import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLoginContext } from '../lib/session.mjs'

const token = 'test-access-token-with-sufficient-length'
const payload = (tenantId = '135', overrides = {}) => ({
  code: 0, data: { accessToken: token, tenantId }, ...overrides
})

test('login tenant context is bound to the exact token stored by the browser', () => {
  assert.deepEqual(resolveLoginContext(payload(), token), { token, tenantId: '135' })
  assert.equal(resolveLoginContext(payload(), `${token}-other`).tenantId, '')
})

test('login context never trusts failed or malformed response envelopes', () => {
  for (const body of [
    null, {}, { code: 0 }, { code: 0, data: null }, payload('135', { code: 403 }),
    payload('135', { success: false }), { data: { accessToken: token, tenantId: '135' } }
  ]) assert.equal(resolveLoginContext(body, token).tenantId, '')
})

test('login context rejects missing tokens and invalid tenant values', () => {
  for (const tenantId of [undefined, null, '', '0', '-1', '1 OR 1=1', true, {}]) {
    assert.equal(resolveLoginContext({
      code: 0, data: { accessToken: token, tenantId }
    }, token).tenantId, '')
  }
  assert.equal(resolveLoginContext(payload(), '').tenantId, '')
  assert.equal(resolveLoginContext({ code: 0, data: { tenantId: '135' } }, token).tenantId, '')
})

test('login context preserves string snowflake IDs and rejects unsafe JSON numbers', () => {
  const tenantId = '2107440015539376129'
  assert.equal(resolveLoginContext(payload(tenantId), token).tenantId, tenantId)
  assert.equal(resolveLoginContext(payload(Number(tenantId)), token).tenantId, '')
  assert.equal(resolveLoginContext(payload(135), token).tenantId, '135')
})
