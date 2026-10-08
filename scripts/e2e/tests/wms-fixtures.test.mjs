import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WMS_FIXTURE_MARK,
  assertLocalWmsWriteTarget,
  fixtureCode,
  fixtureToken,
  isOwnedFixture,
  isWmsWriteEnabled,
  pageRows
} from '../lib/wms-fixtures.mjs'

test('WMS write fixtures require exact opt-in and local tenant target', () => {
  assert.equal(isWmsWriteEnabled({ CFOR_E2E_WRITE_FIXTURES: 'true' }), true)
  assert.equal(isWmsWriteEnabled({ CFOR_E2E_WRITE_FIXTURES: '1' }), false)
  assert.throws(() => assertLocalWmsWriteTarget({ tenantId: '2' }), /租户 1/)
  assert.doesNotThrow(() => assertLocalWmsWriteTarget({ tenantId: '1', tenantName: 'CFOR 标准平台' }))
})

test('WMS fixture ownership is token and marker scoped', () => {
  const token = fixtureToken('TEST')
  assert.match(token, /^E2E-WMS-TEST-/)
  assert.equal(isOwnedFixture({ code: `${token}-WH-1`, name: 'warehouse' }, token), true)
  assert.equal(isOwnedFixture({ code: 'shared', name: 'shared' }, token), false)
  assert.equal(isOwnedFixture({ remark: WMS_FIXTURE_MARK }, 'other-token'), true)
})

test('WMS fixture codes are stable, distinct, and within the 32 character limit', () => {
  const token = fixtureToken('CODE')
  const codes = ['WH', 'AR', 'LC', 'MT'].map((kind) => fixtureCode(token, kind, 1))
  assert.deepEqual(fixtureCode(token, 'WH', 1), fixtureCode(token, 'WH', 1))
  assert.equal(new Set(codes).size, codes.length)
  assert.ok(codes.every((code) => code.length <= 32))
  assert.notEqual(fixtureCode(token, 'WH', 1), fixtureCode(token, 'WH', 2))
})

test('WMS stock IO bill numbers are short and deterministic per fixture kind', () => {
  const token = fixtureToken('IO')
  const billNo = fixtureCode(token, 'IO', 106)
  assert.equal(billNo, fixtureCode(token, 'IO', 106))
  assert.ok(billNo.length <= 32)
})

test('WMS pageRows rejects malformed page and preserves empty valid page', () => {
  assert.deepEqual(pageRows({ code: 0, data: { list: [] }}).rows, [])
  assert.deepEqual(pageRows({ code: 0, data: { records: [{ id: '1' }] }}).rows, [{ id: '1' }])
  assert.throws(() => pageRows({ code: 0, data: {} }), /未返回数组/)
})
