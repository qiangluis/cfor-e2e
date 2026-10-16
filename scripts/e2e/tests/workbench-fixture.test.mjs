import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WORKBENCH_CASE_PERMISSIONS,
  WORKBENCH_FIXTURE_CASES,
  WORKBENCH_WRITE_FIXTURE_ENV,
  assertLocalWorkbenchWriteTarget,
  inspectWorkbenchFixtureTarget,
  inspectWorkbenchReadGate,
  isWorkbenchWriteFixturesEnabled,
  resolveWorkbenchReadGate,
  workbenchReadBlockNote
} from '../workbenchhelper/fixture.mjs'
import { runCase } from '../suites/workbench.mjs'
import { caseOutcome } from '../lib/report.mjs'

const validTarget = {
  target: 'local',
  webBase: 'http://127.0.0.1:9151',
  apiBase: 'http://127.0.0.1:48083',
  tenantId: '1',
  tenantName: 'CFOR 标准平台'
}

const readPermissions = WORKBENCH_CASE_PERMISSIONS['WBF-004']

function permissionPayload (permissions = readPermissions) {
  return {
    code: 0,
    data: {
      user: { id: 7 },
      permissions
    }
  }
}

function menuPayload (permissions = readPermissions) {
  return {
    code: 0,
    data: permissions.map((permission, index) => ({
      id: index + 1,
      permission,
      status: 0,
      children: []
    }))
  }
}

test('workbench write fixtures require exact opt-in and do not inherit truthy values', () => {
  assert.equal(WORKBENCH_WRITE_FIXTURE_ENV, 'CFOR_E2E_WRITE_FIXTURES')
  assert.equal(isWorkbenchWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: 'true' }), true)
  assert.equal(isWorkbenchWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: 'TRUE' }), false)
  assert.equal(isWorkbenchWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: '1' }), false)
  assert.equal(isWorkbenchWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: 'yes' }), false)
  assert.equal(isWorkbenchWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: 'false' }), false)
  assert.equal(isWorkbenchWriteFixturesEnabled({}), false)
})

test('workbench write fixture scope rejects non-local endpoints, wrong ports, and non-tenant-1', () => {
  assert.doesNotThrow(() => assertLocalWorkbenchWriteTarget(validTarget))
  assert.throws(
    () => assertLocalWorkbenchWriteTarget({ ...validTarget, target: 'production' }),
    /仅允许 local/
  )
  assert.throws(
    () => assertLocalWorkbenchWriteTarget({ ...validTarget, webBase: 'http://127.0.0.1:9152' }),
    /前端必须是 loopback:9151/
  )
  assert.throws(
    () => assertLocalWorkbenchWriteTarget({ ...validTarget, apiBase: 'http://127.0.0.1:48082' }),
    /后端必须是 loopback:48083/
  )
  assert.throws(
    () => assertLocalWorkbenchWriteTarget({ ...validTarget, tenantId: '2' }),
    /租户 1/
  )
  assert.throws(
    () => assertLocalWorkbenchWriteTarget({ ...validTarget, tenantName: '其他租户' }),
    /租户 1/
  )
})

test('case permissions match invoked read controllers and never bind report writes globally', () => {
  assert.deepEqual(
    [...WORKBENCH_FIXTURE_CASES].sort(),
    ['WBF-004', 'WBF-005', 'WBF-008', 'WBF-009', 'WBF-012']
  )
  assert.deepEqual(WORKBENCH_CASE_PERMISSIONS['WBF-005'], [])
  assert.deepEqual(WORKBENCH_CASE_PERMISSIONS['WBF-009'], [])
  for (const caseId of ['WBF-004', 'WBF-008', 'WBF-012']) {
    assert.deepEqual(WORKBENCH_CASE_PERMISSIONS[caseId],
      ['pm:daily-report:query', 'crm:work-report:query'])
  }
  assert.equal(Object.values(WORKBENCH_CASE_PERMISSIONS).flat()
    .some((permission) => /:(create|update|delete|submit|save)$/.test(permission)), false)
})

test('daily-report project-dependent enhancements stay blocked until membership and reporter ownership are proven', async () => {
  const { WORKBENCH_FIXTURE_DEPENDENCIES } = await import('../workbenchhelper/contracts.mjs')
  for (const caseId of ['WBF-004', 'WBF-008', 'WBF-012']) {
    const blockers = WORKBENCH_FIXTURE_DEPENDENCIES[caseId].projectDependentEnhancements.join('；')
    assert.match(blockers, /项目成员、填报人归属及数据权限校验/)
  }
})

for (const caseId of ['WBF-005', 'WBF-009']) {
  test(`${caseId} is readable without any report or portal-management permission`, () => {
    const gate = resolveWorkbenchReadGate({
      caseId,
      permissionPayload: permissionPayload([]),
      menuPayload: { code: 403 }
    })
    assert.equal(gate.allowed, true)
    assert.equal(gate.readOnly, true)
    assert.deepEqual(gate.missing, [])
  })
}

for (const caseId of ['WBF-004', 'WBF-008', 'WBF-012']) {
  test(`${caseId} allows report reads with query permissions alone`, () => {
    const gate = resolveWorkbenchReadGate({
      caseId, permissionPayload: permissionPayload(), menuPayload: menuPayload()
    })
    assert.equal(gate.allowed, true)
    assert.equal(gate.userId, 7)
    assert.deepEqual(gate.missing, [])
  })

  test(`${caseId} diagnoses a missing CRM query seed without widening permissions`, () => {
    const gate = resolveWorkbenchReadGate({
      caseId,
      permissionPayload: permissionPayload(['pm:daily-report:query']),
      menuPayload: menuPayload(['pm:daily-report:query'])
    })
    assert.equal(gate.allowed, false)
    assert.deepEqual(gate.missingPermissions, ['crm:work-report:query'])
    assert.deepEqual(gate.missingMenuDefinitions, ['crm:work-report:query'])
    assert.equal(gate.diagnostics[1].state, 'menu-missing')
    assert.match(workbenchReadBlockNote(gate), /菜单缺 seed/)
  })
}

test('enabled menu without an auth grant is not diagnosed as a missing seed', () => {
  const gate = resolveWorkbenchReadGate({
    caseId: 'WBF-004',
    permissionPayload: permissionPayload(['pm:daily-report:query']),
    menuPayload: menuPayload()
  })
  assert.equal(gate.allowed, false)
  assert.equal(gate.diagnostics[1].state, 'permission-unassigned')
  assert.deepEqual(gate.missingMenuDefinitions, [])
})

test('nested menu definitions, disabled menus, and wrong permission strings are distinguished', () => {
  const disabled = menuPayload()
  disabled.data[1].status = 1
  const gate = resolveWorkbenchReadGate({
    caseId: 'WBF-004',
    permissionPayload: permissionPayload(['pm:daily-report:query']),
    menuPayload: { code: 0, data: [{ id: 29610005, children: disabled.data }] }
  })
  assert.equal(gate.diagnostics[1].state, 'menu-disabled')
  assert.deepEqual(gate.missingMenuDefinitions, [])

  const mismatch = resolveWorkbenchReadGate({
    caseId: 'WBF-004',
    permissionPayload: permissionPayload(['pm:daily-report:query', 'crm:workreport:query']),
    menuPayload: menuPayload(['pm:daily-report:query', 'crm:workreport:query'])
  })
  assert.equal(mismatch.allowed, false)
  assert.equal(mismatch.diagnostics[1].state, 'permission-code-mismatch')
  assert.deepEqual(mismatch.diagnostics[1].similar, ['crm:workreport:query'])
  assert.deepEqual(mismatch.missing, ['crm:work-report:query'])
})

test('menu inspection failure cannot block otherwise authorized read cases', () => {
  const gate = resolveWorkbenchReadGate({
    caseId: 'WBF-004',
    permissionPayload: permissionPayload(),
    menuPayload: { code: 403 }
  })
  assert.equal(gate.allowed, true)
  assert.ok(gate.diagnostics.every(({ state }) => state === 'menu-unverified'))
})

test('HTTP-200 business errors and invalid auth structures cannot open a read gate', () => {
  const gate = resolveWorkbenchReadGate({
    caseId: 'WBF-009',
    permissionPayload: { code: 500, data: {} },
    menuPayload: menuPayload()
  })
  assert.equal(gate.allowed, false)
  assert.deepEqual(gate.missing, ['有效的当前用户权限响应'])
  for (const payload of [
    permissionPayload([null]),
    { code: 0, data: { user: { id: 0 }, permissions: [] } },
    { code: 0, data: { user: { id: 7 }, permissions: null } }
  ]) {
    assert.equal(resolveWorkbenchReadGate({
      caseId: 'WBF-009', permissionPayload: payload
    }).allowed, false)
  }
})

test('super_admin role alone is not substituted for frontend canQuery permissions', () => {
  const payload = permissionPayload(['pm:daily-report:query'])
  payload.data.roles = ['super_admin']
  const gate = resolveWorkbenchReadGate({
    caseId: 'WBF-004', permissionPayload: payload, menuPayload: menuPayload()
  })
  assert.equal(gate.allowed, false)
  assert.equal(gate.unrestricted, false)
})

test('only an explicit frontend wildcard permits all report read permissions', () => {
  const gate = resolveWorkbenchReadGate({
    caseId: 'WBF-004', permissionPayload: permissionPayload(['*:*:*'])
  })
  assert.equal(gate.allowed, true)
  assert.equal(gate.unrestricted, true)
  assert.equal(resolveWorkbenchReadGate({
    caseId: 'WBF-unknown', permissionPayload: permissionPayload(['*:*:*'])
  }).allowed, false)
})

test('menu lookup is diagnostic-only and not requested for WBF-005 or WBF-009', async () => {
  for (const caseId of ['WBF-005', 'WBF-009', 'WBF-004']) {
    const paths = []
    const gate = await inspectWorkbenchReadGate({
      caseId,
      api: {
        get: async (path) => {
          paths.push(path)
          assert.equal(path, '/system/auth/get-permission-info')
          return permissionPayload(caseId === 'WBF-004' ? readPermissions : [])
        }
      }
    })
    assert.equal(gate.allowed, true)
    assert.deepEqual(paths, ['/system/auth/get-permission-info'])
  }
})

test('missing report permission requests menu diagnosis but never requests business writes', async () => {
  const paths = []
  const gate = await inspectWorkbenchReadGate({
    caseId: 'WBF-008',
    api: {
      get: async (path) => {
        paths.push(path)
        return path === '/system/auth/get-permission-info'
          ? permissionPayload(['pm:daily-report:query'])
          : menuPayload(['pm:daily-report:query'])
      }
    }
  })
  assert.equal(gate.allowed, false)
  assert.deepEqual(paths, ['/system/auth/get-permission-info', '/system/menu/list'])
  assert.match(gate.reason, /菜单缺 seed/)
})

test('fixture tenant identity requires both login context and formal named-tenant lookup', async () => {
  const paths = []
  const api = {
    get: async (path) => {
      paths.push(path)
      return { code: 0, data: '1' }
    }
  }
  assert.equal((await inspectWorkbenchFixtureTarget({
    api, settings: validTarget, sessionTenantId: '2'
  })).allowed, false)
  assert.deepEqual(paths, [])
  assert.equal((await inspectWorkbenchFixtureTarget({
    api, settings: validTarget, sessionTenantId: '1'
  })).allowed, true)
  assert.equal(paths.length, 1)
  assert.match(paths[0], /get-id-by-name/)
  for (const payload of [{ code: 0, data: '2' }, { code: 403, data: '1' }]) {
    assert.equal((await inspectWorkbenchFixtureTarget({
      api: { get: async () => payload }, settings: validTarget, sessionTenantId: '1'
    })).allowed, false)
  }
})

function portalFixture ({ env = {}, permissions = [] } = {}) {
  const events = []
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const locator = (selector) => ({
    first () { return this },
    waitFor: async () => {},
    isVisible: async () => true
  })
  const api = {
    get: async (path) => {
      events.push(`GET:${path}`)
      if (path.startsWith('/system/tenant/get-id-by-name')) return { code: 0, data: '1' }
      assert.equal(path, '/system/auth/get-permission-info')
      return permissionPayload(permissions)
    },
    post: async () => assert.fail('Unexpected POST'),
    put: async () => assert.fail('Unexpected PUT'),
    delete: async () => assert.fail('Unexpected DELETE')
  }
  const dependencies = {
    env,
    workbenchConfig: validTarget,
    login: async (_page, options) => options.returnContext
      ? { token: 'unit-token', tenantId: '1' } : 'unit-token',
    createApiClient: () => api,
    openRoute: async () => events.push('navigate'),
    saveScreenshot: async () => events.push('screenshot')
  }
  const page = {
    locator,
    url: () => 'http://127.0.0.1:9151/index'
  }
  return { page, caseRecord, dependencies, events }
}

  test('WBF-009 default path stays read-only without report grants', async () => {
    const fixture = portalFixture({
      env: {}
    })
    const result = await runCase({
      caseId: 'WBF-009', page: fixture.page, caseRecord: fixture.caseRecord,
      record: {}, outputDir: '/unit-only'
    }, fixture.dependencies)
    assert.ok(fixture.events.includes('navigate'))
    assert.ok(fixture.events.includes('screenshot'))
    assert.equal(fixture.caseRecord.checks.length, 3)
    assert.ok(fixture.caseRecord.checks.every(({ passed }) => passed))
    assert.equal(caseOutcome({
      failedChecks: [], hasAssertions: true, result
    }).status, 'PARTIAL')
    assert.match(result.note, /未验证专属角色/)
    assert.equal(fixture.events.some((event) => event.includes('/system/menu/list')), false)
  })

for (const caseId of WORKBENCH_FIXTURE_CASES) {
  test(`${caseId} explicit opt-in delegates to the owned fixture, not the read-only gate`, async () => {
    const fixture = portalFixture({ env: { CFOR_E2E_WRITE_FIXTURES: 'true' } })
    fixture.dependencies.runOwnedWorkbenchCase = async (context, tools) => {
      fixture.events.push('owned')
      assert.equal(context.caseId, caseId)
      assert.equal(context.sessionTenantId, '1')
      assert.equal(tools.env.CFOR_E2E_WRITE_FIXTURES, 'true')
      assert.equal(tools.runReadOnlyCase, runCase)
      assert.equal(typeof tools.readBrowserResponsePayload, 'function')
      return { partial: true, note: 'unit-only delegated write fixture' }
    }
    const result = await runCase({
      caseId, page: fixture.page, caseRecord: fixture.caseRecord, record: {}, outputDir: '/unit-only'
    }, fixture.dependencies)
    assert.equal(result.partial, true)
    assert.deepEqual(fixture.events, [
      'GET:/system/tenant/get-id-by-name?name=CFOR%20%E6%A0%87%E5%87%86%E5%B9%B3%E5%8F%B0',
      'owned'
    ])
  })
}

test('opt-in cannot enter an owned fixture with an unverified tenant session', async () => {
  const fixture = portalFixture({ env: { CFOR_E2E_WRITE_FIXTURES: 'true' } })
  fixture.dependencies.login = async () => ({ token: 'unit-token', tenantId: '2' })
  fixture.dependencies.runOwnedWorkbenchCase = async () => assert.fail('Must not create fixtures')
  const result = await runCase({
    caseId: 'WBF-009', page: fixture.page, caseRecord: fixture.caseRecord, record: {}, outputDir: '/unit-only'
  }, fixture.dependencies)
  assert.equal(result.partial, true)
  assert.match(result.note, /租户 1/)
  assert.deepEqual(fixture.events, [])
})

test('WBF-004 default missing query retains precise PARTIAL diagnosis', async () => {
  const fixture = portalFixture({
    env: {},
    permissions: ['pm:daily-report:query']
  })
  fixture.dependencies.createApiClient = () => ({
    get: async (path) => {
      fixture.events.push(`GET:${path}`)
      if (path.startsWith('/system/tenant/get-id-by-name')) return { code: 0, data: '1' }
      if (path === '/system/auth/get-permission-info') return permissionPayload(['pm:daily-report:query'])
      assert.equal(path, '/system/menu/list')
      return menuPayload(['pm:daily-report:query'])
    }
  })
  const result = await runCase({
    caseId: 'WBF-004', page: fixture.page, caseRecord: fixture.caseRecord,
    record: {}, outputDir: '/unit-only'
  }, fixture.dependencies)
  assert.equal(result.partial, true)
  assert.match(result.note, /crm:work-report:query：菜单缺 seed/)
  assert.equal(fixture.events.includes('navigate'), false)
  const evidence = JSON.parse(fixture.caseRecord.evidence[0])
  assert.deepEqual(evidence.missingPermissions, ['crm:work-report:query'])
  assert.equal(evidence.readOnly, true)
})
