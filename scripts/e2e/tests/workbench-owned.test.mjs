import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  OWNED_CASE_PERMISSIONS,
  SECTION_SELECTORS,
  assertFixtureActor,
  createDrafts,
  createOwnedAccount,
  createOwnedRegistry,
  createPortal,
  draftPayloads,
  draftReminderMismatches,
  expectPermissionDenied,
  expectedReminders,
  newOwnedBrowser,
  normalizeOwnedPermissions,
  recordReadOnlyCoverage,
  restoreOwnedPreference,
  runOwnedWorkbenchCase,
  saveOwnedPreference,
  selectOwnedMenuIds,
  validatePurchaseSequence,
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

function menusFor (permissions = []) {
  return [
    { id: 1, parentId: 0, status: 0, permission: '', component: 'Home/SystemIndex', path: '/index' },
    ...permissions.map((permission, index) => ({
      id: index + 2, parentId: 0, status: 0, permission
    }))
  ]
}

function ownedMock ({ caseId = 'WBF-009', hiddenSection, extraPermission, failPost, failDelete } = {}) {
  const events = []
  const caseRecord = newRecord()
  const permissions = OWNED_CASE_PERMISSIONS[caseId]
  const state = {
    roles: new Map(), users: new Map(), reports: new Map(),
    portal: null, preferences: new Map(), menuRows: menusFor(permissions),
    nextId: 101, healthy: true, loginTenant: '1'
  }
  const adminApi = {
    async get (pathname) {
      events.push(`GET:${pathname}`)
      if (pathname.startsWith('/system/tenant/get-id-by-name')) return success('1')
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
        permissions: [...permissions, ...(extraPermission ? [extraPermission] : [])],
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

test('menu selection grants only required nodes and their available parent chains', () => {
  const rows = [
    { id: 1, parentId: 0, status: 0, permission: '' },
    { id: 2, parentId: 1, status: 0, component: 'Home/SystemIndex.vue' },
    { id: 3, parentId: 1, status: 0, permission: 'crm:work-report:query' },
    { id: 4, parentId: 1, status: 0, permission: 'crm:work-report:submit' }
  ]
  assert.deepEqual(selectOwnedMenuIds(rows, rows, ['crm:work-report:query']), ['2', '1', '3'])
  assert.deepEqual(selectOwnedMenuIds(rows, rows, []), ['2', '1'])
  assert.throws(() => selectOwnedMenuIds(rows, rows.filter((row) => row.id !== 3),
    ['crm:work-report:query']), /套餐范围/)
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
  assert.ok(ids.includes('10') && ids.includes('1') && ids.includes('2'))
  const available = rows.filter((row) => row.id !== 11)
  const fallback = selectOwnedMenuIds(rows, available, ['pm:daily-report:query'])
  assert.ok(fallback.includes('10'))
  assert.ok(!fallback.includes('11'), '套餐外候选不得被选中')
})

test('directory scaffold may reuse a menu-grouping permission but pages and buttons may not', () => {
  const rows = [
    { id: 1, parentId: 0, status: 0, permission: '', type: 1 },
    { id: 2, parentId: 1, status: 0, component: 'Home/SystemIndex.vue', type: 2 },
    { id: 10, parentId: 1, status: 0, permission: 'system:settings:query', type: 1 },
    { id: 11, parentId: 10, status: 0, permission: 'base:material-grade:query', type: 3 }
  ]
  const ids = selectOwnedMenuIds(rows, rows, ['base:material-grade:query'])
  assert.ok(ids.includes('10') && ids.includes('11'), '目录骨架应可随叶子一并授予')
  assert.throws(() => selectOwnedMenuIds(
    rows.map((row) => (row.id === 10 ? { ...row, type: 2 } : row)),
    rows, ['base:material-grade:query']), /范围外权限/)
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
  assert.match(result.note, /日报非空/)
  assert.ok(!f.events.some((event) => /pm\/.*(create|save|submit)|modeling|PB-001/.test(event)))
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

test('draft-reminder defect is conditional on real DOM wording, not just the existence of a draft', () => {
  const pages = {
    DAILY: { list: [], total: 0 },
    WEEKLY: { list: [{ periodStart: '2026-10-05', periodEnd: '2026-10-11', status: 'DRAFT' }], total: 1 },
    MONTHLY: { list: [{ periodStart: '2026-10-01', periodEnd: '2026-10-31', status: 'DRAFT' }], total: 1 }
  }
  const actual = expectedReminders(pages, '2026-10-07')
  assert.deepEqual(draftReminderMismatches(pages, actual, '2026-10-07'), ['WEEKLY', 'MONTHLY'])
  actual[1][0] = '本周周报已填写'
  actual[2][0] = '本月月报已填写'
  assert.deepEqual(draftReminderMismatches(pages, actual, '2026-10-07'), [])
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
  assert.equal(result.catalogComplete, true)
  assert.equal(result.partial, true)
})

test('partial report tab or cycle checks do not silently verify all original assertions', () => {
  const caseRecord = newRecord()
  recordReadOnlyCoverage('WBF-004', caseRecord, [{ name: '真实登录成功', passed: true }])
  assert.equal(caseRecord.catalogAssertions.filter((row) => row.status === 'VERIFIED').length, 0)
})
