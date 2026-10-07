import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  cases,
  caseRegistry,
  procurementFoundationReadonlyPage,
  runCase,
  runProcurementFoundationReadonlyContract
} from '../suites/procurement-foundation-readonly.mjs'

const ok = (data) => ({ code: 0, data })
const paged = (rows, total = rows.length) => ok({ list: rows, total })
const records = (rows, total = rows.length) => ok({ records: rows, total })
const record = () => ({ checks: [], notes: [], evidence: [] })

const mrpRow = () => ({
  id: 'mrp-1',
  status: 3,
  progress: 100,
  totalMaterials: 1,
  shortageCount: 1,
  purchaseCount: 1,
  purchasePlanGenerated: true,
  resultJson: JSON.stringify({
    calculationId: 'mrp-1',
    demandPlan: [{
      materialId: 'material-1',
      netDemand: 2,
      currentStock: 0,
      totalDemand: 2,
      suggestPurchase: 2
    }],
    purchaseSuggestion: [{
      materialId: 'material-1',
      suggestQty: 2
    }]
  })
})

const requestRow = () => ({
  id: 'request-1',
  srcBillType: 'MRP',
  srcBillId: 'mrp-1',
  processInstanceId: 'process-1'
})

const purchaseRow = () => ({ id: 'purchase-1' })
const purchaseItem = () => ({
  id: 'purchase-item-1',
  srcBillId: 'request-1',
  srcEntryId: 'request-item-1',
  productId: 'material-1'
})

const rule = () => ({
  id: 'rule-1',
  settleMethodCode: 'BANK',
  version: 2,
  status: 1,
  direction: 'BOTH',
  allowedAccountTypes: 'BANK_ACCOUNT',
  requireBillNo: true,
  requireDueDate: false,
  allowCredit: true,
  defaultCreditDays: 30,
  effectiveFrom: '2026-01-01',
  effectiveTo: null
})

// Fixtures are limited to node:test and are never substituted in real runs.
function fixture (overrides = {}) {
  const rows = {
    mrpHistory: [mrpRow()],
    inventory: [{
      id: 'stock-1',
      materialId: 'material-1',
      warehouseId: 'warehouse-1',
      qty: 10,
      availableQty: 8,
      lockQty: 1,
      holdQty: 0,
      frozenQty: 0,
      pendingPutawayQty: 1
    }],
    requests: [requestRow()],
    purchaseOrders: [{
      ...purchaseRow(),
      settleMethodCode: 'BANK',
      settleMethodRuleVersion: 2
    }],
    todos: [{ processInstanceId: 'process-1' }],
    purchaseInvoices: [{
      id: 'invoice-1',
      supplierId: 'supplier-1',
      srcBillType: 'PURCHASE_ORDER',
      srcBillId: 'purchase-1',
      isRubric: false
    }],
    payables: [{
      id: 'payable-1',
      srcBillType: 'PurInvoice',
      srcBillId: 'invoice-1',
      supplierId: 'supplier-1',
      isRubric: false
    }],
    asn: [{
      id: 'asn-1',
      purchaseOrderId: 'purchase-1',
      vendorId: 'supplier-1'
    }],
    reconciliations: [{
      id: 'reconciliation-1',
      status: 'CONFIRMED',
      confirmVersion: 1,
      supplierId: 'supplier-1'
    }],
    saleInvoices: [{
      id: 'sale-invoice-1',
      srcBillType: 'SALE_ORDER',
      srcBillId: 'sale-1',
      srcBillVersion: 1
    }],
    dictionary: [{
      id: 'dict-1',
      value: 'BANK',
      label: 'Bank',
      dictType: 'x_settle_method',
      status: 0
    }],
    rules: [rule()],
    saleSnapshotOrders: [{
      id: 'sale-1',
      settleMethodCode: 'BANK',
      settleMethodRuleVersion: 2
    }]
  }

  const responses = {
    '/mes/mrp/history?pageNo=1&pageSize=100': records(rows.mrpHistory),
    '/mes/mrp/status/mrp-1': ok({
      calculationId: 'mrp-1',
      status: 3,
      progress: 100,
      totalMaterials: 1,
      shortageCount: 1,
      purchaseCount: 1,
      purchasePlanGenerated: true,
      cancelable: false
    }),
    '/mes/stkInventory/list?pageNo=1&pageSize=100': records(rows.inventory),

    '/erp/purchase/order/request/page?pageNo=1&pageSize=100': records(rows.requests),
    '/erp/purchase/order/request/get?id=request-1': ok({
      ...requestRow(),
      itemsList: [{
        id: 'request-item-1',
        productId: 'material-1'
      }]
    }),
    '/erp/purchase-order/page?pageNo=1&pageSize=100': paged(rows.purchaseOrders),
    '/erp/purchase-order/get?id=purchase-1': ok({
      ...purchaseRow(),
      items: [purchaseItem()]
    }),
    '/bpm/task/todo-page?pageNo=1&pageSize=100': paged(rows.todos),

    '/erp/purchase-invoice/page?pageNo=1&pageSize=100': paged(rows.purchaseInvoices),
    '/erp/purchase-invoice/get?id=invoice-1': ok({
      id: 'invoice-1',
      supplierId: 'supplier-1',
      srcBillType: 'PURCHASE_ORDER',
      srcBillId: 'purchase-1',
      isRubric: false
    }),
    '/finance/finPayable/list?pageNo=1&pageSize=100': records(rows.payables),
    '/finance/finPayable/queryById?id=payable-1': ok({
      ...rows.payables[0]
    }),
    '/mes/wms/arrival-notice/page?pageSize=100&withLines=true': ok(rows.asn),
    '/mes/wms/arrival-notice/get?id=asn-1': ok({
      id: 'asn-1',
      purchaseOrderId: 'purchase-1',
      vendorId: 'supplier-1',
      lines: [{
        id: 'asn-line-1',
        purchaseOrderItemId: 'purchase-item-1',
        itemId: 'material-1',
        arrivalQuantity: 2,
        receivedQuantity: 0,
        qualifiedQuantity: 0,
        iqcCheckFlag: false
      }]
    }),

    '/system/config/get?category=purchase&tag=requisition':
      ok({ category: 'purchase', tag: 'requisition', configData: '{"enabled":true}' }),
    '/system/config/get?category=purchase&tag=reconciliation':
      ok({ category: 'purchase', tag: 'reconciliation', configData: '{"enabled":true}' }),
    '/system/config/get?category=sales&tag=reconciliation':
      ok({ category: 'sales', tag: 'reconciliation', configData: '{"enabled":true}' }),
    '/erp/purchase-reconciliation/page?pageNo=1&pageSize=100':
      paged(rows.reconciliations),
    '/erp/purchase-reconciliation/get?id=reconciliation-1': ok({
      id: 'reconciliation-1',
      status: 'CONFIRMED',
      confirmVersion: 1,
      supplierId: 'supplier-1',
      lines: [{ id: 'reconciliation-line-1' }]
    }),
    '/erp/sale-invoice/page?pageNo=1&pageSize=100': paged(rows.saleInvoices),
    '/erp/sale-invoice/get?id=sale-invoice-1': ok({
      id: 'sale-invoice-1',
      srcBillType: 'SALE_ORDER',
      srcBillId: 'sale-1',
      srcBillVersion: 1
    }),

    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=x_settle_method':
      paged(rows.dictionary),
    '/erp/settle-method-rule/page?pageNo=1&pageSize=100': paged(rows.rules),
    '/erp/settle-method-rule/get?id=rule-1': ok(rule()),
    '/erp/settle-method-rule/list-by-code?settleMethodCode=BANK': ok([rule()]),
    '/erp/sale-order/page?pageNo=1&pageSize=100': paged(rows.saleSnapshotOrders),
    '/erp/sale-order/get?id=sale-1': ok(rows.saleSnapshotOrders[0])
  }

  responses['/erp/purchase-order/get?id=purchase-1'] = ok({
    ...purchaseRow(),
    items: [purchaseItem()],
    settleMethodCode: 'BANK',
    settleMethodRuleVersion: 2
  })

  const merged = { ...responses, ...overrides }
  const calls = []
  const api = {
    async getBusiness (path) {
      calls.push(path)
      assert.ok(Object.hasOwn(merged, path), `unexpected GET ${path}`)
      return structuredClone(merged[path])
    },
    async post () {
      assert.fail('readonly suite attempted POST')
    },
    async put () {
      assert.fail('readonly suite attempted PUT')
    },
    async delete () {
      assert.fail('readonly suite attempted DELETE')
    }
  }
  return { api, calls, responses: merged }
}

const emptyOverrides = () => ({
  '/mes/mrp/history?pageNo=1&pageSize=100': records([]),
  '/mes/stkInventory/list?pageNo=1&pageSize=100': records([]),
  '/erp/purchase/order/request/page?pageNo=1&pageSize=100': records([]),
  '/erp/purchase-order/page?pageNo=1&pageSize=100': paged([]),
  '/bpm/task/todo-page?pageNo=1&pageSize=100': paged([]),
  '/erp/purchase-invoice/page?pageNo=1&pageSize=100': paged([]),
  '/finance/finPayable/list?pageNo=1&pageSize=100': records([]),
  '/mes/wms/arrival-notice/page?pageSize=100&withLines=true': ok([]),
  '/erp/purchase-reconciliation/page?pageNo=1&pageSize=100': paged([]),
  '/erp/sale-invoice/page?pageNo=1&pageSize=100': paged([]),
  '/system/dict-data/page?pageNo=1&pageSize=100&dictType=x_settle_method': paged([]),
  '/erp/settle-method-rule/page?pageNo=1&pageSize=100': paged([]),
  '/erp/sale-order/page?pageNo=1&pageSize=100': paged([])
})

async function run (caseId, overrides = {}) {
  const fixtureState = fixture(overrides)
  const caseRecord = record()
  const result = await runProcurementFoundationReadonlyContract({
    caseId,
    api: fixtureState.api,
    caseRecord
  })
  return { ...fixtureState, caseRecord, result }
}

test('registry exports exactly PROC-001 through PROC-005 with readonly PARTIAL metadata', () => {
  assert.deepEqual(cases, ['PROC-001', 'PROC-002', 'PROC-003', 'PROC-004', 'PROC-005'])
  assert.equal(caseRegistry.length, cases.length)
  for (const item of caseRegistry) {
    assert.equal(item.mode, 'READ_ONLY')
    assert.equal(item.resultCeiling, 'PARTIAL')
    assert.ok(item.pbScope.length > 0)
    assert.ok(item.safeGet.length > 0)
    assert.ok(item.unverified.length > 0)
    assert.match(item.businessSideEffects, /不创建业务实体/)
  }
})

for (const caseId of cases) {
  test(`${caseId} populated readonly evidence remains PARTIAL and uses GET only`, async () => {
    const { calls, caseRecord, result } = await run(caseId)
    assert.equal(result.partial, true)
    assert.ok(caseRecord.notes.some((note) => note.startsWith(`${caseId} 仅真实 GET 只读前置`)))
    assert.ok(caseRecord.notes.some((note) => note.startsWith('未验证：')))
    assert.ok(caseRecord.checks.every((check) => check.passed))
    assert.ok(calls.length > 0)
    assert.ok(calls.every((path) => path.startsWith('/')))
  })
}

for (const caseId of cases) {
  test(`${caseId} empty pages record missing prerequisites without empty PASS`, async () => {
    const { calls, caseRecord, result } = await run(caseId, emptyOverrides())
    assert.equal(result.partial, true)
    assert.ok(caseRecord.notes.some((note) => note.startsWith('前置/证据缺口：')))
    assert.ok(!caseRecord.checks.some((check) =>
      /字段|状态|关联|来源|版本|门禁|行数量|物料/.test(check.name)))
    if (caseId !== 'PROC-004') {
      assert.ok(!calls.some((path) => /\/get\?|\/gate\?/.test(path)))
    }
  })
}

test('page helper rejects failed business codes, missing data, malformed totals and rows', () => {
  for (const payload of [
    { code: 500, data: { list: [], total: 0 } },
    ok({}),
    ok({ list: {}, total: 0 }),
    ok({ list: [{}], total: 0 }),
    ok({ list: [], total: '0' }),
    ok({ list: [null], total: 1 }),
    ok({ list: [], total: 101 }),
    ok({ list: Array.from({ length: 101 }, () => ({})), total: 101 })
  ]) assert.throws(() => procurementFoundationReadonlyPage(payload, 'unit page'))
  assert.deepEqual(
    procurementFoundationReadonlyPage(paged([]), 'unit page'),
    { list: [], total: 0 }
  )
  assert.deepEqual(
    procurementFoundationReadonlyPage(ok([]), 'unit array', 'array'),
    { list: [], total: null }
  )
})

test('business failure, missing detail and ID drift fail instead of becoming PARTIAL', async () => {
  await assert.rejects(() => run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': { code: 500, data: { records: [], total: 0 } }
  }), /MRP 历史 业务响应成功/)

  await assert.rejects(() => run('PROC-002', {
    '/erp/purchase/order/request/get?id=request-1': ok(null)
  }), /请购单 详情精确回读/)

  await assert.rejects(() => run('PROC-005', {
    '/erp/settle-method-rule/get?id=rule-1': ok({ ...rule(), version: 3 })
  }), /结算规则 分页详情契约一致/)
})

test('MRP result JSON and source associations are validated against real IDs', async () => {
  await assert.rejects(() => run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': records([{
      ...mrpRow(),
      resultJson: '{malformed'
    }])
  }), /MRP 结果 JSON 可解析/)

  const request = await run('PROC-002')
  assert.ok(request.calls.includes('/erp/purchase-order/get?id=purchase-1'))
  assert.ok(request.caseRecord.checks.some((check) => /来源请购明细/.test(check.name)))
  assert.ok(request.caseRecord.checks.some((check) => /待办关联/.test(check.name)))
})

test('invoice/payable and ASN evidence follows invoice and purchase-order line IDs', async () => {
  const { caseRecord } = await run('PROC-003')
  assert.ok(caseRecord.checks.some((check) => /PurInvoice 应付精确引用/.test(check.name)))
  assert.ok(caseRecord.checks.some((check) => /ASN 行引用真实采购订单行/.test(check.name)))
  assert.ok(caseRecord.notes.some((note) => /101 入库及质检放行/.test(note)))
})

test('configuration and settlement snapshot branches stay evidence-based', async () => {
  const options = await run('PROC-004')
  assert.ok(options.caseRecord.checks.some((check) => /purchase\/requisition 配置/.test(check.name)))
  assert.ok(options.caseRecord.checks.some((check) => /采购对账状态/.test(check.name)))

  const snapshots = await run('PROC-005')
  assert.ok(snapshots.calls.some((path) => path.includes('/list-by-code?settleMethodCode=BANK')))
  assert.ok(snapshots.caseRecord.checks.some((check) => /历史订单版本/.test(check.name)))
  assert.ok(snapshots.caseRecord.checks.some((check) => /编码版本列表包含当前规则/.test(check.name)))
})

test('missing or disabled config records a gap without asserting the disabled gate', async () => {
  const { caseRecord, result } = await run('PROC-004', {
    '/system/config/get?category=purchase&tag=requisition':
      ok({ category: 'purchase', tag: 'requisition', configData: '{"enabled":false}' }),
    '/system/config/get?category=purchase&tag=reconciliation': ok(null)
  })
  assert.equal(result.partial, true)
  assert.ok(caseRecord.notes.some((note) => /purchase\/requisition 配置 未启用/.test(note)))
  assert.ok(caseRecord.notes.some((note) => /purchase\/reconciliation 配置 未配置/.test(note)))
  assert.ok(!caseRecord.checks.some((check) => /开关已开启|门禁允许/.test(check.name)))
})

test('historical settlement version absence is a gap, not a false failure', async () => {
  const { caseRecord, result } = await run('PROC-005', {
    '/erp/settle-method-rule/page?pageNo=1&pageSize=100':
      paged([{ ...rule(), version: 3 }]),
    '/erp/settle-method-rule/get?id=rule-1': ok({ ...rule(), version: 3 }),
    '/erp/settle-method-rule/list-by-code?settleMethodCode=BANK':
      ok([{ ...rule(), version: 3 }])
  })
  assert.equal(result.partial, true)
  assert.ok(caseRecord.notes.some((note) => /历史订单版本未在当前规则列表保留/.test(note)))
  assert.ok(!caseRecord.checks.some((check) => check.passed === false))
})

test('runCase accepts an injected GET client without login, page or browser dependency', async () => {
  const f = fixture()
  const caseRecord = record()
  const result = await runCase({ caseId: 'PROC-005', caseRecord }, { api: f.api })
  assert.equal(result.partial, true)
  await assert.rejects(() => runCase({ caseId: 'PROC-001', caseRecord }), /不自动登录/)
  await assert.rejects(() => run('PROC-006'), /非目标采购基础只读案例/)
})

for (const [caseId, path] of [
  ['PROC-001', '/mes/mrp/history?pageNo=1&pageSize=100'],
  ['PROC-002', '/erp/purchase/order/request/page?pageNo=1&pageSize=100'],
  ['PROC-003', '/erp/purchase-invoice/page?pageNo=1&pageSize=100'],
  ['PROC-004', '/system/config/get?category=purchase&tag=requisition'],
  ['PROC-005', '/system/dict-data/page?pageNo=1&pageSize=100&dictType=x_settle_method']
]) {
  test(`${caseId} failed business responses and missing data reject before accepting empty evidence`, async () => {
    for (const response of [{ code: 500, data: null }, { code: 0 }, { code: 0, success: false, data: null }]) {
      await assert.rejects(() => run(caseId, { [path]: response }), /业务响应成功/)
    }
  })
}

test('HTTP/API errors are failures without exposing business bodies', async () => {
  const caseRecord = record()
  await assert.rejects(() => runProcurementFoundationReadonlyContract({
    caseId: 'PROC-001',
    caseRecord,
    api: { async getBusiness () { throw new Error('SECRET_BUSINESS_BODY') } }
  }), (error) => {
    assert.match(error.message, /GET 请求成功/)
    assert.doesNotMatch(error.message, /SECRET_BUSINESS_BODY/)
    return true
  })
  assert.doesNotMatch(JSON.stringify(caseRecord), /SECRET_BUSINESS_BODY/)
  assert.ok(caseRecord.checks.some((check) => check.passed === false))
})

test('nonempty detail ID drift and malformed record pages fail at the correct contract', async () => {
  await assert.rejects(() => run('PROC-002', {
    '/erp/purchase/order/request/get?id=request-1': ok({ ...requestRow(), id: 'wrong' })
  }), /请购单 详情精确回读/)
  await assert.rejects(() => run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': ok({ records: [], total: 1 })
  }), /data.records\/total/)
})

test('source association mismatches are FAIL rather than a missing-data PARTIAL', async () => {
  await assert.rejects(() => run('PROC-002', {
    '/erp/purchase-order/get?id=purchase-1': ok({
      ...purchaseRow(),
      items: [{ ...purchaseItem(), srcEntryId: 'missing' }]
    })
  }), /精确引用请购明细/)
  const f = fixture()
  await assert.rejects(() => run('PROC-003', {
    '/erp/purchase-invoice/get?id=invoice-1': ok({
      ...f.responses['/erp/purchase-invoice/get?id=invoice-1'].data,
      supplierId: 'wrong'
    })
  }), /同一供应商/)
  await assert.rejects(() => run('PROC-003', {
    '/mes/wms/arrival-notice/get?id=asn-1': ok({
      ...f.responses['/mes/wms/arrival-notice/get?id=asn-1'].data,
      lines: [{
        ...f.responses['/mes/wms/arrival-notice/get?id=asn-1'].data.lines[0],
        itemId: 'wrong'
      }]
    })
  }), /ASN 行引用真实采购订单行/)
})

test('MRP result uses real production/sales VO list names and materialId row keys', async () => {
  const production = await run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': records([{
      ...mrpRow(),
      resultJson: JSON.stringify({
        calculationId: 'mrp-1',
        demandPlan: [{
          materialId: 'material-1',
          netDemand: 2,
          suggestPurchase: 2
        }],
        purchaseSuggestion: [{ materialId: 'material-1', suggestQty: 2 }]
      })
    }])
  })
  assert.equal(production.result.partial, true)
  assert.ok(production.caseRecord.checks.some((check) => /MRP 结果 purchaseSuggestion 明细数组/.test(check.name)))
  assert.ok(!production.caseRecord.checks.some((check) => /MRP 结果 purchaseSuggestion明细稳定 ID/.test(check.name)))

  const sales = await run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': records([{
      ...mrpRow(),
      saleOrderId: 'sale-1',
      resultJson: JSON.stringify({
        calculationId: 'mrp-1',
        purchaseSuggestions: [{ materialId: 'material-1', suggestQty: 2 }]
      })
    }])
  })
  assert.equal(sales.result.partial, true)
  assert.ok(sales.caseRecord.checks.some((check) => /MRP 结果 purchaseSuggestions 明细数组/.test(check.name)))

  const { result } = await run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': records([{
      ...mrpRow(),
      saleOrderId: 'sale-1',
      resultJson: JSON.stringify({
        calculationId: 'mrp-1',
        purchaseSuggestions: [{ materialId: 'material-1', suggestQty: 2 }]
      })
    }])
  })
  assert.equal(result.partial, true)
  await assert.rejects(() => run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': records([{
      ...mrpRow(),
      resultJson: JSON.stringify({ calculationId: 'mrp-1', demandPlan: [
        { materialId: 'material-1', suggestPurchase: 'invalid' }
      ] })
    }])
  }), /MRP 结果行物料与数量类型/)
  await assert.rejects(() => run('PROC-001', {
    '/mes/mrp/history?pageNo=1&pageSize=100': records([{
      ...mrpRow(),
      resultJson: JSON.stringify({
        calculationId: 'mrp-1',
        demandPlan: [],
        purchaseSuggestion: [{ materialId: 'material-1', suggestQty: 'invalid' }]
      })
    }])
  }), /MRP 结果行物料与数量类型/)
})

test('BPM todo uses processInstanceId for correlation without requiring task row id', async () => {
  const { caseRecord } = await run('PROC-002')
  assert.ok(caseRecord.checks.some((check) =>
    /当前用户待办 非空记录稳定 processInstanceId/.test(check.name)))
  assert.ok(!caseRecord.checks.some((check) =>
    /当前用户待办 非空记录稳定 id/.test(check.name)))
  await assert.rejects(() => run('PROC-002', {
    '/bpm/task/todo-page?pageNo=1&pageSize=100':
      paged([{ name: 'missing-process-instance-id' }])
  }), /当前用户待办 非空记录稳定 processInstanceId/)
})

test('empty version lists record a gap without an every() based positive check', async () => {
  const { caseRecord } = await run('PROC-005', {
    '/erp/settle-method-rule/list-by-code?settleMethodCode=BANK': ok([])
  })
  assert.ok(caseRecord.notes.some((note) => /当前规则/.test(note)))
  assert.ok(!caseRecord.checks.some((check) =>
    /结算规则版本列表对象数组|同编码版本降序/.test(check.name)))
})

test('readonly suite source has no write API or business-response logging', () => {
  const source = fs.readFileSync(
    new URL('../suites/procurement-foundation-readonly.mjs', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(source, /api\.(post|put|delete|request|upload)\s*\(/)
  assert.doesNotMatch(source, /console\.(log|error|warn)\s*\(/)
  assert.match(source, /resultCeiling: 'PARTIAL'/)
})
