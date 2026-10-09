import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSafeScope,
  catalogDefinition,
  cases,
  initRoutes,
  initReadinessFactSql,
  INIT_READINESS_FACT_KEYS,
  initializeCatalogAssertions,
  inspectLogoFields,
  isAllowedRequest,
  isForbiddenRequest,
  presetConfirmButtonSelector,
  presetConfirmButtonText,
  readinessClassification,
  validateInitReadinessFacts
} from '../fixtures/init-gaps.mjs'

const local = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { name: 'cfor_admin_standard' }
}

test('init gap fixture owns exactly the requested catalog cases', () => {
  assert.deepEqual([...cases], ['INIT-002', 'INIT-003', 'INIT-004', 'INIT-005', 'PB001-002'])
  for (const caseId of cases) {
    const definition = catalogDefinition(caseId)
    assert.ok(definition.assertions.length > 0)
  }
})

test('scope rejects non-local endpoints, wrong tenant, and credential-bearing URLs', () => {
  assert.doesNotThrow(() => assertSafeScope(local))
  for (const change of [
    { target: 'production' },
    { tenantId: '2' },
    { tenantName: 'other' },
    { db: { name: 'cfor_admin_saas' } },
    { apiBase: 'http://127.0.0.1:48084' },
    { webBase: 'https://example.invalid:9151' },
    { apiBase: 'http://user:secret@127.0.0.1:48083' }
  ]) assert.throws(() => assertSafeScope({ ...local, ...change }), /BLOCKED:/)
})

test('allowlist permits only read and preview calls and rejects every write surface', () => {
  for (const [method, path] of [
    ['GET', '/system/system-init/state'],
    ['GET', '/system/system-init/readiness'],
    ['GET', '/system/system-init/preset/catalog'],
    ['GET', '/system/auth/get-permission-info'],
    ['GET', '/system/enterprise-organization/current'],
    ['POST', '/system/system-init/preset/preview']
  ]) assert.equal(isAllowedRequest(method, path), true)
  for (const [method, path] of [
    ['POST', '/system/system-init/preset/apply'],
    ['PUT', '/system/system-init/state'],
    ['POST', '/system/system-init/skip?key=erp.opening&skipped=true'],
    ['PUT', '/system/system-init/subsystems'],
    ['PUT', '/system/enterprise-organization/current'],
    ['POST', '/system/file/upload']
  ]) {
    assert.equal(isForbiddenRequest(method, path), true)
    assert.equal(isAllowedRequest(method, path), false)
  }
})

test('catalog mapping preserves every assertion and keeps unproven work as GAP', () => {
  const record = { checks: [] }
  initializeCatalogAssertions(record, 'INIT-002', new Map([[0, { status: 'VERIFIED' }]]))
  const definition = catalogDefinition('INIT-002')
  assert.deepEqual(record.catalogAssertions.map((item) => item.assertion), definition.assertions)
  assert.equal(record.catalogAssertions[0].status, 'VERIFIED')
  assert.ok(record.catalogAssertions.slice(1).every((item) => item.status === 'GAP'))
  assert.equal(record.readyCandidate, false)
})

test('INIT-005 catalog mapping preserves GAP reasons without upgrading assertions', () => {
  const record = { checks: [] }
  initializeCatalogAssertions(record, 'INIT-005', new Map([
    [0, { status: 'GAP', reason: 'WMS topology not checked' }],
    [1, { status: 'GAP', reason: 'skip API round trip not executed' }],
    [2, { status: 'GAP', reason: 'facts-before/after not captured' }],
    [3, { status: 'VERIFIED', evidence: 'default migration plus read-only snapshot' }]
  ]))
  assert.equal(record.catalogAssertions.length, 4)
  assert.deepEqual(record.catalogAssertions.map((item) => item.status), [
    'GAP', 'GAP', 'GAP', 'VERIFIED'
  ])
  assert.deepEqual(record.remainingAssertions.map((item) => item.reason), [
    'WMS topology not checked', 'skip API round trip not executed', 'facts-before/after not captured'
  ])
  assert.equal(record.readyCandidate, false)
})

test('headed init routes and preset confirmation locator match the current Web contract', () => {
  assert.equal(initRoutes.overview, '/systemInit/index')
  assert.equal(
    initRoutes.enterpriseOrganization,
    '/systemModel/base/organization/enterprise-organization'
  )
  assert.equal(presetConfirmButtonSelector, '.init-preset__actions button')
  assert.equal(presetConfirmButtonText, '查看并确认预置')
  assert.match(presetConfirmButtonSelector, /init-preset__actions/)
})

test('readiness classification requires structured items and distinguishes opening/account-set', () => {
  const payload = {
    code: 0,
    data: {
      items: [
        { key: 'erp.material', module: 'erp', status: 'READY', skippable: false },
        { key: 'mes.bas-unit', module: 'mes', status: 'INCOMPLETE', skippable: false },
        { key: 'erp.supplier', module: 'erp', status: 'READY', skippable: false },
        { key: 'erp.customer', module: 'erp', status: 'READY', skippable: false },
        { key: 'erp.account', module: 'erp', status: 'READY', skippable: false },
        { key: 'wms.warehouse', module: 'wms', status: 'READY', skippable: false },
        { key: 'fms.account-set', module: 'fms', status: 'NOT_STARTED', skippable: false },
        { key: 'wms.opening-stock', module: 'wms', status: 'SKIPPED', skippable: true },
        { key: 'integration.connection', module: 'integration', status: 'UNKNOWN', skippable: false }
      ]
    }
  }
  const result = readinessClassification(payload)
  for (const name of ['material', 'unit', 'supplier', 'customer', 'account', 'warehouse', 'accountSet']) {
    assert.ok(result.categories[name].length > 0, name)
  }
  assert.equal(result.opening.length, 1)
  assert.equal(result.opening[0].skippable, true)
  assert.equal(result.unknown, true)
  assert.deepEqual(readinessClassification({ code: 0, data: {} }).items, null)
})

function readinessItems (counts, statuses = {}) {
  return [
    ['erp.material', 'material'],
    ['erp.unit', 'unit'],
    ['erp.supplier', 'supplier'],
    ['erp.customer', 'customer'],
    ['erp.account', 'account'],
    ['wms.base', 'warehouse'],
    ['fms.account-set', 'accountSet']
  ].map(([key, fact]) => ({
    key,
    count: counts[fact],
    status: statuses[fact] || (counts[fact] > 0 ? 'READY' : 'NOT_STARTED')
  }))
}

test('INIT-005 official fact SQL is tenant-scoped and uses WMS wms.base source', () => {
  const sql = initReadinessFactSql(1)
  assert.doesNotThrow(() => initReadinessFactSql(1))
  assert.throws(() => initReadinessFactSql(2), /tenant_id=1/)
  assert.doesNotMatch(sql, /erp_warehouse/)
  assert.match(sql, /mes_wms_ware_house/)
  for (const table of [
    'mes_bas_material', 'mes_bas_unit', 'base_partner', 'erp_account',
    'mes_wms_ware_house', 'fms_account_set'
  ]) assert.match(sql, new RegExp(`${table}[\\s\\S]*tenant_id = 1`))
  for (const key of INIT_READINESS_FACT_KEYS) assert.match(sql, new RegExp(`'${key}'`))
})

test('INIT-005 rejects cross-tenant/unscoped counts and missing or wrong official counts', () => {
  const counts = { material: 420, unit: 5, supplier: 2, customer: 3, account: 4, warehouse: 1, accountSet: 1 }
  const rows = INIT_READINESS_FACT_KEYS.map((key) => [key, String(counts[key])])
  const items = readinessItems(counts)
  assert.equal(validateInitReadinessFacts(rows, items).valid, true)

  const crossTenantRows = rows.map(([key, value]) =>
    [key, key === 'material' ? '423' : key === 'unit' ? '11' : value])
  assert.equal(validateInitReadinessFacts(crossTenantRows, items).valid, false)

  assert.equal(validateInitReadinessFacts(rows.slice(1), items).valid, false)
  const wrongRows = rows.map(([key, value]) => [key, key === 'accountSet' ? '0' : value])
  assert.equal(validateInitReadinessFacts(wrongRows, items).valid, false)
})

test('INIT-005 permits empty facts only with a non-ready status', () => {
  const counts = { material: 0, unit: 0, supplier: 0, customer: 0, account: 0, warehouse: 0, accountSet: 0 }
  const rows = INIT_READINESS_FACT_KEYS.map((key) => [key, '0'])
  assert.equal(validateInitReadinessFacts(rows, readinessItems(counts)).valid, true)
  assert.equal(validateInitReadinessFacts(rows, readinessItems(counts, { material: 'READY' })).valid, false)
})

test('logo inspection requires actual labeled fields and does not infer save behavior', () => {
  assert.deepEqual(inspectLogoFields([
    { label: '图形标识', required: false, hasRequiredMark: false },
    { label: '黑字完整 Logo', required: false, hasRequiredMark: false },
    { label: '白字完整 Logo', required: false, hasRequiredMark: false }
  ]), { found: 2, optional: true })
  assert.equal(inspectLogoFields([{ label: '黑字完整 Logo', required: true }]).optional, false)
  assert.equal(inspectLogoFields([{ label: '企业名称', required: false }]).optional, false)
})
