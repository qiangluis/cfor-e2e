import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IOT_011_ROUTE,
  IOT_012_ROUTE,
  containsE2eMarker,
  nicknameBeforeChange
} from '../suites/iot.mjs'

test('IOT-011 and IOT-012 use the menu-derived device routes', () => {
  assert.equal(IOT_011_ROUTE, '/iot/device/write-back-dead-letter')
  assert.equal(IOT_012_ROUTE, '/iot/device/device-change-audit')
})

test('IOT-012 preserves a null or empty nickname instead of using the device name', () => {
  assert.equal(nicknameBeforeChange({ nickname: null, deviceName: 'E2E-device' }), null)
  assert.equal(nicknameBeforeChange({ nickname: '', deviceName: 'E2E-device' }), '')
  assert.equal(nicknameBeforeChange({ nickname: 'original' }), 'original')
})

test('IOT-011 accepts only explicit E2E identity markers, not error or payload mentions', () => {
  assert.equal(containsE2eMarker({ idempotentKey: 'E2E-IOT-011-fixture' }), true)
  assert.equal(containsE2eMarker({ messageId: 'iot-E2E-011' }), true)
  assert.equal(containsE2eMarker({ identifier: 'deviceE2Euser' }), false)
  assert.equal(containsE2eMarker({ lastError: 'E2E test failed', payload: 'E2E' }), false)
})
