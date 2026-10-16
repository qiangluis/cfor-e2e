import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  expectedMesBaseDomainRejection, isLegacyInitializedRoute, isMesBaseSuccess,
  isPb038002Fixture, matchesGradeInventoryReportRow, matchesPb038ReportUiRows,
  mesBaseRows, mesBaseDetail, matchesTeamHandoverCancellation,
  pb038GradePayload, runCase
} from '../suites/mes-base.mjs'
import {
  capacityMinimum, capacityProductScope, capacityRowsForProduct, capacitySavePayload,
  capacityProductPayload, cleanupRouteCapacityFixture,
  teamHandoverPayload, workCalendarPayload
} from '../fixtures/mes-base-fixtures.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

const ok = (data) => ({ code: 0, data })
const fixture = {
  id: '2106195986162864130', code: 'E2E_PB038_002_ONLY',
  mark: 'PB038-002 dedicated e2e fixture', inventoryNature: 'STOCK',
  unitId: '2106194707130830849', gradeManaged: 'N',
  defaultGradeId: null, allowedGradeIds: []
}

const cancelledHandover = () => {
  const expected = {
    handoverId: '2100000000000000001', outTeamId: '2100000000000000002',
    inTeamId: '2100000000000000003', marker: 'MESB005-TEST', reason: 'owned cancel'
  }
  const detail = {
    id: expected.handoverId, status: 0, outConfirmBy: null, inConfirmBy: null,
    outTeamId: expected.outTeamId, inTeamId: expected.inTeamId,
    remark: `${expected.marker}；取消原因：${expected.reason}`
  }
  const rows = [[detail.id, '0', 'NULL', 'NULL', detail.remark, '1', '0', detail.outTeamId, detail.inTeamId]]
  return { detail, rows, expected }
}

test('handover cancellation requires exact API and SQL nulls while retaining owned record and teams', () => {
  const h = cancelledHandover()
  assert.equal(matchesTeamHandoverCancellation(h.detail, h.rows, h.expected), true)
  for (const patch of [
    { status: 1 }, { outConfirmBy: 'old confirmer' }, { inConfirmBy: '' },
    { id: '2100000000000000004' }, { outTeamId: h.expected.inTeamId },
    { inTeamId: h.expected.outTeamId }, { remark: h.expected.marker }
  ]) {
    assert.equal(matchesTeamHandoverCancellation({ ...h.detail, ...patch }, h.rows, h.expected), false)
  }
})

test('handover cancellation cannot pass on API-only, another tenant, deleted row or stale database confirmations', () => {
  const h = cancelledHandover()
  for (const rows of [undefined, [], [...h.rows, ...h.rows]]) {
    assert.equal(matchesTeamHandoverCancellation(h.detail, rows, h.expected), false)
  }
  for (const [index, value] of [
    [0, '2100000000000000004'], [1, '1'], [2, 'old confirmer'], [3, ''],
    [4, 'different remark'], [5, '2'], [6, '1'], [7, h.expected.inTeamId], [8, h.expected.outTeamId]
  ]) {
    const row = [...h.rows[0]]
    row[index] = value
    assert.equal(matchesTeamHandoverCancellation(h.detail, [row], h.expected), false)
  }
})

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

test('MES base write fixtures preserve Snowflake IDs and use the backend date-time format', () => {
  const workModeId = '2106210110036992002'
  assert.equal(workCalendarPayload('MESB004-TEST', {
    workModeId, startDate: '2026-10-09', endDate: '2026-10-09'
  }).workModeId, workModeId)
  assert.equal(teamHandoverPayload('MESB005-TEST', {
    outTeamId: '2100000000000000001', inTeamId: '2100000000000000002'
  }).handoverTime, '2026-01-01T08:00:00')
})

test('MES base accepts both success envelopes but does not classify system errors as domain rejections', () => {
  assert.equal(isMesBaseSuccess({ code: 0, data: true }), true)
  assert.equal(isMesBaseSuccess({ code: 200, success: true, data: true }), true)
  assert.equal(isMesBaseSuccess({ code: 200, success: false, data: true }), false)
  const rejection = expectedMesBaseDomainRejection(500, /品级已被引用/)
  assert.equal(rejection.allowServiceCode, true)
  assert.equal(rejection.code, 500)
  assert.match(String(rejection.message), /品级已被引用/)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 500, msg: '品级已被引用，只能停用，不能删除' }, rejection), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 500, msg: '系统异常' }, rejection), false)
  const handoverContract = expectedMesBaseDomainRejection(
    2010954002, '班组交接必须由交出方和接入方双方确认'
  )
  assert.equal(matchesExpectedBusinessRejection({
    code: 2010954002, msg: '班组交接必须由交出方和接入方双方确认'
  }, handoverContract), true)
  const repeatedContract = expectedMesBaseDomainRejection(
    2010954001, '班组交接当前状态不允许该操作：已确认'
  )
  assert.equal(matchesExpectedBusinessRejection({
    code: 2010954001, msg: '班组交接当前状态不允许该操作：已确认'
  }, repeatedContract), true)
})

test('PB102 capacity helpers preserve product scopes and official minimum semantics', () => {
  const detail = {
    routeCapacity: 10,
    procedureList: [{
      procedureCapacity: 10,
      deviceList: [
        { id: 'default', productId: null, mockCapacity: 10 },
        { id: 'a-old', productId: '2100000000000000001', mockCapacity: 88 },
        { id: 'a-new', productId: '2100000000000000001', mockCapacity: 77 },
        { id: 'b', productId: '2100000000000000002', mockCapacity: 99 }
      ]
    }]
  }
  assert.equal(capacityProductScope(detail.procedureList[0].deviceList[0]), null)
  assert.equal(capacityProductScope(detail.procedureList[0].deviceList[1]), '2100000000000000001')
  assert.equal(capacityRowsForProduct(detail, null).length, 1)
  assert.equal(capacityRowsForProduct(detail, '2100000000000000001').length, 2)
  assert.equal(capacityRowsForProduct(detail, '2100000000000000002').length, 1)
  assert.equal(capacityMinimum(detail.procedureList[0].deviceList), 10)
  assert.equal(capacityMinimum(capacityRowsForProduct(detail, '2100000000000000001')), 77)
})

test('PB102 edit payload carries the published capacity id without converting IDs to Number', () => {
  const payload = capacitySavePayload({ routeSubId: '2100000000000000003', procedureId: '2100000000000000004', marker: 'PB102' }, {
    id: '2100000000000000005', deviceId: '2100000000000000006', unitId: '2100000000000000007',
    productId: '2100000000000000008', suffix: 'A-EDIT'
  })
  assert.equal(payload.id, '2100000000000000005')
  assert.equal(payload.productId, '2100000000000000008')
  assert.equal(payload.routeSubId, '2100000000000000003')
  assert.equal(payload.procedureId, '2100000000000000004')
  assert.equal(payload.equipmentId, '2100000000000000006')
})

test('PB102 dedicated capacity products use the official manufacture source contract', () => {
  const payload = capacityProductPayload('PB102-TEST', '2100000000000000007', 'PRODUCT-A')
  assert.equal(payload.source, 'manufacture')
  assert.equal(payload.purchased, 'N')
  assert.equal(payload.produced, 'Y')
})

test('PB102 contract source requires real A/B product scopes and exact duplicate publish rejection', () => {
  const source = fs.readFileSync(new URL('../suites/mes-base.mjs', import.meta.url), 'utf8')
  const pb102 = source.slice(source.indexOf("if (caseId === 'PB102-001'"), source.indexOf("if (caseId === 'PB038-001'"))
  assert.match(pb102, /createCapacityProductFixture\(api, marker, context\.unitId, 'PRODUCT-A'\)/)
  assert.match(pb102, /createCapacityProductFixture\(api, marker, context\.unitId, 'PRODUCT-B'\)/)
  assert.match(pb102, /productId: productA\.id/)
  assert.match(pb102, /productId: productB\.id/)
  assert.match(pb102, /duplicatePublishContract = expectedMesBaseDomainRejection\(\s*400/)
  assert.match(pb102, /同一工序设备产品适用范围已存在有效发布版本，请先停用旧版本再发布/)
  assert.match(pb102, /Number\(editedADraft\?\.capacityVersion\) > Number\(afterEditA\?\.capacityVersion\)/)
  assert.match(pb102, /id: capacityAId, deviceId: context\.deviceId/)
  assert.match(pb102, /详情设备行按已发布优先、版本号降序返回/)
  assert.match(pb102, /readRouteCapacityDetail\(api, fixture\)/)
  assert.doesNotMatch(pb102, /openRoute\(page,[\s\S]{0,180}\.catch\(\(\) => \{\}\)/)
  assert.doesNotMatch(pb102, /saveScreenshot\(page,[\s\S]{0,180}\.catch\(\(\) => \{\}\)/)
})

test('PB102 cleanup retains audit principals and only disables capacity/unpublishes route', async () => {
  const calls = []
  let routeStatus = 2
  let capacityStatus = 1
  const api = {
    getBusiness: async (url) => {
      calls.push(['GET', url])
      if (url.includes('/getRouteCapacityDetail')) {
        return { code: 0, data: { procedureList: [{ deviceList: [
          { id: 'capacity-published', productId: 'product-a', publishStatus: capacityStatus },
          { id: 'capacity-draft', productId: 'product-a', publishStatus: 0 }
        ] }] } }
      }
      if (url.includes('/queryById')) return { code: 0, data: { id: 'route-1', devStatus: routeStatus } }
      throw new Error(`unexpected GET ${url}`)
    },
    postBusiness: async (url) => {
      calls.push(['POST', url])
      if (url.includes('/capacity/disable')) capacityStatus = 2
      if (url.includes('/wmsTechRoute/unpublish')) routeStatus = 3
      return { code: 0, data: true }
    }
  }
  const manifest = await cleanupRouteCapacityFixture(api, {
    routeId: 'route-1', procedureId: 'procedure-1'
  })
  assert.equal(manifest.status, 'RETAINED_AUDIT')
  assert.equal(manifest.cleaned, false)
  assert.deepEqual(manifest.retained.productIds, ['product-a'])
  assert.deepEqual(manifest.retained.capacityIds, ['capacity-published', 'capacity-draft'])
  assert.deepEqual(manifest.errors, [])
  assert.equal(manifest.verification.routeStatusAfter, 3)
  assert.equal(manifest.verification.allKnownCapacityRowsDisabled, true)
  assert.ok(calls.some(([, url]) => url.includes('/capacity/disable?capacityId=capacity-published')))
  assert.ok(calls.some(([, url]) => url.includes('/wmsTechRoute/unpublish?id=route-1')))
  assert.ok(calls.every(([, url]) => !url.includes('/delete')))

  const source = fs.readFileSync(new URL('../suites/mes-base.mjs', import.meta.url), 'utf8')
  const pb102 = source.slice(source.indexOf("if (caseId === 'PB102-001'"), source.indexOf("if (caseId === 'PB038-001'"))
  assert.match(pb102, /cleanupRouteCapacityFixture\(api, fixture\)/)
  assert.doesNotMatch(pb102, /cleanupRouteCapacityFixture\(api, fixture, /)
})

test('PB038 cleanup keeps effective grade inventory and does not call grade restore', () => {
  const source = fs.readFileSync(new URL('../suites/mes-base.mjs', import.meta.url), 'utf8')
  const fixtureSource = fs.readFileSync(new URL('../fixtures/mes-base-fixtures.mjs', import.meta.url), 'utf8')
  const pb038 = source.slice(source.lastIndexOf("if (caseId === 'PB038-003')"), source.lastIndexOf("if (caseId === 'PB038-004')"))
  assert.match(pb038, /保留生效库存/)
  assert.doesNotMatch(pb038, /requestExpectedDomainRejection\(api, 'PUT', '\/mes\/basMaterial\/edit'/)
  assert.match(pb038, /mes\/stk\/report\/view\/list/)
  assert.match(pb038, /materialCode: material\.code/)
  assert.match(pb038, /warehouseId: wms\.warehouse\.id/)
  assert.match(pb038, /wareAreaId: wms\.area\.id/)
  assert.match(pb038, /wareLocationId: wms\.location\.id/)
  assert.match(pb038, /reportAll\.length === 2/)
  assert.match(pb038, /beforeFlowExact = beforeVoidFlow\.length === 1/)
  assert.match(pb038, /afterFlowExact = afterVoidFlow\.length === 1/)
  assert.match(pb038, /正式作废明细继承原单品级且作废状态回读/)
  assert.match(pb038, /Number\(row\.inQty\) === 1 && Number\(row\.outQty\) === 0/)
  assert.match(source, /Number\(row\?\.availableQty\) === Number\(expected\.qty\)/)
  assert.match(pb038, /matchesGradeInventoryReportRow\(row, \{/)
  assert.match(pb038, /costField: reportCostField\(row\), cost:/)
  assert.match(fixtureSource, /deleted: row\[12\] == null \? null/)
  assert.match(pb038, /没有独立红冲单不标记 PASS\/READY/)
  assert.doesNotMatch(pb038, /openRoute\(page, '\/wms\/stock\/report\/inventory'/)
})

test('PB038 report contract does not require a cost field but rejects incorrect quantity', () => {
  const expected = {
    materialId: '2100000000000000001', materialCode: 'PB038-MATERIAL',
    warehouseId: '2100000000000000002', wareAreaId: '2100000000000000003',
    wareLocationId: '2100000000000000004', gradeId: '2100000000000000005', qty: 1
  }
  const reportRow = { ...expected, availableQty: 1 }
  assert.equal(matchesGradeInventoryReportRow(reportRow, expected), true)
  assert.equal(matchesGradeInventoryReportRow({ ...reportRow, qty: 3, availableQty: 3 }, expected), false)
})

test('PB038-003 uses the registered standing-stock component and only screenshots verified filtered rows', () => {
  const source = fs.readFileSync(new URL('../suites/mes-base.mjs', import.meta.url), 'utf8')
  const pb038 = source.slice(source.lastIndexOf("if (caseId === 'PB038-003')"), source.lastIndexOf("if (caseId === 'PB038-004')"))
  const helper = source.slice(source.indexOf('async function verifyPb038ReportPage'),
    source.indexOf('export const isLegacyInitializedRoute'))
  assert.match(helper, /wms\/stock\/reportForms\/standingStock\/index/)
  assert.match(helper, /readySelector: 'input\[placeholder="请输入存货编码"\]'/)
  assert.match(helper, /input\[placeholder="请输入存货编码"\]/)
  assert.match(helper, /\.el-form-item__label/)
  assert.match(helper, /getByRole\('option', \{ name: optionLabel, exact: true \}\)/)
  assert.match(helper, /\.el-select-dropdown:visible/)
  assert.doesNotMatch(helper, /\.el-option/)
  assert.match(helper, /const warehouseLabel = warehouse\.name \|\| warehouse\.code/)
  assert.match(helper, /const areaLabel = \[warehouseLabel, area\.areaName \|\| area\.areaCode\]/)
  assert.match(helper, /const locationLabel = \[area\.areaName \|\| area\.areaCode, location\.locationName \|\| location\.locationCode\]/)
  assert.match(helper, /selectOption\('仓库', warehouseLabel\)/)
  assert.match(helper, /selectOption\('库区', areaLabel\)/)
  assert.match(helper, /selectOption\('库位', locationLabel\)/)
  assert.match(helper, /getByRole\('button', \{ name: '搜索', exact: true \}\)/)
  assert.match(helper, /queryStockQty/)
  assert.match(helper, /params\.get\('warehouseId'\) === String\(warehouse\.id\)/)
  assert.match(helper, /params\.get\('wareAreaId'\) === String\(area\.id\)/)
  assert.match(helper, /params\.get\('wareLocationId'\) === String\(location\.id\)/)
  assert.match(helper, /const rows = await readPb038ReportUiRows\(page\)/)
  assert.match(helper, /rows\.length === 2/)
  assert.match(helper, /expectedQty/)
  assert.match(helper, /waitForFunction\(\(\{ code, expected \}\)/)
  assert.match(helper, /JSON\.stringify\(quantities\) === JSON\.stringify\(expectedQuantities\)/)
  assert.ok(helper.indexOf('await response') < helper.indexOf('waitForFunction'),
    '页面必须先等待本轮 queryStockQty 响应，再等待表格投影')
  const forwardIndex = pb038.indexOf("expectedQty: [1, 2]")
  const voidIndex = pb038.indexOf("api.request('PUT', '/mes/stkIo/void'")
  const reverseIndex = pb038.indexOf("expectedQty: [0, 2]")
  assert.ok(forwardIndex >= 0, '正向页面必须验证 A/B=1/2')
  assert.ok(voidIndex > forwardIndex, '正式作废必须发生在正向页面验证之后')
  assert.ok(reverseIndex > voidIndex, '反向页面必须验证 A/B=0/2')
  assert.match(pb038, /pb038-003-grade-forward/)
  assert.match(pb038, /pb038-003-grade-reverse/)

  assert.equal(matchesPb038ReportUiRows([
    { materialCode: 'M-PB038', qty: '1', availableQty: '1' },
    { materialCode: 'M-PB038', qty: '2', availableQty: '2' }
  ], 'M-PB038'), true)
  assert.equal(matchesPb038ReportUiRows([
    { materialCode: 'M-PB038', qty: '0', availableQty: '0' },
    { materialCode: 'M-PB038', qty: '2', availableQty: '2' }
  ], 'M-PB038', [0, 2]), true)
  assert.equal(matchesPb038ReportUiRows([
    { materialCode: 'M-PB038', qty: '0', availableQty: '0' },
    { materialCode: 'M-PB038', qty: '2', availableQty: '2' }
  ], 'M-PB038', [1, 2]), false)
  assert.equal(matchesPb038ReportUiRows([
    { materialCode: 'M-PB038', qty: '1', availableQty: '1' },
    { materialCode: 'M-PB038', qty: '3', availableQty: '3' }
  ], 'M-PB038'), false)
  assert.equal(matchesPb038ReportUiRows([
    { materialCode: 'M-PB038', qty: '1', availableQty: '1' }
  ], 'M-PB038'), false)
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
