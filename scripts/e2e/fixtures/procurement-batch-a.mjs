import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertProcurementDirectCreateGate } from './procurement-direct-create-gate.mjs'

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const localDateTime = () => new Date().toISOString().slice(0, 19)
const localDate = () => localDateTime().slice(0, 10)
const tagOf = (caseId) =>
  `${caseId.replace(/[^A-Z0-9]/g, '')}_${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`

const addFixture = (caseRecord, fixture) => {
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  return fixture
}

export const procurementBatchContracts = Object.freeze({
  financeRuleDuplicate: Object.freeze({
    code: 1_030_102_021,
    message: /已存在启用中的财务规则/
  }),
  documentTypeReferenced: Object.freeze({
    code: 1_002_029_003,
    message: /已被业务引用，不能删除，只能停用/
  }),
  purchaseRuleTypeInvalid: Object.freeze({
    code: 1_030_102_014,
    message: /采购订单单据类型不存在或未启用/
  }),
  openingInvoiceLimit: Object.freeze({
    code: 1_020_205_004,
    message: /开票金额.*超过期初采购入库剩余可开票金额/
  }),
  openingInvoicePendingDuplicate: Object.freeze({
    code: -645,
    message: /存在未审核完成的发票.*审核完再提交/,
    allowServiceCode: true
  }),
  financeManualCreateForbidden: Object.freeze({
    code: 500,
    message: /不允许手工创建单据/,
    allowServiceCode: true
  }),
  financeRequiredFieldMissing: Object.freeze({
    code: 500,
    message: /缺少必填字段.*(?:bankAccountId|settleMethod)/,
    allowServiceCode: true
  })
})

const canonicalSnapshot = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item)

export const matchesExactProcurementRejection = (response, contract) =>
  matchesExpectedBusinessRejection(response, contract) && response?.data === null

const assertExactRejection = (response, contract, label) => {
  if (!matchesExactProcurementRejection(response, contract)) {
    throw new Error(`${label}不是精确领域拒绝：${JSON.stringify({
      code: response?.code,
      message: response?.msg || response?.message,
      data: response?.data
    })}`)
  }
  return response
}

const assertSnapshotUnchanged = (before, after, label) => {
  if (canonicalSnapshot(before) !== canonicalSnapshot(after)) {
    throw new Error(`${label}前后专属快照发生变化：before=${canonicalSnapshot(before)} after=${canonicalSnapshot(after)}`)
  }
}

const assertStableId = (value, label) => {
  if (!stableId(value)) throw new Error(`${label}未返回稳定 ID：${value}`)
  return String(value)
}

const readRule = async (api, base, id, label) =>
  dataOf(await api.getBusiness(`${base}/get?id=${encodeURIComponent(id)}`), label)

const readDocumentType = async (api, id, label) =>
  dataOf(await api.getBusiness(
    `/system/document/type/get?id=${encodeURIComponent(id)}`
  ), label)

async function createDocumentType (api, code, name, caseRecord, fixture, field) {
  const id = assertStableId(dataOf(await api.postBusiness('/system/document/type/create', {
    code,
    name,
    isOpen: true,
    sort: 995
  }), `${field}单据类型创建`), `${field}单据类型`)
  fixture[field] = id
  caseRecord.evidence.push(`${field} retained documentTypeId=${id}, code=${code}`)
  return id
}

async function createSupplier (api, caseRecord, fixture, {
  name,
  field = 'supplierId',
  customerEnabled = false,
  carrierEnabled = false
}) {
  const id = assertStableId(dataOf(await api.postBusiness('/base/partner/create', {
    name,
    shortName: name.slice(0, 12),
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled,
    supplierEnabled: true,
    carrierEnabled,
    remark: name
  }), `${field}专属客商`), `${field}专属客商`)
  fixture[field] = id
  caseRecord.evidence.push(`${field} retained partnerId=${id}, name=${name}`)
  return id
}

async function pickMaterial (api, query, label) {
  const page = dataOf(await api.getBusiness(
    `/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&${query}`
  ), label)
  const rows = Array.isArray(page?.records) ? page.records : []
  const material = rows.find((row) => stableId(row?.id) && stableId(row?.unitId))
  if (!material) throw new Error(`BLOCKED: ${label}没有可用物料/单位`)
  return material
}

async function createPurchaseOrder (api, fixture, {
  supplierId,
  material,
  documentTypeId,
  tag,
  code
}) {
  const orderTime = localDateTime()
  const orderId = assertStableId(dataOf(await api.postBusiness('/erp/purchase-order/create', {
    type: 0,
    supplierId: String(supplierId),
    orderTime,
    billDate: orderTime.slice(0, 10),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 1,
    totalProductPrice: 10,
    totalTaxPrice: 0,
    totalPrice: 10,
    settleMethodCode: code,
    documentTypeId: documentTypeId ? String(documentTypeId) : undefined,
    directCreate: 1,
    directCreateReason: `${tag} isolated order`,
    remark: `${tag} isolated order`,
    items: [{
      entryNo: 1,
      productId: String(material.id),
      productUnitId: String(material.unitId),
      productPrice: 10,
      count: 1,
      taxPercent: 0,
      totalPrice: 10,
      taxPrice: 0,
      remark: `${tag} isolated line`
    }]
  }), `${tag} 专属采购订单`), `${tag} 专属采购订单`)
  const detail = dataOf(await api.getBusiness(
    `/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`
  ), `${tag} 采购订单详情`)
  return { orderId, orderTime, detail }
}

/**
 * PROC-007: isolated FIN document type + rule contract, including duplicate
 * enabled rule and referenced type deletion protection.
 */
export async function createFinanceRuleWriteFixture (api, caseRecord) {
  const tag = tagOf('PROC007')
  const fixture = addFixture(caseRecord, {
    kind: 'procurement-finance-type-rule',
    tag,
    status: 'creating',
    retained: true,
    reason: '规则删除后清理专属单据类型；若系统保护拒绝删除则保留停用引用证据'
  })
  const documentTypeCode = `FIN_E2E_${tag.slice(-16)}`
  const documentTypeId = await createDocumentType(
    api, documentTypeCode, `E2E财务${tag.slice(-10)}`, caseRecord, fixture, 'documentTypeId')

  const createPayload = {
    documentTypeId,
    applicableOrgIds: null,
    defaultApproval: true,
    approvalProcessKey: 'erp-receipt-approval',
    voucherEventType: 'RECEIPT',
    printTemplate: 'E2E_PRINT',
    billNoRule: 'E2E_BILL_NO',
    allowManualCreate: false,
    requiredFields: 'bankAccountId,settleMethod',
    status: 1,
    remark: `PROC-007 isolated finance rule ${tag}`
  }
  const ruleId = assertStableId(dataOf(await api.postBusiness(
    '/erp/finance-document-type-rule/create', createPayload
  ), 'PROC-007 财务规则创建'), 'PROC-007 财务规则')
  fixture.ruleId = ruleId
  caseRecord.evidence.push(`PROC-007 retained ruleId=${ruleId}`)

  const created = await readRule(api, '/erp/finance-document-type-rule', ruleId,
    'PROC-007 财务规则创建详情')
  if (String(created?.documentTypeId) !== documentTypeId ||
      created?.documentTypeCode !== documentTypeCode ||
      created.defaultApproval !== true ||
      created.allowManualCreate !== false ||
      created.requiredFields !== createPayload.requiredFields ||
      created.approvalProcessKey !== createPayload.approvalProcessKey) {
    throw new Error('PROC-007 财务规则创建回读与提交值不一致')
  }

  const duplicateBefore = {
    rule: await readRule(api, '/erp/finance-document-type-rule', ruleId,
      'PROC-007 重复规则拒绝前规则快照'),
    documentType: await readDocumentType(api, documentTypeId,
      'PROC-007 重复规则拒绝前单据类型快照')
  }
  const duplicate = assertExactRejection(await api.post(
    '/erp/finance-document-type-rule/create', createPayload, {
      expectedBusinessRejection: procurementBatchContracts.financeRuleDuplicate
    }), procurementBatchContracts.financeRuleDuplicate, 'PROC-007 重复启用规则')
  const duplicateAfter = {
    rule: await readRule(api, '/erp/finance-document-type-rule', ruleId,
      'PROC-007 重复规则拒绝后规则快照'),
    documentType: await readDocumentType(api, documentTypeId,
      'PROC-007 重复规则拒绝后单据类型快照')
  }
  assertSnapshotUnchanged(duplicateBefore, duplicateAfter,
    'PROC-007 重复启用规则拒绝')

  const deleteTypeBefore = {
    rule: await readRule(api, '/erp/finance-document-type-rule', ruleId,
      'PROC-007 类型删除拒绝前规则快照'),
    documentType: await readDocumentType(api, documentTypeId,
      'PROC-007 类型删除拒绝前单据类型快照')
  }
  const deleteTypeRejected = assertExactRejection(await api.delete(
    `/system/document/type/delete?id=${encodeURIComponent(documentTypeId)}`,
    { expectedBusinessRejection: procurementBatchContracts.documentTypeReferenced }
  ), procurementBatchContracts.documentTypeReferenced, 'PROC-007 被规则引用的单据类型删除')
  const deleteTypeAfter = {
    rule: await readRule(api, '/erp/finance-document-type-rule', ruleId,
      'PROC-007 类型删除拒绝后规则快照'),
    documentType: await readDocumentType(api, documentTypeId,
      'PROC-007 类型删除拒绝后单据类型快照')
  }
  assertSnapshotUnchanged(deleteTypeBefore, deleteTypeAfter,
    'PROC-007 被规则引用的单据类型删除拒绝')

  const receiptProbeBody = (overrides = {}) => ({
    billNo: `E2E-FIN-${tag}`,
    billDate: localDate(),
    receiptType: '101',
    documentTypeId,
    customerId: '1',
    amt: 1,
    discountAmt: 0,
    settleMethod: '1',
    bankAccountId: '1',
    collectionItem: '1',
    isAuto: 0,
    remark: `PROC-007 runtime guard probe ${tag}`,
    finReceiptEntryList: [{
      entryNo: 1,
      amt: 1,
      settleMethod: '1',
      bankAccountId: '1',
      collectionItem: '1',
      remark: `PROC-007 runtime guard entry ${tag}`
    }],
    ...overrides
  })

  const manualCreateBefore = await readRule(api, '/erp/finance-document-type-rule', ruleId,
    'PROC-007 手工创建拒绝前规则快照')
  const manualCreateRejected = assertExactRejection(await api.post(
    '/finance/finReceipt/add/save',
    receiptProbeBody(),
    {
      expectedBusinessRejection: procurementBatchContracts.financeManualCreateForbidden
    }
  ), procurementBatchContracts.financeManualCreateForbidden,
  'PROC-007 allowManualCreate=false 手工保存')
  const manualCreateAfter = await readRule(api, '/erp/finance-document-type-rule', ruleId,
    'PROC-007 手工创建拒绝后规则快照')
  assertSnapshotUnchanged(manualCreateBefore, manualCreateAfter,
    'PROC-007 allowManualCreate=false 手工保存拒绝')

  dataOf(await api.putBusiness('/erp/finance-document-type-rule/update', {
    ...createPayload,
    id: ruleId,
    allowManualCreate: true,
    remark: `${createPayload.remark} required-field probe`
  }), 'PROC-007 财务规则必填字段探针准备')
  const requiredFieldBefore = await readRule(api, '/erp/finance-document-type-rule', ruleId,
    'PROC-007 必填字段拒绝前规则快照')
  const requiredFieldRejected = assertExactRejection(await api.post(
    '/finance/finReceipt/add/save',
    receiptProbeBody({ bankAccountId: null, settleMethod: '' }),
    {
      expectedBusinessRejection: procurementBatchContracts.financeRequiredFieldMissing
    }
  ), procurementBatchContracts.financeRequiredFieldMissing,
  'PROC-007 requiredFields 手工保存')
  const requiredFieldAfter = await readRule(api, '/erp/finance-document-type-rule', ruleId,
    'PROC-007 必填字段拒绝后规则快照')
  assertSnapshotUnchanged(requiredFieldBefore, requiredFieldAfter,
    'PROC-007 requiredFields 手工保存拒绝')

  dataOf(await api.putBusiness('/erp/finance-document-type-rule/update', {
    ...createPayload,
    id: ruleId,
    allowManualCreate: true,
    requiredFields: null,
    defaultApproval: true,
    approvalProcessKey: 'erp-receipt-approval',
    remark: `${createPayload.remark} default approval probe`
  }), 'PROC-007 财务规则默认审批探针准备')
  let defaultApprovalProbe
  try {
    const billId = assertStableId(dataOf(await api.postBusiness(
      '/finance/finReceipt/add/submit', receiptProbeBody({ isAuto: 1 })
    ), 'PROC-007 默认审批收款单提交'), 'PROC-007 默认审批收款单')
    const detail = dataOf(await api.getBusiness(
      `/finance/finReceipt/queryById?id=${encodeURIComponent(billId)}`
    ), 'PROC-007 默认审批收款单详情')
    defaultApprovalProbe = {
      billId,
      detail,
      effective: Number(detail?.isEffective) === 1,
      message: ''
    }
    fixture.defaultApprovalBillId = billId
    fixture.cleanup = 'default-approval-bill-retained'
  } catch (error) {
    defaultApprovalProbe = {
      billId: null,
      detail: null,
      effective: true,
      message: String(error.message || error).slice(0, 500)
    }
    caseRecord.notes.push(
      `PROC-007 默认审批运行时探针未完成：${defaultApprovalProbe.message}`
    )
  }

  const updatePayload = {
    ...createPayload,
    id: ruleId,
    defaultApproval: false,
    approvalProcessKey: null,
    allowManualCreate: true,
    requiredFields: null,
    status: 0,
    remark: `${createPayload.remark} disabled`
  }
  dataOf(await api.putBusiness('/erp/finance-document-type-rule/update', updatePayload),
    'PROC-007 财务规则停用')
  const updated = await readRule(api, '/erp/finance-document-type-rule', ruleId,
    'PROC-007 财务规则停用详情')
  if (updated.defaultApproval !== false || updated.allowManualCreate !== true ||
      updated.requiredFields != null || updated.approvalProcessKey != null ||
      Number(updated.status) !== 0) {
    throw new Error('PROC-007 财务规则停用策略回读不一致')
  }

  dataOf(await api.deleteBusiness(
    `/erp/finance-document-type-rule/delete?id=${encodeURIComponent(ruleId)}`
  ), 'PROC-007 财务规则清理')
  fixture.cleanup = 'rule-deleted'
  const cleanupTypeDelete = await api.delete(
    `/system/document/type/delete?id=${encodeURIComponent(documentTypeId)}`,
    { expectedBusinessRejection: procurementBatchContracts.documentTypeReferenced }
  )
  if (cleanupTypeDelete?.code === 0) {
    fixture.cleanup = 'rule-and-type-deleted'
  } else {
    assertExactRejection(
      cleanupTypeDelete, procurementBatchContracts.documentTypeReferenced,
      'PROC-007 财务单据类型清理'
    )
    fixture.cleanup = 'rule-deleted-type-retained'
    caseRecord.notes.push(
      `PROC-007 规则已删除，单据类型 ${documentTypeId} 保留：${cleanupTypeDelete.msg || cleanupTypeDelete.message}`
    )
  }
  fixture.status = 'verified'
  return {
    tag,
    documentTypeCode,
    documentTypeId,
    ruleId,
    createPayload,
    created,
    duplicate,
    duplicateBefore,
    duplicateAfter,
    deleteTypeRejected,
    deleteTypeBefore,
    deleteTypeAfter,
    manualCreateProbe: {
      rejected: true,
      code: manualCreateRejected.code,
      message: manualCreateRejected.msg || manualCreateRejected.message || ''
    },
    manualCreateBefore,
    manualCreateAfter,
    requiredFieldProbe: {
      rejected: true,
      code: requiredFieldRejected.code,
      message: requiredFieldRejected.msg || requiredFieldRejected.message || ''
    },
    requiredFieldBefore,
    requiredFieldAfter,
    defaultApprovalProbe,
    updated,
    fixture
  }
}

/**
 * PROC-008: isolated PURCHASE document type/rule snapshot and deletion guard.
 */
export async function createPurchaseTypeRuleWriteFixture (api, caseRecord) {
  const tag = tagOf('PROC008')
  await assertProcurementDirectCreateGate(api, 'PROC-008')
  const fixture = addFixture(caseRecord, {
    kind: 'procurement-purchase-type-rule',
    tag,
    status: 'creating',
    retained: true,
    reason: '采购订单引用后单据类型只停用不删除'
  })
  const documentTypeCode = `PURCHASE_E2E_${tag.slice(-14)}`
  const documentTypeId = await createDocumentType(
    api, documentTypeCode, `E2E采购${tag.slice(-10)}`, caseRecord, fixture, 'documentTypeId')
  const negativeDocumentTypeId = await createDocumentType(
    api, `FIN_E2E_NEG_${tag.slice(-12)}`, `E2E负向${tag.slice(-10)}`,
    caseRecord, fixture, 'negativeDocumentTypeId')
  const createPayload = {
    documentTypeId,
    orgId: null,
    approvalProcessKey: `e2e-purchase-${tag}`,
    statisticsBasis: 'PURCHASE',
    displayTemplate: 'E2E_DISPLAY',
    printTemplate: 'E2E_PRINT',
    effectiveFrom: localDate(),
    effectiveTo: null,
    status: 1,
    remark: `PROC-008 isolated purchase rule ${tag}`
  }
  const ruleId = assertStableId(dataOf(await api.postBusiness(
    '/erp/purchase-type-rule/create', createPayload
  ), 'PROC-008 采购类型规则创建'), 'PROC-008 采购类型规则')
  fixture.ruleId = ruleId
  caseRecord.evidence.push(`PROC-008 retained ruleId=${ruleId}`)
  const created = await readRule(api, '/erp/purchase-type-rule', ruleId,
    'PROC-008 采购类型规则详情')
  if (String(created?.documentTypeId) !== documentTypeId ||
      created.documentTypeCode !== documentTypeCode ||
      Number(created.version) !== 1) {
    throw new Error('PROC-008 采购类型规则创建快照不一致')
  }

  const nonPurchaseBefore = await readDocumentType(api, negativeDocumentTypeId,
    'PROC-008 非采购类型拒绝前单据类型快照')
  const nonPurchaseRejected = assertExactRejection(await api.post(
    '/erp/purchase-type-rule/create', {
    ...createPayload,
    documentTypeId: negativeDocumentTypeId
  }, {
    expectedBusinessRejection: procurementBatchContracts.purchaseRuleTypeInvalid
  }), procurementBatchContracts.purchaseRuleTypeInvalid, 'PROC-008 非采购类型创建规则')
  const nonPurchaseAfter = await readDocumentType(api, negativeDocumentTypeId,
    'PROC-008 非采购类型拒绝后单据类型快照')
  assertSnapshotUnchanged(nonPurchaseBefore, nonPurchaseAfter,
    'PROC-008 非采购类型创建规则拒绝')

  const material = await pickMaterial(api, 'purchased=Y&isEnabled=1', 'PROC-008 可采购物料')
  const supplierId = await createSupplier(api, caseRecord, fixture, {
    name: `E2E-PROC008-SUPPLIER-${tag}`
  })
  const order = await createPurchaseOrder(api, fixture, {
    supplierId,
    material,
    documentTypeId,
    tag,
    code: null
  })
  fixture.orderId = order.orderId
  if (String(order.detail?.documentTypeId) !== documentTypeId ||
      order.detail?.documentTypeCode !== documentTypeCode ||
      Number(order.detail?.documentTypeRuleVersion) !== 1) {
    throw new Error(
      `PROC-008 采购订单未保存类型/版本快照：id=${order.detail?.documentTypeId}, ` +
      `code=${order.detail?.documentTypeCode}, version=${order.detail?.documentTypeRuleVersion}`
    )
  }

  dataOf(await api.putBusiness('/erp/purchase-type-rule/update', {
    ...createPayload,
    id: ruleId,
    remark: `${createPayload.remark} v2`
  }), 'PROC-008 采购类型规则更新')
  const updated = await readRule(api, '/erp/purchase-type-rule', ruleId,
    'PROC-008 采购类型规则版本2')
  if (Number(updated.version) !== 2) throw new Error('PROC-008 规则版本未自增到2')

  const deleteTypeBefore = {
    rule: await readRule(api, '/erp/purchase-type-rule', ruleId,
      'PROC-008 类型删除拒绝前规则快照'),
    documentType: await readDocumentType(api, documentTypeId,
      'PROC-008 类型删除拒绝前单据类型快照'),
    order: await api.getBusiness(
      `/erp/purchase-order/get?id=${encodeURIComponent(order.orderId)}`
    ).then((payload) => payload.data)
  }
  const deleteTypeRejected = assertExactRejection(await api.delete(
    `/system/document/type/delete?id=${encodeURIComponent(documentTypeId)}`,
    { expectedBusinessRejection: procurementBatchContracts.documentTypeReferenced }
  ), procurementBatchContracts.documentTypeReferenced, 'PROC-008 被采购订单引用的单据类型删除')
  const deleteTypeAfter = {
    rule: await readRule(api, '/erp/purchase-type-rule', ruleId,
      'PROC-008 类型删除拒绝后规则快照'),
    documentType: await readDocumentType(api, documentTypeId,
      'PROC-008 类型删除拒绝后单据类型快照'),
    order: await api.getBusiness(
      `/erp/purchase-order/get?id=${encodeURIComponent(order.orderId)}`
    ).then((payload) => payload.data)
  }
  assertSnapshotUnchanged(deleteTypeBefore, deleteTypeAfter,
    'PROC-008 被采购订单引用的单据类型删除拒绝')

  dataOf(await api.putBusiness('/erp/purchase-type-rule/update', {
    ...createPayload,
    id: ruleId,
    status: 0,
    remark: `${createPayload.remark} disabled v3`
  }), 'PROC-008 采购类型规则停用')
  const disabled = await readRule(api, '/erp/purchase-type-rule', ruleId,
    'PROC-008 采购类型规则停用详情')
  if (Number(disabled.status) !== 0 || Number(disabled.version) !== 3) {
    throw new Error('PROC-008 规则停用或版本3回读不一致')
  }
  fixture.cleanup = 'rule-disabled-type-order-retained'
  fixture.status = 'verified'
  return {
    tag,
    documentTypeId,
    documentTypeCode,
    negativeDocumentTypeId,
    ruleId,
    createPayload,
    created,
    nonPurchaseRejected,
    nonPurchaseBefore,
    nonPurchaseAfter,
    order,
    updated,
    deleteTypeRejected,
    deleteTypeBefore,
    deleteTypeAfter,
    disabled,
    fixture
  }
}

async function inventoryQty (api, materialId, warehouseId) {
  const page = dataOf(await api.getBusiness(
    `/mes/stkInventory/list?pageNo=1&pageSize=100&materialId=${encodeURIComponent(materialId)}` +
    `&warehouseId=${encodeURIComponent(warehouseId)}`
  ), 'WMS 库存回读')
  const rows = Array.isArray(page?.records) ? page.records : Array.isArray(page?.list) ? page.list : []
  return rows.reduce((sum, row) => sum + Number(row?.qty || 0), 0)
}

/**
 * PROC-011: approved OPENING purchase-in, invoice quantity/amount controls,
 * approval write-back and WMS non-posting evidence.
 */
export async function createOpeningInvoiceWriteFixture (api, caseRecord) {
  const tag = tagOf('PROC011')
  const fixture = addFixture(caseRecord, {
    kind: 'procurement-opening-invoice',
    tag,
    status: 'creating',
    retained: true,
    reason: '已审核期初开票事实保留，避免直接删除财务与库存证据'
  })
  const supplierId = await createSupplier(api, caseRecord, fixture, {
    name: `E2E-PROC011-SUPPLIER-${tag}`
  })
  const material = await pickMaterial(api, 'purchased=Y&isEnabled=1', 'PROC-011 可采购物料')
  const warehousePage = dataOf(await api.getBusiness('/mes/wmsWareHouse/allTree'), 'PROC-011 仓库树')
  const warehouses = Array.isArray(warehousePage) ? warehousePage : warehousePage?.list || []
  const warehouse = warehouses.find((row) => stableId(row?.id))
  if (!warehouse) throw new Error('BLOCKED: PROC-011 没有可用仓库')
  const accountId = assertStableId(dataOf(await api.postBusiness('/erp/account/create', {
    name: `E2E-PROC011-${tag}`,
    no: `E2E-PROC011-${tag}`,
    accountType: 'BANK',
    currency: 'CNY',
    status: 0,
    sort: 999,
    remark: `PROC-011 isolated account ${tag}`
  }), 'PROC-011 专属结算账户创建'), 'PROC-011 专属结算账户')
  fixture.accountId = accountId
  const beforeInventory = await inventoryQty(api, String(material.id), String(warehouse.id))
  const body = {
    accountId,
    inTime: localDateTime(),
    businessType: 'OPENING',
    openingBaselineDate: localDate(),
    supplierId: String(supplierId),
    orderId: null,
    discountPercent: 0,
    otherPrice: 0,
    remark: `PROC-011 opening fixture ${tag}`,
    items: [{
      orderItemId: null,
      warehouseId: String(warehouse.id),
      productId: String(material.id),
      productUnitId: String(material.unitId),
      productPrice: 10,
      count: 6,
      taxPercent: 0,
      remark: `PROC-011 opening line ${tag}`
    }]
  }
  const purchaseInId = assertStableId(dataOf(await api.postBusiness(
    '/erp/purchase-in/create', body
  ), 'PROC-011 期初采购入库创建'), 'PROC-011 期初采购入库')
  fixture.purchaseInId = purchaseInId
  dataOf(await api.putBusiness(
    `/erp/purchase-in/update-status?id=${encodeURIComponent(purchaseInId)}&status=20`
  ), 'PROC-011 期初采购入库审核')
  const opening = dataOf(await api.getBusiness(
    `/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`
  ), 'PROC-011 期初采购入库详情')
  if (String(opening?.businessType).toUpperCase() !== 'OPENING' ||
      Number(opening?.status) !== 20 ||
      Number(opening?.totalCount) !== 6 ||
      Number(opening?.totalPrice) !== 60) {
    throw new Error('PROC-011 期初采购入库审核或数量金额回读不一致')
  }

  const invoiceItem = (count, money) => ({
    purchaseInId,
    srcBillType: 'OPENING_PURCHASE_IN',
    invoiceCountItem: count,
    invoiceMoneyItem: money
  })
  const overflowCountBefore = await api.getBusiness(
    `/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`
  ).then((payload) => payload.data)
  const overflowCount = assertExactRejection(await api.post('/erp/purchase-invoice/create', {
    supplierId,
    invoiceMoney: 70,
    invoicePrice: 10,
    invoiceType: 1,
    status: 0,
    items: [invoiceItem(7, 70)]
  }, {
    expectedBusinessRejection: procurementBatchContracts.openingInvoiceLimit
  }), procurementBatchContracts.openingInvoiceLimit, 'PROC-011 超数量开票')
  const overflowCountAfter = await api.getBusiness(
    `/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`
  ).then((payload) => payload.data)
  assertSnapshotUnchanged(overflowCountBefore, overflowCountAfter,
    'PROC-011 超数量开票拒绝')

  const overflowMoneyBefore = overflowCountAfter
  const overflowMoney = assertExactRejection(await api.post('/erp/purchase-invoice/create', {
    supplierId,
    invoiceMoney: 61,
    invoicePrice: 10,
    invoiceType: 1,
    status: 0,
    items: [invoiceItem(6, 61)]
  }, {
    expectedBusinessRejection: procurementBatchContracts.openingInvoiceLimit
  }), procurementBatchContracts.openingInvoiceLimit, 'PROC-011 超金额开票')
  const overflowMoneyAfter = await api.getBusiness(
    `/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`
  ).then((payload) => payload.data)
  assertSnapshotUnchanged(overflowMoneyBefore, overflowMoneyAfter,
    'PROC-011 超金额开票拒绝')

  const invoiceId = assertStableId(dataOf(await api.postBusiness('/erp/purchase-invoice/create', {
    supplierId,
    invoiceMoney: 60,
    invoicePrice: 10,
    invoiceType: 1,
    status: 0,
    items: [invoiceItem(6, 60)]
  }), 'PROC-011 采购发票创建'), 'PROC-011 采购发票')
  fixture.invoiceId = invoiceId
  const pendingDuplicateBefore = {
    opening: await api.getBusiness(
      `/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`
    ).then((payload) => payload.data),
    invoice: await api.getBusiness(
      `/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`
    ).then((payload) => payload.data)
  }
  const pendingDuplicate = assertExactRejection(await api.post('/erp/purchase-invoice/create', {
    supplierId,
    invoiceMoney: 1,
    invoicePrice: 10,
    invoiceType: 1,
    status: 0,
    items: [invoiceItem(1, 1)]
  }, {
    expectedBusinessRejection: procurementBatchContracts.openingInvoicePendingDuplicate
  }), procurementBatchContracts.openingInvoicePendingDuplicate,
  'PROC-011 同一期初来源未审发票重复登记')
  const pendingDuplicateAfter = {
    opening: await api.getBusiness(
      `/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`
    ).then((payload) => payload.data),
    invoice: await api.getBusiness(
      `/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`
    ).then((payload) => payload.data)
  }
  assertSnapshotUnchanged(pendingDuplicateBefore, pendingDuplicateAfter,
    'PROC-011 同一期初来源未审发票重复登记拒绝')

  dataOf(await api.putBusiness(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoiceId)}`
  ), 'PROC-011 采购发票复核')
  const invoice = dataOf(await api.getBusiness(
    `/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`
  ), 'PROC-011 采购发票详情')
  const openingAfter = dataOf(await api.getBusiness(
    `/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`
  ), 'PROC-011 开票回写详情')
  if (String(invoice?.srcBillType) !== 'OPENING_PURCHASE_IN' ||
      String(invoice?.srcBillId) !== purchaseInId ||
      !String(invoice?.details || '').includes(purchaseInId) ||
      Number(openingAfter?.invoicedCount) !== 6 ||
      Number(openingAfter?.invoicedPrice) !== 60) {
    throw new Error(
      `PROC-011 来源或开票回写不一致：src=${invoice?.srcBillType}/${invoice?.srcBillId}, ` +
      `count=${openingAfter?.invoicedCount}, price=${openingAfter?.invoicedPrice}`
    )
  }
  const afterInventory = await inventoryQty(api, String(material.id), String(warehouse.id))
  if (afterInventory !== beforeInventory) {
    throw new Error(`PROC-011 期初采购入库错误进入 WMS 库存：before=${beforeInventory}, after=${afterInventory}`)
  }
  fixture.status = 'verified'
  fixture.cleanup = 'approved-opening-invoice-retained'
  return {
    tag,
    supplierId,
    material,
    warehouseId: String(warehouse.id),
    purchaseInId,
    invoiceId,
    opening,
    openingAfter,
    invoice,
    overflowCount,
    overflowCountBefore,
    overflowCountAfter,
    overflowMoney,
    overflowMoneyBefore,
    overflowMoneyAfter,
    pendingDuplicate,
    pendingDuplicateBefore,
    pendingDuplicateAfter,
    beforeInventory,
    afterInventory,
    fixture
  }
}

/**
 * PROC-017: one-click request from a real sale-order source.
 */
export async function createPendingRequestFromSaleSourceFixture (api, caseRecord, {
  generateRequest
} = {}) {
  const tag = tagOf('PROC017')
  const fixture = addFixture(caseRecord, {
    kind: 'procurement-pending-request',
    tag,
    status: 'creating',
    retained: true,
    reason: '保留未审核请购和销售来源关联，避免破坏来源追溯审计'
  })
  const customerId = await createSupplier(api, caseRecord, fixture, {
    name: `E2E-PROC017-CUSTOMER-${tag}`,
    field: 'customerId',
    customerEnabled: true
  })
  const material = await pickMaterial(api, 'saled=Y&isEnabled=1', 'PROC-017 可销售物料')
  const orderTime = localDateTime()
  const saleOrderId = assertStableId(dataOf(await api.postBusiness('/erp/sale-order/create', {
    customerId: String(customerId),
    orderTime,
    billDate: orderTime.slice(0, 10),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 2,
    totalProductPrice: 20,
    totalTaxPrice: 0,
    totalPrice: 20,
    remark: `PROC-017 sale source ${tag}`,
    items: [{
      entryNo: 1,
      productId: String(material.id),
      productUnitId: String(material.unitId),
      productPrice: 10,
      count: 2,
      taxPercent: 0,
      totalPrice: 20,
      taxPrice: 0,
      remark: `PROC-017 sale source line ${tag}`
    }]
  }), 'PROC-017 销售订单来源'), 'PROC-017 销售订单来源')
  fixture.saleOrderId = saleOrderId
  const saleOrder = dataOf(await api.getBusiness(
    `/erp/sale-order/get?id=${encodeURIComponent(saleOrderId)}`
  ), 'PROC-017 销售订单详情')
  const billNo = `AUTOTEST-PROC-017-${tag}`
  const requestPayload = {
    billNo,
    no: billNo,
    billType: '18',
    srcBillType: 'SALE_ORDER',
    srcBillId: saleOrderId,
    srcNo: saleOrder?.billNo || null,
    type: 1,
    status: 0,
    orderTime,
    expectedOrderTime: orderTime,
    remark: `PROC-017 generated from sale order ${saleOrderId}`,
    itemsList: [{
      productId: String(material.id),
      productUnitId: String(material.unitId),
      inCount: 2,
      purchasedQuantity: 0,
      remark: `PROC-017 source line ${tag}`
    }]
  }
  const generated = generateRequest
    ? await generateRequest({ saleOrderId, saleOrder, material, fixture })
    : {
        response: await api.postBusiness('/erp/purchase/order/request/create', requestPayload),
        payload: requestPayload,
        viaBrowser: false
      }
  const requestId = assertStableId(dataOf(generated.response, 'PROC-017 一键生成请购'),
    'PROC-017 请购单')
  fixture.requestId = requestId
  fixture.generatedViaBrowser = generated.viaBrowser === true
  const request = dataOf(await api.getBusiness(
    `/erp/purchase/order/request/get?id=${encodeURIComponent(requestId)}`
  ), 'PROC-017 请购详情')
  if (String(request?.srcBillType) !== (generated.viaBrowser ? 'sale' : 'SALE_ORDER') ||
      String(request?.srcBillId) !== saleOrderId ||
      Number(request?.isEffective) !== 0 ||
      String(request?.billStage) !== '14' ||
      Number(request?.isClosed) !== 0 ||
      !Array.isArray(request?.itemsList) || request.itemsList.length !== 1 ||
      String(request.itemsList[0]?.productId) !== String(material.id) ||
      String(request.itemsList[0]?.productUnitId) !== String(material.unitId) ||
      Number(request.itemsList[0]?.inCount) !== 2) {
    throw new Error('PROC-017 生成请购未保留销售来源、未审核状态或数量')
  }
  fixture.status = 'verified'
  fixture.cleanup = 'request-and-sale-order-retained'
  return {
    tag,
    customerId,
    material,
    saleOrderId,
    saleOrder,
    requestId,
    requestPayload: generated.payload,
    request,
    fixture
  }
}

async function submitPurchaseOrder (api, orderId, caseRecord) {
  const before = dataOf(await api.getBusiness(
    `/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`
  ), 'PROC-019 采购订单审核前')
  if (Number(before?.status) !== 20) {
    dataOf(await api.putBusiness(
      `/erp/purchase-order/update-status?id=${encodeURIComponent(orderId)}&status=20`
    ), 'PROC-019 采购订单审核')
  }
  const order = dataOf(await api.getBusiness(
    `/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`
  ), 'PROC-019 采购订单详情')
  if (Number(order?.status) !== 20 || !Array.isArray(order?.items) || !order.items.length) {
    throw new Error('PROC-019 采购订单未审核或明细为空')
  }
  caseRecord.evidence.push(`PROC-019 采购订单 ${orderId} 已审核，明细=${order.items.length}`)
  return order
}

/**
 * PROC-019: isolated order -> ASN -> available lines -> reconciliation confirm.
 */
export async function createReconciliationWriteFixture (api, caseRecord) {
  const tag = tagOf('PROC019')
  const fixture = addFixture(caseRecord, {
    kind: 'procurement-reconciliation',
    tag,
    status: 'creating',
    retained: true,
    reason: '已确认对账是后续开票事实源，保留单号、来源行和确认版本'
  })
  const supplierId = await createSupplier(api, caseRecord, fixture, {
    name: `E2E-PROC019-SUPPLIER-${tag}`
  })
  const material = await pickMaterial(api, 'purchased=Y&isEnabled=1', 'PROC-019 可采购物料')
  const order = await createPurchaseOrder(api, fixture, {
    supplierId,
    material,
    tag,
    code: null
  })
  fixture.purchaseOrderId = order.orderId
  const approvedOrder = await submitPurchaseOrder(api, order.orderId, caseRecord)
  const orderItem = approvedOrder.items[0]
  const noticeCode = `AUTOTEST-PROC-019-${tag}-ASN`
  const asnPayload = {
    code: noticeCode,
    name: noticeCode,
    purchaseOrderId: order.orderId,
    purchaseOrderCode: approvedOrder.billNo,
    vendorId: String(supplierId),
    supplierShipmentKey: `${noticeCode}-SHIP`,
    supplierShipmentNo: `${noticeCode}-NO`,
    arrivalDate: localDateTime(),
    shippedAt: localDateTime(),
    remark: `PROC-019 isolated ASN ${tag}`,
    lines: [{
      itemId: String(material.id),
      purchaseOrderItemId: String(orderItem.id),
      unitId: String(material.unitId),
      arrivalQuantity: 2,
      iqcCheckFlag: false,
      batchNo: `${tag}-BATCH`,
      remark: `PROC-019 ASN line ${tag}`
    }]
  }
  const noticeId = assertStableId(dataOf(await api.postBusiness(
    '/mes/wms/arrival-notice/create', asnPayload
  ), 'PROC-019 ASN 创建'), 'PROC-019 ASN')
  fixture.noticeId = noticeId
  dataOf(await api.postBusiness(
    `/mes/wms/arrival-notice/submit?id=${encodeURIComponent(noticeId)}`
  ), 'PROC-019 ASN 提交')
  const notice = dataOf(await api.getBusiness(
    `/mes/wms/arrival-notice/get?id=${encodeURIComponent(noticeId)}`
  ), 'PROC-019 ASN 详情')
  if (Number(notice?.status) === 0 || !Array.isArray(notice?.lines) || notice.lines.length !== 1) {
    throw new Error('PROC-019 ASN 未提交或来源明细为空')
  }
  const sourceLine = notice.lines[0]
  const available = dataOf(await api.getBusiness(
    `/erp/purchase-reconciliation/available-lines?supplierId=${encodeURIComponent(supplierId)}`
  ), 'PROC-019 可对账明细')
  const availableLine = available.find((line) =>
    String(line.sourceNoticeId) === noticeId && String(line.sourceNoticeLineId) === String(sourceLine.id))
  if (!availableLine || Number(availableLine.shippedQty) < 2) {
    throw new Error('PROC-019 可对账明细未返回本轮 ASN 专属行')
  }
  const createPayload = {
    supplierId: String(supplierId),
    periodStart: localDate(),
    periodEnd: localDate(),
    sourceNoticeIds: [noticeId],
    sourceNoticeLineIds: [String(sourceLine.id)],
    remark: `PROC-019 isolated reconciliation ${tag}`
  }
  const reconciliationId = assertStableId(dataOf(await api.postBusiness(
    '/erp/purchase-reconciliation/create', createPayload
  ), 'PROC-019 对账创建'), 'PROC-019 对账')
  fixture.reconciliationId = reconciliationId
  const duplicate = await api.post('/erp/purchase-reconciliation/create', createPayload, {
    expectedBusinessRejection: {
      code: 500,
      message: /已进入其他有效对账单/,
      allowServiceCode: true
    }
  })
  if (duplicate.code === 0) throw new Error('PROC-019 同一 ASN 行重复发起对账未被拒绝')

  const pending = dataOf(await api.getBusiness(
    `/erp/purchase-reconciliation/get?id=${encodeURIComponent(reconciliationId)}`
  ), 'PROC-019 对账详情')
  if (!Array.isArray(pending?.lines) || !pending.lines.length ||
      Number(pending.totalShippedQty) < 2) {
    throw new Error('PROC-019 对账详情缺少来源行或发货数量')
  }
  const confirmLine = pending.lines[0]
  const confirmedPrice = Number(confirmLine.confirmedPrice) > 0
    ? Number(confirmLine.confirmedPrice)
    : 10
  dataOf(await api.putBusiness('/erp/purchase-reconciliation/confirm', {
    id: reconciliationId,
    confirmVersion: Number(pending.confirmVersion || 0),
    lines: [{
      id: String(confirmLine.id),
      confirmedQty: 2,
      confirmedPrice,
      remark: `PROC-019 confirm ${tag}`
    }]
  }), 'PROC-019 对账确认')
  const confirmed = dataOf(await api.getBusiness(
    `/erp/purchase-reconciliation/get?id=${encodeURIComponent(reconciliationId)}`
  ), 'PROC-019 对账确认详情')
  const confirmedLine = confirmed.lines?.[0]
  if (!confirmedLine ||
      Number(confirmedLine.confirmedQty) !== 2 ||
      Number(confirmedLine.confirmedPrice) !== confirmedPrice ||
      Number(confirmedLine.remainingInvoiceQty) !== 2 ||
      Number(confirmed.totalConfirmedQty) !== 2) {
    throw new Error('PROC-019 确认数量、单价或剩余可开票字段回读不一致')
  }
  fixture.status = 'verified'
  fixture.cleanup = 'confirmed-reconciliation-retained'
  return {
    tag,
    supplierId,
    material,
    purchaseOrderId: order.orderId,
    approvedOrder,
    noticeId,
    notice,
    availableLine,
    reconciliationId,
    createPayload,
    duplicate,
    pending,
    confirmed,
    confirmedPrice,
    fixture
  }
}
