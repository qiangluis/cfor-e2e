import { isDeepStrictEqual } from 'node:util'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import {
  prepareCostScenario,
  resetCostScenarioCache,
  resolveWmsPurchaseReceipt
} from './cost-scenario.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { checkInspection } from './mes-quality-write.mjs'

export const COST_PURCHASE_SOURCE_CHECKS = Object.freeze({
  receipt: 'COST-009 正式审核采购入库按专属期间刷新并精确回读来源数量金额',
  mapping: 'COST-009 非空PURCHASE快照唯一映射ERP/PURCHASE_RECEIPT真实主从ID',
  draft: 'COST-009 刷新后主从均为DRAFT且无人工确认人或正式发布事实',
  empty: 'COST-009 无来源专属期间精确业务阻断且数据库没有空快照',
  browser: 'COST-009 正式页面显示同期间真实采购入库并调用正式刷新API'
})

export const COST_PURCHASE_RETURN_CHECKS = Object.freeze({
  receipt: 'COST-010 正式采购入库映射正数量和正材料金额',
  returned: 'COST-010 正式审核执行采购退回映射真实主从ID及负数量负材料金额',
  draft: 'COST-010 入库与退回共用同一PURCHASE草稿且写后回读一致',
  net: 'COST-010 按精确产品ID核对入库退回净数量净金额及数据库事实',
  overflow: 'COST-010 真实跨期退回造成当期负净额被精确阻断且不生成可确认快照',
  browser: 'COST-010 正式页面显示同期间入库退回及准确正负数量金额'
})

const requireFact = (condition, message) => {
  if (!condition) throw new Error(message)
}
const data = (payload, label) => assertBusinessSuccess(payload, label).data
const id = (value) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  requireFact(/^[1-9]\d*$/.test(text) && BigInt(text) <= 9223372036854775807n,
    '采购成本夹具缺少精确主键')
  return text
}
export const costSourceDecimal = (value) => {
  requireFact((typeof value === 'string' || typeof value === 'number') &&
    /^-?\d+(?:\.\d{1,8})?$/.test(String(value)), '采购成本数量金额缺失或精度异常')
  const text = String(value)
  const [whole, fraction = ''] = text.replace('-', '').split('.')
  return (text.startsWith('-') ? -1n : 1n) *
    (BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0')))
}
const same = (left, right) => costSourceDecimal(left) === costSourceDecimal(right)
export const costSourceAmountText = (value) => {
  requireFact((typeof value === 'string' || typeof value === 'number') &&
    String(value).trim() !== '' && Number.isFinite(Number(value)),
  '采购成本页面金额缺失或格式异常')
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}
const nullableId = (value) => {
  if (value == null || String(value).trim() === '') return null
  return String(value)
}
const amountOfPurchaseItem = (item) => {
  if (item?.totalPrice !== undefined && item?.totalPrice !== null) {
    return costSourceDecimal(item.totalPrice)
  }
  const productAmount = costSourceDecimal(item?.productPrice) *
    costSourceDecimal(item?.count) / 100000000n
  const taxAmount = item?.taxPrice === undefined || item?.taxPrice === null
    ? 0n
    : costSourceDecimal(item.taxPrice)
  return productAmount + taxAmount
}
const rows = (payload, label) => {
  const value = data(payload, label)
  const result = value?.records ?? value?.list ?? value
  requireFact(Array.isArray(result), `${label}缺少真实数组`)
  return result
}
const check = (caseRecord, name, detail) => caseRecord.checks.push({
  name, passed: true, details: JSON.stringify(detail)
})
const snapshotPath = (fixture) => `/cost/periods/${id(fixture.periodId)}/source-snapshot` +
  `?snapshotKey=PURCHASE&versionNo=${encodeURIComponent(fixture.versionNo)}`

export function assertPurchaseDraft (snapshot, fixture) {
  requireFact(snapshot?.periodId === fixture.periodId && snapshot.snapshotKey === 'PURCHASE' &&
    snapshot.versionNo === fixture.versionNo && snapshot.status === 'DRAFT' &&
    snapshot.confirmedAt == null && snapshot.confirmedBy == null &&
    Array.isArray(snapshot.lines) && snapshot.lines.length > 0,
  '采购来源必须是本期间非空未人工确认的PURCHASE草稿')
  id(snapshot.id)
  requireFact(/^[a-f\d]{64}$/i.test(snapshot.snapshotHash || ''), '采购快照缺少哈希')
  const keys = new Set()
  for (const line of snapshot.lines) {
    const key = `${line.sourceModule}:${line.sourceType}:${line.sourceId}:${line.sourceLineId}`
    requireFact(line.sourceModule === 'ERP' && line.sourceStatus === 'DRAFT' &&
      !keys.has(key) && String(line.productCode) === fixture.materialId,
    '采购草稿行归属、状态、产品或重复来源不正确')
    id(line.sourceId)
    id(line.sourceLineId)
    keys.add(key)
    costSourceDecimal(line.quantity)
    costSourceDecimal(line.materialAmount)
  }
  return snapshot
}

export function assertPurchaseReceipt (snapshot, fixture, receipt, wms) {
  assertPurchaseDraft(snapshot, fixture)
  requireFact(receipt?.id === fixture.purchaseInId && Number(receipt.status) === 20 &&
    receipt.businessType === 'NORMAL' && String(receipt.orderId) === fixture.purchaseOrderId &&
    Array.isArray(receipt.items) && receipt.items.length === 1,
  '正式采购入库未按本轮订单审核生效')
  // 成本来源已切到 WMS 采购入库事实源：来源主从 ID 是 mes_stk_io 的主从 ID，ERP 采购入库是上游单据。
  requireFact(wms?.wmsId && wms?.entryId, '采购入库缺少WMS来源主从ID')
  const item = receipt.items[0]
  const matches = snapshot.lines.filter((line) => line.sourceType === 'PURCHASE_RECEIPT' &&
    line.sourceId === id(wms.wmsId) && line.sourceLineId === id(wms.entryId))
  requireFact(matches.length === 1 && matches[0].sourceNo === receipt.no &&
    String(item.productId) === fixture.materialId &&
    costSourceDecimal(matches[0].quantity) > 0n &&
    costSourceDecimal(matches[0].materialAmount) > 0n &&
    same(matches[0].quantity, item.count) &&
    costSourceDecimal(matches[0].materialAmount) === amountOfPurchaseItem(item),
  '正式采购入库与PURCHASE_RECEIPT未按WMS主从ID精确对应')
  return matches[0]
}

export function assertPurchaseConfirmed (snapshot, fixture, draft) {
  assertPurchaseDraft(draft, fixture)
  requireFact(snapshot?.id === draft.id && snapshot.periodId === fixture.periodId &&
    snapshot.snapshotKey === 'PURCHASE' && snapshot.versionNo === fixture.versionNo &&
    snapshot.snapshotHash === draft.snapshotHash && snapshot.status === 'CONFIRMED' &&
    Array.isArray(snapshot.lines) && snapshot.lines.length === draft.lines.length,
  '采购来源确认必须保留同一期间、版本、主键和非空快照哈希')
  for (const line of draft.lines) {
    const matches = snapshot.lines.filter((row) =>
      row.sourceModule === line.sourceModule && row.sourceType === line.sourceType &&
      row.sourceId === line.sourceId && row.sourceLineId === line.sourceLineId)
    requireFact(matches.length === 1 && matches[0].sourceStatus === 'CONFIRMED' &&
      isDeepStrictEqual({ ...matches[0], sourceStatus: 'DRAFT' }, line),
    '采购来源确认改变了真实来源身份、数量金额、映射或发票快照')
  }
  return snapshot
}

export function assertPurchaseReturn (snapshot, fixture, returned) {
  assertPurchaseDraft(snapshot, fixture)
  requireFact(Number(returned?.status) === 20 && Number(returned.isEffective) === 1 &&
    Number(returned.isVoided) === 0 && ['32', '34'].includes(String(returned.billStage)) &&
    String(returned.srcBillId) === fixture.purchaseOrderId &&
    Array.isArray(returned.items) && returned.items.length === 1,
  '采购退回必须经过真实审核和执行')
  const item = returned.items[0]
  const matches = snapshot.lines.filter((line) => line.sourceType === 'PURCHASE_RETURN' &&
    line.sourceId === id(returned.id) && line.sourceLineId === id(item.id))
  requireFact(matches.length === 1 && matches[0].sourceNo === returned.billNo &&
    String(item.productId) === fixture.materialId &&
    costSourceDecimal(matches[0].quantity) < 0n &&
    costSourceDecimal(matches[0].materialAmount) < 0n &&
    costSourceDecimal(matches[0].quantity) === -costSourceDecimal(item.count) &&
    costSourceDecimal(matches[0].materialAmount) === -amountOfPurchaseItem(item),
  '正式退回与负数量负材料金额来源未精确对应')
  return matches[0]
}

export async function preparePurchaseClosure ({ api, record, caseRecord }, dependencies = {}) {
  requireFact(config.target === 'local' && config.tenantId === '1' &&
    record.environment?.tenantId === '1' &&
    process.env.CFOR_E2E_WRITE_FIXTURES === 'true',
  'BLOCKED: 采购成本写侧仅允许显式开启的local tenant1')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  // A case must not inherit another case's mutable purchase period.
  resetCostScenarioCache()
  return (dependencies.prepareCostScenario || prepareCostScenario)({
    api, record, caseRecord, scenario: 'purchase'
  })
}

const prepareEmpty = async ({ api, record, caseRecord }, dependencies) => {
  const negative = { ...caseRecord, fixtures: {}, checks: [], notes: [], evidence: [] }
  resetCostScenarioCache()
  const fixture = await (dependencies.prepareCostScenario || prepareCostScenario)({
    api, record, caseRecord: negative, scenario: 'accounting'
  })
  caseRecord.fixtures.costUnpublishedScenario = fixture
  return fixture
}

export async function readPurchaseDatabase ({ fixture, snapshot, caseRecord, readSql = runReadOnlySql }) {
  const result = await readSql(`
    SELECT 'snapshot', CAST(id AS CHAR), status, CAST(confirmed_by AS CHAR),
      CAST(confirmed_at AS CHAR), snapshot_hash FROM cost_period_snapshot
    WHERE tenant_id=1 AND deleted=0 AND period_id=${id(fixture.periodId)}
      AND snapshot_type='SOURCE' AND snapshot_key='PURCHASE';
    SELECT 'line', source_module, source_type, source_id, source_line_id,
      product_code, quantity, material_amount, source_status
    FROM cost_source_snapshot_line WHERE tenant_id=1 AND deleted=0
      AND snapshot_id=${id(snapshot.id)} ORDER BY id;
    SELECT 'publications', COUNT(*) FROM cost_publication
    WHERE tenant_id=1 AND deleted=0 AND period_id=${id(fixture.periodId)}
  `)
  requireFact(result.available, '采购成本缺少只读数据库证据')
  const headers = result.rows.filter((row) => row[0] === 'snapshot')
  const lines = result.rows.filter((row) => row[0] === 'line')
  requireFact(headers.length === 1 && headers[0][1] === snapshot.id &&
    headers[0][2] === 'DRAFT' && headers[0][3] === 'NULL' &&
    headers[0][4] === 'NULL' && headers[0][5] === snapshot.snapshotHash &&
    lines.length === snapshot.lines.length && lines.length > 0,
  '数据库采购草稿主从/确认状态与正式API不一致')
  for (const line of snapshot.lines) {
    const matches = lines.filter((row) => row[1] === line.sourceModule &&
      row[2] === line.sourceType && row[3] === line.sourceId && row[4] === line.sourceLineId)
    requireFact(matches.length === 1 && matches[0][5] === line.productCode &&
      same(matches[0][6], line.quantity) && same(matches[0][7], line.materialAmount) &&
      matches[0][8] === 'DRAFT', '数据库采购来源逐行数量金额不符')
  }
  requireFact(result.rows.find((row) => row[0] === 'publications')?.[1] === '0',
    '采购草稿刷新不应自动发布')
  caseRecord.database = [...(caseRecord.database || []), { stage: 'purchase-draft', ...result }]
  return result
}

export async function readConfirmedPurchaseDatabase ({
  fixture, snapshot, draft, caseRecord, readSql = runReadOnlySql
}) {
  assertPurchaseConfirmed(snapshot, fixture, draft)
  const result = await readSql(`
    SELECT 'snapshot', CAST(id AS CHAR), CAST(period_id AS CHAR), snapshot_type,
      snapshot_key, version_no, status, CAST(confirmed_by AS CHAR),
      CAST(confirmed_at AS CHAR), snapshot_hash
    FROM cost_period_snapshot
    WHERE tenant_id=1 AND deleted=0 AND period_id=${id(fixture.periodId)}
      AND id=${id(snapshot.id)};
    SELECT 'line', source_module, source_type, source_id, source_line_id,
      product_code, quantity, material_amount, source_status, mapping_status, payload_json
    FROM cost_source_snapshot_line
    WHERE tenant_id=1 AND deleted=0 AND period_id=${id(fixture.periodId)}
      AND snapshot_id=${id(snapshot.id)} ORDER BY id
  `)
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'purchase-confirmed', ...result
  }]
  requireFact(result?.available === true && Array.isArray(result.rows),
    '已确认采购来源缺少只读数据库证据')
  const headers = result.rows.filter((row) => row[0] === 'snapshot')
  const lines = result.rows.filter((row) => row[0] === 'line')
  const header = headers[0]
  requireFact(headers.length === 1 && header[1] === snapshot.id &&
    header[2] === fixture.periodId && header[3] === 'SOURCE' &&
    header[4] === 'PURCHASE' && header[5] === fixture.versionNo &&
    header[6] === 'CONFIRMED' && /^[1-9]\d*$/.test(header[7]) &&
    BigInt(header[7]) <= 9223372036854775807n &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(header[8]) &&
    header[9] === snapshot.snapshotHash && lines.length === snapshot.lines.length,
  '数据库采购来源确认主表、真实确认人时间或哈希与正式API不一致')
  for (const line of snapshot.lines) {
    const matches = lines.filter((row) => row[1] === line.sourceModule &&
      row[2] === line.sourceType && row[3] === line.sourceId && row[4] === line.sourceLineId)
    requireFact(matches.length === 1 && matches[0][5] === line.productCode &&
      same(matches[0][6], line.quantity) && same(matches[0][7], line.materialAmount) &&
      matches[0][8] === 'CONFIRMED' && matches[0][9] === 'MAPPED',
    '数据库采购来源明细未确认、未映射或真实来源数量金额发生变化')
    const payload = JSON.parse(matches[0][10])
    requireFact(payload && payload.sourceModule === line.sourceModule &&
      payload.sourceType === line.sourceType && payload.sourceId === line.sourceId &&
      payload.sourceLineId === line.sourceLineId && payload.productCode === line.productCode &&
      same(payload.quantity, line.quantity) && same(payload.materialAmount, line.materialAmount),
    '数据库采购来源载荷未保留原始来源身份或数量金额')
    for (const field of ['invoicePriceStatus', 'invoicePriceScope']) {
      requireFact(payload[field] === line[field], `数据库采购来源载荷${field}与确认回读不一致`)
    }
    for (const field of [
      'invoiceAmount', 'invoiceExpectedAmount', 'invoicePriceDifference',
      'invoiceQuantity', 'invoiceUnitPrice', 'invoiceExpectedUnitPrice'
    ]) {
      requireFact((payload[field] == null && line[field] == null) ||
        (payload[field] != null && line[field] != null && same(payload[field], line[field])),
      `数据库采购来源载荷${field}与确认回读不一致`)
    }
  }
  return result
}

const verifyEmpty = async ({ api, fixture, caseRecord, readSql = runReadOnlySql, overflow = false }) => {
  const contract = { code: 422001, message: overflow
    ? `采购退回超过本期采购入库：${fixture.materialId}`
    : '本期没有可用的已审核采购入库或采购退回来源' }
  const result = await api.post(`/cost/periods/${id(fixture.periodId)}/source-snapshot/purchase/refresh`,
    undefined, { expectedBusinessRejection: contract })
  requireFact(matchesExpectedBusinessRejection(result, contract), '无来源/负净额未按精确业务契约阻断')
  const missing = { code: 422001, message: 'Source snapshot does not exist' }
  const snapshot = await api.get(snapshotPath(fixture), { expectedBusinessRejection: missing })
  requireFact(matchesExpectedBusinessRejection(snapshot, missing), '被阻断期间出现可确认采购快照')
  const database = await readSql(`
    SELECT 'snapshot', COUNT(*) FROM cost_period_snapshot
    WHERE tenant_id=1 AND deleted=0 AND period_id=${id(fixture.periodId)} AND snapshot_key='PURCHASE';
    SELECT 'lines', COUNT(*) FROM cost_source_snapshot_line
    WHERE tenant_id=1 AND deleted=0 AND period_id=${id(fixture.periodId)};
    SELECT 'publication', COUNT(*) FROM cost_publication
    WHERE tenant_id=1 AND deleted=0 AND period_id=${id(fixture.periodId)}
  `)
  requireFact(database.available && database.rows.length === 3 &&
    ['snapshot', 'lines', 'publication'].every((tag) =>
      database.rows.filter((row) => row[0] === tag && row[1] === '0').length === 1),
  '被阻断期间数据库残留了来源或正式发布')
  caseRecord.database = [...(caseRecord.database || []), { stage: overflow ? 'purchase-overflow' : 'purchase-empty', ...database }]
  return { periodId: fixture.periodId, month: fixture.month, rejection: result, noSnapshot: true }
}

export async function verifyPurchaseSourcePage ({ page, outputDir, record, fixture, snapshot, caseId }) {
  const writes = []
  const listener = (request) => {
    if (request.url().includes('/cost/workspace-states') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.method())
  }
  page.on('request', listener)
  try {
    await openRoute(page, `/cost-management/monthly/purchase-costing?periodId=${fixture.periodId}`, {
      readySelector: '[data-testid="formal-purchase-cost"]', retries: 1
    })
    const root = page.locator('[data-testid="formal-purchase-cost"]')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="formal-purchase-cost"]')
      return el?.dataset.loaded === 'true' || el?.dataset.error
    })
    requireFact(await root.getAttribute('data-error') === '', '采购正式页面加载失败')
    const response = page.waitForResponse((res) =>
      new URL(res.url()).pathname ===
        `/admin-api/cost/periods/${fixture.periodId}/source-snapshot/purchase/refresh` &&
      res.request().method() === 'POST')
    const [refreshed] = await Promise.all([
      response, root.locator('[data-testid="purchase-refresh-sources"]').click()
    ])
    const body = data(await refreshed.json(), '采购页面正式刷新')
    requireFact(refreshed.ok() && body.id === snapshot.id &&
      body.snapshotHash === snapshot.snapshotHash, '采购页面正式刷新结果改变了来源')
    await page.getByText(`已刷新 ${fixture.month} 的 ${snapshot.lines.length} 条采购来源`, {
      exact: true
    }).waitFor()
    const observation = await root.evaluate((el) => ({
      ...el.dataset,
      rows: [...el.querySelectorAll('[data-testid="purchase-source-row"]')].map((row) => {
        const cells = row.closest('tr').querySelectorAll('td')
        return { ...row.dataset, text: row.textContent.trim(),
          materialText: cells[5].textContent.trim().replaceAll(',', '') }
      })
    }))
    requireFact(observation.periodId === fixture.periodId && observation.month === fixture.month &&
      observation.modelId === fixture.modelId && observation.snapshotId === snapshot.id &&
      observation.status === 'DRAFT' && observation.rows.length === snapshot.lines.length &&
      observation.rows.length > 0 && writes.length === 0, '采购页面事实归属或正式保存链错误')
    for (const line of snapshot.lines) {
      const matches = observation.rows.filter((row) => row.sourceType === line.sourceType &&
        row.sourceId === line.sourceId && row.sourceLineId === line.sourceLineId)
      requireFact(matches.length === 1 && matches[0].text === line.sourceNo &&
        same(matches[0].quantity, line.quantity) &&
        same(matches[0].materialAmount, line.materialAmount) &&
        matches[0].materialText === costSourceAmountText(line.materialAmount),
      '采购页面来源行数量金额未正确展示')
    }
    await saveScreenshot(page, outputDir, `${caseId.toLowerCase()}-formal-purchase`, record)
    return { ...observation, workspaceWrites: writes }
  } finally {
    page.off('request', listener)
  }
}

export async function runCostPurchaseReceiptClosure (context, dependencies = {}) {
  const { api, record, caseRecord } = context
  const fixture = await preparePurchaseClosure(context, dependencies)
  const closure = { complete: false }
  caseRecord.fixtures.costPurchaseReceipt = closure
  const receipt = data(await api.getBusiness(`/erp/purchase-in/get?id=${fixture.purchaseInId}`), '采购入库')
  const wms = await resolveWmsPurchaseReceipt({ api, fixture })
  const snapshot = data(await api.postBusiness(
    `/cost/periods/${fixture.periodId}/source-snapshot/purchase/refresh`), '采购来源刷新')
  assertPurchaseReceipt(snapshot, fixture, receipt, wms)
  closure.wmsSource = wms
  requireFact(snapshot.lines.length === 1, '专属期间应仅有一条本轮入库来源')
  const reread = data(await api.getBusiness(snapshotPath(fixture)), '采购来源回读')
  requireFact(JSON.stringify(reread) === JSON.stringify(snapshot), '采购草稿写后回读不一致')
  await readPurchaseDatabase({ fixture, snapshot, caseRecord, readSql: dependencies.readSql })
  Object.assign(closure, { periodId: fixture.periodId, receipt, snapshot })
  check(caseRecord, COST_PURCHASE_SOURCE_CHECKS.receipt, { receipt: receipt.id, month: fixture.month })
  check(caseRecord, COST_PURCHASE_SOURCE_CHECKS.mapping, snapshot)
  check(caseRecord, COST_PURCHASE_SOURCE_CHECKS.draft, { status: snapshot.status, confirmedBy: snapshot.confirmedBy })
  const empty = await prepareEmpty(context, dependencies)
  closure.empty = await verifyEmpty({ api, fixture: empty, caseRecord, readSql: dependencies.readSql })
  check(caseRecord, COST_PURCHASE_SOURCE_CHECKS.empty, closure.empty)
  closure.browser = await (dependencies.verifyPage || verifyPurchaseSourcePage)({ ...context, fixture, snapshot })
  check(caseRecord, COST_PURCHASE_SOURCE_CHECKS.browser, closure.browser)
  closure.complete = true
}

const releaseOwnedReceipt = async ({ api, fixture, caseRecord }) => {
  const wmsRows = rows(await api.getBusiness(
    `/mes/stkIo/list?pageNo=1&pageSize=100&srcBillType=ErpPurchaseIn&srcBillId=${fixture.purchaseInId}`
  ), '采购WMS来源').filter((row) => String(row.srcBillType) === 'ErpPurchaseIn' &&
    String(row.srcBillId) === fixture.purchaseInId && Number(row.isEffective) === 1 &&
    Number(row.isVoided) === 0 && String(row.stockIoType) === '101')
  requireFact(wmsRows.length === 1, '采购退回夹具缺少唯一真实WMS入库')
  const wmsId = id(wmsRows[0].id)
  const entries = rows(await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${wmsId}`), '采购WMS明细')
  requireFact(entries.length === 1 && String(entries[0].materialId) === fixture.materialId,
    '采购WMS明细归属不正确')
  const inspections = rows(await api.getBusiness(
    `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100&srcBillId=${wmsId}&type=101`
  ), '采购入库检').filter((row) => String(row.srcBillId) === wmsId && Number(row.isVoided) === 0)
  requireFact(inspections.length === 1, '采购退回前未唯一命中专属入库检')
  const inspectionId = id(inspections[0].id)
  const inspection = data(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${inspectionId}`), '入库检详情')
  if (Number(inspection.isEffective) !== 1) {
    const inspectionEntries = rows(await api.getBusiness(
      `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${inspectionId}`), '入库检明细')
    const items = rows(await api.getBusiness(
      `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${inspectionId}`), '入库检项目')
    requireFact(inspectionEntries.length > 0 && items.length > 0, '入库检缺少正式明细项目')
    await api.putBusiness('/mes/quality/qualityInspection/edit/submit', {
      ...inspection, inspectionQty: 2, passQty: 2, concessionQty: 0, pendingJudgeQty: 0,
      inspector: '1', inspectionResult: '全部合格',
      qualityInspectionEntryList: inspectionEntries.map((row) => ({
        ...row, inspectionQty: row.qty, passQty: row.qty, concessionQty: 0, pendingJudgeQty: 0,
        finalResult: '全部合格', inspectionConclusion: '全部合格'
      })),
      qualityInspectionItemList: items.map((row) => ({
        ...row, inspectionQty: 2, passQty: 2, ngQty: 0,
        finalInspectionResult: row.inspectionResult || '1'
      }))
    })
    await checkInspection(api, caseRecord, inspectionId)
  }
  return { wmsId, entry: entries[0], inspectionId }
}

export const costPurchaseReturnRemark = (fixture, suffix) =>
  `C10R-${fixture.suffix}-${suffix}`

export const costPurchaseReturnEntryRemark = (fixture, suffix) =>
  `C10E-${fixture.suffix}-${suffix}`

export const buildCostPurchaseReturn = ({ fixture, entry, month, suffix }) => ({
  billNo: `E2E-C10-${fixture.suffix}-${suffix}`, billDate: `${month}-08`,
  srcBillType: 'PurOrder', srcBillId: fixture.purchaseOrderId,
  supplierId: fixture.supplierId, accountId: fixture.accountId,
  returnTime: `${month}-08T10:00:00`, returnType: 2, status: 0,
  discountPercent: 0, otherPrice: 0, totalCount: 1,
  totalProductPrice: 61.725, totalPrice: 61.725, totalTaxPrice: 0,
  remark: costPurchaseReturnRemark(fixture, suffix),
  items: [{
    entryNo: 1, srcBillType: 'PURCHASE_ORDER', srcBillId: fixture.purchaseOrderId,
    srcEntryId: fixture.orderItemId,
    warehouseId: String(entry.warehouseId),
    areaHouseId: nullableId(entry.wareAreaId),
    wareLocationId: nullableId(entry.wareLocationId),
    productId: fixture.materialId,
    productUnitId: fixture.unitId, productPrice: 61.725, count: 1,
    taxPercent: 0, totalPrice: 61.725, taxPrice: 0,
    remark: costPurchaseReturnEntryRemark(fixture, suffix)
  }]
})

const readReturn = async (api, returnId) => data(
  await api.getBusiness(`/erp/purchase-return/get?id=${id(returnId)}`), '采购退回回读')
const waitFor = async (read, predicate, label) => {
  const deadline = Date.now() + 60000
  do {
    const result = await read()
    if (predicate(result)) return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  } while (Date.now() < deadline)
  throw new Error(`${label}未达到正式状态`)
}

const createReturn = async ({ api, fixture, entry, month, suffix, record, caseRecord, closure }) => {
  const returnId = id(data(await api.postBusiness('/erp/purchase-return/create',
    buildCostPurchaseReturn({ fixture, entry, month, suffix })), '采购退回创建'))
  closure.ownedReturns.push({ id: returnId, month, suffix })
  let returned = await readReturn(api, returnId)
  if (Number(returned.isEffective) !== 1) {
    if (String(returned.billStage) === '14') {
      await api.putBusiness(`/erp/purchase-return/update-status?id=${returnId}&status=10`)
      returned = await readReturn(api, returnId)
    }
    if (Number(returned.isEffective) !== 1 && returned.processInstanceId) {
      await approveWmsProcess({
        api, processId: returned.processInstanceId, caseRecord, record,
        label: `COST-010 ${suffix}采购退回`, taskDefinitionKey: 'FirstApprove_purchase-return',
        stageApprovers: [
          { taskDefinitionKey: 'FirstApprove_purchase-return', username: config.warehouseApproverUsername, password: config.warehouseApproverPassword },
          { taskDefinitionKey: 'SecondApprove_purchase-return', username: config.warehouseApproverUsername, password: config.warehouseApproverPassword },
          { taskDefinitionKey: 'FinalApprove_purchase-return', username: config.warehouseFinalApproverUsername, password: config.warehouseFinalApproverPassword }
        ]
      })
    }
  }
  returned = await waitFor(() => readReturn(api, returnId),
    (value) => Number(value.isEffective) === 1, '采购退回审核')
  if (!['32', '34'].includes(String(returned.billStage))) {
    requireFact(returned.actions?.execute, '审核后采购退回缺少正式执行动作')
    await api.putBusiness(`/erp/purchase-return/execute?id=${returnId}`)
  }
  returned = await waitFor(() => readReturn(api, returnId),
    (value) => Number(value.status) === 20 && ['32', '34'].includes(String(value.billStage)),
    '采购退回执行')
  const wms = rows(await api.getBusiness(
    `/mes/stkIo/list?pageNo=1&pageSize=100&srcBillType=PurReturn&srcBillId=${returnId}`
  ), '退回WMS').filter((row) => String(row.srcBillType) === 'PurReturn' &&
    String(row.srcBillId) === returnId && String(row.stockIoType) === '301' &&
    Number(row.isEffective) === 1 && Number(row.isVoided) === 0)
  requireFact(wms.length === 1, '真实采购退回未形成唯一有效WMS出库')
  return { ...returned, wmsId: id(wms[0].id) }
}

export async function runCostPurchaseReturnClosure (context, dependencies = {}) {
  const { api, record, caseRecord } = context
  const fixture = await preparePurchaseClosure(context, dependencies)
  const closure = { complete: false, ownedReturns: [], cleanup: { complete: false, residuals: [] } }
  caseRecord.fixtures.costPurchaseReturn = closure
  try {
    const empty = await prepareEmpty(context, dependencies)
    const source = await (dependencies.releaseReceipt || releaseOwnedReceipt)({ api, fixture, caseRecord })
    closure.wmsSource = source
    const receipt = data(await api.getBusiness(`/erp/purchase-in/get?id=${fixture.purchaseInId}`), '采购入库')
    closure.returned = await (dependencies.createReturn || createReturn)({
      api, fixture, entry: source.entry, month: fixture.month, suffix: 'NORMAL', record, caseRecord, closure
    })
    const snapshot = data(await api.postBusiness(
      `/cost/periods/${fixture.periodId}/source-snapshot/purchase/refresh`), '入库退回刷新')
    const receiptLine = assertPurchaseReceipt(snapshot, fixture, receipt,
      { wmsId: id(source.wmsId), entryId: id(source.entry.id) })
    const returnLine = assertPurchaseReturn(snapshot, fixture, closure.returned)
    requireFact(snapshot.lines.length === 2, '采购净额夹具必须同时具有真实入库和退回两行')
    requireFact(costSourceDecimal(receiptLine.quantity) + costSourceDecimal(returnLine.quantity) === 100000000n &&
      costSourceDecimal(receiptLine.materialAmount) + costSourceDecimal(returnLine.materialAmount) > 0n,
    '同产品采购净额与本轮入库退回不符')
    const reread = data(await api.getBusiness(snapshotPath(fixture)), '入库退回草稿回读')
    requireFact(JSON.stringify(reread) === JSON.stringify(snapshot), '采购净额草稿写后回读不一致')
    await readPurchaseDatabase({ fixture, snapshot, caseRecord, readSql: dependencies.readSql })
    closure.snapshot = snapshot
    check(caseRecord, COST_PURCHASE_RETURN_CHECKS.receipt, receiptLine)
    check(caseRecord, COST_PURCHASE_RETURN_CHECKS.returned, closure.returned)
    check(caseRecord, COST_PURCHASE_RETURN_CHECKS.draft, { id: snapshot.id, status: snapshot.status })
    check(caseRecord, COST_PURCHASE_RETURN_CHECKS.net, { receiptLine, returnLine })
    closure.browser = await (dependencies.verifyPage || verifyPurchaseSourcePage)({ ...context, fixture, snapshot })
    check(caseRecord, COST_PURCHASE_RETURN_CHECKS.browser, closure.browser)
    closure.crossPeriod = await (dependencies.createReturn || createReturn)({
      api, fixture, entry: source.entry, month: empty.month, suffix: 'CROSS', record, caseRecord, closure
    })
    closure.overflow = await verifyEmpty({
      api, fixture: { ...empty, materialId: fixture.materialId }, caseRecord,
      readSql: dependencies.readSql, overflow: true
    })
    check(caseRecord, COST_PURCHASE_RETURN_CHECKS.overflow, {
      crossPeriod: closure.crossPeriod.id, originalReceiptMonth: fixture.month, ...closure.overflow
    })
    closure.complete = true
  } finally {
    for (const owned of [...closure.ownedReturns].reverse()) {
      try {
        const current = await readReturn(api, owned.id)
        requireFact(String(current.srcBillId) === fixture.purchaseOrderId &&
          current.remark === costPurchaseReturnRemark(fixture, owned.suffix),
        '退回清理所有权不匹配')
        await api.putBusiness('/erp/purchase-return/void', { id: owned.id })
        const after = await readReturn(api, owned.id)
        requireFact(Number(after.isVoided) === 0 && Number(after.isEffective) === 0 &&
          String(after.billStage) === '12',
        '采购退回弃审清理未正式回读')
        owned.voided = true
      } catch (error) {
        closure.complete = false
        closure.cleanup.residuals.push({ ...owned, reason: error.message })
      }
    }
    closure.cleanup.complete = closure.cleanup.residuals.length === 0
    if (!closure.cleanup.complete) throw new Error(
      `采购退回正式清理失败：${JSON.stringify(closure.cleanup.residuals)}`)
    caseRecord.notes.push('采购退回已通过正式弃审接口退回编制并回读；WMS出库保留审计，未SQL造单或删除事实')
  }
}
