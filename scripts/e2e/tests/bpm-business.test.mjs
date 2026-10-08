import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalValues, validateApprovalSnapshot } from '../suites/bpm-business.mjs'

const expected = { no: 'E2E-OUT-1', tag: 'E2E-SALES-UNIT', materialId: '901' }
const snapshot = () => ({
  billNo: expected.no, quantity: 2, amount: 177.6, partnerName: expected.tag,
  creatorName: 'E2E 管理员', businessDate: '2026-10-07',
  items: [{
    productId: '901', productCode: expected.tag, productName: expected.tag,
    productUnitName: '个', warehouseName: 'E2E 仓库', count: 2, productPrice: 88.8
  }]
})

test('approval regression requires populated header, names and exact owned detail', () => {
  assert.doesNotThrow(() => validateApprovalSnapshot(snapshot(), expected))
  for (const change of [
    { billNo: 'FOREIGN' }, { quantity: null }, { amount: 0 }, { partnerName: '' },
    { creatorName: '' }, { businessDate: '' }, { items: [] },
    { items: [{ ...snapshot().items[0], productId: '902' }] },
    { items: [{ ...snapshot().items[0], productUnitName: '' }] },
    { items: [{ ...snapshot().items[0], warehouseName: '' }] }
  ]) assert.throws(() => validateApprovalSnapshot({ ...snapshot(), ...change }, expected))
})

test('warehouse and finance inputs are distinct approval evidence, not stock writes', () => {
  assert.equal(approvalValues.approvedQty.value, 2)
  assert.equal(approvalValues.approvedUnitPrice.value, 88.8)
  assert.ok(approvalValues.approvedWarehouse.label)
  assert.ok(approvalValues.approvedLocation.label)
})
