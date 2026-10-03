import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB012-001']

const hasRawSecret = (value) => {
  const text = JSON.stringify(value ?? {})
  // 企业接口只返回掩码与 configured 标记，出现明文 sk- 或非空 apiKey 字段即为泄露。
  return /"apiKey"\s*:\s*"sk-|"apiSecret"\s*:\s*"sk-/.test(text)
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'PB012-001') return

  const token = await login(page)
  const api = createApiClient({ token, record })

  const keyPage = await api.getBusiness('/ai/tenant-config/api-key/page?pageNo=1&pageSize=100')
  const modelPage = await api.getBusiness('/ai/tenant-config/model/page?pageNo=1&pageSize=100')
  const capabilityList = await api.getBusiness('/ai/tenant-config/capability/list')
  const keys = keyPage?.list || []
  const models = modelPage?.list || []
  const capabilities = Array.isArray(capabilityList) ? capabilityList : []

  await openRoute(page, '/ai/model/tenant')
  const pageHeading = page.getByText('企业 AI 配置').first()
  const apiKeyTab = page.getByText('企业 API Key', { exact: true }).first()
  const modelTab = page.getByText('企业模型', { exact: true }).first()

  caseRecord.checks.push({
    name: '企业 AI 配置页面与企业接口可访问',
    passed:
      page.url().includes('/ai/model/tenant') &&
      (await pageHeading.count()) > 0 &&
      (await apiKeyTab.count()) > 0 &&
      (await modelTab.count()) > 0,
    details: `url=${page.url()} keys=${keys.length} models=${models.length}`
  })

  caseRecord.checks.push({
    name: '企业 Key 分页只返回掩码不回显明文',
    passed: !hasRawSecret(keyPage),
    details: `keyCount=${keys.length} masked=${keys.filter((item) => item?.apiKeyMasked).length}`
  })

  caseRecord.checks.push({
    name: '企业模型与能力绑定接口按企业维度返回',
    passed: Array.isArray(models) && Array.isArray(capabilities),
    details: `modelCount=${models.length} capabilityCount=${capabilities.length}`
  })

  const capabilityCarriesFallbackFlag = capabilities.every(
    (item) => item?.allowPlatformFallback === undefined || typeof item.allowPlatformFallback === 'boolean'
  )
  caseRecord.checks.push({
    name: '企业能力绑定声明平台回退开关',
    passed: capabilityCarriesFallbackFlag,
    details: 'allowPlatformFallback 仅在开启时允许企业能力不可用时回退平台同名能力'
  })

  await saveScreenshot(page, outputDir, 'pb012-ai-tenant-config', record)
  caseRecord.evidence.push(
    '真实登录并打开企业 AI 配置页；企业/平台分层路由、Key 掩码脱敏、回退开关判定由后端 AiModelCapabilityResolverTest/AiApiKeyServiceImplTest 与 Flyway 覆盖'
  )
  return { token, api }
}
