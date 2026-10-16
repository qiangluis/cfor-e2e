import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, resolveChromePath } from '../config/index.mjs'
import { ensureDir } from './report.mjs'
import { decryptResponse, ENCRYPT_HEADER } from './crypto.mjs'
import { extractAccessToken, resolveLoginContext } from './session.mjs'
import { assertBusinessSuccess, isBusinessSuccess } from './assertions.mjs'
import { resourceUrl } from './redact.mjs'

/**
 * 带重试的页面导航。jixu-ai.com 会从边缘节点拦截海外机房的
 * 自动化浏览器流量（net::ERR_EMPTY_RESPONSE，curl 正常），
 * 此时重试几次（应对间歇性拦截），最终失败则抛出可识别的
 * 网络错误，方便与真正的测试断言失败区分开。
 */
export async function gotoSite (page, url, opts = {}) {
  const tries = opts.tries ?? 3
  let lastErr = null
  for (let i = 1; i <= tries; i++) {
    try {
      await pageObservers.get(page)?.flushResponses()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000, ...opts.goto })
      return
    } catch (err) {
      lastErr = err
      const msg = String(err?.message || err)
      if (/ERR_EMPTY_RESPONSE|ERR_CONNECTION|ETIMEDOUT|ENOTFOUND|ERR_TUNNEL_CONNECTION_FAILED/i.test(msg)) {
        if (i < tries) {
          await new Promise(r => setTimeout(r, 10000))
          continue
        }
        throw new Error(
          `网站不可达（${i} 次重试均失败）：${url}。` +
          `最后错误：${msg.split('\n')[0]}。` +
          '疑似当前机房 IP 被站点边缘拦截（海外 runner 常见）；' +
          '建议改用国内 self-hosted runner 跑此套件。'
        )
      }
      throw err
    }
  }
  throw lastErr
}

const SELECTORS = {
  loginCard: '.portal-login-card',
  accountTab: 'button:has-text("账密登录")',
  tenant: [
    'input[placeholder="请输入租户名称"]',
    'input[placeholder*="租户"]',
    'input[name="tenantName"]'
  ],
  username: [
    'input[placeholder="请输入用户名"]',
    'input[placeholder*="用户名"]',
    'input[name="username"]'
  ],
  password: [
    'input[placeholder="请输入密码"]',
    'input[name="password"]',
    'input[type="password"]'
  ],
  loggedIn: ['.avatar', '.user-info', '[class*="user"]', 'text=工作台']
}
const loginContexts = new WeakMap()
const pageObservers = new WeakMap()

// Layout and form-prefetch requests are shared background work. They may outlive
// a business case, but HTTP and business failures must still be recorded.
//
// 门户首页（/index）登录后会并发预取一批聚合小部件数据。用例随后用整页跳转打开业务
// 路由时，浏览器会取消这些还没返回的 XHR，而 Playwright 对这类被跨文档导航销毁的请求
// 既不发 requestfinished 也不发 requestfailed，收尾 flush 会被永久阻塞。
// 放行条件同时要求「发起请求时的页面文档就是门户首页」，因此同一路径被业务页面正常
// 调用时仍然按业务请求阻塞收尾；失败也依旧通过 requestfailed 与响应体检查记录。
const HOME_WORKSPACE_PREFETCH_PATHS = new Set([
  '/workbench/todo/page',
  '/bpm/task/done-page',
  '/bpm/process-instance/my-page',
  '/bpm/process-instance/copy/page',
  '/system/notify-message/my-page',
  '/system/notice/page',
  '/hrm/survey/my-pending',
  '/oa/schedule/my-page',
  '/oa/schedule/received-page',
  '/oa/meeting-booking/my-range',
  '/oa/task/received-page',
  '/oa/plan/page',
  '/oa/contact/my-page',
  '/erp/sale-order/page',
  '/pms/pm/project/page',
  '/pms/kb/favorite/page',
  '/pm/daily-report/page',
  '/crm/work-report/page',
  '/system/user-favorite/page'
])

const PORTAL_HOME_PATHS = new Set(['/', '/index'])

const isPortalHomeDocument = (url) => {
  try {
    return PORTAL_HOME_PATHS.has(new URL(String(url || '')).pathname)
  } catch {
    return false
  }
}

const isHomeWorkspacePrefetch = (url, documentUrl) => {
  if (!isPortalHomeDocument(documentUrl)) return false
  const pathname = String(url || '').split(/[?#]/)[0]
  const marker = '/admin-api'
  const index = pathname.lastIndexOf(marker)
  if (index < 0) return false
  return HOME_WORKSPACE_PREFETCH_PATHS.has(pathname.slice(index + marker.length))
}

const isBackgroundLifecycleRequest = (url, documentUrl) =>
  /\/system\/system-init\/(?:state|readiness)(?:[/?]|$)/.test(url || '') ||
  /\/base\/material-grade\/simple-list(?:[/?]|$)/.test(url || '') ||
  /\/system\/notify-message\/get-unread-list(?:[/?]|$)/.test(url || '') ||
  // 个人工作台首页会预取用户偏好（列宽/视图等），可能在用例导航或收尾时仍在
  // 传输中。它同样保持失败可观测，但不阻塞健康的浏览器上下文被下一个用例复用。
  /\/system\/user-preference\/get(?:[/?]|$)/.test(url || '') ||
  // The portal notification panel keeps this request alive while a case
  // navigates through business pages. It remains observable for failures,
  // but must not block reuse of an otherwise healthy browser session.
  /\/oa\/announcement\/received-page(?:[/?]|$)/.test(url || '') ||
  isHomeWorkspacePrefetch(url, documentUrl)

export const isExpectedRequestFailure = ({ resourceType, error, url } = {}) =>
  error === 'net::ERR_ABORTED' &&
  (
    (resourceType === 'media' &&
      /\/ai-human\/digital-human-idle\.webm(?:$|\?)/.test(url || '')) ||
    // Vite cancels the local root fetch while openRoute warms the dynamic route
    // registry. It is a navigation teardown, not a business request failure.
    (resourceType === 'fetch' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url || ''))
  )

export const isReleasedResponseBodyError = (error) => {
  const message = String(error?.message || error || '')
  return /No resource with given identifier found|Response body is not available for a response that was navigated away from|Target page, context or browser has been closed/i
    .test(message)
}

async function firstVisible (page, selectors, timeout = 30000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    try {
      await locator.waitFor({ state: 'visible', timeout })
      return locator
    } catch {}
  }
  throw new Error(`找不到可见元素：${selectors.join(' / ')}`)
}

async function findLoginButton (page, timeout = 30000) {
  const exact = page.locator('.portal-login-card').getByRole('button', { name: '登录', exact: true }).first()
  try {
    await exact.waitFor({ state: 'visible', timeout })
    return exact
  } catch {}

  for (const selector of [
    '.portal-login-card button[type="submit"]',
    '.portal-login-card button.el-button--primary',
    '.portal-login-card button.el-button'
  ]) {
    const buttons = page.locator(selector)
    for (let i = 0; i < await buttons.count(); i++) {
      const button = buttons.nth(i)
      if (!(await button.isVisible().catch(() => false))) continue
      const text = (await button.innerText().catch(() => '')).replace(/\s+/g, '')
      if (text === '登录') return button
    }
  }
  throw new Error('找不到登录提交按钮')
}

async function waitForLoginSurface (page, timeout = config.browserTimeoutMs) {
  await page.waitForFunction(
    () => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false
        const style = window.getComputedStyle(element)
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0 &&
          element.getBoundingClientRect().width > 0 &&
          element.getBoundingClientRect().height > 0
      }
      const selectors = [
        'input[placeholder="请输入租户名称"]',
        'input[placeholder*="租户"]',
        'input[name="tenantName"]',
        'input[placeholder="请输入用户名"]',
        'input[placeholder*="用户名"]',
        'input[name="username"]',
        'input[placeholder="请输入密码"]',
        'input[name="password"]',
        'input[type="password"]'
      ]
      return selectors.some((selector) =>
        [...document.querySelectorAll(selector)].some(isVisible)
      )
    },
    undefined,
    { timeout }
  )
}

export async function dumpLoginDom (page, directory, tag = 'login') {
  if (!directory) return null
  try {
    ensureDir(directory)
    const html = await page.locator(SELECTORS.loginCard).first().innerHTML().catch(() => '')
    const file = path.join(directory, `${tag}-dom.html`)
    fs.writeFileSync(file, html || await page.content())
    return file
  } catch {
    return null
  }
}

export function chromeLaunchOptions () {
  const chrome = resolveChromePath()
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return {
      executablePath: fileURLToPath(new URL('./chrome-macos.sh', import.meta.url)),
      env: { ...process.env, CFOR_NATIVE_CHROME_PATH: chrome }
    }
  }
  return { executablePath: chrome }
}

export async function launchBrowser ({ headed = false, record } = {}) {
  const rawProxy = process.env.https_proxy || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.HTTP_PROXY
  let proxy
  if (rawProxy) {
    try {
      const parsed = new URL(rawProxy)
      proxy = {
        server: `${parsed.protocol}//${parsed.host}`,
        ...(parsed.username
          ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
          : {})
      }
    } catch {
      proxy = { server: rawProxy }
    }
  }

  const browser = await chromium.launch({
    headless: headed ? false : config.headless,
    ...chromeLaunchOptions(),
    proxy,
    args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--window-size=1600,900']
  })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    locale: 'zh-CN'
  })
  context.setDefaultTimeout(config.browserTimeoutMs)
  context.setDefaultNavigationTimeout(config.browserTimeoutMs)
  await context.addInitScript(() => performance.setResourceTimingBufferSize(10000))
  const page = await context.newPage()
  const capture = observePage(page, record)
  return { browser, context, page, flushResponses: capture.flushResponses }
}

export function observePage (page, record) {
  const existing = pageObservers.get(page)
  if (existing) return existing
  const responseTasks = new Map()
  const pendingRequests = new Map()
  const consoleTasks = new Set()
  const currentDocumentUrl = () => {
    try {
      return typeof page.url === 'function' ? page.url() : ''
    } catch {
      return ''
    }
  }
  const trackRequest = (request) => {
    if (!/\/(?:admin|app)-api\//.test(request.url())) return
    if (!pendingRequests.has(request)) {
      let resolve
      const finished = new Promise((settle) => { resolve = settle })
      pendingRequests.set(request, {
        finished, resolve, startedAt: Date.now(),
        method: request.method(), url: resourceUrl(request.url()),
        // 门户首页的聚合预取只在「发起时仍停留在首页文档」才被放行。
        background: isBackgroundLifecycleRequest(request.url(), currentDocumentUrl())
      })
    }
    return pendingRequests.get(request)
  }
  const finishRequest = (request, completed) => {
    pendingRequests.get(request)?.resolve(completed)
    pendingRequests.delete(request)
  }
  page.on('request', trackRequest)
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    record?.consoleErrors?.push(text)
    const location = message.location()
    const entry = {
      text, url: resourceUrl(location.url),
      line: location.lineNumber, column: location.columnNumber
    }
    record?.consoleErrorDetails?.push(entry)
    const task = (async () => {
      const details = []
      for (const arg of message.args()) {
        try {
          const error = await arg.evaluate((value) => {
            if (value instanceof Error) {
              return { name: value.name, message: value.message, stack: value.stack }
            }
            return null
          })
          if (error) details.push(error)
        } catch {}
      }
      if (details.length) entry.errors = details
    })()
    consoleTasks.add(task)
    task.finally(() => consoleTasks.delete(task))
  })
  page.on('requestfailed', (request) => {
    finishRequest(request, false)
    const failure = {
      url: resourceUrl(request.url()), method: request.method(),
      resourceType: request.resourceType(), error: request.failure()?.errorText
    }
    if (isExpectedRequestFailure(failure)) return
    record?.requestFailures?.push(failure)
  })
  page.on('requestfinished', (request) => finishRequest(request, true))
  page.on('pageerror', (error) => record?.pageErrors?.push(error.message))
  page.on('response', (response) => {
    if (!/\/(?:admin|app)-api\//.test(response.url())) return
    const entry = {
      status: response.status(), method: response.request().method(),
      url: resourceUrl(response.url())
    }
    if (response.status() >= 400) {
      record?.failedApiResponses?.push(entry)
      finishRequest(response.request(), false)
      return
    }
    const headers = response.headers()
    if (!headers['content-type']?.includes('json') &&
      headers[ENCRYPT_HEADER.toLowerCase()] !== 'true') {
      finishRequest(response.request(), false)
      return
    }
    const trackedRequest = trackRequest(response.request())
    if (!trackedRequest) return
    const { finished } = trackedRequest
    const task = (async () => {
      try {
        // Reading before requestfinished can leave a body read pending across navigations.
        if (!await finished) return
        const text = await response.text()
        const body = headers[ENCRYPT_HEADER.toLowerCase()] === 'true'
          ? decryptResponse(text) : JSON.parse(text)
        if (typeof body?.code === 'number' && !isBusinessSuccess(body)) {
          record?.failedApiResponses?.push({ ...entry, code: body.code })
        }
      } catch (error) {
        // Chrome can release a successful background response body when a route
        // navigation replaces the old document. This is not an API or business failure.
        if (isReleasedResponseBodyError(error)) return
        record?.failedApiResponses?.push({
          ...entry, responseError: true, error: String(error.message || error)
        })
      }
    })()
    responseTasks.set(task, {
      ...entry,
      startedAt: Date.now(),
      background: trackedRequest.background
    })
    task.finally(() => responseTasks.delete(task))
  })
  const capture = {
    async flushResponses ({ timeoutMs = 12000, quietMs = 50 } = {}) {
      let timer
      let expired = false
      try {
        await Promise.race([
          (async () => {
            do {
              await Promise.all([
                ...[...responseTasks.entries()]
                  .filter(([, entry]) => !entry.background)
                  .map(([task]) => task),
                ...[...pendingRequests.values()]
                  .filter((entry) => !entry.background)
                  .map((entry) => entry.finished),
                ...consoleTasks
              ])
              // Drain events queued during body reads before freezing case evidence or navigating.
              await new Promise((resolve) => setTimeout(resolve, quietMs))
            } while (!expired && (
              [...responseTasks.values()].some((entry) => !entry.background) ||
              [...pendingRequests.values()].some((entry) => !entry.background) ||
              consoleTasks.size > 0
            ))
          })(),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              expired = true
              const pending = [
                ...[...responseTasks.values()].filter((entry) => !entry.background),
                ...[...pendingRequests.values()].filter((entry) => !entry.background)
              ]
                .map(({ startedAt, finished, resolve, ...entry }) => ({
                ...entry, pendingMs: Date.now() - startedAt
              }))
              reject(new Error(`响应检查未完成，禁止复用当前上下文: ${JSON.stringify(pending)}`))
            }, timeoutMs)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
  }
  pageObservers.set(page, capture)
  return capture
}

async function readToken (page) {
  const entries = await page.evaluate(() => {
    const entries = []
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        entries.push([key, storage.getItem(key)])
      }
    }
    return entries
  }).catch(() => [])
  const keys = entries.map(([key]) => key)
  const token = extractAccessToken(entries)
  if (token) return { token, keys }
  const cookies = await page.context().cookies().catch(() => [])
  return {
    token: extractAccessToken(cookies.map((item) => [item.name, item.value])),
    keys
  }
}

async function readLoginResponse (response) {
  if (!response) return null
  const text = await response.text().catch(() => '')
  if (!text) return null
  try {
    return response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
      ? decryptResponse(text)
      : JSON.parse(text)
  } catch {
    return null
  }
}

function watchApiFailures (page) {
  const failures = []
  page.on('response', (response) => {
    if (response.url().includes('/admin-api/') && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`)
    }
  })
  return failures
}

export async function login (page, { check, dumpDir, credentials, returnContext = false } = {}) {
  const tenantName = credentials?.tenantName ?? config.tenantName
  const username = credentials?.username ?? config.username
  const password = credentials?.password ?? config.password
  if (credentials && page.url() !== 'about:blank') {
    throw new Error('关联账号必须使用新建、隔离的 Chrome 页面登录，不能覆盖当前管理员会话')
  }
  const reuseSession = async () => {
    if (credentials || !config.reuseSession || !page.url().startsWith(config.webBase)) return null
    const { token } = await readToken(page)
    if (!token) return null
    // Visiting /login with an existing token redirects to the public portal.
    // Another page in this context may already have completed authentication.
    if (['/', '/login'].includes(new URL(page.url()).pathname)) {
      await gotoSite(page, `${config.webBase}/index`, {
        goto: { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }
      })
      await page.locator('[class*="-user-info"]').first().waitFor({
        state: 'visible', timeout: config.browserTimeoutMs
      })
    }
    check?.step('page', '复用当前登录会话', true, page.url())
    const cached = loginContexts.get(page.context())
    return returnContext
      ? { token, tenantId: cached?.token === token ? cached.tenantId : '' }
      : token
  }
  const existingSession = await reuseSession()
  if (existingSession) return existingSession
  await gotoSite(page, `${config.webBase}/login`, {
    goto: { waitUntil: 'domcontentloaded', timeout: 60000 }
  })

  const redirectedSession = await reuseSession()
  if (redirectedSession) return redirectedSession

  try {
    await waitForLoginSurface(page)
    const tab = page.locator(SELECTORS.accountTab).first()
    if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {})

    const tenant = await firstVisible(page, SELECTORS.tenant)
    if (!tenantName || !username || !password) {
      throw new Error('缺少 CFOR_TENANT_NAME、CFOR_USERNAME 或 CFOR_PASSWORD')
    }
    await tenant.fill(tenantName)
    await tenant.press('Tab')
    await page.locator('text=企业名称校验通过').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})

    await (await firstVisible(page, SELECTORS.username)).fill(username)
    await (await firstVisible(page, SELECTORS.password)).fill(password)
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/system/auth/login-encrypted') &&
        response.request().method() === 'POST',
      { timeout: 30000 }
    ).catch(() => null)
    await (await findLoginButton(page)).click()
    const loginResponse = await responsePromise
    const loginPayload = await readLoginResponse(loginResponse)
    // Reject bad credentials before waiting for token and router bootstrap.
    assertBusinessSuccess(loginPayload, `登录 ${username}（租户 ${tenantName}）`)
    // The login page completes authentication through Vue router and permission
    // bootstrap. Waiting for a full "load" event is flaky for history.pushState
    // navigations, so poll the actual URL and storage state instead.
    const loginDeadline = Date.now() + 90000
    let token = ''
    let keys = []
    while (Date.now() < loginDeadline) {
      const current = await readToken(page)
      token = current.token
      keys = current.keys
      if (token && !page.url().includes('/login')) break
      await page.waitForTimeout(250)
    }
    if (!token || page.url().includes('/login')) {
      throw new Error(
        `登录后系统初始化超时：url=${page.url()}，title=${await page.title().catch(() => '')}，storageKeys=${keys.slice(0, 10).join(',')}`
      )
    }
    // Authentication completes before the dynamic menu and route scope finish mounting.
    // Wait for the admin shell to settle so deep-link checks do not race route registration.
    // The shell boot is shared with parallel work on the same dev server, so use the
    // configured browser timeout instead of a hardcoded 30s.
    const shellTimeout = config.browserTimeoutMs
    await page
      .getByText('正在加载系统中...', { exact: true })
      .first()
      .waitFor({ state: 'hidden', timeout: shellTimeout })
      .catch(() => {})
    await page
      .locator('[class*="-user-info"]')
      .first()
      .waitFor({ state: 'visible', timeout: shellTimeout })
    check?.step('page', '登录后离开 /login', true, page.url())
    check?.step('page', '本地 token 已写入', Boolean(token), keys.slice(0, 10).join(','))
    if (!token) throw new Error('登录成功后未读取到 token')
    const loginContext = resolveLoginContext(loginPayload, token)
    loginContexts.set(page.context(), loginContext)
    return returnContext ? loginContext : token
  } catch (error) {
    const dump = await dumpLoginDom(page, dumpDir, 'login')
    throw new Error(`${error.message}${dump ? `（登录 DOM：${dump}）` : ''}`)
  }
}

export const loginWithCredentials = async (page, credentials, options = {}) =>
  login(page, { ...options, credentials })

export async function openRegistration (page) {
  await gotoSite(page, `${config.webBase}/login`, {
    goto: { waitUntil: 'domcontentloaded' }
  })
  await page.getByText('前往注册', { exact: true }).first().click()
  await page.getByPlaceholder('企业 / 团队名称').waitFor({ state: 'visible' })
}

export async function submitTenantRegistration (page) {
  const required = [
    ['CFOR_REGISTER_EMAIL', config.registerEmail],
    ['CFOR_REGISTER_PASSWORD', config.registerPassword],
    ['CFOR_REGISTER_EMAIL_CODE', config.registerEmailCode]
  ]
  const missing = required.filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) throw new Error(`BLOCKED: registration credentials missing: ${missing.join(', ')}`)
  await page.getByPlaceholder('企业 / 团队名称').fill(config.registerTenantName)
  await page.getByPlaceholder('联系人姓名').fill(config.registerContactName || config.registerTenantName)
  await page.getByPlaceholder('登录邮箱（审核通过后作为登录账号）').fill(config.registerEmail)
  await page.getByPlaceholder('邮箱验证码').fill(config.registerEmailCode)
  await page.getByPlaceholder('设置管理员密码').fill(config.registerPassword)
  await page.getByPlaceholder('确认密码').fill(config.registerPassword)
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: '提交注册申请' }).click()
  await page.getByText('申请已提交', { exact: true }).waitFor({ state: 'visible' })
}

export async function openRoute (page, pathname, options = {}) {
  const failures = watchApiFailures(page)
  const target = new URL(`${config.webBase}${pathname}`)
  const index = new URL(`${config.webBase}/index`)
  // Backend menus are converted into dynamic Vue Router routes after login.
  // A real deep navigation lets the app rebuild that route scope deterministically.
  const readyTimeoutMs = options.readyTimeoutMs || config.browserTimeoutMs
  const retries = Number.isInteger(options.retries) ? options.retries : 0
  let lastError
  let warmedDynamicRoutes = false

  const waitUntilReady = async () => {
    await page.waitForFunction(
      (expectedPath) => window.location.pathname === expectedPath,
      target.pathname,
      { timeout: config.browserTimeoutMs }
    )
    if (options.readySelector) {
      await page.locator(options.readySelector).first().waitFor({
        state: 'visible',
        timeout: readyTimeoutMs
      })
    } else {
      await page.waitForFunction(
        (readyText) => {
          const text = document.body?.innerText || ''
          return text.includes(readyText) && text.length > 100
        },
        options.readyText || '工作台',
        { timeout: readyTimeoutMs }
      )
    }
  }

  const isNotFoundPage = async () =>
    page
      .locator('body')
      .evaluate((body) => {
        const text = body?.innerText || ''
        return /页面不存在|Page Not Found|\b404\b/.test(text)
      })

  // Reserve one recovery attempt for warming the dynamic route registry from /index.
  for (let attempt = 0; attempt <= retries + 1; attempt++) {
    try {
      await gotoSite(page, target.toString(), {
        goto: { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }
      })
      if (await isNotFoundPage()) {
        throw new Error(`动态路由尚未注册：${pathname}`)
      }
      await waitUntilReady()
      await waitForPageReady(page, readyTimeoutMs)
      return { failures }
    } catch (error) {
      lastError = error
      if (!warmedDynamicRoutes) {
        warmedDynamicRoutes = true
        await gotoSite(page, index.toString(), {
          goto: { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }
        })
        await page.waitForFunction(
          (readyText) => {
            const text = document.body?.innerText || ''
            return text.includes(readyText) && text.length > 100
          },
          '工作台',
          { timeout: readyTimeoutMs }
        )
        continue
      }
      if (attempt >= retries + 1) throw error
      await page.waitForTimeout(500)
    }
  }
  throw lastError
}

export async function waitForPageReady (page, timeout = config.browserTimeoutMs) {
  await page.waitForFunction(
    () => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false
        const style = window.getComputedStyle(element)
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0 &&
          element.getBoundingClientRect().width > 0 &&
          element.getBoundingClientRect().height > 0
      }
      const loadingSelectors = [
        '[aria-busy="true"]',
        '.route-skeleton',
        '.el-skeleton',
        '.el-loading-mask'
      ]
      return loadingSelectors.every((selector) =>
        ![...document.querySelectorAll(selector)].some(isVisible)
      )
    },
    undefined,
    { timeout }
  )
}

export async function tableRows (page) {
  return page.locator('.el-table__row').evaluateAll((rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) =>
        String(cell.textContent || '').replace(/\s+/g, ' ').trim()
      )
    )
  )
}

export async function bodyContainsAny (page, keywords) {
  const text = await page.locator('body').innerText()
  return keywords.filter((keyword) => text.includes(keyword))
}

export async function saveScreenshot (page, outputDir, name, record) {
  ensureDir(outputDir)
  const target = path.join(outputDir, `${name}.png`)
  const screenshotOptions = {
    animations: 'disabled',
    caret: 'hide',
    timeout: Math.min(config.browserTimeoutMs, 15000)
  }
  try {
    await page.screenshot({ ...screenshotOptions, path: target, fullPage: true })
    record?.screenshots?.push(target)
    return target
  } catch (error) {
    // Very tall or continuously changing pages can block full-page layout
    // capture. Keep a usable viewport artifact so the business result is not
    // lost only because the evidence page could not be stitched.
    const viewportTarget = path.join(outputDir, `${name}-viewport.png`)
    await page.screenshot({ ...screenshotOptions, path: viewportTarget, fullPage: false })
    record?.screenshots?.push(viewportTarget)
    record?.notes?.push(`全屏截图失败，已降级为视口截图：${String(error?.message || error).split('\n')[0]}`)
    return viewportTarget
  }
}
