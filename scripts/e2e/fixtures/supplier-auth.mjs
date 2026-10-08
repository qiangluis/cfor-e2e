import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { config } from '../config/index.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { decryptResponse, encryptRequest, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { assertLocalDatabase, runReadOnlySql } from '../lib/db.mjs'

const sessionKey = 'CFOR_SUPPLIER_PORTAL_SESSION'
const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? '')) &&
  (typeof value !== 'number' || Number.isSafeInteger(value))

const success = (result, label) => {
  if (!(result.status >= 200 && result.status < 300) || !isBusinessSuccess(result.body)) {
    throw new Error(`${label}: HTTP=${result.status}; code=${result.body?.code ?? 'invalid'}`)
  }
  return result.body.data
}

export function assertSupplierAuthLocal (settings = config) {
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.pathname !== '/') {
      throw new Error('BLOCKED: PROC-010 仅允许本地48083/9151')
    }
  }
  if (settings.target !== 'local' || String(settings.tenantId) !== '1') {
    throw new Error('BLOCKED: PROC-010 仅允许 local tenant1')
  }
  assertLocalDatabase(settings.db)
}

export const supplierAuthRejected = (result, codes) =>
  [200, 400, 401, 403].includes(result.status) &&
  !isBusinessSuccess(result.body) && codes.includes(result.body?.code)

export const supplierAuthFixturePayload = (tag) => ({
  partner: {
    name: `E2E-PROC010-SUPPLIER-${tag}`,
    shortName: 'E2E-PROC010',
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled: true,
    supplierEnabled: true,
    carrierEnabled: false,
    remark: `PROC-010 isolated auth fixture ${tag}`
  },
  account: {
    loginName: `e2e_proc010_${tag.toLowerCase()}`,
    password: `P10-${randomBytes(12).toString('base64url')}-x9`,
    contactName: 'PROC-010 local test',
    contactEmail: '',
    status: 'ENABLED'
  }
})

export const createSupplierAuthRequest = ({ record, fetchImpl = fetch, settings = config }) =>
  async (method, pathname, body, { token = '', encrypted = false } = {}) => {
    const response = await fetchImpl(`${settings.apiBase}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'tenant-id': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(encrypted ? { [ENCRYPT_HEADER]: 'true' } : {})
      },
      body: body === undefined ? undefined : encrypted ? encryptRequest(body) : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(settings.requestTimeoutMs)
    })
    const text = await response.text()
    let payload
    if (response.headers.get(ENCRYPT_HEADER.toLowerCase()) === 'true') payload = decryptResponse(text)
    else {
      try { payload = JSON.parse(text) } catch { payload = null }
    }
    // Persist only endpoint and outcome, never authentication headers or bodies.
    record?.api?.push({ method, pathname, status: response.status, code: payload?.code })
    return { status: response.status, body: payload }
  }

const browserLogin = async ({ page, payload, capture, check, record, outputDir }) => {
  // Use a fresh context so the headed auth flow cannot overwrite the admin session.
  const context = await page.context().browser().newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
  })
  try {
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        ['9151', '48083'].includes(url.port)
      return local ? route.continue() : route.abort()
    })
    const isolated = await context.newPage()
    isolated.setDefaultTimeout(config.browserTimeoutMs)
    await isolated.goto(`${config.webBase}/supplier/login?tenantId=1`, {
      waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs
    })
    if (await isolated.locator('#supplier-app').count() !== 1) {
      if (outputDir) {
        const filename = path.join(outputDir, 'supplier-auth-entry-gap.png')
        await isolated.screenshot({ path: filename, fullPage: true })
        record.screenshots.push(filename)
      }
      return null
    }
    const adminStorage = () => isolated.evaluate(() =>
      ['localStorage', 'sessionStorage'].map((storage) =>
        ['ACCESS_TOKEN', 'REFRESH_TOKEN'].map((key) => window[storage].getItem(key))))
    const before = await adminStorage()
    await isolated.locator('.supplier-login input[autocomplete="username"]').fill(payload.loginName)
    await isolated.locator('.supplier-login input[autocomplete="current-password"]').fill(payload.password)
    const responsePromise = isolated.waitForResponse((response) =>
      new URL(response.url()).pathname === '/supplier-api/erp/auth/login' &&
      response.request().method() === 'POST')
    await isolated.locator('.supplier-login__submit').click()
    const response = await responsePromise
    const headers = await response.allHeaders()
    const text = await response.text()
    const result = {
      status: response.status(),
      body: headers[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
    }
    capture(result)
    record.api.push({
      method: 'POST', pathname: '/supplier-api/erp/auth/login',
      status: result.status, code: result.body?.code
    })
    const requestHeaders = await response.request().allHeaders()
    check('headed 供应商登录使用加密请求与 tenant1',
      requestHeaders[ENCRYPT_HEADER.toLowerCase()] === 'true' &&
      requestHeaders['tenant-id'] === '1' && !requestHeaders.authorization)
    success(result, 'headed supplier login')
    await isolated.waitForURL('**/supplier/workbench')
    const stored = await isolated.evaluate((key) =>
      JSON.parse(localStorage.getItem(key) || 'null'), sessionKey)
    check('headed supplier 独立存储且未覆盖管理端令牌',
      stored?.accessToken === result.body.data.accessToken &&
      stored?.refreshToken === result.body.data.refreshToken &&
      JSON.stringify(before) === JSON.stringify(await adminStorage()))
    await isolated.locator('.supplier-workbench__summary-grid').first().waitFor({ state: 'visible' })
    if (outputDir) {
      const filename = path.join(outputDir, 'supplier-auth-workbench.png')
      await isolated.screenshot({ path: filename, fullPage: true })
      record.screenshots.push(filename)
    }
    return result
  } catch {
    // Playwright call logs can contain fill values; never persist those errors.
    throw new Error('PROC-010 headed supplier login failed; authentication details withheld')
  } finally {
    await context.close()
  }
}

export async function runSupplierAuth (
  { page, caseRecord, record, outputDir },
  dependencies = {}
) {
  const settings = dependencies.settings || config
  assertSupplierAuthLocal(settings)
  const request = dependencies.request ||
    createSupplierAuthRequest({ record, settings, fetchImpl: dependencies.fetchImpl })
  const sql = dependencies.sql || runReadOnlySql
  const tag = dependencies.tag ||
    `${Date.now().toString(36).toUpperCase()}_${randomBytes(3).toString('hex')}`
  const payload = supplierAuthFixturePayload(tag)
  const fixture = {
    kind: 'supplier-auth',
    tag,
    status: 'creating',
    retained: true,
    reason: '仅本地专属直接密码账号；无邀请/邮件/映射写侧；无 delete API，保留 DISABLED 审计事实'
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  const check = (name, passed, details = '') => {
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
    if (!passed) throw new Error(`PROC-010 ${name}${details ? `: ${details}` : ''}`)
  }
  const reject = (name, result, codes) => check(name, supplierAuthRejected(result, codes),
    `HTTP=${result.status}; code=${result.body?.code ?? 'invalid'}; expected=${codes.join(',')}`)
  let admin
  let failure
  const sessions = []
  const adminCall = async (method, endpoint, body) => success(
    await request(method, `/admin-api${endpoint}`, body, { token: admin.accessToken }), endpoint)
  const partnerOwned = async () => {
    const value = await adminCall('GET', `/base/partner/get?id=${fixture.partnerId}`)
    if (String(value?.id) !== fixture.partnerId ||
        value?.name !== payload.partner.name ||
        value?.remark !== payload.partner.remark ||
        value?.customerEnabled !== true) {
      throw new Error('PROC-010 partner ownership mismatch; mutation refused')
    }
    return value
  }
  const accountOwned = async () => {
    await partnerOwned()
    const value = await adminCall(
      'GET', `/erp/supplier-portal/account/get?id=${fixture.accountId}`)
    if (String(value?.id) !== fixture.accountId ||
        String(value?.basePartnerId) !== fixture.partnerId ||
        value?.loginName !== payload.account.loginName ||
        value?.contactEmail) {
      throw new Error('PROC-010 account ownership mismatch; mutation refused')
    }
    return value
  }
  const accountStatus = async (status) => {
    await accountOwned()
    await adminCall(
      'PUT', `/erp/supplier-portal/account/status?id=${fixture.accountId}&status=${status}`)
    check(`专属账号状态回读 ${status}`, (await accountOwned()).status === status)
    fixture.accountStatus = status
  }
  const partnerStatus = async (changes) => {
    const owned = await partnerOwned()
    await adminCall('PUT', '/base/partner/update', {
      ...payload.partner,
      id: fixture.partnerId,
      partnerCode: owned.partnerCode,
      customerCode: owned.customerCode,
      supplierCode: owned.supplierCode,
      status: owned.status,
      supplierEnabled: owned.supplierEnabled,
      ...changes
    })
    const after = await partnerOwned()
    check('专属 partner 状态/角色回读',
      Object.entries(changes).every(([key, value]) => after[key] === value))
    fixture.partnerStatus = after.status
    fixture.supplierEnabled = after.supplierEnabled
  }
  const capture = (result) => {
    if (isBusinessSuccess(result.body) && result.body?.data?.accessToken) {
      sessions.push(result.body.data)
    }
  }
  const loginSupplier = async () => {
    const result = await request('POST', '/supplier-api/erp/auth/login', {
      loginName: payload.account.loginName,
      password: payload.account.password
    }, { encrypted: true })
    capture(result)
    return result
  }
  const session = (result) => {
    const data = success(result, 'supplier login/refresh')
    check('supplier 认证主体及有效令牌匹配',
      String(data.userId) === fixture.accountId &&
      String(data.basePartnerId) === fixture.partnerId &&
      String(data.tenantId) === '1' &&
      typeof data.accessToken === 'string' && data.accessToken.length > 0 &&
      typeof data.refreshToken === 'string' && data.refreshToken.length > 0 &&
      Number.isFinite(Date.parse(data.expiresTime)) &&
      Date.parse(data.expiresTime) > Date.now())
    return data
  }
  try {
    const gate = await sql(`SELECT COUNT(*) FROM system_tenant_subsystem_activation
      WHERE tenant_id = 1 AND subsystem_code = 'erp.supplier-portal'
      AND status = 'ENABLED' AND deleted = 0
      AND (enabled_month IS NULL OR enabled_month = ''
        OR enabled_month <= DATE_FORMAT(CURRENT_DATE, '%Y-%m'))`)
    if (!gate.available || gate.rows?.[0]?.[0] !== '1') {
      throw new Error('BLOCKED: supplier portal 未证实已启用；不修改共享策略')
    }
    admin = success(await request('POST', '/admin-api/system/auth/login-encrypted', {
      username: settings.username,
      password: settings.password,
      captchaVerification: ''
    }, { encrypted: true }), 'admin login')
    if (!admin?.accessToken || !admin?.refreshToken) throw new Error('admin session missing')

    const partnerId = await adminCall('POST', '/base/partner/create', payload.partner)
    fixture.partnerId = String(partnerId)
    check('专属 partner 创建 ID 无精度损失', stableId(partnerId), `partnerId=${fixture.partnerId}`)
    await partnerOwned()
    const accountId = await adminCall('POST', '/erp/supplier-portal/account/create', {
      ...payload.account,
      basePartnerId: fixture.partnerId
    })
    fixture.accountId = String(accountId)
    check('直接密码专属账号创建 ID 无精度损失', stableId(accountId), `accountId=${fixture.accountId}`)
    check('专属账号直接启用无联系邮箱', (await accountOwned()).status === 'ENABLED')
    caseRecord.evidence.push(`partnerId=${fixture.partnerId}; accountId=${fixture.accountId}; tag=${tag}`)

    let initial = page || dependencies.browserLogin
      ? await (dependencies.browserLogin || browserLogin)({
        page, payload: payload.account, capture, check, record, outputDir
      })
      : await loginSupplier()
    if (!initial) {
      caseRecord.notes.push(
        'headed GAP: 9151/supplier/login 未挂载 #supplier-app；当前提供管理端入口。仅继续真实 AUTH API，不冒充页面登录通过。')
      fixture.headedLogin = 'GAP'
      initial = await loginSupplier()
    } else if (page) fixture.headedLogin = 'verified'
    capture(initial)
    const first = session(initial)
    const tokenFacts = await sql(`SELECT user_id, user_type, tenant_id
      FROM system_oauth2_access_token WHERE user_id = ${fixture.accountId}
      AND user_type = 3 AND tenant_id = 1 AND deleted = 0`)
    check('DB 证实专属 token userType=SUPPLIER(3)/tenant1',
      tokenFacts.available && tokenFacts.rows.length > 0 &&
      tokenFacts.rows.every((row) => row.join('|') === `${fixture.accountId}|3|1`))
    caseRecord.database = [...(caseRecord.database || []), { stage: 'supplier-principal', ...tokenFacts }]
    const summaryResult = await request('GET', '/supplier-api/erp/workbench/summary',
      undefined, { token: first.accessToken })
    const summaryPassed = summaryResult.status === 200 && isBusinessSuccess(summaryResult.body) &&
      String(summaryResult.body.data?.basePartnerId) === fixture.partnerId
    caseRecord.checks.push({
      name: 'supplier token 可访问自身工作台',
      passed: summaryPassed,
      details: `HTTP=${summaryResult.status}; code=${summaryResult.body?.code ?? 'invalid'}`
    })
    if (!summaryPassed) {
      caseRecord.notes.push(
        'supplier 工作台真实失败，不替换/伪造正向业务证据；继续执行独立 AUTH 隔离和状态拒绝断言。')
    }
    reject('supplier token 不可访问 admin-api', await request(
      'GET', '/admin-api/system/auth/get-permission-info', undefined, { token: first.accessToken }), [401, 403])
    reject('admin token 不可访问 supplier 工作台', await request(
      'GET', '/supplier-api/erp/workbench/summary', undefined, { token: admin.accessToken }),
    [401, 403, 1030620010])
    reject('admin refresh 不可通过 supplier refresh', await request(
      'POST', '/supplier-api/erp/auth/refresh-token', { refreshToken: admin.refreshToken }), [401])
    await adminCall('GET', '/system/auth/get-permission-info')
    check('跨端 refresh 拒绝后原 admin 会话仍有效', true)

    const renewedResult = await request('POST', '/supplier-api/erp/auth/refresh-token', {
      refreshToken: first.refreshToken
    })
    capture(renewedResult)
    const renewed = session(renewedResult)
    check('supplier refresh 正常轮换 access', renewed.accessToken !== first.accessToken)
    reject('refresh 后旧 access 失效', await request(
      'GET', '/supplier-api/erp/workbench/summary', undefined, { token: first.accessToken }), [401])
    success(await request('POST', '/supplier-api/erp/auth/logout',
      undefined, { token: renewed.accessToken }), 'supplier logout')
    reject('logout 后 access 失效', await request(
      'GET', '/supplier-api/erp/workbench/summary', undefined, { token: renewed.accessToken }), [401])
    reject('logout 后 refresh 失效', await request(
      'POST', '/supplier-api/erp/auth/refresh-token',
      { refreshToken: renewed.refreshToken }), [400])

    for (const [label, change, code] of [
      ['账号停用', () => accountStatus('DISABLED'), 1030620008],
      ['partner停用', () => partnerStatus({ status: 'INACTIVE' }), 1030620009],
      ['供应商角色停用', () => partnerStatus({ supplierEnabled: false }), 1030620009]
    ]) {
      const active = session(await loginSupplier())
      await change()
      reject(`${label}后登录拒绝`, await loginSupplier(), [code])
      const deniedRefresh = await request('POST', '/supplier-api/erp/auth/refresh-token', {
        refreshToken: active.refreshToken
      })
      capture(deniedRefresh)
      reject(`${label}后refresh拒绝`, deniedRefresh, [code])
      if (label === '账号停用') await accountStatus('ENABLED')
      if (label === 'partner停用') await partnerStatus({ status: 'ACTIVE' })
    }
    fixture.status = 'verified'
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    const cleanup = async (name, action) => {
      try { await action() } catch {
        cleanupErrors.push(name)
        caseRecord.notes.push(
          `PROC-010 cleanup failed: ${name}; 专属ID见fixtures；未操作非本次数据`)
      }
    }
    for (const owned of new Map(sessions.map((value) => [value.accessToken, value])).values()) {
      await cleanup('owned supplier logout', async () => {
        const result = await request('POST', '/supplier-api/erp/auth/logout',
          undefined, { token: owned.accessToken })
        if (!isBusinessSuccess(result.body) && !supplierAuthRejected(result, [401])) {
          throw new Error('supplier logout cleanup rejected')
        }
      })
    }
    if (fixture.accountId && admin) {
      await cleanup('owned account DISABLED', () => accountStatus('DISABLED'))
    }
    if (fixture.partnerId && admin) {
      await cleanup('owned partner INACTIVE', () => partnerStatus({ status: 'INACTIVE' }))
    }
    if (admin) {
      await cleanup('owned admin logout', async () => {
        success(await request('POST', '/admin-api/system/auth/logout',
          undefined, { token: admin.accessToken }), 'admin logout')
      })
    }
    fixture.status = cleanupErrors.length
      ? 'cleanup-failed' : fixture.accountId ? 'DISABLED' : 'retained-incomplete'
    if (cleanupErrors.length) {
      caseRecord.checks.push({
        name: '专属夹具所有权清理',
        passed: false,
        details: cleanupErrors.join('; ')
      })
      failure ||= new Error(`PROC-010 cleanup failed: ${cleanupErrors.join('; ')}`)
    }
  }
  if (failure) throw failure
  const note = `PROC-010 专属直接密码 AUTH API 已验证；${fixture.headedLogin === 'GAP' ? 'headed登录入口 GAP；' : ''}自然过期 GAP，不修改共享 OAuth；邀请/邮件与 Member refresh 未验证；PB150映射写侧未执行`
  caseRecord.notes.push(note)
  return { partial: true, note }
}
