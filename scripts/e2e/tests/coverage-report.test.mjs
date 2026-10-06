import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildCoverageReport,
  findResultFiles,
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
