import assert from 'node:assert/strict'
import test from 'node:test'

import { __internal } from '../fixtures/wms-qc-closure.mjs'
import {
  createStockIoFixture,
  fixtureCode,
  WMS_FIXTURE_MARK
} from '../lib/wms-fixtures.mjs'
import { runCase } from '../suites/wms-quality.mjs'

const ok = (data) => ({ code: 0, data })
const record = () => ({ checks: [], notes: [], evidence: [], fixtures: [] })
const localSettings = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { name: 'cfor_admin_standard' }
}
const ownedFixture = () => ({
  token: 'E2E-WMS-RUN-1-UNIT',
  marker: 'E2E-Q001-UNIT',
  warehouse: { id: '201' },
  area: { id: '202' },
  location: { id: '203' },
  material: { id: '204', unitId: '205' },
  unit: { id: '205' }
})

test('legacy QC001 assigns distinct deterministic bill numbers to two 101 materials', async () => {
  const fixture = ownedFixture()
  const caseRecord = record()
  const submissions = []
  const billNos = [1, 2].map((sequence) => fixtureCode(fixture.token, 'IO', `101-${sequence}`))
  const api = {
    async postBusiness (path, body) {
      if (path === '/mes/quality/qualityMaterial/addBatch') return ok(true)
      assert.equal(path, '/mes/stkIo/add/submit')
      submissions.push(structuredClone(body))
      if (submissions.slice(0, -1).some((submission) => submission.billNo === body.billNo)) {
        throw new Error(`Duplicate entry '1-${body.billNo}' for key 'mes_stk_io.uk_mes_stk_io_tenant_bill_no'`)
      }
      return ok(String(205 + submissions.length))
    },
    async getBusiness (path) {
      const query = new URL(path, 'http://unit')
      if (query.pathname === '/mes/stkIo/queryById') {
        return ok({
          id: query.searchParams.get('id'), billNo: submissions.at(-1).billNo,
          stockIoType: '101', isEffective: 1,
          remark: `${WMS_FIXTURE_MARK} ${fixture.token}`
        })
      }
      if (query.pathname === '/mes/quality/qualityPlan/list/dictText') {
        return ok({ records: [{ id: '207' }] })
      }
      if (query.pathname === '/mes/quality/qualityMaterial/list/dictText') {
        return ok({ records: [{ id: '208', materialId: '204', type: '101' }] })
      }
      throw new Error(`unexpected GET ${path}`)
    }
  }
  await createStockIoFixture(api, caseRecord, fixture, { id: '209' }, '205', {
    stockIoType: '101', quantity: 4, isQc: 0
  })
  await createStockIoFixture(
    api, caseRecord, fixture, fixture.material, '205',
    { stockIoType: '101', quantity: 10, isQc: 1 }
  )
  assert.equal(submissions.length, 2)
  assert.equal(submissions[0].billNo, billNos[0])
  assert.equal(submissions[1].billNo, billNos[1])
  assert.notEqual(submissions[0].billNo, submissions[1].billNo)
  assert.notEqual(submissions[0].stkIoEntryList[0].materialId,
    submissions[1].stkIoEntryList[0].materialId)
  assert.equal(submissions.every((body) => body.id == null), true)
  assert.equal(caseRecord.fixtures.filter((row) => row.kind === 'stockIo').length, 2)
  assert.ok(caseRecord.checks.every((check) => check.passed === true))
})

test('closure purchase inbound uses the formal ERP create and reads its generated WMS source without re-inserting it', async () => {
  const fixture = ownedFixture()
  const calls = []
  const caseRecord = record()
  caseRecord.fixtures.push({ kind: 'purchaseOrder', id: '210', marker: fixture.marker })
  let notice
  let submitted = false
  let inboundPayload
  const api = {
    async postBusiness (path, body) {
      calls.push(['POST', path, structuredClone(body)])
      if (path === '/mes/wms/arrival-notice/create') {
        notice = structuredClone(body)
        assert.equal(body.purchaseOrderId, '210')
        assert.equal(body.lines[0].purchaseOrderItemId, '211')
        assert.equal(body.lines[0].iqcCheckFlag, true)
        return ok('217')
      }
      if (path === '/mes/wms/arrival-notice/submit?id=217') {
        submitted = true
        return ok(true)
      }
      assert.equal(path, '/erp/purchase-in/create')
      assert.equal(submitted, true)
      assert.equal(body.orderId, '210')
      assert.equal(body.items[0].orderItemId, '211')
      assert.equal(body.items[0].productId, '204')
      assert.equal(body.id, undefined)
      inboundPayload = structuredClone(body)
      return ok('212')
    },
    async getBusiness (path) {
      calls.push(['GET', path])
      const query = new URL(path, 'http://unit')
      if (query.pathname === '/erp/purchase-order/get') {
        return ok({
          id: '210', status: 20, billNo: 'PO-210', supplierId: '215', remark: fixture.marker,
          items: [{ id: '211', productId: '204', productUnitId: '205', count: 1 }]
        })
      }
      if (query.pathname === '/mes/wms/arrival-notice/get') {
        return ok({
          ...notice, id: '217', status: submitted ? 10 : 0,
          lines: notice.lines.map((line) => ({ ...line, id: '218' }))
        })
      }
      if (query.pathname === '/erp/purchase-in/get') {
        return ok({
          ...inboundPayload, id: '212', status: 20, orderNo: 'PO-210',
          items: inboundPayload.items.map((item) => ({ ...item, id: '219' }))
        })
      }
      if (query.pathname === '/mes/stkIo/list') {
        assert.equal(query.searchParams.get('srcBillType'), 'ErpPurchaseIn')
        assert.equal(query.searchParams.get('srcBillId'), '212')
        return ok({ records: [{
          id: '213', srcBillType: 'ErpPurchaseIn', srcBillId: '212'
        }] })
      }
      if (query.pathname === '/mes/stkIo/queryById') {
        assert.equal(query.searchParams.get('id'), '213')
        return ok({
          id: '213', billNo: 'WMS-SERVER-213', stockIoType: '101',
          srcBillType: 'ErpPurchaseIn', srcBillId: '212'
        })
      }
      if (query.pathname === '/mes/stkIo/queryEntryByMainId') {
        return ok([{
          id: '214', mid: '213', materialId: '204',
          srcBillType: 'ErpPurchaseIn', srcBillId: '212', srcEntryId: '219'
        }])
      }
      throw new Error(`unexpected GET ${path}`)
    }
  }
  const result = await __internal.createPurchaseInbound(
    api, caseRecord, fixture, { id: '215' }, fixture.material,
    { id: '210', item: { id: '211' } }, { id: '216' }
  )
  assert.equal(result.id, '212')
  assert.equal(result.wms.id, '213')
  assert.equal(result.entry.id, '214')
  assert.equal(result.arrival.id, '217')
  assert.deepEqual(calls.filter(([method]) => method !== 'GET').map(([, path]) => path),
    ['/mes/wms/arrival-notice/create', '/mes/wms/arrival-notice/submit?id=217', '/erp/purchase-in/create'])
  assert.equal(caseRecord.checks.every((check) => check.passed), true)
  assert.equal(caseRecord.fixtures.filter((row) => row.kind === 'purchaseInbound').length, 1)
})

test('closure non-quality payload uses its own marker and formal order source, not the legacy IO hash or an existing bill ID', () => {
  const fixture = ownedFixture()
  const control = {
    ...fixture,
    marker: `${fixture.marker}-NONQC`,
    token: `${fixture.token}-NONQC`,
    material: { id: '209', unitId: '205' }
  }
  const body = __internal.buildNonQcInboundPayload(
    control, { id: '215' },
    { id: '210', detail: { billNo: 'PO-210' }, item: { id: '211' } }
  )
  assert.equal(body.billNo, `${control.marker}-101`)
  assert.notEqual(body.billNo, fixtureCode(fixture.token, 'IO', '101'))
  assert.equal(body.srcBillType, 'PurOrder')
  assert.equal(body.srcBillId, '210')
  assert.equal(body.id, undefined)
  assert.equal(body.stkIoEntryList[0].srcEntryId, '211')
  assert.equal(body.stkIoEntryList[0].materialId, '209')
  assert.equal(body.stkIoEntryList[0].isQc, 0)
  assert.equal(body.stkIoEntryList[0].id, undefined)
})

test('the actual closure environment switch dispatches QC001 and QC002 before legacy fixture or shared-config access', async () => {
  const previousWrite = process.env.CFOR_E2E_WRITE_FIXTURES
  const previousEnable = process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE
  delete process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE = 'true'
  try {
    for (const caseId of ['WMS-QC-001', 'WMS-QC-002']) {
      const caseRecord = record()
      const calls = []
      const stop = new Error('UNIT: stop before creating any fixture')
      const api = new Proxy({}, {
        get: (_target, method) => async () => {
          calls.push(['UNEXPECTED_API', method])
          throw new Error(`unexpected API ${String(method)}`)
        }
      })
      await assert.rejects(runCase({
        caseId, page: {}, record: {}, caseRecord, outputDir: '/tmp/wms-qc-unit'
      }, {
        allowWrite: true,
        cleanup: false,
        settings: localSettings,
        login: async () => 'unit-token',
        createApiClient: () => api,
        assertLocalWriteSafety: async () => { calls.push(['SAFETY']) },
        prepareWmsFixture: async (actualApi, actualRecord, index) => {
          assert.equal(actualApi, api)
          assert.equal(actualRecord, caseRecord)
          calls.push(['CLOSURE_PREPARE', index])
          throw stop
        }
      }), (error) => error === stop)
      assert.deepEqual(calls, [['SAFETY'], ['CLOSURE_PREPARE', 11]])
      assert.equal(caseRecord.evidence.some((item) =>
        item.includes(`专属 closure 写侧入口：${caseId}`)), true)
      assert.equal(caseRecord.checks.some((check) =>
        check.name.includes('closure') && check.passed), false)
      assert.equal(caseRecord.passCandidate, false)
      assert.ok(caseRecord.remainingAssertions.length > 0)
    }
  } finally {
    if (previousWrite === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previousWrite
    if (previousEnable === undefined) delete process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE
    else process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE = previousEnable
  }
})
