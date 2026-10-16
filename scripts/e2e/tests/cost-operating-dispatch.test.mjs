import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import {
  costCatalogBindings, costCatalogEvidence, protectSharedCostWorkspace, runCase
} from '../suites/cost.mjs'
import {
  COST_OPERATING_CHECKS, hasCostOperatingEvidence, runCostOperatingClosure
} from '../fixtures/cost-operating-closure.mjs'

const definitions = JSON.parse(fs.readFileSync(
  new URL('../cases/catalog.json', import.meta.url), 'utf8'
)).suites.flatMap((suite) => suite.cases)
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = (value) => structuredClone(value)
const response = (data) => ({ code: 0, data: clone(data) })
const settings = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083', apiUrl: 'http://127.0.0.1:48083/admin-api',
  webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const unitPage = () => ({
  registrations: 0,
  async route (pattern, handler) {
    assert.equal(pattern, '**/cost/workspace-states/save')
    this.registrations++
    this.handler = handler
  }
})

// In-memory API/SQL doubles exercise the real closure, not a replacement
// closure. No network, browser, SQL process, or business persistence is used.
const harness = (caseId, options = {}) => {
  const record = options.record || { runId: 'unit-operating', environment: { tenantId: '1' } }
  const page = options.page || unitPage()
  const caseRecord = { id: caseId, caseId, checks: [], evidence: [], notes: [], fixtures: {}, database: [] }
  const steps = []
  const calls = []
  const periodId = caseId === 'COST-005' ? '601' : '602'
  const fixture = {
    scenario: 'published', caseId, tenantId: '1', runId: record.runId,
    suffix: caseId === 'COST-005' ? 'UNIT005' : 'UNIT008', month: '2213-06',
    periodId, modelId: caseId === 'COST-005' ? '401' : '402', publicationId: '501'
  }
  fixture.remark = `CFOR-E2E:costScenario:published:${fixture.runId}:${fixture.suffix}:tenant=1:org=1:month=${fixture.month}`
  const period = {
    id: periodId, period: fixture.month, status: 'COST_PUBLISHED', version: 4,
    currentPublicationId: fixture.publicationId, currentOperatingPublicationId: null
  }
  const collections = new Map()
  const publications = new Map()
  let calculation
  let nextId = 700
  const root = `/cost/periods/${periodId}`
  const collect = (method, path) => {
    calls.push({ method, path })
    assert.doesNotMatch(path, /workspace-states|model-versions|accountingOrgId=/,
      'The owned dispatch must not fall through to generic/shared discovery')
  }
  const getBusiness = async (path) => {
    collect('GET', path)
    if (path === root) return response(period)
    if (path === `/cost/publications/${fixture.publicationId}/trace`) return response({
      publicationId: fixture.publicationId, status: 'PUBLISHED', resultHash: hash('cost')
    })
    if (path === `${root}/operating-calculation`) {
      if (options.failedApi) return { code: 500, msg: 'unit operating API failure' }
      return response(calculation)
    }
    if (path === `${root}/operating-publication`) {
      return response(publications.get(period.currentOperatingPublicationId) || null)
    }
    if (path.startsWith(`${root}/operating-collections?direction=`)) {
      const direction = new URL(path, settings.apiBase).searchParams.get('direction')
      const collection = collections.get(direction) || null
      return response(options.emptyCollection && collection ? { ...collection, rows: [] } : collection)
    }
    assert.fail(`Unexpected offline GET: ${path}`)
  }
  const request = async (method, path, body, requestOptions) => {
    collect(method, path)
    assert.equal(method, 'POST')
    assert.ok(requestOptions.headers['X-Request-Id'])
    assert.ok(requestOptions.headers['X-Input-Hash'])
    assert.equal(requestOptions.headers['If-Match'], '4')
    if (path === `/cost/operating-calculations/${calculation.id}/confirm`) {
      calculation.status = 'CONFIRMED'
      calculation.confirmedBy = '22'
      return response({ ...period, periodId })
    }
    if (path === `${root}/operating-publications`) {
      if (calculation.status !== 'CONFIRMED') {
        return { code: 422001, msg: '只有已确认经营计算可以发布' }
      }
      if (calculation.rows.some((row) => row.allocationBasis?.startsWith('MANUAL:0|'))) {
        return { code: 422001, msg: '经营发布缺少有效分摊基数：办公室租金' }
      }
      calculation.status = 'PUBLISHED'
      calculation.publishedBy = '22'
      period.currentOperatingPublicationId = calculation.id
      return response(calculation)
    }
    assert.fail(`Unexpected offline reviewer POST: ${path}`)
  }
  const postBusiness = async (path, body, requestOptions) => {
    collect('POST', path)
    if (path === '/system/auth/logout') return response(true)
    if ([`${root}/operating-income-sources/refresh`, `${root}/operating-expense-sources/refresh`].includes(path)) {
      return response({
        periodId, direction: path.includes('income') ? 'INCOME' : 'EXPENSE',
        status: 'DRAFT', rowCount: 0, rows: []
      })
    }
    assert.ok(requestOptions?.headers['X-Request-Id'])
    if (path === `${root}/operating-collections/confirm`) {
      const id = String(++nextId)
      collections.set(body.direction, {
        id, periodId, direction: body.direction, status: 'CONFIRMED', confirmedBy: '11',
        rows: clone(body.rows), rowCount: body.rows.length,
        totalAmount: body.rows.reduce((sum, row) => sum + row.amount, 0),
        snapshotHash: hash(body.rows)
      })
      return response({ ...period, periodId })
    }
    if (path === `${root}/operating-calculation`) {
      const rows = [...collections.values()].flatMap((collection) => clone(collection.rows))
      const revenue = rows.filter((row) => row.direction === 'INCOME')
        .reduce((sum, row) => sum + row.amount, 0)
      const salesCost = rows.filter((row) => row.reportScope === '销售成本')
        .reduce((sum, row) => sum + row.amount, 0)
      const operatingExpense = rows.filter((row) => row.direction === 'EXPENSE' && row.reportScope !== '销售成本')
        .reduce((sum, row) => sum + row.amount, 0)
      calculation = {
        id: String(++nextId), periodId, costPublicationId: fixture.publicationId,
        status: 'CALCULATED', rows, resultHash: hash(rows), revenue, salesCost,
        operatingExpense, operatingProfit: revenue - salesCost - operatingExpense
      }
      publications.set(calculation.id, calculation)
      return response(calculation)
    }
    if (path === `${root}/operating-collections/EXPENSE/rollback`) {
      assert.ok(body.reason)
      collections.delete('EXPENSE')
      return response({ ...period, periodId })
    }
    if (path === `/cost/operating-publications/${calculation.id}/rollback`) {
      assert.ok(body.reason)
      calculation.status = 'ROLLED_BACK'
      period.currentOperatingPublicationId = null
      return response(period)
    }
    assert.fail(`Unexpected offline POST: ${path}`)
  }
  const api = { getBusiness, postBusiness }
  const reviewer = {
    userId: '22',
    api: {
      request,
      postBusiness: (path, body, requestOptions) => path === '/system/auth/logout'
        ? postBusiness(path, body, requestOptions)
        : request('POST', path, body, requestOptions)
    }
  }
  const readSql = async (sql) => {
    steps.push('sql')
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE)\b/i)
    assert.match(sql, /tenant_id=1/)
    if (options.missingSql) return { available: true, rows: [] }
    if (sql.includes('SELECT CAST(id AS CHAR), status, CAST(calculated_by AS CHAR)')) {
      return { available: true, rows: [[calculation.id, calculation.status, '11', '22',
        calculation.publishedBy || 'NULL']] }
    }
    const periodRow = ['period', periodId, fixture.month, period.status, String(period.version),
      fixture.publicationId, period.currentOperatingPublicationId || 'NULL']
    if (!sql.includes('FROM cost_operating_collection')) {
      return { available: true, rows: [
        periodRow,
        ['publication', calculation.id, calculation.status, calculation.resultHash, '22', 'NULL'],
        ...calculation.rows.map((row, index) => ['fact', String(index + 1), hash(row)])
      ] }
    }
    return { available: true, rows: [
      periodRow,
      ...[...collections.values()].map((row) => [
        'collection', row.direction, row.status, row.id, row.confirmedBy,
        String(row.rowCount), String(row.totalAmount), row.snapshotHash
      ]),
      ['publication', calculation.id, calculation.status, periodId, fixture.publicationId,
        calculation.resultHash, ...['revenue', 'salesCost', 'operatingExpense', 'operatingProfit']
          .map((key) => String(calculation[key])), '11', '22', '22'],
      ...calculation.rows.map((row) => [
        'fact', row.direction, row.itemCode, row.reportScope, row.sourceNo,
        String(row.amount), row.allocationBasis ?? 'NULL', hash(row)
      ])
    ] }
  }
  const dependencies = {
    writeFixtures: true,
    login: async () => assert.fail('The existing ctx token must not be replaced by another login'),
    createApiClient: (input) => {
      assert.equal(input.token, 'unit-existing-session')
      assert.equal(input.record, record)
      return api
    },
    prepareCostScenario: async () => assert.fail('Generic scenario must not execute'),
    runCostOperatingClosure: async (context, deps) => {
      steps.push('closure')
      assert.equal(context.page, page)
      assert.equal(context.token, 'unit-existing-session')
      assert.equal(context.api, api)
      assert.equal(context.caseRecord, caseRecord)
      assert.equal(context.record, record)
      return runCostOperatingClosure(context, deps)
    },
    costOperatingDependencies: {
      settings,
      assertLocalWriteSafety: async () => { steps.push('safety') },
      prepareCostScenario: async (input) => {
        steps.push('prepare')
        assert.equal(input.scenario, 'published')
        assert.equal(input.api, api)
        caseRecord.fixtures.costScenario = fixture
        return fixture
      },
      createOperatingReviewer: async () => reviewer,
      readSql,
      verifyPage: async (context) => {
        steps.push('page')
        assert.equal(context.page, page)
        assert.equal(context.fixture, fixture)
        if (options.pageFailure) throw options.pageFailure
        if (options.sharedSave) {
          await page.handler({
            request: () => ({ method: () => 'PUT' }),
            abort: async (reason) => { assert.equal(reason, 'blockedbyclient'); steps.push('abort') },
            continue: () => assert.fail('Shared writes must not reach the backend'),
            fulfill: () => assert.fail('Shared writes must not receive a fake success')
          })
        }
        return { passed: !options.pageGap, observation: { periodId, offlineDouble: true } }
      },
      cleanupReviewer: async ({ key }) => {
        steps.push(`cleanup:${key}`)
        if (options.cleanupFailure && key === 'operatingReviewer') throw new Error('unit cleanup failure')
      }
    }
  }
  const context = {
    caseId, ctx: { page, token: 'unit-existing-session' },
    record, caseRecord, outputDir: '/unused-offline'
  }
  return {
    record, page, caseRecord, steps, calls, fixture, dependencies, context,
    run: () => runCase(context, dependencies)
  }
}

test('COST-005/008 suite dispatches the real closure once per case using the same ctx page/token', async () => {
  const page = unitPage()
  const record = { runId: 'unit-operating-batch', environment: { tenantId: '1' } }
  const periods = []
  for (const caseId of ['COST-005', 'COST-008']) {
    const h = harness(caseId, { page, record })
    const result = await h.run()
    assert.equal(result.token, 'unit-existing-session')
    assert.equal(result.partial, false)
    assert.equal(result.acceptanceComplete, true)
    assert.equal(h.caseRecord.passCandidate, true)
    assert.equal(hasCostOperatingEvidence(h.caseRecord), true)
    for (const step of ['closure', 'safety', 'prepare', 'page',
      'cleanup:operatingReviewer', 'cleanup:reviewer', 'cleanup:approvalReviewer']) {
      assert.equal(h.steps.filter((entry) => entry === step).length, 1, `${caseId}: ${step}`)
    }
    assert.ok(h.steps.indexOf('safety') < h.steps.indexOf('prepare'))
    assert.deepEqual(h.caseRecord.catalogAssertions.map((row) => row.assertion),
      definitions.find((item) => item.id === caseId).assertions)
    assert.ok(h.caseRecord.catalogAssertions.every((row) =>
      row.status === 'VERIFIED' && row.evidenceChecks.length > 0))
    const names = Object.values(costCatalogBindings[caseId]).flat()
    assert.equal(new Set(names).size, names.length, 'Each original assertion needs distinct named proof')
    periods.push(h.fixture.periodId)
  }
  assert.equal(page.registrations, 1, 'Reuse the existing page without reopening or duplicate routes')
  assert.equal(new Set(periods).size, 2)
})

test('disabled write fixtures keep both operating cases read-only and incomplete', async () => {
  for (const caseId of ['COST-005', 'COST-008']) {
    for (const writeFixtures of [false, 'false', 'true']) {
      const h = harness(caseId)
      h.dependencies.writeFixtures = writeFixtures
      h.dependencies.saveCostPrerequisiteEvidence = async ({ page, note }) => {
        assert.equal(page, h.page)
        assert.match(note, /未显式启用/)
        h.steps.push('readonly')
      }
      const result = await h.run()
      assert.equal(result.partial, true)
      assert.equal(result.acceptanceComplete, false)
      assert.deepEqual(h.steps, ['readonly'])
      assert.deepEqual(h.calls, [])
      assert.equal(h.caseRecord.passCandidate, false)
      assert.ok(h.caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
    }
  }
})

test('target or write-preflight rejection stops before owned fixture creation', async () => {
  for (const change of [
    { target: 'online' }, { tenantId: '2' }, { tenantName: 'other' },
    { apiBase: 'http://127.0.0.1:48084' }, { webBase: 'http://127.0.0.1:9152' },
    { apiUrl: 'https://invalid.example/admin-api' },
    { db: { ...settings.db, name: 'other' } }
  ]) {
    const h = harness('COST-005')
    h.dependencies.costOperatingDependencies.settings = { ...settings, ...change }
    await assert.rejects(h.run)
    assert.deepEqual(h.steps, ['closure'])
    assert.deepEqual(h.calls, [])
    assert.equal(h.caseRecord.passCandidate, false)
  }
  const h = harness('COST-008')
  h.dependencies.costOperatingDependencies.assertLocalWriteSafety = async () => {
    h.steps.push('safety')
    throw new Error('BLOCKED: unsafe local snapshot')
  }
  await assert.rejects(h.run, /unsafe local snapshot/)
  assert.deepEqual(h.steps, ['closure', 'safety'])
  assert.deepEqual(h.calls, [])
  assert.equal(h.caseRecord.passCandidate, false)
})

test('disabled dispatch discards stale closure evidence instead of reusing an earlier PASS', async () => {
  for (const caseId of ['COST-005', 'COST-008']) {
    const previous = harness(caseId)
    await previous.run()
    const h = harness(caseId)
    h.caseRecord.checks = clone(previous.caseRecord.checks)
    h.caseRecord.fixtures = clone(previous.caseRecord.fixtures)
    h.dependencies.writeFixtures = false
    h.dependencies.saveCostPrerequisiteEvidence = async () => {}
    const result = await h.run()
    assert.equal(result.acceptanceComplete, false)
    assert.equal(h.caseRecord.passCandidate, false)
    assert.equal(h.caseRecord.fixtures.costOperating, undefined)
    assert.deepEqual(h.calls, [])
  }
})

test('empty formal collections, missing SQL facts, failed page or cleanup never pass', async () => {
  for (const caseId of ['COST-005', 'COST-008']) {
    for (const options of [
      { emptyCollection: true }, { missingSql: true }, { failedApi: true },
      { pageGap: true }, { cleanupFailure: true }
    ]) {
      const h = harness(caseId, options)
      if (options.pageGap) {
        const result = await h.run()
        assert.equal(result.acceptanceComplete, false)
        assert.equal(result.partial, true)
      } else {
        await assert.rejects(h.run)
      }
      assert.equal(h.caseRecord.passCandidate, false, JSON.stringify({ caseId, options }))
      assert.equal(hasCostOperatingEvidence(h.caseRecord), false)
      assert.ok(h.caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
    }
  }
})

test('page evidence exceptions retain the original failure and always clean up all reviewers', async () => {
  for (const caseId of ['COST-005', 'COST-008']) {
    for (const cleanupFailure of [false, true]) {
      const pageFailure = new Error(`unit ${caseId} page evidence failed`)
      const h = harness(caseId, { pageFailure, cleanupFailure })
      await assert.rejects(h.run, (error) => error === pageFailure)
      for (const key of ['operatingReviewer', 'reviewer', 'approvalReviewer']) {
        assert.equal(h.steps.filter((step) => step === `cleanup:${key}`).length, 1)
      }
      assert.equal(h.calls.filter((call) =>
        call.method === 'POST' && call.path === '/system/auth/logout').length, 1)
      const cleanupChecks = h.caseRecord.checks
        .filter((check) => check.name === COST_OPERATING_CHECKS.cleanup)
      assert.equal(cleanupChecks.length, 1)
      assert.equal(cleanupChecks[0].passed, !cleanupFailure)
      if (cleanupFailure) {
        assert.match(cleanupChecks[0].details, /unit cleanup failure/)
        assert.ok(h.caseRecord.notes.some((note) => note.includes('unit cleanup failure')))
      }
      assert.equal(h.caseRecord.passCandidate, false)
      assert.equal(hasCostOperatingEvidence(h.caseRecord), false)
      assert.equal(h.caseRecord.fixtures.costOperating, undefined)
      assert.ok(h.caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
    }
  }
})

test('every required operating check needs unique boolean true and nonempty evidence', async () => {
  for (const caseId of ['COST-005', 'COST-008']) {
    const h = harness(caseId)
    await h.run()
    const valid = clone(h.caseRecord)
    const requiredNames = Object.values(COST_OPERATING_CHECKS)
      .filter((name) => valid.checks.some((check) => check.name === name))
    for (const name of requiredNames) {
      for (const mutation of ['missing', 'failed', 'string', 'duplicate', 'similar', 'empty']) {
        const record = clone(valid)
        const check = record.checks.find((item) => item.name === name)
        if (mutation === 'missing') record.checks = record.checks.filter((item) => item !== check)
        if (mutation === 'failed') check.passed = false
        if (mutation === 'string') check.passed = 'true'
        if (mutation === 'duplicate') record.checks.push(clone(check))
        if (mutation === 'similar') check.name += ' unrelated'
        if (mutation === 'empty') check.details = ' '
        costCatalogEvidence(caseId, record)
        assert.equal(record.passCandidate, false, `${caseId}: ${name}: ${mutation}`)
        assert.ok(record.catalogAssertions.every((row) => row.status === 'GAP'))
      }
    }
    for (const mutate of [
      (record) => { delete record.fixtures.costOperating },
      (record) => { record.fixtures.costOperating.complete = false },
      (record) => { record.fixtures.costOperating.periodId = '999' },
      (record) => { record.fixtures.costOperating.runId = 'old-run' },
      (record) => { record.fixtures.costOperating.tenantId = '2' },
      (record) => { record.fixtures.costOperating.pageFormal = false },
      (record) => { record.fixtures.costScenario.caseId = 'COST-012' },
      (record) => { record.fixtures.costScenario.remark += 'other' }
    ]) {
      const record = clone(valid)
      mutate(record)
      costCatalogEvidence(caseId, record)
      assert.equal(record.passCandidate, false)
    }
  }
})

test('closure success without checks or runtime fixture cannot certify acceptance', async () => {
  for (const caseId of ['COST-005', 'COST-008']) {
    const h = harness(caseId)
    h.dependencies.runCostOperatingClosure = async () => ({ acceptanceComplete: true })
    const result = await h.run()
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(h.caseRecord.passCandidate, false)
  }
})

test('operating dispatch upgrades an existing soft guard to abort shared saves without mock receipts', async () => {
  for (const caseId of ['COST-005', 'COST-008']) {
    const h = harness(caseId, { sharedSave: true })
    const earlierCase = { checks: [], notes: [] }
    await protectSharedCostWorkspace(h.page, earlierCase)
    const result = await h.run()
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(h.page.registrations, 1)
    assert.equal(h.steps.filter((step) => step === 'abort').length, 1)
    assert.deepEqual(earlierCase.checks, [])
    assert.ok(h.caseRecord.checks.some((check) =>
      check.name === '经营闭环禁止保存共享workspace' && check.passed === false))
    assert.equal(h.caseRecord.passCandidate, false)
  }
})
