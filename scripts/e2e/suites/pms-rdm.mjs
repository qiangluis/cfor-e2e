import { createApiClient } from '../lib/api.mjs'
import { login, openRoute } from '../lib/browser.mjs'

export const cases = [
  'RDM-001',
  'RDM-002',
  'RDM-003',
  'RDM-004',
  'RDM-005',
  'RDM-006',
  'RDM-007'
]

const CANONICAL_PROJECT_STATUSES = new Set([
  'DRAFT',
  'INITIATED',
  'RUNNING',
  'PAUSED',
  'CLOSED',
  'CANCELLED'
])
const LEGACY_PROJECT_STATUSES = new Set([
  'REVIEW',
  'APPROVING',
  'PILOT',
  'MASS',
  'DONE',
  'ARCHIVED',
  'EXECUTING'
])

const readPage = (payload) => {
  const data = payload?.data ?? payload
  const rows = Array.isArray(data?.list)
    ? data.list
    : Array.isArray(data?.records)
      ? data.records
      : []
  return { total: data?.total, rows }
}

export const runCase = async ({ caseId, page, record, caseRecord }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'RDM-001') {
    const requirementPage = readPage(
      await api.getBusiness('/pm/requirement/page?pageNo=1&pageSize=100')
    )
    caseRecord.checks.push({
      name: '需求分页接口返回分页结构且 pageSize 不超过 100',
      passed: typeof requirementPage.total === 'number' && requirementPage.rows.length <= 100,
      details: JSON.stringify({ total: requirementPage.total, count: requirementPage.rows.length })
    })
    caseRecord.evidence.push('真实登录与需求分页接口契约校验（PB-333）')
  }

  if (caseId === 'RDM-002') {
    const taskPage = readPage(await api.getBusiness('/pm/task/page?pageNo=1&pageSize=100'))
    const blockedRows = taskPage.rows.filter((row) => row?.status === 'BLOCKED')
    caseRecord.checks.push({
      name: '任务分页接口返回阻塞任务的解除条件字段',
      passed:
        typeof taskPage.total === 'number' &&
        taskPage.rows.length <= 100 &&
        blockedRows.every((row) => Object.prototype.hasOwnProperty.call(row, 'releaseCondition')),
      details: JSON.stringify({ total: taskPage.total, blocked: blockedRows.length })
    })
    caseRecord.evidence.push('真实登录与任务分页接口契约校验（PB-334）')
  }

  if (caseId === 'RDM-003') {
    const projectPage = readPage(
      await api.getBusiness('/plm/rdm/project/ledger/page?pageNo=1&pageSize=100')
    )
    const invalidStatuses = projectPage.rows
      .map((row) => String(row?.status || '').toUpperCase())
      .filter((status) => !CANONICAL_PROJECT_STATUSES.has(status) && !LEGACY_PROJECT_STATUSES.has(status))
    caseRecord.checks.push({
      name: '研发项目分页返回六状态或历史兼容状态',
      passed:
        typeof projectPage.total === 'number' &&
        projectPage.rows.length <= 100 &&
        invalidStatuses.length === 0,
      details: JSON.stringify({
        total: projectPage.total,
        count: projectPage.rows.length,
        invalidStatuses
      })
    })
    caseRecord.evidence.push('真实登录与研发项目六状态分页契约校验（PB-332）')
  }

  if (caseId === 'RDM-004') {
    const changePage = readPage(await api.getBusiness('/pm/change/page?pageNo=1&pageSize=100'))
    const versionChanges = changePage.rows.filter((row) => row?.iterationId != null)
    const missingImpact = versionChanges.filter(
      (row) =>
        !row?.impactTest ||
        !row?.impactMaterial ||
        !row?.impactDelivery ||
        !row?.impactCost ||
        !row?.targetScopeJson
    )
    caseRecord.checks.push({
      name: '版本范围变更单返回迭代、四类影响评估和目标范围快照',
      passed:
        typeof changePage.total === 'number' &&
        changePage.rows.length <= 100 &&
        missingImpact.length === 0,
      details: JSON.stringify({
        total: changePage.total,
        versionChanges: versionChanges.length,
        missingImpact: missingImpact.map((row) => row?.changeNo || row?.id)
      })
    })
    caseRecord.evidence.push('真实登录与版本范围变更单契约校验（PB-335）')
  }

  if (caseId === 'RDM-005') {
    const ebomPage = readPage(await api.getBusiness('/plm/core/ebom/page?pageNo=1&pageSize=100'))
    const missingApprovalFields = ebomPage.rows.filter(
      (row) =>
        !Object.prototype.hasOwnProperty.call(row, 'approvalStatus') ||
        !Object.prototype.hasOwnProperty.call(row, 'effectiveDate') ||
        !Object.prototype.hasOwnProperty.call(row, 'expiryDate')
    )
    caseRecord.checks.push({
      name: '研发 BOM 行返回审批状态与生效/失效日期结构化字段',
      passed:
        typeof ebomPage.total === 'number' &&
        ebomPage.rows.length <= 100 &&
        missingApprovalFields.length === 0,
      details: JSON.stringify({
        total: ebomPage.total,
        count: ebomPage.rows.length,
        missing: missingApprovalFields.map((row) => row?.id)
      })
    })
    const approvalPage = readPage(
      await api.getBusiness('/plm/rdm/record/page?bizTypes=APPROVAL&pageNo=1&pageSize=100')
    )
    const missingTrialBatchFields = approvalPage.rows.filter(
      (row) =>
        !Object.prototype.hasOwnProperty.call(row, 'planId') ||
        !Object.prototype.hasOwnProperty.call(row, 'runId')
    )
    caseRecord.checks.push({
      name: '试制领料申请返回 planId/runId 试制批次关联字段',
      passed:
        typeof approvalPage.total === 'number' &&
        approvalPage.rows.length <= 100 &&
        missingTrialBatchFields.length === 0,
      details: JSON.stringify({
        total: approvalPage.total,
        count: approvalPage.rows.length,
        missing: missingTrialBatchFields.map((row) => row?.bizNo || row?.id)
      })
    })
    caseRecord.evidence.push('真实登录与研发 BOM 审批/试制批次契约校验（PB-336）')
  }

  if (caseId === 'RDM-006') {
    const releasePage = readPage(await api.getBusiness('/pm/release/page?pageNo=1&pageSize=100'))
    const releases = releasePage.rows
    let passed = typeof releasePage.total === 'number' && releases.length <= 100
    let details = { total: releasePage.total, count: releases.length, gateChecked: false }
    if (passed && releases.length > 0) {
      const releaseId = releases[0]?.id
      const gate = await api.getBusiness(`/pm/release/gate?id=${encodeURIComponent(releaseId)}`)
      const gateData = gate?.data ?? gate
      passed =
        typeof gateData?.passed === 'boolean' &&
        Array.isArray(gateData?.blockReasons) &&
        Object.prototype.hasOwnProperty.call(gateData, 'requirementCoverage') &&
        Object.prototype.hasOwnProperty.call(gateData, 'criticalBugOpenCount') &&
        Object.prototype.hasOwnProperty.call(gateData, 'artifactFrozen')
      details = { ...details, releaseId, gateChecked: true, passed: gateData?.passed }
    }
    caseRecord.checks.push({
      name: '发布门禁返回需求覆盖、关键缺陷、验证结论与不可变冻结字段',
      passed,
      details: JSON.stringify(details)
    })
    caseRecord.evidence.push('真实登录与发布门禁契约校验（PB-337）')
  }

  if (caseId === 'RDM-007') {
    await openRoute(page, '/reports/project/project-plan/progress-efficiency')
    const reportPage = page.locator('[data-testid="pm-report-progress-efficiency"]').first()
    await reportPage.waitFor({ state: 'visible' })
    const reportPageText = await reportPage.innerText()
    const expectedPageTexts = [
      '研发进度与效率报表',
      '需求平均周期',
      '任务完成率',
      '版本准时率',
      '缺陷密度',
      '研发工时',
      '研发团队',
      '统计日期'
    ]
    const missingPageTexts = expectedPageTexts.filter((text) => !reportPageText.includes(text))
    caseRecord.checks.push({
      name: '研发进度与效率报表页面展示五类指标和项目维度筛选',
      passed: missingPageTexts.length === 0,
      details: JSON.stringify({ missingPageTexts })
    })

    const reportPayload = await api.getBusiness('/pm/report/progress-efficiency')
    const report = reportPayload?.data ?? reportPayload
    const metricKeys = [
      'requirementAverageCycleDays',
      'taskCompletionRate',
      'versionOnTimeRate',
      'defectDensity',
      'rdWorkHours'
    ]
    const missingMetricFields = metricKeys.filter(
      (key) => !Object.prototype.hasOwnProperty.call(report, key)
    )
    caseRecord.checks.push({
      name: '研发进度与效率报表返回口径版本、五类指标、过滤条件和数据提示',
      passed:
        typeof report?.metricVersion === 'number' &&
        typeof report?.projectCount === 'number' &&
        missingMetricFields.length === 0 &&
        Array.isArray(report?.warnings) &&
        report?.appliedFilters !== null &&
        typeof report?.appliedFilters === 'object',
      details: JSON.stringify({
        metricVersion: report?.metricVersion,
        projectCount: report?.projectCount,
        missingMetricFields,
        warningCount: report?.warnings?.length
      })
    })

    const definitionPayload = await api.getBusiness('/pm/report/metric-definitions')
    const definition = definitionPayload?.data ?? definitionPayload
    const metricCodes = new Set((definition?.metrics || []).map((item) => item?.code))
    caseRecord.checks.push({
      name: '研发统计口径定义与报表使用同一版本并返回五类指标',
      passed:
        definition?.metricVersion === report?.metricVersion &&
        metricKeys.every((key) => metricCodes.has(key)),
      details: JSON.stringify({
        configCode: definition?.configCode,
        metricVersion: definition?.metricVersion,
        metricCodes: Array.from(metricCodes)
      })
    })
    caseRecord.evidence.push('真实登录、报表页面与研发进度效率指标契约校验（PB-338）')
  }

  return { token, api }
}
