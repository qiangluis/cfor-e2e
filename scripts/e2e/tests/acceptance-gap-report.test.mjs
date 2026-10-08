import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildAcceptanceGapReport,
  renderAcceptanceGapMarkdown,
  writeAcceptanceGapReport
} from '../acceptance-gap-report.mjs'

function workspace () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-e2e-acceptance-gap-'))
}

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function fixture () {
  const root = workspace()
  const catalogPath = path.join(root, 'catalog.json')
  const sourcePath = path.join(root, 'run', 'result.json')
  const coveragePath = path.join(root, 'coverage.json')
  writeJson(catalogPath, {
    suites: [{
      id: 'suite-a',
      cases: [{
        id: 'A-001',
        title: '完整与缺口',
        status: 'READY',
        assertions: ['first assertion', 'second assertion', 'third assertion']
      }]
    }]
  })
  writeJson(sourcePath, {
    runId: 'run-a',
    environment: {
      target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
      webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083'
    },
    cases: [{
      caseId: 'A-001',
      status: 'PASS',
      notes: ['must not leak'],
      error: 'must not leak',
      checks: [{ name: 'HTTP 200', passed: true, details: 'must not leak' }],
      catalogAssertions: [
        { index: 0, assertion: 'first assertion', status: 'VERIFIED', details: 'secret' },
        { index: 1, assertion: 'old assertion text', status: 'VERIFIED' },
        { index: 2, assertion: 'third assertion', status: 'GAP' }
      ]
    }]
  })
  writeJson(coveragePath, {
    cases: [{
      id: 'A-001', actualStatus: 'PASS', executed: true,
      skippedRecordCount: 0,
      latestExecution: {
        runId: 'run-a', sourcePath, evidencePaths: [path.join(root, 'proof.png')]
      }
    }]
  })
  return { root, catalogPath, sourcePath, coveragePath }
}

test('maps only exact index/assertion VERIFIED and preserves real gaps without leaking fields', () => {
  const paths = fixture()
  const report = buildAcceptanceGapReport({
    coveragePath: paths.coveragePath,
    catalogPath: paths.catalogPath
  })
  const item = report.cases[0]
  assert.equal(item.actualStatus, 'PASS')
  assert.equal(item.acceptanceStatus, 'GAP')
  assert.equal(item.completeAcceptance, false)
  assert.deepEqual(item.assertions.map((row) => row.status), [
    'RECORDED_VERIFIED', 'NOT_RECORDED', 'GAP'
  ])
  assert.equal(item.assertions[1].mappingIssue, 'MISMATCHED_OR_EXPIRED_MAPPING')
  assert.equal(report.summary.completeCases, 0)
  const markdown = renderAcceptanceGapMarkdown(report)
  assert.match(markdown, /second assertion/)
  assert.doesNotMatch(markdown, /old assertion text/)
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /must not leak|secret/)
  assert.doesNotMatch(serialized, /notes|error|details/)
})

test('PASS without structured acceptance mapping is NEEDS_REVIEW, while unexecuted remains visible', () => {
  const paths = fixture()
  const coverage = JSON.parse(fs.readFileSync(paths.coveragePath, 'utf8'))
  coverage.cases[0].actualStatus = 'UNEXECUTED'
  coverage.cases[0].executed = false
  coverage.cases[0].latestExecution = null
  writeJson(paths.coveragePath, coverage)
  const report = buildAcceptanceGapReport({ coveragePath: paths.coveragePath, catalogPath: paths.catalogPath })
  assert.equal(report.cases[0].actualStatus, 'UNEXECUTED')
  assert.equal(report.cases[0].acceptanceStatus, 'NOT_RECORDED')
  assert.equal(report.cases[0].sourcePath, null)
  assert.equal(report.cases[0].evidencePaths.length, 0)
  assert.ok(report.metadataWarnings.length > 0)

  const source = JSON.parse(fs.readFileSync(paths.sourcePath, 'utf8'))
  source.cases[0].catalogAssertions = undefined
  writeJson(paths.sourcePath, source)
  coverage.cases[0].actualStatus = 'PASS'
  coverage.cases[0].executed = true
  coverage.cases[0].latestExecution = {
    runId: 'run-a', sourcePath: paths.sourcePath, evidencePaths: []
  }
  writeJson(paths.coveragePath, coverage)
  const passReport = buildAcceptanceGapReport({ coveragePath: paths.coveragePath, catalogPath: paths.catalogPath })
  assert.equal(passReport.cases[0].acceptanceStatus, 'NEEDS_REVIEW')
  assert.deepEqual(passReport.metadataWarnings, [])
})

test('output cannot overwrite coverage or source inputs and writes JSON plus Markdown', () => {
  const paths = fixture()
  const report = buildAcceptanceGapReport({ coveragePath: paths.coveragePath, catalogPath: paths.catalogPath })
  assert.throws(
    () => writeAcceptanceGapReport(report, paths.coveragePath, paths.coveragePath),
    /拒绝覆盖/
  )
  assert.throws(
    () => writeAcceptanceGapReport(report, paths.sourcePath, paths.coveragePath),
    /拒绝覆盖/
  )
  const output = path.join(paths.root, 'acceptance-gap')
  const result = writeAcceptanceGapReport(report, output, paths.coveragePath)
  assert.deepEqual(result, { json: `${output}.json`, markdown: `${output}.md` })
  assert.ok(fs.existsSync(result.json))
  assert.ok(fs.existsSync(result.markdown))
  assert.equal(JSON.parse(fs.readFileSync(result.json, 'utf8')).cases.length, 1)
})
