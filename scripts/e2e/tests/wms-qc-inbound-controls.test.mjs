import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  __internal,
  createWmsQcNonInspectionControl,
  mapWmsQcCatalogAssertions,
  verifyWmsQcInboundReversal
} from '../fixtures/wms-qc-closure.mjs'

const ok = (data) => ({ code: 0, data })
const record = () => ({ checks: [], notes: [], evidence: [], fixtures: [] })
const ownedFixture = () => ({
  token: 'OWNED-Q001', marker: 'E2E-Q001-TEST',
  warehouse: { id: '201' }, area: { id: '202' }, location: { id: '203' },
  material: { id: '204', unitId: '205', code: 'MT-Q001' }
})
const register = (caseRecord, fixture) => {
  for (const [kind, value] of [
    ['warehouse', fixture.warehouse], ['area', fixture.area],
    ['location', fixture.location], ['material', fixture.material]
  ]) {
    caseRecord.fixtures.push({ kind, id: value.id, token: fixture.token, code: value.code })
  }
}
const inventory = (materialId, availableQty, holdQty = 0) => ({
  id: materialId === '204' ? '210' : '211',
  warehouseId: '201', materialId, qty: availableQty + holdQty,
  availableQty, holdQty, lockQty: 0, frozenQty: 0, pendingPutawayQty: 0
})

function controlHarness ({ effective = true } = {}) {
  const calls = []
  const fixture = ownedFixture()
  const caseRecord = record()
  register(caseRecord, fixture)
  const state = {
    material: { id: '206', unitId: '205', code: 'MT-NONQC' },
    order: {
      id: '207', status: 20, remark: `${fixture.marker}-NONQC`, billNo: 'PO-NONQC',
      items: [{ id: '208', productId: '206', count: 1, inCount: 0 }]
    },
    rules: [], inspections: [], balances: [],
    positive: [inventory('204', 1)],
    detail: null, entries: []
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      const query = new URL(path, 'http://unit')
      if (query.pathname === '/mes/quality/qualityMaterial/list/dictText') {
        assert.equal(query.searchParams.get('materialId'), '206')
        return ok({ records: state.rules, total: state.ruleTotal ?? state.rules.length })
      }
      if (query.pathname === '/mes/stkInventory/list') {
        assert.equal(query.searchParams.get('warehouseId'), '201')
        const rows = query.searchParams.get('materialId') === '204' ? state.positive : state.balances
        return ok({ records: rows, total: rows.length })
      }
      if (query.pathname === '/erp/purchase-order/get') return ok(state.order)
      if (query.pathname === '/mes/stkIo/queryById') return ok(state.detail)
      if (query.pathname === '/mes/stkIo/queryEntryByMainId') return ok(state.entries)
      if (query.pathname === '/mes/quality/qualityInspection/list/dictText') {
        assert.equal(query.searchParams.get('srcBillId'), '209')
        return ok({ records: state.inspections, total: state.inspectionTotal ?? state.inspections.length })
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path, payload) {
      calls.push(['POST', path, structuredClone(payload)])
      if (path === '/erp/purchase-order/create') return ok('207')
      assert.equal(path, '/mes/stkIo/add/submit')
      state.detail = {
        id: '209', billNo: payload.billNo, remark: payload.remark,
        stockIoType: '101', srcBillType: 'PurOrder', srcBillId: '207',
        isEffective: effective ? 1 : 0, billStage: effective ? '34' : '14',
        actions: effective ? { void: true } : { check: true }
      }
      state.entries = [{ ...payload.stkIoEntryList[0], id: '212', mid: '209' }]
      state.balances = effective ? [inventory('206', 1)] : []
      state.onSubmit?.()
      return ok('209')
    },
    async putBusiness (path) {
      calls.push(['PUT', path])
      assert.equal(path, '/mes/stkIo/check')
      state.onAudit?.()
      if (state.auditFailure) return { code: 500, message: '系统异常' }
      state.detail.isEffective = 1
      state.detail.billStage = '34'
      state.detail.actions = { void: true }
      state.balances = [inventory('206', 1)]
      return ok(true)
    }
  }
  const dependencies = {
    async createMaterialFixture (_api, actualRecord, token, unitId) {
      calls.push(['MATERIAL', token, unitId])
      assert.equal(actualRecord, caseRecord)
      actualRecord.fixtures.push({ kind: 'material', id: '206', token, code: state.material.code })
      return state.material
    }
  }
  return { api, state, fixture, caseRecord, calls, dependencies, supplier: { id: '213' } }
}

test('QC001 non-quality control uses a new owned material and a real dedicated purchase-order source', async () => {
  const h = controlHarness()
  const result = await createWmsQcNonInspectionControl(
    h.api, h.caseRecord, h.fixture, h.supplier, h.dependencies)
  const create = h.calls.find(([method, path]) => method === 'POST' && path === '/mes/stkIo/add/submit')
  assert.equal(create[2].srcBillType, 'PurOrder')
  assert.equal(create[2].srcBillId, '207')
  assert.equal(create[2].stkIoEntryList[0].srcEntryId, '208')
  assert.equal(create[2].stkIoEntryList[0].isQc, 0)
  assert.equal(create[2].stkIoEntryList[0].materialId, '206')
  assert.equal(create[2].stkIoEntryList[0].wareAreaId, '202')
  assert.equal(result.wms.isEffective, 1)
  assert.equal(result.inventory[0].availableQty, 1)
  assert.equal(h.calls.filter(([method]) => method === 'PUT').length, 0)
  assert.equal(h.caseRecord.checks.every((check) => check.passed), true)
  assert.deepEqual(h.caseRecord.inventorySnapshots.map((row) => row.stage), [
    'NON_QC_BEFORE', 'NON_QC_AVAILABLE'
  ])
  h.state.balances[0].availableQty = 99
  assert.equal(h.caseRecord.inventorySnapshots.at(-1).inventory[0].availableQty, 1)
  assert.equal(h.caseRecord.evidence.some((item) => item.includes('未冒充 ERP needQc=false')), true)
})

test('QC001 pending non-quality source audits only an allowed action and proves executed inventory', async () => {
  const h = controlHarness({ effective: false })
  await createWmsQcNonInspectionControl(h.api, h.caseRecord, h.fixture, h.supplier, h.dependencies)
  assert.equal(h.calls.filter(([method]) => method === 'PUT').length, 1)
  assert.equal(h.caseRecord.checks.every((check) => check.passed), true)
})

test('QC001 non-quality control reuses formal BPM approval when its owned source is already auditing', async () => {
  const h = controlHarness({ effective: false })
  h.state.onSubmit = () => {
    h.state.detail.billStage = '22'
    h.state.detail.processInstanceId = 'unit-owned-process'
    h.state.detail.actions = { ebpm: true }
  }
  h.dependencies.approveWmsProcess = async (context) => {
    assert.equal(context.processId, 'unit-owned-process')
    assert.equal(context.taskDefinitionKey, 'FirstApprove_purchase-in')
    h.calls.push(['BPM', context.processId])
    h.state.detail.isEffective = 1
    h.state.detail.billStage = '34'
    h.state.balances = [inventory('206', 1)]
  }
  await createWmsQcNonInspectionControl(h.api, h.caseRecord, h.fixture, h.supplier, h.dependencies)
  assert.equal(h.calls.some(([method]) => method === 'BPM'), true)
  assert.equal(h.calls.some(([method]) => method === 'PUT'), false)
})

test('shared dimensions, reused materials, existing quality rules and incomplete reads stop before stock writes', async () => {
  for (const change of [
    (h) => { h.caseRecord.fixtures[0].token = 'SHARED' },
    (h) => { h.state.material.id = '204' },
    (h) => { h.state.material.unitId = '999' },
    (h) => { h.state.rules = [{ id: '220', materialId: '206', type: '101' }] },
    (h) => { h.state.ruleTotal = 1 },
    (h) => { h.state.balances = [inventory('206', 1)] },
    (h) => { h.state.order.items[0].productId = '999' }
  ]) {
    const h = controlHarness()
    change(h)
    await assert.rejects(createWmsQcNonInspectionControl(
      h.api, h.caseRecord, h.fixture, h.supplier, h.dependencies))
    assert.equal(h.calls.some(([method, path]) => method === 'POST' && path === '/mes/stkIo/add/submit'), false)
    assert.equal(h.caseRecord.checks.some((check) => check.name === '非质检存货不生成采购入库检'), false)
  }
})

test('an unexpected inspection after non-quality submit is a real failure and is never audited away', async () => {
  const h = controlHarness({ effective: false })
  h.state.onSubmit = () => {
    h.state.inspections = [{ id: '220', srcBillType: 'MesStkIo', srcBillId: '209', type: '101' }]
  }
  await assert.rejects(createWmsQcNonInspectionControl(
    h.api, h.caseRecord, h.fixture, h.supplier, h.dependencies), /意外生成采购入库检/)
  assert.equal(h.calls.some(([method]) => method === 'PUT'), false)
  assert.equal(h.caseRecord.checks.some((check) => check.name === '非质检存货不生成采购入库检'), false)
})

test('source mismatches, ambiguous pages or disabled approval never become a passed non-quality control', async () => {
  for (const change of [
    (h) => { h.state.detail.srcBillId = '999' },
    (h) => { h.state.entries[0].isQc = 1 },
    (h) => { h.state.entries[0].wareLocationId = '999' },
    (h) => { h.state.inspectionTotal = 1 },
    (h) => { h.state.detail.actions = {} },
    (h) => { h.state.auditFailure = true }
  ]) {
    const h = controlHarness({ effective: false })
    h.state.onSubmit = () => change(h)
    await assert.rejects(createWmsQcNonInspectionControl(
      h.api, h.caseRecord, h.fixture, h.supplier, h.dependencies))
    assert.equal(h.caseRecord.checks.some((check) =>
      check.name === '非质检存货不生成采购入库检' && check.passed), false)
  }
})

test('an effective non-quality document with held stock, new rules or a mutated positive sample cannot pass', async () => {
  for (const change of [
    (h) => { h.state.balances = [inventory('206', 0, 1)] },
    (h) => { h.state.rules = [{ id: '220', materialId: '206', type: '101' }] },
    (h) => { h.state.positive[0] = inventory('204', 0, 1) }
  ]) {
    const h = controlHarness()
    h.state.onSubmit = () => change(h)
    await assert.rejects(createWmsQcNonInspectionControl(
      h.api, h.caseRecord, h.fixture, h.supplier, h.dependencies),
    /未直接进入 available|改变了质检正样本库存/)
    assert.equal(h.caseRecord.checks.some((check) => check.passed === false), true)
  }
})

function reversalHarness () {
  const fixture = ownedFixture()
  const caseRecord = record()
  register(caseRecord, fixture)
  caseRecord.fixtures.push({ kind: 'purchaseInbound', id: '301', marker: fixture.marker })
  const inbound = { id: '301', wms: { id: '302' }, entry: { id: '303', qty: 1 },
    payload: { orderId: '304' } }
  const artifacts = { plan: { planId: '305' } }
  const prepared = { inbound, artifacts, inspection: { inspectionId: '306' } }
  const calls = []
  const state = {
    erp: {
      id: '301', status: 20, orderId: '304', paymentPrice: 0, remark: fixture.marker,
      items: [{ id: '314', productId: '204', warehouseId: '201', count: 1 }]
    },
    main: {
      id: '302', stockIoType: '101', srcBillType: 'ErpPurchaseIn', srcBillId: '301',
      billStage: '34', isEffective: 1, isVoided: 0, qcQty: 1, actions: { void: true }
    },
    entries: [{
      id: '303', mid: '302', materialId: '204', warehouseId: '201', qty: 1,
      isQc: 1, qcQty: 1, stockIoDirection: '1'
    }],
    inspection: {
      id: '306', billNo: 'QC-REVERSE', type: '101', srcBillType: 'MesStkIo',
      srcBillId: '302', inspectionPlan: '305', isEffective: 1, billStage: '34',
      isVoided: 0, actions: { void: true }
    },
    inspectionEntries: [{
      id: '307', srcEntryId: '303', srcBillId: '302', srcBillType: 'MesStkIo', materialId: '204'
    }],
    items: [{ id: '308', mid: '306', entryId: '307', itemId: '309' }],
    balances: [inventory('204', 1)], removed: false
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      const query = new URL(path, 'http://unit')
      if (query.pathname === '/erp/purchase-in/get') return ok(state.erp)
      if (query.pathname === '/mes/stkIo/queryById') return ok(state.main)
      if (query.pathname === '/mes/stkIo/queryEntryByMainId') return ok(state.entries)
      if (query.pathname === '/mes/stkInventory/list') return ok({
        records: state.balances, total: state.balances.length
      })
      if (query.pathname === '/mes/quality/qualityInspection/list/dictText') return ok({
        records: state.removed ? [] : [state.inspection], total: state.removed ? 0 : 1
      })
      if (query.pathname.includes('queryById/dictText')) return ok(state.inspection)
      if (query.pathname.includes('queryMesQualityInspectionEntryByMainId')) return ok(state.inspectionEntries)
      if (query.pathname.includes('queryMesQualityInspectionItemByMainId')) return ok(state.items)
      throw new Error(`unexpected GET ${path}`)
    },
    async putBusiness (path, payload) {
      calls.push(['PUT', path, payload])
      if (path === '/mes/quality/qualityInspection/void') {
        assert.deepEqual(payload, { id: '306' })
        if (state.holdFailure) return { code: 500, message: '库存不足，不能弃审' }
        state.inspection.isEffective = 0
        state.inspection.billStage = '12'
        state.balances[0].availableQty = 0
        state.balances[0].holdQty = 1
        state.main.qcQty = 0
        state.entries[0].qcQty = 0
        state.onHold?.()
        return ok(true)
      }
      assert.equal(path, '/erp/purchase-in/update-status?id=301&status=0')
      assert.equal(state.balances[0].holdQty, 1, 'must prove available -> hold before canceling the receipt')
      if (state.cancelFailure) return { code: 500, message: '采购入库弃审失败' }
      state.erp.status = 0
      state.main.isEffective = 0
      state.main.billStage = '12'
      state.balances[0].qty = 0
      state.balances[0].holdQty = 0
      state.onCancel?.()
      return ok(true)
    }
  }
  return { api, state, calls, fixture, caseRecord, prepared }
}

test('QC001 reversal uses two formal APIs and preserves exact available -> hold -> zero snapshots', async () => {
  const h = reversalHarness()
  const result = await verifyWmsQcInboundReversal(h.api, h.caseRecord, h.fixture, h.prepared, [])
  assert.equal(result.reversed, true)
  assert.deepEqual(h.calls.filter(([method]) => method === 'PUT').map(([, path]) => path), [
    '/mes/quality/qualityInspection/void',
    '/erp/purchase-in/update-status?id=301&status=0'
  ])
  assert.deepEqual(h.caseRecord.inventorySnapshots.map((row) => [
    row.stage, row.inventory[0].qty, row.inventory[0].availableQty, row.inventory[0].holdQty
  ]), [
    ['REVERSE_AVAILABLE', 1, 1, 0], ['REVERSE_HOLD', 1, 0, 1], ['REVERSE_ZERO', 0, 0, 0]
  ])
  assert.equal(h.caseRecord.checks.every((check) => check.passed), true)
  assert.equal(h.caseRecord.reversalEvidence[0].erpBefore.status, 20)
  assert.equal(h.caseRecord.reversalEvidence[0].erpAfter.status, 0)
  assert.equal(h.caseRecord.reversalEvidence[0].inspectionsAfter.length, 1)
  assert.equal(h.caseRecord.checks.find((check) =>
    check.name === '质检弃审保留可重新录入的草稿符合正式源码契约').passed, true)
  h.state.balances[0].qty = 999
  assert.equal(h.caseRecord.reversalEvidence[0].after.inventory[0].qty, 0)
})

test('QC001 reversal requires owned, fully released and unoccupied source facts before any write', async () => {
  for (const change of [
    (h) => { h.caseRecord.fixtures[0].token = 'SHARED' },
    (h) => { h.caseRecord.fixtures.at(-1).marker = 'FOREIGN' },
    (h) => { h.state.erp.orderId = '999' },
    (h) => { h.state.erp.items[0].warehouseId = '999' },
    (h) => { h.state.erp.paymentPrice = 1 },
    (h) => { h.state.main.srcBillId = '999' },
    (h) => { h.state.entries[0].isQc = 0 },
    (h) => { h.state.inspection.actions.void = false },
    (h) => { h.state.balances[0].availableQty = 0; h.state.balances[0].lockQty = 1 }
  ]) {
    const h = reversalHarness()
    change(h)
    await assert.rejects(verifyWmsQcInboundReversal(h.api, h.caseRecord, h.fixture, h.prepared, []), /BLOCKED:/)
    assert.equal(h.calls.some(([method]) => method === 'PUT'), false)
  }
})

test('QC001 failed or incomplete quality reversal stops before the ERP cancellation', async () => {
  for (const change of [
    (h) => { h.state.holdFailure = true },
    (h) => { h.state.inspection.isEffective = 1 },
    (h) => { h.state.inspection.billStage = '10' },
    (h) => { h.state.balances[0].availableQty = 1; h.state.balances[0].holdQty = 0 },
    (h) => { h.state.main.qcQty = 1 }
  ]) {
    const h = reversalHarness()
    h.state.onHold = () => change(h)
    // Business failure is returned before onHold in the mock.
    if (change.toString().includes('holdFailure')) change(h)
    await assert.rejects(verifyWmsQcInboundReversal(h.api, h.caseRecord, h.fixture, h.prepared, []),
      /业务失败|未恢复 hold/)
    assert.equal(h.calls.some(([method, path]) =>
      method === 'PUT' && path.startsWith('/erp/purchase-in/update-status')), false)
  }
})

test('QC001 ERP cancellation failures, effective inspection or remaining stock cannot pass the reverse catalog requirement', async () => {
  for (const change of [
    (h) => { h.state.cancelFailure = true },
    (h) => { h.state.erp.status = 20 },
    (h) => { h.state.main.billStage = '10' },
    (h) => { h.state.main.isEffective = 1 },
    (h) => { h.state.inspection.isEffective = 1 },
    (h) => { h.state.inspection.billStage = '14' },
    (h) => { h.state.inspection.isVoided = 1 },
    (h) => { h.state.inspectionEntries[0].qty = 2 },
    (h) => { h.state.balances[0].qty = 1; h.state.balances[0].holdQty = 1 }
  ]) {
    const h = reversalHarness()
    h.state.onCancel = () => change(h)
    if (change.toString().includes('cancelFailure')) change(h)
    await assert.rejects(verifyWmsQcInboundReversal(h.api, h.caseRecord, h.fixture, h.prepared, []),
      /业务失败|未撤销专属库存/)
    assert.equal(h.caseRecord.checks.some((check) =>
      check.name === '采购入库弃审撤销本轮库存且来源单据回读未生效' && check.passed), false)
  }
})

test('QC001 catalog original assertions and reverse remain exact and all require independent proof', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((row) => row.id === 'WMS-QC-001')
  const caseRecord = record()
  const names = __internal.catalogContract['WMS-QC-001'].flatMap(([, checks]) => checks)
  caseRecord.checks = [...new Set(names)].map((name) => ({ name, passed: true }))
  mapWmsQcCatalogAssertions(caseRecord, 'WMS-QC-001')
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.assertion), definition.assertions)
  assert.deepEqual(caseRecord.catalogReverseAssertions.map((row) => row.assertion), definition.reverse)
  assert.deepEqual(caseRecord.remainingAssertions, definition.reverse)
  assert.equal(caseRecord.passCandidate, false)
  for (const name of caseRecord.catalogReverseAssertions[0].evidenceChecks) {
    caseRecord.checks.push({ name, passed: true })
  }
  mapWmsQcCatalogAssertions(caseRecord, 'WMS-QC-001')
  assert.deepEqual(caseRecord.remainingAssertions, [])
  assert.equal(caseRecord.passCandidate, true)
  caseRecord.checks.find((row) => row.name === '非质检存货不生成采购入库检').passed = false
  mapWmsQcCatalogAssertions(caseRecord, 'WMS-QC-001')
  assert.deepEqual(caseRecord.remainingAssertions, [definition.assertions[0]])
  assert.equal(caseRecord.passCandidate, false)
})

test('QC001 keeps its non-quality receipt and zeroed reversal facts away from public cleanup', async () => {
  const h = reversalHarness()
  h.caseRecord.fixtures.push({ kind: 'stockIo', id: '400', retained: true })
  let cleaned
  await __internal.cleanupWmsQcFixtures({}, h.caseRecord, async (_api, scoped) => {
    cleaned = scoped.fixtures
  })
  assert.deepEqual(cleaned, [])
  assert.equal(h.caseRecord.fixtures.every((row) => row.retained), true)
})
