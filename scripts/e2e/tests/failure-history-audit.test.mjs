import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildFailureHistoryAudit, discoverAuditFiles, isSpecificAssertion,
  renderAuditMarkdown, writeAuditOutputs
} from '../failure-history-audit.mjs'

const env = { target: 'local', apiBase: 'http://127.0.0.1:48083/admin-api',
  webBase: 'http://127.0.0.1:9151', tenantId: '1', dbName: 'standard' }
const name = '表格行数与真实 GET 返回数量精确一致'
const check = (passed, label = name, extra = {}) => ({ name: label, passed, ...extra })
const clock = (second) => `2026-10-06T10:00:${String(second).padStart(2, '0')}.000Z`
const execution = (status, start, end, checks, extra = {}) => ({
  id: 'A-001', status, startedAt: clock(start), finishedAt: clock(end), checks, ...extra
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-history-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const catalogPath = path.join(root, 'catalog.json')
  fs.writeFileSync(catalogPath, JSON.stringify({
    suites: [{ id: 'a', cases: [{ id: 'A-001', status: 'READY' }, { id: 'A-002', status: 'PARTIAL' }] }]
  }))
  const resultPaths = []
  const write = (relative, value) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }
  const add = (result, options = {}) => {
    const file = write(`${resultPaths.length}/result.json`, {
      runId: options.runId || `run-${resultPaths.length}`,
      environment: options.environment ?? env,
      cases: [result]
    })
    resultPaths.push(file)
    return file
  }
  const audit = (options = {}) => buildFailureHistoryAudit({ catalogPath, resultPaths, ...options })
  return { root, catalogPath, resultPaths, write, add, audit }
}
const first = (report) => report.cases.find((item) => item.id === 'A-001')
const failureCheck = (report) => first(report).historicalFailures[0].failedChecks[0]

test('later same specific PASS re-verifies a subassertion without declaring case closure', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  f.add(execution('PASS', 3, 4, [check(true)]))
  const report = f.audit()
  assert.equal(failureCheck(report).auditStatus, 'REVERIFIED_ASSERTION')
  assert.equal(first(report).auditStatus, 'SPECIFIC_ASSERTIONS_REVERIFIED')
  assert.equal(first(report).actualStatus, 'PASS')
  assert.equal(report.summary.reverifiedByPass, 1)
  assert.equal(report.summary.caseClosures, 0)
  assert.equal(first(report).caseClosureClaimed, false)
})

test('coverage actualStatus/acceptanceStatus are copied, not recomputed by the audit', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  f.add(execution('PASS', 3, 4, [check(true)]))
  const coveragePath = f.write('coverage.json', {
    cases: [{ id: 'A-001', suite: 'a', catalogStatus: 'PARTIAL',
      actualStatus: 'PARTIAL', acceptanceStatus: 'PARTIAL' }],
    scannedResultPaths: f.resultPaths, since: clock(3)
  })
  const report = buildFailureHistoryAudit({ coveragePath })
  assert.equal(first(report).actualStatus, 'PARTIAL')
  assert.equal(first(report).acceptanceStatus, 'PARTIAL')
  assert.equal(first(report).historicalFailures.length, 1, 'coverage since must not filter raw history')
  assert.equal(report.scope.coverageSinceAppliedToHistory, false)
})

test('PARTIAL re-verifies only the concrete subassertion; prerequisite-only PARTIAL does not', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  f.add(execution('PARTIAL', 3, 4, [check(true, '真实登录成功')]))
  assert.equal(failureCheck(f.audit()).auditStatus, 'UNREVERIFIED')
  f.add(execution('PARTIAL', 5, 6, [check(true)]))
  const report = f.audit()
  assert.equal(failureCheck(report).auditStatus, 'REVERIFIED_SUBASSERTION_ONLY')
  assert.equal(first(report).auditStatus, 'PARTIAL_SUBASSERTIONS_ONLY')
  assert.equal(first(report).unverifiedFailureChecks.length, 1)
  assert.equal(report.summary.reverifiedByPartial, 1)
  assert.equal(report.summary.caseClosures, 0)
})

test('newer SKIPPED even with copied passed checks is never a re-verification', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  f.add(execution('SKIPPED', 3, 4, [check(true)]))
  const report = f.audit()
  assert.equal(first(report).actualStatus, 'FAIL')
  assert.equal(failureCheck(report).auditStatus, 'UNREVERIFIED')
  assert.equal(first(report).skippedRecords.length, 1)
})

test('each environment field must match and all five fields must exist', (t) => {
  for (const key of Object.keys(env)) {
    const f = fixture(t)
    f.add(execution('FAIL', 1, 2, [check(false)]))
    f.add(execution('PASS', 3, 4, [check(true)]), { environment: { ...env, [key]: 'different' } })
    assert.equal(failureCheck(f.audit()).auditStatus, 'UNREVERIFIED', key)
  }
  for (const key of Object.keys(env)) {
    const f = fixture(t)
    const missing = { ...env }
    delete missing[key]
    f.add(execution('FAIL', 1, 2, [check(false)]), { environment: missing })
    f.add(execution('PASS', 3, 4, [check(true)]), { environment: missing })
    assert.equal(failureCheck(f.audit()).auditStatus, 'UNREVERIFIED', `missing ${key}`)
    assert.equal(f.audit().summary.recordsWithMissingEnvironment, 2)
  }
})

test('equal, overlapping, reversed and missing time cannot re-verify; mtime is ignored', (t) => {
  for (const times of [[2, 4], [1, 4], [4, 3]]) {
    const f = fixture(t)
    f.add(execution('FAIL', 1, 2, [check(false)]))
    const later = f.add(execution('PASS', ...times, [check(true)]))
    fs.utimesSync(later, new Date('2030-01-01'), new Date('2030-01-01'))
    assert.equal(failureCheck(f.audit()).auditStatus, 'UNREVERIFIED')
  }
  const f = fixture(t)
  const old = f.add(execution('FAIL', 1, 2, [check(false)], { startedAt: undefined, finishedAt: undefined }))
  f.add(execution('PASS', 3, 4, [check(true)]))
  fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'))
  assert.equal(failureCheck(f.audit()).auditStatus, 'UNREVERIFIED')
  assert.equal(f.audit().summary.recordsWithoutComparableTime, 1)
})

test('run-level timestamps do not substitute for missing case-level timestamps', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)], {
    startedAt: undefined, finishedAt: undefined
  }), { runId: 'old', runStartedAt: clock(1) })
  f.add(execution('PASS', 3, 4, [check(true)]), { runId: 'new', runStartedAt: clock(3) })
  // The fixture helper stores only run.environment/cases; add explicit run
  // windows to prove they are ignored for case ordering.
  const old = f.resultPaths[0]
  const next = f.resultPaths[1]
  for (const file of [old, next]) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    value.startedAt = value.runStartedAt || clock(1)
    value.finishedAt = value.startedAt
    delete value.runStartedAt
    fs.writeFileSync(file, JSON.stringify(value))
  }
  const report = f.audit()
  assert.equal(failureCheck(report).auditStatus, 'UNREVERIFIED')
  assert.equal(report.summary.recordsWithoutComparableTime, 1)
})

test('same name means exact name and layer; no fuzzy normalization or name substring match', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false, name, { layer: 'page' })]))
  f.add(execution('PASS', 3, 4, [check(true, `${name}（仅前置）`, { layer: 'page' })]))
  f.add(execution('PASS', 5, 6, [check(true, name, { layer: 'api' })]))
  assert.equal(failureCheck(f.audit()).auditStatus, 'UNREVERIFIED')
})

test('generic checks cannot resolve specific failures or unnamed business error notes', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)], { notes: ['locator.click strict mode: token=top-secret'] }))
  f.add(execution('PASS', 3, 4, [check(true, '本用例无控制台错误、页面异常、浏览器业务 API 错误或请求失败')]))
  const report = f.audit()
  assert.equal(failureCheck(report).auditStatus, 'UNREVERIFIED')
  assert.equal(report.summary.manualExceptionItems, 1)
  assert.equal(first(report).unverifiedFailureChecks.length, 2)
  assert.equal(isSpecificAssertion('真实登录成功'), false)
  assert.equal(isSpecificAssertion('失败现场的控制台、页面、业务 API 与请求错误'), false)
  assert.equal(isSpecificAssertion(name), true)
})

test('exception without a concrete failed check remains manual even after PASS', (t) => {
  const f = fixture(t)
  f.add(execution('ERROR', 1, 2, [], { error: 'secret=never-emit; browser closed' }))
  f.add(execution('PASS', 3, 4, [check(true)]))
  const report = f.audit()
  assert.equal(failureCheck(report).auditStatus, 'EXCEPTION_MANUAL_REVIEW')
  assert.equal(first(report).auditStatus, 'OPEN_HISTORICAL_FAILURE')
})

test('raw notes/errors/details and secret-bearing check labels never appear in JSON or Markdown', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [
    check(false, '调用接口 token=check-secret', { details: '{"password":"details-secret"}' })
  ], { notes: ['password=note-secret'], error: 'Bearer error-secret' }))
  const report = f.audit()
  const output = JSON.stringify(report) + renderAuditMarkdown(report)
  for (const value of ['check-secret', 'details-secret', 'note-secret', 'error-secret']) {
    assert(!output.includes(value), value)
  }
  assert(output.includes('sensitive label omitted'))
  assert.equal(report.summary.manualExceptionItems, 1)
})

test('legacy steps/error are supported but at/runId/mtime are not execution timestamps', (t) => {
  const f = fixture(t)
  const legacy = f.write('legacy/result.json', {
    runId: '2026-10-06T10-00-01', at: clock(2), environment: env,
    cases: [{ caseId: 'A-001', status: 'FAIL', steps: [check(false)], error: 'legacy failure' }]
  })
  f.resultPaths.push(legacy)
  f.add(execution('PASS', 3, 4, [check(true)]))
  const report = f.audit()
  assert.equal(report.summary.recordsWithoutComparableTime, 1)
  assert.equal(failureCheck(report).auditStatus, 'UNREVERIFIED')
  assert.equal(failureCheck(report).origins[0].field, 'steps')
})

test('raw result copies are deduplicated; conflicting execution identities cannot close failures', (t) => {
  const f = fixture(t)
  const old = f.add(execution('FAIL', 1, 2, [check(false)]))
  f.resultPaths.push(f.write('copy/result.json', fs.readFileSync(old, 'utf8')))
  f.add(execution('PASS', 3, 4, [check(true)]), { runId: 'conflict' })
  f.add(execution('FAIL', 3, 4, [check(false)]), { runId: 'conflict' })
  const report = f.audit()
  assert.equal(report.summary.duplicateExecutionCount, 1)
  assert.equal(failureCheck(report).auditStatus, 'UNREVERIFIED')
  assert(report.integrityIssues.some((item) => item.integrityIssues.includes('EXECUTION_IDENTITY_CONFLICT')))
})

test('ambiguous duplicate check signatures, boolean strings and PASS with failed checks are not evidence', (t) => {
  for (const checks of [[check(true), check(false)], [check('true')], [check(true), check(false, '另一业务断言')]]) {
    const f = fixture(t)
    f.add(execution('FAIL', 1, 2, [check(false)]))
    f.add(execution('PASS', 3, 4, checks))
    assert.equal(failureCheck(f.audit()).auditStatus, 'UNREVERIFIED')
  }
})

test('last successful re-verification is retained; a newer failure remains unresolved', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  f.add(execution('PASS', 3, 4, [check(true)]))
  f.add(execution('PARTIAL', 5, 6, [check(true)]))
  f.add(execution('FAIL', 7, 8, [check(false)]))
  const report = f.audit()
  assert.equal(failureCheck(report).lastSuccessfulReverification.finishedAt, clock(6))
  assert.equal(first(report).historicalFailures[1].failedChecks[0].auditStatus, 'UNREVERIFIED')
  assert.equal(first(report).auditStatus, 'OPEN_HISTORICAL_FAILURE')
  assert.equal(first(report).actualStatus, 'FAIL')
})

test('orphan FAIL/ERROR remain separate and cannot re-verify a registered case', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  f.add(execution('PASS', 3, 4, [check(true)], { id: 'ORPHAN-001' }))
  f.add(execution('ERROR', 5, 6, [], { id: 'ORPHAN-002', error: 'secret=orphan' }))
  const report = f.audit()
  assert.equal(report.summary.orphanExecutionCount, 2)
  assert.equal(report.summary.orphanFailureCount, 1)
  assert.equal(failureCheck(report).auditStatus, 'UNREVERIFIED')
  assert(!JSON.stringify(report).includes('secret=orphan'))
})

test('parse/schema errors and missing runId remain explicit and never leak source content', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  f.resultPaths.push(f.write('bad/result.json', '{"password":"parse-secret", broken'))
  f.resultPaths.push(f.write('invalid/result.json', { notes: 'secret=schema-secret' }))
  const later = f.write('missing-run/result.json', { environment: env, cases: [execution('PASS', 3, 4, [check(true)])] })
  f.resultPaths.push(later)
  const report = f.audit()
  assert.equal(report.summary.parseErrorCount, 2)
  assert.equal(report.scope.historyIncomplete, true)
  assert.equal(failureCheck(report).auditStatus, 'UNREVERIFIED')
  assert(!JSON.stringify(report).includes('parse-secret'))
  assert(!JSON.stringify(report).includes('schema-secret'))
})

test('default discovery scans all cfor-e2e roots, not unrelated trees or excluded siblings', (t) => {
  const f = fixture(t)
  const firstPath = f.write('cfor-e2e-first/run/result.json', { cases: [] })
  const secondPath = f.write('cfor-e2e-second/parallel-result.json', { results: [] })
  f.write('unrelated/run/result.json', { cases: [] })
  f.write('cfor-e2e-first-stale/run/result.json', { cases: [] })
  const found = discoverAuditFiles({
    tmpRoot: f.root, excludePaths: [path.join(f.root, 'cfor-e2e-first-stale')]
  })
  assert.deepEqual(found.paths, [firstPath, secondPath].map((file) => fs.realpathSync(file)))
})

test('parallel wrappers do not double count child FAILs; ERROR without child is retained', (t) => {
  const f = fixture(t)
  const child = f.add(execution('FAIL', 1, 2, [check(false)]))
  const batch = f.write('batch/parallel-result.json', {
    batchId: 'batch', startedAt: clock(10), results: [
      { caseId: 'A-001', status: 'FAIL', report: child },
      { caseId: 'A-002', status: 'ERROR', error: 'secret=worker-launch', report: '' }
    ]
  })
  f.resultPaths.push(batch)
  const report = f.audit()
  assert.equal(report.summary.linkedBatchRecordCount, 1)
  assert.equal(report.summary.historicalFailureExecutions, 2)
  assert.equal(report.summary.recordsWithoutComparableTime, 1)
  assert(!JSON.stringify(report).includes('worker-launch'))
})

test('outputs produce JSON/Markdown but cannot overwrite inputs or raw execution filenames', (t) => {
  const f = fixture(t)
  const input = f.add(execution('FAIL', 1, 2, [check(false)]))
  const report = f.audit()
  const outputs = writeAuditOutputs(report, path.join(f.root, 'audit.json'))
  assert.equal(JSON.parse(fs.readFileSync(outputs.json, 'utf8')).summary.caseClosures, 0)
  assert.match(fs.readFileSync(outputs.markdown, 'utf8'), /Actual.*Acceptance/)
  assert.throws(() => writeAuditOutputs(report, input))
  assert.throws(() => writeAuditOutputs(report, f.catalogPath))
  assert.throws(() => writeAuditOutputs(report, path.join(f.root, 'parallel-result.json')))
})

test('CLI can read coverage scannedResultPaths and emit both reports using only offline files', (t) => {
  const f = fixture(t)
  f.add(execution('FAIL', 1, 2, [check(false)]))
  const coverage = f.write('coverage.json', {
    cases: [{ id: 'A-001', actualStatus: 'FAIL', acceptanceStatus: 'FAIL' }],
    scannedResultPaths: f.resultPaths
  })
  const tool = fileURLToPath(new URL('../failure-history-audit.mjs', import.meta.url))
  const stdout = execFileSync(process.execPath, [tool, '--coverage', coverage, '--out', path.join(f.root, 'cli-audit')], { encoding: 'utf8' })
  const result = JSON.parse(stdout)
  assert.equal(result.summary.historicalFailureExecutions, 1)
  assert(fs.existsSync(result.outputs.json))
  assert(fs.existsSync(result.outputs.markdown))
})
