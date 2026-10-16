import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COST_PURCHASE_REPORT_CHECKS,
  __test as helpers
} from '../fixtures/cost-purchase-report-closure.mjs'
import { costCatalogEvidence } from '../suites/cost.mjs'

const business = (data) => ({ code: 0, data })
const ownedFixture = () => ({
  suffix: 'UNIT', month: '2212-01', modelId: '2002', periodId: '2003',
  versionNo: 'E2E-C12-UNIT', materialId: '2110561246932443138',
  purchaseInId: '2110561246932443139', purchaseOrderId: '2110561246932443140',
  receiptNo: 'CGRK-C12-UNIT', period: { enterpriseType: 'MANUFACTURING' }
})
const ownedPeriod = (fixture) => ({
  id: fixture.periodId, accountingOrgId: 1, period: fixture.month,
  modelVersionId: fixture.modelId, modelVersionNo: fixture.versionNo,
  enterpriseType: 'MANUFACTURING', status: 'ACCOUNTING'
})
const receiptFor = (fixture) => ({
  id: fixture.purchaseInId, orderId: fixture.purchaseOrderId, status: 20,
  businessType: 'NORMAL', no: fixture.receiptNo,
  items: [{
    id: '2110561246932443141', productId: fixture.materialId,
    count: 2, totalPrice: '123.45'
  }]
})
const draftFor = (fixture) => ({
  id: '910', periodId: fixture.periodId, snapshotKey: 'PURCHASE',
  versionNo: fixture.versionNo, snapshotHash: 'a'.repeat(64), status: 'DRAFT',
  lines: [{
    sourceModule: 'ERP', sourceType: 'PURCHASE_RECEIPT', sourceId: fixture.purchaseInId,
    sourceLineId: receiptFor(fixture).items[0].id, sourceNo: fixture.receiptNo,
    sourceStatus: 'DRAFT', productCode: fixture.materialId,
    mappingStatus: 'MAPPED', quantity: 2, materialAmount: '123.45',
    invoicePriceStatus: 'PARTIAL_INVOICE', invoicePriceScope: 'PURCHASE_ORDER',
    invoiceAmount: '100.00', invoiceExpectedAmount: '123.45', invoicePriceDifference: 0
  }]
})
const confirmDraft = (draft) => ({
  ...structuredClone(draft), status: 'CONFIRMED',
  lines: draft.lines.map((line) => ({ ...line, sourceStatus: 'CONFIRMED' }))
})
const confirmedClosureFor = (fixture) => {
  const draft = draftFor(fixture)
  const confirmed = confirmDraft(draft)
  return {
    complete: false, snapshot: draft,
    confirmedSnapshot: confirmed, rereadSnapshot: structuredClone(confirmed)
  }
}
const confirmedDbFor = (fixture, snapshot) => ({
  available: true,
  rows: [
    ['snapshot', snapshot.id, fixture.periodId, 'SOURCE', 'PURCHASE', fixture.versionNo,
      'CONFIRMED', '1001', '2026-10-15 19:00:00', snapshot.snapshotHash],
    ...snapshot.lines.map((line) => [
      'line', line.sourceModule, line.sourceType, line.sourceId, line.sourceLineId,
      line.productCode, String(line.quantity), line.materialAmount, 'CONFIRMED', 'MAPPED',
      JSON.stringify(line)
    ])
  ]
})

test('COST-012 names four distinct evidence checks', () => {
  const names = Object.values(COST_PURCHASE_REPORT_CHECKS)
  assert.equal(new Set(names).size, 4)
  assert.ok(names.every((name) => name.startsWith('COST-012 ')))
})

test('COST-012 order-level invoice fallback keeps row-level unit price absent', () => {
  const fixture = { purchaseInId: '1001' }
  const line = helpers.sourceLine({
    lines: [{
      sourceType: 'PURCHASE_RECEIPT',
      sourceId: '1001',
      invoicePriceScope: 'PURCHASE_ORDER'
    }]
  }, fixture)
  assert.equal(line.invoicePriceScope, 'PURCHASE_ORDER')
  assert.equal(helpers.sameMoney('100.00', 100), true)
  assert.equal(helpers.reviewerPermissions.includes('cost:publication:publish'), true)
})

test('COST-012 trial uses the owned period without changing its enterprise track', () => {
  const fixture = {
    suffix: 'UNIT',
    month: '2212-01',
    modelId: '2002',
    periodId: '2003',
    versionNo: 'E2E-C12-UNIT',
    period: { enterpriseType: 'MANUFACTURING' }
  }
  const period = {
    id: fixture.periodId, accountingOrgId: 1, period: fixture.month,
    modelVersionId: fixture.modelId, modelVersionNo: fixture.versionNo,
    enterpriseType: 'MANUFACTURING', status: 'ACCOUNTING'
  }
  assert.deepEqual(helpers.purchaseTrialPayload({ fixture, period }), {
    enterpriseType: 'MANUFACTURING',
    periodId: '2003',
    modelVersion: 'E2E-C12-UNIT',
    requestId: 'e2e-cost012-trial-UNIT'
  })
  for (const change of [
    { id: '2004' }, { accountingOrgId: 2 }, { period: '2212-02' },
    { modelVersionId: '2005' }, { modelVersionNo: 'OTHER' },
    { enterpriseType: 'TRADE' }, { status: 'COST_PUBLISHED' }
  ]) assert.throws(() => helpers.purchaseTrialPayload({
    fixture, period: { ...period, ...change }
  }))
})

test('COST-012 rejects an empty purchase source snapshot', () => {
  assert.throws(
    () => helpers.sourceLine({ lines: [] }, { purchaseInId: '1001' }),
    /采购来源快照为空/
  )
})

test('COST-012 money comparisons do not round away missing values or sub-cent differences', () => {
  assert.equal(helpers.sameMoney('123.45000000', 123.45), true)
  assert.equal(helpers.sameMoney('123.45000001', 123.45), false)
  for (const value of [null, undefined, '', NaN, 'NaN', '1.000000001']) {
    assert.throws(() => helpers.sameMoney(value, 0))
    assert.throws(() => helpers.sameMoney(0, value))
  }
})

test('COST-012 rejects duplicate owned purchase receipt sources', () => {
  const fixture = ownedFixture()
  const draft = draftFor(fixture)
  draft.lines.push({ ...draft.lines[0], sourceLineId: '2110561246932443142' })
  assert.throws(() => helpers.sourceLine(draft, fixture), /缺少或重复/)
})

test('COST-012 refreshes, confirms and rereads the exact invoice source without editing it', async () => {
  const fixture = ownedFixture()
  const draft = draftFor(fixture)
  const confirmed = confirmDraft(draft)
  const calls = []
  const closure = { complete: false }
  const caseRecord = {}
  let reads = 0
  const api = {
    postBusiness: async (pathname, body) => {
      calls.push(['POST', pathname, body])
      return business(structuredClone(pathname.endsWith('/refresh') ? draft : confirmed))
    },
    getBusiness: async (pathname) => {
      calls.push(['GET', pathname])
      return business(structuredClone(confirmed))
    }
  }
  await helpers.prepareInvoiceSnapshot({
    api, fixture, invoice: { invoiceMoney: 100 }, receipt: receiptFor(fixture), closure,
    caseRecord,
    readSql: async (sql) => {
      reads++
      assert.match(sql, /period_id=2003/)
      assert.match(sql, /id=910/)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/i)
      return confirmedDbFor(fixture, confirmed)
    }
  })
  assert.deepEqual(calls, [
    ['POST', '/cost/periods/2003/source-snapshot/purchase/refresh', undefined],
    ['POST', '/cost/periods/2003/source-snapshot/confirm?snapshotKey=PURCHASE&versionNo=E2E-C12-UNIT', undefined],
    ['GET', '/cost/periods/2003/source-snapshot?snapshotKey=PURCHASE&versionNo=E2E-C12-UNIT']
  ])
  assert.deepEqual(closure.snapshot, draft)
  assert.deepEqual(closure.confirmedSnapshot, confirmed)
  assert.deepEqual(closure.rereadSnapshot, confirmed)
  assert.deepEqual(closure.confirmedDatabase, confirmedDbFor(fixture, confirmed))
  assert.equal(closure.complete, false)
  assert.equal(reads, 1)
  assert.equal(caseRecord.database[0].stage, 'purchase-confirmed')
})

test('COST-012 refuses changed invoice or receipt facts before confirming a snapshot', async () => {
  const fixture = ownedFixture()
  for (const change of [
    { quantity: 3 }, { materialAmount: 123.46 }, { sourceLineId: '999' },
    { invoiceAmount: '100.00000001' }, { invoiceExpectedAmount: 123.46 },
    { invoicePriceDifference: null }, { invoicePriceScope: 'LINE' }
  ]) {
    const draft = draftFor(fixture)
    Object.assign(draft.lines[0], change)
    let posts = 0
    await assert.rejects(helpers.prepareInvoiceSnapshot({
      fixture, receipt: receiptFor(fixture), invoice: { invoiceMoney: 100 }, closure: {},
      caseRecord: {}, readSql: async () => assert.fail('Invalid draft must not query the database'),
      api: { postBusiness: async () => { posts++; return business(draft) } }
    }))
    assert.equal(posts, 1)
  }
})

test('COST-012 keeps confirmation and reread mismatch evidence and refuses it', async () => {
  const fixture = ownedFixture()
  for (const corruptAt of ['confirmation', 'reread']) {
    const draft = draftFor(fixture)
    const confirmed = confirmDraft(draft)
    const corrupt = structuredClone(confirmed)
    corrupt.lines[0].invoiceAmount = '99.99'
    let reads = 0
    const closure = { complete: false }
    await assert.rejects(helpers.prepareInvoiceSnapshot({
      fixture, invoice: { invoiceMoney: 100 }, receipt: receiptFor(fixture), closure,
      caseRecord: {}, readSql: async () => assert.fail('Changed sources must not reach database evidence'),
      api: {
        postBusiness: async (pathname) => business(pathname.endsWith('/refresh')
          ? draft : corruptAt === 'confirmation' ? corrupt : confirmed),
        getBusiness: async () => { reads++; return business(corrupt) }
      }
    }), /改变了真实来源/)
    assert.equal(closure.complete, false)
    assert.deepEqual(closure.snapshot, draft)
    assert.equal(reads, corruptAt === 'confirmation' ? 0 : 1)
    assert.deepEqual(corruptAt === 'confirmation'
      ? closure.confirmedSnapshot : closure.rereadSnapshot, corrupt)
  }
})

test('COST-012 records confirmed source readiness without changing an inapplicable track', () => {
  const fixture = ownedFixture()
  const closure = confirmedClosureFor(fixture)
  const before = structuredClone({ fixture, closure })
  const manufacturing = helpers.describePurchaseTrialSources({
    fixture, period: ownedPeriod(fixture), closure
  })
  assert.equal(manufacturing.confirmedPurchaseSources, 1)
  assert.equal(manufacturing.applicablePurchaseSources, 0)
  assert.equal(manufacturing.publicationIncludesPurchaseSources, false)
  assert.match(manufacturing.reason, /MANUFACTURING/)
  const trade = helpers.describePurchaseTrialSources({
    fixture: { ...fixture, period: { enterpriseType: 'TRADE' } },
    period: { ...ownedPeriod(fixture), enterpriseType: 'TRADE' }, closure
  })
  assert.equal(trade.applicablePurchaseSources, 1)
  assert.equal(trade.publicationIncludesPurchaseSources, true)
  assert.deepEqual({ fixture, closure }, before)
  assert.throws(() => helpers.describePurchaseTrialSources({
    fixture, period: { ...ownedPeriod(fixture), enterpriseType: 'TRADE' }, closure
  }), /企业类型归属不一致/)
  for (const key of ['confirmedSnapshot', 'rereadSnapshot']) {
    const invalid = structuredClone(closure)
    invalid[key].lines[0].quantity = 3
    assert.throws(() => helpers.describePurchaseTrialSources({
      fixture, period: ownedPeriod(fixture), closure: invalid
    }), /改变了真实来源/)
  }
})

test('COST-012 requires persisted confirmation evidence without repairing sources or declaring completion', async () => {
  const fixture = ownedFixture()
  const draft = draftFor(fixture)
  const confirmed = confirmDraft(draft)
  const invalidMapping = confirmedDbFor(fixture, confirmed)
  invalidMapping.rows[1][9] = 'UNMAPPED'
  for (const database of [{ available: false, rows: [] }, invalidMapping]) {
    const calls = []
    const caseRecord = {}
    const closure = { complete: false }
    await assert.rejects(helpers.prepareInvoiceSnapshot({
      fixture, invoice: { invoiceMoney: 100 }, receipt: receiptFor(fixture), closure,
      caseRecord, readSql: async () => database,
      api: {
        postBusiness: async (pathname) => {
          calls.push(['POST', pathname])
          assert.match(pathname, /\/source-snapshot\/(purchase\/refresh|confirm\?)/)
          return business(pathname.endsWith('/refresh') ? draft : confirmed)
        },
        getBusiness: async (pathname) => {
          calls.push(['GET', pathname])
          return business(confirmed)
        }
      }
    }))
    assert.equal(calls.length, 3)
    assert.equal(closure.complete, false)
    assert.deepEqual(closure.rereadSnapshot, confirmed)
    assert.deepEqual(caseRecord.database[0].rows, database.rows)
    assert.equal(fixture.publicationId, undefined)
    assert.equal(closure.trial, undefined)
  }
})

test('COST-012 preserves a trial rejection and never creates a reviewer or publication', async () => {
  const fixture = ownedFixture()
  const failure = new Error('/cost/periods/2003/trials business failure: {"code":422001,"msg":"no applicable confirmed sources"}')
  const calls = []
  const closure = confirmedClosureFor(fixture)
  await assert.rejects(helpers.publishOwnedPurchaseScenario({
    fixture, closure, record: {}, caseRecord: {},
    api: {
      getBusiness: async (pathname) => { calls.push(['GET', pathname]); return business(ownedPeriod(fixture)) },
      postBusiness: async (pathname, body) => {
        calls.push(['POST', pathname, body])
        throw failure
      }
    },
    dependencies: {
      createReviewer: async () => assert.fail('A rejected trial must not create a reviewer'),
      loginAs: async () => assert.fail('A rejected trial must not create a reviewer session'),
      createApiClient: () => assert.fail('A rejected trial must not attempt publication')
    }
  }), (error) => error === failure)
  assert.deepEqual(calls, [
    ['GET', '/cost/periods/2003'],
    ['POST', '/cost/periods/2003/trials', helpers.purchaseTrialPayload({
      fixture, period: ownedPeriod(fixture)
    })]
  ])
  assert.deepEqual(closure.trialFailure, {
    pathname: '/cost/periods/2003/trials', message: failure.message
  })
  assert.equal(closure.complete, false)
  assert.equal(closure.confirmedSnapshot.status, 'CONFIRMED')
  assert.equal(closure.trialSourceReadiness.applicablePurchaseSources, 0)
  assert.equal(closure.trialSourceReadiness.publicationIncludesPurchaseSources, false)
  assert.equal(closure.trial, undefined)
  assert.equal(fixture.publicationId, undefined)
})

test('COST-012 successful trial requires a separate reviewer and versioned confirmation and publication', async () => {
  const fixture = ownedFixture()
  fixture.period.enterpriseType = 'TRADE'
  const tradePeriod = { ...ownedPeriod(fixture), enterpriseType: 'TRADE' }
  const periods = [
    tradePeriod,
    { ...tradePeriod, currentTrialId: '3001', version: 2 },
    { ...tradePeriod, currentTrialId: '3001', version: 3 },
    { ...tradePeriod, status: 'COST_PUBLISHED', currentPublicationId: '4001', version: 4 }
  ]
  const calls = []
  const reviewer = { username: 'unit-reviewer', password: 'unit-password' }
  const closure = confirmedClosureFor(fixture)
  const result = await helpers.publishOwnedPurchaseScenario({
    fixture, closure, record: {}, caseRecord: {},
    api: {
      getBusiness: async (pathname) => { calls.push(['GET', pathname]); return business(periods.shift()) },
      postBusiness: async (pathname, payload) => {
        calls.push(['POST', pathname, payload])
        return business({ trialId: '3001' })
      }
    },
    dependencies: {
      createReviewer: async (options) => {
        assert.equal(options.loginImmediately, false)
        assert.deepEqual(options.permissions, helpers.reviewerPermissions)
        calls.push(['reviewer'])
        return reviewer
      },
      loginAs: async (_record, username, password) => {
        assert.equal(username, reviewer.username)
        assert.equal(password, reviewer.password)
        return 'unit-token'
      },
      createApiClient: ({ token }) => {
        assert.equal(token, 'unit-token')
        return {
          request: async (method, pathname, body, options) => {
            calls.push([method, pathname, body, options])
            return business(pathname.endsWith('/confirm')
              ? { periodId: fixture.periodId } : { publicationId: '4001' })
          }
        }
      }
    }
  })
  assert.equal(periods.length, 0)
  assert.ok(calls.findIndex((call) => call[1] === '/cost/periods/2003/trials') <
    calls.findIndex((call) => call[0] === 'reviewer'))
  assert.deepEqual(calls.filter((call) => call[3]), [
    ['POST', '/cost/trials/3001/confirm', undefined, { headers: {
      'If-Match': '2', 'X-Request-Id': 'e2e-cost012-confirm-UNIT'
    } }],
    ['POST', '/cost/periods/2003/publications', undefined, { headers: {
      'If-Match': '3', 'X-Request-Id': 'e2e-cost012-publish-UNIT'
    } }]
  ])
  assert.equal(result.reviewer, reviewer)
  assert.equal(fixture.publicationId, '4001')
  assert.equal(fixture.period.status, 'COST_PUBLISHED')
  assert.equal(closure.complete, false)
  assert.equal(closure.trialRequest.enterpriseType, 'TRADE')
  assert.equal(closure.trialSourceReadiness.applicablePurchaseSources, 1)
})

test('COST-012 formal report rejects empty, draft, mismatched or incomplete published rows', async () => {
  const fixture = { ...ownedFixture(), publicationId: '4001' }
  const report = {
    reportKey: 'purchase-cost-report', formal: true, publicationId: '4001',
    rows: [{ values: {
      receiptNo: fixture.receiptNo,
      invoicePriceStatus: 'PARTIAL_INVOICE', invoicePriceStatusText: '部分开票',
      invoicePriceScope: 'PURCHASE_ORDER', invoicePriceScopeText: '采购订单级比较',
      invoiceAmount: 100, invoiceExpectedAmount: 123.45, invoicePriceDifference: 0
    } }]
  }
  const apiFor = (value) => ({ getBusiness: async () => business(value) })
  assert.deepEqual((await helpers.readPublishedReport(apiFor(report), fixture)).report, report)
  for (const change of [
    { reportKey: 'OTHER' }, { formal: false }, { publicationId: '4002' }, { rows: [] }
  ]) await assert.rejects(helpers.readPublishedReport(apiFor({ ...report, ...change }), fixture))
  for (const key of ['invoicePriceStatus', 'invoicePriceStatusText', 'invoicePriceScope',
    'invoicePriceScopeText', 'invoicePriceDifference', 'invoiceAmount', 'invoiceExpectedAmount']) {
    const invalid = structuredClone(report)
    delete invalid.rows[0].values[key]
    await assert.rejects(helpers.readPublishedReport(apiFor(invalid), fixture))
  }
})

test('COST-012 catalog evidence requires a complete owned runtime fixture', () => {
  const record = {
    checks: Object.values(COST_PURCHASE_REPORT_CHECKS)
      .map((name) => ({ name, passed: true })),
    fixtures: { costPurchaseReport: { complete: true } },
    notes: []
  }
  costCatalogEvidence('COST-012', record)
  assert.equal(record.passCandidate, true)
  record.fixtures.costPurchaseReport.complete = false
  costCatalogEvidence('COST-012', record)
  assert.equal(record.passCandidate, false)
})
