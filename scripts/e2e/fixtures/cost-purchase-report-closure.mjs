import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import {
  createReviewer,
  loginAs,
  prepareCostScenario,
  resetCostScenarioCache
} from './cost-scenario.mjs'
import {
  assertPurchaseConfirmed,
  assertPurchaseReceipt,
  costSourceDecimal,
  readConfirmedPurchaseDatabase
} from './cost-purchase-source-closure.mjs'

export const COST_PURCHASE_REPORT_CHECKS = Object.freeze({
  fields: 'COST-012 采购成本正式报表包含发票价格状态、状态说明、比较范围和价差字段',
  aggregate: 'COST-012 发票价格状态按采购订单累计已生效开票金额比较',
  fallback: 'COST-012 无行级事实时正式报表标记订单级比较且不伪造行级单价',
  frozen: 'COST-012 正式报表只读取已发布采购来源且来源公式保留发票状态快照'
})

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data

const requireFact = (condition, message) => {
  if (!condition) throw new Error(message)
}

const exactId = (value, label) => {
  const text = typeof value === 'string'
    ? value
    : Number.isSafeInteger(value) ? String(value) : ''
  requireFact(/^[1-9]\d*$/.test(text) && BigInt(text) <= 9223372036854775807n,
    `${label} 未返回精确数字 ID`)
  return text
}

const sameMoney = (left, right) => costSourceDecimal(left) === costSourceDecimal(right)

const reviewerPermissions = [
  'cost:period:query',
  'cost:model:query',
  'cost:publication:query',
  'cost:trial:confirm',
  'cost:publication:publish'
]

const purchaseTrialPayload = ({ fixture, period }) => {
  requireFact(period && exactId(period.id, 'COST-012试算期间') === fixture.periodId &&
    String(period.accountingOrgId) === '1' && period.period === fixture.month &&
    String(period.modelVersionId) === fixture.modelId &&
    period.modelVersionNo === fixture.versionNo &&
    period.enterpriseType === fixture.period?.enterpriseType &&
    ['MANUFACTURING', 'TRADE'].includes(period.enterpriseType) &&
    period.status === 'ACCOUNTING',
  'COST-012试算期间、模型或企业类型归属不一致')
  return {
    enterpriseType: period.enterpriseType,
    periodId: fixture.periodId,
    modelVersion: period.modelVersionNo,
    requestId: `e2e-cost012-trial-${fixture.suffix}`
  }
}

const describePurchaseTrialSources = ({ fixture, period, closure }) => {
  purchaseTrialPayload({ fixture, period })
  assertPurchaseConfirmed(closure.confirmedSnapshot, fixture, closure.snapshot)
  assertPurchaseConfirmed(closure.rereadSnapshot, fixture, closure.snapshot)
  const purchase = sourceLine(closure.rereadSnapshot, fixture)
  const applicable = period.enterpriseType === 'TRADE'
  // This is a diagnostic, not permission to change the period or source type.
  // Manufacturing publication filters purchase rows too, so adding production
  // inputs would not make this purchase report complete.
  return {
    periodId: fixture.periodId,
    enterpriseType: period.enterpriseType,
    snapshotId: closure.rereadSnapshot.id,
    snapshotKey: closure.rereadSnapshot.snapshotKey,
    snapshotHash: closure.rereadSnapshot.snapshotHash,
    sourceType: purchase.sourceType,
    sourceId: purchase.sourceId,
    sourceLineId: purchase.sourceLineId,
    confirmedPurchaseSources: closure.rereadSnapshot.lines.length,
    applicablePurchaseSources: applicable ? closure.rereadSnapshot.lines.length : 0,
    publicationIncludesPurchaseSources: applicable,
    reason: applicable
      ? '已确认PURCHASE来源适用于既有TRADE期间，仍须通过正式试算和发布'
      : 'MANUFACTURING试算及发布均排除采购来源；补生产来源不能生成采购发布事实，需确认独立采购计算契约或授权贸易测试环境'
  }
}

const readInvoice = async (api, invoiceId) => dataOf(
  await api.getBusiness(`/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`),
  'COST-012采购发票'
)

const createAndAuditInvoice = async ({ api, record, caseRecord, fixture }) => {
  const invoiceNo = `E2E-C12-${fixture.suffix}-INV`
  const invoiceMoney = 100
  const invoiceId = exactId(
    dataOf(
      await api.postBusiness('/erp/purchase-invoice/create', {
        supplierId: String(fixture.supplierId),
        companyName: '',
        taxNo: '',
        invoiceNo,
        invoiceType: 1,
        taxRate: 0,
        invoiceMoney,
        invoicePrice: 50,
        isRubric: 0,
        remark: `${fixture.remark}:invoice`,
        items: [{
          purchaseOrderId: String(fixture.purchaseOrderId),
          srcBillType: 'ERP_PURCHASE_ORDER',
          invoiceMoneyItem: invoiceMoney
        }]
      }),
      'COST-012采购发票创建'
    ),
    'COST-012采购发票'
  )
  fixture.invoiceId = invoiceId
  let invoice = await readInvoice(api, invoiceId)
  requireFact(String(invoice.invoiceNo) === invoiceNo &&
    String(invoice.supplierId) === String(fixture.supplierId) &&
    String(invoice.srcBillType) === 'ERP_PURCHASE_ORDER' &&
    String(invoice.srcBillId) === String(fixture.purchaseOrderId) &&
    sameMoney(invoice.invoiceMoney, invoiceMoney),
  'COST-012采购发票来源、供应商或金额回读不一致')

  if (Number(invoice.isEffective) !== 1) {
    if (invoice.processInstanceId) {
      await approveWmsProcess({
        api,
        processId: invoice.processInstanceId,
        caseRecord,
        record,
        label: 'COST-012采购发票',
        taskDefinitionKey: 'FirstApprove_purchase-invoice',
        stageApprovers: [
          {
            taskDefinitionKey: 'FirstApprove_purchase-invoice',
            username: config.financeApproverUsername,
            password: config.financeApproverPassword
          },
          {
            taskDefinitionKey: 'SecondApprove_purchase-invoice',
            username: config.financeApproverUsername,
            password: config.financeApproverPassword
          },
          {
            taskDefinitionKey: 'FinalApprove_purchase-invoice',
            username: config.finalApproverUsername,
            password: config.finalApproverPassword
          }
        ],
        reason: 'COST-012采购成本报表专属发票复核'
      })
    } else {
      await api.putBusiness(
        `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoiceId)}`
      )
    }
    invoice = await readInvoice(api, invoiceId)
  }
  requireFact(Number(invoice.isEffective) === 1 && Number(invoice.isVoided) !== 1,
    'COST-012采购发票未形成已生效事实')
  return { invoiceId, invoice, invoiceMoney }
}

const sourceLine = (snapshot, fixture) => {
  const lines = snapshot?.lines
  requireFact(Array.isArray(lines) && lines.length > 0, 'COST-012采购来源快照为空')
  const matches = lines.filter((row) =>
    row.sourceType === 'PURCHASE_RECEIPT' &&
    String(row.sourceId) === String(fixture.purchaseInId))
  requireFact(matches.length === 1, 'COST-012正式采购来源缺少或重复本轮入库行')
  return matches[0]
}

const prepareInvoiceSnapshot = async ({
  api, fixture, invoice, receipt, closure, caseRecord, readSql
}) => {
  const snapshot = dataOf(
    await api.postBusiness(
      `/cost/periods/${fixture.periodId}/source-snapshot/purchase/refresh`
    ),
    'COST-012采购来源刷新'
  )
  closure.snapshot = snapshot
  assertPurchaseReceipt(snapshot, fixture, receipt)
  requireFact(snapshot.lines.length === 1, 'COST-012专属期间必须只有本轮采购来源')
  const line = sourceLine(snapshot, fixture)
  requireFact(snapshot.snapshotKey === 'PURCHASE' &&
    snapshot.versionNo === fixture.versionNo &&
    snapshot.status === 'DRAFT' &&
    line.sourceModule === 'ERP' &&
    line.sourceStatus === 'DRAFT' &&
    line.invoicePriceStatus === 'PARTIAL_INVOICE' &&
    line.invoicePriceScope === 'PURCHASE_ORDER' &&
    sameMoney(line.invoiceAmount, invoice.invoiceMoney) &&
    sameMoney(line.invoiceExpectedAmount, 123.45) &&
    sameMoney(line.invoicePriceDifference, 0),
  `COST-012采购来源发票快照不符合订单级累计口径：${JSON.stringify({
    status: line.invoicePriceStatus,
    scope: line.invoicePriceScope,
    amount: line.invoiceAmount,
    expected: line.invoiceExpectedAmount,
    difference: line.invoicePriceDifference
  })}`)
  const confirmed = dataOf(
    await api.postBusiness(
      `/cost/periods/${fixture.periodId}/source-snapshot/confirm` +
      `?snapshotKey=PURCHASE&versionNo=${encodeURIComponent(fixture.versionNo)}`
    ),
    'COST-012采购来源确认'
  )
  closure.confirmedSnapshot = confirmed
  assertPurchaseConfirmed(confirmed, fixture, snapshot)
  const reread = dataOf(
    await api.getBusiness(`/cost/periods/${fixture.periodId}/source-snapshot` +
      `?snapshotKey=PURCHASE&versionNo=${encodeURIComponent(fixture.versionNo)}`),
    'COST-012已确认采购来源回读'
  )
  closure.rereadSnapshot = reread
  assertPurchaseConfirmed(reread, fixture, snapshot)
  closure.confirmedSnapshot = reread
  closure.confirmedDatabase = await readConfirmedPurchaseDatabase({
    fixture, snapshot: reread, draft: snapshot, caseRecord, readSql
  })
  return { snapshot, line, confirmed }
}

const publishOwnedPurchaseScenario = async ({
  api, record, caseRecord, fixture, closure, dependencies = {}
}) => {
  const period = dataOf(
    await api.getBusiness(`/cost/periods/${fixture.periodId}`),
    'COST-012采购成本试算期间'
  )
  const payload = purchaseTrialPayload({ fixture, period })
  closure.trialSourceReadiness = describePurchaseTrialSources({ fixture, period, closure })
  closure.trialRequest = payload
  const trialPath = `/cost/periods/${fixture.periodId}/trials`
  let trial
  try {
    trial = dataOf(
      await api.postBusiness(trialPath, payload),
      'COST-012采购成本试算'
    )
  } catch (error) {
    closure.trialFailure = { pathname: trialPath, message: error.message }
    throw error
  }
  closure.trial = trial
  const trialPeriod = dataOf(
    await api.getBusiness(`/cost/periods/${fixture.periodId}`),
    'COST-012采购成本试算期间'
  )
  requireFact(String(trialPeriod.currentTrialId) === String(trial.trialId || trial.id),
    'COST-012试算未绑定到专属期间')
  const reviewer = await (dependencies.createReviewer || createReviewer)({
    api,
    record,
    fixture,
    key: 'reviewer',
    loginImmediately: false,
    permissions: reviewerPermissions,
    suffix: fixture.suffix
  })
  const reviewerToken = await (dependencies.loginAs || loginAs)(
    record, reviewer.username, reviewer.password
  )
  const reviewerApi = (dependencies.createApiClient || createApiClient)({ token: reviewerToken, record })
  const confirmed = dataOf(
    await reviewerApi.request(
      'POST',
      `/cost/trials/${trialPeriod.currentTrialId}/confirm`,
      undefined,
      {
        headers: {
          'If-Match': String(trialPeriod.version),
          'X-Request-Id': `e2e-cost012-confirm-${fixture.suffix}`
        }
      }
    ),
    'COST-012试算确认'
  )
  requireFact(String(confirmed.periodId) === String(fixture.periodId),
    'COST-012试算确认期间不一致')
  const publishPeriod = dataOf(
    await api.getBusiness(`/cost/periods/${fixture.periodId}`),
    'COST-012发布前期间'
  )
  const published = dataOf(
    await reviewerApi.request(
      'POST',
      `/cost/periods/${fixture.periodId}/publications`,
      undefined,
      {
        headers: {
          'If-Match': String(publishPeriod.version),
          'X-Request-Id': `e2e-cost012-publish-${fixture.suffix}`
        }
      }
    ),
    'COST-012采购成本发布'
  )
  fixture.publicationId = exactId(published.publicationId, 'COST-012采购成本发布')
  fixture.period = dataOf(
    await api.getBusiness(`/cost/periods/${fixture.periodId}`),
    'COST-012采购成本发布期间'
  )
  requireFact(fixture.period.status === 'COST_PUBLISHED' &&
    String(fixture.period.currentPublicationId) === fixture.publicationId,
  'COST-012采购成本发布未绑定当前期间')
  return { reviewer, trial, confirmed, published }
}

const readPublishedReport = async (api, fixture) => {
  const report = dataOf(
    await api.getBusiness(`/cost/reports/purchase-cost-report/${fixture.periodId}`),
    'COST-012采购成本正式报表'
  )
  requireFact(report.reportKey === 'purchase-cost-report' &&
    report.formal === true &&
    String(report.publicationId) === fixture.publicationId &&
    Array.isArray(report.rows) && report.rows.length > 0,
  'COST-012正式报表没有绑定专属发布批次的真实行')
  const values = report.rows.map((row) => row?.values || {})
  requireFact(values.every((row) =>
    Object.hasOwn(row, 'invoicePriceStatus') &&
    Object.hasOwn(row, 'invoicePriceStatusText') &&
    Object.hasOwn(row, 'invoicePriceScope') &&
    Object.hasOwn(row, 'invoicePriceScopeText') &&
    Object.hasOwn(row, 'invoicePriceDifference')
  ), 'COST-012正式报表发票比较字段不完整')
  const row = values.find((value) => String(value.receiptNo || '') === String(fixture.receiptNo))
  requireFact(row, 'COST-012正式报表缺少本轮采购入库来源行')
  requireFact(row.invoicePriceStatus === 'PARTIAL_INVOICE' &&
    row.invoicePriceStatusText === '部分开票' &&
    row.invoicePriceScope === 'PURCHASE_ORDER' &&
    row.invoicePriceScopeText === '采购订单级比较' &&
    sameMoney(row.invoiceAmount, 100) &&
    sameMoney(row.invoiceExpectedAmount, 123.45) &&
    sameMoney(row.invoicePriceDifference, 0),
  `COST-012正式报表发票比较事实不一致：${JSON.stringify(row)}`)
  return { report, row }
}

const readPublicationFormula = async ({ fixture, caseRecord, readSql = runReadOnlySql }) => {
  const result = await readSql(`
    SELECT source_id, source_line_id, formula_json
    FROM cost_publication_source_fact
    WHERE tenant_id=1 AND deleted=0 AND publication_id=${exactId(fixture.publicationId, 'COST-012发布批次')}
      AND source_type='PURCHASE_RECEIPT'
    ORDER BY id
  `)
  requireFact(result.available && result.rows.length > 0,
    'COST-012正式发布来源事实缺少采购行')
  const owned = result.rows.filter((row) =>
    String(row[0]) === String(fixture.purchaseInId))
  requireFact(owned.length === 1 &&
    String(owned[0][2]).includes('"invoicePriceStatus"') &&
    String(owned[0][2]).includes('"invoicePriceScope"') &&
    String(owned[0][2]).includes('PURCHASE_ORDER'),
  'COST-012发布来源公式没有保留发票比较快照')
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'cost012-published-invoice-formula',
    ...result
  }]
  return { sourceRows: result.rows.length, formula: owned[0][2] }
}

const verifyPurchaseReportPage = async ({ page, outputDir, record, fixture, report }) => {
  await openRoute(page,
    `/cost-management/results/purchase-cost-report?periodId=${encodeURIComponent(fixture.periodId)}`,
    { readySelector: '[data-testid="formal-cost-report"]', retries: 1 })
  const root = page.locator('[data-testid="formal-cost-report"]')
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="formal-cost-report"]')
    return element?.dataset.formal === 'true' && Number(element.dataset.reportRowCount) > 0
  })
  const observation = await root.evaluate((element) => ({
    period: element.dataset.reportPeriod,
    backendPeriodId: element.dataset.backendPeriodId,
    formal: element.dataset.formal,
    rowCount: Number(element.dataset.reportRowCount),
    text: element.textContent || ''
  }))
  const first = report.rows[0]?.values || {}
  requireFact(observation.period === report.period &&
    observation.backendPeriodId === fixture.periodId &&
    observation.formal === 'true' &&
    observation.rowCount === report.rows.length &&
    observation.text.includes(String(first.invoicePriceStatusText)) &&
    observation.text.includes(String(first.invoicePriceScopeText)),
  `COST-012正式页面未展示同期间真实报表行：${JSON.stringify(observation)}`)
  await saveScreenshot(page, outputDir, 'cost012-formal-purchase-report', record)
  return observation
}

export async function runCostPurchaseReportClosure (context, dependencies = {}) {
  const { api, record, caseRecord } = context
  requireFact(config.target === 'local' && String(config.tenantId) === '1' &&
    String(record.environment?.tenantId) === '1' &&
    process.env.CFOR_E2E_WRITE_FIXTURES === 'true',
  'BLOCKED: COST-012采购报表写侧仅允许显式开启的local tenant1')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  resetCostScenarioCache()
  const fixture = await (dependencies.prepareCostScenario || prepareCostScenario)({
    api, record, caseRecord, scenario: 'purchase'
  })
  const closure = { complete: false, periodId: fixture.periodId }
  caseRecord.fixtures.costPurchaseReport = closure
  const invoice = await createAndAuditInvoice({
    api, record, caseRecord, fixture
  })
  closure.invoiceId = invoice.invoiceId
  const receipt = dataOf(
    await api.getBusiness(`/erp/purchase-in/get?id=${fixture.purchaseInId}`),
    'COST-012采购入库'
  )
  requireFact(typeof receipt.no === 'string' && receipt.no.trim() !== '',
    'COST-012采购入库缺少正式单号')
  fixture.receiptNo = receipt.no
  const source = await prepareInvoiceSnapshot({
    api, fixture, invoice, receipt, closure, caseRecord, readSql: dependencies.readSql
  })
  const publication = await publishOwnedPurchaseScenario({
    api, record, caseRecord, fixture, closure, dependencies
  })
  const reportEvidence = await readPublishedReport(api, fixture)
  const formula = await readPublicationFormula({
    fixture, caseRecord, readSql: dependencies.readSql
  })
  const pageEvidence = await (dependencies.verifyPage || verifyPurchaseReportPage)({
    ...context, fixture, report: reportEvidence.report
  })
  const checks = [
    [COST_PURCHASE_REPORT_CHECKS.fields, reportEvidence.report.rows.length > 0],
    [COST_PURCHASE_REPORT_CHECKS.aggregate,
      reportEvidence.row.invoicePriceStatus === 'PARTIAL_INVOICE' &&
      sameMoney(reportEvidence.row.invoiceAmount, invoice.invoiceMoney)],
    [COST_PURCHASE_REPORT_CHECKS.fallback,
      reportEvidence.row.invoicePriceScope === 'PURCHASE_ORDER' &&
      reportEvidence.row.invoiceUnitPrice == null],
    [COST_PURCHASE_REPORT_CHECKS.frozen,
      formula.sourceRows > 0 && pageEvidence.formal === 'true']
  ]
  for (const [name, passed] of checks) {
    caseRecord.checks.push({
      name,
      passed,
      details: JSON.stringify({
        periodId: fixture.periodId,
        publicationId: fixture.publicationId,
        invoiceId: invoice.invoiceId,
        pageRows: pageEvidence.rowCount,
        sourceRows: formula.sourceRows
      })
    })
    if (!passed) throw new Error(`${name} 未通过`)
  }
  Object.assign(closure, {
    complete: true,
    periodId: fixture.periodId,
    publicationId: fixture.publicationId,
    invoiceId: invoice.invoiceId,
    snapshotId: source.confirmed.id,
    report: reportEvidence.report,
    page: pageEvidence
  })
  caseRecord.evidence.push(
    `COST-012正式采购报表：period=${fixture.periodId}; publication=${fixture.publicationId}; ` +
    `invoice=${invoice.invoiceId}; snapshot=${source.confirmed.id}`
  )
  caseRecord.notes.push(
    'COST-012使用正式采购入库、采购发票、PURCHASE来源快照、试算确认和成本发布链路；' +
    '发票未提供行级占用快照，报表按采购订单级比较，未伪造行级单价'
  )
  return { fixture, invoice, source, publication, report: reportEvidence.report, page: pageEvidence }
}

export const __test = Object.freeze({
  sameMoney,
  sourceLine,
  reviewerPermissions,
  purchaseTrialPayload,
  describePurchaseTrialSources,
  prepareInvoiceSnapshot,
  publishOwnedPurchaseScenario,
  readPublishedReport
})
