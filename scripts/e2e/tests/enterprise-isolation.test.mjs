import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  ENTERPRISE_ISOLATION_COMPONENTS,
  ENTERPRISE_ISOLATION_PERMISSIONS,
  assertTenantAdminIdentity,
  assertDepartmentOwnerRow,
  assertForeignDepartmentNotVisible,
  assertAuthenticatedTenantIdentity,
  buildEnterpriseIsolationPackage,
  BUILTIN_ROLE_DATA_SCOPE_REJECTION,
  enterpriseIsolationSpec,
  pageRows,
  runEnterpriseIsolationEvidence,
  tenantAdminIdentityMatches
} from '../fixtures/enterprise-isolation.mjs'

const makeMenus = () => {
  const root = { id: '9007199254740993', parentId: '0', status: 0, deleted: 0 }
  const components = ENTERPRISE_ISOLATION_COMPONENTS.map((component, index) => ({
    id: String(9007199254741000n + BigInt(index)),
    parentId: root.id,
    status: 0,
    deleted: 0,
    component
  }))
  const permissions = ENTERPRISE_ISOLATION_PERMISSIONS.map((permission, index) => ({
    id: String(9007199254741100n + BigInt(index)),
    parentId: root.id,
    status: 0,
    deleted: 0,
    permission
  }))
  return [root, ...components, ...permissions]
}

test('enterprise isolation package stays inside enabled, assignable standard-package menu ancestry', () => {
  const menus = makeMenus()
  const plan = buildEnterpriseIsolationPackage({
    standardPackage: { id: '111', status: 0, menuIds: menus.map((row) => row.id) },
    menus,
    assignableMenus: menus
  })
  assert.ok(plan.menuIds.includes('9007199254740993'))
  assert.equal(new Set(plan.menuIds).size, plan.menuIds.length)
  for (const change of [
    (value) => { value.standardPackage.status = 1 },
    (value) => { value.standardPackage.menuIds = value.standardPackage.menuIds.slice(1) },
    (value) => { value.assignableMenus = value.assignableMenus.slice(1) },
    (value) => { value.menus[1].status = 1 },
    (value) => { value.menus[1].parentId = value.menus[1].id }
  ]) {
    const rows = makeMenus()
    const input = {
      standardPackage: { id: '111', status: 0, menuIds: rows.map((row) => row.id) },
      menus: rows,
      assignableMenus: rows
    }
    change(input)
    assert.throws(() => buildEnterpriseIsolationPackage(input), /enterprise isolation/)
  }
})

test('enterprise isolation skips a duplicate component outside the package', () => {
  const menus = makeMenus()
  const validDept = menus.find((row) => row.component === 'system/dept/index')
  menus.push({
    id: '999',
    parentId: validDept.parentId,
    status: 0,
    deleted: 0,
    component: 'system/dept/index'
  })
  const plan = buildEnterpriseIsolationPackage({
    standardPackage: { id: '111', status: 0, menuIds: menus
      .filter((row) => row.id !== '999').map((row) => row.id) },
    menus,
    assignableMenus: menus.filter((row) => row.id !== '999')
  })
  assert.ok(plan.menuIds.includes(validDept.id))
  assert.equal(plan.menuIds.includes('999'), false)
})

test('enterprise isolation uses the backend permission guards for permission-list endpoints', () => {
  assert.ok(ENTERPRISE_ISOLATION_PERMISSIONS.includes('system:permission:assign-role-menu'))
  assert.ok(ENTERPRISE_ISOLATION_PERMISSIONS.includes('system:permission:assign-user-role'))
  assert.ok(ENTERPRISE_ISOLATION_PERMISSIONS.includes('system:permission:assign-role-data-scope'))
  assert.equal(ENTERPRISE_ISOLATION_PERMISSIONS.includes('system:permission:list-role-menus'), false)
  assert.equal(ENTERPRISE_ISOLATION_PERMISSIONS.includes('system:permission:list-user-roles'), false)
})

test('enterprise isolation preserves the backend built-in-role data-scope rejection contract', () => {
  assert.deepEqual(BUILTIN_ROLE_DATA_SCOPE_REJECTION, {
    code: 1002002003,
    message: '不能操作类型为系统内置的角色'
  })
  const source = fs.readFileSync(
    new URL('../fixtures/enterprise-isolation.mjs', import.meta.url), 'utf8'
  )
  assert.match(source, /BUILTIN_ROLE_DATA_SCOPE_REJECTION/)
  assert.match(source, /expectedBusinessRejection: BUILTIN_ROLE_DATA_SCOPE_REJECTION/)
  assert.match(source, /visit-tenant-id.*tenantId/s)
  assert.match(source, /platformApi: primaryApi/)
})

test('enterprise isolation preserves long IDs and generates bounded, non-shared markers', () => {
  const first = enterpriseIsolationSpec('marker-a')
  const second = enterpriseIsolationSpec('marker-b')
  assert.notEqual(first.marker, second.marker)
  assert.notEqual(first.tenantPayload.username, second.tenantPayload.username)
  assert.match(first.tenantPayload.username, /^[A-Za-z0-9]{4,30}$/)
  assert.ok(first.tenantPayload.name.length <= 30)
  assert.ok(first.packagePayload.name.length <= 30)
  assert.ok(first.tenantPayload.password.length >= 4 && first.tenantPayload.password.length <= 16)
  assert.throws(() => buildEnterpriseIsolationPackage({
    standardPackage: { id: '111', status: 0, menuIds: [Number.MAX_SAFE_INTEGER + 2] },
    menus: [{ id: Number.MAX_SAFE_INTEGER + 2, parentId: 0, status: 0 }],
    assignableMenus: []
  }), /enterprise isolation/)
})

test('tenant_admin evidence requires the real authenticated user and tenant identity', () => {
  const info = {
    user: { id: '9007199254741001', tenantId: '9007199254740999' },
    roles: ['tenant_admin'],
    permissions: ['system:enterprise-organization:query']
  }
  assert.equal(tenantAdminIdentityMatches(info, '9007199254740999', '9007199254741001'), true)
  assert.equal(tenantAdminIdentityMatches(info, '1', '9007199254741001'), false)
  assert.equal(tenantAdminIdentityMatches({ ...info, roles: ['super_admin'] },
    '9007199254740999', '9007199254741001'), false)
  assert.throws(() => assertTenantAdminIdentity(info, '1', '9007199254741001'),
    /真实登录账号不是目标 tenant_admin/)
})

test('authenticated tenant identity requires login response, permission user and formal tenant record', () => {
  const base = {
    auth: { token: 'token-12345678901234567890', tenantId: '9007199254740999' },
    permissionInfo: {
      user: { id: '9007199254741001' },
      roles: ['tenant_admin']
    },
    tenant: { id: '9007199254740999', name: 'E2E TENANT' },
    userId: '9007199254741001',
    tenantRecord: { id: '9007199254740999', name: 'E2E TENANT', status: 0 }
  }
  assert.equal(assertAuthenticatedTenantIdentity(base), true)
  assert.equal(assertAuthenticatedTenantIdentity({
    ...base,
    permissionInfo: { user: { id: base.userId }, roles: ['e2e_limited'] },
    requireTenantAdmin: false
  }), true)
  for (const change of [
    { auth: { ...base.auth, tenantId: '' } },
    { permissionInfo: { ...base.permissionInfo, user: { id: '9007199254741002' } } },
    { tenantRecord: { ...base.tenantRecord, name: 'FOREIGN TENANT' } },
    { tenantRecord: { ...base.tenantRecord, status: 1 } }
  ]) {
    assert.throws(() => assertAuthenticatedTenantIdentity({ ...base, ...change }),
      /enterprise isolation/)
  }
})

test('department authorization uses a strict formal page response and rejects malformed evidence', () => {
  assert.deepEqual(pageRows({ code: 0, data: { total: 1, list: [{ id: '1' }] } }), [{ id: '1' }])
  assert.deepEqual(pageRows({ code: 0, data: { total: 1, records: [{ id: '1' }] } }), [{ id: '1' }])
  for (const payload of [
    { code: 0, data: null },
    { code: 0, data: { total: 1 } },
    { code: 0, data: { total: 0, list: [{ id: '1' }] } },
    { code: 0, data: [] }
  ]) assert.throws(() => pageRows(payload), /enterprise isolation/)
})

test('department ownership evidence binds the SQL row to the created ID, code and tenant', () => {
  assert.equal(assertDepartmentOwnerRow(['9007199254741001', 'E2EA', '9007199254740999'], {
    departmentId: '9007199254741001',
    code: 'E2EA',
    tenantId: '9007199254740999'
  }), true)
  for (const row of [
    ['9007199254741002', 'E2EA', '9007199254740999'],
    ['9007199254741001', 'E2EB', '9007199254740999'],
    ['9007199254741001', 'E2EA', '1'],
    ['9007199254741001', 'E2EA'],
    null
  ]) {
    assert.throws(() => assertDepartmentOwnerRow(row, {
      departmentId: '9007199254741001',
      code: 'E2EA',
      tenantId: '9007199254740999'
    }), /部门数据库所有权回读不一致/)
  }
})

test('foreign department detail accepts code 0 with null data but rejects any returned row', () => {
  assert.equal(assertForeignDepartmentNotVisible({ code: 0, data: null }), true)
  assert.equal(assertForeignDepartmentNotVisible({ code: 403, data: null }), true)
  for (const response of [
    { code: 0, data: { id: '9007199254741001', tenantId: '1' } },
    { code: 200, success: true, data: { id: '9007199254741001', tenantId: '1' } },
    { code: 0, data: [] },
    null
  ]) assert.throws(() => assertForeignDepartmentNotVisible(response), /enterprise isolation/)
})

test('write-side disabled records a GAP without creating, logging into, or modifying a tenant', async () => {
  const calls = []
  const context = { caseRecord: { checks: [], notes: [], database: [] }, record: { api: [] } }
  const result = await runEnterpriseIsolationEvidence({
    context,
    primaryApi: {
      async getBusiness () { calls.push('GET'); throw new Error('must not call primary API') },
      async postBusiness () { calls.push('POST'); throw new Error('must not create') }
    },
    dependencies: {
      config: {
        target: 'local',
        tenantId: '1',
        tenantName: 'CFOR 标准平台',
        apiBase: 'http://127.0.0.1:48083',
        webBase: 'http://127.0.0.1:9151',
        db: { name: 'cfor_admin_standard' }
      },
      writeFixturesEnabled: false
    }
  })
  assert.deepEqual(result, { executed: false })
  assert.deepEqual(calls, [])
  assert.match(context.caseRecord.notes.join('; '), /GAP/)
})

test('enterprise isolation code separates real login identity from cleanup tenant switching', () => {
  const source = fs.readFileSync(
    new URL('../fixtures/enterprise-isolation.mjs', import.meta.url), 'utf8'
  )
  assert.match(source, /String\(auth\?\.tenantId\) === String\(tenant\.id\)/)
  assert.match(source, /assertTenantAdminIdentity\(info, tenantId, userId\)/)
  assert.match(source, /visit-tenant-id/)
  assert.match(source, /system\/auth\/logout/)
  assert.match(source, /loginWithCredentials\(page, credentials, \{ returnContext: true/)
  assert.match(source, /visit-tenant-id.*String\(tenant\.id\)/s)
  assert.match(source, /const forbiddenDetail = await api\.request\('GET'/)
  assert.match(source, /const denied = await api\.request\('POST'/)
})

const failedTenantCreation = ({
  commitAfterRetries,
  timeout = true,
  tenantCreateTimeoutMs = 180000
}) => {
  const menus = makeMenus()
  const spec = enterpriseIsolationSpec('delayedcommit')
  const packageId = '9007199254741999'
  const tenantId = '9007199254742999'
  const userId = '9007199254743999'
  const context = { caseRecord: { checks: [], notes: [] }, record: { api: [] } }
  const writes = []
  let retries = 0
  let userStatus = '0'
  let tenantStatus = '0'
  let packageStatus = '0'
  return {
    context, writes,
    args: {
      context,
      primaryApi: {
        async getBusiness (path) {
          if (path === '/system/auth/get-permission-info') return { data: { roles: ['super_admin'] } }
          if (path === '/system/tenant-package/get?id=111') {
            return { data: { id: '111', status: 0, menuIds: menus.map((row) => row.id) } }
          }
          return { data: menus }
        },
        async postBusiness (path, body, options) {
          if (path === '/system/tenant-package/create') return { data: packageId }
          assert.equal(options.timeoutMs, tenantCreateTimeoutMs)
          throw timeout
            ? Object.assign(new Error('tenant create timeout'), { name: 'TimeoutError' })
            : new Error('tenant quota rejected')
        },
        async putBusiness (path, body) {
          writes.push({ path, body })
          if (path === '/system/user/update-status') userStatus = String(body.status)
          if (path === '/system/tenant/update') tenantStatus = String(body.status)
          if (path === '/system/tenant-package/update') packageStatus = String(body.status)
          return { code: 0, data: true }
        }
      },
      dependencies: {
        marker: spec.marker,
        writeFixturesEnabled: true,
        config: {
          target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
          apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
          db: { name: 'cfor_admin_standard' }
        },
        async waitForReconciliation () { retries++ },
        async readDb (stage) {
          if (stage === 'enterprise-marker-preflight') {
            return [['package', '0'], ['tenant', '0'], ['user', '0']]
          }
          if (stage.startsWith('enterprise-package-')) {
            return [[packageId, spec.packagePayload.name, packageStatus]]
          }
          if (stage.startsWith('enterprise-tenant-')) {
            return retries >= commitAfterRetries
              ? [[tenantId, spec.tenantPayload.name, packageId, userId, tenantStatus]]
              : []
          }
          if (stage.startsWith('enterprise-admin-')) {
            return [[userId, spec.tenantPayload.username, tenantId, userStatus]]
          }
          throw new Error(`unexpected SQL stage ${stage}`)
        }
      }
    }
  }
}

test('timed-out tenant creation resolves delayed commit and retires exact owners without retrying creation', async () => {
  const fixture = failedTenantCreation({ commitAfterRetries: 2 })
  await assert.rejects(runEnterpriseIsolationEvidence(fixture.args), /tenant create timeout/)
  assert.deepEqual(fixture.writes.map((item) => item.path), [
    '/system/user/update-status', '/system/tenant/update', '/system/tenant-package/update'
  ])
  assert.equal(fixture.writes[0].body.id, '9007199254743999')
  assert.equal(fixture.writes[1].body.id, '9007199254742999')
  assert.equal(fixture.writes[2].body.id, '9007199254741999')
  assert.equal(fixture.context.caseRecord.fixtures[0].cleanup, 'RETIRED_VERIFIED')
  assert.equal(fixture.context.caseRecord.checks.at(-1).passed, false)
  assert.equal(JSON.stringify(fixture.context.caseRecord).includes('password'), false)
})

test('unknown tenant commit remains registered and does not disable its package prematurely', async () => {
  const fixture = failedTenantCreation({ commitAfterRetries: Infinity })
  fixture.args.dependencies.reconciliationTimeoutMs = 1
  fixture.args.dependencies.reconciliationIntervalMs = 1
  await assert.rejects(runEnterpriseIsolationEvidence(fixture.args), /创建结果仍未确认/)
  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.context.caseRecord.fixtures[0].marker, 'delayedcommit')
  assert.equal(fixture.context.caseRecord.fixtures[0].cleanup, 'RETAINED_UNVERIFIED')
})

test('enterprise tenant creation timeout and reconciliation windows are configurable', async () => {
  const fixture = failedTenantCreation({
    commitAfterRetries: 2,
    tenantCreateTimeoutMs: 240000
  })
  fixture.args.dependencies.tenantCreateTimeoutMs = 240000
  fixture.args.dependencies.reconciliationTimeoutMs = 120000
  fixture.args.dependencies.reconciliationIntervalMs = 10
  await assert.rejects(runEnterpriseIsolationEvidence(fixture.args), /tenant create timeout/)
  assert.equal(fixture.writes.length, 3)
  assert.match(fixture.context.caseRecord.notes.join('; '), /按 marker 回读/)
})

test('a rejected tenant creation can retire its owned package without requiring a nonexistent tenant', async () => {
  const fixture = failedTenantCreation({ commitAfterRetries: Infinity, timeout: false })
  await assert.rejects(runEnterpriseIsolationEvidence(fixture.args), /tenant quota rejected/)
  assert.deepEqual(fixture.writes.map((item) => item.path), ['/system/tenant-package/update'])
  assert.equal(fixture.context.caseRecord.fixtures[0].cleanup, 'RETIRED_VERIFIED')
})
