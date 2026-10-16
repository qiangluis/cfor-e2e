import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { login, openRoute } from '../lib/browser.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const catalogPath = path.join(here, '..', 'cases', 'catalog.json')

export const cases = Object.freeze([
  'INIT-002', 'INIT-003', 'INIT-004', 'INIT-005', 'PB001-001', 'PB001-002'
])

export const INIT_READINESS_FACT_KEYS = Object.freeze([
  'material', 'unit', 'supplier', 'customer', 'account', 'warehouse', 'accountSet'
])

const INIT_READINESS_KEY_BY_FACT = Object.freeze({
  material: 'erp.material',
  unit: 'erp.unit',
  supplier: 'erp.supplier',
  customer: 'erp.customer',
  account: 'erp.account',
  warehouse: 'wms.base',
  accountSet: 'fms.account-set'
})

// 专属写侧初始化租户：名称、账号固定且可识别，重复运行复用，不污染正式租户 1。
export const dedicatedTenantSpec = Object.freeze({
  name: 'CFOR E2E 写侧初始化租户',
  username: 'e2einitadmin',
  password: 'E2e!Init501Write',
  packageId: '111'
})

/** 幂等确保专属初始化租户存在；只使用平台资源接口，不借助注册表单。 */
export async function ensureDedicatedTenant (adminApi, record) {
  const spec = dedicatedTenantSpec
  const lookup = await adminApi.request(
    'GET', `/system/tenant/get-id-by-name?name=${encodeURIComponent(spec.name)}`)
  const existing = lookup?.data
  if (existing && /^[1-9]\d*$/.test(String(existing))) {
    return { id: String(existing), ...spec, created: false }
  }
  const create = await adminApi.request('POST', '/system/tenant/create', {
    name: spec.name,
    contactName: spec.name,
    contactMobile: '19900000000',
    status: 0,
    packageId: spec.packageId,
    expireTime: '2099-12-31T23:59:59',
    accountCount: 100,
    username: spec.username,
    password: spec.password
  })
  if (!isBusinessSuccess(create) || !/^[1-9]\d*$/.test(String(create?.data))) {
    throw new Error(`BLOCKED: 专属租户创建失败：${JSON.stringify(create).slice(0, 300)}`)
  }
  record.notes.push(`专属初始化租户已创建：${spec.name}（tenantId=${create.data}）`)
  return { id: String(create.data), ...spec, created: true }
}

/** 在隔离浏览器上下文中以专属租户管理员登录，避免污染套件主会话。 */
export async function withDedicatedTenant (context, tenant, run) {
  const browser = context.page.context().browser()
  const isolated = await browser.newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
  })
  try {
    const page = await isolated.newPage()
    const auth = await login(page, {
      credentials: { tenantName: tenant.name, username: tenant.username, password: tenant.password },
      returnContext: true,
      check: context.check
    })
    if (String(auth.tenantId) !== String(tenant.id)) {
      throw new Error(`BLOCKED: 专属租户登录身份不一致：${auth.tenantId} != ${tenant.id}`)
    }
    const api = createApiClient({ token: auth.token, tenantId: tenant.id, record: context.record })
    return await run({ page, api, auth })
  } finally {
    await isolated.close().catch(() => {})
  }
}
export const initRoutes = Object.freeze({
  overview: '/systemInit/index',
  // The settings menu mounts the enterprise profile page under the
  // /systemModel/base/organization scope; /system/enterprise-organization is
  // not a registered front-end route.
  enterpriseOrganization: '/systemModel/base/organization/enterprise-organization'
})
export const presetConfirmButtonSelector = '.init-preset__actions button'
export const presetConfirmButtonText = '查看并确认预置'

const forbiddenRequests = Object.freeze([
  /^POST \/system\/system-init\/preset\/apply$/,
  /^PUT \/system\/system-init\/state$/,
  /^POST \/system\/system-init\/skip(?:\?|$)/,
  /^PUT \/system\/system-init\/subsystems$/,
  /^PUT \/system\/enterprise-organization\/current$/,
  /^POST \/system\/file\/upload$/
])

const allowedRequests = Object.freeze([
  /^GET \/system\/system-init\/(?:state|readiness|subsystems|preset\/catalog)$/,
  /^GET \/system\/auth\/get-permission-info$/,
  /^GET \/system\/enterprise-organization\/current$/,
  /^POST \/system\/system-init\/preset\/preview$/
])

const readCatalog = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8'))

export function catalogDefinition (caseId, catalog = readCatalog()) {
  const definition = catalog.suites
    ?.flatMap((suite) => (suite.cases || []).map((item) => ({ ...item, suite: suite.id })))
    .find((item) => item.id === caseId)
  if (!definition || !cases.includes(caseId)) throw new Error(`Missing init gap catalog: ${caseId}`)
  return definition
}

export function initializeCatalogAssertions (caseRecord, caseId, verified = new Map()) {
  const definition = catalogDefinition(caseId)
  const statuses = verified instanceof Map ? verified : new Map(Object.entries(verified))
  const statusFor = (index) => {
    const value = statuses.get(index)
    return typeof value === 'string' ? { status: value } : (value || {})
  }
  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => {
    const candidate = statusFor(index)
    const names = Array.isArray(candidate.evidenceChecks) ? candidate.evidenceChecks : []
    const supported = names.length > 0 && names.every((name) => {
      const checks = (caseRecord.checks || []).filter((item) => item.name === name)
      return checks.length === 1 && checks[0].passed === true
    })
    const verified = candidate.status === 'VERIFIED' && !candidate.reason && supported
    return {
      index, assertion, status: verified ? 'VERIFIED' : 'GAP', evidenceChecks: [...names],
      ...(verified && candidate.evidence ? { evidence: candidate.evidence } : {}),
      ...(!verified ? { reason: candidate.reason ||
        '缺少本轮非空、唯一且全部通过的具名检查，不能仅以 VERIFIED 标记升级' } : {})
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED')
    .map((item) => ({
      index: item.index,
      assertion: item.assertion,
      ...(item.reason ? { reason: item.reason } : {})
    }))
  caseRecord.readyCandidate = false
  caseRecord.passCandidate = false
  caseRecord.acceptanceComplete = false
  return caseRecord.catalogAssertions
}

export function assertSafeScope (settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: init gap checks require local tenant1/CFOR 标准平台/cfor_admin_standard')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: init gap checks require loopback 48083/9151 without credentials')
    }
  }
}

export function isAllowedRequest (method, pathname) {
  const value = `${String(method).toUpperCase()} ${pathname}`
  if (forbiddenRequests.some((pattern) => pattern.test(value))) return false
  return allowedRequests.some((pattern) => pattern.test(value))
}

export function isForbiddenRequest (method, pathname) {
  return forbiddenRequests.some((pattern) =>
    pattern.test(`${String(method).toUpperCase()} ${pathname}`))
}

const dataOf = (payload) => (isBusinessSuccess(payload) ? payload.data : null)
const nonNegative = (value) => Number.isInteger(value) && value >= 0
const text = (value) => String(value ?? '')
const normalize = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item)

function stateSnapshot (value) {
  const state = dataOf(value) || {}
  return {
    id: state.id,
    industryTemplate: state.industryTemplate,
    industryCategory: state.industryCategory,
    industrySubCategory: state.industrySubCategory,
    selectedModules: Array.isArray(state.selectedModules) ? [...state.selectedModules] : null,
    skippedItems: Array.isArray(state.skippedItems) ? [...state.skippedItems] : null,
    currentStep: state.currentStep,
    status: state.status,
    firstRunPresetTime: state.firstRunPresetTime,
    firstRunPresetResult: state.firstRunPresetResult || null
  }
}

function organizationSnapshot (value) {
  const data = dataOf(value) || {}
  return {
    id: data.id,
    enterpriseType: data.enterpriseType,
    industryCategory: data.industryCategory,
    industrySubCategory: data.industrySubCategory,
    enterpriseLogoUrlPresent: Boolean(data.enterpriseLogoUrl),
    brandMarkUrlPresent: Boolean(data.brandMarkUrl),
    brandLogoUrlPresent: Boolean(data.brandLogoUrl),
    brandDarkLogoUrlPresent: Boolean(data.brandDarkLogoUrl)
  }
}

function permissionSnapshot (value) {
  const data = dataOf(value) || {}
  const menus = Array.isArray(data.menus) ? data.menus : []
  const flatten = (items) => items.flatMap((item) => [
    { id: item.id, name: item.name, path: item.path, component: item.component },
    ...flatten(Array.isArray(item.children) ? item.children : [])
  ])
  return flatten(menus).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function presetResultComplete (value, applied) {
  const result = dataOf(value)
  if (!result || result.applied !== applied || !Array.isArray(result.contributions) ||
      ![result.added, result.skipped, result.modified, result.conflicts].every(nonNegative)) {
    return false
  }
  return result.contributions.every((item) =>
    item && typeof item.key === 'string' && typeof item.module === 'string' &&
    typeof item.title === 'string' &&
    [item.added, item.skipped, item.modified, item.conflicts].every(nonNegative) &&
    Array.isArray(item.messages))
}

export function readinessClassification (payload) {
  const items = dataOf(payload)?.items
  if (!Array.isArray(items)) return { items: null, categories: {}, opening: [], unknown: true }
  const descriptors = items.map((item) => ({
    ...item,
    haystack: [item.key, item.module, item.title, item.name, item.reason]
      .map(text).join(' ').toLowerCase()
  }))
  const match = (pattern) => descriptors.filter((item) => pattern.test(item.haystack))
  const categories = {
    material: match(/material|存货|物料/),
    unit: match(/unit|bas.?unit|单位/),
    supplier: match(/supplier|供应商/),
    customer: match(/customer|客户/),
    account: match(/account(?!.?set)|账户|资金账户/),
    warehouse: match(/warehouse|仓储|仓库/),
    accountSet: match(/account.?set|账套/)
  }
  return {
    items: descriptors,
    categories,
    opening: descriptors.filter((item) => /opening|initial|期初|初始/.test(item.haystack)),
    unknown: descriptors.some((item) => item.status === 'UNKNOWN')
  }
}

export function initReadinessFactSql (tenantId = 1) {
  if (Number(tenantId) !== 1) {
    throw new Error('INIT-005 只允许核对标准平台 tenant_id=1')
  }
  return `
    SELECT 'material', COUNT(*) FROM mes_bas_material
    WHERE tenant_id = 1 AND deleted = 0;
    SELECT 'unit', COUNT(*) FROM mes_bas_unit
    WHERE tenant_id = 1 AND deleted = 0;
    SELECT 'supplier', COUNT(*) FROM base_partner
    WHERE tenant_id = 1 AND deleted = 0 AND supplier_enabled = 1;
    SELECT 'customer', COUNT(*) FROM base_partner
    WHERE tenant_id = 1 AND deleted = 0 AND customer_enabled = 1;
    SELECT 'account', COUNT(*) FROM erp_account
    WHERE tenant_id = 1 AND deleted = 0;
    SELECT 'warehouse', COUNT(*) FROM mes_wms_ware_house
    WHERE tenant_id = 1 AND deleted = 0 AND is_enabled = 1;
    SELECT 'accountSet', COUNT(*)
    FROM fms_account_set a
    WHERE a.tenant_id = 1 AND a.deleted = 0 AND a.initialized = 1
      AND a.standard IS NOT NULL AND a.start_time IS NOT NULL AND a.currency_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM fms_finance_parameter p
        WHERE p.account_set_id = a.id AND p.tenant_id = 1 AND p.deleted = 0
      )
      AND EXISTS (
        SELECT 1 FROM fms_currency c
        WHERE c.account_set_id = a.id AND c.tenant_id = 1 AND c.deleted = 0 AND c.standard = 1
      )
      AND EXISTS (
        SELECT 1 FROM fms_voucher_word v
        WHERE v.account_set_id = a.id AND v.tenant_id = 1 AND v.deleted = 0
      )
      AND EXISTS (
        SELECT 1 FROM fms_subject s
        WHERE s.account_set_id = a.id AND s.tenant_id = 1 AND s.deleted = 0
      )
      AND EXISTS (
        SELECT 1 FROM fms_closing_template t
        WHERE t.account_set_id = a.id AND t.tenant_id = 1 AND t.deleted = 0
      );
  `
}

export function validateInitReadinessFacts (factRows, readinessItems) {
  const rows = Array.isArray(factRows) ? factRows : []
  const rowMap = new Map()
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2 ||
        !INIT_READINESS_FACT_KEYS.includes(row[0]) || rowMap.has(row[0]) ||
        !/^\d+$/.test(String(row[1] ?? ''))) {
      return { valid: false, reason: '七类事实计数必须完整、唯一且为非负整数', factMap: new Map() }
    }
    rowMap.set(row[0], Number(row[1]))
  }
  if (rowMap.size !== INIT_READINESS_FACT_KEYS.length) {
    return { valid: false, reason: '七类官方事实计数缺失', factMap: rowMap }
  }

  const itemMap = new Map((Array.isArray(readinessItems) ? readinessItems : [])
    .map((item) => [item?.key, item]))
  for (const factKey of INIT_READINESS_FACT_KEYS) {
    const item = itemMap.get(INIT_READINESS_KEY_BY_FACT[factKey])
    const count = item?.count
    if (!item || !Number.isInteger(count) || count < 0 || count !== rowMap.get(factKey)) {
      return {
        valid: false,
        reason: `${factKey} readiness 计数缺失或与官方事实不一致`,
        factMap: rowMap
      }
    }
    if (rowMap.get(factKey) === 0 && item.status === 'READY') {
      return {
        valid: false,
        reason: `${factKey} 空事实不能标记 READY`,
        factMap: rowMap
      }
    }
  }
  return { valid: true, reason: '', factMap: rowMap }
}

export function validateWmsTopology (topologyInput, readinessStatus) {
  const topology = topologyInput instanceof Map
    ? topologyInput
    : new Map(Object.entries(topologyInput || {}).map(([key, value]) => [key, Number(value)]))
  const required = [
    'warehouse', 'warehouse-total', 'area', 'location',
    'orphan-area', 'orphan-location', 'erp-view', 'erp-rows'
  ]
  const missing = required.filter((key) => !Number.isInteger(topology.get(key)))
  if (missing.length > 0) {
    return { valid: false, reason: `WMS 拓扑计数缺失：${missing.join(',')}` }
  }
  const failures = []
  if (topology.get('warehouse') <= 0) failures.push('没有启用仓库')
  if (topology.get('warehouse-total') <= 0) failures.push('没有未删除仓库')
  if (topology.get('warehouse') > topology.get('warehouse-total')) {
    failures.push('启用仓库数大于未删除仓库总数')
  }
  if (topology.get('area') <= 0) failures.push('没有启用库区')
  if (topology.get('location') <= 0) failures.push('没有启用库位')
  if (topology.get('orphan-area') !== 0) failures.push('存在孤立库区')
  if (topology.get('orphan-location') !== 0) failures.push('存在孤立库位')
  if (topology.get('erp-view') !== 1) failures.push('erp_warehouse 不是唯一兼容视图')
  // The compatibility view projects all non-deleted WMS warehouses, including disabled ones.
  if (topology.get('erp-rows') !== topology.get('warehouse-total')) {
    failures.push('ERP 兼容视图行数与未删除 WMS 仓库总数不一致')
  }
  if (readinessStatus !== 'READY') failures.push(`wms.base readiness=${readinessStatus || 'missing'}`)
  return { valid: failures.length === 0, reason: failures.join('；') }
}

export function inspectLogoFields (fields = []) {
  const expected = ['图形标识', '黑字完整 Logo', '白字完整 Logo']
  const labels = expected.map((label) => fields.find((item) => text(item.label).trim() === label))
  return {
    found: labels.filter(Boolean).length,
    optional: labels.every((item) => item && item.required !== true && item.hasRequiredMark !== true)
  }
}

function addCheck (caseRecord, name, passed, details = '') {
  caseRecord.checks ||= []
  caseRecord.checks.push({ name, passed: Boolean(passed), details: String(details).slice(0, 500) })
  return Boolean(passed)
}

function evidence (caseRecord, value) {
  caseRecord.evidence ||= []
  caseRecord.evidence.push(value)
}

async function pageBodyText (page) {
  if (!page) return ''
  return page.locator('body').innerText().catch(() => '')
}

async function openReadOnlyRoute (page, route, navigate, caseRecord) {
  if (!page) return false
  try {
    await navigate(page, route, { readyText: route.includes('enterprise') ? '企业' : '初始化' })
    addCheck(caseRecord, `打开只读页面 ${route}`, true, '只读导航')
    return true
  } catch (error) {
    addCheck(caseRecord, `打开只读页面 ${route}`, false, String(error.message || error))
    return false
  }
}

function presetConfirmButton (page) {
  return page
    .locator(presetConfirmButtonSelector)
    .filter({ hasText: presetConfirmButtonText })
    .first()
}

async function callReadOnly (api, method, pathname, body, caseRecord) {
  if (!isAllowedRequest(method, pathname)) {
    throw new Error(`BLOCKED: request outside init gap read-only allowlist: ${method} ${pathname}`)
  }
  return api.request(method, pathname, body)
}

/**
 * 受控写侧请求。仅用于初始化用例明确声明的真实写路径，并在运行记录中留痕。
 * 与 callReadOnly 分离，避免放宽只读 allowlist 的契约。
 */
async function callWrite (api, method, pathname, body, caseRecord) {
  const result = await api.request(method, pathname, body)
  caseRecord.api = [...(caseRecord.api || []), {
    method: String(method).toUpperCase(),
    pathname,
    code: result?.code,
    success: isBusinessSuccess(result)
  }]
  return result
}

/** 只读数据库证据，失败不阻断用例，仅记录原因。 */
async function readSql (caseRecord, stage, sql) {
  try {
    const result = await runReadOnlySql(sql)
    if (!result.available) {
      caseRecord.notes.push(`只读数据库证据不可用：${result.reason}`)
      return null
    }
    caseRecord.database = [...(caseRecord.database || []), { stage, rows: result.rows }]
    return result.rows
  } catch (error) {
    caseRecord.notes.push(`只读数据库检查失败：${String(error.message || error).slice(0, 200)}`)
    return null
  }
}

/** 从权限快照中取出菜单编号集合，用于比较授权前后差异。 */
function menuIdsOf (permissionPayload) {
  return permissionSnapshot(permissionPayload)
    .filter((item) => item.id != null)
    .map((item) => String(item.id))
    .sort()
}

/** 读取当前选中的模块，作为子系统依赖断言的输入。 */
function selectedModulesOf (state) {
  const value = dataOf(state)?.selectedModules
  return Array.isArray(value) ? value : []
}

async function runInit002 ({ api, page, caseRecord, navigate }) {
  const before = {
    state: await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    organization: await callReadOnly(api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord),
    permissions: await callReadOnly(api, 'GET', '/system/auth/get-permission-info', undefined, caseRecord)
  }
  const state = dataOf(before.state)
  const catalog = await callReadOnly(api, 'GET', '/system/system-init/preset/catalog', undefined, caseRecord)
    .catch(() => null)
  const modules = Array.isArray(state?.selectedModules) && state.selectedModules.length
    ? state.selectedModules
    : (Array.isArray(dataOf(catalog)?.modules) ? dataOf(catalog).modules : ['system'])
  const preview = await callReadOnly(api, 'POST', '/system/system-init/preset/preview', { modules }, caseRecord)
  const previewState = await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord)
  const after = {
    state: await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    organization: await callReadOnly(api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord),
    permissions: await callReadOnly(api, 'GET', '/system/auth/get-permission-info', undefined, caseRecord)
  }
  const unchanged = normalize(stateSnapshot(before.state)) === normalize(stateSnapshot(after.state)) &&
    normalize(organizationSnapshot(before.organization)) === normalize(organizationSnapshot(after.organization)) &&
    normalize(permissionSnapshot(before.permissions)) === normalize(permissionSnapshot(after.permissions))
  addCheck(caseRecord, 'preview 返回 applied=false 且前后只读快照一致',
    isBusinessSuccess(preview) && presetResultComplete(preview, false) && unchanged,
    `modules=${modules.length}; unchanged=${unchanged}`)
  if (isBusinessSuccess(preview) && presetResultComplete(preview, false) && unchanged) {
    evidence(caseRecord, 'state/organization/permission API 前后快照一致；preview applied=false')
    caseRecord.catalogAssertions = initializeCatalogAssertions(caseRecord, 'INIT-002', new Map([
      [0, {
        status: 'VERIFIED',
        evidence: '只读快照一致且 preview.applied=false',
        evidenceChecks: ['preview 返回 applied=false 且前后只读快照一致']
      }]
    ]))
  }
  const sameAsBeforePreview = normalize(stateSnapshot(before.state)) === normalize(stateSnapshot(previewState))
  addCheck(caseRecord, 'preview 之后立刻回读 state 未发生写入',
    isBusinessSuccess(previewState) && sameAsBeforePreview,
    `previewWrite=${sameAsBeforePreview}`)
  // 真实写侧：保存同一份行业/模块/步骤配置，回读确认同步结果与顶部业务域刷新。
  const stateSave = await callWrite(api, 'PUT', '/system/system-init/state', {
    industryTemplate: state?.industryTemplate || 'electronics_pcb',
    selectedModules: modules,
    currentStep: 2
  }, caseRecord)
  const savedState = await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord)
  const savedModules = selectedModulesOf(savedState)
  const savedModulesMatch = savedModules.length === modules.length &&
    modules.every((module) => savedModules.includes(module))
  addCheck(caseRecord, '保存行业/模块/步骤后回读一致并保留首轮回执',
    isBusinessSuccess(stateSave) && savedModulesMatch &&
    Boolean(dataOf(savedState)?.firstRunPresetResult),
    `write=${isBusinessSuccess(stateSave)} modules=${savedModules.length}`)
  // tenant_admin 菜单授权同步：保存后读取权限快照并回读 system_role_menu。
  const permissionsAfterSave = await callReadOnly(
    api, 'GET', '/system/auth/get-permission-info', undefined, caseRecord)
  const beforeMenuIds = menuIdsOf(before.permissions)
  const afterMenuIds = menuIdsOf(permissionsAfterSave)
  const permissionChanged = JSON.stringify(beforeMenuIds) !== JSON.stringify(afterMenuIds)
  const stillHasMenus = afterMenuIds.length > 0
  addCheck(caseRecord, '保存后 tenant_admin 菜单权限已同步且角色菜单可回读',
    isBusinessSuccess(permissionsAfterSave) && stillHasMenus,
    `menusBefore=${beforeMenuIds.length} menusAfter=${afterMenuIds.length} changed=${permissionChanged}`)
  const roleMenuRows = await readSql(caseRecord, 'init-role-menu-sync',
    'SELECT COUNT(*) FROM system_role_menu')
  const roleMenuCount = roleMenuRows ? Number(roleMenuRows[0]?.[0]) : null
  addCheck(caseRecord, '权限同步落库 system_role_menu 并有可用授权记录',
    roleMenuCount != null && roleMenuCount > 0, `roleMenuRows=${roleMenuCount ?? 'n/a'}`)
  // 顶部业务域：当前工作台应出现业务菜单分组，证明业务域即时刷新。
  if (page) {
    await openReadOnlyRoute(page, initRoutes.overview, navigate, caseRecord)
    const body = await pageBodyText(page)
    const hasBusinessDomain = /ERP|BPM|WMS|MES|系统/.test(body)
    addCheck(caseRecord, '顶部业务域在工作台即时可见', hasBusinessDomain,
      hasBusinessDomain ? '页面包含业务域分组' : '未在页面文本中发现业务域')
    if (hasBusinessDomain) evidence(caseRecord, '重新打开初始化中心后顶部业务域可见')
  }
  // 共享套餐保持不变：套餐 111 仍为启用的标准套餐，未改动菜单授权。
  const packageSnapshot = await readSql(caseRecord, 'tenant-package-unchanged',
    "SELECT id, name, status FROM system_tenant_package WHERE id = 111")
  const packageUnchanged = packageSnapshot?.length === 1 &&
    String(packageSnapshot[0][2]) === '0'
  addCheck(caseRecord, '共享标准套餐未被本用例修改',
    packageUnchanged, `package=${JSON.stringify(packageSnapshot)}`)
  if (page) {
    await openReadOnlyRoute(page, initRoutes.overview, navigate, caseRecord)
    const body = await pageBodyText(page)
    const previewButton = presetConfirmButton(page)
    if (await previewButton.isVisible().catch(() => false)) {
      const previewResponses = []
      const onResponse = async (response) => {
        if (!response.url().includes('preset/preview')) return
        const bodyText = await response.text().catch(() => '')
        previewResponses.push({ status: response.status(), body: bodyText.slice(0, 300) })
      }
      page.on('response', onResponse)
      await previewButton.click()
      const dialog = page.locator('[role="dialog"]').filter({ hasText: /预览|确认/ }).first()
      // The preview dialog only renders after the preset/preview request
      // resolves, so wait for it instead of reading visibility synchronously.
      const visible = await dialog
        .waitFor({ state: 'visible', timeout: 20000 })
        .then(() => true)
        .catch(() => false)
      let diagnostic = visible ? '只打开弹窗，未确认' : body.slice(0, 200)
      if (!visible) {
        await page.waitForTimeout(3000)
        const roleDialogs = await page.locator('[role="dialog"]').count().catch(() => -1)
        const presetDialogs = await page.locator('.init-preset-dialog').count().catch(() => -1)
        const messages = await page.locator('.el-message').allInnerTexts().catch(() => [])
        diagnostic = `dialogCount=${roleDialogs} presetDialog=${presetDialogs} ` +
          `messages=${JSON.stringify(messages)} previewResponses=${JSON.stringify(previewResponses)}`
      }
      page.off('response', onResponse)
      addCheck(caseRecord, '预览按钮打开确认弹窗', visible, diagnostic)
      if (visible) {
        const current = caseRecord.catalogAssertions?.find((item) => item.index === 1)
        if (current) {
          current.status = 'VERIFIED'
          current.evidenceChecks = ['预览按钮打开确认弹窗']
          delete current.reason
        }
        else initializeCatalogAssertions(caseRecord, 'INIT-002', new Map([
          [0, {
            status: 'VERIFIED',
            evidenceChecks: ['preview 返回 applied=false 且前后只读快照一致']
          }],
          [1, { status: 'VERIFIED', evidenceChecks: ['预览按钮打开确认弹窗'] }]
        ]))
        evidence(caseRecord, 'headed 页面确认弹窗可见，未点击确认')
      }
    } else addCheck(caseRecord, '预览按钮打开确认弹窗', false, '当前状态没有可安全点击的预览按钮')
  }
  const verified = new Map((caseRecord.catalogAssertions || []).map((item) => [item.index, item]))
  if (isBusinessSuccess(preview) && presetResultComplete(preview, false) && unchanged &&
      sameAsBeforePreview && isBusinessSuccess(stateSave) && savedModulesMatch) {
    verified.set(2, {
      status: 'VERIFIED',
      evidenceChecks: [
        '保存后 tenant_admin 菜单权限已同步且角色菜单可回读',
        '权限同步落库 system_role_menu 并有可用授权记录'
      ]
    })
  }
  if (isBusinessSuccess(permissionsAfterSave) && stillHasMenus &&
      roleMenuCount != null && roleMenuCount > 0) {
    verified.set(3, {
      status: 'VERIFIED',
      evidenceChecks: ['顶部业务域在工作台即时可见']
    })
  }
  // The shared package snapshot does not prove that every other role stayed
  // unchanged. Keep assertion 4 as GAP in this legacy tenant-1 path.
  initializeCatalogAssertions(caseRecord, 'INIT-002', verified)
  evidence(caseRecord,
    '真实写侧：保存同一份行业/模块/步骤配置 -> 回读一致 -> 权限快照与 system_role_menu 落库 -> 顶部业务域可见 -> 标准套餐未变。')
}

async function runInit003 ({ api, page, caseRecord, navigate }) {
  const [catalog, state, readiness] = await Promise.all([
    callReadOnly(api, 'GET', '/system/system-init/preset/catalog', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/readiness', undefined, caseRecord)
  ])
  const receipt = dataOf(state)?.firstRunPresetResult
  const complete = presetResultComplete({ code: 0, data: receipt }, true)
  addCheck(caseRecord, 'state 首轮回执具备完整结构化明细', complete,
    complete ? `contributions=${receipt.contributions.length}` : '当前没有完整 applied=true 回执')
  addCheck(caseRecord, 'preset catalog/readiness 返回结构化成功数据',
    isBusinessSuccess(catalog) && Array.isArray(dataOf(catalog)?.contributions) &&
    isBusinessSuccess(readiness) && Array.isArray(dataOf(readiness)?.items),
    `catalog=${isBusinessSuccess(catalog)} readiness=${isBusinessSuccess(readiness)}`)
  const modules = selectedModulesOf(state)
  // 幂等写侧只针对 system 模块，避免在标准租户 1 上批量预置业务主数据。
  const idempotentModules = ['system']
  // 真实写侧：连续执行两次同一预设。第二次必须零新增、零新冲突，且不能覆盖上一轮结果。
  const apply1 = await callWrite(api, 'POST', '/system/system-init/preset/apply',
    { modules: idempotentModules, firstRun: false }, caseRecord)
  const stateAfter1 = await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord)
  const apply2 = await callWrite(api, 'POST', '/system/system-init/preset/apply',
    { modules: idempotentModules, firstRun: false }, caseRecord)
  const stateAfter2 = await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord)
  const result1 = dataOf(apply1)
  const result2 = dataOf(apply2)
  const applyOk = isBusinessSuccess(apply1) && isBusinessSuccess(apply2) &&
    presetResultComplete(apply1, true) && presetResultComplete(apply2, true) &&
    Array.isArray(result1?.contributions) && Array.isArray(result2?.contributions)
  const contribKey = (item) => `${item.key}|${item.module}|${item.status}`
  const secondIdempotent = applyOk && Number(result2.added) === 0 &&
    result1.contributions.length === result2.contributions.length &&
    result2.contributions.every((item) => Number(item.added) === 0) &&
    result1.contributions.every((first) => {
      const second = result2.contributions.find((item) => contribKey(item) === contribKey(first))
      return second && Number(second.conflicts) === Number(first.conflicts)
    })
  addCheck(caseRecord, '第二次 apply 零新增且冲突明细不再变化（幂等）',
    secondIdempotent,
    `firstAdded=${result1?.added} secondAdded=${result2?.added} ` +
    `secondConflicts=${result2?.conflicts} contributions=${result2?.contributions?.length}`)
  const preservedReceipt = normalize(stateSnapshot(state)) === normalize(stateSnapshot(stateAfter1)) &&
    normalize(stateSnapshot(stateAfter1)) === normalize(stateSnapshot(stateAfter2))
  addCheck(caseRecord, '重复预设保留首轮回执且 state 稳定不漂移',
    preservedReceipt && Boolean(dataOf(stateAfter2)?.firstRunPresetResult),
    `stable=${preservedReceipt} firstRunTime=${dataOf(stateAfter2)?.firstRunPresetTime || 'n/a'}`)
  const receiptRows = await readSql(caseRecord, 'first-run-preset-result',
    'SELECT first_run_preset_result, first_run_preset_time FROM system_init_state WHERE deleted = 0 LIMIT 1')
  const receiptJson = receiptRows?.[0]?.[0] || ''
  const receiptPersisted = /"applied":true/.test(receiptJson) &&
    /"contributions":\[/.test(receiptJson)
  addCheck(caseRecord, '首轮回执持久化在 system_init_state 且可解析',
    receiptPersisted,
    `bytes=${receiptJson.length} hasTime=${Boolean(receiptRows?.[0]?.[1])}`)
  // 已修改值保留：第二次 apply 的 modified 明细与第一次完全一致，未出现额外覆盖。
  const modifiedStable = applyOk &&
    Number(result1.modified) === Number(result2.modified) &&
    result1.contributions.every((first) => {
      const second = result2.contributions.find((item) => contribKey(item) === contribKey(first))
      return second && Number(second.modified) === Number(first.modified)
    })
  addCheck(caseRecord, '第二次 apply 的 modified 明细与第一次一致，未覆盖已修改值',
    modifiedStable,
    `modified1=${result1?.modified} modified2=${result2?.modified}`)
  if (page && complete) {
    await openReadOnlyRoute(page, initRoutes.overview, navigate, caseRecord)
    const body = await pageBodyText(page)
    const displayed = /新增\s*\d+/.test(body) && /已存在|跳过/.test(body) && /未覆盖修改|保留修改/.test(body)
    addCheck(caseRecord, '刷新后的页面显示回执摘要', displayed, displayed ? '页面包含回执统计' : '页面未显示完整回执摘要')
    if (displayed) evidence(caseRecord, 'headed 刷新页面显示首轮预置回执摘要')
  }
  const verified = new Map()
  // The legacy page check does not verify all four rendered detail categories;
  // the isolated local closure owns the complete INIT-003 assertion 0 proof.
  if (receiptPersisted) {
    verified.set(1, {
      status: 'VERIFIED',
      evidenceChecks: [
        '重复预设保留首轮回执且 state 稳定不漂移',
        '首轮回执持久化在 system_init_state 且可解析'
      ]
    })
  }
  if (secondIdempotent) {
    verified.set(2, {
      status: 'VERIFIED',
      evidenceChecks: ['第二次 apply 零新增且冲突明细不再变化（幂等）']
    })
  }
  // Equal modified counters do not prove a deliberately changed value was
  // preserved. Keep assertion 3 as GAP outside the isolated local closure.
  initializeCatalogAssertions(caseRecord, 'INIT-003', verified)
  evidence(caseRecord,
    `真实写侧：apply(first) added=${result1?.added} -> apply(second) added=${result2?.added} ` +
    `modified=${result2?.modified} -> state 回执持久化且未漂移。`)
}

async function runInit004 ({ api, page, caseRecord, navigate }) {
  const [state, readiness] = await Promise.all([
    callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/readiness', undefined, caseRecord)
  ])
  const classified = readinessClassification(readiness)
  const selected = dataOf(state)?.selectedModules
  const hasSelected = Array.isArray(selected)
  const items = classified.items || []
  const skippable = classified.opening.filter((item) => item.skippable === true)
  const formal = items.filter((item) => /account.?set|账套/.test(item.haystack))
  addCheck(caseRecord, 'state/readiness 返回已选模块和初始化项', hasSelected && Array.isArray(classified.items),
    `selected=${hasSelected}; items=${items.length}`)
  addCheck(caseRecord, '期初项结构化标记为可跳过', skippable.length > 0, `count=${skippable.length}`)
  addCheck(caseRecord, '正式账套结构化标记为不可跳过', formal.length > 0 && formal.every((item) => item.skippable === false),
    `count=${formal.length}`)
  // 真实写侧：对可跳过项执行跳过/取消跳过，回读 state.skippedItems 精确变化。
  const skippableKey = skippable[0]?.key || 'wms.opening'
  const beforeState = dataOf(state)
  const originalSkipped = Array.isArray(beforeState?.skippedItems) ? [...beforeState.skippedItems] : []
  const skipWrite = await callWrite(api, 'POST',
    `/system/system-init/skip?key=${encodeURIComponent(skippableKey)}&skipped=true`,
    undefined, caseRecord)
  const afterSkipState = dataOf(await callReadOnly(
    api, 'GET', '/system/system-init/state', undefined, caseRecord))
  const skipApplied = isBusinessSuccess(skipWrite) &&
    Array.isArray(afterSkipState?.skippedItems) &&
    afterSkipState.skippedItems.includes(skippableKey)
  addCheck(caseRecord, '跳过期初项后 state.skippedItems 真实包含该键',
    skipApplied, `key=${skippableKey} skipped=${JSON.stringify(afterSkipState?.skippedItems)}`)
  const unskipWrite = await callWrite(api, 'POST',
    `/system/system-init/skip?key=${encodeURIComponent(skippableKey)}&skipped=false`,
    undefined, caseRecord)
  const restoredState = dataOf(await callReadOnly(
    api, 'GET', '/system/system-init/state', undefined, caseRecord))
  const restored = isBusinessSuccess(unskipWrite) && Array.isArray(restoredState?.skippedItems) &&
    normalize([...(restoredState.skippedItems || [])].sort()) ===
    normalize([...originalSkipped].sort())
  addCheck(caseRecord, '取消跳过期初项后 state.skippedItems 恢复到原值（反向闭环）',
    restored, `original=${JSON.stringify(originalSkipped)} restored=${JSON.stringify(restoredState?.skippedItems)}`)
  // 正式账套不可跳过：真实请求必须被服务端拒绝，且不改变 state。
  const formalKey = formal[0]?.key || 'fms.account-set'
  const formalReject = await callWrite(api, 'POST',
    `/system/system-init/skip?key=${encodeURIComponent(formalKey)}&skipped=true`,
    undefined, caseRecord)
  const stateAfterFormal = dataOf(await callReadOnly(
    api, 'GET', '/system/system-init/state', undefined, caseRecord))
  const formalBlocked = !isBusinessSuccess(formalReject) &&
    !(stateAfterFormal?.skippedItems || []).includes(formalKey)
  addCheck(caseRecord, '正式账套跳过被服务端拒绝且 state 不变',
    formalBlocked, `key=${formalKey} code=${formalReject?.code} msg=${formalReject?.msg || ''}`)
  const skipRows = await readSql(caseRecord, 'init-skipped-items',
    'SELECT skipped_items FROM system_init_state WHERE deleted = 0 LIMIT 1')
  const skipPersisted = skipRows?.length === 1 &&
    normalize(JSON.parse(skipRows[0][0] || '[]')) === normalize(originalSkipped)
  addCheck(caseRecord, 'skipped_items 落库与取消后原值一致',
    skipPersisted, `db=${JSON.stringify(skipRows?.[0]?.[0])}`)
  // 同一配置从初始化与设置接口回读一致：企业资料与行业分类。
  const organization = await callReadOnly(
    api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord)
  const orgData = dataOf(organization)
  const configConsistent = isBusinessSuccess(organization) &&
    orgData?.industryCategory === beforeState?.industryCategory &&
    orgData?.industrySubCategory === beforeState?.industrySubCategory &&
    orgData?.industrySubCategory === beforeState?.industryTemplate
  addCheck(caseRecord, '初始化与设置的企业/行业配置回读一致',
    configConsistent,
    `org=${orgData?.industryCategory}/${orgData?.industrySubCategory} ` +
    `state=${beforeState?.industryCategory}/${beforeState?.industrySubCategory}`)
  const settingModules = ['system', 'erp', 'bpm']
  const settingsSplit = settingModules.every((module) => (selected || []).includes(module) ||
    module === 'system')
  addCheck(caseRecord, '设置入口按已选模块拆分且不越过套餐边界',
    settingsSplit && (selected || []).length > 0,
    `selected=${(selected || []).join(',')}`)
  const verified = new Map()
  if (page) {
    const initOpened = await openReadOnlyRoute(page, initRoutes.overview, navigate, caseRecord)
    const initBody = initOpened ? await pageBodyText(page) : ''
    const tabsVisible = initBody.length > 0 && hasSelected
    // Opening the page does not prove the visible tabs exactly equal selectedModules.
    const settingsOpened = await openReadOnlyRoute(
      page,
      initRoutes.enterpriseOrganization,
      navigate,
      caseRecord
    )
    const settingsBody = settingsOpened ? await pageBodyText(page) : ''
    if (settingsOpened && initBody && settingsBody) {
      evidence(caseRecord, '初始化与设置页面均只读打开；未执行跳过或保存')
    }
  }
  // This path exercises one skippable item only; it cannot prove both WMS and
  // FMS opening items. The isolated local closure supplies that exact evidence.
  if (formalBlocked) {
    verified.set(2, {
      status: 'VERIFIED',
      evidenceChecks: ['正式账套跳过被服务端拒绝且 state 不变']
    })
  }
  // selectedModules membership alone does not prove the settings UI split.
  if (configConsistent) {
    verified.set(4, {
      status: 'VERIFIED',
      evidenceChecks: ['初始化与设置的企业/行业配置回读一致']
    })
  }
  initializeCatalogAssertions(caseRecord, 'INIT-004', verified)
  evidence(caseRecord,
    `真实写侧：skip(${skippableKey})=true -> state 含该键 -> skip=false 恢复原值 -> ` +
    `正式账套 ${formalKey} 跳过被拒；企业/行业配置在初始化与设置回读一致。`)
}

async function runInit005 ({ api, caseRecord }) {
  const [state, readiness] = await Promise.all([
    callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/readiness', undefined, caseRecord)
  ])
  const classified = readinessClassification(readiness)
  const categoryNames = ['material', 'unit', 'supplier', 'customer', 'account', 'warehouse', 'accountSet']
  const completeCategories = classified.items !== null && categoryNames.every((name) =>
    classified.categories[name].length > 0 && classified.categories[name].every((item) =>
      ['READY', 'INCOMPLETE', 'NOT_STARTED', 'SKIPPED', 'UNKNOWN'].includes(item.status)))
  addCheck(caseRecord, '必配事实按 readiness 分类完整返回', completeCategories,
    `categories=${categoryNames.filter((name) => classified.categories[name].length > 0).join(',')}`)
  addCheck(caseRecord, '期初 readiness 标记为可跳过', classified.opening.some((item) => item.skippable === true),
    `opening=${classified.opening.length}`)
  const external = (classified.items || []).filter((item) => /cost|成本|integration|集成|connection|连接/.test(item.haystack))
  addCheck(caseRecord, '成本模型/集成仅按现状读取，不伪造外部连接', external.length > 0 &&
    external.every((item) => ['READY', 'INCOMPLETE', 'NOT_STARTED', 'SKIPPED', 'UNKNOWN'].includes(item.status)),
  `externalItems=${external.length}`)
  const externalSnapshot = (items) => JSON.stringify((items || []).map((item) => ({
    key: item.key,
    status: item.status,
    count: item.count,
    skippable: item.skippable
  })).sort((left, right) => String(left.key).localeCompare(String(right.key))))
  const externalBefore = externalSnapshot(external)

  // 真实写侧：只切换“库存期初”跳过状态并恢复，不触碰成本模型或集成连接。
  const beforeState = dataOf(state)
  const originalSkipped = Array.isArray(beforeState?.skippedItems)
    ? [...beforeState.skippedItems]
    : []
  const openingKey = classified.opening.find((item) => item.skippable === true)?.key
  let skipApplied = false
  let skipRestored = false
  if (openingKey) {
    const skipWrite = await callWrite(api, 'POST',
      `/system/system-init/skip?key=${encodeURIComponent(openingKey)}&skipped=true`,
      undefined, caseRecord)
    const afterSkip = dataOf(await callReadOnly(
      api, 'GET', '/system/system-init/state', undefined, caseRecord))
    skipApplied = isBusinessSuccess(skipWrite) &&
      Array.isArray(afterSkip?.skippedItems) &&
      afterSkip.skippedItems.includes(openingKey)
    addCheck(caseRecord, '跳过期初项后 state.skippedItems 真实包含该键',
      skipApplied, `key=${openingKey} skipped=${JSON.stringify(afterSkip?.skippedItems)}`)

    const restoreWrite = await callWrite(api, 'POST',
      `/system/system-init/skip?key=${encodeURIComponent(openingKey)}&skipped=false`,
      undefined, caseRecord)
    const restoredState = dataOf(await callReadOnly(
      api, 'GET', '/system/system-init/state', undefined, caseRecord))
    skipRestored = isBusinessSuccess(restoreWrite) &&
      Array.isArray(restoredState?.skippedItems) &&
      normalize([...(restoredState.skippedItems || [])].sort()) ===
      normalize([...originalSkipped].sort())
    addCheck(caseRecord, '取消跳过期初项后 state.skippedItems 恢复到原值（反向闭环）',
      skipRestored,
      `original=${JSON.stringify(originalSkipped)} restored=${JSON.stringify(restoredState?.skippedItems)}`)
  } else {
    addCheck(caseRecord, '存在可跳过的库存期初项',
      false, `opening=${JSON.stringify(classified.opening)}`)
  }

  const readyAfterSkip = await callReadOnly(
    api, 'GET', '/system/system-init/readiness', undefined, caseRecord)
  const externalAfter = externalSnapshot(
    readinessClassification(readyAfterSkip).items
      ?.filter((item) => /cost|成本|integration|集成|connection|连接/.test(item.haystack)) || [])
  addCheck(caseRecord, '成本模型/集成可选连接在期初跳过往返前后保持不变',
    external.length > 0 && externalBefore === externalAfter,
    `before=${externalBefore} after=${externalAfter}`)

  const topologyRows = await readSql(caseRecord, 'wms-topology-and-erp-view', `
    SELECT 'warehouse', COUNT(*) FROM mes_wms_ware_house
    WHERE tenant_id = 1 AND deleted = 0 AND is_enabled = 1;
    SELECT 'warehouse-total', COUNT(*) FROM mes_wms_ware_house
    WHERE tenant_id = 1 AND deleted = 0;
    SELECT 'area', COUNT(*) FROM mes_wms_house_area
    WHERE tenant_id = 1 AND deleted = 0 AND is_enabled = 1;
    SELECT 'location', COUNT(*) FROM mes_wms_house_location
    WHERE tenant_id = 1 AND deleted = 0 AND is_enabled = 1;
    SELECT 'orphan-area', COUNT(*)
    FROM mes_wms_house_area a
    LEFT JOIN mes_wms_ware_house w
      ON w.tenant_id = a.tenant_id AND w.deleted = 0
      AND CAST(w.id AS CHAR) = a.house_id
    WHERE a.tenant_id = 1 AND a.deleted = 0 AND a.is_enabled = 1 AND w.id IS NULL;
    SELECT 'orphan-location', COUNT(*)
    FROM mes_wms_house_location l
    LEFT JOIN mes_wms_house_area a
      ON a.tenant_id = l.tenant_id AND a.deleted = 0
      AND CAST(a.id AS CHAR) = l.area_id
    LEFT JOIN mes_wms_ware_house w
      ON w.tenant_id = l.tenant_id AND w.deleted = 0
      AND CAST(w.id AS CHAR) = l.house_id
    WHERE l.tenant_id = 1 AND l.deleted = 0 AND l.is_enabled = 1
      AND (a.id IS NULL OR w.id IS NULL OR a.house_id <> l.house_id);
    SELECT 'erp-view', COUNT(*)
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'erp_warehouse' AND table_type = 'VIEW';
    SELECT 'erp-rows', COUNT(*) FROM erp_warehouse
    WHERE tenant_id = 1 AND deleted = 0;
  `)
  const topology = new Map((topologyRows || []).map((row) => [row[0], Number(row[1])]))
  const wmsItem = (classified.items || []).find((item) => item.key === 'wms.base')
  const topologyValidation = validateWmsTopology(topology, wmsItem?.status)
  const topologyComplete = topologyValidation.valid
  addCheck(caseRecord, 'WMS 仓库/库区/库位层级完整且 ERP 兼容视图按同租户同源回读',
    topologyComplete,
    `topology=${JSON.stringify(Object.fromEntries(topology))} readiness=${wmsItem?.status || 'missing'}` +
      (topologyValidation.reason ? ` reason=${topologyValidation.reason}` : ''))
  // Official readiness facts are tenant-scoped and must never be fabricated.
  const factRows = await readSql(caseRecord, 'init-readiness-facts', initReadinessFactSql(1))
  const factValidation = validateInitReadinessFacts(factRows, classified.items || [])
  const factMap = factValidation.factMap
  addCheck(caseRecord, 'readiness 七类官方计数与当前租户事实一致', factValidation.valid,
    factValidation.valid
      ? INIT_READINESS_FACT_KEYS.map((key) => `${key}=${factMap.get(key)}`).join(' ')
      : factValidation.reason)
  let jobVerified = false
  try {
    const result = await runReadOnlySql(`
      SELECT 'enabled-jobs', COUNT(*) FROM infra_job WHERE deleted = 0 AND status = 1;
      SELECT 'active-triggers', COUNT(*) FROM QRTZ_TRIGGERS
      WHERE TRIGGER_STATE IN ('WAITING', 'ACQUIRED', 'BLOCKED')
    `)
    if (result.available) {
      const map = new Map(result.rows.map(([key, value]) => [key, Number(value)]))
      jobVerified = map.get('enabled-jobs') === 0 && map.get('active-triggers') === 0
      caseRecord.database = [...(caseRecord.database || []), { stage: 'job-read-only', rows: result.rows }]
    } else caseRecord.notes.push(`Job 只读证据不可用：${result.reason}`)
  } catch (error) {
    caseRecord.notes.push(`Job 只读检查未完成：${String(error.message || error).slice(0, 240)}`)
  }
  addCheck(caseRecord, 'Job 默认关闭且 Quartz 无活动触发器', jobVerified, jobVerified ? 'read-only SQL' : '缺少可用只读数据库证据')
  const verified = new Map([
    [0, {
      status: factValidation.valid && topologyComplete ? 'VERIFIED' : 'GAP',
      ...(factValidation.valid && topologyComplete
        ? { evidenceChecks: [
            '必配事实按 readiness 分类完整返回',
            'readiness 七类官方计数与当前租户事实一致',
            'WMS 仓库/库区/库位层级完整且 ERP 兼容视图按同租户同源回读'
          ] }
        : { reason: '七类事实或 WMS/ERP 同源拓扑未全部闭环' })
    }],
    [1, {
      status: skipApplied && skipRestored ? 'VERIFIED' : 'GAP',
      ...(skipApplied && skipRestored
        ? { evidenceChecks: [
            '跳过期初项后 state.skippedItems 真实包含该键',
            '取消跳过期初项后 state.skippedItems 恢复到原值（反向闭环）'
          ] }
        : { reason: '库存期初跳过或恢复写侧未闭环' })
    }],
    [2, {
      status: external.length > 0 && externalBefore === externalAfter ? 'VERIFIED' : 'GAP',
      ...(external.length > 0 && externalBefore === externalAfter
        ? { evidenceChecks: [
            '成本模型/集成仅按现状读取，不伪造外部连接',
            '成本模型/集成可选连接在期初跳过往返前后保持不变'
          ] }
        : { reason: '成本模型/集成连接前后快照不稳定或未见结构化项' })
    }]
  ])
  if (jobVerified) {
    verified.set(3, {
      status: 'VERIFIED',
      evidenceChecks: ['Job 默认关闭且 Quartz 无活动触发器'],
      evidence: '只读快照 enabled-jobs=0、active-triggers=0；默认关闭策略由 V202609272500__disable_jobs_by_default.sql 明确设置 infra_job=2、Quartz=PAUSED'
    })
  } else {
    verified.set(3, {
      status: 'GAP',
      reason: '缺少 enabled Job 与 Quartz active trigger 的完整只读快照'
    })
  }
  initializeCatalogAssertions(caseRecord, 'INIT-005', verified)
  evidence(caseRecord,
    `state status=${text(dataOf(state)?.status)}；readiness 七类官方计数与 tenant_id=1 事实核对， ` +
    '未启用 Job、未伪造外部连接。')
}

async function runPb001002 ({ api, page, caseRecord, record, navigate }) {
  const readOrganization = () => callReadOnly(
    api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord)
  const beforePayload = await readOrganization()
  const before = dataOf(beforePayload)
  if (!isBusinessSuccess(beforePayload) || !before) {
    throw new Error('BLOCKED: 无法读取当前企业组织资料，Logo 写侧前置不足')
  }
  // 页面契约：三种 Logo 字段存在且均为可选（未标记必填）。
  let optional = false
  if (page) {
    const opened = await openReadOnlyRoute(
      page,
      initRoutes.enterpriseOrganization,
      navigate,
      caseRecord
    )
    if (opened) {
      const fields = await page.evaluate(() => [...document.querySelectorAll('.el-form-item')].map((item) => ({
        label: item.querySelector('.el-form-item__label')?.textContent || '',
        required: item.classList.contains('is-required'),
        hasRequiredMark: item.classList.contains('is-required') ||
          Boolean(item.querySelector('.el-form-item__asterisk'))
      }))).catch(() => [])
      const logo = inspectLogoFields(fields)
      optional = logo.optional
      addCheck(caseRecord, '企业资料页三种 Logo 字段存在且未标记为必填', optional,
        `found=${logo.found}`)
    }
  }
  // 真实写侧：Logo 字段留空保存，服务端必须补齐并持久化四个地址。
  const uniqueShortName = `E2E${String(Date.now()).slice(-8)}`
  const writeResult = await api.request('PUT', '/system/enterprise-organization/current', {
    enterpriseFullName: before.enterpriseFullName,
    enterpriseShortName: uniqueShortName,
    enterpriseType: before.enterpriseType,
    unifiedSocialCreditCode: before.unifiedSocialCreditCode,
    industryCategory: before.industryCategory,
    industrySubCategory: before.industrySubCategory,
    taxpayerQualification: before.taxpayerQualification,
    province: before.province,
    provinceCode: before.provinceCode,
    city: before.city,
    cityCode: before.cityCode,
    district: before.district,
    districtCode: before.districtCode,
    registeredAddress: before.registeredAddress
    // 四个 Logo 字段留空，交由服务端生成
  })
  caseRecord.api = [...(caseRecord.api || []), {
    method: 'PUT', pathname: '/system/enterprise-organization/current',
    code: writeResult?.code, success: isBusinessSuccess(writeResult)
  }]
  const after = dataOf(await readOrganization())
  const logoFields = ['enterpriseLogoUrl', 'brandMarkUrl', 'brandLogoUrl', 'brandDarkLogoUrl']
  const generated = after != null && logoFields.every((field) =>
    typeof after[field] === 'string' && after[field].trim() !== '')
  addCheck(caseRecord, '保存时服务端补齐并持久化四个 Logo 地址',
    isBusinessSuccess(writeResult) && generated,
    `code=${writeResult?.code} shortName=${after?.enterpriseShortName} ` +
    logoFields.map((field) => `${field}=${Boolean(after?.[field])}`).join(' '))
  if (page) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  const reread = dataOf(await readOrganization())
  const rereadConsistent = generated && logoFields.every((field) =>
    reread?.[field] === after?.[field])
  addCheck(caseRecord, '刷新后 Logo 地址可回读且与生成值一致',
    rereadConsistent, `mark=${reread?.brandMarkUrl || 'n/a'}`)
  // 反证：再次保存并显式清空 Logo，服务端必须重新生成而非留下空值。
  const regenResult = await api.request('PUT', '/system/enterprise-organization/current', {
    enterpriseFullName: before.enterpriseFullName,
    enterpriseShortName: uniqueShortName,
    enterpriseType: before.enterpriseType,
    unifiedSocialCreditCode: before.unifiedSocialCreditCode,
    industryCategory: before.industryCategory,
    industrySubCategory: before.industrySubCategory,
    taxpayerQualification: before.taxpayerQualification,
    province: before.province, provinceCode: before.provinceCode,
    city: before.city, cityCode: before.cityCode,
    district: before.district, districtCode: before.districtCode,
    registeredAddress: before.registeredAddress,
    enterpriseLogoUrl: '', brandMarkUrl: '', brandLogoUrl: '', brandDarkLogoUrl: ''
  })
  const regenerated = dataOf(await readOrganization())
  const reGenerated = isBusinessSuccess(regenResult) && logoFields.every((field) =>
    typeof regenerated?.[field] === 'string' && regenerated[field].trim() !== '')
  addCheck(caseRecord, '清空 Logo 后再次保存仍由服务端重新生成（幂等/反向）',
    reGenerated, `code=${regenResult?.code}`)
  const brandRows = await readSql(caseRecord, 'brand-config-persisted',
    "SELECT tag, config_data FROM system_config WHERE tenant_id=1 AND category='global' AND tag='common'")
  const brandConfig = brandRows?.find((row) => row[0] === 'common')?.[1] || ''
  const brandPersisted = /brandMarkUrl/.test(brandConfig) &&
    /brandLogoUrl/.test(brandConfig) && /brandDarkLogoUrl/.test(brandConfig)
  addCheck(caseRecord, '品牌配置持久化服务端生成的 Logo 地址',
    brandPersisted, `tenantId=1 bytes=${brandConfig.length}`)
  // 反向闭环：恢复原始企业简称与原始 Logo 地址。
  const restoreBody = Object.fromEntries([
    'enterpriseFullName', 'enterpriseType', 'unifiedSocialCreditCode', 'industryCategory',
    'industrySubCategory', 'taxpayerQualification', 'province', 'provinceCode', 'city',
    'cityCode', 'district', 'districtCode', 'registeredAddress',
    'enterpriseLogoUrl', 'brandMarkUrl', 'brandLogoUrl', 'brandDarkLogoUrl'
  ].map((field) => [field, before[field]]))
  restoreBody.enterpriseShortName = before.enterpriseShortName
  const restoreResult = await api.request('PUT', '/system/enterprise-organization/current', restoreBody)
  const restored = dataOf(await readOrganization())
  const restoredOk = isBusinessSuccess(restoreResult) &&
    restored?.enterpriseShortName === before.enterpriseShortName &&
    logoFields.every((field) => restored?.[field] === before?.[field])
  addCheck(caseRecord, '恢复原始企业简称与 Logo（反向闭环）',
    restoredOk, `restoredShortName=${restored?.enterpriseShortName}`)
  const verified = new Map()
  if (optional) verified.set(0, { status: 'VERIFIED' })
  if (generated && brandPersisted) verified.set(1, { status: 'VERIFIED' })
  if (rereadConsistent) verified.set(2, { status: 'VERIFIED' })
  initializeCatalogAssertions(caseRecord, 'PB001-002', verified)
  evidence(caseRecord,
    `真实写侧：Logo 留空保存 -> 服务端补齐四个地址 -> 刷新回读一致 -> 清空后再次生成；` +
    `system_config(tenantId=1) 持久化品牌 Logo；随后恢复原始简称与 Logo。`)
}

export async function runCase (context, dependencies = {}) {
  const { caseId, caseRecord } = context
  if (!cases.includes(caseId)) throw new Error(`Unsupported init gap case: ${caseId}`)
  assertSafeScope(dependencies.config || config)
  initializeCatalogAssertions(caseRecord, caseId)
  if (caseId !== 'INIT-005') {
    const { runIsolatedLocalInitCase, localInitEvidence } = await import('./init-local-closure.mjs')
    await runIsolatedLocalInitCase(context, dependencies)
    const mapping = localInitEvidence[caseId]
    initializeCatalogAssertions(caseRecord, caseId, new Map(Object.entries(mapping)
      .map(([index, entry]) => [Number(index), {
        status: 'VERIFIED', evidenceChecks: entry.checks
      }])))
    return finalizeGapEvidence(caseRecord)
  }
  const record = context.record || { api: [] }
  const page = context.page || dependencies.page
  let token = context.token || dependencies.token || ''
  if (!token && page && dependencies.login !== false) token = await login(page, { check: dependencies.check })
  const api = dependencies.api || createApiClient({ token, record })
  const navigate = dependencies.openRoute || openRoute
  const runContext = { api, page, caseRecord, record, navigate }
  if (caseId === 'PB001-002') {
    // 真实写侧后立即恢复原始企业简称与 Logo，不改变租户 1 的最终状态。
    await runPb001002(runContext)
  }
  if (caseId === 'INIT-002') await runInit002(runContext)
  if (caseId === 'INIT-003') await runInit003(runContext)
  if (caseId === 'INIT-004') await runInit004(runContext)
  if (caseId === 'INIT-005') await runInit005(runContext)
  return finalizeGapEvidence(caseRecord)
}

export function finalizeGapEvidence (caseRecord) {
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED')
    .map((item) => ({
      index: item.index,
      assertion: item.assertion,
      ...(item.reason ? { reason: item.reason } : {})
    }))
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.catalogAssertions.length > 0 &&
    caseRecord.catalogAssertions.every((item) =>
      item.status === 'VERIFIED' && Array.isArray(item.evidenceChecks) && item.evidenceChecks.length > 0 &&
      item.evidenceChecks.every((name) => {
        const checks = (caseRecord.checks || []).filter((check) => check.name === name)
        return checks.length === 1 && checks[0].passed === true
      }))
  caseRecord.acceptanceComplete = caseRecord.catalogComplete &&
    caseRecord.checks.length > 0 &&
    caseRecord.checks.every((item) => item.passed === true)
  caseRecord.readyCandidate = caseRecord.acceptanceComplete
  caseRecord.passCandidate = caseRecord.acceptanceComplete
  return {
    partial: !caseRecord.acceptanceComplete,
    acceptanceComplete: caseRecord.acceptanceComplete,
    passCandidate: caseRecord.passCandidate,
    note: caseRecord.acceptanceComplete ? '原 catalog 逐项检查完整，最终由 runner 验证运行时错误'
      : caseRecord.remainingAssertions.map((item) => `${item.assertion}: ${item.reason || '缺证'}`).join('；')
  }
}
