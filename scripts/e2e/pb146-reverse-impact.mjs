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
const outputDir = process.env.CFOR_E2E_OUT || '/tmp/cfor-e2e-pb146-reverse-impact'
const record = { api: [], screenshots: [], consoleErrors: [], pageErrors: [] }

try {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const accountSetResponse = await api.getBusiness('/fms/config/account-set/list')
  const accountSets = Array.isArray(accountSetResponse?.data) ? accountSetResponse.data : []
  if (accountSets.length === 0) {
    throw new Error('BLOCKED: 当前租户没有已初始化的 FMS 账套，PB-146 反结账影响评估需要先在引导中心初始化 FMS 账套')
  }
  const accountSetId = accountSets[0].id

  const currentMonthResponse = await api.getBusiness(
    `/fms/closing/period/current-month?accountSetId=${accountSetId}`
  )
  const month = currentMonthResponse?.data
  if (!month) {
    throw new Error('FMS 未返回当前会计期间')
  }

  // 只读评估接口，不触发反结账；未结账月份按业务返回 CLOSING_PERIOD_NOT_CLOSED
  const impactResponse = await api.getBusiness(
    `/fms/closing/period/cancel-impact?accountSetId=${accountSetId}&month=${month}`
  )
  const impact = impactResponse?.data
  if (impact && !Array.isArray(impact.periods)) {
    throw new Error('反结账影响评估未返回 periods 数组')
  }

  await openRoute(page, '/fms/closing')
  const bodyText = await page.locator('body').innerText()
  if (!bodyText.includes('结账')) {
    throw new Error('结账页面未正确渲染')
  }

  await saveScreenshot(page, outputDir, 'pb146-reverse-impact', record)
  console.log(
    `PASS PB-146 reverse closing impact read-side, accountSet=${accountSetId}, month=${month}, periods=${impact?.periods?.length ?? 'not-closed'}`
  )
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}
