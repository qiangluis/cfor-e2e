import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  CHECKS, COST_FORMAL_REPORT_CHECKS, COST_FORMAL_REPORT_BINDINGS,
  runCostFormalReportClosure, hasCostFormalReportEvidence
} from '../fixtures/cost-formal-report-closure.mjs'

const settings = {
  target: 'local', tenantId: '1',
  apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151'
}
const clone = (value) => structuredClone(value)
const success = (data) => ({ code: 0, data })
const paths = {
  enterprise: '/cost-management/results/enterprise-full-cost',
  alias: '/reports/cost/results/enterprise-full-cost',
  goods: '/cost-management/results/goods-cost',
  makeBuy: '/cost-management/analysis/make-buy'
}
const columns = {
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
  'dimension-cost-report': [
    ['产品/商品编码', 'productCode'], ['产品/商品名称', 'productName'], ['完工/商品成本', 'total', 'money']
  ],
  'goods-cost': [
    ['商品编码', 'goodsCode'], ['商品名称', 'goodsName'], ['正式库存成本', 'inventoryCost', 'money'],
    ['单位成本', 'unitCost', 'money'], ['状态', 'status']
  ]
}
const money = (value) => value === null || value === undefined ? '--'
  : `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const viewFor = (report, period) => ({
  visible: true, periodId: period.id, month: period.period, formal: 'true',
  loaded: 'true', error: '', modelId: period.modelVersionId, modelVersion: period.modelVersionNo,
  queryMonth: period.period,
  count: String(report.rows.length), text: '正式报表',
  headers: ['序号', ...columns[report.reportKey].map(([label]) => label)],
  rows: report.rows.slice(0, 10).map((row, index) => [String(index + 1),
    ...columns[report.reportKey].map(([, key, type]) => type === 'money'
      ? money(row.values[key]) : String(row.values[key] ?? '-'))])
})
const period = (id, operating = false, enterpriseType = 'MANUFACTURING', published = true) => ({
  id, accountingOrgId: '1', period: `2099-${String(Number(id) - 100).padStart(2, '0')}`,
  enterpriseType, modelVersionId: `2${id}`, modelVersionNo: `E2E-${id}`,
  status: published ? 'COST_PUBLISHED' : 'ACCOUNTING',
  currentPublicationId: published ? `3${id}` : null,
  currentOperatingPublicationId: operating ? `4${id}` : null
})
const factsFor = (p) => {
  const tenantId = '1'
  const publicationId = p.currentPublicationId
  return {
    period: [{ id: p.id, tenantId, period: p.period, enterpriseType: p.enterpriseType,
      accountingOrgId: '1', modelId: p.modelVersionId, versionNo: p.modelVersionNo, publicationId }],
    publication: publicationId ? [{ id: publicationId, tenantId, periodId: p.id,
      status: 'PUBLISHED', batchNo: `B-${p.id}`, resultHash: `RH-${p.id}` }] : [],
    object: publicationId ? [{
      id: `5${p.id}`, tenantId, publicationId, objectKey: `OBJ-${p.id}`,
      productCode: `PRODUCT-${p.id}`, productName: `正式产品${p.id}`,
      quantity: '2.000000', amount: '100.000000', unitCost: '50.000000'
    }] : [],
    source: [],
    operating: p.currentOperatingPublicationId ? [{
      id: p.currentOperatingPublicationId, tenantId, periodId: p.id, costPublicationId: publicationId,
      status: 'PUBLISHED', batchNo: `OP-${p.id}`, resultHash: `ORH-${p.id}`,
      revenue: '1000', expense: '50', profit: '550', salesCost: '400'
    }] : [],
    operatingFact: p.currentOperatingPublicationId ? [{
      id: `6${p.id}`, tenantId, publicationId: p.currentOperatingPublicationId, scope: '管理费用', amount: '50'
    }] : []
  }
}
const makeReport = (p, key, f) => {
  const report = { reportKey: key, period: p.period, publicationId: p.currentPublicationId,
    scope: `${p.enterpriseType}/${p.modelVersionNo}`, formal: true, metrics: {}, rows: [], notices: [] }
  const object = f.object[0]
  if (key === 'enterprise-full-cost') {
    const op = f.operating[0]
    const path = p.enterpriseType === 'MANUFACTURING' ? '生产路径' : '贸易路径'
    report.rows = [{ key: path, values: {
      costPath: path, object: p.enterpriseType === 'MANUFACTURING' ? '产成品正式成本合计' : '商品正式成本合计',
      formalCost: 100, operatingCost: op ? 50 : null, fullCost: op ? 150 : null,
      revenue: op ? 1000 : null, fullMargin: op ? 850 : null, fullMarginRate: op ? 0.85 : null,
      status: op ? '已发布' : '待经营发布'
    } }]
    if (op) report.rows.push({ key: 'public:管理费用', values: {
      costPath: '公共费用', object: '管理费用', formalCost: null,
      operatingCost: 50, fullCost: 50, revenue: null, fullMargin: null, fullMarginRate: null, status: '已发布'
    } })
    report.metrics = { formalCost: 100, operatingExpense: op ? 50 : null,
      enterpriseFullCost: op ? 150 : null, revenue: op ? 1000 : null, operatingProfit: op ? 550 : null }
  } else if (key === 'make-buy') {
    const source = f.source[0]
    const formula = source ? JSON.parse(source.formula || '{}') : {}
    const comparable = source && formula.qualityStatus && formula.deliveryStatus && formula.capacityLoad !== undefined
    const reasons = comparable ? '' : `${source ? '' : '外购采购/委外到岸成本缺失；'}质量约束事实缺失；交期约束事实缺失；产能约束事实缺失`
    report.rows = object ? [{ key: object.objectKey, values: {
      objectKey: object.objectKey, productCode: object.productCode, productName: object.productName,
      makeCost: 50, buyCost: source ? 40 : null, difference: source ? 10 : null,
      capacityLoad: formula.capacityLoad ?? null, qualityImpact: formula.qualityStatus || 'DATA_MISSING',
      deliveryImpact: formula.deliveryStatus || 'DATA_MISSING', externalSourceCount: source ? 1 : 0,
      notComparableReasons: reasons, status: comparable ? '需综合判断' : '不可比较'
    } }] : []
    report.metrics = { comparableCount: comparable ? 1 : 0, notComparableCount: comparable ? 0 : 1 }
  } else if (key === 'goods-cost') {
    report.rows = object ? [{ key: object.objectKey, values: {
      goodsCode: object.productCode, goodsName: object.productName, quantity: 2,
      inventoryCost: 100, unitCost: 50, status: '已发布'
    } }] : []
    report.metrics = { goodsCount: 1, inventoryCost: 100 }
  } else {
    report.rows = object ? [{ key: object.productCode, values: {
      productCode: object.productCode, productName: object.productName, total: 100
    } }] : []
  }
  return report
}
const menuDefinitions = [
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
const makeMenus = () => {
  const rows = [
    ['1', '0', '成本管理', '/cost-management'], ['2', '0', '报表', '/reports'],
    ['3', '2', '成本', 'cost'], ['4', '1', '成本结果', 'results'],
    ['5', '1', '成本分析', 'analysis'], ['6', '3', '成本结果', 'results'],
    ['7', '3', '成本分析', 'analysis'], ['8', '1', '月度核算', 'monthly']
  ].map(([id, parentId, name, path]) => ({
    id, parentId, name, path, component: '', componentName: '', permission: '',
    type: 1, status: 0, visible: 1
  }))
  const add = (id, parentId, name, key, visible = 1) => rows.push({
    id, parentId, name, path: key, component: `cost-management/section/index.vue?page=${key}`,
    componentName: `Menu${id}`, permission: '', type: 2, status: 0, visible
  })
  for (const [i, [name, key, section]] of menuDefinitions.entries()) {
    add(String(1000 + i), section === 'results' ? '4' : '5', name, key)
    add(String(2000 + i), section === 'results' ? '6' : '7', name, key)
  }
  add('3001', '8', '异常处理队列', 'exception-queue')
  add('3002', '8', '成本试算', 'cost-trial')
  add('3003', '8', '成本发布', 'cost-publish')
  for (const id of ['29611031', '29611032', '29611033', '29611034', '29611035',
    '29611042', '29611043', '29611044', '29611045', '29611046']) {
    add(id, '1', `隐藏${id}`, `placeholder-${id}`, 0)
  }
  return rows
}
const treeFor = (rows, parentId = '0') => rows.filter((row) => row.parentId === parentId)
  .map((row) => ({ ...row, children: treeFor(rows, row.id) }))

class OfflinePage {
  constructor (world) {
    this.world = world
    this.waiters = []
    this.guards = new Map()
    this.currentUrl = settings.webBase
    this.navigations = []
    this.view = {}
  }

  async route (pattern, handler) { this.guards.set(pattern, handler) }
  async unroute (pattern, handler) {
    assert.equal(this.guards.get(pattern), handler)
    this.guards.delete(pattern)
  }

  waitForResponse (predicate) {
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }))
  }

  async emit (endpoint, body, overrides = {}) {
    const response = {
      url: () => `${overrides.origin || this.world.browserOrigin || settings.apiBase}/admin-api${overrides.path || endpoint}`,
      request: () => ({
        method: () => overrides.method || 'GET',
        headers: () => ({ 'tenant-id': this.world.browserTenant || '1' })
      }),
      ok: () => true, status: () => 200, headers: () => ({}),
      text: async () => JSON.stringify(success(body))
    }
    if (this.world.probeResponses) {
      for (const overrides of [
        { origin: 'http://127.0.0.1:9152' }, { origin: 'https://not-local.example:48083' },
        { origin: 'http://127.0.0.2:48083' }, { method: 'POST' }, { path: `${endpoint}/other` },
        { path: endpoint.replace(/\/\d+$/, '/999999') }
      ]) {
        if (overrides.path === endpoint) continue
        const probe = {
          ...response,
          url: () => `${overrides.origin || settings.webBase}/admin-api${overrides.path || endpoint}`,
          request: () => ({ method: () => overrides.method || 'GET' })
        }
        for (const waiter of this.waiters) assert.equal(waiter.predicate(probe), false,
          `Incorrect response accepted: ${JSON.stringify(overrides)}`)
      }
    }
    for (const waiter of this.waiters.filter((item) => item.predicate(response))) {
      waiter.resolve(response)
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
    }
  }

  async navigate (target) {
    this.navigations.push(target)
    const url = new URL(target, settings.webBase)
    this.currentUrl = url.href
    if (this.world.attemptMutation) {
      const handler = this.guards.get('**/admin-api/cost/**')
      await handler({
        request: () => ({ method: () => 'PUT', url: () => `${settings.apiBase}/admin-api/cost/workspace-states` }),
        abort: async () => { this.world.aborted++ }, continue: async () => assert.fail('Unexpected cost write allowed')
      })
    }
    const key = url.pathname.split('/').at(-1)
    if (url.pathname === '/cost-management') {
      this.view = { visible: true, controls: 4, text: '成本工作台' }
      return
    }
    if (['enterprise-full-cost', 'make-buy', 'goods-cost', 'cost-composition'].includes(key)) {
      const periodId = url.searchParams.get('periodId') || '101'
      const p = this.world.periods.find((row) => row.id === periodId)
      let actualKey = key
      if (key === 'goods-cost' && p.enterpriseType === 'MANUFACTURING') {
        actualKey = 'dimension-cost-report'
        this.currentUrl = `${settings.webBase}/cost-management/results/dimension-cost-report?periodId=${periodId}`
        if (this.world.dropRedirectPeriod) this.currentUrl = this.currentUrl.split('?')[0]
      }
      if (key === 'cost-composition') actualKey = 'dimension-cost-report'
      const report = clone(this.world.report(p, actualKey))
      this.world.browserReport?.(report)
      this.view = viewFor(report, p)
      this.world.view?.(this.view, target)
      await this.emit(`/cost/reports/${actualKey}/${periodId}`, report)
    } else {
      this.view = { visible: true, controls: 3, text: '正式工作区',
        loaded: 'true', error: '', periodId: url.searchParams.get('periodId') }
      await this.emit(key === 'exception-queue' ? `/cost/periods/${this.view.periodId}/rule-hits`
        : key === 'cost-trial' ? '/cost/periods' : '/cost/outbox/dead-letters', { list: [], total: 0 })
    }
  }

  locator (selector) {
    const page = this
    let label
    return {
      evaluate: async () => clone(page.view),
      waitFor: async () => {},
      count: async () => selector.endsWith('.quick-links button') ? label ? 1 : 4 : 3,
      filter (options) { label = options.hasText; return this },
      locator () { return { count: async () => page.world.emptyWorkspace ? 0 : 3 } },
      click: async () => {
        const targets = {
          异常处理队列: '/cost-management/monthly/exception-queue',
          计算过程: '/cost-management/monthly/cost-trial',
          成本发布: '/cost-management/monthly/cost-publish',
          成本分析: '/cost-management/analysis/cost-composition'
        }
        await page.navigate(targets[label])
      }
    }
  }

  async waitForFunction () {}
  async waitForURL (predicate) { assert.equal(predicate(new URL(this.currentUrl)), true) }
  url () { return this.currentUrl }
}

const harness = (caseId, options = {}) => {
  const world = {
    periods: [period('101', true), period('102')],
    facts: {}, calls: [], sql: [], artifacts: [], menus: makeMenus(), aborted: 0, ...options
  }
  for (const p of world.periods) world.facts[p.id] ||= factsFor(p)
  world.report = (p, key) => {
    const report = makeReport(p, key, world.facts[p.id])
    world.changeReport?.(report, p, key)
    return report
  }
  const read = (route) => {
    world.calls.push(route)
    if (route.startsWith('/cost/periods?')) {
      const pageNo = Number(new URL(route, settings.apiBase).searchParams.get('pageNo'))
      return { list: world.periods.slice((pageNo - 1) * 100, pageNo * 100), total: world.periods.length }
    }
    if (route === '/system/menu/list') return clone(world.menus)
    if (route === '/system/auth/get-permission-info') {
      return { menus: treeFor(world.menus.filter((row) => !world.omitPermission || row.id !== world.omitPermission)) }
    }
    const detail = route.match(/^\/cost\/periods\/(\d+)$/)
    if (detail) return clone(world.periods.find((p) => p.id === detail[1]))
    const op = route.match(/^\/cost\/periods\/(\d+)\/operating-publication$/)
    if (op) {
      const row = world.facts[op[1]].operating[0]
      return row ? { ...row, operatingExpense: row.expense, operatingProfit: row.profit } : null
    }
    const model = route.match(/^\/cost\/model-versions\/(\d+)$/)
    if (model) {
      const p = world.periods.find((row) => row.modelVersionId === model[1])
      return { id: p.modelVersionId, accountingOrgId: '1', enterpriseType: p.enterpriseType,
        versionNo: p.modelVersionNo, status: 'LOCKED', remark: 'CFOR-E2E existing fixture' }
    }
    const report = route.match(/^\/cost\/reports\/([^/]+)\/(\d+)$/)
    assert.ok(report, `Unexpected API: ${route}`)
    return clone(world.report(world.periods.find((p) => p.id === report[2]), report[1]))
  }
  const api = {
    getBusiness: async (route) => world.businessError ? { code: 500, msg: 'offline business failure' } : success(read(route)),
    request: async (method, route, body, contract) => {
      assert.equal(method, 'GET', 'Offline contract forbids mutation API')
      assert.equal(body, undefined)
      world.calls.push({ method, route, contract })
      const p = world.periods.find((row) => row.id === route.split('/').at(-1))
      return { code: world.rejectionCode ?? 422001,
        msg: world.rejectionMessage || (p.enterpriseType === 'MANUFACTURING'
          ? '商品成本表仅适用于贸易型期间' : '本期间没有有效的正式成本发布，不能查询正式报表') }
    },
    postBusiness: () => assert.fail('No creation/publish/refresh allowed'),
    putBusiness: () => assert.fail('No shared workspace/type update allowed'),
    deleteBusiness: () => assert.fail('No cleanup writes allowed')
  }
  const readSql = async (sql) => {
    world.sql.push(sql)
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|TRUNCATE)\b/i.test(sql), 'SQL must be read-only')
    if (sql.includes('system_menu')) {
      const rows = world.menus.map((row) => ['menu', JSON.stringify(row)])
      return { available: true, rows: [['total', String(world.menus.length)], ...rows] }
    }
    const match = sql.match(/FROM cost_period WHERE tenant_id = 1 AND deleted = 0 AND id = (\d+)/)
    assert.ok(match, 'SQL must precisely bind tenant and period')
    const facts = clone(world.facts[match[1]])
    world.changeFacts?.(facts)
    const rows = Object.entries(facts).flatMap(([key, data]) => [
      [`${key}-count`, String(data.length)], ...data.map((row) => [key, JSON.stringify(row)])
    ])
    world.changeSqlRows?.(rows)
    return { available: world.databaseAvailable !== false, rows }
  }
  const page = options.noPage ? null : new OfflinePage(world)
  const caseRecord = { id: caseId, checks: [], notes: [] }
  const context = { caseId, api, page, caseRecord, outputDir: '/not-written-by-offline-tests', record: {} }
  const deps = {
    settings, readSql, navigate: (page, target) => page.navigate(target),
    artifact: async (_ctx, name, evidence) => world.artifacts.push({ name, evidence: clone(evidence) })
  }
  return { world, page, caseRecord, context, deps,
    run: () => runCostFormalReportClosure(context, deps) }
}
const verified = (h, key) => h.caseRecord.costFormalReportClosure.assertions[COST_FORMAL_REPORT_CHECKS[h.caseRecord.id][key]]?.verified
const messages = (result) => [...result.evidence.gaps, ...result.evidence.failures].map((issue) => issue.message).join('\n')

test('bindings cover every original assertion with globally unique named checks', () => {
  assert.strictEqual(CHECKS, COST_FORMAL_REPORT_CHECKS)
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const cases = catalog.suites.flatMap((suite) => suite.cases)
  const names = []
  for (const [caseId, checks] of Object.entries(COST_FORMAL_REPORT_CHECKS)) {
    const original = cases.find((item) => item.id === caseId)
    assert.ok(original)
    assert.equal(Object.keys(checks).length, original.assertions.length)
    assert.deepEqual(Object.keys(COST_FORMAL_REPORT_BINDINGS[caseId]),
      original.assertions.map((_item, index) => String(index)))
    names.push(...Object.values(COST_FORMAL_REPORT_BINDINGS[caseId]).flat())
  }
  assert.equal(new Set(names).size, names.length)
})

test('035 requires positive and negative SQL/API controls and both real formal route tables', async () => {
  const h = harness('COST-035')
  const result = await h.run()
  assert.equal(result.acceptanceComplete, true, messages(result))
  assert.equal(hasCostFormalReportEvidence(h.caseRecord), true)
  assert.deepEqual(h.page.navigations, [`${paths.enterprise}?periodId=101`, `${paths.alias}?periodId=101`])
  assert.equal(h.page.guards.size, 0)
  assert.equal(h.world.artifacts.length, 2)
  assert.equal(h.world.calls.some((call) => typeof call === 'object'), false)
})

for (const caseId of ['COST-035', 'COST-038', 'COST-039']) {
  test(`${caseId} accepts only exact loopback API or Web proxy GET; rejects other origin/path/method`, async () => {
    const h = harness(caseId, { browserOrigin: settings.webBase, probeResponses: true })
    const result = await h.run()
    assert.equal(result.acceptanceComplete, true, messages(result))
    assert.equal(h.page.waiters.length, 0)
    assert.equal(h.page.guards.size, 0)
  })
}

test('same caseRecord runs once, including concurrent calls; it never duplicates reads/checks', async () => {
  const h = harness('COST-035')
  const [a, b] = await Promise.all([h.run(), h.run()])
  assert.strictEqual(a, b)
  assert.strictEqual(await h.run(), a)
  assert.equal(h.page.navigations.length, 2)
  assert.equal(h.caseRecord.checks.length, 4)
  assert.equal(h.world.sql.length, 2)
})

for (const field of ['operatingExpense', 'enterpriseFullCost', 'revenue', 'operatingProfit']) {
  test(`035 unpublished ${field}=0 is a real failure, not a passed negative control`, async () => {
    const h = harness('COST-035', {
      changeReport: (report, p) => { if (p.id === '102') report.metrics[field] = 0 }
    })
    const result = await h.run()
    assert.equal(result.acceptanceComplete, false)
    assert.equal(verified(h, 'operating'), false)
    assert.match(messages(result), /must be null/)
    assert.equal(result.evidence.failures.length, 1)
  })
}

test('035 missing operating positive is GAP and does not substitute zero or unpublished rows', async () => {
  const h = harness('COST-035', { periods: [period('102')] })
  const result = await h.run()
  assert.equal(result.acceptanceComplete, false)
  assert.ok(result.evidence.gaps.length > 0)
  assert.equal(result.evidence.failures.length, 0)
  assert.equal(h.page.navigations.length, 0)
})

test('035 missing unpublished negative stays GAP although published report and pages are valid', async () => {
  const h = harness('COST-035', { periods: [period('101', true)] })
  const result = await h.run()
  assert.equal(verified(h, 'pages'), true)
  assert.equal(result.acceptanceComplete, false)
  assert.match(messages(result), /Both frozen operating positive and unpublished negative/)
})

for (const [name, mutate] of [
  ['empty rows', (report) => { report.rows = [] }],
  ['wrong publication', (report) => { report.publicationId = '99999' }],
  ['wrong frozen amount', (report) => { report.rows[0].values.formalCost = 101 }],
  ['duplicate path', (report) => { report.rows.push(clone(report.rows[0])) }],
  ['nonformal response', (report) => { report.formal = false }]
]) {
  test(`035 ${name} cannot satisfy complete evidence`, async () => {
    const h = harness('COST-035', { changeReport: mutate })
    const result = await h.run()
    assert.equal(result.acceptanceComplete, false)
    assert.ok(result.evidence.failures.length)
  })
}

for (const [name, mutate] of [
  ['wrong period ID', (view) => { view.periodId = '999' }],
  ['wrong model ID', (view) => { view.modelId = '999' }],
  ['shared draft model', (view) => { view.modelVersion = 'E2E-LOCK-other' }],
  ['query month from another period', (view) => { view.queryMonth = '2100-03' }],
  ['still loading', (view) => { view.loaded = 'false' }],
  ['formal API load error', (view) => { view.error = '正式报表加载失败' }],
  ['preview formal flag', (view) => { view.formal = 'false' }],
  ['no table rows', (view) => { view.rows = [] }],
  ['wrong displayed money', (view) => { view.rows[0][3] = '¥0.00' }],
  ['template placeholder', (view) => { view.text = '演示数据' }]
]) {
  test(`035 real page ${name} is not replaced by URL/title-only evidence`, async () => {
    const h = harness('COST-035', { view: mutate })
    const result = await h.run()
    assert.equal(verified(h, 'pages'), false)
    assert.equal(result.acceptanceComplete, false)
    assert.ok(result.evidence.failures.length)
    assert.equal(h.world.artifacts.length, 1, 'Failed page still retains diagnostic evidence')
  })
}

test('page GET must match independent API result and explicit tenant header', async () => {
  for (const options of [
    { browserReport: (report) => { report.metrics.formalCost = 999 } },
    { browserTenant: '2' }
  ]) {
    const h = harness('COST-035', options)
    const result = await h.run()
    assert.equal(verified(h, 'pages'), false)
    assert.equal(result.acceptanceComplete, false)
  }
})

test('mutation attempted by a page is aborted, never fake-saved or counted complete', async () => {
  const h = harness('COST-035', { attemptMutation: true })
  const result = await h.run()
  assert.equal(h.world.aborted, 2)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.evidence.mutations.length, 2)
  assert.match(messages(result), /aborted, not mocked/)
  assert.equal(h.page.guards.size, 0)
})

for (const [name, options] of [
  ['unavailable SQL', { databaseAvailable: false }],
  ['truncated SQL', { changeSqlRows: (rows) => rows.splice(rows.findIndex((row) => row[0] === 'object'), 1) }],
  ['cross-tenant SQL', { changeFacts: (facts) => { facts.object[0].tenantId = '2' } }],
  ['lossy object ID', { changeFacts: (facts) => { facts.object[0].id = 9007199254740992 } }]
]) {
  test(`${name} is a failure, not an absent-data positive`, async () => {
    const h = harness('COST-035', options)
    const result = await h.run()
    assert.equal(result.acceptanceComplete, false)
    assert.ok(result.evidence.failures.length)
  })
}

test('read-only fixture rejects nonlocal or nonexplicit tenant before any API/SQL', async () => {
  for (const override of [{ target: 'prod' }, { tenantId: '' },
    { tenantId: '2' }, { apiBase: 'http://example.test:48083' }]) {
    const h = harness('COST-035')
    await assert.rejects(runCostFormalReportClosure(h.context, {
      ...h.deps, settings: { ...settings, ...override }
    }))
    assert.equal(h.world.calls.length, 0)
    assert.equal(h.world.sql.length, 0)
  }
})

test('036 manufacturing negative is exact and missing TRADE positive remains GAP', async () => {
  const h = harness('COST-036')
  const result = await h.run()
  assert.equal(verified(h, 'rejection'), true)
  assert.equal(verified(h, 'trade'), false)
  assert.equal(verified(h, 'page'), true)
  assert.equal(result.acceptanceComplete, false)
  assert.match(messages(result), /no existing legal TRADE PUBLISHED nonempty positive/)
  assert.match(messages(result), /original empty-month ownership/)
  assert.equal(h.world.calls.filter((call) => typeof call === 'object').length, 1)
})

test('036 unpublished TRADE type/publication rejection can never impersonate formal positive control', async () => {
  const h = harness('COST-036', { periods: [period('101', true), period('104', false, 'TRADE', false)] })
  const result = await h.run()
  assert.equal(verified(h, 'trade'), false)
  assert.equal(result.acceptanceComplete, false)
  assert.match(messages(result), /PUBLISHED nonempty positive/)
})

test('036 existing legal published TRADE plus unpublished negative validates API but original allocation stays GAP', async () => {
  const h = harness('COST-036', { periods: [
    period('101', true), period('103', false, 'TRADE'), period('104', false, 'TRADE', false)
  ] })
  const result = await h.run()
  assert.equal(verified(h, 'trade'), true, messages(result))
  assert.equal(verified(h, 'retained'), false)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.evidence.failures.length, 0)
  assert.deepEqual(result.remainingAssertions, [COST_FORMAL_REPORT_CHECKS['COST-036'].retained])
})

for (const options of [{ rejectionCode: 422002 }, { rejectionMessage: '企业类型不支持' }]) {
  test(`036 rejection requires exact code and trade-only message ${JSON.stringify(options)}`, async () => {
    const h = harness('COST-036', options)
    const result = await h.run()
    assert.equal(verified(h, 'rejection'), false)
    assert.ok(result.evidence.failures.length)
  })
}

test('036 manufacturing redirect dropping periodId cannot pass with another period', async () => {
  const h = harness('COST-036', { dropRedirectPeriod: true })
  const result = await h.run()
  assert.equal(verified(h, 'page'), false)
  assert.match(messages(result), /dropped the exact period/)
})

test('037 nonempty formal rows, real incomparable reasons and exact visible columns pass together', async () => {
  const h = harness('COST-037')
  const result = await h.run()
  assert.equal(result.acceptanceComplete, true, messages(result))
  assert.equal(hasCostFormalReportEvidence(h.caseRecord), true)
  assert.deepEqual(h.page.navigations, [`${paths.makeBuy}?periodId=102`])
})

test('037 eight-place zero quantity and ten-place SQL unit cost retain a real incomparable negative', async () => {
  const h = harness('COST-037', {
    changeFacts: (facts) => {
      facts.object[0].quantity = '0.00000000'
      facts.object[0].unitCost = '0.0000000000'
    },
    changeReport: (report) => {
      const row = report.rows[0].values
      row.makeCost = null
      row.difference = null
      row.notComparableReasons = `自产正式成本或完工数量缺失；${row.notComparableReasons}`
    }
  })
  const result = await h.run()
  assert.equal(result.acceptanceComplete, true, messages(result))
  assert.equal(hasCostFormalReportEvidence(h.caseRecord), true)
})

for (const [amount, quantity, cost] of [
  ['1.000000', '3.00000000', '0.333333'],
  ['1.000000', '0.00000003', '33333333.333333'],
  ['-1.000000', '3.00000000', '-0.333333'],
  ['1.000001', '2.00000000', '0.500001']
]) {
  test(`037 exact eight-place quantity ${quantity} and six-place HALF_UP result ${cost}`, async () => {
    const h = harness('COST-037', {
      changeFacts: (facts) => {
        Object.assign(facts.object[0], { amount, quantity, unitCost: `${cost}0000` })
      },
      changeReport: (report) => { report.rows[0].values.makeCost = cost }
    })
    const result = await h.run()
    assert.equal(result.acceptanceComplete, true, messages(result))
  })
}

test('037 one-millionth cost difference fails exact comparison, without Number tolerance', async () => {
  const h = harness('COST-037', {
    changeFacts: (facts) => { facts.object[0].quantity = '3.00000000'; facts.object[0].amount = '1.000000' },
    changeReport: (report) => { report.rows[0].values.makeCost = '0.333334' }
  })
  const result = await h.run()
  assert.equal(result.acceptanceComplete, false)
  assert.match(messages(result), /Frozen amount mismatch/)
})

test('036 published TRADE ten-place unit price is checked exactly, not rounded to six places', async () => {
  for (const expected of ['50.0000000001', '50.0000000002']) {
    const h = harness('COST-036', { periods: [
      period('101', true), period('103', false, 'TRADE'), period('104', false, 'TRADE', false)
    ],
    changeFacts: (facts) => { if (facts.object[0]) facts.object[0].unitCost = '50.0000000001' },
    changeReport: (report, p) => {
      if (p.id === '103' && report.reportKey === 'goods-cost') report.rows[0].values.unitCost = expected
    } })
    const result = await h.run()
    assert.equal(verified(h, 'trade'), expected === '50.0000000001', messages(result))
    assert.equal(result.acceptanceComplete, false, 'Original retained-fixture GAP is still mandatory')
  }
})

test('037 empty rows never pass vacuous every', async () => {
  const h = harness('COST-037', { changeReport: (report) => { report.rows = [] } })
  const result = await h.run()
  assert.equal(result.acceptanceComplete, false)
  assert.equal(verified(h, 'rows'), false)
  assert.equal(verified(h, 'reasons'), false)
})

test('037 independently reconciles external amounts and constraint facts; no incomparable sample is GAP', async () => {
  const h = harness('COST-037', { periods: [period('101', true)] })
  h.world.facts['101'].source = [{
    id: '7101', tenantId: '1', publicationId: '3101', objectKey: 'OBJ-101',
    sourceModule: 'ERP', sourceType: 'PURCHASE', sourceNo: 'E2E-PO-101',
    quantity: '2', amount: '90', allocatedAmount: '80',
    formula: JSON.stringify({ qualityStatus: 'QUALIFIED', deliveryStatus: 'ON_TIME', capacityLoad: 0.7 })
  }]
  const result = await h.run()
  assert.equal(verified(h, 'rows'), true, messages(result))
  assert.equal(verified(h, 'page'), true)
  assert.equal(result.acceptanceComplete, false)
  assert.match(messages(result), /actual incomparable object/)
})

for (const [name, mutate] of [
  ['missing reason', (report) => { report.rows[0].values.notComparableReasons = '' }],
  ['invented buy cost', (report) => { report.rows[0].values.buyCost = 0 }],
  ['invented conclusion', (report) => { report.rows[0].values.status = '建议自产' }]
]) {
  test(`037 ${name} fails original negative assertion`, async () => {
    const h = harness('COST-037', { changeReport: mutate })
    const result = await h.run()
    assert.equal(result.acceptanceComplete, false)
    assert.equal(verified(h, 'rows'), false)
  })
}

test('037 missing exact buy column cannot pass textual mention elsewhere', async () => {
  const h = harness('COST-037', { view: (view) => {
    view.headers[view.headers.indexOf('外购到岸成本')] = '采购价'
    view.text += '外购到岸成本'
  } })
  const result = await h.run()
  assert.equal(verified(h, 'page'), false)
  assert.equal(verified(h, 'columns'), false)
  assert.equal(result.acceptanceComplete, false)
})

test('038 full inventory, hidden placeholders, permissions, workspaces and actual quick-link clicks', async () => {
  const h = harness('COST-038')
  const result = await h.run()
  assert.equal(result.acceptanceComplete, true, messages(result))
  assert.equal(hasCostFormalReportEvidence(h.caseRecord), true)
  assert.equal(h.page.guards.size, 0)
  assert.ok(h.page.navigations.includes('/cost-management/monthly/cost-trial'))
})

test('038 a visible alias of a hidden placeholder fails even when canonical IDs are hidden', async () => {
  const h = harness('COST-038')
  h.world.menus.push({ ...h.world.menus.find((row) => row.id === '29611031'),
    id: '9900', visible: 1, path: 'leaked-trace' })
  const result = await h.run()
  assert.equal(verified(h, 'hidden'), false)
  assert.equal(result.acceptanceComplete, false)
  assert.match(messages(result), /re-exposes hidden placeholder/)
})

test('038 removed hidden record is not evidence for hide-only migration', async () => {
  const h = harness('COST-038')
  h.world.menus = h.world.menus.filter((row) => row.id !== '29611031')
  const result = await h.run()
  assert.equal(verified(h, 'hidden'), false)
  assert.match(messages(result), /retained, not deleted/)
})

test('038 correct database menu without current-user permission cannot pass', async () => {
  const h = harness('COST-038', { omitPermission: '1000' })
  const result = await h.run()
  assert.equal(verified(h, 'added'), false)
  assert.equal(result.acceptanceComplete, false)
})

test('039 all ten aliases and real formal alias page pass; no single-alias shortcut', async () => {
  const h = harness('COST-039')
  const result = await h.run()
  assert.equal(result.acceptanceComplete, true, messages(result))
  assert.equal(h.caseRecord.costFormalReportClosure.assertions[COST_FORMAL_REPORT_CHECKS['COST-039'].titles].data.length, 10)
  assert.deepEqual(h.page.navigations, [`${paths.alias}?periodId=101`])
})

test('039 optionally prefers an exact existing published period but retains independent census', async () => {
  const h = harness('COST-039', { periods: [period('101', true), period('102', true)] })
  h.context.periodId = '101'
  const result = await h.run()
  assert.equal(result.acceptanceComplete, true, messages(result))
  assert.deepEqual(h.page.navigations, [`${paths.alias}?periodId=101`])
})

for (const [name, change] of [
  ['wrong alias title', (menus) => { menus.find((row) => row.id === '2009').name = '旧比较页' }],
  ['old placeholder page key', (menus) => { menus.find((row) => row.id === '2009').component = 'cost-management/section/index?page=old-trace' }],
  ['duplicate page query', (menus) => { menus.find((row) => row.id === '2009').component += '&page=make-buy' }],
  ['disabled parent', (menus) => { menus.find((row) => row.id === '3').status = 1 }]
]) {
  test(`039 ${name} prevents complete menu proof`, async () => {
    const h = harness('COST-039')
    change(h.world.menus)
    const result = await h.run()
    assert.equal(result.acceptanceComplete, false)
    assert.ok(result.evidence.failures.length)
  })
}

test('absent page is a GAP, not permission to open another browser or count API-only PASS', async () => {
  const h = harness('COST-037', { noPage: true })
  const result = await h.run()
  assert.equal(verified(h, 'rows'), true)
  assert.equal(result.acceptanceComplete, false)
  assert.match(messages(result), /Caller ctx.page/)
})

test('business envelope errors are not treated as data/empty rows', async () => {
  const h = harness('COST-037', { businessError: true })
  const result = await h.run()
  assert.equal(result.acceptanceComplete, false)
  assert.ok(result.evidence.failures.length)
})

test('completeness rejects duplicate checks, missing fact sample and tampered post-run page', async () => {
  const h = harness('COST-037')
  assert.equal((await h.run()).acceptanceComplete, true)
  const original = clone(h.caseRecord)
  h.caseRecord.checks.push(clone(h.caseRecord.checks[0]))
  assert.equal(hasCostFormalReportEvidence(h.caseRecord), false)
  const noFacts = clone(original)
  noFacts.costFormalReportClosure.samples = []
  assert.equal(hasCostFormalReportEvidence(noFacts), false)
  const tampered = clone(original)
  tampered.costFormalReportClosure.pages[0].view.rows = []
  assert.equal(hasCostFormalReportEvidence(tampered), false)
  assert.equal(hasCostFormalReportEvidence({ id: 'COST-037', checks: original.checks }), false)
  const malformed = clone(original)
  delete malformed.costFormalReportClosure.assertions
  assert.equal(hasCostFormalReportEvidence(malformed), false)
})
