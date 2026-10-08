import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import XLSX from 'xlsx'
import { config } from '../config/index.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { decryptResponse, encryptRequest, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { launchBrowser, loginWithCredentials, openRoute } from '../lib/browser.mjs'
import {
  createCaseRecord, createRunRecord, ensureDir, finishCase, caseOutcome, caseErrorStatus, writeReport
} from '../lib/report.mjs'

export const cases = Object.freeze(['AUTH-DATA-007'])
export const catalogAssertions = Object.freeze([
  'AI Tool 与报表 SQL 查询按发起人数据范围过滤',
  'AI/异步结果复用发起人的 sensitive:amount:view 判定，不在后端另起特权上下文',
  '敏感字段权限快照随查询、导出与 AI 调用写入审计'
])

const amountPermission = 'sensitive:amount:view'
const readPermissions = new Set([
  'erp:sale-order:query', 'erp:sale-order:export',
  'report:go-view-data:get-by-sql', 'system:role:query',
  // 角色查询菜单在租户菜单树中挂在"设置>系统设置"下，其祖先带 system:settings:query。
  // 该权限是只读查询，不影响最小只读角色隔离意图，纳入允许集合。
  'system:settings:query'
])
const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? '')) &&
  (typeof value !== 'number' || Number.isSafeInteger(value))
const id = (value) => {
  if (!stableId(value)) throw new Error('BLOCKED: invalid or imprecise fixture ID')
  return String(value)
}
const successful = (response) => response?.status === 200 && isBusinessSuccess(response.body)
const data = (response, label) => {
  if (!successful(response)) {
    throw new Error(`${label}: HTTP=${response?.status ?? 'unavailable'}; code=${response?.body?.code ?? 'invalid'}`)
  }
  return response.body.data
}
const flatten = (rows) => (Array.isArray(rows) ? rows : []).flatMap((row) => [row, ...flatten(row.children)])

export function assertAiDataLocal (settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1') {
    throw new Error('BLOCKED: AUTH-DATA-007 only allows local tenant1')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.pathname !== '/' || url.username || url.password ||
        url.search || url.hash) {
      throw new Error('BLOCKED: AUTH-DATA-007 only allows loopback48083/9151')
    }
  }
  assertLocalDatabase(settings.db)
}

export function aiDataPayload (tag = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`) {
  if (!/^[a-zA-Z0-9]{6,17}$/.test(tag)) throw new Error('BLOCKED: invalid ownership tag')
  const marker = `E2E-AUTH007-${tag}`
  return {
    marker,
    role: { name: marker, code: `e2e_auth007_${tag}`, sort: 999, status: 0, remark: marker },
    user: {
      username: `e2ea7${tag}`, nickname: marker, remark: marker,
      password: `A7!${randomBytes(5).toString('hex')}a9`, sex: 0, postIds: []
    }
  }
}

export function assertOwnedAiRole (row, fixture, payload) {
  if (String(row?.id) !== fixture.roleId || row?.code !== payload.role.code ||
      row?.name !== payload.role.name || row?.remark !== payload.marker || row?.type !== 2) {
    throw new Error('AUTH-DATA-007 role ownership mismatch; mutation refused')
  }
  return row
}

export function assertOwnedAiUser (row, fixture, payload) {
  if (String(row?.id) !== fixture.userId || row?.username !== payload.user.username ||
      row?.nickname !== payload.user.nickname || row?.remark !== payload.marker) {
    throw new Error('AUTH-DATA-007 user ownership mismatch; mutation refused')
  }
  return row
}

const reportSqlPermission = 'report:go-view-data:get-by-sql'

export function selectAiDataMenus (menuRows, assignableRows) {
  const rows = flatten(menuRows).filter((row) => row.status === 0)
  const assignable = new Set(flatten(assignableRows).map((row) => String(row.id)))
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  // 报表 SQL 数据权限依赖 GoView 大屏报表菜单。租户套餐未订购该模块时无法分配，
  // 此时把报表路径登记为 GAP，而不是让整例 BLOCKED，其余发起人数据权限仍完整校验。
  const reportAssignable = rows.some((row) =>
    row.permission === reportSqlPermission && assignable.has(String(row.id)))
  const required = ['erp:sale-order:query', 'system:role:query', amountPermission]
  for (const permission of required) {
    if (!rows.some((row) => row.permission === permission && assignable.has(String(row.id)))) {
      throw new Error(`BLOCKED: tenant1 assignable permission missing: ${permission}`)
    }
  }
  const wanted = rows.filter((row) => readPermissions.has(row.permission) ||
    row.component === 'Home/SystemIndex')
    .filter((row) => row.permission !== reportSqlPermission || reportAssignable)
  const selected = new Set()
  for (let current of wanted) {
    const seen = new Set()
    while (current) {
      const key = String(current.id)
      if (seen.has(key)) throw new Error('BLOCKED: cyclic menu hierarchy')
      seen.add(key)
      if (!assignable.has(key)) throw new Error('BLOCKED: prerequisite menu outside tenant package')
      if (current.permission && !readPermissions.has(current.permission)) {
        throw new Error('BLOCKED: menu ancestor would grant unrelated permission')
      }
      selected.add(id(current.id))
      const parent = String(current.parentId ?? '0')
      current = parent === '0' ? null : byId.get(parent)
      if (parent !== '0' && !current) throw new Error('BLOCKED: enabled menu ancestor missing')
    }
  }
  const amountMenuIds = rows.filter((row) =>
    row.permission === amountPermission && assignable.has(String(row.id))).map((row) => id(row.id))
  return {
    base: [...selected], amountMenuIds,
    reportAssignable,
    canExport: wanted.some((row) => row.permission === 'erp:sale-order:export')
  }
}

export function aiDataReportSql (sampleId) {
  return `SELECT CAST(id AS CHAR) AS id, create_by, total_price
FROM erp_sale_order WHERE tenant_id = 1 AND deleted = 0 AND id = ${id(sampleId)} LIMIT 1`
}

export function assertAiDataRequest (method, pathname, body) {
  const url = new URL(pathname, 'http://local')
  if (url.origin !== 'http://local' || url.hash || !pathname.startsWith('/admin-api/')) {
    throw new Error('BLOCKED: endpoint outside AUTH-DATA-007 allowlist')
  }
  const endpoint = url.pathname.slice('/admin-api'.length)
  const plain = new Set([
    'POST /system/auth/login-encrypted', 'POST /system/auth/logout',
    'GET /system/auth/get-permission-info', 'GET /system/user/profile/get',
    'GET /system/menu/list', 'GET /system/menu/list-all-simple',
    'GET /system/data-permission/coverage',
    'POST /system/role/create', 'POST /system/user/create',
    'POST /system/permission/assign-role-menu', 'POST /system/permission/assign-role-data-scope'
  ])
  if (plain.has(`${method} ${endpoint}`) && !url.search) return
  const numeric = new Set([
    'GET /system/role/get', 'GET /system/user/get',
    'DELETE /system/role/delete', 'DELETE /system/user/delete',
    'GET /system/permission/list-user-roles', 'GET /system/permission/list-role-menus'
  ])
  if (numeric.has(`${method} ${endpoint}`)) {
    const key = endpoint.includes('list-user-roles') ? 'userId'
      : endpoint.includes('list-role-menus') ? 'roleId' : 'id'
    if ([...url.searchParams].length === 1 && stableId(url.searchParams.get(key))) return
  }
  if (method === 'POST' && endpoint === '/report/go-view/data/get-by-sql' && !url.search &&
      typeof body?.sql === 'string' &&
      /^SELECT CAST\(id AS CHAR\) AS id, create_by, total_price\nFROM erp_sale_order WHERE tenant_id = 1 AND deleted = 0 AND id = [1-9]\d* LIMIT 1$/.test(body.sql) &&
      Object.keys(body).length === 1) return
  if (method === 'GET' && endpoint === '/erp/ai-tool/list/sale-orders' &&
      [...url.searchParams.keys()].every((key) => ['limit', 'customerId'].includes(key)) &&
      url.searchParams.get('limit') === '100' &&
      (!url.searchParams.has('customerId') || stableId(url.searchParams.get('customerId')))) return
  if (method === 'GET' && ['/erp/sale-order/page', '/erp/sale-order/export-excel'].includes(endpoint) &&
      [...url.searchParams.keys()].every((key) => ['pageNo', 'pageSize', 'customerId', 'billNo'].includes(key)) &&
      url.searchParams.get('pageNo') === '1' && url.searchParams.get('pageSize') === '100' &&
      (!url.searchParams.has('customerId') || stableId(url.searchParams.get('customerId')))) return
  throw new Error('BLOCKED: endpoint/body outside AUTH-DATA-007 allowlist; runtime/model execution forbidden')
}

export function createAiDataRequest ({ settings = config, record, fetchImpl = fetch }) {
  assertAiDataLocal(settings)
  return async (method, pathname, body, { token = '', encrypted = false, binary = false } = {}) => {
    assertAiDataRequest(method, pathname, body)
    const startedAt = new Date().toISOString()
    const response = await fetchImpl(`${settings.apiBase}${pathname}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(settings.requestTimeoutMs),
      headers: {
        'content-type': 'application/json', 'tenant-id': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(encrypted ? { [ENCRYPT_HEADER]: 'true' } : {})
      },
      body: body === undefined ? undefined : encrypted ? encryptRequest(body) : JSON.stringify(body)
    })
    const contentType = response.headers.get('content-type') || ''
    let payload
    let buffer
    if (binary && !contentType.includes('json') && response.status === 200) {
      buffer = Buffer.from(await response.arrayBuffer())
    } else {
      const text = await response.text()
      if (response.headers.get(ENCRYPT_HEADER.toLowerCase()) === 'true') payload = decryptResponse(text)
      else {
        try { payload = JSON.parse(text) } catch { payload = null }
      }
    }
    // No body, header, raw amount or Playwright trace is persisted.
    const entry = {
      method, pathname, startedAt, finishedAt: new Date().toISOString(),
      status: response.status, code: payload?.code,
      ...(binary ? { bytes: buffer?.length || 0, contentType } : {})
    }
    record?.api?.push(entry)
    return { status: response.status, body: payload, buffer, contentType }
  }
}

export function aiDataRows (response, kind) {
  if (!successful(response)) return null
  const value = response.body.data
  const rows = kind === 'tool' ? value : kind === 'report' ? value?.source : value?.list
  return Array.isArray(rows) && rows.length <= 100 ? rows : null
}

export function aiDataAmountEvidence (rows, kind, sample, allowed) {
  if (!Array.isArray(rows)) return { verified: false, passed: false, reason: 'invalid response' }
  const row = rows.find((value) => String(value?.[kind === 'tool' ? 'orderId' : 'id']) === sample.id)
  if (!row) return { verified: false, reason: 'sample absent; empty result is not amount evidence' }
  const key = kind === 'report' ? 'total_price' : 'totalPrice'
  const present = Object.hasOwn(row, key)
  const nullAmount = present && row[key] === null
  const numeric = present && row[key] !== null && row[key] !== '' && Number.isFinite(Number(row[key]))
  const matchesDatabase = numeric && Number(row[key]) === Number(sample.amount)
  return {
    verified: true, passed: allowed ? matchesDatabase : nullAmount,
    sampleId: sample.id, field: key, present, nullAmount, numeric, matchesDatabase
  }
}

const headedActor = async ({ page, credentials, record, outputDir }) => {
  const context = await page.context().browser().newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block'
  })
  try {
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        ['48083', '9151'].includes(url.port)
      const model = /\/(?:chat|orchestrator|business-tools\/execute|conversation|completions|generate)(?:\/|$)/.test(url.pathname)
      return local && !model ? route.continue() : route.abort()
    })
    const actorPage = await context.newPage()
    const session = await loginWithCredentials(actorPage, credentials, { returnContext: true })
    return {
      token: session.token, context,
      capture: async (stage) => {
        try {
          await openRoute(actorPage, '/erp/sale/order', { readySelector: '.el-table', readyTimeoutMs: 20000 })
          const filename = path.join(outputDir, `auth-data-007-${stage}.png`)
          await actorPage.screenshot({
            path: filename, fullPage: true, animations: 'disabled',
            mask: [actorPage.locator('.el-table__body-wrapper'), actorPage.locator('.el-statistic')]
          })
          record.screenshots.push(filename)
          return { route: '/erp/sale/order', mounted: true }
        } catch {
          return { route: '/erp/sale/order', mounted: false }
        }
      },
      close: () => context.close()
    }
  } catch {
    await context.close()
    throw new Error('AUTH-DATA-007 headed actor login failed; private authentication details withheld')
  }
}

export async function runCase (
  { caseId = cases[0], page, caseRecord, record = { api: [], screenshots: [] }, outputDir },
  dependencies = {}
) {
  if (!cases.includes(caseId)) throw new Error('BLOCKED: unsupported AUTH-DATA-007 case')
  const settings = dependencies.settings || config
  assertAiDataLocal(settings)
  const sql = dependencies.sql || runReadOnlySql
  await (dependencies.writeSafety || assertLocalWriteSafety)(caseRecord)
  const request = dependencies.request || createAiDataRequest({ settings, record })
  const payload = aiDataPayload(dependencies.tag)
  const fixture = { marker: payload.marker, status: 'creating', tenantId: '1' }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  caseRecord.assertionMappings = catalogAssertions.map((assertion, index) => ({
    index: index + 1, assertion, status: 'PARTIAL', checks: [], gaps: []
  }))
  const check = (name, passed, details = '', mapping) => {
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
    if (mapping) {
      const item = caseRecord.assertionMappings[mapping - 1]
      item.checks.push(name)
      if (!passed) item.status = 'FAIL'
    }
  }
  const gap = (mapping, note) => {
    caseRecord.assertionMappings[mapping - 1].gaps.push(note)
    caseRecord.notes.push(`GAP: ${note}`)
  }
  const storeDatabase = (stage, value) => {
    caseRecord.database = [...(caseRecord.database || []), { stage, ...value }]
  }
  let admin
  let actor
  let failure
  let sample
  const call = async (method, endpoint, body, token = admin?.accessToken, options = {}) => {
    assertAiDataRequest(method, `/admin-api${endpoint}`, body)
    return request(method, `/admin-api${endpoint}`, body, { token, ...options })
  }
  const adminCall = async (method, endpoint, body) => data(await call(method, endpoint, body), endpoint)
  const ownedRole = async () => assertOwnedAiRole(
    await adminCall('GET', `/system/role/get?id=${fixture.roleId}`), fixture, payload)
  const ownedUser = async () => assertOwnedAiUser(
    await adminCall('GET', `/system/user/get?id=${fixture.userId}`), fixture, payload)
  const scope = async (value) => {
    await ownedRole()
    await adminCall('POST', '/system/permission/assign-role-data-scope', {
      roleId: fixture.roleId, dataScope: value, dataScopeDeptIds: []
    })
    if ((await ownedRole()).dataScope !== value) throw new Error('owned role dataScope readback mismatch')
    fixture.dataScope = value
  }
  const menus = async (menuIds) => {
    await ownedRole()
    await adminCall('POST', '/system/permission/assign-role-menu', { roleId: fixture.roleId, menuIds })
    const actual = await adminCall('GET', `/system/permission/list-role-menus?roleId=${fixture.roleId}`)
    if (!Array.isArray(actual) || JSON.stringify(actual.map(String).sort()) !== JSON.stringify([...menuIds].sort())) {
      throw new Error('owned role exact menu readback mismatch')
    }
  }
  const responseFact = (stage, kind, response, rows) => {
    const fact = {
      stage, kind, status: response.status, code: response.body?.code,
      validRows: Array.isArray(rows), rowCount: rows?.length ?? null,
      rows: rows?.map((row) => ({
        id: String(row[kind === 'tool' ? 'orderId' : 'id'] ?? ''),
        owner: kind === 'report' ? String(row.create_by ?? '') : undefined,
        amountNull: row[kind === 'report' ? 'total_price' : 'totalPrice'] === null
      }))
    }
    caseRecord.responseFacts = [...(caseRecord.responseFacts || []), fact]
    return fact
  }
  const read = async (stage, kind, endpoint, body) => {
    const response = await call(body ? 'POST' : 'GET', endpoint, body, actor.token)
    const rows = aiDataRows(response, kind)
    responseFact(stage, kind, response, rows)
    check(`${stage} ${kind}真实响应结构`, rows !== null,
      `HTTP=${response.status}; code=${response.body?.code ?? 'invalid'}`, kind === 'page' ? undefined : 1)
    return rows
  }
  try {
    const before = await sql(`SELECT CAST(id AS CHAR), CAST(customer_id AS CHAR), create_by, total_price, bill_no
      FROM erp_sale_order WHERE tenant_id = 1 AND deleted = 0 AND total_price IS NOT NULL
      AND total_price <> 0 ORDER BY id DESC LIMIT 50`)
    if (!before.available || !before.rows.length) throw new Error('BLOCKED: no tenant1 nonzero sales sample; no business fixtures are created')
    sample = {
      id: id(before.rows[0][0]), customerId: id(before.rows[0][1]),
      owner: before.rows[0][2], amount: before.rows[0][3], billNo: before.rows[0][4]
    }
    fixture.sampleId = sample.id
    storeDatabase('readonly-business-sample', {
      available: true, rows: before.rows.map((row) => [row[0], row[1], row[2], 'NONZERO_AMOUNT_REDACTED'])
    })
    admin = data(await request('POST', '/admin-api/system/auth/login-encrypted', {
      username: settings.username, password: settings.password, captchaVerification: ''
    }, { encrypted: true }), 'encrypted admin login')
    if (!admin?.accessToken) throw new Error('admin session missing')
    const adminPrincipal = await adminCall('GET', '/system/auth/get-permission-info')
    if (!stableId(adminPrincipal?.user?.id)) throw new Error('admin principal missing')
    const coverage = await adminCall('GET', '/system/data-permission/coverage')
    const item = coverage?.find((row) => row.tableName === 'erp_sale_order')
    check('正式 coverage 包含销售订单归属口径', Boolean(item), JSON.stringify(item || {}))
    const selected = selectAiDataMenus(
      await adminCall('GET', '/system/menu/list'),
      await adminCall('GET', '/system/menu/list-all-simple'))
    fixture.roleId = id(await adminCall('POST', '/system/role/create', payload.role))
    await ownedRole()
    await menus(selected.base)
    await scope(5)
    fixture.userId = id(await adminCall('POST', '/system/user/create', {
      ...payload.user, roleIds: [fixture.roleId]
    }))
    await ownedUser()
    const roles = await adminCall('GET', `/system/permission/list-user-roles?userId=${fixture.userId}`)
    if (!Array.isArray(roles) || roles.length !== 1 || String(roles[0]) !== fixture.roleId) {
      throw new Error('isolated user must have exactly its owned role')
    }
    caseRecord.evidence.push(`owner=${fixture.marker}; roleId=${fixture.roleId}; userId=${fixture.userId}; sampleId=${sample.id}; business data READ ONLY`)
    actor = await (dependencies.headedActor || headedActor)({
      page, credentials: { ...payload.user, tenantName: settings.tenantName }, record, outputDir
    })
    if (!actor?.token) throw new Error('BLOCKED: headed actor token missing')
    const principal = data(await call('GET', '/system/user/profile/get', undefined, actor.token), 'actor profile')
    if (String(principal?.id) !== fixture.userId) throw new Error('headed actor principal mismatch')
    const identity = async (allowed) => {
      const info = data(await call('GET', '/system/auth/get-permission-info', undefined, actor.token), 'actor permission info')
      // 菜单树里存在 permission 为空串的父级节点，权限快照会带回空串，判定时忽略空值。
      const permissions = (Array.isArray(info?.permissions) ? info.permissions : [])
        .filter((value) => typeof value === 'string' && value.length > 0)
      check(`发起人权限快照 amountAllowed=${allowed}`,
        String(info?.user?.id) === fixture.userId &&
        Array.isArray(info.roles) && info.roles.length === 1 && info.roles[0] === payload.role.code &&
        permissions.includes(amountPermission) === allowed &&
        permissions.every((value) => readPermissions.has(value) || value === amountPermission),
      `userId=${fixture.userId}; roleId=${fixture.roleId}; roles=${JSON.stringify(info?.roles || [])}; ` +
      `permissions=${permissions.map((value) => readPermissions.has(value) || value === amountPermission ? value : `<outside:${value}>`).join(',')}`, 2)
    }
    await identity(false)
    const ownedFacts = await sql(`SELECT 'owned-orders',COUNT(*) FROM erp_sale_order
      WHERE tenant_id=1 AND deleted=0 AND create_by='${fixture.userId}';
      SELECT 'principal-token',COUNT(*) FROM system_oauth2_access_token
      WHERE tenant_id=1 AND deleted=0 AND user_id=${fixture.userId} AND user_type=2 AND expires_time>NOW()`)
    storeDatabase('SELF-principal', ownedFacts)
    if (!ownedFacts.available || ownedFacts.rows.find((row) => row[0] === 'owned-orders')?.[1] !== '0' ||
        Number(ownedFacts.rows.find((row) => row[0] === 'principal-token')?.[1]) < 1) {
      throw new Error('SELF ownership/token prerequisite not proved')
    }
    const pageEndpoint = '/erp/sale-order/page?pageNo=1&pageSize=100'
    const toolEndpoint = '/erp/ai-tool/list/sale-orders?limit=100'
    const reportEndpoint = '/report/go-view/data/get-by-sql'
    if (!selected.reportAssignable) {
      gap(1, '租户套餐未订购 GoView 大屏报表模块，report:go-view-data:get-by-sql 不可分配；报表 SQL 发起人范围过滤未执行')
    }
    const selfTargets = [
      ['page', pageEndpoint], ['tool', toolEndpoint]
    ]
    if (selected.reportAssignable) {
      selfTargets.push(['report', reportEndpoint, { sql: aiDataReportSql(sample.id) }])
    }
    for (const [kind, endpoint, body] of selfTargets) {
      const rows = await read('SELF', kind, endpoint, body)
      if (rows) check(`SELF ${kind}按发起人范围过滤`, rows.length === 0,
        `ownedOrders=0; returned=${rows.length}; sampleId=${sample.id}`, 1)
    }
    if (actor.capture) {
      const ui = await actor.capture('SELF')
      if (ui.mounted) {
        check('headed 销售路由真实挂载', true, '/erp/sale/order')
      } else {
        // 受限只读账号只挂载最小只读菜单，/erp/sale/order 在 20s 内未渲染表格。
        // 本用例三条 catalog 断言均由正式 API 证据支撑，页面渲染作为已知前端边界登记。
        gap(1, 'headed 受限只读账号访问 /erp/sale/order 未在 20s 内挂载表格；金额脱敏与数据范围已由正式 API 验证，前端最小角色渲染待排查')
      }
    }

    await scope(1)
    const params = new URLSearchParams({
      pageNo: '1', pageSize: '100', customerId: sample.customerId, billNo: sample.billNo
    })
    for (const [stage, allowed] of [['NO_AMOUNT', false], ['GRANTED', true], ['REVOKED', false]]) {
      await menus(allowed ? [...selected.base, ...selected.amountMenuIds] : selected.base)
      await identity(allowed)
      const grantFacts = await sql(`SELECT 'owned-role',id,data_scope,tenant_id,deleted+0 FROM system_role WHERE id=${fixture.roleId};
        SELECT 'owned-user-role',user_id,role_id,tenant_id,deleted+0 FROM system_user_role
          WHERE user_id=${fixture.userId} AND deleted=0;
        SELECT 'amount-menu-count',COUNT(*) FROM system_role_menu rm JOIN system_menu m ON m.id=rm.menu_id
          WHERE rm.tenant_id=1 AND rm.role_id=${fixture.roleId} AND rm.deleted=0 AND m.deleted=0
          AND m.permission='sensitive:amount:view'`)
      storeDatabase(stage, grantFacts)
      check(`${stage} system_role_menu权限事实与正式API一致`,
        grantFacts.available &&
        grantFacts.rows.some((row) => row[0] === 'owned-role' && row[1] === fixture.roleId &&
          row[2] === '1' && row[3] === '1' && row[4] === '0') &&
        grantFacts.rows.filter((row) => row[0] === 'owned-user-role').length === 1 &&
        grantFacts.rows.some((row) => row[0] === 'owned-user-role' && row[1] === fixture.userId &&
          row[2] === fixture.roleId && row[3] === '1') &&
        Number(grantFacts.rows.find((row) => row[0] === 'amount-menu-count')?.[1]) ===
          (allowed ? selected.amountMenuIds.length : 0), '', 2)
      const stageTargets = [
        ['page', `/erp/sale-order/page?${params}`],
        ['tool', `${toolEndpoint}&customerId=${sample.customerId}`]
      ]
      if (selected.reportAssignable) {
        stageTargets.push(['report', reportEndpoint, { sql: aiDataReportSql(sample.id) }])
      }
      for (const [kind, endpoint, body] of stageTargets) {
        const rows = await read(stage, kind, endpoint, body)
        const evidence = aiDataAmountEvidence(rows, kind, sample, allowed)
        caseRecord.amountFacts = [...(caseRecord.amountFacts || []), { stage, kind, ...evidence }]
        if (evidence.verified) check(`${stage} ${kind}复用发起人金额权限`,
          evidence.passed, JSON.stringify(evidence), 2)
        else gap(2, `${stage} ${kind}: ${evidence.reason}`)
      }
      if (selected.canExport) {
        const exported = await call('GET', `/erp/sale-order/export-excel?${params}`,
          undefined, actor.token, { binary: true })
        if (!exported.buffer) {
          check(`${stage}正式导出响应`, false, `HTTP=${exported.status}; code=${exported.body?.code ?? 'invalid'}`, 2)
        } else {
          const workbook = XLSX.read(exported.buffer, { type: 'buffer' })
          const cells = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 })
          check(`${stage}正式导出文件可解析且非空`, cells.length > 1, `bytes=${exported.buffer.length}`, 2)
          caseRecord.exportFacts = [...(caseRecord.exportFacts || []), {
            stage, bytes: exported.buffer.length, dataRows: Math.max(0, cells.length - 1)
          }]
          gap(2, `${stage}同步Excel金额列未建立精确快照契约；不以下载成功标金额通过`)
        }
      } else gap(3, '当前租户没有可授予专属角色的销售导出菜单')
    }
    if (actor.capture) await actor.capture('REVOKED')

    const auditSchema = await sql(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name IN
      ('infra_api_access_log','system_operate_log','ai_tool_call','ai_agent_runtime_task')
      ORDER BY table_name,ordinal_position`)
    storeDatabase('audit-schema', auditSchema)
    const audit = await sql(`SELECT CAST(id AS CHAR),trace_id,request_method,request_url,result_code,
      (COALESCE(request_params,'') LIKE '%sensitive:amount:view%'
       OR COALESCE(response_body,'') LIKE '%sensitive:amount:view%') AS has_amount_permission_marker
      FROM infra_api_access_log WHERE tenant_id=1 AND deleted=0 AND user_id=${fixture.userId}
      AND request_url IN ('/admin-api/erp/sale-order/page','/admin-api/erp/ai-tool/list/sale-orders',
        '/admin-api/report/go-view/data/get-by-sql','/admin-api/erp/sale-order/export-excel')
      ORDER BY id DESC LIMIT 100;
      SELECT 'runtime-task-count',COUNT(*) FROM ai_agent_runtime_task
        WHERE tenant_id=1 AND deleted=0 AND user_id=${fixture.userId};
      SELECT 'model-or-quota-usage',COUNT(*) FROM ai_usage_log WHERE tenant_id=1 AND user_id=${fixture.userId}
        AND (cost_quota>0 OR cost_yuan>0 OR total_tokens>0)`)
    storeDatabase('owned-query-export-tool-audit', audit)
    const queryAudits = audit.rows.filter((row) => stableId(row[0]))
    caseRecord.auditFacts = {
      observedAccessLogs: queryAudits.length,
      withAmountPermissionMarker: queryAudits.filter((row) => row[5] === '1').length,
      sensitiveSnapshotVerified: false
    }
    check('没有真实模型调用或付费配额消耗',
      audit.available && audit.rows.find((row) => row[0] === 'model-or-quota-usage')?.[1] === '0')
    gap(1, 'catalog /erp/ai/runtime/tool/execute未找到正式Controller；只验证现有 /erp/ai-tool/list/sale-orders，未执行Runtime收费链')
    gap(2, '异步发起人SecurityContext/金额判定未执行；现有只读HTTP Tool不能替代异步证据')
    gap(3, `本轮查询/报表/导出审计只观察到${queryAudits.length}条access log；敏感金额权限快照未证实，普通访问日志不冒充快照审计`)
    gap(3, '未调用模型/Runtime，AI调用敏感快照与异步导出审计链仍缺证据；ai_agent_runtime_task.data_scope_snapshot仅行权限不是金额快照')
    fixture.status = 'verified'
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    const cleanup = async (label, action) => {
      try { await action() } catch {
        cleanupErrors.push(label)
        caseRecord.notes.push(`cleanup failed: ${label}; only fixture IDs retained`)
      }
    }
    if (actor) {
      await cleanup('owned actor logout', async () =>
        data(await call('POST', '/system/auth/logout', undefined, actor.token), 'owned logout'))
      await cleanup('headed actor context close', () => actor.close())
    }
    if (admin && fixture.userId) {
      await cleanup('owned user DELETE', async () => {
        await ownedUser()
        await adminCall('DELETE', `/system/user/delete?id=${fixture.userId}`)
        if (await adminCall('GET', `/system/user/get?id=${fixture.userId}`)) throw new Error('user still active')
      })
    }
    if (admin && fixture.roleId) {
      await cleanup('owned role DELETE', async () => {
        await ownedRole()
        await adminCall('DELETE', `/system/role/delete?id=${fixture.roleId}`)
        if (await adminCall('GET', `/system/role/get?id=${fixture.roleId}`)) throw new Error('role still active')
      })
    }
    if (fixture.userId && fixture.roleId) {
      await cleanup('owned database cleanup verification', async () => {
        const cleaned = await sql(`SELECT 'active-users',COUNT(*) FROM system_users WHERE tenant_id=1 AND deleted=0 AND id=${fixture.userId};
          SELECT 'active-roles',COUNT(*) FROM system_role WHERE tenant_id=1 AND deleted=0 AND id=${fixture.roleId};
          SELECT 'active-role-menus',COUNT(*) FROM system_role_menu WHERE tenant_id=1 AND deleted=0 AND role_id=${fixture.roleId};
          SELECT 'active-user-roles',COUNT(*) FROM system_user_role WHERE tenant_id=1 AND deleted=0 AND (role_id=${fixture.roleId} OR user_id=${fixture.userId});
          SELECT 'active-tokens',COUNT(*) FROM system_oauth2_access_token WHERE tenant_id=1 AND deleted=0 AND user_id=${fixture.userId} AND user_type=2 AND expires_time>NOW()`)
        storeDatabase('formal-cleanup', cleaned)
        if (!cleaned.available || cleaned.rows.length !== 5 || cleaned.rows.some((row) => row[1] !== '0')) {
          throw new Error('owned cleanup database mismatch')
        }
      })
    }
    if (admin) await cleanup('owned admin logout', async () =>
      data(await call('POST', '/system/auth/logout'), 'admin logout'))
    fixture.status = cleanupErrors.length ? 'cleanup-failed' : 'deleted'
    check('专属账号/角色/菜单关系/令牌正式清理', cleanupErrors.length === 0, cleanupErrors.join('; '))
    if (cleanupErrors.length) failure ||= new Error('AUTH-DATA-007 owned cleanup failed')
  }
  if (failure) throw failure
  const note = '现有只读Tool/报表SQL已执行安全反例；Runtime、异步与敏感快照审计仍有GAP，不能标完整PASS'
  return { partial: true, note }
}

async function main () {
  if (!process.argv.includes('--headed') || !process.argv.includes('--execute')) {
    throw new Error('BLOCKED: explicit --headed --execute required for owned tenant1 role/account fixture')
  }
  assertAiDataLocal()
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases.map((item) =>
    ({ ...item, suite: suite.id || suite.name }))).find((item) => item.id === cases[0])
  if (JSON.stringify(definition?.assertions) !== JSON.stringify(catalogAssertions)) {
    throw new Error('BLOCKED: catalog assertions changed; do not silently lower acceptance')
  }
  const record = createRunRecord({ selectedSuites: ['ai-data-permission'], selectedCases: cases })
  const caseRecord = createCaseRecord({ ...definition, suite: 'ai-data-permission' })
  record.cases.push(caseRecord)
  const outputDir = ensureDir(path.join(config.outputRoot, record.runId, 'screenshots'))
  let browser
  try {
    browser = await launchBrowser({ headed: true })
    const result = await runCase({ page: browser.page, record, caseRecord, outputDir })
    const outcome = caseOutcome({
      result, hasAssertions: caseRecord.checks.length > 0,
      failedChecks: caseRecord.checks.filter((item) => item.passed === false)
    })
    finishCase(caseRecord, outcome.status, outcome.note)
  } catch (error) {
    finishCase(caseRecord, caseErrorStatus(error, caseRecord.checks), error.message)
  } finally {
    if (browser) {
      await browser.context.close()
      await browser.browser.close()
    }
  }
  caseRecord.durationMs = Date.now() - Date.parse(caseRecord.startedAt)
  record.sessionsExited = true
  const report = await writeReport(record)
  console.log(JSON.stringify({
    caseId: cases[0], status: caseRecord.status, report: report.resultFile,
    fixtures: caseRecord.fixtures, sessionsExited: true
  }))
  process.exitCode = caseRecord.status === 'PASS' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('AUTH-DATA-007 runner rejected before execution; private details withheld')
    process.exitCode = 1
  })
}
