import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ReportPersistenceError,
  atomicWriteFile,
  createCaseRecord,
  createRunRecord,
  finishCase,
  isRunPassed,
  reportSnapshot,
  safeCaseId,
  writeProgress,
  writeReport
} from '../lib/report.mjs'
import { finalizeSuiteSessions, main, persistFinalizedCase } from '../runner.mjs'
import { buildCoverageReport } from '../coverage-report.mjs'

function temporaryRoot (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-e2e-runner-progress-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function recordFor (status, id = `CASE-${status}`) {
  const record = createRunRecord({
    selectedSuites: ['unit'],
    selectedCases: [id]
  })
  record.runId = `run-${status.toLowerCase()}`
  const caseRecord = createCaseRecord({ id, suite: 'unit', title: `${status} case` })
  if (status !== 'RUNNING') finishCase(caseRecord, status)
  record.cases.push(caseRecord)
  return record
}

test('writeProgress persists every case status as an atomic case snapshot', (t) => {
  const root = temporaryRoot(t)

  for (const status of ['RUNNING', 'PASS', 'PARTIAL', 'FAIL', 'BLOCKED', 'SKIPPED']) {
    const record = recordFor(status)
    const locations = { outputDir: path.join(root, record.runId) }
    if (status === 'RUNNING') {
      writeProgress(record, { outputRoot: root, phase: 'RUNNING' })
    } else {
      persistFinalizedCase(record, 0, record.cases[0], { outputRoot: root, phase: 'RUNNING' })
    }
    locations.progressFile = path.join(locations.outputDir, 'progress.json')
    locations.caseDir = path.join(locations.outputDir, 'cases')
    const progress = JSON.parse(fs.readFileSync(locations.progressFile, 'utf8'))
    const caseFile = path.join(locations.caseDir, `${safeCaseId(record.cases[0].caseId)}.json`)
    const snapshot = JSON.parse(fs.readFileSync(caseFile, 'utf8'))

    assert.equal(snapshot.status, status)
    assert.equal(progress.results[0].status, status)
    assert.equal(progress.counts[status], 1)
    assert.equal(progress.counts.finalized, status === 'RUNNING' ? 0 : 1)
    assert.equal(progress.counts.pending, status === 'RUNNING' ? 1 : 0)
    assert.equal(progress.phase, 'RUNNING')
  }
})

test('interrupted progress preserves its exact environment for scoped coverage and redacts secrets', (t) => {
  const root = temporaryRoot(t)
  const environment = {
    target: 'local', webBase: 'http://127.0.0.1:9151',
    apiBase: 'http://127.0.0.1:48083/admin-api', tenantId: '1', dbName: 'cfor_admin_standard'
  }
  const record = recordFor('PASS', 'CASE-PASS')
  record.environment = { ...environment, password: 'unit-environment-secret' }
  const locations = writeProgress(record, { outputRoot: root })
  const progressText = fs.readFileSync(locations.progressFile, 'utf8')
  const progress = JSON.parse(progressText)
  assert.equal(progress.environment.password, '[REDACTED]')
  assert.equal(progressText.includes('unit-environment-secret'), false)
  for (const [key, value] of Object.entries(environment)) {
    assert.equal(progress.environment[key], value)
  }
  const filterPath = path.join(root, 'environment.json')
  const catalogPath = path.join(root, 'catalog.json')
  fs.writeFileSync(filterPath, JSON.stringify(environment))
  fs.writeFileSync(catalogPath, JSON.stringify({
    suites: [{ id: 'unit', cases: [{ id: 'CASE-PASS', status: 'READY' }] }]
  }))
  const report = buildCoverageReport({
    catalogPath, environmentFile: filterPath, resultPaths: [locations.progressFile]
  })
  assert.equal(report.cases[0].latestExecution.status, 'PASS')
  assert.equal(report.cases[0].latestExecution.sourceKind, 'case-progress')
  assert.deepEqual(report.environmentExclusions, [])
})

test('runner persists a RUNNING snapshot immediately after a case is queued', async (t) => {
  const root = temporaryRoot(t)
  const phases = []
  const settings = {
    outputRoot: root,
    password: 'unit-password',
    target: 'remote',
    webBase: 'https://example.test',
    apiBase: 'https://example.test',
    apiUrl: 'https://example.test/admin-api'
  }

  await assert.rejects(
    main({
      argv: ['--case', 'SMOKE-001'],
      config: settings,
      clearCheckpoint: () => {},
      loadCheckpoint: () => new Set(),
      loadSuite: async () => ({
        cases: ['SMOKE-001'],
        runCase: async () => {
          throw new Error('unit stop')
        }
      }),
      launchBrowser: async () => {
        throw new Error('browser must not be launched in this test: Authorization: Bearer unit-password')
      },
      writeProgress: (record, options) => {
        phases.push(record.cases.at(-1)?.status || 'EMPTY')
        return writeProgress(record, options)
      },
      reconcileCheckpoint: () => {}
    }),
    /browser must not be launched/
  )

  assert.ok(phases.includes('RUNNING'))
  const runDirectories = fs.readdirSync(root)
  assert.equal(runDirectories.length, 1)
  const result = JSON.parse(fs.readFileSync(
    path.join(root, runDirectories[0], 'result.json'), 'utf8'
  ))
  const progress = JSON.parse(fs.readFileSync(
    path.join(root, runDirectories[0], 'progress.json'), 'utf8'
  ))
  assert.match(result.runError.message, /\[REDACTED\]/)
  assert.equal(result.runError.message.includes('unit-password'), false)
  assert.equal(progress.phase, 'STOPPED')
})

test('unfinished reports are persisted without claiming PASS', async (t) => {
  const root = temporaryRoot(t)
  const record = recordFor('PASS', 'CASE-PASS')
  const pending = createCaseRecord({ id: 'CASE-PENDING', suite: 'unit', title: 'pending case' })
  record.selectedCases.push('CASE-PENDING')
  record.cases.push(pending)

  const report = await writeReport(record, { outputRoot: root })
  const result = JSON.parse(fs.readFileSync(report.resultFile, 'utf8'))
  const progress = JSON.parse(fs.readFileSync(path.join(report.outputDir, 'progress.json'), 'utf8'))

  assert.equal(record.runStatus, 'INCOMPLETE')
  assert.equal(record.passed, false)
  assert.equal(isRunPassed(record), false)
  assert.equal(result.passed, false)
  assert.equal(result.finishedAt, undefined)
  assert.equal(progress.phase, 'STOPPED')
  assert.equal(progress.passed, undefined)
  assert.equal(progress.pendingCases[0], 'CASE-PENDING')
})

test('runtime exceptions are saved in result and progress with secrets redacted', async (t) => {
  const root = temporaryRoot(t)
  const secret = 'unit-password-123'
  const record = recordFor('RUNNING', 'CASE-ERROR')
  record.runError = new Error(`request failed: Authorization: Bearer ${secret}`)

  const report = await writeReport(record, {
    outputRoot: root,
    settings: { password: secret, nested: { accessToken: secret } }
  })
  const resultText = fs.readFileSync(report.resultFile, 'utf8')
  const progressText = fs.readFileSync(path.join(report.outputDir, 'progress.json'), 'utf8')
  const result = JSON.parse(resultText)
  const progress = JSON.parse(progressText)

  assert.equal(result.runError.message.includes(secret), false)
  assert.equal(progress.runError.message.includes(secret), false)
  assert.match(result.runError.message, /\[REDACTED\]/)
  assert.match(progress.runError.message, /\[REDACTED\]/)
})

test('teardown failure changes a previously passing case to FAIL', async () => {
  const record = recordFor('PASS', 'CASE-TEARDOWN')

  await finalizeSuiteSessions(new Map([
    ['unit', { teardownRun: async () => { throw new Error('cleanup secret failure') } }]
  ]), record)

  assert.equal(record.cases[0].status, 'FAIL')
  assert.equal(record.cases[0].checks.at(-1).passed, false)
  assert.equal(isRunPassed(record), false)
})

test('atomicWriteFile replaces complete contents and cleans failed temporary writes', (t) => {
  const root = temporaryRoot(t)
  const file = path.join(root, 'nested', 'result.json')
  atomicWriteFile(file, 'old\n')
  atomicWriteFile(file, 'new\n')
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n')

  const failingFile = path.join(root, 'nested', 'failed.json')
  atomicWriteFile(failingFile, 'old\n')
  const failingFs = {
    ...fs,
    writeFileSync: () => {
      const error = new Error('disk full')
      error.code = 'ENOSPC'
      throw error
    }
  }
  assert.throws(
    () => atomicWriteFile(failingFile, 'new\n', { fileSystem: failingFs }),
    (error) => error instanceof ReportPersistenceError && error.code === 'E2E_REPORT_PERSISTENCE_FAILED'
  )
  assert.equal(fs.readFileSync(failingFile, 'utf8'), 'old\n')
  assert.deepEqual(fs.readdirSync(path.dirname(failingFile)), ['failed.json', 'result.json'])
})

test('report snapshots redact secrets in keys, messages, JSON strings, URLs, and errors', () => {
  const password = 'p@ss-unit-456'
  const token = 'token-unit-789'
  const snapshot = reportSnapshot({
    password,
    nested: {
      accessToken: token,
      payload: JSON.stringify({ token, password })
    },
    message: `password=${password}; Authorization: Bearer ${token}`,
    url: `https://user:${password}@example.test/path`,
    error: new Error(`cookie=${token}`)
  }, { settings: { password, token } })
  const serialized = JSON.stringify(snapshot)

  assert.equal(serialized.includes(password), false)
  assert.equal(serialized.includes(token), false)
  assert.match(serialized, /\[REDACTED\]/)
})

test('report snapshots replace circular references with a stable marker', () => {
  const payload = { name: 'cycle-unique-20261013' }
  payload.self = payload
  payload.child = { parent: payload }

  const snapshot = reportSnapshot(payload)

  assert.deepEqual(snapshot, {
    name: 'cycle-unique-20261013',
    self: '[Circular]',
    child: { parent: '[Circular]' }
  })
})

test('report paths reject unsafe run IDs and sanitize case IDs', (t) => {
  const root = temporaryRoot(t)
  const unsafe = recordFor('RUNNING', 'case/../../secret')
  unsafe.runId = '../escape'
  assert.throws(
    () => writeProgress(unsafe, { outputRoot: root }),
    /Unsafe report run ID/
  )

  const safe = safeCaseId('../secret/case')
  assert.match(safe, /^[A-Za-z0-9_-]+$/)
  assert.equal(safe.includes('/'), false)
  assert.equal(safe.includes('..'), false)
})

test('progress stores references instead of recursively serializing the run API payload', (t) => {
  const root = temporaryRoot(t)
  const record = recordFor('PASS', 'CASE-API')
  record.api = []
  record.api.push({ response: { status: 500 }, self: record.api })

  const locations = writeProgress(record, { outputRoot: root })
  const progress = JSON.parse(fs.readFileSync(locations.progressFile, 'utf8'))

  assert.equal(progress.api, undefined)
  assert.deepEqual(Object.keys(progress.results[0]).sort(), ['caseId', 'resultFile', 'status', 'suite'])
  assert.equal(typeof progress.results[0].resultFile, 'string')
})
