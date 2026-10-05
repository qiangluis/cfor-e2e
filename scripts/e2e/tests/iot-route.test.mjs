import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IOT_011_ROUTE,
  IOT_012_ROUTE
} from '../suites/iot.mjs'

test('IOT-011 and IOT-012 use the menu-derived device routes', () => {
  assert.equal(IOT_011_ROUTE, '/iot/device/write-back-dead-letter')
  assert.equal(IOT_012_ROUTE, '/iot/device/device-change-audit')
})
