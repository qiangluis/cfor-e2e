#!/usr/bin/env node

import { login, openRoute, saveScreenshot } from './lib/browser.mjs'
import { createApiClient } from './lib/api.mjs'

const { config } = await import('./config/index.mjs')
const { chromium } = await import('playwright-core')

const browser = await chromium.launch({
  headless: config.headless,
  executablePath: config.chromePath,
  args: ['--disable-dev-shm-usage']
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN'
})
const page = await context.newPage()
const outputDir = process.env.CFOR_E2E_OUT || '/tmp/cfor-e2e-pb145-payment-request'
const record = { api: [], screenshots: [], consoleErrors: [], pageErrors: [] }

try {
  const token = await login(page)
  const api = createApiClient({ token, record })

  // 1. 付款申请（isRequest=1）与正式付款单（isRequest=0）读侧均可查，属于同一条 fin_payment 事实
  const requestPage = await api.getBusiness(
    '/finance/finPayment/list?isRequest=1&pageNo=1&pageSize=100'
  )
  const requests = Array.isArray(requestPage?.data?.records) ? requestPage.data.records : null
  if (!requests) {
    throw new Error('付款申请分页未返回 records')
  }
  const paymentPage = await api.getBusiness(
    '/finance/finPayment/list?isRequest=0&pageNo=1&pageSize=100'
  )
  const payments = Array.isArray(paymentPage?.data?.records) ? paymentPage.data.records : null
  if (!payments) {
    throw new Error('付款单分页未返回 records')
  }

  // 2. 付款截图写侧门禁：付款申请单不允许上传付款截图，避免未审批申请挂载付款凭证
  const sampleRequest = requests.find((item) => item?.id)
  if (sampleRequest) {
    const response = await api.put('/finance/finPayment/updateScreenshot', {
      id: sampleRequest.id,
      attachment: '/e2e/pb145-should-be-blocked.png'
    })
    if (response?.code === 200) {
      throw new Error('付款申请单不应允许上传付款截图')
    }
  }

  // 3. 已完成付款的付款单允许回写付款截图；用原附件值回写，避免污染真实业务数据
  const executed = payments.find((item) => item?.id && item?.isEffective === 1)
  let screenshotVerified = false
  if (executed) {
    const response = await api.put('/finance/finPayment/updateScreenshot', {
      id: executed.id,
      attachment: executed.attachment || ''
    })
    if (response?.code !== 200) {
      throw new Error(`已完成付款的付款单应允许保存付款截图：${JSON.stringify(response)}`)
    }
    screenshotVerified = true
  }

  // 4. 前端页面渲染：付款单与付款申请单入口均可打开
  await openRoute(page, '/erp/finance/payableManage/payment')
  let bodyText = await page.locator('body').innerText()
  if (!bodyText.includes('付款单')) {
    throw new Error('付款单页面未正确渲染标题')
  }
  await saveScreenshot(page, outputDir, 'pb145-payment-list', record)

  await openRoute(page, '/erp/finance/payableManage/paymentRequest')
  bodyText = await page.locator('body').innerText()
  if (!bodyText.includes('付款申请')) {
    throw new Error('付款申请单页面未正确渲染标题')
  }
  await saveScreenshot(page, outputDir, 'pb145-payment-request-list', record)

  console.log(
    `PASS PB-145 payment request convert read-side, requests=${requests.length}, payments=${payments.length}, ` +
      `screenshotGuard=${sampleRequest ? 'checked' : 'skipped'}, screenshotWrite=${screenshotVerified ? 'verified' : 'no-executed-payment'}`
  )
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}
