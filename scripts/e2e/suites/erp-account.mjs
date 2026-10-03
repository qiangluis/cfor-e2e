import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['ERP-ACCOUNT-001']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const result = await api.get('/erp/account/page?pageNo=1&pageSize=100')
  const rows = Array.isArray(result?.data?.list) ? result.data.list : []
  caseRecord.checks.push({
    name: '企业资金账户分页返回主档字段且真实账号默认脱敏',
    passed:
      Array.isArray(result?.data?.list) &&
      rows.every(
        (row) =>
          row?.no &&
          row?.accountType !== undefined &&
          (!row?.accountNo || /^\*{4}\d{0,4}$/.test(row.accountNo))
      ),
    details: `rows=${rows.length}`
  })

  await openRoute(page, '/base/account')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '企业资金账户设置页真实渲染',
    passed:
      page.url().includes('/base/account') &&
      bodyText.includes('账户编码') &&
      bodyText.includes('账户类型') &&
      bodyText.includes('真实账号'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-account', record)
  caseRecord.evidence.push('真实登录、账户分页脱敏契约和企业资金账户设置页截图')
  return { token, api }
}
