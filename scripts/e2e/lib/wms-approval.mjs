import { config } from '../config/index.mjs'
import { createApiClient } from './api.mjs'
import { assertBusinessSuccess } from './assertions.mjs'
import { login, launchBrowser, openRoute } from './browser.mjs'
import { runReadOnlySql } from './db.mjs'

const activeTask = (tasks, taskDefinitionKey) =>
  (Array.isArray(tasks) ? tasks : []).find((task) =>
    task?.endTime == null &&
    Number(task?.status) === 1 &&
    (!taskDefinitionKey || task.taskDefinitionKey === taskDefinitionKey)
  ) || null

const taskList = (payload) => {
  const value = payload?.data ?? payload
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.records)) return value.records
  return []
}

const stableId = (value) =>
  (typeof value === 'string' && /^[1-9]\d*$/.test(value)) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)

async function resolveTaskUsername (task, tenantId) {
  const direct = task?.assigneeUser?.username || task?.assigneeUsername
  if (direct) return String(direct)
  const assigneeId = task?.assigneeUser?.id ?? task?.assignee
  if (!stableId(assigneeId)) return ''
  const snapshot = await runReadOnlySql(
    `SELECT username FROM system_users WHERE tenant_id=${Number(tenantId)} ` +
    `AND deleted=0 AND status=0 AND id=${String(assigneeId)}`
  )
  return snapshot.rows[0]?.[0] || ''
}

const taskEvidence = (task, username) =>
  [
    `taskId=${task?.id || ''}`,
    `node=${task?.taskDefinitionKey || ''}`,
    `status=${task?.status ?? ''}`,
    `actualAssigneeId=${task?.assigneeUser?.id ?? task?.assignee ?? ''}`,
    `actualAssigneeName=${task?.assigneeUser?.nickname || ''}`,
    `actualUsername=${username || ''}`
  ].join(', ')

const waitFor = async (read, predicate, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await read()
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return latest
}

export async function approveWmsProcess ({
  api,
  processId,
  caseRecord,
  record,
  label,
  taskDefinitionKey = 'FirstApprove_stock-move',
  stageApprovers = [
    {
      taskDefinitionKey,
      username: config.warehouseApproverUsername,
      password: config.warehouseApproverPassword
    },
    {
      taskDefinitionKey: 'SecondApprove_stock-move',
      username: config.warehouseApproverUsername,
      password: config.warehouseApproverPassword
    },
    {
      taskDefinitionKey: 'FinalApprove_stock-move',
      username: config.warehouseFinalApproverUsername,
      password: config.warehouseFinalApproverPassword
    }
  ],
  reason = 'WMS E2E tenant1 专属数据验收'
} = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(processId || '')) {
    throw new Error(`BLOCKED: ${label || 'WMS'} 审批缺少有效流程实例 ID`)
  }
  const stages = stageApprovers.filter((stage) => stage?.taskDefinitionKey)
  if (!stages.length || stages.some((stage) => !stage.username || !stage.password)) {
    throw new Error(`BLOCKED: ${label || 'WMS'} 缺少一个或多个实际审批节点的账号或密码配置`)
  }

  const readTasks = () => api.getBusiness(
    `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`
  ).then(taskList)
  const sessions = new Map()
  const getApproverSession = async (stage) => {
    const cacheKey = stage.username
    if (sessions.has(cacheKey)) return sessions.get(cacheKey)
    const approverBrowser = await launchBrowser({ headed: !config.headless, record })
    try {
      const loginContext = await login(approverBrowser.page, {
        credentials: {
          tenantName: config.tenantName,
          username: stage.username,
          password: stage.password
        },
        returnContext: true
      })
      if (String(loginContext?.tenantId || '') !== String(config.tenantId || '1')) {
        throw new Error(
          `BLOCKED: ${label || 'WMS'} 审批账号租户不一致：` +
          `username=${stage.username}, expected=${config.tenantId || '1'}, ` +
          `actual=${loginContext?.tenantId || ''}`
        )
      }
      const approverApi = createApiClient({
        token: loginContext.token,
        tenantId: config.tenantId || '1',
        record
      })
      const permission = assertBusinessSuccess(
        await approverApi.getPermissionInfo(),
        `${label || 'WMS'} ${stage.username} 审批账号权限`
      )
      const identity = permission?.data?.user || permission?.user
      if (!identity?.id || String(identity.username) !== stage.username) {
        throw new Error(
          `BLOCKED: ${label || 'WMS'} 审批账号身份回读不一致：` +
          `configuredUsername=${stage.username}, actualUsername=${identity?.username || ''}, ` +
          `actualUserId=${identity?.id || ''}`
        )
      }
      const session = { browser: approverBrowser, api: approverApi, identity }
      sessions.set(cacheKey, session)
      return session
    } catch (error) {
      await approverBrowser.browser.close().catch(() => {})
      throw error
    }
  }

  try {
    for (const [index, stage] of stages.entries()) {
      const expectedTaskDefinitionKey = stage.taskDefinitionKey
      const processTask = await waitFor(
        readTasks,
        (tasks) => Boolean(activeTask(tasks, expectedTaskDefinitionKey)),
        60000
      ).then((tasks) => activeTask(tasks, expectedTaskDefinitionKey))
      if (!processTask?.id) {
        throw new Error(
          `BLOCKED: ${label || 'WMS'} 未收到预期 BPM 待办：processInstanceId=${processId}, ` +
          `taskDefinitionKey=${expectedTaskDefinitionKey}`
        )
      }

      const actualUsername = await resolveTaskUsername(processTask, config.tenantId || 1)
      const evidence = taskEvidence(processTask, actualUsername)
      const stageLabel = `${label || 'WMS'} 第${index + 1}段`
      caseRecord.evidence.push(
        `WMS 实际 assignee：processInstanceId=${processId}, ${evidence}`
      )
      caseRecord.checks.push({
        name: `${stageLabel}待办分配给配置的实际审批账号并核对真实身份`,
        passed: actualUsername === stage.username,
        details: `configuredUsername=${stage.username}, ${evidence}`
      })
      if (actualUsername !== stage.username) {
        throw new Error(
          `BLOCKED: ${stageLabel}实际 assignee 与配置不一致；` +
          `configuredUsername=${stage.username}, ${evidence}`
        )
      }

      const session = await getApproverSession(stage)
      const approverBrowser = session.browser
      const approverApi = session.api
      const todo = await waitFor(
        () => approverApi.getBusiness(
          `/bpm/task/my-todo?processInstanceId=${encodeURIComponent(processId)}`
        ).then((payload) => payload?.data ?? payload),
        (value) => Boolean(
          Array.isArray(value)
            ? value.find((item) => item?.id === processTask.id)
            : value?.id === processTask.id
        ),
        30000
      )
      const todoTask = Array.isArray(todo)
        ? todo.find((item) => item?.id === processTask.id)
        : todo
      if (!todoTask?.id) {
        throw new Error(
          `BLOCKED: ${stageLabel}实际审批账号未收到准确待办：${evidence}`
        )
      }

      await openRoute(
        approverBrowser.page,
        `/bpm/process-instance/detail?id=${encodeURIComponent(processId)}&taskId=${encodeURIComponent(processTask.id)}`,
        {
          readySelector: '.processInstance-wrap-main',
          readyTimeoutMs: 30000,
          retries: 2
        }
      )
      const approveReference = approverBrowser.page
        .getByRole('button', { name: '通过', exact: true })
        .first()
      await approveReference.waitFor({ state: 'visible', timeout: 30000 })
      await approveReference.click()
      const approvePopover = approverBrowser.page.locator('.el-popover:visible').last()
      await approvePopover.waitFor({ state: 'visible', timeout: 30000 })
      const opinion = approvePopover.getByPlaceholder(/请输入.*意见/).first()
      if (await opinion.count()) await opinion.fill(`${reason}（第${index + 1}段）`)
      const approvalResponse = approverBrowser.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/bpm/task/approve') &&
          response.request().method() === 'PUT',
        { timeout: 60000 }
      )
      await approvePopover.getByRole('button', { name: '通过', exact: true }).click()
      const response = await approvalResponse
      if (!response.ok()) {
        throw new Error(`${stageLabel}页面审批请求失败：HTTP ${response.status()}`)
      }
      assertBusinessSuccess(await response.json(), `${stageLabel}页面正式审批`)

      const completedTasks = await waitFor(
        readTasks,
        (tasks) => {
          const current = (Array.isArray(tasks) ? tasks : []).find(
            (item) => item?.id === processTask.id
          )
          return Boolean(current && (current.endTime != null || Number(current.status) !== 1))
        },
        30000
      )
      const completedTask = (Array.isArray(completedTasks) ? completedTasks : [])
        .find((item) => item?.id === processTask.id)
      if (!completedTask || completedTask.endTime == null && Number(completedTask.status) === 1) {
        throw new Error(`BLOCKED: ${stageLabel}审批后原任务仍处于活动状态：${evidence}`)
      }
      caseRecord.checks.push({
        name: `${stageLabel}由实际 assignee 在浏览器中完成正式审批`,
        passed: true,
        details: `${evidence}, endTime=${completedTask.endTime || ''}, reason=${completedTask.reason || ''}`
      })
    }

    const finalTasks = await waitFor(
      readTasks,
      (tasks) => !activeTask(tasks),
      30000
    )
    const remainingActiveTasks = (Array.isArray(finalTasks) ? finalTasks : [])
      .filter((task) => task?.endTime == null && Number(task?.status) === 1)
    caseRecord.checks.push({
      name: `${label || 'WMS'} 三段 BPM 审批完成且流程无活动待办`,
      passed: remainingActiveTasks.length === 0,
      details: remainingActiveTasks.map(task => taskEvidence(task, '')).join(' | ') || 'none'
    })
    if (remainingActiveTasks.length) {
      throw new Error(
        `BLOCKED: ${label || 'WMS'} 三段审批后仍有活动待办：` +
        remainingActiveTasks.map(task => taskEvidence(task, '')).join(' | ')
      )
    }
  } finally {
    for (const session of sessions.values()) {
      await session.browser.browser.close().catch(() => {})
    }
  }
}
