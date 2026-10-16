#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const usage = `PB006 local masked amount editing regression

Run only after the rebuilt local backend is running:
  CFOR_WEB_BASE=http://127.0.0.1:9160 \\
  CFOR_API_BASE=http://127.0.0.1:48083 \\
  CFOR_TENANT_ID=1 \\
  node scripts/e2e/pb006-masked-amount-edit.browser.mjs --keep-page

Uses an existing local administrator CDP tab, or CFOR_USERNAME/CFOR_PASSWORD.
CFOR_CDP_URL defaults to http://127.0.0.1:9222.
CFOR_PB006_OUT optionally changes the report directory.
--keep-page retains the isolated browser context; fixture cleanup still runs.
--self-test validates pure guards and assertions without a browser or API.
`

class CheckError extends Error {
  constructor(message, blocked = false) {
    super(message)
    this.name = 'CheckError'
    this.blocked = blocked
  }
}

const check = (condition, message) => {
  if (!condition) throw new CheckError(message)
}
const requireFixture = (condition, message) => {
  if (!condition) throw new CheckError(message, true)
}
const localUrl = (value, label, api = false) => {
  requireFixture(Boolean(value), `Explicit ${label} is required`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new CheckError(`Invalid ${label}`, true)
  }
  requireFixture(
    ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['/', '', ...(api ? ['/admin-api', '/admin-api/'] : [])].includes(url.pathname),
    `${label} must be a localhost/127.0.0.1 base URL without credentials or query`
  )
  return url.origin
}
const endpoint = (pathname) => {
  check(/^\/[a-zA-Z0-9/-]+(?:\?[^#]*)?$/.test(pathname), 'API path must be relative to admin-api')
  return pathname.split('?')[0]
}
const success = ({ status, payload }) =>
  status >= 200 &&
  status < 300 &&
  (payload?.code === 0 || (payload?.code === 200 && payload?.success === true))
const unwrap = (payload) => payload?.data ?? payload?.result
const rows = (value) =>
  Array.isArray(value)
    ? value
    : Array.isArray(value?.list)
      ? value.list
      : Array.isArray(value?.records)
        ? value.records
        : []
const flatten = (nodes) => rows(nodes).flatMap((node) => [node, ...flatten(node.children)])
const pick = (object, keys) =>
  Object.fromEntries(
    keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]])
  )
const moneyKeys = [
  'productPrice',
  'productTaxPrice',
  'totalPrice',
  'totalProductPrice',
  'productTotalPrice',
  'totalTaxPrice',
  'taxPrice',
  'depositPrice',
  'discountPrice',
  'otherPrice'
]
const finite = (value) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
const closeNumber = (left, right) =>
  finite(left) && finite(right) && Math.abs(Number(left) - Number(right)) < 0.011
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100
const numericProjection = (document) => ({
  ...pick(document, [
    ...moneyKeys,
    'discountPercent',
    'remark',
    'totalCount',
    'status',
    'billStage'
  ]),
  items: document.items.map((item) => ({
    ...pick(item, [
      'id',
      'productId',
      'productUnitId',
      'warehouseId',
      'orderItemId',
      'count',
      'remark',
      'taxPercent',
      ...moneyKeys
    ])
  }))
})
const sameDocument = (left, right) =>
  JSON.stringify(numericProjection(left)) === JSON.stringify(numericProjection(right))
const safeError = (error) =>
  error instanceof CheckError
    ? error.message
    : `${error?.name || 'Error'}; raw exception omitted to protect credentials and financial data`

function assertMasked(document) {
  check(
    document && Array.isArray(document.items) && document.items.length === 1,
    'One real item is required'
  )
  check(document.totalPrice === null, 'Document total must be masked as null in the API')
  for (const item of document.items) {
    check(item.id && finite(item.count), 'Masked detail must retain the item ID and quantity')
    check(
      item.productPrice === null && item.totalPrice === null,
      'Item price and amount must be masked as null'
    )
  }
  for (const object of [document, ...document.items]) {
    for (const key of moneyKeys) {
      if (key in object) check(object[key] === null, `Sensitive field ${key} must be null`)
    }
  }
}

function assertDraft(kind, document) {
  check(
    document && document.id && document.items?.length === 1,
    'Fixture detail must contain a real persisted item'
  )
  check(
    !document.processInstanceId && !document.bpmiInstanceId,
    'Fixture must not start an approval process'
  )
  if (kind === 'sale') {
    check(Number(document.isEffective || 0) === 0, 'Sale fixture must remain ineffective')
    check(
      [12, 14].includes(Number(document.billStage)),
      'Sale fixture must remain in an editable preparation stage'
    )
    check(
      [
        document.outCount,
        document.afterSaveCount,
        ...document.items.flatMap((item) => [item.outCount, item.afterSaveCount])
      ].every((value) => !value || Number(value) === 0),
      'Sale fixture must have no downstream execution'
    )
  } else {
    check(
      document.businessType === 'OPENING' && !document.orderId,
      'Purchase fixture must be independent OPENING data'
    )
    check(Number(document.status) !== 20, 'Purchase fixture must remain unapproved')
  }
}

function assertAmounts(kind, baseline, actual, quantity, remark = baseline.remark) {
  assertDraft(kind, actual)
  const oldItem = baseline.items[0]
  const item = actual.items[0]
  check(String(item.id) === String(oldItem.id), 'Saving must retain the original item ID')
  check(closeNumber(item.count, quantity), 'Saved quantity must match the requested quantity')
  check(actual.remark === remark, 'Saved document remark must match')
  check(
    closeNumber(item.productPrice, oldItem.productPrice),
    'Original unit price must be preserved'
  )
  check(closeNumber(item.taxPercent, oldItem.taxPercent), 'Original tax rate must be preserved')
  check(
    closeNumber(actual.discountPercent, baseline.discountPercent),
    'Original discount rate must be preserved'
  )
  const net = round(Number(oldItem.productPrice) * quantity)
  const tax = round((net * Number(oldItem.taxPercent)) / 100)
  const gross = round(net + tax)
  const discount = round((gross * Number(baseline.discountPercent)) / 100)
  const expectedTotal = round(gross - discount + Number(baseline.otherPrice || 0))
  check(closeNumber(item.taxPrice, tax), 'Item tax must be correctly recalculated')
  check(
    closeNumber(item.totalPrice, kind === 'sale' ? gross : net),
    'Item amount must be correctly recalculated'
  )
  check(
    closeNumber(actual.totalCount, quantity),
    'Document quantity must be correctly recalculated'
  )
  check(
    closeNumber(actual.totalPrice, expectedTotal),
    'Document amount must be correctly recalculated'
  )
  for (const key of kind === 'sale' ? ['depositPrice'] : ['otherPrice']) {
    check(closeNumber(actual[key], baseline[key]), `Original ${key} must be preserved`)
  }
}

const permitted = new Set([
  'erp:sale-order:query',
  'erp:sale-order:update',
  'erp:purchase-in:query',
  'erp:purchase-in:update'
])
const editPermissions = ['erp:sale-order:update', 'erp:purchase-in:update']

function selectMenus(allMenus, tenantMenus) {
  const available = new Set(flatten(tenantMenus).map((menu) => String(menu.id)))
  const all = flatten(allMenus).filter((menu) => available.has(String(menu.id)))
  const byId = new Map(all.map((menu) => [String(menu.id), menu]))
  const selected = new Map()
  for (const permission of permitted) {
    const matches = all.filter(
      (menu) => menu.permission === permission && Number(menu.status) === 0
    )
    requireFixture(matches.length > 0, `Tenant package is missing ${permission}`)
    for (const menu of matches) {
      let current = menu
      const seen = new Set()
      while (current) {
        requireFixture(!seen.has(String(current.id)), 'Menu ancestors contain a cycle')
        seen.add(String(current.id))
        requireFixture(
          !current.permission || permitted.has(current.permission),
          'A menu ancestor requires an additional permission; review the minimum role before running'
        )
        selected.set(String(current.id), current)
        if (!current.parentId || String(current.parentId) === '0') break
        current = byId.get(String(current.parentId))
        requireFixture(Boolean(current), 'A required menu ancestor is outside the tenant package')
      }
    }
  }
  for (const component of ['erp/sale/order/index', 'erp/purchase/in/index']) {
    requireFixture(
      [...selected.values()].some(
        (menu) => menu.component?.replace(/^\//, '').replace(/\.vue$/, '') === component
      ),
      `Missing discoverable page menu for ${component}`
    )
  }
  return [...selected.values()]
}

function findRoute(menus, component, parent = '') {
  for (const menu of rows(menus)) {
    const route = menu.path?.startsWith('/')
      ? menu.path
      : `${parent}/${menu.path || ''}`.replace(/\/+/g, '/')
    if (menu.component?.replace(/^\//, '').replace(/\.vue$/, '') === component) return route
    const child = findRoute(menu.children, component, route)
    if (child) return child
  }
}

async function selfTest() {
  for (const bad of [
    '',
    'https://jixu-ai.com',
    'http://localhost.evil.test',
    'http://127.0.0.2',
    'http://localhost@evil.test',
    'http://user:password@localhost',
    'http://localhost/?token=hidden',
    'file:///tmp/test'
  ]) {
    assert.throws(() => localUrl(bad, 'test'), CheckError)
  }
  assert.equal(localUrl('http://127.0.0.1:48083/admin-api', 'test', true), 'http://127.0.0.1:48083')
  assert.equal(localUrl('http://localhost:9160', 'test'), 'http://localhost:9160')
  assert.throws(() => endpoint('//external.test/path'), CheckError)
  assert.throws(() => assertMasked({ totalPrice: null, items: [] }), CheckError)
  assert.throws(
    () =>
      assertMasked({
        totalPrice: null,
        items: [{ id: '1', count: 1, productPrice: 0, totalPrice: null }]
      }),
    CheckError
  )
  assertMasked({
    totalPrice: null,
    items: [{ id: '1', count: 1, productPrice: null, totalPrice: null }]
  })
  const baseline = {
    id: '1',
    businessType: 'OPENING',
    status: 10,
    remark: 'fixture',
    totalCount: 10,
    totalPrice: 865.8,
    discountPercent: 5,
    otherPrice: 7,
    items: [
      { id: '2', count: 10, productPrice: 80, taxPercent: 13, taxPrice: 104, totalPrice: 800 }
    ]
  }
  assertAmounts(
    'purchase',
    baseline,
    {
      ...baseline,
      totalCount: 12,
      totalPrice: 1037.56,
      items: [{ ...baseline.items[0], count: 12, taxPrice: 124.8, totalPrice: 960 }]
    },
    12
  )
  assert.throws(
    () =>
      assertAmounts(
        'purchase',
        baseline,
        {
          ...baseline,
          items: [{ ...baseline.items[0], productPrice: 0 }]
        },
        10
      ),
    CheckError
  )
  check(success({ status: 200, payload: { code: 0, data: true } }), 'CommonResult success')
  check(!success({ status: 200, payload: { code: 403 } }), 'Business 403 is not success')
  check(
    findRoute(
      [{ path: '/erp', children: [{ path: 'sale/order', component: 'erp/sale/order/index' }] }],
      'erp/sale/order/index'
    ) === '/erp/sale/order',
    'Dynamic menu route resolution'
  )
  console.log(
    'PASS: local URL guards, nonempty masking, amount assertions, envelopes and menu routes (no I/O)'
  )
}

async function main() {
  // Capture explicit shell values before config/local.env can supply defaults.
  const webBase = localUrl(process.env.CFOR_WEB_BASE, 'CFOR_WEB_BASE')
  const apiBase = localUrl(process.env.CFOR_API_BASE, 'CFOR_API_BASE', true)
  requireFixture(process.env.CFOR_TENANT_ID === '1', 'Explicit CFOR_TENANT_ID=1 is required')
  const cdpBase = localUrl(process.env.CFOR_CDP_URL || 'http://127.0.0.1:9222', 'CFOR_CDP_URL')
  const { chromium } = await import('playwright-core')
  const { unwrapWebStorageValue } = await import('./lib/assertions.mjs')
  const { config } = await import('./config/index.mjs')
  const keepPage = process.argv.includes('--keep-page')
  const runId = `PB006${Date.now()}${randomBytes(3).toString('hex')}`
  const outputDir = path.resolve(
    process.env.CFOR_PB006_OUT || `/tmp/cfor-pb006-masked-edit/${runId}`
  )
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const result = {
    runId,
    startedAt: new Date().toISOString(),
    webBase,
    apiBase,
    tenantId: '1',
    status: 'RUNNING',
    checks: [],
    api: [],
    screenshots: [],
    cleanup: [],
    blockedBrowserWrites: [],
    pageErrors: [],
    fixtures: [],
    keepPage
  }
  const documentIds = { sale: new Set(), purchase: new Set() }
  const users = new Set()
  const roles = new Set()
  const documents = { sale: [], purchase: [] }
  const secrets = new Set()
  let browser
  let context
  let adminContext
  let page
  let authenticated = false
  let adminToken
  let restrictedToken
  let restrictedUserId
  let roleId
  let selectedMenus
  let interrupted = false
  let cleaning = false
  const onInterrupt = () => {
    interrupted = true
  }
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onInterrupt)

  const screenshot = async (name) => {
    if (!page || !authenticated || page.isClosed()) return undefined
    const filename = path.join(outputDir, `${name}.png`)
    await page.screenshot({
      path: filename,
      animations: 'disabled',
      mask: [page.locator('input[type="password"]')]
    })
    result.screenshots.push(filename)
    return filename
  }
  const step = async (name, action) => {
    const started = Date.now()
    if (interrupted) {
      result.checks.push({ name, status: 'BLOCKED', durationMs: 0, error: 'Run interrupted' })
      return false
    }
    try {
      const evidence = await action()
      result.checks.push({ name, status: 'PASS', durationMs: Date.now() - started, evidence })
      console.log(`PASS: ${name} (${Date.now() - started}ms)`)
      return true
    } catch (error) {
      const status = error instanceof CheckError && error.blocked ? 'BLOCKED' : 'FAIL'
      const image = await screenshot(`failure-${result.checks.length + 1}`).catch(() => undefined)
      result.checks.push({
        name,
        status,
        durationMs: Date.now() - started,
        error: safeError(error),
        screenshot: image
      })
      console.log(`${status}: ${name}; ${safeError(error)}`)
      return false
    }
  }
  const allowedWrite = (method, pathname, body) => {
    if (method === 'POST' && pathname === '/bpm/approval-policy/preview') return true
    if (method === 'POST' && pathname === '/system/role/create')
      return body?.code?.startsWith(runId)
    if (method === 'POST' && pathname === '/system/user/create')
      return body?.username?.startsWith(runId.toLowerCase())
    if (method === 'POST' && pathname.startsWith('/system/permission/')) {
      if (pathname === '/system/permission/assign-user-role') {
        return (
          users.has(String(body?.userId)) &&
          Array.isArray(body?.roleIds) &&
          body.roleIds.every((id) => roles.has(String(id)))
        )
      }
      return (
        [
          '/system/permission/assign-role-menu',
          '/system/permission/assign-role-data-scope'
        ].includes(pathname) && roles.has(String(body?.roleId))
      )
    }
    for (const kind of ['sale', 'purchase']) {
      const base = kind === 'sale' ? '/erp/sale-order' : '/erp/purchase-in'
      if (method === 'POST' && pathname === `${base}/create`) {
        return (
          body?.remark?.startsWith(runId) &&
          (kind === 'sale' || (body.businessType === 'OPENING' && !body.orderId))
        )
      }
      if (method === 'PUT' && pathname === `${base}/update`)
        return documentIds[kind].has(String(body?.id))
      if (method === 'DELETE' && pathname === `${base}/delete`) return true
    }
    return method === 'DELETE' && ['/system/user/delete', '/system/role/delete'].includes(pathname)
  }
  const request = async (token, method, pathname, body) => {
    if (interrupted && !cleaning) throw new CheckError('Run interrupted', true)
    const route = endpoint(pathname)
    check(
      method === 'GET' || allowedWrite(method, route, body),
      'Unapproved API mutation was blocked'
    )
    if (method === 'DELETE') {
      const query = new URLSearchParams(pathname.split('?')[1])
      const owned =
        route === '/system/user/delete'
          ? users
          : route === '/system/role/delete'
            ? roles
            : route === '/erp/sale-order/delete'
              ? documentIds.sale
              : documentIds.purchase
      const ids = (query.get('ids') || query.get('id') || '').split(',')
      check(
        ids.length > 0 && ids.every((id) => owned.has(id)),
        'Cleanup may only delete fixtures from this run'
      )
    }
    const started = Date.now()
    let response
    try {
      response = await fetch(`${apiBase}/admin-api${pathname}`, {
        method,
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'tenant-id': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000)
      })
    } catch {
      throw new CheckError(`Transport failure: ${method} ${route}`)
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new CheckError(`Non-JSON response: ${method} ${route}, HTTP ${response.status}`)
    }
    result.api.push({
      method,
      pathname: route,
      status: response.status,
      code: payload?.code,
      durationMs: Date.now() - started
    })
    return { status: response.status, payload }
  }
  const business = async (token, method, pathname, body) => {
    const response = await request(token, method, pathname, body)
    check(
      success(response),
      `${method} ${endpoint(pathname)} failed; HTTP ${response.status}, business code ${response.payload?.code}`
    )
    return unwrap(response.payload)
  }
  const getDocument = (kind, id, token = adminToken) =>
    business(
      token,
      'GET',
      `/erp/${kind === 'sale' ? 'sale-order' : 'purchase-in'}/get?id=${encodeURIComponent(id)}`
    )
  const getRestrictedToken = async () => {
    const token = unwrapWebStorageValue(
      await page.evaluate(() => localStorage.getItem('ACCESS_TOKEN'))
    )
    check(typeof token === 'string' && token.length > 0, 'Restricted session token is missing')
    secrets.add(token)
    restrictedToken = token
    return token
  }
  const permissions = async () =>
    business(await getRestrictedToken(), 'GET', '/system/auth/get-permission-info')
  const loginPage = async (target, username, password, tenantName) => {
    secrets.add(password)
    await target.goto(`${webBase}/login`, { waitUntil: 'domcontentloaded' })
    await target.getByRole('button', { name: '账密登录', exact: true }).click()
    const usernameInput = target.getByPlaceholder('请输入用户名').first()
    const form = usernameInput.locator('xpath=ancestor::form[1]')
    const tenantInput = form.getByPlaceholder('请输入租户名称')
    if (await tenantInput.count()) {
      await tenantInput.fill(tenantName)
      await tenantInput.press('Tab')
    }
    await usernameInput.fill(username)
    await form.getByPlaceholder('请输入密码').fill(password)
    await form.getByRole('button', { name: '登录', exact: true }).click()
    await target.waitForFunction(
      () => Boolean(localStorage.getItem('ACCESS_TOKEN')) && location.pathname !== '/login',
      undefined,
      { timeout: 60000 }
    )
    const token = unwrapWebStorageValue(
      await target.evaluate(() => localStorage.getItem('ACCESS_TOKEN'))
    )
    check(
      typeof token === 'string' && token.length > 0,
      'Browser login did not produce an access token'
    )
    secrets.add(token)
    return token
  }
  const guardContext = async (target) => {
    await target.route('**/*', async (route) => {
      const req = route.request()
      let url
      try {
        url = new URL(req.url())
      } catch {
        await route.abort()
        return
      }
      if (
        req.isNavigationRequest() &&
        req.resourceType() === 'document' &&
        url.origin !== webBase
      ) {
        result.blockedBrowserWrites.push({ method: req.method(), pathname: 'nonlocal-navigation' })
        await route.abort()
        return
      }
      if (!url.pathname.includes('/admin-api/')) {
        await route.continue()
        return
      }
      const pathname = url.pathname.slice(url.pathname.indexOf('/admin-api/') + '/admin-api'.length)
      const auth =
        /^\/system\/auth\/(login-encrypted|tenant-options-encrypted|login-tenant-selection|refresh-token|logout)$/.test(
          pathname
        )
      let body
      if (!auth && req.method() !== 'GET') {
        try {
          body = req.postDataJSON()
        } catch {
          /* Reject unrecognized mutations. */
        }
      }
      const tenant = req.headers()['tenant-id']
      const local = [webBase, apiBase].includes(url.origin)
      const readable =
        req.method() === 'GET' &&
        (tenant === '1' ||
          pathname.startsWith('/system/tenant/') ||
          pathname.startsWith('/system/auth/'))
      const editable =
        req.method() === 'PUT' &&
        ['/erp/sale-order/update', '/erp/purchase-in/update'].includes(pathname) &&
        tenant === '1' &&
        (allowedWrite('PUT', pathname, body) ||
          // The SPA may encrypt request bodies, so postDataJSON() cannot expose the
          // fixture ID. The endpoint itself is still limited to the two edit APIs.
          documentIds.sale.size > 0 ||
          documentIds.purchase.size > 0)
      if (!(local && (readable || auth || editable))) {
        result.blockedBrowserWrites.push({ method: req.method(), pathname: pathname.split('?')[0] })
        await route.abort()
        return
      }
      await route.continue()
    })
  }
  const navigate = async (route) => {
    check(route?.startsWith('/') && !route.startsWith('//'), 'Expected a tenant menu route')
    await page.waitForFunction(() =>
      Boolean(document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router)
    )
    await page.evaluate(async (destination) => {
      await document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$router.push(destination)
    }, route)
  }
  const tableCell = async (dialog, title, kind) => {
    if (kind === 'sale') {
      const grid = dialog.locator('.vxe-table').first()
      const header = grid
        .locator('.vxe-header--column')
        .filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) })
        .first()
      await header.waitFor()
      const colid = await header.getAttribute('colid')
      check(colid && /^[a-zA-Z0-9_-]+$/.test(colid), 'Quantity column has no stable VXE identifier')
      return grid.locator(`.vxe-table--body-wrapper .vxe-body--row td[colid="${colid}"]`).first()
    }
    const table = dialog.locator('.el-table').first()
    const header = table
      .locator('thead th')
      .filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) })
      .first()
    await header.waitFor()
    const column = (await header.getAttribute('class'))
      ?.split(/\s+/)
      .find((value) => /^el-table_\d+_column_\d+$/.test(value))
    check(Boolean(column), 'Purchase column has no stable Element identifier')
    return table.locator(`.el-table__body .el-table__row td.${column}`).first()
  }
  const openEditor = async (kind, document) => {
    const info = await permissions()
    const route = findRoute(
      info.menus,
      kind === 'sale' ? 'erp/sale/order/index' : 'erp/purchase/in/index'
    )
    requireFixture(
      Boolean(route),
      `Restricted account cannot discover the ${kind} page in dynamic menus`
    )
    await navigate(route)
    const selector = kind === 'sale' ? '请输入订单单号' : '请输入入库单号'
    const no = kind === 'sale' ? document.billNo : document.no
    await page.getByPlaceholder(selector, { exact: true }).fill(no)
    const listPath = `/admin-api/erp/${kind === 'sale' ? 'sale-order' : 'purchase-in'}/page`
    const loaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === listPath && response.request().method() === 'GET'
    )
    await page
      .getByRole('button', { name: /^搜\s*索$/ })
      .first()
      .click()
    const response = await loaded
    const payload = await response.json()
    check(success({ status: response.status(), payload }), 'Restricted list request must succeed')
    check(
      rows(unwrap(payload)).some((row) => String(row.id) === String(document.id)),
      'List must contain the isolated fixture'
    )
    const row = page
      .locator(kind === 'sale' ? '.vxe-body--row' : '.el-table__row')
      .filter({ hasText: no })
      .first()
    await row.waitFor()
    let action = row.getByRole('button', { name: kind === 'sale' ? '修改' : '编辑', exact: true })
    if (kind === 'sale') {
      const rowid = await row.getAttribute('rowid')
      if (rowid && /^[a-zA-Z0-9_-]+$/.test(rowid)) {
        const fixed = page.locator(
          `.vxe-table--fixed-right-wrapper .vxe-body--row[rowid="${rowid}"]`
        )
        if (await fixed.count()) action = fixed.getByRole('button', { name: '修改', exact: true })
      }
    }
    await action.first().click()
    const dialog = page
      .locator('.el-dialog:visible')
      .filter({
        hasText: kind === 'sale' ? '存货清单' : '入库产品清单'
      })
      .last()
    await dialog.waitFor()
    await dialog.locator('.el-loading-mask:visible').waitFor({ state: 'hidden' })
    const price = await tableCell(dialog, kind === 'sale' ? '未税单价' : '产品单价', kind)
    await price.scrollIntoViewIfNeeded()
    const masked = await price.evaluate(
      (element) =>
        element.textContent.includes('****') ||
        [...element.querySelectorAll('input')].some((input) => input.value === '****')
    )
    check(masked, 'Visible item price must be displayed as ****')
    return dialog
  }
  const saveEditor = async (kind, document, dialog) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/admin-api/erp/${kind === 'sale' ? 'sale-order' : 'purchase-in'}/update` &&
        response.request().method() === 'PUT' &&
        String(response.request().postDataJSON()?.id) === String(document.id)
    )
    await dialog.getByRole('button', { name: kind === 'sale' ? /^保\s*存$/ : /^确\s*定$/ }).click()
    const response = await responsePromise
    const payload = await response.json()
    check(
      success({ status: response.status(), payload }),
      `Visible ${kind} save failed; HTTP ${response.status()}, business code ${payload?.code}`
    )
    if (kind === 'sale') {
      await dialog.locator('.el-loading-mask:visible').waitFor({ state: 'hidden' })
    } else {
      await dialog.waitFor({ state: 'hidden' })
    }
  }
  const closeEditor = async () => {
    const dialog = page.locator('.el-dialog:visible').last()
    if (await dialog.count()) {
      await dialog
        .getByRole('button', { name: /^取\s*消$/ })
        .last()
        .click()
      await dialog.waitFor({ state: 'hidden' })
    }
  }
  const maskedUpdate = (kind, document) => {
    const common = pick(document, [
      'id',
      'customerId',
      'accountId',
      'saleUserId',
      'orderTime',
      'expectedArrivalTime',
      'billNo',
      'billDate',
      'version',
      'remark',
      'taxPercent',
      'saleTypeCode',
      'settleMethodCode',
      'businessType',
      'openingBaselineDate',
      'supplierId',
      'orderId',
      'inTime',
      'fileUrl'
    ])
    return {
      ...common,
      ...(kind === 'sale' ? { saleOrderBomList: [] } : {}),
      items: document.items.map((item) =>
        pick(item, [
          'id',
          'mid',
          'entryNo',
          'productId',
          'productUnitId',
          'warehouseId',
          'orderItemId',
          'count',
          'remark',
          'isGift',
          'isQc'
        ])
      )
    }
  }
  const beforeUi = async (kind, document) => {
    assertMasked(await getDocument(kind, document.id, await getRestrictedToken()))
    await closeEditor()
    return openEditor(kind, document)
  }
  try {
    let tenantName
    const setup = await step(
      'preflight: local browser, tenant, administrator and nonempty legal seeds',
      async () => {
        const tenants = rows(await business(undefined, 'GET', '/system/tenant/simple-list'))
        const tenant = tenants.find((item) => String(item?.id) === '1')
        requireFixture(tenant?.name, 'Local tenant 1 is unavailable')
        tenantName = tenant.name
        browser = await chromium.connectOverCDP(cdpBase)
        for (const existingContext of browser.contexts()) {
          for (const existingPage of existingContext.pages()) {
            if (!existingPage.url().startsWith(`${webBase}/`)) continue
            const stored = await existingPage
              .evaluate(() => localStorage.getItem('ACCESS_TOKEN'))
              .catch(() => null)
            const candidate = unwrapWebStorageValue(stored)
            if (typeof candidate !== 'string' || !candidate) continue
            const response = await request(candidate, 'GET', '/system/auth/get-permission-info')
            const info = unwrap(response.payload)
            if (
              success(response) &&
              (info?.permissions?.includes('*:*:*') ||
                [
                  'system:role:create',
                  'system:user:create',
                  'system:permission:assign-role-menu'
                ].every((permission) => info?.permissions?.includes(permission)))
            ) {
              adminToken = candidate
              secrets.add(candidate)
              break
            }
          }
          if (adminToken) break
        }
        if (!adminToken) {
          requireFixture(
            config.username && config.password,
            'No local administrator CDP session or configured administrator credentials'
          )
          adminContext = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
            locale: 'zh-CN',
            serviceWorkers: 'block'
          })
          await guardContext(adminContext)
          const adminPage = await adminContext.newPage()
          adminToken = await loginPage(adminPage, config.username, config.password, tenantName)
        }
        const admin = await business(adminToken, 'GET', '/system/auth/get-permission-info')
        const deptList = rows(await business(adminToken, 'GET', '/system/dept/list'))
        const customerList = rows(
          await business(adminToken, 'GET', '/base/partner/simple-list?roleType=CUSTOMER')
        )
        const supplierList = rows(await business(adminToken, 'GET', '/erp/supplier/simple-list'))
        const materialList = rows(
          await business(adminToken, 'GET', '/mes/basMaterial/list/enabled')
        )
        const accountList = rows(await business(adminToken, 'GET', '/erp/account/simple-list'))
        const warehouseList = rows(await business(adminToken, 'GET', '/erp/warehouse/simple-list'))
        const yes = (value) => ['Y', '1', '是', 'TRUE'].includes(String(value).toUpperCase())
        const saleMaterial = materialList.find(
          (item) => item.id && item.unitId && Number(item.isEnabled) === 1 && yes(item.saled)
        )
        const purchaseMaterial = materialList.find(
          (item) =>
            item.id &&
            item.unitId &&
            Number(item.isEnabled) === 1 &&
            yes(item.purchased) &&
            (item.inventoryNature ? item.inventoryNature === 'STOCK' : !yes(item.virtualGoods))
        )
        const customer = customerList.find((item) => item.id)
        const supplier = supplierList.find((item) => item.id)
        const account = accountList.find(
          (item) => item.id && (item.status === undefined || Number(item.status) === 0)
        )
        const warehouse = warehouseList.find((item) => item.id)
        requireFixture(
          customer && supplier && saleMaterial && purchaseMaterial && account && warehouse,
          'Missing enabled customer/supplier, sellable material, purchasable STOCK material, account or warehouse'
        )
        const fixtureDepartment = deptList.find(
          (department) => department?.id && Number(department.status) === 0
        )
        requireFixture(
          fixtureDepartment,
          'Tenant must have an enabled department for the isolated role'
        )
        const allMenus = await business(adminToken, 'GET', '/system/menu/list')
        const tenantMenus = await business(adminToken, 'GET', '/system/menu/simple-list')
        selectedMenus = selectMenus(allMenus, tenantMenus)
        result.seeds = {
          customerId: String(customer.id),
          supplierId: String(supplier.id),
          saleMaterialId: String(saleMaterial.id),
          purchaseMaterialId: String(purchaseMaterial.id),
          unitIds: [String(saleMaterial.unitId), String(purchaseMaterial.unitId)],
          accountId: String(account.id),
          warehouseId: String(warehouse.id)
        }
        result.departmentId = String(fixtureDepartment.id)
        return {
          seedCounts: {
            customers: customerList.length,
            suppliers: supplierList.length,
            materials: materialList.length,
            accounts: accountList.length,
            warehouses: warehouseList.length
          },
          departmentId: result.departmentId,
          menuCount: selectedMenus.length
        }
      }
    )
    requireFixture(setup, 'Local preflight did not pass; no fixtures were created')

    const roleReady = await step(
      'fixture: isolated minimum editor role and account without sensitive amount access',
      async () => {
        roleId = String(await business(adminToken, 'POST', '/system/role/create', {
          name: `${runId.slice(0, 23)}编辑`,
          code: runId,
          sort: 99,
          status: 0,
          remark: `${runId} temporary local fixture`
        }))
        requireFixture(
          roleId !== null && ['string', 'number'].includes(typeof roleId),
          'Role creation returned no scalar ID'
        )
        roles.add(String(roleId))
        await business(adminToken, 'POST', '/system/permission/assign-role-menu', {
          roleId,
          menuIds: selectedMenus.map((menu) => String(menu.id))
        })
        await business(adminToken, 'POST', '/system/permission/assign-role-data-scope', {
          roleId,
          dataScope: 2,
          dataScopeDeptIds: [result.departmentId]
        })
        const username = runId.toLowerCase().slice(0, 30)
        const password = `Aa9!${randomBytes(6).toString('hex')}`
        secrets.add(password)
        restrictedUserId = String(await business(adminToken, 'POST', '/system/user/create', {
          username,
          password,
          nickname: `${runId.slice(0, 23)}测试`,
          deptId: result.departmentId,
          postIds: [],
          roleIds: [roleId],
          remark: `${runId} temporary local fixture`
        }))
        requireFixture(
          restrictedUserId !== null && ['string', 'number'].includes(typeof restrictedUserId),
          'User creation returned no scalar ID'
        )
        users.add(String(restrictedUserId))
        const roleIds = await business(
          adminToken,
          'GET',
          `/system/permission/list-user-roles?userId=${restrictedUserId}`
        )
        check(
          Array.isArray(roleIds) && roleIds.length === 1 && String(roleIds[0]) === String(roleId),
          'Fixture user must have exactly the isolated role'
        )
        context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          locale: 'zh-CN',
          serviceWorkers: 'block'
        })
        context.setDefaultTimeout(30000)
        context.setDefaultNavigationTimeout(60000)
        await guardContext(context)
        page = await context.newPage()
        page.on('pageerror', () => result.pageErrors.push({ type: 'pageerror', at: Date.now() }))
        restrictedToken = await loginPage(page, username, password, tenantName)
        authenticated = true
        const info = await permissions()
        check(
          String(info.user?.id) === String(restrictedUserId),
          'Visible browser must use the isolated account'
        )
        check(
          !info.permissions.includes('sensitive:amount:view') &&
            !info.permissions.includes('*:*:*'),
          'Restricted account must not inherit amount or wildcard access'
        )
        check(
          [...permitted].every((permission) => info.permissions.includes(permission)),
          'Restricted account must have the four expected query/edit permissions'
        )
        check(
          info.permissions.every((permission) => !permission || permitted.has(permission)),
          `Restricted account must not inherit additional action permissions: ${info.permissions
            .filter((permission) => permission && !permitted.has(permission))
            .slice(0, 20)
            .join(',')}`
        )
        return {
          userId: String(restrictedUserId),
          roleId: String(roleId),
          loginCount: 1,
          permissionCount: info.permissions.length
        }
      }
    )
    requireFixture(roleReady, 'Isolated account setup failed')

    const date = new Date()
    const businessDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date)
    const orderTime = `${businessDate}T09:00:00`
    const expectedArrivalTime = `${businessDate}T18:00:00`
    const seed = result.seeds
    for (const kind of ['sale', 'purchase']) {
      await step(`${kind}: create two real isolated unapproved documents`, async () => {
        for (let index = 0; index < 2; index++) {
          const remark = `${runId}-${kind}-${index + 1}`
          const body =
            kind === 'sale'
              ? {
                  customerId: seed.customerId,
                  accountId: seed.accountId,
                  billNo: `${runId}-S${index + 1}`,
                  billType: 'SalOrder',
                  isAuto: 0,
                  billDate: businessDate,
                  orderTime,
                  expectedArrivalTime,
                  discountPercent: 0,
                  discountPrice: 0,
                  depositPrice: 0,
                  totalPrice: 1130,
                  totalCount: 10,
                  totalProductPrice: 1000,
                  totalTaxPrice: 130,
                  remark,
                  saleOrderBomList: [],
                  items: [
                    {
                      productId: seed.saleMaterialId,
                      productUnitId: seed.unitIds[0],
                      count: 10,
                      productPrice: 100,
                      productTaxPrice: 113,
                      taxPercent: 13,
                      taxPrice: 130,
                      totalPrice: 1130,
                      isGift: 0,
                      isQc: 0,
                      remark
                    }
                  ]
                }
              : {
                  businessType: 'OPENING',
                  openingBaselineDate: businessDate,
                  supplierId: seed.supplierId,
                  accountId: seed.accountId,
                  inTime: orderTime,
                  discountPercent: 5,
                  otherPrice: 7,
                  remark,
                  items: [
                    {
                      productId: seed.purchaseMaterialId,
                      productUnitId: seed.unitIds[1],
                      warehouseId: seed.warehouseId,
                      count: 10,
                      productPrice: 80,
                      taxPercent: 13,
                      remark
                    }
                  ]
                }
          if (kind === 'sale') {
            const decision = await business(adminToken, 'POST', '/bpm/approval-policy/preview', {
              billType: 'SalOrder',
              sourceType: 'MANUAL',
              businessData: { ...body, status: 0 }
            })
            requireFixture(
              decision?.mode === 'MANUAL',
              'Sales /create calls submitAdd: require MANUAL approval mode to avoid automatic effect or workflow; policy was not changed'
            )
          }
          const id = await business(
            adminToken,
            'POST',
            `/erp/${kind === 'sale' ? 'sale-order' : 'purchase-in'}/create`,
            body
          )
          requireFixture(
            id !== null && ['string', 'number'].includes(typeof id),
            `${kind} creation returned no scalar ID`
          )
          documentIds[kind].add(String(id))
          result.fixtures.push({ kind, id: String(id), tag: remark })
          const persisted = await getDocument(kind, id)
          check(persisted.remark === remark, 'Created fixture must retain its unique run tag')
          documents[kind].push(persisted)
          assertAmounts(kind, persisted, persisted, 10)
          check(
            Number(persisted.items[0].productPrice) > 0 && Number(persisted.totalPrice) > 0,
            'Administrator baseline must contain nonzero real prices and amounts'
          )
        }
        return { created: 2, inventoryApproved: false, workflowStarted: false }
      })
    }
    for (const kind of ['sale', 'purchase']) {
      const baseline = documents[kind][0]
      const ready = baseline && documentIds[kind].has(String(baseline.id))
      await step(`${kind}: visible UI edits quantity with masked prices and saves`, async () => {
        requireFixture(ready, 'Real fixture creation did not complete')
        assertDraft(kind, baseline)
        const errorCount = result.pageErrors.length
        const dialog = await beforeUi(kind, baseline)
        await screenshot(`${kind}-quantity-before`)
        const cell = await tableCell(dialog, '数量', kind)
        await cell.scrollIntoViewIfNeeded()
        if (kind === 'sale') await cell.dblclick()
        const input = cell.locator('input:visible').first()
        await input.fill('12')
        await input.press('Tab')
        await saveEditor(kind, baseline, dialog)
        const actual = await getDocument(kind, baseline.id)
        assertAmounts(kind, baseline, actual, 12)
        assertMasked(await getDocument(kind, baseline.id, await getRestrictedToken()))
        check(
          result.pageErrors.length === errorCount,
          'Quantity flow must not trigger browser page errors'
        )
        return {
          quantity: 12,
          originalUnitPricePreserved: true,
          totalRecalculated: true,
          screenshot: await screenshot(`${kind}-quantity-saved`)
        }
      })
      await step(
        `${kind}: visible UI edits only remark and preserves quantities and all amounts`,
        async () => {
          requireFixture(ready, 'Real fixture creation did not complete')
          const before = await getDocument(kind, baseline.id)
          const dialog = await beforeUi(kind, before)
          const expand = dialog.getByRole('button', { name: '展开基本信息', exact: true })
          if (await expand.isVisible().catch(() => false)) await expand.click()
          const field = dialog
            .locator('.el-form-item')
            .filter({
              has: page.locator('.el-form-item__label', {
                hasText: kind === 'sale' ? /^订单备注$/ : /^备注$/
              })
            })
            .first()
          const remark = `${runId}-${kind}-remark-only`
          await field.locator('input,textarea').first().fill(remark)
          await screenshot(`${kind}-remark-before-save`)
          await saveEditor(kind, before, dialog)
          const actual = await getDocument(kind, baseline.id)
          check(actual.remark === remark, 'Remark-only UI save must persist the new remark')
          check(
            sameDocument({ ...before, remark }, actual),
            'Remark-only UI save must preserve every item, quantity and amount'
          )
          assertDraft(kind, actual)
          return {
            quantityUnchanged: true,
            allAmountsUnchanged: true,
            screenshot: await screenshot(`${kind}-remark-saved`)
          }
        }
      )
      await closeEditor().catch(() => {})
    }
    for (const kind of ['sale', 'purchase']) {
      await step(`${kind}: API forged prices cannot overwrite server pricing`, async () => {
        requireFixture(documents[kind][0], 'Real fixture is required for price tampering')
        const before = await getDocument(kind, documents[kind][0].id)
        const body = maskedUpdate(kind, before)
        for (const key of moneyKeys) body[key] = 999999
        body.discountPercent = 99
        for (const key of moneyKeys) body.items[0][key] = 888888
        body.items[0].taxPercent = 99
        const response = await request(
          await getRestrictedToken(),
          'PUT',
          `/erp/${kind === 'sale' ? 'sale-order' : 'purchase-in'}/update`,
          body
        )
        check(
          success(response) ||
            [400, 403].includes(Number(response.payload?.code)) ||
            [400, 403].includes(response.status),
          'Price tampering must be safely ignored or explicitly rejected'
        )
        const actual = await getDocument(kind, before.id)
        check(
          sameDocument(before, actual),
          'Price tampering must leave server quantities, prices, totals and remarks intact'
        )
        return { pricingUnchanged: true, outcome: success(response) ? 'IGNORED' : 'REJECTED' }
      })
      await step(
        `${kind}: API rejects another isolated document item ID without changing either document`,
        async () => {
          requireFixture(
            documents[kind].length === 2,
            'Two real fixtures are required for cross-document item validation'
          )
          const before = await getDocument(kind, documents[kind][0].id)
          const other = await getDocument(kind, documents[kind][1].id)
          const body = maskedUpdate(kind, before)
          body.items[0].id = other.items[0].id
          body.items[0].count = 19
          const response = await request(
            await getRestrictedToken(),
            'PUT',
            `/erp/${kind === 'sale' ? 'sale-order' : 'purchase-in'}/update`,
            body
          )
          check(
            !success(response) &&
              ([400, 403].includes(Number(response.payload?.code)) ||
                [400, 403].includes(response.status)),
            'Foreign item ID must be explicitly rejected'
          )
          check(
            sameDocument(before, await getDocument(kind, before.id)),
            'Cross-document attempt must preserve the target document'
          )
          check(
            sameDocument(other, await getDocument(kind, other.id)),
            'Cross-document attempt must preserve the other document'
          )
          return { rejected: true, bothDocumentsUnchanged: true }
        }
      )
    }
    const revoked = await step(
      'permission: revoke only edit rights from the temporary role',
      async () => {
        await business(adminToken, 'POST', '/system/permission/assign-role-menu', {
          roleId,
          menuIds: selectedMenus
            .filter((menu) => !editPermissions.includes(menu.permission))
            .map((menu) => String(menu.id))
        })
        const info = await permissions()
        check(
          editPermissions.every((permission) => !info.permissions.includes(permission)),
          'Revoked edit permissions must disappear immediately'
        )
        check(
          !info.permissions.includes('sensitive:amount:view'),
          'Amount access must remain absent after revocation'
        )
        return { sameAccount: true, sameBrowserLogin: true, editPermissionsRevoked: true }
      }
    )
    for (const kind of ['sale', 'purchase']) {
      await step(`${kind}: API returns 403 without the corresponding edit permission`, async () => {
        requireFixture(
          revoked && documents[kind][0],
          'Permission revocation and a real fixture are required'
        )
        const before = await getDocument(kind, documents[kind][0].id)
        const body = maskedUpdate(kind, before)
        body.items[0].count = 21
        body.remark = `${runId}-forbidden-edit`
        const response = await request(
          await getRestrictedToken(),
          'PUT',
          `/erp/${kind === 'sale' ? 'sale-order' : 'purchase-in'}/update`,
          body
        )
        check(
          response.status === 403 || Number(response.payload?.code) === 403,
          'Missing edit permission must return HTTP or business 403'
        )
        check(
          sameDocument(before, await getDocument(kind, before.id)),
          'Forbidden save must not change the document'
        )
        return {
          httpStatus: response.status,
          businessCode: response.payload?.code,
          unchanged: true
        }
      })
    }
    await step('browser: no unapproved writes or JavaScript page failures', async () => {
      check(
        result.blockedBrowserWrites.length === 0,
        'Unexpected browser mutations or nonlocal navigation were blocked'
      )
      check(
        result.pageErrors.length === 0,
        'The restricted browser session must not report JavaScript page errors'
      )
      return { unexpectedWrites: 0, pageErrors: 0 }
    })
  } catch (error) {
    result.checks.push({
      name: 'setup-orchestration',
      status: error?.blocked ? 'BLOCKED' : 'FAIL',
      durationMs: 0,
      error: safeError(error)
    })
  } finally {
    cleaning = true
    // Never unapprove or execute stock operations during cleanup.
    const cleanup = async (kind, id, pathname, verify) => {
      const started = Date.now()
      try {
        await business(adminToken, 'DELETE', pathname)
        const remaining = await business(adminToken, 'GET', verify)
        check(!remaining, 'Deleted fixture remains visible after cleanup')
        result.cleanup.push({ kind, id, status: 'PASS', durationMs: Date.now() - started })
      } catch (error) {
        result.cleanup.push({
          kind,
          id,
          status: 'FAIL',
          durationMs: Date.now() - started,
          error: safeError(error)
        })
        console.log(`CLEANUP FAIL: ${kind} ${id}; ${safeError(error)}`)
      }
    }
    if (adminToken) {
      for (const kind of ['purchase', 'sale']) {
        const base = kind === 'sale' ? '/erp/sale-order' : '/erp/purchase-in'
        for (const id of documentIds[kind]) {
          await cleanup(
            kind,
            id,
            `${base}/delete?ids=${encodeURIComponent(id)}`,
            `${base}/get?id=${encodeURIComponent(id)}`
          )
        }
      }
      for (const id of users) {
        await cleanup('user', id, `/system/user/delete?id=${id}`, `/system/user/get?id=${id}`)
      }
      for (const id of roles) {
        await cleanup('role', id, `/system/role/delete?id=${id}`, `/system/role/get?id=${id}`)
      }
    }
    if (adminContext) await adminContext.close().catch(() => {})
    if (context && !keepPage) await context.close().catch(() => {})
    // CDP Browser.close disconnects this client; it does not close the existing Chrome.
    if (browser) await browser.close().catch(() => {})
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onInterrupt)
    result.finishedAt = new Date().toISOString()
    result.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt)
    result.summary = {
      PASS: result.checks.filter((entry) => entry.status === 'PASS').length,
      FAIL: result.checks.filter((entry) => entry.status === 'FAIL').length,
      BLOCKED: result.checks.filter((entry) => entry.status === 'BLOCKED').length,
      cleanupFailures: result.cleanup.filter((entry) => entry.status === 'FAIL').length
    }
    result.status =
      result.summary.FAIL || result.summary.cleanupFailures
        ? 'FAIL'
        : result.summary.BLOCKED || interrupted
          ? 'BLOCKED'
          : 'PASS'
    result.retainedPageHasDeletedFixtures = keepPage && result.cleanup.length > 0
    let serialized = JSON.stringify(result, null, 2)
    for (const secret of secrets) {
      if (secret) serialized = serialized.replaceAll(secret, '[REDACTED]')
    }
    const report = path.join(outputDir, 'result.json')
    await writeFile(report, `${serialized}\n`, { mode: 0o600 })
    console.log(
      `${result.status}: PB006; ${result.summary.PASS} PASS / ${result.summary.FAIL} FAIL / ${result.summary.BLOCKED} BLOCKED; cleanup failures=${result.summary.cleanupFailures}`
    )
    console.log(`Report: ${report}`)
    if (keepPage)
      console.log(
        'Isolated page retained for inspection; accounts, roles and documents were still scheduled for cleanup.'
      )
    process.exitCode = result.status === 'PASS' ? 0 : 1
  }
}

if (process.argv.includes('--help')) {
  console.log(usage)
} else if (process.argv.includes('--self-test')) {
  await selfTest()
} else {
  try {
    await main()
  } catch (error) {
    console.error(`BLOCKED: ${safeError(error)}`)
    process.exitCode = 1
  }
}
