import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

export const KNOWLEDGE_DOCUMENT_REQUIRED = Object.freeze({
  code: 1040011, message: '保存知识案例前必须关联知识中枢文档及版本'
})
export const PB123_REQUIREMENT_SOURCE = Object.freeze({
  path: '/Users/liuqiang/Documents/赣州奇工/平台功能梳理0929.xlsx',
  sheet: '功能梳理', range: 'A126:I126', id: 'PB-123',
  assertions: Object.freeze([
    '知识草稿必须脱敏并经人工审核',
    '发布保存适用产品、版本和来源案例',
    '停用不删除历史，AI引用返回来源版本和适用范围',
    '知识库必须分类，来源为平常处理的问题单据可点击生成也可以手工新增'
  ]),
  confirmation: '确认敏感字段清单、审核层级和外部可见范围。'
})
const factTables = ['after_sales_knowledge_case', 'after_sales_knowledge_event']
const digest = (value) => createHash('sha256').update(value).digest('hex')
const exactId = (value, zero = false) => {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), 'PB123 requires lossless IDs')
  assert.match(String(value), zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/, 'PB123 invalid ID')
  return String(value)
}
const integer = (value) => {
  assert.match(String(value), /^\d+$/, 'PB123 missing census')
  assert.ok(Number.isSafeInteger(Number(value)), 'PB123 unsafe census')
  return Number(value)
}
const businessData = (payload) => {
  // Do not serialize failed responses: document bodies and server errors may contain secrets.
  assert.ok(isBusinessSuccess(payload), 'PB123 business response unsuccessful')
  return payload.data
}
const gap = (result, code, reason) => result.gaps.push({ code, reason })

export const assertKnowledgeReadinessLocalContext = (settings, tenantId) => {
  assert.equal(settings.target, 'local', 'PB123 only allows local')
  assert.equal(String(tenantId), '1', 'PB123 requires explicit tenant1')
  if (settings.tenantId) assert.equal(String(settings.tenantId), '1', 'PB123 configured tenant mismatch')
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.protocol === 'http:' && url.port === port && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash, 'PB123 requires exact local endpoints')
  }
  assert.equal(settings.apiUrl, `${settings.apiBase}/admin-api`, 'PB123 requires formal admin API')
  assertLocalDatabase(settings.db)
}

export const readKnowledgeReadinessSourceContracts = () => {
  const root = '../../../../cfor/cfor-admin/'
  const java = 'cfor-module-after-sales/cfor-module-after-sales-biz/src/main/java/tech/cfor17/module/aftersales/'
  const definitions = {
    categoryVo: `${java}controller/admin/modeling/vo/IssueCategoryCreateReqVO.java`,
    categoryCreate: `${java}controller/admin/modeling/AfterSalesModelingController.java`,
    categoryMaintenance: `${java}controller/admin/modeling/AfterSalesModelingMaintenanceController.java`,
    categoryService: `${java}service/modeling/AfterSalesModelingServiceImpl.java`,
    draftVo: `${java}controller/admin/knowledge/vo/KnowledgeCaseSaveReqVO.java`,
    draftController: `${java}controller/admin/knowledge/AfterSalesKnowledgeController.java`,
    draftService: `${java}service/knowledge/AfterSalesKnowledgeServiceImpl.java`
  }
  const sources = Object.fromEntries(Object.entries(definitions).map(([key, relative]) => {
    const file = new URL(root + relative, import.meta.url)
    return [key, { path: file.pathname, text: fs.readFileSync(file, 'utf8') }]
  }))
  const required = (text) => [...text.matchAll(
    /@(NotNull|NotBlank|NotEmpty)\s+private\s+[\w<>?, ]+\s+(\w+)\s*;/g
  )].map((match) => match[2]).sort()
  const checks = [
    JSON.stringify(required(sources.categoryVo.text)) === JSON.stringify(['categoryCode', 'categoryName']),
    JSON.stringify(required(sources.draftVo.text)) ===
      JSON.stringify(['categoryId', 'keywords', 'sourceType', 'title']),
    sources.categoryCreate.text.includes('@PostMapping("/category/create")'),
    sources.categoryCreate.text.includes("after-sales:modeling:create"),
    sources.categoryMaintenance.text.includes('@GetMapping("/category/get")'),
    sources.categoryMaintenance.text.includes('@PostMapping("/status")'),
    sources.categoryMaintenance.text.includes("after-sales:modeling:enable"),
    sources.categoryService.text.includes('row.setStatus("ENABLED")'),
    sources.draftController.text.includes('@PostMapping("/save-draft")'),
    sources.draftController.text.includes("after-sales:knowledge:edit"),
    sources.draftService.text.includes(`new ServiceException(1_040_011, "${KNOWLEDGE_DOCUMENT_REQUIRED.message}")`),
    sources.draftService.text.indexOf('new ServiceException(1_040_011,') <
      sources.draftService.text.indexOf('caseMapper.insert(value)')
  ]
  return { writeContractConfirmed: checks.every(Boolean), files: Object.fromEntries(
    Object.entries(sources).map(([key, source]) => [key, { path: source.path, sha256: digest(source.text) }])
  ) }
}

// Every persisted field is hashed inside a read-only transaction, including soft-deleted facts.
export const readAfterSalesKnowledgeFactSnapshot = async (readSql = runReadOnlySql) => {
  const names = factTables.map((table) => `'${table}'`).join(', ')
  const schema = await readSql(`
    SELECT 'schema-count', table_name, COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name IN (${names}) GROUP BY table_name;
    SELECT 'column', table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name IN (${names}) ORDER BY table_name, ordinal_position
  `)
  assert.equal(schema.available, true, 'PB123 requires read-only schema evidence')
  const columns = {}
  for (const table of factTables) {
    const census = schema.rows.filter((row) => row[0] === 'schema-count' && row[1] === table)
    assert.equal(census.length, 1, 'PB123 missing schema census')
    columns[table] = schema.rows.filter((row) => row[0] === 'column' && row[1] === table)
      .map(([, , name, type]) => {
        assert.match(name, /^[a-z][a-z0-9_]*$/, 'PB123 unsafe column')
        return { name, type }
      })
    assert.equal(columns[table].length, integer(census[0][2]), 'PB123 incomplete schema')
    assert.equal(new Set(columns[table].map((column) => column.name)).size, columns[table].length)
    assert.ok(['id', 'tenant_id', 'deleted', 'create_time', 'update_time'].every(
      (name) => columns[table].some((column) => column.name === name)), 'PB123 missing fact identity/audit')
  }
  const snapshot = await readSql(factTables.map((table) => {
    const fields = columns[table].map(({ name, type }) =>
      `'${name}', ${type.toLowerCase() === 'bit' ? `CAST(\`${name}\` AS UNSIGNED)` : `\`${name}\``}`).join(', ')
    return `
      SELECT 'count', '${table}', COUNT(*) FROM ${table} WHERE tenant_id = 1;
      SELECT 'row', '${table}', CAST(id AS CHAR),
        SHA2(CAST(JSON_OBJECT(${fields}) AS CHAR), 256)
      FROM ${table} WHERE tenant_id = 1 ORDER BY id
    `
  }).join(';'))
  assert.equal(snapshot.available, true, 'PB123 requires read-only fact evidence')
  return Object.fromEntries(factTables.map((table) => {
    const census = snapshot.rows.filter((row) => row[0] === 'count' && row[1] === table)
    assert.equal(census.length, 1, 'PB123 missing row census')
    const rows = snapshot.rows.filter((row) => row[0] === 'row' && row[1] === table)
      .map(([, , value, hash]) => {
        assert.match(hash || '', /^[a-f0-9]{64}$/, 'PB123 invalid fact hash')
        return { id: exactId(value), hash }
      }).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
    assert.equal(rows.length, integer(census[0][2]), 'PB123 truncated facts')
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'PB123 duplicate fact')
    return [table, { columns: columns[table], count: rows.length, rows }]
  }))
}

export const auditKnowledgeDocumentReadiness = async ({ api, readSql = runReadOnlySql, maxPages = 20 }) => {
  assert.ok(Number.isSafeInteger(maxPages) && maxPages > 0, 'PB123 invalid page bound')
  const documents = []
  const pages = []
  let total
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const pathname = '/ai/knowledge/document/page?' + new URLSearchParams({
      status: '0', parseStatus: 'PARSED', indexStatus: 'INDEXED',
      pageNo: String(pageNo), pageSize: '100'
    })
    const data = businessData(await api.get(pathname))
    assert.ok(Array.isArray(data?.list) && Number.isSafeInteger(data.total) && data.total >= 0,
      'PB123 invalid document page')
    if (total === undefined) total = data.total
    assert.equal(data.total, total, 'PB123 document census drift')
    assert.equal(data.list.length, Math.min(100, Math.max(0, total - (pageNo - 1) * 100)),
      'PB123 truncated document page')
    pages.push({ pageNo, pageSize: 100, total, count: data.list.length, businessCode: 0 })
    for (const row of data.list) {
      assert.equal(row.status, 0)
      assert.equal(row.parseStatus, 'PARSED')
      assert.equal(row.indexStatus, 'INDEXED')
      documents.push({
        id: exactId(row.id), knowledgeId: exactId(row.knowledgeId), status: row.status,
        parseStatus: row.parseStatus, indexStatus: row.indexStatus,
        // The formal VO omits versionNo. Unknown stays unknown until SQL confirms it.
        apiVersion: row.versionNo == null ? null : integer(row.versionNo)
      })
    }
    if (documents.length === total) break
  }
  assert.equal(documents.length, total, 'PB123 document page bound exceeded')
  assert.equal(new Set(documents.map((row) => row.id)).size, documents.length, 'PB123 duplicate document')
  const ids = documents.map((row) => row.id).join(', ') || '0'
  const sql = await readSql(`
    SELECT 'document-count', COUNT(*) FROM ai_knowledge_document
    WHERE tenant_id = 1 AND deleted = 0 AND status = 0 AND parse_status = 'PARSED' AND index_status = 'INDEXED';
    SELECT 'document', CAST(d.id AS CHAR), CAST(d.knowledge_id AS CHAR), d.version_no,
      d.status, d.parse_status, d.index_status, CAST(d.tenant_id AS CHAR), CAST(d.deleted AS UNSIGNED),
      (SELECT COUNT(*) FROM ai_knowledge_segment s WHERE s.tenant_id = 1 AND s.document_id = d.id
        AND s.knowledge_id = d.knowledge_id AND s.deleted = 0 AND s.status = 0
        AND s.vector_id IS NOT NULL AND s.vector_id <> '')
    FROM ai_knowledge_document d WHERE d.tenant_id = 1 AND d.id IN (${ids}) ORDER BY d.id
  `)
  assert.equal(sql.available, true, 'PB123 requires SQL version/readiness confirmation')
  const census = sql.rows.filter((row) => row[0] === 'document-count')
  assert.equal(census.length, 1)
  assert.equal(integer(census[0][1]), total, 'PB123 API/tenant SQL readiness census mismatch')
  const rows = sql.rows.filter((row) => row[0] === 'document')
  assert.equal(rows.length, documents.length, 'PB123 incomplete SQL document metadata')
  assert.equal(new Set(rows.map((row) => row[1])).size, rows.length, 'PB123 duplicate SQL document')
  const metadata = documents.map((document) => {
    const matches = rows.filter((row) => row[1] === document.id)
    assert.equal(matches.length, 1)
    const [, , knowledgeId, version, status, parseStatus, indexStatus, tenantId, deleted, segments] = matches[0]
    assert.equal(exactId(knowledgeId), document.knowledgeId)
    assert.equal(tenantId, '1')
    assert.equal(integer(deleted), 0)
    assert.equal(integer(status), 0)
    assert.equal(parseStatus, 'PARSED')
    assert.equal(indexStatus, 'INDEXED')
    const versionNo = version == null || version === 'NULL' ? null : integer(version)
    if (document.apiVersion !== null) assert.equal(document.apiVersion, versionNo, 'PB123 version drift')
    const indexedSegments = integer(segments)
    const usable = versionNo !== null && versionNo > 0 && indexedSegments > 0
    const { apiVersion, ...safe } = document
    return { ...safe, versionNo, versionSource: versionNo === null ? 'UNKNOWN' : 'READ_ONLY_SQL',
      indexedSegments, usable,
      reasons: [...(versionNo === null || versionNo <= 0 ? ['EXACT_VERSION_UNKNOWN'] : []),
        ...(indexedSegments === 0 ? ['NO_INDEXED_SEGMENT_EVIDENCE'] : [])] }
  })
  return { pages, total, metadata, candidates: metadata.filter((row) => row.usable),
    noIndexedSample: !metadata.some((row) => row.usable), positiveExecuted: false }
}

export const resolveAfterSalesKnowledgeRoute = (menus) => {
  assert.ok(Array.isArray(menus), 'PB123 missing permission menus')
  const found = []
  const walk = (nodes, parent = '') => {
    for (const node of nodes) {
      if (typeof node.path !== 'string' || /[?#\\]|^(?:[\w+-]+:|\/\/)/.test(node.path) ||
          node.path.split('/').some((part) => ['.', '..'].includes(part))) continue
      const route = (node.path.startsWith('/') ? node.path : `${parent}/${node.path}`).replace(/\/+/g, '/')
      if (node.children?.length) walk(node.children, route)
      else if (String(node.component || '').replace(/^\/|\.vue$/g, '') === 'after-sales/knowledge/index') {
        found.push({ route, menuId: exactId(node.id), component: node.component })
      }
    }
  }
  walk(menus)
  assert.ok(found.length <= 1, 'PB123 ambiguous formal knowledge component routes')
  // Missing access prerequisites are not failures of a page that was never executed.
  return found[0] || null
}

const browserReads = new Set([
  '/system/auth/get-permission-info', '/system/user/profile/get', '/system/dict-data/simple-list',
  '/system/notify-message/get-unread-list', '/system/notify-message/get-unread-count',
  '/oa/announcement/received-page',
  '/after-sales/ticket/list', '/after-sales/asset/list', '/after-sales/asset/details',
  '/after-sales/asset/customer/list', '/after-sales/knowledge/list'
])
export const isSafeKnowledgePageRequest = ({ url, method, tenantId }, settings = config) => {
  const parsed = new URL(url)
  const webOrigin = new URL(settings.webBase).origin
  const apiOrigin = new URL(settings.apiBase).origin
  if (![webOrigin, apiOrigin].includes(parsed.origin)) return false
  if (parsed.pathname.startsWith('/admin-api/')) {
    return browserReads.has(parsed.pathname.slice('/admin-api'.length)) &&
      (method === 'OPTIONS' || (method === 'GET' && String(tenantId) === '1'))
  }
  return parsed.origin === webOrigin && method === 'GET'
}
export const assertKnowledgePageText = (text) => {
  assert.doesNotMatch(text,
    /模块配置异常|页面加载失败|页面不存在|Page Not Found|\b404\b|\b403\b|无权限|没有权限|权限不足|权限拒绝|拒绝访问|Forbidden|Access Denied|登录已过期|请重新登录/i,
    'PB123 error/permission page')
}

// Supply a fresh authenticated page, without the runner's raw response recorder.
export const auditAfterSalesKnowledgePage = async ({
  page, route, screenshotPath, settings = config, timeoutMs = 15000
}) => {
  assertKnowledgeReadinessLocalContext(settings, '1')
  assert.ok(page && page.listenerCount('response') === 0, 'PB123 requires a recorder-free page')
  assert.equal(page.context().serviceWorkers().length, 0, 'PB123 active service workers are unsafe')
  assert.ok(path.isAbsolute(screenshotPath || '') && screenshotPath.endsWith('.png'),
    'PB123 requires absolute PNG evidence path')
  assert.ok(typeof route === 'string' && route.startsWith('/') && !route.startsWith('//') &&
    !/[?#\\]/.test(route) && !route.split('/').some((part) => ['.', '..'].includes(part)),
  'PB123 invalid formal page route')
  const errors = []
  const pending = new Set()
  const reads = []
  const guard = async (intercept) => {
    const request = intercept.request()
    const safe = isSafeKnowledgePageRequest({
      url: request.url(), method: request.method(), tenantId: request.headers()['tenant-id']
    }, settings)
    if (!safe) { errors.push('UNSAFE_PAGE_REQUEST_BLOCKED'); await intercept.abort('blockedbyclient') }
    else await intercept.continue()
  }
  const onResponse = (response) => {
    const request = response.request()
    const url = new URL(response.url())
    if ((!response.ok() && response.status() !== 304) &&
        ['document', 'script'].includes(request.resourceType())) errors.push('PAGE_RESOURCE_FAILED')
    if (!url.pathname.startsWith('/admin-api/') || request.method() === 'OPTIONS') return
    const task = (async () => {
      assert.equal(response.status(), 200)
      assert.equal(request.method(), 'GET')
      assert.equal(request.headers()['tenant-id'], '1')
      const text = await response.text()
      const payload = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
      const data = businessData(payload)
      const entry = { pathname: url.pathname, method: 'GET', status: 200, code: 0 }
      if (/^\/admin-api\/after-sales\/(?:knowledge\/list|ticket\/list|asset\/(?:list|details|customer\/list))$/.test(url.pathname)) {
        assert.ok(Array.isArray(data), 'PB123 invalid real knowledge list')
        entry.count = data.length
      }
      if (url.pathname === '/admin-api/after-sales/knowledge/list') {
        assert.equal(url.search, '', 'PB123 expected unfiltered real knowledge list')
      }
      reads.push(entry)
    })().catch(() => errors.push('PAGE_API_FAILED')).finally(() => pending.delete(task))
    pending.add(task)
  }
  const onFailure = () => errors.push('PAGE_NETWORK_FAILED')
  const onPageError = () => errors.push('PAGE_SCRIPT_ERROR')
  const onConsole = (message) => { if (message.type() === 'error') errors.push('PAGE_CONSOLE_ERROR') }
  page.on('response', onResponse)
  page.on('requestfailed', onFailure)
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  let result
  try {
    await page.route('**/*', guard)
    const navigation = await page.goto(`${settings.webBase}${route}`,
      { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    assert.ok(navigation?.ok() && navigation.status() === 200, 'PB123 failed page document')
    assert.equal(new URL(page.url()).pathname, route, 'PB123 page redirected')
    const root = page.locator('.after-sales-page.knowledge-page')
    await root.waitFor({ state: 'visible', timeout: timeoutMs })
    const deadline = Date.now() + timeoutMs
    const hydrated = () => {
      const initial = ['ticket/list', 'asset/list', 'asset/customer/list', 'knowledge/list']
      if (!initial.every((endpoint) => reads.some((read) =>
        read.pathname === `/admin-api/after-sales/${endpoint}`))) return false
      const assets = reads.find((read) => read.pathname === '/admin-api/after-sales/asset/list')
      return reads.filter((read) => read.pathname === '/admin-api/after-sales/asset/details')
        .reduce((sum, read) => sum + read.count, 0) === assets.count
    }
    while (pending.size || !hydrated()) {
      assert.equal(errors.length, 0, 'PB123 page failed')
      assert.ok(Date.now() < deadline, 'PB123 missing real knowledge response')
      await delay(20)
    }
    assertKnowledgePageText(await page.locator('body').innerText())
    assert.equal((await root.locator('h1').innerText()).trim(), '知识案例')
    assert.equal((await root.locator('h2').innerText()).trim(), '知识库目录')
    const list = reads.filter((read) => read.pathname === '/admin-api/after-sales/knowledge/list')
    assert.equal(list.length, 1, 'PB123 ambiguous browser knowledge hydration')
    const expectedRows = Math.min(10, list[0].count)
    await page.waitForFunction((expected) => document.querySelectorAll(
      '.knowledge-page .knowledge-feed-item').length === expected, expectedRows, { timeout: timeoutMs })
    await page.screenshot({ path: screenshotPath, fullPage: true, mask: [
      page.locator('.knowledge-feed-item, .knowledge-table .el-table__body-wrapper'),
      page.locator('.knowledge-category-panel .el-tree, .knowledge-page .el-select__selection'),
      page.locator('.global-ai-assistant, .global-ai-message, .el-popover, .el-notification')
    ] })
    assert.equal(errors.length, 0, 'PB123 page failed')
    assert.equal(page.context().serviceWorkers().length, 0)
    result = { loaded: true, route, title: '知识案例', reads, displayedRows: expectedRows,
      screenshotPath, screenshotMasked: true, readOnly: true }
  } finally {
    try {
      await page.unroute('**/*', guard)
      await Promise.all([...pending])
    } finally {
      page.off('response', onResponse)
      page.off('requestfailed', onFailure)
      page.off('pageerror', onPageError)
      page.off('console', onConsole)
    }
  }
  assert.equal(errors.length, 0, 'PB123 late page failure')
  return result
}

const ownedCategory = (row, expected, categoryId) => {
  assert.ok(row, 'PB123 category missing')
  if (categoryId) assert.equal(exactId(row.id), categoryId)
  assert.equal(row.categoryCode, expected.categoryCode, 'PB123 category ownership mismatch')
  assert.equal(row.categoryName, expected.categoryName, 'PB123 category ownership mismatch')
  assert.equal(exactId(row.parentId, true), '0')
  if (row.tenantId != null) assert.equal(exactId(row.tenantId), '1', 'PB123 category tenant mismatch')
  assert.equal(row.leafFlag, true)
  assert.equal(row.defaultPriority, expected.defaultPriority, 'PB123 category priority mismatch')
  assert.equal(row.applicableServiceStatus, expected.applicableServiceStatus, 'PB123 category scope mismatch')
  assert.equal(row.sortNo, expected.sortNo, 'PB123 category sort mismatch')
  return exactId(row.id)
}

const confirmOwnedCategory = async (row, expected, categoryId, readSql) => {
  const id = ownedCategory(row, expected, categoryId)
  // Category DO extends BaseDO, not TenantBaseDO; tenant is confirmed without altering the API.
  const result = await readSql(`
    SELECT 'owned-category', CAST(id AS CHAR), CAST(tenant_id AS CHAR), category_code, category_name,
      CAST(parent_id AS CHAR), CAST(leaf_flag AS UNSIGNED), status, CAST(deleted AS UNSIGNED)
    FROM after_sales_issue_category WHERE tenant_id = 1 AND id = ${id}
  `)
  assert.equal(result.available, true, 'PB123 category tenant SQL unavailable')
  assert.equal(result.rows.length, 1, 'PB123 category tenant SQL incomplete')
  assert.deepEqual(result.rows[0], [
    'owned-category', id, '1', expected.categoryCode, expected.categoryName, '0', '1', row.status, '0'
  ], 'PB123 category API SQL ownership mismatch')
  return id
}

export const runProjectAfterSalesKnowledgeReadiness = async ({
  token, tenantId, runId, caseRecord = {}, page, screenshotPath
}, dependencies = {}) => {
  const settings = dependencies.settings || config
  assertKnowledgeReadinessLocalContext(settings, tenantId)
  if (caseRecord.environment?.tenantId != null) {
    assert.equal(String(caseRecord.environment.tenantId), '1', 'PB123 record tenant mismatch')
  }
  assert.ok(typeof token === 'string' && token.trim(), 'PB123 requires authenticated token')
  assert.match(runId || '', /^[A-Za-z0-9_-]{1,80}$/, 'PB123 requires current run ID')
  const result = {
    partial: true, acceptanceComplete: false, passCandidate: false, positiveExecuted: false,
    auditSucceeded: true, negativeComplete: false, tenantId: '1', requirementSource: PB123_REQUIREMENT_SOURCE,
    gaps: [], failures: [], candidateAssertionEvidence: []
  }
  caseRecord.projectAfterSalesKnowledgeReadiness = result
  const attempt = async (stage, action) => {
    try { return await action() } catch (error) {
      result.auditSucceeded = false
      const firstLine = String(error?.message || '').split('\n')[0]
      const fixedAssertion = error?.code === 'ERR_ASSERTION' && /^PB123 [A-Za-z0-9 /:-]+$/.test(firstLine)
      result.failures.push({ stage, reason: '审计失败；未保存响应正文或原始异常',
        errorType: ['AssertionError', 'TypeError', 'SyntaxError', 'Error'].includes(error?.name)
          ? error.name : 'Error',
        ...(error?.code === 'ERR_ASSERTION'
          ? { assertionMessage: fixedAssertion ? firstLine : 'Assertion failed (values omitted)' } : {}) })
      return undefined
    }
  }
  // No check/record is passed to the general client, whose bodySummary retains document content.
  const api = (dependencies.createApiClient || createApiClient)({ token, tenantId: '1' })
  const readSql = dependencies.readSql || runReadOnlySql
  const source = await attempt('source-contract', () =>
    (dependencies.readSources || readKnowledgeReadinessSourceContracts)())
  result.sourceContracts = source
  const info = await attempt('permission-audit', async () =>
    businessData(await api.get('/system/auth/get-permission-info')))
  const permissions = Array.isArray(info?.permissions) ? info.permissions : []
  const requiredPermissions = [
    'after-sales:modeling:create', 'after-sales:modeling:query', 'after-sales:modeling:enable',
    'after-sales:knowledge:edit', 'after-sales:knowledge:query'
  ]
  result.permissions = { required: requiredPermissions,
    missing: requiredPermissions.filter((permission) => !permissions.includes(permission)) }
  result.readiness = await attempt('document-readiness', () =>
    auditKnowledgeDocumentReadiness({ api, readSql }))
  if (!result.readiness) {
    gap(result, 'READINESS_UNKNOWN', '正式GET或只读SQL就绪审计失败；不能推断样本不存在，不运行正例')
  } else if (result.readiness.noIndexedSample) {
    gap(result, 'NO_REAL_INDEXED_SAMPLE', '没有已由正式GET和只读SQL交叉确认版本及索引分片的可用文档；不运行正例')
  }
  let menu
  if (result.permissions.missing.length) {
    gap(result, 'PERMISSION_GAP', '正式现有权限缺失；负例未完成，不扩共享角色或套餐')
  }
  menu = await attempt('page-route', () => resolveAfterSalesKnowledgeRoute(info?.menus))
  if (menu === null) {
    result.pageRoute = { available: false, source: 'FORMAL_PERMISSION_MENUS', matchingRoutes: 0 }
    gap(result, 'PAGE_ROUTE_UNAVAILABLE',
      '正式权限菜单未包含知识案例组件入口；隐藏静态deep-link不作为可见菜单，不构造路由或执行页面')
  } else if (menu) {
    result.pageRoute = { available: true, source: 'FORMAL_PERMISSION_MENUS', ...menu }
  }
  const pageQueryAllowed = !result.permissions.missing.includes('after-sales:knowledge:query')
  if (page && menu && pageQueryAllowed) {
    result.page = await attempt('knowledge-page', () => auditAfterSalesKnowledgePage({
      page, route: menu.route, screenshotPath, settings
    }))
  } else if (menu && !pageQueryAllowed) {
    gap(result, 'PAGE_PERMISSION_UNAVAILABLE', '正式菜单入口存在但知识查询权限缺失；未执行页面，不扩共享权限')
  } else gap(result, 'PAGE_NOT_AUDITED', '缺少正式权限菜单或独立已登录页面；页面证据未验证')
  const writeFlag = dependencies.writeFlag ?? process.env.CFOR_E2E_WRITE_FIXTURES
  result.writeGate = { target: 'local', tenantId: '1', enabled: writeFlag === 'true', safetyPassed: false }
  let canWrite = writeFlag === 'true' && source?.writeContractConfirmed === true &&
    result.permissions.missing.length === 0
  if (!canWrite) gap(result, 'NEGATIVE_NOT_EXECUTED',
    'writeflag、正式分类/草稿契约或现有权限未满足；仅保留只读审计，不修改授权')
  if (canWrite) {
    const preflightRecord = {}
    canWrite = await attempt('write-safety', async () => {
      await (dependencies.assertWriteSafety || assertLocalWriteSafety)(preflightRecord)
      return true
    })
    result.writeGate.safetyPassed = canWrite === true
    result.writeGate.database = preflightRecord.database
  }
  if (canWrite) {
    const suffix = digest(`${runId}:${randomUUID()}`).slice(0, 20)
    const category = { categoryCode: `E2E-PB123-${suffix}`, categoryName: `E2E-PB123-${suffix}`,
      parentId: '0', defaultPriority: 'P2', applicableServiceStatus: 'IN_SERVICE', sortNo: 902 }
    let createAttempted = false
    let categoryId
    const readSnapshot = dependencies.readSnapshot || (() => readAfterSalesKnowledgeFactSnapshot(readSql))
    await attempt('negative', async () => {
      try {
        const list = businessData(await api.get('/after-sales/modeling/category/list'))
        assert.ok(Array.isArray(list), 'PB123 invalid category inventory')
        assert.equal(list.filter((row) => row.categoryCode === category.categoryCode).length, 0)
        // Prove the full fact snapshot is available before any fixture mutation.
        await readSnapshot()
        createAttempted = true
        categoryId = exactId(businessData(await api.post('/after-sales/modeling/category/create', category)))
        const row = businessData(await api.get(`/after-sales/modeling/category/get?id=${categoryId}`))
        await confirmOwnedCategory(row, category, categoryId, readSql)
        assert.equal(row.status, 'ENABLED')
        result.category = { id: categoryId, ...category, tenantId: '1', readbackStatus: row.status }
        const before = await readSnapshot()
        let response
        try {
          response = await api.post('/after-sales/knowledge/save-draft', {
            categoryId, title: `E2E-PB123-REQUIRED-${suffix}`, keywords: ['E2E-PB123'],
            sourceType: 'MANUAL', desensitizationStatus: 'PENDING',
            applicableScope: 'E2E-PB123 dedicated local audit'
          }, { expectedBusinessRejection: KNOWLEDGE_DOCUMENT_REQUIRED })
        } finally {
          const after = await readSnapshot()
          const unchanged = JSON.stringify(before) === JSON.stringify(after)
          result.negative = { expected: KNOWLEDGE_DOCUMENT_REQUIRED, before, after, unchanged,
            matched: response != null && matchesExpectedBusinessRejection(response, KNOWLEDGE_DOCUMENT_REQUIRED) &&
              response?.msg === KNOWLEDGE_DOCUMENT_REQUIRED.message,
            observedCode: Number.isSafeInteger(response?.code) ? response.code : null }
        }
        assert.equal(result.negative.matched, true, 'PB123 wrong rejection reason')
        assert.equal(result.negative.unchanged, true, 'PB123 knowledge facts changed')
      } finally {
        if (createAttempted) {
          const cleaned = await attempt('category-cleanup', async () => {
            // Recover ownership even if create committed but its response/readback failed.
            const list = businessData(await api.get('/after-sales/modeling/category/list'))
            assert.ok(Array.isArray(list))
            const matches = list.filter((row) => row.categoryCode === category.categoryCode)
            assert.equal(matches.length, 1, 'PB123 cleanup ownership unresolved')
            const cleanupId = await confirmOwnedCategory(matches[0], category, categoryId, readSql)
            assert.equal(businessData(await api.post(
              `/after-sales/modeling/status?configType=CATEGORY&id=${cleanupId}&enabled=false`, undefined)),
            true, 'PB123 category disable response unsuccessful')
            const row = businessData(await api.get(`/after-sales/modeling/category/get?id=${cleanupId}`))
            await confirmOwnedCategory(row, category, cleanupId, readSql)
            assert.equal(row.status, 'DISABLED', 'PB123 category cleanup not persisted')
            return { id: cleanupId, status: 'DISABLED', readback: true, completed: true }
          })
          result.categoryCleanup = cleaned || { completed: false, ownershipUnresolved: true }
        }
      }
    })
  }
  result.negativeComplete = result.negative?.matched === true && result.negative?.unchanged === true &&
    result.categoryCleanup?.completed === true && result.writeGate.safetyPassed === true
  result.candidateAssertionEvidence = PB123_REQUIREMENT_SOURCE.assertions.map((assertion, index) => ({
    sourceCell: 'G126', assertion, acceptanceComplete: false,
    observations: index === 3 ? {
      categoryCreatedAndReadback: Boolean(result.category),
      categoryDisabledAndReadback: result.categoryCleanup?.readback === true,
      documentReferenceRequired: result.negative?.matched === true && result.negative?.unchanged === true,
      pageReadOnlyLoaded: result.page?.loaded === true
    } : {},
    remaining: [
      '本helper不执行脱敏/人工审核/发布正例',
      '未验证发布产品/版本/来源案例',
      '未执行案例停用与AI引用版本/适用范围',
      '未执行来源问题单生成或合法关联文档手工新增'
    ][index]
  }))
  gap(result, 'POSITIVE_OUT_OF_SCOPE', '本helper只做安全负例与就绪审计；候选证据不自动VERIFIED')
  gap(result, 'PRODUCT_CONFIRMATION_REQUIRED', PB123_REQUIREMENT_SOURCE.confirmation)
  return result
}
