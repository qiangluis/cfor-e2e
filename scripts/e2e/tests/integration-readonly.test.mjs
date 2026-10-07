import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertIntegrationLocalScope,
  integrationConfigIsMasked,
  integrationInitBlocker,
  integrationReadonlyArray,
  integrationReadonlyPage,
  runCase,
  runIntegrationReadonlyContract
} from '../suites/integration.mjs'
import { caseErrorStatus, caseOutcome } from '../lib/report.mjs'
import { config } from '../config/index.mjs'
import { ENCRYPT_HEADER, REQ_KEY, RESP_KEY } from '../lib/crypto.mjs'
import crypto from 'node:crypto'

const settings = {
  target: 'local', webBase: 'http://127.0.0.1:9151',
  apiBase: 'http://127.0.0.1:48083', apiUrl: 'http://127.0.0.1:48083/admin-api',
  tenantId: '1', tenantName: 'CFOR 标准平台', username: 'admin',
  password: 'unit-only-password'
}
const tenantPath = `/system/tenant/get-id-by-name?name=${encodeURIComponent(settings.tenantName)}`
const authPath = '/system/auth/login-encrypted'
const accessToken = 'unit-only-access-token-1234567890'
const auth = { userId: '1', tenantId: '1', accessToken, refreshToken: 'unit-only-refresh-token' }
const ok = (data) => ({ code: 0, data })
const record = () => ({ checks: [], notes: [], evidence: [] })
const platform = {
  id: 10, code: 'U8', name: '用友 U8', tenantId: 0, isActive: true,
  officialDocsUrl: 'https://example.invalid/docs', officialDocsLabel: '官方文档',
  configGuideTitle: '配置指引', configGuideSteps: '注册应用\n获取参数'
}
const connector = {
  id: 20, platformCode: 'U8', connectorName: 'U8 模板', tenantId: 0,
  isSystemPreset: true,
  authSchema: JSON.stringify({ type: 'object', properties: {
    appSecret: { type: 'string', title: '应用密钥', inputType: 'password' }
  } })
}
const instance = {
  id: 30, instanceName: '已有实例', platformCode: 'U8', isActive: true,
  lastTestTime: null, lastTestResult: null,
  configData: '{"appSecret":"******","nested":{"password":"******"}}'
}
const readonlyPaths = [
  '/integration/platform/list-all',
  '/integration/platform/list-enabled',
  '/integration/platform/registered-adapters',
  '/integration/connector/list-preset-by-platform?platformCode=U8',
  '/integration/connector/get?id=20',
  '/integration/instance/page?pageNo=1&pageSize=100'
]

function fixture (overrides = {}) {
  const responses = {
    '/integration/platform/list-all': ok([platform]),
    '/integration/platform/list-enabled': ok([platform]),
    '/integration/platform/registered-adapters': ok(['U8']),
    '/integration/connector/list-preset-by-platform?platformCode=U8': ok([connector]),
    '/integration/connector/get?id=20': ok(connector),
    '/integration/instance/page?pageNo=1&pageSize=100': ok({ list: [instance], total: 1 }),
    ...overrides
  }
  const calls = []
  const api = {
    async get (pathname) {
      calls.push(pathname)
      assert.ok(Object.hasOwn(responses, pathname), `Unexpected GET ${pathname}`)
      const response = responses[pathname]
      if (response instanceof Error) throw response
      return structuredClone(response)
    }
  }
  return { api, calls, responses, caseRecord: record() }
}
async function run (overrides) {
  const context = fixture(overrides)
  const result = await runIntegrationReadonlyContract(context)
  return { ...context, result }
}

test('readonly contracts validate actual catalog, preset detail and masked instance but always PARTIAL', async () => {
  const { result, calls, caseRecord } = await run()
  assert.equal(result.partial, true)
  assert.deepEqual(result.eligibleCodes, ['U8'])
  assert.ok(caseRecord.checks.length >= 9)
  assert.ok(caseRecord.checks.every((check) => check.passed))
  assert.deepEqual(calls, readonlyPaths)
  assert.doesNotMatch(JSON.stringify({ result, caseRecord }), /appSecret|configData":|authSchema":/)
  assert.ok(caseRecord.notes.some((note) => note.includes(integrationInitBlocker)))
  assert.equal(caseOutcome({
    failedChecks: [], hasAssertions: true, partial: false, result
  }).status, 'PARTIAL')
})

test('empty facts remain gaps, without invented details, adapters or connection evidence', async () => {
  const { result, calls, caseRecord } = await run({
    '/integration/platform/list-all': ok([]),
    '/integration/platform/list-enabled': ok([]),
    '/integration/platform/registered-adapters': ok([]),
    '/integration/instance/page?pageNo=1&pageSize=100': ok({ list: [], total: 0 })
  })
  assert.equal(result.partial, true)
  assert.deepEqual(result.eligibleCodes, [])
  assert.ok(!calls.some((path) => path.includes('/get?') || path.includes('connector/')))
  assert.ok(caseRecord.notes.filter((note) => note.startsWith('未验收：')).length >= 5)
  assert.ok(caseRecord.checks.every(({ name }) =>
    !/全局平台行|唯一平台编码|预置连接器的编号|authSchema|服务端掩码|真实测试状态/.test(name)))
  assert.ok(caseRecord.checks.some(({ name }) => name === '实例分页 list/total 响应契约'))
})

test('quick setup candidates are the live enabled/registered/preset intersection, not a fixed 11', async () => {
  const noAdapter = await run({ '/integration/platform/registered-adapters': ok([]) })
  assert.deepEqual(noAdapter.result.eligibleCodes, [])
  assert.ok(noAdapter.calls.includes('/integration/connector/get?id=20'))
  assert.ok(!noAdapter.caseRecord.checks.some(({ name }) => name.includes('官方文档和注册步骤')))
  const noConnector = await run({
    '/integration/connector/list-preset-by-platform?platformCode=U8': ok([])
  })
  assert.deepEqual(noConnector.result.eligibleCodes, [])
  assert.ok(!noConnector.calls.includes('/integration/connector/get?id=20'))
  assert.ok(!noConnector.caseRecord.checks.some(({ name }) =>
    /预置连接器的编号|authSchema|详情精确对应/.test(name)))
})

test('malformed response envelopes and pagination are rejected', () => {
  for (const payload of [null, { code: 500, data: [] }, ok({ list: [] })]) {
    assert.throws(() => integrationReadonlyArray(payload, '目录'))
  }
  for (const payload of [
    ok({ list: [], total: '0' }), ok({ list: [], total: -1 }),
    ok({ list: [instance], total: 0 }), ok({ records: [], total: 0 }),
    ok({ list: Array(101).fill(instance), total: 101 })
  ]) assert.throws(() => integrationReadonlyPage(payload))
})

test('foreign template tenant, duplicate platform and mismatched enabled catalog cannot pass', async () => {
  for (const rows of [[{ ...platform, tenantId: 1 }], [platform, platform]]) {
    await assert.rejects(() => run({
      '/integration/platform/list-all': ok(rows)
    }), /全局平台行/)
  }
  await assert.rejects(() => run({
    '/integration/platform/list-enabled': ok([{ ...platform, id: 99 }])
  }), /启用目录/)
})

test('connector source, schema and detail identity are validated against real preset records', async () => {
  for (const row of [
    { ...connector, platformCode: 'WECOM' }, { ...connector, tenantId: 1 },
    { ...connector, isSystemPreset: false }
  ]) {
    await assert.rejects(() => run({
      '/integration/connector/list-preset-by-platform?platformCode=U8': ok([row])
    }), /预置连接器/)
  }
  for (const authSchema of ['not-json', '{}', '{"type":"object","properties":[]}']) {
    await assert.rejects(() => run({
      '/integration/connector/list-preset-by-platform?platformCode=U8':
        ok([{ ...connector, authSchema }])
    }), /authSchema/)
  }
  await assert.rejects(() => run({
    '/integration/connector/get?id=20': ok({ ...connector, id: 99 })
  }), /详情精确对应/)
})

test('official guides must exist in data; tests never fetch their URLs', async () => {
  const missingGuide = { ...platform, configGuideSteps: '' }
  await assert.rejects(() => run({
    '/integration/platform/list-all': ok([missingGuide]),
    '/integration/platform/list-enabled': ok([missingGuide])
  }), /官方文档和注册步骤/)
})

test('nested credentials and JSON strings are checked without being printed', async () => {
  assert.equal(integrationConfigIsMasked(instance.configData), true)
  for (const value of [
    'not-json', '[]', '{"appSecret":"plain-sensitive-value"}',
    '{"nested":[{"password":"plain-sensitive-value"}]}',
    '{"api-key":"plain-sensitive-value"}', '{"access_token":null}'
  ]) assert.equal(integrationConfigIsMasked(value), false)
  const context = fixture({
    '/integration/instance/page?pageNo=1&pageSize=100': ok({
      list: [{ ...instance, configData: '{"appSecret":"plain-sensitive-value"}' }], total: 1
    })
  })
  await assert.rejects(() => runIntegrationReadonlyContract(context), /仅返回服务端掩码/)
  assert.doesNotMatch(JSON.stringify(context.caseRecord), /plain-sensitive-value/)
  await assert.rejects(() => run({
    '/integration/platform/list-all': new Error('plain-sensitive-value')
  }), (error) => !error.message.includes('plain-sensitive-value'))
})

test('success without historical lastTestTime is not invented connection evidence', async () => {
  await assert.rejects(() => run({
    '/integration/instance/page?pageNo=1&pageSize=100': ok({
      list: [{ ...instance, lastTestResult: true }], total: 1
    })
  }), /真实测试状态字段/)
})

test('local safety scope rejects production, alternate ports, tenants and API prefixes', () => {
  assert.doesNotThrow(() => assertIntegrationLocalScope(settings))
  assert.doesNotThrow(() => assertIntegrationLocalScope({ ...settings, tenantId: '' }))
  for (const override of [
    { target: 'production' }, { tenantId: '0' }, { tenantId: 0 }, { username: 'other' },
    { tenantName: '其他租户' }, { apiBase: 'http://127.0.0.1:48080' },
    { webBase: 'https://external.invalid:9151' }, { apiUrl: `${settings.apiBase}/app-api` }
  ]) assert.throws(() => assertIntegrationLocalScope({ ...settings, ...override }), /BLOCKED:/)
})

test('INT-002 notImplemented guard runs before config, browser, login and any API access', async () => {
  const forbidden = new Proxy({}, { get () { throw new Error('Forbidden access') } })
  const caseRecord = record()
  const result = await runCase({ caseId: 'INT-002', page: forbidden, caseRecord }, forbidden)
  assert.equal(result.notImplemented, true)
  assert.equal(result.partial, true)
  assert.deepEqual(caseRecord.checks, [])
  assert.equal(caseOutcome({
    failedChecks: [], partial: false, hasAssertions: true, result
  }).status, 'PARTIAL')
})

function wrapperFixture ({ tenant = ok('1'), login = ok(auth), business = {} } = {}) {
  const context = fixture(business)
  const requests = []
  const optionsList = []
  const page = new Proxy({ url: () => 'about:blank' }, {
    get () { throw new Error('API-only case must not read, navigate or mutate the browser') }
  })
  const createApiClient = (options) => {
    optionsList.push(options)
    if (options.token) {
      assert.equal(options.token, accessToken)
      return { get: async (pathname) => {
        requests.push(['GET', pathname])
        return context.api.get(pathname)
      } }
    }
    return {
      get: async (pathname) => {
        requests.push(['GET', pathname])
        assert.equal(pathname, tenantPath)
        if (tenant instanceof Error) throw tenant
        return structuredClone(tenant)
      },
      post: async (pathname, body, options) => {
        requests.push(['POST', pathname])
        assert.equal(pathname, authPath)
        assert.deepEqual(body, {
          username: 'admin', password: settings.password, captchaVerification: ''
        })
        assert.deepEqual(options, { encrypted: true })
        if (login instanceof Error) throw login
        return structuredClone(login)
      }
    }
  }
  return {
    ...context, page, requests, optionsList,
    run: (overrides = {}) => runCase({
      caseId: 'INT-001', page, caseRecord: context.caseRecord
    }, { config: { ...settings, ...overrides }, createApiClient })
  }
}

test('fresh runCase authenticates admin encrypted then executes GET contracts without opening app', async () => {
  const context = wrapperFixture()
  const result = await context.run()
  assert.equal(result.partial, true)
  assert.deepEqual(context.requests, [
    ['GET', tenantPath], ['POST', authPath], ...readonlyPaths.map((path) => ['GET', path])
  ])
  assert.deepEqual(context.optionsList, [
    { tenantId: '1' }, { token: accessToken, tenantId: '1' }
  ])
  assert.ok(context.caseRecord.checks.every((check) => check.passed))
  assert.ok(context.caseRecord.checks.some(({ name }) => name.includes('真实 admin 加密认证')))
  assert.ok(context.caseRecord.notes.some((note) => note.includes('UI 尚未验收')))
  assert.doesNotMatch(JSON.stringify({ result, caseRecord: context.caseRecord }),
    /unit-only-password|unit-only-access-token|unit-only-refresh-token/)
})

test('missing credentials and unsafe settings stop before creating API clients', async () => {
  for (const overrides of [{ password: '' }, { tenantId: '2' }, { target: 'production' }]) {
    const context = wrapperFixture()
    await assert.rejects(context.run(overrides), /BLOCKED:/)
    assert.deepEqual(context.optionsList, [])
    assert.deepEqual(context.requests, [])
  }
})

test('tenant-name mismatch stops before login instead of reading another tenant', async () => {
  const context = wrapperFixture({ tenant: ok('2') })
  await assert.rejects(context.run(), /BLOCKED: CFOR 标准平台未解析为租户 1/)
  assert.deepEqual(context.requests, [['GET', tenantPath]])
})

test('authentication transport and business errors fail and never disclose credentials or tokens', async () => {
  for (const login of [
    new Error('unit-only-password unit-only-access-token'),
    { code: 401, msg: 'unit-only-password', data: auth },
    ok(null), ok({ ...auth, tenantId: '2' }), ok({ ...auth, userId: null }),
    ok({ ...auth, accessToken: '' }), ok({ ...auth, accessToken: 'short-token' })
  ]) {
    const context = wrapperFixture({ login })
    await assert.rejects(context.run(), (error) => {
      assert.equal(caseErrorStatus(error, context.caseRecord.checks), 'FAIL')
      assert.doesNotMatch(error.message, /unit-only-password|unit-only-access-token/)
      return true
    })
    assert.equal(context.optionsList.length, 1)
    assert.deepEqual(context.requests, [['GET', tenantPath], ['POST', authPath]])
    assert.doesNotMatch(JSON.stringify(context.caseRecord), /unit-only-password|unit-only-access-token/)
  }
})

test('tenant lookup and readonly business failures remain FAIL rather than returning partial', async () => {
  for (const options of [
    { tenant: new Error('unit-only-password') },
    { tenant: { code: 500, msg: 'unit-only-password' } },
    { business: { '/integration/platform/list-all': { code: 500, msg: 'unit-only-password' } } },
    { business: { '/integration/platform/list-all': new Error('unit-only-password') } },
    { business: { '/integration/instance/page?pageNo=1&pageSize=100': ok({
      list: [{ ...instance, configData: '{"appSecret":"unit-only-password"}' }], total: 1
    }) } }
  ]) {
    const context = wrapperFixture(options)
    await assert.rejects(context.run(), (error) => {
      assert.equal(caseErrorStatus(error, context.caseRecord.checks), 'FAIL')
      assert.doesNotMatch(error.message, /unit-only-password/)
      return true
    })
    assert.doesNotMatch(JSON.stringify(context.caseRecord), /unit-only-password/)
  }
})

test('real API helper sends encrypted login and handles encrypted response in an isolated fetch stub', async (t) => {
  const context = fixture()
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, config.apiBase)
    assert.equal(parsed.pathname.startsWith('/admin-api/'), true)
    const pathname = `${parsed.pathname.slice('/admin-api'.length)}${parsed.search}`
    requests.push([options.method, pathname])
    assert.equal(options.headers['tenant-id'], '1')
    if (pathname === tenantPath) {
      assert.equal(options.method, 'GET')
      assert.equal(options.headers.Authorization, undefined)
      return Response.json(ok('1'))
    }
    if (pathname === authPath) {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers.Authorization, undefined)
      assert.equal(options.headers[ENCRYPT_HEADER], 'true')
      assert.doesNotMatch(options.body, /unit-only-password/)
      const decipher = crypto.createDecipheriv('aes-256-ecb',
        Buffer.from(process.env.CFOR_API_ENCRYPT_REQUEST_KEY || REQ_KEY), null)
      const body = JSON.parse(Buffer.concat([
        decipher.update(options.body, 'base64'), decipher.final()
      ]).toString('utf8'))
      assert.deepEqual(body, { username: 'admin', password: settings.password, captchaVerification: '' })
      const cipher = crypto.createCipheriv('aes-256-ecb',
        Buffer.from(process.env.CFOR_API_ENCRYPT_RESPONSE_KEY || RESP_KEY), null)
      return new Response(Buffer.concat([
        cipher.update(JSON.stringify(ok(auth)), 'utf8'), cipher.final()
      ]).toString('base64'), { headers: { [ENCRYPT_HEADER]: 'true' } })
    }
    assert.equal(options.method, 'GET')
    assert.equal(options.headers.Authorization, `Bearer ${accessToken}`)
    assert.equal(options.body, undefined)
    assert.ok(Object.hasOwn(context.responses, pathname), `Unreviewed GET ${pathname}`)
    return Response.json(context.responses[pathname])
  })
  const forbiddenBrowser = new Proxy({}, { get () { throw new Error('Forbidden browser access') } })
  const result = await runCase({
    caseId: 'INT-001', page: forbiddenBrowser, caseRecord: context.caseRecord
  }, { config: { ...settings, webBase: config.webBase, apiBase: config.apiBase, apiUrl: config.apiUrl } })
  assert.equal(result.partial, true)
  assert.deepEqual(requests, [
    ['GET', tenantPath], ['POST', authPath], ...readonlyPaths.map((path) => ['GET', path])
  ])
  assert.ok(context.caseRecord.checks.every((check) => check.passed))
  assert.doesNotMatch(JSON.stringify({ result, caseRecord: context.caseRecord }),
    /unit-only-password|unit-only-access-token|unit-only-refresh-token/)
})
