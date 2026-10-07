import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { coreDirections, duplicateCodes, finiteQuantity, menuRoute, runCase, strictList } from '../suites/wms-quality.mjs'

test('WMS strictList distinguishes valid empty data from malformed payload', () => {
  assert.deepEqual(strictList({ data: { list: [] }}), { valid: true, rows: [] })
  assert.deepEqual(strictList({ data: {} }), { valid: false, rows: [] })
  assert.equal(strictList({ data: [{}] }).valid, false)
  assert.equal(strictList({ data: [null] }).valid, false)
})

test('WMS quantitative prerequisites do not treat null or blank as zero', () => {
  for (const value of [null, undefined, '', ' ', 'not-a-number', Infinity]) assert.equal(finiteQuantity(value), false)
  for (const value of [0, '0', '12.500']) assert.equal(finiteQuantity(value), true)
})

test('WMS core directions keep the historical 106/301/302 contracts', () => {
  assert.equal(Object.keys(coreDirections).length, 18)
  assert.equal(coreDirections[106], 'IN')
  assert.equal(coreDirections[301], 'OUT')
  assert.equal(coreDirections[302], 'IN')
})

test('WMS code uniqueness is scoped to warehouse, not global code alone', () => {
  assert.equal(duplicateCodes([{ houseId: 1, areaCode: 'A' }, { houseId: 2, areaCode: 'A' }], 'areaCode').length, 0)
  assert.equal(duplicateCodes([{ houseId: 1, areaCode: 'A' }, { houseId: 1, areaCode: 'A' }], 'areaCode').length, 1)
})

test('WMS menuRoute resolves nested relative paths and rejects missing routes', () => {
  const menus = [{
    path: '/settings',
    children: [{
      path: 'warehouse',
      children: [{ path: 'archive', component: 'base/warehouseConfig/archives/index.vue' }]
    }]
  }]
  assert.equal(menuRoute(menus, ['base/warehouseConfig/archives/index']), '/settings/warehouse/archive')
  assert.equal(menuRoute(menus, ['wms/missing/index']), null)
  assert.equal(menuRoute([
    { path: '/a', component: 'base/warehouseConfig/archives/index' },
    { path: '/b', component: 'base/warehouseConfig/archives/index' }
  ], ['base/warehouseConfig/archives']), '/a')
  assert.equal(menuRoute([
    { path: '/systemModel/base/archives', component: 'base/warehouseConfig/archives/index' },
    { path: '/settings/warehouse/archives', component: 'base/warehouseConfig/archives/index' }
  ], ['base/warehouseConfig/archives']), '/settings/warehouse/archives')
})

test('WMS-QC-008 readonly branch stays partial and performs no API writes', async () => {
  const calls = []
  let currentUrl = 'about:blank'
  const page = {
    url: () => currentUrl,
    getByRole: () => ({ count: async () => 0 })
  }
  const api = {
    async getBusiness(path) {
      calls.push(`GET ${path}`)
      if (path === '/mes/wmsWareHouse/allTree') return { code: 0, data: [{ id: 1 }] }
      if (path.includes('/mes/wmsWareHouse/queryById')) {
        return { code: 0, data: { id: 1, areaEnabled: false, locationEnabled: false } }
      }
      if (path === '/system/auth/get-permission-info') {
        return {
          code: 0,
          data: {
            menus: [{
              path: '/settings',
              children: [{
                path: 'warehouse',
                children: [{ path: 'archives', component: 'base/warehouseConfig/archives/index' }]
              }]
            }]
          }
        }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    post: async (...args) => {
      calls.push(`POST ${args[0]}`)
      throw new Error('readonly branch attempted POST')
    },
    put: async (...args) => {
      calls.push(`PUT ${args[0]}`)
      throw new Error('readonly branch attempted PUT')
    },
    delete: async (...args) => {
      calls.push(`DELETE ${args[0]}`)
      throw new Error('readonly branch attempted DELETE')
    }
  }
  const caseRecord = { checks: [], evidence: [], notes: [] }
  const result = await runCase(
    { caseId: 'WMS-QC-008', page, record: {}, caseRecord, outputDir: '/tmp' },
    {
      login: async () => 'token',
      createApiClient: () => api,
      openRoute: async (_page, route) => { currentUrl = `http://127.0.0.1:9151${route}` },
      saveScreenshot: async () => {}
    }
  )
  assert.equal(result.partial, true)
  assert.equal(calls.some((call) => /^(POST|PUT|DELETE) /.test(call)), false)
  assert.equal(caseRecord.checks.some((check) => check.passed === false), false)
  assert.match(caseRecord.notes.join('\n'), /未验证|未执行任何仓库写操作/)
})

test('WMS target suite contains no write probe for readonly target cases', () => {
  const source = fs.readFileSync(new URL('../suites/wms-quality.mjs', import.meta.url), 'utf8')
  const target = source.split("if (caseId === 'WMS-QC-005')")[0]
  assert.doesNotMatch(target, /api\.(post|put|delete)\(/)
  const switches = source.split("if (caseId === 'WMS-QC-008')")[1].split("if (caseId === 'WMS-QC-009')")[0]
  assert.doesNotMatch(switches, /api\.(post|put|delete)\(/)
  assert.match(switches, /finally/)
  assert.match(switches, /partial: true/)
  assert.doesNotMatch(target, /readySelector: 'body'/)
})
