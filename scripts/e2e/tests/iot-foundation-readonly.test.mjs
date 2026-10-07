import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { caseOutcome } from '../lib/report.mjs'
import {
  cases, iotFoundationPage, iotFoundationViews,
  runIotFoundationReadonlyContract, runIotFoundationReadonlyCase
} from '../suites/iot-foundation-readonly.mjs'

const ok = (data) => ({ code: 0, data })
const paged = (list, total = list.length) => ok({ list, total })
const record = () => ({ checks: [], notes: [], evidence: [] })
const productId = '2106401100777586690'
const deviceId = '2106401100798558209'
const groupId = '2106401100798558211'
const product = () => ({ id: productId, name: 'unit product', productKey: 'unit-key',
  status: 0, deviceType: 0 })
const model = () => ({ id: '21', productId, productKey: 'unit-key',
  name: 'Temperature', identifier: 'temperature', type: 1,
  property: { identifier: 'temperature', name: 'Temperature', dataType: 'float' } })
const group = () => ({ id: groupId, name: 'unit group', status: 0, deviceCount: 1 })
const device = () => ({ id: deviceId, productId, productKey: 'unit-key',
  deviceName: 'unit device', state: 0, deviceType: 0, groupIds: [groupId] })

// Mocks are confined to node:test; the suite never mocks browser/API facts.
function fixture(populated = true, overrides = {}) {
  const paths = {
    '/system/auth/get-permission-info': ok({ menus: [{ path: '/iot', children: [
      { path: 'actual-product', component: iotFoundationViews.product.component },
      { path: 'actual-group', component: iotFoundationViews.group.component },
      { path: 'actual-device', component: iotFoundationViews.device.component }
    ] }] }),
    '/iot/product/page?pageNo=1&pageSize=100': paged(populated ? [product()] : []),
    [`/iot/thing-model/page?pageNo=1&pageSize=100&productId=${productId}`]:
      paged(populated ? [model()] : []),
    '/iot/device-group/page?pageNo=1&pageSize=100': paged(populated ? [group()] : []),
    '/iot/device/page?pageNo=1&pageSize=100': paged(populated ? [device()] : []),
    [`/iot/product/get?id=${productId}`]: ok(product()),
    '/iot/thing-model/get?id=21': ok(model()),
    [`/iot/device-group/get?id=${groupId}`]: ok(group()),
    [`/iot/device/get?id=${deviceId}`]: ok(device()),
    [`/iot/device/page?pageNo=1&pageSize=100&groupId=${groupId}`]: paged([device()]),
    ...overrides
  }
  const calls = []
  return {
    paths, calls,
    api: { async getBusiness(path) {
      calls.push(path)
      assert.ok(Object.hasOwn(paths, path), `unexpected GET ${path}`)
      return structuredClone(paths[path])
    } }
  }
}

test('only IOT-001 is supported; malformed/failed page never becomes an empty success', () => {
  assert.deepEqual(cases, ['IOT-001'])
  for (const response of [
    { code: 500, data: { list: [], total: 0 } }, { code: 0, success: false, data: {} },
    ok({}), ok({ list: {}, total: 0 }), paged([null]), paged([[]]),
    paged([], '0'), paged([], -1), paged([], 1), paged([{}], 0),
    paged(Array.from({ length: 101 }, () => ({})))
  ]) assert.throws(() => iotFoundationPage(response, 'unit page'))
  assert.deepEqual(iotFoundationPage(paged([]), 'unit page'), { list: [], total: 0 })
})

for (const populated of [false, true]) {
  test(`${populated ? 'populated' : 'empty'} facts always report PARTIAL and explicit write gaps`, async () => {
    const f = fixture(populated)
    const caseRecord = record()
    const result = await runIotFoundationReadonlyContract({ api: f.api, caseRecord })
    assert.equal(result.partial, true)
    assert.equal(caseOutcome({ failedChecks: [], hasAssertions: true, result }).status, 'PARTIAL')
    assert.match(result.note, /新增维护/)
    assert.match(result.note, /MES 主资源引用/)
    assert.match(result.note, /旧 MES 写侧拒绝/)
    assert.ok(caseRecord.checks.every((check) => check.passed))
    assert.ok(f.calls.every((path) =>
      /^\/iot\/(?:product|thing-model|device-group|device)\/(?:page|get)\?/.test(path)))
    if (!populated) {
      assert.equal(f.calls.length, 3)
      assert.equal(result.modelSample, null)
      assert.ok(caseRecord.notes.filter((note) => /前置缺失/.test(note)).length >= 4)
      assert.ok(!caseRecord.checks.some((check) => /字段|引用|详情|成员/.test(check.name)))
    } else {
      assert.equal(result.modelSample.productId, productId)
      assert.ok(caseRecord.checks.some((check) => /groupIds 精确引用/.test(check.name)))
      assert.equal(f.calls.filter((path) => path === `/iot/product/get?id=${productId}`).length, 1)
    }
  })
}

test('IDs are never rounded/coerced; invalid and duplicate rows fail before detail GET', async () => {
  for (const rows of [
    [{ ...product(), id: Number(productId) }], [{ ...product(), id: '0' }],
    [{ ...product(), id: ' 1' }], [product(), product()],
    [{ ...product(), productKey: '' }]
  ]) {
    const f = fixture(true, { '/iot/product/page?pageNo=1&pageSize=100': paged(rows) })
    await assert.rejects(() => runIotFoundationReadonlyContract({ api: f.api, caseRecord: record() }))
    assert.ok(!f.calls.some((path) => path.includes('/get?')))
  }
})

test('missing detail and product/model/device association drift fail instead of PARTIAL success', async () => {
  for (const overrides of [
    { [`/iot/product/get?id=${productId}`]: ok(null) },
    { '/iot/thing-model/get?id=21': ok({ ...model(), id: '22' }) },
    { '/iot/thing-model/get?id=21': ok({ ...model(), productKey: 'wrong' }) },
    { [`/iot/device/get?id=${deviceId}`]: ok({ ...device(), productKey: 'wrong' }) },
    { [`/iot/device/get?id=${deviceId}`]: ok({ ...device(), groupIds: [] }) },
    { [`/iot/device-group/get?id=${groupId}`]: ok(null) },
    { [`/iot/device/page?pageNo=1&pageSize=100&groupId=${groupId}`]: paged([]) },
    { [`/iot/device/page?pageNo=1&pageSize=100&groupId=${groupId}`]:
      paged([{ ...device(), groupIds: ['999'] }]) }
  ]) {
    const f = fixture(true, overrides)
    const caseRecord = record()
    await assert.rejects(() => runIotFoundationReadonlyContract({ api: f.api, caseRecord }))
    assert.ok(caseRecord.checks.some((check) => check.passed === false))
  }
})

test('definitions must agree with outer identifier/type; no made-up tenant field is required', async () => {
  for (const change of [
    { type: 4 }, { property: null }, { property: { identifier: 'wrong', name: 'Temperature' } },
    { productId: Number(productId) }
  ]) {
    const f = fixture(true, {
      [`/iot/thing-model/page?pageNo=1&pageSize=100&productId=${productId}`]:
        paged([{ ...model(), ...change }])
    })
    await assert.rejects(() => runIotFoundationReadonlyContract({ api: f.api, caseRecord: record() }))
  }
  const f = fixture()
  const caseRecord = record()
  await runIotFoundationReadonlyContract({ api: f.api, caseRecord })
  assert.ok(caseRecord.notes.some((note) => /BaseDO.*不证明其租户隔离/.test(note)))
})

test('parent records outside first page are read by exact referenced IDs', async () => {
  const f = fixture(true, {
    '/iot/product/page?pageNo=1&pageSize=100': paged([]),
    '/iot/device-group/page?pageNo=1&pageSize=100': paged([])
  })
  const result = await runIotFoundationReadonlyContract({ api: f.api, caseRecord: record() })
  assert.equal(result.partial, true)
  assert.ok(f.calls.includes(`/iot/product/get?id=${productId}`))
  assert.ok(f.calls.includes(`/iot/device-group/get?id=${groupId}`))
})

test('no-group devices record a gap, not a fabricated membership', async () => {
  const f = fixture(true, {
    '/iot/device/page?pageNo=1&pageSize=100': paged([{ ...device(), groupIds: null }]),
    [`/iot/device/get?id=${deviceId}`]: ok({ ...device(), groupIds: null }),
    '/iot/device-group/page?pageNo=1&pageSize=100': paged([])
  })
  const caseRecord = record()
  const result = await runIotFoundationReadonlyContract({ api: f.api, caseRecord })
  assert.equal(result.partial, true)
  assert.ok(caseRecord.notes.some((note) => /无分组成员事实/.test(note)))
  assert.ok(!caseRecord.checks.some((check) => /groupIds 精确引用/.test(check.name)))
})

function browserFixture(f, { labels, wrongUrl = false } = {}) {
  let url = 'http://127.0.0.1:9151/'
  const opened = []
  const filled = []
  const clicks = []
  const locator = (selector) => ({
    allInnerTexts: async () => labels ?? (
      selector === '.el-table__header-wrapper th'
        ? iotFoundationViews.group.headers
        : ['产品名称', 'ProductKey', '产品', '设备名称', '所属部门', '设备分组']),
    filter: () => locator(selector),
    first: () => locator(selector),
    waitFor: async () => {},
    count: async () => 1,
    getByRole: (_role, options) => ({
      click: async () => {
        clicks.push(options.name)
        url = `http://127.0.0.1:9151/iot/product/product/detail/${productId}?tab=thingModel`
      }
    }),
    locator: (child) => ({
      waitFor: async () => {},
      allInnerTexts: async () => ['功能类型', '功能名称', '标识符', '数据定义']
    })
  })
  const page = {
    url: () => wrongUrl ? 'http://127.0.0.1:9151/404' : url,
    locator,
    getByText: () => ({}),
    getByPlaceholder: (_placeholder, options) => ({
      fill: async (value) => filled.push({ value, options })
    }),
    getByRole: (_role, options) => ({ click: async () => clicks.push(options.name) }),
    waitForURL: async (predicate) => assert.equal(predicate(new URL(url)), true)
  }
  const dependencies = {
    login: async () => 'unit-token',
    createApiClient: () => f.api,
    openRoute: async (_page, route, options) => {
      opened.push({ route, options })
      url = `http://127.0.0.1:9151${route}`
    },
    saveScreenshot: async (_page, _dir, name) => `/unit-only/${name}.png`
  }
  return { page, dependencies, opened, filled, clicks }
}

test('real component menus and stable labels are used; empty models never open a fake page', async () => {
  const f = fixture(false)
  const browser = browserFixture(f)
  const caseRecord = record()
  const result = await runIotFoundationReadonlyCase({
    caseId: 'IOT-001', page: browser.page, record: {}, caseRecord, outputDir: '/unused'
  }, browser.dependencies)
  assert.equal(result.partial, true)
  assert.deepEqual(browser.opened.map((item) => item.route),
    ['/iot/actual-product', '/iot/actual-group', '/iot/actual-device'])
  assert.ok(browser.opened.every((item) => item.options.readySelector))
  assert.equal(caseRecord.evidence.length, 3)
  assert.ok(!caseRecord.checks.some((check) => /物模型功能定义页/.test(check.name)))
})

test('model UI is reached from exact product entry and true params route, never standalone shell', async () => {
  const f = fixture()
  const browser = browserFixture(f)
  const caseRecord = record()
  const result = await runIotFoundationReadonlyCase({
    caseId: 'IOT-001', page: browser.page, record: {}, caseRecord, outputDir: '/unused'
  }, browser.dependencies)
  assert.equal(result.partial, true)
  assert.equal(browser.filled[0].value, 'unit-key')
  assert.deepEqual(browser.clicks, ['搜索', '物模型'])
  assert.equal(caseRecord.evidence.length, 4)
  assert.ok(caseRecord.checks.some((check) => /真实产品入口打开物模型/.test(check.name)))
  assert.ok(!browser.opened.some((item) => /thing-model/.test(item.route)))
})

test('authorized settings aliases are valid foundation pages without guessed IoT paths', async () => {
  const f = fixture(false, {
    '/system/auth/get-permission-info': ok({ menus: [{ path: '/settings/iot', children: [
      { path: 'product', component: iotFoundationViews.product.component },
      { path: 'device-group', component: iotFoundationViews.group.component },
      { path: 'device', component: iotFoundationViews.device.component }
    ] }] })
  })
  const browser = browserFixture(f)
  const result = await runIotFoundationReadonlyCase({
    caseId: 'IOT-001', page: browser.page, record: {}, caseRecord: record(), outputDir: '/unused'
  }, browser.dependencies)
  assert.equal(result.partial, true)
  assert.deepEqual(browser.opened.map((item) => item.route),
    ['/settings/iot/product', '/settings/iot/device-group', '/settings/iot/device'])
})

test('missing menus block before domain GETs; 404 and generic shell cannot pass', async () => {
  const f = fixture(false, { '/system/auth/get-permission-info': ok({ menus: [] }) })
  const browser = browserFixture(f)
  await assert.rejects(() => runIotFoundationReadonlyCase({
    caseId: 'IOT-001', page: browser.page, record: {}, caseRecord: record()
  }, browser.dependencies), /BLOCKED.*component=/)
  assert.equal(f.calls.length, 1)
  assert.equal(browser.opened.length, 0)
  for (const options of [{ wrongUrl: true }, { labels: ['首页'] }]) {
    const invalid = browserFixture(fixture(false), options)
    await assert.rejects(() => runIotFoundationReadonlyCase({
      caseId: 'IOT-001', page: invalid.page, record: {}, caseRecord: record()
    }, invalid.dependencies), /真实菜单领域界面/)
  }
})

test('implementation contains no business writes, SQL, external endpoints or browser response mocks', () => {
  const source = fs.readFileSync(new URL('../suites/iot-foundation-readonly.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /api\.(?:put|post|delete|request)|fetch\(|runReadOnlySql|route\.fulfill|https?:\/\//)
  assert.match(source, /partial: true/)
  assert.match(source, /config\.target !== 'local'/)
  assert.match(source, /非只读 GET 被拒绝/)
})
