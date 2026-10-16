import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  SOURCE_SCENARIO, assertBatchOptions, assertReturnInventoryDelta, assertWmsSource,
  buildSourceOrder, buildSourceReturn, inventoryTotals, readReusableSource, regressionPlan, sourceId, sourceMarker
} from '../fixtures/sale-return-source-regression.mjs'

// Synthetic snapshots exercise the evidence validator offline; they are never submitted as live sources.
const expected = {
  marker: sourceMarker('ABCDEF1234'),
  customerId: '9223372036854775701', accountId: '9223372036854775702',
  orderId: '9223372036854775703', orderItemId: '9223372036854775704',
  materialId: '9223372036854775705', unitId: '9223372036854775706',
  warehouseId: '9223372036854775707', wareAreaId: '9223372036854775708',
  wareLocationId: '9223372036854775709',
  batchNo: `${sourceMarker('ABCDEF1234')}-OPENING-BATCH`
}
const dims = ({ materialId, unitId, warehouseId, wareAreaId, wareLocationId, batchNo }) =>
  ({ materialId, unitId, warehouseId, wareAreaId, wareLocationId, batchNo })
function shipment (index, count) {
  const head = { id: `${100 + index}`, stockIoType: '201', srcBillType: 'ErpSaleOut',
    srcBillId: `${200 + index}`, srcNo: `OUT-${index}`, isEffective: 1, isVoided: 0, billStage: '32' }
  return {
    head,
    entries: [{ id: `${300 + index}`, mid: head.id, srcBillType: 'ErpSaleOut', srcBillId: head.srcBillId,
      srcEntryId: `${400 + index}`, stockIoType: '201', stockIoDirection: '2', qty: count,
      inStockTime: '2026-10-15 10:00:00', ...dims(expected) }]
  }
}
const shipments = [shipment(1, 2), shipment(2, 3)]
const options = (quantities = [2, 3]) => shipments.map((source, index) => ({
  ...dims(expected), orderItemId: expected.orderItemId, saleOrderItemId: expected.orderItemId,
  srcStkIoId: source.head.id, srcStkIoEntryId: source.entries[0].id, availableQty: quantities[index]
}))
const inventory = (qty = 3) => ({
  id: '500', ...dims(expected), qty, availableQty: qty, lockQty: 0,
  holdQty: 0, frozenQty: 0, pendingPutawayQty: 0
})
const sourceExpectation = (source, type = '201') => ({
  ...expected, sourceType: source.head.srcBillType, sourceId: source.head.srcBillId,
  sourceNo: source.head.srcNo, sourceEntryId: source.entries[0].srcEntryId,
  type, quantity: source.entries[0].qty
})

test('default CLI is an offline plan with no service/config/browser imports', () => {
  const file = fileURLToPath(new URL('../fixtures/sale-return-source-regression.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, CFOR_TARGET: 'not-a-live-target',
      CFOR_WEB_BASE: 'invalid', CFOR_DB_HOST: 'invalid', CFOR_E2E_WRITE_FIXTURES: 'false' }
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.mode, 'PLAN_ONLY')
  assert.equal(plan.case.id, 'SALE-RETURN-SOURCE-001')
  assert.deepEqual(plan.shipments, [2, 3])
  assert.match(plan.command, /CFOR_E2E_WRITE_FIXTURES=true CFOR_TENANT_ID=1/)
  assert.match(plan.command, /--execute --headed$/)
  assert.match(regressionPlan().boundary, /pending approval is BLOCKED/)
})

test('Long IDs are preserved; lossy numeric IDs and SQL fragments fail before any write', () => {
  assert.equal(sourceId(expected.orderItemId), expected.orderItemId)
  for (const id of [Number(expected.orderItemId), '', null, undefined, '0', '-1', '1 OR 1=1', ' 1', true]) {
    assert.throws(() => sourceId(id))
  }
})

test('dedicated marker permits real 106 batch reuse within the existing 32 character limit', () => {
  assert.ok(expected.batchNo.length <= 32)
  assert.match(sourceMarker(), /^E2E-SR-[A-F0-9]{10}$/)
  assert.throws(() => sourceMarker('wrong'))
})

test('one five-unit order supports two genuine NORMAL shipments without invented balances', () => {
  const body = buildSourceOrder(expected)
  assert.equal(body.saleTypeCode, 'NORMAL')
  assert.equal(body.items[0].count, SOURCE_SCENARIO.shipments.reduce((sum, value) => sum + value, 0))
  assert.equal(body.items[0].totalPrice, 50)
  assert.equal(body.totalPrice, 50)
  assert.equal(body.items[0].productId, expected.materialId)
})

test('RETURN_ONLY keeps real order, batch, dimensions and selected WMS provenance without QC fields', () => {
  const body = buildSourceReturn(expected, options()[0])
  assert.equal(body.returnType, 2)
  assert.equal(body.srcBillId, expected.orderId)
  assert.equal(body.items[0].srcEntryId, expected.orderItemId)
  assert.equal(body.items[0].batchNo, expected.batchNo)
  assert.equal(body.items[0].count, 1)
  assert.equal(body.items[0].totalPrice, 10)
  const bom = body.saleReturnBomList[0]
  assert.equal(bom.saleOrderItemId, expected.orderItemId)
  assert.equal(bom.srcStkIoId, shipments[0].head.id)
  assert.equal(bom.srcStkIoEntryId, shipments[0].entries[0].id)
  assert.equal(bom.qty, 1)
  for (const row of [body, body.items[0], bom]) {
    assert.ok(!('needQc' in row))
    assert.ok(!('isQc' in row))
  }
})

test('return builder rejects a borrowed batch, wrong order item and insufficient source', () => {
  for (const patch of [{ batchNo: 'OTHER' }, { warehouseId: '999' }, { orderItemId: '999' },
    { availableQty: 0 }, { srcStkIoEntryId: Number(expected.orderItemId) }]) {
    assert.throws(() => buildSourceReturn(expected, { ...options()[0], ...patch }))
  }
})

test('formal WMS201 must refer to sale-out ID/item rather than the parent order ID/item', () => {
  const source = structuredClone(shipments[0])
  assert.equal(assertWmsSource(source, sourceExpectation(source)), source)
  source.entries[0].srcEntryId = expected.orderItemId
  assert.throws(() => assertWmsSource(source, sourceExpectation(shipments[0])), /strictly equal/)
})

test('effective alone cannot substitute for actual WMS execution and original inventory dimensions', () => {
  for (const [target, patch] of [
    ['head', { srcBillType: 'SalOrder' }], ['head', { srcBillId: expected.orderId }],
    ['head', { isEffective: 0 }], ['head', { isVoided: 1 }], ['head', { isVoided: null }],
    ['head', { isVoided: undefined }], ['head', { billStage: '24' }],
    ['entry', { inStockTime: null }], ['entry', { qty: -2 }], ['entry', { stockIoDirection: '1' }],
    ['entry', { wareAreaId: '999' }], ['entry', { batchNo: 'OTHER' }]
  ]) {
    const source = structuredClone(shipments[0])
    Object.assign(target === 'head' ? source.head : source.entries[0], patch)
    assert.throws(() => assertWmsSource(source, sourceExpectation(shipments[0])))
  }
})

test('fresh return evidence must be positive SalReturn/302, never abs of a 201 replacement', () => {
  const source = {
    head: { id: '600', stockIoType: '302', srcBillType: 'SalReturn', srcBillId: '601',
      srcNo: 'SR-1', isEffective: 1, isVoided: 0, billStage: '32' },
    entries: [{ id: '602', mid: '600', stockIoType: '302', stockIoDirection: '1',
      srcBillType: 'SalReturn', srcBillId: '601', srcEntryId: '603', qty: 1,
      inStockTime: '2026-10-15 10:00:00', ...dims(expected) }]
  }
  const target = sourceExpectation(source, '302')
  assert.equal(assertWmsSource(source, target), source)
  source.entries[0].qty = -1
  assert.throws(() => assertWmsSource(source, target))
  source.entries[0].qty = 1
  source.head.stockIoType = '201'
  source.entries[0].stockIoType = '201'
  source.entries[0].stockIoDirection = '2'
  assert.throws(() => assertWmsSource(source, target))
})

test('batch options map both real source entries back to the original order item', () => {
  assert.deepEqual(assertBatchOptions(options(), expected, shipments), [['301', 2], ['302', 3]])
  const rows = options()
  rows[0].orderItemId = shipments[0].entries[0].srcEntryId
  assert.throws(() => assertBatchOptions(rows, expected, shipments), /map back to the order item/)
})

test('302 deduction accepts either source allocation but the total must be exactly four', () => {
  assert.deepEqual(assertBatchOptions(options([1, 3]), expected, shipments, 1), [['301', 1], ['302', 3]])
  assert.deepEqual(assertBatchOptions(options([2, 2]), expected, shipments, 1), [['301', 2], ['302', 2]])
})

test('old duplicate deduction across same-batch shipments fails; unchanged five also fails', () => {
  assert.throws(() => assertBatchOptions(options([1, 2]), expected, shipments, 1), /deducted once/)
  assert.throws(() => assertBatchOptions(options(), expected, shipments, 1), /deducted once/)
})

test('foreign or duplicated WMS rows and dropped source rows cannot yield a passing aggregate', () => {
  const duplicate = options([2, 2])
  duplicate[1].srcStkIoEntryId = duplicate[0].srcStkIoEntryId
  assert.throws(() => assertBatchOptions(duplicate, expected, shipments, 1), /Duplicate/)
  for (const patch of [{ srcStkIoEntryId: '999' }, { srcStkIoId: '999' }, { batchNo: 'OTHER' }]) {
    const rows = options([1, 3])
    Object.assign(rows[0], patch)
    assert.throws(() => assertBatchOptions(rows, expected, shipments, 1))
  }
  assert.throws(() => assertBatchOptions([options()[0]], expected, shipments, 1))
})

test('physical inventory reconciles all WMS components without a parallel ERP balance', () => {
  const totals = inventoryTotals([inventory()], expected)
  assert.deepEqual(totals, { qty: 3, availableQty: 3, lockQty: 0, holdQty: 0, frozenQty: 0, pendingPutawayQty: 0 })
  assert.deepEqual(inventoryTotals([], expected), { ...totals, qty: 0, availableQty: 0 })
  assertReturnInventoryDelta(totals, inventoryTotals([inventory(4)], expected))
})

test('missing component evidence, wrong dimensions, duplicate rows and unbalanced inventory fail', () => {
  for (const patch of [{ qty: 4 }, { holdQty: undefined }, { availableQty: null }, { lockQty: '' },
    { frozenQty: -1 }, { wareLocationId: '999' }, { unitId: '999' }]) {
    assert.throws(() => inventoryTotals([{ ...inventory(), ...patch }], expected))
  }
  assert.throws(() => inventoryTotals([inventory(), inventory()], expected), /Duplicate/)
})

test('return delta cannot pass through duplicate receipt, pending QC or movement of other components', () => {
  const before = inventoryTotals([inventory()], expected)
  for (const after of [{ ...before, qty: 5, availableQty: 5 },
    { ...before, qty: 4, holdQty: 1 }, { ...before, qty: 4, availableQty: 4, lockQty: 1 }]) {
    assert.throws(() => assertReturnInventoryDelta(before, after))
  }
})

test('only this case local pre-return formal sources can be reused after a browser locator failure', () => {
  const report = {
    runId: 'prior-owned-run',
    environment: { target: 'local', webBase: 'http://127.0.0.1:9151',
      apiBase: 'http://127.0.0.1:48083/admin-api', tenantId: '1', dbName: 'cfor_admin_standard' },
    cases: [{ id: 'SALE-RETURN-SOURCE-001', marker: expected.marker,
      checks: [{ name: 'Both formal 201 shipments appear as order-item return candidates', passed: true }],
      evidence: [{ stage: 'before-return-options', options: options() }],
      fixtures: [
        { kind: 'opening', id: '1', quantity: 8 },
        { kind: 'warehouse', id: '2' }, { kind: 'area', id: '3' }, { kind: 'location', id: '4' },
        { kind: 'material', id: '5' }, { kind: 'partner', id: '6' },
        { kind: 'sale-order', id: '7', body: { accountId: expected.accountId } },
        { kind: 'sale-out', id: '8' }, { kind: 'sale-out', id: '9' }
      ] }]
  }
  assert.equal(readReusableSource(report).marker, expected.marker)
  assert.deepEqual(readReusableSource(report).outIds, ['8', '9'])
  const differentTenant = structuredClone(report)
  differentTenant.environment.tenantId = '2'
  assert.throws(() => readReusableSource(differentTenant))
  const alreadyReturned = structuredClone(report)
  alreadyReturned.cases[0].fixtures.push({ kind: 'sale-return', id: '10' })
  assert.throws(() => readReusableSource(alreadyReturned), /already-created return/)
  assert.throws(() => readReusableSource(alreadyReturned, { readbackOnly: true }))
  alreadyReturned.cases[0].checks.push({
    name: 'Same-batch shipments deduct return only once: 5 -> 4', passed: true
  })
  assert.equal(readReusableSource(alreadyReturned, { readbackOnly: true }).completedReturn.id, '10')
  assert.throws(() => readReusableSource(report, { readbackOnly: true }), /previously-created return/)
  const incomplete = structuredClone(report)
  incomplete.cases[0].checks[0].passed = false
  assert.throws(() => readReusableSource(incomplete))
})
