import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasOutsourceBusinessFixture,
  hasOutsourcePaymentFixture,
  outsourceListRows,
  outsourceReadySelector,
  outsourceRoute,
  paymentRequestReadySelector,
  paymentRequestRoute,
  paymentSourceReadySelector
} from '../suites/mes-outsource.mjs'

test('委外专项使用真实菜单路由和页面就绪选择器', () => {
  assert.equal(outsourceRoute, '/mes/produce/outsource/outsource-work')
  assert.equal(paymentRequestRoute, '/mes/produce/outsource/payment-request')
  assert.match(outsourceReadySelector, /新增/)
  assert.match(paymentRequestReadySelector, /新增/)
  assert.match(paymentSourceReadySelector, /选委外应付/)
})

test('空委外订单和付款来源不能被识别为完整业务前置', () => {
  assert.equal(hasOutsourceBusinessFixture([]), false)
  assert.equal(hasOutsourceBusinessFixture([{ billNo: 'NO_ID' }]), false)
  assert.equal(hasOutsourceBusinessFixture([{ id: 1 }]), true)
  assert.equal(hasOutsourcePaymentFixture([]), false)
  assert.equal(hasOutsourcePaymentFixture([{ entryId: 1, uncheckedAmt: 0 }]), false)
  assert.equal(hasOutsourcePaymentFixture([{ entryId: 1, uncheckedAmt: 10 }]), true)
})

test('委外专项不会把无效响应对象伪造成空列表', () => {
  assert.deepEqual(outsourceListRows({ data: { records: [{ id: 1 }] } }), [{ id: 1 }])
  assert.deepEqual(outsourceListRows({ data: { list: [{ id: 2 }] } }), [{ id: 2 }])
  assert.throws(() => outsourceListRows({ data: {} }), /必须返回数组/)
})
