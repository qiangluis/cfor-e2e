import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import {
  __internal,
  cleanupMaterialStockScenarioFixtures,
  materialStockScenarioAssertionMap,
  materialStockScenarioCheckNames,
  materialStockScenarioContracts,
  verifyMaterialStockScenarioClosure
} from '../fixtures/material-stock-scenario-closure.mjs'

const ok = (data) => ({ code: 0, data })
const records = (rows = []) => ok({ total: rows.length, records: rows })
const sqlOk = (rows = [['erp', '0'], ['mes_stk_io', '0'], ['mes_stk_inventory', '0', '0', '0']]) => ({
  available: true,
  rows
})

const responseForProbe = (path, materialId, materials = new Map()) => {
  const material = materials.get(String(materialId))
  const nonPhysical = material?.inventoryNature !== 'STOCK'
  const purchase = path.includes('/purchase-')
  const operation = path.includes('purchase-in')
    ? '采购入库'
    : path.includes('purchase-return')
      ? '采购退货'
      : path.includes('sale-out')
        ? '销售出库'
        : '销售退货'
  const reason = nonPhysical
    ? (purchase ? '采购出入库只能引用实物存货' : '销售出入库只能引用实物存货')
    : (purchase ? '未启用可采购能力' : '未启用可销售能力')
  if (path === '/erp/purchase-in/create') {
    return { code: 2010100007, msg: `存货(${materialId})不能用于${operation}：${reason}`, data: null }
  }
  return { code: 2010100007, msg: `存货(${materialId})不能用于${operation}：${reason}`, data: null }
}

const createApi = ({ probeResponse = responseForProbe, cleanupFailure = false } = {}) => {
  const state = {
    nextId: 9007199254740991n,
    materials: new Map(),
    orders: new Map(),
    purchaseRequests: new Map(),
    deletedMaterials: [],
    deletedOrders: [],
    deletedPurchaseRequests: [],
    posts: []
  }
  const makeId = () => String(++state.nextId)
  const orderDetail = (body, id) => ({
    id,
    billNo: body.billNo,
    remark: body.remark,
    items: body.items.map((item) => ({ ...item }))
  })
  const api = {
    state,
    async getBusiness (pathname) {
      const url = new URL(pathname, 'http://local')
      if (url.pathname === '/base/partner/get') {
        const id = url.searchParams.get('id')
        return ok(id === '11'
          ? { id, status: 'ACTIVE', supplierEnabled: true }
          : { id, status: 'ACTIVE', customerEnabled: true })
      }
      if (url.pathname === '/mes/basMaterial/queryById') return ok(state.materials.get(url.searchParams.get('id')) ?? null)
      if (url.pathname === '/mes/basMaterial/list') {
        const code = url.searchParams.get('code')
        return records([...state.materials.values()].filter((row) => row.code === code))
      }
      if (url.pathname === '/erp/purchase/order/request/get') {
        return ok(state.purchaseRequests.get(url.searchParams.get('id')) ?? null)
      }
      if (url.pathname === '/erp/purchase-order/page') {
        return records([...state.orders.values()])
      }
      if (url.pathname.endsWith('/page')) return records([])
      if (url.pathname.endsWith('/get')) {
        const id = url.searchParams.get('id')
        return ok(state.orders.get(id) ?? null)
      }
      throw new Error(`unexpected GET ${pathname}`)
    },
    async postBusiness (pathname, body) {
      state.posts.push({ method: 'POST-BUSINESS', pathname, body })
      if (pathname === '/mes/basMaterial/add') {
        const id = makeId()
        state.materials.set(id, { ...body, id })
        return ok(id)
      }
      if (pathname === '/erp/purchase/order/request/create') {
        const id = makeId()
        const itemId = makeId()
        state.purchaseRequests.set(id, {
          id,
          billNo: body.billNo,
          status: 0,
          isEffective: 0,
          isPlaceOrder: 0,
          billStage: '10',
          remark: body.remark,
          itemsList: body.itemsList.map((item) => ({ ...item, id: itemId, mid: id }))
        })
        return ok(id)
      }
      if (pathname.endsWith('/purchase-order/create')) {
        const id = makeId()
        state.orders.set(id, orderDetail(body, id))
        return ok(id)
      }
      throw new Error(`unexpected POST-BUSINESS ${pathname}`)
    },
    async post (pathname, body, options) {
      state.posts.push({ method: 'POST', pathname, body, options })
      return typeof probeResponse === 'function'
        ? probeResponse(pathname, body.items?.[0]?.productId, state.materials)
        : probeResponse
    },
    async putBusiness (pathname) {
      const url = new URL(pathname, 'http://local')
      if (url.pathname === '/erp/purchase/order/request/update-status') {
        const request = state.purchaseRequests.get(url.searchParams.get('id'))
        request.status = 20
        request.isEffective = 1
        request.billStage = '24'
        return ok(true)
      }
      if (url.pathname === '/erp/purchase/order/request/place/an/order') {
        const itemId = url.searchParams.get('ids')
        const request = [...state.purchaseRequests.values()].find((row) =>
          row.itemsList.some((item) => String(item.id) === String(itemId)))
        const item = request.itemsList.find((entry) => String(entry.id) === String(itemId))
        const id = makeId()
        state.orders.set(id, {
          id,
          billNo: `PO-${request.billNo}`,
          remark: '',
          items: [{ ...item, srcBillId: request.id, srcEntryId: item.id }]
        })
        request.isPlaceOrder = 1
        return ok(true)
      }
      throw new Error(`unexpected PUT-BUSINESS ${pathname}`)
    },
    async deleteBusiness (pathname) {
      if (cleanupFailure) throw new Error(`cleanup failed: ${pathname}`)
      const url = new URL(pathname, 'http://local')
      const id = url.searchParams.get('id') || url.searchParams.get('ids')
      if (pathname.includes('/basMaterial/delete')) {
        state.deletedMaterials.push(id)
        state.materials.delete(id)
      } else if (pathname.includes('/purchase/order/request/delete')) {
        state.deletedPurchaseRequests.push(id)
        state.purchaseRequests.delete(id)
      } else {
        state.deletedOrders.push(id)
        state.orders.delete(id)
      }
      return ok(true)
    },
    async get (pathname) {
      const url = new URL(pathname, 'http://local')
      if (url.pathname === '/erp/purchase/order/request/get') {
        const request = state.purchaseRequests.get(url.searchParams.get('id'))
        return request
          ? ok(request)
          : { code: -636, success: false, data: null, msg: 'ERP 采购订单申请不存在' }
      }
      throw new Error(`unexpected raw GET ${pathname}`)
    }
  }
  return api
}

const runSql = async () => sqlOk()

test('PB032-002 contracts are exact and preserve string snowflake IDs', () => {
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于采购入库：采购出入库只能引用实物存货', data: null },
    materialStockScenarioContracts.servicePurchaseInNonPhysical
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于采购入库：采购出入库只能引用实物存货', data: null },
    materialStockScenarioContracts.purchaseInNonPhysical
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于采购入库：未启用可采购能力', data: null },
    materialStockScenarioContracts.purchaseInCapability
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于采购退货：采购出入库只能引用实物存货', data: null },
    materialStockScenarioContracts.purchaseReturnNonPhysical
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于采购退货：未启用可采购能力', data: null },
    materialStockScenarioContracts.purchaseReturnCapability
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于销售出库：销售出入库只能引用实物存货', data: null },
    materialStockScenarioContracts.saleOutNonPhysical
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于销售退货：销售出入库只能引用实物存货', data: null },
    materialStockScenarioContracts.saleReturnNonPhysical
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于销售出库：未启用可销售能力', data: null },
    materialStockScenarioContracts.saleOutCapability
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(9007199254740993)不能用于销售退货：未启用可销售能力', data: null },
    materialStockScenarioContracts.saleReturnCapability
  ), true)
  assert.equal(__internal.exactId('9007199254740993', 'snowflake'), '9007199254740993')
  assert.throws(() => __internal.exactId(9007199254740993, 'snowflake'), /不安全数字 ID/)
})

test('PB032-002 assertion mapping covers every catalog assertion with explicit checks', () => {
  assert.deepEqual(materialStockScenarioAssertionMap.purchasePhysicalAndCapability, [
    materialStockScenarioCheckNames.purchaseInNonPhysical,
    materialStockScenarioCheckNames.purchaseInCapability,
    materialStockScenarioCheckNames.purchaseReturnNonPhysical,
    materialStockScenarioCheckNames.purchaseReturnCapability
  ])
  assert.deepEqual(materialStockScenarioAssertionMap.salePhysicalAndCapability, [
    materialStockScenarioCheckNames.saleOutNonPhysical,
    materialStockScenarioCheckNames.saleOutCapability,
    materialStockScenarioCheckNames.saleReturnNonPhysical,
    materialStockScenarioCheckNames.saleReturnCapability
  ])
  assert.deepEqual(materialStockScenarioAssertionMap.virtualPhysicalMoveRejections, [
    materialStockScenarioCheckNames.purchaseInNonPhysical,
    materialStockScenarioCheckNames.purchaseReturnNonPhysical,
    materialStockScenarioCheckNames.saleOutNonPhysical,
    materialStockScenarioCheckNames.saleReturnNonPhysical
  ])
  assert.deepEqual(materialStockScenarioAssertionMap.servicePurchaseOrderWithoutInventory, [
    materialStockScenarioCheckNames.servicePurchaseOrder,
    materialStockScenarioCheckNames.serviceInventoryUnchanged,
    materialStockScenarioCheckNames.servicePurchaseInNonPhysical
  ])
  assert.deepEqual(materialStockScenarioAssertionMap.mixedStockPurchaseOrder, [
    materialStockScenarioCheckNames.stockPurchaseOrder,
    materialStockScenarioCheckNames.stockInventoryUnchanged
  ])
  assert.equal(new Set(Object.values(materialStockScenarioAssertionMap).flat()).size, 13)
})

test('PB032-002 bodies follow the verified opening/return DTO prerequisite order', () => {
  const material = { id: '9007199254740993', unitId: '7' }
  const common = { kind: 'purchaseIn', marker: 'E2E-MARK', billNo: 'E2E-BILL', material, partnerId: '11' }
  const purchaseIn = __internal.probeBody(common)
  assert.equal(purchaseIn.businessType, 'OPENING')
  assert.equal(purchaseIn.orderId, null)
  assert.equal(purchaseIn.items[0].productId, material.id)
  const purchaseReturn = __internal.probeBody({ ...common, kind: 'purchaseReturn' })
  assert.equal(purchaseReturn.srcBillId, null)
  assert.equal(purchaseReturn.returnType, 2)
  for (const body of [purchaseIn, purchaseReturn]) {
    assert.equal('status' in body, false)
    assert.equal('stockIoType' in body, false)
  }
  const sql = __internal.scenarioSql('E2E-MARK', 'E2E-BILL', [material.id])
  assert.match(sql, /mes_stk_inventory/)
  assert.match(sql, /9007199254740993/)
})

test('PB032-002 registers an unexpected formal document before detail readback', async () => {
  const fixture = { marker: 'E2E-PB032-002-MARK', unexpectedDocuments: [] }
  const probe = {
    kind: 'saleOut',
    material: { id: '9007199254740993' }
  }
  const api = {
    async getBusiness () {
      throw new Error('detail readback failed')
    }
  }
  await assert.rejects(() => __internal.createUnexpectedResource(api, fixture, probe, ok('9007199254740994')), /detail readback failed/)
  assert.equal(fixture.unexpectedDocuments.length, 1)
  assert.deepEqual(fixture.unexpectedDocuments[0], {
    kind: 'saleOut',
    material: probe.material,
    marker: fixture.marker,
    billNo: null,
    id: '9007199254740994'
  })
})

test('PB032-002 cleans a registered unexpected formal document by ownership', async () => {
  const document = {
    kind: 'saleOut',
    material: { id: '9007199254740993' },
    marker: 'E2E-PB032-002-MARK',
    billNo: 'E2E-UNEXPECTED-1',
    id: '9007199254740994'
  }
  let deleted = false
  const api = {
    async getBusiness (pathname) {
      const url = new URL(pathname, 'http://local')
      if (url.pathname === '/erp/sale-out/get') {
        return ok(deleted ? null : {
          id: document.id,
          no: document.billNo,
          remark: document.marker,
          items: [{ productId: document.material.id }]
        })
      }
      if (url.pathname === '/erp/sale-out/page') return records(deleted ? [] : [{
        id: document.id,
        no: document.billNo,
        productId: document.material.id
      }])
      throw new Error(`unexpected GET ${pathname}`)
    },
    async deleteBusiness (pathname) {
      assert.match(pathname, /\/erp\/sale-out\/delete\?ids=9007199254740994/)
      deleted = true
      return ok(true)
    }
  }
  const record = { checks: [], database: [] }
  await cleanupMaterialStockScenarioFixtures(api, {
    marker: document.marker,
    materials: [],
    orders: [],
    unexpectedDocuments: [document],
    lastBillNo: null
  }, record, runSql)
  assert.equal(deleted, true)
  assert.equal(record.checks.at(-1).passed, true)
})

test('PB032-002 closure records every rejection/positive-control assertion and cleans only this run', async () => {
  const api = createApi()
  const record = { checks: [], evidence: [], fixtures: [] }
  const fixture = await verifyMaterialStockScenarioClosure({
    api,
    caseRecord: record,
    unit: { id: '7' },
    supplier: { id: '11' },
    customer: { id: '12' },
    readOnlySql: runSql
  })
  assert.match(fixture.marker, /^E2E-PB032-002-[A-F0-9]{16}$/)
  assert.equal(record.checks.every((check) => check.passed), true)
  assert.deepEqual(record.checks.map((check) => check.name), [
    materialStockScenarioCheckNames.servicePurchaseOrder,
    materialStockScenarioCheckNames.serviceInventoryUnchanged,
    materialStockScenarioCheckNames.stockPurchaseOrder,
    materialStockScenarioCheckNames.stockInventoryUnchanged,
    materialStockScenarioCheckNames.servicePurchaseInNonPhysical,
    materialStockScenarioCheckNames.purchaseInNonPhysical,
    materialStockScenarioCheckNames.purchaseInCapability,
    materialStockScenarioCheckNames.purchaseReturnNonPhysical,
    materialStockScenarioCheckNames.purchaseReturnCapability,
    materialStockScenarioCheckNames.saleOutNonPhysical,
    materialStockScenarioCheckNames.saleOutCapability,
    materialStockScenarioCheckNames.saleReturnNonPhysical,
    materialStockScenarioCheckNames.saleReturnCapability,
    materialStockScenarioCheckNames.cleanup
  ])
  assert.equal(record.database.length >= 23, true)
  assert.equal(fixture.caseRecord, undefined)
  assert.doesNotThrow(() => JSON.stringify(record))
  for (const checkName of [
    materialStockScenarioCheckNames.servicePurchaseInNonPhysical,
    ...materialStockScenarioAssertionMap.purchasePhysicalAndCapability,
    ...materialStockScenarioAssertionMap.salePhysicalAndCapability
  ]) {
    const check = record.checks.find((item) => item.name === checkName)
    assert.equal(check.passed, true)
    assert.match(check.details, /beforePage/)
    assert.match(check.details, /afterPage/)
    assert.match(check.details, /beforeDb/)
    assert.match(check.details, /afterDb/)
  }
  assert.equal(api.state.materials.size, 0)
  assert.equal(api.state.orders.size, 0)
  assert.equal(api.state.deletedMaterials.length, 5)
  assert.equal(api.state.deletedOrders.length, 2)
  const rejectedPosts = api.state.posts.filter((item) => item.method === 'POST')
  assert.deepEqual(rejectedPosts.map((item) => item.pathname), [
    '/erp/purchase-in/create', '/erp/purchase-in/create', '/erp/purchase-in/create',
    '/erp/purchase-return/create', '/erp/purchase-return/create',
    '/erp/sale-out/create', '/erp/sale-out/create',
    '/erp/sale-return/create', '/erp/sale-return/create'
  ])
  const virtualMaterial = fixture.materials.find((material) => material.inventoryNature === 'VIRTUAL')
  assert.deepEqual(rejectedPosts
    .filter((item) => item.pathname === '/erp/sale-out/create' || item.pathname === '/erp/sale-return/create')
    .filter((item) => item.body.items[0].productId === virtualMaterial.id)
    .map((item) => item.pathname), ['/erp/sale-out/create', '/erp/sale-return/create'])
  assert.equal(rejectedPosts.every((item) => item.options.expectedBusinessRejection.code === 2010100007), true)
  const materialBodies = api.state.posts.filter((item) => item.pathname === '/mes/basMaterial/add').map((item) => item.body)
  assert.deepEqual(materialBodies.map(({ inventoryNature, source, purchased, saled, produced }) =>
    ({ inventoryNature, source, purchased, saled, produced })), [
    { inventoryNature: 'SERVICE', source: 'purchase', purchased: 'Y', saled: 'Y', produced: 'N' },
    { inventoryNature: 'VIRTUAL', source: 'purchase', purchased: 'Y', saled: 'Y', produced: 'N' },
    { inventoryNature: 'STOCK', source: 'manufacture', purchased: 'N', saled: 'Y', produced: 'Y' },
    { inventoryNature: 'STOCK', source: 'purchase', purchased: 'Y', saled: 'N', produced: 'N' },
    { inventoryNature: 'STOCK', source: 'mixed', purchased: 'Y', saled: 'Y', produced: 'Y' }
  ])
})

test('PB032-002 fails hard on a non-domain rejection and still cleans all owned resources', async () => {
  const api = createApi({
    probeResponse: (pathname, materialId, materials) => pathname === '/erp/purchase-in/create'
      ? responseForProbe(pathname, materialId, materials)
      : { code: 500, msg: '系统异常', data: null }
  })
  const record = { checks: [], evidence: [], fixtures: [] }
  await assert.rejects(() => verifyMaterialStockScenarioClosure({
    api, caseRecord: record, unit: '7', supplier: '11', customer: '12', readOnlySql: runSql
  }), /销售订单|系统异常|销售出库正式 create API/)
  assert.equal(api.state.materials.size, 0)
  assert.equal(api.state.orders.size, 0)
  assert.equal(record.checks.at(-1).name, materialStockScenarioCheckNames.cleanup)
  assert.equal(record.checks.at(-1).passed, true)
  assert.equal(record.checks.some((check) => !check.passed), true)
})

test('PB032-002 fails hard when the API response is a business-domain mismatch', async () => {
  const api = createApi({
    probeResponse: (pathname, materialId, materials) => pathname === '/erp/purchase-in/create'
      ? responseForProbe(pathname, materialId, materials)
      : { code: 2010100007, msg: `存货(${materialId})不能用于销售出库：未启用可销售能力`, data: null }
  })
  const record = { checks: [], evidence: [], fixtures: [] }
  await assert.rejects(() => verifyMaterialStockScenarioClosure({
    api, caseRecord: record, unit: '7', supplier: '11', customer: '12', readOnlySql: runSql
  }), /采购退货正式 create API|销售出库正式 create API/)
  assert.equal(api.state.materials.size, 0)
  assert.equal(api.state.orders.size, 0)
  assert.equal(record.checks.at(-1).name, materialStockScenarioCheckNames.cleanup)
  assert.equal(record.checks.at(-1).passed, true)
  assert.equal(record.checks.some((check) => !check.passed), true)
})

test('PB032-002 treats SQL unavailability and cleanup failure as hard failures', async () => {
  const unavailableRecord = { checks: [], evidence: [], fixtures: [] }
  await assert.rejects(() => verifyMaterialStockScenarioClosure({
    api: createApi(), caseRecord: unavailableRecord, unit: '7', supplier: '11', customer: '12',
    readOnlySql: async () => ({ available: false, reason: 'unit test unavailable', rows: [] })
  }), /只读 SQL 不可用/)

  const cleanupRecord = { checks: [], evidence: [], fixtures: [] }
  await assert.rejects(() => verifyMaterialStockScenarioClosure({
    api: createApi({ cleanupFailure: true }), caseRecord: cleanupRecord,
    unit: '7', supplier: '11', customer: '12', readOnlySql: runSql
  }), /夹具清理失败/)
  assert.equal(cleanupRecord.checks.at(-1).name, materialStockScenarioCheckNames.cleanup)
  assert.equal(cleanupRecord.checks.at(-1).passed, false)
})
