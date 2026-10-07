import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'

export const cases = ['INT-001', 'INT-002']
export const integrationReadonlyBoundary =
  'INT-001 仅验收本地目录、连接器和既有实例 API，只读范围始终 PARTIAL；' +
  'UI、外部连接、创建实例、订阅和执行/重试均未验收，INT-002 保持范围外。'
export const integrationInitBlocker =
  'UI 尚未验收：不导航平台页或引导中心，不读取权限信息；' +
  'AppView 会探测初始化 GET，readiness 调用 refreshCompleted 回写，getState 缺省时 insert。'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim() !== ''
const id = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && /^[1-9]\d*$/.test(value))
const code = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)
const unique = (rows, key) => new Set(rows.map((row) => String(row[key]))).size === rows.length
const fact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(name)
}
const gap = (record, note) => record.notes.push(`未验收：${note}；保留 PARTIAL`)
const data = (payload, label) => {
  if (!isBusinessSuccess(payload)) throw new Error(`${label} 业务响应失败（正文不记录）`)
  return payload.data
}
const get = async (api, pathname) => {
  try { return await api.get(pathname) } catch {
    throw new Error(`只读 GET ${pathname} 失败（正文和凭据不记录）`)
  }
}
const validDocs = (value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

export function integrationReadonlyArray (payload, label) {
  const rows = data(payload, label)
  if (!Array.isArray(rows)) throw new Error(`${label} 必须返回 data 数组`)
  return rows
}

export function integrationReadonlyPage (payload) {
  const result = data(payload, '实例分页')
  if (!object(result) || !Array.isArray(result.list) ||
    !Number.isSafeInteger(result.total) || result.total < result.list.length ||
    result.list.length > 100) throw new Error('实例分页 list/total 契约无效')
  return result
}

export function integrationConfigIsMasked (configData) {
  if (configData == null || configData === '') return true
  let parsed
  try { parsed = JSON.parse(configData) } catch { return false }
  const sensitive = /secret|password|token|^(?:pwd|encrypt_?key|sign_?key|private_?key|api_?key)$/i
  const visit = (value) => {
    if (Array.isArray(value)) return value.every(visit)
    if (!object(value)) return true
    return Object.entries(value).every(([key, item]) =>
      sensitive.test(key.replace(/[-.]/g, '')) ? item === '******' : visit(item))
  }
  return object(parsed) && visit(parsed)
}

export function assertIntegrationLocalScope (settings) {
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083']]) {
    const url = new URL(base)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.port !== port || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash) throw new Error('BLOCKED: INT-001 仅允许本地 9151/48083')
  }
  if (settings.target !== 'local' ||
    (settings.tenantId != null && settings.tenantId !== '' && String(settings.tenantId) !== '1') ||
    settings.tenantName !== 'CFOR 标准平台' || settings.username !== 'admin' ||
    settings.apiUrl !== `${settings.apiBase}/admin-api`) {
    throw new Error('BLOCKED: INT-001 必须使用租户 1 / CFOR 标准平台 / admin')
  }
}

export async function runIntegrationReadonlyContract ({ api, caseRecord }) {
  const readList = async (path, label) => {
    const rows = integrationReadonlyArray(await get(api, path), label)
    fact(caseRecord, `${label} data 数组响应契约`, true, `count=${rows.length}`)
    if (!rows.length) gap(caseRecord, `${label}为空，仅验收数组外壳，未验收字段样本`)
    return rows
  }
  const platforms = await readList('/integration/platform/list-all', '平台目录')
  const enabled = await readList('/integration/platform/list-enabled', '启用平台')
  const adapters = await readList('/integration/platform/registered-adapters', '注册适配器')
  if (platforms.length) fact(caseRecord, '全局平台行有稳定编号、编码、名称、启用标记及模板租户 0',
    platforms.every((row) => object(row) && id(row.id) && code(row.code) &&
      text(row.name) && typeof row.isActive === 'boolean' && String(row.tenantId) === '0') &&
      unique(platforms, 'code') && unique(platforms, 'id'), `count=${platforms.length}（非双租户验证）`)
  fact(caseRecord, '启用目录精确对应全局目录的启用平台',
    enabled.every((row) => object(row) && row.isActive === true && String(row.tenantId) === '0' &&
      platforms.some((item) => item.code === row.code && String(item.id) === String(row.id) &&
        item.name === row.name)) && unique(enabled, 'code') &&
      enabled.length === platforms.filter((row) => row.isActive).length)
  if (adapters.length) fact(caseRecord, '注册适配器只声明唯一平台编码，不代表外部连接成功',
    adapters.every(code) && new Set(adapters).size === adapters.length)

  const eligibleCodes = []
  for (const platform of enabled) {
    const connectors = await readList(
      `/integration/connector/list-preset-by-platform?platformCode=${platform.code}`, '预置连接器')
    if (!connectors.length) continue
    fact(caseRecord, '预置连接器的编号、平台归属、系统标记及模板租户正确',
      connectors.every((row) => object(row) && id(row.id) && row.platformCode === platform.code &&
        text(row.connectorName) && row.isSystemPreset === true && String(row.tenantId) === '0') &&
        unique(connectors, 'id'), `platform=${platform.code} count=${connectors.length}`)
    for (const connector of connectors) {
      let schema
      try { schema = JSON.parse(connector.authSchema) } catch {}
      fact(caseRecord, '预置连接器 authSchema 是真实参数对象定义',
        object(schema) && schema.type === 'object' && object(schema.properties) &&
          Object.keys(schema.properties).length > 0 && Object.values(schema.properties).every(object),
        `platform=${platform.code}（不记录参数默认值或地址）`)
    }
    const detail = data(await get(api, `/integration/connector/get?id=${connectors[0].id}`), '连接器详情')
    fact(caseRecord, '连接器详情精确对应现存预置模板',
      object(detail) && String(detail.id) === String(connectors[0].id) &&
        detail.platformCode === platform.code && detail.isSystemPreset === true &&
        String(detail.tenantId) === '0' && detail.authSchema === connectors[0].authSchema)
    if (!adapters.includes(platform.code)) continue
    eligibleCodes.push(platform.code)
    fact(caseRecord, '即配候选平台有运营维护的官方文档和注册步骤',
      validDocs(platform.officialDocsUrl) && text(platform.officialDocsLabel) &&
        text(platform.configGuideTitle) && text(platform.configGuideSteps),
      `platform=${platform.code}（只检查地址结构，不访问官方站点）`)
  }
  if (!eligibleCodes.length) gap(caseRecord, '启用平台/注册适配器/预置模板交集为空，未验证即配 UI')
  const instances = integrationReadonlyPage(
    await get(api, '/integration/instance/page?pageNo=1&pageSize=100'))
  fact(caseRecord, '实例分页 list/total 响应契约', true, `count=${instances.list.length} total=${instances.total}`)
  if (instances.list.length) {
    fact(caseRecord, '既有实例分页返回稳定编号、平台编码和真实测试状态字段',
      instances.list.every((row) => object(row) && id(row.id) && code(row.platformCode) &&
        text(row.instanceName) && typeof row.isActive === 'boolean' &&
        (row.lastTestResult == null || typeof row.lastTestResult === 'boolean') &&
        (row.lastTestTime == null || text(row.lastTestTime) ||
          (Array.isArray(row.lastTestTime) && row.lastTestTime.length >= 3)) &&
        (row.lastTestResult !== true || row.lastTestTime != null)) && unique(instances.list, 'id'))
    fact(caseRecord, '实例 configData 中敏感字段仅返回服务端掩码',
      instances.list.every((row) => integrationConfigIsMasked(row.configData)), '不记录配置或测试消息')
  } else {
    gap(caseRecord, '实例为空，仅验收分页外壳，未验收掩码与历史连接状态样本')
  }
  if (instances.total > instances.list.length) gap(caseRecord, '实例仅覆盖首页最多 100 条')
  gap(caseRecord, 'IntegrationInstanceRespVO 不含 tenantId，未证明跨租户互斥或未授权写入拒绝')
  gap(caseRecord, integrationInitBlocker)
  caseRecord.notes.push(integrationReadonlyBoundary)
  caseRecord.evidence.push(
    '源码：Platform/ConnectorController -> ServiceImpl -> selectGlobal*（tenant_id=0）；' +
    'InstanceController.page -> ServiceImpl.getInstancePage -> Mapper.selectPage，返回前 maskForDisplay。')
  return { partial: true, note: integrationReadonlyBoundary, eligibleCodes }
}

export async function runCase ({ caseId, caseRecord }, dependencies = {}) {
  if (caseId !== 'INT-001') {
    const note = 'INT-002 未实现受控流程；缺获准外部系统和凭据，保持范围外，不认证、不测试连接。'
    caseRecord?.notes.push(note)
    return { notImplemented: true, partial: true, note }
  }
  const settings = dependencies.config || config
  assertIntegrationLocalScope(settings)
  if (!text(settings.password)) throw new Error('BLOCKED: INT-001 缺进程环境 CFOR_PASSWORD/CFOR_PASS')
  const factory = dependencies.createApiClient || createApiClient
  // No record/check: login tokens and JSON-string configData must never enter shared reports.
  const publicApi = factory({ tenantId: '1' })
  const tenantId = data(await get(publicApi,
    `/system/tenant/get-id-by-name?name=${encodeURIComponent(settings.tenantName)}`), '租户名称预检')
  if (String(tenantId) !== '1') throw new Error('BLOCKED: CFOR 标准平台未解析为租户 1')
  let payload
  try {
    payload = await publicApi.post('/system/auth/login-encrypted', {
      username: settings.username, password: settings.password, captchaVerification: ''
    }, { encrypted: true })
  } catch {
    throw new Error('本地 admin 加密认证失败（正文和凭据不记录）')
  }
  const auth = data(payload, 'admin 加密认证')
  fact(caseRecord, '真实 admin 加密认证返回租户 1 访问令牌和用户编号',
    object(auth) && String(auth.tenantId) === '1' && id(auth.userId) &&
      text(auth.accessToken) && auth.accessToken.length > 20 && !/\s/.test(auth.accessToken))
  caseRecord.evidence.push(
    '认证：租户名 GET -> TenantService.getTenantByName -> selectByName；' +
    'AuthController.login-encrypted -> AdminAuthServiceImpl.login，凭据/token 仅驻进程内存。')
  return runIntegrationReadonlyContract({
    api: factory({ token: auth.accessToken, tenantId: '1' }), caseRecord
  })
}
