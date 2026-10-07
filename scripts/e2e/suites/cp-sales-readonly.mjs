import { config } from '../config/index.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { decryptResponse, encryptRequest, ENCRYPT_HEADER } from '../lib/crypto.mjs'

export const cases = Object.freeze([
  'CP-158-001',
  'CP-160-161-001',
  'CP-162-164-001',
  'CP-165-166-167-168-169-001'
])

export const cpSalesReadonlyRegistration = Object.freeze({
  suite: 'cp-sales-readonly',
  cases,
  status: 'PARTIAL',
  mode: 'api-only',
  ui: 'UNVERIFIED',
  catalog: 'not-registered-by-design'
})

export const customerPortalPaths = Object.freeze({
  login: '/customer-api/customer/auth/login',
  adminPermissionInfo: '/admin-api/system/auth/get-permission-info',
  workbenchSummary: '/customer-api/customer/workbench/summary',
  saleOrderPage: '/customer-api/customer/sale-order/page?pageNo=1&pageSize=100',
  saleOrderGet: (id) => `/customer-api/customer/sale-order/get?id=${encodeURIComponent(id)}`,
  deliveryPage: '/customer-api/customer/delivery/page?pageNo=1&pageSize=100',
  deliveryGet: (id) => `/customer-api/customer/delivery/get?id=${encodeURIComponent(id)}`,
  reconciliationPage: '/customer-api/customer/reconciliation/page?pageNo=1&pageSize=100',
  reconciliationGet: (id) =>
    `/customer-api/customer/reconciliation/get?id=${encodeURIComponent(id)}`,
  invoicePage: '/customer-api/customer/invoice/page?pageNo=1&pageSize=100',
  invoiceGet: (id) => `/customer-api/customer/invoice/get?id=${encodeURIComponent(id)}`,
  receivableSummary: '/customer-api/customer/receivable/summary',
  receivablePage: '/customer-api/customer/receivable/page?pageNo=1&pageSize=100',
  feedbackPage: '/customer-api/customer/feedback/page?pageNo=1&pageSize=100',
  feedbackGet: (id) => `/customer-api/customer/feedback/get?id=${encodeURIComponent(id)}`,
  unreadCount: '/customer-api/customer/notify/unread-count',
  unreadList: '/customer-api/customer/notify/unread-list?size=50',
  messagePage: '/customer-api/customer/notify/page?pageNo=1&pageSize=100'
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => value !== undefined && value !== null && String(value).trim() !== ''
const hasId = (value) =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && nonEmpty(value))

const addCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}${details ? ` | ${details}` : ''}`)
}

const addGap = (caseRecord, note) => {
  caseRecord.notes.push(`未验收：${note}；结果保持 PARTIAL`)
}

const responseHeader = (response, name) =>
  response.headers?.get?.(name) || response.headers?.get?.(name.toLowerCase()) || ''

const decode = async (response) => {
  const text = await response.text()
  if (responseHeader(response, ENCRYPT_HEADER) === 'true') return decryptResponse(text)
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const safeSummary = (body) => ({
  code: body?.code,
  success: body?.success
})

const customerCredentials = (env = process.env) => {
  const loginName = String(env.CFOR_CUSTOMER_USERNAME || '').trim()
  const password = env.CFOR_CUSTOMER_PASSWORD || ''
  return loginName && password ? { loginName, password } : null
}

export { customerCredentials }

export const customerPortalSession = (body, tenantId, now = Date.now()) => {
  const data = body?.data
  const expiresRaw = data?.expiresTime
  const expiresTime = typeof expiresRaw === 'number'
    ? expiresRaw < 10_000_000_000 ? expiresRaw * 1000 : expiresRaw
    : typeof expiresRaw === 'string' ? Date.parse(expiresRaw) : NaN
  if (!isBusinessSuccess(body) ||
      !isObject(data) ||
      !nonEmpty(data.accessToken) ||
      !nonEmpty(data.refreshToken) ||
      !hasId(data.userId) ||
      !hasId(data.basePartnerId) ||
      !nonEmpty(data.partnerName) ||
      String(data.tenantId) !== String(tenantId) ||
      !Number.isFinite(expiresTime) ||
      expiresTime <= now) {
    throw new Error('客户门户登录响应缺少有效独立令牌、主体、租户或有效期')
  }
  return {
    accessToken: String(data.accessToken),
    refreshToken: String(data.refreshToken),
    expiresTime,
    tenantId: String(data.tenantId),
    userId: String(data.userId),
    basePartnerId: String(data.basePartnerId),
    partnerName: String(data.partnerName)
  }
}

const localScope = (settings) => {
  const api = new URL(settings.apiBase)
  if (settings.target !== 'local' ||
      api.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname) ||
      api.port !== '48083' ||
      api.username ||
      api.password ||
      String(settings.tenantId || '') !== '1' ||
      settings.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: CP 客户门户只允许本地 48083、租户 1、CFOR 标准平台')
  }
}

const requestClient = ({ apiBase, tenantId, token = '', record, fetchImpl }) => async (
  method,
  pathname,
  body,
  { encrypted = false } = {}
) => {
  const headers = {
    'content-type': 'application/json',
    'tenant-id': String(tenantId),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(encrypted ? { [ENCRYPT_HEADER]: 'true' } : {})
  }
  const response = await fetchImpl(`${apiBase}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : encrypted ? encryptRequest(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  })
  const payload = await decode(response)
  record?.api?.push({
    method,
    pathname,
    status: response.status,
    code: payload?.code
  })
  if (!response.ok) {
    throw new Error(`客户门户 ${method} ${pathname} HTTP ${response.status}`)
  }
  return payload
}

const requireBusiness = async (client, pathname, label) => {
  const payload = await client('GET', pathname)
  if (!isBusinessSuccess(payload)) {
    const summary = safeSummary(payload)
    throw new Error(`${label}业务响应失败 code=${summary.code}`)
  }
  return payload.data
}

const requirePage = async (client, pathname, label, caseRecord) => {
  const data = await requireBusiness(client, pathname, label)
  if (!isObject(data) || !Array.isArray(data.list) ||
      !Number.isSafeInteger(data.total) ||
      data.total < data.list.length ||
      data.list.length > 100) {
    throw new Error(`${label}分页响应结构异常`)
  }
  addCheck(caseRecord, `${label}返回合法分页 envelope`, true,
    `rows=${data.list.length}; total=${data.total}`)
  if (!data.list.length) addGap(caseRecord, `${label}为空，未验收非空业务字段或详情关联`)
  else addCheck(caseRecord, `${label}非空样本均有稳定编号`,
    data.list.every((row) => isObject(row) && hasId(row.id)),
    `rows=${data.list.length}`)
  return data.list
}

const requireDetail = async (client, pathname, label, id, caseRecord) => {
  const data = await requireBusiness(client, pathname, label)
  addCheck(caseRecord, `${label}详情返回对象且编号一致`,
    isObject(data) && hasId(data.id) && String(data.id) === String(id),
    `id=${id}`)
  return data
}

const partialResult = (caseRecord, reason) => {
  addGap(caseRecord, reason)
  const note = 'API-only 客户门户只读核验始终 PARTIAL：未验证真实浏览器页面、菜单渲染、' +
    '外部系统同步和全部业务写侧。'
  caseRecord.notes.push(note)
  return { partial: true, note }
}

const verifyAdminIsolation = async (client, caseRecord) => {
  let payload
  try {
    payload = await client('GET', customerPortalPaths.adminPermissionInfo)
  } catch (error) {
    if (!String(error.message).includes('HTTP 401') &&
        !String(error.message).includes('HTTP 403')) throw error
    addCheck(caseRecord, '客户令牌访问 /admin-api 被拒绝', true, 'HTTP 401/403')
    return
  }
  if (isBusinessSuccess(payload) || ![401, 403].includes(Number(payload?.code))) {
    throw new Error('客户令牌访问 /admin-api 未被拒绝')
  }
  addCheck(caseRecord, '客户令牌访问 /admin-api 被拒绝', true,
    `code=${payload.code}`)
}

const runCaseContract = async (caseId, client, caseRecord, session) => {
  if (caseId === 'CP-158-001') {
    await verifyAdminIsolation(client, caseRecord)
    const summary = await requireBusiness(client, customerPortalPaths.workbenchSummary, '客户工作台')
    addCheck(caseRecord, '客户工作台摘要返回对象且保留客户主体',
      isObject(summary) &&
      String(summary.basePartnerId) === session.basePartnerId &&
      summary.partnerName === session.partnerName)
    return partialResult(caseRecord, '独立认证与客户令牌隔离已通过 API 核验')
  }

  if (caseId === 'CP-160-161-001') {
    const summary = await requireBusiness(client, customerPortalPaths.workbenchSummary, '客户工作台')
    addCheck(caseRecord, '业务总览返回对象且保留客户主体',
      isObject(summary) &&
      String(summary.basePartnerId) === session.basePartnerId &&
      summary.partnerName === session.partnerName)
    const orders = await requirePage(
      client, customerPortalPaths.saleOrderPage, '客户销售订单', caseRecord)
    if (orders.length) {
      const id = orders[0].id
      const detail = await requireDetail(
        client, customerPortalPaths.saleOrderGet(id), '客户销售订单', id, caseRecord)
      if (detail.lines != null) {
        addCheck(caseRecord, '销售订单详情明细为数组', Array.isArray(detail.lines))
      }
    }
    return partialResult(caseRecord, '订单仅执行工作台、列表和详情 GET，未确认或变更订单')
  }

  if (caseId === 'CP-162-164-001') {
    const deliveries = await requirePage(
      client, customerPortalPaths.deliveryPage, '客户发货', caseRecord)
    if (deliveries.length) {
      await requireDetail(
        client, customerPortalPaths.deliveryGet(deliveries[0].id), '客户发货', deliveries[0].id,
        caseRecord)
    }
    return partialResult(caseRecord, '发货仅执行列表和详情 GET，未签收或提交异常反馈')
  }

  const reconciliation = await requirePage(
    client, customerPortalPaths.reconciliationPage, '客户对账', caseRecord)
  if (reconciliation.length) {
    const detail = await requireDetail(
      client,
      customerPortalPaths.reconciliationGet(reconciliation[0].id),
      '客户对账',
      reconciliation[0].id,
      caseRecord
    )
    if (detail.lines != null) {
      addCheck(caseRecord, '对账详情明细为数组', Array.isArray(detail.lines))
    }
  }
  const invoices = await requirePage(
    client, customerPortalPaths.invoicePage, '客户发票', caseRecord)
  if (invoices.length) {
    await requireDetail(
      client, customerPortalPaths.invoiceGet(invoices[0].id), '客户发票', invoices[0].id, caseRecord)
  }
  const receivableSummary = await requireBusiness(
    client, customerPortalPaths.receivableSummary, '客户应收汇总')
  addCheck(caseRecord, '客户应收汇总返回对象', isObject(receivableSummary))
  await requirePage(client, customerPortalPaths.receivablePage, '客户应收', caseRecord)
  const feedback = await requirePage(
    client, customerPortalPaths.feedbackPage, '客户服务反馈', caseRecord)
  if (feedback.length) {
    await requireDetail(
      client, customerPortalPaths.feedbackGet(feedback[0].id), '客户服务反馈', feedback[0].id,
      caseRecord)
  }
  const unreadCount = await requireBusiness(client, customerPortalPaths.unreadCount, '客户未读消息数')
  addCheck(caseRecord, '客户未读消息数为非负整数',
    Number.isSafeInteger(unreadCount) && unreadCount >= 0)
  const unreadList = await requireBusiness(client, customerPortalPaths.unreadList, '客户未读消息')
  addCheck(caseRecord, '客户未读消息返回数组', Array.isArray(unreadList))
  if (!unreadList.length) addGap(caseRecord, '客户未读消息为空，未验收消息字段')
  else addCheck(caseRecord, '客户未读消息非空样本均有稳定编号',
    unreadList.every((row) => isObject(row) && hasId(row.id)))
  await requirePage(client, customerPortalPaths.messagePage, '客户消息', caseRecord)
  return partialResult(
    caseRecord,
    '对账、发票、应收、反馈和消息仅执行 GET，未确认对账、申请开票、提交反馈或标记已读'
  )
}

export async function runCase({ caseId, caseRecord, record } = {}, {
  env = process.env,
  config: settings = config,
  fetchImpl = fetch
} = {}) {
  if (!cases.includes(caseId)) return { designed: true }
  if (!caseRecord) throw new Error('缺少客户门户案例记录')
  localScope(settings)
  const credentials = customerCredentials(env)
  if (!credentials) {
    throw new Error('BLOCKED: 需显式 CFOR_CUSTOMER_USERNAME/CFOR_CUSTOMER_PASSWORD')
  }
  const anonymous = requestClient({
    apiBase: settings.apiBase,
    tenantId: settings.tenantId,
    record,
    fetchImpl
  })
  const loginPayload = await anonymous('POST', customerPortalPaths.login, credentials, {
    encrypted: true
  })
  const session = customerPortalSession(loginPayload, settings.tenantId)
  const customer = requestClient({
    apiBase: settings.apiBase,
    tenantId: session.tenantId,
    token: session.accessToken,
    record,
    fetchImpl
  })
  addCheck(caseRecord, '客户门户登录使用加密请求、租户 1 且返回独立会话', true,
    `tenantId=${session.tenantId}; userId=${session.userId}; token仅驻进程`)
  return runCaseContract(caseId, customer, caseRecord, session)
}
