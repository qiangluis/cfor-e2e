#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const chromePath =
  process.env.CFOR_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const webBase = (process.env.CFOR_CUSTOMER_WEB_BASE || 'http://127.0.0.1:9153/customer').replace(
  /\/+$/,
  ''
)

const browser = await chromium.launch({
  headless: process.env.CFOR_E2E_HEADLESS !== 'false',
  executablePath: chromePath,
  args: ['--disable-dev-shm-usage']
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  locale: 'zh-CN'
})
// 共享 runner 已支持 CFOR_E2E_BROWSER_TIMEOUT_MS，这里保持一致，避免高负载下误判。
context.setDefaultTimeout(Number(process.env.CFOR_E2E_BROWSER_TIMEOUT_MS || 30000))
const page = await context.newPage()
const requests = []
let twoFactorEnabled = false
const customerOrders = [
  {
    id: 'sale-order-1',
    billNo: 'XSDD-PORTAL-001',
    billDate: '2026-09-30T09:00:00',
    orderTime: '2026-09-30T09:00:00',
    totalCount: '10',
    totalPrice: '1234.56',
    outCount: '0',
    version: '1',
    remark: '请确认交期',
    lines: [
      {
        id: 'sale-order-item-1',
        entryNo: 1,
        productName: '测试成品',
        count: '10',
        productTaxPrice: '123.46',
        totalPrice: '1234.56',
        outCount: '0'
      }
    ]
  },
  {
    id: 'sale-order-2',
    billNo: 'XSDD-PORTAL-002',
    billDate: '2026-09-30T10:00:00',
    orderTime: '2026-09-30T10:00:00',
    totalCount: '5',
    totalPrice: '500.00',
    outCount: '0',
    version: '2',
    lines: []
  }
]
const customerDeliveries = [
  {
    id: 'sale-out-1',
    no: 'CK2609300001',
    status: 20,
    outTime: '2026-09-30T14:00:00',
    orderId: 'sale-order-1',
    orderNo: 'XSDD-PORTAL-001',
    totalCount: '10',
    totalPrice: '1234.56',
    logisticsCompany: '顺丰',
    portalReceiptStatus: null
  }
]
const customerReconciliations = [
  {
    id: 'reconciliation-1',
    billNo: 'XSDZ-20260930-001',
    billDate: '2026-09-30T12:00:00',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    status: 'PENDING_CUSTOMER_CONFIRM',
    statusName: '待客户确认',
    version: 1,
    totalEnterpriseQty: '10',
    totalEnterpriseAmount: '1000.00',
    remainingInvoiceAmount: '1000.00',
    lines: [
      {
        id: 'reconciliation-entry-1',
        entryNo: 1,
        sourceOutNo: 'CK2609300001',
        outQty: '10',
        enterpriseConfirmedQty: '10',
        enterpriseConfirmedPrice: '100.00',
        enterpriseConfirmedTaxPrice: '113.00',
        enterpriseConfirmedAmount: '1000.00',
        remainingInvoiceAmount: '1000.00',
        lineStatus: 'PENDING_CUSTOMER_CONFIRM'
      }
    ]
  }
]

const customerInvoices = [
  {
    id: 'invoice-1',
    billNo: 'FP-PORTAL-001',
    billDate: '2026-09-30T12:00:00',
    billStage: 'CONFIRMED',
    isEffective: 1,
    invoiceType: 1,
    invoiceMoney: '1000.00',
    isRubric: 0,
    companyName: '测试客户',
    fileUrl: 'https://files.cfor.local/invoice-1.pdf'
  }
]

const invoiceReceipts = []

/** 1x1 PNG，用于触发 PB-164 签收凭证上传。 */
const voucherPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
)

try {
  await page.route('**/customer/config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projectName: '奇工智造',
        enableTenant: true,
        projectApi: '',
        projectUrl: '/admin-api'
      })
    })
  })
  await page.route('**/customer-api/customer/auth/login', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postData() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          userId: '8001',
          basePartnerId: '9101',
          partnerName: '测试客户',
          accessToken: 'customer-access-token',
          refreshToken: 'customer-refresh-token',
          expiresTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          tenantId: '1001'
        }
      })
    })
  })
  await page.route('**/customer-api/customer/auth/logout', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/customer-api/customer/workbench/summary', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          basePartnerId: '9101',
          partnerName: '测试客户',
          totalTransactionAmount: '1234.56',
          payableBalance: '800.00',
          pendingConfirmOrderCount: 2,
          pendingReconciliationCount: 1,
          invoiceCount: 1,
          pendingReceiptDeliveryCount: 1,
          overdueReceivableCount: 0,
          openFeedbackCount: 1
        }
      })
    })
  })
  await page.route('**/customer-api/customer/notify/unread-count', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 1 })
    })
  })
  await page.route('**/customer-api/customer/notify/unread-list**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: [
          {
            id: 'notice-1',
            templateNickname: '销售协同',
            templateContent: '销售订单已发布，请及时确认。',
            readStatus: false,
            createTime: '2026-09-30T10:00:00'
          }
        ]
      })
    })
  })
  await page.route('**/customer-api/customer/notify/read-all', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/customer-api/customer/sale-order/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const url = new URL(route.request().url())
    const keyword = url.searchParams.get('keyword')
    const list = customerOrders.filter((order) => !keyword || order.billNo.includes(keyword))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list, total: list.length } })
    })
  })
  await page.route('**/customer-api/customer/sale-order/get**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const id = new URL(route.request().url()).searchParams.get('id')
    const order = customerOrders.find((item) => item.id === id)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: order })
    })
  })
  await page.route('**/customer-api/customer/sale-order/confirm', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 1 })
    })
  })
  await page.route('**/customer-api/customer/sale-order/reject', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 2 })
    })
  })
  await page.route('**/customer-api/customer/delivery/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list: customerDeliveries, total: customerDeliveries.length } })
    })
  })
  await page.route('**/customer-api/customer/delivery/get**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const id = new URL(route.request().url()).searchParams.get('id')
    const delivery = customerDeliveries.find((item) => item.id === id)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: delivery })
    })
  })
  await page.route('**/customer-api/customer/delivery/receipt', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 9 })
    })
  })
  await page.route('**/customer-api/customer/reconciliation/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: { list: customerReconciliations, total: customerReconciliations.length }
      })
    })
  })
  await page.route('**/customer-api/customer/reconciliation/get**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const id = new URL(route.request().url()).searchParams.get('id')
    const reconciliation = customerReconciliations.find((item) => item.id === id)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: reconciliation })
    })
  })
  await page.route('**/customer-api/customer/reconciliation/confirm', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/customer-api/customer/invoice/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list: customerInvoices, total: customerInvoices.length } })
    })
  })
  // PB-164 签收凭证/异常证据上传：客户门户独立文件通道，先校验门户会话再落文件资产
  await page.route('**/customer-api/customer/file/upload', async (route) => {
    const request = route.request()
    requests.push({
      url: request.url(),
      headers: request.headers(),
      body: request.postData() || ''
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 'https://files.cfor.local/voucher.png' })
    })
  })
  // PB-168 发票接收状态回执：只记录门户回执，不回写发票财务字段
  await page.route('**/customer-api/customer/invoice/receipt/list**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: invoiceReceipts })
    })
  })
  await page.route('**/customer-api/customer/invoice/receipt', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 7 })
    })
  })
  await page.route('**/customer-api/customer/invoice/request', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 5 })
    })
  })
  await page.route('**/customer-api/customer/receivable/summary', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: { payableBalance: '800.00', overdueAmount: '0.00', outstandingCount: 2, settledAmount: '200.00' }
      })
    })
  })
  await page.route('**/customer-api/customer/receivable/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list: [], total: 0 } })
    })
  })
  await page.route('**/customer-api/customer/feedback/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list: [], total: 0 } })
    })
  })
  await page.route('**/customer-api/customer/feedback/create', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 7 })
    })
  })
  // PB-158 账号安全：授权到期、改密与二次认证
  await page.route('**/customer-api/customer/auth/security', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          loginName: 'customer01',
          expireAt: '2027-09-30T00:00:00',
          passwordUpdatedAt: '2026-09-30T09:00:00',
          passwordExpireDays: 0,
          twoFactorEnabled
        }
      })
    })
  })
  await page.route('**/customer-api/customer/auth/change-password', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/customer-api/customer/auth/two-factor/bind', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/CFOR:customer01?secret=JBSWY3DPEHPK3PXP&issuer=CFOR',
          account: 'customer01'
        }
      })
    })
  })
  await page.route('**/customer-api/customer/auth/two-factor/enable', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    twoFactorEnabled = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })

  await page.goto(`${webBase}/login?tenantId=1001`, { waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('请输入客户账号').waitFor({ state: 'visible' })
  await page.getByPlaceholder('请输入客户账号').fill('customer01')
  await page.getByPlaceholder('请输入密码').fill('customer-pass-123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/customer/workbench')

  assert.equal(requests[0]?.headers['tenant-id'], '1001')
  assert.equal(requests[0]?.headers['x-api-encrypt'], 'true')
  assert.notEqual(
    requests[0]?.body,
    JSON.stringify({ loginName: 'customer01', password: 'customer-pass-123' })
  )
  // 客户门户只能命中 /customer-api，不能命中 /admin-api 或 /supplier-api
  assert.ok(requests.every((request) => !request.url.includes('/admin-api')))
  assert.ok(requests.every((request) => !request.url.includes('/supplier-api')))
  assert.ok(requests.every((request) => request.url.includes('/customer-api')))

  const storage = await page.evaluate(() => ({
    customer: window.localStorage.getItem('CFOR_CUSTOMER_PORTAL_SESSION'),
    supplier: window.localStorage.getItem('CFOR_SUPPLIER_PORTAL_SESSION'),
    admin: window.localStorage.getItem('ACCESS_TOKEN'),
    refresh: window.localStorage.getItem('REFRESH_TOKEN')
  }))
  assert.ok(storage.customer)
  assert.equal(storage.supplier, null)
  assert.equal(storage.admin, null)
  assert.equal(storage.refresh, null)

  await page.getByText('测试客户', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.customer-workbench__summary-item').nth(0).getByText('¥1,234.56').waitFor({
    state: 'visible'
  })
  await page.locator('.customer-workbench__summary-item').nth(1).getByText('¥800.00').waitFor({
    state: 'visible'
  })
  await page.getByText('销售订单已发布，请及时确认。', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '全部已读' }).click()
  await page.getByText('当前暂无未读消息', { exact: true }).waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.endsWith('/customer/workbench/summary')))
  assert.ok(requests.some((request) => request.url.endsWith('/customer/notify/read-all')))

  await page.getByRole('link', { name: '销售订单' }).click()
  await page.waitForURL('**/customer/orders')
  await page.getByText('XSDD-PORTAL-001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '详情' }).first().click()
  await page.getByText('销售订单详情', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('测试成品', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.el-dialog__headerbtn').first().click()

  await page.getByRole('button', { name: '确认', exact: true }).first().click()
  await page.locator('.el-message-box__btns .el-button--primary').click()
  await page.getByText('已确认订单').first().waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '驳回' }).first().click()
  await page.getByPlaceholder('请输入驳回原因').fill('交期需要提前')
  await page.locator('.el-dialog').getByRole('button', { name: '提交' }).click()
  await page.getByText('已驳回订单').first().waitFor({ state: 'visible' })
  const rejectRequest = requests.find((request) => request.url.endsWith('/customer/sale-order/reject'))
  assert.equal(rejectRequest?.body?.reason, '交期需要提前')
  assert.ok(rejectRequest?.body?.idempotencyKey)

  await page.getByRole('link', { name: '发货签收' }).click()
  await page.waitForURL('**/customer/deliveries')
  await page.getByText('CK2609300001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '签收' }).first().click()
  // PB-164：签收凭证先走门户独立文件通道，再随签收确认一起落库
  await page
    .locator('.el-dialog input[type="file"]')
    .first()
    .setInputFiles({ name: 'voucher.png', mimeType: 'image/png', buffer: voucherPng })
  await page.getByText('凭证上传成功', { exact: false }).first().waitFor({ state: 'visible' })
  const uploadRequest = requests.find((request) => request.url.endsWith('/customer/file/upload'))
  assert.ok(uploadRequest, 'PB-164 签收凭证必须通过 /customer/file/upload 上传')
  assert.ok(
    String(uploadRequest?.body || '').includes('RECEIPT'),
    'PB-164 上传场景必须声明 RECEIPT'
  )
  await page.locator('.el-dialog').getByRole('button', { name: '确认签收' }).click()
  await page.getByText('签收已提交').first().waitFor({ state: 'visible' })
  const receiptRequest = requests.find((request) => request.url.endsWith('/customer/delivery/receipt'))
  assert.equal(receiptRequest?.body?.receiptType, 'RECEIVED')
  assert.ok(receiptRequest?.body?.idempotencyKey)
  assert.equal(receiptRequest?.body?.attachmentUrl, 'https://files.cfor.local/voucher.png')
  assert.equal(receiptRequest?.body?.attachmentName, 'voucher.png')

  await page.getByRole('link', { name: '销售对账' }).click()
  await page.waitForURL('**/customer/reconciliations')
  await page.getByText('XSDZ-20260930-001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '确认/驳回' }).first().click()
  await page.getByText('对账单详情', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('CK2609300001', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.el-dialog').getByRole('button', { name: '确认对账' }).click()
  await page.locator('.el-message-box__btns .el-button--primary').click()
  await page.getByText('对账已确认').first().waitFor({ state: 'visible' })
  const confirmRequest = requests.find((request) =>
    request.url.endsWith('/customer/reconciliation/confirm')
  )
  assert.equal(confirmRequest?.body?.lines?.[0]?.id, 'reconciliation-entry-1')

  await page.getByRole('link', { name: '发票与开票' }).click()
  await page.waitForURL('**/customer/invoices')
  await page.getByText('发票与开票', { exact: true }).first().waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '开票申请' }).click()
  await page.locator('.el-dialog').getByRole('button', { name: '提交申请' }).click()
  await page.getByText('申请金额必须大于 0').first().waitFor({ state: 'visible' })
  // 校验失败不会自动关闭弹窗，先收起再切页，避免遮罩拦截后续点击
  await page.locator('.el-dialog').getByRole('button', { name: '取消' }).click()
  await page.locator('.el-overlay').first().waitFor({ state: 'hidden' })

  // PB-168：发票接收状态回执只记录客户反馈，不改动发票本身
  await page.getByText('FP-PORTAL-001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '反馈接收' }).first().click()
  await page.getByText('反馈发票接收状态', { exact: true }).waitFor({ state: 'visible' })
  // 原生 radio 被样式层覆盖，点击可见的 el-radio 标签
  await page.locator('.el-dialog .el-radio', { hasText: '有异议' }).click()
  await page.getByRole('textbox', { name: '反馈说明' }).fill('发票金额与对账单不一致')
  await page.locator('.el-dialog').getByRole('button', { name: '提交反馈' }).click()
  await page.getByText('接收状态已反馈', { exact: false }).first().waitFor({ state: 'visible' })
  const invoiceReceiptRequest = requests.find((request) =>
    request.url.endsWith('/customer/invoice/receipt')
  )
  assert.equal(invoiceReceiptRequest?.body?.invoiceId, 'invoice-1')
  assert.equal(invoiceReceiptRequest?.body?.receiveStatus, 'DISPUTED')
  assert.equal(invoiceReceiptRequest?.body?.receiveNote, '发票金额与对账单不一致')
  assert.ok(invoiceReceiptRequest?.body?.idempotencyKey)
  assert.ok(
    requests.some((request) => request.url.endsWith('/customer/invoice/receipt/list')),
    'PB-168 页面必须回读接收状态列表'
  )

  await page.getByRole('link', { name: '结算与收款' }).click()
  await page.waitForURL('**/customer/receivables')
  await page.getByText('应付企业余额', { exact: true }).waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.endsWith('/customer/receivable/summary')))

  await page.getByRole('link', { name: '服务反馈' }).click()
  await page.waitForURL('**/customer/feedback')
  await page.getByRole('button', { name: '提交反馈' }).click()
  await page.getByPlaceholder('请输入问题描述').fill('到货包装破损')
  await page.locator('.el-dialog').getByRole('button', { name: '提交' }).click()
  await page.getByText('反馈已提交').first().waitFor({ state: 'visible' })
  const feedbackRequest = requests.find((request) => request.url.endsWith('/customer/feedback/create'))
  assert.ok(feedbackRequest?.body?.idempotencyKey)

  // PB-158 账号安全：授权到期显示、改密与二次认证绑定
  await page.getByRole('link', { name: '安全设置' }).click()
  await page.waitForURL('**/customer/security')
  await page.getByRole('heading', { name: '安全设置' }).waitFor({ state: 'visible' })
  await page.getByText('customer01', { exact: true }).waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.endsWith('/customer/auth/security')))

  const passwordPanel = page.locator('.customer-security__panel').nth(1)
  await passwordPanel.locator('input').nth(0).fill('customer-pass-123')
  await passwordPanel.locator('input').nth(1).fill('customer-pass-456')
  await passwordPanel.locator('input').nth(2).fill('customer-pass-456')
  await page.getByRole('button', { name: '保存新密码' }).click()
  await page.getByText('密码已更新', { exact: true }).first().waitFor({ state: 'visible' })
  const changePasswordRequest = requests.find((request) =>
    request.url.endsWith('/customer/auth/change-password')
  )
  assert.equal(changePasswordRequest?.body?.currentPassword, 'customer-pass-123')
  assert.equal(changePasswordRequest?.body?.newPassword, 'customer-pass-456')

  await page.getByRole('button', { name: '生成绑定密钥' }).click()
  await page.getByText('JBSWY3DPEHPK3PXP', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.customer-security__binding input').first().fill('123456')
  await page.getByRole('button', { name: '确认启用' }).click()
  await page.getByText('二次认证已开启', { exact: true }).first().waitFor({ state: 'visible' })
  await page.getByText('已开启', { exact: true }).waitFor({ state: 'visible' })
  const enableTwoFactorRequest = requests.find((request) =>
    request.url.endsWith('/customer/auth/two-factor/enable')
  )
  assert.equal(enableTwoFactorRequest?.body?.code, '123456')

  await page.getByRole('button', { name: '退出' }).click()
  await page.waitForURL('**/customer/login')
  const customerSession = await page.evaluate(() =>
    window.localStorage.getItem('CFOR_CUSTOMER_PORTAL_SESSION')
  )
  assert.equal(customerSession, null)
  const logoutRequest = requests.find((request) => request.url.endsWith('/customer/auth/logout'))
  assert.equal(logoutRequest?.headers.authorization, 'Bearer customer-access-token')

  console.log(
    'PASS customer portal isolated login, storage, order, delivery receipt voucher, reconciliation, invoice receipt and feedback'
  )
} finally {
  await context.close()
  await browser.close()
}
