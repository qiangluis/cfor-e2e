import test from 'node:test'
import assert from 'node:assert/strict'
import { recordWipAcceptance, verifyDedicatedWip, wipCatalogAssertions } from '../suites/mes-outsource.mjs'

const prerequisite = {
  unitId: '12',
  component: { id: '101' },
  opening: { batchNo: '0' },
  storage: { warehouse: { id: '102' }, area: { id: '103' }, location: { id: '104' } }
}
const balance = {
  materialId: '101', unitId: '12', batchNo: '0', snNo: null,
  warehouseId: '102', wareAreaId: '103', wareLocationId: '104',
  issuedQty: 1, returnedQty: 0, consumedQty: 0, balanceQty: 1
}

test('dedicated WIP requires actual inventory dimensions and 1/0/0/1 conservation', () => {
  assert.equal(verifyDedicatedWip([balance], prerequisite), true)
  for (const change of [
    { wareLocationId: null }, { materialId: 'other' }, { balanceQty: 2 },
    { consumedQty: null }, { returnedQty: undefined }, { batchNo: 'wrong' }
  ]) assert.equal(verifyDedicatedWip([{ ...balance, ...change }], prerequisite), false)
  assert.equal(verifyDedicatedWip([], prerequisite), false)
  assert.equal(verifyDedicatedWip([balance, balance], prerequisite), false)
})

test('WIP catalog mapping records only exact supported assertions as VERIFIED', () => {
  const record = {}
  recordWipAcceptance(record, [{ passed: true, details: 'API+DB' }, { passed: false, details: 'UI mismatch' }])
  assert.deepEqual(record.catalogAssertions.map((row) => row.index), [0, 1, 2])
  assert.deepEqual(record.catalogAssertions.map((row) => row.assertion), wipCatalogAssertions)
  assert.deepEqual(record.catalogAssertions.map((row) => row.status), ['VERIFIED', 'GAP', 'GAP'])
  assert.equal(record.remainingAssertions.length, 2)
})
