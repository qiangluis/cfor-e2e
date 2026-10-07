import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB-063-001']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const pageResult = await api.get('/erp/sale-delivery/page?pageNo=1&pageSize=100')
  const rows = Array.isArray(pageResult?.data?.list) ? pageResult.data.list : []
  caseRecord.checks.push({
    name: '销售发货单分页返回物流快照字段',
    passed: Array.isArray(pageResult?.data?.list) && rows.every((row) =>
      Object.prototype.hasOwnProperty.call(row, 'carrierPartnerId') &&
      Object.prototype.hasOwnProperty.call(row, 'carrierPartnerName') &&
      Object.prototype.hasOwnProperty.call(row, 'expressCode')),
    details: `rows=${rows.length}`
  })

  await openRoute(page, '/erp/sale/delivery', { readyText: '新增' })
  await page.getByRole('button', { name: /新增/ }).first().click()
  const dialog = page.locator('.el-dialog:visible').first()
  await dialog.waitFor({ state: 'visible', timeout: 60000 })
  const expandForm = dialog.locator('.check_btn').first()
  if (await expandForm.count() && await expandForm.isVisible()) {
    await expandForm.click()
  }
  await dialog.getByText('承运商', { exact: true }).first().waitFor({
    state: 'visible',
    timeout: 60000
  })
  const bodyText = await dialog.innerText()
  const carrierField = dialog.getByText('承运商', { exact: true }).first()
  const expressField = dialog.getByText('快递品牌', { exact: true }).first()
  const visible = (await carrierField.count()) > 0 && (await expressField.count()) > 0
  caseRecord.checks.push({
    name: '发运页面提供统一客商承运商和快递品牌字段',
    passed: new URL(page.url()).pathname === '/erp/sale/delivery' &&
      bodyText.includes('承运商') && bodyText.includes('快递品牌') && visible,
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-sale-delivery-carrier-snapshot', record)
  caseRecord.evidence.push('真实登录、发货单分页快照字段和发运页面截图')
  return { token, api }
}
