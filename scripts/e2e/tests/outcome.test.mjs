import test from 'node:test'
import assert from 'node:assert/strict'
import { caseOutcome, caseErrorStatus } from '../lib/report.mjs'

test('failed assertions cannot be masked by partial implementation', () => {
  assert.equal(caseOutcome({
    failedChecks: [{ passed: false }],
    partial: true,
    hasAssertions: true,
    result: { notImplemented: true }
  }).status, 'FAIL')
})

test('passing implemented steps do not promote incomplete cases', () => {
  assert.equal(caseOutcome({
    failedChecks: [], partial: false, hasAssertions: true,
    result: { notImplemented: true, note: 'pending permission matrix' }
  }).status, 'PARTIAL')
  assert.equal(caseOutcome({
    failedChecks: [], partial: true, hasAssertions: true
  }).status, 'PARTIAL')
})

test('only complete cases with nonempty passing assertions pass', () => {
  assert.equal(caseOutcome({ failedChecks: [], hasAssertions: false }).status, 'PARTIAL')
  assert.equal(caseOutcome({ failedChecks: [], hasAssertions: true }).status, 'PASS')
})

test('mocked supplier smoke cannot run as real workflow acceptance', async () => {
  const suite = await import('../suites/supplier-portal.mjs')
  await assert.rejects(suite.runCase(), /^Error: BLOCKED:/)
})

test('mocked WMS receipt cannot run as real stock acceptance', async () => {
  const suite = await import('../suites/wms-operation.mjs')
  await assert.rejects(suite.runCase(), /^Error: BLOCKED:/)
})

test('later blocked prerequisites cannot hide an earlier business failure', () => {
  const error = new Error('BLOCKED: permission fixture unavailable')
  assert.equal(caseErrorStatus(error, [{ passed: false }]), 'FAIL')
  assert.equal(caseErrorStatus(error, [{ passed: true }]), 'BLOCKED')
  assert.equal(caseErrorStatus(new Error('unexpected failure')), 'FAIL')
})
