import test from 'node:test'
import assert from 'node:assert/strict'
import { openingDateMatches } from '../suites/fms.mjs'

test('openingDateMatches accepts the backend LocalDate array response', () => {
  assert.equal(openingDateMatches([2026, 10, 6]), true)
  assert.equal(openingDateMatches([2026, 10, 7]), false)
})

test('openingDateMatches accepts the backend ISO date response', () => {
  assert.equal(openingDateMatches('2026-10-06'), true)
  assert.equal(openingDateMatches('2026-10-06T00:00:00'), true)
  assert.equal(openingDateMatches('2026-10-07'), false)
})
