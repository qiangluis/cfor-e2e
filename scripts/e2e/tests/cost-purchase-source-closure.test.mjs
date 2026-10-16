import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPurchaseConfirmed,
  assertPurchaseDraft,
  assertPurchaseReceipt,
  assertPurchaseReturn,
  buildCostPurchaseReturn,
  costPurchaseReturnEntryRemark,
  costPurchaseReturnRemark,
  costSourceAmountText,
  costSourceDecimal,
  readConfirmedPurchaseDatabase,
  readPurchaseDatabase,
  COST_PURCHASE_SOURCE_CHECKS,
  COST_PURCHASE_RETURN_CHECKS
} from '../fixtures/cost-purchase-source-closure.mjs'
import { costCatalogEvidence } from '../suites/cost.mjs'

const fixture = {
  periodId: '163', modelId: '251', versionNo: 'E2E-C-PURCHASE',
  month: '2212-01', materialId: '2110561246932443138',
  purchaseInId: '2110561246932443139', purchaseOrderId: '2110561246932443140',
  orderItemId: '2110561246932443141', supplierId: '2110561246932443142',
  unitId: '100', accountId: '10', suffix: 'AABBCC', remark: 'owned'
}
const receipt = {
  id: fixture.purchaseInId, orderId: fixture.purchaseOrderId,
  status: 20, businessType: 'NORMAL', no: 'CGRK-OWNED',
  items: [{ id: '2110561246932443143', productId: fixture.materialId, count: 2, totalPrice: '123.45' }]
}
const returned = {
  id: '2110561246932443144', srcBillId: fixture.purchaseOrderId, status: 20,
  isEffective: 1, isVoided: 0, billStage: '34', billNo: 'CGTH-OWNED',
  items: [{ id: '2110561246932443145', productId: fixture.materialId, count: 1, totalPrice: '61.725' }]
}
const snapshot = () => ({
  id: '910', periodId: fixture.periodId, snapshotKey: 'PURCHASE',
  versionNo: fixture.versionNo, status: 'DRAFT', snapshotHash: 'a'.repeat(64),
  lines: [{
    sourceModule: 'ERP', sourceType: 'PURCHASE_RECEIPT', sourceId: receipt.id,
    sourceLineId: receipt.items[0].id, productCode: fixture.materialId,
    sourceStatus: 'DRAFT', sourceNo: receipt.no, quantity: 2, materialAmount: '123.45'
  }, {
    sourceModule: 'ERP', sourceType: 'PURCHASE_RETURN', sourceId: returned.id,
    sourceLineId: returned.items[0].id, productCode: fixture.materialId,
    sourceStatus: 'DRAFT', sourceNo: returned.billNo, quantity: -1, materialAmount: '-61.725'
  }]
})

test('exact decimal comparison preserves cents and Snowflake identities', () => {
  assert.equal(costSourceDecimal('123.45000000'), costSourceDecimal(123.45))
  assert.equal(costSourceDecimal('-61.725'), -6172500000n)
  assert.equal(costSourceAmountText('-61.725'), '-61.73')
  assert.equal(costSourceAmountText('123.45000000'), '123.45')
  for (const value of [null, undefined, '', 'NaN', NaN, '1.000000001']) {
    assert.throws(() => costSourceDecimal(value))
  }
  const result = buildCostPurchaseReturn({
    fixture, entry: { warehouseId: '1', wareAreaId: null, wareLocationId: null },
    month: '2212-02', suffix: 'CROSS'
  })
  assert.equal(result.returnTime, '2212-02-08T10:00:00')
  assert.equal(result.srcBillId, fixture.purchaseOrderId)
  assert.equal(result.items[0].srcEntryId, fixture.orderItemId)
  assert.equal(result.returnType, 2)
  assert.equal(result.items[0].count, 1)
  assert.equal(result.items[0].areaHouseId, null)
  assert.equal(result.items[0].wareLocationId, null)
  assert.equal(result.remark, costPurchaseReturnRemark(fixture, 'CROSS'))
  assert.equal(result.items[0].remark, costPurchaseReturnEntryRemark(fixture, 'CROSS'))
  assert.ok(result.remark.length <= 50)
  assert.ok(result.items[0].remark.length <= 50)
  assert.notEqual(result.remark, buildCostPurchaseReturn({
    fixture, entry: { warehouseId: '1' }, month: '2212-02', suffix: 'NORMAL'
  }).remark)
  const blankDimensions = buildCostPurchaseReturn({
    fixture, entry: { warehouseId: '1', wareAreaId: '  ', wareLocationId: '' },
    month: '2212-02', suffix: 'BLANK-DIMENSIONS'
  })
  assert.equal(blankDimensions.items[0].areaHouseId, null)
  assert.equal(blankDimensions.items[0].wareLocationId, null)
})

test('nonempty draft proves separately audited source and unconfirmed cost boundaries', () => {
  assertPurchaseReceipt(snapshot(), fixture, receipt)
  assertPurchaseReturn(snapshot(), fixture, returned)
  for (const change of [
    { lines: [] }, { periodId: '999' }, { status: 'CONFIRMED' },
    { confirmedBy: '1' }, { confirmedAt: '2026-10-15' }
  ]) assert.throws(() => assertPurchaseDraft({ ...snapshot(), ...change }, fixture))
})

const confirmedSnapshot = (draft) => ({
  ...structuredClone(draft),
  status: 'CONFIRMED',
  lines: draft.lines.map((line) => ({ ...structuredClone(line), sourceStatus: 'CONFIRMED' }))
})

test('purchase confirmation preserves every signed source and invoice fact', () => {
  const draft = snapshot()
  Object.assign(draft.lines[0], {
    costCenterCode: null, mappingStatus: 'MAPPED',
    invoicePriceStatus: 'PARTIAL_INVOICE', invoicePriceScope: 'PURCHASE_ORDER',
    invoiceAmount: '100.00', invoiceExpectedAmount: '123.45', invoicePriceDifference: 0
  })
  const confirmed = confirmedSnapshot(draft)
  confirmed.lines.reverse()
  assert.equal(assertPurchaseConfirmed(confirmed, fixture, draft), confirmed)
  assert.equal(Object.hasOwn(confirmed, 'confirmedAt'), false)
  assert.equal(Object.hasOwn(confirmed, 'confirmedBy'), false)
  assert.equal(draft.status, 'DRAFT')
  assert.equal(draft.lines[0].sourceStatus, 'DRAFT')
})

test('purchase confirmation rejects changed identity, amounts and invoice metadata', () => {
  const draft = snapshot()
  Object.assign(draft.lines[0], {
    costCenterCode: null, mappingStatus: 'MAPPED',
    invoicePriceStatus: 'PARTIAL_INVOICE', invoicePriceScope: 'PURCHASE_ORDER',
    invoiceAmount: '100.00', invoiceExpectedAmount: '123.45', invoicePriceDifference: 0
  })
  for (const change of [
    { id: '911' }, { periodId: '999' }, { snapshotKey: 'DEFAULT' },
    { versionNo: 'OTHER' }, { snapshotHash: 'b'.repeat(64) }, { status: 'DRAFT' },
    { lines: [] }
  ]) assert.throws(() => assertPurchaseConfirmed({
    ...confirmedSnapshot(draft), ...change
  }, fixture, draft))
  for (const change of [
    { sourceModule: 'MES' }, { sourceType: 'LABOR' }, { sourceId: '999' },
    { sourceLineId: '999' }, { sourceStatus: 'DRAFT' }, { productCode: '999' },
    { quantity: '2.00000001' }, { materialAmount: '123.45000001' },
    { costCenterCode: 'OTHER' }, { mappingStatus: 'UNMAPPED' },
    { invoicePriceStatus: 'FULL_INVOICE' }, { invoicePriceScope: 'LINE' },
    { invoiceAmount: '99.99' }, { invoiceExpectedAmount: '123.44' },
    { invoicePriceDifference: '0.00000001' }
  ]) {
    const confirmed = confirmedSnapshot(draft)
    Object.assign(confirmed.lines[0], change)
    assert.throws(() => assertPurchaseConfirmed(confirmed, fixture, draft))
  }
  for (const mutate of [
    (value) => { value.lines.pop() },
    (value) => { value.lines[1] = { ...value.lines[0] } },
    (value) => { value.lines.push({ ...value.lines[0] }) }
  ]) {
    const confirmed = confirmedSnapshot(draft)
    mutate(confirmed)
    assert.throws(() => assertPurchaseConfirmed(confirmed, fixture, draft))
  }
})

test('positive, missing, duplicated or unaudited return rows cannot count as coverage', () => {
  for (const mutate of [
    (s) => { s.lines.pop() },
    (s) => { s.lines.push({ ...s.lines[1] }) },
    (s) => { s.lines[1].quantity = 1 },
    (s) => { s.lines[1].materialAmount = 61.725 },
    (s) => { s.lines[1].sourceId = '2110561246932443146' },
    (s) => { s.lines[1].productCode = '2110561246932443147' }
  ]) {
    const value = snapshot()
    mutate(value)
    assert.throws(() => assertPurchaseReturn(value, fixture, returned))
  }
  for (const change of [{ isEffective: 0 }, { status: 10 }, { billStage: '24' }, { isVoided: 1 }]) {
    assert.throws(() => assertPurchaseReturn(snapshot(), fixture, { ...returned, ...change }))
  }
  assert.throws(() => assertPurchaseReceipt(snapshot(), fixture, { ...receipt, status: 10 }))
})

test('database evidence must contain exact nonempty header and all signed source lines', async () => {
  const value = snapshot()
  const db = [
    ['snapshot', value.id, 'DRAFT', 'NULL', 'NULL', value.snapshotHash],
    ...value.lines.map((line) => ['line', line.sourceModule, line.sourceType,
      line.sourceId, line.sourceLineId, line.productCode, String(line.quantity),
      line.materialAmount, 'DRAFT']),
    ['publications', '0']
  ]
  const record = {}
  await readPurchaseDatabase({
    fixture, snapshot: value, caseRecord: record,
    readSql: async () => ({ available: true, rows: db })
  })
  assert.equal(record.database.length, 1)
  for (const invalid of [[], db.slice(1), db.filter((row) => row[2] !== 'PURCHASE_RETURN'),
    db.map((row) => row[0] === 'publications' ? ['publications', '1'] : row)]) {
    await assert.rejects(readPurchaseDatabase({
      fixture, snapshot: value, caseRecord: {},
      readSql: async () => ({ available: true, rows: invalid })
    }))
  }
})

test('confirmed database evidence requires confirmation audit and mapped original payload facts', async () => {
  const draft = snapshot()
  Object.assign(draft.lines[0], {
    invoicePriceStatus: 'PARTIAL_INVOICE', invoicePriceScope: 'PURCHASE_ORDER',
    invoiceAmount: '100.00', invoiceExpectedAmount: '123.45', invoicePriceDifference: 0
  })
  const confirmed = confirmedSnapshot(draft)
  const rows = [
    ['snapshot', confirmed.id, fixture.periodId, 'SOURCE', 'PURCHASE', fixture.versionNo,
      'CONFIRMED', '1001', '2026-10-15 19:00:00', confirmed.snapshotHash],
    ...confirmed.lines.map((line) => [
      'line', line.sourceModule, line.sourceType, line.sourceId, line.sourceLineId,
      line.productCode, String(line.quantity), line.materialAmount, 'CONFIRMED', 'MAPPED',
      JSON.stringify({ ...line, sourceStatus: 'DRAFT' })
    ])
  ]
  const record = {}
  await readConfirmedPurchaseDatabase({
    fixture, snapshot: confirmed, draft, caseRecord: record,
    readSql: async (sql) => {
      assert.match(sql, /tenant_id=1/)
      assert.match(sql, /period_id=163/)
      assert.match(sql, /snapshot_id=910/)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/i)
      return { available: true, rows }
    }
  })
  assert.equal(record.database[0].stage, 'purchase-confirmed')
  assert.deepEqual(record.database[0].rows, rows)
  for (const mutate of [
    (value) => { value.shift() },
    (value) => { value.pop() },
    (value) => { value.push(structuredClone(value[1])) },
    (value) => { value[0][2] = '164' },
    (value) => { value[0][3] = 'OTHER' },
    (value) => { value[0][4] = 'DEFAULT' },
    (value) => { value[0][5] = 'OTHER' },
    (value) => { value[0][6] = 'DRAFT' },
    (value) => { value[0][7] = 'NULL' },
    (value) => { value[0][8] = 'NULL' },
    (value) => { value[0][9] = 'b'.repeat(64) },
    (value) => { value[1][8] = 'DRAFT' },
    (value) => { value[1][9] = 'UNMAPPED' },
    (value) => { value[1][10] = 'not-json' },
    (value) => { value[1][10] = JSON.stringify({ ...confirmed.lines[0], quantity: 3 }) },
    (value) => { value[1][10] = JSON.stringify({ ...confirmed.lines[0], invoiceAmount: 99 }) }
  ]) {
    const invalid = structuredClone(rows)
    mutate(invalid)
    const rejectedRecord = {}
    await assert.rejects(readConfirmedPurchaseDatabase({
      fixture, snapshot: confirmed, draft, caseRecord: rejectedRecord,
      readSql: async () => ({ available: true, rows: invalid })
    }))
    assert.deepEqual(rejectedRecord.database[0].rows, invalid)
  }
  await assert.rejects(readConfirmedPurchaseDatabase({
    fixture, snapshot: confirmed, draft, caseRecord: {},
    readSql: async () => ({ available: false, rows: [] })
  }), /缺少只读数据库证据/)
})

test('catalog 009 and 010 require every original check plus completed runtime fixture', () => {
  for (const [caseId, checks, key] of [
    ['COST-009', COST_PURCHASE_SOURCE_CHECKS, 'costPurchaseReceipt'],
    ['COST-010', COST_PURCHASE_RETURN_CHECKS, 'costPurchaseReturn']
  ]) {
    const record = {
      checks: Object.values(checks).map((name) => ({ name, passed: true })),
      notes: [], fixtures: { [key]: { complete: true } }
    }
    costCatalogEvidence(caseId, record)
    assert.equal(record.passCandidate, true)
    for (const check of record.checks) {
      check.passed = false
      costCatalogEvidence(caseId, record)
      assert.equal(record.passCandidate, false)
      check.passed = true
    }
    record.fixtures[key].complete = false
    costCatalogEvidence(caseId, record)
    assert.equal(record.passCandidate, false)
  }
})
