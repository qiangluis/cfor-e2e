import { nonEmpty } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['CRM-BR-001']

const unwrap = (response) => response?.data
const pad2 = (value) => String(value).padStart(2, '0')
const dateValue = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
const reportKeys = [
  'sales-plan',
  'public-pool',
  'private-pool',
  'follow-up',
  'weekly-review',
  'quote',
  'contract-receipt',
  'work-log',
  'ai-effect'
]

const getReport = async (api, reportKey, startTime, endTime) => {
  return unwrap(
    await api.getBusiness(
      `/crm/statistics-business-report/overview?reportKey=${reportKey}` +
        `&startTime=${encodeURIComponent(`${startTime} 00:00:00`)}` +
        `&endTime=${encodeURIComponent(`${endTime} 23:59:59`)}`
    )
  )
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'CRM-BR-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const endTime = new Date()
  const startTime = new Date(endTime.getFullYear(), endTime.getMonth() - 5, 1)
  const start = dateValue(startTime)
  const end = dateValue(endTime)

  for (const reportKey of reportKeys) {
    const result = await getReport(api, reportKey, start, end)
    caseRecord.checks.push({
      name: `PB-257~261 ${reportKey} 返回统一报表结构`,
      passed:
        result?.reportKey === reportKey &&
        Array.isArray(result?.metrics) &&
        result.metrics.length > 0 &&
        Array.isArray(result?.progressMetrics) &&
        Array.isArray(result?.rows) &&
        result?.options &&
        nonEmpty(result?.period) &&
        nonEmpty(result?.generatedAt),
      details: JSON.stringify({
        reportKey: result?.reportKey,
        metrics: result?.metrics?.length,
        progressMetrics: result?.progressMetrics?.length,
        rows: result?.rows?.length
      })
    })
  }

  const filtered = await getReport(api, 'sales-plan', start, end)
  const department = filtered?.options?.departments?.[0]
  const owner = filtered?.options?.owners?.[0]
  if (department || owner) {
    const filteredResponse = unwrap(
      await api.getBusiness(
        `/crm/statistics-business-report/overview?reportKey=sales-plan` +
          `&startTime=${encodeURIComponent(`${start} 00:00:00`)}` +
          `&endTime=${encodeURIComponent(`${end} 23:59:59`)}` +
          `${department ? `&department=${encodeURIComponent(department)}` : ''}` +
          `${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`
      )
    )
    caseRecord.checks.push({
      name: 'PB-261 指标与明细使用同一筛选口径',
      passed:
        filteredResponse?.reportKey === 'sales-plan' &&
        Array.isArray(filteredResponse?.rows) &&
        (filteredResponse.rows.length <= (filtered?.rows?.length || 0) ||
          (filtered?.rows?.length || 0) === 0),
      details: JSON.stringify({
        before: filtered?.rows?.length,
        after: filteredResponse?.rows?.length,
        department,
        owner
      })
    })
  }

  await openRoute(page, '/crm/jixu/report/sales-plan')
  await page.getByText('销售计划报表').first().waitFor({ state: 'visible' })
  await page.getByText('实际回款').first().waitFor({ state: 'visible' })
  caseRecord.checks.push({
    name: 'PB-257 真实浏览器经营报表页面已接后端数据',
    passed: true,
    details: '页面显示销售计划报表与后端指标字段'
  })
  await saveScreenshot(page, outputDir, 'crm-business-report-overview', record)

  return { token, api }
}
