import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot, waitForPageReady } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { assertHrmOaLocalTarget } from '../fixtures/hrm-local-closure.mjs'
import { runCase as runHrmLocalCase } from './hrm.mjs'
import { runCase as runOaLocalCase } from './oa.mjs'
import { verifyPmsMemberPermissions } from '../fixtures/pms-member-permissions.mjs'
import {
  createPmsIsolationTenant,
  retirePmsIsolationTenant,
  verifyPmsCrossTenantInvisible
} from '../fixtures/pms-tenant-isolation.mjs'

export const cases = ['HRM-001', 'PMS-001', 'OA-001']

export const PMS_CATALOG_ASSERTIONS = Object.freeze([
  '成员权限',
  '状态流转',
  '评论参与权',
  '实际工时非负',
  '跨租户不可见'
])

export const initializePmsCatalogAssertions = (caseRecord) => {
  caseRecord.catalogAssertions = PMS_CATALOG_ASSERTIONS.map((assertion, index) => ({
    index,
    assertion,
    status: 'GAP',
    evidenceChecks: [],
    details: '本轮尚未执行该原断言'
  }))
  caseRecord.remainingAssertions = [...PMS_CATALOG_ASSERTIONS]
  caseRecord.catalogComplete = false
}

const pmsDataOf = (response) => response?.data ?? response

const pmsListOf = (response) => {
  const data = pmsDataOf(response)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.records)) return data.records
  return []
}

const pmsNumericId = (value, label) => {
  const text = String(value ?? '')
  if (!/^\d+$/.test(text)) throw new Error(`BLOCKED: ${label} 未返回合法数据库ID`)
  return text
}

const pmsUnique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`

const pmsDate = (days = 0) => {
  const value = new Date()
  value.setDate(value.getDate() + days)
  return value.toISOString().slice(0, 10)
}

const pmsLocalDateTime = (days = 0) => `${pmsDate(days)}T00:00:00`

const pmsProjectPayload = ({ marker, ownerId }) => ({
  name: marker,
  type: 1,
  level: 3,
  description: 'E2E 正式 PMS 项目闭环',
  openStatus: false,
  icon: 'ep:folder',
  startTime: pmsLocalDateTime(0),
  endTime: pmsLocalDateTime(30),
  memberUserIds: [ownerId]
})

const pmsWorkItemPayload = ({ projectId, ownerId, marker }) => ({
  projectId,
  type: 3,
  name: `${marker} 任务`,
  description: 'E2E 正式 PMS 工作项状态、评论与工时闭环',
  priority: 2,
  assigneeUserId: ownerId,
  memberUserIds: [ownerId],
  progress: 0,
  estimatedHours: 8,
  startTime: pmsLocalDateTime(0),
  endTime: pmsLocalDateTime(7)
})

const cleanupPmsProject = async (api, projectId, caseRecord) => {
  if (!projectId) return
  try {
    const current = pmsDataOf(await api.getBusiness(`/pms/pm/project/get?id=${projectId}`))
    if (current?.status !== 3) {
      await api.putBusiness(`/pms/pm/project/recycle?id=${projectId}`, undefined)
    }
    await api.deleteBusiness(`/pms/pm/project/delete?id=${projectId}`)
    const contract = { code: 2050100000, message: '项目不存在' }
    const deleted = await api.get(`/pms/pm/project/get?id=${projectId}`, {
      expectedBusinessRejection: contract
    })
    if (!matchesExpectedBusinessRejection(deleted, contract) || deleted?.data != null) {
      throw new Error('删除后专属项目仍可读取')
    }
    caseRecord.evidence.push(`清理：删除本轮专属 PMS 项目 ${projectId}`)
  } catch (error) {
    caseRecord.checks.push({
      name: `清理：删除本轮专属 PMS 项目 ${projectId}`,
      passed: false,
      details: error.message
    })
  }
}

export const markPmsCatalogAssertion = (caseRecord, index, evidenceChecks, gap = '') => {
  const row = caseRecord.catalogAssertions?.[index]
  if (!row) return false
  const names = Array.isArray(evidenceChecks) ? [...evidenceChecks] : []
  const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
  const missing = names.filter((name, position) => !checks[position])
  const failed = checks.filter((check) => check && check.passed !== true)
  row.evidenceChecks = names
  row.status = !gap && names.length > 0 && missing.length === 0 && failed.length === 0
    ? 'VERIFIED'
    : 'GAP'
  row.details = [
    gap,
    ...checks.map((check, position) => check
      ? `${check.name}: ${check.details}`
      : `缺证: ${names[position]}`)
  ].filter(Boolean).join('; ')
  return row.status === 'VERIFIED'
}

const finalizePmsCatalogAssertions = (caseRecord, result = {}) => {
  const gaps = caseRecord.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
  caseRecord.remainingAssertions = gaps.map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.catalogAssertions.length > 0 &&
    caseRecord.remainingAssertions.length === 0
  const notes = gaps.map((row) =>
    `PMS-001 catalog 断言未验证：${row.assertion}（${row.details || '缺少精确证据'}）`
  )
  for (const note of notes) {
    if (!caseRecord.notes.includes(note)) caseRecord.notes.push(note)
  }
  return {
    partial: !caseRecord.catalogComplete,
    note: notes.join('；'),
    catalogAssertions: caseRecord.catalogAssertions,
    remainingAssertions: caseRecord.remainingAssertions,
    catalogComplete: caseRecord.catalogComplete,
    acceptanceComplete: caseRecord.catalogComplete && result?.partial !== true
  }
}

const runCaseCore = async ({ caseId, page, record, caseRecord, outputDir, check }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌读取 HRM、PMS、OA 事实接口'
  })

  if (caseId === 'HRM-001') {
    const employees = await api.getBusiness('/hrm/employee/page?pageNo=1&pageSize=100')
    const data = employees?.data || {}
    const rows = Array.isArray(data?.list) ? data.list : []
    const boundUsers = await api.getBusiness('/hrm/employee/bound-user-id-list')
    const statusCount = await api.getBusiness('/hrm/employee/status-count')
    caseRecord.checks.push({
      name: 'HRM 员工分页与账号绑定事实可查询，pageSize 不超过 100',
      passed:
        employees?.code === 0 &&
        rows.length <= 100 &&
        rows.every((row) => row.id != null && Object.prototype.hasOwnProperty.call(row, 'status')),
      details: `employees=${rows.length}`
    })
    caseRecord.checks.push({
      name: '员工账号绑定与在职状态统计使用 HRM 公共接口',
      passed: Array.isArray(boundUsers?.data) && statusCount?.code === 0,
      details: `bound=${boundUsers?.data?.length || 0}`
    })
    await openRoute(page, '/hrm/employee')
    await saveScreenshot(page, outputDir, 'hrm-employee-facts', record)
    caseRecord.evidence.push('真实登录后读取员工分页、账号绑定和状态统计并验证员工页面')
    return { token, api }
  }

  if (caseId === 'PMS-001') {
    const profile = pmsDataOf(await api.getBusiness('/system/user/profile/get'))
    const ownerId = pmsNumericId(profile?.id, 'PMS 当前登录用户')
    const permissionInfo = await api.getBusiness('/system/auth/get-permission-info')
    const permissionData = permissionInfo?.data || {}
    const permissionCodes = Array.isArray(permissionData.permissions)
      ? permissionData.permissions.map(String)
      : []
    caseRecord.checks.push({
      name: 'PMS 正式权限码可用于项目与工作项查询',
      passed:
        permissionCodes.includes('*:*:*') ||
        permissionCodes.includes('pms:pm:project:query') ||
        permissionCodes.includes('pms:pm:work-item:query') ||
        permissionCodes.some((code) => code.startsWith('pms:pm:')),
      details: `permissions=${permissionCodes.filter((code) => code.startsWith('pms:pm:')).join(',') || 'n/a'}`
    })

    const marker = pmsUnique('E2E_PMS_001')
    let projectId
    let isolationFixture
    let workItemId
    try {
      projectId = pmsNumericId(
        pmsDataOf(await api.postBusiness('/pms/pm/project/create', pmsProjectPayload({ marker, ownerId }))),
        'PMS 专属项目'
      )
      const projectPage = await api.getBusiness(
        '/pms/pm/project/page?pageNo=1&pageSize=100&status=1&sceneType=1'
      )
      const project = pmsListOf(projectPage).find((row) => String(row.id) === String(projectId))
      caseRecord.checks.push({
        name: 'PMS 项目分页回读本轮专属项目及成员权限字段',
        passed:
          projectPage?.code === 0 &&
          project?.name === marker &&
          project?.status === 1 &&
          project?.ownerStatus === true &&
          project?.memberStatus === true &&
          project?.writeStatus === true,
        details: `projectId=${projectId}, project=${JSON.stringify(project || null)}`
      })

      const members = pmsListOf(
        await api.getBusiness(`/pms/pm/project-member/list?projectId=${projectId}`)
      )
      const member = members.find((row) => String(row.userId) === String(ownerId))
      caseRecord.checks.push({
        name: 'PMS 项目成员权限级别与创建人身份真实回读',
        passed:
          member?.level === 1 &&
          member?.creatorStatus === true &&
          Boolean(member?.nickname),
        details: `members=${members.length}, member=${JSON.stringify(member || null)}`
      })

      const statuses = pmsListOf(
        await api.getBusiness(`/pms/pm/work-item-status/list?projectId=${projectId}&type=3`)
      )
      const defaultStatus = statuses.find((row) => row.defaultStatus === true) || statuses[0]
      const processingStatus = statuses.find(
        (row) => row.statusType === 2 && String(row.id) !== String(defaultStatus?.id)
      )
      const completedStatus = statuses.find((row) => row.statusType === 3)
      caseRecord.checks.push({
        name: 'PMS 工作项状态主档包含默认状态与进行中状态',
        passed:
          statuses.length >= 2 &&
          defaultStatus?.id != null &&
          processingStatus?.id != null &&
          defaultStatus?.statusType === 1 &&
          processingStatus?.statusType === 2,
        details: `statuses=${JSON.stringify(statuses)}`
      })

      workItemId = pmsNumericId(
        pmsDataOf(await api.postBusiness(
          '/pms/pm/work-item/create',
          pmsWorkItemPayload({ projectId, ownerId, marker })
        )),
        'PMS 专属工作项'
      )
      const workItemPage = await api.getBusiness(
        `/pms/pm/work-item/page?pageNo=1&pageSize=100&projectId=${projectId}&lifecycleStatus=1`
      )
      const workItem = pmsListOf(workItemPage).find(
        (row) => String(row.id) === String(workItemId)
      )
      await api.putBusiness('/pms/pm/work-item/update-status', {
        id: workItemId,
        statusId: processingStatus?.id
      })
      const workItemAfterStatus = pmsDataOf(
        await api.getBusiness(`/pms/pm/work-item/get?id=${workItemId}`)
      )
      caseRecord.checks.push({
        name: 'PMS 工作项通过正式状态接口切换并回读新状态',
        passed:
          workItem?.statusId != null &&
          String(workItemAfterStatus?.statusId) === String(processingStatus?.id) &&
          workItemAfterStatus?.status === processingStatus?.statusType,
        details: `workItemId=${workItemId}, before=${workItem?.statusId}, after=${workItemAfterStatus?.statusId}`
      })
      markPmsCatalogAssertion(caseRecord, 1, [
        'PMS 工作项状态主档包含默认状态与进行中状态',
        'PMS 工作项通过正式状态接口切换并回读新状态'
      ])

      const mainCommentId = pmsNumericId(
        pmsDataOf(await api.postBusiness('/pms/pm/work-item-comment/create', {
          workItemId,
          content: `${marker} 主评论`
        })),
        'PMS 主评论'
      )
      await api.postBusiness('/pms/pm/work-item-comment/create', {
        workItemId,
        mainId: mainCommentId,
        replyUserId: ownerId,
        content: `${marker} 回复`
      })
      const comments = pmsListOf(
        await api.getBusiness(`/pms/pm/work-item-comment/list?workItemId=${workItemId}`)
      )
      const mainComment = comments.find((row) => String(row.id) === String(mainCommentId))
      caseRecord.checks.push({
        name: 'PMS 工作项评论与回复按真实参与人回读',
        passed:
          String(mainComment?.userId) === String(ownerId) &&
          Array.isArray(mainComment?.children) &&
          mainComment.children.length === 1 &&
          String(mainComment.children[0]?.replyUserId) === String(ownerId),
        details: `workItemId=${workItemId}, comments=${JSON.stringify(comments)}`
      })

      await api.postBusiness('/pms/pm/work-item-work-log/create', {
        workItemId,
        actualHours: 2,
        remainingHours: 6,
        description: `${marker} 实际工时`
      })
      const summary = pmsDataOf(
        await api.getBusiness(`/pms/pm/work-item-work-log/summary?workItemId=${workItemId}`)
      )
      caseRecord.checks.push({
        name: 'PMS 实际工时登记后汇总非负且保留记录',
        passed:
          Number(summary?.actualHours) >= 0 &&
          Number(summary?.actualHours) === 2 &&
          Number(summary?.remainingHours) >= 0 &&
          Array.isArray(summary?.records) &&
          summary.records.length === 1 &&
          summary.records.every((row) => Number(row.actualHours) >= 0),
        details: `summary=${JSON.stringify(summary || null)}`
      })
      const negativeHours = await api.post('/pms/pm/work-item-work-log/create', {
        workItemId, actualHours: -1, remainingHours: 6, description: `${marker} 负工时拒绝探针`
      }, { expectedBusinessRejection: { code: 400, message: /实际投入工时必须大于 0/ } })
      const afterNegative = pmsDataOf(
        await api.getBusiness(`/pms/pm/work-item-work-log/summary?workItemId=${workItemId}`)
      )
      caseRecord.checks.push({
        name: 'PMS 负工时精确校验拒绝且汇总记录不变',
        passed: negativeHours?.code === 400 &&
          /实际投入工时必须大于 0/.test(negativeHours?.msg || '') &&
          JSON.stringify(summary) === JSON.stringify(afterNegative),
        details: `code=${negativeHours?.code}, unchanged=${JSON.stringify(summary) === JSON.stringify(afterNegative)}`
      })
      markPmsCatalogAssertion(caseRecord, 3, [
        'PMS 实际工时登记后汇总非负且保留记录',
        'PMS 负工时精确校验拒绝且汇总记录不变'
      ])

      const permission = await verifyPmsMemberPermissions({
        adminApi: api, page, record, caseRecord, projectId, ownerId, workItemId,
        mainCommentId, defaultStatusId: defaultStatus.id,
        processingStatusId: processingStatus.id, marker
      })
      caseRecord.checks.push({
        name: 'PMS 普通成员与非成员权限矩阵完整通过',
        passed: permission.verified,
        details: `${permission.checks.length} checks`
      })
      markPmsCatalogAssertion(caseRecord, 0, [
        'PMS 项目分页回读本轮专属项目及成员权限字段',
        'PMS 项目成员权限级别与创建人身份真实回读',
        'PMS 普通成员与非成员权限矩阵完整通过'
      ])
      markPmsCatalogAssertion(caseRecord, 2, [
        'PMS 工作项评论与回复按真实参与人回读',
        'PMS 非成员评论被领域权限拒绝且未落库',
        'PMS 只读成员评论被拒绝且未落库',
        'PMS 编辑成员评论由真实用户创建并回读',
        'PMS 编辑成员不能修改他人评论且原文不变',
        'PMS 编辑成员不能删除他人评论且原文不变'
      ])
      if (!completedStatus?.id) throw new Error('PMS 缺少工作项完成状态')
      await api.putBusiness('/pms/pm/work-item/update-status', {
        id: workItemId, statusId: completedStatus.id
      })
      const completedItem = pmsDataOf(await api.getBusiness(`/pms/pm/work-item/get?id=${workItemId}`))
      caseRecord.checks.push({
        name: 'PMS 工作项从未开始、进行中流转至已完成',
        passed: completedItem?.status === 3 && String(completedItem.statusId) === String(completedStatus.id),
        details: `workItemId=${workItemId}, status=${completedItem?.status}`
      })
      markPmsCatalogAssertion(caseRecord, 1, [
        'PMS 工作项状态主档包含默认状态与进行中状态',
        'PMS 工作项通过正式状态接口切换并回读新状态',
        'PMS 工作项从未开始、进行中流转至已完成'
      ])

      await api.putBusiness(`/pms/pm/project/recycle?id=${projectId}`, undefined)
      const recycled = pmsDataOf(
        await api.getBusiness(`/pms/pm/project/get?id=${projectId}`)
      )
      await api.putBusiness(`/pms/pm/project/restore?id=${projectId}`, undefined)
      const restored = pmsDataOf(
        await api.getBusiness(`/pms/pm/project/get?id=${projectId}`)
      )
      caseRecord.checks.push({
        name: 'PMS 项目回收站恢复而非直接删除',
        passed: recycled?.status === 3 && restored?.status === 1,
        details: `recycled=${recycled?.status}, restored=${restored?.status}`
      })

      isolationFixture = await createPmsIsolationTenant(api, { marker })
      const isolation = await verifyPmsCrossTenantInvisible({
        context: { page, check, record }, fixture: isolationFixture, projectId, workItemId, marker
      })
      caseRecord.checks.push({
        name: 'PMS 第二租户真实登录后不可读取 tenant 1 专属项目',
        passed: isolation.passed,
        details: isolation.details
      })
      markPmsCatalogAssertion(caseRecord, 4, [
        'PMS 第二租户真实登录后不可读取 tenant 1 专属项目'
      ])
      await openRoute(page, '/pms/pm/project/list', { readyText: '项目' })
      await page.getByPlaceholder('请输入项目名称', { exact: true }).fill(marker)
      const projectResponse = page.waitForResponse((response) =>
        response.url().includes('/pms/pm/project/page?') &&
        new URL(response.url()).searchParams.get('name') === marker
      ).catch(() => null)
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      if (!(await projectResponse)?.ok()) throw new Error('PMS 页面未查询专属项目')
      await waitForPageReady(page)
      const projectRow = page.locator('.el-table__row').filter({ hasText: marker })
      await projectRow.first().waitFor({ state: 'visible' })
      caseRecord.checks.push({
        name: 'PMS 页面清理前真实显示本轮私有项目',
        passed: await projectRow.count() === 1,
        details: marker
      })
      await saveScreenshot(page, outputDir, 'pms-project-facts', record)
      const detailResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/pms/pm/project/get')
      ).catch(() => null)
      await projectRow.getByText(marker, { exact: true }).click()
      const detail = await detailResponse
      const actualId = detail ? new URL(detail.url()).searchParams.get('id') : null
      caseRecord.checks.push({
        name: 'PMS 项目详情页面请求保持长 ID 精度',
        passed: actualId === String(projectId),
        details: `expected=${projectId}, actual=${actualId}`
      })
      if (actualId !== String(projectId)) throw new Error(`PMS 项目详情丢失 ID 精度：${projectId} -> ${actualId}`)
      await page.getByRole('heading', { name: marker, exact: true }).waitFor({ state: 'visible' })
      await waitForPageReady(page)
      await page.getByText(`${marker} 任务`, { exact: true }).first().waitFor({ state: 'visible' })
      await page.getByPlaceholder('请输入任务标题', { exact: true }).waitFor({ state: 'visible' })
      caseRecord.checks.push({
        name: 'PMS 项目详情真实展示本轮完成工作项',
        passed: true,
        details: `projectId=${projectId}, workItemId=${workItemId}`
      })
      await saveScreenshot(page, outputDir, 'pms-project-completed-task', record)
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const settingsResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/pms/pm/project/get')
      ).catch(() => null)
      await page.getByRole('menuitem', { name: '项目设置', exact: true }).click()
      const settings = await settingsResponse
      const settingsId = settings ? new URL(settings.url()).searchParams.get('id') : null
      caseRecord.checks.push({
        name: 'PMS 项目设置页面请求保持长 ID 精度',
        passed: settingsId === String(projectId),
        details: `expected=${projectId}, actual=${settingsId}`
      })
      if (settingsId !== String(projectId)) throw new Error('PMS 项目设置丢失 ID 精度')
      await page.getByRole('tab', { name: '成员', exact: true }).click()
      await waitForPageReady(page)
      await page.getByText('管理员', { exact: true }).last().waitFor({ state: 'visible' })
      await saveScreenshot(page, outputDir, 'pms-project-settings-members', record)
    } finally {
      await retirePmsIsolationTenant(api, isolationFixture, caseRecord)
      await cleanupPmsProject(api, projectId, caseRecord)
    }

    caseRecord.evidence.push(
      '真实登录后创建并回读正式 PMS 专属项目、成员权限、工作项状态、评论参与权、实际工时及回收站恢复。'
    )
    return { token, api }
  }

  if (caseId === 'OA-001') {
    const leave = await api.getBusiness('/bpm/oa/leave/page?pageNo=1&pageSize=100')
    const leaveData = leave?.data || {}
    const leaveRows = Array.isArray(leaveData?.list) ? leaveData.list : []
    const meetingRooms = await api.getBusiness('/oa/meeting-room/page?pageNo=1&pageSize=100')
    const roomData = meetingRooms?.data || {}
    const roomRows = Array.isArray(roomData?.list) ? roomData.list : []
    caseRecord.checks.push({
      name: '请假与协同资源分别通过 BPM/OA 接口读取',
      passed:
        leave?.code === 0 &&
        meetingRooms?.code === 0 &&
        leaveRows.length <= 100 &&
        roomRows.length <= 100,
      details: `leave=${leaveRows.length}, meetingRooms=${roomRows.length}`
    })
    await openRoute(page, '/oa')
    await saveScreenshot(page, outputDir, 'oa-collaboration-facts', record)
    caseRecord.evidence.push('真实登录后读取 BPM 请假和 OA 会议室分页并验证 OA 页面')
    return { token, api }
  }

  return { token, api }
}

export const runCase = async (args) => {
  const { caseId, caseRecord } = args
  // Keep the legacy read-only path unless this domain and fixture writes are both opted in.
  if ((caseId === 'HRM-001' || caseId === 'OA-001') &&
      process.env.CFOR_HRM_OA_LOCAL_CLOSURE === 'true' &&
      process.env.CFOR_E2E_WRITE_FIXTURES === 'true') {
    assertHrmOaLocalTarget(config, process.env)
    return caseId === 'HRM-001' ? runHrmLocalCase(args) : runOaLocalCase(args)
  }
  if (caseId === 'PMS-001') initializePmsCatalogAssertions(caseRecord)
  let result
  try {
    result = await runCaseCore(args)
  } catch (error) {
    if (caseId === 'PMS-001') finalizePmsCatalogAssertions(caseRecord, { partial: true })
    throw error
  }
  if (caseId !== 'PMS-001') return result
  return {
    ...result,
    ...finalizePmsCatalogAssertions(caseRecord, result)
  }
}
