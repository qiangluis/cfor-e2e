import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['HRM-001', 'PMS-001', 'OA-001']

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
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
    const projects = await api.getBusiness('/pms/project/page?pageNo=1&pageSize=100')
    const projectData = projects?.data || {}
    const rows = Array.isArray(projectData?.list) ? projectData.list : []
    caseRecord.checks.push({
      name: 'PMS 项目分页返回项目状态与数据权限字段',
      passed:
        projects?.code === 0 &&
        rows.length <= 100 &&
        rows.every((row) => row.id != null && typeof row.status === 'string'),
      details: `projects=${rows.length}`
    })
    if (rows[0]?.id) {
      const [members, workItems, estimate] = await Promise.all([
        api.getBusiness(`/pms/project/member/list?projectId=${rows[0].id}`),
        api.getBusiness(`/pms/work-item/page?pageNo=1&pageSize=100&projectId=${rows[0].id}`),
        api.getBusiness(`/pms/work-item/sum-estimate-hours?projectId=${rows[0].id}`)
      ])
      const itemData = workItems?.data || {}
      caseRecord.checks.push({
        name: '项目成员、工作项和工时统计均通过 PMS 事实接口读取',
        passed:
          Array.isArray(members?.data) &&
          Array.isArray(itemData?.list) &&
          estimate?.code === 0,
        details: `members=${members?.data?.length || 0}, workItems=${itemData?.list?.length || 0}`
      })
    } else {
      caseRecord.notes.push('当前租户无 PMS 项目，跳过成员/工作项明细回读。')
    }
    await openRoute(page, '/pms/project')
    await saveScreenshot(page, outputDir, 'pms-project-facts', record)
    caseRecord.evidence.push('真实登录后读取 PMS 项目、成员、工作项和工时统计接口')
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
