import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import {
  PROCUREMENT_ORGANIZATION_GATE,
  PROCUREMENT_REQUEST_NOT_EXISTS,
  PROCUREMENT_QUERY_PERMISSION,
  buildProcurementIsolationPackage,
  createProcurementIsolationTenant,
  dataOf,
  numericId,
  procurementPageRows,
  procurementOrganizationGateStatus,
  retireProcurementIsolationTenant,
  withProcurementTenant,
  verifyProcurementTenantIsolation
} from '../fixtures/procurement-tenant-isolation.mjs'

const menu = (id, component, parentId = 0, permission = '') => ({
  id, component, parentId, permission, status: 0, deleted: 0
})

test('采购隔离套餐只复用标准套餐授权内的查询父链，不扩大共享套餐', () => {
  const menus = [
    menu(1, 'system/tenant-workbench/index'),
    menu(2, 'system/user/index'),
    menu(3, 'system/role/index'),
    menu(4, 'system/dept/index'),
    menu(5, 'system/enterprise-organization/index'),
    menu(6, 'system/systemInit/index'),
    menu(10, 'erp/purchase/index'),
    menu(11, 'erp/purchase/request', 10, PROCUREMENT_QUERY_PERMISSION),
    menu(99, 'erp/other/index')
  ]
  const plan = buildProcurementIsolationPackage({
    standardPackage: { menuIds: menus.filter((item) => item.id !== 99).map((item) => item.id) },
    menus,
    assignableMenus: menus
  })
  assert.equal(plan.queryPermission, PROCUREMENT_QUERY_PERMISSION)
  assert.ok(plan.menuIds.includes('11'))
  assert.ok(plan.menuIds.includes('10'))
  assert.ok(!plan.menuIds.includes('99'))
})

test('菜单父链先 has 再 add，并保留雪花菜单 ID 原字符串精度', () => {
  const hugeParentId = '9007199254740993'
  const hugeQueryId = '9007199254740995'
  const menus = [
    menu(1, 'system/tenant-workbench/index'),
    menu(2, 'system/user/index'),
    menu(3, 'system/role/index'),
    menu(4, 'system/dept/index'),
    menu(5, 'system/enterprise-organization/index'),
    menu(6, 'system/systemInit/index'),
    menu(hugeParentId, 'erp/purchase/index'),
    menu(hugeQueryId, 'erp/purchase/request', hugeParentId, PROCUREMENT_QUERY_PERMISSION)
  ]
  const plan = buildProcurementIsolationPackage({
    standardPackage: { menuIds: menus.map((item) => item.id) }, menus
  })
  assert.ok(plan.menuIds.includes(hugeParentId))
  assert.ok(plan.menuIds.includes(hugeQueryId))
  assert.equal(plan.menuIds.find((id) => id === hugeQueryId), hugeQueryId)

  const cycleMenus = menus.map((item) => ({ ...item }))
  cycleMenus.find((item) => String(item.id) === hugeParentId).parentId = hugeQueryId
  assert.throws(
    () => buildProcurementIsolationPackage({
      standardPackage: { menuIds: cycleMenus.map((item) => item.id) }, menus: cycleMenus
    }),
    /菜单父链存在循环/
  )
})

test('numericId 和菜单父链拒绝不安全 Number，避免已丢精度后继续运行', () => {
  assert.throws(
    () => numericId(Number.MAX_SAFE_INTEGER + 2, '测试 ID'),
    /安全整数或原字符串 ID/
  )
  const menus = [
    menu(1, 'system/tenant-workbench/index'),
    menu(2, 'system/user/index'),
    menu(3, 'system/role/index'),
    menu(4, 'system/dept/index'),
    menu(5, 'system/enterprise-organization/index'),
    menu(6, 'system/systemInit/index'),
    menu(Number.MAX_SAFE_INTEGER + 2, 'erp/purchase/index'),
    menu('9007199254740995', 'erp/purchase/request', Number.MAX_SAFE_INTEGER + 2,
      PROCUREMENT_QUERY_PERMISSION)
  ]
  assert.throws(
    () => buildProcurementIsolationPackage({
      standardPackage: { menuIds: menus.map((item) => item.id) }, menus
    }),
    /菜单(?:编号|父编号)必须是安全整数或原字符串 ID/
  )
})

test('dataOf 保留显式 null，分页必须明确返回 records 或 list 数组', () => {
  assert.equal(dataOf({ data: null }), null)
  assert.equal(dataOf({ data: false }), false)
  assert.deepEqual(dataOf({ data: { id: '1' } }), { id: '1' })
  assert.deepEqual(procurementPageRows({ code: 0, data: { records: [] } }), [])
  assert.deepEqual(procurementPageRows({ code: 0, data: { list: [{ id: '1' }] } }), [{ id: '1' }])
  assert.throws(
    () => procurementPageRows({ code: 0, data: { total: 0 } }),
    /明确 records\/list 数组/
  )
  assert.throws(
    () => procurementPageRows({ code: 0, data: null }),
    /明确 records\/list 数组/
  )
})

test('采购详情不存在使用后端精确领域码，不把 500 当作可接受运行时错误', () => {
  const missing = { code: -636, data: null, msg: 'ERP 采购订单申请不存在' }
  assert.equal(matchesExpectedBusinessRejection(missing, PROCUREMENT_REQUEST_NOT_EXISTS), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 500, data: null, msg: 'ERP 采购订单申请不存在' }, PROCUREMENT_REQUEST_NOT_EXISTS
  ), false)
  assert.equal(PROCUREMENT_REQUEST_NOT_EXISTS.allowServiceCode, true)
})

test('采购租户隔离 fixture 明确要求正式租户/套餐 API 和 token logout', () => {
  const source = fs.readFileSync(
    new URL('../fixtures/procurement-tenant-isolation.mjs', import.meta.url), 'utf8'
  )
  assert.match(source, /\/system\/tenant-package\/create/)
  assert.match(source, /\/system\/tenant\/create/)
  assert.match(source, /\/system\/auth\/logout/)
  assert.match(source, /purchase\/order\/request\/page/)
  assert.match(source, /retireProcurementIsolationTenant/)
  assert.match(source, /flushResponses/)
  assert.match(source, /await page\?\.close\(\)/)
})

test('隔离验证通过依赖注入检查精确详情拒绝和严格分页数组', async () => {
  const calls = []
  const retired = []
  const tenantApi = {
    async get (path, options) {
      calls.push({ path, options })
      if (path.includes('/get?')) {
        return { code: -636, data: null, msg: 'ERP 采购订单申请不存在' }
      }
      return { code: 0, data: { records: [] }, msg: '' }
    }
  }
  const result = await verifyProcurementTenantIsolation({
    context: { page: {}, record: {} },
    api: {},
    tenant1Fixture: { id: '9223372036854775807', billNo: 'PROC-ISO-001' },
    dependencies: {
      createTenant: async () => ({ tenantId: '9007199254740993', tenant: { id: '9007199254740993' } }),
      retireTenant: async (_api, fixture) => retired.push(fixture.tenantId),
      withTenant: async (_context, _tenant, run) => run({
        api: tenantApi,
        auth: { tenantId: '9007199254740993' }
      })
    }
  })
  assert.equal(result.hidden, true)
  assert.equal(result.pageHidden, true)
  assert.deepEqual(retired, ['9007199254740993'])
  assert.deepEqual(calls[0].options, { expectedBusinessRejection: PROCUREMENT_REQUEST_NOT_EXISTS })
  assert.match(calls[1].path, /pageNo=1&pageSize=100/)
})

test('隔离验证缺少 records/list 数组时阻断且仍执行租户退役', async () => {
  let retired = false
  await assert.rejects(
    verifyProcurementTenantIsolation({
      context: { page: {}, record: {} },
      api: {},
      tenant1Fixture: { id: '1', billNo: 'PROC-ISO-002' },
      dependencies: {
        createTenant: async () => ({ tenantId: '2', tenant: { id: '2' } }),
        retireTenant: async () => { retired = true },
        withTenant: async (_context, _tenant, run) => run({
          api: {
            async get (path) {
              if (path.includes('/get?')) return { code: -636, data: null, msg: 'ERP 采购订单申请不存在' }
              return { code: 0, data: { total: 0 }, msg: '' }
            }
          },
          auth: { tenantId: '2' }
        })
      }
    }),
    /明确 records\/list 数组/
  )
  assert.equal(retired, true)
})

test('隔离验证仅退役失败时也拒绝，不能被成功 return 吞掉', async () => {
  await assert.rejects(
    verifyProcurementTenantIsolation({
      context: { page: {}, record: {} },
      api: {},
      tenant1Fixture: { id: '1' },
      dependencies: {
        createTenant: async () => ({ tenantId: '2', tenant: { id: '2' } }),
        withTenant: async (_context, _tenant, run) => run({
          api: {
            async get () {
              return { code: -636, data: null, msg: 'ERP 采购订单申请不存在' }
            }
          },
          auth: { tenantId: '2' }
        }),
        retireTenant: async () => { throw new Error('仅退役失败') }
      }
    }),
    /仅退役失败/
  )
})

test('详情错误 envelope 携带源单据数据时不能判定为隔离成功', async () => {
  await assert.rejects(
    verifyProcurementTenantIsolation({
      context: { page: {}, record: {} },
      api: {},
      tenant1Fixture: { id: '1' },
      dependencies: {
        createTenant: async () => ({ tenantId: '2', tenant: { id: '2' } }),
        withTenant: async (_context, _tenant, run) => run({
          api: {
            async get () {
              return { code: -636, data: { id: '1', billNo: 'LEAKED' }, msg: 'ERP 采购订单申请不存在' }
            }
          },
          auth: { tenantId: '2' }
        }),
        retireTenant: async () => {}
      }
    }),
    /第二租户可以读取 tenant1 请购单详情/
  )
})

test('隔离验证每轮传入随机 marker，连续两轮专属租户名称不重复', async () => {
  const markers = []
  const createTenant = async (_api, options) => {
    markers.push(options.marker)
    return {
      tenantId: String(markers.length + 1),
      tenant: { id: String(markers.length + 1) }
    }
  }
  const withTenant = async (_context, tenant, run) => run({
    api: {
      async get () {
        return { code: -636, data: null, msg: 'ERP 采购订单申请不存在' }
      }
    },
    auth: { tenantId: tenant.id }
  })
  const dependencies = { createTenant, withTenant, retireTenant: async () => {} }
  await verifyProcurementTenantIsolation({
    context: { page: {}, record: {} }, api: {}, tenant1Fixture: { id: '1' }, dependencies
  })
  await verifyProcurementTenantIsolation({
    context: { page: {}, record: {} }, api: {}, tenant1Fixture: { id: '1' }, dependencies
  })
  assert.equal(markers.length, 2)
  assert.match(markers[0], /^PROC014-/)
  assert.match(markers[1], /^PROC014-/)
  assert.notEqual(markers[0], markers[1])
})

test('正式租户构造两轮生成不同的专属租户名称和用户名', async () => {
  const menus = [
    menu(1, 'system/tenant-workbench/index'),
    menu(2, 'system/user/index'),
    menu(3, 'system/role/index'),
    menu(4, 'system/dept/index'),
    menu(5, 'system/enterprise-organization/index'),
    menu(6, 'system/systemInit/index'),
    menu(10, 'erp/purchase/index'),
    menu(11, 'erp/purchase/request', 10, PROCUREMENT_QUERY_PERMISSION)
  ]
  const tenantPayloads = []
  let packageSequence = 0
  let tenantSequence = 0
  const api = {
    async getBusiness (path) {
      if (path.includes('tenant-package/get')) return { data: { menuIds: menus.map((item) => item.id) } }
      return { data: menus }
    },
    async postBusiness (path, payload) {
      if (path.endsWith('/tenant-package/create')) return { data: String(++packageSequence) }
      tenantPayloads.push(payload)
      return { data: String(++tenantSequence) }
    }
  }
  const first = await createProcurementIsolationTenant(api, { marker: 'PROC014-A' })
  const second = await createProcurementIsolationTenant(api, { marker: 'PROC014-B' })
  assert.notEqual(first.tenant.name, second.tenant.name)
  assert.notEqual(first.tenant.username, second.tenant.username)
  assert.notEqual(tenantPayloads[0].name, tenantPayloads[1].name)
  assert.notEqual(tenantPayloads[0].username, tenantPayloads[1].username)
  for (const payload of tenantPayloads) {
    assert.ok(payload.password.length >= 4 && payload.password.length <= 16)
    assert.match(payload.username, /^[a-zA-Z0-9]{4,30}$/)
  }
  await assert.rejects(
    createProcurementIsolationTenant(api, { marker: 'PROC014-C', password: 'x'.repeat(17) }),
    /4-16 位约束/
  )
  assert.equal(packageSequence, 2)
  assert.equal(tenantPayloads.length, 2)
})

test('套餐创建失败时停用失败与主错误同时保留', async () => {
  const menus = [
    menu(1, 'system/tenant-workbench/index'),
    menu(2, 'system/user/index'),
    menu(3, 'system/role/index'),
    menu(4, 'system/dept/index'),
    menu(5, 'system/enterprise-organization/index'),
    menu(6, 'system/systemInit/index'),
    menu(10, 'erp/purchase/index'),
    menu(11, 'erp/purchase/request', 10, PROCUREMENT_QUERY_PERMISSION)
  ]
  const calls = []
  const api = {
    async getBusiness (path) {
      if (path.includes('tenant-package/get')) return { data: { menuIds: menus.map((item) => item.id) } }
      return { data: menus }
    },
    async postBusiness (path) {
      calls.push(path)
      if (path.endsWith('/tenant-package/create')) return { data: '9007199254740993' }
      throw new Error('租户创建主错误')
    },
    async putBusiness (path) {
      calls.push(path)
      throw new Error('套餐停用清理错误')
    }
  }
  await assert.rejects(
    createProcurementIsolationTenant(api, { marker: 'PROC-TEST' }),
    (error) => error instanceof AggregateError &&
      error.errors.some((item) => item.message === '租户创建主错误') &&
      error.errors.some((item) => item.message === '套餐停用清理错误')
  )
  assert.deepEqual(calls, ['/system/tenant-package/create', '/system/tenant/create', '/system/tenant-package/update'])
})

test('租户和套餐两个退役请求都执行，两个清理错误都保留', async () => {
  const calls = []
  await assert.rejects(
    retireProcurementIsolationTenant({
      async putBusiness (path) {
        calls.push(path)
        throw new Error(path.includes('/tenant-package/') ? '套餐退役错误' : '租户退役错误')
      }
    }, {
      tenantId: '2', packageId: '3', tenantPayload: {}, packagePayload: {}
    }),
    (error) => error instanceof AggregateError &&
      error.errors.some((item) => item.message === '租户退役错误') &&
      error.errors.some((item) => item.message === '套餐退役错误')
  )
  assert.deepEqual(calls, ['/system/tenant/update', '/system/tenant-package/update'])
})

test('主验证错误与退役清理错误均保留', async () => {
  await assert.rejects(
    verifyProcurementTenantIsolation({
      context: { page: {}, record: {} },
      api: {},
      tenant1Fixture: { id: '1' },
      dependencies: {
        createTenant: async () => ({ tenantId: '2', tenant: { id: '2' } }),
        withTenant: async () => { throw new Error('主验证错误') },
        retireTenant: async () => { throw new Error('退役清理错误') }
      }
    }),
    (error) => error instanceof AggregateError &&
      error.errors.some((item) => item.message === '主验证错误') &&
      error.errors.some((item) => item.message === '退役清理错误')
  )
})

test('隔离浏览器按 flush、关闭页面/上下文、logout 顺序清理且不吞任何错误', async () => {
  const events = []
  const isolatedPage = {
    async close () {
      events.push('page.close')
      throw new Error('页面关闭错误')
    }
  }
  const isolatedContext = {
    async newPage () {
      return isolatedPage
    },
    async close () {
      events.push('context.close')
      throw new Error('上下文关闭错误')
    }
  }
  const tenantApi = {
    async postBusiness (path) {
      events.push(path === '/system/auth/logout' ? 'logout' : path)
      throw new Error('logout 错误')
    }
  }
  await assert.rejects(
    withProcurementTenant(
      { page: {}, record: {} },
      { id: '2', name: 'tenant-2', username: 'user-2', password: 'secret' },
      async () => {
        events.push('run')
        throw new Error('主验证错误')
      },
      {
        browser: { async newContext () { return isolatedContext } },
        observePage: () => ({
          async flushResponses () {
            events.push('flush')
            throw new Error('响应 flush 错误')
          }
        }),
        login: async () => ({ token: 'token-not-logged', tenantId: '2' }),
        createApiClient: () => tenantApi
      }
    ),
    (error) => error instanceof AggregateError && error.errors.length === 5 &&
      error.errors.map((item) => item.message).includes('主验证错误') &&
      error.errors.map((item) => item.message).includes('响应 flush 错误') &&
      error.errors.map((item) => item.message).includes('页面关闭错误') &&
      error.errors.map((item) => item.message).includes('上下文关闭错误') &&
      error.errors.map((item) => item.message).includes('logout 错误')
  )
  assert.deepEqual(events, ['run', 'flush', 'page.close', 'context.close', 'logout'])
})

test('组织门禁当前只能登记 GAP，不得伪称已覆盖', () => {
  const status = procurementOrganizationGateStatus()
  assert.equal(status.supported, false)
  assert.equal(status.reason, PROCUREMENT_ORGANIZATION_GATE.reason)
  assert.equal(status.evidence.length, 3)
})
