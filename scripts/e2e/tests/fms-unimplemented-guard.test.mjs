import test from 'node:test'
import assert from 'node:assert/strict'
import { ownedCases, money, numericId, ownedKey, balancedDraft } from '../fmshelper/contracts.mjs'

test('FMS-003 and FMS-004 are owned by the real runner, not the old unimplemented stub', () => {
  assert.deepEqual(ownedCases, ['FMS-001', 'FMS-002', 'FMS-003', 'FMS-004', 'FMS-005',
    'FMS-006', 'FMS-007'])
})

test('FMS helper keeps money and fixture ownership checks strict', () => {
  assert.equal(money('123.45'), 12345)
  assert.equal(money('-0.10'), -10)
  assert.equal(numericId('2107455388355596289'), '2107455388355596289')
  assert.equal(ownedKey('E2E-FMS-FMS-003-ABC-123'), 'E2E-FMS-FMS-003-ABC-123')
  assert.equal(numericId('9007199254740993'), '9007199254740993')
  assert.throws(() => numericId(9007199254740993))
  assert.throws(() => ownedKey('E2E-OTHER-123'))
})

test('balancedDraft requires equal debit and credit totals', () => {
  const draft = {
    debitTotal: '123.45',
    creditTotal: '123.45',
    entries: [
      { direction: 'DEBIT', amount: '123.45' },
      { direction: 'CREDIT', amount: '123.45' }
    ]
  }
  assert.equal(balancedDraft(draft, '123.45'), true)
  assert.equal(balancedDraft({ ...draft, creditTotal: '123.44' }, '123.45'), false)
})
