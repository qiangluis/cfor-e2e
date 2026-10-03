import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAccessToken } from '../lib/session.mjs'
import { assertLocalDatabase } from '../lib/db.mjs'

const access = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
test('reads the actual web-storage-cache access value, never refresh or JSON wrapper', () => {
  assert.equal(extractAccessToken([
    ['REFRESH_TOKEN', JSON.stringify({ c: 1, e: 100, v: 'refresh-secret-with-long-value' })],
    ['ACCESS_TOKEN', JSON.stringify({ c: 1, e: 100, v: access })]
  ], 50), access)
  assert.equal(extractAccessToken([
    ['ACCESS_TOKEN', JSON.stringify({ c: 1, e: 100, v: JSON.stringify(access) })]
  ], 50), access)
})
test('supports a raw access token and rejects expired or malformed values', () => {
  assert.equal(extractAccessToken([['accessToken', `Bearer ${access}`]]), access)
  assert.equal(extractAccessToken([['ACCESS_TOKEN', JSON.stringify({ e: 10, v: access })]], 11), '')
  assert.equal(extractAccessToken([['ACCESS_TOKEN', '{"some":"long-json-is-not-a-token"}']]), '')
  assert.equal(extractAccessToken([['REFRESH_TOKEN', access], ['loginForm', access]]), '')
})
test('database assertions cannot read a production host, alternate port or database', () => {
  const db = { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
  assert.doesNotThrow(() => assertLocalDatabase(db))
  for (const override of [
    { host: 'example.com' }, { port: '3307' }, { name: 'cfor_admin_saas_standard' }
  ]) assert.throws(() => assertLocalDatabase({ ...db, ...override }), /only allow loopback/)
})
