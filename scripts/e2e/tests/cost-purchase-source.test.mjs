import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuditedPurchaseReceipt } from '../fixtures/cost-scenario.mjs'

const options = {
  suffix: 'AABBCCDDEEFF',
  month: '2208-10',
  material: { materialId: '2109000000000000001', unitId: '100' },
  warehouseId: '200',
  accountId: '300'
}
const ok = (data) => ({ code: 0, data })

function receiptApi ({ noticeStatus = 20, auditStatus = 20 } = {}) {
  const calls = []
  const api = {
    postBusiness: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      if (path === '/base/partner/create') return ok('401')
      if (path === '/erp/purchase-order/create') return ok('402')
      if (path === '/mes/wms/arrival-notice/create') return ok('404')
      if (path === '/mes/wms/arrival-notice/submit?id=404') return ok(true)
      if (path === '/erp/purchase-in/create') return ok('405')
      assert.fail(`Unexpected POST ${path}`)
    },
    putBusiness: async (path) => {
      calls.push({ method: 'PUT', path })
      assert.equal(path, '/erp/purchase-in/update-status?id=405&status=20')
      return ok(true)
    },
    getBusiness: async (path) => {
      calls.push({ method: 'GET', path })
      if (path === '/erp/purchase-order/get?id=402') {
        return ok({ id: '402', billNo: 'ORDER-402', items: [{ id: '403' }] })
      }
      if (path === '/mes/wms/arrival-notice/get?id=404') {
        return ok({
          id: '404', purchaseOrderId: '402', status: noticeStatus,
          lines: [{
            purchaseOrderItemId: '403', itemId: options.material.materialId,
            arrivalQuantity: 2
          }]
        })
      }
      if (path === '/erp/purchase-in/get?id=405') {
        return ok({
          id: '405', orderId: '402', status: auditStatus,
          items: [{ productId: options.material.materialId, count: 2 }]
        })
      }
      assert.fail(`Unexpected GET ${path}`)
    }
  }
  return { api, calls }
}

test('purchase cost fixtures submit and read the owned ASN before creating a normal ERP receipt', async () => {
  const { api, calls } = receiptApi()
  const fixture = {}
  await createAuditedPurchaseReceipt({ ...options, api, fixture })
  const notice = calls.find((call) => call.path === '/mes/wms/arrival-notice/create').body
  assert.equal(notice.purchaseOrderId, '402')
  assert.equal(notice.lines[0].purchaseOrderItemId, '403')
  assert.equal(notice.lines[0].itemId, options.material.materialId)
  assert.equal(notice.lines[0].arrivalQuantity, 2)
  const submitIndex = calls.findIndex((call) => call.path.includes('/arrival-notice/submit'))
  const readIndex = calls.findIndex((call) => call.path.includes('/arrival-notice/get'))
  const receiptIndex = calls.findIndex((call) => call.path === '/erp/purchase-in/create')
  assert.ok(submitIndex < readIndex && readIndex < receiptIndex)
  assert.equal(calls[receiptIndex].body.businessType, 'NORMAL')
  assert.deepEqual(fixture, {
    supplierId: '401', purchaseOrderId: '402', orderItemId: '403',
    noticeId: '404', purchaseInId: '405'
  })
})

test('an unsubmitted or invalid ASN never authorizes receipt creation and retains its registered IDs', async () => {
  for (const noticeStatus of [0, 40, undefined]) {
    const { api, calls } = receiptApi({ noticeStatus: noticeStatus ?? null })
    const fixture = {}
    await assert.rejects(
      createAuditedPurchaseReceipt({ ...options, api, fixture }),
      /到货通知未形成有效/
    )
    assert.equal(fixture.noticeId, '404')
    assert.equal(fixture.purchaseInId, undefined)
    assert.ok(!calls.some((call) => call.path === '/erp/purchase-in/create'))
  }
})

test('successful audit submission does not replace an audited receipt readback', async () => {
  const { api } = receiptApi({ auditStatus: 10 })
  const fixture = {}
  await assert.rejects(
    createAuditedPurchaseReceipt({ ...options, api, fixture }),
    /采购入库审核状态或来源明细不一致/
  )
  assert.equal(fixture.purchaseInId, '405')
})
