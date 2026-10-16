import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  cases,
  costCatalogBindings,
  costCatalogEvidence,
  runCase
} from '../suites/cost.mjs'
import {
  COST_FORMAL_REPORT_BINDINGS,
  COST_FORMAL_REPORT_CHECKS
} from '../fixtures/cost-formal-report-closure.mjs'
import {
  COST_OPERATING_CHECKS,
  hasCostOperatingEvidence
} from '../fixtures/cost-operating-closure.mjs'

const formalCases = Object.keys(COST_FORMAL_REPORT_CHECKS)
const definitions = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  .suites.flatMap((suite) => suite.cases)
const settings = {
  target: 'local', tenantId: '1',
  apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151'
}
const context = (caseId, token) => {
  const page = { async route () { assert.fail('Formal dispatch must not install the generic workspace guard') } }
  const caseRecord = {
    id: caseId, caseId, checks: [], notes: [], evidence: [], gaps: []
  }
  return {
    caseId,
    token,
    page,
    caseRecord,
    record: {
      runId: `unit-${caseId.toLowerCase()}`,
      environment: { tenantId: '1' },
      cases: []
    },
    outputDir: `/tmp/${caseId.toLowerCase()}-dispatch`
  }
}

test('COST-035..039 are runnable cases with one strict binding per original assertion', () => {
  assert.deepEqual(cases.slice(-5), formalCases)
  const names = []
  for (const caseId of formalCases) {
    assert.equal(cases.filter((id) => id === caseId).length, 1)
    assert.deepEqual(costCatalogBindings[caseId], COST_FORMAL_REPORT_BINDINGS[caseId], caseId)
    assert.equal(Object.keys(costCatalogBindings[caseId]).length,
      Object.keys(COST_FORMAL_REPORT_CHECKS[caseId]).length, caseId)
    const definition = definitions.find((item) => item.id === caseId)
    assert.ok(definition, caseId)
    assert.deepEqual(Object.keys(costCatalogBindings[caseId]),
      definition.assertions.map((_assertion, index) => String(index)), caseId)
    assert.ok(Object.values(costCatalogBindings[caseId]).every((names) =>
      names.length === 1 && typeof names[0] === 'string' && names[0].length > 0))
    names.push(...Object.values(costCatalogBindings[caseId]).flat())
    const input = context(caseId)
    costCatalogEvidence(caseId, input.caseRecord)
    assert.deepEqual(input.caseRecord.remainingAssertions, definition.assertions, caseId)
    assert.deepEqual(input.caseRecord.catalogAssertions.map((item) => item.assertion),
      definition.assertions, caseId)
  }
  assert.equal(new Set(names).size, names.length)
})

test('formal report cases dispatch once before generic discovery and reuse page/token', async () => {
  for (const caseId of formalCases) {
    let calls = 0
    const suppliedToken = `unit-token-${caseId}`
    const input = context(caseId, suppliedToken)
    const closureOptions = { settings }
    const api = new Proxy({}, {
      get () {
        assert.fail(`${caseId} must not discover generic cost models or periods`)
      }
    })
    const result = await runCase(input, {
      login: async () => assert.fail(`${caseId} should reuse the supplied token`),
      createApiClient: (options) => {
        assert.equal(options.token, suppliedToken)
        assert.equal(options.record, input.record)
        return api
      },
      writeFixtures: false,
      formalReportPeriodId: '9001',
      costFormalReportDependencies: closureOptions,
      runCostFormalReportClosure: async (closureInput, dependencies) => {
        calls += 1
        assert.equal(closureInput.caseId, caseId)
        assert.equal(closureInput.page, input.page)
        assert.equal(closureInput.token, suppliedToken)
        assert.equal(closureInput.record, input.record)
        assert.equal(closureInput.caseRecord, input.caseRecord)
        assert.equal(closureInput.outputDir, input.outputDir)
        assert.equal(closureInput.periodId, '9001')
        assert.equal(dependencies, closureOptions)
        return { acceptanceComplete: false, partial: true, evidence: { caseId } }
      }
    })
    assert.equal(calls, 1, caseId)
    assert.equal(result.partial, true, caseId)
    assert.equal(result.acceptanceComplete, false, caseId)
    assert.equal(input.caseRecord.catalogComplete, false, caseId)
  }
})

test('formal dispatch reuses ctx.page/token when no top-level session is provided', async () => {
  const input = context('COST-039')
  const page = input.page
  delete input.page
  input.ctx = { page, token: 'unit-shared-session' }
  await runCase(input, {
    login: async () => assert.fail('Existing ctx session must not log in again'),
    createApiClient: ({ token }) => {
      assert.equal(token, input.ctx.token)
      return {}
    },
    runCostFormalReportClosure: async (closureInput) => {
      assert.equal(closureInput.page, page)
      assert.equal(closureInput.token, input.ctx.token)
      return { acceptanceComplete: false }
    }
  })
})

const operatingRecord = (runId) => {
  const source = {
    scenario: 'published', caseId: 'COST-008', tenantId: '1', runId, suffix: 'operating',
    month: '2099-01', periodId: '9001', modelId: '9002', publicationId: '9003'
  }
  source.remark = `CFOR-E2E:costScenario:published:${runId}:operating:tenant=1:org=1:month=${source.month}`
  return {
    id: 'COST-008',
    fixtures: {
      costScenario: source,
      costOperating: {
        complete: true, pageFormal: true, published: true,
        caseId: 'COST-008', tenantId: '1', runId, month: source.month,
        periodId: source.periodId, modelId: source.modelId, costPublicationId: source.publicationId,
        operatingPublicationId: '9004'
      }
    },
    checks: ['refresh', 'collections', 'calculation', 'confirmationGate', 'publication',
      'page', 'cleanup', 'allocationBasis', 'invalidBasis', 'salesCost']
      .map((key) => ({ name: COST_OPERATING_CHECKS[key], passed: true, details: key }))
  }
}

test('only complete current-run COST-008 evidence supplies a preferred existing period', async () => {
  for (const mode of ['complete', 'incomplete', 'foreign-run', 'explicit']) {
    const input = context('COST-035', 'unit-token')
    const previous = operatingRecord(mode === 'foreign-run' ? 'another-run' : input.record.runId)
    assert.equal(hasCostOperatingEvidence(previous), true)
    if (mode === 'incomplete') previous.fixtures.costOperating.complete = false
    input.record.cases.push(previous)
    await runCase(input, {
      createApiClient: () => ({}),
      formalReportPeriodId: mode === 'explicit' ? '9101' : undefined,
      runCostFormalReportClosure: async (closureInput) => {
        assert.equal(closureInput.periodId,
          mode === 'explicit' ? '9101' : mode === 'complete' ? '9001' : undefined, mode)
        return { acceptanceComplete: false }
      }
    })
  }
})

test('formal report catalog cannot pass from named checks or claimed closure alone', async () => {
  for (const caseId of formalCases) {
    const input = context(caseId)
    const names = Object.values(costCatalogBindings[caseId]).flat()
    input.caseRecord.checks = names.map((name) => ({ name, passed: true, details: name }))
    costCatalogEvidence(caseId, input.caseRecord)
    assert.ok(input.caseRecord.catalogAssertions.every((item) => item.status === 'GAP'), caseId)
    assert.equal(input.caseRecord.passCandidate, false, caseId)

    const result = await runCase(input, {
      login: async () => 'unit-token',
      createApiClient: () => ({}),
      runCostFormalReportClosure: async () => ({
        acceptanceComplete: true, partial: false
      })
    })
    assert.equal(result.acceptanceComplete, false, caseId)
    assert.equal(result.partial, true, caseId)
    assert.ok(input.caseRecord.remainingAssertions.length > 0, caseId)
  }
})

const completeComparisonProof = (caseRecord) => {
  const period = {
    id: '101', period: '2099-01', enterpriseType: 'MANUFACTURING',
    accountingOrgId: '1', modelVersionId: '201', modelVersionNo: 'E2E-101'
  }
  const facts = {
    period,
    publication: { id: '301', periodId: period.id, status: 'PUBLISHED', batchNo: 'B-101', resultHash: 'H-101' },
    operating: null, operatingFacts: [],
    objects: [{
      id: '501', publicationId: '301', objectKey: 'OBJ-101', productCode: 'PRODUCT-101',
      productName: '正式产品', quantity: '2.000000', amount: '100.000000', unitCost: '50.000000'
    }],
    sources: []
  }
  const reasons = '外购采购/委外到岸成本缺失；质量约束事实缺失；交期约束事实缺失；产能约束事实缺失'
  const report = {
    reportKey: 'make-buy', formal: true, period: period.period, publicationId: '301',
    scope: 'MANUFACTURING/E2E-101', metrics: { comparableCount: 0, notComparableCount: 1 },
    rows: [{
      key: 'OBJ-101',
      values: {
        objectKey: 'OBJ-101', productCode: 'PRODUCT-101', productName: '正式产品',
        makeCost: 50, buyCost: null, difference: null, capacityLoad: null,
        qualityImpact: 'DATA_MISSING', deliveryImpact: 'DATA_MISSING', externalSourceCount: 0,
        notComparableReasons: reasons, status: '不可比较'
      }
    }]
  }
  const view = {
    visible: true, periodId: period.id, month: period.period, formal: 'true', count: '1',
    loaded: 'true', error: '', modelId: period.modelVersionId, modelVersion: period.modelVersionNo,
    queryMonth: period.period,
    text: '正式成本比较',
    headers: ['产品编码', '产品名称', '成本对象', '自产全成本', '外购到岸成本', '成本差异',
      '质量影响', '交期影响', '不可比较原因', '比较结论'],
    rows: [['PRODUCT-101', '正式产品', 'OBJ-101', '¥50.00', '--', '--',
      'DATA_MISSING', 'DATA_MISSING', reasons, '不可比较']]
  }
  const page = {
    verified: true, route: '/cost-management/analysis/make-buy', periodId: period.id, report, view,
    request: { method: 'GET', tenantId: '1', path: '/admin-api/cost/reports/make-buy/101' }
  }
  const proof = {
    caseId: 'COST-037', tenantId: '1', finished: true, complete: true,
    gaps: [], failures: [], mutations: [],
    samples: [{ facts, report }], pages: [page],
    assertions: {}
  }
  const names = COST_FORMAL_REPORT_CHECKS['COST-037']
  const assertionData = {
    rows: { objects: facts.objects, sources: facts.sources, report },
    reasons: [report.rows[0]],
    page,
    columns: { headers: view.headers, rows: view.rows }
  }
  for (const [key, name] of Object.entries(names)) {
    proof.assertions[name] = { verified: true, data: assertionData[key] }
    caseRecord.checks.push({ name, passed: true, details: JSON.stringify(assertionData[key]) })
  }
  caseRecord.costFormalReportClosure = proof
  return proof
}

test('complete structured evidence can pass the suite and exact original catalog assertions', async () => {
  const input = context('COST-037', 'unit-token')
  const result = await runCase(input, {
    createApiClient: () => ({}),
    runCostFormalReportClosure: async ({ caseRecord }) => {
      completeComparisonProof(caseRecord)
      return { acceptanceComplete: true, partial: false }
    }
  })
  assert.equal(result.acceptanceComplete, true)
  assert.equal(result.partial, false)
  assert.equal(input.caseRecord.catalogComplete, true)
  assert.equal(input.caseRecord.passCandidate, true)
  assert.equal(input.caseRecord.catalogAssertions.length, 4)
  assert.ok(input.caseRecord.catalogAssertions.every((item) => item.status === 'VERIFIED'))
  assert.deepEqual(input.caseRecord.remainingAssertions, [])
})

const corruptions = {
  'missing fact sample': (record) => { record.costFormalReportClosure.samples = [] },
  'empty API rows': (record) => { record.costFormalReportClosure.samples[0].report.rows = [] },
  'empty page rows': (record) => { record.costFormalReportClosure.pages[0].view.rows = [] },
  'wrong period': (record) => { record.costFormalReportClosure.pages[0].view.periodId = '999' },
  'incorrect amount': (record) => { record.costFormalReportClosure.samples[0].report.rows[0].values.makeCost = 100 },
  'missing original check': (record) => { record.checks.pop() },
  'duplicate check': (record) => { record.checks.push({ ...record.checks[0] }) },
  'failed check': (record) => { record.checks[0].passed = false },
  'truthy non-boolean check': (record) => { record.checks[0].passed = 'true' },
  'missing structured assertion': (record) => { delete record.costFormalReportClosure.assertions[record.checks[0].name] },
  'unverified assertion': (record) => { record.costFormalReportClosure.assertions[record.checks[0].name].verified = false },
  'missing assertion payload': (record) => { record.costFormalReportClosure.assertions[record.checks[0].name].data = null },
  'existing gap': (record) => { record.costFormalReportClosure.gaps.push({ message: 'missing control' }) },
  'runtime failure': (record) => { record.costFormalReportClosure.failures.push({ message: 'failed read' }) },
  'attempted mutation': (record) => { record.costFormalReportClosure.mutations.push({ method: 'PUT' }) }
}
for (const [label, corrupt] of Object.entries(corruptions)) {
  test(`suite evidence rejects ${label} even when the closure claims completion`, async () => {
    const input = context('COST-037', 'unit-token')
    const result = await runCase(input, {
      createApiClient: () => ({}),
      runCostFormalReportClosure: async ({ caseRecord }) => {
        completeComparisonProof(caseRecord)
        corrupt(caseRecord)
        return { acceptanceComplete: true, partial: false }
      }
    })
    assert.equal(result.acceptanceComplete, false)
    assert.equal(result.partial, true)
    assert.equal(input.caseRecord.passCandidate, false)
    assert.ok(input.caseRecord.catalogAssertions.every((item) => item.status === 'GAP'))
  })
}

test('COST-036 remains GAP without original allocation provenance and lawful TRADE controls', async () => {
  const input = context('COST-036', 'unit-token')
  const result = await runCase(input, {
    createApiClient: () => ({}),
    runCostFormalReportClosure: async ({ caseRecord }) => {
      caseRecord.checks = Object.values(COST_FORMAL_REPORT_CHECKS['COST-036'])
        .map((name) => ({ name, passed: true }))
      caseRecord.costFormalReportClosure = {
        caseId: 'COST-036', tenantId: '1', finished: true, complete: true,
        gaps: [], failures: [], mutations: [], samples: [],
        assertions: Object.fromEntries(caseRecord.checks.map(({ name }) =>
          [name, { verified: true, data: { code: 422001 } }])),
        pages: [{ verified: true, request: { method: 'GET', tenantId: '1' } }]
      }
      return { acceptanceComplete: true }
    }
  })
  assert.equal(result.partial, true)
  assert.equal(input.caseRecord.passCandidate, false)
})

test('suite runs the real nonempty comparison closure once with independent API/SQL/page evidence', async () => {
  const input = context('COST-037', 'unit-token')
  const seed = completeComparisonProof({ checks: [] })
  const { facts, report } = seed.samples[0]
  const period = {
    ...facts.period, status: 'COST_PUBLISHED', currentPublicationId: facts.publication.id
  }
  const apiReads = []
  const apiRows = new Map([
    ['/cost/periods?accountingOrgId=1&pageNo=1&pageSize=100', { list: [period], total: 1 }],
    ['/cost/periods/101', period],
    ['/cost/periods/101/operating-publication', null],
    ['/cost/reports/make-buy/101', report]
  ])
  const tableFacts = {
    period: [{
      id: period.id, tenantId: '1', accountingOrgId: '1', period: period.period,
      enterpriseType: period.enterpriseType, modelId: period.modelVersionId,
      versionNo: period.modelVersionNo, publicationId: facts.publication.id
    }],
    publication: [{ ...facts.publication, tenantId: '1' }],
    object: facts.objects.map((row) => ({ ...row, tenantId: '1' })),
    source: [], operating: [], operatingFact: []
  }
  let responsePredicate, guard, sqlReads = 0, navigations = 0, artifacts = 0, routes = 0
  const browserResponse = {
    url: () => `${settings.apiBase}/admin-api/cost/reports/make-buy/101`,
    request: () => ({ method: () => 'GET', headers: () => ({ 'tenant-id': '1' }) }),
    ok: () => true, status: () => 200, headers: () => ({}),
    text: async () => JSON.stringify({ code: 0, data: report })
  }
  input.page = {
    async route (pattern, handler) {
      assert.equal(pattern, '**/admin-api/cost/**')
      guard = handler
      routes++
    },
    async unroute (pattern, handler) {
      assert.equal(pattern, '**/admin-api/cost/**')
      assert.equal(handler, guard)
    },
    waitForResponse (predicate) {
      responsePredicate = predicate
      return Promise.resolve(browserResponse)
    },
    async waitForFunction (_predicate, args) {
      assert.equal(args.periodId, period.id)
      assert.equal(args.count, report.rows.length)
    },
    locator (selector) {
      assert.equal(selector, '[data-testid="formal-cost-report"]')
      return { evaluate: async () => structuredClone(seed.pages[0].view) }
    },
    url: () => `${settings.webBase}/cost-management/analysis/make-buy?periodId=101`
  }
  const dependencies = {
    writeFixtures: false,
    createApiClient: () => ({
      async getBusiness (route) {
        assert.ok(apiRows.has(route), `Unexpected generic or write API: ${route}`)
        apiReads.push(route)
        return { code: 0, data: structuredClone(apiRows.get(route)) }
      }
    }),
    costFormalReportDependencies: {
      settings,
      readSql: async (sql) => {
        sqlReads++
        assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|TRUNCATE)\b/i)
        assert.match(sql, /FROM cost_period WHERE tenant_id = 1 AND deleted = 0 AND id = 101/)
        return {
          available: true,
          rows: Object.entries(tableFacts).flatMap(([tag, rows]) => [
            [`${tag}-count`, String(rows.length)],
            ...rows.map((row) => [tag, JSON.stringify(row)])
          ])
        }
      },
      navigate: async (page, target) => {
        navigations++
        assert.equal(page, input.page)
        assert.equal(target, '/cost-management/analysis/make-buy?periodId=101')
        assert.equal(responsePredicate(browserResponse), true)
      },
      artifact: async () => { artifacts++ }
    }
  }
  for (let execution = 0; execution < 2; execution++) {
    const result = await runCase(input, dependencies)
    assert.equal(result.acceptanceComplete, true)
    assert.equal(result.partial, false)
    assert.equal(input.caseRecord.passCandidate, true)
    assert.ok(input.caseRecord.catalogAssertions.every((item) => item.status === 'VERIFIED'))
  }
  assert.deepEqual(apiReads, [...apiRows.keys()])
  assert.equal(sqlReads, 1)
  assert.equal(navigations, 1)
  assert.equal(artifacts, 1)
  assert.equal(routes, 1)
  assert.equal(input.caseRecord.checks.length, 4)
})

test('real closure dispatch with empty facts stays GAP and executes only once per case record', async () => {
  const input = context('COST-035', 'unit-token')
  const apiReads = []
  const guards = []
  input.page = {
    async route (pattern, handler) {
      assert.equal(pattern, '**/admin-api/cost/**')
      guards.push(handler)
    },
    async unroute (pattern, handler) {
      assert.equal(pattern, '**/admin-api/cost/**')
      assert.equal(handler, guards[0])
    }
  }
  const dependencies = {
    writeFixtures: false,
    createApiClient: () => ({
      async getBusiness (route) {
        apiReads.push(route)
        assert.equal(route, '/cost/periods?accountingOrgId=1&pageNo=1&pageSize=100')
        return { code: 0, data: { list: [], total: 0 } }
      }
    }),
    costFormalReportDependencies: {
      settings,
      readSql: async () => assert.fail('No formal period means no SQL sample'),
      navigate: async () => assert.fail('No sample means no page navigation'),
      artifact: async () => assert.fail('No page evidence means no artifact')
    }
  }
  for (let execution = 0; execution < 2; execution++) {
    const result = await runCase(input, dependencies)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(result.partial, true)
    assert.ok(input.caseRecord.costFormalReportClosure.gaps.length > 0)
    assert.deepEqual(input.caseRecord.checks, [])
    assert.ok(input.caseRecord.catalogAssertions.every((item) => item.status === 'GAP'))
  }
  assert.equal(apiReads.length, 1)
  assert.equal(guards.length, 1)
})

test('formal report runtime errors retain a failed check and catalog gaps', async () => {
  const input = context('COST-037')
  await assert.rejects(runCase(input, {
    login: async () => 'unit-token',
    createApiClient: () => ({}),
    runCostFormalReportClosure: async () => {
      throw new Error('formal report API failed')
    }
  }), /formal report API failed/)
  assert.ok(input.caseRecord.checks.some((check) => check.passed === false))
  assert.equal(input.caseRecord.passCandidate, false)
  assert.ok(input.caseRecord.catalogAssertions.some((item) => item.status === 'GAP'))
})
