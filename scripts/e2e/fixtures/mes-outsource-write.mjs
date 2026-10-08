import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { asList } from '../lib/assertions.mjs'

/**
 * 委外写侧专用夹具。
 *
 * 该模块只创建带 `E2E-OUTSRC` 前缀的专属业务数据，并增量补齐委外写侧
 * 真正缺失的审批前置（mes_bas_bill_options[MesProdOutsource]）。它不做
 * 任何破坏性操作：审批配置仅在缺失时新增，不覆盖其它单据类型或审批策略。
 */

export const OUTSOURCE_MARKER_PREFIX = 'E2E-OUTSRC'
export const OUTSOURCE_APPROVAL_BILL_TYPE = 'MesProdOutsource'
/** 委外单据审核/下达依赖的手工核批类型。 */
export const OUTSOURCE_MANUAL_APPROVAL = '1'
/** 加工费必须挂在服务类存货上，审核前置会强校验 inventoryNature=SERVICE。 */
export const SERVICE_INVENTORY_NATURE = 'SERVICE'

const payloadData = (payload) => payload?.data ?? payload

export function newOutsourceMarker () {
  return `${OUTSOURCE_MARKER_PREFIX}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
}

export function assertOutsourceFixtureScope (settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: 委外写侧夹具仅允许本机 tenant1/CFOR 标准平台/cfor_admin_standard')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: 委外写侧夹具仅允许本机 48083/9151')
    }
  }
}

/** 加工费服务类存货：唯一编码，避免复用历史污染数据。 */
export async function ensureServiceMaterial (api, marker = newOutsourceMarker()) {
  const code = `${marker}-FEE`
  const existing = asList(payloadData(
    await api.getBusiness(`/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&code=${encodeURIComponent(code)}`)
  )).find((row) => String(row.code) === code)
  if (existing?.id) return { id: String(existing.id), code, created: false }
  const created = payloadData(await api.postBusiness('/mes/basMaterial/add', {
    code, name: code, remark: marker, inventoryNature: SERVICE_INVENTORY_NATURE,
    isEnabled: 1, virtualGoods: 'N', source: 'mixed',
    purchased: 'N', saled: 'N', produced: 'N', parented: 'N',
    isMaterial: 'N', assembled: 'N', soned: 'N',
    batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N', gradeManaged: 'N',
    colorManaged: 'N', brandManaged: 'N', backflush: 'N',
    leadTime: 1, bufferTime: 1, refPrice: 0, refCost: 0
  }))
  return { id: String(created), code, created: true }
}

/**
 * 增量补齐委外审批配置。
 *
 * 标准租户默认没有 mes_bas_bill_options[MesProdOutsource]，BillUtils.getApprovalType
 * 回退为 "0"（免审），导致 Bill.getActions() 不提供 check，审核直接报
 * “单据不能做该操作”。该接口为租户级增量写入，不覆盖其它单据类型与审批策略。
 */
export async function ensureOutsourceApprovalOption (api) {
  const page = await api.getBusiness(
    `/mes/basBillOptions/list?pageNo=1&pageSize=100&billType=${OUTSOURCE_APPROVAL_BILL_TYPE}`
  )
  const rows = asList(payloadData(page))
  const match = rows.find((row) =>
    String(row.billType) === OUTSOURCE_APPROVAL_BILL_TYPE &&
    String(row.mbillApprovalType) === OUTSOURCE_MANUAL_APPROVAL
  )
  if (match?.id) return { created: false, id: String(match.id) }
  const created = await api.postBusiness('/mes/basBillOptions/add', {
    billType: OUTSOURCE_APPROVAL_BILL_TYPE,
    mbillApprovalType: OUTSOURCE_MANUAL_APPROVAL,
    abillApprovalType: OUTSOURCE_MANUAL_APPROVAL
  })
  return { created: true, response: created }
}

/** 创建带专属单号的委外草稿单，返回真实单据 id 与用于断言的快照。 */
export async function createOutsourceDraft (api, {
  marker = newOutsourceMarker(),
  prodWorkId,
  materialId,
  unitId,
  supplierId,
  processFeeMaterialId,
  planQty = 2,
  processPrice = 7,
  materialAmount = 3,
  giftLossQty = 0.5,
  taxInclusive = 1,
  currencyCode = 'CNY',
  taxRate = 13
} = {}) {
  const billNo = `${marker}-WO`
  const items = [{
    entryNo: 1,
    prodWorkId,
    materialId,
    unitId,
    supplierId,
    processFeeMaterialId,
    planQty,
    processPrice
  }]
  const body = {
    billNo,
    subject: marker,
    sourceType: 'WORK',
    outsourceType: 'WORK',
    outsourceTypeCode: 'OUTSOURCE_WORK',
    outsourceTypeRuleVersion: 1,
    prodWorkId,
    materialId,
    unitId,
    supplierId,
    processFeeMaterialId,
    planQty,
    processPrice,
    materialAmount,
    giftLossQty,
    taxInclusive,
    currencyCode,
    taxRate,
    isAuto: 0,
    isRubric: 0,
    status: 0,
    items
  }
  const id = String(payloadData(await api.postBusiness('/mes/prodOutsource/add', body)))
  return { id, billNo, marker }
}

/** 提交审批 -> 审核 -> 下达，逐步返回每一步的真实响应，供断言与留证。 */
export async function driveOutsourceLifecycle (api, id, remark = 'E2E 委外写侧闭环') {
  const steps = {}
  steps.submitApproval = await api.putBusiness(`/mes/prodOutsource/submitApproval?id=${encodeURIComponent(id)}`)
  steps.check = await api.putBusiness(`/mes/prodOutsource/check?id=${encodeURIComponent(id)}`)
  steps.release = await api.putBusiness(
    `/mes/prodOutsource/release?id=${encodeURIComponent(id)}&remark=${encodeURIComponent(remark)}`
  )
  return steps
}

export async function queryOutsourceDetail (api, id) {
  return payloadData(await api.getBusiness(`/mes/prodOutsource/queryById?id=${encodeURIComponent(id)}`))
}

export async function queryOutsourceActionLogs (api, id) {
  return asList(payloadData(await api.getBusiness(`/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(id)}`)))
}

export async function queryPriceAdjustments (api, id) {
  return asList(payloadData(await api.getBusiness(`/mes/prodOutsource/queryPriceAdjustments?id=${encodeURIComponent(id)}`)))
}
