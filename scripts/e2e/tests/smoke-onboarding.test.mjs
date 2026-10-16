import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSmokeOnboardingPackage,
  runSmokeOnboardingEvidence,
  smokeFreshLoginFact
} from '../fixtures/smoke-onboarding.mjs'
import {
  ENTERPRISE_ISOLATION_COMPONENTS,
  ENTERPRISE_ISOLATION_PERMISSIONS
} from '../fixtures/enterprise-isolation.mjs'

const input = () => ({
  logins: [{ code: 0, status: 200, tenantId: '9007199254740995', tokenMatches: true }],
  auth: { tenantId: '9007199254740995' }, tenantId: '9007199254740995',
  state: { code: 0, data: { currentStep: 1, industryTemplate: null } },
  info: { onboardingRequired: true }, route: '/systemInit/index', visible: true
})

test('fresh login requires one real successful response, exact private tenant and genuine unconfirmed landing', () => {
  assert.equal(smokeFreshLoginFact(input()), true)
  for (const change of [
    (value) => { value.logins = [] },
    (value) => { value.logins.push({ ...value.logins[0] }) },
    (value) => { value.logins[0].code = '0' },
    (value) => { value.logins[0].status = 500 },
    (value) => { value.logins[0].tokenMatches = false },
    (value) => { value.logins[0].tenantId = '1' },
    (value) => { value.auth.tenantId = '1' },
    (value) => { value.tenantId = '1' },
    (value) => { value.state.data.currentStep = 2 },
    (value) => { value.state.data.industryTemplate = 'trade' },
    (value) => { value.info.onboardingRequired = false },
    (value) => { value.route = '/index' },
    (value) => { value.visible = 'true' }
  ]) {
    const value = input()
    change(value)
    assert.equal(smokeFreshLoginFact(value), false)
  }
})

const packageInput = () => {
  const menus = [
    { id: '1', parentId: '0', status: 0 },
    ...ENTERPRISE_ISOLATION_COMPONENTS.map((component, index) => ({
      id: String(index + 2), parentId: '1', status: 0, component
    })),
    ...[...ENTERPRISE_ISOLATION_PERMISSIONS, 'system:system-init:query'].map((permission, index) => ({
      id: String(index + 100),
      parentId: permission === 'system:system-init:query'
        ? String(ENTERPRISE_ISOLATION_COMPONENTS.indexOf('system/systemInit/index') + 2) : '1',
      status: 0, permission
    }))
  ]
  return {
    menus, assignableMenus: menus,
    standardPackage: { id: '111', status: 0, menuIds: menus.map((menu) => menu.id) }
  }
}

test('private onboarding package adds only the exact enabled query permission within standard authorization', () => {
  const value = packageInput()
  const baseline = structuredClone(value)
  const result = buildSmokeOnboardingPackage(value)
  assert.ok(result.menuIds.includes(value.menus.at(-1).id))
  assert.deepEqual(value, baseline)
  const pagePermission = packageInput()
  pagePermission.menus.find((menu) => menu.component === 'system/systemInit/index')
    .permission = 'system:system-init:query'
  assert.doesNotThrow(() => buildSmokeOnboardingPackage(pagePermission))
  for (const change of [
    (value) => { value.menus.at(-1).status = 1 },
    (value) => { value.standardPackage.menuIds.pop() },
    (value) => { value.assignableMenus = value.assignableMenus.slice(0, -1) },
    (value) => { value.menus.push({ ...value.menus.at(-1), id: '999' }) }
  ]) {
    const value = packageInput()
    change(value)
    assert.throws(() => buildSmokeOnboardingPackage(value), /onboarding/)
  }
})

function setup (change = {}) {
  const value = input()
  const context = { caseRecord: { checks: [], notes: [] }, record: {} }
  const log = []
  let callbackFinished = false
  const rows = (tenantId, currentStep = 1) => ({
    id: '1000', tenant_id: tenantId, deleted: '0', current_step: String(currentStep)
  })
  let snapshots = 0
  return {
    context, primaryApi: {}, outputDir: '/mock-only',
    dependencies: {
      writeEnabled: true, logins: value.logins,
      async readSql (sql) {
        log.push(sql)
        assert.match(sql.trim(), /^SELECT/)
        if (change.sqlUnavailable) return { available: false, rows: [] }
        if (sql.includes('information_schema')) return { available: true, rows:
          Object.keys(rows('1')).map((key) => [key, key === 'deleted' ? 'bit' : 'varchar']) }
        if (sql.includes('system_oauth2_access_token')) return { available: true,
          rows: [['access', change.tokensRemain ? '1' : '0'], ['refresh', '0']] }
        const tenantId = sql.match(/tenant_id=(\d+)/)[1]
        snapshots++
        return { available: true, rows: [[JSON.stringify(rows(tenantId,
          change.sharedChanged && tenantId === '1' && snapshots > 1 ? 3 : 1))]] }
      },
      async isolate (options) {
        assert.equal(options.packagePlan, buildSmokeOnboardingPackage)
        if (change.isolateFailure) throw new Error('tenant create failure')
        await options.verifyEnterprisePage({
          tenantId: value.tenantId, userId: '9007199254740996',
          auth: value.auth, info: change.confirmed ? { onboardingRequired: false } : value.info,
          page: { url: () => `http://localhost${change.wrongRoute ? '/index' : value.route}`,
            locator: () => ({ first: () => ({
              waitFor: async () => {}, isVisible: async () => true
            }) }) },
          api: { getBusiness: async () => value.state }
        })
        callbackFinished = true
        if (change.cleanupFailure) throw new Error('tenant retirement failure')
        return { executed: true }
      },
      screenshot: async () => log.push('screenshot')
    },
    log, callbackFinished: () => callbackFinished
  }
}

test('private branch keeps full shared state, verifies token retirement and then adds the original check', async () => {
  const value = setup()
  const result = await runSmokeOnboardingEvidence(value)
  assert.equal(result.executed, true)
  assert.equal(value.callbackFinished(), true)
  assert.deepEqual(value.context.caseRecord.checks.map((check) => check.passed), [true, true, true])
  assert.equal(value.context.caseRecord.checks.at(-1).name, '未确认初始化真实登录进入引导中心')
})

for (const change of [
  { sqlUnavailable: true }, { isolateFailure: true }, { cleanupFailure: true },
  { confirmed: true }, { wrongRoute: true }, { sharedChanged: true }, { tokensRemain: true }
]) {
  test(`missing/contradictory or unsafe evidence never adds a verified original branch: ${JSON.stringify(change)}`, async () => {
    const value = setup(change)
    await assert.rejects(() => runSmokeOnboardingEvidence(value))
    assert.equal(value.context.caseRecord.checks.some((check) =>
      check.name === '未确认初始化真实登录进入引导中心'), false)
  })
}

test('write opt-in disabled leaves an explicit GAP and performs no SQL or tenant writes', async () => {
  const value = setup()
  value.dependencies.writeEnabled = false
  assert.deepEqual(await runSmokeOnboardingEvidence(value), { executed: false })
  assert.equal(value.log.length, 0)
  assert.match(value.context.caseRecord.notes[0], /GAP/)
})
