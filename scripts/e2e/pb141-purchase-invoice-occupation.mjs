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
const outputDir = process.env.CFOR_E2E_OUT || '/tmp/cfor-e2e-pb141-invoice-occupation'
const record = { api: [], screenshots: [], consoleErrors: [], pageErrors: [] }

try {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const invoicePage = await api.getBusiness('/erp/purchase-invoice/page?pageNo=1&pageSize=100')
  if (!Array.isArray(invoicePage?.data?.list) || invoicePage?.data?.total === undefined) {
    throw new Error('采购发票分页未返回 list/total')
  }

  const reconciliationPage = await api.getBusiness(
    '/erp/purchase-reconciliation/page?pageNo=1&pageSize=100'
  )
  const reconciliations = Array.isArray(reconciliationPage?.data?.list)
    ? reconciliationPage.data.list
    : []
  const supplierId = reconciliations.find((item) => item?.supplierId)?.supplierId
  let invoiceableLines = []
  if (supplierId) {
    const response = await api.getBusiness(
      `/erp/purchase-reconciliation/invoiceable-lines?supplierId=${encodeURIComponent(supplierId)}`
    )
    if (!Array.isArray(response?.data)) {
      throw new Error('待开票对账明细接口未返回数组')
    }
    invoiceableLines = response.data
  }

  await openRoute(page, '/erp/purchase/invoice')
  const bodyText = await page.locator('body').innerText()
  if (!bodyText.includes('采购发票')) {
    throw new Error('采购发票页面未正确渲染标题')
  }

  await page.getByRole('button', { name: '待开票对账' }).click()
  await page.getByText('待开票对账明细', { exact: true }).waitFor({ state: 'visible' })
  const dialogText = await page.locator('.el-dialog').last().innerText()
  for (const header of ['采购订单', '确认数量', '确认单价', '已开票金额', '剩余可开票']) {
    if (!dialogText.includes(header)) {
      throw new Error(`待开票对账弹窗缺少列：${header}`)
    }
  }
  await saveScreenshot(page, outputDir, 'pb141-invoiceable-dialog', record)
  await page.getByRole('button', { name: '关 闭' }).click()

  console.log(
    `PASS purchase invoice reconciliation occupation, supplier=${supplierId || 'none'}, invoiceable=${invoiceableLines.length}`
  )
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}
