import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  MES_SALES_SELECTION_ASSERTION, MES_SALES_SELECTION_CHECK, MesSalesSelectionFixture,
  assertMesSalesSelectionScope, assertMesSalesSelectionSource, assertMesSalesSelectionSaved,
  assertMesSalesSelectionReceivablesRestored,
  classifyMesSalesSelectionBrowserRequest,
  isMesSalesSelectionEvidenceVerified, mesSalesSelectionBrowserBody, mesSalesSelectionId,
  mesSalesSelectionMarker, runMesSalesSelectionClosure
} from '../fixtures/mes-sales-selection-closure.mjs'
import {
  dispatchProductionSalesSelection, finalizeProductionCatalogEvidence,
  isMesSalesSelectionDispatchEnabled, productionEvidenceBindingsFor
} from '../suites/mes-production.mjs'

const marker = 'E2E-SALES-MSS-123456789ABC'
const settings = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const env = { CFOR_E2E_WRITE_FIXTURES: 'true', CFOR_E2E_MES_SALES_SELECTION: 'true' }
const clone = (value) => structuredClone(value)
const ok = (value) => ({ code: 0, data: clone(value) })
const emptySql = () => ({ available: true, rows: [] })
const noExecution = () => ({ available: true, rows: [
  ['inventory', '0'], ['stock-lines', '0'], ['works', '0'], ['tasks', '0']
] })
const recordOf = () => ({ checks: [], notes: [], evidence: [], database: [] })
const restoredReceivables = (sourceId) => ({ sourceId, marker,
  sql: { available: true, rows: [['ar-counts', '0', '0']] }, heads: [], entries: [] })
const settledReceivables = (source) => {
  const headId = `${source.id}8`
  return {
    sourceId: source.id,
    marker,
    sql: { available: true, rows: [['ar-counts', '1', '2']] },
    heads: [{
      id: headId, tenant_id: '1', src_bill_type: 'SalOrder', src_bill_id: source.id,
      src_no: source.billNo, remark: marker, receivable_type: '101',
      bill_stage: '0', is_effective: '0', is_voided: '1', is_closed: '0',
      checked_amt: '0', after_save_checked_amt: '0', return_amt: '0'
    }],
    entries: source.items.map((item, index) => ({
      id: `${source.id}9${index}`, tenant_id: '1', mid: headId,
      src_bill_type: 'SalOrder', src_bill_id: source.id,
      src_entry_id: item.id, checked_amt: '0', after_save_checked_amt: '0',
      return_amt: '0', parent_bill_stage: '0',
      parent_is_effective: '0', parent_is_voided: '1'
    }))
  }
}
const otherNames = [
  '专属生产订单审核后拆分出唯一工单', '专属工单排产生成唯一专属任务',
  '未配工艺排产被拒绝且不产生孤立任务', '未配置班组时预排产被正式阻断'
]

function saved(source, products, id = '2109682344865423399') {
  const head = { id, remark: marker, billNo: `${marker}-PLAN`, srcBillType: '0',
    srcBillId: source.id, salOrderId: source.id, customerId: source.customerId,
    billStage: '14', isEffective: 0,
    qty: source.items.reduce((sum, item) => sum + Number(item.count) - Number(item.prodCount), 0) }
  const entries = source.items.map((item, index) => ({
    id: String(BigInt(id) + BigInt(index + 1)), mid: id, salOrderId: source.id,
    salOrderEntryId: item.id, materialId: item.productId, unitId: item.productUnitId,
    qty: Number(item.count) - Number(item.prodCount),
    wmsAssembleId: products.find((product) => product.id === item.productId).bomId
  }))
  const sql = { available: true, rows: [
    ['head', id, '1', head.billNo, marker, '0', source.id, source.customerId, '14', '0'],
    ...entries.map((entry) => ['entry', entry.id, id, '1', source.id, entry.salOrderEntryId,
      entry.materialId, entry.unitId, String(entry.qty), entry.wmsAssembleId])
  ] }
  return { head, entries, sql }
}

function evidenceRecord() {
  const record = recordOf()
  const products = [1, 2].map((index) => ({
    id: `21096823448654233${index}1`, unitId: '7',
    code: `${marker}-FG${index}`, bomId: `21096823448654233${index}2`
  }))
  const sources = [[3, 5], [7, 11]].map((counts, index) => ({
    id: `21096823448654233${index}3`, customerId: '2109682344865423388',
    remark: marker, billNo: `${marker}-SO-${index + 1}`, status: 20, isEffective: 1,
    billStage: '24',
    items: products.map((product, row) => ({
      id: `2109682344865423${index}${row}4`, productId: product.id,
      productUnitId: product.unitId, productCode: product.code, productName: product.code,
      count: counts[row], prodCount: 0, outCount: 0, returnCount: 0
    }))
  }))
  const readback = saved(sources[1], products)
  const persisted = assertMesSalesSelectionSaved(readback, sources[1], marker)
  record.mesSalesSelectionClosure = {
    assertion: MES_SALES_SELECTION_ASSERTION, marker, status: 'VERIFIED', gaps: [],
    products, sources, customerId: sources[0].customerId,
    browser: {
      cancelled: { id: sources[0].id }, selected: { id: sources[1].id },
      persisted, readback, screenshot: '/offline/owned-selection.png',
      writes: [{ method: 'POST', path: '/admin-api/mes/prodOrder/add' }],
      cancellation: { before: emptySql(), after: emptySql(), reopenedEmpty: true },
      noExecution: noExecution()
    },
    cleanup: { status: 'VERIFIED_WITH_AUDIT_RETENTION',
      unresolved: [], resources: [
      { kind: 'production', id: persisted.id, marker, status: 'DELETED_VERIFIED' },
      ...sources.map((source) => ({
        kind: 'sale', id: source.id, marker, status: 'RETREATED_RETAINED_AUDIT',
        formalAction: { method: 'PUT', path: '/erp/sale-order/void', status: 'VERIFIED', invoked: true },
        receivablesBefore: restoredReceivables(source.id),
        receivablesAfter: settledReceivables(source),
        readback: {
          final: { ...clone(source), billStage: '12', isEffective: 0, isVoided: 0 },
          sql: { available: true, rows: [
            ['sale-cleanup', source.id, '1', source.billNo, marker, '12', '0', '0']
          ] }
        }
      }))
    ] }
  }
  record.checks = [...otherNames, MES_SALES_SELECTION_CHECK].map((name) => ({
    name, passed: true, details: 'Offline synthetic evidence only'
  }))
  record.mesSalesSelectionDispatchedVerified = true
  return record
}

function harness(options = {}) {
  const caseRecord = recordOf(), calls = [], resources = []
  const definitions = {
    material: ['mes_bas_material', 'code', 'remark', '/mes/basMaterial/add', '/mes/basMaterial/queryById'],
    bom: ['mes_wms_assemble', 'code', 'mark', '/mes/wmsAssemble/add', '/mes/wmsAssemble/queryById'],
    route: ['mes_wms_tech_route', 'code', 'mark', '/mes/wmsTechRoute/addMain', '/mes/wmsTechRoute/queryById/dictText'],
    partner: ['base_partner', 'name', 'remark', '/base/partner/create', '/base/partner/get'],
    sale: ['erp_sale_order', 'billNo', 'remark', '/erp/sale-order/create', '/erp/sale-order/get'],
    production: ['mes_prod_order', 'billNo', 'remark', null, '/mes/prodOrder/queryById/dictText']
  }
  let sequence = 2109682344865423400n
  const next = () => String(sequence++)
  let production, proof, safetyCalls = 0
  const getResource = (kind, id) => resources.find((item) => item.kind === kind && item.id === id && !item.deleted)
  const readSql = async (sql) => {
    calls.push(['SQL', sql])
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i)
    assert.match(sql, /tenant_id=1/)
    if (options.sqlUnavailable) return { available: false, reason: 'offline unavailable' }
    if (sql.includes("SELECT 'ar-counts'")) {
      assert.doesNotMatch(sql, /\b(?:deleted|is_effective|is_voided)\s*=/i)
      assert.match(sql, /LEFT JOIN fin_receivable h ON h.id=e.mid AND h.tenant_id=e.tenant_id/)
      const sale = resources.find((item) => item.kind === 'sale' && sql.includes(`h.src_bill_id='${item.id}'`))
      assert.ok(sale)
      const state = options.financeAppearsAfterWithdrawal && sale.row.billStage === '12'
        ? 'active' : options.financeState
      if (!state) return clone(restoredReceivables(sale.id).sql)
      if (state === 'unavailable') return { available: false, rows: [] }
      const orphan = state === 'orphan'
      const stage = state === 'withdrawn' ? '12' : state === 'voided' ? '0' : '24'
      const effective = ['withdrawn', 'voided'].includes(state) ? '0' : '1'
      const voided = state === 'voided' ? '1' : '0'
      const arId = '2109682344865423990'
      const head = ['ar-head', arId, '1', 'XSAR-OFFLINE', 'SalOrder', sale.id,
        sale.row.billNo, marker, sale.row.customerId, '101', '0', stage, effective, voided,
        '0', '0.00', '0.00', '0.00', '0.00', '0', '0', 'NULL', 'NULL']
      const item = sale.row.items[0]
      const entry = ['ar-entry', '2109682344865423991', '1', arId, 'XSAR-OFFLINE',
        'SalOrder', sale.id, item.id, item.productId, item.productUnitId,
        String(item.count), '30.00', '0.00', '0.00', '0.00',
        ...orphan ? ['NO_HEADER', 'NO_HEADER', 'NO_HEADER'] : [stage, effective, voided]]
      return { available: true, rows: [
        ['ar-counts', orphan || state === 'falseZeroCounts' ? '0' : '1',
          state === 'falseZeroCounts' ? '0' : '1'],
        ...orphan ? [] : [head], entry
      ] }
    }
    if (sql.includes("SELECT 'sale-cleanup'")) {
      const sale = resources.find((item) => item.kind === 'sale' && sql.includes(`id='${item.id}'`))
      assert.ok(sale)
      const row = sale.row
      return { available: true, rows: options.emptyCleanupSql ? [] : [[
        'sale-cleanup', row.id, '1', row.billNo, marker,
        options.cleanupSqlMismatch ? '32' : row.billStage, String(row.isEffective), String(row.isVoided)
      ]] }
    }
    if (sql.includes("SELECT 'production-heads'")) {
      const automaticReceivables = options.financeState ? '1' : '0'
      return { available: true, rows: ['production-heads', 'production-lines', 'stock-heads',
        'receivables', 'receipts', 'receipt-lines'].map((kind) =>
        [kind, options.dependencyReference === kind
          ? '1' : kind === 'receivables' ? automaticReceivables : '0']) }
    }
    if (sql.includes('FROM mes_wms_procedure')) {
      return { available: true, rows: [['2109682344865423395', `${marker}-PROC-1`]] }
    }
    if (sql.includes("SELECT 'inventory'")) {
      const materials = resources.filter((item) => item.kind === 'material')
      for (const material of materials) assert.ok(sql.includes(`'${material.id}'`))
      const result = noExecution()
      if (options.executed) result.rows[2][1] = '1'
      return result
    }
    if (sql.includes("SELECT 'head',COUNT")) return { available: true, rows: [
      ['head', production?.deleted ? '0' : '1'],
      ['entry', production?.deleted && !options.orphanEntries ? '0' : '2'],
      ['material', production?.deleted ? '0' : '1']
    ] }
    if (sql.includes("SELECT 'head',id")) {
      assert.doesNotMatch(sql.split('FROM mes_prod_order')[0], /sal_order_id/)
      return production && !production.deleted ? clone(proof.sql) : emptySql()
    }
    const kind = Object.keys(definitions).find((name) =>
      new RegExp(`FROM ${definitions[name][0]}\\s`).test(sql))
    assert.ok(kind, `Unexpected offline SQL: ${sql}`)
    const owned = resources.filter((item) => item.kind === kind && !item.deleted &&
      (sql.includes(`id='${item.id}'`) || sql.includes(`='${item.identity}'`)))
    if (sql.includes('SELECT id,tenant_id')) return { available: true,
      rows: owned.map((item) => [item.id, '1', item.identity, options.foreignSql ? 'FOREIGN' : marker]) }
    return { available: true, rows: owned.map((item) => [item.id]) }
  }
  const api = {
    getBusiness: async (url) => {
      calls.push(['GET', url])
      if (url === '/system/auth/get-permission-info') {
        return ok({ user: { id: '77' }, permissions: ['produce:order:create'] })
      }
      if (url === '/mes/basMaterial/list/enabled') return ok([{ id: '8', saled: 'Y', unitId: '7' }])
      if (url.startsWith('/bpm/process-instance/get?')) return ok({
        id: '11111111-1111-1111-1111-111111111111',
        businessKey: resources.find((item) => item.kind === 'sale').id,
        startUser: { id: '77' }, status: 2, endTime: '2026-10-16T12:00:00'
      })
      const parsed = new URL(`http://offline${url}`)
      if (parsed.pathname === '/mes/prodOrder/queryMesProdOrderSubByMainId/dictText') return ok(proof.entries)
      const kind = Object.keys(definitions).find((name) => definitions[name][4] === parsed.pathname)
      assert.ok(kind, `Unexpected offline GET ${url}`)
      const found = getResource(kind, parsed.searchParams.get('id'))
      return ok(found ? found.row : null)
    },
    postBusiness: async (url, body) => {
      calls.push(['POST', url])
      if (url.startsWith('/mes/wmsAssemble/publish?id=')) {
        const bom = getResource('bom', url.split('=')[1])
        bom.row.devStatus = 2
        getResource('material', bom.row.stockId).row.defaultProdBom = bom.id
        return ok(true)
      }
      const kind = Object.keys(definitions).find((name) => definitions[name][3] === url)
      assert.ok(kind, `Unexpected write ${url}; no stock/scheduling/grants permitted`)
      const id = next(), row = { ...clone(body), id }
      if (kind === 'sale') {
        Object.assign(row, { status: options.pending ? 10 : 20, isEffective: options.pending ? 0 : 1,
          billStage: options.pending ? '22' : '24', prodCount: 0, outCount: 0, returnCount: 0, isVoided: 0,
          afterSaveCount: 0, checkedAmt: 0, invoiceMount: 0 })
        if (options.pending) row.processInstanceId = '11111111-1111-1111-1111-111111111111'
        row.items = row.items.map((item) => ({
          ...item, id: next(), prodCount: 0, outCount: 0, returnCount: 0,
          productCode: getResource('material', item.productId).row.code,
          productName: getResource('material', item.productId).row.name
        }))
      }
      resources.push({ kind, id, identity: row[definitions[kind][1]], row })
      if (options.createLost) throw new Error('create network timeout')
      return ok(id)
    },
    putBusiness: async (url, body) => {
      calls.push(['PUT', url])
      assert.equal(url, '/erp/sale-order/void', 'Only the verified sales withdrawal API is permitted')
      if (!options.withdrawalUncommitted) {
        Object.assign(getResource('sale', body.id).row, { billStage: '12', isEffective: 0 })
      }
      if (options.voidLost) throw new Error('void response lost')
      return ok(true)
    },
    deleteBusiness: async (url) => {
      calls.push(['DELETE', url])
      assert.equal(url, `/mes/prodOrder/delete?id=${production.id}`)
      if (!options.deleteUncommitted) {
        production.deleted = true
        const source = getResource('sale', production.row.srcBillId)
        source.row.prodCount = 0
        for (const item of source.row.items) item.prodCount = 0
      }
      if (options.deleteLost || options.deleteUncommitted) throw new Error('delete response lost')
      return ok(true)
    }
  }
  const safetyCheck = async () => {
    safetyCalls++
    if (options.unsafe) throw new Error('unsafe local migration writer')
  }
  const context = { caseId: 'MES-PROD-001', api, page: {}, caseRecord, record: {},
    outputDir: '/offline/mes-selection' }
  const verifyBrowser = async ({ fixture }) => {
    if (options.browserFailure) throw new Error('page did not render')
    const intent = fixture.productionIntent()
    intent.id = next()
    proof = saved(fixture.sales[1], fixture.products, intent.id)
    production = { kind: 'production', id: intent.id, identity: intent.identity, row: proof.head }
    resources.push(production)
    const source = getResource('sale', proof.head.srcBillId)
    source.row.prodCount = proof.head.qty
    for (const item of source.row.items) item.prodCount = item.count
    return {
      cancelled: { id: fixture.sales[0].id }, selected: { id: fixture.sales[1].id },
      readback: clone(proof), persisted: assertMesSalesSelectionSaved(proof, fixture.sales[1], marker),
      screenshot: '/offline/owned-selection.png',
      writes: [{ method: 'POST', path: '/admin-api/mes/prodOrder/add' }],
      cancellation: { before: emptySql(), after: emptySql(), reopenedEmpty: true },
      noExecution: noExecution()
    }
  }
  const dependencies = { settings, env, marker, runReadOnlySql: readSql,
    assertLocalWriteSafety: safetyCheck, verifyBrowser }
  return { context, dependencies, calls, resources,
    get safetyCalls() { return safetyCalls },
    fixture: () => new MesSalesSelectionFixture({
      api, caseRecord, marker, settings, env, readSql, safetyCheck
    }),
    run: () => runMesSalesSelectionClosure(context, dependencies) }
}

test('scope requires both explicit flags, exact local endpoints, tenant and database before any I/O', async () => {
  assert.doesNotThrow(() => assertMesSalesSelectionScope(settings, env))
  for (const invalid of [
    { ...settings, target: 'online' }, { ...settings, tenantId: '2' },
    { ...settings, tenantName: 'OTHER' },
    { ...settings, webBase: 'https://127.0.0.1:9151' },
    { ...settings, webBase: 'http://127.0.0.1:9151/unrelated' },
    { ...settings, apiBase: 'http://example.test:48083' },
    { ...settings, apiBase: 'http://127.0.0.1:48080' },
    { ...settings, db: { ...settings.db, name: 'production' } },
    { ...settings, db: { ...settings.db, host: 'remote' } },
    { ...settings, db: { ...settings.db, port: '3307' } }
  ]) {
    assert.throws(() => assertMesSalesSelectionScope(invalid, env))
    assert.equal(isMesSalesSelectionDispatchEnabled(invalid, env), false)
  }
  for (const flags of [{}, { CFOR_E2E_WRITE_FIXTURES: 'true' }, { CFOR_E2E_MES_SALES_SELECTION: 'true' }]) {
    const h = harness()
    await assert.rejects(runMesSalesSelectionClosure(h.context, { ...h.dependencies, env: flags }))
    assert.deepEqual(h.calls, [])
  }
})

test('owned marker and bigint IDs never accept injection, implicit booleans or precision loss', () => {
  assert.equal(mesSalesSelectionId('2109682344865423362'), '2109682344865423362')
  assert.equal(mesSalesSelectionMarker(marker), marker)
  for (const invalid of [undefined, null, 0, true, 9007199254740992, '1 OR 1', '']) {
    assert.throws(() => mesSalesSelectionId(invalid))
  }
  for (const invalid of ['shared', `${marker}'`, marker.toLowerCase()]) {
    assert.throws(() => mesSalesSelectionMarker(invalid))
  }
})

test('source approval, unit, line identity and exact remaining quantities must all be formal', () => {
  const e = evidenceRecord().mesSalesSelectionClosure
  const expected = { marker, products: e.products, customerId: e.customerId, counts: [3, 5] }
  assert.equal(assertMesSalesSelectionSource(e.sources[0], expected), e.sources[0])
  for (const mutate of [
    (source) => { source.status = 10 },
    (source) => { source.isEffective = 0 },
    (source) => { source.remark = 'FOREIGN' },
    (source) => { source.customerId = '9' },
    (source) => { source.items[0].prodCount = 1 },
    (source) => { source.items[0].count = null },
    (source) => { source.items[1] = clone(source.items[0]) },
    (source) => { source.items[0].productUnitId = '9' }
  ]) {
    const source = clone(e.sources[0])
    mutate(source)
    assert.throws(() => assertMesSalesSelectionSource(source, expected))
  }
})

test('saved evidence rejects A/B source leakage, wrong quantities/BOM, missing SQL and null terminal fields', () => {
  const e = evidenceRecord().mesSalesSelectionClosure
  for (const mutate of [
    (proof) => { proof.head.srcBillId = e.sources[0].id },
    (proof) => { proof.head.salOrderId = e.sources[0].id },
    (proof) => { proof.head.isEffective = null },
    (proof) => { proof.head.billStage = '24' },
    (proof) => { proof.entries[0].salOrderEntryId = e.sources[0].items[0].id },
    (proof) => { proof.entries[0].qty = 3 },
    (proof) => { proof.entries[0].materialId = '9' },
    (proof) => { proof.entries[0].wmsAssembleId = null },
    (proof) => { proof.entries[1] = clone(proof.entries[0]) },
    (proof) => { proof.sql.available = false },
    (proof) => { proof.sql.rows.pop() },
    (proof) => { proof.sql.rows[0][2] = '2' },
    (proof) => { proof.sql.rows[1][8] = '1' }
  ]) {
    const proof = clone(e.browser.readback)
    mutate(proof)
    assert.throws(() => assertMesSalesSelectionSaved(proof, e.sources[1], marker))
  }
})

test('HTTP 200, empty or legacy business errors are never browser business success', async () => {
  const response = (body, http = true) => ({
    ok: () => http, headers: () => ({}), text: async () => JSON.stringify(body)
  })
  assert.deepEqual(await mesSalesSelectionBrowserBody(response(ok({ id: '7' }))), { id: '7' })
  assert.deepEqual(await mesSalesSelectionBrowserBody(response({ code: 200, success: true, data: [] })), [])
  for (const body of [{}, { code: 500 }, { code: 200, success: false, data: '7' }, { code: 200 }]) {
    await assert.rejects(mesSalesSelectionBrowserBody(response(body)))
  }
  await assert.rejects(mesSalesSelectionBrowserBody(response(ok('7'), false)))
})

test('the exact field-meaning POST query is read-only and remains recorded for both form requests', () => {
  const request = (path) => ({
    method: () => 'POST', url: () => `http://127.0.0.1:9151${path}`
  })
  const reads = [
    '/admin-api/system/field-meaning/query-by-condition',
    '/admin-api/system/field-meaning/query-by-condition?tableName=mes_prod_order',
    '/admin-api/mes/prodOrder/prodBom/dictText'
  ]
  assert.deepEqual(reads.map((path) => classifyMesSalesSelectionBrowserRequest(request(path))),
    ['read', 'read', 'read'])
})

test('field-meaning siblings, path variants, other methods and unknown POSTs remain business writes', () => {
  for (const [method, path] of [
    ...['create', 'update', 'delete', 'list-by-condition', 'query-by-condition-extra',
      'query-by-condition/', 'Query-by-condition'].map((suffix) =>
      ['POST', `/admin-api/system/field-meaning/${suffix}`]),
    ['POST', '/admin-api/system/field-meaning/query-by-condition/delete'],
    ['POST', '/admin-api/mes/prodOrder/add'],
    ['POST', '/admin-api/unknown/query'],
    ['PUT', '/admin-api/system/field-meaning/query-by-condition'],
    ['PATCH', '/admin-api/system/field-meaning/query-by-condition'],
    ['DELETE', '/admin-api/system/field-meaning/query-by-condition']
  ]) {
    const request = { method: () => method, url: () => `http://127.0.0.1:9151${path}` }
    assert.equal(classifyMesSalesSelectionBrowserRequest(request), 'write', `${method} ${path}`)
  }
  const request = (method, path) => ({ method: () => method, url: () => `http://127.0.0.1:9151${path}` })
  assert.equal(classifyMesSalesSelectionBrowserRequest(request('PUT',
    '/admin-api/mes/fillRule/executeRuleByCode/mes_scdd_bill_no')), 'numbering')
  assert.equal(classifyMesSalesSelectionBrowserRequest(request('POST',
    '/admin-api/mes/fillRule/executeRuleByCode/mes_scdd_bill_no')), 'write')
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(classifyMesSalesSelectionBrowserRequest(request(method,
      '/admin-api/system/field-meaning/query-by-condition')), 'ignore')
  }
})

test('create validates marker and identity before any writes and does not retry ambiguous POST', async () => {
  const h = harness({ createLost: true }), fixture = h.fixture()
  await assert.rejects(fixture.create('material', { code: 'SHARED', remark: marker }))
  await assert.rejects(fixture.create('material', { code: `${marker}-RM`, remark: 'OTHER' }))
  assert.deepEqual(h.calls, [])
  await assert.rejects(fixture.create('material', { code: `${marker}-RM`, remark: marker }), /timeout/)
  assert.equal(h.calls.filter((call) => call[0] === 'POST').length, 1)
  assert.equal(fixture.resources.length, 1)
  assert.equal(fixture.resources[0].id, h.resources[0].id, 'Lost response still registers exact persisted ID')
  await fixture.cleanup()
  await fixture.cleanup()
  assert.equal(h.context.caseRecord.mesSalesSelectionCleanup.status, 'VERIFIED_WITH_AUDIT_RETENTION')
  assert.equal(h.calls.filter((call) => call[0] === 'POST').length, 1)
})

test('duplicate creation and foreign ownership stop before any destructive action', async () => {
  const h = harness(), fixture = h.fixture()
  await fixture.create('material', { code: `${marker}-RM`, remark: marker })
  await assert.rejects(fixture.create('material', { code: `${marker}-RM`, remark: marker }), /already exists/)
  assert.equal(h.calls.filter((call) => call[0] === 'POST').length, 1)
  h.resources[0].row.remark = 'FOREIGN'
  await assert.rejects(fixture.cleanup(), /incomplete/)
  assert.equal(h.context.caseRecord.mesSalesSelectionCleanup.resources[0].status, 'RECOVERY_REQUIRED')
  assert.equal(h.calls.filter((call) => ['DELETE', 'PUT'].includes(call[0])).length, 0)
})

test('migration/job safety gate blocks fixture preparation before API calls', async () => {
  const h = harness({ unsafe: true })
  await assert.rejects(h.run(), /unsafe local/)
  assert.equal(h.safetyCalls, 1)
  assert.deepEqual(h.calls, [])
})

test('selection evidence passes with official sales-order void audit retention', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(result.salesSelectionVerified, true)
  assert.equal(result.partial, true)
  assert.equal(isMesSalesSelectionEvidenceVerified(h.context.caseRecord), true)
  assert.equal(h.context.caseRecord.mesSalesSelectionClosure.status, 'VERIFIED')
  assert.equal(h.safetyCalls, 1)
  assert.equal(h.resources.filter((item) => item.kind === 'sale').length, 2)
  assert.equal(h.resources.filter((item) => item.kind === 'bom').length, 2)
  assert.equal(h.resources.filter((item) => item.kind === 'material').length, 3)
  assert.ok(h.resources.find((item) => item.kind === 'production').deleted)
  assert.ok(h.resources.filter((item) => item.kind === 'sale')
    .every((item) => item.row.isVoided === 0 && item.row.billStage === '12' && item.row.isEffective === 0))
  const sales = h.context.caseRecord.mesSalesSelectionCleanup.resources.filter((item) => item.kind === 'sale')
  assert.ok(sales.every((item) => item.status === 'RETREATED_RETAINED_AUDIT' && item.readback.sql.available))
  assert.deepEqual(result.evidence.cleanup.unresolved, [])
  assert.ok(result.evidence.cleanup.resources.filter((item) => item.kind === 'sale').every((item) =>
    item.formalAction.method === 'PUT' &&
    item.formalAction.path === '/erp/sale-order/void' &&
    item.formalAction.status === 'VERIFIED' &&
    item.formalAction.invoked === true))
  assert.doesNotMatch(h.calls.filter((call) => call[0] !== 'SQL').flat().join(' '),
    /stkInventory|stkIo|schedule|routeproducetask|assign-role|update-password/)
})

test('pending formal sales approval remains GAP even when official withdrawal cleanup succeeds', async () => {
  const h = harness({ pending: true })
  const result = await h.run()
  assert.equal(result.salesSelectionVerified, false)
  const evidence = h.context.caseRecord.mesSalesSelectionClosure
  assert.equal(evidence.status, 'GAP')
  assert.ok(evidence.gaps.some((item) => /formally approved/.test(item.detail)))
  assert.equal(evidence.gaps.some((item) => item.code === 'CLEANUP_RECOVERY_REQUIRED'), false)
  assert.equal(evidence.cleanup.status, 'VERIFIED_WITH_AUDIT_RETENTION')
  assert.equal(isMesSalesSelectionEvidenceVerified(h.context.caseRecord), false)
  assert.equal(h.resources.some((item) => item.kind === 'production'), false)
})

test('missing SQL stays GAP and failed browser throws; neither becomes an empty successful sample', async () => {
  const sql = harness({ sqlUnavailable: true })
  const result = await sql.run()
  assert.equal(result.salesSelectionVerified, false)
  assert.equal(result.evidence.status, 'GAP')
  assert.equal(sql.calls.some((call) => call[0] === 'POST'), false)
  const browser = harness({ browserFailure: true })
  await assert.rejects(browser.run(), /page did not render/)
  assert.equal(isMesSalesSelectionEvidenceVerified(browser.context.caseRecord), false)
})

test('lost committed delete/withdrawal responses are recovered without promoting withdrawal to final void', async () => {
  const h = harness({ deleteLost: true, voidLost: true })
  const result = await h.run()
  assert.equal(result.salesSelectionVerified, true)
  assert.equal(isMesSalesSelectionEvidenceVerified(h.context.caseRecord), true)
  assert.equal(h.calls.filter((call) => call[0] === 'DELETE').length, 1)
  const cleanup = h.context.caseRecord.mesSalesSelectionCleanup
  assert.match(cleanup.resources.find((item) => item.kind === 'production').recoveredWriteError, /lost/)
  assert.equal(cleanup.resources.filter((item) => item.kind === 'sale' && item.recoveredWithdrawalError).length, 2)
  assert.equal(h.calls.filter((call) => call[0] === 'PUT').length, 2)
})

test('cleanup recovery of r47-style already withdrawn sources does not repeat the write or guess invalid paths', async () => {
  const h = harness(), fixture = h.fixture()
  await fixture.prepare()
  await fixture.cleanup()
  const writes = h.calls.filter((call) => call[0] === 'PUT').length
  assert.equal(writes, 2)
  await fixture.cleanup()
  assert.equal(h.calls.filter((call) => call[0] === 'PUT').length, writes)
  assert.equal(h.calls.some((call) => /\/invalid/.test(call[1])), false)
  for (const resource of h.context.caseRecord.mesSalesSelectionCleanup.resources.filter((item) => item.kind === 'sale')) {
    assert.equal(resource.status, 'RETREATED_RETAINED_AUDIT')
    assert.equal(resource.before.final.billStage, '12')
    assert.equal(resource.readback.final.isVoided, 0)
    assert.equal(resource.error, undefined)
  }
  assert.deepEqual(h.context.caseRecord.mesSalesSelectionCleanup.unresolved, [])
})

test('HTTP success without committed withdrawal remains recovery required and cannot verify the selection', async () => {
  const h = harness({ withdrawalUncommitted: true })
  await assert.rejects(h.run(), /cleanup incomplete/)
  assert.equal(isMesSalesSelectionEvidenceVerified(h.context.caseRecord), false)
  assert.equal(h.context.caseRecord.mesSalesSelectionCleanup.status, 'RECOVERY_REQUIRED')
})

test('preexisting final void is accepted only with exact owned API/SQL terminal evidence and no repeated write', async () => {
  const h = harness(), fixture = h.fixture()
  await fixture.prepare()
  for (const source of h.resources.filter((item) => item.kind === 'sale')) {
    Object.assign(source.row, { billStage: '0', isEffective: 0, isVoided: 1 })
  }
  const cleanup = await fixture.cleanup()
  assert.equal(cleanup.status, 'VERIFIED_WITH_AUDIT_RETENTION')
  assert.equal(h.calls.some((call) => ['PUT', 'DELETE'].includes(call[0])), false)
  assert.ok(cleanup.resources.filter((item) => item.kind === 'sale').every((item) =>
    item.status === 'VOIDED_RETAINED_AUDIT' && item.readback.sql.rows[0].slice(-3).join(',') === '0,0,1'))
})

test('cleanup refuses consumed headers or entries and missing quantities before withdrawal', async () => {
  for (const mutate of [
    (row) => { row.prodCount = 1 },
    (row) => { row.outCount = 1 },
    (row) => { row.returnCount = 1 },
    (row) => { row.afterSaveCount = 1 },
    (row) => { row.checkedAmt = 1 },
    (row) => { row.invoiceMount = 1 },
    (row) => { row.depositPrice = 1 },
    (row) => { row.items[0].prodCount = 1 },
    (row) => { row.items[0].outCount = 1 },
    (row) => { row.items[0].returnCount = 1 },
    (row) => { row.prodCount = null },
    (row) => { row.items = [] }
  ]) {
    const h = harness(), fixture = h.fixture()
    await fixture.prepare()
    h.resources.filter((item) => item.kind === 'sale').forEach((item) => mutate(item.row))
    await assert.rejects(fixture.cleanup(), /cleanup incomplete/)
    assert.equal(h.calls.some((call) => ['PUT', 'DELETE'].includes(call[0])), false)
  }
})

test('any known downstream reference blocks cascaded ERP/WMS/finance cleanup before the first write', async () => {
  for (const dependencyReference of ['production-heads', 'production-lines', 'stock-heads',
    'receivables', 'receipts', 'receipt-lines']) {
    const h = harness({ dependencyReference }), fixture = h.fixture()
    await fixture.prepare()
    await assert.rejects(fixture.cleanup(), /cleanup incomplete/)
    assert.equal(h.calls.some((call) => ['PUT', 'DELETE'].includes(call[0])), false)
    assert.ok(h.context.caseRecord.mesSalesSelectionCleanup.resources.filter((item) => item.kind === 'sale')
      .every((item) => /downstream references|Automatic AR count changed/.test(item.error)))
  }
})

test('AR snapshots preserve exact source, states and line amounts without pretending header zero means no obligation', async () => {
  const h = harness({ financeState: 'active' }), fixture = h.fixture()
  await fixture.prepare()
  await assert.rejects(fixture.cleanup(), /cleanup incomplete/)
  const dispositions = h.context.caseRecord.mesSalesSelectionCleanup.resources.filter((item) => item.kind === 'sale')
  assert.equal(dispositions.length, 2)
  for (const disposition of dispositions) {
    assert.equal(disposition.status, 'RECOVERY_REQUIRED')
    assert.match(disposition.error, /AR recovery unresolved/)
    const snapshot = disposition.receivablesBefore
    assert.equal(snapshot.sourceId, disposition.id)
    assert.equal(snapshot.marker, marker)
    assert.equal(snapshot.heads[0].src_bill_id, disposition.id)
    assert.equal(snapshot.heads[0].remark, marker)
    assert.equal(snapshot.heads[0].bill_stage, '24')
    assert.equal(snapshot.heads[0].is_effective, '1')
    assert.equal(snapshot.heads[0].is_voided, '0')
    assert.equal(snapshot.heads[0].is_auto, '0')
    assert.equal(snapshot.heads[0].amt, '0.00')
    assert.equal(snapshot.entries[0].amt, '30.00')
    assert.equal(snapshot.entries[0].parent_is_effective, '1')
    assert.equal(disposition.receivablesAfter.heads[0].bill_stage, '24')
    assert.equal(disposition.receivablesAfter.heads[0].is_effective, '1')
    assert.equal(disposition.receivablesAfter.heads[0].is_voided, '0')
    assert.equal(disposition.receivablesAfter.entries[0].parent_is_effective, '1')
  }
  assert.equal(h.calls.filter((call) => call[0] === 'PUT').length, 2,
    'Each unconsumed source must use the formal sales withdrawal API before recovery is reported')
  assert.equal(h.calls.some((call) => call[0] === 'DELETE'), false)
  assert.equal(h.calls.some((call) => /\/finance\//.test(call[1])), false)
})

test('inactive, voided, orphaned, incomplete or falsely zero AR evidence never permits withdrawal or cleanup PASS', async () => {
  for (const financeState of ['withdrawn', 'voided', 'orphan', 'falseZeroCounts', 'unavailable']) {
    const h = harness({ financeState }), fixture = h.fixture()
    await fixture.prepare()
    await assert.rejects(fixture.cleanup(), /cleanup incomplete/)
    assert.equal(h.context.caseRecord.mesSalesSelectionCleanup.status, 'RECOVERY_REQUIRED')
    assert.equal(h.calls.some((call) => call[0] === 'PUT'), false,
      'Invalid AR state must block the formal sales withdrawal API')
    assert.equal(h.calls.some((call) => call[0] === 'DELETE'), false)
    if (financeState === 'orphan') {
      const snapshot = h.context.caseRecord.mesSalesSelectionCleanup.resources[0].receivablesBefore
      assert.deepEqual(snapshot.heads, [])
      assert.equal(snapshot.entries[0].parent_bill_stage, 'NO_HEADER')
    }
  }
})

test('AR appearing during formal withdrawal is read back and remains recovery required', async () => {
  const h = harness({ financeAppearsAfterWithdrawal: true })
  await assert.rejects(h.run(), /cleanup incomplete/)
  const cleanup = h.context.caseRecord.mesSalesSelectionCleanup
  assert.equal(cleanup.status, 'RECOVERY_REQUIRED')
  const sources = cleanup.resources.filter((item) => item.kind === 'sale')
  assert.ok(sources.every((item) => item.receivablesBefore.sql.rows[0][1] === '0' &&
    item.receivablesAfter.heads[0].is_effective === '1' && item.status === 'RECOVERY_REQUIRED'))
  assert.equal(isMesSalesSelectionEvidenceVerified(h.context.caseRecord), false)
})

test('AR restoration requires raw SQL absence for both headers and entries with exact source and marker', () => {
  const resource = { id: '2109682344865423990', marker }
  const valid = restoredReceivables(resource.id)
  assert.doesNotThrow(() => assertMesSalesSelectionReceivablesRestored(valid, resource))
  for (const mutate of [
    (snapshot) => { snapshot.sourceId = '9' },
    (snapshot) => { snapshot.marker = 'E2E-SALES-MSS-000000000000' },
    (snapshot) => { snapshot.sql.available = false },
    (snapshot) => { snapshot.sql.rows = [] },
    (snapshot) => { snapshot.sql.rows[0][1] = '1' },
    (snapshot) => { snapshot.sql.rows[0][2] = '1' },
    (snapshot) => { snapshot.sql.rows.push(['ar-counts', '0', '0']) },
    (snapshot) => { snapshot.sql.rows.push(['ar-head', 'still present']) }
  ]) {
    const invalid = clone(valid)
    mutate(invalid)
    assert.throws(() => assertMesSalesSelectionReceivablesRestored(invalid, resource))
  }
})

test('missing or mismatched cleanup SQL and inconsistent terminal flags never become verified', async () => {
  for (const options of [{ emptyCleanupSql: true }, { cleanupSqlMismatch: true }, {}]) {
    const h = harness(options), fixture = h.fixture()
    await fixture.prepare()
    for (const source of h.resources.filter((item) => item.kind === 'sale')) {
      Object.assign(source.row, { billStage: options.emptyCleanupSql || options.cleanupSqlMismatch ? '0' : '12',
        isEffective: 0, isVoided: 1 })
    }
    await assert.rejects(fixture.cleanup(), /cleanup incomplete/)
    assert.equal(h.context.caseRecord.mesSalesSelectionCleanup.status, 'RECOVERY_REQUIRED')
    assert.equal(h.calls.some((call) => ['PUT', 'DELETE'].includes(call[0])), false)
  }
})

test('uncommitted delete or orphaned production lines retain sources and forbid VERIFIED', async () => {
  for (const options of [{ deleteUncommitted: true }, { orphanEntries: true }]) {
    const h = harness(options)
    await assert.rejects(h.run(), /incomplete/)
    assert.equal(h.context.caseRecord.mesSalesSelectionCleanup.status, 'RECOVERY_REQUIRED')
    assert.equal(h.calls.filter((call) => call[0] === 'PUT' && call[1] === '/erp/sale-order/void').length, 0)
    assert.equal(isMesSalesSelectionEvidenceVerified(h.context.caseRecord), false)
  }
})

test('catalog #0 needs full evidence and exact unique check, never status/check/flag alone', () => {
  const record = evidenceRecord()
  assert.equal(isMesSalesSelectionEvidenceVerified(record), true)
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-001'), true)
  assert.deepEqual(record.catalogAssertions.map((item) => item.status), Array(4).fill('VERIFIED'))
  for (const mutate of [
    (row) => { delete row.mesSalesSelectionClosure },
    (row) => { row.mesSalesSelectionClosure = { status: 'VERIFIED' } },
    (row) => { row.mesSalesSelectionDispatchedVerified = false },
    (row) => { row.checks.pop() },
    (row) => { row.checks.push(clone(row.checks.at(-1))) },
    (row) => { row.checks.at(-1).passed = false },
    (row) => { delete row.mesSalesSelectionClosure.browser.readback.sql },
    (row) => { row.mesSalesSelectionClosure.browser.readback.sql.rows = [] },
    (row) => { row.mesSalesSelectionClosure.browser.readback.head.srcBillId = '9' },
    (row) => { row.mesSalesSelectionClosure.browser.cancellation.reopenedEmpty = false },
    (row) => { row.mesSalesSelectionClosure.browser.noExecution.rows[0][1] = '1' },
    (row) => { row.mesSalesSelectionClosure.cleanup.status = 'RECOVERY_REQUIRED' },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[0].status = 'RETAINED_AUDIT' },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].readback.final.isVoided = 1 },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].readback.final.billStage = '32' },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].readback.final.isEffective = 1 },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].status = 'RETAINED_AUDIT' },
    (row) => { delete row.mesSalesSelectionClosure.cleanup.resources[1].formalAction },
    (row) => { row.mesSalesSelectionClosure.cleanup.unresolved.push({ code: 'UNEXPECTED_GAP' }) },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].readback.sql.available = false },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].readback.sql.rows = [] },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].readback.sql.rows[0][2] = '2' },
    (row) => { delete row.mesSalesSelectionClosure.cleanup.resources[1].receivablesBefore },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].receivablesAfter.sql.rows[0][2] = '1' },
    (row) => { row.mesSalesSelectionClosure.cleanup.resources[1].receivablesAfter.sql.available = false },
    (row) => { row.mesSalesSelectionClosure.gaps.push({ detail: 'missing proof' }) }
  ]) {
    const invalid = clone(record)
    mutate(invalid)
    assert.equal(finalizeProductionCatalogEvidence(invalid, 'MES-PROD-001'), false)
    assert.equal(invalid.catalogAssertions[0].status, 'GAP')
    assert.deepEqual(invalid.catalogAssertions.slice(1).map((item) => item.status), Array(3).fill('VERIFIED'))
  }
})

test('catalog preserves non-selection gaps and requires original split/schedule/negative evidence independently', () => {
  const record = evidenceRecord()
  record.checks = record.checks.filter((check) => check.name === MES_SALES_SELECTION_CHECK)
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-001'), false)
  assert.equal(record.catalogAssertions[0].status, 'VERIFIED')
  assert.equal(record.remainingAssertions.length, 3)
  const before = productionEvidenceBindingsFor('MES-PROD-002', recordOf())
  productionEvidenceBindingsFor('MES-PROD-001', record)
  assert.deepEqual(productionEvidenceBindingsFor('MES-PROD-002', recordOf()), before)
})

test('dispatch is local opt-in only, passes the existing authenticated context, and reuses precise sales approvers', async () => {
  const record = evidenceRecord(), api = {}, page = {}, calls = []
  const context = { caseId: 'MES-PROD-001', caseRecord: record, api, page }
  await dispatchProductionSalesSelection(context, {
    config: settings, env,
    runMesSalesSelectionClosure: async (received, deps) => {
      assert.equal(received, context)
      assert.equal(received.api, api)
      assert.equal(received.page, page)
      assert.equal(deps.settings, settings)
      await deps.approveSalesOrder({ source: { processInstanceId: 'owned-process' } })
      return { salesSelectionVerified: true }
    },
    approveOwnedSalesProcess: async (received) => {
      assert.equal(received.api, api)
      assert.equal(received.page, page)
      calls.push(received.processId)
    }
  })
  assert.deepEqual(calls, ['owned-process'])
  assert.equal(record.mesSalesSelectionDispatchedVerified, true)
  for (const flags of [{}, { CFOR_E2E_WRITE_FIXTURES: 'true' }]) {
    await dispatchProductionSalesSelection(context, {
      config: settings, env: flags,
      runMesSalesSelectionClosure: async () => assert.fail('Disabled helper must not execute')
    })
    assert.equal(record.mesSalesSelectionDispatchedVerified, false)
    assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-001'), false)
  }
  await dispatchProductionSalesSelection({ ...context, caseId: 'MES-PROD-002' }, {
    config: settings, env,
    runMesSalesSelectionClosure: async () => assert.fail('Other cases must remain untouched')
  })
})

test('dispatch return boolean cannot replace real evidence or conceal a GAP/throw', async () => {
  for (const [record, result] of [
    [recordOf(), { salesSelectionVerified: true }],
    [evidenceRecord(), { salesSelectionVerified: false }],
    [evidenceRecord(), {}]
  ]) {
    await dispatchProductionSalesSelection({ caseId: 'MES-PROD-001', caseRecord: record }, {
      config: settings, env, runMesSalesSelectionClosure: async () => result
    })
    assert.equal(record.mesSalesSelectionDispatchedVerified, false)
  }
  const record = evidenceRecord()
  await assert.rejects(dispatchProductionSalesSelection({ caseId: 'MES-PROD-001', caseRecord: record }, {
    config: settings, env, runMesSalesSelectionClosure: async () => { throw new Error('real failure') }
  }), /real failure/)
  assert.equal(record.mesSalesSelectionDispatchedVerified, false)
})

test('suite invokes selection dispatch only in PROD001 and preserves original execution workflows', () => {
  const source = fs.readFileSync(new URL('../suites/mes-production.mjs', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("if (caseId === 'MES-PROD-001')"),
    source.indexOf("if (caseId === 'MES-PROD-002')"))
  assert.match(branch, /await dispatchProductionSalesSelection\(\{ \.\.\.context, api \}, dependencies\)/)
  assert.match(branch, /new ExecutionWorkflowFixture/)
  assert.match(branch, /await fixture\.cleanup\(caseRecord\)/)
  assert.match(branch, /if \(complete\) return/)
  assert.equal((source.match(/await dispatchProductionSalesSelection/g) || []).length, 1)
})
