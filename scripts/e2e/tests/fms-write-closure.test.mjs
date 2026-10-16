import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { config } from '../config/index.mjs'
import { createApiClient, serverApiFailures } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import {
  assertDeletedById,
  deleteOpeningSummaryFixture,
  cleanupWriteOff,
  cleanupOpening,
  payableBatchPrefix,
  financialFixtureBillNo,
  registerPayableResources,
  registerPaymentResource,
  registerPayableCheckResource,
  registerReceivableCheckResource,
  registerReceiptResource,
  readPaymentEntries,
  readReceiptEntries,
  statedAssertion,
  adjustmentDelta,
  readOutbox,
  expectFmsRejection,
  flattenFmsBalances,
  voucherBalanceDelta,
  readPublishedDelivery,
  verifyIsolatedClosedPeriod,
  isolatedPeriodPassword,
  isolatedPeriodTenantName,
  isolatedPeriodTenantCreationGap,
  waitForFmsTasks,
  assessFms004WriteOffReversal,
  runFmsCashReversalClosure
} from '../fixtures/fms-write-closure.mjs'
import { comparableDraftEntries } from '../fmshelper/scenarios.mjs'
import {
  assertFms004WriteScope, readFms004Context, readFms004FormalVouchers, readFms004CashDraft,
  assertFms004CashRevision, assessFms004CashReversalEvidence,
  readFms004CashReversalEvidence, finalizeFms004CashReversalEvidence
} from '../fixtures/fms-004-evidence.mjs'
import { balancedDraft, catalogResult, check, dataOf, money, numericId } from '../fmshelper/contracts.mjs'

test('isolated FMS period tenant password stays within the tenant contract', () => {
  const password = isolatedPeriodPassword()
  assert.equal(password.length, 16)
  assert.match(password, /^Fms![a-f0-9]{10}A9$/)
})

test('isolated FMS period tenant name stays within the tenant schema', () => {
  const name = isolatedPeriodTenantName('E2E-FMS-FMS-003-MV2RCSGQ-0A2265')
  assert.equal(name, 'FMS03-P-RCSGQ-0A2265')
  assert.ok(name.length <= 32)
})

test('isolated FMS period tenant bootstrap rejection is a controlled evidence gap', () => {
  assert.equal(isolatedPeriodTenantCreationGap(
    new Error('Business failure POST /system/tenant/create: 提交的菜单权限包含已停用资源：1261')
  ), true)
  assert.equal(isolatedPeriodTenantCreationGap(
    new Error('Business failure POST /system/tenant/create: 租户名已存在')
  ), false)
})

test('draft evidence comparison ignores response-only audit fields', () => {
  const draft = [{ lineNo: 2, accountCode: '3001', direction: 'CREDIT', amount: '123.45' },
    { lineNo: 1, accountCode: '1001', direction: 'DEBIT', amount: '123.45' }]
  const confirmed = [{ id: 'entry-1', lineNo: 1, accountCode: '1001', direction: 'DEBIT', amount: '123.45',
    confirmedBy: '1' }, { id: 'entry-2', lineNo: 2, accountCode: '3001', direction: 'CREDIT', amount: '123.45',
    confirmedTime: '2026-10-11T03:00:00' }]
  assert.deepEqual(comparableDraftEntries(draft), comparableDraftEntries(confirmed))
})

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' }
})

test('parallel FMS tasks drain remaining writes before exposing failure to cleanup', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const events = []
  const failure = new Error('first delivery failed')
  const run = waitForFmsTasks([
    async () => { throw failure },
    async () => {
      await pending
      events.push('write-finished')
      return 'registered-fixture'
    }
  ]).catch((error) => {
    events.push('cleanup-started')
    throw error
  })
  const rejected = assert.rejects(run, (error) => error === failure)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [])
  release()
  await rejected
  assert.deepEqual(events, ['write-finished', 'cleanup-started'])
})

test('parallel FMS tasks preserve role order and drain synchronous failures', async () => {
  assert.deepEqual(await waitForFmsTasks([
    async () => { await new Promise((resolve) => setImmediate(resolve)); return 'receivable' },
    async () => 'payable'
  ]), ['receivable', 'payable'])
  const failure = new Error('synchronous fixture failure')
  let siblingFinished = false
  await assert.rejects(waitForFmsTasks([
    () => { throw failure },
    async () => {
      await new Promise((resolve) => setImmediate(resolve))
      siblingFinished = true
      throw new Error('second failure')
    }
  ]), (error) => error === failure && siblingFinished)
})

function fms004WriteOffAggregationSource () {
  const fixture = readFileSync(new URL('../fixtures/fms-write-closure.mjs', import.meta.url), 'utf8')
  const branch = fixture.slice(fixture.indexOf('export async function runFms004Closure'),
    fixture.indexOf('async function runFms007Closure'))
  const start = branch.indexOf('    const writeOffReverseResults = []')
  const end = branch.indexOf('    const afterContext =', start)
  assert.ok(start >= 0 && end > start, 'FMS-004 write-off aggregation block must exist')
  return branch.slice(start, end)
}

const fmsTaskTurn = () => new Promise((resolve) => setImmediate(resolve))
const fms004WriteOffAggregateName = 'ERP 应收/应付核销真实正反发布闭环'

function fms004WriteOffAggregationProbe ({
  source = fms004WriteOffAggregationSource(), badRole, rejectRole, pending = false,
  mutateOriginal = () => {}, mutateReverse = () => {}, mutateBalance = () => {}
} = {}) {
  const roles = ['receivable', 'payable']
  const gates = new Map(roles.map((role) => {
    let release
    const promise = new Promise((resolve) => { release = resolve })
    return [role, { promise, release }]
  }))
  const caseRecord = { checks: [], notes: [] }
  const state = { started: [], balanceReads: [], settled: false }
  const failure = new Error('delayed reverse delivery failed')
  const sources = roles.map((role, index) => ({
    role,
    fixture: { checkId: String(601 + index), receivable: { id: String(501 + index) },
      payableId: String(501 + index),
      writeoffReverseEvidence: { payable: { checkedAmt: '123.45' } } },
    writeOff: {
      event: { id: String(701 + index) },
      payload: { sourceEventId: `${role}-forward`, sourceVersion: '24' },
      draft: { id: String(801 + index), status: 'DRAFT',
        inboxId: String(701 + index), accountSetId: config.fmsAccountSetId,
        sourceBillId: String(601 + index), summary: `${role} write-off`,
        confirmedBy: null, confirmedTime: null, postedBy: null, postedTime: null,
        voucherId: null, reversalVoucherId: null, cancelledBy: null, cancelledTime: null,
        cancelRemark: null, debitTotal: '123.45', creditTotal: '123.45',
        entries: [
          { id: `81${index}`, lineNo: 1, accountCode: '1002', direction: 'DEBIT', amount: '123.45' },
          { id: `82${index}`, lineNo: 2, accountCode: '1122', direction: 'CREDIT', amount: '123.45' }
        ] }
    }
  }))
  const balance = (current) => {
    state.balanceReads.push(current.role)
    const bill = { id: current.fixture.payableId, checkedAmt: '0.00' }
    mutateBalance(bill, current.role)
    return bill
  }
  // Execute the fixture's actual call site with the real task waiter and checks.
  // All I/O dependencies are local stubs, and each delivery has an explicit gate.
  const run = runInNewContext(`(async () => {\n${source}\n})()`, {
    sources, caseRecord, waitForFmsTasks, check, dataOf, money, balancedDraft,
    numericId, assertBusinessSuccess, assessFms004WriteOffReversal,
    api: { getBusiness: async (path) => {
      const bill = sources.find((item) => path ===
        `/finance/${item.role === 'receivable' ? 'finReceivable' : 'finPayable'}/queryById?id=${item.fixture.payableId}`)
      if (bill) return { code: 200, success: true, data: balance(bill) }
      const current = sources.find((item) =>
        path === `/fms/voucher-draft/get?id=${item.writeOff.draft.id}`)
      assert.ok(current, `unexpected original-draft read: ${path}`)
      const original = { ...structuredClone(current.writeOff.draft), status: 'CANCELLED',
        cancelledBy: '0', cancelledTime: '2026-10-15T23:07:23',
        cancelRemark: `ADR3.5 来源反向取消；forward=${current.role}-forward; ` +
          `reverse=${current.role}-reverse; sourceVersion=24` }
      mutateOriginal(original, current.role)
      return { code: 0, data: original }
    } },
    readPublishedDelivery: async (_, record, id, eventType, direction) => {
      const current = sources.find((item) => item.fixture.checkId === id)
      assert.ok(current)
      assert.equal(record, caseRecord)
      assert.equal(eventType, current.role === 'receivable'
        ? 'ERP_RECEIVABLE_WRITE_OFF' : 'ERP_PAYABLE_WRITE_OFF')
      assert.equal(direction, 'REVERSE')
      state.started.push(current.role)
      await gates.get(current.role).promise
      if (current.role === rejectRole) throw failure
      const draft = pending ? null : {
        id: `9${id}`, status: 'DRAFT', debitTotal: '123.45', creditTotal: '123.45',
        entries: [
          { accountCode: '1122', direction: 'DEBIT', amount: '123.45' },
          { accountCode: '1002', direction: 'CREDIT', amount: '123.45' }
        ]
      }
      const reverse = {
        event: { id: `1${id}`, draftId: draft?.id ?? null,
          processStatus: pending ? 'PENDING' : 'DRAFTED',
          processMessage: pending ? '未配置反向事件映射' : '已生成凭证草稿' },
        payload: { sourceEventId: `${current.role}-reverse`, sourceVersion: '24',
          reversalOfEventId: current.role === badRole
          ? 'wrong-forward' : current.writeOff.payload.sourceEventId },
        draft
      }
      mutateReverse(reverse, current.role)
      return reverse
    }
  }, { timeout: 1000 })
  run.then(() => { state.settled = true }, () => { state.settled = true })
  return {
    caseRecord, state, sources, run, failure,
    release: (role) => gates.get(role).release(),
    aggregate: () => caseRecord.checks.find((item) => item.name === fms004WriteOffAggregateName),
    drain: async () => {
      for (const gate of gates.values()) gate.release()
      await run.catch(() => {})
      await fmsTaskTurn()
    }
  }
}

test('FMS-004 actual reverse aggregation waits for both delayed role factories', { timeout: 3000 }, async (t) => {
  for (const first of ['receivable', 'payable']) {
    const probe = fms004WriteOffAggregationProbe()
    t.after(probe.drain)
    await fmsTaskTurn()
    assert.deepEqual([...probe.state.started].sort(), ['payable', 'receivable'])
    assert.equal(probe.state.settled, false)
    assert.deepEqual(probe.caseRecord.checks, [])
    probe.release(first)
    await fmsTaskTurn()
    assert.equal(probe.state.settled, false)
    assert.equal(probe.aggregate(), undefined)
    assert.equal(probe.caseRecord.checks.length, 1)
    assert.equal(probe.caseRecord.checks[0].passed, true)
    probe.release(first === 'receivable' ? 'payable' : 'receivable')
    await probe.run
    assert.equal(probe.aggregate().passed, true)
    const results = JSON.parse(probe.aggregate().details.split('：').at(-1))
    assert.equal(results.length, 2)
    assert.deepEqual(results.map((item) => item.role).sort(), ['payable', 'receivable'])
    assert.ok(results.every((item) => item.passed))
    assert.ok(probe.sources.every((item) => item.reverseVerified === true))
    assert.equal(probe.caseRecord.checks.at(-1), probe.aggregate())
  }
})

test('FMS-004 delayed failing role stays in the final aggregate without an early empty result', { timeout: 3000 }, async (t) => {
  const probe = fms004WriteOffAggregationProbe({ badRole: 'receivable' })
  t.after(probe.drain)
  await fmsTaskTurn()
  probe.release('payable')
  await fmsTaskTurn()
  assert.equal(probe.state.settled, false)
  assert.equal(probe.aggregate(), undefined)
  probe.release('receivable')
  await probe.run
  assert.equal(probe.aggregate().passed, false)
  assert.deepEqual(JSON.parse(probe.aggregate().details.split('：').at(-1)), [
    { role: 'payable', passed: true }, { role: 'receivable', passed: false }
  ])
})

test('FMS-004 reverse rejection waits for the sibling and never records a partial aggregate', { timeout: 3000 }, async (t) => {
  const probe = fms004WriteOffAggregationProbe({ rejectRole: 'receivable' })
  t.after(probe.drain)
  const rejected = assert.rejects(probe.run, (error) => error === probe.failure)
  await fmsTaskTurn()
  probe.release('receivable')
  await fmsTaskTurn()
  assert.equal(probe.state.settled, false)
  assert.equal(probe.aggregate(), undefined)
  probe.release('payable')
  await rejected
  assert.equal(probe.aggregate(), undefined)
  assert.equal(probe.caseRecord.checks.length, 1)
  assert.equal(probe.sources[1].reverseVerified, true)
})

test('FMS-004 regression detects eager Promise map mutation in the actual call site', { timeout: 3000 }, async (t) => {
  const source = fms004WriteOffAggregationSource()
  const eager = source.replace('sources.map((source) => async () => {', 'sources.map(async (source) => {')
  assert.notEqual(eager, source, 'task factory call site must be present')
  const probe = fms004WriteOffAggregationProbe({ source: eager })
  t.after(probe.drain)
  await fmsTaskTurn()
  assert.equal(probe.state.settled, true)
  assert.deepEqual([...probe.state.started].sort(), ['payable', 'receivable'])
  assert.equal(probe.aggregate().passed, false)
  assert.match(probe.aggregate().details, /\[\]$/)
  assert.ok(probe.sources.every((item) => item.reverseVerified === undefined))
  for (const role of ['receivable', 'payable']) probe.release(role)
  await probe.drain()
  assert.ok(probe.sources.every((item) => item.reverseVerified === true))
  assert.equal(probe.aggregate().passed, false)
  assert.notEqual(probe.caseRecord.checks.at(-1), probe.aggregate())
})

test('FMS-004 missing reverse mapping is event-delivery evidence, not accounting draft evidence', { timeout: 3000 }, async (t) => {
  const probe = fms004WriteOffAggregationProbe({ pending: true })
  t.after(probe.drain)
  for (const role of ['receivable', 'payable']) probe.release(role)
  await probe.run
  assert.equal(probe.aggregate().passed, false)
  assert.ok(probe.sources.every((source) => source.reverseVerified === false))
  assert.equal(probe.caseRecord.catalogEvidence, undefined)
  assert.equal(probe.caseRecord.notes.length, 2)
  assert.ok(probe.caseRecord.notes.every((note) => note.includes('PENDING') &&
    note.includes('未宣称反向会计草稿/正式过账通过')))
})

test('FMS-004 accepts audited cancellation while preserving original content and reading both latest ERP balances', async (t) => {
  const probe = fms004WriteOffAggregationProbe()
  t.after(probe.drain)
  const before = structuredClone(probe.sources.map((source) => source.writeOff.draft))
  for (const role of ['receivable', 'payable']) probe.release(role)
  await probe.run
  assert.equal(probe.aggregate().passed, true)
  assert.deepEqual([...probe.state.balanceReads].sort(), ['payable', 'receivable'])
  assert.deepEqual(probe.sources.map((source) => source.writeOff.draft), before,
    'the forward before-image must never be overwritten by cancellation readback')
})

test('FMS-004 cancellation cannot hide changed original headers, entries, audit or implicit posting', async (t) => {
  const changes = [
    ['uncancelled', (draft) => { draft.status = 'DRAFT' }],
    ['missing operator', (draft) => { draft.cancelledBy = null }],
    ['missing time', (draft) => { draft.cancelledTime = null }],
    ['invalid time', (draft) => { draft.cancelledTime = 'not-a-time' }],
    ['wrong event audit', (draft) => { draft.cancelRemark = 'unrelated cancellation' }],
    ['wrong version audit', (draft) => { draft.cancelRemark = draft.cancelRemark.replace('=24', '=240') }],
    ['identity drift', (draft) => { draft.sourceBillId = '999' }],
    ['header drift', (draft) => { draft.summary = 'changed summary' }],
    ['missing entry', (draft) => { draft.entries.pop() }],
    ['entry identity drift', (draft) => { draft.entries[0].id = '999' }],
    ['entry amount drift', (draft) => { draft.entries[0].amount = '100.00' }],
    ['implicit confirmation', (draft) => { draft.confirmedBy = '1' }],
    ['implicit posting', (draft) => { draft.postedTime = '2026-10-15T23:07:23' }],
    ['formal voucher', (draft) => { draft.voucherId = '999' }],
    ['formal reversal voucher', (draft) => { draft.reversalVoucherId = '999' }]
  ]
  for (const role of ['receivable', 'payable']) {
    for (const [label, mutate] of changes) {
      const probe = fms004WriteOffAggregationProbe({
        mutateOriginal: (draft, current) => { if (current === role) mutate(draft) }
      })
      t.after(probe.drain)
      for (const current of ['receivable', 'payable']) probe.release(current)
      await probe.run
      assert.equal(probe.aggregate().passed, false, `${role}: ${label}`)
      assert.equal(probe.sources.find((source) => source.role === role).reverseVerified, false,
        `${role}: ${label}`)
      assert.equal(probe.sources.find((source) => source.role !== role).reverseVerified, true,
        `${role}: unaffected sibling must retain its own evidence`)
    }
  }
})

test('FMS-004 latest ERP balance must belong to the current source and be zero', async (t) => {
  for (const role of ['receivable', 'payable']) {
    for (const mutate of [
      (bill) => { bill.checkedAmt = '123.45' },
      (bill) => { bill.id = '999' }
    ]) {
      const probe = fms004WriteOffAggregationProbe({
        mutateBalance: (bill, current) => { if (current === role) mutate(bill) }
      })
      t.after(probe.drain)
      for (const current of ['receivable', 'payable']) probe.release(current)
      await probe.run
      assert.equal(probe.aggregate().passed, false, role)
      assert.equal(probe.sources.find((source) => source.role === role).reverseVerified, false)
    }
    const missing = fms004WriteOffAggregationProbe({
      mutateBalance: (bill, current) => { if (current === role) delete bill.checkedAmt }
    })
    t.after(missing.drain)
    const rejected = assert.rejects(missing.run, /无效金额/)
    for (const current of ['receivable', 'payable']) missing.release(current)
    await rejected
    assert.equal(missing.aggregate(), undefined)
  }
})

test('FMS-004 reverse draft must be independent, unconfirmed and exactly offset the original entries', async (t) => {
  for (const mutate of [
    (reverse) => { reverse.payload.sourceVersion = '25' },
    (reverse) => { reverse.event.processStatus = 'PENDING' },
    (reverse) => { reverse.event.draftId = '999' },
    (reverse) => { reverse.draft.id = '801' },
    (reverse) => { reverse.draft.status = 'CONFIRMED' },
    (reverse) => { reverse.draft.confirmedTime = '2026-10-15T23:07:23' },
    (reverse) => { reverse.draft.voucherId = '999' },
    (reverse) => { reverse.draft.entries[0].accountCode = '9999' },
    (reverse) => { reverse.draft.entries[0].direction = 'CREDIT' },
    (reverse) => { reverse.draft.entries[0].auxiliaryCode = 'foreign' }
  ]) {
    const probe = fms004WriteOffAggregationProbe({
      mutateReverse: (reverse, role) => { if (role === 'receivable') mutate(reverse) }
    })
    t.after(probe.drain)
    for (const role of ['receivable', 'payable']) probe.release(role)
    await probe.run
    assert.equal(probe.aggregate().passed, false)
    assert.equal(probe.sources[0].reverseVerified, false)
    assert.equal(probe.sources[1].reverseVerified, true)
  }
})

test('financial fixture bill numbers fit schema while preserving deterministic ownership', () => {
  const longKey = `E2E-FMS-FMS-004-${'A'.repeat(100)}-PAYABLE-E-AP-PAYMENT`
  for (const kind of ['RCPT', 'PAY']) {
    const number = financialFixtureBillNo(longKey, kind)
    assert.ok(number.length <= 32)
    assert.match(number, new RegExp(`^E2E-FMS-${kind}-[A-F0-9]{16}$`))
    assert.equal(number, financialFixtureBillNo(longKey, kind))
    assert.notEqual(number, financialFixtureBillNo(`${longKey}-OTHER`, kind))
  }
  assert.throws(() => financialFixtureBillNo('user-bill', 'PAY'))
  assert.throws(() => financialFixtureBillNo(longKey, 'OTHER'))
})

test('outbox evidence stage labels never become query IDs and SQL nulls map to null', async () => {
  const row = await readOutbox({}, '9007199254740993', 'manual-takeover', async (_, label, sql) => {
    assert.equal(label, 'outbox-9007199254740993-manual-takeover')
    assert.match(sql, /id='9007199254740993'/)
    assert.doesNotMatch(sql, /manual-takeover/)
    return [['9007199254740993', 'DEAD_LETTER', '3', 'error', '9', '2026-10-10',
      'handled', 'NULL', 'NULL']]
  })
  assert.equal(row.status, 'DEAD_LETTER')
  assert.equal(row.manual_takeover_by, '9')
  assert.equal(row.fms_inbox_id, null)
  assert.equal(row.draft_id, null)
  await assert.rejects(readOutbox({}, '123-stage', '', () => assert.fail('invalid ID queried')))
  await assert.rejects(readOutbox({}, Number.MAX_SAFE_INTEGER + 1, '', () => assert.fail('unsafe ID queried')))
})

test('FMS expected rejection requires the exact business contract and preserves transport failures', async () => {
  const previousFetch = globalThis.fetch
  const contract = { code: 1052105000, message: '该会计期间已结账' }
  try {
    for (const scenario of [
      { code: 1052105000, message: contract.message, accepted: true },
      { code: 1052105001, message: contract.message },
      { code: 1052105000, message: '系统异常' },
      { code: 1052105000, message: contract.message, http: 500 },
      { code: 0, message: contract.message },
      { network: true }
    ]) {
      const record = { api: [] }
      globalThis.fetch = async () => {
        if (scenario.network) throw new Error('network unavailable')
        return jsonResponse({ code: scenario.code, msg: scenario.message }, scenario.http || 200)
      }
      const api = createApiClient({ record })
      const call = () => expectFmsRejection(api, 'POST', '/fms/voucher/post-draft?id=123', {}, contract)
      if (scenario.accepted) {
        await call()
        assert.equal(record.api[0].expectedBusinessRejectionMatched, true)
      } else {
        await assert.rejects(call())
        assert.equal(record.api[0].expectedBusinessRejectionMatched, undefined)
      }
      if (scenario.network || scenario.http === 500) {
        assert.equal(serverApiFailures(record.api).length, 1)
      }
    }
    globalThis.fetch = async () => jsonResponse({ code: contract.code, msg: contract.message })
    await assert.rejects(expectFmsRejection(createApiClient(), 'POST', '/probe', {}, /已结账/))
  } finally {
    globalThis.fetch = previousFetch
  }
})

const balance = (id, debit, credit, endingDebit, endingCredit) => ({
  subjectId: id, nodeType: 1, periodDebitAmount: debit, periodCreditAmount: credit,
  endingDebitAmount: endingDebit, endingCreditAmount: endingCredit
})
const formalEntries = [
  { subjectId: '9007199254740993', debitAmount: '123.45', creditAmount: '0' },
  { subjectId: '9007199254740994', debitAmount: '0', creditAmount: '123.45' }
]

test('posting and reversal balance evidence requires exact single-write totals and actual readback', () => {
  const posted = [
    balance('9007199254740993', '123.45', '0', '123.45', '0'),
    balance('9007199254740994', '0', '123.45', '0', '123.45')
  ]
  const reversed = posted.map((row) => balance(row.subjectId, '123.45', '123.45', '0', '0'))
  assert.equal(voucherBalanceDelta([], posted, formalEntries), true)
  assert.equal(voucherBalanceDelta([], reversed, formalEntries, true), true)
  assert.equal(voucherBalanceDelta([], [], formalEntries), false)
  assert.equal(voucherBalanceDelta([], posted, formalEntries, true), false)
  assert.equal(voucherBalanceDelta([], reversed.map((row) =>
    ({ ...row, periodCreditAmount: '246.90' })), formalEntries, true), false)
  assert.deepEqual(flattenFmsBalances([{ ...posted[0], children: [posted[1]] }]).length, 2)
  assert.throws(() => flattenFmsBalances(null))
})

function publishedProbe (direction = 'FORWARD', {
  eventType = 'ERP_RECEIVABLE_WRITE_OFF', sourceBillType = 'FinReceivableCheck'
} = {}) {
  const payload = {
    sourceSystem: 'ERP', sourceBillId: '601', eventType,
    sourceBillType, direction,
    sourceEventId: `erp-601-${direction}`,
    ...(direction === 'REVERSE' ? { reversalOfEventId: 'erp-601-FORWARD' } : {}),
    lines: [{ amount: '123.45', direction: 'DEBIT' }, { amount: '123.45', direction: 'CREDIT' }]
  }
  const event = { ...payload, id: '701', draftId: '801', processStatus: 'DRAFTED' }
  const state = {
    row: ['501', 'SENT', payload.sourceEventId, payload.reversalOfEventId || 'NULL',
      event.id, event.draftId, JSON.stringify(payload)],
    events: [event, { ...event, id: '702', direction: direction === 'FORWARD' ? 'REVERSE' : 'FORWARD' }],
    inboxPayload: { ...payload, accountSetId: config.fmsAccountSetId },
    replay: { id: event.id, draftId: event.draftId, duplicated: true },
    draft: { id: event.draftId, accountSetId: config.fmsAccountSetId, status: 'DRAFT' },
    calls: []
  }
  const api = {
    getBusiness: async (path) => ({ code: 0, data: path.includes('event-inbox/page')
      ? { list: state.events } : state.draft }),
    postBusiness: async (path, body) => {
      assert.equal(path, '/fms/voucher-draft/accept-event')
      state.calls.push(structuredClone(body))
      return { code: 0, data: state.replay }
    }
  }
  const read = async (_, label, sql) => {
    if (sql.includes('FROM fms_event_inbox')) return [[JSON.stringify(state.inboxPayload)]]
    assert.match(sql, new RegExp(`direction='${direction}'`))
    assert.match(sql, /source_bill_id='601'/)
    return state.row ? [state.row] : []
  }
  return { state, api, read, payload,
    wait: async (action) => action() }
}

test('ERP delivery uses real direction-scoped outbox payload and replays the same inbox/draft', async () => {
  for (const direction of ['FORWARD', 'REVERSE']) {
    const probe = publishedProbe(direction)
    const record = { fixtures: [] }
    const result = await readPublishedDelivery(probe.api, record, '601',
      'ERP_RECEIVABLE_WRITE_OFF', direction, probe)
    assert.equal(result.event.id, '701')
    assert.deepEqual(probe.state.calls[0], { ...probe.payload, accountSetId: config.fmsAccountSetId })
    assert.equal(record.fixtures[0].direction, direction)
    assert.match(record.fixtures[0].cleanup, /^RETAINED_AUDIT/)
  }
})

test('ERP delivery rejects missing publish, mismatched reversal, foreign account and false replay', async () => {
  for (const mutate of [
    (state) => { state.row = null },
    (state) => { state.row[1] = 'DEAD_LETTER' },
    (state) => { state.row[3] = 'wrong-forward-event' },
    (state) => { state.events[0].id = '999' },
    (state) => { state.inboxPayload.accountSetId = '999' },
    (state) => { state.draft.accountSetId = '999' },
    (state) => { state.replay.duplicated = false },
    (state) => { state.replay.draftId = '999' }
  ]) {
    const probe = publishedProbe('REVERSE')
    mutate(probe.state)
    const record = { fixtures: [] }
    await assert.rejects(readPublishedDelivery(probe.api, record, '601',
      'ERP_RECEIVABLE_WRITE_OFF', 'REVERSE', probe))
    assert.equal(record.fixtures.length, 0)
  }
})

test('ERP delivery does not accept an unresolved outbox status as published', async () => {
  const probe = publishedProbe('REVERSE')
  probe.state.row[1] = 'PENDING'
  await assert.rejects(
    readPublishedDelivery(probe.api, { fixtures: [] }, '601',
      'ERP_RECEIVABLE_WRITE_OFF', 'REVERSE', probe),
    /当前状态=PENDING/
  )
})

test('ERP delivery waits through an initial PENDING state before accepting SENT', async () => {
  const probe = publishedProbe('FORWARD')
  const rows = [
    ['501', 'PENDING', probe.payload.sourceEventId, 'NULL', 'NULL', 'NULL',
      JSON.stringify(probe.payload)],
    ['501', 'SENT', probe.payload.sourceEventId, 'NULL', '701', '801',
      JSON.stringify(probe.payload)]
  ]
  let index = 0
  const result = await readPublishedDelivery(probe.api, { fixtures: [] }, '601',
    'ERP_RECEIVABLE_WRITE_OFF', 'FORWARD', {
      read: async (_, label, sql) => {
        if (sql.includes('FROM fms_event_inbox')) return [[JSON.stringify(probe.state.inboxPayload)]]
        return [rows[Math.min(index++, rows.length - 1)]]
      },
      wait: async (action, ready) => {
        const first = await action()
        assert.equal(ready(first), false)
        const second = await action()
        assert.equal(ready(second), true)
        return second
      }
    })
  assert.equal(result.event.id, '701')
})

test('ERP reverse missing-mapping inbox has no accounting draft for write-off, receipt or payment', async () => {
  for (const [eventType, sourceBillType] of [
    ['ERP_RECEIVABLE_WRITE_OFF', 'FinReceivableCheck'],
    ['ERP_RECEIPT_ARRIVED', 'FinReceipt'],
    ['ERP_PAYMENT_DISBURSED', 'FinPayment']
  ]) {
    const probe = publishedProbe('REVERSE', { eventType, sourceBillType })
    const event = { ...probe.state.events[0], draftId: null, processStatus: 'PENDING',
      processMessage: `未配置反向事件映射：ERP/${eventType}` }
    probe.state.events[0] = event
    probe.state.row = ['501', 'SENT', probe.payload.sourceEventId, probe.payload.reversalOfEventId,
      event.id, 'NULL', JSON.stringify(probe.payload)]
    probe.state.draft = null
    probe.state.replay = { id: event.id, draftId: null, duplicated: true }
    const record = { fixtures: [] }
    const result = await readPublishedDelivery(probe.api, record, '601', eventType, 'REVERSE', probe)
    assert.equal(result.event.processStatus, 'PENDING')
    assert.match(result.event.processMessage, /未配置反向事件映射/)
    assert.equal(result.event.draftId, null)
    assert.equal(result.draft, null)
    assert.equal(balancedDraft(result.draft, '123.45'), false)
    assert.equal(record.catalogEvidence, undefined)
    assert.equal(record.fixtures[0].draftId, undefined)
  }
})

function isolatedPeriodProbe () {
  const calls = []
  const api = { postBusiness: async (path) => {
    assert.equal(path, '/system/tenant/create')
    calls.push(['shared', path])
    return { code: 0, data: '6001' }
  } }
  const isolated = {
    postBusiness: async (path, body) => {
      calls.push(['isolated', path, body])
      if (path === '/fms/config/account-set/create') return { data: '7001' }
      if (path === '/fms/voucher-draft/accept-event') return { data: { draftId: '8001' } }
      assert.equal(path, '/fms/voucher-draft/confirm?id=8001')
      return { data: true }
    },
    putBusiness: async (path, body) => {
      calls.push(['isolated', path, body])
      assert.equal(body.accountSetId, '7001')
      assert.notEqual(body.accountSetId, config.fmsAccountSetId)
      return { data: true }
    },
    getBusiness: async (path) => {
      if (path.includes('/overview')) return { data: { closed: true } }
      if (path.includes('/fms/report/balance-sheet/get')) return { data: [{ rowId: 1 }] }
      if (path.includes('/fms/report/income-statement/get')) return { data: [{ rowNo: 1 }] }
      if (path.includes('voucher-draft/get')) return { data: { status: 'CONFIRMED' } }
      return { data: { total: 0, list: [] } }
    },
    request: async (method, path) => {
      assert.equal(method, 'POST')
      assert.equal(path, '/fms/voucher/post-draft?id=8001')
      return { code: 1052105000, msg: '该会计期间已结账' }
    }
  }
  const caseRecord = { checks: [], evidence: [], notes: [] }
  return { api, isolated, caseRecord, calls,
    withTenant: async (_, tenant, run) => {
      assert.equal(tenant.id, '6001')
      assert.notEqual(tenant.id, config.tenantId)
      return run({ api: isolated })
    } }
}

test('closed-period probe closes only a new isolated account and proves unchanged formal state', async () => {
  const probe = isolatedPeriodProbe()
  await verifyIsolatedClosedPeriod(probe, probe)
  const closes = probe.calls.filter((call) => call[1] === '/fms/closing/period/close')
  assert.deepEqual(closes, [['isolated', '/fms/closing/period/close',
    { accountSetId: '7001', month: '2026-10' }]])
  assert.equal(probe.caseRecord.catalogEvidence[statedAssertion('FMS-003', 4)].status, 'PASS')
  assert.equal(probe.caseRecord.fixtures[0].tenantId, '6001')
})

test('a failed isolated close never creates PASS evidence or tries closing the shared account', async () => {
  const probe = isolatedPeriodProbe()
  probe.isolated.putBusiness = async () => { throw new Error('close prerequisites missing') }
  await assert.rejects(verifyIsolatedClosedPeriod(probe, probe))
  assert.equal(probe.caseRecord.catalogEvidence?.[statedAssertion('FMS-003', 4)], undefined)
  assert.equal(probe.calls.some((call) => call[0] === 'shared' && call[1].includes('/close')), false)
})

test('FMS deleted-by-id accepts only the exact service rejection and records no server failure', async () => {
  const previousFetch = globalThis.fetch
  const record = { api: [] }
  globalThis.fetch = async () => jsonResponse({
    code: 500,
    success: false,
    message: '未找到对应数据'
  })
  try {
    await assertDeletedById(
      createApiClient({ record }),
      '/finance/finPayment/queryById?id=9301',
      '应付付款单'
    )
    assert.equal(record.api.length, 1)
    assert.equal(record.api[0].expectedBusinessRejectionMatched, true)
    assert.deepEqual(serverApiFailures(record.api), [])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('FMS deleted-by-id keeps unrelated 500 and HTTP failures visible', async () => {
  for (const scenario of [
    { payload: { code: 500, success: false, message: '系统异常' }, status: 200 },
    { payload: { code: 500, success: false, message: '未找到对应数据' }, status: 500 }
  ]) {
    const previousFetch = globalThis.fetch
    const record = { api: [] }
    globalThis.fetch = async () => jsonResponse(scenario.payload, scenario.status)
    try {
      await assert.rejects(assertDeletedById(
        createApiClient({ record }),
        '/finance/finPayment/queryById?id=9301',
        '应付付款单'
      ))
      assert.equal(serverApiFailures(record.api).length, 1)
      assert.equal(record.api[0].expectedBusinessRejectionMatched, undefined)
    } finally {
      globalThis.fetch = previousFetch
    }
  }
})

const result = () => ({ code: 200, success: true, data: {
  total: 1, records: [{
    id: '101', customerId: '201', amt: '123.45',
    finReceiptEntryList: [{ id: '301', mid: '101', amt: '123.45', checkedAmt: 0 }]
  }]
} })

test('FMS receipt entries are original formal IDs scoped by exact receipt and partner', async () => {
  const calls = []
  const entries = await readReceiptEntries({
    getBusiness: async (path) => { calls.push(path); return result() }
  }, 101, 201, '123.45')
  assert.deepEqual(calls, ['/finance/finReceipt/list/102?id=101&pageNo=1&pageSize=100'])
  assert.equal(entries[0].id, '301')
  assert.equal(entries[0].mid, '101')
})

test('FMS receipt entries reject empty pages, missing/foreign IDs and amount drift', async () => {
  const changes = [
    (response) => { response.data.total = 0; response.data.records = [] },
    (response) => { response.data.records[0].id = '999' },
    (response) => { response.data.records[0].customerId = '999' },
    (response) => { response.data.records[0].amt = '123.46' },
    (response) => { response.data.records[0].finReceiptEntryList = [] },
    (response) => { delete response.data.records[0].finReceiptEntryList[0].id },
    (response) => { response.data.records[0].finReceiptEntryList[0].mid = '999' },
    (response) => { response.data.records[0].finReceiptEntryList[0].amt = '123.46' },
    (response) => { response.data.records[0].finReceiptEntryList[0].id = Number.MAX_SAFE_INTEGER + 1 }
  ]
  for (const change of changes) {
    const response = result()
    change(response)
    await assert.rejects(readReceiptEntries({ getBusiness: async () => response }, '101', '201', '123.45'))
  }
})

test('FMS receipt source API failure is never replaced with SQL or a fabricated entry', async () => {
  await assert.rejects(readReceiptEntries({
    getBusiness: async () => ({ code: 500, message: '系统异常' })
  }, '101', '201', '123.45'))
  const failure = new Error('network')
  await assert.rejects(readReceiptEntries({
    getBusiness: async () => { throw failure }
  }, '101', '201', '123.45'), (error) => error === failure)
})

test('FMS payment read follows the real main/list contracts instead of inventing IDs in display VO', async () => {
  const calls = []
  const entries = await readPaymentEntries({
    getBusiness: async (path) => {
      calls.push(path)
      if (path === '/finance/finPayment/queryById?id=101') {
        return { code: 200, success: true, data: {
          id: '101', supplierId: '201', amt: '123.45', paymentType: '2021'
        } }
      }
      if (path === '/finance/finPayment/queryEntryByMainId?id=101') {
        return { code: 200, success: true, data: [{ amt: '123.45' }] }
      }
      if (path === '/finance/finPayment/list?pageNo=1&pageSize=100&id=101&paymentType=2021') {
        return { code: 200, success: true, data: {
          total: 1,
          records: [{
            id: '101', supplierId: '201', amt: '123.45',
            finPaymentEntryList: [{
              id: '301', mid: '101', srcBillId: '401', srcEntryId: '501', amt: '123.45'
            }]
          }]
        } }
      }
      throw new Error(`unexpected ${path}`)
    }
  }, '101', '201', '123.45')
  assert.deepEqual(calls, [
    '/finance/finPayment/queryById?id=101',
    '/finance/finPayment/queryEntryByMainId?id=101',
    '/finance/finPayment/list?pageNo=1&pageSize=100&id=101&paymentType=2021'
  ])
  assert.equal(entries.payment.id, '101')
  assert.equal(entries.displayEntries[0].id, undefined)
  assert.equal(entries.entries[0].id, '301')
  assert.equal(entries.entries[0].mid, '101')
})

test('FMS payment read rejects missing formal list evidence without fabricating entry IDs', async () => {
  await assert.rejects(readPaymentEntries({
    getBusiness: async (path) => {
      if (path.includes('/queryById')) {
        return { code: 200, success: true, data: {
          id: '101', supplierId: '201', amt: '123.45', paymentType: '2021'
        } }
      }
      if (path.includes('/queryEntryByMainId')) {
        return { code: 200, success: true, data: [{ amt: '123.45' }] }
      }
      return { code: 200, success: true, data: { total: 1, records: [{
        id: '101', supplierId: '201', amt: '123.45', finPaymentEntryList: [{}]
      }] } }
    }
  }, '101', '201', '123.45'), /无效单据 ID/)
})

test('FMS payable opening batch marker stays within fin_payable.src_no length', () => {
  for (const effective of [true, false]) {
    const sample = `${payableBatchPrefix(effective)}-${Date.now().toString(36).toUpperCase()}-ABCD`
    assert.ok(sample.length <= 50, sample)
  }
  assert.match(payableBatchPrefix(true), /^E2E-FMS-005-AP-E$/)
  assert.match(payableBatchPrefix(false), /^E2E-FMS-005-AP-D$/)
})

test('FMS summary cleanup deletes once and independently confirms absence before recording completion', async () => {
  const calls = []
  const fixture = { id: '101', batch: 'E2E-FMS-005-AR-UNIT', voided: true, cleanup: 'PENDING' }
  const api = {
    putBusiness: async () => assert.fail('already voided'),
    deleteBusiness: async (path) => { calls.push(path); return { code: 0 } },
    getBusiness: async (path) => { calls.push(path); return { code: 200, success: true,
      data: { total: 0, records: [] } } }
  }
  await deleteOpeningSummaryFixture(api, fixture)
  await deleteOpeningSummaryFixture(api, fixture)
  assert.equal(fixture.deleted, true)
  assert.match(fixture.cleanup, /回读不存在/)
  assert.deepEqual(calls, [
    '/finance/dealingsBeginning/delete?id=101',
    '/finance/dealingsBeginning/list?id=101&pageNo=1&pageSize=100'
  ])
})

test('FMS summary cleanup cannot mark a failed delete or nonempty readback complete', async () => {
  for (const stage of ['delete', 'readback']) {
    const fixture = { id: '101', batch: 'E2E-FMS-005-AR-UNIT', voided: true }
    await assert.rejects(deleteOpeningSummaryFixture({
      deleteBusiness: async () => { if (stage === 'delete') throw new Error('rejected') },
      getBusiness: async () => ({ code: 0, data: { total: 1, records: [{ id: '101' }] } })
    }, fixture))
    assert.equal(fixture.deleted, undefined)
    assert.equal(fixture.cleanup, undefined)
  }
})

test('FMS payable read failure retains payment resources and blocks opening deletion', async () => {
  const calls = []
  const fixture = {
    id: '9001',
    batch: 'E2E-FMS-005-AP-E-UNIT',
    role: 'payable',
    writeoffCleanupError: 'FMS-005 付款正式明细缺少真实主键',
    writeoffCleanup: 'RETAINED_AUDIT: 应付付款撤核销清理失败：FMS-005 付款正式明细缺少真实主键',
    cleanup: 'RETAINED_AUDIT: 应付付款撤核销清理失败：FMS-005 付款正式明细缺少真实主键'
  }
  registerPayableResources(fixture, { id: '9101' }, { id: '9201', mid: '9101' })
  registerPaymentResource(fixture, '9301')
  await cleanupOpening({
    getBusiness: async (path) => { calls.push(path); throw new Error('opening must remain') },
    putBusiness: async () => assert.fail('opening must not be voided'),
    deleteBusiness: async () => assert.fail('opening must not be deleted')
  }, fixture)
  assert.deepEqual(calls, [])
  assert.equal(fixture.paymentId, '9301')
  assert.equal(fixture.payableId, '9101')
  assert.equal(fixture.payableEntry.id, '9201')
  assert.equal(fixture.deleted, undefined)
  assert.match(fixture.cleanup, /^RETAINED_AUDIT:/)
})

test('FMS payable cleanup deletes its withdrawn draft check before withdrawing the source payment', async () => {
  const calls = []
  const state = {
    paymentWithdrawn: false, paymentDeleted: false, checkWithdrawn: false, checkDeleted: false,
    listReads: 0, openingVoided: false, checkEntryReads: 0
  }
  const fixture = {
    id: '9001', batch: 'E2E-FMS-005-AP-E-UNIT', role: 'payable', cleanup: 'PENDING'
  }
  registerPayableResources(fixture, { id: '9101' }, { id: '9201', mid: '9101' }, {
    supplierId: '7001', amount: '123.45'
  })
  registerPaymentResource(fixture, '9301')
  registerPayableCheckResource(fixture, '9401')
  const api = {
    getBusiness: async (path) => {
      calls.push(['GET', path])
      if (path === '/finance/finPayment/queryById?id=9301') {
        if (state.paymentDeleted) {
          return { code: 500, success: false, message: '未找到对应数据' }
        }
        return { code: 200, success: true, data: {
          id: '9301', supplierId: '7001', amt: '123.45', paymentType: '2021',
          isVoided: 0, isEffective: state.paymentWithdrawn ? 0 : 1,
          billStage: state.paymentWithdrawn ? '12' : '35',
          checkedAmt: state.checkWithdrawn ? 0 : '123.45'
        } }
      }
      if (path === '/finance/finPayment/queryEntryByMainId?id=9301') {
        return { code: 200, success: true, data: [{ amt: '123.45' }] }
      }
      if (path.startsWith('/finance/finPayment/list?')) {
        state.listReads += 1
        return { code: 200, success: true, data: {
          total: state.paymentDeleted ? 0 : 1, records: state.paymentDeleted ? [] : [{
          id: '9301', supplierId: '7001', amt: '123.45',
          finPaymentEntryList: state.listReads === 1 ? [{}] : [{
            id: '9303', mid: '9301', srcBillId: '9101', srcEntryId: '9201', amt: '123.45'
          }]
        }] } }
      }
      if (path.startsWith('/finance/finPayableCheck/list/2?')) {
        return { code: 200, success: true, data: { records: state.checkDeleted ? [] : [{
          id: '9401', srcBillId: '9301', supplierId: '7001', amt: '123.45',
          isEffective: state.checkWithdrawn ? 0 : 1, isVoided: 0
        }] } }
      }
      if (path === '/finance/finPayableCheck/queryById?id=9401') {
        if (state.checkDeleted) {
          return { code: 500, success: false, message: '未找到对应数据' }
        }
        return { code: 200, success: true, data: {
          id: '9401', srcBillId: '9301', supplierId: '7001', amt: '123.45',
          billStage: state.checkWithdrawn ? '12' : '35',
          isEffective: state.checkWithdrawn ? 0 : 1, isVoided: 0
        } }
      }
      if (path === '/finance/finPayableCheck/queryEntryByMainId?id=9401') {
        state.checkEntryReads += 1
        return { code: 200, success: true, data: [
          { checkSide: '1', srcBillId: '9101', srcEntryId: '9201', amt: '123.45' },
          { checkSide: '2', srcBillId: '9301', srcEntryId: '9303', amt: '123.45' }
        ] }
      }
      if (path === '/finance/finPayable/queryById?id=9101') {
        return { code: 200, success: true, data: {
          id: '9101', supplierId: '7001', amt: '123.45',
          checkedAmt: state.checkWithdrawn ? 0 : '123.45'
        } }
      }
      if (path === '/finance/dealingsBeginning/queryById?id=9001') {
        assert.equal(state.paymentDeleted, true)
        return { code: 200, success: true, data: {
          id: '9001', importBatchNo: fixture.batch, isEffective: 1,
          isVoided: state.openingVoided ? 1 : 0
        } }
      }
      if (path.startsWith('/finance/dealingsBeginning/list?')) {
        return { code: 200, success: true, data: { total: 0, records: [] } }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    putBusiness: async (path, body) => {
      calls.push(['PUT', path, body])
      if (path === '/finance/finPayableCheck/void') {
        assert.equal(body.id, '9401')
        state.checkWithdrawn = true
        return { code: 200, success: true, data: 'ok' }
      }
      if (path === '/finance/finPayment/void') {
        assert.equal(body.id, '9301')
        assert.equal(state.checkDeleted, true, 'source payment must retain the downstream check guard')
        state.paymentWithdrawn = true
        return { code: 200, success: true, data: 'ok' }
      }
      if (path === '/finance/dealingsBeginning/void') {
        assert.equal(body.id, '9001')
        state.openingVoided = true
        return { code: 200, success: true, data: 'ok' }
      }
      throw new Error(`unexpected PUT ${path}`)
    },
    deleteBusiness: async (path) => {
      calls.push(['DELETE', path])
      if (path === '/finance/finPayableCheck/delete?id=9401') {
        assert.equal(state.checkWithdrawn, true)
        state.checkDeleted = true
        return { code: 200, success: true, data: 'ok' }
      }
      if (path === '/finance/finPayment/delete?id=9301') {
        assert.equal(state.paymentWithdrawn, true)
        state.paymentDeleted = true
        return { code: 200, success: true, data: 'ok' }
      }
      assert.equal(path, '/finance/dealingsBeginning/delete?id=9001')
      return { code: 200, success: true, data: 'ok' }
    }
  }

  await cleanupWriteOff(api, fixture)
  assert.equal(fixture.checkId, '9401')
  assert.equal(fixture.writeoffReadError, '无效单据 ID')
  assert.equal(fixture.writeoffCleaned, true)
  assert.equal(fixture.checkDeleted, true)
  assert.equal(fixture.paymentDeleted, true)
  assert.equal(fixture.paymentEntryId, '9303')
  assert.equal(state.checkEntryReads >= 1, true)
  assert.equal(fixture.writeoffReverseEvidence.check.isVoided, 0)
  assert.match(fixture.cleanup, /余额归零/)

  await cleanupOpening(api, fixture)
  assert.match(fixture.cleanup, /期初批次正式删除并回读不存在/)
  assert.ok(calls.some(([, path]) => path === '/finance/finPayment/void'))
  assert.ok(calls.findIndex(([, path]) => path === '/finance/finPayableCheck/void') <
    calls.findIndex(([, path]) => path === '/finance/finPayableCheck/delete?id=9401'))
  assert.ok(calls.findIndex(([, path]) => path === '/finance/finPayableCheck/delete?id=9401') <
    calls.findIndex(([, path]) => path === '/finance/finPayment/void'))
  assert.ok(calls.findIndex(([, path]) => path === '/finance/finPayment/void') <
    calls.findIndex(([, path]) => path === '/finance/finPayment/delete?id=9301'))
  assert.ok(calls.some(([, path]) => path === '/finance/dealingsBeginning/delete?id=9001'))
})

test('FMS payable cleanup retains audit when registered check identity mismatches', async () => {
  const fixture = { id: '9002', batch: 'E2E-FMS-005-AP-E-MISMATCH', role: 'payable' }
  registerPayableResources(fixture, { id: '9102' }, { id: '9202', mid: '9102' }, {
    supplierId: '7002', amount: '123.45'
  })
  registerPaymentResource(fixture, '9302')
  registerPayableCheckResource(fixture, '9402')
  fixture.paymentEntryId = '9304'
  const api = {
    getBusiness: async (path) => {
      if (path === '/finance/finPayment/queryById?id=9302') {
        return { code: 200, success: true, data: {
          id: '9302', supplierId: '7002', amt: '123.45', paymentType: '2021'
        } }
      }
      if (path === '/finance/finPayment/queryEntryByMainId?id=9302') {
        return { code: 200, success: true, data: [{ amt: '123.45' }] }
      }
      if (path.startsWith('/finance/finPayment/list?')) {
        return { code: 200, success: true, data: { total: 1, records: [{
          id: '9302', supplierId: '7002', amt: '123.45', finPaymentEntryList: [{}]
        }] } }
      }
      if (path === '/finance/finPayableCheck/queryById?id=9402') {
        return { code: 200, success: true, data: {
          id: '9402', srcBillId: '9302', supplierId: '7999', amt: '123.45',
          isEffective: 1, isVoided: 0
        } }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    putBusiness: async () => assert.fail('identity mismatch must block void'),
    deleteBusiness: async () => assert.fail('identity mismatch must block delete')
  }
  await cleanupWriteOff(api, fixture)
  assert.match(fixture.writeoffCleanup, /^RETAINED_AUDIT:/)
  assert.match(fixture.writeoffCleanupError, /归属|身份|金额/)
  assert.equal(fixture.writeoffCleaned, undefined)
  assert.equal(fixture.paymentDeleted, undefined)
})

test('FMS receivable successful writes retain receipt and check IDs immediately', () => {
  const fixture = {}
  registerReceiptResource(fixture, '8101', '7001', '123.45')
  registerReceivableCheckResource(fixture, '8201')
  assert.deepEqual(fixture, {
    writeoffStarted: true,
    receiptId: '8101',
    receiptPartnerId: '7001',
    receiptAmount: '123.45',
    checkId: '8201'
  })
})

test('FMS closure evidence binds to the real catalog assertion coordinates', () => {
  assert.equal(statedAssertion('FMS-001', 3), '失败重试/死信')
  assert.equal(statedAssertion('FMS-001', 0, true), '只重试事件，不重复来源业务动作')
  assert.equal(statedAssertion('FMS-003', 1), '确认不等于过账')
  assert.equal(statedAssertion('FMS-007', 3), '对账弹窗展示逐客商匹配状态与合计差异')
  assert.throws(() => statedAssertion('FMS-001', 99), /catalog 断言不存在/)
})

test('FMS-007 adjustment delta is computed from authoritative cents, never floats', () => {
  assert.equal(adjustmentDelta('200.00', '123.45'), 7655)
  assert.equal(adjustmentDelta('123.45', '123.45'), 0)
  assert.equal(adjustmentDelta('67.89', '123.45'), -5556)
  assert.throws(() => adjustmentDelta('abc', '1.00'), /无效金额/)
})

test('FMS-004 blocks every nonlocal target, wrong account and missing write opt-in before writes', () => {
  const settings = { ...config, db: { ...config.db, host: '127.0.0.1', port: '3306' } }
  assert.doesNotThrow(() => assertFms004WriteScope(settings, 'true'))
  for (const change of [
    { target: 'online' }, { tenantId: '2' }, { fmsAccountSetId: '999' },
    { webBase: 'http://127.0.0.1:9152' }, { apiBase: 'https://jixu-ai.com' },
    { db: { ...settings.db, host: '192.168.110.252' } },
    { db: { ...settings.db, port: '3307' } },
    { db: { ...settings.db, name: 'cfor_admin_saas_standard' } }
  ]) assert.throws(() => assertFms004WriteScope({ ...settings, ...change }, 'true'), /BLOCKED:/)
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    assert.throws(() => assertFms004WriteScope(settings, flag), /WRITE_FIXTURES/)
  }
})

function fms004ContextProbe () {
  const state = {
    account: { id: config.fmsAccountSetId, initialized: true, level: 1 },
    accounts: [[config.fmsAccountSetId, 'E2EUNIT', 'FMS E2E', '1', '2026-10-01']],
    month: '2026-10', periods: [], calls: []
  }
  return { state,
    api: { getBusiness: async (path) => {
      state.calls.push(path)
      return { code: 0, data: path.includes('account-set/list') ? [state.account] : state.month }
    } },
    read: async (_, stage, sql) => {
      assert.match(sql, /tenant_id=1 AND deleted=0/)
      if (stage.includes('account')) return state.accounts
      assert.match(sql, new RegExp(`account_set_id='${config.fmsAccountSetId}'`))
      return state.periods
    } }
}

test('FMS-004 reads only the existing E2E account and open period, never creates or closes one', async () => {
  const h = fms004ContextProbe()
  const value = await readFms004Context(h.api, { checks: [] }, 'unit', h)
  assert.equal(value.accountSetId, config.fmsAccountSetId)
  assert.equal(value.month, '2026-10')
  assert.equal(h.state.calls.length, 2)
  assert.ok(h.state.calls.every((path) => /\/list$|\/current-month\?/.test(path)))
})

test('FMS-004 refuses ambiguous accounts, initialization drift, lost permission and closed periods', async () => {
  for (const mutate of [
    (s) => { s.accounts.push(['999', 'E2EOTHER', 'Cost E2E', '1', '2026-10-01']) },
    (s) => { s.account.initialized = false },
    (s) => { s.account.level = 3 },
    (s) => { s.accounts[0][0] = '999' },
    (s) => { s.accounts[0][1] = 'BUSINESS' },
    (s) => { s.accounts[0][4] = '2026-10-08' },
    (s) => { s.month = '2026-11' },
    (s) => { s.periods = [['901', '2026-10-31 23:59:59']] }
  ]) {
    const h = fms004ContextProbe()
    mutate(h.state)
    await assert.rejects(readFms004Context(h.api, { checks: [] }, 'unit', h), /BLOCKED:/)
  }
})

function fms004VoucherProbe (count = 1) {
  const state = { calls: [], rows: Array.from({ length: count }, (_, index) => ({
    id: String(1001 + index), accountSetId: config.fmsAccountSetId,
    status: 9, sourceDraftId: String(2001 + index),
    debitAmount: '123.45', creditAmount: '123.45', total: '123.45'
  })) }
  const h = { state,
    api: { getBusiness: async (path) => {
      state.calls.push(path)
      const query = new URL(path, 'http://127.0.0.1').searchParams
      assert.equal(query.get('accountSetId'), config.fmsAccountSetId)
      assert.equal(query.get('pageSize'), '100')
      const offset = (Number(query.get('pageNo')) - 1) * 100
      return { code: 0, data: { total: state.rows.length, list: state.rows.slice(offset, offset + 100) } }
    } },
    read: async (_, stage, sql) => {
      assert.match(sql, /FROM fms_voucher/)
      assert.match(sql, new RegExp(`tenant_id=1 AND deleted=0 AND account_set_id='${config.fmsAccountSetId}'`))
      return state.rows.map((r) => [r.id, String(r.status), r.sourceDraftId,
        r.debitAmount, r.creditAmount, r.total])
    } }
  return h
}

test('FMS-004 formal voucher snapshots are account-scoped, complete and independently matched to SQL', async () => {
  const h = fms004VoucherProbe(101)
  const result = await readFms004FormalVouchers(h.api, { checks: [] }, 'unit', h)
  assert.equal(result.length, 101)
  assert.equal(h.state.calls.length, 2)
  assert.equal(result[0][3], 12345)
})

test('FMS-004 formal voucher evidence rejects foreign accounts, truncated API, duplicates and SQL drift', async () => {
  for (const kind of ['foreign', 'truncated', 'duplicate', 'sql']) {
    const h = fms004VoucherProbe(kind === 'duplicate' ? 2 : 1)
    if (kind === 'foreign') h.state.rows[0].accountSetId = '999'
    if (kind === 'duplicate') h.state.rows[1].id = h.state.rows[0].id
    if (kind === 'truncated') h.api.getBusiness = async () => ({ code: 0, data: { total: 101, list: [] } })
    if (kind === 'sql') h.read = async () => []
    await assert.rejects(readFms004FormalVouchers(h.api, { checks: [] }, 'unit', h))
  }
})

function fms004CashProbe () {
  const draft = { id: '801', inboxId: '701', accountSetId: config.fmsAccountSetId,
    sourceSystem: 'ERP', sourceBillType: 'FinReceipt', sourceBillId: '601',
    eventType: 'ERP_RECEIPT_ARRIVED', draftNo: 'FMS-UNIT-001', bizDate: '2026-10-07',
    status: 'DRAFT', debitTotal: '123.45', creditTotal: '123.45',
    entries: [
      { id: '901', lineNo: 1, accountCode: '1002', direction: 'DEBIT', amount: '123.45' },
      { id: '902', lineNo: 2, accountCode: '1122', direction: 'CREDIT', amount: '123.45' }
    ] }
  const state = {
    draft, listed: { ...draft, entries: null }, formal: [],
    sql: ['801', '701', config.fmsAccountSetId, 'DRAFT', '2026-10-07', '123.45', '123.45',
      'NULL', 'NULL', 'NULL', 'NULL', 'NULL'],
    entries: [['901', '1', '1002', 'DEBIT', '123.45'], ['902', '2', '1122', 'CREDIT', '123.45']],
    sourceRows: [['801', 'ERP_RECEIPT_ARRIVED', 'FinReceipt', '601', 'FMS-UNIT-001']]
  }
  return { state,
    source: { role: 'receivable', cash: { draft,
      event: { id: '701', draftId: '801', sourceSystem: 'ERP', sourceBillType: 'FinReceipt',
        sourceBillId: '601', eventType: 'ERP_RECEIPT_ARRIVED', direction: 'FORWARD',
        processStatus: 'DRAFTED' } } },
    api: { getBusiness: async (path) => ({ code: 0, data: path.includes('/page?')
      ? { total: 1, list: [state.listed] } : state.draft }) },
    read: async (_, stage, sql) => {
      assert.match(sql, /tenant_id=1/)
      assert.match(sql, /deleted=0/)
      if (stage.endsWith('cash-source-drafts')) return state.sourceRows
      if (stage.endsWith('cash-draft')) return [state.sql]
      assert.match(sql, new RegExp(`account_set_id='${config.fmsAccountSetId}'`))
      if (stage.endsWith('cash-entries')) return state.entries
      return state.formal
    } }
}

test('FMS-004 cash proof joins actual source, inbox, draft and entry IDs with zero formal vouchers', async () => {
  const h = fms004CashProbe()
  const record = { checks: [] }
  assert.equal((await readFms004CashDraft(h.api, record, h.source, h)).id, '801')
  assert.equal(record.checks.length, 4)
  assert.ok(record.checks.every((row) => row.passed))
})

test('FMS-004 cash proof refuses write-off substitutes, historical drafts, implicit confirmation and forged SQL', async () => {
  for (const mutate of [
    (h) => { h.source.cash.event.eventType = 'ERP_RECEIVABLE_WRITE_OFF' },
    (h) => { h.state.draft.id = '899' },
    (h) => { h.state.draft.inboxId = '799' },
    (h) => { h.state.draft.accountSetId = '999' },
    (h) => { h.state.draft.sourceBillId = '699' },
    (h) => { h.state.draft.bizDate = '2026-10-06' },
    (h) => { h.state.draft.confirmedBy = '1' },
    (h) => { h.state.draft.postedTime = '2026-10-15T00:00:00' },
    (h) => { h.source.cash.event.processStatus = 'PENDING' },
    (h) => { h.state.draft.entries = [] },
    (h) => { h.state.draft.entries[1].id = h.state.draft.entries[0].id },
    (h) => { h.state.draft.entries[1].lineNo = h.state.draft.entries[0].lineNo },
    (h) => { h.state.draft.entries.push({ id: '903', lineNo: 3, accountCode: '999',
      direction: 'UNKNOWN', amount: '123.45' }) },
    (h) => { h.state.sql = h.state.sql.slice(0, 7) },
    (h) => { h.state.entries = [] },
    (h) => { h.state.listed.confirmedTime = '2026-10-15T00:00:00' },
    (h) => { h.state.sql[9] = '123' },
    (h) => { h.state.entries[0][4] = '123.46' },
    (h) => { h.state.sourceRows.push(['802', 'ERP_RECEIPT_ARRIVED', 'FinReceipt', '601', 'FMS-UNIT-OLD']) },
    (h) => { h.state.formal = [['1001', '801']] }
  ]) {
    const h = fms004CashProbe()
    mutate(h)
    await assert.rejects(readFms004CashDraft(h.api, { checks: [] }, h.source, h))
  }
})

function fms004ReversalProbe (role = 'receivable') {
  const prefix = role === 'receivable' ? '1' : '2'
  const sourceBillId = `${prefix}601`
  const eventType = role === 'receivable' ? 'ERP_RECEIPT_ARRIVED' : 'ERP_PAYMENT_DISBURSED'
  const sourceBillType = role === 'receivable' ? 'FinReceipt' : 'FinPayment'
  const eventId = `ERP:${eventType}:${sourceBillType}:${sourceBillId}:32`
  const delivery = (direction) => {
    const suffix = direction === 'FORWARD' ? '1' : '2'
    const payload = { sourceSystem: 'ERP', eventType, sourceBillType, sourceBillId,
      sourceVersion: '32', sourceEventId: eventId + (suffix === '2' ? ':REVERSE' : ''),
      accountSetId: config.fmsAccountSetId, direction,
      ...(suffix === '2' ? { reversalOfEventId: eventId } : {}) }
    const event = { ...payload, id: `${prefix}70${suffix}`, draftId: `${prefix}80${suffix}`,
      processStatus: 'DRAFTED' }
    const draft = { id: event.draftId, inboxId: event.id, accountSetId: config.fmsAccountSetId,
      sourceSystem: 'ERP', eventType, sourceBillType, sourceBillId,
      draftNo: `FMS-UNIT-${event.draftId}`, bizDate: '2026-10-07', status: 'DRAFT',
      debitTotal: '123.45', creditTotal: '123.45',
      entries: [
        { id: `${prefix}90${suffix}1`, lineNo: 1, accountCode: '1002',
          direction: suffix === '1' ? 'DEBIT' : 'CREDIT', amount: '123.45' },
        { id: `${prefix}90${suffix}2`, lineNo: 2, accountCode: role === 'receivable' ? '1122' : '2202',
          direction: suffix === '1' ? 'CREDIT' : 'DEBIT', amount: '123.45' }
      ] }
    return { event, payload, draft, outboxId: `${prefix}50${suffix}`,
      duplicate: { id: event.id, draftId: event.draftId, duplicated: true } }
  }
  const source = { role, cash: delivery('FORWARD'), cashReverse: delivery('REVERSE') }
  const state = { original: { ...structuredClone(source.cash.draft), status: 'CANCELLED',
    cancelledBy: '1', cancelledTime: '2026-10-15T10:00:00' }, calls: [] }
  source.originalDraftAfterReversal = state.original
  return { source, state,
    api: { getBusiness: async (path) => {
      state.calls.push(path)
      if (path.includes('/page?')) return { code: 0,
        data: { total: 1, list: [{ ...source.cashReverse.draft, entries: null }] } }
      const draft = path.endsWith(`id=${source.cash.event.draftId}`)
        ? state.original : source.cashReverse.draft
      return { code: 0, data: draft }
    } },
    read: async (_, stage, sql) => {
      assert.match(sql, /tenant_id=1 AND deleted=0|e.tenant_id=1 AND e.deleted=0/)
      const d = source.cashReverse.draft
      if (stage.endsWith('original-after-reversal')) {
        return [[state.original.id, state.original.status,
          state.original.cancelledBy ?? 'NULL', state.original.cancelledTime ?? 'NULL']]
      }
      if (stage.endsWith('source-drafts')) {
        return [[d.id, d.eventType, d.sourceBillType, d.sourceBillId, d.draftNo]]
      }
      if (stage.endsWith('-draft')) return [[d.id, d.inboxId, d.accountSetId, d.status, d.bizDate,
        d.debitTotal, d.creditTotal, 'NULL', 'NULL', 'NULL', 'NULL', 'NULL']]
      if (stage.endsWith('-entries')) return d.entries.map((entry) =>
        [entry.id, String(entry.lineNo), entry.accountCode, entry.direction, entry.amount])
      assert.match(stage, /no-formal-voucher$/)
      return []
    } }
}

const fms004Definition = () => JSON.parse(
  readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8')
).suites.flatMap((suite) => suite.cases).find((item) => item.id === 'FMS-004')

function fms004PriorPass () {
  const definition = fms004Definition()
  return { checks: [], notes: [], catalogEvidence: Object.fromEntries(
    [...definition.assertions, ...definition.reverse].map((text) =>
      [text, { status: 'PASS', evidence: 'legacy candidate, not strict reverse evidence' }])
  ), passCandidate: true }
}

function fms004Pending (delivery) {
  delivery.event.processStatus = 'PENDING'
  delivery.event.draftId = null
  delivery.duplicate.draftId = null
  delivery.draft = null
}

test('FMS-004 pending forward and reverse are registration only, never accounting draft proof', () => {
  const { source } = fms004ReversalProbe()
  fms004Pending(source.cash)
  fms004Pending(source.cashReverse)
  source.originalDraftAfterReversal = null
  const evidence = assessFms004CashReversalEvidence(source)
  assert.equal(evidence.eventRegistered, true)
  assert.equal(evidence.accountingDraftVerified, false)
  assert.equal(evidence.originalDraftCancelled, false)
  assert.equal(evidence.status, 'PARTIAL')
  assert.deepEqual(evidence.defects, [])
  assert.equal(evidence.gaps.length, 2)
})

test('FMS-004 rejects a reverse draft whose referenced forward event is still PENDING', () => {
  const { source } = fms004ReversalProbe()
  fms004Pending(source.cash)
  source.originalDraftAfterReversal = null
  const evidence = assessFms004CashReversalEvidence(source)
  assert.equal(evidence.eventRegistered, true)
  assert.equal(evidence.accountingDraftVerified, false)
  assert.equal(evidence.status, 'FAIL')
  assert.ok(evidence.defects.includes('正向尚未生成草稿，反向却已生成会计草稿'))
})

test('FMS-004 unchanged unconfirmed original is an ADR violation, not a successful reversal', () => {
  const { source } = fms004ReversalProbe()
  source.originalDraftAfterReversal = structuredClone(source.cash.draft)
  const evidence = assessFms004CashReversalEvidence(source)
  assert.equal(evidence.eventRegistered, true)
  assert.equal(evidence.accountingDraftVerified, true)
  assert.equal(evidence.originalDraftCancelled, false)
  assert.equal(evidence.status, 'FAIL')
  assert.ok(evidence.defects.some((text) => text.includes('ADR 3.5')))
})

test('FMS-004 distinguishes same-payload replay from a new source revision after void', () => {
  const { source } = fms004ReversalProbe()
  assert.throws(() => assertFms004CashRevision(source.cash, structuredClone(source.cash)), /未升 sourceVersion/)
  const next = structuredClone(source.cash)
  next.outboxId = '1503'
  Object.assign(next.event, { sourceVersion: '33', sourceEventId: 'ERP:receipt:1601:33',
    id: '1703', draftId: '1803' })
  Object.assign(next.payload, { sourceVersion: '33', sourceEventId: next.event.sourceEventId })
  Object.assign(next.draft, { id: '1803', inboxId: '1703', draftNo: 'FMS-UNIT-1803' })
  assert.equal(assertFms004CashRevision(source.cash, next), true)
  source.reexecutedCash = next
  assert.equal(assessFms004CashReversalEvidence(source).sourceRevisionVerified, true)
  for (const mutate of [
    (n) => { n.event.sourceVersion = '32'; n.payload.sourceVersion = '32' },
    (n) => { n.event.draftId = source.cash.event.draftId; n.draft.id = source.cash.draft.id },
    (n) => { n.event.id = source.cash.event.id },
    (n) => { n.event.sourceBillId = 'other-bill' }
  ]) {
    const copy = structuredClone(next)
    mutate(copy)
    assert.throws(() => assertFms004CashRevision(source.cash, copy))
    source.reexecutedCash = copy
    assert.equal(assessFms004CashReversalEvidence(source).status, 'FAIL')
  }
})

test('FMS-004 strict reversal rejects identity, version, idempotency, entry and audit drift', () => {
  for (const mutate of [
    (s) => { s.cashReverse.event.sourceVersion = '33' },
    (s) => { s.cashReverse.payload.sourceVersion = '33' },
    (s) => { s.cashReverse.event.reversalOfEventId = 'other-forward' },
    (s) => { s.cashReverse.payload.reversalOfEventId = 'other-forward' },
    (s) => { s.cashReverse.payload.accountSetId = '999' },
    (s) => { s.cashReverse.outboxId = s.cash.outboxId },
    (s) => { s.cashReverse.event.id = s.cash.event.id },
    (s) => { s.cashReverse.duplicate.duplicated = false },
    (s) => { s.cashReverse.duplicate.draftId = '999' },
    (s) => { s.cashReverse.draft.entries = [] },
    (s) => { s.cashReverse.draft.entries[0].accountCode = '9999' },
    (s) => { s.cashReverse.draft.entries[0].auxiliaryCode = 'OTHER' },
    (s) => { s.cashReverse.draft.entries.forEach((e, i) => { e.direction = s.cash.draft.entries[i].direction }) },
    (s) => { s.originalDraftAfterReversal.cancelledTime = null },
    (s) => { s.originalDraftAfterReversal.voucherId = '999' },
    (s) => { s.originalDraftAfterReversal.entries = [] }
  ]) {
    const { source } = fms004ReversalProbe()
    mutate(source)
    const evidence = assessFms004CashReversalEvidence(source)
    assert.equal(evidence.status, 'FAIL', JSON.stringify(evidence))
    assert.ok(evidence.defects.length > 0)
  }
})

test('FMS-004 reversal independently reads API/SQL and preserves the original before-image', async () => {
  for (const role of ['receivable', 'payable']) {
    const h = fms004ReversalProbe(role)
    const before = structuredClone(h.source)
    const record = { checks: [] }
    const result = await readFms004CashReversalEvidence(h.api, record, h.source, h)
    assert.equal(result.status, 'PASS')
    assert.equal(result.accountingDraftVerified, true)
    assert.equal(result.originalDraftCancelled, true)
    assert.deepEqual(record.fms004CashReversalEvidence, [result])
    assert.equal(record.checks.length, 5)
    assert.ok(record.checks.every((item) => item.passed))
    assert.deepEqual(h.source, before)
    assert.ok(h.state.calls.includes(`/fms/voucher-draft/get?id=${h.source.cash.event.draftId}`))
  }
})

test('FMS-004 reversal refuses missing SQL, false business responses and original status drift', async () => {
  for (const mutate of [
    (h) => { h.read = async () => [] },
    (h) => { h.api.getBusiness = async () => ({ code: 500, msg: 'failure' }) },
    (h) => {
      const read = h.read
      h.read = async (...args) => args[1].endsWith('original-after-reversal')
        ? [[h.state.original.id, 'DRAFT', 'NULL', 'NULL']] : read(...args)
    },
    (h) => {
      const read = h.read
      h.read = async (...args) => args[1].endsWith('original-after-reversal')
        ? [[h.state.original.id, 'CANCELLED', '1', '2026-10-15 09:00:00']] : read(...args)
    }
  ]) {
    const h = fms004ReversalProbe()
    mutate(h)
    const record = { checks: [] }
    await assert.rejects(readFms004CashReversalEvidence(h.api, record, h.source, h))
    assert.equal(record.fms004CashReversalEvidence, undefined)
  }
})

test('FMS-004 final gate demotes legacy PASS without complete, distinct two-role reverse evidence', () => {
  const definition = fms004Definition()
  for (const makeEvidence of [
    () => [],
    () => [assessFms004CashReversalEvidence(fms004ReversalProbe().source)],
    () => Array.from({ length: 2 }, () => assessFms004CashReversalEvidence(fms004ReversalProbe().source)),
    () => {
      const results = ['receivable', 'payable'].map((role) =>
        assessFms004CashReversalEvidence(fms004ReversalProbe(role).source))
      results[1].sourceBillId = results[0].sourceBillId
      return results
    }
  ]) {
    const record = fms004PriorPass()
    record.fms004CashReversalEvidence = makeEvidence()
    finalizeFms004CashReversalEvidence(record)
    assert.equal(catalogResult(record, definition).partial, true)
    assert.equal(record.passCandidate, false)
    assert.equal(record.catalogEvidence[definition.reverse[0]].status, 'UNVERIFIED')
    assert.equal(record.catalogEvidence[definition.assertions[2]].status, 'UNVERIFIED')
  }
})

test('FMS-004 final gate separates pending gaps, confirmed defects and complete cancellation evidence', async () => {
  const definition = fms004Definition()
  for (const kind of ['pending', 'unchanged', 'complete']) {
    const record = fms004PriorPass()
    for (const role of ['receivable', 'payable']) {
      const h = fms004ReversalProbe(role)
      if (kind === 'pending') {
        fms004Pending(h.source.cash)
        fms004Pending(h.source.cashReverse)
      }
      if (kind === 'unchanged') h.state.original = structuredClone(h.source.cash.draft)
      await readFms004CashReversalEvidence(h.api, record, h.source, h)
    }
    finalizeFms004CashReversalEvidence(record)
    assert.equal(record.catalogEvidence[definition.reverse[0]].status, 'PASS')
    assert.equal(record.catalogEvidence[definition.assertions[2]].status,
      kind === 'pending' ? 'UNVERIFIED' : kind === 'unchanged' ? 'FAIL' : 'PASS')
    assert.equal(catalogResult(record, definition).partial, kind !== 'complete')
    assert.equal(record.passCandidate, kind === 'complete')
  }
})

test('FMS-004 final context read applies strict evidence gate even with the unchanged main fixture', async () => {
  const h = fms004ContextProbe()
  const record = fms004PriorPass()
  await readFms004Context(h.api, record, 'after', h)
  assert.equal(catalogResult(record, fms004Definition()).partial, true)
  assert.equal(record.passCandidate, false)
  record.catalogEvidence[fms004Definition().assertions[2]].status = 'FAIL'
  finalizeFms004CashReversalEvidence(record)
  assert.equal(record.catalogEvidence[fms004Definition().assertions[2]].status, 'FAIL')
})

function fms004CashMainProbe (kind = 'complete') {
  const probes = ['receivable', 'payable'].map((role) => fms004ReversalProbe(role))
  const state = { calls: [], effective: '1' }
  const record = fms004PriorPass()
  for (const h of probes) {
    const { source } = h
    source.fixture = { writeoffCleaned: true, paymentDeleted: source.role === 'payable',
      [source.role === 'receivable' ? 'receiptId' : 'paymentId']: source.cash.event.sourceBillId }
    if (kind === 'unchanged') h.state.original = structuredClone(source.cash.draft)
    if (kind === 'pending') {
      fms004Pending(source.cash)
      fms004Pending(source.cashReverse)
    }
  }
  const api = {
    getBusiness: async (path) => {
      state.calls.push(path)
      if (path.startsWith('/finance/finReceipt/queryById?')) {
        assert.equal(new URL(path, 'http://127.0.0.1').searchParams.get('id'),
          probes[0].source.fixture.receiptId)
        return { code: 0, data: { isEffective: state.effective } }
      }
      const query = new URL(path, 'http://127.0.0.1').searchParams
      const h = probes.find(({ source }) => query.get('sourceBillId') === source.cash.event.sourceBillId ||
        [source.cash.event.draftId, source.cashReverse.event.draftId].includes(query.get('id')))
      assert.ok(h, `unexpected fixture API read: ${path}`)
      return h.api.getBusiness(path)
    },
    putBusiness: async (path, body) => {
      assert.equal(path, '/finance/finReceipt/void')
      assert.equal(body.id, probes[0].source.fixture.receiptId)
      state.calls.push('receipt-void')
      state.effective = '0'
      return { code: 0, data: true }
    }
  }
  const options = {
    readDelivery: async (client, caseRecord, id, type, direction) => {
      assert.equal(client, api)
      assert.equal(caseRecord, record)
      const h = probes.find(({ source }) => source.cash.event.sourceBillId === id)
      assert.ok(h)
      assert.equal(type, h.source.cash.event.eventType)
      assert.equal(direction, 'REVERSE')
      assert.equal(h.source.fixture.cashVoided, true)
      state.calls.push(`delivery:${h.source.role}`)
      return structuredClone(h.source.cashReverse)
    },
    readEvidence: async (client, caseRecord, source) => {
      assert.equal(client, api)
      assert.equal(caseRecord, record)
      const h = probes.find((h) => h.source === source)
      assert.ok(h)
      state.calls.push(`strict:${source.role}`)
      return readFms004CashReversalEvidence(client, caseRecord, source, { read: h.read })
    }
  }
  return { probes, record, api, options, state,
    sources: probes.map((h) => h.source),
    run: () => runFmsCashReversalClosure({ api, caseRecord: record },
      probes.map((h) => h.source), options) }
}

test('FMS-004 cash main chain invokes real strict API/SQL reader for both voided sources', async () => {
  const h = fms004CashMainProbe()
  const result = await h.run()
  assert.equal(result.length, 2)
  assert.deepEqual(h.state.calls.filter((call) => call.startsWith('strict:')).sort(),
    ['strict:payable', 'strict:receivable'])
  assert.equal(h.state.calls.filter((call) => call === 'receipt-void').length, 1)
  assert.equal(h.record.fms004CashReversalEvidence.length, 2)
  for (const source of h.sources) {
    assert.equal(source.cashReverseVerified, true)
    assert.equal(source.cashReverseEvidence.status, 'PASS')
  }
  finalizeFms004CashReversalEvidence(h.record)
  assert.equal(catalogResult(h.record, fms004Definition()).partial, false)
  assert.equal(h.record.passCandidate, true)
  assert.equal(h.record.notes.filter((note) => note.startsWith('GAP:') &&
    note.includes('sourceVersion')).length, 2)
})

test('FMS-004 cash main chain keeps PENDING partial and fails an unchanged original draft', async () => {
  for (const kind of ['pending', 'unchanged']) {
    const h = fms004CashMainProbe(kind)
    const result = await h.run()
    assert.equal(result.length, 2)
    assert.ok(result.every((item) => item.eventRegistered))
    assert.ok(result.every((item) => item.status === (kind === 'pending' ? 'PARTIAL' : 'FAIL')))
    finalizeFms004CashReversalEvidence(h.record)
    assert.equal(catalogResult(h.record, fms004Definition()).partial, true)
    assert.equal(h.record.passCandidate, false)
    const draftProof = h.record.catalogEvidence[fms004Definition().assertions[2]]
    assert.equal(draftProof.status, kind === 'pending' ? 'UNVERIFIED' : 'FAIL')
    if (kind === 'unchanged') {
      assert.ok(h.record.checks.some((item) => item.passed === false &&
        item.name.includes('现金取消/反向严格证据门禁')))
    }
  }
})

test('FMS-004 cash main chain drains sibling evidence before propagating API/SQL failure', async () => {
  const h = fms004CashMainProbe()
  const originalRead = h.probes[0].read
  h.probes[0].read = async (...args) =>
    args[1].endsWith('cash-reverse-entries') ? [] : originalRead(...args)
  let siblingFinished = false
  const readEvidence = h.options.readEvidence
  h.options.readEvidence = async (...args) => {
    if (args[2].role === 'payable') await fmsTaskTurn()
    const result = await readEvidence(...args)
    if (args[2].role === 'payable') siblingFinished = true
    return result
  }
  await assert.rejects(h.run(), /分录 API\/SQL 精确一致/)
  assert.equal(siblingFinished, true)
  assert.equal(h.sources[0].cashReverseVerified, undefined)
  assert.equal(h.record.fms004CashReversalEvidence.length, 1)
  finalizeFms004CashReversalEvidence(h.record)
  assert.equal(catalogResult(h.record, fms004Definition()).partial, true)
  assert.equal(h.record.passCandidate, false)
})

test('FMS-004 cash main chain never accepts an empty role collection as reversal evidence', async () => {
  const record = { checks: [], notes: [] }
  const result = await runFmsCashReversalClosure({ api: {}, caseRecord: record }, [])
  assert.deepEqual(result, [])
  assert.equal(record.catalogEvidence[fms004Definition().reverse[0]].status, 'FAIL')
  assert.ok(record.checks.some((item) => item.passed === false))
})

test('FMS-004 main fixture uses scoped writes, final context gate and only read-only UI controls', () => {
  const fixture = readFileSync(new URL('../fixtures/fms-write-closure.mjs', import.meta.url), 'utf8')
  const branch = fixture.slice(fixture.indexOf('export async function runFms004Closure'),
    fixture.indexOf('async function runFms007Closure'))
  const guard = branch.indexOf('assertFms004WriteScope()')
  assert.ok(guard >= 0 && guard < branch.indexOf('ensureAcceptanceNumbering('))
  assert.match(branch, /await runFmsCashReversalClosure\(ctx, sources\)/)
  assert.match(branch, /readFms004Context\(api, caseRecord, 'after'\)/)
  const cashBranch = fixture.slice(fixture.indexOf('export async function runFmsCashReversalClosure'),
    fixture.indexOf('export async function runFms004Closure'))
  assert.match(cashBranch, /readEvidence = readFms004CashReversalEvidence/)
  assert.doesNotMatch(cashBranch, /originalUnchanged|originalDraftUnchanged|原草稿不变/)
  assert.match(cashBranch, /certify\(caseRecord, 'FMS-004', 0,[\s\S]*?, true\)/)
  assert.deepEqual(
    [...branch.matchAll(/certify\(caseRecord, 'FMS-004', (\d+),/g)]
      .map((match) => Number(match[1])),
    [0, 1, 2, 3, 2],
  )
  const ui = readFileSync(new URL('../fixtures/fms-004-evidence.mjs', import.meta.url), 'utf8')
  assert.match(ui, /name: '搜索'/)
  assert.match(ui, /name: '详情'/)
  assert.doesNotMatch(ui, /name: '确认'|postBusiness|putBusiness|deleteBusiness|route\.fulfill|setContent/)
})
