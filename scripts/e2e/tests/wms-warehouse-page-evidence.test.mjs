import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { __internal } from '../suites/wms-quality.mjs'

const response = ({
  url = 'http://127.0.0.1:48083/admin-api/mes/wmsHouseArea/list?pageNo=1&pageSize=10&houseId=42',
  status = 200,
  ok = status >= 200 && status < 300,
  body = { code: 0, data: { total: 1, records: [{ id: 'area-1', houseId: '42' }] } }
} = {}) => ({
  url: () => url,
  ok: () => ok,
  status: () => status,
  json: async () => body
})

test('warehouse evidence accepts only successful, scoped one-page responses', async () => {
  const result = await __internal.validateWarehousePageResponse(
    response(), '/mes/wmsHouseArea/list', '42'
  )
  assert.equal(result.passed, true)
  assert.match(result.details, /scoped=true/)
  assert.match(result.details, /totalMatches=true/)
})

test('warehouse evidence rejects global totals, non-array payloads, cross-warehouse rows, and failed responses', async () => {
  const cases = [
    response({ body: { code: 0, data: { total: 399, records: [{ id: 'area-1', houseId: '42' }] } } }),
    response({ body: { code: 0, data: { total: 1 } } }),
    response({ body: { code: 0, data: { total: 1, records: [{ id: 'area-1', houseId: '99' }] } } }),
    response({ status: 500, body: { code: 500, msg: '系统异常' } })
  ]
  for (const item of cases) {
    const result = await __internal.validateWarehousePageResponse(item, '/mes/wmsHouseArea/list', '42')
    assert.equal(result.passed, false)
  }
})

test('warehouse response waiter is exact about path and houseId', () => {
  assert.equal(__internal.warehousePageRequest(response(), '/mes/wmsHouseArea/list', '42'), true)
  assert.equal(__internal.warehousePageRequest(response({
    url: 'http://127.0.0.1:48083/admin-api/mes/wmsHouseArea/list?pageNo=1&pageSize=10&houseId=43'
  }), '/mes/wmsHouseArea/list', '42'), false)
  assert.equal(__internal.warehousePageRequest(response({
    url: 'http://127.0.0.1:48083/admin-api/mes/wms-house-location/page?pageNo=1&pageSize=10&houseId=42'
  }), '/mes/wmsHouseArea/list', '42'), false)
})

test('screenshot helper clicks the tree node and gates evidence on both scoped page responses', () => {
  const source = fs.readFileSync(new URL('../suites/wms-quality.mjs', import.meta.url), 'utf8')
  const helper = source.slice(source.indexOf('const captureWarehousePageEvidence'))
  assert.match(helper, /Promise\.all\(\[\s*areaResponse,\s*locationResponse,/)
  assert.match(helper, /await labels\.first\(\)\.click\(\)/)
  assert.match(helper, /\.el-tree-node\.is-current/)
  assert.match(helper, /validateWarehousePageResponse\(area/)
  assert.match(helper, /validateWarehousePageResponse\(location/)
  assert.match(helper, /仓库档案页面过滤证据失败，截图仅供排查，不作为过滤通过证据/)
})

test('warehouse screenshots use retained inventory fixtures instead of emptied switch/delete probes', () => {
  const source = fs.readFileSync(new URL('../suites/wms-quality.mjs', import.meta.url), 'utf8')
  assert.match(source, /pageWarehouse: references\.inventoryFixture\.warehouse/)
  assert.match(source, /const inventoryFixture = await verifyWarehouseDimensionInventory\(api, caseRecord\)/)
  assert.match(source, /warehouse: inventoryFixture\.warehouse, openRoute, saveScreenshot/)
})
