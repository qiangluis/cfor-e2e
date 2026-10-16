import { randomBytes } from 'node:crypto'
import * as XLSX from 'xlsx'
import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { login, loginWithCredentials, openRoute, saveScreenshot, waitForPageReady } from '../lib/browser.mjs'

export const HRM_LOCAL_ASSERTIONS = Object.freeze([
  '员工与 system 用户一对一映射', '离职禁用访问', '敏感字段加密脱敏', '导出权限和审计'
])
export const HRM_LOCAL_CHECKS = Object.freeze({
  binding: 'HRM 专属员工与 system 用户双向关联且数据库唯一',
  duplicate: 'HRM 重复绑定精确拒绝且原绑定与候选工号均未改变',
  quit: 'HRM 专属员工离职状态和实际账号访问结果已回读',
  rehire: 'HRM 复职经 rehire 状态机恢复同一员工与账号',
  sensitive: 'HRM 合成敏感字段存储及普通查询暴露结果已核对',
  exportDenied: 'HRM 无导出权限账号精确拒绝且未返回文件',
  exportFile: 'HRM 授权导出真实工作簿仅含专属员工且排除证件工资卡社保字段',
  exportAudit: 'HRM 导出审计关联实际用户、接口、筛选、结果与 EXPORT 类型'
})
export const HRM_LOCAL_REJECTIONS = Object.freeze({
  duplicate: { code: 2041100002, message: '系统用户已绑定员工档案' },
  forbidden: { code: 403, message: '没有该操作权限', allowServiceCode: true }
})

export function assertHrmOaLocalTarget (settings = config, env = process.env) {
  const local = (value, port) => {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === port && !url.username && !url.password && !url.search && !url.hash &&
      ['', '/'].includes(url.pathname)
  }
  if (env.CFOR_E2E_WRITE_FIXTURES !== 'true' || settings.target !== 'local' ||
      String(settings.tenantId) !== '1' || !local(settings.webBase, '9151') ||
      !local(settings.apiBase, '48083') ||
      !['127.0.0.1', 'localhost', '::1'].includes(settings.db?.host) ||
      String(settings.db?.port) !== '3306' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: HRM/OA 写夹具仅允许显式启用的 local 9151/48083 tenant 1 cfor_admin_standard')
  }
}

export const closureId = (value) => {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) ||
      !/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error('Invalid closure ID')
  return String(value)
}
export const closureMarker = (domain) => {
  if (!['HRM001', 'OA001'].includes(domain)) throw new Error('Invalid closure domain')
  return `E2E-${domain}-${randomBytes(6).toString('hex').toUpperCase()}`
}
export function assertClosureMarker (marker, domain) {
  if (!new RegExp(`^E2E-${domain}-[A-F0-9]{12}$`).test(marker)) {
    throw new Error('BLOCKED: 非专属 HRM/OA 命名')
  }
}
export const closureTime = (milliseconds) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
}).format(new Date(milliseconds)).replace(' ', 'T')

export async function installHrmOaLocalApiBridge (context, record, env = process.env) {
  if (env.CFOR_HRM_OA_LOCAL_API_BRIDGE !== 'true') return
  assertHrmOaLocalTarget(config, env)
  record.transportEvidence = {
    mode: 'LOCAL_API_FORWARDING',
    web: config.webBase, backend: config.apiBase,
    reason: '9151 API proxy returned HTTP 500; browser forwards unchanged requests to real 48083, no response mock',
    normalWebProxyVerified: false
  }
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === config.webBase && /^\/(?:admin|app)-api\//.test(url.pathname)) {
      await route.continue({ url: `${config.apiBase}${url.pathname}${url.search}` })
    } else await route.continue()
  })
}
export const closureData = (response) => {
  const body = assertBusinessSuccess(response, 'HRM/OA formal API')
  if (body.code !== 0 || !Object.hasOwn(body, 'data') || body.data === undefined) {
    throw new Error('HRM/OA missing explicit formal business data')
  }
  return body.data
}
export const closureList = (response) => {
  const data = closureData(response)
  const rows = Array.isArray(data) ? data : data?.list
  if (!Array.isArray(rows) || rows.length > 100 ||
      (!Array.isArray(data) && (data?.total == null || !Number.isSafeInteger(Number(data.total)) ||
        Number(data.total) < rows.length))) {
    throw new Error('HRM/OA missing bounded list evidence')
  }
  return rows
}
export const closureCheck = (record, name, condition, details = '') => {
  const row = { name, passed: condition === true, details: String(details) }
  record.checks.push(row)
  if (!row.passed) throw new Error(`${name}: ${details}`)
}
export function inspectClosureSensitive ({ visible, stored, id, synthetic, mobile }) {
  const row = stored.length === 1 && stored[0][0] === id ? stored[0] : null
  const ordinaryQueryVisible = String(visible?.id) === id
  const hasFields = ordinaryQueryVisible &&
    typeof visible.idNumber === 'string' && typeof visible.mobile === 'string'
  return {
    measured: Boolean(row),
    idStoredPlaintext: row ? row[1] === '1' : null,
    mobileStoredPlaintext: row ? row[2] === '1' : null,
    ordinaryQueryVisible,
    ordinaryQueryMasked: hasFields
      ? visible.idNumber !== synthetic && visible.mobile !== mobile &&
        /\*/.test(visible.idNumber) && /\*/.test(visible.mobile)
      : null
  }
}
export function inspectClosureWorkbook ({ rows, id, marker, synthetic, mobile }) {
  const first = rows[0] || {}
  const columns = Object.keys(first)
  const values = rows.flatMap((row) => Object.values(row))
  const exactId = (value) => (typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))) && String(value) === id
  return {
    rowCount: rows.length,
    idExact: rows.length === 1 && exactId(first['员工编号']),
    markerPresent: rows.length === 1 && first['工号'] === marker,
    syntheticPresent: values.some((value) => typeof value === 'string' && value.includes(synthetic)),
    mobileColumnPresent: columns.includes('手机号'),
    mobilePlaintextPresent: typeof mobile === 'string'
      ? values.some((value) => String(value) === mobile) : null,
    sensitiveColumns: columns.filter((name) => /证件|身份证|银行卡|社保|公积金/.test(name)),
    columns
  }
}
export const closureGap = (record, index, details) => {
  record.localAssertionGaps ||= {}
  record.localAssertionGapReasons ||= {}
  const reasons = record.localAssertionGapReasons[index] ||= record.localAssertionGaps[index]
    ? [record.localAssertionGaps[index]] : []
  if (!reasons.includes(details)) reasons.push(details)
  record.localAssertionGaps[index] = reasons.join('；')
}

export function finalizeLocalAssertions (record, assertions, evidence) {
  record.catalogAssertions = assertions.map((assertion, index) => {
    const names = evidence[index] || []
    const matches = names.map((name) => record.checks.filter((row) => row.name === name))
    const gap = record.localAssertionGaps?.[index] || ''
    const verified = !gap && names.length > 0 &&
      matches.every((rows) => rows.length === 1 && rows[0].passed === true)
    return {
      index, assertion, status: verified ? 'VERIFIED' : 'GAP', evidenceChecks: [...names],
      details: gap || (verified ? '精确命名检查及事实回读完整' : '本轮缺少完整且唯一的命名证据')
    }
  })
  record.remainingAssertions = record.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
    .map((row) => row.assertion)
  record.catalogComplete = record.remainingAssertions.length === 0
  record.passCandidate = record.catalogComplete && record.checks.every((row) => row.passed === true)
  record.acceptanceComplete = record.passCandidate
  const gaps = record.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
  return { partial: !record.passCandidate,
    note: gaps.length ? gaps.map((row) => `${row.assertion}：${row.details}`).join('；') : '',
    acceptanceComplete: record.passCandidate,
    catalogComplete: record.catalogComplete, remainingAssertions: record.remainingAssertions,
    catalogAssertions: record.catalogAssertions }
}

export function createLocalClosureCleanup (record) {
  let pending = []
  let running = false
  const holds = new Map()
  return {
    hold (id, reason) { holds.set(closureId(id), reason) },
    track (label, id, cleanup, { recovery, blocks = [] } = {}) {
      const entry = { label, id: closureId(id), cleanup: 'PENDING', attempts: 0,
        ...(recovery ? { recovery: { ...recovery, id: closureId(id) } } : {}) }
      record.fixtures ||= []
      record.fixtures.push(entry)
      pending.push({ entry, cleanup, blocks: blocks.map(closureId) })
      return entry.id
    },
    async cleanup () {
      if (running) throw new Error('HRM/OA cleanup already running')
      running = true
      const errors = []
      const blocked = new Map(holds)
      const completed = new Set()
      try {
        record.checks ||= []
        for (const item of [...pending].reverse()) {
          const { entry, cleanup, blocks } = item
          try {
            if (blocked.has(entry.id)) throw new Error(`BLOCKED: ${blocked.get(entry.id)}`)
            entry.attempts++
            entry.cleanup = 'PENDING'
            await cleanup(entry.id, entry)
            if (entry.cleanup === 'PENDING') entry.cleanup = 'VERIFIED'
            completed.add(item)
            if (entry.transportErrors?.length) record.checks.push({
              name: `${entry.label} 清理原请求异常`, passed: false,
              details: entry.transportErrors.join('; ')
            })
            record.checks.push({ name: `${entry.label} 清理回读`, passed: true,
              details: `id=${entry.id}; attempt=${entry.attempts}; ${entry.cleanup}` })
          } catch (error) {
            entry.cleanup = blocked.has(entry.id) ? 'BLOCKED' : 'FAILED'
            entry.cleanupErrors ||= []
            entry.cleanupErrors.push(error.message)
            for (const id of blocks) blocked.set(id, `依赖资源 ${entry.id} 未完成清理`)
            record.checks.push({ name: `${entry.label} 清理回读`, passed: false, details: error.message })
            errors.push(error)
          }
        }
      } finally {
        pending = pending.filter((item) => !completed.has(item))
        running = false
      }
      if (errors.length) throw new AggregateError(errors, 'HRM/OA 专属夹具清理失败')
    }
  }
}

export function closureActorIdentity (marker, suffix) {
  if (!/^E2E-(HRM001|OA001)-[A-F0-9]{12}$/.test(marker) || !/^[a-z]{1,5}$/.test(suffix)) {
    throw new Error('BLOCKED: 非专属 HRM/OA 命名')
  }
  const tag = marker.split('-').at(-1).toLowerCase()
  return { marker, suffix, username: `e2e${marker.includes('HRM') ? 'hrm' : 'oa'}${suffix}${tag}`,
    nickname: `${marker}-${suffix}`, roleCode: `e2e_${suffix}_${tag}` }
}

// These APIs use LIKE filters. Never adopt a partial page or its first row.
export async function findClosureRows (api, path, matches) {
  const response = await api.getBusiness(path, { timeoutMs: 10000 })
  const rows = closureList(response)
  if (Array.isArray(response.data) || Number(response.data.total) !== rows.length) {
    throw new Error('BLOCKED: 专属资源查询不完整')
  }
  return rows.filter(matches)
}

export async function createClosureResource ({
  record, cleanup, label, recovery, find, owns, create, remove, blocks = [], allowNoResource = false
}) {
  const intent = { ...recovery, state: 'PREFLIGHT' }
  record.resourceIntents ||= []
  record.resourceIntents.push(intent)
  const before = await find()
  if (before.length) {
    intent.state = 'EXISTS_REQUIRES_EXPLICIT_RECOVERY'
    intent.ids = before.map((row) => closureId(row.id))
    throw new Error(`BLOCKED: ${label} 已存在，禁止复用或自动删除；ids=${intent.ids.join(',')}`)
  }
  intent.state = 'CREATE_IN_FLIGHT'
  const register = (id) => {
    intent.id = closureId(id)
    intent.state = 'REGISTERED'
    return cleanup.track(label, intent.id, remove, { recovery, blocks })
  }
  try {
    const id = await create()
    if (id === null && allowNoResource) {
      intent.state = 'NOT_CREATED_BUSINESS_GAP'
      return null
    }
    return register(id)
  } catch (error) {
    intent.state = 'COMMIT_UNKNOWN'
    intent.error = error.message
    try {
      const found = await find()
      if (found.length === 1 && owns(found[0], closureId(found[0].id))) {
        register(found[0].id)
        intent.state = 'RECOVERED_FOR_CLEANUP_ONLY'
      } else if (found.length) throw new Error('找回资源所有权不符或不唯一')
    } catch (recoveryError) {
      intent.recoveryError = recoveryError.message
    }
    if (intent.state === 'COMMIT_UNKNOWN') {
      for (const id of blocks) cleanup.hold(id, `${label} 创建提交状态未知，需精确回读恢复`)
    }
    // Even a recovered ID is cleanup evidence, never a successful workflow.
    throw error
  }
}

export async function deleteClosureResource ({ api, path, get, owns, verify, entry }) {
  const current = await get()
  if (current === undefined) throw new Error('资源读取缺少明确 data:null 或对象')
  if (current != null && !owns(current)) throw new Error('资源所有权不符，停止清理')
  let mutationError
  if (current != null) {
    try {
      if (closureData(await api.deleteBusiness(path, { timeoutMs: 10000 })) !== true) {
        throw new Error('正式删除未返回 true')
      }
    } catch (error) {
      mutationError = error
      entry.transportErrors ||= []
      entry.transportErrors.push(error.message)
    }
  }
  try {
    if (await get() !== null) throw new Error('资源删除未回读，不自动重试写请求')
    if (verify) await verify()
  } catch (error) {
    if (mutationError) throw new AggregateError([mutationError, error], mutationError.message)
    throw error
  }
  if (mutationError) entry.cleanupRecovery = 'DELETE_RESPONSE_LOST; absence verified independently'
}

async function readClosureRoleState ({ adminApi, record, identity, id, read }) {
  const role = closureData(await adminApi.getBusiness(`/system/role/get?id=${id}`, { timeoutMs: 10000 }))
  const rows = await readClosureDb(record, `role-${id}-recovery`, `
    SELECT 'role', CAST(id AS CHAR), code, name, remark, type, deleted+0, data_scope
    FROM system_role WHERE tenant_id=1 AND id=${id};
    SELECT 'user-role', COUNT(*) FROM system_user_role WHERE tenant_id=1 AND deleted=0 AND role_id=${id};
    SELECT 'role-menu', COUNT(*) FROM system_role_menu WHERE tenant_id=1 AND deleted=0 AND role_id=${id};
    SELECT 'exact-user', COUNT(*) FROM system_users
    WHERE tenant_id=1 AND deleted=0 AND username='${identity.username}'`, read)
  const roleRows = rows.filter((row) => row[0] === 'role')
  const count = (tag) => {
    const matched = rows.filter((row) => row[0] === tag)
    if (matched.length !== 1 || !/^\d+$/.test(matched[0][1] ?? '')) {
      throw new Error(`BLOCKED: 角色恢复缺少 ${tag} 证据`)
    }
    return matched[0][1]
  }
  if (roleRows.length > 1 || (roleRows.length === 1 && (
    roleRows[0][1] !== id || roleRows[0][2] !== identity.roleCode ||
    roleRows[0][3] !== identity.nickname || roleRows[0][4] !== identity.marker ||
    roleRows[0][5] !== '2' || !['0', '1'].includes(roleRows[0][6]) || roleRows[0][7] !== '5'
  ))) throw new Error('BLOCKED: 角色数据库所有权或 SELF 范围不符')
  if (role != null && (String(role.id) !== id || role.code !== identity.roleCode ||
      role.name !== identity.nickname || role.remark !== identity.marker ||
      role.type !== 2 || role.dataScope !== 5 || roleRows[0]?.[6] !== '0')) {
    throw new Error('BLOCKED: 角色所有权不符，停止清理')
  }
  if (role == null && roleRows[0]?.[6] === '0') throw new Error('BLOCKED: API 与数据库角色可见性不一致')
  const state = { exists: role != null, userRoles: count('user-role'),
    roleMenus: count('role-menu'), exactUsers: count('exact-user') }
  if (state.userRoles !== '0' || state.exactUsers !== '0') {
    throw new Error('BLOCKED: 角色仍有关联用户或精确命名账号，先恢复子资源')
  }
  if (!state.exists && state.roleMenus !== '0') throw new Error('BLOCKED: 删除角色仍有菜单关联')
  return state
}

async function removeClosureRole ({ adminApi, record, identity, id, entry, read }) {
  const before = await readClosureRoleState({ adminApi, record, identity, id, read })
  if (!before.exists) { entry.cleanup = 'ALREADY_ABSENT; associations=0'; return }
  await deleteClosureResource({ api: adminApi, path: `/system/role/delete?id=${id}`, entry,
    get: async () => closureData(await adminApi.getBusiness(`/system/role/get?id=${id}`, { timeoutMs: 10000 })),
    owns: (role) => String(role.id) === id && role.code === identity.roleCode &&
      role.name === identity.nickname && role.remark === identity.marker && role.type === 2 && role.dataScope === 5,
    verify: async () => {
      const after = await readClosureRoleState({ adminApi, record, identity, id, read })
      if (after.exists) throw new Error('角色删除未回读')
    } })
}

export async function recoverClosureRole ({
  adminApi, marker, suffix, roleId, apply = false, record = { checks: [] },
  read = runReadOnlySql, settings = config, env = process.env
}) {
  assertHrmOaLocalTarget(settings, env)
  const identity = closureActorIdentity(marker, suffix)
  const id = closureId(roleId)
  if (apply && env.CFOR_HRM_OA_RECOVERY_APPLY !== 'true') {
    throw new Error('BLOCKED: 精确恢复删除需 CFOR_HRM_OA_RECOVERY_APPLY=true')
  }
  const state = await readClosureRoleState({ adminApi, record, identity, id, read })
  const entry = { id, recovery: { kind: 'role', ...identity }, cleanup: 'PREFLIGHT_ONLY' }
  if (apply) {
    await removeClosureRole({ adminApi, record, identity, id, entry, read })
    if (entry.cleanup === 'PREFLIGHT_ONLY') entry.cleanup = 'VERIFIED'
  }
  return { marker, roleId: id, ...state, ...entry, applied: apply }
}

export async function readClosureDb (record, stage, sql, read = runReadOnlySql) {
  const result = await read(sql)
  if (result.available !== true || !Array.isArray(result.rows)) {
    throw new Error(`BLOCKED: ${stage} 缺少只读数据库证据`)
  }
  record.database ||= []
  record.database.push({ stage, available: true, rows: result.rows })
  return result.rows
}

export function closurePermissionMenus (menus, assignable, permissions) {
  const byId = new Map(menus.map((row) => [String(row.id), row]))
  const allowed = new Set(assignable.map((row) => String(row.id)))
  const ids = new Set()
  for (const permission of permissions) {
    if (!permission || permission.includes('*')) throw new Error('BLOCKED: 通配权限禁止用于独立夹具')
    const candidates = menus.filter((row) => row.permission === permission && row.status === 0)
    let selected
    for (const candidate of candidates) {
      let row = candidate
      const chain = []
      const seen = new Set()
      while (row && row.status === 0 && allowed.has(String(row.id)) && !seen.has(String(row.id)) &&
          !row.permission?.includes('*')) {
        seen.add(String(row.id))
        chain.push(closureId(row.id))
        if (String(row.parentId) === '0') { selected = chain; break }
        row = byId.get(String(row.parentId))
      }
      if (selected) break
    }
    if (!selected) throw new Error(`BLOCKED: 无可分配的正式权限父链 ${permission}`)
    for (const id of selected) ids.add(id)
  }
  return [...ids]
}

export async function assignClosurePermissions (adminApi, actor, permissions) {
  const menus = closureData(await adminApi.getBusiness('/system/menu/list'))
  const assignable = closureData(await adminApi.getBusiness('/system/menu/list-all-simple'))
  const menuIds = closurePermissionMenus(menus, assignable, permissions)
  await adminApi.postBusiness('/system/permission/assign-role-menu', { roleId: actor.roleId, menuIds })
  actor.permissions = [...permissions]
}

export async function createClosureActor ({ adminApi, record, cleanup, marker, suffix, permissions, read = runReadOnlySql }) {
  const identity = closureActorIdentity(marker, suffix)
  const actor = {
    ...identity,
    credentials: { tenantName: config.tenantName, password: `E2e!${randomBytes(4).toString('hex')}A9` }
  }
  actor.credentials.username = actor.username
  // Resolve the grant before creating any account. Only fixture-owned roles are changed.
  const menus = closureData(await adminApi.getBusiness('/system/menu/list'))
  const assignable = closureData(await adminApi.getBusiness('/system/menu/list-all-simple'))
  const menuIds = closurePermissionMenus(menus, assignable, permissions)
  const findUsers = () => findClosureRows(adminApi,
    `/system/user/page?pageNo=1&pageSize=100&username=${encodeURIComponent(actor.username)}`,
    (row) => row.username === actor.username)
  // Check both names before the first mutation; never reuse a previous run's account.
  if ((await findUsers()).length) throw new Error('BLOCKED: 精确命名账号已存在，需显式恢复')
  actor.roleId = await createClosureResource({
    record, cleanup, label: `${marker}-${suffix} 角色`, recovery: { kind: 'role', ...identity },
    find: async () => {
      const rows = []
      for (const [key, value] of [['code', actor.roleCode], ['name', actor.nickname]]) {
        rows.push(...await findClosureRows(adminApi,
          `/system/role/page?pageNo=1&pageSize=100&${key}=${encodeURIComponent(value)}`,
          (row) => row.code === actor.roleCode || row.name === actor.nickname))
      }
      return [...new Map(rows.map((row) => [closureId(row.id), row])).values()]
    },
    owns: (role, id) => String(role.id) === id && role.code === actor.roleCode &&
      role.name === actor.nickname && role.remark === marker && role.type === 2 && role.dataScope === 5,
    create: async () => closureData(await adminApi.postBusiness('/system/role/create', {
      name: actor.nickname, code: actor.roleCode, sort: 999, status: 0, remark: marker
    })),
    remove: (id, entry) => removeClosureRole({ adminApi, record, identity, id, entry, read })
  })
  await adminApi.postBusiness('/system/permission/assign-role-menu', { roleId: actor.roleId, menuIds })
  const ownsUser = (user, id) => String(user?.id) === id && user.username === actor.username &&
    user.nickname === actor.nickname && user.remark === marker
  actor.userId = await createClosureResource({
    record, cleanup, label: `${marker}-${suffix} 账号`,
    recovery: { kind: 'user', ...identity, roleId: actor.roleId }, blocks: [actor.roleId],
    find: findUsers, owns: ownsUser,
    create: async () => closureData(await adminApi.postBusiness('/system/user/create', {
      username: actor.username, nickname: actor.nickname, password: actor.credentials.password,
      postIds: [], sex: 0, remark: marker
    })),
    remove: async (id, entry) => {
    const links = closureList(await adminApi.getBusiness(`/hrm/employee/user-links?userIds=${id}`))
    if (links.length) throw new Error('BLOCKED: 账号仍绑定员工，先恢复员工清理')
    const user = closureData(await adminApi.getBusiness(`/system/user/get?id=${id}`))
    const roles = closureList(await adminApi.getBusiness(`/system/permission/list-user-roles?userId=${id}`))
    if (roles.some((roleId) => closureId(roleId) !== actor.roleId)) {
      throw new Error('BLOCKED: 专属账号存在其他角色，禁止自动解除授权')
    }
    if (user != null) {
      if (!ownsUser(user, id)) throw new Error('账号所有权不符')
      for (const session of actor.sessions || []) await session.postBusiness('/system/auth/logout')
      if (user.status !== 1) await adminApi.putBusiness('/system/user/update-status', { id, status: 1 })
      const disabled = closureData(await adminApi.getBusiness(`/system/user/get?id=${id}`))
      if (disabled?.status !== 1 || !ownsUser(disabled, id)) throw new Error('账号停用未回读')
      if (roles.length) await adminApi.postBusiness('/system/permission/assign-user-role', { userId: id, roleIds: [] })
    } else if (roles.length) throw new Error('BLOCKED: 已删除账号仍有角色关联')
    await deleteClosureResource({ api: adminApi, path: `/system/user/delete?id=${id}`, entry,
      get: async () => closureData(await adminApi.getBusiness(`/system/user/get?id=${id}`)),
      owns: (current) => ownsUser(current, id),
      verify: async () => {
        if (closureList(await adminApi.getBusiness(`/system/permission/list-user-roles?userId=${id}`)).length) {
          throw new Error('账号删除后角色关联仍存在')
        }
      } })
    }
  })
  await adminApi.postBusiness('/system/permission/assign-user-role', {
    userId: actor.userId, roleIds: [actor.roleId]
  })
  actor.permissions = [...permissions]
  record.accounts ||= []
  record.accounts.push({ userId: actor.userId, username: actor.username, roleId: actor.roleId,
    permissions: [...permissions] })
  return actor
}

export async function loginClosureActor (actor, { record, page, apiFactory = createApiClient } = {}) {
  let token
  if (page) token = await loginWithCredentials(page, actor.credentials)
  else token = closureData(await apiFactory({ tenantId: '1', record }).postBusiness(
    '/system/auth/login-encrypted', {
      username: actor.username, password: actor.credentials.password, captchaVerification: ''
    }, { encrypted: true })).accessToken
  if (!token) throw new Error('专属账号未返回令牌')
  const api = apiFactory({ token, tenantId: '1', record })
  actor.sessions ||= []
  actor.sessions.push(api)
  const info = closureData(await api.getBusiness('/system/auth/get-permission-info'))
  if (String(info?.user?.id) !== actor.userId || info.user.username !== actor.username ||
      !Array.isArray(info.permissions) || info.permissions.some((value) => value.includes('*')) ||
      !actor.permissions.every((value) => info.permissions.includes(value))) {
    throw new Error('专属账号真实身份或最小权限回读不符')
  }
  return api
}

export async function createClosureEmployee ({ adminApi, actor, record, cleanup, marker }) {
  if (!/^E2E-(HRM001|OA001)-[A-F0-9]{12}(?:-OTHER)?$/.test(marker)) {
    throw new Error('BLOCKED: 非专属员工工号')
  }
  const departments = closureList(await adminApi.getBusiness(
    '/system/dept/list?name=%E4%BA%BA%E5%8A%9B%E8%B5%84%E6%BA%90%E9%83%A8&status=0'
  ))
  const department = departments.find((row) => row.name === '人力资源部')
  if (!department?.id || departments.length !== 1) {
    throw new Error('BLOCKED: 启用的人力资源部不存在或不唯一，不修改共享组织')
  }
  const mobile = `199${String(BigInt(`0x${randomBytes(4).toString('hex')}`) % 100000000n).padStart(8, '0')}`
  const payload = { userId: actor.userId, jobNumber: marker, mobile,
    deptId: closureId(department.id), type: 1, probation: 0, entryTime: closureTime(Date.now() - 86400000),
    remark: marker }
  const owns = (employee, id) => String(employee?.id) === id && employee.jobNumber === marker &&
    String(employee.userId) === actor.userId && employee.remark === marker
  const employeeId = await createClosureResource({
    record, cleanup, label: `${marker} 员工`,
    recovery: { kind: 'employee', marker, userId: closureId(actor.userId) }, blocks: [actor.userId],
    find: () => findClosureRows(adminApi,
      `/hrm/employee/page?pageNo=1&pageSize=100&jobNumber=${marker}`, (row) => row.jobNumber === marker),
    owns,
    create: async () => {
      const ids = closureData(await adminApi.postBusiness('/hrm/employee/create-list', [payload]))
      if (!Array.isArray(ids) || ids.length !== 1) throw new Error('HRM 批量建档返回非唯一 ID')
      return ids[0]
    },
    remove: async (id, entry) => {
      await deleteClosureResource({ api: adminApi, path: `/hrm/employee/delete?id=${id}`, entry,
        get: async () => closureData(await adminApi.getBusiness(`/hrm/employee/get?id=${id}`)),
        owns: (employee) => owns(employee, id), verify: async () => {
          const links = closureList(await adminApi.getBusiness(`/hrm/employee/user-links?userIds=${actor.userId}`))
          if (links.length) throw new Error('员工删除后绑定仍存在')
        } })
      entry.cleanup = 'DELETED; lifecycle/audit records retained when no formal delete API exists'
    }
  })
  return { ...payload, employeeId, name: actor.nickname, entryStatus: 1, createUserAccount: false }
}

export function resolveClosureRoute (menus, component) {
  const matches = []
  const walk = (rows, parent = '') => {
    for (const row of rows || []) {
      if (typeof row.path !== 'string' || /[?#\\]|^(?:\w+:|\/\/)/.test(row.path) ||
          row.path.split('/').some((value) => ['.', '..'].includes(value))) continue
      const route = (row.path.startsWith('/') ? row.path : `${parent}/${row.path}`).replace(/\/+/g, '/')
      if (row.component === component) matches.push(route)
      walk(row.children, route)
    }
  }
  walk(menus)
  if (matches.length !== 1) throw new Error(`BLOCKED: 正式菜单组件 ${component} 路径不唯一`)
  return matches[0]
}

export async function showClosureRow ({ page, api, component, placeholder, marker, outputDir, record }) {
  const menus = closureData(await api.getBusiness('/system/auth/get-permission-info')).menus
  const route = resolveClosureRoute(menus, component)
  await openRoute(page, route, { readySelector: '.el-table' })
  await page.getByPlaceholder(placeholder, { exact: true }).fill(marker)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const row = page.locator('.el-table__row').filter({ hasText: marker })
  await row.first().waitFor({ state: 'visible' })
  await waitForPageReady(page)
  if (await row.count() !== 1) throw new Error('页面未显示唯一专属事实')
  await saveScreenshot(page, outputDir, `${marker}-facts`, record)
  return { route, row }
}

const hrmEvidence = {
  0: [HRM_LOCAL_CHECKS.binding, HRM_LOCAL_CHECKS.duplicate],
  1: [HRM_LOCAL_CHECKS.quit, HRM_LOCAL_CHECKS.rehire],
  2: [HRM_LOCAL_CHECKS.sensitive],
  3: [HRM_LOCAL_CHECKS.exportDenied, HRM_LOCAL_CHECKS.exportFile, HRM_LOCAL_CHECKS.exportAudit]
}

export async function runHrmLocalClosure (context, dependencies = {}) {
  const { caseRecord, page, record, outputDir } = context
  finalizeLocalAssertions(caseRecord, HRM_LOCAL_ASSERTIONS, hrmEvidence)
  assertHrmOaLocalTarget(dependencies.config || config, dependencies.env || process.env)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const apiFactory = dependencies.createApiClient || createApiClient
  const api = context.api || apiFactory({ token: await login(page), tenantId: '1', record })
  const read = dependencies.runReadOnlySql || runReadOnlySql
  const marker = dependencies.marker || closureMarker('HRM001')
  assertClosureMarker(marker, 'HRM001')
  const cleanup = createLocalClosureCleanup(caseRecord)
  let primaryError
  try {
    const actor = await createClosureActor({ adminApi: api, record: caseRecord, cleanup, marker,
      suffix: 'read', permissions: ['hrm:employee:query', 'hrm:portal:query'], read })
    const employee = await createClosureEmployee({ adminApi: api, actor, record: caseRecord, cleanup, marker })
    const id = employee.employeeId
    const before = closureData(await api.getBusiness(`/hrm/employee/get?id=${id}`))
    const links = closureList(await api.getBusiness(`/hrm/employee/user-links?userIds=${actor.userId}`))
    const unique = await readClosureDb(caseRecord, 'hrm-binding', `
      SELECT CAST(id AS CHAR), CAST(user_id AS CHAR), job_number, entry_status
      FROM hrm_employee WHERE tenant_id=1 AND deleted=0 AND user_id=${actor.userId}`, read)
    closureCheck(caseRecord, HRM_LOCAL_CHECKS.binding,
      String(before?.id) === id && String(before.userId) === actor.userId &&
      before.jobNumber === marker && before.entryStatus === 1 &&
      links.length === 1 && String(links[0].employeeId) === id &&
      unique.length === 1 && unique[0][0] === id && unique[0][1] === actor.userId,
      `employeeId=${id}; userId=${actor.userId}; sqlCount=${unique.length}`)
    const duplicate = await api.post('/hrm/employee/create-list', [{
      ...employee, jobNumber: `${marker}-DUP`, mobile: `198${employee.mobile.slice(3)}`
    }], { expectedBusinessRejection: HRM_LOCAL_REJECTIONS.duplicate })
    const after = closureData(await api.getBusiness(`/hrm/employee/get?id=${id}`))
    const candidate = closureList(await api.getBusiness(
      `/hrm/employee/page?pageNo=1&pageSize=100&jobNumber=${marker}-DUP`))
    const uniqueAfter = await readClosureDb(caseRecord, 'hrm-binding-after-duplicate', `
      SELECT CAST(id AS CHAR), CAST(user_id AS CHAR), job_number, entry_status
      FROM hrm_employee WHERE tenant_id=1 AND deleted=0 AND user_id=${actor.userId}`, read)
    closureCheck(caseRecord, HRM_LOCAL_CHECKS.duplicate,
      matchesExpectedBusinessRejection(duplicate, HRM_LOCAL_REJECTIONS.duplicate) &&
      candidate.length === 0 && JSON.stringify(before) === JSON.stringify(after) &&
      JSON.stringify(unique) === JSON.stringify(uniqueAfter), `code=${duplicate.code}; candidateRows=${candidate.length}`)
    const actorApi = await loginClosureActor(actor, { record, apiFactory })
    const denied = await actorApi.get(`/hrm/employee/export-excel?search=${marker}`,
      { expectedBusinessRejection: HRM_LOCAL_REJECTIONS.forbidden })
    closureCheck(caseRecord, HRM_LOCAL_CHECKS.exportDenied,
      matchesExpectedBusinessRejection(denied, HRM_LOCAL_REJECTIONS.forbidden) && denied.data == null,
      `userId=${actor.userId}; code=${denied.code}`)

    // Synthetic values only; database evidence returns booleans, never sensitive values.
    const synthetic = `E2E-PROBE-${marker.split('-').at(-1)}`
    await api.putBusiness('/hrm/employee/update', { ...employee, id, idType: 5, idNumber: synthetic })
    const visible = closureData(await actorApi.getBusiness(`/hrm/employee/get?id=${id}`))
    const stored = await readClosureDb(caseRecord, 'hrm-sensitive-flags', `
      SELECT CAST(id AS CHAR), id_number='${synthetic}', mobile='${employee.mobile}'
      FROM hrm_employee WHERE tenant_id=1 AND deleted=0 AND id=${id}`, read)
    const sensitive = inspectClosureSensitive({ visible, stored, id, synthetic, mobile: employee.mobile })
    closureCheck(caseRecord, HRM_LOCAL_CHECKS.sensitive, sensitive.measured,
      `employeeId=${id}; ${JSON.stringify(sensitive)}; syntheticOnly=true`)
    closureGap(caseRecord, 2,
      `合成字段实测 ${JSON.stringify(sensitive)}；data:null 不等于脱敏，存储值不同也不足以证明加密算法/密钥契约`)

    const exporter = closureData(await api.getBusiness('/system/user/profile/get'))
    const exporterId = closureId(exporter?.id)
    const exported = await api.download(`/hrm/employee/export-excel?search=${marker}`)
    const workbook = XLSX.read(exported.buffer, { type: 'buffer' })
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' })
    const workbookEvidence = inspectClosureWorkbook({ rows, id, marker, synthetic, mobile: employee.mobile })
    caseRecord.exportWorkbook = {
      contentType: exported.contentType || '',
      bytes: exported.buffer.length,
      ...workbookEvidence
    }
    const exportPassed = /excel|spreadsheet|octet-stream/i.test(exported.contentType || '') &&
      workbookEvidence.rowCount === 1 && workbookEvidence.idExact &&
      workbookEvidence.markerPresent && !workbookEvidence.syntheticPresent &&
      workbookEvidence.sensitiveColumns.length === 0
    if (exportPassed) {
      closureCheck(caseRecord, HRM_LOCAL_CHECKS.exportFile, true,
        `employeeId=${id}; exporterId=${exporterId}; ${JSON.stringify(workbookEvidence)}; bytes=${exported.buffer.length}`)
    } else {
      closureGap(caseRecord, 3,
        `授权导出已返回工作簿但内容证据不完整：employeeId=${id}; exporterId=${exporterId}; ${JSON.stringify(caseRecord.exportWorkbook)}`)
    }
    if (workbookEvidence.mobilePlaintextPresent) {
      closureGap(caseRecord, 2, '授权导出含本轮合成手机号原值；手机号的可见角色及脱敏策略待确认，不将排除证件/工资卡/社保字段等同于所有个人信息脱敏')
    }
    let audit = []
    for (let attempt = 0; attempt < 12; attempt++) {
      audit = await readClosureDb(caseRecord, 'hrm-export-audit', `
        SELECT CAST(id AS CHAR), CAST(user_id AS CHAR), request_method, result_code, operate_type
        FROM infra_api_access_log WHERE tenant_id=1 AND deleted=0 AND user_id=${exporterId}
          AND request_url='/admin-api/hrm/employee/export-excel'
          AND JSON_UNQUOTE(JSON_EXTRACT(
            JSON_UNQUOTE(JSON_EXTRACT(request_params, '$.query')), '$.search'))='${marker}'
          AND request_method='GET' AND result_code=0 AND operate_type=5
        ORDER BY id DESC LIMIT 1`, read)
      if (audit.length) break
      await new Promise((resolve) => setTimeout(resolve, dependencies.pollMs ?? 300))
    }
    if (audit.length === 1) {
      closureCheck(caseRecord, HRM_LOCAL_CHECKS.exportAudit,
        audit[0][1] === exporterId && audit[0][2] === 'GET' && audit[0][3] === '0' && audit[0][4] === '5',
        `auditId=${audit[0][0]}; userId=${exporterId}`)
    } else closureGap(caseRecord, 3,
      '未回读到同一用户、精确筛选及 EXPORT 审计；需核对有效 cfor.access-log.enable（dev 默认为 false），不据此断言产品漏审计')

    const now = closureTime(Date.now() - 60000)
    await api.postBusiness('/hrm/employee/quit', { employeeId: id, planQuitTime: now,
      applyQuitTime: now, salarySettlementTime: now, type: 1, reason: 10, remark: marker })
    const left = closureData(await api.getBusiness(`/hrm/employee/get?id=${id}`))
    const user = closureData(await api.getBusiness(`/system/user/get?id=${actor.userId}`))
    const access = await actorApi.get('/system/user/profile/get')
    const fresh = await apiFactory({ tenantId: '1', record }).post('/system/auth/login-encrypted', {
      username: actor.username, password: actor.credentials.password, captchaVerification: ''
    }, { encrypted: true, expectedBusinessRejection: {
      code: 1002000001, message: '登录失败，账号被禁用', allowServiceCode: true
    } })
    if (fresh?.code === 0 && fresh.data?.accessToken) {
      actor.sessions.push(apiFactory({ token: fresh.data.accessToken, tenantId: '1', record }))
    }
    const accessDisabled = user?.status === 1 && access?.code === 401 && fresh?.code === 1002000001
    closureCheck(caseRecord, HRM_LOCAL_CHECKS.quit,
      left?.entryStatus === 4 && String(left.userId) === actor.userId,
      `employeeId=${id}; entryStatus=${left?.entryStatus}; accountStatus=${user?.status}; activeSessionCode=${access?.code}; freshLoginCode=${fresh?.code}`)
    if (!accessDisabled) closureGap(caseRecord, 1,
      `离职后 accountStatus=${user?.status}, activeSessionCode=${access?.code}, freshLoginCode=${fresh?.code}；禁用账号及已签发令牌的策略须确认，未手动停用冒充离职联动`)
    await api.postBusiness('/hrm/employee/rehire', { ...employee, employeeId: id,
      entryStatus: 1, entryTime: closureTime(Date.now() - 1000), idType: 5, idNumber: synthetic })
    const rehired = closureData(await api.getBusiness(`/hrm/employee/get?id=${id}`))
    const quitInfo = closureData(await api.getBusiness(`/hrm/employee/quit-info/get?employeeId=${id}`))
    const changes = closureList(await api.getBusiness(`/hrm/employee/change-record/list?employeeId=${id}`))
    closureCheck(caseRecord, HRM_LOCAL_CHECKS.rehire,
      rehired?.entryStatus === 1 && String(rehired.id) === id && String(rehired.userId) === actor.userId &&
      quitInfo == null && changes.some((row) => String(row.employeeId) === id),
      `employeeId=${id}; userId=${actor.userId}; changes=${changes.length}; quitInfoCleared=${quitInfo == null}`)
    if (page && outputDir) {
      await (dependencies.showClosureRow || showClosureRow)({ page, api, marker, outputDir, record,
        component: 'hrm/employee/index', placeholder: '请输入工号' })
      closureCheck(caseRecord, 'HRM headed 页面按真实菜单精确显示本轮员工', true, marker)
    }
    caseRecord.evidence.push(`正式 HRM 独立夹具 ${marker}：建档、重复绑定拒绝、导出、离职与复职均经真实 API 回读`)
  } catch (error) {
    primaryError = error
  } finally {
    try { await cleanup.cleanup() } catch (error) {
      primaryError = primaryError ? new AggregateError([primaryError, error], primaryError.message) : error
    }
    finalizeLocalAssertions(caseRecord, HRM_LOCAL_ASSERTIONS, hrmEvidence)
  }
  if (primaryError) throw primaryError
  return { ...finalizeLocalAssertions(caseRecord, HRM_LOCAL_ASSERTIONS, hrmEvidence) }
}
