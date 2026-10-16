import { randomUUID } from 'node:crypto'

import { runReadOnlySql } from '../lib/db.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { approvePurchaseRequestProcess } from './procurement-chain.mjs'

const text = (value) => String(value ?? '').trim()
const dataOf = (response) => response?.data
const localDateTime = () => new Date().toISOString().slice(0, 19)
const localDate = () => localDateTime().slice(0, 10)
// ERP purchase requisition numbers are varchar(50); keep every generated
// fixture identifier within the narrowest real business-column limit.
const codeOf = (marker, suffix) => `${marker}-${suffix}`.slice(0, 50)

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
  const rows = dataOf(response)?.records ?? dataOf(response)?.list
  if (!Array.isArray(rows)) throw new Error(`${label}未返回 records/list 数组`)
  return rows
}

const pageOf = (response, label) => {
  const rows = rowsOf(response, label)
  const total = dataOf(response)?.total
  if (!Number.isInteger(total) || total < 0) throw new Error(`${label}未返回非负整数 total`)
  return { total, rows }
}

const responseMessage = (response) => response?.msg || response?.message || ''

const recordDatabase = (caseRecord, stage, snapshot) => {
  caseRecord.database = [...(caseRecord.database || []), { stage, ...snapshot }]
}

const materialPage = async (api, code) => rowsOf(
  await api.getBusiness(`/mes/basMaterial/list?pageNo=1&pageSize=100&code=${encodeURIComponent(code)}`),
  'PB032-002 专属物料分页'
).filter((row) => text(row?.code) === code)

const materialBody = ({ code, marker, unitId, inventoryNature, source, purchased, saled, produced }) => ({
  code,
  name: code,
  auxName: code,
  unitId,
  inventoryNature,
  virtualGoods: inventoryNature === 'VIRTUAL' ? 'Y' : 'N',
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
  newPurchasePrice: 1,
  remark: marker
})

const materialSnapshot = (row) => ({
  id: text(row?.id),
  code: text(row?.code),
  name: text(row?.name),
  remark: text(row?.remark),
  unitId: text(row?.unitId),
  inventoryNature: text(row?.inventoryNature),
  virtualGoods: text(row?.virtualGoods),
  source: text(row?.source),
  purchased: text(row?.purchased),
  saled: text(row?.saled),
  produced: text(row?.produced),
  isEnabled: text(row?.isEnabled),
  batchManaged: text(row?.batchManaged),
  periodManaged: text(row?.periodManaged),
  defaultWare: text(row?.defaultWare),
  defaultWareArea: text(row?.defaultWareArea),
  defaultWareLocation: text(row?.defaultWareLocation)
})

const ownsMaterial = (row, expected) => {
  const actual = materialSnapshot(row)
  return actual.id === expected.id && actual.code === expected.code &&
    actual.name === expected.code && actual.remark === expected.marker &&
    actual.unitId === expected.unitId && actual.inventoryNature === expected.inventoryNature &&
    actual.virtualGoods === expected.virtualGoods && actual.source === expected.source &&
    actual.purchased === expected.purchased && actual.saled === expected.saled &&
    actual.produced === expected.produced && actual.isEnabled === '1' &&
    actual.batchManaged === 'N' && actual.periodManaged === 'N' &&
    actual.defaultWare === '' && actual.defaultWareArea === '' && actual.defaultWareLocation === ''
}

const createMaterial = async (api, fixture, spec) => {
  const material = {
    ...spec,
    id: null,
    marker: fixture.marker,
    virtualGoods: spec.inventoryNature === 'VIRTUAL' ? 'Y' : 'N'
  }
  fixture.materials.push(material)
  const body = materialBody(material)
  try {
    material.id = exactId(dataOf(await api.postBusiness('/mes/basMaterial/add', body)),
      `PB032-002 ${spec.inventoryNature}物料`)
  } catch (error) {
    const rows = await materialPage(api, material.code)
    const recovered = rows.filter((row) => text(row?.remark) === fixture.marker)
    if (recovered.length === 1) material.id = exactId(recovered[0]?.id, 'PB032-002 专属物料失败后恢复')
    if (recovered.length > 1) throw new Error(`PB032-002 专属物料恢复出现多个本轮记录：${material.code}`)
    throw error
  }
  const detail = dataOf(await api.getBusiness(
    `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`))
  if (!ownsMaterial(detail, material)) throw new Error(`PB032-002 物料回读不匹配：${material.code}`)
  material.snapshot = materialSnapshot(detail)
  return material
}

const partnerId = (partner, label) => exactId(partner?.id ?? partner, label)

const readPartner = async (api, partner, role, label) => {
  const id = partnerId(partner, label)
  const row = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(id)}`))
  const roleField = role === 'SUPPLIER' ? 'supplierEnabled' : 'customerEnabled'
  if (exactId(row?.id, `${label}回读`) !== id || row?.[roleField] !== true || text(row?.status) !== 'ACTIVE') {
    throw new Error(`BLOCKED: ${label}不是启用的${role === 'SUPPLIER' ? '供应商' : '客户'}公共主档`)
  }
  return id
}

const orderBody = ({ kind, billNo, marker, partnerId: partner, material }) => {
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
    ? { ...common, type: 0, supplierId: partner }
    : { ...common, customerId: partner }
}

const ownsOrder = (detail, expected) => {
  const id = exactId(detail?.id, '订单详情')
  const no = text(detail?.billNo ?? detail?.no)
  const sourceMatched = expected.requestId &&
    Array.isArray(detail?.items) &&
    detail.items.some((item) =>
      text(item?.srcBillId) === text(expected.requestId) &&
      (!expected.requestItemId || text(item?.srcEntryId) === text(expected.requestItemId)) &&
      text(item?.productId) === expected.materialId)
  return id === expected.id && no === expected.billNo &&
    Array.isArray(detail?.items) && (
      (text(detail?.remark) === expected.marker && detail.items.some((item) =>
        text(item?.productId) === expected.materialId && text(item?.remark) === expected.marker)) ||
      sourceMatched
    )
}

const orderEndpoint = (kind) => kind === 'purchase' ? '/erp/purchase-order' : '/erp/sale-order'

const uuid = (value) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ''))

const createOwnedPurchaseRequestOrder = async (
  api, fixture, caseRecord, { material, partnerId, suffix, checkName, record }
) => {
  const billNo = codeOf(fixture.marker, `REQUEST-${suffix}`)
  const payload = {
    billNo,
    billType: '18',
    status: 0,
    orderTime: localDateTime(),
    expectedOrderTime: localDateTime(),
    remark: fixture.marker,
    itemsList: [{
      entryNo: 1,
      productId: String(material.id),
      productUnitId: String(material.unitId),
      supplierId: String(partnerId),
      inCount: 1,
      purchasedQuantity: 0,
      remark: `${fixture.marker}-${suffix}`
    }]
  }
  const requestId = exactId(
    dataOf(await api.postBusiness('/erp/purchase/order/request/create', payload)),
    `PB032-002 ${suffix}请购`
  )
  const requestFixture = {
    id: requestId,
    billNo,
    materialId: String(material.id),
    partnerId: String(partnerId),
    itemId: null
  }
  fixture.purchaseRequests.push(requestFixture)

  const readRequest = async () => dataOf(await api.getBusiness(
    `/erp/purchase/order/request/get?id=${encodeURIComponent(requestId)}`))
  let request = await readRequest()
  const requestItem = request?.itemsList?.find((item) =>
    text(item?.productId) === text(material.id))
  if (!requestItem?.id) throw new Error(`PB032-002 ${suffix}请购缺少明细`)
  requestFixture.itemId = exactId(requestItem.id, `PB032-002 ${suffix}请购明细`)

  if (Number(request?.status) !== 20) {
    await api.putBusiness(
      `/erp/purchase/order/request/update-status?id=${encodeURIComponent(requestId)}&status=10`
    )
    request = await readRequest()
  }
  if (Number(request?.status) !== 20) {
    if (!uuid(request?.processInstanceId)) {
      throw new Error(
        `BLOCKED: PB032-002 ${suffix}请购提交后未生效且缺少 BPM 流程：` +
        `requestId=${requestId}; status=${request?.status}`
      )
    }
    request = await approvePurchaseRequestProcess({
      api,
      processId: request.processInstanceId,
      requestId,
      caseRecord,
      record
    })
  }
  if (Number(request?.status) !== 20 || Number(request?.isEffective) !== 1) {
    throw new Error(`BLOCKED: PB032-002 ${suffix}请购未完成正式审批：${JSON.stringify({
      requestId, status: request?.status, isEffective: request?.isEffective
    })}`)
  }
  if (Number(request?.isPlaceOrder) !== 1) {
    await api.putBusiness(
      `/erp/purchase/order/request/place/an/order?ids=${encodeURIComponent(requestFixture.itemId)}&isSeparate=0`
    )
  }

  const orders = rowsOf(
    await api.getBusiness('/erp/purchase-order/page?pageNo=1&pageSize=100'),
    `PB032-002 ${suffix}采购订单`
  )
  let order
  let item
  for (const row of orders.filter((candidate) => candidate?.id)) {
    const candidate = dataOf(await api.getBusiness(
      `/erp/purchase-order/get?id=${encodeURIComponent(row.id)}`))
    const candidateItem = candidate?.items?.find((entry) =>
      text(entry?.srcBillId) === requestId &&
      text(entry?.srcEntryId) === requestFixture.itemId &&
      text(entry?.productId) === text(material.id))
    if (candidateItem) {
      order = candidate
      item = candidateItem
      break
    }
  }
  if (!order?.id || !item) {
    throw new Error(`BLOCKED: PB032-002 ${suffix}请购转单后未找到正式采购订单：requestId=${requestId}`)
  }
  const expected = {
    id: exactId(order.id, `PB032-002 ${suffix}采购订单`),
    kind: 'purchase',
    billNo: text(order.billNo),
    marker: fixture.marker,
    materialId: String(material.id),
    requestId,
    requestItemId: requestFixture.itemId,
    material
  }
  fixture.orders.push(expected)
  const detail = dataOf(await api.getBusiness(
    `/erp/purchase-order/get?id=${encodeURIComponent(expected.id)}`))
  requireCheck(caseRecord, checkName, ownsOrder(detail, expected), JSON.stringify({
    id: expected.id,
    billNo: expected.billNo,
    requestId,
    requestItemId: requestFixture.itemId,
    materialId: material.id,
    detail
  }))
  return expected
}

const createOwnedOrder = async (
  api, fixture, caseRecord,
  { kind, material, partnerId: partner, suffix, checkName, record }
) => {
  if (kind === 'purchase') {
    return createOwnedPurchaseRequestOrder(api, fixture, caseRecord, {
      material,
      partnerId: partner,
      suffix,
      checkName,
      record
    })
  }
  const billNo = codeOf(fixture.marker, suffix)
  const expected = { id: null, kind, billNo, marker: fixture.marker, materialId: material.id }
  const response = await api.postBusiness(`${orderEndpoint(kind)}/create`, orderBody({
    kind, billNo, marker: fixture.marker, partnerId: partner, material
  }))
  expected.id = exactId(dataOf(response), `PB032-002 ${kind}正控制订单`)
  fixture.orders.push(expected)
  const detail = dataOf(await api.getBusiness(`${orderEndpoint(kind)}/get?id=${encodeURIComponent(expected.id)}`))
  const passed = ownsOrder(detail, expected)
  requireCheck(caseRecord, checkName, passed, JSON.stringify({
    id: expected.id, billNo, materialId: material.id, detail
  }))
  return expected
}

const pagePathFor = (kind, billNo, materialId) => {
  const path = {
    purchaseIn: '/erp/purchase-in/page',
    purchaseReturn: '/erp/purchase-return/page',
    saleOut: '/erp/sale-out/page',
    saleReturn: '/erp/sale-return/page'
  }[kind]
  const numberField = kind === 'purchaseIn' || kind === 'saleOut' ? 'no' : 'billNo'
  const query = new URLSearchParams({ pageNo: '1', pageSize: '100', [numberField]: billNo, productId: materialId })
  return `${path}?${query.toString()}`
}

const pageSnapshot = async (api, probe, label) => {
  const page = pageOf(await api.getBusiness(pagePathFor(probe.kind, probe.billNo, probe.material.id)), label)
  const matching = page.rows.filter((row) => {
    const no = text(row?.billNo ?? row?.no)
    return no === probe.billNo && (row?.productId == null || text(row.productId) === probe.material.id)
  })
  if (matching.length !== page.rows.length) throw new Error(`${label}返回了不匹配 billNo/productId 的行`)
  return { total: page.total, rows: matching.map((row) => ({ id: row?.id ?? null, billNo: row?.billNo ?? row?.no ?? null, productId: row?.productId ?? null })) }
}

const sqlQuote = (value) => `'${String(value).replaceAll("'", "''")}'`

const scenarioSql = (marker, billNo, materialIds) => {
  const materialList = materialIds.map(sqlQuote).join(',') || sqlQuote('__none__')
  const markerSql = sqlQuote(marker)
  const billSql = sqlQuote(billNo)
  return [
    `SELECT 'erp_purchase_in', COUNT(*) FROM erp_purchase_in WHERE tenant_id=1 AND deleted=0 AND (no=${billSql} OR remark=${markerSql})`,
    `SELECT 'erp_purchase_return', COUNT(*) FROM erp_purchase_return WHERE tenant_id=1 AND deleted=0 AND (bill_no=${billSql} OR remark=${markerSql})`,
    `SELECT 'erp_sale_out', COUNT(*) FROM erp_sale_out WHERE tenant_id=1 AND deleted=0 AND (no=${billSql} OR remark=${markerSql})`,
    `SELECT 'erp_sale_return', COUNT(*) FROM erp_sale_return WHERE tenant_id=1 AND deleted=0 AND (bill_no=${billSql} OR remark=${markerSql})`,
    `SELECT 'mes_stk_io', COUNT(*) FROM mes_stk_io WHERE tenant_id=1 AND deleted=0 AND (bill_no=${billSql} OR remark=${markerSql} OR src_no=${billSql})`,
    `SELECT 'mes_stk_inventory', COUNT(*), COALESCE(SUM(qty),0), COALESCE(SUM(available_qty),0) FROM mes_stk_inventory WHERE tenant_id=1 AND deleted=0 AND material_id IN (${materialList})`
  ].join(';\n')
}

const readScenarioSql = async (readSql, caseRecord, stage, marker, billNo, materialIds) => {
  const result = await readSql(scenarioSql(marker, billNo, materialIds))
  if (!result?.available) throw new Error(`BLOCKED: PB032-002 只读 SQL 不可用：${result?.reason || 'unknown'}`)
  const snapshot = { rows: result.rows || [] }
  recordDatabase(caseRecord, stage, snapshot)
  return snapshot
}

const sameSnapshot = (before, after) => JSON.stringify(before?.rows || []) === JSON.stringify(after?.rows || [])

const probeBody = (probe) => {
  const commonItem = {
    warehouseId: '1',
    areaHouseId: '1',
    productId: probe.material.id,
    productUnitId: probe.material.unitId,
    productPrice: 1,
    count: 1,
    taxPercent: 0,
    remark: probe.marker
  }
  if (probe.kind === 'purchaseIn') {
    return {
      businessType: 'OPENING',
      openingBaselineDate: localDate(),
      supplierId: probe.partnerId,
      orderId: null,
      inTime: localDateTime(),
      discountPercent: 0,
      otherPrice: 0,
      remark: probe.marker,
      items: [{ ...commonItem, orderItemId: null }]
    }
  }
  if (probe.kind === 'purchaseReturn') {
    return {
      billNo: probe.billNo,
      returnTime: localDateTime(),
      supplierId: probe.partnerId,
      srcBillId: null,
      accountId: null,
      returnType: 2,
      discountPercent: 0,
      otherPrice: 0,
      remark: probe.marker,
      items: [{ ...commonItem, srcEntryId: '1', wareLocationId: '1', totalPrice: 1 }]
    }
  }
  if (probe.kind === 'saleOut') {
    return {
      businessType: 'OPENING',
      customerId: probe.partnerId,
      orderId: null,
      outTime: localDateTime(),
      goLiveBaseDate: localDate(),
      openingInvoicedAmount: 0,
      discountPercent: 0,
      otherPrice: 0,
      remark: probe.marker,
      items: [{ ...commonItem, orderItemId: null }]
    }
  }
  return {
    billNo: probe.billNo,
    returnTime: localDateTime(),
    customerId: probe.partnerId,
    srcBillId: null,
    accountId: null,
    returnType: 2,
    discountPercent: 0,
    otherPrice: 0,
    remark: probe.marker,
    items: [{ ...commonItem, wareLocationId: '1', totalPrice: 1 }]
  }
}

export const materialStockScenarioContracts = Object.freeze({
  servicePurchaseInNonPhysical: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于采购入库：采购出入库只能引用实物存货/
  }),
  purchaseInNonPhysical: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于采购入库：采购出入库只能引用实物存货/
  }),
  purchaseInCapability: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于采购入库：未启用可采购能力/
  }),
  purchaseReturnNonPhysical: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于采购退货：采购出入库只能引用实物存货/
  }),
  purchaseReturnCapability: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于采购退货：未启用可采购能力/
  }),
  saleOutNonPhysical: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于销售出库：销售出入库只能引用实物存货/
  }),
  saleOutCapability: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于销售出库：未启用可销售能力/
  }),
  saleReturnNonPhysical: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于销售退货：销售出入库只能引用实物存货/
  }),
  saleReturnCapability: Object.freeze({
    code: 2010100007,
    message: /存货\([^)]*\)不能用于销售退货：未启用可销售能力/
  })
})

export const materialStockScenarioCheckNames = Object.freeze({
  servicePurchaseInNonPhysical: 'SERVICE 正式采购入库 create API 精确拒绝非实物存货且分页/数据库/WMS 前后不变',
  purchaseInNonPhysical: '采购入库正式 create API 精确拒绝非实物存货且分页/数据库/WMS 前后不变',
  purchaseInCapability: '采购入库正式 create API 精确拒绝能力不符 STOCK 且分页/数据库/WMS 前后不变',
  purchaseReturnNonPhysical: '采购退货正式 create API 精确拒绝非实物存货且分页/数据库/WMS 前后不变',
  purchaseReturnCapability: '采购退货正式 create API 精确拒绝能力不符 STOCK 且分页/数据库/WMS 前后不变',
  saleOutNonPhysical: '销售出库正式 create API 精确拒绝非实物存货且分页/数据库/WMS 前后不变',
  saleOutCapability: '销售出库正式 create API 精确拒绝能力不符 STOCK 且分页/数据库/WMS 前后不变',
  saleReturnNonPhysical: '销售退货正式 create API 精确拒绝非实物存货且分页/数据库/WMS 前后不变',
  saleReturnCapability: '销售退货正式 create API 精确拒绝能力不符 STOCK 且分页/数据库/WMS 前后不变',
  servicePurchaseOrder: 'SERVICE 正式采购订单创建并回读且不形成 WMS 库存',
  serviceInventoryUnchanged: 'SERVICE 采购订单前后 WMS 库存只读快照不变',
  stockPurchaseOrder: '合法 mixed STOCK 正式采购订单创建并回读且不形成 WMS 库存',
  stockInventoryUnchanged: '合法 mixed STOCK 采购订单前后 WMS 库存只读快照不变',
  cleanup: 'PB032-002 本轮专属物料/订单/意外单据按所有权清理并回读不可见'
})

export const materialStockScenarioAssertionMap = Object.freeze({
  purchasePhysicalAndCapability: Object.freeze([
    materialStockScenarioCheckNames.purchaseInNonPhysical,
    materialStockScenarioCheckNames.purchaseInCapability,
    materialStockScenarioCheckNames.purchaseReturnNonPhysical,
    materialStockScenarioCheckNames.purchaseReturnCapability
  ]),
  salePhysicalAndCapability: Object.freeze([
    materialStockScenarioCheckNames.saleOutNonPhysical,
    materialStockScenarioCheckNames.saleOutCapability,
    materialStockScenarioCheckNames.saleReturnNonPhysical,
    materialStockScenarioCheckNames.saleReturnCapability
  ]),
  virtualPhysicalMoveRejections: Object.freeze([
    materialStockScenarioCheckNames.purchaseInNonPhysical,
    materialStockScenarioCheckNames.purchaseReturnNonPhysical,
    materialStockScenarioCheckNames.saleOutNonPhysical,
    materialStockScenarioCheckNames.saleReturnNonPhysical
  ]),
  servicePurchaseOrderWithoutInventory: Object.freeze([
    materialStockScenarioCheckNames.servicePurchaseOrder,
    materialStockScenarioCheckNames.serviceInventoryUnchanged,
    materialStockScenarioCheckNames.servicePurchaseInNonPhysical
  ]),
  mixedStockPurchaseOrder: Object.freeze([
    materialStockScenarioCheckNames.stockPurchaseOrder,
    materialStockScenarioCheckNames.stockInventoryUnchanged
  ])
})

const createUnexpectedResource = async (api, fixture, probe, response) => {
  if (!isBusinessSuccess(response)) return null
  const id = exactId(dataOf(response), `${probe.kind} 意外单据`)
  const base = {
    purchaseIn: '/erp/purchase-in',
    purchaseReturn: '/erp/purchase-return',
    saleOut: '/erp/sale-out',
    saleReturn: '/erp/sale-return'
  }[probe.kind]
  const resource = {
    kind: probe.kind,
    material: probe.material,
    marker: fixture.marker,
    billNo: null,
    id
  }
  fixture.unexpectedDocuments.push(resource)
  const detail = dataOf(await api.getBusiness(`${base}/get?id=${encodeURIComponent(id)}`))
  const actualBillNo = text(detail?.billNo ?? detail?.no)
  if (!actualBillNo) throw new Error(`${probe.kind} 意外单据成功返回后缺少正式单号`)
  probe.billNo = actualBillNo
  resource.billNo = actualBillNo
  return resource
}

const cleanupDocument = async (api, document) => {
  const base = {
    purchaseIn: '/erp/purchase-in',
    purchaseReturn: '/erp/purchase-return',
    saleOut: '/erp/sale-out',
    saleReturn: '/erp/sale-return'
  }[document.kind]
  const detail = dataOf(await api.getBusiness(`${base}/get?id=${encodeURIComponent(document.id)}`))
  const no = text(detail?.billNo ?? detail?.no)
  if (exactId(detail?.id, '意外单据详情') !== document.id ||
      (document.billNo != null && no !== document.billNo) ||
      text(detail?.remark) !== document.marker ||
      !Array.isArray(detail?.items) || !detail.items.some((item) =>
        text(item?.productId ?? item?.materialId) === document.material.id)) {
    throw new Error(`意外 ${document.kind} 单据所有权或明细不匹配`)
  }
  await api.deleteBusiness(`${base}/delete?ids=${encodeURIComponent(document.id)}`)
  const after = await pageOf(await api.getBusiness(pagePathFor(document.kind, document.billNo, document.material.id)),
    `${document.kind} 意外单据删除后分页`)
  if (after.total !== 0 || after.rows.length !== 0) throw new Error(`${document.kind} 意外单据删除后分页仍有残留`)
}

export async function cleanupMaterialStockScenarioFixtures (api, fixture, caseRecord, readSql = runReadOnlySql) {
  const failures = []
  for (const document of [...(fixture?.unexpectedDocuments || [])].reverse()) {
    try {
      await cleanupDocument(api, document)
    } catch (error) {
      failures.push(`${document.kind}/${document.id}: ${error.message}`)
    }
  }
  for (const order of [...(fixture?.orders || [])].reverse()) {
    try {
      const base = orderEndpoint(order.kind)
      const detail = dataOf(await api.getBusiness(`${base}/get?id=${encodeURIComponent(order.id)}`))
      if (!ownsOrder(detail, { ...order, materialId: order.materialId })) throw new Error('正控制订单所有权或明细不匹配')
      const hasLifecycleFields = ['billStage', 'isEffective', 'isClosed']
        .some((field) => Object.prototype.hasOwnProperty.call(detail || {}, field))
      const shouldVoid = hasLifecycleFields && (
        String(detail?.billStage || '') !== '12' ||
        Number(detail?.isEffective || 0) !== 0 ||
        Number(detail?.isClosed || 0) !== 0
      )
      if (shouldVoid) {
        const voidPath = order.kind === 'purchase'
          ? '/erp/purchase-order/void'
          : '/erp/sale-order/void'
        await api.putBusiness(voidPath, { id: order.id })
        const afterVoid = dataOf(await api.getBusiness(`${base}/get?id=${encodeURIComponent(order.id)}`))
        if (String(afterVoid?.billStage || '') !== '12' ||
            Number(afterVoid?.isEffective || 0) !== 0 ||
            Number(afterVoid?.isClosed || 0) !== 0) {
          throw new Error(`正控制订单作废后未回到可删除编制态：${JSON.stringify({
            billStage: afterVoid?.billStage,
            isEffective: afterVoid?.isEffective,
            isClosed: afterVoid?.isClosed
          })}`)
        }
      }
      await api.deleteBusiness(`${base}/delete?ids=${encodeURIComponent(order.id)}`)
      const after = dataOf(await api.getBusiness(`${base}/get?id=${encodeURIComponent(order.id)}`))
      if (after != null) throw new Error('正控制订单删除后详情仍可见')
    } catch (error) {
      failures.push(`order/${order.id}: ${error.message}`)
    }
  }
  for (const request of [...(fixture?.purchaseRequests || [])].reverse()) {
    try {
      const detail = dataOf(await api.getBusiness(
        `/erp/purchase/order/request/get?id=${encodeURIComponent(request.id)}`))
      const owned = exactId(detail?.id, '请购详情') === request.id &&
        text(detail?.billNo) === request.billNo &&
        Array.isArray(detail?.itemsList) &&
        detail.itemsList.some((item) =>
          text(item?.id) === request.itemId &&
          text(item?.productId) === request.materialId &&
          text(item?.supplierId) === request.partnerId)
      if (!owned) throw new Error('请购所有权或物料/供应商明细不匹配')
      await api.deleteBusiness(
        `/erp/purchase/order/request/delete?id=${encodeURIComponent(request.id)}`)
      const after = await api.get(
        `/erp/purchase/order/request/get?id=${encodeURIComponent(request.id)}`,
        {
          expectedBusinessRejection: {
            code: -636,
            message: 'ERP 采购订单申请不存在',
            allowServiceCode: true
          }
        }
      )
      const absent = after?.data == null &&
        (after?.code === -636 ||
          (after?.code === 0 && after?.success !== false))
      if (!absent) throw new Error(`请购删除后详情仍可见或返回异常：${JSON.stringify(after)}`)
    } catch (error) {
      failures.push(`purchase-request/${request.id}: ${error.message}`)
    }
  }
  for (const material of [...(fixture?.materials || [])].reverse()) {
    if (!material.id) continue
    try {
      const detail = dataOf(await api.getBusiness(
        `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`))
      if (!ownsMaterial(detail, material)) throw new Error('物料所有权或档案能力不匹配')
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${encodeURIComponent(material.id)}`)
      const rows = await materialPage(api, material.code)
      if (rows.some((row) => text(row?.id) === material.id || text(row?.code) === material.code)) {
        throw new Error('物料删除后按本轮 ID 或编码仍可见')
      }
    } catch (error) {
      failures.push(`material/${material.id}: ${error.message}`)
    }
  }
  const passed = failures.length === 0
  addCheck(caseRecord, materialStockScenarioCheckNames.cleanup, passed,
    passed ? `marker=${fixture?.marker}; materials=${fixture?.materials?.length || 0}; orders=${fixture?.orders?.length || 0}` : failures.join('；'))
  if (!passed) throw new Error(`PB032-002 夹具清理失败：${failures.join('；')}`)
  if (fixture?.lastBillNo) await readScenarioSql(readSql, caseRecord, 'cleanup', fixture.marker, fixture.lastBillNo,
    fixture.materials.filter((material) => material.id).map((material) => material.id))
}

const runProbe = async (api, fixture, probe, caseRecord, readSql) => {
  const beforePage = await pageSnapshot(api, probe, `${probe.label}拒绝前分页`)
  const beforeDb = await readScenarioSql(readSql, caseRecord, `${probe.kind}-before`, fixture.marker,
    probe.billNo, fixture.materials.map((material) => material.id).filter(Boolean))
  const response = await api.post(probe.path, probeBody(probe), { expectedBusinessRejection: probe.contract })
  const unexpected = await createUnexpectedResource(api, fixture, probe, response)
  const afterPage = await pageSnapshot(api, probe, `${probe.label}拒绝后分页`)
  const afterDb = await readScenarioSql(readSql, caseRecord, `${probe.kind}-after`, fixture.marker,
    probe.billNo, fixture.materials.map((material) => material.id).filter(Boolean))
  const rejected = response?.data == null && matchesExpectedBusinessRejection(response, probe.contract)
  const unchanged = beforePage.total === 0 && beforePage.rows.length === 0 &&
    afterPage.total === 0 && afterPage.rows.length === 0 && sameSnapshot(beforeDb, afterDb)
  const details = JSON.stringify({
    path: probe.path,
    billNo: probe.billNo,
    materialId: probe.material.id,
    response: { code: response?.code, message: responseMessage(response), data: response?.data ?? null },
    beforePage,
    afterPage,
    beforeDb,
    afterDb,
    unexpectedId: unexpected?.id ?? null
  })
  requireCheck(caseRecord, probe.checkName, rejected && unchanged, details)
  fixture.lastBillNo = probe.billNo
}

export async function verifyMaterialStockScenarioClosure ({
  api,
  caseRecord,
  unit,
  supplier,
  customer,
  record,
  readOnlySql = runReadOnlySql
}) {
  const unitId = exactId(unit?.id ?? unit, '启用计量单位')
  const marker = `E2E-PB032-002-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
  const fixture = {
    marker,
    materials: [],
    orders: [],
    purchaseRequests: [],
    unexpectedDocuments: [],
    lastBillNo: null
  }
  caseRecord.evidence = [...(caseRecord.evidence || [])]
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  let failure
  try {
    const [supplierId, customerId] = await Promise.all([
      readPartner(api, supplier, 'SUPPLIER', 'PB032-002 只读供应商'),
      readPartner(api, customer, 'CUSTOMER', 'PB032-002 只读客户')
    ])
    caseRecord.evidence.push(`PB032-002 只读伙伴/单位：supplier=${supplierId}; customer=${customerId}; unit=${unitId}`)

    const [service, virtual, purchaseDisabled, saleDisabled, mixed] = await Promise.all([
      createMaterial(api, fixture, {
        code: codeOf(marker, 'SERVICE'), unitId, inventoryNature: 'SERVICE', source: 'purchase',
        purchased: 'Y', saled: 'Y', produced: 'N'
      }),
      createMaterial(api, fixture, {
        code: codeOf(marker, 'VIRTUAL'), unitId, inventoryNature: 'VIRTUAL', source: 'purchase',
        purchased: 'Y', saled: 'Y', produced: 'N'
      }),
      createMaterial(api, fixture, {
        code: codeOf(marker, 'PURCHASE-DISABLED'), unitId, inventoryNature: 'STOCK', source: 'manufacture',
        purchased: 'N', saled: 'Y', produced: 'Y'
      }),
      createMaterial(api, fixture, {
        code: codeOf(marker, 'SALE-DISABLED'), unitId, inventoryNature: 'STOCK', source: 'purchase',
        purchased: 'Y', saled: 'N', produced: 'N'
      }),
      createMaterial(api, fixture, {
        code: codeOf(marker, 'MIXED'), unitId, inventoryNature: 'STOCK', source: 'mixed',
        purchased: 'Y', saled: 'Y', produced: 'Y'
      })
    ])

    const serviceBefore = await readScenarioSql(readOnlySql, caseRecord, 'service-order-before', marker,
      codeOf(marker, 'SERVICE-ORDER'), [service.id])
    await createOwnedOrder(api, fixture, caseRecord, {
      kind: 'purchase', material: service, partnerId: supplierId, suffix: 'SERVICE-ORDER',
      checkName: materialStockScenarioCheckNames.servicePurchaseOrder, record
    })
    const serviceAfter = await readScenarioSql(readOnlySql, caseRecord, 'service-order-after', marker,
      codeOf(marker, 'SERVICE-ORDER'), [service.id])
    requireCheck(caseRecord, materialStockScenarioCheckNames.serviceInventoryUnchanged, sameSnapshot(serviceBefore, serviceAfter),
      JSON.stringify({ serviceBefore, serviceAfter, materialId: service.id }))

    const stockBefore = await readScenarioSql(readOnlySql, caseRecord, 'stock-order-before', marker,
      codeOf(marker, 'MIXED-ORDER'), [mixed.id])
    await createOwnedOrder(api, fixture, caseRecord, {
      kind: 'purchase', material: mixed, partnerId: supplierId, suffix: 'MIXED-ORDER',
      checkName: materialStockScenarioCheckNames.stockPurchaseOrder, record
    })
    const stockAfter = await readScenarioSql(readOnlySql, caseRecord, 'stock-order-after', marker,
      codeOf(marker, 'MIXED-ORDER'), [mixed.id])
    requireCheck(caseRecord, materialStockScenarioCheckNames.stockInventoryUnchanged, sameSnapshot(stockBefore, stockAfter),
      JSON.stringify({ stockBefore, stockAfter, materialId: mixed.id }))

    const probes = [
      {
        kind: 'purchaseIn', label: 'SERVICE 采购入库', path: '/erp/purchase-in/create', material: service,
        partnerId: supplierId, billNo: codeOf(marker, 'PURCHASE-IN-SERVICE'),
        contract: materialStockScenarioContracts.servicePurchaseInNonPhysical,
        checkName: materialStockScenarioCheckNames.servicePurchaseInNonPhysical
      },
      {
        kind: 'purchaseIn', label: '采购入库', path: '/erp/purchase-in/create', material: virtual,
        partnerId: supplierId, billNo: codeOf(marker, 'PURCHASE-IN-VIRTUAL'),
        contract: materialStockScenarioContracts.purchaseInNonPhysical,
        checkName: materialStockScenarioCheckNames.purchaseInNonPhysical
      },
      {
        kind: 'purchaseIn', label: '采购入库', path: '/erp/purchase-in/create', material: purchaseDisabled,
        partnerId: supplierId, billNo: codeOf(marker, 'PURCHASE-IN-DISABLED'),
        contract: materialStockScenarioContracts.purchaseInCapability,
        checkName: materialStockScenarioCheckNames.purchaseInCapability
      },
      {
        kind: 'purchaseReturn', label: '采购退货', path: '/erp/purchase-return/create', material: virtual,
        partnerId: supplierId, billNo: codeOf(marker, 'PURCHASE-RETURN-VIRTUAL'),
        contract: materialStockScenarioContracts.purchaseReturnNonPhysical,
        checkName: materialStockScenarioCheckNames.purchaseReturnNonPhysical
      },
      {
        kind: 'purchaseReturn', label: '采购退货', path: '/erp/purchase-return/create', material: purchaseDisabled,
        partnerId: supplierId, billNo: codeOf(marker, 'PURCHASE-RETURN-DISABLED'),
        contract: materialStockScenarioContracts.purchaseReturnCapability,
        checkName: materialStockScenarioCheckNames.purchaseReturnCapability
      },
      {
        kind: 'saleOut', label: '销售出库', path: '/erp/sale-out/create', material: virtual,
        partnerId: customerId, billNo: codeOf(marker, 'SALE-OUT-VIRTUAL'),
        contract: materialStockScenarioContracts.saleOutNonPhysical,
        checkName: materialStockScenarioCheckNames.saleOutNonPhysical
      },
      {
        kind: 'saleOut', label: '销售出库', path: '/erp/sale-out/create', material: saleDisabled,
        partnerId: customerId, billNo: codeOf(marker, 'SALE-OUT-DISABLED'),
        contract: materialStockScenarioContracts.saleOutCapability,
        checkName: materialStockScenarioCheckNames.saleOutCapability
      },
      {
        kind: 'saleReturn', label: '销售退货', path: '/erp/sale-return/create', material: virtual,
        partnerId: customerId, billNo: codeOf(marker, 'SALE-RETURN-VIRTUAL'),
        contract: materialStockScenarioContracts.saleReturnNonPhysical,
        checkName: materialStockScenarioCheckNames.saleReturnNonPhysical
      },
      {
        kind: 'saleReturn', label: '销售退货', path: '/erp/sale-return/create', material: saleDisabled,
        partnerId: customerId, billNo: codeOf(marker, 'SALE-RETURN-DISABLED'),
        contract: materialStockScenarioContracts.saleReturnCapability,
        checkName: materialStockScenarioCheckNames.saleReturnCapability
      }
    ]
    for (const probe of probes) await runProbe(api, fixture, probe, caseRecord, readOnlySql)
    caseRecord.evidence.push(`PB032-002 四类 ERP create API 已使用 marker=${marker} 完成正式拒绝、分页、数据库和 WMS 库存前后核对`)
  } catch (error) {
    failure = error
  }
  try {
    await cleanupMaterialStockScenarioFixtures(api, fixture, caseRecord, readOnlySql)
  } catch (cleanupError) {
    if (failure) {
      throw new AggregateError(
        [failure, cleanupError],
        `PB032-002 场景失败且夹具清理失败：${cleanupError.message}`
      )
    }
    throw cleanupError
  }
  if (failure) throw failure
  return fixture
}

export const __internal = {
  codeOf,
  exactId,
  materialBody,
  materialSnapshot,
  ownsMaterial,
  orderBody,
  ownsOrder,
  pagePathFor,
  probeBody,
  scenarioSql,
  sameSnapshot,
  createUnexpectedResource
}
