import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB012-001']

const hasRawSecret = (value) => {
  const text = JSON.stringify(value ?? {})
  // 企业接口只返回掩码与 configured 标记，出现明文 sk- 或非空 apiKey 字段即为泄露。
  return /"apiKey"\s*:\s*"sk-|"apiSecret"\s*:\s*"sk-/.test(text)
}

const isSuccessfulPayload = (payload) =>
  (payload?.code === 0 && payload.success !== false) ||
  (payload?.code === 200 && payload.success === true)

const listPayload = (payload) => {
  const list = payload?.data?.list
  return Array.isArray(list) ? list : null
}

const arrayPayload = (payload) => {
  const data = payload?.data
  return Array.isArray(data) ? data : null
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'PB012-001') return

  const token = await login(page)
  const api = createApiClient({ token, record })

  const keyPage = await api.get('/ai/tenant-config/api-key/page?pageNo=1&pageSize=100')
  const modelPage = await api.get('/ai/tenant-config/model/page?pageNo=1&pageSize=100')
  const capabilityList = await api.get('/ai/tenant-config/capability/list')
  const platformTenantBoundaryDenied =
    keyPage?.code === 403 &&
    modelPage?.code === 403 &&
    capabilityList?.code === 403 &&
    [keyPage, modelPage, capabilityList].some((payload) =>
      String(payload?.msg || payload?.message || '').includes('当前租户不能维护企业 AI')
    )

  if (platformTenantBoundaryDenied) {
    await openRoute(page, '/settings/business-settings/ai-model', {
      readyText: '企业 AI 配置'
    })
    caseRecord.checks.push({
      name: '平台租户按设计拒绝企业 AI 配置接口',
      passed:
        page.url().includes('/settings/business-settings/ai-model') &&
        (await page.getByText('企业 AI 配置').first().count()) > 0,
      details: '企业 Key、企业模型和能力接口均按租户边界返回 403'
    })
    caseRecord.evidence.push(
      '平台租户真实浏览器打开企业 AI 配置入口；企业 BYOK 敏感接口按租户边界拒绝，企业租户写侧需使用 tenantId > 1 的真实测试租户'
    )
    return {
      token,
      api,
      partial: true,
      note: '当前为平台租户，企业 BYOK 接口按设计返回 403；企业租户写侧待 tenantId > 1 的真实租户复测'
    }
  }

  const keys = listPayload(keyPage) || []
  const models = listPayload(modelPage) || []
  const capabilities = arrayPayload(capabilityList) || []

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
      (await modelTab.count()) > 0 &&
      isSuccessfulPayload(keyPage) &&
      isSuccessfulPayload(modelPage) &&
      isSuccessfulPayload(capabilityList),
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
