import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertProcurementDirectCreateGate,
  parseProcurementRequisitionConfig,
  PROCUREMENT_DIRECT_CREATE_PERMISSION,
  PROCUREMENT_SUPER_PERMISSION
} from '../fixtures/procurement-direct-create-gate.mjs'
import { createProcurementSettlementFixture } from '../fixtures/procurement-settlement.mjs'
import { createSettleRuleWriteFixture } from '../fixtures/procurement-settle-rule-write.mjs'
import { createPurchaseTypeRuleWriteFixture } from '../fixtures/procurement-batch-a.mjs'

const ok = (data) => ({ code: 0, data })

test('procurement requisition config parser accepts backend boolean forms', () => {
  for (const [configData, enabled] of [
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['{"enabled":true}', true],
    ['{"enabled":false}', false],
    ['{"enabled":"true"}', true],
    ['{"enabled":1}', true]
  ]) {
    assert.deepEqual(parseProcurementRequisitionConfig({ configData }), {
      valid: true,
      enabled,
      source: ['true', '1', 'false', '0'].includes(configData) ? 'scalar' : 'json'
    })
  }
  assert.deepEqual(parseProcurementRequisitionConfig(null), {
    valid: true,
    enabled: false,
    source: 'missing'
  })
})

test('malformed requisition config fails closed before permission lookup', async () => {
  let permissionReads = 0
  const api = {
    getBusiness: async () => ok({ configData: '{"enabled":' }),
    getPermissionInfo: async () => {
      permissionReads++
      return ok({ permissions: [PROCUREMENT_DIRECT_CREATE_PERMISSION] })
    }
  }
  assert.equal(parseProcurementRequisitionConfig({ configData: 'not-json' }).valid, false)
  await assert.rejects(
    assertProcurementDirectCreateGate(api, 'PROC-GATE'),
    /BLOCKED: PROC-GATE 请购配置 JSON 无法解析/
  )
  assert.equal(permissionReads, 0)
})

test('enabled requisition accepts only existing direct-create or super permission', async () => {
  for (const permission of [
    PROCUREMENT_DIRECT_CREATE_PERMISSION,
    PROCUREMENT_SUPER_PERMISSION
  ]) {
    const result = await assertProcurementDirectCreateGate({
      getBusiness: async () => ok({ configData: '{"enabled":true}' }),
      getPermissionInfo: async () => ok({ permissions: [permission] })
    }, 'PROC-GATE')
    assert.equal(result.requisitionEnabled, true)
    assert.equal(result.directCreatePermission, permission)
  }
})

test('enabled requisition without existing direct-create permission stays blocked', async () => {
  const api = {
    getBusiness: async () => ok({ configData: '{"enabled":true}' }),
    getPermissionInfo: async () => ok({
      permissions: ['erp:purchase-order:query', 'erp:purchase-order:create', 'erp:settle-method-rule:update']
    })
  }
  await assert.rejects(
    assertProcurementDirectCreateGate(api, 'PROC-GATE'),
    /BLOCKED: PROC-GATE 请购开关已开启且当前账号没有 erp:purchase-order:direct-create/
  )
})

test('PROC-005/006 continue past the gate with the legal admin direct-create permission', async () => {
  const fixtures = [
    ['PROC-005', createProcurementSettlementFixture, /PROC-005 没有可采购的专属物料\/单位/],
    ['PROC-006', createSettleRuleWriteFixture, /PROC-006 没有可采购的物料\/单位/]
  ]
  for (const [caseId, createFixture, expectedError] of fixtures) {
    const events = []
    const api = {
      getBusiness: async (path) => {
        events.push(`GET ${path}`)
        if (path.startsWith('/system/config/get')) return ok({ configData: 'true' })
        if (path.startsWith('/mes/basMaterial/')) return ok({ records: [] })
        throw new Error(`unexpected GET ${path}`)
      },
      getPermissionInfo: async () => {
        events.push('GET /system/auth/get-permission-info')
        return ok({ permissions: [PROCUREMENT_DIRECT_CREATE_PERMISSION] })
      },
      postBusiness: async () => {
        throw new Error(`${caseId} attempted a write before material prerequisite`)
      }
    }
    const record = { evidence: [], fixtures: [] }
    await assert.rejects(createFixture(api, record), expectedError)
    assert.deepEqual(record.fixtures, [])
    assert.deepEqual(events, [
      'GET /system/config/get?category=purchase&tag=requisition',
      'GET /system/auth/get-permission-info',
      'GET /mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
    ])
  }
})

for (const permission of [PROCUREMENT_DIRECT_CREATE_PERMISSION, PROCUREMENT_SUPER_PERMISSION]) {
  test(`PROC-006 completes rule versions with requisition enabled and ${permission}`, async () => {
    const record = { evidence: [], fixtures: [] }
    const orders = new Map()
    let rule
    let dictionary
    let permissionRead = false
    const api = {
      getPermissionInfo: async () => {
        permissionRead = true
        return ok({ permissions: [permission] })
      },
      async getBusiness (path) {
        if (path === '/system/config/get?category=purchase&tag=requisition') {
          return ok({ configData: 'true' })
        }
        assert.equal(permissionRead, true)
        if (path.startsWith('/mes/basMaterial/')) {
          return ok({ records: [{ id: '2101', unitId: '3101' }] })
        }
        if (path.startsWith('/erp/settle-method-rule/get?')) return ok({ ...rule })
        if (path.startsWith('/erp/settle-method-rule/list-by-code?')) return ok([{ ...rule }])
        if (path.startsWith('/erp/purchase-order/get?')) {
          return ok(orders.get(new URL(path, 'http://localhost').searchParams.get('id')))
        }
        throw new Error(`unexpected GET ${path}`)
      },
      async postBusiness (path, body) {
        assert.equal(permissionRead, true)
        if (path === '/base/partner/create') return ok('4101')
        if (path === '/system/dict-data/create') {
          dictionary = body
          return ok('5101')
        }
        if (path === '/erp/settle-method-rule/create') {
          rule = { ...body, id: '6101', version: 1, settleMethodName: dictionary.label }
          return ok(rule.id)
        }
        assert.equal(path, '/erp/purchase-order/create')
        assert.equal(body.directCreate, 1)
        assert.match(body.directCreateReason, /PROC-006 isolated order/)
        const id = String(7101 + orders.size)
        orders.set(id, {
          ...body, id, status: 20, settleMethodRuleVersion: rule.version
        })
        return ok(id)
      },
      async putBusiness (path, body) {
        assert.equal(path, '/erp/settle-method-rule/update')
        rule = { ...rule, ...body, version: rule.version + 1 }
        return ok(true)
      }
    }
    const result = await createSettleRuleWriteFixture(api, record)
    assert.equal(result.fixture.requisitionEnabled, true)
    assert.equal(result.fixture.directCreatePermission, permission)
    assert.equal(result.createdRule.version, 1)
    assert.equal(result.ruleV2.version, 2)
    assert.equal(result.orderV1.detail.settleMethodRuleVersion, 1)
    assert.equal(result.orderV2.detail.settleMethodRuleVersion, 2)
    assert.equal(result.orderV1After.settleMethodRuleVersion, 1)
    assert.equal(result.finalRule.status, 0)
    assert.equal(result.finalRule.version, 3)
    assert.equal(orders.size, 2)
  })
}

test('PROC-005/006/008 block before their first write when direct-create is unavailable', async () => {
  const fixtures = [
    ['PROC-005', createProcurementSettlementFixture],
    ['PROC-006', createSettleRuleWriteFixture],
    ['PROC-008', createPurchaseTypeRuleWriteFixture]
  ]
  for (const [caseId, createFixture] of fixtures) {
    const events = []
    const api = {
      getBusiness: async (path) => {
        events.push(`GET ${path}`)
        return ok({ configData: 'true' })
      },
      getPermissionInfo: async () => {
        events.push('GET /system/auth/get-permission-info')
        return ok({ permissions: ['erp:purchase-order:create'] })
      },
      postBusiness: async () => {
        events.push('POST')
        return ok('unexpected-write')
      },
      putBusiness: async () => {
        events.push('PUT')
        return ok(true)
      },
      post: async () => {
        events.push('POST raw')
        return { code: 0, data: 'unexpected-write' }
      },
      delete: async () => {
        events.push('DELETE')
        return { code: 0, data: true }
      }
    }
    const record = { evidence: [], fixtures: [] }
    await assert.rejects(
      createFixture(api, record),
      new RegExp(`BLOCKED: ${caseId} 请购开关已开启且当前账号没有`)
    )
    assert.deepEqual(record.fixtures, [])
    assert.deepEqual(events, [
      'GET /system/config/get?category=purchase&tag=requisition',
      'GET /system/auth/get-permission-info'
    ])
  }
})
