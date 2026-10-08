import assert from 'node:assert/strict'
import test from 'node:test'
import {
  supplierAuthFixturePayload, supplierAuthRejected, assertSupplierAuthLocal,
  createSupplierAuthRequest, runSupplierAuth
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
      if (body.refreshToken === 'admin-private-refresh') return result(null, 401)
      const owned = refresh.get(body.refreshToken)
      if (!owned) return result(null, 400)
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
    available: true, rows: query.includes('COUNT(*)')
      ? [[gate ? '1' : '0']] : [[accountId, '3', '1']]
  })
  return {
    caseRecord, record, calls, secrets,
    state: () => ({ partner, account }),
    run: (extra = {}) => runSupplierAuth(
      { caseRecord, record }, { settings, request, sql, tag: 'UNIT_AUTH', ...extra })
  }
}

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
  assert.match(outcome.note, /自然过期 GAP/)
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
