import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROCUREMENT_SOURCE_GATE_CHECKS,
  assertProcurementSourceRejection,
  assertReconciliationInvoiceSnapshot,
  buildDirectCreatePayload,
  matchesExactProcurementSourceRejection,
  procurementSourceGateContracts,
  PROCUREMENT_RECONCILIATION_SOURCE_TYPE,
  runProcurementSourceGates
} from '../fixtures/procurement-source-gates.mjs'

const ok = (data) => ({ code: 0, data })
const record = () => ({ checks: [], notes: [], evidence: [] })
const ids = Object.freeze({ supplier: '2108967034210226178', material: '2108967034210226181', unit: '2108967034210226183', reconciliation: '2108967034210226189', entry: '2108967034210226191', directOrder: '2108967034210226193' })
const reconciliation = () => ({
  tag: 'UNIT', supplierId: ids.supplier, material: { id: ids.material, unitId: ids.unit },
  reconciliationId: ids.reconciliation,
  confirmed: { lines: [{ id: ids.entry, remainingInvoiceQty: 1, confirmedQty: 1, confirmedPrice: 10 }] }
})

test('direct-create payload needs dedicated source IDs and preserves the reason', () => {
  assert.throws(() => buildDirectCreatePayload({ supplierId: 'invalid', material: {} }), /缺少专属供应商/)
  const payload = buildDirectCreatePayload({
    supplierId: ids.supplier, material: { id: ids.material, unitId: ids.unit }, reason: 'unit emergency', tag: 'UNIT'
  })
  assert.equal(payload.directCreate, 1)
  assert.equal(payload.directCreateReason, 'unit emergency')
  assert.equal(payload.items[0].productId, ids.material)
  assert.equal(payload.items[0].productUnitId, ids.unit)
})

test('source gate rejection matcher accepts only exact business contracts', () => {
  const response = { code: 1030102009, data: null, msg: '紧急直采需要专用权限' }
  assert.equal(matchesExactProcurementSourceRejection(response, procurementSourceGateContracts.directCreatePermission), true)
  assert.equal(matchesExactProcurementSourceRejection({ ...response, data: { leaked: true } }, procurementSourceGateContracts.directCreatePermission), false)
  assert.equal(matchesExactProcurementSourceRejection({ code: 403, data: null, msg: '无权限' }, procurementSourceGateContracts.directCreatePermission), false)
  assert.equal(assertProcurementSourceRejection(response, procurementSourceGateContracts.directCreatePermission, 'unit'), response)
})

test('confirmed purchase reconciliation snapshot requires source type, ID and version', () => {
  const invoice = {
    reconciliationSourceType: PROCUREMENT_RECONCILIATION_SOURCE_TYPE,
    reconciliationSourceIds: `${ids.entry},other`,
    reconciliationSourceVersions: JSON.stringify({
      allocations: [{
        entryId: ids.entry,
        sourceVersion: '2026-10-12T00:00:00Z'
      }]
    })
  }
  assert.equal(assertReconciliationInvoiceSnapshot(invoice, reconciliation()), invoice)
  for (const patch of [
    { reconciliationSourceType: 'FIN_RECEIVABLE' },
    { reconciliationSourceIds: 'other' },
    { reconciliationSourceVersions: '' },
    {
      reconciliationSourceVersions: JSON.stringify({
        allocations: [{ entryId: ids.reconciliation, sourceVersion: '2026-10-12T00:00:00Z' }]
      })
    }
  ]) assert.throws(() => assertReconciliationInvoiceSnapshot({ ...invoice, ...patch }, reconciliation()), /未保存/)
})

test('source gate fixture uses separate principals, creates confirmed reconciliation once, and retains GAP without portal or receivable evidence', async () => {
  const calls = []
  const caseRecord = record()
  let reconciliationConfig = 'false'
  const privilegedApi = {
    async post (path, body, options) {
      calls.push(['privileged-post', path, body, options])
      if (path === '/erp/purchase-order/create') {
        if (!body.directCreateReason) return { code: 1030102010, data: null, msg: '紧急直采必须填写原因' }
        throw new Error('positive direct create must use postBusiness')
      }
      if (path === '/erp/purchase-invoice/create') {
        return {
          code: 1030102013,
          data: null,
          msg: '采购对账已启用，采购发票必须来源于已确认供应商对账'
        }
      }
      throw new Error(`unexpected privileged post path: ${path}`)
    },
    async postBusiness (path, body) {
      calls.push(['privileged-postBusiness', path, body])
      if (path === '/system/config/save?category=purchase&tag=reconciliation') {
        reconciliationConfig = body.configData
        return ok(true)
      }
      assert.equal(path, '/erp/purchase-order/create')
      assert.match(body.directCreateReason, /PROC-004 emergency procurement/)
      return ok(ids.directOrder)
    },
    async getBusiness (path) {
      calls.push(['privileged-getBusiness', path])
      if (path === '/system/config/get?category=purchase&tag=reconciliation') {
        return ok({ configData: reconciliationConfig })
      }
      assert.equal(path, `/erp/purchase-order/get?id=${ids.directOrder}`)
      const create = calls.find((call) =>
        call[0] === 'privileged-postBusiness' && call[1] === '/erp/purchase-order/create'
      )[2]
      return ok({ id: ids.directOrder, directCreate: 1, directCreateReason: create.directCreateReason })
    }
  }
  const lowPrivilegeApi = {
    async post (path, body, options) {
      calls.push(['low-post', path, body, options])
      assert.equal(path, '/erp/purchase-order/create')
      assert.equal(options.expectedBusinessRejection.code, 1030102009)
      return { code: 1030102009, data: null, msg: '紧急直采需要专用权限' }
    }
  }
  let reconciliationCreations = 0
  const result = await runProcurementSourceGates({
    privilegedApi,
    lowPrivilegeApi,
    caseRecord,
    createConfirmedReconciliation: async () => { reconciliationCreations++; return reconciliation() }
  })
  assert.equal(reconciliationCreations, 1)
  assert.equal(result.directOrderId, ids.directOrder)
  assert.equal(calls.filter(([kind]) => kind === 'low-post').length, 1)
  assert.equal(calls.filter(([kind, path]) => kind === 'privileged-post' && path === '/erp/purchase-order/create').length, 1)
  assert.equal(calls.filter(([kind, path]) => kind === 'privileged-post' && path === '/erp/purchase-invoice/create').length, 1)
  assert.equal(reconciliationConfig, 'false')
  assert.equal(calls.filter(([kind, path]) =>
    kind === 'privileged-postBusiness' &&
    path === '/system/config/save?category=purchase&tag=reconciliation').length, 2)
  assert.equal(calls.filter(([kind, path]) =>
    kind === 'privileged-postBusiness' && path === '/erp/purchase-order/create').length, 1)
  assert.equal(caseRecord.checks.find((item) => item.name === PROCUREMENT_SOURCE_GATE_CHECKS.directPermission)?.passed, true)
  assert.equal(caseRecord.checks.find((item) => item.name === PROCUREMENT_SOURCE_GATE_CHECKS.directReason)?.passed, true)
  assert.equal(caseRecord.checks.find((item) => item.name === PROCUREMENT_SOURCE_GATE_CHECKS.confirmedReconciliation)?.passed, true)
  assert.equal(caseRecord.checks.find((item) => item.name === PROCUREMENT_SOURCE_GATE_CHECKS.purchaseInvoiceSource)?.passed, false)
  assert.equal(caseRecord.checks.find((item) => item.name === PROCUREMENT_SOURCE_GATE_CHECKS.saleInvoiceSource)?.passed, false)
  assert.match(caseRecord.notes.join('\n'), /GAP: 缺少供应商门户正式 API 上下文/)
  assert.doesNotMatch(JSON.stringify(calls), /sql|database|INSERT|UPDATE/i)
})

test('source gate fixture refuses to treat a missing low-privilege principal as evidence', async () => {
  await assert.rejects(() => runProcurementSourceGates({
    privilegedApi: { post: async () => ok(), postBusiness: async () => ok(), getBusiness: async () => ok() },
    caseRecord: record()
  }), /separately authenticated low-privilege API client/)
})
