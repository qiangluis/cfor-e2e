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
const outputDir = process.env.CFOR_E2E_OUT || '/tmp/cfor-e2e-pb146-period-lock'
const record = { api: [], screenshots: [], consoleErrors: [], pageErrors: [] }

try {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const accountSetResponse = await api.getBusiness('/fms/config/account-set/list')
  const accountSets = Array.isArray(accountSetResponse?.data) ? accountSetResponse.data : []
  if (accountSets.length === 0) {
    throw new Error('BLOCKED: 当前租户没有已初始化的 FMS 账套，PB-146 期间锁需要先在引导中心初始化 FMS 账套')
  }
  const accountSetId = accountSets[0].id

  const currentMonthResponse = await api.getBusiness(
    `/fms/closing/period/current-month?accountSetId=${accountSetId}`
  )
  const month = currentMonthResponse?.data
  if (!month) {
    throw new Error('FMS 未返回当前会计期间')
  }

  const overviewResponse = await api.getBusiness(
    `/fms/closing/period/overview?accountSetId=${accountSetId}&month=${month}`
  )
  if (overviewResponse?.data === undefined) {
    throw new Error('FMS 结账概况未返回 data')
  }

  await openRoute(page, '/erp/finance/payableManage/payable')
  const bodyText = await page.locator('body').innerText()
  if (!bodyText.includes('应付')) {
    throw new Error('应付单页面未正确渲染标题')
  }

  await saveScreenshot(page, outputDir, 'pb146-period-lock', record)
  console.log(
    `PASS PB-146 period lock read-side, accountSet=${accountSetId}, month=${month}, status=${overviewResponse.data.status || 'unknown'}`
  )
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}
