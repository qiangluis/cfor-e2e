import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  KNOWLEDGE_DOCUMENT_REQUIRED, PB123_REQUIREMENT_SOURCE,
  assertKnowledgeReadinessLocalContext, readKnowledgeReadinessSourceContracts,
  readAfterSalesKnowledgeFactSnapshot, auditKnowledgeDocumentReadiness,
  resolveAfterSalesKnowledgeRoute, isSafeKnowledgePageRequest, assertKnowledgePageText,
  auditAfterSalesKnowledgePage, runProjectAfterSalesKnowledgeReadiness
} from '../fixtures/project-after-sales-knowledge-readiness.mjs'

const settings = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083',
  apiUrl: 'http://127.0.0.1:48083/admin-api', webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const token = 'PB123-token-must-not-appear'
const sensitive = 'PB123-sensitive-body-must-not-appear'
const docId = '2110003329070088194'
const categoryId = '2110003329070088195'
const tables = ['after_sales_knowledge_case', 'after_sales_knowledge_event']
const menus = [{
  id: '10', path: '/after-sales', children: [{
    id: '11', path: 'knowledge', component: 'after-sales/knowledge/index'
  }]
}]
const permissions = [
  'after-sales:modeling:create', 'after-sales:modeling:query', 'after-sales:modeling:enable',
  'after-sales:knowledge:edit', 'after-sales:knowledge:query'
]
const ok = (data) => ({ code: 0, data })
const snapshot = (hash = 'a'.repeat(64)) => Object.fromEntries(tables.map((table) =>
  [table, { columns: [{ name: 'all-fields', type: 'test' }], count: 1,
    rows: [{ id: '7', hash }] }]))
const document = (change = {}) => ({
  id: docId, knowledgeId: '8', status: 0, parseStatus: 'PARSED', indexStatus: 'INDEXED',
  name: sensitive, content: sensitive, url: sensitive, parseSummaryJson: sensitive,
  parseErrorMessage: sensitive, indexErrorMessage: sensitive, ...change
})
const metadataSql = (rows = [], total = rows.length) => ({
  available: true, rows: [['document-count', String(total)], ...rows]
})
const sqlDocument = (change = {}) => {
  const row = { id: docId, knowledgeId: '8', version: '9', status: '0',
    parseStatus: 'PARSED', indexStatus: 'INDEXED', tenantId: '1', deleted: '0', segments: '3', ...change }
  return ['document', ...Object.values(row)]
}

const harness = (overrides = {}) => {
  const calls = []
  const state = { category: null, snapshots: 0, factoryCalls: 0, safetyCalls: 0 }
  const api = {
    async get (pathname) {
      calls.push({ method: 'GET', pathname })
      if (overrides.get) {
        const result = await overrides.get(pathname, state)
        if (result !== undefined) return result
      }
      if (pathname === '/system/auth/get-permission-info') return ok({
        menus, permissions: overrides.permissions ?? permissions
      })
      if (pathname.startsWith('/ai/knowledge/document/page?')) return ok({ list: [], total: 0 })
      if (pathname === '/after-sales/modeling/category/list') return ok(
        state.category ? [{ ...state.category, ...(overrides.cleanupRow || {}) }] : [])
      if (pathname.startsWith('/after-sales/modeling/category/get?id=')) return ok({
        ...state.category, ...(overrides.readbackRow || {})
      })
      throw new Error(`Unexpected GET ${pathname}`)
    },
    async post (pathname, body, options) {
      calls.push({ method: 'POST', pathname, body, options })
      if (pathname === '/after-sales/modeling/category/create') {
        state.category = { ...body, id: categoryId, tenantId: '1', leafFlag: true, status: 'ENABLED' }
        if (overrides.createThrow) throw new Error(sensitive)
        return ok(overrides.createId ?? categoryId)
      }
      if (pathname === '/after-sales/knowledge/save-draft') {
        if (overrides.negativeThrow) throw new Error(sensitive)
        return overrides.rejection ?? { code: KNOWLEDGE_DOCUMENT_REQUIRED.code, msg: KNOWLEDGE_DOCUMENT_REQUIRED.message }
      }
      if (pathname.startsWith('/after-sales/modeling/status?')) {
        if (overrides.cleanupThrow) throw new Error(sensitive)
        state.category.status = overrides.cleanupStatus ?? 'DISABLED'
        return ok(true)
      }
      throw new Error(`Unexpected POST ${pathname}`)
    }
  }
  const deps = {
    settings, writeFlag: 'true',
    createApiClient (args) {
      state.factoryCalls++
      assert.deepEqual(args, { token, tenantId: '1' })
      assert.equal(args.record, undefined)
      assert.equal(args.check, undefined)
      return api
    },
    readSql: async (sql) => {
      if (sql.includes('FROM after_sales_issue_category')) {
        const row = state.category
        return { available: true, rows: row ? [
          ['owned-category', row.id, '1', row.categoryCode, row.categoryName, '0', '1', row.status, '0']
        ] : [] }
      }
      return metadataSql()
    },
    readSources: () => ({ writeContractConfirmed: overrides.contract !== false, files: {} }),
    assertWriteSafety: async () => {
      state.safetyCalls++
      if (overrides.safetyThrow) throw new Error(sensitive)
    },
    readSnapshot: async () => {
      state.snapshots++
      if (overrides.snapshotThrowAt === state.snapshots) throw new Error(sensitive)
      return snapshot(overrides.drift && state.snapshots === 3 ? 'b'.repeat(64) : 'a'.repeat(64))
    },
    ...overrides.dependencies
  }
  const record = { environment: { tenantId: '1' }, checks: [], api: [] }
  return { calls, state, deps, record, api,
    run: (input = {}) => runProjectAfterSalesKnowledgeReadiness({
      token, tenantId: '1', runId: '20261013-PB123-unit', caseRecord: record, ...input
    }, deps) }
}
const noWrites = (h) => assert.equal(h.calls.some((call) => call.method !== 'GET'), false)
const assertSafeResult = (result) => {
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.passCandidate, false)
  assert.equal(result.positiveExecuted, false)
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes(token))
  assert.ok(!serialized.includes(sensitive))
  assert.ok(!serialized.includes('"VERIFIED"'))
}

test('PB123 source is the original workbook row; no catalog assertion is invented', () => {
  assert.equal(PB123_REQUIREMENT_SOURCE.sheet, '功能梳理')
  assert.equal(PB123_REQUIREMENT_SOURCE.range, 'A126:I126')
  assert.deepEqual(PB123_REQUIREMENT_SOURCE.assertions, [
    '知识草稿必须脱敏并经人工审核',
    '发布保存适用产品、版本和来源案例',
    '停用不删除历史，AI引用返回来源版本和适用范围',
    '知识库必须分类，来源为平常处理的问题单据可点击生成也可以手工新增'
  ])
  const source = readKnowledgeReadinessSourceContracts()
  assert.equal(source.writeContractConfirmed, true)
  assert.equal(Object.keys(source.files).length, 7)
  for (const file of Object.values(source.files)) assert.match(file.sha256, /^[a-f0-9]{64}$/)
})

for (const [label, patch, tenant = '1'] of [
  ['online', { target: 'online' }], ['tenant', {}, '2'],
  ['configured tenant', { tenantId: '2' }],
  ['remote API', { apiBase: 'http://192.168.0.2:48083' }],
  ['wrong API port', { apiBase: 'http://127.0.0.1:48080' }],
  ['remote web', { webBase: 'http://192.168.0.2:9151' }],
  ['wrong prefix', { apiUrl: 'http://127.0.0.1:48083/mock-api' }],
  ['database host', { db: { ...settings.db, host: 'remote' } }],
  ['database port', { db: { ...settings.db, port: '3307' } }],
  ['database name', { db: { ...settings.db, name: 'cfor_admin_saas' } }]
]) {
  test(`PB123 context rejects ${label} before any API, SQL or browser activity`, async () => {
    const h = harness({ dependencies: { settings: { ...settings, ...patch } } })
    await assert.rejects(h.run({ tenantId: tenant }))
    assert.equal(h.state.factoryCalls, 0)
    assert.equal(h.state.snapshots, 0)
  })
}
test('PB123 accepts only explicit tenant1 and exact local database/endpoints', () => {
  assert.doesNotThrow(() => assertKnowledgeReadinessLocalContext(settings, '1'))
})

const schemaRows = () => tables.flatMap((table) => [
  ['schema-count', table, '7'],
  ...[['id', 'bigint'], ['tenant_id', 'bigint'], ['deleted', 'bit'], ['create_time', 'datetime'],
    ['update_time', 'datetime'], ['content', 'longtext'], ['snapshot', 'json']]
    .map(([name, type]) => ['column', table, name, type])
])
test('PB123 full facts include body, JSON, BIT, tenant, audit and soft-deleted columns without emitting content', async () => {
  const queries = []
  const evidence = await readAfterSalesKnowledgeFactSnapshot(async (sql) => {
    queries.push(sql)
    return { available: true, rows: queries.length === 1 ? schemaRows() : tables.flatMap((table) => [
      ['count', table, '1'], ['row', table, docId, 'b'.repeat(64)]
    ]) }
  })
  assert.equal(queries.length, 2)
  assert.ok(queries[1].includes("'content', `content`"))
  assert.ok(queries[1].includes("'snapshot', `snapshot`"))
  assert.ok(queries[1].includes("'deleted', CAST(`deleted` AS UNSIGNED)"))
  assert.ok(!queries[1].includes('AND deleted = 0'))
  assert.ok(!/\b(?:INSERT|UPDATE|DELETE|CALL|EXECUTE)\b/i.test(queries.join('\n')))
  assert.equal(evidence.after_sales_knowledge_case.rows[0].id, docId)
})
test('PB123 a proven zero census is absence-of-insertion evidence, not a positive business closure', async () => {
  const evidence = await readAfterSalesKnowledgeFactSnapshot(async (sql) => ({
    available: true, rows: sql.includes('information_schema') ? schemaRows() :
      tables.map((table) => ['count', table, '0'])
  }))
  assert.equal(evidence.after_sales_knowledge_case.count, 0)
})
for (const [label, change] of [
  ['unavailable', () => ({ available: false, rows: [] })],
  ['empty schema', () => ({ available: true, rows: [] })],
  ['truncated facts', (sql) => ({ available: true, rows: sql.includes('information_schema')
    ? schemaRows() : tables.map((table) => ['count', table, '1']) })],
  ['missing row census', (sql) => ({ available: true, rows: sql.includes('information_schema')
    ? schemaRows() : [] })],
  ['duplicate ID', (sql) => ({ available: true, rows: sql.includes('information_schema')
    ? schemaRows() : tables.flatMap((table) => [
      ['count', table, '2'], ['row', table, docId, 'a'.repeat(64)], ['row', table, docId, 'a'.repeat(64)]
    ]) })]
]) test(`PB123 rejects ${label} read-only fact evidence`, async () => {
  await assert.rejects(readAfterSalesKnowledgeFactSnapshot(change))
})

test('PB123 document page records metadata only and exact SQL version9, never version1', async () => {
  const calls = []
  const readiness = await auditKnowledgeDocumentReadiness({
    api: { get: async (url) => { calls.push(url); return ok({ list: [document()], total: 1 }) } },
    readSql: async (sql) => {
      assert.ok(sql.includes('d.version_no'))
      assert.ok(sql.includes('s.vector_id'))
      assert.ok(!sql.includes('s.content'))
      assert.ok(sql.includes(`d.id IN (${docId})`))
      return metadataSql([sqlDocument()])
    }
  })
  assert.equal(calls.length, 1)
  const params = new URL('http://local' + calls[0]).searchParams
  assert.deepEqual(Object.fromEntries(params), {
    status: '0', parseStatus: 'PARSED', indexStatus: 'INDEXED', pageNo: '1', pageSize: '100'
  })
  assert.equal(readiness.candidates[0].versionNo, 9)
  assert.equal(readiness.candidates[0].versionSource, 'READ_ONLY_SQL')
  assert.equal(readiness.positiveExecuted, false)
  assert.ok(!JSON.stringify(readiness).includes(sensitive))
})
for (const [label, version, segments, reason] of [
  ['unknown version', 'NULL', '3', 'EXACT_VERSION_UNKNOWN'],
  ['invalid zero version', '0', '3', 'EXACT_VERSION_UNKNOWN'],
  ['no vector segment', '9', '0', 'NO_INDEXED_SEGMENT_EVIDENCE']
]) test(`PB123 ${label} is not a usable sample`, async () => {
  const readiness = await auditKnowledgeDocumentReadiness({
    api: { get: async () => ok({ list: [document()], total: 1 }) },
    readSql: async () => metadataSql([sqlDocument({ version, segments })])
  })
  assert.equal(readiness.candidates.length, 0)
  assert.equal(readiness.noIndexedSample, true)
  assert.ok(readiness.metadata[0].reasons.includes(reason))
  if (version === 'NULL') assert.equal(readiness.metadata[0].versionNo, null)
})
test('PB123 handles every formal page within the bound without dropping records after100', async () => {
  const docs = Array.from({ length: 101 }, (_, index) => document({ id: String(index + 100) }))
  const calls = []
  const readiness = await auditKnowledgeDocumentReadiness({
    api: { get: async (url) => {
      const pageNo = Number(new URL('http://local' + url).searchParams.get('pageNo'))
      calls.push(pageNo)
      return ok({ list: docs.slice((pageNo - 1) * 100, pageNo * 100), total: 101 })
    } },
    readSql: async () => metadataSql(docs.map((doc) => sqlDocument({ id: doc.id })))
  })
  assert.deepEqual(calls, [1, 2])
  assert.equal(readiness.candidates.length, 101)
})
for (const [label, data, sql] of [
  ['generic auth rejection', { code: 403, msg: sensitive }],
  ['missing list', ok({ total: 0 })],
  ['missing total', ok({ list: [] })],
  ['truncated list', ok({ list: [], total: 1 })],
  ['duplicate document', ok({ list: [document(), document()], total: 2 })],
  ['unsafe numeric ID', ok({ list: [document({ id: Number(docId) })], total: 1 })],
  ['wrong parse status', ok({ list: [document({ parseStatus: 'PENDING' })], total: 1 })],
  ['wrong index status', ok({ list: [document({ indexStatus: 'ERROR_INDEXING' })], total: 1 })],
  ['wrong enabled status', ok({ list: [document({ status: 1 })], total: 1 })],
  ['SQL unavailable', ok({ list: [], total: 0 }), { available: false, rows: [] }],
  ['SQL hidden sample', ok({ list: [], total: 0 }), metadataSql([], 1)],
  ['SQL tenant mismatch', ok({ list: [document()], total: 1 }), metadataSql([sqlDocument({ tenantId: '2' })])],
  ['version conflict', ok({ list: [document({ versionNo: 2 })], total: 1 }), metadataSql([sqlDocument()])]
]) test(`PB123 readiness rejects ${label}`, async () => {
  await assert.rejects(auditKnowledgeDocumentReadiness({
    api: { get: async () => data }, readSql: async () => sql ?? metadataSql()
  }))
})
test('PB123 readiness page limit cannot convert an incomplete audit into no samples', async () => {
  await assert.rejects(auditKnowledgeDocumentReadiness({
    maxPages: 1, api: { get: async () => ok({ total: 101, list: Array.from(
      { length: 100 }, (_, index) => document({ id: String(index + 1) })) }) },
    readSql: async () => { assert.fail('SQL must not run after truncated API enumeration') }
  }), /bound exceeded/)
})

test('PB123 actual helper uses a valid exclusive category and precise domain rejection with final cleanup', async () => {
  const h = harness()
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, true)
  assert.equal(result.negative.matched, true)
  assert.equal(result.negative.unchanged, true)
  assert.equal(result.negativeComplete, true)
  assert.equal(result.categoryCleanup.status, 'DISABLED')
  assert.equal(h.state.category.status, 'DISABLED')
  const create = h.calls.find((call) => call.pathname === '/after-sales/modeling/category/create')
  assert.equal(create.body.parentId, '0')
  assert.equal(create.body.defaultPriority, 'P2')
  assert.match(create.body.categoryCode, /^E2E-PB123-[a-f0-9]{20}$/)
  const negative = h.calls.find((call) => call.pathname === '/after-sales/knowledge/save-draft')
  assert.equal(negative.body.categoryId, categoryId)
  assert.equal(negative.body.sourceType, 'MANUAL')
  assert.equal(negative.body.desensitizationStatus, 'PENDING')
  assert.ok(negative.body.title && negative.body.keywords.length)
  assert.ok(!('knowledgeDocumentId' in negative.body))
  assert.ok(!('knowledgeDocumentVersion' in negative.body))
  assert.ok(!('symptom' in negative.body) && !('solution' in negative.body))
  assert.deepEqual(negative.options.expectedBusinessRejection, KNOWLEDGE_DOCUMENT_REQUIRED)
  assert.equal(h.record.projectAfterSalesKnowledgeReadiness, result)
  assert.deepEqual(h.record.checks, [])
  assert.deepEqual(h.record.api, [])
  assert.ok(result.gaps.some((item) => item.code === 'NO_REAL_INDEXED_SAMPLE'))
})
for (const [label, overrides] of [
  ['writeflag', { dependencies: { writeFlag: 'false' } }],
  ['boolean flag not explicit string', { dependencies: { writeFlag: true } }],
  ['unconfirmed contracts', { contract: false }],
  ['missing shared permissions', { permissions: ['ai:knowledge:query'] }],
  ['write safety failed', { safetyThrow: true }],
  ['fact snapshot unavailable', { snapshotThrowAt: 1 }]
]) test(`PB123 ${label} does not cause any write`, async () => {
  const h = harness(overrides)
  const result = await h.run()
  noWrites(h)
  assertSafeResult(result)
})
for (const rejection of [
  { code: 1040011, msg: 'wrong domain reason' },
  { code: 400, msg: 'categoryId required' },
  { code: 403, msg: 'Forbidden' }, { code: 422001, msg: '参数错误' },
  { code: 1040011, message: KNOWLEDGE_DOCUMENT_REQUIRED.message },
  { code: 0, data: '7' }, { code: 500, msg: sensitive }
]) test(`PB123 non-contract rejection ${JSON.stringify(rejection.code)} never proves the negative`, async () => {
  const h = harness({ rejection })
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, false)
  assert.equal(result.negative.matched, false)
  assert.equal(result.categoryCleanup.status, 'DISABLED')
})
for (const [label, overrides] of [
  ['request transport failure', { negativeThrow: true }],
  ['full-field fact drift', { drift: true }],
  ['readback failure', { readbackRow: { status: 'DISABLED' } }],
  ['create committed but response lost', { createThrow: true }],
  ['unsafe creation ID', { createId: Number(categoryId) }],
  ['after snapshot failure', { snapshotThrowAt: 3 }]
]) test(`PB123 ${label} still tries owned-category finally cleanup without hiding failure`, async () => {
  const h = harness(overrides)
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, false)
  assert.equal(result.categoryCleanup.status, 'DISABLED')
  if (overrides.negativeThrow) assert.equal(h.state.snapshots, 3)
})
for (const [label, overrides] of [
  ['cleanup HTTP/permission failure', { cleanupThrow: true }],
  ['cleanup not persisted', { cleanupStatus: 'ENABLED' }],
  ['changed category owner', { cleanupRow: { tenantId: '2' } }]
]) test(`PB123 ${label} propagates explicit cleanup failure`, async () => {
  const h = harness(overrides)
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, false)
  assert.equal(result.categoryCleanup.completed, false)
  assert.ok(result.failures.some((item) => item.stage === 'category-cleanup'))
  if (overrides.cleanupRow) assert.equal(h.calls.some((call) =>
    call.pathname.startsWith('/after-sales/modeling/status?')), false)
})
test('PB123 a real readiness candidate still never runs or completes the positive', async () => {
  const h = harness({
    get: async (url) => url.startsWith('/ai/knowledge/document/page?')
      ? ok({ list: [document()], total: 1 }) : undefined,
    dependencies: { readSql: async (sql) => {
      if (sql.includes('FROM after_sales_issue_category')) {
        const row = h.state.category
        return { available: true, rows: [
          ['owned-category', row.id, '1', row.categoryCode, row.categoryName, '0', '1', row.status, '0']
        ] }
      }
      return metadataSql([sqlDocument()])
    } }
  })
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.readiness.candidates.length, 1)
  assert.equal(result.gaps.some((item) => item.code === 'NO_REAL_INDEXED_SAMPLE'), false)
  assert.equal(result.candidateAssertionEvidence.length, 4)
})
test('PB123 category BaseDO may omit tenantId; scoped SQL proves ownership for readback and finally', async () => {
  const h = harness({ readbackRow: { tenantId: undefined }, cleanupRow: { tenantId: undefined } })
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, true)
  assert.equal(result.negativeComplete, true)
  assert.equal(result.categoryCleanup.completed, true)
})
test('PB123 missing category SQL ownership is not guessed from API tenant headers', async () => {
  const h = harness({
    readbackRow: { tenantId: undefined }, cleanupRow: { tenantId: undefined },
    dependencies: { readSql: async (sql) => sql.includes('FROM after_sales_issue_category')
      ? { available: true, rows: [] } : metadataSql() }
  })
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, false)
  assert.equal(result.negativeComplete, false)
  assert.equal(result.categoryCleanup.completed, false)
  assert.equal(h.calls.some((call) => call.pathname.startsWith('/after-sales/modeling/status?')), false)
})
test('PB123 known permission gap stays a gap, makes no write and does not complete the negative', async () => {
  const h = harness({
    get: async (url) => url === '/system/auth/get-permission-info'
      ? ok({ menus: [], permissions: ['ai:knowledge:query'] }) : undefined
  })
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, true)
  assert.equal(result.negativeComplete, false)
  assert.equal(result.negative, undefined)
  assert.ok(result.gaps.some((item) => item.code === 'PERMISSION_GAP'))
  noWrites(h)
})
test('PB123 r29 nonempty menu inventory without a knowledge entry is prerequisite GAP, not page-route FAIL', async () => {
  const h = harness({
    get: async (url) => url === '/system/auth/get-permission-info' ? ok({
      menus: [{ id: '29613001', path: '/after-sales', children: [
        { id: '29613002', path: 'workbench', component: 'after-sales/workbench/index.vue' },
        { id: '29613018', path: 'analysis/knowledge', component: 'after-sales/analysis/report.vue' },
        { id: '29613021', path: 'modeling', component: 'after-sales/settings/index.vue' }
      ] }], permissions: ['ai:knowledge:query']
    }) : undefined
  })
  const result = await h.run({ page: { goto: () => assert.fail('No permitted route may be invented') } })
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, true)
  assert.equal(result.negativeComplete, false)
  assert.equal(result.negative, undefined)
  assert.equal(result.page, undefined)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.pageRoute, {
    available: false, source: 'FORMAL_PERMISSION_MENUS', matchingRoutes: 0
  })
  assert.ok(result.gaps.some((item) => item.code === 'PERMISSION_GAP'))
  assert.ok(result.gaps.some((item) => item.code === 'PAGE_ROUTE_UNAVAILABLE'))
  assert.equal(result.readiness.total, 0)
  noWrites(h)
})
test('PB123 an existing knowledge menu with missing query permission does not execute the page', async () => {
  const h = harness({ permissions: ['ai:knowledge:query'] })
  const result = await h.run({ page: { goto: () => assert.fail('Missing query permission must remain GAP') } })
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, true)
  assert.equal(result.pageRoute.available, true)
  assert.equal(result.page, undefined)
  assert.ok(result.gaps.some((item) => item.code === 'PAGE_PERMISSION_UNAVAILABLE'))
  assert.ok(!result.gaps.some((item) => item.code === 'PAGE_ROUTE_UNAVAILABLE'))
  noWrites(h)
})
test('PB123 ambiguous formal routes remain an audit failure, even with missing permissions', async () => {
  const h = harness({
    get: async (url) => url === '/system/auth/get-permission-info'
      ? ok({ menus: [...menus, ...menus], permissions: [] }) : undefined
  })
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, false)
  assert.ok(result.failures.some((item) => item.stage === 'page-route'))
  assert.ok(!result.gaps.some((item) => item.code === 'PAGE_ROUTE_UNAVAILABLE'))
  noWrites(h)
})
test('PB123 readiness failure reports UNKNOWN, not a proven empty INDEXED inventory', async () => {
  const h = harness({
    get: async (url) => url.startsWith('/ai/knowledge/document/page?')
      ? { code: 403, msg: sensitive } : undefined
  })
  const result = await h.run()
  assertSafeResult(result)
  assert.equal(result.auditSucceeded, false)
  assert.equal(result.readiness, undefined)
  assert.ok(result.gaps.some((item) => item.code === 'READINESS_UNKNOWN'))
  assert.ok(!result.gaps.some((item) => item.code === 'NO_REAL_INDEXED_SAMPLE'))
})
test('PB123 fixed assertion diagnostics are useful without actual/expected values or response text', async () => {
  const h = harness({ rejection: { code: 1040011, msg: sensitive } })
  const result = await h.run()
  assertSafeResult(result)
  const failure = result.failures.find((item) => item.stage === 'negative')
  assert.equal(failure.errorType, 'AssertionError')
  assert.equal(failure.assertionMessage, 'PB123 wrong rejection reason')
  const transport = harness({ negativeThrow: true })
  const transportResult = await transport.run()
  assertSafeResult(transportResult)
  assert.equal(transportResult.failures.find((item) => item.stage === 'negative').errorType, 'Error')
})
test('PB123 cleanup failure prevents negativeComplete despite exact unchanged negative evidence', async () => {
  const h = harness({ cleanupThrow: true })
  const result = await h.run()
  assert.equal(result.negative.matched, true)
  assert.equal(result.negative.unchanged, true)
  assert.equal(result.negativeComplete, false)
  assert.equal(result.auditSucceeded, false)
})
test('PB123 runner helper only uses the narrowly approved formal endpoints', async () => {
  const h = harness()
  await h.run()
  const allowed = new Set([
    '/system/auth/get-permission-info', '/ai/knowledge/document/page',
    '/after-sales/modeling/category/list', '/after-sales/modeling/category/get',
    '/after-sales/modeling/category/create', '/after-sales/modeling/status',
    '/after-sales/knowledge/save-draft'
  ])
  for (const call of h.calls) {
    assert.ok(allowed.has(call.pathname.split('?')[0]))
    assert.ok(!/policy|sources|segment|search|worker|retry|executeIgnore/.test(call.pathname))
  }
  const source = fs.readFileSync(new URL('../fixtures/project-after-sales-knowledge-readiness.mjs', import.meta.url), 'utf8')
  assert.ok(!source.includes('runLocalFixtureSql'))
  assert.ok(!source.includes('launchBrowser'))
})

test('PB123 resolves only the existing formal permission-menu component', () => {
  assert.equal(resolveAfterSalesKnowledgeRoute(menus).route, '/after-sales/knowledge')
  assert.equal(resolveAfterSalesKnowledgeRoute([{
    ...menus[0].children[0], component: 'after-sales/knowledge/index.vue'
  }]).route, '/knowledge')
  for (const component of ['after-sales/module-overview/index', 'after-sales/knowledge/index?mock=true']) {
    assert.equal(resolveAfterSalesKnowledgeRoute([{ ...menus[0].children[0], component }]), null)
  }
  assert.throws(() => resolveAfterSalesKnowledgeRoute([...menus, ...menus]))
  assert.equal(resolveAfterSalesKnowledgeRoute([]), null)
  assert.throws(() => resolveAfterSalesKnowledgeRoute(undefined))
})
for (const text of ['模块配置异常，请联系管理员', '404', '403', '权限不足', 'Forbidden', '请重新登录']) {
  test(`PB123 page error text ${text} is not accepted`, () => assert.throws(() => assertKnowledgePageText(text)))
}
test('PB123 page guard rejects all writes, side-effecting GETs, foreign hosts and tenants', () => {
  const url = 'http://127.0.0.1:48083/admin-api'
  assert.equal(isSafeKnowledgePageRequest({
    url: url + '/after-sales/knowledge/list', method: 'GET', tenantId: '1'
  }, settings), true)
  assert.equal(isSafeKnowledgePageRequest({
    url: url + '/after-sales/knowledge/list', method: 'OPTIONS'
  }, settings), true)
  for (const [endpoint, method, tenantId] of [
    ['/after-sales/knowledge/save-draft', 'POST', '1'],
    ['/after-sales/knowledge/review', 'POST', '1'],
    ['/ai/knowledge/document/create', 'POST', '1'],
    ['/system/ai-desktop/knowledge/policy/sources', 'GET', '1'],
    ['/ai/knowledge/segment/search', 'GET', '1'],
    ['/system/ai-runtime/admin/worker/executeIgnore', 'POST', '1'],
    ['/after-sales/knowledge/list', 'GET', '2']
  ]) assert.equal(isSafeKnowledgePageRequest({ url: url + endpoint, method, tenantId }, settings), false)
  assert.equal(isSafeKnowledgePageRequest({ url: 'https://remote/x', method: 'GET' }, settings), false)
})

const mockPage = (options = {}) => {
  const page = new EventEmitter()
  let guard
  let currentUrl
  const captures = []
  const actions = []
  const request = (pathname, method = 'GET') => ({
    url: () => `${settings.apiBase}/admin-api${pathname}`,
    method: () => method, headers: () => ({ 'tenant-id': '1' }), resourceType: () => 'xhr'
  })
  page.context = () => ({ serviceWorkers: () => options.serviceWorkers || [] })
  page.route = async (_, handler) => { guard = handler; actions.push('route') }
  page.unroute = async () => { guard = undefined; actions.push('unroute') }
  page.url = () => currentUrl
  page.goto = async (url) => {
    currentUrl = options.redirect ? settings.webBase + '/login' : url
    actions.push('goto')
    for (const pathname of ['/after-sales/ticket/list', '/after-sales/asset/list',
      '/after-sales/asset/customer/list', '/after-sales/knowledge/list']) {
      const req = request(pathname)
      await guard({ request: () => req, continue: async () => {}, abort: async () => assert.fail('safe GET aborted') })
      if ((options.missingResponse && pathname === '/after-sales/knowledge/list') ||
          (options.missingAssetResponse && pathname === '/after-sales/asset/list')) continue
      page.emit('response', {
        request: () => req, url: req.url, ok: () => true, status: () => 200, headers: () => ({}),
        text: async () => JSON.stringify(options.businessFailure && pathname === '/after-sales/knowledge/list'
          ? { code: 403, msg: sensitive } : ok([]))
      })
    }
    if (options.write) await guard({
      request: () => request('/after-sales/knowledge/save-draft', 'POST'),
      continue: async () => assert.fail('write passed guard'), abort: async () => actions.push('abort')
    })
    if (options.scriptError) page.emit('pageerror', new Error(sensitive))
    if (options.consoleError) page.emit('console', { type: () => 'error', text: () => sensitive })
    return { ok: () => true, status: () => options.navigationStatus || 200 }
  }
  page.locator = (selector) => ({
    waitFor: async () => {},
    innerText: async () => selector === 'body' ? options.bodyText || '知识案例 知识库目录' : '',
    locator: (name) => ({ innerText: async () => name === 'h1' ? '知识案例' : '知识库目录' })
  })
  page.waitForFunction = async (_, expected) => { assert.equal(expected, 0) }
  page.screenshot = async (args) => { captures.push(args); if (options.screenshotThrow) throw new Error(sensitive) }
  return { page, captures, actions }
}
const pageArgs = (page) => ({
  page, route: '/after-sales/knowledge', screenshotPath: '/tmp/pb123-unit.png', settings, timeoutMs: 30
})
test('PB123 browser audit observes successful real GET, formal DOM, masked screenshot and removes only own guards/listeners', async () => {
  const { page, captures, actions } = mockPage()
  const result = await auditAfterSalesKnowledgePage(pageArgs(page))
  assert.equal(result.loaded, true)
  assert.equal(result.readOnly, true)
  assert.equal(result.displayedRows, 0)
  assert.equal(result.reads.find((read) => read.pathname.endsWith('/knowledge/list')).status, 200)
  assert.equal(captures[0].mask.length, 3)
  assert.deepEqual(actions, ['route', 'goto', 'unroute'])
  assert.equal(page.listenerCount('response'), 0)
  assert.equal(page.listenerCount('requestfailed'), 0)
  assert.equal(page.listenerCount('pageerror'), 0)
  assert.equal(page.listenerCount('console'), 0)
  assert.ok(!JSON.stringify(result).includes(sensitive))
})
for (const [label, options] of [
  ['write request', { write: true }], ['business refusal', { businessFailure: true }],
  ['module configuration error', { bodyText: '模块配置异常，请联系管理员' }],
  ['script exception', { scriptError: true }], ['console error', { consoleError: true }],
  ['no real knowledge GET', { missingResponse: true }],
  ['incomplete real hydration', { missingAssetResponse: true }],
  ['page document not200', { navigationStatus: 404 }], ['redirect', { redirect: true }],
  ['screenshot failure', { screenshotThrow: true }]
]) test(`PB123 browser ${label} fails and leaves no own listeners or guards`, async () => {
  const { page, actions } = mockPage(options)
  await assert.rejects(auditAfterSalesKnowledgePage(pageArgs(page)))
  assert.ok(actions.includes('unroute'))
  for (const event of ['response', 'requestfailed', 'pageerror', 'console']) {
    assert.equal(page.listenerCount(event), 0)
  }
})
test('PB123 browser refuses a global response recorder or active service worker before navigation', async () => {
  const { page, actions } = mockPage()
  const listener = () => {}
  page.on('response', listener)
  await assert.rejects(auditAfterSalesKnowledgePage(pageArgs(page)), /recorder-free/)
  assert.deepEqual(actions, [])
  assert.equal(page.listenerCount('response'), 1)
  page.off('response', listener)
  const other = mockPage({ serviceWorkers: [{}] })
  await assert.rejects(auditAfterSalesKnowledgePage(pageArgs(other.page)), /service workers/)
  assert.deepEqual(other.actions, [])
})
test('PB123 orchestrator exposes only page audit metadata and no page-opening PASS', async () => {
  const h = harness()
  const { page } = mockPage()
  const result = await h.run({ page, screenshotPath: '/tmp/pb123-unit.png' })
  assertSafeResult(result)
  assert.equal(result.page.loaded, true)
  assert.equal(result.negative.matched, true)
  assert.equal(result.candidateAssertionEvidence[3].observations.pageReadOnlyLoaded, true)
  assert.equal(result.acceptanceComplete, false)
})
