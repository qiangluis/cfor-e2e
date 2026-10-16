import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildCoverageReport,
  findResultFiles,
  main,
  renderMarkdown,
  resolvedOutputPaths,
  writeReportOutputs
} from '../coverage-report.mjs'

function tempWorkspace () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-e2e-coverage-test-'))
}

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function catalogFile (directory) {
  const filePath = path.join(directory, 'catalog.json')
  writeJson(filePath, {
    suites: [{
      id: 'suite-a',
      cases: [
        { id: 'A-001', title: 'A one', status: 'PARTIAL' },
        { id: 'A-002', title: 'A two', status: 'DESIGNED' },
        { id: 'A-003', title: 'A three', status: 'READY' },
        { id: 'A-004', title: 'A four', status: 'BLOCKED' },
        { id: 'A-005', title: 'A five', status: 'READY' }
      ]
    }]
  })
  return filePath
}

function progressRun (directory, cases, metadata = {}) {
  for (const item of cases) {
    writeJson(path.join(directory, 'cases', `${item.caseId || item.id}.json`), item)
  }
  const progressPath = path.join(directory, 'progress.json')
  writeJson(progressPath, {
    schemaVersion: 1,
    runId: path.basename(directory),
    startedAt: '2026-10-02T10:00:00Z',
    updatedAt: '2026-10-02T11:00:00Z',
    phase: 'RUNNING',
    selectionComplete: false,
    selectedCases: cases.map((item) => item.caseId || item.id),
    pendingCases: [],
    counts: {},
    results: cases.map((item) => ({
      caseId: item.caseId || item.id,
      status: item.status,
      resultFile: path.join(directory, 'cases', `${item.caseId || item.id}.json`)
    })),
    ...metadata
  })
  return progressPath
}

const localEnvironment = {
  target: 'local',
  webBase: 'http://127.0.0.1:9151',
  apiBase: 'http://127.0.0.1:48083/admin-api',
  tenantId: '1',
  dbName: 'cfor_admin_standard'
}

function environmentFile (directory, environment = localEnvironment) {
  const file = path.join(directory, 'environment.json')
  writeJson(file, environment)
  return file
}

test('coverage selects latest non-skipped execution and preserves evidence paths', () => {
  const directory = tempWorkspace()
  const catalogPath = catalogFile(directory)
  const first = path.join(directory, 'old', 'result.json')
  const second = path.join(directory, 'new', 'result.json')
  writeJson(first, {
    runId: 'old',
    startedAt: '2026-10-01T10:00:00Z',
    finishedAt: '2026-10-01T10:01:00Z',
    outputDir: path.join(directory, 'old'),
    cases: [
      { caseId: 'A-001', status: 'FAIL', startedAt: '2026-10-01T10:00:01Z', finishedAt: '2026-10-01T10:00:02Z', evidence: ['old-proof.png'] },
      { caseId: 'A-003', status: 'PASS', startedAt: '2026-10-01T10:00:03Z', finishedAt: '2026-10-01T10:00:04Z', evidence: ['/tmp/proof-old.png'] }
    ]
  })
  writeJson(second, {
    runId: 'new',
    startedAt: '2026-10-02T10:00:00Z',
    finishedAt: '2026-10-02T10:01:00Z',
    outputDir: path.join(directory, 'new'),
    cases: [
      { caseId: 'A-001', status: 'SKIPPED', startedAt: '2026-10-02T10:00:01Z', finishedAt: '2026-10-02T10:00:02Z', evidence: ['/tmp/skip.png'] },
      { caseId: 'A-003', status: 'ERROR', startedAt: '2026-10-02T10:00:03Z', finishedAt: '2026-10-02T10:00:04Z', evidence: ['/tmp/error.png'] },
      { caseId: 'A-005', status: 'SKIPPED', evidence: ['/tmp/only-skip.png'] }
    ]
  })

  const report = buildCoverageReport({ catalogPath, resultPaths: [first, second] })
  const byId = Object.fromEntries(report.cases.map((item) => [item.id, item]))

  assert.equal(byId['A-001'].actualStatus, 'FAIL')
  assert.equal(byId['A-001'].skippedRecordCount, 1)
  assert.equal(byId['A-001'].latestExecution.sourcePath, first)
  assert.deepEqual(byId['A-003'].actualStatus, 'ERROR')
  assert.equal(byId['A-005'].actualStatus, 'UNEXECUTED')
  assert.equal(byId['A-002'].actualStatus, 'UNEXECUTED')
  assert.equal(byId['A-002'].acceptanceStatus, 'NOT_READY')
  assert.equal(byId['A-004'].acceptanceStatus, 'NOT_READY')
  assert.ok(byId['A-001'].evidencePaths.includes(first))
  assert.ok(byId['A-001'].evidencePaths.includes(path.join(directory, 'old')))
  assert.ok(byId['A-005'].skippedEvidencePaths.includes(second))
  assert.equal(report.summary.actualStatusCounts.FAIL, 1)
  assert.equal(report.summary.actualStatusCounts.ERROR, 1)
  assert.equal(report.summary.actualStatusCounts.UNEXECUTED, 3)
})

test('coverage handles duplicate timestamps and records without timestamps deterministically', () => {
  const directory = tempWorkspace()
  const catalogPath = catalogFile(directory)
  const noTimestamp = path.join(directory, 'a', 'result.json')
  const duplicate = path.join(directory, 'b', 'result.json')
  writeJson(noTimestamp, {
    runId: 'no-time',
    cases: [{ caseId: 'A-001', status: 'PARTIAL', evidence: [] }]
  })
  writeJson(duplicate, {
    runId: 'duplicate',
    cases: [{
      caseId: 'A-001',
      status: 'PASS',
      startedAt: '2026-10-03T00:00:00Z',
      finishedAt: '2026-10-03T00:00:01Z'
    }]
  })

  const report = buildCoverageReport({ catalogPath, resultPaths: [noTimestamp, duplicate] })
  const item = report.cases.find((candidate) => candidate.id === 'A-001')
  assert.equal(item.actualStatus, 'PASS')
  assert.equal(item.latestExecution.runId, 'duplicate')

  const onlyNoTimestamp = buildCoverageReport({ catalogPath, resultPaths: [noTimestamp] })
  assert.equal(
    onlyNoTimestamp.cases.find((candidate) => candidate.id === 'A-001').actualStatus,
    'PARTIAL'
  )
})

test('since filters old and timeless executions without promoting skipped records', () => {
  const directory = tempWorkspace()
  const catalogPath = catalogFile(directory)
  const resultPath = path.join(directory, 'result.json')
  writeJson(resultPath, {
    runId: 'since',
    cases: [
      { caseId: 'A-001', status: 'FAIL', finishedAt: '2026-10-01T00:00:00Z' },
      { caseId: 'A-003', status: 'PASS' },
      { caseId: 'A-005', status: 'SKIPPED', finishedAt: '2026-10-05T00:00:00Z' }
    ]
  })
  const report = buildCoverageReport({
    catalogPath,
    resultPaths: [resultPath],
    since: '2026-10-02T00:00:00Z'
  })
  const byId = Object.fromEntries(report.cases.map((item) => [item.id, item]))
  assert.equal(byId['A-001'].actualStatus, 'UNEXECUTED')
  assert.equal(byId['A-003'].actualStatus, 'UNEXECUTED')
  assert.equal(byId['A-005'].actualStatus, 'UNEXECUTED')
  assert.equal(report.summary.unexecutedCases, 5)
})

test('markdown and explicit output paths expose both report formats', () => {
  const directory = tempWorkspace()
  const catalogPath = catalogFile(directory)
  const report = buildCoverageReport({ catalogPath, resultPaths: [] })
  const markdown = renderMarkdown(report)
  assert.match(markdown, /Catalog实现状态/)
  assert.match(markdown, /UNEXECUTED/)
  const outputPrefix = path.join(directory, 'coverage')
  const paths = writeReportOutputs(report, outputPrefix)
  assert.equal(paths.json, `${outputPrefix}.json`)
  assert.equal(paths.markdown, `${outputPrefix}.md`)
  assert.ok(fs.existsSync(paths.json))
  assert.ok(fs.existsSync(paths.markdown))
  assert.equal(JSON.parse(fs.readFileSync(paths.json, 'utf8')).summary.totalCases, 5)
  assert.deepEqual(resolvedOutputPaths(`${outputPrefix}.json`), {
    json: `${outputPrefix}.json`,
    markdown: `${outputPrefix}.md`
  })
})

test('explicit evidence roots exclude stale trees without excluding sibling prefixes', () => {
  const directory = tempWorkspace()
  const stale = path.join(directory, 'stale', 'run', 'result.json')
  const valid = path.join(directory, 'stale-corrected', 'run', 'result.json')
  const unrelated = path.join(directory, 'other', 'result.json')
  for (const filePath of [stale, valid, unrelated]) writeJson(filePath, { cases: [] })
  assert.deepEqual(findResultFiles({
    roots: [path.join(directory, 'stale'), path.join(directory, 'stale-corrected')],
    excludePaths: [path.join(directory, 'stale')]
  }), [valid])
})

test('latest wrapper-only ERROR replaces an older PASS and retains batch/log evidence', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const old = path.join(directory, 'old', 'result.json')
  const wrapper = path.join(directory, 'batch', 'parallel-result.json')
  const logFile = path.join(directory, 'batch', 'workers', 'A-003', 'worker.log')
  writeJson(old, {
    runId: 'old', cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-01T10:00:00Z' }]
  })
  writeJson(wrapper, {
    batchId: 'batch',
    startedAt: '2026-10-02T10:00:00Z',
    finishedAt: '2026-10-02T10:03:00Z',
    results: [{ caseId: 'A-003', status: 'ERROR', report: '', logFile, error: 'worker timeout' }]
  })
  const report = buildCoverageReport({ catalogPath, roots: [directory] })
  const item = report.cases.find((candidate) => candidate.id === 'A-003')
  assert.equal(item.actualStatus, 'ERROR')
  assert.equal(item.latestExecution.sourceKind, 'parallel-summary')
  assert.equal(item.latestExecution.batchId, 'batch')
  assert.equal(item.latestExecution.startedAt, null)
  assert.equal(item.latestExecution.finishedAt, null)
  assert.equal(item.latestExecution.timestampSource, 'batch-window')
  assert.equal(item.latestExecution.effectiveAt, '2026-10-02T10:03:00.000Z')
  assert.ok(item.evidencePaths.includes(wrapper))
  assert.ok(item.evidencePaths.includes(logFile))
  assert.equal(report.scannedResultPaths.length, 2)
})

test('wrapper ERROR invalidates its linked child PASS regardless of input order or timestamp', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const child = path.join(directory, 'child', 'result.json')
  const wrapper = path.join(directory, 'parallel-result.json')
  writeJson(child, {
    runId: 'child',
    cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:04:00Z' }]
  })
  writeJson(wrapper, {
    batchId: 'batch', finishedAt: '2026-10-02T10:03:00Z',
    results: [{ caseId: 'A-003', status: 'ERROR', reportedStatus: 'PASS', report: child }]
  })
  for (const resultPaths of [[child, wrapper], [wrapper, child]]) {
    const report = buildCoverageReport({ catalogPath, resultPaths })
    const item = report.cases.find((candidate) => candidate.id === 'A-003')
    assert.equal(item.actualStatus, 'ERROR')
    assert.equal(item.latestExecution.sourcePath, wrapper)
    assert.ok(item.evidencePaths.includes(child))
  }
})

test('normal wrapper-child duplication cannot supersede a later serial execution', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const child = path.join(directory, 'child', 'result.json')
  const wrapper = path.join(directory, 'parallel-result.json')
  const later = path.join(directory, 'serial', 'result.json')
  writeJson(child, {
    runId: 'child',
    cases: [{ id: 'A-003', status: 'PARTIAL', finishedAt: '2026-10-02T10:01:00Z' }]
  })
  writeJson(wrapper, {
    batchId: 'batch', finishedAt: '2026-10-02T10:05:00Z',
    results: [{ caseId: 'A-003', status: 'PARTIAL', report: child }]
  })
  writeJson(later, {
    runId: 'serial',
    cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:04:00Z' }]
  })
  const report = buildCoverageReport({ catalogPath, resultPaths: [wrapper, child, later] })
  const item = report.cases.find((candidate) => candidate.id === 'A-003')
  assert.equal(item.actualStatus, 'PASS')
  assert.equal(item.latestExecution.sourcePath, later)
})

test('subsequent serial PASS supersedes a wrapper-only ERROR but keeps history scan paths', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const wrapper = path.join(directory, 'parallel-result.json')
  const later = path.join(directory, 'serial', 'result.json')
  writeJson(wrapper, {
    batchId: 'batch', finishedAt: '2026-10-02T10:03:00Z',
    results: [{ caseId: 'A-003', status: 'ERROR' }]
  })
  writeJson(later, {
    runId: 'serial',
    cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:04:00Z' }]
  })
  const report = buildCoverageReport({ catalogPath, roots: [directory] })
  const item = report.cases.find((candidate) => candidate.id === 'A-003')
  assert.equal(item.actualStatus, 'PASS')
  assert.ok(report.scannedResultPaths.includes(wrapper))
})

test('parallel SKIPPED remains unexecuted and since respects legacy batch-start-only times', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const wrapper = path.join(directory, 'parallel-result.json')
  writeJson(wrapper, {
    batchId: 'legacy', startedAt: '2026-10-02T10:00:00Z',
    results: [
      { caseId: 'A-003', status: 'ERROR' },
      { caseId: 'A-005', status: 'SKIPPED' }
    ]
  })
  const report = buildCoverageReport({ catalogPath, resultPaths: [wrapper] })
  const byId = Object.fromEntries(report.cases.map((item) => [item.id, item]))
  assert.equal(byId['A-003'].actualStatus, 'ERROR')
  assert.equal(byId['A-003'].latestExecution.finishedAt, null)
  assert.equal(byId['A-003'].latestExecution.effectiveAt, '2026-10-02T10:00:00.000Z')
  assert.equal(byId['A-005'].actualStatus, 'UNEXECUTED')
  assert.equal(byId['A-005'].skippedRecordCount, 1)
  const filtered = buildCoverageReport({
    catalogPath, resultPaths: [wrapper], since: '2026-10-02T10:01:00Z'
  })
  assert.equal(filtered.summary.executedCases, 0)
})

test('parallel discovery honors exclusions for files and trees without prefix collisions', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stale = path.join(directory, 'stale', 'parallel-result.json')
  const sibling = path.join(directory, 'stale-corrected', 'parallel-result.json')
  const child = path.join(directory, 'stale-corrected', 'worker', 'result.json')
  for (const filePath of [stale, sibling, child]) writeJson(filePath, { results: [] })
  assert.deepEqual(findResultFiles({
    roots: [directory], excludePaths: [path.join(directory, 'stale'), child]
  }), [sibling])
  assert.deepEqual(findResultFiles({ roots: [sibling] }), [sibling])
})

test('interrupted progress reads terminal snapshots and preserves run metadata without counting skips', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const statuses = ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED', 'SKIPPED']
  const progressPath = progressRun(path.join(directory, 'interrupted'), statuses.map((status, index) => ({
    id: `A-00${index + 1}`,
    status,
    startedAt: '2026-10-02T10:00:01Z',
    finishedAt: `2026-10-02T10:00:0${index + 2}Z`,
    notes: [`saved ${status}`]
  })), { counts: { finalized: 5, executed: 4 }, pendingCases: ['A-006'] })
  assert.deepEqual(findResultFiles({ roots: [directory] }), [progressPath])
  const report = buildCoverageReport({ catalogPath, roots: [directory] })
  assert.equal(report.summary.executedCases, 4)
  assert.deepEqual(report.cases.map((item) => item.actualStatus), [
    'PASS', 'FAIL', 'PARTIAL', 'BLOCKED', 'UNEXECUTED'
  ])
  assert.equal(report.cases[4].skippedRecordCount, 1)
  for (const item of report.cases.slice(0, 4)) {
    const execution = item.latestExecution
    assert.equal(execution.sourceKind, 'case-progress')
    assert.equal(execution.runId, 'interrupted')
    assert.equal(execution.timestampSource, 'case')
    assert.equal(execution.progress.sourcePath, progressPath)
    assert.equal(execution.progress.phase, 'RUNNING')
    assert.equal(execution.progress.selectionComplete, false)
    assert.deepEqual(execution.progress.pendingCases, ['A-006'])
    assert.deepEqual(execution.progress.counts, { finalized: 5, executed: 4 })
    assert.ok(item.evidencePaths.includes(progressPath))
    assert.ok(item.evidencePaths.includes(execution.sourcePath))
  }
  assert.equal(report.scannedResultPaths.length, 6)
})

test('RUNNING and pending cases are unexecuted even when progress claims PASS or completion', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const old = path.join(directory, 'old', 'result.json')
  writeJson(old, {
    cases: [{ id: 'A-001', status: 'FAIL', finishedAt: '2026-10-01T10:00:00Z' }]
  })
  const progressPath = progressRun(path.join(directory, 'interrupted'), [
    { id: 'A-001', status: 'RUNNING', startedAt: '2026-10-02T10:00:01Z' },
    { id: 'A-003', status: 'RUNNING', finishedAt: '2026-10-02T10:00:02Z' }
  ], {
    phase: 'FINISHED',
    selectionComplete: true,
    selectedCases: ['A-001', 'A-003', 'A-005'],
    executedCases: ['A-001', 'A-003', 'A-005'],
    counts: { PASS: 3 },
    results: ['A-001', 'A-003', 'A-005'].map((caseId) => ({ caseId, status: 'PASS' }))
  })
  const finalPath = path.join(directory, 'unfinished-final', 'result.json')
  writeJson(finalPath, { cases: [{ id: 'A-005', status: 'RUNNING' }] })
  const report = buildCoverageReport({ catalogPath, resultPaths: [old, progressPath, finalPath] })
  assert.equal(report.summary.executedCases, 1)
  assert.equal(report.summary.actualStatusCounts.PASS, 0)
  assert.equal(report.summary.actualStatusCounts.ERROR, 0)
  assert.equal(report.cases[0].latestExecution.sourcePath, old)
  assert.equal(report.cases[2].executed, false)
  assert.equal(report.cases[4].executed, false)
})

test('case snapshots committed before a stale progress index still supply completed evidence', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const progressPath = progressRun(path.join(directory, 'interrupted'), [
    { id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:01:00Z' }
  ], { results: [], executedCases: [], pendingCases: ['A-003'] })
  const report = buildCoverageReport({ catalogPath, resultPaths: [progressPath] })
  assert.equal(report.cases[2].actualStatus, 'PASS')
  assert.equal(report.cases[2].latestExecution.effectiveAt, '2026-10-02T10:01:00.000Z')
})

test('final reports supersede snapshots including teardown corrections without duplicate skipped records', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const progressPath = progressRun(path.join(directory, 'finished'), [
    { id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:05:00Z' },
    { id: 'A-005', status: 'SKIPPED', finishedAt: '2026-10-02T10:05:00Z' }
  ])
  const finalPath = path.join(directory, 'finished', 'result.json')
  writeJson(finalPath, {
    runId: 'finished',
    cases: [
      { id: 'A-003', status: 'FAIL', finishedAt: '2026-10-02T10:01:00Z' },
      { id: 'A-005', status: 'SKIPPED', finishedAt: '2026-10-02T10:01:00Z' }
    ]
  })
  assert.deepEqual(findResultFiles({ roots: [directory] }), [finalPath])
  for (const resultPaths of [[progressPath, finalPath], [finalPath, progressPath]]) {
    const report = buildCoverageReport({ catalogPath, resultPaths })
    assert.equal(report.cases[2].actualStatus, 'FAIL')
    assert.equal(report.cases[2].latestExecution.sourcePath, finalPath)
    assert.equal(report.cases[4].skippedRecordCount, 1)
    assert.equal(report.parseErrors.length, 0)
  }
  assert.equal(buildCoverageReport({ catalogPath, resultPaths: [progressPath] }).summary.executedCases, 0)
})

test('interrupted snapshots use case completion time for latest coverage and since, not progress or mtime', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const old = path.join(directory, 'old', 'result.json')
  const later = path.join(directory, 'later', 'result.json')
  writeJson(old, { cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:00:00Z' }] })
  writeJson(later, { cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:02:00Z' }] })
  const progressPath = progressRun(path.join(directory, 'interrupted'), [
    { id: 'A-003', status: 'FAIL', finishedAt: '2026-10-02T10:01:00Z' }
  ], { updatedAt: '2027-01-01T00:00:00Z', finishedAt: '2027-01-01T00:00:00Z' })
  fs.utimesSync(path.join(directory, 'interrupted', 'cases', 'A-003.json'), new Date('2028-01-01'), new Date('2028-01-01'))
  for (const resultPaths of [[old, progressPath], [progressPath, old]]) {
    const report = buildCoverageReport({ catalogPath, resultPaths })
    assert.equal(report.cases[2].actualStatus, 'FAIL')
    assert.equal(report.cases[2].latestExecution.effectiveAt, '2026-10-02T10:01:00.000Z')
  }
  const report = buildCoverageReport({ catalogPath, resultPaths: [progressPath, later, old] })
  assert.equal(report.cases[2].latestExecution.sourcePath, later)
  assert.equal(report.cases[2].actualStatus, 'PASS')
  const filtered = buildCoverageReport({
    catalogPath, resultPaths: [progressPath], since: '2026-10-02T10:01:01Z'
  })
  assert.equal(filtered.summary.executedCases, 0)
})

test('incomplete PASS snapshots and mismatched identities are rejected without promoting progress indexes', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const progressPath = progressRun(path.join(directory, 'interrupted'), [
    { id: 'A-001', status: 'PASS' },
    { id: 'A-002', status: 'PASS', finishedAt: 'invalid' },
    { id: 'A-003', status: 'PASS', startedAt: '2026-10-02T10:02:00Z', finishedAt: '2026-10-02T10:01:00Z' },
    { id: 'A-004', caseId: 'A-005', status: 'PASS', finishedAt: '2026-10-02T10:01:00Z' }
  ])
  const report = buildCoverageReport({ catalogPath, resultPaths: [progressPath] })
  assert.equal(report.summary.executedCases, 0)
  assert.equal(report.parseErrors.length, 4)
  assert.match(report.parseErrors[0].error, /finishedAt/)
  assert.match(report.parseErrors[3].error, /ID/)
})

test('progress discovery and snapshot expansion honor exclusions and do not follow external resultFile pointers', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const external = path.join(directory, 'external', 'A-005.json')
  writeJson(external, { id: 'A-005', status: 'PASS', finishedAt: '2026-10-02T10:01:00Z' })
  const progressPath = progressRun(path.join(directory, 'interrupted'), [
    { id: 'A-003', status: 'FAIL', finishedAt: '2026-10-02T10:01:00Z' }
  ], {
    selectedCases: ['A-003', 'A-005'],
    results: [{ caseId: 'A-005', status: 'PASS', resultFile: external }]
  })
  const sibling = progressRun(path.join(directory, 'interrupted-corrected'), [])
  assert.deepEqual(findResultFiles({
    roots: [directory], excludePaths: [path.dirname(progressPath)]
  }), [sibling])
  const report = buildCoverageReport({ catalogPath, resultPaths: [progressPath] })
  assert.equal(report.cases[2].actualStatus, 'FAIL')
  assert.equal(report.cases[4].actualStatus, 'UNEXECUTED')
  const excluded = buildCoverageReport({
    catalogPath, roots: [path.dirname(progressPath)],
    excludePaths: [path.join(path.dirname(progressPath), 'cases', 'A-003.json')]
  })
  assert.equal(excluded.summary.executedCases, 0)
  assert.ok(!excluded.scannedResultPaths.includes(external))
})

test('parallel wrappers deduplicate interrupted children and abnormal exits invalidate their snapshots only', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const progressPath = progressRun(path.join(directory, 'interrupted'), [
    { id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:01:00Z' }
  ])
  const missingFinal = path.join(path.dirname(progressPath), 'result.json')
  const wrapper = path.join(directory, 'parallel-result.json')
  const serial = path.join(directory, 'serial', 'result.json')
  writeJson(serial, { cases: [{ id: 'A-003', status: 'FAIL', finishedAt: '2026-10-02T10:02:00Z' }] })
  writeJson(wrapper, {
    batchId: 'batch', finishedAt: '2026-10-02T10:05:00Z',
    results: [{ caseId: 'A-003', status: 'PASS', report: missingFinal }]
  })
  const normal = buildCoverageReport({ catalogPath, roots: [directory] })
  assert.equal(normal.cases[2].actualStatus, 'FAIL')
  assert.equal(normal.cases[2].latestExecution.sourcePath, serial)
  writeJson(wrapper, {
    batchId: 'batch', finishedAt: '2026-10-02T10:00:30Z',
    results: [{ caseId: 'A-003', status: 'ERROR', report: missingFinal }]
  })
  const error = buildCoverageReport({ catalogPath, resultPaths: [wrapper, progressPath] })
  assert.equal(error.cases[2].actualStatus, 'ERROR')
  const subsequent = buildCoverageReport({ catalogPath, roots: [directory] })
  assert.equal(subsequent.cases[2].latestExecution.sourcePath, serial)
})

test('exact environment scope excludes newer foreign runs and missing fields without changing the default', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const filterPath = environmentFile(directory)
  const matching = path.join(directory, 'matching', 'result.json')
  writeJson(matching, {
    environment: { ...localEnvironment, tenantId: 1 },
    cases: [{ id: 'A-003', status: 'PARTIAL', finishedAt: '2026-10-01T00:00:00Z' }]
  })
  const invalidEnvironments = [
    { ...localEnvironment, webBase: 'http://127.0.0.1:9160' },
    { ...localEnvironment, dbName: 'cfor_admin_saas_standard' },
    { ...localEnvironment, tenantId: '2' },
    { ...localEnvironment, target: 'production' },
    { ...localEnvironment, apiBase: 'http://127.0.0.1:48084/admin-api' },
    { ...localEnvironment, webBase: 'http://localhost:9151' },
    { ...localEnvironment, webBase: `${localEnvironment.webBase}/` },
    undefined,
    null,
    ...Object.keys(localEnvironment).map((key) => {
      const value = { ...localEnvironment }
      delete value[key]
      return value
    })
  ]
  const resultPaths = [matching]
  for (const [index, environment] of invalidEnvironments.entries()) {
    const file = path.join(directory, `foreign-${index}`, 'result.json')
    writeJson(file, {
      environment,
      cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T00:00:00Z' }]
    })
    resultPaths.push(file)
    const report = buildCoverageReport({ catalogPath, resultPaths: [file], environmentFile: filterPath })
    assert.equal(report.summary.executedCases, 0, `environment ${index}`)
    assert.equal(report.environmentExclusions.length, 1)
  }
  const report = buildCoverageReport({ catalogPath, resultPaths, environmentFile: filterPath })
  assert.equal(report.cases[2].actualStatus, 'PARTIAL')
  assert.equal(report.cases[2].latestExecution.sourcePath, matching)
  assert.equal(report.cases[2].latestExecution.environmentSourcePath, matching)
  assert.deepEqual(report.environmentFilter, localEnvironment)
  assert.equal(report.environmentExclusions.length, invalidEnvironments.length)
  assert.match(renderMarkdown(report), /精确环境范围/)
  assert.match(renderMarkdown(report), /不匹配或缺失：dbName/)
  const unscoped = buildCoverageReport({ catalogPath, resultPaths })
  assert.equal(unscoped.cases[2].actualStatus, 'PASS')
  assert.equal(unscoped.environmentFilter, undefined)
  assert.equal(unscoped.environmentExclusions, undefined)
})

test('environment-file CLI validates the full scope and records it in both outputs', async (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const filterPath = environmentFile(directory)
  const run = path.join(directory, 'run', 'result.json')
  writeJson(run, { environment: localEnvironment, cases: [{ id: 'A-003', status: 'PASS' }] })
  const output = path.join(directory, 'coverage')
  await main([
    '--catalog', catalogPath, '--root', directory,
    '--environment-file', filterPath, '--out', output
  ])
  assert.deepEqual(JSON.parse(fs.readFileSync(`${output}.json`, 'utf8')).environmentFilter, localEnvironment)
  assert.match(fs.readFileSync(`${output}.md`, 'utf8'), /9151/)
  await assert.rejects(main(['--environment-file']), /缺少参数/)
  await assert.rejects(main(['--environment-file', '--out', output]), /缺少参数/)
  const invalid = [null, [], {}, { ...localEnvironment, tenantId: {} },
    { ...localEnvironment, target: '' }, { ...localEnvironment, dbName: ' ' },
    { ...localEnvironment, webBsae: localEnvironment.webBase }]
  for (const environment of invalid) {
    writeJson(filterPath, environment)
    assert.throws(
      () => buildCoverageReport({ catalogPath, resultPaths: [], environmentFile: filterPath }),
      /--environment-file/
    )
  }
})

test('scoped progress requires the index environment and cannot be rescued by a snapshot environment', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const filterPath = environmentFile(directory)
  const snapshot = { id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:01:00Z' }
  const invalidEnvironments = [undefined, { ...localEnvironment, webBase: 'http://127.0.0.1:9160' },
    { ...localEnvironment, dbName: 'other' }, { ...localEnvironment, tenantId: '2' }]
  for (const [index, environment] of invalidEnvironments.entries()) {
    const progressPath = progressRun(path.join(directory, `invalid-${index}`), [
      { ...snapshot, environment: localEnvironment }
    ], { environment })
    const report = buildCoverageReport({ catalogPath, resultPaths: [progressPath], environmentFile: filterPath })
    assert.equal(report.summary.executedCases, 0)
    assert.equal(report.environmentExclusions.length, 1)
  }
  const progressPath = progressRun(path.join(directory, 'matching'), [
    snapshot,
    { ...snapshot, id: 'A-005', environment: { ...localEnvironment, tenantId: '2' } }
  ], { environment: localEnvironment })
  const report = buildCoverageReport({ catalogPath, resultPaths: [progressPath], environmentFile: filterPath })
  assert.equal(report.summary.executedCases, 1)
  assert.equal(report.cases[2].actualStatus, 'PASS')
  assert.equal(report.cases[2].latestExecution.environmentSourcePath, progressPath)
  assert.equal(report.cases[4].actualStatus, 'UNEXECUTED')
})

test('parallel scope uses only a matching scanned child and preserves scoped worker ERROR authority', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const filterPath = environmentFile(directory)
  const child = path.join(directory, 'child', 'result.json')
  const wrapper = path.join(directory, 'parallel-result.json')
  writeJson(child, {
    environment: localEnvironment,
    cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:04:00Z' }]
  })
  writeJson(wrapper, {
    batchId: 'batch', finishedAt: '2026-10-02T10:03:00Z',
    results: [{ caseId: 'A-003', status: 'ERROR', report: child }]
  })
  const build = (resultPaths) => buildCoverageReport({
    catalogPath, resultPaths, environmentFile: filterPath
  })
  const unattested = build([wrapper])
  assert.equal(unattested.summary.executedCases, 0)
  assert.equal(unattested.environmentExclusions.length, 1)
  for (const resultPaths of [[wrapper, child], [child, wrapper]]) {
    const item = build(resultPaths).cases[2]
    assert.equal(item.actualStatus, 'ERROR')
    assert.equal(item.latestExecution.sourcePath, wrapper)
    assert.equal(item.latestExecution.environmentSourcePath, child)
  }
  const invalidEnvironments = [
    { ...localEnvironment, webBase: 'http://127.0.0.1:9160' },
    { ...localEnvironment, dbName: 'other' }, { ...localEnvironment, tenantId: '2' }, undefined
  ]
  for (const environment of invalidEnvironments) {
    writeJson(child, {
      environment,
      cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:04:00Z' }]
    })
    assert.equal(build([wrapper, child]).summary.executedCases, 0)
  }
  writeJson(child, {
    environment: localEnvironment,
    cases: [{ id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:04:00Z' }]
  })
  writeJson(wrapper, {
    environment: { ...localEnvironment, tenantId: '2' },
    results: [{ caseId: 'A-003', status: 'ERROR', report: child }]
  })
  assert.equal(build([wrapper, child]).cases[2].actualStatus, 'PASS')
  writeJson(wrapper, {
    environment: localEnvironment,
    results: [{ caseId: 'A-003', status: 'ERROR' }]
  })
  assert.equal(build([wrapper]).cases[2].actualStatus, 'ERROR')
})

test('parallel cannot lend its environment to foreign children or interrupted snapshots', (t) => {
  const directory = tempWorkspace()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const catalogPath = catalogFile(directory)
  const filterPath = environmentFile(directory)
  const wrapper = path.join(directory, 'parallel-result.json')
  const progressDir = path.join(directory, 'progress-child')
  const progressPath = progressRun(progressDir, [
    { id: 'A-003', status: 'PASS', finishedAt: '2026-10-02T10:04:00Z' }
  ], { environment: { ...localEnvironment, webBase: 'http://127.0.0.1:9160' } })
  const writeWrapper = (status, environment) => writeJson(wrapper, {
    environment,
    finishedAt: '2026-10-02T10:05:00Z',
    results: [{ caseId: 'A-003', status, report: path.join(progressDir, 'result.json') }]
  })
  const build = () => buildCoverageReport({
    catalogPath, resultPaths: [wrapper, progressPath], environmentFile: filterPath
  })
  writeWrapper('ERROR', localEnvironment)
  assert.equal(build().summary.executedCases, 0)
  const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'))
  progress.environment = localEnvironment
  writeJson(progressPath, progress)
  writeWrapper('PASS')
  assert.equal(build().cases[2].latestExecution.sourceKind, 'case-progress')
  writeWrapper('ERROR')
  assert.equal(build().cases[2].actualStatus, 'ERROR')
  const snapshotPath = path.join(progressDir, 'cases', 'A-003.json')
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  snapshot.environment = { ...localEnvironment, dbName: 'other' }
  writeJson(snapshotPath, snapshot)
  assert.equal(build().summary.executedCases, 0)
})
