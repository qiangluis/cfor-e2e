import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import {
  MAINTENANCE_ISOLATION_PERMISSIONS,
  buildMaintenanceIsolationPackage,
  createMaintenanceIsolationTenant,
  createMaintenanceIsolationDevice,
  disableMaintenanceIsolationAccount,
  retireMaintenanceIsolationTenant,
  runMaintenanceTenantIsolation,
  prepareMaintenanceIsolationDeviceScope,
  verifyMaintenanceIsolationIdentity
} from '../fixtures/maintenance-tenant-isolation.mjs'
import { createFixtureCleanup, runCase } from '../suites/iot-maintenance.mjs'

const envelope = (data) => ({ code: 0, data })
let previousWriteFlag
before(() => {
  previousWriteFlag = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
})
after(() => {
  if (previousWriteFlag === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
  else process.env.CFOR_E2E_WRITE_FIXTURES = previousWriteFlag
})
const menuFixture = () => [
  { id: '10', parentId: '0', status: 0 },
  ...['iot/product/product/index', 'iot/device/device/index', 'iot/maintenance/repair-order/index']
    .map((component, index) => ({
      id: String(20 + index), parentId: '10', status: 0, component,
      permission: index === 2 ? 'system:order:list' : ''
    })),
  ...MAINTENANCE_ISOLATION_PERMISSIONS.filter((permission) => permission !== 'system:order:list')
    .map((permission, index) => ({ id: String(30 + index), parentId: '20', status: 0, permission })),
  ...['system/tenant-workbench/index', 'system/user/index', 'system/role/index',
    'system/dept/index', 'system/enterprise-organization/index', 'system/systemInit/index']
    .map((component, index) => ({ id: String(100 + index), parentId: '10', component, status: 0 })),
  { id: '110', parentId: '101', status: 0, permission: 'system:user:query' },
  { id: '111', parentId: '102', status: 0, permission: 'sensitive:amount:view' },
  ...['system:dept:create', 'system:dept:query', 'system:dept:update',
    'system:role:create', 'system:role:query', 'system:role:update',
    'system:permission:assign-user-role', 'system:permission:assign-role-data-scope',
    'system:permission:assign-role-menu']
    .map((permission, index) => ({ id: String(120 + index), parentId: '102', status: 0, permission })),
  { id: '90', parentId: '10', status: 0, permission: 'mes:repair-order:dispatch' }
]
const packageFixture = (menus = menuFixture()) => ({ id: '111', status: 0, menuIds: menus.map((menu) => menu.id) })
const fixtureOf = () => {
  const plan = buildMaintenanceIsolationPackage({ standardPackage: packageFixture(), menus: menuFixture() })
  return {
    tenantId: '902', packageId: '901', userId: '903',
    tenant: { id: '902', name: 'E2E M4 ISO TEN UNIT', username: 'e2em4unit', password: 'Unit!123' },
    tenantPayload: { name: 'E2E M4 ISO TEN UNIT', username: 'e2em4unit', status: 0, packageId: '901' },
    packagePayload: { name: 'E2E M4 ISO PKG UNIT', status: 0, menuIds: plan.menuIds },
    plan
  }
}
const recordOf = () => ({ checks: [], evidence: [], notes: [] })
const authOf = (tenantId = '902') => ({ token: 'tenant-token', tenantId })
const platformIdentityApi = api => ({
  ...api,
  async getBusiness (path, options) {
    if (path === '/system/user/profile/get') {
      return envelope({ id: '905', username: 'platform-admin' })
    }
    if (path === '/system/auth/get-permission-info') {
      return envelope({ user: { id: '905', username: 'platform-admin' }, roles: ['super_admin'], permissions: [] })
    }
    return api.getBusiness(path, options)
  }
})
const identityApi = (fixture, override = {}) => ({
  async getBusiness (path) {
    if (path === '/system/user/profile/get') return envelope({
      id: fixture.userId, username: fixture.tenant.username, roles: [{ id: '904', name: '租户管理员' }]
    })
    if (path === '/system/auth/get-permission-info') return envelope({
      user: { id: fixture.userId, username: fixture.tenant.username },
      roles: ['tenant_admin'],
      permissions: [...fixture.plan.permissions, ...fixture.plan.bootstrapPermissions], ...override
    })
    if (path === '/system/role/get?id=904') return envelope({
      id: '904', code: 'tenant_admin', type: 1, status: 0, dataScope: 5
    })
    return envelope({ list: [], total: 0 })
  }
})

function scopeApiHarness (fixture = fixtureOf(), mutateScope) {
  const state = {
    adminRole: { id: '904', code: 'tenant_admin', type: 1, status: 0, dataScope: 5 },
    department: null, role: null, roleIds: ['904'], menus: [], deptId: null, userStatus: 0, events: [],
    platformProfile: { id: '905', username: 'platform-admin' },
    platformInfo: { user: { id: '905', username: 'platform-admin' }, roles: ['super_admin'], permissions: [] },
    platformTenant: { ...fixture.tenantPayload, id: fixture.tenantId },
    platformPackage: { ...fixture.packagePayload, id: fixture.packageId }
  }
  const visiting = options => {
    if (!options?.headers) return false
    assert.deepEqual(options.headers, { 'visit-tenant-id': fixture.tenantId })
    return true
  }
  const departmentVisible = options => visiting(options)
    ? !state.hideProvisionDepartment
    : !state.hideDepartment && state.roleIds.includes(state.role?.id) &&
      state.role?.status === 0 && state.role.dataScope === 2 &&
      state.role.dataScopeDeptIds.includes(state.department?.id)
  const api = {
    async getBusiness (path, options) {
      state.events.push(['GET', path, undefined, options])
      const roles = state.roleIds.filter(id => id === '904' || state.role?.status === 0)
      if (path === '/system/user/profile/get') return envelope({
        id: '903', username: fixture.tenant.username, roles: roles.map(id => ({ id })),
        dept: state.deptId == null ? null : { id: state.deptId }
      })
      if (path === '/system/auth/get-permission-info') return envelope({
        user: { id: '903', username: fixture.tenant.username, deptId: state.deptId },
        roles: roles.map(id => id === '904' ? 'tenant_admin' : state.role.code),
        permissions: [...fixture.plan.permissions, ...fixture.plan.bootstrapPermissions]
      })
      if (path.startsWith('/system/user/get?')) return envelope({
        id: '903', username: fixture.tenant.username, status: state.userStatus
      })
      if (path.startsWith('/system/role/get?')) return envelope(
        path.endsWith('=904') ? state.adminRole : state.role
      )
      if (path.startsWith('/system/dept/get?')) return envelope(departmentVisible(options) ? state.department : null)
      if (path.startsWith('/system/permission/list-role-menus?')) return envelope(state.menus)
      if (/^\/(?:iot|mes)\//.test(path)) return envelope({ list: [], total: 0 })
      assert.fail(`unexpected scope GET ${path}`)
    },
    async postBusiness (path, body, options) {
      state.events.push(['POST', path, structuredClone(body), options])
      if (path === '/system/dept/create') {
        state.department = { ...body, id: '56', tenantId: fixture.tenantId,
          creator: visiting(options) ? state.platformProfile.id : fixture.userId, deleted: 0 }
        return envelope('56')
      }
      if (path === '/system/role/create') {
        state.role = { ...body, id: '57', tenantId: fixture.tenantId, type: 2, dataScope: 5, dataScopeDeptIds: [] }
        return envelope('57')
      }
      if (path === '/system/permission/assign-role-data-scope') {
        assert.equal(body.roleId, '57')
        assert.equal(body.dataScope, 2)
        assert.deepEqual(body.dataScopeDeptIds, ['56'])
        if (!state.department || state.department.tenantId !== fixture.tenantId ||
            state.department.creator !== state.platformProfile.id) {
          throw new Error('400: 数据范围包含不存在或不属于当前租户的部门')
        }
        Object.assign(state.role, { dataScope: body.dataScope, dataScopeDeptIds: body.dataScopeDeptIds })
        mutateScope?.(state)
        return envelope(true)
      }
      if (path === '/system/permission/assign-user-role') {
        assert.equal(body.userId, '903')
        state.roleIds = [...body.roleIds]
        return envelope(true)
      }
      if (path.endsWith('/login-encrypted')) return envelope({
        tenantId: fixture.tenantId, accessToken: 'own-cleanup-token'
      })
      if (path.endsWith('/logout')) return envelope(true)
      assert.fail(`unexpected scope POST ${path}`)
    },
    async putBusiness (path, body, options) {
      state.events.push(['PUT', path, structuredClone(body), options])
      if (path === '/system/dept/update') Object.assign(state.department, body)
      else if (path === '/system/role/update') Object.assign(state.role, body)
      else if (path === '/system/user/update-status') state.userStatus = body.status
      else assert.fail(`unexpected scope PUT ${path}`)
      return envelope(true)
    }
  }
  const provisionPaths = /^\/system\/(?:dept\/(?:create|get\?|update)|role\/(?:create|get\?|update)|permission\/(?:list-role-menus\?|assign-role-data-scope|assign-user-role))/
  const platformApi = {
    async getBusiness (path, options) {
      if (visiting(options)) {
        assert.match(path, provisionPaths, 'platform visit must not execute IoT/MES business')
        return api.getBusiness(path, options)
      }
      state.events.push(['PLATFORM_GET', path])
      if (path === '/system/user/profile/get') return envelope(state.platformProfile)
      if (path === '/system/auth/get-permission-info') return envelope(state.platformInfo)
      if (path === `/system/tenant/get?id=${fixture.tenantId}`) return envelope(state.platformTenant)
      if (path === `/system/tenant-package/get?id=${fixture.packageId}`) return envelope(state.platformPackage)
      assert.fail(`unexpected platform GET ${path}`)
    },
    async postBusiness (path, body, options) {
      assert.equal(visiting(options), true)
      assert.match(path, provisionPaths, 'platform visit must not execute IoT/MES business')
      return api.postBusiness(path, body, options)
    },
    async putBusiness (path, body, options) {
      assert.equal(visiting(options), true)
      assert.match(path, provisionPaths, 'platform visit must not execute IoT/MES business')
      return api.putBusiness(path, body, options)
    }
  }
  const dependencies = {
    platformApi,
    async runReadOnlySql (sql) {
      state.events.push(['SQL', sql])
      assert.match(sql, /^\s*SELECT id, tenant_id, code, name, parent_id, status, CAST\(deleted AS UNSIGNED\), creator/)
      assert.match(sql, /FROM system_dept/)
      assert.match(sql, new RegExp(`WHERE tenant_id = ${fixture.tenantId} AND id = 56\\b`))
      assert.match(sql, new RegExp(`AND code = '${state.department.code}' AND name = '${state.department.name}'`))
      assert.match(sql, /AND deleted = 0\s+LIMIT 2/)
      assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|REPLACE|ALTER|DROP)\b/i)
      const row = state.department
      return { available: true, rows: [[row.id, row.tenantId, row.code, row.name,
        String(row.parentId), String(row.status), String(row.deleted), row.creator]] }
    }
  }
  return { api, platformApi, state, fixture, dependencies }
}

test('maintenance isolation package selects only required package-111 menus and complete parents', () => {
  const menus = menuFixture()
  const plan = buildMaintenanceIsolationPackage({ standardPackage: packageFixture(menus), menus })
  assert.ok(plan.menuIds.includes('10'))
  assert.ok(plan.menuIds.includes('22'))
  assert.equal(plan.menuIds.includes('90'), false)
  assert.deepEqual([...plan.permissions].sort(), [...MAINTENANCE_ISOLATION_PERMISSIONS].sort())
})

test('an existing required ancestor permission is included without adding its unrelated children', () => {
  const menus = menuFixture()
  menus[0].permission = 'system:settings:query'
  const plan = buildMaintenanceIsolationPackage({ standardPackage: packageFixture(menus), menus })
  assert.ok(plan.permissions.includes('system:settings:query'))
  assert.equal(plan.menuIds.includes('90'), false)
  assert.equal(plan.permissions.includes('mes:repair-order:dispatch'), false)
})

test('automatic tenant-admin bootstrap permissions are predicted exactly but never added to the dedicated package', () => {
  const menus = menuFixture()
  const plan = buildMaintenanceIsolationPackage({ standardPackage: packageFixture(menus), menus })
  assert.ok(plan.bootstrapPermissions.includes('sensitive:amount:view'))
  assert.ok(plan.bootstrapPermissions.includes('system:permission:assign-role-data-scope'))
  assert.ok(plan.bootstrapPermissions.includes('system:user:query'))
  assert.equal(plan.menuIds.includes('110'), false)
  assert.equal(plan.menuIds.includes('111'), false)
  assert.equal(plan.permissions.includes('sensitive:amount:view'), false)
})

test('missing/disabled permission, ancestor, assignability, cycle and disabled source block before writes', async () => {
  const mutations = [
    (menus, source) => { source.status = 1 },
    (menus) => { menus.splice(menus.findIndex((row) => row.permission === 'mes:maintenance-plan:publish'), 1) },
    (menus) => { menus[0].status = 1 },
    (menus) => { menus[0].deleted = 1 },
    (menus, source) => { source.menuIds = source.menuIds.filter((id) => id !== '10') },
    (menus) => { menus[0].parentId = '999' },
    (menus) => { menus[0].parentId = '20' },
    (menus) => { menus[0].permission = '*:*:*' }
  ]
  for (const mutate of mutations) {
    const menus = menuFixture()
    const source = packageFixture(menus)
    mutate(menus, source)
    const writes = []
    await assert.rejects(createMaintenanceIsolationTenant(platformIdentityApi({
      async getBusiness (path) {
        return envelope(path.includes('tenant-package') ? source : menus)
      },
      async postBusiness (path) { writes.push(path); assert.fail('must not write') }
    })), /BLOCKED/)
    assert.deepEqual(writes, [])
  }
  const menus = menuFixture()
  assert.throws(() => buildMaintenanceIsolationPackage({
    standardPackage: packageFixture(menus), menus, assignableMenus: menus.slice(1)
  }), /BLOCKED/)
})

test('failed tenant creation retires only the new package and preserves the primary failure', async () => {
  const menus = menuFixture()
  const plan = buildMaintenanceIsolationPackage({ standardPackage: packageFixture(menus), menus })
  const writes = []
  let status = 0
  await assert.rejects(createMaintenanceIsolationTenant(platformIdentityApi({
    async getBusiness (path) {
      if (path.endsWith('id=111')) return envelope(packageFixture(menus))
      if (path.endsWith('id=901')) return envelope({ id: '901', status, menuIds: plan.menuIds })
      return envelope(menus)
    },
    async postBusiness (path) {
      writes.push(path)
      if (path === '/system/tenant-package/create') return envelope('901')
      throw new Error('tenant creation failed')
    },
    async putBusiness (path, body) {
      assert.equal(body.id, '901')
      status = body.status
      writes.push(path)
      return envelope(true)
    }
  })), /tenant creation failed/)
  assert.deepEqual(writes, [
    '/system/tenant-package/create', '/system/tenant/create', '/system/tenant-package/update'
  ])
  assert.equal(status, 1)
})

test('created tenant/package and exact menu subset are read back without assuming contactUserId exists', async () => {
  const menus = menuFixture()
  let packageBody
  let tenantBody
  const created = await createMaintenanceIsolationTenant(platformIdentityApi({
    async getBusiness (path) {
      if (path.endsWith('id=111')) return envelope(packageFixture(menus))
      if (path.endsWith('id=901')) return envelope({ ...packageBody, id: '901' })
      if (path.endsWith('id=902')) return envelope({ ...tenantBody, id: '902' })
      return envelope(menus)
    },
    async postBusiness (path, body) {
      if (path === '/system/tenant-package/create') { packageBody = body; return envelope('901') }
      assert.equal(path, '/system/tenant/create')
      tenantBody = body
      return envelope('902')
    }
  }), { marker: 'UNIT', password: 'Unit!123' })
  assert.equal(created.tenantId, '902')
  assert.equal(created.userId, undefined)
  assert.equal(created.tenant.username, 'e2em4unit')
  assert.ok(packageBody.menuIds.every((id) => packageFixture(menus).menuIds.includes(id)))
  assert.equal(packageBody.menuIds.includes('90'), false)
})

test('real own profile resolves the administrator ID missing from tenant response', async () => {
  const fixture = fixtureOf()
  const api = identityApi(fixture)
  delete fixture.userId
  const originalGet = api.getBusiness
  api.getBusiness = async (path) => path === '/system/user/profile/get'
    ? envelope({ id: '903', username: fixture.tenant.username, roles: [{ id: '904' }] })
    : path === '/system/auth/get-permission-info'
      ? envelope({ user: { id: '903', username: fixture.tenant.username }, roles: ['tenant_admin'],
        permissions: [...fixture.plan.permissions, ...fixture.plan.bootstrapPermissions] }) : originalGet(path)
  await verifyMaintenanceIsolationIdentity(api, authOf(), fixture, recordOf())
  assert.equal(fixture.userId, '903')
})

test('administrator verification rejects shared tenant, wrong identity, super role, missing or extra business permissions', async () => {
  const fixture = fixtureOf()
  for (const override of [
    { roles: ['super_admin'] },
    { roles: ['tenant_admin', 'super_admin'] },
    { permissions: ['*:*:*'] },
    { permissions: fixture.plan.permissions.slice(1) },
    { permissions: [...fixture.plan.permissions, ...fixture.plan.bootstrapPermissions, 'mes:repair-order:dispatch'] },
    { permissions: [...fixture.plan.permissions, ...fixture.plan.bootstrapPermissions, 'system:tenant:create'] }
  ]) {
    await assert.rejects(verifyMaintenanceIsolationIdentity(
      identityApi(fixture, override), authOf(), fixture, recordOf()
    ), /BLOCKED/)
  }
  await assert.rejects(verifyMaintenanceIsolationIdentity(
    identityApi(fixture), authOf('1'), fixture, recordOf()
  ), /BLOCKED/)
  await assert.rejects(verifyMaintenanceIsolationIdentity(
    identityApi(fixture), authOf(), { ...fixture, userId: '904' }, recordOf()
  ), /BLOCKED/)
  const api = identityApi(fixture)
  const originalGet = api.getBusiness
  api.getBusiness = async (path) => path.includes('/iot/device/page')
    ? envelope({ list: [{ id: 'old-device' }], total: 1 }) : originalGet(path)
  await assert.rejects(verifyMaintenanceIsolationIdentity(
    api, authOf(), fixture, recordOf()
  ), /空白专属范围/)
})

test('permission-info user must match profile and cannot silently add another department to CUSTOM scope', async () => {
  for (const user of [
    { id: '999', username: 'e2em4unit' },
    { id: '903', username: 'foreign-admin' },
    { id: '903', username: 'e2em4unit', deptId: '999' }
  ]) {
    const fixture = fixtureOf()
    await assert.rejects(verifyMaintenanceIsolationIdentity(
      identityApi(fixture, { user }), authOf(), fixture, recordOf()
    ), /BLOCKED/)
  }
  const h = scopeApiHarness()
  await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, recordOf(), h.dependencies)
  h.state.deptId = '999'
  await assert.rejects(verifyMaintenanceIsolationIdentity(
    h.api, authOf(), h.fixture, recordOf(), { requireEmpty: false }
  ), /BLOCKED/)
})

test('retirement disables account, tenant and package even if account cleanup fails', async () => {
  const fixture = fixtureOf()
  const events = []
  const api = {
    async putBusiness (path, body) { events.push(`${path}:${body.id}`); return envelope(true) },
    async getBusiness (path) { return envelope({ id: path.endsWith('901') ? '901' : '902', status: 1 }) }
  }
  await assert.rejects(retireMaintenanceIsolationTenant(api, fixture, recordOf(), {
    disableAccount: async () => { events.push('disable-account'); throw new Error('account cleanup failed') }
  }), /account cleanup failed/)
  assert.deepEqual(events, ['disable-account', '/system/tenant/update:902', '/system/tenant-package/update:901'])
  events.length = 0
  await assert.rejects(retireMaintenanceIsolationTenant(api, { ...fixture, tenantId: '1' }), /不是本轮专属/)
  await assert.rejects(retireMaintenanceIsolationTenant(api, { ...fixture, packageId: '111' }), /不是本轮专属/)
  assert.deepEqual(events, [])
})

test('account retirement uses its own encrypted tenant login, verifies ownership/status and logs out', async () => {
  const fixture = fixtureOf()
  const events = []
  await disableMaintenanceIsolationAccount(fixture, recordOf(), {
    createApiClient: ({ token, tenantId }) => {
      assert.equal(tenantId, '902')
      return {
        async postBusiness (path, body, options) {
          events.push(path)
          if (path.endsWith('login-encrypted')) {
            assert.equal(token, undefined)
            assert.equal(body.username, fixture.tenant.username)
            assert.equal(options.encrypted, true)
            return envelope({ accessToken: 'own-token', tenantId: '902' })
          }
          assert.equal(token, 'own-token')
          return envelope(true)
        },
        async getBusiness (path) {
          return envelope({ id: '903', username: fixture.tenant.username, status: path.includes('/get?') ? 1 : 0 })
        },
        async putBusiness (path, body) {
          events.push(path)
          assert.deepEqual(body, { id: '903', status: 1 })
          return envelope(true)
        }
      }
    }
  })
  assert.equal(fixture.accountDisabled, true)
  assert.deepEqual(events, ['/system/auth/login-encrypted', '/system/user/update-status', '/system/auth/logout'])
})

test('isolation orchestration retires on browser/identity/business failures and never falls back to primary tenant', async () => {
  for (const stage of ['browser', 'identity', 'business']) {
    const fixture = fixtureOf()
    const h = scopeApiHarness(fixture)
    let retired = false
    let businessCalled = false
    await assert.rejects(runMaintenanceTenantIsolation({
      caseRecord: recordOf(), record: {}, page: {}
    }, h.platformApi, async () => {
      businessCalled = true
      throw new Error('business failed')
    }, {
      assertWriteSafety: async () => {},
      runReadOnlySql: h.dependencies.runReadOnlySql,
      createTenant: async () => fixture,
      prepareTenant: async () => {},
      withTenant: async (_context, _tenant, run) => {
        if (stage === 'browser') throw new Error('browser failed')
        return run({ api: h.api, auth: authOf(stage === 'identity' ? '1' : '902') })
      },
      retireTenant: async () => { retired = true }
    }), stage === 'identity' ? /BLOCKED/ : /failed/)
    assert.equal(retired, true)
    assert.equal(businessCalled, stage === 'business')
  }
})

test('default SELF administrator gains only one owned department through a menu-free CUSTOM role', async () => {
  const { api, state, fixture, dependencies } = scopeApiHarness()
  const before = structuredClone(state.adminRole)
  await prepareMaintenanceIsolationDeviceScope(api, authOf(), fixture, recordOf(), dependencies)
  assert.deepEqual(state.adminRole, before)
  assert.equal(fixture.adminRoleId, '904')
  assert.equal(fixture.deviceScope.deptId, '56')
  assert.equal(fixture.deviceScope.roleId, '57')
  assert.equal(state.role.type, 2)
  assert.equal(state.role.dataScope, 2)
  assert.deepEqual(state.role.dataScopeDeptIds, ['56'])
  assert.deepEqual(state.roleIds, ['904', '57'])
  assert.deepEqual(state.menus, [])
  assert.equal(state.events.some(([, path]) => path === '/system/permission/assign-role-menu'), false)
  assert.deepEqual(state.events.filter(([method]) => method === 'POST').map(([, path]) => path), [
    '/system/dept/create', '/system/role/create',
    '/system/permission/assign-role-data-scope', '/system/permission/assign-user-role'
  ])
  for (const [, , , options] of state.events.filter(([method]) => method === 'POST')) {
    assert.deepEqual(options?.headers, { 'visit-tenant-id': fixture.tenantId })
  }
})

test('SELF hides the department until SQL ownership, persisted CUSTOM scope and exact user-role assignment precede API verification', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  const post = h.api.postBusiness
  h.api.postBusiness = async (path, body, options) => {
    if (path === '/system/role/create') {
      assert.equal(h.fixture.deviceScope.departmentOwnershipVerified, true)
      assert.equal((await h.api.getBusiness('/system/dept/get?id=56')).data, null)
    }
    if (path === '/system/permission/assign-user-role') {
      assert.equal(h.fixture.deviceScope.dataScopeVerified, true)
      assert.equal(h.fixture.deviceScope.assigned, undefined)
      assert.equal(h.fixture.deviceScope.ready, undefined)
      assert.equal((await h.api.getBusiness('/system/dept/get?id=56')).data, null)
      assert.equal(h.state.events.at(-2)[1], '/system/permission/list-role-menus?roleId=57')
    }
    const response = await post(path, body, options)
    if (path === '/system/dept/create') {
      assert.equal((await h.api.getBusiness('/system/dept/get?id=56')).data, null)
    }
    return response
  }
  await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, record, h.dependencies)
  assert.equal((await h.api.getBusiness('/system/dept/get?id=56')).data.id, '56')
  assert.equal(h.fixture.deviceScope.assigned, true)
  assert.equal(h.fixture.deviceScope.ready, true)
  const events = h.state.events
  const sqlIndex = events.findIndex(([method]) => method === 'SQL')
  const createRoleIndex = events.findIndex(([, path]) => path === '/system/role/create')
  const customIndex = events.findIndex(([, path]) => path === '/system/permission/assign-role-data-scope')
  const assignIndex = events.findIndex(([, path]) => path === '/system/permission/assign-user-role')
  assert.ok(sqlIndex < createRoleIndex && createRoleIndex < customIndex && customIndex < assignIndex)
  assert.ok(events.slice(customIndex + 1, assignIndex).some(([, path]) => path === '/system/role/get?id=57'))
  assert.ok(events.slice(assignIndex + 1).some(([, path]) => path === '/system/dept/get?id=56'))
  assert.equal(record.database.length, 1)
  assert.equal(record.database[0].stage, 'maint004-owned-department-before-custom-role')
  assert.ok(record.evidence.some(line => /不代替正式API验收/.test(line)))
  assert.deepEqual(h.state.adminRole, { id: '904', code: 'tenant_admin', type: 1, status: 0, dataScope: 5 })
})

for (const [label, mutate] of [
  ['unavailable SQL', snapshot => { snapshot.available = false }],
  ['empty SQL result', snapshot => { snapshot.rows = [] }],
  ['multiple SQL rows', snapshot => { snapshot.rows.push([...snapshot.rows[0]]) }],
  ['malformed SQL result', snapshot => { snapshot.rows = null }],
  ['truncated SQL row', snapshot => { snapshot.rows[0].pop() }],
  ['foreign department ID', snapshot => { snapshot.rows[0][0] = '999' }],
  ['rounded department ID', snapshot => { snapshot.rows[0][0] = Number('2110019776332775425') }],
  ['foreign tenant', snapshot => { snapshot.rows[0][1] = '1' }],
  ['foreign code', snapshot => { snapshot.rows[0][2] = 'E2E-M4-FOREIGN' }],
  ['foreign name', snapshot => { snapshot.rows[0][3] = 'foreign department' }],
  ['foreign parent', snapshot => { snapshot.rows[0][4] = '999' }],
  ['disabled department', snapshot => { snapshot.rows[0][5] = '1' }],
  ['deleted department', snapshot => { snapshot.rows[0][6] = '1' }],
  ['foreign creator', snapshot => { snapshot.rows[0][7] = '999' }]
]) {
  test(`${label} blocks department bootstrap before any role creation or assignment`, async () => {
    const h = scopeApiHarness()
    const record = recordOf()
    const runSql = h.dependencies.runReadOnlySql
    h.dependencies.runReadOnlySql = async sql => {
      const snapshot = await runSql(sql)
      mutate(snapshot)
      return snapshot
    }
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, authOf(), h.fixture, record, h.dependencies
    ), /BLOCKED/)
    assert.equal(h.fixture.deviceScope.departmentOwnershipVerified, undefined)
    assert.equal(h.fixture.deviceScope.dataScopeVerified, undefined)
    assert.equal(h.fixture.deviceScope.assigned, undefined)
    assert.equal(h.fixture.deviceScope.ready, undefined)
    assert.deepEqual(h.state.events.filter(([method]) => method === 'POST').map(([, path]) => path), [
      '/system/dept/create'
    ])
    assert.equal(record.database.length, 1)
    assert.equal(record.checks.some(check => check.passed), false)
  })
}

test('a read-only SQL exception is BLOCKED evidence and cannot create or assign a role', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  h.dependencies.runReadOnlySql = async () => { throw new Error('department SQL unavailable') }
  await assert.rejects(prepareMaintenanceIsolationDeviceScope(
    h.api, authOf(), h.fixture, record, h.dependencies
  ), /BLOCKED.*department SQL unavailable/)
  assert.equal(record.database[0].available, false)
  assert.deepEqual(record.database[0].rows, [])
  assert.equal(h.state.role, null)
  assert.deepEqual(h.state.roleIds, ['904'])
})

test('department marker drift is rejected before constructing or running SQL', async () => {
  const h = scopeApiHarness()
  const post = h.api.postBusiness
  h.api.postBusiness = async (path, body, options) => {
    const response = await post(path, body, options)
    if (path === '/system/dept/create') h.fixture.deviceScope.deptPayload.code = "E2E-M4-' OR 1=1"
    return response
  }
  await assert.rejects(prepareMaintenanceIsolationDeviceScope(
    h.api, authOf(), h.fixture, recordOf(), h.dependencies
  ), /BLOCKED.*marker/)
  assert.equal(h.state.events.some(([method]) => method === 'SQL'), false)
  assert.equal(h.state.role, null)
})

test('scope preparation rejects wrong session, mutated builtin role and extra menus before unsafe writes', async () => {
  for (const mutation of [
    h => { h.state.adminRole.dataScope = 1 },
    h => { h.state.adminRole.type = 2 },
    h => { h.state.menus = ['10'] }
  ]) {
    const h = scopeApiHarness()
    mutation(h)
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, authOf(), h.fixture, recordOf(), h.dependencies
    ), /BLOCKED/)
    assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-role-data-scope'), false)
    assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-user-role'), false)
  }
  for (const auth of [authOf('1'), { tenantId: '902' }, { ...authOf(), token: '' }]) {
    const h = scopeApiHarness()
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, auth, h.fixture, recordOf(), h.dependencies
    ), /BLOCKED/)
    assert.equal(h.state.events.some(([method]) => method === 'POST'), false)
  }
})

test('missing existing platform super_admin blocks before department or role writes', async () => {
  const h = scopeApiHarness()
  const { platformApi: _platformApi, ...dependenciesWithoutPlatform } = h.dependencies
  await assert.rejects(prepareMaintenanceIsolationDeviceScope(
    h.api, authOf(), h.fixture, recordOf(), dependenciesWithoutPlatform
  ), /BLOCKED: MAINT-004 部门引导需要既有平台 super_admin/)
  assert.equal(h.state.department, null)
  assert.equal(h.state.role, null)
  assert.deepEqual(
    h.state.events.filter(([method]) => ['POST', 'PUT'].includes(method)),
    []
  )
})

test('successful data-scope response cannot hide ALL, foreign departments or missing persistence', async () => {
  for (const mutate of [
    state => { state.role.dataScope = 1 },
    state => { state.role.dataScopeDeptIds = ['999'] },
    state => { state.role.dataScopeDeptIds = ['56', '999'] },
    state => { state.role.dataScopeDeptIds = ['56', '56'] },
    state => { state.role.dataScopeDeptIds = [] },
    state => { state.role.dataScope = 5 }
  ]) {
    const h = scopeApiHarness(fixtureOf(), mutate)
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, authOf(), h.fixture, recordOf(), h.dependencies
    ), /BLOCKED/)
    assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-user-role'), false)
  }
})

test('scope persistence cannot hide role ownership, enabled status or menu drift before user-role assignment', async () => {
  for (const mutate of [
    state => { state.role.id = '999' },
    state => { state.role.name = 'foreign role' },
    state => { state.role.code = 'foreign-role' },
    state => { state.role.remark = 'foreign marker' },
    state => { state.role.type = 1 },
    state => { state.role.status = 1 },
    state => { state.menus = ['10'] }
  ]) {
    const h = scopeApiHarness(fixtureOf(), mutate)
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, authOf(), h.fixture, recordOf(), h.dependencies
    ), /BLOCKED/)
    assert.equal(h.fixture.deviceScope.dataScopeVerified, undefined)
    assert.equal(h.fixture.deviceScope.assigned, undefined)
    assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-user-role'), false)
  }
})

test('initial custom-role ownership and default SELF are verified before any data-scope assignment', async () => {
  for (const mutate of [
    state => { state.role.dataScope = 1 },
    state => { state.role.dataScopeDeptIds = ['999'] },
    state => { state.role.code = 'foreign-role' },
    state => { state.role.type = 1 },
    state => { state.role.status = 1 }
  ]) {
    const h = scopeApiHarness()
    const post = h.api.postBusiness
    h.api.postBusiness = async (path, body, options) => {
      const response = await post(path, body, options)
      if (path === '/system/role/create') mutate(h.state)
      return response
    }
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, authOf(), h.fixture, recordOf(), h.dependencies
    ), /BLOCKED/)
    assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-role-data-scope'), false)
    assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-user-role'), false)
  }
})

test('formal CUSTOM assignment rejection stops bootstrap without falling back to ALL or changing builtin roles', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  const post = h.api.postBusiness
  h.api.postBusiness = async (path, body, options) => {
    if (path === '/system/permission/assign-role-data-scope') {
      h.state.events.push(['POST', path, structuredClone(body), options])
      throw new Error('400: 数据范围包含不存在或不属于当前租户的部门')
    }
    return post(path, body, options)
  }
  await assert.rejects(prepareMaintenanceIsolationDeviceScope(
    h.api, authOf(), h.fixture, record, h.dependencies
  ), /数据范围包含不存在或不属于当前租户的部门/)
  assert.equal(h.fixture.deviceScope.dataScopeVerified, undefined)
  assert.equal(h.fixture.deviceScope.assigned, undefined)
  assert.equal(h.fixture.deviceScope.ready, undefined)
  assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-user-role'), false)
  assert.deepEqual(h.state.adminRole, { id: '904', code: 'tenant_admin', type: 1, status: 0, dataScope: 5 })
  await disableMaintenanceIsolationAccount(
    h.fixture, record, { ...h.dependencies, createApiClient: () => h.api }
  )
  assert.equal(h.fixture.accountDisabled, true)
  assert.equal(h.fixture.deviceScope.retired, true)
  assert.deepEqual(record.maintenanceIsolationResiduals || [], [])
  assert.equal(h.state.department.status, 1)
  assert.equal(h.state.role.status, 1)
})

test('non-true CUSTOM assignment responses never authorize user-role assignment even if scope was persisted', async () => {
  for (const response of [false, 1, 'true', null]) {
    const h = scopeApiHarness()
    const post = h.api.postBusiness
    h.api.postBusiness = async (path, body, options) => {
      const result = await post(path, body, options)
      return path === '/system/permission/assign-role-data-scope' ? envelope(response) : result
    }
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, authOf(), h.fixture, recordOf(), h.dependencies
    ), /未返回真实 true/)
    assert.equal(h.fixture.deviceScope.dataScopeVerified, undefined)
    assert.equal(h.fixture.deviceScope.assigned, undefined)
    assert.equal(h.fixture.deviceScope.ready, undefined)
    assert.equal(h.state.events.some(([, path]) => path === '/system/permission/assign-user-role'), false)
  }
})

test('a true user-role assignment response without persisted exact role IDs is rejected', async () => {
  for (const roleIds of [['904'], ['904', '57', '999'], ['57']]) {
    const h = scopeApiHarness()
    const post = h.api.postBusiness
    h.api.postBusiness = async (path, body, options) => {
      const response = await post(path, body, options)
      if (path === '/system/permission/assign-user-role') h.state.roleIds = roleIds
      return response
    }
    await assert.rejects(prepareMaintenanceIsolationDeviceScope(
      h.api, authOf(), h.fixture, recordOf(), h.dependencies
    ), /BLOCKED/)
  }
})

test('assigned CUSTOM roles do not make an API-null department ready or authorize any device writes', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  h.state.hideDepartment = true
  await assert.rejects(prepareMaintenanceIsolationDeviceScope(
    h.api, authOf(), h.fixture, record, h.dependencies
  ), /正式API回读不可见/)
  assert.equal(h.fixture.deviceScope.dataScopeVerified, true)
  assert.equal(h.fixture.deviceScope.assigned, true)
  assert.equal(h.fixture.deviceScope.ready, undefined)
  assert.equal(record.checks.some(check => check.passed), false)
  await assert.rejects(createMaintenanceIsolationDevice({
    api: h.api, auth: authOf(), fixture: h.fixture, fixtures: {}, product: {}, caseRecord: record
  }), /正式API回读不可见/)
  assert.equal(h.state.events.some(([, path]) => path === '/iot/device/create'), false)
})

test('scope and account retirement uses own login, retires department/role before disabling account and retains ownership audit', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, record, h.dependencies)
  h.state.events.length = 0
  await disableMaintenanceIsolationAccount(h.fixture, record, {
    ...h.dependencies,
    createApiClient: ({ tenantId }) => {
      assert.equal(tenantId, '902')
      return h.api
    }
  })
  assert.equal(h.fixture.deviceScope.retired, true)
  assert.equal(h.fixture.accountDisabled, true)
  assert.equal(h.state.department.status, 1)
  assert.equal(h.state.role.status, 1)
  assert.equal(h.state.userStatus, 1)
  assert.deepEqual(h.state.adminRole, { id: '904', code: 'tenant_admin', type: 1, status: 0, dataScope: 5 })
  assert.deepEqual(h.state.events.filter(([method]) => method === 'PUT').map(([, path]) => path), [
    '/system/dept/update', '/system/role/update', '/system/user/update-status'
  ])
  assert.equal(h.state.events.at(-1)[1], '/system/auth/logout')
})

test('partial scope creation uses platform visit cleanup and still disables the account', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  const post = h.api.postBusiness
  h.api.postBusiness = async (path, body, options) => {
    if (path === '/system/role/create') throw new Error('role creation failed')
    return post(path, body, options)
  }
  await assert.rejects(prepareMaintenanceIsolationDeviceScope(
    h.api, authOf(), h.fixture, record, h.dependencies
  ), /role creation failed/)
  assert.equal(h.fixture.deviceScope.roleId, undefined)
  await disableMaintenanceIsolationAccount(
    h.fixture, record, { ...h.dependencies, createApiClient: () => h.api }
  )
  assert.equal(h.state.department.status, 1)
  assert.equal(h.fixture.accountDisabled, true)
  assert.equal(h.fixture.deviceScope.retired, true)
  assert.deepEqual(record.maintenanceIsolationResiduals || [], [])
  assert.deepEqual(h.state.events.filter(([method]) => method === 'PUT').map(([, path]) => path), [
    '/system/dept/update', '/system/user/update-status'
  ])
})

test('partial scope creation still allows tenant and package retirement after platform cleanup', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  const post = h.api.postBusiness
  h.api.postBusiness = async (path, body, options) => {
    if (path === '/system/role/create') throw new Error('role creation failed')
    return post(path, body, options)
  }
  await assert.rejects(prepareMaintenanceIsolationDeviceScope(
    h.api, authOf(), h.fixture, record, h.dependencies
  ), /role creation failed/)
  const statuses = { '901': 0, '902': 0 }
  const events = []
  await retireMaintenanceIsolationTenant({
    async putBusiness (path, body) {
      events.push([path, body.id])
      statuses[body.id] = body.status
      return envelope(true)
    },
    async getBusiness (path) {
      const id = path.split('=').at(-1)
      return envelope({ id, status: statuses[id] })
    }
  }, h.fixture, record, { ...h.dependencies, createApiClient: () => h.api })
  assert.equal(h.fixture.accountDisabled, true)
  assert.deepEqual(statuses, { '901': 1, '902': 1 })
  assert.deepEqual(events, [['/system/tenant/update', '902'], ['/system/tenant-package/update', '901']])
  assert.equal(h.state.department.status, 1)
  assert.deepEqual(record.maintenanceIsolationResiduals || [], [])
  assert.equal(record.checks.at(-1).passed, true)
  assert.equal(h.state.events.at(-1)[1], '/system/auth/logout')
})

test('API-null post-retirement department is not successful cleanup and records only unverified residuals', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, record, h.dependencies)
  const put = h.api.putBusiness
  h.api.putBusiness = async (path, body, options) => {
    const response = await put(path, body, options)
    if (path === '/system/dept/update') h.state.hideProvisionDepartment = true
    return response
  }
  await assert.rejects(disableMaintenanceIsolationAccount(
    h.fixture, record, { ...h.dependencies, createApiClient: () => h.api }
  ), /正式API回读不可见/)
  assert.equal(h.fixture.deviceScope.deptRetirementVerified, undefined)
  assert.equal(h.fixture.deviceScope.roleRetirementVerified, true)
  assert.equal(h.fixture.deviceScope.retired, undefined)
  assert.equal(h.fixture.accountDisabled, true)
  assert.deepEqual(record.maintenanceIsolationResiduals.map(row => row.resource), ['department'])
  assert.equal(record.evidence.some(line => /专属部门 56 已停用并回读/.test(line)), false)
})

test('scope ownership drift blocks department/role writes but does not skip own account disable/logout', async () => {
  for (const mutate of [
    state => { state.department.code = 'FOREIGN' },
    state => { state.role.code = 'foreign-role' },
    state => { state.role.type = 1 },
    state => { state.role.dataScopeDeptIds = ['999'] },
    state => { state.menus = ['10'] }
  ]) {
    const h = scopeApiHarness()
    await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, recordOf(), h.dependencies)
    mutate(h.state)
    h.state.events.length = 0
    await assert.rejects(disableMaintenanceIsolationAccount(
      h.fixture, recordOf(), { ...h.dependencies, createApiClient: () => h.api }
    ), /BLOCKED/)
    assert.equal(h.fixture.deviceScope.retired, undefined)
    assert.equal(h.fixture.accountDisabled, true)
    assert.deepEqual(h.state.events.filter(([method]) => method === 'PUT').map(([, path]) => path), [
      '/system/user/update-status'
    ])
    assert.equal(h.state.events.at(-1)[1], '/system/auth/logout')
  }
})

test('scope, account and logout failures remain independent and preserve every cleanup error', async () => {
  const h = scopeApiHarness()
  await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, recordOf(), h.dependencies)
  const writes = []
  h.api.putBusiness = async (path) => {
    writes.push(path)
    if (path === '/system/role/update') return envelope(false)
    throw new Error(path === '/system/dept/update' ? 'department cleanup failed' : 'account cleanup failed')
  }
  const post = h.api.postBusiness
  h.api.postBusiness = async (path, body, options) => {
    if (path === '/system/auth/logout') { writes.push(path); throw new Error('logout failed') }
    return post(path, body, options)
  }
  await assert.rejects(disableMaintenanceIsolationAccount(
    h.fixture, recordOf(), { ...h.dependencies, createApiClient: () => h.api }
  ), error => {
    assert.ok(error instanceof AggregateError)
    for (const message of ['department cleanup failed', '未返回真实 true', 'account cleanup failed', 'logout failed']) {
      assert.ok(error.message.includes(message), error.message)
    }
    return true
  })
  assert.equal(h.fixture.accountDisabled, undefined)
  assert.equal(h.fixture.deviceScope.retired, undefined)
  assert.deepEqual(writes, [
    '/system/dept/update', '/system/role/update', '/system/user/update-status', '/system/auth/logout'
  ])
})

test('scope retirement failure still records a successful own account disable without claiming scope success', async () => {
  const h = scopeApiHarness()
  const record = recordOf()
  await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, record, h.dependencies)
  const put = h.api.putBusiness
  h.api.putBusiness = async (path, body, options) => {
    if (path === '/system/dept/update') throw new Error('department cleanup failed')
    return put(path, body, options)
  }
  await assert.rejects(disableMaintenanceIsolationAccount(
    h.fixture, record, { ...h.dependencies, createApiClient: () => h.api }
  ), /department cleanup failed/)
  assert.equal(h.fixture.accountDisabled, true)
  assert.equal(h.fixture.deviceScope.retired, undefined)
  assert.equal(h.state.role.status, 1)
  assert.deepEqual(record.maintenanceIsolationResiduals.map(row => row.resource), ['department'])
  assert.equal(h.fixture.deviceScope.roleRetirementVerified, true)
  assert.ok(record.evidence.some(line => /专属管理员 903 已停用并回读/.test(line)))
  assert.equal(h.state.events.at(-1)[1], '/system/auth/logout')
})

test('cleanup account status false/missing persistence is not success and logout cannot mask ownership failure', async () => {
  for (const response of [false, true]) {
    const h = scopeApiHarness()
    h.api.putBusiness = async () => envelope(response)
    await assert.rejects(disableMaintenanceIsolationAccount(
      h.fixture, recordOf(), { ...h.dependencies, createApiClient: () => h.api }
    ), response ? /停用回读不一致/ : /未返回真实 true/)
    assert.equal(h.fixture.accountDisabled, undefined)
    assert.equal(h.state.events.at(-1)[1], '/system/auth/logout')
  }
  const h = scopeApiHarness()
  const get = h.api.getBusiness
  h.api.getBusiness = async path => path === '/system/user/profile/get'
    ? envelope({ id: '999', username: 'foreign-admin' }) : get(path)
  const post = h.api.postBusiness
  h.api.postBusiness = async (path, body) => {
    if (path === '/system/auth/logout') throw new Error('logout failed')
    return post(path, body)
  }
  await assert.rejects(disableMaintenanceIsolationAccount(
    h.fixture, recordOf(), { ...h.dependencies, createApiClient: () => h.api }
  ), error => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /不是本轮专属账号/)
    assert.match(error.message, /logout failed/)
    return true
  })
  assert.equal(h.state.events.some(([method]) => method === 'PUT'), false)
})

async function deviceHarness () {
  const h = scopeApiHarness()
  const caseRecord = recordOf()
  await prepareMaintenanceIsolationDeviceScope(h.api, authOf(), h.fixture, caseRecord, h.dependencies)
  h.fixture.categoryId = '50'
  const product = { id: '52', name: 'E2E-MAINT-004-PRODUCT-UNIT', categoryId: '50', deviceType: 0 }
  h.fixture.product = { id: product.id, name: product.name }
  const id = '2109968319386521601'
  const marker = 'E2E-MAINT-004-DEVICE-UNIT'
  const get = h.api.getBusiness
  const post = h.api.postBusiness
  h.api.getBusiness = async path => path === `/iot/device/get?id=${id}`
    ? envelope(h.state.device) : get(path)
  h.api.postBusiness = async (path, body) => {
    if (path !== '/iot/device/create') return post(path, body)
    h.state.events.push(['POST', path, structuredClone(body)])
    h.state.device = { ...body, id, deviceType: product.deviceType }
    return envelope(id)
  }
  h.api.deleteBusiness = async path => {
    assert.equal(path, `/iot/device/delete?id=${id}`)
    h.state.events.push(['DELETE', path])
    h.state.device = null
    return envelope(true)
  }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-004', caseRecord })
  return {
    ...h, fixtures, caseRecord, product, id,
    create: (overrides = {}) => createMaintenanceIsolationDevice({
      api: h.api, auth: authOf(), fixture: h.fixture, fixtures, product, marker, caseRecord, ...overrides
    })
  }
}

test('owned device keeps its exact large ID, explicit department and positive ownership read before deletion', async () => {
  const h = await deviceHarness()
  const device = await h.create()
  assert.equal(device.id, h.id)
  assert.equal(device.deptId, h.fixture.deviceScope.deptId)
  await h.fixtures.cleanup(false)
  assert.equal(h.fixture.deviceCleanupVerified, true)
  assert.equal(h.state.device, null)
  assert.equal(h.caseRecord.checks.at(-1).passed, true)
  assert.deepEqual(h.state.events.filter(([method, path]) => method === 'POST' && path.startsWith('/iot/')), [
    ['POST', '/iot/device/create', { productId: '52', deptId: '56', deviceName: 'E2E-MAINT-004-DEVICE-UNIT' }]
  ])
})

test('device create rejects unowned product/category, repeated fixture or wrong session before device writes', async () => {
  for (const overrides of [
    { product: { id: '999', name: 'E2E-MAINT-004-PRODUCT-UNIT', categoryId: '50', deviceType: 0 } },
    { product: { id: '52', name: 'FOREIGN', categoryId: '50', deviceType: 0 } },
    { product: { id: '52', name: 'E2E-MAINT-004-PRODUCT-UNIT', categoryId: '999', deviceType: 0 } },
    { product: { id: '52', name: 'E2E-MAINT-004-PRODUCT-UNIT', categoryId: '50' } },
    { marker: 'foreign-device' },
    { auth: authOf('1') }
  ]) {
    const h = await deviceHarness()
    await assert.rejects(h.create(overrides), /BLOCKED/)
    assert.equal(h.state.events.some(([, path]) => path === '/iot/device/create'), false)
  }
  const h = await deviceHarness()
  await h.create()
  await assert.rejects(h.create(), /BLOCKED/)
  assert.equal(h.state.events.filter(([, path]) => path === '/iot/device/create').length, 1)
})

test('foreign, missing or rounded device read cannot pass creation or authorize deletion', async () => {
  for (const mutation of [
    row => ({ ...row, productId: '999' }),
    row => ({ ...row, deptId: '999' }),
    row => ({ ...row, deviceName: 'FOREIGN' }),
    row => ({ ...row, deviceType: 1 }),
    row => ({ ...row, id: Number(row.id) }),
    () => null
  ]) {
    const h = await deviceHarness()
    const get = h.api.getBusiness
    h.api.getBusiness = async path => path.startsWith('/iot/device/get?')
      ? envelope(mutation(h.state.device)) : get(path)
    await assert.rejects(h.create(), /BLOCKED/)
    await h.fixtures.cleanup(true)
    assert.equal(h.fixture.deviceCleanupVerified, undefined)
    assert.equal(h.state.events.some(([method]) => method === 'DELETE'), false)
    assert.equal(h.caseRecord.checks.at(-1).passed, false)
  }
})

test('identity/scope/device ownership drift before cleanup prevents any device delete', async () => {
  for (const mutate of [
    state => { state.roleIds = ['904'] },
    state => { state.deptId = '999' },
    state => { state.role.dataScope = 1 },
    state => { state.device.productId = '999' },
    state => { state.device.deptId = '999' },
    state => { state.device.deviceName = 'FOREIGN' }
  ]) {
    const h = await deviceHarness()
    await h.create()
    mutate(h.state)
    await assert.rejects(h.fixtures.cleanup(false), /清理失败/)
    assert.equal(h.fixture.deviceCleanupVerified, undefined)
    assert.equal(h.state.events.some(([method]) => method === 'DELETE'), false)
    assert.equal(h.caseRecord.checks.at(-1).passed, false)
  }
})

test('delete false or a non-null post-delete read cannot mark the device cleaned', async () => {
  for (const [response, after] of [[false, null], [true, 'unchanged'], [true, undefined]]) {
    const h = await deviceHarness()
    await h.create()
    h.api.deleteBusiness = async () => {
      if (after !== 'unchanged') h.state.device = after
      return envelope(response)
    }
    await assert.rejects(h.fixtures.cleanup(false), /清理失败/)
    assert.equal(h.fixture.deviceCleanupVerified, undefined)
    assert.equal(h.caseRecord.checks.at(-1).passed, false)
  }
})

const runAssignmentCase = async ({
  extraDevice = false, invisibleDevice = false,
  deviceDeleteResult = true, keepDeviceAfterDelete = false,
  productDeleteResult = true, keepProductAfterDelete = false
} = {}) => {
  const fixture = fixtureOf()
  const caseRecord = recordOf()
  const scopeHarness = scopeApiHarness(fixture)
  const state = { category: null, product: null, device: null, item: null, plan: null, assignments: [], orders: [], writes: [], deletes: [], retired: false }
  const resolve = () => state.assignments.filter((assignment) =>
    assignment.status === 0 &&
    (!assignment.effectiveStart || new Date(assignment.effectiveStart) <= new Date()) &&
    (!assignment.effectiveEnd || new Date(assignment.effectiveEnd) >= new Date())
  ).sort((left, right) =>
    ['DEVICE', 'PRODUCT', 'DEVICE_TYPE'].indexOf(left.targetType) -
    ['DEVICE', 'PRODUCT', 'DEVICE_TYPE'].indexOf(right.targetType) ||
    right.priority - left.priority ||
    String(right.effectiveStart || '').localeCompare(String(left.effectiveStart || ''))
  )[0] || null
  const page = (rows) => envelope({ list: rows, records: rows, total: rows.length })
  const api = {
    async getBusiness (path) {
      if (path.startsWith('/system/') && !path.includes('/order/')) return scopeHarness.api.getBusiness(path)
      if (path.includes('/iot/product/page')) return page(state.product ? [state.product] : [])
      if (path.includes('/iot/device/page')) return page(state.device ? [
        state.device, ...(extraDevice ? [{ id: '999', deviceType: 0 }] : [])
      ] : [])
      if (path.includes('/mes/maintenance-plan/page')) return page([])
      if (path.includes('/mes/maintenance-plan-assignment/page')) return page([])
      if (path.includes('/iot/product-category/simple-list')) return envelope(state.category ? [state.category] : [])
      if (path.includes('/iot/product-category/get')) return envelope(state.category)
      if (path.includes('/iot/product/get')) return envelope(state.product)
      if (path.includes('/iot/device/get')) return envelope(invisibleDevice ? null : state.device)
      if (path === '/mes/maintenance-item/tree') return envelope([{ id: '51', categoryRoot: 'REPAIR', systemRoot: true }])
      if (path.includes('/mes/maintenance-item/get')) return envelope(state.item)
      if (path.includes('/mes/maintenance-plan/get')) return envelope(structuredClone(state.plan))
      if (path.includes('/maintenance-plan-assignment/resolve')) return envelope(resolve())
      if (path.includes('/mes/system/order/list')) return page(state.orders.map((order) => ({ ...order })))
      if (path.startsWith('/mes/system/order/')) return envelope(state.orders.find((order) => order.id === path.split('/').at(-1)))
      assert.fail(`unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      state.writes.push(path)
      if (path.startsWith('/system/')) return scopeHarness.api.postBusiness(path, body)
      if (path === '/iot/product-category/create') { state.category = { ...body, id: '50' }; return envelope('50') }
      if (path === '/iot/product/create') { state.product = { ...body, id: '52' }; return envelope('52') }
      if (path === '/iot/device/create') {
        assert.equal(body.deptId, fixture.deviceScope.deptId)
        assert.equal(scopeHarness.state.role.dataScope, 2)
        assert.deepEqual(scopeHarness.state.role.dataScopeDeptIds, [body.deptId])
        assert.deepEqual(scopeHarness.state.roleIds, ['904', fixture.deviceScope.roleId])
        state.device = { ...body, id: '53', deviceType: 0 }
        return envelope('53')
      }
      if (path === '/mes/maintenance-item/create') { state.item = { ...body, id: '54' }; return envelope('54') }
      if (path === '/mes/maintenance-plan/create') {
        state.plan = { ...body, id: '55', status: 'DRAFT', currentVersion: 1, publishedVersion: null }
        return envelope('55')
      }
      if (path === '/mes/maintenance-plan-assignment/create') {
        const id = String(60 + state.assignments.length)
        state.assignments.push({ ...body, id })
        return envelope(id)
      }
      assert.fail(`unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      state.writes.push(path)
      if (path === '/mes/maintenance-plan-assignment/update') {
        Object.assign(state.assignments.find((assignment) => assignment.id === body.id), body)
      } else if (path.startsWith('/mes/maintenance-plan/publish')) {
        state.plan.status = 'PUBLISHED'
        state.plan.publishedVersion = state.plan.currentVersion
        const assignment = resolve()
        if (assignment && !state.orders.some((order) =>
          order.sourceAssignmentId === assignment.id && order.sourcePlanVersion === state.plan.currentVersion)) {
          state.orders.push({
            id: String(100 + state.orders.length), projectName: state.plan.planName, deviceId: state.device.id,
            sourcePlanId: state.plan.id, sourcePlanVersion: state.plan.currentVersion,
            sourceAssignmentId: assignment.id, orderStatus: 'REPORTED',
            cycleRuleSnapshot: JSON.stringify(state.plan.cycles[0]),
            deviceSnapshot: JSON.stringify({ deviceId: state.device.id }),
            idempotentKey: `${state.plan.id}:${state.plan.currentVersion}:${assignment.id}`
          })
        }
      } else if (path === '/mes/maintenance-plan/update') {
        Object.assign(state.plan, body, { status: 'DRAFT', currentVersion: 2 })
      } else if (path.startsWith('/mes/maintenance-plan/disable')) {
        state.plan.status = 'DISABLED'
      } else if (path === '/mes/maintenance-item/update') {
        Object.assign(state.item, body)
      } else assert.fail(`unexpected PUT ${path}`)
      return envelope(true)
    },
    async deleteBusiness (path) {
      state.deletes.push(path)
      if (path.includes('/maintenance-plan-assignment/delete')) {
        state.assignments = state.assignments.filter((assignment) => assignment.id !== path.split('=').at(-1))
      } else if (path.startsWith('/mes/system/order/')) {
        state.orders = state.orders.filter((order) => order.id !== path.split('/').at(-1))
      } else if (path.includes('/iot/device/delete')) {
        if (invisibleDevice) throw new Error('1050003000: 设备不存在')
        if (deviceDeleteResult && !keepDeviceAfterDelete) state.device = null
        return envelope(deviceDeleteResult)
      }
      else if (path.includes('/iot/product/delete')) {
        if (productDeleteResult && !keepProductAfterDelete) state.product = null
        return envelope(productDeleteResult)
      }
      else if (path.includes('/iot/product-category/delete')) state.category = null
      else if (path.includes('/maintenance-plan/delete')) state.plan = null
      else if (path.includes('/maintenance-item/delete')) state.item = null
      else assert.fail(`unexpected DELETE ${path}`)
      return envelope(true)
    },
    async request (method, path) {
      assert.equal(method, 'GET')
      assert.ok(path.includes('/maintenance-plan-assignment/get'))
      return { code: 400, msg: '维保方案分配不存在' }
    }
  }
  const screenshots = []
  const context = { caseId: 'MAINT-004', page: {}, caseRecord, record: {}, outputDir: '/unused' }
  let error
  let result
  try {
    result = await runCase(context, {
      login: async () => 'platform-token',
      createApiClient: () => scopeHarness.platformApi,
      assertWriteSafety: async () => {},
      createTenant: async () => fixture,
      prepareTenant: async () => {},
      withTenant: async (_context, tenant, run) => {
        assert.equal(tenant.id, '902')
        return run({ page: {}, api, auth: { token: 'tenant-token', tenantId: '902' } })
      },
      retireTenant: async () => { state.retired = true },
      openRoute: async () => {},
      saveScreenshot: async (_page, _output, name) => screenshots.push(name),
      runReadOnlySql: async (sql) => {
        assert.match(sql, /tenant_id = 902/)
        assert.doesNotMatch(sql, /tenant_id = 1\b/)
        if (sql.includes('FROM system_dept')) return scopeHarness.dependencies.runReadOnlySql(sql)
        return { available: true, rows: [['1', '61', '55:1:61']] }
      }
    })
  } catch (cause) { error = cause }
  return { result, error, state, caseRecord, screenshots, scopeHarness }
}

test('MAINT-004 retains all three-source, real order V1/V2, historical snapshot and effective-priority assertions in isolated identity', async () => {
  const { result, error, state, caseRecord, screenshots, scopeHarness } = await runAssignmentCase()
  assert.equal(error, undefined)
  assert.equal(result.partial, true)
  assert.ok(caseRecord.checks.every((check) => check.passed), JSON.stringify(caseRecord.checks.filter((check) => !check.passed)))
  assert.equal(caseRecord.catalogAssertions.length, 5)
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.status), [
    'VERIFIED', 'VERIFIED', 'VERIFIED', 'GAP', 'VERIFIED'
  ])
  assert.equal(caseRecord.acceptanceGapAssertions.length, 2)
  assert.equal(caseRecord.acceptanceGapAssertions[0].status, 'GAP')
  assert.match(caseRecord.acceptanceGapAssertions[0].details, /仅输出 log\.warn/)
  assert.equal(caseRecord.acceptanceGapAssertions[1].status, 'VERIFIED')
  assert.deepEqual(caseRecord.remainingAssertions, [
    '无有效分配时生成链的受控配置缺失告警尚未完成验收'
  ])
  for (const name of [
    '真实发布生成器按最终命中分配生成唯一维修工单并固化 V1 来源',
    '停用 DEVICE 后再次发布由 PRODUCT 分配实际驱动 V1 维修工单',
    '停用 DEVICE/PRODUCT 后再次发布由 DEVICE_TYPE 分配实际驱动 V1 维修工单',
    '发布 V2 后实际生成新版本维修工单，旧 V1 工单来源快照不漂移',
    '全部三级分配停用后再次发布不生成新维修工单',
    '同层先排除未来与过期分配，再按显式优先级及较晚生效时间命中'
  ]) assert.ok(caseRecord.checks.some((check) => check.name === name && check.passed), name)
  assert.equal(state.retired, true)
  assert.equal(state.device, null)
  assert.equal(state.product, null)
  assert.equal(state.category, null)
  assert.equal(state.orders.length, 0)
  assert.equal(state.assignments.length, 0)
  assert.equal(state.plan.status, 'DISABLED')
  assert.equal(state.item.status, 1)
  assert.deepEqual(screenshots, ['maint-004-isolated-repair-orders'])
  assert.equal(scopeHarness.state.role.dataScope, 2)
  assert.deepEqual(scopeHarness.state.role.dataScopeDeptIds, ['56'])
  assert.equal(scopeHarness.state.adminRole.dataScope, 5)
})

test('a second device in the isolated tenant blocks before any plan/assignment publish and still cleans/retires', async () => {
  const { error, state } = await runAssignmentCase({ extraDevice: true })
  assert.match(error.message, /BLOCKED.*唯一专属设备/)
  assert.equal(state.retired, true)
  assert.equal(state.plan, null)
  assert.equal(state.device, null)
  assert.equal(state.product, null)
  assert.equal(state.category, null)
  assert.equal(state.writes.some((path) => path.includes('maintenance-plan')), false)
})

test('an unreadable created device fails without publishing or orphaning its owned product/category', async () => {
  const { result, error, state, caseRecord, screenshots } = await runAssignmentCase({ invisibleDevice: true })
  assert.equal(result, undefined)
  assert.match(error.message, /专属设备回读/)
  assert.equal(state.retired, true)
  assert.equal(state.device.id, '53')
  assert.equal(state.product.id, '52')
  assert.equal(state.category.id, '50')
  assert.equal(state.plan, null)
  assert.equal(state.item, null)
  assert.deepEqual(state.assignments, [])
  assert.deepEqual(state.orders, [])
  assert.equal(state.writes.some((path) => path.startsWith('/mes/')), false)
  assert.equal(caseRecord.passCandidate, undefined)
  assert.ok(caseRecord.checks.some((check) =>
    check.name === 'MAINT004 专属 IoT 设备测试数据已清理' && !check.passed &&
    /id=53.*专属设备回读/.test(check.details)))
  assert.ok(caseRecord.notes.some((note) => /MAINT-004 清理失败.*id=53/.test(note)))
  assert.equal(state.deletes.some(path => path.startsWith('/iot/')), false)
  assert.deepEqual(screenshots, [])
})

test('device cleanup failure fails the complete case and retains product/category without relaxing catalog assertions', async () => {
  for (const options of [{ deviceDeleteResult: false }, { keepDeviceAfterDelete: true }]) {
    const { result, error, state, caseRecord } = await runAssignmentCase(options)
    assert.equal(result, undefined)
    assert.match(error.message, /清理失败/)
    assert.equal(state.retired, true)
    assert.equal(state.device.id, '53')
    assert.equal(state.product.id, '52')
    assert.equal(state.category.id, '50')
    assert.equal(state.deletes.some(path => path.includes('/iot/product/delete')), false)
    assert.equal(state.deletes.some(path => path.includes('/iot/product-category/delete')), false)
    assert.equal(caseRecord.catalogAssertions.length, 5)
    assert.equal(caseRecord.checks.filter(check => !check.passed).length, 3)
  }
})

test('unconfirmed product deletion retains its category even after successful device deletion', async () => {
  for (const options of [{ productDeleteResult: false }, { keepProductAfterDelete: true }]) {
    const { result, error, state, caseRecord } = await runAssignmentCase(options)
    assert.equal(result, undefined)
    assert.match(error.message, /清理失败/)
    assert.equal(state.retired, true)
    assert.equal(state.device, null)
    assert.equal(state.product.id, '52')
    assert.equal(state.category.id, '50')
    assert.equal(state.deletes.some(path => path.includes('/iot/product-category/delete')), false)
    assert.equal(caseRecord.checks.filter(check => !check.passed).length, 2)
  }
})
