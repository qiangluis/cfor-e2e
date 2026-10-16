import assert from 'node:assert/strict'
import test from 'node:test'

import { __internal, mapWmsQcCatalogAssertions, verifyWmsQcOutboundClosure } from '../fixtures/wms-qc-closure.mjs'

const ok = (data) => ({ code: 0, data })
const copy = (value) => structuredClone(value)

function harness () {
  const calls = []
  const fixture = {
    token: 'owned-q002', marker: 'E2E-Q002-OQC',
    warehouse: { id: '201' }, area: { id: '202' }, location: { id: '203' },
    material: { id: '204', unitId: '205' }
  }
  const saleOut = { id: '301', payload: { orderId: '305', items: [{ count: 1 }] } }
  const artifacts = { plan: { planId: '401' }, item: { itemId: '402' } }
  const record = {
    checks: [], notes: [], evidence: [], fixtures: [
      ...['warehouse', 'area', 'location', 'material'].map((kind) => ({
        kind, id: fixture[kind].id, token: fixture.token
      })),
      { kind: 'saleOut', id: '301', marker: fixture.marker },
      { kind: 'saleOrder', id: '305', marker: fixture.marker },
      { kind: 'qualityArtifact', type: '201', planId: '401', materialId: '204', marker: fixture.marker }
    ]
  }
  const inspection = (id, recheck = false) => ({
    inspectionId: id,
    detail: {
      id, billNo: `${fixture.marker}-${id}`, srcBillType: 'MesStkIo:201', srcBillId: '303',
      type: '201', inspectionPlan: '401', isEffective: 0,
      isRecheck: recheck ? 1 : 0, reinspectOfId: recheck ? '501' : null,
      inspectionRound: recheck ? 2 : 1, actions: { edit: true, check: true }
    },
    entries: [{
      id: `${id}1`, mid: id, materialId: '204', srcBillId: '303', srcEntryId: '304',
      srcBillType: 'MesStkIo:201', qty: 1
    }],
    items: [{ id: `${id}2`, mid: id, entryId: `${id}1`, itemId: '402', itemName: 'OQC item' }]
  })
  const state = {
    erp: {
      id: '301', orderId: '305', status: 20, remark: fixture.marker,
      items: [{ id: '302', productId: '204', warehouseId: '201', count: 1 }]
    },
    order: { id: '305', remark: fixture.marker, items: [{ id: '306', outCount: 1 }] },
    main: {
      id: '303', billNo: `${fixture.marker}-WMS`, stockIoType: '201',
      srcBillType: 'ErpSaleOut', srcBillId: '301', billStage: '24',
      isEffective: 0, isVoided: 0, isClosed: 0, actions: { execute: true }
    },
    entries: [{
      id: '304', mid: '303', materialId: '204', warehouseId: '201', srcBillType: 'ErpSaleOut',
      srcBillId: '301', srcEntryId: '302', stockIoDirection: '2', qty: 1, isQc: 1, inStockTime: null
    }],
    inventory: [{
      id: '209', materialId: '204', warehouseId: '201', qty: 1, availableQty: 1,
      holdQty: 0, lockQty: 0, frozenQty: 0, pendingPutawayQty: 0
    }],
    inspections: [inspection('501')], audit: [['original-audit']], executed: false
  }
  const baseline = copy(state.inventory)
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      const url = new URL(path, 'http://offline')
      const id = url.searchParams.get('id')
      const quality = state.inspections.find((row) => row.inspectionId === id)
      switch (url.pathname) {
        case '/erp/sale-out/get': return ok(state.erp)
        case '/erp/sale-order/get': return ok(state.order)
        case '/mes/stkIo/queryById': return ok(state.main)
        case '/mes/stkIo/queryEntryByMainId': return ok(state.entries)
        case '/mes/stkInventory/list':
          return ok({ records: state.inventory, total: state.inventory.length })
        case '/mes/quality/qualityInspection/list/dictText':
          return ok({ records: state.inspections.map((row) => row.detail), total: state.inspections.length })
        case '/mes/quality/qualityInspection/queryById/dictText': return ok(quality.detail)
        case '/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText':
          return ok(quality.entries)
        case '/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText':
          return ok(quality.items)
        default: throw new Error(`Unexpected GET ${path}`)
      }
    },
    async putBusiness (path, payload) {
      calls.push(['PUT-BUSINESS', path, copy(payload)])
      if (path === '/mes/quality/qualityInspection/edit/submit') {
        const row = state.inspections.find((item) => item.inspectionId === payload.id)
        row.detail = { ...row.detail, passQty: payload.passQty, inspectionResult: payload.inspectionResult }
        row.entries = copy(payload.qualityInspectionEntryList)
        row.items = copy(payload.qualityInspectionItemList)
        return ok(true)
      }
      assert.equal(path, '/mes/stkIo/execute')
      assert.equal(state.inspections.at(-1).detail.passQty, 1)
      state.executed = true
      state.main.isEffective = 1
      state.main.billStage = '34'
      state.main.actions = { void: true }
      state.entries[0].inStockTime = '2026-10-15 20:00:00'
      state.inventory = []
      state.audit.push(['formal-release'])
      state.onExecute?.()
      return ok(true)
    },
    async put (path, payload, options) {
      calls.push(['PUT', path, copy(payload), options])
      if (path === '/mes/quality/qualityInspection/check') {
        const row = state.inspections.find((item) => item.inspectionId === payload.id)
        row.detail.isEffective = 1
        row.detail.actions = { void: true }
        return ok(true)
      }
      assert.equal(path, '/mes/stkIo/execute')
      state.onReject?.()
      if (state.failure) return state.failure
      return {
        code: 500,
        message: state.executed
          ? `${state.main.billNo}：单据不能做该操作，可能被其他用户改变了状态！`
          : '当前出入库单还需销售出库检'
      }
    },
    async postBusiness (path, payload) {
      calls.push(['POST', path, copy(payload)])
      assert.equal(path, '/mes/quality/qualityInspection/recheck')
      assert.deepEqual(payload, { id: '501' })
      state.inspections.push(inspection('502', true))
      state.onRecheck?.()
      return ok({ id: '502', reinspectOfId: '501' })
    }
  }
  const runReadOnlySql = async (sql) => {
    calls.push(['SQL', sql])
    assert.match(sql, /^SELECT \* FROM mes_stk_inventory(?:_adjust_log)? WHERE tenant_id = 1/)
    if (state.noSql) return { available: false, rows: [] }
    return { available: true, rows: copy(sql.includes('adjust_log') ? state.audit : state.inventory) }
  }
  return {
    api, state, record, calls, fixture, artifacts,
    run: () => verifyWmsQcOutboundClosure(
      api, record, fixture, saleOut, '303', baseline, artifacts, { runReadOnlySql })
  }
}

test('201 OQC uses formal NG, exact refusal, a distinct recheck, release, deduction and duplicate refusal', async () => {
  const h = harness()
  await h.run()
  assert.equal(h.record.checks.every((row) => row.passed), true)
  assert.equal(h.state.inspections[0].detail.passQty, 0)
  assert.equal(h.state.inspections[0].items[0].finalInspectionResult, '0')
  assert.equal(h.state.inspections[1].detail.passQty, 1)
  assert.equal(h.calls.filter(([method]) => method === 'POST').length, 1)
  assert.equal(h.calls.filter(([method, path]) =>
    method === 'PUT-BUSINESS' && path === '/mes/stkIo/execute').length, 1)
  const refuses = h.calls.filter(([method, path]) => method === 'PUT' && path === '/mes/stkIo/execute')
  assert.equal(refuses.length, 2)
  assert.deepEqual(refuses[0][3].expectedBusinessRejection, {
    code: 500, message: '当前出入库单还需销售出库检', allowServiceCode: true
  })
  assert.equal(h.record.outboundOqcEvidence[0].rejectedBefore.stock.main.isEffective, 0)
  assert.equal(h.record.fixtures.some((row) => row.inspectionId === '502' && row.retained), true)
  mapWmsQcCatalogAssertions(h.record, 'WMS-QC-002')
  assert.equal(h.record.catalogAssertions[3].status, 'VERIFIED')
  assert.equal(h.record.catalogAssertions[4].status, 'VERIFIED')
  assert.equal(h.record.catalogAssertions[2].status, 'GAP')
  assert.equal(h.record.passCandidate, false)
})

for (const failure of [
  { code: 500, message: '数据库连接失败' },
  { code: 403, message: '没有权限' },
  { code: 0, data: true },
  { code: 500, message: '当前出入库单还需销售出库检', msg: '其它失败' }
]) {
  test(`OQC rejects unrelated/success/conflicting refusal ${JSON.stringify(failure)}`, async () => {
    const h = harness()
    h.state.failure = failure
    await assert.rejects(h.run(), /OQC 未精确拒绝/)
    assert.equal(h.calls.some(([method]) => method === 'POST'), false)
  })
}

for (const [label, mutate] of [
  ['WMS version', (s) => { s.main.version = '2' }],
  ['entry quantity', (s) => { s.entries[0].remark = 'changed' }],
  ['inventory components', (s) => { s.inventory[0].availableQty = 0; s.inventory[0].holdQty = 1 }],
  ['ERP order', (s) => { s.order.items[0].outCount = 2 }],
  ['original inspection', (s) => { s.inspections[0].detail.remark = 'changed' }],
  ['audit append', (s) => { s.audit.push(['unexpected']) }]
]) {
  test(`OQC refusal detects ${label} mutation before any recheck`, async () => {
    const h = harness()
    h.state.onReject = () => mutate(h.state)
    await assert.rejects(h.run(), /OQC 未精确拒绝或完整事实发生变化/)
    assert.equal(h.calls.some(([method]) => method === 'POST'), false)
  })
}

for (const [label, mutate] of [
  ['missing registry', (h) => { h.record.fixtures.pop() }],
  ['foreign source', (h) => { h.state.inspections[0].entries[0].srcEntryId = '999' }],
  ['missing quality flag', (h) => { h.state.entries[0].isQc = 0 }],
  ['effective source', (h) => { h.state.main.isEffective = 1 }],
  ['missing execute', (h) => { h.state.main.actions = {} }],
  ['missing SQL', (h) => { h.state.noSql = true }]
]) {
  test(`OQC ${label} preflight refuses before any write`, async () => {
    const h = harness()
    mutate(h)
    await assert.rejects(h.run(), /BLOCKED:/)
    assert.equal(h.calls.some(([method]) => ['PUT', 'PUT-BUSINESS', 'POST'].includes(method)), false)
  })
}

test('recheck must preserve original conclusion and the formal chain root', async () => {
  for (const mutate of [
    (s) => { s.inspections[0].detail.passQty = 1 },
    (s) => { s.inspections[1].detail.reinspectOfId = '999' },
    (s) => { s.inspections[1].detail.inspectionRound = 1 }
  ]) {
    const h = harness()
    h.state.onRecheck = () => mutate(h.state)
    await assert.rejects(h.run(), /201 复检链/)
    assert.equal(h.state.executed, false)
  }
})

test('duplicate execute detects even an audit-only mutation', async () => {
  const h = harness()
  h.state.onReject = () => {
    if (h.state.executed) h.state.audit.push(['duplicate-write'])
  }
  await assert.rejects(h.run(), /201 重复执行未精确拒绝/)
  assert.equal(h.record.checks.at(-1).passed, false)
})

test('formal recheck may change sent-for-inspection counters but cannot execute stock early', async () => {
  const allowed = harness()
  allowed.state.onRecheck = () => {
    allowed.state.main.afterSaveQcQty = 2
    allowed.state.entries[0].afterSaveQcQty = 2
  }
  await allowed.run()
  assert.equal(allowed.record.checks.every((row) => row.passed), true)
  const premature = harness()
  premature.state.onRecheck = () => { premature.state.entries[0].inStockTime = '2026-10-15 20:00:00' }
  await assert.rejects(premature.run(), /复检审核提前改变库存执行事实/)
  assert.equal(premature.state.executed, false)
})

test('an interrupted OQC artifact creation is registered and retained, never silently orphaned', async () => {
  const h = harness()
  const api = {
    async postBusiness (path) {
      assert.equal(path, '/mes/quality/item/add')
      throw new Error('ECONNRESET after request')
    }
  }
  await assert.rejects(__internal.createQualityArtifacts(
    api, h.record, h.fixture, h.fixture.material, '201'), /ECONNRESET/)
  const owned = h.record.fixtures.at(-1)
  assert.equal(owned.kind, 'qualityArtifact')
  assert.equal(owned.createAttempted, true)
  assert.equal(owned.retained, true)
  assert.equal(owned.marker, h.fixture.marker)
  assert.equal(owned.materialId, h.fixture.material.id)
})

test('201 OQC publishes a dedicated plan and binds only the owned material using formal APIs', async () => {
  const h = harness()
  const saved = {}
  const api = {
    async postBusiness (path, payload) {
      if (path === '/mes/quality/item/add') saved.item = { ...payload, id: '402' }
      else if (path === '/mes/quality/item/publish?id=402') saved.item.publishStatus = 1
      else if (path === '/mes/quality/qualityPlan/add') saved.plan = { ...payload, id: '401' }
      else if (path === '/mes/quality/qualityPlan/publish?id=401') saved.plan.publishStatus = 1
      else if (path === '/mes/quality/qualityMaterial/add') saved.rule = { ...payload, id: '403' }
      else throw new Error(`unexpected POST ${path}`)
      return ok(true)
    },
    async getBusiness (path) {
      if (path.startsWith('/mes/quality/item/list/dictText?')) return ok([saved.item])
      if (path.startsWith('/mes/quality/qualityPlan/list/dictText?')) return ok([saved.plan])
      if (path.startsWith('/mes/quality/qualityMaterial/list/dictText?')) return ok([saved.rule])
      throw new Error(`unexpected GET ${path}`)
    }
  }
  const result = await __internal.createQualityArtifacts(
    api, h.record, h.fixture, h.fixture.material, '201')
  assert.equal(result.plan.type, 201)
  assert.equal(saved.item.publishStatus, 1)
  assert.equal(saved.plan.publishStatus, 1)
  assert.equal(saved.rule.type, '201')
  assert.equal(saved.rule.materialId, '204')
  assert.equal(saved.rule.planId, '401')
  assert.equal(h.record.fixtures.at(-1).ruleId, '403')
  assert.equal(h.record.fixtures.at(-1).retained, true)
  await assert.rejects(__internal.createQualityArtifacts(
    {}, h.record, h.fixture, { id: '999' }, '201'), /只能绑定本轮专属物料/)
})
