import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { caseOutcome } from '../lib/report.mjs'
import {
  iotReadonlyPage, iotReadonlyViews, runIotReadonlyContract,
  runIotReadonlyCase, validateDeviceSnapshot
} from '../suites/iot-readonly.mjs'

const ok = (data) => ({ code: 0, data })
const paged = (list, shape = 'list') =>
  ok(shape === 'records' ? { records: list, total: list.length } : { list, total: list.length })
const record = () => ({ checks: [], notes: [], evidence: [] })
const product = () => ({
  id: '2106401100777586690', name: 'unit-product', productKey: 'unit-product-key',
  status: 0, deviceType: 0, protocolType: 'mqtt'
})
const device = () => ({
  id: '2106401100798558209', productId: '2106401100777586690',
  assetStatus: 'ENABLED', state: 1, deviceType: 0, protocolType: 'mqtt',
  accessConfigVersion: 1,
  productModelSnapshot: JSON.stringify({
    productId: '2106401100777586690', productKey: 'unit-only',
    deviceType: 0, netType: 1, protocolType: 'mqtt', serializeType: 'json',
    accessConfigVersion: 1
  })
})
const anomaly = () => ({
  id: '20', type: 'DUPLICATE', status: 0,
  idempotentKey: 'unit-only', sequenceNo: 10, qualityCode: 0, payload: '{}'
})
const alert = () => ({ id: '30', alertStatus: 'ACTIVE' })
const alertConfig = () => ({
  id: '31', durationSeconds: 0, combineMode: 'OR', combineExpression: null,
  suppressSeconds: 300, escalateSeconds: 600, escalateLevel: 3
})
const route = () => ({ id: '2106401100888888888', version: '1.0' })
const procedure = () => ({
  id: '2106401100999999999',
  procedureId: '2106401100666666666',
  equipmentId: '2106401100798558209'
})
const capacity = () => ({
  id: '2106401100111111111',
  routeSubId: '2106401100999999999',
  equipmentId: '2106401100798558209',
  unitId: 'PCS',
  standardOutput: 10,
  standardDuration: 60,
  changeoverMinutes: 5,
  calendarCode: 'DEFAULT',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  capacityVersion: 1,
  publishStatus: 2
})
const dict = () => ({
  id: '2106401100222222222', label: '生产设备', value: '1', dictType: 'equipment_type'
})

test('IOT-003 uses only official numeric capacity publish states', async () => {
  for (const publishStatus of [undefined, 'PUBLISHED', 99]) {
    const f = fixture('IOT-003', true, {
      '/mes/wmsTechRoute/capacity/list?routeSubId=2106401100999999999&equipmentId=2106401100798558209':
        ok([{ ...capacity(), publishStatus }])
    })
    await assert.rejects(runIotReadonlyContract({
      caseId: 'IOT-003', api: f.api, caseRecord: record()
    }), /产能版本/)
  }
})

// Unit fixtures never substitute API responses in real Chrome runs.
function fixture(caseId, populated = true, overrides = {}) {
  const paths = {
    '/iot/device/page?pageNo=1&pageSize=100': paged(populated ? [device()] : []),
    '/iot/device/get?id=2106401100798558209': ok(device()),
    '/iot/device/message/page?pageNo=1&pageSize=100&deviceId=2106401100798558209':
      paged(populated ? [{
        id: '40', deviceId: device().id, method: 'PROPERTY_REPORT',
        upstream: true, reply: false, identifier: 'temperature', pointVersion: 1
      }] : []),
    '/iot/device/message/latest?limit=20': ok(populated ? [{
      id: '40', deviceId: device().id, identifier: 'temperature', pointVersion: 1
    }] : []),
    '/iot/data-anomaly/page?pageNo=1&pageSize=100': paged(populated ? [anomaly()] : []),
    '/iot/data-anomaly/get?id=20': ok(anomaly()),
    '/iot/alert-config/page?pageNo=1&pageSize=100': paged(populated ? [alertConfig()] : []),
    '/iot/alert-record/page?pageNo=1&pageSize=100': paged(populated ? [alert()] : []),
    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=equipment_type':
      paged(populated ? [dict()] : []),
    '/iot/product/page?pageNo=1&pageSize=100': paged(populated ? [product()] : []),
    '/mes/wmsTechRoute/list?pageNo=1&pageSize=100':
      paged(populated ? [route()] : [], 'records'),
    '/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?parentId=2106401100888888888&pageNo=1&pageSize=100':
      paged(populated ? [procedure()] : [], 'records'),
    '/mes/wmsTechRoute/capacity/list?routeSubId=2106401100999999999&equipmentId=2106401100798558209':
      ok(populated ? [capacity()] : []),
    '/system/auth/get-permission-info': ok({
      menus: [{
        path: '/iot',
        children: [{ path: caseId, component: iotReadonlyViews[caseId].component }]
      }, {
        path: '/mes',
        children: [{ path: 'produce/technique', component: 'mes/produce/technique/index' }]
      }]
    }),
    ...overrides
  }
  const calls = []
  const api = { async getBusiness(path) {
    calls.push(path)
    assert.ok(Object.hasOwn(paths, path), `Unexpected GET ${path}`)
    return structuredClone(paths[path])
  } }
  return { api, calls }
}

test('IoT page rejects failed business codes and malformed rows/counts', () => {
  for (const payload of [
    { code: 500, data: { list: [], total: 0 } },
    ok({}), ok({ list: {}, total: 0 }), ok({ list: [null], total: 1 }),
    ok({ list: [[]], total: 1 }), ok({ list: [], total: '0' }),
    ok({ list: [], total: -1 }), ok({ list: [{}], total: 0 })
  ]) assert.throws(() => iotReadonlyPage(payload, 'unit page'))
  assert.deepEqual(iotReadonlyPage(paged([]), 'unit page'), { list: [], total: 0 })
  assert.deepEqual(iotReadonlyPage(paged([], 'records'), 'unit records'), {
    records: [], list: [], total: 0
  })
})

for (const caseId of Object.keys(iotReadonlyViews)) {
  for (const populated of [false, true]) {
    test(`${caseId} ${populated ? 'populated' : 'empty'} facts always remain PARTIAL`, async () => {
      const f = fixture(caseId, populated)
      const caseRecord = record()
      const result = await runIotReadonlyContract({ caseId, api: f.api, caseRecord })
      assert.equal(result.partial, true)
      assert.ok(caseRecord.checks.every((check) => check.passed))
      assert.equal(caseOutcome({
        failedChecks: [], hasAssertions: true, result
      }).status, 'PARTIAL')
      assert.ok(!f.calls.some((path) => /handle|asset-status|acknowledge|close|update/.test(path)))
      if (!populated) {
        assert.ok(caseRecord.notes.some((note) => /前置缺失/.test(note)))
        assert.ok(!f.calls.some((path) => path.includes('/get?id=')))
        assert.ok(!caseRecord.checks.some((check) => /详情|生命周期状态|独立字段/.test(check.name)))
      }
    })
  }
  test(`${caseId} uses real menu route, specific ready selector and screenshot evidence`, async () => {
    const f = fixture(caseId)
    const caseRecord = record()
    let url = 'http://127.0.0.1:9151/'
    const opened = []
    const result = await runIotReadonlyCase({
      caseId, caseRecord, record: {}, outputDir: '/unused',
      page: {
        url: () => url,
        locator: () => ({
          allInnerTexts: async () =>
            iotReadonlyViews[caseId].headers || iotReadonlyViews[caseId].labels,
          innerText: async () => '工艺路线 工序库'
        })
      }
    }, {
      login: async () => 'unit-token', createApiClient: () => f.api,
      openRoute: async (_page, route, options) => {
        opened.push({ route, options })
        url = `http://127.0.0.1:9151${route}`
      },
      saveScreenshot: async () => '/unit-only/screenshot.png'
    })
    assert.equal(opened[0].route, `/iot/${caseId}`)
    assert.equal(opened[0].options.readySelector, iotReadonlyViews[caseId].readySelector)
    if (caseId === 'IOT-003') {
      assert.equal(opened[1].route, '/mes/produce/technique')
      assert.equal(opened[1].options.readySelector, '.technique-route')
    }
    assert.equal(result.partial, true)
    assert.deepEqual(
      caseRecord.evidence,
      caseId === 'IOT-003'
        ? ['/unit-only/screenshot.png', '/unit-only/screenshot.png']
        : ['/unit-only/screenshot.png']
    )
  })
}

test('IOT-013 requires both snapshot and version, not an OR', () => {
  for (const change of [{ accessConfigVersion: null }, { productModelSnapshot: null }]) {
    const caseRecord = record()
    assert.equal(validateDeviceSnapshot({ ...device(), ...change }, caseRecord), false)
    assert.equal(caseRecord.checks.length, 0)
    assert.match(caseRecord.notes[0], /缺模型快照或接入版本/)
  }
})

test('IOT-002 accepts UUID message identifiers while requiring numeric device IDs', async () => {
  const f = fixture('IOT-002', true, {
    '/iot/device/message/latest?limit=20': ok([{
      id: '59e5d0b664c043e8b3befcdfdf143916',
      deviceId: device().id,
      identifier: null,
      pointVersion: null
    }])
  })
  const caseRecord = record()
  const result = await runIotReadonlyContract({
    caseId: 'IOT-002',
    api: f.api,
    caseRecord
  })
  assert.equal(result.partial, true)
  assert.ok(caseRecord.checks.every((check) => check.passed))
})

test('IOT-013 rejects malformed snapshot, wrong product and inconsistent versions', () => {
  for (const snapshot of [
    'not-json', 'null', '[]', '{}',
    JSON.stringify({ ...JSON.parse(device().productModelSnapshot), productId: '999' }),
    JSON.stringify({ ...JSON.parse(device().productModelSnapshot), accessConfigVersion: 2 })
  ]) assert.throws(() => validateDeviceSnapshot({
    ...device(), productModelSnapshot: snapshot
  }, record()))
})

test('IOT-013 rejects missing detail, state drift and missing asset state', async () => {
  for (const detail of [null, { ...device(), state: 2 }, { ...device(), assetStatus: 'DISABLED' }]) {
    const f = fixture('IOT-013', true, {
      '/iot/device/get?id=2106401100798558209': ok(detail)
    })
    await assert.rejects(() => runIotReadonlyContract({
      caseId: 'IOT-013', api: f.api, caseRecord: record()
    }), /详情与分页/)
  }
  const f = fixture('IOT-013', true, {
    '/iot/device/page?pageNo=1&pageSize=100': paged([{ ...device(), assetStatus: null }])
  })
  await assert.rejects(() => runIotReadonlyContract({
    caseId: 'IOT-013', api: f.api, caseRecord: record()
  }), /独立字段/)
})

test('IOT-009 rejects invalid status and incomplete or mismatched anomaly detail', async () => {
  for (const detail of [null, { ...anomaly(), id: '21' }, { id: '20', type: 'DUPLICATE', status: 0 }]) {
    const f = fixture('IOT-009', true, { '/iot/data-anomaly/get?id=20': ok(detail) })
    await assert.rejects(() => runIotReadonlyContract({
      caseId: 'IOT-009', api: f.api, caseRecord: record()
    }), /异常详情/)
  }
  const f = fixture('IOT-009', true, {
    '/iot/data-anomaly/page?pageNo=1&pageSize=100': paged([{ ...anomaly(), status: 99 }])
  })
  await assert.rejects(() => runIotReadonlyContract({
    caseId: 'IOT-009', api: f.api, caseRecord: record()
  }), /处理状态/)
})

test('IOT-010 rejects missing upgrade fields and arbitrary lifecycle status', async () => {
  for (const overrides of [
    { '/iot/alert-config/page?pageNo=1&pageSize=100': paged([{ id: '31' }]) },
    { '/iot/alert-record/page?pageNo=1&pageSize=100': paged([{ id: '30', alertStatus: 'OK' }]) }
  ]) {
    const f = fixture('IOT-010', true, overrides)
    await assert.rejects(() => runIotReadonlyContract({
      caseId: 'IOT-010', api: f.api, caseRecord: record()
    }))
  }
})

test('missing menu blocks before contract queries or navigation', async () => {
  const f = fixture('IOT-013', false, { '/system/auth/get-permission-info': ok({ menus: [] }) })
  await assert.rejects(() => runIotReadonlyCase({
    caseId: 'IOT-013', caseRecord: record(), page: {}, record: {}
  }, {
    login: async () => 'unit-token', createApiClient: () => f.api,
    openRoute: async () => assert.fail('must not navigate')
  }), /BLOCKED.*component=/)
  assert.equal(f.calls.length, 1)
})

test('404 or generic shell cannot count as IoT domain UI', async () => {
  for (const [url, labels] of [
    ['http://127.0.0.1:9151/404', iotReadonlyViews['IOT-013'].labels],
    ['http://127.0.0.1:9151/iot/IOT-013', ['首页']]
  ]) {
    const f = fixture('IOT-013')
    await assert.rejects(() => runIotReadonlyCase({
      caseId: 'IOT-013', record: {}, caseRecord: record(),
      page: { url: () => url, locator: () => ({ allInnerTexts: async () => labels }) }
    }, {
      login: async () => 'unit-token', createApiClient: () => f.api,
      openRoute: async () => {}, saveScreenshot: async () => assert.fail('must not capture')
    }), /真实权限菜单路由与领域界面/)
  }
})

test('IoT readonly implementation has no state-changing API methods', () => {
  const source = fs.readFileSync(new URL('../suites/iot-readonly.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /api\.(put|post|delete|request)|runReadOnlySql/)
  assert.match(source, /partial: true/)
})
