import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { assistAmount } from '../fmshelper/scenarios.mjs'
import {
  draftLedgerPaths, catalogResult, proof, receiptMappingBody, openingQuery, reconcileMatches,
  openingDateInputOrder
} from '../fmshelper/contracts.mjs'

test('assistAmount reads only the matching auxiliary item', () => {
  const balances = [{
    subjectId: '1122',
    assistBalances: [
      { auxiliaries: [{ itemId: '101' }], openingAmount: '123.45' },
      { auxiliaries: [{ itemId: '102' }], openingAmount: '67.89' }
    ]
  }]
  assert.equal(assistAmount(balances, '1122', '101'), 12345)
  assert.equal(assistAmount(balances, '1122', '999'), 0)
})

test('draft ledger queries include every distinct existing subject ID without losing precision', () => {
  const draft = {
    accountSetId: '2107455388355596289',
    entries: [{ accountCode: '1002' }, { accountCode: '1122' }, { accountCode: '1122' }]
  }
  const paths = draftLedgerPaths(draft, [
    { id: '9007199254740993', code: '1002' },
    { id: '9007199254740994', code: '1122' }
  ], '2026-10')
  assert.equal(paths.length, 2)
  const queries = paths.map((pathname) => new URL(pathname, 'http://localhost').searchParams)
  assert.deepEqual(queries.map((query) => query.get('subjectId')),
    ['9007199254740993', '9007199254740994'])
  for (const query of queries) {
    assert.equal(query.get('accountSetId'), draft.accountSetId)
    assert.equal(query.get('startMonth'), '2026-10')
    assert.equal(query.get('endMonth'), '2026-10')
  }
})

test('draft ledger lookup blocks absent or ambiguous subjects instead of changing accounting configuration', () => {
  const draft = { accountSetId: '2107455388355596289', entries: [{ accountCode: '1122' }] }
  assert.throws(() => draftLedgerPaths(draft, [], '2026-10'), /BLOCKED:/)
  assert.throws(() => draftLedgerPaths(draft, [
    { id: '1', code: '1122' }, { id: '2', code: '1122' }
  ], '2026-10'), /BLOCKED:/)
})

test('partial evidence never completes missing catalog assertions or masks an earlier failure', () => {
  const record = { checks: [] }
  const definition = { assertions: ['confirmed', 'posted'], reverse: ['reversed'] }
  proof(record, 'confirmed', true, 'browser confirmation')
  assert.equal(catalogResult(record, definition).partial, true)
  assert.equal(record.passCandidate, false)
  assert.deepEqual(record.remainingAssertions.map((item) => item.assertion), ['posted', 'reversed'])
  assert.deepEqual(record.catalogAssertions, [
    { index: 0, assertion: 'confirmed', status: 'VERIFIED', evidence: 'browser confirmation' },
    { index: 1, assertion: 'posted', status: 'GAP', evidence: '尚无本轮真实闭环证据' }
  ])
  assert.deepEqual(record.catalogReverseAssertions, [
    { index: 0, assertion: 'reversed', status: 'GAP', evidence: '尚无本轮真实闭环证据' }
  ])
  assert.equal(record.catalogAssertions.some((item) => item.assertion === 'reversed'), false)
  proof(record, 'posted', false, 'posting failed')
  proof(record, 'posted', true, 'later unrelated success')
  proof(record, 'reversed', true, 'reversal proof')
  assert.equal(catalogResult(record, definition).partial, true)
  assert.equal(record.catalogEvidence.posted.status, 'FAIL')
  assert.deepEqual(record.catalogAssertions.map((item) => item.status), ['VERIFIED', 'GAP'])
  assert.deepEqual(record.catalogReverseAssertions.map((item) => item.status), ['VERIFIED'])
})

test('complete FMS evidence emits strict indexed positive mappings without exposing reverse indexes', () => {
  const record = { checks: [], notes: [] }
  const definition = { assertions: ['created', 'posted'], reverse: ['reversed'] }
  proof(record, 'created', true, 'create response and readback')
  proof(record, 'posted', true, 'posting response and ledger readback')
  proof(record, 'reversed', true, 'reversal response and ledger readback')

  const result = catalogResult(record, definition)

  assert.equal(result.partial, false)
  assert.equal(record.passCandidate, true)
  assert.equal(record.remainingAssertions.length, 0)
  assert.deepEqual(record.catalogAssertions.map(({ index, assertion, status }) => ({ index, assertion, status })), [
    { index: 0, assertion: 'created', status: 'VERIFIED' },
    { index: 1, assertion: 'posted', status: 'VERIFIED' }
  ])
  assert.deepEqual(record.catalogReverseAssertions.map(({ index, assertion, status }) => ({ index, assertion, status })), [
    { index: 0, assertion: 'reversed', status: 'VERIFIED' }
  ])
})

test('receipt mapping uses the real ERP event, existing accounts and source-line amounts without auxiliary fabrication', () => {
  const key = 'E2E-FMS-FMS-006-UNIT-123'
  const first = receiptMappingBody(key)
  const second = receiptMappingBody(key, 2)
  assert.equal(first.accountSetId, '2107455388355596289')
  assert.equal(first.eventType, 'ERP_RECEIPT_ARRIVED')
  assert.equal(first.entries.length, 3)
  assert.equal(second.entries.length, 4)
  for (const body of [first, second]) {
    for (const entry of body.entries) {
      assert.equal(entry.accountCode, entry.direction === 'DEBIT' ? '100201' : '1122')
      assert.match(entry.amountExpression, /^line\.amount/)
      assert.equal(entry.auxiliarySource, undefined)
      assert.equal(entry.auxiliaryType, undefined)
      assert.deepEqual(Object.keys(JSON.parse(entry.conditionJson)).sort(),
        ['direction', 'eventType', 'sourceBillType', 'sourceSystem'])
    }
    assert.equal(body.effectiveFrom, '2026-10-01')
    assert.equal(body.effectiveTo, '2026-10-31')
  }
  assert.throws(() => receiptMappingBody('OTHER'), /非本组/)
})

test('FMS-006 headed evidence contract requires the real dialog title and leaf-entry content', () => {
  const source = fs.readFileSync(new URL('../fmshelper/scenarios.mjs', import.meta.url), 'utf8')
  assert.match(source, /getByText\('分录规则', \{ exact: true \}\)/)
  assert.doesNotMatch(source, /借贷分录规则/)
  assert.match(source, /rows\.length === 3/)
  assert.match(source, /100201/)
  assert.match(source, /1122/)
  assert.match(source, /line\.amount \* 0\.4/)
})

test('FMS mapping subject lookup preserves the string account-set ID', () => {
  const source = fs.readFileSync(
    '/Users/liuqiang/code/cfor-standard/cfor/cfor-admin-vue3/src/views/fms/config/event-mapping/index.vue',
    'utf8')
  assert.match(source, /getSubjectSimpleList\(accountSetId\.value\)/)
  assert.doesNotMatch(source, /getSubjectSimpleList\(Number\(accountSetId\.value\)\)/)
})

test('opening filters always include all four catalog dimensions and explicit local fixture ownership', () => {
  const batch = 'E2E-FMS-FMS-007-UNIT-123'
  const query = openingQuery(batch)
  assert.equal(query.get('importBatchNo'), batch)
  assert.equal(query.get('dealingsLogotype'), 'receivable')
  assert.equal(query.get('openingBaseDate'), '2026-10-07')
  assert.equal(query.get('billDate_begin'), '2026-10-07 00:00:00')
  assert.equal(query.get('billDate_end'), '2026-10-07 23:59:59')
  assert.equal(openingQuery(batch, { dealingsLogotype: 'payable' }).get('dealingsLogotype'), 'payable')
  assert.throws(() => openingQuery('SHARED'), /非本组/)
})

test('opening date inputs move through a valid range when changing both endpoints', () => {
  assert.deepEqual(openingDateInputOrder('2026-10-07', '2026-10-07',
    '2026-10-08', '2026-10-08'), ['end', 'start'])
  assert.deepEqual(openingDateInputOrder('2026-10-08', '2026-10-08',
    '2026-10-07', '2026-10-07'), ['start', 'end'])
  assert.deepEqual(openingDateInputOrder('', '',
    '2026-10-07', '2026-10-07'), ['start', 'end'])
})

test('opening reconciliation rejects empty samples and duplicated partner rows', () => {
  const empty = { accountSetId: '2107455388355596289', reconciled: true, entries: [],
    sourceTotalAmount: 0, fmsTotalAmount: 0, differenceAmount: 0 }
  assert.equal(reconcileMatches(empty, new Map()), false)
  const row = { partnerId: '101', status: 'MATCHED', sourceAmount: '123.45',
    fmsAmount: '123.45', difference: '0' }
  const value = { ...empty, sourceTotalAmount: '191.34', fmsTotalAmount: '191.34',
    entries: [row, { ...row, partnerId: '102', sourceAmount: '67.89', fmsAmount: '67.89' }] }
  const expected = new Map([['101', '123.45'], ['102', '67.89']])
  assert.equal(reconcileMatches(value, expected), true)
  assert.equal(reconcileMatches({ ...value, entries: [row, row] }, expected), false)
})
