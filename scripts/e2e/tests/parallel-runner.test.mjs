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
  groupDefinitionsBySuite,
  parallelSafeCases,
  parseParallelArgs,
  partitionDefinitions,
  processTreeHasExited,
  resultFromChildReport,
  runGroupedChild,
  runGroupedPool,
  runPool,
  selectDefinitions,
  summarizeResults,
  terminateProcessTree,
  validateCaseTimeoutMs,
  validateParallelPreflight,
  waitForChildExit
} from '../parallel-runner.mjs'

test('parallel CLI rejects unknown options and missing values before scheduling', () => {
  assert.equal(parseParallelArgs(['--help']).help, true)
  assert.equal(parseParallelArgs(['-h']).help, true)
  assert.deepEqual(parseParallelArgs(['--case', 'SMOKE-001', '--case', 'SMOKE-002']).cases,
    ['SMOKE-001', 'SMOKE-002'])
  for (const option of ['--case', '--suite', '--workers', '--case-timeout-ms', '--out']) {
    assert.throws(() => parseParallelArgs([option]), /缺少参数/)
    assert.throws(() => parseParallelArgs([option, '--plan']), /缺少参数/)
  }
  assert.throws(() => parseParallelArgs(['--cases', 'SMOKE-001']), /未知参数/)
})

test('both CLI help commands exit without opening browsers or writing evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-cli-help-test-'))
  try {
    for (const entry of ['runner.mjs', 'parallel-runner.mjs']) {
      const output = path.join(root, entry)
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL(`../${entry}`, import.meta.url)), '--help'
      ], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env, CFOR_E2E_OUT: output,
          CFOR_TARGET: 'local',
          CFOR_API_BASE: 'http://127.0.0.1:48083', CFOR_WEB_BASE: 'http://127.0.0.1:9151'
        }
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Usage:/)
      assert.doesNotMatch(result.stdout, /\[RUN|\[parallel\] RUN|\[e2e\]/)
      assert.equal(fs.existsSync(output), false)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('parallel plan keeps safe cases disjoint from serial cases', () => {
  const { parallel, serial } = partitionDefinitions(allDefinitions())
  const parallelIds = new Set(parallel.map((item) => item.id))
  const serialIds = new Set(serial.map((item) => item.id))
  assert.equal([...parallelIds].some((id) => serialIds.has(id)), false)
  assert.ok(parallelIds.size > 0)
  assert.ok(serialIds.size > 0)
})

test('parallel safe cases are grouped by suite for session reuse', () => {
  const groups = groupDefinitionsBySuite([
    { id: 'A', suite: 'workbench' },
    { id: 'B', suite: 'workbench' },
    { id: 'C', suite: 'procurement' }
  ])
  assert.deepEqual(groups.map((group) => group.suite), ['workbench', 'procurement'])
  assert.deepEqual(groups[0].definitions.map((item) => item.id), ['A', 'B'])
  assert.deepEqual(groups[1].definitions.map((item) => item.id), ['C'])
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

test('suite filtering rejects unknown suites and supports all as an explicit wildcard', () => {
  assert.throws(
    () => selectDefinitions({ suites: ['smoke', 'typo-suite'] }),
    /未知 suite：typo-suite/
  )
  const selected = selectDefinitions({
    definitions: [
      { id: 'A', suite: 'alpha' },
      { id: 'B', suite: 'beta' }
    ],
    suites: ['all'],
    safeOnly: false
  })
  assert.deepEqual(selected.map((item) => item.id), ['A', 'B'])
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

test('owned write fixtures cannot enter the automatic read-only worker pool', () => {
  const writeCases = [
    'PROC-005', 'QUALITY-METRIC-001',
    'RDM-001', 'RDM-002', 'RDM-003', 'RDM-004', 'RDM-005', 'RDM-006'
  ]
  for (const caseId of writeCases) {
    assert.equal(parallelSafeCases.has(caseId), false, caseId)
    assert.throws(() => selectDefinitions({ cases: [caseId] }), /不属于并行只读池/)
  }
})

test('read-only WBF-008 is eligible for the parallel pool', () => {
  assert.equal(parallelSafeCases.has('WBF-008'), true)
  assert.equal(parallelSafeCases.has('WBF-005'), true)
})

test('MES-PROD-003 stays serial because its material fixture can be referenced by procurement', () => {
  assert.equal(parallelSafeCases.has('MES-PROD-003'), false)
  const { serial } = partitionDefinitions(allDefinitions())
  assert.equal(serial.some((item) => item.id === 'MES-PROD-003'), true)
})

test('outsource draft builders stay serial because GET probes allocate bill numbers', () => {
  assert.equal(parallelSafeCases.has('PB151-OUTSOURCE-RECEIPT-QUALITY-001'), false)
  assert.equal(parallelSafeCases.has('PB153-OUTSOURCE-MATERIAL-001'), false)
  const { serial } = partitionDefinitions(allDefinitions())
  const serialIds = new Set(serial.map((item) => item.id))
  assert.equal(serialIds.has('PB151-OUTSOURCE-RECEIPT-QUALITY-001'), true)
  assert.equal(serialIds.has('PB153-OUTSOURCE-MATERIAL-001'), true)
})

test('RDM progress report stays serial after an unexplained parallel timeout', () => {
  assert.equal(parallelSafeCases.has('RDM-007'), false)
  const { serial } = partitionDefinitions(allDefinitions())
  assert.equal(serial.some((item) => item.id === 'RDM-007'), true)
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

test('a grouped runner may exit 1 for another case without invalidating PASS cases', () => {
  const result = resultFromChildReport({
    definition: { id: 'A', suite: 'unit', title: 'A' },
    record: {
      cases: [
        { id: 'A', status: 'PASS', notes: [] },
        { id: 'B', status: 'FAIL', notes: ['断言失败'] }
      ]
    },
    exitCode: 1,
    signal: null,
    grouped: true
  })
  assert.equal(result.status, 'PASS')
})

test('grouped exit 1 with an all-PASS report is still an error', () => {
  const result = resultFromChildReport({
    definition: { id: 'A', suite: 'unit', title: 'A' },
    record: { cases: [{ id: 'A', status: 'PASS', notes: [] }] },
    exitCode: 1,
    signal: null,
    grouped: true
  })
  assert.equal(result.status, 'ERROR')
})

test('grouped child starts one runner with shared-session flags and maps each case report', async (t) => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-grouped-child-'))
  t.after(() => fs.rmSync(batchDir, { recursive: true, force: true }))
  const definitions = [
    { id: 'A', suite: 'workbench', title: 'A' },
    { id: 'B', suite: 'workbench', title: 'B' }
  ]
  const calls = []
  const child = new EventEmitter()
  const resultPromise = runGroupedChild({
    definitions,
    batchDir,
    headless: false,
    caseTimeoutMs: 1000,
    spawnChild: (_executable, args, options) => {
      calls.push({ args, options })
      const groupDir = path.join(batchDir, 'workers', 'workbench')
      fs.writeFileSync(
        path.join(groupDir, 'result.json'),
        JSON.stringify({
          cases: [
            { id: 'A', status: 'PASS', notes: [] },
            { id: 'B', status: 'FAIL', notes: ['断言失败'] }
          ]
        })
      )
      setImmediate(() => child.emit('close', 1, null))
      return child
    },
    terminateChild: () => () => {},
    processTreeExited: () => true
  })
  const result = await resultPromise

  assert.equal(calls.length, 1)
  const { args, options } = calls[0]
  assert.deepEqual(
    args.filter((value) => value === '--case').length,
    2
  )
  assert.deepEqual(
    args.slice(0, 5),
    [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../runner.mjs'),
      '--case',
      'A',
      '--case',
      'B'
    ]
  )
  assert.ok(args.includes('--reuse-session'))
  assert.ok(args.includes('--continue-on-failure'))
  assert.ok(args.includes('--headed'))
  assert.equal(options.env.CFOR_E2E_OUT, path.join(batchDir, 'workers', 'workbench'))
  assert.deepEqual(result.results.map((item) => item.status), ['PASS', 'FAIL'])
  assert.equal(result.results[0].report, path.join(batchDir, 'workers', 'workbench', 'result.json'))
})

test('grouped child rejects mixed suites and duplicate case ids', async () => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-grouped-validation-'))
  try {
    assert.throws(
      () => runGroupedChild({
        definitions: [{ id: 'A', suite: 'one' }, { id: 'B', suite: 'two' }],
        batchDir,
        headless: true,
        caseTimeoutMs: 1000,
        spawnChild: () => { throw new Error('must not spawn') }
      }),
      /只能运行同一 suite/
    )
    assert.throws(
      () => runGroupedChild({
        definitions: [{ id: 'A', suite: 'one' }, { id: 'A', suite: 'one' }],
        batchDir,
        headless: true,
        caseTimeoutMs: 1000,
        spawnChild: () => { throw new Error('must not spawn') }
      }),
      /不能包含重复/
    )
  } finally {
    fs.rmSync(batchDir, { recursive: true, force: true })
  }
})

test('grouped pool runs one unit per suite and keeps queued cases together when aborted', async () => {
  const groups = [
    {
      groupId: 'one',
      suite: 'one',
      definitions: [{ id: 'A', suite: 'one' }, { id: 'B', suite: 'one' }]
    },
    {
      groupId: 'two',
      suite: 'two',
      definitions: [{ id: 'C', suite: 'two' }]
    }
  ]
  const started = []
  const results = await runGroupedPool(
    groups,
    { workers: 1 },
    async ({ group, definitions }) => {
      started.push(group.suite)
      return {
        groupId: group.groupId,
        definitions,
        terminationWaitTimedOut: true,
        results: definitions.map((definition) => ({
          caseId: definition.id,
          suite: definition.suite,
          status: 'ERROR'
        }))
      }
    }
  )
  assert.deepEqual(started, ['one'])
  assert.equal(results.length, 2)
  assert.deepEqual(results[1].results.map((item) => item.caseId), ['C'])
  assert.equal(results[1].results[0].status, 'SKIPPED')
  assert.equal(results[1].definitions.length, 1)
})

test('termination escalation can be cancelled after confirmed process-group exit', async () => {
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
    processTreeExited: () => true,
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

test('process-group probe accepts only ESRCH as confirmed exit', () => {
  assert.equal(processTreeHasExited({ pid: 12345 }, { kill: () => {} }), false)
  assert.equal(processTreeHasExited({ pid: 12345 }, {
    kill: () => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }) }
  }), process.platform !== 'win32')
  assert.equal(processTreeHasExited({ pid: 12345 }, {
    kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }
  }), false)
  assert.equal(processTreeHasExited({}), false)
})

test('root close does not cancel escalation or release worker while descendants survive', async (t) => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-parallel-descendants-'))
  t.after(() => fs.rmSync(batchDir, { recursive: true, force: true }))
  const events = []
  const groups = new Set()
  const definitions = ['A', 'B'].map((id) => ({ id, suite: 'unit', title: id }))
  const results = await runPool(definitions, {
    batchDir,
    workers: 1,
    caseTimeoutMs: 10,
    terminationTimeoutMs: 200,
    terminationPollMs: 5,
    spawnChild: (_executable, args) => {
      const child = new EventEmitter()
      child.caseId = args[args.indexOf('--case') + 1]
      child.pid = child.caseId === 'A' ? 12345 : 12346
      groups.add(-child.pid)
      events.push(`start:${child.caseId}`)
      return child
    },
    terminateChild: (child) => terminateProcessTree(child, {
      killDelayMs: 30,
      kill: (_pid, signal) => {
        if (signal === 'SIGTERM') {
          events.push(`close:${child.caseId}`)
          child.emit('close', null, 'SIGTERM')
        } else {
          events.push(`group-exit:${child.caseId}`)
          groups.delete(-child.pid)
        }
      }
    }),
    processTreeExited: (child) => !groups.has(-child.pid)
  })
  assert.ok(events.indexOf('start:B') > events.indexOf('group-exit:A'))
  assert.ok(events.indexOf('group-exit:A') > events.indexOf('close:A'))
  assert.equal(results.every((item) => item.timedOut && !item.terminationWaitTimedOut), true)
  assert.equal(results.every((item) => item.startedAt && item.finishedAt), true)
})

test('root close with unconfirmed surviving descendants aborts the next case', async (t) => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-parallel-survivors-'))
  t.after(() => fs.rmSync(batchDir, { recursive: true, force: true }))
  const started = []
  let cancelled = false
  const definitions = ['A', 'B'].map((id) => ({ id, suite: 'unit', title: id }))
  const results = await runPool(definitions, {
    batchDir,
    workers: 1,
    caseTimeoutMs: 10,
    terminationTimeoutMs: 30,
    terminationPollMs: 5,
    spawnChild: (_executable, args) => {
      const child = new EventEmitter()
      child.pid = 12345
      started.push(args[args.indexOf('--case') + 1])
      return child
    },
    terminateChild: (child) => {
      child.emit('close', null, 'SIGTERM')
      return () => { cancelled = true }
    },
    processTreeExited: () => false
  })
  assert.deepEqual(started, ['A'])
  assert.equal(results[0].terminationWaitTimedOut, true)
  assert.equal(results[1].status, 'SKIPPED')
  assert.equal(cancelled, false)
})
