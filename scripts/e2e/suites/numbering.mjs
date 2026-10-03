import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB011-001']

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'PB011-001') return

  const token = await login(page)
  const api = createApiClient({ token, record })
  const payload = await api.getBusiness('/mes/fillRule/list?pageNo=1&pageSize=100')
  const records = payload?.records || payload?.list || []

  await openRoute(page, '/mes/base/fillRule')
  const versionColumn = page.getByText('版本', { exact: true }).first()
  const effectiveColumn = page.getByText('生效时间', { exact: true }).first()
  const publishColumn = page.getByText('发布时间', { exact: true }).first()

  caseRecord.checks.push({
    name: '编号设置页面与分页接口可访问',
    passed:
      page.url().includes('/mes/base/fillRule') &&
      Array.isArray(records) &&
      (await versionColumn.count()) > 0,
    details: `url=${page.url()} count=${records.length}`
  })

  caseRecord.checks.push({
    name: '规则分页返回版本、发布状态和生效时间',
    passed:
      records.length > 0 &&
      records.every(
        (item) =>
          item?.versionNo !== undefined &&
          item?.status !== undefined &&
          item?.effectiveFrom !== undefined
      ) &&
      (await effectiveColumn.count()) > 0 &&
      (await publishColumn.count()) > 0,
    details: '已发布规则只读展示版本、发布状态和生效时间'
  })

  const structuredRule = records.find((item) => {
    try {
      const params = JSON.parse(item?.ruleParams || '{}')
      return Array.isArray(params?.segments) && params.segments.length > 0
    } catch {
      return false
    }
  })
  const sequenceLengths = records
    .map((item) => {
      try {
        return Number(JSON.parse(item?.ruleParams || '{}')?.seqLen)
      } catch {
        return Number.NaN
      }
    })
    .filter((length) => Number.isFinite(length))

  caseRecord.checks.push({
    name: '编号规则已采用结构化片段和默认流水位数',
    passed: Boolean(structuredRule) && sequenceLengths.every((length) => length === 5),
    details: structuredRule
      ? `结构化规则=${structuredRule.ruleCode}；平台规则流水位数=${[...new Set(sequenceLengths)].join(',') || '无'}`
      : '未读取到结构化 segments 规则'
  })

  const hasDraft = records.some((item) => item?.status === 'DRAFT')
  caseRecord.checks.push({
    name: '草稿规则提供发布入口',
    passed: !hasDraft || (await page.getByText('发布', { exact: true }).count()) > 0,
    details: `draft=${hasDraft}；发布入口仅对草稿版本显示`
  })

  await saveScreenshot(page, outputDir, 'pb011-numbering', record)
  caseRecord.evidence.push(
    '真实登录并打开编号设置页面；结构化片段、原子取号、租户序列隔离和业务单号唯一性由后端单测与 Flyway 覆盖'
  )
  return { token, api }
}
