import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  OWNED_CASE_PERMISSIONS,
  SECTION_SELECTORS,
  assertFixtureActor,
  captureOwnedWorkbenchReports,
  createDrafts,
  createOwnedAccount,
  createOwnedRegistry,
  createPortal,
  collectOwnedNavigationQueryPermissions,
  draftPayloads,
  draftReminderMismatches,
  expectPermissionDenied,
  expectedReminders,
  newOwnedBrowser,
  matchesWorkbenchReminders,
  normalizeOwnedPermissions,
  recordReadOnlyCoverage,
  restoreOwnedPreference,
  runOwnedWorkbenchCase,
  saveOwnedPreference,
  selectOwnedMenuIds,
  validatePurchaseSequence,
  verifyDatedReportIsolation,
  verifyReportIsolation,
  verifyPreferences,
  verifyPurchase
} from '../workbenchhelper/owned.mjs'
import {
  OWNED_CATALOG_ASSERTIONS,
  WORKBENCH_FIXTURE_DEPENDENCIES,
  ownedCaseConclusion,
  recordCatalogAssertion
} from '../workbenchhelper/contracts.mjs'
import { caseOutcome } from '../lib/report.mjs'

// Any missed mock must fail before an outbound request, even while local.env exists.
const originalFetch = globalThis.fetch
test.before(() => {
  globalThis.fetch = async () => assert.fail('Network is forbidden in workbench unit tests')
})
test.after(() => { globalThis.fetch = originalFetch })

test('owned report capture listens before a cold navigation with the full browser budget and preserves scope validation', async () => {
  for (const scope of ['self', 'team']) {
    const pending = []
    const responses = ['DAILY', 'WEEKLY', 'MONTHLY'].map((type) => {
      const ownerKey = type === 'DAILY' ? 'reporterId' : 'ownerUserId'
      const url = new URL(`http://127.0.0.1:9151/admin-api/${type === 'DAILY' ? 'pm/daily' : 'crm/work'}-report/page`)
      url.search = new URLSearchParams({
        pageNo: '1', pageSize: '100', reportType: type,
        ...(scope === 'self' ? { [ownerKey]: '101' } : {})
      }).toString()
      return {
        url: () => url.toString(), ok: () => true,
        request: () => ({ method: () => 'GET' }), headers: () => ({}),
        text: async () => JSON.stringify({
          code: 0, data: { total: 1, list: [{ reportType: type, [ownerKey]: '101' }] }
        })
      }
    })
    const page = {
      waitForResponse (predicate, options) {
        assert.equal(options.timeout, 60000)
        return new Promise((resolve) => pending.push({ predicate, resolve }))
      }
    }
    const captured = await captureOwnedWorkbenchReports(page, async () => {
      assert.equal(pending.length, 3, 'All listeners must precede navigation')
      for (const response of responses) {
        const listeners = pending.filter(({ predicate }) => predicate(response))
        assert.equal(listeners.length, 1)
        listeners[0].resolve(response)
      }
    }, '101', scope)
    assert.deepEqual(captured.missing, [])
    assert.deepEqual(Object.values(captured.pages).map((row) => row.total), [1, 1, 1])
    responses[0].text = async () => JSON.stringify({
      code: 0, data: { total: 1, list: [{ reportType: 'DAILY', reporterId: '102' }] }
    })
    if (scope === 'self') {
      pending.length = 0
      await assert.rejects(captureOwnedWorkbenchReports(page, async () => {
        for (const response of responses) pending.find(({ predicate }) => predicate(response)).resolve(response)
      }, '101', scope), /非当前用户报告/)
    }
  }
})

test('owned report capture retains a missing real GET as an explicit gap', async () => {
  const page = { waitForResponse: async () => { throw new Error('unit-only missing GET') } }
  const captured = await captureOwnedWorkbenchReports(page, async () => {}, '101')
  assert.equal(captured.missing.length, 3)
  assert.deepEqual(captured.pages, {})
})

test('report isolation requires exact forbidden responses and empty cross-user pages', async () => {
  const run = (observerApi) => verifyReportIsolation({
    observerApi, ownerId: '2110538109578686466', fixture: { projectId: '101' },
    report: { draftId: '102' }, crmReportIds: ['103', '104'], caseRecord: newRecord()
  })
  const observerApi = {
    async get (pathname) {
      if (pathname.includes('/get?') || pathname.includes('projectId=')) return { code: 403 }
      return { code: 0, data: { list: [], total: 0 } }
    }
  }
  await run(observerApi)
  await assert.rejects(run({
    get: async () => ({ code: 0, data: { list: [], total: 0 } })
  }), /非项目成员读取了专属日报/)
  await assert.rejects(run({
    async get (pathname) {
      if (pathname.includes('/get?') || pathname.includes('projectId=')) return { code: 403 }
      return { code: 0, data: { list: [{ id: '102' }], total: 1 } }
    }
  }), /跨用户报告筛选返回了其他用户的报告/)
  await assert.rejects(run({
    get: async () => ({ code: 500, msg: 'unavailable' })
  }), /非项目成员读取了专属日报/)
})

test('report membership date probes preserve returned IDs and end only the owned role', async () => {
  const record = newRecord()
  const registry = createOwnedRegistry('E2E-WBF-004-DATE', record)
  let role
  const calls = []
  const adminApi = {
    async putBusiness (pathname, body) {
      calls.push({ pathname, body })
      if (pathname === '/pm/project-role/assign') {
        if (role) assert.equal(body.id, role.id)
        role = { ...body, id: '2110546138818723841', status: 'ACTIVE' }
        return success(role.id)
      }
      assert.equal(pathname, `/pm/project-role/end?id=${role.id}`)
      role.status = 'ENDED'
      return success(true)
    },
    async getBusiness (pathname) {
      assert.equal(pathname, '/pm/project-role/list?projectId=101')
      return success([role])
    }
  }
  const observerApi = {
    async get (pathname) {
      if (pathname.includes('/get?') || pathname.includes('projectId=')) return { code: 403 }
      return success({ list: [], total: 0 })
    }
  }
  await verifyDatedReportIsolation({
    adminApi, observerApi, observer: { userId: '103' }, registry, ownerId: '102',
    fixture: { projectId: '101', handoverId: '100' }, report: { draftId: '104' },
    crmReportIds: ['105'], today: '2026-10-15', caseRecord: record
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.roleCode, 'REPORT_READ_BOUNDARY')
  assert.equal(calls[0].body.effectiveStart, '2026-10-16')
  assert.equal(calls[1].body.effectiveEnd, '2026-10-14')
  assert.equal(record.checks.filter((row) => row.name.includes('项目角色不能读取')).length, 2)
  await registry.cleanup()
  assert.equal(role.status, 'ENDED')
  assert.equal(record.fixtureCleanup.remaining.length, 0)
})

const marker = 'E2E-WBF-009-ABC123'
const settings = {
  target: 'local', webBase: 'http://127.0.0.1:9151',
  apiBase: 'http://127.0.0.1:48083', tenantId: '1', tenantName: 'CFOR 标准平台'
}
const success = (data) => ({ code: 0, data })
const newRecord = () => ({ checks: [], notes: [], evidence: [] })
const outcome = (result, caseRecord) => caseOutcome({
  result, hasAssertions: caseRecord.checks.length > 0,
  failedChecks: caseRecord.checks.filter((row) => row.passed === false)
}).status

function menusFor (permissions = [], navigationQuery) {
  const parentId = navigationQuery ? 2 : 0
  return [
    { id: 1, parentId: 0, status: 0, permission: '', component: 'Home/SystemIndex', path: '/index' },
    ...(navigationQuery ? [{ id: 2, parentId: 0, status: 0, permission: navigationQuery, type: 2 }] : []),
    ...permissions.map((permission, index) => ({
      id: index + 2 + (navigationQuery ? 1 : 0), parentId, status: 0, permission
    }))
  ]
}

function ownedMock ({
  caseId = 'WBF-009',
  hiddenSection,
  extraPermission,
  navigationQuery,
  packageMenuIds,
  failPost,
  failDelete
} = {}) {
  const events = []
  const caseRecord = newRecord()
  const permissions = OWNED_CASE_PERMISSIONS[caseId]
  const state = {
    roles: new Map(), users: new Map(), reports: new Map(),
    portal: null, preferences: new Map(), menuRows: menusFor(permissions, navigationQuery),
    nextId: 101, healthy: true, loginTenant: '1'
  }
  state.packageMenuIds = packageMenuIds || state.menuRows.map((row) => row.id)
  const adminApi = {
    async get (pathname) {
      events.push(`GET:${pathname}`)
      if (pathname.startsWith('/system/tenant/get-id-by-name')) return success('1')
      if (pathname === '/system/tenant/get?id=1') {
        return success({ id: '1', packageId: '111', status: 0 })
      }
      if (pathname === '/system/tenant-package/get?id=111') {
        return success({ id: '111', status: 0, menuIds: state.packageMenuIds })
      }
      if (pathname === '/system/auth/get-permission-info') return success({
        user: { id: 1 }, permissions: ['*:*:*'], roles: ['super_admin']
      })
      if (pathname === '/system/menu/list') return success(state.menuRows)
      if (pathname === '/system/menu/list-all-simple') return success(state.menuRows)
      if (pathname.startsWith('/system/role/get?id=')) return success(state.roles.get(pathname.split('=')[1]) || null)
      if (pathname.startsWith('/system/user/get?id=')) return success(state.users.get(pathname.split('=')[1]) || null)
      if (pathname.startsWith('/system/permission/list-role-menus?')) return success(state.assigned || [])
      if (pathname.startsWith('/system/portal/get?id=')) return success(state.portal)
      if (pathname.startsWith('/system/user-preference/get?')) return success('["riskCount"]')
      assert.fail(`Unmocked admin GET ${pathname}`)
    },
    async post (pathname, body) {
      events.push(`POST:${pathname}`)
      if (pathname === failPost) return { code: 500, msg: 'unit-only HTTP-200 business failure' }
      const id = String(state.nextId++)
      if (pathname === '/system/role/create') {
        state.roles.set(id, { ...body, id, type: 2, dataScope: 5 })
        return success(id)
      }
      if (pathname === '/system/permission/assign-role-menu') {
        assert.ok(state.roles.has(body.roleId), 'Only the returned owned role may be assigned')
        state.assigned = body.menuIds
        return success(true)
      }
      if (pathname === '/system/user/create') {
        assert.equal(body.roleIds.length, 1)
        assert.ok(state.roles.has(body.roleIds[0]))
        const { password, ...publicUser } = body
        assert.ok(password.length <= 16)
        state.users.set(id, { ...publicUser, id, status: 0 })
        return success(id)
      }
      if (pathname === '/system/portal/create') {
        assert.ok(state.roles.has(body.roleIds[0]))
        state.portal = { ...body, id }
        return success(id)
      }
      assert.fail(`Unmocked admin POST ${pathname}`)
    },
    async put (pathname, body) {
      events.push(`PUT:${pathname}`)
      assert.equal(pathname, '/system/user/update-status')
      const user = state.users.get(body.id)
      assert.ok(user)
      user.status = body.status
      return success(true)
    },
    async delete (pathname) {
      events.push(`DELETE:${pathname}`)
      if (pathname.startsWith(failDelete || 'UNMATCHABLE')) return { code: 500 }
      const id = pathname.split('=')[1]
      if (pathname.startsWith('/system/role/delete')) state.roles.delete(id)
      else if (pathname.startsWith('/system/user/delete')) state.users.delete(id)
      else if (pathname.startsWith('/system/portal/delete')) state.portal = null
      else assert.fail(`Unmocked admin DELETE ${pathname}`)
      return success(true)
    }
  }
  const ownApi = {
    async get (pathname) {
      events.push(`OWN-GET:${pathname}`)
      const user = [...state.users.values()][0]
      if (pathname === '/system/auth/get-permission-info') return success({
        user: { id: user.id }, roles: [state.roles.get(user.roleIds[0]).code],
        permissions: [...permissions, ...(navigationQuery ? [navigationQuery] : []), ...(extraPermission ? [extraPermission] : [])],
        landingPath: '/index',
        portalCode: state.portal?.code,
        portalSections: state.portal?.sections
      })
      if (pathname.startsWith('/system/user-preference/get?')) {
        return success(state.preferences.get(new URLSearchParams(pathname.split('?')[1]).get('key')) ?? null)
      }
      if (pathname.startsWith('/crm/work-report/get?id=')) return success(state.reports.get(pathname.split('=')[1]) || null)
      if (pathname.startsWith('/crm/work-report/page?')) return { code: 403, msg: 'denied' }
      assert.fail(`Unmocked owned GET ${pathname}`)
    },
    async post (pathname, body) {
      events.push(`OWN-POST:${pathname}`)
      assert.equal(pathname, '/crm/work-report/create')
      assert.equal(body.ownerUserId, undefined, 'Do not create reports owned by another user')
      assert.equal(body.projectId, undefined, 'Do not fabricate a project')
      const id = String(state.nextId++)
      state.reports.set(id, {
        ...body, id, status: 'DRAFT', ownerUserId: [...state.users.keys()][0],
        reportNo: `CRM-WR-${id}`, periodLabel: `${body.periodStart} ~ ${body.periodEnd}`
      })
      return success(id)
    },
    async put (pathname, body) {
      events.push(`OWN-PUT:${pathname}`)
      assert.ok(pathname.startsWith('/system/user-preference/save?'))
      state.preferences.set(new URLSearchParams(pathname.split('?')[1]).get('key'), body.value)
      return success(true)
    },
    async delete (pathname) {
      events.push(`OWN-DELETE:${pathname}`)
      assert.ok(pathname.startsWith('/crm/work-report/delete?id='))
      if (failDelete === 'report') return { code: 500 }
      const id = pathname.split('=')[1]
      assert.ok(state.reports.has(id))
      state.reports.delete(id)
      return success(true)
    }
  }
  const page = {
    url: () => 'http://127.0.0.1:9151/index',
    locator: (selector) => ({
      first () { return this },
      isVisible: async () => {
        const key = Object.keys(SECTION_SELECTORS).find((key) => SECTION_SELECTORS[key] === selector)
        return key !== hiddenSection && (!state.portal || state.portal.sections.includes(key))
      }
    }),
    evaluate: async () => '2026-10-07'
  }
  const handle = {
    page,
    context: {
      tracing: {
        start: async () => events.push('trace-start'),
        stop: async () => events.push('trace-stop')
      },
      close: async () => events.push('context-close')
    },
    browser: { close: async () => events.push('browser-close') },
    flushResponses: async () => events.push('responses-flushed')
  }
  const tools = {
    env: { CFOR_E2E_WRITE_FIXTURES: 'true' },
    checkHealth: async () => {
      events.push('mock-health')
      return { response: { ok: state.healthy }, body: { status: state.healthy ? 'UP' : 'DOWN' } }
    },
    assertLocalWriteSafety: async () => events.push('mock-db-safety'),
    launchBrowser: async ({ headed }) => {
      assert.equal(headed, true)
      events.push('mock-headed-launch')
      return handle
    },
    login: async (_page, options) => {
      assert.ok(options.credentials)
      assert.equal(options.returnContext, true)
      events.push('mock-login')
      return { token: 'unit-only-owned-token', tenantId: state.loginTenant }
    },
    createApiClient: () => ownApi,
    openRoute: async (_page, route) => {
      assert.equal(route, '/index')
      events.push('mock-navigate')
    },
    saveScreenshot: async () => events.push('mock-screenshot'),
    runReadOnlySql: async () => assert.fail('SQL must be mocked per fixture path'),
    runReadOnlyCase: async ({ caseId, caseRecord }, dependencies) => {
      assert.deepEqual(dependencies.env, {})
      assert.equal(dependencies.createApiClient(), ownApi)
      if (caseId === 'WBF-004') {
        for (const label of ['日报', '周报', '月报']) caseRecord.checks.push({
          name: `${label}实际切换并匹配当前用户真实响应（PB-359~365）`, passed: true
        })
        caseRecord.checks.push({ name: '工作报告区块保持在统一门户内', passed: true })
      } else if (caseId === 'WBF-012') {
        for (const period of ['month', 'quarter', 'year']) caseRecord.checks.push({
          name: `${period}/self真实范围请求与统计数值一致（PB-364）`, passed: true
        })
        caseRecord.checks.push({ name: '关闭统计后仍停留在工作台', passed: true })
      }
      return { partial: true, note: 'unit-only original read assertions' }
    }
  }
  const context = {
    caseId, api: adminApi, token: 'unit-only-admin-token',
    page, record: {}, caseRecord, outputDir: '/unit-only',
    settings, sessionTenantId: '1'
  }
  return { context, tools, events, state, adminApi, ownApi, handle, caseRecord }
}

function dailyClosureMock (caseId = 'WBF-012') {
  const f = ownedMock({ caseId })
  const { state, events, adminApi, ownApi, tools } = f
  const permissions = [...OWNED_CASE_PERMISSIONS[caseId], 'pm:daily-report:update']
  state.menuRows = menusFor(permissions)
  state.packageMenuIds = state.menuRows.map((row) => row.id)
  state.pmRoles = new Map()
  state.pmReports = new Map()
  tools.env.CFOR_E2E_WORKBENCH_DAILY_CLOSURE = 'true'
  const ownGet = ownApi.get
  ownApi.get = async (pathname) => {
    const response = await ownGet(pathname)
    if (pathname === '/system/auth/get-permission-info') response.data.permissions = permissions
    return response
  }
  adminApi.getBusiness = async (pathname) => {
    events.push(`BUSINESS-GET:${pathname}`)
    if (pathname === '/system/user/profile/get') return success({ id: '1' })
    if (pathname.startsWith('/pm/modeling/list?')) return success([{ configCode: 'UNIT_TEST' }])
    if (pathname.startsWith('/pm/project/get?')) return success(state.pmProject)
    if (pathname.startsWith('/pm/project-role/list?')) {
      if (state.failRoleReadOnce) {
        state.failRoleReadOnce = false
        throw new Error('unit-only initial role read failed')
      }
      return success([...state.pmRoles.values()])
    }
    if (pathname.startsWith('/pm/daily-report/get?')) {
      return success(state.pmReports.get(new URLSearchParams(pathname.split('?')[1]).get('id')))
    }
    if (pathname.startsWith('/pm/daily-report/page?')) {
      return success({ list: [...state.pmReports.values()], total: state.pmReports.size })
    }
    assert.fail(`Unmocked business GET ${pathname}`)
  }
  adminApi.postBusiness = async (pathname, body) => {
    events.push(`BUSINESS-POST:${pathname}`)
    assert.equal(pathname, '/pm/handover/create')
    state.pmHandover = { ...body, id: String(state.nextId++) }
    return success(state.pmHandover.id)
  }
  adminApi.putBusiness = async (pathname, body) => {
    events.push(`BUSINESS-PUT:${pathname}`)
    if (pathname.startsWith('/pm/handover/submit?')) return success(true)
    if (pathname === '/pm/handover/review') {
      assert.equal(body.id, state.pmHandover.id)
      state.pmProject = {
        ...state.pmHandover, id: String(state.nextId++), handoverId: body.id
      }
      return success(state.pmProject.id)
    }
    if (pathname === '/pm/project-role/assign') {
      const id = body.id || String(state.nextId++)
      state.pmRoles.set(id, { ...body, id, status: 'ACTIVE' })
      return success(id)
    }
    const query = new URLSearchParams(pathname.split('?')[1])
    if (pathname.startsWith('/pm/project-role/end?')) {
      state.pmRoles.get(query.get('id')).status = 'ENDED'
      return success(true)
    }
    if (pathname.startsWith('/pm/daily-report/review?')) {
      const report = state.pmReports.get(query.get('id'))
      assert.equal(report.status, 'SUBMITTED')
      report.status = 'APPROVED'
      report.locked = true
      return success(true)
    }
    assert.fail(`Unmocked business PUT ${pathname}`)
  }
  ownApi.postBusiness = async (pathname, body) => {
    events.push(`OWN-BUSINESS-POST:${pathname}`)
    assert.equal(pathname, '/pm/daily-report/save-draft')
    const id = String(state.nextId++)
    state.pmReports.set(id, {
      ...body, id, status: 'DRAFT', sourceSnapshotJson: '{"generatedAt":"unit-only"}'
    })
    return success(id)
  }
  ownApi.getBusiness = adminApi.getBusiness
  ownApi.putBusiness = async (pathname) => {
    events.push(`OWN-BUSINESS-PUT:${pathname}`)
    assert.ok(pathname.startsWith('/pm/daily-report/submit?'))
    const id = new URLSearchParams(pathname.split('?')[1]).get('id')
    state.pmReports.get(id).status = 'SUBMITTED'
    return success(true)
  }
  tools.captureOwnedWorkbenchReports = async (_page, action, userId) => {
    await action()
    events.push('mock-capture-reports')
    return {
      missing: [],
      pages: Object.fromEntries(['DAILY', 'WEEKLY', 'MONTHLY'].map((type) => {
        const reports = type === 'DAILY' ? state.pmReports : state.reports
        const ownerKey = type === 'DAILY' ? 'reporterId' : 'ownerUserId'
        const list = [...reports.values()].filter((row) =>
          row.reportType === type && String(row[ownerKey]) === userId)
        return [type, { list, total: list.length }]
      }))
    }
  }
  tools.waitForReportRendering = async () => events.push('mock-report-rendered')
  tools.runReadOnlyCase = async () => assert.fail('Team closure must own all five catalog assertions')
  return f
}

test('WBF-012 daily closure delegates the prepared owner and registers each original assertion once', async () => {
  const f = dailyClosureMock()
  let teamCalls = 0
  f.tools.runWorkbenchTeamClosure = async (args) => {
    teamCalls++
    f.events.push('mock-team-closure')
    assert.equal(args.adminApi, f.adminApi)
    assert.equal(args.ownerHandle.api, f.ownApi)
    assert.equal(args.ownerHandle.page, f.handle.page)
    assert.equal(args.caseRecord, f.caseRecord)
    assert.equal(args.record, f.context.record)
    assert.equal(args.outputDir, f.context.outputDir)
    assert.equal(args.tools, f.tools)
    assert.equal(args.fixture.marker, args.marker)
    assert.equal(args.fixture.accountId, args.ownerAccount.userId)
    assert.equal(args.fixture.projectId, f.state.pmProject.id)
    assert.equal(args.ownerAccount.state.hasRetainedReports, true)
    assert.equal(args.report.submitted.status, 'SUBMITTED')
    assert.deepEqual(args.crmReportIds, [...f.state.reports.keys()])
    assert.equal(args.crmReportIds.length, 2)
    assert.equal(args.registry.entries.filter((row) => row.type === 'pm-project-role').length, 1)
    assert.ok(f.events.includes('mock-report-rendered'))
    for (const [index] of OWNED_CATALOG_ASSERTIONS['WBF-012'].entries()) {
      recordCatalogAssertion(args.caseRecord, 'WBF-012', index, 'VERIFIED',
        `unit-only delegated team evidence ${index}`)
    }
  }
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(teamCalls, 1)
  assert.equal(outcome(result, f.caseRecord), 'PASS')
  assert.equal(result.catalogComplete, true)
  assert.equal(f.caseRecord.catalogAssertions.length, 5)
  assert.equal([...f.state.pmReports.values()][0].status, 'APPROVED')
  assert.equal([...f.state.pmRoles.values()][0].status, 'ENDED')
  assert.equal(f.caseRecord.fixtureObjects.filter((row) => row.type === 'pm-project-role').length, 1)
  assert.equal(f.events.filter((event) => event.startsWith('BUSINESS-PUT:/pm/project-role/end?')).length, 1)
  assert.ok(f.events.findIndex((event) => event.startsWith('BUSINESS-PUT:/pm/daily-report/review?')) >
    f.events.indexOf('mock-team-closure'))
  assert.equal(f.state.reports.size, 0)
  assert.equal([...f.state.users.values()][0].status, 1)
  assert.equal(f.state.roles.size, 0)
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
  assert.ok(f.events.indexOf('browser-close') >
    f.events.findLastIndex((event) => event.startsWith('OWN-DELETE:/crm/work-report/delete?id=')))
})

test('WBF-012 team failure still cleans the registered role and CRM drafts, retains PM ownership and closes Chrome', async () => {
  const f = dailyClosureMock()
  f.tools.runWorkbenchTeamClosure = async () => { throw new Error('unit-only team closure failure') }
  await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /team closure failure/)
  assert.equal([...f.state.pmRoles.values()][0].status, 'ENDED')
  assert.equal([...f.state.pmReports.values()][0].status, 'SUBMITTED')
  assert.equal(f.state.reports.size, 0)
  assert.equal([...f.state.users.values()][0].status, 1)
  assert.equal(f.state.roles.size, 0)
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
  assert.ok(!f.events.some((event) => event.startsWith('BUSINESS-PUT:/pm/daily-report/review?')))
  assert.ok(f.events.includes('trace-stop') && f.events.includes('browser-close'))
})

test('daily project preparation registers cleanup before the first role read can fail', async () => {
  const f = dailyClosureMock()
  f.state.failRoleReadOnce = true
  f.tools.runWorkbenchTeamClosure = async () => assert.fail('Owner was not prepared')
  await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /initial role read failed/)
  assert.equal([...f.state.pmRoles.values()][0].status, 'ENDED')
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
  assert.equal(f.state.users.size, 0)
  assert.equal(f.state.roles.size, 0)
  assert.equal(f.events.includes('mock-headed-launch'), false)
})

test('WBF-012 does not enter team closure before the owner report capture succeeds', async () => {
  const f = dailyClosureMock()
  f.tools.captureOwnedWorkbenchReports = async () => ({ missing: ['unit-only DAILY GET missing'] })
  f.tools.runWorkbenchTeamClosure = async () => assert.fail('Owner report capture failed')
  await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /DAILY GET missing/)
  assert.equal([...f.state.pmRoles.values()][0].status, 'ENDED')
  assert.equal(f.state.reports.size, 0)
  assert.equal([...f.state.users.values()][0].status, 1)
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
  assert.ok(f.events.includes('browser-close'))
})

test('daily closure rejects unsupported cases and conflicting gap mode before any writes', async () => {
  for (const caseId of ['WBF-005', 'WBF-009', 'WBF-012']) {
    const f = ownedMock({ caseId })
    f.tools.env.CFOR_E2E_WORKBENCH_DAILY_CLOSURE = 'true'
    if (caseId === 'WBF-012') f.tools.env.CFOR_E2E_WORKBENCH_DAILY_GAPS = 'true'
    await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /BLOCKED:/)
    assert.deepEqual(f.events, [])
  }
})

test('WBF-004 daily closure retains date-boundary probes and removes only the current read-only gap note', async () => {
  const f = dailyClosureMock('WBF-004')
  const note = 'unit-only previous cross-user gap'
  f.caseRecord.notes.push(note)
  f.tools.runReadOnlyCase = async ({ caseId, caseRecord }, dependencies) => {
    assert.equal(caseId, 'WBF-004')
    assert.equal(dependencies.createApiClient(), f.ownApi)
    assert.deepEqual(dependencies.env, {})
    for (const label of ['日报', '周报', '月报']) caseRecord.checks.push({
      name: `${label}实际切换并匹配当前用户真实响应（PB-359~365）`, passed: true
    })
    caseRecord.checks.push({ name: '工作报告区块保持在统一门户内', passed: true })
    f.caseRecord.notes.push(note)
    return { partial: true, note }
  }
  let clients = 0
  f.tools.createApiClient = () => {
    if (clients++ === 0) return f.ownApi
    const observer = [...f.state.users.values()][1]
    return {
      async get (pathname) {
        if (pathname === '/system/auth/get-permission-info') return success({
          user: { id: observer.id }, roles: [f.state.roles.get(observer.roleIds[0]).code],
          permissions: [...OWNED_CASE_PERMISSIONS['WBF-004'], 'pm:daily-report:update']
        })
        if (pathname.includes('/get?') || pathname.includes('projectId=')) return { code: 403 }
        return success({ list: [], total: 0 })
      }
    }
  }
  f.tools.runWorkbenchTeamClosure = async () => assert.fail('WBF-004 must retain its isolation branch')
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(outcome(result, f.caseRecord), 'PASS')
  assert.equal(f.caseRecord.notes.filter((row) => row === note).length, 1)
  assert.equal(f.caseRecord.checks.filter((row) => row.name.includes('项目角色不能读取他人报告')).length, 2)
  assert.equal(f.caseRecord.catalogAssertions.length, 3)
  assert.equal(f.state.pmRoles.size, 2)
  assert.ok([...f.state.pmRoles.values()].every((row) => row.status === 'ENDED'))
  assert.equal(f.state.users.size, 1)
  assert.equal([...f.state.users.values()][0].status, 1)
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
})

for (const caseId of ['WBF-004', 'WBF-008', 'WBF-012']) {
  test(`${caseId} daily-gap mode performs no report/preference/role reassignment writes and cleans accounts`, async () => {
    fs.mkdirSync('/tmp/cfor-e2e', { recursive: true })
    const root = fs.mkdtempSync('/tmp/cfor-e2e/continue-20261013-project-unit-')
    const filename = `${root}/result.json`
    fs.writeFileSync(filename, JSON.stringify({ cases: [{
      id: 'PB113-001', startedAt: '2026-10-13T07:00:00Z',
      checks: [{ name: '本轮专属项目归属、状态与原计划日期回读不变', passed: true }],
      evidence: ['创建并回读本轮专属空项目 projectId=701, handoverId=702, marker=E2E_PB113_001_PROJECT-UNIT']
    }] }))
    try {
      const f = ownedMock({ caseId })
      f.tools.env.CFOR_E2E_WORKBENCH_DAILY_GAPS = 'true'
      f.tools.env.CFOR_E2E_WORKBENCH_PM_RESULT = filename
      const permissionKeys = ['pm:daily-report:query', 'crm:work-report:query']
      f.state.menuRows = menusFor(permissionKeys)
      f.state.packageMenuIds = f.state.menuRows.map((row) => row.id)
      const adminGet = f.adminApi.get
      f.adminApi.get = async (query) => {
        if (query.startsWith('/pm/project/get')) return success({
          id: '701', handoverId: '702', projectName: 'E2E_PB113_001_PROJECT-UNIT'
        })
        if (query.startsWith('/pm/handover/get')) return success({
          projectId: '701', projectName: 'E2E_PB113_001_PROJECT-UNIT'
        })
        if (query.startsWith('/pm/project-role/list')) return success([
          { id: '703', userId: '1', status: 'ACTIVE' }
        ])
        if (query.startsWith('/pm/daily-report/page')) return success({ list: [], total: 0 })
        return adminGet(query)
      }
      const ownGet = f.ownApi.get
      f.ownApi.get = async (query) => {
        if (query === '/system/auth/get-permission-info') {
          const payload = await ownGet(query)
          payload.data.permissions = permissionKeys
          return payload
        }
        if (query.startsWith('/pm/daily-report/page')) return success({ list: [], total: 0 })
        return ownGet(query)
      }
      f.tools.waitForReportRendering = async () => {}
      f.tools.runReadOnlyCase = async () => assert.fail('Prior week/month/read-only flow must not repeat')
      const result = await runOwnedWorkbenchCase(f.context, f.tools)
      assert.equal(result.partial, true)
      assert.equal(outcome(result, f.caseRecord), 'PARTIAL')
      assert.ok(!f.events.some((event) => /crm\/work-report\/create|user-preference\/save|assign-role-data-scope/.test(event)))
      assert.equal(f.state.roles.size, 0)
      assert.equal(f.state.users.size, 0)
      assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
    } finally { fs.rmSync(root, { recursive: true }) }
  })
}

test('owned assertion contract exactly matches the current catalog without editing it', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url)))
  const definitions = catalog.suites.flatMap((suite) => suite.cases)
  for (const [id, assertions] of Object.entries(OWNED_CATALOG_ASSERTIONS)) {
    assert.deepEqual(assertions, definitions.find((row) => row.id === id).assertions)
    assert.equal(WORKBENCH_FIXTURE_DEPENDENCIES[id].catalogNeedsProject, false)
  }
  for (const id of ['WBF-005', 'WBF-009']) {
    assert.deepEqual(WORKBENCH_FIXTURE_DEPENDENCIES[id].projectDependentEnhancements, [])
  }
  assert.match(WORKBENCH_FIXTURE_DEPENDENCIES['WBF-012'].nonProjectBlockers.join(), /数据权限/)
})

test('owned permission normalization ignores empty display values but preserves grants and gaps', () => {
  assert.deepEqual(normalizeOwnedPermissions([
    '', ' erp:purchase-order:query ', null, undefined, 'erp:purchase-order:create'
  ]), ['erp:purchase-order:query', 'erp:purchase-order:create'])
  assert.throws(() => normalizeOwnedPermissions(['*:*:*']), /通配符/)
  assert.throws(() => normalizeOwnedPermissions([123]), /非字符串/)
  assert.throws(() => normalizeOwnedPermissions(null), /不是数组/)
})

test('menu selection grants only required package nodes and resolves parent chains from full definitions', () => {
  const rows = [
    { id: 1, parentId: 0, status: 0, permission: '' },
    { id: 2, parentId: 1, status: 0, component: 'Home/SystemIndex.vue' },
    { id: 3, parentId: 1, status: 0, permission: 'crm:work-report:query' },
    { id: 4, parentId: 1, status: 0, permission: 'crm:work-report:submit' }
  ]
  assert.deepEqual(selectOwnedMenuIds(rows, rows, ['crm:work-report:query']), ['2', '3'])
  assert.deepEqual(selectOwnedMenuIds(rows, rows.filter((row) => row.id !== 1), []), ['2'])
  assert.deepEqual(
    selectOwnedMenuIds(rows, rows.filter((row) => row.id !== 1), ['crm:work-report:query']),
    ['2', '3']
  )
  assert.throws(() => selectOwnedMenuIds(rows, rows, ['crm:workreport:query']), /菜单缺失/)
  assert.throws(() => selectOwnedMenuIds(rows, rows, ['*:*:*']), /输入无效/)
  assert.throws(() => selectOwnedMenuIds(rows.map((row) =>
    row.id === 1 ? { ...row, permission: 'system:user:update' } : row), rows, []), /范围外权限/)
})

test('duplicated permission codes resolve to the deepest available leaf without widening grants', () => {
  const rows = [
    { id: 1, parentId: 0, status: 0, permission: '' },
    { id: 2, parentId: 1, status: 0, component: 'Home/SystemIndex.vue' },
    { id: 10, parentId: 1, status: 0, permission: 'pm:daily-report:query', name: 'page' },
    { id: 11, parentId: 10, status: 0, permission: 'pm:daily-report:query', name: 'button' }
  ]
  const ids = selectOwnedMenuIds(rows, rows, ['pm:daily-report:query'])
  assert.ok(ids.includes('11'), '应该选择层级更深的叶子按钮')
  assert.ok(ids.includes('2'))
  assert.ok(!ids.includes('10'), '服务端会规范化父链，夹具不应主动提交父页面')
  const available = rows.filter((row) => row.id !== 11)
  const fallback = selectOwnedMenuIds(rows, available, ['pm:daily-report:query'])
  assert.ok(fallback.includes('10'))
  assert.ok(!fallback.includes('11'), '套餐外候选不得被选中')
})

test('PMS 旧隐藏父链按原始套餐 menu_ids 解析，查询型父权限仅作为服务端导航回读', () => {
  const rows = [
    { id: 1, parentId: 0, status: 0, permission: '', type: 1 },
    { id: 2, parentId: 1, status: 0, component: 'Home/SystemIndex.vue', type: 2 },
    { id: 10, parentId: 1, status: 0, permission: 'system:settings:query', type: 2 },
    { id: 11, parentId: 10, status: 0, permission: 'base:material-grade:query', type: 3 }
  ]
  const packageRows = rows.filter((row) => [2, 11].includes(row.id))
  const ids = selectOwnedMenuIds(rows, packageRows, ['base:material-grade:query'])
  assert.deepEqual(ids, ['2', '11'], '夹具只提交套餐内工作台和真实权限节点')
  assert.deepEqual(
    collectOwnedNavigationQueryPermissions(rows, ids, ['base:material-grade:query']),
    ['system:settings:query']
  )
  assert.deepEqual(
    selectOwnedMenuIds(rows, packageRows, ['base:material-grade:query']),
    ['2', '11']
  )
  assert.throws(() => selectOwnedMenuIds(
    rows.map((row) => (row.id === 10 ? { ...row, permission: 'system:user:update' } : row)),
    rows, ['base:material-grade:query']), /范围外权限/)
})

test('套餐原始 menu_ids 缺少真实权限叶子时在任何写入前 BLOCKED', async () => {
  const f = ownedMock({ caseId: 'WBF-004', packageMenuIds: [1, 2, 3, 4] })
  await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /权限菜单缺失/)
  assert.equal(f.events.some((event) => /^(POST|PUT|DELETE):/.test(event)), false)
})

test('cyclic, disabled, duplicated or missing-parent menus stop before writes', () => {
  const rows = menusFor()
  assert.throws(() => selectOwnedMenuIds([{ ...rows[0], parentId: 1 }], rows, []), /循环/)
  assert.throws(() => selectOwnedMenuIds([{ ...rows[0], status: 1 }], rows, []), /启用/)
  assert.throws(() => selectOwnedMenuIds([...rows, { ...rows[0], id: 2 }], rows, []), /未唯一/)
  assert.throws(() => selectOwnedMenuIds([{ ...rows[0], parentId: 42 }], rows, []), /父链缺失/)
})

test('WBF-009 and WBF-005 never inherit all report writes or portal management grants', () => {
  assert.deepEqual(OWNED_CASE_PERMISSIONS['WBF-009'], [])
  assert.deepEqual(OWNED_CASE_PERMISSIONS['WBF-005'],
    ['erp:purchase-order:query', 'erp:purchase-order:create', 'base:material-grade:query'])
  for (const permissions of Object.values(OWNED_CASE_PERMISSIONS)) {
    assert.ok(!permissions.some((key) => /submit|review|portal|assign|daily-report:update|\*/.test(key)))
  }
  assert.throws(() => assertFixtureActor({ user: { id: 1 }, permissions: [] }, 'WBF-009'), /未写入/)
})

for (const gate of ['opt-in', 'target', 'tenant', 'health', 'safety', 'menus', 'actor']) {
  test(`${gate} gate rejects with zero owned writes and no browser`, async () => {
    const f = ownedMock()
    if (gate === 'opt-in') f.tools.env = {}
    if (gate === 'target') f.context.settings = { ...settings, target: 'production' }
    if (gate === 'tenant') f.context.sessionTenantId = '2'
    if (gate === 'health') f.state.healthy = false
    if (gate === 'safety') f.tools.assertLocalWriteSafety = async () => { throw new Error('BLOCKED: unit-only jobs active') }
    if (gate === 'menus') f.state.menuRows = []
    if (gate === 'actor') {
      const get = f.adminApi.get
      f.adminApi.get = async (path) => path === '/system/auth/get-permission-info'
        ? success({ user: { id: 1 }, permissions: [] }) : get(path)
    }
    await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /BLOCKED:/)
    assert.equal(f.events.some((event) => /^(POST|PUT|DELETE|OWN-POST|OWN-PUT|OWN-DELETE):/.test(event)), false)
    assert.equal(f.events.includes('mock-headed-launch'), false)
  })
}

test('registry cleans in reverse order, checks marker, and keeps cleanup failures as evidence', async () => {
  const caseRecord = newRecord()
  const registry = createOwnedRegistry(marker, caseRecord)
  const removed = []
  for (const [id, remark] of [['1', marker], ['2', 'EXISTING-BUSINESS'], ['3', marker]]) {
    registry.add({
      type: 'fixture', id, read: async () => ({ remark }),
      matches: (row, expected) => row.remark === expected,
      remove: async () => removed.push(id)
    })
  }
  const remaining = await registry.cleanup()
  assert.deepEqual(removed, ['3', '1'])
  assert.deepEqual(remaining.map((row) => row.id), ['2'])
  assert.equal(caseRecord.checks.at(-1).passed, false)
  assert.throws(() => createOwnedRegistry('EXISTING', newRecord()), /marker/)
  assert.throws(() => registry.add({ type: 'fixture', id: '1' }), /契约/)
})

test('portal manual cleanup updates the actual registry entry and never deletes twice', async () => {
  const f = ownedMock()
  const registry = createOwnedRegistry(marker, f.caseRecord)
  const account = await createOwnedAccount({
    api: f.adminApi, registry, marker, menuIds: ['1'], tag: 'owner', caseRecord: f.caseRecord
  })
  const portal = await createPortal({
    api: f.adminApi, registry, marker, account, sections: ['report'], caseRecord: f.caseRecord
  })
  await portal.remove()
  await registry.cleanup()
  assert.equal(f.events.filter((event) => event.startsWith('DELETE:/system/portal/delete')).length, 1)
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
  assert.equal(f.state.users.size, 0)
  assert.equal(f.state.roles.size, 0)
})

test('full WBF-009 mock verifies configured and default DOM, then deletes only owned objects', async () => {
  const f = ownedMock()
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(outcome(result, f.caseRecord), 'PASS')
  assert.equal(f.caseRecord.catalogAssertions.length, 3)
  assert.ok(f.caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'))
  assert.equal(f.state.portal, null)
  assert.equal(f.state.users.size, 0)
  assert.equal(f.state.roles.size, 0)
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
  assert.ok(f.events.indexOf('mock-login') < f.events.indexOf('trace-start'))
  assert.equal(f.events.filter((event) => event === 'browser-close').length, 1)
  assert.ok(!f.events.some((event) => /PB-|modeling|daily-report\/save|assign-role-data-scope/.test(event)))
  assert.ok(!JSON.stringify(f.caseRecord).includes('unit-only-owned-token'))
})

test('WBF-009 does not upgrade a missing default section or successful unauthorized API to PASS', async () => {
  const hidden = ownedMock({ hiddenSection: 'culture' })
  const result = await runOwnedWorkbenchCase(hidden.context, hidden.tools)
  assert.equal(outcome(result, hidden.caseRecord), 'FAIL')
  assert.equal(result.catalogComplete, false)
  const exposed = ownedMock()
  const get = exposed.ownApi.get
  exposed.ownApi.get = async (path) => path.startsWith('/crm/work-report/page')
    ? success({ list: [], total: 0 }) : get(path)
  const exposedResult = await runOwnedWorkbenchCase(exposed.context, exposed.tools)
  assert.equal(outcome(exposedResult, exposed.caseRecord), 'FAIL')
})

test('HTTP-200 role-create business failure cannot become a fixture ID or start Chrome', async () => {
  const f = ownedMock({ failPost: '/system/role/create' })
  await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /business failure/)
  assert.equal(f.state.roles.size, 0)
  assert.equal(f.events.includes('mock-headed-launch'), false)
  assert.deepEqual(f.caseRecord.fixtureCleanup.remaining, [])
})

test('account creation failure clears the returned role without touching any existing user', async () => {
  const f = ownedMock({ failPost: '/system/user/create' })
  await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /business failure/)
  assert.equal(f.state.roles.size, 0)
  assert.equal(f.events.some((event) => event.startsWith('DELETE:/system/user/')), false)
})

test('unexpected owned grant or wrong login tenant closes Chrome and clears only owned IDs', async () => {
  for (const mode of ['grant', 'tenant']) {
    const f = ownedMock({ extraPermission: mode === 'grant' ? 'system:user:delete' : undefined })
    if (mode === 'tenant') f.state.loginTenant = '2'
    await assert.rejects(runOwnedWorkbenchCase(f.context, f.tools), /授权不符|租户 1/)
    assert.equal(f.state.users.size, 0)
    assert.equal(f.state.roles.size, 0)
    assert.equal(f.state.portal, null)
    assert.equal(f.events.filter((event) => event === 'browser-close').length, 1)
  }
})

test('a cleanup business error remains a failure and Chrome still closes', async () => {
  const f = ownedMock({ failDelete: '/system/role/delete' })
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(outcome(result, f.caseRecord), 'FAIL')
  assert.equal(f.caseRecord.fixtureCleanup.remaining.length, 1)
  assert.equal(f.caseRecord.fixtureCleanup.remaining[0].type, 'role')
  assert.ok(f.events.includes('browser-close'))
})

test('only a formal permission denial is accepted, not empty lists, 500s or timeouts', async () => {
  const path = '/crm/work-report/page?pageNo=1&pageSize=100'
  assert.equal((await expectPermissionDenied({ get: async () => ({ code: 403 }) }, path)).passed, true)
  assert.equal((await expectPermissionDenied({ get: async () => success({ list: [], total: 0 }) }, path)).passed, false)
  assert.equal((await expectPermissionDenied({ get: async () => ({ code: 500 }) }, path)).passed, false)
  assert.equal((await expectPermissionDenied({
    get: async () => { throw new Error(`HTTP 403 GET ${path}: denied`) }
  }, path)).passed, true)
  await assert.rejects(expectPermissionDenied({
    get: async () => { throw new Error('unit-only timeout') }
  }, path), /timeout/)
})

test('draft periods cover a real Monday-Sunday week and month including leap-year boundaries', () => {
  const rows = draftPayloads(marker, '2026-10-07')
  assert.equal(rows[0].periodStart, '2026-10-05')
  assert.equal(rows[0].periodEnd, '2026-10-11')
  assert.equal(rows[1].periodStart, '2026-10-01')
  assert.equal(rows[1].periodEnd, '2026-10-31')
  assert.equal(draftPayloads(marker, '2024-02-29')[1].periodEnd, '2024-02-29')
  assert.throws(() => draftPayloads(marker, '2026-02-31'), /日期/)
  assert.ok(rows.every((row) => row.aiConfirmed === false && !row.projectId && !row.ownerUserId))
})

test('WBF-004 has nonempty CRM drafts but remains PARTIAL for uncovered enhanced acceptance', async () => {
  const f = ownedMock({ caseId: 'WBF-004' })
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(outcome(result, f.caseRecord), 'PARTIAL')
  assert.equal(result.catalogComplete, true)
  assert.equal(f.caseRecord.businessIds.filter((row) => row.type === 'crm-report').length, 2)
  assert.equal(f.state.reports.size, 0)
  assert.equal(f.state.users.size, 0)
  assert.equal(f.state.roles.size, 0)
  assert.ok(f.events.includes('GET:/system/tenant-package/get?id=111'))
  assert.equal(f.events.some((event) => event.includes('/system/menu/list-all-simple')), false)
  assert.match(result.note, /日报非空/)
  assert.match(result.note, /项目成员、填报人归属或数据权限校验/)
  assert.ok(!f.events.some((event) => /pm\/.*(create|save|submit)|modeling|PB-001/.test(event)))
})

test('套餐外页面型 query 父节点不由夹具提交，但不会被判为范围外授权', async () => {
  const f = ownedMock({
    caseId: 'WBF-004',
    navigationQuery: 'system:menu:query',
    packageMenuIds: [1, 3, 4, 5, 6]
  })
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(outcome(result, f.caseRecord), 'PARTIAL')
  assert.ok(!f.state.assigned.includes('2'), '夹具不得主动提交父节点')
  assert.equal(f.events.some((event) => event.includes('授权不符')), false)
  assert.equal(f.state.roles.size, 0)
  assert.equal(f.state.users.size, 0)
})

test('WBF-012 leaves the team original assertion unverified, independently of PB seed state', async () => {
  const f = ownedMock({ caseId: 'WBF-012' })
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(outcome(result, f.caseRecord), 'PARTIAL')
  assert.equal(result.catalogComplete, false)
  assert.equal(f.caseRecord.catalogAssertions[3].status, 'UNVERIFIED')
  assert.match(result.note, /团队/)
  assert.ok(!f.events.some((event) => event.includes('assign-role-data-scope')))
})

test('failed CRM draft cleanup preserves its owner and recovery role as explicit residuals', async () => {
  const f = ownedMock({ caseId: 'WBF-004', failDelete: 'report' })
  const result = await runOwnedWorkbenchCase(f.context, f.tools)
  assert.equal(outcome(result, f.caseRecord), 'FAIL')
  assert.equal(f.state.reports.size, 2)
  assert.equal([...f.state.users.values()][0].status, 1)
  assert.equal(f.state.roles.size, 1)
  assert.match(f.caseRecord.fixtureCleanup.remaining.find((row) => row.type === 'role').reason, /恢复角色/)
  assert.ok(f.caseRecord.fixtureResiduals.some((row) => row.type === 'disabled-user'))
})

test('new preference baseline is scoped to the owned account and unknown preexisting state is not overwritten', async () => {
  const f = ownedMock()
  const account = { userId: '102', state: {} }
  const key = 'workbench.report.weekly-metrics'
  const baseline = await saveOwnedPreference(account, f.ownApi, key, ['riskCount'], f.caseRecord)
  assert.equal(baseline, '["riskCount"]')
  assert.equal(account.state.hasPreferences, true)
  await assert.rejects(saveOwnedPreference(account, f.ownApi, key, ['contractAmount'], f.caseRecord), /拒绝覆盖/)
  assert.equal(f.state.preferences.get(key), baseline)
  await restoreOwnedPreference(f.ownApi, key, baseline, f.caseRecord)
  assert.equal(f.caseRecord.fixtureResiduals[0].restored, true)
})

test('restore failures are reported without hiding an earlier primary failure', async () => {
  const caseRecord = newRecord()
  await restoreOwnedPreference({
    put: async () => ({ code: 500 }),
    get: async () => assert.fail('Business failure must be rejected before readback')
  }, 'workbench.quick-actions', '[]', caseRecord)
  assert.equal(caseRecord.checks[0].passed, false)
  assert.match(caseRecord.notes[0], /未还原/)
})

test('accounts with preferences are disabled and retained, not deleted with orphan preferences', async () => {
  const f = ownedMock()
  const registry = createOwnedRegistry(marker, f.caseRecord)
  const account = await createOwnedAccount({
    api: f.adminApi, registry, marker, menuIds: ['1'], tag: 'owner', caseRecord: f.caseRecord
  })
  await saveOwnedPreference(account, f.ownApi, 'workbench.quick-actions', [], f.caseRecord)
  await registry.cleanup()
  assert.equal(f.state.users.get(account.userId).status, 1)
  assert.equal(f.state.roles.size, 0)
  assert.ok(f.caseRecord.fixtureResiduals.some((row) => row.type === 'disabled-user'))
  assert.ok(!f.events.some((event) => event.startsWith('DELETE:/system/user/delete')))
})

test('cleaning CRM drafts retains the disabled owner of an undeletable PM report', async () => {
  const f = ownedMock({ caseId: 'WBF-004' })
  const registry = createOwnedRegistry(marker, f.caseRecord)
  const account = await createOwnedAccount({
    api: f.adminApi, registry, marker, menuIds: ['1'], tag: 'owner', caseRecord: f.caseRecord
  })
  await createDrafts({
    account, ownApi: f.ownApi, registry, marker, today: '2026-10-15', caseRecord: f.caseRecord
  })
  account.state.hasRetainedReports = true
  await registry.cleanup()
  assert.equal(f.state.reports.size, 0)
  assert.equal(account.state.hasResidualReports, false)
  assert.equal(f.state.users.get(account.userId).status, 1)
  assert.equal(f.state.roles.size, 0)
  assert.equal(f.caseRecord.fixtureCleanup.remaining.length, 0)
  assert.ok(!f.events.some((event) => event.startsWith('DELETE:/system/user/delete')))
})

test('purchase sequence evidence requires exact tenant key and an actual allocation delta', () => {
  const key = 'CGDD261007RESET261007TENANT1'
  const before = { available: true, rows: [[key, '1', '2']] }
  const after = { available: true, rows: [[key, '1', '3']] }
  assert.equal(validatePurchaseSequence('CGDD261007003', before, after).passed, true)
  assert.equal(validatePurchaseSequence('CGDD261007003', before, before).passed, false)
  assert.throws(() => validatePurchaseSequence('CGDD261007003', before,
    { available: true, rows: [[key, '2', '3']] }), /key\/租户/)
  assert.throws(() => validatePurchaseSequence('CGDD261007003', before,
    { available: false, rows: [] }), /数据库契约/)
})

function purchaseMock ({ failStage, businessCode = 0 } = {}) {
  const caseRecord = newRecord()
  const account = { userId: '101', state: {} }
  const billNo = 'CGDD261015003'
  const waits = []
  let preference = null
  let pending
  let sequenceReads = 0
  const activate = async (pathname, method, payload) => {
    assert.ok(pending, 'The real response listener must precede the click')
    const response = {
      url: () => `http://127.0.0.1:9151/admin-api${pathname}`,
      request: () => ({ method: () => method }),
      ok: () => true,
      payload
    }
    assert.equal(pending.predicate(response), true)
    assert.equal(pending.predicate({
      ...response, request: () => ({ method: () => method === 'PUT' ? 'GET' : 'POST' })
    }), false)
    const listener = pending
    pending = null
    listener.resolve(response)
  }
  const ready = {
    first () { return this },
    last () { return this },
    waitFor: async () => {},
    isVisible: async () => true,
    evaluateAll: async () => [billNo],
    click: async () => {}
  }
  const create = { ...ready, click: () => activate(
    '/mes/fillRule/executeRuleByCode/erp_purchase_no', 'PUT', success(billNo)
  ) }
  const execution = { ...ready, click: () => activate(
    '/erp/purchase-order/page', 'GET',
    businessCode === 0 ? success({ list: [], total: 0 }) : { code: businessCode, msg: 'unit-only denied' }
  ) }
  const quick = {
    first () { return this },
    getByRole: (_role, { name }) => name === '新增采购订单' ? create : execution
  }
  const form = {
    ...ready,
    locator: () => ready,
    getByRole: () => ready
  }
  const page = {
    on () {}, off () {},
    url: () => 'http://127.0.0.1:9151/index',
    locator: (selector) => selector === '.quick-actions-strip' ? quick : form,
    getByRole: () => form,
    waitForResponse (predicate, { timeout }) {
      waits.push(timeout)
      if (failStage === waits.length) return Promise.reject(new Error('unit-only response timeout'))
      return new Promise((resolve) => { pending = { predicate, resolve } })
    }
  }
  const handle = {
    page,
    api: {
      get: async (pathname) => success(pathname.startsWith('/system/user-preference/')
        ? preference : { list: [], total: 0 }),
      put: async (_pathname, body) => { preference = body.value; return success(true) }
    }
  }
  const tools = {
    openRoute: async () => {},
    saveScreenshot: async () => {},
    readBrowserResponsePayload: async (response) => response.payload,
    runReadOnlySql: async () => ({
      available: true, rows: [['CGDD261015RESET261015TENANT1', '1', String(2 + sequenceReads++)]]
    })
  }
  if (failStage) {
    const action = failStage === 1 ? create : execution
    action.click = async () => {}
  }
  const adminApi = {
    get: async () => success({ records: [{
      ruleCode: 'erp_purchase_no', status: 'PUBLISHED', ruleClass: 'unit.BillNoRule',
      ruleParams: JSON.stringify({ prefix: 'CGDD', period: 'yyMMdd', seqLen: 3 })
    }] })
  }
  return { caseRecord, waits, run: () => verifyPurchase({
    account, handle, caseRecord, tools, adminApi, outputDir: '/unit-only', record: {}
  }) }
}

test('purchase uses bounded cold-load and slow-page waits while retaining number, DB and no-save assertions', async () => {
  const f = purchaseMock()
  await f.run()
  assert.deepEqual(f.waits, [120000, 180000])
  assert.ok(f.caseRecord.checks.every((row) => row.passed))
  assert.equal(f.caseRecord.catalogAssertions.length, 3)
  const timings = f.caseRecord.evidence.map((row) => JSON.parse(row))
    .filter((row) => row.stage?.startsWith('purchase-'))
  assert.deepEqual(timings.map((row) => row.completed), [true, true])
  assert.ok(timings.every((row) => Number.isInteger(row.elapsedMs) && row.elapsedMs >= 0))
})

test('purchase response timeouts and HTTP-200 business denial remain failures with preference restoration', async () => {
  for (const failStage of [1, 2]) {
    const f = purchaseMock({ failStage })
    await assert.rejects(f.run(), /unit-only response timeout/)
    assert.ok(f.caseRecord.evidence.some((row) => JSON.parse(row).completed === false))
    assert.equal(f.caseRecord.checks.at(-1).passed, true)
    assert.match(f.caseRecord.checks.at(-1).name, /基线还原/)
  }
  const denied = purchaseMock({ businessCode: 403 })
  await assert.rejects(denied.run(), /采购执行分页/)
  assert.equal(denied.caseRecord.catalogAssertions.length, 1)
  assert.match(denied.caseRecord.checks.at(-1).name, /基线还原/)
})

test('draft-reminder defect is conditional on real DOM wording, not just the existence of a draft', () => {
  const pages = {
    DAILY: { list: [], total: 0 },
    WEEKLY: { list: [{ periodStart: '2026-10-05', periodEnd: '2026-10-11', status: 'DRAFT' }], total: 1 },
    MONTHLY: { list: [{ periodStart: '2026-10-01', periodEnd: '2026-10-31', status: 'DRAFT' }], total: 1 }
  }
  const actual = expectedReminders(pages, '2026-10-07')
  assert.equal(matchesWorkbenchReminders(pages, actual, '2026-10-07'), true)
  assert.equal(actual[1][0], '本周周报草稿待提交')
  assert.equal(actual[2][0], '本月月报草稿待提交')
  assert.deepEqual(draftReminderMismatches(pages, actual, '2026-10-07'), [])
  const incorrect = actual.map((row) => [...row])
  incorrect[1][0] = '本周周报已提交'
  incorrect[2][0] = '本月月报已提交'
  assert.deepEqual(draftReminderMismatches(pages, incorrect, '2026-10-07'), ['WEEKLY', 'MONTHLY'])
  assert.equal(matchesWorkbenchReminders(pages, incorrect, '2026-10-07'), false)
  assert.equal(matchesWorkbenchReminders(pages, actual.map((row, index) => [
    ['今日日报未填报', '本周周报未填报', '本月月报未填报'][index], row[1]
  ]), '2026-10-07'), false)
  assert.equal(actual[0][1], '本月日报 已填 0 · 待审批 0')
})

test('no checks or only unrelated checks cannot mark owned catalog acceptance PASS', () => {
  const caseRecord = newRecord()
  caseRecord.checks.push({ name: 'HTTP 200', passed: true })
  const result = ownedCaseConclusion('WBF-009', caseRecord)
  assert.equal(result.partial, true)
  assert.equal(result.catalogComplete, false)
  assert.match(result.note, /原断言未证实/)
  assert.throws(() => recordCatalogAssertion(caseRecord, 'WBF-009', 0, 'VERIFIED', ''), /无证据/)
})

test('all original assertions can be verified while larger untested scope still remains PARTIAL', () => {
  const caseRecord = newRecord()
  for (let index = 0; index < 3; index++) {
    recordCatalogAssertion(caseRecord, 'WBF-004', index, 'VERIFIED', 'unit-only exact assertion evidence')
  }
  const result = ownedCaseConclusion('WBF-004', caseRecord, ['非空日报增强尚未验收'])
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => ({
    index: row.index, assertion: row.assertion
  })), OWNED_CATALOG_ASSERTIONS['WBF-004'].map((assertion, index) => ({ index, assertion })))
  assert.equal(result.catalogComplete, true)
  assert.equal(result.partial, true)
})

test('partial report tab or cycle checks do not silently verify all original assertions', () => {
  const caseRecord = newRecord()
  recordReadOnlyCoverage('WBF-004', caseRecord, [{ name: '真实登录成功', passed: true }])
  assert.equal(caseRecord.catalogAssertions.filter((row) => row.status === 'VERIFIED').length, 0)
})
