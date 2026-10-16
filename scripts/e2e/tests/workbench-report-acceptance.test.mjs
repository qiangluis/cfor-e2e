import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  finalizeWorkbenchReportClosure,
  workbenchReportMode,
  WORKBENCH_REPORT_CLOSURE_CHECKS
} from '../fixtures/workbench-report-acceptance.mjs'
import { OWNED_CATALOG_ASSERTIONS } from '../workbenchhelper/contracts.mjs'
import { runCase } from '../suites/workbench.mjs'
import { caseOutcome } from '../lib/report.mjs'

const flags = {
  CFOR_E2E_WRITE_FIXTURES: 'true',
  CFOR_E2E_WORKBENCH_DAILY_CLOSURE: 'true'
}
const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const settings = {
  target: 'local', webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
  tenantId: '1', tenantName: 'CFOR 标准平台'
}
function recordFor (caseId) {
  const marker = `E2E-WBF-${caseId.slice(-3)}-UNIT`
  return {
    notes: [], evidence: [], remainingAssertions: [],
    workbenchReportMode: workbenchReportMode(caseId, flags),
    checks: WORKBENCH_REPORT_CLOSURE_CHECKS[caseId].flatMap(([name, count]) =>
      Array.from({ length: count }, () => ({ name, passed: true, details: 'unit-only evidence' }))),
    catalogAssertions: OWNED_CATALOG_ASSERTIONS[caseId].map((assertion, index) => ({
      caseId, index, assertion, status: 'VERIFIED', evidence: 'unit-only original assertion'
    })),
    database: [{ stage: 'write-preflight', available: true,
      rows: ['failed-migrations', 'enabled-jobs', 'active-triggers', 'active-database-writers']
        .map((key) => [key, '0']) }],
    fixtureObjects: [{ type: 'pm-project-role', id: '101', marker }],
    fixtureCleanup: { marker, cleaned: [{ type: 'pm-project-role', id: '101' }], remaining: [] }
  }
}
const conclusion = { catalogComplete: true }
const outcome = (record, result) => caseOutcome({
  failedChecks: record.checks.filter((row) => row.passed === false),
  hasAssertions: record.checks.length > 0, result
}).status

test('both report cases keep the catalog original wording, order and index mapping', () => {
  for (const caseId of ['WBF-004', 'WBF-008']) {
    const definition = catalog.suites.find((suite) => suite.id === 'workbench')
      .cases.find((item) => item.id === caseId)
    assert.deepEqual(OWNED_CATALOG_ASSERTIONS[caseId], definition.assertions)
    const record = recordFor(caseId)
    const result = finalizeWorkbenchReportClosure(caseId, record, conclusion)
    assert.equal(result.acceptanceComplete, true)
    assert.equal(outcome(record, result), 'PASS')
    assert.deepEqual(record.remainingAssertions, [])
  }
})

test('mode records why generic write opt-in cannot replace daily closure; flags require exact values', () => {
  for (const caseId of ['WBF-004', 'WBF-008']) {
    assert.equal(workbenchReportMode(caseId, {}).mode, 'read-only')
    assert.equal(workbenchReportMode(caseId, { CFOR_E2E_WRITE_FIXTURES: 'true' }).mode, 'owned-crm-only')
    assert.equal(workbenchReportMode(caseId, flags).mode, 'daily-closure')
    assert.equal(workbenchReportMode(caseId, {
      CFOR_E2E_WRITE_FIXTURES: 'true', CFOR_E2E_WORKBENCH_DAILY_GAPS: 'true'
    }).mode, 'daily-gaps')
    for (const value of ['TRUE', '1', 'yes', 'false', '']) {
      assert.equal(workbenchReportMode(caseId, {
        CFOR_E2E_WRITE_FIXTURES: 'true', CFOR_E2E_WORKBENCH_DAILY_CLOSURE: value
      }).mode, 'owned-crm-only')
      assert.throws(() => workbenchReportMode(caseId, {
        ...flags, CFOR_E2E_WRITE_FIXTURES: value
      }), /BLOCKED:/)
    }
    assert.throws(() => workbenchReportMode(caseId, {
      ...flags, CFOR_E2E_WORKBENCH_DAILY_GAPS: 'true'
    }), /不能同时/)
  }
  assert.equal(workbenchReportMode('WBF-009', flags), null)
})

test('each existing nonempty, isolation, preference and cleanup gate remains mandatory', () => {
  for (const caseId of ['WBF-004', 'WBF-008']) {
    for (const [name] of WORKBENCH_REPORT_CLOSURE_CHECKS[caseId]) {
      for (const mutation of ['missing', 'failed', 'conflicting']) {
        const record = recordFor(caseId)
        const index = record.checks.findIndex((row) => row.name === name)
        if (mutation === 'missing') record.checks.splice(index, 1)
        else if (mutation === 'failed') record.checks[index].passed = false
        else record.checks.push({ name, passed: false, details: 'unit-only later failure' })
        assert.equal(finalizeWorkbenchReportClosure(caseId, record, conclusion).acceptanceComplete, false,
          `${caseId}/${name}/${mutation}`)
        assert.notEqual(outcome(record, {}), 'PASS')
      }
    }
  }
})

test('catalog mismatches, failed safety snapshots, foreign cleanup or remaining gaps never become PASS', () => {
  const mutations = [
    (record) => { record.catalogAssertions.reverse() },
    (record) => { record.catalogAssertions[0].assertion += ' alias' },
    (record) => { record.catalogAssertions[0].index = 9 },
    (record) => { record.catalogAssertions[0].caseId = 'WBF-009' },
    (record) => { record.catalogAssertions[0].evidence = '' },
    (record) => { record.catalogAssertions[0].status = 'UNVERIFIED' },
    (record) => { record.catalogAssertions.push({ ...record.catalogAssertions[0] }) },
    (record) => { record.workbenchReportMode = workbenchReportMode('WBF-004', {}) },
    (record) => { record.database = [] },
    (record) => { record.database[0].rows[0][1] = '1' },
    (record) => { record.fixtureObjects[0].marker = 'E2E-WBF-004-FOREIGN' },
    (record) => { record.fixtureCleanup.cleaned = [] },
    (record) => { record.fixtureCleanup.remaining.push({ type: 'role', id: '102' }) },
    (record) => { record.checks.push({ name: 'unrelated failure', passed: false }) },
    (record) => { record.remainingAssertions = ['unit-only unresolved gap'] }
  ]
  for (const caseId of ['WBF-004', 'WBF-008']) {
    for (const mutate of mutations) {
      const record = recordFor(caseId)
      mutate(record)
      const result = finalizeWorkbenchReportClosure(caseId, record, conclusion)
      assert.equal(result.acceptanceComplete, false)
      assert.notEqual(outcome(record, result), 'PASS')
      assert.ok(record.remainingAssertions.length)
    }
    const record = recordFor(caseId)
    assert.equal(finalizeWorkbenchReportClosure(caseId, record, {
      partial: true, catalogComplete: true, note: 'unit-only child gap'
    }).acceptanceComplete, false)
  }
})

test('suite forwards exact closure flags, preserves mode across read-only callbacks and reuses the runner page', async () => {
  const page = {}
  const logins = []
  let delegated = 0
  const dependencies = {
    env: flags, workbenchConfig: settings,
    login: async (actualPage, options) => {
      assert.equal(actualPage, page)
      assert.equal(options.returnContext, true)
      logins.push(actualPage)
      return { token: 'unit-only', tenantId: '1' }
    },
    createApiClient: () => ({ get: async () => ({ code: 0, data: '1' }) }),
    runOwnedWorkbenchCase: async (context, tools) => {
      delegated++
      assert.equal(context.page, page)
      assert.equal(tools.env, flags)
      assert.equal(tools.runReadOnlyCase, runCase)
      assert.equal(context.caseRecord.workbenchReportMode.mode, 'daily-closure')
      Object.assign(context.caseRecord, recordFor(context.caseId))
      return conclusion
    }
  }
  for (const caseId of ['WBF-004', 'WBF-008']) {
    const caseRecord = recordFor(caseId)
    delete caseRecord.workbenchReportMode
    const result = await runCase({ caseId, page, caseRecord, record: {}, outputDir: '/unit-only' }, dependencies)
    assert.equal(outcome(caseRecord, result), 'PASS')
  }
  assert.equal(delegated, 2)
  assert.deepEqual(logins, [page, page])

  const caseRecord = recordFor('WBF-004')
  const result = await runCase({ caseId: 'WBF-004', page, caseRecord, record: {}, outputDir: '/unit-only' }, {
    env: {}, login: async () => 'unit-only',
    createApiClient: () => ({ get: async () => ({ code: 0, data: { user: { id: '101' }, permissions: [] } }) })
  })
  assert.equal(result.partial, true)
  assert.equal(caseRecord.workbenchReportMode.mode, 'daily-closure')
})

test('invalid flags and nonlocal targets stop before login or fixture writes', async () => {
  for (const env of [
    { CFOR_E2E_WORKBENCH_DAILY_CLOSURE: 'true' },
    { ...flags, CFOR_E2E_WORKBENCH_DAILY_GAPS: 'true' }
  ]) {
    await assert.rejects(runCase({
      caseId: 'WBF-004', page: {}, caseRecord: { checks: [] }, record: {}, outputDir: '/unit-only'
    }, { env, login: async () => assert.fail('Must stop before login') }), /BLOCKED:/)
  }
  await assert.rejects(runCase({
    caseId: 'WBF-008', page: {}, caseRecord: { checks: [] }, record: {}, outputDir: '/unit-only'
  }, {
    env: flags, workbenchConfig: { ...settings, target: 'production' },
    login: async () => assert.fail('Must stop before login')
  }), /仅允许 local/)
})
