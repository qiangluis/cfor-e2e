import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasOutsourceBusinessFixture,
  hasOutsourcePaymentFixture,
  outsourceListRows,
  outsourceReadySelector,
  outsourceRoute,
  paymentRequestReadySelector,
  paymentRequestRoute,
  paymentSourceReadySelector
} from '../suites/mes-outsource.mjs'
import {
  buildDedicatedBomPayload,
  buildDedicatedProductionOrderPayload,
  createOutsourceDraft,
  isStableOutsourceId,
  OUTSOURCE_MARKER_PREFIX
} from '../fixtures/mes-outsource-write.mjs'

const ok = (data) => ({ code: 0, data })

const makeDedicatedApi = (marker, { failPath, inventoryQty = 4, inventoryAvailableQty = inventoryQty } = {}) => {
  const calls = []
  const ids = {
    warehouse: '101', area: '102', location: '103', product: '104', component: '105',
    bom: '106', opening: '107', inventory: '108', order: '109', orderSub: '110',
    work: '111', outsource: '112'
  }
  const api = {
    calls,
    async getBusiness(path) {
      calls.push({ method: 'GET', path })
      if (path === failPath) throw new Error(`simulated failure: ${path}`)
      if (path === '/mes/basUnit/list/enabled') return ok([{ id: '11' }])
      if (path === '/mes/wmsWareHouse/allTree') {
        return ok([{ id: ids.warehouse, name: `${marker}-委外仓`, code: `${marker}-WH`, mark: marker, children: [] }])
      }
      if (path.includes('/mes/wmsWareHouse/queryById')) {
        return ok({ id: ids.warehouse, code: `${marker}-WH`, name: `${marker}-委外仓`, mark: marker })
      }
      if (path.includes('/mes/wmsHouseArea/list')) {
        return ok([{ id: ids.area, areaCode: `${marker}-AR`, areaName: `${marker}-库区`,
          houseId: ids.warehouse, remark: marker }])
      }
      if (path.includes('/mes/wms-house-location/get')) {
        return ok({ id: ids.location, locationCode: `${marker}-LC`, locationName: `${marker}-库位`,
          houseId: ids.warehouse, areaId: ids.area, remark: marker })
      }
      if (path.includes('/mes/basMaterial/queryById?id=')) {
        const id = new URL(`http://unit${path}`).searchParams.get('id')
        const code = id === ids.product ? `${marker}-FG` : `${marker}-RM`
        return ok({ id, code, remark: marker })
      }
      if (path.includes('/mes/wmsAssemble/queryById')) {
        return ok({ id: ids.bom, stockId: ids.product, bomUsage: 'PRODUCTION',
          prepayWareHouseId: ids.warehouse, prepayWareAreaId: ids.area })
      }
      if (path.includes('/mes/wmsAssemble/queryWmsAssembleSubByMainId')) {
        return ok({ records: [{ stockId: ids.component, prepayWareHouseId: ids.warehouse,
          prepayWareAreaId: ids.area }] })
      }
      if (path.includes('/mes/prodOrder/queryById')) return ok({ id: ids.order,
        prodNo: `${marker}-PLAN`, remark: marker })
      if (path.includes('/mes/prodOrder/queryMesProdOrderSubByMainId')) {
        return ok([{ id: ids.orderSub, materialId: ids.product, wmsAssembleId: ids.bom }])
      }
      if (path.includes('/mes/prodWork/getWorkByProdOrderId')) {
        return ok([{ id: ids.work, prodOrderId: ids.order, remark: marker }])
      }
      if (path.includes('/mes/prodWork/queryById')) {
        return ok({ id: ids.work, prodOrderId: ids.order, remark: marker })
      }
      if (path.includes('/mes/prodWorkSub/queryEntryByMainId')) {
        return ok([{ id: '110', materialId: ids.component }])
      }
      if (path.includes('/mes/prodWorkSub/queryById')) {
        return ok({ id: '110', mid: ids.work, materialId: ids.component,
          prepayWareHouseId: ids.warehouse, prepayWareAreaId: ids.area })
      }
      if (path.includes('/mes/stkIo/queryById')) {
        return ok({ id: ids.opening, stockIoType: '106', remark: marker, isEffective: 1 })
      }
      if (path.includes('/mes/stkInventory/list/dictText')) {
        return ok([{ id: ids.inventory, warehouseId: ids.warehouse, wareAreaId: ids.area,
          wareLocationId: ids.location, materialId: ids.component, batchNo: '0',
          qty: inventoryQty, availableQty: inventoryAvailableQty }])
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness(path, body) {
      calls.push({ method: 'POST', path, body })
      if (path === failPath) throw new Error(`simulated failure: ${path}`)
      if (path === '/mes/basMaterial/add') {
        return ok(body.code.endsWith('-FG') ? ids.product : body.code.endsWith('-RM') ? ids.component : ids.outsource)
      }
      if (path === '/mes/wmsAssemble/add') return ok(ids.bom)
      if (path === '/mes/prodOrder/add') return ok(ids.order)
      if (path === '/mes/prodWork/transferWorkOrder') return ok(true)
      if (path === '/mes/prodOutsource/add') return ok(ids.outsource)
      if (path === '/mes/stkIo/add/submit') return ok(ids.opening)
      if (path === '/mes/wms-house-location/create') return ok(ids.location)
      if (path === '/mes/wmsWareHouse/add' || path === '/mes/wmsHouseArea/add') return ok(true)
      throw new Error(`unexpected POST ${path}`)
    },
    async putBusiness(path, body) {
      calls.push({ method: 'PUT', path, body })
      if (path === failPath) throw new Error(`simulated failure: ${path}`)
      if (path === '/mes/prodOrder/check') return ok(true)
      if (path === '/mes/stkIo/check') return ok(true)
      throw new Error(`unexpected PUT ${path}`)
    }
  }
  return api
}

test('委外专项使用真实菜单路由和页面就绪选择器', () => {
  assert.equal(outsourceRoute, '/mes/produce/outsource/outsource-work')
  assert.equal(paymentRequestRoute, '/mes/produce/outsource/payment-request')
  assert.match(outsourceReadySelector, /新增/)
  assert.match(paymentRequestReadySelector, /新增/)
  assert.match(paymentSourceReadySelector, /选委外应付/)
})

test('空委外订单和付款来源不能被识别为完整业务前置', () => {
  assert.equal(hasOutsourceBusinessFixture([]), false)
  assert.equal(hasOutsourceBusinessFixture([{ billNo: 'NO_ID' }]), false)
  assert.equal(hasOutsourceBusinessFixture([{ id: 1 }]), true)
  assert.equal(hasOutsourcePaymentFixture([]), false)
  assert.equal(hasOutsourcePaymentFixture([{ entryId: 1, uncheckedAmt: 0 }]), false)
  assert.equal(hasOutsourcePaymentFixture([{ entryId: 1, uncheckedAmt: 10 }]), true)
})

test('委外专项不会把无效响应对象伪造成空列表', () => {
  assert.deepEqual(outsourceListRows({ data: { records: [{ id: 1 }] } }), [{ id: 1 }])
  assert.deepEqual(outsourceListRows({ data: { list: [{ id: 2 }] } }), [{ id: 2 }])
  assert.throws(() => outsourceListRows({ data: {} }), /必须返回数组/)
})

test('专属生产 BOM 固定为单层 PRODUCTION 且主表/子件都携带预出库仓储', () => {
  const body = buildDedicatedBomPayload({
    marker: `${OUTSOURCE_MARKER_PREFIX}-UNIT`,
    productId: '103', componentId: '104', unitId: '11', warehouseId: '101', areaId: '102'
  })
  assert.equal(body.bomUsage, 'PRODUCTION')
  assert.equal(body.prepayWareHouseId, '101')
  assert.equal(body.prepayWareAreaId, '102')
  assert.equal(body.wmsAssembleSubList.length, 1)
  assert.deepEqual(body.wmsAssembleSubList[0], {
    stockId: '104', subStockCount: 1, unitId: '11', lossRate: 0,
    prepayWareHouseId: '101', prepayWareAreaId: '102', mark: `${OUTSOURCE_MARKER_PREFIX}-UNIT`
  })
})

test('专属生产订单只引用专属成品、组件和 BOM', () => {
  const body = buildDedicatedProductionOrderPayload({
    marker: `${OUTSOURCE_MARKER_PREFIX}-ORDER`,
    productId: '103', componentId: '104', unitId: '11', bomId: '105',
    startDate: '2026-10-09 10:00:00', endDate: '2026-10-09 14:00:00'
  })
  assert.equal(body.remark, `${OUTSOURCE_MARKER_PREFIX}-ORDER`)
  assert.equal(body.prodOrderSubList[0].materialId, '103')
  assert.equal(body.prodOrderSubList[0].wmsAssembleId, '105')
  assert.equal(body.prodOrderMaterialList[0].materialId, '104')
})

test('createOutsourceDraft ignores shared work arguments and builds an owned work-order chain', async () => {
  const marker = `${OUTSOURCE_MARKER_PREFIX}-SIMULATED`
  const api = makeDedicatedApi(marker)
  const caseRecord = { fixtures: [] }
  const draft = await createOutsourceDraft(api, {
    marker,
    caseRecord,
    dedicatedPrerequisite: true,
    prodWorkId: 'SHARED-WORK',
    materialId: 'SHARED-MATERIAL',
    unitId: 'SHARED-UNIT',
    supplierId: '9001',
    processFeeMaterialId: '9002'
  })
  const outsourceAdd = api.calls.find((call) => call.path === '/mes/prodOutsource/add')
  const materials = api.calls.filter((call) => call.path === '/mes/basMaterial/add')
  assert.equal(materials.find((call) => call.body.code.endsWith('-FG')).body.source, 'manufacture')
  assert.equal(materials.find((call) => call.body.code.endsWith('-RM')).body.source, 'purchase')
  assert.equal(draft.prerequisite.work.id, '111')
  assert.equal(outsourceAdd.body.prodWorkId, '111')
  assert.equal(outsourceAdd.body.materialId, '104')
  assert.equal(outsourceAdd.body.unitId, '11')
  assert.notEqual(outsourceAdd.body.prodWorkId, 'SHARED-WORK')
  assert.equal(outsourceAdd.body.items[0].prodWorkId, '111')
  assert.equal(outsourceAdd.body.items[0].materialId, '104')
  assert.deepEqual(draft.resources.map((resource) => resource.kind), [
    'warehouse', 'area', 'location', 'material', 'material', 'bom', 'opening', 'inventory', 'order', 'work', 'outsource'
  ])
  assert.equal(caseRecord.fixtures.length, draft.resources.length)
  assert.equal(draft.prerequisite.cleanup, 'READY_RETAINED_AUDIT')
  const orderAdd = api.calls.find((call) => call.path === '/mes/prodOrder/add')
  const openingAdd = api.calls.find((call) => call.path === '/mes/stkIo/add/submit')
  assert.match(orderAdd.body.expectStartDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.match(orderAdd.body.expectEndDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(openingAdd.body.stockIoType, '106')
  assert.equal(openingAdd.body.stkIoEntryList[0].wareLocationId, '103')
  assert.equal(openingAdd.body.stkIoEntryList[0].stockIoDirection, '1')
  assert.ok(api.calls.some((call) => call.path === '/mes/prodOrder/check'))
  assert.ok(api.calls.some((call) => call.path === '/mes/prodWork/transferWorkOrder'))
})

test('轻量委外草稿默认不创建专属生产大链', async () => {
  const calls = []
  const api = {
    async postBusiness(path, body) {
      calls.push({ method: 'POST', path, body })
      assert.equal(path, '/mes/prodOutsource/add')
      return ok('901')
    }
  }
  const draft = await createOutsourceDraft(api, {
    marker: `${OUTSOURCE_MARKER_PREFIX}-LIGHT`,
    prodWorkId: '801', materialId: '802', unitId: '803',
    supplierId: '804', processFeeMaterialId: '805'
  })
  assert.equal(draft.prerequisite, null)
  assert.equal(draft.resources.length, 1)
  assert.equal(draft.body.prodWorkId, '801')
  assert.equal(calls.length, 1)
})

test('委外专属 ID 拒绝不安全 number，保留字符串 Snowflake ID', () => {
  assert.equal(isStableOutsourceId('9007199254740993'), true)
  assert.equal(isStableOutsourceId(9007199254740991), true)
  assert.equal(isStableOutsourceId(9007199254740992), false)
  assert.equal(isStableOutsourceId(0), false)
})

test('专属前置中途失败会登记已创建资源并明确保留，不伪称清理成功', async () => {
  const marker = `${OUTSOURCE_MARKER_PREFIX}-FAILURE`
  const caseRecord = { fixtures: [] }
  const api = makeDedicatedApi(marker, { failPath: '/mes/wmsAssemble/add' })
  await assert.rejects(() => createOutsourceDraft(api, {
    marker,
    caseRecord,
    dedicatedPrerequisite: true,
    supplierId: '9001',
    processFeeMaterialId: '9002'
  }), /simulated failure/)
  assert.deepEqual(caseRecord.fixtures.map((resource) => resource.kind), [
    'warehouse', 'area', 'location', 'material', 'material'
  ])
  assert.ok(caseRecord.fixtures.every((resource) =>
    resource.cleanup === 'RETAINED_AUDIT_FAILURE' && resource.source === 'mes-outsource-write'))
})

test('106 库存数量或可用量不足时不能伪称为可发料专属前置', async () => {
  for (const options of [{ inventoryQty: 0 }, { inventoryQty: 4, inventoryAvailableQty: 0 }]) {
    const marker = `${OUTSOURCE_MARKER_PREFIX}-NO-STOCK-${options.inventoryQty}-${options.inventoryAvailableQty ?? 4}`
    const api = makeDedicatedApi(marker, options)
    await assert.rejects(() => createOutsourceDraft(api, {
      marker,
      dedicatedPrerequisite: true,
      supplierId: '9001',
      processFeeMaterialId: '9002'
    }), /库存事实数量不可用于发料/)
  }
})
