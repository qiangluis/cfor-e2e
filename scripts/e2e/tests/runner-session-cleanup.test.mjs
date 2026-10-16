import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeSuiteSessions } from '../runner.mjs'

test('runner awaits supported suite teardown before returning, including early-stop paths', async () => {
  const record = { cases: [{ id: 'CRM-BASE-001', suite: 'crm', checks: [], notes: [], status: 'PASS' }] }
  const calls = []
  await finalizeSuiteSessions(new Map([
    ['init', {}],
    ['crm', { teardownRun: async ({ record: actual }) => {
      await Promise.resolve()
      assert.equal(actual, record)
      calls.push('closed')
    } }]
  ]), record)
  assert.deepEqual(calls, ['closed'])
  assert.equal(record.cases[0].status, 'PASS')
})

test('teardown failures invalidate their own suite instead of disappearing after a PASS', async () => {
  const record = { cases: [
    { id: 'CRM-BASE-001', suite: 'crm', checks: [], notes: [], status: 'PASS' },
    { id: 'OTHER', suite: 'other', checks: [], notes: [], status: 'PASS' }
  ] }
  await finalizeSuiteSessions(new Map([
    ['crm', { teardownRun: async () => { throw new Error('deactivation failed') } }]
  ]), record)
  assert.equal(record.cases[0].status, 'FAIL')
  assert.equal(record.cases[0].checks.at(-1).passed, false)
  assert.match(record.cases[0].notes.at(-1), /deactivation failed/)
  assert.equal(record.cases[1].status, 'PASS')
})
