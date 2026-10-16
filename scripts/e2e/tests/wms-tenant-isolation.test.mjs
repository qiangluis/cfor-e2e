import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WMS_HOUSE_LOCATION_NOT_EXISTS,
  cleanupSecondTenantWmsFixture,
  createSecondTenantWmsFixture,
  verifyWmsTenantIsolation
} from '../fixtures/wms-tenant-isolation.mjs'

const ok = (data) => ({ code: 0, data })

const codes = Object.freeze({
  warehouseCode: 'ISO-WH-01',
  areaCode: 'ISO-AR-01',
  locationCode: 'ISO-LC-01',
  marker: 'WMS004UNIT'
})

const tenant1Fixture = Object.freeze({
  warehouse: { id: '101', code: codes.warehouseCode },
  area: { id: '102', areaCode: codes.areaCode },
  location: { id: '103', locationCode: codes.locationCode, locationName: 'Tenant one location' }
})

test('second-tenant WMS fixture creates same codes but keeps its own parent IDs', async () => {
  const calls = []
  const api = {
    async postBusiness (path, body) {
      calls.push(['POST', path, body])
      if (path === '/mes/wmsWareHouse/add' || path === '/mes/wmsHouseArea/add') return ok(true)
      if (path === '/mes/wms-house-location/create') return ok('203')
      throw new Error(`unexpected post ${path}`)
    },
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/mes/wmsWareHouse/allTree') return ok([{ id: '201', name: 'E2E WMS ISO warehouse UNIT' }])
      if (path === '/mes/wmsWareHouse/queryById?id=201') return ok({
        id: '201', code: codes.warehouseCode, name: 'E2E WMS ISO warehouse UNIT',
        mark: 'E2E WMS tenant isolation fixture UNIT'
      })
      if (path.startsWith('/mes/wmsHouseArea/list')) return ok({ records: [{
        id: '202', areaCode: codes.areaCode, houseId: '201'
      }] })
      if (path === '/mes/wmsHouseArea/queryById?id=202') return ok({
        id: '202', areaCode: codes.areaCode, houseId: '201', remark: 'E2E WMS tenant isolation fixture UNIT'
      })
      if (path === '/mes/wms-house-location/get?id=203') return ok({
        id: '203', locationCode: codes.locationCode, houseId: '201', areaId: '202',
        remark: 'E2E WMS tenant isolation fixture UNIT'
      })
      throw new Error(`unexpected get ${path}`)
    }
  }
  const record = { checks: [], evidence: [] }
  const fixture = await createSecondTenantWmsFixture(api, record, codes, { suffix: 'UNIT' })
  assert.deepEqual(fixture.warehouse, {
    id: '201', code: codes.warehouseCode, name: 'E2E WMS ISO warehouse UNIT'
  })
  assert.deepEqual(fixture.area, { id: '202', code: codes.areaCode, warehouseId: '201' })
  assert.deepEqual(fixture.location, { id: '203', code: codes.locationCode, warehouseId: '201', areaId: '202' })
  assert.equal(calls.find((call) => call[1] === '/mes/wmsHouseArea/add')[2].houseId, '201')
  assert.equal(calls.find((call) => call[1] === '/mes/wms-house-location/create')[2].areaId, '202')
})

test('WMS isolation requires a real second-tenant session and exact domain errors', async () => {
  const calls = []
  const record = { api: [], checks: [], evidence: [] }
  const rootApi = {
    async postBusiness () { throw new Error('not called by injected tenant creator') },
    async getBusiness () { throw new Error('not called by injected tenant creator') }
  }
  const tenantApi = {
    async get (path) {
      calls.push(['GET', path])
      assert.equal(path, '/mes/wms-house-location/get?id=103')
      return ok(null)
    },
    async delete (path, options) {
      calls.push(['DELETE', path, options])
      assert.equal(path, '/mes/wms-house-location/delete?id=103')
      assert.deepEqual(options.expectedBusinessRejection, WMS_HOUSE_LOCATION_NOT_EXISTS)
      return { code: 1001001000, msg: '库位管理不存在' }
    },
    async put (path, body, options) {
      calls.push(['PUT', path, body, options])
      assert.equal(path, '/mes/wms-house-location/update')
      assert.equal(body.id, '103')
      assert.equal(body.houseId, '101')
      assert.equal(body.areaId, '102')
      assert.deepEqual(options.expectedBusinessRejection, WMS_HOUSE_LOCATION_NOT_EXISTS)
      return { code: 1001001000, message: '库位管理不存在' }
    },
    async postBusiness (path) {
      calls.push(['POST', path])
      assert.equal(path, '/system/auth/logout')
      return ok(true)
    }
  }
  const result = await verifyWmsTenantIsolation({
    context: { page: {}, record }, api: rootApi, caseRecord: record, tenant1Fixture, codes,
    dependencies: {
      createTenant: async () => ({
        packageId: '901', tenantId: '902', tenant: { id: '902', name: 'iso', username: 'admin', password: 'secret' }
      }),
      withTenant: async (context, tenant, run) => {
        assert.equal(context.record, record)
        assert.equal(tenant.id, '902')
        return run({ api: tenantApi, auth: { tenantId: '902' }, page: {} })
      },
      createWmsFixture: async () => ({
        warehouse: { id: '201', code: codes.warehouseCode },
        area: { id: '202', code: codes.areaCode, warehouseId: '201' },
        location: { id: '203', code: codes.locationCode, warehouseId: '201', areaId: '202' }
      }),
      cleanupWmsFixture: async (api, fixture) => {
        assert.equal(api, tenantApi)
        assert.equal(fixture.location.id, '203')
      },
      retireTenant: async (api, fixture) => {
        assert.equal(api, rootApi)
        assert.equal(fixture.tenantId, '902')
      },
      observePage: () => ({ flushResponses: async () => calls.push(['FLUSH']) })
    }
  })
  assert.equal(result.tenantId, '902')
  assert.equal(result.errors.delete.code, 1001001000)
  assert.equal(result.errors.update.code, 1001001000)
  assert.equal(record.checks.length, 4)
  assert.equal(record.checks.every((check) => check.passed), true)
  assert.ok(record.checks.some((check) =>
    check.name === '第二租户同编码仓库库区库位可创建并回读归属隔离' &&
    check.details.includes('tenant=902') && check.details.includes('tenant1=101/102/103')
  ))
  assert.deepEqual(calls.map((call) => call[0]), ['GET', 'DELETE', 'PUT', 'POST', 'FLUSH'])
})

test('WMS fixture creation failure still logs out, flushes page evidence, and retires tenant', async () => {
  const calls = []
  const record = { api: [], checks: [], evidence: [] }
  const rootApi = { postBusiness: async () => ok(true), getBusiness: async () => ok(true) }
  const tenantApi = {
    async postBusiness (path) {
      calls.push(['POST', path])
      assert.equal(path, '/system/auth/logout')
      return ok(true)
    }
  }
  await assert.rejects(() => verifyWmsTenantIsolation({
    context: { page: {}, record }, api: rootApi, caseRecord: record, tenant1Fixture, codes,
    dependencies: {
      createTenant: async () => ({
        packageId: '901', tenantId: '902', tenant: { id: '902', name: 'iso', username: 'admin' }
      }),
      withTenant: async (context, tenant, run) => run({
        api: tenantApi, auth: { tenantId: tenant.id }, page: {}
      }),
      createWmsFixture: async () => { throw new Error('fixture create failed') },
      retireTenant: async () => calls.push(['RETIRE']),
      observePage: () => ({ flushResponses: async () => calls.push(['FLUSH']) })
    }
  }), /fixture create failed/)
  assert.deepEqual(calls.map((call) => call[0]), ['POST', 'FLUSH', 'RETIRE'])
})

test('partial WMS fixture creation cleans only identified owned resources', async () => {
  const calls = []
  const record = { checks: [], evidence: [] }
  const api = {
    async postBusiness (path) {
      calls.push(['POST', path])
      if (path === '/mes/wmsWareHouse/add') return ok(true)
      if (path === '/mes/wmsHouseArea/add') throw new Error('area create failed')
      throw new Error(`unexpected post ${path}`)
    },
    async getBusiness (path) {
      calls.push(['GETBUSINESS', path])
      if (path === '/mes/wmsWareHouse/allTree') {
        return ok([{ id: '201', name: 'E2E WMS ISO warehouse PARTIAL' }])
      }
      if (path === '/mes/wmsWareHouse/queryById?id=201') {
        return ok({ id: '201', code: codes.warehouseCode, name: 'E2E WMS ISO warehouse PARTIAL',
          mark: 'E2E WMS tenant isolation fixture PARTIAL' })
      }
      throw new Error(`unexpected getBusiness ${path}`)
    },
    async deleteBusiness (path) {
      calls.push(['DELETEBUSINESS', path])
      assert.equal(path, '/mes/wmsWareHouse/delete?id=201')
      return ok(true)
    },
    async get (path) {
      calls.push(['GET', path])
      assert.equal(path, '/mes/wmsWareHouse/queryById?id=201')
      return { code: 500, success: false, msg: '未找到对应数据', data: null }
    }
  }
  await assert.rejects(
    () => createSecondTenantWmsFixture(api, record, codes, { suffix: 'PARTIAL' }),
    /area create failed/
  )
  assert.ok(calls.some((call) => call[0] === 'DELETEBUSINESS'))
  assert.ok(record.checks.some((check) => check.name.includes('仓库删除后不可再读取') && check.passed))
})

test('cleanup refuses unowned resource before delete', async () => {
  const calls = []
  const record = { checks: [], evidence: [] }
  const fixture = {
    marker: 'UNIT',
    payloads: {
      warehouse: { code: codes.warehouseCode, name: 'owned warehouse', mark: 'E2E WMS tenant isolation fixture UNIT' },
      area: { areaCode: codes.areaCode },
      location: { locationCode: codes.locationCode }
    },
    warehouse: { id: '201' }, area: null, location: null
  }
  const api = {
    async getBusiness () {
      return ok({ id: '201', code: codes.warehouseCode, name: 'foreign warehouse',
        mark: 'E2E WMS tenant isolation fixture UNIT' })
    },
    async deleteBusiness (path) { calls.push(path); return ok(true) },
    async get () { return ok(null) }
  }
  await assert.rejects(() => cleanupSecondTenantWmsFixture(api, fixture, record), /所有权不匹配/)
  assert.deepEqual(calls, [])
})

test('cleanup does not treat arbitrary failed readback as a deleted owned resource', async () => {
  const record = { checks: [], evidence: [] }
  const fixture = {
    marker: 'UNIT',
    payloads: {
      warehouse: { code: codes.warehouseCode, name: 'owned warehouse', mark: 'E2E WMS tenant isolation fixture UNIT' },
      area: { areaCode: codes.areaCode },
      location: { locationCode: codes.locationCode }
    },
    warehouse: { id: '201' }, area: null, location: null
  }
  const api = {
    async getBusiness () {
      return ok({ id: '201', code: codes.warehouseCode, name: 'owned warehouse',
        mark: 'E2E WMS tenant isolation fixture UNIT' })
    },
    async deleteBusiness () { return ok(true) },
    async get (_path, options) {
      assert.deepEqual(options, { expectedBusinessRejection: {
        code: 500, message: '未找到对应数据', allowServiceCode: true
      } })
      return { code: 500, success: false, msg: '系统异常：数据库连接失败' }
    }
  }
  await assert.rejects(() => cleanupSecondTenantWmsFixture(api, fixture, record), /删除后仍可读取/)
  assert.ok(record.checks.some((check) => check.name.includes('仓库删除后不可再读取') && !check.passed))
})

test('cleanup accepts a successful WMS location readback with explicit null data', async () => {
  const record = { checks: [], evidence: [] }
  const fixture = {
    marker: 'UNIT',
    payloads: {
      warehouse: { code: codes.warehouseCode, name: 'owned warehouse', mark: 'E2E WMS tenant isolation fixture UNIT' },
      area: { areaCode: codes.areaCode },
      location: { locationCode: codes.locationCode }
    },
    warehouse: { id: '201' },
    area: { id: '202' },
    location: { id: '203' }
  }
  const api = {
    async getBusiness (path) {
      if (path.includes('wms-house-location')) {
        return ok({ id: '203', locationCode: codes.locationCode, houseId: '201', areaId: '202',
          remark: 'E2E WMS tenant isolation fixture UNIT' })
      }
      if (path.includes('wmsHouseArea')) {
        return ok({ id: '202', areaCode: codes.areaCode, houseId: '201',
          remark: 'E2E WMS tenant isolation fixture UNIT' })
      }
      if (path.includes('wmsWareHouse')) {
        return ok({ id: '201', code: codes.warehouseCode, name: 'owned warehouse',
          mark: 'E2E WMS tenant isolation fixture UNIT' })
      }
      throw new Error(`unexpected pre-delete readback ${path}`)
    },
    async deleteBusiness (path) {
      assert.match(path, /^\/mes\/(wms-house-location|wmsHouseArea|wmsWareHouse)\/delete\?id=20[123]$/)
      return ok(true)
    },
    async get (path, options) {
      if (path === '/mes/wms-house-location/get?id=203') {
        assert.equal(options, undefined)
        return { code: 0, data: null }
      }
      assert.deepEqual(options, { expectedBusinessRejection: {
        code: 500, message: '未找到对应数据', allowServiceCode: true
      } })
      return { code: 500, success: false, msg: '未找到对应数据' }
    }
  }
  await cleanupSecondTenantWmsFixture(api, fixture, record)
  assert.ok(record.checks.some((check) => check.name.includes('库位删除后不可再读取') && check.passed))
})

for (const stage of ['get', 'delete', 'update']) {
  test(`WMS isolation ${stage} failure still retires tenant after logout and evidence flush`, async () => {
    const calls = []
    const record = { checks: [], evidence: [] }
    const fixture = {
      warehouse: { id: '201', code: codes.warehouseCode },
      area: { id: '202', code: codes.areaCode, warehouseId: '201' },
      location: { id: '203', code: codes.locationCode, warehouseId: '201', areaId: '202' }
    }
    const tenantApi = {
      async get () {
        if (stage === 'get') throw new Error('get transport failed')
        return ok(null)
      },
      async delete () {
        if (stage === 'delete') throw new Error('delete transport failed')
        return { code: 1001001000, msg: '库位管理不存在' }
      },
      async put () {
        if (stage === 'update') throw new Error('update transport failed')
        return { code: 1001001000, msg: '库位管理不存在' }
      },
      async postBusiness (path) {
        assert.equal(path, '/system/auth/logout')
        calls.push('logout')
        return ok(true)
      }
    }
    await assert.rejects(() => verifyWmsTenantIsolation({
      context: { page: {}, record },
      api: { postBusiness: async () => ok(true), getBusiness: async () => ok(true) },
      caseRecord: record,
      tenant1Fixture,
      codes,
      dependencies: {
        createTenant: async () => ({ packageId: '901', tenantId: '902', tenant: { id: '902', name: 'iso', username: 'admin' } }),
        withTenant: async (_context, _tenant, run) => run({ api: tenantApi, auth: { tenantId: '902' }, page: {} }),
        createWmsFixture: async () => fixture,
        cleanupWmsFixture: async () => calls.push('fixture-cleanup'),
        observePage: () => ({ flushResponses: async () => calls.push('flush') }),
        retireTenant: async () => calls.push('retire')
      }
    }), new RegExp(`${stage} transport failed`))
    assert.deepEqual(calls, ['fixture-cleanup', 'logout', 'flush', 'retire'])
  })
}

test('WMS isolation combines operation and tenant retirement failures', async () => {
  const record = { checks: [], evidence: [] }
  const calls = []
  await assert.rejects(() => verifyWmsTenantIsolation({
    context: { page: {}, record },
    api: { postBusiness: async () => ok(true), getBusiness: async () => ok(true) },
    caseRecord: record,
    tenant1Fixture,
    codes,
    dependencies: {
      createTenant: async () => ({ packageId: '901', tenantId: '902', tenant: { id: '902', name: 'iso', username: 'admin' } }),
      withTenant: async (_context, _tenant, run) => run({
        api: { postBusiness: async () => { calls.push('logout'); return ok(true) } },
        auth: { tenantId: '902' }, page: {}
      }),
      createWmsFixture: async () => { throw new Error('fixture create failed') },
      observePage: () => ({ flushResponses: async () => calls.push('flush') }),
      retireTenant: async () => { throw new Error('tenant retirement transport failed') }
    }
  }), /fixture create failed; 第二租户退役失败：tenant retirement transport failed/)
  assert.deepEqual(calls, ['logout', 'flush'])
})

test('WMS isolation surfaces second-tenant provisioning limits as BLOCKED', async () => {
  const record = { checks: [], evidence: [] }
  await assert.rejects(() => verifyWmsTenantIsolation({
    context: { page: {}, record },
    api: { postBusiness: async () => ok(true), getBusiness: async () => ok(true) },
    caseRecord: record,
    tenant1Fixture,
    codes,
    dependencies: {
      createTenant: async () => { throw new Error('套餐资源不足') }
    }
  }), /BLOCKED: 无法创建第二安全测试租户：套餐资源不足/)
})
