import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { __internal, mapWmsQcCatalogAssertions } from '../fixtures/wms-qc-closure.mjs'

const ok = (data) => ({ code: 0, data })
const ids = Object.fromEntries([
  'supplier', 'order', 'orderItem', 'material', 'unit', 'warehouse', 'area', 'location',
  'account', 'notice', 'noticeLine', 'inbound', 'inboundItem', 'wms', 'wmsEntry'
].map((name, index) => [name, String(9223372036854775800n + BigInt(index))]))

test.before(() => {
  test.mock.method(globalThis, 'fetch', () => { throw new Error('Unit tests must not access real APIs') })
})
test.after(() => test.mock.restoreAll())

function arrivalHarness () {
  const calls = []
  const fixture = {
    marker: 'E2E-Q002-ASN-UNIT', token: 'OWNED-WMS-ASN-UNIT',
    ...Object.fromEntries(['warehouse', 'area', 'location', 'material'].map((kind) =>
      [kind, { id: ids[kind], ...(kind === 'material' ? { unitId: ids.unit } : {}) }]))
  }
  const caseRecord = {
    checks: [], notes: [], evidence: [],
    fixtures: [
      ...['warehouse', 'area', 'location', 'material'].map((kind) =>
        ({ kind, id: ids[kind], token: fixture.token })),
      { kind: 'purchaseOrder', id: ids.order, marker: fixture.marker }
    ]
  }
  const state = {
    overrides: {},
    order: {
      id: ids.order, status: 20, remark: fixture.marker, billNo: 'PO-SERVER-UNIT',
      supplierId: ids.supplier,
      items: [{ id: ids.orderItem, productId: ids.material, productUnitId: ids.unit, count: 1 }]
    },
    submitted: false,
    submittedStatus: 10
  }
  const response = (step, data) => state.overrides[step]
    ? state.overrides[step](structuredClone(data))
    : ok(structuredClone(data))
  const api = {
    async postBusiness (path, body) {
      calls.push(['POST', path, structuredClone(body)])
      if (path === '/mes/wms/arrival-notice/create') {
        state.notice = {
          ...structuredClone(body), id: ids.notice, status: 0,
          lines: body.lines.map((line) => ({
            ...structuredClone(line), id: ids.noticeLine, receivedQuantity: 0, qualifiedQuantity: 0
          }))
        }
        return response('create', ids.notice)
      }
      if (path === `/mes/wms/arrival-notice/submit?id=${ids.notice}`) {
        state.submitted = true
        return response('submit', true)
      }
      assert.equal(path, '/erp/purchase-in/create', 'No direct WMS write or alternative receipt API is allowed')
      assert.equal(state.submitted, true)
      state.inbound = {
        ...structuredClone(body), id: ids.inbound, status: 10, orderNo: state.order.billNo,
        items: body.items.map((line) => ({ ...structuredClone(line), id: ids.inboundItem }))
      }
      return response('inbound-create', ids.inbound)
    },
    async getBusiness (path) {
      calls.push(['GET', path])
      const query = new URL(path, 'http://unit')
      if (query.pathname === '/erp/purchase-order/get') {
        assert.equal(query.searchParams.get('id'), ids.order)
        return response('order', state.order)
      }
      if (query.pathname === '/mes/wms/arrival-notice/get') {
        assert.equal(query.searchParams.get('id'), ids.notice)
        return response(state.submitted ? 'submitted' : 'draft', {
          ...state.notice, status: state.submitted ? state.submittedStatus : 0
        })
      }
      if (query.pathname === '/erp/purchase-in/get') {
        assert.equal(query.searchParams.get('id'), ids.inbound)
        return response('inbound-read', state.inbound)
      }
      if (query.pathname === '/mes/stkIo/list') {
        assert.equal(query.searchParams.get('srcBillType'), 'ErpPurchaseIn')
        assert.equal(query.searchParams.get('srcBillId'), ids.inbound)
        return ok({ records: [{ id: ids.wms, srcBillType: 'ErpPurchaseIn', srcBillId: ids.inbound }] })
      }
      if (query.pathname === '/mes/stkIo/queryById') {
        return ok({ id: ids.wms, stockIoType: '101', srcBillType: 'ErpPurchaseIn', srcBillId: ids.inbound })
      }
      assert.equal(query.pathname, '/mes/stkIo/queryEntryByMainId')
      return response('wms-entries', [{
        id: ids.wmsEntry, mid: ids.wms, materialId: ids.material, unitId: ids.unit,
        warehouseId: ids.warehouse, qty: 1,
        srcBillType: 'ErpPurchaseIn', srcBillId: ids.inbound, srcEntryId: ids.inboundItem
      }])
    },
    async putBusiness (path) {
      calls.push(['PUT', path])
      assert.equal(path, `/erp/purchase-in/update-status?id=${ids.inbound}&status=20`)
      state.inbound.status = 20
      return response('approve', true)
    }
  }
  const run = () => __internal.createPurchaseInbound(api, caseRecord, fixture,
    { id: ids.supplier }, fixture.material,
    { id: ids.order, item: { id: ids.orderItem } }, { id: ids.account })
  return { api, calls, fixture, caseRecord, state, run }
}

test('QC inbound formally creates and submits owned ASN before ERP creation, preserving string IDs and source evidence', async () => {
  const { run, calls, caseRecord, fixture, state } = arrivalHarness()
  const result = await run()
  const writes = calls.filter(([method]) => method !== 'GET')
  assert.deepEqual(writes.map(([, path]) => path), [
    '/mes/wms/arrival-notice/create',
    `/mes/wms/arrival-notice/submit?id=${ids.notice}`,
    '/erp/purchase-in/create',
    `/erp/purchase-in/update-status?id=${ids.inbound}&status=20`
  ])
  const asn = writes[0][2]
  assert.equal(asn.purchaseOrderId, ids.order)
  assert.equal(asn.purchaseOrderCode, state.order.billNo)
  assert.equal(asn.vendorId, ids.supplier)
  assert.equal(asn.supplierShipmentKey, `${fixture.marker}-ASN-SHIP`)
  assert.equal(asn.lines[0].purchaseOrderItemId, ids.orderItem)
  assert.equal(asn.lines[0].itemId, ids.material)
  assert.equal(asn.lines[0].unitId, ids.unit)
  assert.equal(asn.lines[0].arrivalQuantity, 1)
  assert.equal(asn.lines[0].iqcCheckFlag, true)
  assert.equal(result.arrival.id, ids.notice)
  assert.equal(result.arrival.detail.status, 10)
  const erp = writes[2][2]
  assert.equal(erp.businessType, 'NORMAL')
  assert.equal(erp.sourceNoticeId, undefined, 'ERP contract has no ASN foreign key')
  assert.equal(erp.orderId, asn.purchaseOrderId)
  assert.equal(erp.items[0].orderItemId, asn.lines[0].purchaseOrderItemId)
  assert.equal(result.entry.srcEntryId, result.detail.items[0].id)
  assert.ok(caseRecord.checks.every((check) => check.passed))
  const evidence = caseRecord.purchaseArrivalEvidence[0]
  assert.equal(evidence.draft.status, 0)
  assert.equal(evidence.submitted.status, 10)
  state.notice.lines[0].itemId = '999'
  assert.equal(evidence.draft.lines[0].itemId, ids.material)
  assert.equal(evidence.submitted.lines[0].itemId, ids.material)
  assert.ok(caseRecord.evidence.some((item) => item.includes(`ASN ${ids.notice}/${ids.noticeLine}`)))
})

test('ASN accepts only the exact submitted statuses admitted by the ERP service', async () => {
  for (const status of [10, 20, 30, '10', '20', '30']) {
    const harness = arrivalHarness()
    harness.state.submittedStatus = status
    const result = await harness.run()
    assert.equal(result.arrival.detail.status, status)
  }
  for (const status of [0, 40, 90, -1, 1, null, undefined, '', true]) {
    const harness = arrivalHarness()
    harness.state.submittedStatus = status
    await assert.rejects(harness.run(), /ASN 提交后回读状态、所有权或采购来源关联不匹配/)
    assert.equal(harness.calls.some(([, path]) => path === '/erp/purchase-in/create'), false)
    assert.equal(harness.caseRecord.checks.some((check) => check.passed), false)
  }
})

test('foreign or unapproved purchase orders and mismatched source lines cannot create an ASN', async () => {
  for (const change of [
    (h) => { h.caseRecord.fixtures = h.caseRecord.fixtures.filter((item) => item.kind !== 'purchaseOrder') },
    (h) => { h.caseRecord.fixtures.at(-1).marker = 'E2E-ANOTHER-RUN' },
    (h) => { h.state.order.id = '999' },
    (h) => { h.state.order.remark = 'E2E-WMS-FIXTURE from another run' },
    (h) => { h.state.order.remark = `${h.fixture.marker}-OTHER` },
    (h) => { h.state.order.status = 10; h.state.order.isEffective = 1 },
    (h) => { delete h.state.order.status },
    (h) => { h.state.order.billNo = '' },
    (h) => { h.state.order.supplierId = '999' },
    (h) => { h.state.order.items[0].id = '999' },
    (h) => { h.state.order.items[0].productId = '999' },
    (h) => { h.state.order.items[0].productUnitId = '999' },
    (h) => { h.state.order.items[0].count = 0 },
    (h) => { delete h.state.order.items[0].count },
    (h) => { h.state.order.items.push({ ...h.state.order.items[0] }) }
  ]) {
    const harness = arrivalHarness()
    change(harness)
    await assert.rejects(harness.run(), /BLOCKED: ASN/)
    assert.equal(harness.calls.some(([method]) => method !== 'GET'), false)
    assert.equal(harness.caseRecord.checks.length, 0)
  }
})

test('both draft and submitted ASN reads must preserve ownership, order, supplier and exact source line', async () => {
  const changes = [
    (notice) => { notice.id = '999' },
    (notice) => { notice.code = 'FOREIGN-ASN' },
    (notice) => { notice.remark = 'E2E-WMS-FIXTURE' },
    (notice) => { notice.purchaseOrderId = '999' },
    (notice) => { notice.purchaseOrderCode = 'OTHER-ORDER' },
    (notice) => { notice.vendorId = '999' },
    (notice) => { notice.supplierShipmentKey = 'FOREIGN-SHIPMENT' },
    (notice) => { notice.lines = [] },
    (notice) => { notice.lines.push({ ...notice.lines[0] }) },
    (notice) => { notice.lines[0].id = Number(ids.noticeLine) },
    (notice) => { notice.lines[0].purchaseOrderItemId = '999' },
    (notice) => { notice.lines[0].itemId = '999' },
    (notice) => { notice.lines[0].unitId = '999' },
    (notice) => { notice.lines[0].arrivalQuantity = 2 },
    (notice) => { delete notice.lines[0].arrivalQuantity },
    (notice) => { notice.lines[0].iqcCheckFlag = false }
  ]
  for (const step of ['draft', 'submitted']) {
    for (const change of changes) {
      const harness = arrivalHarness()
      harness.state.overrides[step] = (notice) => { change(notice); return ok(notice) }
      await assert.rejects(harness.run(), /ASN .*回读状态、所有权或采购来源关联不匹配/)
      assert.equal(harness.calls.some(([, path]) => path === '/erp/purchase-in/create'), false)
      if (step === 'draft') {
        assert.equal(harness.calls.some(([, path]) => path.includes('/arrival-notice/submit?')), false)
      }
      assert.equal(harness.caseRecord.contractGaps, undefined)
    }
  }
})

test('a returned submitted ASN cannot be treated as a fresh draft and resubmitted', async () => {
  const harness = arrivalHarness()
  harness.state.overrides.draft = (notice) => ok({ ...notice, status: 10 })
  await assert.rejects(harness.run(), /ASN 草稿回读状态/)
  assert.deepEqual(harness.calls.filter(([method]) => method !== 'GET').map(([, path]) => path),
    ['/mes/wms/arrival-notice/create'])
})

test('ASN and ERP business or transport failures propagate instead of becoming GAP or passed checks', async () => {
  for (const step of ['order', 'create', 'draft', 'submit', 'submitted', 'inbound-create', 'inbound-read', 'approve']) {
    for (const failure of [
      () => ({ code: 1020205013, msg: '采购入库必须来源于已提交的到货通知', data: null }),
      () => ({ code: 403, msg: '没有权限', data: null }),
      () => { throw new Error('ECONNRESET unit transport failure') }
    ]) {
      const harness = arrivalHarness()
      harness.state.overrides[step] = failure
      await assert.rejects(harness.run(), /1020205013|403|ECONNRESET/)
      assert.equal(harness.caseRecord.contractGaps, undefined)
      assert.equal(harness.caseRecord.checks.some((check) =>
        check.name === '正式采购入库生成 101 WMS 来源单和明细' && check.passed), false)
      assert.equal(harness.calls.some(([, path]) => path.startsWith('/mes/stkIo/')), false)
      if (['order', 'create', 'draft', 'submit', 'submitted'].includes(step)) {
        assert.equal(harness.calls.some(([, path]) => path === '/erp/purchase-in/create'), false)
      }
    }
  }
})

test('unsafe ASN create IDs stop before source reads, submission or ERP creation', async () => {
  for (const value of [Number(ids.notice), null, '', '0', 'invalid']) {
    const harness = arrivalHarness()
    harness.state.overrides.create = () => ok(value)
    await assert.rejects(harness.run(), /未返回稳定 ID/)
    assert.deepEqual(harness.calls.filter(([method]) => method !== 'GET').map(([, path]) => path),
      ['/mes/wms/arrival-notice/create'])
  }
})

test('ERP source readback must match the owned ASN before any approval', async () => {
  for (const change of [
    (inbound) => { inbound.id = '999' },
    (inbound) => { inbound.remark = 'E2E-WMS-FIXTURE' },
    (inbound) => { inbound.businessType = 'OPENING' },
    (inbound) => { inbound.orderId = '999' },
    (inbound) => { inbound.orderNo = 'FOREIGN-ORDER' },
    (inbound) => { inbound.supplierId = '999' },
    (inbound) => { inbound.items = [] },
    (inbound) => { inbound.items[0].id = Number(ids.inboundItem) },
    (inbound) => { inbound.items[0].orderItemId = '999' },
    (inbound) => { inbound.items[0].productId = '999' },
    (inbound) => { inbound.items[0].productUnitId = '999' },
    (inbound) => { inbound.items[0].warehouseId = '999' },
    (inbound) => { inbound.items[0].count = 2 }
  ]) {
    const harness = arrivalHarness()
    harness.state.overrides['inbound-read'] = (inbound) => { change(inbound); return ok(inbound) }
    await assert.rejects(harness.run(), /采购入库与本轮 ASN .*来源回读不匹配/)
    assert.equal(harness.calls.some(([method]) => method === 'PUT'), false)
    assert.equal(harness.calls.some(([, path]) => path.startsWith('/mes/stkIo/')), false)
  }
})

test('an ASN source mutation after ERP approval is not accepted as a successful inbound', async () => {
  const harness = arrivalHarness()
  harness.state.overrides['inbound-read'] = (inbound) => {
    if (inbound.status === 20) inbound.items[0].orderItemId = '999'
    return ok(inbound)
  }
  await assert.rejects(harness.run(), /采购入库与本轮 ASN .*来源回读不匹配/)
  assert.equal(harness.calls.filter(([method]) => method === 'PUT').length, 1)
  assert.equal(harness.calls.some(([, path]) => path.startsWith('/mes/stkIo/')), false)
})

test('WMS source-line mismatch remains a failed assertion instead of successful chain evidence', async () => {
  for (const change of [
    (entries) => { entries[0].srcBillId = '999' },
    (entries) => { entries[0].srcBillType = 'PurOrder' },
    (entries) => { entries[0].srcEntryId = '999' },
    (entries) => { entries[0].mid = '999' },
    (entries) => { entries[0].materialId = '999' },
    (entries) => { entries.push({ ...entries[0] }) }
  ]) {
    const harness = arrivalHarness()
    harness.state.overrides['wms-entries'] = (entries) => { change(entries); return ok(entries) }
    await assert.rejects(harness.run(), /WMS 主单或明细来源关联不匹配/)
    assert.equal(harness.caseRecord.checks.at(-1).passed, false)
    assert.equal(harness.caseRecord.evidence.some((item) => item.includes('专属采购来源回读')), false)
  }
})

test('cleanup retains ASN facts and dependencies even if creation response was interrupted', async () => {
  for (const interrupted of [false, true]) {
    const harness = arrivalHarness()
    if (interrupted) {
      harness.state.overrides.create = () => { throw new Error('ECONNRESET') }
      await assert.rejects(harness.run(), /ECONNRESET/)
    } else {
      await harness.run()
    }
    const notice = harness.caseRecord.fixtures.find((item) => item.kind === 'arrivalNotice')
    assert.equal(notice.createAttempted, true)
    assert.equal(notice.id, interrupted ? undefined : ids.notice)
    // Prove the ASN itself protects its dependencies, without relying on another formal kind.
    harness.caseRecord.fixtures = harness.caseRecord.fixtures.filter((item) =>
      !['purchaseOrder', 'purchaseInbound'].includes(item.kind))
    await __internal.cleanupWmsQcFixtures({}, harness.caseRecord, async (_api, record) => {
      assert.deepEqual(record.fixtures, [])
    })
    assert.ok(harness.caseRecord.fixtures.every((item) => item.retained === true))
  }
})

function qc002Harness () {
  const fixture = {
    marker: 'E2E-Q002-GAP-UNIT', token: 'OWNED-Q002-GAP',
    warehouse: { id: '201' }, area: { id: '202' }, location: { id: '203' },
    material: { id: '204', unitId: '205' }
  }
  const caseRecord = {
    checks: [], notes: [], evidence: [],
    fixtures: ['warehouse', 'area', 'location', 'material'].map((kind) =>
      ({ kind, id: fixture[kind].id, token: fixture.token }))
  }
  const pages = [
    {
      route: '/unit-wms/outbound/sales', component: 'wms/stock/out/sell/index',
      billNo: 'WMS-201-SERVER-UNIT', placeholder: '请输入出库单号',
      fields: '出库单号 单据日期 客户 单据阶段'
    },
    {
      route: '/unit-erp/sales/returns', component: 'erp/sale/return/index',
      billNo: 'SALE-RETURN-SERVER-UNIT', placeholder: '请输入退货单号',
      fields: '退货单号 退货类型 客户'
    }
  ]
  const state = { executed: false, failWrite: false, noDeduction: false }
  const calls = []
  const stock = () => ({
    id: '209', materialId: '204', warehouseId: '201',
    qty: state.executed && !state.noDeduction ? 1 : 2,
    availableQty: state.executed && !state.noDeduction ? 0 : 1,
    lockQty: 1, holdQty: 0, frozenQty: 0, pendingPutawayQty: 0
  })
  const api = {
    async postBusiness (path, body) {
      calls.push(['POST', path])
      if (path === '/base/partner/create') return ok('210')
      if (path === '/erp/sale-order/create') return ok('211')
      if (path === '/erp/sale-out/create') {
        state.outbound = structuredClone(body)
        return state.failWrite ? { code: 403, msg: '没有权限' } : ok('213')
      }
      assert.equal(path, '/erp/sale-return/create')
      return ok('217')
    },
    async getBusiness (path) {
      const query = new URL(path, 'http://unit')
      if (query.pathname === '/system/auth/get-permission-info') return ok({
        menus: pages.map(({ route, component }) => ({ path: route, component }))
      })
      if (query.pathname === '/base/partner/get') return ok({ id: '210', remark: fixture.marker })
      if (query.pathname === '/erp/account/page') return ok({ list: [{ id: '218' }] })
      if (query.pathname === '/erp/sale-order/get') return ok({
        id: '211', remark: fixture.marker, status: 20,
        items: [{ id: '212', productId: '204', stockCount: 2 }]
      })
      if (query.pathname === '/mes/stkInventory/list') return ok({ records: [stock()], total: 1 })
      if (query.pathname === '/wms/transfer-bill/page') return ok({
        list: [{ id: '219', transferStatus: 'IN_TRANSIT' }], total: 1
      })
      if (query.pathname === '/wms/transfer-bill/get') return ok({
        id: '219', transferStatus: 'IN_TRANSIT',
        lines: [{ materialId: '204', qty: 1, inPostedQty: 0 }]
      })
      if (query.pathname === '/erp/sale-out/get') return ok({
        ...state.outbound, id: '213', status: 20,
        items: state.outbound.items.map((item) => ({ ...item, id: '214' }))
      })
      if (query.pathname === '/mes/stkIo/list') return ok({
        records: [{ id: '215', billNo: pages[0].billNo, srcBillType: 'ErpSaleOut', srcBillId: '213' }]
      })
      if (query.pathname === '/mes/stkIo/queryById') return ok({
        id: '215', billNo: pages[0].billNo,
        stockIoType: '201', srcBillType: 'ErpSaleOut', srcBillId: '213', isVoided: 0,
        isEffective: state.executed ? 1 : 0, billStage: state.executed ? '34' : '14',
        actions: { execute: !state.executed }
      })
      if (query.pathname === '/mes/stkIo/queryEntryByMainId') return ok([{
        id: '216', mid: '215', srcBillType: 'ErpSaleOut', srcBillId: '213', srcEntryId: '214',
        materialId: '204', warehouseId: '201', stockIoDirection: '2', qty: 1,
        inStockTime: state.executed ? '2026-10-15T10:00:00' : null
      }])
      assert.equal(query.pathname, '/erp/sale-return/get')
      return ok({
        id: '217', billNo: pages[1].billNo,
        srcBillType: 'SalOrder', srcBillId: '211', remark: fixture.marker,
        items: [{ id: '220', srcEntryId: '212' }]
      })
    },
    async putBusiness (path) {
      calls.push(['PUT', path])
      assert.equal(path, '/mes/stkIo/execute')
      state.executed = true
      return ok(true)
    }
  }
  let currentRoute = ''
  let filterValue = ''
  let submittedValue = ''
  const currentPage = () => {
    const spec = pages.find(({ route }) => route === currentRoute)
    assert.ok(spec, `Unexpected QC002 page route: ${currentRoute}`)
    return spec
  }
  const page = {
    url: () => `http://unit${currentRoute}`,
    getByPlaceholder: (placeholder, options) => {
      assert.equal(placeholder, currentPage().placeholder)
      assert.deepEqual(options, { exact: true })
      return {
        fill: async (value) => {
          assert.equal(value, currentPage().billNo)
          filterValue = value
        },
        press: async (key) => {
          assert.equal(key, 'Enter')
          assert.equal(filterValue, currentPage().billNo)
          submittedValue = filterValue
        }
      }
    },
    getByText: (value, options) => {
      assert.equal(value, currentPage().billNo)
      assert.deepEqual(options, { exact: true })
      return { value, ...options }
    },
    locator: (selector) => {
      if (selector === 'body') return {
        innerText: async () => {
          assert.equal(submittedValue, currentPage().billNo)
          return `${currentPage().fields} ${submittedValue}`
        }
      }
      assert.equal(selector, '.vxe-body--row, .el-table__row')
      return {
        filter: (match) => {
          assert.deepEqual(match, { has: { value: currentPage().billNo, exact: true } })
          return { first: () => ({
            waitFor: async (options) => {
              assert.equal(submittedValue, currentPage().billNo)
              assert.deepEqual(options, { state: 'visible', timeout: 30000 })
              calls.push(['PAGE-ROW', currentRoute, submittedValue])
            }
          }) }
        }
      }
    }
  }
  const dependencies = {
    createQualityArtifacts: async (_api, _record, _fixture, _material, type) => {
      assert.equal(type, '201')
      calls.push(['ARTIFACT', '201'])
      return { plan: { planId: '301' }, item: { itemId: '302' } }
    },
    verifyWmsQcOutboundClosure: async (...args) => {
      calls.push(['OQC', 'verifyWmsQcOutboundClosure'])
      return __internal.executeWmsStockBillWhenNeeded(...args.slice(0, 6))
    },
    openRoute: async (_page, route, options) => {
      currentRoute = route
      filterValue = ''
      submittedValue = ''
      assert.deepEqual(options, {
        readySelector: `input[placeholder="${currentPage().placeholder}"]`, readyText: undefined
      })
    },
    saveScreenshot: async (_page, _outputDir, name) => `/tmp/${name}.png`
  }
  const run = () => __internal.runQc002(api, page, {}, caseRecord, '/tmp/unit',
    dependencies, fixture, { id: '221' })
  return { run, caseRecord, state, calls }
}

test('QC002 delegates OQC before execution but keeps unexecuted multiline and mocked OQC evidence as GAP', async () => {
  const { run, caseRecord, calls } = qc002Harness()
  assert.equal((await run()).partial, true)
  assert.ok(caseRecord.checks.length > 0)
  assert.ok(caseRecord.checks.every((check) => check.passed))
  assert.deepEqual(caseRecord.contractGaps.map(({ key, status }) => ({ key, status })), [
    { key: 'multi-line-partial-execution', status: 'GAP' }
  ])
  assert.match(caseRecord.contractGaps[0].reason, /按行部分执行.*未执行.*仅创建一条/)
  assert.ok(calls.findIndex(([method]) => method === 'ARTIFACT') <
    calls.findIndex(([, path]) => path === '/erp/sale-out/create'))
  assert.equal(calls.filter(([method]) => method === 'OQC').length, 1)
  mapWmsQcCatalogAssertions(caseRecord, 'WMS-QC-002')
  const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const original = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'WMS-QC-002')
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.assertion), original.assertions)
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.status),
    ['VERIFIED', 'VERIFIED', 'GAP', 'GAP', 'GAP'])
  assert.equal(caseRecord.passCandidate, false)
})

test('QC002 real request and inventory failures are still failures, not deferred GAPs', async () => {
  for (const failure of ['failWrite', 'noDeduction']) {
    const harness = qc002Harness()
    harness.state[failure] = true
    await assert.rejects(harness.run(), failure === 'failWrite' ? /403/ : /库存扣减/)
    assert.equal(harness.caseRecord.contractGaps, undefined)
    assert.equal(harness.calls.some(([, path]) => path === '/erp/sale-return/create'), false)
    if (failure === 'noDeduction') {
      assert.equal(harness.caseRecord.checks.find((check) =>
        check.name === '正式销售出库后专属可用库存按行扣减').passed, false)
    }
  }
})
