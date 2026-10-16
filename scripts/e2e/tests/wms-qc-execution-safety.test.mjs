import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  mapWmsQcCatalogAssertions,
  verifyWmsAtp,
  verifyWmsQcDuplicateAudit,
  verifyWmsQcInvalidPurchaseLine
} from '../fixtures/wms-qc-closure.mjs'
import { __internal } from '../fixtures/wms-qc-closure.mjs'

const ok = (data) => ({ code: 0, data })
const freshRecord = () => ({ checks: [], notes: [], evidence: [], fixtures: [] })
const fixture = {
  marker: 'E2E-Q003-SAFETY',
  warehouse: { id: '201' },
  material: { id: '202' }
}
const inbound = {
  id: '203',
  wms: { id: '204' },
  payload: {
    orderId: '205',
    remark: fixture.marker,
    items: [{ productId: '202', warehouseId: '201', count: 1, orderItemId: '206' }]
  }
}

function harness () {
  const calls = []
  const state = {
    main: {
      id: '204', billNo: 'E2E-Q003-IO', isEffective: 1, actions: { check: false },
      stockIoType: '101', srcBillType: 'ErpPurchaseIn', srcBillId: '203'
    },
    entries: [{ id: '207', mid: '204', materialId: '202', warehouseId: '201', qty: 1 }],
    inventory: [{
      id: '208', materialId: '202', warehouseId: '201', qty: 1, availableQty: 1,
      lockQty: 0, holdQty: 0, frozenQty: 0, pendingPutawayQty: 0
    }],
    order: { id: '205', items: [{ id: '206', inCount: 1 }] },
    probeRows: [],
    missing: { code: 500, message: '未找到对应数据' },
    duplicate: { code: 500, message: 'E2E-Q003-IO：单据不能做该操作，可能被其他用户改变了状态！' },
    invalid: { code: 1030500000, msg: '产品不存在' }
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET-BUSINESS', path])
      if (path.startsWith('/mes/stkIo/queryById?')) return ok(state.main)
      if (path.startsWith('/mes/stkIo/queryEntryByMainId?')) return ok(state.entries)
      if (path.startsWith('/mes/stkInventory/list?')) {
        return ok({ records: state.inventory, total: state.inventory.length })
      }
      if (path.startsWith('/erp/purchase-order/get?')) return ok(state.order)
      if (path.startsWith('/erp/purchase-in/page?')) {
        return ok({ list: state.probeRows, total: state.probeRows.length })
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async get (path, options) {
      calls.push(['GET', path, undefined, options])
      return state.missing
    },
    async put (path, body, options) {
      calls.push(['PUT', path, body, options])
      state.onPut?.()
      return state.duplicate
    },
    async post (path, body, options) {
      calls.push(['POST', path, body, options])
      state.onPost?.()
      return state.invalid
    }
  }
  return { state, calls, api }
}

test('duplicate WMS audit requires an exact state refusal and unchanged owned records', async () => {
  const { api, calls } = harness()
  const record = freshRecord()
  const result = await verifyWmsQcDuplicateAudit(api, record, fixture, inbound)
  assert.equal(result.rejected, true)
  assert.equal(result.unchanged, true)
  const request = calls.find(([method]) => method === 'PUT')
  assert.deepEqual(request[3].expectedBusinessRejection, {
    code: 500,
    message: 'E2E-Q003-IO：单据不能做该操作，可能被其他用户改变了状态！',
    allowServiceCode: true
  })
  assert.equal(record.checks.every((check) => check.passed), true)
})

test('effective WMS bill may omit check or return null without weakening exact rejection proof', async () => {
  for (const actions of [
    { void: true, edit: false, invalid: true, unclose: true, delete: false },
    { check: null },
    { check: false }
  ]) {
    const { api, state, calls } = harness()
    state.main.actions = actions
    const result = await verifyWmsQcDuplicateAudit(api, freshRecord(), fixture, inbound)
    assert.equal(result.rejected && result.unchanged, true)
    assert.equal(calls.filter(([method]) => method === 'PUT').length, 1)
  }
})

test('missing or malformed actions cannot authorize a deliberate duplicate write', async () => {
  for (const actions of [undefined, null, [], 'disabled', { check: 'false' }, { check: 0 }, { check: true }]) {
    const { api, state, calls } = harness()
    state.main.actions = actions
    await assert.rejects(verifyWmsQcDuplicateAudit(api, freshRecord(), fixture, inbound), /BLOCKED:/)
    assert.equal(calls.some(([method]) => method === 'PUT'), false)
  }
})

for (const [label, response] of [
  ['generic service failure', { code: 500, message: '数据库连接失败' }],
  ['unrelated business rejection', { code: 1030500000, msg: '产品不存在' }],
  ['authorization failure', { code: 403, msg: '没有该操作权限' }],
  ['conflicting messages', {
    code: 500, message: 'E2E-Q003-IO：单据不能做该操作，可能被其他用户改变了状态！',
    msg: '数据库连接失败'
  }]
]) {
  test(`duplicate audit does not accept ${label} as idempotency evidence`, async () => {
    const { api, state } = harness()
    state.duplicate = response
    const record = freshRecord()
    await assert.rejects(verifyWmsQcDuplicateAudit(api, record, fixture, inbound), /未精确拒绝/)
    assert.equal(record.checks[0].passed, false)
  })
}

for (const [label, change] of [
  ['main', (state) => { state.main.isVoided = 1 }],
  ['entry', (state) => { state.entries[0].qty = 2 }],
  ['balance', (state) => { state.inventory[0].availableQty = 0; state.inventory[0].lockQty = 1 }]
]) {
  test(`duplicate audit detects ${label} mutation even with a matching refusal`, async () => {
    const { api, state } = harness()
    state.onPut = () => change(state)
    const record = freshRecord()
    await assert.rejects(verifyWmsQcDuplicateAudit(api, record, fixture, inbound), /正式数据发生变化/)
    assert.equal(record.checks[0].passed, true)
    assert.equal(record.checks[1].passed, false)
  })
}

test('pending bill and foreign stock dimensions stop before the duplicate write', async () => {
  for (const change of [
    (state) => { state.main.isEffective = 0; state.main.effectiveTime = '2026-10-12T10:00:00' },
    (state) => { state.main.actions.check = true },
    (state) => { state.entries[0].warehouseId = '999' },
    (state) => { state.main.srcBillId = '999' }
  ]) {
    const { api, state, calls } = harness()
    change(state)
    await assert.rejects(verifyWmsQcDuplicateAudit(api, freshRecord(), fixture, inbound), /BLOCKED:/)
    assert.equal(calls.some(([method]) => method === 'PUT'), false)
  }
})

test('transport errors propagate without any successful duplicate check', async () => {
  const { api } = harness()
  api.put = async () => { throw new Error('ECONNRESET') }
  const record = freshRecord()
  await assert.rejects(verifyWmsQcDuplicateAudit(api, record, fixture, inbound), /ECONNRESET/)
  assert.equal(record.checks.some((check) => check.passed), false)
})

test('invalid second line uses the submitted remark for complete before/after absence checks', async () => {
  const { api, calls } = harness()
  const record = freshRecord()
  const result = await verifyWmsQcInvalidPurchaseLine(api, record, fixture, inbound)
  assert.equal(result.rejected && result.absent && result.unchanged, true)
  const [, path, payload, options] = calls.find(([method]) => method === 'POST')
  assert.equal(path, '/erp/purchase-in/create')
  assert.equal(Object.hasOwn(payload, 'billNo'), false)
  assert.equal(payload.remark, result.marker)
  assert.equal(payload.items.length, 2)
  assert.equal(payload.items[1].productId, '999999999999999999')
  assert.deepEqual(options.expectedBusinessRejection, { code: 1030500000, message: '产品不存在' })
  const queries = calls.filter(([method, query]) =>
    method === 'GET-BUSINESS' && query.startsWith('/erp/purchase-in/page?'))
  assert.equal(queries.length, 2)
  for (const [, query] of queries) {
    assert.equal(new URL(query, 'http://unit').searchParams.get('remark'), payload.remark)
  }
  assert.equal(record.notes.includes(
    '非法物料在插入主单前被全量校验拒绝；该检查不计入事务中途失败整体回滚证据。'
  ), true)
})

test('unknown absence, a colliding probe or a real material never triggers a negative write', async () => {
  for (const change of [
    (state) => { state.missing = { code: 0, data: { id: '999999999999999999' } } },
    (state) => { state.missing = { code: 500, message: '数据库连接失败' } },
    (state) => { state.probeRows = [{ id: '209', remark: `${fixture.marker}-INVALID-LINE` }] }
  ]) {
    const { api, state, calls } = harness()
    change(state)
    await assert.rejects(verifyWmsQcInvalidPurchaseLine(api, freshRecord(), fixture, inbound), /BLOCKED:/)
    assert.equal(calls.some(([method]) => method === 'POST'), false)
  }
})

test('invalid second-line refusal must leave the order and owned stock unchanged with no orphan', async () => {
  for (const change of [
    (state) => { state.invalid = { code: 500, message: '数据库连接失败' } },
    (state) => { state.probeRows = [{ id: '209', remark: `${fixture.marker}-INVALID-LINE` }] },
    (state) => { state.order.items[0].inCount = 2 },
    (state) => { state.inventory[0].holdQty = 1; state.inventory[0].availableQty = 0 }
  ]) {
    const { api, state } = harness()
    state.onPost = () => change(state)
    await assert.rejects(verifyWmsQcInvalidPurchaseLine(api, freshRecord(), fixture, inbound),
      /未精确拒绝|孤儿单据|正式数据变化/)
  }
})

test('catalog does not promote pre-validation or a stock balance into rollback and flow proof', () => {
  const record = freshRecord()
  record.checks = [
    '重复审核正式 WMS 单据不允许二次执行',
    '重复审核前后正式主单、来源明细和专属库存完全不变',
    '多行正式采购入库失败后不留下孤儿单据',
    '专属库存余额可回读并保留库存守恒字段'
  ].map((name) => ({ name, passed: true }))
  mapWmsQcCatalogAssertions(record, 'WMS-QC-003')
  assert.equal(record.catalogAssertions[2].status, 'VERIFIED')
  assert.equal(record.catalogAssertions[3].status, 'GAP')
  assert.equal(record.catalogAssertions[4].status, 'GAP')
  assert.equal(record.passCandidate, false)
  assert.equal(record.remainingAssertions.includes('多行失败整体回滚'), true)
})

test('WMS balances and 201 source alone do not establish shipment conservation', () => {
  const record = freshRecord()
  record.checks = [
    { name: '正式销售出库生成 201 WMS 来源流水', passed: true },
    { name: '正式销售出库后库存总量守恒', passed: true }
  ]
  mapWmsQcCatalogAssertions(record, 'WMS-QC-002')
  assert.equal(record.catalogAssertions[4].status, 'GAP')
})

test('QC001 and QC003 mappings preserve every original catalog assertion verbatim', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  for (const caseId of ['WMS-QC-001', 'WMS-QC-003']) {
    const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === caseId)
    const record = freshRecord()
    mapWmsQcCatalogAssertions(record, caseId)
    assert.deepEqual(record.catalogAssertions.map((item) => item.assertion), definition.assertions)
    const reverse = definition.reverse || []
    assert.deepEqual(record.remainingAssertions, [...definition.assertions, ...reverse])
    if (reverse.length) {
      assert.deepEqual(record.catalogReverseAssertions.map((item) => item.assertion), definition.reverse)
    }
    assert.equal(record.passCandidate, false)
  }
})

test('QC003 forward proof cannot replace the original reverse requirement', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'WMS-QC-003')
  const record = freshRecord()
  const names = __internal.catalogContract['WMS-QC-003'].flatMap(([, checks]) => checks)
  record.checks = [...new Set(names)].map((name) => ({ name, passed: true }))

  mapWmsQcCatalogAssertions(record, 'WMS-QC-003')

  assert.deepEqual(record.catalogAssertions.map((item) => item.assertion), definition.assertions)
  assert.equal(record.catalogAssertions.every((item) => item.status === 'VERIFIED'), true)
  assert.deepEqual(record.catalogReverseAssertions.map((item) => item.assertion), definition.reverse)
  assert.equal(record.catalogReverseAssertions.every((item) => item.status === 'GAP'), true)
  assert.deepEqual(record.remainingAssertions, definition.reverse)
  assert.equal(record.passCandidate, false)
})

test('QC001 needs both quality-material and non-quality-material controls, not a page alone', () => {
  const record = freshRecord()
  record.checks = [
    { name: 'wms-qc-001-inbound页面字段、专属标记和截图证据', passed: true },
    { name: '非质检存货不生成采购入库检', passed: true }
  ]
  mapWmsQcCatalogAssertions(record, 'WMS-QC-001')
  assert.equal(record.catalogAssertions[0].status, 'GAP')
  record.checks.push(
    { name: '正式采购入库生成 101 WMS 来源单和明细', passed: true },
    { name: '正式质检单含来源明细和项目明细并审核生效', passed: true }
  )
  mapWmsQcCatalogAssertions(record, 'WMS-QC-001')
  assert.equal(record.catalogAssertions[0].status, 'VERIFIED')
  assert.equal(record.passCandidate, false)
})

test('explicit contract gaps and failed cleanup keep PASS unavailable', () => {
  const names = __internal.catalogContract['WMS-QC-001'].flatMap(([, checks]) => checks)
  for (const failure of ['gap', 'cleanup', 'undefined-check']) {
    const record = freshRecord()
    record.checks = [...new Set(names)].map((name) => ({ name, passed: true }))
    if (failure === 'gap') record.contractGaps = [{ key: 'inbound-reversal', status: 'GAP' }]
    if (failure === 'cleanup') record.checks.push({ name: 'cleanup', passed: false })
    if (failure === 'undefined-check') record.checks.push({ name: 'missing proof' })
    mapWmsQcCatalogAssertions(record, 'WMS-QC-001')
    assert.equal(record.passCandidate, false)
  }
})

test('formal cleanup protects all dedicated facts and dependencies from the public cleanup helper', async () => {
  const record = freshRecord()
  record.fixtures = [
    { kind: 'purchaseOrder', id: '205' },
    { kind: 'purchaseInbound', id: '203' },
    { kind: 'purchaseReturn', id: '209' },
    { kind: 'warehouse', id: '201' },
    { kind: 'area', id: '210' },
    { kind: 'location', id: '211' },
    { kind: 'material', id: '202' },
    { kind: 'partner', id: '212' },
    { kind: 'qualityArtifact', ruleId: '213' },
    { kind: 'qualityMaterial', id: '214' },
    { kind: 'dictionary', id: '215' },
    { kind: 'mapping', id: '216' }
  ]
  const writes = []
  const api = {
    async deleteBusiness (path) { writes.push(path); return ok(true) },
    async putBusiness () { throw new Error('cleanup must not void a formal bill') },
    async getBusiness () { throw new Error('cleanup must not delete referenced partners') }
  }
  let publicFixtures
  await __internal.cleanupWmsQcFixtures(api, record, async (_api, scopedRecord) => {
    publicFixtures = scopedRecord.fixtures
  })
  assert.deepEqual(writes, [
    '/wms/business-io-type-rule/delete?id=216',
    '/system/dict-data/delete?id=215'
  ])
  assert.deepEqual(publicFixtures.map((item) => item.kind), ['dictionary', 'mapping'])
  assert.equal(record.fixtures.slice(0, 10).every((item) => item.retained), true)
  assert.equal(record.checks.at(-1).passed, true)
})

test('an interrupted formal creation response retains dependencies even without a returned ID', async () => {
  const record = freshRecord()
  record.fixtures = [
    { kind: 'warehouse', id: '201' },
    { kind: 'area', id: '210' },
    { kind: 'location', id: '211' },
    { kind: 'material', id: '202' },
    { kind: 'partner', id: '212' }
  ]
  await assert.rejects(__internal.createPurchaseOrder({
    async postBusiness () { throw new Error('ECONNRESET after request was sent') }
  }, record, { marker: fixture.marker }, { id: '212' }, { id: '202', unitId: '213' }), /ECONNRESET/)
  const attempted = record.fixtures.find((item) => item.kind === 'purchaseOrder')
  assert.equal(attempted.createAttempted, true)
  assert.equal(attempted.id, undefined)
  let cleanupRows
  await __internal.cleanupWmsQcFixtures({
    async deleteBusiness () { throw new Error('must not delete dependencies of an uncertain formal write') }
  }, record, async (_api, scoped) => { cleanupRows = scoped.fixtures })
  assert.deepEqual(cleanupRows, [])
  assert.equal(record.fixtures.every((item) => item.retained), true)
  assert.equal(record.notes.some((note) => note.includes('创建响应未确认ID')), true)
})

test('cleanup failure is propagated and never recorded as successful preservation', async () => {
  const record = freshRecord()
  record.fixtures = [{ kind: 'dictionary', id: '215' }]
  await assert.rejects(__internal.cleanupWmsQcFixtures({
    async deleteBusiness () { return { code: 500, msg: '系统异常' } }
  }, record, async () => { throw new Error('must not continue cleanup after failure') }), /清理未完成/)
  assert.equal(record.checks.at(-1).passed, false)
})

function atpHarness (stockCount = 9) {
  const inventory = [{
    id: '208', materialId: '202', warehouseId: '201', qty: 10,
    availableQty: 7, lockQty: 3, holdQty: 0, frozenQty: 0, pendingPutawayQty: 0
  }]
  return {
    async getBusiness (path) {
      if (path.startsWith('/mes/stkInventory/list?')) return ok({ records: inventory, total: 1 })
      if (path.startsWith('/wms/transfer-bill/page?')) {
        return ok({ list: [{ id: '210', transferStatus: 'IN_TRANSIT' }], total: 1 })
      }
      if (path.startsWith('/wms/transfer-bill/get?')) return ok({
        id: '210', transferStatus: 'IN_TRANSIT',
        lines: [{ materialId: '202', qty: 5, inPostedQty: 3 }]
      })
      if (path.startsWith('/erp/sale-order/get?')) return ok({
        id: '211', items: [{ id: '212', productId: '202', stockCount }]
      })
      throw new Error(`unexpected GET ${path}`)
    }
  }
}

test('ATP requires positive reservation/in-transit evidence and does not subtract lock twice', async () => {
  const record = freshRecord()
  const result = await verifyWmsAtp(atpHarness(), record, { orderId: '211', materialId: '202' })
  assert.equal(result.passed, true)
  assert.equal(result.reserved, 3)
  assert.equal(result.inTransit, 2)
  assert.equal(record.checks.find((check) =>
    check.name === 'ATP 正数预留及在途对照且未二次扣减 lockQty').passed, true)
  const mismatch = await verifyWmsAtp(atpHarness(6), freshRecord(), { orderId: '211', materialId: '202' })
  assert.equal(mismatch.passed, false)
})

test('ATP cannot certify a wrong order, incomplete pages or reads that mutate balances', async () => {
  for (const failure of ['wrong-order', 'truncated-page', 'query-mutation']) {
    const original = atpHarness()
    let inventoryReads = 0
    const api = {
      async getBusiness (path) {
        const result = await original.getBusiness(path)
        if (failure === 'wrong-order' && path.startsWith('/erp/sale-order/get?')) result.data.id = '999'
        if (path.startsWith('/mes/stkInventory/list?')) {
          inventoryReads++
          if (failure === 'truncated-page') result.data = { records: [], total: 1 }
          if (failure === 'query-mutation' && inventoryReads === 2) {
            result.data.records[0].availableQty = 6
            result.data.records[0].lockQty = 4
          }
        }
        return result
      }
    }
    if (failure === 'query-mutation') {
      const result = await verifyWmsAtp(api, freshRecord(), { orderId: '211', materialId: '202' })
      assert.equal(result.passed, false)
    } else {
      await assert.rejects(verifyWmsAtp(api, freshRecord(), { orderId: '211', materialId: '202' }))
    }
  }
})

test('a pending isEffective flag overrides historical effectiveTime in the normal inspection path', async () => {
  const api = {
    async getBusiness () {
      return ok({
        id: '301', billNo: 'E2E-Q001-INSPECTION', isEffective: 0,
        effectiveTime: '2026-10-12T10:00:00', actions: { check: false }
      })
    }
  }
  await assert.rejects(__internal.auditInboundInspectionWhenNeeded(api, freshRecord(), '301'), /不允许手工核批/)
})
