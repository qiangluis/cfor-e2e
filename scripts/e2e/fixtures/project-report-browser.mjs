import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { config } from '../config/index.mjs'
import { gotoSite, waitForPageReady } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

const definitions = [
  ['project-progress', 'PROJECT_PROGRESS', '项目进度报表', [
    ['projectCount', '项目总数'], ['activeProjectCount', '执行中项目'],
    ['overdueProjectCount', '超期项目'], ['averageProgressRate', '平均进度', true]
  ]],
  ['task-execution', 'TASK_EXECUTION', '任务执行报表', [
    ['taskCount', '任务总数'], ['completedTaskCount', '已完成'],
    ['inProgressTaskCount', '进行中'], ['blockedTaskCount', '已阻塞'],
    ['taskCompletionRate', '完成率', true]
  ]],
  ['research', 'RESEARCH', '调研报表', [
    ['researchTaskCount', '调研任务'], ['researchCompletedCount', '已完成调研']
  ]],
  ['risk-issue', 'RISK_ISSUE_BUG', '风险问题 Bug 报表', [
    ['openRiskCount', '开放风险'], ['openIssueCount', '开放问题'], ['openBugCount', '开放 Bug']
  ]],
  ['plan-change', 'PLAN_CHANGE', '计划变更报表', [
    ['planCount', '计划总数'], ['approvedPlanCount', '已审核计划'], ['pendingChangeCount', '待处理变更']
  ]],
  ['release', 'RELEASE', '发布报表', [
    ['releaseCount', '发布记录'], ['approvedReleaseCount', '待发布']
  ]],
  ['go-live-issue', 'GO_LIVE_ISSUE', '上线问题报表', [['openIssueCount', '开放上线问题']]],
  ['acceptance-rectification', 'ACCEPTANCE_RECTIFICATION', '验收整改报表', [
    ['acceptanceCount', '验收记录'], ['approvedAcceptanceCount', '已通过验收'],
    ['openRectificationCount', '开放整改']
  ]],
  ['review', 'PROJECT_REVIEW', '项目复盘报表', [
    ['reviewCount', '复盘记录'], ['completedReviewCount', '已完成复盘']
  ]],
  ['after-sales-handover', 'AFTER_SALES_HANDOVER', '售后移交报表', [
    ['handoverCount', '移交记录'], ['confirmedHandoverCount', '已确认承接']
  ]],
  ['closeout', 'PROJECT_CLOSEOUT', '项目结项报表', [
    ['closeoutCount', '结项记录'], ['approvedCloseoutCount', '已审批结项']
  ]]
]
export const PROJECT_REPORT_BROWSER_DEFINITIONS = Object.freeze(definitions.map(
  ([path, reportType, title, metrics]) => Object.freeze({ path, reportType, title,
    metrics: Object.freeze(metrics.map(([key, label, percent = false]) =>
      Object.freeze({ key, label, percent }))) })
))
const definitionFor = (path) => {
  const definition = PROJECT_REPORT_BROWSER_DEFINITIONS.find((item) => item.path === path)
  assert.ok(definition, `PB953 unknown report: ${path}`)
  return definition
}
const id = (value) => {
  assert.ok(typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)),
    'PB953 requires a lossless ID')
  assert.match(String(value), /^[1-9]\d*$/, 'PB953 invalid ID')
  return String(value)
}
const formalComponent = (component) => {
  let path = component.split('?')[0].trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  const viewsIndex = path.lastIndexOf('/views/')
  if (viewsIndex >= 0) path = path.slice(viewsIndex + 7)
  path = path.replace(/^\/+/, '').replace(/^views\//, '').replace(/\.(vue|tsx)$/, '')
  return path === 'project-management/report/index' || path === 'project-management/report'
}

export const resolveProjectReportMenuRoute = (menus, reportPath) => {
  definitionFor(reportPath)
  assert.ok(Array.isArray(menus), 'PB953 missing real permission menus')
  const matches = []
  const walk = (nodes, parent = '') => {
    for (const node of nodes) {
      if (typeof node.path !== 'string' || /^(?:[\w+-]+:|\/\/)/.test(node.path) ||
          node.path.includes('#')) continue
      const pathname = node.path.split('?')[0].replace(/\\/g, '/').replace(/\/+/g, '/')
      if (pathname.split('/').some((part) => part === '..' || part === '.')) continue
      const fullPath = pathname.startsWith('/') ? pathname : `${parent}/${pathname}`
      if (Array.isArray(node.children) && node.children.length) {
        walk(node.children, fullPath)
        continue
      }
      if (!node.component || !formalComponent(node.component)) continue
      const context = new URLSearchParams(node.component.split('?').slice(1).join('?'))
      const types = context.getAll('reportType')
      assert.ok(types.length <= 1, `PB953 ambiguous component context: ${fullPath}`)
      // Match the same context precedence as report/index.vue, never URL query injection.
      const type = types[0] || fullPath.match(
        /\/(?:reports\/project|project\/statistics)\/([^/]+)$/)?.[1]
      if (type === reportPath) matches.push({
        route: fullPath.replace(/\/+/g, '/'), menuId: id(node.id), component: node.component
      })
    }
  }
  walk(menus)
  assert.equal(matches.length, 1,
    `PB953 expected one configured permission-menu report ${reportPath}, found ${matches.length}`)
  return matches[0]
}

const assertQuery = (actual, expected) => {
  assert.deepEqual(Object.fromEntries(Object.entries(actual || {}).filter(
    ([, value]) => value !== undefined && value !== null && value !== ''
  )), { projectId: id(expected.projectId), startDate: expected.startDate, endDate: expected.endDate },
  'PB953 report must use only the owned project and exact date range')
}
export const assertProjectReportBrowserResponse = (event, path, query, expected) => {
  const definition = definitionFor(path)
  assert.equal(event.method, 'GET', 'PB953 must observe a real browser GET')
  assert.equal(event.pathname, `/admin-api/pm/report/${path}`, 'PB953 foreign report endpoint')
  assert.ok(event.ok && event.status === 200, `PB953 report HTTP ${event.status}`)
  assertQuery(event.query, query)
  const report = assertBusinessSuccess(event.payload, 'PB953 browser report').data
  assert.equal(report?.reportType, definition.reportType, 'PB953 wrong browser report type')
  assertQuery(report.appliedFilters, query)
  assert.ok(Number.isInteger(report.metricVersion) && report.metricVersion > 0,
    'PB953 missing metric version')
  assert.equal(report.calculationMode, 'RECHECKED')
  assert.ok(typeof report.generatedAt === 'string' && report.generatedAt.trim(),
    'PB953 missing generation time')
  assert.ok(expected, 'PB953 missing API reconciliation report')
  assert.equal(expected.reportType, definition.reportType)
  assertQuery(expected.appliedFilters, query)
  assert.equal(report.metricVersion, expected.metricVersion, 'PB953 metric version drift')
  assert.equal(report.calculationMode, expected.calculationMode)
  for (const { key } of definition.metrics) {
    assert.ok(typeof report[key] === 'number' && Number.isFinite(report[key]),
      `PB953 missing/non-numeric browser metric ${key}`)
    assert.equal(report[key], expected[key], `PB953 browser/API metric mismatch: ${key}`)
  }
  if (definition.reportType === 'PROJECT_PROGRESS') {
    assert.equal(report.projectCount, 1, 'PB953 owned project positive control must be present')
  }
  return report
}

export const assertProjectReportPageText = (text) => {
  assert.doesNotMatch(text,
    /模块配置异常|报表配置异常|未配置.*报表类型|页面加载失败|报表暂时无法加载|报表加载失败|暂无报表数据|没有可展示的数据|页面不存在|Page Not Found|\b404\b|\b403\b|无权限|没有权限|权限不足|权限拒绝|无权访问|拒绝访问|Forbidden|Access Denied|登录已过期|请重新登录/i,
    'PB953 error/placeholder/permission page cannot be accepted')
}
export const assertProjectReportRendered = (rendered, path, report, projectLabel, query) => {
  const definition = definitionFor(path)
  assertProjectReportPageText(rendered.bodyText)
  assert.equal(rendered.title, definition.title)
  assert.equal(rendered.projectLabel, projectLabel, 'PB953 owned project selection did not persist')
  assert.deepEqual(rendered.dateRange, [query.startDate, query.endDate])
  for (const value of [
    `报表类型：${definition.reportType}`, `口径版本：V${report.metricVersion}`, '计算口径：即时重算',
    `生成时间：${report.generatedAt.replace('T', ' ').slice(0, 19)}`
  ]) assert.ok(rendered.metaText.includes(value), `PB953 missing rendered ${value}`)
  assert.deepEqual(rendered.metrics, definition.metrics.map(({ key, label, percent }) => ({
    label, value: percent ? Number(report[key]).toFixed(2) : Number(report[key]).toLocaleString('zh-CN')
  })), 'PB953 every visible metric must match the successful owned browser response')
  return true
}

export const assertProjectReportOption = (event, project) => {
  assert.ok(event.ok && event.status === 200, `PB953 project options HTTP ${event.status}`)
  assert.equal(event.method, 'GET')
  assert.equal(event.pathname, '/admin-api/pm/project/page')
  assert.equal(event.query.pageNo, '1')
  assert.equal(event.query.pageSize, '100')
  const data = assertBusinessSuccess(event.payload, 'PB953 browser project options').data
  assert.ok(Array.isArray(data?.list), 'PB953 missing browser project options')
  const rows = data.list.filter((row) => id(row.id) === id(project.id))
  assert.equal(rows.length, 1,
    'PB953 owned project absent/ambiguous in real page options (first 100); frontend fix required')
  const row = rows[0]
  assert.equal(row.projectCode, project.projectCode)
  assert.equal(row.projectName, project.projectName)
  assert.ok(row.projectCode && row.projectName, 'PB953 missing owned project label')
  return `${row.projectCode} ${row.projectName}`.trim()
}

// Own listeners are scoped to this helper; failed navigation never leaves response waiters behind.
export const observeProjectReportBrowser = (page, { timeoutMs = 15000 } = {}) => {
  const events = []
  const pending = new Set()
  const errors = []
  const relevant = (url) => /^\/admin-api\/pm\/(?:report\/[^/]+|project\/page)$/.test(url.pathname)
  const onResponse = (response) => {
    const url = new URL(response.url())
    const request = response.request()
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      events.push({ navigation: true, pathname: url.pathname, ok: response.ok(), status: response.status() })
      if (!response.ok()) errors.push(new Error(`PB953 document HTTP ${response.status()}`))
    }
    if (request.resourceType() === 'script' && !response.ok() && response.status() !== 304) {
      errors.push(new Error(`PB953 lazy-load HTTP ${response.status()}: ${url.pathname}`))
    }
    if (!relevant(url)) return
    const event = { pathname: url.pathname, method: request.method(), status: response.status(),
      ok: response.ok(), query: Object.fromEntries(url.searchParams) }
    events.push(event)
    const task = (async () => {
      assert.ok(event.ok, `PB953 browser HTTP ${event.status}: ${event.pathname}`)
      const text = await response.text()
      event.payload = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
      assertBusinessSuccess(event.payload, 'PB953 browser read')
    })().catch((error) => errors.push(error)).finally(() => pending.delete(task))
    pending.add(task)
  }
  const onRequestFailed = (request) => {
    if (relevant(new URL(request.url())) || request.resourceType() === 'script') {
      errors.push(new Error(`PB953 browser request failed: ${new URL(request.url()).pathname}`))
    }
  }
  const onPageError = (error) => errors.push(error)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)
  page.on('pageerror', onPageError)
  const healthy = () => { if (errors.length) throw errors[0] }
  return {
    mark: () => events.length,
    healthy,
    async waitFor (predicate, after = 0) {
      const deadline = Date.now() + timeoutMs
      do {
        healthy()
        const event = events.slice(after).find((event) => event.payload && predicate(event))
        if (event) return event
        await delay(20)
      } while (Date.now() < deadline)
      throw new Error('PB953 timed out awaiting successful real browser response/body')
    },
    assertNavigation (route, after) {
      healthy()
      assert.ok(events.slice(after).some((event) =>
        event.navigation && event.pathname === route && event.ok && event.status === 200),
      'PB953 missing successful real report document response')
    },
    async flush () {
      const deadline = Date.now() + timeoutMs
      while (pending.size) {
        healthy()
        assert.ok(Date.now() < deadline, 'PB953 response bodies remain pending')
        await delay(20)
      }
      healthy()
    },
    close () {
      page.off('response', onResponse)
      page.off('requestfailed', onRequestFailed)
      page.off('pageerror', onPageError)
    }
  }
}

const formField = (page, root, label) => root.locator('.el-form-item').filter({
  has: page.locator('.el-form-item__label', { hasText: new RegExp(`^${label}$`) })
})
const selectedProject = (select) => select.locator(
  '.el-select__selection > .el-select__selected-item:not(.el-select__input-wrapper)')
export const selectProjectReportFilters = async (page, root, projectLabel, query) => {
  const select = formField(page, root, '项目').locator('.el-select')
  await select.click()
  const expanded = select.locator('input[role="combobox"][aria-expanded="true"]')
  await expanded.waitFor({ state: 'attached' })
  const controls = await expanded.getAttribute('aria-controls')
  assert.match(controls || '', /^[\w:-]+$/, 'PB953 project select must identify its own listbox')
  const selector = `[role="listbox"][id=${JSON.stringify(controls)}]`
  const popup = page.locator('.el-popper.el-select__popper[aria-hidden="false"]:visible')
    .filter({ has: page.locator(selector) })
  await popup.waitFor({ state: 'visible' })
  const option = popup.locator(selector).getByRole('option', { name: projectLabel, exact: true })
  assert.equal(await option.count(), 1, 'PB953 owned project option must resolve uniquely')
  await option.click()
  await popup.waitFor({ state: 'hidden' })
  assert.equal((await selectedProject(select).innerText()).trim(), projectLabel)
  const dates = formField(page, root, '统计日期').locator('.el-date-editor input')
  assert.equal(await dates.count(), 2, 'PB953 requires the real date-range control')
  for (const [index, value] of [query.startDate, query.endDate].entries()) {
    await dates.nth(index).fill(value)
    await dates.nth(index).press('Tab')
  }
  await dates.nth(1).press('Enter')
}

const readRendered = async (page, root) => {
  const metrics = root.locator('.report-metric')
  const result = []
  for (let index = 0; index < await metrics.count(); index++) {
    const metric = metrics.nth(index)
    result.push({
      label: (await metric.locator('.report-metric__label').innerText()).trim(),
      value: (await metric.locator('.report-metric__value').innerText()).trim()
    })
  }
  const dates = formField(page, root, '统计日期').locator('.el-date-editor input')
  return {
    bodyText: await page.locator('body').innerText(),
    title: (await root.locator('h1').innerText()).trim(),
    projectLabel: (await selectedProject(formField(page, root, '项目')
      .locator('.el-select')).innerText()).trim(),
    dateRange: [await dates.nth(0).inputValue(), await dates.nth(1).inputValue()],
    metaText: await root.locator('.report-meta-row').innerText(), metrics: result
  }
}

export const verifyProjectReportPages = async ({
  page, api, project, query, reports, capture = async () => {}, timeoutMs = 15000,
  reportPaths = PROJECT_REPORT_BROWSER_DEFINITIONS.map((item) => item.path)
}) => {
  assert.equal(id(project?.id), id(query?.projectId), 'PB953 foreign project query')
  for (const value of [query.startDate, query.endDate]) assert.match(value || '', /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(query.startDate <= query.endDate, 'PB953 reversed date range')
  assert.ok(reports instanceof Map && reportPaths.length > 0, 'PB953 requires API reports and page types')
  assert.equal(new Set(reportPaths).size, reportPaths.length, 'PB953 duplicate page types')
  const info = assertBusinessSuccess(await api.getBusiness('/system/auth/get-permission-info'),
    'PB953 permission menus').data
  assert.ok(info?.permissions?.some((permission) => ['pm:report:query', '*:*:*'].includes(permission)),
    'PB953 current actor lacks formal report query permission')
  const routes = reportPaths.map((path) => ({ path, ...resolveProjectReportMenuRoute(info.menus, path) }))
  const observer = observeProjectReportBrowser(page, { timeoutMs })
  const evidence = []
  try {
    for (const target of routes) {
      const definition = definitionFor(target.path)
      const expected = reports.get(definition.reportType)
      assert.ok(expected, `PB953 missing API report ${definition.reportType}`)
      const navigationMark = observer.mark()
      const selector = `.pm-report-page[data-testid="pm-report-${target.path}"]`
      await gotoSite(page, new URL(target.route, config.webBase).toString(), {
        goto: { waitUntil: 'domcontentloaded', timeout: timeoutMs }
      })
      observer.assertNavigation(target.route, navigationMark)
      assert.equal(new URL(page.url()).pathname, target.route, 'PB953 report route redirected')
      const root = page.locator(selector)
      try {
        await root.waitFor({ state: 'visible', timeout: timeoutMs })
      } catch (error) {
        assertProjectReportPageText(await page.locator('body').innerText())
        throw error
      }
      await waitForPageReady(page, timeoutMs)
      assertProjectReportPageText(await page.locator('body').innerText())
      const optionEvent = await observer.waitFor(
        (event) => event.pathname === '/admin-api/pm/project/page', navigationMark)
      const projectLabel = assertProjectReportOption(optionEvent, project)
      assert.equal(await root.count(), 1, 'PB953 official report root must resolve uniquely')
      await selectProjectReportFilters(page, root, projectLabel, query)
      const queryMark = observer.mark()
      await root.getByRole('button', { name: '查询', exact: true }).click()
      const response = await observer.waitFor((event) =>
        event.pathname === `/admin-api/pm/report/${target.path}`, queryMark)
      const report = assertProjectReportBrowserResponse(response, target.path, query, expected)
      await waitForPageReady(page, timeoutMs)
      await root.locator('.report-body').waitFor({ state: 'visible', timeout: timeoutMs })
      await observer.flush()
      const rendered = await readRendered(page, root)
      assertProjectReportRendered(rendered, target.path, report, projectLabel, query)
      const screenshot = await capture(`pb953-project-report-${target.path}`)
      evidence.push({ ...target, projectId: id(project.id), query: { ...query },
        response: report, rendered, screenshot })
    }
    await observer.flush()
    return evidence
  } finally {
    observer.close()
  }
}
