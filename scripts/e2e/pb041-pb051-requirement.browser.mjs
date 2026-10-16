#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { loadEnv } from 'vite'
import { config } from './config/index.mjs'
import { loginWithCredentials, waitForPageReady } from './lib/browser.mjs'
import { unwrapWebStorageValue } from './lib/assertions.mjs'

const implementedCases = ['PB041', 'PB043', 'PB049']
const selectableCases = [...implementedCases, 'PB051']
const usage = `
Local PB041/PB043 rule-dialog regression, with an optional PB049 API fixture flow.

  CFOR_WEB_BASE=http://127.0.0.1:9164 CFOR_API_BASE=http://127.0.0.1:48084 \\
  CFOR_TENANT_ID=1 node scripts/e2e/pb041-pb051-requirement.browser.mjs --keep-page

  ... node scripts/e2e/pb041-pb051-requirement.browser.mjs \\
      --case=PB049 --allow-local-fixtures --keep-page

Options:
  --case=PB041,PB043   Repeatable. Defaults to PB041,PB043; ALL includes deferred PB051.
  --allow-local-fixtures
                      Permit only this run's own CRM rule/customer/task writes.
  --keep-page         Leave the reused tab at the last inspected page.
  --out=/absolute/dir Evidence directory; otherwise CFOR_PB041_PB051_OUT or /tmp.
  --help              Print this help without connecting to Chrome.

Chrome must already expose CDP on http://127.0.0.1:9222 (CFOR_CDP_URL overrides).
An existing tab at CFOR_WEB_BASE is required. Its tenant-1 session is reused.
If expired, one UI login may use CFOR_TENANT_NAME/CFOR_USERNAME/CFOR_PASSWORD.
Both Web and API URLs must explicitly use 127.0.0.1. No production fallback.
Fixtures and screenshots are retained; no browser, context or user tab is closed.
PB051 is deferred and explicitly BLOCKED when selected; it performs no API writes.
This runner covers only the listed scenarios, not all PB041-PB051 requirements.
Exit codes: 0 = selected cases PASS, 1 = FAIL, 2 = BLOCKED/preconditions missing.
`

if (process.argv.includes('--help')) {
  console.log(usage.trim())
  process.exit(0)
}

class Blocked extends Error {
  constructor(message) {
    super(message)
    this.name = 'Blocked'
  }
}

const args = process.argv.slice(2)
const allowFixtures = args.includes('--allow-local-fixtures')
const keepPage = args.includes('--keep-page')
const requested = args
  .filter((arg) => arg.startsWith('--case='))
  .flatMap((arg) => arg.slice(7).split(','))
  .map((item) => item.trim().toUpperCase())
const selectedCases = [...new Set(
  requested.length
    ? requested.flatMap((item) => item === 'ALL' ? selectableCases : [item])
    : ['PB041', 'PB043']
)]
const runId = `PB041_051_${new Date().toISOString().replace(/\D/g, '')}_${randomBytes(3).toString('hex')}`
const outputDir = path.resolve(
  args.find((arg) => arg.startsWith('--out='))?.slice(6) ||
    process.env.CFOR_PB041_PB051_OUT ||
    `/tmp/cfor-pb041-pb051/${runId}`
)
const webBase = config.webBase.replace(/\/+$/, '')
const apiBase = config.apiBase
const cdpBase = process.env.CFOR_CDP_URL || 'http://127.0.0.1:9222'
const desktop = { width: 1440, height: 1000 }
const mobile = { width: 390, height: 844 }
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const report = {
  runId,
  startedAt: new Date().toISOString(),
  scope: implementedCases,
  deferredCases: ['PB051'],
  selectedCases,
  allowLocalFixtures: allowFixtures,
  keepPage,
  tenantId: '1',
  visualReview: 'Screenshots and viewport checks are evidence, not aesthetic acceptance.',
  fixturesRetained: true,
  fixtures: [],
  results: [],
  requests: [],
  safetyViolations: [],
  pageErrors: [],
  consoleErrors: [],
  uiHttpErrors: []
}
let browser
let page
let originalUrl
let originalViewport
let currentCase
let currentStep
let userId
let permissionInfo
let loginInProgress = false
let loginAttempts = 0
let guardInstalled = false
const ownedRules = new Map()
const ownedCustomers = new Map()
const ownedTasks = new Map()

const checkpoint = async () => {
  await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
}
const sameId = (left, right) => left != null && right != null && String(left) === String(right)
const validId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const requireId = (value, label) => {
  assert.ok(validId(value), `${label}: missing/invalid identifier`)
  return value
}
const ensure = (condition, message) => {
  if (!condition) throw new Blocked(message)
}
const safeMessage = (error) => String(error?.message || error)
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/((?:accessToken|refreshToken|password|token)=)[^&\s]+/gi, '$1[redacted]')
  .slice(0, 1500)
const query = (pathname, params = {}) => {
  const values = Object.entries(params).filter(([, value]) => value != null)
  return `${pathname}?${new URLSearchParams(values.map(([key, value]) => [key, String(value)]))}`
}
const localUrl = (value, label) => {
  const url = new URL(value)
  ensure(
    ['http:', 'https:'].includes(url.protocol) &&
      url.hostname === '127.0.0.1' &&
      !url.username && !url.password && !url.search && !url.hash,
    `${label} must explicitly use http(s)://127.0.0.1 with no credentials/query/fragment`
  )
  return url
}
const storedSession = async () => {
  ensure(new URL(page.url()).origin === new URL(webBase).origin, 'Tab left the local Web origin')
  const raw = await page.evaluate(() => ({
    token: localStorage.getItem('ACCESS_TOKEN'),
    tenantId: localStorage.getItem('tenantId'),
    visitTenantId: localStorage.getItem('visitTenantId')
  }))
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, unwrapWebStorageValue(value)])
  )
}
const assertTenant = (session, allowUnset = false) => {
  ensure(
    String(session.tenantId) === '1' ||
      (allowUnset && !session.token && session.tenantId == null),
    'Refusing a session outside tenant 1; select tenant 1 in the local browser first'
  )
  ensure(
    session.visitTenantId == null || session.visitTenantId === '' ||
      String(session.visitTenantId) === '1',
    'Refusing a cross-tenant visit session'
  )
}
const verifySession = async (allowUnset = false) => {
  const session = await storedSession()
  assertTenant(session, allowUnset)
  return session
}
const recordViolation = (method, pathname, reason) => {
  report.safetyViolations.push({
    case: currentCase?.id || 'SETUP',
    step: currentStep?.name,
    method,
    pathname,
    reason
  })
}

// Browser interaction is always read-only. API fixture writes use a separate ownership gate.
const browserGuard = async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  const method = request.method()
  const isApi = url.pathname.includes('/admin-api/')
  const reject = async (reason) => {
    recordViolation(method, url.pathname, reason)
    await route.abort('blockedbyclient')
  }
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue()
  if (isApi) {
    if (
      url.hostname !== '127.0.0.1' ||
      ![new URL(apiBase).origin, new URL(webBase).origin].includes(url.origin)
    ) return reject('Non-local or unconfigured API destination')
    const headers = request.headers()
    const tenant = headers['tenant-id']
    const visit = headers['visit-tenant-id']
    if ((tenant != null && tenant !== '1') || (visit != null && visit !== '1')) {
      return reject('API request selected a tenant other than 1')
    }
    if (headers.authorization && tenant !== '1' &&
        !url.pathname.endsWith('/system/auth/refresh-token')) {
      return reject('Authenticated API request has no tenant-1 header')
    }
    try {
      await verifySession(loginInProgress)
    } catch (error) {
      return reject(safeMessage(error))
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue()
    const endpoint = url.pathname.slice(url.pathname.indexOf('/admin-api') + 10)
    if (
      method === 'POST' &&
      ((loginInProgress && [
        '/system/auth/login-encrypted',
        '/system/captcha/get',
        '/system/captcha/check'
      ].includes(endpoint)) || endpoint === '/system/auth/refresh-token')
    ) return route.continue()
    if (method === 'POST' && endpoint === '/crm/customer-cultivation/active-list') {
      try {
        const ids = request.postDataJSON()
        if (Array.isArray(ids) && ids.length <= 100 && ids.every(validId)) {
          return route.continue()
        }
      } catch {}
    }
    return reject('Browser-side write is not allowed, even with fixture permission')
  }
  if (request.isNavigationRequest() && request.frame() === page.mainFrame() &&
      url.origin !== new URL(webBase).origin) {
    return reject('Navigation outside the configured local Web origin')
  }
  if (['fetch', 'xhr'].includes(request.resourceType()) &&
      ![new URL(webBase).origin, new URL(apiBase).origin].includes(url.origin)) {
    return reject('External XHR/fetch is not allowed')
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return reject('Unrecognized non-API write')
  }
  return route.continue()
}

const authorizeFixtureWrite = (method, endpoint, data) => {
  ensure(allowFixtures, 'Read-only mode: select --allow-local-fixtures to create owned fixtures')
  assert.ok(userId && currentCase, 'Fixture writes require a verified user and running case')
  const prefixed = (value) => typeof value === 'string' && value.startsWith(`${runId}_`)
  const ownedCustomer = ownedCustomers.get(String(data?.id ?? data?.customerId))
  if (currentCase.id === 'PB049') {
    if (method === 'POST' && endpoint === '/crm/intention-rule/create' &&
        prefixed(data?.levelCode) && prefixed(data?.levelName) && data.id == null) return
    if (method === 'PUT' && endpoint === '/crm/intention-rule/update' &&
        ownedRules.has(String(data?.id)) &&
        ownedRules.get(String(data.id)) === data.levelCode) return
    if (method === 'PUT' && endpoint === '/crm/customer/update' &&
        ownedCustomer && ownedCustomer.name === data?.name && sameId(data.ownerUserId, userId) &&
        [...ownedRules.values()].includes(data.intentionLevel)) return
    if (method === 'POST' && endpoint === '/crm/customer-cultivation/complete-wake' &&
        ownedCustomer && sameId(ownedTasks.get(String(data.taskId)), data.customerId) &&
        prefixed(data.followNo) && prefixed(data.resultContent)) return
  }
  if (currentCase.id === 'PB049' &&
      method === 'POST' && endpoint === '/crm/customer/create' &&
      data?.id == null && prefixed(data?.name) && sameId(data.ownerUserId, userId) &&
      (!data.intentionLevel || [...ownedRules.values()].includes(data.intentionLevel))) return
  recordViolation(method, endpoint, 'Direct API write failed the owned-fixture allowlist')
  throw new Error(`Unsafe fixture write rejected: ${method} ${endpoint}`)
}

const request = async (method, pathname, data, { unauthenticated = false } = {}) => {
  const url = new URL(`${apiBase}/admin-api${pathname}`)
  assert.equal(url.origin, new URL(apiBase).origin)
  assert.ok(url.pathname.startsWith('/admin-api/'), 'API path must stay below /admin-api/')
  assert.equal(url.hostname, '127.0.0.1')
  const session = await verifySession(unauthenticated)
  if (!unauthenticated) ensure(session.token, 'Session expired; no repeated login per case')
  if (method !== 'GET') authorizeFixtureWrite(method, url.pathname.slice(10), data)
  const entry = {
    case: currentCase?.id || 'SETUP',
    step: currentStep?.name,
    method,
    pathname: url.pathname,
    at: new Date().toISOString()
  }
  report.requests.push(entry)
  try {
    const response = await page.request.fetch(url.href, {
      method,
      headers: {
        'tenant-id': '1',
        ...(session.token && !unauthenticated ? { Authorization: `Bearer ${session.token}` } : {})
      },
      ...(data === undefined ? {} : { data }),
      timeout: config.requestTimeoutMs,
      maxRedirects: 0
    })
    entry.httpStatus = response.status()
    const body = await response.json().catch(() => null)
    entry.code = body?.code
    return { status: response.status(), body }
  } catch (error) {
    entry.error = safeMessage(error)
    throw new Error(`${method} ${url.pathname}: ${entry.error}`)
  }
}
const successData = ({ status, body }, label) => {
  if ([401, 403, 404, 405, 501].includes(status) ||
      [401, 403, 404, 405, 501].includes(body?.code)) {
    throw new Blocked(`${label}: API unavailable/not authorized (HTTP ${status}, code ${body?.code})`)
  }
  assert.equal(status, 200, `${label}: HTTP ${status}`)
  assert.ok(body && [0, 200].includes(body.code) && body.success !== false,
    `${label}: code ${body?.code}, ${safeMessage(body?.msg || 'invalid response')}`)
  return body.data ?? body.result
}
const business = async (method, pathname, data) =>
  successData(await request(method, pathname, data), `${method} ${pathname.split('?')[0]}`)
const allPages = async (endpoint, params = {}) => {
  const rows = []
  for (let pageNo = 1; pageNo <= 100; pageNo++) {
    const result = await business('GET', query(endpoint, { ...params, pageNo, pageSize: 100 }))
    assert.ok(Array.isArray(result?.list), `${endpoint}: invalid page list`)
    assert.ok(Number.isFinite(Number(result.total)), `${endpoint}: missing total`)
    rows.push(...result.list)
    if (rows.length >= Number(result.total)) return rows
    assert.ok(result.list.length, `${endpoint}: empty page before total`)
  }
  throw new Blocked(`${endpoint}: more than 100 pages; not claiming complete coverage`)
}
const dictionary = async (dictType) => {
  const rows = await allPages('/system/dict-data/page', { dictType })
  assert.ok(rows.every((row) => row.dictType === dictType), 'Dictionary query returned another type')
  return rows.filter((row) => Number(row.status) === 0)
}
const requirePermissions = (...permissions) => {
  const granted = new Set(permissionInfo?.permissions || [])
  ensure(granted.has('*:*:*') || permissions.every((item) => granted.has(item)),
    `Current account needs permissions: ${permissions.join(', ')}`)
}
const nextFrame = () => page.evaluate(() =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const navigate = async (target) => {
  await verifySession()
  const destination = new URL(target, `${webBase}/`)
  ensure(destination.origin === new URL(webBase).origin, 'Only local routes are allowed')
  await page.waitForFunction(
    () => Boolean(document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router),
    undefined,
    { timeout: 30000 }
  )
  await page.evaluate(async (destination) => {
    await document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(destination)
  }, `${destination.pathname}${destination.search}${destination.hash}`)
  await waitForPageReady(page, 30000)
  await verifySession()
}
const discoverRoute = async (kind, value) => page.evaluate(({ kind, value }) => {
  const router = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router
  const routes = router?.getRoutes() || []
  const route = routes.find((item) => {
    if (item.path.includes(':') || item.redirect) return false
    if (kind === 'dict') return item.meta?.query?.dictType === value
    return item.path.endsWith('/crm/jixu/workbench') ||
      item.meta?.menuComponent === 'crm/jixu/workbench/index'
  })
  return route ? { path: route.path, title: route.meta?.title } : null
}, { kind, value })
const screenshot = async (name) => {
  await verifySession()
  const filename = path.join(outputDir, `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`)
  await page.screenshot({ path: filename, animations: 'disabled', timeout: 15000 })
  const evidence = { path: filename, url: page.url(), viewport: page.viewportSize() }
  currentCase?.screenshots.push(evidence)
  return evidence
}
const responsiveEvidence = async (name, surface, { dialog = false, focus } = {}) => {
  const evidence = []
  const issues = []
  try {
    for (const [label, viewport] of [['desktop', desktop], ['mobile', mobile]]) {
      await page.setViewportSize(viewport)
      await nextFrame()
      await surface.waitFor({ state: 'visible' })
      if (focus) await focus.scrollIntoViewIfNeeded()
      const image = await screenshot(`${name}-${label}`)
      const metrics = await surface.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const footer = element.querySelector('.el-dialog__footer')?.getBoundingClientRect()
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          width: rect.width, height: rect.height,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          footerBottom: footer?.bottom
        }
      })
      image.metrics = metrics
      evidence.push({ label, ...image, metrics })
      if (metrics.width <= 0 || metrics.left < -2 ||
          metrics.right > metrics.viewportWidth + 2) {
        issues.push(`${label}: surface extends outside the viewport`)
      }
      if (dialog && (metrics.top < -2 || metrics.bottom > metrics.viewportHeight + 2 ||
          metrics.footerBottom > metrics.viewportHeight + 2)) {
        issues.push(`${label}: dialog or footer is vertically clipped`)
      }
    }
  } finally {
    await page.setViewportSize(desktop)
    await nextFrame()
  }
  assert.equal(issues.length, 0, issues.join('; '))
  return evidence
}
const uiResponse = async (endpoint, params, action) => {
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' &&
        url.pathname === `/admin-api${endpoint}` &&
        Object.entries(params).every(([key, value]) => url.searchParams.get(key) === String(value))
    }, { timeout: 30000 }),
    action()
  ])
  return successData({
    status: response.status(),
    body: await response.json().catch(() => null)
  }, `UI GET ${endpoint}`)
}
const formItem = (container, label) =>
  container.locator('.el-form-item').filter({
    has: page.locator('.el-form-item__label').filter({
      hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
    })
  })
const closeRuleDialog = async (dialog) => {
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  const confirmation = page.locator('.el-message-box:visible')
  const state = await Promise.race([
    dialog.waitFor({ state: 'hidden' }).then(() => 'closed'),
    confirmation.waitFor({ state: 'visible' }).then(() => 'confirm')
  ])
  if (state === 'confirm') {
    await confirmation.getByRole('button', { name: /^(确定|确 定)$/ }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
}
const check = async (name, action) => {
  const item = { name, status: 'RUNNING', startedAt: new Date().toISOString() }
  currentCase.steps.push(item)
  currentStep = item
  await checkpoint()
  try {
    item.evidence = await action()
    item.status = 'PASS'
    return item.evidence
  } catch (error) {
    item.status = error instanceof Blocked ? 'BLOCKED' : 'FAIL'
    item.error = safeMessage(error)
    throw error
  } finally {
    item.finishedAt = new Date().toISOString()
    currentStep = undefined
    await checkpoint()
  }
}
const runCase = async (id, action) => {
  const item = {
    id, status: 'RUNNING', startedAt: new Date().toISOString(),
    steps: [], screenshots: []
  }
  report.results.push(item)
  currentCase = item
  const errorCount = report.pageErrors.length
  const violationCount = report.safetyViolations.length
  try {
    await verifySession()
    await page.setViewportSize(desktop)
    await action()
    assert.equal(report.pageErrors.length, errorCount, 'New browser runtime errors; see pageErrors')
    assert.equal(report.safetyViolations.length, violationCount,
      'Browser/API safety guard rejected requests; see safetyViolations')
    item.status = 'PASS'
  } catch (error) {
    item.status = error instanceof Blocked ? 'BLOCKED' : 'FAIL'
    item.error = safeMessage(error)
    if (report.pageErrors.length > errorCount ||
        report.safetyViolations.length > violationCount) item.status = 'FAIL'
    await screenshot(`${id}-stopped`).catch(() => {})
  } finally {
    item.finishedAt = new Date().toISOString()
    currentCase = undefined
    await checkpoint()
    console.log(`${item.status}: ${id}${item.error ? ` - ${item.error}` : ''}`)
  }
}

const typeRuleCase = async (id, dictType, endpoint, codeField) => {
  const gaps = []
  const types = await check('Read authoritative dictionary and locate existing versions', async () => {
    requirePermissions('system:dict:query')
    const types = await dictionary(dictType)
    ensure(types.length, `No enabled dictionary values for ${dictType}; no fixtures will be invented`)
    let selected = types[0]
    for (const type of types) {
      const versionPage = await business('GET', query(`${endpoint}/page`, {
        [codeField]: type.value, orgId: 0, pageNo: 1, pageSize: 100
      }))
      assert.ok(Array.isArray(versionPage?.list), 'Invalid rule-version page')
      if (versionPage.list.length) {
        selected = type
        break
      }
    }
    return { dictType, selected: { label: selected.label, value: selected.value } }
  })
  const selected = types.selected
  let dialog
  const orgScope = { [codeField]: selected.value, orgId: 0 }
  await check('Open the real dictionary page and business-rule version table', async () => {
    const discovered = await discoverRoute('dict', dictType)
    const route = discovered?.path || `/system/dict/type/data/${encodeURIComponent(dictType)}`
    await navigate(route)
    const filter = page.locator('.el-form').filter({
      has: page.getByPlaceholder(/请输入名称|请输入字典标签/)
    }).first()
    await filter.getByPlaceholder(/请输入名称|请输入字典标签/).fill(selected.label)
    await uiResponse('/system/dict-data/page', { dictType }, () =>
      filter.getByRole('button', { name: '搜索', exact: true }).click())
    await waitForPageReady(page, 30000)
    const row = page.locator('.el-table__body-wrapper .el-table__row').filter({
      has: page.getByText(String(selected.value), { exact: true })
    }).filter({ hasText: selected.label }).first()
    await row.getByRole('button', { name: '业务规则', exact: true }).waitFor()
    const versionPage = await uiResponse(`${endpoint}/page`, orgScope, () =>
      row.getByRole('button', { name: '业务规则', exact: true }).click())
    dialog = page.getByRole('dialog', {
      name: `${id === 'PB041' ? '销售类型' : '计划类型'}业务规则 - ${selected.label}`,
      exact: true
    })
    await dialog.waitFor()
    await waitForPageReady(page, 30000)
    for (const column of ['版本', '状态', '生效日期', '失效日期', '维护说明', '操作']) {
      await dialog.getByRole('columnheader', { name: column, exact: true }).waitFor()
    }
    const rows = dialog.locator('.el-table__body-wrapper .el-table__row')
    assert.equal(await rows.count(), versionPage.list.length)
    assert.equal(await formItem(dialog, id === 'PB041' ? '销售类型编码' : '计划类型编码')
      .locator('input').inputValue(), String(selected.value))
    const images = await responsiveEvidence(`${id}-rule-versions`, dialog, { dialog: true })
    if (!versionPage.list.length) {
      gaps.push(`No existing all-organization rule versions for ${dictType}/${selected.value}`)
    } else {
      const first = versionPage.list[0]
      assert.ok((await rows.first().innerText()).includes(String(first.versionNo)),
        'Version number is missing from the rendered version row')
      const detail = await uiResponse(`${endpoint}/get`, { id: first.id }, () =>
        rows.first().getByRole('button', { name: '查看', exact: true }).click())
      assert.ok(sameId(detail.id, first.id))
      assert.equal(String(detail[codeField]), String(selected.value))
      assert.equal(String(detail.orgId ?? 0), '0')
      if (id === 'PB041') {
        assert.equal(await formItem(dialog, '统计分类').locator('input').inputValue(),
          detail.statisticsBasis || '')
      }
    }
    return {
      route, discoveredFromExistingRoutes: Boolean(discovered),
      dictionaryValue: selected.value, totalVersions: versionPage.total,
      displayedVersions: versionPage.list.map((item) => ({
        id: item.id, versionNo: item.versionNo, orgId: item.orgId
      })),
      screenshots: images
    }
  })
  await check('Choose an existing organization without saving', async () => {
    const depts = await business('GET', '/system/dept/simple-list')
    assert.ok(Array.isArray(depts), 'Invalid organization options')
    const department = depts.find((item) => validId(item.id) && item.name)
    if (!department) {
      gaps.push('No real organization option; only the all-organization option can be displayed')
      return { selected: false, reason: gaps.at(-1) }
    }
    const selector = formItem(dialog, '适用组织').locator('.el-select')
    await selector.click()
    const popper = page.locator('.el-select__popper:visible').last()
    const node = popper.locator('.el-tree-node__content').filter({
      has: page.getByText(department.name, { exact: true })
    }).first()
    const scopedPage = await uiResponse(`${endpoint}/page`, {
      [codeField]: selected.value, orgId: department.id
    }, () => node.click())
    await waitForPageReady(page, 30000)
    assert.ok(scopedPage.list.every((item) =>
      sameId(item.orgId, department.id) && String(item[codeField]) === String(selected.value)))
    const image = await screenshot(`${id}-organization`)
    await selector.click()
    await uiResponse(`${endpoint}/page`, orgScope, () =>
      page.locator('.el-select__popper:visible').last()
        .getByText('全部组织', { exact: true }).click())
    await waitForPageReady(page, 30000)
    return { organizationId: department.id, scopedVersionCount: scopedPage.total, screenshot: image }
  })
  await check('Choose a published approval process, capture both viewports and discard', async () => {
    const definitions = await business('GET', '/bpm/process-definition/simple-list')
    assert.ok(Array.isArray(definitions), 'Invalid approval-process options')
    const definition = definitions.find((item) => item.key && item.name)
    const selector = formItem(dialog, '审批流程快照').locator('.el-select')
    const disabled = await selector.locator('input').first().isDisabled()
    if (!definition || disabled) {
      gaps.push(!definition
        ? 'No published approval process available for a real selection'
        : 'Approval-process selector disabled (check query/update permissions and option errors)')
    } else {
      await selector.scrollIntoViewIfNeeded()
      await selector.click()
      const option = page.getByRole('option', { name: definition.name, exact: true }).first()
      await option.waitFor()
      await screenshot(`${id}-approval-options`)
      await option.click()
      assert.ok((await formItem(dialog, '审批流程快照').innerText()).includes(definition.name))
    }
    const images = await responsiveEvidence(`${id}-approval-selection`, dialog, { dialog: true })
    const alerts = await dialog.locator('.el-alert').allTextContents()
    assert.ok(!alerts.some((text) => /失败|错误/.test(text)), alerts.join('; '))
    await closeRuleDialog(dialog)
    assert.ok(!report.requests.some((entry) =>
      entry.case === id && entry.method !== 'GET'), 'Dictionary cases must not write')
    return {
      processKey: definition?.key, selected: Boolean(definition && !disabled),
      saved: false, alerts, screenshots: images
    }
  })
  ensure(gaps.length === 0, gaps.join('; '))
}

const formatLocal = (date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date)
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`
}
const afterDays = (days) => formatLocal(new Date(Date.now() + days * 86400000))
const dateOnly = (value) => {
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-')
  }
  if (typeof value === 'number') return formatLocal(new Date(value)).slice(0, 10)
  return String(value || '').slice(0, 10)
}
const eventually = async (label, read, accepts) => {
  const deadline = Date.now() + 15000
  do {
    const value = await read()
    if (accepts(value)) return value
    await delay(350)
  } while (Date.now() < deadline)
  throw new Error(`${label}: expected state not observed within 15 seconds`)
}
const createCustomer = async (suffix, fields = {}) => {
  const data = { name: `${runId}_${suffix}`, ownerUserId: userId, remark: runId, ...fields }
  const fixture = { kind: 'customer', name: data.name, id: null }
  report.fixtures.push(fixture)
  const id = requireId(await business('POST', '/crm/customer/create', data), 'Created customer')
  fixture.id = id
  ownedCustomers.set(String(id), { ...data, id })
  await checkpoint()
  const persisted = await business('GET', query('/crm/customer/get', { id }))
  assert.equal(persisted.name, data.name)
  assert.ok(sameId(persisted.ownerUserId, userId))
  return { ...data, id }
}
const wakeTasks = async (customerId) => {
  assert.ok(ownedCustomers.has(String(customerId)))
  const tasks = await allPages('/crm/customer-cultivation/wake-task/page', { customerId })
  for (const task of tasks) {
    assert.ok(sameId(task.customerId, customerId), 'Task page returned another customer')
    assert.ok(sameId(task.ownerUserId, userId), 'Owned fixture task has another owner')
    if (task.taskType === 'INTENTION') {
      ownedTasks.set(String(task.id), customerId)
      const fixture = report.fixtures.find((item) =>
        item.kind === 'intention-task' && sameId(item.id, task.id))
      const state = { kind: 'intention-task', id: task.id, ...taskSnapshot(task) }
      if (fixture) Object.assign(fixture, state)
      else report.fixtures.push(state)
    }
  }
  return tasks
}
const followRecords = (customerId) =>
  allPages('/crm/follow-up-record/page', { bizType: 2, bizId: customerId })
const taskSnapshot = (task) => ({
  id: task.id, taskType: task.taskType, status: task.status,
  customerId: task.customerId, ownerUserId: task.ownerUserId,
  ruleLevelCode: task.ruleLevelCode, ruleVersion: task.ruleVersion,
  deadline: task.deadline, plannedFollowDate: task.plannedFollowDate,
  followRecordId: task.followRecordId ?? null
})
const identityList = (items) => items.map((item) => String(item.id)).sort()
const expectRejection = async (method, endpoint, data, expectedCode) => {
  const response = await request(method, endpoint, data)
  assert.ok([200, 400].includes(response.status), `${endpoint}: unexpected HTTP ${response.status}`)
  assert.equal(response.body?.code, expectedCode,
    `${endpoint}: expected domain rejection ${expectedCode}, got ${response.body?.code}`)
  return { httpStatus: response.status, code: response.body.code }
}
const workbenchEvidence = async (customer) => {
  const discovered = await discoverRoute('workbench')
  const route = discovered?.path || '/crm/jixu/workbench'
  await navigate(route)
  // A borrowed tab may already cache this view. Reload once, retaining the same login/session.
  await uiResponse('/crm/customer-cultivation/wake-task/page', { status: '待执行' }, () =>
    page.reload({ waitUntil: 'domcontentloaded' }))
  const surface = page.locator('.jx-workbench')
  await surface.waitFor()
  await surface.locator('.task-category-card').filter({ hasText: '待办任务' }).click()
  const title = `${customer.name} 周期跟进`
  const pagination = surface.locator('.todo-center-card .el-pagination')
  let found
  let visitedPages = 0
  while (visitedPages++ < 500) {
    await nextFrame()
    const row = surface.locator('.task-table .el-table__row').filter({ hasText: title }).first()
    if (await row.count()) {
      found = row
      break
    }
    const next = pagination.locator('.btn-next')
    if (!(await next.count()) || await next.isDisabled()) break
    const previous = await pagination.locator('.number.is-active').innerText()
    await next.click()
    await page.waitForFunction(({ selector, previous }) =>
      document.querySelector(selector)?.textContent?.trim() !== previous,
    { selector: '.todo-center-card .el-pagination .number.is-active', previous })
  }
  assert.ok(found, `Workbench did not render owned task "${title}" (visited ${visitedPages} pages)`)
  await found.getByRole('button', { name: '处理', exact: true }).waitFor()
  await found.scrollIntoViewIfNeeded()
  return {
    route, customerId: customer.id, title, visitedPages,
    screenshots: await responsiveEvidence('PB049-workbench', surface, { focus: found })
  }
}

const intentionCase = async () => {
  ensure(allowFixtures, 'PB049 requires --allow-local-fixtures; nothing was written')
  const followType = await check('Check permissions and a real attachment-free follow-up method', async () => {
    requirePermissions(
      'crm:intention-rule:query', 'crm:intention-rule:update',
      'crm:customer:create', 'crm:customer:query', 'crm:customer:update',
      'crm:follow-up-record:query', 'crm:follow-up-type-rule:query'
    )
    const dict = await dictionary('crm_follow_up_type')
    const rules = await business('GET', '/crm/follow-up-type-rule/list')
    assert.ok(Array.isArray(rules), 'Invalid follow-up method rules')
    const method = dict.find((item) => {
      if (!/^[1-9]\d*$/.test(String(item.value))) return false
      const rule = rules.find((rule) => Number(rule.dictValue) === Number(item.value))
      return !rule || Number(rule.status) !== 1 || rule.requireAttachment !== true
    })
    ensure(method, 'No enabled attachment-free follow-up method; do not invent attachment URLs')
    return { value: Number(method.value), label: method.label }
  })
  let rule
  await check('Create an owned intention rule and verify the server-assigned version', async () => {
    const payload = {
      levelCode: `${runId}_PB049`, levelName: `${runId}_intention`,
      followUpDays: 2, warnDays: 0, recycleGraceDays: 30, status: 1, remark: runId
    }
    const fixture = { kind: 'intention-rule', levelCode: payload.levelCode, id: null }
    report.fixtures.push(fixture)
    const id = requireId(await business('POST', '/crm/intention-rule/create', payload), 'Created rule')
    fixture.id = id
    ownedRules.set(String(id), payload.levelCode)
    rule = await business('GET', query('/crm/intention-rule/get', { id }))
    assert.equal(Number(rule.versionNo), 1)
    assert.equal(rule.levelCode, payload.levelCode)
    return { id, levelCode: rule.levelCode, versionNo: rule.versionNo }
  })
  let customer
  let originalTask
  await check('Create an owned customer and observe its generated INTENTION task', async () => {
    customer = await createCustomer('PB049_customer', {
      intentionLevel: rule.levelCode, contactNextTime: afterDays(1)
    })
    const tasks = await eventually('Initial task generation', () => wakeTasks(customer.id),
      (items) => items.some((item) => item.taskType === 'INTENTION' && item.status === '待执行'))
    const pending = tasks.filter((item) => item.taskType === 'INTENTION' && item.status === '待执行')
    assert.equal(pending.length, 1, 'Only one pending task is allowed per cycle')
    originalTask = pending[0]
    assert.equal(originalTask.ruleLevelCode, rule.levelCode)
    assert.equal(Number(originalTask.ruleVersion), 1)
    assert.equal(dateOnly(originalTask.plannedFollowDate), dateOnly(customer.contactNextTime))
    assert.equal((await followRecords(customer.id)).length, 0,
      'Planning a task must not create a formal follow-up record')
    return { customerId: customer.id, customerName: customer.name, task: taskSnapshot(originalTask) }
  })
  await check('Upgrade only the owned rule; re-save the same cycle without rewriting its snapshot', async () => {
    await business('PUT', '/crm/intention-rule/update', {
      id: rule.id, levelCode: rule.levelCode, levelName: rule.levelName,
      followUpDays: 5, warnDays: 0, recycleGraceDays: 30, status: 1,
      remark: `${runId}_version_2`
    })
    const latest = await business('GET', query('/crm/intention-rule/get', { id: rule.id }))
    assert.equal(Number(latest.versionNo), 2, 'Rule version must be assigned by the server')
    const immediatelyAfter = await wakeTasks(customer.id)
    assert.deepEqual(taskSnapshot(immediatelyAfter.find((task) => sameId(task.id, originalTask.id))),
      taskSnapshot(originalTask), 'Rule update rewrote an already generated task')
    await business('PUT', '/crm/customer/update', { ...customer, remark: `${runId}_same_cycle` })
    const afterSync = await wakeTasks(customer.id)
    const pending = afterSync.filter((item) => item.status === '待执行')
    assert.equal(pending.length, 1)
    assert.deepEqual(taskSnapshot(pending[0]), taskSnapshot(originalTask),
      'Same-cycle synchronization must preserve the original rule-version snapshot')
    assert.equal((await followRecords(customer.id)).length, 0)
    rule = latest
    return { newRuleVersion: rule.versionNo, preservedTask: taskSnapshot(pending[0]) }
  })
  const complete = {
    taskId: originalTask.id, customerId: customer.id, resultType: '完成跟进',
    resultContent: `${runId}_actual_follow_up`,
    followNo: `${runId}_follow`, contactPerson: `${runId}_contact`,
    communicationMethod: followType.label, followUpType: followType.value,
    fileUrls: [], picUrls: [], customerFeedback: `${runId}_feedback`,
    planContent: `${runId}_current_plan`, achieved: false,
    nextFollowTime: afterDays(3), nextPlanContent: `${runId}_next_plan`
  }
  let recordId
  let nextTask
  await check('Complete the owned task, verify a formal record and next-version task', async () => {
    recordId = requireId(
      await business('POST', '/crm/customer-cultivation/complete-wake', complete),
      'Formal follow-up record'
    )
    report.fixtures.push({ kind: 'follow-up-record', id: recordId, customerId: customer.id })
    const tasks = await eventually('Next intention task', () => wakeTasks(customer.id),
      (items) => items.some((task) =>
        task.status === '待执行' && !sameId(task.id, originalTask.id)))
    const completed = tasks.find((task) => sameId(task.id, originalTask.id))
    assert.equal(completed.status, '已完成')
    assert.ok(sameId(completed.followRecordId, recordId))
    const pending = tasks.filter((task) => task.taskType === 'INTENTION' && task.status === '待执行')
    assert.equal(pending.length, 1)
    nextTask = pending[0]
    assert.equal(Number(nextTask.ruleVersion), 2)
    assert.equal(nextTask.ruleLevelCode, rule.levelCode)
    assert.equal(dateOnly(nextTask.plannedFollowDate), dateOnly(complete.nextFollowTime))
    const record = await business('GET', query('/crm/follow-up-record/get', { id: recordId }))
    assert.equal(Number(record.bizType), 2)
    assert.ok(sameId(record.bizId, customer.id))
    assert.ok(sameId(record.sourceTaskId, originalTask.id))
    assert.equal(record.content, complete.resultContent)
    assert.equal(record.intentionLevelCode, originalTask.ruleLevelCode)
    assert.equal(Number(record.intentionRuleVersion), 1)
    assert.equal(dateOnly(record.plannedFollowDate), dateOnly(originalTask.plannedFollowDate))
    const records = await followRecords(customer.id)
    assert.deepEqual(identityList(records), [String(recordId)])
    return {
      completedTask: taskSnapshot(completed), nextTask: taskSnapshot(nextTask),
      formalRecord: {
        id: record.id, sourceTaskId: record.sourceTaskId,
        intentionRuleVersion: record.intentionRuleVersion, plannedFollowDate: record.plannedFollowDate
      }
    }
  })
  await check('Reject duplicate completion without another record or task', async () => {
    const beforeTasks = await wakeTasks(customer.id)
    const beforeRecords = await followRecords(customer.id)
    const rejection = await expectRejection(
      'POST', '/crm/customer-cultivation/complete-wake', complete, 1020015005
    )
    const afterTasks = await wakeTasks(customer.id)
    const stableSnapshots = (items) => items.map(taskSnapshot)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    assert.deepEqual(stableSnapshots(afterTasks), stableSnapshots(beforeTasks))
    assert.deepEqual(identityList(await followRecords(customer.id)), identityList(beforeRecords))
    return { ...rejection, recordId, nextTaskId: nextTask.id, noAdditionalWritesObserved: true }
  })
  await check('Render the retained owned pending task in the real workbench', () =>
    workbenchEvidence(customer))
}

const setup = async () => {
  for (const arg of args) {
    ensure(['--allow-local-fixtures', '--keep-page'].includes(arg) ||
      arg.startsWith('--case=') || arg.startsWith('--out='), `Unknown argument: ${arg}`)
  }
  ensure(selectedCases.every((item) => selectableCases.includes(item)),
    `Supported cases: ${selectableCases.join(', ')}`)
  const web = localUrl(webBase, 'CFOR_WEB_BASE')
  const api = localUrl(apiBase, 'CFOR_API_BASE')
  const cdp = localUrl(cdpBase, 'CFOR_CDP_URL')
  ensure(web.pathname === '/' && api.pathname === '/' && cdp.pathname === '/',
    'Web, API and CDP bases must be origin URLs')
  ensure(String(config.tenantId) === '1', 'CFOR_TENANT_ID must be exactly 1')
  report.environment = { webBase, apiBase, cdpBase }
  try {
    browser = await chromium.connectOverCDP(cdp.href, { timeout: 15000 })
  } catch (error) {
    throw new Blocked(`Existing local CDP browser unavailable: ${safeMessage(error)}`)
  }
  const candidates = browser.contexts().flatMap((context) => context.pages())
    .filter((candidate) => {
      try {
        return !candidate.isClosed() && new URL(candidate.url()).origin === web.origin
      } catch {
        return false
      }
    })
  ensure(candidates.length,
    `Open a tab at ${webBase} in the existing CDP browser; this runner does not create/close user tabs`)
  const usable = []
  for (const candidate of candidates) {
    const raw = await candidate.evaluate(() => ({
      token: localStorage.getItem('ACCESS_TOKEN'),
      tenantId: localStorage.getItem('tenantId'),
      visitTenantId: localStorage.getItem('visitTenantId')
    })).catch(() => null)
    if (!raw) continue
    const session = Object.fromEntries(Object.entries(raw)
      .map(([key, value]) => [key, unwrapWebStorageValue(value)]))
    try {
      assertTenant(session, true)
      usable.push({ candidate, authenticated: Boolean(session.token) })
    } catch {}
  }
  ensure(usable.length, 'No existing local tab has a safe tenant-1 session; no tenant switching attempted')
  page = (usable.find((item) => item.authenticated) || usable[0]).candidate
  originalUrl = page.url()
  originalViewport = page.viewportSize()
  page.setDefaultTimeout(15000)
  page.setDefaultNavigationTimeout(45000)
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  page.on('response', onResponse)
  await page.route('**/*', browserGuard)
  guardInstalled = true
  await page.bringToFront()
  const session = await verifySession(true)
  let permission = session.token
    ? await request('GET', '/system/auth/get-permission-info')
    : { status: 401, body: { code: 401 } }
  if (permission.status === 401 || permission.body?.code === 401) {
    ensure(config.username && config.password && config.tenantName,
      'Session missing/expired: set CFOR_TENANT_NAME/CFOR_USERNAME/CFOR_PASSWORD for one UI login')
    const tenant = successData(
      await request('GET', query('/system/tenant/get-id-by-name', { name: config.tenantName }),
        undefined, { unauthenticated: true }),
      'Resolve login tenant'
    )
    ensure(String(tenant?.id ?? tenant?.tenantId ?? tenant) === '1',
      'Configured login tenant name does not resolve to tenant 1')
    const environment = loadEnv('env.local', repoRoot, 'VITE_APP_API_ENCRYPT')
    process.env.CFOR_API_ENCRYPT_RESPONSE_KEY ||= environment.VITE_APP_API_ENCRYPT_RESPONSE_KEY
    loginAttempts++
    loginInProgress = true
    try {
      if (session.token) {
        await page.evaluate(() => {
          localStorage.removeItem('ACCESS_TOKEN')
          localStorage.removeItem('REFRESH_TOKEN')
        })
      }
      await loginWithCredentials(page)
    } finally {
      loginInProgress = false
    }
    await verifySession()
    permission = await request('GET', '/system/auth/get-permission-info')
  }
  permissionInfo = successData(permission, 'Verify reused/login session')
  userId = requireId(permissionInfo?.user?.id, 'Authenticated user')
  if (permissionInfo.user.tenantId != null) {
    ensure(String(permissionInfo.user.tenantId) === '1', 'Authenticated user is not in tenant 1')
  }
  await page.waitForFunction(
    () => Boolean(document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router),
    undefined, { timeout: 30000 }
  )
  ensure(report.safetyViolations.length === 0, 'Setup triggered the safety guard; inspect result.json')
  assert.equal(report.pageErrors.length, 0, 'Browser runtime errors during setup; see pageErrors')
  report.session = { reusedContext: true, reusedPage: true, reusedToken: loginAttempts === 0,
    loginAttempts, userId, tenantId: '1' }
}
const onPageError = (error) => report.pageErrors.push({
  case: currentCase?.id || 'SETUP', step: currentStep?.name, message: safeMessage(error)
})
const onConsole = (message) => {
  if (message.type() === 'error') report.consoleErrors.push({
    case: currentCase?.id || 'SETUP', message: safeMessage(message.text())
  })
}
const onResponse = (response) => {
  const url = new URL(response.url())
  if (url.pathname.includes('/admin-api/') && response.status() >= 400) {
    report.uiHttpErrors.push({
      case: currentCase?.id || 'SETUP',
      method: response.request().method(), pathname: url.pathname, status: response.status()
    })
  }
}
const actions = {
  PB041: () => typeRuleCase('PB041', 'erp_sale_type', '/erp/sale-type-rule', 'saleTypeCode'),
  PB043: () => typeRuleCase('PB043', 'crm_sales_plan_type', '/crm/sales-plan-type-rule', 'planTypeCode'),
  PB049: intentionCase,
  PB051: async () => {
    throw new Blocked('NOT EXECUTED: PB051 deferred by the current test scope; no business fixtures/writes')
  }
}

await mkdir(outputDir, { recursive: true })
await checkpoint()
let exitCode = 2
try {
  await setup()
  report.setup = { status: 'PASS' }
  for (const id of selectedCases) await runCase(id, actions[id])
} catch (error) {
  report.setup = { status: error instanceof Blocked ? 'BLOCKED' : 'FAIL', error: safeMessage(error) }
  for (const id of selectedCases) {
    if (!report.results.some((item) => item.id === id)) {
      report.results.push({ id, status: 'BLOCKED', error: `Setup incomplete: ${safeMessage(error)}`,
        steps: [], screenshots: [] })
    }
  }
  console.error(`${report.setup.status}: ${safeMessage(error)}`)
} finally {
  if (page && !page.isClosed()) {
    try {
      if (!keepPage && guardInstalled) {
        await verifySession()
        await navigate(originalUrl)
        if (originalViewport) {
          await page.setViewportSize(originalViewport)
        } else {
          const session = await page.context().newCDPSession(page)
          try {
            await session.send('Emulation.clearDeviceMetricsOverride')
          } finally {
            await session.detach()
          }
        }
      }
    } catch (error) {
      report.restoreWarning = safeMessage(error)
    }
    if (guardInstalled) await page.unroute('**/*', browserGuard).catch(() => {})
    page.off('pageerror', onPageError)
    page.off('console', onConsole)
    page.off('response', onResponse)
  }
  report.finishedAt = new Date().toISOString()
  report.summary = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED']
    .map((status) => [status, report.results.filter((item) => item.status === status).length]))
  exitCode = report.setup?.status === 'FAIL' || report.summary.FAIL ||
    report.safetyViolations.length ? 1 : report.summary.BLOCKED ? 2 : 0
  report.exitCode = exitCode
  await checkpoint()
  console.log(`${JSON.stringify(report.summary)}\nEvidence: ${path.join(outputDir, 'result.json')}`)
}
// CDP is a borrowed connection. Exiting disconnects the client without closing Chrome or its tabs.
process.exit(exitCode)
