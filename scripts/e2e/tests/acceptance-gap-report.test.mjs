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
      runtimeErrors: { console: [], page: [], api: [], request: [], nodeApi: [] },
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

test('fully recorded assertions never hide a failed execution or an unclosed acceptance gate', () => {
  const paths = fixture()
  const catalog = JSON.parse(fs.readFileSync(paths.catalogPath, 'utf8'))
  catalog.suites[0].cases[0].acceptanceGaps = ['real page rendering']
  writeJson(paths.catalogPath, catalog)
  const source = JSON.parse(fs.readFileSync(paths.sourcePath, 'utf8'))
  const record = source.cases[0]
  record.catalogAssertions = catalog.suites[0].cases[0].assertions
    .map((assertion, index) => ({ index, assertion, status: 'VERIFIED' }))
  writeJson(paths.sourcePath, source)
  const build = () => buildAcceptanceGapReport({
    coveragePath: paths.coveragePath, catalogPath: paths.catalogPath
  })
  assert.equal(build().cases[0].completeAcceptance, false)
  assert.equal(build().cases[0].acceptanceGates[0].status, 'GAP')
  record.catalogAssertions.push({
    index: 3, assertion: 'real page rendering', status: 'VERIFIED'
  })
  writeJson(paths.sourcePath, source)
  assert.equal(build().cases[0].completeAcceptance, true)
  const coverage = JSON.parse(fs.readFileSync(paths.coveragePath, 'utf8'))
  for (const status of ['FAIL', 'PARTIAL', 'BLOCKED', 'SKIPPED', 'UNEXECUTED']) {
    coverage.cases[0].actualStatus = status
    writeJson(paths.coveragePath, coverage)
    const report = build()
    assert.equal(report.cases[0].completeAcceptance, false, status)
    assert.equal(report.cases[0].acceptanceStatus, 'GAP')
    assert.equal(report.summary.completeCases, 0)
  }
})

test('a PASS label cannot mask source failure, runtime errors or incomplete checks', () => {
  const paths = fixture()
  const source = JSON.parse(fs.readFileSync(paths.sourcePath, 'utf8'))
  const assertions = JSON.parse(fs.readFileSync(paths.catalogPath, 'utf8')).suites[0].cases[0].assertions
  source.cases[0].catalogAssertions = assertions
    .map((assertion, index) => ({ index, assertion, status: 'VERIFIED' }))
  const original = structuredClone(source.cases[0])
  const mutations = [
    (record) => { record.status = 'FAIL' },
    (record) => { record.checks[0].passed = false },
    (record) => { record.checks[0].passed = undefined },
    (record) => { record.runtimeErrors = { api: ['secret server error'] } },
    (record) => { record.runtimeErrors = { api: null } },
    (record) => { delete record.runtimeErrors },
    (record) => { record.runtimeErrors = {} },
    (record) => { delete record.runtimeErrors.nodeApi },
    (record) => { record.partial = true },
    (record) => { record.passCandidate = false },
    (record) => { record.acceptanceComplete = false },
    (record) => { record.checks = [] },
    (record) => { record.remainingAssertions = ['missing page evidence'] }
  ]
  for (const mutate of mutations) {
    source.cases[0] = structuredClone(original)
    mutate(source.cases[0])
    writeJson(paths.sourcePath, source)
    const report = buildAcceptanceGapReport({
      coveragePath: paths.coveragePath, catalogPath: paths.catalogPath
    })
    assert.equal(report.cases[0].completeAcceptance, false)
    assert.equal(report.cases[0].acceptanceStatus, 'GAP')
    assert.doesNotMatch(JSON.stringify(report), /secret server error/)
  }
})

test('all checks passing remains PARTIAL/GAP while structured remaining assertions are displayed', () => {
  const paths = fixture()
  const source = JSON.parse(fs.readFileSync(paths.sourcePath, 'utf8'))
  const record = source.cases[0]
  record.status = 'PARTIAL'
  record.checks = Array.from({ length: 45 }, () => ({
    name: 'must not leak', passed: true, details: 'secret check details'
  }))
  record.remainingAssertions = [
    '销售退货 SALES_RETURN 来源',
    { assertion: '质量计划 QUALITY_PLAN 来源', details: 'secret remaining details', token: 'secret token' },
    'RQC 校验'
  ]
  writeJson(paths.sourcePath, source)
  const coverage = JSON.parse(fs.readFileSync(paths.coveragePath, 'utf8'))
  coverage.cases[0].actualStatus = 'PARTIAL'
  writeJson(paths.coveragePath, coverage)
  const report = buildAcceptanceGapReport({ coveragePath: paths.coveragePath, catalogPath: paths.catalogPath })
  const item = report.cases[0]
  assert.deepEqual(item.checksSummary, { recorded: true, total: 45, passed: 45, failed: 0, unknown: 0 })
  assert.deepEqual(report.summary.checksSummary, { total: 45, passed: 45, failed: 0, unknown: 0 })
  assert.deepEqual(report.suites[0].checksSummary, report.summary.checksSummary)
  assert.deepEqual(item.remainingAssertions, ['销售退货 SALES_RETURN 来源', '质量计划 QUALITY_PLAN 来源', 'RQC 校验'])
  assert.equal(item.actualStatus, 'PARTIAL')
  assert.equal(item.acceptanceStatus, 'GAP')
  assert.equal(item.completeAcceptance, false)
  assert.deepEqual(item.completionBlockers, [
    'EXECUTION_NOT_PASS', 'SOURCE_NOT_PASS', 'ASSERTION_GAP', 'ACCEPTANCE_GATE_GAP'
  ])
  const markdown = renderAcceptanceGapMarkdown(report)
  assert.match(markdown, /通过 45 \/ 失败 0 \/ 未确认 0（共 45）/)
  assert.match(markdown, /SALES_RETURN/)
  assert.match(markdown, /QUALITY_PLAN/)
  assert.match(markdown, /RQC 校验/)
  assert.doesNotMatch(`${markdown}${JSON.stringify(report)}`, /must not leak|secret/)
})

test('check counts distinguish failed, unknown, missing and explicitly empty evidence', () => {
  const paths = fixture()
  const source = JSON.parse(fs.readFileSync(paths.sourcePath, 'utf8'))
  const build = () => buildAcceptanceGapReport({ coveragePath: paths.coveragePath, catalogPath: paths.catalogPath })
  source.cases[0].checks = [{ passed: true }, { passed: false }, {}, { passed: 'true' }]
  source.cases[0].remainingAssertions = ['explicit gap', { details: 'secret' }, 42, '']
  writeJson(paths.sourcePath, source)
  const item = build().cases[0]
  assert.deepEqual(item.checksSummary, { recorded: true, total: 4, passed: 1, failed: 1, unknown: 2 })
  assert.deepEqual(item.remainingAssertions, ['explicit gap', null, null, null])
  assert.match(renderAcceptanceGapMarkdown(build()), /未记录有效断言文本/)
  assert.equal(item.completeAcceptance, false)
  delete source.cases[0].checks
  delete source.cases[0].remainingAssertions
  source.cases[0].notes = ['45/45 passed; fake remaining assertion']
  writeJson(paths.sourcePath, source)
  assert.deepEqual(build().cases[0].checksSummary, { recorded: false, total: 0, passed: 0, failed: 0, unknown: 0 })
  assert.equal(build().cases[0].remainingAssertions, null)
  assert.match(renderAcceptanceGapMarkdown(build()), /已记录 checks：未记录/)
  assert.doesNotMatch(renderAcceptanceGapMarkdown(build()), /fake remaining assertion|45\/45/)
  source.cases[0].checks = []
  source.cases[0].remainingAssertions = []
  writeJson(paths.sourcePath, source)
  assert.deepEqual(build().cases[0].checksSummary, { recorded: true, total: 0, passed: 0, failed: 0, unknown: 0 })
  assert.deepEqual(build().cases[0].remainingAssertions, [])
  assert.match(renderAcceptanceGapMarkdown(build()), /remainingAssertions）：无/)
})
