import { config } from '../config/index.mjs'
import { isDeepStrictEqual } from 'node:util'
import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { addCheck } from '../lib/report.mjs'
import {
  IQC_SOURCE_PERMISSIONS,
  QUALITY_PENDING_SOURCE_GAPS,
  cleanupQualityPendingSalesSource,
  loadQualityPendingIqcSource,
  pendingSourceId,
  prepareQualityPendingProductionSources,
  prepareQualityPendingSalesSource,
  prepareQualityPendingIqcSource,
  readPendingWmsDraft,
  verifyPendingAccess
} from './quality-pending-source.mjs'

export const QUALITY_PENDING_CASE_ID = 'QUALITY-PENDING-001'
export const QUALITY_PENDING_PERMISSIONS = [
  'mes:quality-pending:query',
  'mes:quality-pending:register',
  'mes:quality-pending:cancel'
]

export const ERROR_CODES = Object.freeze({
  SOURCE_UNSUPPORTED: 2010920007,
  SAMPLE_QTY_INVALID: 2010920008
})

export const QUALITY_PENDING_CATALOG_ASSERTIONS = Object.freeze([
  '待检任务统一记录采购入库、生产过程、生产入库、销售出库、销售退货和质量计划来源场景',
  '重复登记仍按质检类型、来源单据和来源明细幂等累加',
  '待检任务保存质检方案、方案版本、抽检方式、样本量、指定检验人和检验期限快照',
  '样本量不能超过待检数量，来源场景与 IQC/IPQC/OQC/RQC 校验一致',
  '待检池页面展示来源场景、检验方案、抽检/样本量、检验员和期限'
])

export const QUALITY_PENDING_SOURCE_SCENES = Object.freeze([
  'PURCHASE_INBOUND',
  'PROCESS_INSPECTION',
  'PRODUCTION_INBOUND',
  'SALES_OUTBOUND',
  'SALES_RETURN',
  'QUALITY_PLAN'
])

const isNonEmpty = (value) => value !== undefined && value !== null && String(value).trim() !== ''

export const stringId = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`BLOCKED: ${label} 必须以字符串传递，禁止 Number 解析造成 ID 精度丢失`)
  }
  return value.trim()
}

const dataOf = (body) => body?.data ?? body

const rowsOf = (body) => {
  const data = dataOf(body)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.records)) return data.records
  throw new Error('BLOCKED: 正式列表响应不是数组，拒绝按空列表继续')
}

const numeric = (value, label) => {
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`BLOCKED: ${label} 必须是大于 0 的有限数字`)
  }
  return result
}

export const createOwnershipLedger = ({ sourceKind = 'WMS_STK_IO' } = {}) => ({
  sourceKind,
  sourceCreatedByCase: false,
  sourceId: null,
  sourceEntryId: null,
  pendingId: null,
  cleanup: [],
  failures: []
})

export const recordOwnershipFailure = (ledger, error) => {
  const message = error instanceof Error ? error.message : String(error)
  ledger.failures.push(message)
  ledger.cleanup.push(
    ledger.sourceCreatedByCase
      ? '来源创建失败或不完整：保留所有权记录，禁止猜测删除；由主控按来源 API 状态人工核对。'
      : '来源由主控预置且非本用例所有：不执行来源删除；只允许回收本用例已登记的待检任务。'
  )
  return ledger
}

export function assertQualityPendingScope (settings = config) {
  if (settings.target !== 'local' ||
      String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: QUALITY-PENDING-001 只允许本地 tenant 1 / CFOR 标准平台')
  }
  for (const [label, base, port] of [
    ['前端', settings.webBase, '9151'],
    ['后端', settings.apiBase, '48083']
  ]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port ||
        url.username ||
        url.password) {
      throw new Error(`BLOCKED: QUALITY-PENDING-001 ${label} 必须使用本地回环端口 ${port}`)
    }
  }
  try {
    assertLocalDatabase(settings.db)
  } catch {
    throw new Error('BLOCKED: QUALITY-PENDING-001 只允许 loopback:3306/cfor_admin_standard')
  }
}

const requireOptIn = (caseRecord) => {
  assertQualityPendingScope()
  if (process.env.CFOR_E2E_ENABLE_QUALITY_PENDING_CLOSURE !== 'true') {
    throw new Error('BLOCKED: 未设置 CFOR_E2E_ENABLE_QUALITY_PENDING_CLOSURE=true')
  }
  if (process.env.CFOR_QUALITY_PENDING_CONFIRM !== QUALITY_PENDING_CASE_ID) {
    throw new Error(
      `BLOCKED: 需要 CFOR_QUALITY_PENDING_CONFIRM=${QUALITY_PENDING_CASE_ID} 才允许待检写侧`
    )
  }
  if (isNonEmpty(process.env.CFOR_QUALITY_PENDING_SOURCE_CREATE_JSON) ||
      isNonEmpty(process.env.CFOR_QUALITY_PENDING_SOURCE_CREATE_PATH)) {
    throw new Error('BLOCKED: 禁止任意 SOURCE_CREATE_JSON/PATH，请使用受控 PREPARE_IQC=true')
  }
  return assertLocalWriteSafety(caseRecord)
}

export const resolveWmsScene = (detail) => {
  const src = String(detail.srcBillType || '')
  const ioType = String(detail.stockIoType || '')
  if (ioType === '302' && ['SalReturn', 'ErpSaleReturn'].includes(src)) {
    return { qcType: 'RQC', sourceScene: 'SALES_RETURN' }
  }
  if (ioType === '101' && ['PurOrder', 'ErpPurchaseIn', 'MesWmsArrivalNotice'].includes(src)) {
    return { qcType: 'IQC', sourceScene: 'PURCHASE_INBOUND' }
  }
  if (ioType === '201' && ['SalOrder', 'ErpSaleOut', 'MesWmsSalesNotice'].includes(src)) {
    return { qcType: 'OQC', sourceScene: 'SALES_OUTBOUND' }
  }
  if (ioType === '104' && ['ProdWork', 'ProdOrder'].includes(src)) {
    return { qcType: 'IPQC', sourceScene: 'PRODUCTION_INBOUND' }
  }
  throw new Error(
    `BLOCKED: 当前专属 WMS 来源类型 ${ioType || '(空)'} / ${src || '(空)'} 无法映射到已证实场景；PROCESS_INSPECTION 工单 helper 仍为 GAP`
  )
}

export function recordQualityPendingCatalogEvidence (caseRecord, {
  sourceChainVerified,
  idempotentVerified,
  snapshotVerified,
  validationVerified,
  pageVerified,
  sourceId,
  sourceEntryId,
  sourceBillNo,
  planId,
  planVersion,
  duplicateDetails,
  validationDetails,
  pageDetails,
  sceneEvidence
}) {
  const tested = sceneEvidence || (sourceChainVerified ? [{
    sourceScene: 'PURCHASE_INBOUND', qcType: 'IQC', chainVerified: sourceChainVerified,
    idempotentVerified, snapshotVerified, validationVerified, pageVerified,
    sourceBillId: sourceId, sourceEntryId, sourceBillNo, planId, planVersion,
    duplicateDetails, validationDetails, pageDetails
  }] : [])
  const verified = tested.filter(row => row.chainVerified === true)
  const missingScenes = QUALITY_PENDING_SOURCE_SCENES.filter(scene =>
    !verified.some(row => row.sourceScene === scene))
  const testedTypes = new Set(verified.filter(row => row.validationVerified === true).map(row => row.qcType))
  const missingTypes = ['IQC', 'IPQC', 'OQC', 'RQC'].filter(type => !testedTypes.has(type))
  const all = key => verified.length > 0 && tested.length === verified.length &&
    verified.every(row => row[key] === true)
  const evidence = [
    JSON.stringify({ verified: verified.map(row => ({
      scene: row.sourceScene, source: `${row.sourceBillId}/${row.sourceEntryId}`,
      sourceBillNo: row.sourceBillNo, pendingId: row.pendingId
    })), missing: missingScenes, gaps: caseRecord.sourceSceneGaps || QUALITY_PENDING_SOURCE_GAPS }),
    JSON.stringify(verified.map(row => ({ scene: row.sourceScene, details: row.duplicateDetails }))),
    JSON.stringify(verified.map(row => ({
      scene: row.sourceScene, planId: row.planId, planVersion: row.planVersion,
      snapshot: row.snapshotVerified
    }))),
    JSON.stringify({ tested: verified.map(row => ({
      qcType: row.qcType, details: row.validationDetails
    })), missingQcTypes: missingTypes }),
    JSON.stringify(verified.map(row => ({ scene: row.sourceScene, details: row.pageDetails })))
  ]
  const passed = [
    missingScenes.length === 0,
    all('idempotentVerified'),
    all('snapshotVerified'),
    all('validationVerified') && missingTypes.length === 0,
    all('pageVerified')
  ]
  caseRecord.catalogAssertions = QUALITY_PENDING_CATALOG_ASSERTIONS.map((assertion, index) => ({
    index,
    assertion,
    status: passed[index] ? 'VERIFIED' : 'PARTIAL',
    evidence: evidence[index],
    details: evidence[index]
  }))
  caseRecord.remainingAssertions = [
    ...(missingScenes.length ? missingScenes.map((scene) => ({
      PROCESS_INSPECTION: '生产过程 PROCESS_INSPECTION 来源',
      PRODUCTION_INBOUND: '生产入库 PRODUCTION_INBOUND 来源',
      SALES_OUTBOUND: '销售出库 SALES_OUTBOUND 来源',
      SALES_RETURN: '销售退货 SALES_RETURN 来源',
      QUALITY_PLAN: '质量计划 QUALITY_PLAN 来源',
      PURCHASE_INBOUND: '采购入库 PURCHASE_INBOUND 来源'
    }[scene])) : []),
    ...QUALITY_PENDING_CATALOG_ASSERTIONS.filter((_, index) => !passed[index] && index !== 0)
  ]
  caseRecord.sourceSceneEvidence = tested
  caseRecord.catalogComplete = caseRecord.catalogAssertions.every((item) =>
    item.status === 'VERIFIED'
  )
  return caseRecord.catalogAssertions
}

const expectRejected = async (api, payload, expectedCode, label) => {
  const response = await api.post('/mes/quality/pending-inspect/register', payload, {
    expectedBusinessRejection: { code: expectedCode,
      message: expectedCode === ERROR_CODES.SAMPLE_QTY_INVALID ? /样本|抽检/ : /来源场景/ }
  })
  const passed = response?.code === expectedCode
  if (!passed) {
    throw new Error(`${label} 未按正式错误码拒绝：${JSON.stringify(response).slice(0, 500)}`)
  }
  return response
}

const add = (caseRecord, name, passed, details = '') =>
  addCheck(caseRecord, name, passed, details)

export async function cancelOwnedPending (api, ledger, reason) {
  const path = `/mes/quality/pending-inspect/get?id=${encodeURIComponent(ledger.pendingId)}`
  const before = dataOf(await api.getBusiness(path))
  if (pendingSourceId(before?.id) !== ledger.pendingId ||
      before.sourceBillType !== (ledger.sourceBillType || 'MesStkIo') || before.sourceBillId !== ledger.sourceId ||
      before.sourceEntryId !== ledger.sourceEntryId ||
      !String(before.remark || '').includes(ledger.marker) ||
      before.qcType !== (ledger.qcType || 'IQC') ||
      before.sourceScene !== (ledger.sourceScene || 'PURCHASE_INBOUND')) {
    throw new Error('BLOCKED: 取消前本轮待检记录所有权核对失败，拒绝写共享记录')
  }
  assertBusinessSuccess(await api.post(
    `/mes/quality/pending-inspect/cancel?id=${encodeURIComponent(ledger.pendingId)}&reason=${encodeURIComponent(reason)}`
  ), 'pending cancel')
  const after = dataOf(await api.getBusiness(path))
  if (after?.status !== 'CANCELLED' || after.cancelReason !== reason ||
      after.sourceBillId !== ledger.sourceId || after.sourceEntryId !== ledger.sourceEntryId) {
    throw new Error(`待检取消后状态/原因/来源回读失败：${ledger.pendingId}`)
  }
  return after
}

export async function verifyOwnedPendingCleanup ({
  api, ledger, context, caseRecord, readSql = runReadOnlySql
}) {
  const pending = dataOf(await api.getBusiness(
    `/mes/quality/pending-inspect/get?id=${encodeURIComponent(ledger.pendingId)}`
  ))
  const rows = rowsOf(await api.getBusiness(
    `/mes/quality/pending-inspect/list-by-source?sourceBillType=MesStkIo&sourceBillId=${encodeURIComponent(ledger.sourceId)}`
  ), '取消后待检来源回读')
  const sourceAfter = dataOf(await api.getBusiness(
    `/mes/stkIo/queryById/dictText?id=${encodeURIComponent(ledger.sourceId)}`
  ))
  const noticeAfter = dataOf(await api.getBusiness(
    `/mes/wms/arrival-notice/get?id=${encodeURIComponent(context.noticeId)}`
  ))
  const orderAfter = dataOf(await api.getBusiness(
    `/erp/purchase-order/get?id=${encodeURIComponent(context.orderId)}`
  ))
  const passed = pendingSourceId(pending?.id) === ledger.pendingId &&
    pending?.status === 'CANCELLED' &&
    pending?.cancelReason === 'QUALITY-PENDING-001 reverse' &&
    pendingSourceId(pending.sourceBillId) === ledger.sourceId &&
    pendingSourceId(pending.sourceEntryId) === ledger.sourceEntryId &&
    rows.length === 1 &&
    pendingSourceId(rows[0]?.id) === ledger.pendingId &&
    rows[0]?.status === 'CANCELLED' &&
    pendingSourceId(sourceAfter?.id) === ledger.sourceId &&
    String(sourceAfter?.stockIoType) === '101' &&
    sourceAfter?.srcBillType === 'MesWmsArrivalNotice' &&
    String(sourceAfter?.billStage) === '12' &&
    Number(sourceAfter?.isEffective) === 0 &&
    Number(sourceAfter?.isVoided) === 0 &&
    pendingSourceId(noticeAfter?.id) === context.noticeId &&
    pendingSourceId(noticeAfter?.purchaseOrderId) === context.orderId &&
    Number(noticeAfter?.status) === 10 &&
    noticeAfter.lines?.length === 1 &&
    pendingSourceId(noticeAfter.lines[0]?.id) === context.noticeLineId &&
    Number(noticeAfter.lines[0]?.receivedQuantity) === 0 &&
    pendingSourceId(orderAfter?.id) === context.orderId &&
    Number(orderAfter?.isEffective) === 1 &&
    Number(orderAfter?.isVoided) === 0 &&
    orderAfter.remark === ledger.marker
  const snapshot = await readSql(`
    SELECT 'pending', id, status, source_bill_id, source_entry_id, cancel_reason
    FROM mes_quality_pending_inspect
    WHERE tenant_id=1 AND deleted=0 AND id='${pendingSourceId(ledger.pendingId)}';
    SELECT 'source', id, stock_io_type, bill_stage, is_effective, is_voided
    FROM mes_stk_io
    WHERE tenant_id=1 AND deleted=0 AND id='${pendingSourceId(ledger.sourceId)}';
    SELECT 'notice', id, status, purchase_order_id
    FROM mes_wms_arrival_notice
    WHERE tenant_id=1 AND deleted=0 AND id='${pendingSourceId(context.noticeId)}';
  `)
  caseRecord.database ||= []
  caseRecord.database.push({ stage: 'quality-pending-owned-cleanup-readback', ...snapshot })
  const expectedRows = [
    ['pending', ledger.pendingId, 'CANCELLED', ledger.sourceId, ledger.sourceEntryId, 'QUALITY-PENDING-001 reverse'],
    ['source', ledger.sourceId, '101', '12', '0', '0'],
    ['notice', context.noticeId, '10', context.orderId]
  ]
  const databaseVerified = snapshot.available && isDeepStrictEqual(snapshot.rows, expectedRows)
  add(
    caseRecord,
    '专属待检取消后回读 pending、101草稿、ASN 和采购订单所有权',
    passed && databaseVerified,
    JSON.stringify({
      pending: { id: pending?.id, status: pending?.status, sourceBillId: pending?.sourceBillId },
      rows: rows.length,
      source: { id: sourceAfter?.id, type: sourceAfter?.stockIoType, stage: sourceAfter?.billStage, effective: sourceAfter?.isEffective },
      notice: { id: noticeAfter?.id, status: noticeAfter?.status, received: noticeAfter?.lines?.[0]?.receivedQuantity },
      order: { id: orderAfter?.id, effective: orderAfter?.isEffective }
    })
  )
  if (!passed || !databaseVerified) throw new Error('BLOCKED: 专属待检取消后的采购/ASN/101来源回读不一致')
  caseRecord.evidence.push(
    `专属数据清理回读通过：pending=${ledger.pendingId} CANCELLED；` +
    `采购=${context.orderId} effective=1；ASN=${context.noticeId} status=10 received=0；` +
    `101=${ledger.sourceId}/${ledger.sourceEntryId} stage=12 effective=0；来源保留作审计`
  )
  return { pending, rows, source: sourceAfter, notice: noticeAfter, order: orderAfter, snapshot }
}

export async function verifyPendingDatabase ({
  ledger, source, plan, inspectorId, caseRecord, readSql = runReadOnlySql
}) {
  const id = pendingSourceId(ledger.pendingId)
  const sourceId = pendingSourceId(ledger.sourceId)
  const entryId = pendingSourceId(ledger.sourceEntryId)
  const materialId = pendingSourceId(source.materialId)
  const planId = pendingSourceId(plan.id)
  const snapshot = await readSql(`
    SELECT p.id, p.status, p.cancel_reason, p.qc_type, p.source_scene,
      p.source_bill_id, p.source_entry_id, p.material_id, p.inspection_plan_id,
      p.inspection_plan_version, p.assigned_inspector_user_id, p.sample_qty,
      p.pending_qty, p.sampling_type, IF(p.due_time IS NULL, 0, 1),
      io.stock_io_type, io.bill_stage, io.is_effective, io.is_voided,
      e.material_id, e.qty, e.is_qc, e.src_bill_type, e.src_bill_id,
      qp.publish_status, qp.version_no,
      (SELECT COUNT(*) FROM mes_stk_inventory WHERE tenant_id=1 AND deleted=0
        AND material_id='${materialId}'),
      (SELECT COUNT(*) FROM mes_quality_pending_inspect WHERE tenant_id=1 AND deleted=0
        AND source_bill_type='MesStkIo' AND source_bill_id='${sourceId}'),
      (SELECT COUNT(*) FROM mes_quality_material WHERE tenant_id=1 AND deleted=0
        AND material_id='${materialId}' AND plan_id='${planId}' AND type='101')
    FROM mes_quality_pending_inspect p
    JOIN mes_stk_io io ON io.id=p.source_bill_id AND io.tenant_id=1 AND io.deleted=0
    JOIN mes_stk_io_entry e ON e.id=p.source_entry_id AND e.mid=io.id AND e.tenant_id=1 AND e.deleted=0
    JOIN mes_quality_plan qp ON qp.id=p.inspection_plan_id AND qp.tenant_id=1 AND qp.deleted=0
    WHERE p.id='${id}' AND p.tenant_id=1 AND p.deleted=0
  `)
  caseRecord.database ||= []
  caseRecord.database.push({ stage: 'quality-pending-101-cancelled', ...snapshot })
  const expected = [
    id, 'CANCELLED', 'QUALITY-PENDING-001 reverse', 'IQC', 'PURCHASE_INBOUND',
    sourceId, entryId, materialId, planId, String(plan.version), inspectorId,
    null, null, 'FIXED', '1', '101', '12', '0', '0', materialId,
    null, '1', 'MesWmsArrivalNotice', pendingSourceId(source.detail.srcBillId),
    '1', String(plan.version), '0', '1', '1'
  ]
  const row = snapshot.rows?.[0]
  const passed = snapshot.available && snapshot.rows.length === 1 &&
    expected.every((value, index) => value === null || row[index] === value) &&
    Number(row[11]) === 1 && Number(row[12]) === 2 && Number(row[20]) === 1
  add(caseRecord, '只读DB证明101来源/快照/重复登记/取消审计且库存未变', Boolean(passed),
    JSON.stringify(snapshot.rows))
  if (!passed) throw new Error('DB 对账未确认101闭环、取消审计或零库存，不宣称完成')
  return snapshot
}

export function pendingSnapshotMatches (row, payload, { pendingId, pendingQty = payload.pendingQty } = {}) {
  return row?.status === 'WAITING' &&
    (!pendingId || String(row.id) === pendingId) &&
    ['qcType', 'sourceScene', 'sourceBillType', 'sourceBillId', 'sourceEntryId',
      'inspectionPlanCode', 'samplingType', 'dueTime'].every(key => row[key] === payload[key]) &&
    ['materialId', 'inspectionPlanId', 'assignedInspectorUserId'].every(key =>
      String(row[key]) === String(payload[key])) &&
    Number(row.inspectionPlanVersion) === Number(payload.inspectionPlanVersion) &&
    Number(row.sampleQty) === Number(payload.sampleQty) &&
    Number(row.pendingQty) === Number(pendingQty)
}

const sceneText = {
  PURCHASE_INBOUND: '采购入库检验', PROCESS_INSPECTION: '生产过程检验',
  PRODUCTION_INBOUND: '生产入库检验', SALES_OUTBOUND: '销售出库检验',
  SALES_RETURN: '销售退货检验', QUALITY_PLAN: '质量计划检验'
}

export function pendingPageCellsMatch (cells, payload) {
  const compact = value => String(value ?? '').replace(/\s+/g, '')
  return cells.length >= 8 &&
    compact(cells[1]) === compact(payload.sourceBillNo) &&
    compact(cells[2]) === compact(sceneText[payload.sourceScene]) &&
    compact(cells[4]) === compact(`${payload.inspectionPlanCode}/V${payload.inspectionPlanVersion}`) &&
    compact(cells[5]) === compact(`固定抽样/${payload.sampleQty}`) &&
    compact(cells[6]) === compact(`${payload.assignedInspectorUserId}/-`) &&
    compact(cells[7]) === compact(payload.dueTime)
}

export async function verifyQualityPendingPage ({
  page, record, caseRecord, outputDir, payload, helpers
}) {
  if (!payload.sourceBillNo) throw new Error('BLOCKED: 待检页面证据必须有真实来源单号')
  await helpers.openRoute(page, '/quality/pendingInspect', {
    readySelector: '[data-testid="quality-pending-inspect-page"]'
  })
  const input = page.getByPlaceholder('出入库单号')
  await input.fill(payload.sourceBillNo)
  await input.press('Enter')
  const row = page.locator('.el-table__body-wrapper tr.el-table__row')
    .filter({ hasText: payload.sourceBillNo })
  await row.first().waitFor({ state: 'visible', timeout: 15000 })
  const cells = await row.first().locator('td').allTextContents()
  const passed = new URL(page.url()).pathname === '/quality/pendingInspect' &&
    await row.count() === 1 && pendingPageCellsMatch(cells, payload)
  const details = JSON.stringify({ route: page.url(), sourceBillNo: payload.sourceBillNo, cells })
  add(caseRecord, `${payload.sourceScene} 页面目标行逐格显示方案版本/样本量/检验员/期限`, passed, details)
  await helpers.saveScreenshot(page, outputDir, `quality-pending-${payload.sourceScene.toLowerCase()}`, record)
  if (!passed) throw new Error('待检页面目标行真实字段值不匹配')
  return { passed, details }
}

export async function exerciseQualityPendingSource ({
  api, page, record, caseRecord, outputDir, prepared, inspectorId, helpers,
  readSql = runReadOnlySql
}) {
  const { source, plan, sourceScene, qcType, sourceBillType, sourceBillId, sourceEntryId, marker } = prepared
  const ledger = { ...createOwnershipLedger(), sourceId: sourceBillId, sourceEntryId,
    sourceBillType, sourceScene, qcType, marker, sourceCreatedByCase: true }
  const evidence = { sourceScene, qcType, sourceBillId, sourceEntryId,
    sourceBillNo: prepared.sourceBillNo, planId: plan.id, planVersion: plan.version,
    chainVerified: false, cleanupVerified: false }
  caseRecord.sourceSceneEvidence.push(evidence)
  const payload = {
    qcType, sourceScene, sourceBillType, sourceBillId, sourceEntryId,
    sourceBillNo: prepared.sourceBillNo, sourceEntryNo: String(source.entry.entryNo || 1),
    materialId: source.materialId, materialCode: source.entry.materialCode,
    materialName: source.entry.materialName, unitId: source.entry.unitId,
    warehouseId: source.entry.warehouseId, batchNo: source.entry.batchNo,
    customerId: source.detail.customerId,
    workId: prepared.context?.workId, processId: prepared.context?.processId,
    pendingQty: source.pendingQty, inspectionPlanId: plan.id, inspectionPlanCode: plan.code,
    inspectionPlanVersion: plan.version, samplingType: 'FIXED', sampleQty: 1,
    assignedInspectorUserId: inspectorId,
    dueTime: new Date(Date.now() + 86400000).toISOString().slice(0, 19),
    remark: `${marker} ${QUALITY_PENDING_CASE_ID}`
  }
  const bySource = async () => rowsOf(await api.getBusiness(
    `/mes/quality/pending-inspect/list-by-source?sourceBillType=${encodeURIComponent(sourceBillType)}&sourceBillId=${sourceBillId}`
  ))
  const get = async () => dataOf(await api.getBusiness(
    `/mes/quality/pending-inspect/get?id=${ledger.pendingId}`
  ))
  let cancelled = false
  try {
    if ((await bySource()).length !== 0) throw new Error('BLOCKED: 扩展来源已有历史待检，不复活或累加共享数据')
    ledger.pendingId = pendingSourceId(dataOf(assertBusinessSuccess(
      await api.postBusiness('/mes/quality/pending-inspect/register', payload), '扩展来源登记'
    )))
    evidence.pendingId = ledger.pendingId
    const first = await get()
    evidence.snapshotVerified = pendingSnapshotMatches(first, payload, { pendingId: ledger.pendingId })
    evidence.chainVerified = evidence.snapshotVerified
    add(caseRecord, `${sourceScene} 真实来源登记及方案快照回读`, evidence.snapshotVerified,
      JSON.stringify({ pendingId: ledger.pendingId, first }))
    if (!evidence.snapshotVerified) throw new Error(`${sourceScene} 来源/快照回读不匹配`)
    const duplicateId = pendingSourceId(dataOf(await api.postBusiness('/mes/quality/pending-inspect/register', payload)))
    const duplicate = await get()
    const rows = await bySource()
    evidence.idempotentVerified = duplicateId === ledger.pendingId && rows.length === 1 &&
      String(rows[0].id) === ledger.pendingId &&
      pendingSnapshotMatches(duplicate, payload, { pendingId: ledger.pendingId, pendingQty: source.pendingQty * 2 })
    evidence.duplicateDetails = `first=${ledger.pendingId}; duplicate=${duplicateId}; rows=${rows.length}; pendingQty=${duplicate.pendingQty}`
    add(caseRecord, `${sourceScene} 重复登记同一来源键只累加一条记录`, evidence.idempotentVerified, evidence.duplicateDetails)
    if (!evidence.idempotentVerified) throw new Error(`${sourceScene} 幂等累加失败`)
    await expectRejected(api, { ...payload, sampleQty: source.pendingQty + 1 },
      ERROR_CODES.SAMPLE_QTY_INVALID, `${sourceScene} 样本量负例`)
    const mismatched = qcType === 'IPQC' ? 'SALES_OUTBOUND' : 'PROCESS_INSPECTION'
    await expectRejected(api, { ...payload, sourceScene: mismatched },
      ERROR_CODES.SOURCE_UNSUPPORTED, `${sourceScene} 场景负例`)
    evidence.validationVerified = isDeepStrictEqual(await get(), duplicate) &&
      isDeepStrictEqual(await bySource(), rows)
    evidence.validationDetails = 'sampleQtyCode=2010920008; sourceSceneCode=2010920007; negativeReadbackUnchanged=' + evidence.validationVerified
    add(caseRecord, `${sourceScene} 正式错误码负例且来源记录及数量无副作用`,
      evidence.validationVerified, evidence.validationDetails)
    if (!evidence.validationVerified) throw new Error(`${sourceScene} 负例改变了来源记录`)
    const pageEvidence = await verifyQualityPendingPage({
      page, record, caseRecord, outputDir, payload, helpers
    })
    evidence.pageVerified = pageEvidence.passed
    evidence.pageDetails = pageEvidence.details
    await cancelOwnedPending(api, ledger, 'QUALITY-PENDING-001 reverse')
    cancelled = true
    const after = await bySource()
    const snapshot = await readSql(`
      SELECT id, status, qc_type, source_scene, source_bill_type, source_bill_id,
        source_entry_id, inspection_plan_id, inspection_plan_version, assigned_inspector_user_id,
        sampling_type, sample_qty, pending_qty, cancel_reason
      FROM mes_quality_pending_inspect WHERE tenant_id=1 AND deleted=0 AND id='${ledger.pendingId}'
    `)
    caseRecord.database ||= []
    caseRecord.database.push({ stage: `quality-pending-${sourceScene.toLowerCase()}-cancelled`, ...snapshot })
    const expected = [ledger.pendingId, 'CANCELLED', qcType, sourceScene, sourceBillType,
      sourceBillId, sourceEntryId, plan.id, String(plan.version), inspectorId, 'FIXED']
    const dbRow = snapshot.rows?.[0]
    evidence.cleanupVerified = after.length === 1 && String(after[0].id) === ledger.pendingId &&
      after[0].status === 'CANCELLED' && snapshot.available && snapshot.rows?.length === 1 &&
      expected.every((value, index) => dbRow[index] === value) &&
      Number(dbRow[11]) === 1 && Number(dbRow[12]) === source.pendingQty * 2 &&
      dbRow[13] === 'QUALITY-PENDING-001 reverse'
    add(caseRecord, `${sourceScene} 取消后API及只读DB确认幂等来源审计保留`,
      evidence.cleanupVerified, JSON.stringify(snapshot.rows))
    if (!evidence.cleanupVerified) throw new Error(`${sourceScene} 取消清理回读失败`)
    caseRecord.evidence.push(`${sourceScene} pending=${ledger.pendingId} 已正式取消，来源审计保留`)
    return evidence
  } finally {
    if (ledger.pendingId && !cancelled) {
      await cancelOwnedPending(api, ledger, 'QUALITY-PENDING-001 failure cleanup')
    }
  }
}

export async function runAdditionalPendingSources (args) {
  if (process.env.CFOR_QUALITY_PENDING_PREPARE_ADDITIONAL !== 'true') {
    throw new Error('BLOCKED: 扩展生产/销售来源涉及库存写侧，需单独授权并开启 PREPARE_ADDITIONAL=true')
  }
  const { api, access, caseRecord, helpers } = args
  const productionOwned = {}
  let production = []
  try {
    try {
      production = await helpers.prepareQualityPendingProductionSources({
        ...args, owned: productionOwned
      })
    } catch (error) {
      caseRecord.sourceSceneGaps.PRODUCTION_INBOUND = error.message
      if (productionOwned.process) production = [productionOwned.process]
      else caseRecord.sourceSceneGaps.PROCESS_INSPECTION = error.message
      caseRecord.notes.push(`生产专属来源未完整准备：${error.message}`)
    }
    for (const prepared of production) {
      await exerciseQualityPendingSource({ ...args, prepared })
      if (prepared.sourceBillType === 'MesStkIo') await readPendingWmsDraft(api, prepared.context)
      else {
        const report = dataOf(await api.getBusiness(`/mes/prodWorkReport/queryById?id=${prepared.sourceBillId}`))
        if (String(report.id) !== prepared.sourceBillId || report.remark !== prepared.marker ||
            Number(report.isEffective) !== 0) throw new Error('过程检取消后真实报工来源审计回读失败')
      }
    }
  } finally {
    const fixture = productionOwned.fixture
    if (fixture) {
      caseRecord.notes.push(`生产专属资源保留审计（仅已取消pending引用的来源，不宣称工单已完成）：${JSON.stringify(fixture.fixtureRecord)}`)
    }
    if (fixture?.opening) {
      const cleaned = await fixture.cleanupResource(fixture.opening, caseRecord)
      if (!cleaned) throw new Error('专属生产组件期初库存正式反向未完成')
    }
    if (fixture?.material?.id) {
      const componentQuery = fixture.component?.id && fixture.warehouse?.id ? `
        SELECT qty, available_qty, lock_qty, hold_qty, frozen_qty, pending_putaway_qty
        FROM mes_stk_inventory WHERE tenant_id=1 AND deleted=0
          AND material_id='${pendingSourceId(fixture.component.id)}'
          AND warehouse_id='${pendingSourceId(fixture.warehouse.id)}'
      ` : ''
      const snapshot = await runReadOnlySql(`
        SELECT COUNT(*) FROM mes_stk_inventory WHERE tenant_id=1 AND deleted=0
          AND material_id='${pendingSourceId(fixture.material.id)}';
        ${componentQuery}
      `)
      caseRecord.database ||= []
      caseRecord.database.push({ stage: 'quality-pending-production-cleanup-stock', ...snapshot })
      const noStock = snapshot.available && snapshot.rows?.[0]?.[0] === '0' &&
        snapshot.rows.slice(1).every(row => row.length === 6 && row.every(value => Number(value) === 0))
      add(caseRecord, '生产待检未提前执行成品库存，专属组件期初反向后分量为零',
        noStock, JSON.stringify(snapshot.rows))
      if (!noStock) throw new Error('生产待检来源出现成品库存或组件反向后非零分量')
    }
  }
  const salesOwned = {}
  try {
    let prepared
    try {
      prepared = await helpers.prepareQualityPendingSalesSource({
        api, caseRecord, access, owned: salesOwned
      })
    } catch (error) {
      caseRecord.sourceSceneGaps.SALES_OUTBOUND = error.message
      caseRecord.notes.push(`销售专属来源未完整准备：${error.message}`)
    }
    if (prepared) await exerciseQualityPendingSource({ ...args, prepared })
  } finally {
    await helpers.cleanupQualityPendingSalesSource({ api, caseRecord, owned: salesOwned })
  }
}

export const runQualityPendingClosure = async ({
  page, record, caseRecord, outputDir, dependencies = {}
}) => {
  const helpers = {
    requireOptIn, login, createApiClient, verifyPendingAccess,
    prepareQualityPendingIqcSource, loadQualityPendingIqcSource,
    prepareQualityPendingProductionSources, prepareQualityPendingSalesSource,
    cleanupQualityPendingSalesSource, runAdditionalPendingSources,
    openRoute, saveScreenshot, verifyPendingDatabase, verifyOwnedPendingCleanup, ...dependencies
  }
  await helpers.requireOptIn(caseRecord)
  caseRecord.sourceSceneEvidence = []
  caseRecord.sourceSceneGaps = { ...QUALITY_PENDING_SOURCE_GAPS }
  const ledger = createOwnershipLedger()
  let api
  let cancelled = false
  let failure = null
  try {
    const token = await helpers.login(page)
    api = helpers.createApiClient({ token, record })
    const access = await helpers.verifyPendingAccess(api, caseRecord, [
      ...QUALITY_PENDING_PERMISSIONS,
      ...IQC_SOURCE_PERMISSIONS
    ])
    const inspectorId = access.userId
    if (isNonEmpty(process.env.CFOR_QUALITY_PENDING_INSPECTOR_ID) &&
        process.env.CFOR_QUALITY_PENDING_INSPECTOR_ID !== inspectorId) {
      throw new Error('BLOCKED: 检验员必须是本次正式登录用户，禁止环境变量冒充其他用户')
    }
    const prepared = process.env.CFOR_QUALITY_PENDING_PREPARE_IQC === 'true'
      ? await helpers.prepareQualityPendingIqcSource({
        api,
        caseRecord,
        ledger,
        access,
        settings: config,
        record
      })
      : await helpers.loadQualityPendingIqcSource(api, ledger)
    const createdSourceId = ledger.sourceId
    const { source, plan, marker } = prepared
    const scene = resolveWmsScene(source.detail)
    const sampleQty = numeric(
      process.env.CFOR_QUALITY_PENDING_SAMPLE_QTY || Math.min(source.pendingQty, 1),
      '抽检样本量'
    )
    if (sampleQty > source.pendingQty) throw new Error('BLOCKED: 配置的抽检样本量超过来源数量')
    const dueTime =
      process.env.CFOR_QUALITY_PENDING_DUE_TIME ||
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19)
    const payload = {
      qcType: scene.qcType,
      sourceScene: scene.sourceScene,
      sourceBillType: 'MesStkIo',
      sourceBillId: ledger.sourceId,
      sourceBillNo: source.detail.billNo,
      sourceEntryId: ledger.sourceEntryId,
      sourceEntryNo: String(source.entry.entryNo),
      materialId: source.materialId,
      materialCode: source.entry.materialCode,
      materialName: source.entry.materialName,
      spec: source.entry.spec,
      unitId: source.entry.unitId,
      batchNo: source.entry.batchNo,
      snNo: source.entry.snNo,
      warehouseId: source.entry.warehouseId,
      supplierId: source.detail.supplierId,
      customerId: source.detail.customerId,
      pendingQty: source.pendingQty,
      inspectionPlanId: plan.id,
      inspectionPlanCode: plan.code,
      inspectionPlanVersion: plan.version,
      samplingType: 'FIXED',
      sampleQty,
      assignedInspectorUserId: inspectorId,
      dueTime,
      remark: `${marker} ${QUALITY_PENDING_CASE_ID}`
    }

    const existing = rowsOf(await api.getBusiness(
      `/mes/quality/pending-inspect/list-by-source?sourceBillType=MesStkIo&sourceBillId=${encodeURIComponent(ledger.sourceId)}`
    ))
    if (existing.length > 0) {
      throw new Error('BLOCKED: 专属 WMS 来源已有待检记录，拒绝复用以避免重复累加历史数据')
    }

    const first = assertBusinessSuccess(
      await api.post('/mes/quality/pending-inspect/register', payload),
      'pending register'
    )
    ledger.pendingId = pendingSourceId(dataOf(first), '待检任务 ID')
    add(
      caseRecord,
      '专属真实 WMS 来源、真实方案和指定检验员均已证明',
      true,
      `source=${ledger.sourceId}/${ledger.sourceEntryId}, plan=${plan.id}, inspector=${inspectorId}`
    )

    const afterFirst = dataOf(await api.getBusiness(
      `/mes/quality/pending-inspect/get?id=${encodeURIComponent(ledger.pendingId)}`
    ))
    const snapshotVerified = add(
      caseRecord,
      '登记后回读保存来源/方案/抽检/期限/检验员快照',
      pendingSnapshotMatches(afterFirst, payload, { pendingId: ledger.pendingId }),
      `status=${afterFirst?.status}, pendingQty=${afterFirst?.pendingQty}`
    )

    const duplicate = assertBusinessSuccess(
      await api.post('/mes/quality/pending-inspect/register', payload),
      'pending duplicate register'
    )
    const duplicateId = pendingSourceId(dataOf(duplicate), '重复登记返回 ID')
    add(
      caseRecord,
      '重复登记复用同一来源键并按正式语义累加数量',
      duplicateId === ledger.pendingId,
      `first=${ledger.pendingId}; duplicate=${duplicateId}; increment=${source.pendingQty}`
    )
    const afterDuplicate = dataOf(await api.getBusiness(
      `/mes/quality/pending-inspect/get?id=${encodeURIComponent(ledger.pendingId)}`
    ))
    const duplicateRows = rowsOf(await api.getBusiness(
      `/mes/quality/pending-inspect/list-by-source?sourceBillType=MesStkIo&sourceBillId=${encodeURIComponent(ledger.sourceId)}`
    ))
    const idempotentVerified = add(
      caseRecord,
      '重复登记只保留一条幂等记录且待检数量按增量累加',
      duplicateId === ledger.pendingId && duplicateRows.length === 1 &&
        String(duplicateRows[0]?.id) === ledger.pendingId &&
        Number(afterDuplicate?.pendingQty) === Number(source.pendingQty) * 2,
      `rows=${duplicateRows.length}; before=${source.pendingQty}; after=${afterDuplicate?.pendingQty}`
    )

    const invalidSample = await expectRejected(
      api,
      { ...payload, sampleQty: 999999999 },
      ERROR_CODES.SAMPLE_QTY_INVALID,
      '非法样本量'
    )
    const sampleQtyVerified = add(caseRecord, '非法样本量保持正式错误码拒绝', true,
      `code=${ERROR_CODES.SAMPLE_QTY_INVALID}`)
    const mismatchedScene = scene.sourceScene === 'PURCHASE_INBOUND'
      ? 'SALES_OUTBOUND'
      : 'PURCHASE_INBOUND'
    const invalidScene = await expectRejected(
      api,
      { ...payload, sourceScene: mismatchedScene },
      ERROR_CODES.SOURCE_UNSUPPORTED,
      '场景类型不匹配'
    )
    const sourceSceneVerified = add(caseRecord, '场景类型与 qcType 不匹配保持正式错误码拒绝', true,
      `code=${ERROR_CODES.SOURCE_UNSUPPORTED}`)
    const negativeAfter = dataOf(await api.getBusiness(
      `/mes/quality/pending-inspect/get?id=${ledger.pendingId}`
    ))
    const negativeRows = rowsOf(await api.getBusiness(
      `/mes/quality/pending-inspect/list-by-source?sourceBillType=MesStkIo&sourceBillId=${ledger.sourceId}`
    ))
    const negativeUnchanged = add(caseRecord, 'IQC 两项负例均未改变数量/方案/来源审计',
      isDeepStrictEqual(negativeAfter, afterDuplicate) && isDeepStrictEqual(negativeRows, duplicateRows),
      `pending=${ledger.pendingId}; qty=${negativeAfter?.pendingQty}; rows=${negativeRows.length}`)
    const sourceBillNo = String(source.detail.billNo || '')
    const pageEvidence = await verifyQualityPendingPage({
      page, record, caseRecord, outputDir, payload, helpers
    })
    const pageVerified = pageEvidence.passed

    const afterCancel = await cancelOwnedPending(api, ledger, 'QUALITY-PENDING-001 reverse')
    cancelled = true
    const bySourceAfterCancel = rowsOf(await api.getBusiness(
      `/mes/quality/pending-inspect/list-by-source?sourceBillType=MesStkIo&sourceBillId=${encodeURIComponent(ledger.sourceId)}`
    ))
    const sourceAfterCancel = dataOf(await api.getBusiness(
      `/mes/stkIo/queryById/dictText?id=${encodeURIComponent(ledger.sourceId)}`
    ))
    add(
      caseRecord,
      '取消只终止待检任务并保留专属来源审计',
      afterCancel?.status === 'CANCELLED' &&
        afterCancel?.cancelReason === 'QUALITY-PENDING-001 reverse' &&
        afterCancel?.sourceBillId === ledger.sourceId &&
        afterCancel?.sourceEntryId === ledger.sourceEntryId &&
        bySourceAfterCancel.length === 1 &&
        String(bySourceAfterCancel[0]?.id) === ledger.pendingId &&
        bySourceAfterCancel[0]?.status === 'CANCELLED' &&
        String(sourceAfterCancel?.id) === ledger.sourceId,
      `source=${ledger.sourceId}/${ledger.sourceEntryId}, status=${afterCancel?.status}, reason=${afterCancel?.cancelReason}`
    )
    await helpers.verifyPendingDatabase({ ledger, source, plan, inspectorId, caseRecord })
    await helpers.verifyOwnedPendingCleanup({
      api,
      ledger,
      context: prepared.context,
      caseRecord
    })
    ledger.cleanup.push(
      `已取消待检任务 ${ledger.pendingId} 并完成专属采购/ASN/101来源回读；来源保留作审计`
    )
    caseRecord.sourceSceneEvidence.push({
      sourceScene: 'PURCHASE_INBOUND', qcType: 'IQC',
      chainVerified: snapshotVerified,
      idempotentVerified,
      snapshotVerified,
      validationVerified: sampleQtyVerified && sourceSceneVerified &&
        invalidSample?.code === ERROR_CODES.SAMPLE_QTY_INVALID &&
        invalidScene?.code === ERROR_CODES.SOURCE_UNSUPPORTED && negativeUnchanged,
      pageVerified,
      cleanupVerified: true,
      pendingId: ledger.pendingId,
      sourceBillId: ledger.sourceId,
      sourceEntryId: ledger.sourceEntryId,
      sourceBillNo,
      planId: plan.id,
      planVersion: plan.version,
      duplicateDetails: `first=${ledger.pendingId}; duplicate=${duplicateId}; rows=${duplicateRows.length}; pendingQty=${afterDuplicate?.pendingQty}`,
      validationDetails: `sampleQtyCode=${invalidSample?.code}; sourceSceneCode=${invalidScene?.code}; negativeReadbackUnchanged=${negativeUnchanged}`,
      pageDetails: pageEvidence.details
    })
    if (process.env.CFOR_QUALITY_PENDING_PREPARE_IQC === 'true' &&
        process.env.CFOR_QUALITY_PENDING_PREPARE_ADDITIONAL === 'true') {
      await helpers.runAdditionalPendingSources({
        api, page, record, caseRecord, outputDir, inspectorId, access, helpers
      })
    } else {
      caseRecord.notes.push('本轮仅授权 IQC 采购→ASN→101草稿，不执行生产/销售来源或库存写侧；其余来源仍为 PARTIAL。')
    }
    caseRecord.evidence.push(
      '正式 super_admin 身份、专属101采购→ASN→WMS草稿来源、真实方案映射、登记/重复累加/负例/页面/取消审计闭包；未覆盖来源按 catalog 原断言保持 GAP'
    )
    return { token, api, ledger, source, plan, inspectorId, createdSourceId, partial: true,
      note: '原catalog缺口见catalogAssertions/remainingAssertions/sourceSceneGaps', prepared }
  } catch (error) {
    failure = error
    recordOwnershipFailure(ledger, error)
    caseRecord.notes.push(`所有权记录：${JSON.stringify(ledger)}`)
    throw error
  } finally {
    if (api && ledger.pendingId && !cancelled) {
      try {
        await cancelOwnedPending(api, ledger, 'QUALITY-PENDING-001 failure cleanup')
        ledger.cleanup.push(`已取消待检任务 ${ledger.pendingId}；来源 ${ledger.sourceId || '(unknown)'} 保留`)
      } catch (cleanupError) {
        recordOwnershipFailure(ledger, cleanupError)
        add(
          caseRecord,
          '失败后待检任务由正式 cancel 接口清理',
          false,
          cleanupError.message || String(cleanupError)
        )
        if (!failure) throw cleanupError
      }
    }
    recordQualityPendingCatalogEvidence(caseRecord, { sceneEvidence: caseRecord.sourceSceneEvidence })
    caseRecord.notes.push(`最终所有权记录：${JSON.stringify(ledger)}`)
  }
}

export default runQualityPendingClosure
