import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { login } from '../lib/browser.mjs'
import {
  assertHrmOaLocalTarget, assertClosureMarker, closureTime, closureMarker, closureId, closureData, closureList, closureCheck,
  closureGap, finalizeLocalAssertions, createLocalClosureCleanup, createClosureActor,
  loginClosureActor, createClosureEmployee, readClosureDb, showClosureRow,
  createClosureResource, findClosureRows, deleteClosureResource
} from './hrm-local-closure.mjs'

export const OA_LOCAL_ASSERTIONS = Object.freeze([
  '提交生成流程', '只能 BPM 回写结论', '审批完成回写状态', '评论和资源预约权限隔离'
])
export const OA_LOCAL_CHECKS = Object.freeze({
  submit: 'OA 员工正式请假提交后 HRM 事实与 BPM 业务键一致',
  overlap: 'OA 重叠请假精确拒绝且本轮请假与流程计数不变',
  cancel: 'OA 请假仅由本人取消流程并回写已取消且活动任务归零',
  approve: 'OA 正式 BPM 待办逐级审批完成并回写同一 HRM 请假',
  forgedCreate: 'OA 门户创建伪造员工终态和流程字段无效且仅生成本人 RUNNING 新 BPM',
  forgedOtherCancel: 'OA 旁观者伪造本人和终态取消被精确拒绝且 HRM/BPM 不变',
  forgedCancel: 'OA 本人取消伪造通过和流程字段无效且原 BPM 与 HRM 一致取消',
  booking: 'OA 专属会议预约回读确认态和真实发起人',
  conflict: 'OA 预约冲突精确拒绝且预约计数与原值不变',
  owner: 'OA 非本人修改与取消精确拒绝且预约事实不变',
  cancelled: 'OA 本人取消释放占用且重复取消精确拒绝',
  cleanup: 'OA 资源清理后取消预约保留审计且会议室不可见'
})
export const OA_LOCAL_REJECTIONS = Object.freeze({
  employeeMissing: { code: 2040100000, message: '员工不存在' },
  overlap: { code: 2041300031, message: '请假时间与已有申请重叠' },
  otherLeave: { code: 2041300030, message: '请假申请不存在' },
  cancelledLeave: { code: 2041300032, message: '只有审批中的请假申请可以取消' },
  owner: { code: 1054200011, message: '只能修改或取消本人发起的会议预约' },
  conflict: { code: 1054200012, message: /^该会议室在 \d{4}-\d\d-\d\d \d\d:\d\d 至 \d{4}-\d\d-\d\d \d\d:\d\d 已被占用$/ },
  cancelledBooking: { code: 1054200013, message: '会议预约已取消，不能重复操作' },
  roomInUse: { code: 1054200003, message: '会议室存在未取消的预约，不能删除' }
})
export const OA_LOCAL_EVIDENCE = Object.freeze({
  0: [OA_LOCAL_CHECKS.submit, OA_LOCAL_CHECKS.overlap],
  1: [OA_LOCAL_CHECKS.forgedCreate, OA_LOCAL_CHECKS.forgedOtherCancel, OA_LOCAL_CHECKS.forgedCancel],
  2: [OA_LOCAL_CHECKS.approve],
  3: ['OA 非本人修改预约被拒绝', 'OA 非本人取消预约被拒绝']
})
const bookingPermissions = [
  'oa:meeting-booking:query', 'oa:meeting-booking:create',
  'oa:meeting-booking:update', 'oa:meeting-booking:cancel'
]
const timeText = (milliseconds) => {
  const date = new Date(milliseconds)
  const format = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${format(date.getMonth() + 1)}-${format(date.getDate())} ` +
    `${format(date.getHours())}:${format(date.getMinutes())}:${format(date.getSeconds())}`
}

export async function expectOaLocalRejection ({ api, method, path, body, contract, snapshot, record, name }) {
  const before = await snapshot()
  const response = await api.request(method, path, body, { expectedBusinessRejection: contract })
  const after = await snapshot()
  closureCheck(record, name, matchesExpectedBusinessRejection(response, contract) && response.data == null &&
    JSON.stringify(before) === JSON.stringify(after), `code=${response.code}; unchanged=${JSON.stringify(before) === JSON.stringify(after)}`)
}

export async function submitOaLocalLeave ({ ownerApi, body, binding, caseRecord }) {
  const path = '/hrm/portal/attendance/leave/create'
  const response = await ownerApi.post(path, body)
  if (matchesExpectedBusinessRejection(response, OA_LOCAL_REJECTIONS.employeeMissing) &&
      response.data == null && binding?.verified === true && binding.roleDataScope === 5 &&
      matchesExpectedBusinessRejection(binding.selfResponse, OA_LOCAL_REJECTIONS.employeeMissing) &&
      binding.selfResponse.data == null) {
    caseRecord.leaveSubmissionBlocker = {
      endpoint: path, code: response.code, message: response.msg ?? response.message,
      employeeId: closureId(binding.employeeId), userId: closureId(binding.userId),
      roleId: closureId(binding.roleId), roleDataScope: binding.roleDataScope,
      adminBindingVerified: true, selfReadCode: binding.selfResponse.code,
      attribution: 'SELF 本人档案读取受阻；未放宽数据范围，需结合当前数据权限源码定位'
    }
    closureGap(caseRecord, 0,
      '管理员 API/只读 DB 已证实本轮账号绑定员工且角色为 SELF；本人档案 GET 与正式请假 POST 均精确返回 2040100000 员工不存在，提交未闭环')
    closureGap(caseRecord, 1, '请假提交被本人档案读取阻断，尚未执行 BPM 终态旁路负断言')
    closureGap(caseRecord, 2, '请假提交被本人档案读取阻断，尚未进入正式 BPM 待办与审批账号匹配；未重置密码或变更 BPM 授权')
    caseRecord.notes.push('OA 请假受控记录 PARTIAL；精确业务阻断不等于提交成功，其他业务/网络异常仍失败')
    return null
  }
  return closureId(closureData(response))
}

export async function cleanupOaLocalBooking ({ api, ownerApi, id, marker, roomId, userId, entry }) {
  assertClosureMarker(marker, 'OA001')
  id = closureId(id)
  roomId = closureId(roomId)
  userId = closureId(userId)
  const get = async () => closureData(await api.getBusiness(`/oa/meeting-booking/get?id=${id}`, { timeoutMs: 10000 }))
  const owns = (current) => String(current?.id) === id && current.subject === marker &&
    current.description === marker && String(current.organizerUserId) === userId && String(current.roomId) === roomId
  const current = await get()
  if (!owns(current)) throw new Error('预约所有权不符')
  let mutationError
  if (current.status !== 30) {
    try { closureData(await ownerApi.putBusiness(`/oa/meeting-booking/cancel?id=${id}`, undefined, { timeoutMs: 10000 })) } catch (error) {
      mutationError = error
      entry.transportErrors ||= []
      entry.transportErrors.push(error.message)
    }
  }
  const final = await get()
  if (!owns(final) || final.status !== 30) throw mutationError || new Error('预约取消未回读，不自动重试写请求')
  entry.cleanup = 'RETAINED_AUDIT; status=30; no formal delete API'
}

export function oaLocalApproverCredentials (settings = config) {
  return [
    [settings.hrmApproverUsername, settings.hrmApproverPassword],
    [settings.purchaseApproverUsername, settings.purchaseApproverPassword],
    [settings.financeApproverUsername, settings.financeApproverPassword],
    [settings.finalApproverUsername, settings.finalApproverPassword],
    [settings.warehouseApproverUsername, settings.warehouseApproverPassword],
    [settings.warehouseFinalApproverUsername, settings.warehouseFinalApproverPassword],
    [settings.username, settings.password]
  ].filter(([username, password]) => username && password)
}

const bpmId = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(value)) {
    throw new Error('OA BPM ID 不合法')
  }
  return value
}

export function oaLocalLeaveForgery ({ marker, employeeId, userId }) {
  assertClosureMarker(marker, 'OA001')
  return {
    employeeId: closureId(employeeId), userId: closureId(userId), approvalStatus: 2,
    processInstanceId: `${marker}-FORGED-PROCESS`, approvalTime: '2000-01-01T00:00:00',
    approvalReason: `${marker}-FORGED-APPROVE`
  }
}

const boundaryCount = (rows, tag) => {
  const matches = rows.filter((row) => row[0] === tag)
  if (matches.length !== 1 || matches[0].length !== 2 || !/^\d+$/.test(matches[0][1])) {
    throw new Error(`OA 门户写边界缺少精确 SQL 计数 ${tag}`)
  }
  return matches[0][1]
}

const fakeLeaveSql = (processId) => `
  SELECT 'fake-history', COUNT(*) FROM ACT_HI_PROCINST
    WHERE TENANT_ID_='1' AND PROC_INST_ID_='${processId}';
  SELECT 'fake-runtime', COUNT(*) FROM ACT_RU_EXECUTION
    WHERE TENANT_ID_='1' AND PROC_INST_ID_='${processId}';
  SELECT 'fake-leaves', COUNT(*) FROM hrm_attendance_leave
    WHERE tenant_id=1 AND deleted=0 AND process_instance_id='${processId}'`

const assertOaLeaveProbe = (probe) => {
  assertClosureMarker(probe.marker, 'OA001')
  const { marker } = probe
  const employeeId = closureId(probe.employeeId)
  const ownerUserId = closureId(probe.ownerUserId)
  const otherEmployeeId = closureId(probe.otherEmployeeId)
  const otherUserId = closureId(probe.otherUserId)
  const forged = oaLocalLeaveForgery({ marker, employeeId: otherEmployeeId, userId: otherUserId })
  const actors = Array.isArray(probe.preflight) ? probe.preflight.filter((row) => row[0] === 'actor') : []
  if (employeeId === otherEmployeeId || ownerUserId === otherUserId ||
      probe.reason !== `${marker}-CANCEL` ||
      Object.entries(forged).some(([key, value]) => probe.forged?.[key] !== value) ||
      actors.length !== 2 ||
      !actors.some((row) => row.length === 4 && row[1] === employeeId && row[2] === ownerUserId && row[3] === marker) ||
      !actors.some((row) => row.length === 4 && row[1] === otherEmployeeId && row[2] === otherUserId && row[3] === `${marker}-OTHER`) ||
      ['marked-leaves', 'fake-history', 'fake-runtime', 'fake-leaves']
        .some((tag) => boundaryCount(probe.preflight, tag) !== '0')) {
    throw new Error('OA 伪造字段请求或 SQL 前置证据不完整')
  }
}

export async function preflightOaLocalLeaveForgery ({
  marker, employeeId, ownerUserId, otherEmployeeId, otherUserId, caseRecord, read = runReadOnlySql
}) {
  assertClosureMarker(marker, 'OA001')
  employeeId = closureId(employeeId)
  ownerUserId = closureId(ownerUserId)
  otherEmployeeId = closureId(otherEmployeeId)
  otherUserId = closureId(otherUserId)
  if (employeeId === otherEmployeeId || ownerUserId === otherUserId) {
    throw new Error('OA 伪造字段负例必须使用两个不同的本轮合成身份')
  }
  const forged = oaLocalLeaveForgery({ marker, employeeId: otherEmployeeId, userId: otherUserId })
  const reason = `${marker}-CANCEL`
  const rows = await readClosureDb(caseRecord, 'oa-leave-forgery-preflight', `
    SELECT 'actor', CAST(e.id AS CHAR), CAST(e.user_id AS CHAR), e.job_number
    FROM hrm_employee e JOIN system_users u ON u.id=e.user_id AND u.tenant_id=e.tenant_id
    WHERE e.tenant_id=1 AND e.deleted=0 AND u.deleted=0 AND u.status=0 AND u.remark='${marker}'
      AND ((e.id=${employeeId} AND e.user_id=${ownerUserId} AND e.job_number='${marker}' AND e.remark='${marker}')
        OR (e.id=${otherEmployeeId} AND e.user_id=${otherUserId} AND e.job_number='${marker}-OTHER' AND e.remark='${marker}-OTHER'));
    SELECT 'marked-leaves', COUNT(*) FROM hrm_attendance_leave
      WHERE tenant_id=1 AND deleted=0 AND (reason='${reason}' OR remark='${reason}');
    ${fakeLeaveSql(forged.processInstanceId)}`, read)
  const probe = { marker, employeeId, ownerUserId, otherEmployeeId, otherUserId, forged, reason, preflight: rows }
  assertOaLeaveProbe(probe)
  return probe
}

export async function readOaLocalLeaveBoundary ({
  api, ownerApi, leaveId, probe, stage, caseRecord, read = runReadOnlySql
}) {
  assertOaLeaveProbe(probe)
  leaveId = closureId(leaveId)
  const fact = closureData(await api.getBusiness(`/hrm/attendance/leave/get?id=${leaveId}`))
  const processId = bpmId(fact?.processInstanceId)
  const process = closureData(await ownerApi.getBusiness(`/bpm/process-instance/get?id=${encodeURIComponent(processId)}`))
  const rows = await readClosureDb(caseRecord, `oa-leave-boundary-${stage}`, `
    SELECT 'link', CAST(l.id AS CHAR), CAST(l.employee_id AS CHAR), CAST(e.user_id AS CHAR),
      l.approval_status, l.process_instance_id, h.BUSINESS_KEY_, h.PROC_DEF_ID_, h.START_USER_ID_,
      IF(h.END_TIME_ IS NULL,0,1), IF(l.approval_time IS NULL,0,1),
      (SELECT COUNT(*) FROM ACT_RU_TASK t WHERE t.TENANT_ID_='1' AND t.PROC_INST_ID_=h.PROC_INST_ID_),
      (SELECT COUNT(*) FROM ACT_RU_EXECUTION x WHERE x.TENANT_ID_='1' AND x.PROC_INST_ID_=h.PROC_INST_ID_),
      (SELECT CAST(v.LONG_ AS CHAR) FROM ACT_HI_VARINST v WHERE v.PROC_INST_ID_=h.PROC_INST_ID_
        AND v.NAME_='PROCESS_STATUS' AND v.TASK_ID_ IS NULL AND v.EXECUTION_ID_=h.PROC_INST_ID_),
      IF(l.approval_reason IS NULL OR l.approval_reason='',0,1),
      IF(l.approval_reason='${probe.forged.approvalReason}',1,0),
      IF(l.approval_time='2000-01-01 00:00:00',1,0)
    FROM hrm_attendance_leave l JOIN hrm_employee e ON e.id=l.employee_id AND e.tenant_id=l.tenant_id
      JOIN ACT_HI_PROCINST h ON h.PROC_INST_ID_=l.process_instance_id
    WHERE l.tenant_id=1 AND l.deleted=0 AND l.id=${leaveId} AND e.deleted=0 AND h.TENANT_ID_='1';
    SELECT 'marked-leaves', COUNT(*) FROM hrm_attendance_leave
      WHERE tenant_id=1 AND deleted=0 AND (reason='${probe.reason}' OR remark='${probe.reason}');
    SELECT 'business-processes', COUNT(*) FROM ACT_HI_PROCINST
      WHERE TENANT_ID_='1' AND BUSINESS_KEY_='${leaveId}' AND PROC_DEF_ID_ LIKE 'hrm-leave-approval:%';
    ${fakeLeaveSql(probe.forged.processInstanceId)}`, read)
  const links = rows.filter((row) => row[0] === 'link')
  const row = links[0]
  if (links.length !== 1 || row.length !== 17 ||
      row[1] !== leaveId || String(fact?.id) !== leaveId ||
      row[2] !== probe.employeeId || String(fact.employeeId) !== probe.employeeId ||
      fact.reason !== probe.reason || fact.remark !== probe.reason ||
      row[3] !== probe.ownerUserId || row[5] !== processId ||
      row[6] !== leaveId || process?.id !== processId || String(process.businessKey) !== leaveId ||
      row[7] !== process.processDefinitionId || !row[7]?.startsWith('hrm-leave-approval:') ||
      row[8] !== probe.ownerUserId || String(process.startUser?.id) !== probe.ownerUserId ||
      row[4] !== String(fact.approvalStatus) || row[13] !== String(process.status)) {
    throw new Error('OA 门户 HRM/BPM 身份、流程或 SQL 关联证据不完整/不一致')
  }
  for (const tag of ['marked-leaves', 'business-processes', 'fake-history', 'fake-runtime', 'fake-leaves']) {
    boundaryCount(rows, tag)
  }
  return { fact, process, rows }
}

export async function verifyOaLocalLeaveBoundary ({ stage, body, probe, caseRecord, ...options }) {
  if (!['create', 'cancel'].includes(stage)) throw new Error('OA 未知门户写边界阶段')
  assertOaLeaveProbe(probe)
  // These are fields deliberately sent to the real endpoints, not a fabricated refusal response.
  if (Object.entries(probe.forged).some(([key, value]) => body[key] !== value) ||
      (stage === 'create' && (body.reason !== probe.reason || body.remark !== probe.reason)) ||
      (stage === 'cancel' && (!probe.created || String(body.id) !== probe.created.leaveId))) {
    throw new Error('OA 伪造字段请求或 SQL 前置证据不完整')
  }
  const state = await readOaLocalLeaveBoundary({ ...options, probe, stage, caseRecord })
  const { fact, process, rows } = state
  const leaveId = closureId(options.leaveId)
  const links = rows.filter((row) => row[0] === 'link')
  const row = links[0]
  const expectedStatus = stage === 'create' ? 1 : 4
  const same = fact.processInstanceId !== probe.forged.processInstanceId &&
    fact.approvalStatus === expectedStatus && process.status === expectedStatus &&
    row[15] === '0' && row[16] === '0' &&
    boundaryCount(rows, 'marked-leaves') === '1' && boundaryCount(rows, 'business-processes') === '1' &&
    ['fake-history', 'fake-runtime', 'fake-leaves'].every((tag) => boundaryCount(rows, tag) === '0')
  const lifecycle = stage === 'create'
    ? fact.approvalTime == null && !fact.approvalReason && process.endTime == null &&
      row?.[9] === '0' && row?.[10] === '0' && row?.[14] === '0' &&
      /^[1-9]\d*$/.test(row?.[11] || '') && /^[1-9]\d*$/.test(row?.[12] || '')
    : Boolean(fact.approvalTime) && fact.approvalTime !== probe.forged.approvalTime &&
      fact.approvalReason !== probe.forged.approvalReason && Boolean(process.endTime) &&
      row?.[9] === '1' && row?.[10] === '1' && row?.[11] === '0' && row?.[12] === '0' &&
      process.id === probe.created.processId && process.processDefinitionId === probe.created.definitionId
  closureCheck(caseRecord, stage === 'create' ? OA_LOCAL_CHECKS.forgedCreate : OA_LOCAL_CHECKS.forgedCancel,
    same && lifecycle,
    `endpoint=${stage === 'create' ? 'POST create' : 'PUT cancel'}; leaveId=${leaveId}; processId=${process?.id}; expectedStatus=${expectedStatus}; sqlLink=${links.length}`)
  if (stage === 'create') probe.created = { leaveId, processId: process.id, definitionId: process.processDefinitionId }
  return state
}

// Match current tasks, never infer eligibility from a role name or a seed password.
export async function approveOaLocalLeave ({
  api, ownerApi, leave, marker, employeeId, ownerUserId, caseRecord, record, read = runReadOnlySql,
  approvers = oaLocalApproverCredentials(), apiFactory = createApiClient,
  pause = () => new Promise((resolve) => setTimeout(resolve, 500)), pollAttempts = 20
}) {
  assertClosureMarker(marker, 'OA001')
  const leaveId = closureId(leave.id)
  employeeId = closureId(employeeId)
  ownerUserId = closureId(ownerUserId)
  const processId = bpmId(leave.fact?.processInstanceId)
  const reason = `${marker}-APPROVE`
  const credentials = new Map()
  for (const entry of approvers) {
    const [username, password] = Array.isArray(entry) ? entry : [entry?.username, entry?.password]
    if (!username || !password) continue
    if (credentials.has(username) && credentials.get(username) !== password) {
      throw new Error('OA 同一审批账号配置了冲突凭据')
    }
    credentials.set(username, password)
  }
  const gap = (message) => {
    closureGap(caseRecord, 2, message)
    return { completed: false, processId }
  }
  const owns = (fact) => String(fact?.id) === leaveId && String(fact.employeeId) === employeeId &&
    fact.processInstanceId === processId && fact.reason === reason && fact.remark === reason
  if (!owns(leave.fact)) throw new Error('OA 审批前请假专属所有权不符')
  const tasksPath = `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`
  const readState = async () => {
    const fact = closureData(await api.getBusiness(`/hrm/attendance/leave/get?id=${leaveId}`))
    const process = closureData(await ownerApi.getBusiness(`/bpm/process-instance/get?id=${encodeURIComponent(processId)}`))
    const tasks = []
    const collect = (rows) => {
      for (const task of rows) {
        bpmId(task.id)
        if (task.processInstanceId !== processId || tasks.some((row) => row.id === task.id)) {
          throw new Error('OA 任务不属于精确请假流程或任务重复')
        }
        tasks.push(task)
        if (task.children?.length) collect(task.children)
      }
    }
    collect(closureList(await api.getBusiness(tasksPath)))
    if (!owns(fact) || process?.id !== processId || String(process.businessKey) !== leaveId ||
        String(process.startUser?.id) !== ownerUserId ||
        !process.processDefinitionId?.startsWith('hrm-leave-approval:')) {
      throw new Error('OA HRM/BPM 请假所有权、发起人或业务键不符')
    }
    return { fact, process, tasks }
  }
  const link = async (stage) => {
    const rows = await readClosureDb(caseRecord, stage, `
      SELECT CAST(l.id AS CHAR), CAST(l.employee_id AS CHAR), l.approval_status,
        l.process_instance_id, h.BUSINESS_KEY_, h.PROC_DEF_ID_,
        (SELECT COUNT(*) FROM ACT_RU_TASK t WHERE t.TENANT_ID_='1' AND t.PROC_INST_ID_=h.PROC_INST_ID_)
      FROM hrm_attendance_leave l JOIN ACT_HI_PROCINST h ON h.PROC_INST_ID_=l.process_instance_id
      WHERE l.tenant_id=1 AND l.deleted=0 AND l.id=${leaveId} AND h.TENANT_ID_='1'`, read)
    if (rows.length !== 1 || rows[0][0] !== leaveId || rows[0][1] !== employeeId ||
        rows[0][3] !== processId || rows[0][4] !== leaveId ||
        !rows[0][5]?.startsWith('hrm-leave-approval:')) {
      throw new Error('OA 审批 HRM/BPM 租户与业务键数据库证据不符')
    }
    return rows[0]
  }
  let state = await readState()
  const definitionId = state.process.processDefinitionId
  const initialLink = await link('oa-approve-link-before')
  if (initialLink[5] !== definitionId || state.fact.approvalStatus !== 1 || state.process.status !== 1) {
    throw new Error('OA 审批初始流程不是同一运行中的请假')
  }
  const sessions = new Map()
  const approvedTasks = new Set()
  let failure
  try {
    for (let step = 0; step < 24; step++) {
      if (state.process.processDefinitionId !== definitionId) throw new Error('OA 审批流程定义发生变化')
      const unfinished = state.tasks.filter((task) => task.endTime == null)
      if (state.fact.approvalStatus === 2 && state.process.status === 2 && !unfinished.length) {
        const finalLink = await link('oa-approve-link-after')
        closureCheck(caseRecord, OA_LOCAL_CHECKS.approve,
          Boolean(state.fact.approvalTime) && Boolean(state.process.endTime) &&
          finalLink[2] === '2' && finalLink[5] === definitionId && finalLink[6] === '0' &&
          approvedTasks.size > 0,
          `leaveId=${leaveId}; processId=${processId}; approvedTasks=${approvedTasks.size}; activeTasks=${finalLink[6]}`)
        return { completed: true, processId, approvedTasks: [...approvedTasks] }
      }
      if (state.fact.approvalStatus !== 1 || state.process.status !== 1) {
        throw new Error('OA 审批未得到 HRM/BPM 一致通过终态')
      }
      const task = unfinished.find((row) => row.status === 1)
      if (!task) throw new Error('OA 流程仍审批中但没有可执行的正式待办')
      if (approvedTasks.has(task.id)) throw new Error('OA 已提交任务仍活动，不重复审批')
      let users = task.assigneeUser?.id != null ? [task.assigneeUser] : []
      if (!users.length) {
        const detail = closureData(await ownerApi.getBusiness(
          `/bpm/process-instance/get-approval-detail?processInstanceId=${encodeURIComponent(processId)}&taskId=${encodeURIComponent(task.id)}`))
        if (detail?.processInstance?.id !== processId) throw new Error('OA 候选人详情流程不符')
        const node = detail.activityNodes?.find((row) => row.id === task.taskDefinitionKey &&
          row.tasks?.some((entry) => entry.id === task.id))
        users = node?.candidateUsers || []
      }
      let selected
      const unmatched = []
      for (const candidate of users) {
        const userId = closureId(candidate.id)
        const user = closureData(await api.getBusiness(`/system/user/get?id=${userId}`))
        if (String(user?.id) !== userId || !user.username) throw new Error('OA 审批人用户回读不符')
        if (!credentials.has(user.username)) {
          unmatched.push(`${userId}/${user.username}`)
          continue
        }
        let session = sessions.get(user.username)
        if (!session) {
          const auth = closureData(await apiFactory({ tenantId: '1', record }).postBusiness(
            '/system/auth/login-encrypted',
            { username: user.username, password: credentials.get(user.username), captchaVerification: '' },
            { encrypted: true }))
          if (!auth?.accessToken || (auth.tenantId != null && String(auth.tenantId) !== '1')) {
            throw new Error('OA 审批登录没有令牌或租户不符')
          }
          session = apiFactory({ token: auth.accessToken, tenantId: '1', record })
          sessions.set(user.username, session)
          const info = closureData(await session.getBusiness('/system/auth/get-permission-info'))
          if (String(info?.user?.id) !== userId || info.user.username !== user.username) {
            throw new Error('OA 审批登录身份与实际任务用户不符')
          }
        }
        const todo = closureData(await session.getBusiness(
          `/bpm/task/my-todo?processInstanceId=${encodeURIComponent(processId)}&taskId=${encodeURIComponent(task.id)}`))
        if (todo == null) continue
        // my-todo can fall back to another task; an exact task match is mandatory.
        if (todo.id !== task.id || todo.processInstanceId !== processId || todo.status !== 1 ||
            (task.assigneeUser?.id != null && String(task.assigneeUser.id) !== userId)) {
          throw new Error('OA 审批账号未收到精确流程待办')
        }
        selected = { session, todo, userId, username: user.username }
        break
      }
      if (!selected) return gap(`正式 HRM 待办缺少匹配凭据或本人可执行待办；taskId=${task.id}; ` +
        `assignee/candidates=${unmatched.join(',') || users.map((user) => String(user.id)).join(',') || '未返回'}；未重置密码、认领任务或更改授权`)
      if (selected.todo.signEnable === true) return gap(`正式待办 taskId=${task.id} 需要真实签名，未伪造签名`)
      const response = await selected.session.putBusiness('/bpm/task/approve', {
        id: task.id, reason: `${marker} 正式 HRM 请假审批`
      })
      if (closureData(response) !== true) throw new Error('OA 正式审批没有返回明确成功数据')
      approvedTasks.add(task.id)
      let advanced = false
      for (let poll = 0; poll < pollAttempts; poll++) {
        state = await readState()
        const previous = state.tasks.find((row) => row.id === task.id)
        const ready = (state.fact.approvalStatus === 2 && state.process.status === 2) ||
          (state.fact.approvalStatus === 1 && state.process.status === 1 &&
            state.tasks.some((row) => row.endTime == null && row.status === 1))
        if (previous?.endTime != null && previous.status === 2 && ready) {
          advanced = true
          break
        }
        await pause()
      }
      if (!advanced) throw new Error('OA 审批响应后没有任务通过历史证据，不重试写请求')
      caseRecord.evidence.push(`OA 正式 BPM 审批：processId=${processId}; taskId=${task.id}; userId=${selected.userId}; username=${selected.username}`)
    }
    return gap(`正式 HRM 流程超过 24 个审批节点；processId=${processId}`)
  } catch (error) {
    failure = error
    throw error
  } finally {
    const errors = []
    for (const session of sessions.values()) {
      try { closureData(await session.postBusiness('/system/auth/logout')) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'OA 审批会话退出失败')
  }
}

async function runLeave ({ api, owner, outsider, ownerApi, outsiderApi, marker, cleanup, caseRecord, record, read, dependencies }) {
  const employee = await createClosureEmployee({ adminApi: api, actor: owner, record: caseRecord, cleanup, marker })
  const otherEmployee = await createClosureEmployee({ adminApi: api, actor: outsider, record: caseRecord, cleanup,
    marker: `${marker}-OTHER` })
  const links = closureList(await api.getBusiness(`/hrm/employee/user-links?userIds=${owner.userId}`))
  const role = closureData(await api.getBusiness(`/system/role/get?id=${owner.roleId}`))
  const binding = await readClosureDb(caseRecord, 'oa-owner-employee-binding', `
    SELECT CAST(id AS CHAR), CAST(user_id AS CHAR), CAST(dept_id AS CHAR)
    FROM hrm_employee WHERE tenant_id=1 AND deleted=0 AND user_id=${owner.userId}`, read)
  closureCheck(caseRecord, 'OA 请假发起人已真实绑定员工且未放宽角色数据范围',
    links.length === 1 && String(links[0].employeeId) === employee.employeeId &&
    binding.length === 1 && binding[0][0] === employee.employeeId && binding[0][1] === owner.userId &&
    String(role?.id) === owner.roleId && role.dataScope === 5,
    `employeeId=${employee.employeeId}; userId=${owner.userId}; roleDataScope=${role?.dataScope}`)
  const selfResponse = await ownerApi.get('/hrm/portal/employee/get')
  if (selfResponse?.code !== 0 &&
      !matchesExpectedBusinessRejection(selfResponse, OA_LOCAL_REJECTIONS.employeeMissing)) {
    closureData(selfResponse)
  }
  if (selfResponse?.code === 0) {
    closureCheck(caseRecord, 'OA SELF 本人正式档案读取与绑定一致',
      String(selfResponse.data?.id) === employee.employeeId, `employeeId=${employee.employeeId}`)
  }
  const definitions = closureList(await api.getBusiness('/bpm/process-definition/list?suspensionState=1'))
  const definition = definitions.find((row) => row.key === 'hrm-leave-approval')
  if (!definition?.id) {
    closureGap(caseRecord, 0, '缺少已部署 hrm-leave-approval；不发布或更改共享 BPM 模型')
    return
  }
  const body = { type: '事假', startTime: closureTime(Date.now() + 86400000 * 2),
    endTime: closureTime(Date.now() + 86400000 * 2 + 3600000), day: 0.13, reason: marker, remark: marker }
  const probe = await preflightOaLocalLeaveForgery({ marker, employeeId: employee.employeeId,
    ownerUserId: owner.userId, otherEmployeeId: otherEmployee.employeeId, otherUserId: outsider.userId, caseRecord, read })
  const createLeave = async (suffix, injected = {}) => {
    const reason = `${marker}-${suffix}`
    const owns = (row, id) => String(row.id) === id &&
      String(row.employeeId) === employee.employeeId && row.reason === reason && row.remark === reason
    const id = await createClosureResource({
      record: caseRecord, cleanup, label: `${marker} 请假 ${suffix}`, allowNoResource: true,
      recovery: { kind: 'leave', marker, reason, employeeId: employee.employeeId, userId: owner.userId,
        ...(suffix === 'CANCEL' ? { injectedEmployeeId: probe.forged.employeeId,
          injectedProcessInstanceId: probe.forged.processInstanceId } : {}) },
      blocks: [employee.employeeId, owner.userId, otherEmployee.employeeId, outsider.userId], owns,
      find: () => findClosureRows(api,
        `/hrm/attendance/leave/page?pageNo=1&pageSize=100&employeeId=${employee.employeeId}`,
        (row) => row.reason === reason),
      create: () => submitOaLocalLeave({ ownerApi, caseRecord,
        body: { ...body, ...injected, reason, remark: reason },
        binding: { verified: true, employeeId: employee.employeeId, userId: owner.userId,
          roleId: owner.roleId, roleDataScope: role.dataScope, selfResponse } }),
      remove: async (id, entry) => {
      const current = closureData(await api.getBusiness(`/hrm/attendance/leave/get?id=${id}`))
      if (!current || !owns(current, id)) throw new Error('请假所有权不符')
      let mutationError
      if (current.approvalStatus === 1) {
        try {
          closureData(await ownerApi.putBusiness('/hrm/portal/attendance/leave/cancel',
            { id, reason: `${marker} cleanup` }, { timeoutMs: 10000 }))
        } catch (error) {
          mutationError = error
          entry.transportErrors ||= []
          entry.transportErrors.push(error.message)
        }
      }
      const final = closureData(await api.getBusiness(`/hrm/attendance/leave/get?id=${id}`))
      if (!final || !owns(final, id) || !/^[a-zA-Z0-9:_-]+$/.test(final.processInstanceId || '')) {
        throw new Error('请假清理事实或 BPM 流程 ID 不符')
      }
      const active = await readClosureDb(caseRecord, `leave-${id}-cleanup`, `
        SELECT COUNT(*) FROM ACT_RU_TASK WHERE PROC_INST_ID_='${final.processInstanceId}' AND TENANT_ID_='1'`, read)
      if (![2, 3, 4].includes(final.approvalStatus) || active?.[0]?.[0] !== '0') {
        throw mutationError || new Error('请假未终态或仍有活动 BPM 待办')
      }
      entry.cleanup = `RETAINED_AUDIT; approvalStatus=${final.approvalStatus}; activeTasks=0; no formal delete API`
      }
    })
    if (id == null) return null
    return { id, fact: closureData(await api.getBusiness(`/hrm/attendance/leave/get?id=${id}`)) }
  }
  const forgedCreateBody = { ...body, ...probe.forged, reason: probe.reason, remark: probe.reason }
  const leave = await createLeave('CANCEL', probe.forged)
  if (leave == null) return
  await verifyOaLocalLeaveBoundary({ stage: 'create', body: forgedCreateBody, probe, leaveId: leave.id,
    api, ownerApi, caseRecord, read })
  const processId = String(leave.fact?.processInstanceId || '')
  if (!/^[a-zA-Z0-9:_-]+$/.test(processId)) throw new Error('HRM 请假没有合法 BPM 流程 ID')
  const process = closureData(await ownerApi.getBusiness(`/bpm/process-instance/get?id=${processId}`))
  const linkage = await readClosureDb(caseRecord, 'oa-hrm-bpm-link', `
    SELECT CAST(l.id AS CHAR), CAST(l.employee_id AS CHAR), l.approval_status,
      l.process_instance_id, h.BUSINESS_KEY_, h.PROC_DEF_ID_
    FROM hrm_attendance_leave l JOIN ACT_HI_PROCINST h ON h.PROC_INST_ID_=l.process_instance_id
    WHERE l.tenant_id=1 AND l.deleted=0 AND l.id=${leave.id} AND h.TENANT_ID_='1'`, read)
  closureCheck(caseRecord, OA_LOCAL_CHECKS.submit,
    String(leave.fact.employeeId) === employee.employeeId && leave.fact.approvalStatus === 1 &&
    process?.id === processId && linkage.length === 1 && linkage[0][0] === leave.id &&
    linkage[0][1] === employee.employeeId && linkage[0][4] === leave.id &&
    linkage[0][5].startsWith('hrm-leave-approval:'), `leaveId=${leave.id}; processId=${processId}; employeeId=${employee.employeeId}`)
  const snapshot = async () => ({
    leave: closureData(await api.getBusiness(`/hrm/attendance/leave/get?id=${leave.id}`)),
    rows: await readClosureDb(caseRecord, 'oa-leave-rejection-count', `
      SELECT COUNT(*) FROM hrm_attendance_leave
      WHERE tenant_id=1 AND deleted=0 AND employee_id=${employee.employeeId};
      SELECT COUNT(*) FROM ACT_HI_PROCINST WHERE TENANT_ID_='1' AND BUSINESS_KEY_='${leave.id}'
        AND PROC_DEF_ID_ LIKE 'hrm-leave-approval:%'`, read)
  })
  await expectOaLocalRejection({ api: ownerApi, method: 'POST', path: '/hrm/portal/attendance/leave/create',
    body, contract: OA_LOCAL_REJECTIONS.overlap, snapshot, record: caseRecord, name: OA_LOCAL_CHECKS.overlap })
  await expectOaLocalRejection({ api: outsiderApi, method: 'PUT', path: '/hrm/portal/attendance/leave/cancel',
    body: { id: leave.id, reason: marker,
      ...oaLocalLeaveForgery({ marker, employeeId: employee.employeeId, userId: owner.userId }) },
    contract: OA_LOCAL_REJECTIONS.otherLeave,
    snapshot: () => readOaLocalLeaveBoundary({ api, ownerApi, leaveId: leave.id, probe,
      stage: 'outsider-cancel', caseRecord, read }),
    record: caseRecord, name: OA_LOCAL_CHECKS.forgedOtherCancel })
  const forgedCancelBody = { id: leave.id, reason: `${marker} cancel`, ...probe.forged }
  if (closureData(await ownerApi.putBusiness('/hrm/portal/attendance/leave/cancel', forgedCancelBody)) !== true) {
    throw new Error('OA 门户正式取消未返回明确 true；不以伪造字段请求的 HTTP 成功作证')
  }
  await verifyOaLocalLeaveBoundary({ stage: 'cancel', body: forgedCancelBody, probe, leaveId: leave.id,
    api, ownerApi, caseRecord, read })
  const cancelled = closureData(await api.getBusiness(`/hrm/attendance/leave/get?id=${leave.id}`))
  const cancelledProcess = closureData(await ownerApi.getBusiness(`/bpm/process-instance/get?id=${processId}`))
  const active = await readClosureDb(caseRecord, 'oa-cancel-active-tasks', `
    SELECT COUNT(*) FROM ACT_RU_TASK WHERE TENANT_ID_='1' AND PROC_INST_ID_='${processId}'`, read)
  closureCheck(caseRecord, OA_LOCAL_CHECKS.cancel, cancelled?.approvalStatus === 4 &&
    cancelledProcess?.status === 4 && active?.[0]?.[0] === '0' && Boolean(cancelled.approvalTime),
    `leaveId=${leave.id}; processId=${processId}; status=${cancelled?.approvalStatus}; activeTasks=${active?.[0]?.[0]}`)
  await expectOaLocalRejection({ api: ownerApi, method: 'PUT', path: '/hrm/portal/attendance/leave/cancel',
    body: { id: leave.id, reason: marker }, contract: OA_LOCAL_REJECTIONS.cancelledLeave,
    snapshot, record: caseRecord, name: 'OA 已取消请假不能重复取消且终态不变' })
  caseRecord.evidence.push('OA 门户公开请假写入口仅核对 POST create/PUT cancel：伪造字段不能选择其他员工、通过终态或假流程；取消须由原真实 BPM 结束并与 HRM 一致，不外推其他管理接口')
  const approvers = dependencies.approvers ?? oaLocalApproverCredentials(dependencies.config || config)
  if (!approvers.length) {
    closureGap(caseRecord, 2, '缺少正式 HRM 审批人的已确认凭据；不重置共享密码、不临时改 BPM 候选角色或授权策略。取消不等于审批完成')
    return
  }
  const approved = await createLeave('APPROVE')
  if (approved == null) return
  await (dependencies.approveLeave || approveOaLocalLeave)({
    api, ownerApi, leave: approved, marker, employeeId: employee.employeeId, ownerUserId: owner.userId,
    approvers, caseRecord, record, read,
    apiFactory: dependencies.createApiClient || createApiClient
  })
}

export async function runOaLocalClosure (context, dependencies = {}) {
  const { caseRecord, page, record, outputDir } = context
  finalizeLocalAssertions(caseRecord, OA_LOCAL_ASSERTIONS, OA_LOCAL_EVIDENCE)
  assertHrmOaLocalTarget(dependencies.config || config, dependencies.env || process.env)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const apiFactory = dependencies.createApiClient || createApiClient
  const api = context.api || apiFactory({ token: await login(page), tenantId: '1', record })
  const read = dependencies.runReadOnlySql || runReadOnlySql
  const marker = dependencies.marker || closureMarker('OA001')
  assertClosureMarker(marker, 'OA001')
  const cleanup = createLocalClosureCleanup(caseRecord)
  let primaryError
  try {
    const permissions = [...bookingPermissions, 'hrm:portal:query', 'hrm:portal:attendance:leave']
    const owner = await createClosureActor({ adminApi: api, record: caseRecord, cleanup, marker,
      suffix: 'owner', permissions, read })
    const outsider = await createClosureActor({ adminApi: api, record: caseRecord, cleanup, marker,
      suffix: 'other', permissions, read })
    const ownerApi = await loginClosureActor(owner, { record, apiFactory })
    const outsiderApi = await loginClosureActor(outsider, { record, apiFactory })
    const roomName = `${marker}-ROOM`
    const ownsRoom = (room, id) => String(room?.id) === id && room.name === roomName &&
      room.remark === marker && room.location === marker
    const roomId = await createClosureResource({
      record: caseRecord, cleanup, label: `${marker} 会议室`, recovery: { kind: 'room', marker, name: roomName },
      find: () => findClosureRows(api, `/oa/meeting-room/page?pageNo=1&pageSize=100&name=${roomName}`,
        (room) => room.name === roomName),
      owns: ownsRoom,
      create: async () => closureData(await api.postBusiness('/oa/meeting-room/create', {
        name: roomName, location: marker, capacity: 4, status: 0, sort: 999, remark: marker
      })),
      remove: async (id, entry) => {
      await deleteClosureResource({ api, path: `/oa/meeting-room/delete?id=${id}`, entry,
        get: async () => closureData(await api.getBusiness(`/oa/meeting-room/get?id=${id}`, { timeoutMs: 10000 })),
        owns: (room) => ownsRoom(room, id) })
      const active = await readClosureDb(caseRecord, 'oa-room-cleanup', `
        SELECT COUNT(*) FROM oa_meeting_booking
        WHERE tenant_id=1 AND deleted=0 AND room_id=${id} AND status<>30`, read)
      closureCheck(caseRecord, OA_LOCAL_CHECKS.cleanup, active?.[0]?.[0] === '0',
        `roomId=${id}; activeBookings=${active?.[0]?.[0]}; cancelled bookings retained`)
      }
    })
    const bookingBody = { roomId, subject: marker, attendeeUserIds: [],
      startTime: timeText(Date.now() + 86400000 * 3), endTime: timeText(Date.now() + 86400000 * 3 + 3600000),
      description: marker }
    const bookingId = await createClosureResource({
      record: caseRecord, cleanup, label: `${marker} 预约`,
      recovery: { kind: 'booking', marker, roomId, userId: owner.userId }, blocks: [roomId, owner.userId],
      find: () => findClosureRows(api,
        `/oa/meeting-booking/page?pageNo=1&pageSize=100&roomId=${roomId}&subject=${marker}`,
        (row) => row.subject === marker),
      owns: (row, id) => String(row.id) === id && row.subject === marker && row.description === marker &&
        String(row.roomId) === roomId && String(row.organizerUserId) === owner.userId,
      create: async () => closureData(await ownerApi.postBusiness('/oa/meeting-booking/create', bookingBody)),
      remove: (id, entry) => cleanupOaLocalBooking({ api, ownerApi, id, marker, roomId, userId: owner.userId, entry })
    })
    const booking = closureData(await api.getBusiness(`/oa/meeting-booking/get?id=${bookingId}`))
    closureCheck(caseRecord, OA_LOCAL_CHECKS.booking, booking?.subject === marker &&
      String(booking.organizerUserId) === owner.userId && String(booking.roomId) === roomId && booking.status === 20,
      `bookingId=${bookingId}; roomId=${roomId}; organizer=${owner.userId}; status=${booking.status}`)
    const snapshot = async () => ({
      booking: closureData(await api.getBusiness(`/oa/meeting-booking/get?id=${bookingId}`)),
      rows: await readClosureDb(caseRecord, 'oa-booking-count', `
        SELECT COUNT(*) FROM oa_meeting_booking WHERE tenant_id=1 AND deleted=0 AND room_id=${roomId}`, read)
    })
    await expectOaLocalRejection({ api: ownerApi, method: 'POST', path: '/oa/meeting-booking/create',
      body: bookingBody, contract: OA_LOCAL_REJECTIONS.conflict, snapshot,
      record: caseRecord, name: OA_LOCAL_CHECKS.conflict })
    for (const [method, path, body, name] of [
      ['PUT', '/oa/meeting-booking/update', { ...bookingBody, id: bookingId, subject: `${marker}-DENIED` }, 'OA 非本人修改预约被拒绝'],
      ['PUT', `/oa/meeting-booking/cancel?id=${bookingId}`, undefined, 'OA 非本人取消预约被拒绝']
    ]) await expectOaLocalRejection({ api: outsiderApi, method, path, body,
      contract: OA_LOCAL_REJECTIONS.owner, snapshot, record: caseRecord, name })
    closureCheck(caseRecord, OA_LOCAL_CHECKS.owner, true, `bookingId=${bookingId}; owner=${owner.userId}; outsider=${outsider.userId}`)
    closureGap(caseRecord, 3, '本轮验证预约所有权写隔离；catalog“评论”未指明 BPM 评论、计划点评或讨论回复，不以预约检查替代评论权限隔离')
    await expectOaLocalRejection({ api, method: 'DELETE', path: `/oa/meeting-room/delete?id=${roomId}`,
      contract: OA_LOCAL_REJECTIONS.roomInUse, snapshot, record: caseRecord, name: 'OA 活动预约阻止删除专属会议室' })
    if (page && outputDir) {
      await (dependencies.showClosureRow || showClosureRow)({ page, api, marker, outputDir, record,
        component: 'oa/reservation/meeting/index', placeholder: '请输入会议主题' })
      closureCheck(caseRecord, 'OA headed 页面真实显示本轮已预约会议', true, marker)
    }
    await ownerApi.putBusiness(`/oa/meeting-booking/cancel?id=${bookingId}`)
    await expectOaLocalRejection({ api: ownerApi, method: 'PUT', path: `/oa/meeting-booking/cancel?id=${bookingId}`,
      contract: OA_LOCAL_REJECTIONS.cancelledBooking, snapshot, record: caseRecord, name: 'OA 预约重复取消精确拒绝且终态不变' })
    const cancelled = closureData(await api.getBusiness(`/oa/meeting-booking/get?id=${bookingId}`))
    const active = await readClosureDb(caseRecord, 'oa-cancelled-booking', `
      SELECT COUNT(*) FROM oa_meeting_booking WHERE tenant_id=1 AND deleted=0 AND room_id=${roomId} AND status<>30`, read)
    closureCheck(caseRecord, OA_LOCAL_CHECKS.cancelled, cancelled?.status === 30 && active?.[0]?.[0] === '0',
      `bookingId=${bookingId}; status=${cancelled?.status}; activeBookings=${active?.[0]?.[0]}`)
    await runLeave({ api, owner, outsider, ownerApi, outsiderApi, marker, cleanup, caseRecord, record, read, dependencies })
    caseRecord.evidence.push(`正式 OA/HRM 独立夹具 ${marker}：资源预约与请假尝试只走现有正式 API；提交结果以原断言映射为准，未新增事实表，未调用 WMS 领用`)
  } catch (error) {
    if (OA_LOCAL_EVIDENCE[1].some((name) => !caseRecord.checks.some((row) => row.name === name && row.passed))) {
      closureGap(caseRecord, 1, `门户 POST create/PUT cancel 伪造字段证据未完整：${error.message}；异常/404/拒绝未知字段不自动等同安全`)
    }
    primaryError = error
  } finally {
    try { await cleanup.cleanup() } catch (error) {
      primaryError = primaryError ? new AggregateError([primaryError, error], primaryError.message) : error
    }
    finalizeLocalAssertions(caseRecord, OA_LOCAL_ASSERTIONS, OA_LOCAL_EVIDENCE)
  }
  if (primaryError) throw primaryError
  return { ...finalizeLocalAssertions(caseRecord, OA_LOCAL_ASSERTIONS, OA_LOCAL_EVIDENCE) }
}
