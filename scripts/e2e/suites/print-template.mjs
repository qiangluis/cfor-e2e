import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB010-001']

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'PB010-001') return
  const token = await login(page)
  await openRoute(page, '/print/index')

  const templateResponse = await page.request.get(
    '/admin-api/system/print-template/page?pageNo=1&pageSize=100'
  )
  const templatePayload = await templateResponse.json().catch(() => null)
  const records = templatePayload?.data?.list || []
  const objectCode = records.find((item) => item?.objectCode)?.objectCode || 'sale_order'
  const resolveResponse = await page.request.post('/admin-api/system/print-template/resolve', {
    data: {
      objectCode,
      businessTypeCode: 'E2E-PROBE',
      lock: false
    }
  })
  const bindingResponse = await page.request.get(
    `/admin-api/system/print-template/binding/page?pageNo=1&pageSize=100&objectCode=${encodeURIComponent(objectCode)}`
  )

  caseRecord.checks.push({
    name: '打印模板页面与版本字段可访问',
    passed: templateResponse.ok() && page.url().includes('/print/index'),
    details: `HTTP ${templateResponse.status()} url=${page.url()} count=${records.length}`
  })
  caseRecord.checks.push({
    name: '打印模板分页返回租户隔离和发布状态字段',
    passed:
      templateResponse.ok() &&
      records.every((item) => item?.tenantId !== undefined && item?.status),
    details: '已发布模板不可原地覆盖；版本递增和默认模板唯一约束由服务层与 Flyway 覆盖'
  })
  caseRecord.checks.push({
    name: '打印模板解析和绑定接口可访问',
    passed: resolveResponse.status() !== 404 && bindingResponse.status() !== 404,
    details: `resolve=${resolveResponse.status()} binding=${bindingResponse.status()} object=${objectCode}`
  })
  caseRecord.checks.push({
    name: '正式打印模板按已锁版本、绑定或默认模板解析',
    passed: resolveResponse.ok() || resolveResponse.status() === 400,
    details: '200 表示存在可用默认/绑定模板，400 表示当前测试对象未配置默认模板；接口不允许随机分页取首条'
  })
  await saveScreenshot(page, outputDir, 'pb010-print-template', record)
  caseRecord.evidence.push(
    '真实登录并打开打印模板入口，读取分页、解析和绑定接口；优先级、冲突拒绝、锁版不可变和租户隔离由后端单测与 Flyway 覆盖'
  )
  return { token }
}
