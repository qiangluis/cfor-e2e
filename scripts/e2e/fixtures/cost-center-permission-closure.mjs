import { createHash, randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, observePage, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { redact } from '../lib/redact.mjs'

export const COST_CENTER_PERMISSION_CHECKS = Object.freeze({
  preflight: 'COST-029 正式可分配菜单交集及最小权限预检通过',
  ownership: 'COST-029 本轮启用中心及专属部门 API/SQL 所有权一致',
  actors: 'COST-029 两个专属账号唯一 CUSTOM 部门及最小权限正式回读一致',
  maintenance: 'COST-029 维护账号新增编辑停用开窗取消及刷新真实可用',
  readOnly: 'COST-029 只读账号同一启用中心新增编辑停用按钮均不存在且刷新一致',
  create: 'COST-029 只读账号新增被精确403拒绝且API及全字段SQL哈希不变',
  update: 'COST-029 只读账号编辑被精确403拒绝且API及全字段SQL哈希不变',
  deactivate: 'COST-029 只读账号停用被精确403拒绝且API及全字段SQL哈希不变',
  uiSave: 'COST-029 页面保存保留完整部门ID且正式回读刷新及关系替换准确',
  cleanup: 'COST-029 专属账号退出令牌清零并停用账号角色准确回读'
})

const readPermissions = Object.freeze(['cost:center:query', 'cost:workspace-state:query'])
const writePermissions = Object.freeze([
  'cost:center:create', 'cost:center:update', 'cost:center:deactivate'
])
const operatorPermissions = [
  'system:menu:query', 'system:dept:create', 'system:dept:query', 'system:dept:delete',
  'system:role:create', 'system:role:query', 'system:role:update',
  'system:permission:assign-role-menu', 'system:permission:assign-role-data-scope',
  'system:permission:assign-user-role', ...readPermissions, ...writePermissions
]
const scopes = new WeakMap()
const completedRecords = new WeakSet()
const need = (condition, label) => {
  if (condition !== true) throw new Error(`COST-029: ${label}`)
}
const id = (value) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  need(/^[1-9]\d*$/.test(text) && BigInt(text) <= 9223372036854775807n, 'lossless ID required')
  return text
}
const data = (result, label) => {
  need(result?.code === 0 && result.success !== false && result.ok !== false, `${label}: formal API rejected`)
  return result.data
}
const truth = (result, label) => need(data(result, label) === true, `${label}: true readback required`)
const ids = (values) => {
  need(Array.isArray(values), 'ID set must be an array')
  const result = values.map(id).sort()
  need(new Set(result).size === result.length, 'duplicate IDs')
  return result
}
const equalIds = (left, right) => JSON.stringify(ids(left)) === JSON.stringify(ids(right))
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const quote = (value) => {
  // Hex literals keep markers, Unicode names and SQL mode out of string escaping.
  return `CONVERT(0x${Buffer.from(String(value)).toString('hex')} USING utf8mb4)`
}
const legacy = (row) => /__legacy__/.test(`${row.path || ''} ${row.component || ''}`)
const enabled = (row) => Number(row?.status) === 0 &&
  ![true, 1, '1', '\u0001'].includes(row?.deleted)
const profilePage = (row) => {
  const [component, query = ''] = String(row.component || '').split('?')
  let extra = {}
  if (row.query) {
    try { extra = typeof row.query === 'string' ? JSON.parse(row.query) : row.query } catch { return false }
  }
  return component.replace(/\.vue$/, '') === 'cost-management/section/index' &&
    (new URLSearchParams(query).get('page') || extra?.page) === 'profile'
}

export function resolveCostCenterPermissionMenus (menus, assignable) {
  need(Array.isArray(menus) && Array.isArray(assignable), 'formal menu arrays missing')
  const byId = new Map()
  for (const row of menus) {
    const key = id(row.id)
    need(!byId.has(key), 'ambiguous menu ID')
    byId.set(key, row)
  }
  const available = new Set(ids(assignable.map((row) => row.id)))
  const formalProfileRoute = (target) => {
    const paths = []
    const seen = new Set()
    let row = target
    while (row) {
      const key = id(row.id)
      need(!seen.has(key), 'profile navigation cycle')
      seen.add(key)
      if (legacy(row)) return false
      paths.unshift(String(row.path || '').split('?')[0].trim())
      if (String(row.parentId) === '0') break
      row = byId.get(id(row.parentId))
      need(Boolean(row), 'profile navigation ancestor absent')
    }
    const route = paths.reduce((parent, part) =>
      (part.startsWith('/') ? part : `${parent}/${part}`).replace(/\/+/g, '/'), '')
    return route === '/cost-management/modeling/profile'
  }
  const pages = menus.filter((row) => Number(row.type) === 2 && enabled(row) &&
    !legacy(row) && profilePage(row) && available.has(id(row.id)) && formalProfileRoute(row))
  need(pages.length === 1, 'assignable formal profile page missing or ambiguous; no menu/package repair')
  const planFor = (permissions) => {
    const selected = new Set()
    const addAncestors = (target, navigation) => {
      let row = target
      const seen = new Set()
      while (row) {
        const key = id(row.id)
        need(!seen.has(key) && enabled(row) && available.has(key), 'menu ancestor disabled/missing/outside package')
        need(!navigation || !legacy(row), 'formal navigation has legacy ancestry')
        need(!row.permission || permissions.includes(row.permission), 'menu ancestor carries extra permission')
        need(!row.permission?.includes('*'), 'wildcard menu permission')
        seen.add(key)
        selected.add(key)
        if (String(row.parentId) === '0') break
        row = byId.get(id(row.parentId))
        need(Boolean(row), 'menu ancestor absent')
      }
    }
    addAncestors(pages[0], true)
    for (const permission of permissions) {
      const buttons = menus.filter((row) => row.permission === permission &&
        Number(row.type) === 3 && enabled(row) && available.has(id(row.id)))
      need(buttons.length === 1, `assignable exact button missing or ambiguous: ${permission}`)
      // Match the service's normalization, including enabled hidden ancestry.
      addAncestors(buttons[0], false)
    }
    return { permissions: [...permissions], menuIds: [...selected].sort(), pageMenuId: id(pages[0].id) }
  }
  return {
    maintenance: planFor([...readPermissions, ...writePermissions]),
    readOnly: planFor(readPermissions)
  }
}

function check (caseRecord, name, passed, details = '') {
  caseRecord.checks ||= []
  caseRecord.checks.push({ name, passed: passed === true, details })
  need(passed === true, name)
}

function guard ({ record, caseRecord }, dependencies) {
  const settings = dependencies.config || config
  need(settings.target === 'local' && String(settings.tenantId) === '1' &&
    String(record?.environment?.tenantId) === '1' && caseRecord?.id === 'COST-029' &&
    typeof record.runId === 'string' && record.runId.length > 0, 'only local tenant1 COST-029/run')
  need(dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true', 'write flag required')
  for (const [key, port] of [['apiBase', '48083'], ['webBase', '9151']]) {
    const url = new URL(settings[key])
    need(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === port && !url.username && !url.password, 'local endpoint mismatch')
  }
  return settings
}

export async function preflightCostCenterPermissionClosure (input) {
  const { api, record, caseRecord, dependencies = {} } = input
  try {
    const settings = guard(input, dependencies)
    await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
    const info = data(await api.getBusiness('/system/auth/get-permission-info'), 'operator identity')
    id(info?.user?.id)
    need(Array.isArray(info.roles) && Array.isArray(info.permissions), 'operator permission info malformed')
    const systemOperator = info.roles.includes('super_admin') || info.roles.includes('tenant_admin')
    need(systemOperator || operatorPermissions.every((permission) => info.permissions.includes(permission)),
      'operator lacks current provisioning/cleanup rights; no privilege expansion')
    const plans = resolveCostCenterPermissionMenus(
      data(await api.getBusiness('/system/menu/list'), 'formal menus'),
      data(await api.getBusiness('/system/menu/list-all-simple'), 'tenant assignable menus')
    )
    const nonce = randomBytes(8).toString('hex')
    const marker = `CFOR-E2E:COST-029:${record.runId}:tenant=1:permission:${nonce}`
    const handle = Object.freeze({ marker })
    scopes.set(handle, {
      api, record, caseRecord, runId: record.runId, settings, plans, nonce, marker,
      used: false, secrets: []
    })
    caseRecord.costCenterPermissionClosure = {
      status: 'PREFLIGHT', runId: record.runId, tenantId: '1', marker,
      plans: structuredClone(plans), actors: [], denials: [], residuals: [], complete: false
    }
    check(caseRecord, COST_CENTER_PERMISSION_CHECKS.preflight, true, JSON.stringify(plans))
    return handle
  } catch (error) {
    caseRecord.checks ||= []
    caseRecord.notes ||= []
    caseRecord.costCenterPermissionClosure ||= {
      status: 'FAILED', runId: record?.runId || null, tenantId: '1',
      actors: [], denials: [], residuals: [], complete: false
    }
    caseRecord.costCenterPermissionClosure.status = 'FAILED'
    caseRecord.checks.push({
      name: COST_CENTER_PERMISSION_CHECKS.preflight,
      passed: false,
      details: String(error.message || error)
    })
    caseRecord.notes.push(`COST-029 预检失败，未创建部门、角色或账号：${String(error.message || error)}`)
    throw new Error(`COST-029 preflight failed: ${error.message || error}`)
  }
}

const safeText = (value, scope) => scope.secrets.filter(Boolean)
  .reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value))
  .replace(/((?:password|passwd|(?:access|refresh)?token|authorization)\s*[:=]\s*)[^,;\s]+/gi, '$1[REDACTED]')
const sanitized = (value, scope) => {
  const result = redact(value)
  const walk = (item) => {
    if (typeof item === 'string') return safeText(item, scope)
    if (Array.isArray(item)) return item.map(walk)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]))
  }
  return walk(result)
}

async function sqlRows (scope, sql) {
  const result = await scope.readSql(sql)
  need(result?.available === true && Array.isArray(result.rows), 'READONLY SQL unavailable')
  return result.rows
}

async function readFields (scope, table, where) {
  if (!scope.columns.has(table)) {
    const rows = await sqlRows(scope, `SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${quote(table)} ORDER BY ORDINAL_POSITION`)
    need(rows.length > 0 && rows.every((row) => row.length === 2 && /^[a-z_][a-z0-9_]*$/.test(row[0])),
      `${table}: full-field schema missing`)
    need(rows.some(([key]) => key === 'id') && rows.some(([key]) => key === 'tenant_id') &&
      rows.some(([key]) => key === 'deleted'), `${table}: identity schema missing`)
    need(new Set(rows.map(([key]) => key)).size === rows.length, `${table}: ambiguous schema`)
    scope.columns.set(table, rows)
  }
  const columns = scope.columns.get(table)
  const fields = columns.map(([key, type]) => `${quote(key)},` +
    (type.toLowerCase() === 'bit' ? `CAST(\`${key}\` AS UNSIGNED)` : `CAST(\`${key}\` AS CHAR)`))
  const rows = await sqlRows(scope, `SELECT JSON_OBJECT(${fields.join(',')}) FROM \`${table}\`
    WHERE tenant_id=1 AND (${where}) ORDER BY id`)
  return rows.map((row) => {
    need(row.length === 1, `${table}: full-field JSON malformed`)
    const value = JSON.parse(row[0])
    need(Object.keys(value).length === columns.length && columns.every(([key]) =>
      Object.hasOwn(value, key)), `${table}: incomplete SQL fields`)
    need(id(value.tenant_id) === '1', `${table}: tenant identity drift`)
    return value
  })
}

function centerFact (scope, row) {
  const center = scope.activeCenter
  need(row && id(row.id) === center.id && String(row.accountingOrgId) === '1' &&
    row.code === center.code && row.name === center.name && row.remark === scope.marker &&
    row.enabledAt === center.enabledAt && row.status === 'ENABLED' && row.disabledAt == null &&
    Number(row.referenceCount) === 0 && row.referenceCount != null &&
    row.departmentCount === 1 && equalIds(row.departmentIds, [scope.department.id]) &&
    Array.isArray(row.departmentNames) && row.departmentNames.length === 1 &&
    row.departmentNames[0] === scope.department.name, 'active center ownership/state/reference/department drift')
  return row
}

async function snapshot (scope, { retainInvalid = false } = {}) {
  const center = data(await scope.api.getBusiness(
    `/cost/centers/${scope.activeCenter.id}`), 'active center detail')
  const department = data(await scope.api.getBusiness(
    `/system/dept/get?id=${scope.department.id}`), 'owned department')
  const ownedIds = scope.ownedCenters.map((row) => row.id).join(',')
  const centers = await readFields(scope, 'cost_center',
    `id IN (${ownedIds}) OR center_code=${quote(scope.probeCode)}`)
  const relations = await readFields(scope, 'cost_center_dept_rel',
    `dept_id=${scope.department.id} OR cost_center_id IN (${ownedIds})`)
  const departments = await readFields(scope, 'system_dept',
    `id=${scope.department.id} AND name=${quote(scope.department.name)} AND code=${quote(scope.department.name)}`)
  const result = {
    apiHash: hash({ center, department }), sqlHash: hash({ centers, relations, departments }),
    rowCounts: { centers: centers.length, relations: relations.length, departments: departments.length },
    valid: false
  }
  try {
    centerFact(scope, center)
    need(department && id(department.id) === scope.department.id &&
      department.name === scope.department.name && department.code === scope.department.name &&
      Number(department.status) === 0, 'owned department invisible/identity drift (SELF is not bypassed)')
    need(departments.length === 1 && id(departments[0].id) === scope.department.id &&
      Number(departments[0].status) === 0 && Number(departments[0].deleted) === 0, 'SQL department ownership empty/drift')
    need(centers.length === scope.ownedCenters.length && relations.length > 0,
      'owned SQL facts empty/missing or rejected create persisted')
    for (const owned of scope.ownedCenters) {
      const rows = centers.filter((row) => id(row.id) === owned.id)
      need(rows.length === 1 && rows[0].accounting_org_id === '1' &&
        rows[0].center_code === owned.code && rows[0].center_name === owned.name &&
        rows[0].remark === scope.marker && Number(rows[0].deleted) === 0, 'SQL center ownership drift')
    }
    need(relations.every((row) => id(row.dept_id) === scope.department.id &&
      scope.ownedCenters.some((owned) => owned.id === id(row.cost_center_id))), 'SQL relationship foreign ownership')
    const activeSql = centers.find((row) => id(row.id) === scope.activeCenter.id)
    const activeRelations = relations.filter((row) => id(row.cost_center_id) === scope.activeCenter.id &&
      Number(row.deleted) === 0)
    need(activeSql.status === 'ENABLED' && activeSql.effective_from === center.enabledAt &&
      activeSql.effective_to == null && activeRelations.length === 1 &&
      activeRelations[0].effective_from === center.enabledAt && activeRelations[0].effective_to == null,
    'API/SQL active period mismatch')
    result.valid = true
  } catch (error) {
    if (!retainInvalid) throw error
    result.validationFailure = safeText(error.message || error, scope)
  }
  return result
}

function roleIdentity (scope, actor, row, status) {
  need(row && id(row.id) === actor.roleId && row.name === actor.rolePayload.name &&
    row.code === actor.rolePayload.code && row.remark === actor.rolePayload.remark &&
    Number(row.type) === 2 && Number(row.status) === status, 'dedicated role identity/status drift')
}

async function verifyRole (scope, actor) {
  const row = data(await scope.api.getBusiness(`/system/role/get?id=${actor.roleId}`), 'CUSTOM role readback')
  roleIdentity(scope, actor, row, 0)
  need(Number(row.dataScope) === 2 && equalIds(row.dataScopeDeptIds, [scope.department.id]),
    'CUSTOM scope persistence mismatch; no ALL fallback')
  const stored = await sqlRows(scope, `SELECT id,code,remark,data_scope,JSON_LENGTH(data_scope_dept_ids),
    JSON_UNQUOTE(JSON_EXTRACT(data_scope_dept_ids,'$[0]')),status,type,
    CAST(deleted AS UNSIGNED),tenant_id FROM system_role
    WHERE tenant_id=1 AND id=${actor.roleId} AND code=${quote(actor.rolePayload.code)}
    AND remark=${quote(actor.rolePayload.remark)}`)
  need(stored.length === 1 && stored[0].length === 10, 'role SQL ownership missing')
  const [key, code, marker, range, deptCount, dept, status, type, deleted, tenant] = stored[0]
  need(id(key) === actor.roleId && code === actor.rolePayload.code && marker === actor.rolePayload.remark &&
    range === '2' && deptCount === '1' && id(dept) === scope.department.id &&
    status === '0' && type === '2' && deleted === '0' && tenant === '1', 'role SQL CUSTOM ownership/persistence drift')
  const menus = data(await scope.api.getBusiness(
    `/system/permission/list-role-menus?roleId=${actor.roleId}`), 'role menu readback')
  need(equalIds(menus, actor.plan.menuIds), 'role menu readback differs from exact preflight intersection')
}

async function userFact (scope, actor, status) {
  const row = data(await scope.api.getBusiness(`/system/user/get?id=${actor.userId}`), 'actor user readback')
  need(row && id(row.id) === actor.userId && row.username === actor.username &&
    row.nickname === actor.nickname && row.remark === actor.marker &&
    id(row.deptId) === scope.department.id && Number(row.status) === status, 'dedicated user identity/status drift')
}

async function createActor (scope, key) {
  const plan = scope.plans[key]
  const short = key === 'maintenance' ? 'm' : 'r'
  const actor = {
    key, plan, marker: `${scope.marker}:${key}`, username: `e2ecc${short}${scope.nonce}`,
    nickname: `E2E CC ${short} ${scope.nonce}`,
    rolePayload: { name: `E2E CC ${short} ${scope.nonce}`, code: `e2e_cc_${key}_${scope.nonce}`,
      sort: 9999, status: 0, remark: `${scope.marker}:${key}` }
  }
  scope.actors.push(actor)
  const ledger = { key, username: actor.username, marker: actor.marker, dataScope: 2,
    departmentIds: [scope.department.id], menuIds: plan.menuIds, permissions: plan.permissions,
    cleanup: {}, loginCount: 0, retainedForAudit: true }
  actor.ledger = ledger
  scope.evidence.actors.push(ledger)
  ledger.roleCreateAttempted = true
  actor.roleId = id(data(await scope.api.postBusiness('/system/role/create', actor.rolePayload), 'role create'))
  ledger.roleId = actor.roleId
  roleIdentity(scope, actor, data(await scope.api.getBusiness(
    `/system/role/get?id=${actor.roleId}`), 'new role ownership'), 0)
  truth(await scope.api.postBusiness('/system/permission/assign-role-menu',
    { roleId: actor.roleId, menuIds: plan.menuIds }), 'role menu assign')
  truth(await scope.api.postBusiness('/system/permission/assign-role-data-scope', {
    roleId: actor.roleId, dataScope: 2, dataScopeDeptIds: [scope.department.id]
  }), 'CUSTOM scope assign (SELF filtered departments remain a failure)')
  await verifyRole(scope, actor)
  const password = `Cc!${randomBytes(4).toString('hex')}Aa9`
  scope.secrets.push(password)
  ledger.userCreateAttempted = true
  actor.userId = id(data(await scope.api.postBusiness('/system/user/create', {
    username: actor.username, nickname: actor.nickname, password, sex: 0, postIds: [],
    deptId: scope.department.id, remark: actor.marker, roleIds: []
  }), 'actor user create'))
  ledger.userId = actor.userId
  await userFact(scope, actor, 0)
  // Scope and role ownership must already be persistent before binding the user.
  await verifyRole(scope, actor)
  truth(await scope.api.postBusiness('/system/permission/assign-user-role',
    { userId: actor.userId, roleIds: [actor.roleId] }), 'actor role assign')
  need(equalIds(data(await scope.api.getBusiness(
    `/system/permission/list-user-roles?userId=${actor.userId}`), 'user role readback'), [actor.roleId]),
  'actor has extra/missing roles')
  const browser = scope.adminPage.context().browser()
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' })
  need(context !== scope.adminPage.context() &&
    !scope.actors.some((other) => other !== actor && other.context === context), 'actor contexts not independent')
  actor.context = context
  actor.context.setDefaultTimeout(scope.settings.browserTimeoutMs || 30000)
  actor.page = await actor.context.newPage()
  need(actor.page.url() === 'about:blank', 'actor login requires a fresh blank page')
  // Never start tracing or dump the login DOM: Playwright traces include credentials.
  actor.audit = { api: [], pageErrors: [], consoleErrors: [], consoleErrorDetails: [],
    requestFailures: [], failedApiResponses: [] }
  actor.observer = (scope.dependencies.observePage || observePage)(actor.page, actor.audit)
  ledger.loginCount = 1
  const auth = await (scope.dependencies.loginWithCredentials || loginWithCredentials)(
    actor.page, { tenantName: scope.settings.tenantName, username: actor.username, password },
    { returnContext: true }
  )
  if (auth?.token) scope.secrets.push(auth.token)
  if (auth?.refreshToken) scope.secrets.push(auth.refreshToken)
  need(typeof auth?.token === 'string' && auth.token.length > 0 && String(auth.tenantId) === '1',
    'actor browser login tenant/session mismatch')
  actor.client = (scope.dependencies.createApiClient || createApiClient)(
    { token: auth.token, tenantId: '1', record: actor.audit })
  const info = data(await actor.client.getBusiness('/system/auth/get-permission-info'), 'actor permission info')
  need(info?.user && id(info.user.id) === actor.userId && info.user.username === actor.username &&
    id(info.user.deptId) === scope.department.id &&
    (info.user.tenantId == null || String(info.user.tenantId) === '1') &&
    Array.isArray(info.roles) && info.roles.length === 1 && info.roles[0] === actor.rolePayload.code &&
    Array.isArray(info.permissions) &&
    hash([...info.permissions].filter(Boolean).sort()) === hash([...plan.permissions].sort()),
  'actor actual identity/permissions exceed or miss the minimal plan')
  const visibleMenus = []
  const flattenMenus = (rows) => {
    need(Array.isArray(rows), 'actor formal navigation malformed')
    for (const row of rows) {
      visibleMenus.push(id(row.id))
      if (row.children) flattenMenus(row.children)
    }
  }
  flattenMenus(info.menus)
  need(visibleMenus.includes(plan.pageMenuId), 'actor formal profile page not granted')
  const centers = data(await actor.client.getBusiness('/cost/centers?accountingOrgId=1'), 'actor centers')
  need(Array.isArray(centers) && centers.filter((row) => id(row.id) === scope.activeCenter.id).length === 1,
    'actor center list missing/ambiguous')
  centerFact(scope, centers.find((row) => id(row.id) === scope.activeCenter.id))
  const actorCenter = centerFact(scope, data(await actor.client.getBusiness(
    `/cost/centers/${scope.activeCenter.id}`), 'actor active detail'))
  const adminCenter = centerFact(scope, data(await scope.api.getBusiness(
    `/cost/centers/${scope.activeCenter.id}`), 'admin active detail'))
  need(hash(actorCenter) === hash(adminCenter), 'actor/admin center detail mismatch')
  const departments = data(await actor.client.getBusiness('/cost/centers/departments'), 'CUSTOM actor departments')
  const found = []
  const walk = (rows) => {
    need(Array.isArray(rows), 'actor department tree malformed')
    for (const row of rows) {
      if (id(row.id) === scope.department.id) found.push(row)
      if (row.children) walk(row.children)
    }
  }
  walk(departments)
  need(found.length === 1 && found[0].name === scope.department.name &&
    found[0].code === scope.department.id && Number(found[0].status) === 0,
  'CUSTOM actor department invisible/identity drift; stop without authorization fallback')
  ledger.identityVerified = true
  actor.page.on('request', (request) => {
    if (/\/(?:admin|app)-api\//.test(request.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      actor.pageWrites ||= []
      actor.pageWrites.push({ method: request.method(), path: new URL(request.url()).pathname, request })
    }
  })
  return actor
}

async function visibleUnique (locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 30000 })
  need(await locator.count() === 1, `${label}: missing/ambiguous DOM`)
}

async function enabledUnique (locator, label, timeoutMs) {
  await visibleUnique(locator, label)
  const deadline = Date.now() + Math.min(timeoutMs || 30000, 30000)
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  need(false, `${label} disabled after formal page finished loading`)
}

export async function verifyCostCenterPermissionPage ({ scope, actor, outputDir }) {
  const page = actor.page
  const capture = async (stage) => {
    need(Boolean(outputDir), 'screenshot output directory required')
    await page.bringToFront()
    const screenshot = await (scope.dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, `cost-029-${actor.key}-${stage}`, scope.record)
    need(typeof screenshot === 'string' && screenshot.length > 0, 'screenshot missing')
    actor.ledger.screenshots ||= []
    actor.ledger.screenshots.push(screenshot)
  }
  const select = async () => {
    need(new URL(page.url()).pathname === '/cost-management/modeling/profile', 'formal page route mismatch')
    const entry = page.getByRole('button', { name: '管理成本中心', exact: true })
    await visibleUnique(entry, 'management entry')
    await entry.click()
    const dialog = page.locator('.cost-center-management-dialog:visible')
    await visibleUnique(dialog, 'management dialog')
    await dialog.locator('.center-search input').fill(scope.activeCenter.code)
    const node = dialog.locator('.center-tree').getByText(scope.activeCenter.name, { exact: true })
    await visibleUnique(node, 'owned center tree node')
    await node.click()
    const summary = dialog.locator('.center-summary')
    for (const text of [scope.activeCenter.name, scope.activeCenter.code, scope.activeCenter.enabledAt,
      '已启用', '0 笔']) {
      await visibleUnique(summary.getByText(text, { exact: true }), `owned center DOM: ${text}`)
    }
    need((await dialog.locator('.department-panel .el-table').getByText(
      scope.department.name, { exact: true }).count()) > 0, 'owned department DOM missing')
    const controls = [
      ['新增', '新增成本中心', '.cost-center-editor-dialog:visible', 'create'],
      ['编辑成本中心', '编辑成本中心', '.cost-center-editor-dialog:visible', 'update'],
      ['停用', '停用成本中心', '.cost-center-deactivate-dialog:visible', 'deactivate']
    ]
    for (const [label, title, selector, action] of controls) {
      const button = dialog.getByRole('button', { name: label, exact: true })
      if (actor.key === 'readOnly') {
        need(await button.count() === 0, `readOnly ${action} button must be absent, not disabled`)
        continue
      }
      await enabledUnique(button, `maintenance ${action}`, scope.settings.browserTimeoutMs)
      await button.click()
      const child = page.locator(selector)
      await visibleUnique(child, `${action} editor`)
      await visibleUnique(child.getByText(title, { exact: true }), `${action} title`)
      if (action === 'update') {
        const code = child.locator('.el-form-item').filter({ hasText: '成本中心编码' }).locator('input')
        need(await code.inputValue() === scope.activeCenter.code && await code.isDisabled(),
          'edit dialog code identity/immutability mismatch')
        need((await child.getByText(scope.department.name, { exact: true }).count()) > 0,
          'edit dialog department missing')
      }
      if (action === 'deactivate') {
        need((await child.getByText(scope.activeCenter.name, { exact: true }).count()) > 0,
          'deactivate dialog center missing')
      }
      await capture(action)
      await child.getByRole('button', { name: '取消', exact: true }).click()
      await child.waitFor({ state: 'hidden', timeout: 30000 })
    }
    await capture('readback')
  }
  await page.bringToFront()
  await (scope.dependencies.openRoute || openRoute)(page, '/cost-management/modeling/profile',
    { readySelector: '.page-head h1', readyTimeoutMs: 30000 })
  await select()
  await page.bringToFront()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.page-head h1').waitFor({ state: 'visible', timeout: 30000 })
  await select()
  await actor.observer.flushResponses()
  need(!actor.pageWrites?.length, 'open/cancel/refresh unexpectedly sent a write request')
  need(['pageErrors', 'consoleErrors', 'requestFailures', 'failedApiResponses'].every((key) =>
    actor.audit[key].length === 0), 'formal page DOM/API/console failure cannot be a GAP')
  actor.ledger.pageVerified = true
  actor.ledger.refreshed = true
}

async function verifyCostCenterBrowserSave (scope, actor, outputDir) {
  const page = actor.page
  const center = scope.activeCenter
  const expected = {
    accountingOrgId: 1, code: center.code, name: center.name, enabledAt: center.enabledAt,
    departmentIds: [scope.department.id], remark: scope.marker
  }
  const unchangedFields = (row, excluded) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.includes(key)))
  const read = async () => ({
    center: centerFact(scope, data(await scope.api.getBusiness(`/cost/centers/${center.id}`), 'UI save center')),
    centers: await readFields(scope, 'cost_center', `id IN (${scope.ownedCenters.map((row) => row.id).join(',')})`),
    relations: await readFields(scope, 'cost_center_dept_rel', `cost_center_id=${center.id}`),
    departments: await readFields(scope, 'system_dept', `id=${scope.department.id}`)
  })
  const before = await read()
  need(before.relations.length === 1 && Number(before.relations[0].deleted) === 0,
    'UI save requires exactly one owned active relation')
  const writePath = `/admin-api/cost/centers/${center.id}`
  const matcher = /\/admin-api\/cost\/centers(?:[/?]|$)/
  let guardedRequests = 0
  let guardFailure
  const handler = async (route) => {
    const request = route.request()
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue()
    try {
      need(request.method() === 'PUT' && new URL(request.url()).pathname === writePath &&
        guardedRequests === 0 && hash(request.postDataJSON()) === hash(expected),
      'UI save may only send one exact owned update with string department ID')
      guardedRequests++
      return await route.continue()
    } catch (error) {
      guardFailure = String(error.message || error)
      await route.abort('blockedbyclient')
    }
  }
  await page.route(matcher, handler)
  try {
    await page.bringToFront()
    await (scope.dependencies.openRoute || openRoute)(page, '/cost-management/modeling/profile',
      { readySelector: '.page-head h1', readyTimeoutMs: 30000 })
    const select = async () => {
      await page.getByRole('button', { name: '管理成本中心', exact: true }).click()
      const dialog = page.locator('.cost-center-management-dialog:visible')
      await visibleUnique(dialog, 'UI save management dialog')
      await dialog.locator('.center-search input').fill(center.code)
      await dialog.locator('.center-tree').getByText(center.name, { exact: true }).click()
      return dialog
    }
    const dialog = await select()
    await dialog.getByRole('button', { name: '编辑成本中心', exact: true }).click()
    const editor = page.locator('.cost-center-editor-dialog:visible')
    await visibleUnique(editor, 'UI save editor')
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname === writePath,
    { timeout: 30000 })
    const [response] = await Promise.all([
      responsePromise, editor.getByRole('button', { name: '保存', exact: true }).click()
    ])
    need(!guardFailure && guardedRequests === 1 && response.status() === 200,
      guardFailure || 'UI save guarded request/HTTP mismatch')
    need(hash(response.request().postDataJSON()) === hash(expected),
      'UI save transmitted a rounded department ID or changed business fields')
    centerFact(scope, data(await response.json(), 'UI save response'))
    await editor.waitFor({ state: 'hidden', timeout: 30000 })
    await actor.observer.flushResponses()
    const writes = actor.pageWrites || []
    need(writes.length === 1 && writes[0].request === response.request(),
      'UI save sent unexpected page writes')
    const after = await read()
    need(hash(unchangedFields(before.center, ['updateTime'])) ===
      hash(unchangedFields(after.center, ['updateTime'])), 'UI save changed center business values')
    need(before.centers.length === after.centers.length && before.centers.every((row) => {
      const current = after.centers.find((item) => id(item.id) === id(row.id))
      return current && hash(unchangedFields(row, ['updater', 'update_time'])) ===
        hash(unchangedFields(current, ['updater', 'update_time']))
    }) && hash(before.departments) === hash(after.departments),
    'UI save changed center ownership or department facts')
    const old = after.relations.find((row) => id(row.id) === id(before.relations[0].id))
    const active = after.relations.filter((row) => Number(row.deleted) === 0)
    need(after.relations.length === 2 && old && Number(old.deleted) === 1 &&
      hash(unchangedFields(old, ['deleted', 'updater', 'update_time'])) ===
      hash(unchangedFields(before.relations[0], ['deleted', 'updater', 'update_time'])) &&
      active.length === 1 && id(active[0].id) !== id(old.id) &&
      id(active[0].tenant_id) === '1' && id(active[0].cost_center_id) === center.id &&
      id(active[0].dept_id) === scope.department.id &&
      active[0].effective_from === center.enabledAt && active[0].effective_to == null,
    'UI save relation replacement lost identity, period or preserved history')
    actor.uiSaveWrite = writes[0]
    const savedSnapshot = await snapshot(scope)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.page-head h1').waitFor({ state: 'visible', timeout: 30000 })
    const refreshed = await select()
    await visibleUnique(refreshed.locator(
      '.department-table .el-table__body-wrapper tr.el-table__row td:nth-child(3)').getByText(
      scope.department.name, { exact: true }), 'UI saved department refresh')
    const refreshedSnapshot = await snapshot(scope)
    need(savedSnapshot.apiHash === refreshedSnapshot.apiHash &&
      savedSnapshot.sqlHash === refreshedSnapshot.sqlHash, 'UI save refresh changed persisted facts')
    await page.bringToFront()
    const screenshot = await (scope.dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, 'cost-029-maintenance-saved-refresh', scope.record)
    need(typeof screenshot === 'string' && screenshot.length > 0, 'UI save screenshot missing')
    scope.evidence.uiSave = {
      method: 'PUT', path: writePath, departmentIds: expected.departmentIds,
      guardedRequests, oldRelationId: id(old.id), activeRelationId: id(active[0].id),
      beforeApiHash: hash(before.center), afterApiHash: hash(after.center),
      savedSnapshot, refreshedSnapshot, screenshot, verified: true
    }
    check(scope.caseRecord, COST_CENTER_PERMISSION_CHECKS.uiSave, true,
      JSON.stringify(scope.evidence.uiSave))
  } finally {
    await page.unroute(matcher, handler)
  }
}

async function cleanupActors (scope) {
  const failures = []
  for (const actor of scope.actors) {
    const attempt = async (label, fn) => {
      try {
        await fn()
        actor.ledger.cleanup[label] = true
      } catch (error) {
        const reason = safeText(error.message || error, scope)
        actor.ledger.cleanup[label] = false
        failures.push(`${actor.key}/${label}: ${reason}`)
        scope.evidence.residuals.push({ key: actor.key, userId: actor.userId, roleId: actor.roleId, step: label, reason })
      }
    }
    for (const kind of ['role', 'user']) {
      if (actor[`${kind}Id`] || !actor.ledger[`${kind}CreateAttempted`]) continue
      await attempt(`${kind}CreateResolved`, async () => {
        // Resolve an uncertain create outcome only for cleanup, never provisioning.
        const rows = await sqlRows(scope, kind === 'role'
          ? `SELECT id FROM system_role WHERE tenant_id=1 AND code=${quote(actor.rolePayload.code)}
              AND remark=${quote(actor.marker)} AND deleted=b'0'`
          : `SELECT id FROM system_users WHERE tenant_id=1 AND username=${quote(actor.username)}
              AND remark=${quote(actor.marker)} AND dept_id=${scope.department.id} AND deleted=b'0'`)
        need(rows.length <= 1 && rows.every((row) => row.length === 1), 'uncertain creation identity ambiguous')
        actor.ledger[`${kind}CreateAbsent`] = rows.length === 0
        if (rows.length === 1) {
          actor[`${kind}Id`] = id(rows[0][0])
          actor.ledger[`${kind}Id`] = actor[`${kind}Id`]
        }
      })
    }
    if (actor.observer) await attempt('responses', async () => {
      await actor.observer.flushResponses()
      need(['pageErrors', 'consoleErrors', 'requestFailures', 'failedApiResponses'].every((key) =>
        actor.audit[key].length === 0) &&
        !(actor.pageWrites || []).some((write) => write !== actor.uiSaveWrite),
      'actor browser runtime failure')
    })
    if (actor.ledger.loginCount === 1) await attempt('logout', async () => {
      need(Boolean(actor.client), 'login failed before usable session handoff; logout not proven')
      truth(await actor.client.postBusiness('/system/auth/logout'), 'formal actor logout')
    })
    if (actor.userId) {
      await attempt('sessionsCleared', async () => {
        const rows = await sqlRows(scope, `SELECT 'access',COUNT(*) FROM system_oauth2_access_token
          WHERE tenant_id=1 AND user_id=${actor.userId} AND deleted=b'0'
          UNION ALL SELECT 'refresh',COUNT(*) FROM system_oauth2_refresh_token
          WHERE tenant_id=1 AND user_id=${actor.userId} AND deleted=b'0'`)
        need(rows.length === 2 && rows[0][0] === 'access' && rows[0][1] === '0' &&
          rows[1][0] === 'refresh' && rows[1][1] === '0', 'dedicated actor sessions remain or SQL malformed')
      })
      await attempt('userDisabled', async () => {
        await userFact(scope, actor, 0)
        truth(await scope.api.putBusiness('/system/user/update-status',
          { id: actor.userId, status: 1 }), 'dedicated user disable')
        await userFact(scope, actor, 1)
      })
    }
    if (actor.roleId) await attempt('roleDisabled', async () => {
      roleIdentity(scope, actor, data(await scope.api.getBusiness(
        `/system/role/get?id=${actor.roleId}`), 'cleanup role ownership'), 0)
      truth(await scope.api.putBusiness('/system/role/update',
        { ...actor.rolePayload, id: actor.roleId, status: 1 }), 'dedicated role disable')
      roleIdentity(scope, actor, data(await scope.api.getBusiness(
        `/system/role/get?id=${actor.roleId}`), 'disabled role readback'), 1)
    })
    if (actor.context) await attempt('contextClosed', () => actor.context.close())
    if (actor.audit) {
      for (const key of Object.keys(actor.audit)) {
        scope.record[key] ||= []
        scope.record[key].push(...sanitized(actor.audit[key], scope))
      }
    }
  }
  check(scope.caseRecord, COST_CENTER_PERMISSION_CHECKS.cleanup,
    failures.length === 0 && scope.actors.length === 2 &&
      scope.actors.every((actor) => actor.ledger.cleanup.logout === true &&
        actor.ledger.cleanup.sessionsCleared === true && actor.ledger.cleanup.userDisabled === true &&
        actor.ledger.cleanup.roleDisabled === true && actor.ledger.cleanup.contextClosed === true),
  failures.join('; ') || 'dedicated users/roles retained disabled for audit; no shared identity changed')
}

export const hasCostCenterPermissionEvidence = (caseRecord) => completedRecords.has(caseRecord) &&
  caseRecord.costCenterPermissionClosure?.complete === true

export async function runCostCenterPermissionClosure ({
  preflight, api, record, caseRecord, page, department, activeCenter, ownedCenters, outputDir,
  dependencies = {}
}) {
  const scope = scopes.get(preflight)
  if (!scope || scope.api !== api || scope.record !== record || scope.caseRecord !== caseRecord || scope.used) {
    caseRecord.checks ||= []
    caseRecord.checks.push({
      name: 'COST-029 私有nonce/run所有权无效不得接受权限证据',
      passed: false, details: 'private nonce/run ownership missing, changed or reused'
    })
    if (caseRecord.costCenterPermissionClosure) {
      caseRecord.costCenterPermissionClosure.complete = false
      caseRecord.costCenterPermissionClosure.status = 'FAILED'
    }
    throw new Error('COST-029: private nonce/run ownership missing, changed or reused')
  }
  scope.used = true
  scope.dependencies = dependencies
  scope.actors = []
  scope.columns = new Map()
  scope.readSql = dependencies.runReadOnlySql || runReadOnlySql
  scope.evidence = caseRecord.costCenterPermissionClosure
  scope.adminPage = page
  let failure
  try {
    guard({ record, caseRecord }, dependencies)
    need(record.runId === scope.runId && scope.evidence.runId === scope.runId &&
      scope.evidence.tenantId === '1' && preflight.marker === scope.marker &&
      scope.evidence.marker === scope.marker, 'private nonce/run marker drift')
    need(department === caseRecord.fixtures?.costDepartment &&
      department?.marker === `CFOR-E2E:COST-029:${record.runId}:tenant=1:department` &&
      /^E2E-COST-029-[a-f0-9]{12}$/.test(department.name), 'department not registered to this run')
    scope.department = { ...department, id: id(department.id) }
    need(Array.isArray(ownedCenters) && ownedCenters.length === 2, 'two existing-chain centers required')
    scope.ownedCenters = ownedCenters.map((row) => {
      need(row.remark === scope.marker && /^E2E-CC2?-/.test(row.code), 'center nonce ownership missing')
      return { ...row, id: id(row.id) }
    })
    need(new Set(scope.ownedCenters.map((row) => row.id)).size === 2, 'duplicate owned centers')
    scope.activeCenter = { ...activeCenter, id: id(activeCenter.id) }
    need(scope.ownedCenters.some((row) => row.id === scope.activeCenter.id &&
      row.code === scope.activeCenter.code && row.name === scope.activeCenter.name),
    'active center not in this run existing chain')
    scope.probeCode = `E2E-CCP-${scope.nonce}`
    scope.evidence.departmentId = scope.department.id
    scope.evidence.activeCenterId = scope.activeCenter.id
    scope.evidence.baseline = await snapshot(scope)
    check(caseRecord, COST_CENTER_PERMISSION_CHECKS.ownership, true, JSON.stringify(scope.evidence.baseline))
    for (const key of ['maintenance', 'readOnly']) await createActor(scope, key)
    check(caseRecord, COST_CENTER_PERMISSION_CHECKS.actors, true, 'exact menus, role ownership, CUSTOM persistence before assignment; one login/context per actor')
    for (const actor of scope.actors) {
      const before = await snapshot(scope)
      let pageFailure
      try { await verifyCostCenterPermissionPage({ scope, actor, outputDir }) } catch (error) {
        pageFailure = safeText(error.message || error, scope)
      }
      let after
      let readbackFailure
      try { after = await snapshot(scope, { retainInvalid: true }) } catch (error) {
        readbackFailure = safeText(error.message || error, scope)
      }
      actor.ledger.pageSnapshot = { before, after: after || null, pageFailure, readbackFailure }
      check(caseRecord, COST_CENTER_PERMISSION_CHECKS[actor.key], !pageFailure && !readbackFailure &&
        after?.valid === true && before.apiHash === after.apiHash && before.sqlHash === after.sqlHash,
      JSON.stringify({ userId: actor.userId, ...actor.ledger.pageSnapshot,
        refresh: actor.ledger.refreshed === true, screenshots: actor.ledger.screenshots?.length || 0 }))
    }
    const reader = scope.actors.find((actor) => actor.key === 'readOnly')
    const common = { accountingOrgId: 1, code: scope.activeCenter.code, name: scope.activeCenter.name,
      enabledAt: scope.activeCenter.enabledAt, departmentIds: [scope.department.id], remark: scope.marker }
    scope.evidence.createProbe = {
      code: scope.probeCode, departmentId: scope.department.id, departmentAlreadyAssigned: true,
      requiredRejection: '403/没有该操作权限',
      note: 'Bean-valid owned request; existing active department overlap (422001) is not permission evidence'
    }
    const requests = [
      ['create', 'POST', '/cost/centers', { ...common, code: scope.probeCode, name: scope.probeCode }],
      ['update', 'PUT', `/cost/centers/${scope.activeCenter.id}`, common],
      ['deactivate', 'POST', `/cost/centers/${scope.activeCenter.id}/deactivate`,
        { disabledAt: scope.activeCenter.enabledAt, reason: scope.marker }]
    ]
    for (const [key, method, path, payload] of requests) {
      const before = await snapshot(scope)
      const entry = { key, method, path, code: null, rejected: false, unchanged: false, before, after: null }
      scope.evidence.denials.push(entry)
      let response
      let requestFailure
      try {
        response = await reader.client.request(method, path, payload, {
          expectedBusinessRejection: { code: 403, message: '没有该操作权限', allowServiceCode: true }
        })
      } catch (error) { requestFailure = error }
      let after
      let readbackFailure
      try { after = await snapshot(scope, { retainInvalid: true }) } catch (error) {
        readbackFailure = safeText(error.message || error, scope)
      }
      const messages = [response?.msg, response?.message].filter((value) => typeof value === 'string' && value.length > 0)
      const rejected = !requestFailure && response?.code === 403 && response.data == null &&
        response.ok !== true && response.success !== true && messages.length > 0 &&
        messages.every((message) => message === '没有该操作权限')
      const unchanged = after?.valid === true && !readbackFailure &&
        before.apiHash === after.apiHash && before.sqlHash === after.sqlHash
      Object.assign(entry, { code: response?.code ?? null, rejected, unchanged, after: after || null,
        requestFailure: requestFailure ? safeText(requestFailure.message, scope) : undefined, readbackFailure })
      check(caseRecord, COST_CENTER_PERMISSION_CHECKS[key], rejected && unchanged, JSON.stringify(entry))
    }
    await verifyCostCenterBrowserSave(scope, scope.actors.find((actor) => actor.key === 'maintenance'), outputDir)
    scope.evidence.status = 'VERIFIED_PENDING_CLEANUP'
  } catch (error) {
    failure = safeText(error.message || error, scope)
    caseRecord.checks.push({ name: 'COST-029 权限闭环异常不得转PARTIAL或PASS', passed: false, details: failure })
    scope.evidence.status = 'FAILED'
  } finally {
    try { await cleanupActors(scope) } catch (error) {
      failure = [failure, safeText(error.message || error, scope)].filter(Boolean).join('; ')
    }
    // Admin API may include an echoed credential in a failure message.
    for (const key of ['api', 'consoleErrors', 'consoleErrorDetails', 'pageErrors', 'failedApiResponses', 'requestFailures']) {
      if (record[key]) record[key] = sanitized(record[key], scope)
    }
    scope.evidence.complete = !failure
    scope.evidence.status = failure ? 'FAILED' : 'VERIFIED'
  }
  if (failure) throw new Error(`COST-029 permission closure failed: ${failure}`)
  completedRecords.add(caseRecord)
  return scope.evidence
}
