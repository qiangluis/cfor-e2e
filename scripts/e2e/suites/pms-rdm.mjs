import { createApiClient } from '../lib/api.mjs'
import { login, openRoute } from '../lib/browser.mjs'
import {
  RDM_CASES, runRdmWriteCase, initializeRdmAssertions, finalizeRdmAssertions,
  createRdmReportFixture, verifyRdmReportFixture, RDM_METRIC_FORMULAS, matchesRdmMetricTruth
} from '../fixtures/rdm.mjs'

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

export const RDM_UNTESTED_STEPS = {
  'RDM-001': '未测需求创建/登记完整性、进入评审、四种结论写入、缺理由拒绝、暂缓重评及数据库前后值。',
  'RDM-002': '未测阻塞写入、缺解除条件拒绝、恢复清空阻塞字段、重复恢复、权限与数据库前后值。',
  'RDM-003': '未测项目创建、合法/非法状态流转、终态保护、历史状态兼容写入及数据库前后值。',
  'RDM-004': '未测变更单创建、四类影响缺失拒绝、LOCKED 快照校验、审批新增快照、历史保护及并发唯一性。',
  'RDM-005': '未测 BOM 行审批/生效校验、生产 BOM 预览阻塞与放行、试制领料写入及 MES/WMS 批次回写。',
  'RDM-006': '未测发布创建、真实门禁阻塞条件、审批放行写入指纹与冻结、冻结后修改拒绝及缺陷延期闭环。'
}

const hasOwn = (value, key) =>
  Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key))

const nonEmpty = (value) =>
  value !== undefined && value !== null && String(value).trim() !== ''

export const readPage = (payload) => {
  const data = payload?.data ?? payload
  const rows = Array.isArray(data?.list)
    ? data.list
    : Array.isArray(data?.records)
      ? data.records
      : []
  return { total: data?.total, rows }
}

export const readArray = (payload) => {
  const data = payload?.data ?? payload
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.records)) return data.records
  return []
}

export const flattenTreeRows = (rows) => {
  const result = []
  const visit = (items) => {
    for (const row of items) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      result.push(row)
      if (Array.isArray(row.children)) visit(row.children)
    }
  }
  visit(Array.isArray(rows) ? rows : [])
  return result
}

const addCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
}

const addGap = (caseRecord, message) => {
  caseRecord.notes.push(`缺前置：${message}`)
}

const pageDetails = ({ total, rows }) => JSON.stringify({
  total: typeof total === 'number' ? total : null,
  count: rows.length
})

const addPageShapeCheck = (caseRecord, name, page) => {
  addCheck(
    caseRecord,
    name,
    typeof page.total === 'number' && page.total >= 0 && page.rows.length <= 100,
    pageDetails(page)
  )
}

const markPartial = (caseRecord, caseId) => {
  caseRecord.notes.push(
    `PARTIAL：当前仅执行只读接口证据；${RDM_UNTESTED_STEPS[caseId]}`
  )
}

export const runRdmEvidenceContract = async ({ caseId, api, caseRecord }) => {
  if (!RDM_UNTESTED_STEPS[caseId]) return { partial: false }

  initializeRdmAssertions(caseRecord, caseId)
  markPartial(caseRecord, caseId)

  if (caseId === 'RDM-001') {
    const requirementPage = readPage(
      await api.getBusiness('/pm/requirement/page?pageNo=1&pageSize=100')
    )
    addPageShapeCheck(caseRecord, '需求分页接口返回分页结构且 pageSize 不超过 100', requirementPage)
    if (!requirementPage.rows.length) {
      addGap(caseRecord, '需求分页为空，未验证 reviewConclusion/reviewReason 字段。')
    } else {
      const missingReviewFields = requirementPage.rows.filter(
        (row) => !hasOwn(row, 'reviewConclusion') || !hasOwn(row, 'reviewReason')
      )
      addCheck(
        caseRecord,
        '需求响应包含 reviewConclusion/reviewReason 字段（允许 null 或空值）',
        missingReviewFields.length === 0,
        JSON.stringify({ sampleCount: requirementPage.rows.length, missingFieldRows: missingReviewFields.length })
      )
    }
    caseRecord.evidence.push('真实登录与需求分页及评审字段契约校验（PB-333；仅只读）')
  }

  if (caseId === 'RDM-002') {
    const taskPage = readPage(await api.getBusiness('/pm/task/page?pageNo=1&pageSize=100'))
    addPageShapeCheck(caseRecord, '任务分页接口返回分页结构且 pageSize 不超过 100', taskPage)
    if (!taskPage.rows.length) {
      addGap(caseRecord, '任务分页为空，未验证 BLOCKED 任务的 releaseCondition。')
    } else {
      const blockedRows = taskPage.rows.filter((row) => row?.status === 'BLOCKED')
      if (!blockedRows.length) {
        addGap(caseRecord, '任务分页没有 BLOCKED 样本，未验证解除条件字段和值。')
      } else {
        const invalidBlockedRows = blockedRows.filter(
          (row) => !hasOwn(row, 'releaseCondition') || !nonEmpty(row.releaseCondition)
        )
        addCheck(
          caseRecord,
          '阻塞任务返回非空 releaseCondition 字段',
          invalidBlockedRows.length === 0,
          JSON.stringify({ blockedCount: blockedRows.length, invalidCount: invalidBlockedRows.length })
        )
      }
    }
    caseRecord.evidence.push('真实登录与任务分页阻塞字段契约校验（PB-334；仅只读）')
  }

  if (caseId === 'RDM-003') {
    const projectPage = readPage(
      await api.getBusiness('/plm/rdm/project/ledger/page?pageNo=1&pageSize=100')
    )
    addPageShapeCheck(caseRecord, '研发项目分页接口返回分页结构且 pageSize 不超过 100', projectPage)
    if (!projectPage.rows.length) {
      addGap(caseRecord, '研发项目分页为空，未验证六状态及历史兼容状态。')
    } else {
      const invalidStatuses = projectPage.rows
        .map((row) => String(row?.status || '').toUpperCase())
        .filter((status) => !CANONICAL_PROJECT_STATUSES.has(status) && !LEGACY_PROJECT_STATUSES.has(status))
      addCheck(
        caseRecord,
        '研发项目分页返回六状态或历史兼容状态',
        invalidStatuses.length === 0,
        JSON.stringify({ sampleCount: projectPage.rows.length, invalidCount: invalidStatuses.length })
      )
    }
    caseRecord.evidence.push('真实登录与研发项目状态分页契约校验（PB-332；仅只读）')
  }

  if (caseId === 'RDM-004') {
    const changePage = readPage(await api.getBusiness('/pm/change/page?pageNo=1&pageSize=100'))
    addPageShapeCheck(caseRecord, '版本变更分页接口返回分页结构且 pageSize 不超过 100', changePage)
    if (!changePage.rows.length) {
      addGap(caseRecord, '版本变更分页为空，未验证迭代范围变更及审批快照字段。')
    } else {
      const versionChanges = changePage.rows.filter(
        (row) => row?.iterationId != null || row?.targetScopeJson != null || row?.approvedSnapshotId != null
      )
      if (!versionChanges.length) {
        addGap(caseRecord, '分页没有可识别的版本范围变更样本，未验证四类影响和 approvedSnapshotId。')
      } else {
        const invalidRows = versionChanges.filter(
          (row) =>
            row?.iterationId == null ||
            !nonEmpty(row.targetScopeJson) ||
            !nonEmpty(row.impactTest) ||
            !nonEmpty(row.impactMaterial) ||
            !nonEmpty(row.impactDelivery) ||
            !nonEmpty(row.impactCost) ||
            !hasOwn(row, 'approvedSnapshotId')
        )
        addCheck(
          caseRecord,
          '版本范围变更返回迭代、四类影响评估、目标范围及 approvedSnapshotId 字段（审批前允许 null）',
          invalidRows.length === 0,
          JSON.stringify({ sampleCount: versionChanges.length, invalidCount: invalidRows.length })
        )
      }
    }
    caseRecord.evidence.push('真实登录与版本范围变更单契约校验（PB-335；仅只读）')
  }

  if (caseId === 'RDM-005') {
    const ebomPage = readPage(await api.getBusiness('/plm/core/ebom/page?pageNo=1&pageSize=100'))
    addPageShapeCheck(caseRecord, '研发 BOM 版本汇总分页返回分页结构且 pageSize 不超过 100', ebomPage)
    if (!ebomPage.rows.length) {
      addGap(caseRecord, 'EBOM 版本汇总为空，未读取真实树行的审批/生效字段。')
    } else {
      const version = ebomPage.rows.find((row) => row?.ebomId != null || row?.id != null)
      if (!version) {
        addGap(caseRecord, 'EBOM 版本汇总没有可用 ebomId/id，未读取树行。')
      } else {
        const ebomId = version.ebomId ?? version.id
        const treeRows = readArray(
          await api.getBusiness(`/plm/core/ebom/tree?ebomId=${encodeURIComponent(ebomId)}`)
        )
        const lineRows = flattenTreeRows(treeRows)
        if (!lineRows.length) {
          addGap(caseRecord, '选中的 EBOM 版本没有树行，未验证审批/生效/失效字段。')
        } else {
          const missingApprovalFields = lineRows.filter(
            (row) =>
              !hasOwn(row, 'approvalStatus') ||
              !hasOwn(row, 'effectiveDate') ||
              !hasOwn(row, 'expiryDate')
          )
          addCheck(
            caseRecord,
            'EBOM 树行返回 approvalStatus/effectiveDate/expiryDate 字段（允许 null）',
            missingApprovalFields.length === 0,
            JSON.stringify({ lineCount: lineRows.length, missingFieldRows: missingApprovalFields.length })
          )
          const rootRowsBelongToVersion = treeRows.every(
            (row) => String(row?.parentId ?? row?.parentPartRevisionId ?? row?.ebomId) === String(ebomId)
          )
          addCheck(
            caseRecord,
            'EBOM 树行与版本汇总的 ebomId 关联一致',
            rootRowsBelongToVersion,
            JSON.stringify({ lineCount: treeRows.length })
          )
        }
      }
    }

    const approvalPage = readPage(
      await api.getBusiness('/plm/rdm/record/page?bizTypes=APPROVAL&pageNo=1&pageSize=100')
    )
    addPageShapeCheck(caseRecord, '试制领料审批分页返回分页结构且 pageSize 不超过 100', approvalPage)
    if (!approvalPage.rows.length) {
      addGap(caseRecord, '试制领料审批分页为空，未验证 planId/runId 关联。')
    } else {
      const missingTrialBatchFields = approvalPage.rows.filter(
        (row) => !hasOwn(row, 'planId') || !hasOwn(row, 'runId')
      )
      addCheck(
        caseRecord,
        '试制领料审批响应包含 planId/runId 字段（允许无批次值）',
        missingTrialBatchFields.length === 0,
        JSON.stringify({ sampleCount: approvalPage.rows.length, missingFieldRows: missingTrialBatchFields.length })
      )
      const linkedRows = approvalPage.rows.filter(
        (row) => nonEmpty(row.planId) && nonEmpty(row.runId)
      )
      if (!linkedRows.length) {
        addGap(caseRecord, '试制领料审批没有同时关联 planId/runId 的样本，未验证真实批次关联。')
      }
    }
    caseRecord.evidence.push('真实登录、EBOM 树行与试制批次字段契约校验（PB-336；仅只读）')
  }

  if (caseId === 'RDM-006') {
    const releasePage = readPage(await api.getBusiness('/pm/release/page?pageNo=1&pageSize=100'))
    addPageShapeCheck(caseRecord, '发布分页接口返回分页结构且 pageSize 不超过 100', releasePage)
    if (!releasePage.rows.length) {
      addGap(caseRecord, '发布分页为空，未调用 /pm/release/gate，发布门禁证据缺失。')
    } else {
      const release = releasePage.rows.find((row) => row?.id != null)
      if (!release) {
        addGap(caseRecord, '发布分页没有可用 release id，未调用 /pm/release/gate。')
      } else {
        const gate = await api.getBusiness(`/pm/release/gate?id=${encodeURIComponent(release.id)}`)
        const gateData = gate?.data ?? gate
        const gateFieldsPresent =
          typeof gateData?.passed === 'boolean' &&
          Array.isArray(gateData?.blockReasons) &&
          hasOwn(gateData, 'requirementCoverage') &&
          hasOwn(gateData, 'criticalBugOpenCount') &&
          hasOwn(gateData, 'verificationConclusion') &&
          hasOwn(gateData, 'artifactFrozen')
        addCheck(
          caseRecord,
          '发布门禁返回需求覆盖、关键缺陷、验证结论和冻结字段',
          gateFieldsPresent,
          JSON.stringify({ gateFieldsPresent: Boolean(gateFieldsPresent) })
        )
        caseRecord.evidence.push('真实登录与发布门禁 GET 纯查询契约校验（PB-337；未执行放行写入）')
      }
    }
  }

  return { ...finalizeRdmAssertions(caseRecord, caseId, { readOnly: true }),
    partial: true, note: `未测步骤：${RDM_UNTESTED_STEPS[caseId]}` }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (RDM_CASES.has(caseId)) {
    const expectedPaths = new Set()
    const result = await runRdmWriteCase({
      caseId,
      api,
      caseRecord,
      expectedPaths
    })
    return { token, api, ...result }
  }

  if (RDM_UNTESTED_STEPS[caseId]) {
    const result = await runRdmEvidenceContract({ caseId, api, caseRecord })
    return { token, api, ...result }
  }

  if (caseId === 'RDM-007') {
    initializeRdmAssertions(caseRecord, caseId)
    const fixture = await createRdmReportFixture({ api, caseRecord })
    await verifyRdmReportFixture({ api, caseRecord, fixture })
    await openRoute(page, '/reports/project/project-plan/progress-efficiency', { retries: 1 })
    const reportPage = page.locator('[data-testid="pm-report-progress-efficiency"]').first()
    await reportPage.waitFor({ state: 'visible' })
    await page
      .getByRole('heading', { name: '研发进度与效率报表', exact: true })
      .waitFor({ state: 'visible' })
    await reportPage.locator('.report-metric__label').nth(4).waitFor({ state: 'visible' })
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
    addCheck(caseRecord, 'RDM007 五指标定义公式与正式口径一致',
      definition?.metricVersion === fixture.metricVersion &&
        Object.entries(RDM_METRIC_FORMULAS).every(([code, formula]) =>
          definition?.metrics?.some((metric) => metric.code === code && metric.formula === formula)),
      JSON.stringify({ metricVersion: definition?.metricVersion, metrics: definition?.metrics }))
    const projectSelect = reportPage.locator('.el-form-item')
      .filter({ has: page.locator('.el-form-item__label').filter({ hasText: /^项目$/ }) })
      .locator('.el-select')
    const selectProject = async (name) => {
      await projectSelect.click()
      const input = projectSelect.locator('input')
      await input.fill(name)
      const option = page.getByRole('option').filter({ hasText: name }).first()
      await option.waitFor({ state: 'visible' })
      await option.click()
    }
    const queryReport = async (projectId) => {
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/pm/report/progress-efficiency') &&
          url.searchParams.get('projectId') === projectId && response.request().method() === 'GET'
      })
      await reportPage.getByRole('button', { name: '查询', exact: true }).click()
      const response = await responsePromise
      const payload = await response.json()
      if (payload?.code !== 0) throw new Error('RDM007 浏览器筛选报表接口未成功')
      await reportPage.locator('.el-loading-mask').waitFor({ state: 'hidden' })
      return payload.data
    }
    await selectProject(fixture.projectName)
    const browserReport = await queryReport(fixture.projectId)
    const metricValues = await reportPage.locator('.report-metric__value').allTextContents()
    const expectedMetricValues = metricKeys.map((key) =>
      fixture.metricTruth[key] === null ? '-' : ['taskCompletionRate', 'versionOnTimeRate'].includes(key)
        ? Number(fixture.metricTruth[key]).toFixed(2)
        : Number(fixture.metricTruth[key]).toLocaleString('zh-CN'))
    addCheck(caseRecord, 'RDM007 浏览器正式项目筛选与五指标真值一致',
      String(browserReport?.appliedFilters?.projectId) === fixture.projectId &&
        browserReport?.projectCount === 1 && matchesRdmMetricTruth(browserReport, fixture.metricTruth) &&
        metricValues.length === 5 && metricValues.every((value, index) =>
          value.trim() === expectedMetricValues[index]),
      JSON.stringify({ filters: browserReport?.appliedFilters, metricValues, expectedMetricValues }))
    if (outputDir) {
      const screenshot = `${outputDir}/rdm-007-owned-project-filter.png`
      await page.screenshot({ path: screenshot, fullPage: true })
      caseRecord.evidence.push(screenshot)
    }
    await selectProject(fixture.controlProjectName)
    const controlReport = await queryReport(fixture.controlProjectId)
    addCheck(caseRecord, 'RDM007 切换对照项目不泄漏目标项目统计',
      String(controlReport?.appliedFilters?.projectId) === fixture.controlProjectId &&
        controlReport?.projectCount === 1 && matchesRdmMetricTruth(controlReport, fixture.controlTruth),
      JSON.stringify({ controlReport, controlTruth: fixture.controlTruth }))
    if (outputDir) {
      const screenshot = `${outputDir}/rdm-007-progress-efficiency.png`
      await page.screenshot({ path: screenshot, fullPage: true })
      caseRecord.evidence.push(screenshot)
    }
    caseRecord.evidence.push('真实登录、报表页面与研发进度效率指标契约校验（PB-338）')
    return { token, api, ...finalizeRdmAssertions(caseRecord, caseId) }
  }

  return { token, api }
}
