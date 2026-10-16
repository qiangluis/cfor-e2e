import assert from 'node:assert/strict'
import test from 'node:test'
import { withProcurementManualIqc } from '../fixtures/procurement-manual-iqc.mjs'

const makeScenario = () => {
  const original = { is_auto_check: true, create_defective_io: false, unrelated: 'keep' }
  let value = structuredClone(original)
  const policies = []
  const ok = (data) => ({ code: 0, data })
  const api = {
    async getBusiness (path) {
      if (path.startsWith('/system/config/get')) return ok({ configData: JSON.stringify(value) })
      const type = new URL(path, 'http://local').searchParams.get('billType')
      return ok({ records: policies.filter((row) => row.billType === type) })
    },
    async postBusiness (path, body) {
      if (path.startsWith('/system/config/save')) value = JSON.parse(body.configData)
      else policies.push({ ...body, id: String(policies.length + 1) })
      return ok(true)
    },
    async deleteBusiness (path) {
      const id = new URL(path, 'http://local').searchParams.get('id')
      policies.splice(policies.findIndex((row) => row.id === id), 1)
      return ok(true)
    }
  }
  return { api, original, policies, value: () => value }
}
const dependencies = {
  config: { target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台' },
  assertLocalWriteSafety: async () => {}
}

for (const fail of [false, true]) {
  test(`manual IQC restores exact tenant settings and owned policies on ${fail ? 'failure' : 'success'}`, async () => {
    const scenario = makeScenario()
    const record = { checks: [] }
    const action = () => withProcurementManualIqc(scenario.api, record, async () => {
      assert.equal(scenario.value().is_auto_check, false)
      assert.equal(scenario.policies.length, 2)
      if (fail) throw new Error('business failed')
      return 'result'
    }, dependencies)
    if (fail) await assert.rejects(action, /business failed/)
    else assert.equal(await action(), 'result')
    assert.deepEqual(scenario.value(), scenario.original)
    assert.equal(scenario.policies.length, 0)
    assert.equal(record.checks.at(-1).passed, true)
  })
}

test('manual IQC refuses a mismatching shared approval policy without changing it', async () => {
  const scenario = makeScenario()
  scenario.policies.push({ id: '9', billType: 'MesQualityInspection', mbillApprovalType: '2' })
  await assert.rejects(() => withProcurementManualIqc(scenario.api, { checks: [] }, async () => {
    assert.fail('must not execute business writes')
  }, dependencies), /不覆盖共享策略/)
  assert.deepEqual(scenario.value(), scenario.original)
  assert.equal(scenario.policies.length, 1)
})
