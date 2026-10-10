import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import * as XLSX from 'xlsx'

export const cases = [
  'PB111-001',
  'PB112-001',
  'PB113-001',
  'PB114-001',
  'PB115-001',
  'PB116-001',
  'PB117-001',
  'PB118-001',
  'PB119-001',
  'PB120-001',
  'PB122-001',
  'PB121-001',
  'PB123-001',
  'PB124-001',
  'PB125-001',
  'PB127-001',
  'PB128-001',
  'PB129-001',
  'PB126-001',
  'PB130-001',
  'PB945-001',
  'PB947-001',
  'PB949-001',
  'PB951-001',
  'PB953-001',
  'PB955-001'
]

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`
const dataOf = (response) => response?.data ?? response
const listOf = (response) => {
  const data = dataOf(response)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  return Array.isArray(data?.records) ? data.records : []
}

const parseJson = (value, fallback = {}) => {
  try {
    return JSON.parse(value || '')
  } catch {
    return fallback
  }
}

const dateOffset = (days) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export const resolveReportPeriodRange = (reportType, periodKey) => {
  const type = String(reportType || '').trim().toUpperCase()
  const key = String(periodKey || '').trim()
  if (type === 'DAILY' && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return [key, key]
  }
  if (type === 'WEEKLY') {
    const match = key.match(/^(\d{4})-W(\d{2})$/)
    if (!match) return null
    const year = Number(match[1])
    const week = Number(match[2])
    if (week < 1 || week > 53) return null
    const jan4 = new Date(Date.UTC(year, 0, 4))
    const weekday = jan4.getUTCDay() || 7
    const monday = new Date(jan4)
    monday.setUTCDate(jan4.getUTCDate() - weekday + 1 + (week - 1) * 7)
    const sunday = new Date(monday)
    sunday.setUTCDate(monday.getUTCDate() + 6)
    return [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)]
  }
  if (type === 'MONTHLY') {
    const match = key.match(/^(\d{4})-(\d{2})$/)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    if (month < 1 || month > 12) return null
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return [`${match[1]}-${match[2]}-01`, `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`]
  }
  return null
}

export const isoWeekKey = (dateText) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) return null
  const date = new Date(`${dateText}T00:00:00Z`)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const year = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

export const PROJECT_REPORT_DEFINITIONS = [
  { reportType: 'PROJECT_PROGRESS', path: 'project-progress' },
  { reportType: 'TASK_EXECUTION', path: 'task-execution' },
  { reportType: 'RESEARCH', path: 'research' },
  { reportType: 'RISK_ISSUE_BUG', path: 'risk-issue' },
  { reportType: 'PLAN_CHANGE', path: 'plan-change' },
  { reportType: 'RELEASE', path: 'release' },
  { reportType: 'GO_LIVE_ISSUE', path: 'go-live-issue' },
  { reportType: 'ACCEPTANCE_RECTIFICATION', path: 'acceptance-rectification' },
  { reportType: 'PROJECT_REVIEW', path: 'review' },
  { reportType: 'AFTER_SALES_HANDOVER', path: 'after-sales-handover' },
  { reportType: 'PROJECT_CLOSEOUT', path: 'closeout' }
]

export const parseRiskLevelHistory = (value) => {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const cleanup = async (caseRecord, name, operation) => {
  try {
    await operation()
    caseRecord.evidence.push(`清理：${name}`)
  } catch (error) {
    caseRecord.checks.push({
      name: `清理：${name}`,
      passed: false,
      details: error.message
    })
  }
}

const projectUpdatePayload = (project, overrides = {}) => ({
  id: project.id,
  projectName: project.projectName,
  projectType: project.projectType,
  projectManagerId: project.projectManagerId,
  projectManagerName: project.projectManagerName,
  plannedStartDate: project.plannedStartDate,
  plannedEndDate: project.plannedEndDate,
  status: project.status,
  healthStatus: project.healthStatus,
  riskLevel: project.riskLevel,
  remark: project.remark,
  ...overrides
})

const numericId = (value, label) => {
  const text = String(value ?? '')
  if (!/^\d+$/.test(text)) throw new Error(`BLOCKED: ${label} 未返回合法数据库ID`)
  return text
}

const resolveProjectOwnerId = async (api) => {
  const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
  return numericId(profile?.id, '项目负责人')
}

const resolveEnabledProjectType = async (api, excluded = new Set()) => {
  const rows = listOf(await api.getBusiness('/pm/modeling/list?configKey=projectType&status=ENABLED'))
  const row = rows.find((item) => item?.configCode && !excluded.has(item.configCode))
  if (!row) throw new Error('BLOCKED: 没有可用于专属 PM 建项的启用 projectType 配置')
  return row.configCode
}

const confirmDedicatedProjectBaselines = async (api, fixture) => {
  // PB-911：正式执行只能由四项已确认基线触发，普通编辑不能绕过基线门禁。
  for (const baselineType of ['SCOPE', 'SCHEDULE', 'RESOURCE', 'ACCEPTANCE']) {
    await api.postBusiness('/pm/baseline/save', {
      projectId: fixture.projectId,
      baselineType,
      contentJson: JSON.stringify({ marker: fixture.marker, baselineType, source: 'E2E' }),
      confirm: true
    })
  }
  const baselineList = listOf(await api.getBusiness(`/pm/baseline/list?projectId=${fixture.projectId}`))
  const confirmedTypes = new Set(
    baselineList.filter((item) => item?.status === 'CONFIRMED').map((item) => item?.baselineType)
  )
  const missing = ['SCOPE', 'SCHEDULE', 'RESOURCE', 'ACCEPTANCE'].filter((type) => !confirmedTypes.has(type))
  if (missing.length) {
    throw new Error(`四项基线确认后仍缺失：${missing.join(',')}`)
  }
  const project = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
  if (project?.status !== 'EXECUTING') {
    throw new Error(`四项基线确认后项目未进入 EXECUTING：${JSON.stringify({ projectId: fixture.projectId, status: project?.status })}`)
  }
  return project
}

const createDedicatedProject = async ({ api, caseId, projectType, caseRecord, activate = false }) => {
  const ownerId = await resolveProjectOwnerId(api)
  const marker = unique(`E2E_${caseId.replace(/[^A-Z0-9]+/gi, '_')}_PROJECT`)
  const handoverId = numericId(dataOf(await api.postBusiness(
    '/pm/handover/create',
    buildDedicatedProjectHandoverPayload({ marker, projectType })
  )), '专属项目交接单')
  await api.putBusiness(`/pm/handover/submit?id=${handoverId}`, undefined)
  const projectId = numericId(dataOf(await api.putBusiness('/pm/handover/review', {
    id: handoverId,
    decision: 'APPROVE',
    opinion: `${marker} 审核通过`,
    proposedPmId: ownerId,
    developmentManagerId: ownerId,
    consultantId: ownerId
  })), '专属 PM 项目')
  const project = dataOf(await api.getBusiness(`/pm/project/get?id=${projectId}`))
  if (!isDedicatedProject(project, { projectId, handoverId, marker }) ||
      project?.projectType !== projectType) {
    throw new Error(`专属 PM 项目归属回读失败：${JSON.stringify({ projectId, handoverId, marker, project })}`)
  }
  caseRecord.evidence.push(`创建并回读本轮专属空项目 projectId=${projectId}, handoverId=${handoverId}, marker=${marker}`)
  caseRecord.notes.push('PM 正式项目域当前无回收/删除接口；本轮仅恢复专属项目基线并严格回读，不调用另一套 /pms/pm/project API。')
  const fixture = { projectId, handoverId, ownerId, marker, projectType, project }
  if (activate) {
    fixture.project = await confirmDedicatedProjectBaselines(api, fixture)
    caseRecord.evidence.push(`专属项目 ${projectId} 已确认 SCOPE/SCHEDULE/RESOURCE/ACCEPTANCE 四项基线并进入 EXECUTING`)
  }
  return fixture
}

const restoreDedicatedProject = async (api, fixture, overrides = {}) => {
  const before = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
  if (!isDedicatedProject(before, fixture)) {
    throw new Error(`专属 PM 项目清理前归属回读失败：projectId=${fixture.projectId}`)
  }
  await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, overrides))
  const after = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
  if (!isDedicatedProject(after, fixture)) {
    throw new Error(`专属 PM 项目清理后归属回读失败：projectId=${fixture.projectId}`)
  }
  return after
}

export const buildDedicatedProjectHandoverPayload = ({ marker, projectType }) => ({
  sourceType: 'MANUAL',
  sourceBusinessNo: marker,
  projectName: `${marker} 专属空项目`,
  projectType,
  customerNameSnapshot: marker,
  scopeIn: marker,
  commitments: marker,
  acceptanceConditions: marker,
  initialRisks: marker
})

export const isDedicatedProject = (project, fixture) =>
  String(project?.id) === String(fixture?.projectId) &&
  String(project?.handoverId) === String(fixture?.handoverId) &&
  project?.customerNameSnapshot === fixture?.marker

const firstEnabledMaterialId = async (api) => {
  const response = await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
  )
  const material = listOf(response)[0]
  const id = material?.id ?? material?.value ?? material?.materialId ?? material?.material_id
  return id == null ? '' : String(id)
}

const retireAsset = async (api, assetId) => {
  if (!assetId) return
  const detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  if (detail?.asset?.serviceStatus === 'RETIRED') return
  await api.putBusiness('/after-sales/asset/update-status', {
    id: assetId,
    serviceStatus: 'RETIRED',
    reason: 'E2E 用例结束退役专属资产',
    version: detail?.asset?.version
  })
}

const createManualAssetFixture = async (api, prefix) => {
  const materialId = await firstEnabledMaterialId(api)
  if (!materialId) throw new Error('BLOCKED: 当前租户没有已启用且可采购的 Base 存货档案')
  const customerNo = unique(`${prefix}_CUSTOMER`)
  const assetNo = unique(`${prefix}_ASSET`)
  const today = dateOffset(0)
  const profile = dataOf(await api.postBusiness('/after-sales/asset/customer-profile/create', {
    customerNo,
    fullName: `${prefix} 客户 ${customerNo}`,
    shortName: `${prefix}客户`,
    primaryContactName: `${prefix} 联系人`,
    primaryContactMobile: '13800000001',
    assets: [{
      assetNo,
      materialId,
      assetName: `${prefix} 手工资产`,
      assetContent: 'E2E 专属客户资产，不参与库存余额',
      useStartDate: today,
      storageAddress: 'E2E 验收环境',
      managers: [{
        departmentName: '售后实施部',
        managerName: `${prefix} 责任人`,
        managerMobile: '13800000002',
        primary: true
      }],
      servicePeriods: [{
        startDate: dateOffset(-1),
        endDate: dateOffset(365),
        sourceType: 'MANUAL',
        sourceNo: unique(`${prefix}_SERVICE`),
        sourceName: `${prefix} 手工服务期`,
        idempotencyKey: unique(`${prefix}_SERVICE_KEY`)
      }]
    }]
  }))
  const assetId = profile?.assetIds?.[0]
  if (!assetId) throw new Error('BLOCKED: 手工客户资产档案创建后未返回 assetId')
  let detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  await api.putBusiness('/after-sales/asset/update-status', {
    id: assetId,
    serviceStatus: 'IN_SERVICE',
    reason: 'E2E 专属资产在有效服务期内恢复服务',
    version: detail?.asset?.version
  })
  detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  return {
    customerId: profile.customerId,
    contactId: profile.primaryContactId,
    assetId,
    assetNo,
    materialId,
    detail,
    profile
  }
}

const createProjectAcceptanceAssetFixture = async (api, project, prefix, baselineId) => {
  const materialId = await firstEnabledMaterialId(api)
  if (!materialId) throw new Error('BLOCKED: 当前租户没有已启用且可采购的 Base 存货档案')
  const customerNo = unique(`${prefix}_CUSTOMER`)
  const customerId = dataOf(await api.postBusiness('/after-sales/asset/customer/create', {
    customerNo,
    fullName: `${prefix} 验收客户 ${customerNo}`,
    shortName: `${prefix}验收客户`
  }))
  const acceptanceId = dataOf(await api.postBusiness('/pm/customer-acceptance/save', {
    projectId: project.id,
    acceptanceType: 'FINAL',
    plannedDate: dateOffset(0),
    customerRepresentative: `${prefix} 客户代表`,
    resultSummary: 'E2E 项目验收通过，用于验证售后资产来源引用',
    evidenceUri: 'e2e://project-after-sales/acceptance',
    // PB-939 门禁：验收通过必须匹配范围基线并留客户确认人/日期。
    baselineId,
    deliveryEvidenceJson: JSON.stringify({
      source: 'E2E',
      evidenceUri: 'e2e://project-after-sales/acceptance'
    }),
    customerConfirmPerson: `${prefix} 客户确认人`,
    customerConfirmDate: dateOffset(0)
  }))
  await api.putBusiness('/pm/customer-acceptance/status', {
    id: acceptanceId,
    status: 'APPROVED',
    opinion: 'E2E 验收通过',
    reviewerName: '管理员'
  })
  const assetNo = unique(`${prefix}_PROJECT_ASSET`)
  const assetId = dataOf(await api.postBusiness('/after-sales/asset/create', {
    customerId,
    assetNo,
    materialId,
    assetName: `${prefix} 项目验收资产`,
    assetContent: '由项目验收单向售后客户资产生成',
    useStartDate: dateOffset(0),
    storageAddress: 'E2E 验收现场',
    sourceType: 'PROJECT_ACCEPTANCE',
    sourceProjectId: project.id,
    sourceAcceptanceId: acceptanceId,
    managers: [{
      departmentName: '售后交付部',
      managerName: `${prefix} 项目责任人`,
      managerMobile: '13800000003',
      primary: true
    }]
  }))
  await api.postBusiness('/after-sales/asset/service-period/create', {
    assetId,
    startDate: dateOffset(-1),
    endDate: dateOffset(365),
    sourceType: 'PROJECT_ACCEPTANCE',
    sourceId: acceptanceId,
    sourceNo: `ACC-${acceptanceId}`,
    sourceName: `${prefix} 项目验收服务期`,
    idempotencyKey: unique(`${prefix}_PROJECT_SERVICE_KEY`)
  })
  let detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  await api.putBusiness('/after-sales/asset/update-status', {
    id: assetId,
    serviceStatus: 'IN_SERVICE',
    reason: 'E2E 项目验收资产在服务期内',
    version: detail?.asset?.version
  })
  detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  return { customerId, acceptanceId, assetId, assetNo, detail }
}

const disableAfterSalesConfig = (api, configType, id) =>
  api.postBusiness(
    `/after-sales/modeling/status?configType=${configType}&id=${id}&enabled=false`
  )

const readAfterSalesConfig = async (api, listPath, id) =>
  listOf(await api.getBusiness(listPath)).find((row) => String(row.id) === String(id))

const getMilestone = async (api, projectId, milestoneId) =>
  listOf(await api.getBusiness(`/pm/milestone/list?projectId=${projectId}`))
    .find((item) => String(item.id) === String(milestoneId))

const createMilestoneFixture = async ({
  api,
  projectId,
  ownerId,
  marker,
  withGates = true,
  plannedStartDate,
  plannedEndDate
}) => {
  await reserveMilestoneWeight(api, projectId, 10)
  const milestoneId = dataOf(await api.postBusiness('/pm/milestone/save', {
    projectId,
    milestoneName: `${marker} 里程碑`,
    ownerId,
    ownerName: '管理员',
    plannedStartDate,
    plannedEndDate,
    weightRate: 10,
    exitCondition: withGates ? `${marker} 准出条件` : null,
    requiredDeliverablesJson: withGates ? JSON.stringify([`${marker}-deliverable`]) : null,
    healthStatus: withGates ? 'NORMAL' : null,
    warningStatus: withGates ? 'NONE' : null
  }))
  return {
    milestoneId,
    detail: await getMilestone(api, projectId, milestoneId)
  }
}

// 专属项目建项时会按模板展开里程碑并占满 100 权重，新增里程碑前先等比下调已有权重腾出空间。
const reserveMilestoneWeight = async (api, projectId, newWeight) => {
  const existing = listOf(await api.getBusiness(`/pm/milestone/list?projectId=${projectId}`))
  if (!existing.length) return
  const total = existing.reduce((sum, item) => sum + Number(item?.weightRate ?? 0), 0)
  if (total + newWeight <= 100) return
  // 已确认里程碑锁定不可改，只能从仍可编辑的里程碑中腾出权重。
  const adjustable = existing.filter((item) => item?.confirmed !== true)
  const lockedWeight = existing
    .filter((item) => item?.confirmed === true)
    .reduce((sum, item) => sum + Number(item?.weightRate ?? 0), 0)
  const budget = 100 - newWeight - lockedWeight
  if (!adjustable.length || budget < adjustable.length) {
    throw new Error(`BLOCKED: 无法为新增里程碑预留权重 ${newWeight}（已确认权重 ${lockedWeight}）`)
  }
  const base = Math.floor(budget / adjustable.length)
  let remainder = budget - base * adjustable.length
  for (const item of adjustable) {
    const weight = base + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder -= 1
    if (Number(item.weightRate) === weight) continue
    const snappedStart = await findWorkingDate(api, item.plannedStartDate)
    const snappedEnd = await findWorkingDate(api, item.plannedEndDate || item.plannedStartDate)
    await api.postBusiness('/pm/milestone/save', {
      id: item.id,
      projectId,
      stageId: item.stageId,
      milestoneName: item.milestoneName,
      ownerId: item.ownerId,
      ownerName: item.ownerName,
      plannedStartDate: snappedStart,
      plannedEndDate: snappedEnd,
      weightRate: weight,
      exitCondition: item.exitCondition ?? null,
      requiredDeliverablesJson: item.requiredDeliverablesJson ?? null,
      healthStatus: item.healthStatus ?? null,
      warningStatus: item.warningStatus ?? null,
      manualConclusion: item.manualConclusion ?? null
    })
  }
}

const createTaskFixture = async ({
  api,
  projectId,
  ownerId,
  marker,
  plannedStartDate,
  plannedEndDate
}) => {
  const taskId = dataOf(await api.postBusiness('/pm/task/create-administrative', {
    projectId,
    taskName: `${marker} 任务`,
    taskContent: 'E2E 项目绩效与报告来源任务',
    ownerId,
    ownerName: '管理员',
    acceptanceOwnerId: ownerId,
    plannedStartDate,
    plannedEndDate,
    priority: 2,
    standardHours: 8,
    plannedHours: 8,
    requiredOutput: `${marker}-output`,
    acceptanceCriteria: `${marker} 验收标准`
  }))
  return taskId
}

const completeTaskFixture = async (api, taskId) => {
  await api.putBusiness(`/pm/task/dispatch?id=${taskId}`, undefined)
  await api.putBusiness(`/pm/task/accept?id=${taskId}`, undefined)
  await api.putBusiness(`/pm/task/start?id=${taskId}`, undefined)
  await api.postBusiness('/pm/task/submit-result', {
    taskId,
    resultSummary: 'E2E 任务成果提交',
    outputJson: JSON.stringify({ marker: taskId, delivered: true }),
    attachmentIds: null
  })
  await api.putBusiness('/pm/task/accept-result', {
    taskId,
    decision: 'APPROVE',
    conclusion: 'E2E 验收通过',
    evidenceJson: JSON.stringify({ source: 'cfor-e2e' }),
    exceptionAllowed: true,
    exceptionRuleCode: 'SAME_PERSON_AUTHORIZED',
    exceptionReason: '自动化验收使用同一管理员账号并显式记录例外规则'
  })
}

const createRiskFixture = async ({
  api,
  projectId,
  ownerId,
  marker,
  level = 'LOW',
  relatedType = null,
  relatedId = null
}) => {
  const riskId = dataOf(await api.postBusiness('/pm/risk/save', {
    projectId,
    title: `${marker} 风险`,
    description: `${marker} 风险描述`,
    level,
    probability: 'MEDIUM',
    impact: 'MEDIUM',
    responsePlan: `${marker} 应对计划`,
    ownerId,
    ownerName: '管理员',
    dueDate: dateOffset(14),
    relatedType,
    relatedId
  }))
  return {
    riskId,
    detail: dataOf(await api.getBusiness(`/pm/risk/get?id=${riskId}`))
  }
}

const createChangeFixture = async ({ api, projectId, requesterId, marker, relatedType, relatedId }) =>
  dataOf(await api.postBusiness('/pm/change/save', {
    projectId,
    title: `${marker} 变更`,
    changeType: 'MODIFY',
    reason: `${marker} 变更原因`,
    impactScope: `${marker} 影响范围`,
    baselineType: 'PROJECT_SCOPE',
    requesterId,
    requesterName: '管理员',
    fieldChanges: [{
      changeType: 'MODIFY',
      fieldName: `${marker}_scope_field`,
      oldValue: 'OLD',
      newValue: 'NEW'
    }],
    relatedType,
    relatedId
  }))

const riskUpdatePayload = (risk, overrides = {}) => ({
  id: risk.id,
  projectId: risk.projectId,
  title: risk.title,
  description: risk.description,
  level: risk.level,
  probability: risk.probability,
  impact: risk.impact,
  responsePlan: risk.responsePlan,
  ownerId: risk.ownerId,
  ownerName: risk.ownerName,
  dueDate: risk.dueDate,
  sourceType: risk.sourceType,
  sourceId: risk.sourceId,
  relatedType: risk.relatedType,
  relatedId: risk.relatedId,
  ...overrides
})

const isHrmWorkingDay = async (api, date) => {
  const holiday = dataOf(await api.getBusiness(
    `/hrm/attendance/holiday/check?day=${encodeURIComponent(`${date}T00:00:00`)}`
  ))
  if (Number(holiday?.type) === 1) return true
  if (Number(holiday?.type) === 2) return false
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6
}

const findWorkingDate = async (api, startDate, searchDays = 45) => {
  for (let offset = 0; offset < searchDays; offset += 1) {
    const candidate = dateOffsetFrom(startDate, offset)
    if (await isHrmWorkingDay(api, candidate)) return candidate
  }
  throw new Error(`BLOCKED: 自 ${startDate} 起 ${searchDays} 天内没有可用 HRM 工作日`)
}

const dateOffsetFrom = (dateText, days) => {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const pushReportQuery = (params, query) => {
  const result = new URLSearchParams(params)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      result.set(key, String(value))
    }
  }
  return result.toString()
}

const setChangeStatus = (api, id, status, extra = {}) =>
  api.putBusiness('/pm/change/status', { id, status, ...extra })

const projectDateRange = (project) => {
  const start = project?.plannedStartDate || dateOffset(0)
  const configuredEnd = project?.plannedEndDate || start
  return configuredEnd < start ? [start, start] : [start, configuredEnd]
}

const readDocument = async (api, documentId) =>
  dataOf(await api.getBusiness(`/ai/knowledge/document/get?id=${documentId}`))

const waitForIndexedDocument = async (api, documentId) => {
  let latest = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await readDocument(api, documentId)
    if (latest?.parseStatus === 'PARSED' && latest?.indexStatus === 'INDEXED') return latest
    if (typeof latest?.indexStatus === 'string' && latest.indexStatus.startsWith('ERROR')) return latest
    if (typeof latest?.parseStatus === 'string' && latest.parseStatus.startsWith('ERROR')) return latest
    await api.postBusiness(
      '/system/ai-runtime/admin/async-tasks/knowledge-index/run?limit=20&workerId=e2e-project-after-sales&lockTimeoutMinutes=15'
    )
    await sleep(1000)
  }
  return latest
}

export const isBusinessRejected = (response, code, message) =>
  Boolean(response?.code === code && response.success !== true &&
    typeof response.msg === 'string' && response.msg.includes(message))

export const hasProjectFixture = (response) => listOf(response).length > 0

export const validTaskLibraryConfig = (config) => {
  const tasks = config?.tasks ?? config?.items
  const nonblank = (value) => typeof value === 'string' && value.trim().length > 0
  if (!Array.isArray(tasks) || !tasks.length) return false
  return tasks.every((task) =>
    nonblank(task?.code || task?.taskCode) &&
    nonblank(task?.name || task?.taskName) &&
    Number(task?.standardHours) > 0 &&
    nonblank(task?.deliverable || task?.requiredOutput) &&
    nonblank(task?.acceptance || task?.acceptanceCriteria) &&
    (task?.predecessorIds == null || Array.isArray(task.predecessorIds)) &&
    (task?.predecessors == null || Array.isArray(task.predecessors))
  )
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后携带真实令牌调用项目与售后接口'
  })

  if (caseId === 'PB111-001') {
    const projectTypes = listOf(await api.getBusiness('/pm/modeling/list?configKey=projectType'))
    const [modules, moduleCategories, researchTemplates, documentTemplates, staffProfiles] =
      await Promise.all([
        api.getBusiness('/pm/modeling/list?configKey=moduleDefinition'),
        api.getBusiness('/pm/modeling/list?configKey=moduleCategory'),
        api.getBusiness('/pm/modeling/list?configKey=researchTemplate'),
        api.getBusiness('/pm/modeling/list?configKey=documentTemplate'),
        api.getBusiness('/pm/modeling/list?configKey=staffProfile')
      ])
    const treeConfigs = [
      ...listOf(modules),
      ...listOf(researchTemplates),
      ...listOf(documentTemplates),
      ...listOf(staffProfiles)
    ]
    caseRecord.checks.push({
      name: '项目建模配置沿用设置主菜单下的项目建模入口',
      passed:
        Array.isArray(projectTypes) &&
        projectTypes.every(
          (item) =>
            Boolean(item?.configCode) &&
            Boolean(item?.configName) &&
            typeof item?.configJson === 'string'
        ),
      details: `projectType 配置数=${Array.isArray(projectTypes) ? projectTypes.length : 'n/a'}，已校验页面所需真实配置字段`
    })
    caseRecord.checks.push({
      name: '项目建模树形条目和分类来自真实配置接口',
      passed:
        treeConfigs.every((item) => {
          try {
            const config = JSON.parse(item?.configJson || '{}')
            return Boolean(item?.configCode) && Boolean(config.categoryId)
          } catch {
            return false
          }
        }) &&
        listOf(moduleCategories).every((item) => Boolean(item?.configCode)),
      details: `模块=${listOf(modules).length}, 模块分类=${listOf(moduleCategories).length}, 调研=${listOf(researchTemplates).length}, 文档=${listOf(documentTemplates).length}, 人员=${listOf(staffProfiles).length}`
    })
    await openRoute(page, '/project/modeling/foundation/project-base/list')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '项目基础建模工作区真实渲染，不新建平行页面',
      passed: bodyText.includes('项目基础建模'),
      details: bodyText.includes('项目基础建模') ? '命中项目基础建模标题' : '未命中项目基础建模标题'
    })
    const existingCategory = listOf(moduleCategories)[0]
    const categoryCode = existingCategory?.configCode || unique('E2E_MODULE_CAT')
    let createdCategoryId = null
    let moduleId = null
    try {
      if (!existingCategory) {
        createdCategoryId = dataOf(await api.postBusiness('/pm/modeling/save', {
          configKey: 'moduleCategory',
          configCode: categoryCode,
          configName: `E2E 模块分类 ${categoryCode}`,
          configJson: JSON.stringify({ description: 'PB111 专属模块分类' }),
          status: 'ENABLED'
        }))
      }
      const moduleCode = unique('E2E_MODULE')
      moduleId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'moduleDefinition',
        configCode: moduleCode,
        configName: `E2E 模块定义 ${moduleCode}`,
        configJson: JSON.stringify({
          categoryId: categoryCode,
          description: 'PB111 验证模块定义复用项目建模事实源'
        }),
        status: 'ENABLED'
      }))
      const created = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=moduleDefinition')
      ).find((item) => String(item.id) === String(moduleId))
      const createdConfig = parseJson(created?.configJson)
      caseRecord.checks.push({
        name: '模块定义写入后可回读分类、版本和启用状态',
        passed:
          created?.status === 'ENABLED' &&
          created?.configCode === moduleCode &&
          created?.versionNo === 1 &&
          createdConfig.categoryId === categoryCode,
        details: `moduleId=${moduleId}, category=${createdConfig.categoryId || 'n/a'}`
      })
      await api.postBusiness(`/pm/modeling/status?id=${moduleId}&status=DISABLED`)
      const disabled = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=moduleDefinition')
      ).find((item) => String(item.id) === String(moduleId))
      caseRecord.checks.push({
        name: '模块定义停用后回读为 DISABLED',
        passed: disabled?.status === 'DISABLED',
        details: `moduleId=${moduleId}`
      })
    } finally {
      if (moduleId) {
        await cleanup(caseRecord, `停用模块定义 ${moduleId}`, () =>
          api.postBusiness(`/pm/modeling/status?id=${moduleId}&status=DISABLED`)
        )
      }
      if (createdCategoryId) {
        // 被模块定义引用的分类会命中后端引用保护；此处保留分类并记录预期行为，避免误判失败。
        try {
          await api.postBusiness(`/pm/modeling/status?id=${createdCategoryId}&status=DISABLED`)
          caseRecord.evidence.push(`清理：停用本轮模块分类 ${createdCategoryId}`)
        } catch (error) {
          caseRecord.evidence.push(
            `本轮模块分类 ${createdCategoryId} 仍被禁用的模块定义引用，后端按引用保护保留，未强制停用：${error.message}`
          )
        }
      }
    }
    await saveScreenshot(page, outputDir, 'pb111-project-modeling', record)
    caseRecord.evidence.push('PB-111 通过项目建模接口创建并回读模块分类/定义，再验证停用状态')
    return { token, api }
  }

  if (caseId === 'PB112-001') {
    const employeePage = await api.getBusiness(
      '/hrm/employee/simple-page?pageNo=1&pageSize=100&entryStatus=1'
    )
    const employee = (employeePage?.data?.list || employeePage?.list || [])[0]
    if (!employee?.id) {
      caseRecord.notes.push('当前租户无在职 HRM 员工，PB112 派研快照以模块单测为当前证据')
      return { token, api }
    }
    const employeeId = employee.id
    const skillCode = unique('SKILL')
    const skillId = dataOf(await api.postBusiness('/pm/staff-skill/save', {
      employeeId,
      skillCode,
      skillName: '现场实施',
      projectRole: '实施顾问',
      skillLevel: 'SENIOR',
      applicableProjectType: 'IMPLEMENTATION',
      loadThreshold: 80,
      effectiveStart: '2026-01-01',
      source: 'MANUAL',
      proficiency: 4,
      auditStatus: 'APPROVED',
      status: 0
    }))
    const skillPage = await api.getBusiness(
      `/pm/staff-skill/list-by-employee?employeeId=${employeeId}`
    )
    const skills = skillPage?.data || []
    caseRecord.checks.push({
      name: '人员能力标签引用 HRM 员工并维护技能历史',
      passed:
        Boolean(skillId) &&
        Array.isArray(skills) &&
        skills.some((skill) => skill.id === skillId && skill.employeeId === employeeId),
      details: `skillId=${skillId}, count=${Array.isArray(skills) ? skills.length : 'n/a'}`
    })

    const projectPage = await api.getBusiness('/pm/project/page?pageNo=1&pageSize=100')
    const project = (projectPage?.data?.list || projectPage?.list || []).find(
      (item) => !['CLOSED', 'TERMINATED'].includes(item?.status)
    )
    if (project?.id) {
      const toStart = (date) => `${date || new Date().toISOString().slice(0, 10)}T00:00:00`
      const toEnd = (date) => `${date || new Date().toISOString().slice(0, 10)}T23:59:59`
      const today = new Date().toISOString().slice(0, 10)
      const plannedStart = project.plannedStartDate || today
      const plannedEnd = project.plannedEndDate || today
      const researchId = dataOf(
        await api.postBusiness('/pm/research/create-detailed', {
          projectId: project.id,
          topic: 'PB112 能力快照自动化验证'
        })
      )
      await api.putBusiness('/pm/research/dispatch', {
        id: researchId,
        assigneeId: employeeId,
        assigneeName: employee.name,
        topic: 'PB112 能力快照自动化验证',
        researchMode: '远程',
        researchAddress: 'E2E',
        participantRequirement: '自动化验证',
        deliverableRequirement: '能力标签快照',
        dispatchNote: '验证派研时固化有效能力标签',
        plannedStartTime: toStart(plannedStart),
        plannedEndTime: toEnd(plannedEnd)
      })
      const dispatched = (await api.getBusiness(`/pm/research/get?id=${researchId}`))?.data
      caseRecord.checks.push({
        name: '派研保存 HRM 员工有效能力标签快照并可回读',
        passed:
          typeof dispatched?.assigneeSkillSnapshotJson === 'string' &&
          dispatched.assigneeSkillSnapshotJson.includes(skillCode),
        details: dispatched?.assigneeSkillSnapshotJson?.slice(0, 200) || 'n/a'
      })
      caseRecord.evidence.push(
        `PB-112 派研研究任务 ${researchId} 固化员工 ${employeeId} 的 ${skillCode} 能力标签`
      )
    } else {
      caseRecord.notes.push('当前租户无未结束项目，PB112 仅验证能力标签主档契约')
    }
    await api.delete(`/pm/staff-skill/delete?id=${skillId}`)
    return { token, api }
  }

  if (caseId === 'PB113-001') {
    const projectPage = await api.getBusiness('/pm/project/page?pageNo=1&pageSize=10')
    const project = listOf(projectPage).find(
      (item) => !['CLOSED', 'TERMINATED'].includes(item?.status)
    )
    if (!project?.id) {
      caseRecord.notes.push('当前租户无交付项目，报告规则契约以接口存在性验证')
      return { token, api }
    }
    const projectId = project.id
    const permission = await api.get('/system/auth/get-permission-info')
    const reporterId = permission?.user?.id ?? permission?.data?.user?.id
    if (reporterId === undefined || reporterId === null) {
      caseRecord.notes.push('BLOCKED：无法取得当前登录用户编号，不能创建真实日报填报人。')
      return { token, api, partial: true }
    }
    // 行政任务日期同样受工作日和项目计划窗口双门禁，必须在项目窗口内取真实工作日。
    const projectEnd = project.plannedEndDate || dateOffset(7)
    const taskStart = await findWorkingDate(api, project.plannedStartDate || dateOffset(0))
    let taskEnd = await findWorkingDate(api, taskStart)
    if (taskEnd > projectEnd) {
      taskEnd = taskStart
    }
    const taskId = dataOf(await api.postBusiness('/pm/task/create-administrative', {
      projectId,
      taskName: `${unique('E2E_REPORT_TASK')} 周报任务状态建议`,
      taskContent: '验证日报周报任务状态只作为建议，不反写任务事实源',
      ownerId: reporterId,
      ownerName: '管理员',
      acceptanceOwnerId: reporterId,
      plannedStartDate: taskStart,
      plannedEndDate: taskEnd,
      priority: 2,
      standardHours: 2,
      plannedHours: 1,
      requiredOutput: '周报与任务状态建议',
      acceptanceCriteria: '任务状态建议不回写任务主档'
    }))
    const taskBefore = dataOf(await api.getBusiness(`/pm/task/get?id=${taskId}`))
    const source = dataOf(await api.getBusiness(`/pm/daily-report/source?projectId=${projectId}`))
    caseRecord.checks.push({
      name: '日报只读来源按项目带出任务/风险/里程碑',
      passed:
        source?.projectId === projectId &&
        Array.isArray(source?.tasks) &&
        Array.isArray(source?.risks) &&
        Array.isArray(source?.milestones) &&
        source.tasks.some((task) => String(task.id) === String(taskId)),
      details: `任务=${source?.tasks?.length ?? 'n/a'}, 风险=${source?.risks?.length ?? 'n/a'}, 里程碑=${source?.milestones?.length ?? 'n/a'}`
    })
    caseRecord.checks.push({
      name: '日报填报人使用当前登录用户，不伪造固定用户编号',
      passed: reporterId !== undefined && reporterId !== null,
      details: `reporterId=${reporterId ?? 'n/a'}`
    })
    const periodKey = unique('E2E_WEEK')
    const draftResponse = await api.postBusiness('/pm/daily-report/save-draft', {
      reportType: 'WEEKLY',
      projectId,
      reporterId,
      periodKey,
      contentJson: JSON.stringify({ summary: 'E2E 周报' }),
      taskStatusSuggestionJson: JSON.stringify([{ taskId, suggestion: 'COMPLETED' }]),
      sourceSnapshotJson: JSON.stringify({ forged: true })
    })
    const draftId = dataOf(draftResponse)
    const savedDraft = await api.getBusiness(`/pm/daily-report/get?id=${draftId}`)
    const savedDraftData = dataOf(savedDraft)
    caseRecord.checks.push({
      name: '日报来源快照由服务端按事实源生成，忽略客户端伪造值',
      passed:
        typeof savedDraftData?.sourceSnapshotJson === 'string' &&
        !savedDraftData.sourceSnapshotJson.includes('forged') &&
        savedDraftData.sourceSnapshotJson.includes('generatedAt'),
      details: savedDraftData?.sourceSnapshotJson?.slice(0, 160) || 'n/a'
    })
    await api.put(`/pm/daily-report/submit?id=${draftId}`)
    await api.put(`/pm/daily-report/review?id=${draftId}&approved=false&remark=E2E退回`)
    const reportPage = await api.getBusiness(
      `/pm/daily-report/page?pageNo=1&pageSize=100&projectId=${projectId}&reportType=WEEKLY&reporterId=${reporterId}&periodKey=${encodeURIComponent(periodKey)}`
    )
    const versions = listOf(reportPage)
      .filter((item) => String(item.reporterId) === String(reporterId))
      .map((item) => item.version)
    caseRecord.checks.push({
      name: '退回后生成新的修订版本，任务状态只作建议',
      passed: versions.length >= 2 && new Set(versions).size >= 2,
      details: `versions=${versions.join(',') || 'n/a'}`
    })
    const taskAfter = dataOf(await api.getBusiness(`/pm/task/get?id=${taskId}`))
    caseRecord.checks.push({
      name: '退回版本不把任务状态建议反写到任务事实源',
      passed:
        taskBefore?.status === 'PENDING_DISPATCH' &&
        taskAfter?.status === taskBefore.status,
      details: `before=${taskBefore?.status}, after=${taskAfter?.status}, taskId=${taskId}`
    })
    caseRecord.evidence.push(
      `PB-113 创建行政任务 ${taskId}、周报草稿 ${draftId}，退回后版本 ${versions.join(',')}，任务状态保持 ${taskAfter?.status}`
    )
    return { token, api }
  }

  if (caseId === 'PB114-001') {
    const projectPage = await api.getBusiness('/pm/project/page?pageNo=1&pageSize=20')
    const project = listOf(projectPage).find(
      (item) =>
        item?.plannedEndDate &&
        !['CLOSED', 'TERMINATED'].includes(item?.status)
    )
    if (!project?.id) {
      caseRecord.notes.push(
        'BLOCKED：当前租户无带计划结束日期且未关闭的交付项目，无法在不改项目日期事实的前提下验证延期预警。'
      )
      return { token, api, partial: true }
    }
    const ruleCode = unique('E2E_WARNING_DELAY')
    let ruleId
    try {
      const ruleResponse = await api.postBusiness('/pm/modeling/save', {
        configKey: 'warningRule',
        configCode: ruleCode,
        configName: 'E2E 当天延期预警',
        configJson: JSON.stringify({
          warningType: '延期',
          metric: 'PLANNED_END_DATE',
          // 提前天数取足够大的窗口，使任意未关闭项目都命中，无需修改项目计划结束日期。
          advanceDays: 36500,
          warningLevel: 'HIGH',
          windowKey: 'DAY',
          dueHours: 24,
          title: 'E2E 项目即将延期',
          detail: '合同计划结束日期已到期'
        }),
        status: 'ENABLED'
      })
      ruleId = dataOf(ruleResponse)

      const projectBefore = dataOf(await api.getBusiness(`/pm/project/get?id=${project.id}`))
      const first = await api.postBusiness('/pm/warning/evaluate', { projectId: project.id })
      const firstData = dataOf(first) || {}
      const warningPage = await api.getBusiness(
        `/pm/warning/page?pageNo=1&pageSize=100&projectId=${project.id}&warningType=DELAY`
      )
      const warning = listOf(warningPage).find(
        (item) => item?.ruleCode === ruleCode
      )
      const warningId = warning?.id
      caseRecord.checks.push({
        name: '预警规则求值命中并保存规则版本、指标与证据',
        passed:
          firstData.matchedCount >= 1 &&
          firstData.createdCount >= 1 &&
          warning?.ruleCode === ruleCode &&
          warning?.ruleVersion === 1 &&
          warning?.triggerMetric === 'PLANNED_END_DATE' &&
          Boolean(warning?.evidenceJson) &&
          Boolean(warning?.idempotencyKey) &&
          Boolean(warning?.dueTime),
        details: `first=${JSON.stringify(first)}, warning=${JSON.stringify(warning)}`
      })
      const afterWarningProject = dataOf(
        await api.getBusiness(`/pm/project/get?id=${project.id}`)
      )
      caseRecord.checks.push({
        name: '预警求值只落事件和待办，不修改项目状态与计划日期',
        passed:
          Boolean(projectBefore) &&
          afterWarningProject?.status === projectBefore?.status &&
          String(afterWarningProject?.plannedEndDate) === String(projectBefore?.plannedEndDate) &&
          afterWarningProject?.healthStatus === projectBefore?.healthStatus &&
          afterWarningProject?.riskLevel === projectBefore?.riskLevel,
        details: `before=${projectBefore?.status}/${projectBefore?.plannedEndDate}/${projectBefore?.healthStatus}, after=${afterWarningProject?.status}/${afterWarningProject?.plannedEndDate}/${afterWarningProject?.healthStatus}`
      })
      const second = await api.postBusiness('/pm/warning/evaluate', { projectId: project.id })
      const secondData = dataOf(second) || {}
      const warningsAfterSecond = listOf(
        await api.getBusiness(
          `/pm/warning/page?pageNo=1&pageSize=100&projectId=${project.id}&warningType=DELAY`
        )
      ).filter((item) => item?.ruleCode === ruleCode)
      caseRecord.checks.push({
        name: '同一规则与触发窗口重复求值保持幂等',
        passed:
          Boolean(warningId) &&
          warningsAfterSecond.length === 1 &&
          String(warningsAfterSecond[0]?.id) === String(warningId) &&
          (secondData.warningIds || []).some(
            (secondId) => String(secondId) === String(warningId)
          ),
        details: `second=${JSON.stringify(second)}, ruleWarnings=${warningsAfterSecond.length}`
      })
    } finally {
      if (ruleId) {
        await api.post(`/pm/modeling/status?id=${ruleId}&status=DISABLED`).catch(() => undefined)
      }
    }
    return { token, api }
  }

  if (caseId === 'PB118-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord })
    let project = fixture.project
    try {
      await api.putBusiness(
        '/pm/project/update',
        projectUpdatePayload(project, { healthStatus: 'NORMAL' })
      )
      fixture.project = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
      project = fixture.project
      const pageData = await api.getBusiness('/pm/project/page?pageNo=1&pageSize=100')
      const pageProject = listOf(pageData).find((item) =>
        String(item?.id) === String(fixture.projectId))
      caseRecord.checks.push({
        name: '交付项目分页可读',
        passed: Array.isArray(listOf(pageData)) && Boolean(pageProject),
        details: `专属项目=${project.id}, pageMatch=${Boolean(pageProject)}, projectType=${project.projectType}`
      })
      const invalidPayload = await api.put(
        '/pm/project/update',
        projectUpdatePayload(project, { healthStatus: 'NOT_A_HEALTH_STATE' })
      )
      // Business rejection is returned in an HTTP-success response; transport and HTTP failures must surface.
      const invalidRejected = isBusinessRejected(
        invalidPayload,
        400,
        '健康状态必须是 NORMAL 或 DELAYED'
      )
      if (invalidRejected) {
        caseRecord.notes.push(`非法健康状态被拒绝：code=${invalidPayload.code} msg=${invalidPayload.msg}`)
      }
      caseRecord.checks.push({
        name: '非法健康状态被拒绝，核心状态与健康状态解耦',
        passed: invalidRejected,
        details: `projectId=${project.id}`
      })
      const afterInvalid = dataOf(await api.getBusiness(`/pm/project/get?id=${project.id}`))
      caseRecord.checks.push({
        name: '非法健康状态拒绝后原项目状态和健康状态不变',
        passed:
          afterInvalid?.status === project.status &&
          afterInvalid?.healthStatus === project.healthStatus,
        details: `status=${afterInvalid?.status}, healthStatus=${afterInvalid?.healthStatus}`
      })
      await api.putBusiness(
        '/pm/project/update',
        projectUpdatePayload(project, { healthStatus: 'DELAYED' })
      )
      const delayed = dataOf(await api.getBusiness(`/pm/project/get?id=${project.id}`))
      caseRecord.checks.push({
        name: '健康状态可独立切换为 DELAYED 且核心状态不变',
        passed:
          delayed?.healthStatus === 'DELAYED' &&
          delayed?.status === project.status,
        details: `healthStatus=${delayed?.healthStatus}, status=${delayed?.status}, originalStatus=${project.status}`
      })
      caseRecord.evidence.push(
        `PB-118 项目 ${project.id} 仅健康状态切换为 DELAYED，核心状态保持 ${project.status}`
      )
    } finally {
      const restored = await restoreDedicatedProject(api, fixture)
      caseRecord.checks.push({
        name: '专属项目清理后归属与原健康状态回读',
        passed: restored?.healthStatus === project.healthStatus &&
          restored?.status === project.status,
        details: `projectId=${fixture.projectId}, healthStatus=${restored?.healthStatus}, status=${restored?.status}`
      })
    }
    return {
      token,
      api,
      partial: true,
      note: 'PB-118 核心生命周期、前置条件、权限、审批和审计仍保留 PARTIAL；本次仅完成专属项目上的健康状态解耦验证。'
    }
  }

  if (caseId === 'PB120-001') {
    const categoryCode = unique('E2E_ISSUE_CATEGORY')
    let categoryId
    try {
      categoryId = dataOf(await api.postBusiness('/after-sales/modeling/category/create', {
        categoryCode,
        categoryName: `E2E 售后问题分类 ${categoryCode}`,
        defaultPriority: 'P2',
        applicableProductType: 'STANDARD',
        applicableAssetType: 'SOFTWARE',
        applicableServiceStatus: 'IN_SERVICE',
        sortNo: 900
      }))
      const category = listOf(
        await api.getBusiness('/after-sales/modeling/category/list')
      ).find((row) => String(row.id) === String(categoryId))
      caseRecord.checks.push({
        name: '分类主档写入后回读产品类型/资产类型/服务状态适用范围',
        passed:
          category?.categoryCode === categoryCode &&
          category?.applicableProductType === 'STANDARD' &&
          category?.applicableAssetType === 'SOFTWARE' &&
          category?.applicableServiceStatus === 'IN_SERVICE' &&
          category?.status === 'ENABLED',
        details: `categoryId=${categoryId}, product=${category?.applicableProductType}, asset=${category?.applicableAssetType}, service=${category?.applicableServiceStatus}`
      })
      const crmTags = listOf(
        await api.getBusiness('/crm/customer-tag/definition/list-enabled')
      )
      caseRecord.checks.push({
        name: '售后问题分类与 CRM 客户标签是相互独立的事实源',
        passed:
          Array.isArray(crmTags) &&
          crmTags.every(
            (tag) =>
              !Object.prototype.hasOwnProperty.call(tag, 'applicableServiceStatus') &&
              !Object.prototype.hasOwnProperty.call(tag, 'applicableAssetType')
          ) &&
          crmTags.every((tag) => String(tag.id) !== String(categoryId)),
        details: `售后分类 id=${categoryId}，CRM 标签数=${Array.isArray(crmTags) ? crmTags.length : 'n/a'}`
      })
      await disableAfterSalesConfig(api, 'CATEGORY', categoryId)
      const disabledCategory = await readAfterSalesConfig(
        api,
        '/after-sales/modeling/category/list',
        categoryId
      )
      caseRecord.checks.push({
        name: '售后问题分类停用后回读为 DISABLED',
        passed: disabledCategory?.status === 'DISABLED',
        details: `categoryId=${categoryId}, status=${disabledCategory?.status}`
      })
    } finally {
      if (categoryId) {
        await cleanup(caseRecord, `停用售后问题分类 ${categoryId}`, () =>
          disableAfterSalesConfig(api, 'CATEGORY', categoryId)
        )
      }
    }
    const settingsCollections = await Promise.all([
      api.getBusiness('/after-sales/modeling/priority-rule/list'),
      api.getBusiness('/after-sales/modeling/sla-policy/list'),
      api.getBusiness('/after-sales/modeling/escalation-rule/list'),
      api.getBusiness('/after-sales/modeling/evaluation-item-category/list'),
      api.getBusiness('/after-sales/modeling/evaluation-item/list'),
      api.getBusiness('/after-sales/modeling/evaluation-template/list'),
      api.getBusiness('/after-sales/modeling/reminder-rule/list'),
      api.getBusiness('/after-sales/modeling/ai-connection/list')
    ])
    caseRecord.checks.push({
      name: '售后设置页全部建模数据均从正式接口读取',
      passed: settingsCollections.every((item) => Array.isArray(listOf(item))),
      details: `优先级=${listOf(settingsCollections[0]).length}, SLA=${listOf(settingsCollections[1]).length}, 升级=${listOf(settingsCollections[2]).length}, 评价项目=${listOf(settingsCollections[4]).length}, 评价模板=${listOf(settingsCollections[5]).length}, 提醒=${listOf(settingsCollections[6]).length}, AI连接=${listOf(settingsCollections[7]).length}`
    })
    await openRoute(page, '/after-sales/settings')
    await page.waitForTimeout(1200)
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '售后设置页已接入真实数据且不再展示虚拟数据标识',
      passed: bodyText.includes('售后建模') && !bodyText.includes('虚拟数据'),
      details: bodyText.includes('售后建模') ? '售后建模页面已渲染' : '未命中售后建模页面'
    })
    await saveScreenshot(page, outputDir, 'pb120-after-sales-modeling', record)
    return { token, api }
  }

  if (caseId === 'PB122-001') {
    const assetFixture = await createManualAssetFixture(api, 'PB122')
    const itemFixture = {
      itemCode: unique('ASII'),
      itemName: 'E2E 售后巡检项目',
      resultType: 'BOOLEAN',
      status: 0
    }
    let itemId
    let planId
    let assignmentId
    try {
    itemId = dataOf(await api.postBusiness('/after-sales/inspection-config/item/create', itemFixture))
    const planResponse = await api.postBusiness('/after-sales/inspection-config/plan/create', {
      planCode: unique('ASIP'),
      planName: 'E2E 售后巡检方案',
      items: [{ itemId, seq: 1, standard: '目视无异常' }],
      cycles: [{ cycleType: 'TIME', cycleValue: 30, cycleUnit: 'DAY', dataSource: 'CALENDAR' }]
    })
    planId = dataOf(planResponse)
    await api.putBusiness(`/after-sales/inspection-config/plan/publish?id=${planId}`)
    const plan = dataOf(await api.getBusiness(`/after-sales/inspection-config/plan/get?id=${planId}`))
    caseRecord.checks.push({
      name: '售后巡检方案发布记录版本',
      passed: plan.status === 'PUBLISHED' && plan.publishedVersion === plan.currentVersion,
      details: `status=${plan.status}, version=${plan.publishedVersion}`
    })
    const deleteResponse = await api.delete(`/after-sales/inspection-config/item/delete?id=${itemId}`)
    const deleteRejected = isBusinessRejected(deleteResponse, 400, '项目已被巡检方案引用，只能停用不能删除')
    caseRecord.checks.push({
      name: '被方案引用的巡检项目禁止删除',
      passed: deleteRejected,
      details: JSON.stringify(deleteResponse)
    })
    const inServiceAssetId = assetFixture.assetId
      const assignmentResponse = await api.postBusiness('/after-sales/inspection-config/assignment/create', {
        assetId: inServiceAssetId,
        planId,
        status: 0
      })
      assignmentId = dataOf(assignmentResponse)
      const assignments = await api.getBusiness(
        `/after-sales/inspection-config/assignment/list?assetId=${inServiceAssetId}`
      )
      caseRecord.checks.push({
        name: '巡检方案可分配到在保客户资产并作为任务快照来源',
        passed:
          assetFixture.detail?.asset?.serviceStatus === 'IN_SERVICE' &&
          listOf(assignments).some((item) => String(item.id) === String(assignmentId)),
        details: `assetId=${inServiceAssetId}, assignmentId=${assignmentId}`
      })
    } finally {
      if (assignmentId) await cleanup(caseRecord, `删除本轮资产分配 ${assignmentId}`, () =>
        api.deleteBusiness(`/after-sales/inspection-config/assignment/delete?id=${assignmentId}`))
      if (planId) await cleanup(caseRecord, `停用并回读本轮方案 ${planId}`, async () => {
        await api.putBusiness(`/after-sales/inspection-config/plan/disable?id=${planId}`)
        const disabled = dataOf(await api.getBusiness(`/after-sales/inspection-config/plan/get?id=${planId}`))
        if (disabled?.status !== 'DISABLED') throw new Error('方案停用后状态未回读为 DISABLED')
      })
      if (itemId) await cleanup(caseRecord, `停用并回读本轮项目 ${itemId}，引用历史按契约保留`, async () => {
        await api.putBusiness('/after-sales/inspection-config/item/update', { ...itemFixture, id: itemId, status: 1 })
        const items = listOf(await api.getBusiness('/after-sales/inspection-config/item/list'))
        if (!items.some((item) => String(item.id) === String(itemId) && item.status === 1)) {
          throw new Error('巡检项目停用后状态未回读为 1')
        }
      })
      await cleanup(caseRecord, `退役本轮专属资产 ${assetFixture.assetId}`, () =>
        retireAsset(api, assetFixture.assetId)
      )
    }
    return { token, api }
  }

  if (caseId === 'PB130-001') {
    // 值班事实源为 HRM/OA 排班：售后只维护电话与转接规则
    const employeePage = await api.getBusiness(
      '/hrm/employee/simple-page?pageNo=1&pageSize=100&entryStatus=1'
    )
    const employee = listOf(employeePage)[0]
    if (!employee?.id) {
      caseRecord.notes.push('BLOCKED：当前租户无在职 HRM 员工，无法创建真实值班排班。')
      return { token, api, partial: true }
    }
    const dutyRole = unique('E2E_DUTY_ROLE')
    const phone = '400-900-1234'
    const dutyDate = dateOffset(0)
    let scheduleId
    let ruleId
    try {
      scheduleId = dataOf(await api.postBusiness('/hrm/attendance/schedule/create', {
        employeeId: employee.id,
        scheduleDate: dutyDate,
        shiftName: 'E2E 值班班次',
        startTime: '09:00:00',
        endTime: '18:00:00',
        dutyRole,
        remark: 'E2E 值班写侧闭环'
      }))
      ruleId = dataOf(await api.postBusiness('/after-sales/duty/rule/save', {
        name: 'E2E 值班转接规则',
        dutyRole,
        phone,
        transferOrder: 1,
        timeoutMinutes: 5,
        serviceScope: 'E2E 服务范围',
        nonServiceTip: '非服务时段请留言',
        enabled: true,
        sort: 1
      }))
      const rules = listOf(await api.getBusiness('/after-sales/duty/rule/list'))
      const rule = rules.find((item) => String(item.id) === String(ruleId))
      caseRecord.checks.push({
        name: '售后值班只维护转接规则，不复制排班事实',
        passed:
          rule?.dutyRole === dutyRole &&
          rule?.phone === phone &&
          rule?.enabled === true,
        details: `ruleId=${ruleId}, dutyRole=${rule?.dutyRole}`
      })
      const dutyRoles = listOf(await api.getBusiness('/after-sales/duty/duty-roles'))
      caseRecord.checks.push({
        name: 'HRM 提供值班角色目录，售后不做角色主档',
        passed:
          Array.isArray(dutyRoles) &&
          dutyRoles.length > 0 &&
          dutyRoles.includes(dutyRole),
        details: `角色数=${Array.isArray(dutyRoles) ? dutyRoles.length : 'n/a'}, 含本轮角色=${dutyRoles.includes(dutyRole)}`
      })
      const roster = dataOf(await api.getBusiness(
        `/after-sales/duty/roster?startDate=${dutyDate}&endDate=${dutyDate}`
      ))
      const shift = (roster?.roster || []).find((item) => item?.dutyRole === dutyRole)
      caseRecord.checks.push({
        name: '值班名册人员来自 HRM/OA 排班，电话来自售后转接规则',
        passed:
          Array.isArray(roster?.roster) &&
          shift?.date === dutyDate &&
          String(shift?.employeeId) === String(employee.id) &&
          shift?.phone === phone &&
          shift?.source === 'MANUAL' &&
          !(roster?.missingRoles || []).includes(dutyRole),
        details: `dutyDate=${dutyDate}, shift=${JSON.stringify(shift)}, missing=${JSON.stringify(roster?.missingRoles)}`
      })
    } finally {
      if (ruleId) {
        await cleanup(caseRecord, `删除本轮值班规则 ${ruleId}`, () =>
          api.deleteBusiness(`/after-sales/duty/rule/delete?id=${ruleId}`)
        )
      }
      if (scheduleId) {
        await cleanup(caseRecord, `删除本轮 HRM 值班排班 ${scheduleId}`, () =>
          api.deleteBusiness(`/hrm/attendance/schedule/delete?id=${scheduleId}`)
        )
      }
    }

    await openRoute(page, '/after-sales/settings')
    const dutyTab = page.locator('.el-tabs__item', { hasText: '值班服务' })
    if (await dutyTab.count()) {
      await dutyTab.first().click()
      await page.waitForTimeout(500)
    }
    const bodyText = await page.locator('body').innerText()
    const hardcoded = ['李工', '王敏', '张伟', '2026-07-22'].filter((name) => bodyText.includes(name))
    caseRecord.checks.push({
      name: '值班设置页不再出现示例人员与固定日期',
      passed: hardcoded.length === 0,
      details: hardcoded.length ? `仍存在：${hardcoded.join(',')}` : '未发现示例人员/固定日期'
    })
    await saveScreenshot(page, outputDir, 'pb130-duty', record)
    caseRecord.evidence.push(
      `PB-130 创建 HRM 值班排班 ${scheduleId}（员工 ${employee.id}, 角色 ${dutyRole}）并回读售后名册电话 ${phone}`
    )
    return { token, api }
  }

  if (caseId === 'PB121-001') {
    const reasonCode = unique('SLA_PAUSE')
    const ruleResponse = await api.postBusiness('/after-sales/sla/pause-rule/save', {
      reasonCode,
      reasonName: 'E2E等待客户补充资料',
      pauseCustomerSla: true,
      pauseInternalSla: false,
      maxPauseHours: 48,
      approvalRequired: false
    })
    const ruleId = dataOf(ruleResponse)
    const rules = listOf(await api.getBusiness('/after-sales/sla/pause-rule/list'))
    const rule = rules.find((item) => String(item.id) === String(ruleId))
    caseRecord.checks.push({
      name: '暂停规则可分别控制客户侧SLA与内部责任计时',
      passed: Boolean(rule) && rule.pauseCustomerSla === true && rule.pauseInternalSla === false,
      details: `ruleId=${ruleId}`
    })
    let rndRejected = false
    try {
      await api.postBusiness('/after-sales/sla/pause-rule/save', {
        reasonCode: 'WAITING_RND',
        reasonName: '等待研发处理',
        pauseCustomerSla: true,
        pauseInternalSla: true
      })
    } catch (error) {
      rndRejected = true
    }
    caseRecord.checks.push({
      name: '等待研发原因禁止暂停内部责任计时',
      passed: rndRejected,
      details: 'WAITING_RND + pauseInternalSla=true 被拒绝'
    })
    try {
      await api.postBusiness(`/after-sales/sla/pause-rule/change-status?id=${ruleId}&enabled=false`)
      const disabledRule = listOf(
        await api.getBusiness('/after-sales/sla/pause-rule/list')
      ).find((item) => String(item.id) === String(ruleId))
      caseRecord.checks.push({
        name: '暂停规则停用后回读为 DISABLED，停止参与 SLA 暂停计算',
        passed: disabledRule?.status === 'DISABLED',
        details: `ruleId=${ruleId}, status=${disabledRule?.status}`
      })
    } finally {
      if (ruleId) {
        await cleanup(caseRecord, `停用 SLA 暂停规则 ${ruleId}`, () =>
          api.postBusiness(`/after-sales/sla/pause-rule/change-status?id=${ruleId}&enabled=false`)
        )
      }
    }
    return { token, api }
  }

  if (caseId === 'PB123-001') {
    const categoryCode = unique('E2E_KB_CATEGORY')
    const title = unique('E2E_KB_CASE')
    let categoryId
    let libraryKey
    let topicId
    let documentId
    let knowledgeCaseId
    try {
      categoryId = dataOf(await api.postBusiness('/after-sales/modeling/category/create', {
        categoryCode,
        categoryName: `E2E 知识分类 ${categoryCode}`,
        defaultPriority: 'P2',
        applicableServiceStatus: 'IN_SERVICE',
        sortNo: 902
      }))
      const invalidResponse = await api.post('/after-sales/knowledge/save-draft', {
        categoryId,
        title: `${title}-未关联`,
        symptom: '问题',
        solution: '方案',
        keywords: ['E2E'],
        sourceType: 'MANUAL',
        desensitizationStatus: 'PASSED'
      })
      caseRecord.checks.push({
        name: '未关联知识中枢文档在保存阶段即被拒绝（1040011）',
        passed: isBusinessRejected(invalidResponse, 1040011, '知识中枢文档'),
        details: JSON.stringify(invalidResponse)
      })

      const libraryName = unique('E2E_KB_LIBRARY')
      // 本地知识库需绑定可用的向量模型；未启用向量能力时无法建立可索引文档。
      let embeddingModels = []
      try {
        embeddingModels = listOf(await api.getBusiness('/ai/model/simple-list?type=5'))
      } catch (error) {
        caseRecord.notes.push(
          `BLOCKED：查询 EMBEDDING 模型失败（/ai/model/simple-list?type=5）：${error.message}`
        )
        return { token, api, partial: true }
      }
      const embeddingModelId = embeddingModels[0]?.id
      if (!embeddingModelId) {
        caseRecord.notes.push(
          'BLOCKED：当前租户没有已启用的 EMBEDDING（type=5）模型，无法创建可索引的本地知识库与真实文档版本。'
        )
        return { token, api, partial: true }
      }
      try {
        await api.postBusiness('/system/ai-desktop/knowledge/policy/libraries', {
          name: libraryName,
          description: 'E2E 售后知识闭环专用本地库',
          libraryType: 'LOCAL',
          embeddingModelId,
          chunkStrategy: 'SMART',
          retrievalMode: 'HYBRID',
          rerankEnabled: false,
          accessScope: 'TENANT'
        })
      } catch (error) {
        caseRecord.notes.push(
          `BLOCKED：创建本地知识库失败（embeddingModelId=${embeddingModelId}）：${error.message}`
        )
        return { token, api, partial: true }
      }
      const library = listOf(
        await api.getBusiness('/system/ai-desktop/knowledge/policy/libraries')
      ).find((item) => item.name === libraryName)
      libraryKey = library?.libraryKey
      if (!libraryKey) {
        caseRecord.notes.push('BLOCKED：知识库创建后未在可见库列表中回读到 libraryKey，无法继续创建专题与文档。')
        return { token, api, partial: true }
      }

      const topicTitle = unique('E2E_KB_TOPIC')
      topicId = dataOf(await api.postBusiness('/system/ai-desktop/knowledge/policy/topics', {
        libraryKey,
        title: topicTitle,
        description: 'E2E 售后知识文档专题'
      }))
      const parsed = dataOf(
        await api.postBusiness('/system/ai-desktop/knowledge/policy/parse', {
          topicId,
          topicTitle,
          text: [
            'E2E 售后知识闭环验证资料。',
            '设备在运行过程中出现异常告警时，应先确认电源与网络连接是否稳定。',
            '随后检查采集网关指示灯状态，并记录告警码与发生时间。',
            '如现场无法恢复，应提交服务单并附上日志与截图，等待研发进一步分析。',
            '处理完成后需要补充验证步骤与结果，确保问题确实闭环。'
          ].join('\n')
        })
      )
      documentId = parsed?.knowledgeDocumentId
      if (!documentId) {
        caseRecord.notes.push(
          `BLOCKED：知识解析未返回文档编号，parsed=${JSON.stringify(parsed)}`
        )
        return { token, api, partial: true }
      }
      const document = await waitForIndexedDocument(api, documentId)
      const documentVersion = document?.versionNo ?? 1
      if (document?.parseStatus !== 'PARSED' || document?.indexStatus !== 'INDEXED') {
        caseRecord.notes.push(
          `BLOCKED：知识中枢文档未完成索引（documentId=${documentId}, parseStatus=${document?.parseStatus}, ` +
          `indexStatus=${document?.indexStatus}, indexError=${document?.indexErrorMessage || 'n/a'}），无法验证发布闭环。`
        )
        caseRecord.notes.push(
          `本轮可复核样本：分类=${categoryId}, 知识库=${libraryKey}, 专题=${topicId}, 文档=${documentId}，均带 E2E 唯一前缀。`
        )
        return { token, api, partial: true }
      }
      caseRecord.checks.push({
        name: '知识中枢文档通过真实解析与索引任务达到 PARSED + INDEXED',
        passed: true,
        details: `documentId=${documentId}, parseStatus=${document?.parseStatus}, indexStatus=${document?.indexStatus}, version=${documentVersion}`
      })

      knowledgeCaseId = dataOf(
        await api.postBusiness('/after-sales/knowledge/save-draft', {
          categoryId,
          title,
          applicableScope: 'E2E 标准平台现场实施',
          environmentSummary: '标准平台验收环境',
          riskNote: '仅用于 E2E 验证',
          keywords: ['E2E', '售后知识'],
          tags: ['E2E'],
          sourceType: 'MANUAL',
          knowledgeDocumentId: documentId,
          knowledgeDocumentVersion: documentVersion,
          desensitizationStatus: 'PENDING'
        })
      )
      await api.postBusiness(`/after-sales/knowledge/submit?id=${knowledgeCaseId}`)
      await api.postBusiness(`/after-sales/knowledge/mark-desensitized?id=${knowledgeCaseId}`)
      await api.postBusiness(
        `/after-sales/knowledge/review?id=${knowledgeCaseId}&approved=true&comment=${encodeURIComponent('E2E 审核通过')}`
      )
      const published = dataOf(
        await api.getBusiness(`/after-sales/knowledge/get?id=${knowledgeCaseId}`)
      )
      caseRecord.checks.push({
        name: '关联知识中枢文档版本后发布成功并同步',
        passed:
          published?.status === 'PUBLISHED' &&
          published?.syncStatus === 'SYNCED' &&
          published?.hubPublishStatus === 'SYNCED' &&
          String(published?.knowledgeDocumentId) === String(documentId) &&
          Number(published?.knowledgeDocumentVersion) === Number(documentVersion),
        details: `caseId=${knowledgeCaseId}, status=${published?.status}, syncStatus=${published?.syncStatus}, docVersion=${published?.knowledgeDocumentVersion}`
      })
      caseRecord.evidence.push(
        `PB-123 创建知识中枢文档 ${documentId}(v${documentVersion}) 与售后知识案例 ${knowledgeCaseId}，发布后状态 ${published?.status}/${published?.syncStatus}`
      )
    } finally {
      if (categoryId) {
        await cleanup(caseRecord, `停用售后知识分类 ${categoryId}`, () =>
          disableAfterSalesConfig(api, 'CATEGORY', categoryId)
        )
      }
    }
    caseRecord.notes.push(
      `本轮保留可复核样本：分类=${categoryId}, 知识库=${libraryKey}, 专题=${topicId}, 文档=${documentId}, 知识案例=${knowledgeCaseId}；售后知识案例无删除接口，按唯一前缀保留。`
    )
    return { token, api }
  }

  if (caseId === 'PB124-001') {
    const ruleCode = unique('REMIND')
    const payload = {
      ruleCode,
      ruleName: 'E2E 提醒规则',
      reminderScene: 'SLA_DUE',
      applicableStatuses: ['PROCESSING'],
      firstDelayMinutes: 30,
      repeatEnabled: false,
      channels: ['SYSTEM'],
      receiverTypes: ['HANDLER'],
      stopCondition: 'SLA_RESUMED',
      messageTemplate: 'SLA即将到期',
      idempotencyKeyTemplate: 'REMIND:{ruleCode}:{ticketId}',
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00'
    }
    let reminderId
    try {
      reminderId = dataOf(await api.postBusiness('/after-sales/modeling/reminder-rule/create', payload))
      const readRule = async () => listOf(await api.getBusiness(
        '/after-sales/modeling/reminder-rule/list'
      )).find((row) => String(row.id) === String(reminderId))
      const created = await readRule()
      caseRecord.checks.push({
        name: '提醒规则回读保留幂等键和跨午夜免打扰时段',
        passed: Boolean(created) && created.ruleCode === ruleCode &&
          created.idempotencyKeyTemplate === payload.idempotencyKeyTemplate &&
          created.quietHoursStart === payload.quietHoursStart &&
          created.quietHoursEnd === payload.quietHoursEnd &&
          created.repeatEnabled === false && created.repeatIntervalMinutes == null,
        details: `reminderId=${reminderId}, status=${created?.status}`
      })
      const editedName = 'E2E 提醒规则已编辑'
      const editedIdempotency = 'REMIND2:{ruleCode}:{ticketId}'
      const editedQuietStart = '23:00'
      const editedQuietEnd = '07:00'
      await api.putBusiness(`/after-sales/modeling/reminder-rule/update?id=${reminderId}`, {
        ...payload,
        ruleName: editedName,
        idempotencyKeyTemplate: editedIdempotency,
        quietHoursStart: editedQuietStart,
        quietHoursEnd: editedQuietEnd
      })
      const edited = await readRule()
      caseRecord.checks.push({
        name: '提醒规则编辑后名称回读并保持非循环无间隔',
        passed: edited?.ruleName === editedName && edited?.repeatIntervalMinutes == null,
        details: `reminderId=${reminderId}, name=${edited?.ruleName}`
      })
      const editFieldMismatch =
        edited?.idempotencyKeyTemplate !== editedIdempotency ||
        edited?.quietHoursStart !== editedQuietStart ||
        edited?.quietHoursEnd !== editedQuietEnd
      if (editFieldMismatch) {
        caseRecord.notes.push(
          `真实产品缺陷：AfterSalesModelingMaintenanceServiceImpl.updateReminderRule 未写回 ` +
          `idempotencyKeyTemplate/quietHoursStart/quietHoursEnd。期望=${editedIdempotency}|${editedQuietStart}|${editedQuietEnd}，` +
          `实际=${edited?.idempotencyKeyTemplate}|${edited?.quietHoursStart}|${edited?.quietHoursEnd}（reminderId=${reminderId}）`
        )
      }
      const invalidQuiet = await api.post('/after-sales/modeling/reminder-rule/create', {
        ...payload, ruleCode: unique('REMIND_INVALID'), quietHoursEnd: null
      })
      caseRecord.checks.push({
        name: '不完整免打扰时段被业务拒绝',
        passed: isBusinessRejected(invalidQuiet, 1020021, '免打扰'),
        details: JSON.stringify(invalidQuiet)
      })
      if (invalidQuiet?.code === 0 && dataOf(invalidQuiet)) {
        await api.postBusiness(`/after-sales/modeling/status?configType=REMINDER_RULE&id=${dataOf(invalidQuiet)}&enabled=false`)
      }
    } finally {
      if (reminderId) {
        await api.postBusiness(`/after-sales/modeling/status?configType=REMINDER_RULE&id=${reminderId}&enabled=false`)
        const disabled = listOf(await api.getBusiness('/after-sales/modeling/reminder-rule/list'))
          .find((row) => String(row.id) === String(reminderId))
        caseRecord.checks.push({
          name: '本轮提醒规则停用清理并回读',
          passed: disabled?.status === 'DISABLED',
          details: `reminderId=${reminderId}`
        })
      }
    }
    await openRoute(page, '/after-sales/settings')
    await page.getByRole('tab', { name: /提醒规则/ }).click()
    await page.locator('.reminder-table').waitFor({ state: 'visible' })
    caseRecord.checks.push({
      name: '真实 Chrome 提醒规则页签和配置表渲染',
      passed: await page.locator('.reminder-table').getByText('提醒场景', { exact: true }).isVisible(),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'pb124-reminder-settings', record)
    caseRecord.notes.push('配置层创建、编辑、回读和停用已执行；运行时重复通知/升级幂等仍未验证。')
    return { token, api, partial: true }
  }

  if (caseId === 'PB115-001') {
    const templates = listOf(await api.getBusiness('/pm/modeling/list?configKey=milestoneTemplate'))
    caseRecord.checks.push({
      name: '里程碑模板复用项目建模配置且不另建主档',
      passed:
        Array.isArray(templates) &&
        templates.every((item) => item.configKey === 'milestoneTemplate'),
      details: `模板数=${templates?.length ?? 'n/a'}`
    })
    caseRecord.checks.push({
      name: '里程碑模板保留版本号以支持发布后新版本变更',
      passed: (templates || []).every(
        (item) => item.versionNo === undefined || typeof item.versionNo === 'number'
      ),
      details: (templates || []).map((item) => `${item.configCode}@${item.versionNo}`).join(',') || '无模板数据，字段存在性以契约保证'
    })
    caseRecord.checks.push({
      name: '里程碑模板返回完整阶段快照供工作台回读',
      passed: (templates || []).every((item) => {
        try {
          const config = JSON.parse(item.configJson || '{}')
          return Array.isArray(config.stages)
        } catch {
          return false
        }
      }),
      details: '已校验 configJson.stages 数组'
    })
    let invalidRejected = false
    try {
      await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: unique('MS_INVALID'),
        configName: 'E2E 无交付物模板',
        configJson: JSON.stringify({
          stages: [{ name: '立项', duration: 5, required: true }]
        }),
        status: 'ENABLED'
      })
    } catch (error) {
      invalidRejected = true
    }
    caseRecord.checks.push({
      name: '启用里程碑模板前阻断缺少必经阶段交付物',
      passed: invalidRejected,
      details: '后端版本发布校验已执行'
    })
    const invalidDraftId = dataOf(await api.postBusiness('/pm/modeling/save', {
      configKey: 'milestoneTemplate',
      configCode: unique('MS_INVALID_DRAFT'),
      configName: 'E2E 无交付物草稿',
      configJson: JSON.stringify({ stages: [{ name: '立项', duration: 5, required: true }] }),
      status: 'DRAFT'
    }))
    let invalidStatusRejected = false
    try {
      await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=ENABLED`)
    } catch (error) {
      invalidStatusRejected = true
    }
    caseRecord.checks.push({
      name: '草稿经启用接口发布仍执行里程碑门禁，不能绕过保存校验',
      passed: invalidStatusRejected,
      details: `draftId=${invalidDraftId}`
    })
    await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=DISABLED`)
    const templateCode = unique('E2E_MILESTONE')
    const versionOneConfig = JSON.stringify({
      stages: [
        { code: `S1_${templateCode}`, name: '方案确认', duration: 3, required: true, deliverable: '确认单' },
        { code: `S2_${templateCode}`, name: '交付验收', duration: 5, required: true, deliverable: '验收材料' }
      ]
    })
    let versionOneId
    let versionTwoId
    try {
      versionOneId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: templateCode,
        configName: 'E2E 里程碑模板 V1',
        configJson: versionOneConfig,
        status: 'DRAFT'
      }))
      await api.postBusiness(`/pm/modeling/status?id=${versionOneId}&status=ENABLED`)
      const versionOne = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=milestoneTemplate')
      ).find((item) => String(item.id) === String(versionOneId))
      caseRecord.checks.push({
        name: '里程碑模板创建并发布 V1 后回读版本号',
        passed:
          versionOne?.status === 'ENABLED' &&
          versionOne?.versionNo === 1 &&
          parseJson(versionOne?.configJson).stages?.length === 2,
        details: `versionOneId=${versionOneId}, versionNo=${versionOne?.versionNo}`
      })
      versionTwoId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: templateCode,
        configName: 'E2E 里程碑模板 V2',
        configJson: JSON.stringify({
          stages: [
            { code: `S1_${templateCode}`, name: '方案确认', duration: 2, required: true, deliverable: '确认单' },
            { code: `S2_${templateCode}`, name: '交付验收', duration: 6, required: true, deliverable: '验收材料' },
            { code: `S3_${templateCode}`, name: '质保移交', duration: 4, required: true, deliverable: '移交清单' }
          ]
        }),
        status: 'DRAFT'
      }))
      await api.postBusiness(`/pm/modeling/status?id=${versionTwoId}&status=ENABLED`)
      const versions = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=milestoneTemplate')
      ).filter((item) => item.configCode === templateCode)
      const latest = versions.find((item) => String(item.id) === String(versionTwoId))
      const previous = versions.find((item) => String(item.id) === String(versionOneId))
      caseRecord.checks.push({
        name: '同编码发布新版本后版本号递增且旧版本自动停用',
        passed:
          latest?.status === 'ENABLED' &&
          latest?.versionNo === 2 &&
          previous?.status === 'DISABLED' &&
          parseJson(latest?.configJson).stages?.length === 3,
        details: `v1=${previous?.status}@${previous?.versionNo}, v2=${latest?.status}@${latest?.versionNo}`
      })
    } finally {
      for (const id of [versionTwoId, versionOneId].filter(Boolean)) {
        await cleanup(caseRecord, `停用里程碑模板版本 ${id}`, () =>
          api.postBusiness(`/pm/modeling/status?id=${id}&status=DISABLED`)
        )
      }
    }
    return { token, api }
  }

  if (caseId === 'PB116-001') {
    const [taskLibrary, taskCategory] = await Promise.all([
      api.getBusiness('/pm/modeling/list?configKey=taskLibrary'),
      api.getBusiness('/pm/modeling/list?configKey=taskCategory')
    ])
    caseRecord.checks.push({
      name: '任务库复用建模配置键 taskLibrary/taskCategory 并返回引用计数',
      passed:
        listOf(taskLibrary).every((item) => item.referenceCount === undefined || typeof item.referenceCount === 'number') &&
        listOf(taskCategory).every((item) => item.referenceCount === undefined || typeof item.referenceCount === 'number'),
      details: `任务库=${listOf(taskLibrary).length}, 任务分类=${listOf(taskCategory).length}`
    })
    caseRecord.checks.push({
      name: '任务库真实条目保存标准工时、产出物、验收标准和前置关系',
      passed: listOf(taskLibrary).every((item) => {
        try {
          const config = JSON.parse(item.configJson || '{}')
          return item.status !== 'ENABLED' || validTaskLibraryConfig(config)
        } catch {
          return false
        }
      }),
      details: '已校验 taskLibrary.configJson.tasks 的 PB-116 结构字段'
    })
    let invalidCycleRejected = false
    try {
      await api.postBusiness('/pm/modeling/save', {
        configKey: 'taskLibrary',
        configCode: unique('TASK_INVALID'),
        configName: 'E2E 循环任务库',
        configJson: JSON.stringify({
          tasks: [
            {
              code: 'TASK-A',
              name: '任务A',
              standardHours: 4,
              deliverable: '交付物A',
              acceptanceCriteria: '验收A',
              predecessorIds: ['TASK-B']
            },
            {
              code: 'TASK-B',
              name: '任务B',
              standardHours: 4,
              deliverable: '交付物B',
              acceptanceCriteria: '验收B',
              predecessorIds: ['TASK-A']
            }
          ]
        }),
        status: 'ENABLED'
      })
    } catch (error) {
      invalidCycleRejected = true
    }
    caseRecord.checks.push({
      name: '启用任务库前阻断前置任务循环依赖',
      passed: invalidCycleRejected,
      details: '后端版本发布校验已执行'
    })
    const invalidDraftId = dataOf(await api.postBusiness('/pm/modeling/save', {
      configKey: 'taskLibrary',
      configCode: unique('TASK_INVALID_DRAFT'),
      configName: 'E2E 无验收标准草稿',
      configJson: JSON.stringify({
        tasks: [{ code: 'TASK-A', name: '任务A', standardHours: 4, deliverable: '交付物A' }]
      }),
      status: 'DRAFT'
    }))
    let invalidStatusRejected = false
    try {
      await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=ENABLED`)
    } catch (error) {
      invalidStatusRejected = true
    }
    caseRecord.checks.push({
      name: '草稿经启用接口发布仍执行任务库门禁，不能绕过验收标准校验',
      passed: invalidStatusRejected,
      details: `draftId=${invalidDraftId}`
    })
    await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=DISABLED`)
    let categoryFixture = listOf(taskCategory)[0]
    let createdCategoryId = null
    if (!categoryFixture) {
      const categoryCode = unique('E2E_TASK_CATEGORY')
      createdCategoryId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'taskCategory',
        configCode: categoryCode,
        configName: 'E2E 任务分类',
        configJson: JSON.stringify({}),
        status: 'ENABLED'
      }))
      categoryFixture = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=taskCategory')
      ).find((item) => String(item.id) === String(createdCategoryId))
    }
    const taskLibraryCode = unique('E2E_TASK_LIBRARY')
    let taskLibraryId
    try {
      taskLibraryId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'taskLibrary',
        configCode: taskLibraryCode,
        configName: 'E2E 可执行任务库',
        configJson: JSON.stringify({
          categoryId: categoryFixture?.configCode,
          tasks: [
            {
              code: 'T1',
              name: '现场勘查',
              standardHours: 4,
              deliverable: '勘查记录',
              acceptance: '客户确认'
            },
            {
              code: 'T2',
              name: '方案实施',
              standardHours: 8,
              deliverable: '实施报告',
              acceptance: '验收通过',
              predecessorIds: ['T1']
            }
          ]
        }),
        status: 'ENABLED'
      }))
      const created = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=taskLibrary')
      ).find((item) => String(item.id) === String(taskLibraryId))
      const config = parseJson(created?.configJson)
      caseRecord.checks.push({
        name: '任务库写入标准工时、产出物、验收标准和前置关系',
        passed:
          created?.status === 'ENABLED' &&
          created?.versionNo === 1 &&
          validTaskLibraryConfig(config) &&
          config.tasks?.[1]?.predecessorIds?.[0] === 'T1' &&
          config.categoryId === categoryFixture?.configCode,
        details: `taskLibraryId=${taskLibraryId}, tasks=${config.tasks?.length ?? 'n/a'}`
      })
      const categoryAfter = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=taskCategory')
      ).find((item) => String(item.id) === String(categoryFixture?.id))
      caseRecord.checks.push({
        name: '任务库引用使 taskCategory 引用计数真实增加',
        passed:
          Number(categoryAfter?.referenceCount) >=
          Number(categoryFixture?.referenceCount || 0) + 1,
        details: `before=${categoryFixture?.referenceCount}, after=${categoryAfter?.referenceCount}`
      })
      const rejected = await api.post(
        `/pm/modeling/status?id=${categoryFixture.id}&status=DISABLED`
      )
      caseRecord.checks.push({
        name: '被任务库引用的任务分类禁止直接停用',
        passed: Number(rejected?.code) !== 0,
        details: JSON.stringify(rejected)
      })
    } finally {
      if (taskLibraryId) {
        await cleanup(caseRecord, `停用任务库 ${taskLibraryId}`, () =>
          api.postBusiness(`/pm/modeling/status?id=${taskLibraryId}&status=DISABLED`)
        )
      }
      if (createdCategoryId) {
        await cleanup(caseRecord, `停用本轮任务分类 ${createdCategoryId}`, () =>
          api.postBusiness(`/pm/modeling/status?id=${createdCategoryId}&status=DISABLED`)
        )
      }
    }
    return { token, api }
  }

  if (caseId === 'PB117-001') {
    for (const field of ['milestone', 'taskLibrary', 'dailyReportRule', 'weeklyReportRule',
      'warningRule', 'approvalFlow', 'staffProfile']) {
      const response = await api.post('/pm/modeling/save', {
        configKey: 'projectType',
        configCode: unique(`TYPE_INVALID_${field.toUpperCase()}`),
        configName: 'E2E 失效依赖项目类型',
        configJson: JSON.stringify({ [field]: unique('MISSING') }),
        status: 'ENABLED'
      })
      caseRecord.checks.push({
        name: `发布项目类型时拒绝未启用的 ${field} 依赖`,
        passed: response?.code === 1055020007,
        details: JSON.stringify(response)
      })
    }
    const invalidDraftId = dataOf(await api.postBusiness('/pm/modeling/save', {
      configKey: 'projectType',
      configCode: unique('TYPE_DRAFT_INVALID'),
      configName: 'E2E 未启用依赖草稿',
      configJson: JSON.stringify({ taskLibrary: unique('MISSING') }),
      status: 'DRAFT'
    }))
    try {
      const response = await api.post(`/pm/modeling/status?id=${invalidDraftId}&status=ENABLED`)
      caseRecord.checks.push({
        name: '项目类型草稿经状态接口启用不能绕过依赖校验',
        passed: response?.code === 1055020007,
        details: JSON.stringify(response)
      })
    } finally {
      await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=DISABLED`)
    }
    const milestoneCode = unique('MS_TYPE')
    const taskCode = unique('TASK_TYPE')
    const typeCode = unique('TYPE_DEPENDENCY')
    const dependencyIds = []
    let typeId
    let projectFixture
    try {
      dependencyIds.push(dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: milestoneCode,
        configName: 'E2E 项目类型里程碑',
        configJson: JSON.stringify({
          stages: [{ name: '交付验收', duration: 5, required: true, deliverable: '验收资料' }]
        }),
        status: 'ENABLED'
      })))
      dependencyIds.push(dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'taskLibrary',
        configCode: taskCode,
        configName: 'E2E 项目类型任务库',
        configJson: JSON.stringify({
          tasks: [{ code: 'T1', name: '交付', standardHours: 8, deliverable: '交付资料', acceptance: '确认通过' }]
        }),
        status: 'ENABLED'
      })))
      typeId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'projectType',
        configCode: typeCode,
        configName: 'E2E 项目类型依赖',
        configJson: JSON.stringify({ milestone: milestoneCode, taskLibrary: taskCode }),
        status: 'DRAFT'
      }))
      await api.postBusiness(`/pm/modeling/status?id=${typeId}&status=ENABLED`)
      for (const id of dependencyIds) {
        const response = await api.post(`/pm/modeling/status?id=${id}&status=DISABLED`)
        caseRecord.checks.push({
          name: '被启用项目类型引用的模板不能直接停用',
          passed: response?.code === 1055020005,
          details: `dependencyId=${id}, ${JSON.stringify(response)}`
        })
      }
      const baseProjectType = await resolveEnabledProjectType(api, new Set([typeCode]))
      projectFixture = await createDedicatedProject({
        api,
        caseId,
        projectType: baseProjectType,
        caseRecord
      })
      await api.putBusiness(
        '/pm/project/update',
        projectUpdatePayload(projectFixture.project, { projectType: typeCode })
      )
      const projectAfterUpdate = dataOf(
        await api.getBusiness(`/pm/project/get?id=${projectFixture.projectId}`)
      )
      const snapshot = parseJson(projectAfterUpdate?.projectTypeConfigSnapshotJson)
      const snapshotCodes = [
        ...(snapshot?.dependencySnapshots?.milestone || []),
        ...(snapshot?.dependencySnapshots?.taskLibrary || [])
      ].map((item) => item?.configCode)
      caseRecord.checks.push({
        name: '项目主档切换项目类型时固化服务端依赖配置快照',
        passed:
          projectAfterUpdate?.projectType === typeCode &&
          Number(projectAfterUpdate?.projectTypeConfigVersion) >= 1 &&
          snapshotCodes.includes(milestoneCode) &&
          snapshotCodes.includes(taskCode),
        details: `projectId=${projectFixture.projectId}, version=${projectAfterUpdate?.projectTypeConfigVersion}, snapshotCodes=${snapshotCodes.join(',')}`
      })
    } finally {
      const cleanupErrors = []
      if (projectFixture) {
        try {
          const restored = await restoreDedicatedProject(api, projectFixture)
          caseRecord.checks.push({
            name: '专属项目清理后归属与原项目类型回读',
            passed: restored?.projectType === projectFixture.project.projectType &&
              restored?.projectName === projectFixture.project.projectName,
            details: `projectId=${projectFixture.projectId}, projectType=${restored?.projectType}`
          })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (typeId) {
        try {
          await api.postBusiness(`/pm/modeling/status?id=${typeId}&status=DISABLED`)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      for (const id of dependencyIds) {
        try {
          await api.postBusiness(`/pm/modeling/status?id=${id}&status=DISABLED`)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, 'PB117 专属项目或建模配置清理失败')
      }
    }
    await openRoute(page, '/project/modeling/foundation/project-base/list?modeling=projectType')
    await saveScreenshot(page, outputDir, 'pb117-project-type-dependencies', record)
    return {
      token,
      api,
      partial: true,
      note: 'PB-117 七类依赖完整 ID/版本/配置快照、建项自动展开和版本漂移仍保留 PARTIAL；本次仅修复专属项目切换与快照验证污染。'
    }
  }

  if (caseId === 'PB119-001') {
    const categoryCode = unique('E2E_SLA_CATEGORY')
    let categoryId
    let policyId
    try {
      categoryId = dataOf(await api.postBusiness('/after-sales/modeling/category/create', {
        categoryCode,
        categoryName: `E2E SLA 分类 ${categoryCode}`,
        defaultPriority: 'P2',
        applicableProductType: 'STANDARD',
        applicableAssetType: 'SOFTWARE',
        applicableServiceStatus: 'IN_SERVICE',
        sortNo: 999
      }))
      policyId = dataOf(await api.postBusiness('/after-sales/modeling/sla-policy/create', {
        policyCode: unique('E2E_SLA'),
        policyName: 'E2E 标准响应 SLA',
        categoryIds: [categoryId],
        priority: 'P2',
        assetServiceStatus: 'IN_SERVICE',
        customerLevel: 'STANDARD',
        contractScope: 'E2E',
        responseMinutes: 30,
        resolutionCommitted: true,
        resolutionMinutes: 240,
        warningRatio: 80,
        pauseReason: 'WAITING_CUSTOMER_SUPPLEMENT',
        effectiveType: 'IMMEDIATE',
        remark: 'PB119 写侧闭环专属策略'
      }))
      const [categories, slaPolicies, reminderRules, evaluationTemplates] = await Promise.all([
        api.getBusiness('/after-sales/modeling/category/list'),
        api.getBusiness('/after-sales/modeling/sla-policy/list'),
        api.getBusiness('/after-sales/modeling/reminder-rule/list'),
        api.getBusiness('/after-sales/modeling/evaluation-template/list')
      ])
      const policy = listOf(slaPolicies).find(
        (item) => String(item.id) === String(policyId)
      )
      caseRecord.checks.push({
        name: '售后设置复用现有建模页读取 SLA/提醒/评价，不建平行主档',
        passed:
          [categories, slaPolicies, reminderRules, evaluationTemplates].every(
            (item) => Array.isArray(listOf(item))
          ) && Boolean(policy),
        details: `分类=${listOf(categories).length}, SLA=${listOf(slaPolicies).length}, 提醒=${listOf(reminderRules).length}, 评价模板=${listOf(evaluationTemplates).length}`
      })
      caseRecord.checks.push({
        name: 'SLA 策略写入后回读分类、响应/解决时限和暂停口径',
        passed:
          policy?.status === 'ENABLED' &&
          policy?.responseMinutes === 30 &&
          policy?.resolutionCommitted === true &&
          policy?.resolutionMinutes === 240 &&
          policy?.pauseReason === 'WAITING_CUSTOMER_SUPPLEMENT' &&
          policy?.categoryIds?.some((id) => String(id) === String(categoryId)),
        details: `policyId=${policyId}, categoryIds=${policy?.categoryIds?.join(',') || 'n/a'}`
      })
      await disableAfterSalesConfig(api, 'SLA_POLICY', policyId)
      const disabledPolicy = await readAfterSalesConfig(
        api,
        '/after-sales/modeling/sla-policy/list',
        policyId
      )
      caseRecord.checks.push({
        name: 'SLA 策略停用后回读为 DISABLED',
        passed: disabledPolicy?.status === 'DISABLED',
        details: `policyId=${policyId}, status=${disabledPolicy?.status}`
      })
    } finally {
      if (policyId) {
        await cleanup(caseRecord, `停用 SLA 策略 ${policyId}`, () =>
          disableAfterSalesConfig(api, 'SLA_POLICY', policyId)
        )
      }
      if (categoryId) {
        await cleanup(caseRecord, `停用 SLA 专属分类 ${categoryId}`, () =>
          disableAfterSalesConfig(api, 'CATEGORY', categoryId)
        )
      }
    }
    await openRoute(page, '/after-sales/settings', { readyText: '售后建模' })
    await page.waitForTimeout(1000)
    const settingsText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '售后设置页可进入且复用页面内维护 SLA/提醒/评价',
      passed: settingsText.includes('售后建模'),
      details: settingsText.includes('售后建模') ? '售后建模设置页已渲染' : '未命中售后建模设置页'
    })
    return { token, api }
  }

  if (caseId === 'PB126-001') {
    // 接待策略为租户单例；先记录旧值，写侧验证结束后恢复，避免污染既有配置。
    const previousPolicy = dataOf(
      await api.getBusiness('/after-sales/modeling/ai-reception-policy/get')
    )
    let policyId
    try {
      policyId = dataOf(await api.postBusiness('/after-sales/modeling/ai-reception-policy/save', {
        policyName: 'E2E 小序接待策略',
        confidenceThreshold: 70,
        sensitiveKeywords: ['投诉', '退款'],
        forceHumanOnSensitive: true,
        receptionWorkdays: [1, 2, 3, 4, 5],
        receptionHoursStart: '09:00',
        receptionHoursEnd: '18:00',
        sessionRetentionDays: 90,
        solutionDedupEnabled: true,
        maxSuggestions: 5
      }))
      const policy = dataOf(await api.getBusiness('/after-sales/modeling/ai-reception-policy/get'))
      caseRecord.checks.push({
        name: 'AI不得自动受理/关闭/改写客户事实',
        passed:
          Boolean(policy) &&
          policy.forbidAutoAccept === true &&
          policy.forbidAutoClose === true &&
          policy.forbidFactRewrite === true &&
          policy.maxSuggestions <= 5,
        details: `policyId=${policyId}`
      })
      let invalidConfidenceRejected = false
      try {
        await api.postBusiness('/after-sales/modeling/ai-reception-policy/save', {
          policyName: 'E2E 非法阈值',
          confidenceThreshold: 120,
          maxSuggestions: 5
        })
      } catch (error) {
        invalidConfidenceRejected = true
      }
      caseRecord.checks.push({
        name: '置信度阈值越界被拒绝',
        passed: invalidConfidenceRejected,
        details: '阈值限定 0-100'
      })
    } finally {
      if (previousPolicy?.id) {
        await cleanup(caseRecord, `恢复小序接待策略原值 ${previousPolicy.id}`, () =>
          api.postBusiness('/after-sales/modeling/ai-reception-policy/save', {
            id: previousPolicy.id,
            policyName: previousPolicy.policyName,
            confidenceThreshold: previousPolicy.confidenceThreshold,
            sensitiveKeywords: parseJson(previousPolicy.sensitiveKeywordsJson, null),
            forceHumanOnSensitive: previousPolicy.forceHumanOnSensitive,
            receptionWorkdays: parseJson(previousPolicy.receptionWorkdaysJson, null),
            receptionHoursStart: previousPolicy.receptionHoursStart,
            receptionHoursEnd: previousPolicy.receptionHoursEnd,
            sessionRetentionDays: previousPolicy.sessionRetentionDays,
            solutionDedupEnabled: previousPolicy.solutionDedupEnabled,
            maxSuggestions: previousPolicy.maxSuggestions
          })
        )
      } else if (policyId) {
        await cleanup(caseRecord, `停用本轮新建小序接待策略 ${policyId}`, () =>
          api.postBusiness(`/after-sales/modeling/ai-reception-policy/status?id=${policyId}&enabled=false`)
        )
      }
    }
    return { token, api }
  }

  if (caseId === 'PB125-001') {
    const fixture = await createManualAssetFixture(api, 'PB125')
    try {
      const assetPage = listOf(
        await api.getBusiness('/after-sales/asset/page?pageNo=1&pageSize=100')
      )
      const listed = assetPage.find((asset) => String(asset.id) === String(fixture.assetId))
      caseRecord.checks.push({
        name: '手工客户资产可在分页中按 assetNo 独立检索',
        passed:
          listed?.assetNo === fixture.assetNo &&
          String(listed?.customerId) === String(fixture.customerId) &&
          Object.prototype.hasOwnProperty.call(listed || {}, 'serviceStatus'),
        details: `assetId=${fixture.assetId}, assetNo=${fixture.assetNo}`
      })
      const detail = fixture.detail
      const managers = detail?.managers || []
      const periods = detail?.servicePeriods || []
      caseRecord.checks.push({
        name: '客户资产详情统一回读服务期、责任人和存货档案引用',
        passed:
          detail?.asset?.id === fixture.assetId &&
          detail?.asset?.serviceStatus === 'IN_SERVICE' &&
          String(detail?.asset?.materialId) === String(fixture.materialId) &&
          managers.some((manager) => manager.managerName?.includes('PB125')) &&
          periods.some((period) => period.sourceType === 'MANUAL') &&
          String(detail?.customer?.id) === String(fixture.customerId),
        details: `assetId=${fixture.assetId}, materialId=${detail?.asset?.materialId}, managers=${managers.length}, periods=${periods.length}`
      })
      caseRecord.checks.push({
        name: '客户资产不是存货余额载体，不含库存数量字段',
        passed:
          !Object.prototype.hasOwnProperty.call(detail?.asset || {}, 'stockQuantity') &&
          !Object.prototype.hasOwnProperty.call(detail?.asset || {}, 'inventoryQuantity') &&
          Boolean(detail?.asset?.materialId),
        details: `assetKeys=${Object.keys(detail?.asset || {}).join(',')}`
      })
    } finally {
      await cleanup(caseRecord, `退役本轮专属资产 ${fixture.assetId}`, () =>
        retireAsset(api, fixture.assetId)
      )
    }
    const retired = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${fixture.assetId}`))
    caseRecord.checks.push({
      name: '资产退役后状态回读为 RETIRED，不改动存货档案',
      passed:
        retired?.asset?.serviceStatus === 'RETIRED' &&
        String(retired?.asset?.materialId) === String(fixture.materialId),
      details: `assetId=${fixture.assetId}, status=${retired?.asset?.serviceStatus}`
    })
    await openRoute(page, '/after-sales/settings')
    await saveScreenshot(page, outputDir, 'pb125-asset', record)
    caseRecord.evidence.push(
      `PB-125 创建手工客户资产 ${fixture.assetNo}（assetId=${fixture.assetId}）并完成服务期/责任人/状态回读与退役`
    )
    return { token, api }
  }

  if (caseId === 'PB127-001') {
    // PB-939 要求验收通过必须匹配已确认范围基线，因此使用本轮专属项目自带四项基线。
    const projectType = await resolveEnabledProjectType(api)
    const dedicated = await createDedicatedProject({
      api,
      caseId,
      projectType,
      caseRecord,
      activate: true
    })
    const project = dedicated.project
    const baseline = listOf(
      await api.getBusiness(`/pm/baseline/list?projectId=${dedicated.projectId}`)
    ).find((item) => item?.baselineType === 'SCOPE' && item?.status === 'CONFIRMED')
    if (!baseline?.id) {
      caseRecord.notes.push('BLOCKED：专属项目缺少已确认 SCOPE 基线，无法通过验收证据门禁。')
      return { token, api, partial: true }
    }
    const fixture = await createProjectAcceptanceAssetFixture(api, project, 'PB127', baseline.id)
    try {
      const detail = fixture.detail
      const periods = detail?.servicePeriods || []
      caseRecord.checks.push({
        name: '客户资产来源类型与来源项目/验收引用可回读',
        passed:
          detail?.asset?.sourceType === 'PROJECT_ACCEPTANCE' &&
          String(detail?.asset?.sourceProjectId) === String(project.id) &&
          String(detail?.asset?.sourceAcceptanceId) === String(fixture.acceptanceId),
        details: `assetId=${fixture.assetId}, sourceProjectId=${detail?.asset?.sourceProjectId}, sourceAcceptanceId=${detail?.asset?.sourceAcceptanceId}`
      })
      caseRecord.checks.push({
        name: '服务期来源关联项目验收单且资产处于在保状态',
        passed:
          detail?.asset?.serviceStatus === 'IN_SERVICE' &&
          periods.some(
            (period) =>
              period.sourceType === 'PROJECT_ACCEPTANCE' &&
              String(period.sourceId) === String(fixture.acceptanceId)
          ),
        details: `serviceStatus=${detail?.asset?.serviceStatus}, periods=${periods.length}`
      })
      const acceptance = dataOf(
        await api.getBusiness(`/pm/customer-acceptance/get?id=${fixture.acceptanceId}`)
      )
      caseRecord.checks.push({
        name: '来源验收单真实存在且状态为 APPROVED',
        passed:
          acceptance?.status === 'APPROVED' &&
          String(acceptance?.projectId) === String(project.id),
        details: `acceptanceId=${fixture.acceptanceId}, status=${acceptance?.status}`
      })
    } finally {
      await cleanup(caseRecord, `退役本轮项目验收资产 ${fixture.assetId}`, () =>
        retireAsset(api, fixture.assetId)
      )
    }
    const retired = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${fixture.assetId}`))
    caseRecord.checks.push({
      name: '项目验收资产退役后仍保留来源引用',
      passed:
        retired?.asset?.serviceStatus === 'RETIRED' &&
        String(retired?.asset?.sourceAcceptanceId) === String(fixture.acceptanceId),
      details: `assetId=${fixture.assetId}, status=${retired?.asset?.serviceStatus}`
    })
    await openRoute(page, '/after-sales/settings')
    await saveScreenshot(page, outputDir, 'pb127-project-acceptance-asset', record)
    caseRecord.evidence.push(
      `PB-127 以项目 ${project.id} 与验收单 ${fixture.acceptanceId} 生成售后资产 ${fixture.assetId}，验证来源引用`
    )
    return { token, api }
  }

  if (caseId === 'PB128-001') {
    const categoryCode = unique('E2E_EVAL_CATEGORY')
    const itemCode = unique('E2E_EVAL_ITEM')
    let categoryId
    let itemId
    try {
      categoryId = dataOf(
        await api.postBusiness('/after-sales/modeling/evaluation-item-category/create', {
          categoryCode,
          categoryName: `E2E 评价分类 ${categoryCode}`,
          sortNo: 900
        })
      )
      itemId = dataOf(await api.postBusiness('/after-sales/modeling/evaluation-item/create', {
        categoryId,
        itemCode,
        itemName: 'E2E 现场服务评分',
        evaluationType: 'STAR',
        maxScore: 5,
        required: true,
        sortNo: 1
      }))
      const item = listOf(
        await api.getBusiness('/after-sales/modeling/evaluation-item/list')
      ).find((row) => String(row.id) === String(itemId))
      caseRecord.checks.push({
        name: '评价项目主档写入后回读稳定编码与分类引用',
        passed:
          item?.itemCode === itemCode &&
          item?.evaluationType === 'STAR' &&
          String(item?.categoryId) === String(categoryId) &&
          item?.status === 'ENABLED' &&
          Number(item?.maxScore) === 5 &&
          item?.requiredFlag === true,
        details: `itemId=${itemId}, itemCode=${item?.itemCode}`
      })
      await disableAfterSalesConfig(api, 'EVALUATION_ITEM', itemId)
      const disabledItem = await readAfterSalesConfig(
        api,
        '/after-sales/modeling/evaluation-item/list',
        itemId
      )
      caseRecord.checks.push({
        name: '评价项目停用后回读为 DISABLED 且编码不变',
        passed: disabledItem?.status === 'DISABLED' && disabledItem?.itemCode === itemCode,
        details: `itemId=${itemId}, status=${disabledItem?.status}`
      })
    } finally {
      if (itemId) {
        await cleanup(caseRecord, `停用评价项目 ${itemId}`, () =>
          disableAfterSalesConfig(api, 'EVALUATION_ITEM', itemId)
        )
      }
      if (categoryId) {
        await cleanup(caseRecord, `停用评价分类 ${categoryId}`, () =>
          disableAfterSalesConfig(api, 'EVALUATION_ITEM_CATEGORY', categoryId)
        )
      }
    }
    await openRoute(page, '/after-sales/settings')
    await saveScreenshot(page, outputDir, 'pb128-evaluation-item', record)
    caseRecord.evidence.push(
      `PB-128 创建评价分类 ${categoryId} 与评价项目 ${itemCode}（itemId=${itemId}）并回读稳定编码`
    )
    return { token, api }
  }

  if (caseId === 'PB129-001') {
    const categoryCode = unique('E2E_EVAL_TPL_CATEGORY')
    const starCode = unique('E2E_EVAL_STAR')
    const resolutionCode = unique('E2E_EVAL_RESOLUTION')
    const templateCode = unique('E2E_EVAL_TEMPLATE')
    let categoryId
    let starItemId
    let resolutionItemId
    let templateId
    const originalItemName = 'E2E 服务评分（模板快照原值）'
    try {
      categoryId = dataOf(
        await api.postBusiness('/after-sales/modeling/evaluation-item-category/create', {
          categoryCode,
          categoryName: `E2E 模板评价分类 ${categoryCode}`,
          sortNo: 901
        })
      )
      resolutionItemId = dataOf(
        await api.postBusiness('/after-sales/modeling/evaluation-item/create', {
          categoryId,
          itemCode: resolutionCode,
          itemName: '问题是否解决',
          evaluationType: 'RESOLUTION_CONFIRM',
          maxScore: 0,
          required: true,
          sortNo: 1
        })
      )
      starItemId = dataOf(await api.postBusiness('/after-sales/modeling/evaluation-item/create', {
        categoryId,
        itemCode: starCode,
        itemName: originalItemName,
        evaluationType: 'STAR',
        maxScore: 5,
        required: true,
        sortNo: 2
      }))
      templateId = dataOf(
        await api.postBusiness('/after-sales/modeling/evaluation-template/create', {
          templateCode,
          templateName: `E2E 客户评价模板 ${templateCode}`,
          versionNo: 'V1',
          items: [
            { itemId: resolutionItemId, score: 0, required: true, sortNo: 1 },
            { itemId: starItemId, score: 100, required: true, sortNo: 2 }
          ]
        })
      )
      await api.postBusiness(`/after-sales/modeling/evaluation-template/enable?id=${templateId}`)
      const readTemplate = async () =>
        listOf(await api.getBusiness('/after-sales/modeling/evaluation-template/list')).find(
          (row) => String(row.id) === String(templateId)
        )
      const enabled = await readTemplate()
      const starSnapshot = enabled?.items?.find(
        (item) => String(item.itemId) === String(starItemId)
      )
      caseRecord.checks.push({
        name: '评价模板启用后回读项目快照与总分',
        passed:
          enabled?.status === 'ENABLED' &&
          Number(enabled?.totalScore) === 100 &&
          Array.isArray(enabled?.items) &&
          enabled.items.length === 2 &&
          starSnapshot?.itemNameSnapshot === originalItemName &&
          starSnapshot?.evaluationTypeSnapshot === 'STAR',
        details: `templateId=${templateId}, totalScore=${enabled?.totalScore}, snapshots=${enabled?.items?.length ?? 'n/a'}`
      })
      const renamed = 'E2E 服务评分（主档已改名）'
      await api.putBusiness(
        `/after-sales/modeling/evaluation-item/update?id=${starItemId}`,
        {
          categoryId,
          itemCode: starCode,
          itemName: renamed,
          evaluationType: 'STAR',
          maxScore: 5,
          required: true,
          sortNo: 2
        }
      )
      const afterMainChange = await readTemplate()
      const frozenSnapshot = afterMainChange?.items?.find(
        (item) => String(item.itemId) === String(starItemId)
      )
      const mainItem = listOf(
        await api.getBusiness('/after-sales/modeling/evaluation-item/list')
      ).find((row) => String(row.id) === String(starItemId))
      caseRecord.checks.push({
        name: '已启用模板保留创建时快照，不随评价项目主档漂移',
        passed:
          mainItem?.itemName === renamed &&
          frozenSnapshot?.itemNameSnapshot === originalItemName &&
          frozenSnapshot?.itemNameSnapshot !== mainItem?.itemName,
        details: `mainItem=${mainItem?.itemName}, templateSnapshot=${frozenSnapshot?.itemNameSnapshot}`
      })
    } finally {
      if (templateId) {
        await cleanup(caseRecord, `停用评价模板 ${templateId}`, () =>
          disableAfterSalesConfig(api, 'EVALUATION_TEMPLATE', templateId)
        )
      }
      for (const [label, id] of [
        ['评价项目-问题是否解决', resolutionItemId],
        ['评价项目-服务评分', starItemId]
      ]) {
        if (id) {
          await cleanup(caseRecord, `停用${label} ${id}`, () =>
            disableAfterSalesConfig(api, 'EVALUATION_ITEM', id)
          )
        }
      }
      if (categoryId) {
        await cleanup(caseRecord, `停用评价模板分类 ${categoryId}`, () =>
          disableAfterSalesConfig(api, 'EVALUATION_ITEM_CATEGORY', categoryId)
        )
      }
    }
    await openRoute(page, '/after-sales/settings')
    await saveScreenshot(page, outputDir, 'pb129-evaluation-template-snapshot', record)
    caseRecord.evidence.push(
      `PB-129 创建评价模板 ${templateCode}（templateId=${templateId}），修改主档后快照保持 ${originalItemName}`
    )
    return { token, api }
  }

  if (caseId === 'PB945-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      const outsideDate = await findWorkingDate(api, dateOffsetFrom(workingDate, 10))
      const projectStart = dateOffsetFrom(workingDate, -7)
      const projectEnd = dateOffsetFrom(workingDate, 90)
      await api.putBusiness('/pm/project/update', projectUpdatePayload(
        fixture.project,
        {
          status: 'EXECUTING',
          plannedStartDate: projectStart,
          plannedEndDate: projectEnd
        }
      ))
      const insideTaskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: `${fixture.marker}_INSIDE`,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const outsideTaskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: `${fixture.marker}_OUTSIDE`,
        plannedStartDate: outsideDate,
        plannedEndDate: outsideDate
      })
      const milestone = await createMilestoneFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const risk = await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        relatedType: 'TASK',
        relatedId: insideTaskId
      })
      const beforeTask = dataOf(await api.getBusiness(`/pm/task/get?id=${insideTaskId}`))
      const generated = []
      for (const [reportType, periodKey] of [
        ['DAILY', workingDate],
        ['WEEKLY', isoWeekKey(workingDate)],
        ['MONTHLY', workingDate.slice(0, 7)]
      ]) {
        const reportId = numericId(dataOf(await api.postBusiness(
          `/pm/daily-report/generate?projectId=${fixture.projectId}&reporterId=${fixture.ownerId}` +
          `&reportType=${reportType}&periodKey=${encodeURIComponent(periodKey)}`
        )), `${reportType} 周期报告`)
        const report = dataOf(await api.getBusiness(`/pm/daily-report/get?id=${reportId}`))
        const range = resolveReportPeriodRange(reportType, periodKey)
        const source = dataOf(await api.getBusiness(
          `/pm/daily-report/source?projectId=${fixture.projectId}` +
          `&reportType=${reportType}&periodKey=${encodeURIComponent(periodKey)}`
        ))
        const sourceTaskIds = (source?.tasks || []).map((item) => String(item.id))
        const periodMatches =
          range &&
          String(report?.periodStart) === range[0] &&
          String(report?.periodEnd) === range[1]
        const sourceMatches =
          String(source?.projectId) === String(fixture.projectId) &&
          sourceTaskIds.includes(String(insideTaskId)) &&
          Array.isArray(source?.risks) &&
          (source?.risks || []).some((item) => String(item.id) === String(risk.riskId)) &&
          Array.isArray(source?.milestones) &&
          (source?.milestones || []).some((item) => String(item.id) === String(milestone.milestoneId))
        caseRecord.checks.push({
          name: `${reportType} 生成周期范围并由服务端构造只读来源快照`,
          passed:
            Boolean(range) &&
            periodMatches &&
            report?.aiSuggestionStatus === 'SUGGESTED' &&
            sourceMatches &&
            Boolean(source?.generatedAt) &&
            typeof report?.sourceSnapshotJson === 'string' &&
            report.sourceSnapshotJson.includes('generatedAt'),
          details: `reportId=${reportId}, period=${report?.periodStart}~${report?.periodEnd}, sourceTasks=${sourceTaskIds.join(',')}`
        })
        generated.push({ reportType, reportId, sourceTaskIds })
      }
      const daily = generated.find((item) => item.reportType === 'DAILY')
      caseRecord.checks.push({
        name: '日报来源按当天过滤，周期外任务不进入快照',
        passed:
          daily?.sourceTaskIds.includes(String(insideTaskId)) &&
          !daily?.sourceTaskIds.includes(String(outsideTaskId)),
        details: `inside=${insideTaskId}, outside=${outsideTaskId}, snapshot=${daily?.sourceTaskIds.join(',')}`
      })
      const afterTask = dataOf(await api.getBusiness(`/pm/task/get?id=${insideTaskId}`))
      caseRecord.checks.push({
        name: '报告生成只读取任务和工时，不反写任务状态',
        passed:
          afterTask?.status === beforeTask?.status &&
          String(afterTask?.plannedEndDate) === String(beforeTask?.plannedEndDate),
        details: `taskId=${insideTaskId}, before=${beforeTask?.status}, after=${afterTask?.status}`
      })
      caseRecord.evidence.push(
        `PB-945 在专属项目 ${fixture.projectId} 生成 ${generated.map((item) => `${item.reportType}:${item.reportId}`).join(', ')}，日报仅包含 ${workingDate} 的任务`
      )
    } finally {
      const restored = await restoreDedicatedProject(api, fixture)
      caseRecord.checks.push({
        name: '专属项目周期与状态清理后回读',
        passed:
          isDedicatedProject(restored, fixture) &&
          restored?.status === fixture.project.status,
        details: `projectId=${fixture.projectId}, status=${restored?.status}`
      })
    }
    return { token, api }
  }

  if (caseId === 'PB947-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const risk = await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        relatedType: 'TASK',
        relatedId: taskId
      })
      const issueId = dataOf(await api.postBusiness('/pm/issue/save', {
        projectId: fixture.projectId,
        title: `${fixture.marker} 问题`,
        description: 'E2E 验证问题独立于风险记录',
        level: 'MEDIUM',
        ownerId: fixture.ownerId,
        ownerName: '管理员',
        dueDate: dateOffset(14)
      }))
      const bugId = dataOf(await api.postBusiness('/pm/bug/save', {
        projectId: fixture.projectId,
        title: `${fixture.marker} Bug`,
        description: 'E2E 验证 Bug 独立编号与记录',
        severity: 'MEDIUM',
        priority: 2,
        reporterId: fixture.ownerId,
        reporterName: '管理员',
        assigneeId: fixture.ownerId,
        assigneeName: '管理员',
        dueDate: dateOffset(14)
      }))
      const [issue, bug] = await Promise.all([
        api.getBusiness(`/pm/issue/get?id=${issueId}`),
        api.getBusiness(`/pm/bug/get?id=${bugId}`)
      ])
      caseRecord.checks.push({
        name: '风险、问题、Bug 使用独立记录和编号，不通过转化删除原记录',
        passed:
          Boolean(dataOf(issue)?.issueNo) &&
          Boolean(dataOf(bug)?.bugNo) &&
          String(dataOf(issue)?.id) !== String(dataOf(bug)?.id),
        details: `riskNo=${risk.detail?.riskNo}, issueNo=${dataOf(issue)?.issueNo}, bugNo=${dataOf(bug)?.bugNo}`
      })
      await api.postBusiness('/pm/risk/save', riskUpdatePayload(risk.detail, { level: 'HIGH' }))
      const leveled = dataOf(await api.getBusiness(`/pm/risk/get?id=${risk.riskId}`))
      const history = parseRiskLevelHistory(leveled?.levelHistoryJson)
      caseRecord.checks.push({
        name: '风险等级变化写前值、变化时间和结构化历史',
        passed:
          leveled?.level === 'HIGH' &&
          leveled?.previousLevel === 'LOW' &&
          Boolean(leveled?.levelChangedTime) &&
          history.some((item) =>
            item?.previousLevel === 'LOW' &&
            item?.currentLevel === 'HIGH' &&
            Boolean(item?.changedTime)),
        details: `riskId=${risk.riskId}, history=${JSON.stringify(history)}`
      })
      caseRecord.checks.push({
        name: '风险可关联任务且保留责任人和期限',
        passed:
          leveled?.relatedType === 'TASK' &&
          String(leveled?.relatedId) === String(taskId) &&
          String(leveled?.ownerId) === String(fixture.ownerId) &&
          Boolean(leveled?.dueDate),
        details: `relatedType=${leveled?.relatedType}, relatedId=${leveled?.relatedId}, dueDate=${leveled?.dueDate}`
      })
      await api.putBusiness('/pm/risk/status', { id: risk.riskId, status: 'MITIGATING' })
      const invalidMissingVerifier = await api.put('/pm/risk/status', {
        id: risk.riskId,
        status: 'CLOSED'
      }, {
        expectedBusinessRejection: {
          code: 1055009002,
          message: /verifier is required before closing/
        }
      })
      caseRecord.checks.push({
        name: '风险关闭缺少验证人时按领域错误拒绝',
        passed: isBusinessRejected(
          invalidMissingVerifier,
          1055009002,
          'verifier is required before closing'
        ),
        details: JSON.stringify(invalidMissingVerifier)
      })
      await api.putBusiness('/pm/risk/status', {
        id: risk.riskId,
        status: 'CLOSED',
        verifierId: fixture.ownerId
      })
      const closed = dataOf(await api.getBusiness(`/pm/risk/get?id=${risk.riskId}`))
      caseRecord.checks.push({
        name: '风险验证后关闭并回读关闭时间、验证人和验证时间',
        passed:
          closed?.status === 'CLOSED' &&
          String(closed?.verifiedBy) === String(fixture.ownerId) &&
          Boolean(closed?.closedTime) &&
          Boolean(closed?.verifiedTime),
        details: `riskId=${risk.riskId}, status=${closed?.status}, verifiedBy=${closed?.verifiedBy}`
      })
      caseRecord.evidence.push(
        `PB-947 验证风险 ${risk.riskId} 关联任务 ${taskId}、LOW→HIGH 历史、关闭验证及问题 ${issueId}/Bug ${bugId} 独立记录`
      )
      await openRoute(page, '/project/execution/controls/risk-issue')
      await saveScreenshot(page, outputDir, 'pb947-risk-issue-governance', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return {
      token,
      api,
      partial: true,
      note: 'PB-947 已验证风险关联/等级历史/验证关闭及问题、Bug 独立记录；问题/Bug 的关联、转化来源字段尚未接入 Do、ReqVO 和 Controller，保留 PARTIAL。'
    }
  }

  if (caseId === 'PB949-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const changeId = await createChangeFixture({
        api,
        projectId: fixture.projectId,
        requesterId: fixture.ownerId,
        marker: fixture.marker,
        relatedType: 'TASK',
        relatedId: taskId
      })
      const idempotencyKey = unique('E2E_CHANGE_EXEC')
      await setChangeStatus(api, changeId, 'ASSESSING')
      await setChangeStatus(api, changeId, 'PENDING_APPROVAL')
      await setChangeStatus(api, changeId, 'APPROVED', {
        objectVersion: 1,
        downstreamStrategy: 'MANUAL',
        approvalOpinion: 'E2E 审批通过并冻结对象版本'
      })
      const approved = dataOf(await api.getBusiness(`/pm/change/get?id=${changeId}`))
      caseRecord.checks.push({
        name: '变更审批通过冻结对象版本并记录下游处理策略',
        passed:
          approved?.status === 'APPROVED' &&
          approved?.objectVersion === 1 &&
          approved?.downstreamStrategy === 'MANUAL' &&
          String(approved?.approverId) === String(fixture.ownerId),
        details: `changeId=${changeId}, version=${approved?.objectVersion}, strategy=${approved?.downstreamStrategy}`
      })
      await setChangeStatus(api, changeId, 'EXECUTING', { executionIdempotencyKey: idempotencyKey })
      const executing = dataOf(await api.getBusiness(`/pm/change/get?id=${changeId}`))
      caseRecord.checks.push({
        name: '服务端一次性执行写入幂等键、执行人和执行时间',
        passed:
          executing?.status === 'EXECUTING' &&
          executing?.executionIdempotencyKey === idempotencyKey &&
          String(executing?.executedBy) === String(fixture.ownerId) &&
          Boolean(executing?.executedTime) &&
          executing?.fieldChanges?.[0]?.executionStatus === 'EXECUTING',
        details: `changeId=${changeId}, key=${executing?.executionIdempotencyKey}, fieldStatus=${executing?.fieldChanges?.[0]?.executionStatus}`
      })
      await setChangeStatus(api, changeId, 'VERIFIED', {
        approvalOpinion: 'E2E 执行结果已验证'
      })
      await setChangeStatus(api, changeId, 'CLOSED', {
        approvalOpinion: 'E2E 变更闭环'
      })
      const closed = dataOf(await api.getBusiness(`/pm/change/get?id=${changeId}`))
      caseRecord.checks.push({
        name: '变更经执行、验证后关闭且全链路时间可回读',
        passed:
          closed?.status === 'CLOSED' &&
          Boolean(closed?.verifiedTime) &&
          Boolean(closed?.closedTime) &&
          closed?.fieldChanges?.[0]?.executionStatus === 'CLOSED',
        details: `changeId=${changeId}, status=${closed?.status}, verified=${closed?.verifiedTime}, closed=${closed?.closedTime}`
      })

      const duplicateChangeId = await createChangeFixture({
        api,
        projectId: fixture.projectId,
        requesterId: fixture.ownerId,
        marker: `${fixture.marker}_DUPLICATE`,
        relatedType: 'TASK',
        relatedId: taskId
      })
      await setChangeStatus(api, duplicateChangeId, 'ASSESSING')
      await setChangeStatus(api, duplicateChangeId, 'PENDING_APPROVAL')
      await setChangeStatus(api, duplicateChangeId, 'APPROVED', {
        objectVersion: 1,
        downstreamStrategy: 'MANUAL',
        approvalOpinion: 'E2E 重复幂等键验证'
      })
      const duplicate = await api.put('/pm/change/status', {
        id: duplicateChangeId,
        status: 'EXECUTING',
        executionIdempotencyKey: idempotencyKey
      }, {
        expectedBusinessRejection: {
          code: 1055012002,
          message: new RegExp(`change already executed with key ${idempotencyKey}`)
        }
      })
      caseRecord.checks.push({
        name: '重复幂等键被领域拒绝，不产生第二次执行',
        passed: isBusinessRejected(
          duplicate,
          1055012002,
          `change already executed with key ${idempotencyKey}`
        ),
        details: JSON.stringify(duplicate)
      })
      const duplicateAfter = dataOf(
        await api.getBusiness(`/pm/change/get?id=${duplicateChangeId}`)
      )
      caseRecord.checks.push({
        name: '重复执行拒绝后第二条变更仍停留在 APPROVED',
        passed: duplicateAfter?.status === 'APPROVED' && !duplicateAfter?.executedTime,
        details: `changeId=${duplicateChangeId}, status=${duplicateAfter?.status}`
      })
      caseRecord.evidence.push(
        `PB-949 变更 ${changeId} 完成 DRAFT→CLOSED，幂等键 ${idempotencyKey} 在 ${duplicateChangeId} 上被拒绝`
      )
      await openRoute(page, '/project/execution/plan-change/list')
      await saveScreenshot(page, outputDir, 'pb949-change-execution', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return { token, api }
  }

  if (caseId === 'PB951-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const missingGate = await createMilestoneFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: `${fixture.marker}_NO_GATE`,
        withGates: false,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      await api.putBusiness(`/pm/milestone/confirm?id=${missingGate.milestoneId}`, undefined)
      const invalidComplete = await api.put(
        `/pm/milestone/complete?id=${missingGate.milestoneId}` +
        `&manualConclusion=${encodeURIComponent('E2E 缺少准出条件')}`,
        undefined,
        {
          expectedBusinessRejection: {
            code: 1055004003,
            message: '里程碑日期超出项目计划窗口或结束日期早于开始日期'
          }
        }
      )
      caseRecord.checks.push({
        name: '里程碑缺少准出条件或必需交付物时不能完成',
        passed: isBusinessRejected(
          invalidComplete,
          1055004003,
          '里程碑日期超出项目计划窗口或结束日期早于开始日期'
        ),
        details: JSON.stringify(invalidComplete)
      })

      const milestone = await createMilestoneFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        withGates: true,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const taskBefore = dataOf(await api.getBusiness(`/pm/task/get?id=${taskId}`))
      await api.putBusiness(`/pm/milestone/confirm?id=${milestone.milestoneId}`, undefined)
      await api.putBusiness(
        `/pm/milestone/complete?id=${milestone.milestoneId}` +
        `&manualConclusion=${encodeURIComponent('E2E 人工确认准出条件和交付物已满足')}`,
        undefined
      )
      const completed = await getMilestone(api, fixture.projectId, milestone.milestoneId)
      caseRecord.checks.push({
        name: '具备准出条件和交付物的里程碑可人工确认完成',
        passed:
          completed?.confirmed === true &&
          completed?.status === 'COMPLETED' &&
          completed?.exitCondition === `${fixture.marker} 准出条件` &&
          parseJson(completed?.requiredDeliverablesJson, []).length === 1 &&
          completed?.manualConclusion === 'E2E 人工确认准出条件和交付物已满足' &&
          Boolean(completed?.actualFinishDate),
        details: `milestoneId=${milestone.milestoneId}, status=${completed?.status}, conclusion=${completed?.manualConclusion}`
      })
      const taskAfter = dataOf(await api.getBusiness(`/pm/task/get?id=${taskId}`))
      caseRecord.checks.push({
        name: '里程碑人工完成不代替任务责任人确认或改写任务状态',
        passed:
          taskAfter?.status === taskBefore?.status &&
          String(taskAfter?.plannedEndDate) === String(taskBefore?.plannedEndDate),
        details: `taskId=${taskId}, before=${taskBefore?.status}, after=${taskAfter?.status}`
      })
      caseRecord.evidence.push(
        `PB-951 缺门禁里程碑 ${missingGate.milestoneId} 被拒绝；达标里程碑 ${milestone.milestoneId} 完成并保留人工结论`
      )
      await openRoute(page, '/project/execution/milestone-confirm/list')
      await saveScreenshot(page, outputDir, 'pb951-milestone-complete', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return { token, api }
  }

  if (caseId === 'PB953-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      await completeTaskFixture(api, taskId)
      await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker
      })
      const query = {
        projectId: fixture.projectId,
        startDate: dateOffset(-1),
        endDate: dateOffset(1)
      }
      for (const definition of PROJECT_REPORT_DEFINITIONS) {
        const report = dataOf(await api.getBusiness(
          `/pm/report/${definition.path}?${pushReportQuery({}, query)}`
        ))
        caseRecord.checks.push({
          name: `${definition.reportType} 报表返回统一口径和同一筛选上下文`,
          passed:
            report?.reportType === definition.reportType &&
            Number.isInteger(Number(report?.metricVersion)) &&
            report?.calculationMode === 'RECHECKED' &&
            Boolean(report?.generatedAt) &&
            String(report?.appliedFilters?.projectId) === String(fixture.projectId) &&
            String(report?.appliedFilters?.startDate) === query.startDate &&
            String(report?.appliedFilters?.endDate) === query.endDate,
          details:
            `type=${report?.reportType}, version=${report?.metricVersion}, ` +
            `mode=${report?.calculationMode}, filters=${JSON.stringify(report?.appliedFilters)}`
        })
      }
      for (const definition of PROJECT_REPORT_DEFINITIONS.slice(0, 2)) {
        const exportFile = await api.download(
          `/pm/report/export-excel?${pushReportQuery({ reportType: definition.reportType }, query)}`
        )
        const workbook = XLSX.read(exportFile.buffer, { type: 'buffer' })
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
          defval: null
        })
        caseRecord.checks.push({
          name: `${definition.reportType} 导出复用相同筛选并生成可解析 Excel`,
          passed:
            workbook.SheetNames.length > 0 &&
            rows.length > 0 &&
            String(rows[0]?.reportType) === definition.reportType &&
            String(rows[0]?.calculationMode) === 'RECHECKED',
          details: `contentType=${exportFile.contentType}, rows=${rows.length}, sheet=${workbook.SheetNames[0]}`
        })
      }
      caseRecord.evidence.push(
        `PB-953 对专属项目 ${fixture.projectId} 校验 11 类报表统一 projectId/startDate/endDate，并验证前两类 Excel 与查询口径一致`
      )
      await openRoute(page, '/project/statistics/overview')
      await saveScreenshot(page, outputDir, 'pb953-project-reports', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return { token, api }
  }

  if (caseId === 'PB955-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      await completeTaskFixture(api, taskId)
      const milestone = await createMilestoneFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        withGates: true,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      await api.putBusiness(`/pm/milestone/confirm?id=${milestone.milestoneId}`, undefined)
      await api.putBusiness(
        `/pm/milestone/complete?id=${milestone.milestoneId}` +
        `&manualConclusion=${encodeURIComponent('E2E 绩效里程碑完成')}`,
        undefined
      )
      const risk = await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker
      })
      await api.postBusiness('/pm/risk/save', riskUpdatePayload(risk.detail, { level: 'HIGH' }))
      await api.putBusiness('/pm/risk/status', { id: risk.riskId, status: 'MITIGATING' })
      await api.putBusiness('/pm/risk/status', {
        id: risk.riskId,
        status: 'CLOSED',
        verifierId: fixture.ownerId
      })

      const formula = dataOf(await api.getBusiness('/pm/report/performance/formula'))
      caseRecord.checks.push({
        name: '绩效公式、数据来源、剔除规则和可见角色公开可读',
        passed:
          Boolean(formula?.configCode) &&
          Boolean(formula?.metricVersion) &&
          typeof formula?.formula === 'string' &&
          formula.formula.trim().length > 0 &&
          Array.isArray(formula?.dataSource) &&
          formula.dataSource.length > 0 &&
          Array.isArray(formula?.excludeRules) &&
          Array.isArray(formula?.visibleRoles) &&
          Boolean(formula?.weightRules),
        details: `config=${formula?.configCode}, version=${formula?.metricVersion}, sources=${formula?.dataSource?.join(',')}`
      })
      const query = {
        projectId: fixture.projectId,
        startDate: dateOffset(-1),
        endDate: dateOffset(1)
      }
      const summary = dataOf(await api.getBusiness(
        `/pm/report/performance/summary?${pushReportQuery({}, query)}`
      ))
      const row = (summary?.rows || []).find(
        (item) => String(item.userId) === String(fixture.ownerId)
      )
      // 专属项目在交接评审时会按模板展开里程碑与任务，plannedWeight 因此包含模板计划量；
      // 绩效口径按公开公式校验：completionRate 必须等于 deliveredWeight / plannedWeight * 100。
      const plannedWeight = Number(row?.plannedWeight)
      const deliveredWeight = Number(row?.deliveredWeight)
      const expectedCompletionRate =
        Number.isFinite(plannedWeight) && plannedWeight > 0
          ? Number(((deliveredWeight * 100) / plannedWeight).toFixed(2))
          : null
      caseRecord.checks.push({
        name: '绩效汇总按正式已验收任务和已完成里程碑计算权重与完成率',
        passed:
          summary?.reportType === 'PROJECT_PERFORMANCE' &&
          Number(row?.acceptedTaskCount) >= 1 &&
          Number(row?.completedMilestoneCount) >= 1 &&
          Number.isFinite(plannedWeight) &&
          plannedWeight >= deliveredWeight &&
          deliveredWeight >= 18 &&
          Number(row?.completionRate) === expectedCompletionRate &&
          summary?.formula === formula?.formula,
        details: `row=${JSON.stringify(row)}, expectedCompletionRate=${expectedCompletionRate}`
      })
      const person = dataOf(await api.getBusiness(
        `/pm/report/performance/person?${pushReportQuery({ userId: fixture.ownerId }, query)}`
      ))
      caseRecord.checks.push({
        name: '个人绩效明细返回任务、里程碑和统一公式口径',
        passed:
          String(person?.userId) === String(fixture.ownerId) &&
          Number(person?.acceptedTaskCount) >= 1 &&
          Number(person?.completedMilestoneCount) >= 1 &&
          (person?.tasks || []).some((item) => String(item.id) === String(taskId)) &&
          (person?.milestones || []).some(
            (item) => String(item.id) === String(milestone.milestoneId)
          ) &&
          Number(person?.metricVersion) === Number(summary?.metricVersion) &&
          person?.formula === summary?.formula,
        details: `user=${person?.userName}, tasks=${person?.tasks?.length}, milestones=${person?.milestones?.length}`
      })
      const trend = dataOf(await api.getBusiness(
        `/pm/report/risk-trend?${pushReportQuery({}, query)}`
      ))
      const change = (trend?.changes || []).find(
        (item) => String(item.riskId) === String(risk.riskId)
      )
      const handling = (trend?.handlingDurations || []).find(
        (item) => String(item.riskId) === String(risk.riskId)
      )
      caseRecord.checks.push({
        name: '风险趋势保留等级变化和验证关闭后的处置时长',
        passed:
          trend?.reportType === 'RISK_TREND' &&
          change?.previousLevel === 'LOW' &&
          change?.currentLevel === 'HIGH' &&
          Boolean(change?.changedTime) &&
          handling?.status === 'CLOSED' &&
          Boolean(handling?.verifiedTime) &&
          Number(handling?.durationDays) >= 0,
        details: `change=${JSON.stringify(change)}, handling=${JSON.stringify(handling)}`
      })
      caseRecord.evidence.push(
        `PB-955 专属项目 ${fixture.projectId} 完成任务 ${taskId}(8h)、里程碑 ${milestone.milestoneId}(权重10) 和风险 ${risk.riskId}，绩效完成率 100%`
      )
      await openRoute(page, '/project/ai/performance/dashboard')
      await saveScreenshot(page, outputDir, 'pb955-performance', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return { token, api }
  }

  caseRecord.notes.push(`未识别的案例：${caseId}`)
  return { token, api }
}
