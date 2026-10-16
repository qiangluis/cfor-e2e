import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'

const definitions = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  .suites.find((suite) => suite.id === 'project-after-sales').cases

export const PROJECT_AFTER_SALES_CATALOG_ASSERTIONS = Object.freeze(Object.fromEntries(
  definitions.map((item) => [item.id, Object.freeze([...(item.assertions || [])])])
))

export const ORIGINAL_PROJECT_ACCEPTANCE_GAPS = Object.freeze(Object.fromEntries(
  definitions.map((item) => [item.id, Object.freeze([...(item.acceptanceGaps || [])])])
))

export const PROJECT_AFTER_SALES_SAFETY_BLOCKS = Object.freeze({
  'PB123-001': '知识索引 worker 从全局待处理队列领取任务；禁止 executeIgnore 或手动启动全局 worker。',
  'PB124-001': '自动提醒扫描遍历全部启用规则和租户对象，尚无专属对象白名单；禁止全量扫描。',
  'PB126-001': '上一轮写入租户单例共享 AI 策略 2107051150215401473，虽记录恢复原值仍属共享写；本轮禁止再次写入。'
})

const ownedFixtures = new WeakSet()
const unwrap = (response, label) => assertBusinessSuccess(response, label).data
const resourceId = (value) => {
  assert.match(String(value ?? ''), /^[1-9]\d*$/, 'Missing owned resource ID')
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value), 'Lossy owned resource ID')
  return String(value)
}
const requireFixture = (fixture) => {
  assert.ok(ownedFixtures.has(fixture), 'Only a fixture created in this run is writable')
}

export const assertPmClosureLocalTarget = (target = config, write = process.env.CFOR_E2E_WRITE_FIXTURES) => {
  assert.equal(target.target, 'local', 'PM closure only allows the local target')
  assert.equal(String(target.tenantId), '1', 'PM closure only allows tenant 1')
  assert.equal(write, 'true', 'PM closure requires explicit fixture write approval')
  for (const [base, port] of [[target.apiBase, '48083'], [target.webBase, '9151']]) {
    const url = new URL(base)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Loopback required')
    assert.equal(url.port, port, 'PM closure local port mismatch')
  }
}

export const newPmClosureFixture = (caseId) => {
  assert.ok(['PB112-001', 'PB113-001', 'PB114-001', 'PB116-001'].includes(caseId))
  const fixture = {
    caseId,
    marker: `E2E_${caseId.slice(0, 5)}_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
    employee: null,
    skill: null,
    configs: []
  }
  ownedFixtures.add(fixture)
  return fixture
}

export const pmClosureTaskDate = (project, workingDate) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workingDate) ||
      (project.plannedStartDate && workingDate < project.plannedStartDate) ||
      (project.plannedEndDate && workingDate > project.plannedEndDate)) {
    throw new Error('BLOCKED: 专属项目原计划窗口内没有可用 HRM 工作日，禁止修改下游日期')
  }
  return workingDate
}

export const pmClosureDelayAdvanceDays = (plannedEndDate, today) => {
  const end = Date.parse(`${plannedEndDate}T00:00:00Z`)
  const start = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(end) || !Number.isFinite(start)) {
    throw new Error('BLOCKED: 专属预警项目缺少有效计划结束日；正式项目更新沿用 NOT_NULL，无法保证恢复原始空日期，禁止临时写入计划窗口')
  }
  return Math.max(0, Math.ceil((end - start) / 86400000))
}

export const assertPb951GatePrerequisites = ({
  fixture, project, milestone, milestoneId, milestoneName, workingDate, workingDay,
  manualConclusion, missingField
}) => {
  assert.match(String(fixture?.projectId ?? ''), /^[1-9]\d*$/, 'Owned project ID required')
  assert.match(String(fixture?.handoverId ?? ''), /^[1-9]\d*$/, 'Owned handover ID required')
  assert.ok(fixture?.marker, 'Owned project marker required')
  assert.equal(String(project?.id), fixture.projectId, 'Project ownership mismatch')
  assert.equal(String(project?.handoverId), fixture.handoverId, 'Project handover mismatch')
  assert.equal(project?.customerNameSnapshot, fixture.marker, 'Project marker mismatch')
  assert.ok(!['CLOSED', 'TERMINATED'].includes(project?.status), 'Project must be writable')
  assert.equal(String(milestone?.id), String(milestoneId), 'Milestone ID mismatch')
  assert.equal(String(milestone?.projectId), fixture.projectId, 'Milestone project mismatch')
  assert.ok(milestoneName.startsWith(fixture.marker), 'Milestone marker required')
  assert.equal(milestone?.milestoneName, milestoneName, 'Milestone ownership mismatch')
  assert.equal(String(milestone?.ownerId), String(fixture.ownerId), 'Milestone owner mismatch')
  assert.equal(milestone?.confirmed, true, 'Milestone must be confirmed before testing gates')
  assert.equal(milestone?.status, 'NOT_STARTED', 'Milestone must not already be completed')
  assert.equal(workingDay, true, 'An actual HRM working day is required')
  assert.equal(pmClosureTaskDate(project, workingDate), workingDate)
  assert.equal(milestone?.plannedStartDate, workingDate, 'Milestone start date mismatch')
  assert.equal(milestone?.plannedEndDate, workingDate, 'Milestone end date mismatch')
  assert.ok(typeof manualConclusion === 'string' && manualConclusion.trim(),
    'Manual conclusion must be present so it cannot explain the rejection')
  assert.ok(['exitCondition', 'requiredDeliverablesJson'].includes(missingField))
  const presentField = missingField === 'exitCondition' ? 'requiredDeliverablesJson' : 'exitCondition'
  assert.ok(milestone[missingField] == null || milestone[missingField] === '',
    'The tested gate must actually be absent')
  assert.ok(typeof milestone[presentField] === 'string' && milestone[presentField].trim(),
    'The other gate must be present to isolate the negative test')
  if (presentField === 'requiredDeliverablesJson') {
    const deliverables = JSON.parse(milestone[presentField])
    assert.ok(Array.isArray(deliverables) && deliverables.length > 0,
      'The control deliverables must be a nonempty array')
  }
}

export const assertPb951GateRejection = (response, before, after) => {
  // The backend reuses its date error for missing gates; never accept that code alone.
  assert.equal(response?.code, 1055004003, 'Unexpected milestone rejection')
  assert.equal(response?.msg, '里程碑日期超出项目计划窗口或结束日期早于开始日期')
  assert.ok(before && after, 'Milestone readback is required')
  for (const field of [
    'id', 'projectId', 'ownerId', 'milestoneName', 'plannedStartDate', 'plannedEndDate',
    'confirmed', 'status', 'exitCondition', 'requiredDeliverablesJson',
    'manualConclusion', 'actualFinishDate', 'versionNo'
  ]) {
    assert.deepEqual(after[field], before[field], `Rejected milestone changed ${field}`)
  }
  assert.equal(after.status, 'NOT_STARTED', 'A rejected milestone must remain uncompleted')
  assert.equal(after.confirmed, true, 'A rejected milestone must remain confirmed')
}

export const buildDedicatedHrmEmployeePayload = (fixture) => {
  requireFixture(fixture)
  const digits = BigInt(`0x${fixture.marker.slice(-16)}`) % 100000000n
  return {
    name: `${fixture.marker}_EMP`,
    jobNumber: `${fixture.marker}_EMP`,
    mobile: `137${String(digits).padStart(8, '0')}`,
    entryStatus: 1,
    type: 1,
    entryTime: '2026-01-01T00:00:00',
    probation: 0,
    createUserAccount: false,
    remark: fixture.marker
  }
}

export const isDedicatedHrmEmployee = (employee, owned) =>
  Boolean(owned?.id && owned?.body?.jobNumber) &&
  String(employee?.id) === owned.id &&
  employee?.name === owned.body.name &&
  employee?.jobNumber === owned.body.jobNumber &&
  employee?.mobile === owned.body.mobile &&
  employee?.remark === owned.body.remark

export const createDedicatedHrmEmployee = async (api, fixture) => {
  requireFixture(fixture)
  assert.equal(fixture.employee, null, 'Employee must be newly created, never reused')
  const body = buildDedicatedHrmEmployeePayload(fixture)
  const id = resourceId(unwrap(await api.postBusiness('/hrm/employee/create', body), 'create employee'))
  fixture.employee = { id, body }
  const employee = unwrap(await api.getBusiness(`/hrm/employee/get?id=${id}`), 'read employee')
  assert.ok(isDedicatedHrmEmployee(employee, fixture.employee), 'Employee ownership mismatch')
  return employee
}

export const deleteDedicatedHrmEmployee = async (api, fixture) => {
  requireFixture(fixture)
  const owned = fixture.employee
  if (!owned) return
  const employee = unwrap(await api.getBusiness(`/hrm/employee/get?id=${owned.id}`), 'read employee')
  assert.ok(isDedicatedHrmEmployee(employee, owned), 'Refusing to delete an unowned employee')
  await api.deleteBusiness(`/hrm/employee/delete?id=${owned.id}`)
  const after = unwrap(await api.getBusiness(`/hrm/employee/get?id=${owned.id}`), 'read deleted employee')
  assert.equal(after, null, 'Employee deletion must be read back')
}

export const createDedicatedStaffSkill = async (api, fixture, projectType) => {
  requireFixture(fixture)
  assert.ok(fixture.employee, 'A new HRM employee is required')
  assert.equal(fixture.skill, null, 'Skill must be newly created')
  const body = {
    employeeId: fixture.employee.id,
    skillCode: `${fixture.marker}_SKILL`,
    skillName: `${fixture.marker} 现场实施`,
    projectRole: '实施顾问',
    skillLevel: 'SENIOR',
    applicableProjectType: projectType,
    loadThreshold: 80,
    effectiveStart: '2026-01-01',
    source: 'MANUAL',
    proficiency: 4,
    auditStatus: 'APPROVED',
    status: 0
  }
  const id = resourceId(unwrap(await api.postBusiness('/pm/staff-skill/save', body), 'create skill'))
  fixture.skill = { id, body }
  return fixture.skill
}

export const deleteDedicatedStaffSkill = async (api, fixture) => {
  requireFixture(fixture)
  const owned = fixture.skill
  if (!owned) return
  const path = `/pm/staff-skill/list-by-employee?employeeId=${fixture.employee.id}`
  const rows = unwrap(await api.getBusiness(path), 'read skills')
  assert.ok(Array.isArray(rows), 'Skills must be an array')
  const skill = rows.find((row) => String(row.id) === owned.id)
  assert.ok(skill && String(skill.employeeId) === fixture.employee.id &&
    skill.skillCode === owned.body.skillCode, 'Refusing to delete an unowned skill')
  await api.deleteBusiness(`/pm/staff-skill/delete?id=${owned.id}`)
  const after = unwrap(await api.getBusiness(path), 'read deleted skill')
  assert.ok(Array.isArray(after) && !after.some((row) => String(row.id) === owned.id))
}

export const isDedicatedModelingConfig = (row, owned) =>
  Boolean(owned?.id && owned?.body?.configCode) &&
  String(row?.id) === owned.id &&
  row?.configKey === owned.body.configKey &&
  row?.configCode === owned.body.configCode &&
  row?.configName === owned.body.configName

export const createDedicatedModelingConfig = async (api, fixture, key, suffix, value, status = 'ENABLED') => {
  requireFixture(fixture)
  assert.ok(['taskCategory', 'taskLibrary', 'warningRule'].includes(key), 'Unapproved config key')
  assert.match(suffix, /^[A-Z][A-Z0-9_]{0,15}$/)
  const body = {
    configKey: key,
    configCode: `${fixture.marker}_${suffix}`,
    configName: `${fixture.marker}_${suffix}`,
    configJson: JSON.stringify(value),
    status
  }
  const id = resourceId(unwrap(await api.postBusiness('/pm/modeling/save', body), 'create config'))
  const owned = { id, body }
  fixture.configs.push(owned)
  const row = await readDedicatedModelingConfig(api, fixture, owned)
  return { owned, row }
}

export const readDedicatedModelingConfig = async (api, fixture, owned) => {
  requireFixture(fixture)
  assert.ok(fixture.configs.includes(owned), 'Config was not created by this fixture')
  const row = unwrap(await api.getBusiness(`/pm/modeling/get?id=${owned.id}`), 'read config')
  assert.ok(isDedicatedModelingConfig(row, owned), 'Config ownership mismatch')
  return row
}

export const cleanupDedicatedModelingConfigs = async (api, fixture, caseRecord) => {
  requireFixture(fixture)
  const errors = []
  for (const owned of [...fixture.configs].reverse()) {
    try {
      await readDedicatedModelingConfig(api, fixture, owned)
      const response = await api.post(`/pm/modeling/status?id=${owned.id}&status=DISABLED`, undefined, {
        expectedBusinessRejection: owned.body.configKey === 'taskCategory'
          ? { code: 1055020005, message: '存在引用的建模配置不能停用' }
          : undefined
      })
      const row = await readDedicatedModelingConfig(api, fixture, owned)
      if (owned.body.configKey === 'taskCategory' && response?.code === 1055020005 &&
          response?.msg === '存在引用的建模配置不能停用') {
        assert.equal(row.status, 'ENABLED')
        assert.ok(Number(row.referenceCount) > 0)
        caseRecord.evidence.push(`本轮专属分类 ${owned.id} 仍被停用任务库历史引用，精确拒绝并保留；未强制解除引用`)
        continue
      }
      assertBusinessSuccess(response, 'disable owned config')
      assert.equal(row.status, 'DISABLED', 'Config cleanup must be read back')
      caseRecord.evidence.push(`清理并回读本轮专属 ${owned.body.configKey} ${owned.id}: DISABLED`)
    } catch (error) {
      errors.push(error)
      caseRecord.checks.push({
        name: `清理本轮专属配置 ${owned.id}`,
        passed: false,
        details: error.message
      })
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned config cleanup failed')
}
