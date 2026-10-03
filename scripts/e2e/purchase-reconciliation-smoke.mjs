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
const outputDir = process.env.CFOR_E2E_OUT || '/tmp/cfor-e2e-purchase-reconciliation'
const record = { api: [], screenshots: [], consoleErrors: [], pageErrors: [] }

try {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const response = await api.getBusiness('/erp/purchase-reconciliation/page?pageNo=1&pageSize=100')
  const rows = Array.isArray(response?.data?.list) ? response.data.list : []
  if (!Array.isArray(response?.data?.list) || response?.data?.total === undefined) {
    throw new Error('采购对账分页未返回 list/total')
  }

  await openRoute(page, '/erp/purchase/reconciliation')
  const bodyText = await page.locator('body').innerText()
  if (!bodyText.includes('采购对账') || !bodyText.includes('发起对账')) {
    throw new Error('采购对账页面未正确渲染标题或发起对账入口')
  }

  await page.getByRole('button', { name: '发起对账' }).click()
  await page.getByText('发起采购对账', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '取消' }).last().click()

  if (rows.length > 0) {
    await page.getByRole('button', { name: rows[0].billNo, exact: true }).click()
    await page.getByText('采购对账详情', { exact: true }).waitFor({ state: 'visible' })
    const detailText = await page.locator('.el-dialog').last().innerText()
    for (const label of ['发货数量', '收货数量', '确认数量', '确认单价', '剩余可开票']) {
      if (!detailText.includes(label)) throw new Error(`对账详情缺少字段：${label}`)
    }
    await page.getByRole('button', { name: '关闭' }).click()
  }

  await saveScreenshot(page, outputDir, 'purchase-reconciliation', record)
  console.log(`PASS purchase reconciliation page, rows=${rows.length}`)
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}
