import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareCostRuleStagePurchase, assertCostStageCollectDatabase } from '../fixtures/cost-rule-stage-closure.mjs'

const ok = (data) => ({ code: 0, data: structuredClone(data) })
const mesOk = (data) => ({ code: 200, success: true, data: structuredClone(data) })
const settings = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083', apiUrl: 'http://127.0.0.1:48083/admin-api',
  webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}

// These formal API doubles never contact an environment or execute SQL.
const purchaseDouble = ({
  missing, waitingApproval = false, templateResponse = mesOk,
  warehouseDetail, warehouseTree
} = {}) => {
  const fixture = {
    caseId: 'COST-034', scenario: 'rule-stage', runId: 'unit-purchase-stage', tenantId: '1',
    month: '2200-01', suffix: 'ABCDEF123456', versionNo: 'E2E-C034-ABCDEF123456',
    modelId: '102', periodId: '101',
    remark: 'CFOR-E2E:costScenario:rule-stage:unit-purchase-stage:ABCDEF123456:tenant=1:org=1:month=2200-01'
  }
  const calls = []
  let material
  let warehouse
  let order
  let notice
  let receipt
  const api = {
    async getBusiness (endpoint) {
      calls.push({ method: 'GET', endpoint })
      if (endpoint === '/cost/periods/101') return ok({
        id: '101', modelVersionId: fixture.modelId, period: fixture.month, status: 'ACCOUNTING'
      })
      if (endpoint === '/cost/model-versions/102') return ok({
        id: fixture.modelId, versionNo: fixture.versionNo, remark: fixture.remark, status: 'LOCKED'
      })
      if (endpoint.startsWith('/mes/basMaterial/list/')) return templateResponse({
        records: missing === 'material' ? [] : [{ id: '103', unitId: '104' }]
      })
      if (endpoint.startsWith('/erp/account/page?')) return ok({
        list: missing === 'account' ? [] : [{ id: '105', status: 0 }]
      })
      if (endpoint.startsWith('/mes/quality/qualityPlan/')) return mesOk({
        records: missing === 'plan' ? [{ id: '106', publishStatus: 0 }] : [{ id: '106', publishStatus: 1 }]
      })
      if (endpoint.startsWith('/mes/fillRule/list?')) return mesOk({
        records: missing === 'number-rule' ? [] : [{ id: '107', ruleCode: 'qc_zjd_bill_no' }]
      })
      if (endpoint === '/mes/basMaterial/queryById?id=201') return mesOk(material)
      if (endpoint === '/mes/wmsWareHouse/allTree') {
        return mesOk(warehouseTree || [{ id: '202', name: warehouse?.name, pid: '0', children: [] }])
      }
      if (endpoint === '/mes/wmsWareHouse/queryById?id=202') return mesOk(warehouseDetail || warehouse)
      if (endpoint === '/erp/purchase-order/get?id=204') return ok(order)
      if (endpoint === '/mes/wms/arrival-notice/get?id=205') return ok(notice)
      if (endpoint === '/erp/purchase-in/get?id=206') return ok(receipt)
      assert.fail(`unexpected GET ${endpoint}`)
    },
    async postBusiness (endpoint, body) {
      calls.push({ method: 'POST', endpoint, body: structuredClone(body) })
      if (endpoint === '/mes/basMaterial/add') { material = { ...body, id: '201' }; return mesOk('201') }
      if (endpoint === '/mes/quality/qualityMaterial/addBatch') return mesOk('batch added')
      if (endpoint === '/mes/wmsWareHouse/add') { warehouse = { ...body, id: '202' }; return mesOk('added') }
      if (endpoint === '/base/partner/create') return ok('203')
      if (endpoint === '/erp/purchase-order/create') {
        order = { ...body, id: '204', billNo: 'UNIT-PO', items: [{ ...body.items[0], id: '2041' }] }
        return ok('204')
      }
      if (endpoint === '/mes/wms/arrival-notice/create') {
        notice = { ...body, id: '205', status: 0 }
        return ok('205')
      }
      if (endpoint === '/mes/wms/arrival-notice/submit?id=205') { notice.status = 10; return ok(true) }
      if (endpoint === '/erp/purchase-in/create') {
        receipt = { ...body, id: '206', no: 'UNIT-IN', status: 10,
          items: [{ ...body.items[0], id: '2061' }] }
        return ok('206')
      }
      assert.fail(`unexpected POST ${endpoint}`)
    },
    async putBusiness (endpoint) {
      calls.push({ method: 'PUT', endpoint })
      assert.equal(endpoint, '/erp/purchase-in/update-status?id=206&status=20')
      if (!waitingApproval) receipt.status = 20
      return ok(true)
    }
  }
  const context = {
    api, record: { runId: fixture.runId, environment: { tenantId: '1' } },
    caseRecord: { id: 'COST-034', caseId: 'COST-034', fixtures: { costScenario: fixture } }
  }
  const dependencies = {
    settings, writeFixtures: true,
    async assertLocalWriteSafety () { calls.push({ method: 'SAFETY' }) }
  }
  return { context, fixture, dependencies, calls }
}

test('collect preparation accepts MES Result 200/true and CommonResult 0 in the formal audited purchase chain', async () => {
  const run = purchaseDouble()
  const result = await prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies)
  assert.equal(result.available, true)
  assert.equal(result.receipt.status, 20)
  assert.equal(run.fixture.purchaseOrderId, '204')
  assert.equal(run.fixture.purchaseInId, '206')
  assert.equal(run.fixture.materialId, '201')
  assert.equal(run.fixture.warehouseId, '202')
  assert.equal(run.calls.filter((row) => row.endpoint === '/mes/wmsWareHouse/add').length, 1)
  assert.equal(run.calls.filter((row) => row.endpoint === '/mes/wmsWareHouse/queryById?id=202').length, 1)
  assert.equal(run.calls[0].method, 'SAFETY')
  const quality = run.calls.find((row) => row.endpoint === '/mes/quality/qualityMaterial/addBatch')
  assert.deepEqual(quality.body, [{
    materialId: '201', planId: '106', type: '101', effectiveFrom: '2200-01-01',
    isDefault: true, priority: 999
  }])
  const inbound = run.calls.find((row) => row.endpoint === '/erp/purchase-in/create')
  assert.equal(inbound.body.inTime, '2200-01-06T10:00:00')
  assert.equal(inbound.body.businessType, 'NORMAL')
  assert.equal(inbound.body.items[0].warehouseId, '202')
  assert.equal(inbound.body.items[0].productId, '201')
  assert.ok(!run.calls.some((row) => row.method !== 'GET' &&
    /qualityPlan|fillRule|options|control-rules|rule-hits|\/cost\//.test(row.endpoint || '')))
})

test('warehouse ownership uses the formal tree DTO only for locating, then validates full detail fields', async () => {
  const run = purchaseDouble({
    warehouseDetail: {
      id: '202', name: 'E2E-C034-WH-ABCDEF123456', code: 'E2E-C034-WH-ABCDEF123456',
      mark: 'CFOR-E2E:costScenario:rule-stage:unit-purchase-stage:ABCDEF123456:tenant=1:org=1:month=2200-01',
      pid: '0', isEnabled: true, areaEnabled: false, locationEnabled: false, countInAvailable: true
    },
    warehouseTree: [{
      id: '202', name: 'E2E-C034-WH-ABCDEF123456', pid: '0', children: []
    }]
  })
  const result = await prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies)
  assert.equal(result.available, true)
  assert.equal(run.fixture.warehouseId, '202')
  const tree = run.calls.find((row) => row.endpoint === '/mes/wmsWareHouse/allTree')
  assert.equal(tree.method, 'GET')
  assert.equal(run.calls.filter((row) => row.endpoint === '/mes/wmsWareHouse/add').length, 1)
})

test('warehouse ownership rejects duplicate tree names and mismatched detail without retrying creation', async (t) => {
  await t.test('duplicate tree candidates', async () => {
    const run = purchaseDouble({
      warehouseTree: [
        { id: '202', name: 'E2E-C034-WH-ABCDEF123456', pid: '0', children: [] },
        { id: '203', name: 'E2E-C034-WH-ABCDEF123456', pid: '0', children: [] }
      ]
    })
    await assert.rejects(() => prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies),
      /树节点唯一性/)
    assert.equal(run.calls.filter((row) => row.endpoint === '/mes/wmsWareHouse/add').length, 1)
    assert.equal(run.calls.filter((row) => row.endpoint?.startsWith('/mes/wmsWareHouse/queryById')).length, 0)
  })
  const owned = {
    id: '202', name: 'E2E-C034-WH-ABCDEF123456', code: 'E2E-C034-WH-ABCDEF123456',
    mark: 'CFOR-E2E:costScenario:rule-stage:unit-purchase-stage:ABCDEF123456:tenant=1:org=1:month=2200-01',
    pid: '0', isEnabled: true, areaEnabled: false, locationEnabled: false, countInAvailable: true
  }
  for (const altered of [
    { id: '999' }, { name: 'FOREIGN' }, { code: 'FOREIGN' }, { mark: 'FOREIGN-RUN' },
    { mark: undefined }, { pid: '999' }, { isEnabled: false }, { areaEnabled: true },
    { locationEnabled: true }, { countInAvailable: false }
  ]) await t.test(`mismatched detail ${Object.keys(altered)[0]}`, async () => {
    const run = purchaseDouble({
      warehouseDetail: { ...owned, ...altered }
    })
    await assert.rejects(() => prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies),
      /仓库详情所有权/)
    assert.equal(run.calls.filter((row) => row.endpoint === '/mes/wmsWareHouse/add').length, 1)
    assert.equal(run.calls.filter((row) => row.endpoint === '/mes/wmsWareHouse/queryById?id=202').length, 1)
    assert.equal(run.fixture.warehouseId, undefined)
    assert.ok(!run.calls.some((row) => row.method === 'POST' &&
      /partner|purchase-order|arrival-notice|purchase-in/.test(row.endpoint || '')))
  })
})

test('purchase preparation rejects failed or incomplete envelopes before any purchase writes', async (t) => {
  const templates = { records: [{ id: '103', unitId: '104' }] }
  const responses = [
    ['MES failure', { code: 200, success: false, data: templates }],
    ['MES missing success', { code: 200, data: templates }],
    ['MES non-boolean success', { code: 200, success: 'true', data: templates }],
    ['MES string code', { code: '200', success: true, data: templates }],
    ['MES missing data', { code: 200, success: true }],
    ['MES null data', { code: 200, success: true, data: null }],
    ['CommonResult failure', { code: 0, success: false, data: templates }],
    ['CommonResult missing data', { code: 0 }],
    ['CommonResult null data', { code: 0, data: null }],
    ['business error', { code: 500, success: true, data: templates }],
    ['HTTP status only', { status: 200, data: templates }],
    ['empty response', null]
  ]
  for (const [name, response] of responses) await t.test(name, async () => {
    const run = purchaseDouble({ templateResponse: () => structuredClone(response) })
    await assert.rejects(() => prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies),
      /正式API未返回成功业务数据/)
    assert.deepEqual(run.calls, [
      { method: 'SAFETY' },
      { method: 'GET', endpoint: '/cost/periods/101' },
      { method: 'GET', endpoint: '/cost/model-versions/102' },
      { method: 'GET', endpoint: '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1' }
    ])
    assert.equal(run.fixture.materialId, undefined)
    assert.equal(run.fixture.purchaseInId, undefined)
  })
})

test('missing shared prerequisites remain explicit GAP without creating or changing anything', async (t) => {
  for (const missing of ['material', 'account', 'plan', 'number-rule']) await t.test(missing, async () => {
    const run = purchaseDouble({ missing })
    const result = await prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies)
    assert.equal(result.available, false)
    assert.equal(result.code, 'COLLECT_PURCHASE_PREREQUISITES_MISSING')
    assert.ok(run.calls.every((row) => ['GET', 'SAFETY'].includes(row.method)))
    assert.equal(run.fixture.materialId, undefined)
  })
})

test('ERP receipt approval cannot be bypassed when the official update does not become audited', async () => {
  const run = purchaseDouble({ waitingApproval: true })
  await assert.rejects(() => prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies),
    /审核状态或来源明细不一致/)
  assert.equal(run.fixture.purchaseInId, '206')
  assert.ok(!run.calls.some((row) => /source-snapshot/.test(row.endpoint || '')))
})

test('purchase preparation refuses disabled writes, production targets, foreign scenarios and failed local safety', async (t) => {
  for (const mutate of [
    (run) => { run.dependencies.writeFixtures = false },
    (run) => { run.dependencies.settings = { ...settings, target: 'production' } },
    (run) => { run.fixture.runId = 'foreign' },
    (run) => { run.fixture.month = '2026-10' },
    (run) => { run.dependencies.assertLocalWriteSafety = async () => { throw new Error('safety rejected') } }
  ]) await t.test(mutate.toString(), async () => {
    const run = purchaseDouble()
    mutate(run)
    await assert.rejects(() => prepareCostRuleStagePurchase(run.context, run.fixture, run.dependencies))
    assert.deepEqual(run.calls, [])
  })
})

test('collect SQL check requires exact ERP main/line/version and quantities, not just a stage PASS row', () => {
  const source = { id: '10', status: 'CONFIRMED', lines: [{
    sourceModule: 'ERP', sourceType: 'PURCHASE_RECEIPT', sourceId: '11',
    sourceLineId: '12', sourceVersion: 'v1', productCode: '13', quantity: 2, materialAmount: 123.45
  }] }
  const database = [['collect-line', '10', 'ERP', 'PURCHASE_RECEIPT', '11', '12', 'v1',
    '13', '2.000000', '123.450000', 'CONFIRMED']]
  assertCostStageCollectDatabase({ database }, source)
  assert.throws(() => assertCostStageCollectDatabase({ database: [] }, source))
  assert.throws(() => assertCostStageCollectDatabase({ database: [...database, ...database] }, source))
  for (let index = 1; index <= 10; index++) {
    const altered = structuredClone(database)
    altered[0][index] = index === 8 || index === 9 ? '0' : 'foreign'
    assert.throws(() => assertCostStageCollectDatabase({ database: altered }, source))
  }
})
