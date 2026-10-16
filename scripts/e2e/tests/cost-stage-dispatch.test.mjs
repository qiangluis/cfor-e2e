import assert from 'node:assert/strict'
import test from 'node:test'
import { costCatalogEvidence, runCase } from '../suites/cost.mjs'
import { COST_STAGE_EVIDENCE_CHECKS } from '../fixtures/cost-stage-evidence-closure.mjs'

const context = () => ({
  caseId: 'COST-034',
  page: { async route () {} },
  record: { runId: 'unit-stage-dispatch', environment: { tenantId: '1' } },
  caseRecord: { id: 'COST-034', caseId: 'COST-034', checks: [], notes: [], evidence: [] }
})
const dependencies = {
  login: async () => 'unit-token',
  createApiClient: () => new Proxy({}, {
    get () { assert.fail('Stage dispatch must not discover shared models or periods') }
  })
}

test('COST-034 dispatches before generic model/period discovery and reuses its page/token', async () => {
  const input = context()
  const result = await runCase(input, {
    ...dependencies,
    writeFixtures: true,
    runCostStageEvidenceClosure: async (stage, options) => {
      assert.equal(stage.page, input.page)
      assert.equal(stage.token, 'unit-token')
      assert.equal(stage.caseRecord, input.caseRecord)
      assert.equal(options.writeFixtures, true)
      return { acceptanceComplete: false, partial: true }
    }
  })
  assert.equal(result.partial, true)
  assert.equal(input.caseRecord.catalogComplete, false)
})

test('COST-034 disabled writes leave all assertions GAP without touching generic APIs', async () => {
  const input = context()
  const result = await runCase(input, { ...dependencies, writeFixtures: false })
  assert.equal(result.acceptanceComplete, false)
  assert.ok(input.caseRecord.gaps.some((gap) => gap.code === 'CONTROLLED_WRITE_DISABLED'))
  assert.ok(input.caseRecord.catalogAssertions.every((item) => item.status === 'GAP'))
})

test('COST-034 named passing checks alone never substitute for owned runtime evidence', async () => {
  const input = context()
  input.caseRecord.checks = Object.values(COST_STAGE_EVIDENCE_CHECKS)
    .map((name) => ({ name, passed: true }))
  costCatalogEvidence(input.caseId, input.caseRecord)
  assert.equal(input.caseRecord.passCandidate, false)
  assert.ok(input.caseRecord.catalogAssertions.every((item) => item.status === 'GAP'))
  const result = await runCase(input, {
    ...dependencies,
    runCostStageEvidenceClosure: async () => ({ acceptanceComplete: true, partial: false })
  })
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
})

test('COST-034 runtime errors remain failures with catalog gaps', async () => {
  const input = context()
  await assert.rejects(runCase(input, {
    ...dependencies,
    runCostStageEvidenceClosure: async () => { throw new Error('stage API failed') }
  }), /stage API failed/)
  assert.ok(input.caseRecord.checks.some((check) => check.passed === false))
  assert.equal(input.caseRecord.passCandidate, false)
})
