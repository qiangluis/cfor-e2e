import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'

const data = (response) => assertBusinessSuccess(response, 'workbench daily gap read').data
const id = (value) => {
  assert.match(String(value), /^[1-9]\d*$/)
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value))
  return String(value)
}

const list = (response) => {
  const value = data(response)
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.list)) return value.list
  return Array.isArray(value?.records) ? value.records : []
}

const todayText = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// IDs come from this round's recorded formal creation, never from guessed constants.
export function readWorkbenchPmReference (filename) {
  const source = realpathSync(filename)
  assert.ok(source.startsWith(`${realpathSync('/tmp/cfor-e2e')}/continue-20261013-project-`))
  const result = JSON.parse(readFileSync(source, 'utf8'))
  const item = result.cases?.find((row) => row.id === 'PB113-001')
  assert.ok(item && item.startedAt?.startsWith('2026-10-13'))
  assert.ok(item.checks.some((row) =>
    row.name === '本轮专属项目归属、状态与原计划日期回读不变' && row.passed === true))
  const evidence = item.evidence.find((row) =>
    /^创建并回读本轮专属空项目 projectId=/.test(row))
  const match = evidence?.match(
    /^创建并回读本轮专属空项目 projectId=([1-9]\d*), handoverId=([1-9]\d*), marker=(E2E_PB113_001_PROJECT-[A-Z0-9]+)$/)
  assert.ok(match, 'Missing recorded owned PM project creation')
  return { source, projectId: id(match[1]), handoverId: id(match[2]), marker: match[3] }
}

/**
 * Create a private project in the formal PM domain and attach the dedicated
 * workbench account through pm_project_role_assignment. The old pms_project
 * member API is intentionally not used here.
 */
export async function prepareWorkbenchDailyProject ({
  adminApi, account, marker, caseRecord, registry
}) {
  const profile = data(await adminApi.getBusiness('/system/user/profile/get'))
  const ownerId = id(profile?.id)
  const projectType = list(await adminApi.getBusiness(
    '/pm/modeling/list?configKey=projectType&status=ENABLED'
  )).find((row) => row?.configCode)?.configCode
  assert.ok(projectType, 'Missing enabled formal PM project type')

  const handoverId = id(data(await adminApi.postBusiness('/pm/handover/create', {
    sourceType: 'MANUAL',
    sourceBusinessNo: marker,
    projectName: `${marker} 专属日报项目`,
    projectType,
    customerNameSnapshot: marker,
    scopeIn: marker,
    commitments: marker,
    acceptanceConditions: marker,
    initialRisks: marker
  })))
  caseRecord.businessIds = [...(caseRecord.businessIds || []), {
    type: 'pm-handover', id: handoverId, marker
  }]
  caseRecord.fixtureResiduals = [...(caseRecord.fixtureResiduals || []), {
    type: 'pm-handover', id: handoverId, marker,
    reason: '保留本轮 PM 项目交接来源与审计记录，不删除来源'
  }]
  await adminApi.putBusiness(`/pm/handover/submit?id=${handoverId}`, undefined)
  const projectId = id(data(await adminApi.putBusiness('/pm/handover/review', {
    id: handoverId,
    decision: 'APPROVE',
    opinion: `${marker} 日报权限验证`,
    proposedPmId: ownerId,
    developmentManagerId: ownerId,
    consultantId: ownerId
  })))
  caseRecord.businessIds = [...(caseRecord.businessIds || []), {
    type: 'pm-project', id: projectId, handoverId, marker
  }]
  caseRecord.fixtureResiduals = [...(caseRecord.fixtureResiduals || []), {
    type: 'pm-project', id: projectId, handoverId, marker,
    reason: '正式 PM 项目无删除接口；保留本轮项目与交接审计记录'
  }]
  const project = data(await adminApi.getBusiness(`/pm/project/get?id=${projectId}`))
  assert.equal(id(project?.id), projectId)
  assert.equal(id(project?.handoverId), handoverId)
  assert.equal(project?.customerNameSnapshot, marker)

  const roleId = id(data(await adminApi.putBusiness('/pm/project-role/assign', {
    projectId,
    userId: account.userId,
    roleCode: 'REPORTER',
    effectiveStart: todayText(),
    sourceType: 'MANUAL',
    sourceId: handoverId
  })))
  caseRecord.businessIds = [...(caseRecord.businessIds || []), {
    type: 'pm-project-role', id: roleId, projectId, userId: account.userId, marker
  }]
  const fixture = { projectId, handoverId, roleId, ownerId, accountId: account.userId, project, marker }
  if (registry) registerWorkbenchDailyRoleCleanup({ adminApi, registry, fixture })
  const role = list(await adminApi.getBusiness(`/pm/project-role/list?projectId=${projectId}`))
    .find((row) => id(row.id) === roleId)
  assert.ok(role && id(role.userId) === id(account.userId) &&
    role.roleCode === 'REPORTER' && role.status === 'ACTIVE')

  caseRecord.evidence.push(
    `本轮专属正式 PM 项目 projectId=${projectId}, handoverId=${handoverId}, reporterRoleId=${roleId}, marker=${marker}`
  )
  caseRecord.notes.push('正式 PM 项目当前无删除接口；本轮结束后结束专属项目角色并停用专属账号，项目与报告保留审计记录。')
  return fixture
}

export function registerWorkbenchDailyRoleCleanup ({ adminApi, registry, fixture }) {
  fixture.accountId = fixture.accountId || fixture.userId
  registry.add({
    type: 'pm-project-role',
    id: fixture.roleId,
    read: async () => data(await adminApi.getBusiness(
      `/pm/project-role/list?projectId=${fixture.projectId}`
    )).find((row) => id(row.id) === id(fixture.roleId)),
    matches: (row) => id(row?.projectId) === id(fixture.projectId) &&
      id(row?.userId) === id(fixture.accountId) &&
      row?.roleCode === 'REPORTER' && row?.status === 'ACTIVE',
    remove: async () => {
      await adminApi.putBusiness(`/pm/project-role/end?id=${fixture.roleId}`, undefined)
    },
    verifyRemoved: async () => {
      const row = data(await adminApi.getBusiness(
        `/pm/project-role/list?projectId=${fixture.projectId}`
      )).find((item) => id(item.id) === id(fixture.roleId))
      return row?.status === 'ENDED'
    }
  })
}

export async function createWorkbenchDailyReport ({
  adminApi, ownApi, account, fixture, marker, caseRecord, periodKey = todayText()
}) {
  account.state ||= {}
  const draftId = id(data(await ownApi.postBusiness('/pm/daily-report/save-draft', {
    reportType: 'DAILY',
    projectId: fixture.projectId,
    reporterId: account.userId,
    periodKey,
    contentJson: JSON.stringify({
      summary: `${marker} 日报已填写`,
      completedWork: `${marker} 完成日报写侧验证`,
      hours: 8
    }),
    taskStatusSuggestionJson: JSON.stringify([]),
    sourceSnapshotJson: JSON.stringify({ forged: true }),
    remark: `${marker} 日报提交`
  })))
  account.state.hasResidualReports = true
  account.state.hasRetainedReports = true
  caseRecord.businessIds = [...(caseRecord.businessIds || []), {
    type: 'pm-daily-report', id: draftId, projectId: fixture.projectId, marker,
    reason: '正式日报无删除接口，保留创建记录及后续提交/审核审计证据'
  }]
  caseRecord.fixtureResiduals = [...(caseRecord.fixtureResiduals || []), {
    type: 'pm-daily-report', id: draftId, projectId: fixture.projectId,
    reporterId: account.userId, marker,
    reason: '正式日报无删除接口；专属账号结束后停用'
  }]
  const draft = data(await ownApi.getBusiness(`/pm/daily-report/get?id=${draftId}`))
  assert.equal(id(draft?.projectId), id(fixture.projectId))
  assert.equal(id(draft?.reporterId), id(account.userId))
  assert.equal(draft?.status, 'DRAFT')
  assert.ok(typeof draft?.sourceSnapshotJson === 'string' &&
    !draft.sourceSnapshotJson.includes('forged') &&
    draft.sourceSnapshotJson.includes('generatedAt'))
  await ownApi.putBusiness(`/pm/daily-report/submit?id=${draftId}`, undefined)
  const submitted = data(await ownApi.getBusiness(`/pm/daily-report/get?id=${draftId}`))
  assert.equal(submitted?.status, 'SUBMITTED')
  const page = data(await adminApi.getBusiness(
    `/pm/daily-report/page?pageNo=1&pageSize=100&projectId=${fixture.projectId}` +
    `&reportType=DAILY&periodKey=${encodeURIComponent(periodKey)}`
  ))
  assert.ok(page.list.some((row) => id(row.id) === draftId &&
    id(row.reporterId) === id(account.userId) && row.status === 'SUBMITTED'))

  caseRecord.checks.push({
    name: '专属成员真实创建、提交日报并回读非空来源快照',
    passed: true,
    details: `projectId=${fixture.projectId}; reporterId=${account.userId}; reportId=${draftId}; status=SUBMITTED`
  })
  return { draftId, periodKey, submitted }
}

export async function approveWorkbenchDailyReport ({ adminApi, report, fixture, caseRecord }) {
  await adminApi.putBusiness(
    `/pm/daily-report/review?id=${report.draftId}&approved=true&remark=E2E日报审核通过`,
    undefined
  )
  const approved = data(await adminApi.getBusiness(`/pm/daily-report/get?id=${report.draftId}`))
  const passed = approved?.status === 'APPROVED' &&
    id(approved.projectId) === id(fixture.projectId) &&
    approved.locked === true
  caseRecord.checks.push({
    name: '项目经理审核日报并回读明细与锁定状态',
    passed,
    details: `reportId=${report.draftId}; status=${approved?.status}; locked=${approved?.locked}`
  })
  return approved
}

export async function inspectWorkbenchDailyGap ({ adminApi, ownApi, reference, userId }) {
  const projectId = id(reference.projectId)
  const handoverId = id(reference.handoverId)
  assert.match(reference.marker, /^E2E_PB113_001_PROJECT-[A-Z0-9]+$/)
  userId = id(userId)
  const project = data(await adminApi.get(`/pm/project/get?id=${projectId}`))
  const handover = data(await adminApi.get(`/pm/handover/get?id=${handoverId}`))
  assert.equal(id(project?.id), projectId)
  assert.equal(id(project?.handoverId), handoverId)
  assert.equal(id(handover?.projectId), projectId)
  assert.ok(project.projectName?.includes(reference.marker))
  assert.ok(handover.projectName?.includes(reference.marker))
  const roles = data(await adminApi.get(`/pm/project-role/list?projectId=${projectId}`))
  assert.ok(Array.isArray(roles))
  const isMember = roles.some((row) => String(row.userId) === userId && row.status === 'ACTIVE')
  assert.equal(isMember, false, 'The query-only counterexample must not be a PM member')
  const pages = {}
  for (const [tag, api, owner] of [
    ['adminDaily', adminApi, undefined],
    ['selfDaily', ownApi, userId],
    ['projectDaily', ownApi, undefined],
    ['projectWeekly', ownApi, undefined]
  ]) {
    const type = tag === 'projectWeekly' ? 'WEEKLY' : 'DAILY'
    const query = `/pm/daily-report/page?pageNo=1&pageSize=100&projectId=${projectId}&reportType=${type}` +
      (owner ? `&reporterId=${owner}` : '')
    const page = data(await api.get(query))
    assert.ok(Array.isArray(page?.list) && Number.isInteger(page.total) &&
      page.total >= page.list.length && page.list.length <= 100)
    assert.ok(page.list.every((row) => String(row.projectId) === projectId &&
      row.reportType === type && (!owner || String(row.reporterId) === owner)))
    pages[tag] = {
      query, total: page.total,
      rows: page.list.map((row) => ({
        id: id(row.id), reporterId: id(row.reporterId), status: row.status, periodKey: row.periodKey
      }))
    }
  }
  // This is an observation, not a selected policy or proof that team access is legitimate.
  return { reference, userId, isMember, roleIds: roles.map((row) => id(row.id)), pages,
    foreignReportsVisible: pages.projectWeekly.rows.filter((row) => row.reporterId !== userId),
    writePerformed: false }
}
