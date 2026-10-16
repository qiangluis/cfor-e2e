import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { withIotIsolationTenant } from './iot-tenant-isolation.mjs'

export const MAINTENANCE_ISOLATION_PERMISSIONS = Object.freeze([
  'iot:product-category:create', 'iot:product-category:query', 'iot:product-category:delete',
  'iot:product:create', 'iot:product:query', 'iot:product:delete',
  'iot:device:create', 'iot:device:query', 'iot:device:delete',
  'mes:maintenance-item:query', 'mes:maintenance-item:update',
  'mes:maintenance-plan:query', 'mes:maintenance-plan:update', 'mes:maintenance-plan:publish',
  'mes:maintenance-plan-assignment:query', 'mes:maintenance-plan-assignment:update',
  'system:order:list', 'mes:repair-order:delete'
])

const COMPONENTS = Object.freeze([
  'iot/product/product/index', 'iot/device/device/index', 'iot/maintenance/repair-order/index'
])
// The official tenant creation API adds these base menus and descendants itself.
const TENANT_BOOTSTRAP_COMPONENTS = Object.freeze([
  'system/tenant-workbench/index', 'system/user/index', 'system/role/index',
  'system/dept/index', 'system/enterprise-organization/index', 'system/systemInit/index'
])
const dataOf = (response) => response && typeof response === 'object' &&
  Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response

const idOf = (value, label) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`BLOCKED: ${label} ID 精度丢失`)
  }
  const id = String(value ?? '')
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`BLOCKED: ${label} ID 无效`)
  return id
}
const flatten = (nodes, result = []) => {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    result.push(node)
    flatten(node?.children, result)
  }
  return result
}
const enabled = (menu) => Number(menu?.status) === 0 && Number(menu?.deleted || 0) === 0
const combineErrors = (errors, label) => errors.length === 1
  ? errors[0] : new AggregateError(errors, `${label}：${errors.map((error) => error.message).join('；')}`)
const sameIds = (actual, expected) => Array.isArray(actual) &&
  actual.length === expected.length &&
  new Set(actual.map(value => idOf(value, '角色/部门'))).size === expected.length &&
  expected.every(value => actual.map(String).includes(String(value)))
const requireTrue = (response, label) => {
  if (assertBusinessSuccess(response, label).data !== true) throw new Error(`${label} 未返回真实 true`)
}
const menuNodes = (nodes, result = []) => {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue
    result.push(node)
    menuNodes(node.children, result)
  }
  return result
}

async function diagnoseMaintenanceRouteContext (page, api, fixture, caseRecord) {
  const permissionInfo = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
  const menus = menuNodes(permissionInfo?.menus)
  const target = menus.find((menu) =>
    menu?.component === 'iot/maintenance/repair-order/index' ||
    menu?.path === 'repair-order'
  )
  const chain = []
  const byId = new Map(menus.map((menu) => [String(menu.id), menu]))
  let current = target
  while (current) {
    chain.unshift({
      id: current.id,
      parentId: current.parentId,
      name: current.name,
      path: current.path,
      component: current.component,
      visible: current.visible
    })
    current = byId.get(String(current.parentId))
  }
  const browserState = typeof page?.evaluate === 'function'
    ? await page.evaluate(() => {
        const parse = (value) => {
          if (!value) return null
          try {
            const parsed = JSON.parse(value)
            if (parsed && typeof parsed === 'object') return parsed
          } catch {}
          return null
        }
        const cached = parse(localStorage.getItem('user'))
        const cachedUser = cached?.user || cached
        return {
          url: window.location.href,
          pathname: window.location.pathname,
          cachedUser: cachedUser && {
            id: cachedUser.id,
            username: cachedUser.username,
            nickname: cachedUser.nickname
          },
          cachedLanding: cached && {
            landingPath: cached.landingPath,
            landingSource: cached.landingSource,
            onboardingRequired: cached.onboardingRequired,
            menuCount: Array.isArray(cached.menus) ? cached.menus.length : null
          },
          routeCount: typeof window.__VUE_ROUTER__?.getRoutes === 'function'
            ? window.__VUE_ROUTER__.getRoutes().length
            : null
        }
      })
    : { unavailable: true }
  const routeEvidence = {
    tenantId: String(fixture.tenantId),
    permissionUser: {
      id: permissionInfo?.user?.id,
      username: permissionInfo?.user?.username
    },
    landingPath: permissionInfo?.landingPath,
    landingSource: permissionInfo?.landingSource,
    onboardingRequired: permissionInfo?.onboardingRequired,
    targetMenu: target ? {
      id: target.id,
      parentId: target.parentId,
      path: target.path,
      component: target.component,
      visible: target.visible
    } : null,
    targetMenuChain: chain,
    browserState
  }
  caseRecord.evidence.push(`MAINT-004 动态路由上下文：${JSON.stringify(routeEvidence)}`)
}

async function verifyMaintenancePlatformActor (api, expectedActorId) {
  if (!api?.getBusiness) throw new Error('BLOCKED: MAINT-004 部门引导需要既有平台 super_admin 正式访租')
  const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
  const info = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
  const actorId = idOf(profile?.id, '平台引导操作者')
  if (idOf(info?.user?.id, '平台权限操作者') !== actorId ||
      !profile.username || info.user.username !== profile.username ||
      !Array.isArray(info.roles) || !info.roles.includes('super_admin') ||
      expectedActorId != null && actorId !== idOf(expectedActorId, '原平台引导操作者')) {
    throw new Error('BLOCKED: MAINT-004 引导必须使用同一既有平台 super_admin，禁止临时授予权限')
  }
  return actorId
}

async function maintenanceScopeProvision (fixture, dependencies) {
  const platformApi = dependencies.platformApi
  const actorId = await verifyMaintenancePlatformActor(platformApi, dependencies.platformActorId)
  const tenantId = idOf(fixture.tenantId, '访租目标')
  const packageId = idOf(fixture.packageId, '访租目标套餐')
  if (tenantId === '1' || packageId === '111' || fixture.tenant?.id !== tenantId ||
      fixture.tenant.name !== fixture.tenantPayload?.name ||
      !fixture.tenant.name.startsWith('E2E M4 ISO TEN ') ||
      fixture.tenant.username !== fixture.tenantPayload?.username ||
      !fixture.packagePayload?.name?.startsWith('E2E M4 ISO PKG ')) {
    throw new Error('BLOCKED: MAINT-004 访租仅允许本轮专属租户/套餐')
  }
  const tenant = dataOf(await platformApi.getBusiness(`/system/tenant/get?id=${tenantId}`))
  const tenantPackage = dataOf(await platformApi.getBusiness(`/system/tenant-package/get?id=${packageId}`))
  if (idOf(tenant?.id, '访租租户回读') !== tenantId || tenant.status !== 0 ||
      tenant.name !== fixture.tenantPayload.name || String(tenant.packageId) !== packageId ||
      idOf(tenantPackage?.id, '访租套餐回读') !== packageId || tenantPackage.status !== 0 ||
      tenantPackage.name !== fixture.packagePayload.name ||
      !sameIds(tenantPackage.menuIds, fixture.plan.menuIds)) {
    throw new Error('BLOCKED: MAINT-004 访租目标所有权/状态/套餐不一致')
  }
  // The existing platform super_admin is used only for tenant-scoped,
  // scoped department/role provisioning. IoT/MES business writes stay on the
  // isolated tenant session so the backend enforces the real tenant boundary.
  const options = (extra = {}) => ({
    ...extra,
    headers: { ...(extra.headers || {}), 'visit-tenant-id': tenantId }
  })
  const visitApi = {
    getBusiness: (path, extra) => platformApi.getBusiness(path, options(extra)),
    postBusiness: (path, body, extra) => platformApi.postBusiness(path, body, options(extra)),
    putBusiness: (path, body, extra) => platformApi.putBusiness(path, body, options(extra))
  }
  return {
    platformActorId: actorId,
    api: visitApi,
    readApi: visitApi
  }
}

async function readOwnedMaintenanceDepartment (api, fixture, { active = true } = {}) {
  const scope = fixture.deviceScope
  const department = dataOf(await api.getBusiness(`/system/dept/get?id=${scope.deptId}`))
  if (department == null) {
    throw new Error('BLOCKED: MAINT-004 专属部门正式API回读不可见，null 不能证明不存在或清理成功')
  }
  if (idOf(department?.id, '专属部门') !== scope.deptId ||
      department.code !== scope.deptPayload.code || department.name !== scope.deptPayload.name ||
      String(department.parentId) !== '0' || active && department.status !== 0 ||
      department.tenantId != null && idOf(department.tenantId, '部门租户') !== fixture.tenantId) {
    throw new Error('BLOCKED: MAINT-004 专属部门所有权/状态不一致')
  }
  return department
}

async function readOwnedMaintenanceRole (api, fixture, {
  active = true, requireCustom = fixture.deviceScope.dataScopeVerified || fixture.deviceScope.assigned
} = {}) {
  const scope = fixture.deviceScope
  const role = dataOf(await api.getBusiness(`/system/role/get?id=${scope.roleId}`))
  const menus = dataOf(await api.getBusiness(`/system/permission/list-role-menus?roleId=${scope.roleId}`))
  if (idOf(role?.id, '专属范围角色') !== scope.roleId || role.type !== 2 ||
      role.code !== scope.rolePayload.code || role.name !== scope.rolePayload.name ||
      role.remark !== scope.rolePayload.remark || active && role.status !== 0 ||
      !Array.isArray(menus) || menus.length !== 0 ||
      role.tenantId != null && idOf(role.tenantId, '范围角色租户') !== fixture.tenantId) {
    throw new Error('BLOCKED: MAINT-004 范围角色不是本轮无菜单权限自定义角色')
  }
  if (requireCustom && (role.dataScope !== 2 || !sameIds(role.dataScopeDeptIds, [scope.deptId]))) {
    throw new Error('BLOCKED: MAINT-004 数据范围必须仅为本轮唯一部门，禁止 ALL/共享范围')
  }
  return role
}

async function readOwnedMaintenanceScope (api, fixture, options = {}) {
  const scope = fixture.deviceScope
  if (!scope) throw new Error('BLOCKED: MAINT-004 缺少专属部门数据范围')
  const department = await readOwnedMaintenanceDepartment(api, fixture, options)
  if (!scope.roleId) return { department }
  const role = await readOwnedMaintenanceRole(api, fixture, options)
  return { department, role }
}

async function verifyCreatedMaintenanceDepartment (fixture, caseRecord, dependencies) {
  const scope = fixture.deviceScope
  const tenantId = idOf(fixture.tenantId, '专属部门租户')
  const creatorId = idOf(scope.provisionActorId, '专属部门访租创建者')
  const deptId = idOf(scope.deptId, '专属部门')
  const marker = /^E2E-M4-([A-F0-9]{10})$/.exec(scope.deptPayload.code)
  if (!marker || scope.deptPayload.name !== `E2E M4 DEPT ${marker[1]}`) {
    throw new Error('BLOCKED: MAINT-004 专属部门 marker 不符合本轮所有权约束')
  }
  // SQL binds ownership to the authorized platform creator; it never authorizes the assignment.
  const sql = `
    SELECT id, tenant_id, code, name, parent_id, status, CAST(deleted AS UNSIGNED), creator
    FROM system_dept
    WHERE tenant_id = ${tenantId} AND id = ${deptId}
      AND code = '${scope.deptPayload.code}' AND name = '${scope.deptPayload.name}'
      AND deleted = 0
    LIMIT 2
  `
  let snapshot
  try {
    snapshot = await (dependencies.runReadOnlySql || runReadOnlySql)(sql)
  } catch (error) {
    caseRecord.database = [...(caseRecord.database || []), {
      stage: 'maint004-owned-department-before-custom-role', sql, available: false, rows: [],
      reason: error.message
    }]
    throw new Error(`BLOCKED: MAINT-004 专属部门只读所有权核实失败：${error.message}`, { cause: error })
  }
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'maint004-owned-department-before-custom-role', sql, ...snapshot
  }]
  if (snapshot?.available !== true || !Array.isArray(snapshot.rows) || snapshot.rows.length !== 1) {
    throw new Error('BLOCKED: MAINT-004 专属部门只读所有权证据不可用或非唯一，禁止分配范围角色')
  }
  const row = snapshot.rows[0]
  if (!Array.isArray(row) || row.length !== 8 ||
      idOf(row[0], '数据库专属部门') !== deptId || idOf(row[1], '数据库部门租户') !== tenantId ||
      row[2] !== scope.deptPayload.code || row[3] !== scope.deptPayload.name ||
      String(row[4]) !== '0' || String(row[5]) !== '0' || String(row[6]) !== '0' ||
      idOf(row[7], '数据库部门创建者') !== creatorId) {
    throw new Error('BLOCKED: MAINT-004 专属部门只读所有权/状态不一致，禁止分配范围角色')
  }
  scope.departmentOwnershipVerified = true
  caseRecord.evidence.push(`MAINT-004 部门引导只读核实：tenant=${tenantId}; dept=${deptId}; ` +
    `creator=${creatorId}; marker=${scope.deptPayload.code}；仅用于所有权前置，不代替正式API验收`)
}

export async function prepareMaintenanceIsolationDeviceScope (
  api, auth, fixture, caseRecord, dependencies = {}
) {
  assertLocalFixtureWrites()
  await verifyMaintenanceIsolationIdentity(api, auth, fixture, caseRecord, { requireEmpty: false })
  if (fixture.deviceScope) throw new Error('BLOCKED: MAINT-004 不允许重复创建部门范围')
  const info = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
  for (const permission of [
    'system:dept:create', 'system:dept:query', 'system:dept:update',
    'system:role:create', 'system:role:query', 'system:role:update',
    'system:permission:assign-user-role', 'system:permission:assign-role-data-scope',
    'system:permission:assign-role-menu'
  ]) {
    if (!info.permissions.includes(permission)) throw new Error(`BLOCKED: 既有基础权限缺少 ${permission}`)
  }
  const provision = await maintenanceScopeProvision(fixture, dependencies)
  const scopeApi = provision.api
  const suffix = randomBytes(5).toString('hex').toUpperCase()
  const scope = {
    provisionActorId: provision.platformActorId,
    businessActorId: idOf(fixture.userId, '专属部门业务创建者'),
    deptPayload: { name: `E2E M4 DEPT ${suffix}`, code: `E2E-M4-${suffix}`,
      parentId: '0', sort: 0, status: 0 },
    rolePayload: { name: `E2E M4 SCOPE ${suffix}`, code: `e2em4scope${suffix.toLowerCase()}`,
      sort: 9997, status: 0, remark: `MAINT-004 own department ${suffix}` }
  }
  fixture.deviceScope = scope
  scope.deptId = idOf(dataOf(await scopeApi.postBusiness('/system/dept/create', scope.deptPayload)), '专属部门')
  caseRecord.evidence.push(`MAINT-004 scope department=${scope.deptId}; tenant=${fixture.tenantId}; code=${scope.deptPayload.code}`)
  await verifyCreatedMaintenanceDepartment(fixture, caseRecord, dependencies)
  await readOwnedMaintenanceDepartment(provision.readApi, fixture)
  scope.roleId = idOf(dataOf(await scopeApi.postBusiness('/system/role/create', scope.rolePayload)), '专属范围角色')
  if (scope.roleId === fixture.adminRoleId) throw new Error('BLOCKED: 范围角色创建指向内置管理员角色')
  caseRecord.evidence.push(`MAINT-004 scope role=${scope.roleId}; tenant=${fixture.tenantId}; code=${scope.rolePayload.code}`)
  const role = await readOwnedMaintenanceRole(provision.readApi, fixture)
  if (role.dataScope !== 5 || role.dataScopeDeptIds != null &&
      (!Array.isArray(role.dataScopeDeptIds) || role.dataScopeDeptIds.length !== 0)) {
    throw new Error('BLOCKED: 新建自定义范围角色不是正式默认 SELF')
  }
  requireTrue(await scopeApi.postBusiness('/system/permission/assign-role-data-scope', {
    roleId: scope.roleId, dataScope: 2, dataScopeDeptIds: [scope.deptId]
  }), '专属部门范围分配')
  await readOwnedMaintenanceRole(scopeApi, fixture, { requireCustom: true })
  scope.dataScopeVerified = true
  requireTrue(await scopeApi.postBusiness('/system/permission/assign-user-role', {
    userId: fixture.userId, roleIds: [fixture.adminRoleId, scope.roleId]
  }), '专属管理员附加无菜单部门范围角色')
  scope.assigned = true
  await verifyMaintenanceIsolationIdentity(api, auth, fixture, caseRecord, { requireEmpty: false })
  scope.ready = true
  caseRecord.evidence.push(`MAINT-004 正式访租引导：platformActor=${scope.provisionActorId}; ` +
    `visitTenant=${fixture.tenantId}; businessActor=${fixture.userId}；业务仍使用真实租户登录`)
  caseRecord.checks.push({
    name: 'MAINT004 数据范围仅限本轮专属部门，内置 SELF 角色及菜单权限保持不变',
    passed: true, details: `tenant=${fixture.tenantId}; user=${fixture.userId}; adminRole=${fixture.adminRoleId}; scopeRole=${scope.roleId}; dept=${scope.deptId}`
  })
}

export async function createMaintenanceIsolationDevice ({
  api, auth, fixture, fixtures, product, marker, caseRecord
}) {
  assertLocalFixtureWrites()
  await verifyMaintenanceIsolationIdentity(api, auth, fixture, caseRecord, { requireEmpty: false })
  if (fixture.device || !fixture.deviceScope?.ready || !/^E2E-MAINT-004-DEVICE-/.test(marker || '') ||
      String(product?.id) !== fixture.product?.id || product.name !== fixture.product.name ||
      String(product.categoryId) !== fixture.categoryId || !Number.isInteger(product.deviceType)) {
    throw new Error('BLOCKED: MAINT-004 设备缺少已核实的专属部门/产品/分类链')
  }
  const owner = {
    productId: idOf(product.id, '专属设备产品'), deviceName: marker,
    deptId: fixture.deviceScope.deptId, deviceType: product.deviceType
  }
  const assertDevice = (row, id) => {
    if (idOf(row?.id, '专属设备回读') !== id || idOf(row.productId, '设备产品') !== owner.productId ||
        row.deviceName !== owner.deviceName || idOf(row.deptId, '设备部门') !== owner.deptId ||
        row.deviceType !== owner.deviceType) {
      throw new Error(`BLOCKED: MAINT-004 设备所有权回读不一致 id=${id}`)
    }
  }
  const response = await api.postBusiness('/iot/device/create', {
    productId: owner.productId, deviceName: owner.deviceName, deptId: owner.deptId
  })
  const id = idOf(dataOf(response), '专属设备创建')
  fixture.device = { ...owner, id }
  fixtures.track(id, 'MAINT004 专属 IoT 设备', async (deviceId) => {
    await verifyMaintenanceIsolationIdentity(api, auth, fixture, caseRecord, { requireEmpty: false })
    assertDevice(dataOf(await api.getBusiness(`/iot/device/get?id=${deviceId}`)), deviceId)
    requireTrue(await api.deleteBusiness(`/iot/device/delete?id=${deviceId}`), '专属设备删除')
    if (dataOf(await api.getBusiness(`/iot/device/get?id=${deviceId}`)) !== null) {
      throw new Error('MAINT-004 专属设备删除后仍可回读')
    }
    fixture.deviceCleanupVerified = true
  })
  const device = dataOf(await api.getBusiness(`/iot/device/get?id=${id}`))
  assertDevice(device, id)
  caseRecord.evidence.push(`MAINT-004 tenant=${fixture.tenantId}/user=${fixture.userId} -> ` +
    `category=${fixture.categoryId}/product=${owner.productId} -> device=${id}/dept=${owner.deptId}`)
  return device
}

function recordMaintenanceScopeResiduals (fixture, caseRecord, error) {
  const scope = fixture.deviceScope
  if (!scope || !caseRecord) return
  for (const [resource, id, payload, verified] of [
    ['department', scope.deptId, scope.deptPayload, scope.deptRetirementVerified],
    ['scope-role', scope.roleId, scope.rolePayload, scope.roleRetirementVerified]
  ]) {
    if (!id || verified) continue
    const residual = {
      resource, id, tenantId: fixture.tenantId, userId: fixture.userId,
      code: payload.code, name: payload.name, roleAssigned: scope.assigned === true,
      retirementVerified: false, reason: error.message
    }
    caseRecord.maintenanceIsolationResiduals ||= []
    const existing = caseRecord.maintenanceIsolationResiduals.findIndex(
      row => row.resource === resource && row.id === id && row.tenantId === fixture.tenantId
    )
    if (existing < 0) {
      caseRecord.maintenanceIsolationResiduals.push(residual)
      caseRecord.notes.push(`MAINT-004 残留待核实：tenant=${fixture.tenantId}; ${resource}=${id}; ` +
        `code=${payload.code}; 未确认停用，不能将 API null 视为清理成功`)
    } else caseRecord.maintenanceIsolationResiduals[existing] = residual
  }
}

async function retireMaintenanceDeviceScope (fixture, caseRecord, dependencies) {
  const scope = fixture.deviceScope
  if (!scope?.deptId) return
  try {
    const { api, readApi } = await maintenanceScopeProvision(fixture, dependencies)
    await readOwnedMaintenanceScope(readApi, fixture, { active: false })
    const errors = []
    for (const [label, path, id, payload, readOwned, verifiedFlag] of [
      ['专属部门', '/system/dept', scope.deptId, scope.deptPayload,
        readOwnedMaintenanceDepartment, 'deptRetirementVerified'],
      ['无菜单范围角色', '/system/role', scope.roleId, scope.rolePayload,
        readOwnedMaintenanceRole, 'roleRetirementVerified']
    ]) {
      if (!id) continue
      try {
        requireTrue(await api.putBusiness(`${path}/update`, { ...payload, id, status: 1 }), `${label}停用`)
        const row = await readOwned(readApi, fixture, { active: false })
        if (row.status !== 1) throw new Error(`${label}停用回读不一致`)
        scope[verifiedFlag] = true
        caseRecord?.evidence?.push(`清理：${label} ${id} 已停用并回读；保留审计关联`)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw combineErrors(errors, 'MAINT-004 部门范围退役失败')
    scope.retired = true
  } catch (error) {
    recordMaintenanceScopeResiduals(fixture, caseRecord, error)
    throw error
  }
}

/** Select only existing enabled package-111 menus and their complete ancestors. */
export function buildMaintenanceIsolationPackage ({ standardPackage, menus, assignableMenus = menus }) {
  if (String(standardPackage?.id) !== '111' || !enabled(standardPackage)) {
    throw new Error('BLOCKED: 标准套餐 111 不存在或未启用')
  }
  const sourceIds = new Set((standardPackage.menuIds || []).map(String))
  const rows = flatten(menus)
  const byId = new Map(rows.map((menu) => [String(menu.id), menu]))
  const assignableIds = new Set(flatten(assignableMenus).map((menu) => String(menu.id)))
  const chainOf = (menu) => {
    const chain = []
    const seen = new Set()
    while (menu) {
      const id = idOf(menu.id, '菜单')
      if (seen.has(id)) throw new Error(`BLOCKED: 菜单父链循环 ${id}`)
      seen.add(id)
      if (!sourceIds.has(id) || !assignableIds.has(id) || !enabled(menu)) {
        throw new Error(`BLOCKED: 菜单或父链不在启用标准套餐 111 可分配范围 ${id}`)
      }
      chain.push(id)
      if (String(menu.parentId) === '0') return chain
      menu = byId.get(String(menu.parentId))
    }
    throw new Error('BLOCKED: 菜单父链缺失')
  }
  const requested = COMPONENTS.map((component) => {
    const menu = rows.find((row) => row.component === component && sourceIds.has(String(row.id)))
    if (!menu) throw new Error(`BLOCKED: 缺少标准套餐页面 ${component}`)
    return menu
  })
  for (const permission of MAINTENANCE_ISOLATION_PERMISSIONS) {
    const menu = requested.find((row) => row.permission === permission) ||
      rows.find((row) => row.permission === permission && sourceIds.has(String(row.id)) && enabled(row))
    if (!menu) throw new Error(`BLOCKED: 标准套餐 111 缺少 ${permission}`)
    requested.push(menu)
  }
  const menuIds = [...new Set(requested.flatMap(chainOf))]
  const permissions = [...new Set(menuIds.map((id) => byId.get(id).permission).filter(Boolean))]
  if (permissions.some((permission) => permission.includes('*'))) {
    throw new Error('BLOCKED: 必需菜单父链包含通配权限，禁止扩权')
  }
  const bootstrapRoots = rows.filter((menu) => enabled(menu) &&
    TENANT_BOOTSTRAP_COMPONENTS.includes(menu.component))
  for (const component of TENANT_BOOTSTRAP_COMPONENTS) {
    if (!bootstrapRoots.some((menu) => menu.component === component)) {
      throw new Error(`BLOCKED: 正式租户管理员基础菜单缺失 ${component}`)
    }
  }
  const bootstrapRootIds = new Set(bootstrapRoots.map((menu) => String(menu.id)))
  const bootstrapMenuIds = new Set(bootstrapRoots.flatMap(chainOf))
  for (const menu of rows.filter(enabled)) {
    const ancestors = []
    const seen = new Set()
    let current = menu
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id))
      ancestors.push(String(current.id))
      current = byId.get(String(current.parentId))
    }
    if (ancestors.some((id) => bootstrapRootIds.has(id))) {
      chainOf(menu).forEach((id) => bootstrapMenuIds.add(id))
    }
  }
  const bootstrapPermissions = [...new Set([...bootstrapMenuIds]
    .map((id) => byId.get(id).permission).filter(Boolean))]
  if (bootstrapPermissions.some((permission) => permission.includes('*'))) {
    throw new Error('BLOCKED: 正式租户管理员基础菜单包含通配权限')
  }
  return { menuIds, permissions, bootstrapPermissions }
}

const assertLocalFixtureWrites = () => {
  if (config.target !== 'local' || process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
    throw new Error('BLOCKED: MAINT-004 仅允许显式启用的本地专属隔离写侧')
  }
}

export async function createMaintenanceIsolationTenant (api, { marker, password } = {}) {
  assertLocalFixtureWrites()
  await verifyMaintenancePlatformActor(api)
  const standardPackage = dataOf(await api.getBusiness('/system/tenant-package/get?id=111'))
  const menus = dataOf(await api.getBusiness('/system/menu/list'))
  const assignableMenus = dataOf(await api.getBusiness('/system/menu/list-all-simple'))
  // All menu and ancestor checks precede the first write.
  const plan = buildMaintenanceIsolationPackage({ standardPackage, menus, assignableMenus })
  const suffix = (String(marker || '').replace(/[^A-Za-z0-9]/g, '').slice(-10) ||
    randomBytes(5).toString('hex')).toUpperCase()
  const safePassword = password || `M4!${randomBytes(5).toString('hex')}`
  if (safePassword.length < 4 || safePassword.length > 16) {
    throw new Error('BLOCKED: 隔离管理员密码不符合正式接口约束')
  }
  const fixture = {
    plan,
    packagePayload: {
      name: `E2E M4 ISO PKG ${suffix}`, status: 0,
      remark: `MAINT-004 isolated acceptance ${suffix}`, menuIds: plan.menuIds
    }
  }
  fixture.packageId = idOf(dataOf(await api.postBusiness(
    '/system/tenant-package/create', fixture.packagePayload
  )), '专属套餐')
  if (fixture.packageId === '111') throw new Error('BLOCKED: 创建结果指向共享套餐，禁止清理共享数据')
  const errors = []
  try {
    const savedPackage = dataOf(await api.getBusiness(`/system/tenant-package/get?id=${fixture.packageId}`))
    if (String(savedPackage?.id) !== fixture.packageId || savedPackage.status !== 0 ||
        JSON.stringify([...savedPackage.menuIds].map(String).sort()) !==
        JSON.stringify([...plan.menuIds].sort())) {
      throw new Error('专属套餐权限回读不一致')
    }
    fixture.tenantPayload = {
      name: `E2E M4 ISO TEN ${suffix}`, contactName: 'CFOR E2E MAINT004',
      contactMobile: '19900000000', status: 0, packageId: fixture.packageId,
      expireTime: '2099-12-31T23:59:59', accountCount: 1,
      username: `e2em4${suffix.toLowerCase()}`, password: safePassword
    }
    fixture.tenantId = idOf(dataOf(await api.postBusiness('/system/tenant/create', fixture.tenantPayload)), '专属租户')
    fixture.tenant = {
      id: fixture.tenantId, name: fixture.tenantPayload.name,
      username: fixture.tenantPayload.username, password: safePassword
    }
    const saved = dataOf(await api.getBusiness(`/system/tenant/get?id=${fixture.tenantId}`))
    if (fixture.tenantId === '1' || String(saved?.id) !== fixture.tenantId ||
        String(saved.packageId) !== fixture.packageId || saved.name !== fixture.tenant.name || saved.status !== 0) {
      throw new Error('BLOCKED: 专属租户回读不一致')
    }
    return fixture
  } catch (error) {
    errors.push(error)
    try { await retireMaintenanceIsolationTenant(api, fixture) } catch (cleanupError) { errors.push(cleanupError) }
    throw combineErrors(errors, '隔离租户创建或清理失败')
  }
}

/** Never switch a platform token's tenant header to perform business writes. */
export async function disableMaintenanceIsolationAccount (fixture, caseRecord, dependencies = {}) {
  if (fixture.accountDisabled || !fixture.tenant) return
  const apiFactory = dependencies.createApiClient || createApiClient
  const anonymous = apiFactory({ tenantId: fixture.tenantId })
  const auth = dataOf(await anonymous.postBusiness('/system/auth/login-encrypted', {
    username: fixture.tenant.username, password: fixture.tenant.password,
    captchaVerification: '', captchaVerificationVO: {}
  }, { encrypted: true }))
  if (String(auth?.tenantId) !== fixture.tenantId || !auth.accessToken) {
    throw new Error('BLOCKED: 清理管理员登录租户身份不一致')
  }
  const api = apiFactory({ token: auth.accessToken, tenantId: fixture.tenantId })
  const errors = []
  try {
    const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
    const userId = idOf(profile?.id, '清理管理员')
    if (profile.username !== fixture.tenant.username ||
        (fixture.userId && fixture.userId !== userId)) {
      throw new Error('BLOCKED: 清理管理员不是本轮专属账号')
    }
    fixture.userId = userId
    try {
      await retireMaintenanceDeviceScope(fixture, caseRecord, dependencies)
    } catch (error) { errors.push(error) }
    try {
      requireTrue(await api.putBusiness('/system/user/update-status', { id: userId, status: 1 }), '专属管理员停用')
      const saved = dataOf(await api.getBusiness(`/system/user/get?id=${userId}`))
      if (String(saved?.id) !== userId || saved.username !== fixture.tenant.username || saved.status !== 1) {
        throw new Error('专属管理员停用回读不一致')
      }
      fixture.accountDisabled = true
      caseRecord?.evidence?.push(`清理：专属管理员 ${userId} 已停用并回读；保留审计主体`)
    } catch (error) { errors.push(error) }
  } catch (error) {
    errors.push(error)
  } finally {
    try { requireTrue(await api.postBusiness('/system/auth/logout'), '专属管理员会话退出') } catch (error) { errors.push(error) }
  }
  if (errors.length) throw combineErrors(errors, 'MAINT-004 专属管理员退役失败')
}

export async function retireMaintenanceIsolationTenant (api, fixture, caseRecord, dependencies = {}) {
  if (!fixture) return
  if (fixture.packageId === '111' || fixture.tenantId === '1' ||
      !fixture.packagePayload?.name?.startsWith('E2E M4 ISO PKG ') ||
      (fixture.tenantId && !fixture.tenantPayload?.name?.startsWith('E2E M4 ISO TEN '))) {
    throw new Error('BLOCKED: 退役对象不是本轮专属租户/套餐')
  }
  const errors = []
  if (fixture.tenant) {
    try {
      await (dependencies.disableAccount || disableMaintenanceIsolationAccount)(fixture, caseRecord, dependencies)
    } catch (error) { errors.push(error) }
  }
  for (const [label, path, id, payload] of [
    ['专属租户', '/system/tenant', fixture.tenantId, fixture.tenantPayload],
    ['专属套餐', '/system/tenant-package', fixture.packageId, fixture.packagePayload]
  ]) {
    if (!id) continue
    try {
      await api.putBusiness(`${path}/update`, { ...payload, id, status: 1 })
      const saved = dataOf(await api.getBusiness(`${path}/get?id=${id}`))
      if (String(saved?.id) !== id || saved.status !== 1) throw new Error(`${label}停用回读不一致`)
      caseRecord?.evidence?.push(`清理：${label} ${id} 已停用并回读`)
    } catch (error) { errors.push(error) }
  }
  if (errors.length) {
    recordMaintenanceScopeResiduals(fixture, caseRecord, combineErrors(errors, '隔离退役失败'))
    caseRecord?.checks?.push({ name: '清理：隔离管理员/租户/套餐停用', passed: false,
      details: errors.map((error) => error.message).join('；') })
    throw combineErrors(errors, '隔离退役失败')
  }
  caseRecord?.checks?.push({
    name: '清理：隔离管理员/租户/套餐停用并回读',
    passed: true, details: `user=${fixture.userId}; tenant=${fixture.tenantId}; package=${fixture.packageId}`
  })
}

export async function verifyMaintenanceIsolationIdentity (
  api, auth, fixture, caseRecord, { requireEmpty = true } = {}
) {
  if (fixture.tenantId === '1' || String(auth?.tenantId) !== fixture.tenantId ||
      typeof auth?.token !== 'string' || !auth.token) {
    throw new Error('BLOCKED: MAINT-004 必须使用非租户 1 的本轮真实管理员')
  }
  const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
  const userId = idOf(profile?.id, '真实专属管理员')
  const permissionInfo = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
  const scope = fixture.deviceScope?.assigned ? fixture.deviceScope : null
  const expectedRoles = ['tenant_admin', ...(scope ? [scope.rolePayload.code] : [])]
  if ((fixture.userId && userId !== fixture.userId) || profile.username !== fixture.tenant.username ||
      String(permissionInfo?.user?.id) !== userId ||
      permissionInfo.user.username !== fixture.tenant.username ||
      profile.dept != null || permissionInfo.user.deptId != null ||
      !Array.isArray(permissionInfo.roles) || permissionInfo.roles.length !== expectedRoles.length ||
      new Set(permissionInfo.roles).size !== expectedRoles.length ||
      expectedRoles.some(role => !permissionInfo.roles.includes(role)) ||
      !Array.isArray(permissionInfo.permissions) ||
      permissionInfo.permissions.some((permission) => permission.includes('*')) ||
      fixture.plan.permissions.some((permission) => !permissionInfo.permissions.includes(permission))) {
    throw new Error('BLOCKED: 专属管理员身份/套餐权限不完整或包含超级角色')
  }
  fixture.userId = userId
  if (!fixture.adminRoleId) {
    if (profile.roles?.length !== 1) throw new Error('BLOCKED: 初始专属管理员内置角色不唯一')
    fixture.adminRoleId = idOf(profile.roles[0].id, '内置租户管理员角色')
  }
  const expectedRoleIds = [fixture.adminRoleId, ...(scope ? [scope.roleId] : [])]
  if (!sameIds(profile.roles?.map(role => role.id), expectedRoleIds)) {
    throw new Error('BLOCKED: 专属管理员真实角色ID不等于本轮内置/部门范围角色')
  }
  const adminRole = dataOf(await api.getBusiness(`/system/role/get?id=${fixture.adminRoleId}`))
  if (String(adminRole?.id) !== fixture.adminRoleId || adminRole.code !== 'tenant_admin' ||
      adminRole.type !== 1 || adminRole.status !== 0 || adminRole.dataScope !== 5) {
    throw new Error('BLOCKED: 内置租户管理员必须保持正式 SELF 数据范围，不允许修改系统角色')
  }
  if (scope) await readOwnedMaintenanceScope(api, fixture)
  const expectedPermissions = new Set([...fixture.plan.permissions, ...fixture.plan.bootstrapPermissions])
  const actualPermissions = new Set(permissionInfo.permissions.filter(Boolean))
  if ([...actualPermissions].some((permission) => !expectedPermissions.has(permission)) ||
      [...expectedPermissions].some((permission) => !actualPermissions.has(permission))) {
    throw new Error('BLOCKED: 专属管理员权限不等于本案例套餐与正式基础菜单闭包')
  }
  caseRecord.evidence.push('正式开通自动补齐的管理员基础权限（未写入专属套餐；范围角色不新增菜单权限）：' +
    fixture.plan.bootstrapPermissions.join(','))
  if (!requireEmpty) return
  for (const path of [
    '/iot/product/page?pageNo=1&pageSize=100',
    '/iot/device/page?pageNo=1&pageSize=100',
    '/mes/maintenance-plan/page?pageNo=1&pageSize=100',
    '/mes/maintenance-plan-assignment/page?pageNo=1&pageSize=100',
    '/mes/system/order/list?pageNo=1&pageSize=100'
  ]) {
    const payload = dataOf(await api.getBusiness(path))
    const rows = payload?.list ?? payload?.records
    if (!Array.isArray(rows) || Number(payload.total) !== 0 || rows.length !== 0) {
      throw new Error(`BLOCKED: 临时租户不是空白专属范围 ${path}`)
    }
  }
  caseRecord.checks.push({
    name: '本轮真实临时租户管理员，套餐仅含标准111必需权限且业务域空白',
    passed: true, details: `tenant=${fixture.tenantId}; user=${fixture.userId}; package=${fixture.packageId}`
  })
}

/**
 * The maintenance acceptance tenant is created through the official tenant
 * API, so it starts in the same unconfirmed state as any new customer tenant.
 * Confirm the first initialization step with the real tenant administrator
 * before opening an IoT/MES business route; this keeps the frontend onboarding
 * guard active and exercises the same permission boundary as a customer login.
 */
export async function confirmMaintenanceTenantInitialization (
  page, api, caseRecord, { platformApi, tenantId } = {}
) {
  const readbackApi = platformApi && tenantId
    ? {
        getBusiness: (path, extra) => platformApi.getBusiness(path, {
          ...(extra || {}),
          headers: { ...(extra?.headers || {}), 'visit-tenant-id': String(tenantId) }
        })
      }
    : api
  const current = dataOf(await api.getBusiness('/system/system-init/state'))
  const confirmed = Number(current?.currentStep) >= 2 &&
    typeof current?.industryTemplate === 'string' && current.industryTemplate.trim() !== ''
  if (!confirmed) {
    const options = dataOf(await api.getBusiness(
      '/system/system-init/industry-template/options'
    ))
    const candidates = Array.isArray(options) ? options : []
    const selected = candidates.find((item) =>
      item?.selectable !== false && item?.level === 'SUB_INDUSTRY'
    ) || candidates.find((item) => item?.selectable !== false)
    if (!selected?.code) {
      throw new Error('BLOCKED: MAINT-004 没有可用于正式初始化确认的行业模板')
    }
    const modules = ['system', 'bpm', 'iot']
    assertBusinessSuccess(await api.putBusiness('/system/system-init/state', {
      industryTemplate: selected.code,
      selectedModules: modules,
      currentStep: 2
    }), 'MAINT-004 确认隔离租户初始化首步')
    const saved = dataOf(await readbackApi.getBusiness('/system/system-init/state'))
    if (Number(saved?.currentStep) < 2 || saved?.industryTemplate !== selected.code ||
        !Array.isArray(saved?.selectedModules) ||
        !saved.selectedModules.includes('iot')) {
      throw new Error('BLOCKED: MAINT-004 初始化首步正式回读不一致')
    }
    caseRecord.evidence.push(
      `MAINT-004 使用正式初始化接口确认首步：industry=${selected.code}; modules=${modules.join(',')}`
    )
  }
  if (page?.reload) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => !window.location.pathname.includes('/login'),
      { timeout: 30000 }
    )
  }
  caseRecord.checks.push({
    name: '隔离租户已通过正式初始化首步并可进入业务路由',
    passed: true,
    details: `industry=${current?.industryTemplate || 'confirmed'}`
  })
}

export async function runMaintenanceTenantIsolation (context, api, run, dependencies = {}) {
  assertLocalFixtureWrites()
  const caseRecord = context.caseRecord
  await (dependencies.assertWriteSafety || assertLocalWriteSafety)(caseRecord)
  let fixture
  let result
  const errors = []
  let scopeDependencies
  try {
    const platformActorId = await verifyMaintenancePlatformActor(api)
    scopeDependencies = { ...dependencies, platformApi: api, platformActorId }
    fixture = await (dependencies.createTenant || createMaintenanceIsolationTenant)(api, {
      marker: `${context.record?.runId || ''}${randomBytes(3).toString('hex')}`
    })
    caseRecord.evidence.push(`MAINT-004 专属隔离：tenant=${fixture.tenantId}; package=${fixture.packageId}; ` +
      `sourcePackage=111; menuIds=${fixture.plan.menuIds.join(',')}`)
    result = await (dependencies.withTenant || withIotIsolationTenant)(context, fixture.tenant,
      async (session) => {
        // Scope provisioning uses the platform administrator's formal
        // visit-tenant APIs. Complete it before initialization synchronizes
        // the tenant administrator's menu set for the selected modules.
        await prepareMaintenanceIsolationDeviceScope(session.api, session.auth, fixture, caseRecord, {
          ...scopeDependencies
        })
        await (dependencies.prepareTenant || confirmMaintenanceTenantInitialization)(
          session.page, session.api, caseRecord, {
            platformApi: scopeDependencies.platformApi,
            tenantId: fixture.tenantId
          }
        )
        await diagnoseMaintenanceRouteContext(session.page, session.api, fixture, caseRecord)
        await verifyMaintenanceIsolationIdentity(session.api, session.auth, fixture, caseRecord)
        return run({ ...session, maintenanceIsolation: fixture })
      }, dependencies)
  } catch (error) {
    errors.push(error)
  } finally {
    if (fixture) {
      try {
        await (dependencies.retireTenant || retireMaintenanceIsolationTenant)(api, fixture, caseRecord, scopeDependencies)
      } catch (error) { errors.push(error) }
    }
  }
  if (errors.length) throw combineErrors(errors, 'MAINT-004 隔离执行失败')
  return result
}
