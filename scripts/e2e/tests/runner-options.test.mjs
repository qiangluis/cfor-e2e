import assert from 'node:assert/strict'
import test from 'node:test'
import {
  caseFailureAction,
  DEFAULT_CASE_TIMEOUT_MS,
  parseRunnerArgs,
  validateCaseTimeoutMs
} from '../lib/runner-options.mjs'

test('runner accepts repeated --case values and keeps a single case compatible', () => {
  const args = parseRunnerArgs([
    '--case', 'COST-005',
    '--case', 'COST-006',
    '--case', 'COST-005',
    '--continue-on-failure',
    '--case-timeout-ms', '240000'
  ])
  assert.deepEqual(args.caseIds, ['COST-005', 'COST-006'])
  assert.equal(args.continueOnFailure, true)
  assert.equal(args.caseTimeoutMs, 240000)

  const single = parseRunnerArgs(['--case', 'SMOKE-001'])
  assert.deepEqual(single.caseIds, ['SMOKE-001'])
  assert.equal(single.continueOnFailure, false)
})

test('runner failure mode is fail-stop by default and isolated only when explicit', () => {
  assert.equal(caseFailureAction('PASS'), 'continue')
  assert.equal(caseFailureAction('PARTIAL'), 'continue')
  assert.equal(caseFailureAction('FAIL'), 'stop')
  assert.equal(caseFailureAction('BLOCKED'), 'stop')
  assert.equal(caseFailureAction('FAIL', true), 'continue-isolated')
  assert.equal(caseFailureAction('BLOCKED', true), 'continue-isolated')
})

test('runner validates timeout without changing the existing default', () => {
  assert.equal(DEFAULT_CASE_TIMEOUT_MS, 180000)
  assert.equal(parseRunnerArgs([]).caseTimeoutMs, DEFAULT_CASE_TIMEOUT_MS)
  assert.throws(() => validateCaseTimeoutMs(999), /不小于 1000/)
  assert.throws(() => parseRunnerArgs(['--case']), /--case 缺少参数/)
})
