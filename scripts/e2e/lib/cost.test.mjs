import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertCostWriteScope,
  costPage,
  preciseCostId,
  unwrapCostData,
  unwrapCostList
} from './cost.mjs'

test('cost IDs remain exact strings, including signed bigint maximum', () => {
  assert.equal(preciseCostId('9223372036854775807'), '9223372036854775807')
  assert.equal(preciseCostId(42), '42')
  assert.throws(() => preciseCostId(9223372036854775808n), /数据库 ID/)
  assert.throws(() => preciseCostId('9223372036854775808'), /数据库 ID/)
})

test('cost response helpers unwrap envelope, nested envelope, pages and raw arrays', () => {
  assert.deepEqual(unwrapCostData({ code: 0, data: { data: { id: '7' } } }), { id: '7' })
  assert.deepEqual(unwrapCostList({ code: 0, data: { list: [{ id: '7' }] } }), [{ id: '7' }])
  assert.deepEqual(unwrapCostList({ code: 0, data: [{ id: '7' }] }), [{ id: '7' }])
  assert.deepEqual(costPage({ code: 0, data: { list: [], total: 0 } }), { list: [], total: 0 })
  assert.throws(() => unwrapCostList({ code: 0, data: {} }), /缺少数组/)
})

test('cost write scope fails closed before any business API write', () => {
  const base = {
    record: {
      runId: '202610141200-1',
      environment: { tenantId: '1', apiBase: 'http://127.0.0.1:48083/admin-api' }
    },
    caseRecord: { id: 'COST-030' },
    caseId: 'COST-030'
  }
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    assert.throws(() => assertCostWriteScope(base), /local:48083/)
    assert.throws(() => assertCostWriteScope({
      ...base,
      record: {
        ...base.record,
        environment: { ...base.record.environment, tenantId: '2' }
      }
    }), /local:48083/)
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})
