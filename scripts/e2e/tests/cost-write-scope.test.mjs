import assert from 'node:assert/strict'
import test from 'node:test'
import { scopedCostScenarioApi } from '../fixtures/cost-write-scope.mjs'
import { runCase } from '../suites/cost.mjs'

const setup = () => {
  const fixture = {
    scenario: 'accounting', runId: 'unit-run', tenantId: '1',
    modelId: '101', periodId: '102', month: '2200-01',
    versionNo: 'E2E-V1', remark: 'CFOR-E2E:costScenario:accounting:unit-run:own:tenant=1'
  }
  const period = {
    id: '102', modelVersionId: '101', modelVersionNo: 'E2E-V1',
    accountingOrgId: 1, period: '2200-01', status: 'ACCOUNTING'
  }
  const writes = []
  const api = {
    async getBusiness (path) {
      if (path === '/cost/model-versions/101') return { code: 0, data: {
        id: '101', accountingOrgId: 1, versionNo: fixture.versionNo, remark: fixture.remark
      } }
      if (path === '/cost/periods/102') return { code: 0, data: period }
      return { code: 0, data: { list: [{ ...period, id: '999', period: '2026-10' }], total: 1 } }
    },
    async request (...args) { writes.push(args); return { code: 0, data: {} } }
  }
  api.postBusiness = (path, body, options) => api.request('POST', path, body, options)
  return {
    api, fixture, period, writes,
    record: { runId: 'unit-run', environment: { tenantId: '1' } },
    caseRecord: { fixtures: { costScenario: fixture } },
    settings: { target: 'local', tenantId: '1' }
  }
}

test('period evidence is reread by registered IDs and never falls back to shared list rows', async () => {
  const input = setup()
  const api = await scopedCostScenarioApi(input)
  const response = await api.getBusiness('/cost/periods?accountingOrgId=1&pageNo=1&pageSize=100')
  assert.deepEqual(response.data.list, [input.period])
  assert.equal(response.data.total, 1)
  assert.equal(input.writes.length, 0)
})

test('non-owned periods, trials, publications and shared workspace writes fail before network mutation', async () => {
  const input = setup()
  const api = await scopedCostScenarioApi(input)
  for (const path of [
    '/cost/periods/999/trials', '/cost/trials/999/confirm',
    '/cost/publications/999/rollback', '/cost/workspace-states/save'
  ]) {
    await assert.rejects(() => api.request('POST', path, {}), /non-owned cost mutation/)
  }
  await assert.rejects(() => api.postBusiness('/cost/periods', {
    accountingOrgId: 1, modelVersion: 'shared', period: '2026-10'
  }), /non-owned cost mutation/)
  assert.equal(input.writes.length, 0)
  await api.request('POST', '/cost/periods/102/source-snapshot/purchase/refresh')
  assert.equal(input.writes.length, 1)
})

test('tenant, run and persisted model marker mismatch do not grant period write ownership', async () => {
  for (const mutate of [
    (input) => { input.record.environment.tenantId = '2' },
    (input) => { input.fixture.runId = 'old-run' },
    (input) => { input.fixture.remark = 'E2E named but shared' },
    (input) => { input.period.modelVersionId = '999' }
  ]) {
    const input = setup()
    mutate(input)
    await assert.rejects(() => scopedCostScenarioApi(input), /BLOCKED/)
    assert.equal(input.writes.length, 0)
  }
})

test('COST-001 suite delegates the enabled write closure and keeps incomplete catalog assertions GAP', async () => {
  const record = { runId: 'unit', environment: { tenantId: '1' } }
  const caseRecord = { id: 'COST-001', caseId: 'COST-001', checks: [], evidence: [], notes: [] }
  let called = 0
  const result = await runCase({ caseId: 'COST-001', page: {}, record, caseRecord }, {
    login: async () => 'token',
    createApiClient: () => ({}),
    writeFixtures: true,
    runCostAllocationClosure: async (input) => {
      called++
      assert.equal(input.caseRecord, caseRecord)
    }
  })
  assert.equal(called, 1)
  assert.equal(result.token, 'token')
  assert.equal(caseRecord.passCandidate, false)
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
})
