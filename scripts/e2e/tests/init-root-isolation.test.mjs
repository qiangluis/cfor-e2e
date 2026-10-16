import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'

import {
  ROOT_ISOLATION_CHECK,
  ROOT_ISOLATION_PERMISSIONS,
  ROOT_ISOLATION_PLATFORM_PERMISSIONS,
  buildRootIsolationPackage,
  rootIsolationId,
  rootIsolationReferencesSql,
  rootIsolationSpec,
  runFreshOrganizationRootEvidence
} from '../fixtures/init-root-isolation.mjs'
import { organizationRootFactsSql, validateOrganizationRootReadiness } from '../suites/init.mjs'
import { RESP_KEY } from '../lib/crypto.mjs'

const menus = () => [
  { id: '9007199254740993', parentId: 0, status: 0, component: 'system/index' },
  ...['system/tenant-workbench/index', 'system/user/index', 'system/role/index',
    'system/dept/index', 'system/enterprise-organization/index', 'system/systemInit/index']
    .map((component, index) => ({ id: String(index + 2), parentId: '9007199254740993', status: 0, component })),
  ...ROOT_ISOLATION_PERMISSIONS.map((permission, index) =>
    ({ id: String(index + 20), parentId: '5', status: 0, permission }))
]
const packagePlan = (overrides = {}) => {
  const rows = menus()
  return { standardPackage: { id: '111', status: 0, menuIds: rows.map((menu) => menu.id) },
    menus: rows, assignableMenus: rows, ...overrides }
}

function harness (options = {}) {
  const calls = []
  const tenantId = options.tenantId || '9007199254740995'
  const packageId = '9007199254740997'
  const userId = '9007199254740999'
  const rootId = '9007199254741001'
  const platformUserId = options.platformUserId || '1'
  const state = { package: null, tenant: null, user: null, roots: [], issued: false, loggedOut: false }
  let currentToken = ''
  const context = { record: { api: [] }, caseRecord: { checks: [], notes: [], database: [] } }
  const defaultRoot = () => ({
    id: '9007199254741011', name: '企业总部', code: '', parentId: 0,
    status: 0, sort: 1, creator: userId
  })
  const seededRoot = () => ({
    id: '9007199254741011', name: '销售部', code: 'DEPT-7ecdf509feb84539a55ab9162eafab16',
    parentId: 0, status: 0, sort: 10, creator: platformUserId,
    ...options.seededRootOverride
  })
  const response = (data) => ({ code: 0, data })
  const platformPermissionInfo = options.platformPermissionInfo || {
    roles: ['super_admin'],
    permissions: [...ROOT_ISOLATION_PLATFORM_PERMISSIONS, ...ROOT_ISOLATION_PERMISSIONS]
  }
  const assertVisitPermission = (requestOptions) => {
    assert.equal(requestOptions?.headers?.['visit-tenant-id'], tenantId)
    if (options.failVisit || !(platformPermissionInfo.roles?.includes('super_admin') ||
        platformPermissionInfo.permissions?.includes('system:tenant:visit'))) {
      throw new Error('tenant visit rejected: code=403, data=null, msg=您无权切换租户')
    }
  }
  const assertDepartmentContext = (requestOptions) => {
    if (requestOptions?.isolatedIdentity) {
      throw new Error('code=1002004002, data=null, msg=当前部门不存在; tenant_admin data scope SELF')
    }
    assertVisitPermission(requestOptions)
  }
  const readiness = () => {
    const active = state.roots.filter((row) => row.status === 0 || options.countDisabled).length
    const item = { key: 'system.organization-root', count: active,
      status: active ? 'READY' : 'NOT_STARTED', selected: true, skippable: false }
    return response({ items: options.duplicateReadiness ? [item, item] : [item] })
  }
  const getBusiness = async (path, requestOptions) => {
    calls.push(['GET', path, requestOptions])
    if (path === '/system/auth/get-permission-info') {
      const info = requestOptions?.isolatedIdentity
        ? { user: { id: options.permissionUserId || userId, username: state.user.username },
            permissions: options.tenantPermissions ?? [...ROOT_ISOLATION_PERMISSIONS] }
        : options.noPermissions ? { roles: [], permissions: [] } : platformPermissionInfo
      return response({ user: { id: platformUserId }, ...info })
    }
    if (path === '/system/tenant-package/get?id=111') return response(packagePlan().standardPackage)
    if (path.startsWith('/system/menu/')) return response(menus())
    if (path.startsWith('/system/tenant-package/get?')) return response(state.package)
    if (path.startsWith('/system/tenant/get?')) return response(state.tenant)
    if (path.startsWith('/system/user/get?')) {
      assertVisitPermission(requestOptions)
      return response(state.user)
    }
    if (path.startsWith('/system/dept/get?')) {
      assertDepartmentContext(requestOptions)
      if (options.unreadableVisitedRoot) return response(null)
      const requestedId = path.split('id=')[1]
      const root = state.roots.find((row) => row.id === requestedId)
      return response(root ? { ...root, ...options.visitedRootOverride } : null)
    }
    if (path.endsWith('/readiness')) {
      assert.equal(requestOptions?.isolatedIdentity, true,
        'BusinessTenantResolver uses the login user, not platform visit-tenant-id')
      return readiness()
    }
    throw new Error(`unexpected GET ${path}`)
  }
  const postBusiness = async (path, body, requestOptions) => {
    calls.push(['POST', path, body, requestOptions])
    if (path === '/system/tenant-package/create') {
      state.package = { ...body, id: packageId }
      if (options.failPackageResponse) throw new Error('package response interrupted')
      return response(packageId)
    }
    if (path === '/system/tenant/create') {
      state.tenant = { ...body, id: tenantId, contactUserId: userId }
      state.user = { id: userId, username: body.username, tenantId, deptId: null, status: 0 }
      if (options.defaultBeforeLogin) state.roots = [defaultRoot()]
      if (options.seededBeforeLogin) state.roots = [seededRoot()]
      if (options.failTenantResponse) throw new Error('tenant response interrupted')
      return response(options.tenantResponseId || tenantId)
    }
    if (path === '/system/dept/create') {
      assertDepartmentContext(requestOptions)
      state.roots = [{ ...body, id: rootId, creator: options.foreignRootCreator ? userId : platformUserId }]
      if (options.failRootResponse) throw new Error('root response interrupted')
      return response(rootId)
    }
    if (path === '/system/auth/logout') {
      if (options.failLogout) throw new Error('logout failed')
      state.loggedOut = true
      return response(true)
    }
    throw new Error(`unexpected POST ${path}`)
  }
  const putBusiness = async (path, body, requestOptions) => {
    calls.push(['PUT', path, body, requestOptions])
    if (path === '/system/dept/update') {
      assertDepartmentContext(requestOptions)
      if (options.failUpdate) throw new Error('root update failed')
      assert.equal(body.id, rootId)
      Object.assign(state.roots[0], body)
    } else if (path === '/system/user/update-status') {
      assertVisitPermission(requestOptions)
      assert.equal(body.id, userId)
      if (options.failUserCleanup) throw new Error('user retirement failed')
      if (!options.noopUserCleanup) state.user.status = body.status
    } else if (path === '/system/tenant/update') {
      assert.equal(body.id, tenantId)
      assert.equal(Object.hasOwn(body, 'password'), false)
      if (options.failTenantCleanup) throw new Error('tenant retirement failed')
      if (!options.noopTenantCleanup) state.tenant.status = body.status
    } else if (path === '/system/tenant-package/update') {
      assert.equal(body.id, packageId)
      if (options.failPackageCleanup) throw new Error('package retirement failed')
      if (!options.noopPackageCleanup) state.package.status = body.status
    } else throw new Error(`unexpected PUT ${path}`)
    return response(true)
  }
  const deleteBusiness = async (path, requestOptions) => {
    calls.push(['DELETE', path, requestOptions])
    assertDepartmentContext(requestOptions)
    assert.equal(path, `/system/dept/delete?id=${state.roots[0].id}`)
    if (options.failDelete) throw new Error('root cleanup failed')
    state.roots = []
    return response(true)
  }
  const api = { getBusiness, postBusiness, putBusiness, deleteBusiness }
  const listeners = new Map()
  const page = {
    on: (event, handler) => listeners.set(event, handler),
    off: (event) => listeners.delete(event),
    async evaluate () { return state.issued ? [['ACCESS_TOKEN', currentToken]] : [] },
    async close () {
      calls.push(['CLOSE_PAGE'])
      if (options.failPageClose) throw new Error('page close failed')
    }
  }
  const isolated = {
    async newPage () { return page },
    async close () { calls.push(['CLOSE_CONTEXT']) }
  }
  const deps = {
    adminApi: api,
    factsSql: organizationRootFactsSql,
    validateReadiness: validateOrganizationRootReadiness,
    browser: { async newContext () {
      if (options.failContext) throw new Error('browser context failed')
      return isolated
    } },
    observePage: () => ({ async flushResponses () {
      calls.push(['FLUSH'])
      if (options.failFlush) throw new Error('flush failed')
    } }),
    createApiClient ({ token, tenantId: requestedTenant }) {
      assert.equal(requestedTenant, tenantId)
      assert.match(token, /token-/)
      const isolatedOptions = (requestOptions) => ({ ...requestOptions, isolatedIdentity: true })
      return { ...api,
        getBusiness: (path, requestOptions) => getBusiness(path, isolatedOptions(requestOptions)),
        postBusiness: (path, body, requestOptions) => postBusiness(path, body, isolatedOptions(requestOptions)),
        putBusiness: (path, body, requestOptions) => putBusiness(path, body, isolatedOptions(requestOptions)),
        deleteBusiness: (path, requestOptions) => deleteBusiness(path, isolatedOptions(requestOptions)) }
    },
    async login (_page, authOptions) {
      calls.push(['LOGIN', { tenantName: authOptions.credentials.tenantName }])
      assert.equal(authOptions.credentials.tenantName, state.tenant.name)
      assert.equal(authOptions.credentials.username, state.user.username)
      assert.equal(authOptions.returnContext, true)
      if (options.defaultAfterLogin) state.roots = [defaultRoot()]
      if (options.seededAfterLogin) state.roots = [seededRoot()]
      if (options.foreignDefaultCreator) state.roots = [{ ...defaultRoot(), creator: '1' }]
      if (options.unexpectedRoot) state.roots = [{ ...defaultRoot(), name: 'existing department' }]
      if (options.extraOrganization) state.roots = [defaultRoot(), { ...defaultRoot(), id: '300' }]
      if (options.rootChangedAfterLogin && state.roots.length) {
        Object.assign(state.roots[0], options.rootChangedAfterLogin)
      }
      if (options.rootRemovedAfterLogin) state.roots = []
      if (options.failLogin) {
        if (options.issuedBeforeFailure) {
          state.issued = true
          currentToken = 'token-issued-before-login-failure'
          if (!options.storageOnly) {
            const payload = JSON.stringify(response({ tenantId, accessToken: currentToken }))
            const cipher = createCipheriv('aes-256-ecb',
              Buffer.from(process.env.CFOR_API_ENCRYPT_RESPONSE_KEY || RESP_KEY), null)
            const text = options.encryptedLoginResponse
              ? Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('base64')
              : payload
            listeners.get('response')({
              url: () => 'http://127.0.0.1:48083/admin-api/system/auth/login-encrypted',
              request: () => ({ method: () => 'POST' }),
              headers: () => options.encryptedLoginResponse ? { 'x-api-encrypt': 'true' } : {},
              text: async () => text
            })
          }
        }
        throw new Error('login bootstrap failed')
      }
      state.issued = true
      currentToken = 'token-root-isolated'
      return { token: 'token-root-isolated', tenantId: options.loginTenantId || tenantId }
    },
    async readDb (_record, stage, sql) {
      calls.push(['SQL', stage, sql])
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|REPLACE)\b/i)
      let rows
      if (stage.endsWith('marker-preflight')) {
        rows = ['package', 'tenant', 'user'].map((key) => [key, options.markerExists ? '1' : '0'])
      } else if (stage.endsWith('package-owner') || stage.endsWith('retired-package')) {
        rows = state.package ? [[packageId, state.package.name, String(state.package.status)]] : []
      } else if (stage.endsWith('tenant-owner') || stage.endsWith('retired-tenant')) {
        rows = state.tenant ? [[tenantId, state.tenant.name,
          options.foreignPackage ? '111' : packageId, userId, String(state.tenant.status)]] : []
      } else if (stage.endsWith('package-tenants')) {
        rows = state.tenant ? [[tenantId, state.tenant.name]] : []
        if (options.extraPackageTenant) rows.push(['888', 'unrelated tenant'])
      } else if (stage.endsWith('user-owner') || stage.endsWith('retired-user')) {
        rows = state.user ? [[userId, options.foreignUser ? 'existingadmin' : state.user.username,
          tenantId, state.user.deptId || '', String(state.user.status)]] : []
      } else if (stage.endsWith('reference-guard')) {
        rows = ['other-departments', 'user-references', 'role-references']
          .map((key) => [key, (options.reference === key ? '1' : '0')])
        if (options.duplicateReference) rows.push(rows[0])
      } else if (stage.endsWith('revoked-tokens')) {
        rows = ['access-tokens', 'refresh-tokens'].map((key) =>
          [key, state.issued && (!state.loggedOut || options.logoutDidNotRevoke) ? '1' : '0'])
      } else if (/\bFROM system_dept\b/.test(sql) && !sql.includes("'active-root'")) {
        if (stage === 'isolated-root-root-owner' && options.rootChangedBeforeDelete) {
          Object.assign(state.roots[0], options.rootChangedBeforeDelete)
        }
        rows = state.roots.map((row) => [row.id, row.name, row.tenantId || tenantId, String(row.parentId),
          row.code, String(row.status), String(row.sort),
          row.leaderUserId || '', row.supervisorUserId || '', row.creator])
      } else if (sql.includes("'active-root'")) {
        assert.match(sql, new RegExp(`tenant_id=${tenantId}\\b`))
        rows = [['active-root', String(state.roots.filter((row) => row.status === 0).length)],
          ['all-root', String(state.roots.length)]]
      } else throw new Error(`unexpected SQL ${stage}: ${sql}`)
      context.caseRecord.database.push({ stage, rows })
      return rows
    }
  }
  return { context, deps, calls, state, tenantId, packageId, userId }
}

const run = (fixture) => runFreshOrganizationRootEvidence(fixture.context, fixture.deps)
const errorMessages = (error) => error instanceof AggregateError
  ? error.errors.flatMap(errorMessages) : [error.message]
const assertRetired = ({ state }) => {
  assert.equal(state.user.status, 1)
  assert.equal(state.tenant.status, 1)
  assert.equal(state.package.status, 1)
}

test('private root package retains exact IDs, parent chains and explicit least-required permissions', () => {
  const plan = buildRootIsolationPackage(packagePlan())
  assert.ok(plan.menuIds.includes('9007199254740993'))
  assert.equal(new Set(plan.menuIds).size, plan.menuIds.length)
  for (const change of [
    (p) => { p.standardPackage.status = 1 },
    (p) => { p.standardPackage.menuIds = p.standardPackage.menuIds.filter((id) => id !== '5') },
    (p) => { p.assignableMenus = p.assignableMenus.filter((row) => row.id !== '5') },
    (p) => { p.menus.find((row) => row.id === '5').status = 1 },
    (p) => { p.menus.find((row) => row.id === '5').parentId = '5' },
    (p) => { p.menus = p.menus.filter((row) => row.id !== '5') }
  ]) {
    const p = packagePlan()
    change(p)
    assert.throws(() => buildRootIsolationPackage(p), /BLOCKED/)
  }
  assert.throws(() => rootIsolationId(Number.MAX_SAFE_INTEGER + 2), /exact positive ID/)
  assert.throws(() => rootIsolationId('2;DELETE'), /exact positive ID/)
  assert.match(rootIsolationReferencesSql('2', '3'), /tenant_id=2 AND dept_id=3/)
})

test('root isolation skips a duplicate component outside the package', () => {
  const input = packagePlan()
  const validDept = input.menus.find((row) => row.component === 'system/dept/index')
  input.menus.push({
    id: '999',
    parentId: validDept.parentId,
    status: 0,
    deleted: 0,
    component: 'system/dept/index'
  })
  input.standardPackage.menuIds = input.standardPackage.menuIds.filter((id) => id !== '999')
  input.assignableMenus = input.assignableMenus.filter((row) => row.id !== '999')
  const plan = buildRootIsolationPackage(input)
  assert.ok(plan.menuIds.includes(validDept.id))
  assert.equal(plan.menuIds.includes('999'), false)
})

test('each root fixture gets fresh random tenant/package/account markers within API limits', () => {
  const first = rootIsolationSpec()
  const second = rootIsolationSpec()
  assert.notEqual(first.marker, second.marker)
  assert.notEqual(first.tenantPayload.name, second.tenantPayload.name)
  assert.notEqual(first.packagePayload.name, second.packagePayload.name)
  assert.notEqual(first.tenantPayload.username, second.tenantPayload.username)
  assert.ok(first.tenantPayload.name.length <= 30 && first.packagePayload.name.length <= 30)
  assert.match(first.tenantPayload.username, /^[A-Za-z0-9]{4,30}$/)
  assert.ok(first.tenantPayload.password.length >= 4 && first.tenantPayload.password.length <= 16)
})

test('fresh root lifecycle proves all four exact API/SQL phases and retires all owned resources', async () => {
  const fixture = harness()
  assert.deepEqual(await run(fixture), { executed: true })
  assert.deepEqual(fixture.state.roots, [])
  assertRetired(fixture)
  assert.equal(fixture.state.loggedOut, true)
  assert.deepEqual(fixture.context.caseRecord.checks.map(({ name, passed }) => ({ name, passed })),
    [{ name: ROOT_ISOLATION_CHECK, passed: true }])
  const details = fixture.context.caseRecord.checks[0].details
  for (const stage of ['absent', 'active', 'disabled', 'cleaned']) assert.match(details, new RegExp(stage))
  const phases = fixture.context.caseRecord.database.filter((row) =>
    /isolated-root-(absent|active|disabled|cleaned)$/.test(row.stage))
  assert.deepEqual(phases.map((row) => row.rows),
    [[['active-root', '0'], ['all-root', '0']], [['active-root', '1'], ['all-root', '1']],
      [['active-root', '0'], ['all-root', '1']], [['active-root', '0'], ['all-root', '0']]])
  const logout = fixture.calls.findIndex((call) => call[1] === '/system/auth/logout')
  assert.ok(logout > fixture.calls.findIndex((call) => call[0] === 'CLOSE_CONTEXT'))
  assert.ok(logout < fixture.calls.findIndex((call) => call[1] === '/system/tenant/update'))
  assert.doesNotMatch(JSON.stringify(fixture.context.caseRecord), /token-root-isolated|Root!/)
})

test('unique default root created before/after login can only be removed after owner/reference guards', async () => {
  for (const option of ['defaultBeforeLogin', 'defaultAfterLogin']) {
    const fixture = harness({ [option]: true })
    await run(fixture)
    assertRetired(fixture)
    const deletes = fixture.calls.filter((call) => call[0] === 'DELETE')
    assert.equal(deletes.length, 2)
    assert.match(deletes[0][1], /9007199254741011/)
    const guarded = fixture.calls.findIndex((call) => call[0] === 'SQL' &&
      call[1] === 'isolated-root-reference-guard')
    assert.ok(guarded < fixture.calls.findIndex((call) => call[0] === 'DELETE'))
    assert.equal(fixture.context.caseRecord.checks[0].passed, true)
  }
})

test('r15 BPM-seeded sales root is owned by the actual platform creator, not the tenant administrator', async () => {
  for (const platformUserId of ['1', '9007199254741111']) {
    const fixture = harness({ seededBeforeLogin: true, platformUserId })
    assert.deepEqual(await run(fixture), { executed: true })
    assertRetired(fixture)
    assert.equal(fixture.state.loggedOut, true)
    assert.deepEqual(fixture.state.roots, [])
    const before = fixture.context.caseRecord.database.find((row) => row.stage === 'isolated-root-before-login')
    const after = fixture.context.caseRecord.database.find((row) => row.stage === 'isolated-root-after-login')
    assert.deepEqual(before.rows, [[
      '9007199254741011', '销售部', fixture.tenantId, '0',
      'DEPT-7ecdf509feb84539a55ab9162eafab16', '0', '10', '', '', platformUserId
    ]])
    assert.deepEqual(after.rows, before.rows)
    const deletes = fixture.calls.filter((call) => call[0] === 'DELETE')
    assert.equal(deletes.length, 2)
    assert.equal(deletes[0][1], '/system/dept/delete?id=9007199254741011')
    assert.equal(fixture.context.caseRecord.checks[0].passed, true)
  }
})

test('sales-shaped roots require the pre-login creation baseline and the exact creator/shape', async () => {
  for (const options of [
    { seededAfterLogin: true },
    ...[
      { name: 'existing department' }, { code: 'DEPT-shared' },
      { code: 'DEPT-7ECDF509FEB84539A55AB9162EAFAB16' },
      { creator: '888' }, { creator: '9007199254740999' }, { creator: '' },
      { tenantId: '1' }, { parentId: '130' }, { status: 1 }, { sort: 1 },
      { leaderUserId: '1' }, { supervisorUserId: '1' }
    ].map((seededRootOverride) => ({ seededBeforeLogin: true, seededRootOverride }))
  ]) {
    const fixture = harness(options)
    await assert.rejects(run(fixture), /unique owned fresh\/default root/)
    assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
    assertRetired(fixture)
    assert.equal(fixture.state.loggedOut, true)
    assert.equal(fixture.state.roots.length, 1)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('every captured default-root field must remain identical through login and the final owner guard', async () => {
  for (const field of [
    { id: '9007199254741013' }, { name: 'changed name' },
    { tenantId: '1' }, { parentId: 1 },
    { code: 'DEPT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { status: 1 }, { sort: 11 },
    { leaderUserId: '1' }, { supervisorUserId: '1' }, { creator: '888' }
  ]) {
    for (const drift of ['rootChangedAfterLogin', 'rootChangedBeforeDelete']) {
      const fixture = harness({ seededBeforeLogin: true, [drift]: field })
      await assert.rejects(run(fixture), /creation baseline|unique owned/)
      assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
      assertRetired(fixture)
      assert.equal(fixture.state.loggedOut, true)
      assert.equal(fixture.context.caseRecord.checks[0].passed, false)
    }
  }
  const fixture = harness({ seededBeforeLogin: true, rootRemovedAfterLogin: true })
  await assert.rejects(run(fixture), /creation baseline/)
  assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
  assertRetired(fixture)
})

test('known BPM roots with any organization/user/role references still cannot be mutated', async () => {
  for (const options of [
    ...['other-departments', 'user-references', 'role-references'].map((reference) => ({ reference })),
    { duplicateReference: true }, { extraOrganization: true }
  ]) {
    const fixture = harness({ seededBeforeLogin: true, ...options })
    await assert.rejects(run(fixture), /existing organizations|creation baseline|references/)
    assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
    assertRetired(fixture)
    assert.equal(fixture.state.loggedOut, true)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('missing or inexact platform creator identity blocks the fresh lifecycle before writes', async () => {
  for (const user of [null, {}, { id: 'unknown' }, { id: Number.MAX_SAFE_INTEGER + 2 }]) {
    const fixture = harness({
      platformPermissionInfo: { roles: ['super_admin'], permissions: [], user }
    })
    await assert.rejects(run(fixture), /exact positive ID/)
    assert.equal(fixture.calls.some((call) => ['POST', 'PUT', 'DELETE', 'LOGIN'].includes(call[0])), false)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('unknown roots, foreign creators, references and duplicate guard rows forbid default root mutation', async () => {
  for (const options of [
    { unexpectedRoot: true }, { foreignDefaultCreator: true }, { extraOrganization: true },
    ...['other-departments', 'user-references', 'role-references']
      .map((reference) => ({ defaultAfterLogin: true, reference })),
    { defaultAfterLogin: true, duplicateReference: true }
  ]) {
    const fixture = harness(options)
    await assert.rejects(run(fixture), /owned|existing|references/)
    assert.equal(fixture.calls.some((call) => call[0] === 'DELETE' || call[1] === '/system/dept/create'), false)
    assertRetired(fixture)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('shared tenant, foreign package/user and extra package tenant never reach root APIs', async () => {
  for (const options of [
    { tenantId: '1' }, { foreignPackage: true }, { foreignUser: true }, { extraPackageTenant: true }
  ]) {
    const fixture = harness(options)
    await assert.rejects(run(fixture), /non-shared|mismatch|references/)
    assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('write-free preflight rejects missing platform permissions or a pre-existing marker', async () => {
  for (const options of [{ noPermissions: true }, { markerExists: true }]) {
    const fixture = harness(options)
    await assert.rejects(run(fixture), /permissions|marker/)
    assert.equal(fixture.calls.some((call) => ['POST', 'PUT', 'DELETE', 'LOGIN'].includes(call[0])), false)
  }
})

test('r11 super_admin without a visit menu or wildcard completes the owned lifecycle', async () => {
  const platformPermissionInfo = {
    roles: ['super_admin'], permissions: [...ROOT_ISOLATION_PLATFORM_PERMISSIONS]
  }
  assert.equal(platformPermissionInfo.permissions.includes('system:tenant:visit'), false)
  assert.equal(platformPermissionInfo.permissions.includes('*:*:*'), false)
  assert.equal(menus().some((menu) => menu.permission === 'system:tenant:visit'), false)
  const fixture = harness({ platformPermissionInfo })
  assert.deepEqual(await run(fixture), { executed: true })
  assertRetired(fixture)
  assert.equal(fixture.state.loggedOut, true)
  assert.equal(fixture.context.caseRecord.checks[0].passed, true)
  assert.equal(fixture.calls.filter((call) =>
    call[1] === '/system/user/update-status' || String(call[1]).startsWith('/system/user/get?')).length, 2)
})

test('platform department CRUD requires its real permissions but not tenant readiness permission', async () => {
  const platformPermissionInfo = {
    roles: ['fixture_operator'],
    permissions: [...ROOT_ISOLATION_PLATFORM_PERMISSIONS, 'system:tenant:visit']
  }
  assert.equal(platformPermissionInfo.permissions.includes('system:system-init:query'), false)
  for (const permission of ['system:dept:query', 'system:dept:create', 'system:dept:update', 'system:dept:delete']) {
    assert.equal(platformPermissionInfo.permissions.includes(permission), true)
  }
  const fixture = harness({ platformPermissionInfo })
  assert.deepEqual(await run(fixture), { executed: true })
  assertRetired(fixture)
  assert.equal(fixture.context.caseRecord.checks[0].passed, true)
})

test('r18 SELF-scoped tenant identity is retained for readiness, and all department CRUD uses exact platform visit', async () => {
  const fixture = harness({ seededBeforeLogin: true })
  assert.deepEqual(await run(fixture), { executed: true })
  const departmentCalls = fixture.calls.filter((call) => /\/system\/dept\//.test(call[1] || ''))
  assert.ok(departmentCalls.some((call) => call[0] === 'GET'))
  assert.ok(departmentCalls.some((call) => call[0] === 'POST'))
  assert.ok(departmentCalls.some((call) => call[0] === 'PUT'))
  assert.equal(departmentCalls.filter((call) => call[0] === 'DELETE').length, 2)
  for (const call of departmentCalls) {
    const requestOptions = call[['POST', 'PUT'].includes(call[0]) ? 3 : 2]
    assert.equal(requestOptions?.isolatedIdentity, undefined)
    assert.deepEqual(requestOptions?.headers, { 'visit-tenant-id': fixture.tenantId })
  }
  const readinessCalls = fixture.calls.filter((call) => call[1] === '/system/system-init/readiness')
  assert.equal(readinessCalls.length, 4)
  for (const call of readinessCalls) {
    assert.equal(call[2]?.isolatedIdentity, true)
    assert.equal(call[2]?.headers?.['visit-tenant-id'], undefined)
  }
  assert.deepEqual(fixture.context.caseRecord.rootAccessContext, {
    departmentActorId: '1', departmentVisitTenantId: fixture.tenantId,
    readinessActorId: fixture.userId, readinessTenantId: fixture.tenantId
  })
  const isolatedApi = fixture.deps.createApiClient({ token: 'token-isolated-self', tenantId: fixture.tenantId })
  await assert.rejects(isolatedApi.getBusiness('/system/dept/get?id=9007199254741011'),
    /1002004002.*tenant_admin data scope SELF/)
  assertRetired(fixture)
  assert.equal(fixture.state.loggedOut, true)
  assert.equal(fixture.context.caseRecord.checks[0].passed, true)
})

test('formal visited department readback must match every owned root field before any mutation', async () => {
  for (const options of [
    { unreadableVisitedRoot: true },
    ...[
      { id: '130' }, { name: 'shared root' }, { parentId: 1 }, { code: 'SHARED' },
      { status: 1 }, { sort: 9999 }, { leaderUserId: '1' }, { supervisorUserId: '1' }
    ].map((visitedRootOverride) => ({ visitedRootOverride }))
  ]) {
    const fixture = harness({ seededBeforeLogin: true, ...options })
    await assert.rejects(run(fixture), /platform visit cannot read the exact owned root/)
    assert.equal(fixture.calls.some((call) =>
      call[0] !== 'GET' && /\/system\/dept\//.test(call[1] || '')), false)
    assertRetired(fixture)
    assert.equal(fixture.state.loggedOut, true)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('a stale or foreign token identity cannot supply the isolated readiness evidence', async () => {
  const fixture = harness({ seededBeforeLogin: true, permissionUserId: '1' })
  await assert.rejects(run(fixture), /fresh tenant readiness identity mismatch/)
  assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
  assertRetired(fixture)
  assert.equal(fixture.state.loggedOut, true)
  assert.equal(fixture.context.caseRecord.checks[0].passed, false)
})

test('non-super administrators missing real API or visit authorization fail before writes', async () => {
  for (const missing of [...ROOT_ISOLATION_PLATFORM_PERMISSIONS, 'system:tenant:visit']) {
    const fixture = harness({
      platformPermissionInfo: { roles: ['fixture_operator'],
        permissions: [...ROOT_ISOLATION_PLATFORM_PERMISSIONS, 'system:tenant:visit']
          .filter((permission) => permission !== missing) }
    })
    await assert.rejects(run(fixture), (error) => {
      assert.ok(error.message.includes(missing), error.message)
      return true
    })
    assert.equal(fixture.calls.some((call) => ['POST', 'PUT', 'DELETE', 'LOGIN'].includes(call[0])), false)
  }
  for (const roles of [['tenant_admin'], ['SUPER_ADMIN'], 'super_admin', []]) {
    const fixture = harness({
      platformPermissionInfo: { roles, permissions: [...ROOT_ISOLATION_PLATFORM_PERMISSIONS, '*:*:*'] }
    })
    await assert.rejects(run(fixture), /permissions: system:tenant:visit/)
    assert.equal(fixture.calls.some((call) => ['POST', 'PUT', 'DELETE', 'LOGIN'].includes(call[0])), false)
  }
})

test('backend tenant visit refusal is not swallowed after the platform preflight passes', async () => {
  const fixture = harness({ failVisit: true })
  await assert.rejects(run(fixture), /code=403, data=null, msg=您无权切换租户/)
  assert.equal(fixture.state.user.status, 0)
  assert.equal(fixture.state.tenant.status, 1)
  assert.equal(fixture.state.package.status, 1)
  assert.equal(fixture.state.loggedOut, true)
  assert.equal(fixture.context.caseRecord.checks[0].passed, false)
})

test('platform super_admin does not waive the isolated tenant root API permission gate', async () => {
  const fixture = harness({ tenantPermissions: [] })
  await assert.rejects(run(fixture), /fresh tenant lacks root fixture permissions/)
  assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
  assertRetired(fixture)
  assert.equal(fixture.state.loggedOut, true)
  assert.equal(fixture.context.caseRecord.checks[0].passed, false)
})

test('package/tenant/root response loss recovers only marker-owned rows and retains the primary error', async () => {
  for (const option of ['failPackageResponse', 'failTenantResponse', 'failRootResponse']) {
    const fixture = harness({ [option]: true })
    await assert.rejects(run(fixture), /response interrupted/)
    assert.equal(fixture.state.package.status, 1)
    if (fixture.state.tenant) assertRetired(fixture)
    assert.deepEqual(fixture.state.roots, [])
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('tenant creation response mismatch does not write to the response ID', async () => {
  const fixture = harness({ tenantResponseId: '1' })
  await assert.rejects(run(fixture), /response\/SQL/)
  assertRetired(fixture)
  assert.equal(fixture.calls.some((call) => call[0] === 'LOGIN'), false)
  assert.equal(fixture.calls.some((call) => call[2]?.id === '1'), false)
})

test('disabled root miscount and duplicate readiness keys are failures, never evidence PASS', async () => {
  for (const options of [{ countDisabled: true }, { duplicateReadiness: true }]) {
    const fixture = harness(options)
    await assert.rejects(run(fixture), /API\/SQL mismatch/)
    assertRetired(fixture)
    assert.deepEqual(fixture.state.roots, [])
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('login failure retires account/package/tenant and logs out tokens issued before bootstrap failure', async () => {
  for (const options of [
    { failLogin: true }, { failLogin: true, issuedBeforeFailure: true },
    { failLogin: true, issuedBeforeFailure: true, encryptedLoginResponse: true },
    { failLogin: true, issuedBeforeFailure: true, storageOnly: true }, { failContext: true }
  ]) {
    const fixture = harness(options)
    await assert.rejects(run(fixture), /login bootstrap failed|browser context failed/)
    assertRetired(fixture)
    assert.equal(fixture.state.loggedOut, Boolean(options.issuedBeforeFailure))
    assert.equal(fixture.calls.some((call) => /\/system\/dept\//.test(call[1] || '')), false)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  }
})

test('primary, root cleanup, logout and all retirement errors remain aggregated while cleanup continues', async () => {
  const fixture = harness({ failUpdate: true, failDelete: true, failLogout: true,
    failUserCleanup: true, failTenantCleanup: true, failPackageCleanup: true, failPageClose: true })
  await assert.rejects(run(fixture), (error) => {
    assert.ok(error instanceof AggregateError)
    const messages = errorMessages(error)
    for (const message of ['root update failed', 'root cleanup failed', 'logout failed',
      'user retirement failed', 'tenant retirement failed', 'package retirement failed', 'page close failed']) {
      assert.ok(messages.includes(message), message)
    }
    return true
  })
  assert.equal(fixture.context.caseRecord.checks[0].passed, false)
  for (const path of ['/system/user/update-status', '/system/tenant/update', '/system/tenant-package/update']) {
    assert.ok(fixture.calls.some((call) => call[1] === path), path)
  }
})

test('flush-only failures still close browser/logout/retire and cannot be swallowed by success', async () => {
  const fixture = harness({ failFlush: true })
  await assert.rejects(run(fixture), /flush failed/)
  assertRetired(fixture)
  assert.equal(fixture.state.loggedOut, true)
  assert.ok(fixture.calls.some((call) => call[0] === 'CLOSE_CONTEXT'))
  assert.equal(fixture.context.caseRecord.checks[0].passed, false)
})

test('logout HTTP/business success without access/refresh token revocation cannot pass', async () => {
  const fixture = harness({ logoutDidNotRevoke: true })
  await assert.rejects(run(fixture), /not fully revoked/)
  assertRetired(fixture)
  assert.equal(fixture.context.caseRecord.checks[0].passed, false)
})

test('no-op retirement APIs cannot pass even when HTTP/business responses report success', async () => {
  for (const option of ['noopUserCleanup', 'noopTenantCleanup', 'noopPackageCleanup']) {
    const fixture = harness({ [option]: true })
    await assert.rejects(run(fixture), /retirement.*mismatch/)
    assert.equal(fixture.context.caseRecord.checks[0].passed, false)
    for (const path of ['/system/user/update-status', '/system/tenant/update', '/system/tenant-package/update']) {
      assert.ok(fixture.calls.some((call) => call[1] === path), path)
    }
  }
})

test('a created root with a foreign creator is not updated or deleted, and remains a failed lifecycle', async () => {
  const fixture = harness({ foreignRootCreator: true })
  await assert.rejects(run(fixture), /unique owned/)
  assert.equal(fixture.calls.some((call) => call[1] === '/system/dept/update' || call[0] === 'DELETE'), false)
  assertRetired(fixture)
  assert.equal(fixture.context.caseRecord.checks[0].passed, false)
})

test('root isolation source never reuses the fixed tenant or issues raw SQL mutations', () => {
  const source = fs.readFileSync(new URL('../fixtures/init-root-isolation.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /ensureDedicatedTenant|dedicatedTenantSpec|runReadOnlySql|executeSql/)
  assert.match(source, /\/system\/auth\/logout/)
  assert.match(source, /\/system\/user\/update-status/)
  assert.match(source, /visit-tenant-id/)
})
