import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { observePage } from '../lib/browser.mjs'
import { ENCRYPT_HEADER, RESP_KEY } from '../lib/crypto.mjs'
import {
  PROJECT_REPORT_BROWSER_DEFINITIONS,
  assertProjectReportBrowserResponse,
  assertProjectReportOption,
  assertProjectReportPageText,
  assertProjectReportRendered,
  observeProjectReportBrowser,
  resolveProjectReportMenuRoute,
  verifyProjectReportPages
} from '../fixtures/project-report-browser.mjs'

const project = {
  id: '2110003329070088194', projectCode: 'PB953-OWNED', projectName: 'PB953-REPORT-PROJECT'
}
const query = { projectId: project.id, startDate: '2026-10-12', endDate: '2026-10-14' }
const projectLabel = `${project.projectCode} ${project.projectName}`
const definition = PROJECT_REPORT_BROWSER_DEFINITIONS[0]
const makeReport = (definition) => ({
  reportType: definition.reportType, metricVersion: 1, calculationMode: 'RECHECKED',
  generatedAt: '2026-10-13T13:42:50', appliedFilters: { ...query },
  ...Object.fromEntries(definition.metrics.map(({ key, percent }, index) =>
    [key, key === 'projectCount' ? 1 : percent ? 14.29 : index]))
})
const reports = new Map(PROJECT_REPORT_BROWSER_DEFINITIONS.map((item) =>
  [item.reportType, makeReport(item)]))
const report = reports.get(definition.reportType)
const menus = [{
  id: '29412700', path: '/reports', children: [{
    id: '58800005', path: 'project', children: [{
      id: '58800032', path: 'project-plan', children: PROJECT_REPORT_BROWSER_DEFINITIONS.map((item, index) => ({
        id: String(58800040 + index), path: item.path,
        component: `project-management/report/index?reportType=${item.path}`
      }))
    }]
  }]
}]
const info = { permissions: ['pm:report:query'], menus }
const browserEvent = (path = definition.path, payload = report, eventQuery = query) => ({
  pathname: `/admin-api/pm/report/${path}`, query: { ...eventQuery }, method: 'GET',
  ok: true, status: 200, payload: { code: 0, data: payload }
})
const optionEvent = () => ({
  pathname: '/admin-api/pm/project/page', query: { pageNo: '1', pageSize: '100' },
  method: 'GET', ok: true, status: 200, payload: { code: 0, data: { list: [{ ...project }] } }
})
const renderedFor = (definition, value) => ({
  bodyText: definition.title, title: definition.title,
  projectLabel, dateRange: [query.startDate, query.endDate],
  metaText: `报表类型：${value.reportType} 口径版本：V${value.metricVersion} 计算口径：即时重算 ` +
    `生成时间：${value.generatedAt.replace('T', ' ').slice(0, 19)}`,
  metrics: definition.metrics.map(({ key, label, percent }) => ({
    label, value: percent ? value[key].toFixed(2) : value[key].toLocaleString('zh-CN')
  }))
})

const responseFor = (event, { text, headers = {} } = {}) => {
  const request = {
    method: () => event.method, isNavigationRequest: () => Boolean(event.navigation),
    frame: () => 'main', resourceType: () => event.navigation ? 'document' : 'xhr',
    url: () => `http://127.0.0.1:9151${event.pathname}?${new URLSearchParams(event.query || {})}`,
    failure: () => ({ errorText: 'net::ERR_FAILED' })
  }
  return {
    url: request.url, request: () => request, ok: () => event.ok, status: () => event.status,
    headers: () => headers, text: text || (async () => JSON.stringify(event.payload))
  }
}
const menuLeaf = (change = {}) => [{
  id: '58800040', path: '/reports/project/project-plan/project-progress',
  component: 'project-management/report/index?reportType=project-progress', ...change
}]

test('PB953 resolves all eleven formally configured components from nested real permission menus', () => {
  assert.equal(PROJECT_REPORT_BROWSER_DEFINITIONS.length, 11)
  for (const item of PROJECT_REPORT_BROWSER_DEFINITIONS) {
    const route = resolveProjectReportMenuRoute(menus, item.path)
    assert.equal(route.route, `/reports/project/project-plan/${item.path}`)
    assert.equal(route.component, `project-management/report/index?reportType=${item.path}`)
  }
})

test('PB953 route resolution mirrors view normalization, absolute children and component query context', () => {
  for (const component of [
    '/project-management/report/index.vue?reportType=project-progress',
    '../views/project-management/report/index.tsx?reportType=project-progress',
    '@/views/project-management/report?reportType=project-progress',
    'views\\project-management\\report\\index?reportType=project-progress'
  ]) {
    assert.equal(resolveProjectReportMenuRoute([{
      path: '/unrelated-parent', children: menuLeaf({ path: '/owned-report', component })
    }], definition.path).route, '/owned-report')
  }
  assert.equal(resolveProjectReportMenuRoute(menuLeaf({
    path: '/project/statistics/project-progress', component: 'project-management/report/index'
  }), definition.path).route, '/project/statistics/project-progress')
})

test('PB953 refuses module overview, generic pages, unconfigured routes and forged URL query report types', () => {
  for (const change of [
    { component: 'project-management/module-overview/index?moduleKey=reporting' },
    { component: 'project-management/generic-page/index?reportType=project-progress' },
    { component: 'project-management/report/index' },
    { component: 'project-management/report/index?reportType=task-execution' },
    { path: '/owned?reportType=project-progress', component: 'project-management/report/index' },
    { path: 'https://example.com/reports/project/project-progress' },
    { path: '//example.com/reports/project/project-progress' },
    { path: '/reports/../project-progress' }, { path: '/reports#project-progress' }
  ]) assert.throws(() => resolveProjectReportMenuRoute(menuLeaf(change), definition.path))
  assert.throws(() => resolveProjectReportMenuRoute(undefined, definition.path))
  assert.throws(() => resolveProjectReportMenuRoute([], 'invented'))
})

test('PB953 fails closed on duplicate routes/context and lossy menu IDs', () => {
  assert.throws(() => resolveProjectReportMenuRoute([...menuLeaf(), ...menuLeaf()], definition.path),
    /found 2/)
  assert.throws(() => resolveProjectReportMenuRoute(menuLeaf({
    component: 'project-management/report/index?reportType=project-progress&reportType=task-execution'
  }), definition.path), /ambiguous/)
  assert.throws(() => resolveProjectReportMenuRoute(menuLeaf({ id: Number(project.id) }), definition.path),
    /lossless/)
})

test('PB953 exact browser GET, business payload and every displayed metric reconcile for all eleven types', () => {
  for (const item of PROJECT_REPORT_BROWSER_DEFINITIONS) {
    const value = reports.get(item.reportType)
    assert.equal(assertProjectReportBrowserResponse(browserEvent(item.path, value), item.path, query, value), value)
    assert.equal(assertProjectReportRendered(renderedFor(item, value), item.path, value, projectLabel, query), true)
  }
})

test('PB953 rejects HTTP/business/authentication failures and foreign endpoints/queries/projects', () => {
  for (const change of [
    { ok: false, status: 404 }, { ok: false, status: 401 }, { ok: false, status: 403 },
    { status: 204 }, { method: 'POST' }, { pathname: '/admin-api/pm/report/task-execution' },
    { payload: { code: 403, msg: 'Forbidden' } }, { payload: { code: 0, success: false, data: report } },
    { query: {} }, { query: { ...query, projectId: '999' } },
    { query: { ...query, startDate: '2026-10-11' } },
    { query: { ...query, productId: '9' } }
  ]) assert.throws(() => assertProjectReportBrowserResponse(
    { ...browserEvent(), ...change }, definition.path, query, report))
  for (const change of [
    { reportType: 'TASK_EXECUTION' }, { metricVersion: 2 }, { metricVersion: null },
    { generatedAt: '' }, { calculationMode: 'CURRENT' },
    { appliedFilters: { ...query, projectId: '999' } },
    { appliedFilters: { ...query, endDate: '2026-10-15' } },
    { projectCount: 999 }, { averageProgressRate: null }, { projectCount: '0' }
  ]) assert.throws(() => assertProjectReportBrowserResponse(
    browserEvent(definition.path, { ...report, ...change }), definition.path, query, report))
  assert.throws(() => assertProjectReportBrowserResponse(browserEvent(), definition.path, query, undefined))
  for (const projectCount of [0, 2]) {
    const emptyOrShared = { ...report, projectCount }
    assert.throws(() => assertProjectReportBrowserResponse(
      browserEvent(definition.path, emptyOrShared), definition.path, query, emptyOrShared),
    /positive control/)
  }
})

test('PB953 first-100 project options require exact lossless ID, code and name, never a label-only match', () => {
  assert.equal(assertProjectReportOption(optionEvent(), project), projectLabel)
  for (const change of [
    { ok: false, status: 403 }, { method: 'POST' }, { pathname: '/admin-api/pms/pm/project/page' },
    { query: { pageNo: '2', pageSize: '100' } }, { query: { pageNo: '1', pageSize: '1000' } },
    { payload: { code: 0, data: { list: [] } } },
    { payload: { code: 0, data: { list: [{ ...project, id: '999' }] } } },
    { payload: { code: 0, data: { list: [{ ...project, id: Number(project.id) }] } } },
    { payload: { code: 0, data: { list: [{ ...project, projectName: 'OTHER' }] } } },
    { payload: { code: 0, data: { list: [{ ...project }, { ...project }] } } }
  ]) assert.throws(() => assertProjectReportOption({ ...optionEvent(), ...change }, project))
})

test('PB953 rejects error placeholders, 404 and permission pages even with correct report words elsewhere', () => {
  for (const text of [
    '模块配置异常，请联系管理员', '报表配置异常', '当前入口未配置有效的报表类型',
    '页面加载失败，请刷新后重试', '报表暂时无法加载', '报表加载失败',
    '暂无报表数据', '当前报表没有可展示的数据', '页面不存在', '404', 'Page Not Found',
    '403', '权限不足', '无权访问', 'Forbidden', 'Access Denied', '请重新登录'
  ]) assert.throws(() => assertProjectReportPageText(`${definition.title} ${text}`))
  const rendered = renderedFor(definition, report)
  for (const change of [
    { title: '统计概览' }, { projectLabel: '全部项目' }, { dateRange: [] }, { metaText: '' },
    { metrics: [] }, { metrics: [...rendered.metrics].reverse() },
    { metrics: rendered.metrics.map((item) => ({ ...item, value: '999' })) }
  ]) assert.throws(() => assertProjectReportRendered(
    { ...rendered, ...change }, definition.path, report, projectLabel, query))
})

test('PB953 response observer waits for actual body completion and decodes encrypted browser responses', async () => {
  const page = new EventEmitter()
  page.mainFrame = () => 'main'
  const observer = observeProjectReportBrowser(page, { timeoutMs: 5000 })
  let resolveBody
  const body = new Promise((resolve) => { resolveBody = resolve })
  const cipher = createCipheriv('aes-256-ecb',
    Buffer.from(process.env.CFOR_API_ENCRYPT_RESPONSE_KEY || RESP_KEY, 'utf8'), null)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ code: 0, data: report }), 'utf8'), cipher.final()
  ]).toString('base64')
  page.emit('response', responseFor(browserEvent(), {
    text: async () => body, headers: { [ENCRYPT_HEADER.toLowerCase()]: 'true' }
  }))
  let complete = false
  const waiting = observer.waitFor(() => true).then((event) => { complete = true; return event })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(complete, false)
    resolveBody(encrypted)
    const event = await waiting
    assert.deepEqual(event.payload.data, report)
    await observer.flush()
  } finally {
    observer.close()
  }
  for (const event of ['response', 'requestfailed', 'pageerror']) assert.equal(page.listenerCount(event), 0)
})

test('PB953 accepts a cached 304 script only while still requiring real report content', async () => {
  const page = new EventEmitter()
  page.mainFrame = () => 'main'
  const observer = observeProjectReportBrowser(page, { timeoutMs: 25 })
  const response = responseFor({
    pathname: '/src/locales/zh-CN.ts', method: 'GET', status: 304, ok: false
  })
  const request = { ...response.request(), resourceType: () => 'script' }
  page.emit('response', { ...response, request: () => request })
  try {
    await observer.flush()
    assert.throws(() => observer.assertNavigation('/reports/project/project-progress', 0),
      /missing successful/)
    await assert.rejects(observer.waitFor(() => true), /timed out/)
  } finally {
    observer.close()
  }
})

test('PB953 observer propagates HTTP/business/body/network/lazy-load failures and enforces fresh response marks', async () => {
  for (const failure of [
    'http', 'business', 'body', 'network', 'lazy', 'lazy-http', 'pageerror', 'timeout', 'pending'
  ]) {
    const page = new EventEmitter()
    page.mainFrame = () => 'main'
    const observer = observeProjectReportBrowser(page, { timeoutMs: 25 })
    try {
      if (failure === 'http') page.emit('response', responseFor({ ...browserEvent(), ok: false, status: 403 }))
      if (failure === 'business') page.emit('response', responseFor({
        ...browserEvent(), payload: { code: 500, msg: 'failed' }
      }))
      if (failure === 'body') page.emit('response', responseFor(browserEvent(), {
        text: async () => { throw new Error('body read failed') }
      }))
      if (failure === 'network') page.emit('requestfailed', responseFor(browserEvent()).request())
      if (failure === 'lazy') page.emit('requestfailed', {
        ...responseFor(browserEvent()).request(),
        url: () => 'http://127.0.0.1:9151/assets/report.js', resourceType: () => 'script'
      })
      if (failure === 'lazy-http') {
        const response = responseFor({ ...browserEvent(), ok: false, status: 404 })
        page.emit('response', { ...response,
          url: () => 'http://127.0.0.1:9151/assets/report.js',
          request: () => ({ ...response.request(), resourceType: () => 'script' })
        })
      }
      if (failure === 'pageerror') page.emit('pageerror', new Error('lazy component failed'))
      if (failure === 'pending') page.emit('response', responseFor(browserEvent(), {
        text: async () => new Promise(() => {})
      }))
      if (failure === 'timeout') {
        page.emit('response', responseFor(browserEvent()))
        await observer.flush()
        await assert.rejects(observer.waitFor(() => true, observer.mark()), /timed out/)
      } else if (failure === 'pending') await assert.rejects(observer.flush(), /remain pending/)
      else await assert.rejects(observer.waitFor(() => true))
    } finally {
      observer.close()
    }
    for (const event of ['response', 'requestfailed', 'pageerror']) assert.equal(page.listenerCount(event), 0)
  }
})

test('PB953 document navigation requires the actual report route and a successful main-frame HTTP response', () => {
  const page = new EventEmitter()
  page.mainFrame = () => 'main'
  const observer = observeProjectReportBrowser(page)
  const route = '/reports/project/project-plan/project-progress'
  assert.throws(() => observer.assertNavigation(route, 0))
  page.emit('response', responseFor({ navigation: true, pathname: '/index', ok: true, status: 200 }))
  assert.throws(() => observer.assertNavigation(route, 0))
  page.emit('response', responseFor({ navigation: true, pathname: route, ok: true, status: 200 }))
  observer.assertNavigation(route, 0)
  page.emit('response', responseFor({ navigation: true, pathname: route, ok: false, status: 404 }))
  assert.throws(() => observer.assertNavigation(route, 0), /HTTP 404/)
  observer.close()
})

const fakeBrowser = ({ failure } = {}) => {
  const page = new EventEmitter()
  const state = { dates: ['', ''], selected: '', path: definition.path, captures: [], clicks: [] }
  const text = (value) => ({ innerText: async () => value })
  const selected = () => text(state.selected)
  const dates = {
    count: async () => 2,
    nth: (index) => ({
      fill: async (value) => { state.dates[index] = value },
      press: async (key) => { state.clicks.push(`date-${index}-${key}`) },
      inputValue: async () => state.dates[index]
    })
  }
  const select = {
    click: async () => state.clicks.push('select'),
    locator: (selector) => {
      if (selector.startsWith('input[role="combobox"]')) return {
        waitFor: async () => {}, getAttribute: async () => 'project-options'
      }
      return selected()
    }
  }
  const root = {
    first: () => root, waitFor: async () => {}, count: async () => 1,
    locator: (selector) => {
      const current = PROJECT_REPORT_BROWSER_DEFINITIONS.find((item) => item.path === state.path)
      const value = reports.get(current.reportType)
      if (selector === '.el-form-item') return {
        filter: ({ has }) => ({ locator: (selector) => {
          if (has.label === '项目') { assert.equal(selector, '.el-select'); return select }
          assert.equal(has.label, '统计日期')
          assert.equal(selector, '.el-date-editor input')
          return dates
        } })
      }
      if (selector === 'h1') return text(current.title)
      if (selector === '.report-body') return { waitFor: async () => {} }
      if (selector === '.report-meta-row') return text(renderedFor(current, value).metaText)
      if (selector === '.report-metric') {
        const metrics = renderedFor(current, value).metrics
        return { count: async () => metrics.length, nth: (index) => ({
          locator: (selector) => text(selector === '.report-metric__label'
            ? metrics[index].label : failure === 'metric' ? '999' : metrics[index].value)
        }) }
      }
      throw new Error(`unexpected root selector ${selector}`)
    },
    getByRole: (role, options) => {
      assert.equal(role, 'button')
      assert.deepEqual(options, { name: '查询', exact: true })
      return { click: async () => {
        state.clicks.push('query')
        const current = PROJECT_REPORT_BROWSER_DEFINITIONS.find((item) => item.path === state.path)
        const value = reports.get(current.reportType)
        const actualQuery = { projectId: project.id, startDate: state.dates[0], endDate: state.dates[1] }
        if (failure === 'query') actualQuery.projectId = '999'
        page.emit('response', responseFor(browserEvent(state.path, value, actualQuery)))
      } }
    }
  }
  const popup = {
    filter: () => popup, waitFor: async () => {},
    locator: () => ({ getByRole: (role, options) => {
      assert.equal(role, 'option')
      assert.deepEqual(options, { name: projectLabel, exact: true })
      return { count: async () => 1, click: async () => { state.selected = projectLabel } }
    } })
  }
  page.mainFrame = () => 'main'
  page.url = () => state.url
  page.waitForFunction = async () => {}
  page.goto = async (url) => {
    state.url = url
    state.path = new URL(url).pathname.split('/').at(-1)
    if (state.path === 'index') return
    state.selected = ''
    state.dates = ['', '']
    if (failure === 'navigation') throw new Error('navigation failed')
    page.emit('response', responseFor({
      navigation: true, pathname: new URL(url).pathname, ok: true, status: 200
    }))
    const options = optionEvent()
    if (failure === 'options') options.payload.data.list = []
    page.emit('response', responseFor(options))
  }
  page.locator = (selector, options) => {
    if (selector.startsWith('.pm-report-page')) return root
    if (selector === 'body') return {
      innerText: async () => failure === 'placeholder'
        ? '模块配置异常，请联系管理员' : '项目报表真实数据',
      evaluate: async (read) => read({ innerText: '项目报表真实数据' })
    }
    if (selector === '.el-form-item__label') return {
      label: options.hasText.test('项目') ? '项目' : '统计日期'
    }
    if (selector.startsWith('.el-popper')) return popup
    if (selector.startsWith('[role="listbox"]')) return {}
    throw new Error(`unexpected page selector ${selector}`)
  }
  observePage(page)
  const baseline = Object.fromEntries(['response', 'requestfailed', 'pageerror'].map(
    (event) => [event, page.listenerCount(event)]))
  return { page, state, baseline }
}

test('PB953 orchestration visits eleven permission routes, queries owned data, then captures verified pages', async () => {
  const { page, state, baseline } = fakeBrowser()
  const evidence = await verifyProjectReportPages({
    page, api: { getBusiness: async (path) => {
      assert.equal(path, '/system/auth/get-permission-info')
      return { code: 0, data: info }
    } }, project, query, reports, timeoutMs: 100,
    capture: async (name) => { state.captures.push(name); return `/unit-only/${name}.png` }
  })
  assert.equal(evidence.length, 11)
  assert.equal(state.clicks.filter((item) => item === 'query').length, 11)
  assert.equal(state.captures.length, 11)
  for (const item of evidence) {
    assert.equal(item.projectId, project.id)
    assert.deepEqual(item.response.appliedFilters, query)
    assert.equal(item.rendered.projectLabel, projectLabel)
    assert.ok(item.screenshot.endsWith(`pb953-project-report-${item.path}.png`))
  }
  for (const [event, count] of Object.entries(baseline)) assert.equal(page.listenerCount(event), count)
})

test('PB953 orchestration fails before capture and releases listeners on navigation/placeholder/options/query/metric failure', async () => {
  for (const failure of ['navigation', 'placeholder', 'options', 'query', 'metric', 'capture']) {
    const { page, state, baseline } = fakeBrowser({ failure })
    await assert.rejects(verifyProjectReportPages({
      page, api: { getBusiness: async () => ({ code: 0, data: info }) },
      project, query, reports, reportPaths: [definition.path], timeoutMs: 50,
      capture: async () => {
        if (failure === 'capture') throw new Error('screenshot failed')
        state.captures.push('unexpected')
      }
    }))
    assert.equal(state.captures.length, 0)
    for (const [event, count] of Object.entries(baseline)) assert.equal(page.listenerCount(event), count)
  }
})

test('PB953 refuses missing permissions, foreign/lossy project IDs and incomplete API reports before acceptance', async () => {
  for (const changes of [
    { project: { ...project, id: '999' } },
    { project: { ...project, id: Number(project.id) } },
    { query: { ...query, startDate: query.endDate, endDate: query.startDate } },
    { reports: new Map() }, { reportPaths: [definition.path, definition.path] },
    { api: { getBusiness: async () => ({ code: 0, data: { ...info, permissions: [] } }) } },
    { api: { getBusiness: async () => ({ code: 403, msg: 'Forbidden' }) } }
  ]) {
    const { page, state } = fakeBrowser()
    await assert.rejects(verifyProjectReportPages({
      page, api: { getBusiness: async () => ({ code: 0, data: info }) },
      project, query, reports, reportPaths: [definition.path], ...changes
    }))
    assert.equal(state.captures.length, 0)
  }
})
