import { randomBytes } from 'node:crypto'

import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { observePage, loginWithCredentials } from '../lib/browser.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { assertSafeScope } from './init-gaps.mjs'

export const ENTERPRISE_ISOLATION_COMPONENTS = Object.freeze([
  'system/tenant-workbench/index',
  'system/user/index',
  'system/role/index',
  'system/dept/index',
  'system/enterprise-organization/index',
  'system/systemInit/index'
])

export const ENTERPRISE_ISOLATION_PERMISSIONS = Object.freeze([
  'system:user:query', 'system:user:create', 'system:user:update', 'system:user:delete',
  'system:role:query', 'system:role:create', 'system:role:update', 'system:role:delete',
  'system:dept:query', 'system:dept:create', 'system:dept:update', 'system:dept:delete',
  'system:permission:assign-role-menu', 'system:permission:assign-user-role',
  'system:permission:assign-role-data-scope',
  'system:enterprise-organization:query', 'system:enterprise-organization:update'
])

const ENTERPRISE_PAGE_COMPONENT = 'system/enterprise-organization/index'
const USER_PAGE_COMPONENT = 'system/user/index'
const idPattern = /^[1-9]\d*$/
const DEFAULT_ENTERPRISE_TENANT_CREATE_TIMEOUT_MS = 180000
const DEFAULT_ENTERPRISE_RECONCILIATION_TIMEOUT_MS = 90000
const DEFAULT_ENTERPRISE_RECONCILIATION_INTERVAL_MS = 1000

export const BUILTIN_ROLE_DATA_SCOPE_REJECTION = Object.freeze({
  code: 1002002003,
  message: '不能操作类型为系统内置的角色'
})

const requireFact = (value, message) => {
  if (!value) throw new Error(`enterprise isolation: ${message}`)
}

const id = (value, label = 'ID') => {
  requireFact(!(typeof value === 'number' && !Number.isSafeInteger(value)),
    `${label}必须保持安全整数或原字符串`)
  const text = String(value ?? '')
  requireFact(idPattern.test(text), `${label}不是合法正整数`)
  return text
}

const dataOf = (payload) => payload?.data

const flatten = (rows) => (Array.isArray(rows) ? rows : [])
  .flatMap((row) => [row, ...flatten(row?.children)])

const quote = (value) => {
  const text = String(value ?? '')
  requireFact(/^[A-Za-z0-9 _:-]+$/.test(text), 'SQL marker 不安全')
  return `'${text}'`
}

const mergeErrors = (errors, label = 'enterprise isolation failed') => {
  const values = errors.filter(Boolean)
  if (!values.length) return null
  if (values.length === 1) return values[0]
  return new AggregateError(values, `${label}: ${values.map((error) => error.message).join('; ')}`)
}

const boundedPositiveInteger = (value, fallback) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const tenantCreateTimeoutMs = (dependencies) =>
  boundedPositiveInteger(
    dependencies.tenantCreateTimeoutMs ??
      process.env.CFOR_E2E_TENANT_CREATE_TIMEOUT_MS,
    DEFAULT_ENTERPRISE_TENANT_CREATE_TIMEOUT_MS
  )

const reconciliationTimeoutMs = (dependencies) =>
  boundedPositiveInteger(
    dependencies.reconciliationTimeoutMs ??
      process.env.CFOR_E2E_TENANT_RECONCILIATION_TIMEOUT_MS,
    DEFAULT_ENTERPRISE_RECONCILIATION_TIMEOUT_MS
  )

const reconciliationIntervalMs = (dependencies) =>
  boundedPositiveInteger(
    dependencies.reconciliationIntervalMs ??
      process.env.CFOR_E2E_TENANT_RECONCILIATION_INTERVAL_MS,
    DEFAULT_ENTERPRISE_RECONCILIATION_INTERVAL_MS
  )

const menuChain = (menu, byId) => {
  const chain = []
  const seen = new Set()
  let current = menu
  while (current) {
    const currentId = id(current.id, '菜单 ID')
    requireFact(!seen.has(currentId), `菜单父链存在循环：${currentId}`)
    seen.add(currentId)
    chain.push(current)
    if (String(current.parentId ?? '0') === '0') return chain
    current = byId.get(id(current.parentId, '菜单父 ID'))
  }
  throw new Error('enterprise isolation: 菜单父链不完整')
}

export function buildEnterpriseIsolationPackage ({ standardPackage, menus, assignableMenus }) {
  requireFact(String(standardPackage?.id) === '111' && Number(standardPackage.status) === 0 &&
    Array.isArray(standardPackage.menuIds), '需要启用的标准套餐 111')
  const allowed = new Set(standardPackage.menuIds.map((value) => id(value, '套餐菜单 ID')))
  const rows = flatten(menus)
  const byId = new Map(rows.map((row) => [id(row.id, '菜单 ID'), row]))
  requireFact(byId.size === rows.length, '菜单 ID 重复')
  const assignable = new Set(flatten(assignableMenus).map((row) => id(row.id, '可分配菜单 ID')))
  const validMenu = (row) => {
    if (!row) return false
    try {
      for (const ancestor of menuChain(row, byId)) {
        const ancestorId = id(ancestor.id, '菜单 ID')
        if (!allowed.has(ancestorId) || !assignable.has(ancestorId) ||
            Number(ancestor.status) !== 0 || Number(ancestor.deleted ?? 0) !== 0) {
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }
  const findValidMenu = (predicate) => rows.find((row) => predicate(row) && validMenu(row))
  const requested = [
    ...ENTERPRISE_ISOLATION_COMPONENTS.map((component) =>
      findValidMenu((row) => row.component === component)),
    ...ENTERPRISE_ISOLATION_PERMISSIONS.map((permission) =>
      findValidMenu((row) => row.permission === permission))
  ]
  requireFact(requested.every(Boolean), '企业隔离所需菜单或权限缺失')
  const menuIds = new Set()
  for (const target of requested) {
    for (const row of menuChain(target, byId)) {
      const rowId = id(row.id, '菜单 ID')
      requireFact(allowed.has(rowId) && assignable.has(rowId) &&
        Number(row.status) === 0 && Number(row.deleted ?? 0) === 0,
      `菜单不在标准套餐或不可分配：${rowId}`)
      menuIds.add(rowId)
    }
  }
  return {
    menuIds: [...menuIds],
    enterprisePageComponent: ENTERPRISE_PAGE_COMPONENT,
    userPageComponent: USER_PAGE_COMPONENT
  }
}

export function enterpriseIsolationSpec (marker = randomBytes(8).toString('hex')) {
  const safeMarker = String(marker).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) ||
    randomBytes(8).toString('hex')
  return {
    marker: safeMarker,
    packagePayload: {
      name: `E2E ENT PKG ${safeMarker}`,
      status: 0,
      remark: `PB001/PB005 ${safeMarker}`
    },
    tenantPayload: {
      name: `E2E ENT TEN ${safeMarker}`,
      contactName: 'CFOR E2E ENT',
      contactMobile: '19900000000',
      status: 0,
      expireTime: '2099-12-31T23:59:59',
      // The BPM tenant bootstrap creates 13 preset accounts plus the tenant admin.
      // Keep this owned fixture above that bootstrap requirement; it is not a quota-boundary assertion.
      accountCount: 50,
      username: `e2eent${safeMarker}`,
      password: `Ent!${randomBytes(5).toString('hex')}`
    }
  }
}

export function tenantAdminIdentityMatches (permissionInfo, tenantId, userId) {
  const info = dataOf(permissionInfo) || permissionInfo
  return String(info?.user?.id ?? '') === String(userId) &&
    Array.isArray(info?.roles) && info.roles.includes('tenant_admin') &&
    (!info?.user?.tenantId || String(info.user.tenantId) === String(tenantId))
}

export function assertTenantAdminIdentity (permissionInfo, tenantId, userId) {
  requireFact(tenantAdminIdentityMatches(permissionInfo, tenantId, userId),
    `真实登录账号不是目标 tenant_admin：tenant=${tenantId}; user=${userId}`)
  return true
}

export function assertAuthenticatedTenantIdentity ({
  auth, permissionInfo, tenant, userId, tenantRecord, requireTenantAdmin = true
}) {
  requireFact(typeof auth?.token === 'string' && auth.token.length > 20,
    '专属租户登录未返回真实访问令牌')
  requireFact(String(auth.tenantId) === String(tenant.id),
    `真实浏览器登录租户不一致：${auth?.tenantId} != ${tenant.id}`)
  const info = dataOf(permissionInfo) || permissionInfo
  if (requireTenantAdmin) {
    assertTenantAdminIdentity(info, tenant.id, userId)
  } else {
    requireFact(String(info?.user?.id ?? '') === String(userId),
      `正式权限用户与创建用户不一致：${info?.user?.id} != ${userId}`)
  }
  requireFact(tenantRecord && String(tenantRecord.id) === String(tenant.id) &&
    tenantRecord.name === tenant.name && Number(tenantRecord.status) === 0,
  `正式 tenant.get 身份不一致：expected=${tenant.id}/${tenant.name}; ` +
    `actual=${tenantRecord ? `${tenantRecord.id}/${tenantRecord.name}/${tenantRecord.status}` : 'missing'}`)
  return true
}

export function pageRows (payload) {
  const page = dataOf(payload)
  requireFact(page && typeof page === 'object' && !Array.isArray(page),
    '正式分页响应不是对象')
  const rows = page.list ?? page.records
  requireFact(Array.isArray(rows) && Number.isSafeInteger(Number(page.total)) &&
    Number(page.total) >= rows.length, '正式分页响应缺少合法 list/records 或 total')
  return rows
}

export function assertDepartmentOwnerRow (row, { departmentId, code, tenantId }) {
  const expectedDepartmentId = id(departmentId, '部门 ID')
  const expectedTenantId = id(tenantId, '租户 ID')
  requireFact(typeof code === 'string' && code.length > 0, '部门编码缺失')
  requireFact(Array.isArray(row) && row.length === 3 &&
    String(row[0]) === expectedDepartmentId &&
    String(row[1]) === code &&
    String(row[2]) === expectedTenantId,
  `部门数据库所有权回读不一致：expected=${expectedDepartmentId}/${code}/${expectedTenantId}; ` +
    `actual=${JSON.stringify(row)}`)
  return true
}

export function assertForeignDepartmentNotVisible (response) {
  requireFact(response && typeof response === 'object' && !Array.isArray(response),
    '外租户部门查询响应不是正式对象')
  requireFact(Number.isInteger(response.code) && response.data == null,
    `第二租户读到了外租户部门：${JSON.stringify(response)}`)
  return true
}

const readDbEvidence = async (caseRecord, stage, sql, readSql = runReadOnlySql) => {
  const result = await readSql(sql)
  requireFact(result.available && Array.isArray(result.rows), `只读 SQL 不可用：${stage}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, rows: result.rows }]
  return result.rows
}

const tenantPackageSql = (spec) => `
  SELECT CAST(id AS CHAR),name,CAST(status AS CHAR)
  FROM system_tenant_package WHERE name=${quote(spec.packagePayload.name)} AND deleted=0`

const tenantSql = (spec) => `
  SELECT CAST(id AS CHAR),name,CAST(package_id AS CHAR),COALESCE(CAST(contact_user_id AS CHAR),''),
    CAST(status AS CHAR)
  FROM system_tenant WHERE name=${quote(spec.tenantPayload.name)} AND deleted=0`

const userSql = (tenantId, username) => `
  SELECT CAST(id AS CHAR),username,CAST(tenant_id AS CHAR),CAST(status AS CHAR)
  FROM system_users WHERE tenant_id=${id(tenantId, '租户 ID')} AND username=${quote(username)} AND deleted=0`

const hasPermissions = (info, permissions) => {
  const values = info?.permissions
  return Array.isArray(values) &&
    (values.includes('*:*:*') || permissions.every((permission) => values.includes(permission)))
}

const menuRoute = (menus, component) => {
  const walk = (rows, parent = '') => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const path = String(row?.path || '').trim()
      const route = path.startsWith('/')
        ? path
        : [parent.replace(/\/$/, ''), path.replace(/^\//, '')].filter(Boolean).join('/')
      if (row?.component === component) return `/${route.replace(/^\/+/, '')}`
      const child = walk(row?.children, route)
      if (child) return child
    }
    return null
  }
  return walk(menus)
}

const targetMenuIds = (menus, components, permissions) => {
  const rows = flatten(menus)
  const byId = new Map(rows.map((row) => [id(row.id, '菜单 ID'), row]))
  const targets = [
    ...components.map((component) => rows.find((row) => row.component === component)),
    ...permissions.map((permission) => rows.find((row) => row.permission === permission))
  ]
  requireFact(targets.every(Boolean), '受限账号菜单目标缺失')
  return [...new Set(targets.flatMap((target) => menuChain(target, byId).map((row) => id(row.id))))]
}

export async function withLoggedInTenant (context, tenant, run, dependencies = {}) {
  const browser = dependencies.browser || context.page.context().browser()
  const observe = dependencies.observePage || observePage
  const apiFactory = dependencies.createApiClient || createApiClient
  const isolated = await browser.newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
  })
  let page
  let api
  let auth
  let capture
  let result
  let operationError
  const cleanupErrors = []
  try {
    page = await isolated.newPage()
    capture = observe(page, context.record)
    const credentials = {
      tenantName: tenant.name,
      username: tenant.username,
      password: tenant.password
    }
    auth = dependencies.login
      ? await dependencies.login(page, { credentials, returnContext: true, check: context.check })
      : await loginWithCredentials(page, credentials, { returnContext: true, check: context.check })
    api = apiFactory({ token: auth.token, tenantId: tenant.id, record: context.record })
    const permissionInfo = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
    const tenantRecord = dependencies.platformApi
      ? dataOf(await dependencies.platformApi.getBusiness(`/system/tenant/get?id=${tenant.id}`, {
        headers: { 'visit-tenant-id': String(tenant.id) }
      }))
      : dependencies.tenantRecord
    assertAuthenticatedTenantIdentity({
      auth, permissionInfo, tenant, userId: dependencies.userId, tenantRecord,
      requireTenantAdmin: dependencies.requireTenantAdmin ?? true
    })
    result = await run({ page, api, auth, info: permissionInfo, tenantRecord })
  } catch (error) {
    operationError = error
  } finally {
    try { await capture?.flushResponses() } catch (error) { cleanupErrors.push(error) }
    try {
      if (api) await api.postBusiness('/system/auth/logout')
    } catch (error) { cleanupErrors.push(error) }
    try { await page?.close() } catch (error) { cleanupErrors.push(error) }
    try { await isolated.close() } catch (error) { cleanupErrors.push(error) }
  }
  const merged = mergeErrors([operationError, ...cleanupErrors], '企业隔离浏览器会话失败')
  if (merged) throw merged
  return result
}

async function runDepartmentScopeEvidence ({
  context, tenant, api, platformApi, page, userId, marker, readDb,
  verifyDepartmentScope, foreignDepartment
}) {
  const provisionApi = platformApi || api
  const provisionOptions = platformApi
    ? { headers: { 'visit-tenant-id': String(tenant.id) } }
    : undefined
  const getProvision = (path) => provisionApi.getBusiness(path, provisionOptions)
  const postProvision = (path, body) => provisionApi.postBusiness(path, body, provisionOptions)
  const requestProvision = (method, path, body, options = {}) =>
    provisionApi.request(method, path, body, { ...provisionOptions, ...options,
      headers: { ...provisionOptions?.headers, ...options.headers } })
  const deleteProvision = (path) => provisionApi.deleteBusiness(path, provisionOptions)
  const resources = { departments: [], users: [], role: null }
  const suffix = `${marker}${randomBytes(4).toString('hex')}`
  const departmentPayload = (label) => ({
    name: `E2E ${label} ${suffix}`,
    code: `E2E${label}${suffix}`.slice(0, 30),
    unitType: 'DEPARTMENT',
    dataBoundary: false,
    parentId: 0,
    sort: 9998,
    leaderUserId: userId,
    supervisorUserId: userId,
    status: 0,
    remark: marker
  })
  const createDepartment = async (label) => {
    const payload = departmentPayload(label)
    const created = id(dataOf(await postProvision('/system/dept/create', payload)), '部门 ID')
    resources.departments.push({ id: created, payload })
    const detail = dataOf(await getProvision(`/system/dept/get?id=${created}`))
    requireFact(String(detail?.id) === created && detail.code === payload.code &&
      String(detail.tenantId ?? tenant.id) === String(tenant.id), `部门 ${label} 所有权回读不一致`)
    const ownerRows = await readDb('department-owner', `SELECT CAST(id AS CHAR),code,CAST(tenant_id AS CHAR)
      FROM system_dept WHERE id=${created} AND tenant_id=${id(tenant.id)} AND deleted=0`)
    requireFact(ownerRows.length === 1, `部门 ${label} 数据库所有权行数不唯一`)
    assertDepartmentOwnerRow(ownerRows[0], {
      departmentId: created, code: payload.code, tenantId: tenant.id
    })
    return { id: created, ...payload }
  }
  const createUser = async (label, deptId, roleIds = []) => {
    const username = `e2eent${label.toLowerCase()}${suffix}`.slice(0, 30)
    const password = `Dept!${randomBytes(5).toString('hex')}`
    const payload = {
      // Keep the fixture nickname within the platform DTO's 30-character limit.
      username, nickname: `E2E-${label}-${suffix.slice(-8)}`, password, deptId: id(deptId),
      postIds: [], roleIds, sex: 0, type: 4, status: 0, remark: marker
    }
    const created = id(dataOf(await postProvision('/system/user/create', payload)), '用户 ID')
    resources.users.push({ id: created, username, password, payload })
    const detail = dataOf(await getProvision(`/system/user/get?id=${created}`))
    requireFact(String(detail?.id) === created && detail.username === username &&
      String(detail.tenantId ?? tenant.id) === String(tenant.id) &&
      String(detail.deptId) === String(deptId), `用户 ${label} 所有权回读不一致`)
    return { id: created, username, password, deptId: id(deptId) }
  }
  const cleanup = async () => {
    const errors = []
    const attempt = async (operation) => {
      try { await operation() } catch (error) { errors.push(error) }
    }
    for (const item of [...resources.users].reverse()) await attempt(async () => {
      const detail = dataOf(await getProvision(`/system/user/get?id=${item.id}`))
      requireFact(detail?.username === item.username && String(detail.tenantId ?? tenant.id) === String(tenant.id),
        `拒绝清理非本轮用户：${item.id}`)
      await deleteProvision(`/system/user/delete?id=${item.id}`)
    })
    if (resources.role) await attempt(async () => {
      const detail = dataOf(await getProvision(`/system/role/get?id=${resources.role.id}`))
      requireFact(detail?.code === resources.role.payload.code && detail.remark === marker,
        `拒绝清理非本轮角色：${resources.role.id}`)
      await deleteProvision(`/system/role/delete?id=${resources.role.id}`)
    })
    for (const item of [...resources.departments].reverse()) await attempt(async () => {
      const detail = dataOf(await getProvision(`/system/dept/get?id=${item.id}`))
      requireFact(detail?.code === item.payload.code && String(detail.tenantId ?? tenant.id) === String(tenant.id),
        `拒绝清理非本轮部门：${item.id}`)
      await deleteProvision(`/system/dept/delete?id=${item.id}`)
    })
    if (errors.length) throw mergeErrors(errors, '部门授权夹具清理失败')
  }

  try {
    const deptA = await createDepartment('A')
    const deptB = await createDepartment('B')
    const menus = dataOf(await getProvision('/system/menu/list'))
    const menuIds = targetMenuIds(menus, [USER_PAGE_COMPONENT], ['system:user:query'])
    const rolePayload = {
      name: `E2E DEPT SCOPE ${suffix}`.slice(0, 30),
      code: `e2e_dept_scope_${suffix}`.slice(0, 30),
      sort: 9997, status: 0, remark: marker
    }
    const roleId = id(dataOf(await postProvision('/system/role/create', rolePayload)), '部门范围角色 ID')
    resources.role = { id: roleId, payload: rolePayload }
    await postProvision('/system/permission/assign-role-menu', { roleId, menuIds })
    await postProvision('/system/permission/assign-role-data-scope', {
      roleId, dataScope: 2, dataScopeDeptIds: [deptA.id]
    })
    const role = dataOf(await getProvision(`/system/role/get?id=${roleId}`))
    requireFact(String(role?.id) === roleId && Number(role.dataScope) === 2,
      '角色部门数据范围未回读为 CUSTOM')
    const scopeRows = await readDb('department-scope-owner', `
      SELECT CAST(tenant_id AS CHAR),CAST(id AS CHAR),CAST(data_scope AS CHAR),data_scope_dept_ids
      FROM system_role WHERE id=${roleId} AND tenant_id=${id(tenant.id)} AND deleted=0`)
    requireFact(scopeRows.length === 1 && scopeRows[0][0] === String(tenant.id) &&
      scopeRows[0][1] === roleId && scopeRows[0][2] === '2' &&
      JSON.parse(scopeRows[0][3]).map(String).includes(String(deptA.id)),
    '角色部门范围未在当前租户真实持久化')
    requireFact(foreignDepartment && String(foreignDepartment.tenantId) !== String(tenant.id),
      '需要真实外租户部门样本')
    const foreignId = id(foreignDepartment.id, '外租户部门 ID')
    // Provisioning may use the platform super admin with visit-tenant-id, but
    // the isolation negative must use the authenticated tenant_admin session.
    const forbiddenDetail = await api.request('GET', `/system/dept/get?id=${foreignId}`)
    assertForeignDepartmentNotVisible(forbiddenDetail)
    const rejection = { code: 400, message: '数据范围包含不存在或不属于当前租户的部门' }
    const denied = await api.request('POST', '/system/permission/assign-role-data-scope', {
      roleId, dataScope: 2, dataScopeDeptIds: [deptA.id, foreignId]
    }, { expectedBusinessRejection: rejection })
    const roleAfterDenied = dataOf(await api.getBusiness(`/system/role/get?id=${roleId}`))
    const scopeAfterDenied = await readDb('department-scope-after-foreign-rejection', `
      SELECT CAST(tenant_id AS CHAR),CAST(id AS CHAR),CAST(data_scope AS CHAR),data_scope_dept_ids
      FROM system_role WHERE id=${roleId} AND tenant_id=${id(tenant.id)} AND deleted=0`)
    requireFact(denied?.code === rejection.code && denied.msg === rejection.message &&
      Number(roleAfterDenied?.dataScope) === 2 &&
      JSON.stringify(scopeAfterDenied) === JSON.stringify(scopeRows),
    '跨租户部门混合授权未被整体拒绝或改变了原授权')
    context.caseRecord.checks.push({
      name: '跨租户部门不可读取且混合授权整体拒绝不改变原范围',
      passed: true,
      details: `loginTenant=${tenant.id}; foreignTenant=${foreignDepartment.tenantId}; foreignDept=${foreignId}`
    })
    const userA = await createUser('A', deptA.id)
    const userB = await createUser('B', deptB.id)
    const limited = await createUser('LIMITED', deptA.id, [roleId])
    const result = await withLoggedInTenant(context, {
      id: tenant.id, name: tenant.name, username: limited.username, password: limited.password
    }, async ({ page: limitedPage, api: limitedApi, auth }) => {
      requireFact(String(auth?.tenantId) === String(tenant.id), '受限账号登录租户不一致')
      const info = dataOf(await limitedApi.getBusiness('/system/auth/get-permission-info'))
      requireFact(String(info?.user?.id) === limited.id &&
        info?.roles?.includes(rolePayload.code) &&
        !info?.roles?.includes('super_admin') && !info?.roles?.includes('tenant_admin') &&
        hasPermissions(info, ['system:user:query']), '受限账号身份或权限不符合')
      const positive = pageRows(await limitedApi.getBusiness(
        `/system/user/page?pageNo=1&pageSize=100&deptId=${deptA.id}`))
      const negative = pageRows(await limitedApi.getBusiness(
        `/system/user/page?pageNo=1&pageSize=100&deptId=${deptB.id}`))
      requireFact(positive.some((row) => String(row.id) === userA.id &&
        String(row.deptId) === deptA.id), '受限账号不能读取已授权部门 A')
      requireFact(!negative.some((row) => String(row.id) === userB.id ||
        String(row.deptId) === deptB.id), '受限账号读取到了未授权部门 B')
      await verifyDepartmentScope?.({
        page: limitedPage, api: limitedApi, auth, info,
        departments: { allowed: deptA, denied: deptB },
        users: { allowed: userA, denied: userB },
        role: { ...resources.role, detail: role },
        positiveRows: positive, negativeRows: negative
      })
      context.caseRecord.checks.push({
        name: '第二租户部门数据范围正反例真实可见性',
        passed: true,
        details: `tenantId=${tenant.id}; allowed=${deptA.id}/${userA.id}; denied=${deptB.id}/${userB.id}`
      })
      return { positiveRows: positive, negativeRows: negative }
    }, { ...context.dependencies, userId: limited.id, requireTenantAdmin: false })
    await cleanup()
    return { ...result, resources }
  } catch (error) {
    try { await cleanup() } catch (cleanupError) { throw mergeErrors([error, cleanupError]) }
    throw error
  }
}

export async function runEnterpriseIsolationEvidence ({
  context, primaryApi, verifyEnterprisePage, verifyDepartmentScope, dependencies = {}, packagePlan
}) {
  const runtimeConfig = dependencies.config || config
  assertSafeScope(runtimeConfig)
  const caseRecord = context.caseRecord
  const writeEnabled = dependencies.writeFixturesEnabled ??
    process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
  if (!writeEnabled) {
    caseRecord.notes.push('未启用写侧夹具，企业隔离证据保留 GAP。')
    return { executed: false }
  }
  requireFact(writeEnabled, 'BLOCKED: 写侧夹具未显式开启')
  const readDb = dependencies.readDb || ((stage, sql) =>
    readDbEvidence(caseRecord, stage, sql, dependencies.runReadOnlySql || runReadOnlySql))
  const apiFactory = dependencies.createApiClient || createApiClient
  const spec = enterpriseIsolationSpec(dependencies.marker)
  const errors = []
  let packageAttempted = false
  let tenantAttempted = false
  let packageId = ''
  let tenantId = ''
  let userId = ''
  let tenantCreationUncertain = false
  let session
  const fixture = {
    kind: 'enterprise-isolation', marker: spec.marker,
    packageName: spec.packagePayload.name, tenantName: spec.tenantPayload.name,
    owned: true, cleanup: 'PENDING'
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  const loadOwners = async (allowMissing = false) => {
    const packageRows = await readDb('enterprise-package-owner', tenantPackageSql(spec))
    if (allowMissing && packageRows.length === 0) return
    requireFact(packageRows.length === 1 && packageRows[0][1] === spec.packagePayload.name,
      '专属企业套餐所有权不唯一')
    packageId = id(packageRows[0][0], '专属套餐 ID')
    requireFact(packageId !== '111', '专属企业套餐不能复用标准套餐 111')
    fixture.packageId = packageId
    if (!tenantAttempted) return
    const tenantRows = await readDb('enterprise-tenant-owner', tenantSql(spec))
    if (allowMissing && tenantRows.length === 0) return
    if (allowMissing && tenantRows.length === 0) return
    requireFact(tenantRows.length === 1 && tenantRows[0][1] === spec.tenantPayload.name &&
      tenantRows[0][2] === packageId, '专属企业租户套餐归属不一致')
    tenantId = id(tenantRows[0][0], '专属租户 ID')
    requireFact(tenantId !== '1', '专属企业租户不能复用 tenant1')
    userId = id(tenantRows[0][3], '专属租户管理员 ID')
    Object.assign(fixture, { tenantId, userId })
    const users = await readDb('enterprise-admin-owner',
      userSql(tenantId, spec.tenantPayload.username))
    requireFact(users.length === 1 && users[0][0] === userId &&
      users[0][1] === spec.tenantPayload.username && users[0][2] === tenantId,
    '专属企业管理员所有权不一致')
  }
  const attempt = async (operation) => {
    try { await operation() } catch (error) { errors.push(error) }
  }
  try {
    const permission = dataOf(await primaryApi.getBusiness('/system/auth/get-permission-info'))
    requireFact(Array.isArray(permission?.roles) && permission.roles.includes('super_admin'),
      '当前平台账号必须是 super_admin 才能创建并退役专属租户')
    const standardPackage = dataOf(await primaryApi.getBusiness('/system/tenant-package/get?id=111'))
    const menus = dataOf(await primaryApi.getBusiness('/system/menu/list'))
    const assignableMenus = dataOf(await primaryApi.getBusiness('/system/menu/list-all-simple'))
    const plan = packagePlan
      ? packagePlan({ standardPackage, menus, assignableMenus })
      : buildEnterpriseIsolationPackage({ standardPackage, menus, assignableMenus })
    requireFact(Array.isArray(plan?.menuIds) && plan.menuIds.length > 0, '专属套餐菜单不能为空')
    spec.packagePayload.menuIds = plan.menuIds
    const absent = await readDb('enterprise-marker-preflight', `
      SELECT 'package',COUNT(*) FROM system_tenant_package WHERE name=${quote(spec.packagePayload.name)}
      UNION ALL SELECT 'tenant',COUNT(*) FROM system_tenant WHERE name=${quote(spec.tenantPayload.name)}
      UNION ALL SELECT 'user',COUNT(*) FROM system_users WHERE username=${quote(spec.tenantPayload.username)}`)
    requireFact(absent.length === 3 && absent.every((row) => row[1] === '0'),
      '专属企业随机 marker 已存在')
    packageAttempted = true
    const returnedPackageId = id(dataOf(await primaryApi.postBusiness(
      '/system/tenant-package/create', spec.packagePayload)), '专属套餐 ID')
    await loadOwners()
    requireFact(returnedPackageId === packageId, '专属套餐 API/数据库 ID 不一致')
    spec.tenantPayload.packageId = packageId
    tenantAttempted = true
    let createResult
    try {
      createResult = await primaryApi.postBusiness(
        '/system/tenant/create', spec.tenantPayload, {
          timeoutMs: tenantCreateTimeoutMs(dependencies)
        })
    } catch (error) {
      tenantCreationUncertain = ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name) ||
        /timeout|fetch failed|ECONN|network|socket/i.test(error?.message || '')
      if (tenantCreationUncertain) {
        caseRecord.notes.push(
          `专属租户创建请求超时或连接中断；将在 ${reconciliationTimeoutMs(dependencies)}ms 内按 marker 回读，` +
          '不重试创建请求。'
        )
      }
      throw error
    }
    const returnedTenantId = id(dataOf(createResult), '专属租户 ID')
    await loadOwners()
    requireFact(returnedTenantId === tenantId, '专属租户 API/数据库 ID 不一致')
    let foreignDepartment
    if (verifyDepartmentScope) {
      const departments = dataOf(await primaryApi.getBusiness('/system/dept/list'))
      const foreign = flatten(departments).find((item) => Number(item.status) === 0)
      requireFact(foreign, '标准平台缺少正式可读取的部门正例')
      const ownerRows = await readDb('foreign-department-owner', `
        SELECT CAST(id AS CHAR),code,CAST(tenant_id AS CHAR) FROM system_dept
        WHERE id=${id(foreign.id)} AND tenant_id=1 AND deleted=0`)
      requireFact(ownerRows.length === 1, '外租户部门数据库所有权不唯一')
      assertDepartmentOwnerRow(ownerRows[0], {
        departmentId: foreign.id, code: foreign.code, tenantId: '1'
      })
      foreignDepartment = { ...foreign, tenantId: '1' }
      // tenant_admin is a system role. The backend must reject data-scope mutation;
      // only the custom department-scope role below may be configured.
      const roles = pageRows(await primaryApi.getBusiness(
        '/system/role/page?pageNo=1&pageSize=100&code=tenant_admin',
        { headers: { 'visit-tenant-id': tenantId } }))
        .filter((item) => item.code === 'tenant_admin')
      requireFact(roles.length === 1, '专属租户 tenant_admin 角色不唯一')
      const builtinScopeAttempt = await primaryApi.request('POST',
        '/system/permission/assign-role-data-scope', {
        roleId: id(roles[0].id), dataScope: 1, dataScopeDeptIds: []
      }, {
        headers: { 'visit-tenant-id': tenantId },
        expectedBusinessRejection: BUILTIN_ROLE_DATA_SCOPE_REJECTION
      })
      requireFact(matchesExpectedBusinessRejection(
        builtinScopeAttempt, BUILTIN_ROLE_DATA_SCOPE_REJECTION
      ), '内置 tenant_admin 数据范围修改未按安全策略拒绝')
      caseRecord.checks.push({
        name: '内置 tenant_admin 禁止修改数据范围且返回正式错误码',
        passed: true,
        details: `roleId=${roles[0].id}; code=${builtinScopeAttempt.code}; ` +
          `message=${builtinScopeAttempt.msg || builtinScopeAttempt.message}`
      })
    }
    session = await withLoggedInTenant(context, {
      id: tenantId,
      name: spec.tenantPayload.name,
      username: spec.tenantPayload.username,
      password: spec.tenantPayload.password
    }, async ({ page, api, auth }) => {
      requireFact(String(auth?.tenantId) === tenantId, '企业隔离真实登录 tenantId 不一致')
      const info = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
      assertTenantAdminIdentity(info, tenantId, userId)
      requireFact(hasPermissions(info, ENTERPRISE_ISOLATION_PERMISSIONS),
        '专属 tenant_admin 缺少企业隔离正式 API 权限')
      if (verifyEnterprisePage) {
        await verifyEnterprisePage({ page, api, auth, info, tenantId, userId, spec, readDb })
      }
      if (verifyDepartmentScope) {
        const departmentResult = await runDepartmentScopeEvidence({
          context: { ...context, dependencies: { ...dependencies, platformApi: primaryApi } },
          tenant: { id: tenantId, name: spec.tenantPayload.name },
          api, platformApi: primaryApi, page, userId, marker: spec.marker, readDb,
          verifyDepartmentScope, foreignDepartment
        })
        return departmentResult
      }
      return { executed: true }
    }, { ...dependencies, platformApi: primaryApi, userId })
  } catch (error) {
    errors.unshift(error)
  } finally {
    if (packageAttempted) await attempt(() => loadOwners(true))
    // An aborted HTTP request does not roll back a server-side tenant transaction.
    // Resolve its exact marker before retiring the package or reporting cleanup.
    if (tenantCreationUncertain && !tenantId) await attempt(async () => {
      const retry = dependencies.waitForReconciliation ||
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      const deadline = Date.now() + reconciliationTimeoutMs(dependencies)
      let attempts = 0
      while (Date.now() < deadline && !tenantId) {
        attempts++
        await retry(reconciliationIntervalMs(dependencies))
        await loadOwners(true)
      }
      requireFact(tenantId,
        `租户创建结果仍未确认（回读尝试 ${attempts} 次），保留精确 marker 待核对，不宣称已清理`)
    })
    let userRetired = false
    let tenantRetired = false
    let packageRetired = false
    if (tenantAttempted && tenantId && userId) await attempt(async () => {
      await loadOwners()
      await primaryApi.putBusiness('/system/user/update-status', { id: userId, status: 1 }, {
        headers: { 'visit-tenant-id': tenantId }
      })
      const rows = await readDb('enterprise-admin-retired', userSql(tenantId, spec.tenantPayload.username))
      requireFact(rows.length === 0 || rows[0][3] === '1', '专属企业管理员未退役')
      userRetired = true
    })
    if (tenantAttempted && tenantId) await attempt(async () => {
      await loadOwners()
      const { username, password, ...tenantPayload } = spec.tenantPayload
      await primaryApi.putBusiness('/system/tenant/update', {
        ...tenantPayload, id: tenantId, status: 1
      })
      const rows = await readDb('enterprise-tenant-retired', tenantSql(spec))
      requireFact(rows.length === 1 && rows[0][4] === '1', '专属企业租户未退役')
      tenantRetired = true
    })
    if (packageAttempted && packageId && (!tenantCreationUncertain || tenantId)) await attempt(async () => {
      await loadOwners(true)
      await primaryApi.putBusiness('/system/tenant-package/update', {
        ...spec.packagePayload, id: packageId, status: 1
      })
      const rows = await readDb('enterprise-package-retired', tenantPackageSql(spec))
      requireFact(rows.length === 1 && rows[0][2] === '1', '专属企业套餐未退役')
      packageRetired = true
    })
    fixture.cleanup = !packageAttempted ? 'NOT_CREATED'
      : packageRetired && (tenantId
        ? userRetired && tenantRetired
        : !tenantCreationUncertain)
      ? 'RETIRED_VERIFIED'
      : 'RETAINED_UNVERIFIED'
    caseRecord.checks.push({
      name: '专属企业租户真实登录、权限验证和生命周期退役完成',
      passed: errors.length === 0,
      details: `tenantId=${tenantId || 'not-created'}; packageId=${packageId || 'not-created'}; errors=${errors.length}`
    })
  }
  const error = mergeErrors(errors)
  if (error) throw error
  return { executed: true, tenantId, packageId, session }
}
