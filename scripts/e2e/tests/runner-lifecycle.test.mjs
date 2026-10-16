import assert from 'node:assert/strict'
import test from 'node:test'
import { finalizeCaseRecord, runCaseWithTimeout } from '../runner.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('timeout closes the browser and drains late fixture writes before finalization or next case', async () => {
  const closed = deferred()
  const release = deferred()
  const events = []
  const fixtureRecord = { status: 'RUNNING', checks: [], notes: [] }
  const operation = (async () => {
    await closed.promise
    events.push('browser-closed')
    await release.promise
    fixtureRecord.status = 'PARTIAL'
    fixtureRecord.checks.push({ passed: false, name: 'interrupted UI' })
    events.push('fixture-settled')
  })()
  let finished = false
  const execution = runCaseWithTimeout(operation, 5, 'INIT-004', async () => {
    events.push('close-browser')
    closed.resolve()
  }).catch((error) => {
    fixtureRecord.status = 'FAIL'
    fixtureRecord.notes.push(error.message)
    finished = true
    events.push('finalize')
    return finalizeCaseRecord(fixtureRecord)
  })
  await closed.promise
  await Promise.resolve()
  assert.equal(finished, false)
  release.resolve()
  const report = await execution
  events.push('next-case')
  assert.deepEqual(events, [
    'close-browser', 'browser-closed', 'fixture-settled', 'finalize', 'next-case'
  ])
  assert.equal(report.status, 'FAIL')
  assert.match(report.notes[0], /INIT-004.*超过/)
  fixtureRecord.status = 'PARTIAL'
  fixtureRecord.checks[0].passed = true
  fixtureRecord.notes.push('late write')
  assert.equal(report.status, 'FAIL')
  assert.equal(report.checks[0].passed, false)
  assert.equal(report.notes.length, 1)
  assert.throws(() => { report.status = 'PARTIAL' }, TypeError)
  assert.throws(() => report.checks.push({ passed: true }), TypeError)
})

test('timeout consumes operation rejection after closing without replacing timeout error', async () => {
  const operation = deferred()
  await assert.rejects(
    runCaseWithTimeout(operation.promise, 5, 'PB-001', async () => {
      operation.reject(new Error('browser closed'))
    }),
    /案例 PB-001 超过 5ms/
  )
})

test('successful and failed operations preserve their result without timeout cleanup', async () => {
  let closes = 0
  const close = async () => { closes++ }
  const result = { partial: true }
  assert.equal(await runCaseWithTimeout(Promise.resolve(result), 100, 'OK', close), result)
  await assert.rejects(
    runCaseWithTimeout(Promise.reject(new Error('fixture failure')), 100, 'FAIL', close),
    /fixture failure/
  )
  assert.equal(closes, 0)
})

test('finalized case records tolerate runtime API functions and circular fixture references', () => {
  const fixture = { marker: 'owned-fixture', request: async () => ({}) }
  fixture.self = fixture
  const report = finalizeCaseRecord({
    status: 'PASS',
    checks: [],
    notes: [],
    fixture
  })

  assert.equal(report.fixture.request, '[Function]')
  assert.equal(report.fixture.self, '[Circular]')
  assert.throws(() => { report.fixture.marker = 'changed' }, TypeError)
})

test('cleanup failure still waits for the underlying fixture to settle', async () => {
  const release = deferred()
  const closing = deferred()
  let finished = false
  const execution = runCaseWithTimeout(release.promise, 5, 'PB-002', async () => {
    closing.resolve()
    throw new Error('cleanup failure')
  }).catch((error) => { finished = true; return error })
  await closing.promise
  await Promise.resolve()
  assert.equal(finished, false)
  release.resolve()
  const error = await execution
  assert.match(error.message, /案例 PB-002 超过 5ms/)
  assert.match(error.cause.message, /cleanup failure/)
})
