import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const localDateTime = () => new Date().toISOString().slice(0, 19)

const enabledConfig = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return false
  if (['true', '1'].includes(raw.trim().toLowerCase())) return true
  try {
    const value = JSON.parse(raw)
    return value && [true, 'true', 1, '1'].includes(value.enabled)
  } catch {
    return false
  }
}

const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value))

/**
 * PB-139 real write side: create an isolated audited purchase order and run the
 * change / change-list / update-attachment chain against it, then verify the
 * `erp_purchase_order_change` audit rows directly in the local database.
 *
 * The order is created with the unique E2E-PROC015 prefix and is retained on
 * purpose, matching the suite's "keep isolated fixtures" convention.
 */
export async function createPurchaseOrderChangeFixture (api, caseRecord) {
  const tag = `${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`

  // Direct-create orders (no requisition source) are only legal while the shared
  // requisition switch is off; do not flip a shared product switch for one case.
  const option = dataOf(
    await api.getBusiness('/system/config/get?category=purchase&tag=requisition'),
    'PROC-015 请购开关'
  )
  if (option && enabledConfig(option.configData)) {
    throw new Error(
      'BLOCKED: PROC-015 请购开关已开启；直采专属订单需要独立 direct-create 权限或有效请购来源，未切换共享策略'
    )
  }

  const materialPage = dataOf(
    await api.getBusiness(
      '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
    ),
    'PROC-015 可采购物料'
  )
  const material = materialPage?.records?.find((row) => stableId(row?.id) && stableId(row?.unitId))
  if (!material) throw new Error('BLOCKED: PROC-015 没有可采购的物料/单位，无法创建专属采购订单')

  const fixture = {
    kind: 'procurement-order-change',
    tag,
    status: 'creating',
    retained: true,
    reason: '专属采购订单与变更审计逐步登记；失败不删除已创建事实'
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  const registerId = (field, id) => {
    fixture[field] = String(id)
    caseRecord.evidence.push(`PROC-015 retained ${field}=${id}，tag=${tag}`)
  }

  const partnerId = dataOf(await api.postBusiness('/base/partner/create', {
    name: `E2E-PROC015-SUPPLIER-${tag}`,
    shortName: 'E2E-PROC015',
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled: false,
    supplierEnabled: true,
    carrierEnabled: false,
    remark: `PROC-015 isolated order change fixture ${tag}`
  }), 'PROC-015 专属供应商')
  if (!stableId(partnerId)) throw new Error('PROC-015 专属供应商未返回稳定 ID')
  registerId('supplierId', partnerId)

  const orderTime = localDateTime()
  const orderPayload = {
    type: 0,
    supplierId: String(partnerId),
    orderTime,
    billDate: orderTime.slice(0, 10),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 5,
    totalProductPrice: 160,
    totalTaxPrice: 0,
    totalPrice: 160,
    directCreate: 1,
    directCreateReason: `PROC-015 isolated order change ${tag}`,
    remark: `PROC-015 original header ${tag}`,
    items: [
      {
        entryNo: 1,
        productId: String(material.id),
        productUnitId: String(material.unitId),
        productPrice: 50,
        count: 2,
        taxPercent: 0,
        totalPrice: 100,
        taxPrice: 0,
        remark: `PROC-015 line A ${tag}`
      },
      {
        entryNo: 2,
        productId: String(material.id),
        productUnitId: String(material.unitId),
        productPrice: 20,
        count: 3,
        taxPercent: 0,
        totalPrice: 60,
        taxPrice: 0,
        remark: `PROC-015 line B ${tag}`
      }
    ]
  }
  const orderId = dataOf(
    await api.postBusiness('/erp/purchase-order/create', orderPayload),
    'PROC-015 专属采购订单'
  )
  if (!stableId(orderId)) throw new Error('PROC-015 专属采购订单未返回稳定 ID')
  registerId('orderId', orderId)

  const created = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`),
    'PROC-015 订单初始详情'
  )
  if (!Array.isArray(created?.items) || created.items.length !== 2) {
    throw new Error(`PROC-015 专属订单未返回两行明细：items=${created?.items?.length}`)
  }
  const lineA = created.items.find((item) => Number(item.entryNo) === 1)
  const lineB = created.items.find((item) => Number(item.entryNo) === 2)
  if (!lineA?.id || !lineB?.id) throw new Error('PROC-015 专属订单缺少稳定行 ID')
  fixture.itemAId = String(lineA.id)
  fixture.itemBId = String(lineB.id)

  // Direct-create purchase orders (no requisition source) land straight in the
  // audited state (status=20); change is only legal on audited, unclosed orders.
  // We intentionally do not drive the BPM re-audit endpoint here.
  const audited = created
  if (Number(audited?.status) !== 20) {
    throw new Error(
      `BLOCKED: PROC-015 专属订单创建后未处于审核通过状态：status=${audited?.status}，未通过 BPM 反审核/弃审接口伪造状态`
    )
  }

  const reason = `PROC-015 isolated change ${tag}`
  const changeBatchNo = dataOf(
    await api.putBusiness('/erp/purchase-order/change', {
      id: String(orderId),
      reason,
      changes: [
        { fieldName: 'remark', value: `PROC-015 changed header ${tag}` },
        { orderItemId: String(lineA.id), fieldName: 'count', value: 4 },
        { orderItemId: String(lineA.id), fieldName: 'productPrice', value: 60 },
        { orderItemId: String(lineB.id), fieldName: 'remark', value: `PROC-015 changed line B ${tag}` }
      ]
    }),
    'PROC-015 采购订单变更'
  )
  fixture.changeBatchNo = String(changeBatchNo)

  const changed = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`),
    'PROC-015 变更后订单详情'
  )
  const changedLineA = changed.items.find((item) => String(item.id) === String(lineA.id))
  const changedLineB = changed.items.find((item) => String(item.id) === String(lineB.id))

  const history = dataOf(
    await api.getBusiness(
      `/erp/purchase-order/change-list?orderId=${encodeURIComponent(orderId)}`
    ),
    'PROC-015 变更记录查询'
  )

  const fileUrl = `https://e2e.invalid/proc015/${tag}/change-order.pdf`
  dataOf(
    await api.putBusiness(
      `/erp/purchase-order/update-attachment?id=${encodeURIComponent(orderId)}&fileUrl=${encodeURIComponent(fileUrl)}`
    ),
    'PROC-015 采购订单附件写入'
  )
  const attached = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`),
    'PROC-015 附件回读'
  )

  // The change audit is the only new write-side fact; read it straight from the
  // local database so the assertion cannot be satisfied by an API echo alone.
  const auditSql = await runReadOnlySql(`
    SELECT field_name, old_value, new_value, reason, change_batch_no, change_status, order_item_id
    FROM erp_purchase_order_change
    WHERE order_id = '${orderId}' AND deleted = 0
    ORDER BY field_name, order_item_id
  `)
  if (!auditSql.available) {
    throw new Error(`BLOCKED: PROC-015 缺少本地数据库只读证据：${auditSql.reason}`)
  }

  return {
    tag,
    fixture,
    orderId: String(orderId),
    itemAId: String(lineA.id),
    itemBId: String(lineB.id),
    created,
    audited,
    changed,
    changedLineA,
    changedLineB,
    changeBatchNo: String(changeBatchNo),
    history,
    fileUrl,
    attached,
    auditRows: auditSql.rows,
    // Numeric conveniences for assertions.
    changedLineACount: numberOrNull(changedLineA?.count),
    changedLineAPrice: numberOrNull(changedLineA?.productPrice),
    changedLineATotal: numberOrNull(changedLineA?.totalPrice),
    changedTotalCount: numberOrNull(changed?.totalCount),
    changedTotalProductPrice: numberOrNull(changed?.totalProductPrice),
    changedTotalPrice: numberOrNull(changed?.totalPrice)
  }
}
