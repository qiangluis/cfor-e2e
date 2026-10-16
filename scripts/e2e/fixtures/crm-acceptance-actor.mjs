import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { launchBrowser, loginWithCredentials } from '../lib/browser.mjs'

const freezeProfile = (permissions, pageComponents) => Object.freeze({
  permissions: Object.freeze([...permissions]),
  navPermissions: Object.freeze(['system:settings:query']),
  pageComponents: Object.freeze([...pageComponents])
})

export const CRM_ACTOR_CASE_PROFILES = Object.freeze({
  'CRM-BASE-001': freezeProfile([
    'crm:customer:create', 'crm:customer:query', 'crm:customer:delete',
    'crm:business:create', 'crm:business:query', 'crm:business:update', 'crm:business:delete',
    'crm:business-status:query',
    'system:dict:query', 'system:dict:create', 'system:dict:update', 'system:dict:delete'
  ], ['crm/business/status/index']),
  'CRM-BASE-002': freezeProfile([
    'crm:intention-rule:update', 'crm:intention-rule:query',
    'crm:customer:create', 'crm:customer:query', 'crm:customer:update', 'crm:customer:delete',
    'crm:business:query',
    'system:dict:query'
  ], ['crm/jixu/privatePool/index?archive=all']),
  'CRM-BASE-003': freezeProfile([
    'crm:customer:create', 'crm:customer:query', 'crm:customer:delete',
    'crm:customer-tag:query', 'crm:customer-tag:update'
  ], ['crm/config/customerTag/index']),
  'CRM-BASE-005': freezeProfile([
    'crm:customer:create', 'crm:customer:query', 'crm:customer:delete',
    'crm:business:create', 'crm:business:query', 'crm:business:update', 'crm:business:delete',
    'crm:business-status:create', 'crm:business-status:query', 'crm:business-status:delete',
    'crm:business-stage-rule:query', 'crm:business-stage-rule:update',
    'crm:contract:create', 'crm:contract:update',
    'crm:quote:create'
  ], ['crm/config/businessStageRule/index'])
})

export const CRM_ACTOR_CASES = Object.freeze(Object.keys(CRM_ACTOR_CASE_PROFILES))
export const CRM_ACTOR_PERMISSIONS = Object.freeze([...new Set(
  CRM_ACTOR_CASES.flatMap((caseId) => CRM_ACTOR_CASE_PROFILES[caseId].permissions)
)])
export const CRM_ACTOR_NAV_PERMISSIONS = Object.freeze([...new Set(
  CRM_ACTOR_CASES.flatMap((caseId) => CRM_ACTOR_CASE_PROFILES[caseId].navPermissions)
)])
export const CRM_ACTOR_PAGE_COMPONENTS = Object.freeze([...new Set(
  CRM_ACTOR_CASES.flatMap((caseId) => CRM_ACTOR_CASE_PROFILES[caseId].pageComponents)
)])
const sessions = new WeakMap()
const attemptedCases = new WeakMap()
const stableId = (id) => (typeof id === 'string' && /^[1-9]\d*$/.test(id)) ||
  (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
const dataOf = (response, label) => assertBusinessSuccess(response, label).data
const fact = (record, name, passed, details) => {
  record.checks ||= []
  record.checks.push({ name, passed: passed === true, details })
  if (passed !== true) throw new Error(`${name}：${details}`)
}

export function crmActorRequirements(selectedCases = CRM_ACTOR_CASES) {
  const cases = [...new Set(Array.isArray(selectedCases) ? selectedCases : [])]
    .filter((caseId) => CRM_ACTOR_CASES.includes(caseId))
  if (cases.length === 0) throw new Error('BLOCKED: CRM 专属账号没有可识别的验收案例')
  return {
    cases,
    permissions: [...new Set(cases.flatMap((caseId) =>
      CRM_ACTOR_CASE_PROFILES[caseId].permissions))],
    navPermissions: [...new Set(cases.flatMap((caseId) =>
      CRM_ACTOR_CASE_PROFILES[caseId].navPermissions))],
    pageComponents: [...new Set(cases.flatMap((caseId) =>
      CRM_ACTOR_CASE_PROFILES[caseId].pageComponents))]
  }
}

const normalizedComponent = (component) => String(component || '')
  .replace(/\.vue(?=\?|$)/, '')
const isLegacyMenu = (row) => String(row.path || '').includes('/__legacy__/') ||
  String(row.component || '').includes('/__legacy__/')

export function crmActorMenuIds(menus, assignableIds, selectedCases = CRM_ACTOR_CASES) {
  if (!Array.isArray(menus) || !Array.isArray(assignableIds)) {
    throw new Error('BLOCKED: CRM 专属账号菜单前置不是完整数组')
  }
  const requirements = crmActorRequirements(selectedCases)
  const available = new Set(assignableIds.map(String))
  const byId = new Map(menus.map((row) => [String(row.id), row]))
  const allowed = new Set([...requirements.permissions, ...requirements.navPermissions])
  const ids = new Set()
  const targets = []
  for (const permission of [...requirements.permissions, ...requirements.navPermissions]) {
    const matches = menus.filter((row) => row.permission === permission &&
      Number(row.status) === 0 && available.has(String(row.id)) && !isLegacyMenu(row))
    if (matches.length === 0) throw new Error(`BLOCKED: 当前套餐缺少 ${permission}，未扩大套餐`)
    // Permission buttons may remain under the hidden legacy business tree.
    // Grant the exact button without granting its legacy navigation ancestry.
    for (const match of matches) ids.add(String(match.id))
  }
  // Query buttons may still belong to an older tree; select only the current page separately.
  const hasVisibleAncestry = (row) => {
    const seen = new Set()
    while (row) {
      const id = String(row.id)
      if (seen.has(id) || isLegacyMenu(row)) return false
      seen.add(id)
      if (String(row.parentId) === '0') return true
      row = byId.get(String(row.parentId))
    }
    return false
  }
  for (const component of requirements.pageComponents) {
    const matches = menus.filter((row) =>
      normalizedComponent(row.component) === component &&
      Number(row.status) === 0 && available.has(String(row.id)) &&
      hasVisibleAncestry(row))
    if (matches.length === 0) {
      throw new Error(`BLOCKED: 当前套餐缺少正式 CRM 页面 ${component} 或其可用父链，未扩大套餐`)
    }
    targets.push(...matches)
  }
  for (const target of targets) {
    let current = target
    const ancestors = new Set()
    while (current) {
      const id = String(current.id)
      if (!stableId(current.id) || ancestors.has(id) || Number(current.status) !== 0 ||
          !available.has(id) || (current.permission && !allowed.has(current.permission))) {
        throw new Error(`BLOCKED: CRM 菜单父链不完整或携带额外权限，未创建账号；` +
          `id=${id}, permission=${current.permission || ''}, status=${current.status}, ` +
          `assignable=${available.has(id)}`)
      }
      ancestors.add(id)
      ids.add(id)
      if (String(current.parentId) === '0') break
      current = byId.get(String(current.parentId))
      if (!current) throw new Error('BLOCKED: CRM 菜单缺失父节点，未创建账号')
    }
  }
  return [...ids]
}

const safeError = (error, session) => (session.secrets || []).reduce((text, secret) =>
  secret ? text.split(secret).join('[REDACTED]') : text, String(error?.message || error))
const leaveBlockedEvidence = (caseRecord, error) => {
  caseRecord.notes ||= []
  const message = String(error?.message || error)
  if (!caseRecord.notes.some((note) => note.includes(message))) {
    caseRecord.notes.push(`BLOCKED：CRM 专属账号前置失败，未扩大套餐或角色：${message}`)
  }
}

async function crmPackagePermissionEvidence (adminApi, menus, assignable, permission) {
  const permissionRows = (Array.isArray(menus) ? menus : [])
    .filter((row) => row?.permission === permission)
  const assignableIds = new Set((Array.isArray(assignable) ? assignable : [])
    .map((row) => String(row?.id)))
  const assignableRows = permissionRows.filter((row) => assignableIds.has(String(row.id)))
  let tenantId = '1'
  let packageId = ''
  let packageName = ''
  let packageStatus = ''
  let packageContains = 'unknown'
  let lookupError = ''
  try {
    const tenant = dataOf(await adminApi.getBusiness('/system/tenant/get?id=1'),
      'CRM 当前租户套餐证据')
    tenantId = String(tenant?.id || tenantId)
    packageId = String(tenant?.packageId || '')
    if (packageId) {
      const tenantPackage = dataOf(await adminApi.getBusiness(
        `/system/tenant-package/get?id=${encodeURIComponent(packageId)}`),
      'CRM 当前套餐证据')
      packageName = String(tenantPackage?.name || '')
      packageStatus = String(tenantPackage?.status ?? '')
      const packageMenuIds = new Set((Array.isArray(tenantPackage?.menuIds)
        ? tenantPackage.menuIds : []).map(String))
      packageContains = permissionRows.some((row) => packageMenuIds.has(String(row.id)))
        ? 'true' : 'false'
    }
  } catch (error) {
    lookupError = `lookupError=${safeError(error, { secrets: [] })}`
  }
  return [
    `permission=${permission}`,
    `systemMenuRows=${permissionRows.length}`,
    `assignableMenuRows=${assignableRows.length}`,
    `tenantId=${tenantId}`,
    `packageId=${packageId || 'unknown'}`,
    `packageName=${packageName || 'unknown'}`,
    `packageStatus=${packageStatus || 'unknown'}`,
    `packageContains=${packageContains}`,
    lookupError
  ].filter(Boolean).join('; ')
}

async function closeActor(session, caseRecord) {
  if (session.closed) return
  const errors = []
  for (const [label, run] of [
    ['响应收尾', () => session.browser?.flushResponses()],
    ['浏览器关闭', () => session.browser?.browser.close()],
    ['正式退出', () => session.actorApi?.postBusiness('/system/auth/logout')],
    ['专属账号停用', async () => {
      if (!session.userId) return
      await session.adminApi.putBusiness('/system/user/update-status', { id: session.userId, status: 1 })
      const user = dataOf(await session.adminApi.getBusiness(
        `/system/user/get?id=${encodeURIComponent(session.userId)}`), 'CRM 专属账号停用回读')
      if (String(user?.id) !== String(session.userId) || user?.username !== session.username ||
          Number(user.status) !== 1) throw new Error('CRM 专属账号停用身份或状态不符')
    }]
  ]) {
    try { await run() } catch (error) { errors.push(`${label}：${safeError(error, session)}`) }
  }
  // A role without a successfully created account has no audit owner.
  if (!session.userId && session.roleId) {
    try {
      await session.adminApi.deleteBusiness(`/system/role/delete?id=${session.roleId}`)
    } catch (error) { errors.push(`准备失败角色清理：${safeError(error, session)}`) }
  }
  caseRecord.checks ||= []
  caseRecord.checks.push({
    name: 'CRM 专属验收账号正式退出并停用，不改共享账号或客户配额',
    passed: errors.length === 0,
    details: `userId=${session.userId || '未创建'}；${errors.join('；') || '全部清理步骤成功'}`
  })
  session.closed = true
  if (errors.length) throw new Error(errors.join('；'))
}

async function createActor(context, adminApi, dependencies) {
  const selected = dependencies.config || config
  if (selected.target !== 'local' || String(selected.tenantId) !== '1' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(selected.apiBase).hostname) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(selected.webBase).hostname)) {
    throw new Error('BLOCKED: CRM 专属账号仅允许本地标准租户')
  }
  const selectedCases = (context.record?.selectedCases || [context.caseId])
    .filter((caseId) => CRM_ACTOR_CASES.includes(caseId))
  const requirements = crmActorRequirements(selectedCases)
  const session = {
    adminApi, username: '', menuIds: [], permissions: requirements.permissions,
    navPermissions: requirements.navPermissions, selectedCases: requirements.cases,
    secrets: [], remaining: new Set(requirements.cases
      .filter((caseId) => caseId === context.caseId ||
        !attemptedCases.get(context.record)?.has(caseId)))
  }
  const tag = randomBytes(6).toString('hex')
  session.username = `autotestcrm${tag}`
  const password = `Crm!${tag.slice(0, 6)}Aa9`
  session.secrets.push(password)
  let menus = []
  let assignable = []
  try {
    menus = dataOf(await adminApi.getBusiness('/system/menu/list'), 'CRM 菜单前置')
    assignable = dataOf(await adminApi.getBusiness('/system/menu/list-all-simple'),
      'CRM 套餐菜单前置')
    if (!Array.isArray(assignable)) {
      throw new Error('BLOCKED: CRM 套餐菜单前置不是数组')
    }
    session.menuIds = crmActorMenuIds(menus, assignable.map((row) => row.id), selectedCases)
    session.roleId = dataOf(await adminApi.postBusiness('/system/role/create', {
      name: `AUTOTEST CRM ${tag}`, code: `autotest_crm_${tag}`,
      sort: 999, status: 0, remark: 'Dedicated CRM acceptance actor; SELF scope'
    }), '创建CRM专属角色')
    if (!stableId(session.roleId)) throw new Error('CRM 角色未返回稳定 ID')
    await adminApi.postBusiness('/system/permission/assign-role-menu', {
      roleId: session.roleId, menuIds: session.menuIds
    })
    await adminApi.postBusiness('/system/permission/assign-role-data-scope', {
      roleId: session.roleId, dataScope: 5, dataScopeDeptIds: []
    })
    const role = dataOf(await adminApi.getBusiness(`/system/role/get?id=${session.roleId}`),
      'CRM 专属角色数据范围')
    if (String(role?.id) !== String(session.roleId) || role?.code !== `autotest_crm_${tag}` ||
        Number(role.dataScope) !== 5) throw new Error('CRM 专属角色不是本轮 SELF 数据范围')
    session.userId = dataOf(await adminApi.postBusiness('/system/user/create', {
      username: session.username, nickname: `CRM验收${tag}`, password,
      sex: 0, postIds: [], remark: 'Dedicated CRM acceptance only'
    }), '创建CRM专属账号')
    if (!stableId(session.userId)) throw new Error('CRM 账号未返回稳定 ID')
    await adminApi.postBusiness('/system/permission/assign-user-role', {
      userId: session.userId, roleIds: [session.roleId]
    })
    session.browser = await (dependencies.launchBrowser || launchBrowser)({
      headed: !selected.headless, record: context.record
    })
    const auth = await (dependencies.loginWithCredentials || loginWithCredentials)(
      session.browser.page, { tenantName: selected.tenantName, username: session.username, password },
      { returnContext: true })
    const token = typeof auth === 'string' ? auth : auth?.token
    if (!token || (auth?.tenantId && String(auth.tenantId) !== '1')) {
      throw new Error('CRM 专属账号登录租户或令牌不匹配')
    }
    session.secrets.push(token)
    session.actorApi = (dependencies.createApiClient || createApiClient)({
      token, tenantId: '1', record: context.record
    })
    const info = dataOf(await session.actorApi.getBusiness('/system/auth/get-permission-info'),
      'CRM 专属账号真实权限')
    const requiredPermissions = [...requirements.permissions, ...requirements.navPermissions]
    if (String(info?.user?.id) !== String(session.userId) || info.user.username !== session.username ||
        !Array.isArray(info.permissions) || !Array.isArray(info.roles) ||
        info.roles.includes('super_admin') || !info.roles.includes(`autotest_crm_${tag}`) ||
        requiredPermissions.some((permission) => !info.permissions.includes(permission)) ||
        info.permissions.some((permission) => permission !== '' &&
          !requirements.permissions.includes(permission) &&
          !requirements.navPermissions.includes(permission))) {
      throw new Error('CRM 专属账号身份或实际权限超出本轮最小集合')
    }
    return session
  } catch (error) {
    let blockedError = error
    if (/当前套餐缺少/.test(String(error?.message || error))) {
      const permission = String(error.message).match(/当前套餐缺少\s+([^\s，,，;；]+)/)?.[1] || ''
      const evidence = await crmPackagePermissionEvidence(
        adminApi, menus, assignable, permission)
      context.caseRecord.evidence ||= []
      context.caseRecord.evidence.push(`CRM 专属账号套餐权限前置证据：${evidence}`)
      blockedError = new Error(`${error.message}; ${evidence}`)
    }
    leaveBlockedEvidence(context.caseRecord, blockedError)
    let cleanup
    try { await closeActor(session, context.caseRecord) } catch (failure) { cleanup = failure }
    throw new Error([safeError(blockedError, session), cleanup && safeError(cleanup, session)]
      .filter(Boolean).join('；'))
  }
}

export async function withCrmAcceptanceActor(context, adminApi, run, dependencies = {}) {
  if (!CRM_ACTOR_CASES.includes(context.caseId) || typeof run !== 'function') {
    throw new Error('BLOCKED: CRM 专属账号只服务具名客户/商机及标签验收')
  }
  const attempted = attemptedCases.get(context.record) || new Set()
  attempted.add(context.caseId)
  attemptedCases.set(context.record, attempted)
  let session = sessions.get(context.record)
  const reused = Boolean(session && !session.closed)
  if (!reused) {
    session = await createActor(context, adminApi, dependencies)
    sessions.set(context.record, session)
  }
  session.latestCaseId = context.caseId
  session.latestCaseRecord = context.caseRecord
  context.caseRecord.accounts ||= []
  context.caseRecord.accounts.push({
    userId: session.userId, username: session.username, roleId: session.roleId,
    menuIds: session.menuIds, selectedCases: session.selectedCases,
    permissions: session.permissions, navPermissions: session.navPermissions,
    dataScope: 5, owned: true, reused
  })
  fact(context.caseRecord, 'CRM 专属最小权限身份与仅本人数据范围用于本轮业务',
    stableId(session.userId) && !session.closed,
    `userId=${session.userId}, roleId=${session.roleId}, reused=${reused}`)
  let result
  let failure
  try {
    result = await run({
      ...context, page: session.browser.page, context: session.browser.context
    }, session.actorApi, String(session.userId))
    await session.browser.flushResponses()
  } catch (error) { failure = error }
  session.remaining.delete(context.caseId)
  if (failure || context.caseRecord.checks.some((check) => check.passed !== true) ||
      session.remaining.size === 0) {
    try { await closeActor(session, context.caseRecord) } catch (error) {
      failure = new Error([failure && safeError(failure, session), safeError(error, session)]
        .filter(Boolean).join('；'))
    }
    sessions.delete(context.record)
  }
  if (failure) throw new Error(safeError(failure, session))
  return result
}

export async function closeCrmAcceptanceRun(record) {
  const session = sessions.get(record)
  if (!session || session.closed) return
  const owner = record.cases?.findLast((entry) => entry.id === session.latestCaseId) ||
    session.latestCaseRecord
  try {
    await closeActor(session, owner)
  } finally {
    sessions.delete(record)
  }
}
