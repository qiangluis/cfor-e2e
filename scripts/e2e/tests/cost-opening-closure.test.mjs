import assert from 'node:assert/strict'
import test from 'node:test'
import { COST_OPENING_CHECKS, runCostOpeningClosure } from '../fixtures/cost-opening-closure.mjs'

const setup = ({ failLock = false, failCleanup = false, initialRows = [] } = {}) => {
  const material = { id: '2109500602170789890', code: 'E2E-MAT', isEnabled: 1 }
  const fixture = {
    caseId: 'COST-002',
    tenantId: '1', runId: 'unit-run', scenario: 'accounting', suffix: 'OWN',
    month: '2099-12', effectiveMonth: '2099-12',
    versionNo: 'E2E-SC-ACCOUNTING-OWN',
    remark: 'CFOR-E2E:costScenario:accounting:unit-run:OWN:tenant=1:org=1:month=2099-12',
    periodId: '101', modelId: '102', costCenterId: '301',
    period: { status: 'ACCOUNTING' }
  }
  const center = {
    id: '301', accountingOrgId: 1, status: 'ENABLED', code: 'E2E-SC-OWN',
    name: 'E2E成本场景中心OWN', remark: fixture.remark
  }
  let rows = initialRows
  const writes = []
  const read = () => structuredClone(rows)
  const api = {
    async getBusiness (path) {
      if (path === '/cost/centers/301') return { code: 0, data: center }
      if (path.includes('/list/dictText')) return { code: 0, data: { records: [material] } }
      if (path.includes('/queryById')) return { code: 0, data: material }
      if (path === '/cost/model-versions/102') {
        return {
          code: 0,
          data: {
            id: '102', accountingOrgId: 1, versionNo: fixture.versionNo,
            enterpriseType: 'MANUFACTURING', effectiveMonth: fixture.month,
            status: 'LOCKED', remark: fixture.remark
          }
        }
      }
      if (path === '/cost/periods/101') {
        return {
          code: 0,
          data: {
            id: '101', accountingOrgId: 1, period: fixture.month,
            modelVersionId: fixture.modelId, modelVersionNo: fixture.versionNo,
            enterpriseType: 'MANUFACTURING', status: 'ACCOUNTING',
            currentPublicationId: null
          }
        }
      }
      return { code: 0, data: read() }
    },
    async putBusiness (path, payload) {
      writes.push({ path, payload })
      rows = payload.map((row) => ({ ...row, id: '201', periodId: '101', status: 'DRAFT', version: 0 }))
      return { code: 0, data: read() }
    },
    async put (path, payload) {
      writes.push({ path, payload })
      const message = rows[0]?.status === 'LOCKED'
        ? 'Confirmed or locked opening WIP cannot be overwritten'
        : payload[0].totalAmount !== 130
          ? '第2行：Total amount must equal material, labor and expense amounts'
          : '第2行：Unit cost must equal total amount divided by quantity'
      return { code: 422001, msg: message }
    },
    async postBusiness (path) {
      writes.push({ path })
      if (path.includes('/confirm')) {
        rows[0] = { ...rows[0], status: 'CONFIRMED', confirmedBy: '1', confirmedAt: 'now' }
      } else if (path.includes('/lock')) {
        if (failLock) throw new Error('lock failed')
        rows[0] = { ...rows[0], status: 'LOCKED', lockedBy: '1', lockedAt: 'now' }
      } else if (path.includes('/reverse')) {
        if (failCleanup) throw new Error('cleanup reverse failed')
        rows[0] = {
          ...rows[0], status: 'REVERSED', reversedBy: '1', reversedAt: 'now',
          reverseReason: fixture.remark
        }
      }
      return { code: 0, data: read() }
    }
  }
  return {
    api, writes, center,
    record: {
      runId: 'unit-run',
      environment: { target: 'local', tenantId: '1' }
    },
    caseRecord: {
      id: 'COST-002',
      caseId: 'COST-002',
      fixtures: { costScenario: fixture },
      checks: []
    },
    dependencies: {
      writeFixtures: true,
      config: { target: 'local', tenantId: '1' },
      assertLocalDatabase: async () => {}
    },
    read
  }
}

test('opening closure writes precise material IDs, proves numeric guards and reads every state transition', async () => {
  const input = setup()
  await runCostOpeningClosure({ ...input, dependencies: input.dependencies })
  assert.deepEqual(input.caseRecord.checks.map((row) => row.name), Object.values(COST_OPENING_CHECKS))
  assert.ok(input.caseRecord.checks.every((row) => row.passed))
  assert.equal(input.read()[0].status, 'REVERSED')
  assert.equal(input.writes[0].payload[0].materialId, '2109500602170789890')
  assert.equal(input.writes[0].payload[0].costCenterCode, 'E2E-SC-OWN')
})

test('opening closure rejects existing formal rows before any overwrite', async () => {
  const input = setup({ initialRows: [{ remark: 'shared' }] })
  await assert.rejects(() => runCostOpeningClosure({ ...input, dependencies: input.dependencies }), /拒绝覆盖/)
  assert.equal(input.writes.length, 0)
})

test('opening closure reverses its owned rows after an operation failure', async () => {
  const input = setup({ failLock: true })
  await assert.rejects(() => runCostOpeningClosure({ ...input, dependencies: input.dependencies }), /lock failed/)
  assert.equal(input.read()[0].status, 'REVERSED')
  assert.equal(input.caseRecord.checks.at(-1).passed, true)
})

test('opening closure cannot swallow operation and cleanup failures', async () => {
  const input = setup({ failLock: true, failCleanup: true })
  await assert.rejects(() => runCostOpeningClosure({ ...input, dependencies: input.dependencies }), /lock failed; .*cleanup reverse failed/)
  assert.equal(input.caseRecord.checks.at(-1).passed, false)
})

test('browser observer runs after numeric rejections while draft is still unconfirmed', async () => {
  const input = setup()
  const observed = []
  const result = await runCostOpeningClosure({
    ...input,
    dependencies: input.dependencies,
    async onDraft ({ fixture, openingRow }) {
      observed.push(openingRow)
      assert.equal(fixture.periodId, '101')
      assert.equal(openingRow.status, 'DRAFT')
      assert.equal(openingRow.costCenterCode, 'E2E-SC-OWN')
      assert.equal(input.writes.length, 3)
      assert.equal(input.caseRecord.checks.length, 4)
      openingRow.remark = 'observer-copy'
      assert.equal(input.read()[0].remark, fixture.remark)
    }
  })
  assert.equal(observed.length, 1)
  assert.equal(result.openingRow.status, 'REVERSED')
})

test('failed browser evidence cannot confirm and still reverses owned draft', async () => {
  const input = setup()
  await assert.rejects(() => runCostOpeningClosure({
    ...input,
    dependencies: input.dependencies,
    onDraft: async () => { throw new Error('real browser failed') }
  }), /real browser failed/)
  assert.equal(input.read()[0].status, 'REVERSED')
  assert.equal(input.writes.some((write) => write.path.includes('/confirm')), false)
  assert.equal(input.caseRecord.checks.at(-1).passed, true)
})

test('shared or imprecise center identity is rejected before any write or observer', async () => {
  for (const mutation of [
    (input) => { input.center.id = 301 },
    (input) => { input.center.remark = 'shared' },
    (input) => { input.center.code = 'shared' },
    (input) => { input.center.accountingOrgId = 2 }
  ]) {
    const input = setup()
    mutation(input)
    await assert.rejects(() => runCostOpeningClosure({
      ...input,
      dependencies: input.dependencies,
      onDraft: async () => assert.fail('must not observe a shared center')
    }), /不是本轮专属中心/)
    assert.equal(input.writes.length, 0)
  }
})
