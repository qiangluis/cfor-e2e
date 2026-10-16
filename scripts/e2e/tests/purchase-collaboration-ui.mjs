#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

// This is an isolated UI contract test. All business responses are mocked; it is not backend acceptance.
const base = new URL(process.env.CFOR_COLLABORATION_UI_BASE || 'http://127.0.0.1:9168/supplier/')
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'UI fixture must target localhost')
const output = path.resolve(
  process.env.CFOR_COLLABORATION_UI_OUTPUT || '/tmp/cfor-purchase-collaboration-ui'
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
const writes = []
const evidence = {
  mode: 'MOCKED_UI_CONTRACT',
  backendAcceptance: false,
  checks: [],
  screenshots: []
}
const check = (label, condition) => {
  assert.ok(condition, label)
  evidence.checks.push(label)
}
const reply = (route, data, code = 0, msg = '') =>
  route.fulfill({ json: { code, data, msg } })
let feedbackFailure = true
let initiatorMissing = true
let submittedFeedback = null
let quoteCount = 0
const inquiries = [
  {
    id: 'inquiry-open', inquiryNo: 'XJ-UI-OPEN', subject: '标准材料采购', status: 'COMPARED',
    items: [{ id: 'inquiry-item', productName: '测试物料', quantity: 10 }],
    quotes: [{
      id: 'own-quote', supplierId: '101', version: 1, totalAmount: 1200, currency: 'CNY',
      submittedAt: '2026-10-16T09:00:00', selected: false
    }]
  },
  {
    id: 'inquiry-approved', inquiryNo: 'XJ-UI-APPROVED', subject: '已完成比价', status: 'APPROVED',
    items: [],
    quotes: [{ id: 'selected-own-quote', supplierId: '101', version: 3,
      totalAmount: 2560, currency: 'CNY', selected: true }]
  },
  {
    id: 'inquiry-expired', inquiryNo: 'XJ-UI-EXPIRED', subject: '已截止询价', status: 'QUOTING',
    deadline: '2020-01-01T00:00:00', items: [], quotes: []
  }
]
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
try {
  await context.addInitScript(() => {
    localStorage.setItem('CFOR_SUPPLIER_PORTAL_SESSION', JSON.stringify({
      accessToken: 'ui-fixture-token', refreshToken: 'ui-fixture-refresh',
      expiresTime: Date.now() + 3600_000, tenantId: '7',
      userId: '801', basePartnerId: '901', partnerName: '测试供应商'
    }))
  })
  await page.route('**/config.json', (route) =>
    route.fulfill({ json: { projectApi: '', projectUrl: '/admin-api' } }))
  await page.route('**/supplier-api/**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    assert.equal(request.headers()['tenant-id'], '7')
    assert.equal(request.headers().authorization, 'Bearer ui-fixture-token')
    if (request.method() === 'GET') {
      if (pathname.endsWith('/sourcing/list')) return reply(route, inquiries)
      if (pathname.endsWith('/purchase-orders/page')) return reply(route, {
        total: 1,
        list: [{
          id: 'order-1', billNo: 'CGDD-UI-001', portalStatus: 'ACCEPTED',
          items: [{
            id: 'line-1', productName: '测试物料', count: 10,
            promisedDeliveryTime: '2026-11-01T10:00:00', nextDeliveryFeedbackVersion: 4
          }]
        }]
      })
      if (pathname.endsWith('/delivery-feedback/list')) {
        return reply(route, submittedFeedback ? [submittedFeedback] : [])
      }
      if (pathname.endsWith('/shipment-tracking')) return reply(route, [{
        id: 'asn-1', purchaseOrderId: 'order-1', purchaseOrderCode: 'CGDD-UI-001',
        shipmentNo: 'SUP-DELIVERY-001', asnNo: 'ASN-UI-001',
        logisticsNo: 'TRACK-UI-001', logisticsCompany: '测试承运商',
        status: '30', statusName: '部分入库',
        eventTime: '2026-10-16T10:00:00', arrivalDate: '2026-10-18T10:00:00',
        lines: [{
          id: 11, purchaseOrderItemId: 'line-1', materialId: 'material-1',
          batchNo: 'BATCH-UI-001', arrivalQuantity: 10.25,
          receivedQuantity: 6.1, qualifiedQuantity: 5.8, pendingReceiptQuantity: 4.15
        }]
      }])
    }
    if (request.method() === 'POST') {
      const payload = request.postDataJSON()
      writes.push({ pathname, payload })
      if (pathname.endsWith('/sourcing/quote')) {
        quoteCount++
        inquiries[0].quotes.unshift({
          id: 'own-quote-v2', supplierId: '101', version: 2, ...payload, selected: false
        })
        return reply(route, true)
      }
      if (pathname.endsWith('/supplier/delivery-feedback')) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (initiatorMissing) return reply(route, null, 409, '交期反馈审批的内部代发身份尚未配置，请联系采购人员')
        if (feedbackFailure) return reply(route, null, 409, '采购订单行反馈版本已变化，请刷新后重试')
        submittedFeedback = {
          id: 'feedback-ui', feedbackNo: 'JQ-UI-001', status: 'APPROVING',
          items: payload.items, createTime: '2026-10-16T10:00:00'
        }
        return reply(route, 'feedback-ui')
      }
    }
    errors.push(`Unexpected business request: ${request.method()} ${pathname}`)
    return reply(route, null, 500, 'Unexpected UI fixture request')
  })
  await page.goto(new URL('sourcing', base).href)
  const row = (no) => page.locator('.el-table__body-wrapper .el-table__row')
    .filter({ hasText: no }).first()
  await row('XJ-UI-OPEN').waitFor()
  check('已审批和截止询价关闭报价入口',
    await row('XJ-UI-APPROVED').getByRole('button', { name: '报价', exact: true }).isDisabled() &&
    await row('XJ-UI-EXPIRED').getByRole('button', { name: '报价', exact: true }).isDisabled())
  await row('XJ-UI-APPROVED').locator('.el-table__expand-icon').click()
  await page.getByText('已选中', { exact: true }).waitFor()
  check('供应商可回看自身报价版本和选中结果',
    (await page.locator('.supplier-sourcing__quotes').innerText()).includes('V3'))
  await row('XJ-UI-OPEN').getByRole('button', { name: '报价', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.el-input-number input').fill('1500')
  await dialog.locator('textarea').fill('UI 版本回归')
  await dialog.getByRole('button', { name: '提交报价', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  check('真实报价弹窗提交当前询价并保留独立门户请求',
    quoteCount === 1 && writes[0].payload.sourcingId === 'inquiry-open' &&
    writes[0].payload.totalAmount === 1500)
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)
    check(`${width}px 询价页面无全局横向溢出`, !overflow)
    const screenshot = path.join(output, `supplier-sourcing-${width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    evidence.screenshots.push(screenshot)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(new URL('delivery-feedback', base).href)
  await row('CGDD-UI-001').waitFor()
  check('订单行承诺交期可回显，不再恒为占位符',
    (await row('CGDD-UI-001').innerText()).includes('2026/11/1'))
  const dateInput = row('CGDD-UI-001').locator('.el-date-editor input')
  await dateInput.fill('2026-11-12 10:00:00')
  await dateInput.press('Tab')
  const submit = row('CGDD-UI-001').getByRole('button', { name: '提交', exact: true })
  await submit.click()
  check('交期提交过程中阻止重复点击', await submit.isDisabled())
  await page.getByText('交期反馈审批的内部代发身份尚未配置，请联系采购人员', { exact: true }).waitFor()
  check('内部代发身份未就绪时展示拒绝原因并保留交期草稿',
    (await dateInput.inputValue()).includes('2026-11-12') && !(await submit.isDisabled()))
  initiatorMissing = false
  await submit.click()
  await page.getByText('采购订单行反馈版本已变化，请刷新后重试', { exact: true }).waitFor()
  check('交期提交失败保留输入内容和可重试入口',
    (await dateInput.inputValue()).includes('2026-11-12') && !(await submit.isDisabled()))
  const failedPayload = writes.at(-1).payload
  check('交期请求包含订单行下一版本，不使用全供应商版本',
    failedPayload.items.length === 1 &&
    failedPayload.items[0].orderId === 'order-1' &&
    failedPayload.items[0].orderItemId === 'line-1' &&
    failedPayload.items[0].version === 4)
  feedbackFailure = false
  await submit.click()
  await page.getByText('JQ-UI-001', { exact: true }).waitFor()
  check('成功后显示订单行版本反馈并清理已提交草稿',
    (await page.locator('main').innerText()).includes('line-1 / V4') &&
    (await dateInput.inputValue()) === '')
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const screenshot = path.join(output, `supplier-delivery-feedback-${width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    evidence.screenshots.push(screenshot)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(new URL('shipment-tracking', base).href)
  await row('SUP-DELIVERY-001').waitFor()
  check('发货跟踪区分送货单和ASN并显示真实订单号及中文状态',
    (await row('SUP-DELIVERY-001').innerText()).includes('ASN-UI-001') &&
    (await row('SUP-DELIVERY-001').innerText()).includes('CGDD-UI-001') &&
    (await row('SUP-DELIVERY-001').innerText()).includes('部分入库'))
  await row('SUP-DELIVERY-001').locator('.el-table__expand-icon').click()
  await page.getByText('BATCH-UI-001', { exact: true }).waitFor()
  check('发货行展开显示批次、到货、收货、合格与待收数量',
    (await page.locator('.supplier-shipment-tracking__lines').innerText()).includes('4.15') &&
    (await page.locator('.supplier-shipment-tracking__lines').innerText()).includes('5.8'))
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 })
    check(`${width}px 发货跟踪无全局横向溢出`, !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)))
    const screenshot = path.join(output, `supplier-shipment-tracking-${width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    evidence.screenshots.push(screenshot)
  }
  check('浏览器无运行错误且所有业务请求均被本地夹具拦截', errors.length === 0)
  evidence.status = 'PASS'
} catch (error) {
  evidence.status = 'FAIL'
  evidence.error = error.stack
  evidence.domFacts = await page.evaluate(() => ({
    path: location.pathname,
    rows: [...document.querySelectorAll('.el-table__row')].map((row) => ({
      text: row.textContent,
      visible: Boolean(row.getClientRects().length),
      parent: row.parentElement?.parentElement?.parentElement?.className
    })),
    bodyWrappers: document.querySelectorAll('.el-table__body-wrapper').length
  })).catch(() => null)
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  evidence.errors = errors
  evidence.writes = writes
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  await browser.close()
}
console.log(`${evidence.status}: ${evidence.checks.length} UI contract checks; ${output}/result.json`)
