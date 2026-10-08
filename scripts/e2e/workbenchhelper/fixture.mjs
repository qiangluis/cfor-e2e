export const WORKBENCH_WRITE_FIXTURE_ENV = 'CFOR_E2E_WRITE_FIXTURES'

const REPORT_READ_PERMISSIONS = Object.freeze([
  'pm:daily-report:query',
  'crm:work-report:query'
])

// Match the invoked controllers, not unrelated report writes or portal administration.
export const WORKBENCH_CASE_PERMISSIONS = Object.freeze({
  'WBF-004': REPORT_READ_PERMISSIONS,
  'WBF-005': Object.freeze([]),
  'WBF-008': REPORT_READ_PERMISSIONS,
  'WBF-009': Object.freeze([]),
  'WBF-012': REPORT_READ_PERMISSIONS
})

export const WORKBENCH_FIXTURE_CASES = new Set(Object.keys(WORKBENCH_CASE_PERMISSIONS))

export const isWorkbenchWriteFixturesEnabled = (env = process.env) =>
  env[WORKBENCH_WRITE_FIXTURE_ENV] === 'true'

export function assertLocalWorkbenchWriteTarget ({
  target,
  webBase,
  apiBase,
  tenantId,
  tenantName
} = {}) {
  if (target !== 'local') throw new Error('BLOCKED: 工作台写侧仅允许 local 目标')
  const parseLocalBase = (base) => {
    let url
    try {
      url = new URL(base)
    } catch {
      throw new Error('BLOCKED: 工作台写侧缺少有效的本地服务地址')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) {
      throw new Error('BLOCKED: 工作台写侧服务地址必须是无凭据的 HTTP(S) loopback 地址')
    }
    return url
  }
  const web = parseLocalBase(webBase)
  const api = parseLocalBase(apiBase)
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (!loopback.has(web.hostname) || web.port !== '9151') {
    throw new Error('BLOCKED: 工作台写侧前端必须是 loopback:9151')
  }
  if (!loopback.has(api.hostname) || api.port !== '48083') {
    throw new Error('BLOCKED: 工作台写侧后端必须是 loopback:48083')
  }
  if (String(tenantId) !== '1' || tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: 工作台写侧仅允许租户 1 / CFOR 标准平台')
  }
  return true
}

const flattenMenus = (menus = []) => menus.flatMap((menu) => [
  menu,
  ...flattenMenus(Array.isArray(menu?.children) ? menu.children : [])
])

export function resolveWorkbenchReadGate ({
  caseId,
  permissionPayload,
  menuPayload
} = {}) {
  const blocked = (reason, missing = []) => ({ allowed: false, reason, missing, readOnly: true })
  const required = WORKBENCH_CASE_PERMISSIONS[caseId]
  if (!required) {
    return blocked('未定义该工作台案例的读取权限契约', [String(caseId)])
  }
  const permissionData = permissionPayload?.data
  if (permissionPayload?.code !== 0 ||
    !/^[1-9]\d*$/.test(String(permissionData?.user?.id)) ||
    !Array.isArray(permissionData?.permissions) ||
    permissionData.permissions.some((permission) => typeof permission !== 'string')) {
    return blocked('未获得有效的当前用户权限信息', ['有效的当前用户权限响应'])
  }
  const permissions = permissionData.permissions
  const menuKnown = menuPayload?.code === 0 && Array.isArray(menuPayload.data)
  const menus = menuKnown ? flattenMenus(menuPayload.data) : []
  const unrestricted = permissions.includes('*:*:*')
  const missingPermissions = unrestricted
    ? []
    : required.filter((permission) => !permissions.includes(permission))
  const normalize = (value) => String(value || '').replace(/[-_:]/g, '')
  const diagnostics = required.map((permission) => {
    const definitions = menus.filter((menu) => menu?.permission === permission)
    const similar = menuKnown && definitions.length === 0
      ? menus.filter((menu) => normalize(menu?.permission) === normalize(permission))
        .map((menu) => menu.permission)
      : []
    const granted = unrestricted || permissions.includes(permission)
    const state = !menuKnown ? 'menu-unverified' : definitions.length === 0
      ? (similar.length ? 'permission-code-mismatch' : 'menu-missing')
      : !definitions.some((menu) => menu.status === 0) ? 'menu-disabled'
        : granted ? 'ready' : 'permission-unassigned'
    return {
      permission, granted, state, similar,
      menus: definitions.map(({ id, parentId, status, type }) => ({ id, parentId, status, type }))
    }
  })
  const missingMenuDefinitions = diagnostics.filter(({ state }) =>
    state === 'menu-missing' || state === 'permission-code-mismatch')
    .map(({ permission }) => permission)
  const labels = {
    'menu-unverified': '菜单定义未核实',
    'menu-missing': '菜单缺 seed',
    'menu-disabled': '菜单已禁用',
    'permission-code-mismatch': '菜单权限串不匹配（不接受别名）',
    'permission-unassigned': '菜单存在但当前用户未获权'
  }
  return {
    allowed: missingPermissions.length === 0,
    readOnly: true,
    missing: missingPermissions,
    missingPermissions,
    missingMenuDefinitions,
    diagnostics,
    reason: missingPermissions.length
      ? diagnostics.filter(({ granted }) => !granted)
        .map(({ permission, state }) => `${permission}：${labels[state]}`).join('；')
      : '',
    userId: permissionData.user.id,
    unrestricted,
    permissionPayload
  }
}

export async function inspectWorkbenchFixtureTarget ({ api, settings, sessionTenantId }) {
  assertLocalWorkbenchWriteTarget(settings)
  if (String(sessionTenantId) !== '1') {
    return {
      allowed: false,
      missing: ['租户 1 正式登录身份'],
      reason: '登录响应未证明当前会话属于租户 1；停止写侧'
    }
  }
  const tenantPayload = await api.get(
    `/system/tenant/get-id-by-name?name=${encodeURIComponent(settings.tenantName)}`
  )
  // Resolve the named tenant before inspecting permission definitions.
  if (tenantPayload?.code !== 0 || String(tenantPayload?.data) !== '1') {
    return {
      allowed: false,
      missing: ['租户 1 正式身份回读'],
      reason: '正式 API 未确认 CFOR 标准平台对应租户 1；停止写侧'
    }
  }
  return { allowed: true }
}

export async function inspectWorkbenchReadGate ({ api, caseId }) {
  const permissionPayload = await api.get('/system/auth/get-permission-info')
  const gate = resolveWorkbenchReadGate({ caseId, permissionPayload })
  // Menu administration is diagnostic only; read cases must not require its permission.
  if (gate.allowed || !gate.missingPermissions?.length) return gate
  const menuPayload = await api.get('/system/menu/list').catch(() => null)
  return resolveWorkbenchReadGate({ caseId, permissionPayload, menuPayload })
}

export function workbenchReadBlockNote (gate) {
  return `读取前置未满足：${gate.reason}；缺失=${gate.missing.join('、')}；未创建账号、报告、偏好、门户或采购数据`
}
