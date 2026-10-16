import { createApiClient } from '../lib/api.mjs'
import { login, observePage, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import {
  WORKBENCH_FIXTURE_CASES,
  assertLocalWorkbenchWriteTarget,
  inspectWorkbenchFixtureTarget,
  inspectWorkbenchReadGate,
  isWorkbenchWriteFixturesEnabled,
  workbenchReadBlockNote
} from '../workbenchhelper/fixture.mjs'
import { runOwnedWorkbenchCase } from '../workbenchhelper/owned.mjs'
import {
  finalizeWorkbenchReportClosure,
  workbenchReportMode
} from '../fixtures/workbench-report-acceptance.mjs'

// 工作台/index 门户化改造（PB-342~PB-377）真实浏览器案例。
export const cases = [
  'WBF-001',
  'WBF-002',
  'WBF-003',
  'WBF-004',
  'WBF-005',
  'WBF-006',
  'WBF-007',
  'WBF-008',
  'WBF-009',
  'WBF-010',
  'WBF-011',
  'WBF-012'
]

const WORKBENCH_PATH = '/index'
const PROCESS_DETAIL_PATH = '/bpm/process-instance/detail'

export const WORKBENCH_PAGE_ASSERTIONS = Object.freeze({
  'WBF-001': [
    ['待办中心面板可见', '工作台/index 渲染待办中心（统一工作入口）'],
    ['待办分面（待办/已办/抄送/我发起等）渲染', '待办中心提供来源/状态分面'],
    ['无 4xx/5xx', '本例请求无4xx/5xx及传输失败']
  ],
  'WBF-002': [
    ['点击待办后弹出流程详情弹窗', '待办在门户内弹窗处理（PB-350/351）'],
    ['路由仍停留在 /index，未跳转 /bpm/process-instance/detail', '处理待办不跳转到子系统页面（PB-350）']
  ],
  'WBF-003': [
    ['关闭弹窗后路由为 /index', '关闭处理弹窗后回到工作台并刷新待办（PB-352）'],
    ['待办中心仍可用', '待办中心仍然可用']
  ],
  'WBF-006': [
    ['我的关注页签可见', '工作台提供用户级我的关注归集（PB-353~355）'],
    ['点击后仍停留在 /index', '我的关注保持用户当前门户上下文'],
    ['无 4xx/5xx', '本例请求无4xx/5xx及传输失败']
  ],
  'WBF-007': [
    ['采购订单详情页存在通用关注按钮', '业务单据详情页提供通用关注按钮（PB-354）'],
    ['点击关注后关注关系落库', '点击关注后关注关系落库（PB-354）'],
    ['关注单据出现在工作台我的关注', '关注单据自动归集到工作台我的关注（PB-355）']
  ],
  'WBF-010': [
    ['会议室设置页可创建会议室台账', '会议室设置页可创建 OA 会议室台账（PB-371）'],
    ['会议室预约页可通过真实表单创建预约', '会议室预约页可通过真实表单创建会议预约（PB-371）'],
    ['同一会议室同时间区间重复预约返回占用冲突', '同一会议室同时间区间的重复预约被后端拒绝（PB-371）'],
    ['会议主题出现在工作台我的日程且不复制会议事实源', '工作台日程保留OA预约原ID且不复制日程事实']
  ],
  'WBF-011': [
    ['调用 HRM 通用问卷接口发送调查成功落库', '工作台发送调查调用 HRM 通用问卷接口（PB-358）'],
    ['待填写调查出现在工作台通知公告区块', '待填写调查显示在工作台通知公告区块（PB-358）'],
    ['在门户内填写并提交调查后从待填写清单移除', '提交后问卷从待填写清单回收（PB-358）'],
    ['工作台不再展示该待填写调查', '提交后工作台不再展示该待填写调查']
  ]
})

export function recordWorkbenchPageAssertions (caseId, caseRecord) {
  const assertions = WORKBENCH_PAGE_ASSERTIONS[caseId]
  if (!assertions) throw new Error(`未定义工作台页面原断言：${caseId}`)
  caseRecord.catalogAssertions ||= []
  for (const [index, [assertion, name]] of assertions.entries()) {
    if (caseRecord.catalogAssertions.some((row) => row.index === index)) {
      throw new Error(`工作台页面原断言重复：${caseId}/${index}`)
    }
    const checks = caseRecord.checks.filter((check) => check.name === name)
    const passed = checks.length > 0 && checks.every((check) =>
      check.passed === true && typeof check.details === 'string' && check.details.length > 0)
    caseRecord.catalogAssertions.push({
      index, assertion, status: passed ? 'VERIFIED' : 'UNVERIFIED',
      evidence: checks.length ? checks.map((check) => check.details).join('；') : `缺少实际检查：${name}`
    })
  }
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED').map((row) => row.assertion)
  return caseRecord.remainingAssertions.length
    ? { partial: true, note: caseRecord.remainingAssertions.join('；') } : {}
}

// 门户区块编码 → 工作台面板选择器，用于校验按角色命中的门户区块组合（PB-373~377）。
const PORTAL_SECTION_SELECTORS = {
  'quick-actions': '.quick-actions-strip',
  todo: '.todo-panel',
  schedule: '.schedule-panel',
  message: '.message-panel',
  announcement: '.announcement-panel',
  focus: '.focus-panel',
  report: '.report-panel',
  culture: '.culture-panel',
  document: '.document-panel',
  contact: '.contact-panel',
  performance: '.performance-panel'
}

export function validateWorkbenchTodoPage (response, payload) {
  const data = payload?.data
  if (!response.ok() || payload?.code !== 0 || !Array.isArray(data?.list) ||
    !Number.isInteger(data.total) || data.total < 0 || data.total < data.list.length) {
    throw new Error('待办真实分页响应或业务契约无效，不能用空态替代失败请求')
  }
  return data
}

async function waitForProcessDetail (dialog) {
  const detail = dialog.locator('.processInstance-wrap-main').first()
  await detail.waitFor({ state: 'visible', timeout: 60000 })
  await detail.locator('.text-26px').first().waitFor({ state: 'visible', timeout: 60000 })
  return detail
}

async function waitForTodoContent (page, todoPanel, expectedRowCount) {
  // The empty state can exist during the initial Vue render. Require both the
  // loading mask to be gone and the DOM row count to match the response body.
  await todoPanel.locator('.todo-body .el-loading-mask').waitFor({
    state: 'hidden',
    timeout: 60000
  })
  await page.waitForFunction(({ expectedRowCount }) => {
    const body = document.querySelector('.todo-panel .todo-body')
    if (!body) return false
    const mask = body.querySelector('.el-loading-mask')
    const maskStyle = mask && window.getComputedStyle(mask)
    const maskVisible = Boolean(mask && maskStyle.display !== 'none' &&
      maskStyle.visibility !== 'hidden' && maskStyle.opacity !== '0')
    if (maskVisible) return false

    const rowCount = body.querySelectorAll('.work-list-row').length
    if (rowCount !== expectedRowCount) return false

    const empty = body.querySelector('.el-empty')
    const emptyStyle = empty && window.getComputedStyle(empty)
    const emptyVisible = Boolean(empty && emptyStyle.display !== 'none' &&
      emptyStyle.visibility !== 'hidden')
    return expectedRowCount > 0 ? !emptyVisible : emptyVisible
  }, { expectedRowCount }, { timeout: 60000 })
  return todoPanel.locator(expectedRowCount > 0
    ? '.todo-body .work-list-row'
    : '.todo-body .el-empty').first()
}

async function readTodoResponse (response) {
  return validateWorkbenchTodoPage(response, await readBrowserResponsePayload(response))
}

const isTodoRequest = (request) =>
  new URL(request.url()).pathname.endsWith('/workbench/todo/page') &&
  request.method() === 'GET'

async function waitForTodoResponse (page, acceptsRequest = () => true) {
  let todoPage
  const response = await page.waitForResponse(async (candidate) => {
    if (!isTodoRequest(candidate.request()) || !acceptsRequest(candidate.request())) return false
    todoPage = await readTodoResponse(candidate)
    return true
  }, { timeout: 60000 })
  return { response, todoPage }
}

export async function openWorkbenchAndWaitForTodo (page, navigate = openRoute) {
  // Ignore late responses from the login document. Only capture requests made
  // after the new workbench document starts loading.
  let documentStarted = false
  const requests = new Set()
  const onRequest = (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentStarted = true
      requests.clear()
    } else if (documentStarted && isTodoRequest(request)) {
      requests.add(request)
    }
  }
  page.on('request', onRequest)
  let todoPage
  try {
    // Attach both rejection handlers immediately, including while navigation
    // is pending, so a lost body produces a case report instead of crashing Node.
    const captured = await Promise.all([
      waitForTodoResponse(page, (request) => requests.has(request)),
      navigate(page, WORKBENCH_PATH)
    ])
    todoPage = captured[0].todoPage
  } finally {
    page.off('request', onRequest)
  }
  const todoPanel = page.locator('.todo-panel').first()
  await todoPanel.waitFor({ state: 'visible' })
  await waitForTodoContent(page, todoPanel, todoPage.list.length)
  return { todoPanel, todoPage }
}

const REPORT_QUERIES = [
  { type: 'DAILY', label: '日报', path: '/pm/daily-report/page', owner: 'reporterId' },
  { type: 'WEEKLY', label: '周报', path: '/crm/work-report/page', owner: 'ownerUserId' },
  { type: 'MONTHLY', label: '月报', path: '/crm/work-report/page', owner: 'ownerUserId' }
]

export function validateWorkbenchReportPage (response, payload, query, userId, scope = 'self') {
  const url = new URL(response.url())
  const params = url.searchParams
  const data = payload?.data
  if (!response.ok() || payload?.code !== 0 || !Array.isArray(data?.list) ||
    !Number.isInteger(data.total) || data.total < data.list.length ||
    data.list.length > 100 || params.get('pageNo') !== '1' || params.get('pageSize') !== '100' ||
    !url.pathname.endsWith(query.path) || response.request().method() !== 'GET' ||
    params.get('reportType') !== query.type) {
    throw new Error(`${query.label}真实分页响应或查询契约无效，不能用空态替代失败请求`)
  }
  const owner = params.get(query.owner)
  if ((scope === 'self' && owner !== String(userId)) || (scope === 'team' && owner !== null)) {
    throw new Error(`${query.label}请求范围不符：预期=${scope}`)
  }
  if (data.list.some((row) => !row || row.reportType !== query.type ||
    (scope === 'self' && String(row[query.owner]) !== String(userId)))) {
    throw new Error(`${query.label}响应包含类型错误或非当前用户报告`)
  }
  return data
}

export async function readBrowserResponsePayload (response) {
  const headers = response.headers()
  const text = await response.text()
  return headers[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(text)
    : JSON.parse(text)
}

export async function captureWorkbenchReports (page, action, userId, scope = 'self') {
  // Tabs use preloaded arrays; statistics changes issue a fresh batch of three GETs.
  const pending = REPORT_QUERIES.map((query) => page.waitForResponse(
    (response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' && url.pathname.endsWith(query.path) &&
        url.searchParams.get('reportType') === query.type
    },
    { timeout: 15000 }
  ).catch(() => null))
  const responses = Promise.all(pending)
  await action()
  const captured = await responses
  const pages = {}
  const missing = []
  for (const [index, query] of REPORT_QUERIES.entries()) {
    const response = captured[index]
    if (!response) {
      missing.push(`${query.label}未捕获真实 GET 响应`)
      continue
    }
    const payload = await readBrowserResponsePayload(response)
    pages[query.type] = validateWorkbenchReportPage(response, payload, query, userId, scope)
  }
  return { pages, missing }
}

function reportPartial (token, api, caseRecord, gaps) {
  const note = `未验收：${gaps.join('；')}`
  caseRecord.notes.push(note)
  return { token, api, partial: true, note }
}

export function summarizeWorkbenchReports (pages, period, today) {
  const [year, month] = today.split('-').map(Number)
  const firstMonth = period === 'year' ? 1 : period === 'quarter'
    ? Math.floor((month - 1) / 3) * 3 + 1 : month
  const lastMonth = period === 'year' ? 12 : period === 'quarter' ? firstMonth + 2 : month
  const start = `${year}-${String(firstMonth).padStart(2, '0')}-01`
  const end = new Date(Date.UTC(year, lastMonth, 0)).toISOString().slice(0, 10)
  const inRange = (value) => typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(value) && value.slice(0, 10) >= start && value.slice(0, 10) <= end
  return REPORT_QUERIES.map(({ type, label }) => {
    const list = pages[type].list.filter((row) => type === 'DAILY'
      ? inRange(row.periodKey) : inRange(row.periodStart) || inRange(row.periodEnd))
    return [label, list.length, list.filter((row) => row.status === 'SUBMITTED').length,
      list.filter((row) => row.status === 'APPROVED').length,
      list.filter((row) => ['REJECTED', 'OVERDUE'].includes(row.status)).length].map(String)
  })
}

export async function waitForReportRendering (panel) {
  await panel.locator('.focus-body .el-loading-mask').waitFor({ state: 'hidden', timeout: 15000 })
  await panel.locator('.focus-body .work-list-row, .focus-body .el-empty').first()
    .waitFor({ state: 'visible', timeout: 15000 })
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  const requestOffsets = {
    api: record.api?.length || 0,
    failed: record.failedApiResponses?.length || 0,
    request: record.requestFailures?.length || 0
  }
  const finishPageCase = async () => {
    if (['WBF-001', 'WBF-006'].includes(caseId)) {
      await observePage(page, record).flushResponses()
      const failures = [
        ...record.failedApiResponses.slice(requestOffsets.failed),
        ...record.requestFailures.slice(requestOffsets.request),
        ...record.api.slice(requestOffsets.api).filter((entry) =>
          Number(entry.status) >= 400 || entry.networkError || entry.responseError)
      ]
      caseRecord.checks.push({
        name: '本例请求无4xx/5xx及传输失败', passed: failures.length === 0,
        details: JSON.stringify({ failureCount: failures.length, failures })
      })
    }
    return { token, api, ...recordWorkbenchPageAssertions(caseId, caseRecord) }
  }
  const reportMode = workbenchReportMode(caseId, dependencies.env || process.env)
  if (reportMode && !caseRecord.workbenchReportMode) caseRecord.workbenchReportMode = reportMode
  const writeEnabled = isWorkbenchWriteFixturesEnabled(dependencies.env || process.env) &&
    WORKBENCH_FIXTURE_CASES.has(caseId)
  const settings = dependencies.workbenchConfig || config
  if (writeEnabled || ['WBF-007', 'WBF-010', 'WBF-011'].includes(caseId)) {
    assertLocalWorkbenchWriteTarget(settings)
  }
  const session = await (dependencies.login || login)(page, writeEnabled ? { returnContext: true } : {})
  const token = typeof session === 'string' ? session : session?.token
  const api = (dependencies.createApiClient || createApiClient)({
    token, record, ...(writeEnabled ? { tenantId: session?.tenantId } : {})
  })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后携带真实令牌打开工作台并校验待办中心'
  })

  if (writeEnabled) {
    const targetGate = await inspectWorkbenchFixtureTarget({
      api, settings, sessionTenantId: session?.tenantId
    })
    if (!targetGate.allowed) {
      return reportPartial(token, api, caseRecord, [targetGate.reason])
    }
    caseRecord.notes.push('opt-in 已确认 local/租户 1；执行本轮专属最小角色/账号夹具，不修改共享授权、门户或业务记录。')
    const result = await (dependencies.runOwnedWorkbenchCase || runOwnedWorkbenchCase)({
      caseId, page, token, api, record, caseRecord, outputDir, settings,
      sessionTenantId: session?.tenantId
    }, {
      ...dependencies,
      runReadOnlyCase: runCase,
      readBrowserResponsePayload,
      captureWorkbenchReports,
      waitForReportRendering
    })
    return reportMode?.mode === 'daily-closure'
      ? finalizeWorkbenchReportClosure(caseId, caseRecord, result) : result
  }

  let readGate
  if (WORKBENCH_FIXTURE_CASES.has(caseId)) {
    readGate = await inspectWorkbenchReadGate({ api, caseId })
    caseRecord.evidence.push(JSON.stringify({
      scope: 'E2E-WBF', caseId, readOnly: true, allowed: readGate.allowed,
      missingPermissions: readGate.missingPermissions,
      missingMenuDefinitions: readGate.missingMenuDefinitions,
      diagnostics: readGate.diagnostics
    }))
    if (!readGate.allowed) {
      return reportPartial(token, api, caseRecord, [workbenchReadBlockNote(readGate)])
    }
  }

  if (caseId === 'WBF-001') {
    const { todoPanel, todoPage } = await openWorkbenchAndWaitForTodo(
      page, dependencies.openRoute || openRoute
    )
    const renderedRows = await todoPanel.locator('.todo-body .work-list-row').count()
    caseRecord.checks.push({
      name: '待办真实 GET 业务成功且 DOM 行数同步',
      passed: renderedRows === todoPage.list.length,
      details: `响应 total=${todoPage.total}，响应 rows=${todoPage.list.length}，DOM rows=${renderedRows}`
    })
    const todoHeading = (await todoPanel.locator('h2').first().innerText()).trim()
    caseRecord.checks.push({
      name: '工作台/index 渲染待办中心（统一工作入口）',
      passed: todoHeading.includes('待办'),
      details: `待办中心标题=${todoHeading}`
    })
    const tileLabels = await todoPanel.locator('.todo-tile small').allTextContents()
    caseRecord.checks.push({
      name: '待办中心提供来源/状态分面',
      passed: ['待办', '已办', '抄送', '我发起'].every((label) =>
        tileLabels.some((actual) => actual.trim() === label)),
      details: `待办分面=${JSON.stringify(tileLabels)}`
    })
    await saveScreenshot(page, outputDir, 'wbf001-workbench-todo', record)
    caseRecord.evidence.push('WBF-001 校验工作台待办中心作为统一工作入口真实渲染')
    return finishPageCase()
  }

  if (caseId === 'WBF-002') {
    const { todoPanel, todoPage } = await openWorkbenchAndWaitForTodo(
      page, dependencies.openRoute || openRoute
    )
    const firstRow = todoPanel.locator('.todo-body .work-list-row').first()
    const renderedRows = await todoPanel.locator('.todo-body .work-list-row').count()
    const hasTodo = renderedRows > 0
    caseRecord.checks.push({
      name: '待办真实 GET 业务成功且 DOM 行数同步',
      passed: renderedRows === todoPage.list.length,
      details: `响应 total=${todoPage.total}，响应 rows=${todoPage.list.length}，DOM rows=${renderedRows}`
    })
    caseRecord.checks.push({
      name: '工作台待办清单存在可处理条目',
      passed: hasTodo,
      details: hasTodo
        ? `真实响应存在 ${todoPage.list.length} 条当前页待办`
        : `真实响应 total=${todoPage.total} 且当前页 rows=0（该分面为空）`
    })
    if (!hasTodo) {
      caseRecord.notes.push(
        `当前账号真实待办 total=${todoPage.total}/当前页 rows=${todoPage.list.length}，弹窗交互无法取真实单据；保留清单渲染证据。`
      )
      await (dependencies.saveScreenshot || saveScreenshot)(
        page, outputDir, 'wbf002-workbench-todo-empty', record
      )
      throw new Error('BLOCKED: 需先通过真实 BPM 流程创建待办，不得跳过弹窗验证')
    }
    const pathBefore = new URL(page.url()).pathname
    await firstRow.click()
    const dialog = page.locator('.todo-detail-dialog').first()
    await dialog.waitFor({ state: 'visible' })
    const detail = await waitForProcessDetail(dialog)
    const dialogVisible = await dialog.isVisible()
    const detailRendered = await detail.count()
    const pathAfter = new URL(page.url()).pathname
    caseRecord.checks.push({
      name: '待办在门户内弹窗处理（PB-350/351）',
      passed: dialogVisible && detailRendered > 0,
      details: `弹窗可见=${dialogVisible}，流程详情渲染=${detailRendered > 0}`
    })
    caseRecord.checks.push({
      name: '处理待办不跳转到子系统页面（PB-350）',
      passed: pathBefore === WORKBENCH_PATH && pathAfter === WORKBENCH_PATH &&
        !pathAfter.includes(PROCESS_DETAIL_PATH),
      details: `点击前=${pathBefore}，点击后=${pathAfter}`
    })
    await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, 'wbf002-workbench-todo-dialog', record
    )
    await dialog.locator('.el-dialog__headerbtn').first().click()
    await dialog.waitFor({ state: 'hidden' })
    caseRecord.evidence.push('WBF-002 校验待办在门户内弹窗打开原始单据，不离开工作台路由')
    return finishPageCase()
  }

  if (caseId === 'WBF-003') {
    const { todoPanel, todoPage } = await openWorkbenchAndWaitForTodo(
      page, dependencies.openRoute || openRoute
    )
    const firstRow = todoPanel.locator('.todo-body .work-list-row').first()
    const renderedRows = await todoPanel.locator('.todo-body .work-list-row').count()
    const hasTodo = renderedRows > 0
    caseRecord.checks.push({
      name: '待办真实 GET 业务成功且 DOM 行数同步',
      passed: renderedRows === todoPage.list.length,
      details: `响应 total=${todoPage.total}，响应 rows=${todoPage.list.length}，DOM rows=${renderedRows}`
    })
    if (!hasTodo) {
      caseRecord.notes.push(
        `当前账号真实待办 total=${todoPage.total}/当前页 rows=${todoPage.list.length}，关闭刷新链路无可执行待办。`
      )
      throw new Error('BLOCKED: 需先通过真实 BPM 流程创建待办，不得把未执行的刷新链路记为通过')
    }
    await firstRow.click()
    const dialog = page.locator('.todo-detail-dialog').first()
    await dialog.waitFor({ state: 'visible' })
    await waitForProcessDetail(dialog)
    const [refreshed] = await Promise.all([
      waitForTodoResponse(page),
      (async () => {
        await dialog.locator('.el-dialog__headerbtn').first().click()
        await dialog.waitFor({ state: 'hidden' })
      })()
    ])
    await waitForTodoContent(page, todoPanel, refreshed.todoPage.list.length)
    const refreshedRows = await todoPanel.locator('.todo-body .work-list-row').count()
    const pathAfterClose = new URL(page.url()).pathname
    caseRecord.checks.push({
      name: '关闭处理弹窗后回到工作台并刷新待办（PB-352）',
      passed: pathAfterClose === WORKBENCH_PATH && refreshedRows === refreshed.todoPage.list.length,
      details: `关闭后路由=${pathAfterClose}；刷新响应 total=${refreshed.todoPage.total}，响应 rows=${refreshed.todoPage.list.length}，DOM rows=${refreshedRows}`
    })
    caseRecord.checks.push({
      name: '待办中心仍然可用',
      passed: await todoPanel.isVisible(),
      details: '关闭后待办中心仍在门户内渲染'
    })
    await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, 'wbf003-workbench-todo-refresh', record
    )
    caseRecord.evidence.push('WBF-003 校验关闭处理弹窗后待办清单刷新且停留在工作台')
    return finishPageCase()
  }

  if (caseId === 'WBF-004') {
    const identity = readGate
    const { pages, missing } = await captureWorkbenchReports(
      page, () => (dependencies.openRoute || openRoute)(page, WORKBENCH_PATH), identity.userId
    )
    if (missing.length) return reportPartial(token, api, caseRecord, missing)
    const reportPanel = page.locator('.report-panel').first()
    await reportPanel.waitFor({ state: 'visible' })
    await waitForReportRendering(reportPanel)
    for (const query of REPORT_QUERIES) {
      const tab = reportPanel.locator('.panel-tabs button').filter({ hasText: query.label }).first()
      await tab.click()
      const titles = pages[query.type].list.slice(0, 5).map((row) => query.type === 'DAILY'
        ? `${row.periodKey || '当前周期'} 项目日报`
        : row.periodLabel || row.reportNo || query.label)
      await page.waitForFunction(({ label, titles }) => {
        const panel = document.querySelector('.report-panel')
        const active = panel?.querySelector('.panel-tabs button.active')
        const rendered = [...(panel?.querySelectorAll('.focus-body .work-list-row') || [])]
          .filter((row) => row.querySelector('.el-tag'))
          .map((row) => row.querySelector('strong')?.textContent?.trim())
        return active?.textContent?.includes(label) && JSON.stringify(rendered) === JSON.stringify(titles) &&
          (titles.length > 0 || Boolean(panel?.querySelector('.focus-body .el-empty')))
      }, { label: query.label, titles }, { timeout: 15000 })
      caseRecord.checks.push({
        name: `${query.label}实际切换并匹配当前用户真实响应（PB-359~365）`,
        passed: true,
        details: `GET ${query.path}；${query.owner}=${identity.userId}；返回=${pages[query.type].list.length}，展示=${titles.length}`
      })
    }
    caseRecord.checks.push({
      name: '工作报告区块保持在统一门户内',
      passed: new URL(page.url()).pathname === WORKBENCH_PATH,
      details: `当前路由=${new URL(page.url()).pathname}`
    })
    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'wbf004-work-report', record)
    caseRecord.evidence.push('WBF-004 已等待三份真实响应、核对请求及返回归属，实际切换三个页签并逐项匹配展示')
    return reportPartial(token, api, caseRecord, [
      '未使用受限账号和他人报告验证权限反例；空列表合法但不证明跨用户隔离'
    ])
  }

  if (caseId === 'WBF-005') {
    const quickPreference = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/system/user-preference/get') &&
      new URL(response.url()).searchParams.get('key') === 'workbench.quick-actions' &&
      response.request().method() === 'GET', { timeout: 15000 }).catch(() => null)
    await (dependencies.openRoute || openRoute)(page, WORKBENCH_PATH)
    if (!await quickPreference) {
      return reportPartial(token, api, caseRecord, ['快捷配置未捕获真实加载响应，未点击采购动作'])
    }
    const quickActions = page.locator('.quick-actions-strip').first()
    await quickActions.waitFor({ state: 'visible' })
    const purchaseOrderAction = quickActions.getByRole('button', { name: '新增采购订单' })
    const purchaseExecutionAction = quickActions.getByRole('button', { name: '采购执行表' })
    const hasPurchaseOrder = (await purchaseOrderAction.count()) > 0
    const hasPurchaseExecution = (await purchaseExecutionAction.count()) > 0
    if (!hasPurchaseOrder || !hasPurchaseExecution) {
      caseRecord.notes.push('当前用户个人快捷配置未包含采购动作，需在“添加快捷”中启用后复测。')
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'wbf005-procurement-actions-missing', record)
      return reportPartial(token, api, caseRecord, ['个人快捷配置缺少采购动作，未修改共享用户配置'])
    }
    caseRecord.checks.push({
      name: '采购快捷动作已提供（PB-367/368）',
      passed: hasPurchaseOrder && hasPurchaseExecution,
      details: `采购订单=${hasPurchaseOrder}，采购执行表=${hasPurchaseExecution}`
    })
    // Opening formDialog.vue immediately PUTs executeRuleByCode/erp_purchase_no.
    // BillNoRule -> BasSequenceServiceImpl -> BasSequenceMapper increments mes_bas_sequence.
    const purchaseGap = '新增采购订单未点击：formDialog.vue:740 打开即 PUT /mes/fillRule/executeRuleByCode/erp_purchase_no，分配正式号并递增 mes_bas_sequence；表单就绪及关闭未验收'
    caseRecord.notes.push(purchaseGap)
    const pathBefore = new URL(page.url()).pathname
    const executionResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/erp/purchase-order/page') &&
      response.request().method() === 'GET', { timeout: 15000 }).catch(() => null)
    await purchaseExecutionAction.click()
    const executionDialog = page.getByRole('dialog', { name: '采购执行表' }).first()
    await executionDialog.waitFor({ state: 'visible' })
    const response = await executionResponse
    if (!response) {
      await executionDialog.locator('.el-dialog__headerbtn').first().click()
      await executionDialog.waitFor({ state: 'hidden' })
      return reportPartial(token, api, caseRecord, [purchaseGap, '采购执行表未捕获真实列表响应'])
    }
    const executionPage = await readBrowserResponsePayload(response)
    caseRecord.checks.push({
      name: '采购执行表真实只读列表加载成功',
      passed: response.ok() && executionPage?.code === 0 && Array.isArray(executionPage?.data?.list),
      details: `GET /erp/purchase-order/page；code=${executionPage?.code}`
    })
    await executionDialog.locator('.el-loading-mask').first()
      .waitFor({ state: 'hidden', timeout: 15000 })
    await executionDialog.locator('.search-form').waitFor({ state: 'visible' })
    const pathAfter = new URL(page.url()).pathname
    caseRecord.checks.push({
      name: '采购执行表在门户弹窗打开（PB-368）',
      passed: pathAfter === pathBefore && (await executionDialog.isVisible()),
      details: `点击前=${pathBefore}，点击后=${pathAfter}`
    })
    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'wbf005-procurement-dialog', record)
    await executionDialog.locator('.el-dialog__headerbtn').first().click()
    await executionDialog.waitFor({ state: 'hidden' })
    caseRecord.checks.push({
      name: '采购执行表关闭且保持工作台、不保存订单',
      passed: new URL(page.url()).pathname === WORKBENCH_PATH,
      details: '仅打开并关闭采购执行表；未点击新增、保存或正式取号'
    })
    caseRecord.evidence.push('WBF-005 仅验收采购执行表真实列表加载、门户弹窗及关闭；未打开有取号副作用的新增订单')
    return reportPartial(token, api, caseRecord, [purchaseGap])
  }

  if (caseId === 'WBF-006') {
    await openRoute(page, WORKBENCH_PATH)
    const focusPanel = page.locator('.focus-panel').first()
    await focusPanel.waitFor({ state: 'visible' })
    const favoriteTab = focusPanel.getByRole('button', { name: /我的关注/ }).first()
    const visible = await favoriteTab.isVisible()
    if (visible) await favoriteTab.click()
    caseRecord.checks.push({
      name: '工作台提供用户级我的关注归集（PB-353~355）',
      passed: visible,
      details: `我的关注页签可见=${visible}`
    })
    caseRecord.checks.push({
      name: '我的关注保持用户当前门户上下文',
      passed: new URL(page.url()).pathname === WORKBENCH_PATH,
      details: `当前路由=${new URL(page.url()).pathname}`
    })
    await saveScreenshot(page, outputDir, 'wbf006-user-favorites', record)
    caseRecord.evidence.push('WBF-006 校验跨业务通用关注在工作台统一归集')
    return finishPageCase()
  }

  if (caseId === 'WBF-007') {
    const orderPage = assertBusinessSuccess(
      await api.get('/erp/purchase-order/page?pageNo=1&pageSize=10'), '采购订单分页'
    ).data
    let order
    for (const candidate of orderPage.list) {
      const favorite = assertBusinessSuccess(await api.get(
        `/system/user-favorite/check?bizType=erp_purchase_order&bizId=${encodeURIComponent(candidate.id)}`
      ), '原关注状态').data
      if (favorite === false) {
        order = candidate
        break
      }
    }
    caseRecord.checks.push({
      name: '存在可用于关注验证的采购订单',
      passed: Boolean(order?.id),
      details: order ? `采购订单=${order.billNo || order.no || order.id}` : '当前租户无采购订单'
    })
    if (!order?.id) {
      throw new Error('BLOCKED: 需先通过采购页面/API 创建采购订单，不得跳过关注归集链路')
    }
    const bizType = 'erp_purchase_order'
    const bizId = String(order.id)
    const favoriteRoute = `/system/user-favorite/remove?bizType=${bizType}&bizId=${bizId}`
    // Select an unfavorited order so existing user preferences stay intact.
    try {
      await openRoute(page, `/purchase/order/formDetail/${bizId}`)
      const detailRoot = page.locator('.mainBox').first()
      const hasDetail = await detailRoot
        .waitFor({ state: 'visible', timeout: 60000 })
        .then(() => true)
        .catch(() => false)
      const actionGroup = detailRoot.locator('.btnGroup').first()
      const hasGroup = hasDetail && await actionGroup
        .waitFor({ state: 'visible', timeout: 60000 })
        .then(() => true)
        .catch(() => false)
      const favoriteButton = actionGroup.getByRole('button', { name: /关注/ }).first()
      const hasButton = hasGroup && await favoriteButton
        .waitFor({ state: 'visible', timeout: 60000 })
        .then(() => true)
        .catch(() => false)
      caseRecord.checks.push({
        name: '业务单据详情页提供通用关注按钮（PB-354）',
        passed: hasButton,
        details: hasButton
          ? '采购订单详情页存在关注按钮'
          : `详情主容器=${hasDetail}，操作区=${hasGroup}，当前URL=${page.url()}`
      })
      if (!hasButton) {
        caseRecord.notes.push('未在采购订单详情页找到关注按钮，可能为权限或详情页结构差异。')
        await saveScreenshot(page, outputDir, 'wbf007-favorite-button-missing', record)
        return finishPageCase()
      }
      await favoriteButton.click()
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
      const check = assertBusinessSuccess(await api.get(
        `/system/user-favorite/check?bizType=${bizType}&bizId=${bizId}`
      ), '点击关注后的正式回读')
      caseRecord.checks.push({
        name: '点击关注后关注关系落库（PB-354）',
        passed: check.data === true,
        details: `关注校验接口返回=${JSON.stringify(check.data)}`
      })

      const favoritePageResponse = page.waitForResponse(
        response =>
          response.url().includes('/system/user-favorite/page') &&
          response.request().method() === 'GET' &&
          response.ok(),
        { timeout: 60000 }
      )
      await openRoute(page, WORKBENCH_PATH)
      const favorites = assertBusinessSuccess(
        await readBrowserResponsePayload(await favoritePageResponse), '工作台关注分页'
      ).data
      const sourceMatches = favorites?.list?.filter((row) =>
        row.bizType === bizType && String(row.bizId) === bizId)
      if (sourceMatches?.length !== 1) throw new Error('工作台关注分页未返回本轮唯一业务来源')
      const panel = page.locator('.focus-panel').first()
      await panel.waitFor({ state: 'visible' })
      const favoriteTab = panel.getByRole('button', { name: /我的关注/ }).first()
      if (await favoriteTab.isVisible()) await favoriteTab.click()
      const expectedTitle = `采购订单 ${order.billNo || order.no || ''}`.trim()
      const favoriteRow = panel
        .locator('.focus-body .focus-row')
        .filter({ hasText: expectedTitle })
        .first()
      const collected = await favoriteRow
        .waitFor({ state: 'visible', timeout: 60000 })
        .then(() => 1)
        .catch(() => 0)
      caseRecord.checks.push({
        name: '关注单据自动归集到工作台我的关注（PB-355）',
        passed: collected > 0,
        details: `bizId=${bizId}; 匹配“${expectedTitle}”的条目数=${collected}`
      })
      await saveScreenshot(page, outputDir, 'wbf007-detail-favorite-to-workbench', record)
      caseRecord.evidence.push('WBF-007 校验详情页关注采购订单后在工作台我的关注中自动归集')
      return finishPageCase()
    } finally {
      assertBusinessSuccess(await api.delete(favoriteRoute), '清理本轮新增关注')
      const restored = assertBusinessSuccess(await api.get(
        `/system/user-favorite/check?bizType=${bizType}&bizId=${bizId}`
      ), '关注清理回读').data
      caseRecord.checks.push({
        name: '仅清理本轮新增关注且原有关注不变', passed: restored === false,
        details: `bizType=${bizType}; bizId=${bizId}; favorite=${restored}`
      })
    }
  }

  if (caseId === 'WBF-008') {
    const gaps = ['共享用户未改选或保存周报格式；未验证精确保存值、刷新后回显、用户隔离及完整偏好还原',
      '提醒仅核对文案，未逐项核对已填/未填及待审批数值']
    const identity = readGate
    const { missing } = await captureWorkbenchReports(
      page, () => (dependencies.openRoute || openRoute)(page, WORKBENCH_PATH), identity.userId
    )
    if (missing.length) return reportPartial(token, api, caseRecord, [...gaps, ...missing])
    const reportPanel = page.locator('.report-panel').first()
    await reportPanel.waitFor({ state: 'visible' })
    await waitForReportRendering(reportPanel)
    const reminderText = await reportPanel.locator('.focus-body').innerText()
    const reminderKinds = ['日报', '周报', '月报'].filter((kind) => reminderText.includes(kind))
    caseRecord.checks.push({
      name: '工作报告区块展示日报/周报/月报提醒汇总（PB-365）',
      passed: reminderKinds.length === 3,
      details: `命中提醒类型=${reminderKinds.join('/')}`
    })
    caseRecord.checks.push({
      name: '提醒包含已填/未填与待审批统计口径（PB-364）',
      passed: reminderText.includes('待审批') && /已填写|未填写/.test(reminderText),
      details: `提醒文案=${reminderText.replace(/\s+/g, ' ').slice(0, 160)}`
    })

    const formatButton = reportPanel.getByRole('button', { name: '格式' }).first()
    caseRecord.checks.push({
      name: '工作报告提供个人周报格式入口（PB-363）',
      passed: await formatButton.isVisible(),
      details: '报告区块存在“格式”入口'
    })
    if (await formatButton.isVisible()) {
      await formatButton.click()
      const dialog = page.getByRole('dialog', { name: '个人周报格式' }).first()
      await dialog.waitFor({ state: 'visible' })
      const checkboxes = dialog.locator('.el-checkbox')
      const checkboxCount = await checkboxes.count()
      caseRecord.checks.push({
        name: '周报格式弹窗只读展示字段选项（不证明持久化）',
        passed: checkboxCount === 4,
        details: `可选字段数=${checkboxCount}；未修改共享用户偏好`
      })
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'wbf008-report-reminders-format', record)
    caseRecord.evidence.push('WBF-008 仅验收已加载提醒文案和格式弹窗只读打开/取消，不证明保存或刷新持久化')
    return reportPartial(token, api, caseRecord, gaps)
  }

  if (caseId === 'WBF-009') {
    // 多门户与角色绑定：校验登录权限信息下发的门户区块与工作台实际渲染一致（PB-373~377）
    const permission = readGate.permissionPayload
    const portal = permission?.data
    const configured = Array.isArray(portal?.portalSections)
    const portalSections = configured ? portal.portalSections : []
    caseRecord.checks.push({
      name: '登录权限信息下发门户标识与区块组合（PB-377）',
      passed: permission?.code === 0 && (configured || portal?.portalSections == null),
      details: `门户编码=${portal?.portalCode || '（未配置，展示全部区块）'}，区块数=${portalSections.length}`
    })

    await (dependencies.openRoute || openRoute)(page, WORKBENCH_PATH)
    await page.locator('.personal-workbench').first().waitFor({ state: 'visible' })

    const visibility = {}
    for (const [key, selector] of Object.entries(PORTAL_SECTION_SELECTORS)) {
      visibility[key] = await page.locator(selector).first().isVisible()
    }
    const visibleKeys = Object.keys(visibility).filter((key) => visibility[key])

    if (portalSections.length === 0) {
      const missing = Object.keys(PORTAL_SECTION_SELECTORS).filter((key) => !visibility[key])
      caseRecord.checks.push({
        name: '未命中门户时工作台展示默认全部区块',
        passed: missing.length === 0,
        details: `可见区块=${visibleKeys.join('/') || '（无）'}；缺失=${missing.join('/') || '无'}`
      })
    } else {
      const missing = portalSections.filter((key) => visibility[key] !== true)
      const unexpected = visibleKeys.filter((key) => !portalSections.includes(key))
      caseRecord.checks.push({
        name: '门户区块按角色配置显隐（PB-374~376）',
        passed: missing.length === 0 && unexpected.length === 0,
        details: `配置区块=${portalSections.join('/')}；缺失=${missing.join('/') || '无'}；越权区块=${unexpected.join('/') || '无'}`
      })
    }

    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'wbf009-portal-sections', record)
    caseRecord.evidence.push('WBF-009 仅校验当前登录账号的门户区块真实显隐，未覆盖其他角色分支')
    return {
      token, api, partial: true,
      note: portalSections.length === 0
        ? '仅验证未配置门户的默认全部区块；未验证专属角色命中 portalCode/portalSections 与无权限账号反例'
        : '仅验证当前账号配置区块；未验证专属角色映射、无权限账号反例及未配置门户的默认全部区块'
    }
  }

  if (caseId === 'WBF-010') {
    // OA 统一资源预约中心（会议室）与工作台我的日程只读聚合（PB-371）
    const suffix = String(Date.now())
    const roomName = `自动化会议室-${suffix}`
    const subject = `自动化会议-${suffix}`
    const conflictSubject = `${subject}-冲突`
    const day = new Date()
    day.setHours(day.getHours() + 1, 0, 0, 0)
    const end = new Date(day.getTime() + 60 * 60 * 1000)
    const formatDateTime = (value) => {
      const pad = (part) => String(part).padStart(2, '0')
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
        value.getHours()
      )}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    }
    const startTime = formatDateTime(day)
    const endTime = formatDateTime(end)
    let roomId
    let bookingId

    try {
      await openRoute(page, '/settings/hrm/meeting-room')
      const addRoomButton = page.getByRole('button', { name: '新增会议室', exact: true }).first()
      await addRoomButton.waitFor({ state: 'visible' })
      await addRoomButton.click()
      const roomDialog = page.locator('.el-dialog:visible').filter({ hasText: '新增会议室' }).last()
      await roomDialog.waitFor({ state: 'visible', timeout: 15000 })
      const roomFormItem = (label) =>
        roomDialog.locator('.el-form-item').filter({ hasText: label }).first()
      await roomFormItem('会议室名称').locator('input').first().fill(roomName)
      await roomFormItem('所在位置').locator('input').first().fill('自动化测试区')
      await roomFormItem('容纳人数').locator('input').first().fill('8')
      await roomFormItem('设备设施').locator('input').first().fill('投影仪,白板')
      await roomDialog.getByRole('button', { name: '保存' }).click()
      await roomDialog.waitFor({ state: 'hidden' })
      const roomPage = await api.get(
        `/oa/meeting-room/page?pageNo=1&pageSize=10&name=${encodeURIComponent(roomName)}`
      )
      roomId = roomPage?.data?.list?.[0]?.id
      caseRecord.checks.push({
        name: '会议室设置页可创建 OA 会议室台账（PB-371）',
        passed: Boolean(roomId),
        details: `会议室编号=${roomId || '未落库'}`
      })
      if (!roomId) {
        caseRecord.notes.push('会议室创建未落库，终止预约冲突与工作台聚合验证。')
        await saveScreenshot(page, outputDir, 'wbf010-room-create-failed', record)
        return { token, api }
      }

      await openRoute(page, '/oa/reservation/meeting-room')
      await page.getByRole('button', { name: '新增预约' }).first().click()
      // Date pickers also render role="dialog"; keep the booking form anchored to
      // its title so opening the start-time picker does not retarget the locator.
      const bookingDialog = page.locator('.el-dialog').filter({ hasText: '新增会议预约' }).last()
      await bookingDialog.waitFor({ state: 'visible' })
      const bookingFormItem = (label) =>
        bookingDialog.locator('.el-form-item').filter({ hasText: label }).first()
      await bookingFormItem('会议主题').locator('input').first().fill(subject)
      await bookingFormItem('会议室').locator('.el-select').first().click()
      await page.getByRole('option', { name: new RegExp(roomName) }).first().click()
      const startTimeInput = bookingFormItem('开始时间').locator('input').first()
      await startTimeInput.fill(startTime)
      await startTimeInput.press('Tab')
      const endTimeInput = bookingFormItem('结束时间').locator('input').first()
      await endTimeInput.fill(endTime)
      await endTimeInput.press('Tab')
      await bookingDialog.getByRole('button', { name: '保存' }).click()
      await bookingDialog.waitFor({ state: 'hidden' })
      const bookingPage = await api.get(
        `/oa/meeting-booking/page?pageNo=1&pageSize=10&subject=${encodeURIComponent(subject)}`
      )
      bookingId = bookingPage?.data?.list?.[0]?.id
      caseRecord.checks.push({
        name: '会议室预约页可通过真实表单创建会议预约（PB-371）',
        passed: Boolean(bookingId),
        details: `预约编号=${bookingId || '未落库'}；时间=${startTime} ~ ${endTime}`
      })
      if (!/^[1-9]\d*$/.test(String(bookingId))) {
        throw new Error('会议预约未返回正式安全ID，不能验证日程事实源')
      }
      const scheduleCopiesBefore = await runReadOnlySql(
        `SELECT COUNT(*) FROM oa_schedule WHERE tenant_id=1 AND title='${subject}'`
      )

      const conflict = await api.post('/oa/meeting-booking/create', {
        roomId,
        subject: conflictSubject,
        attendeeUserIds: [],
        startTime,
        endTime,
        description: '自动化冲突校验'
      })
      caseRecord.checks.push({
        name: '同一会议室同时间区间的重复预约被后端拒绝（PB-371）',
        passed: conflict?.code !== 0 && String(conflict?.msg || '').includes('已被占用'),
        details: `冲突返回 code=${conflict?.code}，msg=${conflict?.msg || ''}`
      })

      const meetings = assertBusinessSuccess(
        await api.get(`/oa/meeting-booking/my-range?rangeStart=${encodeURIComponent(startTime)}` +
          `&rangeEnd=${encodeURIComponent(endTime)}`),
        '工作台OA预约来源'
      ).data
      await openRoute(page, WORKBENCH_PATH)
      const schedulePanel = page.locator('.schedule-panel').first()
      await schedulePanel.waitFor({ state: 'visible' })
      await schedulePanel
        .locator('.agenda-row, .el-empty')
        .first()
        .waitFor({ state: 'visible', timeout: 60000 })
      const weekStart = (value) => {
        const result = new Date(value)
        result.setHours(0, 0, 0, 0)
        const offset = (result.getDay() + 6) % 7
        result.setDate(result.getDate() - offset)
        return result
      }
      const weekOffset = Math.round(
        (weekStart(day).getTime() - weekStart(new Date()).getTime()) / (7 * 24 * 60 * 60 * 1000)
      )
      const weekButton = weekOffset >= 0
        ? page.getByRole('button', { name: '下一周' })
        : page.getByRole('button', { name: '上一周' })
      for (let index = 0; index < Math.abs(weekOffset); index++) {
        await weekButton.click()
      }
      const targetWeekday = (day.getDay() + 6) % 7
      await page.locator('.week-days button').nth(targetWeekday).click()
      const meetingText = await schedulePanel.innerText()
      caseRecord.checks.push({
        name: '工作台我的日程只读聚合 OA 会议室预约（PB-371）',
        passed: meetingText.includes(subject),
        details: meetingText.includes(subject)
          ? `日程区出现会议主题=${subject}`
          : `日程区未出现会议主题=${subject}`
      })
      const scheduleCopiesAfter = await runReadOnlySql(
        `SELECT COUNT(*) FROM oa_schedule WHERE tenant_id=1 AND title='${subject}'`
      )
      const originalBooking = Array.isArray(meetings) && meetings.filter((row) =>
        String(row.id) === String(bookingId) && String(row.roomId) === String(roomId) &&
        row.subject === subject)
      caseRecord.checks.push({
        name: '工作台日程保留OA预约原ID且不复制日程事实',
        passed: meetingText.includes(subject) && originalBooking?.length === 1 &&
          scheduleCopiesBefore.available && scheduleCopiesAfter.available &&
          scheduleCopiesBefore.rows[0]?.[0] === '0' && scheduleCopiesAfter.rows[0]?.[0] === '0',
        details: JSON.stringify({ bookingId, roomId, originalBooking,
          before: scheduleCopiesBefore.rows, after: scheduleCopiesAfter.rows })
      })
      await saveScreenshot(page, outputDir, 'wbf010-meeting-reservation-workbench', record)
      caseRecord.evidence.push('WBF-010 校验会议室台账、时段冲突与工作台 OA 会议只读聚合')
      return finishPageCase()
    } finally {
      const cleanupErrors = []
      try {
        if (!bookingId && roomId) {
          const bookingPage = assertBusinessSuccess(await api.get(
            `/oa/meeting-booking/page?pageNo=1&pageSize=100&subject=${encodeURIComponent(subject)}`
          ), '专属预约清理定位').data
          bookingId = bookingPage.list.find((row) =>
            row.subject === subject && String(row.roomId) === String(roomId))?.id
        }
        if (bookingId) {
          assertBusinessSuccess(await api.put(`/oa/meeting-booking/cancel?id=${bookingId}`), '取消本轮预约')
          const cancelled = assertBusinessSuccess(
            await api.get(`/oa/meeting-booking/get?id=${bookingId}`), '取消预约正式回读'
          ).data
          if (cancelled?.status !== 30 || cancelled.subject !== subject ||
            String(cancelled.roomId) !== String(roomId)) throw new Error('专属预约未正式取消')
          caseRecord.fixtureResiduals = [...(caseRecord.fixtureResiduals || []), {
            type: 'oa-meeting-booking', id: String(bookingId), roomId: String(roomId),
            status: 'CANCELLED', reason: '正式取消预约，保留历史审计'
          }]
        }
      } catch (error) {
        cleanupErrors.push(error.message)
      }
      if (roomId) {
        try {
          assertBusinessSuccess(await api.delete(`/oa/meeting-room/delete?id=${roomId}`), '删除本轮会议室')
          const removed = assertBusinessSuccess(
            await api.get(`/oa/meeting-room/get?id=${roomId}`), '会议室删除回读'
          ).data
          if (removed != null) throw new Error('本轮会议室删除后仍存在')
        } catch (error) {
          cleanupErrors.push(error.message)
        }
      }
      caseRecord.checks.push({
        name: '本轮会议室正式删除且预约取消保留审计', passed: cleanupErrors.length === 0,
        details: JSON.stringify({ roomId, bookingId, cleanupErrors })
      })
    }
  }

  if (caseId === 'WBF-011') {
    // 发送调查与待填写回收（PB-358）：事实源在 HRM，工作台只做发送入口与填写回收。
    const suffix = String(Date.now()).slice(-6)
    const title = `自动化调查-${suffix}`
    const permission = await api.get('/system/auth/get-permission-info')
    const currentUserId = permission?.data?.user?.id
    if (!currentUserId) throw new Error('当前登录人编号回读失败，禁止向空范围发放调查')
    caseRecord.checks.push({
      name: '获取当前登录人编号用于定向发放调查',
      passed: Boolean(currentUserId),
      details: `当前用户编号=${currentUserId || '未获取'}`
    })

    const created = await api.post('/hrm/survey/send', {
      title,
      description: '自动化测试调查，请选择后提交',
      anonymous: false,
      recipientUserIds: currentUserId ? [currentUserId] : [],
      questions: [
        {
          title: '满意度',
          questionType: 1,
          required: true,
          options: ['满意', '一般'],
          sort: 0
        }
      ]
    })
    const surveyId = created?.data
    caseRecord.checks.push({
      name: '工作台发送调查调用 HRM 通用问卷接口（PB-358）',
      passed: created?.code === 0 && Boolean(surveyId),
      details: `问卷编号=${surveyId || '未落库'}，返回 code=${created?.code}`
    })
    if (!surveyId) {
      caseRecord.notes.push('问卷未落库，终止工作台待填写回收验证。')
      return { token, api }
    }

    await openRoute(page, WORKBENCH_PATH)
    const announcementPanel = page.locator('.announcement-panel').first()
    await announcementPanel.waitFor({ state: 'visible' })
    const surveyRow = announcementPanel.locator('.survey-row').filter({ hasText: title }).first()
    await surveyRow.waitFor({ state: 'visible', timeout: 15000 })
    caseRecord.checks.push({
      name: '待填写调查显示在工作台通知公告区块（PB-358）',
      passed: (await surveyRow.count()) > 0,
      details: `调查标题=${title}`
    })

    await surveyRow.click()
    const submitDialog = page.locator('.survey-submit-dialog').first()
    await submitDialog.waitFor({ state: 'visible' })
    await submitDialog
      .locator('label.el-radio')
      .filter({ hasText: '满意' })
      .first()
      .click()
    await submitDialog.getByRole('button', { name: '提交' }).click()
    await submitDialog.waitFor({ state: 'hidden' })

    const pendingAfterSubmit = assertBusinessSuccess(
      await api.get('/hrm/survey/my-pending'), '问卷提交后的正式待填写回读'
    ).data
    if (!Array.isArray(pendingAfterSubmit)) throw new Error('问卷待填写响应不是正式数组')
    const stillPending = pendingAfterSubmit.some((item) => String(item.surveyId) === String(surveyId))
    caseRecord.checks.push({
      name: '提交后问卷从待填写清单回收（PB-358）',
      passed: !stillPending,
      details: stillPending ? '提交后仍出现在待填写清单' : '提交后已从待填写清单移除'
    })

    await announcementPanel
      .locator('.survey-row')
      .filter({ hasText: title })
      .first()
      .waitFor({ state: 'hidden', timeout: 15000 })
      .catch(() => undefined)
    caseRecord.checks.push({
      name: '提交后工作台不再展示该待填写调查',
      passed:
        (await announcementPanel.locator('.survey-row').filter({ hasText: title }).count()) === 0,
      details: `调查标题=${title}`
    })
    await saveScreenshot(page, outputDir, 'wbf011-survey-collected', record)
    caseRecord.evidence.push('WBF-011 校验发送调查、工作台待填写展示与提交回收链路')
    caseRecord.notes.push('HRM 问卷当前无删除接口，用例保留一条已提交问卷记录，待补作废/删除能力后再实现硬清理。')
    return finishPageCase()
  }

  if (caseId === 'WBF-012') {
    const identity = readGate
    const initial = await captureWorkbenchReports(
      page, () => (dependencies.openRoute || openRoute)(page, WORKBENCH_PATH), identity.userId
    )
    if (initial.missing.length) return reportPartial(token, api, caseRecord, initial.missing)
    const reportPanel = page.locator('.report-panel').first()
    await reportPanel.waitFor({ state: 'visible' })
    await waitForReportRendering(reportPanel)
    const statsDialog = page.locator('.report-stats-dialog').first()
    const gaps = ['未使用无权限账号及他人报告验证团队权限反例',
      'CRM Mapper 当前强制仅本人；PMS getReportPage 未见团队数据权限过滤，不能声明团队隔离已通过']
    const steps = [
      { period: 'month', scope: 'self', action: () => reportPanel.getByRole('button', { name: '统计' }).first().click() },
      { period: 'quarter', scope: 'self', label: '本季度' },
      { period: 'year', scope: 'self', label: '本年度' }
    ]
    // Broad PMS reads are safe only for an explicitly unrestricted account.
    if (identity.unrestricted) {
      steps.push({ period: 'year', scope: 'team', label: '团队（按数据权限）' })
      steps.push({ period: 'year', scope: 'self', label: '本人' })
    } else {
      gaps.push('未点击团队：PMS 团队权限未确认，当前账号无 *:*:* 全范围授权')
    }
    try {
      for (const step of steps) {
        const captured = await captureWorkbenchReports(page, step.action || (() => statsDialog
          .locator('label.el-radio-button').filter({ hasText: step.label }).first().click()),
        identity.userId, step.scope)
        if (captured.missing.length) {
          gaps.push(...captured.missing)
          break
        }
        await statsDialog.waitFor({ state: 'visible' })
        await statsDialog.locator('.el-loading-mask').waitFor({ state: 'hidden', timeout: 15000 })
        const today = await page.evaluate(() => {
          const now = new Date()
          return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        })
        const expected = summarizeWorkbenchReports(captured.pages, step.period, today)
        const periodLabel = { month: '本月', quarter: '本季度', year: '本年度' }[step.period]
        const scopeLabel = step.scope === 'self' ? '本人' : '团队（按数据权限）'
        // 轮询比对并在超时时输出实际值，避免 waitForFunction 只报超时无法定位差异。
        const readStats = () => page.evaluate(() => {
          const dialog = [...document.querySelectorAll('.report-stats-dialog')].find((el) => {
            const style = window.getComputedStyle(el)
            return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0
          })
          if (!dialog) return { visible: false, rows: [], selected: [] }
          return {
            visible: true,
            rows: [...dialog.querySelectorAll('.el-table__body tr')]
              .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim())),
            selected: [...dialog.querySelectorAll('label.el-radio-button.is-active')]
              .map((label) => label.textContent.trim())
          }
        })
        const statsDeadline = Date.now() + 20000
        let actualStats = null
        while (Date.now() < statsDeadline) {
          actualStats = await readStats()
          if (actualStats.visible && actualStats.selected.includes(periodLabel) &&
            actualStats.selected.includes(scopeLabel) &&
            JSON.stringify(actualStats.rows) === JSON.stringify(expected)) break
          await page.waitForTimeout(250)
        }
        if (!actualStats?.visible || !actualStats.selected.includes(periodLabel) ||
          !actualStats.selected.includes(scopeLabel) ||
          JSON.stringify(actualStats.rows) !== JSON.stringify(expected)) {
          throw new Error(`${step.period}/${step.scope}报统计表数值或范围不符：` +
            `实际=${JSON.stringify(actualStats)}；期望=${JSON.stringify({ rows: expected, periodLabel, scopeLabel })}`)
        }
        caseRecord.checks.push({
          name: `${step.period}/${step.scope}真实范围请求与统计数值一致（PB-364）`,
          passed: true,
          details: `三份 GET 的归属参数已核对；合计/待审批/已通过/退回逾期=${JSON.stringify(expected)}；仅核对返回页`
        })
        caseRecord.evidence.push(`WBF-012 已核对 ${step.period}/${step.scope} 三份 GET 归属参数、加载完成和三行四项数值`)
        for (const query of REPORT_QUERIES) {
          const data = captured.pages[query.type]
          if (data.total > data.list.length) gaps.push(
            `${step.period}/${step.scope}/${query.label}仅加载 ${data.list.length}/${data.total} 条，完整汇总未验收`
          )
        }
      }
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'wbf012-report-stats', record)
    } finally {
      if (await statsDialog.isVisible()) {
        await statsDialog.getByRole('button', { name: '关闭', exact: true }).click()
        await statsDialog.waitFor({ state: 'hidden' })
      }
    }
    caseRecord.checks.push({
      name: '关闭统计后仍停留在工作台',
      passed: new URL(page.url()).pathname === WORKBENCH_PATH,
      details: `当前路由=${new URL(page.url()).pathname}`
    })
    return reportPartial(token, api, caseRecord, gaps)
  }
}
