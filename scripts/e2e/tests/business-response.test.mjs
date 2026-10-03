import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createCipheriv } from 'node:crypto'
import { assertBusinessSuccess, isBusinessSuccess } from '../lib/assertions.mjs'
import { encryptRequest, decryptResponse } from '../lib/crypto.mjs'

test('supports CommonResult and the legacy Result success contracts', () => {
  for (const body of [{ code: 0, data: [] }, { code: 200, success: true, data: [] }]) {
    assert.equal(isBusinessSuccess(body), true)
    assert.equal(assertBusinessSuccess(body, 'probe'), body)
  }
})

test('HTTP success, conflicting success markers and errors cannot pass', () => {
  for (const body of [
    undefined, {}, { status: 200 }, { code: 200 }, { code: 200, success: false },
    { code: 0, success: false }, { code: 500, success: true }, { code: 403 }
  ]) {
    assert.equal(isBusinessSuccess(body), false)
    assert.throws(() => assertBusinessSuccess(body, 'probe'), /business failure/)
  }
})

test('encrypted requests and responses use environment-specific keys', (t) => {
  const before = {
    request: process.env.CFOR_API_ENCRYPT_REQUEST_KEY,
    response: process.env.CFOR_API_ENCRYPT_RESPONSE_KEY
  }
  t.after(() => {
    for (const [name, value] of [
      ['CFOR_API_ENCRYPT_REQUEST_KEY', before.request],
      ['CFOR_API_ENCRYPT_RESPONSE_KEY', before.response]
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  process.env.CFOR_API_ENCRYPT_REQUEST_KEY = 'r'.repeat(32)
  process.env.CFOR_API_ENCRYPT_RESPONSE_KEY = 's'.repeat(32)
  const input = { message: 'environment contract' }
  const decipher = createDecipheriv('aes-256-ecb', Buffer.from('r'.repeat(32)), null)
  const plain = Buffer.concat([
    decipher.update(encryptRequest(input), 'base64'), decipher.final()
  ]).toString()
  assert.deepEqual(JSON.parse(plain), input)
  const cipher = createCipheriv('aes-256-ecb', Buffer.from('s'.repeat(32)), null)
  const response = Buffer.concat([
    cipher.update(JSON.stringify(input)), cipher.final()
  ]).toString('base64')
  assert.deepEqual(decryptResponse(response), input)
})
