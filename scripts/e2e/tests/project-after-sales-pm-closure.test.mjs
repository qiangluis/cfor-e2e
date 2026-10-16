import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  assertPmClosureLocalTarget,
  buildDedicatedHrmEmployeePayload,
  cleanupDedicatedModelingConfigs,
  createDedicatedHrmEmployee,
  createDedicatedModelingConfig,
  createDedicatedStaffSkill,
  deleteDedicatedHrmEmployee,
  deleteDedicatedStaffSkill,
  isDedicatedHrmEmployee,
  isDedicatedModelingConfig,
  newPmClosureFixture,
  ORIGINAL_PROJECT_ACCEPTANCE_GAPS,
  pmClosureDelayAdvanceDays,
  pmClosureTaskDate,
  PROJECT_AFTER_SALES_SAFETY_BLOCKS,
  readDedicatedModelingConfig
} from '../fixtures/project-after-sales-pm-closure.mjs'
import {
  finalizeProjectAfterSalesCatalogAssertions,
  isDedicatedProject,
  PROJECT_AFTER_SALES_CATALOG_ASSERTIONS,
  runCase
} from '../suites/project-after-sales.mjs'

const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  .suites.find((suite) => suite.id === 'project-after-sales')
const suiteSource = readFileSync(new URL('../suites/project-after-sales.mjs', import.meta.url), 'utf8')
const caseBlock = (id) => {
  const start = suiteSource.indexOf(`if (caseId === '${id}')`)
  const end = suiteSource.indexOf('\n  if (caseId === ', start + 1)
  return suiteSource.slice(start, end < 0 ? undefined : end)
}
const record = () => ({ checks: [], evidence: [], notes: [] })
const success = (data) => ({ code: 0, data })

const mockApi = () => {
  const calls = []
  let sequence = 100
  let employee = null
  let skill = null
  const configs = new Map()
  return {
    calls, configs,
    async postBusiness(path, body) {
      calls.push(['POST', path, body])
      const id = String(++sequence)
      if (path === '/hrm/employee/create') employee = { ...body, id }
      else if (path === '/pm/staff-skill/save') skill = { ...body, id }
      else if (path === '/pm/modeling/save') {
        configs.set(id, { ...body, id, referenceCount: 0, versionNo: 1 })
      } else throw new Error(`Unexpected mock POST ${path}`)
      return success(id)
    },
    async getBusiness(path) {
      calls.push(['GET', path])
      if (path.startsWith('/hrm/employee/get?')) return success(employee)
      if (path.startsWith('/pm/staff-skill/list-by-employee?')) return success(skill ? [skill] : [])
      if (path.startsWith('/pm/modeling/get?')) {
        return success(configs.get(new URL(path, 'http://local').searchParams.get('id')))
      }
      throw new Error(`Unexpected mock GET ${path}`)
    },
    async deleteBusiness(path) {
      calls.push(['DELETE', path])
      if (path.startsWith('/hrm/employee/delete?')) employee = null
      else if (path.startsWith('/pm/staff-skill/delete?')) skill = null
      else throw new Error(`Unexpected mock DELETE ${path}`)
      return success(true)
    },
    async post(path) {
      calls.push(['POST', path])
      const id = new URL(path, 'http://local').searchParams.get('id')
      configs.get(id).status = 'DISABLED'
      return success(true)
    }
  }
}

test('PM fixture writes require explicit local tenant-1 approval and fixed loopback ports', () => {
  const target = { target: 'local', tenantId: '1',
    apiBase: 'http://127.0.0.1:48083', webBase: 'http://localhost:9151' }
  assert.doesNotThrow(() => assertPmClosureLocalTarget(target, 'true'))
  for (const other of [
    { ...target, target: 'production' },
    { ...target, tenantId: '2' },
    { ...target, apiBase: 'http://192.168.1.2:48083' },
    { ...target, webBase: 'http://127.0.0.1:9152' }
  ]) assert.throws(() => assertPmClosureLocalTarget(other, 'true'))
  for (const approval of [undefined, '', 'false', '1']) {
    assert.throws(() => assertPmClosureLocalTarget(target, approval))
  }
})

test('employee payloads are unique dedicated HRM records without shared user bindings or account writes', () => {
  const first = newPmClosureFixture('PB112-001')
  const second = newPmClosureFixture('PB112-001')
  const body = buildDedicatedHrmEmployeePayload(first)
  assert.notEqual(first.marker, second.marker)
  assert.equal(body.name, `${first.marker}_EMP`)
  assert.equal(body.jobNumber, body.name)
  assert.equal(body.remark, first.marker)
  assert.match(body.mobile, /^137\d{8}$/)
  assert.equal(body.createUserAccount, false)
  assert.equal(body.userId, undefined)
  assert.equal(body.userAccountPassword, undefined)
  assert.throws(() => buildDedicatedHrmEmployeePayload({ marker: first.marker }))
})

test('task dates stay in the original project window and delay rules never require shrinking project dates', () => {
  const project = { plannedStartDate: '2026-10-13', plannedEndDate: '2027-01-11' }
  assert.equal(pmClosureTaskDate(project, '2026-10-13'), '2026-10-13')
  assert.equal(pmClosureTaskDate(project, '2027-01-11'), '2027-01-11')
  for (const date of ['2026-10-12', '2027-01-12', 'invalid']) {
    assert.throws(() => pmClosureTaskDate(project, date), /^Error: BLOCKED:/)
  }
  assert.equal(pmClosureDelayAdvanceDays(project.plannedEndDate, '2026-10-13'), 90)
  assert.equal(pmClosureDelayAdvanceDays('2026-10-12', '2026-10-13'), 0)
  assert.throws(() => pmClosureDelayAdvanceDays(null, '2026-10-13'), /^Error: BLOCKED:/)
})

test('PB114 missing an original plan blocks before publishing rules or evaluating warnings', () => {
  for (const end of [null, undefined, '', 'invalid']) {
    assert.throws(() => pmClosureDelayAdvanceDays(end, '2026-10-13'),
      /^Error: BLOCKED:.*NOT_NULL.*禁止临时写入计划窗口$/)
  }
  const block = caseBlock('PB114-001')
  const precondition = block.indexOf('pmClosureDelayAdvanceDays(')
  const publish = block.indexOf('createDedicatedModelingConfig(')
  const evaluate = block.indexOf("api.postBusiness('/pm/warning/evaluate'")
  assert.ok(precondition >= 0 && publish > precondition && evaluate > publish)
  assert.doesNotMatch(block, /\/pm\/project\/update|restoreDedicatedProject\(/)
})

test('dedicated employee ownership requires exact ID, job number, name, phone and marker', () => {
  const fixture = newPmClosureFixture('PB112-001')
  const body = buildDedicatedHrmEmployeePayload(fixture)
  const owned = { id: '101', body }
  const employee = { ...body, id: '101' }
  assert.equal(isDedicatedHrmEmployee(employee, owned), true)
  for (const field of ['id', 'name', 'jobNumber', 'mobile', 'remark']) {
    assert.equal(isDedicatedHrmEmployee({ ...employee, [field]: 'shared' }, owned), false)
  }
  assert.equal(isDedicatedHrmEmployee(undefined, undefined), false)
})

test('employee and skill creation/readback/cleanup only use newly returned IDs', async () => {
  const api = mockApi()
  const fixture = newPmClosureFixture('PB112-001')
  const employee = await createDedicatedHrmEmployee(api, fixture)
  assert.equal(String(employee.id), fixture.employee.id)
  const skill = await createDedicatedStaffSkill(api, fixture, 'TYPE')
  assert.equal(skill.body.employeeId, fixture.employee.id)
  await assert.rejects(createDedicatedHrmEmployee(api, fixture), /never reused/)
  await deleteDedicatedStaffSkill(api, fixture)
  await deleteDedicatedHrmEmployee(api, fixture)
  assert.ok(api.calls.some(([method, path]) => method === 'DELETE' &&
    path === `/pm/staff-skill/delete?id=${skill.id}`))
  assert.ok(api.calls.some(([method, path]) => method === 'DELETE' &&
    path === `/hrm/employee/delete?id=${employee.id}`))
  assert.ok(api.calls.every(([, path]) => !path.includes('simple-page') &&
    !path.includes('/system/user/')))
})

test('foreign fixtures and changed employee ownership never trigger deletion', async () => {
  const api = mockApi()
  await assert.rejects(deleteDedicatedHrmEmployee(api, { employee: { id: '999' } }), /this run/)
  const fixture = newPmClosureFixture('PB112-001')
  await createDedicatedHrmEmployee(api, fixture)
  api.getBusiness = async () => success({ ...fixture.employee.body, id: '999' })
  await assert.rejects(deleteDedicatedHrmEmployee(api, fixture), /unowned employee/)
  assert.ok(api.calls.every(([method]) => method !== 'DELETE'))
})

test('configuration ownership requires exact returned ID, key, code and name', () => {
  const owned = { id: '101', body: {
    configKey: 'taskCategory', configCode: 'E2E_CATEGORY', configName: 'E2E_CATEGORY'
  } }
  const row = { ...owned.body, id: '101' }
  assert.equal(isDedicatedModelingConfig(row, owned), true)
  for (const field of ['id', 'configKey', 'configCode', 'configName']) {
    assert.equal(isDedicatedModelingConfig({ ...row, [field]: 'shared' }, owned), false)
  }
  assert.equal(isDedicatedModelingConfig(undefined, undefined), false)
})

test('task categories are always created and cleanup processes only fixture-owned configs in reverse order', async () => {
  const api = mockApi()
  const fixture = newPmClosureFixture('PB116-001')
  const category = await createDedicatedModelingConfig(api, fixture, 'taskCategory', 'CATEGORY', {})
  const library = await createDedicatedModelingConfig(api, fixture, 'taskLibrary', 'LIBRARY', {
    categoryId: category.row.configCode
  })
  await assert.rejects(readDedicatedModelingConfig(api, fixture,
    { ...category.owned, id: '999' }), /not created/)
  const result = record()
  await cleanupDedicatedModelingConfigs(api, fixture, result)
  assert.deepEqual(api.calls.filter(([, path]) => path.startsWith('/pm/modeling/status'))
    .map(([, path]) => path), [
    `/pm/modeling/status?id=${library.owned.id}&status=DISABLED`,
    `/pm/modeling/status?id=${category.owned.id}&status=DISABLED`
  ])
  assert.equal(result.evidence.length, 2)
  assert.ok(api.calls.every(([, path]) => !path.includes('/list')))
})

test('owned category cleanup preserves exact reference rejection but never hides a server error', async () => {
  for (const rejected of [
    { code: 1055020005, msg: '存在引用的建模配置不能停用' },
    { code: 500, msg: '系统异常' }
  ]) {
    const api = mockApi()
    const fixture = newPmClosureFixture('PB116-001')
    const category = await createDedicatedModelingConfig(api, fixture, 'taskCategory', 'CATEGORY', {})
    api.configs.get(category.owned.id).referenceCount = 1
    api.post = async () => rejected
    const result = record()
    if (rejected.code === 1055020005) {
      await cleanupDedicatedModelingConfigs(api, fixture, result)
      assert.equal(result.checks.length, 0)
      assert.ok(result.evidence[0].includes('未强制解除引用'))
    } else {
      await assert.rejects(cleanupDedicatedModelingConfigs(api, fixture, result), AggregateError)
      assert.equal(result.checks[0].passed, false)
    }
  }
})

test('project ownership also rejects empty IDs, wrong handover and absent marker', () => {
  assert.equal(isDedicatedProject(undefined, undefined), false)
  assert.equal(isDedicatedProject({}, {}), false)
  const owned = { projectId: '101', handoverId: '202', marker: 'E2E_PB113' }
  const project = { id: '101', handoverId: '202', customerNameSnapshot: owned.marker }
  assert.equal(isDedicatedProject(project, owned), true)
  assert.equal(isDedicatedProject({ ...project, handoverId: '999' }, owned), false)
  assert.equal(isDedicatedProject({ ...project, customerNameSnapshot: 'shared' }, owned), false)
})

test('PB112/113/114/116 never select a shared employee, project or category', () => {
  for (const id of ['PB112-001', 'PB113-001', 'PB114-001', 'PB116-001']) {
    const block = caseBlock(id)
    assert.doesNotMatch(block, /employee\/simple-page|project\/page|listOf\([^)]*\)\[0\]/)
    assert.doesNotMatch(block, /executeIgnore|automation\/scan|generate-quarter|knowledge-index\/run/)
    assert.doesNotMatch(block, /\/pm\/project\/update|restoreDedicatedProject\(/)
    if (id !== 'PB116-001') assert.match(block, /createDedicatedProject\(/)
  }
  assert.match(caseBlock('PB112-001'), /createDedicatedHrmEmployee\(api, owned\)/)
  assert.match(caseBlock('PB112-001'), /projectId: fixture\.projectId/)
  assert.match(caseBlock('PB113-001'), /const projectId = fixture\.projectId/)
  assert.equal((caseBlock('PB114-001').match(/warning\/evaluate', \{ projectId \}/g) || []).length, 2)
  assert.match(caseBlock('PB116-001'), /createDedicatedModelingConfig\(api, owned, 'taskCategory'/)
  assert.match(caseBlock('PB116-001'), /categoryId: category\.row\.configCode/)
  assert.match(caseBlock('PB116-001'), /code: 1055020011, message: cycleMessage/)
  assert.doesNotMatch(caseBlock('PB116-001'), /catch \(error\).*Rejected = true/s)
})

test('PB123 without its safe write gate and shared PB126 are blocked before login or any API call', async () => {
  for (const caseId of ['PB123-001', 'PB126-001']) {
    const result = record()
    await assert.rejects(runCase({
      caseId, caseRecord: result,
      page: new Proxy({}, { get() { throw new Error('Browser must not be touched') } })
    }), /^Error: BLOCKED:/)
    assert.equal(result.passCandidate, false)
    assert.equal(result.checks.length, 0)
  }
  assert.ok(PROJECT_AFTER_SALES_SAFETY_BLOCKS['PB126-001'].includes('2107051150215401473'))
  assert.equal(PROJECT_AFTER_SALES_SAFETY_BLOCKS['PB122-001'], undefined)
  const inspection = caseBlock('PB122-001')
  assert.doesNotMatch(inspection, /generate-quarter\?/)
  assert.match(inspection, /generate-quarter-for-assets/)
  assert.match(inspection, /readOtherInspectionFacts/)
  assert.match(inspection, /assertInspectionTaskSnapshot/)
  assert.match(inspection, /assertInspectionSnapshotUnchanged/)
})

test('every catalog assertion and original GAP remains verbatim, without empty assertion mappings for PB9xx', () => {
  for (const definition of catalog.cases) {
    assert.deepEqual(PROJECT_AFTER_SALES_CATALOG_ASSERTIONS[definition.id], definition.assertions || [])
    assert.deepEqual(ORIGINAL_PROJECT_ACCEPTANCE_GAPS[definition.id], definition.acceptanceGaps || [])
    const result = record()
    finalizeProjectAfterSalesCatalogAssertions(result, definition.id)
    assert.deepEqual(result.acceptanceGapAssertions.map((row) => row.assertion),
      definition.acceptanceGaps || [])
  }
})

test('four closure cases retain original GAPs even when all original assertion checks pass', () => {
  for (const id of ['PB112-001', 'PB113-001', 'PB114-001', 'PB116-001']) {
    const result = record()
    result.checks = PROJECT_AFTER_SALES_CATALOG_ASSERTIONS[id].map((name) => ({
      name, passed: true, details: 'original assertion only'
    }))
    const outcome = finalizeProjectAfterSalesCatalogAssertions(result, id)
    assert.equal(outcome.partial, true)
    assert.equal(outcome.acceptanceComplete, false)
    assert.ok(result.acceptanceGapAssertions.every((row) => row.status === 'GAP'))
    assert.deepEqual(outcome.remainingAssertions, id === 'PB114-001'
      ? [PROJECT_AFTER_SALES_CATALOG_ASSERTIONS[id][1], ...ORIGINAL_PROJECT_ACCEPTANCE_GAPS[id]]
      : ORIGINAL_PROJECT_ACCEPTANCE_GAPS[id])
  }
})

test('PB945 requires all three exact period checks and retains incomplete formal-date evidence', () => {
  const result = record()
  result.checks = [
    'DAILY 生成周期范围并由服务端构造只读来源快照',
    '日报来源按当天过滤，周期外任务不进入快照',
    '报告生成只读取任务和工时，不反写任务状态'
  ].map((name) => ({ name, passed: true }))
  finalizeProjectAfterSalesCatalogAssertions(result, 'PB945-001')
  assert.deepEqual(result.catalogAssertions.map((row) => row.status),
    ['GAP', 'GAP', 'VERIFIED', 'GAP'])
  result.checks.push(...['WEEKLY', 'MONTHLY'].map((type) => ({
    name: `${type} 生成周期范围并由服务端构造只读来源快照`, passed: true
  })))
  finalizeProjectAfterSalesCatalogAssertions(result, 'PB945-001')
  assert.deepEqual(result.catalogAssertions.map((row) => row.status),
    ['VERIFIED', 'VERIFIED', 'VERIFIED', 'GAP'])
})

test('PB953 cannot accept one report as eleven or equate parseable Excel with exact filter/version agreement', () => {
  const result = record()
  result.checks = [
    'PROJECT_PROGRESS 报表返回统一口径和同一筛选上下文',
    'PROJECT_PROGRESS 导出复用相同筛选并生成可解析 Excel',
    'TASK_EXECUTION 导出复用相同筛选并生成可解析 Excel'
  ].map((name) => ({ name, passed: true }))
  finalizeProjectAfterSalesCatalogAssertions(result, 'PB953-001')
  assert.deepEqual(result.catalogAssertions.map((row) => row.status),
    ['GAP', 'GAP', 'VERIFIED', 'GAP'])
})

test('PB949 exact duplicate rejection and unchanged second change must both be present', () => {
  const result = record()
  result.checks = [
    '变更审批通过冻结对象版本并记录下游处理策略',
    '服务端一次性执行写入幂等键、执行人和执行时间',
    '重复幂等键被领域拒绝，不产生第二次执行',
    '变更经执行、验证后关闭且全链路时间可回读'
  ].map((name) => ({ name, passed: true }))
  finalizeProjectAfterSalesCatalogAssertions(result, 'PB949-001')
  assert.equal(result.catalogAssertions[3].status, 'GAP')
  result.checks.push({ name: '重复执行拒绝后第二条变更仍停留在 APPROVED', passed: true })
  finalizeProjectAfterSalesCatalogAssertions(result, 'PB949-001')
  assert.equal(result.catalogAssertions[3].status, 'VERIFIED')
  assert.equal(result.catalogAssertions[0].status, 'GAP')
  assert.equal(result.catalogAssertions[4].status, 'GAP')
})
