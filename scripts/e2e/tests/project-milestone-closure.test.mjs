import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { encryptRequest } from '../lib/crypto.mjs'
import {
  assertMilestoneCompletion,
  assertMilestoneDatabaseCompletion,
  assertMilestoneProjectOwnership,
  assertMilestoneTaskFactsUnchanged,
  finalizeMilestoneClosureEvidence,
  observeMilestoneBrowser,
  PB951_CLOSURE_CHECKS,
  PB951_ORIGINAL_ASSERTIONS,
  PB951_PAGE_REMAINING_GATE,
  prepareMilestoneClosure,
  readMilestoneTaskFacts,
  registerMilestoneClosureAssertions
} from '../fixtures/project-milestone-closure.mjs'
import {
  finalizeProjectAfterSalesCatalogAssertions,
  initializeProjectAfterSalesCatalogAssertions
} from '../suites/project-after-sales.mjs'

const success = (data) => ({ code: 0, data, msg: '' })
const record = () => ({ checks: [], notes: [], evidence: [] })
const definition = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  .suites.find((suite) => suite.id === 'project-after-sales').cases.find((item) => item.id === 'PB951-001')
const fixture = () => {
  const owned = { projectId: '101', handoverId: '201', ownerId: '1', marker: 'E2E_PB951_TEST' }
  return { ...owned, project: {
    id: owned.projectId, handoverId: owned.handoverId, customerNameSnapshot: owned.marker,
    projectCode: 'PM-OWNED', status: 'EXECUTING',
    plannedStartDate: '2026-09-15', plannedEndDate: '2027-04-13'
  } }
}
const task = (taskId = '401', milestoneId = '303') => ({
  id: taskId, projectId: '101', milestoneId, status: 'PENDING_DISPATCH', ownerId: '1',
  acceptanceOwnerId: '1', receiveTime: null, completedTime: null, actualStartTime: null,
  actualEndTime: null, plannedStartDate: '2026-10-08', plannedEndDate: '2026-10-08',
  rejectedTime: null, reconfirmTime: null, sourcePlanNo: 'OWNED-PLAN'
})
const facts = () => {
  const tasks = [task(), task('402', null)]
  return {
    tasks, task: structuredClone(tasks[1]),
    sql: { available: true, rows: tasks.map((item) =>
      [item.id, item.status, item.ownerId, item.acceptanceOwnerId, 'NULL', 'NULL']) }
  }
}
const completeRecord = () => {
  const result = record()
  initializeProjectAfterSalesCatalogAssertions(result, 'PB951-001')
  registerMilestoneClosureAssertions(result)
  result.checks = Object.values(PB951_CLOSURE_CHECKS)
    .map((name) => ({ name, passed: true, details: 'new execution evidence' }))
  return result
}

test('PB951 registers the exact original index/assertion pairs and the existing page remaining gate', () => {
  const result = record()
  initializeProjectAfterSalesCatalogAssertions(result, 'PB951-001')
  registerMilestoneClosureAssertions(result)
  assert.deepEqual(result.catalogAssertions.slice(0, 4).map(({ index, assertion }) =>
    ({ index, assertion })), definition.assertions.map((assertion, index) => ({ index, assertion })))
  assert.deepEqual(PB951_ORIGINAL_ASSERTIONS, definition.assertions)
  assert.equal(result.catalogAssertions[4].index, 4)
  assert.equal(result.catalogAssertions[4].assertion, PB951_PAGE_REMAINING_GATE)
  assert.deepEqual(result.remainingAssertions, [...definition.assertions, PB951_PAGE_REMAINING_GATE])
  assert.ok(result.catalogAssertions.every((row) => row.status === 'GAP'))
  assert.equal(Object.keys(PB951_CLOSURE_CHECKS).length, 17)
  assert.throws(() => registerMilestoneClosureAssertions(result), /register.*once/)
})

test('PB951 refuses drifted original assertion text or index before adding page evidence', () => {
  for (const mutation of [
    (row) => { row.assertion = 'similar wording is not the original assertion' },
    (row) => { row.index = 7 }
  ]) {
    const result = record()
    initializeProjectAfterSalesCatalogAssertions(result, 'PB951-001')
    mutation(result.catalogAssertions[2])
    assert.throws(() => registerMilestoneClosureAssertions(result), /drift/)
  }
})

test('all 17 new checks close the original assertions plus page gate through the actual suite finalizer', () => {
  const result = completeRecord()
  finalizeMilestoneClosureEvidence(result)
  const outcome = finalizeProjectAfterSalesCatalogAssertions(result, 'PB951-001')
  assert.equal(outcome.partial, false)
  assert.equal(outcome.acceptanceComplete, true)
  assert.equal(outcome.passCandidate, true)
  assert.deepEqual(result.remainingAssertions, [])
  assert.equal(result.catalogAssertions.length, 5)
  assert.ok(result.catalogAssertions.every((row) =>
    row.status === 'VERIFIED' && row.evidenceChecks.length > 0))
  assert.deepEqual(result.catalogAssertions.slice(0, 4).map((row) => row.assertion),
    definition.assertions)
})

test('every missing, failed, nonboolean or duplicated substantive check prevents complete acceptance', () => {
  for (const name of Object.values(PB951_CLOSURE_CHECKS)) {
    for (const mode of ['missing', 'failed', 'nonboolean', 'duplicate']) {
      const result = completeRecord()
      const check = result.checks.find((row) => row.name === name)
      if (mode === 'missing') result.checks = result.checks.filter((row) => row !== check)
      if (mode === 'failed') check.passed = false
      if (mode === 'nonboolean') check.passed = 'true'
      if (mode === 'duplicate') result.checks.push({ ...check })
      finalizeMilestoneClosureEvidence(result)
      const outcome = finalizeProjectAfterSalesCatalogAssertions(result, 'PB951-001')
      assert.equal(outcome.acceptanceComplete, false, `${mode}: ${name}`)
      assert.ok(result.remainingAssertions.length > 0, `${mode}: ${name}`)
    }
  }
})

test('legacy API-only aliases cannot clear the original page remaining gate', () => {
  const result = record()
  initializeProjectAfterSalesCatalogAssertions(result, 'PB951-001')
  registerMilestoneClosureAssertions(result)
  result.checks = [
    'PB951 缺门禁负例在合法HRM工作日且确认状态和其它条件完整',
    '里程碑缺少准出条件或必需交付物时不能完成',
    '具备准出条件和交付物的里程碑可人工确认完成',
    '里程碑人工完成不代替任务责任人确认或改写任务状态'
  ].map((name) => ({ name, passed: true }))
  const outcome = finalizeProjectAfterSalesCatalogAssertions(result, 'PB951-001')
  assert.equal(outcome.acceptanceComplete, false)
  assert.deepEqual(outcome.remainingAssertions, [PB951_PAGE_REMAINING_GATE])
})

test('project ownership rejects foreign projects, handovers, markers, status and lossy IDs', () => {
  const owned = fixture()
  assert.doesNotThrow(() => assertMilestoneProjectOwnership(owned))
  for (const change of [
    { id: '999' }, { handoverId: '999' }, { customerNameSnapshot: 'shared' },
    { status: 'CLOSED' }, { projectCode: '' }, { id: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.throws(() => assertMilestoneProjectOwnership(owned, { ...owned.project, ...change }))
  }
  assert.throws(() => assertMilestoneProjectOwnership({ ...owned, marker: 'SHARED' }))
})

test('task comparison checks every formal field, directly linked tasks and actual database facts', () => {
  const before = facts()
  const scope = { projectId: '101', milestoneId: '303' }
  assert.doesNotThrow(() => assertMilestoneTaskFactsUnchanged(before, structuredClone(before), scope))
  for (const field of Object.keys(before.tasks[0])) {
    const after = structuredClone(before)
    after.tasks[0][field] = 'changed'
    assert.throws(() => assertMilestoneTaskFactsUnchanged(before, after, scope), field)
  }
  const changedAdmin = structuredClone(before)
  changedAdmin.task.acceptanceOwnerId = '999'
  assert.throws(() => assertMilestoneTaskFactsUnchanged(before, changedAdmin, scope))
  for (let index = 0; index < before.sql.rows[0].length; index++) {
    const after = structuredClone(before)
    after.sql.rows[0][index] = 'changed'
    assert.throws(() => assertMilestoneTaskFactsUnchanged(before, after, scope), `SQL ${index}`)
  }
  for (const broken of [
    { ...before, tasks: [] }, { ...before, sql: { available: false, rows: [] } },
    { ...before, sql: { available: true, rows: [] } }
  ]) assert.throws(() => assertMilestoneTaskFactsUnchanged(broken, broken, scope))
  assert.throws(() => assertMilestoneTaskFactsUnchanged(before, before,
    { ...scope, milestoneId: '999' }), /directly linked/)
  const alreadyReceived = structuredClone(before)
  alreadyReceived.tasks[0].receiveTime = '2026-10-15T00:00:00'
  assert.throws(() => assertMilestoneTaskFactsUnchanged(alreadyReceived, alreadyReceived, scope))
})

test('task readback paginates at 100 and reconciles all API IDs with scoped SQL', async () => {
  const tasks = Array.from({ length: 101 }, (_, index) => task(String(index + 401)))
  const requests = []
  const api = { async getBusiness(path) {
    requests.push(path)
    if (path.startsWith('/pm/task/get')) return success(tasks[0])
    const query = new URL(path, 'http://local').searchParams
    assert.equal(query.get('projectId'), '101')
    assert.equal(query.get('pageSize'), '100')
    return success({ total: tasks.length,
      list: query.get('pageNo') === '1' ? tasks.slice(0, 100) : tasks.slice(100) })
  } }
  const snapshot = await readMilestoneTaskFacts(api, fixture(), tasks[0].id, async (sql) => {
    assert.match(sql, /WHERE project_id=101\s+AND tenant_id=1 AND deleted=0/)
    return { available: true, rows: tasks.map((item) => [item.id]) }
  })
  assert.equal(snapshot.tasks.length, 101)
  assert.equal(requests.length, 3)
})

test('task readback rejects truncated pagination, duplicate/foreign IDs and absent SQL evidence', async () => {
  for (const broken of [
    { total: 2, list: [] },
    { total: 2, list: [task(), task()] },
    { total: 1, list: [{ ...task(), projectId: '999' }] },
    { total: '1', list: [task()] }
  ]) {
    const api = { getBusiness: async () => success(broken) }
    await assert.rejects(readMilestoneTaskFacts(api, fixture(), '401',
      async () => ({ available: true, rows: [['401']] })))
  }
  const api = { getBusiness: async (path) =>
    success(path.includes('/get?') ? task() : { total: 1, list: [task()] }) }
  for (const sql of [
    { available: false, rows: [] }, { available: true, rows: [] },
    { available: true, rows: [['999']] }
  ]) await assert.rejects(readMilestoneTaskFacts(api, fixture(), '401', async () => sql))
})

const expectedCompletion = () => ({
  id: '303', projectId: '101', today: '2026-10-15', exitCondition: 'owned exit gate',
  deliverables: ['owned signed report', 'owned delivery list'],
  manualConclusion: 'approved after human inspection', healthStatus: 'NORMAL', warningStatus: 'NONE'
})
const completedMilestone = () => {
  const expected = expectedCompletion()
  return { ...expected, status: 'COMPLETED', confirmed: true, actualFinishDate: expected.today,
    requiredDeliverablesJson: JSON.stringify(expected.deliverables) }
}

test('completion requires exact identity, conclusion, date and ordered deliverables without overriding health', () => {
  assert.doesNotThrow(() => assertMilestoneCompletion(completedMilestone(), expectedCompletion()))
  for (const field of ['id', 'projectId', 'status', 'confirmed', 'actualFinishDate',
    'manualConclusion', 'exitCondition', 'requiredDeliverablesJson', 'healthStatus', 'warningStatus']) {
    assert.throws(() => assertMilestoneCompletion({
      ...completedMilestone(), [field]: field === 'requiredDeliverablesJson' ? '[]' : 'changed'
    }, expectedCompletion()), field)
  }
})

test('milestone SQL completion checks every persisted column and cannot silently skip unavailable SQL', () => {
  const expected = expectedCompletion()
  const snapshot = { available: true, rows: [[
    '303', '101', 'COMPLETED', '\u0001', expected.today, expected.exitCondition,
    JSON.stringify(expected.deliverables), 'NORMAL', 'NONE', expected.manualConclusion
  ]] }
  assert.doesNotThrow(() => assertMilestoneDatabaseCompletion(snapshot, expected))
  for (let index = 0; index < snapshot.rows[0].length; index++) {
    const changed = structuredClone(snapshot)
    changed.rows[0][index] = index === 6 ? '[]' : 'changed'
    assert.throws(() => assertMilestoneDatabaseCompletion(changed, expected), `SQL column ${index}`)
  }
  for (const invalid of [
    { available: false, rows: [] }, { available: true, rows: [] },
    { available: true, rows: [...snapshot.rows, ...snapshot.rows] }
  ]) assert.throws(() => assertMilestoneDatabaseCompletion(invalid, expected))
})

const mockRequest = (pathname, method = 'GET', body, encrypted = false) => ({
  url: () => `http://127.0.0.1:48083/admin-api/pm/milestone/${pathname}`,
  method: () => method,
  headers: () => encrypted ? { 'x-api-encrypt': 'true' } : {},
  postData: () => body ? (encrypted ? encryptRequest(body) : JSON.stringify(body)) : null,
  postDataJSON: () => body
})
const mockResponse = (request, payload = success(true), ok = true) => ({
  url: request.url, request: () => request, ok: () => ok, status: () => ok ? 200 : 500,
  headers: () => ({}), text: async () => JSON.stringify(payload)
})

test('browser observer captures actual unencrypted and encrypted saves and only matches new responses', async () => {
  for (const encrypted of [false, true]) {
    const page = new EventEmitter()
    const observer = observeMilestoneBrowser(page, 40)
    const request = mockRequest('save', 'POST',
      { id: '303', projectId: '101', requiredDeliverablesJson: '["owned"]' }, encrypted)
    page.emit('request', request)
    page.emit('response', mockResponse(request, success('303')))
    await observer.flush()
    const event = await observer.waitFor((row) => row.pathname.endsWith('/save'))
    assert.deepEqual(event.body, request.postDataJSON())
    assert.equal(observer.requests.length, 1)
    assert.equal(event.data, '303')
    const mark = observer.mark()
    await assert.rejects(observer.waitFor(() => true, mark), /timed out/)
    await observer.stop()
    assert.equal(page.listenerCount('request'), 0)
    assert.equal(page.listenerCount('response'), 0)
  }
})

test('browser observer rejects HTTP errors, business errors and malformed payloads without orphan listeners', async () => {
  for (const response of [
    mockResponse(mockRequest('complete?id=303'), success(true), false),
    mockResponse(mockRequest('complete?id=303'), { code: 500, msg: 'not accepted' }),
    { ...mockResponse(mockRequest('list?projectId=101')), text: async () => 'not JSON' }
  ]) {
    const page = new EventEmitter()
    const observer = observeMilestoneBrowser(page, 40)
    page.emit('response', response)
    await assert.rejects(observer.flush())
    await observer.stop()
    assert.equal(page.listenerCount('request') + page.listenerCount('response'), 0)
  }
})

const mockPreparationApi = () => {
  const calls = []
  const owned = fixture()
  const milestones = Array.from({ length: 3 }, (_, index) => ({
    id: String(index + 301), projectId: owned.projectId, stageId: String(index + 501),
    confirmed: false, status: 'NOT_STARTED', weightRate: 33.33, versionNo: 1,
    manualConclusion: null, actualFinishDate: null
  }))
  const tasks = facts()
  return {
    calls, milestones, tasks,
    async getBusiness(path) {
      calls.push(['GET', path])
      if (path.startsWith('/pm/project/get?')) return success(structuredClone(owned.project))
      if (path === '/system/user/profile/get') return success({ id: '1', nickname: 'owner' })
      if (path.startsWith('/hrm/attendance/holiday/check?')) return success(null)
      if (path.startsWith('/pm/milestone/list?')) return success(structuredClone(milestones))
      if (path.startsWith('/pm/task/page?')) {
        return success({ list: structuredClone(tasks.tasks), total: tasks.tasks.length })
      }
      if (path.startsWith('/pm/task/get?')) return success(structuredClone(tasks.task))
      throw new Error(`Unexpected GET ${path}`)
    },
    async postBusiness(path, body) {
      calls.push(['POST', path, body])
      if (path === '/pm/milestone/save') {
        Object.assign(milestones.find((row) => row.id === body.id), body)
        return success(body.id)
      }
      if (path === '/pm/task/create-administrative') return success(tasks.task.id)
      throw new Error(`Unexpected POST ${path}`)
    },
    async putBusiness(path) {
      calls.push(['PUT', path])
      const target = new URL(path, 'http://local').searchParams.get('id')
      assert.ok(path.startsWith('/pm/milestone/confirm?'))
      milestones.find((row) => row.id === target).confirmed = true
      return success(true)
    },
    async put(path, body, options) {
      calls.push(['PUT negative', path, body, options])
      return { code: 1055004003, msg: '里程碑日期超出项目计划窗口或结束日期早于开始日期' }
    }
  }
}

test('preparation uses only owned template IDs, isolates both gates, and leaves positive completion to the browser', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    const api = mockPreparationApi()
    const result = record()
    const closure = await prepareMilestoneClosure({
      api, fixture: fixture(), caseRecord: result, today: '2026-10-15',
      readSql: async () => structuredClone(api.tasks.sql)
    })
    assert.deepEqual(closure.owned.map((row) => row.id), ['301', '302', '303'])
    assert.equal(closure.owned[0].exitCondition, null)
    assert.equal(closure.owned[1].requiredDeliverablesJson, null)
    assert.deepEqual(result.pb951GateEvidence.map((row) => row.missingField),
      ['exitCondition', 'requiredDeliverablesJson'])
    assert.ok(result.pb951GateEvidence.every((row) => row.workingDay && row.before.confirmed))
    assert.equal(api.calls.filter(([kind]) => kind === 'PUT negative').length, 2)
    assert.ok(api.calls.filter(([kind]) => kind === 'PUT negative').every(([, path]) =>
      !path.includes('id=303')))
    assert.equal(api.milestones[2].confirmed, false)
    assert.equal(api.milestones[2].status, 'NOT_STARTED')
    assert.deepEqual(result.pb951TaskFacts.before, api.tasks)
    assert.ok(api.calls.every(([, path]) => !/executeIgnore|pms\/pm|update|delete/.test(path)))
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

test('preparation rejects unrelated ownership and already locked templates before milestone mutation', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    const wrongOwner = mockPreparationApi()
    await assert.rejects(prepareMilestoneClosure({
      api: wrongOwner, fixture: { ...fixture(), handoverId: '999' },
      caseRecord: record(), today: '2026-10-15'
    }), /handover/)
    assert.ok(wrongOwner.calls.every(([method]) => method === 'GET'))
    const locked = mockPreparationApi()
    locked.milestones[0].confirmed = true
    await assert.rejects(prepareMilestoneClosure({
      api: locked, fixture: fixture(), caseRecord: record(), today: '2026-10-15'
    }), /locked/)
    assert.ok(locked.calls.every(([method]) => method === 'GET'))
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

test('missing local write approval stops preparation before any formal API call', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'false'
  try {
    const api = mockPreparationApi()
    await assert.rejects(prepareMilestoneClosure({
      api, fixture: fixture(), caseRecord: record(), today: '2026-10-15'
    }), /explicit fixture write approval/)
    assert.deepEqual(api.calls, [])
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

test('a date/identity failure cannot masquerade as a missing-gate rejection with the reused error code', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    for (const change of [
      { plannedStartDate: '2027-04-14' }, { projectId: '999' }, { ownerId: '999' },
      { requiredDeliverablesJson: '[]' }
    ]) {
      const api = mockPreparationApi()
      const confirm = api.putBusiness.bind(api)
      api.putBusiness = async (path) => {
        const result = await confirm(path)
        Object.assign(api.milestones[0], change)
        return result
      }
      await assert.rejects(prepareMilestoneClosure({
        api, fixture: fixture(), caseRecord: record(), today: '2026-10-15',
        readSql: async () => structuredClone(api.tasks.sql)
      }))
      assert.equal(api.calls.filter(([method]) => method === 'PUT negative').length, 0)
    }
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

test('an exact rejection code cannot mask changed milestone facts or a different business message', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    for (const changedFacts of [false, true]) {
      const api = mockPreparationApi()
      api.put = async () => {
        if (changedFacts) api.milestones[0].manualConclusion = 'written despite rejection'
        return { code: 1055004003, msg: changedFacts
          ? '里程碑日期超出项目计划窗口或结束日期早于开始日期' : 'different error' }
      }
      const result = record()
      await assert.rejects(prepareMilestoneClosure({
        api, fixture: fixture(), caseRecord: result, today: '2026-10-15',
        readSql: async () => structuredClone(api.tasks.sql)
      }))
      assert.equal(result.checks.some((row) => row.name === PB951_CLOSURE_CHECKS.noExit), false)
    }
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

test('missing a directly linked task blocks before confirming or completing any milestone', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    const api = mockPreparationApi()
    api.tasks.tasks[0].milestoneId = '999'
    await assert.rejects(prepareMilestoneClosure({
      api, fixture: fixture(), caseRecord: record(), today: '2026-10-15',
      readSql: async () => structuredClone(api.tasks.sql)
    }), /directly linked/)
    assert.equal(api.calls.filter(([method]) => method.startsWith('PUT')).length, 0)
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})
