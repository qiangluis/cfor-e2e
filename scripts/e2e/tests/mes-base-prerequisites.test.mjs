import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLegacyInitializedRoute, isPb038002Fixture, mesBaseRows, mesBaseDetail, pb038GradePayload, runCase
} from '../suites/mes-base.mjs'

const ok = (data) => ({ code: 0, data })
const fixture = {
  id: '2106195986162864130', code: 'E2E_PB038_002_ONLY',
  mark: 'PB038-002 dedicated e2e fixture', inventoryNature: 'STOCK',
  unitId: '2106194707130830849', gradeManaged: 'N',
  defaultGradeId: null, allowedGradeIds: []
}

test('MES base strictly unwraps both envelopes without losing material unit or string IDs', () => {
  assert.deepEqual(mesBaseRows(ok({ list: [fixture], total: 1 }), 'material'), [fixture])
  const detail = mesBaseDetail({ code: 200, success: true, data: fixture }, fixture.id, 'material')
  assert.equal(pb038GradePayload(detail, { gradeManaged: 'Y' }).unitId, fixture.unitId)
  for (const result of [
    ok({ list: [], total: 1 }), ok({}), ok([{}]), { code: 500, data: [] },
    { code: 200, success: false, data: [] }
  ]) assert.throws(() => mesBaseRows(result, 'invalid'))
  assert.throws(() => mesBaseDetail(ok({}), fixture.id, 'material'))
})

test('PB038 only owns its exact dedicated fixture, never another E2E or formal material', () => {
  assert.equal(isPb038002Fixture(fixture), true)
  for (const row of [
    { ...fixture, code: 'E2E_20261003' }, { ...fixture, mark: '' },
    { ...fixture, unitId: '' }, { ...fixture, inventoryNature: 'VIRTUAL' }
  ]) {
    assert.equal(isPb038002Fixture(row), false)
    assert.throws(() => pb038GradePayload(row, {}))
  }
})

function harness (responses, putBusiness = async () => ok(true)) {
  const calls = []
  const api = {
    getBusiness: async (url) => {
      calls.push(['GET', url])
      const value = responses[url]
      if (!value) throw new Error(`Unexpected GET ${url}`)
      return value
    },
    putBusiness: async (url, data) => {
      calls.push(['PUT', url, data])
      return putBusiness(url, data)
    },
    request: async () => { throw new Error('unexpected write') }
  }
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const dependencies = {
    login: async () => 'unit-token', createApiClient: () => api,
    openRoute: async (_page, route, options) => { calls.push(['UI', route, options]) },
    saveScreenshot: async () => {}
  }
  const run = (caseId) => runCase({ caseId, caseRecord, record: {}, page: {}, outputDir: '' }, dependencies)
  return { run, calls, caseRecord }
}

test('all five new DESIGNED branches execute actual read prerequisites and keep empty facts PARTIAL', async () => {
  const responses = Object.fromEntries([
    '/mes/production-type-rule/page?pageNo=1&pageSize=100',
    '/mes/prodOrder/list/dictText?pageNo=1&pageSize=100',
    '/erp/barcode/rules/page?pageNo=1&pageSize=100',
    '/mes/workCalendar/page?pageNo=1&pageSize=100',
    '/mes/team-handover/page?pageNo=1&pageSize=100',
    '/mes/wmsTechRoute/list?pageNo=1&pageSize=100',
    '/mes/prodWorkTask/list?pageNo=1&pageSize=100'
  ].map((url) => [url, ok({ list: [], total: 0 })]))
  for (const url of ['/erp/barcode/catalog/object-types', '/erp/barcode/catalog/carriers', '/mes/workMode/list']) {
    responses[url] = ok([])
  }
  responses['/system/auth/get-permission-info'] = ok({ menus: [] })
  for (const id of ['MES-BASE-001', 'MES-BASE-003', 'MES-BASE-004', 'MES-BASE-005', 'MES-BASE-006']) {
    const h = harness(responses)
    const result = await h.run(id)
    assert.equal(result.partial, true, id)
    assert.notEqual(result.designed, true, id)
    assert.ok(h.calls.length > 0, id)
    assert.ok(h.calls.every(([method]) => ['GET', 'UI'].includes(method)), id)
    assert.ok(result.note.length > 20)
  }
})

test('only the exact legacy initialization route may lack publication audit without a false FAIL', () => {
  const legacy = { code: 'INIT-ROUTE-001', createBy: 'system-init', publishTime: null, publishBy: null }
  assert.equal(isLegacyInitializedRoute(legacy), true)
  assert.equal(isLegacyInitializedRoute({ ...legacy, code: 'FORMAL_ROUTE' }), false)
  assert.equal(isLegacyInitializedRoute({ ...legacy, createBy: 'admin' }), false)
  assert.equal(isLegacyInitializedRoute({ ...legacy, publishTime: '2026-10-06 10:00:00' }), false)
})

test('barcode normalizes real /views menu component and waits for the actual page control', async () => {
  const h = harness({
    '/erp/barcode/catalog/object-types': ok([{ id: 1, code: 'MATERIAL' }]),
    '/erp/barcode/catalog/carriers': ok([
      { id: 1, code: 'BARCODE', supported: 1, deferred: 0 },
      { id: 2, code: 'QR_CODE', supported: 1, deferred: 0 },
      { id: 3, code: 'RFID', supported: 0, deferred: 1 }
    ]),
    '/erp/barcode/rules/page?pageNo=1&pageSize=100': ok({ list: [], total: 0 }),
    '/system/auth/get-permission-info': ok({ menus: [{
      path: '/erp', children: [{
        path: 'barcode', children: [{
          path: 'barCodeRules', component: '/views/barcode/barCodeRules/index'
        }]
      }]
    }] })
  })
  assert.equal((await h.run('MES-BASE-003')).partial, true)
  assert.deepEqual(h.calls.find(([method]) => method === 'UI'), [
    'UI', '/erp/barcode/barCodeRules', { readySelector: 'input[placeholder="请输入规则编码"]' }
  ])
  assert.ok(h.caseRecord.checks.every((check) => check.passed))
})

test('PB038 absent dedicated fixture never creates grades or mutates other E2E material', async () => {
  const h = harness({
    '/base/material-grade/simple-list': ok([]),
    '/mes/basMaterial/list?pageNo=1&pageSize=100': ok({
      records: [{ ...fixture, code: 'E2E_20261003' }], total: 1
    })
  })
  assert.equal((await h.run('PB038-002')).partial, true)
  assert.ok(h.calls.every(([method]) => method === 'GET'))
})

test('PB038 successful write followed by readback error still restores unwrapped original in finally', async () => {
  const idUrl = `/mes/basMaterial/queryById?id=${fixture.id}`
  const responses = {
    '/base/material-grade/simple-list': ok(['A', 'B', 'C'].map((code) => ({ id: code, code }))),
    '/mes/basMaterial/list?pageNo=1&pageSize=100': ok({ records: [fixture], total: 1 }),
    [idUrl]: ok(fixture),
    [`/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${fixture.id}`]: ok({ list: [], total: 0 })
  }
  let writes = 0
  const h = harness(responses, async () => {
    writes++
    responses[idUrl] = writes === 1 ? ok({}) : ok(fixture)
    return ok(true)
  })
  await assert.rejects(h.run('PB038-002'), /详情响应无效/)
  assert.equal(writes, 2)
  const payloads = h.calls.filter(([method]) => method === 'PUT').map(([, , data]) => data)
  assert.ok(payloads.every((data) => data.unitId === fixture.unitId && !('data' in data)))
  assert.deepEqual(payloads[1].allowedGradeIds, [])
  assert.equal(payloads[1].gradeManaged, 'N')
})
