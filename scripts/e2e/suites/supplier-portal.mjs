import { config } from '../config/index.mjs'
import { isBusinessSuccess, nonEmpty } from '../lib/assertions.mjs'
import { decryptResponse, encryptRequest, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB150-OUTSOURCE-PORTAL-001']
export const supplierSessionKey = 'CFOR_SUPPLIER_PORTAL_SESSION'
const activeStatuses = ['RELEASED', 'EXECUTING', 'PARTIAL_COMPLETED']
const accountStatuses = ['ENABLED', 'DISABLED', 'INVITED', 'LOCKED']

const finiteNumber = (value) => ['number', 'string'].includes(typeof value) &&
  nonEmpty(value) && Number.isFinite(Number(value))
const hasId = (value) => ['number', 'string'].includes(typeof value) && nonEmpty(value) &&
  (typeof value !== 'number' || Number.isSafeInteger(value))

export const supplierCredentials = (env = process.env) => {
  const loginName = String(env.CFOR_SUPPLIER_USERNAME || '').trim()
  // Passwords are not trimmed or inherited from administrator credentials.
  const password = env.CFOR_SUPPLIER_PASSWORD || ''
  return loginName && password ? { loginName, password } : null
}

export const supplierPageRows = (body, label) => {
  const data = body?.data
  if (!isBusinessSuccess(body) || !Array.isArray(data?.list) ||
      !finiteNumber(data.total) || !Number.isSafeInteger(Number(data.total)) ||
      Number(data.total) < data.list.length || data.list.length > 100 ||
      (!data.list.length && Number(data.total) !== 0) ||
      data.list.some((row) => !row || Array.isArray(row) || !hasId(row.id))) {
    throw new Error(`${label}响应异常，不能视为缺少前置`)
  }
  return data.list
}

export const supplierSession = (body, tenantId, now = Date.now()) => {
  const data = body?.data
  const raw = data?.expiresTime
  const expiresTime = typeof raw === 'number'
    ? (raw < 10_000_000_000 ? raw * 1000 : raw)
    : typeof raw === 'string' ? Date.parse(raw) : NaN
  if (!isBusinessSuccess(body) || typeof data?.accessToken !== 'string' || !nonEmpty(data.accessToken) ||
      typeof data?.refreshToken !== 'string' || !nonEmpty(data.refreshToken) || !hasId(data?.userId) ||
      !hasId(data?.basePartnerId) || !hasId(data?.tenantId) ||
      String(data.tenantId) !== String(tenantId) || !nonEmpty(data.partnerName) ||
      !Number.isFinite(expiresTime) || expiresTime <= now) {
    throw new Error('供应商登录响应缺少有效独立令牌/主体/有效期或租户不一致')
  }
  return {
    accessToken: data.accessToken, refreshToken: data.refreshToken, expiresTime,
    tenantId: String(data.tenantId), userId: String(data.userId),
    basePartnerId: String(data.basePartnerId), partnerName: data.partnerName
  }
}

export const supplierBlocker = ({ status, body } = {}) => {
  // Only exact business prerequisites qualify; HTTP/system errors remain failures.
  if (!(status >= 200 && status < 500) || isBusinessSuccess(body)) return null
  const message = body?.msg || body?.message
  const known = new Map([
    [1030620008, '供应商门户账号未启用'],
    [1030620009, '关联供应商主体不存在或已停用']
  ])
  if (known.get(body?.code) === message) return message
  const prerequisites = [
    '供应商门户未启用，请联系企业管理员',
    '当前供应商尚未完成 ERP 供应商映射，请联系企业管理员',
    '当前供应商绑定多个 ERP 供应商，请联系企业管理员确认唯一主体',
    '当前供应商 ERP 映射数据异常，请联系企业管理员'
  ]
  return body?.code === 409 && prerequisites.includes(message) ? message : null
}

export const supplierAuthRejected = ({ status, body } = {}) =>
  ((status === 401 || status === 403) && !isBusinessSuccess(body)) ||
  (status >= 200 && status < 300 && (body?.code === 401 || body?.code === 403))

export const supplierEntryFacts = (html) => ({
  supplier: /id=["']supplier-app["']/.test(html),
  admin: /id=["']app["']/.test(html)
})

const check = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}${details ? ` | ${details}` : ''}`)
}

const decode = async (response) => {
  const text = await response.text()
  if (response.headers.get(ENCRYPT_HEADER.toLowerCase()) === 'true') return decryptResponse(text)
  try { return JSON.parse(text) } catch { return null }
}

const requestClient = ({ prefix, tenantId, record, fetchImpl, token = '' }) => async (
  method, pathname, body, { encrypted = false } = {}
) => {
  const response = await fetchImpl(`${config.apiBase}${prefix}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json', 'tenant-id': String(tenantId),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(encrypted ? { [ENCRYPT_HEADER]: 'true' } : {})
    },
    body: body === undefined ? undefined : encrypted ? encryptRequest(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  })
  const payload = await decode(response)
  // Authentication bodies and headers must never enter persisted evidence.
  record?.api?.push({
    method, pathname: `${prefix}${pathname}`, status: response.status, code: payload?.code
  })
  return { status: response.status, body: payload }
}

const success = (caseRecord, result, label) => {
  check(caseRecord, `${label} HTTP/业务成功`,
    result.status >= 200 && result.status < 300 && isBusinessSuccess(result.body),
    `status=${result.status}; code=${result.body?.code}; msg=${result.body?.msg || ''}`)
  return result.body
}

const accountSafe = (row) => hasId(row?.id) && hasId(row?.basePartnerId) &&
  nonEmpty(row?.loginName) && accountStatuses.includes(row?.status) &&
  !Object.keys(row).some((key) => /password|token|secret/i.test(key))

const inspectOrders = (caseRecord, rows, expectedSupplierId) => {
  if (!rows.length) return
  const supplierId = expectedSupplierId || rows[0].supplierId
  check(caseRecord, '委外样本包含同一供应商主体、正式状态、计划数量与开放预警数量',
    hasId(supplierId) && rows.every((row) =>
      String(row.supplierId) === String(supplierId) && nonEmpty(row.billNo) &&
      [...activeStatuses, 'COMPLETED'].includes(row.outsourceStatus) &&
      finiteNumber(row.planQty) && Number(row.planQty) >= 0 &&
      finiteNumber(row.openWarningCount) && Number.isInteger(Number(row.openWarningCount)) &&
      Number(row.openWarningCount) >= 0 &&
      (row.latestCompletedQty == null ||
        (finiteNumber(row.latestCompletedQty) && Number(row.latestCompletedQty) >= 0)) &&
      (row.latestProgressPercent == null ||
        (finiteNumber(row.latestProgressPercent) &&
          Number(row.latestProgressPercent) >= 0 && Number(row.latestProgressPercent) <= 100))),
    `rows=${rows.length}; legacySupplierId=${supplierId}; 仅当前查询样本`)
}

const inspectWarnings = (caseRecord, rows, order, label) => {
  check(caseRecord, `${label}是当前委外单/供应商的开放预警数组`,
    Array.isArray(rows) && rows.every((row) => hasId(row?.id) &&
      String(row.outsourceId) === String(order.id) &&
      String(row.supplierId) === String(order.supplierId) && row.status === 'OPEN' &&
      ['DUE_SOON', 'OVERDUE', 'NO_FEEDBACK'].includes(row.warningType)),
    `orderId=${order.id}; rows=${Array.isArray(rows) ? rows.length : 'invalid'}`)
}

const storageSnapshot = (page) => page.evaluate(() =>
  ['localStorage', 'sessionStorage'].map((storage) =>
    ['ACCESS_TOKEN', 'REFRESH_TOKEN'].map((key) => window[storage].getItem(key))))

const browserSupplierLogin = async ({ page, credentials, tenantId, caseRecord, captureLogin }) => {
  await page.goto(`${config.webBase}/supplier/login?tenantId=${encodeURIComponent(tenantId)}`, {
    waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs
  })
  const before = await storageSnapshot(page)
  const existing = await page.evaluate((key) => window.localStorage.getItem(key), supplierSessionKey)
  if (existing) throw new Error('BLOCKED: 当前浏览器已有供应商会话，不覆盖或退出非本次登录会话')
  await page.locator('.supplier-login input[autocomplete="username"]').fill(credentials.loginName)
  await page.locator('.supplier-login input[autocomplete="current-password"]').fill(credentials.password)
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/supplier-api/erp/auth/login' &&
    response.request().method() === 'POST')
    .then((response) => ({ response }), (error) => ({ error }))
  await page.locator('.supplier-login__submit').click()
  const received = await responsePromise
  if (received.error) throw received.error
  const response = received.response
  const request = response.request()
  const headers = await request.allHeaders()
  const body = await decode({
    text: () => response.text(),
    headers: new Headers(await response.allHeaders())
  })
  const result = { status: response.status(), body }
  captureLogin(result)
  check(caseRecord, '供应商真实页面登录请求使用加密头与当前 tenant-id',
    headers[ENCRYPT_HEADER.toLowerCase()] === 'true' &&
      headers['tenant-id'] === String(tenantId) && !headers.authorization &&
      !request.postData()?.includes(credentials.password))
  if (!isBusinessSuccess(body)) return { result }
  await page.waitForURL('**/supplier/workbench')
  const stored = await page.evaluate((key) =>
    JSON.parse(window.localStorage.getItem(key) || 'null'), supplierSessionKey)
  check(caseRecord, '供应商会话仅写入独立门户存储键且管理端令牌保持不变',
    stored?.accessToken === body.data?.accessToken &&
      JSON.stringify(before) === JSON.stringify(await storageSnapshot(page)),
    `storageKey=${supplierSessionKey}; 未输出令牌值`)
  return { result, stored }
}

export const runCase = async (
  { caseId, page, record, caseRecord, outputDir } = {},
  { fetchImpl = fetch, env = process.env } = {}
) => {
  if (!caseId || !caseRecord) {
    throw new Error('BLOCKED: 缺少真实案例上下文，不能将历史模拟 smoke 当作供应商业务验收')
  }
  if (!cases.includes(caseId)) return { designed: true }
  caseRecord.notes.push(
    '只读核验：不新建/关联/启停账号，不改客商/ERP映射，不接受邀请，不提交进度/异常，不触发预警Job。登录/退出仅操作本次独立认证会话。'
  )
  const missing = []
  const partial = (reason) => {
    if (reason) missing.push(reason)
    const note = `PARTIAL：${missing.join('；')}；未验证进度/异常写侧、重复幂等键、通知回写与状态版本不变。`
    caseRecord.notes.push(note)
    return { partial: true, note }
  }
  const tenantId = String(env.CFOR_TENANT_ID ?? config.tenantId ?? '').trim()
  if (!/^[1-9]\d*$/.test(tenantId)) {
    throw new Error('BLOCKED: 需显式 CFOR_TENANT_ID，不能绕过租户或猜测供应商归属')
  }
  const credentials = supplierCredentials(env)
  const anonymous = requestClient({ prefix: '/supplier-api', tenantId, record, fetchImpl })
  for (const pathname of ['/erp/workbench/summary', '/erp/outsource-orders/page?pageNo=1&pageSize=100']) {
    const result = await anonymous('GET', pathname)
    check(caseRecord, '无供应商令牌时只读业务入口拒绝访问', supplierAuthRejected(result),
      `GET /supplier-api${pathname}; status=${result.status}; code=${result.body?.code}`)
  }
  const response = await fetchImpl(`${config.webBase}/supplier/login`, {
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  })
  check(caseRecord, '9151 门户入口探测没有服务端错误', response.status < 500,
    `status=${response.status}`)
  const entry = supplierEntryFacts(await response.text())
  const portalAvailable = response.ok && entry.supplier && !entry.admin
  caseRecord.evidence.push(
    `GET ${config.webBase}/supplier/login -> ${response.status}; supplierMount=${entry.supplier}; adminMount=${entry.admin}；仅HTTP构建入口探测，不是Chrome渲染证据`
  )
  if (!portalAvailable) missing.push('9151 /supplier/login 未挂载独立 #supplier-app（管理端SPA回退不算门户）')
  if (!page) missing.push('未执行Chrome登录/路由/表格渲染与存储隔离核验')

  let admin, supplier, supplierToken, expectedAccount, supplierSessionOwned = false
  const captureLogin = (result) => {
    supplierToken = isBusinessSuccess(result.body) ? result.body.data?.accessToken : ''
    if (typeof supplierToken === 'string' && nonEmpty(supplierToken)) supplier = requestClient({
      prefix: '/supplier-api', tenantId, record, fetchImpl, token: supplierToken
    })
  }
  try {
    if (page && portalAvailable) {
      await page.goto(`${config.webBase}/supplier/login`, {
        waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs
      })
      const existing = await page.evaluate((key) => window.localStorage.getItem(key), supplierSessionKey)
      if (existing) throw new Error('BLOCKED: 当前浏览器已有供应商会话，需隔离上下文，不覆盖既有会话')
    }
    const adminPassword = env.CFOR_PASSWORD ?? config.password
    if (adminPassword) {
      const publicAdmin = requestClient({ prefix: '/admin-api', tenantId, record, fetchImpl })
      const auth = success(caseRecord, await publicAdmin('POST', '/system/auth/login-encrypted', {
        username: env.CFOR_USERNAME || config.username, password: adminPassword, captchaVerification: ''
      }, { encrypted: true }), '管理员只读账号盘点登录')
      check(caseRecord, '管理员盘点令牌有效', nonEmpty(auth.data?.accessToken))
      admin = requestClient({
        prefix: '/admin-api', tenantId, record, fetchImpl, token: auth.data.accessToken
      })
      const accountPath = '/erp/supplier-portal/account/page?pageNo=1&pageSize=100' +
        (credentials ? `&loginName=${encodeURIComponent(credentials.loginName)}` : '')
      const accounts = supplierPageRows(
        success(caseRecord, await admin('GET', accountPath), '供应商账号分页'), '供应商账号分页')
      caseRecord.evidence.push(`当前租户供应商门户账号分页rows=${accounts.length}；未创建/关联账号，空集不证明关联/状态核验`)
      if (accounts.length) check(caseRecord, '账号分页保留客商关联/启停状态且不暴露密码/邀请令牌',
        accounts.every(accountSafe), `accounts=${accounts.length}; 仅当前分页样本`)
      const settings = success(caseRecord,
        await admin('GET', '/erp/supplier-portal/account/settings'), '门户账号设置').data
      check(caseRecord, '门户设置保留访问地址与1-30天邀请有效期',
        settings && Object.hasOwn(settings, 'portalBaseUrl') &&
          Number.isInteger(settings.inviteExpireDays) &&
          settings.inviteExpireDays >= 1 && settings.inviteExpireDays <= 30)
      caseRecord.evidence.push(`门户只读设置inviteExpireDays=${settings.inviteExpireDays}；未修改访问地址或启停配置`)
      const account = credentials
        ? accounts.find((row) => row.loginName === credentials.loginName) : accounts[0]
      if (credentials && !account) return partial('显式供应商账号在当前租户查询不到；未创建或关联共享正式账号')
      if (account) {
        expectedAccount = account
        const detail = success(caseRecord, await admin('GET',
          `/erp/supplier-portal/account/get?id=${encodeURIComponent(account.id)}`), '账号详情').data
        check(caseRecord, '账号详情保持分页身份/客商关联/状态且无密码或邀请令牌',
          accountSafe(detail) && String(detail.id) === String(account.id) &&
            String(detail.basePartnerId) === String(account.basePartnerId) &&
            detail.loginName === account.loginName && detail.status === account.status,
          `accountId=${account.id}; basePartnerId=${account.basePartnerId}; status=${account.status}`)
        const partner = success(caseRecord, await admin('GET',
          `/base/partner/get?id=${encodeURIComponent(account.basePartnerId)}`), '关联统一客商').data
        if (partner !== null) check(caseRecord, '关联客商响应包含主体、状态和供应商角色',
          partner && hasId(partner.id) && ['ACTIVE', 'INACTIVE'].includes(partner.status) &&
            typeof partner.supplierEnabled === 'boolean')
        if (partner === null || partner.status !== 'ACTIVE' || partner.supplierEnabled !== true) {
          return partial('关联统一客商不是 ACTIVE/supplierEnabled=true，未修改主数据')
        }
        check(caseRecord, '账号关联现有统一客商而非另建供应商主体',
          String(partner.id) === String(account.basePartnerId) && partner.name === account.partnerName,
          `basePartnerId=${partner.id}; supplierEnabled=${partner.supplierEnabled}; status=${partner.status}`)
        if (credentials && account.status !== 'ENABLED') {
          return partial(`显式供应商账号状态=${account.status}；未启用/重置/邀请共享账号`)
        }
      } else missing.push('当前租户账号分页为空，关联账号/状态样本未核验')
      const rejection = await requestClient({
        prefix: '/supplier-api', tenantId, record, fetchImpl, token: auth.data.accessToken
      })('GET', '/erp/outsource-orders/page?pageNo=1&pageSize=100')
      check(caseRecord, '管理端令牌不能替代供应商令牌读取委外入口',
        supplierAuthRejected(rejection), `status=${rejection.status}; code=${rejection.body?.code}`)
    } else missing.push('缺管理员查询身份，账号关联/状态盘点未执行')

    if (!credentials) return partial('缺显式 CFOR_SUPPLIER_USERNAME/CFOR_SUPPLIER_PASSWORD；不继承admin密码，不猜测账号')
    const loginResult = page && portalAvailable
      ? (await browserSupplierLogin({
          page, credentials, tenantId, caseRecord,
          captureLogin: (result) => {
            captureLogin(result)
            supplierSessionOwned = Boolean(supplier)
          }
        })).result
      : await anonymous('POST', '/erp/auth/login', credentials, { encrypted: true })
    // Capture the newly issued token before validating other fields so cleanup still runs on failure.
    captureLogin(loginResult)
    const loginBlocker = supplierBlocker(loginResult)
    if (loginBlocker) return partial(loginBlocker)
    const session = supplierSession(success(caseRecord, loginResult, '独立供应商登录'), tenantId)
    check(caseRecord, '供应商响应保留当前租户、账号、统一客商与有效独立会话', true,
      `tenantId=${session.tenantId}; accountId=${session.userId}; basePartnerId=${session.basePartnerId}`)
    if (expectedAccount) check(caseRecord, '独立登录主体与管理员只读查询的显式供应商账号一致',
      session.userId === String(expectedAccount.id) &&
        session.basePartnerId === String(expectedAccount.basePartnerId) &&
        session.partnerName === expectedAccount.partnerName,
      `accountId=${expectedAccount.id}; basePartnerId=${expectedAccount.basePartnerId}`)
    supplier = requestClient({
      prefix: '/supplier-api', tenantId, record, fetchImpl, token: session.accessToken
    })
    const rejection = await requestClient({
      prefix: '/admin-api', tenantId, record, fetchImpl, token: session.accessToken
    })('GET', '/system/auth/get-permission-info')
    check(caseRecord, '供应商令牌不能读取管理端权限接口', supplierAuthRejected(rejection),
      `status=${rejection.status}; code=${rejection.body?.code}`)
    const summary = success(caseRecord, await supplier('GET', '/erp/workbench/summary'), '供应商工作台').data
    check(caseRecord, '工作台主体/名称与独立登录主体一致',
      String(summary?.basePartnerId) === session.basePartnerId && summary?.partnerName === session.partnerName)
    const ordersResult = await supplier('GET', '/erp/outsource-orders/page?pageNo=1&pageSize=100')
    const mappingBlocker = supplierBlocker(ordersResult)
    if (mappingBlocker) return partial(mappingBlocker)
    const rows = supplierPageRows(success(caseRecord, ordersResult, '供应商委外分页'), '供应商委外分页')
    inspectOrders(caseRecord, rows, env.CFOR_SUPPLIER_LEGACY_ID)
    caseRecord.evidence.push(
      `GET /supplier-api/erp/outsource-orders/page?pageNo=1&pageSize=100; rows=${rows.length}; 不传supplierId，由真实会话与唯一CONFIRMED ERP_SUPPLIER映射解析`
    )
    const order = rows.find((row) => activeStatuses.includes(row.outsourceStatus) &&
      nonEmpty(row.releaseTime) && Number(row.planQty) > 0)
    if (!order) return partial('缺已下达、未完成且有releaseTime/正计划量的正式委外来源；不自动下达订单')
    const detail = success(caseRecord, await supplier('GET',
      `/erp/outsource-orders/get?id=${encodeURIComponent(order.id)}`), '供应商委外详情').data
    check(caseRecord, '委外详情与分页保持同单、同供应商、正式状态和数量',
      detail && String(detail.id) === String(order.id) && detail.billNo === order.billNo &&
        String(detail.supplierId) === String(order.supplierId) &&
        [...activeStatuses, 'COMPLETED'].includes(detail.outsourceStatus) &&
        finiteNumber(detail.planQty) && Number(detail.planQty) === Number(order.planQty),
      `outsourceId=${order.id}; supplierId=${order.supplierId}; status=${detail?.outsourceStatus}`)
    inspectWarnings(caseRecord, detail.warnings, order, '详情预警')
    check(caseRecord, '详情开放预警计数来源于同次响应预警数组',
      finiteNumber(detail.openWarningCount) && Number(detail.openWarningCount) === detail.warnings.length)
    check(caseRecord, '详情反馈响应为数组', Array.isArray(detail.progressList))
    if (detail.progressList.length) check(caseRecord, '既有反馈归属当前委外单/供应商且异常记录保留必填信息',
      detail.progressList.every((row) =>
        hasId(row?.id) && String(row.outsourceId) === String(order.id) &&
        String(row.supplierId) === String(order.supplierId) &&
        ['START', 'PROGRESS', 'ESTIMATE', 'EXCEPTION'].includes(row.feedbackType) &&
        (row.feedbackType !== 'EXCEPTION' ||
          [row.exceptionReason, row.responsiblePerson, row.correctiveAction].every(nonEmpty))),
      `outsourceId=${order.id}; 仅读取历史反馈，不证明写侧必填门禁/幂等`)
    if (!detail.progressList.length) missing.push('没有既有反馈样本，异常信息回读未验证')
    const warnings = success(caseRecord, await supplier('GET',
      `/erp/outsource-orders/warnings?id=${encodeURIComponent(order.id)}`), '开放预警查询').data
    inspectWarnings(caseRecord, warnings, order, '独立预警查询')
    if (!warnings.length) missing.push('当前委外单无开放预警，未证明预警生成/通知到达')
    caseRecord.evidence.push(
      `现有正式委外outsourceId=${order.id}; status=${detail.outsourceStatus}; openWarnings=${warnings.length}；只读详情/预警，不是进度写侧证据`
    )
    if (page && portalAvailable) {
      const pageResultPromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/supplier-api/erp/outsource-orders/page' &&
        response.request().method() === 'GET')
        .then((response) => ({ response }), (error) => ({ error }))
      await page.goto(`${config.webBase}/supplier/outsource-orders`, {
        waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs
      })
      const received = await pageResultPromise
      if (received.error) throw received.error
      const pageResponse = received.response
      const pageHeaders = await pageResponse.request().allHeaders()
      check(caseRecord, '委外页面GET携带独立供应商令牌/当前租户且不传供应商参数',
        pageHeaders.authorization === `Bearer ${session.accessToken}` &&
          pageHeaders['tenant-id'] === String(tenantId) &&
          !new URL(pageResponse.url()).searchParams.has('supplierId'))
      const pageBody = await decode({
        text: () => pageResponse.text(), headers: new Headers(await pageResponse.allHeaders())
      })
      supplierPageRows(success(caseRecord, {
        status: pageResponse.status(), body: pageBody
      }, '真实页面委外列表请求'), '真实页面委外列表')
      await page.locator('#supplier-app .supplier-outsource input[placeholder="请输入委外单号"]').waitFor()
      await page.locator('.supplier-outsource .el-table__row').first().waitFor()
      const text = await page.locator('.supplier-outsource .el-table').innerText()
      check(caseRecord, '真实委外路由渲染计划/完工、进度与预警列',
        new URL(page.url()).pathname === '/supplier/outsource-orders' &&
          ['计划/完工', '进度', '预警', '委外单号'].every((label) => text.includes(label)))
      await saveScreenshot(page, outputDir, 'supplier-outsource-readonly', record)
    }
    return partial('仅完成独立鉴权、关联主体和现有正式委外只读核验')
  } finally {
    // Logout only sessions created here; never touch the runner's administrator session.
    try {
      if (supplier) {
        success(caseRecord, await supplier('POST', '/erp/auth/logout'), '本次供应商会话退出')
        const rejected = await supplier('GET', '/erp/outsource-orders/page?pageNo=1&pageSize=100')
        check(caseRecord, '退出后本次供应商访问令牌失效', supplierAuthRejected(rejected),
          `status=${rejected.status}; code=${rejected.body?.code}`)
      }
    } finally {
      try {
        if (page && supplierSessionOwned && supplierToken) await page.evaluate(({ key, token }) => {
          const session = JSON.parse(window.localStorage.getItem(key) || 'null')
          if (session?.accessToken === token) window.localStorage.removeItem(key)
        }, { key: supplierSessionKey, token: supplierToken })
      } finally {
        if (admin) success(caseRecord, await admin('POST', '/system/auth/logout'), '本次管理员盘点会话退出')
      }
    }
  }
}
