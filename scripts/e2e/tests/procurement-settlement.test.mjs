import test from 'node:test'
import assert from 'node:assert/strict'
import { createProcurementSettlementFixture, procurementSettlementFixturePayload } from '../fixtures/procurement-settlement.mjs'
import {
  PROCUREMENT_DIRECT_CREATE_PERMISSION,
  PROCUREMENT_SUPER_PERMISSION
} from '../fixtures/procurement-direct-create-gate.mjs'

test('PROC-005 settlement fixture uses an isolated method and snapshot order payload', () => {
  const payload = procurementSettlementFixturePayload(
    'UNIT_ABC123',
    { id: '2101', unitId: '3101' },
    '4101'
  )
  assert.match(payload.rule.settleMethodCode, /^E2E_PROC005_/)
  assert.equal(payload.dictionary.value, payload.rule.settleMethodCode)
  assert.equal(payload.dictionary.dictType, 'x_settle_method')
  assert.equal(payload.rule.status, 1)
  assert.equal(payload.order.supplierId, '4101')
  assert.equal(payload.order.settleMethodCode, payload.rule.settleMethodCode)
  assert.equal(payload.order.items[0].productId, '2101')
  assert.equal(payload.order.items[0].productUnitId, '3101')
  assert.equal(payload.order.totalPrice, 88.8)
  assert.equal(payload.order.type, 0)
  assert.equal(payload.order.totalCount, payload.order.items[0].count)
  assert.equal(payload.order.totalProductPrice, payload.order.items[0].productPrice * payload.order.items[0].count)
  assert.equal(payload.order.totalTaxPrice, payload.order.items[0].taxPrice)
  assert.equal(payload.order.totalPrice, payload.order.totalProductPrice + payload.order.totalTaxPrice)
  assert.equal(payload.order.discountPercent, 0)
  assert.equal(payload.order.discountPrice, 0)
  assert.equal(payload.order.items[0].entryNo, 1)
  assert.equal(payload.order.billDate, payload.order.orderTime.slice(0, 10))
  assert.equal(payload.order.directCreate, 1)
  assert.match(payload.order.directCreateReason, /PROC-005 isolated/)
})

const fixtureApi = (record, failAt, permission) => {
  const ids = ['4101', '5101', '6101', '7101', '8101']
  const fields = ['supplierId', 'dictionaryId', 'ruleId', 'orderId', 'saleOrderId']
  let created = 0
  let code
  let updated = false
  let supplierName
  let customerEnabled = false
  let ruleVersion = 1
  let ruleStatus = 1
  let dictionaryStatus = 0
  const success = (data) => ({ code: 0, data })
  return {
    getPermissionInfo: async () => success({ permissions: [permission] }),
    async getBusiness (path) {
      if (path.startsWith('/system/config/get')) {
        return success(permission ? { configData: 'true' } : null)
      }
      if (path.startsWith('/mes/basMaterial/')) {
        return success({ records: [{ id: '2101', unitId: '3101' }] })
      }
      assert.equal(record.fixtures[0].orderId, '7101')
      if (failAt === 'get') throw new Error('injected detail failure')
      if (path.startsWith('/erp/settle-method-rule/get')) {
        return success({
          id: '6101',
          settleMethodCode: code,
          version: ruleVersion,
          status: ruleStatus,
          effectiveFrom: new Date().toISOString().slice(0, 10)
        })
      }
      if (path.startsWith('/base/partner/get')) {
        return success({
          id: '4101',
          name: supplierName,
          shortName: 'E2E-PROC005',
          partnerKind: 'ORGANIZATION',
          status: 'ACTIVE',
          customerEnabled,
          supplierEnabled: true,
          supplierCode: 'S4101',
          carrierEnabled: false
        })
      }
      if (path.startsWith('/system/dict-data/get')) {
        return success({ id: '5101', value: code, dictType: 'x_settle_method', status: dictionaryStatus })
      }
      if (path.startsWith('/erp/sale-order/get')) {
        return success({ settleMethodCode: code, settleMethodRuleVersion: 2 })
      }
      return success({ settleMethodCode: code, settleMethodRuleVersion: 1 })
    },
    async postBusiness (path, payload) {
      for (let index = 0; index < created; index++) {
        assert.equal(record.fixtures[0][fields[index]], ids[index])
      }
      if (created === failAt) throw new Error('injected create failure')
      if (path === '/base/partner/create') supplierName = payload.name
      if (path === '/erp/purchase-order/create') {
        code = payload.settleMethodCode
        assert.equal(payload.directCreate, 1)
        assert.match(payload.directCreateReason, /PROC-005 isolated/)
        assert.equal(payload.totalCount, 1)
        assert.equal(payload.totalProductPrice, 88.8)
        assert.equal(payload.totalTaxPrice, 0)
        assert.equal(payload.type, 0)
      }
      return success(ids[created++])
    },
    async putBusiness (path, body) {
      updated = true
      if (path === '/erp/settle-method-rule/update') {
        ruleVersion++
        ruleStatus = body.status
      }
      if (path === '/base/partner/update') customerEnabled = body.customerEnabled
      if (path === '/system/dict-data/update') {
        assert.equal(body.id, '5101')
        assert.equal(body.value, code)
        dictionaryStatus = body.status
      }
      return failAt === 'update' ? { code: 500, msg: 'injected update failure' } : success(true)
    },
    async post (path) {
      if (path === '/erp/purchase-order/create' || path === '/erp/sale-order/create') {
        return { code: 1030102016, msg: `结算方式【${code}】不存在或未启用` }
      }
      return { code: 500, msg: 'unexpected mock POST' }
    },
    wasUpdated: () => updated
  }
}

for (const failAt of [1, 2, 3, 'get', 'update']) {
  test(`PROC-005 immediately retains created IDs before failure at ${failAt}`, async () => {
    const record = { evidence: [], fixtures: [] }
    const api = fixtureApi(record, failAt)
    await assert.rejects(createProcurementSettlementFixture(api, record), /injected/)
    const created = typeof failAt === 'number' ? failAt : 4
    const fields = ['supplierId', 'dictionaryId', 'ruleId', 'orderId']
    const ids = ['4101', '5101', '6101', '7101']
    assert.equal(record.fixtures.length, 1)
    assert.equal(record.fixtures[0].retained, true)
    assert.equal(record.fixtures[0].status, 'creating')
    for (let index = 0; index < created; index++) {
      assert.equal(record.fixtures[0][fields[index]], ids[index])
    }
    assert.equal(record.evidence.length, created)
  })
}

test('PROC-005 verifies snapshot versions and retains all created IDs', async () => {
  const record = { evidence: [], fixtures: [] }
  const api = fixtureApi(record)
  const result = await createProcurementSettlementFixture(api, record)
  assert.equal(api.wasUpdated(), true)
  assert.equal(result.fixture, record.fixtures[0])
  assert.equal(result.fixture.status, 'verified')
  assert.equal(result.fixture.ruleVersionAtCreate, 1)
  assert.equal(result.fixture.ruleVersionAfterUpdate, 2)
  assert.equal(result.second.settleMethodRuleVersion, 1)
  assert.equal(result.saleSnapshot.settleMethodRuleVersion, 2)
  assert.equal(result.fixture.saleOrderId, '8101')
  assert.equal(result.fixture.ruleVersionAfterDisable, 3)
  assert.equal(result.afterDictionaryDisable.sale.settleMethodRuleVersion, 2)
  assert.equal(result.rejectedSale.code, 1030102016)
  assert.equal(result.rejectedPurchase.code, 1030102016)
})

for (const permission of [PROCUREMENT_DIRECT_CREATE_PERMISSION, PROCUREMENT_SUPER_PERMISSION]) {
  test(`PROC-005 completes settlement snapshots with requisition enabled and ${permission}`, async () => {
    const record = { evidence: [], fixtures: [] }
    const result = await createProcurementSettlementFixture(fixtureApi(record, undefined, permission), record)
    assert.equal(result.fixture.status, 'verified')
    assert.equal(result.fixture.requisitionEnabled, true)
    assert.equal(result.fixture.directCreatePermission, permission)
    assert.equal(result.afterDictionaryDisable.purchase.settleMethodRuleVersion, 1)
    assert.equal(result.afterDictionaryDisable.sale.settleMethodRuleVersion, 2)
    assert.equal(result.rejectedPurchase.code, 1030102016)
    assert.equal(result.rejectedSale.code, 1030102016)
  })
}

test('PROC-005 fixture source contains only the approved procurement write endpoints', async () => {
  const source = await import('../fixtures/procurement-settlement.mjs')
  assert.equal(typeof source.createProcurementSettlementFixture, 'function')
  const fs = await import('node:fs')
  const text = fs.readFileSync(new URL('../fixtures/procurement-settlement.mjs', import.meta.url), 'utf8')
  for (const path of [
    '/base/partner/create',
    '/base/partner/get',
    '/base/partner/update',
    '/system/dict-data/create',
    '/system/dict-data/get',
    '/system/dict-data/update',
    '/erp/settle-method-rule/create',
    '/erp/purchase-order/create',
    '/erp/purchase-order/get',
    '/erp/settle-method-rule/update',
    '/erp/sale-order/create',
    '/erp/sale-order/get'
  ]) assert.match(text, new RegExp(path.replaceAll('/', '\\/')))
  assert.doesNotMatch(text, /system\/config\/update|system\/config\/create|\/system\/dict-data\/delete/)
})
