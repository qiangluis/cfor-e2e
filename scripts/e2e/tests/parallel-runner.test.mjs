import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allDefinitions,
  parallelSafeCases,
  partitionDefinitions,
  selectDefinitions,
  summarizeResults,
  validateCaseTimeoutMs
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
