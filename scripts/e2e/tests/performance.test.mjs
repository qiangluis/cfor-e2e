import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizePagePerformance } from '../lib/performance.mjs'

test('the original five-second budget includes navigation and cannot pass a slow page', () => {
  assert.equal(summarizePagePerformance({}, 5000).withinBudget, true)
  assert.equal(summarizePagePerformance({}, 5001).withinBudget, false)
  assert.equal(summarizePagePerformance({}, 9383).withinBudget, false)
  for (const value of [NaN, Infinity, -1]) {
    assert.throws(() => summarizePagePerformance({}, value), /Invalid/)
  }
})

test('performance evidence is bounded, sorted and does not expose URL credentials', () => {
  const resources = Array.from({ length: 12 }, (_, index) => ({
    url: `http://user:secret@127.0.0.1:9151/asset-${index}?token=secret#private`,
    initiatorType: 'script',
    durationMs: 100 + index * 10,
    waitMs: 80 + index * 10
  }))
  resources.push({ url: 'password=secret', durationMs: 1 })
  const result = summarizePagePerformance({ resources }, 1200)
  assert.equal(result.slowResources.length, 10)
  assert.equal(result.slowResources[0].url, 'http://127.0.0.1:9151/asset-11')
  assert.equal(result.slowResources[0].durationMs, 210)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})
