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
  validateInitReadinessFacts,
  validateWmsTopology
} from '../fixtures/init-gaps.mjs'
import {
  localInitCases,
  localInitEvidence,
  runIsolatedLocalInitCase,
  validateInitialEnterpriseShape,
  buildInitialEnterpriseShapeSql,
  buildConfigSnapshotSql,
  buildDedicatedLogoPersistenceSql,
  routeByComponent
} from '../fixtures/init-local-closure.mjs'

const local = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { name: 'cfor_admin_standard' }
}

test('init gap fixture owns exactly the requested catalog cases', () => {
  assert.deepEqual([...cases], [
    'INIT-002', 'INIT-003', 'INIT-004', 'INIT-005', 'PB001-001', 'PB001-002'
  ])
  for (const caseId of cases) {
    const definition = catalogDefinition(caseId)
    assert.ok(definition.assertions.length > 0)
  }
})

test('every isolated local init case is connected to the gap suite dispatcher', () => {
  assert.deepEqual([...localInitCases], ['INIT-002', 'INIT-003', 'INIT-004', 'PB001-001', 'PB001-002'])
  for (const caseId of localInitCases) assert.ok(cases.includes(caseId), caseId)
})

test('enterprise page route follows the complete real permission-menu path', () => {
  const menus = [{
    path: 'systemModel',
    children: [{
      path: 'base',
      children: [{
        path: 'organization',
        children: [{
          path: 'enterprise-organization',
          component: 'system/enterprise-organization/index'
        }]
      }]
    }]
  }]
  assert.equal(
    routeByComponent(menus, 'system/enterprise-organization/index'),
    '/systemModel/base/organization/enterprise-organization'
  )
  assert.equal(routeByComponent(menus, 'missing/component'), null)
})

test('new tenant initial enterprise shape accepts owned template branding but requires empty profile data', () => {
  const valid = validateInitialEnterpriseShape({
    registrationName: 'E2E TENANT',
    enterpriseFullName: null,
    enterpriseLogoUrl: null,
    brandMarkUrl: '/logo/cfor-logo-mark.png',
    brandLogoUrl: '/logo/cfor-logo.png',
    brandDarkLogoUrl: '/logo/cfor-logo.png'
  }, [
    ['organization', '0', '', '', '', '', '', ''],
    ['tenant-brand', '1', '9007199254740999', '/logo/cfor-logo-mark.png',
      '/logo/cfor-logo.png', '/logo/cfor-logo.png', '', ''],
    ['template-brand', '1', '/logo/cfor-logo-mark.png', '/logo/cfor-logo.png',
      '/logo/cfor-logo.png', '', '', '']
  ], '9007199254740999')
  assert.equal(valid.tenantBrandOwned, true)
  assert.throws(() => validateInitialEnterpriseShape({
    enterpriseFullName: 'foreign data', enterpriseLogoUrl: null,
    brandMarkUrl: '/logo/cfor-logo-mark.png', brandLogoUrl: '/logo/cfor-logo.png',
    brandDarkLogoUrl: '/logo/cfor-logo.png'
  }, [
    ['organization', '1', '', '', '', '', '', ''],
    ['tenant-brand', '1', '9007199254740999', '/logo/cfor-logo-mark.png',
      '/logo/cfor-logo.png', '/logo/cfor-logo.png', '', ''],
    ['template-brand', '1', '/logo/cfor-logo-mark.png', '/logo/cfor-logo.png',
      '/logo/cfor-logo.png', '', '', '']
  ], '9007199254740999'), /新租户企业资料主表必须为空/)
})

test('new tenant initial enterprise shape rejects cross-tenant or non-template branding', () => {
  const base = {
    enterpriseFullName: null, enterpriseLogoUrl: null,
    brandMarkUrl: '/logo/cfor-logo-mark.png', brandLogoUrl: '/logo/cfor-logo.png',
    brandDarkLogoUrl: '/logo/cfor-logo.png'
  }
  const template = ['template-brand', '1', '/logo/cfor-logo-mark.png',
    '/logo/cfor-logo.png', '/logo/cfor-logo.png', '', '', '']
  assert.throws(() => validateInitialEnterpriseShape(base, [
    ['organization', '0', '', '', '', '', '', ''],
    ['tenant-brand', '1', '1', '/logo/cfor-logo-mark.png', '/logo/cfor-logo.png',
      '/logo/cfor-logo.png', '', ''], template
  ], '9007199254740999'), /不属于当前租户/)
  assert.throws(() => validateInitialEnterpriseShape({ ...base, brandLogoUrl: '/logo/other.png' }, [
    ['organization', '0', '', '', '', '', '', ''],
    ['tenant-brand', '1', '9007199254740999', '/logo/cfor-logo-mark.png', '/logo/cfor-logo.png',
      '/logo/cfor-logo.png', '', ''], template
  ], '9007199254740999'), /接口品牌字段与当前租户配置不一致/)
})

test('initial enterprise snapshot SQL follows the actual table schemas', () => {
  const sql = buildInitialEnterpriseShapeSql({
    tenantId: '9007199254740999',
    organizationColumns: [
      'tenant_id', 'enterprise_full_name', 'enterprise_short_name', 'enterprise_type',
      'unified_social_credit_code', 'industry_category', 'industry_sub_category',
      'taxpayer_qualification', 'province_code', 'city_code', 'district_code',
      'registered_address', 'enterprise_logo_url', 'deleted'
    ],
    configColumns: ['tenant_id', 'category', 'tag', 'config_data']
  })
  assert.match(sql, /system_enterprise_organization[\s\S]*deleted=0/)
  assert.match(sql, /FROM system_config[\s\S]*tag='common'/)
  assert.doesNotMatch(sql, /FROM system_config[\s\S]*deleted=0/)
  assert.throws(() => buildInitialEnterpriseShapeSql({
    tenantId: '1', organizationColumns: ['tenant_id'],
    configColumns: ['tenant_id', 'category', 'tag', 'config_data']
  }), /缺少初始形状所需正式字段/)
})

test('all system_config read-only snapshots omit deleted when the actual table omits it', () => {
  const configColumns = ['id', 'tenant_id', 'category', 'tag', 'config_data']
  const snapshot = buildConfigSnapshotSql({ tenantId: '9007199254740999', configColumns })
  const logo = buildDedicatedLogoPersistenceSql({
    tenantId: '9007199254740999',
    organizationColumns: ['tenant_id', 'enterprise_logo_url', 'deleted'],
    configColumns
  })
  assert.doesNotMatch(snapshot, /deleted=0/)
  assert.doesNotMatch(logo, /system_config[\s\S]*deleted=0/)
  assert.match(logo, /system_enterprise_organization[\s\S]*deleted=0/)
  assert.throws(() => buildConfigSnapshotSql({ tenantId: '1', configColumns: ['tenant_id'] }),
    /系统配置表缺少只读快照所需正式字段/)
  assert.throws(() => buildDedicatedLogoPersistenceSql({
    tenantId: '1', organizationColumns: ['tenant_id'], configColumns
  }), /企业资料表缺少 Logo 只读快照所需正式字段/)
})

test('local init closure reuses the runner platform session instead of treating options as credentials', async () => {
  const calls = []
  const context = {
    page: {},
    record: { api: [] },
    caseRecord: { checks: [], notes: [], database: [] }
  }
  const dependencies = {
    config: local,
    writeFixturesEnabled: true,
    async assertLocalWriteSafety () {},
    async login (page, options) {
      calls.push({ page, options })
      return { token: 'platform-token-12345678901234567890', tenantId: '1' }
    },
    createApiClient () {
      return {
        async getPermissionInfo () {
          return { data: { roles: ['super_admin'] } }
        },
        async getBusiness () {
          return { data: { id: '1', name: 'CFOR 标准平台' } }
        }
      }
    },
    async runEnterpriseIsolationEvidence () {
      return { executed: true }
    }
  }
  const result = await runIsolatedLocalInitCase(context, dependencies)
  assert.deepEqual(result, { executed: true })
  assert.deepEqual(calls, [{ page: context.page, options: { returnContext: true } }])
})

test('local init closure proves tenant1 from formal APIs when the cached login context has no tenant id', async () => {
  const context = {
    page: {},
    record: { api: [] },
    caseRecord: { checks: [], notes: [], database: [] }
  }
  const dependencies = {
    config: local,
    writeFixturesEnabled: true,
    async assertLocalWriteSafety () {},
    async login () {
      return { token: 'platform-token-12345678901234567890', tenantId: '' }
    },
    createApiClient () {
      return {
        async getPermissionInfo () {
          return { data: { roles: ['super_admin'] } }
        },
        async getBusiness (path) {
          assert.equal(path, '/system/tenant/get?id=1')
          return { data: { id: '1', name: 'CFOR 标准平台' } }
        }
      }
    },
    async runEnterpriseIsolationEvidence () {
      return { executed: true }
    }
  }
  assert.deepEqual(await runIsolatedLocalInitCase(context, dependencies), { executed: true })
})

test('local init closure rejects a token that is not formally a standard-platform super_admin session', async () => {
  const context = {
    page: {},
    record: { api: [] },
    caseRecord: { checks: [], notes: [], database: [] }
  }
  const dependencies = {
    config: local,
    writeFixturesEnabled: true,
    async assertLocalWriteSafety () {},
    async login () {
      return { token: 'platform-token-12345678901234567890', tenantId: '' }
    },
    createApiClient () {
      return {
        async getPermissionInfo () {
          return { data: { roles: ['tenant_admin'] } }
        },
        async getBusiness () {
          return { data: { id: '1', name: 'CFOR 标准平台' } }
        }
      }
    },
    async runEnterpriseIsolationEvidence () {
      throw new Error('must not create isolated resources')
    }
  }
  await assert.rejects(
    runIsolatedLocalInitCase(context, dependencies),
    /正式 API 证明为标准租户 1 super_admin/
  )
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
  const record = {
    checks: [{ name: 'preview evidence', passed: true }]
  }
  initializeCatalogAssertions(record, 'INIT-002', new Map([[
    0, { status: 'VERIFIED', evidenceChecks: ['preview evidence'] }
  ]]))
  const definition = catalogDefinition('INIT-002')
  assert.deepEqual(record.catalogAssertions.map((item) => item.assertion), definition.assertions)
  assert.equal(record.catalogAssertions[0].status, 'VERIFIED')
  assert.ok(record.catalogAssertions.slice(1).every((item) => item.status === 'GAP'))
  assert.equal(record.readyCandidate, false)
})

test('catalog mapping rejects bare, missing, duplicate, or failed named evidence', () => {
  for (const record of [
    { checks: [] },
    { checks: [{ name: 'preview evidence', passed: false }] },
    { checks: [
      { name: 'preview evidence', passed: true },
      { name: 'preview evidence', passed: true }
    ] }
  ]) {
    initializeCatalogAssertions(record, 'INIT-002', new Map([[
      0, { status: 'VERIFIED', evidenceChecks: ['preview evidence'] }
    ]]))
    assert.equal(record.catalogAssertions[0].status, 'GAP')
    assert.match(record.catalogAssertions[0].reason, /具名检查/)
  }

  const bare = { checks: [{ name: 'preview evidence', passed: true }] }
  initializeCatalogAssertions(bare, 'INIT-002', new Map([[0, { status: 'VERIFIED' }]]))
  assert.equal(bare.catalogAssertions[0].status, 'GAP')
  assert.deepEqual(bare.catalogAssertions[0].evidenceChecks, [])
})

test('isolated INIT-002/003/004 evidence maps remain fully named and verifiable', () => {
  for (const caseId of ['INIT-002', 'INIT-003', 'INIT-004']) {
    const record = {
      checks: Object.values(localInitEvidence[caseId]).flatMap((entry) =>
        entry.checks.map((name) => ({ name, passed: true })))
    }
    const mapping = new Map(Object.entries(localInitEvidence[caseId]).map(([index, entry]) => [
      Number(index), { status: 'VERIFIED', evidenceChecks: entry.checks }
    ]))
    initializeCatalogAssertions(record, caseId, mapping)
    assert.equal(record.catalogAssertions.every((item) => item.status === 'VERIFIED'), true, caseId)
    assert.equal(record.catalogAssertions.every((item) =>
      item.evidenceChecks.length > 0 && item.evidenceChecks.every((name) =>
        record.checks.filter((check) => check.name === name).length === 1)), true, caseId)
  }
})

test('INIT-005 catalog mapping preserves GAP reasons without upgrading assertions', () => {
  const record = {
    checks: [{ name: 'job disabled evidence', passed: true }]
  }
  initializeCatalogAssertions(record, 'INIT-005', new Map([
    [0, { status: 'GAP', reason: 'WMS topology not checked' }],
    [1, { status: 'GAP', reason: 'skip API round trip not executed' }],
    [2, { status: 'GAP', reason: 'facts-before/after not captured' }],
    [3, {
      status: 'VERIFIED',
      evidence: 'default migration plus read-only snapshot',
      evidenceChecks: ['job disabled evidence']
    }]
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

test('INIT-005 compares ERP compatibility rows with all non-deleted warehouses, not only enabled warehouses', () => {
  const topology = {
    warehouse: 415,
    'warehouse-total': 486,
    area: 331,
    location: 391,
    'orphan-area': 0,
    'orphan-location': 0,
    'erp-view': 1,
    'erp-rows': 486
  }
  assert.equal(validateWmsTopology(topology, 'READY').valid, true)
  assert.match(validateWmsTopology({ ...topology, 'orphan-location': 25 }, 'READY').reason, /孤立库位/)
  assert.match(validateWmsTopology({ ...topology, 'erp-rows': 415 }, 'READY').reason, /行数/)
})

test('logo inspection requires actual labeled fields and does not infer save behavior', () => {
  assert.deepEqual(inspectLogoFields([
    { label: '图形标识', required: false, hasRequiredMark: false },
    { label: '黑字完整 Logo', required: false, hasRequiredMark: false },
    { label: '白字完整 Logo', required: false, hasRequiredMark: false }
  ]), { found: 3, optional: true })
  assert.equal(inspectLogoFields([{ label: '黑字完整 Logo', required: true }]).optional, false)
  assert.equal(inspectLogoFields([{ label: '企业名称', required: false }]).optional, false)
})
