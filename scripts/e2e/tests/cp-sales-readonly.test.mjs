import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cases,
  cpSalesReadonlyRegistration,
  customerPortalPaths,
  customerPortalSession,
  runCase
} from '../suites/cp-sales-readonly.mjs'

const ok = (data) => ({ code: 0, data })
const page = (rows) => ok({ list: rows, total: rows.length })
const record = () => ({ checks: [], notes: [], evidence: [], api: [] })

const session = {
  userId: '8001',
  basePartnerId: '9101',
  partnerName: '测试客户',
  accessToken: 'customer-access-token-1234567890',
  refreshToken: 'customer-refresh-token',
  expiresTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  tenantId: '1'
}

const fixtures = {
  [customerPortalPaths.workbenchSummary]: ok({
    basePartnerId: '9101',
    partnerName: '测试客户',
    pendingConfirmOrderCount: 1
  }),
  [customerPortalPaths.saleOrderPage]: page([{ id: '1001', billNo: 'SO-001', lines: [] }]),
  [customerPortalPaths.saleOrderGet('1001')]: ok({ id: '1001', billNo: 'SO-001', lines: [] }),
  [customerPortalPaths.deliveryPage]: page([{ id: '2001', no: 'OUT-001' }]),
  [customerPortalPaths.deliveryGet('2001')]: ok({ id: '2001', no: 'OUT-001' }),
  [customerPortalPaths.reconciliationPage]: page([{ id: '3001', billNo: 'REC-001', lines: [] }]),
  [customerPortalPaths.reconciliationGet('3001')]: ok({ id: '3001', billNo: 'REC-001', lines: [] }),
  [customerPortalPaths.invoicePage]: page([{ id: '4001', billNo: 'INV-001' }]),
  [customerPortalPaths.invoiceGet('4001')]: ok({ id: '4001', billNo: 'INV-001' }),
  [customerPortalPaths.receivableSummary]: ok({ payableBalance: '10.00' }),
  [customerPortalPaths.receivablePage]: page([{ id: '5001', billNo: 'AR-001' }]),
  [customerPortalPaths.feedbackPage]: page([{ id: '6001', serviceCode: 'AS-001' }]),
  [customerPortalPaths.feedbackGet('6001')]: ok({ id: '6001', serviceCode: 'AS-001' }),
  [customerPortalPaths.unreadCount]: ok(0),
  [customerPortalPaths.unreadList]: ok([]),
  [customerPortalPaths.messagePage]: page([])
}

const settings = {
  target: 'local',
  apiBase: 'http://127.0.0.1:48083',
  tenantId: '1',
  tenantName: 'CFOR 标准平台'
}

function fakeFetch(overrides = {}) {
  const calls = []
  const routes = { ...fixtures, ...overrides }
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}`
    calls.push({ path, options })
    if (parsed.pathname === customerPortalPaths.login) {
      return new Response(JSON.stringify(ok(session)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (parsed.pathname === '/admin-api/system/auth/get-permission-info') {
      return new Response(JSON.stringify({ code: 401, msg: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (Object.hasOwn(routes, path)) {
      const value = routes[path]
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    throw new Error(`Unexpected ${options.method || 'GET'} ${path}`)
  }
  return { calls, fetchImpl }
}

test('CP readonly registration exports all four cases without catalog coupling', () => {
  assert.deepEqual(cases, [
    'CP-158-001',
    'CP-160-161-001',
    'CP-162-164-001',
    'CP-165-166-167-168-169-001'
  ])
  assert.equal(cpSalesReadonlyRegistration.status, 'PARTIAL')
  assert.equal(cpSalesReadonlyRegistration.ui, 'UNVERIFIED')
  assert.equal(cpSalesReadonlyRegistration.catalog, 'not-registered-by-design')
})

test('customer login response requires an independent live tenant session', () => {
  assert.equal(customerPortalSession({ code: 0, data: session }, '1').tenantId, '1')
  assert.throws(
    () => customerPortalSession({ code: 0, data: { ...session, tenantId: '135' } }, '1'),
    /租户/
  )
  assert.throws(
    () => customerPortalSession({ code: 500, data: session }, '1'),
    /登录响应/
  )
})

for (const caseId of cases) {
  test(`${caseId} performs encrypted customer login and GET-only checks, then stays PARTIAL`, async () => {
    const { calls, fetchImpl } = fakeFetch()
    const caseRecord = record()
    const result = await runCase(
      { caseId, caseRecord, record: caseRecord },
      {
        config: settings,
        env: {
          CFOR_CUSTOMER_USERNAME: 'customer-readonly',
          CFOR_CUSTOMER_PASSWORD: 'customer-password'
        },
        fetchImpl
      }
    )
    assert.equal(result.partial, true)
    assert.ok(caseRecord.checks.length > 0)
    assert.ok(caseRecord.checks.every((check) => check.passed))
    assert.ok(caseRecord.notes.some((note) => note.includes('PARTIAL')))
    assert.equal(calls[0].path, customerPortalPaths.login)
    assert.equal(calls[0].options.method, 'POST')
    assert.equal(calls[0].options.headers['tenant-id'], '1')
    assert.equal(calls[0].options.headers[ 'X-Api-Encrypt'], 'true')
    assert.equal(typeof calls[0].options.body, 'string')
    assert.ok(calls[0].options.body.length > 20)
    assert.notEqual(calls[0].options.body, 'customer-password')
    assert.ok(calls.slice(1).every(({ options }) => options.method === 'GET'))
    assert.ok(calls.slice(1).every(({ options }) =>
      options.headers['tenant-id'] === '1' &&
      options.headers.Authorization === `Bearer ${session.accessToken}`))
    assert.ok(!calls.some(({ path }) =>
      /\/(confirm|reject|change-request|receipt|request|create|read|read-all)\b/.test(path)))
  })
}

test('empty pages do not create non-empty row-field passes or detail calls', async () => {
  const empty = Object.fromEntries([
    customerPortalPaths.saleOrderPage,
    customerPortalPaths.deliveryPage,
    customerPortalPaths.reconciliationPage,
    customerPortalPaths.invoicePage,
    customerPortalPaths.receivablePage,
    customerPortalPaths.feedbackPage,
    customerPortalPaths.messagePage
  ].map((path) => [path, page([])]))
  const { calls, fetchImpl } = fakeFetch(empty)
  const caseRecord = record()
  const result = await runCase(
    { caseId: 'CP-160-161-001', caseRecord, record: caseRecord },
    {
      config: settings,
      env: {
        CFOR_CUSTOMER_USERNAME: 'customer-readonly',
        CFOR_CUSTOMER_PASSWORD: 'customer-password'
      },
      fetchImpl
    }
  )
  assert.equal(result.partial, true)
  assert.ok(caseRecord.notes.some((note) => note.includes('客户销售订单为空')))
  assert.ok(!caseRecord.checks.some((check) => check.name.includes('非空样本')))
  assert.ok(!calls.some(({ path }) => path.includes('/get?id=')))
})

test('HTTP 500 and business errors fail instead of becoming PARTIAL', async () => {
  const { fetchImpl: http500 } = fakeFetch({
    [customerPortalPaths.saleOrderPage]: { code: 0, data: { list: [], total: 0 } }
  })
  const original500 = async (url, options) => {
    const response = await http500(url, options)
    if (new URL(url).pathname === '/customer-api/customer/workbench/summary') {
      return new Response('server error', { status: 500 })
    }
    return response
  }
  await assert.rejects(
    () => runCase(
      { caseId: 'CP-160-161-001', caseRecord: record(), record: record() },
      {
        config: settings,
        env: { CFOR_CUSTOMER_USERNAME: 'customer-readonly', CFOR_CUSTOMER_PASSWORD: 'customer-password' },
        fetchImpl: original500
      }
    ),
    /HTTP 500/
  )

  const businessError = async (url, options) => {
    const response = await http500(url, options)
    if (new URL(url).pathname === '/customer-api/customer/workbench/summary') {
      return new Response(JSON.stringify({ code: 500, msg: 'failed' }), { status: 200 })
    }
    return response
  }
  await assert.rejects(
    () => runCase(
      { caseId: 'CP-160-161-001', caseRecord: record(), record: record() },
      {
        config: settings,
        env: { CFOR_CUSTOMER_USERNAME: 'customer-readonly', CFOR_CUSTOMER_PASSWORD: 'customer-password' },
        fetchImpl: businessError
      }
    ),
    /业务响应失败/
  )
})

test('login credentials stay in process and are not recorded in API evidence', async () => {
  const { fetchImpl } = fakeFetch()
  const caseRecord = record()
  await runCase(
    { caseId: 'CP-158-001', caseRecord, record: caseRecord },
    {
      config: settings,
      env: {
        CFOR_CUSTOMER_USERNAME: 'customer-readonly',
        CFOR_CUSTOMER_PASSWORD: 'super-secret-password'
      },
      fetchImpl
    }
  )
  const evidence = JSON.stringify(caseRecord)
  assert.doesNotMatch(evidence, /super-secret-password|customer-access-token/)
})
