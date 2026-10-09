import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient, serverApiFailures } from '../lib/api.mjs'
import {
  releasedLifecycleRejections,
  verifyReleasedLifecycleGuards
} from '../suites/mes-outsource.mjs'

function fixture ({ message, statusVersion = 4, auditCount = 1 } = {}) {
  const id = '2108397028208615426'
  const baseline = { id, outsourceStatus: 'RELEASED', statusVersion: 4, totalAmount: 20 }
  const logs = [{ id: '2108397028208615427', outsourceId: id, actionType: 'RELEASE' }]
  const requests = []
  const api = {
    put: async (path, body, options) => {
      const action = path.includes('/close?') ? 'close' : 'reopen'
      requests.push({ path, body, options })
      return { code: 500, msg: message ?? releasedLifecycleRejections[action].message }
    },
    getBusiness: async (path) => ({
      data: path.includes('/queryById?')
        ? { ...baseline, statusVersion }
        : Array.from({ length: auditCount }, (_, index) => ({
          ...logs[0], id: String(BigInt(logs[0].id) + BigInt(index))
        }))
    })
  }
  return { api, id, baseline, logs, requests }
}

test('released close/reopen require exact legacy contracts and unchanged facts', async () => {
  const f = fixture()
  const result = await verifyReleasedLifecycleGuards(f.api, f.id, f.baseline, f.logs)
  assert.ok(result.checks.every((check) => check.passed))
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[0].options.expectedBusinessRejection, releasedLifecycleRejections.close)
  assert.equal(f.requests[1].options.expectedBusinessRejection, releasedLifecycleRejections.reopen)
})

test('system errors containing lifecycle words cannot satisfy negative assertions', async () => {
  const f = fixture({ message: '系统异常：只有已完成的委外单可以关闭：已下达' })
  const result = await verifyReleasedLifecycleGuards(f.api, f.id, f.baseline, f.logs)
  assert.ok(result.checks.every((check) => !check.passed))
})

test('version drift or added audit rows after rejection fail the guard', async () => {
  for (const options of [{ statusVersion: 5 }, { auditCount: 2 }]) {
    const f = fixture(options)
    const result = await verifyReleasedLifecycleGuards(f.api, f.id, f.baseline, f.logs)
    assert.ok(result.checks.every((check) => !check.passed))
  }
})

test('shared or unverified baseline is rejected before a lifecycle request', async () => {
  const f = fixture()
  await assert.rejects(
    verifyReleasedLifecycleGuards(f.api, f.id, { ...f.baseline, id: 'other' }, f.logs),
    /专属下达单/
  )
  assert.equal(f.requests.length, 0)
})

test('API recorder exempts only the explicitly matched domain refusal', async () => {
  const originalFetch = globalThis.fetch
  try {
    const record = { api: [] }
    const api = createApiClient({ token: 'unit-test', record })
    for (const message of [
      releasedLifecycleRejections.close.message, '系统异常', '只有已完成的委外单可以关闭：执行中'
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ code: 500, msg: message }))
      await api.put('/mes/prodOutsource/close?id=unit', undefined, {
        expectedBusinessRejection: releasedLifecycleRejections.close
      })
    }
    assert.equal(record.api[0].expectedBusinessRejectionMatched, true)
    assert.equal(serverApiFailures(record.api).length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
