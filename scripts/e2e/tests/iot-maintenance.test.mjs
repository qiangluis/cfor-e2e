import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dataOf,
  hasFormalMetricEvidence,
  hasExactDeviceStatusMapping,
  MAINT_008_REPAIR_ORDER_ROUTE,
  MAINT_009_INSPECTION_RECORD_ROUTE,
  MAINT_011_DEVICE_STATUS_ROUTE
} from '../suites/iot-maintenance.mjs'

test('MAINT-008 and MAINT-009 preserve the menu-derived maintenance routes', () => {
  assert.equal(MAINT_008_REPAIR_ORDER_ROUTE, '/iot/maintenance/repair-order')
  assert.equal(MAINT_009_INSPECTION_RECORD_ROUTE, '/iot/maintenance/inspection-record')
})

test('MAINT-011 unwraps CommonResult data before reading business payloads', () => {
  const payload = { list: [{ id: 'device-1' }], total: 1 }
  assert.deepEqual(dataOf({ code: 0, data: payload, msg: '' }), payload)
  assert.deepEqual(dataOf(payload), payload)
})

test('MAINT-011 uses the menu-derived device status route', () => {
  assert.equal(MAINT_011_DEVICE_STATUS_ROUTE, '/iot/maintenance/device-status')
})

test('MAINT-011 does not treat empty status and repair facts as complete evidence', () => {
  assert.equal(
    hasFormalMetricEvidence({ statusEvents: [], drilldown: [] }),
    false
  )
  assert.equal(
    hasFormalMetricEvidence({
      statusEvents: [{ id: 'event-1' }],
      drilldown: [{ orderId: 'order-1' }]
    }),
    true
  )
})

test('IOT-006 requires exact mapping identity, layer, core state, subtype and enabled status', () => {
  const expected = {
    id: '9007199254740993', coreLayer: 'RUNTIME', coreState: 'RUNNING',
    subStateCode: 'E2E-RUN', subStateName: '正常运行', status: 0
  }
  assert.equal(hasExactDeviceStatusMapping({ ...expected }, expected), true)
  assert.equal(hasExactDeviceStatusMapping(null, expected), false)
  for (const field of Object.keys(expected)) {
    assert.equal(hasExactDeviceStatusMapping({ ...expected, [field]: null }, expected), false, field)
  }
  assert.equal(hasExactDeviceStatusMapping({ ...expected, coreLayer: 'ASSET' }, expected), false)
  assert.equal(hasExactDeviceStatusMapping({ ...expected, status: '0' }, expected), false)
})
