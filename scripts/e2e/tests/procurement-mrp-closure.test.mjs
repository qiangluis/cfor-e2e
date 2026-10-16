import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MRP_PLAN_IDEMPOTENCY_REJECTION,
  MRP_PLAN_PATH,
  PROCUREMENT_MRP_CHECKS,
  assertMrpPlanIdempotencyRejection,
  buildMrpCalculationRequest,
  bindDedicatedSupplier,
  runProcurementMrpClosure
} from '../fixtures/procurement-mrp-closure.mjs'

const ids = Object.freeze({
  supplier: '2109500602170789810',
  finished: '2109500602170789820',
  component: '2109500602170789830',
  work: '2109500602170789840',
  request: '2109500602170789850',
  requestItem: '2109500602170789860',
  order: '2109500602170789870',
  task: '2109500602170789890'
})
const calculationId = '8c218aba-1487-4e79-8cd8-e7151c78dc45'

const ok = (data) => ({ code: 0, data })
const paged = (rows) => ok({ records: rows, total: rows.length })
const record = () => ({ checks: [], notes: [], evidence: [], fixtures: {} })

function executionFixture () {
  return {
    marker: 'AUTOTEST-PROC-001-UNIT',
    material: { id: ids.finished, identity: 'AUTOTEST-FG' },
    component: { id: ids.component, identity: 'AUTOTEST-RM' },
    works: [{ id: ids.work, workTicketNo: 'AUTOTEST-WORK' }],
    tasks: [{ id: ids.task, workTicketId: ids.work }],
    fixtureRecord: {},
    setupCalls: 0,
    shortageCalls: 0,
    cleanupCalls: 0,
    async setup () { this.setupCalls++ },
    async voidOpeningInventoryForShortage () {
      this.shortageCalls++
      this.fixtureRecord.shortage = { taskId: this.tasks[0].id }
    },
    async cleanup () { this.cleanupCalls++ }
  }
}

const component = (defaultMerchant = '') => ({
  id: ids.component,
  code: 'AUTOTEST-RM',
  name: 'AUTOTEST-PROC-001-UNIT-RM',
  auxName: 'AUTOTEST-PROC-001-UNIT-RM',
  unitId: '2109500602170789880',
  inventoryNature: 'STOCK',
  virtualGoods: 'N',
  purchased: 'Y',
  produced: 'Y',
  saled: 'Y',
  parented: 'N',
  isMaterial: 'Y',
  assembled: 'N',
  soned: 'N',
  batchManaged: 'N',
  oneBarcode: 'N',
  periodManaged: 'N',
  colorManaged: 'N',
  brandManaged: 'N',
  backflush: 'N',
  participateKitting: 'N',
  source: 'mixed',
  leadTime: 1,
  bufferTime: 1,
  defaultMerchant,
  remark: 'AUTOTEST-PROC-001-UNIT'
})

const calculation = ({ shortage = true, demandChanges = {} } = {}) => ok({
  calculationId,
  summary: {
    totalOrders: 1,
    totalMaterials: 1,
    shortageCount: shortage ? 1 : 0,
    purchaseCount: shortage ? 1 : 0
  },
  demandPlan: [{
    materialId: ids.component,
    currentStock: 0,
    lockStock: 0,
    inTransitStock: shortage ? 1 : 3,
    availableStock: shortage ? 1 : 3,
    totalDemand: 3,
    netDemand: shortage ? 2 : 0,
    suggestPurchase: shortage ? 2 : 0,
    status: shortage ? '缺料' : '正常',
    ...demandChanges
  }],
  purchaseSuggestion: shortage ? [{
    materialId: ids.component,
    materialCode: 'AUTOTEST-RM',
    supplierId: ids.supplier,
    supplierName: 'UNIT-SUPPLIER',
    suggestQty: 2
  }] : [],
  missingBomProducts: []
})

function harness ({
  directOrder = false,
  shortage = true,
  duplicateRows = 1,
  requestDeleteError = '',
  fixtureCleanupError = '',
  demandChanges = {},
  previewChanges = {},
  startRejection = {},
  afterStartStatus = 1
} = {}) {
  const fixture = executionFixture()
  const calls = []
  fixture.cleanup = async () => {
    fixture.cleanupCalls++
    calls.push(['FIXTURE-CLEANUP'])
    if (fixtureCleanupError) throw new Error(fixtureCleanupError)
  }
  let material = component()
  let generated = false
  let startAttempted = false
  const request = {
    id: ids.request,
    srcBillType: 'MRP',
    srcBillId: calculationId,
    status: 0,
    processInstanceId: '2aa8fcce-1f23-4fae-8ac8-11770fa70dc6',
    itemsList: [{
      id: ids.requestItem,
      productId: ids.component,
      productUnitId: material.unitId,
      inCount: 2
    }]
  }
  const sourceRows = () => !generated || directOrder ? [] : Array.from(
    { length: duplicateRows },
    (_, index) => ({ ...request, id: String(BigInt(ids.request) + BigInt(index)) })
  )
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/erp/supplier/simple-list') {
        return ok([{ id: ids.supplier, name: 'UNIT-SUPPLIER' }])
      }
      if (path === `/mes/basMaterial/queryById?id=${ids.component}`) return ok(material)
      if (path === `/mes/prodWorkTask/feed-pick-preview?taskId=${ids.task}`) {
        assert.equal(fixture.shortageCalls, 1)
        return ok({
          taskId: ids.task,
          materialList: [{
            materialId: ids.component,
            requiredQty: 3,
            remainingPickQty: 3,
            stockQty: 0
          }],
          ...previewChanges
        })
      }
      if (path === `/mes/prodWork/queryById?id=${ids.work}`) {
        return ok({
          ...fixture.works[0],
          status: startAttempted ? afterStartStatus : 1
        })
      }
      if (path === '/mes/mrp/history?pageNo=1&pageSize=100') {
        return paged([{ id: calculationId, status: 3, idempotencyKey: fixture.marker }])
      }
      if (path.startsWith('/erp/purchase/order/request/page?')) return paged(sourceRows())
      if (path.startsWith('/erp/purchase/order/request/get?id=')) {
        const requestId = decodeURIComponent(path.slice('/erp/purchase/order/request/get?id='.length))
        return ok({ ...request, id: requestId })
      }
      if (path.startsWith('/erp/purchase-order/page?')) {
        return ok({ list: generated && directOrder ? [{ id: ids.order, remark: `由MRP运算生成 - 运算ID: ${calculationId}` }] : [], total: generated && directOrder ? 1 : 0 })
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async putBusiness (path, body) {
      calls.push(['PUT', path, body])
      assert.equal(path, '/mes/basMaterial/edit')
      assert.equal(body.id, ids.component)
      assert.equal(body.defaultMerchant, ids.supplier)
      material = { ...material, ...body }
      return ok('编辑成功')
    },
    async postBusiness (path, body) {
      calls.push(['POST-BUSINESS', path, body])
      if (path === '/mes/mrp/calculate') {
        assert.deepEqual(body.workIds, [ids.work])
        assert.deepEqual(body.workNos, ['AUTOTEST-WORK'])
        assert.deepEqual(body.materialIds, [ids.finished])
        assert.equal(body.idempotencyKey, fixture.marker)
        assert.equal(body.considerInTransitStock, true)
        return calculation({ shortage, demandChanges })
      }
      if (path === `${MRP_PLAN_PATH}?calculationId=${calculationId}`) {
        assert.equal(startAttempted, true, 'shortage start gate must precede generation')
        assert.equal(generated, false, 'duplicate generation must use the rejection contract')
        generated = true
        return ok(directOrder
          ? '采购订单生成完成！成功创建1个采购单据，共1个供应商。'
          : '采购申请生成完成！成功创建1个采购单据，共1个供应商。')
      }
      throw new Error(`unexpected POST business ${path}`)
    },
    async post (path, body, options) {
      calls.push(['POST-RAW', path, body, options])
      assert.equal(path, '/mes/prodWork/start')
      assert.deepEqual(body, { id: ids.work, prodWorkOrderId: ids.work })
      assert.equal(options.expectedBusinessRejection.code, 400)
      assert.match('工单存在缺料，当前任务没有足够可分配库存，不能开工：AUTOTEST-RM',
        options.expectedBusinessRejection.message)
      startAttempted = true
      return {
        code: 400,
        data: null,
        msg: '工单存在缺料，当前任务没有足够可分配库存，不能开工：AUTOTEST-RM',
        ...startRejection
      }
    },
    async request (method, path, body, options) {
      calls.push([method, path, body, options])
      assert.equal(method, 'POST')
      assert.equal(path, `${MRP_PLAN_PATH}?calculationId=${calculationId}`)
      assert.equal(options.expectedBusinessRejection, MRP_PLAN_IDEMPOTENCY_REJECTION)
      assert.equal(generated, true)
      return {
        code: 500,
        data: null,
        msg: '生成采购计划失败：该运算已生成采购计划，生成时间: 2026-10-12 10:00:00'
      }
    },
    async deleteBusiness (path) {
      calls.push(['DELETE-BUSINESS', path])
      if (requestDeleteError && path.startsWith('/erp/purchase/order/request/delete')) {
        throw new Error(requestDeleteError)
      }
      return ok(true)
    }
  }
  return { api, calls, fixture }
}

function supplierBindingHarness (current = component()) {
  const calls = []
  const fixture = executionFixture()
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/erp/supplier/simple-list') {
        return ok([{ id: ids.supplier, name: 'UNIT-SUPPLIER' }])
      }
      if (path === `/mes/basMaterial/queryById?id=${ids.component}`) {
        return ok(structuredClone(current))
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async putBusiness (path, body) {
      calls.push(['PUT', path, structuredClone(body)])
      assert.equal(path, '/mes/basMaterial/edit')
      assert.equal(body.id, ids.component)
      assert.equal(body.defaultMerchant, ids.supplier)
      current = { ...current, ...body }
      return ok('编辑成功')
    }
  }
  return { api, calls, fixture }
}

for (const missingFields of [['parented'], ['assembled'], ['parented', 'assembled']]) {
  for (const missingKind of ['omitted', 'null']) {
    test(`supplier binding falls back ${missingKind} ${missingFields.join('/')} only on the owned component with evidence`, async () => {
      const current = { ...component(), parented: 'Y', assembled: 'Y' }
      for (const field of missingFields) {
        if (missingKind === 'omitted') delete current[field]
        else current[field] = null
      }
      const input = supplierBindingHarness(current)
      const caseRecord = record()

      const supplier = await bindDedicatedSupplier({
        api: input.api,
        fixture: input.fixture,
        caseRecord
      })

      const puts = input.calls.filter(([method]) => method === 'PUT')
      assert.equal(puts.length, 1)
      assert.equal(puts[0][2].parented, missingFields.includes('parented') ? 'N' : 'Y')
      assert.equal(puts[0][2].assembled, missingFields.includes('assembled') ? 'N' : 'Y')
      assert.deepEqual(input.calls.map(([method, path]) => [method, path]), [
        ['GET', '/erp/supplier/simple-list'],
        ['GET', `/mes/basMaterial/queryById?id=${ids.component}`],
        ['PUT', '/mes/basMaterial/edit'],
        ['GET', `/mes/basMaterial/queryById?id=${ids.component}`]
      ])
      assert.deepEqual(caseRecord.evidence, missingFields.map((field) =>
        `PROC MRP 专属缺料子件 API 回读缺少 ${field}，使用创建夹具已知值 N 继续回写`))
      assert.deepEqual(supplier, { id: ids.supplier, name: 'UNIT-SUPPLIER' })
      assert.deepEqual(input.fixture.mrpSupplier, supplier)
      assert.deepEqual(caseRecord.fixtures.procurementMrp.supplier, supplier)
    })
  }
}

for (const parented of ['Y', 'N']) {
  for (const assembled of ['Y', 'N']) {
    test(`supplier binding preserves API-provided parented=${parented} and assembled=${assembled} without fallback evidence`, async () => {
      const input = supplierBindingHarness({ ...component(), parented, assembled })
      const caseRecord = record()

      await bindDedicatedSupplier({
        api: input.api,
        fixture: input.fixture,
        caseRecord
      })

      const puts = input.calls.filter(([method]) => method === 'PUT')
      assert.equal(puts.length, 1)
      assert.equal(puts[0][2].parented, parented)
      assert.equal(puts[0][2].assembled, assembled)
      assert.deepEqual(caseRecord.evidence, [])
    })
  }
}

for (const field of [
  'code', 'name', 'unitId', 'purchased', 'produced', 'saled',
  'isMaterial', 'source', 'leadTime', 'bufferTime'
]) {
  test(`supplier binding rejects missing required ${field} with zero PUT even when flag fallback is available`, async () => {
    for (const missingKind of ['omitted', 'null', 'empty']) {
      const current = component()
      delete current.parented
      delete current.assembled
      if (missingKind === 'omitted') delete current[field]
      else current[field] = missingKind === 'null' ? null : ''
      const input = supplierBindingHarness(current)
      const caseRecord = record()

      await assert.rejects(() => bindDedicatedSupplier({
        api: input.api,
        fixture: input.fixture,
        caseRecord
      }), new RegExp(`缺少字段 ${field}，拒绝部分覆盖`))

      assert.equal(input.calls.filter(([method]) => method === 'PUT').length, 0, missingKind)
      assert.equal(input.fixture.mrpSupplier, undefined)
      assert.deepEqual(caseRecord.fixtures, {})
    }
  })
}

for (const field of ['parented', 'assembled']) {
  test(`supplier binding does not replace an explicit empty ${field} and rejects with zero PUT`, async () => {
    const input = supplierBindingHarness({ ...component(), [field]: '' })
    const caseRecord = record()

    await assert.rejects(() => bindDedicatedSupplier({
      api: input.api,
      fixture: input.fixture,
      caseRecord
    }), new RegExp(`缺少 ${field} 夹具值，拒绝部分覆盖`))

    assert.equal(input.calls.filter(([method]) => method === 'PUT').length, 0)
    assert.deepEqual(caseRecord.evidence, [])
    assert.equal(input.fixture.mrpSupplier, undefined)
  })
}

test('supplier binding rejects an owner marker mismatch without PUT', async () => {
  for (const marker of ['AUTOTEST-FOREIGN-MATERIAL', 'AUTOTEST-PROC-001-UNIT-OLD', undefined, null, '']) {
    const current = { ...component(), remark: marker }
    delete current.parented
    delete current.assembled
    const input = supplierBindingHarness(current)
    const caseRecord = record()

    await assert.rejects(() => bindDedicatedSupplier({
      api: input.api,
      fixture: input.fixture,
      caseRecord
    }), /^Error: BLOCKED: .*所有权回读不匹配/)

    assert.equal(input.calls.filter(([method]) => method === 'PUT').length, 0)
    assert.deepEqual(caseRecord.evidence, [])
    assert.equal(input.fixture.mrpSupplier, undefined)
    assert.deepEqual(caseRecord.fixtures, {})
  }
})

test('supplier binding rejects mismatched or missing component IDs before fallback with zero PUT', async () => {
  for (const id of [ids.finished, undefined, null, '']) {
    const current = { ...component(), id }
    delete current.parented
    delete current.assembled
    const input = supplierBindingHarness(current)
    const caseRecord = record()

    await assert.rejects(() => bindDedicatedSupplier({
      api: input.api,
      fixture: input.fixture,
      caseRecord
    }), /^Error: BLOCKED: .*所有权回读不匹配/)

    assert.equal(input.calls.filter(([method]) => method === 'PUT').length, 0)
    assert.deepEqual(caseRecord.evidence, [])
    assert.equal(input.fixture.mrpSupplier, undefined)
    assert.deepEqual(caseRecord.fixtures, {})
  }
})

test('request builder binds exactly one dedicated work and a stable idempotency key', () => {
  const fixture = executionFixture()
  const body = buildMrpCalculationRequest({ fixture, marker: fixture.marker })
  assert.deepEqual(body.workIds, [ids.work])
  assert.deepEqual(body.workNos, ['AUTOTEST-WORK'])
  assert.deepEqual(body.materialIds, [ids.finished])
  assert.equal(body.idempotencyKey, fixture.marker)
  assert.equal(body.considerInTransitStock, true)
})

test('formal worker MRP path proves shortage, unique auto-request source and duplicate-generation idempotency', async () => {
  const input = harness()
  const caseRecord = record()
  let fixtureOptions
  const result = await runProcurementMrpClosure({
    api: input.api,
    record: {},
    caseRecord,
    fixtureFactory: (_api, _record, caseId, options) => {
      fixtureOptions = { caseId, options }
      return input.fixture
    }
  })

  assert.equal(result.partial, false)
  assert.equal(input.fixture.setupCalls, 1)
  assert.equal(input.fixture.shortageCalls, 1)
  assert.equal(input.fixture.cleanupCalls, 1)
  assert.equal(fixtureOptions.caseId, 'PROC-001')
  assert.deepEqual(fixtureOptions.options, { schedule: true, withOpeningInventory: true })
  assert.ok(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.shortage)?.passed)
  assert.ok(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.atp)?.passed)
  assert.ok(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.netDemand)?.passed)
  assert.ok(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.startGate)?.passed)
  assert.ok(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.source)?.passed)
  assert.ok(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.idempotency)?.passed)
  assert.equal(result.state.request.srcBillType, 'MRP')
  assert.equal(result.state.request.srcBillId, calculationId)
  const demand = result.state.calculation.demandPlan[0]
  assert.equal(demand.inTransitStock, 1)
  assert.equal(demand.availableStock, demand.currentStock - demand.lockStock + demand.inTransitStock)
  assert.equal(demand.netDemand, Math.max(0, demand.totalDemand - demand.availableStock))
  const gateCalls = input.calls.filter(([, path]) =>
    path === `/mes/prodWorkTask/feed-pick-preview?taskId=${ids.task}` ||
    path === `/mes/prodWork/queryById?id=${ids.work}` ||
    path === '/mes/prodWork/start')
  assert.deepEqual(gateCalls.map(([method, path]) => [method, path]), [
    ['GET', `/mes/prodWorkTask/feed-pick-preview?taskId=${ids.task}`],
    ['GET', `/mes/prodWork/queryById?id=${ids.work}`],
    ['POST-RAW', '/mes/prodWork/start'],
    ['GET', `/mes/prodWork/queryById?id=${ids.work}`]
  ])
  assert.equal(input.calls.filter(([, path]) => path === `${MRP_PLAN_PATH}?calculationId=${calculationId}`).length, 2)
  const requestDelete = input.calls.find(([, path]) =>
    path === `/erp/purchase/order/request/delete?id=${ids.request}`)
  const cleanupIndex = input.calls.indexOf(requestDelete)
  const fixtureCleanupIndex = input.calls.findIndex(([method]) => method === 'FIXTURE-CLEANUP')
  assert.ok(cleanupIndex >= 0)
  assert.ok(fixtureCleanupIndex > cleanupIndex)
  assert.equal(input.calls.some(([, path]) => path === '/erp/purchase/order/request/create'), false)
})

for (const [label, options, failedCheck] of [
  ['wrong preview task', { previewChanges: { taskId: ids.work } }, PROCUREMENT_MRP_CHECKS.atp],
  ['sufficient ATP stock', { previewChanges: {
    materialList: [{ materialId: ids.component, requiredQty: 3, remainingPickQty: 3, stockQty: 3 }]
  } }, PROCUREMENT_MRP_CHECKS.atp],
  ['omitted in-transit availability', { demandChanges: { availableStock: 0 } }, PROCUREMENT_MRP_CHECKS.netDemand],
  ['incorrect net demand', { demandChanges: { netDemand: 3 } }, PROCUREMENT_MRP_CHECKS.netDemand],
  ['unrelated start rejection', { startRejection: { msg: '系统异常' } }, PROCUREMENT_MRP_CHECKS.startGate],
  ['changed work status after rejection', { afterStartStatus: 2 }, PROCUREMENT_MRP_CHECKS.startGate]
]) {
  test(`${label} fails the shortage gate before purchase generation and still cleans the fixture`, async () => {
    const input = harness(options)
    const caseRecord = record()
    await assert.rejects(() => runProcurementMrpClosure({
      api: input.api,
      caseRecord,
      executionFixture: input.fixture
    }), /缺料 ATP、净需求或开工门禁断言未通过/)
    assert.equal(caseRecord.checks.find((row) => row.name === failedCheck)?.passed, false)
    assert.equal(input.calls.some(([, path]) =>
      typeof path === 'string' && path.startsWith(MRP_PLAN_PATH)), false)
    assert.equal(input.calls.some(([, path]) => path === '/erp/purchase/order/request/create'), false)
    assert.equal(input.calls.some(([method]) => method === 'DELETE-BUSINESS'), false)
    assert.equal(input.fixture.cleanupCalls, 1)
  })
}

test('legacy is_purchase_request direct-order branch is a strict product GAP and never backfills a request', async () => {
  const input = harness({ directOrder: true })
  const caseRecord = record()
  const result = await runProcurementMrpClosure({
    api: input.api,
    caseRecord,
    executionFixture: input.fixture
  })

  assert.equal(result.partial, true)
  assert.equal(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.source)?.passed, false)
  assert.equal(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.configGap)?.passed, false)
  assert.match(caseRecord.notes.join('\n'), /legacy config is_purchase_request/)
  assert.ok(input.calls.some(([, path]) => path === `/erp/purchase-order/delete?ids=${ids.order}`))
  assert.equal(input.fixture.cleanupCalls, 1)
  assert.equal(input.calls.some(([, path]) => path === '/erp/purchase/order/request/create'), false)
  assert.equal(input.calls.filter(([method]) => method === 'POST').length, 0)
})

test('missing real shortage remains GAP and stops before purchase generation', async () => {
  const input = harness({ shortage: false })
  const caseRecord = record()
  const result = await runProcurementMrpClosure({
    api: input.api,
    caseRecord,
    executionFixture: input.fixture
  })

  assert.equal(result.partial, true)
  assert.match(caseRecord.notes.join('\n'), /未同时返回专属缺料子件/)
  assert.equal(input.calls.some(([, path]) =>
    typeof path === 'string' && path.startsWith(MRP_PLAN_PATH)), false)
  assert.equal(input.calls.some(([, path]) => path === '/erp/purchase/order/request/create'), false)
  assert.equal(input.calls.some(([method]) => method === 'DELETE-BUSINESS'), false)
})

test('duplicate generation accepts only the exact completed-plan rejection', () => {
  assert.equal(assertMrpPlanIdempotencyRejection({
    code: 500,
    data: null,
    msg: '生成采购计划失败：该运算已生成采购计划，生成时间: 2026-10-12 10:00:00'
  }), true)
  for (const response of [
    { code: 0, msg: '成功' },
    { code: 500, msg: '系统异常' },
    { code: 500, msg: '该运算已生成采购计划' },
    { code: 403, msg: '无权限' }
  ]) {
    assert.throws(() => assertMrpPlanIdempotencyRejection(response), /拒绝契约不符/)
  }
})

test('a duplicate request row is not accepted as idempotent closure', async () => {
  const input = harness({ duplicateRows: 2 })
  const caseRecord = record()
  const result = await runProcurementMrpClosure({
    api: input.api,
    caseRecord,
    executionFixture: input.fixture
  })

  assert.equal(result.partial, true)
  assert.equal(caseRecord.checks.find((row) => row.name === PROCUREMENT_MRP_CHECKS.source)?.passed, false)
  assert.match(caseRecord.notes.join('\n'), /requestCount=2/)
  assert.equal(input.calls.filter(([, path]) => path?.startsWith('/erp/purchase/order/request/delete')).length, 2)
})

test('request cleanup failure marks the returned closure partial', async () => {
  const input = harness({ requestDeleteError: 'request still referenced' })
  const caseRecord = record()
  const result = await runProcurementMrpClosure({
    api: input.api,
    caseRecord,
    executionFixture: input.fixture
  })

  assert.equal(result.partial, true)
  assert.match(caseRecord.notes.join('\n'), /request still referenced/)
  assert.equal(input.fixture.cleanupCalls, 1)
})

test('execution fixture cleanup failure marks the returned closure partial', async () => {
  const input = harness({ fixtureCleanupError: 'fixture dependency remains' })
  const caseRecord = record()
  const result = await runProcurementMrpClosure({
    api: input.api,
    caseRecord,
    executionFixture: input.fixture
  })

  assert.equal(result.partial, true)
  assert.match(caseRecord.notes.join('\n'), /fixture dependency remains/)
})

test('owned-chain mode preserves a successful fixture for downstream cases', async () => {
  const input = harness()
  const caseRecord = record()
  const result = await runProcurementMrpClosure({
    api: input.api,
    caseRecord,
    executionFixture: input.fixture,
    preserveSuccessfulFixture: true
  })

  assert.equal(result.partial, false)
  assert.equal(input.fixture.cleanupCalls, 0)
  assert.equal(input.calls.some(([method]) => method === 'DELETE-BUSINESS'), false)
})

test('owned-chain mode still cleans a partial direct-order branch', async () => {
  const input = harness({ directOrder: true })
  const caseRecord = record()
  const result = await runProcurementMrpClosure({
    api: input.api,
    caseRecord,
    executionFixture: input.fixture,
    preserveSuccessfulFixture: true
  })

  assert.equal(result.partial, true)
  assert.equal(input.fixture.cleanupCalls, 1)
  assert.ok(input.calls.some(([, path]) => path === `/erp/purchase-order/delete?ids=${ids.order}`))
})
