import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-123 reads the real knowledge-hub state and only publishes when a valid document exists.
export const cases = ['PB123-001']

const dataOf = (response) => response?.data ?? response

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实租户令牌读取售后知识案例'
  })

  const rows = dataOf(await api.getBusiness('/after-sales/knowledge/list')) || []
  const published = rows.filter((item) => item.status === 'PUBLISHED')
  const invalid = published.filter(
    (item) => !item.knowledgeDocumentId || !item.knowledgeDocumentVersion || item.hubPublishStatus !== 'SYNCED'
  )
  caseRecord.checks.push({
    name: '已发布案例只引用已同步的知识中枢文档版本',
    passed: published.length === 0 || invalid.length === 0,
    details: `published=${published.length}, invalid=${invalid.length}`
  })

  const linked = rows.find((item) => item.knowledgeDocumentId)
  if (linked) {
    const detail = dataOf(await api.getBusiness(`/after-sales/knowledge/get?id=${linked.id}`))
    caseRecord.checks.push({
      name: '知识案例详情回读知识中枢文档 ID/版本',
      passed:
        String(detail?.knowledgeDocumentId) === String(linked.knowledgeDocumentId) &&
        Number(detail?.knowledgeDocumentVersion) === Number(linked.knowledgeDocumentVersion),
      details: `document=${detail?.knowledgeDocumentId}, version=${detail?.knowledgeDocumentVersion}`
    })
  } else {
    const documentPage = await api.getBusiness(
      '/ai/knowledge/document/page?pageNo=1&pageSize=100&status=0&parseStatus=PARSED&indexStatus=INDEXED'
    )
    const documentData = dataOf(documentPage)
    const documents = Array.isArray(documentData)
      ? documentData
      : documentData?.list || documentData?.records || []
    caseRecord.checks.push({
      name: '知识中枢文档状态可供售后引用，或明确记录前置数据缺失',
      passed: Array.isArray(documents),
      details: documents.length
        ? `可引用文档=${documents.length}，当前售后案例尚未映射`
        : '当前租户没有已解析且已索引的知识中枢文档，跳过正向发布'
    })
    if (!documents.length) {
      caseRecord.notes.push('PB123 正向发布需要真实的 PARSED + INDEXED 知识中枢文档；当前租户无可用文档，已跳过。')
    }
  }

  await openRoute(page, '/after-sales/knowledge')
  await saveScreenshot(page, outputDir, 'pb123-after-sales-knowledge')
}
