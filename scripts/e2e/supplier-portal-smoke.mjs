#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const chromePath =
  process.env.CFOR_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const webBase = (process.env.CFOR_SUPPLIER_WEB_BASE || 'http://127.0.0.1:9152/supplier').replace(
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
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const requests = []
const acceptInviteRequests = []

// 打印通过隐藏 iframe 渲染，断言同一帧内包含全部关键字以确认打印内容生成（PB-133 打印要求）。
const waitForPrintFrame = async (expectedTexts) => {
  const expected = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts]
  await page.waitForFunction(
    (keywords) =>
      Array.from(document.querySelectorAll('iframe[aria-hidden="true"]')).some((frame) => {
        try {
          const text =
            frame.contentDocument?.body?.innerText || frame.contentDocument?.body?.textContent || ''
          return keywords.every((keyword) => text.includes(keyword))
        } catch {
          return false
        }
      }),
    expected,
    { timeout: 5000 }
  )
}

const portalOrders = [
  {
    id: 'purchase-order-1',
    billNo: 'CGDD-PORTAL-001',
    orderTime: '2026-09-30T09:00:00',
    expectedArrivalTime: '2026-10-03T09:00:00',
    totalCount: '10',
    totalPrice: '1234.56',
    portalStatus: 'SENT',
    portalVersion: 1,
    remark: '请按订单要求供货。',
    items: [
      {
        id: 'purchase-order-item-1',
        productCode: 'MAT-001',
        productName: '测试材料',
        productModel: 'M-01',
        unitName: '件',
        count: '10',
        totalPrice: '1234.56'
      }
    ]
  },
  {
    id: 'purchase-order-2',
    billNo: 'CGDD-PORTAL-002',
    orderTime: '2026-09-30T10:00:00',
    expectedArrivalTime: '2026-10-04T09:00:00',
    totalCount: '5',
    totalPrice: '500.00',
    portalStatus: 'SENT',
    portalVersion: 2,
    remark: '请确认交期。',
    items: []
  }
]
const portalReconciliations = [
  {
    id: 'reconciliation-1',
    billNo: 'CGDZ-20260930-001',
    billDate: '2026-09-30T12:00:00',
    supplierName: '测试供应商',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    status: 'PENDING_INVOICE',
    statusName: '待开票',
    totalShippedQty: '10',
    totalReceivedQty: '8',
    totalConfirmedQty: '8',
    totalAmount: '1000.00',
    invoicedAmount: '200.00',
    remainingInvoiceAmount: '800.00',
    lines: [
      {
        id: 'reconciliation-line-1',
        entryNo: 1,
        sourceNoticeCode: 'ASN2609300001',
        purchaseOrderId: 'purchase-order-1',
        shippedQty: '10',
        receivedQty: '8',
        confirmedQty: '8',
        confirmedPrice: '125.00',
        confirmedAmount: '1000.00',
        remainingInvoiceAmount: '800.00',
        lineStatus: 'PENDING_INVOICE'
      }
    ]
  }
]
const portalReconciliationAvailableLines = [
  {
    sourceNoticeId: '9002',
    sourceNoticeLineId: '9201',
    sourceNoticeCode: 'ASN2609300002',
    purchaseOrderId: 'purchase-order-2',
    purchaseOrderItemId: 'purchase-order-item-2',
    shippedQty: '5',
    receivedQty: '5',
    confirmedQty: '5',
    confirmedPrice: '100.00',
    lineStatus: 'PENDING_CONFIRM'
  }
]
const portalApplicablePayables = [
  {
    payableId: 'payable-1',
    payableBillNo: 'YF-20260930-001',
    payableDate: '2026-09-30T12:00:00',
    payableType: '201',
    entryId: 'payable-entry-1',
    entryNo: 1,
    srcNo: 'FP-PORTAL-001',
    materialId: 'material-1',
    materialCode: 'MAT-001',
    materialName: '测试材料',
    materialModel: 'M-01',
    unitName: '件',
    qty: '4',
    price: '100.00',
    amt: '400.00',
    checkedAmt: '0.00',
    reservedAmt: '0.00',
    availableAmt: '400.00',
    collectionTime: '2026-10-10T00:00:00'
  }
]
const portalPaymentRequests = []
const portalOutsourceOrders = [
  {
    id: 'outsource-order-1',
    billNo: 'WWDD-PORTAL-001',
    materialCode: 'SEMI-001',
    materialName: '外协半成品',
    unitName: '件',
    planQty: '100',
    sendQty: '80',
    inQty: '20',
    latestCompletedQty: '20',
    latestProgressPercent: '20',
    processPrice: '12.50',
    totalAmount: '1250.00',
    outsourceStatus: 'EXECUTING',
    expectedFinishTime: '2026-10-06T18:00:00',
    releaseTime: '2026-09-30T09:30:00',
    releaseNotifyStatus: 'SENT',
    openWarningCount: 1,
    items: [
      {
        id: 'outsource-item-1',
        materialCode: 'SEMI-001',
        materialName: '外协半成品',
        unitName: '件',
        planQty: '100',
        sendQty: '80',
        inQty: '20',
        expectedFinishTime: '2026-10-06T18:00:00'
      }
    ],
    warnings: [
      {
        id: 'warning-1',
        outsourceId: 'outsource-order-1',
        billNo: 'WWDD-PORTAL-001',
        warningType: 'DUE_SOON',
        dueTime: '2026-10-06T18:00:00',
        status: 'OPEN',
        notifyStatus: 'SENT'
      }
    ],
    progressList: [
      {
        id: 'progress-1',
        outsourceId: 'outsource-order-1',
        feedbackType: 'PROGRESS',
        progressPercent: '20',
        completedQty: '20',
        reportedAt: '2026-09-30T16:00:00'
      }
    ]
  }
]

try {
  await page.route('**/supplier/config.json', async (route) => {
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
  await page.route('**/supplier-api/erp/auth/accept-invite', async (route) => {
    const request = route.request()
    acceptInviteRequests.push({
      url: request.url(),
      headers: request.headers(),
      body: request.postData()
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 'supplier01' })
    })
  })
  await page.route('**/supplier-api/erp/auth/login', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postData() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          userId: '7001',
          basePartnerId: '9001',
          partnerName: '测试供应商',
          accessToken: 'supplier-access-token',
          refreshToken: 'supplier-refresh-token',
          expiresTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          tenantId: '1001'
        }
      })
    })
  })
  await page.route('**/supplier-api/erp/auth/logout', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/supplier-api/erp/workbench/summary', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          basePartnerId: '9001',
          partnerName: '测试供应商',
          totalTransactionAmount: '1234.56',
          receivableBalance: '800.00',
          pendingCollectionAmount: '600.00',
          pendingCollectionCount: 2,
          auditedOrderCount: 3,
          auditedOrderAmount: '1234.56'
        }
      })
    })
  })
  await page.route('**/supplier-api/erp/notify/unread-count', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 1 })
    })
  })
  await page.route('**/supplier-api/erp/notify/unread-list**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: [
          {
            id: 'notice-1',
            templateNickname: '采购协同',
            templateContent: '采购订单已发送，请及时确认。',
            readStatus: false,
            createTime: '2026-09-30T10:00:00'
          }
        ]
      })
    })
  })
  await page.route('**/supplier-api/erp/notify/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          list: [
            {
              id: 'notice-1',
              templateNickname: '采购协同',
              templateContent: '采购订单已发送，请及时确认。',
              readStatus: false,
              createTime: '2026-09-30T10:00:00'
            }
          ],
          total: 1
        }
      })
    })
  })
  await page.route('**/supplier-api/erp/notify/read-all', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/supplier-api/erp/purchase-orders/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const url = new URL(route.request().url())
    const portalStatus = url.searchParams.get('portalStatus')
    const billNo = url.searchParams.get('billNo')
    const list = portalOrders.filter(
      (order) =>
        (!portalStatus || order.portalStatus === portalStatus) &&
        (!billNo || order.billNo.includes(billNo))
    )
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list, total: list.length } })
    })
  })
  await page.route('**/supplier-api/erp/purchase-orders/get**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const id = new URL(route.request().url()).searchParams.get('id')
    const order = portalOrders.find((item) => item.id === id)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: order })
    })
  })
  await page.route('**/supplier-api/erp/purchase-orders/accept**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const id = new URL(route.request().url()).searchParams.get('id')
    const order = portalOrders.find((item) => item.id === id)
    if (order) order.portalStatus = 'ACCEPTED'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/supplier-api/erp/purchase-orders/ship**', async (route) => {
    const request = route.request()
    const body = request.postDataJSON()
    requests.push({ url: request.url(), headers: request.headers(), body })
    const id = new URL(request.url()).searchParams.get('id')
    const order = portalOrders.find((item) => item.id === id)
    if (order) order.portalStatus = 'SHIPPED'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          arrivalNoticeId: 9001,
          arrivalNoticeCode: 'ASN2609300001',
          arrivalNoticeStatus: 20,
          portalStatus: 'SHIPPED'
        }
      })
    })
  })
  await page.route('**/supplier-api/erp/purchase-orders/reject**', async (route) => {
    const request = route.request()
    const body = request.postDataJSON()
    requests.push({ url: request.url(), headers: request.headers(), body })
    const id = new URL(request.url()).searchParams.get('id')
    const order = portalOrders.find((item) => item.id === id)
    if (order) {
      order.portalStatus = 'REJECTED'
      order.portalRejectReason = body?.reason
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: true })
    })
  })
  await page.route('**/supplier-api/erp/reconciliations/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const url = new URL(route.request().url())
    const status = url.searchParams.get('status')
    const billNo = url.searchParams.get('billNo')
    const list = portalReconciliations.filter(
      (item) => (!status || item.status === status) && (!billNo || item.billNo.includes(billNo))
    )
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list, total: list.length } })
    })
  })
  await page.route('**/supplier-api/erp/reconciliations/get**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const id = new URL(route.request().url()).searchParams.get('id')
    const reconciliation = portalReconciliations.find((item) => item.id === id)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: reconciliation })
    })
  })
  await page.route('**/supplier-api/erp/reconciliations/available-lines', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: portalReconciliationAvailableLines })
    })
  })
  await page.route('**/supplier-api/erp/reconciliations/create', async (route) => {
    const body = route.request().postDataJSON()
    requests.push({ url: route.request().url(), headers: route.request().headers(), body })
    portalReconciliations.unshift({
      id: 'reconciliation-2',
      billNo: 'CGDZ-PORTAL-002',
      billDate: '2026-10-01T10:00:00',
      supplierName: '测试供应商',
      periodStart: body?.periodStart,
      periodEnd: body?.periodEnd,
      status: 'PENDING_CONFIRM',
      statusName: '待企业确认',
      totalShippedQty: '5',
      totalReceivedQty: '5',
      totalConfirmedQty: '5',
      totalAmount: '500.00',
      invoicedAmount: '0.00',
      remainingInvoiceAmount: '500.00',
      slaStatus: 'NORMAL',
      slaDueDate: '2026-10-06',
      slaRemainingDays: 3,
      lines: []
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 'reconciliation-2' })
    })
  })
  await page.route('**/supplier-api/erp/purchase-invoices/invoiceable-lines**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: [
          {
            id: 'entry-1',
            entryNo: 1,
            sourceNoticeCode: 'ASN2609300001',
            purchaseOrderId: 'purchase-order-1',
            confirmedQty: '4',
            confirmedPrice: '100.00',
            remainingInvoiceQty: '4',
            remainingInvoiceAmount: '400.00',
            lineStatus: 'PENDING_INVOICE'
          }
        ]
      })
    })
  })
  await page.route('**/supplier-api/erp/purchase-invoices/submit', async (route) => {
    requests.push({
      url: route.request().url(),
      headers: route.request().headers(),
      body: JSON.parse(route.request().postData() || '{}')
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 'invoice-1' })
    })
  })
  await page.route('**/supplier-api/erp/files/upload', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 'https://cdn.example.com/invoice.png' })
    })
  })
  await page.route('**/supplier-api/erp/payment-requests/applicable-payables', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: portalApplicablePayables })
    })
  })
  await page.route('**/supplier-api/erp/payment-requests/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const url = new URL(route.request().url())
    const billNo = url.searchParams.get('billNo')
    const status = url.searchParams.get('status')
    const list = portalPaymentRequests.filter(
      (item) => (!billNo || item.billNo.includes(billNo)) && (!status || item.status === status)
    )
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list, total: list.length } })
    })
  })
  await page.route('**/supplier-api/erp/payment-requests', async (route) => {
    const request = route.request()
    const body = request.postDataJSON()
    requests.push({ url: request.url(), headers: request.headers(), body })
    const requestLines = (body?.lines || []).map((line, index) => ({
      id: `payment-request-line-${index + 1}`,
      requestId: 'payment-request-1',
      entryNo: index + 1,
      payableId: line.payableId,
      payableBillNo: 'YF-20260930-001',
      payableEntryId: line.entryId,
      amt: line.amount,
      checkedAmt: '0.00',
      materialName: '测试材料',
      materialModel: 'M-01'
    }))
    portalPaymentRequests.unshift({
      id: 'payment-request-1',
      billNo: 'FKSQ-PORTAL-001',
      billDate: '2026-10-01T10:00:00',
      amt: requestLines.reduce((sum, line) => sum + Number(line.amt || 0), 0),
      checkedAmt: '0.00',
      isRequest: 1,
      billStage: '14',
      isEffective: 0,
      status: 'PENDING_ENTERPRISE',
      statusName: '待企业确认',
      createTime: '2026-10-01T10:00:00',
      lines: requestLines
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 'payment-request-1' })
    })
  })
  await page.route('**/supplier-api/erp/outsource-orders/page**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const billNo = new URL(route.request().url()).searchParams.get('billNo')
    const list = portalOutsourceOrders.filter((order) => !billNo || order.billNo.includes(billNo))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { list, total: list.length } })
    })
  })
  await page.route('**/supplier-api/erp/outsource-orders/get**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    const id = new URL(route.request().url()).searchParams.get('id')
    const order = portalOutsourceOrders.find((item) => item.id === id)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: order })
    })
  })
  await page.route('**/supplier-api/erp/outsource-orders/warnings**', async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: portalOutsourceOrders[0].warnings })
    })
  })
  await page.route('**/supplier-api/erp/outsource-orders/progress**', async (route) => {
    const request = route.request()
    requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 1001 })
    })
  })

  await page.goto(`${webBase}/accept-invite?tenantId=1001&token=invite-token`, {
    waitUntil: 'domcontentloaded'
  })
  await page.getByText('设置门户登录密码', { exact: true }).waitFor({ state: 'visible' })
  await page.getByPlaceholder('至少 8 位').fill('supplier-pass-123')
  await page.getByPlaceholder('再次输入密码').fill('supplier-pass-123')
  await page.getByRole('button', { name: '设置密码并激活' }).click()
  await page.waitForURL('**/supplier/login?tenantId=1001&loginName=supplier01')
  assert.equal(acceptInviteRequests[0]?.headers['tenant-id'], '1001')
  assert.equal(acceptInviteRequests[0]?.headers['x-api-encrypt'], 'true')
  assert.notEqual(
    acceptInviteRequests[0]?.body,
    JSON.stringify({ token: 'invite-token', password: 'supplier-pass-123' })
  )
  assert.equal(await page.getByPlaceholder('请输入供应商账号').inputValue(), 'supplier01')

  await page.getByPlaceholder('请输入供应商账号').waitFor({ state: 'visible' })
  await page.getByPlaceholder('请输入密码').fill('supplier-pass-123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/supplier/workbench')

  assert.equal(requests[0]?.headers['tenant-id'], '1001')
  assert.equal(requests[0]?.headers['x-api-encrypt'], 'true')
  assert.notEqual(
    requests[0]?.body,
    JSON.stringify({ loginName: 'supplier01', password: 'supplier-pass-123' })
  )

  const storage = await page.evaluate(() => ({
    supplier: window.localStorage.getItem('CFOR_SUPPLIER_PORTAL_SESSION'),
    admin: window.localStorage.getItem('ACCESS_TOKEN'),
    refresh: window.localStorage.getItem('REFRESH_TOKEN')
  }))
  assert.ok(storage.supplier)
  assert.equal(storage.admin, null)
  assert.equal(storage.refresh, null)
  await page.getByText('测试供应商', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.supplier-workbench__summary-item').nth(0).getByText('¥1,234.56').waitFor({
    state: 'visible'
  })
  await page.locator('.supplier-workbench__summary-item').nth(1).getByText('¥800.00').waitFor({
    state: 'visible'
  })
  await page.locator('.supplier-workbench__summary-item').nth(2).getByText('¥600.00').waitFor({
    state: 'visible'
  })
  await page
    .getByText('采购订单已发送，请及时确认。', { exact: true })
    .waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '全部已读' }).click()
  await page.getByText('当前暂无未读消息', { exact: true }).waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.endsWith('/erp/notify/unread-count')))
  assert.ok(requests.some((request) => request.url.includes('/erp/notify/unread-list')))
  assert.ok(requests.some((request) => request.url.endsWith('/erp/workbench/summary')))
  assert.ok(requests.some((request) => request.url.endsWith('/erp/notify/read-all')))
  await page.getByRole('link', { name: '消息' }).click()
  await page.waitForURL('**/supplier/messages')
  await page.getByText('消息中心', { exact: true }).waitFor({ state: 'visible' })
  await page
    .getByText('采购订单已发送，请及时确认。', { exact: true })
    .waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.includes('/erp/notify/page')))

  await page.getByRole('link', { name: '采购订单' }).click()
  await page.waitForURL('**/supplier/orders')
  await page.getByText('采购订单', { exact: true }).first().waitFor({ state: 'visible' })
  await page.getByText('CGDD-PORTAL-001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('CGDD-PORTAL-002', { exact: true }).waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '详情' }).first().click()
  await page.getByText('采购订单详情', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('MAT-001', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.el-dialog__headerbtn').first().click()

  await page.getByRole('button', { name: '打印' }).first().click()
  await waitForPrintFrame(['采购订单', 'CGDD-PORTAL-001'])

  await page.getByRole('button', { name: '接单' }).first().click()
  await page.locator('.el-message-box__btns .el-button--primary').click()
  await page
    .locator('.el-table')
    .getByText('已接单', { exact: true })
    .first()
    .waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '发货' }).first().click()
  const shipDialog = page.locator('.el-dialog').filter({ hasText: '供应商发货' })
  await shipDialog.getByPlaceholder('物流或运单编号').fill('SF-001')
  await shipDialog.getByRole('button', { name: '确认发货' }).click()
  // 发货成功即生成供货单打印内容（PB-133 规则 3）。
  await waitForPrintFrame(['供货单', 'SF-001'])
  await page
    .locator('.el-table')
    .getByText('已发货', { exact: true })
    .first()
    .waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '拒单' }).first().click()
  await page.getByPlaceholder('请输入拒单原因').fill('交期无法满足')
  await page.getByRole('button', { name: '确认拒单' }).click()
  await page
    .locator('.el-table')
    .getByText('已拒单', { exact: true })
    .first()
    .waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.includes('/erp/purchase-orders/page')))
  assert.ok(requests.some((request) => request.url.includes('/erp/purchase-orders/get')))
  assert.ok(requests.some((request) => request.url.includes('/erp/purchase-orders/accept')))
  const shipmentRequest = requests.find((request) =>
    request.url.includes('/erp/purchase-orders/ship')
  )
  assert.equal(shipmentRequest?.body?.logisticsNo, 'SF-001')
  assert.equal(shipmentRequest?.body?.lines?.[0]?.purchaseOrderItemId, 'purchase-order-item-1')
  assert.ok(requests.some((request) => request.url.includes('/erp/purchase-orders/ship')))
  const rejectRequest = requests.find((request) =>
    request.url.includes('/erp/purchase-orders/reject')
  )
  assert.equal(rejectRequest?.body?.reason, '交期无法满足')

  await page.getByRole('link', { name: '委外订单' }).click()
  await page.waitForURL('**/supplier/outsource-orders')
  await page.getByText('WWDD-PORTAL-001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('1 条', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '详情' }).first().click()
  await page.getByText('委外订单详情', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('当前存在待处理预警', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.el-drawer__close-btn').click()

  await page.getByRole('button', { name: '反馈进度' }).first().click()
  await page.getByText('委外进度反馈', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '提交反馈' }).click()
  await page.getByText('进度反馈已提交', { exact: true }).waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.includes('/erp/outsource-orders/page')))
  assert.ok(requests.some((request) => request.url.includes('/erp/outsource-orders/get')))
  // 预警信息随委外订单详情一次性返回，页面不再单独请求 /warnings 列表
  const progressRequest = requests.find((request) =>
    request.url.includes('/erp/outsource-orders/progress')
  )
  assert.equal(progressRequest?.body?.feedbackType, 'PROGRESS')
  assert.ok(progressRequest?.body?.idempotencyKey)

  await page.getByRole('link', { name: '采购对账' }).click()
  await page.waitForURL('**/supplier/reconciliations')
  await page.getByText('CGDZ-20260930-001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('¥800.00', { exact: true }).first().waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '详情' }).first().click()
  await page.getByText('采购对账详情', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('ASN2609300001', { exact: true }).waitFor({ state: 'visible' })
  assert.ok(requests.some((request) => request.url.includes('/erp/reconciliations/page')))
  assert.ok(requests.some((request) => request.url.includes('/erp/reconciliations/get')))
  await page.locator('.el-drawer__close-btn').click()

  await page.getByRole('button', { name: '发起对账' }).click()
  await page.getByText('只展示已提交', { exact: false }).waitFor({ state: 'visible' })
  await page.getByText('ASN2609300002', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.el-dialog .el-table__body .el-checkbox__inner').first().click()
  await page.getByRole('button', { name: '提交对账' }).click()
  await page
    .getByText('对账单已发起，等待采购企业确认', { exact: true })
    .waitFor({ state: 'visible' })
  const createReconciliationRequest = requests.find((request) =>
    request.url.includes('/erp/reconciliations/create')
  )
  assert.deepEqual(createReconciliationRequest?.body?.sourceNoticeIds, ['9002'])
  assert.deepEqual(createReconciliationRequest?.body?.sourceNoticeLineIds, ['9201'])
  assert.equal(createReconciliationRequest?.body?.supplierId, undefined)

  await page.getByRole('link', { name: '发票登记' }).click()
  await page.waitForURL('**/supplier/invoices')
  await page.getByText('ASN2609300001', { exact: true }).waitFor({ state: 'visible' })
  // Element Plus 多选框的真实 input 被隐藏，需点击可见的 checkbox 外观元素
  await page.locator('.el-table__body .el-checkbox__inner').first().click()
  await page.getByPlaceholder('请输入发票号').fill('FP-PORTAL-001')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'invoice.png',
    mimeType: 'image/png',
    buffer: Buffer.from('invoice-image')
  })
  await page.getByText('发票附件上传成功', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '提交发票登记' }).click()
  await page
    .getByText('发票登记已提交，等待采购企业复核', { exact: true })
    .waitFor({ state: 'visible' })
  assert.ok(
    requests.some((request) => request.url.includes('/erp/purchase-invoices/invoiceable-lines'))
  )
  const invoiceRequest = requests.find((request) =>
    request.url.includes('/erp/purchase-invoices/submit')
  )
  assert.equal(invoiceRequest?.body?.invoiceNo, 'FP-PORTAL-001')
  assert.equal(invoiceRequest?.body?.fileUrl, 'https://cdn.example.com/invoice.png')
  assert.equal(invoiceRequest?.body?.lines?.[0]?.entryId, 'entry-1')
  assert.equal(invoiceRequest?.body?.lines?.[0]?.amount, 400)
  assert.ok(requests.some((request) => request.url.includes('/erp/files/upload')))

  await page.getByRole('link', { name: '付款申请' }).click()
  await page.waitForURL('**/supplier/payment-requests')
  await page.getByText('YF-20260930-001', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('FP-PORTAL-001', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.el-table__body .el-checkbox__inner').first().click()
  const paymentAmountInput = page
    .locator('.supplier-payment__panel')
    .first()
    .locator('.el-input-number input')
    .first()
  await paymentAmountInput.fill('320.50')
  await page.getByPlaceholder('申请备注（选填）').fill('10 月付款')
  await page.getByRole('button', { name: '提交付款申请' }).click()
  await page
    .getByText('付款申请已提交，等待企业确认', { exact: true })
    .waitFor({ state: 'visible' })
  await page.getByText('FKSQ-PORTAL-001', { exact: true }).waitFor({ state: 'visible' })
  assert.ok(
    requests.some((request) => request.url.includes('/erp/payment-requests/applicable-payables'))
  )
  assert.ok(requests.some((request) => request.url.includes('/erp/payment-requests/page')))
  const paymentRequest = requests.find(
    (request) => request.url.endsWith('/erp/payment-requests') && request.body?.lines?.length
  )
  assert.equal(paymentRequest?.body?.remark, '10 月付款')
  assert.equal(paymentRequest?.body?.lines?.[0]?.payableId, 'payable-1')
  assert.equal(paymentRequest?.body?.lines?.[0]?.entryId, 'payable-entry-1')
  assert.equal(paymentRequest?.body?.lines?.[0]?.amount, 320.5)

  await page.getByRole('button', { name: '退出' }).click()
  await page.waitForURL('**/supplier/login')
  const supplierSession = await page.evaluate(() =>
    window.localStorage.getItem('CFOR_SUPPLIER_PORTAL_SESSION')
  )
  assert.equal(supplierSession, null)
  const logoutRequest = requests.find((request) => request.url.endsWith('/erp/auth/logout'))
  assert.equal(logoutRequest?.headers.authorization, 'Bearer supplier-access-token')

  console.log('PASS supplier portal isolated login, storage and logout')
} finally {
  await context.close()
  await browser.close()
}
