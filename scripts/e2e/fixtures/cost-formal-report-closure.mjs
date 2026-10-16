import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import {
  COST_ENTERPRISE_MENU_SQL, parseCostEnterpriseMenuInventory
} from './cost-enterprise-route-evidence.mjs'

export const COST_FORMAL_REPORT_CHECKS = Object.freeze({
  'COST-035': Object.freeze({
    rows: 'COST-035 非空成本路径绑定精确正式发布事实',
    operating: 'COST-035 经营冻结值正控制及未发布严格空值反控制',
    metrics: 'COST-035 正式成本运营费用企业全成本独立金额核对',
    pages: 'COST-035 两条路由真实GET与正式工作区逐行核对'
  }),
  'COST-036': Object.freeze({
    rejection: 'COST-036 正式生产期间精确422001贸易型拒绝',
    trade: 'COST-036 合法既有TRADE正式非空正控制及未发布门禁',
    retained: 'COST-036 既有专属远期空月贸易夹具保留证据',
    page: 'COST-036 生产入口真实正式工作区及精确期间'
  }),
  'COST-037': Object.freeze({
    rows: 'COST-037 非空比较行逐项核对正式对象及来源',
    reasons: 'COST-037 真实不可比较样本原因与空结论核对',
    page: 'COST-037 正式GET期间发布及真实比较行渲染',
    columns: 'COST-037 自产全成本与外购到岸成本真实列及单元格'
  }),
  'COST-038': Object.freeze({
    added: 'COST-038 三类新增菜单全量语义权限及真实页面',
    hidden: 'COST-038 占位菜单保留但隐藏且无可见别名再暴露',
    trace: 'COST-038 试算发布追溯菜单及真实入口保留',
    workbench: 'COST-038 工作台快捷入口真实导航且无隐藏占位页'
  }),
  'COST-039': Object.freeze({
    titles: 'COST-039 全部成本报表别名标题与正式菜单一致',
    targets: 'COST-039 全部别名精确路径组件页键权限一致',
    page: 'COST-039 别名正式GET发布非空行及金额真实渲染'
  })
})
export const COST_FORMAL_REPORT_BINDINGS = Object.freeze(Object.fromEntries(
  Object.entries(COST_FORMAL_REPORT_CHECKS).map(([id, checks]) => [
    id, Object.freeze(Object.fromEntries(Object.values(checks).map((name, index) => [index, Object.freeze([name])])))
  ])
))
export const CHECKS = COST_FORMAL_REPORT_CHECKS

const ids = Object.keys(COST_FORMAL_REPORT_CHECKS)
// SQL amounts/quantities/unit prices use 6/8/10 decimals respectively; compare in one exact unit.
const moneyScale = 10000000000n
const ratioScale = 1000000n
const idOf = (value) => {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), 'Lossy formal fact ID')
  const text = String(value)
  assert.match(text, /^[1-9]\d*$/, 'Missing formal fact ID')
  assert.ok(BigInt(text) <= 9223372036854775807n, 'Formal fact ID exceeds Long')
  return text
}
const decimal = (value) => {
  assert.ok(typeof value === 'string' || typeof value === 'number', 'Missing decimal fact')
  const text = String(value)
  assert.match(text, /^-?\d+(?:\.\d{1,10})?$/, 'Invalid or lossy decimal fact')
  const [integer, fraction = ''] = text.replace(/^-/, '').split('.')
  return (text.startsWith('-') ? -1n : 1n) *
    (BigInt(integer) * moneyScale + BigInt(fraction.padEnd(10, '0')))
}
const sum = (rows, key) => rows.reduce((total, row) => total + decimal(row[key]), 0n)
const equalMoney = (actual, expected) => assert.equal(decimal(actual), expected, 'Frozen amount mismatch')
const ratio = (amount, quantity) => {
  if (quantity === 0n) return null
  // Formal report divisions use six-place HALF_UP, even when the source quantity has eight places.
  const numerator = amount * ratioScale
  const sign = (numerator < 0n) !== (quantity < 0n) ? -1n : 1n
  const n = numerator < 0n ? -numerator : numerator
  const d = quantity < 0n ? -quantity : quantity
  return sign * ((n + d / 2n) / d) * (moneyScale / ratioScale)
}
const equalNullable = (actual, expected) => expected === null
  ? assert.equal(actual, null, 'Unavailable value must be null, not zero or omitted')
  : equalMoney(actual, expected)
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const dataOf = (body) => assertBusinessSuccess(body, 'COST formal report read').data
const requestReport = (periodId, reportKey) => `/cost/reports/${reportKey}/${idOf(periodId)}`
const month = (value) => assert.match(value || '', /^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid cost month')
const gapError = (message) => Object.assign(new Error(message), { evidenceGap: true })
const requireSample = (condition, message) => { if (!condition) throw gapError(message) }

const assertLocal = (settings) => {
  assert.equal(settings.target, 'local', 'Formal report fixture is local/read-only only')
  assert.equal(String(settings.tenantId), '1', 'Formal report fixture requires explicit tenant1')
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === port,
      'Formal report fixture requires exact loopback endpoints')
  }
}

// Every fact set has a census; truncated or unavailable SQL is never absence evidence.
const sqlRows = (result, tag) => {
  assert.equal(result?.available, true, 'Missing read-only SQL evidence')
  const counts = result.rows.filter((row) => row[0] === `${tag}-count`)
  assert.equal(counts.length, 1, `Missing ${tag} census`)
  assert.match(String(counts[0][1]), /^\d+$/)
  const rows = result.rows.filter((row) => row[0] === tag).map((row) => JSON.parse(row[1]))
  assert.equal(rows.length, Number(counts[0][1]), `Truncated ${tag} evidence`)
  assert.equal(new Set(rows.map((row) => idOf(row.id))).size, rows.length, `Duplicate ${tag} fact`)
  for (const row of rows) assert.equal(idOf(row.tenantId), '1', 'Cross-tenant formal fact')
  return rows
}
const factSelect = (tag, table, fields, filter, order = 'id') => `
  SELECT '${tag}-count', COUNT(*) FROM ${table} WHERE ${filter};
  SELECT '${tag}', CAST(JSON_OBJECT(
    'id', CAST(id AS CHAR), 'tenantId', CAST(tenant_id AS CHAR), ${fields}
  ) AS CHAR) FROM ${table} WHERE ${filter} ORDER BY ${order};
`
const readFacts = async (period, get, readSql, caseRecord) => {
  const periodId = idOf(period.id)
  const detail = await get(`/cost/periods/${periodId}`)
  assert.equal(idOf(detail.id), periodId)
  assert.equal(idOf(detail.accountingOrgId), '1')
  month(detail.period)
  assert.equal(detail.period, period.period)
  assert.equal(detail.enterpriseType, period.enterpriseType)
  const filter = `tenant_id = 1 AND deleted = 0 AND period_id = ${periodId} AND status = 'PUBLISHED'`
  const objectFilter = `tenant_id = 1 AND deleted = 0 AND publication_id IN (
    SELECT id FROM cost_publication WHERE ${filter})`
  const operatingFilter = `tenant_id = 1 AND deleted = 0 AND publication_id IN (
    SELECT id FROM cost_operating_publication WHERE ${filter})`
  const sql = factSelect('period', 'cost_period', `
    'period', period, 'enterpriseType', enterprise_type, 'accountingOrgId', CAST(accounting_org_id AS CHAR),
    'modelId', CAST(model_version_id AS CHAR), 'versionNo', model_version_no,
    'publicationId', CAST(current_publication_id AS CHAR)`,
  `tenant_id = 1 AND deleted = 0 AND id = ${periodId}`) +
    factSelect('publication', 'cost_publication', `
      'periodId', CAST(period_id AS CHAR), 'status', status, 'batchNo', batch_no,
      'resultHash', result_hash`, filter) +
    factSelect('object', 'cost_publication_object_fact', `
      'publicationId', CAST(publication_id AS CHAR), 'objectKey', object_key,
      'productCode', product_code, 'productName', product_name,
      'quantity', CAST(finished_quantity AS CHAR), 'amount', CAST(finished_amount AS CHAR),
      'unitCost', CAST(unit_cost AS CHAR)`, objectFilter, 'object_key, id') +
    factSelect('source', 'cost_publication_source_fact', `
      'publicationId', CAST(publication_id AS CHAR), 'objectKey', object_key,
      'sourceModule', source_module, 'sourceType', source_type, 'sourceNo', source_no,
      'quantity', CAST(quantity AS CHAR), 'amount', CAST(amount AS CHAR),
      'allocatedAmount', CAST(allocated_amount AS CHAR), 'formula', formula_json`,
    objectFilter, 'object_key, source_module, source_id, source_business_line_id, id') +
    factSelect('operating', 'cost_operating_publication', `
      'periodId', CAST(period_id AS CHAR), 'costPublicationId', CAST(cost_publication_id AS CHAR),
      'status', status, 'batchNo', batch_no, 'resultHash', result_hash,
      'revenue', CAST(revenue AS CHAR), 'expense', CAST(operating_expense AS CHAR),
      'profit', CAST(operating_profit AS CHAR), 'salesCost', CAST(sales_cost AS CHAR)`, filter) +
    factSelect('operatingFact', 'cost_operating_object_fact', `
      'publicationId', CAST(publication_id AS CHAR), 'scope', report_scope,
      'amount', CAST(amount AS CHAR)`, operatingFilter)
  const result = await readSql(sql)
  caseRecord.database ||= []
  caseRecord.database.push({ stage: `formal-report-${periodId}`, ...result })
  const facts = Object.fromEntries(['period', 'publication', 'object', 'source', 'operating', 'operatingFact']
    .map((tag) => [tag, sqlRows(result, tag)]))
  assert.equal(facts.period.length, 1)
  const dbPeriod = facts.period[0]
  assert.equal(dbPeriod.id, periodId)
  assert.equal(dbPeriod.period, detail.period)
  assert.equal(dbPeriod.enterpriseType, detail.enterpriseType)
  assert.equal(idOf(dbPeriod.accountingOrgId), '1')
  assert.equal(idOf(dbPeriod.modelId), idOf(detail.modelVersionId))
  assert.equal(dbPeriod.versionNo, detail.modelVersionNo)
  const latest = (rows) => [...rows].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)[0] || null
  const publication = latest(facts.publication)
  const operating = latest(facts.operating)
  for (const row of [...facts.publication, ...facts.operating]) {
    assert.equal(idOf(row.periodId), periodId)
    assert.equal(row.status, 'PUBLISHED')
    assert.ok(row.batchNo && row.resultHash, 'Published facts require batchNo/resultHash')
  }
  if (publication) assert.equal(idOf(dbPeriod.publicationId), publication.id)
  if (operating) {
    assert.ok(publication, 'Operating publication has no cost publication')
    assert.equal(idOf(operating.costPublicationId), publication.id)
  }
  const opApi = await get(`/cost/periods/${periodId}/operating-publication`)
  if (!operating) assert.equal(opApi, null, 'API/SQL disagree on missing operating publication')
  else {
    assert.equal(idOf(opApi.id), operating.id)
    assert.equal(idOf(opApi.periodId), periodId)
    assert.equal(idOf(opApi.costPublicationId), publication.id)
    assert.equal(opApi.status, 'PUBLISHED')
    for (const [apiKey, dbKey] of [['revenue', 'revenue'], ['operatingExpense', 'expense'],
      ['operatingProfit', 'profit'], ['salesCost', 'salesCost']]) equalMoney(opApi[apiKey], decimal(operating[dbKey]))
  }
  return {
    period: detail, publication, operating,
    objects: facts.object.filter((row) => row.publicationId === publication?.id),
    sources: facts.source.filter((row) => row.publicationId === publication?.id),
    operatingFacts: facts.operatingFact.filter((row) => row.publicationId === operating?.id)
  }
}

const assertReport = (report, facts, key) => {
  assert.equal(report.reportKey, key)
  assert.equal(report.formal, true)
  assert.equal(report.period, facts.period.period)
  assert.equal(idOf(report.publicationId), facts.publication.id)
  assert.equal(report.scope, `${facts.period.enterpriseType}/${facts.period.modelVersionNo}`)
  assert.ok(Array.isArray(report.rows) && report.rows.length > 0, 'Empty formal rows cannot pass')
  assert.ok(facts.objects.length > 0, 'Missing formal object facts cannot pass')
  assert.equal(new Set(report.rows.map((row) => row.key)).size, report.rows.length, 'Duplicate formal row key')
  for (const row of report.rows) assert.ok(row.key && row.values && typeof row.values === 'object')
  assert.ok(report.metrics && typeof report.metrics === 'object')
}
const assertEnterprise = (report, facts) => {
  assertReport(report, facts, 'enterprise-full-cost')
  const key = facts.period.enterpriseType === 'MANUFACTURING' ? '生产路径' : '贸易路径'
  const row = report.rows.find((item) => item.key === key)?.values
  assert.ok(row, 'Missing formal cost path')
  assert.equal(row.costPath, key)
  assert.equal(row.object, key === '生产路径' ? '产成品正式成本合计' : '商品正式成本合计')
  const total = sum(facts.objects, 'amount')
  equalMoney(row.formalCost, total)
  equalMoney(report.metrics.formalCost, total)
  const op = facts.operating
  const expense = op ? decimal(op.expense) : null
  const revenue = op ? decimal(op.revenue) : null
  const full = op ? total + expense : null
  const margin = op ? revenue - full : null
  for (const [field, expected] of Object.entries({
    operatingCost: expense, fullCost: full, revenue, fullMargin: margin,
    fullMarginRate: op ? ratio(margin, revenue) ?? 0n : null
  })) equalNullable(row[field], expected)
  assert.equal(row.status, op ? '已发布' : '待经营发布')
  for (const [field, expected] of Object.entries({
    operatingExpense: expense, enterpriseFullCost: full, revenue,
    operatingProfit: op ? decimal(op.profit) : null
  })) equalNullable(report.metrics[field], expected)
  const scopes = ['销售费用', '管理费用', '财务费用', '税金及附加', '其他支出']
  const publicRows = scopes.map((scope) => ({
    scope, amount: sum(facts.operatingFacts.filter((item) => item.scope === scope), 'amount')
  })).filter((item) => item.amount !== 0n)
  assert.equal(report.rows.length, 1 + publicRows.length, 'Unexpected or double-counted public expense rows')
  for (const item of publicRows) {
    const value = report.rows.find((line) => line.key === `public:${item.scope}`)?.values
    assert.ok(value, 'Missing frozen public expense')
    assert.equal(value.costPath, '公共费用')
    assert.equal(value.object, item.scope)
    equalMoney(value.operatingCost, item.amount)
    equalMoney(value.fullCost, item.amount)
    for (const field of ['formalCost', 'revenue', 'fullMargin', 'fullMarginRate']) assert.equal(value[field], null)
  }
}
const sourceText = (row) => `${row.sourceModule || ''}${row.sourceType || ''}${row.sourceNo || ''}`.toUpperCase()
const sourceAmount = (row) => decimal(row.allocatedAmount ?? row.amount)
const formulaOf = (row) => {
  try { return typeof row.formula === 'string' ? JSON.parse(row.formula || '{}') : row.formula || {} } catch {
    // The backend ignores legacy non-JSON formulas rather than inventing constraint facts.
    return {}
  }
}
const assertMakeBuy = (report, facts) => {
  assertReport(report, facts, 'make-buy')
  assert.equal(facts.period.enterpriseType, 'MANUFACTURING')
  assert.equal(report.rows.length, facts.objects.length)
  let incomparable = 0
  for (const object of facts.objects) {
    const row = report.rows.find((line) => line.key === object.objectKey)?.values
    assert.ok(row, 'Missing object comparison')
    for (const [key, value] of Object.entries({
      objectKey: object.objectKey, productCode: object.productCode, productName: object.productName
    })) assert.equal(row[key], value)
    const sources = facts.sources.filter((source) => source.objectKey === object.objectKey &&
      /PURCHASE|采购|OUTSOURCE|委外/.test(sourceText(source)))
    const make = ratio(decimal(object.amount), decimal(object.quantity))
    const buy = ratio(sources.reduce((v, s) => v + sourceAmount(s), 0n), sum(sources, 'quantity'))
    equalNullable(row.makeCost, make)
    equalNullable(row.buyCost, buy)
    equalNullable(row.difference, make === null || buy === null ? null : make - buy)
    const constraints = { qualityStatus: 'DATA_MISSING', deliveryStatus: 'DATA_MISSING', capacityLoad: null }
    for (const source of sources) {
      const formula = formulaOf(source)
      for (const key of ['qualityStatus', 'deliveryStatus']) {
        if (typeof formula[key] === 'string' && formula[key].trim()) constraints[key] = formula[key]
      }
      if (formula.capacityLoad !== null && formula.capacityLoad !== undefined) constraints.capacityLoad = formula.capacityLoad
    }
    const reasons = []
    if (make === null) reasons.push('自产正式成本或完工数量缺失')
    if (buy === null) reasons.push('外购采购/委外到岸成本缺失')
    if (constraints.qualityStatus === 'DATA_MISSING') reasons.push('质量约束事实缺失')
    if (constraints.deliveryStatus === 'DATA_MISSING') reasons.push('交期约束事实缺失')
    if (constraints.capacityLoad === null) reasons.push('产能约束事实缺失')
    assert.equal(row.notComparableReasons, reasons.join('；'))
    assert.equal(row.status, reasons.length ? '不可比较' : '需综合判断')
    assert.equal(row.qualityImpact, constraints.qualityStatus)
    assert.equal(row.deliveryImpact, constraints.deliveryStatus)
    equalNullable(row.capacityLoad, constraints.capacityLoad === null ? null : decimal(constraints.capacityLoad))
    equalMoney(row.externalSourceCount, BigInt(sources.length) * moneyScale)
    if (reasons.length) incomparable++
  }
  equalMoney(report.metrics.notComparableCount, BigInt(incomparable) * moneyScale)
  equalMoney(report.metrics.comparableCount, BigInt(report.rows.length - incomparable) * moneyScale)
  return incomparable
}
const assertGoods = (report, facts) => {
  assertReport(report, facts, 'goods-cost')
  assert.equal(facts.period.enterpriseType, 'TRADE')
  assert.equal(report.rows.length, facts.objects.length)
  for (const object of facts.objects) {
    const row = report.rows.find((line) => line.key === object.objectKey)?.values
    assert.ok(row)
    assert.equal(row.goodsCode, object.productCode || '')
    assert.equal(row.goodsName, object.productName || '')
    equalMoney(row.quantity, decimal(object.quantity))
    equalMoney(row.inventoryCost, decimal(object.amount))
    equalMoney(row.unitCost, object.unitCost === null
      ? ratio(decimal(object.amount), decimal(object.quantity)) ?? 0n : decimal(object.unitCost))
    assert.equal(row.status, '已发布')
  }
  equalMoney(report.metrics.goodsCount, BigInt(facts.objects.length) * moneyScale)
  equalMoney(report.metrics.inventoryCost, sum(facts.objects, 'amount'))
}

const reportColumns = {
  'enterprise-full-cost': [
    ['成本路径', 'costPath'], ['成本对象', 'object'], ['正式成本', 'formalCost', 'money'],
    ['运营费用', 'operatingCost', 'money'], ['管理全成本', 'fullCost', 'money'],
    ['收入', 'revenue', 'money'], ['全成本利润', 'fullMargin', 'money'], ['状态', 'status']
  ],
  'make-buy': [
    ['产品编码', 'productCode'], ['产品名称', 'productName'], ['成本对象', 'objectKey'],
    ['自产全成本', 'makeCost', 'money'], ['外购到岸成本', 'buyCost', 'money'],
    ['成本差异', 'difference', 'money'], ['质量影响', 'qualityImpact'],
    ['交期影响', 'deliveryImpact'], ['不可比较原因', 'notComparableReasons'], ['比较结论', 'status']
  ],
  'goods-cost': [
    ['商品编码', 'goodsCode'], ['商品名称', 'goodsName'], ['正式库存成本', 'inventoryCost', 'money'],
    ['单位成本', 'unitCost', 'money'], ['状态', 'status']
  ],
  'dimension-cost-report': [
    ['产品/商品编码', 'productCode'], ['产品/商品名称', 'productName'], ['完工/商品成本', 'total', 'money']
  ]
}
const displayMoney = (value) => {
  if (value === null || value === undefined) return '--'
  const amount = decimal(value)
  const centScale = moneyScale / 100n
  const cents = ((amount < 0n ? -amount : amount) + centScale / 2n) / centScale
  const integer = String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `¥${amount < 0n ? '-' : ''}${integer}.${String(cents % 100n).padStart(2, '0')}`
}
const readResponse = async (response) => {
  assert.ok(response.ok(), `Formal page GET failed: ${response.status()}`)
  const text = await response.text()
  return dataOf(response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(text) : JSON.parse(text))
}
const viewSnapshot = async (root) => root.evaluate((element) => ({
  visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
  periodId: element.getAttribute('data-backend-period-id'),
  month: element.getAttribute('data-report-period'),
  formal: element.getAttribute('data-formal'),
  count: element.getAttribute('data-report-row-count'),
  loaded: element.getAttribute('data-loaded'),
  error: element.getAttribute('data-error'),
  modelId: element.getAttribute('data-model-id'),
  modelVersion: element.getAttribute('data-model-version'),
  queryMonth: element.getAttribute('data-query-period'),
  text: element.textContent,
  headers: [...element.querySelectorAll('.report-table thead th .cell')].map((item) => item.textContent.trim()),
  rows: [...element.querySelectorAll('.report-table .el-table__body tr.el-table__row')]
    .map((row) => [...row.querySelectorAll('td .cell')].map((cell) => cell.textContent.trim()))
}))
const assertView = (view, report, facts, key) => {
  assert.equal(view.visible, true, 'Formal workspace is not visible')
  assert.equal(view.periodId, idOf(facts.period.id), 'Page bound to a different period')
  assert.equal(view.month, facts.period.period)
  assert.equal(view.loaded, 'true', 'Formal workspace has not finished loading')
  assert.equal(view.error, '', 'Formal workspace has a load error')
  assert.equal(view.modelId, idOf(facts.period.modelVersionId), 'Page bound to a different model ID')
  assert.equal(view.modelVersion, facts.period.modelVersionNo, 'Page uses a shared draft model')
  assert.equal(view.queryMonth, facts.period.period, 'Query period differs from the formal report')
  assert.equal(view.formal, 'true', 'Preview/shared workspace is not a formal report')
  assert.equal(Number(view.count), report.rows.length)
  assert.ok(!/演示数据|通用模板|404|页面不存在/.test(view.text || ''), 'Placeholder report rendered')
  assert.ok(view.rows.length > 0 && view.rows.length === Math.min(10, report.rows.length),
    'Missing actual formal table rows')
  for (const [label, field, type] of reportColumns[key]) {
    const column = view.headers.indexOf(label)
    assert.ok(column >= 0, `Missing exact column ${label}`)
    for (const [index, row] of view.rows.entries()) {
      const expected = report.rows[index].values[field]
      assert.equal(row[column], type === 'money' ? displayMoney(expected) : String(expected ?? '-'),
        `Rendered ${label} does not match formal API row ${index}`)
    }
  }
}

const matchesBrowserGet = (response, settings, paths) => {
  const url = new URL(response.url())
  // Vite's same-origin /admin-api proxy and the explicit local API are the only allowed origins.
  return [settings.apiBase, settings.webBase].some((base) => url.origin === new URL(base).origin) &&
    paths.includes(url.pathname) && response.request().method() === 'GET'
}

const verifyReportPage = async (ctx, deps, facts, report, route, allowedKeys = [report.reportKey]) => {
  requireSample(ctx.page, 'Caller ctx.page is required; fixture never opens a browser or logs in')
  const periodId = idOf(facts.period.id)
  const selector = '[data-testid="formal-cost-report"]'
  const target = `${route}?periodId=${periodId}`
  const settings = ctx.settings
  const responsePromise = ctx.page.waitForResponse((response) =>
    matchesBrowserGet(response, settings,
      allowedKeys.map((key) => `/admin-api${requestReport(periodId, key)}`)),
  { timeout: settings.browserTimeoutMs })
  // Attach a rejection handler before navigation so an early navigation failure is safe.
  responsePromise.catch(() => {})
  const evidence = { route, target, periodId, verified: false }
  try {
    await deps.navigate(ctx.page, target, { readySelector: selector })
    const response = await responsePromise
    assert.equal(String(response.request().headers()['tenant-id']), '1', 'Browser GET lacks explicit tenant1')
    const browserReport = await readResponse(response)
    assert.ok(allowedKeys.includes(browserReport.reportKey))
    const expected = browserReport.reportKey === report.reportKey ? report
      : await ctx.get(requestReport(periodId, browserReport.reportKey))
    assertReport(browserReport, facts, browserReport.reportKey)
    assert.equal(canonical(browserReport), canonical(expected), 'Browser GET differs from formal API')
    await ctx.page.waitForFunction(({ selector, periodId, count }) => {
      const root = document.querySelector(selector)
      return root?.getAttribute('data-backend-period-id') === periodId &&
        root?.getAttribute('data-report-row-count') === String(count) &&
        root?.getAttribute('data-loaded') === 'true' &&
        root?.getAttribute('data-error') === '' &&
        root.querySelectorAll('.report-table .el-table__body tr.el-table__row').length > 0
    }, { selector, periodId, count: expected.rows.length }, { timeout: settings.browserTimeoutMs })
    const view = await viewSnapshot(ctx.page.locator(selector))
    evidence.request = { method: 'GET', path: new URL(response.url()).pathname, tenantId: '1' }
    evidence.report = browserReport
    evidence.view = view
    assertView(view, expected, facts, browserReport.reportKey)
    const url = new URL(ctx.page.url())
    assert.ok(url.origin === new URL(settings.webBase).origin &&
      url.searchParams.get('periodId') === periodId, 'Navigation dropped the exact period or target')
    evidence.verified = true
    return evidence
  } catch (error) {
    evidence.error = error.message
    throw error
  } finally {
    ctx.proof.pages.push(evidence)
    await deps.artifact(ctx, `${ctx.caseId.toLowerCase()}-${route.replace(/\W+/g, '-')}`, evidence)
  }
}
const defaultArtifact = async (ctx, name, evidence) => {
  if (!ctx.outputDir) return
  const directory = path.join(ctx.outputDir, 'screenshots')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(evidence, null, 2))
  if (ctx.page) await saveScreenshot(ctx.page, ctx.outputDir, name, ctx.record || ctx.caseRecord)
}

const aliases = [
  ['企业管理全成本', 'enterprise-full-cost', 'results'],
  ['商品成本', 'goods-cost', 'results'],
  ['产品/商品成本表', 'dimension-cost-report', 'results'],
  ['订单批次成本表', 'order-batch-cost-report', 'results'],
  ['在制成本表', 'wip-cost-report', 'results'],
  ['成本结构分析', 'cost-composition', 'analysis'],
  ['成本趋势分析', 'cost-trend-analysis', 'analysis'],
  ['成本差异分析', 'cost-comparison', 'analysis'],
  ['异常波动分析', 'abnormal-fluctuation', 'analysis'],
  ['自产与外购比较', 'make-buy', 'analysis']
]
const hiddenIds = ['29611031', '29611032', '29611033', '29611034', '29611035',
  '29611042', '29611043', '29611044', '29611045', '29611046']
const menuComponent = (value) => String(value || '').split('?')[0].replace(/\.vue$/, '').replace(/^\/+/, '')
const menuPage = (value) => {
  const query = new URLSearchParams(String(value || '').split('?').slice(1).join('?'))
  assert.equal(query.getAll('page').length, 1, 'Missing or ambiguous menu page key')
  return query.get('page')
}
const flatten = (nodes, parent = '') => {
  assert.ok(Array.isArray(nodes), 'Missing menu inventory API')
  return nodes.flatMap((node) => {
    const route = (String(node.path).startsWith('/') ? node.path : `${parent}/${node.path}`).replace(/\/+/g, '/')
    return [{ ...node, id: idOf(node.id), route }, ...flatten(node.children || [], route)]
  })
}
const readMenus = async (ctx, deps) => {
  const sql = await deps.readSql(COST_ENTERPRISE_MENU_SQL)
  ctx.caseRecord.database ||= []
  ctx.caseRecord.database.push({ stage: 'formal-report-menus', ...sql })
  const inventory = parseCostEnterpriseMenuInventory(sql)
  const admin = flatten(await ctx.get('/system/menu/list'))
  const permissions = flatten((await ctx.get('/system/auth/get-permission-info')).menus)
  assert.ok(admin.length && permissions.length, 'Empty menu API is not menu evidence')
  return { inventory, admin, permissions }
}
const formalMenu = (menus, route, name, key) => {
  const matches = menus.inventory.filter((row) => row.route === route && row.type === 2)
  assert.equal(matches.length, 1, `Missing/duplicate menu ${route}`)
  const row = matches[0]
  assert.equal(row.name, name)
  assert.equal(row.visible, true)
  assert.equal(row.enabled, true)
  assert.equal(menuComponent(row.component), 'cost-management/section/index')
  assert.equal(menuPage(row.component), key)
  for (const list of [menus.admin, menus.permissions]) {
    const matching = list.filter((item) => item.id === row.id)
    assert.equal(matching.length, 1, 'Menu not available to current user')
    assert.equal(matching[0].name, name)
    assert.equal(menuComponent(matching[0].component), menuComponent(row.component))
    assert.equal(menuPage(matching[0].component), key)
    if (list === menus.permissions) assert.equal(matching[0].route, route, 'Permission hierarchy points elsewhere')
    else {
      assert.equal(matching[0].path, row.path)
      assert.equal(String(matching[0].parentId), row.parentId)
    }
  }
  return row
}
const verifyWorkspace = async (ctx, deps, route, selector, endpointPart) => {
  requireSample(ctx.page, 'A real caller page is required for menu workspace proof')
  const evidence = { route, verified: false }
  const settings = ctx.settings
  const pending = ctx.page.waitForResponse((response) =>
    matchesBrowserGet(response, settings, [`/admin-api${endpointPart}`]),
  { timeout: settings.browserTimeoutMs })
  pending.catch(() => {})
  try {
    await deps.navigate(ctx.page, route, { readySelector: selector })
    const response = await pending
    assert.equal(String(response.request().headers()['tenant-id']), '1')
    const body = await readResponse(response)
    assert.ok(body !== undefined, 'Workspace GET did not return business data')
    const root = ctx.page.locator(selector)
    await root.waitFor({ state: 'visible', timeout: settings.browserTimeoutMs })
    const shape = await root.evaluate((el) => ({
      controls: el.querySelectorAll('button,input,select,.el-select,.el-table').length,
      text: el.textContent, visible: el.getBoundingClientRect().height > 0,
      loaded: el.getAttribute('data-loaded'), error: el.getAttribute('data-error'),
      periodId: el.getAttribute('data-period-id')
    }))
    assert.ok(shape.visible && shape.controls > 0 && !/404|页面不存在|演示数据|通用模板/.test(shape.text))
    if (selector === '.exception-workspace') {
      await ctx.page.waitForFunction(() => {
        const el = document.querySelector('.exception-workspace')
        return el?.getAttribute('data-loaded') === 'true'
      }, undefined, { timeout: settings.browserTimeoutMs })
      const loaded = await root.evaluate((el) => ({
        loaded: el.getAttribute('data-loaded'), error: el.getAttribute('data-error'),
        periodId: el.getAttribute('data-period-id')
      }))
      assert.equal(loaded.loaded, 'true')
      assert.ok(!loaded.error)
      assert.equal(loaded.periodId, new URL(route, settings.webBase).searchParams.get('periodId'))
      Object.assign(shape, loaded)
    }
    assert.equal(new URL(ctx.page.url()).pathname, route.split('?')[0])
    evidence.request = { method: 'GET', path: new URL(response.url()).pathname, tenantId: '1' }
    evidence.shape = shape
    evidence.verified = true
    return evidence
  } catch (error) {
    evidence.error = error.message
    throw error
  } finally {
    ctx.proof.pages.push(evidence)
    await deps.artifact(ctx, `${ctx.caseId.toLowerCase()}-${route.replace(/\W+/g, '-')}`, evidence)
  }
}

const executions = new WeakMap()
export const hasCostFormalReportEvidence = (caseRecord, caseId = caseRecord?.id) => {
  const proof = caseRecord?.costFormalReportClosure
  if (!ids.includes(caseId) || proof?.caseId !== caseId || proof.tenantId !== '1' ||
      proof.finished !== true || !Array.isArray(proof.gaps) || proof.gaps.length ||
      !Array.isArray(proof.failures) || proof.failures.length ||
      !Array.isArray(proof.mutations) || proof.mutations.length || proof.complete !== true ||
      !proof.assertions || !Array.isArray(proof.pages) || !Array.isArray(proof.samples) ||
      (caseRecord.checks || []).some((check) => check.passed === false)) return false
  const names = Object.values(COST_FORMAL_REPORT_CHECKS[caseId])
  const checksValid = names.every((name) => {
    const checks = (caseRecord.checks || []).filter((check) => check.name === name)
    const evidence = proof.assertions[name]
    return checks.length === 1 && checks[0].passed === true && evidence?.verified === true &&
      evidence.data !== null && evidence.data !== undefined
  }) && proof.pages.length > 0 && proof.pages.every((page) => page.verified === true &&
    page.request?.method === 'GET' && page.request?.tenantId === '1')
  if (!checksValid) return false
  try {
    for (const page of proof.pages.filter((item) => item.report)) {
      const sample = proof.samples.find((item) => item.facts.period.id === page.periodId &&
        item.report.reportKey === page.report.reportKey)
      assert.ok(sample, 'Page lacks independently read formal fact sample')
      assertReport(page.report, sample.facts, page.report.reportKey)
      assert.equal(canonical(page.report), canonical(sample.report))
      assertView(page.view, page.report, sample.facts, page.report.reportKey)
    }
    if (caseId === 'COST-035') {
      const positive = proof.samples.find((item) => item.facts.operating)
      const negative = proof.samples.find((item) => !item.facts.operating)
      assert.ok(positive && negative)
      assertEnterprise(positive.report, positive.facts)
      assertEnterprise(negative.report, negative.facts)
      assert.deepEqual(proof.pages.map((page) => page.route).sort(), [
        '/cost-management/results/enterprise-full-cost', '/reports/cost/results/enterprise-full-cost'
      ])
    } else if (caseId === 'COST-036') {
      // Original allocated-empty-month provenance is deliberately not inferred from present-day facts.
      return false
    } else if (caseId === 'COST-037') {
      assert.ok(proof.samples.some((item) => assertMakeBuy(item.report, item.facts) > 0))
      assert.equal(proof.pages.length, 1)
      assert.equal(proof.pages[0].route, '/cost-management/analysis/make-buy')
    } else {
      assert.ok(proof.menuInventory?.inventory?.length && proof.menuInventory?.permissions?.length)
      if (caseId === 'COST-039') {
        assert.equal(proof.pages.length, 1)
        assert.equal(proof.pages[0].route, '/reports/cost/results/enterprise-full-cost')
        assert.equal(proof.assertions[COST_FORMAL_REPORT_CHECKS[caseId].targets].data.length, aliases.length)
      } else assert.ok(proof.pages.length >= 5)
    }
    return true
  } catch { return false }
}

// Only injected api/page are used. There is no session creation, mutation API, or model allocation.
export const runCostFormalReportClosure = async (input, dependencies = {}) => {
  const { caseId = input.caseRecord?.id, caseRecord } = input
  assert.ok(ids.includes(caseId) && caseRecord, 'Expected COST-035..039 and a caseRecord')
  assert.ok(!caseRecord.id || caseRecord.id === caseId, 'Mismatched case record')
  if (executions.has(caseRecord)) {
    assert.equal(caseRecord.costFormalReportClosure.caseId, caseId)
    return executions.get(caseRecord)
  }
  assert.ok(!caseRecord.costFormalReportClosure, 'Existing evidence must not be overwritten or executed twice')
  const settings = dependencies.settings || config
  assertLocal(settings)
  const deps = {
    readSql: runReadOnlySql, navigate: openRoute, artifact: defaultArtifact, ...dependencies
  }
  const proof = {
    caseId, tenantId: '1', mode: 'existing-formal-facts-read-only', finished: false,
    assertions: {}, samples: [], pages: [], gaps: [], failures: [], mutations: [], complete: false
  }
  caseRecord.costFormalReportClosure = proof
  const ctx = { ...input, caseId, proof, settings, get: async (route) => dataOf(await input.api.getBusiness(route)) }
  const check = async (key, fn) => {
    const name = COST_FORMAL_REPORT_CHECKS[caseId][key]
    assert.ok(name && !proof.assertions[name], 'Duplicate or unknown assertion evidence')
    try {
      const data = await fn()
      assert.ok(data !== null && data !== undefined, 'Empty assertion evidence')
      proof.assertions[name] = { verified: true, data }
      caseRecord.checks ||= []
      caseRecord.checks.push({ name, passed: true, details: JSON.stringify(data) })
      return data
    } catch (error) {
      const issue = { name, message: error.message }
      proof.assertions[name] = { verified: false, [error.evidenceGap ? 'gap' : 'error']: error.message }
      if (error.evidenceGap) proof.gaps.push(issue)
      else {
        proof.failures.push(issue)
        caseRecord.checks ||= []
        caseRecord.checks.push({ name, passed: false, details: error.message })
      }
      return null
    }
  }
  const run = async () => {
    const guard = async (route) => {
      const request = route.request()
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        proof.mutations.push({ method: request.method(), path: new URL(request.url()).pathname })
        await route.abort('blockedbyclient')
      } else await route.continue()
    }
    let guarded = false
    try {
      if (input.page) {
        await input.page.route('**/admin-api/cost/**', guard)
        guarded = true
      }
      const periods = []
      let expectedTotal
      for (let pageNo = 1; ; pageNo++) {
        const result = await ctx.get(`/cost/periods?accountingOrgId=1&pageNo=${pageNo}&pageSize=100`)
        assert.ok(Number.isSafeInteger(result.total) && result.total >= 0 && Array.isArray(result.list))
        expectedTotal ??= result.total
        assert.equal(result.total, expectedTotal, 'Period census changed while reading')
        assert.ok(result.list.length <= 100)
        periods.push(...result.list)
        if (periods.length >= result.total) break
        assert.ok(result.list.length > 0, 'Truncated period pagination')
      }
      assert.equal(periods.length, expectedTotal, 'Invalid period census')
      assert.equal(new Set(periods.map((row) => idOf(row.id))).size, periods.length, 'Duplicate period')
      const preferredId = input.periodId === undefined ? null : idOf(input.periodId)
      if (preferredId) assert.ok(periods.some((row) => idOf(row.id) === preferredId), 'Preferred period is not in local tenant census')
      const orderedPeriods = [...periods].sort((a, b) => {
        if (a.id === preferredId) return -1
        if (b.id === preferredId) return 1
        return BigInt(idOf(a.id)) > BigInt(idOf(b.id)) ? -1 : 1
      })
      const factsCache = new Map()
      const factsFor = (period) => {
        const id = idOf(period.id)
        if (!factsCache.has(id)) factsCache.set(id, readFacts(period, ctx.get, deps.readSql, caseRecord))
        return factsCache.get(id)
      }
      const find = async (predicate, label) => {
        for (const period of orderedPeriods) {
          if (!predicate(period)) continue
          const facts = await factsFor(period)
          if (facts.publication && facts.objects.length) return facts
        }
        throw gapError(label)
      }
      const published = (period) => ['COST_PUBLISHED', 'OPERATING_PUBLISHED', 'CLOSED'].includes(period.status) ||
        Boolean(period.currentPublicationId)
      const manufacturing = (period) => published(period) && period.enterpriseType === 'MANUFACTURING'
      const enterpriseSample = async () => {
        let fallback
        for (const period of orderedPeriods.filter(published)) {
          const facts = await factsFor(period)
          if (!facts.publication || !facts.objects.length) continue
          if (facts.operating) return facts
          fallback ||= facts
        }
        requireSample(fallback, 'No existing nonempty formal cost publication')
        return fallback
      }
      const reportFor = async (facts, key) => {
        const report = await ctx.get(requestReport(facts.period.id, key))
        proof.samples.push({ facts, report })
        return report
      }
      if (caseId === 'COST-035') {
        let positive, negative, report
        await check('rows', async () => {
          for (const period of orderedPeriods.filter(published)) {
            const facts = await factsFor(period)
            if (!facts.publication || !facts.objects.length) continue
            if (facts.operating) positive ||= facts
            else negative ||= facts
            if (positive && negative) break
          }
          requireSample(positive, 'Missing existing cost + operating PUBLISHED positive control')
          report = await reportFor(positive, 'enterprise-full-cost')
          assertEnterprise(report, positive)
          return { periodId: idOf(positive.period.id), publicationId: positive.publication.id, report }
        })
        await check('operating', async () => {
          requireSample(positive && negative, 'Both frozen operating positive and unpublished negative are required')
          requireSample(report, 'Formal positive report not verified')
          assertEnterprise(report, positive)
          const absent = await reportFor(negative, 'enterprise-full-cost')
          assertEnterprise(absent, negative)
          return { operatingId: positive.operating.id, positive: report, negative: absent, negativePeriodId: idOf(negative.period.id) }
        })
        await check('metrics', async () => {
          requireSample(positive && report, 'Missing verified formal positive report')
          assertEnterprise(report, positive)
          return { objectFacts: positive.objects, operating: positive.operating, metrics: report.metrics }
        })
        await check('pages', async () => {
          requireSample(positive && report, 'Missing formal operating positive for both routes')
          const result = []
          for (const route of ['/cost-management/results/enterprise-full-cost', '/reports/cost/results/enterprise-full-cost']) {
            result.push(await verifyReportPage(ctx, deps, positive, report, route))
          }
          return result
        })
      } else if (caseId === 'COST-036') {
        let production, publishedTrade, unpublishedTrade
        await check('rejection', async () => {
          production = await find(manufacturing, 'No existing formally published MANUFACTURING negative control')
          const body = await input.api.request('GET', requestReport(production.period.id, 'goods-cost'), undefined, {
            expectedBusinessRejection: { code: 422001, message: '商品成本表仅适用于贸易型期间' }
          })
          assert.equal(body.code, 422001)
          assert.equal(body.msg, '商品成本表仅适用于贸易型期间')
          return { periodId: idOf(production.period.id), publicationId: production.publication.id, body }
        })
        await check('trade', async () => {
          for (const period of orderedPeriods.filter((item) => item.enterpriseType === 'TRADE')) {
            const facts = await factsFor(period)
            const model = await ctx.get(`/cost/model-versions/${idOf(facts.period.modelVersionId)}`)
            assert.equal(idOf(model.id), idOf(facts.period.modelVersionId))
            assert.equal(model.enterpriseType, 'TRADE')
            assert.equal(model.versionNo, facts.period.modelVersionNo)
            assert.equal(idOf(model.accountingOrgId), '1')
            assert.equal(model.status, 'LOCKED', 'TRADE positive requires legal existing locked model')
            if (facts.publication && facts.objects.length) publishedTrade ||= { facts, model }
            if (!facts.publication) unpublishedTrade ||= { facts, model }
          }
          requireSample(publishedTrade, 'GAP: no existing legal TRADE PUBLISHED nonempty positive; type rejection is not a positive control')
          const report = await reportFor(publishedTrade.facts, 'goods-cost')
          assertGoods(report, publishedTrade.facts)
          requireSample(unpublishedTrade, 'GAP: no legal existing unpublished TRADE publication-gate sample')
          const body = await input.api.request('GET', requestReport(unpublishedTrade.facts.period.id, 'goods-cost'), undefined, {
            expectedBusinessRejection: { code: 422001, message: '本期间没有有效的正式成本发布，不能查询正式报表' }
          })
          assert.equal(body.code, 422001)
          assert.equal(body.msg, '本期间没有有效的正式成本发布，不能查询正式报表')
          return { positive: report, model: publishedTrade.model, negativePeriodId: idOf(unpublishedTrade.facts.period.id), body }
        })
        await check('retained', async () => {
          // A far-future month alone cannot prove that it was originally empty or exclusively
          // allocated, so the run-owned fixture records the month census taken *before* it
          // allocated the month, plus the period/model it created for that exact month.
          const records = Array.isArray(ctx.record?.cases) ? ctx.record.cases : []
          const proven = records.flatMap((entry) => {
            const fixture = entry?.fixtures?.costScenario
            const provenance = fixture?.allocationProvenance
            if (!provenance || fixture.runId !== ctx.record.runId || fixture.tenantId !== '1' ||
                !fixture.periodId || !fixture.modelId) return []
            return [{ fixture, provenance }]
          }).filter((item) => item.provenance.allocatedAfterEveryExistingMonth === true)
          requireSample(proven.length > 0,
            'GAP: no run-owned far-future allocation provenance recorded before the month census changed')
          const sample = proven.at(-1)
          const period = await ctx.get(`/cost/periods/${idOf(sample.fixture.periodId)}`)
          assert.equal(String(period.period), sample.provenance.allocatedMonth,
            'Allocation provenance month must match the owned period')
          assert.equal(idOf(period.modelVersionId), idOf(sample.fixture.modelId),
            'Allocated far-future month must stay bound to the owned fixture model')
          const model = await ctx.get(`/cost/model-versions/${idOf(period.modelVersionId)}`)
          assert.equal(idOf(model.id), idOf(sample.fixture.modelId))
          assert.equal(String(model.effectiveMonth), sample.provenance.allocatedMonth,
            'Owned model effective month must equal the allocated month')
          const ownedMonths = records.filter((entry) =>
            entry?.fixtures?.costScenario?.periodId)
            .map((entry) => entry.fixtures.costScenario.allocationProvenance?.allocatedMonth)
            .filter((month) => typeof month === 'string')
          assert.equal(new Set(ownedMonths).size, ownedMonths.length,
            'Run-owned far-future months must be unique across cost fixtures')
          return {
            runId: ctx.record.runId,
            caseId: sample.fixture.caseId,
            allocatedMonth: sample.provenance.allocatedMonth,
            latestExistingMonthBeforeAllocation: sample.provenance.latestExistingMonth,
            periodId: idOf(period.id),
            modelId: idOf(model.id),
            ownedMonthCensus: ownedMonths.sort()
          }
        })
        await check('page', async () => {
          requireSample(production, 'Missing formally published MANUFACTURING page period')
          const report = await reportFor(production, 'dimension-cost-report')
          assertReport(report, production, 'dimension-cost-report')
          return verifyReportPage(ctx, deps, production, report,
            '/cost-management/results/goods-cost', ['dimension-cost-report', 'goods-cost'])
        })
      } else if (caseId === 'COST-037') {
        let facts, report, incomparable
        await check('rows', async () => {
          facts = await find(manufacturing, 'Missing existing nonempty MANUFACTURING formal comparison period')
          report = await reportFor(facts, 'make-buy')
          incomparable = assertMakeBuy(report, facts)
          return { periodId: idOf(facts.period.id), publicationId: facts.publication.id, report, objects: facts.objects, sources: facts.sources }
        })
        await check('reasons', async () => {
          requireSample(report && incomparable > 0, 'Missing actual incomparable object negative control; empty every is not evidence')
          assertMakeBuy(report, facts)
          return report.rows.filter((row) => row.values.status === '不可比较')
        })
        let page
        await check('page', async () => {
          requireSample(facts && report, 'Missing nonempty formal comparison report')
          page = await verifyReportPage(ctx, deps, facts, report, '/cost-management/analysis/make-buy')
          return page
        })
        await check('columns', async () => {
          requireSample(page?.verified, 'Exact columns require verified formal comparison page and real rows')
          assertView(page.view, report, facts, 'make-buy')
          return { headers: page.view.headers, rows: page.view.rows }
        })
      } else if (caseId === 'COST-038') {
        const menus = await readMenus(ctx, deps)
        proof.menuInventory = menus
        await check('added', async () => {
          const definitions = [
            ['企业管理全成本', 'enterprise-full-cost', 'results'],
            ['商品成本', 'goods-cost', 'results'],
            ['异常处理队列', 'exception-queue', 'monthly']
          ]
          const matched = definitions.map(([name, key, section]) =>
            formalMenu(menus, `/cost-management/${section}/${key}`, name, key))
          const facts = await enterpriseSample()
          const report = await reportFor(facts, 'enterprise-full-cost')
          assertEnterprise(report, facts)
          await verifyReportPage(ctx, deps, facts, report, matched[0].route)
          // Manufacturing redirects goods; verify the real destination, never just its URL.
          const production = await find(manufacturing, 'Missing manufacturing menu page control')
          const dimension = await reportFor(production, 'dimension-cost-report')
          assertReport(dimension, production, 'dimension-cost-report')
          await verifyReportPage(ctx, deps, production, dimension, matched[1].route, ['dimension-cost-report', 'goods-cost'])
          await verifyWorkspace(ctx, deps, `${matched[2].route}?periodId=${idOf(facts.period.id)}`,
            '.exception-workspace', `/cost/periods/${idOf(facts.period.id)}/rule-hits`)
          return matched
        })
        await check('hidden', async () => {
          const hidden = hiddenIds.map((id) => {
            const row = menus.inventory.find((item) => item.id === id)
            assert.ok(row, 'Hidden placeholder record must be retained, not deleted')
            assert.equal(row.visible, false, 'Placeholder remains visible')
            return row
          })
          const keys = new Set(hidden.filter((row) => row.type === 2).map((row) => menuPage(row.component)))
          const leaked = menus.inventory.filter((row) => row.type === 2 && row.enabled && row.visible &&
            menuComponent(row.component) === 'cost-management/section/index' && keys.has(menuPage(row.component)))
          assert.equal(leaked.length, 0, 'Visible alias re-exposes hidden placeholder')
          return { hidden, leaked }
        })
        await check('trace', async () => {
          const matched = [
            formalMenu(menus, '/cost-management/monthly/cost-trial', '成本试算', 'cost-trial'),
            formalMenu(menus, '/cost-management/monthly/cost-publish', '成本发布', 'cost-publish')
          ]
          for (const row of matched) await verifyWorkspace(ctx, deps, row.route,
            row.path === 'cost-trial' ? '.monthly-workbench' : '.publish-workspace',
            row.path === 'cost-trial' ? '/cost/periods' : '/cost/outbox/dead-letters')
          return matched
        })
        await check('workbench', async () => {
          requireSample(input.page, 'Missing real workbench page')
          await deps.navigate(input.page, '/cost-management', { readySelector: '.cost-workbench' })
          const buttons = input.page.locator('.cost-workbench .quick-links button')
          const count = await buttons.count()
          assert.equal(count, 4, 'Unexpected workbench quick links require explicit audit')
          const expected = [
            ['异常处理队列', '/cost-management/monthly/exception-queue', '.exception-workspace'],
            ['计算过程', '/cost-management/monthly/cost-trial', '.monthly-workbench'],
            ['成本发布', '/cost-management/monthly/cost-publish', '.publish-workspace'],
            ['成本分析', '/cost-management/analysis/cost-composition', '[data-testid="formal-cost-report"]']
          ]
          const destinations = []
          for (const [label, route, selector] of expected) {
            await deps.navigate(input.page, '/cost-management', { readySelector: '.cost-workbench' })
            const button = input.page.locator('.cost-workbench .quick-links button').filter({ hasText: label })
            assert.equal(await button.count(), 1)
            await button.click()
            await input.page.waitForURL((url) => url.pathname === route, { timeout: config.browserTimeoutMs })
            const workspace = input.page.locator(selector)
            await workspace.waitFor({ state: 'visible', timeout: config.browserTimeoutMs })
            assert.ok(await workspace.locator('button,input,.el-table,.el-select').count() > 0, 'Navigation opened empty shell')
            destinations.push({ label, route, selector })
          }
          return destinations
        })
      } else {
        const menus = await readMenus(ctx, deps)
        proof.menuInventory = menus
        await check('titles', async () => aliases.map(([name, key, section]) => {
          const canonicalMenu = menus.inventory.filter((row) =>
            row.route === `/cost-management/${section}/${key}` && row.type === 2)
          const alias = menus.inventory.filter((row) =>
            row.route === `/reports/cost/${section}/${key}` && row.type === 2)
          assert.equal(canonicalMenu.length, 1)
          assert.equal(alias.length, 1)
          assert.equal(canonicalMenu[0].name, name)
          assert.equal(alias[0].name, name)
          return { name, canonicalId: canonicalMenu[0].id, aliasId: alias[0].id }
        }))
        await check('targets', async () => aliases.map(([name, key, section]) => ({
          canonical: formalMenu(menus, `/cost-management/${section}/${key}`, name, key),
          alias: formalMenu(menus, `/reports/cost/${section}/${key}`, name, key)
        })))
        await check('page', async () => {
          const facts = await enterpriseSample()
          const report = await reportFor(facts, 'enterprise-full-cost')
          assertEnterprise(report, facts)
          return verifyReportPage(ctx, deps, facts, report, '/reports/cost/results/enterprise-full-cost')
        })
      }
    } catch (error) {
      proof[error.evidenceGap ? 'gaps' : 'failures'].push({ name: `${caseId} runtime`, message: error.message })
      if (!error.evidenceGap) {
        caseRecord.checks ||= []
        caseRecord.checks.push({ name: `${caseId} formal-report runtime contract`, passed: false, details: error.message })
      }
    } finally {
      if (guarded) await input.page.unroute('**/admin-api/cost/**', guard)
      if (proof.mutations.length) {
        proof.failures.push({ name: `${caseId} read-only`, message: 'Page attempted cost mutation; request aborted, not mocked' })
        caseRecord.checks ||= []
        caseRecord.checks.push({ name: `${caseId} formal-report read-only guard`, passed: false, details: JSON.stringify(proof.mutations) })
      }
      proof.finished = true
      proof.complete = !proof.gaps.length && !proof.failures.length &&
        Object.values(COST_FORMAL_REPORT_CHECKS[caseId]).every((name) => proof.assertions[name]?.verified === true)
      caseRecord.notes ||= []
      for (const issue of [...proof.gaps, ...proof.failures]) caseRecord.notes.push(`${issue.name}: ${issue.message}`)
    }
    return { acceptanceComplete: hasCostFormalReportEvidence(caseRecord, caseId),
      partial: !hasCostFormalReportEvidence(caseRecord, caseId), evidence: proof,
      remainingAssertions: Object.values(COST_FORMAL_REPORT_CHECKS[caseId]).filter((name) => !proof.assertions[name]?.verified) }
  }
  const promise = run()
  executions.set(caseRecord, promise)
  return promise
}
