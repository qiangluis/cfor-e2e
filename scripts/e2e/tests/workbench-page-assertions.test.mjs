import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  recordWorkbenchPageAssertions,
  WORKBENCH_PAGE_ASSERTIONS
} from '../suites/workbench.mjs'

const catalog = JSON.parse(fs.readFileSync(
  new URL('../cases/catalog.json', import.meta.url), 'utf8'
))
const cases = catalog.suites.find((suite) => suite.id === 'workbench').cases

test('workbench page evidence keeps the exact original assertion order', () => {
  for (const [caseId, mappings] of Object.entries(WORKBENCH_PAGE_ASSERTIONS)) {
    assert.deepEqual(mappings.map(([assertion]) => assertion),
      cases.find((item) => item.id === caseId).assertions)
    const record = {
      checks: mappings.map(([, name]) => ({ name, passed: true, details: 'actual evidence' }))
    }
    assert.deepEqual(recordWorkbenchPageAssertions(caseId, record), {})
    assert.deepEqual(record.remainingAssertions, [])
    assert.ok(record.catalogAssertions.every((row, index) =>
      row.index === index && row.status === 'VERIFIED' && row.evidence === 'actual evidence'))
    assert.throws(() => recordWorkbenchPageAssertions(caseId, record), /重复/)
  }
})

test('absent, failed, conflicting or empty checks never count as verified', () => {
  const mappings = WORKBENCH_PAGE_ASSERTIONS['WBF-002']
  for (const checks of [
    [],
    mappings.map(([, name]) => ({ name, passed: false, details: 'failure' })),
    mappings.map(([, name]) => ({ name, passed: true, details: '' })),
    mappings.flatMap(([, name]) => [
      { name, passed: true, details: 'pass' },
      { name, passed: false, details: 'later failure' }
    ])
  ]) {
    const record = { checks }
    assert.equal(recordWorkbenchPageAssertions('WBF-002', record).partial, true)
    assert.equal(record.remainingAssertions.length, 2)
    assert.ok(record.catalogAssertions.every((row) => row.status === 'UNVERIFIED'))
  }
})
