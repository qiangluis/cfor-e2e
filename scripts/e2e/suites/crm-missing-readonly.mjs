import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { crmMenuRoute, crmReadRows } from './crm.mjs'

const definitionPath = '/crm/customer-tag/definition/page'
const summaryPath = '/crm/customer-tag/report/summary'
const permissionPath = '/system/auth/get-permission-info'

export const caseRegistry = Object.freeze([Object.freeze({
  id: 'PB052-001',
  title: '客户标签口径统计、零客户标签及真实页面数值核对',
  suite: 'crm-missing-readonly',
  status: 'PARTIAL',
  pbScope: Object.freeze(['PB-052']),
  mode: 'READ_ONLY',
  resultCeiling: 'PARTIAL',
  component: 'crm/config/customerTag/index',
  api: Object.freeze([definitionPath, summaryPath]),
  safeGet: Object.freeze([permissionPath, definitionPath, summaryPath]),
  database: Object.freeze(['crm_customer_tag_definition', 'crm_customer_tag_relation']),
  sourceSuite: 'crm-customer-tag.mjs',
  unverified: Object.freeze([
    '系统标签人工增删拒绝、重复添加幂等及变更审计写侧需批准的隔离夹具',
    '历史报价/合同/报表标签快照不回溯未验证',
    '无权限用户及跨租户/客户数据范围负例未验证'
  ])
})])
export const cases = Object.freeze(caseRegistry.map((item) => item.id))

const freezeGroup = (item) => Object.freeze({
  ...item,
  ids: Object.freeze(item.ids),
  pbScope: Object.freeze(item.pbScope),
  currentSourceEvidence: Object.freeze(item.currentSourceEvidence),
  runnable: false
})

// These are documented as developed, but the current checked-out source lacks
// the corresponding backend/frontend chain. Keep them visible as deployment
// gaps without registering synthetic runnable cases.
export const developmentGapGroups = Object.freeze([
  {
    ids: ['CRM-CONTRACT-CHANGE-001', 'CRM-CONTRACT-CHANGE-002', 'CRM-CONTRACT-CHANGE-003'],
    pbScope: ['PB-237'],
    documentEvidence: 'CFOR-PB-158至PB-282销售协同深化改造方案-20260930.md:7',
    sourceEvidence: '当前 cfor-admin/cfor-module-crm 与 cfor-admin-vue3 无 /crm/contract-change Controller、Service、API 或页面',
    currentSourceEvidence: [
      'cfor-module-crm/src/main/java/tech/cfor17/module/crm/**: 无 /crm/contract-change',
      'cfor-admin-vue3/src/api/crm/** 与 src/views/crm/**: 无 contract-change 链路'
    ],
    reason: '文档声明 PB-237 已开发，但当前 checkout 缺失合同变更完整调用链；不可用旧合同列表冒充变更闭环',
    registrationAction: '补齐并部署真实链路后再登记；当前不加入 cases'
  },
  {
    ids: ['CRM-TASK-001'],
    pbScope: ['PB-201~205'],
    documentEvidence: 'CFOR-PB-158至PB-282销售协同深化改造方案-20260930.md:7,152',
    sourceEvidence: '当前 cfor-admin/cfor-module-crm 与 cfor-admin-vue3 无 /crm/task Controller、Service、API 或任务页面',
    currentSourceEvidence: [
      'cfor-module-crm/src/main/java/tech/cfor17/module/crm/**: 无 /crm/task',
      'cfor-admin-vue3/src/views/crm/jixu/**: 无 task 页面/API'
    ],
    reason: '文档声明 PB-201~205 已开发，但当前 checkout 缺失销售任务部署链路',
    registrationAction: '补齐并部署任务链路后再登记；当前不加入 cases'
  },
  {
    ids: ['CRM-WR-001'],
    pbScope: ['PB-253~256'],
    documentEvidence: 'CFOR-PB-158至PB-282销售协同深化改造方案-20260930.md:404~423',
    sourceEvidence: '当前仅有 /crm/work-report page/get 等旧读写接口；缺 /facts 与 /review 深化接口',
    currentSourceEvidence: [
      'cfor-module-crm/**/CrmWorkReportController.java: 仅 page/get 等现有接口，无 facts/review',
      'cfor-admin-vue3/src/api/crm/workReport/index.ts: 当前缺深化 facts/review 完整契约'
    ],
    reason: '文档声明 PB-253~256 已开发，但当前 checkout 不是该文档描述的完整发布链路',
    registrationAction: '补齐并部署 facts/review/审核链路后再登记；当前不加入 cases'
  },
  {
    ids: ['CRM-BR-001'],
    pbScope: ['PB-257~261'],
    documentEvidence: 'CFOR-PB-158至PB-282销售协同深化改造方案-20260930.md:236~244',
    sourceEvidence: '当前 cfor-admin/cfor-module-crm 无 /crm/statistics-business-report/overview Controller/Service/API 链路',
    currentSourceEvidence: [
      'cfor-module-crm/src/main/java/tech/cfor17/module/crm/**: 无 statistics-business-report 聚合接口',
      'cfor-admin-vue3/src/api/crm/statistics/**: 无该 overview API 实现'
    ],
    reason: '文档声明 PB-257~261 已开发，但当前 checkout 缺统一经营报表部署链路',
    registrationAction: '补齐并部署 overview 链路后再登记；当前不加入 cases'
  },
  {
    ids: ['CRM-PROJECT-HANDOVER-001', 'CRM-PROJECT-HANDOVER-002', 'CRM-PROJECT-HANDOVER-003'],
    pbScope: ['PB-248~252'],
    documentEvidence: 'CFOR-PB-158至PB-282销售协同深化改造方案-20260930.md:211~219',
    sourceEvidence: '当前 checkout 未找到 CRM→PMS 交接公开 API/页面调用链；不能以 PMS 通用交接列表代替',
    currentSourceEvidence: [
      'cfor-module-crm/src/main/java/tech/cfor17/module/crm/**: 无 CRM contract-handover Controller/Service',
      'cfor-admin-vue3/src/api/crm/** 与 src/views/crm/**: 无 CRM contract-handover 入口'
    ],
    reason: '文档声明 PB-248~252 已开发，但当前 checkout 缺 CRM→PMS 交接部署链路',
    registrationAction: '补齐并部署跨域公开 API、幂等和前端链路后再登记；当前不加入 cases'
  }
].map(freezeGroup))

// Historical cases whose development status is not confirmed by the current
// development document. Existing CRUD pages are not sufficient proof.
export const unconfirmedCaseGroups = Object.freeze([
  { ids: ['CRM-WB-001'], pbScope: ['PB-170~173'], reason: '开发文档未将该深化切片标记为已开发；当前无 /crm/workbench 聚合读链路', currentSourceEvidence: ['当前无 /crm/workbench 聚合接口'] },
  { ids: ['CRM-POOL-001', 'CRM-POOL-002', 'CRM-POOL-003'], pbScope: ['PB-179~191'], reason: '开发文档未将该深化切片标记为已开发；已有客户分页不能证明核验/领取/批量无效门禁', currentSourceEvidence: ['现有客户分页不能替代写侧状态机证据'] },
  { ids: ['CRM-LEAD-001', 'CRM-LEAD-002', 'CRM-BIZ-001', 'CRM-BIZ-002'], pbScope: ['PB-206~216'], reason: '开发文档未将该深化切片标记为已开发；已有列表不能证明筛选转化与执行状态写侧', currentSourceEvidence: ['现有线索/商机页面不能替代转化与门禁证据'] },
  { ids: ['CRM-FUNNEL-001', 'CRM-FUNNEL-002', 'CRM-FUNNEL-003'], pbScope: ['PB-217~223'], reason: '开发文档未将该深化切片标记为已开发；当前无漏斗评审配置/取消完整链路', currentSourceEvidence: ['当前无配置/取消完整链路'] },
  { ids: ['CRM-QUOTE-001', 'CRM-QUOTE-002', 'CRM-QUOTE-003', 'CRM-QUOTE-004'], pbScope: ['PB-224~231'], reason: '开发文档未将该深化切片标记为已开发；当前无报价审批配置完整链路', currentSourceEvidence: ['当前无报价审批配置完整链路'] },
  { ids: ['CRM-CONTRACT-001', 'CRM-CONTRACT-002', 'CRM-CONTRACT-003', 'CRM-CONTRACT-004'], pbScope: ['PB-232~238'], reason: '开发文档未将该深化切片标记为已开发；旧合同列表不证明全切片履约/重复提交门禁', currentSourceEvidence: ['现有合同列表不能替代履约与重复提交证据'] },
  { ids: ['CRM-RECEIVABLE-001', 'CRM-RECEIVABLE-002', 'CRM-RECEIVABLE-003', 'CRM-RECEIVABLE-004'], pbScope: ['PB-239~247'], reason: '开发文档未将该深化切片标记为已开发；当前无回款配置及计划调整历史完整链路', currentSourceEvidence: ['当前无回款配置/计划调整历史完整链路'] }
].map((item) => freezeGroup({ ...item, documentEvidence: '当前开发文档未确认该切片已开发' })))

export const excludedCaseGroups = Object.freeze([
  ...developmentGapGroups,
  ...unconfirmedCaseGroups
])

const stableId = (value) =>
  (typeof value === 'string' && /^[1-9]\d*$/.test(value)) ||
  (Number.isSafeInteger(value) && value > 0)
const text = (value) => typeof value === 'string' && value.trim().length > 0
const tagFields = (row) => text(row.code) && text(row.name) &&
  ['SYSTEM', 'MANUAL'].includes(row.tagType) && [0, 1].includes(row.status)
const unique = (rows, field) => new Set(rows.map((row) => String(row[field]))).size === rows.length
const fact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`FAIL: ${name}`)
}

export function validateTagUsage(definitionPayload, summaryPayload) {
  const definitions = crmReadRows(definitionPayload, definitionPath)
  const summary = crmReadRows(summaryPayload, summaryPath, false)
  const total = definitionPayload.data.total
  if (definitions.length > 100 || (!definitions.length && total !== 0) ||
    definitions.some((row) => !stableId(row.id) || !tagFields(row)) ||
    !unique(definitions, 'id') || !unique(definitions, 'code')) {
    throw new Error('FAIL: 标签定义分页、稳定 ID/编码或字段无效')
  }
  if (summary.some((row) => !stableId(row.tagId) || !tagFields(row) ||
    !Number.isSafeInteger(row.customerCount) || row.customerCount < 0) ||
    !unique(summary, 'tagId') || !unique(summary, 'code') || summary.length !== total) {
    throw new Error('FAIL: 标签统计需唯一稳定 ID/编码、非负整数客户数及完整定义数量')
  }
  const summaryById = new Map(summary.map((row) => [String(row.tagId), row]))
  for (const definition of definitions) {
    const row = summaryById.get(String(definition.id))
    if (!row || ['code', 'name', 'tagType', 'status'].some((key) => row[key] !== definition[key])) {
      throw new Error('FAIL: 标签统计未精确覆盖当前定义与来源/状态')
    }
  }
  return {
    definitions, summary, total,
    displayRows: definitions.map((row) => ({
      code: row.code, customerCount: summaryById.get(String(row.id)).customerCount
    })),
    gaps: [
      ...(!definitions.length ? ['当前标签定义为空，未验证真实标签字段和零客户标签保留'] : []),
      ...(definitions.length && !summary.some((row) => row.customerCount === 0)
        ? ['当前无零客户标签样本，未验证零计数保留'] : []),
      ...(total > definitions.length ? ['定义仅核对首页100条，未核对全量定义字段及页面'] : [])
    ]
  }
}

export function tagTableMatches(snapshot, expectedRows) {
  if (!snapshot || snapshot.loading || !snapshot.headers?.includes('标签编码') ||
    !snapshot.headers.includes('当前客户数') || !Array.isArray(snapshot.rows) ||
    snapshot.rows.length !== expectedRows.length) return false
  if (!expectedRows.length) return snapshot.empty === true
  const actual = new Map(snapshot.rows.map((row) => [row.code, row.customerCount]))
  return actual.size === expectedRows.length && expectedRows.every((row) =>
    actual.get(row.code) === String(row.customerCount))
}

export function tagIdentity(payload) {
  const data = payload?.data
  if (!isBusinessSuccess(payload) || !stableId(data?.user?.id) ||
    !Array.isArray(data.menus) || !Array.isArray(data.permissions) ||
    data.permissions.some((permission) => typeof permission !== 'string')) {
    throw new Error('FAIL: 当前用户/菜单/权限真实响应无效')
  }
  return {
    route: crmMenuRoute(data.menus, caseRegistry[0].component),
    advertisedQuery: data.permissions.includes('crm:customer-tag:query') ||
      data.permissions.includes('*:*:*')
  }
}

async function safeGet(api, pathname, record) {
  const base = pathname.split('?')[0]
  if (!caseRegistry[0].safeGet.includes(base)) throw new Error(`FAIL: 非只读白名单 ${base}`)
  let payload
  try {
    payload = await api.getBusiness(pathname)
  } catch (error) {
    const denied = /HTTP (401|403|404)\b|"code":(401|403|404)\b/.test(String(error.message))
    throw new Error(`${denied ? 'BLOCKED' : 'FAIL'}: ${base} 真实 GET ${denied ? '不可访问/未部署' : '失败'}；未执行业务写侧`)
  }
  fact(record, `${base} 真实 GET 业务成功`, isBusinessSuccess(payload))
  return payload
}

export async function readTagUsage({ api, caseRecord }) {
  const definition = await safeGet(api, `${definitionPath}?pageNo=1&pageSize=100`, caseRecord)
  const summary = await safeGet(api, summaryPath, caseRecord)
  const usage = validateTagUsage(definition, summary)
  fact(caseRecord, '真实定义/统计响应结构与数量一致', true,
    `definitions=${usage.definitions.length}, total=${usage.total}, summary=${usage.summary.length}`)
  if (usage.definitions.length) {
    fact(caseRecord, '非空样本统计按稳定编码覆盖定义并区分来源/状态', true)
  }
  caseRecord.notes.push(...usage.gaps)
  return usage
}

export function isTagResponse(response, endpoint) {
  const url = new URL(response.url())
  if (response.request().method() !== 'GET' || url.origin !== new URL(config.apiUrl).origin ||
    url.pathname !== `${new URL(config.apiUrl).pathname}${endpoint}`) return false
  if (endpoint === definitionPath) {
    return url.searchParams.get('pageNo') === '1' && url.searchParams.get('pageSize') === '100' &&
      [...url.searchParams.keys()].every((key) => ['pageNo', 'pageSize'].includes(key))
  }
  return url.search === ''
}

async function responseBody(response) {
  if (!response.ok()) throw new Error('FAIL: 客户标签页面真实 GET HTTP 失败')
  const headers = response.headers()
  const raw = await response.text()
  return headers[ENCRYPT_HEADER.toLowerCase()] === 'true' ? decryptResponse(raw) : JSON.parse(raw)
}

export async function captureTagUsage(page, action) {
  const pending = [definitionPath, summaryPath].map((endpoint) =>
    page.waitForResponse((response) => isTagResponse(response, endpoint),
      { timeout: 15000 }).catch(() => null))
  await action()
  const responses = await Promise.all(pending)
  if (responses.some((response) => !response)) {
    throw new Error('BLOCKED: 未捕获定义和统计两条真实 GET，不能以页面标题/空态代替')
  }
  const payloads = await Promise.all(responses.map(responseBody))
  return validateTagUsage(...payloads)
}

// Run the same pure predicate in Node unit tests and in the real browser.
export async function waitForTagTable(page, expectedRows) {
  await page.waitForFunction(({ expectedRows, matchesSource }) => {
    const visible = (element) => !!element && element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'
    const table = [...document.querySelectorAll('.el-table')].find((element) =>
      visible(element) && [...element.querySelectorAll('.el-table__header-wrapper th')]
        .some((cell) => cell.textContent.trim() === '当前客户数'))
    if (!table) return false
    const headers = [...table.querySelectorAll('.el-table__header-wrapper th')]
      .map((cell) => cell.textContent.trim())
    const codeIndex = headers.indexOf('标签编码')
    const countIndex = headers.indexOf('当前客户数')
    const bodyRows = [...table.querySelectorAll('.el-table__body-wrapper tbody > tr.el-table__row')]
      .filter(visible)
    const snapshot = {
      headers,
      loading: [...table.querySelectorAll('.el-loading-mask')].some(visible),
      empty: visible(table.querySelector('.el-table__empty-block')),
      rows: bodyRows.map((row) => {
        const cells = row.querySelectorAll('td')
        return {
          code: cells[codeIndex]?.textContent.trim(),
          customerCount: cells[countIndex]?.textContent.trim()
        }
      })
    }
    return (0, eval)(`(${matchesSource})`)(snapshot, expectedRows)
  }, { expectedRows, matchesSource: tagTableMatches.toString() }, { timeout: 15000 })
}

export async function runCase({ caseId, page, record, caseRecord, outputDir }) {
  if (!cases.includes(caseId)) throw new Error(`非当前已开发只读目标案例：${caseId}`)
  const token = await login(page)
  const api = createApiClient({ token, record })
  const identity = tagIdentity(await safeGet(api, permissionPath, caseRecord))
  caseRecord.notes.push(identity.advertisedQuery
    ? '真实权限列表包含查询权限或全权限标记；不证明权限负例'
    : '真实权限列表未列出查询权限；不推断后端拒绝/给予权限，以真实安全 GET 判定可访问性')
  await readTagUsage({ api, caseRecord })
  if (!identity.route) throw new Error('BLOCKED: 当前真实菜单无客户标签 component，未虚构路由')
  const usage = await captureTagUsage(page, () => openRoute(page, identity.route, {
    readySelector: '.el-table__header-wrapper th:has-text("当前客户数")'
  }))
  fact(caseRecord, '页面定义/统计两条真实 GET 契约完整', true,
    `rows=${usage.definitions.length}, summary=${usage.summary.length}`)
  await waitForTagTable(page, usage.displayRows)
  fact(caseRecord, usage.displayRows.length
    ? '加载 mask 隐藏且 DOM 行数、标签编码、客户数与页面响应精确一致'
    : '加载 mask 隐藏且 DOM 真实空态与零行响应一致', true,
    `rows=${usage.displayRows.length}；空列表仅证明空态契约，不证明零客户标签`)
  caseRecord.notes.push(...usage.gaps.filter((gap) => !caseRecord.notes.includes(gap)),
    ...caseRegistry[0].unverified,
    '统计来自当前标签关系，不反向还原历史单据；两次读为非事务快照，不宣称业务全量验收')
  const screenshot = await saveScreenshot(page, outputDir, 'PB052-001-readonly', record)
  caseRecord.evidence.push(screenshot,
    '既有账号登录；仅 GET 定义/统计及真实菜单页面；未打开编辑/新增/删除入口')
  return { token, api, partial: true, note: '仅完成 PB052 只读统计及页面证据；完整需求缺口见 notes，不计完整 PASS' }
}
