import test from 'node:test'
import assert from 'node:assert/strict'
import { createFixtureCleanup, trackDeviceRuntimeCleanup } from '../suites/iot-maintenance.mjs'

test('metrics failure cleanup ends the workflow-created runtime event before removing the device', async () => {
  const record = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-011', caseRecord: record })
  const calls = []
  let ended = false
  fixtures.track('9001', 'device', async () => { calls.push('delete-device') })
  const api = {
    getBusiness: async () => ({ code: 0, data: {
      id: '202', deviceId: '9001', coreLayer: 'RUNTIME', active: !ended,
      startTime: '2026-10-11T10:00:00', endTime: ended ? '2026-10-11T10:01:00' : null
    } }),
    putBusiness: async (path, body) => {
      assert.equal(path, '/mes/device-status-event/end')
      assert.equal(body.id, '202')
      calls.push('end-event')
      ended = true
      return { code: 0, data: true }
    }
  }
  trackDeviceRuntimeCleanup(fixtures, api, '9001')
  await fixtures.cleanup(true)
  assert.deepEqual(calls, ['end-event', 'delete-device'])
  assert.equal(record.checks.every((item) => item.passed), true)
  assert.match(record.checks[0].details, /已结束/)
})

test('metrics cleanup refuses a runtime event owned by another device', async () => {
  const record = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-011', caseRecord: record })
  trackDeviceRuntimeCleanup(fixtures, {
    getBusiness: async () => ({ code: 0, data: { id: '202', deviceId: '9002', coreLayer: 'RUNTIME' } }),
    putBusiness: async () => assert.fail('must not end a foreign event')
  }, '9001')
  await fixtures.cleanup(true)
  assert.equal(record.checks[0].passed, false)
  assert.match(record.notes[0], /所有权不一致/)
})

test('metrics cleanup does not invent an event when the device has no active runtime', async () => {
  const record = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-011', caseRecord: record })
  trackDeviceRuntimeCleanup(fixtures, {
    getBusiness: async () => ({ code: 0, data: null }),
    putBusiness: async () => assert.fail('must not create or end an event')
  }, '9001')
  await fixtures.cleanup(false)
  assert.equal(record.checks[0].passed, true)
})
