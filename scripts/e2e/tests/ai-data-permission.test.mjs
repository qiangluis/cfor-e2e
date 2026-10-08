import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  cases, catalogAssertions, assertAiDataLocal, aiDataPayload,
  assertOwnedAiRole, assertOwnedAiUser, selectAiDataMenus, aiDataReportSql,
  assertAiDataRequest, createAiDataRequest, aiDataRows, aiDataAmountEvidence, runCase
} from '../fixtures/ai-data-permission.mjs'
import { caseOutcome } from '../lib/report.mjs'

const settings = {
  target: 'local', apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
  tenantId: '1', tenantName: 'Unit tenant', username: 'unitadmin',
  password: 'private-admin-password', requestTimeoutMs: 1000,
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const ok = (data) => ({ status: 200, body: { code: 0, data } })
const sample = {
  id: '2107770278182100993', customerId: '2107770270351335425',
  owner: '1', amount: '74593.127', billNo: 'E2E-UNIT-READONLY'
}
const menuRows = [
  { id: '201', parentId: 0, status: 0, permission: 'erp:sale-order:query' },
  { id: '202', parentId: 0, status: 0, permission: 'system:role:query' },
  { id: '203', parentId: 0, status: 0, permission: 'report:go-view-data:get-by-sql' },
  { id: '204', parentId: '202', status: 0, permission: 'sensitive:amount:view' },
  { id: '205', parentId: 0, status: 0, permission: 'erp:sale-order:export' }
]
const outcome = (result, caseRecord) => caseOutcome({
  result, hasAssertions: caseRecord.checks.length > 0,
  failedChecks: caseRecord.checks.filter((row) => row.passed === false)
}).status

const originalFetch = globalThis.fetch
test.before(() => {
  globalThis.fetch = async () => assert.fail('Unmocked network forbidden in AUTH-DATA-007 unit tests')
})
test.after(() => { globalThis.fetch = originalFetch })

function harness ({
  leakTool = false, leakReport = false, self500 = false,
  wrongOwner = false, failUserCreate = false, failRoleDelete = false, noSample = false
} = {}) {
  const record = { api: [], screenshots: [] }
  const caseRecord = { checks: [], evidence: [], notes: [] }
  const state = {
    role: null, user: null, menuIds: [], roleId: '1101', userId: '1102',
    actorLoggedIn: false, actorClosed: false
  }
  const calls = []
  const secrets = [settings.password, 'private-admin-token', 'private-actor-token', sample.amount]
  const request = async (method, pathname, body, options = {}) => {
    calls.push({ method, pathname, body, options })
    assertAiDataRequest(method, pathname, body)
    if (pathname.endsWith('/system/auth/login-encrypted')) {
      assert.equal(options.encrypted, true)
      return ok({ accessToken: 'private-admin-token' })
    }
    if (pathname.endsWith('/system/auth/logout')) {
      if (options.token === 'private-actor-token') state.actorLoggedIn = false
      return ok(true)
    }
    if (pathname.endsWith('/system/auth/get-permission-info')) return ok({
      user: { id: options.token === 'private-actor-token' ? state.userId : '1' },
      roles: options.token === 'private-actor-token' ? [state.role.code] : ['super_admin'],
      permissions: options.token === 'private-actor-token'
        ? menuRows.filter((row) => state.menuIds.includes(row.id)).map((row) => row.permission) : ['*:*:*']
    })
    if (pathname.endsWith('/system/user/profile/get')) return ok({ id: state.userId })
    if (pathname.endsWith('/system/data-permission/coverage')) return ok([{
      tableName: 'erp_sale_order', status: 'NOT_APPLICABLE', ownerRule: 'unit rule'
    }])
    if (pathname.endsWith('/system/menu/list') || pathname.endsWith('/system/menu/list-all-simple')) {
      return ok(menuRows)
    }
    if (pathname.endsWith('/system/role/create')) {
      state.role = { ...body, id: state.roleId, type: 2, dataScope: 5 }
      return ok(state.roleId)
    }
    if (pathname.includes('/system/role/get?')) return ok(state.role
      ? { ...state.role, remark: wrongOwner ? 'unrelated-owner' : state.role.remark } : null)
    if (pathname.endsWith('/assign-role-menu')) {
      assert.equal(body.roleId, state.roleId)
      state.menuIds = [...body.menuIds]
      return ok(true)
    }
    if (pathname.endsWith('/assign-role-data-scope')) {
      assert.equal(body.roleId, state.roleId)
      state.role.dataScope = body.dataScope
      return ok(true)
    }
    if (pathname.includes('/list-role-menus?')) return ok(state.menuIds)
    if (pathname.endsWith('/system/user/create')) {
      secrets.push(body.password)
      if (failUserCreate) return { status: 200, body: { code: 500 } }
      assert.deepEqual(body.roleIds, [state.roleId])
      const { password, ...publicUser } = body
      state.user = { ...publicUser, id: state.userId }
      return ok(state.userId)
    }
    if (pathname.includes('/system/user/get?')) return ok(state.user)
    if (pathname.includes('/list-user-roles?')) return ok([state.roleId])
    if (method === 'DELETE') {
      if (pathname.includes('/system/role/delete?')) {
        if (failRoleDelete) return { status: 200, body: { code: 500 } }
        state.role = null
        state.menuIds = []
      } else if (pathname.includes('/system/user/delete?')) state.user = null
      else assert.fail(`Unexpected deletion ${pathname}`)
      return ok(true)
    }
    const kind = pathname.includes('/erp/sale-order/page?') ? 'page'
      : pathname.includes('/erp/ai-tool/') ? 'tool'
        : pathname.endsWith('/report/go-view/data/get-by-sql') ? 'report' : null
    if (kind) {
      assert.equal(options.token, 'private-actor-token')
      if (state.role.dataScope === 5 && self500 && kind !== 'report') return { status: 200, body: { code: 500 } }
      const allowed = state.menuIds.includes('204')
      const leak = kind === 'tool' ? leakTool : kind === 'report' ? leakReport : false
      const rows = state.role.dataScope === 5 && !(kind === 'report' && leakReport) ? [] : [{
        [kind === 'tool' ? 'orderId' : 'id']: sample.id,
        [kind === 'report' ? 'total_price' : 'totalPrice']: allowed || leak ? Number(sample.amount) : null,
        ...(kind === 'report' ? { create_by: sample.owner } : {})
      }]
      return ok(kind === 'tool' ? rows : kind === 'report' ? { source: rows } : { list: rows, total: rows.length })
    }
    if (pathname.includes('/erp/sale-order/export-excel?')) {
      return { status: 200, body: { code: 500 } }
    }
    assert.fail(`Unmocked request ${method} ${pathname}`)
  }
  const sql = async (query) => {
    if (query.includes('ORDER BY id DESC LIMIT 50')) return {
      available: true, rows: noSample ? [] : [[sample.id, sample.customerId, sample.owner, sample.amount, sample.billNo]]
    }
    if (query.includes("'owned-orders'")) return {
      available: true, rows: [['owned-orders', '0'], ['principal-token', '1']]
    }
    if (query.includes("'owned-role'")) return {
      available: true, rows: [
        ['owned-role', state.roleId, '1', '1', '0'],
        ['owned-user-role', state.userId, state.roleId, '1', '0'],
        ['amount-menu-count', state.menuIds.includes('204') ? '1' : '0']
      ]
    }
    if (query.includes('information_schema.columns')) return {
      available: true, rows: [['ai_agent_runtime_task', 'data_scope_snapshot']]
    }
    if (query.includes("'runtime-task-count'")) return {
      available: true, rows: [['runtime-task-count', '0'], ['model-or-quota-usage', '0']]
    }
    if (query.includes("'active-users'")) return {
      available: true, rows: [
        ['active-users', state.user ? '1' : '0'], ['active-roles', state.role ? '1' : '0'],
        ['active-role-menus', state.menuIds.length ? '1' : '0'], ['active-user-roles', state.role && state.user ? '1' : '0'],
        ['active-tokens', state.actorLoggedIn ? '1' : '0']
      ]
    }
    assert.fail(`Unmocked SQL ${query}`)
  }
  const dependencies = {
    settings, request, sql, tag: 'UNITABC123',
    writeSafety: async () => {},
    headedActor: async ({ credentials }) => {
      assert.equal(credentials.username, state.user.username)
      secrets.push(credentials.password)
      state.actorLoggedIn = true
      return {
        token: 'private-actor-token',
        capture: async () => ({ mounted: true }),
        close: async () => { state.actorClosed = true }
      }
    }
  }
  return {
    calls, secrets, state, record, caseRecord, dependencies,
    run: (overrides = {}) => runCase({ caseRecord, record }, { ...dependencies, ...overrides })
  }
}

test('independent executable exports retain every original catalog assertion exactly', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const original = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'AUTH-DATA-007')
  assert.deepEqual(cases, ['AUTH-DATA-007'])
  assert.deepEqual(catalogAssertions, original.assertions)
  assert.equal(typeof runCase, 'function')
})

test('local target validation blocks remote, credentials-in-URL, tenant2 and wrong database', async () => {
  assert.doesNotThrow(() => assertAiDataLocal(settings))
  for (const extra of [
    { target: 'prod' }, { tenantId: '2' },
    { apiBase: 'https://127.0.0.1:48083' }, { webBase: 'http://remote:9151' },
    { apiBase: 'http://user:password@127.0.0.1:48083' },
    { apiBase: 'http://127.0.0.1:48083/admin-api' },
    { db: { ...settings.db, name: 'cfor_admin_saas_standard' } }
  ]) assert.throws(() => assertAiDataLocal({ ...settings, ...extra }))
  const h = harness()
  await assert.rejects(h.run({ settings: { ...settings, tenantId: '2' } }), /BLOCKED/)
  assert.equal(h.calls.length, 0)
})

test('write safety failure prevents authentication and every role/account write', async () => {
  const h = harness()
  await assert.rejects(h.run({ writeSafety: async () => { throw new Error('BLOCKED: jobs enabled') } }), /BLOCKED/)
  assert.equal(h.calls.length, 0)
})

test('payload uses unique owned names, bounded usernames and one random in-memory password', () => {
  const payload = aiDataPayload('UNITABC123')
  assert.match(payload.marker, /^E2E-AUTH007-/)
  assert.equal(payload.user.remark, payload.role.remark)
  assert.equal(payload.user.remark, payload.marker)
  assert.match(payload.user.username, /^[a-zA-Z0-9]{4,30}$/)
  assert.ok(payload.role.name.length <= 30)
  assert.ok(payload.user.password.length >= 12 && payload.user.password.length <= 16)
  assert.throws(() => aiDataPayload("x';DROP"), /ownership/)
})

test('menu selection grants only read ancestors, excludes amount and requires tenant assignability', () => {
  const selected = selectAiDataMenus(menuRows, menuRows)
  assert.deepEqual(new Set(selected.base), new Set(['201', '202', '203', '205']))
  assert.deepEqual(selected.amountMenuIds, ['204'])
  assert.throws(() => selectAiDataMenus(menuRows, menuRows.filter((row) => row.id !== '204')), /BLOCKED/)
  assert.throws(() => selectAiDataMenus([
    ...menuRows.map((row) => row.id === '201' ? { ...row, parentId: '999' } : row),
    { id: '999', parentId: 0, status: 0, permission: 'system:user:update' }
  ], [...menuRows, { id: '999' }]), /unrelated/)
})

test('ownership checks refuse shared IDs, system roles and mismatched ownership markers', () => {
  const payload = aiDataPayload('UNITABC123')
  const fixture = { roleId: '1101', userId: '1102' }
  const role = { ...payload.role, id: '1101', type: 2 }
  const user = { ...payload.user, id: '1102' }
  assert.doesNotThrow(() => assertOwnedAiRole(role, fixture, payload))
  assert.doesNotThrow(() => assertOwnedAiUser(user, fixture, payload))
  for (const changes of [{ id: '1' }, { type: 1 }, { remark: 'shared' }, { code: 'super_admin' }]) {
    assert.throws(() => assertOwnedAiRole({ ...role, ...changes }, fixture, payload), /ownership mismatch/)
  }
  assert.throws(() => assertOwnedAiUser({ ...user, username: 'admin' }, fixture, payload), /ownership mismatch/)
})

test('fixed SELECT and request allowlist refuse SQL mutation, tenant2, Runtime and paid model routes', () => {
  const sql = aiDataReportSql(sample.id)
  assert.doesNotThrow(() => assertAiDataRequest('POST', '/admin-api/report/go-view/data/get-by-sql', { sql }))
  assert.doesNotThrow(() => assertAiDataRequest('GET', '/admin-api/erp/ai-tool/list/sale-orders?limit=100'))
  for (const query of [
    `${sql}; DELETE FROM erp_sale_order`, sql.replace('tenant_id = 1', 'tenant_id = 2'),
    sql.replace('LIMIT 1', 'LIMIT 100'), 'SELECT * FROM system_users'
  ]) assert.throws(() => assertAiDataRequest('POST', '/admin-api/report/go-view/data/get-by-sql', { sql: query }), /BLOCKED/)
  for (const endpoint of [
    '/admin-api/erp/ai/runtime/tool/execute', '/admin-api/system/ai-desktop/business-tools/execute',
    '/admin-api/system/ai/orchestrator/chat', '/admin-api/system/user/update-password',
    '/admin-api/erp/sale-order/create', 'http://remote/admin-api/system/menu/list'
  ]) assert.throws(() => assertAiDataRequest('POST', endpoint, {}), /BLOCKED/)
  assert.throws(() => aiDataReportSql('1 OR 1=1'))
  assert.throws(() => aiDataReportSql(2107770278182100993))
})

test('response validators do not turn malformed responses, HTTP500 or empty rows into amount PASS', () => {
  assert.equal(aiDataRows({ status: 500, body: { code: 0, data: [] } }, 'tool'), null)
  assert.equal(aiDataRows(ok({ records: [] }), 'page'), null)
  assert.equal(aiDataAmountEvidence([], 'tool', sample, false).verified, false)
  const hidden = aiDataAmountEvidence([{ orderId: sample.id, totalPrice: null }], 'tool', sample, false)
  assert.equal(hidden.passed, true)
  const leaked = aiDataAmountEvidence([{ orderId: sample.id, totalPrice: Number(sample.amount) }], 'tool', sample, false)
  assert.equal(leaked.passed, false)
  assert.equal(leaked.matchesDatabase, true)
  assert.equal(aiDataAmountEvidence([{ orderId: sample.id }], 'tool', sample, false).passed, false)
  assert.equal(aiDataAmountEvidence([{ orderId: sample.id, totalPrice: Number(sample.amount) }], 'tool', sample, true).passed, true)
})

test('transport records metadata only and rejects nonallowlisted requests before fetch', async () => {
  const record = { api: [] }
  let calls = 0
  const request = createAiDataRequest({
    settings, record,
    fetchImpl: async () => {
      calls++
      return new Response(JSON.stringify({
        code: 0, data: { accessToken: 'private-response-token', password: 'private-response-password' }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  const response = await request('POST', '/admin-api/system/auth/login-encrypted', {
    username: 'unit', password: 'private-input-password'
  }, { encrypted: true })
  assert.equal(response.body.data.accessToken, 'private-response-token')
  assert.doesNotMatch(JSON.stringify(record), /private-/)
  assert.equal(record.api[0].code, 0)
  await assert.rejects(request('POST', '/admin-api/system/ai-desktop/business-tools/execute', {}), /BLOCKED/)
  assert.equal(calls, 1)
})

test('full isolated run keeps async/runtime/audit GAPs PARTIAL and always formally cleans fixtures', async () => {
  const h = harness()
  // Avoid unrelated export mocks here; export execution is separately guarded and not claimed complete.
  const withoutExport = menuRows.filter((row) => row.id !== '205')
  const request = async (method, endpoint, body, options) => endpoint.endsWith('/system/menu/list') ||
    endpoint.endsWith('/system/menu/list-all-simple') ? ok(withoutExport) : h.dependencies.request(method, endpoint, body, options)
  const result = await h.run({ request })
  assert.equal(outcome(result, h.caseRecord), 'PARTIAL')
  assert.equal(h.caseRecord.assertionMappings.length, 3)
  assert.ok(h.caseRecord.assertionMappings.every((row) => row.gaps.length > 0))
  assert.ok(h.caseRecord.checks.some((row) => row.name === 'REVOKED tool复用发起人金额权限' && row.passed))
  assert.equal(h.caseRecord.fixtures[0].status, 'deleted')
  assert.equal(h.state.user, null)
  assert.equal(h.state.role, null)
  assert.equal(h.state.actorLoggedIn, false)
  assert.equal(h.state.actorClosed, true)
  for (const secret of h.secrets) assert.equal(JSON.stringify({ ...h.record, caseRecord: h.caseRecord, result }).includes(secret), false)
  assert.ok(h.calls.every((call) => !/\/erp\/sale-order\/(?:create|update)|reset|tenant\/create/.test(call.pathname)))
})

test('realistic Tool amount bypass and SQL row bypass remain FAIL, independent steps and cleanup still run', async () => {
  const h = harness({ leakTool: true, leakReport: true })
  const result = await h.run()
  assert.equal(outcome(result, h.caseRecord), 'FAIL')
  assert.equal(h.caseRecord.assertionMappings[0].status, 'FAIL')
  assert.equal(h.caseRecord.assertionMappings[1].status, 'FAIL')
  assert.ok(h.caseRecord.checks.some((row) => row.name === 'SELF report按发起人范围过滤' && !row.passed))
  assert.ok(h.caseRecord.checks.some((row) => row.name === 'REVOKED tool复用发起人金额权限' && !row.passed))
  assert.equal(h.caseRecord.fixtures[0].status, 'deleted')
  assert.equal(h.state.actorClosed, true)
})

test('SELF backend500 is not treated as successful access denial and does not suppress later evidence', async () => {
  const h = harness({ self500: true })
  const result = await h.run()
  assert.equal(outcome(result, h.caseRecord), 'FAIL')
  assert.ok(h.caseRecord.checks.some((row) => row.name === 'SELF tool真实响应结构' && !row.passed))
  assert.ok(h.caseRecord.checks.some((row) => row.name === 'GRANTED tool复用发起人金额权限' && row.passed))
  assert.equal(h.caseRecord.fixtures[0].status, 'deleted')
})

test('user creation failure immediately retains IDs and deletes already-created owned role', async () => {
  const h = harness({ failUserCreate: true })
  await assert.rejects(h.run(), /user\/create/)
  assert.equal(h.state.role, null)
  assert.equal(h.caseRecord.fixtures[0].roleId, '1101')
  assert.equal(h.caseRecord.fixtures[0].userId, undefined)
  assert.ok(h.calls.some((call) => call.method === 'DELETE' && call.pathname.includes('/system/role/delete?')))
})

test('ownership mismatch forbids every role mutation/delete and records cleanup failure', async () => {
  const h = harness({ wrongOwner: true })
  await assert.rejects(h.run(), /ownership mismatch/)
  assert.equal(h.caseRecord.fixtures[0].status, 'cleanup-failed')
  assert.equal(h.calls.filter((call) => /assign-role|role\/delete|user\/create/.test(call.pathname)).length, 0)
})

test('cleanup failure is FAIL, keeps fixture IDs and never claims deleted', async () => {
  const h = harness({ failRoleDelete: true })
  await assert.rejects(h.run(), /cleanup failed/)
  assert.equal(h.caseRecord.fixtures[0].status, 'cleanup-failed')
  assert.equal(h.caseRecord.fixtures[0].roleId, '1101')
  assert.equal(h.state.actorClosed, true)
  assert.ok(h.caseRecord.checks.some((row) => /正式清理/.test(row.name) && !row.passed))
})

test('no tenant1 nonzero sample is BLOCKED before authentication and creates no fake business facts', async () => {
  const h = harness({ noSample: true })
  await assert.rejects(h.run(), /BLOCKED: no tenant1/)
  assert.equal(h.calls.length, 0)
})

test('headed login failure still deletes the owned account and role without persisting private errors', async () => {
  const h = harness()
  await assert.rejects(h.run({ headedActor: async () => { throw new Error('unit headed failure') } }), /unit headed failure/)
  assert.equal(h.state.role, null)
  assert.equal(h.state.user, null)
})

test('fixture is independent of shared suite and does not enable catalog, models or background tasks', () => {
  const source = fs.readFileSync(new URL('../fixtures/ai-data-permission.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /system-data-permission\.mjs|tracing\.start|fs\.writeFile|system\/config\/update|tenant\/create/)
  assert.match(source, /--headed/)
  assert.match(source, /--execute/)
  assert.match(source, /START|runReadOnlySql/)
})
