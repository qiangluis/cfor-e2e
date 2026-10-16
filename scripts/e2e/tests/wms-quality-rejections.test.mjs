import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiClient, serverApiFailures } from '../lib/api.mjs'
import { __internal, runCase } from '../suites/wms-quality.mjs'

const { rawCall, isBusinessRejection, runQc008WriteSide, runQc009WriteSide } = __internal
const businessCode = 1030401010
const retiredCode = 1030400002
const rejection = { code: businessCode, msg: 'Duplicate warehouse code' }
const qc008Rejection = { code: 500, msg: '启用库位前必须先启用库区' }
const caseRecord = () => ({ checks: [], notes: [], evidence: [] })

const apiHarness = (t, respond) => {
  const record = {
    api: [],
    consoleErrors: ['existing console error'],
    pageErrors: ['existing page error'],
    failedApiResponses: ['existing browser API error'],
    requestFailures: ['existing request failure']
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const reply = await respond(new URL(url), options)
    return new Response(JSON.stringify(reply.body), {
      status: reply.status || 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  return { api: createApiClient({ token: 'unit-token', tenantId: '1', record }), record }
}

const runReadProbe = (caseId, api, record, cr) => runCase(
  {
    caseId, page: {
      url: () => '/base/warehouseConfig/archives',
      locator: () => ({ isVisible: async () => true })
    }, record, caseRecord: cr, outputDir: '/unused-unit-output'
  },
  {
    login: async () => 'unit-token', createApiClient: () => api,
    openRoute: async () => {}, saveScreenshot: async () => {},
    warehouseRoute: '/base/warehouseConfig/archives',
    verifyLegacyWarehouse: async () => ({ covered: false })
  }
)

test('rawCall uses CommonResult 0 and Result 200 with explicit success true', async (t) => {
  let body
  const { api } = apiHarness(t, () => ({ body }))
  for (const payload of [{ code: 0, data: 'id' }, { code: 200, success: true, data: 'id' }]) {
    body = payload
    const result = await rawCall(() => api.post('/unit/probe', {}))
    assert.equal(result.ok, true)
    assert.equal(isBusinessRejection(result), false)
    assert.equal(result.data, 'id')
  }
  for (const payload of [{ code: 0, success: false }, { code: 200 }, { code: 200, success: false }]) {
    body = payload
    const result = await rawCall(() => api.post('/unit/probe', {}))
    assert.equal(result.ok, false)
    assert.equal(isBusinessRejection(result), false)
  }
})

test('explicit business rejection accepts valid code and msg or message', async () => {
  for (const payload of [
    rejection,
    { code: 400, msg: 'Warehouse and area do not match' },
    { code: businessCode, success: false, message: 'Location is referenced by an unfinished bill' }
  ]) {
    assert.equal(isBusinessRejection(payload), true)
    const result = await rawCall(async () => payload)
    assert.equal(result.ok, false)
    assert.equal(isBusinessRejection(result), true)
  }
})

test('missing, malformed, success and infrastructure responses are not business rejections', async () => {
  for (const payload of [
    undefined, null, {}, { code: businessCode }, { code: businessCode, msg: ' ' },
    { code: businessCode, msg: 123 }, { code: businessCode, message: {} },
    { code: String(businessCode), msg: 'Duplicate code' },
    { code: NaN, msg: 'Duplicate code' }, { code: Infinity, msg: 'Duplicate code' },
    { code: 1.5, msg: 'Duplicate code' }, { code: -1, msg: 'fetch failed' },
    { code: 0, msg: 'Duplicate code' }, { code: 200, success: true, msg: 'Duplicate code' },
    { code: businessCode, success: true, msg: 'Contradictory envelope' },
    ...[401, 403, 404, 405, 423, 429, 900, 901, 999].map((code) => ({ code, msg: 'Duplicate code' }))
  ]) {
    assert.equal(isBusinessRejection(payload), false, JSON.stringify(payload))
    assert.equal(isBusinessRejection(await rawCall(async () => payload)), false)
  }
  assert.equal(isBusinessRejection({ ...rejection, ok: true }), false)
})

test('HTTP 200 service error bodies cannot pass and remain runtime API failures', async (t) => {
  let body
  const { api, record } = apiHarness(t, () => ({ body }))
  const runtimeBefore = {
    consoleErrors: [...record.consoleErrors],
    pageErrors: [...record.pageErrors],
    failedApiResponses: [...record.failedApiResponses],
    requestFailures: [...record.requestFailures]
  }
  for (const code of [500, 501, 502, 503, 504, 599]) {
    body = { code, msg: 'Duplicate warehouse code' }
    const result = await rawCall(() => api.post('/unit/probe', {}))
    assert.equal(result.ok, false)
    assert.equal(isBusinessRejection(result), false)
    const entry = record.api.at(-1)
    assert.equal(entry.status, 200)
    assert.equal(entry.code, code)
    assert.deepEqual(serverApiFailures([entry]), [entry])
  }
  for (const [key, value] of Object.entries(runtimeBefore)) assert.deepEqual(record[key], value)
})

test('expected service-code business rejection is separated from runtime failure', async (t) => {
  let body = { code: 500, msg: '启用库位前必须先启用库区' }
  const { api, record } = apiHarness(t, () => ({ body }))
  const expected = {
    expectedBusinessRejection: {
      code: 500,
      message: '启用库位前必须先启用库区',
      allowServiceCode: true
    }
  }
  const matched = await rawCall((options) => api.put('/mes/wmsWareHouse/edit', {}, options), expected)
  assert.equal(matched.businessRejection, true)
  assert.equal(matched.expectedBusinessRejectionMatched, true)
  assert.deepEqual(serverApiFailures(record.api), [])

  body = { code: 500, msg: '其他服务错误' }
  const unmatched = await rawCall((options) => api.put('/mes/wmsWareHouse/edit', {}, options), expected)
  assert.equal(unmatched.businessRejection, false)
  assert.equal(unmatched.expectedBusinessRejectionMatched, false)
  assert.equal(serverApiFailures(record.api).length, 1)
})

test('system and service messages cannot be hidden behind a domain code or alternate message field', async () => {
  for (const message of [
    '系统异常', '系统发生了错误', '服务异常', '服务错误', '服务不可用', '内部错误',
    'Internal Server Error', 'Service Unavailable', 'Runtime Exception', 'SQLSyntaxErrorException'
  ]) {
    for (const payload of [
      { code: businessCode, msg: message },
      { code: businessCode, message },
      { code: businessCode, msg: 'Duplicate code', message }
    ]) {
      assert.equal(isBusinessRejection(payload), false)
      assert.equal(isBusinessRejection(await rawCall(async () => payload)), false)
    }
  }
})

test('HTTP 500 cannot turn a business-looking body into a passed rejection', async (t) => {
  const { api, record } = apiHarness(t, () => ({ status: 500, body: rejection }))
  let passed = false
  await assert.rejects(async () => {
    passed = isBusinessRejection(await rawCall(() => api.post('/unit/probe', {})))
  }, /HTTP 500/)
  assert.equal(passed, false)
  assert.equal(record.api[0].status, 500)
  assert.equal(record.api[0].code, businessCode)
  assert.deepEqual(serverApiFailures(record.api), record.api)
})

test('network and timeout exceptions propagate unchanged and retain runtime failures', async (t) => {
  let failure
  const { api, record } = apiHarness(t, () => { throw failure })
  for (const error of [new TypeError('fetch failed'), new DOMException('Timed out', 'TimeoutError')]) {
    failure = error
    let passed = false
    await assert.rejects(async () => {
      passed = isBusinessRejection(await rawCall(() => api.post('/unit/probe', {})))
    }, (caught) => caught === error)
    assert.equal(passed, false)
    assert.equal(record.api.at(-1).networkError, true)
    assert.deepEqual(serverApiFailures([record.api.at(-1)]), [record.api.at(-1)])
  }
})

test('response reading exceptions propagate unchanged rather than becoming rejections', async (t) => {
  const failure = new Error('Response stream failed')
  t.mock.method(globalThis, 'fetch', async () => ({
    status: 200,
    text: async () => { throw failure }
  }))
  const record = { api: [] }
  const api = createApiClient({ record })
  await assert.rejects(rawCall(() => api.post('/unit/probe', {})), (caught) => caught === failure)
  assert.equal(record.api[0].responseError, true)
  assert.deepEqual(serverApiFailures(record.api), record.api)
})

for (const [label, payload, expected] of [
  ['legal rejection', { code: 500, msg: '业务出入库类型不存在或已停用：CUSTOM' }, true],
  ['CommonResult success', { code: 0, msg: '业务出入库类型' }, false],
  ['Result success', { code: 200, success: true, message: '业务出入库类型' }, false],
  ['service error', { code: 500, msg: '业务出入库类型校验失败' }, false],
  ['unavailable service', { code: 503, msg: '业务出入库类型校验失败' }, false],
  ['system message', { code: businessCode, msg: '业务出入库类型：系统异常' }, false],
  ['unrelated business rejection', rejection, false]
]) {
  test(`QC-009 preserves its business type message assertion: ${label}`, async (t) => {
    const { api, record } = apiHarness(t, (url, options) => {
      if (options.method === 'POST') return { body: payload }
      if (url.pathname.endsWith('/core-types')) return { body: { code: 0, data: [{ code: '299', direction: 'OUT' }] } }
      if (url.pathname.endsWith('/dict-data/page')) return { body: { code: 0, data: { list: [{ value: 'CUSTOM' }] } } }
      return { body: { code: 0, data: { list: [] } } }
    })
    const cr = caseRecord()
    await runReadProbe('WMS-QC-009', api, record, cr)
    assert.equal(cr.checks.find((check) => check.name === '写侧拒绝不在字典中的企业业务类型').passed, expected)
  })
}

for (const [label, payload, expected] of [
  ['exact retirement rejection', { code: retiredCode, message: 'Warehouse write APIs are retired' }, true],
  ['different business code', rejection, false],
  ['service error', { code: 500, msg: 'Warehouse write APIs are retired' }, false],
  ['system message with exact code', { code: retiredCode, msg: '系统异常' }, false],
  ['success with exact code', { code: retiredCode, success: true, msg: 'Warehouse write APIs are retired' }, false]
]) {
  test(`QC-010 keeps the exact retirement code and a valid rejection: ${label}`, async (t) => {
    const { api, record } = apiHarness(t, (_url, options) => ({
      body: options.method === 'GET' ? { code: 0, data: { list: [{ id: '1', name: 'Warehouse' }] } } : payload
    }))
    const cr = caseRecord()
    await runReadProbe('WMS-QC-010', api, record, cr)
    const checks = cr.checks.filter((check) => check.name.endsWith('返回退役错误码'))
    assert.equal(checks.length, 4)
    assert.ok(checks.every((check) => check.passed === expected))
  })
}

test('QC-010 does not swallow transport failures into fabricated response objects', async (t) => {
  const failure = new TypeError('fetch failed')
  const { api, record } = apiHarness(t, (_url, options) => {
    if (options.method !== 'GET') throw failure
    return { body: { code: 0, data: { list: [] } } }
  })
  const cr = caseRecord()
  await assert.rejects(runReadProbe('WMS-QC-010', api, record, cr), (caught) => caught === failure)
  assert.equal(cr.checks.some((check) => check.name.endsWith('返回退役错误码') && check.passed), false)
  assert.equal(record.api.at(-1).networkError, true)
})

test('QC-008 write-side negatives accept only actual business rejections', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    for (const [payload, expected] of [
      [qc008Rejection, true], [{ code: 500, msg: 'Invalid warehouse switches' }, false],
      [{ code: 503, msg: 'Invalid warehouse switches' }, false],
      [{ code: 500, msg: '系统异常' }, false], [{ code: 200, success: true }, false]
    ]) {
      let warehouse
      const api = {
        post: async (_path, body) => {
          warehouse = { ...body, id: 'unit-warehouse', areaEnabled: false, locationEnabled: false }
          return { code: 200, success: true }
        },
        getBusiness: async () => ({ code: 0, data: [warehouse] }),
        get: async () => ({ code: 200, success: true, data: { ...warehouse } }),
        put: async (_path, body) => {
          if (body.areaEnabled === false && body.locationEnabled !== false) return payload
          Object.assign(warehouse, body)
          return { code: 0 }
        }
      }
      const cr = caseRecord()
      await runQc008WriteSide(api, cr)
      const negatives = cr.checks.filter((check) =>
        check.name.endsWith('被后端拒绝') ||
        check.name === '非法库区库位组合拒绝后仓库完整原值不变')
      assert.equal(negatives.length, 3)
      assert.ok(negatives.every((check) => check.passed === expected))
      assert.ok(cr.checks.filter((check) => !negatives.includes(check)).every((check) => check.passed))
    }
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

const qc009Fixture = () => ({
  token: 'E2E-WMS-RUN-QC009-UNIT',
  unit: { id: 'unit-1' },
  material: { id: 'material-1' },
  warehouse: { id: 'warehouse-1' },
  area: { id: 'area-1' },
  location: { id: 'location-1' }
})

const qc009Harness = (saveResponse = { code: 0, success: true }) => {
  const state = { dictionary: null, mapping: null, drafts: new Map(), calls: [] }
  const api = {
    postBusiness: async (path, body) => {
      state.calls.push({ method: 'POSTB', path, body })
      if (path === '/system/dict-data/create') {
        state.dictionary = { ...body, id: 'dict-1' }
        return { code: 0, data: 'dict-1' }
      }
      if (path === '/wms/business-io-type-rule/create') {
        state.mapping = { ...body, id: 'rule-1', direction: body.coreStockIoType === '101' ? 'IN' : 'OUT' }
        return { code: 0, data: 'rule-1' }
      }
      throw new Error(`unexpected postBusiness ${path}`)
    },
    putBusiness: async (path, body) => {
      state.calls.push({ method: 'PUTB', path, body })
      if (path === '/system/dict-data/update') state.dictionary = { ...state.dictionary, ...body }
      return { code: 0, data: true }
    },
    deleteBusiness: async (path) => {
      state.calls.push({ method: 'DELETEB', path })
      if (path.startsWith('/mes/stkIo/delete')) {
        state.drafts.delete(new URL(`http://unit${path}`).searchParams.get('id'))
      }
      if (path.startsWith('/wms/business-io-type-rule/delete')) state.mapping = null
      if (path.startsWith('/system/dict-data/delete')) state.dictionary = null
      return { code: 0, data: true }
    },
    getBusiness: async (path) => {
      state.calls.push({ method: 'GETB', path })
      if (path.startsWith('/system/dict-data/get')) return { code: 0, data: state.dictionary }
      if (path.startsWith('/wms/business-io-type-rule/core-types')) {
        return { code: 0, data: [{ code: '101', direction: 'IN' }, { code: '299', direction: 'OUT' }] }
      }
      if (path.startsWith('/wms/business-io-type-rule/get')) return { code: 0, data: state.mapping }
      if (path.startsWith('/wms/business-io-type-rule/page')) {
        return { code: 0, data: { list: state.mapping ? [state.mapping] : [] } }
      }
      if (path.startsWith('/mes/stkIo/list')) {
        const billNo = new URL(`http://unit${path}`).searchParams.get('billNo')
        return {
          code: 0,
          data: { list: [...state.drafts.values()].filter((draft) => !billNo || draft.billNo === billNo) }
        }
      }
      if (path.startsWith('/mes/stkIo/queryById')) {
        const id = new URL(`http://unit${path}`).searchParams.get('id')
        return { code: 0, data: state.drafts.get(id) || null }
      }
      if (path.startsWith('/mes/stkIo/queryEntryByMainId')) {
        const id = new URL(`http://unit${path}`).searchParams.get('id')
        const draft = state.drafts.get(id)
        return { code: 0, data: draft ? [{ stockIoDirection: draft.stockIoDirection }] : [] }
      }
      throw new Error(`unexpected getBusiness ${path}`)
    },
    post: async (path, body, options) => {
      state.calls.push({ method: 'POST', path, body, options })
      if (path !== '/mes/stkIo/add/save') throw new Error(`unexpected post ${path}`)
      if (body.businessTypeCode.includes('ILLEGAL')) {
        return { code: 500, msg: `业务出入库类型不存在或已停用：${body.businessTypeCode}` }
      }
      if (state.mapping && body.stockIoType === '299') {
        return { code: 500, msg: `业务出入库类型【${state.mapping.businessTypeName}】的库存方向与当前单据不一致，请选择对应方向的类型` }
      }
      if (saveResponse.code !== 0 && !(saveResponse.code === 200 && saveResponse.success === true)) {
        return saveResponse
      }
      const id = `draft-${state.drafts.size + 1}`
      state.drafts.set(id, {
        id,
        billNo: body.billNo,
        remark: body.remark,
        businessTypeCode: body.businessTypeCode,
        businessTypeName: state.dictionary.label,
        stockIoType: state.mapping ? state.mapping.coreStockIoType : body.stockIoType,
        stockIoDirection: state.mapping ? '1' : body.stkIoEntryList?.[0]?.stockIoDirection
      })
      return { code: 0, success: true }
    },
    get: async (path) => {
      state.calls.push({ method: 'GET', path })
      if (path.startsWith('/mes/stkIo/queryById') || path.startsWith('/system/dict-data/get')) {
        return { code: 500, data: null, msg: '未找到对应数据' }
      }
      throw new Error(`unexpected get ${path}`)
    }
  }
  return { api, state }
}

test('QC-009 completes the unmapped dictionary formal draft snapshot and cleanup contract', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    const { api, state } = qc009Harness()
    const record = caseRecord()
    const result = await runQc009WriteSide(api, record, {
      prepareWmsFixture: async () => qc009Fixture(),
      inventorySnapshot: async () => [{ id: 'inventory-1', materialId: 'material-1', qty: 106 }]
    })
    assert.equal(result.covered, true)
    assert.equal(record.checks.every((check) => check.passed), true)
    assert.deepEqual(record.catalogAssertions.map((row) => row.status), [
      'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED'
    ])
    const save = state.calls.find((call) => call.method === 'POST' && call.path === '/mes/stkIo/add/save')
    assert.equal(save.body.businessTypeCode.startsWith('E2E_WMS_QC009_'), true)
    assert.equal(save.body.stockIoType, '106')
    assert.equal(save.body.stkIoEntryList[0].stockIoDirection, '1')
    assert.ok(state.calls.some((call) => call.method === 'PUTB' && call.body.status === 1))
    assert.ok(state.calls.some((call) => call.method === 'DELETEB' && call.path.startsWith('/mes/stkIo/delete')))
    assert.ok(state.calls.some((call) => call.method === 'POSTB' && call.path === '/wms/business-io-type-rule/create' && call.body.active === true))
    assert.ok(state.calls.some((call) => call.method === 'GETB' && call.path.startsWith('/wms/business-io-type-rule/get')))
    assert.ok(state.calls.some((call) => call.method === 'DELETEB' && call.path.startsWith('/wms/business-io-type-rule/delete')))
    assert.ok(state.calls.some((call) => call.method === 'DELETEB' && call.path.startsWith('/system/dict-data/delete')))
    assert.ok(record.checks.some((check) => check.name.includes('方向不一致') && check.details.includes('rows=0')))
    assert.ok(record.checks.some((check) => check.name.includes('非法企业业务类型') && check.details.includes('rows=0')))
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

test('QC-009 reports a backend defect when formal save still requires a mapping rule', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  try {
    const { api } = qc009Harness({ code: 500, msg: '业务出入库类型未配置映射规则：E2E_WMS_QC009_UNIT' })
    const record = caseRecord()
    const result = await runQc009WriteSide(api, record, {
      prepareWmsFixture: async () => qc009Fixture(),
      inventorySnapshot: async () => []
    })
    assert.equal(result.covered, false)
    assert.equal(result.backendMappingRequired, true)
    assert.ok(record.notes.some((note) => note.includes('后端真实缺陷')))
    assert.equal(record.checks.find((check) => check.name === '合法未映射企业业务类型可正式保存出入库草稿').passed, false)
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})
