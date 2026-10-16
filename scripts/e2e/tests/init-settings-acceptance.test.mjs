import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import {
  applyInitCatalogEvidence,
  canonicalBusinessOptionCatalog,
  finalizeInitCaseResult,
  INIT_CASE_CATALOG_EVIDENCE,
  INIT_SETTINGS_CATALOG_ASSERTIONS,
  initSettingsConfigSnapshotSql,
  isUnknownBusinessOptionCreateRejection,
  PARTNER_LEVEL_SCOPE_LABELS,
  assertLocalPartnerLevelWriteScope,
  runCase,
  sameBusinessOptionCatalog,
  validateBusinessOptionCatalog,
  validateInitSettingsConfigSnapshot,
  validateInitSettingsEffectiveValues,
  validatePartnerLevelScopePageEvidence
} from '../suites/init.mjs'

const copy = (value) => structuredClone(value)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const rowHash = hash('unchanged-complete-row')
const response = (payload, {
  status = 200, url = 'http://127.0.0.1:48083/admin-api/test', method = 'GET'
} = {}) => ({
  status: () => status,
  ok: () => status >= 200 && status < 300,
  headers: () => ({}),
  json: async () => copy(payload),
  text: async () => JSON.stringify(payload),
  url: () => url,
  request: () => ({ method: () => method })
})
const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const caseDefinition = (caseId) => catalog.suites.flatMap((suite) => suite.cases)
  .find((item) => item.id === caseId)
const passingRecord = (caseId) => ({
  checks: [...new Set(Object.values(INIT_CASE_CATALOG_EVIDENCE[caseId])
    .flatMap((item) => item.checks))].map((name) =>
    ({ name, passed: true, details: 'mock-only evidence' }))
})

for (const caseId of ['PB033-002', 'PB028-001']) {
  test(`${caseId}: mapping retains every frozen catalog assertion and exact index`, () => {
    const definition = caseDefinition(caseId)
    const mapping = INIT_CASE_CATALOG_EVIDENCE[caseId]
    assert.deepEqual(definition.assertions, INIT_SETTINGS_CATALOG_ASSERTIONS[caseId])
    assert.deepEqual(Object.keys(mapping), definition.assertions.map((_, index) => String(index)))
    for (const [index, original] of definition.assertions.entries()) {
      assert.equal(mapping[index].assertion, original)
      assert.ok(mapping[index].checks.length > 0)
    }
    const record = passingRecord(caseId)
    applyInitCatalogEvidence(record, caseId, mapping)
    assert.equal(record.acceptanceComplete, true)
    assert.deepEqual(record.catalogAssertions.map((item) => item.assertion), definition.assertions)
    assert.deepEqual(record.catalogAssertions.map((item) => item.index),
      definition.assertions.map((_, index) => index))
    assert.equal(finalizeInitCaseResult(record, caseId, {}).partial, false)
  })

  test(`${caseId}: any missing, false, non-boolean or duplicate evidence blocks completion`, () => {
    const names = passingRecord(caseId).checks.map((check) => check.name)
    for (const name of names) {
      for (const failure of ['missing', false, undefined, 'true', 1, null, 'duplicate']) {
        const record = passingRecord(caseId)
        const check = record.checks.find((item) => item.name === name)
        if (failure === 'missing') record.checks = record.checks.filter((item) => item.name !== name)
        else if (failure === 'duplicate') record.checks.push({ ...check })
        else check.passed = failure
        applyInitCatalogEvidence(record, caseId, INIT_CASE_CATALOG_EVIDENCE[caseId])
        assert.equal(record.acceptanceComplete, false, `${name}: ${String(failure)}`)
        assert.ok(record.remainingAssertions.length > 0)
      }
    }
  })

  test(`${caseId}: weakened text, shifted index and extra mappings cannot verify assertions`, () => {
    const mapping = INIT_CASE_CATALOG_EVIDENCE[caseId]
    const variants = [
      { ...mapping, 0: { ...mapping[0], assertion: '仅页面标题存在' } },
      { ...mapping, 0: { checks: mapping[0].checks } },
      { ...mapping, 99: { assertion: 'extra', checks: [mapping[0].checks[0]] } },
      { ...mapping, 0: mapping[1], 1: mapping[0] },
      { ...mapping, 0: { ...mapping[0], checks: [] } },
      { ...mapping, 0: { ...mapping[0], checks: [mapping[0].checks[0], mapping[0].checks[0]] } }
    ]
    for (const weakened of variants) {
      const record = passingRecord(caseId)
      applyInitCatalogEvidence(record, caseId, weakened)
      assert.equal(record.acceptanceComplete, false)
      assert.ok(record.remainingAssertions.length > 0)
    }
  })
}

const partner = (scope, id = '1888888888888888888') => ({
  id, code: `LEVEL_${scope}`, name: `${scope} sample`, scope, status: 1
})
const scopePage = (scope = 'CUSTOMER') => ({
  responseStatus: 200,
  responseUrl: `http://127.0.0.1:48083/admin-api/base/partner-level/page?pageNo=1&pageSize=100&scope=${scope}`,
  scope,
  payload: { code: 0, data: { list: [partner(scope)], total: 1 } },
  renderedRows: [{
    code: partner(scope).code, name: partner(scope).name, scopeText: PARTNER_LEVEL_SCOPE_LABELS[scope]
  }]
})

test('PB033-002: all three scoped page responses need actual matching visible rows', () => {
  for (const scope of Object.keys(PARTNER_LEVEL_SCOPE_LABELS)) {
    assert.equal(validatePartnerLevelScopePageEvidence(scopePage(scope)).valid, true)
  }
})

test('PB033-002: HTTP200, count, title, blank rows and stale/cross-scope data are insufficient', () => {
  const variants = [
    { ...scopePage(), responseStatus: 500 },
    { ...scopePage(), responseUrl: '/admin-api/base/partner-level/simple-list?scope=CUSTOMER' },
    { ...scopePage(), responseUrl: '/admin-api/base/partner-level/page?pageNo=1&pageSize=100&scope=BOTH' },
    { ...scopePage(), responseUrl: '/admin-api/base/partner-level/page?pageNo=2&pageSize=100&scope=CUSTOMER' },
    { ...scopePage(), responseUrl: '/admin-api/base/partner-level/page?pageNo=1&pageSize=101&scope=CUSTOMER' },
    { ...scopePage(), payload: { code: 500, data: scopePage().payload.data } },
    { ...scopePage(), payload: { code: 0, data: { list: [], total: 0 } }, renderedRows: [] },
    { ...scopePage(), payload: { code: 0, data: { list: Array(1), total: 1 } },
      renderedRows: Array(1) },
    { ...scopePage(), payload: { code: 0, data: { list: [{}], total: 1 } } },
    { ...scopePage(), payload: { code: 0, data: { list: [partner('BOTH')], total: 1 } } },
    { ...scopePage(), payload: { code: 0, data: { list: [partner('CUSTOMER')], total: -1 } } },
    { ...scopePage(), renderedRows: [] },
    { ...scopePage(), renderedRows: [{ code: '', name: '', scopeText: '客户' }] },
    { ...scopePage(), renderedRows: [{ ...scopePage().renderedRows[0], code: 'STALE_LEVEL' }] },
    { ...scopePage(), renderedRows: [{ ...scopePage().renderedRows[0], name: 'STALE_NAME' }] },
    { ...scopePage(), renderedRows: [{ ...scopePage().renderedRows[0], scopeText: '供应商' }] }
  ]
  for (const evidence of variants) {
    assert.equal(validatePartnerLevelScopePageEvidence(evidence).valid, false)
  }
  const duplicate = scopePage()
  duplicate.payload.data.list.push(copy(duplicate.payload.data.list[0]))
  duplicate.payload.data.total = 2
  duplicate.renderedRows.push(copy(duplicate.renderedRows[0]))
  assert.equal(validatePartnerLevelScopePageEvidence(duplicate).valid, false)
})

const optionsFixture = () => [
  {
    optionCode: 'ERP.SALES.BOM_DEFAULT_EXPAND', moduleCode: 'erp', name: '销售 BOM 默认展开',
    ownerType: 'SYSTEM_CONFIG', runtimeConsumer: 'ErpSaleOrderServiceImpl',
    category: 'sales', tag: 'bom', valueType: 'BOOLEAN',
    defaultValue: 'false', currentValue: 'true', currentValueSource: 'TENANT',
    manageable: true, irreversibleAfterBusiness: false
  },
  {
    optionCode: 'ERP.PURCHASE.RECONCILIATION_SLA', moduleCode: 'erp', name: '采购对账 SLA',
    ownerType: 'SYSTEM_CONFIG', runtimeConsumer: 'ErpPurchaseReconciliationSlaCalculator',
    category: 'purchase', tag: 'reconciliationSla', valueType: 'POLICY',
    defaultValue: '{"workingDays":3}', currentValue: '{"workingDays":3}', currentValueSource: 'TEMPLATE',
    manageable: true, irreversibleAfterBusiness: false
  },
  {
    optionCode: 'ERP.PURCHASE.RECEIPT_TOLERANCE', moduleCode: 'erp', name: '采购超收默认策略',
    ownerType: 'SYSTEM_CONFIG', runtimeConsumer: 'ErpPurchaseInServiceImpl',
    category: 'purchase', tag: 'receiptTolerance', valueType: 'POLICY',
    defaultValue: '{"enabled":false,"rate":0}', currentValue: '{"enabled":false,"rate":0}',
    currentValueSource: 'DEFAULT', manageable: true, irreversibleAfterBusiness: true
  },
  {
    optionCode: 'ERP.BARCODE.SCHEME', moduleCode: 'erp', name: '条码方案',
    ownerType: 'DOMAIN_MODEL', runtimeConsumer: 'erp_barcode_scheme',
    category: null, tag: null, valueType: 'ENTRY', defaultValue: null,
    currentValue: null, currentValueSource: 'DOMAIN_MODEL', manageable: false
  },
  {
    optionCode: 'MES.APS.CONSTRAINTS', moduleCode: 'mes', name: 'APS 排产约束',
    ownerType: 'DOMAIN_MODEL', runtimeConsumer: 'aps_scheduling_constraints',
    category: null, tag: null, valueType: 'ENTRY', defaultValue: null,
    currentValue: null, currentValueSource: 'DOMAIN_MODEL', manageable: false
  }
]
const configFixture = () => [
  ['1', '0', 'sales', 'bom', hash('false'), rowHash],
  ['2', '0', 'purchase', 'reconciliationSla', hash('{"workingDays":3}'), rowHash],
  ['3', '1', 'sales', 'bom', hash('true'), rowHash]
]

test('PB028-001: entire catalog compares all fields and added fields, not only row count', () => {
  const before = optionsFixture()
  assert.equal(sameBusinessOptionCatalog(before, copy(before).reverse()), true)
  assert.equal(sameBusinessOptionCatalog(before, before.map((item) =>
    Object.fromEntries(Object.entries(item).reverse()))), true)
  for (const field of Object.keys(before[0])) {
    const after = copy(before)
    after[0][field] = `${after[0][field]}-changed`
    assert.equal(sameBusinessOptionCatalog(before, after), false, field)
  }
  const replacement = copy(before)
  replacement[4].optionCode = 'MES.MRP.CONSTRAINTS'
  assert.equal(replacement.length, before.length)
  assert.equal(sameBusinessOptionCatalog(before, replacement), false)
  const futureField = copy(before)
  futureField[0].newContractField = { nested: 'changed' }
  assert.equal(sameBusinessOptionCatalog(before, futureField), false)
  for (const invalid of [null, {}, [null], Array(2)]) {
    assert.equal(canonicalBusinessOptionCatalog(invalid), null)
    assert.equal(sameBusinessOptionCatalog(before, invalid), false)
  }
})

test('PB028-001: exact stable codes, supported owners and named runtime consumers are mandatory', () => {
  assert.equal(validateBusinessOptionCatalog(optionsFixture()).valid, true)
  for (const field of ['optionCode', 'ownerType', 'runtimeConsumer', 'moduleCode', 'name']) {
    const items = optionsFixture()
    delete items[0][field]
    assert.equal(validateBusinessOptionCatalog(items).valid, false, field)
  }
  const duplicate = optionsFixture()
  duplicate.push(copy(duplicate[0]))
  assert.equal(validateBusinessOptionCatalog(duplicate).valid, false)
  for (const invalid of [[], null, [{}], [{ optionCode: 'free-form title' }], Array(2)]) {
    assert.equal(validateBusinessOptionCatalog(invalid).valid, false)
  }
})

test('PB028-001: effective values must match tenant first, template fallback and actual defaults', () => {
  assert.equal(validateInitSettingsEffectiveValues(optionsFixture(), configFixture(), '1'), true)
  for (const change of [
    (items) => { items[0].currentValue = 'false' },
    (items) => { items[0].currentValueSource = 'TEMPLATE' },
    (items) => { items[1].currentValueSource = 'TENANT' },
    (items) => { items[2].currentValue = '{"enabled":true,"rate":99}' },
    (items) => { items[2].currentValueSource = 'TENANT' },
    (items) => { items[0].tag = 'other' },
    (items) => { items[0].category = 'other' }
  ]) {
    const items = optionsFixture()
    change(items)
    assert.equal(validateInitSettingsEffectiveValues(items, configFixture(), '1'), false)
  }
  assert.equal(validateInitSettingsEffectiveValues([], configFixture(), '1'), false)
  assert.equal(validateInitSettingsEffectiveValues(optionsFixture(), [], '1'), false)
})

test('PB028-001: config snapshots forbid invalid rows, ambiguous source addresses and foreign tenants', () => {
  assert.equal(validateInitSettingsConfigSnapshot(configFixture(), '1'), true)
  for (const invalid of [
    null, Array(1), [[]], [['1', '1', 'sales', 'bom', 'broken', rowHash]],
    [['1', '2', 'sales', 'bom', hash('true'), rowHash]],
    [...configFixture(), copy(configFixture()[0])],
    [...configFixture(), ['4', '0', 'sales', 'bom', hash('true'), rowHash]]
  ]) assert.equal(validateInitSettingsConfigSnapshot(invalid, '1'), false)
  const sql = initSettingsConfigSnapshotSql('1')
  assert.match(sql, /FROM system_config WHERE tenant_id IN \(0,1\)/)
  assert.match(sql, /JSON_ARRAY\(CAST\(id AS CHAR\),CAST\(tenant_id AS CHAR\),\s+category,tag,config_data\)/)
  assert.match(sql, /ORDER BY tenant_id,id/)
  assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE|COUNT\(/i)
  assert.throws(() => initSettingsConfigSnapshotSql('1 OR 1=1'))
})

test('PB028-001: missing endpoint rejection is precise, not permission denial or generic server failure', () => {
  const exact = '请求地址不存在:/admin-api/system/config/business-options/create'
  assert.equal(isUnknownBusinessOptionCreateRejection(response({}, { status: 200 }),
    { code: 404, msg: exact }), true)
  assert.equal(isUnknownBusinessOptionCreateRejection(response({}, { status: 404 }),
    { code: 404, msg: '请求地址不存在:admin-api/system/config/business-options/create' }), true)
  for (const [status, payload] of [
    [500, { code: 404, msg: exact }],
    [403, { code: 403, msg: '没有权限' }],
    [200, { code: 500, msg: exact }],
    [200, { code: 404, msg: '请求地址不存在:/admin-api/unrelated/create' }],
    [200, { code: 404, msg: '请求地址不存在' }],
    [200, { code: 404, msg: exact, success: true }],
    [200, { code: 0, msg: exact, data: 'created' }]
  ]) assert.equal(isUnknownBusinessOptionCreateRejection(response({}, { status }), payload), false)
})

function harness (caseId, settings = {}) {
  const calls = {
    requests: [], navigation: [], clicks: [], snapshots: [], waits: [], events: [], login: 0
  }
  let currentUrl = 'http://127.0.0.1:9151/index'
  let selected
  let wait
  let tableRows = []
  let listReads = 0
  let snapshotReads = 0
  let partnerPageReads = 0
  let createdRow
  let deletedRow
  const options = settings.options || optionsFixture()
  const scoped = Object.fromEntries(Object.keys(PARTNER_LEVEL_SCOPE_LABELS)
    .map((scope) => [scope, [partner(scope)]]))
  if (settings.emptyScope) scoped[settings.emptyScope] = []
  const pageResponse = (scope) => {
    const list = copy(scoped[scope])
    if (settings.crossScope && scope === 'CUSTOMER') list[0].scope = 'SUPPLIER'
    return response({ code: settings.pageCode ?? 0, data: { list, total: list.length } }, {
      status: settings.pageStatus ?? 200,
      url: `http://127.0.0.1:48083/admin-api/base/partner-level/page?pageNo=1&pageSize=100&scope=${scope}`
    })
  }
  const locator = (selector, kind) => ({
    first: () => locator(selector, kind),
    filter: () => locator(selector, kind),
    locator: (child) => locator(`${selector} ${child}`, kind),
    isVisible: async () => !settings.hiddenControls,
    count: async () => 1,
    getByRole: (role, { name }) => locator(selector, { role, name, option: true }),
    evaluateAll: async () => copy(tableRows),
    click: async () => {
      calls.clicks.push(kind?.name || selector)
      if (kind?.option) {
        if (kind.name === '采购与销售') {
          selected = 'erp'
          const items = copy(options.filter((item) => item.moduleCode === 'erp'))
          if (settings.pageOptionsChanged) items[0].currentValue = 'changed'
          const payload = { code: settings.pageCode ?? 0, data: items }
          tableRows = items.map((item) => [
            item.name, '采购与销售',
            item.ownerType === 'DOMAIN_MODEL' ? '领域配置'
              : item.valueType === 'BOOLEAN' ? item.currentValue === 'true' ? '已启用' : '未启用'
                : item.currentValue,
            ({ TENANT: '企业配置', TEMPLATE: '平台模板', DEFAULT: '默认值',
              DOMAIN_MODEL: '领域设置' })[item.currentValueSource]
          ])
          if (settings.staleTable) tableRows[0][2] = 'STALE_VALUE'
          wait?.(response(payload, { status: settings.pageStatus ?? 200,
            url: 'http://127.0.0.1:48083/admin-api/system/config/business-options/list?moduleCode=erp' }))
        } else selected = Object.keys(PARTNER_LEVEL_SCOPE_LABELS)
          .find((scope) => PARTNER_LEVEL_SCOPE_LABELS[scope] === kind.name)
      } else if (kind?.name === '查询') {
        tableRows = scoped[selected].map((item) => [item.code, item.name,
          PARTNER_LEVEL_SCOPE_LABELS[item.scope]])
        if (settings.staleTable && tableRows.length > 0) tableRows[0][0] = 'STALE_CODE'
        wait?.(pageResponse(selected))
      } else if (/新增|编辑|保存|删除|启用|停用/.test(kind?.name || '')) {
        throw new Error(`禁止表单或写侧点击：${kind.name}`)
      }
    }
  })
  const page = {
    url: () => currentUrl,
    locator: (selector) => locator(selector),
    getByText: (name) => locator('text', { name }),
    getByRole: (role, { name }) => locator('role', { role, name }),
    waitForResponse: (predicate) => new Promise((resolve) => {
      wait = (actual) => {
        assert.equal(predicate(actual), true)
        resolve(actual)
      }
    }),
    waitForFunction: async (_fn, expected) => {
      calls.waits.push(copy(expected))
      assert.equal(tableRows.length, expected.length)
      assert.ok(tableRows.every((row, index) => expected[index]
        .every((cell, column) => row[column] === cell)), 'stale rendered table')
    }
  }
  const context = {
    caseId, page,
    caseRecord: { checks: [], notes: [], evidence: [], database: [] },
    record: { api: [] }
  }
  const localWriteConfig = {
    target: settings.target || 'local',
    tenantId: settings.configTenantId || '1',
    tenantName: settings.configTenantName || 'CFOR 标准平台',
    webBase: settings.webBase || 'http://127.0.0.1:9151',
    apiBase: settings.apiBase || 'http://127.0.0.1:48083',
    db: {
      host: '127.0.0.1',
      port: '3306',
      name: settings.dbName || 'cfor_admin_standard',
      user: 'root'
    }
  }
  const dependencies = {
    tenantId: '1',
    authToken: 'mock-token',
    config: localWriteConfig,
    writeFixturesEnabled: settings.writeFixturesEnabled === true,
    loginWithCredentials: async () => {
      calls.login++
      calls.events.push('login')
      return 'mock-token'
    },
    openRoute: async (_page, route) => {
      calls.navigation.push(route)
      currentUrl = `http://127.0.0.1:9151${route}`
    },
    readDb: async (_record, stage, sql) => {
      calls.events.push(`snapshot:${stage}`)
      calls.snapshots.push({ stage, sql })
      snapshotReads++
      if (settings.noDb) return null
      if (caseId === 'PB033-002') {
        const rows = [['1888888888888888888', settings.dbChanged && snapshotReads > 1
          ? hash('changed-row') : rowHash, '0']]
        if (createdRow && snapshotReads > 1) {
          rows.push([createdRow.id, rowHash, '0'])
        }
        if (deletedRow && snapshotReads > 1) {
          rows.push([deletedRow.id, rowHash, '1'])
        }
        return rows
      }
      const rows = copy(settings.configs || configFixture())
      if (settings.dbChanged && snapshotReads > 1) rows[0][5] = hash('changed-row')
      return rows
    },
    assertWriteSafety: async (caseRecord) => {
      calls.events.push('write-safety')
      caseRecord.database.push({
        stage: 'write-preflight',
        available: true,
        rows: [['failed-migrations', '0'], ['enabled-jobs', '0'], ['active-triggers', '0'],
          ['active-database-writers', '0']]
      })
    },
    request: async (_page, method, path, init) => {
      calls.requests.push({ method, path, init })
      if (method === 'get' && path.startsWith('/admin-api/base/partner-level/page?')) {
        calls.events.push(`partner-page:${path.includes('code=') ? 'fixture' : 'scope'}`)
        const url = new URL(`http://127.0.0.1:48083${path}`)
        const code = url.searchParams.get('code')
        partnerPageReads++
        let rows = copy(scoped.BOTH)
        if (code) rows = rows.filter((row) => row.code === code)
        if (settings.existingSample && code) {
          rows = [{
            id: '7001',
            code,
            name: `${code} existing`,
            scope: 'BOTH',
            status: 1,
            remark: 'shared sample'
          }]
        }
        if (settings.readbackFailure && createdRow && code === createdRow.code &&
            partnerPageReads === 2) rows = []
        return response({ code: 0, data: { list: rows, total: rows.length } }, {
          url: `http://127.0.0.1:48083${path}`
        })
      }
      if (path.includes('get-permission-info')) {
        const menus = settings.noMenu ? [] : [
          { path: settings.partnerRoute || '/settings/erp/partner-level',
            component: 'base/partnerLevel/index' },
          { path: '/settings/system-options', component: 'system/business-options/index' }
        ]
        return response({ code: 0, data: { menus } })
      }
      if (method === 'get' && path.includes('business-options/list')) {
        listReads++
        const items = copy(options)
        if (settings.catalogChanged && listReads > 1) items[0].runtimeConsumer = 'changed-consumer'
        if (settings.unfilteredChanged && listReads > 1) items[4].runtimeConsumer = 'changed-mes'
        return response({ code: settings.catalogCode ?? 0, data: items },
          { status: settings.catalogStatus ?? 200 })
      }
      if (method === 'post' && path === '/admin-api/base/partner-level/create') {
        if (settings.createFailure) {
          return response({ code: 500, msg: 'mock create failure' }, { method: 'POST' })
        }
        createdRow = {
          id: '9001',
          code: init.data.code,
          name: init.data.name,
          scope: init.data.scope,
          sort: init.data.sort,
          status: init.data.status,
          remark: init.data.remark
        }
        scoped.BOTH.push(copy(createdRow))
        return response({ code: 0, data: createdRow.id }, { method: 'POST' })
      }
      if (method === 'delete' && path.startsWith('/admin-api/base/partner-level/delete?id=')) {
        if (settings.cleanupFailure) {
          return response({ code: 500, msg: 'mock cleanup failure' }, { method: 'DELETE' })
        }
        const id = new URL(`http://127.0.0.1:48083${path}`).searchParams.get('id')
        const index = scoped.BOTH.findIndex((row) => String(row.id) === id)
        if (index >= 0) {
          deletedRow = { ...scoped.BOTH[index] }
          scoped.BOTH.splice(index, 1)
        }
        createdRow = null
        return response({ code: 0, data: true }, { method: 'DELETE' })
      }
      if (method === 'post' && path === '/admin-api/system/config/business-options/create') {
        assert.match(init.data.optionCode, /^ERP\.E2E\.UNKNOWN\./)
        assert.equal(init.data.ownerType, 'SYSTEM_CONFIG')
        return response(settings.rejection || {
          code: 404, msg: '请求地址不存在:/admin-api/system/config/business-options/create'
        }, { status: settings.rejectionStatus ?? 200, method: 'POST' })
      }
      if (method === 'get' && path === '/admin-api/base/partner-level/simple-list?scope=BOTH') {
        return response({ code: 0, data: copy(scoped.BOTH) })
      }
      throw new Error(`unexpected or forbidden request ${method} ${path}`)
    }
  }
  return { context, dependencies, calls }
}

test('PB033-002: full mock suite wires exact page queries and readbacks without any directory writes', async () => {
  const { context, dependencies, calls } = harness('PB033-002')
  const result = await runCase(context, dependencies)
  assert.equal(result.acceptanceComplete, true)
  assert.equal(result.partial, false)
  assert.equal(calls.login, 1)
  assert.deepEqual(calls.navigation, ['/settings/erp/partner-level'])
  assert.equal(calls.clicks.filter((name) => name === '查询').length, 3)
  assert.equal(calls.snapshots.length, 2)
  assert.ok(calls.requests.every((item) => item.method === 'get'))
  assert.ok(calls.clicks.every((name) => !/新增|编辑|保存|删除|启用|停用/.test(name)))
  assert.deepEqual(context.caseRecord.catalogAssertions.map((item) => item.assertion),
    caseDefinition('PB033-002').assertions)
})

test('PB033-002: opt-in creates an owned BOTH/status=1 row, proves it in page/simple-list, then cleans it', async () => {
  const { context, dependencies, calls } = harness('PB033-002', { writeFixturesEnabled: true })
  const result = await runCase(context, dependencies)
  const fixture = context.caseRecord.fixtures?.[0]
  assert.equal(result.acceptanceComplete, true)
  assert.equal(result.partial, false)
  assert.equal(fixture?.createdThisRun, true)
  assert.match(fixture?.id, /^[1-9]\d*$/)
  assert.equal(fixture?.scope, 'BOTH')
  assert.equal(fixture?.status, 1)
  assert.equal(fixture?.cleanup, 'DELETED_VERIFIED')
  assert.equal(calls.events.indexOf('write-safety') < calls.events.indexOf('snapshot:partner-level-before'), true)
  assert.equal(calls.requests.filter((item) =>
    item.method === 'post' && item.path === '/admin-api/base/partner-level/create').length, 1)
  assert.equal(calls.requests.filter((item) =>
    item.method === 'delete' && item.path.includes('/admin-api/base/partner-level/delete?id=')).length, 1)
  assert.ok(calls.snapshots.every((item) => /FROM base_partner_level/.test(item.sql)))
  assert.ok(calls.snapshots.every((item) => /CAST\(deleted AS UNSIGNED\)/.test(item.sql)))
  assert.ok(context.caseRecord.checks.some((item) =>
    item.name === '本轮专属 BOTH 启用等级创建后精确回读' && item.passed === true))
  assert.ok(context.caseRecord.checks.some((item) =>
    item.name === '本轮专属等级清理后分页不可见' && item.passed === true))
})

test('PB033-002: closed opt-in remains read-only and an empty BOTH scope stays a genuine gap', async () => {
  const { context, dependencies, calls } = harness('PB033-002', {
    emptyScope: 'BOTH',
    writeFixturesEnabled: false
  })
  const result = await runCase(context, dependencies)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.partial, true)
  assert.equal(calls.events.includes('write-safety'), false)
  assert.equal(calls.requests.some((item) => ['post', 'put', 'delete'].includes(item.method)), false)
  assert.equal(context.caseRecord.fixtures, undefined)
})

test('PB033-002: write target guard blocks remote, wrong tenant, wrong database and non-loopback endpoints', () => {
  const valid = {
    target: 'local',
    tenantId: '1',
    tenantName: 'CFOR 标准平台',
    webBase: 'http://127.0.0.1:9151',
    apiBase: 'http://127.0.0.1:48083',
    db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard', user: 'root' }
  }
  assert.doesNotThrow(() => assertLocalPartnerLevelWriteScope(valid, {
    tenantId: '1', token: 'mock-token'
  }))
  for (const settings of [
    { target: 'remote' },
    { tenantId: '2' },
    { db: { ...valid.db, name: 'cfor_admin_saas' } },
    { apiBase: 'https://jixu-ai.com' },
    { webBase: 'http://127.0.0.1:9152' }
  ]) {
    assert.throws(() => assertLocalPartnerLevelWriteScope({ ...valid, ...settings }, {
      tenantId: settings.tenantId || '1', token: 'mock-token'
    }), /BLOCKED: PB033-002/)
  }
  assert.throws(() => assertLocalPartnerLevelWriteScope(valid, {
    tenantId: '1', token: ''
  }), /BLOCKED: PB033-002/)
})

test('PB033-002: create failure does not attempt cleanup or claim a fixture', async () => {
  const { context, dependencies, calls } = harness('PB033-002', {
    writeFixturesEnabled: true,
    createFailure: true
  })
  await assert.rejects(runCase(context, dependencies), /本轮专属 BOTH 启用等级创建返回精确 ID/)
  assert.equal(calls.requests.filter((item) => item.method === 'post' &&
    item.path === '/admin-api/base/partner-level/create').length, 1)
  assert.equal(calls.requests.filter((item) => item.method === 'delete').length, 0)
  assert.ok(context.caseRecord.checks.some((item) =>
    item.name === '本轮专属 BOTH 启用等级创建返回精确 ID' && item.passed === false))
})

test('PB033-002: create readback failure still cleans only the owned ID and records the failed readback', async () => {
  const { context, dependencies, calls } = harness('PB033-002', {
    writeFixturesEnabled: true,
    readbackFailure: true
  })
  await assert.rejects(runCase(context, dependencies), /本轮专属 BOTH 启用等级创建后精确回读/)
  assert.equal(calls.requests.filter((item) => item.method === 'delete' &&
    item.path.includes('/admin-api/base/partner-level/delete?id=')).length, 1)
  assert.equal(context.caseRecord.fixtures?.[0]?.cleanup, 'DELETED_VERIFIED')
  assert.ok(context.caseRecord.checks.some((item) =>
    item.name === '本轮专属 BOTH 启用等级创建后精确回读' && item.passed === false))
})

test('PB033-002: cleanup failure is surfaced and the fixture is marked not cleaned', async () => {
  const { context, dependencies, calls } = harness('PB033-002', {
    writeFixturesEnabled: true,
    cleanupFailure: true
  })
  await assert.rejects(runCase(context, dependencies), /mock cleanup failure/)
  assert.equal(context.caseRecord.fixtures?.[0]?.cleanup, 'NOT_CLEANED')
  assert.ok(context.caseRecord.checks.some((item) =>
    item.name === '本轮专属等级清理后分页不可见' && item.passed === false))
  assert.ok(context.caseRecord.checks.some((item) =>
    item.name === '客商等级完整目录只读验证前后相同' && item.passed === false))
  assert.equal(calls.requests.filter((item) => item.method === 'delete' &&
    item.path.includes('/admin-api/base/partner-level/delete?id=')).length, 1)
})

test('PB033-002: an existing same-code sample is never treated as this run ownership', async () => {
  const { context, dependencies, calls } = harness('PB033-002', {
    writeFixturesEnabled: true,
    existingSample: true
  })
  await assert.rejects(runCase(context, dependencies), /创建前不存在同编码共享客商等级样本/)
  assert.equal(calls.requests.filter((item) => item.method === 'post' &&
    item.path === '/admin-api/base/partner-level/create').length, 0)
  assert.equal(calls.requests.filter((item) => item.method === 'delete').length, 0)
  assert.ok(context.caseRecord.checks.some((item) =>
    item.name === '创建前不存在同编码共享客商等级样本' && item.passed === false))
})

test('PB033-002: empty scope, missing menu and unavailable DB retain genuine gaps', async () => {
  for (const settings of [{ emptyScope: 'SUPPLIER' }, { noMenu: true }, { noDb: true }]) {
    const { context, dependencies, calls } = harness('PB033-002', settings)
    const result = await runCase(context, dependencies)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(result.partial, true)
    assert.ok(context.caseRecord.remainingAssertions.length > 0)
    assert.ok(calls.requests.every((item) => item.method === 'get'))
  }
})

test('PB033-002: cross-scope response, hidden controls, stale display and directory drift fail', async () => {
  for (const settings of [
    { crossScope: true }, { hiddenControls: true }, { staleTable: true },
    { dbChanged: true }, { pageCode: 500 }, { pageStatus: 500 },
    { partnerRoute: '/settings/warehouse/partner-level' }
  ]) {
    const { context, dependencies, calls } = harness('PB033-002', settings)
    await assert.rejects(runCase(context, dependencies))
    assert.ok(calls.requests.every((item) => item.method === 'get'))
  }
})

test('PB028-001: full mock suite verifies source hashes, real rendered values and one harmless rejection', async () => {
  const { context, dependencies, calls } = harness('PB028-001')
  const result = await runCase(context, dependencies)
  assert.equal(result.acceptanceComplete, true)
  assert.equal(result.partial, false)
  assert.equal(calls.login, 1)
  assert.deepEqual(calls.navigation, ['/settings/system-options'])
  assert.equal(calls.snapshots.length, 2)
  const probes = calls.requests.filter((item) => item.method !== 'get')
  assert.equal(probes.length, 1)
  assert.equal(probes[0].path, '/admin-api/system/config/business-options/create')
  assert.ok(calls.clicks.every((name) => !/新增|编辑|配置|保存|删除/.test(name)))
  assert.deepEqual(context.caseRecord.catalogAssertions.map((item) => item.assertion),
    caseDefinition('PB028-001').assertions)
})

test('PB028-001: lack of DB prevents the POST probe and keeps effective-value and reverse gaps', async () => {
  const { context, dependencies, calls } = harness('PB028-001', { noDb: true })
  const result = await runCase(context, dependencies)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.partial, true)
  assert.equal(calls.requests.filter((item) => item.method === 'post').length, 0)
  assert.ok(context.caseRecord.remainingAssertions.some((item) => item.index === 3))
})

test('PB028-001: absent menu, empty catalog and absent DOMAIN_MODEL samples are not complete', async () => {
  for (const settings of [
    { noMenu: true }, { options: [] },
    { options: optionsFixture().filter((item) => item.ownerType !== 'DOMAIN_MODEL') }
  ]) {
    const { context, dependencies } = harness('PB028-001', settings)
    const result = await runCase(context, dependencies)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(result.partial, true)
    assert.ok(context.caseRecord.remainingAssertions.length > 0)
  }
})

test('PB028-001: same-length mutation in any module and config drift fail after readback', async () => {
  for (const settings of [
    { catalogChanged: true }, { unfilteredChanged: true }, { dbChanged: true }
  ]) {
    const { context, dependencies, calls } = harness('PB028-001', settings)
    await assert.rejects(runCase(context, dependencies))
    assert.equal(calls.snapshots.length, 2)
    assert.equal(calls.requests.filter((item) => item.path.includes('business-options/list')).length, 2)
  }
})

test('PB028-001: forged 404, permission denial, success and 500 fail without hiding the response', async () => {
  for (const settings of [
    { rejection: { code: 404, msg: '请求地址不存在:/admin-api/other/create' } },
    { rejection: { code: 403, msg: '没有权限' }, rejectionStatus: 403 },
    { rejection: { code: 0, data: 'created' } },
    { rejection: { code: 500, msg: '系统异常' }, rejectionStatus: 500 }
  ]) {
    const { context, dependencies, calls } = harness('PB028-001', settings)
    await assert.rejects(runCase(context, dependencies), /租户不能通过目录接口自由新增未知配置项/)
    assert.equal(calls.snapshots.length, 2)
    assert.equal(context.record.api.length, 1)
    assert.equal(context.record.api[0].code, settings.rejection.code)
    assert.equal(context.record.api[0].expectedBusinessRejectionMatched, undefined)
  }
})

test('PB028-001: mirror facts, wrong source, stale display and API anomalies are failures', async () => {
  const mirrored = configFixture()
  mirrored.push(['4', '1', 'erp', 'ERP.BARCODE.SCHEME', hash('copied-state'), rowHash])
  const wrongSource = optionsFixture()
  wrongSource[0].currentValueSource = 'TEMPLATE'
  for (const settings of [
    { configs: mirrored }, { options: wrongSource }, { staleTable: true },
    { pageOptionsChanged: true }, { pageCode: 500 }, { catalogCode: 500 },
    { catalogStatus: 500 }, { pageStatus: 500 }
  ]) {
    const { context, dependencies, calls } = harness('PB028-001', settings)
    await assert.rejects(runCase(context, dependencies))
    assert.equal(calls.requests.filter((item) => item.method === 'post').length, 0)
  }
})
