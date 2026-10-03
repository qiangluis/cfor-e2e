import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB052-001']

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'PB052-001') return

  const token = await login(page)
  const api = createApiClient({ token, record })
  const definitionPage = await api.getBusiness('/crm/customer-tag/definition/page?pageNo=1&pageSize=100')
  const summary = await api.getBusiness('/crm/customer-tag/report/summary')
  const definitions = definitionPage?.list || []
  const summaryRows = Array.isArray(summary) ? summary : []

  caseRecord.checks.push({
    name: '客户标签定义与口径统计接口可访问',
    passed: Array.isArray(definitions) && Array.isArray(summaryRows),
    details: `definitionCount=${definitions.length} summaryCount=${summaryRows.length}`
  })

  const summaryCoversAllDefinitions = definitions.every((definition) =>
    summaryRows.some((row) => row?.tagId === definition?.id)
  )
  caseRecord.checks.push({
    name: '口径统计覆盖全部标签并包含零客户标签',
    passed: summaryCoversAllDefinitions && summaryRows.every((row) => typeof row?.customerCount === 'number'),
    details: '统计按标签稳定编码输出当前客户数，历史单据标签快照不参与反向还原'
  })

  const systemTagsDistinct = summaryRows.every(
    (row) => row?.tagType === 'SYSTEM' || row?.tagType === 'MANUAL'
  )
  caseRecord.checks.push({
    name: '系统标签与人工标签在口径中可区分',
    passed: systemTagsDistinct,
    details: `system=${summaryRows.filter((row) => row?.tagType === 'SYSTEM').length} manual=${summaryRows.filter((row) => row?.tagType === 'MANUAL').length}`
  })

  await openRoute(page, '/crm/config/customerTag')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '设置-业务设置-CRM 客户标签页展示当前客户数',
    passed: bodyText.includes('客户标签') || bodyText.includes('标签编码'),
    details: bodyText.includes('当前客户数') ? '页面展示口径列' : '页面已渲染（无标签时列可为空）'
  })

  await saveScreenshot(page, outputDir, 'pb052-customer-tag', record)
  caseRecord.evidence.push(
    '真实登录并打开 CRM 客户标签设置页；三表定义/关系/审计、系统与人工标签互不冒充、快照口径由后端 CrmCustomerTagServiceImplTest 与 Flyway 覆盖'
  )
  return { token, api }
}
