import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  allDefinitions,
  parallelSafeCases,
  partitionDefinitions,
  resultFromChildReport,
  runPool,
  selectDefinitions,
  summarizeResults,
  terminateProcessTree,
  validateCaseTimeoutMs,
  validateParallelPreflight,
  waitForChildExit
} from '../parallel-runner.mjs'

test('parallel plan keeps safe cases disjoint from serial cases', () => {
  const { parallel, serial } = partitionDefinitions(allDefinitions())
  const parallelIds = new Set(parallel.map((item) => item.id))
  const serialIds = new Set(serial.map((item) => item.id))
  assert.equal([...parallelIds].some((id) => serialIds.has(id)), false)
  assert.ok(parallelIds.size > 0)
  assert.ok(serialIds.size > 0)
})

test('default selection excludes designed and blocked cases', () => {
  const selected = selectDefinitions()
  assert.ok(selected.length > 0)
  assert.equal(
    selected.some((item) => ['DESIGNED', 'BLOCKED'].includes(item.status)),
    false
  )
  assert.equal(
    selected.every((item) => parallelSafeCases.has(item.id)),
    true
  )
})

test('explicit case selection can run one safe case only', () => {
  const selected = selectDefinitions({ cases: ['SMOKE-001'] })
  assert.deepEqual(selected.map((item) => item.id), ['SMOKE-001'])
  assert.throws(() => selectDefinitions({ cases: ['DOES-NOT-EXIST'] }), /未知 case/)
})

test('explicit serial or unimplemented cases are rejected instead of silently omitted', () => {
  assert.throws(
    () => selectDefinitions({ cases: ['PB081-001'] }),
    /不属于并行只读池.*runner\.mjs/
  )
  assert.throws(
    () => selectDefinitions({ cases: ['INIT-002'] }),
    /不属于并行只读池.*runner\.mjs/
  )
})

test('mixed explicit selection cannot silently drop a requested case', () => {
  assert.throws(
    () => selectDefinitions({ cases: ['SMOKE-001', 'PB081-001'] }),
    /不属于并行只读池.*PB081-001/
  )
  assert.throws(
    () => selectDefinitions({ cases: ['SMOKE-001'], suites: ['procurement'] }),
    /指定 case 与 suite 不匹配.*SMOKE-001/
  )
  assert.throws(
    () => selectDefinitions({
      definitions: [{ id: 'SMOKE-001', suite: 'smoke', status: 'BLOCKED' }],
      cases: ['SMOKE-001']
    }),
    /不属于并行只读池.*SMOKE-001/
  )
})

test('batch summary exposes failures and partial cases for one retest list', () => {
  const summary = summarizeResults([
    { caseId: 'A', status: 'PASS' },
    { caseId: 'B', status: 'FAIL' },
    { caseId: 'C', status: 'PARTIAL' },
    { caseId: 'D', status: 'BLOCKED' },
    { caseId: 'E', status: 'ERROR' }
  ])
  assert.deepEqual(summary.counts, {
    PASS: 1,
    PARTIAL: 1,
    FAIL: 1,
    BLOCKED: 1,
    SKIPPED: 0,
    ERROR: 1
  })
  assert.deepEqual(summary.failedCaseIds, ['B', 'D', 'E'])
  assert.deepEqual(summary.partialCaseIds, ['C'])
})

test('parallel worker timeout must be a bounded integer', () => {
  assert.equal(validateCaseTimeoutMs(180000), 180000)
  assert.throws(() => validateCaseTimeoutMs(undefined), /不小于 1000/)
  assert.throws(() => validateCaseTimeoutMs(999), /不小于 1000/)
})

test('conditionally mutating quality cases stay in the serial pool', () => {
  const { parallel, serial } = partitionDefinitions(allDefinitions())
  const parallelIds = new Set(parallel.map((item) => item.id))
  const serialIds = new Set(serial.map((item) => item.id))
  assert.equal(parallelIds.has('QUALITY-NG-001'), false)
  assert.equal(parallelIds.has('QUALITY-TRACE-001'), false)
  assert.equal(serialIds.has('QUALITY-NG-001'), true)
  assert.equal(serialIds.has('QUALITY-TRACE-001'), true)
})

test('read-only WBF-008 is eligible for the parallel pool', () => {
  assert.equal(parallelSafeCases.has('WBF-008'), true)
  assert.equal(parallelSafeCases.has('WBF-005'), true)
})

test('outsource draft builders stay serial because GET probes allocate bill numbers', () => {
  assert.equal(parallelSafeCases.has('PB151-OUTSOURCE-RECEIPT-QUALITY-001'), false)
  assert.equal(parallelSafeCases.has('PB153-OUTSOURCE-MATERIAL-001'), false)
  const { serial } = partitionDefinitions(allDefinitions())
  const serialIds = new Set(serial.map((item) => item.id))
  assert.equal(serialIds.has('PB151-OUTSOURCE-RECEIPT-QUALITY-001'), true)
  assert.equal(serialIds.has('PB153-OUTSOURCE-MATERIAL-001'), true)
})

test('parallel preflight rejects missing login credentials before workers start', () => {
  assert.doesNotThrow(() => validateParallelPreflight({ password: 'unit-password' }))
  assert.throws(
    () => validateParallelPreflight({ password: '' }),
    /缺少 CFOR_PASSWORD\/CFOR_PASS/
  )
})

test('abnormal worker exit cannot be reported as PASS', () => {
  const result = resultFromChildReport({
    definition: { id: 'SMOKE-001', suite: 'smoke', title: 'smoke' },
    record: { cases: [{ id: 'SMOKE-001', status: 'PASS', notes: [] }] },
    report: '/tmp/result.json',
    exitCode: 1,
    signal: null,
    logFile: '/tmp/worker.log'
  })
  assert.equal(result.status, 'ERROR')
  assert.match(result.error, /不能接受 PASS 报告/)
})

test('worker shutdown is awaited before timeout result is settled', async () => {
  const child = new EventEmitter()
  const waiting = waitForChildExit(child)
  setTimeout(() => child.emit('close', 143, 'SIGTERM'), 20)
  assert.deepEqual(await waiting, { exitCode: 143, signal: 'SIGTERM' })
})

test('live child errors do not release the worker before close', async () => {
  const child = new EventEmitter()
  let settled = false
  const waiting = waitForChildExit(child).then((value) => {
    settled = true
    return value
  })
  const error = new Error('kill failed')
  child.emit('error', error)
  await Promise.resolve()
  assert.equal(settled, false)
  child.emit('close', 1, null)
  assert.deepEqual(await waiting, { exitCode: 1, signal: null, error })
})

test('expected PARTIAL exit 1 stays PARTIAL but fatal exits override stale reports', () => {
  const args = {
    definition: { id: 'A', suite: 'unit', title: 'A' },
    record: { cases: [{ id: 'A', status: 'PARTIAL' }] },
    exitCode: 1,
    signal: null
  }
  assert.equal(resultFromChildReport(args).status, 'PARTIAL')
  assert.equal(resultFromChildReport({ ...args, exitCode: 2 }).status, 'ERROR')
  assert.equal(resultFromChildReport({ ...args, signal: 'SIGTERM' }).status, 'ERROR')
})

test('termination escalation can be cancelled after confirmed close', async () => {
  const signals = []
  const cancel = terminateProcessTree({ pid: 12345 }, {
    kill: (pid, signal) => signals.push({ pid, signal }),
    killDelayMs: 20
  })
  cancel()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(signals.map((item) => item.signal), ['SIGTERM'])
})

test('timeout waits for actual close before the pool starts another case', async (t) => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-parallel-close-'))
  t.after(() => fs.rmSync(batchDir, { recursive: true, force: true }))
  const definitions = ['A', 'B'].map((id) => ({ id, suite: 'unit', title: id }))
  const events = []
  const options = {
    batchDir,
    workers: 1,
    caseTimeoutMs: 10,
    terminationTimeoutMs: 200,
    spawnChild: (_executable, args) => {
      const id = args[args.indexOf('--case') + 1]
      events.push(`start:${id}`)
      const child = new EventEmitter()
      child.pid = 12345
      child.caseId = id
      return child
    },
    terminateChild: (child) => {
      events.push(`terminate:${child.caseId}`)
      const timer = setTimeout(() => {
        events.push(`close:${child.caseId}`)
        child.emit('close', null, 'SIGTERM')
      }, 20)
      return () => clearTimeout(timer)
    }
  }
  const results = await runPool(definitions, options)
  assert.ok(events.indexOf('start:B') > events.indexOf('close:A'))
  assert.equal(results.length, 2)
  assert.equal(results.every((item) => item.timedOut), true)
  assert.equal(results.some((item) => item.terminationWaitTimedOut), false)
})

test('unconfirmed termination stops the entire queue and records unstarted cases', async (t) => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-parallel-abort-'))
  t.after(() => fs.rmSync(batchDir, { recursive: true, force: true }))
  const definitions = ['A', 'B', 'C'].map((id) => ({ id, suite: 'unit', title: id }))
  const children = []
  const results = await runPool(definitions, {
    batchDir,
    workers: 1,
    caseTimeoutMs: 10,
    terminationTimeoutMs: 20,
    spawnChild: () => {
      const child = new EventEmitter()
      children.push(child)
      return child
    },
    terminateChild: () => () => {}
  })
  assert.equal(children.length, 1)
  assert.equal(results[0].terminationWaitTimedOut, true)
  assert.deepEqual(
    results.filter((item) => item.blockedByProcessTermination).map((item) => item.caseId),
    ['B', 'C']
  )
  assert.equal(results.slice(1).every((item) => item.status === 'SKIPPED'), true)
  children[0].emit('close', null, 'SIGKILL')
})

test('one unsafe shutdown stops other workers from taking new cases', async () => {
  const started = []
  const definitions = ['A', 'B', 'C'].map((id) => ({ id, title: id }))
  const results = await runPool(definitions, { workers: 2 }, async ({ definition }) => {
    started.push(definition.id)
    await new Promise((resolve) => setTimeout(resolve, definition.id === 'A' ? 10 : 30))
    return {
      caseId: definition.id,
      status: definition.id === 'A' ? 'ERROR' : 'PASS',
      terminationWaitTimedOut: definition.id === 'A'
    }
  })
  assert.deepEqual(started, ['A', 'B'])
  assert.equal(results.find((item) => item.caseId === 'C').blockedByProcessTermination, true)
})

test('missing credentials fail CLI preflight without creating a batch or worker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-parallel-preflight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const execution = spawnSync(process.execPath, [
    'scripts/e2e/parallel-runner.mjs', '--case', 'SMOKE-001', '--out', root
  ], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, CFOR_TARGET: 'local', CFOR_PASSWORD: '', CFOR_PASS: '' },
    encoding: 'utf8'
  })
  assert.equal(execution.status, 2)
  assert.match(execution.stderr, /缺少 CFOR_PASSWORD\/CFOR_PASS/)
  assert.doesNotMatch(execution.stdout, /\[parallel\] RUN/)
  assert.deepEqual(fs.readdirSync(root), [])
})
