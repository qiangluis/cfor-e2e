import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  erpSalesMenuRoute,
  erpSalesReadOnlyCases,
  erpSalesReadOnlyViews,
  erpSalesReadonlyArray,
  erpSalesReadonlyPage,
  runCase,
  runErpSalesReadonlyContract
} from '../suites/erp-sales.mjs'

const ok = (data) => ({ code: 0, data })
const paged = (rows, useRecords = false) => ok({
  [useRecords ? 'records' : 'list']: rows,
  total: rows.length
})
const record = () => ({ checks: [], notes: [], evidence: [] })

test('sales readonly catalog cases are executable without claiming full acceptance', () => {
  const catalog = JSON.parse(fs.readFileSync(
    new URL('../cases/catalog.json', import.meta.url), 'utf8'
  ))
  const definitions = new Map(catalog.suites.flatMap((suite) =>
    suite.cases.map((item) => [item.id, item])
  ))
  for (const caseId of erpSalesReadOnlyCases) {
    assert.equal(definitions.get(caseId)?.status, 'PARTIAL', caseId)
  }
})

const contract = () => ({
  id: 101,
  customerId: 201,
  businessId: 301,
  auditStatus: 20,
  signStatus: 30,
  sourceType: 20
})
const business = () => ({ id: 301, customerId: 201, name: '正式商机' })
const customer = () => ({ id: 201, name: '正式客户' })
const order = () => ({ id: '701', customerId: '201', status: 20, saleTypeCode: 'SALE_STANDARD' })
const orderDetail = () => ({
  ...order(),
  items: [{ id: '711', count: 2, productId: '801', productUnitId: '11' }]
})
const salesNotice = () => ({
  id: 801,
  salesOrderId: '701',
  status: 20,
  lines: [{
    id: 811,
    itemId: '801',
    unitId: '11',
    quantity: 2,
    shippedQuantity: 1,
    oqcCheckFlag: true,
    oqcRefId: '991'
  }]
})
const salesPlan = () => ({ id: 1001, planTypeCode: 'PLAN_YEAR', name: '年度销售计划' })

function fakeApi(paths) {
  const calls = []
  return {
    calls,
    async getBusiness(path) {
      calls.push(path)
      assert.ok(Object.hasOwn(paths, path), `Unexpected GET ${path}`)
      const value = paths[path]
      return structuredClone(typeof value === 'function' ? value() : value)
    }
  }
}

function fixture(caseId, overrides = {}) {
  const paths = {}
  if (caseId === 'ERP-SALES-001') {
    paths['/crm/contract/page?pageNo=1&pageSize=100'] = paged([contract()])
    paths['/crm/contract/get?id=101'] = ok(contract())
    paths['/crm/business/get?id=301'] = ok(business())
    paths['/crm/customer/get?id=201'] = ok(customer())
  }
  if (caseId === 'ERP-SALES-002') {
    paths['/finance/finReceivable/list/dictText?pageNo=1&pageSize=100'] = paged([{
      id: 401, amt: 100, checkedAmt: 40, srcBillId: '101', srcBillType: 'CrmContract',
      finReceivableEntryList: [{ id: 411, amt: 100, checkedAmt: 40, srcBillId: '101', srcBillType: 'CrmContract' }]
    }], true)
    paths['/finance/finReceipt/list/102/1030?pageNo=1&pageSize=100'] = paged([{
      id: 501, amt: 40, srcBillId: '401', srcBillType: 'FinReceivable'
    }], true)
    paths['/finance/finReceivableCheck/list?pageNo=1&pageSize=100'] = paged([{
      id: 601, amt: 40, checkedAmt: 40, srcBillId: '401', srcBillType: 'FinReceivable'
    }], true)
    paths['/finance/finReceivable/queryById/dictText?id=401'] = ok({ id: 401, amt: 100, checkedAmt: 40 })
    paths['/finance/finReceipt/queryById/dictText?id=501'] = ok({ id: 501, amt: 40 })
    paths['/finance/finReceivableCheck/queryById/dictText?id=601'] = ok({ id: 601, amt: 40 })
  }
  if (caseId === 'ERP-SALES-003') {
    paths['/erp/sale-order/page?pageNo=1&pageSize=100'] = paged([order()])
    paths['/erp/sale-order/get?id=701'] = ok(orderDetail())
    paths['/mes/wms/sales-notice/page?salesOrderId=701&withLines=true&pageSize=100'] =
      ok([salesNotice()])
  }
  if (caseId === 'ERP-SALES-004') {
    paths['/mes/wms/sales-notice/page?withLines=true&pageSize=100'] = ok([salesNotice()])
    paths['/mes/wms/sales-notice/get?id=801'] = ok(salesNotice())
    paths['/erp/sale-out/page?pageNo=1&pageSize=100'] = paged([{
      id: 901, orderId: '701', status: 20
    }])
    paths['/erp/sale-order/get?id=701'] = ok(orderDetail())
    paths['/erp/sale-out/get?id=901'] = ok({
      id: 901, orderId: '701', status: 20,
      items: [{ id: '911', orderItemId: '711', productId: '801', productUnitId: '11', count: 1 }]
    })
    paths['/mes/quality/qualityInspection/getQualityInspectionByOrderId/dictText?orderId=701&type=201'] =
      ok([{ id: '991', type: '201', srcBillType: 'MesStkIo' }])
  }
  if (caseId === 'ERP-SALES-007') {
    paths['/system/dict-data/page?pageNo=1&pageSize=100&dictType=erp_sale_type'] =
      paged([{ id: 1, dictType: 'erp_sale_type', value: 'SALE_STANDARD', label: '标准销售', status: 0 }])
    paths['/system/dict-data/page?pageNo=1&pageSize=100&dictType=crm_sales_plan_type'] =
      paged([{ id: 2, dictType: 'crm_sales_plan_type', value: 'PLAN_YEAR', label: '年度计划', status: 0 }])
    paths['/erp/sale-order/page?pageNo=1&pageSize=100'] = paged([order()])
    paths['/erp/sale-order/get?id=701'] = ok(order())
    paths['/crm/sales-plan/page?pageNo=1&pageSize=100'] = paged([salesPlan()])
    paths['/crm/sales-plan/get?id=1001'] = ok(salesPlan())
  }
  Object.assign(paths, overrides)
  return fakeApi(paths)
}

async function runReadonly(caseId, overrides = {}) {
  const api = fixture(caseId, overrides)
  const caseRecord = record()
  const result = await runErpSalesReadonlyContract({ caseId, api, caseRecord })
  return { api, caseRecord, result }
}

test('ERP sales readonly parsers reject malformed envelopes and keep WMS array contract', () => {
  assert.deepEqual(erpSalesReadonlyPage(paged([]), 'page'), { rows: [], total: 0 })
  assert.deepEqual(erpSalesReadonlyPage(paged([], true), 'records'), { rows: [], total: 0 })
  assert.deepEqual(erpSalesReadonlyArray(ok([]), 'WMS'), [])
  for (const payload of [
    { code: 500, data: { list: [], total: 0 } },
    ok({ list: [], total: '0' }),
    ok({ list: [{}], total: 0 }),
    ok({ records: {}, total: 0 }),
    ok({ list: [], total: -1 })
  ]) assert.throws(() => erpSalesReadonlyPage(payload, 'page'))
  for (const payload of [ok({ list: [] }), ok({}), ok([null])]) {
    assert.throws(() => erpSalesReadonlyArray(payload, 'WMS'))
  }
})

test('ERP sales route resolution uses authorized component, nested paths and aliases', () => {
  const menus = [{
    path: '/sales',
    children: [{
      path: 'crm',
      children: [{
        path: 'contract',
        component: '@/views/crm/jixu/contract/index.vue'
      }]
    }]
  }]
  assert.equal(erpSalesMenuRoute(menus, erpSalesReadOnlyViews['ERP-SALES-001'].components),
    '/sales/crm/contract')
  assert.equal(erpSalesMenuRoute(menus, 'crm/contract/index'), null)
  assert.equal(
    erpSalesMenuRoute([{
      path: 'sales-plan',
      component: 'crm/jixu/salesPlan/index.vue?section=master'
    }], erpSalesReadOnlyViews['ERP-SALES-007'].components),
    '/sales-plan'
  )
  assert.deepEqual(erpSalesReadOnlyCases, [
    'ERP-SALES-001', 'ERP-SALES-002', 'ERP-SALES-003', 'ERP-SALES-004', 'ERP-SALES-007'
  ])
})

for (const caseId of erpSalesReadOnlyCases) {
  test(`${caseId} real GET contract records assertions and always returns PARTIAL`, async () => {
    const { result, caseRecord, api } = await runReadonly(caseId)
    assert.equal(result.partial, true)
    assert.ok(caseRecord.checks.length > 0, caseId)
    assert.ok(caseRecord.checks.every((check) => check.passed), caseId)
    assert.match(caseRecord.notes.at(-1), /仅执行 .* GET .*始终 PARTIAL/)
    assert.ok(api.calls.every((path) => !/\/(create|update|delete|submit|publish|check|void|save|add)\b/.test(path)))
  })
}

test('empty tenant facts stay PARTIAL and do not fabricate detail or association passes', async () => {
  const emptyByCase = {
    'ERP-SALES-001': {
      '/crm/contract/page?pageNo=1&pageSize=100': paged([])
    },
    'ERP-SALES-002': {
      '/finance/finReceivable/list/dictText?pageNo=1&pageSize=100': paged([], true),
      '/finance/finReceipt/list/102/1030?pageNo=1&pageSize=100': paged([], true),
      '/finance/finReceivableCheck/list?pageNo=1&pageSize=100': paged([], true)
    },
    'ERP-SALES-003': {
      '/erp/sale-order/page?pageNo=1&pageSize=100': paged([])
    },
    'ERP-SALES-004': {
      '/mes/wms/sales-notice/page?withLines=true&pageSize=100': ok([])
    },
    'ERP-SALES-007': {
      '/system/dict-data/page?pageNo=1&pageSize=100&dictType=erp_sale_type': paged([]),
      '/system/dict-data/page?pageNo=1&pageSize=100&dictType=crm_sales_plan_type': paged([]),
      '/erp/sale-order/page?pageNo=1&pageSize=100': paged([]),
      '/crm/sales-plan/page?pageNo=1&pageSize=100': paged([])
    }
  }
  for (const caseId of erpSalesReadOnlyCases) {
    const { result, caseRecord, api } = await runReadonly(caseId, emptyByCase[caseId])
    assert.equal(result.partial, true, caseId)
    assert.ok(caseRecord.notes.some((note) => note.startsWith('前置缺失：')), caseId)
    assert.ok(!api.calls.some((path) => /\/get\?id=/.test(path)), caseId)
  }
})

test('ERP-SALES-001 rejects a contract detail that changes the page source IDs', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-001', {
    '/crm/contract/get?id=101': ok({ ...contract(), customerId: 999 })
  }), /合同详情与分页客户/)
})

test('manual contracts may have no business and never request an empty business ID', async () => {
  const manual = { ...contract(), sourceType: 10, businessId: null }
  const { result, api } = await runReadonly('ERP-SALES-001', {
    '/crm/contract/page?pageNo=1&pageSize=100': paged([manual]),
    '/crm/contract/get?id=101': ok(manual)
  })
  assert.equal(result.partial, true)
  assert.ok(!api.calls.some((path) => path.startsWith('/crm/business/get')))
})

test('ERP-SALES-002 rejects a financial sample whose checked amount exceeds its bill', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-002', {
    '/finance/finReceivable/list/dictText?pageNo=1&pageSize=100':
      paged([{ id: 401, amt: 100, checkedAmt: 101, srcBillId: '101', srcBillType: 'CrmContract' }], true)
  }), /核销金额不超过应收金额/)
})

test('ERP-SALES-002 rejects check-entry amt greater than its real srcBillAmt', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-002', {
    '/finance/finReceivableCheck/queryById/dictText?id=601': ok({
      id: 601,
      finReceivableCheckEntryList: [{
        id: 611, checkSide: '1', amt: 1000, srcBillAmt: 1
      }]
    })
  }), /核销金额不超过应收金额/)
})

test('ERP-SALES-002 rejects nonnumeric comparable amounts rather than skipping them', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-002', {
    '/finance/finReceivable/queryById/dictText?id=401': ok({
      id: 401, amt: 100, checkedAmt: 'invalid'
    })
  }), /有限十进制数/)
})

test('ERP-SALES-003 rejects shipped quantity greater than the notice quantity', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-003', {
    '/mes/wms/sales-notice/page?salesOrderId=701&withLines=true&pageSize=100':
      ok([{ ...salesNotice(), lines: [{ ...salesNotice().lines[0], shippedQuantity: 3 }] }])
  }), /WMS 发货通知明细数量满足/)
})

test('missing shipped quantity remains a gap and cannot produce a quantity-boundary pass', async () => {
  const { caseRecord } = await runReadonly('ERP-SALES-003', {
    '/mes/wms/sales-notice/page?salesOrderId=701&withLines=true&pageSize=100':
      ok([{ ...salesNotice(), lines: [{ ...salesNotice().lines[0], shippedQuantity: null }] }])
  })
  assert.ok(caseRecord.notes.some((note) => note.includes('没有 shippedQuantity')))
  assert.ok(!caseRecord.checks.some((check) => check.name.includes('满足已发/应发边界')))
})

const outItem = (overrides = {}) => ({
  id: '911', orderItemId: '711', productId: '801', productUnitId: '11', count: 1,
  ...overrides
})
const outDetail = (items) => ok({ id: 901, orderId: '701', status: 20, items })

test('ERP-SALES-004 rejects invalid output quantities and mismatched product/unit references', async () => {
  for (const item of [
    outItem({ count: 'invalid' }),
    outItem({ productId: '802' }),
    outItem({ productUnitId: '12' })
  ]) {
    await assert.rejects(() => runReadonly('ERP-SALES-004', {
      '/erp/sale-out/get?id=901': outDetail([item])
    }), /数量为有限非负数|逐行对应订单明细/)
  }
})

test('ERP-SALES-004 cannot borrow another product quantity to cover an over-shipment', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-004', {
    '/erp/sale-order/get?id=701': ok({
      ...order(),
      items: [
        ...orderDetail().items,
        { id: '712', productId: '802', productUnitId: '11', count: 100 }
      ]
    }),
    '/mes/wms/sales-notice/page?withLines=true&pageSize=100': ok([{
      ...salesNotice(),
      lines: [
        ...salesNotice().lines,
        { id: 812, itemId: '802', unitId: '11', quantity: 100, shippedQuantity: 0 }
      ]
    }]),
    '/erp/sale-out/get?id=901': outDetail([outItem({ count: 3 })])
  }), /累计数量不超过对应订单明细数量/)
})

test('ERP-SALES-004 sums repeated order-item output rows before comparing the quota', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-004', {
    '/erp/sale-out/get?id=901': outDetail([
      outItem({ count: 1.5 }), outItem({ id: '912', count: 1 })
    ])
  }), /累计数量不超过对应订单明细数量/)
})

test('decimal quantity totals do not misreport 0.1 plus 0.2 as exceeding 0.3', async () => {
  const { result } = await runReadonly('ERP-SALES-004', {
    '/erp/sale-order/get?id=701': ok({
      ...order(), items: [{ ...orderDetail().items[0], count: '0.3' }]
    }),
    '/erp/sale-out/get?id=901': outDetail([
      outItem({ count: 0.1 }), outItem({ id: '912', count: 0.2 })
    ])
  })
  assert.equal(result.partial, true)
})

test('legacy invented output source fields cannot establish the actual orderId association', async () => {
  const { api, caseRecord } = await runReadonly('ERP-SALES-004', {
    '/erp/sale-out/page?pageNo=1&pageSize=100': paged([{
      id: 901, srcBillId: '701', salesNoticeId: 801, status: 20
    }])
  })
  assert.ok(!api.calls.includes('/erp/sale-out/get?id=901'))
  assert.ok(caseRecord.notes.some((note) => note.includes('没有可确认来源的销售出库样本')))
})

test('ERP-SALES-004 rejects process inspection or an unrelated OQC ID as notice evidence', async () => {
  for (const row of [
    { id: '991', type: '300', srcBillType: 'MesProdWork', srcBillId: '999' },
    { id: '992', type: '201', srcBillType: 'MesStkIo' }
  ]) {
    await assert.rejects(() => runReadonly('ERP-SALES-004', {
      '/mes/quality/qualityInspection/getQualityInspectionByOrderId/dictText?orderId=701&type=201':
        ok([row])
    }), /只返回 201 类型|质检 ID 精确对应/)
  }
})

test('OQC rows without an explicit notice reference remain a gap, not an association pass', async () => {
  const { caseRecord } = await runReadonly('ERP-SALES-004', {
    '/mes/wms/sales-notice/page?withLines=true&pageSize=100': ok([{
      ...salesNotice(),
      lines: [{ ...salesNotice().lines[0], oqcRefId: null }]
    }])
  })
  assert.ok(caseRecord.notes.some((note) => note.includes('没有明确 oqcRefId')))
  assert.ok(!caseRecord.checks.some((check) => check.name.includes('质检 ID 精确对应')))
})

test('ERP-SALES-007 rejects a formal order snapshot that is absent from the enabled dictionary', async () => {
  await assert.rejects(() => runReadonly('ERP-SALES-007', {
    '/erp/sale-order/page?pageNo=1&pageSize=100':
      paged([{ ...order(), saleTypeCode: 'DISABLED_TYPE' }])
  }), /销售订单保存稳定销售类型编码/)
})

test('readonly wrapper resolves the menu route, waits for the table and performs no writes', async () => {
  const api = fixture('ERP-SALES-001', {
    '/crm/contract/page?pageNo=1&pageSize=100': paged([])
  })
  api.getBusiness = async (path) => {
    if (path === '/system/auth/get-permission-info') {
      api.calls.push(path)
      return ok({ menus: [{
        path: '/sales',
        children: [{
          path: 'contracts',
          component: 'crm/jixu/contract/index.vue'
        }]
      }] })
    }
    return fakeApi({
      '/crm/contract/page?pageNo=1&pageSize=100': paged([])
    }).getBusiness(path)
  }
  let currentUrl = 'http://127.0.0.1:9151/'
  let opened
  const page = {
    url: () => currentUrl,
    locator: (selector) => {
      assert.equal(selector, '.el-table__header-wrapper th')
      return { allInnerTexts: async () => ['合同编号', '客户名称'] }
    }
  }
  const result = await runCase({
    caseId: 'ERP-SALES-001',
    page,
    record: {},
    caseRecord: record(),
    outputDir: '/unused'
  }, {
    readonly: true,
    login: async () => 'unit-token',
    createApiClient: () => api,
    openRoute: async (_page, route, options) => {
      opened = { route, options }
      currentUrl = `http://127.0.0.1:9151${route}`
    },
    saveScreenshot: async () => '/unit-only/erp-sales-001.png'
  })
  assert.equal(result.partial, true)
  assert.equal(opened.route, '/sales/contracts')
  assert.equal(opened.options.readySelector, erpSalesReadOnlyViews['ERP-SALES-001'].readySelector)
  assert.ok(api.calls.includes('/system/auth/get-permission-info'))
  assert.ok(!api.calls.some((path) => /\/(create|update|delete|submit|publish|check|void)\b/.test(path)))
})

test('readonly source section contains only GET calls and all five branches remain outside write cases', () => {
  const source = fs.readFileSync(new URL('../suites/erp-sales.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function runErpSalesReadonlyContract')
  const end = source.indexOf('async function openErpSalesReadonlyView')
  const readonlyContract = source.slice(start, end)
  assert.doesNotMatch(readonlyContract, /api\.(post|put|delete|request)|fetch\([^)]*method:\s*['"](?:POST|PUT|DELETE)/)
  assert.match(readonlyContract, /return \{ partial: true/)
  assert.deepEqual(Object.keys(erpSalesReadOnlyViews), erpSalesReadOnlyCases)
})

test('readonly table views exclude hidden VXE fixed-column copies', () => {
  for (const id of ['ERP-SALES-002', 'ERP-SALES-003']) {
    const view = erpSalesReadOnlyViews[id]
    assert.match(view.readySelector, /^\.vxe-table--header-wrapper/)
    assert.match(view.headerSelector, /^\.vxe-table--header-wrapper/)
    assert.ok(view.readySelector.includes(':not(.fixed--hidden):visible'))
    assert.ok(view.headerSelector.includes(':not(.fixed--hidden):visible'))
    assert.ok(view.headers.length > 0)
  }
  for (const id of ['ERP-SALES-001', 'ERP-SALES-004']) {
    const view = erpSalesReadOnlyViews[id]
    assert.match(view.readySelector, /^\.el-table__header-wrapper/)
    assert.ok(view.readySelector.includes(':has-text('))
    assert.ok(view.headers.length > 0)
  }
})

test('sales plan readonly view checks all dimensions and workflow steps, not a hidden table', () => {
  const view = erpSalesReadOnlyViews['ERP-SALES-007']
  assert.match(view.readySelector, /^\.sales-plan-page \.dimension-tabs button/)
  assert.doesNotMatch(view.headerSelector, /table/)
  assert.ok(view.headerSelector.includes('.workflow-step strong:visible'))
  assert.deepEqual(view.headers, [
    '产品系列年度计划', '部门年/季/月度计划', '部门/人员计划',
    '计划总表', '任务组分解', '季月人员分配', '执行跟踪'
  ])
})
