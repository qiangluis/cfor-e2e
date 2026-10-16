import assert from 'node:assert/strict'
import test from 'node:test'
import { assertBusinessSuccess, isBusinessSuccess } from './assertions.mjs'

test('accepts current and legacy successful business response contracts', () => {
  for (const body of [{ code: 0, data: [] }, { code: 200, success: true, data: [] }]) {
    assert.equal(isBusinessSuccess(body), true)
    assert.equal(assertBusinessSuccess(body, 'probe'), body)
  }
})

test('rejects missing, conflicting, and failed business response contracts', () => {
  for (const body of [
    undefined,
    {},
    { code: 200 },
    { code: 200, success: false },
    { code: 0, success: false },
    { code: 500, success: true }
  ]) {
    assert.equal(isBusinessSuccess(body), false)
    assert.throws(() => assertBusinessSuccess(body, 'probe'), /business failure/)
  }
})
