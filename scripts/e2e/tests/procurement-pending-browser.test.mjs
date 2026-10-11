import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPendingRequestPayload, assertPendingSaleSelection, createPendingRequestBrowserFixture
} from '../fixtures/procurement-pending-browser.mjs'

const source = {
  saleOrderId: '2109264816687083522',
  saleOrder: { billNo: 'AUTOTEST-PROC-017-SOURCE' },
  material: { id: '2109264816687083523', unitId: '2109264816687083524' }
}
const item = {
  productId: source.material.id, productUnitId: source.material.unitId, count: 2, inCount: 2
}
const payload = () => ({
  srcBillType: 'sale', srcBillId: source.saleOrderId, srcNo: source.saleOrder.billNo,
  status: 0, itemsList: [{ ...item }]
})
const list = () => ({ code: 0, data: { list: [{
  id: source.saleOrderId, billNo: source.saleOrder.billNo, status: 20, items: [{ ...item }]
}] } })

test('browser generation requires exact source and lossless IDs', () => {
  assert.equal(assertPendingSaleSelection(list(), source).id, source.saleOrderId)
  assert.equal(assertPendingRequestPayload(payload(), source).srcBillId, source.saleOrderId)
  for (const change of [
    { srcBillId: Number(source.saleOrderId) }, { srcBillId: '99' },
    { srcBillType: 'SALE_ORDER' }, { srcNo: 'other' }, { status: 20 },
    { pendingSourceId: '99' }, { itemsList: [] },
    { itemsList: [{ ...item, inCount: 3 }] },
    { itemsList: [{ ...item, productUnitId: '99' }] }
  ]) assert.throws(() => assertPendingRequestPayload({ ...payload(), ...change }, source))
})

test('browser selection rejects empty, duplicate, unaudited or unrelated sources', () => {
  for (const rows of [[], [...list().data.list, ...list().data.list],
    [{ ...list().data.list[0], status: 0 }], [{ ...list().data.list[0], id: '99' }],
    [{ ...list().data.list[0], items: [{ ...item, count: 3 }] }]
  ]) assert.throws(() => assertPendingSaleSelection({ data: { list: rows } }, source))
})

function fixtureApi (requestChanges = {}) {
  const calls = []
  return {
    calls,
    async postBusiness (url, body) {
      calls.push({ url, body })
      return { code: 0, data: url === '/base/partner/create'
        ? '2109264816687083525' : source.saleOrderId }
    },
    async getBusiness (url) {
      if (url.startsWith('/mes/basMaterial/')) return {
        code: 200, success: true,
        data: { records: [{ id: source.material.id, unitId: source.material.unitId }] }
      }
      if (url.startsWith('/erp/sale-order/get')) return {
        code: 0, data: { ...source.saleOrder, id: source.saleOrderId, status: 20 }
      }
      return { code: 0, data: {
        id: '2109264816687083526', billNo: 'QGD-ISOLATED', srcBillType: 'sale',
        srcBillId: source.saleOrderId, srcNo: source.saleOrder.billNo,
        billStage: '14', isEffective: 0, isClosed: 0,
        itemsList: [{ ...item }], ...requestChanges
      } }
    }
  }
}
const generated = () => ({
  viaBrowser: true, payload: payload(), response: { code: 0, data: '2109264816687083526' }
})

test('pending fixture has no API-only generation fallback and retains exact browser provenance', async () => {
  const api = fixtureApi()
  await assert.rejects(createPendingRequestBrowserFixture(api, {}, undefined), /真实浏览器/)
  assert.equal(api.calls.length, 0)
  const record = { fixtures: [] }
  const write = await createPendingRequestBrowserFixture(api, record, async (actual) => {
    assert.equal(actual.saleOrderId, source.saleOrderId)
    return generated()
  })
  assert.equal(api.calls[0].body.supplierEnabled, false)
  assert.equal(api.calls.some(({ url }) => url.includes('/request/create')), false)
  assert.equal(write.fixture.generatedViaBrowser, true)
  assert.equal(write.fixture.requestId, '2109264816687083526')
  assert.equal(write.fixture.status, 'verified')
})

test('pending fixture rejects false browser evidence and incorrect persisted provenance or state', async () => {
  await assert.rejects(createPendingRequestBrowserFixture(fixtureApi(), {}, async () => ({
    ...generated(), viaBrowser: false
  })), /真实浏览器/)
  for (const change of [
    { id: '99' }, { srcBillType: 'SALE_ORDER' }, { srcBillId: '99' }, { srcNo: 'other' },
    { billStage: '32' }, { isEffective: 1 }, { isClosed: 1 }, { itemsList: [] },
    { itemsList: [{ ...item, inCount: 3 }] }
  ]) {
    const record = {}
    await assert.rejects(createPendingRequestBrowserFixture(
      fixtureApi(change), record, async () => generated()
    ), /请购回读/)
    assert.equal(record.fixtures[0].requestId, '2109264816687083526')
    assert.equal(record.fixtures[0].status, 'creating')
  }
})
