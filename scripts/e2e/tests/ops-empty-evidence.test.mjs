import test from 'node:test'
import assert from 'node:assert/strict'
import { hasDeadLetterSamples } from '../suites/cost.mjs'
import { dataOf, hasFormalMetricEvidence } from '../suites/iot-maintenance.mjs'

test('empty or malformed dead-letter data cannot prove a complete Outbox case', () => {
  assert.equal(hasDeadLetterSamples([]), false)
  assert.equal(hasDeadLetterSamples(undefined), false)
  assert.equal(hasDeadLetterSamples({}), false)
  assert.equal(hasDeadLetterSamples([{ id: 1 }]), true)
})

test('IoT capability and Modbus responses are unwrapped before reading fields', () => {
  const catalog = { serializeTypes: [{ value: 'json' }] }
  const points = { list: [], total: 0 }
  assert.deepEqual(dataOf({ code: 0, data: catalog }), catalog)
  assert.deepEqual(dataOf({ code: 0, data: points }), points)
})

test('one-sided device facts still do not prove complete metric evidence', () => {
  assert.equal(hasFormalMetricEvidence({ statusEvents: [{ id: 1 }], drilldown: [] }), false)
  assert.equal(hasFormalMetricEvidence({ statusEvents: [], drilldown: [{ id: 1 }] }), false)
})
