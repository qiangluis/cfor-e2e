import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { config } from '../config/index.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { decryptResponse, encryptRequest, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { assertLocalDatabase, runLocalFixtureSql, runReadOnlySql } from '../lib/db.mjs'

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

const sqlString = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`

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
  async (method, pathname, body, { token = '', encrypted = false, tenantId = '1' } = {}) => {
    if (!stableId(tenantId) ||
        (String(tenantId) !== '1' &&
          (method !== 'POST' || pathname !== '/supplier-api/erp/auth/refresh-token' || token))) {
      throw new Error('PROC-010 alternate tenant is restricted to anonymous refresh rejection')
    }
    const response = await fetchImpl(`${settings.apiBase}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'tenant-id': String(tenantId),
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

export async function verifySupplierRefreshTenantIsolation ({
  request, sql, supplier, accountId, check, caseRecord
}) {
  if (!stableId(accountId) || !supplier?.refreshToken || !supplier?.accessToken ||
      String(supplier.userId) !== String(accountId) || String(supplier.tenantId) !== '1') {
    throw new Error('PROC-010 tenant refresh probe requires an owned supplier session')
  }
  const targets = await sql(`
    SELECT t.id FROM system_tenant t
    JOIN system_tenant_subsystem_activation s ON s.tenant_id=t.id
    WHERE t.deleted=0 AND t.status=0 AND t.expire_time>CURRENT_TIMESTAMP AND t.id<>1
      AND s.deleted=0 AND s.subsystem_code='erp.supplier-portal' AND s.status='ENABLED'
      AND (s.enabled_month IS NULL OR s.enabled_month=''
        OR s.enabled_month<=DATE_FORMAT(CURRENT_DATE, '%Y-%m'))
    ORDER BY t.id LIMIT 1
  `)
  const targetId = targets.available && targets.rows?.[0]?.[0]
  if (!stableId(targetId) || String(targetId) === '1') {
    caseRecord.notes.push('PROC-010 tenant refresh GAP: no active local alternate portal tenant; no activation changed')
    return false
  }
  const snapshot = async () => {
    const facts = await sql(`
      SELECT 'access',id,user_id,user_type,tenant_id,SHA2(access_token,256),
        SHA2(refresh_token,256),expires_time FROM system_oauth2_access_token
      WHERE tenant_id=1 AND user_id=${accountId} AND user_type=3 AND deleted=0
        AND refresh_token=${sqlString(supplier.refreshToken)}
      UNION ALL
      SELECT 'refresh',id,user_id,user_type,tenant_id,'',SHA2(refresh_token,256),expires_time
      FROM system_oauth2_refresh_token
      WHERE tenant_id=1 AND user_id=${accountId} AND user_type=3 AND deleted=0
        AND refresh_token=${sqlString(supplier.refreshToken)}
      ORDER BY 1,2
    `)
    if (!facts.available || facts.rows?.length !== 2 ||
        !['access', 'refresh'].every((kind) => facts.rows.filter((row) =>
          row[0] === kind && row[2] === String(accountId) &&
          row[3] === '3' && row[4] === '1').length === 1)) {
      throw new Error('PROC-010 tenant refresh probe lacks exact source token SQL evidence')
    }
    return facts
  }
  const before = await snapshot()
  const rejected = await request('POST', '/supplier-api/erp/auth/refresh-token', {
    refreshToken: supplier.refreshToken
  }, { tenantId: String(targetId) })
  check('tenant-id 不匹配 refresh 精确拒绝',
    supplierAuthRejected(rejected, [401]) &&
      (rejected.body?.msg || rejected.body?.message) === '刷新令牌租户不匹配',
    `sourceTenant=1; targetTenant=${targetId}; HTTP=${rejected.status}; code=${rejected.body?.code}`)
  const after = await snapshot()
  check('跨租户 refresh 拒绝前后原 access/refresh 完整事实不变',
    JSON.stringify(before.rows) === JSON.stringify(after.rows), `accountId=${accountId}`)
  const original = await request('GET', '/supplier-api/erp/workbench/summary',
    undefined, { token: supplier.accessToken })
  const sessionStillValid = original.status === 200 && isBusinessSuccess(original.body) &&
    String(original.body?.data?.basePartnerId) === String(supplier.basePartnerId)
  caseRecord.checks.push({
    name: '跨租户 refresh 拒绝后原 supplier 会话仍有效',
    passed: sessionStillValid,
    details: `HTTP=${original.status}; code=${original.body?.code ?? 'invalid'}`
  })
  caseRecord.database = [...(caseRecord.database || []),
    { stage: 'supplier-tenant-refresh-before', ...before },
    { stage: 'supplier-tenant-refresh-after', ...after }]
  return sessionStillValid
}

const digest = (value) => createHash('sha256').update(value).digest('hex')

export async function verifyMemberSupplierRefresh ({
  request, sql, check, caseRecord, settings = config,
  credentials = {
    userId: process.env.CFOR_E2E_PROC010_MEMBER_USER_ID,
    mobile: process.env.CFOR_E2E_PROC010_MEMBER_MOBILE,
    password: process.env.CFOR_E2E_PROC010_MEMBER_PASSWORD
  }
}) {
  assertSupplierAuthLocal(settings)
  if (!credentials || !stableId(credentials.userId) ||
      !/^1\d{10}$/.test(credentials.mobile || '') ||
      typeof credentials.password !== 'string' ||
      credentials.password.length < 4 || credentials.password.length > 16) {
    caseRecord.notes.push('PROC-010 Member refresh GAP: 缺少专属 Member 账号的真实登录凭据；不注册、不发短信、不伪造 token')
    return false
  }
  let member
  try {
    const owned = await sql(`SELECT id,tenant_id,status FROM member_user
      WHERE id=${credentials.userId} AND tenant_id=1 AND deleted=0 AND status=0
        AND nickname='E2E-PROC010-MEMBER' AND mobile=${sqlString(credentials.mobile)}`)
    if (!owned.available || owned.rows?.length !== 1 ||
        owned.rows[0].join('|') !== `${credentials.userId}|1|0`) {
      caseRecord.notes.push('PROC-010 Member refresh GAP: 未证实 tenant1 专属 E2E-PROC010-MEMBER 账号；不操作共享会员')
      return false
    }
    member = success(await request('POST', '/app-api/member/auth/login', {
      mobile: credentials.mobile, password: credentials.password
    }), 'Member login')
    check('Member API 登录取得真实专属会话',
      String(member?.userId) === String(credentials.userId) &&
      typeof member?.accessToken === 'string' && member.accessToken.length > 0 &&
      typeof member?.refreshToken === 'string' && member.refreshToken.length > 0 &&
      Date.parse(member.expiresTime) > Date.now())
    const snapshot = async () => {
      const facts = await sql(`
        SELECT 'access',id,user_id,user_type,tenant_id,SHA2(access_token,256),
          SHA2(refresh_token,256),expires_time FROM system_oauth2_access_token
        WHERE user_id=${credentials.userId} AND user_type=1 AND tenant_id=1 AND deleted=0
          AND SHA2(refresh_token,256)=${sqlString(digest(member.refreshToken))}
          AND expires_time>CURRENT_TIMESTAMP
        UNION ALL
        SELECT 'refresh',id,user_id,user_type,tenant_id,'',SHA2(refresh_token,256),expires_time
        FROM system_oauth2_refresh_token
        WHERE user_id=${credentials.userId} AND user_type=1 AND tenant_id=1 AND deleted=0
          AND SHA2(refresh_token,256)=${sqlString(digest(member.refreshToken))}
          AND expires_time>CURRENT_TIMESTAMP ORDER BY 1,2
      `)
      check('DB 证实真实 Member access/refresh userType=MEMBER(1)/tenant1' +
        (snapshots++ ? '（拒绝后）' : ''),
      facts.available && facts.rows?.length === 2 &&
        ['access', 'refresh'].every((kind) => facts.rows.filter((row) =>
          row[0] === kind && row[2] === String(credentials.userId) &&
          row[3] === '1' && row[4] === '1' &&
          row[6] === digest(member.refreshToken) &&
          row[5] === (kind === 'access' ? digest(member.accessToken) : '')).length === 1))
      return { available: true, rows: facts.rows }
    }
    let snapshots = 0
    const before = await snapshot()
    const rejected = await request('POST', '/supplier-api/erp/auth/refresh-token', {
      refreshToken: member.refreshToken
    })
    check('Member refresh 不可通过 supplier refresh 精确拒绝',
      supplierAuthRejected(rejected, [401]) &&
        (rejected.body?.msg || rejected.body?.message) === '刷新令牌用户类型不匹配',
      `HTTP=${rejected.status}; code=${rejected.body?.code ?? 'invalid'}`)
    const after = await snapshot()
    check('Member 跨端 refresh 拒绝前后原 access/refresh 完整事实不变',
      JSON.stringify(before.rows) === JSON.stringify(after.rows))
    caseRecord.database = [...(caseRecord.database || []),
      { stage: 'member-supplier-refresh-before', ...before },
      { stage: 'member-supplier-refresh-after', ...after }]
    const original = await request('GET', '/app-api/member/user/get',
      undefined, { token: member.accessToken })
    check('跨端 refresh 拒绝后原 Member 会话仍有效',
      original.status === 200 && isBusinessSuccess(original.body) &&
        String(original.body?.data?.id) === String(credentials.userId))
    return true
  } catch {
    throw new Error('PROC-010 Member refresh verification failed; authentication details withheld')
  } finally {
    if (member?.accessToken) {
      try {
        const loggedOut = await request('POST', '/app-api/member/auth/logout',
          undefined, { token: member.accessToken })
        check('专属 Member 会话退出',
          loggedOut.status === 200 && isBusinessSuccess(loggedOut.body))
      } catch {
        throw new Error('PROC-010 Member session cleanup failed; authentication details withheld')
      }
    }
  }
}

export async function browserAcceptSupplierInvite ({
  page, inviteUrl, loginName, password, check, record, outputDir, settings = config
}) {
  assertSupplierAuthLocal(settings)
  const context = await page.context().browser().newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
  })
  try {
    const url = new URL(inviteUrl)
    if (url.origin !== new URL(settings.webBase).origin ||
        url.pathname !== '/supplier/accept-invite' || url.searchParams.get('tenantId') !== '1' ||
        url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some((key) => !['token', 'tenantId'].includes(key)) ||
        url.searchParams.getAll('token').length !== 1 ||
        url.searchParams.getAll('tenantId').length !== 1 ||
        !/^[a-f0-9]{32}$/.test(url.searchParams.get('token') || '')) {
      throw new Error('Invalid local invite URL')
    }
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        ['9151', '48083'].includes(url.port) ? route.continue() : route.abort()
    })
    const isolated = await context.newPage()
    isolated.setDefaultTimeout(settings.browserTimeoutMs || config.browserTimeoutMs)
    await isolated.goto(inviteUrl, { waitUntil: 'domcontentloaded' })
    if (await isolated.locator('#supplier-app').count() !== 1) return false
    const passwords = isolated.locator('.supplier-login input[autocomplete="new-password"]')
    await passwords.nth(0).fill(password)
    await passwords.nth(1).fill(password)
    const pending = isolated.waitForResponse((response) =>
      new URL(response.url()).pathname === '/supplier-api/erp/auth/accept-invite' &&
      response.request().method() === 'POST')
    await isolated.locator('.supplier-login__submit').click()
    const response = await pending
    const headers = await response.allHeaders()
    const text = await response.text()
    const result = {
      status: response.status(),
      body: headers[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
    }
    record.api.push({
      method: 'POST', pathname: '/supplier-api/erp/auth/accept-invite',
      status: result.status, code: result.body?.code
    })
    const sent = await response.request().allHeaders()
    check('headed 邀请激活使用加密请求与 tenant1',
      sent[ENCRYPT_HEADER.toLowerCase()] === 'true' && sent['tenant-id'] === '1' &&
        !sent.authorization)
    check('headed 邀请激活成功返回本轮登录名', success(result, 'accept invite') === loginName)
    await isolated.waitForURL((url) => url.pathname === '/supplier/login' &&
      url.searchParams.get('tenantId') === '1' && url.searchParams.get('loginName') === loginName)
    check('headed 邀请激活跳转登录页并预填登录名',
      await isolated.locator('.supplier-login input[autocomplete="username"]').inputValue() === loginName)
    if (outputDir) {
      const filename = path.join(outputDir, 'supplier-auth-invite-login.png')
      await isolated.screenshot({ path: filename, fullPage: true })
      record.screenshots.push(filename)
    }
    return true
  } catch {
    // Navigation URLs and Playwright fill diagnostics can contain the invite token.
    throw new Error('PROC-010 invite activation failed; authentication details withheld')
  } finally {
    await context.close()
  }
}

export async function verifySupplierInviteActivation ({
  page, sql, check, caseRecord, record, outputDir, tag, partnerId, settings = config,
  activate = browserAcceptSupplierInvite, adminCall
}) {
  assertSupplierAuthLocal(settings)
  if (!page || !stableId(partnerId) || !/^[A-Za-z0-9_]+$/.test(tag || '')) {
    caseRecord.notes.push('PROC-010 invitation GAP: 缺少 headed 页面或本轮专属邀请范围；不发送外部邮件')
    return false
  }
  const loginName = `e2e_proc010_invite_${tag.toLowerCase()}`
  // Only consume an invitation already issued by the product for this run.
  // Never invoke inviteAccount: its cached mail configuration can send externally.
  let accountId
  let activationAttempted = false
  try {
    const found = await sql(`
      SELECT a.id,l.id,JSON_UNQUOTE(JSON_EXTRACT(l.template_params,'$.inviteUrl'))
      FROM supplier_portal_account a
      JOIN base_partner p ON p.id=a.base_partner_id AND p.tenant_id=a.tenant_id AND p.deleted=0
      JOIN system_mail_log l ON l.deleted=0 AND l.template_code='supplier_portal_account_invite'
        AND JSON_UNQUOTE(JSON_EXTRACT(l.template_params,'$.loginName'))=a.login_name
        AND l.to_mail=a.contact_email AND l.send_status=30 AND l.create_time>=a.create_time
      WHERE a.tenant_id=1 AND a.deleted=0 AND a.base_partner_id=${partnerId}
        AND p.name=${sqlString(`E2E-PROC010-SUPPLIER-${tag}`)}
        AND p.remark=${sqlString(`PROC-010 isolated auth fixture ${tag}`)}
        AND a.login_name=${sqlString(loginName)} AND a.status='INVITED'
        AND a.invite_expire_at>CURRENT_TIMESTAMP
    `)
    if (!found.available || found.rows?.length !== 1) {
      caseRecord.notes.push('PROC-010 invitation GAP: 无本轮专属 INVITED 账号及 send_status=30 未发送日志中的真实 token；inviteAccount 必调 MailSendApi，且模板/账号走缓存；不修改邮件配置、不发送外部邮件、不以哈希冒充 token')
      return false
    }
    const row = found.rows[0]
    const url = new URL(row[2])
    const token = url.searchParams.get('token')
    const base = new URL(settings.webBase)
    if (!stableId(row[0]) || !stableId(row[1]) || url.origin !== base.origin ||
        url.pathname !== '/supplier/accept-invite' || url.searchParams.get('tenantId') !== '1' ||
        url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some((key) => !['token', 'tenantId'].includes(key)) ||
        url.searchParams.getAll('token').length !== 1 ||
        url.searchParams.getAll('tenantId').length !== 1 || !/^[a-f0-9]{32}$/.test(token || '')) {
      throw new Error('Invalid owned invite source')
    }
    accountId = String(row[0])
    const matching = await sql(`SELECT id FROM supplier_portal_account
      WHERE id=${accountId} AND base_partner_id=${partnerId} AND tenant_id=1 AND deleted=0
        AND login_name=${sqlString(loginName)} AND status='INVITED'
        AND invite_expire_at>CURRENT_TIMESTAMP AND invite_token=${sqlString(digest(token))}`)
    check('邀请 token 来自本轮专属未发送日志且匹配有效邀请哈希',
      matching.available && matching.rows?.length === 1 && matching.rows[0][0] === accountId)
    caseRecord.evidence.push(`inviteAccountId=${accountId}; ignoredMailLogId=${row[1]}; tag=${tag}`)
    if (!adminCall) throw new Error('Owned invitation cleanup unavailable')
    activationAttempted = true
    const activated = await activate({
      page, inviteUrl: url.href, loginName, password: `P10-${randomBytes(12).toString('base64url')}`,
      check, record, outputDir, settings
    })
    if (!activated) {
      caseRecord.notes.push('PROC-010 invitation UI GAP: supplier-app 未挂载，不以 API 结果冒充跳转和预填证据')
      return false
    }
    const consumed = await sql(`SELECT id,status,(invite_token='') FROM supplier_portal_account
      WHERE id=${accountId} AND base_partner_id=${partnerId} AND tenant_id=1 AND deleted=0
        AND login_name=${sqlString(loginName)}`)
    check('邀请激活后正式 API 消耗 token 且账号启用',
      consumed.available && consumed.rows?.length === 1 &&
        consumed.rows[0].join('|') === `${accountId}|ENABLED|1`)
    return true
  } catch {
    throw new Error('PROC-010 owned invite verification failed; authentication details withheld')
  } finally {
    if (activationAttempted) {
      try {
        const endpoint = `/erp/supplier-portal/account/get?id=${accountId}`
        const owned = await adminCall('GET', endpoint)
        if (String(owned?.id) !== accountId || String(owned?.basePartnerId) !== String(partnerId) ||
            owned?.loginName !== loginName) throw new Error('Owned invite cleanup refused')
        await adminCall('PUT', `/erp/supplier-portal/account/status?id=${accountId}&status=DISABLED`)
        check('本轮邀请账号清理为 DISABLED', (await adminCall('GET', endpoint)).status === 'DISABLED')
      } catch {
        throw new Error('PROC-010 owned invite cleanup failed; authentication details withheld')
      }
    }
  }
}

const workbenchPaths = [
  '/supplier-api/erp/workbench/summary',
  '/supplier-api/erp/notify/unread-count',
  '/supplier-api/erp/notify/unread-list'
]

export const observeSupplierWorkbench = (page) => Promise.all(workbenchPaths.map(async (pathname) => {
  try {
    const response = await page.waitForResponse((value) =>
      new URL(value.url()).pathname === pathname && value.request().method() === 'GET')
    const headers = await response.allHeaders()
    const text = await response.text()
    return {
      pathname,
      status: response.status(),
      body: headers[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
    }
  } catch {
    return { pathname, status: 0, body: null }
  }
}))

export const verifySupplierWorkbench = async ({ page, responses, partnerId, check, record }) => {
  for (const pathname of workbenchPaths) {
    const response = responses.find((value) => value.pathname === pathname)
    record.api.push({
      method: 'GET', pathname, status: response?.status ?? 0, code: response?.body?.code
    })
    check(`headed 工作台接口成功 ${pathname}`,
      response?.status === 200 && isBusinessSuccess(response?.body),
      `HTTP=${response?.status ?? 0}; code=${response?.body?.code ?? 'invalid'}`)
    success(response, 'headed supplier workbench')
  }
  const summary = responses[0].body.data
  const unreadCount = responses[1].body.data
  const messages = responses[2].body.data
  check('headed 工作台数据归属和消息结构正确',
    String(summary?.basePartnerId) === String(partnerId) &&
    Number.isInteger(Number(unreadCount)) && Number(unreadCount) >= 0 &&
    Array.isArray(messages))
  await page.locator('.supplier-workbench__summary-grid').first().waitFor({ state: 'visible' })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.supplier-workbench .el-loading-mask')].every((element) =>
      !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden'))
  const amount = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  })}`
  const expected = [
    amount(summary.totalTransactionAmount),
    amount(summary.receivableBalance),
    amount(summary.pendingCollectionAmount),
    `${summary.auditedOrderCount || 0} 笔`,
    `${summary.pendingOrderCount || 0} 笔`,
    `${summary.pendingShipmentCount || 0} 笔`,
    `${summary.pendingInvoiceCount || 0} 行`,
    `${summary.dueSoonOrderCount || 0} 笔`,
    `${summary.overdueOrderCount || 0} 笔`
  ]
  check('headed 工作台加载结束且九项统计与真实接口一致',
    JSON.stringify(await page.locator('.supplier-workbench__summary-item strong').allTextContents()) ===
      JSON.stringify(expected))
  const displayedMessages = await page.locator('.supplier-workbench__message-main p').allTextContents()
  check('headed 工作台消息与真实接口一致',
    JSON.stringify(displayedMessages) ===
      JSON.stringify(messages.map((message) => message.templateContent || '暂无消息内容')))
  if (messages.length === 0) {
    await page.getByText('当前暂无未读消息', { exact: true }).waitFor({ state: 'visible' })
  }
}

export const browserLogin = async ({ page, payload, capture, check, record, outputDir }) => {
  // Use a fresh context so the headed auth flow cannot overwrite the admin session.
  const context = await page.context().browser().newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
  })
  let isolated
  let phase = 'local-network-guard'
  let outcome
  try {
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        ['9151', '48083'].includes(url.port)
      return local ? route.continue() : route.abort()
    })
    phase = 'open-login-page'
    isolated = await context.newPage()
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
    phase = 'read-admin-storage'
    const before = await adminStorage()
    phase = 'fill-login-form'
    await isolated.locator('.supplier-login input[autocomplete="username"]').fill(payload.loginName)
    await isolated.locator('.supplier-login input[autocomplete="current-password"]').fill(payload.password)
    phase = 'submit-login'
    const responsePromise = isolated.waitForResponse((response) =>
      new URL(response.url()).pathname === '/supplier-api/erp/auth/login' &&
      response.request().method() === 'POST')
    const workbenchResponses = observeSupplierWorkbench(isolated)
    await isolated.locator('.supplier-login__submit').click()
    const response = await responsePromise
    const headers = await response.allHeaders()
    const text = await response.text()
    const result = {
      status: response.status(),
      body: headers[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
    }
    outcome = { status: result.status, code: result.body?.code ?? 'invalid' }
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
    phase = 'workbench-navigation'
    await isolated.waitForURL('**/supplier/workbench')
    phase = 'session-isolation'
    const stored = await isolated.evaluate((key) =>
      JSON.parse(localStorage.getItem(key) || 'null'), sessionKey)
    check('headed supplier 独立存储且未覆盖管理端令牌',
      stored?.accessToken === result.body.data.accessToken &&
      stored?.refreshToken === result.body.data.refreshToken &&
      JSON.stringify(before) === JSON.stringify(await adminStorage()))
    phase = 'workbench-render'
    await verifySupplierWorkbench({
      page: isolated,
      responses: await workbenchResponses,
      partnerId: result.body.data.basePartnerId,
      check,
      record
    })
    if (outputDir) {
      const filename = path.join(outputDir, 'supplier-auth-workbench.png')
      await isolated.screenshot({ path: filename, fullPage: true })
      record.screenshots.push(filename)
    }
    return result
  } catch (error) {
    const kind = error?.name === 'TimeoutError' ? 'timeout' : 'error'
    record.api.push({ method: 'UI', pathname: 'supplier-login', phase, kind, ...outcome })
    if (isolated && outputDir) {
      const filename = path.join(outputDir, 'supplier-auth-login-failure.png')
      try {
        await isolated.screenshot({ path: filename, fullPage: true })
        record.screenshots.push(filename)
      } catch {}
    }
    // Playwright call logs can contain fill values; never persist those errors.
    throw new Error(`PROC-010 headed supplier login failed at ${phase} (${kind}); authentication details withheld`)
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
  const writeSql = dependencies.writeSql || runLocalFixtureSql
  const tag = dependencies.tag ||
    `${Date.now().toString(36).toUpperCase()}_${randomBytes(3).toString('hex')}`
  const payload = supplierAuthFixturePayload(tag)
  const fixture = {
    kind: 'supplier-auth',
    tag,
    status: 'creating',
    retained: true,
    reason: '本地专属直接密码账号；邀请仅消费本轮真实未发送日志，不发邮件；无映射写侧或 delete API，保留 DISABLED 审计事实'
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

    await verifySupplierRefreshTenantIsolation({
      request, sql, supplier: first, accountId: fixture.accountId, check, caseRecord
    })
    fixture.invitation = await verifySupplierInviteActivation({
      page, sql, check, caseRecord, record, outputDir, tag, partnerId: fixture.partnerId,
      settings, adminCall
    }) ? 'VERIFIED' : 'GAP'
    fixture.memberRefresh = await verifyMemberSupplierRefresh({
      request, sql, check, caseRecord, settings,
      ...(Object.hasOwn(dependencies, 'memberCredentials')
        ? { credentials: dependencies.memberCredentials } : {})
    }) ? 'VERIFIED' : 'GAP'
    const renewedResult = await request('POST', '/supplier-api/erp/auth/refresh-token', {
      refreshToken: first.refreshToken
    })
    capture(renewedResult)
    const renewed = session(renewedResult)
    check('supplier refresh 正常轮换 access', renewed.accessToken !== first.accessToken)
    reject('refresh 后旧 access 失效', await request(
      'GET', '/supplier-api/erp/workbench/summary', undefined, { token: first.accessToken }), [401])

    const expiring = session(await loginSupplier())
    const expiredAt = '2000-01-01 00:00:00'
    await writeSql(`
      UPDATE system_oauth2_refresh_token
      SET expires_time = ${sqlString(expiredAt)}
      WHERE tenant_id = 1
        AND user_id = ${fixture.accountId}
        AND user_type = 3
        AND refresh_token = ${sqlString(expiring.refreshToken)}
        AND deleted = 0
    `)
    const expiredFacts = await sql(`
      SELECT COUNT(*), MAX(expires_time)
      FROM system_oauth2_refresh_token
      WHERE tenant_id = 1
        AND user_id = ${fixture.accountId}
        AND user_type = 3
        AND refresh_token = ${sqlString(expiring.refreshToken)}
        AND deleted = 0
    `)
    check('供应商专属 refresh 过期注入仅命中本轮 token',
      expiredFacts.available &&
      expiredFacts.rows.length === 1 &&
      expiredFacts.rows[0][0] === '1' &&
      expiredFacts.rows[0][1] === expiredAt,
      `accountId=${fixture.accountId}; rows=${JSON.stringify(expiredFacts.rows)}`)
    const expiredRefresh = await request('POST', '/supplier-api/erp/auth/refresh-token', {
      refreshToken: expiring.refreshToken
    })
    reject('自然过期 refresh 拒绝', expiredRefresh, [401])
    const expiredAccess = await request(
      'GET', '/supplier-api/erp/workbench/summary', undefined, { token: expiring.accessToken })
    reject('自然过期 refresh 同时撤销旧 access', expiredAccess, [401])
    const expiredAfter = await sql(`
      SELECT COUNT(*)
      FROM system_oauth2_refresh_token
      WHERE tenant_id = 1
        AND user_id = ${fixture.accountId}
        AND user_type = 3
        AND refresh_token = ${sqlString(expiring.refreshToken)}
        AND deleted = 0
    `)
    check('自然过期 refresh 被正式 API 清理',
      expiredAfter.available &&
      expiredAfter.rows.length === 1 &&
      expiredAfter.rows[0][0] === '0',
      `accountId=${fixture.accountId}; rows=${JSON.stringify(expiredAfter.rows)}`)

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
  const note = `PROC-010 专属直接密码 AUTH API 已验证；${fixture.headedLogin === 'GAP' ? 'headed登录入口 GAP；' : ''}refresh 到期拒绝及关联令牌撤销已验证（仅调整本轮专属 refresh 有效期）；邀请激活=${fixture.invitation}（不发送邮件）；Member refresh=${fixture.memberRefresh}；PB150映射写侧未执行`
  caseRecord.notes.push(note)
  return { partial: true, note }
}
