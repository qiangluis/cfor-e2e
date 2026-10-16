import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { config, environmentSummary } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { launchBrowser, login, saveScreenshot } from '../lib/browser.mjs'
import { reportSnapshot } from '../lib/report.mjs'
import { costCatalogEvidence } from '../suites/cost.mjs'
import {
  COST_OPERATING_CHECKS,
  costOperatingRequestId,
  inspectOperatingExpenseFacts,
  inspectOperatingPublication,
  readOperatingSql,
  runCostOperatingClosure,
  verifyOperatingPage
} from '../fixtures/cost-operating-closure.mjs'

const pageEvidenceHarness = (t, caseId = 'COST-005', failure = '') => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-cost-operating-page-'))
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  const outputDir = path.join(tempDir, 'new-run', 'screenshots')
  const fixture = { caseId, periodId: '601', suffix: 'OWNED-PAGE' }
  const readySelector = `.operating-collection-workspace[data-period-id="${fixture.periodId}"][data-loaded="true"]`
  const text = `经营收入 CFOR-E2E-${caseId}-${fixture.suffix} 2000`
  const caseRecord = { checks: [], evidence: [] }
  const listeners = new Map()
  const screenshotError = new Error('unit screenshot failed')
  const navigationError = new Error('unit navigation failed')
  const page = {
    on: (event, listener) => listeners.set(event, listener),
    off: (event, listener) => {
      assert.equal(listeners.get(event), listener)
      listeners.delete(event)
    },
    locator: (selector) => {
      assert.equal(selector, readySelector)
      return {
        waitFor: async () => {},
        getAttribute: async (name) => name === 'data-period-id' ? fixture.periodId : 'true',
        innerText: async () => text
      }
    }
  }
  const dependencies = {
    openRoute: async (currentPage, route, options) => {
      assert.equal(currentPage, page)
      assert.equal(route, `/cost-management/monthly/operating-income-expense?periodId=${fixture.periodId}`)
      assert.equal(options.readySelector, readySelector)
      assert.equal(fs.statSync(outputDir).isDirectory(), true)
      listeners.get('request')({
        url: () => `http://127.0.0.1:48083/admin-api/cost/periods/${fixture.periodId}/operating-collections?direction=INCOME`,
        method: () => 'GET'
      })
      if (failure === 'navigation') throw navigationError
    },
    saveScreenshot: async (currentPage, dir, name) => {
      assert.equal(currentPage, page)
      assert.equal(dir, outputDir)
      assert.equal(name, `${caseId.toLowerCase()}-operating-closure`)
      assert.equal(fs.readFileSync(path.join(dir, `${caseId.toLowerCase()}-operating-page.txt`), 'utf8'), text)
      if (failure === 'screenshot') throw screenshotError
    }
  }
  return {
    context: { page, fixture, outputDir, record: {}, caseRecord },
    dependencies, listeners, text, screenshotError, navigationError
  }
}

for (const caseId of ['COST-005', 'COST-008']) {
  test(`${caseId} page evidence creates a fresh screenshot directory before writing text`, async (t) => {
    const h = pageEvidenceHarness(t, caseId)
    assert.equal(fs.existsSync(h.context.outputDir), false)
    const proof = await verifyOperatingPage(h.context, h.dependencies)
    assert.equal(proof.passed, true)
    assert.equal(proof.observation.markerVisible, true)
    assert.equal(proof.observation.renderedPeriodId, h.context.fixture.periodId)
    assert.equal(proof.observation.loaded, 'true')
    assert.equal(proof.observation.formalRequests.length, 1)
    assert.equal(fs.readFileSync(path.join(h.context.outputDir,
      `${caseId.toLowerCase()}-operating-page.txt`), 'utf8'), h.text)
    assert.equal(h.listeners.size, 0)
  })
}

test('operating page waits for the owned period to finish async loading before recording text', async (t) => {
  const h = pageEvidenceHarness(t)
  let releaseLoaded
  const loaded = new Promise((resolve) => { releaseLoaded = resolve })
  const attrs = { 'data-period-id': '600', 'data-loaded': 'false' }
  let textReads = 0
  h.context.page.locator = (selector) => {
    assert.equal(selector,
      '.operating-collection-workspace[data-period-id="601"][data-loaded="true"]')
    return {
      waitFor: async () => {
        await loaded
        assert.equal(attrs['data-period-id'], '601')
        assert.equal(attrs['data-loaded'], 'true')
      },
      getAttribute: async (name) => attrs[name],
      innerText: async () => {
        textReads++
        return h.text
      }
    }
  }
  const verifying = verifyOperatingPage(h.context, h.dependencies)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textReads, 0, 'A visible root for another period must not be snapshotted')
  attrs['data-period-id'] = '601'
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textReads, 0, 'The owned period must also report loaded=true')
  attrs['data-loaded'] = 'true'
  releaseLoaded()
  const proof = await verifying
  assert.equal(proof.passed, true)
  assert.equal(textReads, 1)
  assert.equal(h.listeners.size, 0)
})

test('operating page readiness cannot replace the real GET and fixture marker evidence', async (t) => {
  for (const missing of ['request', 'marker']) {
    const h = pageEvidenceHarness(t)
    if (missing === 'request') {
      const openRoute = h.dependencies.openRoute
      h.dependencies.openRoute = async (...args) => {
        const listener = h.listeners.get('request')
        h.listeners.set('request', () => {})
        try { await openRoute(...args) } finally { h.listeners.set('request', listener) }
      }
    } else {
      const locator = h.context.page.locator
      h.context.page.locator = (selector) => ({
        ...locator(selector), innerText: async () => '本期暂无经营来源'
      })
      h.dependencies.saveScreenshot = async () => {}
    }
    const proof = await verifyOperatingPage(h.context, h.dependencies)
    assert.equal(proof.passed, false, missing)
    assert.equal(h.listeners.size, 0)
  }
})

for (const failure of ['navigation', 'screenshot']) {
  test(`operating ${failure} failure preserves evidence and removes its request listener`, async (t) => {
    const h = pageEvidenceHarness(t, 'COST-005', failure)
    const expectedError = failure === 'navigation' ? h.navigationError : h.screenshotError
    await assert.rejects(() => verifyOperatingPage(h.context, h.dependencies),
      (error) => error === expectedError)
    assert.equal(h.listeners.size, 0)
    const failedChecks = h.context.caseRecord.checks
      .filter((check) => check.name === COST_OPERATING_CHECKS.page)
    assert.equal(failedChecks.length, 1)
    assert.equal(failedChecks[0].passed, false)
    const observation = JSON.parse(failedChecks[0].details)
    assert.equal(observation.periodId, h.context.fixture.periodId)
    assert.equal(observation.error, expectedError.message)
    assert.equal(observation.formalRequests.length, 1)
    assert.ok(h.context.caseRecord.evidence.some((entry) => entry.includes(expectedError.message)))
    const textPath = path.join(h.context.outputDir, 'cost-005-operating-page.txt')
    if (failure === 'screenshot') {
      assert.equal(fs.readFileSync(textPath, 'utf8'), h.text)
      assert.ok(h.context.caseRecord.evidence.some((entry) => entry.startsWith('经营页面观察：')))
    } else {
      assert.equal(fs.existsSync(textPath), false, 'Navigation failure must not fabricate page text')
    }
  })
}

const validPublication = () => ({
  id: '701',
  periodId: '601',
  costPublicationId: '501',
  status: 'PUBLISHED',
  rows: [{
    itemCode: 'OPERATING_EXPENSE',
    itemName: '办公室租金',
    direction: 'EXPENSE',
    reportScope: '管理费用',
    affectsProfit: true,
    amount: 200,
    allocationBasis: 'MANUAL:200|测试'
  }]
})

test('operating publication inspection rejects empty facts and invalid basis but excludes sales cost', () => {
  const empty = inspectOperatingPublication({ ...validPublication(), rows: [] })
  assert.equal(empty.valid, false)
  assert.match(empty.invalid.join('|'), /正式经营对象事实为空/)

  const invalidBasis = inspectOperatingExpenseFacts({
    ...validPublication(),
    rows: [{ ...validPublication().rows[0], allocationBasis: 'MANUAL:0|测试' }]
  })
  assert.equal(invalidBasis.valid, false)
  assert.match(invalidBasis.invalid.join('|'), /分摊依据不是有效正数/)

  const salesCost = inspectOperatingExpenseFacts({
    ...validPublication(),
    rows: [
      validPublication().rows[0],
      {
        ...validPublication().rows[0],
        itemCode: 'SALES_COST',
        itemName: '销售成本',
        reportScope: '销售成本',
        allocationBasis: null
      }
    ]
  })
  assert.equal(salesCost.valid, true)
  assert.equal(salesCost.expenseRows.length, 1)
  assert.equal(salesCost.expenseRows[0].itemCode, 'OPERATING_EXPENSE')
  for (const basis of ['', 'MANUAL:NaN', 'AREA:Infinity', 'REVENUE:-1', 'HEADCOUNT:0']) {
    assert.equal(inspectOperatingExpenseFacts({
      ...validPublication(),
      rows: [{ ...validPublication().rows[0], allocationBasis: basis }]
    }).valid, false, `${basis} must not count as a positive finite basis`)
  }
})

test('operating publication inspection never certifies an empty-list every predicate', () => {
  const inspected = inspectOperatingPublication({ ...validPublication(), rows: [] })
  assert.equal(inspected.rows.length, 0)
  assert.equal(inspected.valid, false)
})

test('operating request IDs fit the 64-character audit boundary and isolate cases, periods and actions', () => {
  const input = {
    caseId: 'COST-005', runId: 'cost-operating-20261015090442043-56757',
    periodId: '184', action: 'publish-before-confirm'
  }
  const id = costOperatingRequestId(input)
  assert.ok(id.length <= 64)
  assert.equal(id, costOperatingRequestId({ ...input }))
  const variants = [
    {}, { caseId: 'COST-008' }, { periodId: '185' },
    { runId: `${input.runId}-again` }, { action: 'publish' },
    { action: 'calculate' }, { action: 'rollback' },
    { action: 'collection-confirm-EXPENSE-before' },
    { action: 'collection-confirm-EXPENSE-after' }
  ].map((variant) => costOperatingRequestId({ ...input, ...variant }))
  assert.equal(new Set(variants).size, variants.length)
  assert.ok(variants.every((value) => value.length <= 64))
  assert.throws(() => costOperatingRequestId({ ...input, caseId: 'COST-012' }), /授权范围/)
  assert.throws(() => costOperatingRequestId({ ...input, periodId: 'unsafe-id' }), /精确/)
})

test('database proof distinguishes PUBLISHED and ROLLED_BACK and rejects missing source facts', async () => {
  const fixture = { periodId: '601', operatingPublicationId: '701', publicationId: '501' }
  const expectedRows = [
    { direction: 'INCOME', itemCode: 'IN', reportScope: '营业收入', sourceNo: 'owned-in', amount: 2000 },
    { direction: 'EXPENSE', itemCode: 'EX', reportScope: '管理费用', sourceNo: 'owned-ex',
      amount: 200, allocationBasis: 'MANUAL:200|owned' }
  ]
  const rows = (status) => [
    ['period', '601', '2213-06', 'COST_PUBLISHED', '4', '501',
      status === 'PUBLISHED' ? '701' : 'NULL'],
    ['collection', 'INCOME', 'CONFIRMED', '21', '1', '1', '2000', 'in-hash'],
    ['collection', 'EXPENSE', 'CONFIRMED', '22', '1', '1', '200', 'ex-hash'],
    ['publication', '701', status, '601', '501', 'hash', '2000', '0', '200', '1800', '1', '2', '2'],
    ['fact', 'INCOME', 'IN', '营业收入', 'owned-in', '2000', 'NULL', 'fact-hash1'],
    ['fact', 'EXPENSE', 'EX', '管理费用', 'owned-ex', '200', 'MANUAL:200|owned', 'fact-hash2']
  ]
  const args = { fixture, caseRecord: { database: [] }, expectedRows,
    expectedAmounts: { revenue: 2000, salesCost: 0, operatingExpense: 200, operatingProfit: 1800 } }
  for (const status of ['PUBLISHED', 'ROLLED_BACK']) {
    const proof = await readOperatingSql({
      ...args, expectedStatus: status,
      readSql: async () => ({ available: true, rows: rows(status) })
    })
    assert.equal(proof.factRows.length, 2)
    assert.equal(proof.publicationRows[0][2], status)
  }
  await assert.rejects(() => readOperatingSql({
    ...args, readSql: async () => ({ available: true, rows: rows('ROLLED_BACK') })
  }), /绑定|主从/)
  await assert.rejects(() => readOperatingSql({
    ...args, readSql: async () => ({ available: true,
      rows: rows('PUBLISHED').filter((row) => row[0] !== 'fact') })
  }), /主从/)
  await assert.rejects(() => readOperatingSql({
    ...args, readSql: async () => ({ available: true, rows: rows('PUBLISHED')
      .map((row) => row[0] === 'fact' ? [...row.slice(0, 4), 'wrong-source', ...row.slice(5)] : row) })
  }), /原始来源/)
})

test('COST-005 and COST-008 continuous headed closure uses one logged-in browser session', {
  skip: process.env.CFOR_E2E_REAL_COST_OPERATING !== 'true'
}, async () => {
  assert.equal(config.target, 'local')
  assert.equal(String(config.tenantId), '1')
  assert.equal(process.env.CFOR_E2E_WRITE_FIXTURES, 'true')
  assert.ok(config.password, '缺少本地管理员凭据，不能执行真实经营闭环')

  const record = {
    runId: `cost-operating-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`,
    environment: environmentSummary(),
    screenshots: [],
    api: [],
    consoleErrors: [],
    pageErrors: [],
    failedApiResponses: [],
    requestFailures: []
  }
  const handle = await launchBrowser({ headed: true, record })
  const cases = []
  const outputDir = path.join(config.outputRoot, 'cost-operating-closure', record.runId)
  fs.mkdirSync(outputDir, { recursive: true })
  try {
    const loginContext = await login(handle.page, {
      returnContext: true,
      dumpDir: outputDir
    })
    const api = createApiClient({ token: loginContext.token, record })
    for (const caseId of ['COST-005', 'COST-008']) {
      const caseRecord = {
        id: caseId,
        caseId,
        suite: 'cost',
        status: 'RUNNING',
        checks: [],
        evidence: [],
        notes: [],
        database: [],
        fixtures: {}
      }
      try {
        const result = await runCostOperatingClosure({
          api,
          page: handle.page,
          record,
          caseRecord,
          outputDir,
          shotDir: outputDir
        })
        caseRecord.status = result.acceptanceComplete ? 'PASS' : 'PARTIAL'
        caseRecord.note = result.note
      } catch (error) {
        caseRecord.status = String(error.message || error).startsWith('BLOCKED:')
          ? 'BLOCKED'
          : 'FAIL'
        caseRecord.notes.push(String(error.message || error))
      }
      costCatalogEvidence(caseId, caseRecord)
      cases.push(caseRecord)
      fs.writeFileSync(path.join(outputDir, `${caseId.toLowerCase()}.json`),
        `${JSON.stringify(reportSnapshot(caseRecord), null, 2)}\n`, { mode: 0o600 })
    }
  } finally {
    await handle.flushResponses().catch((error) => record.pageErrors.push(error.message))
    await saveScreenshot(handle.page, outputDir, 'cost-operating-final', record).catch(() => {})
    await handle.context.close().catch(() => {})
    await handle.browser.close().catch(() => {})
  }

  const snapshot = reportSnapshot({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: record.runId,
    environment: record.environment,
    session: { loggedInOnce: true, cases: ['COST-005', 'COST-008'] },
    api: record.api,
    screenshots: record.screenshots,
    consoleErrors: record.consoleErrors,
    pageErrors: record.pageErrors,
    failedApiResponses: record.failedApiResponses,
    requestFailures: record.requestFailures,
    deferredCases: [{
      id: 'COST-012',
      status: 'PENDING_CONFIRMATION',
      reason: 'tenant1为MANUFACTURING生产型企业；现有采购报表夹具需发布PURCHASE_RECEIPT采购来源，' +
        '被生产试算门禁“采购成本不能直接等于生产材料成本”正确拒绝。' +
        '需用户确认独立贸易型测试租户或符合既有生产口径的正式采购成本发布链；' +
        '本轮不改tenant1企业类型、会计口径，不绕过来源校验，不执行COST-012写侧。'
    }],
    cases
  })
  const reportPath = path.join(outputDir, 'result.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  console.log(`[cost-operating] report=${reportPath}`)
  assert.equal(cases.length, 2)
  assert.ok(cases.every((item) =>
    item.status === 'PASS' || item.status === 'PARTIAL',
  ), `经营闭环异常：${cases.map((item) => `${item.id}:${item.status}`).join(', ')}`)
  assert.ok(cases.every((item) =>
    item.checks.some((check) => check.name === COST_OPERATING_CHECKS.collections && check.passed)
  ), 'COST-005/008至少一个正式经营归集闭环未完成')
  assert.equal(record.pageErrors.length, 0, '浏览器页面运行异常不能被PARTIAL掩盖')
  assert.equal(record.failedApiResponses.length, 0, '浏览器API错误不能被PARTIAL掩盖')
  assert.equal(record.requestFailures.length, 0, '浏览器请求错误不能被PARTIAL掩盖')
  const periods = cases.map((item) => item.fixtures.costScenario?.periodId)
  assert.equal(new Set(periods).size, 2, '两个案例不能复用同一专属期间')
})
