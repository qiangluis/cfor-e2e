import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  COST_CASE_EFFECTIVE_MONTH,
  costArrayData,
  costFixtureRemark,
  costPageRows,
  hasEditableCostModel,
  isOwnedCostModelFixture,
  loadOwnedCostFixture,
  nextCostCenterStartDate,
  runCase
} from '../suites/cost.mjs'

const source = fs.readFileSync(new URL('../suites/cost.mjs', import.meta.url), 'utf8')
const cost029 = source.slice(
  source.indexOf("if (caseId === 'COST-029')"),
  source.indexOf("if (caseId === 'COST-030')")
)

test('COST-029 preserves Snowflake department IDs in the request payload', () => {
  assert.match(cost029, /departmentIds:\s*\[availableDepartment\.id\]/)
  assert.doesNotMatch(cost029, /departmentIds:\s*\[Number\(availableDepartment\.id\)\]/)
})

test('COST-029 starts temporary centers strictly after the latest historical end date', () => {
  const departmentId = '2106200343998562305'
  const centers = [
    { departmentIds: [departmentId], status: 'DISABLED', disabledAt: '2026-10-05' },
    { departmentIds: [departmentId], status: 'DISABLED', disabledAt: '2026-10-06' },
    { departmentIds: ['2106200343998562306'], status: 'DISABLED', disabledAt: '2099-12-31' }
  ]
  assert.equal(nextCostCenterStartDate({ centers, departmentId, today: '2026-10-05' }), '2026-10-07')
  assert.equal(nextCostCenterStartDate({ centers, departmentId, today: '2026-10-08' }), '2026-10-08')
  assert.equal(nextCostCenterStartDate({ centers: [], departmentId, today: '2026-10-05' }), '2026-10-05')
})

test('COST-029 fails fast when create or deactivate does not succeed', () => {
  assert.match(cost029, /if \(!firstCenterActive\) \{\s*throw new Error/)
  assert.match(cost029, /if \(firstCenterActive\) throw new Error/)
  assert.match(cost029, /if \(!secondCenterActive\) throw new Error/)
})

test('cost prerequisites distinguish valid empty pages from malformed responses', () => {
  assert.deepEqual(costPageRows({ code: 0, data: { list: [], total: 0 } }, 'models'), [])
  const row = { id: '9223372036854775807', status: 'LOCKED' }
  assert.deepEqual(costPageRows({ code: 0, data: { list: [row], total: 1 } }, 'models'), [row])
  for (const payload of [
    undefined,
    { code: 0, data: null },
    { code: 0, data: { total: 0 } },
    { code: 0, data: { list: [], total: 1 } },
    { code: 0, data: { list: [row], total: 0 } },
    { code: 403, data: { list: [], total: 0 } }
  ]) {
    assert.throws(() => costPageRows(payload, 'models'), /不能视为缺少依赖/)
  }
})

test('cost array contracts reject errors and null instead of manufacturing empty evidence', () => {
  assert.deepEqual(costArrayData({ code: 0, data: [] }, 'dead letters'), [])
  for (const payload of [
    undefined, { code: 0, data: null }, { code: 0, data: {} }, { code: 403, data: [] }
  ]) {
    assert.throws(() => costArrayData(payload, 'dead letters'), /不能视为缺少依赖/)
  }
})

test('locked-only or incomplete model lists cannot authorize cost configuration writes', () => {
  assert.equal(hasEditableCostModel([]), false)
  assert.equal(hasEditableCostModel([{ id: '1', status: 'LOCKED' }]), false)
  assert.equal(hasEditableCostModel([{ status: 'DRAFT' }]), false)
  assert.equal(hasEditableCostModel([{ id: '9223372036854775807', status: 'DRAFT' }]), true)
})

const ownedFixtureContext = (caseId = 'COST-032') => {
  const record = {
    runId: '20261006120000000-12345',
    environment: { tenantId: '1' }
  }
  const registration = {
    caseId,
    runId: record.runId,
    fixtureId: `E2E-${caseId}-${record.runId}-dedicated`,
    tenantId: '1',
    accountingOrgId: '1',
    effectiveMonth: COST_CASE_EFFECTIVE_MONTH,
    exclusive: true,
    modelVersionId: '9223372036854775807',
    costCenterId: '9223372036854775806',
    componentItemId: '9223372036854775805'
  }
  const remark = costFixtureRemark(registration)
  const model = {
    id: registration.modelVersionId,
    versionNo: `E2E-${caseId}-MODEL`,
    accountingOrgId: 1,
    status: 'DRAFT',
    effectiveMonth: registration.effectiveMonth,
    lockedAt: null,
    lockedBy: null,
    remark
  }
  const center = {
    id: registration.costCenterId,
    accountingOrgId: 1,
    status: 'ENABLED',
    enabledAt: `${registration.effectiveMonth}-01`,
    disabledAt: null,
    referenceCount: 0,
    remark
  }
  const config = {
    modelVersionId: model.id,
    categories: [
      { id: '9223372036854775804', parentId: '', code: 'E2E-CATEGORY', status: 'ENABLED' }
    ],
    items: [
      {
        id: registration.componentItemId,
        categoryId: '9223372036854775804',
        code: 'E2E-ITEM',
        status: 'ENABLED',
        systemItem: false,
        remark
      }
    ],
    sourceRules: [
      { id: '9223372036854775803', componentItemId: registration.componentItemId }
    ]
  }
  const caseRecord = {
    id: caseId,
    caseId,
    fixtures: { cost: registration },
    checks: [],
    evidence: [],
    notes: []
  }
  return {
    caseId, record, caseRecord, modelVersions: [model],
    registration, model, center, config, rules: []
  }
}

const fakeFixtureApi = (context) => {
  const reads = []
  const writes = []
  const routes = new Map([
    ['/cost/model-versions?accountingOrgId=1&pageNo=1&pageSize=100', () => ({
      list: context.modelVersions, total: context.modelVersions.length
    })],
    [`/cost/model-versions/${context.registration.modelVersionId}`, () => context.model],
    [`/cost/centers/${context.registration.costCenterId}`, () => context.center],
    [`/cost/model-versions/${context.registration.modelVersionId}/components`, () => context.config],
    [`/cost/allocation-rules?modelVersionId=${context.registration.modelVersionId}&effectiveMonth=${COST_CASE_EFFECTIVE_MONTH}`, () => context.rules]
  ])
  const api = {
    async getBusiness (path) {
      reads.push(path)
      assert.ok(routes.has(path), `unexpected GET: ${path}`)
      return { code: 0, data: routes.get(path)() }
    },
    async put (path, payload) {
      writes.push({ method: 'PUT', path, payload })
      if (['LABOR_HOUR', 'MACHINE_HOUR', 'AREA', 'OUTPUT'].includes(payload.lines?.[0]?.allocationMode)) {
        return { code: 422001, msg: 'factor source must be SNAPSHOT or MANUAL for factor allocation' }
      }
      if (payload.lines?.[0]?.allocationMode === 'UNKNOWN_FACTOR') {
        return { code: 422001, msg: 'unsupported allocation mode' }
      }
      return { code: 0, data: {} }
    },
    async post (...args) { writes.push({ method: 'POST', args }); throw new Error('unexpected POST') },
    async delete (...args) { writes.push({ method: 'DELETE', args }); throw new Error('unexpected DELETE') }
  }
  return { api, reads, writes }
}

const runFakeCostCase = async (context, fake) => {
  const evidence = []
  const result = await runCase(
    { ...context, page: { url: () => 'http://fake/cost-management' }, outputDir: '/unused' },
    {
      login: async () => 'fake-token',
      createApiClient: () => fake.api,
      prepareCostFixture: async () => {},
      recordCostDatabase: async () => {},
      saveCostPrerequisiteEvidence: async (entry) => evidence.push(entry.note),
      openRoute: async () => {},
      saveScreenshot: async () => {}
    }
  )
  return { result, evidence }
}

test('COST-030/031/032 version names cannot authorize historical or unregistered models', () => {
  for (const caseId of ['COST-030', 'COST-031', 'COST-032']) {
    const context = ownedFixtureContext(caseId)
    assert.equal(isOwnedCostModelFixture(context.model, context), true)
    assert.equal(isOwnedCostModelFixture(context.model), false)
    assert.equal(isOwnedCostModelFixture(
      { ...context.model, remark: 'E2E dedicated model' }, context
    ), false)
    delete context.caseRecord.fixtures
    assert.equal(isOwnedCostModelFixture(context.model, context), false)
  }
})

test('model ownership binds exact string IDs, case, run, tenant, draft state and future month', () => {
  const context = ownedFixtureContext()
  for (const candidate of [
    { ...context.model, id: '9223372036854775806' },
    { ...context.model, id: Number(context.model.id) },
    { ...context.model, status: 'LOCKED' },
    { ...context.model, lockedAt: '2026-10-01T12:00:00' },
    { ...context.model, lockedBy: '1' },
    { ...context.model, accountingOrgId: 2 },
    { ...context.model, effectiveMonth: '2026-10' },
    { ...context.model, id: '' }
  ]) {
    assert.equal(isOwnedCostModelFixture(candidate, context), false)
  }
  for (const overrides of [
    { caseId: 'COST-031' }, { runId: 'old-run' }, { tenantId: '2' },
    { accountingOrgId: '2' }, { effectiveMonth: '2026-10' },
    { fixtureId: 'E2E-COST-032-shared' }, { exclusive: false },
    { modelVersionId: Number(context.model.id) },
    { costCenterId: '9223372036854775808' },
    { componentItemId: '' }
  ]) {
    const candidate = ownedFixtureContext()
    Object.assign(candidate.registration, overrides)
    assert.equal(isOwnedCostModelFixture(candidate.model, candidate), false)
  }
  for (const overrides of [
    { caseId: 'COST-031' },
    { record: { ...context.record, runId: 'other-run' } },
    { record: { ...context.record, environment: { tenantId: '2' } } }
  ]) {
    assert.equal(isOwnedCostModelFixture(context.model, { ...context, ...overrides }), false)
  }
})

test('owned fixtures are reread by registered IDs rather than selecting first shared rows', async () => {
  const context = ownedFixtureContext()
  context.modelVersions.unshift({ ...context.model, id: '17', remark: 'shared' })
  const fake = fakeFixtureApi(context)
  const { fixture } = await loadOwnedCostFixture({ ...context, api: fake.api })
  assert.equal(fixture.model.id, context.registration.modelVersionId)
  assert.equal(fixture.center.id, context.registration.costCenterId)
  assert.equal(fixture.componentItem.id, context.registration.componentItemId)
  assert.deepEqual(fake.reads, [
    `/cost/model-versions/${context.registration.modelVersionId}`,
    `/cost/centers/${context.registration.costCenterId}`,
    `/cost/model-versions/${context.registration.modelVersionId}/components`,
    `/cost/allocation-rules?modelVersionId=${context.registration.modelVersionId}&effectiveMonth=${COST_CASE_EFFECTIVE_MONTH}`
  ])
  assert.equal(fake.writes.length, 0)
})

test('COST-030/031/032 missing registration remains PARTIAL with zero writes', async () => {
  for (const caseId of ['COST-030', 'COST-031', 'COST-032']) {
    for (const empty of [false, true]) {
      const context = ownedFixtureContext(caseId)
      if (empty) context.modelVersions = []
      delete context.caseRecord.fixtures
      const fake = fakeFixtureApi(context)
      const { result, evidence } = await runFakeCostCase(context, fake)
      assert.equal(result.partial, true)
      assert.equal(fake.writes.length, 0)
      assert.equal(fake.reads.length, 1)
      assert.equal(evidence.length, 1)
      assert.match(evidence[0], /未自动创建夹具/)
      assert.equal(context.caseRecord.checks.some((check) => !check.passed), false)
    }
  }
})

test('COST-030/031/032 reject mismatched or shared fixture members without any writes', async () => {
  const mutations = [
    (context) => { context.registration.runId = 'previous-run' },
    (context) => { context.registration.caseId = 'COST-029' },
    (context) => { context.modelVersions = [] },
    (context) => { context.modelVersions.push(context.model) },
    (context) => { context.model = { ...context.model, remark: 'old fixture' } },
    (context) => { context.model = { ...context.model, id: '7' } },
    (context) => { context.model = { ...context.model, status: 'LOCKED' } },
    (context) => { context.model = { ...context.model, effectiveMonth: '2026-10' } },
    (context) => { context.model = null },
    (context) => { context.center.id = '17' },
    (context) => { context.center.id = Number(context.center.id) },
    (context) => { context.center.remark = 'E2E other/shared center' },
    (context) => { context.center.accountingOrgId = 2 },
    (context) => { context.center.enabledAt = '2026-10-06' },
    (context) => { context.center.disabledAt = '2099-12-02' },
    (context) => { context.center.status = 'DISABLED' },
    (context) => { context.center.referenceCount = 1 },
    (context) => { delete context.center.referenceCount },
    (context) => { context.config.modelVersionId = '19' },
    (context) => { context.config.items = [] },
    (context) => { context.config.items[0].id = '18' },
    (context) => { context.config.items[0].remark = 'E2E other/shared component' },
    (context) => { context.config.items[0].systemItem = true },
    (context) => { context.config.items[0].status = 'DISABLED' },
    (context) => { context.config.items[0].categoryId = '17' },
    (context) => { context.config.items.push({ ...context.config.items[0], id: '17', remark: 'shared' }) },
    (context) => { context.config.items.push({ ...context.config.items[0] }) },
    (context) => { context.config.categories[0].parentId = '17' },
    (context) => { context.config.sourceRules[0].componentItemId = '17' },
    (context) => { context.rules.push({ id: '17', status: 'DRAFT' }) }
  ]
  for (const caseId of ['COST-030', 'COST-031', 'COST-032']) {
    for (const [index, mutate] of mutations.entries()) {
      const context = ownedFixtureContext(caseId)
      mutate(context)
      const fake = fakeFixtureApi(context)
      const { result, evidence } = await runFakeCostCase(context, fake)
      assert.equal(result.partial, true, `${caseId} mutation ${index}`)
      assert.equal(fake.writes.length, 0, `${caseId} mutation ${index}`)
      assert.equal(evidence.length, 1)
    }
  }
})

test('malformed or failed fixture APIs remain failures, never missing-data PARTIAL', async () => {
  for (const payload of [
    undefined, { code: 500, data: null }, { code: 0, data: [] },
    { code: 0, data: 'not an object' }, { code: 0 }
  ]) {
    const context = ownedFixtureContext()
    const fake = fakeFixtureApi(context)
    fake.api.getBusiness = async () => payload
    await assert.rejects(() => loadOwnedCostFixture({ ...context, api: fake.api }), /不能视为缺少归属证据/)
    assert.equal(fake.writes.length, 0)
  }
  const context = ownedFixtureContext()
  context.config.sourceRules = null
  const fake = fakeFixtureApi(context)
  await assert.rejects(() => loadOwnedCostFixture({ ...context, api: fake.api }), /未返回.*数组/)
  assert.equal(fake.writes.length, 0)
})

test('COST-032 keeps model, center, and component IDs as strings', () => {
  const cost032 = source.slice(
    source.indexOf("if (caseId === 'COST-032')"),
    source.indexOf("if (caseId === 'COST-033')")
  )
  assert.doesNotMatch(cost032, /Number\((draftModel|center|componentItemId)\.?\w*\)/)
  assert.doesNotMatch(cost032, /\.find\(|items\??\.\[0\]|centers\?accountingOrgId/)
  assert.match(cost032, /componentItemId = ownedCostFixture\.componentItem\.id/)
  assert.match(cost032, /modelVersionId:\s*String\(draftModel\.id\)/)
  assert.match(cost032, /costCenterId:\s*String\(center\.id\)/)
  assert.match(cost032, /componentItemId:\s*String\(componentItemId\)/)
})

test('COST-032 sends exact registered Snowflake strings for every factor and quantity payload', async () => {
  const context = ownedFixtureContext()
  const fake = fakeFixtureApi(context)
  const { result } = await runFakeCostCase(context, fake)
  assert.notEqual(result.partial, true)
  assert.equal(fake.writes.length, 6)
  for (const { path, payload } of fake.writes) {
    assert.equal(path, '/cost/allocation-rules')
    assert.equal(payload.modelVersionId, context.registration.modelVersionId)
    assert.equal(payload.costCenterId, context.registration.costCenterId)
    assert.equal(payload.lines[0].componentItemId, context.registration.componentItemId)
    assert.equal(payload.effectiveMonth, COST_CASE_EFFECTIVE_MONTH)
    assert.equal(payload.status, 'DRAFT')
  }
  assert.equal(context.caseRecord.checks.some((check) => !check.passed), false)
})
