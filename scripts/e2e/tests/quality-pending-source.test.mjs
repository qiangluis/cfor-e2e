import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertOwnedIqcDraft,
  assertOwnedDeliveredSalesSource,
  assertOwnedPendingWmsDraft,
  assertOwnedSalesReturnBatchOption,
  assertPendingPermissions,
  assertPublishedIqcPlan,
  approveQualityPendingPurchaseOrder,
  buildQualityPendingSalesReturnPayload,
  pendingRows,
  prepareQualityPendingIqcSource,
  prepareQualityPendingSalesSource,
  prepareQualityPendingProductionSources,
  qualityPendingPurchaseApprovalStages,
  cleanupQualityPendingSalesSource,
  QUALITY_PENDING_SOURCE_GAPS,
  verifyPendingAccess
} from '../fixtures/quality-pending-source.mjs'

const ok = (data) => ({ code: 0, data })
const record = () => ({ notes: [], evidence: [], checks: [] })
const info = {
  user: { id: '1', username: 'admin' },
  roles: ['super_admin'],
  permissions: ['mes:quality-pending:query']
}
const env = {
  CFOR_QUALITY_PENDING_PREPARE_IQC: 'true',
  CFOR_E2E_WRITE_FIXTURES: 'true',
  CFOR_E2E_ENABLE_QUALITY_PENDING_CLOSURE: 'true',
  CFOR_QUALITY_PENDING_CONFIRM: 'QUALITY-PENDING-001'
}
const access = { info, userId: '1', mode: 'existing-super-admin' }
const approvalSettings = {
  purchaseApproverUsername: 'purchase-test', purchaseApproverPassword: 'unit-only-purchase',
  financeApproverUsername: 'finance-test', financeApproverPassword: 'unit-only-finance',
  finalApproverUsername: 'final-test', finalApproverPassword: 'unit-only-final'
}
const workflowDecision = {
  tenantId: 1, mode: 'WORKFLOW', processDefinitionKey: 'erp-purchase-order-approval'
}
const processId = '7a5311b4-bfc6-11f1-89c9-ce1b36cb2521'
const plan = { id: '8', type: 101, planCode: 'QP-OWNED', versionNo: 1, publishStatus: 1 }
const binding = {
  id: '9', materialId: '2', planId: '8', type: '101', isDefault: true,
  effectiveFrom: '2026-01-01', effectiveTo: null
}

function sourceHarness ({
  configData = 'true', mode = 'NONE', effective = 1,
  processDefinitionKey = 'erp-purchase-order-approval'
} = {}) {
  const events = []
  let marker
  let order
  let notice
  let detail
  let entries
  const dependencies = {
    prepareWmsFixture: async () => {
      events.push('master-write')
      return {
        token: 'owned-master-token', material: { id: '2' }, unit: { id: '3' },
        warehouse: { id: '4' }, area: { id: '5' }, location: { id: '6' }
      }
    },
    createPublishedItem: async () => {
      events.push('item-write')
      return { itemId: '7', token: 'item-token', row: { publishStatus: 1 } }
    },
    createPlan: async (_api, _record, options) => {
      events.push(['plan-write', options])
      assert.equal(options.publish, true)
      assert.equal(options.type, 101)
      assert.ok(options.subOverrides.remark.length <= 32)
      return { planId: '8', token: 'full-parent-token', row: plan }
    },
    createQualityMaterialRule: async () => {
      events.push('binding-write')
      return { ruleId: '9', row: binding }
    }
  }
  const api = {
    getBusiness: async (path) => {
      events.push(['GET', path])
      if (path.startsWith('/system/config/get')) return ok({ configData })
      if (path.startsWith('/base/partner/get')) return ok({ id: '10', remark: marker, supplierEnabled: true })
      if (path.startsWith('/erp/purchase-order/get')) return ok(order)
      if (path.startsWith('/mes/wms/arrival-notice/get')) return ok(notice)
      if (path.startsWith('/mes/stkIo/queryById')) return ok(detail)
      if (path.startsWith('/mes/stkIo/queryEntryByMainId')) return ok(entries)
      throw Error(`Unexpected GET ${path}`)
    },
    postBusiness: async (path, body) => {
      events.push(['POST', path, body])
      if (path === '/bpm/approval-policy/preview') return ok({ tenantId: 1, mode, processDefinitionKey })
      if (path === '/base/partner/create') {
        marker = body.remark
        return ok('10')
      }
      if (path === '/erp/purchase-order/create') {
        assert.equal(body.directCreate, 1)
        assert.ok(body.directCreateReason)
        assert.equal(body.items[0].count, 1)
        assert.equal(body.status, undefined)
        order = { ...body, id: '11', isEffective: effective, isVoided: 0,
          items: [{ ...body.items[0], id: '12' }] }
        return ok('11')
      }
      if (path === '/mes/wms/arrival-notice/create') {
        notice = { ...body, id: '13', status: 0,
          lines: [{ ...body.lines[0], id: '14', receivedQuantity: 0 }] }
        return ok('13')
      }
      if (path.startsWith('/mes/wms/arrival-notice/submit')) {
        notice.status = 10
        return ok(true)
      }
      if (path.startsWith('/mes/wms/arrival-notice/create-receipt-bill')) {
        assert.equal(body[0].qualifiedQuantity, null)
        assert.equal(body[0].receivedQuantity, 1)
        detail = {
          id: '15', stockIoType: '101', srcBillType: 'MesWmsArrivalNotice', srcBillId: '13',
          srcNo: notice.code, billStage: '12', isEffective: 0, isVoided: 0, isQc: 0, supplierId: '10'
        }
        entries = [{
          id: '16', mid: '15', srcBillType: 'MesWmsArrivalNotice', srcBillId: '13', srcEntryId: '14',
          materialId: '2', unitId: '3', warehouseId: '4', wareAreaId: '5', wareLocationId: '6',
          batchNo: `${marker}-BATCH`, qty: 1, isQc: 1
        }]
        return ok('15')
      }
      throw Error(`Unexpected POST ${path}`)
    }
  }
  return { api, dependencies, events, snapshot: () => ({ detail, entries, notice, order }) }
}

test('IQC source prepares only formal purchase -> submitted ASN -> type101 draft', async () => {
  const h = sourceHarness()
  const ledger = {}
  const result = await prepareQualityPendingIqcSource({
    api: h.api, dependencies: h.dependencies, caseRecord: record(), ledger, access, env
  })
  assert.equal(ledger.sourceId, '15')
  assert.equal(ledger.sourceEntryId, '16')
  assert.equal(result.source.detail.billStage, '12')
  assert.equal(result.source.entry.isQc, 1)
  assert.equal(result.plan.version, 1)
  const paths = h.events.filter(Array.isArray).map(event => event[1])
  assert.ok(!paths.some(path => typeof path === 'string' && /update-status|stkIo\/add|config\/save|pending-inspect/.test(path)))
  assert.equal(h.events[0][0], 'GET')
  assert.equal(h.events[1][1], '/bpm/approval-policy/preview')
})

test('additional pending source builders reject missing explicit confirmation before any writes', async () => {
  for (const prepare of [prepareQualityPendingSalesSource, prepareQualityPendingProductionSources]) {
    let called = false
    await assert.rejects(prepare({
      api: { getBusiness: async () => { called = true } }, record: record(), caseRecord: record(),
      access, owned: {}, env: { ...env, CFOR_QUALITY_PENDING_CONFIRM: 'OTHER' }
    }), /完整写侧确认/)
    assert.equal(called, false)
  }
})

test('unconfirmed return and quality-plan execution sources remain explicit contract gaps', () => {
  assert.match(QUALITY_PENDING_SOURCE_GAPS.SALES_RETURN, /ErpSaleOut\/201/)
  assert.match(QUALITY_PENDING_SOURCE_GAPS.SALES_RETURN, /SalOrder\/201/)
  assert.match(QUALITY_PENDING_SOURCE_GAPS.SALES_RETURN, /isQc=0/)
  assert.match(QUALITY_PENDING_SOURCE_GAPS.QUALITY_PLAN, /已发布质检方案不是执行来源/)
})

const salesReturnBatchContext = {
  orderItemId: '21',
  materialId: '22',
  saleOutWmsId: '23',
  saleOutWmsEntryId: '24',
  warehouseId: '25',
  areaId: '26',
  locationId: '27',
  unitId: '28',
  saleOutWmsBillNo: 'E2E-QP-SALE-201',
  batchNo: 'E2E-QP-SALE-BATCH',
  quantity: 1
}

const salesReturnBatch = {
  saleOrderItemId: '21',
  materialId: '22',
  unitId: '28',
  srcStkIoId: '23',
  srcStkIoEntryId: '24',
  warehouseId: '25',
  wareAreaId: '26',
  wareLocationId: '27',
  batchNo: 'E2E-QP-SALE-BATCH',
  availableQty: 1,
  billNo: 'E2E-QP-SALE-201'
}

function deliveredSalesSnapshot () {
  const context = {
    ...salesReturnBatchContext, marker: 'E2E-QP-RQC-OWNED', customerId: '10',
    saleOrderId: '11', saleOutId: '30', saleOutItemId: '31'
  }
  const item = {
    productId: '22', productUnitId: '28', count: 1, productPrice: 10, taxPercent: 0
  }
  const dimensions = {
    materialId: '22', warehouseId: '25', wareAreaId: '26', wareLocationId: '27',
    batchNo: context.batchNo
  }
  const stock = {
    id: '32', ...dimensions, qty: 1, availableQty: 1, lockQty: 0, holdQty: 0,
    frozenQty: 0, pendingPutawayQty: 0
  }
  return {
    context,
    order: {
      id: '11', remark: context.marker, customerId: '10', isEffective: 1, isVoided: 0,
      saleTypeCode: 'NORMAL', items: [{ ...item, id: '21' }]
    },
    saleOut: {
      id: '30', no: 'FORMAL-SALE-OUT-30', remark: context.marker,
      customerId: '10', orderId: '11', businessType: 'NORMAL', status: 20,
      totalCount: 1, totalPrice: 10, discountPercent: 0, otherPrice: 0,
      items: [{ ...item, id: '31', orderItemId: '21', warehouseId: '25' }]
    },
    detail: {
      id: '23', billNo: 'E2E-QP-SALE-201', stockIoType: '201',
      srcBillType: 'ErpSaleOut', srcBillId: '30', srcNo: 'FORMAL-SALE-OUT-30',
      customerId: '10', billStage: '34', isEffective: 1, isVoided: 0
    },
    entries: [{
      id: '24', mid: '23', ...dimensions, unitId: '28', qty: 1,
      srcBillType: 'ErpSaleOut', srcBillId: '30', srcEntryId: '31', stockIoDirection: '2',
      inStockTime: '2026-10-13 13:30:00'
    }],
    inventoryBefore: [stock],
    inventoryAfter: [{ ...stock, qty: 0, availableQty: 0 }]
  }
}

function salesReturnPayloadOptions () {
  const delivery = deliveredSalesSnapshot()
  return {
    ...delivery.context, accountId: '29', batchOptions: [salesReturnBatch], delivery
  }
}

test('delivered sales source uses ERP no/status and exact order -> sale-out -> executed WMS line linkage', () => {
  const input = deliveredSalesSnapshot()
  const result = assertOwnedDeliveredSalesSource(input)
  assert.equal(result.deliveredQty, 1)
  assert.equal(input.saleOut.billNo, undefined)
  assert.equal(input.saleOut.isEffective, undefined)
  assert.equal(result.entry.srcEntryId, input.saleOut.items[0].id)
  assert.notEqual(result.entry.srcEntryId, input.order.items[0].id)
  assert.equal(result.inventoryBefore[0].availableQty, 1)
  assert.equal(result.inventoryAfter[0].availableQty, 0)
  assert.equal(assertOwnedDeliveredSalesSource({
    ...input, inventoryAfter: []
  }).deliveredQty, 1)
})

test('delivered sales source rejects draft, opening, foreign and unexecuted source chains', () => {
  for (const change of [
    input => { input.context.marker = 'SHARED' },
    input => { input.order.remark = 'SHARED' },
    input => { input.order.isEffective = 0 },
    input => { input.order.isVoided = null },
    input => { input.order.items[0].id = '999' },
    input => { input.order.items[0].productUnitId = '999' },
    input => { input.saleOut.remark = 'SHARED' },
    input => { input.saleOut.orderId = '999' },
    input => { input.saleOut.customerId = '999' },
    input => { input.saleOut.businessType = 'OPENING' },
    input => { input.saleOut.status = 10 },
    input => { input.saleOut.no = undefined; input.saleOut.billNo = 'NOT-THE-ERP-CONTRACT' },
    input => { input.saleOut.items[0].orderItemId = '999' },
    input => { input.saleOut.items[0].count = 2 },
    input => { input.saleOut.items[0].productPrice = 11 },
    input => { input.saleOut.items[0].taxPercent = 5 },
    input => { input.saleOut.discountPercent = 5 },
    input => { input.detail.srcBillType = 'SalOrder' },
    input => { input.detail.srcBillId = '11' },
    input => { input.detail.srcNo = 'OTHER' },
    input => { input.detail.billStage = '24' },
    input => { input.detail.isEffective = 0 },
    input => { input.detail.isVoided = 1 },
    input => { input.entries = [] },
    input => { input.entries.push(structuredClone(input.entries[0])) },
    input => { input.entries[0].srcEntryId = '21' },
    input => { input.entries[0].unitId = '999' },
    input => { input.entries[0].stockIoDirection = '1' },
    input => { input.entries[0].wareLocationId = '999' },
    input => { input.entries[0].batchNo = 'OTHER' },
    input => { input.entries[0].inStockTime = null },
    input => { input.entries[0].inStockTime = 'invalid' }
  ]) {
    const input = deliveredSalesSnapshot()
    change(input)
    assert.throws(() => assertOwnedDeliveredSalesSource(input), /BLOCKED/)
  }
})

test('delivered sales source requires complete conserved inventory 1 -> 0, never an empty baseline', () => {
  for (const change of [
    input => { input.inventoryBefore = [] },
    input => { input.inventoryBefore = undefined },
    input => { input.inventoryAfter = undefined },
    input => { input.inventoryBefore.push(structuredClone(input.inventoryBefore[0])) },
    input => { input.inventoryBefore[0].warehouseId = '999' },
    input => { input.inventoryAfter[0].batchNo = 'OTHER' },
    input => { input.inventoryAfter[0].id = '999' },
    input => { input.inventoryBefore[0].pendingPutawayQty = undefined },
    input => { input.inventoryBefore[0].qty = 2 },
    input => { input.inventoryBefore[0].availableQty = 0; input.inventoryBefore[0].lockQty = 1 },
    input => { input.inventoryAfter[0].qty = 1; input.inventoryAfter[0].holdQty = 1 }
  ]) {
    const input = deliveredSalesSnapshot()
    change(input)
    assert.throws(() => assertOwnedDeliveredSalesSource(input), /BLOCKED/)
  }
  for (const value of [null, '', ' ', true, NaN, Infinity, 'Infinity', '-1', '1e0']) {
    const input = deliveredSalesSnapshot()
    input.inventoryBefore[0].qty = value
    assert.throws(() => assertOwnedDeliveredSalesSource(input), /BLOCKED/)
  }
})

test('sales return candidate requires the exact delivered 201 WMS batch and positive return quantity', () => {
  assert.equal(assertOwnedSalesReturnBatchOption({
    options: [salesReturnBatch], context: salesReturnBatchContext
  }), salesReturnBatch)
  for (const change of [
    { options: [] },
    { options: [{ ...salesReturnBatch, srcStkIoId: '999' }] },
    { options: [{ ...salesReturnBatch, srcStkIoEntryId: '999' }] },
    { options: [{ ...salesReturnBatch, unitId: '999' }] },
    { options: [{ ...salesReturnBatch, batchNo: 'OTHER' }] },
    { options: [{ ...salesReturnBatch, billNo: 'OTHER' }] },
    { options: [{ ...salesReturnBatch, availableQty: 0 }] },
    { options: [{ ...salesReturnBatch }, { ...salesReturnBatch }] }
  ]) {
    assert.throws(() => assertOwnedSalesReturnBatchOption({
      options: change.options ?? [salesReturnBatch],
      context: salesReturnBatchContext
    }), /BLOCKED/)
  }
})

test('sales return batch aliases must agree and every returnable quantity must be finite single-piece data', () => {
  const alias = { ...salesReturnBatch, orderItemId: '21' }
  delete alias.saleOrderItemId
  assert.equal(assertOwnedSalesReturnBatchOption({
    options: [alias], context: salesReturnBatchContext
  }), alias)
  assert.throws(() => assertOwnedSalesReturnBatchOption({
    options: [{ ...salesReturnBatch, orderItemId: '999' }], context: salesReturnBatchContext
  }), /别名冲突/)
  assert.throws(() => assertOwnedSalesReturnBatchOption({
    options: [salesReturnBatch, { ...salesReturnBatch, availableQty: 0 }],
    context: salesReturnBatchContext
  }), /唯一可退/)
  for (const value of [0, -1, 0.5, 2, null, '', ' ', true, NaN, Infinity, 'Infinity', '1e0']) {
    assert.throws(() => assertOwnedSalesReturnBatchOption({
      options: [{ ...salesReturnBatch, availableQty: value }], context: salesReturnBatchContext
    }), /BLOCKED/)
    assert.throws(() => assertOwnedSalesReturnBatchOption({
      options: [salesReturnBatch], context: { ...salesReturnBatchContext, quantity: value }
    }), /BLOCKED/)
  }
  for (const options of [undefined, null, { list: [] }, { code: 0, data: [] }]) {
    assert.throws(() => assertOwnedSalesReturnBatchOption({
      options, context: salesReturnBatchContext
    }), /不是正式数组/)
  }
})

test('sales return payload retains the exact delivered batch and source order line', () => {
  const result = buildQualityPendingSalesReturnPayload(salesReturnPayloadOptions())
  assert.equal(result.batch, salesReturnBatch)
  assert.equal(result.payload.srcBillType, 'SalOrder')
  assert.equal(result.payload.srcBillId, '11')
  assert.equal(result.payload.items[0].srcEntryId, '21')
  assert.equal(result.payload.items[0].batchNo, salesReturnBatch.batchNo)
  assert.equal(result.payload.items[0].count, 1)
  assert.equal(result.payload.items[0].totalPrice, 10)
  assert.equal(result.payload.items[0].productTotalPrice, 10)
  assert.equal(result.payload.items[0].taxPercent, 0)
  assert.equal(result.payload.items[0].warehouseId, '25')
  assert.equal(result.payload.items[0].areaHouseId, '26')
  assert.equal(result.payload.items[0].wareLocationId, '27')
  assert.equal(result.payload.items[0].productUnitId, '28')
})

test('sales return payload preparation cannot bypass missing delivery, batches, ownership or single-piece pricing', () => {
  const options = salesReturnPayloadOptions()
  assert.throws(() => buildQualityPendingSalesReturnPayload({
    ...options, delivery: undefined
  }), /BLOCKED/)
  assert.throws(() => buildQualityPendingSalesReturnPayload({
    ...options, batchOptions: []
  }), /BLOCKED/)
  assert.throws(() => buildQualityPendingSalesReturnPayload({
    ...options, marker: 'SHARED'
  }), /BLOCKED/)
  assert.throws(() => buildQualityPendingSalesReturnPayload({
    ...options, unitId: '999'
  }), /BLOCKED/)
  for (const quantity of [0, -1, 2, 0.5, null, '', true, NaN, Infinity]) {
    assert.throws(() => buildQualityPendingSalesReturnPayload({
      ...options, quantity
    }), /BLOCKED/)
  }
})

test('sales return payload preparation does not invent a successful RQC source or QC execution flags', () => {
  const result = buildQualityPendingSalesReturnPayload(salesReturnPayloadOptions())
  for (const field of ['isQc', 'needQc', 'isEffective', 'billStage', 'stockIoType', 'qcType']) {
    assert.equal(result.payload[field], undefined)
    assert.equal(result.payload.items[0][field], undefined)
  }
  assert.equal(result.source, undefined)
  assert.equal(result.pendingQty, undefined)
  assert.match(QUALITY_PENDING_SOURCE_GAPS.SALES_RETURN, /needQc=false/)
  assert.match(QUALITY_PENDING_SOURCE_GAPS.SALES_RETURN, /非本轮API实测/)
  assert.match(QUALITY_PENDING_SOURCE_GAPS.SALES_RETURN, /旧201负数统计/)
  assert.match(QUALITY_PENDING_SOURCE_GAPS.SALES_RETURN, /不得以空批次、手工302或待检直登/)
})

test('additional pending WMS drafts prove exact upstream line, owned dimensions and need-QC flag', () => {
  const context = {
    sourceId: '20', type: '201', sourceType: 'SalOrder', upstreamId: '21',
    upstreamEntryId: '22', materialId: '23', unitId: '24',
    warehouseId: '25', areaId: '26', locationId: '27', marker: 'E2E-QP-OWNED', batchNo: 'OWNED-BATCH'
  }
  const detail = { id: '20', stockIoType: '201', srcBillType: 'SalOrder', srcBillId: '21',
    remark: context.marker, billStage: '12', isEffective: 0, isVoided: 0, billNo: 'OWNED-201' }
  const entry = { id: '28', mid: '20', srcBillType: 'SalOrder', srcBillId: '21',
    srcEntryId: '22', materialId: '23', unitId: '24', warehouseId: '25', wareAreaId: '26',
    wareLocationId: '27', batchNo: 'OWNED-BATCH', qty: 1, isQc: 1 }
  const result = assertOwnedPendingWmsDraft({ detail, entries: [entry], context })
  assert.equal(result.pendingQty, 1)
  for (const change of [
    { detail: { ...detail, isEffective: 1 } }, { detail: { ...detail, remark: 'SHARED' } },
    { detail: { ...detail, stockIoType: '106' } }, { detail: { ...detail, srcBillId: '999' } },
    { entries: [] }, { entries: [entry, entry] },
    { entries: [{ ...entry, srcEntryId: '999' }] },
    { entries: [{ ...entry, isQc: 0 }] }, { entries: [{ ...entry, qty: 2 }] },
    { entries: [{ ...entry, batchNo: 'SHARED-BATCH' }] },
    { entries: [{ ...entry, warehouseId: '999' }] }
  ]) assert.throws(() => assertOwnedPendingWmsDraft({ detail, entries: [entry], context, ...change }), /BLOCKED/)
})

function additionalSourceHarness () {
  const events = []
  let marker
  let order
  let detail
  let entries
  let planType
  const api = {
    async getBusiness(path) {
      events.push(['GET', path])
      if (path.startsWith('/base/partner/get')) return ok({ id: '10', remark: marker, customerEnabled: true })
      if (path.startsWith('/erp/sale-order/get')) return ok(order)
      if (path.startsWith('/mes/stkIo/list')) return ok([detail])
      if (path.startsWith('/mes/stkIo/queryById')) return ok(detail)
      if (path.startsWith('/mes/stkIo/queryEntryByMainId')) return ok(entries)
      if (path.startsWith('/mes/quality/qualityInspection/list')) {
        return ok([{ id: '39', type: '300', srcBillId: '38', inspectionPlan: '8', isEffective: 0 }])
      }
      if (path.startsWith('/mes/quality/qualityInspection/queryById')) {
        return ok({ id: '39', type: '300', srcBillId: '38', inspectionPlan: '8', isEffective: 0 })
      }
      if (path.startsWith('/mes/prodWork/returnProdOrderMsg')) {
        return ok([{ orderId: '35', orderEntryId: '35', materialId: '2', orderNo: 'WORK-OWNED', orderQty: 2 }])
      }
      throw Error(`unexpected ${path}`)
    },
    async postBusiness(path, body) {
      events.push(['POST', path, body])
      if (path === '/base/partner/create') { marker = body.remark; return ok('10') }
      if (path === '/erp/sale-order/create') {
        order = { ...body, id: '11', isVoided: 0, items: [{ ...body.items[0], id: '12' }] }
        assert.equal(body.status, undefined)
        return ok('11')
      }
      if (path === '/mes/stkIo/add/save') {
        assert.equal(body.isEffective, undefined)
        assert.equal(body.stockIoType, planType)
        detail = { ...body, id: '15', billStage: '12', isEffective: 0, isVoided: 0 }
        entries = [{ ...body.stkIoEntryList[0], id: '16', mid: '15' }]
        return ok('saved')
      }
      throw Error(`unexpected ${path}`)
    }
  }
  const dependencies = {
    prepareWmsFixture: async () => ({
      token: 'E2E-QP-MASTER', material: { id: '2' }, unit: { id: '3' },
      warehouse: { id: '4' }, area: { id: '5' }, location: { id: '6' }
    }),
    createPublishedItem: async () => ({ itemId: '7', row: { publishStatus: 1 } }),
    createPlan: async (_api, _record, options) => {
      planType = String(options.type)
      assert.ok(options.subOverrides.remark.length <= 32)
      return { planId: '8', row: { id: '8', type: options.type, publishStatus: 1, planCode: 'QP-OWNED', versionNo: 1 } }
    },
    createQualityMaterialRule: async (_api, _record, options) => ({
      ruleId: '9', row: { ...options, id: '9' }
    }),
    createOpeningInventory: async (_api, _record, _fixture, material, unit, qty) => {
      events.push(['OPENING', material.id, unit, qty])
      return { id: '17', approved: true, batchNo: 'E2E-QP-OWNED-BATCH' }
    },
    readSql: async () => ({ available: true, rows: [['18', '1.000000', '1.000000']] })
  }
  return { api, dependencies, events }
}

test('sales pending source uses a real order, real owned stock and saved need-QC draft without shared config writes', async () => {
  const h = additionalSourceHarness()
  const owned = {}
  const result = await prepareQualityPendingSalesSource({
    ...h, access, env, caseRecord: record(), owned
  })
  assert.equal(result.sourceBillId, '15')
  assert.equal(result.sourceEntryId, '16')
  assert.equal(result.sourceScene, 'SALES_OUTBOUND')
  assert.equal(result.qcType, 'OQC')
  assert.equal(result.source.entry.srcEntryId, '12')
  assert.equal(result.context.opening.id, '17')
  assert.ok(h.events.find(event => event[0] === 'OPENING'))
  assert.ok(!h.events.some(event => /config|execute|update-status|add\/submit/.test(String(event[1]))))
})

test('sales pending source cannot register when the available-stock readback is absent or non-owned', async () => {
  for (const rows of [[], [['18', '1', '0']], [['18', '2', '2']], [['18', '1', '1'], ['19', '1', '1']]]) {
    const h = additionalSourceHarness()
    h.dependencies.readSql = async () => ({ available: true, rows })
    await assert.rejects(prepareQualityPendingSalesSource({
      ...h, access, env, caseRecord: record(), owned: {}
    }), /可用库存前态/)
    assert.ok(!h.events.some(event => event[1] === '/mes/stkIo/add/save'))
  }
})

test('production pending sources reuse formal plan-work-task-report fixture and source API for 104', async () => {
  const h = additionalSourceHarness()
  class FormalFixture {
    constructor(_api, _record, caseId, options) {
      assert.equal(caseId, 'QUALITY-PENDING-001')
      assert.deepEqual(options, { withOpeningInventory: true, withQuality: true, withFeed: false })
      this.marker = 'AUTOTEST-QUALITY-PENDING-001-OWNED'
      this.shortCode = 'AT-QP-OWNED'
      this.material = { id: '2' }
      this.unit = { id: '3' }
      this.warehouse = { id: '4' }
      this.area = { id: '5' }
      this.location = { id: '6' }
      this.order = { id: '34' }
      this.works = [{ id: '35', batchNo: 'OWNED' }]
      this.procedure = { id: '36' }
      this.tasks = [{ id: '37' }]
      this.outputIds = []
    }
    async setup() { await this.createQualityConfiguration() }
    async startWork() { h.events.push(['START', '35']) }
    async reportTask(options) {
      assert.deepEqual(options, { qty: 1, qualifiedQty: 1, defectQty: 0 })
      return { id: '38', reportCode: 'REPORT-OWNED', billType: 'MesProdWorkReport',
        materialId: '2', workTaskId: '37', reportNum: 1, isEffective: 0 }
    }
  }
  h.dependencies.ExecutionWorkflowFixture = FormalFixture
  const owned = {}
  const results = await prepareQualityPendingProductionSources({
    ...h, access, env, caseRecord: record(), record: record(), owned
  })
  assert.deepEqual(results.map(row => row.sourceScene), ['PROCESS_INSPECTION', 'PRODUCTION_INBOUND'])
  assert.equal(results[0].sourceBillType, 'MesProdWorkReport')
  assert.equal(results[0].sourceEntryId, '38')
  assert.equal(results[1].source.entry.srcEntryId, '35')
  assert.equal(results[1].source.detail.stockIoType, '104')
  assert.equal(owned.process.context.inspectionId, '39')
})

test('sales cleanup refuses a foreign opening before any reversal API write', async () => {
  let writes = 0
  await assert.rejects(cleanupQualityPendingSalesSource({
    api: {
      getBusiness: async () => ok({ id: '17', stockIoType: '106', remark: 'SHARED' }),
      putBusiness: async () => { writes++ }
    },
    caseRecord: record(),
    owned: { context: { opening: { id: '17' }, fixture: { token: 'E2E-OWNED' } } }
  }), /所有权/)
  assert.equal(writes, 0)
})

test('IQC source blocks missing confirmation before any API call or master write', async () => {
  const h = sourceHarness()
  await assert.rejects(prepareQualityPendingIqcSource({
    api: h.api, dependencies: h.dependencies, caseRecord: record(), ledger: {}, access,
    env: { ...env, CFOR_QUALITY_PENDING_CONFIRM: 'OTHER' }
  }), /BLOCKED/)
  assert.deepEqual(h.events, [])
})

test('IQC source parses malformed requisition config fail-closed before writes', async () => {
  const h = sourceHarness({ configData: '{"enabled":"maybe"}' })
  await assert.rejects(prepareQualityPendingIqcSource({
    api: h.api, dependencies: h.dependencies, caseRecord: record(), ledger: {}, access, env
  }), /BLOCKED/)
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0][0], 'GET')
})

test('IQC source blocks ordinary missing direct-create permission before masters', async () => {
  const h = sourceHarness()
  const ordinary = {
    info: { user: { id: '2', username: 'ordinary' }, roles: ['ordinary'],
      permissions: ['wms:arrival-notice:query', 'wms:arrival-notice:create',
        'wms:arrival-notice:submit', 'wms:arrival-notice:receipt', 'base:partner:create',
        'base:partner:query', 'system:config:query'] }
  }
  await assert.rejects(prepareQualityPendingIqcSource({
    api: h.api, dependencies: h.dependencies, caseRecord: record(), ledger: {}, access: ordinary, env
  }), /direct-create/)
  assert.equal(h.events.length, 1)
})

for (const change of [
  { mode: 'UNKNOWN' },
  { mode: 'WORKFLOW', processDefinitionKey: 'other-unverified-flow' },
  { mode: 'WORKFLOW', settings: { ...approvalSettings, financeApproverPassword: '' } }
]) {
  test(`IQC source blocks unverified approval contract ${JSON.stringify({
    mode: change.mode, processDefinitionKey: change.processDefinitionKey,
    missingCredential: Boolean(change.settings)
  })} before any business writes`, async () => {
    const h = sourceHarness(change)
    await assert.rejects(prepareQualityPendingIqcSource({
      api: h.api, dependencies: h.dependencies, caseRecord: record(), ledger: {}, access, env,
      settings: change.settings || approvalSettings
    }), /BLOCKED/)
    assert.equal(h.events.length, 2)
  })
}

test('IQC source awaits actual purchase approval and rereads effective ownership before creating ASN', async () => {
  const h = sourceHarness({ mode: 'WORKFLOW', effective: 0 })
  const runRecord = { api: [] }
  let approvals = 0
  const result = await prepareQualityPendingIqcSource({
    api: h.api, caseRecord: record(), ledger: {}, access, env,
    settings: approvalSettings, record: runRecord,
    dependencies: {
      ...h.dependencies,
      approveOrder: async (args) => {
        approvals++
        assert.equal(args.record, runRecord)
        assert.deepEqual(args.decision, workflowDecision)
        assert.equal(args.order.id, '11')
        assert.equal(h.snapshot().notice, undefined)
        h.snapshot().order.isEffective = 1
      }
    }
  })
  assert.equal(approvals, 1)
  assert.equal(result.context.orderId, '11')
  assert.equal(result.source.detail.stockIoType, '101')
})

test('IQC source never creates ASN when the real approval helper fails or leaves the order ineffective', async () => {
  for (const reject of [true, false]) {
    const h = sourceHarness({ mode: 'WORKFLOW', effective: 0 })
    await assert.rejects(prepareQualityPendingIqcSource({
      api: h.api, caseRecord: record(), ledger: {}, access, env, settings: approvalSettings,
      dependencies: {
        ...h.dependencies,
        approveOrder: async () => {
          if (reject) throw Error('actual approval failed')
          return ok(true)
        }
      }
    }), reject ? /actual approval failed/ : /采购订单未由既有正式策略生效/)
    assert.equal(h.snapshot().notice, undefined)
  }
})

function purchaseApprovalHarness ({ mode = 'WORKFLOW', existingProcess = true } = {}) {
  const events = []
  const order = {
    id: '11', supplierId: '10', remark: 'E2E-QP-OWNED',
    status: 0, billStage: existingProcess ? '22' : '14',
    isEffective: 0, isVoided: 0, processInstanceId: existingProcess ? processId : null
  }
  const original = structuredClone(order)
  const api = {
    getBusiness: async path => {
      events.push(['GET', path])
      assert.equal(path, '/erp/purchase-order/get?id=11')
      return ok(structuredClone(order))
    },
    putBusiness: async path => {
      events.push(['PUT', path])
      assert.equal(path, '/erp/purchase-order/update-status?id=11&status=10')
      if (mode === 'MANUAL') {
        Object.assign(order, { status: 20, isEffective: 1, billStage: '24' })
      } else {
        Object.assign(order, { status: 10, processInstanceId: processId, billStage: '22' })
      }
      return ok(true)
    }
  }
  return { api, order, original, events }
}

test('purchase pending approval reuses an existing real BPM and delegates all three exact nodes/accounts', async () => {
  const h = purchaseApprovalHarness()
  const caseRecord = record()
  const runRecord = { api: [] }
  const approved = await approveQualityPendingPurchaseOrder({
    api: h.api, order: h.original, decision: workflowDecision,
    settings: approvalSettings, caseRecord, record: runRecord,
    dependencies: {
      approveWmsProcess: async args => {
        assert.equal(args.processId, processId)
        assert.equal(args.record, runRecord)
        assert.equal(args.caseRecord, caseRecord)
        assert.deepEqual(args.stageApprovers, qualityPendingPurchaseApprovalStages(
          workflowDecision, approvalSettings
        ))
        assert.deepEqual(args.stageApprovers.map(stage => stage.taskDefinitionKey), [
          'FirstApprove_purchase-order', 'SecondApprove_purchase-order', 'FinalApprove_purchase-order'
        ])
        Object.assign(h.order, { status: 20, isEffective: 1, billStage: '24' })
      }
    }
  })
  assert.equal(approved.isEffective, 1)
  assert.equal(h.events.filter(([method]) => method === 'PUT').length, 0)
  assert.match(caseRecord.evidence.at(-1), /existing-formal-bpm/)
})

test('purchase pending approval submits a draft through status=10 before actual BPM completion', async () => {
  const h = purchaseApprovalHarness({ existingProcess: false })
  let approvals = 0
  await approveQualityPendingPurchaseOrder({
    api: h.api, order: h.original, decision: workflowDecision,
    settings: approvalSettings, caseRecord: record(),
    dependencies: {
      approveWmsProcess: async args => {
        approvals++
        assert.equal(args.processId, processId)
        assert.equal(h.events.filter(([method]) => method === 'PUT').length, 1)
        Object.assign(h.order, { status: 20, isEffective: 1, billStage: '24' })
      }
    }
  })
  assert.equal(approvals, 1)
  assert.deepEqual(h.events.filter(([method]) => method === 'PUT'), [
    ['PUT', '/erp/purchase-order/update-status?id=11&status=10']
  ])
})

test('purchase pending MANUAL policy uses the formal submit result, not a forged status or BPM override', async () => {
  const h = purchaseApprovalHarness({ mode: 'MANUAL', existingProcess: false })
  await approveQualityPendingPurchaseOrder({
    api: h.api, order: h.original, decision: { tenantId: 1, mode: 'MANUAL' },
    caseRecord: record(),
    dependencies: {
      approveWmsProcess: async () => { assert.fail('MANUAL must not create a workflow') }
    }
  })
  assert.equal(h.order.isEffective, 1)
  assert.deepEqual(h.events.filter(([method]) => method === 'PUT'), [
    ['PUT', '/erp/purchase-order/update-status?id=11&status=10']
  ])
})

test('purchase pending approval rejects an ineffective, voided or foreign result even if BPM helper returns', async () => {
  for (const change of [
    order => {},
    order => Object.assign(order, { isEffective: 1, status: 10 }),
    order => Object.assign(order, { isEffective: 1, status: 20, isVoided: 1 }),
    order => Object.assign(order, { isEffective: 1, status: 20, remark: 'FOREIGN' }),
    order => Object.assign(order, { isEffective: 1, status: 20, supplierId: '999' })
  ]) {
    const h = purchaseApprovalHarness()
    await assert.rejects(approveQualityPendingPurchaseOrder({
      api: h.api, order: h.original, decision: workflowDecision,
      settings: approvalSettings, caseRecord: record(),
      dependencies: { approveWmsProcess: async () => change(h.order) }
    }), /未生效或所有权不一致/)
  }
})

test('IQC source does not create ASN when NONE preview differs from actual ineffective order', async () => {
  const h = sourceHarness({ effective: 0 })
  await assert.rejects(prepareQualityPendingIqcSource({
    api: h.api, dependencies: h.dependencies, caseRecord: record(), ledger: {}, access, env
  }), /实际未生效/)
  assert.ok(!h.events.some(event => Array.isArray(event) && event[1] === '/mes/wms/arrival-notice/create'))
})

test('IQC source rejects 106, shared ownership, effective source, mismatched chain and batch', async () => {
  const h = sourceHarness()
  const result = await prepareQualityPendingIqcSource({
    api: h.api, dependencies: h.dependencies, caseRecord: record(), ledger: {}, access, env
  })
  const snapshot = h.snapshot()
  for (const change of [
    { detail: { ...snapshot.detail, stockIoType: '106' } },
    { detail: { ...snapshot.detail, isEffective: 1 } },
    { detail: { ...snapshot.detail, srcNo: 'SHARED-HISTORY' } },
    { notice: { ...snapshot.notice, purchaseOrderId: '999' } },
    { entries: [{ ...snapshot.entries[0], batchNo: 'SHARED-BATCH' }] },
    { entries: [...snapshot.entries, snapshot.entries[0]] }
  ]) {
    assert.throws(() => assertOwnedIqcDraft({ ...snapshot, context: result.context, ...change }), /BLOCKED/)
  }
})

test('IQC plan rejects missing publish status, version, expired dates and another scene', () => {
  for (const change of [
    { publishStatus: undefined }, { publishStatus: 0 }, { versionNo: null },
    { versionNo: 0 }, { versionNo: 1.5 }, { type: 104 }, { planCode: null }
  ]) {
    assert.throws(() => assertPublishedIqcPlan({ ...plan, ...change }, binding, '2', '8'), /BLOCKED/)
  }
  for (const change of [
    { effectiveFrom: '2999-01-01' }, { effectiveTo: '2020-01-01' },
    { effectiveFrom: null }, { isDefault: false }, { type: '104' }
  ]) {
    assert.throws(() => assertPublishedIqcPlan(plan, { ...binding, ...change }, '2', '8'), /BLOCKED/)
  }
})

test('IQC plan accepts official LocalDate arrays and rejects impossible calendar dates', () => {
  assert.doesNotThrow(() => assertPublishedIqcPlan(plan, {
    ...binding, effectiveFrom: [2026, 10, 13]
  }, '2', '8', new Date('2026-10-13T00:00:00Z')))
  assert.doesNotThrow(() => assertPublishedIqcPlan(plan, {
    ...binding, effectiveFrom: '2026-10-13 00:00:00'
  }, '2', '8', new Date('2026-10-13T00:00:00Z')))
  for (const effectiveFrom of [[2026, 2, 30], [2026, 13, 1], '2026-02-30', [2026, 1]]) {
    assert.throws(() => assertPublishedIqcPlan(plan, { ...binding, effectiveFrom },
      '2', '8', new Date('2026-10-13T00:00:00Z')), /BLOCKED/)
  }
})

test('pending lists fail closed on malformed or rejected responses', () => {
  assert.deepEqual(pendingRows(ok([])), [])
  assert.throws(() => pendingRows(ok({ count: 0 })), /不是正式列表/)
  assert.throws(() => pendingRows({ code: 403, msg: 'forbidden' }), /business failure/)
})

test('pending preflight observes authenticated super_admin and service rejection without business writes', async () => {
  const calls = []
  const api = {
    getBusiness: async path => {
      calls.push(['GET', path])
      return path.includes('permission-info') ? ok(info) : ok([])
    },
    post: async (path, body) => {
      calls.push(['POST', path, body])
      return { code: 2010920003, msg: '不支持的检验类型：null' }
    }
  }
  const result = await verifyPendingAccess(api, record(), ['mes:quality-pending:register'])
  assert.equal(result.mode, 'existing-super-admin')
  assert.deepEqual(calls[2][2], {})
  assert.equal(calls.length, 3)
})

test('pending preflight does not infer permission from 400, 403, 401 or register success', async () => {
  for (const body of [
    { code: 400, msg: 'validation' }, { code: 403, msg: 'forbidden' },
    { code: 401, msg: 'unauthenticated' }, ok('unexpected-insert')
  ]) {
    await assert.rejects(verifyPendingAccess({
      getBusiness: async path => path.includes('permission-info') ? ok(info) : ok([]),
      post: async () => body
    }, record(), ['mes:quality-pending:register']), /BLOCKED/)
  }
})

test('pending preflight ignores role environment overrides and requires API roles and identity', () => {
  for (const invalid of [
    { ...info, roles: [] }, { ...info, roles: undefined },
    { ...info, user: { username: 'admin' } },
    { ...info, roles: ['admin'] }
  ]) {
    assert.throws(() => assertPendingPermissions(invalid, ['mes:quality-pending:register']), /BLOCKED/)
  }
})
