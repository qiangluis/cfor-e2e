import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { procurementCatalogEvidence, runCase } from '../suites/procurement.mjs'

const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'PROC-013')
const evidence = {
  0: ['企业侧采购工作台摘要返回 7 项非负整数待办'],
  1: ['采购工作台首页渲染 7 张待办卡片',
    '7 张待办卡片显示浏览器真实摘要响应的数值，不以默认零值结案'],
  2: ['待接单下钻请求真实携带 SENT 且页面显示筛选条件',
    '重置后清除门户筛选并重新查询全部订单']
}
const record = () => ({ checks: [], notes: [], evidence: [] })
const completeRecord = () => ({
  ...record(),
  checks: Object.values(evidence).flat().map((name) => ({
    name, passed: true, details: `unit observation: ${name}`
  }))
})

test('PROC-013 maps all three exact catalog index/text pairs to observed checks without adding checks', () => {
  assert.deepEqual(definition.assertions, [
    '/erp/purchase/workbench/summary 返回 7 项非负整数待办计数',
    '采购首页渲染待审请购/待审订单/待接单/待收货/待对账/待开票复核/待付款 7 张待办卡片',
    '点击待接单卡片下钻到采购订单列表'
  ])
  const caseRecord = completeRecord()
  const before = structuredClone(caseRecord.checks)
  procurementCatalogEvidence('PROC-013', caseRecord, evidence)
  assert.deepEqual(caseRecord.checks, before)
  assert.deepEqual(caseRecord.catalogAssertions.map(({ index, assertion, status, evidenceChecks }) =>
    ({ index, assertion, status, evidenceChecks })), definition.assertions.map((assertion, index) => ({
    index, assertion, status: 'VERIFIED', evidenceChecks: evidence[index]
  })))
  assert.deepEqual(caseRecord.remainingAssertions, [])
  assert.equal(caseRecord.passCandidate, true)
})

test('PROC-013 every missing, failed or non-boolean required check produces its exact catalog GAP', () => {
  for (const [index, names] of Object.entries(evidence)) {
    for (const name of names) {
      for (const passed of [undefined, false, 'true', 1, null, 'missing']) {
        const caseRecord = completeRecord()
        if (passed === 'missing') caseRecord.checks = caseRecord.checks.filter((item) => item.name !== name)
        else caseRecord.checks.find((item) => item.name === name).passed = passed
        procurementCatalogEvidence('PROC-013', caseRecord, evidence)
        assert.equal(caseRecord.catalogAssertions[Number(index)].status, 'GAP', name)
        assert.deepEqual(caseRecord.remainingAssertions, [definition.assertions[Number(index)]])
        assert.equal(caseRecord.passCandidate, false)
      }
    }
  }
})

test('PROC-013 duplicate named checks are GAP regardless of ordering or individual passed values', () => {
  for (const [index, names] of Object.entries(evidence)) {
    for (const name of names) {
      for (const passed of [true, false, 'true']) {
        for (const first of [true, false]) {
          const caseRecord = completeRecord()
          const duplicate = { name, passed }
          if (first) caseRecord.checks.unshift(duplicate)
          else caseRecord.checks.push(duplicate)
          procurementCatalogEvidence('PROC-013', caseRecord, evidence)
          assert.equal(caseRecord.catalogAssertions[Number(index)].status, 'GAP')
          assert.equal(caseRecord.passCandidate, false)
        }
      }
    }
  }
})

test('PROC-013 missing mappings or repeated check references never verify an assertion', () => {
  for (const index of [0, 1, 2]) {
    for (const names of [undefined, [], [evidence[index][0], evidence[index][0]]]) {
      const caseRecord = completeRecord()
      procurementCatalogEvidence('PROC-013', caseRecord, { ...evidence, [index]: names })
      assert.equal(caseRecord.catalogAssertions[index].status, 'GAP')
      assert.deepEqual(caseRecord.remainingAssertions, [definition.assertions[index]])
      assert.equal(caseRecord.passCandidate, false)
    }
  }
})

const summary = {
  pendingRequestCount: 7,
  pendingOrderCount: 6,
  pendingPortalAcceptanceCount: 5,
  pendingReceiptCount: 4,
  pendingReconciliationCount: 3,
  pendingInvoiceReviewCount: 2,
  pendingPaymentRequestCount: 1
}
const titles = ['待审请购', '待审订单', '待接单', '待收货', '待对账', '待开票复核', '待付款']

async function workbenchHarness ({
  counts = summary,
  cardValues = Object.values(summary).map(String),
  pageTitles = titles,
  acceptanceRows = [{ portalStatus: 'SENT' }],
  resetCode = 0,
  retainPortalFilter = false
} = {}) {
  const caseRecord = record()
  const events = []
  let currentUrl = 'http://127.0.0.1:9151/'
  let portalText = '门户状态 待接单'
  const responses = [
    ['/erp/purchase/workbench/summary', { code: 0, data: summary }],
    ['/erp/purchase-order/page?portalStatus=SENT', { code: 0, data: { list: acceptanceRows } }],
    ['/erp/purchase-order/page', { code: resetCode, data: { list: [] } }]
  ]
  const visibleLocator = {
    first () { return this },
    nth () { return this },
    last () { return this },
    async waitFor () {},
    async scrollIntoViewIfNeeded () {},
    async isVisible () { return true },
    async click () {}
  }
  const page = {
    url: () => currentUrl,
    keyboard: { async press (key) { events.push(`key:${key}`) } },
    async waitForResponse (predicate) {
      const [route, payload] = responses.shift()
      const response = {
        url: () => `http://127.0.0.1:48083/admin-api${route}`,
        request: () => ({ method: () => 'GET' }),
        headers: () => ({}),
        text: async () => JSON.stringify(payload)
      }
      assert.equal(predicate(response), true, `response predicate: ${route}`)
      events.push(`response:${route}`)
      return response
    },
    async waitForURL (pattern) { assert.match(currentUrl, pattern) },
    async waitForFunction (_predicate, expected) {
      assert.deepEqual(expected, Object.values(summary))
      events.push('wait-for-seven-observed-values')
    },
    locator (selector) {
      if (selector === '.p_workbench_card .p_workbench_value') return {
        async allInnerTexts () { return cardValues }
      }
      if (selector === '.p_workbench_card') return {
        ...visibleLocator,
        async allInnerTexts () { return pageTitles.map((title, index) => `${title}\n${cardValues[index]}`) },
        filter ({ hasText }) {
          assert.equal(hasText, '待接单')
          return { ...visibleLocator, async click () {
            events.push('click-acceptance')
            currentUrl = 'http://127.0.0.1:9151/erp/purchase/order?portalStatus=SENT'
          } }
        }
      }
      if (selector === '.el-form-item') return {
        filter ({ hasText }) {
          assert.equal(hasText, '门户状态')
          return { ...visibleLocator, async innerText () { return portalText } }
        }
      }
      assert.ok(['.p_workbench', '.cardBox .paramsBox .el-select',
        '.el-select-dropdown:visible'].includes(selector), selector)
      return visibleLocator
    },
    getByRole (role, options) {
      assert.equal(role, 'button')
      assert.deepEqual(options, { name: '重置', exact: true })
      return { async click () {
        events.push('click-reset')
        if (!retainPortalFilter) portalText = '门户状态'
      } }
    }
  }
  const api = {
    async getBusiness (route) {
      assert.equal(route, '/erp/purchase/workbench/summary')
      events.push(`GET:${route}`)
      return { code: 0, data: counts }
    }
  }
  const result = await runCase({
    caseId: 'PROC-013', page, caseRecord, record: {}, outputDir: '/unit-only'
  }, {
    login: async () => 'unit-token',
    createApiClient: () => api,
    openRoute: async (_page, route) => {
      assert.equal(route, '/erp/purchase/home')
      currentUrl = `http://127.0.0.1:9151${route}`
    },
    collectPagePerformance: async () => ({ unitOnly: true }),
    saveScreenshot: async (_page, _dir, name) => { events.push(`screenshot:${name}`) }
  })
  assert.equal(responses.length, 0)
  return { caseRecord, result, events }
}

test('PROC-013 actual read-only branch records exact mapping after seven values, SENT drilldown and reset', async () => {
  const { caseRecord, result, events } = await workbenchHarness()
  assert.equal(result.partial, false)
  assert.equal(caseRecord.passCandidate, true)
  assert.ok(caseRecord.checks.every((check) => check.passed === true))
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.evidenceChecks), Object.values(evidence))
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.assertion), definition.assertions)
  assert.ok(events.indexOf('wait-for-seven-observed-values') < events.indexOf('click-acceptance'))
  assert.ok(events.indexOf('click-acceptance') < events.indexOf('click-reset'))
})

test('PROC-013 actual branch permits the catalog empty-set precondition without inventing SENT rows', async () => {
  const { caseRecord, result } = await workbenchHarness({ acceptanceRows: [] })
  assert.equal(result.partial, false)
  assert.match(caseRecord.checks.find((check) => check.name === evidence[2][0]).details, /orders=0/)
})

test('PROC-013 actual branch keeps invalid counts, missing cards, mismatches, bad SENT rows and reset failures GAP/PARTIAL', async () => {
  for (const [options, index] of [
    [{ counts: { ...summary, pendingRequestCount: -1 } }, 0],
    [{ counts: { ...summary, pendingOrderCount: '6' } }, 0],
    [{ pageTitles: titles.slice(1) }, 1],
    [{ pageTitles: [...titles].reverse() }, 1],
    [{ cardValues: ['0', '0', '0', '0', '0', '0', '0'] }, 1],
    [{ cardValues: Object.values(summary).slice(1).map(String) }, 1],
    [{ acceptanceRows: [{ portalStatus: 'ACCEPTED' }] }, 2],
    [{ acceptanceRows: null }, 2],
    [{ resetCode: 500 }, 2],
    [{ retainPortalFilter: true }, 2]
  ]) {
    const { caseRecord, result } = await workbenchHarness(options)
    assert.equal(result.partial, true)
    assert.equal(caseRecord.passCandidate, false)
    assert.equal(caseRecord.catalogAssertions[index].status, 'GAP')
    assert.deepEqual(caseRecord.remainingAssertions, [definition.assertions[index]])
  }
})
