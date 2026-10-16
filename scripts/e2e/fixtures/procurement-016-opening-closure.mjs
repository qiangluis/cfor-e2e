import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

const historicalCode = 1_030_102_040

export const PROCUREMENT_016_CONTRACTS = Object.freeze({
  purchaseOrderApproval: Object.freeze({
    draftStatus: 0,
    processStatus: 10,
    approvedStatus: 20,
    processKey: 'erp-purchase-order-approval',
    submitStatus: 10
  }),
  historicalOrderPayable: Object.freeze({
    code: historicalCode,
    message: /来源采购订单已存在历史应付单.*为避免重复挂账，请先处理历史应付/
  }),
  invoiceAlreadyApproved: Object.freeze({
    code: 1_030_102_003,
    message: '审核失败，只有未审核的采购发票才能审核'
  })
})

export const PROCUREMENT_016_ACCEPTANCE_GAPS = Object.freeze([
  Object.freeze({
    index: 0,
    assertion: '采购发票分页返回 srcBillType、srcBillId、details、isEffective',
    evidence: 'fixture 回读每张专属发票详情并要求来源字段、details、isEffective 存在'
  }),
  Object.freeze({
    index: 1,
    assertion: '按发票来源订单反查未作废历史订单应付，不发现重复发票应付',
    evidence: '历史应付存在场景精确拒绝审核，并核对 PurInvoice 应付不存在；无历史应付场景精确核对唯一 PurInvoice 应付'
  }),
  Object.freeze({
    index: 2,
    assertion: '采购发票页面正常渲染并保留人工复核入口',
    evidence: 'captureProcurement016PageEvidence 只读页面、截图并检查复核入口；未注入页面时明确 DEFERRED'
  }),
  Object.freeze({
    index: 3,
    assertion: '后端定向单测覆盖历史应付存在、历史应付不存在、期初发票跳过三分支',
    evidence: '后端三分支测试路径作为 fixture evidence 记录，Java 单测不在本轮修改范围'
  })
])

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data

export const stableId = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value !== 'string') return null
  return /^[1-9]\d*$/.test(value) ? value : null
}

const tagOf = () => `PROC016_${Date.now().toString(36).toUpperCase()}_${randomBytes(3).toString('hex')}`
const localDateTime = () => new Date().toISOString().slice(0, 19)
const localDate = () => localDateTime().slice(0, 10)

export const canonicalSnapshot = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item)

export const exactProcurement016Rejection = (payload, contract) =>
  payload?.data === null && matchesExpectedBusinessRejection(payload, contract)

export const assertProcurement016Rejection = (payload, contract, label) => {
  if (!exactProcurement016Rejection(payload, contract)) {
    throw new Error(`${label}不是精确采购领域拒绝：${JSON.stringify({
      code: payload?.code,
      message: payload?.msg || payload?.message,
      data: payload?.data
    })}`)
  }
  return payload
}

export const assertProcurement016Unchanged = (before, after, label) => {
  const beforeText = canonicalSnapshot(before)
  const afterText = canonicalSnapshot(after)
  if (beforeText !== afterText) {
    throw new Error(`${label}前后完整快照不一致：before=${beforeText}; after=${afterText}`)
  }
  return true
}

export const assertProcurement016ApprovedTransition = (before, after, generated, invoiceId, label) => {
  const beforeInvoice = before?.invoice
  const afterInvoice = after?.invoice
  if (!beforeInvoice || !afterInvoice || String(afterInvoice.isEffective) !== '1') {
    throw new Error(`${label}审核后采购发票未进入生效状态`)
  }
  for (const field of ['id', 'srcBillType', 'srcBillId', 'details', 'invoiceMoney']) {
    if (String(afterInvoice[field] ?? '') !== String(beforeInvoice[field] ?? '')) {
      throw new Error(`${label}审核成功后发票字段 ${field} 未保持来源或金额快照`)
    }
  }
  if (!Array.isArray(generated) || generated.length !== 1) {
    throw new Error(`${label}审核成功后没有唯一 PurInvoice 应付快照`)
  }
  const payable = generated[0]
  if (String(payable.srcBillType) !== 'PurInvoice' || String(payable.srcBillId) !== String(invoiceId)) {
    throw new Error(`${label}审核成功后应付来源不是当前专属采购发票`)
  }
  return true
}

const requirePageRows = (payload, label) => {
  const data = dataOf(payload, label)
  if (Array.isArray(data?.records)) return data.records
  if (Array.isArray(data?.list)) return data.list
  throw new Error(`${label}缺少明确 records/list 数组，不能把空数组当作通过`)
}

const addFixture = (caseRecord, fixture) => {
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  return fixture
}

const addEvidence = (caseRecord, text) => {
  caseRecord.evidence = [...(caseRecord.evidence || []), text]
}

const registerFixtureResource = (fixture, resource) => {
  const owned = {
    ...resource,
    marker: fixture.tag,
    ownership: resource.ownership || 'dedicated',
    cleanup: resource.cleanup || 'retained-or-formal-deactivate-only'
  }
  fixture.resources = [...(fixture.resources || []), owned]
  if (owned.ownership === 'dedicated') {
    fixture.cleanupPlan = [...(fixture.cleanupPlan || []), {
      kind: owned.kind,
      id: owned.id,
      action: owned.cleanup
    }]
  }
  return owned
}

const readInvoice = async (api, invoiceId, label) => dataOf(
  await api.getBusiness(`/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`), label)

const readOrder = async (api, orderId, label) => dataOf(
  await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`), label)

const readPurchaseIn = async (api, purchaseInId, label) => dataOf(
  await api.getBusiness(`/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`), label)

const readPayable = async (api, payableId, label) => dataOf(
  await api.getBusiness(`/finance/finPayable/queryById?id=${encodeURIComponent(payableId)}`), label)

const sourcePayables = async (api, sourceId, label) => {
  const rows = dataOf(await api.getBusiness(
    `/finance/finPayable/getPayableByPurId?id=${encodeURIComponent(sourceId)}`), label)
  if (!Array.isArray(rows)) throw new Error(`${label}返回值不是数组`)
  return rows
}

const assertInvoiceSourceFields = (invoice, label) => {
  for (const field of ['srcBillType', 'srcBillId', 'details', 'isEffective']) {
    if (!Object.prototype.hasOwnProperty.call(invoice || {}, field)) {
      throw new Error(`${label}缺少字段 ${field}`)
    }
  }
  return invoice
}

const pageRows = (payload, label) => {
  const data = dataOf(payload, label)
  if (Array.isArray(data?.records)) return data.records
  if (Array.isArray(data?.list)) return data.list
  throw new Error(`${label}缺少明确 records/list 数组`)
}

export const findUniqueProcurement016Invoice = (rows, invoice) => {
  if (!Array.isArray(rows)) return null
  const invoiceId = stableId(invoice?.invoiceId ?? invoice?.id ?? invoice?.created?.id)
  const invoiceNo = String(invoice?.invoiceNo ?? invoice?.created?.invoiceNo ?? '').trim()
  if (!invoiceId || !invoiceNo) return null
  const matches = rows.filter((row) =>
    stableId(row?.id) === invoiceId && String(row?.invoiceNo ?? '').trim() === invoiceNo)
  return matches.length === 1 ? matches[0] : null
}

const readBrowserBusinessResponse = async (response) => {
  if (!response) throw new Error('采购发票页面未捕获业务响应')
  const text = await response.text()
  const headers = response.headers()
  const encrypted = headers?.[ENCRYPT_HEADER.toLowerCase()] === 'true' ||
    headers?.[ENCRYPT_HEADER] === 'true'
  return encrypted ? decryptResponse(text) : JSON.parse(text)
}

const sameDetails = (left, right) => {
  if (String(left ?? '') === String(right ?? '')) return true
  try {
    return canonicalSnapshot(JSON.parse(left)) === canonicalSnapshot(JSON.parse(right))
  } catch {
    return false
  }
}

export const assertProcurement016InvoiceDetail = (detail, expected, label) => {
  if (!detail || stableId(detail.id) !== stableId(expected?.invoiceId ?? expected?.id ?? expected?.created?.id)) {
    throw new Error(`${label}详情不是专属发票`)
  }
  const expectedRecord = expected?.created || expected
  for (const field of ['srcBillType', 'srcBillId', 'details', 'isEffective']) {
    if (!Object.prototype.hasOwnProperty.call(detail, field)) {
      throw new Error(`${label}详情缺少字段 ${field}`)
    }
  }
  if (String(detail.srcBillType) !== String(expectedRecord.srcBillType) ||
      String(detail.srcBillId) !== String(expectedRecord.srcBillId) ||
      !sameDetails(detail.details, expectedRecord.details) ||
      String(detail.isEffective) !== String(expectedRecord.isEffective)) {
    throw new Error(`${label}详情来源、明细或生效字段与专属发票不一致`)
  }
  return true
}

const createSupplier = async (api, fixture, tag) => {
  const name = `E2E-${tag}-SUPPLIER`
  const supplierId = stableId(dataOf(await api.postBusiness('/base/partner/create', {
    name,
    shortName: name.slice(0, 12),
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled: false,
    supplierEnabled: true,
    carrierEnabled: false,
    remark: `PROC-016 isolated supplier ${tag}`
  }), 'PROC-016 专属供应商创建'))
  if (!supplierId) throw new Error('PROC-016 专属供应商未返回稳定 ID')
  fixture.supplierId = supplierId
  fixture.cleanupPlan.push({ kind: 'supplier', id: supplierId, action: 'retained-or-formal-deactivate-only' })
  return supplierId
}

const enabledUnit = async (api, fixture) => {
  const payload = await api.getBusiness('/mes/basUnit/list/enabled')
  const rows = dataOf(payload, 'PROC-016 启用计量单位')
  if (!Array.isArray(rows)) throw new Error('PROC-016 启用计量单位接口必须返回明确数组')
  const unit = rows.find((row) => stableId(row?.id) && row?.isEnabled !== 0 && row?.isEnabled !== false)
  if (!unit) throw new Error('BLOCKED: PROC-016 没有可用启用计量单位')
  const unitId = stableId(unit.id)
  registerFixtureResource(fixture, {
    kind: 'unit',
    id: unitId,
    name: unit.name,
    ownership: 'shared-readonly-dependency',
    cleanup: 'do-not-touch'
  })
  return unitId
}

const flattenWarehouseTree = (nodes) => (nodes || []).flatMap((row) => [row, ...flattenWarehouseTree(row?.children)])

const createDedicatedWarehouse = async (api, fixture, tag) => {
  const code = `${tag}-WH`
  const name = `${tag}-PROCUREMENT-WH`
  await api.postBusiness('/mes/wmsWareHouse/add', {
    code,
    name,
    mark: tag,
    pid: '0',
    isEnabled: true,
    countInAvailable: true,
    areaEnabled: false,
    locationEnabled: false
  })
  const tree = dataOf(await api.getBusiness('/mes/wmsWareHouse/allTree'), 'PROC-016 专属仓库树回读')
  const rows = Array.isArray(tree) ? tree : Array.isArray(tree?.list) ? tree.list : null
  if (!rows) throw new Error('PROC-016 专属仓库树接口必须返回明确数组')
  const matches = flattenWarehouseTree(rows).filter((row) =>
    String(row?.name) === name)
  if (matches.length !== 1) {
    throw new Error(`PROC-016 专属仓库回读不唯一：${code}; count=${matches.length}`)
  }
  const warehouseId = stableId(matches[0].id)
  if (!warehouseId) throw new Error('PROC-016 专属仓库未返回稳定 ID')
  const warehouse = dataOf(await api.getBusiness(
    `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(warehouseId)}`),
  'PROC-016 专属仓库详情回读')
  if (stableId(warehouse?.id) !== warehouseId || String(warehouse?.code) !== code ||
      String(warehouse?.name) !== name || String(warehouse?.mark) !== tag ||
      warehouse?.isEnabled === false) {
    throw new Error(`PROC-016 专属仓库归属回读失败：${warehouseId}`)
  }
  const resource = registerFixtureResource(fixture, {
    kind: 'warehouse',
    id: warehouseId,
    code,
    name,
    cleanup: 'retained-or-formal-deactivate-only'
  })
  return { ...resource, detail: warehouse }
}

const createDedicatedMaterial = async (api, fixture, tag, unitId) => {
  const code = `${tag}-MAT`
  const id = stableId(dataOf(await api.postBusiness('/mes/basMaterial/add', {
    code,
    name: `${tag}-PROCUREMENT-MATERIAL`,
    auxName: `${tag}-PROCUREMENT-MATERIAL`,
    unitId,
    inventoryNature: 'STOCK',
    virtualGoods: 'N',
    isMaterial: 'Y',
    isEnabled: 1,
    purchased: 'Y',
    saled: 'Y',
    produced: 'N',
    parented: 'N',
    source: 'purchase',
    leadTime: 1,
    bufferTime: 1,
    refCost: 10,
    refPrice: 20,
    batchManaged: 'N',
    oneBarcode: 'N',
    periodManaged: 'N',
    gradeManaged: 'N',
    colorManaged: 'N',
    brandManaged: 'N',
    backflush: 'N',
    remark: tag
  }), 'PROC-016 专属物料创建'))
  if (!id) throw new Error('PROC-016 专属物料未返回稳定 ID')
  const material = dataOf(await api.getBusiness(
    `/mes/basMaterial/queryById?id=${encodeURIComponent(id)}`),
  'PROC-016 专属物料详情回读')
  if (stableId(material?.id) !== id || String(material?.code) !== code ||
      stableId(material?.unitId) !== unitId || String(material?.remark) !== tag ||
      material?.isEnabled === 0 || material?.isEnabled === false) {
    throw new Error(`PROC-016 专属物料归属回读失败：${id}`)
  }
  const resource = registerFixtureResource(fixture, {
    kind: 'material',
    id,
    code,
    name: material.name,
    unitId,
    cleanup: 'retained-or-formal-deactivate-only'
  })
  return { ...resource, detail: material }
}

export const readDedicatedStockBaseline = async (api, materialId, warehouseId, label = 'PROC-016 专属库存基线') => {
  const query = `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100` +
    `&materialId=${encodeURIComponent(materialId)}&warehouseId=${encodeURIComponent(warehouseId)}`
  const data = dataOf(await api.getBusiness(query), label)
  const rows = Array.isArray(data?.list) ? data.list : Array.isArray(data?.records) ? data.records : null
  if (!rows) throw new Error(`${label}缺少明确 list/records 数组，不能把空数组当作通过`)
  const total = Number(data?.total)
  if (!Number.isInteger(total) || total !== rows.length) {
    throw new Error(`${label} total 与明确分页数组不一致：total=${String(data?.total)}; rows=${rows.length}`)
  }
  if (rows.length !== 0 || total !== 0) {
    throw new Error(`${label}必须为零：total=${total}; rows=${JSON.stringify(rows)}`)
  }
  return { total, rows }
}

const createDedicatedResources = async (api, fixture, tag) => {
  const unitId = await enabledUnit(api, fixture)
  const material = await createDedicatedMaterial(api, fixture, tag, unitId)
  const warehouse = await createDedicatedWarehouse(api, fixture, tag)
  const stockBaseline = await readDedicatedStockBaseline(api, material.id, warehouse.id)
  fixture.stockBaseline = {
    materialId: material.id,
    warehouseId: warehouse.id,
    baseline: 0,
    source: 'formal-read-api:/mes/stkIo/queryStockQty',
    rows: stockBaseline.rows
  }
  return { unitId, material, warehouse, stockBaseline }
}

const createAccount = async (api, fixture, tag) => {
  const accountId = stableId(dataOf(await api.postBusiness('/erp/account/create', {
    name: `E2E-${tag}-ACCOUNT`,
    no: `E2E-${tag}-ACCOUNT`,
    accountType: 'BANK',
    currency: 'CNY',
    status: 0,
    sort: 999,
    remark: `PROC-016 isolated account ${tag}`
  }), 'PROC-016 专属结算账户创建'))
  if (!accountId) throw new Error('PROC-016 专属结算账户未返回稳定 ID')
  fixture.accountId = accountId
  fixture.cleanupPlan.push({ kind: 'account', id: accountId, action: 'retained-or-formal-deactivate-only' })
  return accountId
}

const purchaseOrderIsApproved = (order) =>
  String(order?.status) === String(PROCUREMENT_016_CONTRACTS.purchaseOrderApproval.approvedStatus)

const purchaseOrderHasBpm = (order) =>
  Boolean(order?.processInstanceId) &&
  (String(order?.status) === String(PROCUREMENT_016_CONTRACTS.purchaseOrderApproval.processStatus) ||
    ['22', 'AUDITING'].includes(String(order?.billStage)))

export const ensureProcurement016PurchaseOrderSubmitted = async (api, orderId, label) => {
  const initial = await readOrder(api, orderId, `${label}创建后回读`)
  if (purchaseOrderIsApproved(initial)) {
    return { order: initial, action: 'already-approved', submitted: false }
  }
  if (purchaseOrderHasBpm(initial)) {
    return { order: initial, action: 'existing-formal-bpm', submitted: false }
  }

  const status = String(initial?.status)
  if (status !== String(PROCUREMENT_016_CONTRACTS.purchaseOrderApproval.draftStatus)) {
    throw new Error(`${label}状态不支持正式提交：status=${String(initial?.status)}; billStage=${String(initial?.billStage)}`)
  }

  // status=10 is the controller's formal submit/BPM entry; status=20 is reverse approval.
  await api.putBusiness(
    `/erp/purchase-order/update-status?id=${encodeURIComponent(orderId)}&status=${PROCUREMENT_016_CONTRACTS.purchaseOrderApproval.submitStatus}`)
  const submitted = await readOrder(api, orderId, `${label}正式提交后回读`)
  if (purchaseOrderIsApproved(submitted) || purchaseOrderHasBpm(submitted)) {
    return { order: submitted, action: 'formal-submit', submitted: true }
  }
  throw new Error(`${label}正式提交后未进入已审核或 BPM 审批状态：${JSON.stringify({
    status: submitted?.status,
    billStage: submitted?.billStage,
    processInstanceId: submitted?.processInstanceId
  })}`)
}

const createOrder = async (api, fixture, { tag, supplierId, material, suffix }) => {
  const orderId = stableId(dataOf(await api.postBusiness('/erp/purchase-order/create', {
    type: 0,
    supplierId,
    orderTime: localDateTime(),
    billDate: localDate(),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 1,
    totalProductPrice: 10,
    totalTaxPrice: 0,
    totalPrice: 10,
    settleMethodCode: '1',
    directCreate: 1,
    directCreateReason: `${tag} ${suffix} direct create`,
    remark: `${tag} ${suffix} order`,
    items: [{
      entryNo: 1,
      productId: material.id,
      productUnitId: material.unitId,
      productPrice: 10,
      count: 1,
      taxPercent: 0,
      totalPrice: 10,
      taxPrice: 0,
      remark: `${tag} ${suffix} line`
    }]
  }), `PROC-016 ${suffix}采购订单创建`))
  if (!orderId) throw new Error(`PROC-016 ${suffix}采购订单未返回稳定 ID`)
  fixture.cleanupPlan.push({ kind: 'purchase-order', id: orderId, action: 'retain-approved-or-formal-delete-draft-only' })
  const submitted = await ensureProcurement016PurchaseOrderSubmitted(
    api, orderId, `PROC-016 ${suffix}采购订单`)
  return {
    orderId,
    draft: submitted.order,
    approved: submitted.order,
    approval: submitted,
    item: submitted.order?.items?.[0]
  }
}

const createInvoice = async (api, fixture, { tag, supplierId, sourceId, sourceType, sourceItem, suffix }) => {
  const invoiceId = stableId(dataOf(await api.postBusiness('/erp/purchase-invoice/create', {
    supplierId,
    companyName: '',
    taxNo: '',
    invoiceNo: `${tag}-${suffix}-INV`,
    invoiceType: 1,
    taxRate: 0,
    invoiceMoney: 10,
    invoicePrice: 10,
    isRubric: 0,
    remark: `${tag} ${suffix} invoice`,
    items: [{
      ...(sourceType === 'OPENING_PURCHASE_IN'
        ? { purchaseInId: sourceId, invoiceCountItem: 1 }
        : { purchaseOrderId: sourceId }),
      srcBillType: sourceType,
      invoiceMoneyItem: 10
    }]
  }), `PROC-016 ${suffix}采购发票创建`))
  if (!invoiceId) throw new Error(`PROC-016 ${suffix}采购发票未返回稳定 ID`)
  fixture.cleanupPlan.push({ kind: 'purchase-invoice', id: invoiceId, action: 'retain-approved-or-formal-delete-draft-only' })
  const created = assertInvoiceSourceFields(
    await readInvoice(api, invoiceId, `PROC-016 ${suffix}采购发票创建回读`),
    `PROC-016 ${suffix}采购发票`)
  if (String(created.srcBillType) !== sourceType || String(created.srcBillId) !== String(sourceId) ||
      !String(created.details || '').includes(String(sourceId))) {
    throw new Error(`PROC-016 ${suffix}采购发票来源回读不一致`)
  }
  return { invoiceId, created, sourceItem }
}

const createHistoricalPayable = async (api, fixture, { supplierId, order, material, tag }) => {
  const billNo = `${tag}-HISTORICAL-PAYABLE`
  const sourceBillNo = order.approved?.billNo || order.draft?.billNo || order.billNo || order.orderId
  const payableId = stableId(dataOf(await api.postBusiness('/finance/finPayable/add/submit', {
    billNo,
    payableType: '201',
    supplierId,
    amt: 10,
    checkedAmt: 0,
    afterSaveCheckedAmt: 0,
    isRubric: 0,
    isAuto: 0,
    isVoided: 0,
    srcBillType: 'PurOrder',
    srcBillId: order.orderId,
    srcNo: sourceBillNo,
    billDate: localDate(),
    remark: `${tag} historical order payable`,
    finPayableEntryList: [{
      entryNo: 1,
      billNo,
      srcBillType: 'PurOrder',
      srcBillId: order.orderId,
      srcEntryId: order.item?.id,
      srcNo: `${sourceBillNo}:1`,
      amt: 10,
      checkedAmt: 0,
      afterSaveCheckedAmt: 0,
      materialId: material.id,
      unitId: material.unitId,
      qty: 1,
      price: 10
    }]
  }), 'PROC-016 历史采购订单应付创建'))
  if (!payableId) throw new Error('PROC-016 历史采购订单应付未返回稳定 ID')
  fixture.cleanupPlan.push({ kind: 'historical-payable', id: payableId, action: 'retain-or-formal-delete-if-unchecked' })
  const payable = await readPayable(api, payableId, 'PROC-016 历史应付回读')
  if (String(payable?.srcBillType) !== 'PurOrder' || String(payable?.srcBillId) !== String(order.orderId) ||
      Number(payable?.isVoided) === 1) {
    throw new Error('PROC-016 历史应付来源或未作废状态回读不一致')
  }
  return { payableId, payable }
}

const runHistoricalOrderPayableScenario = async (api, fixture, context) => {
  const order = await createOrder(api, fixture, context)
  const historical = await createHistoricalPayable(api, fixture, { ...context, order })
  const orderPayables = await sourcePayables(api, order.orderId, 'PROC-016 历史订单应付前置反查')
  if (!orderPayables.some((item) => String(item?.id) === historical.payableId &&
      String(item?.srcBillType) === 'PurOrder' && Number(item?.isVoided) !== 1)) {
    throw new Error('PROC-016 历史订单应付前置未回读到未作废 PurOrder 应付')
  }
  const invoice = await createInvoice(api, fixture, {
    ...context,
    sourceId: order.orderId,
    sourceType: 'ERP_PURCHASE_ORDER',
    sourceItem: order.item,
    suffix: 'HISTORICAL'
  })
  const before = {
    order: await readOrder(api, order.orderId, 'PROC-016 历史拒绝前采购订单快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 历史拒绝前采购发票快照'),
    payable: await readPayable(api, historical.payableId, 'PROC-016 历史拒绝前应付快照')
  }
  const rejected = assertProcurement016Rejection(await api.put(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoice.invoiceId)}`,
    undefined,
    { expectedBusinessRejection: PROCUREMENT_016_CONTRACTS.historicalOrderPayable }
  ), PROCUREMENT_016_CONTRACTS.historicalOrderPayable, 'PROC-016 历史应付存在审核')
  const after = {
    order: await readOrder(api, order.orderId, 'PROC-016 历史拒绝后采购订单快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 历史拒绝后采购发票快照'),
    payable: await readPayable(api, historical.payableId, 'PROC-016 历史拒绝后应付快照')
  }
  assertProcurement016Unchanged(before, after, 'PROC-016 历史应付存在首次拒绝')
  const duplicate = assertProcurement016Rejection(await api.put(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoice.invoiceId)}`,
    undefined,
    { expectedBusinessRejection: PROCUREMENT_016_CONTRACTS.historicalOrderPayable }
  ), PROCUREMENT_016_CONTRACTS.historicalOrderPayable, 'PROC-016 历史应付存在重复审核')
  const duplicateAfter = {
    order: await readOrder(api, order.orderId, 'PROC-016 历史重复拒绝后采购订单快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 历史重复拒绝后采购发票快照'),
    payable: await readPayable(api, historical.payableId, 'PROC-016 历史重复拒绝后应付快照')
  }
  assertProcurement016Unchanged(after, duplicateAfter, 'PROC-016 历史应付存在重复拒绝')
  const generated = await sourcePayables(api, invoice.invoiceId, 'PROC-016 历史拒绝后发票应付反查')
  if (generated.some((item) => String(item?.srcBillType) === 'PurInvoice')) {
    throw new Error('PROC-016 历史应付存在时仍生成了采购发票应付')
  }
  return {
    scenario: 'historical-order-payable-exists', order, historical, orderPayables,
    invoice, rejected, duplicate, before, after, generated,
    snapshots: {
      before: canonicalSnapshot(before),
      after: canonicalSnapshot(after),
      duplicateAfter: canonicalSnapshot(duplicateAfter)
    }
  }
}

const runNoHistoricalPayableScenario = async (api, fixture, context) => {
  const order = await createOrder(api, fixture, context)
  const orderPayables = await sourcePayables(api, order.orderId, 'PROC-016 无历史订单应付前置反查')
  if (orderPayables.some((item) => String(item?.srcBillType) === 'PurOrder' && Number(item?.isVoided) !== 1)) {
    throw new Error('PROC-016 无历史场景前置已经存在未作废 PurOrder 应付')
  }
  const invoice = await createInvoice(api, fixture, {
    ...context,
    sourceId: order.orderId,
    sourceType: 'ERP_PURCHASE_ORDER',
    sourceItem: order.item,
    suffix: 'NO-HISTORICAL'
  })
  const payablesBefore = await sourcePayables(api, invoice.invoiceId, 'PROC-016 无历史审核前发票应付反查')
  const before = {
    order: await readOrder(api, order.orderId, 'PROC-016 无历史拒绝前采购订单快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 无历史审核前采购发票快照'),
    payables: payablesBefore
  }
  const approved = dataOf(await api.putBusiness(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoice.invoiceId)}`),
  'PROC-016 无历史采购发票审核')
  const after = {
    order: await readOrder(api, order.orderId, 'PROC-016 无历史审核后采购订单快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 无历史审核后采购发票快照')
  }
  const generated = await sourcePayables(api, invoice.invoiceId, 'PROC-016 无历史发票应付反查')
  after.payables = generated
  if (generated.length !== 1 || String(generated[0]?.srcBillType) !== 'PurInvoice' ||
      String(generated[0]?.srcBillId) !== String(invoice.invoiceId)) {
    throw new Error('PROC-016 无历史审核未生成唯一采购发票应付')
  }
  const payableId = stableId(generated[0]?.id)
  if (!payableId) throw new Error('PROC-016 无历史生成应付未返回稳定 ID')
  const payableBeforeDuplicate = await readPayable(api, payableId, 'PROC-016 无历史重复审核前应付快照')
  const payableAfter = await readPayable(api, payableId, 'PROC-016 无历史审核后应付快照')
  const approvedAfter = { ...after, payable: payableAfter }
  assertProcurement016ApprovedTransition(before, approvedAfter, generated, invoice.invoiceId,
    'PROC-016 无历史采购发票审核')
  const duplicate = assertProcurement016Rejection(await api.put(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoice.invoiceId)}`,
    undefined,
    { expectedBusinessRejection: PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved }
  ), PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved, 'PROC-016 无历史重复审核')
  const duplicateAfter = {
    order: await readOrder(api, order.orderId, 'PROC-016 无历史重复审核后采购订单快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 无历史重复审核后采购发票快照'),
    payable: await readPayable(api, payableId, 'PROC-016 无历史重复审核后应付快照'),
    payables: await sourcePayables(api, invoice.invoiceId, 'PROC-016 无历史重复审核后发票应付反查')
  }
  assertProcurement016Unchanged(approvedAfter, duplicateAfter,
    'PROC-016 无历史重复审核')
  return {
    scenario: 'historical-order-payable-absent',
    order,
    orderPayables,
    invoice,
    approved,
    before,
    after: approvedAfter,
    generated,
    payableBeforeDuplicate,
    payableAfter,
    duplicate,
    duplicateAfter,
    snapshots: {
      before: canonicalSnapshot(before),
      after: canonicalSnapshot(approvedAfter),
      duplicateAfter: canonicalSnapshot(duplicateAfter)
    }
  }
}

const runOpeningInvoiceScenario = async (api, fixture, context) => {
  const purchaseInId = stableId(dataOf(await api.postBusiness('/erp/purchase-in/create', {
    accountId: context.accountId,
    inTime: localDateTime(),
    businessType: 'OPENING',
    openingBaselineDate: localDate(),
    supplierId: context.supplierId,
    orderId: null,
    discountPercent: 0,
    otherPrice: 0,
    remark: `${context.tag} opening purchase in`,
    items: [{
      orderItemId: null,
      warehouseId: context.warehouseId,
      productId: context.material.id,
      productUnitId: context.material.unitId,
      productPrice: 10,
      count: 1,
      taxPercent: 0,
      remark: `${context.tag} opening line`
    }]
  }), 'PROC-016 期初采购入库创建'))
  if (!purchaseInId) throw new Error('PROC-016 期初采购入库未返回稳定 ID')
  fixture.cleanupPlan.push({ kind: 'opening-purchase-in', id: purchaseInId, action: 'retain-approved-or-formal-delete-draft-only' })
  await api.putBusiness(`/erp/purchase-in/update-status?id=${encodeURIComponent(purchaseInId)}&status=20`)
  const opening = await readPurchaseIn(api, purchaseInId, 'PROC-016 期初采购入库审核回读')
  const invoice = await createInvoice(api, fixture, {
    ...context,
    sourceId: purchaseInId,
    sourceType: 'OPENING_PURCHASE_IN',
    suffix: 'OPENING'
  })
  const payablesBefore = await sourcePayables(api, invoice.invoiceId, 'PROC-016 期初审核前发票应付反查')
  const before = {
    opening: await readPurchaseIn(api, purchaseInId, 'PROC-016 期初审核前入库快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 期初审核前发票快照'),
    payables: payablesBefore
  }
  const approved = dataOf(await api.putBusiness(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoice.invoiceId)}`),
  'PROC-016 期初采购发票审核')
  const after = {
    opening: await readPurchaseIn(api, purchaseInId, 'PROC-016 期初审核后入库快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 期初审核后发票快照')
  }
  const generated = await sourcePayables(api, invoice.invoiceId, 'PROC-016 期初发票应付反查')
  after.payables = generated
  if (generated.length !== 1 || String(generated[0]?.srcBillType) !== 'PurInvoice' ||
      String(generated[0]?.srcBillId) !== String(invoice.invoiceId) ||
      generated.some((item) => String(item?.srcBillType) === 'PurOrder')) {
    throw new Error('PROC-016 期初发票未生成正确来源的唯一应付')
  }
  const payableId = stableId(generated[0]?.id)
  if (!payableId) throw new Error('PROC-016 期初生成应付未返回稳定 ID')
  const payableAfter = await readPayable(api, payableId, 'PROC-016 期初审核后应付快照')
  const approvedAfter = { ...after, payable: payableAfter }
  assertProcurement016ApprovedTransition(before, approvedAfter, generated, invoice.invoiceId,
    'PROC-016 期初采购发票审核')
  const duplicate = assertProcurement016Rejection(await api.put(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoice.invoiceId)}`,
    undefined,
    { expectedBusinessRejection: PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved }
  ), PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved, 'PROC-016 期初发票重复审核')
  const duplicateAfter = {
    opening: await readPurchaseIn(api, purchaseInId, 'PROC-016 期初重复审核后入库快照'),
    invoice: await readInvoice(api, invoice.invoiceId, 'PROC-016 期初重复审核后发票快照'),
    payable: await readPayable(api, payableId, 'PROC-016 期初重复审核后应付快照'),
    payables: await sourcePayables(api, invoice.invoiceId, 'PROC-016 期初重复审核后发票应付反查')
  }
  assertProcurement016Unchanged(approvedAfter, duplicateAfter, 'PROC-016 期初重复审核')
  return {
    scenario: 'opening-invoice-skips-historical-check',
    opening,
    purchaseInId,
    invoice,
    approved,
    before,
    after: approvedAfter,
    generated,
    payableAfter,
    duplicate,
    duplicateAfter,
    snapshots: {
      before: canonicalSnapshot(before),
      after: canonicalSnapshot(approvedAfter),
      duplicateAfter: canonicalSnapshot(duplicateAfter)
    }
  }
}

export const PROCUREMENT_016_PAGE_EVIDENCE = Object.freeze({
  route: '/erp/purchase/invoice',
  requiredText: ['采购发票'],
  requiredControls: ['详情', '审核'],
  fields: ['srcBillType', 'srcBillId', 'details', 'isEffective'],
  screenshotName: 'proc-016-purchase-invoice-history'
})

export async function captureProcurement016PageEvidence ({
  page,
  openRoute,
  saveScreenshot,
  outputDir,
  record,
  invoice
} = {}) {
  if (!page || typeof openRoute !== 'function' || typeof saveScreenshot !== 'function') {
    return { status: 'DEFERRED', ...PROCUREMENT_016_PAGE_EVIDENCE, reason: '未注入真实页面与截图依赖' }
  }
  const invoiceId = stableId(invoice?.invoiceId ?? invoice?.id ?? invoice?.created?.id)
  const invoiceNo = String(invoice?.invoiceNo ?? invoice?.created?.invoiceNo ?? '').trim()
  if (!invoiceId || !invoiceNo) {
    return { status: 'DEFERRED', ...PROCUREMENT_016_PAGE_EVIDENCE, reason: '未注入专属发票稳定 ID 与发票号' }
  }
  const renderStartedAt = Date.now()
  try {
    await openRoute(page, PROCUREMENT_016_PAGE_EVIDENCE.route, { readyText: '采购发票' })
    const invoiceInput = page.getByPlaceholder('请输入发票号').first()
    const searchButton = page.getByRole('button', { name: '搜索', exact: true }).first()
    const listResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/erp/purchase-invoice/page') &&
        url.searchParams.get('invoiceNo') === invoiceNo
    })
    await invoiceInput.fill(invoiceNo)
    const [response] = await Promise.all([listResponse, searchButton.click()])
    const listPayload = await readBrowserBusinessResponse(response)
    const list = pageRows(listPayload, 'PROC-016 专属发票页面分页')
    const row = findUniqueProcurement016Invoice(list, invoice)
    if (!row) throw new Error('专属发票号/ID未在唯一分页行中命中')

    const tableRow = page.locator('.vxe-table--main-wrapper .vxe-body--row').filter({ hasText: invoiceNo })
    await tableRow.first().waitFor({ state: 'visible', timeout: 30000 })
    if (await tableRow.count() !== 1) throw new Error('专属发票未定位到唯一页面行')
    let actionRow = tableRow
    let detailButton = actionRow.getByRole('button', { name: '详情', exact: true }).first()
    let reviewButton = actionRow.getByRole('button', { name: /^(审核|提审)$/ }).first()
    if (await detailButton.count() !== 1 || await reviewButton.count() !== 1) {
      // VXE renders fixed-right operation cells in a separate table. Keep the
      // invoice identity from the main table, then align the operation row by
      // row index when the fixed table does not repeat invoice text.
      const mainRowIndex = typeof tableRow.first().evaluate === 'function'
        ? await tableRow.first().evaluate((row) =>
          row.parentElement ? Array.from(row.parentElement.children).indexOf(row) : -1)
        : -1
      const fixedRows = page.locator('.vxe-table--fixed-right-wrapper .vxe-body--row')
      const indexedRow = typeof fixedRows.nth === 'function'
        ? (mainRowIndex >= 0 ? fixedRows.nth(mainRowIndex) : fixedRows.filter({ hasText: invoiceNo }).first())
        : null
      if (indexedRow && await indexedRow.count() === 1) actionRow = indexedRow
      detailButton = actionRow.getByRole('button', { name: '详情', exact: true }).first()
      reviewButton = actionRow.getByRole('button', { name: /^(审核|提审)$/ }).first()
    }
    if (await detailButton.count() !== 1 || await reviewButton.count() !== 1) {
      throw new Error('专属发票页面行缺少详情或审核/提审复核入口')
    }
    const reviewEntry = await reviewButton.innerText()
    // The current invoice page opens the detail dialog from the verified list
    // row and only loads the history panel afterward; it does not issue a
    // second purchase-invoice page request with an id query parameter.
    assertProcurement016InvoiceDetail(row, invoice, 'PROC-016 专属发票页面行')
    await detailButton.click()
    const dialog = page.locator('.el-dialog:visible').last()
    await dialog.waitFor({ state: 'visible', timeout: 30000 })
    const detailBody = await dialog.innerText()
    let invoiceNoInputVisible = false
    if (typeof dialog.locator === 'function') {
      const inputs = dialog.locator('input')
      if (inputs && typeof inputs.count === 'function' && typeof inputs.nth === 'function') {
        for (let index = 0; index < await inputs.count(); index++) {
          const value = await inputs.nth(index).inputValue().catch(() => '')
          if (value === invoiceNo) {
            invoiceNoInputVisible = true
            break
          }
        }
      }
    }
    if (!detailBody.includes(invoiceNo) && !invoiceNoInputVisible) {
      throw new Error('专属发票详情弹窗未显示目标发票号')
    }
    await saveScreenshot(page, outputDir, PROCUREMENT_016_PAGE_EVIDENCE.screenshotName, record)
    const body = await page.locator('body').innerText()
    const requiredTextPresent = PROCUREMENT_016_PAGE_EVIDENCE.requiredText.every((text) => body.includes(text))
    const requiredControlPresent = true
    return {
      status: requiredTextPresent && requiredControlPresent ? 'VERIFIED' : 'GAP',
      route: PROCUREMENT_016_PAGE_EVIDENCE.route,
      renderMs: Date.now() - renderStartedAt,
      requiredTextPresent,
      requiredControlPresent,
      uniqueInvoiceId: invoiceId,
      uniqueInvoiceNo: invoiceNo,
      detailFields: PROCUREMENT_016_PAGE_EVIDENCE.fields,
      reviewEntry,
      screenshotName: PROCUREMENT_016_PAGE_EVIDENCE.screenshotName
    }
  } catch (error) {
    return {
      status: 'GAP',
      route: PROCUREMENT_016_PAGE_EVIDENCE.route,
      renderMs: Date.now() - renderStartedAt,
      reason: error?.message || String(error),
      uniqueInvoiceId: invoiceId,
      uniqueInvoiceNo: invoiceNo
    }
  }
}

export async function createProcurement016OpeningClosureFixture (api, caseRecord = {}, options = {}) {
  if (!api || typeof api.getBusiness !== 'function' || typeof api.postBusiness !== 'function' ||
      typeof api.putBusiness !== 'function' || typeof api.put !== 'function') {
    throw new TypeError('PROC-016 fixture 需要完整的正式 API client')
  }
  const tag = options.tag || tagOf()
  const fixture = addFixture(caseRecord, {
    kind: 'procurement-016-opening-closure',
    tag,
    status: 'creating',
    retained: true,
    cleanupPlan: [],
    resources: [],
    acceptanceGaps: PROCUREMENT_016_ACCEPTANCE_GAPS
  })
  const supplierId = await createSupplier(api, fixture, tag)
  const accountId = await createAccount(api, fixture, tag)
  const { unitId, material, warehouse, stockBaseline } = await createDedicatedResources(api, fixture, tag)
  fixture.dependencies = [
    { kind: 'unit', id: unitId, ownership: 'shared-readonly-dependency', action: 'do-not-touch' },
    { kind: 'supplier', id: supplierId, ownership: 'dedicated-formal-api', action: 'retain-or-formal-deactivate-only' },
    { kind: 'account', id: accountId, ownership: 'dedicated-formal-api', action: 'retain-or-formal-deactivate-only' }
  ]
  const context = { tag, supplierId, material, warehouse, warehouseId: warehouse.id, accountId, stockBaseline }
  const historical = await runHistoricalOrderPayableScenario(api, fixture, {
    ...context,
    suffix: 'HISTORICAL'
  })
  const absent = await runNoHistoricalPayableScenario(api, fixture, {
    ...context,
    suffix: 'ABSENT'
  })
  const opening = await runOpeningInvoiceScenario(api, fixture, context)
  const pageEvidence = await captureProcurement016PageEvidence({
    ...(options.pageEvidence || {}),
    invoice: options.pageEvidence?.invoice || historical.invoice
  })
  fixture.status = 'verified'
  fixture.pageEvidence = pageEvidence
  fixture.cleanup = '已审核订单、应付、发票和期初入库只保留正式 ID；仅草稿且后端正式允许时删除，供应商/账户没有正式安全删除接口则停用或保留'
  addEvidence(caseRecord,
    `PROC-016 专属 fixture ${tag}：历史应付拒绝、无历史生成 PurInvoice 应付、期初来源跳过历史检查；` +
    `页面证据=${pageEvidence.status}；清理仅登记本轮 ID，不使用 SQL`)
  return {
    tag,
    fixture,
    historical,
    absent,
    opening,
    pageEvidence,
    acceptanceGaps: PROCUREMENT_016_ACCEPTANCE_GAPS,
    remaining: [
      ...(pageEvidence.status === 'VERIFIED' ? [] : ['需要主控注入 headed 页面执行并保留截图']),
      'Java 定向单测与后端部署不在本轮修改/验证范围'
    ]
  }
}

export const procurement016TestHooks = Object.freeze({
  runHistoricalOrderPayableScenario,
  runNoHistoricalPayableScenario,
  runOpeningInvoiceScenario,
  requirePageRows,
  assertInvoiceSourceFields,
  stableId,
  findUniqueProcurement016Invoice,
  assertProcurement016InvoiceDetail,
  assertProcurement016ApprovedTransition,
  ensureProcurement016PurchaseOrderSubmitted,
  createHistoricalPayable,
  createDedicatedResources,
  readDedicatedStockBaseline
})
