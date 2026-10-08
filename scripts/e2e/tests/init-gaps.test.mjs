import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSafeScope,
  catalogDefinition,
  cases,
  initRoutes,
  initializeCatalogAssertions,
  inspectLogoFields,
  isAllowedRequest,
  isForbiddenRequest,
  presetConfirmButtonSelector,
  presetConfirmButtonText,
  readinessClassification
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

test('logo inspection requires actual labeled fields and does not infer save behavior', () => {
  assert.deepEqual(inspectLogoFields([
    { label: '图形标识', required: false, hasRequiredMark: false },
    { label: '黑字完整 Logo', required: false, hasRequiredMark: false },
    { label: '白字完整 Logo', required: false, hasRequiredMark: false }
  ]), { found: 2, optional: true })
  assert.equal(inspectLogoFields([{ label: '黑字完整 Logo', required: true }]).optional, false)
  assert.equal(inspectLogoFields([{ label: '企业名称', required: false }]).optional, false)
})
