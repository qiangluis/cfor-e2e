import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { acceptanceIsComplete, caseOutcome } from '../lib/report.mjs'

test('any explicit unresolved assertion prevents every completion claim from producing PASS', () => {
  for (let index = 0; index < 4; index++) {
    const candidates = Array(4).fill(false)
    candidates[index] = true
    const acceptanceComplete = acceptanceIsComplete({
      candidates, remainingAssertions: ['organization scope still unverified']
    })
    assert.equal(acceptanceComplete, false)
    assert.equal(caseOutcome({
      partial: true, hasAssertions: true, result: { acceptanceComplete }
    }).status, 'PARTIAL')
  }
})

test('verified complete cases and legacy cases without a remaining list retain their completion gate', () => {
  assert.equal(acceptanceIsComplete({ candidates: [true], remainingAssertions: [] }), true)
  assert.equal(acceptanceIsComplete({ candidates: [true] }), true)
  assert.equal(acceptanceIsComplete({ candidates: [false, undefined] }), false)
  assert.equal(acceptanceIsComplete({ candidates: ['true'] }), false)
})

test('failed checks and malformed remaining lists cannot be bypassed by completion claims', () => {
  assert.equal(acceptanceIsComplete({
    candidates: [true], remainingAssertions: [], failedChecks: [{ passed: false }]
  }), false)
  for (const remainingAssertions of [null, '', {}, 'unverified']) {
    assert.equal(acceptanceIsComplete({ candidates: [true], remainingAssertions }), false)
  }
})

test('the runner supplies all completion candidates and the actual unresolved list to the gate', () => {
  const source = fs.readFileSync(new URL('../runner.mjs', import.meta.url), 'utf8')
  assert.match(source, /acceptanceComplete = acceptanceIsComplete\(\{/)
  assert.match(source, /remainingAssertions: caseRecord\.remainingAssertions/)
  assert.match(source, /Boolean\(caseRecord\.remainingAssertions\?\.length\)/)
})
