import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __internal,
  buildPurchaseReturnPayload,
  buildSaleReturnPayload,
  WMS_QC_SOURCE_CONTRACTS
} from '../fixtures/wms-qc-closure.mjs'

const ok = (data) => ({ code: 0, data })

const ids = {
  supplierId: '9223372036854775801',
  customerId: '9223372036854775802',
  purchaseOrderId: '9223372036854775803',
  saleOrderId: '9223372036854775804',
  orderItemId: '9223372036854775805',
  materialId: '9223372036854775806',
  unitId: '9223372036854775807',
  warehouseId: '9223372036854775808',
  areaId: '9223372036854775809',
  locationId: '9223372036854775810',
  accountId: '9223372036854775811'
}

test('purchase and sale return default batch numbers fit the WMS BOM boundary and retain the full marker', () => {
  const marker = `E2E-Q002-${'M'.repeat(80)}`
  const purchase = buildPurchaseReturnPayload({
    marker,
    ...ids
  })
  const sale = buildSaleReturnPayload({
    marker,
    ...ids
  })

  for (const payload of [purchase, sale]) {
    assert.ok(payload.items[0].batchNo.length > 0)
    assert.ok(payload.items[0].batchNo.length <= 32)
    assert.equal(payload.remark, marker)
    assert.equal(payload.items[0].remark, marker)
  }
  assert.notEqual(purchase.items[0].batchNo, sale.items[0].batchNo)
})

test('explicit return batch numbers over the formal WMS BOM boundary are rejected', () => {
  const marker = 'E2E-Q002-BOUNDARY'
  assert.throws(() => buildPurchaseReturnPayload({
    marker,
    ...ids,
    batchNo: 'P'.repeat(33)
  }), /1-32/)
  assert.throws(() => buildSaleReturnPayload({
    marker,
    ...ids,
    batchNo: 'S'.repeat(33)
  }), /1-32/)
})

test('return batches preserve explicit 31/32-character values and deterministic defaults without prefix collisions', () => {
  for (const build of [buildPurchaseReturnPayload, buildSaleReturnPayload]) {
    for (const length of [31, 32]) {
      const batchNo = 'B'.repeat(length)
      const payload = build({ ...ids, marker: 'E2E-BOUNDARY', batchNo })
      assert.equal(payload.items[0].batchNo, batchNo)
    }
    const marker = `E2E-Q002-${'A'.repeat(100)}`
    const first = build({ ...ids, marker })
    assert.equal(first.items[0].batchNo,
      build({ ...ids, marker }).items[0].batchNo)
    assert.notEqual(first.items[0].batchNo,
      build({ ...ids, marker: `${marker}B` }).items[0].batchNo)
    assert.match(first.items[0].batchNo, /^E2E-(PR|SR)-[a-f0-9]{20}$/)
    for (const batchNo of ['', '   ', 123, {}, 'B'.repeat(33)]) {
      assert.throws(() => build({ ...ids, marker, batchNo }), /1-32/)
    }
  }
})

test('QC001 source contract requires the same retained inactive draft, not absent or ambiguous records', () => {
  const rows = [{
    id: 'inspection-1',
    billStage: '12',
    isEffective: 0,
    isVoided: 0
  }]
  assert.equal(__internal.qualityVoidDraftMatchesSourceContract(rows, 'inspection-1'), true)
  assert.equal(__internal.qualityVoidDraftMatchesSourceContract(rows, 'other'), false)
  for (const invalid of [
    [], [...rows, { ...rows[0] }],
    [{ ...rows[0], isEffective: 1 }], [{ ...rows[0], isEffective: null }],
    [{ ...rows[0], billStage: '14' }], [{ ...rows[0], isVoided: 1 }]
  ]) {
    assert.equal(__internal.qualityVoidDraftMatchesSourceContract(invalid, 'inspection-1'), false)
  }
  assert.match(WMS_QC_SOURCE_CONTRACTS.qualityVoidRetainsDraft.reason, /未删除质检主单/)
  assert.match(WMS_QC_SOURCE_CONTRACTS.qualityVoidRetainsDraft.sources.join(' '), /MesQualityInspectionServiceImpl/)
})

const stock = (qty = 1) => ({
  id: '209', materialId: '204', warehouseId: '201', qty,
  availableQty: qty, holdQty: 0, lockQty: 0, frozenQty: 0, pendingPutawayQty: 0
})

function executionHarness () {
  const calls = []
  const fixture = {
    token: 'OWNED-Q002', marker: 'E2E-Q002-EXEC',
    warehouse: { id: '201' }, area: { id: '202' }, location: { id: '203' },
    material: { id: '204', unitId: '205' }
  }
  const saleOut = { id: '301', payload: { items: [{ count: 1 }] } }
  const caseRecord = {
    checks: [], evidence: [], notes: [],
    fixtures: [
      ...['warehouse', 'area', 'location', 'material'].map((kind) => ({
        kind, id: fixture[kind].id, token: fixture.token
      })),
      { kind: 'saleOut', id: saleOut.id, marker: fixture.marker }
    ]
  }
  const baseline = [stock()]
  const state = {
    erp: { id: '301', status: 20, remark: fixture.marker,
      items: [{ id: '302', productId: '204', warehouseId: '201', count: 1 }] },
    main: {
      id: '303', stockIoType: '201', srcBillType: 'ErpSaleOut', srcBillId: '301',
      billStage: '14', isEffective: 0, isVoided: 0, actions: { check: true }
    },
    entries: [{
      id: '304', mid: '303', materialId: '204', warehouseId: '201',
      srcBillType: 'ErpSaleOut', srcBillId: '301', srcEntryId: '302',
      stockIoDirection: '2', qty: 1, inStockTime: null
    }],
    inventory: [stock()]
  }
  const complete = () => {
    state.main.billStage = '34'
    state.main.isEffective = 1
    state.main.actions = { void: true }
    state.entries[0].inStockTime = '2026-10-12 13:35:41'
    state.inventory = []
  }
  const api = {
    async getBusiness(path) {
      calls.push(['GET', path])
      const query = new URL(path, 'http://unit')
      if (query.pathname === '/erp/sale-out/get') return ok(state.erp)
      if (query.pathname === '/mes/stkIo/queryById') return ok(state.main)
      if (query.pathname === '/mes/stkIo/queryEntryByMainId') return ok(state.entries)
      if (query.pathname === '/mes/stkInventory/list') {
        return ok({ records: state.inventory, total: state.inventory.length })
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async putBusiness(path, body) {
      calls.push(['PUT', path, structuredClone(body)])
      if (path === '/mes/stkIo/check') {
        assert.deepEqual(body, {
          id: '303',
          approvalResultType: '1',
          approvalRemark: 'E2E WMS-QC formal WMS201 audit'
        })
        if (state.checkFailure) return { code: 500, msg: '系统异常' }
        state.main.billStage = '24'
        state.main.isEffective = 1
        state.main.actions = { execute: true }
        state.onCheck?.()
        return ok(true)
      }
      assert.equal(path, '/mes/stkIo/execute')
      assert.deepEqual(body, { id: '303' })
      if (state.executeFailure) return { code: 500, msg: '系统异常' }
      complete()
      state.onExecute?.()
      return ok(true)
    }
  }
  const run = () => __internal.executeWmsStockBillWhenNeeded(
    api, caseRecord, fixture, saleOut, '303', baseline)
  return { calls, caseRecord, fixture, saleOut, baseline, state, complete, run }
}

test('WMS201 uses formal check then execute and proves actual owned inventory deduction', async () => {
  const h = executionHarness()
  const result = await h.run()
  assert.equal(result.checkCalled, true)
  assert.equal(result.executeCalled, true)
  assert.deepEqual(h.calls.filter(([method]) => method === 'PUT').map(([, path]) => path), [
    '/mes/stkIo/check',
    '/mes/stkIo/execute'
  ])
  assert.equal(h.caseRecord.checks.at(-1).passed, true)
  assert.equal(h.caseRecord.outboundExecutionEvidence[0].baseline[0].qty, 1)
  assert.deepEqual(h.caseRecord.outboundExecutionEvidence[0].after.inventory, [])
  h.baseline[0].qty = 99
  assert.equal(h.caseRecord.outboundExecutionEvidence[0].baseline[0].qty, 1)
  assert.match(WMS_QC_SOURCE_CONTRACTS.wmsManualExecute.reason, /正式 check\/execute/)
})

test('WMS201 without a formal execute action stops before any write', async () => {
  const h = executionHarness()
  h.state.main.billStage = '24'
  h.state.main.actions = {}
  await assert.rejects(h.run(), /没有正式 execute 动作/)
  assert.equal(h.calls.some(([method]) => method === 'PUT'), false)
  assert.equal(h.caseRecord.contractGaps[0].key, 'wms201-execute-action')
})

test('effective but unexecuted WMS201 still executes while completed sources never execute twice', async () => {
  const pending = executionHarness()
  pending.state.main.billStage = '24'
  pending.state.main.isEffective = 1
  pending.state.main.actions = { execute: true }
  const executed = await pending.run()
  assert.equal(executed.checkCalled, false)
  assert.equal(executed.executeCalled, true)
  const done = executionHarness()
  done.complete()
  const result = await done.run()
  assert.equal(result.checkCalled, false)
  assert.equal(result.executeCalled, false)
  assert.equal(done.calls.some(([method]) => method === 'PUT'), false)
})

test('a check that already executes inventory is not followed by another execute', async () => {
  const h = executionHarness()
  h.state.onCheck = () => h.complete()
  const result = await h.run()
  assert.equal(result.checkCalled, true)
  assert.equal(result.executeCalled, false)
  assert.equal(h.calls.filter(([method]) => method === 'PUT').length, 1)
})

test('WMS201 guards ownership and exact source dimensions before any execute/check', async () => {
  for (const change of [
    (h) => { h.caseRecord.fixtures[0].token = 'SHARED' },
    (h) => { h.caseRecord.fixtures.at(-1).marker = 'OTHER' },
    (h) => { h.state.erp.remark = 'OTHER' },
    (h) => { h.state.erp.status = 10 },
    (h) => { h.state.main.srcBillId = '999' },
    (h) => { h.state.main.isVoided = 1 },
    (h) => { h.state.entries[0].srcEntryId = '999' },
    (h) => { h.state.entries[0].warehouseId = '999' },
    (h) => { h.state.entries[0].qty = 2 },
    (h) => { h.baseline[0].warehouseId = '999' },
    (h) => { h.baseline[0].qty = 9 }
  ]) {
    const h = executionHarness()
    change(h)
    await assert.rejects(h.run(), /BLOCKED:/)
    assert.equal(h.calls.some(([method]) => method === 'PUT'), false)
  }
})

test('failed check/execute, false success or missing stock deduction can never pass WMS201', async () => {
  for (const change of [
    (h) => { h.state.checkFailure = true },
    (h) => { h.state.executeFailure = true },
    (h) => { h.state.onExecute = () => { h.state.main.isEffective = 0 } },
    (h) => { h.state.onExecute = () => { h.state.entries[0].inStockTime = null } },
    (h) => { h.state.onExecute = () => { h.state.inventory = [stock()] } },
    (h) => { h.state.onExecute = () => { h.state.entries[0].srcEntryId = '999' } }
  ]) {
    const h = executionHarness()
    change(h)
    await assert.rejects(h.run(), /业务失败|未生效|未产生|不匹配/)
    assert.equal(h.caseRecord.checks.some((check) =>
      check.name === '正式销售出库后专属可用库存按行扣减' && check.passed), false)
    if (h.state.checkFailure) {
      assert.equal(h.calls.some(([, path]) => path === '/mes/stkIo/execute'), false)
    }
  }
})
