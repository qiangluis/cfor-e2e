import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { assertHrmOaLocalTarget } from '../fixtures/hrm-local-closure.mjs'

const local = {
  target: 'local', tenantId: '1', webBase: 'http://127.0.0.1:9151',
  apiBase: 'http://127.0.0.1:48083',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const flags = {
  CFOR_HRM_OA_LOCAL_CLOSURE: 'true',
  CFOR_E2E_WRITE_FIXTURES: 'true'
}
const flagNames = [...Object.keys(flags), 'CFOR_HRM_OA_LOCAL_HEADED']
const dataModule = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
let sequence = 0

async function withFlags (env, operation) {
  const previous = Object.fromEntries(flagNames.map((key) => [key, process.env[key]]))
  try {
    for (const key of flagNames) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    return await operation()
  } finally {
    for (const key of flagNames) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

// Substitute imports only in this unit-test module, never in a real E2E execution.
async function harness (settings = local, { loginError, dispatchError } = {}) {
  const events = []
  const delegated = { partial: true, catalogComplete: false, acceptanceComplete: false,
    remainingAssertions: ['policy GAP'], catalogAssertions: [
      { index: 0, assertion: 'policy GAP', status: 'GAP' }
    ] }
  const api = { getBusiness: async (path) => {
    events.push(['get', path])
    const data = {
      '/hrm/employee/page?pageNo=1&pageSize=100': { list: [{ id: '14', status: 1 }], total: 1 },
      '/hrm/employee/bound-user-id-list': ['13'],
      '/hrm/employee/status-count': [],
      '/bpm/oa/leave/page?pageNo=1&pageSize=100': { list: [], total: 0 },
      '/oa/meeting-room/page?pageNo=1&pageSize=100': { list: [], total: 0 }
    }
    assert.ok(Object.hasOwn(data, path), `Unexpected read-only request ${path}`)
    return { code: 0, data: data[path] }
  } }
  const delegate = (name) => async (context) => {
    events.push([name, context])
    if (dispatchError) throw dispatchError
    Object.assign(context.caseRecord, delegated)
    return delegated
  }
  const injected = {
    '../config/index.mjs': { config: settings },
    '../lib/api.mjs': {
      createApiClient: (options) => {
        events.push(['api', options])
        return api
      },
      matchesExpectedBusinessRejection: () => assert.fail('No business rejection expected in legacy reads')
    },
    '../lib/browser.mjs': {
      login: async (page) => {
        events.push(['login', page])
        if (loginError) throw loginError
        return 'unit-token'
      },
      openRoute: async (page, route) => { events.push(['route', route, page]) },
      saveScreenshot: async (...args) => { events.push(['screenshot', ...args]) },
      waitForPageReady: async () => assert.fail('PMS UI must not run in this dispatch unit test')
    },
    '../fixtures/hrm-local-closure.mjs': {
      assertHrmOaLocalTarget: (settings, env) => {
        events.push(['guard'])
        assertHrmOaLocalTarget(settings, env)
      }
    },
    './hrm.mjs': { runCase: delegate('hrm') },
    './oa.mjs': { runCase: delegate('oa') },
    '../fixtures/pms-member-permissions.mjs': {
      verifyPmsMemberPermissions: () => assert.fail('PMS fixture must not run in this dispatch unit test')
    },
    '../fixtures/pms-tenant-isolation.mjs': {
      createPmsIsolationTenant: () => assert.fail('No tenant writes in this unit test'),
      retirePmsIsolationTenant: () => assert.fail('No tenant cleanup in this unit test'),
      verifyPmsCrossTenantInvisible: () => assert.fail('No tenant calls in this unit test')
    }
  }
  const key = `__hrmOaDispatch${++sequence}`
  globalThis[key] = injected
  let suite
  try {
    const suiteUrl = new URL('../suites/hrm-pms-oa.mjs', import.meta.url)
    const source = fs.readFileSync(suiteUrl, 'utf8')
    const body = source.replace(/from '(\.\.?\/[^']+)'/g, (_match, specifier) => {
      const mock = injected[specifier]
      assert.ok(mock, `Unexpected suite import ${specifier}`)
      const url = dataModule(Object.keys(mock).map((name) =>
        `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];`
      ).join('\n'))
      return `from ${JSON.stringify(url)}`
    })
    suite = await import(dataModule(body))
  } finally {
    delete globalThis[key]
  }
  return { suite, events, delegated, api }
}

const contextOf = (caseId) => ({
  caseId, suiteId: 'hrm-pms-oa', page: { name: 'unit-page' },
  context: { name: 'unit-browser-context' }, ctx: { name: 'unit-runner-context' },
  record: {}, caseRecord: { checks: [], notes: [], evidence: [] },
  outputDir: '/unit-only/screenshots', shotDir: '/unit-only/screenshots',
  check: { name: 'unit-check' }
})

test('shared HRM/OA dispatch forwards the original runner context and preserves every GAP field', async () => {
  for (const [caseId, name] of [['HRM-001', 'hrm'], ['OA-001', 'oa']]) {
    const h = await harness()
    assert.deepEqual(h.suite.cases, ['HRM-001', 'PMS-001', 'OA-001'])
    const context = contextOf(caseId)
    const result = await withFlags(flags, () => h.suite.runCase(context))
    assert.equal(result, h.delegated)
    assert.deepEqual(h.events.map(([type]) => type), ['guard', name])
    assert.equal(h.events[1][1], context)
    assert.equal(context.caseRecord.acceptanceComplete, false)
    assert.equal(context.caseRecord.catalogComplete, false)
    assert.equal(context.caseRecord.catalogAssertions, result.catalogAssertions)
    assert.equal(context.caseRecord.remainingAssertions, result.remainingAssertions)
    assert.deepEqual(context.caseRecord.checks, [])
  }
})

test('legacy HRM/OA read-only paths remain unchanged without both exact opt-in flags', async () => {
  const environments = [
    {}, { CFOR_E2E_WRITE_FIXTURES: 'true' }, { CFOR_HRM_OA_LOCAL_CLOSURE: 'true' },
    { CFOR_E2E_WRITE_FIXTURES: 'true', CFOR_HRM_OA_LOCAL_HEADED: '1' },
    ...['', 'false', '1', 'TRUE', 'yes'].flatMap((value) => [
      { ...flags, CFOR_HRM_OA_LOCAL_CLOSURE: value },
      { ...flags, CFOR_E2E_WRITE_FIXTURES: value }
    ])
  ]
  for (const caseId of ['HRM-001', 'OA-001']) {
    for (const env of environments) {
      const h = await harness()
      const context = contextOf(caseId)
      const result = await withFlags(env, () => h.suite.runCase(context))
      assert.equal(result.api, h.api)
      assert.equal(result.token, 'unit-token')
      assert.equal(context.caseRecord.catalogAssertions, undefined)
      assert.equal(context.caseRecord.acceptanceComplete, undefined)
      assert.ok(context.caseRecord.checks.every((row) => row.passed))
      assert.equal(context.caseRecord.evidence.length, 1)
      assert.equal(h.events.some(([type]) => ['guard', 'hrm', 'oa'].includes(type)), false)
      assert.deepEqual(h.events.filter(([type]) => type === 'get').map(([, path]) => path),
        caseId === 'HRM-001' ? [
            '/hrm/employee/page?pageNo=1&pageSize=100',
            '/hrm/employee/bound-user-id-list', '/hrm/employee/status-count'
          ] : [
            '/bpm/oa/leave/page?pageNo=1&pageSize=100',
            '/oa/meeting-room/page?pageNo=1&pageSize=100'
          ])
      assert.deepEqual(h.events.filter(([type]) => type === 'route').map(([, route]) => route),
        [caseId === 'HRM-001' ? '/hrm/employee' : '/oa'])
      assert.equal(h.events.filter(([type]) => type === 'screenshot').length, 1)
    }
  }
})

test('explicit HRM/OA closure rejects unsafe local targets before any login, API or delegation', async () => {
  for (const settings of [
    { ...local, target: 'online' }, { ...local, tenantId: '2' },
    { ...local, webBase: 'http://127.0.0.1:9151/admin' },
    { ...local, apiBase: 'http://127.0.0.1:48080' },
    { ...local, db: { ...local.db, host: '192.168.110.252' } },
    { ...local, db: { ...local.db, name: 'cfor_admin_saas_standard' } }
  ]) {
    for (const caseId of ['HRM-001', 'OA-001']) {
      const h = await harness(settings)
      await withFlags(flags, () => assert.rejects(h.suite.runCase(contextOf(caseId)), /BLOCKED/))
      assert.deepEqual(h.events, [['guard']])
    }
  }
})

test('nonlocal legacy reads are not rejected by the local-write-only guard', async () => {
  for (const caseId of ['HRM-001', 'OA-001']) {
    const h = await harness({ ...local, target: 'online' })
    await withFlags({ CFOR_E2E_WRITE_FIXTURES: 'true' },
      () => h.suite.runCase(contextOf(caseId)))
    assert.equal(h.events.some(([type]) => type === 'guard'), false)
    assert.equal(h.events.filter(([type]) => type === 'login').length, 1)
  }
})

test('delegated HRM/OA failures propagate unchanged with no fallback to old reads', async () => {
  for (const caseId of ['HRM-001', 'OA-001']) {
    const failure = new Error('unit-only fixture failure')
    const h = await harness(local, { dispatchError: failure })
    await withFlags(flags, () => assert.rejects(h.suite.runCase(contextOf(caseId)),
      (error) => error === failure))
    assert.equal(h.events.some(([type]) => ['login', 'api', 'get'].includes(type)), false)
  }
})

test('PMS initialization, original core and error finalization are unaffected by HRM/OA flags', async () => {
  const failure = new Error('unit-only PMS core entered')
  const h = await harness({ ...local, target: 'online', tenantId: '2' }, { loginError: failure })
  const context = contextOf('PMS-001')
  await withFlags(flags, () => assert.rejects(h.suite.runCase(context),
    (error) => error === failure))
  assert.deepEqual(h.events, [['login', context.page]])
  assert.deepEqual(context.caseRecord.catalogAssertions.map((row) => row.assertion),
    h.suite.PMS_CATALOG_ASSERTIONS)
  assert.ok(context.caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
  assert.equal(context.caseRecord.catalogComplete, false)
  assert.deepEqual(context.caseRecord.remainingAssertions, h.suite.PMS_CATALOG_ASSERTIONS)
  assert.equal(context.caseRecord.notes.length, 5)
})
