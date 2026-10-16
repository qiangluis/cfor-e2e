import { nonEmpty } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { config } from '../config/index.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['CRM-WR-001']

const unwrap = (response) => response?.data

const pad2 = (value) => String(value).padStart(2, '0')
const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}
const afterHours = (hours) => {
  const at = new Date(Date.now() + hours * 60 * 60 * 1000)
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}:00`
}

const getProfile = async (api) => unwrap(await api.getBusiness('/system/user/profile/get'))

const getReport = async (api, id) =>
  unwrap(await api.getBusiness(`/crm/work-report/get?id=${id}`))

const getReportPage = async (api, params = 'pageNo=1&pageSize=100') =>
  unwrap(await api.getBusiness(`/crm/work-report/page?${params}`))

const getTaskPage = async (api, params = 'pageNo=1&pageSize=100') =>
  unwrap(await api.getBusiness(`/crm/task/page?${params}`))

const newReportBody = (ownerUserId, period) => ({
  reportType: 'DAILY',
  periodStart: period,
  periodEnd: period,
  ownerUserId,
  deadline: afterHours(6),
  contractAmount: 0,
  receivableAmount: 0,
  completionRate: 60,
  riskCount: 1,
  summary: 'E2E 工作汇报：完成客户回访和报价确认',
  unresolvedReason: '一家客户尚未确认最终报价',
  coordination: '需要技术协助确认交付边界',
  aiConclusion: '签约进度正常，回款需重点跟进',
  aiEvidence: '合同与回款事实来自系统汇总',
  aiConfirmed: false,
  plans: [
    {
      category: '客户',
      baseline: '1 家客户待确认报价',
      target: '完成报价确认',
      action: '提交补充方案并确认决策人',
      priority: 'P1',
      ownerUserId,
      dueDate: period,
      acceptance: '客户书面确认报价版本'
    }
  ]
})

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'CRM-WR-001') return { designed: true }
  if (!nonEmpty(config.secondUsername) || !nonEmpty(config.secondPassword)) {
    throw new Error('BLOCKED: CRM-WR-001 requires CFOR_SECOND_USERNAME/CFOR_SECOND_PASSWORD')
  }

  // 汇报人使用第二账号，审核人使用超级管理员账号，避免“自己审核自己”。
  const reviewerToken = await loginWithCredentials(page)
  const reviewerApi = createApiClient({ token: reviewerToken, record })
  const reviewer = await getProfile(reviewerApi)
  if (!reviewer?.id) throw new Error('BLOCKED: current account profile has no user id')

  const ownerToken = await loginWithCredentials(page, {
    tenantName: config.tenantName,
    username: config.secondUsername,
    password: config.secondPassword
  })
  const ownerApi = createApiClient({ token: ownerToken, record })
  const owner = await getProfile(ownerApi)
  if (!owner?.id || String(owner.id) === String(reviewer.id)) {
    throw new Error('BLOCKED: report owner and reviewer must be two different real users')
  }

  const period = today()
  // 读取系统事实前后对比客户分页总数，证明事实接口只读不回写业务单据。
  const customersBefore = unwrap(
    await ownerApi.getBusiness('/crm/customer/page?pageNo=1&pageSize=1')
  )
  const facts = unwrap(
    await ownerApi.getBusiness(
      `/crm/work-report/facts?ownerUserId=${owner.id}&periodStart=${period}&periodEnd=${period}`
    )
  )
  const customersAfter = unwrap(
    await ownerApi.getBusiness('/crm/customer/page?pageNo=1&pageSize=1')
  )
  caseRecord.checks.push({
    name: 'PB-254 系统事实按周期聚合且不回写原单据',
    passed:
      (facts?.groups?.length || 0) === 7 &&
      Number(customersBefore?.total) === Number(customersAfter?.total),
    details: JSON.stringify({
      groups: facts?.groups?.map((group) => group.groupKey),
      customersBefore: customersBefore?.total,
      customersAfter: customersAfter?.total
    })
  })

  const createBody = newReportBody(owner.id, period)
  const reportId = unwrap(await ownerApi.postBusiness('/crm/work-report/create', createBody))
  if (!reportId) throw new Error('CRM-WR-001 create returned an empty report id')

  let report = await getReport(ownerApi, reportId)
  caseRecord.checks.push({
    name: 'PB-253 创建日报草稿并派生周期标签',
    passed: report.status === 'DRAFT' && nonEmpty(report.periodLabel) && report.revisionNo === 1,
    details: JSON.stringify({
      status: report.status,
      periodLabel: report.periodLabel,
      revisionNo: report.revisionNo
    })
  })

  // PB-256：AI 未人工确认时禁止提交。
  const unconfirmedSubmit = await ownerApi.request(
    'PUT',
    `/crm/work-report/submit?id=${reportId}&submissionNote=E2E`,
    undefined
  )
  caseRecord.checks.push({
    name: 'PB-256 AI 内容未人工确认不能提交',
    passed: unconfirmedSubmit?.code !== 0,
    details: JSON.stringify({
      code: unconfirmedSubmit?.code,
      message: unconfirmedSubmit?.msg
    })
  })

  await ownerApi.putBusiness('/crm/work-report/update', {
    ...createBody,
    id: reportId,
    aiConfirmed: true,
    version: report.version
  })
  report = await getReport(ownerApi, reportId)
  await ownerApi.putBusiness(
    `/crm/work-report/submit?id=${reportId}&submissionNote=E2E 提交`,
    undefined
  )
  report = await getReport(ownerApi, reportId)
  caseRecord.checks.push({
    name: 'PB-253 确认 AI 后可提交并进入待审核',
    passed: report.status === 'SUBMITTED' && nonEmpty(report.submittedAt),
    details: JSON.stringify({ status: report.status, submittedAt: report.submittedAt })
  })

  // 同一周期已有正式版本时禁止再次提交。
  const duplicate = await ownerApi.postBusiness('/crm/work-report/create', {
    ...newReportBody(owner.id, period),
    aiConfirmed: true
  })
  caseRecord.checks.push({
    name: 'PB-253 同周期正式版本去重',
    passed: duplicate === undefined || duplicate === null,
    details: 'create should be rejected by WORK_REPORT_FORMAL_DUPLICATE'
  })

  const reportPage = await getReportPage(ownerApi)
  caseRecord.checks.push({
    name: 'PB-253 分页返回本人汇报',
    passed: (reportPage?.list || []).some((item) => String(item.id) === String(reportId)),
    details: `total=${reportPage?.total}`
  })

  // PB-255：退回并转销售任务。
  report = await getReport(reviewerApi, reportId)
  await reviewerApi.postBusiness('/crm/work-report/review', {
    id: reportId,
    version: report.version,
    decision: 'RETURN',
    comment: '请补充客户报价确认证据后重新提交',
    createTask: true,
    taskOwnerUserId: owner.id,
    taskDeadline: afterHours(48),
    taskTitle: '补齐客户报价确认',
    taskTarget: '完成客户报价书面确认',
    taskAcceptance: '提交客户确认的报价版本'
  })
  report = await getReport(ownerApi, reportId)
  const taskPage = await getTaskPage(reviewerApi, 'pageNo=1&pageSize=100&sourceType=WORK_REPORT_REVIEW')
  const generatedTask = (taskPage?.list || []).find(
    (task) => String(task.sourceId) === String(reportId)
  )
  caseRecord.checks.push({
    name: 'PB-255 退回生成销售任务并保留审核意见',
    passed:
      report.status === 'RETURNED' &&
      nonEmpty(report.reviewComment) &&
      nonEmpty(generatedTask?.id) &&
      String(generatedTask.acceptanceUserId) === String(reviewer.id),
    details: JSON.stringify({
      status: report.status,
      reviewComment: report.reviewComment,
      taskId: generatedTask?.id,
      acceptanceUserId: generatedTask?.acceptanceUserId
    })
  })

  // 退回后修订生成下一版草稿。
  const revisedId = unwrap(
    await ownerApi.postBusiness(`/crm/work-report/revise?sourceReportId=${reportId}`)
  )
  const revised = await getReport(ownerApi, revisedId)
  caseRecord.checks.push({
    name: 'PB-255 退回后修订生成下一版草稿',
    passed:
      revised.status === 'DRAFT' &&
      String(revised.sourceReportId) === String(reportId) &&
      Number(revised.revisionNo) === Number(report.revisionNo) + 1,
    details: JSON.stringify({
      status: revised.status,
      sourceReportId: revised.sourceReportId,
      revisionNo: revised.revisionNo
    })
  })

  // 汇报人不能审核自己的汇报。
  const selfReview = await ownerApi.request('POST', '/crm/work-report/review', {
    id: revisedId,
    version: revised.version,
    decision: 'CONFIRM',
    comment: 'E2E 越权校验'
  })
  caseRecord.checks.push({
    name: 'PB-255 汇报人不能审核自己的汇报',
    passed: selfReview?.code !== 0,
    details: JSON.stringify({ code: selfReview?.code, message: selfReview?.msg })
  })

  // 修订版本提交后由审核人确认。
  await ownerApi.putBusiness('/crm/work-report/update', {
    ...newReportBody(owner.id, period),
    id: revisedId,
    version: revised.version,
    aiConfirmed: true,
    summary: 'E2E 工作汇报修订版：客户已确认报价',
    unresolvedReason: '无'
  })
  const revisedUpdated = await getReport(ownerApi, revisedId)
  await ownerApi.putBusiness(
    `/crm/work-report/submit?id=${revisedId}&submissionNote=E2E 修订提交`,
    undefined
  )
  const revisedSubmitted = await getReport(ownerApi, revisedId)
  await reviewerApi.postBusiness('/crm/work-report/review', {
    id: revisedId,
    version: revisedSubmitted.version,
    decision: 'CONFIRM',
    comment: '审核通过'
  })
  const confirmed = await getReport(reviewerApi, revisedId)
  caseRecord.checks.push({
    name: 'PB-255 修订版本提交后确认通过',
    passed: confirmed.status === 'CONFIRMED' && nonEmpty(confirmed.reviewerUserId),
    details: JSON.stringify({
      status: confirmed.status,
      reviewerUserId: confirmed.reviewerUserId,
      revisedVersion: revisedUpdated.version
    })
  })

  await openRoute(page, '/crm/jixu/work-report')
  await page.getByText('工作汇报').first().waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '真实浏览器打开工作汇报页面并显示数据',
    passed: bodyText.includes('工作汇报') && bodyText.includes('已确认'),
    details: '页面文本包含工作汇报标题与已确认状态'
  })
  await saveScreenshot(page, outputDir, 'crm-work-report-lifecycle', record)
  caseRecord.evidence.push(`reportId=${reportId}`)
  caseRecord.evidence.push(`revisedId=${revisedId}`)
  return { token: ownerToken, api: ownerApi }
}
