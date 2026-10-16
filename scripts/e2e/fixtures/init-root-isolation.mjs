import { randomBytes } from 'node:crypto'

import { createApiClient } from '../lib/api.mjs'
import { login, observePage } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { extractAccessToken, resolveLoginContext } from '../lib/session.mjs'

export const ROOT_ISOLATION_CHECK = '专属租户验证无根/有效根/停用根并清理本轮根组织'
export const ROOT_ISOLATION_PERMISSIONS = Object.freeze([
  'system:dept:query', 'system:dept:create', 'system:dept:update', 'system:dept:delete',
  'system:user:query', 'system:user:update', 'system:system-init:query'
])
const COMPONENTS = [
  'system/tenant-workbench/index', 'system/user/index', 'system/role/index',
  'system/dept/index', 'system/enterprise-organization/index', 'system/systemInit/index'
]
export const ROOT_ISOLATION_PLATFORM_PERMISSIONS = Object.freeze([
  'system:tenant:query', 'system:tenant:create', 'system:tenant:update',
  'system:tenant-package:query', 'system:tenant-package:create', 'system:tenant-package:update',
  'system:menu:query', 'system:user:query', 'system:user:update',
  'system:dept:query', 'system:dept:create', 'system:dept:update', 'system:dept:delete'
])
const dataOf = (payload) => payload?.data
const requireFact = (condition, message) => {
  if (!condition) throw new Error(`BLOCKED: ${message}`)
}
export const rootIsolationId = (value) => {
  requireFact(!(typeof value === 'number' && !Number.isSafeInteger(value)) &&
    /^[1-9]\d*$/.test(String(value ?? '')), 'root isolation requires an exact positive ID')
  return String(value)
}
const flatten = (menus) => (Array.isArray(menus) ? menus : []).flatMap((menu) =>
  [menu, ...flatten(menu?.children)])
const hasPermissions = (values, required) => Array.isArray(values) &&
  required.every((permission) => values.includes(permission) || values.includes('*:*:*'))

const menuChain = (menu, byId) => {
  const chain = []
  const seen = new Set()
  let current = menu
  while (current) {
    const currentId = rootIsolationId(current.id)
    requireFact(!seen.has(currentId), `菜单父链存在循环：${currentId}`)
    seen.add(currentId)
    chain.push(current)
    if (String(current.parentId ?? '0') === '0') return chain
    current = byId.get(rootIsolationId(current.parentId))
  }
  throw new Error('菜单父链不完整')
}

const missingPlatformPermissions = (info) => {
  // Match PermissionServiceImpl: enabled super_admin does not need a permission menu.
  if (Array.isArray(info?.roles) && info.roles.includes('super_admin')) return []
  // The visit interceptor still checks this permission for non-super administrators.
  const required = [...ROOT_ISOLATION_PLATFORM_PERMISSIONS, 'system:tenant:visit']
  return required.filter((permission) =>
    !Array.isArray(info?.permissions) || !info.permissions.includes(permission))
}

// Derive a private package without mutating or exceeding package 111.
export function buildRootIsolationPackage ({ standardPackage, menus, assignableMenus }) {
  requireFact(String(standardPackage?.id) === '111' && Number(standardPackage.status) === 0 &&
    Array.isArray(standardPackage.menuIds), 'enabled standard package 111 is required')
  const allowed = new Set(standardPackage.menuIds.map(rootIsolationId))
  const flat = flatten(menus)
  const byId = new Map(flat.map((menu) => [rootIsolationId(menu.id), menu]))
  requireFact(byId.size === flat.length, 'duplicate menu IDs in root isolation source')
  const assignable = new Set(flatten(assignableMenus).map((menu) => rootIsolationId(menu.id)))
  const validMenu = (menu) => {
    if (!menu) return false
    try {
      for (const ancestor of menuChain(menu, byId)) {
        const ancestorId = rootIsolationId(ancestor.id)
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
  const findValidMenu = (predicate) => flat.find((menu) => predicate(menu) && validMenu(menu))
  const requested = [
    ...COMPONENTS.map((component) => findValidMenu((menu) => menu.component === component)),
    ...ROOT_ISOLATION_PERMISSIONS.map((permission) =>
      findValidMenu((menu) => menu.permission === permission))
  ]
  requireFact(requested.every(Boolean), 'root isolation menus/permissions are incomplete')
  const ids = new Set()
  for (const requestedMenu of requested) {
    const seen = new Set()
    let menu = requestedMenu
    while (menu) {
      const id = rootIsolationId(menu.id)
      requireFact(!seen.has(id), 'root isolation menu parent cycle')
      seen.add(id)
      requireFact(allowed.has(id) && assignable.has(id) && menu.status === 0 &&
        Number(menu.deleted ?? 0) === 0, `root isolation menu is not assignable within package 111: ${id}`)
      ids.add(id)
      if (String(menu.parentId) === '0') break
      const parentId = rootIsolationId(menu.parentId)
      menu = byId.get(parentId)
      requireFact(menu, `root isolation menu parent is missing: ${parentId}`)
    }
  }
  return { menuIds: [...ids] }
}

export function rootIsolationSpec () {
  const marker = randomBytes(8).toString('hex')
  return {
    marker,
    packagePayload: { name: `E2E ROOT PKG ${marker}`, status: 0,
      remark: `PB003 isolated root ${marker}` },
    tenantPayload: { name: `E2E ROOT TEN ${marker}`, contactName: 'CFOR E2E ROOT',
      contactMobile: '19900000000', status: 0, expireTime: '2099-12-31T23:59:59',
      accountCount: 1, username: `e2eroot${marker}`, password: `Root!${randomBytes(5).toString('hex')}` },
    rootPayload: { name: `E2EROOT-${marker}`, code: `E2EROOT-${marker}`,
      parentId: 0, unitType: 'BRANCH', dataBoundary: true, sort: 9999, status: 0 }
  }
}

const packageSql = (spec) => `SELECT CAST(id AS CHAR),name,CAST(status AS CHAR)
  FROM system_tenant_package WHERE name='${spec.packagePayload.name}' AND deleted=0`
const tenantSql = (spec) => `SELECT CAST(id AS CHAR),name,CAST(package_id AS CHAR),
  COALESCE(CAST(contact_user_id AS CHAR),''),CAST(status AS CHAR)
  FROM system_tenant WHERE name='${spec.tenantPayload.name}' AND deleted=0`
const usersSql = (tenantId) => `SELECT CAST(id AS CHAR),username,CAST(tenant_id AS CHAR),
  COALESCE(CAST(dept_id AS CHAR),''),CAST(status AS CHAR)
  FROM system_users WHERE tenant_id=${rootIsolationId(tenantId)} AND deleted=0`
const departmentsSql = (tenantId) => `SELECT CAST(id AS CHAR),name,CAST(tenant_id AS CHAR),
  CAST(parent_id AS CHAR),COALESCE(code,''),CAST(status AS CHAR),CAST(sort AS CHAR),
  COALESCE(CAST(leader_user_id AS CHAR),''),COALESCE(CAST(supervisor_user_id AS CHAR),''),
  COALESCE(creator,'')
  FROM system_dept WHERE tenant_id=${rootIsolationId(tenantId)} AND deleted=0`
const sameRootRows = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((row, index) =>
    Array.isArray(row) && Array.isArray(right[index]) && row.length === 10 &&
    right[index].length === 10 && row.every((value, column) => value === right[index][column]))
export const rootIsolationReferencesSql = (tenantId, deptId) => `
  SELECT 'other-departments',COUNT(*) FROM system_dept
    WHERE tenant_id=${rootIsolationId(tenantId)} AND deleted=0 AND id<>${rootIsolationId(deptId)}
  UNION ALL SELECT 'user-references',COUNT(*) FROM system_users
    WHERE tenant_id=${rootIsolationId(tenantId)} AND dept_id=${rootIsolationId(deptId)}
  UNION ALL SELECT 'role-references',COUNT(*) FROM system_role
    WHERE tenant_id=${rootIsolationId(tenantId)} AND deleted=0
    AND COALESCE(data_scope_dept_ids,'') NOT IN ('','[]','null')`
const tokensSql = (tenantId, userId) => `
  SELECT 'access-tokens',COUNT(*) FROM system_oauth2_access_token
    WHERE tenant_id=${rootIsolationId(tenantId)} AND user_id=${rootIsolationId(userId)} AND deleted=0
  UNION ALL SELECT 'refresh-tokens',COUNT(*) FROM system_oauth2_refresh_token
    WHERE tenant_id=${rootIsolationId(tenantId)} AND user_id=${rootIsolationId(userId)} AND deleted=0`

const mergeErrors = (errors) => {
  if (!errors.length) return null
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, `PB003 root isolation failed: ${errors.map((error) => error.message).join('; ')}`)
}

/**
 * All business mutations use formal APIs. SQL is only ownership/readiness evidence.
 * The caller enforces local scope and write opt-in before entering this lifecycle.
 */
export async function runFreshOrganizationRootEvidence (context, dependencies) {
  const { adminApi, readDb, factsSql, validateReadiness } = dependencies
  const { caseRecord } = context
  const apiFactory = dependencies.createApiClient || createApiClient
  const spec = rootIsolationSpec()
  const phases = []
  const errors = []
  const tokens = new Map()
  const loginResponses = []
  let packageAttempted = false
  let tenantAttempted = false
  let packageId, tenantId, userId, rootId, tenantApi, platformUserId
  let beforeLoginRoots, defaultRootBaseline
  let isolated, page, capture, loginListener
  let rootAttempted = false
  let loginAttempted = false
  let rootEvidenceStarted = false
  const query = (stage, sql) => readDb(caseRecord, `isolated-root-${stage}`, sql)
  const attempt = async (operation) => {
    try { await operation() } catch (error) { errors.push(error) }
  }
  const loadPackageOwner = async (allowMissing = false) => {
    const rows = await query('package-owner', packageSql(spec))
    if (allowMissing && rows.length === 0) return
    requireFact(rows.length === 1 && rows[0][1] === spec.packagePayload.name,
      'private root package ownership is ambiguous')
    const id = rootIsolationId(rows[0][0])
    requireFact(id !== '111' && (!packageId || packageId === id), 'private root package ID changed')
    packageId = id
  }
  const loadTenantOwner = async (allowMissing = false) => {
    const rows = await query('tenant-owner', tenantSql(spec))
    if (allowMissing && rows.length === 0) return
    requireFact(rows.length === 1 && rows[0][1] === spec.tenantPayload.name &&
      rows[0][2] === packageId, 'fresh root tenant ownership/package mismatch')
    const id = rootIsolationId(rows[0][0])
    requireFact(id !== '1' && (!tenantId || tenantId === id), 'root negatives require a fresh non-shared tenant')
    tenantId = id
    const linked = await query('package-tenants', `SELECT CAST(id AS CHAR),name
      FROM system_tenant WHERE package_id=${packageId} AND deleted=0`)
    requireFact(linked.length === 1 && linked[0][0] === tenantId &&
      linked[0][1] === spec.tenantPayload.name, 'private root package has unexpected tenant references')
    const users = await query('user-owner', usersSql(tenantId))
    requireFact(users.length === 1 && users[0][1] === spec.tenantPayload.username &&
      users[0][2] === tenantId && users[0][0] === rows[0][3], 'fresh root administrator ownership mismatch')
    const idOfUser = rootIsolationId(users[0][0])
    requireFact(!userId || userId === idOfUser, 'fresh root administrator ID changed')
    userId = idOfUser
    return users[0]
  }
  const visitOptions = () => ({ headers: { 'visit-tenant-id': tenantId } })
  const assertNoReferences = async (id) => {
    await loadTenantOwner()
    const rows = await query('reference-guard', rootIsolationReferencesSql(tenantId, id))
    requireFact(rows.length === 3 && ['other-departments', 'user-references', 'role-references']
      .every((key) => rows.filter((row) => row[0] === key).length === 1 &&
        rows.find((row) => row[0] === key)[1] === '0'), 'root has other organization/user/role references')
  }
  const assertRootOwner = async (id, isDefault = false) => {
    const rows = await query('root-owner', departmentsSql(tenantId))
    requireFact(rows.length === 1 && rows[0][0] === id && rows[0][2] === tenantId &&
      rows[0][3] === '0' && rows[0][7] === '' && rows[0][8] === '' &&
      (isDefault
        ? sameRootRows(rows, defaultRootBaseline) && rows[0][5] === '0' &&
          ((rows[0][1] === '企业总部' && rows[0][4] === '' &&
            rows[0][6] === '1' && rows[0][9] === userId) ||
           // Tenant-created BPM seeding runs as the platform creator, before login.
           (sameRootRows(rows, beforeLoginRoots) && rows[0][1] === '销售部' &&
            /^DEPT-[a-f0-9]{32}$/.test(rows[0][4]) &&
            rows[0][6] === '10' && rows[0][9] === platformUserId))
        : rows[0][1] === spec.rootPayload.name && rows[0][4] === spec.rootPayload.code &&
          rows[0][9] === platformUserId),
    'only a unique owned fresh/default root can be mutated')
    await assertNoReferences(id)
    const returned = dataOf(await adminApi.getBusiness(`/system/dept/get?id=${id}`, visitOptions()))
    requireFact(returned && rootIsolationId(returned.id) === id &&
      [returned.name, String(returned.parentId), String(returned.code ?? ''),
        String(returned.status), String(returned.sort), String(returned.leaderUserId ?? ''),
        String(returned.supervisorUserId ?? '')].every((value, index) =>
        value === rows[0][[1, 3, 4, 5, 6, 7, 8][index]]),
    'platform visit cannot read the exact owned root through the formal department API')
  }
  const sample = async (stage, api = tenantApi) => {
    const payload = await api.getBusiness('/system/system-init/readiness')
    const items = payload?.data?.items
    const matches = Array.isArray(items) ? items.filter((item) => item?.key === 'system.organization-root') : []
    const rows = await query(stage, factsSql(tenantId))
    const result = validateReadiness(matches.length === 1 ? matches[0] : null, rows)
    const expected = stage === 'active' ? [1, 1] : stage === 'disabled' ? [0, 1] : [0, 0]
    phases.push({ stage, ...result, valid: result.valid === true &&
      result.counts['active-root'] === expected[0] && result.counts['all-root'] === expected[1] })
    requireFact(phases.at(-1).valid, `root ${stage} API/SQL mismatch: ${JSON.stringify(phases.at(-1))}`)
  }
  const rememberAuth = (auth) => {
    if (typeof auth?.token === 'string' && auth.token) {
      tokens.set(auth.token, /^[1-9]\d*$/.test(String(auth.tenantId)) ? String(auth.tenantId) : tenantId)
    }
  }
  try {
    const permission = await adminApi.getBusiness('/system/auth/get-permission-info')
    const missingPermissions = missingPlatformPermissions(permission?.data)
    requireFact(missingPermissions.length === 0,
      `platform account lacks root isolation lifecycle permissions: ${missingPermissions.join(', ')}`)
    platformUserId = rootIsolationId(permission?.data?.user?.id)
    const standardPackage = dataOf(await adminApi.getBusiness('/system/tenant-package/get?id=111'))
    const menus = dataOf(await adminApi.getBusiness('/system/menu/list'))
    const assignableMenus = dataOf(await adminApi.getBusiness('/system/menu/list-all-simple'))
    Object.assign(spec.packagePayload, buildRootIsolationPackage({ standardPackage, menus, assignableMenus }))
    const preflight = await query('marker-preflight', `
      SELECT 'package',COUNT(*) FROM system_tenant_package WHERE name='${spec.packagePayload.name}'
      UNION ALL SELECT 'tenant',COUNT(*) FROM system_tenant WHERE name='${spec.tenantPayload.name}'
      UNION ALL SELECT 'user',COUNT(*) FROM system_users WHERE username='${spec.tenantPayload.username}'`)
    requireFact(preflight.length === 3 && ['package', 'tenant', 'user'].every((key) =>
      preflight.filter((row) => row[0] === key).length === 1 &&
      preflight.find((row) => row[0] === key)[1] === '0'), 'random root isolation marker already exists')
    packageAttempted = true
    const createdPackageId = rootIsolationId(dataOf(await adminApi.postBusiness(
      '/system/tenant-package/create', spec.packagePayload)))
    await loadPackageOwner()
    requireFact(createdPackageId === packageId, 'root package response/SQL mismatch')
    spec.tenantPayload.packageId = packageId
    tenantAttempted = true
    const createdTenantId = rootIsolationId(dataOf(await adminApi.postBusiness(
      '/system/tenant/create', spec.tenantPayload)))
    const administrator = await loadTenantOwner()
    requireFact(createdTenantId === tenantId && administrator[3] === '' && administrator[4] === '0',
      'fresh tenant response/SQL or administrator state mismatch')
    caseRecord.fixtures = [...(caseRecord.fixtures || []),
      { kind: 'root-isolation', marker: spec.marker, tenantId, packageId, userId, owned: true }]
    beforeLoginRoots = (await query('before-login', departmentsSql(tenantId))).map((row) => [...row])
    requireFact(beforeLoginRoots.length <= 1, 'fresh tenant has unexpected existing organizations')
    const browser = dependencies.browser || context.page.context().browser()
    isolated = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' })
    page = await isolated.newPage()
    capture = (dependencies.observePage || observePage)(page, context.record)
    // Keep issued tokens even if menu/bootstrap fails after successful authentication.
    loginListener = (response) => {
      if (!/\/system\/auth\/(?:login-encrypted|refresh-token)(?:\?|$)/.test(response.url()) ||
          response.request().method() !== 'POST') return
      loginResponses.push((async () => {
        const text = await response.text()
        const payload = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
          ? decryptResponse(text) : JSON.parse(text)
        rememberAuth(resolveLoginContext(payload, payload?.data?.accessToken))
      })().catch(() => { errors.push(new Error('root login token capture failed')) }))
    }
    page.on('response', loginListener)
    loginAttempted = true
    const auth = await (dependencies.login || login)(page, {
      credentials: { tenantName: spec.tenantPayload.name,
        username: spec.tenantPayload.username, password: spec.tenantPayload.password },
      returnContext: true, check: context.check
    })
    rememberAuth(auth)
    requireFact(rootIsolationId(auth?.tenantId) === tenantId && typeof auth?.token === 'string' && auth.token,
      'fresh root login identity mismatch')
    tenantApi = apiFactory({ token: auth.token, tenantId, record: context.record })
    await capture.flushResponses()
    const tenantPermissions = await tenantApi.getBusiness('/system/auth/get-permission-info')
    requireFact(rootIsolationId(tenantPermissions?.data?.user?.id) === userId &&
      tenantPermissions.data.user.username === spec.tenantPayload.username,
    'fresh tenant readiness identity mismatch')
    requireFact(hasPermissions(tenantPermissions?.data?.permissions, ROOT_ISOLATION_PERMISSIONS),
      'fresh tenant lacks root fixture permissions')
    caseRecord.rootAccessContext = {
      departmentActorId: platformUserId, departmentVisitTenantId: tenantId,
      readinessActorId: userId, readinessTenantId: tenantId
    }
    const original = await query('after-login', departmentsSql(tenantId))
    requireFact(original.length <= 1, 'fresh tenant has unexpected existing organizations')
    requireFact(beforeLoginRoots.length === 0 || sameRootRows(original, beforeLoginRoots),
      'fresh default root changed since the tenant creation baseline')
    if (original.length) {
      defaultRootBaseline = original.map((row) => [...row])
      const defaultRootId = rootIsolationId(original[0][0])
      await assertRootOwner(defaultRootId, true)
      await adminApi.deleteBusiness(`/system/dept/delete?id=${defaultRootId}`, visitOptions())
    }
    rootEvidenceStarted = true
    await sample('absent')
    rootAttempted = true
    // Tenant administrators start with SELF data scope; use the authorized platform visit
    // for department CRUD, while readiness remains tied to the isolated login identity.
    const createdRootId = rootIsolationId(dataOf(await adminApi.postBusiness(
      '/system/dept/create', spec.rootPayload, visitOptions())))
    const owned = await query('created-owner', departmentsSql(tenantId))
    requireFact(owned.length === 1 && owned[0][4] === spec.rootPayload.code &&
      owned[0][0] === createdRootId, 'root response/SQL mismatch')
    rootId = createdRootId
    await assertRootOwner(rootId)
    await sample('active')
    await assertRootOwner(rootId)
    await adminApi.putBusiness('/system/dept/update', { ...spec.rootPayload, id: rootId, status: 1 }, visitOptions())
    await sample('disabled')
  } catch (error) {
    errors.unshift(error)
  } finally {
    await attempt(async () => { await capture?.flushResponses() })
    await attempt(async () => { await Promise.all(loginResponses) })
    if (loginAttempted) {
      await attempt(async () => {
        const entries = await page.evaluate(() => [window.localStorage, window.sessionStorage]
          .flatMap((storage) => Array.from({ length: storage.length }, (_, index) => {
            const key = storage.key(index)
            return [key, storage.getItem(key)]
          })))
        const token = extractAccessToken(entries)
        if (token) rememberAuth({ token, tenantId })
      })
    }
    await attempt(async () => {
      if (page && loginListener) page.off('response', loginListener)
    })
    await attempt(async () => { await page?.close() })
    await attempt(async () => { await isolated?.close() })
    // Recover response-loss writes by the preflight-absent random marker, never by a shared ID.
    if (packageAttempted) await attempt(() => loadPackageOwner(true))
    if (tenantAttempted && packageId) await attempt(() => loadTenantOwner(true))
    if (tenantId && rootAttempted) {
      await attempt(async () => {
        const owned = await query('cleanup-root-owner', departmentsSql(tenantId))
        requireFact(owned.length <= 1, 'root cleanup ownership is ambiguous')
        if (owned.length) {
          const id = rootIsolationId(owned[0][0])
          requireFact(!rootId || rootId === id, 'root cleanup ID changed')
          await assertRootOwner(id)
          await adminApi.deleteBusiness(`/system/dept/delete?id=${id}`, visitOptions())
        }
      })
    }
    if (tenantId && rootEvidenceStarted) {
      await attempt(() => sample('cleaned'))
    }
    // Logout must precede tenant disable, otherwise the tenant filter rejects it.
    for (const [token, tokenTenantId] of tokens) {
      await attempt(async () => {
        await apiFactory({ token, tenantId: tokenTenantId, record: context.record })
          .postBusiness('/system/auth/logout')
      })
    }
    if (tenantId && userId) {
      await attempt(async () => {
        const rows = await query('revoked-tokens', tokensSql(tenantId, userId))
        requireFact(rows.length === 2 && ['access-tokens', 'refresh-tokens'].every((key) =>
          rows.filter((row) => row[0] === key).length === 1 &&
          rows.find((row) => row[0] === key)[1] === '0'), 'root administrator tokens were not fully revoked')
      })
    }
    if (tenantId && userId) {
      await attempt(async () => {
        await loadTenantOwner()
        await adminApi.putBusiness('/system/user/update-status', { id: userId, status: 1 }, visitOptions())
        const returned = dataOf(await adminApi.getBusiness(`/system/user/get?id=${userId}`, visitOptions()))
        const users = await query('retired-user', usersSql(tenantId))
        requireFact(String(returned?.id) === userId && returned.username === spec.tenantPayload.username &&
          returned.status === 1 && users.length === 1 && users[0][0] === userId &&
          users[0][1] === spec.tenantPayload.username &&
          users[0][2] === tenantId && users[0][4] === '1', 'root administrator retirement SQL mismatch')
      })
    }
    if (tenantId) {
      await attempt(async () => {
        await loadTenantOwner()
        const { username, password, ...body } = spec.tenantPayload
        await adminApi.putBusiness('/system/tenant/update', { ...body, id: tenantId, status: 1 })
        const returned = dataOf(await adminApi.getBusiness(`/system/tenant/get?id=${tenantId}`))
        await loadTenantOwner()
        const rows = await query('retired-tenant', tenantSql(spec))
        requireFact(String(returned?.id) === tenantId && returned.name === spec.tenantPayload.name &&
          String(returned.packageId) === packageId && returned.status === 1 &&
          rows.length === 1 && rows[0][4] === '1', 'root tenant retirement API/SQL mismatch')
      })
    }
    if (packageId) {
      await attempt(async () => {
        await loadPackageOwner()
        const linked = await query('package-tenants', `SELECT CAST(id AS CHAR),name
          FROM system_tenant WHERE package_id=${packageId} AND deleted=0`)
        requireFact(linked.length <= 1 && linked.every((row) => row[0] === tenantId &&
          row[1] === spec.tenantPayload.name), 'private root package has unexpected tenant references')
        await adminApi.putBusiness('/system/tenant-package/update',
          { ...spec.packagePayload, id: packageId, status: 1 })
        const returned = dataOf(await adminApi.getBusiness(`/system/tenant-package/get?id=${packageId}`))
        const rows = await query('retired-package', packageSql(spec))
        requireFact(String(returned?.id) === packageId && returned.name === spec.packagePayload.name &&
          returned.status === 1 && rows.length === 1 && rows[0][2] === '1',
        'root package retirement API/SQL mismatch')
      })
    }
    caseRecord.checks.push({ name: ROOT_ISOLATION_CHECK,
      passed: errors.length === 0 && phases.length === 4 && phases.every((phase) => phase.valid),
      details: `tenantId=${tenantId || 'not-created'}; marker=${spec.marker}; ${JSON.stringify(phases)}; ` +
        `lifecycleErrors=${errors.length}` })
  }
  const error = mergeErrors(errors)
  if (error) throw error
  return { executed: true }
}
