import { randomUUID } from 'node:crypto'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'

const text = (value) => String(value ?? '').trim()
const dataOf = (response) => response?.data
const exactId = (value, label) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${label}返回不安全数字 ID，必须使用字符串`)
  }
  const id = text(value)
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`${label}未返回合法 ID`)
  return id
}
const addCheck = (record, name, passed, details) => {
  record.checks = [...(record.checks || []), { name, passed: Boolean(passed), details }]
  return Boolean(passed)
}
const requireCheck = (record, name, passed, details) => {
  if (!addCheck(record, name, passed, details)) throw new Error(`${name}: ${details}`)
}
const rowsOf = (response, label) => {
  if (!isBusinessSuccess(response)) throw new Error(`${label}读取失败`)
  const data = dataOf(response)
  const rows = Array.isArray(data?.records) ? data.records : data?.list
  if (!Array.isArray(rows)) throw new Error(`${label}未返回 records/list 数组`)
  return rows
}
const pageOf = (response, label) => {
  const rows = rowsOf(response, label)
  const total = dataOf(response)?.total
  if (!Number.isInteger(total) || total < 0) throw new Error(`${label}未返回非负整数 total`)
  return { total, rows }
}
const localDateTime = () => new Date().toISOString().slice(0, 19)
const codeOf = (marker, suffix) => `${marker}-${suffix}`.slice(0, 64)

export const materialCommercialValidationContracts = Object.freeze({
  purchaseDisabled: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于采购订单：未启用可采购能力/
  }),
  saleDisabled: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于销售订单：未启用可销售能力/
  })
})

export const materialCommercialValidationSemantics = Object.freeze({
  purchaseOrderAllowsService: true,
  saleOrderDoesNotRequireStockNature: true,
  scope: 'Only disabled purchased/saled capability is asserted; non-physical order eligibility is not negated.'
})

export const materialCommercialValidationCheckNames = Object.freeze({
  purchase: '采购订单引用未启用可采购专属物料被精确拒绝且前后无订单残留',
  sale: '销售订单引用未启用可销售专属物料被精确拒绝且前后无订单残留',
  cleanup: 'PB032 商业场景专属物料和意外订单已按所有权清理并回读不可见'
})

const materialBody = ({ code, marker, unitId, purchased, saled, source, produced }) => ({
  code,
  name: code,
  auxName: code,
  unitId,
  inventoryNature: 'STOCK',
  virtualGoods: 'N',
  isEnabled: 1,
  source,
  purchased,
  saled,
  produced,
  isMaterial: 'N',
  parented: 'N',
  assembled: 'N',
  soned: 'N',
  leadTime: 1,
  bufferTime: 1,
  batchManaged: 'N',
  oneBarcode: 'N',
  periodManaged: 'N',
  gradeManaged: 'N',
  colorManaged: 'N',
  brandManaged: 'N',
  backflush: 'N',
  remark: marker
})

const ownsMaterial = (row, material) =>
  exactId(row?.id, '物料详情') === material.id &&
  text(row?.code) === material.code && text(row?.name) === material.code &&
  text(row?.remark) === material.marker && text(row?.unitId) === material.unitId &&
  text(row?.inventoryNature) === 'STOCK' && text(row?.purchased) === material.purchased &&
  text(row?.saled) === material.saled && text(row?.source) === material.source &&
  text(row?.produced) === material.produced && text(row?.isEnabled) === '1'

const materialSnapshot = (row) => ({
  id: text(row?.id),
  code: text(row?.code),
  name: text(row?.name),
  remark: text(row?.remark),
  unitId: text(row?.unitId),
  inventoryNature: text(row?.inventoryNature),
  source: text(row?.source),
  purchased: text(row?.purchased),
  saled: text(row?.saled),
  produced: text(row?.produced),
  isEnabled: text(row?.isEnabled),
  isMaterial: text(row?.isMaterial),
  parented: text(row?.parented),
  assembled: text(row?.assembled),
  soned: text(row?.soned),
  batchManaged: text(row?.batchManaged),
  periodManaged: text(row?.periodManaged),
  periodDays: row?.periodDays ?? null,
  defaultWare: text(row?.defaultWare),
  defaultWareArea: text(row?.defaultWareArea),
  defaultWareLocation: text(row?.defaultWareLocation)
})

const materialRowsByCode = async (api, code) => rowsOf(await api.getBusiness(
  `/mes/basMaterial/list?pageNo=1&pageSize=100&code=${encodeURIComponent(code)}`
), 'PB032 商业物料分页').filter((row) => text(row?.code) === code)

const readPartner = async (api, partner, role, label) => {
  const id = exactId(partner?.id ?? partner, label)
  const row = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(id)}`))
  const roleField = role === 'SUPPLIER' ? 'supplierEnabled' : 'customerEnabled'
  if (exactId(row?.id, `${label}回读`) !== id || row?.[roleField] !== true || text(row?.status) !== 'ACTIVE') {
    throw new Error(`BLOCKED: ${label}不是启用的${role === 'SUPPLIER' ? '供应商' : '客户'}公共主档`)
  }
  return { id, snapshot: { id, status: row.status, [roleField]: true, name: row.name ?? null } }
}

const orderBody = ({ kind, billNo, marker, partnerId, material }) => {
  const orderTime = localDateTime()
  const common = {
    billNo,
    orderTime,
    billDate: orderTime.slice(0, 10),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 1,
    totalProductPrice: 1,
    totalTaxPrice: 0,
    totalPrice: 1,
    remark: marker,
    items: [{
      entryNo: 1,
      productId: material.id,
      productUnitId: material.unitId,
      productPrice: 1,
      productTaxPrice: 1,
      count: 1,
      taxPercent: 0,
      totalPrice: 1,
      taxPrice: 0,
      remark: marker
    }]
  }
  return kind === 'purchase'
    ? { ...common, type: 0, supplierId: partnerId }
    : { ...common, customerId: partnerId }
}

const orderPath = (kind) => kind === 'purchase' ? '/erp/purchase-order' : '/erp/sale-order'
const readOrderPage = async (api, kind, billNo, materialId, label) => {
  const base = orderPath(kind)
  const query = new URLSearchParams({ pageNo: '1', pageSize: '100', billNo, productId: materialId })
  const page = pageOf(await api.getBusiness(`${base}/page?${query.toString()}`), label)
  const unexpected = page.rows.filter((row) =>
    text(row?.billNo) !== billNo || (row?.productId != null && text(row.productId) !== materialId))
  if (unexpected.length > 0) throw new Error(`${label}返回了不匹配筛选条件的订单行`)
  return { total: page.total, rows: page.rows.map((row) => ({ id: row?.id ?? null, billNo: row?.billNo ?? null, productId: row?.productId ?? null })) }
}
const emptyOrderSnapshot = (snapshot) => snapshot.total === 0 && snapshot.rows.length === 0

const ownsOrder = (detail, order) =>
  exactId(detail?.id, '意外订单详情') === order.id && text(detail?.billNo) === order.billNo &&
  text(detail?.remark) === order.marker && Array.isArray(detail?.items) &&
  detail.items.some((item) => text(item?.productId) === order.materialId && text(item?.remark) === order.marker)

async function createOwnedMaterial (api, fixture, { code, unitId, purchased, saled, source, produced }) {
  const material = { code, marker: fixture.marker, unitId, purchased, saled, source, produced, id: null }
  fixture.materials.push(material)
  try {
    material.id = exactId(dataOf(await api.postBusiness('/mes/basMaterial/add', materialBody(material))),
      'PB032 商业场景专属物料')
  } catch (error) {
    const rows = await materialRowsByCode(api, material.code)
    const recovered = rows.filter((row) => text(row?.remark) === material.marker)
    if (recovered.length === 1) material.id = exactId(recovered[0]?.id, 'PB032 商业物料失败后恢复')
    if (recovered.length > 1) throw new Error(`PB032 商业物料创建后恢复出现多个本轮记录：${material.code}`)
    throw error
  }
  const detail = dataOf(await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`))
  if (!ownsMaterial(detail, material)) throw new Error(`PB032 商业物料回读不匹配：${material.id}`)
  return material
}

const readOwnedMaterialSnapshot = async (api, material, label) => {
  const detail = dataOf(await api.getBusiness(
    `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`
  ))
  if (!ownsMaterial(detail, material)) throw new Error(`${label}物料所有权或能力字段不匹配`)
  return materialSnapshot(detail)
}

/**
 * Removes only records whose current formal readback still proves this run owns
 * them. Cleanup failures are preserved as hard failures and are never swallowed.
 */
export async function cleanupMaterialCommercialValidationFixtures (api, fixture, caseRecord) {
  const failures = []
  for (const order of [...(fixture?.unexpectedOrders || [])].reverse()) {
    try {
      const detail = dataOf(await api.getBusiness(
        `${orderPath(order.kind)}/get?id=${encodeURIComponent(order.id)}`
      ))
      if (!ownsOrder(detail, order)) throw new Error('意外订单所有权或行项目不匹配')
      await api.deleteBusiness(`${orderPath(order.kind)}/delete?ids=${encodeURIComponent(order.id)}`)
      const after = await readOrderPage(api, order.kind, order.billNo, order.materialId, '意外订单删除后分页回读')
      if (!emptyOrderSnapshot(after)) throw new Error('意外订单删除后仍可由 billNo/productId 查询到')
    } catch (error) {
      failures.push(`order/${order?.id || order?.billNo || 'unknown'}: ${error.message}`)
    }
  }
  for (const material of [...(fixture?.materials || [])].reverse()) {
    if (!material.id) continue
    try {
      const detail = dataOf(await api.getBusiness(
        `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`
      ))
      if (!ownsMaterial(detail, material)) throw new Error('物料所有权或能力字段不匹配')
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${encodeURIComponent(material.id)}`)
      const rows = await materialRowsByCode(api, material.code)
      if (rows.some((row) => text(row?.id) === material.id || text(row?.code) === material.code)) {
        throw new Error('物料删除后仍可按本轮 ID 或编码查询到')
      }
    } catch (error) {
      failures.push(`material/${material?.id || material?.code || 'unknown'}: ${error.message}`)
    }
  }
  const passed = failures.length === 0
  addCheck(caseRecord, materialCommercialValidationCheckNames.cleanup, passed,
    passed ? `marker=${fixture?.marker}; ownedMaterials=${fixture?.materials?.length || 0}` : failures.join('；'))
  if (!passed) throw new Error(`PB032 商业场景夹具清理失败：${failures.join('；')}`)
}

export async function verifyMaterialCommercialValidationClosure ({ api, caseRecord, unit, supplier, customer }) {
  const unitId = exactId(unit?.id ?? unit, '启用计量单位')
  const marker = `E2E-PB032-COM-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
  const fixture = { marker, materials: [], unexpectedOrders: [] }
  caseRecord.evidence = [...(caseRecord.evidence || [])]
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  try {
    const [verifiedSupplier, verifiedCustomer] = await Promise.all([
      readPartner(api, supplier, 'SUPPLIER', 'PB032 只读供应商'),
      readPartner(api, customer, 'CUSTOMER', 'PB032 只读客户')
    ])
    caseRecord.evidence.push(`PB032 商业场景只读伙伴：supplier=${verifiedSupplier.id}; customer=${verifiedCustomer.id}`)
    const purchaseMaterial = await createOwnedMaterial(api, fixture, {
      code: codeOf(marker, 'PURCHASE-DISABLED'), unitId, purchased: 'N', saled: 'Y',
      source: 'manufacture', produced: 'Y'
    })
    const saleMaterial = await createOwnedMaterial(api, fixture, {
      code: codeOf(marker, 'SALE-DISABLED'), unitId, purchased: 'Y', saled: 'N',
      source: 'purchase', produced: 'N'
    })
    const probes = [
      {
        kind: 'purchase', material: purchaseMaterial, partnerId: verifiedSupplier.id,
        contract: materialCommercialValidationContracts.purchaseDisabled,
        checkName: materialCommercialValidationCheckNames.purchase
      },
      {
        kind: 'sale', material: saleMaterial, partnerId: verifiedCustomer.id,
        contract: materialCommercialValidationContracts.saleDisabled,
        checkName: materialCommercialValidationCheckNames.sale
      }
    ]
    for (const probe of probes) {
      const billNo = codeOf(marker, probe.kind === 'purchase' ? 'PO' : 'SO')
      const materialBefore = await readOwnedMaterialSnapshot(api, probe.material,
        `${probe.kind} 场景拒绝前`)
      const before = await readOrderPage(api, probe.kind, billNo, probe.material.id,
        `${probe.kind} 场景拒绝前订单分页`)
      if (!emptyOrderSnapshot(before)) throw new Error(`BLOCKED: ${probe.kind} 拒绝前存在本轮 billNo/productId 残留`)
      const response = await api.post(`${orderPath(probe.kind)}/create`, orderBody({
        kind: probe.kind, billNo, marker, partnerId: probe.partnerId, material: probe.material
      }), { expectedBusinessRejection: probe.contract })
      if (isBusinessSuccess(response) && /^[1-9]\d*$/.test(text(dataOf(response)))) {
        fixture.unexpectedOrders.push({
          id: exactId(dataOf(response), '意外创建订单'), kind: probe.kind, billNo,
          marker, materialId: probe.material.id
        })
      }
      const after = await readOrderPage(api, probe.kind, billNo, probe.material.id,
        `${probe.kind} 场景拒绝后订单分页`)
      const materialAfter = await readOwnedMaterialSnapshot(api, probe.material,
        `${probe.kind} 场景拒绝后`)
      const rejected = matchesExpectedBusinessRejection(response, probe.contract) && response?.data == null
      requireCheck(caseRecord, probe.checkName,
        rejected && emptyOrderSnapshot(after) && JSON.stringify(materialBefore) === JSON.stringify(materialAfter), JSON.stringify({
        materialId: probe.material.id, materialCode: probe.material.code, billNo,
        materialBefore, materialAfter, before, after, code: response?.code,
        message: response?.msg || response?.message || '', data: response?.data ?? null
      }))
    }
    return fixture
  } finally {
    await cleanupMaterialCommercialValidationFixtures(api, fixture, caseRecord)
  }
}

export const __internal = {
  codeOf,
  materialBody,
  ownsMaterial,
  materialSnapshot,
  orderBody,
  ownsOrder,
  emptyOrderSnapshot,
  readOrderPage
}
