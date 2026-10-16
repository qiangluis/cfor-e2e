import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPurchaseFreightPage } from '../fixtures/cost-purchase-freight-page.mjs'

function example () {
  const fixture = {
    periodId: '160', modelId: '248', month: '2211-06', versionNo: 'OWNED',
    purchaseInId: '9223372036854775001'
  }
  const positive = { id: '9223372036854775002', entryId: '9223372036854775003', amount: '12.34' }
  const zero = { id: '9223372036854775004' }
  // 采购入库来源已切到 WMS 事实源：页面来源主从 ID 是 mes_stk_io 的主从 ID。
  const wmsSource = {
    wms: { id: '9223372036854775006' },
    entry: { id: '9223372036854775007' }
  }
  const lines = [{
    sourceType: 'PURCHASE_RECEIPT', sourceId: wmsSource.wms.id,
    sourceLineId: wmsSource.entry.id, sourceNo: 'OWNED-RECEIPT',
    productCode: 'OWNED-P01', quantity: 2, materialAmount: 100, expenseAmount: 0
  }, {
    sourceType: 'PURCHASE_FREIGHT', sourceId: positive.id, sourceLineId: positive.entryId,
    sourceNo: 'OWNED-FREIGHT', productCode: 'OWNED-P01', quantity: 0,
    materialAmount: 0, expenseAmount: 12.34
  }]
  const snapshot = {
    id: '9001', periodId: fixture.periodId, snapshotKey: 'PURCHASE',
    versionNo: fixture.versionNo, status: 'DRAFT', lines
  }
  const observation = {
    loaded: 'true', error: '', periodId: fixture.periodId, month: fixture.month,
    modelId: fixture.modelId, versionNo: fixture.versionNo, snapshotId: snapshot.id,
    status: 'DRAFT', expenseTotal: '12.34', workspaceWrites: [],
    rows: lines.map((line) => ({
      ...line, periodId: fixture.periodId, sourceText: line.sourceNo,
      quantity: String(line.quantity), materialAmount: String(line.materialAmount),
      expenseAmount: String(line.expenseAmount),
      materialText: line.materialAmount.toFixed(2), expenseText: line.expenseAmount.toFixed(2)
    }))
  }
  return { fixture, positive, zero, snapshot, observation, wmsSource }
}

test('COST-011 page requires exact Snowflake IDs and visible real fee/receipt cells', () => {
  const facts = example()
  assert.equal(assertPurchaseFreightPage(facts), facts.observation)
})

for (const [name, mutate] of [
  ['zero rows', (x) => { x.observation.rows = [] }],
  ['zero rows and zero source snapshot', (x) => { x.observation.rows = []; x.snapshot.lines = [] }],
  ['another period', (x) => { x.observation.periodId = '159' }],
  ['another model', (x) => { x.observation.modelId = '247' }],
  ['another month', (x) => { x.observation.month = '2211-05' }],
  ['wrong snapshot', (x) => { x.observation.snapshotId = '9002' }],
  ['wrong version', (x) => { x.observation.versionNo = 'OTHER' }],
  ['error after refresh', (x) => { x.observation.error = 'failed' }],
  ['missing precise freight ID', (x) => { x.observation.rows[1].sourceId = '9223372036854775000' }],
  ['wrong freight line ID', (x) => { x.observation.rows[1].sourceLineId = '42' }],
  ['empty freight visible cell', (x) => { x.observation.rows[1].expenseText = '' }],
  ['zero freight visible cell', (x) => { x.observation.rows[1].expenseText = '0.00' }],
  ['wrong freight amount attribute', (x) => { x.observation.rows[1].expenseAmount = '10.00' }],
  ['wrong receipt amount cell', (x) => { x.observation.rows[0].materialText = '0.00' }],
  ['duplicate row', (x) => { x.observation.rows[1] = { ...x.observation.rows[0] } }],
  ['wrong total', (x) => { x.observation.expenseTotal = '0.00' }],
  ['fake successful workspace save', (x) => {
    x.observation.workspaceWrites.push({ method: 'PUT', path: '/cost/workspace-states/PURCHASE' })
  }]
]) {
  test(`COST-011 page rejects ${name}`, () => {
    const facts = example()
    mutate(facts)
    assert.throws(() => assertPurchaseFreightPage(facts))
  })
}
