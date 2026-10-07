import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  runCase, supplierAuthRejected, supplierBlocker, supplierCredentials,
  supplierEntryFacts, supplierPageRows, supplierSession, supplierSessionKey
} from '../suites/supplier-portal.mjs'
import { caseErrorStatus, caseOutcome } from '../lib/report.mjs'

const caseId = 'PB150-OUTSOURCE-PORTAL-001'
const now = Date.parse('2026-10-06T00:00:00Z')
const login = {
  code: 0,
  data: {
    accessToken: 'unit-supplier-access', refreshToken: 'unit-supplier-refresh',
    expiresTime: '2026-10-07T00:00:00Z', tenantId: '1',
    userId: '2106200343998562305', basePartnerId: '2106200343998562306', partnerName: 'Supplier'
  }
}

test('supplier credentials never fall back to admin username or password', () => {
  assert.equal(supplierCredentials({ CFOR_USERNAME: 'admin', CFOR_PASSWORD: 'admin123' }), null)
  assert.equal(supplierCredentials({ CFOR_SUPPLIER_USERNAME: 'supplier', CFOR_PASSWORD: 'admin123' }), null)
  assert.deepEqual(supplierCredentials({
    CFOR_SUPPLIER_USERNAME: ' supplier ', CFOR_SUPPLIER_PASSWORD: ' password '
  }), { loginName: 'supplier', password: ' password ' })
})

test('supplier session preserves string Snowflake IDs and normalizes actual expiry', () => {
  const session = supplierSession(login, '1', now)
  assert.equal(session.userId, login.data.userId)
  assert.equal(session.basePartnerId, login.data.basePartnerId)
  assert.equal(session.expiresTime, Date.parse(login.data.expiresTime))
  assert.equal(supplierSessionKey, 'CFOR_SUPPLIER_PORTAL_SESSION')
  assert.equal(supplierSession({ ...login, data: {
    ...login.data, expiresTime: Date.parse(login.data.expiresTime) / 1000
  } }, '1', now).expiresTime, session.expiresTime)
})

test('supplier session rejects expiry, missing principal fields and wrong tenant', () => {
  for (const data of [
    { ...login.data, accessToken: '' }, { ...login.data, refreshToken: '' },
    { ...login.data, accessToken: {} }, { ...login.data, refreshToken: true },
    { ...login.data, userId: '' }, { ...login.data, basePartnerId: '' },
    { ...login.data, userId: 2106200343998562305 }, { ...login.data, tenantId: '2' },
    { ...login.data, expiresTime: null }, { ...login.data, expiresTime: 'bad-date' },
    { ...login.data, expiresTime: now }, { ...login.data, partnerName: '' }
  ]) assert.throws(() => supplierSession({ code: 0, data }, '1', now), /登录响应/)
  assert.throws(() => supplierSession({ code: 500, data: login.data }, '1', now), /登录响应/)
})

test('account/order pages distinguish valid empty data from malformed/error responses', () => {
  const row = { id: '2106200343998562305' }
  assert.deepEqual(supplierPageRows({ code: 0, data: { list: [], total: 0 } }, 'page'), [])
  assert.deepEqual(supplierPageRows({ code: 0, data: { list: [row], total: '1' } }, 'page'), [row])
  for (const body of [
    { code: 500, data: { list: [], total: 0 } },
    { code: 0, data: {} }, { code: 0, data: { list: [], total: null } },
    { code: 0, data: { list: [], total: 1 } }, { code: 0, data: { list: [{}], total: 1 } },
    { code: 0, data: { list: [row], total: 0 } },
    { code: 0, data: { list: [row], total: 1.2 } },
    { code: 0, data: { list: [{ id: 2106200343998562305 }], total: 1 } }
  ]) assert.throws(() => supplierPageRows(body, 'page'), /不能视为缺少前置/)
})

test('only exact missing portal/account/partner/mapping errors qualify as prerequisites', () => {
  for (const msg of [
    '供应商门户未启用，请联系企业管理员',
    '当前供应商尚未完成 ERP 供应商映射，请联系企业管理员',
    '当前供应商绑定多个 ERP 供应商，请联系企业管理员确认唯一主体',
    '当前供应商 ERP 映射数据异常，请联系企业管理员'
  ]) assert.equal(supplierBlocker({ status: 200, body: { code: 409, msg } }), msg)
  assert.equal(supplierBlocker({
    status: 200, body: { code: 1030620008, msg: '供应商门户账号未启用' }
  }), '供应商门户账号未启用')
  assert.equal(supplierBlocker({
    status: 200, body: { code: 1030620009, msg: '关联供应商主体不存在或已停用' }
  }), '关联供应商主体不存在或已停用')
  for (const result of [
    { status: 500, body: { code: 409, msg: '供应商门户未启用，请联系企业管理员' } },
    { status: 200, body: { code: 500, msg: '系统异常' } },
    { status: 200, body: { code: 409, msg: '其他异常' } },
    { status: 200, body: { code: 1030620007, msg: '供应商门户账号或密码错误' } },
    { status: 404, body: { code: 404, msg: '请求地址不存在' } }
  ]) assert.equal(supplierBlocker(result), null)
})

test('auth gates cannot pass because an endpoint is missing, broken or business-successful', () => {
  for (const status of [200, 401, 403]) {
    assert.equal(supplierAuthRejected({ status, body: { code: 401 } }), true)
  }
  for (const result of [
    { status: 500, body: { code: 401 } }, { status: 404, body: { code: 404 } },
    { status: 404, body: { code: 401 } },
    { status: 200, body: { code: 500, msg: '系统异常' } },
    { status: 200, body: { code: 0, data: [] } },
    { status: 200, body: null }
  ]) assert.equal(supplierAuthRejected(result), false)
})

test('HTTP 200 admin SPA fallback is not the independent supplier app', () => {
  assert.deepEqual(supplierEntryFacts('<div id="app"></div><script src="/src/main.ts"></script>'),
    { supplier: false, admin: true })
  assert.deepEqual(supplierEntryFacts("<div id='supplier-app'></div>"), { supplier: true, admin: false })
})

const unitEnvironment = {
  CFOR_TENANT_ID: '1', CFOR_SUPPLIER_USERNAME: 'unit-supplier',
  CFOR_SUPPLIER_PASSWORD: 'unit-password'
}
const order = {
  id: 'unit-outsource', billNo: 'UNIT-OS', supplierId: '123', outsourceStatus: 'RELEASED',
  planQty: '10', openWarningCount: 0, releaseTime: '2026-10-01T00:00:00'
}
const account = {
  id: login.data.userId, basePartnerId: login.data.basePartnerId,
  loginName: unitEnvironment.CFOR_SUPPLIER_USERNAME, partnerName: 'Supplier', status: 'ENABLED'
}

// Test doubles exercise script control flow only. They are never acceptance evidence.
const setup = ({
  orders = [order], accounts = [account], mappingError, overrides = {},
  html = '<div id="supplier-app"></div>'
} = {}) => {
  const calls = []
  const caseRecord = { checks: [], evidence: [], notes: [] }
  const record = { api: [] }
  let loggedOut = false
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname
    const method = options.method || 'GET'
    calls.push({ url, method, options })
    if (pathname === '/supplier/login') {
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    }
    let body, status = 200
    const override = overrides[`${method} ${pathname}`]
    if (override) {
      body = override.body
      status = override.status || 200
    } else if (pathname === '/admin-api/system/auth/login-encrypted') {
      body = { code: 0, data: { accessToken: 'unit-admin-access' } }
    } else if (options.headers.Authorization === 'Bearer unit-admin-access') {
      const routes = {
        '/admin-api/erp/supplier-portal/account/page': { list: accounts, total: accounts.length },
        '/admin-api/erp/supplier-portal/account/get': accounts[0],
        '/admin-api/erp/supplier-portal/account/settings': { portalBaseUrl: '', inviteExpireDays: 7 },
        '/admin-api/base/partner/get': {
          id: login.data.basePartnerId, name: 'Supplier', status: 'ACTIVE', supplierEnabled: true
        },
        '/admin-api/system/auth/logout': true
      }
      body = pathname.startsWith('/supplier-api/')
        ? { code: 401, msg: '令牌类型不匹配' }
        : { code: 0, data: routes[pathname] }
      if (!pathname.startsWith('/supplier-api/')) {
        assert.notEqual(body.data, undefined, `Unexpected admin request: ${pathname}`)
      }
    } else if (!options.headers.Authorization || loggedOut) {
      body = pathname === '/supplier-api/erp/auth/login'
        ? { ...login, data: { ...login.data, expiresTime: '2099-10-07T00:00:00Z' } }
        : { code: 401, msg: '未登录' }
    } else if (pathname === '/admin-api/system/auth/get-permission-info') {
      body = { code: 401, msg: '令牌类型不匹配' }
    } else if (pathname === '/supplier-api/erp/workbench/summary') {
      body = { code: 0, data: { basePartnerId: login.data.basePartnerId, partnerName: 'Supplier' } }
    } else if (pathname === '/supplier-api/erp/outsource-orders/page') {
      body = mappingError || { code: 0, data: { list: orders, total: orders.length } }
    } else if (pathname === '/supplier-api/erp/outsource-orders/get') {
      body = { code: 0, data: { ...order, warnings: [], items: [], progressList: [] } }
    } else if (pathname === '/supplier-api/erp/outsource-orders/warnings') {
      body = { code: 0, data: [] }
    } else if (pathname === '/supplier-api/erp/auth/logout') {
      loggedOut = true
      body = { code: 0, data: true }
    } else throw new Error(`Unexpected unit-test request: ${method} ${pathname}`)
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' }
    })
  }
  const run = (env = unitEnvironment) => runCase({ caseId, record, caseRecord },
    { fetchImpl, env: { CFOR_PASSWORD: '', ...env } })
  return { calls, caseRecord, record, run }
}

test('no explicit supplier account stays PARTIAL and never logs in or creates one', async () => {
  const context = setup()
  const result = await context.run({ CFOR_TENANT_ID: '1' })
  assert.equal(result.partial, true)
  assert.equal(context.calls.some((call) => call.method !== 'GET'), false)
  assert.match(result.note, /缺显式 CFOR_SUPPLIER_USERNAME/)
})

test('missing tenant is BLOCKED before any network request', async () => {
  const context = setup()
  await assert.rejects(context.run({ CFOR_TENANT_ID: '' }), /^Error: BLOCKED:/)
  assert.equal(context.calls.length, 0)
})

test('real-request control flow uses encrypted supplier login and tenant on every business request', async () => {
  const context = setup()
  const result = await context.run()
  assert.equal(result.partial, true)
  const auth = context.calls.find((call) => new URL(call.url).pathname === '/supplier-api/erp/auth/login')
  assert.equal(auth.options.headers['X-Api-Encrypt'], 'true')
  assert.equal(auth.options.headers.Authorization, undefined)
  assert.equal(auth.options.headers['tenant-id'], '1')
  assert.equal(auth.options.body.includes(unitEnvironment.CFOR_SUPPLIER_PASSWORD), false)
  assert.equal(auth.options.body.includes(unitEnvironment.CFOR_SUPPLIER_USERNAME), false)
  for (const call of context.calls.filter((item) => item.options.headers)) {
    assert.equal(call.options.headers['tenant-id'], '1')
    assert.equal(new URL(call.url).searchParams.has('supplierId'), false)
  }
  assert.equal(context.caseRecord.checks.every((item) => item.passed), true)
  assert.deepEqual(context.calls.filter((call) => call.method !== 'GET')
    .map((call) => new URL(call.url).pathname),
  ['/supplier-api/erp/auth/login', '/supplier-api/erp/auth/logout'])
  assert.equal(JSON.stringify(context.record).includes(login.data.accessToken), false)
  assert.equal(JSON.stringify(context.record).includes(unitEnvironment.CFOR_SUPPLIER_PASSWORD), false)
  assert.equal(caseOutcome({ result, failedChecks: [], hasAssertions: true }).status, 'PARTIAL')
})

test('empty or completed-only orders do not authorize write-side coverage', async () => {
  for (const orders of [[], [{ ...order, outsourceStatus: 'COMPLETED' }], [{ ...order, releaseTime: null }]]) {
    const context = setup({ orders })
    const result = await context.run()
    assert.match(result.note, /缺已下达/)
    assert.equal(context.calls.some((call) => new URL(call.url).pathname.endsWith('/outsource-orders/get')), false)
    assert.equal(context.calls.filter((call) => call.method === 'POST').length, 2)
  }
})

test('missing or ambiguous ERP supplier mapping remains PARTIAL without correcting shared data', async () => {
  for (const msg of [
    '当前供应商尚未完成 ERP 供应商映射，请联系企业管理员',
    '当前供应商绑定多个 ERP 供应商，请联系企业管理员确认唯一主体'
  ]) {
    const context = setup({ mappingError: { code: 409, msg } })
    const result = await context.run()
    assert.equal(result.partial, true)
    assert.match(result.note, /ERP 供应商/)
    assert.equal(context.calls.filter((call) => call.method === 'POST').length, 2)
  }
})

test('admin read-only account linkage matches the independently authenticated supplier principal', async () => {
  const context = setup()
  const result = await context.run({ ...unitEnvironment, CFOR_PASSWORD: 'unit-admin-password' })
  assert.equal(result.partial, true)
  assert.equal(context.caseRecord.checks.every((item) => item.passed), true)
  assert.ok(context.caseRecord.checks.some((item) => item.name.includes('显式供应商账号一致')))
  assert.equal(context.calls.filter((call) => call.method === 'POST').length, 4)
  assert.equal(context.calls.some((call) => ['PUT', 'DELETE'].includes(call.method)), false)
})

test('missing or disabled explicit account remains partial and no supplier login or account write occurs', async () => {
  for (const accounts of [[], [{ ...account, status: 'DISABLED' }], [{ ...account, status: 'INVITED' }]]) {
    const context = setup({ accounts })
    const result = await context.run({ ...unitEnvironment, CFOR_PASSWORD: 'unit-admin-password' })
    assert.equal(result.partial, true)
    assert.equal(context.calls.some((call) => new URL(call.url).pathname === '/supplier-api/erp/auth/login'), false)
    assert.equal(context.calls.filter((call) => call.method === 'POST').length, 2)
  }
})

test('unexpected account secrets and malformed partner data fail instead of creating prerequisites', async () => {
  for (const context of [
    setup({ accounts: [{ ...account, passwordHash: 'unit-secret' }] }),
    setup({ overrides: {
      'GET /admin-api/base/partner/get': { body: { code: 0, data: {} } }
    } })
  ]) {
    await assert.rejects(context.run({ ...unitEnvironment, CFOR_PASSWORD: 'unit-admin-password' }))
    assert.equal(context.caseRecord.checks.some((item) => !item.passed), true)
    assert.equal(context.calls.some((call) => new URL(call.url).pathname === '/admin-api/system/auth/logout'), true)
  }
})

test('supplier login principal mismatch fails and both new sessions are cleaned up', async () => {
  const context = setup({ overrides: {
    'POST /supplier-api/erp/auth/login': { body: {
      ...login, data: { ...login.data, expiresTime: '2099-10-07T00:00:00Z', basePartnerId: 'wrong-partner' }
    } }
  } })
  await assert.rejects(context.run({ ...unitEnvironment, CFOR_PASSWORD: 'unit-admin-password' }), /显式供应商账号一致/)
  for (const prefix of ['supplier-api/erp', 'admin-api/system']) {
    assert.equal(context.calls.some((call) => new URL(call.url).pathname === `/${prefix}/auth/logout`), true)
  }
})

test('absent 9151 supplier build does not mask a real supplier API system failure', async () => {
  const context = setup({
    html: '<div id="app"></div>',
    overrides: {
      'POST /supplier-api/erp/auth/login': { status: 500, body: { code: 500, msg: '系统异常' } }
    }
  })
  await assert.rejects(context.run(), /独立供应商登录 HTTP\/业务成功/)
  assert.equal(context.caseRecord.checks.some((item) => !item.passed), true)
})

test('system errors remain FAIL and new supplier tokens are cleaned up', async () => {
  const context = setup({ mappingError: { code: 500, msg: '系统异常' } })
  let error
  try { await context.run() } catch (caught) { error = caught }
  assert.ok(error)
  assert.equal(caseErrorStatus(error, context.caseRecord.checks), 'FAIL')
  assert.equal(context.caseRecord.checks.some((item) => !item.passed), true)
  assert.equal(context.calls.some((call) => new URL(call.url).pathname === '/supplier-api/erp/auth/logout'), true)
})

test('warning foreign supplier or wrong status fails instead of becoming missing prerequisite', async () => {
  const context = setup({ overrides: {
    'GET /supplier-api/erp/outsource-orders/warnings': { body: {
      code: 0, data: [{
        id: 'unit-warning', outsourceId: order.id, supplierId: 'other',
        status: 'OPEN', warningType: 'OVERDUE'
      }]
    } }
  } })
  await assert.rejects(context.run(), /当前委外单\/供应商/)
})

test('empty historical feedback is not asserted as existing anomaly validation evidence', async () => {
  const context = setup()
  const result = await context.run()
  assert.equal(context.caseRecord.checks.some((item) => item.name.includes('既有反馈归属')), false)
  assert.match(result.note, /没有既有反馈样本/)
})

test('historical exception readback must retain supplier ownership and mandatory fields', async () => {
  const feedback = {
    id: 'unit-progress', outsourceId: order.id, supplierId: order.supplierId,
    feedbackType: 'EXCEPTION', exceptionReason: 'Inspection',
    responsiblePerson: 'Unit', correctiveAction: 'Repair'
  }
  for (const patch of [{ correctiveAction: '' }, { supplierId: 'other' }]) {
    const context = setup({ overrides: {
      'GET /supplier-api/erp/outsource-orders/get': { body: {
        code: 0, data: { ...order, warnings: [], progressList: [{ ...feedback, ...patch }] }
      } }
    } })
    await assert.rejects(context.run(), /既有反馈归属/)
  }
})

test('supplier suite contains no account/partner/order writes or retained mock smoke invocation', () => {
  const source = fs.readFileSync(new URL('../suites/supplier-portal.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /supplier-portal-smoke|9152|page\.route\(|addInitScript|localStorage\.setItem/)
  assert.doesNotMatch(source, /\/erp\/auth\/accept-invite|\/erp\/outsource-orders\/progress/)
  assert.doesNotMatch(source, /['"](?:PUT|DELETE)['"]|\/(?:create|update|reset-password|invite|status)['"`?]/)
  assert.match(source, /\/supplier-api/)
  assert.match(source, /finally/)
  assert.match(source, /partial: true/)
})
