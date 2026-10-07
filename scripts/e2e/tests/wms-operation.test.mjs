import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  ASN_BASE, ASN_ROUTE, FIXTURE_MARK, arrivalRoute, assertPurchaseRemaining, assertReceiptDraft, fixturePrefix,
  operationDetail, operationRows, purchaseLinkMissing, quantityUnits, receiptPlan, runCase
} from '../suites/wms-operation.mjs'
import { caseOutcome } from '../lib/report.mjs'

const ok = (data) => ({ code: 0, data })
const legacy = (data) => ({ code: 200, success: true, data })
const prefix = 'AUTOTEST-WMS-OP-001-20261006A'
const notice = {
  id: '2106401100798558209', code: `${prefix}-ASN`, status: 20,
  supplierShipmentKey: `${prefix}-SHIP`, remark: FIXTURE_MARK,
  purchaseOrderId: 'po-1', purchaseOrderCode: `${prefix}-PO`, vendorId: 'vendor-1',
  lines: [{
    id: '2106401100798558210', purchaseOrderItemId: 'po-line-1',
    itemId: 'material-1', unitId: 'unit-1', batchNo: `${prefix}-BATCH`,
    arrivalQuantity: '10.123456', receivedQuantity: '2.000000',
    qualifiedQuantity: '2.000000', iqcCheckFlag: false
  }]
}
const order = {
  id: 'po-1', billNo: `${prefix}-PO`, supplierId: 'vendor-1', remark: FIXTURE_MARK,
  isEffective: 1, isVoided: 0, isClosed: 0, inCount: 2, afterSaveCount: 2,
  items: [{
    id: 'po-line-1', mid: 'po-1', productId: 'material-1',
    productUnitId: 'unit-1', count: '10.123456', inCount: 2, afterSaveCount: 2
  }]
}
const warehouse = {
  id: 'warehouse-1', code: `${prefix}-WH`,
  isEnabled: true, areaEnabled: false, locationEnabled: false
}
const material = {
  id: 'material-1', code: `${prefix}-MAT-1`, remark: FIXTURE_MARK,
  inventoryNature: 'STOCK', unitId: 'unit-1', isEnabled: 1, purchased: 'Y',
  periodManaged: 'N', gradeManaged: 'N', oneBarcode: 'N', batchManaged: 'Y'
}
const permissionInfo = {
  permissions: ['wms:arrival-notice:query', 'wms:arrival-notice:receipt', 'ware:inproduct:delete'],
  menus: [{
    path: '/wireSideWarehouse', children: [{
      path: 'arrivalNotice', component: '/views/wms/arrivalNotice/index.vue'
    }]
  }]
}
const writeEnv = {
  CFOR_WMS_OP_WRITE_FIXTURE: '1',
  CFOR_WMS_OP_ASN_ID: notice.id,
  CFOR_WMS_OP_WAREHOUSE_ID: warehouse.id
}
const draftFor = (request, id = 'receipt-1') => ({
  id, billNo: 'REAL-RECEIPT-001', stockIoType: '101',
  srcBillType: 'MesWmsArrivalNotice', srcBillId: notice.id, srcNo: notice.code,
  idempotentKey: request[0].idempotentKey, billStage: '12',
  isEffective: 0, isVoided: 0, actions: { delete: true }, supplierId: notice.vendorId
})
const entriesFor = (request, id = 'receipt-1') => request.map((line, index) => ({
  id: `entry-${index + 1}`, mid: id, srcEntryId: line.lineId,
  srcBillType: 'MesWmsArrivalNotice', srcBillId: notice.id, srcNo: notice.code,
  stockIoType: '101', stockIoDirection: '1',
  materialId: notice.lines[index].itemId, unitId: notice.lines[index].unitId,
  warehouseId: line.warehouseId, batchNo: line.batchNo,
  isQc: notice.lines[index].iqcCheckFlag ? 1 : 0, qty: line.receivedQuantity
}))

test('strict contracts unwrap real CommonResult and legacy Result; empty or HTTP-success errors cannot pass', () => {
  assert.deepEqual(operationRows(ok([]), 'ASN'), [])
  assert.deepEqual(operationRows(legacy({ records: [], total: 0 }), '101', true), [])
  assert.deepEqual(operationRows(ok({ list: [notice], total: 1 }), 'orders', true), [notice])
  assert.equal(operationDetail(ok(notice), notice.id, 'ASN').id, notice.id)
  for (const payload of [
    undefined, { status: 200, data: [] }, { code: 500, data: [] },
    { code: 200, success: false, data: [] }, ok(null), ok({}), ok([{}]),
    ok([{ id: Number(notice.id) }]), ok(Array.from({ length: 101 }, () => notice))
  ]) assert.throws(() => operationRows(payload, 'ASN'))
  for (const payload of [
    ok({ records: [], total: 1 }), ok({ list: [notice], total: 0 }),
    ok({ list: [], total: '0' }), ok({ records: [] })
  ]) assert.throws(() => operationRows(payload, '101', true))
  assert.throws(() => operationDetail(ok({ ...notice, id: Number(notice.id) }), notice.id, 'ASN'), /丢失精度/)
  assert.throws(() => operationDetail(ok(null), notice.id, 'ASN'))
  assert.equal(operationDetail(ok(null), notice.id, 'ASN', true), null)
})

test('menu-derived route uses real component, not the API pathname or a guessed fallback', () => {
  assert.equal(arrivalRoute(permissionInfo.menus), ASN_ROUTE)
  assert.equal(arrivalRoute([{ path: '/new/asn', component: 'src/views/wms/arrivalNotice/index' }]), '/new/asn')
  assert.equal(arrivalRoute([{ path: '/mes/wms/arrival-notice', component: 'wms/missing/index' }]), null)
  assert.throws(() => arrivalRoute(null), /菜单树/)
  assert.throws(() => arrivalRoute([
    { path: '/one', component: 'wms/arrivalNotice/index' },
    { path: '/two', component: 'wms/arrivalNotice/index' }
  ]), /^Error: BLOCKED:/)
})

test('ownership requires the same case-specific AUTOTEST code, shipment key and marker', () => {
  assert.equal(fixturePrefix(notice), prefix)
  for (const row of [
    { ...notice, code: 'AUTOTEST-PROC-001-ASN' },
    { ...notice, code: `${prefix}-ASN-user` },
    { ...notice, code: 'E2E-ASN-001' },
    { ...notice, remark: 'user data with AUTOTEST mention' },
    { ...notice, supplierShipmentKey: 'another-SHIP' }
  ]) assert.equal(fixturePrefix(row), null)
})

test('ASN purchase links require actual nonempty order lines, matching vendor, product and unit', () => {
  assert.deepEqual(purchaseLinkMissing(notice, order), [])
  assert.match(purchaseLinkMissing(notice, null).join(), /为空/)
  assert.match(purchaseLinkMissing({ ...notice, lines: [] }, order).join(), /非空 ASN/)
  assert.match(purchaseLinkMissing(notice, { ...order, items: [] }).join(), /非空采购/)
  const missingLine = { ...notice, lines: [{ ...notice.lines[0], purchaseOrderItemId: null }] }
  assert.match(purchaseLinkMissing(missingLine, order).join(), /订单行 ID/)
  for (const changed of [
    { ...order, id: 'po-2' }, { ...order, supplierId: 'vendor-2' },
    { ...order, billNo: 'USER-ORDER' },
    { ...order, items: [{ ...order.items[0], mid: 'po-2' }] },
    { ...order, items: [{ ...order.items[0], productId: 'material-2' }] },
    { ...order, items: [{ ...order.items[0], productUnitId: 'unit-2' }] }
  ]) assert.throws(() => purchaseLinkMissing(notice, changed))
  assert.throws(() => purchaseLinkMissing({
    ...notice, lines: [{ ...notice.lines[0], receivedQuantity: 11 }]
  }, order), /数量事实/)
})

test('receipt plan preserves string Long IDs and exact six-decimal remaining quantity with one key', () => {
  assert.equal(quantityUnits('10.123456'), 10123456n)
  for (const value of [null, undefined, true, '', ' ', 'NaN', Infinity, -1, '0.0000001']) {
    assert.equal(quantityUnits(value), null)
  }
  const source = {
    ...notice,
    lines: [...notice.lines, {
      ...notice.lines[0], id: '2106401100798558211',
      arrivalQuantity: '0.000003', receivedQuantity: '0.000001'
    }]
  }
  const request = receiptPlan(source, warehouse.id, 'one-key')
  assert.deepEqual(request.map((line) => line.receivedQuantity), ['8.123456', '0.000002'])
  assert.deepEqual(request.map((line) => line.lineId), source.lines.map((line) => line.id))
  assert.ok(request.every((line) => line.idempotentKey === 'one-key'))
  assert.throws(() => receiptPlan(notice, '', 'key'), /^Error: BLOCKED:/)
  assert.throws(() => receiptPlan({ ...notice, status: 0 }, warehouse.id, 'key'), /^Error: BLOCKED:/)
  assert.throws(() => receiptPlan({
    ...notice, lines: [{ ...notice.lines[0], receivedQuantity: notice.lines[0].arrivalQuantity }]
  }, warehouse.id, 'key'), /无正数未收/)
  assert.throws(() => receiptPlan({
    ...notice, lines: [...notice.lines, notice.lines[0]]
  }, warehouse.id, 'key'), /明细/)
})

test('101 proof requires real nonempty draft and ASN line linkage, not just a returned ID', () => {
  const request = receiptPlan(notice, warehouse.id, 'key')
  const bill = draftFor(request)
  const entries = entriesFor(request)
  assert.doesNotThrow(() => assertReceiptDraft(bill, entries, notice, request))
  for (const changed of [
    { ...bill, srcBillType: 'PurOrder' }, { ...bill, srcBillId: 'another-ASN' },
    { ...bill, srcNo: 'another-code' }, { ...bill, stockIoType: '104' },
    { ...bill, isEffective: 1 }, { ...bill, isVoided: 1 }, { ...bill, billStage: '24' },
    { ...bill, actions: {} }, { ...bill, idempotentKey: '' }, { ...bill, supplierId: 'vendor-2' }
  ]) assert.throws(() => assertReceiptDraft(changed, entries, notice, request))
  for (const changed of [
    [], [{ ...entries[0], srcEntryId: 'another-line' }],
    [{ ...entries[0], mid: 'receipt-2' }], [{ ...entries[0], srcBillId: 'another-ASN' }],
    [{ ...entries[0], qty: 20 }], [{ ...entries[0], qty: null }],
    [{ ...entries[0], unitId: 'unit-2' }], [{ ...entries[0], warehouseId: 'warehouse-2' }],
    [{ ...entries[0], isQc: 1 }], [{ ...entries[0], stockIoDirection: '2' }]
  ]) assert.throws(() => assertReceiptDraft(bill, changed, notice, request))
})

test('receipt quantities cannot exceed order-line remaining quantity including already documented drafts', () => {
  const request = receiptPlan(notice, warehouse.id, 'key')
  assert.doesNotThrow(() => assertPurchaseRemaining(notice, order, request))
  for (const item of [
    { ...order.items[0], count: null },
    { ...order.items[0], count: 9 },
    { ...order.items[0], afterSaveCount: 3 }
  ]) assert.throws(() => assertPurchaseRemaining(notice, { ...order, items: [item] }, request), /^Error: BLOCKED:/)
  const duplicate = {
    ...notice, lines: [...notice.lines, { ...notice.lines[0], id: '2106401100798558211' }]
  }
  assert.throws(() => assertPurchaseRemaining(
    duplicate, order, receiptPlan(duplicate, warehouse.id, 'key')
  ), /余量不足/)
})

// Offline orchestration tests inject dependencies; no browser or live endpoint is started.
function harness (options = {}) {
  const calls = []
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const state = { bill: options.existingBill || null, entries: options.existingEntries || [] }
  const n = options.notice === undefined ? structuredClone(notice) : options.notice
  const o = options.order === undefined ? structuredClone(order) : options.order
  const perms = options.permissions || permissionInfo
  let currentUrl = 'about:blank'
  let noticeReads = 0
  const page = {
    url: () => currentUrl,
    locator: () => ({ innerText: async () => '通知单编码 采购订单 预约月台 操作' })
  }
  const api = {
    async getBusiness (url) {
      calls.push(['GET', url])
      if (url === '/system/auth/get-permission-info') return ok(perms)
      if (url.startsWith(`${ASN_BASE}/page?`)) return ok(n ? [n] : [])
      if (url.startsWith(`${ASN_BASE}/get?`)) {
        noticeReads++
        return ok(options.sourceChangedBeforeWrite && noticeReads > 1
          ? { ...n, lines: [{ ...n.lines[0], receivedQuantity: 3 }] } : n)
      }
      if (url.startsWith('/erp/purchase-order/page?')) return ok({ list: o ? [o] : [], total: o ? 1 : 0 })
      if (url.startsWith('/erp/purchase-order/get?')) return ok(o)
      if (url.startsWith('/mes/wmsWareHouse/queryById?')) return legacy(options.warehouse || warehouse)
      if (url.startsWith('/mes/basMaterial/queryById?')) return legacy(options.material || material)
      if (url.startsWith('/mes/stkIo/list?')) {
        // Real StkIoPage deliberately has no idempotentKey.
        const rows = state.bill ? [{ ...state.bill }] : []
        for (const row of rows) delete row.idempotentKey
        return options.billPage || legacy({ records: rows, total: rows.length })
      }
      if (url.startsWith('/mes/stkIo/queryById?')) return legacy(state.bill)
      if (url.startsWith('/mes/stkIo/queryEntryByMainId?')) return legacy(state.entries)
      throw new Error(`Unexpected GET ${url}`)
    },
    async postBusiness (url, request) {
      calls.push(['POST', url, request])
      assert.ok(url.startsWith(`${ASN_BASE}/create-receipt-bill?id=`))
      assert.equal(options.env?.CFOR_WMS_OP_WRITE_FIXTURE, '1')
      if (!state.bill) {
        state.bill = draftFor(request)
        state.entries = entriesFor(request)
        if (options.entryFault) state.entries[0].unitId = 'wrong-unit'
        if (options.lostResponse) throw new Error('create response lost')
      } else if (options.retryFault) throw new Error('retry failed')
      return ok(state.bill.id)
    },
    async deleteBusiness (url) {
      calls.push(['DELETE', url])
      if (options.cleanupFault) throw new Error('delete denied')
      state.bill = null
      state.entries = []
      return legacy('删除成功!')
    }
  }
  const dependencies = {
    env: options.env || {}, login: async () => 'offline-unit-token', createApiClient: () => api,
    openRoute: async (_page, route) => {
      calls.push(['UI', route])
      currentUrl = `http://127.0.0.1:9151${route}`
    },
    saveScreenshot: async () => {}
  }
  return {
    calls, caseRecord, state,
    run: () => runCase({ caseId: 'WMS-OP-001', page, record: {}, caseRecord, outputDir: '' }, dependencies)
  }
}
const writes = (h) => h.calls.filter(([method]) => ['POST', 'PUT', 'DELETE'].includes(method))

test('valid empty read responses never become PASS and produce explicit missing prerequisites', async () => {
  const h = harness({ notice: null, order: null })
  const result = await h.run()
  assert.equal(result.partial, true)
  assert.equal(caseOutcome({ hasAssertions: true, failedChecks: [], result }).status, 'PARTIAL')
  assert.match(result.note, /分页样本为空|非空 ASN/)
  assert.match(result.note, /审核\/弃审|库存/)
  assert.equal(writes(h).length, 0)
})

test('readonly default remains PARTIAL even with complete dedicated sources', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(result.partial, true)
  assert.ok(h.caseRecord.checks.every((check) => check.passed))
  assert.equal(writes(h).length, 0)
  assert.ok(h.calls.some(([, url]) => url.startsWith('/erp/purchase-order/get?')))
  assert.ok(h.calls.some(([, url]) => url.startsWith('/mes/stkIo/list?')))
})

test('explicit write request without owned ASN, order or permissions is BLOCKED before any mutation', async () => {
  for (const options of [
    { notice: null, order: null },
    { notice: { ...notice, code: 'USER-ASN' } },
    { order: { ...order, remark: 'another case fixture' } },
    { order: { ...order, isEffective: 0 } },
    { notice: { ...notice, status: 0 } },
    { notice: { ...notice, lines: [{ ...notice.lines[0], iqcCheckFlag: true }] } },
    { order: { ...order, afterSaveCount: null } },
    { permissions: { ...permissionInfo, permissions: ['wms:arrival-notice:query'] } }
  ]) {
    const h = harness({ ...options, env: writeEnv })
    await assert.rejects(h.run(), /^Error: BLOCKED:/)
    assert.equal(writes(h).length, 0)
  }
})

test('write opt-in alone cannot auto-select an ASN or warehouse from list data', async () => {
  const h = harness({ env: { CFOR_WMS_OP_WRITE_FIXTURE: '1' } })
  await assert.rejects(h.run(), /显式 ASN ID 与专属仓库 ID/)
  assert.equal(writes(h).length, 0)
})

test('shared warehouses, shared material and unsupported material dimensions stay zero-write BLOCKED', async () => {
  for (const options of [
    { warehouse: { ...warehouse, code: 'SHARED' } },
    { warehouse: { ...warehouse, locationEnabled: true } },
    { material: { ...material, code: 'SHARED' } },
    { material: { ...material, inventoryNature: 'SERVICE' } },
    { material: { ...material, periodManaged: 'Y' } },
    { material: { ...material, gradeManaged: 'Y' } }
  ]) {
    const h = harness({ ...options, env: writeEnv })
    await assert.rejects(h.run(), /^Error: BLOCKED:/)
    assert.equal(writes(h).length, 0)
  }
})

test('historical 101 under the selected source is read but is never reused or deleted', async () => {
  const request = receiptPlan(notice, warehouse.id, 'historical-key')
  const h = harness({
    env: writeEnv, existingBill: draftFor(request), existingEntries: entriesFor(request)
  })
  await assert.rejects(h.run(), /ASN 下已有 101 单据/)
  assert.equal(writes(h).length, 0)
  assert.equal(h.state.bill.idempotentKey, 'historical-key')
})

test('source quantities changing before create are BLOCKED with zero writes', async () => {
  const h = harness({ env: writeEnv, sourceChangedBeforeWrite: true })
  await assert.rejects(h.run(), /写前来源或数量已变化/)
  assert.equal(writes(h).length, 0)
})

test('HTTP 200 business errors or malformed 101 pages fail instead of becoming missing fixture PARTIAL', async () => {
  for (const billPage of [{ code: 500, data: [] }, legacy({ records: [], total: 1 })]) {
    const h = harness({ billPage })
    await assert.rejects(h.run(), /business failure|不一致/)
    assert.equal(writes(h).length, 0)
  }
})

test('guarded API sequence generates, reads, retries one key and deletes only its own draft; result stays PARTIAL', async () => {
  const h = harness({ env: writeEnv })
  const result = await h.run()
  assert.equal(result.partial, true)
  assert.equal(caseOutcome({ hasAssertions: true, failedChecks: [], result }).status, 'PARTIAL')
  assert.deepEqual(writes(h).map(([method]) => method), ['POST', 'POST', 'DELETE'])
  const requests = writes(h).filter(([method]) => method === 'POST').map(([, , request]) => request)
  assert.deepEqual(requests[0], requests[1])
  assert.ok(requests[0][0].idempotentKey.startsWith(`${prefix}:RECEIPT:`))
  assert.equal(h.state.bill, null)
  assert.equal(h.state.entries.length, 0)
  assert.match(h.caseRecord.notes.join('\n'), /未删除 ASN、订单、物料或仓库/)
  assert.ok(h.caseRecord.checks.every((check) => check.passed))
})

test('draft assertion and retry failures still run exact-key cleanup without masking the error', async () => {
  for (const options of [{ entryFault: true }, { retryFault: true }]) {
    const h = harness({ ...options, env: writeEnv })
    await assert.rejects(h.run(), /101 草稿明细|retry failed/)
    assert.equal(writes(h).filter(([method]) => method === 'DELETE').length, 1)
    assert.equal(h.state.bill, null)
    assert.match(h.caseRecord.notes.join('\n'), /步骤失败/)
  }
})

test('lost create response recovers ownership from real detail, not the list VO', async () => {
  const h = harness({ env: writeEnv, lostResponse: true })
  await assert.rejects(h.run(), /create response lost/)
  assert.equal(writes(h).filter(([method]) => method === 'DELETE').length, 1)
  assert.equal(h.state.bill, null)
  assert.equal(h.caseRecord.fixtures.at(-1).kind, 'receipt-draft-intent')
  assert.ok(h.caseRecord.fixtures.at(-1).idempotentKey)
})

test('cleanup failure is not PASS or silent PARTIAL and retains created draft evidence', async () => {
  const h = harness({ env: writeEnv, cleanupFault: true })
  await assert.rejects(h.run(), /delete denied/)
  assert.equal(h.caseRecord.fixtures.at(-1).id, h.state.bill.id)
  assert.ok(h.caseRecord.fixtures.at(-1).idempotentKey)
})

test('suite contains no intercepted responses, historical fake stock ID, SQL or stock approval calls', async () => {
  const source = fs.readFileSync(new URL('../suites/wms-operation.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /page\.route|route\.fulfill|stk-e2e-101|legacy\/wms-operation/)
  assert.doesNotMatch(source, /runReadOnlySql|mysql|\/(update-bill-stage|check|execute|void|submit)\b/)
  assert.match(source, /partial: true/)
  await assert.rejects(runCase(), /^Error: BLOCKED:/)
})
