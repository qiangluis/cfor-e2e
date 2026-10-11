import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPmsIsolationPackage,
  createPmsIsolationTenant,
  retirePmsIsolationTenant
} from '../fixtures/pms-tenant-isolation.mjs'

const ok = (data) => ({ code: 0, data })

const rows = [
  { id: 1, parentId: 0, status: 0, component: '', permission: '' },
  { id: 2, parentId: 1, status: 0, component: 'system/tenant-workbench/index', permission: '' },
  { id: 3, parentId: 1, status: 0, component: 'system/user/index', permission: '' },
  { id: 4, parentId: 1, status: 0, component: 'system/role/index', permission: '' },
  { id: 5, parentId: 1, status: 0, component: 'system/dept/index', permission: '' },
  { id: 6, parentId: 1, status: 0, component: 'system/enterprise-organization/index', permission: '' },
  { id: 7, parentId: 1, status: 0, component: 'system/systemInit/index', permission: '' },
  { id: 8, parentId: 1, status: 0, component: 'pms/pm/project/index', permission: 'pms:pm:project:query' },
  { id: 9, parentId: 1, status: 1, component: '', permission: '' },
  { id: 10, parentId: 9, status: 0, component: 'disabled/child', permission: '' }
]

test('PMS isolation package keeps only enabled 111 menu parent chains', () => {
  const plan = buildPmsIsolationPackage({
    standardPackage: { menuIds: rows.map((row) => row.id) }, menus: rows,
    assignableMenus: rows.filter((row) => row.id !== 9 && row.id !== 10)
  })
  assert.deepEqual(new Set(plan.baseMenuIds), new Set(['2', '3', '4', '5', '6', '7']))
  assert.ok(plan.menuIds.includes(8))
  assert.ok(!plan.menuIds.includes(9))
  assert.ok(plan.excluded.some((row) => row.sourceId === '10' && /不可分配|停用/.test(row.reason)))
})

test('PMS isolation package blocks forced menus outside the 111 authorization boundary', () => {
  assert.throws(() => buildPmsIsolationPackage({
    standardPackage: { menuIds: rows.filter((row) => row.id !== 2).map((row) => row.id) }, menus: rows,
    assignableMenus: rows
  }), /强制菜单越过111授权/)
})

test('PMS isolation tenant uses dedicated package and retires tenant before package', async () => {
  const calls = []
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/system/tenant/get?id=9007199254740995') return ok({ id: '9007199254740995', status: 1 })
      if (path === '/system/tenant-package/get?id=9007199254740993') return ok({ id: '9007199254740993', status: 1 })
      if (path.includes('tenant-package/get')) return ok({ menuIds: rows.map((row) => row.id) })
      if (path === '/system/menu/list') return ok(rows)
      if (path === '/system/menu/list-all-simple') {
        return ok(rows.filter((row) => row.id !== 9 && row.id !== 10))
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      calls.push(['POST', path, body])
      if (path === '/system/tenant-package/create') return ok('9007199254740993')
      if (path === '/system/tenant/create') return ok('9007199254740995')
      throw new Error(`unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      calls.push(['PUT', path, body])
      return ok(true)
    }
  }
  const fixture = await createPmsIsolationTenant(api, { marker: 'PMS001ABC', password: 'Pms!fixture1' })
  assert.equal(fixture.packageId, '9007199254740993')
  assert.equal(fixture.tenantId, '9007199254740995')
  assert.equal(calls.find((call) => call[1] === '/system/tenant-package/create')[2].status, 0)
  assert.equal(calls.find((call) => call[1] === '/system/tenant/create')[2].packageId, '9007199254740993')
  const record = { checks: [], evidence: [] }
  await retirePmsIsolationTenant(api, fixture, record)
  const retire = calls.filter((call) => call[0] === 'PUT')
  assert.deepEqual(retire.map((call) => call[1]), ['/system/tenant/update', '/system/tenant-package/update'])
  assert.equal(retire[0][2].status, 1)
  assert.equal(retire[1][2].status, 1)
  assert.equal(retire[0][2].id, '9007199254740995')
  assert.equal(retire[1][2].id, '9007199254740993')
  assert.equal(record.checks.length, 0)
})

test('PMS retirement fails when successful writes do not persist the disabled state', async () => {
  const record = { checks: [], evidence: [] }
  const api = {
    putBusiness: async () => ok(true),
    getBusiness: async () => ok({ id: '101', status: 0 })
  }
  await retirePmsIsolationTenant(api, {
    tenantId: '101', packageId: '102', tenantPayload: {}, packagePayload: {}
  }, record)
  assert.equal(record.checks.length, 1)
  assert.equal(record.checks[0].passed, false)
  assert.match(record.checks[0].details, /停用状态回读不一致/)
  assert.equal(record.evidence.length, 0)
})
