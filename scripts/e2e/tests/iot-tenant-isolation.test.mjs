import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IOT_ISOLATION_PERMISSIONS,
  assertCrossWriteRejected,
  buildIotIsolationPackage,
  createIotIsolationTenant,
  retireIotIsolationTenant,
  runIotTenantIsolation,
  withIotIsolationTenant
} from '../fixtures/iot-tenant-isolation.mjs'

const envelope = (data) => ({ code: 0, data })

const menuFixture = () => {
  const root = { id: '1', parentId: '0', status: 0, deleted: 0, permission: '' }
  const components = [
    'system/tenant-workbench/index', 'system/user/index', 'system/role/index',
    'system/dept/index', 'system/enterprise-organization/index', 'system/systemInit/index'
  ]
  const base = components.map((component, index) => ({
    id: String(index + 2), parentId: '1', status: 0, deleted: 0, component, permission: ''
  }))
  const permissions = IOT_ISOLATION_PERMISSIONS.map((permission, index) => ({
    id: String(index + 20), parentId: '1', status: 0, deleted: 0, component: '', permission
  }))
  return [root, ...base, ...permissions]
}

test('IOT-002 package plan stays inside package 111 and preserves complete enabled parent chains', () => {
  const menus = menuFixture()
  const plan = buildIotIsolationPackage({
    standardPackage: { menuIds: menus.map((menu) => menu.id) },
    menus,
    assignableMenus: menus
  })
  assert.ok(plan.menuIds.includes('1'))
  for (const permission of IOT_ISOLATION_PERMISSIONS) {
    const menu = menus.find((item) => item.permission === permission)
    assert.ok(plan.menuIds.includes(menu.id), permission)
  }
  assert.deepEqual(plan.permissions, [...IOT_ISOLATION_PERMISSIONS])
  assert.throws(() => buildIotIsolationPackage({
    standardPackage: { menuIds: menus.map((menu) => menu.id).filter((id) => id !== '20') },
    menus,
    assignableMenus: menus
  }), /越过标准套餐 111/)
})

test('IOT-002 tenant creation failure disables the newly created package', async () => {
  const writes = []
  const menus = menuFixture()
  const api = {
    async getBusiness (path) {
      if (path === '/system/tenant-package/get?id=111') return envelope({ menuIds: menus.map((menu) => menu.id) })
      if (path === '/system/menu/list' || path === '/system/menu/list-all-simple') return envelope(menus)
      assert.fail(`unexpected GET ${path}`)
    },
    async postBusiness (path) {
      if (path === '/system/tenant-package/create') return envelope('901')
      if (path === '/system/tenant/create') throw new Error('tenant create failed')
      assert.fail(`unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      writes.push({ path, body })
      return envelope(true)
    }
  }
  await assert.rejects(createIotIsolationTenant(api, { marker: 'UNITFAIL' }), /tenant create failed/)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/system/tenant-package/update')
  assert.equal(writes[0].body.id, '901')
  assert.equal(writes[0].body.status, 1)
})

test('IOT-002 tenant fixture returns the scoped role payload for cleanup', async () => {
  const menus = menuFixture()
  const writes = []
  const api = {
    async getBusiness (path) {
      if (path === '/system/tenant-package/get?id=111') {
        return envelope({ menuIds: menus.map((menu) => menu.id) })
      }
      if (path === '/system/menu/list' || path === '/system/menu/list-all-simple') {
        return envelope(menus)
      }
      if (path.startsWith('/system/user/page?')) {
        return envelope({ list: [{ id: '902', username: 'e2eiotunit' }] })
      }
      if (path === '/system/role/page?pageNo=1&pageSize=100&code=tenant_admin') {
        return envelope({ list: [{ id: '903', code: 'tenant_admin' }] })
      }
      if (path === '/system/dept/get?id=904') {
        return envelope({ id: '904', name: 'E2E IOT DEPT UNIT', parentId: 0, status: 0 })
      }
      assert.fail(`unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      if (path === '/system/tenant-package/create') return envelope('901')
      if (path === '/system/tenant/create') return envelope('902')
      if (path === '/system/dept/create') {
        assert.equal(body.name, 'E2E IOT DEPT UNIT')
        return envelope('904')
      }
      if (path === '/system/role/create') {
        assert.match(body.code, /^e2eiotscope/)
        return envelope('905')
      }
      if (path === '/system/permission/assign-role-data-scope') {
        assert.deepEqual(body, { roleId: '905', dataScope: 2, dataScopeDeptIds: ['904'] })
        return envelope(true)
      }
      if (path === '/system/permission/assign-user-role') {
        assert.deepEqual(body, { userId: '902', roleIds: ['903', '905'] })
        return envelope(true)
      }
      assert.fail(`unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      writes.push({ path, body })
      return envelope(true)
    }
  }

  const fixture = await createIotIsolationTenant(api, {
    marker: 'UNIT',
    password: 'Unit!123'
  })
  assert.equal(fixture.scope.role.id, '905')
  assert.equal(fixture.scope.role.payload.code.startsWith('e2eiotscope'), true)
  assert.equal(fixture.department.id, '904')
  assert.equal(writes.length, 0)
})

test('IOT-002 finally retires both tenant and package and verifies status', async () => {
  const writes = []
  const api = {
    async putBusiness (path, body) {
      writes.push({ path, body })
      return envelope(true)
    },
    async getBusiness (path) {
      if (path === '/system/tenant/get?id=902') return envelope({ id: '902', status: 1 })
      if (path === '/system/tenant-package/get?id=901') return envelope({ id: '901', status: 1 })
      assert.fail(`unexpected GET ${path}`)
    }
  }
  const record = { checks: [], evidence: [] }
  await retireIotIsolationTenant(api, {
    tenantId: '902', packageId: '901',
    tenantPayload: { id: '902', name: 'unit tenant', status: 0 },
    packagePayload: { id: '901', name: 'unit package', status: 0, menuIds: ['1'] }
  }, record)
  assert.deepEqual(writes.map((item) => [item.path, item.body.id, item.body.status]), [
    ['/system/tenant/update', '902', 1],
    ['/system/tenant-package/update', '901', 1]
  ])
  assert.match(record.evidence[0], /902.*901/)
})

test('IOT-002 isolated browser session rejects wrong tenant identity and always logs out/closes', async () => {
  const events = []
  const page = { close: async () => events.push('page.close') }
  const isolated = {
    newPage: async () => page,
    close: async () => events.push('context.close')
  }
  const browser = { newContext: async () => isolated }
  const context = { page: { context: () => ({ browser: () => browser }) }, record: { api: [] } }
  const tenantApi = { postBusiness: async (path) => { events.push(path); return envelope(true) } }
  await assert.rejects(withIotIsolationTenant(context, {
    id: '902', name: 'unit tenant', username: 'unit', password: 'Unit!123'
  }, async () => {}, {
    login: async () => ({ token: 'unit-token', tenantId: '1' }),
    createApiClient: () => tenantApi,
    observePage: () => ({ flushResponses: async () => events.push('flush') })
  }), /登录身份不一致/)
  assert.deepEqual(events, ['flush', 'page.close', 'context.close'])
})

test('IOT-002 real fixture orchestration proves self visibility and cross-tenant read/write no effect', async () => {
  const record = { api: [] }
  const caseRecord = { checks: [], evidence: [] }
  const tenantFixture = {
    tenantId: '902',
    tenant: { id: '902', name: 'unit tenant', username: 'unit', password: 'Unit!123' },
    department: { id: '20', payload: { name: 'unit dept', parentId: '0', sort: 0, status: 0 } }
  }
  const state = {
    category: { id: '10', name: 'E2E-IOT-002-CATEGORY-UNIT', status: 0 },
    product: { id: '100', name: 'E2E-IOT-002-PRODUCT-UNIT', productKey: 'PK-UNIT', status: 0 },
    model: { id: '101', productId: '100', identifier: 'e2e_iot002_unit' },
    device: { id: '102', productId: '100', deviceName: 'E2E-IOT-002-DEVICE-UNIT', deptId: '20' },
    template: { id: '103', code: 'e2e_notify_unit' },
    scene: { id: '104' },
    config: { id: '105', sceneRuleIds: ['104'] },
    alert: { id: '106', deviceId: '102', configId: '105', processRemark: null },
    messageSequence: null,
    deleted: []
  }
  const tenantApi = {
    async getBusiness (path) {
      if (path === '/iot/product-category/simple-list') return envelope([{ id: '10' }])
      if (path === '/iot/product-category/get?id=10') return envelope(state.category)
      if (path === '/system/user/profile/get') return envelope({ id: '200' })
      if (path.includes('/iot/product/get')) return envelope(state.product)
      if (path.includes('/iot/thing-model/get')) return envelope(state.model)
      if (path.includes('/iot/device/get')) return envelope(state.device)
      if (path.includes('/system/notify-template/get')) return envelope(state.template)
      if (path.includes('/iot/scene-rule/get')) return envelope(state.scene)
      if (path.includes('/iot/alert-config/get')) return envelope(state.config)
      if (path.includes('/iot/device/message/page')) return envelope({
        list: state.messageSequence == null ? [] : [{ id: '107', sequenceNo: state.messageSequence }], total: state.messageSequence == null ? 0 : 1
      })
      if (path.includes('/iot/device/property/get-latest')) return envelope([{ identifier: state.model.identifier, value: 80 }])
      if (path.includes('/iot/device/property/history-list')) return envelope([{ identifier: state.model.identifier, value: 80 }])
      if (path.includes('/iot/alert-record/page')) return envelope({ list: [{ ...state.alert }], total: 1 })
      if (path.includes('/iot/alert-record/get')) return envelope({ ...state.alert })
      if (path === '/system/auth/logout') return envelope(true)
      assert.fail(`unexpected tenant GET ${path}`)
    },
    async postBusiness (path, body) {
      if (path === '/iot/product-category/create') {
        state.category = { ...state.category, ...body, id: '10' }
        return envelope('10')
      }
      if (path === '/iot/product/create') { state.product = { ...state.product, ...body, id: '100' }; return envelope('100') }
      if (path === '/iot/thing-model/create') { state.model = { ...state.model, ...body, id: '101' }; return envelope('101') }
      if (path === '/iot/device/create') { state.device = { ...state.device, ...body, id: '102' }; return envelope('102') }
      if (path === '/system/notify-template/create') { state.template = { ...state.template, ...body, id: '103' }; return envelope('103') }
      if (path === '/iot/scene-rule/create') { state.scene = { ...state.scene, ...body, id: '104' }; return envelope('104') }
      if (path === '/iot/alert-config/create') { state.config = { ...state.config, ...body, id: '105' }; return envelope('105') }
      if (path === '/iot/device/message/send') { state.messageSequence = body.sequenceNo; return envelope(true) }
      if (path === '/iot/alert-record/process') { state.alert.processRemark = body.processRemark; return envelope(true) }
      assert.fail(`unexpected tenant POST ${path}`)
    },
    async putBusiness (path, body) {
      if (path.includes('/iot/product/update-status')) state.product.status = path.endsWith('status=1') ? 1 : 0
      if (path === '/iot/alert-record/process') state.alert.processRemark = body.processRemark
      return envelope(true)
    },
    async deleteBusiness (path) {
      state.deleted.push(path)
      return envelope(true)
    }
  }
  const mainApi = {
    async get (path) {
      if (path.includes('/iot/device/message/page')) {
        return { code: 1050003000, msg: '设备不存在', data: null }
      }
      if (path.includes('/iot/alert-record/page')) {
        return envelope({ list: [], total: 0 })
      }
      if (path.includes('/iot/device/property/get-latest') || path.includes('/iot/device/property/history-list')) return envelope([])
      return envelope(null)
    },
    async request (method, path) {
      if (method === 'POST' && path === '/iot/device/message/send') return { code: 1050003000, msg: '设备不存在', data: null }
      if (method === 'PUT' && path === '/iot/alert-record/process') {
        return { code: 1050014000, msg: 'IoT 告警记录不存在', data: null }
      }
      assert.fail(`unexpected main request ${method} ${path}`)
    }
  }
  const retired = []
  const result = await runIotTenantIsolation({
    context: { page: {}, record }, api: mainApi, caseRecord
  }, {
    createTenant: async () => tenantFixture,
    withTenant: async (_context, _tenant, run) => run({ api: tenantApi, auth: { tenantId: '902' } }),
    retireTenant: async (_api, fixture) => retired.push(fixture.tenantId)
  })
  assert.equal(result.tenantId, '902')
  assert.deepEqual(retired, ['902'])
  assert.equal(caseRecord.checks.length, 4)
  assert.ok(caseRecord.checks.every((check) => check.passed))
  assert.deepEqual(state.deleted, [
    '/iot/alert-config/delete?id=105', '/iot/scene-rule/delete?id=104',
    '/system/notify-template/delete?id=103', '/iot/device/delete?id=102',
    '/iot/thing-model/delete?id=101', '/iot/product/delete?id=100',
    '/iot/product-category/delete?id=10'
  ])
})

test('IOT-002 cross-tenant write cannot treat a successful response as a rejection', async () => {
  await assert.rejects(
    assertCrossWriteRejected({
      async request () {
        return { code: 0, data: true }
      }
    }, 'PUT', '/iot/alert-record/process', { id: '106', processRemark: 'must reject' }),
    /返回成功，不能当作拒绝/
  )
})
