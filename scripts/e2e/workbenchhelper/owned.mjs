import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { createApiClient, checkHealth } from '../lib/api.mjs'
import { launchBrowser, login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import {
  assertLocalWorkbenchWriteTarget,
  inspectWorkbenchFixtureTarget,
  isWorkbenchWriteFixturesEnabled
} from './fixture.mjs'
import { ownedCaseConclusion, recordCatalogAssertion } from './contracts.mjs'

export const OWNED_CASE_PERMISSIONS = Object.freeze({
  'WBF-004': ['pm:daily-report:query', 'crm:work-report:query',
    'crm:work-report:create', 'crm:work-report:delete'],
  'WBF-005': ['erp:purchase-order:query', 'erp:purchase-order:create', 'base:material-grade:query'],
  'WBF-008': ['pm:daily-report:query', 'crm:work-report:query',
    'crm:work-report:create', 'crm:work-report:delete'],
  'WBF-009': [],
  'WBF-012': ['pm:daily-report:query', 'crm:work-report:query',
    'crm:work-report:create', 'crm:work-report:delete']
})

export const SECTION_SELECTORS = Object.freeze({
  'quick-actions': '.quick-actions-strip',
  todo: '.todo-panel',
  schedule: '.schedule-panel',
  message: '.message-panel',
  announcement: '.announcement-panel',
  focus: '.focus-panel',
  report: '.report-panel',
  culture: '.culture-panel',
  document: '.document-panel',
  contact: '.contact-panel',
  performance: '.performance-panel'
})

const flatten = (rows = []) => rows.flatMap((row) => [row, ...flatten(row.children || [])])
const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const numericId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value)) ||
    (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error('无效的专属夹具 ID')
  return String(value)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (caseRecord, name, passed, details = '') =>
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
const navigation = (tools, page, selector) => (tools.openRoute || openRoute)(
  page, '/index', { readySelector: selector }
)
const screenshot = (tools, page, outputDir, name, record) =>
  (tools.saveScreenshot || saveScreenshot)(page, outputDir, name, record)

export function normalizeOwnedPermissions (values) {
  if (!Array.isArray(values)) throw new Error('专属账号权限响应不是数组')
  const normalized = values
    .map((value) => typeof value === 'string' ? value.trim() : value)
    .filter((value) => value !== '' && value != null)
  if (normalized.some((value) => typeof value !== 'string' || value.includes('*'))) {
    throw new Error('专属账号权限包含非字符串或通配符')
  }
  return normalized
}

export function assertFixtureActor (auth, caseId) {
  const required = [
    'system:menu:query', 'system:role:create', 'system:role:query', 'system:role:delete',
    'system:user:create', 'system:user:query', 'system:user:delete', 'system:user:update',
    'system:permission:assign-role-menu'
  ]
  if (caseId === 'WBF-009') required.push('system:portal:save', 'system:portal:query')
  if (!auth?.user?.id || !Array.isArray(auth.permissions)) throw new Error('BLOCKED: 管理员身份响应无效')
  const missing = auth.permissions.includes('*:*:*') ? [] : required.filter((key) => !auth.permissions.includes(key))
  if (missing.length) throw new Error(`BLOCKED: 创建/清理夹具所需正式权限不足：${missing.join(',')}；未写入`)
}

export async function expectPermissionDenied (api, pathname) {
  try {
    const payload = await api.get(pathname)
    return { passed: payload?.code === 403 && payload?.success !== true, payload }
  } catch (error) {
    if (String(error.message).startsWith(`HTTP 403 GET ${pathname}:`)) {
      return { passed: true, httpStatus: 403, message: '正式 HTTP 403；原始响应见 record.api' }
    }
    throw error
  }
}

export async function restoreOwnedPreference (api, key, baseline, caseRecord) {
  try {
    dataOf(await api.put(`/system/user-preference/save?key=${key}`, { value: baseline }), '专属偏好基线恢复')
    const actual = dataOf(await api.get(`/system/user-preference/get?key=${key}`), '偏好恢复回读')
    if (actual !== baseline) throw new Error('恢复后的 API 值与本轮基线不符')
    for (const row of caseRecord.fixtureResiduals || []) {
      if (row.type === 'preference' && row.key === key) row.restored = true
    }
    check(caseRecord, `专属偏好最终基线还原：${key}`, true, baseline)
  } catch (error) {
    check(caseRecord, `专属偏好最终基线还原：${key}`, false, error.message)
    caseRecord.notes.push(`偏好未还原：${key}；${error.message}`)
  }
}

export function selectOwnedMenuIds (menuRows, availableRows, permissions) {
  if (!Array.isArray(menuRows) || !Array.isArray(availableRows) || !Array.isArray(permissions) ||
    permissions.some((permission) => typeof permission !== 'string' || permission.includes('*'))) {
    throw new Error('BLOCKED: 最小菜单授权输入无效')
  }
  const menus = flatten(menuRows)
  const available = new Set(flatten(availableRows).map((row) => String(row.id)))
  const byId = new Map(menus.map((row) => [String(row.id), row]))
  const home = menus.filter((row) =>
    String(row.component || '').replace(/\.vue$/, '') === 'Home/SystemIndex')
  if (home.length !== 1) throw new Error('BLOCKED: 工作台页面菜单未唯一确定；未创建专属账号')
  // 真实菜单表中同一 permission 常被目录页与其按钮复用（例如 pm:report:query 有 20+ 条），
  // 因此这里按「租户套餐内优先 -> 层级更深（更贴近叶子按钮）-> id 更大」做确定性择一，
  // 父链的套餐范围与越权权限仍由下方 walking 校验兜底。
  const menuDepth = (row) => {
    let depth = 0
    let current = row
    const seen = new Set()
    while (current) {
      const parentId = String(current.parentId ?? 0)
      if (parentId === '0' || seen.has(parentId)) break
      seen.add(parentId)
      depth++
      current = byId.get(parentId)
    }
    return depth
  }
  const selected = [home[0]]
  for (const permission of permissions) {
    const candidates = menus.filter((row) => row.permission === permission && row.status === 0)
    if (candidates.length === 0) {
      throw new Error(`BLOCKED: 权限菜单缺失、禁用或不唯一：${permission}；未创建专属账号`)
    }
    candidates.sort((a, b) =>
      Number(available.has(String(b.id))) - Number(available.has(String(a.id))) ||
      menuDepth(b) - menuDepth(a) ||
      Number(b.id) - Number(a.id))
    selected.push(candidates[0])
  }
  const ids = new Set()
  for (const leaf of selected) {
    let row = leaf
    const seen = new Set()
    while (row) {
      const id = String(row.id)
      if (seen.has(id)) throw new Error('BLOCKED: 菜单父链存在循环')
      seen.add(id)
      if (row.status !== 0 || !available.has(id)) {
        throw new Error(`BLOCKED: 菜单 ${id} 不在启用/租户套餐范围；未创建专属账号`)
      }
      // 目录（type=1）在 CFOR 设置树中复用了 system:settings:query 这类菜单分组键，
      // 它们只决定目录可见性、没有任何后端 @PreAuthorize 引用，属于到达叶子的结构性骨架；
      // 页面（type=2）和按钮（type=3）父节点的越权权限仍然必须拦截，避免扩大真实授权。
      const directoryScaffold = Number(row.type) === 1
      if (row.permission && !permissions.includes(row.permission) && !directoryScaffold) {
        throw new Error(`BLOCKED: 父菜单携带范围外权限 ${row.permission}，不扩大授权`)
      }
      ids.add(id)
      const parentId = String(row.parentId ?? 0)
      if (parentId === '0') break
      row = byId.get(parentId)
      if (!row) throw new Error(`BLOCKED: 菜单父链缺失 ${parentId}`)
    }
  }
  return [...ids]
}

// Every destructive operation is tied to a returned ID and a fresh marker read.
export function createOwnedRegistry (marker, caseRecord) {
  if (!/^E2E-WBF-[A-Z0-9-]+$/.test(marker)) throw new Error('无效的工作台所有权 marker')
  const entries = []
  const add = (entry) => {
    numericId(entry.id)
    if (!entry.read || !entry.remove || !entry.matches) throw new Error('缺少所有权回读或清理契约')
    if (entries.some((row) => row.type === entry.type && String(row.id) === String(entry.id))) {
      throw new Error('专属对象重复登记')
    }
    const owned = { ...entry, cleaned: false }
    entries.push(owned)
    caseRecord.fixtureObjects = [...(caseRecord.fixtureObjects || []), {
      type: entry.type, id: String(entry.id), marker
    }]
    return owned
  }
  const cleanup = async () => {
    const failures = []
    for (const entry of [...entries].reverse()) {
      if (entry.cleaned) continue
      try {
        const row = await entry.read()
        if (!row || !entry.matches(row, marker)) {
          throw new Error('所有权回读不符；拒绝删除')
        }
        await entry.remove()
        if (entry.verifyRemoved && !await entry.verifyRemoved()) {
          throw new Error('清理后正式回读未证实对象已删除')
        }
        entry.cleaned = true
      } catch (error) {
        failures.push({ type: entry.type, id: entry.id, reason: error.message })
      }
    }
    caseRecord.fixtureCleanup = {
      marker,
      cleaned: entries.filter((entry) => entry.cleaned).map(({ type, id }) => ({ type, id })),
      remaining: failures
    }
    if (failures.length) {
      check(caseRecord, '本轮专属对象清理完成', false, JSON.stringify(failures))
    }
    return failures
  }
  return { add, cleanup, entries }
}

export async function createOwnedAccount ({ api, registry, marker, menuIds, tag, caseRecord }) {
  const code = `${marker}-${tag}`
  let account
  const roleId = numericId(dataOf(await api.post('/system/role/create', {
    name: code.slice(0, 30), code, sort: 999, status: 0, remark: marker
  }), '专属角色创建'))
  registry.add({
    type: 'role', id: roleId,
    read: async () => dataOf(await api.get(`/system/role/get?id=${roleId}`), '角色所有权回读'),
    matches: (row) => row.code === code && row.remark === marker && row.type === 2,
    remove: async () => {
      if (account?.hasResidualReports) {
        throw new Error('本轮报告尚未清理，保留专属恢复角色')
      }
      dataOf(await api.delete(`/system/role/delete?id=${roleId}`), '删除本轮角色')
    },
    verifyRemoved: async () => dataOf(await api.get(`/system/role/get?id=${roleId}`), '角色清理回读') === null
  })
  const role = dataOf(await api.get(`/system/role/get?id=${roleId}`), '专属角色回读')
  if (role.status !== 0 || role.dataScope !== 5) throw new Error('专属角色未保持启用/仅本人范围')
  dataOf(await api.post('/system/permission/assign-role-menu', { roleId, menuIds }), '分配本轮菜单')
  const assigned = dataOf(await api.get(`/system/permission/list-role-menus?roleId=${roleId}`), '回读角色菜单')
  if (!Array.isArray(assigned) ||
    !same(assigned.map(String).sort(), [...menuIds].sort())) throw new Error('角色菜单与最小授权不一致')
  const username = `autotestwbf${randomBytes(5).toString('hex')}${tag}`.slice(0, 30)
  const password = `Auto!${randomBytes(3).toString('hex')}Aa9`
  const userId = numericId(dataOf(await api.post('/system/user/create', {
    username, nickname: code.slice(0, 30), workNo: code.slice(0, 30),
    password, sex: 0, postIds: [], roleIds: [roleId], remark: marker
  }), '专属账号创建'))
  account = { userId, roleId, username, menuIds, hasPreferences: false, hasResidualReports: false }
  registry.add({
    type: 'user', id: userId,
    read: async () => dataOf(await api.get(`/system/user/get?id=${userId}`), '用户所有权回读'),
    matches: (row) => row.username === username && row.remark === marker,
    remove: async () => {
      if (account.hasResidualReports || account.hasPreferences) {
        dataOf(await api.put('/system/user/update-status', { id: userId, status: 1 }), '停用专属账号')
        caseRecord.fixtureResiduals = [...(caseRecord.fixtureResiduals || []), {
          type: 'disabled-user', id: userId, username, marker,
          reason: account.hasResidualReports ? '报告清理未完成，保留归属账号' : '偏好无删除 API，保留停用归属账号'
        }]
      } else {
        dataOf(await api.delete(`/system/user/delete?id=${userId}`), '删除本轮账号')
      }
    },
    verifyRemoved: async () => {
      const row = dataOf(await api.get(`/system/user/get?id=${userId}`), '账号清理回读')
      return account.hasResidualReports || account.hasPreferences ? row?.status === 1 : row === null
    }
  })
  const user = dataOf(await api.get(`/system/user/get?id=${userId}`), '专属账号回读')
  if (user.username !== username || user.status !== 0 ||
    !same((user.roleIds || []).map(String), [roleId])) throw new Error('专属账号状态或角色回读不符')
  caseRecord.accounts = [...(caseRecord.accounts || []), { userId, roleId, username, menuIds, marker }]
  return { ...account, credentials: { username, password, tenantName: 'CFOR 标准平台' },
    state: account }
}

export async function createPortal ({ api, registry, marker, account, sections, caseRecord }) {
  const portalId = numericId(dataOf(await api.post('/system/portal/create', {
    name: marker, code: marker, sections, sort: 999, status: 0,
    remark: marker, roleIds: [account.roleId]
  }), '专属门户创建'))
  const read = async () => dataOf(await api.get(`/system/portal/get?id=${portalId}`), '门户所有权回读')
  const matches = (row) => row.code === marker && row.remark === marker &&
    same((row.roleIds || []).map(String), [account.roleId])
  const entry = registry.add({
    type: 'portal', id: portalId, read, matches,
    remove: async () => dataOf(await api.delete(`/system/portal/delete?id=${portalId}`), '删除本轮门户'),
    verifyRemoved: async () => await read() === null
  })
  const row = await read()
  if (!matches(row) || !same(row.sections, sections)) throw new Error('门户区块或本轮角色回读不符')
  caseRecord.businessIds = [...(caseRecord.businessIds || []), { type: 'portal', id: portalId, marker }]
  return {
    portalId,
    async remove () {
      if (!matches(await read())) throw new Error('专属门户所有权变化，停止删除')
      await entry.remove()
      if (!await entry.verifyRemoved()) throw new Error('专属门户删除后仍可读取')
      entry.cleaned = true
    }
  }
}

export async function newOwnedBrowser ({ account, record, outputDir, caseRecord, tools = {} }) {
  const handle = await (tools.launchBrowser || launchBrowser)({ headed: true, record })
  try {
    const session = await (tools.login || login)(handle.page, {
      credentials: account.credentials, returnContext: true
    })
    if (!session?.token || String(session.tenantId) !== '1') throw new Error('BLOCKED: 专属账号登录未证明租户 1')
    const api = (tools.createApiClient || createApiClient)({ token: session.token, tenantId: '1', record })
    const permission = dataOf(await api.get('/system/auth/get-permission-info'), '专属账号权限回读')
    const actualPermissions = normalizeOwnedPermissions(permission.permissions)
    if (String(permission.user?.id) !== account.userId ||
      permission.roles?.includes('super_admin')) {
      throw new Error('专属账号身份或权限出现范围外结果')
    }
    permission.permissions = actualPermissions
    // Credential entry is excluded from this fixture's trace.
    await handle.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    caseRecord.evidence.push(JSON.stringify({
      stage: 'owned-login', userId: account.userId, roleId: account.roleId,
      permissions: permission.permissions, landingPath: permission.landingPath,
      portalCode: permission.portalCode, portalSections: permission.portalSections
    }))
    return { ...handle, api, token: session.token, permission }
  } catch (error) {
    await screenshot(tools, handle.page, outputDir, `${account.username}-login-blocked`, record).catch(() => {})
    await closeOwnedBrowser(handle, outputDir, account.username, caseRecord)
    throw error
  }
}

async function closeOwnedBrowser (handle, outputDir, tag, caseRecord) {
  await handle.flushResponses?.().catch(() => {})
  const trace = path.join(outputDir, `${tag}-trace.zip`)
  await handle.context.tracing.stop({ path: trace }).then(() => caseRecord.evidence.push(trace))
    .catch(() => caseRecord.notes.push('专属 Chrome trace 未生成；不作为已完成证据'))
  await handle.context.close().catch(() => {})
  await handle.browser.close().catch(() => {})
}

export async function saveOwnedPreference (account, api, key, value, caseRecord) {
  numericId(account.userId)
  if (!account.state || !/^[a-z0-9._-]{1,100}$/.test(key)) throw new Error('无效的专属用户偏好契约')
  const previous = dataOf(await api.get(`/system/user-preference/get?key=${key}`), '偏好写入前回读')
  if (previous !== null) throw new Error('BLOCKED: 本轮首次偏好已存在，拒绝覆盖未知基线')
  const encoded = JSON.stringify(value)
  dataOf(await api.put(`/system/user-preference/save?key=${key}`, { value: encoded }), '专属偏好保存')
  account.state.hasPreferences = true
  const actual = dataOf(await api.get(`/system/user-preference/get?key=${key}`), '专属偏好回读')
  if (actual !== encoded) throw new Error('专属偏好保存值与 API 回读不符')
  caseRecord.fixtureResiduals = [...(caseRecord.fixtureResiduals || []), {
    type: 'preference', userId: account.userId, key, value: encoded,
    reason: '当前正式 API 无删除偏好接口；结束时恢复本轮建立的基线并停用账号'
  }]
  return encoded
}

export function draftPayloads (marker, today) {
  if (!/^E2E-WBF-[A-Z0-9-]+$/.test(marker) || !/^\d{4}-\d{2}-\d{2}$/.test(today) ||
    new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10) !== today) {
    throw new Error('无效的专属报告 marker 或日期')
  }
  const [year, month] = today.split('-').map(Number)
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const monday = new Date(`${today}T00:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(sunday.getUTCDate() + 6)
  return ['WEEKLY', 'MONTHLY'].map((reportType) => ({
    reportType, periodStart: reportType === 'WEEKLY' ? monday.toISOString().slice(0, 10) : monthStart,
    periodEnd: reportType === 'WEEKLY' ? sunday.toISOString().slice(0, 10) : monthEnd,
    contractAmount: 1234.5, receivableAmount: 321.25,
    completionRate: 73, riskCount: 2, summary: `${marker}-${reportType}`,
    unresolvedReason: marker, coordination: marker, aiConfirmed: false, plans: []
  }))
}

export async function createDrafts ({ account, ownApi, registry, marker, today, caseRecord }) {
  const ids = []
  for (const payload of draftPayloads(marker, today)) {
    const id = numericId(dataOf(await ownApi.post('/crm/work-report/create', payload), '创建本人专属报告草稿'))
    ids.push(id)
    account.state.hasResidualReports = true
    registry.add({
      type: 'crm-report', id,
      read: async () => dataOf(await ownApi.get(`/crm/work-report/get?id=${id}`), '报告所有权回读'),
      matches: (row) => row.summary === payload.summary && row.status === 'DRAFT' &&
        String(row.ownerUserId) === account.userId,
      remove: async () => {
        dataOf(await ownApi.delete(`/crm/work-report/delete?id=${id}`), '删除本人本轮草稿')
        ids.splice(ids.indexOf(id), 1)
        account.state.hasResidualReports = ids.length > 0
      }
    })
    const row = dataOf(await ownApi.get(`/crm/work-report/get?id=${id}`), '草稿正式 API 回读')
    check(caseRecord, `${payload.reportType}专属草稿字段/归属/状态回读`,
      row.reportType === payload.reportType && row.summary === payload.summary &&
      row.status === 'DRAFT' && row.aiConfirmed === false &&
      String(row.ownerUserId) === account.userId &&
      row.periodStart === payload.periodStart && row.periodEnd === payload.periodEnd &&
      Number(row.contractAmount) === 1234.5 && Number(row.receivableAmount) === 321.25 &&
      Number(row.completionRate) === 73 && row.riskCount === 2,
      `id=${id}；owner=${row.ownerUserId}；status=${row.status}`)
    caseRecord.businessIds = [...(caseRecord.businessIds || []), { type: 'crm-report', id, marker }]
  }
  return [...ids]
}

export async function verifyPortal ({ handle, portal, marker, sections, caseRecord, outputDir, record, tools = {} }) {
  const inspect = async (configured) => {
    const auth = dataOf(await handle.api.get('/system/auth/get-permission-info'), '门户身份回读')
    const matched = configured ? auth.portalCode === marker && same(auth.portalSections, sections)
      : !auth.portalCode && (!auth.portalSections || auth.portalSections.length === 0)
    check(caseRecord, configured ? '专属角色命中 portalCode/portalSections' : '删除专属绑定后无门户配置',
      matched,
      JSON.stringify({ portalCode: auth.portalCode, portalSections: auth.portalSections }))
    if (configured) recordCatalogAssertion(caseRecord, 'WBF-009', 0,
      matched ? 'VERIFIED' : 'FAILED', `专属角色 ${handle.permission?.roles?.join(',') || '已回读'}；portalCode=${auth.portalCode}`)
    await navigation(tools, handle.page, '.personal-workbench')
    const visible = []
    for (const [key, selector] of Object.entries(SECTION_SELECTORS)) {
      if (await handle.page.locator(selector).first().isVisible()) visible.push(key)
    }
    const expected = configured ? sections : Object.keys(SECTION_SELECTORS)
    check(caseRecord, configured ? 'DOM 与专属门户组合完整一致' : '无配置默认全部 11 区块',
      same([...visible].sort(), [...expected].sort()),
      `expected=${expected.join(',')}；visible=${visible.join(',')}`)
    recordCatalogAssertion(caseRecord, 'WBF-009', configured ? 1 : 2,
      matched && same([...visible].sort(), [...expected].sort()) ? 'VERIFIED' : 'FAILED',
      `配置=${expected.join(',')}；可见=${visible.join(',')}；本轮${configured ? '命中' : '删除'}专属门户`)
    check(caseRecord, '门户聚合仍在 /index', new URL(handle.page.url()).pathname === '/index')
    await screenshot(tools, handle.page, outputDir, configured ? 'wbf009-owned-portal' : 'wbf009-owned-default', record)
  }
  await inspect(true)
  await portal.remove()
  await inspect(false)
}

export function validatePurchaseSequence (billNo, before, after) {
  if (!/^CGDD\d{9}$/.test(billNo) || !before.available || !after.available) {
    throw new Error('采购编号或取号前后数据库契约无效')
  }
  const date = billNo.slice(4, 10)
  const key = `CGDD${date}RESET${date}TENANT1`
  const pre = before.rows.filter(([k, tenant]) => k === key && tenant === '1')
  const post = after.rows.filter(([k, tenant]) => k === key && tenant === '1')
  if (pre.length > 1 || post.length !== 1 || (pre.length && !/^\d+$/.test(pre[0][2])) ||
    !/^\d+$/.test(post[0][2])) throw new Error('采购取号 key/租户/序列唯一性回读无效')
  const prior = pre.length ? Number(pre[0][2]) : 0
  const assigned = Number(billNo.slice(-3))
  return { key, prior, assigned, after: Number(post[0][2]),
    passed: assigned > prior && Number(post[0][2]) >= assigned }
}

export async function verifyPurchase ({ account, handle, caseRecord, outputDir, record, tools = {} }) {
  const readSql = tools.runReadOnlySql || runReadOnlySql
  const baseline = await saveOwnedPreference(account, handle.api, 'workbench.quick-actions', [
    { id: 'purchase-order-create', iconKey: 'plus' },
    { id: 'purchase-execution-report', iconKey: 'dataBoard' }
  ], caseRecord)
  const orderWrites = []
  const onRequest = (request) => {
    if (/\/erp\/purchase-order\/(create|update)$/.test(new URL(request.url()).pathname) &&
      ['POST', 'PUT'].includes(request.method())) orderWrites.push(request.url())
  }
  handle.page.on('request', onRequest)
  try {
    await navigation(tools, handle.page, '.quick-actions-strip')
    const quick = handle.page.locator('.quick-actions-strip').first()
    const create = quick.getByRole('button', { name: '新增采购订单', exact: true })
    const execution = quick.getByRole('button', { name: '采购执行表', exact: true })
    const visible = await create.isVisible() && await execution.isVisible()
    check(caseRecord, '两个采购快捷动作可见', visible)
    recordCatalogAssertion(caseRecord, 'WBF-005', 0, visible ? 'VERIFIED' : 'FAILED',
      '本轮专属用户快捷偏好已正式 API 回读；DOM 检查两个采购按钮')
    if (!visible) throw new Error('专属采购快捷未展示，停止取号')
    const rule = dataOf(await handle.api.get(
      '/mes/fillRule/list?pageNo=1&pageSize=100&ruleCode=erp_purchase_no'
    ), '当前采购取号规则只读回读')
    const candidates = rule?.records?.filter((row) => row.ruleCode === 'erp_purchase_no' && row.status === 'PUBLISHED')
    const params = candidates?.length === 1 ? JSON.parse(candidates[0].ruleParams) : null
    if (!Array.isArray(candidates) || candidates.length !== 1 ||
      !candidates[0].ruleClass?.endsWith('.BillNoRule') ||
      params?.prefix !== 'CGDD' || params?.period !== 'yyMMdd' || params?.seqLen !== 3 ||
      !same(Object.keys(params || {}).sort(), ['period', 'prefix', 'seqLen'])) {
      throw new Error('BLOCKED: 采购正式规则契约变化，未取号，不修改共享规则')
    }
    const before = await readSql("SELECT k, tenant_id, v FROM mes_bas_sequence WHERE tenant_id=1 AND k LIKE 'CGDD%'")
    if (!before.available) throw new Error('BLOCKED: 缺少取号前 DB 证据，未打开新增')
    caseRecord.database = [...(caseRecord.database || []), { stage: 'purchase-sequence-before', ...before }]
    const responsePromise = handle.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/mes/fillRule/executeRuleByCode/erp_purchase_no') &&
      response.request().method() === 'PUT', { timeout: 15000 })
    await create.click()
    const response = await responsePromise
    const billNo = dataOf(await tools.readBrowserResponsePayload(response), '采购正式取号')
    if (!response.ok() || typeof billNo !== 'string' || !/^CGDD\d{9}$/.test(billNo)) {
      throw new Error('采购正式取号响应格式无效')
    }
    caseRecord.businessIds = [...(caseRecord.businessIds || []), {
      type: 'consumed-purchase-number', billNo, reason: '打开表单正式取号；不回滚号段，不保存订单'
    }]
    const form = handle.page.locator('.com-dialog:visible').last()
    await form.waitFor({ state: 'visible', timeout: 20000 })
    await form.locator('.subtitle', { hasText: '存货清单' }).first().waitFor({ state: 'visible' })
    await form.locator('input:visible').first().waitFor({ state: 'visible' })
    const values = await form.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value))
    check(caseRecord, '新增采购表单显示真实分配编号', values.includes(billNo), `billNo=${billNo}`)
    await screenshot(tools, handle.page, outputDir, 'wbf005-owned-new-number', record)
    await form.getByRole('button', { name: /取\s*消/ }).last().click()
    await form.waitFor({ state: 'hidden' })
    const after = await readSql("SELECT k, tenant_id, v FROM mes_bas_sequence WHERE tenant_id=1 AND k LIKE 'CGDD%'")
    caseRecord.database.push({ stage: 'purchase-sequence-after', ...after })
    const sequence = validatePurchaseSequence(billNo, before, after)
    check(caseRecord, '取号序列回读包含本次正式号码', sequence.passed, JSON.stringify(sequence))
    const promise = handle.page.waitForResponse((candidate) =>
      new URL(candidate.url()).pathname.endsWith('/erp/purchase-order/page') &&
      candidate.request().method() === 'GET', { timeout: 15000 })
    await execution.click()
    const dialog = handle.page.getByRole('dialog', { name: '采购执行表' }).first()
    await dialog.waitFor({ state: 'visible' })
    const captured = await promise
    const pageData = dataOf(await tools.readBrowserResponsePayload(captured), '采购执行分页')
    if (!captured.ok() || !Array.isArray(pageData?.list) || !Number.isInteger(pageData.total) ||
      pageData.total < pageData.list.length || pageData.list.length > 100) {
      throw new Error('采购执行分页业务契约无效')
    }
    await dialog.locator('.el-loading-mask').first().waitFor({ state: 'hidden' })
    await dialog.locator('.search-form').waitFor({ state: 'visible' })
    check(caseRecord, '采购执行表弹窗可见且路由仍 /index',
      await dialog.isVisible() && new URL(handle.page.url()).pathname === '/index',
      `真实返回 ${pageData.list.length}/${pageData.total}；空集仅作列表契约，不证明订单链路`)
    recordCatalogAssertion(caseRecord, 'WBF-005', 1,
      await dialog.isVisible() ? 'VERIFIED' : 'FAILED',
      `真实执行表响应=${pageData.list.length}/${pageData.total}；已等待表单和加载结束`)
    await screenshot(tools, handle.page, outputDir, 'wbf005-owned-execution', record)
    await dialog.locator('.el-dialog__headerbtn').first().click()
    await dialog.waitFor({ state: 'hidden' })
    const persisted = dataOf(await handle.api.get(
      `/erp/purchase-order/page?pageNo=1&pageSize=100&billNo=${encodeURIComponent(billNo)}`
    ), '取号未保存订单回读')
    const finalRoute = new URL(handle.page.url()).pathname
    check(caseRecord, '关闭两个弹窗不新增订单且仍在工作台',
      orderWrites.length === 0 && Array.isArray(persisted.list) &&
      persisted.list.length === 0 && persisted.total === 0 && finalRoute === '/index',
      `create/update请求=${orderWrites.length}；分配号码对应订单=${persisted.total}`)
    recordCatalogAssertion(caseRecord, 'WBF-005', 2, finalRoute === '/index' ? 'VERIFIED' : 'FAILED',
      `新增/执行两个弹窗关闭后真实路由=${finalRoute}`)
  } finally {
    handle.page.off('request', onRequest)
    await restoreOwnedPreference(handle.api, 'workbench.quick-actions', baseline, caseRecord)
  }
}

export function expectedReminders (pages, today) {
  const daily = pages.DAILY.list.filter((row) => row.periodKey?.startsWith(today.slice(0, 7)))
  const covering = (rows) => rows.filter((row) => row.periodStart <= today && row.periodEnd >= today)
  const weekly = covering(pages.WEEKLY.list)
  const monthly = covering(pages.MONTHLY.list)
  const pending = (rows) => rows.filter((row) => row.status === 'SUBMITTED').length
  return [
    [daily.some((row) => row.periodKey === today) ? '今日日报已填写' : '今日日报未填写',
      `本月日报 已填 ${daily.length} · 待审批 ${pending(daily)}`],
    [weekly.length ? '本周周报已提交' : '本周周报未填写',
      `待审批 ${pending(weekly)} · 截止 ${weekly[0]?.deadline?.slice(5, 10) || '未设置'}`],
    [monthly.length ? '本月月报已提交' : '本月月报未填写',
      `待审批 ${pending(monthly)} · 截止 ${monthly[0]?.deadline?.slice(5, 10) || '未设置'}`]
  ]
}

export function draftReminderMismatches (pages, actual, today) {
  return ['WEEKLY', 'MONTHLY'].filter((type, index) => {
    const covering = pages[type].list.filter((row) =>
      row.periodStart <= today && row.periodEnd >= today)
    return covering.length > 0 && covering.every((row) => row.status === 'DRAFT') &&
      actual[index + 1]?.[0]?.includes('已提交')
  })
}

export async function verifyPreferences ({ account, handle, pages, today, caseRecord, outputDir, record, tools = {}, adminApi }) {
  const key = 'workbench.report.weekly-metrics'
  const baseline = await saveOwnedPreference(account, handle.api, key, ['completionRate', 'riskCount'], caseRecord)
  try {
    const adminBaseline = dataOf(await adminApi.get(`/system/user-preference/get?key=${key}`), '管理员偏好只读基线')
    const captured = await tools.captureWorkbenchReports(handle.page,
      () => navigation(tools, handle.page, '.report-panel'), account.userId)
    if (captured.missing.length) throw new Error(captured.missing.join('；'))
    pages = captured.pages
    const panel = handle.page.locator('.report-panel').first()
    await tools.waitForReportRendering(panel)
    const expected = expectedReminders(pages, today)
    const actual = await panel.locator('.focus-body .work-list-row').evaluateAll((rows) =>
      rows.filter((row) => !row.querySelector('.el-tag')).map((row) => [
        row.querySelector('strong')?.textContent.trim(), row.querySelector('small')?.textContent.trim()
      ]))
    const allKinds = actual.length === 3 && ['日报', '周报', '月报'].every((kind, index) =>
      actual[index]?.[0]?.includes(kind))
    const countsMatch = allKinds && actual.every((row, index) => row[1] === expected[index][1] &&
      (expected[index][0].includes('未填写') ? row[0].includes('未填写') : !row[0].includes('未填写')))
    check(caseRecord, '三类提醒精确匹配正式 API 已填/未填/待审批口径',
      countsMatch, JSON.stringify({ actual, expected }))
    recordCatalogAssertion(caseRecord, 'WBF-008', 0, allKinds ? 'VERIFIED' : 'FAILED',
      `真实 DOM 三类提醒=${JSON.stringify(actual)}`)
    const draftsNamedSubmitted = draftReminderMismatches(pages, actual, today)
    check(caseRecord, '草稿提醒不得被称为已提交', draftsNamedSubmitted.length === 0,
      `真实 DRAFT 覆盖当前周期=${draftsNamedSubmitted.join(',')}；DOM=${actual.map((row) => row[0]).join(',')}`)
    recordCatalogAssertion(caseRecord, 'WBF-008', 1,
      countsMatch && draftsNamedSubmitted.length === 0 ? 'VERIFIED' : 'FAILED',
      `正式 API 当前周期记录/状态与提醒逐项比较=${JSON.stringify({ actual, expected })}`)
    for (const type of ['DAILY', 'WEEKLY', 'MONTHLY']) {
      if (pages[type].total > pages[type].list.length) {
        check(caseRecord, `${type}提醒未截断`, false, `只载入 ${pages[type].list.length}/${pages[type].total}，汇总不完整`)
      }
    }
    await panel.getByRole('button', { name: '格式', exact: true }).click()
    const dialog = handle.page.getByRole('dialog', { name: '个人周报格式' }).first()
    await dialog.waitFor({ state: 'visible' })
    for (const label of ['合同额', '回款额', '完成率', '风险数']) {
      // Element Plus 的真实 input 为零尺寸，Playwright 判定不可见；点击可见的勾选框皮肤。
      const wantChecked = ['合同额', '回款额'].includes(label)
      const option = dialog.locator('.el-checkbox').filter({ hasText: label }).first()
      const input = option.locator('input[type="checkbox"]')
      if ((await input.isChecked()) !== wantChecked) {
        await option.locator('.el-checkbox__inner').click()
      }
    }
    const saved = handle.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/system/user-preference/save') &&
      new URL(response.url()).searchParams.get('key') === key &&
      response.request().method() === 'PUT', { timeout: 15000 })
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    const response = await saved
    if (!response.ok()) throw new Error('真实 UI 偏好保存 HTTP 失败')
    dataOf(await tools.readBrowserResponsePayload(response), '真实 UI 偏好保存')
    await dialog.waitFor({ state: 'hidden' })
    const value = dataOf(await handle.api.get(`/system/user-preference/get?key=${key}`), 'UI 保存值回读')
    const savedExactly = value === '["contractAmount","receivableAmount"]'
    check(caseRecord, '周报格式 UI 保存精确字段', savedExactly, value)
    const sql = await (tools.runReadOnlySql || runReadOnlySql)(`
      SELECT user_id, preference_key, preference_value, tenant_id
      FROM system_user_preference WHERE deleted=0 AND tenant_id=1
      AND user_id=${numericId(account.userId)} AND preference_key='${key}'
    `)
    caseRecord.database = [...(caseRecord.database || []), { stage: 'weekly-preference-ui-save', ...sql }]
    const persisted = sql.available && sql.rows.length === 1 && sql.rows[0][0] === account.userId &&
      sql.rows[0][1] === key && sql.rows[0][2] === value && sql.rows[0][3] === '1'
    check(caseRecord, 'system_user_preference 按专属用户/租户落库', persisted, JSON.stringify(sql.rows))
    await navigation(tools, handle.page, '.report-panel')
    await panel.getByRole('button', { name: '格式', exact: true }).click()
    await dialog.waitFor({ state: 'visible' })
    const reflected = await dialog.getByRole('checkbox', { name: '合同额', exact: true }).isChecked() &&
      await dialog.getByRole('checkbox', { name: '回款额', exact: true }).isChecked() &&
      !await dialog.getByRole('checkbox', { name: '完成率', exact: true }).isChecked() &&
      !await dialog.getByRole('checkbox', { name: '风险数', exact: true }).isChecked()
    check(caseRecord, '刷新后周报格式回显已保存字段', reflected)
    await screenshot(tools, handle.page, outputDir, 'wbf008-owned-persisted-preference', record)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    const isolated = dataOf(await adminApi.get(`/system/user-preference/get?key=${key}`), '管理员偏好隔离回读') === adminBaseline
    check(caseRecord, '专属用户偏好不修改管理员偏好', isolated)
    recordCatalogAssertion(caseRecord, 'WBF-008', 2,
      savedExactly && persisted && reflected && isolated ? 'VERIFIED' : 'FAILED',
      `真实 UI 保存、API、DB、刷新及管理员隔离：user=${account.userId}；key=${key}；value=${value}`)
  } finally {
    await restoreOwnedPreference(handle.api, key, baseline, caseRecord)
  }
}

export function recordReadOnlyCoverage (caseId, caseRecord, childChecks) {
  const verified = (name) => childChecks.some((row) => row.name === name && row.passed === true)
  const record = (index, passed, details) => recordCatalogAssertion(
    caseRecord, caseId, index, passed ? 'VERIFIED' : 'UNVERIFIED', details)
  if (caseId === 'WBF-004') {
    const tabs = ['日报', '周报', '月报'].every((label) =>
      verified(`${label}实际切换并匹配当前用户真实响应（PB-359~365）`))
    record(0, tabs, '报告区块可见等待完成后，三个真实 GET 与 DOM 已逐项对齐')
    record(1, tabs, '真正点击三个页签，标题及当前用户归属匹配本轮响应；空集不证明非空/隔离增强断言')
    record(2, verified('工作报告区块保持在统一门户内'), '本轮真实 pathname 回读')
  } else if (caseId === 'WBF-012') {
    const cycles = ['month', 'quarter', 'year'].every((period) =>
      verified(`${period}/self真实范围请求与统计数值一致（PB-364）`))
    record(0, cycles, '统计弹窗通过真实操作打开，并捕获本人三类正式 GET')
    record(1, cycles, '三类统计行及四项状态数值逐条匹配正式响应；非空日报增强仍未完成')
    record(2, cycles, '本月、本季度、本年度均真实切换并验证选中及数值')
    record(3, false, '未发起未核实的 PMS 团队广范围查询；不能扩大角色授权解决')
    record(4, verified('关闭统计后仍停留在工作台'), '本轮关闭弹窗后实际 pathname 回读')
  }
}

export async function runOwnedWorkbenchCase (context, tools = {}) {
  const { caseId, api, token, record, caseRecord, outputDir, settings, sessionTenantId } = context
  if (!isWorkbenchWriteFixturesEnabled(tools.env || process.env)) throw new Error('BLOCKED: 未显式 opt-in，停止专属写侧')
  assertLocalWorkbenchWriteTarget(settings)
  const target = await inspectWorkbenchFixtureTarget({ api, settings, sessionTenantId })
  if (!target.allowed) throw new Error(`BLOCKED: ${target.reason}`)
  const health = await (tools.checkHealth || checkHealth)()
  if (!health.response?.ok || health.body?.status !== 'UP') throw new Error('BLOCKED: 后端未 UP，不启动写链')
  await (tools.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const permissions = OWNED_CASE_PERMISSIONS[caseId]
  if (!permissions) throw new Error('BLOCKED: 非专属工作台案例')
  assertFixtureActor(dataOf(await api.get('/system/auth/get-permission-info'), '夹具创建者权限回读'), caseId)
  const menus = dataOf(await api.get('/system/menu/list'), '菜单定义')
  const available = dataOf(await api.get('/system/menu/list-all-simple'), '租户可分配菜单')
  const menuIds = selectOwnedMenuIds(menus, available, permissions)
  // 目录骨架（type=1）自带的菜单分组键会随父链进入账号权限集合，
  // 它不来自本例显式申请的业务权限，也不对应任何后端 @PreAuthorize，比较时单列。
  const menuIdSet = new Set(menuIds.map(String))
  const scaffoldPermissions = new Set(
    menus
      .filter((row) => menuIdSet.has(String(row.id)) && Number(row.type) === 1 && row.permission)
      .map((row) => String(row.permission))
  )
  const marker = `E2E-WBF-${caseId.slice(-3)}-${randomBytes(5).toString('hex').toUpperCase()}`
  const registry = createOwnedRegistry(marker, caseRecord)
  const gaps = []
  let account
  let handle
  let result
  try {
    account = await createOwnedAccount({ api, registry, marker, menuIds, tag: 'owner', caseRecord })
    let portal
    const sections = ['quick-actions', 'schedule', 'report', 'contact']
    if (caseId === 'WBF-009') {
      portal = await createPortal({ api, registry, marker, account, sections, caseRecord })
    }
    handle = await newOwnedBrowser({ account, record, outputDir, caseRecord, tools })
    const requiredPermissions = normalizeOwnedPermissions(permissions)
    const actualPermissions = normalizeOwnedPermissions(handle.permission.permissions)
    const unexpected = actualPermissions.filter((permission) =>
      !requiredPermissions.includes(permission) && !scaffoldPermissions.has(permission))
    const missing = requiredPermissions.filter((permission) => !actualPermissions.includes(permission))
    if (unexpected.length || missing.length) throw new Error(
      `BLOCKED: 专属账号授权不符：额外=${unexpected.join(',')}；缺失=${missing.join(',')}`)
    if (caseId === 'WBF-009') {
      await verifyPortal({ handle, portal, marker, sections, caseRecord, outputDir, record, tools })
      // This account deliberately has no report-query grant. Never widen it.
      const denied = await expectPermissionDenied(handle.api, '/crm/work-report/page?pageNo=1&pageSize=100&reportType=WEEKLY')
      check(caseRecord, '无报告权限专属账号被正式 Controller 拒绝', denied.passed,
        JSON.stringify(denied).slice(0, 500))
      result = { token, api }
    } else if (caseId === 'WBF-005') {
      await verifyPurchase({ account, handle, caseRecord, outputDir, record, tools })
      result = { token, api }
    } else {
      const today = await handle.page.evaluate(() => {
        const now = new Date()
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      })
      await createDrafts({ account, ownApi: handle.api, registry, marker, today, caseRecord })
      gaps.push('增强验收未覆盖：PMS 日报非空/状态反例需要合法专属项目；不建 PB-001~005 规则、不写既有项目、不伪造 projectId。该规则不是 catalog UI 原断言共同门禁')
      const checkOffset = caseRecord.checks.length
      const child = await tools.runReadOnlyCase({
        caseId, page: handle.page, record, caseRecord, outputDir
      }, { env: {}, login: async () => handle.token, createApiClient: () => handle.api })
      recordReadOnlyCoverage(caseId, caseRecord, caseRecord.checks.slice(checkOffset))
      if (caseId === 'WBF-008') {
        await verifyPreferences({
          account, handle, today, caseRecord, outputDir, record, tools, adminApi: api
        })
      }
      if (caseId === 'WBF-012') {
        gaps.push('团队未点击：PMS 团队数据权限过滤未确认；CRM Mapper 固定仅本人，未扩大为全范围角色')
      }
      if (caseId === 'WBF-004') {
        gaps.push('日报非空和另一专属用户报告归属反例仍未完成，不能仅凭周/月草稿升级完整 PASS')
      }
      caseRecord.evidence.push(`专属账号真实只读分支结果：${child.note || '已执行'}；以本轮新证据为准`)
      result = { token, api }
    }
  } finally {
    // Reports need the owner token during cleanup, before closing Chrome or users.
    try {
      await registry.cleanup()
    } finally {
      if (handle) await closeOwnedBrowser(handle, outputDir, account.username, caseRecord)
    }
  }
  return { ...result, ...ownedCaseConclusion(caseId, caseRecord, gaps) }
}
