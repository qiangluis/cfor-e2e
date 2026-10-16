#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

// This local fixture verifies fail-closed presentation, not inventory ownership or backend acceptance.
const base = new URL(process.env.CFOR_CUSTOMER_INVENTORY_UI_BASE || 'http://127.0.0.1:9170/customer/')
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'UI fixture must target localhost')
const output = path.resolve(
  process.env.CFOR_CUSTOMER_INVENTORY_UI_OUTPUT || '/tmp/cfor-customer-inventory-ui'
)
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CFOR_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
})
const context = await browser.newContext({ locale: 'zh-CN' })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
const requests = []
const result = { mode: 'MOCKED_UI_CONTRACT', backendAcceptance: false, checks: [], screenshots: [] }
const message = '客户库存归属链尚未就绪，暂不可查询库存，请联系业务人员'
const check = (label, condition) => {
  assert.ok(condition, label)
  result.checks.push(label)
}
page.on('pageerror', (error) => errors.push(error.message))
try {
  await context.addInitScript(() => {
    localStorage.setItem('CFOR_CUSTOMER_PORTAL_SESSION', JSON.stringify({
      accessToken: 'customer-ui-token', refreshToken: 'customer-ui-refresh',
      expiresTime: Date.now() + 3600_000, tenantId: '7',
      userId: '802', basePartnerId: '902', partnerName: '测试客户'
    }))
  })
  await page.route('**/config.json', (route) =>
    route.fulfill({ json: { projectApi: '', projectUrl: '/admin-api' } }))
  await page.route('**/customer-api/**', async (route) => {
    const request = route.request()
    assert.equal(request.method(), 'GET', 'Inventory screen must be read only')
    assert.equal(request.headers()['tenant-id'], '7')
    assert.equal(request.headers().authorization, 'Bearer customer-ui-token')
    const pathname = new URL(request.url()).pathname
    assert.match(pathname, /\/customer\/inventory\/(summary|detail|flow)$/)
    requests.push(pathname)
    return route.fulfill({ json: { code: 409, data: null, msg: message } })
  })
  await page.goto(new URL('inventory', base).href)
  await page.locator('.customer-inventory__error').getByText(message, { exact: true }).waitFor()
  const unavailable = async () =>
    (await page.locator('.customer-inventory__card strong').allTextContents())
      .every((value) => value.trim() === '-')
  check('归属未就绪以持续错误呈现，不伪装为零库存', await unavailable())
  check('库存和流水均不渲染共享余额', await page.locator('.el-table__row').count() === 0)
  check('归属未就绪不能用物料下拉绕过', await page.locator('.el-select__wrapper').evaluate(
    (element) => element.classList.contains('is-disabled')))
  const oldCount = requests.length
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.el-button.is-loading'))
  check('刷新可重试且不会回退显示零库存', requests.length > oldCount && await unavailable())
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 })
    check(`${width}px 客户库存错误态无全局横向溢出`, !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)))
    const screenshot = path.join(output, `customer-inventory-unavailable-${width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    result.screenshots.push(screenshot)
  }
  check('真实Vue页面无运行错误且未发起写请求', errors.length === 0 && requests.length >= 6)
  result.status = 'PASS'
} catch (error) {
  result.status = 'FAIL'
  result.error = error.stack
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  result.errors = errors
  result.requests = requests
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(`${result.status}: ${result.checks.length} UI contract checks; ${output}/result.json`)
