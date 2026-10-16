import test from 'node:test'
import assert from 'node:assert/strict'
import { runCase } from '../suites/iot-maintenance.mjs'
import {
  assertLegacyLocalTarget, buildLegacySnapshotSql, hasCompleteLegacySnapshot,
  hasConservedLegacySummary, hasLegacyPageContract, legacyMetadataSql,
  legacyCandidateMetadataSql, buildLegacyCandidateCountSql, legacyLedgerSql,
  legacySnapshotDigest, summarizeLegacyCandidates, verifyLegacyReadonly,
  createLegacyMappingPageOpener, resolveLegacyMappingMenuRoute, hasLegacyBrowserReadEvidence
} from '../fixtures/maintenance-legacy-closure.mjs'

const permissionMenus = [{
  path: '/iot', children: [{
    path: 'device', children: [{
      id: 58800363, path: 'device-legacy-mapping', name: '设备引用对账',
      component: 'mes/device/legacyMapping/index'
    }]
  }]
}]

const local = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const tables = ['equipment_info', 'mes_wms_site_equipment', 'iot_device', 'mes_device_legacy_mapping']
const metadata = tables.flatMap((table) =>
  (table === 'equipment_info' ? ['id', 'name', 'sn', 'qr_code'] : ['id', 'tenant_id', 'deleted'])
    .map((column) => [table, column]))
const candidateMetadata = [
  ['cfor_admin_zhongneng', 'equipment_info', 'id'],
  ['cfor_admin_zhongneng', 'equipment_info', 'name'],
  ['cfor_admin_zhongneng', 'mes_wms_site_equipment', 'id'],
  ['cfor_admin_zhongneng', 'mes_wms_site_equipment', 'tenant_id'],
  ['cfor_admin_zhongneng', 'mes_wms_site_equipment', 'deleted']
]
const snapshot = (hash = 'a'.repeat(64)) => tables.flatMap((table) => [
  ['table', table, table === 'iot_device' ? '1' : '0'],
  ...(table === 'iot_device' ? [['row', table, '9007199254740993', hash]] : [])
])
const empty = { total: 0, matched: 0, ambiguous: 0, unmatched: 0 }
const matched = {
  id: '9007199254740993', legacyTable: 'equipment_info', legacyId: '1',
  legacyCode: 'CODE1', legacyName: 'legacy name', iotDeviceId: '9007199254740994',
  iotDeviceName: 'device name', matchStatus: 'MATCHED', matchType: 'CODE'
}
const record = () => ({ checks: [], notes: [], evidence: [] })

const fixture = ({ summary = empty, page = { list: [], total: 0 }, changed = false,
  available = true, queryFailure, candidates = false } = {}) => {
  const caseRecord = record()
  const calls = []
  let snapshots = 0
  const read = async (sql) => {
    calls.push(['SQL', sql])
    if (!available) return { available: false, rows: [], reason: 'database not configured' }
    if (sql === legacyMetadataSql) return { available: true, rows: metadata }
    if (sql === legacyCandidateMetadataSql) {
      return { available: true, rows: candidates ? candidateMetadata : [] }
    }
    if (candidates && sql === buildLegacyCandidateCountSql(candidateMetadata)) {
      return { available: true, rows: [
        ['candidate-source', 'cfor_admin_zhongneng', 'equipment_info', '22', 'NULL', 'NULL'],
        ['candidate-source', 'cfor_admin_zhongneng', 'mes_wms_site_equipment', '22', '1', '22']
      ] }
    }
    if (sql === legacyLedgerSql) return { available: true, rows: [
      ['source', 'equipment_info', '0'], ['source', 'mes_wms_site_equipment', '0'],
      ['summary', '0', '0', '0', '0']
    ] }
    snapshots++
    return { available: true, rows: snapshot(changed && snapshots > 1 ? 'b'.repeat(64) : undefined) }
  }
  const api = {
    getBusiness: async (path) => {
      calls.push(['GET', path])
      if (queryFailure) throw queryFailure
      if (path === '/system/auth/get-permission-info') {
        return { code: 0, data: { menus: permissionMenus } }
      }
      return { code: 0, data: path.endsWith('/summary') ? summary : page }
    },
    postBusiness: async () => assert.fail('must never POST reconcile or create legacy sources'),
    putBusiness: async () => assert.fail('must never edit legacy sources'),
    deleteBusiness: async () => assert.fail('must never delete mappings or sources')
  }
  return { api, caseRecord, calls, read, dependencies: { config: local, runReadOnlySql: read } }
}

test('local guard rejects other tenants, databases, hosts and ports before reading', () => {
  assert.doesNotThrow(() => assertLegacyLocalTarget(local))
  for (const settings of [
    { ...local, target: 'online' }, { ...local, tenantId: '2' },
    { ...local, apiBase: 'http://127.0.0.1:48080' },
    { ...local, webBase: 'http://example.test:9151' },
    { ...local, db: { ...local.db, name: 'cfor_admin_saas_standard' } }
  ]) assert.throws(() => assertLegacyLocalTarget(settings))
})

test('snapshot hashes every column without returning credentials and protects all mappings', () => {
  const sql = buildLegacySnapshotSql([...metadata, ['iot_device', 'device_secret']])
  assert.match(sql, /'device_secret', HEX\(`device_secret`\)/)
  assert.match(sql, /SHA2\(CAST\(JSON_OBJECT/)
  assert.match(sql, /FROM `iot_device` WHERE tenant_id=1/)
  assert.doesNotMatch(sql, /FROM `mes_device_legacy_mapping` WHERE/)
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE|INSERT|REPLACE)\s/i)
  assert.doesNotMatch(sql, /deleted\s*=/i)
})

test('historical candidate inventory is exact, read-only, isolated, and never treated as approval', () => {
  const sql = buildLegacyCandidateCountSql(candidateMetadata)
  assert.match(sql, /FROM `cfor_admin_zhongneng`\.`equipment_info`/)
  assert.match(sql, /FROM `cfor_admin_zhongneng`\.`mes_wms_site_equipment`/)
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE|INSERT|REPLACE)\s/i)
  assert.throws(() => buildLegacyCandidateCountSql([
    ['cfor;drop', 'equipment_info', 'id']
  ]))
  const inventory = summarizeLegacyCandidates(candidateMetadata, [
    ['candidate-source', 'cfor_admin_zhongneng', 'equipment_info', '22', 'NULL', 'NULL'],
    ['candidate-source', 'cfor_admin_zhongneng', 'mes_wms_site_equipment', '22', '1', '22']
  ], 'cfor_admin_standard')
  assert.deepEqual(inventory.candidateDatabases, ['cfor_admin_zhongneng'])
  assert.equal(inventory.isolatedFromTarget, true)
  assert.equal(inventory.approved, false)
  assert.equal(inventory.usableReadOnlyFixture, false)
  assert.match(inventory.reason, /未确认数据归属/)
})

test('schema and row snapshots reject omissions, unknown identifiers and malformed hashes', () => {
  assert.throws(() => buildLegacySnapshotSql(metadata.filter((row) => row[0] !== 'iot_device')))
  assert.throws(() => buildLegacySnapshotSql([...metadata, ['iot_device', 'secret); DELETE x']]))
  assert.throws(() => buildLegacySnapshotSql([...metadata, ['iot_device', 'id']]))
  assert.equal(hasCompleteLegacySnapshot(snapshot()), true)
  for (const rows of [
    [], snapshot().slice(1), [...snapshot(), ['row', 'unknown', '1', 'a'.repeat(64)]],
    snapshot().map((row) => row[0] === 'row' ? [...row.slice(0, 3), 'bad hash'] : row),
    [...snapshot(), ['row', 'iot_device', '9007199254740993', 'a'.repeat(64)]]
  ]) {
    assert.equal(hasCompleteLegacySnapshot(rows), false)
    assert.throws(() => legacySnapshotDigest(rows))
  }
  assert.notEqual(legacySnapshotDigest(snapshot()), legacySnapshotDigest(snapshot('b'.repeat(64))))
})

test('conserved summaries reject missing fields, negatives, decimals, overflow and inconsistency', () => {
  assert.equal(hasConservedLegacySummary(empty), true)
  assert.equal(hasConservedLegacySummary({ total: '3', matched: '1', ambiguous: '1', unmatched: '1' }), true)
  for (const summary of [null, {}, { ...empty, total: 1 }, { ...empty, total: -1 },
    { ...empty, total: null }, { ...empty, total: 0.1 }, { ...empty, total: 2 ** 54 }]) {
    assert.equal(hasConservedLegacySummary(summary), false)
  }
})

test('mapping contract validates exact IDs, snapshots, pending states and filter identity', () => {
  assert.equal(hasLegacyPageContract({ list: [matched], total: 1 }, 1), true)
  assert.equal(hasLegacyPageContract({ list: [], total: 0 }, 0), true)
  const ambiguous = { ...matched, matchStatus: 'AMBIGUOUS', matchType: 'NAME',
    iotDeviceId: null, iotDeviceName: null, remark: '名称命中 2 台设备，需人工确认' }
  assert.equal(hasLegacyPageContract({ list: [ambiguous], total: 1 }, 1,
    { matchStatus: 'AMBIGUOUS' }), true)
  assert.equal(hasLegacyPageContract({ list: [{ ...ambiguous, matchStatus: 'UNMATCHED',
    matchType: null }], total: 1 }, 1), true)
  for (const row of [
    { ...matched, id: 2 ** 54 }, { ...matched, iotDeviceId: 2 ** 54 },
    { ...matched, legacyId: null }, { ...matched, iotDeviceName: null },
    { ...matched, matchStatus: 'unknown' }, { ...matched, matchType: 'NAME2' },
    { ...ambiguous, iotDeviceId: matched.iotDeviceId }, { ...ambiguous, remark: '' }
  ]) assert.equal(hasLegacyPageContract({ list: [row], total: 1 }, 1), false)
  assert.equal(hasLegacyPageContract({ list: [matched], total: 2 }, 2), false)
  assert.equal(hasLegacyPageContract({ list: [matched], total: 1 }, 1,
    { matchStatus: 'AMBIGUOUS' }), false)
})

test('empty real-source fixture records blockers, never mutates or claims rebuild idempotence', async () => {
  const context = fixture()
  let inspected = false
  await verifyLegacyReadonly({ ...context, checkPage: async () => { inspected = true } })
  assert.equal(inspected, true)
  assert.equal(context.caseRecord.checks.every((check) => check.passed), true)
  assert.equal(context.caseRecord.legacySafety.reconcileExecuted, false)
  assert.equal(context.caseRecord.legacySafety.mutationRequests, 0)
  assert.deepEqual(context.caseRecord.legacySafety.sourceCounts,
    { equipment_info: 0, mes_wms_site_equipment: 0 })
  assert.deepEqual(context.caseRecord.legacySafety.historicalCandidateInventory.candidateDatabases, [])
  assert.equal(context.caseRecord.legacySafety.historicalCandidateInventory.approved, false)
  assert.ok(context.caseRecord.legacySafety.blockers.length >= 3)
  assert.match(context.caseRecord.evidence[0], /空清单不作为 CODE\/SN/)
  assert.equal(context.calls.filter(([method]) => method === 'GET').length, 6)
})

test('real-source fixture records separate historical candidates without using them', async () => {
  const context = fixture({ candidates: true })
  await verifyLegacyReadonly({ ...context, checkPage: async () => {} })
  const inventory = context.caseRecord.legacySafety.historicalCandidateInventory
  assert.deepEqual(inventory.candidateDatabases, ['cfor_admin_zhongneng'])
  assert.equal(inventory.sourceRows.find((row) => row.table === 'equipment_info').total, 22)
  assert.equal(inventory.sourceRows.find((row) => row.table === 'mes_wms_site_equipment').tenantOneActive, 22)
  assert.equal(inventory.approved, false)
  assert.equal(inventory.usableReadOnlyFixture, false)
  assert.equal(context.caseRecord.legacySafety.mutationRequests, 0)
  assert.equal(context.caseRecord.legacySafety.reconcileExecuted, false)
})

test('source or any derived mapping content change fails despite unchanged row counts', async () => {
  const context = fixture({ changed: true })
  await verifyLegacyReadonly({ ...context, checkPage: async () => {} })
  assert.equal(context.caseRecord.checks.find((check) => check.name.includes('逐行哈希不变')).passed, false)
})

test('unavailable evidence is blocked while service and malformed response errors stay failures', async () => {
  const context = fixture({ available: false })
  await assert.rejects(verifyLegacyReadonly({ ...context, checkPage: async () => {} }), /^Error: BLOCKED:/)
  assert.equal(context.calls.filter(([method]) => method === 'GET').length, 0)
  const outage = fixture({ queryFailure: new Error('HTTP 500 GET summary') })
  await assert.rejects(verifyLegacyReadonly({ ...outage, checkPage: async () => {} }), /HTTP 500/)
  const malformed = fixture({ summary: null })
  await verifyLegacyReadonly({ ...malformed, checkPage: async () => {} })
  assert.equal(malformed.caseRecord.checks[0].passed, false)
})

test('MAINT-012 wrapper records original catalog gaps then blocks the unsafe real rebuild', async () => {
  const context = fixture()
  const shots = []
  await assert.rejects(runCase({
    caseId: 'MAINT-012', caseRecord: context.caseRecord, record: {},
    outputDir: '/unused', page: {
      url: () => 'http://127.0.0.1:9151/iot/device/device-legacy-mapping',
      locator: () => ({
      innerText: async () => '对账总行数 已命中 多义待确认 未命中待确认 来源表 旧设备编码 命中方式 重跑对账'
      })
    }
  }, {
    login: async () => 'unit-token', createApiClient: () => context.api,
    openRoute: async () => {}, saveScreenshot: async (page, output, name) => shots.push(name),
    legacyDependencies: context.dependencies
  }), /BLOCKED: MAINT-012/)
  assert.equal(context.caseRecord.catalogAssertions.length, 5)
  assert.deepEqual(context.caseRecord.catalogAssertions.map((item) => item.status),
    ['GAP', 'GAP', 'GAP', 'VERIFIED', 'GAP'])
  assert.equal(context.caseRecord.remainingAssertions.length, 4)
  assert.equal(context.caseRecord.passCandidate, false)
  assert.deepEqual(shots, ['maint-012-device-legacy-mapping'])
  assert.equal(context.caseRecord.checks.every((check) => check.passed), true)
})

test('legacy mapping route follows the exact component in real permission menus', () => {
  const resolved = resolveLegacyMappingMenuRoute(permissionMenus)
  assert.equal(resolved.route, '/iot/device/device-legacy-mapping')
  assert.equal(resolved.menuId, 58800363)
  assert.throws(() => resolveLegacyMappingMenuRoute(undefined), /Missing real/)
  assert.throws(() => resolveLegacyMappingMenuRoute([]), /found 0/)
  assert.throws(() => resolveLegacyMappingMenuRoute([
    ...permissionMenus, ...permissionMenus
  ]), /found 2/)
  const leaf = permissionMenus[0].children[0].children[0]
  assert.equal(resolveLegacyMappingMenuRoute([{
    path: '/iot', children: [{ ...leaf, path: '/custom/legacy-mapping' }]
  }]).route, '/custom/legacy-mapping')
  for (const path of ['https://example.test', '//example.test', '../device', '/iot#fake']) {
    assert.throws(() => resolveLegacyMappingMenuRoute([{ ...leaf, path }]), /found 0/)
  }
  assert.throws(() => resolveLegacyMappingMenuRoute([{
    ...leaf, component: 'mes/device/other/index'
  }]), /found 0/)
})

test('focused opener corrects only the stale test URL and checks the actual destination', async () => {
  const caseRecord = record()
  const paths = []
  let menuReads = 0
  const opener = createLegacyMappingPageOpener({
    api: { getBusiness: async (path) => {
      assert.equal(path, '/system/auth/get-permission-info')
      menuReads++
      return { code: 0, data: { menus: permissionMenus } }
    } },
    caseRecord,
    openRoute: async (page, path) => paths.push(path)
  })
  const page = { url: () => 'http://127.0.0.1:9151/iot/device/device-legacy-mapping' }
  await opener(page, '/settings/iot/device-legacy-mapping')
  await opener(page, '/iot/device/device-legacy-mapping')
  assert.equal(menuReads, 1)
  assert.deepEqual(paths, Array(2).fill('/iot/device/device-legacy-mapping'))
  assert.equal(caseRecord.checks.every((check) => check.passed), true)
  await assert.rejects(opener(page, '/other'), /Unexpected legacy/)
  await opener({ url: () => 'http://127.0.0.1:9151/index' }, '/settings/iot/device-legacy-mapping')
  assert.equal(caseRecord.checks.at(-1).passed, false)
})

test('browser read evidence requires real summary and bounded first-page GETs, not repeated cache loads', () => {
  const reads = [
    { method: 'GET', pathname: '/admin-api/mes/device-legacy-mapping/summary', query: '' },
    { method: 'GET', pathname: '/admin-api/mes/device-legacy-mapping/page', query: '?pageNo=1&pageSize=100' }
  ]
  assert.equal(hasLegacyBrowserReadEvidence(reads), true)
  assert.equal(hasLegacyBrowserReadEvidence([]), false)
  assert.equal(hasLegacyBrowserReadEvidence(reads.slice(0, 1)), false)
  for (const changed of [
    { ...reads[1], method: 'POST' },
    { ...reads[1], pathname: '/admin-api/mes/device-legacy-mapping/reconcile' },
    { ...reads[1], query: '?pageNo=1&pageSize=101' }
  ]) assert.equal(hasLegacyBrowserReadEvidence([reads[0], changed]), false)
})

test('headed MAINT-012 follows the official menu without reconciling and remains BLOCKED', {
  skip: process.env.CFOR_MAINT_LEGACY_HEADED !== '1',
  timeout: 180000
}, async () => {
  const { main } = await import('../runner.mjs')
  const { config } = await import('../config/index.mjs')
  const { createApiClient } = await import('../lib/api.mjs')
  const { launchBrowser, openRoute, saveScreenshot, waitForPageReady } = await import('../lib/browser.mjs')
  const blockedWrites = []
  const browserReads = []
  const outputRoot = `${config.outputRoot}/maintenance-legacy-page`
  const { record: result, report } = await main({
    argv: ['--case', 'MAINT-012', '--fresh', '--headed', '--continue-on-failure'],
    config: { ...config, outputRoot },
    // Do not change shared checkpoints while other agents run their cases.
    clearCheckpoint: () => {},
    reconcileCheckpoint: () => {},
    saveCheckpoint: () => {},
    launchBrowser: async ({ record, ...options }) => {
      record.browserMode = 'headed'
      const handle = await launchBrowser({ record, ...options })
      await handle.page.route('**/admin-api/**', (route) => {
        const request = route.request()
        const pathname = new URL(request.url()).pathname
        if (!['GET', 'OPTIONS'].includes(request.method()) &&
            /\/(?:mes|iot)\//.test(pathname)) {
          blockedWrites.push({ method: request.method(), pathname })
          return route.abort()
        }
        return route.continue()
      })
      handle.page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname.includes('/mes/device-legacy-mapping/')) {
          browserReads.push({ method: request.method(), pathname: url.pathname, query: url.search })
        }
      })
      return handle
    },
    loadSuite: async (suiteId) => {
      assert.equal(suiteId, 'iot-maintenance')
      return {
        cases: ['MAINT-012'],
        runCase: async (context) => {
          let api
          let opener
          try {
            return await runCase(context, {
              createApiClient: (options) => (api = createApiClient(options)),
              openRoute: async (page, requestedRoute, options) => {
                opener ||= createLegacyMappingPageOpener({
                  api, caseRecord: context.caseRecord, openRoute
                })
                const directStart = browserReads.length
                const menu = await opener(page, requestedRoute, options)
                const inspect = async (stage, readStart) => {
                  await waitForPageReady(page)
                  const table = page.locator('.el-table').first()
                  await table.waitFor({ state: 'visible' })
                  const summary = page.locator('.el-descriptions').first()
                  await summary.waitFor({ state: 'visible' })
                  const text = await table.innerText()
                  const summaryText = await summary.innerText()
                  context.caseRecord.checks.push({
                    name: `对账正式页面${stage}真实显示汇总、列头及空状态`,
                    passed: new URL(page.url()).pathname === menu.route &&
                      ['对账总行数', '已命中', '多义待确认', '未命中待确认']
                        .every((label) => summaryText.includes(label)) &&
                      ['来源表', '旧设备编码', '旧设备名称', '命中方式', 'iot_device', '暂无数据']
                        .every((label) => text.includes(label)),
                    details: `${page.url()}; ${summaryText.replace(/\s+/g, ' ')}`
                  })
                  if (readStart !== undefined) {
                    const reads = browserReads.slice(readStart)
                    context.caseRecord.checks.push({
                      name: `对账页面${stage}真实加载汇总及每页100条清单`,
                      passed: hasLegacyBrowserReadEvidence(reads),
                      details: JSON.stringify(reads)
                    })
                  }
                  await saveScreenshot(page, context.outputDir, `maint-012-${stage}-headed`, context.record)
                }
                await inspect('direct', directStart)
                const menuLabel = page.locator('span.v-menu__title[data-menu-path]')
                  .filter({ hasText: /^设备引用对账$/ })
                assert.equal(await menuLabel.getAttribute('data-menu-path'), menu.route)
                const sibling = page.locator('span.v-menu__title[data-menu-path="/iot/device/device"]').first()
                await sibling.click()
                await page.waitForURL('**/iot/device/device')
                await menuLabel.click()
                await page.waitForURL(`**${menu.route}`)
                await inspect('menu')
                const reloadStart = browserReads.length
                await page.reload({ waitUntil: 'domcontentloaded' })
                await page.locator('.el-descriptions').waitFor({ state: 'visible' })
                await inspect('reload', reloadStart)
              }
            })
          } finally {
            const pageCheck = context.caseRecord.checks.find((check) =>
              check.name === '设备引用对账页真实渲染汇总与清单')
            if (pageCheck && context.caseRecord.legacyPageRoute) {
              pageCheck.details += `; 真实菜单及访问路径=${context.caseRecord.legacyPageRoute.actualPath}`
            }
            context.caseRecord.checks.push({
              name: 'headed 复验只观察真实对账 GET 且无 MES/IoT 写请求',
              passed: blockedWrites.length === 0 && hasLegacyBrowserReadEvidence(browserReads),
              details: JSON.stringify({ blockedWrites, browserReads })
            })
          }
        }
      }
    }
  })
  console.log(`MAINT-012 headed report: ${report.resultFile}`)
  const actual = result.cases[0]
  assert.equal(actual.status, 'BLOCKED', 'Page evidence must not hide failures or claim complete acceptance')
  assert.equal(actual.passCandidate, false)
  assert.equal(actual.remainingAssertions.length, 4)
  assert.equal(actual.legacySafety.reconcileExecuted, false)
  assert.equal(actual.legacySafety.mutationRequests, 0)
  assert.equal(actual.checks.every((check) => check.passed), true)
})
