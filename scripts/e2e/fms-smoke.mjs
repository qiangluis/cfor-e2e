#!/usr/bin/env node

import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const config = {
  webBase: process.env.CFOR_WEB_BASE || 'http://127.0.0.1:9160',
  apiBase: process.env.CFOR_API_BASE || 'http://127.0.0.1:48083',
  tenantId: process.env.CFOR_TENANT_ID || '1',
  tenantName: process.env.CFOR_TENANT_NAME || '福奇科技',
  username: process.env.CFOR_USERNAME || 'admin',
  password: process.env.CFOR_PASSWORD || 'admin123',
  accountSetId: process.env.CFOR_FMS_ACCOUNT_SET_ID || '1',
  chromePath:
    process.env.CFOR_CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  outputDir:
    process.env.CFOR_E2E_OUT ||
    path.join('/tmp', 'cfor-e2e', 'fms-smoke'),
  requestTimeoutMs: Number(process.env.CFOR_E2E_REQUEST_TIMEOUT_MS || 20000),
  browserTimeoutMs: Number(process.env.CFOR_E2E_BROWSER_TIMEOUT_MS || 180000)
}

const result = {
  startedAt: new Date().toISOString(),
  environment: {
    webBase: config.webBase,
    apiBase: config.apiBase,
    tenantId: config.tenantId,
    tenantName: config.tenantName,
    username: config.username,
    accountSetId: config.accountSetId
  },
  checks: [],
  api: {},
  browser: {},
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  failedApiResponses: []
}

const check = (name, passed, details = '') => {
  const item = { name, passed: Boolean(passed), details }
  result.checks.push(item)
  const marker = item.passed ? 'PASS' : 'FAIL'
  console.log(`[${marker}] ${name}${details ? ` - ${details}` : ''}`)
  return item.passed
}

const assertCheck = (name, passed, details = '') => {
  if (!check(name, passed, details)) {
    throw new Error(`${name}: ${details || 'assertion failed'}`)
  }
}

const stage = (name) => {
  console.log(`[STAGE] ${name}`)
}

const nonEmpty = (value) => value !== undefined && value !== null && String(value).trim() !== ''

const unwrapWebStorageValue = (rawValue) => {
  if (!rawValue) return null
  try {
    const parsed = JSON.parse(rawValue)
    if (parsed && typeof parsed === 'object' && 'v' in parsed) {
      return typeof parsed.v === 'string' ? JSON.parse(parsed.v) : parsed.v
    }
    return parsed
  } catch {
    return rawValue
  }
}

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 300)}`)
  }
  return body
}

const apiGet = (pathname, accessToken) =>
  fetchJson(`${config.apiBase}/admin-api${pathname}`, {
    headers: {
      'tenant-id': config.tenantId,
      Authorization: `Bearer ${accessToken}`
    }
  })

const extractTableRows = (page) =>
  page.locator('.el-table__row').evaluateAll((rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) =>
        String(cell.textContent || '').replace(/\s+/g, ' ').trim()
      )
    )
  )

const waitForTable = async (page) => {
  await page.locator('.el-table__row').first().waitFor({
    state: 'visible',
    timeout: config.browserTimeoutMs
  })
}

const gotoAndWait = async (page, pathname) => {
  await page.goto(`${config.webBase}${pathname}`, {
    waitUntil: 'commit',
    timeout: config.browserTimeoutMs
  })
  await page.waitForLoadState('networkidle', { timeout: config.browserTimeoutMs }).catch(() => {})
  await waitForTable(page)
}

const saveScreenshot = async (page, name) => {
  const target = path.join(config.outputDir, `${name}.png`)
  await page.screenshot({
    path: target,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    timeout: 15000
  })
  result.screenshots.push(target)
}

let browser
let context
let page
const hardTimeout = setTimeout(() => {
  console.error('[FAIL] e2e hard timeout after 10 minutes')
  process.exit(124)
}, 10 * 60 * 1000)

try {
  stage('prepare output directory')
  await mkdir(config.outputDir, { recursive: true })

  stage('check web and API availability')
  const webHealth = await fetchJson(`${config.webBase}/`)
  assertCheck('web is reachable', webHealth !== null, config.webBase)

  const apiHealth = await fetchJson(`${config.apiBase}/actuator/health`)
  assertCheck('api is healthy', apiHealth?.status === 'UP', JSON.stringify(apiHealth))

  stage('launch browser')
  browser = await chromium.launch({
    headless: process.env.CFOR_E2E_HEADLESS !== 'false',
    executablePath: config.chromePath,
    args: ['--disable-dev-shm-usage']
  })
  stage('create browser context')
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN'
  })
  context.setDefaultTimeout(config.browserTimeoutMs)
  context.setDefaultNavigationTimeout(config.browserTimeoutMs)
  page = await context.newPage()

  page.on('console', (message) => {
    if (message.type() === 'error') {
      result.consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    result.pageErrors.push(error.message)
  })
  page.on('response', (response) => {
    if (response.url().includes('/admin-api/') && response.status() >= 400) {
      result.failedApiResponses.push({
        status: response.status(),
        method: response.request().method(),
        url: response.url()
      })
    }
  })

  stage('open login page')
  await page.goto(`${config.webBase}/login`, {
    waitUntil: 'commit',
    timeout: config.browserTimeoutMs
  })
  const usernameInput = page.getByPlaceholder('请输入用户名').first()
  const passwordInput = page.getByPlaceholder('请输入密码').first()
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      stage(`wait for login form, attempt ${attempt}`)
      await usernameInput.waitFor({
        state: 'visible',
        timeout: attempt === 1 ? 30000 : config.browserTimeoutMs
      })
      break
    } catch (error) {
      if (attempt === 2) throw error
      result.browser.loginPageColdStartRetry = true
      await page.reload({
        waitUntil: 'commit',
        timeout: config.browserTimeoutMs
      })
    }
  }
  const visibleLoginForm = usernameInput.locator('xpath=ancestor::form[1]')
  stage('fill and submit login form')
  await visibleLoginForm.locator('input').first().fill(config.tenantName)
  await usernameInput.fill(config.username)
  await passwordInput.fill(config.password)

  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/system/auth/login-encrypted') &&
      response.request().method() === 'POST',
    { timeout: config.browserTimeoutMs }
  )
  await visibleLoginForm.getByRole('button', { name: '登录' }).click()
  const loginResponse = await loginResponsePromise
  const loginBody = await loginResponse.json()
  assertCheck(
    'browser login succeeds',
    loginResponse.ok() && loginBody?.code === 0,
    `HTTP ${loginResponse.status()} code=${loginBody?.code}`
  )

  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), null, {
    timeout: config.browserTimeoutMs
  })
  stage('login completed')
  result.browser.landingUrl = page.url()
  assertCheck(
    'browser leaves login page',
    !new URL(page.url()).pathname.startsWith('/login'),
    page.url()
  )
  await saveScreenshot(page, '01-login-landing')

  const rawAccessToken = await page.evaluate(() =>
    window.localStorage.getItem('ACCESS_TOKEN')
  )
  const accessToken = unwrapWebStorageValue(rawAccessToken)
  assertCheck('access token is available', nonEmpty(accessToken), 'localStorage ACCESS_TOKEN')

  stage('verify FMS APIs')
  const accountSetResult = await apiGet('/fms/config/account-set/list', accessToken)
  const accountSets = Array.isArray(accountSetResult?.data) ? accountSetResult.data : []
  result.api.accountSets = accountSets
  assertCheck(
    'fixed FMS account set exists',
    accountSets.some((item) => String(item.id) === String(config.accountSetId)),
    accountSets.map((item) => `${item.id}:${item.companyName || item.companyCode || ''}`).join(', ')
  )

  const voucherResult = await apiGet('/fms/voucher-draft/page?pageNo=1&pageSize=20', accessToken)
  const voucherRows = voucherResult?.data?.list || []
  result.api.voucherDraft = {
    total: voucherResult?.data?.total,
    rows: voucherRows.slice(0, 5)
  }
  assertCheck(
    'voucher draft API returns data',
    voucherResult?.code === 0 && voucherRows.length > 0,
    `total=${voucherResult?.data?.total}`
  )
  assertCheck(
    'voucher draft API exposes trace fields',
    voucherRows.every(
      (row) => nonEmpty(row.draftNo) && nonEmpty(row.sourceSystem) && nonEmpty(row.eventType)
    ),
    `rows=${voucherRows.length}`
  )

  const eventResult = await apiGet('/fms/event-inbox/page?pageNo=1&pageSize=20', accessToken)
  const eventRows = eventResult?.data?.list || []
  result.api.eventInbox = {
    total: eventResult?.data?.total,
    rows: eventRows.slice(0, 5)
  }
  assertCheck(
    'event inbox API returns data',
    eventResult?.code === 0 && eventRows.length > 0,
    `total=${eventResult?.data?.total}`
  )
  assertCheck(
    'event inbox API exposes source fields',
    eventRows.every(
      (row) =>
        nonEmpty(row.sourceSystem) &&
        nonEmpty(row.eventType) &&
        nonEmpty(row.sourceBillType) &&
        nonEmpty(row.sourceBillId) &&
        nonEmpty(row.sourceVersion) &&
        nonEmpty(row.direction) &&
        row.retryCount !== undefined &&
        row.retryCount !== null
    ),
    `rows=${eventRows.length}`
  )

  stage('open voucher draft page')
  await gotoAndWait(page, '/fms/voucher-draft')
  const voucherPageRows = await extractTableRows(page)
  result.browser.voucherDraftRows = voucherPageRows
  assertCheck(
    'voucher draft page renders rows',
    voucherPageRows.length > 0,
    `rows=${voucherPageRows.length}`
  )
  assertCheck(
    'voucher draft page row fields are visible',
    voucherPageRows.every(
      (cells) => nonEmpty(cells[0]) && nonEmpty(cells[2]) && nonEmpty(cells[3]) && nonEmpty(cells[6])
    ),
    `rows=${voucherPageRows.length}`
  )
  await saveScreenshot(page, '02-voucher-draft')

  stage('open event inbox page')
  await gotoAndWait(page, '/fms/event-inbox')
  const eventPageRows = await extractTableRows(page)
  result.browser.eventInboxRows = eventPageRows
  assertCheck(
    'event inbox page renders rows',
    eventPageRows.length > 0,
    `rows=${eventPageRows.length}`
  )
  assertCheck(
    'event inbox page row fields are visible',
    eventPageRows.every(
      (cells) =>
        nonEmpty(cells[0]) &&
        nonEmpty(cells[1]) &&
        nonEmpty(cells[2]) &&
        cells[2].includes('/') &&
        nonEmpty(cells[3]) &&
        cells[3].includes('/') &&
        nonEmpty(cells[6])
    ),
    `rows=${eventPageRows.length}`
  )
  await saveScreenshot(page, '03-event-inbox')

  assertCheck(
    'no page JavaScript errors',
    result.pageErrors.length === 0,
    result.pageErrors.join(' | ')
  )
  assertCheck(
    'no failed admin API responses',
    result.failedApiResponses.length === 0,
    result.failedApiResponses.map((item) => `${item.status} ${item.url}`).join(' | ')
  )
} catch (error) {
  check('e2e execution completed', false, error instanceof Error ? error.message : String(error))
  result.error = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }
  if (page) {
    await saveScreenshot(page, '99-failure').catch(() => {})
  }
} finally {
  clearTimeout(hardTimeout)
  if (context) {
    await context.close().catch(() => {})
  }
  if (browser) {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]).catch(() => {})
  }
}

result.finishedAt = new Date().toISOString()
result.passed = result.checks.length > 0 && result.checks.every((item) => item.passed)
await mkdir(config.outputDir, { recursive: true })
const resultFile = path.join(config.outputDir, 'result.json')
await writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8')

console.log(`Result: ${result.passed ? 'PASS' : 'FAIL'}`)
console.log(`Report: ${resultFile}`)
console.log(`Screenshots: ${result.screenshots.join(', ') || 'none'}`)

process.exit(result.passed ? 0 : 1)
