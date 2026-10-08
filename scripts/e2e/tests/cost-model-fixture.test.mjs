import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareCostModelFixture, costModelPayload } from '../fixtures/cost-model.mjs'
import { costConfigurationSignature, costFixtureRemark } from '../suites/cost.mjs'

const context = () => ({
  caseId: 'COST-031',
  record: { runId: '202610071200-123', environment: { tenantId: '1' } },
  caseRecord: { id: 'COST-031', caseId: 'COST-031', checks: [], evidence: [] },
  effectiveMonth: '2099-12',
  remarkForFixture: costFixtureRemark
})

test('cost fixture scope rejects another tenant, case, run or non-future month before writes', async () => {
  for (const mutate of [
    (input) => { input.record.environment.tenantId = '2' },
    (input) => { input.caseId = 'COST-002' },
    (input) => { input.record.runId = '' },
    (input) => { input.caseRecord.caseId = 'COST-030' },
    (input) => { input.effectiveMonth = '2026-10' }
  ]) {
    const input = context()
    mutate(input)
    let wrote = false
    input.api = { postBusiness: async () => { wrote = true } }
    await assert.rejects(() => prepareCostModelFixture(input), /authorized local tenant/)
    assert.equal(wrote, false)
  }
})

test('cost fixture safety preflight happens before any department or model is created', async () => {
  const input = context()
  let writes = 0
  input.api = { postBusiness: async () => { writes++ } }
  await assert.rejects(() => prepareCostModelFixture(input, {
    assertLocalWriteSafety: async () => { throw new Error('enabled-jobs') }
  }), /enabled-jobs/)
  assert.equal(writes, 0)
})

test('cost fixture creates exclusive IDs through APIs, never reuses shared departments', async () => {
  const input = context()
  const requests = []
  input.api = {
    async postBusiness (pathname, payload) {
      requests.push({ pathname, payload })
      if (pathname === '/system/dept/create') return { code: 0, data: '9223372036854775807' }
      if (pathname === '/cost/centers') return { code: 0, data: { id: '41' } }
      if (pathname === '/cost/model-versions') return { code: 0, data: { id: '42' } }
      throw new Error(`Unexpected fixture write: ${pathname}`)
    },
    async putBusiness (pathname, payload) {
      requests.push({ pathname, payload })
      return { code: 0, data: { items: [{ id: '43' }] } }
    }
  }
  const fixture = await prepareCostModelFixture(input, { assertLocalWriteSafety: async () => {} })
  assert.equal(fixture.departmentId, '9223372036854775807')
  assert.deepEqual(requests[1].payload.departmentIds, ['9223372036854775807'])
  assert.equal(fixture.modelVersionId, '42')
  assert.equal(fixture.costCenterId, '41')
  assert.equal(fixture.componentItemId, '43')
  assert.equal(fixture.exclusive, true)
  assert.equal(requests[1].payload.remark, costFixtureRemark(fixture))
  assert.equal(requests[2].payload.remark, costFixtureRemark(fixture))
  assert.equal(requests[3].payload.items[0].remark, costFixtureRemark(fixture))
  assert.equal(requests[2].payload.effectiveMonth, '2099-12')
  assert.equal(input.caseRecord.fixtures.cost, fixture)
})

test('fixture ownership registration preserves partial IDs when later preparation fails', async () => {
  const input = context()
  input.api = {
    postBusiness: async (pathname) => {
      if (pathname === '/system/dept/create') return { code: 0, data: '41' }
      throw new Error('Cost center creation failed')
    }
  }
  await assert.rejects(() => prepareCostModelFixture(input, {
    assertLocalWriteSafety: async () => {}
  }), /Cost center creation failed/)
  assert.equal(input.caseRecord.fixtures.cost.departmentId, '41')
  assert.equal(input.caseRecord.fixtures.cost.costCenterId, undefined)
})

test('cost models use supported manual fixture sources without claiming ERP or MES facts', () => {
  const payload = costModelPayload({ versionNo: 'fixture', effectiveMonth: '2099-12', remark: 'owned' })
  assert.equal(payload.valuationMethod, 'MOVING_AVERAGE')
  assert.deepEqual(JSON.parse(payload.finishedIoScopeJson), [])
  assert.equal(JSON.parse(payload.valuationScopeConfigJson).finishedDataSourceMode, 'MANUAL')
})

test('configuration restoration compares business values, not regenerated database IDs or field order', () => {
  const left = {
    categories: [{ id: '1', parentId: '', code: 'CAT', name: 'Category' }],
    items: [{ id: '2', categoryId: '1', code: 'ITEM', name: 'Item', status: 'ENABLED' }],
    sourceRules: [{ id: '3', componentItemId: '2', sourceType: 'MANUAL', sourcePriority: 1 }]
  }
  const right = {
    categories: [{ name: 'Category', code: 'CAT', parentId: '', id: '11' }],
    items: [{ status: 'ENABLED', name: 'Item', code: 'ITEM', categoryId: '11', id: '12' }],
    sourceRules: [{ sourcePriority: 1, sourceType: 'MANUAL', componentItemId: '12', id: '13' }]
  }
  assert.equal(costConfigurationSignature(left), costConfigurationSignature(right))
  right.items[0].status = 'DISABLED'
  assert.notEqual(costConfigurationSignature(left), costConfigurationSignature(right))
})
