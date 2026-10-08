import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const localDateTime = () => new Date().toISOString().slice(0, 19)

export async function createPurchasePriceSnapshotFixture (api, caseRecord) {
  const tag = `${Date.now().toString(36).toUpperCase()}_${randomBytes(3).toString('hex')}`
  const code = `E2E_PROC012_${tag}`
  const orderTime = localDateTime()
  const effectiveFrom = orderTime.slice(0, 10)

  const materialPage = dataOf(
    await api.getBusiness(
      '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
    ),
    'PROC-012 可采购物料'
  )
  const material = materialPage?.records?.find((row) =>
    stableId(row?.id) && stableId(row?.unitId))
  if (!material) throw new Error('BLOCKED: PROC-012 没有可采购物料/单位')

  const fixture = {
    kind: 'procurement-price-snapshot',
    tag,
    code,
    status: 'creating',
    retained: true,
    reason: '价格方案、版本、规则和采购订单是本地验收专属事实，不删除'
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]

  const partnerId = dataOf(await api.postBusiness('/base/partner/create', {
    name: `E2E-PROC012-SUPPLIER-${tag}`,
    shortName: 'E2E-PROC012',
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled: false,
    supplierEnabled: true,
    carrierEnabled: false,
    remark: `PROC-012 isolated price snapshot ${tag}`
  }), 'PROC-012 专属供应商')
  if (!stableId(partnerId)) throw new Error('PROC-012 专属供应商未返回稳定 ID')
  fixture.partnerId = String(partnerId)

  const schemePayload = {
    priceDirection: 'PURCHASE',
    code,
    name: `E2E采购价格-${tag}`,
    priority: 1,
    businessTypeCode: 'NORMAL',
    currencyCode: 'CNY',
    status: 1,
    remark: `PROC-012 isolated purchase price scheme ${tag}`
  }
  const schemeId = dataOf(
    await api.postBusiness('/erp/price-scheme/create', schemePayload),
    'PROC-012 专属价格方案'
  )
  if (!stableId(schemeId)) throw new Error('PROC-012 专属价格方案未返回稳定 ID')
  fixture.schemeId = String(schemeId)

  const publishPayload = {
    schemeId: String(schemeId),
    effectiveFrom,
    changeReason: `PROC-012 isolated version ${tag}`,
    rules: [{
      partnerId: String(partnerId),
      materialId: String(material.id),
      unitId: String(material.unitId),
      quantityFrom: 0,
      currencyCode: 'CNY',
      taxIncluded: true,
      taxRate: 0,
      price: 123.45,
      sort: 1,
      remark: `PROC-012 isolated price rule ${tag}`
    }]
  }
  const versionId = dataOf(
    await api.postBusiness('/erp/price-scheme/publish', publishPayload),
    'PROC-012 专属价格版本'
  )
  if (!stableId(versionId)) throw new Error('PROC-012 专属价格版本未返回稳定 ID')
  fixture.versionId = String(versionId)

  const inquiryPayload = {
    priceDirection: 'PURCHASE',
    partnerId: String(partnerId),
    businessTypeCode: 'NORMAL',
    materialId: String(material.id),
    unitId: String(material.unitId),
    quantity: 1,
    priceDate: effectiveFrom
  }
  const inquiry = dataOf(
    await api.postBusiness('/erp/price-scheme/inquiry', inquiryPayload),
    'PROC-012 采购取价'
  )
  if (inquiry?.matched !== true ||
      inquiry?.schemeId !== String(schemeId) ||
      inquiry?.schemeCode !== code ||
      inquiry?.versionId !== String(versionId) ||
      Number(inquiry?.versionNo) !== 1 ||
      !stableId(inquiry?.ruleId) ||
      inquiry?.hitSource !== 'PARTNER' ||
      Number(inquiry?.price) !== 123.45 ||
      !inquiry?.calculatedAt) {
    throw new Error(`PROC-012 专属采购取价未命中完整快照：${JSON.stringify(inquiry)}`)
  }
  fixture.ruleId = String(inquiry.ruleId)

  const saleInquiry = dataOf(
    await api.postBusiness('/erp/price-scheme/inquiry', {
      ...inquiryPayload,
      priceDirection: 'SALE'
    }),
    'PROC-012 销售方向隔离取价'
  )
  if (saleInquiry?.schemeCode === code) {
    throw new Error('PROC-012 采购价格方案泄露到 SALE 方向')
  }
  caseRecord.checks.push({
    name: '专属采购价格方案按 PURCHASE 方向命中，SALE 查询不混用同一方案',
    passed: true,
    details: `schemeId=${schemeId}, versionId=${versionId}, ruleId=${inquiry.ruleId}, saleScheme=${saleInquiry?.schemeCode || ''}`
  })

  const orderPayload = {
    type: 0,
    supplierId: String(partnerId),
    orderTime,
    billDate: effectiveFrom,
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 1,
    totalProductPrice: 88.8,
    totalTaxPrice: 0,
    totalPrice: 88.8,
    directCreate: 1,
    directCreateReason: `PROC-012 isolated order price snapshot ${tag}`,
    remark: `PROC-012 isolated order ${tag}`,
    items: [{
      entryNo: 1,
      productId: String(material.id),
      productUnitId: String(material.unitId),
      productPrice: 88.8,
      count: 1,
      taxPercent: 0,
      totalPrice: 88.8,
      taxPrice: 0,
      remark: `PROC-012 isolated order line ${tag}`
    }]
  }
  const orderId = dataOf(
    await api.postBusiness('/erp/purchase-order/create', orderPayload),
    'PROC-012 专属采购订单'
  )
  if (!stableId(orderId)) throw new Error('PROC-012 专属采购订单未返回稳定 ID')
  fixture.orderId = String(orderId)

  const order = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`),
    'PROC-012 采购订单快照回读'
  )
  const item = order?.items?.find((row) =>
    String(row.productId) === String(material.id) &&
    String(row.productUnitId) === String(material.unitId))
  if (!item ||
      String(item.priceSchemeId) !== String(schemeId) ||
      item.priceSchemeCode !== code ||
      String(item.priceVersionId) !== String(versionId) ||
      Number(item.priceVersionNo) !== 1 ||
      String(item.priceRuleId) !== String(inquiry.ruleId) ||
      item.priceHitSource !== 'PARTNER' ||
      !item.priceCalculatedAt) {
    throw new Error(`PROC-012 采购订单未保存完整取价快照：${JSON.stringify(item)}`)
  }

  const database = await runReadOnlySql(`
    SELECT 'scheme', id, price_direction, code, status, tenant_id
    FROM erp_price_scheme
    WHERE id = ${schemeId} AND deleted = 0;
    SELECT 'version', id, scheme_id, version_no, published_status,
           DATE_FORMAT(effective_from, '%Y-%m-%d'), tenant_id
    FROM erp_price_version
    WHERE id = ${versionId} AND deleted = 0;
    SELECT 'rule', id, version_id, partner_id, material_id, unit_id, price, tenant_id
    FROM erp_price_rule
    WHERE id = ${inquiry.ruleId} AND deleted = 0;
    SELECT 'order-item', id, mid, product_id, price_scheme_id, price_scheme_code,
           price_version_id, price_version_no, price_rule_id, price_hit_source,
           DATE_FORMAT(price_calculated_at, '%Y-%m-%d %H:%i:%s'), tenant_id
    FROM erp_purchase_order_items
    WHERE mid = ${orderId} AND deleted = 0
    ORDER BY id
  `)
  if (!database.available) throw new Error(`BLOCKED: ${database.reason}`)
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'procurement-price-snapshot',
    ...database
  }]
  const rows = database.rows
  const schemeRow = rows.find((row) => row[0] === 'scheme')
  const versionRow = rows.find((row) => row[0] === 'version')
  const ruleRow = rows.find((row) => row[0] === 'rule')
  const orderItemRow = rows.find((row) => row[0] === 'order-item')
  if (!schemeRow || schemeRow[2] !== 'PURCHASE' || schemeRow[3] !== code ||
      Number(schemeRow[4]) !== 1 ||
      !versionRow || Number(versionRow[3]) !== 1 ||
      !ruleRow || ruleRow[1] !== String(inquiry.ruleId) ||
      !orderItemRow ||
      orderItemRow[4] !== String(schemeId) ||
      orderItemRow[5] !== code ||
      orderItemRow[6] !== String(versionId) ||
      orderItemRow[7] !== '1' ||
      orderItemRow[8] !== String(inquiry.ruleId) ||
      orderItemRow[9] !== 'PARTNER') {
    throw new Error('PROC-012 数据库快照与价格方案/版本/规则/订单 API 回读不一致')
  }
  fixture.status = 'verified'
  caseRecord.evidence.push(
    `PROC-012 retained partnerId=${partnerId}, schemeId=${schemeId}, versionId=${versionId}, ` +
    `ruleId=${inquiry.ruleId}, orderId=${orderId}；订单行快照 code=${code}, version=1, hitSource=PARTNER`
  )
  return { fixture, schemePayload, publishPayload, inquiry, saleInquiry, order, item, database }
}
