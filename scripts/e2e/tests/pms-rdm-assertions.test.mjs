import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  RDM_ASSERTION_BINDINGS, initializeRdmAssertions, finalizeRdmAssertions
} from '../fixtures/rdm.mjs'
import { acceptanceIsComplete } from '../lib/report.mjs'

const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const definitions = catalog.suites.find((suite) => suite.id === 'rdm-pms').cases
const record = () => ({ checks: [], notes: [], evidence: [] })
const completeChecks = (caseId) => [...new Set(
  RDM_ASSERTION_BINDINGS[caseId].flatMap(([, names]) => names)
)].map((name) => ({ name, passed: true, details: 'unit-test evidence' }))

test('RDM mappings preserve every original catalog assertion and its exact index', () => {
  assert.deepEqual(Object.keys(RDM_ASSERTION_BINDINGS), definitions.map((row) => row.id))
  for (const definition of definitions) {
    const caseRecord = record()
    initializeRdmAssertions(caseRecord, definition.id)
    assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.assertion), definition.assertions)
    assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.index), definition.assertions.map((_, index) => index))
    assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP' && row.evidenceChecks.length > 0))
  }
})

for (const definition of definitions) {
  const caseId = definition.id
  test(`${caseId}: missing evidence stays GAP and returns partial`, () => {
    const caseRecord = record()
    initializeRdmAssertions(caseRecord, caseId)
    const result = finalizeRdmAssertions(caseRecord, caseId)
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
    assert.ok(caseRecord.catalogAssertions.every((row) => /缺失或失败/.test(row.details)))
  })

  test(`${caseId}: exact current checks are bound; known limitations cannot become VERIFIED`, () => {
    const caseRecord = record()
    initializeRdmAssertions(caseRecord, caseId)
    caseRecord.checks.push(...completeChecks(caseId))
    const result = finalizeRdmAssertions(caseRecord, caseId)
    assert.equal(result.partial, !['RDM-001', 'RDM-003', 'RDM-004', 'RDM-007'].includes(caseId))
    for (const [index, [, names, gap]] of RDM_ASSERTION_BINDINGS[caseId].entries()) {
      const row = caseRecord.catalogAssertions[index]
      assert.equal(row.status, gap ? 'GAP' : 'VERIFIED')
      assert.deepEqual(row.evidenceChecks, names)
      for (const name of names) assert.ok(caseRecord.checks.some((check) => check.name === name))
    }
    if (result.partial) {
      assert.equal(acceptanceIsComplete({
        failedChecks: [], remainingAssertions: caseRecord.remainingAssertions,
        candidates: [result.acceptanceComplete, caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED')]
      }), false)
    }
  })

  test(`${caseId}: old checks and read-only evidence cannot complete a write mapping`, () => {
    const caseRecord = record()
    caseRecord.checks.push(...completeChecks(caseId))
    initializeRdmAssertions(caseRecord, caseId)
    finalizeRdmAssertions(caseRecord, caseId)
    assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
    caseRecord.checks.push(...completeChecks(caseId))
    const result = finalizeRdmAssertions(caseRecord, caseId, { readOnly: true })
    assert.equal(result.partial, true)
    assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
  })
}

for (const passed of [false, undefined, 'true', 1]) {
  test(`a non-boolean-success check (${String(passed)}) cannot verify an assertion`, () => {
    const caseRecord = record()
    initializeRdmAssertions(caseRecord, 'RDM-001')
    caseRecord.checks.push(...completeChecks('RDM-001'))
    caseRecord.checks[0].passed = passed
    assert.equal(finalizeRdmAssertions(caseRecord, 'RDM-001').partial, true)
    assert.equal(caseRecord.catalogAssertions[0].status, 'GAP')
  })
}

test('a missing named check is not replaced by unrelated or duplicate successful checks', () => {
  const caseRecord = record()
  initializeRdmAssertions(caseRecord, 'RDM-001')
  caseRecord.checks.push(...completeChecks('RDM-001').slice(1))
  caseRecord.checks.push({ name: 'HTTP 200', passed: true })
  caseRecord.checks.push(caseRecord.checks[0])
  assert.equal(finalizeRdmAssertions(caseRecord, 'RDM-001').partial, true)
  assert.equal(caseRecord.catalogAssertions[0].status, 'GAP')
})

test('RDM005 keeps the production conversion assertion incomplete when only dry-run preview is evidenced', () => {
  const caseRecord = record()
  initializeRdmAssertions(caseRecord, 'RDM-005')
  caseRecord.checks.push(...completeChecks('RDM-005'))
  assert.equal(finalizeRdmAssertions(caseRecord, 'RDM-005').partial, true)
  assert.equal(caseRecord.catalogAssertions[2].status, 'GAP')
  assert.match(caseRecord.catalogAssertions[2].details, /正式生产 BOM/)
  assert.ok(caseRecord.remainingAssertions.length > 0)
})
