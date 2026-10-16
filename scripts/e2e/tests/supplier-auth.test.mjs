import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  supplierAuthFixturePayload, supplierAuthRejected, assertSupplierAuthLocal,
  browserLogin, createSupplierAuthRequest, runSupplierAuth, observeSupplierWorkbench,
  verifySupplierWorkbench, verifySupplierRefreshTenantIsolation,
  verifyMemberSupplierRefresh, verifySupplierInviteActivation, browserAcceptSupplierInvite
} from '../fixtures/supplier-auth.mjs'

const settings = {
  target: 'local', apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
  tenantId: '1', username: 'unit-admin', password: 'unit-admin-private', requestTimeoutMs: 1000,
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const partnerId = '2107455388355596289'
const accountId = '2107455388355596291'
const result = (data, code = 0) => ({ status: 200, body: { code, data } })

function harness ({ failSummary = false, foreignAccount = false, gate = true } = {}) {
  const caseRecord = { checks: [], evidence: [], notes: [] }
  const record = { api: [], screenshots: [] }
  const calls = []
  const secrets = []
  const access = new Map()
  const refresh = new Map()
  let partner
  let account
  let counter = 0
  const writeSql = async (query) => {
    calls.push({ method: 'SQL-WRITE', pathname: 'local-fixture-sql', query })
    const match = query.match(/refresh_token = '([^']+)'/)
    assert.ok(match, 'expired refresh SQL must scope an exact refresh token')
    const token = match[1]
    const owned = refresh.get(token)
    assert.ok(owned, 'expired refresh SQL must target an owned refresh token')
    owned.expired = true
  }
  const mint = (refreshToken) => {
    const value = {
      accessToken: `supplier-private-access-${++counter}`,
      refreshToken: refreshToken || `supplier-private-refresh-${counter}`,
      userId: accountId, basePartnerId: partnerId, tenantId: '1',
      expiresTime: new Date(Date.now() + 3600000).toISOString()
    }
    secrets.push(value.accessToken, value.refreshToken)
    access.set(value.accessToken, value)
    refresh.set(value.refreshToken, value)
    return value
  }
  const loginError = () => account.status !== 'ENABLED'
    ? 1030620008 : partner.status !== 'ACTIVE' || !partner.supplierEnabled ? 1030620009 : 0
  const request = async (method, pathname, body, options = {}) => {
    calls.push({ method, pathname, body, options })
    if (pathname.endsWith('/system/auth/login-encrypted')) {
      return result({ accessToken: 'admin-private-access', refreshToken: 'admin-private-refresh' })
    }
    if (pathname.endsWith('/base/partner/create')) {
      partner = { ...body, id: partnerId, partnerCode: 'UNIT', customerCode: 'UC', supplierCode: 'US' }
      return result(partnerId)
    }
    if (pathname.includes('/base/partner/get?')) return result({ ...partner })
    if (pathname.endsWith('/base/partner/update')) {
      partner = { ...partner, ...body }
      return result(true)
    }
    if (pathname.endsWith('/supplier-portal/account/create')) {
      assert.equal(body.basePartnerId, partnerId)
      secrets.push(body.password)
      account = { ...body, id: accountId }
      return result(accountId)
    }
    if (pathname.includes('/supplier-portal/account/get?')) {
      return result({ ...account, loginName: foreignAccount ? 'foreign-owner' : account.loginName })
    }
    if (pathname.includes('/supplier-portal/account/status?')) {
      account.status = new URL(`http://local${pathname}`).searchParams.get('status')
      return result(true)
    }
    if (pathname === '/supplier-api/erp/auth/login') {
      const code = loginError()
      return code ? result(null, code) : result(mint())
    }
    if (pathname === '/supplier-api/erp/auth/refresh-token') {
      if (options.tenantId && options.tenantId !== '1') {
        return { ...result(null, 401), body: { code: 401, msg: '刷新令牌租户不匹配' } }
      }
      if (body.refreshToken === 'admin-private-refresh') return result(null, 401)
      const owned = refresh.get(body.refreshToken)
      if (!owned) return result(null, 400)
      if (owned.expired) {
        access.delete(owned.accessToken)
        refresh.delete(body.refreshToken)
        return result(null, 401)
      }
      const code = loginError()
      if (code) return result(null, code)
      access.delete(owned.accessToken)
      return result(mint(owned.refreshToken))
    }
    if (pathname === '/supplier-api/erp/auth/logout') {
      const owned = access.get(options.token)
      if (!owned) return result(null, 401)
      access.delete(owned.accessToken)
      refresh.delete(owned.refreshToken)
      return result(true)
    }
    if (pathname.endsWith('/system/auth/get-permission-info')) {
      return options.token === 'admin-private-access' ? result({}) : result(null, 403)
    }
    if (pathname.endsWith('/workbench/summary')) {
      if (options.token === 'admin-private-access') return result(null, 1030620010)
      if (failSummary && access.has(options.token)) return result(null, 500)
      return access.has(options.token) ? result({ basePartnerId: partnerId }) : result(null, 401)
    }
    if (pathname.endsWith('/system/auth/logout')) return result(true)
    throw new Error(`Unexpected unit path: ${pathname}`)
  }
  const sql = async (query) => ({
    available: true, rows: query.includes('SELECT t.id FROM system_tenant t')
      ? [['2108347281128759297']]
      : query.includes("SELECT 'access',id")
        ? [
            ['access', '100', accountId, '3', '1', 'safe-access-hash', 'safe-refresh-hash', '2026-11-01'],
            ['refresh', '101', accountId, '3', '1', '', 'safe-refresh-hash', '2026-11-01']
          ]
        : query.includes('COUNT(*)')
      ? query.includes('MAX(expires_time)')
        ? [['1', '2000-01-01 00:00:00']]
        : query.includes('refresh_token')
          ? [['0']]
          : [[gate ? '1' : '0']]
      : [[accountId, '3', '1']]
  })
  return {
    caseRecord, record, calls, secrets,
    state: () => ({ partner, account }),
    run: (extra = {}) => runSupplierAuth(
      { caseRecord, record },
      { settings, request, sql, writeSql, tag: 'UNIT_AUTH', memberCredentials: null, ...extra })
  }
}

test('PROC-010 wrong-tenant refresh preserves exact SQL token facts and the original session', async () => {
  const h = harness()
  await h.run()
  const probe = h.calls.find((call) => call.options?.tenantId === '2108347281128759297')
  assert.equal(probe.pathname, '/supplier-api/erp/auth/refresh-token')
  assert.equal(probe.options.token, undefined)
  for (const name of [
    'tenant-id 不匹配 refresh 精确拒绝',
    '跨租户 refresh 拒绝前后原 access/refresh 完整事实不变',
    '跨租户 refresh 拒绝后原 supplier 会话仍有效'
  ]) assert.equal(h.caseRecord.checks.find((check) => check.name === name)?.passed, true)
})

test('PROC-010 alternate tenant header is confined to the anonymous refresh rejection', async () => {
  const headers = []
  const request = createSupplierAuthRequest({
    settings,
    fetchImpl: async (_url, options) => {
      headers.push(options.headers)
      return new Response(JSON.stringify({ code: 401, msg: '刷新令牌租户不匹配' }))
    }
  })
  for (const [method, pathname, options] of [
    ['POST', '/supplier-api/erp/auth/login', { tenantId: '2' }],
    ['GET', '/supplier-api/erp/workbench/summary', { tenantId: '2' }],
    ['POST', '/supplier-api/erp/auth/refresh-token', { tenantId: '2', token: 'owned' }],
    ['POST', '/supplier-api/erp/auth/refresh-token', { tenantId: 'NaN' }],
    ['POST', '/supplier-api/erp/auth/refresh-token', { tenantId: Number.MAX_SAFE_INTEGER + 1 }]
  ]) await assert.rejects(request(method, pathname, {}, options), /alternate tenant/)
  assert.equal(headers.length, 0)
  await request('POST', '/supplier-api/erp/auth/refresh-token', {}, { tenantId: '2' })
  assert.equal(headers[0]['tenant-id'], '2')
  assert.equal(headers[0].Authorization, undefined)
})

test('PROC-010 tenant refresh cannot certify early gate failures, source drift or lost sessions', async () => {
  const supplier = {
    userId: accountId, tenantId: '1', basePartnerId: partnerId,
    accessToken: 'private-access', refreshToken: 'private-refresh'
  }
  for (const fault of ['wrong-error', 'changed-facts', 'missing-access', 'lost-session']) {
    let snapshots = 0
    const caseRecord = { notes: [], checks: [] }
    const check = (name, passed) => {
      caseRecord.checks.push({ name, passed })
      assert.ok(passed, name)
    }
    const probe = () => verifySupplierRefreshTenantIsolation({
      accountId, supplier, caseRecord, check,
      sql: async (query) => {
        if (query.includes('SELECT t.id FROM system_tenant t')) {
          return { available: true, rows: [['2108347281128759297']] }
        }
        const rows = [
          ['access', '100', accountId, '3', '1', 'hash', 'refresh-hash', '2026-11-01'],
          ['refresh', '101', accountId, '3', '1', '', 'refresh-hash', '2026-11-01']
        ]
        if (fault === 'missing-access') rows.shift()
        if (fault === 'changed-facts' && snapshots++ > 0) rows[0][1] = 'new-access-id'
        return { available: true, rows }
      },
      request: async (_method, pathname) => {
        if (pathname.endsWith('/summary')) {
          return fault === 'lost-session' ? result(null, 401) : result({ basePartnerId: partnerId })
        }
        return {
          status: 200,
          body: { code: 401, msg: fault === 'wrong-error' ? '访问令牌不存在' : '刷新令牌租户不匹配' }
        }
      }
    })
    if (fault === 'lost-session') {
      assert.equal(await probe(), false)
      assert.equal(caseRecord.checks.at(-1).passed, false)
    } else {
      await assert.rejects(probe())
      assert.equal(caseRecord.database, undefined)
    }
  }
})

test('PROC-010 missing alternate portal tenant stays GAP without requests or policy writes', async () => {
  const caseRecord = { notes: [], checks: [] }
  assert.equal(await verifySupplierRefreshTenantIsolation({
    accountId,
    supplier: { userId: accountId, tenantId: '1', accessToken: 'private', refreshToken: 'private' },
    caseRecord,
    check: () => assert.fail('no evidence may be certified'),
    request: () => assert.fail('no request without a valid target'),
    sql: async () => ({ available: true, rows: [] })
  }), false)
  assert.match(caseRecord.notes[0], /GAP/)
})

test('PROC-010 direct-password fixture has no external contact', () => {
  const payload = supplierAuthFixturePayload('UNIT_AUTH')
  assert.equal(payload.partner.customerEnabled, true)
  assert.equal(payload.partner.supplierEnabled, true)
  assert.equal(payload.account.status, 'ENABLED')
  assert.equal(payload.account.contactEmail, '')
  assert.match(payload.account.loginName, /^e2e_proc010_/)
  assert.ok(payload.account.password.length >= 8)
})

test('PROC-010 exact rejection disallows 500/404 and unrelated business failures', () => {
  for (const status of [200, 400, 401, 403]) {
    assert.equal(supplierAuthRejected({ status, body: { code: 1030620008 } }, [1030620008]), true)
  }
  for (const status of [404, 500]) {
    assert.equal(supplierAuthRejected({ status, body: { code: 1030620008 } }, [1030620008]), false)
  }
  assert.equal(supplierAuthRejected(result(null, 500), [1030620008]), false)
  assert.equal(supplierAuthRejected(result(null, 1030620009), [1030620008]), false)
  assert.equal(supplierAuthRejected(result(null), [0]), false)
})

test('PROC-010 expiry probe scopes a local SQL mutation to the owned supplier refresh token', async () => {
  const h = harness()
  await h.run()
  const writes = h.calls.filter((call) => call.method === 'SQL-WRITE')
  assert.equal(writes.length, 1)
  assert.match(writes[0].query, /system_oauth2_refresh_token/)
  assert.match(writes[0].query, /user_id = 2107455388355596291/)
  assert.match(writes[0].query, /user_type = 3/)
  assert.match(writes[0].query, /tenant_id = 1/)
  assert.ok(h.caseRecord.checks.some((check) =>
    check.name === '自然过期 refresh 拒绝' && check.passed))
  assert.ok(h.caseRecord.checks.some((check) =>
    check.name === '自然过期 refresh 被正式 API 清理' && check.passed))
})

test('PROC-010 rejects nonlocal endpoint, tenant, database before requests', async () => {
  assert.doesNotThrow(() => assertSupplierAuthLocal(settings))
  for (const override of [
    { target: 'prod' }, { tenantId: '2' }, { apiBase: 'http://remote:48083' },
    { webBase: 'http://localhost:9152' }, { db: { ...settings.db, name: 'other' } }
  ]) assert.throws(() => assertSupplierAuthLocal({ ...settings, ...override }))
  const h = harness()
  await assert.rejects(runSupplierAuth(h, {
    settings: { ...settings, tenantId: '2' }, request: () => assert.fail('request forbidden')
  }), /BLOCKED/)
})

test('PROC-010 runs all isolated auth transitions and retains disabled owned facts', async () => {
  const h = harness()
  const outcome = await h.run()
  assert.equal(outcome.partial, true)
  assert.match(outcome.note, /refresh 到期拒绝及关联令牌撤销已验证/)
  assert.doesNotMatch(outcome.note, /自然过期 GAP/)
  assert.equal(h.state().account.status, 'DISABLED')
  assert.equal(h.state().partner.status, 'INACTIVE')
  assert.equal(h.state().partner.supplierEnabled, false)
  for (const name of [
    'supplier token 不可访问 admin-api', 'admin refresh 不可通过 supplier refresh',
    'logout 后 access 失效', 'logout 后 refresh 失效',
    '账号停用后登录拒绝', '账号停用后refresh拒绝',
    'partner停用后登录拒绝', 'partner停用后refresh拒绝',
    '供应商角色停用后登录拒绝', '供应商角色停用后refresh拒绝'
  ]) assert.ok(h.caseRecord.checks.some((item) => item.name === name && item.passed), name)
  const evidence = JSON.stringify({ ...h.record, caseRecord: h.caseRecord, outcome })
  for (const secret of [...h.secrets, settings.password, 'admin-private-access', 'admin-private-refresh']) {
    assert.equal(evidence.includes(secret), false)
  }
  assert.equal(h.caseRecord.fixtures[0].accountId, accountId)
  assert.equal(h.caseRecord.fixtures[0].partnerId, partnerId)
  assert.ok(h.calls.every((call) => !/invite|mapping|oauth2\/client|reset-password/.test(call.pathname)))
})

test('PROC-010 workbench failure remains FAIL while independent auth tests and cleanup complete', async () => {
  const h = harness({ failSummary: true })
  await h.run()
  assert.ok(h.caseRecord.checks.some((check) =>
    check.name === 'supplier token 可访问自身工作台' && check.passed === false))
  assert.ok(h.caseRecord.checks.some((check) =>
    check.name === '供应商角色停用后refresh拒绝' && check.passed))
  assert.equal(h.state().account.status, 'DISABLED')
  assert.equal(h.state().partner.status, 'INACTIVE')
  assert.equal(h.caseRecord.fixtures[0].accountId, accountId)
  assert.ok(h.calls.some((call) => call.pathname === '/admin-api/system/auth/logout'))
})

test('PROC-010 ownership mismatch forbids account mutation and records cleanup failure', async () => {
  const h = harness({ foreignAccount: true })
  await assert.rejects(h.run(), /ownership mismatch/)
  assert.ok(h.calls.every((call) => !call.pathname.includes('/account/status?')))
  assert.equal(h.caseRecord.fixtures[0].status, 'cleanup-failed')
  assert.ok(h.caseRecord.checks.some((check) => check.passed === false))
})

test('PROC-010 disabled shared gate makes no authentication or mutation request', async () => {
  const h = harness({ gate: false })
  await assert.rejects(h.run(), /BLOCKED/)
  assert.equal(h.calls.length, 0)
})

test('PROC-010 missing headed supplier mount stays explicit GAP, not false UI PASS', async () => {
  const h = harness()
  const outcome = await h.run({ browserLogin: async () => null })
  assert.equal(h.caseRecord.fixtures[0].headedLogin, 'GAP')
  assert.match(outcome.note, /headed登录入口 GAP/)
  assert.equal(h.state().account.status, 'DISABLED')
})

test('PROC-010 headed failure still records IDs and disables owned prerequisites', async () => {
  const h = harness()
  await assert.rejects(h.run({ browserLogin: async () => { throw new Error('unit headed failure') } }),
    /unit headed failure/)
  assert.equal(h.caseRecord.fixtures[0].accountId, accountId)
  assert.equal(h.state().account.status, 'DISABLED')
  assert.equal(h.state().partner.status, 'INACTIVE')
})

test('PROC-010 transport stores only safe response metadata, never raw payload', async () => {
  const record = { api: [] }
  const request = createSupplierAuthRequest({
    record, settings,
    fetchImpl: async () => new Response(JSON.stringify({
      code: 0, data: { accessToken: 'secret-access', refreshToken: 'secret-refresh', password: 'secret-password' }
    }), { status: 200 })
  })
  const response = await request('POST', '/supplier-api/erp/auth/login', { password: 'secret-input' })
  assert.equal(response.body.data.accessToken, 'secret-access')
  assert.deepEqual(record.api, [{
    method: 'POST', pathname: '/supplier-api/erp/auth/login', status: 200, code: 0
  }])
  assert.doesNotMatch(JSON.stringify(record), /secret/)
})

test('PROC-010 headed diagnostics identify a failed phase without leaking Playwright fill values', async () => {
  const secret = 'private-password-and-call-log'
  const record = { api: [], screenshots: [] }
  let closed = false
  const isolated = {
    setDefaultTimeout () {},
    goto: async () => {},
    locator: (selector) => selector === '#supplier-app'
      ? { count: async () => 1 }
      : { fill: async () => { throw new Error(secret) } },
    evaluate: async () => [[null, null], [null, null]],
    screenshot: async () => {}
  }
  const context = {
    route: async () => {},
    newPage: async () => isolated,
    close: async () => { closed = true }
  }
  const page = { context: () => ({ browser: () => ({ newContext: async () => context }) }) }
  await assert.rejects(browserLogin({
    page, payload: { loginName: 'unit', password: secret },
    capture () {}, check () {}, record, outputDir: '/tmp/unit-supplier'
  }), (error) => {
    assert.match(error.message, /fill-login-form \(error\)/)
    assert.equal(error.message.includes(secret), false)
    return true
  })
  assert.equal(closed, true)
  assert.deepEqual(record.api, [{
    method: 'UI', pathname: 'supplier-login', phase: 'fill-login-form', kind: 'error'
  }])
  assert.equal(record.screenshots.length, 1)
  assert.equal(JSON.stringify(record).includes(secret), false)
})

function workbenchHarness ({ failSummary = false, loadingFailure = false, wrongAmount = false } = {}) {
  const paths = [
    '/supplier-api/erp/workbench/summary',
    '/supplier-api/erp/notify/unread-count',
    '/supplier-api/erp/notify/unread-list'
  ]
  const values = [
    { basePartnerId: partnerId, totalTransactionAmount: 1234.56, receivableBalance: 800,
      pendingCollectionAmount: 600, auditedOrderCount: 3 },
    0,
    []
  ]
  const record = { api: [] }
  const checks = []
  const events = []
  const page = {
    waitForResponse: async (predicate) => {
      const pathname = paths.find((value) => predicate({
        url: () => `http://127.0.0.1:9151${value}?size=10`,
        request: () => ({ method: () => 'GET' })
      }))
      assert.ok(pathname)
      return {
        allHeaders: async () => ({}),
        status: () => 200,
        text: async () => JSON.stringify({
          code: failSummary && pathname === paths[0] ? 500 : 0,
          data: values[paths.indexOf(pathname)]
        })
      }
    },
    locator: (selector) => ({
      first () { return this },
      waitFor: async () => { events.push('visible') },
      allTextContents: async () => {
        events.push('read-data')
        if (selector.includes('message-main')) return []
        return [
          wrongAmount ? '¥0.00' : '¥1,234.56', '¥800.00', '¥600.00', '3 笔',
          '0 笔', '0 笔', '0 行', '0 笔', '0 笔'
        ]
      }
    }),
    waitForFunction: async () => {
      events.push('loading-hidden')
      if (loadingFailure) throw new Error('loading timeout')
    },
    getByText: () => ({ waitFor: async () => { events.push('empty-visible') } })
  }
  const check = (name, passed) => {
    checks.push({ name, passed })
    assert.equal(passed, true, name)
  }
  return {
    page, record, checks, events,
    verify: async () => verifySupplierWorkbench({
      page, responses: await observeSupplierWorkbench(page), partnerId, check, record
    })
  }
}

test('PROC-010 headed workbench waits for all real APIs and loading before checking rendered data', async () => {
  const h = workbenchHarness()
  await h.verify()
  assert.equal(h.record.api.length, 3)
  assert.ok(h.events.indexOf('loading-hidden') < h.events.indexOf('read-data'))
  assert.equal(h.events.at(-1), 'empty-visible')
  assert.equal(h.checks.length, 6)
  assert.ok(h.checks.every((value) => value.passed))
  assert.doesNotMatch(JSON.stringify(h.record), /1234|basePartnerId|accessToken/)
})

test('PROC-010 headed workbench cannot pass on an HTTP 200 business failure', async () => {
  const h = workbenchHarness({ failSummary: true })
  await assert.rejects(h.verify(), /headed 工作台接口成功/)
  assert.equal(h.events.includes('read-data'), false)
})

test('PROC-010 headed workbench cannot pass or screenshot a pending loading state', async () => {
  const h = workbenchHarness({ loadingFailure: true })
  await assert.rejects(h.verify(), /loading timeout/)
  assert.equal(h.events.includes('read-data'), false)
})

test('PROC-010 headed workbench rejects placeholder amounts after API success', async () => {
  const h = workbenchHarness({ wrongAmount: true })
  await assert.rejects(h.verify(), /九项统计与真实接口一致/)
})

const memberId = '2107455388355596293'
const sha = (value) => createHash('sha256').update(value).digest('hex')

function memberHarness (fault = '') {
  const credentials = { userId: memberId, mobile: '19900000010', password: 'unit-private' }
  const member = {
    userId: memberId, accessToken: 'unit-member-private-access',
    refreshToken: 'unit-member-private-refresh',
    expiresTime: new Date(Date.now() + 3600000).toISOString()
  }
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const calls = []
  let snapshots = 0
  const sql = async (query) => {
    calls.push({ query })
    assert.match(query.trim(), /^SELECT /)
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER)\b/i)
    if (query.includes('FROM member_user')) {
      assert.match(query, /nickname='E2E-PROC010-MEMBER'/)
      assert.match(query, /tenant_id=1.*deleted=0.*status=0/)
      return { available: true, rows: fault === 'foreign-member' ? [] : [[memberId, '1', '0']] }
    }
    assert.ok(query.includes(sha(member.refreshToken)))
    assert.ok(!query.includes(member.refreshToken))
    const rows = [
      ['access', '100', memberId, '1', '1', sha(member.accessToken), sha(member.refreshToken), '2026-12-01'],
      ['refresh', '101', memberId, '1', '1', '', sha(member.refreshToken), '2026-12-01']
    ]
    if (['admin-type', 'supplier-type'].includes(fault)) {
      for (const row of rows) row[3] = fault === 'admin-type' ? '2' : '3'
    }
    if (fault === 'wrong-tenant') for (const row of rows) row[4] = '2'
    if (fault === 'wrong-token') rows[0][5] = sha('different-token')
    if (fault === 'missing-access') rows.shift()
    if (fault === 'drift' && snapshots > 0) rows[0][7] = '2026-12-02'
    snapshots++
    return { available: fault !== 'no-sql', rows }
  }
  const request = async (method, pathname, body, options = {}) => {
    calls.push({ method, pathname, body, options })
    if (pathname === '/app-api/member/auth/login') {
      assert.deepEqual(body, { mobile: credentials.mobile, password: credentials.password })
      return fault === 'login-failed' ? result(null, 401) : result(member)
    }
    if (pathname === '/supplier-api/erp/auth/refresh-token') {
      assert.equal(options.token, undefined)
      assert.equal(body.refreshToken, member.refreshToken)
      if (fault === 'secret-error') throw new Error(member.refreshToken)
      return {
        status: fault === 'http500' ? 500 : 200,
        body: {
          code: fault === 'accepted' ? 0 : 401,
          msg: fault === 'unrelated401' ? '刷新令牌租户不匹配' : '刷新令牌用户类型不匹配'
        }
      }
    }
    if (pathname === '/app-api/member/user/get') {
      assert.equal(options.token, member.accessToken)
      return fault === 'lost-session' ? result(null, 401)
        : result({ id: fault === 'wrong-profile' ? accountId : memberId })
    }
    if (pathname === '/app-api/member/auth/logout') {
      assert.equal(options.token, member.accessToken)
      return result(true, fault === 'cleanup-failed' ? 500 : 0)
    }
    assert.fail(`Unexpected unit Member request: ${method} ${pathname}`)
  }
  const check = (name, passed) => {
    caseRecord.checks.push({ name, passed })
    assert.equal(passed, true, name)
  }
  return {
    credentials, member, calls, caseRecord,
    run: (extra = {}) => verifyMemberSupplierRefresh({
      credentials, request, sql, caseRecord, check, settings, ...extra
    })
  }
}

test('PROC-010 Member rejection uses a fresh password login and exact real-principal SQL evidence', async () => {
  const h = memberHarness()
  assert.equal(await h.run(), true)
  assert.deepEqual(h.calls.filter((call) => call.pathname).map((call) => call.pathname), [
    '/app-api/member/auth/login', '/supplier-api/erp/auth/refresh-token',
    '/app-api/member/user/get', '/app-api/member/auth/logout'
  ])
  assert.equal(h.caseRecord.database.length, 2)
  assert.equal(h.caseRecord.checks.length, 7)
  assert.ok(h.caseRecord.checks.every((check) => check.passed === true))
  const evidence = JSON.stringify(h.caseRecord)
  for (const secret of [h.credentials.mobile, h.credentials.password,
    h.member.accessToken, h.member.refreshToken]) assert.equal(evidence.includes(secret), false)
})

test('PROC-010 missing/invalid Member credentials make no requests, SQL writes or synthetic tokens', async () => {
  for (const credentials of [null, {}, { userId: memberId, mobile: 'invalid', password: 'private' },
    { userId: '1 OR 1=1', mobile: '19900000010', password: 'private' }]) {
    const h = memberHarness()
    assert.equal(await h.run({ credentials }), false)
    assert.equal(h.calls.length, 0)
    assert.equal(h.caseRecord.checks.length, 0)
    assert.match(h.caseRecord.notes[0], /GAP/)
  }
  const foreign = memberHarness('foreign-member')
  assert.equal(await foreign.run(), false)
  assert.equal(foreign.calls.filter((call) => call.pathname).length, 0)
  assert.match(foreign.caseRecord.notes[0], /不操作共享会员/)
})

test('PROC-010 Member probe never sends a forged/admin/supplier principal to the refresh rejection', async () => {
  for (const fault of ['admin-type', 'supplier-type', 'wrong-tenant', 'wrong-token',
    'missing-access', 'no-sql', 'login-failed']) {
    const h = memberHarness(fault)
    await assert.rejects(h.run(), /authentication details withheld/)
    assert.ok(!h.calls.some((call) => call.pathname === '/supplier-api/erp/auth/refresh-token'), fault)
    assert.equal(h.caseRecord.database, undefined)
  }
})

test('PROC-010 Member refresh rejects unrelated 401, HTTP500, acceptance, drift or lost source session', async () => {
  for (const fault of ['unrelated401', 'http500', 'accepted', 'drift', 'lost-session',
    'wrong-profile', 'secret-error', 'cleanup-failed']) {
    const h = memberHarness(fault)
    await assert.rejects(h.run(), (error) => {
      assert.match(error.message, /authentication details withheld/)
      assert.ok(!error.message.includes(h.member.refreshToken))
      return true
    })
    assert.equal(h.calls.at(-1).pathname, '/app-api/member/auth/logout', fault)
    assert.ok(!h.caseRecord.checks.some((check) =>
      check.name === 'Member refresh 不可通过 supplier refresh 精确拒绝' && check.passed &&
      ['unrelated401', 'http500', 'accepted'].includes(fault)))
  }
})

test('PROC-010 integrated auth keeps missing invite and Member prerequisites explicitly GAP', async () => {
  const h = harness()
  await h.run()
  assert.equal(h.caseRecord.fixtures[0].invitation, 'GAP')
  assert.equal(h.caseRecord.fixtures[0].memberRefresh, 'GAP')
  assert.ok(h.caseRecord.notes.some((note) => /Member refresh GAP/.test(note)))
  assert.ok(h.caseRecord.notes.some((note) => /invitation GAP/.test(note)))
  assert.ok(!h.calls.some((call) => /member|accept-invite|\/invite/.test(call.pathname)))
})

const inviteAccountId = '2107455388355596295'
const inviteToken = '0123456789abcdef0123456789abcdef'
const inviteLoginName = 'e2e_proc010_invite_unit_auth'
const inviteUrl = `${settings.webBase}/supplier/accept-invite?tenantId=1&token=${inviteToken}`

function inviteHarness (fault = '') {
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const record = { api: [], screenshots: [] }
  const queries = []
  const calls = []
  let status = 'INVITED'
  const check = (name, passed) => {
    caseRecord.checks.push({ name, passed })
    assert.equal(passed, true, name)
  }
  const sql = async (query) => {
    queries.push(query)
    assert.match(query.trim(), /^SELECT /)
    if (query.includes('SELECT a.id,l.id')) {
      assert.match(query, /FROM supplier_portal_account a/)
      assert.match(query, /l.send_status=30/)
      assert.match(query, /l.create_time>=a.create_time/)
      assert.match(query, /a.tenant_id=1/)
      assert.match(query, /a.base_partner_id=2107455388355596289/)
      assert.match(query, /E2E-PROC010-SUPPLIER-UNIT_AUTH/)
      assert.match(query, /a.login_name='e2e_proc010_invite_unit_auth'/)
      if (fault === 'no-source') return { available: true, rows: [] }
      if (fault === 'duplicate-source') return { available: true, rows: [[], []] }
      return { available: true, rows: [[inviteAccountId, '301',
        fault === 'external-url' ? inviteUrl.replace('127.0.0.1', 'remote.invalid')
          : fault === 'hash-token' ? inviteUrl.replace(inviteToken, sha(inviteToken))
            : fault === 'wrong-tenant' ? inviteUrl.replace('tenantId=1', 'tenantId=2')
              : inviteUrl]] }
    }
    if (query.includes('AND invite_token=')) {
      assert.ok(query.includes(sha(inviteToken)))
      assert.ok(!query.includes(inviteToken))
      return { available: true, rows: fault === 'hash-mismatch' ? [] : [[inviteAccountId]] }
    }
    assert.match(query, /SELECT id,status,\(invite_token=''\)/)
    return { available: true, rows: [[inviteAccountId, 'ENABLED',
      fault === 'unconsumed-token' ? '0' : '1']] }
  }
  const activate = async ({ inviteUrl: url, loginName, password }) => {
    calls.push({ kind: 'activate' })
    assert.equal(url, inviteUrl)
    assert.equal(loginName, inviteLoginName)
    assert.ok(password.length >= 8)
    if (fault === 'ui-failure') throw new Error(inviteToken)
    return fault !== 'missing-mount'
  }
  const adminCall = async (method, pathname) => {
    calls.push({ method, pathname })
    if (method === 'PUT') {
      assert.equal(pathname,
        `/erp/supplier-portal/account/status?id=${inviteAccountId}&status=DISABLED`)
      status = 'DISABLED'
      return true
    }
    return {
      id: inviteAccountId, basePartnerId: partnerId,
      loginName: fault === 'foreign-cleanup' ? 'foreign-owner' : inviteLoginName, status
    }
  }
  return {
    caseRecord, record, queries, calls,
    run: (extra = {}) => verifySupplierInviteActivation({
      page: {}, sql, check, caseRecord, record, tag: 'UNIT_AUTH', partnerId, settings,
      activate, adminCall, ...extra
    })
  }
}

test('PROC-010 invite consumes only a current-run genuine ignored-mail token, then disables its owned account', async () => {
  const h = inviteHarness()
  assert.equal(await h.run(), true)
  assert.equal(h.queries.length, 3)
  assert.ok(h.caseRecord.checks.every((check) => check.passed === true))
  assert.equal(h.calls.filter((call) => call.method === 'PUT').length, 1)
  assert.ok(h.caseRecord.evidence[0].includes(`inviteAccountId=${inviteAccountId}`))
  assert.ok(!JSON.stringify({ caseRecord: h.caseRecord, record: h.record }).includes(inviteToken))
  assert.ok(!h.calls.some((call) => /\/invite(?:\?|$)|reset-password|mail\/.*send/.test(call.pathname)))
})

test('PROC-010 absent or ambiguous invitation stays GAP without mail, activation or policy writes', async () => {
  for (const fault of ['no-source', 'duplicate-source']) {
    const h = inviteHarness(fault)
    assert.equal(await h.run(), false)
    assert.equal(h.calls.length, 0)
    assert.equal(h.caseRecord.checks.length, 0)
    assert.match(h.caseRecord.notes[0], /GAP.*MailSendApi.*不发送外部邮件/)
  }
  const h = inviteHarness()
  assert.equal(await h.run({ page: null }), false)
  assert.equal(h.queries.length, 0)
})

test('PROC-010 invite rejects foreign URL/tenant, hash-as-token and mismatched stored hash before UI', async () => {
  for (const fault of ['external-url', 'wrong-tenant', 'hash-token', 'hash-mismatch']) {
    const h = inviteHarness(fault)
    await assert.rejects(h.run(), /authentication details withheld/)
    assert.equal(h.calls.length, 0, fault)
  }
})

test('PROC-010 invite cannot pass missing UI mount, unconsumed token, failed UI or foreign cleanup', async () => {
  for (const fault of ['missing-mount', 'unconsumed-token', 'ui-failure', 'foreign-cleanup']) {
    const h = inviteHarness(fault)
    if (fault === 'missing-mount') {
      assert.equal(await h.run(), false)
      assert.match(h.caseRecord.notes[0], /UI GAP/)
    } else await assert.rejects(h.run(), /authentication details withheld/)
    assert.equal(h.calls.filter((call) => call.method === 'PUT').length,
      fault === 'foreign-cleanup' ? 0 : 1, fault)
  }
})

function inviteBrowserHarness (fault = '') {
  const record = { api: [], screenshots: [] }
  const checks = []
  const events = []
  let guard
  const check = (name, passed) => {
    checks.push({ name, passed })
    assert.equal(passed, true, name)
  }
  const isolated = {
    setDefaultTimeout () {},
    goto: async () => { events.push('navigate') },
    locator: (selector) => ({
      count: async () => fault === 'missing-mount' ? 0 : 1,
      nth () { return this },
      fill: async () => {
        events.push('fill')
        if (fault === 'secret-error') throw new Error(inviteToken)
      },
      click: async () => { events.push('submit') },
      inputValue: async () => {
        assert.match(selector, /autocomplete="username"/)
        return fault === 'wrong-prefill' ? '' : inviteLoginName
      }
    }),
    waitForResponse: async (predicate) => {
      assert.equal(predicate({
        url: () => `${settings.apiBase}/supplier-api/erp/auth/accept-invite`,
        request: () => ({ method: () => 'POST' })
      }), true)
      return {
        status: () => 200,
        allHeaders: async () => ({}),
        text: async () => JSON.stringify({
          code: fault === 'business-failed' ? 500 : 0, data: inviteLoginName
        }),
        request: () => ({
          allHeaders: async () => ({
            'tenant-id': fault === 'wrong-tenant' ? '2' : '1',
            'x-api-encrypt': fault === 'unencrypted' ? 'false' : 'true'
          })
        })
      }
    },
    waitForURL: async (predicate) => {
      assert.equal(predicate(new URL(`${settings.webBase}/supplier/login?tenantId=1&loginName=${inviteLoginName}`)), true)
      assert.equal(predicate(new URL(`${settings.webBase}/supplier/workbench`)), false)
      events.push('redirect')
      if (fault === 'no-redirect') throw new Error('unit redirect timeout')
    },
    screenshot: async () => { events.push('screenshot') }
  }
  const context = {
    route: async (_pattern, handler) => { guard = handler },
    newPage: async () => isolated,
    close: async () => { events.push('closed') }
  }
  const page = { context: () => ({ browser: () => ({ newContext: async () => context }) }) }
  return {
    record, checks, events,
    route: (url) => {
      let outcome
      guard({
        request: () => ({ url: () => url }),
        continue: () => { outcome = 'continue' },
        abort: () => { outcome = 'abort' }
      })
      return outcome
    },
    run: (extra = {}) => browserAcceptSupplierInvite({
      page, inviteUrl, loginName: inviteLoginName, password: 'unit-private-password',
      check, record, outputDir: '/tmp/unit-only-no-browser', settings, ...extra
    })
  }
}

test('PROC-010 invitation headed contract observes encryption/tenant, redirect and actual prefill in an isolated context', async () => {
  const h = inviteBrowserHarness()
  assert.equal(await h.run(), true)
  assert.equal(h.checks.length, 3)
  assert.ok(h.checks.every((check) => check.passed === true))
  assert.ok(h.events.indexOf('redirect') < h.events.indexOf('screenshot'))
  assert.equal(h.events.at(-1), 'closed')
  assert.equal(h.route(`${settings.apiBase}/supplier-api/erp/auth/accept-invite`), 'continue')
  assert.equal(h.route('https://remote.invalid/mail'), 'abort')
  assert.ok(!JSON.stringify(h.record).includes(inviteToken))
})

test('PROC-010 invitation headed contract never turns HTTP200 or missing UI details into PASS', async () => {
  for (const fault of ['wrong-tenant', 'unencrypted', 'business-failed', 'no-redirect',
    'wrong-prefill', 'secret-error']) {
    const h = inviteBrowserHarness(fault)
    await assert.rejects(h.run(), (error) => {
      assert.match(error.message, /authentication details withheld/)
      assert.ok(!error.message.includes(inviteToken))
      return true
    })
    assert.ok(!h.events.includes('screenshot'), fault)
    assert.equal(h.events.at(-1), 'closed')
  }
  const missing = inviteBrowserHarness('missing-mount')
  assert.equal(await missing.run(), false)
  assert.ok(!missing.events.includes('submit'))
  const remote = inviteBrowserHarness()
  await assert.rejects(remote.run({ inviteUrl: inviteUrl.replace('127.0.0.1', 'remote.invalid') }))
  assert.ok(!remote.events.includes('navigate'))
})
