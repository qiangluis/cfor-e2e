import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  cases,
  smokeCatalogBindings,
  smokeCatalogEvidence,
  smokeHttpFact,
  smokeInitializationFact,
  smokeLoginFact,
  smokeMenuExpectation,
  smokeObserveSidebarMenu,
  smokeSidebarPaths
} from '../suites/smoke.mjs'
import { acceptanceIsComplete, caseOutcome } from '../lib/report.mjs'

const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const definitions = catalog.suites.find((suite) => suite.id === 'smoke').cases
const originals = {
  'SMOKE-001': [
    'actuator health=UP', '登录 code=0', 'tenantId=1',
    '初始化未确认进入引导中心，已确认进入工作台'
  ],
  'SMOKE-002': ['顶部工作台可进入', '引导中心存在', '已确认模块菜单可见', '无 4xx/5xx']
}
const names = (caseId) => smokeCatalogBindings[caseId].flatMap((item) => item.evidenceChecks)
const record = (caseId) => ({
  checks: names(caseId).map((name) => ({ name, passed: true, details: `observed: ${name}` })),
  notes: [], evidence: []
})
const outcome = (result) => {
  const failedChecks = result.checks.filter((check) => check.passed === false)
  const complete = acceptanceIsComplete({
    failedChecks, remainingAssertions: result.remainingAssertions,
    candidates: [result.passCandidate, result.acceptanceComplete],
    incomplete: result.passCandidate === false
  })
  return caseOutcome({
    failedChecks, hasAssertions: result.checks.length > 0,
    partial: !complete, result: { acceptanceComplete: complete }
  }).status
}

test('SMOKE keeps all eight original catalog assertions and exact zero-based bindings', () => {
  assert.deepEqual(cases, ['SMOKE-001', 'SMOKE-002'])
  for (const definition of definitions) {
    assert.deepEqual(definition.assertions, originals[definition.id])
    assert.deepEqual(smokeCatalogBindings[definition.id].map(({ index, assertion }) => ({
      index, assertion
    })), definition.assertions.map((assertion, index) => ({ index, assertion })))
    assert.equal(new Set(names(definition.id)).size, names(definition.id).length)
  }
})

for (const caseId of cases) {
  test(`${caseId}: all required uniquely named boolean checks verify the exact assertions`, () => {
    const result = smokeCatalogEvidence(caseId, record(caseId))
    assert.deepEqual(result.catalogAssertions.map((item) => item.assertion), originals[caseId])
    assert.deepEqual(result.catalogAssertions.map((item) => item.index), [0, 1, 2, 3])
    assert.ok(result.catalogAssertions.every((item) =>
      item.status === 'VERIFIED' && item.evidenceChecks.length > 0))
    assert.deepEqual(result.remainingAssertions, [])
    assert.equal(result.passCandidate, true)
    assert.equal(outcome(result), 'PASS')
    assert.equal(Object.hasOwn(result, 'runtimeErrors'), false)
    assert.equal(Object.hasOwn(result, 'status'), false)
  })

  test(`${caseId}: every missing, failed, duplicate or non-boolean required check blocks PASS`, () => {
    for (const required of names(caseId)) {
      for (const mutation of ['missing', 'failed', 'duplicate', 'truthy', 'undefined', 'null']) {
        const result = record(caseId)
        const check = result.checks.find((item) => item.name === required)
        if (mutation === 'missing') result.checks = result.checks.filter((item) => item !== check)
        if (mutation === 'failed') check.passed = false
        if (mutation === 'duplicate') result.checks.push({ ...check })
        if (mutation === 'truthy') check.passed = 'true'
        if (mutation === 'undefined') delete check.passed
        if (mutation === 'null') check.passed = null
        smokeCatalogEvidence(caseId, result)
        const assertion = result.catalogAssertions.find((item) => item.evidenceChecks.includes(required))
        assert.equal(assertion.status, 'GAP', `${required}: ${mutation}`)
        assert.ok(result.remainingAssertions.includes(assertion.assertion))
        assert.equal(result.passCandidate, false, `${required}: ${mutation}`)
        assert.equal(result.acceptanceComplete, false)
        assert.notEqual(outcome(result), 'PASS', `${required}: ${mutation}`)
        if (mutation === 'missing') assert.ok(assertion.missingChecks.includes(required))
      }
    }
  })

  test(`${caseId}: titles, similarly named checks, HTTP 200 and empty evidence cannot verify acceptance`, () => {
    for (const checks of [
      [], [{ name: 'HTTP 200', passed: true }],
      originals[caseId].map((name) => ({ name, passed: true })),
      names(caseId).map((name) => ({ name: `${name}（只读）`, passed: true }))
    ]) {
      const result = smokeCatalogEvidence(caseId, { checks })
      assert.ok(result.catalogAssertions.every((item) => item.status === 'GAP'))
      assert.equal(result.passCandidate, false)
      assert.notEqual(outcome(result), 'PASS')
    }
  })

  test(`${caseId}: index/text drift, duplicate mappings and weakened check bindings fail closed`, () => {
    const variations = [
      (rows) => { rows[0].index = 99 },
      (rows) => { rows[0].index = '0' },
      (rows) => { rows[0].assertion += ' ' },
      (rows) => { rows.push(structuredClone(rows[0])) },
      (rows) => { rows.push({ ...rows[0], assertion: 'different text' }) },
      (rows) => { rows.push({ ...rows[0], index: 99 }) },
      (rows) => { rows[0].evidenceChecks = [] },
      (rows) => { rows[0].evidenceChecks = [''] },
      (rows) => { rows[0].evidenceChecks = Array(rows[0].evidenceChecks.length) },
      (rows) => { rows[0].evidenceChecks.push(rows[0].evidenceChecks[0]) },
      (rows) => { rows[1].evidenceChecks = [...rows[0].evidenceChecks] },
      (rows) => { rows[1].evidenceChecks.pop() }
    ]
    for (const mutate of variations) {
      const bindings = structuredClone(smokeCatalogBindings)
      mutate(bindings[caseId])
      const result = smokeCatalogEvidence(caseId, record(caseId), bindings)
      assert.ok(result.catalogAssertions.some((item) => item.status === 'GAP'))
      assert.equal(result.passCandidate, false)
      assert.notEqual(outcome(result), 'PASS')
    }
    const result = smokeCatalogEvidence(caseId, record(caseId), {})
    assert.ok(result.catalogAssertions.every((item) => item.status === 'GAP'))
  })

  test(`${caseId}: unknown extra mappings and malformed/sparse check collections cannot yield PASS`, () => {
    const bindings = structuredClone(smokeCatalogBindings)
    bindings[caseId].push({ index: 99, assertion: 'unrelated', evidenceChecks: ['unrelated'] })
    const extra = record(caseId)
    extra.checks.push({ name: 'unrelated', passed: true })
    smokeCatalogEvidence(caseId, extra, bindings)
    assert.equal(extra.passCandidate, false)
    assert.notEqual(outcome(extra), 'PASS')
    for (const checks of [undefined, null, {}, Array(names(caseId).length)]) {
      const result = smokeCatalogEvidence(caseId, { checks })
      assert.equal(result.passCandidate, false)
      assert.ok(result.catalogAssertions.every((item) => item.status === 'GAP'))
    }
    const sparse = record(caseId)
    sparse.checks.length++
    smokeCatalogEvidence(caseId, sparse)
    assert.equal(sparse.passCandidate, false)
  })

  test(`${caseId}: an unrelated failed/non-boolean or repeated check cannot yield PASS`, () => {
    for (const passed of [false, 'true', undefined]) {
      const result = record(caseId)
      result.checks.push({ name: 'retained existing regression', passed })
      smokeCatalogEvidence(caseId, result)
      assert.equal(result.passCandidate, false)
      assert.notEqual(outcome(result), 'PASS')
    }
    const result = record(caseId)
    result.checks.push(
      { name: 'retained existing regression', passed: true },
      { name: 'retained existing regression', passed: true }
    )
    smokeCatalogEvidence(caseId, result)
    assert.equal(result.passCandidate, false)
    assert.notEqual(outcome(result), 'PASS')
  })
}

test('SMOKE-001 requires both actual initialization login branches; either single actor remains PARTIAL', () => {
  for (const missing of ['未确认初始化真实登录进入引导中心', '已确认初始化真实登录进入普通工作台']) {
    const result = record('SMOKE-001')
    result.checks = result.checks.filter((check) => check.name !== missing)
    smokeCatalogEvidence('SMOKE-001', result)
    assert.deepEqual(result.catalogAssertions.map((item) => item.status),
      ['VERIFIED', 'VERIFIED', 'VERIFIED', 'GAP'])
    assert.deepEqual(result.remainingAssertions, [originals['SMOKE-001'][3]])
    assert.equal(outcome(result), 'PARTIAL')
  }
})

test('SMOKE-002 menu permission alone cannot replace visible menu observations', () => {
  const result = record('SMOKE-002')
  result.checks = result.checks.filter((check) =>
    check.name !== '已确认模块顶部导航与各模块设置菜单逐项可见')
  smokeCatalogEvidence('SMOKE-002', result)
  assert.equal(result.catalogAssertions[2].status, 'GAP')
  assert.equal(outcome(result), 'PARTIAL')
})

const permission = (onboardingRequired = false) => ({ code: 0, data: { onboardingRequired } })
const state = (data = {}) => ({
  code: 0,
  data: { currentStep: 2, industryTemplate: 'trade', selectedModules: ['erp'], ...data }
})

test('initialization confirmation reads currentStep and industry template rather than completion/title', () => {
  assert.deepEqual(smokeInitializationFact(state(), permission()),
    { known: true, confirmed: true, consistent: true })
  for (const data of [
    { currentStep: 1 }, { industryTemplate: '' }, { industryTemplate: null }
  ]) {
    assert.deepEqual(smokeInitializationFact(state(data), permission(true)),
      { known: true, confirmed: false, consistent: true })
  }
  assert.equal(smokeInitializationFact(
    state({ currentStep: 1, status: 'COMPLETED' }), permission(true)
  ).confirmed, false)
})

test('missing, malformed, rejected or contradictory initialization facts do not verify either branch', () => {
  for (const [payload, auth] of [
    [null, permission()], [{ code: 0, data: {} }, permission()],
    [state({ currentStep: '2' }), permission()], [{ ...state(), code: 500 }, permission()],
    [state(), { code: 0, data: {} }], [state(), permission(true)],
    [state({ currentStep: 1 }), permission()], [state(), { ...permission(), code: 403 }]
  ]) assert.equal(smokeInitializationFact(payload, auth).consistent, false)
})

const loginInput = () => ({
  logins: [{ status: 200, code: 0, tenantId: 1, tokenMatches: true }],
  token: 'unit-only-token', loginTenantId: '1',
  storage: { tenantId: '{"v":1,"e":4102444800000}', visitTenantId: null },
  permissionRequests: [{ tenantId: '1', tokenMatches: true }]
})

test('login evidence uses actual code, matching token, tenant response/cache/request without leaking tokens', () => {
  const input = loginInput()
  const result = smokeLoginFact(input)
  assert.equal(result.codeZero, true)
  assert.equal(result.tenantOne, true)
  assert.ok(!JSON.stringify(result).includes(input.token))
})

test('HTTP 200, reused session, duplicate responses, truthy code and different tokens cannot prove login code=0', () => {
  for (const change of [
    (input) => { input.logins = [] },
    (input) => { input.logins.push({ ...input.logins[0] }) },
    (input) => { delete input.logins[0].code },
    (input) => { input.logins[0].code = '0' },
    (input) => { input.logins[0].code = 401 },
    (input) => { input.logins[0].tokenMatches = false },
    (input) => { input.logins[0].status = 500 },
    (input) => { input.token = '' }
  ]) {
    const input = loginInput()
    change(input)
    assert.equal(smokeLoginFact(input).codeZero, false)
  }
})

test('configured tenant cannot mask missing or conflicting browser tenant observations', () => {
  for (const change of [
    (input) => { input.loginTenantId = '' },
    (input) => { input.logins[0].tenantId = 2 },
    (input) => { delete input.logins[0].tenantId },
    (input) => { input.storage.tenantId = null },
    (input) => { input.storage.tenantId = '{"v":2}' },
    (input) => { input.storage.visitTenantId = '{"v":2}' },
    (input) => { input.storage.visitTenantId = '{"invalid":true}' },
    (input) => { input.logins[0].tokenMatches = false },
    (input) => { input.permissionRequests = [] },
    (input) => { input.permissionRequests[0].tenantId = '2' },
    (input) => { input.permissionRequests[0].visitTenantId = '2' },
    (input) => { input.permissionRequests[0].tokenMatches = false },
    (input) => { input.permissionRequests.push({ tenantId: '2', tokenMatches: true }) }
  ]) {
    const input = loginInput()
    change(input)
    assert.equal(smokeLoginFact(input).tenantOne, false)
  }
})

const menuPermission = () => ({
  code: 0,
  data: {
    onboardingRequired: false,
    menus: [
      { path: '/settings', name: '设置', visible: true, children: [
        { path: 'erp', name: 'ERP 设置', visible: true }
      ] },
      { path: '/erp', name: 'ERP', visible: true }
    ],
    navigationGroups: [
      { key: 'settings', title: '设置', sources: ['/settings'] },
      { key: 'sales', title: '销售', sources: ['/erp'] },
      { key: 'supply-chain', title: '供应链', sources: ['/erp'] },
      { key: 'finance', title: '财务', sources: ['/erp'] }
    ]
  }
})

test('confirmed module expectation resolves real nested route paths and each required business group', () => {
  const result = smokeMenuExpectation(state(), menuPermission())
  assert.equal(result.complete, true)
  assert.deepEqual(result.gaps, [])
  assert.deepEqual(result.settings, [{
    module: 'erp', pathname: '/settings/erp', name: 'ERP 设置', ancestors: ['/settings'],
    component: undefined, displayPaths: ['/settings/erp']
  }])
  assert.deepEqual(result.navigation.map((item) => item.key),
    ['settings', 'sales', 'supply-chain', 'finance'])
})

test('reorganized sidebar maps display groups and formal component aliases without inventing sources', () => {
  const routes = [
    { pathname: '/settings/business-settings', name: '业务设置', ancestors: ['/settings'] },
    { pathname: '/settings/iot', name: '设备与 IoT',
      ancestors: ['/settings', '/settings/business-settings'] },
    { pathname: '/settings/iot/device', name: '设备档案', component: 'iot/device/device/index',
      ancestors: ['/settings', '/settings/business-settings', '/settings/iot'] },
    { pathname: '/settings/plugin-settings/platform', name: '集成平台',
      component: 'integration/platform/index', ancestors: ['/settings', '/settings/plugin-settings'] },
    { pathname: '/integration', name: '集成设置', ancestors: ['/settings'] },
    { pathname: '/integration/platform', name: '集成平台',
      component: 'integration/platform/index.vue', ancestors: ['/settings', '/integration'] }
  ]
  const group = { sidebarTree: [
    { title: '业务设置', children: [{ source: '/settings/iot', children: null }] },
    { title: '插件中心', children: [{ source: '/integration', children: null }] }
  ] }
  assert.deepEqual(smokeSidebarPaths(routes[0], routes, group), ['/__top-menu__/0'])
  assert.deepEqual(smokeSidebarPaths(routes[2], routes, group), ['/settings/iot/device'])
  assert.deepEqual(smokeSidebarPaths(routes[3], routes, group), ['/integration/platform'])
  assert.deepEqual(smokeSidebarPaths({
    ...routes[3], component: 'unrelated/component'
  }, routes, group), [])
  assert.deepEqual(smokeSidebarPaths(routes[3], routes, {
    sidebarTree: [{ title: '插件中心', children: [{ source: '/missing', children: null }] }]
  }), [])
})

test('sidebar observation expands actual rendered ancestors in order and uses a unique path span', async () => {
  const calls = []
  const opened = new Set()
  const item = {
    count: async () => 1,
    evaluate: async (fn) => {
      assert.match(fn.toString(), /closest\('\.el-sub-menu'\)/)
      return ['/__top-menu__/1', '/settings/iot']
    },
    scrollIntoViewIfNeeded: async () => calls.push('scroll'),
    getAttribute: async () => '/settings/iot/device',
    isVisible: async () => opened.size === 2
  }
  const sidebar = {
    locator(selector) {
      if (selector.startsWith('span.v-menu__title')) {
        assert.equal(selector, 'span.v-menu__title[data-menu-path="/settings/iot/device"]')
        return item
      }
      const pathname = selector.match(/data-submenu-index="([^"]+)"/)[1]
      return {
        count: async () => 1,
        getAttribute: async () => opened.has(pathname) ? 'el-sub-menu is-opened' : 'el-sub-menu',
        locator: () => ({
          waitFor: async () => calls.push(`visible:${pathname}`),
          click: async () => { opened.add(pathname); calls.push(`click:${pathname}`) }
        })
      }
    }
  }
  const result = await smokeObserveSidebarMenu(sidebar, {
    module: 'iot', pathname: '/settings/iot/device',
    displayPaths: ['/settings/iot/device']
  })
  assert.equal(result.visible, true)
  assert.deepEqual(calls, ['visible:/__top-menu__/1', 'click:/__top-menu__/1',
    'visible:/settings/iot', 'click:/settings/iot', 'scroll'])
})

test('ambiguous sidebar targets fail visibility evidence without clicking hidden or unrelated nodes', async () => {
  const result = await smokeObserveSidebarMenu({
    locator: () => ({ count: async () => 2 })
  }, { pathname: '/settings/iot/device', displayPaths: ['/settings/iot/device'] })
  assert.equal(result.visible, false)
})

test('empty, unconfirmed, unknown or duplicate module facts and unrelated/hidden menus retain a gap', () => {
  for (const data of [
    { currentStep: 1 }, { selectedModules: [] }, { selectedModules: null },
    { selectedModules: ['erp', 'erp'] }, { selectedModules: ['unknown'] },
    { selectedModules: ['mes'] }, { selectedModules: ['iot'] },
    { selectedModules: ['integration'] }, { selectedModules: ['after-sales'] }
  ]) assert.equal(smokeMenuExpectation(state(data), menuPermission()).complete, false)
  for (const mutate of [
    (auth) => { auth.code = 403 },
    (auth) => { auth.data.menus = [] },
    (auth) => { auth.data.menus[0].visible = false },
    (auth) => { auth.data.menus[0].children[0].visible = false },
    (auth) => { auth.data.menus[0].children[0].path = 'unrelated' },
    (auth) => { auth.data.menus[0].children.push({ ...auth.data.menus[0].children[0] }) },
    (auth) => { auth.data.navigationGroups = [] },
    (auth) => { auth.data.navigationGroups.pop() },
    (auth) => { auth.data.navigationGroups[0].sources = ['/unrelated'] },
    (auth) => { auth.data.navigationGroups.push({ ...auth.data.navigationGroups[0] }) }
  ]) {
    const auth = menuPermission()
    mutate(auth)
    assert.equal(smokeMenuExpectation(state(), auth).complete, false)
  }
})

test('current system, IoT and integration menus require their real business pages within Settings', () => {
  const auth = menuPermission()
  auth.data.menus[0].children.push(
    { path: 'business-settings', name: '业务设置', visible: true },
    { path: '/settings/iot', name: '设备与 IoT', visible: true, children: [
      { path: 'device', name: '设备档案', visible: true, component: 'iot/device/device/index' }
    ] },
    { path: 'plugin-settings', name: '插件中心', visible: true, children: [
      { path: 'platform', name: '集成平台', visible: true, component: 'integration/platform/index' }
    ] }
  )
  const actualState = state({ selectedModules: ['system', 'iot', 'integration'] })
  const result = smokeMenuExpectation(actualState, auth)
  assert.equal(result.complete, true)
  assert.deepEqual(result.settings.map((row) => row.pathname), [
    '/settings/business-settings', '/settings/iot', '/settings/iot/device',
    '/settings/plugin-settings', '/settings/plugin-settings/platform'
  ])
  for (const mutate of [
    (auth) => { auth.data.menus[0].children[2].children = [] },
    (auth) => { auth.data.menus[0].children[2].children[0].visible = false },
    (auth) => { auth.data.menus[0].children[2].children[0].component = 'unrelated/index' },
    (auth) => { auth.data.menus[0].children[3].children = [] },
    (auth) => { auth.data.menus[0].children[3].children[0].path = 'instance' },
    (auth) => { auth.data.menus[0].children[3].children.push({ ...auth.data.menus[0].children[3].children[0] }) }
  ]) {
    const variant = structuredClone(auth)
    mutate(variant)
    assert.equal(smokeMenuExpectation(actualState, variant).complete, false)
  }
})

test('4xx/5xx assertion needs nonempty observed browser, Node and health statuses', () => {
  const browser = [{ pathname: '/index', status: 200 }, { pathname: '/assets/app.js', status: 304 }]
  const node = [{ pathname: '/system/auth/get-permission-info', status: 200 }]
  assert.equal(smokeHttpFact(browser, node, 200).passed, true)
  for (const [b, n, health] of [
    [[], node, 200], [browser, [], 200], [browser, node, undefined],
    [browser, node, 503], [[...browser, { pathname: '/image.png', status: 404 }], node, 200],
    [browser, [...node, { pathname: '/api', status: 500 }], 200],
    [browser, [{ status: null, networkError: true }], 200],
    [[{ status: '200' }], node, 200]
  ]) assert.equal(smokeHttpFact(b, n, health).passed, false)
})

test('real suite retains existing regressions and wires concrete observations with final runtime owned by runner', () => {
  const source = fs.readFileSync(new URL('../suites/smoke.mjs', import.meta.url), 'utf8')
  for (const name of [
    '后端健康检查', '真实登录成功', '当前租户具有真实菜单权限',
    '普通工作台不提前加载未访问的六个业务域首页',
    '旧租户管理入口归并到统一工作台，不渲染第二套首页', '快捷栏同一入口不重复展示',
    '首次打开设置抽屉，异步布局、颜色与界面控件可用',
    'AI 助手首次打开，人物 canvas 非空、视频播放推进且输入框可用'
  ]) assert.ok(source.includes(`name: '${name}'`), name)
  assert.match(source, /getImageData\(0, 0, canvas\.width, canvas\.height\)/)
  assert.match(source, /visiblePixels > 100/)
  assert.match(source, /Math\.abs\(video\.currentTime - startedAt\) > 0\.125/)
  assert.match(source, /await workbenchEntry\.click\(\)/)
  assert.match(source, /login\(page, \{ returnContext: true \}\)/)
  assert.match(source, /decryptResponse\(text\)/)
  assert.match(source, /api\.get\('\/system\/system-init\/state'\)/)
  assert.match(source, /page\.on\('response', observeResponse\)/)
  assert.match(source, /page\.off\('response', observeResponse\)/)
  assert.match(source, /record\.api\.slice\(apiStart\)/)
  assert.doesNotMatch(source, /runtimeErrors\s*=|allowRuntimeErrors|status:\s*'PASS'/)
  assert.doesNotMatch(source, /permissionRequests\.filter|page\.route\(|runReadOnlySql|api\.(post|put|delete)\(/)
})
