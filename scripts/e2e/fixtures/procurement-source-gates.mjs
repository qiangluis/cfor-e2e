import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { createReconciliationWriteFixture } from './procurement-batch-a.mjs'

const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const tagOf = () => `PROC004_${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`
const dateTime = () => new Date().toISOString().slice(0, 19)
const PURCHASE_RECONCILIATION_CONFIG_PATH = '/system/config/get?category=purchase&tag=reconciliation'
const PURCHASE_RECONCILIATION_SAVE_PATH = '/system/config/save?category=purchase&tag=reconciliation'
const SALES_RECONCILIATION_CONFIG_PATH = '/system/config/get?category=sales&tag=reconciliation'
const SALES_RECONCILIATION_SAVE_PATH = '/system/config/save?category=sales&tag=reconciliation'

export const PROCUREMENT_RECONCILIATION_SOURCE_TYPE = 'ERP_PURCHASE_RECONCILIATION_ENTRY'

export const procurementSourceGateContracts = Object.freeze({
  directCreatePermission: Object.freeze({
    code: 1_030_102_009,
    message: /紧急直采需要专用权限/
  }),
  directCreateReason: Object.freeze({
    code: 1_030_102_010,
    message: /紧急直采必须填写原因/
  }),
  saleInvoiceReconciliation: Object.freeze({
    code: 1_030_102_012,
    message: /销售对账已启用，销售发票必须来源于已确认客户对账/
  }),
  purchaseInvoiceReconciliation: Object.freeze({
    code: 1_030_102_013,
    message: /采购对账已启用，采购发票必须来源于已确认供应商对账/
  })
})

export const PROCUREMENT_SOURCE_GATE_CHECKS = Object.freeze({
  directPermission: 'PROC-004 低权限账号紧急直采被专用权限门禁拒绝',
  directReason: 'PROC-004 有直采权限但未填写原因被门禁拒绝',
  directSnapshot: 'PROC-004 紧急直采订单保存原因快照',
  confirmedReconciliation: 'PROC-004 专属采购对账来源已确认且保留可开票余额',
  purchaseInvoiceUnconfirmed: 'PROC-004 未确认采购对账来源创建采购发票被拒绝',
  purchaseInvoiceSource: 'PROC-004 已确认采购对账来源创建发票并保留来源快照',
  saleInvoiceUnconfirmed: 'PROC-004 销售对账启用后未确认应收不能创建销售发票',
  saleInvoiceSource: 'PROC-004 已确认应收来源创建销售发票并保留来源快照'
})

const check = (caseRecord, name, passed, details = '') => {
  caseRecord.checks ||= []
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
}

const gap = (caseRecord, name, details) => {
  check(caseRecord, name, false, details)
  caseRecord.notes ||= []
  caseRecord.notes.push(`GAP: ${details}`)
}

const enabledConfig = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0' || normalized === '') return false
  try {
    return JSON.parse(normalized)?.enabled === true
  } catch {
    return false
  }
}

async function preparePurchaseReconciliationMode (api, caseRecord) {
  const row = dataOf(
    await api.getBusiness(PURCHASE_RECONCILIATION_CONFIG_PATH),
    'PROC-004 采购对账配置原值'
  )
  const originalValue = row?.configData == null ? 'false' : String(row.configData)
  const state = {
    originalValue,
    originalEnabled: enabledConfig(originalValue),
    temporaryOverride: false,
    restored: false
  }
  if (state.originalEnabled) {
    caseRecord.evidence.push('PROC-004 purchase/reconciliation 原值已启用，直接复用来源门禁')
    return state
  }
  await api.postBusiness(PURCHASE_RECONCILIATION_SAVE_PATH, {
    configData: '{"enabled":true}'
  })
  const prepared = dataOf(
    await api.getBusiness(PURCHASE_RECONCILIATION_CONFIG_PATH),
    'PROC-004 采购对账配置启用回读'
  )
  if (!enabledConfig(prepared?.configData)) {
    throw new Error('PROC-004 采购对账配置启用后回读仍未生效')
  }
  state.temporaryOverride = true
  caseRecord.evidence.push(
    `PROC-004 purchase/reconciliation 临时启用，原值=${originalValue}`
  )
  return state
}

async function restorePurchaseReconciliationMode (api, caseRecord, state) {
  if (!state?.temporaryOverride || state.restored) return
  const current = dataOf(
    await api.getBusiness(PURCHASE_RECONCILIATION_CONFIG_PATH),
    'PROC-004 采购对账配置恢复前回读'
  )
  if (!enabledConfig(current?.configData)) {
    throw new Error('BLOCKED: PROC-004 采购对账配置被并发修改，拒绝覆盖当前值')
  }
  await api.postBusiness(PURCHASE_RECONCILIATION_SAVE_PATH, {
    configData: state.originalValue
  })
  const restored = dataOf(
    await api.getBusiness(PURCHASE_RECONCILIATION_CONFIG_PATH),
    'PROC-004 采购对账配置恢复回读'
  )
  if (String(restored?.configData ?? '') !== state.originalValue) {
    throw new Error(
      `BLOCKED: PROC-004 采购对账配置恢复失败：expected=${state.originalValue}; ` +
      `actual=${restored?.configData ?? ''}`
    )
  }
  state.restored = true
  caseRecord.evidence.push(
    `PROC-004 purchase/reconciliation 已恢复原值=${state.originalValue}`
  )
}

async function prepareSalesReconciliationMode (api, caseRecord) {
  const row = dataOf(
    await api.getBusiness(SALES_RECONCILIATION_CONFIG_PATH),
    'PROC-004 销售对账配置原值'
  )
  const originalValue = row?.configData == null ? 'false' : String(row.configData)
  const state = {
    originalValue,
    originalEnabled: enabledConfig(originalValue),
    temporaryOverride: false,
    restored: false
  }
  if (state.originalEnabled) {
    caseRecord.evidence.push('PROC-004 sales/reconciliation 原值已启用，直接复用来源门禁')
    return state
  }
  await api.postBusiness(SALES_RECONCILIATION_SAVE_PATH, {
    configData: '{"enabled":true}'
  })
  const prepared = dataOf(
    await api.getBusiness(SALES_RECONCILIATION_CONFIG_PATH),
    'PROC-004 销售对账配置启用回读'
  )
  if (!enabledConfig(prepared?.configData)) {
    throw new Error('PROC-004 销售对账配置启用后回读仍未生效')
  }
  state.temporaryOverride = true
  caseRecord.evidence.push(
    `PROC-004 sales/reconciliation 临时启用，原值=${originalValue}`
  )
  return state
}

async function restoreSalesReconciliationMode (api, caseRecord, state) {
  if (!state?.temporaryOverride || state.restored) return
  const current = dataOf(
    await api.getBusiness(SALES_RECONCILIATION_CONFIG_PATH),
    'PROC-004 销售对账配置恢复前回读'
  )
  if (!enabledConfig(current?.configData)) {
    throw new Error('BLOCKED: PROC-004 销售对账配置被并发修改，拒绝覆盖当前值')
  }
  await api.postBusiness(SALES_RECONCILIATION_SAVE_PATH, {
    configData: state.originalValue
  })
  const restored = dataOf(
    await api.getBusiness(SALES_RECONCILIATION_CONFIG_PATH),
    'PROC-004 销售对账配置恢复回读'
  )
  if (String(restored?.configData ?? '') !== state.originalValue) {
    throw new Error(
      `BLOCKED: PROC-004 销售对账配置恢复失败：expected=${state.originalValue}; ` +
      `actual=${restored?.configData ?? ''}`
    )
  }
  state.restored = true
  caseRecord.evidence.push(
    `PROC-004 sales/reconciliation 已恢复原值=${state.originalValue}`
  )
}

export const matchesExactProcurementSourceRejection = (response, contract) =>
  response?.data === null && matchesExpectedBusinessRejection(response, contract)

export function assertProcurementSourceRejection (response, contract, label) {
  if (!matchesExactProcurementSourceRejection(response, contract)) {
    throw new Error(`${label}不是精确领域拒绝：${JSON.stringify({
      code: response?.code,
      message: response?.msg || response?.message,
      data: response?.data
    })}`)
  }
  return response
}

export function buildDirectCreatePayload ({ supplierId, material, reason = '', tag = tagOf() } = {}) {
  if (!stableId(supplierId) || !stableId(material?.id) || !stableId(material?.unitId)) {
    throw new Error('PROC-004 紧急直采订单缺少专属供应商、物料或单位 ID')
  }
  return {
    type: 0,
    supplierId: String(supplierId),
    orderTime: dateTime(),
    billDate: dateTime().slice(0, 10),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 1,
    totalProductPrice: 10,
    totalTaxPrice: 0,
    totalPrice: 10,
    directCreate: 1,
    directCreateReason: reason,
    remark: `PROC-004 isolated emergency purchase ${tag}`,
    items: [{
      entryNo: 1,
      productId: String(material.id),
      productUnitId: String(material.unitId),
      productPrice: 10,
      count: 1,
      taxPercent: 0,
      totalPrice: 10,
      taxPrice: 0,
      remark: `PROC-004 isolated emergency line ${tag}`
    }]
  }
}

export function assertReconciliationInvoiceSnapshot (invoice, reconciliation) {
  const sourceIds = String(invoice?.reconciliationSourceIds || '')
    .split(',').map((value) => value.trim()).filter(Boolean)
  const expectedEntryIds = (reconciliation?.confirmed?.lines || [])
    .map((line) => String(line?.id || '').trim())
    .filter(Boolean)
  const versions = invoice?.reconciliationSourceVersions
  let versionSnapshot
  try {
    versionSnapshot = JSON.parse(String(versions || ''))
  } catch {
    versionSnapshot = null
  }
  const allocationSnapshot = Array.isArray(versionSnapshot?.allocations)
    ? versionSnapshot.allocations
    : []
  const hasExpectedEntry = expectedEntryIds.some((entryId) => sourceIds.includes(entryId))
  const hasVersionSnapshot = allocationSnapshot.some((allocation) =>
    expectedEntryIds.includes(String(allocation?.entryId || '').trim()) &&
    String(allocation?.sourceVersion || '').trim())
  if (invoice?.reconciliationSourceType !== PROCUREMENT_RECONCILIATION_SOURCE_TYPE ||
      !hasExpectedEntry || !hasVersionSnapshot) {
    throw new Error('PROC-004 采购发票未保存已确认采购对账的类型、ID 或版本快照')
  }
  return invoice
}

/**
 * Runs only formal API contracts. Callers must supply separate principals:
 * `lowPrivilegeApi` without direct-create permission and `privilegedApi` with it.
 * No account, configuration, or financial record is fabricated here.
 */
export async function runProcurementSourceGates ({
  privilegedApi,
  lowPrivilegeApi,
  caseRecord,
  createConfirmedReconciliation = createReconciliationWriteFixture,
  supplierPortalApi,
  submitSupplierInvoice,
  saleInvoiceEvidence,
  createSaleInvoiceEvidence
} = {}) {
  if (!privilegedApi?.post || !privilegedApi?.postBusiness || !privilegedApi?.getBusiness) {
    throw new Error('PROC-004 requires a privileged API client with post/postBusiness/getBusiness')
  }
  if (!lowPrivilegeApi?.post) {
    throw new Error('PROC-004 requires a separately authenticated low-privilege API client')
  }
  if (!caseRecord) throw new Error('PROC-004 requires a case record')

  const reconciliationMode = await preparePurchaseReconciliationMode(privilegedApi, caseRecord)
  try {
    const reconciliation = await createConfirmedReconciliation(privilegedApi, caseRecord)
    const source = {
      supplierId: reconciliation.supplierId,
      material: reconciliation.material
    }
    const validReason = `PROC-004 emergency procurement ${reconciliation.tag || tagOf()}`
    const lowPrivilegePayload = buildDirectCreatePayload({ ...source, reason: validReason })
    const lowPrivilege = assertProcurementSourceRejection(await lowPrivilegeApi.post(
      '/erp/purchase-order/create', lowPrivilegePayload, {
        expectedBusinessRejection: procurementSourceGateContracts.directCreatePermission
      }
    ), procurementSourceGateContracts.directCreatePermission, 'PROC-004 低权限紧急直采')
    check(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.directPermission, true,
      `code=${lowPrivilege.code}; supplierId=${source.supplierId}`)

    const noReasonPayload = buildDirectCreatePayload({ ...source, reason: '' })
    const noReason = assertProcurementSourceRejection(await privilegedApi.post(
      '/erp/purchase-order/create', noReasonPayload, {
        expectedBusinessRejection: procurementSourceGateContracts.directCreateReason
      }
    ), procurementSourceGateContracts.directCreateReason, 'PROC-004 紧急直采缺少原因')
    check(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.directReason, true, `code=${noReason.code}`)

    const directOrderId = String(dataOf(await privilegedApi.postBusiness(
      '/erp/purchase-order/create', lowPrivilegePayload
    ), 'PROC-004 有权限且有原因的紧急直采'),)
    if (!stableId(directOrderId)) throw new Error(`PROC-004 紧急直采未返回稳定订单 ID：${directOrderId}`)
    const directOrder = dataOf(await privilegedApi.getBusiness(
      `/erp/purchase-order/get?id=${encodeURIComponent(directOrderId)}`
    ), 'PROC-004 紧急直采订单详情')
    if (Number(directOrder?.directCreate) !== 1 || directOrder?.directCreateReason !== validReason) {
      throw new Error('PROC-004 紧急直采订单未保存 directCreate 或 directCreateReason')
    }
    check(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.directSnapshot, true,
      `orderId=${directOrderId}; reason=${validReason}`)

    const unconfirmedInvoice = await privilegedApi.post('/erp/purchase-invoice/create', {
      supplierId: String(source.supplierId),
      companyName: '',
      taxNo: '',
      invoiceNo: `PROC004-UNCONFIRMED-${tagOf()}`,
      invoiceType: 1,
      taxRate: 0,
      invoiceMoney: 10,
      invoicePrice: 10,
      isRubric: 0,
      remark: 'PROC-004 unconfirmed reconciliation rejection',
      items: [{
        purchaseOrderId: directOrderId,
        invoiceMoneyItem: 10
      }]
    }, {
      expectedBusinessRejection: procurementSourceGateContracts.purchaseInvoiceReconciliation
    })
    if (unconfirmedInvoice?.code === 0 && stableId(unconfirmedInvoice?.data) &&
        privilegedApi.deleteBusiness) {
      await privilegedApi.deleteBusiness(
        `/erp/purchase-invoice/delete?id=${encodeURIComponent(unconfirmedInvoice.data)}`
      )
    }
    const rejectedUnconfirmed = assertProcurementSourceRejection(
      unconfirmedInvoice,
      procurementSourceGateContracts.purchaseInvoiceReconciliation,
      'PROC-004 未确认采购对账来源创建采购发票'
    )
    check(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.purchaseInvoiceUnconfirmed, true,
      `code=${rejectedUnconfirmed.code}; msg=${rejectedUnconfirmed.msg || ''}`)

    const confirmedLine = reconciliation.confirmed?.lines?.[0]
    if (!reconciliation.reconciliationId || !confirmedLine?.id ||
        Number(confirmedLine.remainingInvoiceQty) <= 0) {
      throw new Error('PROC-004 专属采购对账未形成可开票确认来源')
    }
    check(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.confirmedReconciliation, true,
      `reconciliationId=${reconciliation.reconciliationId}; entryId=${confirmedLine.id}; ` +
      `remainingInvoiceQty=${confirmedLine.remainingInvoiceQty}`)

    if (!supplierPortalApi?.getBusiness || typeof submitSupplierInvoice !== 'function') {
      gap(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.purchaseInvoiceSource,
        '缺少供应商门户正式 API 上下文或 submitSupplierInvoice；不能用后台令牌伪造采购发票来源快照')
    } else {
      const invoice = await submitSupplierInvoice({
        supplierPortalApi,
        privilegedApi,
        reconciliation,
        confirmedLine,
        caseRecord
      })
      assertReconciliationInvoiceSnapshot(invoice, reconciliation)
      check(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.purchaseInvoiceSource, true,
        `invoiceId=${invoice.id}; reconciliationId=${reconciliation.reconciliationId}`)
    }

    const actualSaleInvoiceEvidence = saleInvoiceEvidence ||
      (typeof createSaleInvoiceEvidence === 'function'
        ? await createSaleInvoiceEvidence({ privilegedApi, caseRecord })
        : null)
    if (!actualSaleInvoiceEvidence?.invoice || !actualSaleInvoiceEvidence?.receivableId ||
        !actualSaleInvoiceEvidence?.version) {
      gap(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.saleInvoiceSource,
        '缺少通过专属销售订单正规生成并确认的应收及销售发票详情；本 helper 不手工创建应收或伪造确认')
    } else {
      const sourceIds = String(actualSaleInvoiceEvidence.invoice.reconciliationSourceIds || '')
      const sourceVersions = String(actualSaleInvoiceEvidence.invoice.reconciliationSourceVersions || '')
      const passed = actualSaleInvoiceEvidence.invoice.reconciliationSourceType === 'FIN_RECEIVABLE' &&
        sourceIds.split(',').includes(String(actualSaleInvoiceEvidence.receivableId)) &&
        sourceVersions.includes(String(actualSaleInvoiceEvidence.version))
      check(caseRecord, PROCUREMENT_SOURCE_GATE_CHECKS.saleInvoiceSource, passed,
        `receivableId=${actualSaleInvoiceEvidence.receivableId}; version=${actualSaleInvoiceEvidence.version}`)
      if (!passed) throw new Error('PROC-004 销售发票未保存确认应收来源快照')
    }

    return { reconciliation, directOrderId, lowPrivilege, noReason }
  } finally {
    await restorePurchaseReconciliationMode(privilegedApi, caseRecord, reconciliationMode)
  }
}
