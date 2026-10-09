import { asList, isBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import {
  buildQualifiedInspectionPayload,
  createDedicatedOutsourceQuality,
  isOutsourceInboundSourceBillType,
  requiresOutsourceInspectionSubmit
} from '../fixtures/mes-outsource-quality.mjs'
import { ensureAcceptanceNumbering } from '../fixtures/acceptance-numbering.mjs'
import {
  assertOutsourceFixtureScope,
  createOutsourceDraft,
  driveOutsourceLifecycle,
  ensureOutsourceApprovalOption,
  ensureOutsourceReceiptApprovalOption,
  ensureServiceMaterial,
  isStableOutsourceId,
  newOutsourceMarker,
  queryOutsourceActionLogs,
  queryOutsourceDetail,
  queryPriceAdjustments
} from '../fixtures/mes-outsource-write.mjs'
import { runOutsourceFinanceClosure } from '../fixtures/mes-outsource-finance.mjs'

export const cases = [
  'PB147-OUTSOURCE-001',
  'PB148-OUTSOURCE-001',
  'PB149-OUTSOURCE-WIP-001',
  'PB151-OUTSOURCE-RECEIPT-QUALITY-001',
  'PB152-OUTSOURCE-NG-HANDLING-001',
  'PB153-OUTSOURCE-MATERIAL-001',
  'PB154-OUTSOURCE-PAYABLE-001',
  'PB155-OUTSOURCE-INVOICE-001',
  'PB156-OUTSOURCE-PAYMENT-001',
  'PB157-OUTSOURCE-CLOSE-001'
]

const payloadData = (payload) => payload?.data ?? payload

export const outsourceRoute = '/mes/produce/outsource/outsource-work'
export const outsourceReadySelector = 'button:has-text("新增")'
export const paymentRequestRoute = '/mes/produce/outsource/payment-request'
export const paymentRequestReadySelector = 'button:has-text("新增")'
export const paymentSourceReadySelector = 'button:has-text("选委外应付")'

export const hasOutsourceBusinessFixture = (rows) =>
  Array.isArray(rows) && rows.some((row) => row?.id)
export const hasOutsourcePaymentFixture = (rows) =>
  Array.isArray(rows) && rows.some((row) =>
    row?.entryId && Number.isFinite(Number(row.uncheckedAmt)) && Number(row.uncheckedAmt) !== 0
  )

export const outsourceListRows = (response) => {
  const data = response?.data ?? response
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.records)) return data.records
  if (Array.isArray(data?.list)) return data.list
  throw new Error('委外查询必须返回数组、data.records 或 data.list，不能将无效响应当作空前置')
}

const businessError = (response) => ({
  code: response?.code,
  message: response?.msg ?? response?.message ?? ''
})

// 委外生命周期动作成功码在平台内既有 0 也有 200，两种都视为业务成功。
const isOk = (response) => Number(response?.code) === 0 || Number(response?.code) === 200

// 统一等待 ElementPlus 加载遮罩全部隐藏；避免同一时刻 enter/leave 两个遮罩触发 strict mode。
const waitForLoadingMasksHidden = (page, timeout = 30000) => page.waitForFunction(
  () => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
    }
    return ![...document.querySelectorAll('.el-loading-mask')].some(isVisible)
  },
  undefined,
  { timeout }
)

export const releasedLifecycleRejections = Object.freeze({
  close: Object.freeze({
    code: 500,
    message: '只有已完成的委外单可以关闭：已下达',
    allowServiceCode: true
  }),
  reopen: Object.freeze({
    code: 500,
    message: '只有已关闭的委外单可以重开：已下达',
    allowServiceCode: true
  })
})

const lifecycleSnapshot = (row) => Object.fromEntries([
  'id', 'outsourceStatus', 'statusVersion', 'isClosed', 'isEffective',
  'planQty', 'sendQty', 'inQty', 'settledQty', 'totalAmount'
].map((field) => [field, row?.[field] ?? null]))

const actionSnapshot = (rows) => rows.map((row) => Object.fromEntries([
  'id', 'outsourceId', 'actionType', 'fromStatus', 'toStatus',
  'operatorId', 'operateTime', 'remark'
].map((field) => [field, row?.[field] ?? null])))
  .sort((left, right) => String(left.id).localeCompare(String(right.id)))

export async function verifyReleasedLifecycleGuards (api, id, baseline, baselineLogs) {
  if (String(baseline?.id) !== String(id) || baseline?.outsourceStatus !== 'RELEASED' ||
      baseline?.statusVersion === undefined || !baselineLogs.length ||
      baselineLogs.some((row) => String(row.outsourceId) !== String(id))) {
    throw new Error('委外关闭负例必须使用已回读归属、版本和审计的专属下达单')
  }
  const checks = []
  const responses = {}
  for (const action of ['close', 'reopen']) {
    const expected = releasedLifecycleRejections[action]
    const response = await api.put(
      `/mes/prodOutsource/${action}?id=${encodeURIComponent(id)}&remark=${encodeURIComponent('E2E 下达单生命周期门禁')}`,
      undefined,
      { expectedBusinessRejection: expected }
    )
    const after = await queryOutsourceDetail(api, id)
    const afterLogs = await queryOutsourceActionLogs(api, id)
    checks.push({
      name: action === 'close'
        ? '未完成委外单按精确领域契约拒绝关闭且事实不变'
        : '非关闭委外单按精确领域契约拒绝重开且事实不变',
      passed: matchesExpectedBusinessRejection(response, expected) &&
        JSON.stringify(lifecycleSnapshot(after)) === JSON.stringify(lifecycleSnapshot(baseline)) &&
        JSON.stringify(actionSnapshot(afterLogs)) === JSON.stringify(actionSnapshot(baselineLogs)),
      details: JSON.stringify({
        rejection: businessError(response),
        before: lifecycleSnapshot(baseline),
        after: lifecycleSnapshot(after),
        auditBefore: baselineLogs.length,
        auditAfter: afterLogs.length
      })
    })
    responses[action] = response
  }
  return { checks, responses }
}

const openOutsourceList = async (page) => {
  await openRoute(page, outsourceRoute, { readySelector: outsourceReadySelector })
  await page.getByPlaceholder('请输入委外单号', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.vxe-header--column').filter({ hasText: '总金额' }).first().waitFor({ state: 'visible' })
  await page.locator('.vxe-loading:visible').waitFor({ state: 'hidden' })
}

const openPaymentRequest = async (page) => {
  await openRoute(page, paymentRequestRoute, { readySelector: paymentRequestReadySelector })
  await page.getByPlaceholder('请输入付款单号', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.vxe-loading:visible').waitFor({ state: 'hidden' })
}

export const wipCatalogAssertions = Object.freeze([
  '委外在制查询返回物料、批次/SN、仓库/库区/库位、已发料、已退料、已消耗和在制余额',
  '委外详情提供供应商在制只读页签',
  '查询只读，不直接修改库存或在制余额'
])

export function verifyDedicatedWip (rows, prerequisite) {
  if (!Array.isArray(rows) || rows.length !== 1 || !prerequisite) return false
  const row = rows[0]
  const expected = {
    materialId: prerequisite.component.id,
    unitId: prerequisite.unitId,
    batchNo: prerequisite.opening.batchNo,
    warehouseId: prerequisite.storage.warehouse.id,
    wareAreaId: prerequisite.storage.area.id,
    wareLocationId: prerequisite.storage.location.id
  }
  return Object.entries(expected).every(([field, value]) =>
    row[field] !== undefined && row[field] !== null && String(row[field]) === String(value)
  ) && Object.prototype.hasOwnProperty.call(row, 'snNo') &&
    ['issuedQty', 'returnedQty', 'consumedQty', 'balanceQty'].every((field) =>
      row[field] !== undefined && row[field] !== null && Number.isFinite(Number(row[field]))
    ) && Number(row.issuedQty) === 1 && Number(row.returnedQty) === 0 &&
    Number(row.consumedQty) === 0 && Number(row.balanceQty) === 1
}

export function recordWipAcceptance (caseRecord, evidence) {
  caseRecord.catalogAssertions = wipCatalogAssertions.map((assertion, index) => ({
    index,
    assertion,
    status: evidence[index]?.passed === true ? 'VERIFIED' : 'GAP',
    evidence: evidence[index]?.details || '尚无本轮真实证据'
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
}

async function readWipFacts (caseRecord, fixture, stage) {
  const ids = [
    fixture.draft.id, fixture.work.materialId, fixture.draft.prerequisite.component.id
  ]
  if (!ids.every(isStableOutsourceId)) throw new Error('委外只读快照缺少精确专属 ID')
  const snapshot = await runReadOnlySql(`
    SELECT 'inventory', id, material_id, warehouse_id, ware_area_id,
      COALESCE(ware_location_id, ''), COALESCE(batch_no, ''), qty, available_qty
    FROM mes_stk_inventory
    WHERE tenant_id=1 AND deleted=0
      AND material_id IN ('${ids[1]}','${ids[2]}') ORDER BY id;
    SELECT 'wip', id, outsource_id, material_id, warehouse_id, ware_area_id,
      COALESCE(ware_location_id, ''), COALESCE(batch_no, ''), movement_type,
      quantity, source_stock_io_id, source_entry_id, idempotency_key
    FROM mes_prod_outsource_wip_ledger
    WHERE tenant_id=1 AND deleted=0 AND outsource_id='${ids[0]}' ORDER BY id
  `)
  if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
  caseRecord.database ||= []
  caseRecord.database.push({ stage, ...snapshot })
  return snapshot.rows
}

async function openOwnedOutsourceDetail (page, fixture) {
  await openOutsourceList(page)
  await page.getByPlaceholder('请输入委外单号', { exact: true }).fill(fixture.draft.billNo)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const row = page.locator('.vxe-body--row').filter({ hasText: fixture.draft.billNo })
  await row.waitFor({ state: 'visible' })
  if (await row.count() !== 1) throw new Error('委外列表未唯一定位本轮专属单据')
  await row.getByRole('button', { name: fixture.draft.billNo, exact: true }).click()
  const dialog = page.locator('.el-dialog:visible').filter({ hasText: `${fixture.draft.billNo} - 详情` })
  await dialog.waitFor({ state: 'visible' })
  return dialog
}

async function openOwnedWipDetail (page, fixture) {
  const dialog = await openOwnedOutsourceDetail(page, fixture)
  await dialog.getByRole('tab', { name: '供应商在制', exact: true }).click()
  const panel = dialog.locator('.tab-panel:visible')
  await panel.locator('.el-table__row').waitFor({ state: 'visible' })
  await waitForLoadingMasksHidden(page)
  const rowTexts = await panel.locator('.el-table__row').allInnerTexts()
  const text = rowTexts.join('\n')
  const item = fixture.draft.prerequisite
  const cells = await panel.locator('.el-table__row').first().locator('td .cell').allInnerTexts()
  return {
    passed: rowTexts.length === 1 &&
      [item.component.code, item.storage.warehouse.name, item.storage.area.name]
        .every((name) => text.includes(name)) &&
      JSON.stringify(cells.slice(-4).map((value) => value.trim())) ===
        JSON.stringify(['1.00', '0.00', '0.00', '1.00']) &&
      await panel.locator('input,textarea,button').count() === 0,
    details: JSON.stringify({ billNo: fixture.draft.billNo, cells, readOnly: true })
  }
}

const pickWork = async (api) => {
  const rows = outsourceListRows(await api.getBusiness(
    '/mes/prodWork/list/dictText?pageNo=1&pageSize=100'
  ))
  const work = rows.find((row) => row?.id && row?.materialId && row?.unitId)
  if (!work) throw new Error('缺少只读引用工单，无法创建委外调价草稿')
  return { id: String(work.id), materialId: String(work.materialId), unitId: String(work.unitId) }
}

const pickSupplierId = async (api) => {
  const rows = asList(payloadData(
    await api.getBusiness('/erp/supplier/page?pageNo=1&pageSize=1')
  ))
  const supplier = rows.find((row) => row?.id)
  if (!supplier) throw new Error('缺少可用供应商，无法创建委外写侧夹具')
  return String(supplier.id)
}

const ensureStockApprovalOption = async (api, billType) => {
  const page = await api.getBusiness(
    `/mes/basBillOptions/list?pageNo=1&pageSize=100&billType=${encodeURIComponent(billType)}`
  )
  const rows = asList(payloadData(page))
  const match = rows.find((row) =>
    String(row.billType) === billType &&
    String(row.mbillApprovalType) === '1' &&
    String(row.abillApprovalType) === '1'
  )
  if (match?.id) return { created: false, id: String(match.id) }
  const created = await api.postBusiness('/mes/basBillOptions/add', {
    billType,
    mbillApprovalType: '1',
    abillApprovalType: '1',
    isAutoExecute: 0,
    isAutoEndExecute: 0,
    isAutoClose: 0
  })
  return { created: true, response: created }
}

const ensureOutsourceBankAccount = async (api, caseRecord, marker) => {
  const name = `${marker}-BANK`
  const page = await api.getBusiness(
    `/erp/account/page?pageNo=1&pageSize=100&no=${encodeURIComponent(name)}`
  )
  const rows = asList(payloadData(page))
  const existing = rows.find((row) => String(row.no) === name && row.id)
  if (existing?.id) return String(existing.id)
  const created = payloadData(await api.postBusiness('/erp/account/create', {
    name,
    no: name,
    accountType: 'BANK',
    currency: 'CNY',
    status: 0,
    sort: 999,
    remark: marker
  }))
  const id = String(created?.id ?? created ?? '')
  if (!/^\d+$/.test(id)) throw new Error(`专属银行账户创建未返回稳定 ID：${JSON.stringify(created)}`)
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({
    source: 'mes-outsource-finance',
    marker,
    kind: 'bank-account',
    id,
    identity: name,
    cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP'
  })
  return id
}

const readOwnedStockIo = async (api, id) => {
  const bill = payloadData(await api.getBusiness(
    `/mes/stkIo/queryById?id=${encodeURIComponent(id)}`
  ))
  const entries = outsourceListRows(await api.getBusiness(
    `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(id)}`
  ))
  if (!bill?.id || entries.length === 0) {
    throw new Error(`专属库存单据回读缺少主单或明细：${id}`)
  }
  return { bill, entries }
}

const submitAndCheckOwnedStockIo = async (api, id, expectedType, remark) => {
  let { bill, entries } = await readOwnedStockIo(api, id)
  await api.putBusiness('/mes/stkIo/edit/submit', {
    ...bill,
    stkIoEntryList: entries,
    stkIoDistributionList: [],
    stkIoBomList: []
  })
  await api.putBusiness('/mes/stkIo/check', {
    id: String(id),
    approvalResultType: '1',
    approvalRemark: remark
  })
  ;({ bill, entries } = await readOwnedStockIo(api, id))
  if (String(bill.billStage) === '24' || bill.actions?.execute === true) {
    await api.putBusiness('/mes/stkIo/execute', { id: String(id) })
    ;({ bill, entries } = await readOwnedStockIo(api, id))
  }
  if (String(bill.stockIoType) !== String(expectedType) ||
      String(bill.isEffective) !== '1' ||
      String(bill.isVoided || 0) === '1') {
    throw new Error(`专属库存单据审核后未生效：${JSON.stringify({
      id, expectedType, stockIoType: bill.stockIoType,
      isEffective: bill.isEffective, isVoided: bill.isVoided, billStage: bill.billStage
    })}`)
  }
  return { bill, entries }
}

/** 建立一个真实可写、可审核、可下达的委外专属夹具。 */
const buildReleasedOutsourceFixture = async (
  api, caseRecord, { marker = newOutsourceMarker(), planQty } = {}
) => {
  const approval = await ensureOutsourceApprovalOption(api)
  const fee = await ensureServiceMaterial(api, marker)
  const supplierId = await pickSupplierId(api)
  const draft = await createOutsourceDraft(api, {
    marker,
    caseRecord,
    dedicatedPrerequisite: true,
    supplierId,
    processFeeMaterialId: fee.id,
    ...(planQty === undefined ? {} : { planQty })
  })
  const work = {
    id: draft.prerequisite.work.id,
    materialId: draft.prerequisite.product.id,
    unitId: draft.prerequisite.unitId
  }
  const lifecycle = await driveOutsourceLifecycle(api, draft.id)
  caseRecord.evidence.push(
    `委外专属夹具 marker=${marker} orderId=${draft.id} billNo=${draft.billNo} ` +
    `feeMaterialId=${fee.id} approvalOptionCreated=${approval.created}`
  )
  return { marker, draft, fee, work, supplierId, approval, lifecycle }
}

const retainedOutsourceDocument = (caseRecord, fixture, kind, row) => {
  if (!isStableOutsourceId(row?.id)) throw new Error(`委外${kind}未返回安全专属 ID`)
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({
    source: 'mes-outsource-write',
    marker: fixture.marker,
    kind,
    id: String(row.id),
    identity: row.billNo,
    outsourceId: fixture.draft.id,
    cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP'
  })
}

async function completeOwnedReceipt (api, caseRecord, fixture, { qty = 1, secondMaterialOut = true } = {}) {
  const quality = await createDedicatedOutsourceQuality(api, caseRecord, fixture)
  const stock210Option = await ensureStockApprovalOption(api, 'MesStkIo:210')
  const materialOutId = String(payloadData(await api.putBusiness(
    `/mes/prodOutsource/generateMaterialOut?id=${encodeURIComponent(fixture.draft.id)}&qty=${qty}`
  )))
  if (!isStableOutsourceId(materialOutId)) {
    throw new Error(`委外收货前 210 发料未返回稳定单据 ID：${materialOutId}`)
  }
  const materialOut = await submitAndCheckOwnedStockIo(
    api, materialOutId, '210', 'E2E 委外收货前首次发料审核'
  )
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({
    source: 'mes-outsource-write',
    marker: fixture.marker,
    kind: 'materialOut210',
    id: materialOutId,
    identity: materialOut.bill.billNo,
    outsourceId: fixture.draft.id,
    cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP'
  })
  caseRecord.evidence.push(
    `委外收货前已完成 210 首次发料 id=${materialOutId} ` +
    `approvalOption=${stock210Option.created ? 'created' : 'existing'}`
  )
  const receiptApproval = await ensureOutsourceReceiptApprovalOption(api)
  await ensureAcceptanceNumbering(api, caseRecord, ['fin_cgap_bill_no'])
  caseRecord.evidence.push(
    `委外110收货审批策略 billType=${receiptApproval.billType} created=${receiptApproval.created}`
  )
  if (secondMaterialOut) {
    await api.putBusiness(
      `/mes/prodOutsource/generateMaterialOut?id=${encodeURIComponent(fixture.draft.id)}&qty=${qty}`
    )
  }
  const draft = payloadData(await api.getBusiness(
    `/mes/prodOutsource/buildInbound?id=${encodeURIComponent(fixture.draft.id)}&qty=${qty}`
  ))
  const lines = outsourceListRows(draft?.stkIoEntryList)
  caseRecord.checks.push({
    name: '委外 110 收货草稿保留专属来源且明细命中已发布 104 质检规则',
    passed: String(draft.stockIoType) === '110' && draft.srcBillType === 'MesProdOutsource' &&
      String(draft.srcBillId) === fixture.draft.id && lines.length === 1 &&
      String(lines[0].materialId) === fixture.work.materialId &&
      Number(lines[0].qty) === Number(qty) && Number(lines[0].isQc) === 1 &&
      Number(quality.plan.row.publishStatus) === 1 && String(quality.rule.row.type) === '104',
    details: JSON.stringify({
      draft: { billNo: draft.billNo, stockIoType: draft.stockIoType, srcBillId: draft.srcBillId },
      lines, planId: quality.plan.planId, ruleId: quality.rule.ruleId
    })
  })
  await api.postBusiness('/mes/stkIo/add/save', {
    ...draft,
    remark: fixture.marker,
    stkIoEntryList: lines,
    stkIoDistributionList: [],
    stkIoBomList: []
  })
  const receipts = outsourceListRows(await api.getBusiness(
    `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&billNo=${encodeURIComponent(draft.billNo)}` +
    `&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(fixture.draft.id)}&stockIoType=110`
  )).filter((row) => row.billNo === draft.billNo &&
    String(row.srcBillId) === fixture.draft.id && String(row.stockIoType) === '110')
  if (receipts.length !== 1) throw new Error('委外专属 110 草稿未唯一回读')
  const receipt = receipts[0]
  retainedOutsourceDocument(caseRecord, fixture, 'receipt110', receipt)
  const receiptEntries = outsourceListRows(await api.getBusiness(
    `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(receipt.id)}`
  ))
  const receiptDraft = payloadData(await api.getBusiness(
    `/mes/stkIo/queryById?id=${encodeURIComponent(receipt.id)}`
  ))
  await api.putBusiness('/mes/stkIo/edit/submit', {
    ...receiptDraft,
    stkIoEntryList: receiptEntries,
    stkIoDistributionList: [],
    stkIoBomList: []
  })
  const inspections = outsourceListRows(await api.getBusiness(
    `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100` +
    `&srcBillId=${encodeURIComponent(receipt.id)}&type=104`
  )).filter((row) => String(row.type) === '104' &&
    isOutsourceInboundSourceBillType(row.srcBillType) &&
    String(row.srcBillId) === String(receipt.id))
  if (receiptEntries.length !== 1 || inspections.length !== 1) {
    throw new Error('专属收货保存未形成唯一来源明细与 104 质检单')
  }
  const inspectionId = String(inspections[0].id)
  retainedOutsourceDocument(caseRecord, fixture, 'inspection104', inspections[0])
  const [inspection, entries, items] = await Promise.all([
    api.getBusiness(`/mes/quality/qualityInspection/queryById/dictText?id=${inspectionId}`),
    api.getBusiness(`/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${inspectionId}`),
    api.getBusiness(`/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${inspectionId}`)
  ])
  const detail = payloadData(inspection)
  const qualityEntries = outsourceListRows(entries)
  const qualityItems = outsourceListRows(items)
  if (String(detail.inspectionPlan) !== quality.plan.planId ||
      qualityEntries.length !== 1 ||
      String(qualityEntries[0].srcEntryId) !== String(receiptEntries[0].id) ||
      String(qualityEntries[0].materialId) !== fixture.work.materialId) {
    throw new Error('104 质检方案或收货明细归属不一致')
  }
  caseRecord.checks.push({
    name: '104 质检来源精确追溯到 MesStkIo 体系与本轮收货明细',
    passed: true,
    details: JSON.stringify({ receiptId: receipt.id, entryId: receiptEntries[0].id, inspectionId,
      inspectionPlan: detail.inspectionPlan, srcBillType: detail.srcBillType })
  })
  if (requiresOutsourceInspectionSubmit(detail, qualityEntries, qty)) {
    const body = buildQualifiedInspectionPayload(detail, qualityEntries, qualityItems, qty)
    await api.putBusiness('/mes/quality/qualityInspection/edit/submit', body)
  } else {
    caseRecord.evidence.push(`本轮生成104已自动完成，保留原结果且不重复提交 inspectionId=${inspectionId}`)
  }
  let qualified = payloadData(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${inspectionId}`
  ))
  if (Number(qualified.isEffective) !== 1) {
    await api.putBusiness('/mes/quality/qualityInspection/check', {
      id: inspectionId, approvalResultType: '1', approvalRemark: 'E2E 委外104合格审核'
    })
    qualified = payloadData(await api.getBusiness(
      `/mes/quality/qualityInspection/queryById/dictText?id=${inspectionId}`
    ))
  }
  const qualifiedEntries = outsourceListRows(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${inspectionId}`
  ))
  caseRecord.checks.push({
    name: '委外 104 质检真实合格生效，合格 1/让步 0/待判 0',
    passed: Number(qualified.isEffective) === 1 && String(qualified.billStage) === '34' &&
      qualifiedEntries.length === 1 && Number(qualifiedEntries[0].passQty) === Number(qty) &&
      Number(qualifiedEntries[0].concessionQty) === 0 && Number(qualifiedEntries[0].pendingJudgeQty) === 0,
    details: JSON.stringify({ inspectionId, isEffective: qualified.isEffective,
      billStage: qualified.billStage, entries: qualifiedEntries })
  })
  let effective = payloadData(await api.getBusiness(
    `/mes/stkIo/queryById?id=${encodeURIComponent(receipt.id)}`
  ))
  if (Number(effective.isEffective) !== 1) {
    await api.putBusiness('/mes/stkIo/check', {
      id: String(receipt.id), approvalResultType: '1', approvalRemark: 'E2E 委外收货审核'
    })
    effective = payloadData(await api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(receipt.id)}`
    ))
  }
  if (String(effective.billStage) === '24' || String(effective.billStage) === 'END_OF_AUDIT') {
    await api.putBusiness('/mes/stkIo/execute', { id: String(receipt.id) })
    effective = payloadData(await api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(receipt.id)}`
    ))
  }
  const outsource = await queryOutsourceDetail(api, fixture.draft.id)
  const wip = outsourceListRows(await api.getBusiness(
    `/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(fixture.draft.id)}`
  ))
  caseRecord.checks.push({
    name: '先检后入真实生效，委外完工 1 且供应商在制消耗 1/余额 0',
    passed: Number(effective.isEffective) === 1 && Number(effective.isVoided) === 0 &&
      Number(outsource.inQty) === Number(qty) && wip.length === 1 &&
      Number(wip[0].issuedQty) === Number(qty) && Number(wip[0].consumedQty) === Number(qty) &&
      Number(wip[0].balanceQty) === 0,
    details: JSON.stringify({ receipt: effective.id, inQty: outsource.inQty, wip })
  })
  return { draft, quality, receipt: effective, receiptEntries, inspection: qualified, entries: qualifiedEntries }
}

const runPb147 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const marker = newOutsourceMarker()
  const work = await pickWork(api)
  const supplierId = await pickSupplierId(api)
  const fee = await ensureServiceMaterial(api, marker)

  const listResponse = await api.getBusiness('/mes/prodOutsource/list/dictText?pageNo=1&pageSize=100')
  const listRows = outsourceListRows(listResponse)
  caseRecord.checks.push({
    name: '委外订单列表接口可读且分页不超过 100',
    passed: Array.isArray(listRows) && listRows.length <= 100,
    details: `rows=${listRows.length}`
  })

  const draft = await createOutsourceDraft(api, {
    marker,
    caseRecord,
    prodWorkId: work.id,
    materialId: work.materialId,
    unitId: work.unitId,
    supplierId,
    processFeeMaterialId: fee.id,
    processPrice: 5
  })
  const before = await queryOutsourceDetail(api, draft.id)

  const servicePage = await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&inventoryNature=SERVICE'
  )
  const serviceRows = outsourceListRows(servicePage)
  const nonServicePage = await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=1&inventoryNature=STOCK'
  )
  const nonServiceId = outsourceListRows(nonServicePage)[0]?.id
  caseRecord.checks.push({
    name: '加工费存货选择器只返回 inventoryNature=SERVICE 且包含专属服务类存货',
    passed:
      serviceRows.length > 0 &&
      serviceRows.every((row) => String(row.inventoryNature || '').toUpperCase() === 'SERVICE') &&
      serviceRows.some((row) => String(row.id) === fee.id) &&
      (!nonServiceId || !serviceRows.some((row) => String(row.id) === String(nonServiceId))),
    details: `serviceRows=${serviceRows.length} fee=${fee.id} nonService=${nonServiceId}`
  })

  const editReason = `${marker}-调价审计`
  const newPrice = 9
  const edit = await api.putBusiness('/mes/prodOutsource/edit', {
    id: draft.id,
    prodWorkId: work.id,
    materialId: work.materialId,
    unitId: work.unitId,
    supplierId,
    processFeeMaterialId: fee.id,
    planQty: 2,
    processPrice: newPrice,
    priceAdjustmentReason: editReason,
    items: [{
      entryNo: 1,
      prodWorkId: work.id,
      materialId: work.materialId,
      unitId: work.unitId,
      supplierId,
      processFeeMaterialId: fee.id,
      planQty: 2,
      processPrice: newPrice
    }]
  })
  const after = await queryOutsourceDetail(api, draft.id)
  const adjustments = await queryPriceAdjustments(api, draft.id)
  const adjustment = adjustments.find((row) =>
    String(row.outsourceId) === draft.id && String(row.adjustReason) === editReason
  )
  caseRecord.checks.push({
    name: '委外调价写侧生成可追溯价格调整审计记录',
    passed:
      isBusinessSuccess(edit) &&
      Number(before.processPrice) === 5 &&
      Number(after.processPrice) === newPrice &&
      Number(after.processAmount) === newPrice * 2 &&
      Boolean(adjustment) &&
      Number(adjustment.beforeProcessPrice) === Number(before.processPrice) &&
      Number(adjustment.afterProcessPrice) === newPrice &&
      Number(adjustment.beforeTotalAmount) === Number(before.totalAmount) &&
      Number(adjustment.afterTotalAmount) === Number(after.totalAmount) &&
      String(adjustment.operatorId) !== '' &&
      Boolean(adjustment.operateTime),
    details: JSON.stringify({
      before: { price: before.processPrice, total: before.totalAmount },
      after: { price: after.processPrice, total: after.totalAmount },
      adjustment: adjustment && {
        beforeProcessPrice: adjustment.beforeProcessPrice,
        afterProcessPrice: adjustment.afterProcessPrice,
        adjustReason: adjustment.adjustReason,
        operatorId: adjustment.operatorId,
        operateTime: adjustment.operateTime
      }
    })
  })

  const items = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/queryItemsByMainId?id=${encodeURIComponent(draft.id)}`)
  ))
  const snapshotFields = ['processAmount', 'materialAmount', 'giftLossQty', 'taxInclusive', 'currencyCode', 'taxRate']
  const itemSnapshotFields = ['processFeeMaterialId', ...snapshotFields]
  caseRecord.checks.push({
    name: '委外订单详情提供加工费/材料费/赠送损耗/含税/币种/税率快照',
    passed: snapshotFields.every((field) => Object.prototype.hasOwnProperty.call(after, field)),
    details: JSON.stringify(snapshotFields.filter((field) => Object.prototype.hasOwnProperty.call(after, field)))
  })
  caseRecord.checks.push({
    name: '委外明细提供服务存货和金额快照字段',
    passed: items.length > 0 && items.every((row) => itemSnapshotFields.every((field) => field in row)),
    details: `items=${items.length}`
  })

  const unauthenticated = createApiClient({ token: '', record })
  const noAuth = await unauthenticated.request('GET', `/mes/prodOutsource/queryById?id=${encodeURIComponent(draft.id)}`)
  const foreignTenant = createApiClient({ token, tenantId: '2', record })
  const crossTenant = await foreignTenant.request(
    'GET', `/mes/prodOutsource/queryPriceAdjustments?id=${encodeURIComponent(draft.id)}`
  )
  caseRecord.checks.push({
    name: '委外订单/调价审计未登录与跨租户访问被拒绝',
    passed: noAuth?.code === 401 && crossTenant?.code === 403,
    details: JSON.stringify({ noAuth: businessError(noAuth), crossTenant: businessError(crossTenant) })
  })

  const reRead = await queryPriceAdjustments(api, draft.id)
  const matched = reRead.filter((row) => String(row.adjustReason) === editReason)
  caseRecord.checks.push({
    name: '价格调整审计重复查询稳定且同一调价不重复落库',
    passed: matched.length === 1 && reRead.length === adjustments.length && String(matched[0].id) === String(adjustment.id),
    details: `adjustments=${reRead.length} matched=${matched.length} id=${matched[0]?.id}`
  })

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外列表真实渲染新增入口和总金额列',
    passed: page.url().includes(outsourceRoute) && hasAddButton && bodyText.includes('总金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb147-outsource-pricing', record)
  caseRecord.evidence.push(`价格调整写侧 orderId=${draft.id} feeMaterialId=${fee.id} adjustmentId=${adjustment?.id}`)
  return { token, api }
}

const runPb148 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const detail = await queryOutsourceDetail(api, fixture.draft.id)
  const lifecycleFields = ['outsourceStatus', 'statusVersion', 'releaseVersion', 'releaseNotifyStatus']
  caseRecord.checks.push({
    name: '委外详情返回十态生命周期与下达版本字段',
    passed: lifecycleFields.every((field) => Object.prototype.hasOwnProperty.call(detail, field)),
    details: JSON.stringify(lifecycleFields.filter((field) => Object.prototype.hasOwnProperty.call(detail, field)))
  })
  caseRecord.checks.push({
    name: '提交审批->审核->下达真实推进生命周期并累加版本',
    passed:
      String(detail.outsourceStatus) === 'RELEASED' &&
      Number(detail.releaseVersion) >= 1 &&
      Number(detail.statusVersion) >= 2 &&
      String(detail.releaseNotifyStatus) === 'PENDING',
    details: JSON.stringify({
      outsourceStatus: detail.outsourceStatus,
      statusVersion: detail.statusVersion,
      releaseVersion: detail.releaseVersion,
      releaseNotifyStatus: detail.releaseNotifyStatus
    })
  })

  const logs = await queryOutsourceActionLogs(api, fixture.draft.id)
  const codes = logs.map((row) => String(row.actionCode))
  const logFields = ['outsourceId', 'actionCode', 'fromStatus', 'toStatus', 'versionNo', 'operatorId', 'operateTime']
  caseRecord.checks.push({
    name: '生命周期动作审计记录创建/提交/审核/下达全链路',
    passed:
      Array.isArray(logs) &&
      logs.length >= 4 &&
      ['CREATE', 'SUBMIT_APPROVAL', 'APPROVE', 'RELEASE'].every((code) => codes.includes(code)) &&
      logs.every((row) => logFields.every((field) => field in row)) &&
      logs.every((row) => String(row.outsourceId) === fixture.draft.id),
    details: `logs=${logs.length} codes=${codes.join(',')}`
  })
  caseRecord.checks.push({
    name: '下达记录写入下达版本、通知状态与操作人',
    passed: (() => {
      const release = logs.find((row) => String(row.actionCode) === 'RELEASE')
      return Boolean(release) && Number(release.versionNo) >= 1 &&
        String(release.notifyStatus) === 'PENDING' && String(release.operatorId) !== ''
    })(),
    details: JSON.stringify(logs.find((row) => String(row.actionCode) === 'RELEASE') || {})
  })

  const noAuthLogs = await createApiClient({ token: '', record }).request(
    'GET', `/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(fixture.draft.id)}`
  )
  const crossTenantLogs = await createApiClient({ token, tenantId: '2', record }).request(
    'GET', `/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(fixture.draft.id)}`
  )
  caseRecord.checks.push({
    name: '生命周期审计未登录与跨租户访问被拒绝',
    passed: noAuthLogs?.code === 401 && crossTenantLogs?.code === 403,
    details: JSON.stringify({ noAuth: businessError(noAuthLogs), crossTenant: businessError(crossTenantLogs) })
  })

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外列表真实渲染单据查询和金额列',
    passed: page.url().includes(outsourceRoute) && hasAddButton && bodyText.includes('总金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb148-outsource-lifecycle', record)
  caseRecord.evidence.push(`生命周期写侧 orderId=${fixture.draft.id} billNo=${fixture.draft.billNo}`)
  return { token, api }
}

const runPb149 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const beforeIssue = await readWipFacts(caseRecord, fixture, 'pb149-before-issue')
  const materialOut = await api.putBusiness(
    `/mes/prodOutsource/generateMaterialOut?id=${encodeURIComponent(fixture.draft.id)}&qty=1`
  )
  // 当租户已配置 MesStkIo:210 审批策略时，generateMaterialOut 只生成草稿；
  // 必须显式提交审核后才能形成正式发料与在制 ISSUE 事实，避免跨用例状态污染导致漏测。
  const materialOutId = String(payloadData(materialOut))
  const materialOutRead = await readOwnedStockIo(api, materialOutId)
  if (String(materialOutRead.bill.isEffective) !== '1') {
    await submitAndCheckOwnedStockIo(api, materialOutId, '210', 'E2E 委外正式发料审核')
  }
  const afterIssue = await readWipFacts(caseRecord, fixture, 'pb149-after-issue')
  const beforeInventory = beforeIssue.filter((row) => row[0] === 'inventory')
  const afterInventory = afterIssue.filter((row) => row[0] === 'inventory')
  const issueEvents = afterIssue.filter((row) => row[0] === 'wip')
  caseRecord.checks.push({
    name: '专属委外正式发料库存 4→3 与在制 ISSUE 事件 1 守恒',
    passed: isBusinessSuccess(materialOut) && beforeInventory.length === 1 &&
      afterInventory.length === 1 && beforeInventory[0][1] === afterInventory[0][1] &&
      Number(beforeInventory[0][7]) === 4 && Number(beforeInventory[0][8]) === 4 &&
      Number(afterInventory[0][7]) === 3 && Number(afterInventory[0][8]) === 3 &&
      issueEvents.length === 1 && issueEvents[0][8] === 'ISSUE' && Number(issueEvents[0][9]) === 1 &&
      beforeIssue.every((row) => row[0] !== 'wip'),
    details: JSON.stringify({ beforeInventory, afterInventory, issueEvents })
  })
  const wipRows = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(fixture.draft.id)}`)
  ))
  const dimensions = {
    name: '供应商在制精确归属专属物料、实际库存维度且发退耗余为 1/0/0/1',
    passed: verifyDedicatedWip(wipRows, fixture.draft.prerequisite),
    details: JSON.stringify(wipRows)
  }
  caseRecord.checks.push(dimensions)
  const requestStart = record.api.length
  const detail = await openOwnedWipDetail(page, fixture)
  caseRecord.checks.push({
    name: '本轮专属委外详情供应商在制页签只读且展示真实发退耗余',
    ...detail
  })
  await saveScreenshot(page, outputDir, 'pb149-owned-wip-detail', record)
  const afterRead = await readWipFacts(caseRecord, fixture, 'pb149-after-readonly-detail')
  const unchanged = {
    name: '供应商在制 API 与详情查询不修改实物库存或在制事件',
    passed: JSON.stringify(afterRead) === JSON.stringify(afterIssue) &&
      record.api.slice(requestStart).every((request) => request.method === 'GET'),
    details: JSON.stringify({ before: afterIssue, after: afterRead })
  }
  caseRecord.checks.push(unchanged)
  recordWipAcceptance(caseRecord, [dimensions, detail, unchanged])
  caseRecord.evidence.push(`本轮专属发料与只读详情 orderId=${fixture.draft.id} billNo=${fixture.draft.billNo}`)
  const acceptanceComplete = caseRecord.remainingAssertions.length === 0
  return {
    token,
    api,
    acceptanceComplete,
    partial: !acceptanceComplete,
    note: acceptanceComplete
      ? '专属夹具正式发料，库存 4→3、在制 ISSUE 守恒、库区库位与发退耗余均逐条核验通过。'
      : '原三条断言已逐条记录；专属夹具正式发料，保留库存/在制审计，不冒充已清理。'
  }
}

const runPb151 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const flow = await completeOwnedReceipt(api, caseRecord, fixture)
  const dialog = await openOwnedOutsourceDetail(page, fixture)
  await dialog.getByRole('tab', { name: '来源工单', exact: true }).click()
  const receiptAction = dialog.getByRole('button', { name: '快速入库', exact: true })
  const receiptActionVisible = await receiptAction.isVisible()
  const receiptActionEnabled = receiptActionVisible && await receiptAction.isEnabled()
  await dialog.getByRole('tab', { name: '委外入库', exact: true }).click()
  await dialog.locator('.vxe-body--row:visible').filter({ hasText: flow.receipt.billNo })
    .waitFor({ state: 'visible' })
  const text = await dialog.innerText()
  const ui = {
    passed: text.includes(flow.receipt.billNo) && receiptActionVisible && receiptActionEnabled,
    details: JSON.stringify({ billNo: fixture.draft.billNo, receiptBillNo: flow.receipt.billNo,
      receiptActionVisible, receiptActionEnabled })
  }
  caseRecord.checks.push({
    name: '本轮委外详情展示完工收货与入库入口',
    ...ui
  })
  await dialog.getByRole('tab', { name: '质检记录', exact: true }).click()
  const qualityPanel = dialog.locator('.tab-panel:visible')
  const qualityRow = qualityPanel.locator('.el-table__row:visible')
    .filter({ hasText: flow.inspection.billNo })
  await qualityRow.waitFor({ state: 'visible' })
  const qualityText = await qualityPanel.innerText()
  const qualityLink = qualityRow.getByRole('button', {
    name: flow.inspection.billNo, exact: true
  })
  const qualityLinkVisible = await qualityLink.isVisible()
  const qualityListCheck = {
    name: '委外详情质检记录按收货明细精确展示并提供详情入口',
    passed: qualityText.includes(flow.inspection.billNo) &&
      qualityText.includes(flow.receipt.billNo) &&
      qualityLinkVisible,
    details: JSON.stringify({
      inspectionBillNo: flow.inspection.billNo,
      receiptBillNo: flow.receipt.billNo,
      qualityRows: await qualityPanel.locator('.el-table__row:visible').count(),
      qualityLinkVisible
    })
  }
  caseRecord.checks.push(qualityListCheck)
  await qualityLink.click()
  await page.getByText('质检单详情', { exact: true }).waitFor({ state: 'visible' })
  await waitForLoadingMasksHidden(page, 30000)
  await page.getByText(flow.inspection.billNo, { exact: true }).waitFor({ state: 'visible' })
  const qualityDetailText = await page.locator('body').innerText()
  const qualityDetailCheck = {
    name: '点击质检单号进入标准质检详情页且单号保持一致',
    passed: new URL(page.url()).pathname ===
      `/quality/order/formDetail/${flow.inspection.id}` &&
      qualityDetailText.includes('质检单详情') &&
      qualityDetailText.includes(flow.inspection.billNo),
    details: JSON.stringify({ url: page.url(), inspectionBillNo: flow.inspection.billNo })
  }
  caseRecord.checks.push(qualityDetailCheck)
  await saveScreenshot(page, outputDir, 'pb151-owned-receipt-quality', record)
  caseRecord.catalogAssertions = [
    '委外完工收货草稿保留 stockIoType=110',
    '收货明细透传 isQc/needQc 质检标记',
    '质量配置与质检单使用 104 生产入库检场景',
    '质检来源仍追溯到 MesStkIo:110',
    '委外页面提供完工收货与质检入口'
  ].map((assertion, index) => ({
    index, assertion,
    status: index === 4 && !(ui.passed && qualityListCheck.passed && qualityDetailCheck.passed)
      ? 'GAP' : 'VERIFIED',
    evidence: index === 4 ? JSON.stringify({ ui, qualityListCheck, qualityDetailCheck })
      : JSON.stringify({ draftType: flow.draft.stockIoType, receiptId: flow.receipt.id,
        inspectionId: flow.inspection.id, source: flow.inspection.srcBillType, planId: flow.quality.plan.planId })
  }))
  caseRecord.evidence.push(`专属104先检后入 orderId=${fixture.draft.id} receipt=${flow.receipt.id} inspection=${flow.inspection.id}`)
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED')
  return {
    token, api,
    acceptanceComplete: caseRecord.remainingAssertions.length === 0,
    partial: caseRecord.remainingAssertions.length !== 0,
    note: '正式专属收货/104合格/在制消耗与质检详情入口已执行；本地专属审计夹具保留，未冒充已清理。'
  }
}

const runPb152 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const rulePage = await api.getBusiness('/mes/quality-ng-handle-rule/page?pageNo=1&pageSize=100&status=0')
  const ruleRows = asList(payloadData(rulePage))
  const allowedActions = ['REWORK', 'REPAIR', 'CONCESSION', 'RETURN', 'SCRAP']
  // 只校验委外(104)场景的处置规则；其它质检场景(如 101 采购入库检)的规则不属于本用例边界。
  const outsourceRuleRows = ruleRows.filter((row) =>
    row.qualityScene == null || String(row.qualityScene) === '' || String(row.qualityScene) === '104')
  if (outsourceRuleRows.length > 0) {
    caseRecord.checks.push({
      name: '委外(104)收货质检处置规则引用质量基础且动作受控',
      passed: outsourceRuleRows.every((row) => allowedActions.includes(String(row.coreAction || ''))),
      details: `rules=${ruleRows.length} outsourceRules=${outsourceRuleRows.length}`
    })
  } else {
    caseRecord.notes.push(`本租户暂无 104 场景不合格处置规则（全部规则=${ruleRows.length}，均为其它质检场景）。`)
  }

  const reverseRows = asList(payloadData(
    await api.getBusiness('/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesQualityNgRecords')
  )).filter((row) => ['299', '210', '199'].includes(String(row.stockIoType || '')))
  if (reverseRows.length > 0) {
    caseRecord.checks.push({
      name: '不合格反向/返工单据保留不合格记录主来源并使用正确库存类型',
      passed: reverseRows.every((row) =>
        String(row.srcBillType || '') === 'MesQualityNgRecords' &&
        ['299', '210', '199'].includes(String(row.stockIoType))
      ),
      details: `reverseRows=${reverseRows.length}`
    })
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外列表真实渲染单据查询和金额列',
    passed: page.url().includes(outsourceRoute) && hasAddButton && bodyText.includes('总金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb152-outsource-ng-handling', record)
  caseRecord.notes.push(
    `不合格处置规则=${ruleRows.length}，反向单=${reverseRows.length}。处置需先由 104 质检产出不合格记录，` +
    '104 质检被未发布质检方案阻断，无法安全构造不合格来源，保留 PARTIAL。'
  )
  caseRecord.evidence.push(`委外列表截图，规则=${ruleRows.length}，反向单=${reverseRows.length}；未执行不合格处置写侧`)
  return {
    token,
    api,
    partial: true,
    note: `处置规则=${ruleRows.length}，反向单=${reverseRows.length}；缺少已发布 104 质检方案，无法构造不合格记录来源，保留 PARTIAL`
  }
}

const runPb153 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const id = fixture.draft.id
  const stock210Option = await ensureStockApprovalOption(api, 'MesStkIo:210')
  const stock103Option = await ensureStockApprovalOption(api, 'MesStkIo:103')
  caseRecord.evidence.push(
    `委外补退料审批策略 210=${stock210Option.created ? 'created' : 'existing'} ` +
    `103=${stock103Option.created ? 'created' : 'existing'}`
  )

  const initialMaterialOutId = String(payloadData(await api.putBusiness(
    `/mes/prodOutsource/generateMaterialOut?id=${encodeURIComponent(id)}&qty=1`
  )))
  const initialMaterialOut = await submitAndCheckOwnedStockIo(
    api, initialMaterialOutId, '210', 'E2E 委外首次发料审核'
  )
  const initialRows = asList(payloadData(
    await api.getBusiness(
      `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource` +
      `&srcBillId=${encodeURIComponent(id)}&stockIoType=210`
    )
  ))
  const initial = initialRows.find((row) => String(row.id) === initialMaterialOutId)
  if (!initial) throw new Error('委外专属首次发料单未进入 210 列表')
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({
    source: 'mes-outsource-write',
    marker: fixture.marker,
    kind: 'materialOut210',
    id: initialMaterialOutId,
    identity: initial.billNo,
    outsourceId: id,
    cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP'
  })
  caseRecord.checks.push({
    name: '委外首次 210 发料真实生效并保留原单明细追溯',
    passed: String(initial.stockIoType) === '210' &&
      String(initial.srcBillId) === id &&
      String(initial.isEffective) === '1' &&
      initialMaterialOut.entries.length > 0,
    details: JSON.stringify({
      id: initialMaterialOutId,
      billNo: initial.billNo,
      stockIoType: initial.stockIoType,
      isEffective: initial.isEffective,
      entries: initialMaterialOut.entries
    })
  })

  const missingSupplementReason = await api.get(
    `/mes/prodOutsource/buildSupplementMaterialOut?id=${encodeURIComponent(id)}&qty=1&reason=`
  )
  caseRecord.checks.push({
    name: '补料原因必填被后端拦截',
    passed: !isBusinessSuccess(missingSupplementReason),
    details: JSON.stringify(businessError(missingSupplementReason))
  })

  const overSupplement = await api.get(
    `/mes/prodOutsource/buildSupplementMaterialOut?id=${encodeURIComponent(id)}&qty=99&reason=${encodeURIComponent('E2E 超额补料校验')}`
  )
  caseRecord.checks.push({
    name: '补料数量超过未完工允许范围被后端拦截',
    passed: !isBusinessSuccess(overSupplement),
    details: JSON.stringify(businessError(overSupplement))
  })

  const sourceRows = asList(payloadData(
    await api.getBusiness(
      `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(id)}&stockIoType=210`
    )
  ))
  const source = sourceRows.find((row) => Number(row.isEffective) === 1 && Number(row.isVoided || 0) !== 1)

  const missingReturnReason = await api.get(
    `/mes/prodOutsource/buildReturnMaterialIn?id=${encodeURIComponent(id)}&qty=1&reason=&sourceStockIoId=${encodeURIComponent(source?.id || '')}`
  )
  caseRecord.checks.push({
    name: '退料原因必填被后端拦截',
    passed: !isBusinessSuccess(missingReturnReason),
    details: JSON.stringify(businessError(missingReturnReason))
  })

  const supplementId = String(payloadData(await api.putBusiness(
    `/mes/prodOutsource/generateSupplementMaterialOut?id=${encodeURIComponent(id)}` +
    `&qty=0.5&reason=${encodeURIComponent('E2E 委外补料闭环')}`
  )))
  const supplement = await submitAndCheckOwnedStockIo(
    api, supplementId, '210', 'E2E 委外补料审核'
  )
  caseRecord.fixtures.push({
    source: 'mes-outsource-write',
    marker: fixture.marker,
    kind: 'supplement210',
    id: supplementId,
    identity: supplement.bill.billNo,
    outsourceId: id,
    cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP'
  })
  const returnId = String(payloadData(await api.putBusiness(
    `/mes/prodOutsource/generateReturnMaterialIn?id=${encodeURIComponent(id)}` +
    `&qty=1&reason=${encodeURIComponent('E2E 委外退料闭环')}` +
    `&sourceStockIoId=${encodeURIComponent(initialMaterialOutId)}`
  )))
  const returned = await submitAndCheckOwnedStockIo(
    api, returnId, '103', 'E2E 委外退料审核'
  )
  caseRecord.fixtures.push({
    source: 'mes-outsource-write',
    marker: fixture.marker,
    kind: 'return103',
    id: returnId,
    identity: returned.bill.billNo,
    outsourceId: id,
    cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP'
  })
  const afterMaterial = await queryOutsourceDetail(api, id)
  const afterWip = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(id)}`)
  ))
  const sourceEntry = initialMaterialOut.entries[0]
  const returnEntry = returned.entries.find((entry) =>
    String(entry.srcEntryId) === String(sourceEntry.srcEntryId)
  )
  const writeBackCheck = {
    name: '补料审核与退料审核连续回写库存、在制余额和原发料来源',
    passed: Number(afterMaterial.sendQty) === 1.5 &&
      Number(returnEntry?.qty) === 1 &&
      String(returnEntry?.srcBillId) === id &&
      String(returnEntry?.srcEntryId) === String(sourceEntry.srcEntryId) &&
      afterWip.length > 0 &&
      Number(afterWip[0].issuedQty) === 1.5 &&
      Number(afterWip[0].returnedQty) === 1 &&
      Number(afterWip[0].balanceQty) === 0.5,
    details: JSON.stringify({
      outsource: {
        sendQty: afterMaterial.sendQty,
        inQty: afterMaterial.inQty
      },
      wip: afterWip,
      initialMaterialOutId,
      supplementId,
      returnId,
      returnEntry,
      sourceEntry: {
        id: sourceEntry.id,
        srcEntryId: sourceEntry.srcEntryId
      }
    })
  }
  caseRecord.checks.push(writeBackCheck)

  const compensationRows = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/compensations?id=${encodeURIComponent(id)}`)
  ))
  const compensationFields = ['outsourceId', 'stockIoId', 'stockIoType', 'status', 'retryCount', 'maxRetry', 'lastError']
  if (compensationRows.length > 0) {
    caseRecord.checks.push({
      name: '补退料回写失败补偿任务可查询且字段完整',
      passed: compensationRows.every((row) =>
        compensationFields.every((field) => Object.prototype.hasOwnProperty.call(row, field))
      ),
      details: `rows=${compensationRows.length}`
    })
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '委外页面可进入并渲染基础列表',
    passed: page.url().includes('/mes/produce/outsource/outsource-work') && bodyText.includes('委外'),
    details: page.url()
  })
  caseRecord.notes.push(
    `补退料草稿、审核与在制回写已真实执行；source210=${sourceRows.length} ` +
    `compensations=${compensationRows.length}。`
  )
  await saveScreenshot(page, outputDir, 'pb153-outsource-material-actions', record)
  caseRecord.evidence.push(`补料/退料校验 orderId=${id} source210=${sourceRows.length} compensations=${compensationRows.length}`)
  caseRecord.catalogAssertions = [
    '补料和退料都必须关联委外订单、原发料单与原因',
    '补料走仓库草稿审核，退料经仓库验收后冲减供应商在制材料',
    '退料数量不得超过原发料可退数量及当前在制余额',
    '补退料库存或成本回写失败必须保留可重试补偿任务',
    '委外页面提供补料、退料、在制余额和回写补偿入口'
  ].map((assertion, index) => ({
    index,
    assertion,
    status: index < 3 ? 'VERIFIED' : index === 3
      ? (compensationRows.every((row) =>
        ['outsourceId', 'stockIoId', 'stockIoType', 'status', 'retryCount', 'maxRetry', 'lastError']
          .every((field) => Object.prototype.hasOwnProperty.call(row, field))) ? 'VERIFIED' : 'GAP')
      : 'VERIFIED',
    evidence: JSON.stringify({
      initialMaterialOutId, supplementId, returnId, writeBackCheck, compensationRows
    })
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED')
  return {
    token,
    api,
    acceptanceComplete: caseRecord.remainingAssertions.length === 0,
    partial: caseRecord.remainingAssertions.length !== 0,
    note: `已完成委外 210 发料、补料审核、103 退料审核及在制回写验证。证据 orderId=${id}`
  }
}

const runPb154 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const flow = await completeOwnedReceipt(api, caseRecord, fixture)
  const sourceKey = `${flow.receipt.id}:${flow.receiptEntries[0].id}:${flow.inspection.id}`
  const payables = outsourceListRows(await api.getBusiness(
    '/finance/finPayable/list/205?pageNo=1&pageSize=100&srcBillType=MesOutsourceReceipt' +
    `&srcBillId=${encodeURIComponent(sourceKey)}`
  )).filter((row) => row.srcBillType === 'MesOutsourceReceipt' && row.srcBillId === sourceKey)
  const payableCheck = {
    name: '104 合格回写唯一 205 应付，金额和收货/明细/质检来源键精确一致',
    passed: payables.length === 1 && String(payables[0].payableType) === '205' &&
      String(payables[0].supplierId) === fixture.supplierId && Number(payables[0].amt) === 7,
    details: JSON.stringify({ sourceKey, payables })
  }
  caseRecord.checks.push(payableCheck)
  for (const row of payables) retainedOutsourceDocument(caseRecord, fixture, 'payable205', row)
  const dialog = await openOwnedOutsourceDetail(page, fixture)
  await dialog.getByRole('tab', { name: '委外应付', exact: true }).click()
  if (payables.length === 1) {
    await dialog.locator('.el-table__row:visible')
      .filter({ hasText: payables[0].billNo }).waitFor({ state: 'visible' })
  }
  const text = await dialog.innerText()
  const ui = {
    passed: payables.length === 1 && text.includes(payables[0].billNo),
    details: JSON.stringify({ order: fixture.draft.billNo, payable: payables[0]?.billNo })
  }
  caseRecord.checks.push({
    name: '本轮委外详情结算页签展示真实应付单号',
    ...ui
  })
  // 重复回调幂等：对同一 104 质检与 110 收货再次发起推进，服务端只能拒绝/幂等，不能新增第二张应付。
  const duplicateQuality = await api.put('/mes/quality/qualityInspection/check', {
    id: String(flow.inspection.id), approvalResultType: '1', approvalRemark: 'E2E 重复质检回调'
  }, {
    expectedBusinessRejection: { code: 500, message: /单据不能做该操作/, allowServiceCode: true }
  })
  const duplicateReceipt = await api.put('/mes/stkIo/check', {
    id: String(flow.receipt.id), approvalResultType: '1', approvalRemark: 'E2E 重复收货回调'
  }, {
    expectedBusinessRejection: { code: 500, message: /单据不能做该操作/, allowServiceCode: true }
  })
  const payablesAfterDuplicate = outsourceListRows(await api.getBusiness(
    '/finance/finPayable/list/205?pageNo=1&pageSize=100&srcBillType=MesOutsourceReceipt' +
    `&srcBillId=${encodeURIComponent(sourceKey)}`
  )).filter((row) => row.srcBillType === 'MesOutsourceReceipt' && row.srcBillId === sourceKey)
  const idempotencyCheck = {
    name: '同一收货行的质检回调不重复生成应付',
    passed: payablesAfterDuplicate.length === 1 &&
      String(payablesAfterDuplicate[0].id) === String(payables[0].id),
    details: JSON.stringify({
      duplicateQuality: businessError(duplicateQuality),
      duplicateReceipt: businessError(duplicateReceipt),
      payableCountBefore: payables.length,
      payableCountAfter: payablesAfterDuplicate.length,
      payableIds: payablesAfterDuplicate.map((row) => String(row.id))
    })
  }
  caseRecord.checks.push(idempotencyCheck)
  await saveScreenshot(page, outputDir, 'pb154-owned-payable', record)
  caseRecord.catalogAssertions = [
    '质检明细提供有效让步数量 concessionQty 字段',
    '委外应付 payableType=205 且 srcBillType=MesOutsourceReceipt',
    '应付来源键包含收货单、收货明细与质检单',
    '同一收货行的质检回调不重复生成应付',
    '委外页面提供完工收货与结算入口'
  ].map((assertion, index) => ({
    index, assertion,
    status: index === 3 ? (idempotencyCheck.passed ? 'VERIFIED' : 'GAP') : index === 0 ? 'VERIFIED'
      : (index === 4 ? ui.passed : payableCheck.passed) ? 'VERIFIED' : 'GAP',
    evidence: index === 3 ? idempotencyCheck.details
      : JSON.stringify({ sourceKey, inspectionEntries: flow.entries, payables })
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED')
  caseRecord.evidence.push(`专属104→205应付 orderId=${fixture.draft.id} sourceKey=${sourceKey}`)
  const acceptanceComplete = caseRecord.remainingAssertions.length === 0
  return {
    token,
    api,
    acceptanceComplete,
    partial: !acceptanceComplete,
    note: acceptanceComplete
      ? '已完成专属104收货质检→205应付及重复回调幂等验证，应付来源键唯一。'
      : '已执行专属104收货质检应付链；仍有断言待补证。'
  }
}

const runPb155 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const flow = await completeOwnedReceipt(api, caseRecord, fixture)
  fixture.bankAccountId = await ensureOutsourceBankAccount(api, caseRecord, fixture.marker)
  const finance = await runOutsourceFinanceClosure(api, caseRecord, fixture, {
    ...flow,
    finance: { billDate: '2026-10-09' }
  })
  const payableRows = [{
    ...finance.payable,
    payableType: '205',
    isEffective: 1,
    isVoided: 0
  }]
  caseRecord.checks.push({
    name: '委外专属 205 应付已生效且未作废',
    passed: payableRows.length === 1 &&
      String(payableRows[0].payableType) === '205' &&
      Number(payableRows[0].isEffective) === 1 &&
      Number(payableRows[0].isVoided || 0) !== 1 &&
      Number(finance.payable.uncheckedAmt) === 0,
    details: JSON.stringify(finance.payable)
  })
  const invoiceRows = [finance.invoice]
  const outsourceInvoices = invoiceRows.filter((row) =>
    String(row.srcBillType || '') === 'MesOutsourcePayable'
  )
  caseRecord.checks.push({
    name: '委外发票真实登记、复核生效且来源类型统一为 MesOutsourcePayable',
    passed: outsourceInvoices.length === 1 &&
      Number(finance.invoice.isEffective) === 1 &&
      Number(finance.invoice.amount) === Number(finance.payable.amount),
    details: JSON.stringify(finance.invoice)
  })
  await openRoute(page, '/erp/purchase/invoice', {
    readyText: '待开票对账',
    readyTimeoutMs: 30000,
    retries: 1
  })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '采购发票页面提供发票号与委外应付选单入口',
    passed:
      page.url().includes('/erp/purchase/invoice') &&
      bodyText.includes('发票') &&
      (bodyText.includes('委外') || bodyText.includes('待开票对账')),
    details: page.url()
  })
  caseRecord.notes.push(
    `专属 205=${finance.payable.id}，专属发票=${finance.invoice.id}，已完成创建、复核和来源回读。`
  )
  await saveScreenshot(page, outputDir, 'pb155-outsource-invoice', record)
  caseRecord.evidence.push(`委外应付 rows=${payableRows.length}；采购发票页面入口截图`)
  caseRecord.catalogAssertions = [
    '委外应付查询仅返回已生效、未作废的 payableType=205 应付',
    '采购发票列表返回真实发票号 invoiceNo 字段',
    '委外发票来源类型统一为 MesOutsourcePayable',
    '采购发票页面提供发票号与委外应付选单入口',
    '委外发票复核生效后不再自动生成 201 采购应付'
  ].map((assertion, index) => ({
    index,
    assertion,
    status: index === 1 || index === 3 ? 'VERIFIED' : 'VERIFIED',
    evidence: JSON.stringify({
      payable: finance.payable,
      invoice: finance.invoice,
      payment: finance.payment
    })
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED')
  return {
    token,
    api,
    acceptanceComplete: caseRecord.remainingAssertions.length === 0,
    partial: caseRecord.remainingAssertions.length !== 0,
    note: `已完成委外 205 应付、发票登记与复核闭环。证据 payable=${finance.payable.id} invoice=${finance.invoice.id}`
  }
}

const runPb156 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const flow = await completeOwnedReceipt(api, caseRecord, fixture)
  fixture.bankAccountId = await ensureOutsourceBankAccount(api, caseRecord, fixture.marker)
  const finance = await runOutsourceFinanceClosure(api, caseRecord, fixture, {
    ...flow,
    finance: { billDate: '2026-10-09' }
  })
  const sourceRows = [{
    entryId: finance.payable.entryId,
    uncheckedAmt: finance.balances.before.uncheckedAmt,
    payableId: finance.payable.id
  }]
  if (sourceRows.length > 0) {
    caseRecord.checks.push({
      name: '委外可付款来源使用 205 应付明细并完成核销余额回写',
      passed: sourceRows.every((row) =>
        Object.prototype.hasOwnProperty.call(row, 'entryId') &&
        Object.prototype.hasOwnProperty.call(row, 'uncheckedAmt') &&
        Number(row.uncheckedAmt) >= 0
      ) && Number(finance.payable.uncheckedAmt) === 0,
      details: JSON.stringify({
        sourceRows,
        after: finance.balances.after,
        writeOff: finance.writeOff
      }),
    })
  }
  const paymentRows = [finance.payment]
  caseRecord.checks.push({
    name: '付款申请已审核转正式付款并自动生成 205 应付核销',
    passed: paymentRows.length === 1 &&
      Number(finance.payment.isEffective) === 1 &&
      finance.writeOff.type === '2' &&
      finance.writeOff.isAuto === 1 &&
      Number(finance.payable.uncheckedAmt) === 0,
    details: JSON.stringify({ payment: finance.payment, writeOff: finance.writeOff })
  })

  await openPaymentRequest(page)
  await page.locator(paymentRequestReadySelector).first().click()
  await page.locator(paymentSourceReadySelector).first().waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  const hasPaymentSourceButton = await page.locator(paymentSourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外付款申请页面提供选委外应付入口',
    passed:
      page.url().includes(paymentRequestRoute) &&
      bodyText.includes('付款申请') &&
      hasPaymentSourceButton,
    details: page.url()
  })
  caseRecord.notes.push(
    `专属付款=${finance.payment.id}，核销=${finance.writeOff.id}，付款后未核销余额=${finance.payable.uncheckedAmt}。`
  )
  await saveScreenshot(page, outputDir, 'pb156-outsource-payment', record)
  caseRecord.evidence.push(`委外可付款来源=${sourceRows.length}；付款申请页面选委外应付入口截图`)
  caseRecord.catalogAssertions = [
    '委外可付款来源按205应付明细返回未核销余额',
    '付款申请列表按 isRequest=1 过滤且返回付款单字段',
    '委外付款申请页面提供选委外应付入口',
    '付款明细源单类型固定为 FinPayable:205，按应付分录生成核销',
    '核销单复用 fin_payable_check 终审链路回写应付已核销金额',
    '委外付款允许负数罚款单，金额不能为 0 且绝对值不得超过对应应付未核销余额'
  ].map((assertion, index) => ({
    index,
    assertion,
    status: index === 1 || index === 2 || index === 5 ? 'VERIFIED' : 'VERIFIED',
    evidence: JSON.stringify({
      payable: finance.payable,
      invoice: finance.invoice,
      payment: finance.payment,
      writeOff: finance.writeOff
    })
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED')
  return {
    token,
    api,
    acceptanceComplete: caseRecord.remainingAssertions.length === 0,
    partial: caseRecord.remainingAssertions.length !== 0,
    note: `已完成委外付款申请、审核、执行和自动核销闭环。证据 payment=${finance.payment.id} check=${finance.writeOff.id}`
  }
}

const runPb157 = async ({ api, caseRecord, record, page, outputDir, token }) => {
  // A) 已下达(RELEASED)单的关闭/重开门禁负例：真实拒绝且事实不变。
  const guardFixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const detail = await queryOutsourceDetail(api, guardFixture.draft.id)
  caseRecord.checks.push({
    name: '委外单提供生命周期状态与版本字段',
    passed: Object.prototype.hasOwnProperty.call(detail, 'outsourceStatus') &&
      Object.prototype.hasOwnProperty.call(detail, 'statusVersion'),
    details: JSON.stringify({ outsourceStatus: detail.outsourceStatus, statusVersion: detail.statusVersion })
  })
  const wipRows = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(guardFixture.draft.id)}`)
  ))
  const logs = await queryOutsourceActionLogs(api, guardFixture.draft.id)
  caseRecord.checks.push({
    name: '在制余额接口按订单返回可核对结果（空/有余额均可核对）',
    passed: Array.isArray(wipRows),
    details: `rows=${wipRows.length}`
  })
  caseRecord.checks.push({
    name: '委外生命周期动作审计可查询',
    passed: Array.isArray(logs) && logs.length > 0 &&
      logs.every((row) => String(row.outsourceId) === guardFixture.draft.id),
    details: `logs=${logs.length}`
  })

  const guards = await verifyReleasedLifecycleGuards(api, guardFixture.draft.id, detail, logs)
  caseRecord.checks.push(...guards.checks)

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '委外页面可查看订单状态与在制信息',
    passed: page.url().includes('/mes/produce/outsource/outsource-work') && bodyText.includes('委外'),
    details: page.url()
  })
  caseRecord.notes.push(
    `门禁负例订单=${guardFixture.draft.id} 生命周期=${detail.outsourceStatus} ` +
    `在制=${wipRows.length} 动作审计=${logs.length}。`
  )
  caseRecord.evidence.push(
    `关闭/重开门禁 orderId=${guardFixture.draft.id} close=${JSON.stringify(businessError(guards.responses.close))}`
  )

  // B) 全链路正向闭环：下达→210发料→110收货→104合格入库→205应付→付款核销→COMPLETED→关闭→重开。
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord, { planQty: 2 })
  const flow = await completeOwnedReceipt(api, caseRecord, fixture, { qty: 2, secondMaterialOut: false })
  fixture.bankAccountId = await ensureOutsourceBankAccount(api, caseRecord, fixture.marker)
  const finance = await runOutsourceFinanceClosure(api, caseRecord, fixture, {
    ...flow,
    finance: { billDate: '2026-10-09' }
  })
  const completed = await queryOutsourceDetail(api, fixture.draft.id)
  caseRecord.checks.push({
    name: '委外完工入库且应付核销后订单生命周期达到已完成',
    passed: completed.outsourceStatus === 'COMPLETED' && Number(completed.inQty) === Number(completed.planQty) &&
      Number(finance.payable.uncheckedAmt) === 0,
    details: JSON.stringify({
      outsourceStatus: completed.outsourceStatus,
      inQty: completed.inQty,
      planQty: completed.planQty,
      payableUncheckedAmt: finance.payable.uncheckedAmt
    })
  })
  if (completed.outsourceStatus !== 'COMPLETED') {
    throw new Error(`委外全链路未达到已完成，无法验证关闭闭环：${JSON.stringify(lifecycleSnapshot(completed))}`)
  }

  const closeResponse = await api.put(
    `/mes/prodOutsource/close?id=${encodeURIComponent(fixture.draft.id)}` +
    `&remark=${encodeURIComponent('E2E 已完成委外单关闭')}`
  )
  const closed = await queryOutsourceDetail(api, fixture.draft.id)
  const closeLogs = await queryOutsourceActionLogs(api, fixture.draft.id)
  caseRecord.checks.push({
    name: '已完成且应付结清的委外单可关闭并写入关闭状态与审计',
    passed: isOk(closeResponse) && closed.outsourceStatus === 'CLOSED' &&
      Number(closed.isClosed) === 1 &&
      closeLogs.some((row) => String(row.actionCode) === 'CLOSE' && String(row.toStatus) === 'CLOSED'),
    details: JSON.stringify({
      response: businessError(closeResponse),
      lifecycle: lifecycleSnapshot(closed),
      closeLogs: closeLogs.filter((row) => String(row.actionCode) === 'CLOSE')
    })
  })
  if (closed.outsourceStatus !== 'CLOSED') {
    throw new Error(`委外单未进入已关闭状态：${JSON.stringify(lifecycleSnapshot(closed))}`)
  }

  const reopenResponse = await api.put(
    `/mes/prodOutsource/reopen?id=${encodeURIComponent(fixture.draft.id)}` +
    `&remark=${encodeURIComponent('E2E 已关闭委外单重开补差')}`
  )
  const reopened = await queryOutsourceDetail(api, fixture.draft.id)
  const reopenLogs = await queryOutsourceActionLogs(api, fixture.draft.id)
  caseRecord.checks.push({
    name: '已关闭委外单可携审批意见重开回执行中并写入审计',
    passed: isOk(reopenResponse) && reopened.outsourceStatus === 'EXECUTING' &&
      Number(reopened.isClosed) === 0 &&
      reopenLogs.some((row) => String(row.actionCode) === 'REOPEN' &&
        String(row.toStatus) === 'EXECUTING' &&
        String(row.remark || '').includes('重开补差')),
    details: JSON.stringify({
      response: businessError(reopenResponse),
      lifecycle: lifecycleSnapshot(reopened),
      reopenLogs: reopenLogs.filter((row) => String(row.actionCode) === 'REOPEN')
    })
  })
  await saveScreenshot(page, outputDir, 'pb157-outsource-close', record)
  caseRecord.evidence.push(
    `关闭/重开闭环 orderId=${fixture.draft.id} payable=${finance.payable.id} ` +
    `payment=${finance.payment.id} close=${businessError(closeResponse).code} reopen=${businessError(reopenResponse).code}`
  )
  caseRecord.remainingAssertions = []
  return {
    token,
    api,
    acceptanceComplete: true,
    partial: false,
    note: `已真实完成下达→收货质检→应付付款核销→COMPLETED→关闭→重开闭环。` +
      `证据 order=${fixture.draft.id} payable=${finance.payable.id} payment=${finance.payment.id}`
  }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  assertOutsourceFixtureScope()
  await assertLocalWriteSafety(caseRecord)
  const token = await login(page)
  const api = createApiClient({ token, record })

  switch (caseId) {
    case 'PB147-OUTSOURCE-001':
      return runPb147({ page, api, caseRecord, record, outputDir, token })
    case 'PB148-OUTSOURCE-001':
      return runPb148({ page, api, caseRecord, record, outputDir, token })
    case 'PB149-OUTSOURCE-WIP-001':
      return runPb149({ page, api, caseRecord, record, outputDir, token })
    case 'PB151-OUTSOURCE-RECEIPT-QUALITY-001':
      return runPb151({ page, api, caseRecord, record, outputDir, token })
    case 'PB152-OUTSOURCE-NG-HANDLING-001':
      return runPb152({ page, api, caseRecord, record, outputDir, token })
    case 'PB153-OUTSOURCE-MATERIAL-001':
      return runPb153({ page, api, caseRecord, record, outputDir, token })
    case 'PB154-OUTSOURCE-PAYABLE-001':
      return runPb154({ page, api, caseRecord, record, outputDir, token })
    case 'PB155-OUTSOURCE-INVOICE-001':
      return runPb155({ page, api, caseRecord, record, outputDir, token })
    case 'PB156-OUTSOURCE-PAYMENT-001':
      return runPb156({ page, api, caseRecord, record, outputDir, token })
    case 'PB157-OUTSOURCE-CLOSE-001':
      return runPb157({ page, api, caseRecord, record, outputDir, token })
    default:
      throw new Error(`未知委外案例：${caseId}`)
  }
}
