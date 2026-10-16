import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  COST_ENTERPRISE_CHECKS, COST_ENTERPRISE_MENU_SQL, COST_ENTERPRISE_PURCHASE_SOURCES,
  COST_ENTERPRISE_TRADE_REJECTION, auditCostEnterpriseRoutes, costEnterprisePurchaseRejection,
  parseCostEnterpriseMenuInventory, readCostEnterpriseFactSnapshot,
  readCostEnterpriseSourceBoundaries, verifyCostEnterpriseRejections, verifyCostEnterpriseWorkbench
} from '../fixtures/cost-enterprise-route-evidence.mjs'
import { costCatalogBindings, costCatalogEvidence, runCase } from '../suites/cost.mjs'

const digest = 'a'.repeat(64)
const period = '2026-10'
const schemaRows = ['cost_period', 'cost_workflow_request'].flatMap((table) => [
  ['schema-count', table, '4'], ['column', table, 'id', 'bigint'],
  ['column', table, 'tenant_id', 'bigint'], ['column', table, 'status', 'varchar'],
  ['column', table, 'deleted', 'bit']
])
const factRows = [
  ['count', 'cost_period', '1'], ['row', 'cost_period', '12', digest],
  ['count', 'cost_workflow_request', '1'], ['row', 'cost_workflow_request', '30', digest]
]
const menu = (id, parentId, path, component = null, extras = {}) => ({
  id, parentId, path, component, name: path, type: component ? 2 : 1,
  componentName: `Menu${id}`, permission: '', status: 0, visible: 1, ...extras
})
const menuRows = [
  menu('1', '0', '/cost-management'),
  menu('2', '1', 'workbench', 'cost-management/index.vue'),
  menu('3', '1', 'modeling'),
  menu('4', '3', 'control-rules', 'cost-management/section/index.vue?page=control-rules'),
  menu('5', '1', 'settings'),
  menu('6', '5', 'validation-threshold', 'cost-management/section/index.vue?page=validation-threshold'),
  menu('7', '1', '/__legacy__/business-menu/cost-management', null, { visible: 0 }),
  menu('8', '7', 'workbench', 'cost-management/index')
]
const inventoryResult = (rows = menuRows) => ({
  available: true, rows: [['total', String(rows.length)],
    ...rows.map((row) => ['menu', JSON.stringify(row)])]
})
const permissionInfo = { code: 0, data: { menus: [{
  ...menuRows[0], children: [{ ...menuRows[1] }]
}] } }
const readSql = async (sql) => {
  if (sql === COST_ENTERPRISE_MENU_SQL) return inventoryResult()
  if (sql.includes('information_schema.columns')) return { available: true, rows: schemaRows }
  assert.match(sql, /WHERE tenant_id = 1/)
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE)\b/i)
  assert.match(sql, /CAST\(`deleted` AS UNSIGNED\)/)
  return { available: true, rows: factRows }
}
const snapshot = async () => readCostEnterpriseFactSnapshot(readSql)
const record = () => ({ id: 'COST-007', checks: [], notes: [], evidence: [] })
const rejectionApi = (override = (response) => response) => ({
  request: async (method, path, body, options) => {
    assert.equal(method, 'POST')
    assert.equal(path, '/cost/verification/production-trial')
    const expected = body.enterpriseType === 'TRADE' ? COST_ENTERPRISE_TRADE_REJECTION
      : costEnterprisePurchaseRejection(body.sourceFacts[0].sourceNo)
    assert.deepEqual(options.expectedBusinessRejection, expected)
    return override({ code: expected.code, msg: expected.message }, body)
  }
})

test('COST-007 exact rejection contracts and six source aliases match the real service/controller', () => {
  const service = fs.readFileSync(new URL(
    '../../../../cfor/cfor-admin/cfor-module-fms/cfor-module-fms-biz/src/main/java/tech/cfor17/module/cost/service/impl/CostVerificationServiceImpl.java',
    import.meta.url), 'utf8')
  const controller = fs.readFileSync(new URL(
    '../../../../cfor/cfor-admin/cfor-module-fms/cfor-module-fms-biz/src/main/java/tech/cfor17/module/cost/controller/admin/CostVerificationController.java',
    import.meta.url), 'utf8')
  assert.ok(service.includes(`"${COST_ENTERPRISE_TRADE_REJECTION.message}"`))
  assert.ok(service.includes('"采购成本不能直接等于生产材料成本：" + value(fact.getSourceNo())'))
  for (const source of COST_ENTERPRISE_PURCHASE_SOURCES) assert.ok(service.includes(`"${source}"`))
  assert.ok(controller.includes('"WF-001".equals(exception.getCode()) ? 422001 : 422099'))
  assert.ok(controller.includes('exception.getMessage()'))
})

test('COST-007 snapshots cover every schema column, BIT values, row identities and tenant1 without writes', async () => {
  const result = await snapshot()
  assert.equal(result.cost_period.count, 1)
  assert.deepEqual(result.cost_period.rows, [{ id: '12', hash: digest }])
  assert.equal(result.cost_workflow_request.columns.length, 4)
  for (const badSchema of [
    schemaRows.filter((row) => !(row[0] === 'column' && row[2] === 'status')),
    schemaRows.map((row) => row[2] === 'status' ? [...row.slice(0, 2), 'x); DROP TABLE x', row[3]] : row),
    schemaRows.filter((row) => row[1] !== 'cost_workflow_request')
  ]) await assert.rejects(readCostEnterpriseFactSnapshot(async () => ({
    available: true, rows: badSchema
  })))
  for (const rows of [
    factRows.filter((row) => row[0] !== 'row'),
    factRows.map((row) => row[0] === 'row' ? [...row.slice(0, 3), 'bad'] : row),
    [...factRows, ['row', 'cost_period', '12', digest]]
  ]) await assert.rejects(readCostEnterpriseFactSnapshot(async (sql) => ({
    available: true, rows: sql.includes('information_schema.columns') ? schemaRows : rows
  })))
  await assert.rejects(readCostEnterpriseFactSnapshot(async () => ({ available: false, rows: [] })))
})

test('COST-007 performs seven exact semantic rejections and independently proves both groups unchanged', async () => {
  const caseRecord = record()
  const result = await verifyCostEnterpriseRejections({
    api: rejectionApi(), caseRecord, period, tenantId: '1', readSnapshot: snapshot
  })
  assert.equal(result.trade.attempts.length, 1)
  assert.equal(result.purchase.attempts.length, 6)
  assert.equal(result.purchase.attempts.find((row) =>
    row.body.sourceFacts[0].sourceType === 'PURCHASE_RECEIPT').msg,
  '采购成本不能直接等于生产材料成本：E2E-GR-001')
  assert.ok(caseRecord.checks.every((row) => row.passed === true))
  costCatalogEvidence('COST-007', caseRecord)
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.status), ['VERIFIED', 'VERIFIED', 'GAP'])
  assert.equal(caseRecord.passCandidate, false)
})

test('COST-007 generic 422001, another semantic cause, wrong echoed source and auth/service codes never verify rejection', async () => {
  for (const change of [
    { code: 422001, msg: '生产型成本试算来源事实不能为空' },
    { code: 422001, msg: 'unsupported allocation mode' },
    { code: 422001, msg: '采购成本不能直接等于生产材料成本：OTHER' },
    { code: 401, msg: COST_ENTERPRISE_TRADE_REJECTION.message },
    { code: 500, msg: COST_ENTERPRISE_TRADE_REJECTION.message },
    { code: 0, msg: COST_ENTERPRISE_TRADE_REJECTION.message }
  ]) {
    const caseRecord = record()
    await verifyCostEnterpriseRejections({
      api: rejectionApi(() => change), caseRecord, period, tenantId: '1', readSnapshot: snapshot
    })
    costCatalogEvidence('COST-007', caseRecord)
    assert.equal(caseRecord.catalogAssertions[0].status, 'GAP')
    assert.equal(caseRecord.catalogAssertions[1].status, 'GAP')
    assert.equal(caseRecord.passCandidate, false)
  }
})

test('COST-007 one incorrect purchase alias fails the whole procurement-source assertion', async () => {
  const caseRecord = record()
  await verifyCostEnterpriseRejections({
    api: rejectionApi((response, body) => body.sourceFacts[0]?.sourceType === 'PURCHASE_RETURN'
      ? { ...response, msg: 'OTHER' } : response),
    caseRecord, period, tenantId: '1', readSnapshot: snapshot
  })
  costCatalogEvidence('COST-007', caseRecord)
  assert.equal(caseRecord.catalogAssertions[0].status, 'VERIFIED')
  assert.equal(caseRecord.catalogAssertions[1].status, 'GAP')
})

test('COST-007 failed requests still capture after-facts; changed formal rows fail the unchanged check', async () => {
  const caseRecord = record()
  let reads = 0
  await assert.rejects(verifyCostEnterpriseRejections({
    api: { request: async () => { throw new Error('request failed') } },
    caseRecord, period, tenantId: '1', readSnapshot: async () => { reads++; return snapshot() }
  }), /request failed/)
  assert.equal(reads, 2)
  assert.equal(caseRecord.costEnterpriseRejections.trade.unchanged, true)
  assert.equal(caseRecord.checks.find((row) => row.name === COST_ENTERPRISE_CHECKS.trade).passed, false)
  const changedRecord = record()
  reads = 0
  await verifyCostEnterpriseRejections({
    api: rejectionApi(), caseRecord: changedRecord, period, tenantId: '1',
    readSnapshot: async () => {
      const result = await snapshot()
      if (++reads % 2 === 0) result.cost_period.rows[0].hash = 'b'.repeat(64)
      return result
    }
  })
  assert.ok(changedRecord.checks.filter((row) => row.name.includes('台账不变'))
    .every((row) => row.passed === false))
  costCatalogEvidence('COST-007', changedRecord)
  assert.ok(changedRecord.catalogAssertions.every((row) => row.status === 'GAP'))
})

test('COST-007 empty fact tables and non-tenant1 context cannot produce acceptance proof', async () => {
  const caseRecord = record()
  await verifyCostEnterpriseRejections({
    api: rejectionApi(), caseRecord, period, tenantId: '1',
    readSnapshot: async () => ({
      cost_period: { count: 0, rows: [] }, cost_workflow_request: { count: 0, rows: [] }
    })
  })
  costCatalogEvidence('COST-007', caseRecord)
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
  assert.equal(caseRecord.notes.filter((row) => row.includes('空表不变')).length, 2)
  await assert.rejects(verifyCostEnterpriseRejections({
    api: rejectionApi(), caseRecord: record(), period, tenantId: '2', readSnapshot: snapshot
  }), /tenant1/)
})

test('COST-007 complete menu census resolves absolute legacy aliases and includes hidden/disabled entries', () => {
  const rows = parseCostEnterpriseMenuInventory(inventoryResult([
    ...menuRows, menu('9', '1', 'disabled-settings', 'other/cost/index', { status: 1, visible: 0 })
  ]))
  assert.equal(rows.find((row) => row.id === '2').route, '/cost-management/workbench')
  const legacy = rows.find((row) => row.id === '8')
  assert.equal(legacy.route, '/__legacy__/business-menu/cost-management/workbench')
  assert.equal(legacy.enabled, true)
  assert.equal(legacy.visible, false)
  assert.equal(rows.find((row) => row.id === '9').enabled, false)
  assert.doesNotMatch(COST_ENTERPRISE_MENU_SQL, /(?:AND|WHERE)\s+(?:status|visible|type)\s*=/i)
})

test('COST-007 empty/truncated/duplicate/orphan/cyclic menu inventories fail closed', () => {
  for (const result of [
    inventoryResult([]),
    { ...inventoryResult(), rows: inventoryResult().rows.slice(0, -1) },
    inventoryResult([...menuRows, menuRows[0]]),
    inventoryResult([menu('2', '99', 'workbench', 'cost-management/index')]),
    inventoryResult([menu('1', '2', 'a'), menu('2', '1', 'b')]),
    { available: false, rows: [] }
  ]) assert.throws(() => parseCostEnterpriseMenuInventory(result))
})

test('COST-007 read-only API/SQL audit proves component reuse but preserves legacy/settings scope GAP', async () => {
  const api = {
    getBusiness: async (path) => {
      assert.equal(path, '/system/auth/get-permission-info')
      return permissionInfo
    },
    request: () => assert.fail('route audit cannot write'),
    postBusiness: () => assert.fail('route audit cannot write')
  }
  const audit = await auditCostEnterpriseRoutes({ api, tenantId: '1', readSql })
  assert.equal(audit.workbench.component, 'cost-management/index.vue')
  assert.equal(audit.inventory.count, 8)
  assert.equal(audit.reusedComponent, true)
  assert.equal(audit.noParallelSettingsVerified, false)
  assert.equal(audit.assertionStatus, 'GAP')
  assert.equal(audit.workbenches.length, 2)
  assert.equal(audit.controlRules.length, 1)
  assert.equal(audit.thresholds.length, 1)
  assert.ok(audit.gaps.some((gap) => gap.includes('legacy')))
  assert.ok(audit.gaps.some((gap) => gap.includes('validation-threshold')))
  assert.equal(audit.sources.registry.thresholdAliasedToFormalRules, false)
  for (const source of Object.values(readCostEnterpriseSourceBoundaries())) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/)
    assert.ok(source.path.startsWith('/Users/liuqiang/code/cfor-standard/'))
  }
})

test('COST-007 database menus never replace actual actor permissions; foreign components remain boundary gaps', async () => {
  for (const payload of [
    { code: 0, data: { menus: [] } },
    { code: 0, data: { menus: [{ ...menuRows[0], children: [] }] } },
    { code: 403, msg: 'Forbidden' }
  ]) await assert.rejects(auditCostEnterpriseRoutes({
    api: { getBusiness: async () => payload }, tenantId: '1', readSql
  }))
  const audit = await auditCostEnterpriseRoutes({
    api: { getBusiness: async () => permissionInfo }, tenantId: '1',
    readSql: async () => inventoryResult([...menuRows,
      menu('9', '1', 'new-settings', 'erp/cost-setting/index', { name: '其他成本设置' })])
  })
  assert.equal(audit.foreignComponents.length, 1)
  assert.equal(audit.noParallelSettingsVerified, false)
})

const fakePage = (change = {}) => ({
  url: () => 'http://127.0.0.1:9151/cost-management/workbench',
  locator: (selector) => selector === 'body' ? {
    innerText: async () => '成本工作台 成本可计算 正式写入需人工确认'
  } : {
    waitFor: async () => {}, count: async () => 1,
    getByRole: (role, options) => {
      assert.equal(role, 'heading')
      assert.deepEqual(options, { name: '成本工作台', exact: true })
      return { count: async () => 1 }
    }
  }, ...change
})

test('COST-007 workbench proof requires exact route, official root, heading and actual contents', async () => {
  const audit = { workbench: { route: '/cost-management/workbench', component: 'cost-management/index.vue' } }
  assert.equal((await verifyCostEnterpriseWorkbench(fakePage(), audit)).route, audit.workbench.route)
  for (const change of [
    { url: () => 'http://127.0.0.1:9151/other' },
    { locator: () => ({ waitFor: async () => {}, count: async () => 0 }) },
    { locator: (selector) => selector === 'body'
      ? { innerText: async () => '成本工作台 成本可计算 正式写入需人工确认 404' }
      : fakePage().locator(selector) },
    { locator: (selector) => selector === 'body'
      ? { innerText: async () => '成本' } : fakePage().locator(selector) }
  ]) await assert.rejects(verifyCostEnterpriseWorkbench(fakePage(change), audit))
})

test('COST-007 suite integrates exact negative/unchanged/menu/page evidence and cannot mark original third assertion PASS', async () => {
  const caseRecord = record()
  const api = {
    ...rejectionApi(),
    getBusiness: async (path) => path === '/system/auth/get-permission-info' ? permissionInfo : {
      code: 0, data: { list: [{ id: '1', versionNo: 'EXISTING', status: 'LOCKED' }], total: 1 }
    }
  }
  let screenshot
  const result = await runCase({
    caseId: 'COST-007', page: fakePage(),
    record: { runId: 'COST-007-UNIT', environment: { tenantId: '1' } }, caseRecord, outputDir: '/unit-only'
  }, {
    login: async () => 'unit-only-token', createApiClient: () => api,
    costEnterpriseReadSql: readSql,
    openRoute: async (page, route, options) => {
      assert.equal(route, '/cost-management/workbench')
      assert.equal(options.readySelector, '.cost-workbench')
    },
    saveScreenshot: async (page, dir, name) => { screenshot = name; return `/unit-only/${name}.png` }
  })
  assert.equal(result.partial, true)
  assert.equal(screenshot, 'cost-enterprise-type-isolation')
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.status), ['VERIFIED', 'VERIFIED', 'GAP'])
  assert.equal(caseRecord.passCandidate, false)
  assert.equal(caseRecord.costEnterpriseRouteEvidence.browser.route, '/cost-management/workbench')
  assert.equal(costCatalogBindings['COST-007'][2], undefined)
  for (const field of ['trade', 'purchase']) assert.equal(caseRecord.costEnterpriseRejections[field].unchanged, true)
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const original = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'COST-007')
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.assertion), original.assertions)
})
