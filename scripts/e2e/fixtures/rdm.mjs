import { config } from '../config/index.mjs'
import { createHash } from 'node:crypto'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'

export const RDM_CASES = new Set([
  'RDM-001',
  'RDM-002',
  'RDM-003',
  'RDM-004',
  'RDM-005',
  'RDM-006'
])

export const RDM_PREFIX = 'E2E-RDM'

const businessSuccess = (payload) =>
  payload?.code === 0 ||
  (payload?.code === 200 && payload?.success === true)

const dataOf = (payload) => payload?.data ?? payload

const idOf = (payload) => {
  const value = dataOf(payload)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['id', 'projectId', 'iterationId', 'releaseId', 'planId', 'runId']) {
      if (value[key] !== undefined && value[key] !== null) return String(value[key])
    }
  }
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    return String(value)
  }
  return ''
}

const asNumberId = (value, label) => {
  const text = String(value ?? '')
  if (!/^\d+$/.test(text)) throw new Error(`BLOCKED: ${label} 未返回合法数据库ID`)
  return text
}

// MySQL bit(1)/tinyint(1) columns surface as a raw control byte, "1" or true.
const isTruthyBit = (value) => {
  if (value === true || value === 1) return true
  if (value == null || value === '') return false
  if (typeof value === 'number') return value !== 0
  const text = String(value)
  return text === '1' || text === '\u0001' || text === 'true' || text === 'b\'1\''
}

const addCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  return Boolean(passed)
}

const addEvidence = (caseRecord, value) => {
  caseRecord.evidence.push(value)
}

const addDatabase = (caseRecord, stage, snapshot) => {
  caseRecord.database = [...(caseRecord.database || []), { stage, ...snapshot }]
}

const today = (offset = 0) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}

const dateOffsetFrom = (dateText, days) => {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const isHrmWorkingDay = async (api, date) => {
  const holiday = await getBusiness(api, `/hrm/attendance/holiday/check?day=${encodeURIComponent(`${date}T00:00:00`)}`)
  if (Number(holiday?.type) === 1) return true
  if (Number(holiday?.type) === 2) return false
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6
}

// 项目任务同时受项目计划窗口和 HRM 工作日门禁约束，夹具必须给出真实工作日。
const findWorkingDate = async (api, startDate, searchDays = 60) => {
  for (let offset = 0; offset < searchDays; offset += 1) {
    const candidate = dateOffsetFrom(startDate, offset)
    if (await isHrmWorkingDay(api, candidate)) return candidate
  }
  throw new Error(`BLOCKED: 自 ${startDate} 起 ${searchDays} 天内没有可用 HRM 工作日`)
}

const summaryOf = (payload) => {
  const value = dataOf(payload)
  if (value === null || value === undefined) return '<empty>'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).slice(0, 240)
  }
  return JSON.stringify(value).slice(0, 600)
}

const expectedFailureKeyword = /invalid|required|不能为空|必须|不允许|无效|不存在|阻塞|状态|影响|冻结|快照|审批|条件|release/i

export async function expectBusinessFailure ({
  api,
  method,
  path,
  body,
  caseRecord,
  name,
  expectedPaths,
  expectedMessage = expectedFailureKeyword,
  expectedCode
}) {
  let payload
  try {
    payload = await api.request(method, path, body)
  } catch (error) {
    const message = String(error?.message || error)
    // Transport and server failures cannot prove a business validation rule.
    addCheck(caseRecord, name, false, message.slice(0, 600))
    throw error
  }
  const failed = !businessSuccess(payload)
  const summary = summaryOf(payload)
  const code = Number(payload?.code)
  const validation = failed &&
    Number.isFinite(code) &&
    ![401, 403, 404, 500].includes(code) &&
    !/SQL|Exception|系统异常|服务器错误|无权限|未登录/i.test(summary) &&
    expectedMessage.test(summary) &&
    (expectedCode === undefined || code === expectedCode)
  addCheck(caseRecord, name, validation, JSON.stringify({ code, businessFailed: failed, summary }))
  if (!failed) throw new Error(`预期业务失败但接口成功：${method} ${path}`)
  if (!validation) throw new Error(`非预期业务校验失败：${method} ${path}: ${summary}`)
  expectedPaths?.add(path.split('?')[0])
  return { failed: true, payload, summary }
}

async function postBusiness (api, path, body) {
  return dataOf(await api.postBusiness(path, body))
}

async function putBusiness (api, path, body) {
  return dataOf(await api.putBusiness(path, body))
}

async function getBusiness (api, path) {
  return dataOf(await api.getBusiness(path))
}

async function readDatabase (caseRecord, stage, sql) {
  const snapshot = await runReadOnlySql(sql)
  addDatabase(caseRecord, stage, snapshot)
  if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
  return snapshot.rows
}

const firstRow = (rows) => rows[0] || []

const rowObject = (row, keys) =>
  Object.fromEntries(keys.map((key, index) => [key, row?.[index] ?? null]))

export function assertRdmLocalTarget (target = config) {
  if (target.target !== 'local' || String(target.tenantId) !== '1') {
    throw new Error('BLOCKED: RDM 写侧仅允许本地标准平台 tenant1')
  }
  for (const [base, port] of [[target.apiBase, '48083'], [target.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== port) {
      throw new Error('BLOCKED: RDM 写侧仅允许 48083/9151 loopback')
    }
  }
}

export async function assertRdmPage ({ api, caseRecord, path, label, id, fields = [] }) {
  const data = await getBusiness(api, path)
  const rows = Array.isArray(data?.list) ? data.list : Array.isArray(data?.records) ? data.records : null
  addCheck(caseRecord, `${label}分页结构有效且 pageSize 不超过 100`,
    Array.isArray(rows) && rows.length <= 100 && typeof data?.total === 'number' && data.total >= 0,
    JSON.stringify({ total: data?.total, count: rows?.length ?? null }))
  const row = rows?.find((item) => String(item.id ?? item.ebomId) === String(id))
  addCheck(caseRecord, `${label}分页包含本轮专属记录和 catalog 字段`,
    Boolean(row) && fields.every((field) => Object.hasOwn(row, field)),
    JSON.stringify({ id, found: Boolean(row), missingFields: fields.filter((field) => !row || !Object.hasOwn(row, field)) }))
  return row
}

async function currentUser (api, caseRecord) {
  const profile = await getBusiness(api, '/system/user/profile/get')
  const ownerId = asNumberId(profile?.id, '当前用户')
  addCheck(
    caseRecord,
    '当前登录用户可通过正式用户接口解析负责人ID',
    ownerId === '1' || /^\d+$/.test(ownerId),
    JSON.stringify({ ownerId, username: profile?.username || null })
  )
  return {
    ownerId,
    ownerName: profile?.nickname || profile?.username || 'admin'
  }
}

export async function resolveRdmProjectType (api, caseRecord) {
  const rows = await getBusiness(api, '/pm/modeling/list?configKey=projectType&status=ENABLED')
  const config = Array.isArray(rows) ? rows[0] : null
  if (!config?.configCode) throw new Error('BLOCKED: 没有启用的 PM projectType 建模配置')
  addCheck(
    caseRecord,
    '项目创建使用正式启用的 projectType 配置而非猜测编码',
    true,
    JSON.stringify({ configCode: config.configCode, versionNo: config.versionNo ?? null })
  )
  return config.configCode
}

export async function createRdmFixture ({
  api, caseRecord, caseId, writeSafety = assertLocalWriteSafety
}) {
  assertRdmLocalTarget()
  await writeSafety(caseRecord)
  const user = await currentUser(api, caseRecord)
  const projectTypeCode = await resolveRdmProjectType(api, caseRecord)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const tag = `${RDM_PREFIX}-${caseId.replace('-', '')}-${stamp}`
  caseRecord.fixtures = {
    prefix: RDM_PREFIX,
    caseId,
    tag,
    tenantId: 1,
    ownerId: user.ownerId
  }
  addEvidence(caseRecord, `本轮数据唯一前缀 ${RDM_PREFIX}，租户 tenant1（tenant_id=1）`)
  return { ...user, projectType: projectTypeCode, tag }
}

export async function createPmProject ({ api, fixture, caseRecord }) {
  const rules = await getBusiness(api, '/pm/modeling/list?configKey=projectBase&status=ENABLED')
  const required = ['PB-001', 'PB-002', 'PB-003', 'PB-004', 'PB-005']
  const missing = required.filter((code) =>
    !Array.isArray(rules) || !rules.some((rule) => rule.configCode === code && rule.status === 'ENABLED'))
  if (missing.length) {
    if (caseRecord) {
      addEvidence(caseRecord, `PM 建项前置缺少启用规则 ${missing.join(', ')}；不能修改共享正式规则`)
      await readDatabase(caseRecord, 'PM projectBase prerequisite', `
        SELECT id,config_code,status,reference_count
        FROM pm_project_modeling_config
        WHERE tenant_id=1 AND deleted=0 AND config_key='projectBase'
        ORDER BY config_code
      `)
    }
    throw new Error(`BLOCKED: 正式 PM 建项硬编码要求启用 ${missing.join(', ')}，专属 E2E-RDM 规则不可替代，需主线程确认共享规则修复`)
  }
  const handoverId = await postBusiness(api, '/pm/handover/create', {
    sourceType: 'MANUAL',
    sourceBusinessNo: fixture.tag,
    projectName: `${fixture.tag}-PM`,
    projectType: fixture.projectType,
    customerNameSnapshot: fixture.tag,
    scopeIn: fixture.tag,
    commitments: fixture.tag,
    acceptanceConditions: fixture.tag,
    initialRisks: fixture.tag
  })
  const handover = asNumberId(handoverId, 'PM交接单')
  await putBusiness(api, `/pm/handover/submit?id=${handover}`, undefined)
  const reviewed = await putBusiness(api, '/pm/handover/review', {
    id: handover,
    decision: 'APPROVE',
    opinion: `${fixture.tag}-review`,
    proposedPmId: fixture.ownerId,
    developmentManagerId: fixture.ownerId,
    consultantId: fixture.ownerId
  })
  let projectId = idOf(reviewed)
  if (!projectId) {
    const detail = await getBusiness(api, `/pm/handover/get?id=${handover}`)
    projectId = idOf(detail?.projectId)
  }
  projectId = asNumberId(projectId, 'PM项目')
  return { handoverId: handover, projectId }
}

export async function createIteration ({ api, fixture, projectId, caseRecord }) {
  const iterationId = asNumberId(await postBusiness(api, '/pm/iteration/save', {
    projectId,
    iterationName: `${fixture.tag}-iteration`,
    versionNo: `${fixture.tag}-V1`,
    objective: fixture.tag,
    plannedStartDate: today(),
    plannedEndDate: today(14)
  }), '迭代')
  const snapshotId = asNumberId(await postBusiness(api, '/pm/iteration/scope-snapshot/save', {
    iterationId,
    projectId,
    scopeJson: JSON.stringify({ items: [`${fixture.tag}-scope-v1`] })
  }), '初始范围快照')
  await putBusiness(api, `/pm/iteration/scope-snapshot/lock?id=${snapshotId}`, undefined)
  await putBusiness(api, '/pm/iteration/status', {
    id: iterationId,
    status: 'PENDING_CONFIRMATION',
    operatorId: fixture.ownerId
  })
  await putBusiness(api, '/pm/iteration/status', {
    id: iterationId,
    status: 'LOCKED',
    operatorId: fixture.ownerId
  })
  const iteration = await getBusiness(api, `/pm/iteration/get?id=${iterationId}`)
  const snapshot = await getBusiness(api, `/pm/iteration/scope-snapshot/get?id=${snapshotId}`)
  addCheck(
    caseRecord,
    '迭代进入 LOCKED 且初始范围快照保持 LOCKED',
    iteration?.status === 'LOCKED' && snapshot?.status === 'LOCKED',
    JSON.stringify({ iterationStatus: iteration?.status, snapshotStatus: snapshot?.status })
  )
  return { iterationId, snapshotId, iteration, snapshot }
}

export async function createRequirement ({ api, fixture, projectId, iterationId, title }) {
  return asNumberId(await postBusiness(api, '/pm/requirement/save', {
    projectId,
    iterationId,
    title: title || `${fixture.tag}-requirement`,
    category: 'FUNCTIONAL',
    sourceType: RDM_PREFIX,
    sourceReference: fixture.tag,
    proposerId: fixture.ownerId,
    proposerName: fixture.ownerName,
    businessScenario: `${fixture.tag}-scenario`,
    expectedDate: today(10),
    acceptanceCriteria: `${fixture.tag}-acceptance`
  }), '需求')
}

export async function reviewRequirement ({ api, id, status, conclusion, reason }) {
  return putBusiness(api, '/pm/requirement/status', {
    id,
    status,
    reviewConclusion: conclusion,
    reviewReason: reason
  })
}

export async function completeRequirement ({ api, id }) {
  await reviewRequirement({
    api,
    id,
    status: 'PENDING_CONFIRMATION',
    conclusion: undefined,
    reason: undefined
  })
  await reviewRequirement({
    api,
    id,
    status: 'CONFIRMED',
    conclusion: 'ADOPTED',
    reason: 'E2E-RDM requirement accepted'
  })
  await reviewRequirement({
    api,
    id,
    status: 'IN_PROGRESS',
    conclusion: undefined,
    reason: undefined
  })
  await reviewRequirement({
    api,
    id,
    status: 'IMPLEMENTED',
    conclusion: undefined,
    reason: undefined
  })
}

export async function createPlmProject ({ api, fixture }) {
  const id = await postBusiness(api, '/plm/rdm/record/create', {
    bizType: 'PROJECT',
    bizNo: `${fixture.tag}-PLM`,
    bizName: `${fixture.tag}-plm-project`,
    status: 'DRAFT',
    stageCode: fixture.tag,
    stageName: fixture.tag,
    ownerId: fixture.ownerId,
    ownerName: fixture.ownerName,
    responsibleDeptName: fixture.tag,
    remark: fixture.tag
  })
  return asNumberId(id, 'PLM研发项目')
}

export function rdmMaterialCode (tag, suffix) {
  const digest = createHash('sha256').update(`${tag}:${suffix}`).digest('hex').slice(0, 16)
  return `${RDM_PREFIX}-${suffix === 'PARENT' ? 'P' : 'C'}-${digest}`
}

export async function createRdmMaterial ({ api, fixture, caseRecord, suffix, unit }) {
  const code = rdmMaterialCode(fixture.tag, suffix)
  const id = asNumberId(await postBusiness(api, '/mes/basMaterial/add', {
    code,
    name: `${fixture.tag}-${suffix}`,
    auxName: code,
    unitId: String(unit.id),
    inventoryNature: 'STOCK',
    isMaterial: 'Y',
    isEnabled: 1,
    purchased: 'Y',
    leadTime: 1,
    bufferTime: 0,
    source: suffix === 'PARENT' ? 'mixed' : 'purchase',
    saled: 'N',
    produced: suffix === 'PARENT' ? 'Y' : 'N',
    batchManaged: 'Y',
    oneBarcode: 'N',
    periodManaged: 'N',
    gradeManaged: 'N',
    remark: fixture.tag
  }), 'RDM专属MES物料')
  const material = await getBusiness(api, `/mes/basMaterial/queryById?id=${id}`)
  const owned = material?.code === code && material?.remark === fixture.tag &&
    String(material?.unitId) === String(unit.id)
  addCheck(caseRecord, `创建并回读 RDM 专属 ${suffix} MES物料`, owned,
    JSON.stringify({ id, code, unitId: material?.unitId }))
  if (!owned) throw new Error('BLOCKED: 专属物料所有权校验未通过')
  return { ...material, id }
}

export async function transitionPlmProject ({ api, id, status, fixture }) {
  await postBusiness(api, '/plm/rdm/project/ledger/transition-status', {
    projectId: id,
    targetStatus: status,
    stageCode: fixture.tag,
    stageName: fixture.tag,
    progressRate: status === 'CLOSED' ? 100 : 20,
    remark: `${fixture.tag}-${status}`
  })
  return getBusiness(api, `/plm/rdm/project/ledger/get?id=${id}`)
}

export async function runRdmWriteCase ({
  caseId,
  api,
  caseRecord,
  expectedPaths = new Set()
}) {
  const fixture = await createRdmFixture({ api, caseRecord, caseId })

  if (caseId === 'RDM-001') {
    const { projectId } = await createPmProject({ api, fixture, caseRecord })
    const ids = {}
    const conclusions = [
      ['adopted', 'CONFIRMED', 'ADOPTED', '需求采纳'],
      ['returned', 'REJECTED', 'RETURNED', '需求退回'],
      ['deferred', 'DEFERRED', 'DEFERRED', '需求暂缓'],
      ['refused', 'CANCELLED', 'REFUSED', '需求拒绝']
    ]
    for (const [key, status, conclusion, label] of conclusions) {
      const id = await createRequirement({
        api,
        fixture,
        projectId,
        title: `${fixture.tag}-${key}`
      })
      ids[key] = id
      await reviewRequirement({ api, id, status: 'PENDING_CONFIRMATION' })
      await expectBusinessFailure({
        api,
        method: 'PUT',
        path: '/pm/requirement/status',
        body: { id, status, reviewConclusion: conclusion },
        caseRecord,
        expectedPaths,
        name: `${label}缺少评审理由时拒绝写入`,
        expectedMessage: /评审|review/i
      })
      if (key === 'adopted') {
        await expectBusinessFailure({
          api,
          method: 'PUT',
          path: '/pm/requirement/status',
          body: { id, status, reviewConclusion: 'UNKNOWN', reviewReason: fixture.tag },
          caseRecord,
          expectedPaths,
          name: '不属于四种结论的评审拒绝写入',
          expectedMessage: /评审|review/i
        })
      }
      await reviewRequirement({
        api,
        id,
        status,
        conclusion,
        reason: `${fixture.tag}-${key}-reason`
      })
      const detail = await getBusiness(api, `/pm/requirement/get?id=${id}`)
      addCheck(
        caseRecord,
        `需求${label}状态和评审结论落库`,
        detail?.status === status && detail?.reviewConclusion === conclusion &&
          detail?.reviewReason === `${fixture.tag}-${key}-reason`,
        JSON.stringify({
          id,
          status: detail?.status,
          reviewConclusion: detail?.reviewConclusion,
          hasReason: Boolean(detail?.reviewReason)
        })
      )
      if (key === 'deferred') {
        await reviewRequirement({ api, id, status: 'DRAFT' })
        await reviewRequirement({ api, id, status: 'PENDING_CONFIRMATION' })
        await reviewRequirement({
          api,
          id,
          status: 'CONFIRMED',
          conclusion: 'ADOPTED',
          reason: `${fixture.tag}-deferred-re-review`
        })
        const reReviewed = await getBusiness(api, `/pm/requirement/get?id=${id}`)
        addCheck(
          caseRecord,
          '暂缓需求可回退并重新进入评审后采纳',
          reReviewed?.status === 'CONFIRMED' &&
            reReviewed?.reviewConclusion === 'ADOPTED',
          JSON.stringify({ status: reReviewed?.status, conclusion: reReviewed?.reviewConclusion })
        )
      }
    }
    await assertRdmPage({
      api, caseRecord, id: ids.adopted, label: '需求',
      path: `/pm/requirement/page?pageNo=1&pageSize=100&projectId=${projectId}`,
      fields: ['reviewConclusion', 'reviewReason']
    })
    const rows = await readDatabase(caseRecord, 'RDM-001 requirements', `
      SELECT id,status,review_conclusion,review_reason,reviewed_by,reviewed_time
      FROM pm_requirement
      WHERE tenant_id=1 AND id IN (${Object.values(ids).map(asNumberId).join(',')})
      ORDER BY id
    `)
    addCheck(caseRecord, 'pm_requirement 数据库证据包含本轮四种评审结论和理由', rows.length === 4 &&
      rows.every((row) => row[2] && row[3] && row[4] && row[5]), JSON.stringify({ rows: rows.length }))
    addEvidence(caseRecord, 'RDM001：PM 需求创建、登记完整性、评审四结论、缺理由拒绝、暂缓重评、API+SQL')
    return { allowRuntimeErrors: { api: ({ url }) => [...expectedPaths].some((path) => url.includes(path)) } }
  }

  if (caseId === 'RDM-002') {
    const { projectId } = await createPmProject({ api, fixture, caseRecord })
    const taskStart = await findWorkingDate(api, today())
    const taskEnd = await findWorkingDate(api, taskStart)
    const taskId = asNumberId(await postBusiness(api, '/pm/task/create-administrative', {
      projectId,
      taskName: `${fixture.tag}-task`,
      taskContent: fixture.tag,
      ownerId: fixture.ownerId,
      ownerName: fixture.ownerName,
      acceptanceOwnerId: fixture.ownerId,
      plannedStartDate: taskStart,
      plannedEndDate: taskEnd,
      standardHours: 1,
      plannedHours: 2,
      requiredOutput: fixture.tag,
      acceptanceCriteria: fixture.tag
    }), '项目任务')
    await putBusiness(api, `/pm/task/dispatch?id=${taskId}`, undefined)
    await putBusiness(api, `/pm/task/accept?id=${taskId}`, undefined)
    await putBusiness(api, `/pm/task/start?id=${taskId}`, undefined)
    await expectBusinessFailure({
      api,
      method: 'PUT',
      path: '/pm/task/block',
      body: {
        taskId,
        reason: `${fixture.tag}-blocked`,
        responsibleParty: fixture.tag
      },
      caseRecord,
      expectedPaths,
      expectedCode: 400,
      expectedMessage: /must not be blank|不能为空/i,
      name: '任务阻塞缺少解除条件时拒绝写入'
    })
    await putBusiness(api, '/pm/task/block', {
      taskId,
      reason: `${fixture.tag}-blocked`,
      responsibleParty: fixture.tag,
      releaseCondition: `${fixture.tag}-release-condition`
    })
    const blocked = await getBusiness(api, `/pm/task/get?id=${taskId}`)
    addCheck(
      caseRecord,
      '任务进入 BLOCKED 并写入原因、责任方和解除条件',
      blocked?.status === 'BLOCKED' &&
        blocked?.blockReason === `${fixture.tag}-blocked` &&
        blocked?.blockParty === fixture.tag &&
        blocked?.releaseCondition === `${fixture.tag}-release-condition`,
      JSON.stringify({
        status: blocked?.status,
        hasReason: Boolean(blocked?.blockReason),
        hasParty: Boolean(blocked?.blockParty),
        hasCondition: Boolean(blocked?.releaseCondition)
      })
    )
    await assertRdmPage({
      api, caseRecord, id: taskId, label: '阻塞任务',
      path: `/pm/task/page?pageNo=1&pageSize=100&projectId=${projectId}&status=BLOCKED`,
      fields: ['releaseCondition', 'blockReason', 'blockParty']
    })
    await readDatabase(caseRecord, 'RDM-002 blocked task', `
      SELECT id,status,COALESCE(block_reason,''),COALESCE(block_party,''),COALESCE(release_condition,'')
      FROM pm_project_task WHERE tenant_id=1 AND id=${asNumberId(taskId)}
    `)
    await putBusiness(api, `/pm/task/resume?id=${taskId}`, undefined)
    const resumed = await getBusiness(api, `/pm/task/get?id=${taskId}`)
    addCheck(
      caseRecord,
      '任务恢复后清空三个阻塞字段',
      resumed?.status === 'IN_PROGRESS' &&
        [resumed?.blockReason, resumed?.blockParty, resumed?.releaseCondition]
          .every((value) => value === '' || value === null),
      JSON.stringify({
        status: resumed?.status,
        blockReason: resumed?.blockReason ?? null,
        blockParty: resumed?.blockParty ?? null,
        releaseCondition: resumed?.releaseCondition ?? null
      })
    )
    await expectBusinessFailure({
      api,
      method: 'PUT',
      path: `/pm/task/resume?id=${taskId}`,
      body: undefined,
      caseRecord,
      expectedPaths,
      name: '非 BLOCKED 任务重复恢复时拒绝写入'
    })
    const rows = await readDatabase(caseRecord, 'RDM-002 task', `
      SELECT id,status,LENGTH(COALESCE(block_reason,'')),LENGTH(COALESCE(block_party,'')),
             LENGTH(COALESCE(release_condition,''))
      FROM pm_project_task
      WHERE tenant_id=1 AND id=${asNumberId(taskId)}
    `)
    addCheck(caseRecord, 'pm_project_task 数据库证据确认恢复后的状态和阻塞字段', rows.length === 1 &&
      rowObject(firstRow(rows), ['id', 'status', 'blockReason', 'blockParty', 'releaseCondition']).status === 'IN_PROGRESS' &&
      [firstRow(rows)[2], firstRow(rows)[3], firstRow(rows)[4]].every((value) => value === '0'),
    JSON.stringify({ rows: rows.length }))
    addEvidence(caseRecord, 'RDM002：任务创建、阻塞必填、恢复清空、重复恢复拒绝、API+SQL')
    return { allowRuntimeErrors: { api: ({ url }) => [...expectedPaths].some((path) => url.includes(path)) } }
  }

  if (caseId === 'RDM-003') {
    const projectId = await createPlmProject({ api, fixture })
    const draft = await getBusiness(api, `/plm/rdm/project/ledger/get?id=${projectId}`)
    addCheck(caseRecord, '研发项目真实创建为 DRAFT', draft?.status === 'DRAFT')
    const statuses = ['INITIATED', 'RUNNING', 'PAUSED', 'RUNNING', 'CLOSED']
    for (const status of statuses) {
      const detail = await transitionPlmProject({ api, id: projectId, status, fixture })
      addCheck(
        caseRecord,
        `研发项目合法状态流转到 ${status}`,
        detail?.status === status,
        JSON.stringify({ status: detail?.status })
      )
    }
    const cancelledId = await createPlmProject({ api, fixture: { ...fixture, tag: `${fixture.tag}-CANCEL` } })
    const cancelled = await transitionPlmProject({ api, id: cancelledId, status: 'CANCELLED', fixture })
    addCheck(caseRecord, '第六种研发项目状态 CANCELLED 真实流转', cancelled?.status === 'CANCELLED')
    const legacyId = asNumberId(await postBusiness(api, '/plm/rdm/record/create', {
      bizType: 'PROJECT',
      bizNo: `${fixture.tag}-LEGACY`,
      bizName: `${fixture.tag}-legacy`,
      status: 'EXECUTING',
      stageCode: 'PILOT',
      stageName: 'PILOT',
      ownerId: fixture.ownerId,
      ownerName: fixture.ownerName,
      remark: fixture.tag
    }), '历史状态研发项目')
    const legacy = await getBusiness(api, `/plm/rdm/project/ledger/get?id=${legacyId}`)
    addCheck(
      caseRecord,
      '历史 EXECUTING 状态项目仍可读取且不被新状态机破坏',
      legacy?.status === 'EXECUTING',
      JSON.stringify({ status: legacy?.status })
    )
    await assertRdmPage({
      api, caseRecord, id: projectId, label: '研发项目',
      path: '/plm/rdm/project/ledger/page?pageNo=1&pageSize=100',
      fields: ['status']
    })
    const rows = await readDatabase(caseRecord, 'RDM-003 projects', `
      SELECT id,project_no,status,current_stage_code,current_stage_name
      FROM plm_rdm_project
      WHERE tenant_id=1 AND id IN (${asNumberId(projectId)},${asNumberId(legacyId)},${asNumberId(cancelledId)})
      ORDER BY id
    `)
    addCheck(caseRecord, 'plm_rdm_project 数据库证据确认两个终态和历史状态', rows.length === 3 &&
      rows.some((row) => row[0] === projectId && row[2] === 'CLOSED') &&
      rows.some((row) => row[0] === cancelledId && row[2] === 'CANCELLED') &&
      rows.some((row) => row[0] === legacyId && row[2] === 'EXECUTING'),
    JSON.stringify({ rows: rows.length }))
    for (const [id, status] of [[projectId, 'CLOSED'], [cancelledId, 'CANCELLED']]) {
      try {
        await expectBusinessFailure({
          api, method: 'POST', path: '/plm/rdm/project/ledger/transition-status',
          body: { projectId: id, targetStatus: 'RUNNING', remark: fixture.tag },
          caseRecord, expectedPaths, expectedCode: 2003005006,
          name: `研发项目 ${status} 终态禁止重新执行并返回 RDM_PROJECT_STATUS_INVALID`
        })
      } catch (error) {
        // Keep the failed assertion while collecting independent terminal-state evidence.
        caseRecord.notes.push(String(error.message).slice(0, 600))
      }
      const after = await getBusiness(api, `/plm/rdm/project/ledger/get?id=${id}`)
      addCheck(caseRecord, `非法流转后 ${status} 状态未改变`, after?.status === status)
    }
    await readDatabase(caseRecord, 'RDM-003 after invalid transitions', `
      SELECT id,status FROM plm_rdm_project
      WHERE tenant_id=1 AND id IN (${projectId},${cancelledId},${legacyId})
      ORDER BY id
    `)
    addEvidence(caseRecord, 'RDM003：研发项目创建、六状态合法流转、终态保护、历史 EXECUTING 兼容、API+SQL')
    return { allowRuntimeErrors: { api: ({ url }) => [...expectedPaths].some((path) => url.includes(path)) } }
  }

  if (caseId === 'RDM-004') {
    const { projectId } = await createPmProject({ api, fixture, caseRecord })
    const { iterationId, snapshotId, snapshot } = await createIteration({
      api,
      fixture,
      projectId,
      caseRecord
    })
    const baseChange = {
      projectId,
      iterationId,
      scopeSnapshotId: snapshotId,
      title: `${fixture.tag}-change`,
      changeType: 'MODIFY',
      reason: fixture.tag,
      impactScope: fixture.tag,
      impactTest: `${fixture.tag}-test`,
      impactMaterial: `${fixture.tag}-material`,
      impactDelivery: `${fixture.tag}-delivery`,
      impactCost: `${fixture.tag}-cost`,
      baselineType: 'ITERATION',
      requesterId: fixture.ownerId,
      requesterName: fixture.ownerName,
      targetScopeJson: JSON.stringify({ items: [`${fixture.tag}-scope-v2`] }),
      fieldChanges: [{
        changeType: 'MODIFY',
        fieldName: 'scope',
        oldValue: `${fixture.tag}-scope-v1`,
        newValue: `${fixture.tag}-scope-v2`
      }]
    }
    for (const missing of ['impactTest', 'impactMaterial', 'impactDelivery', 'impactCost']) {
      const body = { ...baseChange }
      delete body[missing]
      await expectBusinessFailure({
        api,
        method: 'POST',
        path: '/pm/change/save',
        body,
        caseRecord,
        expectedPaths,
        name: `版本范围变更缺少 ${missing} 时拒绝创建`
      })
    }
    const changeId = asNumberId(await postBusiness(api, '/pm/change/save', baseChange), '版本范围变更')
    const before = await getBusiness(api, `/pm/change/get?id=${changeId}`)
    addCheck(
      caseRecord,
      '版本范围变更创建后保留迭代、四类影响和目标范围',
      String(before?.iterationId) === String(iterationId) &&
        before?.targetScopeJson &&
        ['impactTest', 'impactMaterial', 'impactDelivery', 'impactCost'].every((key) => before?.[key]),
      JSON.stringify({
        iterationId: before?.iterationId,
        hasTargetScope: Boolean(before?.targetScopeJson),
        impactFields: ['impactTest', 'impactMaterial', 'impactDelivery', 'impactCost']
          .filter((key) => Boolean(before?.[key])).length
      })
    )
    await putBusiness(api, '/pm/change/status', { id: changeId, status: 'ASSESSING' })
    await putBusiness(api, '/pm/change/status', { id: changeId, status: 'PENDING_APPROVAL' })
    await putBusiness(api, '/pm/change/status', {
      id: changeId,
      status: 'APPROVED',
      approvalOpinion: `${fixture.tag}-approved`,
      // PB-949：审批通过必须冻结变更对象版本并确定下游执行策略。
      objectVersion: Number(before?.objectVersion ?? 1),
      downstreamStrategy: 'MANUAL'
    })
    const after = await getBusiness(api, `/pm/change/get?id=${changeId}`)
    const approvedSnapshotId = asNumberId(after?.approvedSnapshotId, '审批后范围快照')
    const approvedSnapshot = await getBusiness(api, `/pm/iteration/scope-snapshot/get?id=${approvedSnapshotId}`)
    const originalSnapshot = await getBusiness(api, `/pm/iteration/scope-snapshot/get?id=${snapshotId}`)
    addCheck(
      caseRecord,
      '变更审批通过新增 LOCKED 范围快照且历史快照未覆盖',
      after?.status === 'APPROVED' &&
        approvedSnapshotId !== snapshotId &&
        approvedSnapshot?.status === 'LOCKED' &&
        originalSnapshot?.scopeJson === snapshot?.scopeJson &&
        approvedSnapshot?.scopeJson !== originalSnapshot?.scopeJson,
      JSON.stringify({
        changeStatus: after?.status,
        originalSnapshotId: snapshotId,
        approvedSnapshotId,
        originalStatus: originalSnapshot?.status,
        approvedStatus: approvedSnapshot?.status
      })
    )
    await assertRdmPage({
      api, caseRecord, id: changeId, label: '版本范围变更',
      path: `/pm/change/page?pageNo=1&pageSize=100&projectId=${projectId}`,
      fields: ['iterationId', 'targetScopeJson', 'impactTest', 'impactMaterial', 'impactDelivery', 'impactCost', 'approvedSnapshotId']
    })
    await expectBusinessFailure({
      api, method: 'POST', path: '/pm/iteration/scope-snapshot/save',
      body: { id: snapshotId, iterationId, projectId, scopeJson: JSON.stringify({ items: [fixture.tag] }) },
      caseRecord, expectedPaths, name: '历史 LOCKED 快照拒绝覆盖'
    })
    const rows = await readDatabase(caseRecord, 'RDM-004 change and snapshots', `
      SELECT id,status,iteration_id,scope_snapshot_id,approved_snapshot_id,target_scope_json
      FROM pm_project_change
      WHERE tenant_id=1 AND id=${asNumberId(changeId)};
      SELECT id,status,iteration_id,snapshot_no,scope_json
      FROM pm_iteration_scope_snapshot
      WHERE tenant_id=1 AND iteration_id=${asNumberId(iterationId)}
      ORDER BY snapshot_no
    `)
    addCheck(caseRecord, 'pm_project_change 与 pm_iteration_scope_snapshot 数据库证据完整', rows.length >= 3 &&
      rows.some((row) => row[0] === changeId && row[1] === 'APPROVED' && row[4] === approvedSnapshotId) &&
      rows.filter((row) => row[1] === 'LOCKED').length >= 2,
    JSON.stringify({ rows: rows.length }))
    addEvidence(caseRecord, 'RDM004：迭代锁定、四类影响缺失拒绝、变更审批新增快照、历史保护、API+SQL')
    return { allowRuntimeErrors: { api: ({ url }) => [...expectedPaths].some((path) => url.includes(path)) } }
  }

  if (caseId === 'RDM-005') {
    const plmProjectId = await createPlmProject({ api, fixture })
    const units = await getBusiness(api, '/mes/basUnit/list/enabled')
    const unit = Array.isArray(units) ? units.find((item) => item?.id && item?.name) : null
    if (!unit) throw new Error('BLOCKED: 没有正式启用的计量单位')
    const parentMaterial = await createRdmMaterial({ api, fixture, caseRecord, suffix: 'PARENT', unit })
    const componentMaterial = await createRdmMaterial({ api, fixture, caseRecord, suffix: 'COMPONENT', unit })
    const parentPartId = asNumberId(await postBusiness(api, '/plm/core/part/create', {
      partNo: `${fixture.tag}-PARENT`,
      partName: `${fixture.tag}-parent`,
      partType: 'PRODUCT',
      unit: unit.name,
      materialId: parentMaterial.id,
      materialCode: parentMaterial.code,
      materialName: parentMaterial.name,
      lifecycleStatus: 'DRAFT',
      remark: fixture.tag
    }), 'EBOM父件')
    const componentPartId = asNumberId(await postBusiness(api, '/plm/core/part/create', {
      partNo: `${fixture.tag}-COMP`,
      partName: `${fixture.tag}-component`,
      partType: 'MATERIAL',
      unit: unit.name,
      materialId: componentMaterial.id,
      materialCode: componentMaterial.code,
      materialName: componentMaterial.name,
      lifecycleStatus: 'DRAFT',
      remark: fixture.tag
    }), 'EBOM子件')
    const parentRevisionNo = `${rdmMaterialCode(fixture.tag, 'PARENT')}-R1`
    const componentRevisionNo = `${rdmMaterialCode(fixture.tag, 'COMPONENT')}-R1`
    const parentRevisionId = asNumberId(await postBusiness(api, '/plm/core/part/revision/create', {
      partId: parentPartId,
      revisionNo: parentRevisionNo,
      iterationNo: 1,
      description: fixture.tag
    }), 'EBOM父件版本')
    const componentRevisionId = asNumberId(await postBusiness(api, '/plm/core/part/revision/create', {
      partId: componentPartId,
      revisionNo: componentRevisionNo,
      iterationNo: 1,
      description: fixture.tag
    }), 'EBOM子件版本')
    const lineBody = {
      ebomId: parentRevisionId,
      parentPartRevisionId: parentRevisionId,
      componentPartId,
      componentRevisionId,
      lineNo: 1,
      partCode: `${fixture.tag}-COMP`,
      partName: `${fixture.tag}-component`,
      partVersion: componentRevisionNo,
      quantity: 1,
      unit: unit.name,
      approvalStatus: 'PENDING',
      remark: fixture.tag
    }
    const lineId = asNumberId(await postBusiness(api, '/plm/core/ebom/save-line', lineBody), 'EBOM行')
    const pendingTree = await getBusiness(api, `/plm/core/ebom/tree?ebomId=${parentRevisionId}`)
    addCheck(
      caseRecord,
      'EBOM 树行创建后返回待审批、生效和失效字段',
      Array.isArray(pendingTree) && pendingTree.some((row) =>
        String(row.id) === lineId &&
        Object.hasOwn(row, 'approvalStatus') &&
        Object.hasOwn(row, 'effectiveDate') &&
        Object.hasOwn(row, 'expiryDate')
      ),
      JSON.stringify({ lineId, treeCount: Array.isArray(pendingTree) ? pendingTree.length : 0 })
    )
    await assertRdmPage({
      api, caseRecord, id: parentRevisionId, label: 'EBOM版本',
      path: `/plm/core/ebom/page?pageNo=1&pageSize=100&ebomId=${parentRevisionId}`,
      fields: ['approvalStatus', 'effectiveDate', 'expiryDate']
    })
    await expectBusinessFailure({
      api,
      method: 'POST',
      path: '/plm/core/ebom/save-line',
      body: { ...lineBody, id: lineId, approvalStatus: 'APPROVED' },
      caseRecord,
      expectedPaths,
      name: 'EBOM 行审批通过但缺少生效日期时拒绝'
    })
    const previewBlocked = await postBusiness(api, '/plm/core/ebom/preview-production-bom', {
      ebomId: parentRevisionId,
      parentPartRevisionId: parentRevisionId,
      dryRun: true,
      operatorName: fixture.tag
    })
    addCheck(
      caseRecord,
      '未审批 EBOM 行在生产 BOM 预览中形成阻塞项',
      previewBlocked?.canRelease === false &&
        Array.isArray(previewBlocked?.blocks) &&
        previewBlocked.blocks.some((block) => /未审批/.test(block?.reason || '') &&
          String(block.objectId) === lineId),
      JSON.stringify({
        canRelease: previewBlocked?.canRelease,
        blockCount: previewBlocked?.blockCount,
        blockReasons: (previewBlocked?.blocks || []).map((block) => block?.reason).slice(0, 5)
      })
    )
    await postBusiness(api, '/plm/core/ebom/save-line', {
      ...lineBody, id: lineId, approvalStatus: 'APPROVED', effectiveDate: today(3)
    })
    const previewFuture = await postBusiness(api, '/plm/core/ebom/preview-production-bom', {
      ebomId: parentRevisionId, dryRun: true, operatorName: fixture.tag
    })
    addCheck(caseRecord, '已审批但尚未生效的 EBOM 行单独形成生效阻塞',
      previewFuture?.canRelease === false &&
        previewFuture?.blocks?.some((block) => /未到生效/.test(block.reason) && String(block.objectId) === lineId),
      JSON.stringify({ reasons: previewFuture?.blocks?.map((block) => block.reason) }))
    await postBusiness(api, '/plm/core/ebom/save-line', {
      ...lineBody,
      id: lineId,
      approvalStatus: 'APPROVED',
      effectiveDate: today(-1),
      approvedBy: fixture.ownerName
    })
    const approvedTree = await getBusiness(api, `/plm/core/ebom/tree?ebomId=${parentRevisionId}`)
    addCheck(
      caseRecord,
      'EBOM 行批准后写入 APPROVED 和有效日期',
      approvedTree.some((row) => String(row.id) === lineId &&
        row.approvalStatus === 'APPROVED' && row.effectiveDate),
      JSON.stringify({ lineId, approved: approvedTree.find((row) => String(row.id) === lineId)?.approvalStatus })
    )
    const previewApproved = await postBusiness(api, '/plm/core/ebom/preview-production-bom', {
      ebomId: parentRevisionId, dryRun: true, operatorName: fixture.tag
    })
    addCheck(caseRecord, '专属物料映射且行审批生效后生产 BOM 预览放行',
      previewApproved?.canRelease === true && previewApproved?.blockCount === 0 &&
        previewApproved?.released === false && previewApproved?.dryRun === true &&
        previewApproved?.lines?.some((line) => String(line.ebomLineId) === lineId && line.releasable === true),
      JSON.stringify({ canRelease: previewApproved?.canRelease, blockCount: previewApproved?.blockCount,
        released: previewApproved?.released, dryRun: previewApproved?.dryRun }))
    const experimentId = asNumberId(await postBusiness(api, '/plm/rdm/record/create', {
      bizType: 'EXPERIMENT',
      bizNo: `${fixture.tag}-EXP`,
      bizName: `${fixture.tag}-experiment`,
      projectId: plmProjectId,
      versionNo: `${fixture.tag}-BATCH`,
      status: 'PENDING',
      ownerId: fixture.ownerId,
      ownerName: fixture.ownerName,
      remark: fixture.tag
    }), '试制实验计划')
    const experiment = await getBusiness(api, `/plm/rdm/record/get?id=${experimentId}&bizType=EXPERIMENT`)
    const runRows = await readDatabase(caseRecord, 'RDM-005 experiment run', `
      SELECT id,plan_id,project_id,status
      FROM plm_rdm_experiment_run
      WHERE tenant_id=1 AND plan_id=${asNumberId(experimentId)}
      ORDER BY id DESC
      LIMIT 1
    `)
    const runRow = firstRow(runRows)
    const runId = asNumberId(runRow[0], '试制执行批次')
    addCheck(
      caseRecord,
      '实验计划创建后由 plm_rdm_experiment_run 返回真实批次ID',
      runRows.length === 1 &&
        String(runRow[1]) === String(experimentId) &&
        String(runRow[2]) === String(plmProjectId),
      JSON.stringify({
        experimentId,
        runId,
        planId: runRow[1] ?? null,
        projectId: runRow[2] ?? null,
        status: runRow[3] ?? null,
        apiRunId: experiment?.runId ?? null
      })
    )
    const approvalId = asNumberId(await postBusiness(api, '/plm/rdm/record/create', {
      bizType: 'APPROVAL',
      bizNo: `${fixture.tag}-REQ`,
      bizName: `${fixture.tag}-material-requisition`,
      projectId: plmProjectId,
      planId: experimentId,
      runId,
      status: 'DRAFT',
      ownerId: fixture.ownerId,
      ownerName: fixture.ownerName,
      remark: fixture.tag,
      items: [{
        itemType: 'MATERIAL',
        itemCode: componentMaterial.id,
        itemName: `${fixture.tag}-material`,
        itemValue: `${fixture.tag}-BATCH`,
        numericValue: 1,
        expectedValue: 1,
        unitName: unit.name,
        extraJson: JSON.stringify({ source: fixture.tag })
      }]
    }), '试制领料申请')
    const approval = await getBusiness(api, `/plm/rdm/record/get?id=${approvalId}&bizType=APPROVAL`)
    addCheck(
      caseRecord,
      '试制领料记录通过 API 关联同一 planId/runId',
      String(approval?.planId) === String(experimentId) &&
        String(approval?.runId) === String(runId),
      JSON.stringify({ planId: approval?.planId, runId: approval?.runId })
    )
    await assertRdmPage({
      api, caseRecord, id: approvalId, label: '试制领料',
      path: `/plm/rdm/record/page?bizTypes=APPROVAL&pageNo=1&pageSize=100&projectId=${plmProjectId}`,
      fields: ['planId', 'runId']
    })
    const rows = await readDatabase(caseRecord, 'RDM-005 EBOM and trial batch', `
      SELECT id,parent_part_revision_id,component_part_id,approval_status,effective_date,expiry_date
      FROM plm_core_ebom_line
      WHERE tenant_id=1 AND id=${asNumberId(lineId)};
      SELECT id,plan_id,project_id,status
      FROM plm_rdm_experiment_run
      WHERE tenant_id=1 AND id=${asNumberId(runId)};
      SELECT id,plan_id,run_id,status
      FROM plm_rdm_material_requisition
      WHERE tenant_id=1 AND id=${asNumberId(approvalId)}
    `)
    addCheck(caseRecord, 'RDM005 三张事实表数据库证据关联一致', rows.length >= 3 &&
      rows.some((row) => row[0] === lineId && row[3] === 'APPROVED') &&
      rows.some((row) => row[0] === runId && row[1] === experimentId) &&
      rows.some((row) => row[0] === approvalId && row[1] === experimentId && row[2] === runId),
    JSON.stringify({ rows: rows.length }))
    await expectBusinessFailure({
      api, method: 'POST', path: '/plm/rdm/record/create',
      body: { bizType: 'APPROVAL', bizName: `${fixture.tag}-missing-batch`, projectId: plmProjectId },
      caseRecord, expectedPaths, name: '试制领料未关联计划或批次时拒绝创建',
      expectedCode: 2003005007, expectedMessage: /试制批次/
    })
    caseRecord.notes.push('生产 BOM 放行仅验证正式 dry-run 预览，不写生产 BOM，也不伪造 MES/WMS 领料库存回写。')
    addEvidence(caseRecord, 'RDM005：专属物料与 EBOM 创建、审批及生效阻塞、生产预览放行、试制计划真实批次、领料关联、API+SQL')
    return { allowRuntimeErrors: { api: ({ url }) => [...expectedPaths].some((path) => url.includes(path)) } }
  }

  if (caseId === 'RDM-006') {
    const { projectId } = await createPmProject({ api, fixture, caseRecord })
    const { iterationId } = await createIteration({ api, fixture, projectId, caseRecord })
    const requirementId = await createRequirement({
      api,
      fixture,
      projectId,
      iterationId,
      title: `${fixture.tag}-release-requirement`
    })
    const releaseId = asNumberId(await postBusiness(api, '/pm/release/save', {
      projectId,
      iterationId,
      versionNo: `${fixture.tag}-V1`,
      releaseName: `${fixture.tag}-release`,
      sourceType: 'ITERATION',
      sourceId: iterationId,
      releaseNotes: fixture.tag,
      verificationConclusion: '',
      applicantId: fixture.ownerId,
      applicantName: fixture.ownerName
    }), '发布单')
    const initialGate = await getBusiness(api, `/pm/release/gate?id=${releaseId}`)
    addCheck(
      caseRecord,
      '发布初始门禁返回真实阻塞原因数组和四类字段',
      initialGate?.passed === false &&
        Array.isArray(initialGate?.blockReasons) &&
        Object.hasOwn(initialGate, 'requirementCoverage') &&
        Object.hasOwn(initialGate, 'criticalBugOpenCount') &&
        Object.hasOwn(initialGate, 'verificationConclusion') &&
        Object.hasOwn(initialGate, 'artifactFrozen'),
      JSON.stringify({
        passed: initialGate?.passed,
        blockReasons: initialGate?.blockReasons,
        requirementCoverage: initialGate?.requirementCoverage
      })
    )
    addCheck(caseRecord, '需求未完成及验证结论缺失各自返回明确门禁原因',
      Number(initialGate?.requirementCoverage) === 0 &&
        initialGate?.blockReasons?.some((reason) => /需求覆盖/.test(reason)) &&
        initialGate?.blockReasons?.some((reason) => /验证结论未填写/.test(reason)),
      JSON.stringify({ blockReasons: initialGate?.blockReasons }))
    await putBusiness(api, '/pm/release/status', {
      id: releaseId, status: 'PENDING_APPROVAL', operatorId: fixture.ownerId,
      operatorName: fixture.ownerName, opinion: `${fixture.tag}-blocked-attempt`
    })
    await expectBusinessFailure({
      api, method: 'PUT', path: '/pm/release/status',
      body: { id: releaseId, status: 'PENDING_RELEASE', operatorId: fixture.ownerId,
        operatorName: fixture.ownerName, opinion: `${fixture.tag}-blocked-attempt` },
      caseRecord, expectedPaths, name: '需求未完成和验证结论缺失时正式放行拒绝',
      expectedMessage: /需求覆盖|验证结论/
    })
    const blockedRelease = await getBusiness(api, `/pm/release/get?id=${releaseId}`)
    addCheck(caseRecord, '门禁拒绝后发布单未冻结、未变更为待发布',
      blockedRelease?.status === 'PENDING_APPROVAL' &&
        blockedRelease?.artifactFrozen !== true && !blockedRelease?.artifactHash)
    await putBusiness(api, '/pm/release/status', { id: releaseId, status: 'REJECTED', opinion: fixture.tag })
    await putBusiness(api, '/pm/release/status', { id: releaseId, status: 'DRAFT', opinion: fixture.tag })
    const packageId = asNumberId(await postBusiness(api, '/pm/release/package/save', {
      releaseId,
      packageName: `${fixture.tag}.zip`,
      packageUri: `e2e://${fixture.tag}/package`,
      checksum: `${fixture.tag}-checksum`,
      packageType: 'TEST'
    }), '发布包')
    const backupId = asNumberId(await postBusiness(api, '/pm/release/backup/save', {
      releaseId,
      backupType: 'DATABASE',
      backupUri: `e2e://${fixture.tag}/backup`,
      verified: true,
      verifiedBy: fixture.ownerId
    }), '发布备份')
    const rollbackId = asNumberId(await postBusiness(api, '/pm/release/rollback/save', {
      releaseId,
      rollbackPlan: `${fixture.tag}-rollback`,
      detail: fixture.tag
    }), '回退方案')
    await postBusiness(api, '/pm/release/cutover-record/save', {
      releaseId,
      environment: 'TEST',
      plannedTime: `${today()}T10:00:00`
    })
    const bugId = asNumberId(await postBusiness(api, '/pm/bug/save', {
      projectId,
      title: `${fixture.tag}-critical-bug`,
      description: fixture.tag,
      severity: 'HIGH',
      priority: 1,
      reporterId: fixture.ownerId,
      reporterName: fixture.ownerName,
      assigneeId: fixture.ownerId,
      assigneeName: fixture.ownerName,
      sourceType: RDM_PREFIX
    }), '关键缺陷')
    const beforeDefer = await getBusiness(api, `/pm/bug/get?id=${bugId}`)
    await completeRequirement({ api, id: requirementId })
    const criticalGate = await getBusiness(api, `/pm/release/gate?id=${releaseId}`)
    addCheck(caseRecord, '需求完成后覆盖率100但关键缺陷未关闭时门禁仍阻塞',
      criticalGate?.passed === false && Number(criticalGate?.requirementCoverage) === 100 &&
        criticalGate?.criticalBugOpenCount === 1 &&
        criticalGate?.blockReasons?.some((reason) => /关键.*缺陷未关闭/.test(reason)) &&
        criticalGate?.blockReasons?.some((reason) => /验证结论未填写/.test(reason)),
      JSON.stringify({ requirementCoverage: criticalGate?.requirementCoverage,
        criticalBugOpenCount: criticalGate?.criticalBugOpenCount, blockReasons: criticalGate?.blockReasons }))
    await expectBusinessFailure({
      api,
      method: 'PUT',
      path: '/pm/bug/status',
      body: { id: bugId, status: 'DEFERRED' },
      caseRecord,
      expectedPaths,
      name: '关键缺陷延期缺少风险说明时拒绝'
    })
    await putBusiness(api, '/pm/bug/status', {
      id: bugId,
      status: 'DEFERRED',
      deferReason: `${fixture.tag}-risk`
    })
    const deferred = await getBusiness(api, `/pm/bug/get?id=${bugId}`)
    await putBusiness(api, '/pm/bug/status', { id: bugId, status: 'IN_PROGRESS' })
    const resumedBug = await getBusiness(api, `/pm/bug/get?id=${bugId}`)
    addCheck(
      caseRecord,
      '缺陷延期写入风险说明且恢复处理后清空当前延期说明',
      deferred?.status === 'DEFERRED' && deferred?.deferReason === `${fixture.tag}-risk` &&
        resumedBug?.status === 'IN_PROGRESS' &&
        (resumedBug?.deferReason === null || resumedBug?.deferReason === ''),
      JSON.stringify({
        before: beforeDefer?.status,
        deferred: deferred?.deferReason,
        resumed: resumedBug?.deferReason
      })
    )
    await putBusiness(api, '/pm/bug/status', {
      id: bugId,
      status: 'FIXED',
      resolution: `${fixture.tag}-fixed`,
      fixedVersion: `${fixture.tag}-V1`
    })
    await putBusiness(api, '/pm/bug/status', {
      id: bugId,
      status: 'VERIFIED',
      resolution: `${fixture.tag}-verified`
    })
    await putBusiness(api, '/pm/bug/status', { id: bugId, status: 'CLOSED' })
    const closedBug = await getBusiness(api, `/pm/bug/get?id=${bugId}`)
    addCheck(caseRecord, '关键缺陷完成 FIXED -> VERIFIED -> CLOSED 闭环', closedBug?.status === 'CLOSED' &&
      (closedBug?.deferReason === null || closedBug?.deferReason === ''), JSON.stringify({ status: closedBug?.status }))
    const verificationGate = await getBusiness(api, `/pm/release/gate?id=${releaseId}`)
    addCheck(caseRecord, '需求100且关键缺陷为0后仍独立阻塞缺验证结论',
      verificationGate?.passed === false &&
        Number(verificationGate?.requirementCoverage) === 100 &&
        verificationGate?.criticalBugOpenCount === 0 &&
        verificationGate?.blockReasons?.length === 1 &&
        /验证结论未填写/.test(verificationGate.blockReasons[0]),
      JSON.stringify({ blockReasons: verificationGate?.blockReasons }))
    await postBusiness(api, '/pm/release/save', {
      id: releaseId,
      projectId,
      iterationId,
      versionNo: `${fixture.tag}-V1`,
      releaseName: `${fixture.tag}-release`,
      sourceType: 'ITERATION',
      sourceId: iterationId,
      releaseNotes: `${fixture.tag}-verified`,
      verificationConclusion: `${fixture.tag}-verification-pass`,
      applicantId: fixture.ownerId,
      applicantName: fixture.ownerName
    })
    const passedGate = await getBusiness(api, `/pm/release/gate?id=${releaseId}`)
    addCheck(
      caseRecord,
      '需求完成、关键缺陷关闭和资料登记后发布门禁通过',
      passedGate?.passed === true &&
        passedGate?.criticalBugOpenCount === 0 &&
        Number(passedGate?.requirementCoverage) === 100,
      JSON.stringify({
        passed: passedGate?.passed,
        criticalBugOpenCount: passedGate?.criticalBugOpenCount,
        requirementCoverage: passedGate?.requirementCoverage
      })
    )
    await putBusiness(api, '/pm/release/status', {
      id: releaseId,
      status: 'PENDING_APPROVAL',
      operatorId: fixture.ownerId,
      operatorName: fixture.ownerName,
      opinion: `${fixture.tag}-approval`
    })
    await putBusiness(api, '/pm/release/status', {
      id: releaseId,
      status: 'PENDING_RELEASE',
      operatorId: fixture.ownerId,
      operatorName: fixture.ownerName,
      opinion: `${fixture.tag}-release`
    })
    const frozen = await getBusiness(api, `/pm/release/get?id=${releaseId}`)
    addCheck(
      caseRecord,
      '发布放行写入冻结标识和非空指纹',
      frozen?.status === 'PENDING_RELEASE' &&
        frozen?.artifactFrozen === true &&
        Boolean(frozen?.artifactHash) &&
        frozen?.gateCheckedTime,
      JSON.stringify({
        status: frozen?.status,
        artifactFrozen: frozen?.artifactFrozen,
        hasHash: Boolean(frozen?.artifactHash)
      })
    )
    await assertRdmPage({
      api, caseRecord, id: releaseId, label: '发布单',
      path: `/pm/release/page?pageNo=1&pageSize=100&projectId=${projectId}`,
      fields: ['requirementCoverage', 'criticalBugOpenCount', 'verificationConclusion', 'artifactFrozen', 'artifactHash']
    })
    await expectBusinessFailure({
      api,
      method: 'POST',
      path: '/pm/release/save',
      body: {
        id: releaseId,
        projectId,
        iterationId,
        versionNo: `${fixture.tag}-V1`,
        releaseName: `${fixture.tag}-release`,
        sourceType: 'ITERATION',
        sourceId: iterationId,
        releaseNotes: `${fixture.tag}-mutated`,
        verificationConclusion: `${fixture.tag}-verification-pass`,
        applicantId: fixture.ownerId,
        applicantName: fixture.ownerName
      },
      caseRecord,
      expectedPaths,
      name: '发布资料冻结后拒绝修改发布单'
    })
    await expectBusinessFailure({
      api,
      method: 'POST',
      path: '/pm/release/package/save',
      body: { id: packageId, releaseId, packageName: `${fixture.tag}-changed.zip`, packageUri: `e2e://${fixture.tag}/changed` },
      caseRecord,
      expectedPaths,
      name: '冻结后拒绝修改发布包'
    })
    await expectBusinessFailure({
      api,
      method: 'POST',
      path: '/pm/release/backup/save',
      body: { id: backupId, releaseId, backupType: 'DATABASE', backupUri: `e2e://${fixture.tag}/changed`, verified: true, verifiedBy: fixture.ownerId },
      caseRecord,
      expectedPaths,
      name: '冻结后拒绝修改已验证备份'
    })
    await expectBusinessFailure({
      api,
      method: 'POST',
      path: '/pm/release/rollback/save',
      body: { id: rollbackId, releaseId, rollbackPlan: `${fixture.tag}-changed` },
      caseRecord,
      expectedPaths,
      name: '冻结后拒绝修改回退方案'
    })
    const immutable = await getBusiness(api, `/pm/release/get?id=${releaseId}`)
    const immutableGate = await getBusiness(api, `/pm/release/gate?id=${releaseId}`)
    addCheck(caseRecord, '四类修改被拒绝后发布资料指纹保持一致',
      immutable?.artifactHash === frozen?.artifactHash &&
        immutable?.artifactFrozen === true &&
        immutableGate?.artifactHash === frozen?.artifactHash)
    const rows = await readDatabase(caseRecord, 'RDM-006 release and bug', `
      SELECT id,status,requirement_coverage,critical_bug_open_count,verification_conclusion,artifact_frozen,artifact_hash
      FROM pm_release
      WHERE tenant_id=1 AND id=${asNumberId(releaseId)};
      SELECT id,status,COALESCE(defer_reason,''),resolution
      FROM pm_project_bug
      WHERE tenant_id=1 AND id=${asNumberId(bugId)}
    `)
    addCheck(caseRecord, 'pm_release 与 pm_project_bug 数据库证据确认冻结指纹和缺陷闭环', rows.length >= 2 &&
      rows.some((row) => row[0] === releaseId && row[1] === 'PENDING_RELEASE' &&
        // MySQL bit(1) columns surface as a raw control byte rather than "1".
        isTruthyBit(row[5]) && row[6]) &&
      rows.some((row) => row[0] === bugId && row[1] === 'CLOSED' && (row[2] === '' || row[2] === null)),
    JSON.stringify({ rows: rows.length }))
    addEvidence(caseRecord, 'RDM006：真实发布门禁阻塞/放行、关键缺陷延期闭环、冻结指纹、冻结后四类修改拒绝、API+SQL')
    return { allowRuntimeErrors: { api: ({ url }) => [...expectedPaths].some((path) => url.includes(path)) } }
  }

  return { partial: false }
}
