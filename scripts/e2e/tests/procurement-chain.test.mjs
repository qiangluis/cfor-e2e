import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROCUREMENT_CHAIN_ROUTES,
  assertOwnedProcurementMaterial,
  assertOwnedProcurementRequest,
  buildProcurementChainPlan,
  captureProcurementChainBrowserEvidence,
  executeApprovedProcurementReturn,
  PROCUREMENT_ARRIVAL_NOTICE_REQUIRED,
  procurementChainCases,
  runProcurementChainFixture
} from '../fixtures/procurement-chain.mjs'
import { PROCUREMENT_MRP_CHECKS } from '../fixtures/procurement-mrp-closure.mjs'
import {
  procurementCatalogEvidence,
  runCase as runProcurementCase
} from '../suites/procurement.mjs'

const record = () => ({ checks: [], notes: [], evidence: [], screenshots: [] })
const ok = (data) => ({ code: 0, data })

test('PROC-001~004 each expose a distinct formal API chain plan', () => {
  assert.deepEqual(procurementChainCases, ['PROC-001', 'PROC-002', 'PROC-003', 'PROC-004'])
  for (const caseId of procurementChainCases) {
    const plan = buildProcurementChainPlan(caseId, {
      mrpId: '101', requestId: '102', orderId: '103', orderItemId: '104',
      materialId: '105', unitId: '106', supplierId: '107', warehouseId: '108', areaId: '109'
    })
    assert.equal(plan.caseId, caseId)
    assert.ok(plan.writes.length > 0)
    assert.ok(plan.routes.length > 0)
  }
  assert.ok(buildProcurementChainPlan('PROC-004').reads.includes('/system/config/business-options/list?moduleCode=erp'))
})

test('chain payloads preserve MRP, request, ASN, WMS receipt and return source identities', () => {
  const context = { mrpId: '101', requestId: '102', orderId: '103', orderItemId: '104', materialId: '105', unitId: '106', supplierId: '107', warehouseId: '108', areaId: '109', quantity: 2 }
  const mrp = buildProcurementChainPlan('PROC-001', context)
  const order = buildProcurementChainPlan('PROC-002', context).writes[1].path
  const arrival = buildProcurementChainPlan('PROC-003', context)
  assert.deepEqual(mrp.writes.map((item) => item.path), [
    '/mes/mrp/calculate',
    '/mes/mrp/generatePurchasePlan?calculationId=<mrp-id>'
  ])
  assert.equal(mrp.writes.some((item) => item.path === '/erp/purchase/order/request/create'), false)
  assert.match(order, /place\/an\/order\?ids=\<request-id\>/)
  assert.equal(arrival.writes[0].body.purchaseOrderId, '103')
  assert.equal(arrival.writes[0].body.lines[0].purchaseOrderItemId, '104')
  assert.equal(arrival.writes[2].body[0].warehouseId, '108')
  assert.equal(arrival.writes[3].body.srcBillType, 'PurOrder')
  assert.equal(arrival.writes[3].body.srcBillId, '103')
  assert.equal(arrival.writes[3].body.returnType, 2)
  assert.equal(arrival.writes[3].body.items[0].srcEntryId, '104')
  assert.equal(arrival.writes[3].body.items[0].areaHouseId, '109')
})

test('PROC-003 direct inbound probe requires the exact submitted-arrival-notice rejection contract', () => {
  assert.equal(PROCUREMENT_ARRIVAL_NOTICE_REQUIRED.code, 1_020_205_013)
  assert.match(PROCUREMENT_ARRIVAL_NOTICE_REQUIRED.message.source, /采购入库必须来源于已提交的到货通知/)
})

test('readonly mode produces a deferred plan and never calls a write API', async () => {
  const calls = []
  const api = {
    async getBusiness () { calls.push('GET'); throw new Error('readonly fixture must not call API') },
    async post () { calls.push('POST'); throw new Error('unexpected POST') },
    async postBusiness () { calls.push('POST business'); throw new Error('unexpected POST') },
    async putBusiness () { calls.push('PUT'); throw new Error('unexpected PUT') }
  }
  const caseRecord = record()
  const result = await runProcurementChainFixture({
    caseId: 'PROC-001', api, caseRecord, chain: {}, writeEnabled: false
  })
  assert.equal(result.partial, true)
  assert.equal(result.deferred, true)
  assert.equal(calls.length, 0)
  assert.match(caseRecord.notes.join('\n'), /未执行真实写侧/)
})

test('runtime uses the same injected API object and refuses order creation without approved request', async () => {
  const calls = []
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path.includes('/purchase/order/request/get')) return ok({
        id: '102', status: 10, processInstanceId: 'p-1',
        srcBillType: 'MRP', srcBillId: '105',
        itemsList: [{ id: '103', productId: '104' }]
      })
      throw new Error(`unexpected GET ${path}`)
    },
    async putBusiness (path) { calls.push(['PUT', path]); return ok(true) },
    async postBusiness () { assert.fail('must not create order while approval is pending') },
    async post () { assert.fail('must not use raw POST for PROC-002') }
  }
  await assert.rejects(() => runProcurementChainFixture({
    caseId: 'PROC-002', api, caseRecord: record(), chain: {
      requestId: '102', requestItemId: '103', materialId: '104', mrpId: '105',
      ownedMarker: 'AUTOTEST-PROC-001-OWNED',
      executionFixture: {
        marker: 'AUTOTEST-PROC-001-OWNED',
        owned: [{ kind: 'material', id: '104', marker: 'AUTOTEST-PROC-001-OWNED' }]
      }
    }, writeEnabled: true
  }), /BLOCKED: PROC-002/)
  assert.equal(calls.filter(([method]) => method === 'POST').length, 0)
  assert.equal(calls.filter(([method]) => method === 'PUT').length, 1)
})

test('PROC-002 rejects a foreign MRP request before submission or order creation', () => {
  const marker = 'AUTOTEST-PROC-001-OWNED'
  const chain = {
    requestId: '102', requestItemId: '103', materialId: '104', mrpId: '105',
    ownedMarker: marker,
    executionFixture: {
      marker,
      owned: [{ kind: 'material', id: '104', marker }]
    }
  }
  assert.throws(() => assertOwnedProcurementRequest({
    request: {
      id: '102', srcBillType: 'MRP', srcBillId: '999',
      itemsList: [{ id: '103', productId: '104' }]
    },
    chain,
    caseRecord: record()
  }), /owned MRP 来源链/)
})

test('PROC-001 uses the owned MRP closure and never falls back to direct request creation', async () => {
  const calls = []
  const fixture = {
    marker: 'AUTOTEST-PROC-001-OWNED',
    component: { id: '104', unitId: '106' },
    mrpSupplier: { id: '107' },
    owned: [{ kind: 'material', id: '104', marker: 'AUTOTEST-PROC-001-OWNED' }]
  }
  const request = {
    id: '102', billNo: 'PR-102', srcBillType: 'MRP', srcBillId: '101',
    itemsList: [{ id: '103', productId: '104', productUnitId: '106', supplierId: '107', inCount: 2 }]
  }
  const caseRecord = record()
  const chain = {}
  const api = {
    getBusiness: async (path) => path.includes('/system/config/get')
      ? ok({ configData: 'false' })
      : ok([{ optionCode: 'ERP.PURCHASE.REQUISITION', currentValue: 'true' }]),
    postBusiness: async () => ok({})
  }
  const result = await runProcurementChainFixture({
    caseId: 'PROC-001', api, record: {}, caseRecord, chain, writeEnabled: true,
    runMrpClosure: async (input) => {
      calls.push(input)
      caseRecord.checks.push(
        { name: 'PROC-001 专属工单 MRP 返回真实缺料、净需求和采购建议', passed: true },
        { name: 'PROC-002 自动请购唯一引用本轮 MRP 运算及缺料物料', passed: true },
        { name: 'PROC-002 重复生成采购计划被正式幂等拒绝且请购数量不增加', passed: true }
      )
      return { partial: false, state: { calculationId: '101', fixture, request } }
    }
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cleanup, true)
  assert.equal(calls[0].preserveSuccessfulFixture, true)
  assert.equal(chain.materialId, '104')
  assert.equal(chain.requestId, '102')
  assert.equal(chain.ownedMarker, fixture.marker)
  assert.equal(chain.mrpClosure.idempotencyVerified, true)
  assert.equal(result.partial, true)
})

test('a failed PROC-001 rerun clears stale request and order identities', async () => {
  const chain = {
    requestId: 'stale-request',
    orderId: 'stale-order',
    materialId: 'stale-material'
  }
  const caseRecord = record()
  const api = {
    getBusiness: async (path) => path.includes('/system/config/get')
      ? ok({ configData: 'false' })
      : ok([{ optionCode: 'ERP.PURCHASE.REQUISITION', currentValue: 'true' }]),
    postBusiness: async () => ok({})
  }
  const result = await runProcurementChainFixture({
    caseId: 'PROC-001', api, record: {}, caseRecord, chain, writeEnabled: true,
    runMrpClosure: async () => ({ partial: true, state: {} })
  })
  assert.equal(result.partial, true)
  assert.equal(chain.requestId, undefined)
  assert.equal(chain.orderId, undefined)
  assert.equal(chain.materialId, undefined)
  assert.equal(chain.requisitionConfig?.prepared, true)
  assert.match(caseRecord.notes.join('\n'), /禁止回退到共享 MRP/)
})

test('PROC-003 rejects shared material before any quality or WMS write', async () => {
  let reads = 0
  const api = { async getBusiness () { reads++; return ok({ id: '104', remark: 'SHARED' }) } }
  await assert.rejects(() => runProcurementChainFixture({
    caseId: 'PROC-003', api, caseRecord: record(), writeEnabled: true,
    chain: { orderId: '201', orderItemId: '202', materialId: '104' }
  }), /Execution owned 物料/)
  assert.equal(reads, 0)
})

test('owned material gate requires both fixture ownership and persisted marker', async () => {
  const marker = 'AUTOTEST-PROC-001-OWNED'
  const chain = {
    requestId: '102', orderId: '201', materialId: '104', ownedMarker: marker,
    executionFixture: {
      marker,
      component: { id: '104' },
      owned: [{ kind: 'material', id: '104', marker }]
    }
  }
  const caseRecord = record()
  const material = await assertOwnedProcurementMaterial({
    api: { getBusiness: async () => ok({ id: '104', remark: marker }) },
    chain,
    caseRecord
  })
  assert.equal(material.id, '104')
  assert.equal(caseRecord.checks[0].passed, true)

  await assert.rejects(() => assertOwnedProcurementMaterial({
    api: { getBusiness: async () => ok({ id: '104', remark: 'SHARED' }) },
    chain,
    caseRecord: record()
  }), /owned 物料标记回读不匹配/)
})

test('browser evidence opens the four domain pages without a second login', async () => {
  const opened = []
  const shots = []
  const caseRecord = record()
  await captureProcurementChainBrowserEvidence({
    page: {}, caseId: 'PROC-003', outputDir: '/tmp', record: {}, caseRecord,
    openRoute: async (_page, route) => opened.push(route),
    saveScreenshot: async (_page, _dir, name) => { shots.push(name); return `/tmp/${name}.png` }
  })
  assert.deepEqual(opened, [PROCUREMENT_CHAIN_ROUTES.order, PROCUREMENT_CHAIN_ROUTES.arrival, PROCUREMENT_CHAIN_ROUTES.inbound, PROCUREMENT_CHAIN_ROUTES.return])
  assert.equal(shots.length, opened.length)
})

test('suite session cache logs in once for the four chain cases', async () => {
  const page = {}
  const caseRecords = procurementChainCases.map(() => record())
  let logins = 0
  let factories = 0
  const dependencies = {
    login: async () => { logins += 1; return 'shared-token' },
    createApiClient: ({ token }) => {
      factories += 1
      assert.equal(token, 'shared-token')
      return { getBusiness: async () => { throw new Error('readonly plan must not call API') } }
    },
    env: {}
  }
  for (const [index, caseId] of procurementChainCases.entries()) {
    const result = await runProcurementCase({
      caseId, page, record: {}, caseRecord: caseRecords[index], outputDir: '/tmp'
    }, dependencies)
    assert.equal(result.partial, true)
  }
  assert.equal(logins, 1)
  assert.equal(factories, 1)
})

test('suite preserves one owned chain object across PROC-001 to PROC-003', async () => {
  const page = {}
  const seen = []
  let logins = 0
  const dependencies = {
    env: { CFOR_E2E_WRITE_FIXTURES: 'true' },
    login: async () => { logins++; return 'shared-token' },
    createApiClient: () => ({ id: 'shared-api' }),
    runProcurementChainFixture: async ({ caseId, chain, api, writeEnabled }) => {
      seen.push({ caseId, chain, api, writeEnabled })
      if (caseId === 'PROC-001') {
        Object.assign(chain, {
          ownedMarker: 'AUTOTEST-PROC-001-OWNED',
          materialId: '104', requestId: '102', mrpId: '101'
        })
      }
      if (caseId === 'PROC-002') chain.orderId = '201'
      return { chain, partial: true }
    }
  }
  for (const caseId of ['PROC-001', 'PROC-002', 'PROC-003']) {
    await runProcurementCase({
      caseId, page, record: {}, caseRecord: record(), outputDir: '/tmp'
    }, dependencies)
  }
  assert.equal(logins, 1)
  assert.equal(seen.length, 3)
  assert.ok(seen.every((entry) => entry.chain === seen[0].chain))
  assert.ok(seen.every((entry) => entry.api === seen[0].api))
  assert.ok(seen.every((entry) => entry.writeEnabled === true))
  assert.equal(seen[2].chain.ownedMarker, 'AUTOTEST-PROC-001-OWNED')
  assert.equal(seen[2].chain.orderId, '201')
})

test('PROC-001 catalog keeps ATP, net-demand and start-block assertions GAP', () => {
  const caseRecord = record()
  caseRecord.checks.push(
    { name: PROCUREMENT_MRP_CHECKS.shortage, passed: true, details: 'owned shortage' },
    { name: PROCUREMENT_MRP_CHECKS.source, passed: true, details: 'owned request' },
    {
      name: 'PROC-001 owned Execution 物料通过正式 MRP 自动请购保留来源和明细',
      passed: true,
      details: 'owned chain'
    }
  )
  procurementCatalogEvidence('PROC-001', caseRecord, {
    0: { gap: 'ATP missing' },
    1: { gap: 'net demand dimensions missing' },
    2: { gap: 'start rejection missing' },
    3: { checks: [PROCUREMENT_MRP_CHECKS.shortage, PROCUREMENT_MRP_CHECKS.source,
      'PROC-001 owned Execution 物料通过正式 MRP 自动请购保留来源和明细'] }
  })
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.status), [
    'GAP', 'GAP', 'GAP', 'VERIFIED'
  ])
  assert.equal(caseRecord.passCandidate, false)
})

test('manual approved return executes through the formal endpoint without a BPM instance', async () => {
  const calls = []
  const api = {
    async putBusiness (path) { calls.push(path); return ok(true) },
    async getBusiness () { return ok({ id: '123', billStage: '34', isEffective: 1, status: 20 }) }
  }
  const result = await executeApprovedProcurementReturn({
    api, purchaseReturn: { id: '123', billStage: '24', isEffective: 1, actions: { execute: true } },
    caseRecord: record()
  })
  assert.deepEqual(calls, ['/erp/purchase-return/execute?id=123'])
  assert.equal(result.status, 20)
})

test('return execution refuses unaudited states and does not repeat an executed write', async () => {
  const api = { putBusiness: async () => assert.fail('must not write') }
  await assert.rejects(executeApprovedProcurementReturn({
    api, purchaseReturn: { id: '123', billStage: '22', isEffective: 0 },
    caseRecord: record()
  }), /尚未审核通过/)
  await assert.rejects(executeApprovedProcurementReturn({
    api, purchaseReturn: { id: '123', billStage: '24', isEffective: 1, actions: {} },
    caseRecord: record()
  }), /缺少可执行动作/)
  const bill = { id: '123', billStage: '34', isEffective: 1, status: 20 }
  assert.equal(await executeApprovedProcurementReturn({ api, purchaseReturn: bill, caseRecord: record() }), bill)
})
