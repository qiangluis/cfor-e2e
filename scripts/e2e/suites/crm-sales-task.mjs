import { nonEmpty } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { config } from '../config/index.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['CRM-TASK-001']

const unwrap = (response) => response?.data

const getProfile = async (api) => unwrap(await api.getBusiness('/system/user/profile/get'))

const getTask = async (api, taskId) => unwrap(await api.getBusiness(`/crm/task/get?id=${taskId}`))

const getSimpleUsers = async (api) =>
  unwrap(await api.getBusiness('/system/user/simple-list')) || []

const postAction = async (api, action, task) => {
  const response = await api.postBusiness(`/crm/task/${action}`, {
    id: task.id,
    version: task.version
  })
  return response
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'CRM-TASK-001') return { designed: true }
  if (!nonEmpty(config.secondUsername) || !nonEmpty(config.secondPassword)) {
    throw new Error('BLOCKED: CRM-TASK-001 requires CFOR_SECOND_USERNAME/CFOR_SECOND_PASSWORD')
  }

  const ownerToken = await loginWithCredentials(page)
  const ownerApi = createApiClient({ token: ownerToken, record })
  const owner = await getProfile(ownerApi)
  if (!owner?.id) throw new Error('BLOCKED: current account profile has no user id')

  const acceptorToken = await loginWithCredentials(page, {
    tenantName: config.tenantName,
    username: config.secondUsername,
    password: config.secondPassword
  })
  const acceptorApi = createApiClient({ token: acceptorToken, record })
  const acceptor = await getProfile(acceptorApi)
  if (!acceptor?.id || String(acceptor.id) === String(owner.id)) {
    throw new Error('BLOCKED: owner and acceptor must be two different real users')
  }

  // Re-enter as the owner for the execution half of the state machine.
  const restoredOwnerToken = await loginWithCredentials(page)
  const restoredOwnerApi = createApiClient({ token: restoredOwnerToken, record })
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19)
  const title = `E2E 销售任务 ${new Date().toISOString()}`
  const taskId = unwrap(
    await restoredOwnerApi.postBusiness('/crm/task/create', {
      sourceType: 'MANUAL',
      sourceId: Date.now(),
      sourceNo: `E2E-${Date.now()}`,
      sourceRule: 'CRM-TASK-001',
      title,
      target: '完成客户方案确认并提交可验收证据',
      acceptanceCriteria: '结果完整、包含证据，验收人确认通过',
      evidenceRequired: true,
      ownerUserId: owner.id,
      acceptanceUserId: acceptor.id,
      deadline,
      idempotencyKey: `CRM-TASK-001-${Date.now()}`
    })
  )
  if (!taskId) throw new Error('CRM-TASK-001 create returned an empty task id')

  let task = await getTask(restoredOwnerApi, taskId)
  caseRecord.checks.push({
    name: '创建任务进入待下达',
    passed: task.status === '待下达' && task.ownerUserId === owner.id,
    details: JSON.stringify({ id: task.id, status: task.status, version: task.version })
  })

  for (const action of ['dispatch', 'start']) {
    await postAction(restoredOwnerApi, action, task)
    task = await getTask(restoredOwnerApi, taskId)
  }
  caseRecord.checks.push({
    name: '下达并开始执行',
    passed: task.status === '执行中' && nonEmpty(task.dispatchedAt) && nonEmpty(task.startedAt),
    details: `status=${task.status}, dispatchedAt=${task.dispatchedAt}, startedAt=${task.startedAt}`
  })

  await restoredOwnerApi.postBusiness('/crm/task/block', {
    id: task.id,
    version: task.version,
    blockReason: '等待客户补充交付边界',
    blockImpact: '方案确认暂不能完成',
    assistanceRequired: '请销售经理协调客户联系人',
    expectedResumeAt: deadline
  })
  task = await getTask(restoredOwnerApi, taskId)
  const blockedVersion = task.version
  await restoredOwnerApi.postBusiness('/crm/task/resume', {
    id: task.id,
    version: task.version,
    remark: '客户已补充信息'
  })
  task = await getTask(restoredOwnerApi, taskId)
  caseRecord.checks.push({
    name: '阻塞和恢复只改变主状态，不生成逾期状态',
    passed:
      blockedVersion === task.version - 1 && task.status === '执行中' && task.overdue === false,
    details: `restored status=${task.status}, version=${task.version}`
  })

  await restoredOwnerApi.postBusiness('/crm/task/submit', {
    id: task.id,
    version: task.version,
    resultContent: '已完成客户方案确认，等待验收',
    evidenceUrl: 'https://example.invalid/e2e/crm-task-001'
  })
  task = await getTask(restoredOwnerApi, taskId)
  caseRecord.checks.push({
    name: '提交结果进入待验收且保留证据',
    passed: task.status === '待验收' && nonEmpty(task.evidenceUrl),
    details: `status=${task.status}, evidence=${task.evidenceUrl}`
  })

  await acceptorApi.postBusiness('/crm/task/reject', {
    id: task.id,
    version: task.version,
    remark: '请补充客户确认附件'
  })
  task = await getTask(acceptorApi, taskId)
  await restoredOwnerApi.postBusiness('/crm/task/submit', {
    id: task.id,
    version: task.version,
    resultContent: '已补充客户确认附件并完成说明',
    evidenceUrl: 'https://example.invalid/e2e/crm-task-001-revised'
  })
  task = await getTask(restoredOwnerApi, taskId)
  await acceptorApi.postBusiness('/crm/task/accept', {
    id: task.id,
    version: task.version,
    remark: '验收通过'
  })
  task = await getTask(acceptorApi, taskId)
  caseRecord.checks.push({
    name: '退回补充后重新提交并验收完成',
    passed: task.status === '已完成' && task.logs?.some((log) => log.action === 'REJECT'),
    details: `status=${task.status}, logs=${task.logs?.length || 0}`
  })

  const thirdUser = (await getSimpleUsers(restoredOwnerApi)).find(
    (user) => String(user.id) !== String(owner.id) && String(user.id) !== String(acceptor.id)
  )
  if (!thirdUser?.id) {
    throw new Error('BLOCKED: CRM-TASK-001 requires a third enabled user as transfer-task acceptor')
  }
  const transferTaskId = unwrap(
    await restoredOwnerApi.postBusiness('/crm/task/create', {
      sourceType: 'MANUAL',
      sourceId: Date.now(),
      sourceNo: `E2E-TRANSFER-${Date.now()}`,
      sourceRule: 'CRM-TASK-001-TRANSFER',
      title: `${title} 转交验证`,
      target: '验证销售任务转交、接收和取消留痕',
      acceptanceCriteria: '新负责人接收任务后可开始执行，取消后保留动作日志',
      evidenceRequired: false,
      ownerUserId: owner.id,
      acceptanceUserId: thirdUser.id,
      deadline,
      idempotencyKey: `CRM-TASK-001-TRANSFER-${Date.now()}`
    })
  )
  let transferTask = await getTask(restoredOwnerApi, transferTaskId)
  await postAction(restoredOwnerApi, 'dispatch', transferTask)
  transferTask = await getTask(restoredOwnerApi, transferTaskId)
  await restoredOwnerApi.postBusiness('/crm/task/transfer', {
    id: transferTask.id,
    version: transferTask.version,
    toUserId: acceptor.id,
    remark: 'E2E 验证负责人调整'
  })
  transferTask = await getTask(acceptorApi, transferTaskId)
  await postAction(acceptorApi, 'start', transferTask)
  transferTask = await getTask(acceptorApi, transferTaskId)
  await acceptorApi.postBusiness('/crm/task/cancel', {
    id: transferTask.id,
    version: transferTask.version,
    remark: 'E2E 转交链路验证完成'
  })
  transferTask = await getTask(acceptorApi, transferTaskId)
  caseRecord.checks.push({
    name: '转交任务由新负责人接收并保留取消审计',
    passed:
      transferTask.status === '已取消' &&
      transferTask.ownerUserId === acceptor.id &&
      nonEmpty(transferTask.transferReceivedAt) &&
      transferTask.logs?.some((log) => log.action === 'TRANSFER') &&
      transferTask.logs?.some((log) => log.action === 'CANCEL'),
    details: JSON.stringify({
      status: transferTask.status,
      ownerUserId: transferTask.ownerUserId,
      transferReceivedAt: transferTask.transferReceivedAt,
      logs: transferTask.logs?.length || 0
    })
  })

  await openRoute(page, '/crm/jixu/task')
  await page.getByText(title, { exact: true }).waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '真实浏览器打开销售任务页面并显示已完成任务',
    passed: bodyText.includes(title) && bodyText.includes('已完成'),
    details: '页面文本包含任务标题和已完成状态'
  })
  await saveScreenshot(page, outputDir, 'crm-sales-task-lifecycle', record)
  caseRecord.evidence.push(`taskId=${taskId}`)
  caseRecord.evidence.push(`transferTaskId=${transferTaskId}`)
  return { token: acceptorToken, api: acceptorApi }
}
