import assert from 'node:assert/strict'
import test from 'node:test'

import {
  arrayPayload,
  isSuccessfulPayload,
  listPayload,
  readinessItemsPayload
} from '../suites/init.mjs'

test('init suite recognizes only successful CommonResult payloads', () => {
  assert.equal(isSuccessfulPayload({ code: 0, data: [] }), true)
  assert.equal(isSuccessfulPayload({ code: 200, success: true, data: [] }), true)
  assert.equal(isSuccessfulPayload({ code: 500, data: [] }), false)
  assert.equal(isSuccessfulPayload({ code: 0, success: false, data: [] }), false)
})

test('init suite preserves response shape and does not turn malformed data into empty evidence', () => {
  assert.deepEqual(listPayload({ code: 0, data: { list: [] } }), [])
  assert.equal(listPayload({ code: 0, data: { error: 'failed' } }), null)
  assert.deepEqual(arrayPayload({ code: 0, data: [] }), [])
  assert.equal(arrayPayload({ code: 0, data: { list: [] } }), null)
  assert.deepEqual(readinessItemsPayload({ code: 0, data: { items: [] } }), [])
  assert.equal(readinessItemsPayload({ code: 0, data: {} }), null)
})
