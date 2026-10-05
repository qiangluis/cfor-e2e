import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, resolveChromePath } from '../config/index.mjs'
import { ensureDir } from './report.mjs'
import { decryptResponse, ENCRYPT_HEADER } from './crypto.mjs'
import { extractAccessToken } from './session.mjs'
import { isBusinessSuccess } from './assertions.mjs'
import { resourceUrl } from './redact.mjs'

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

export const isExpectedRequestFailure = ({ resourceType, error, url } = {}) =>
  resourceType === 'media' &&
  error === 'net::ERR_ABORTED' &&
  /\/ai-human\/digital-human-idle\.webm(?:$|\?)/.test(url || '')

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
  const responseTasks = new Set()
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    record?.consoleErrors?.push(message.text())
    const location = message.location()
    record?.consoleErrorDetails?.push({
      text: message.text(), url: resourceUrl(location.url),
      line: location.lineNumber, column: location.columnNumber
    })
  })
  page.on('requestfailed', (request) => {
    const failure = {
      url: resourceUrl(request.url()), method: request.method(),
      resourceType: request.resourceType(), error: request.failure()?.errorText
    }
    if (isExpectedRequestFailure(failure)) return
    record?.requestFailures?.push(failure)
  })
  page.on('pageerror', (error) => record?.pageErrors?.push(error.message))
  page.on('response', (response) => {
    if (!/\/(?:admin|app)-api\//.test(response.url())) return
    const task = (async () => {
      const entry = {
        status: response.status(), method: response.request().method(),
        url: resourceUrl(response.url())
      }
      if (response.status() >= 400) {
        record?.failedApiResponses?.push(entry)
        return
      }
      const headers = response.headers()
      if (!headers['content-type']?.includes('json') &&
        headers[ENCRYPT_HEADER.toLowerCase()] !== 'true') return
      try {
        const text = await response.text()
        const body = headers[ENCRYPT_HEADER.toLowerCase()] === 'true'
          ? decryptResponse(text) : JSON.parse(text)
        if (typeof body?.code === 'number' && !isBusinessSuccess(body)) {
          record?.failedApiResponses?.push({ ...entry, code: body.code })
        }
      } catch {}
    })()
    responseTasks.add(task)
    task.finally(() => responseTasks.delete(task))
  })
  return { browser, context, page, flushResponses: () => Promise.all([...responseTasks]) }
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

function watchApiFailures (page) {
  const failures = []
  page.on('response', (response) => {
    if (response.url().includes('/admin-api/') && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`)
    }
  })
  return failures
}

export async function login (page, { check, dumpDir, credentials } = {}) {
  const tenantName = credentials?.tenantName ?? config.tenantName
  const username = credentials?.username ?? config.username
  const password = credentials?.password ?? config.password
  if (credentials && page.url() !== 'about:blank') {
    throw new Error('关联账号必须使用新建、隔离的 Chrome 页面登录，不能覆盖当前管理员会话')
  }
  if (!credentials && config.reuseSession && page.url().startsWith(config.webBase) && !page.url().includes('/login')) {
    const { token } = await readToken(page)
    if (token) {
      check?.step('page', '复用当前登录会话', true, page.url())
      return token
    }
  }
  await page.goto(`${config.webBase}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })

  if (!page.url().includes('/login')) {
    const { token } = await readToken(page)
    if (!token) throw new Error('已登录但未找到 token')
    check?.step('page', '已是登录态，复用当前会话', true, page.url())
    return token
  }

  try {
    await page.locator(SELECTORS.loginCard).first().waitFor({ state: 'visible', timeout: 60000 })
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
    await responsePromise
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
    await page
      .getByText('正在加载系统中...', { exact: true })
      .first()
      .waitFor({ state: 'hidden', timeout: 30000 })
      .catch(() => {})
    await page
      .locator('[class*="-user-info"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
    check?.step('page', '登录后离开 /login', true, page.url())
    check?.step('page', '本地 token 已写入', Boolean(token), keys.slice(0, 10).join(','))
    if (!token) throw new Error('登录成功后未读取到 token')
    return token
  } catch (error) {
    const dump = await dumpLoginDom(page, dumpDir, 'login')
    throw new Error(`${error.message}${dump ? `（登录 DOM：${dump}）` : ''}`)
  }
}

export const loginWithCredentials = async (page, credentials) => login(page, { credentials })

export async function openRegistration (page) {
  await page.goto(`${config.webBase}/login`, { waitUntil: 'domcontentloaded' })
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
  // Backend menus are converted into dynamic Vue Router routes after login.
  // A real deep navigation lets the app rebuild that route scope deterministically.
  const readyTimeoutMs = options.readyTimeoutMs || config.browserTimeoutMs
  const retries = Number.isInteger(options.retries) ? options.retries : 0
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.goto(target.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: config.browserTimeoutMs
      })
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
      return { failures }
    } catch (error) {
      lastError = error
      if (attempt === retries) throw error
      await page.waitForTimeout(500)
    }
  }
  throw lastError
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

export async function saveScreenshot (page, outputDir, name, record) {
  ensureDir(outputDir)
  const target = path.join(outputDir, `${name}.png`)
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled', caret: 'hide' })
  record?.screenshots?.push(target)
  return target
}
