import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { recordPartnerCatalogEvidence } from '../fixtures/partner-acceptance-evidence.mjs'

const definition = JSON.parse(fs.readFileSync(
  new URL('../cases/catalog.json', import.meta.url), 'utf8'
)).suites.flatMap((suite) => suite.cases).find((row) => row.id === 'PB034-002')
const initial = () => ({ checks: [], notes: [`GAP: ${definition.acceptanceGaps[0]}`] })
const completeRecord = () => {
  const record = initial()
  recordPartnerCatalogEvidence(record, definition)
  record.checks = [...new Set(record.catalogAssertions.flatMap((row) => row.evidenceChecks))]
    .map((name) => ({ name, passed: true, details: 'Exact real evidence' }))
  return record
}

test('partner acceptance retains every original assertion and gap with nonempty evidence', () => {
  const record = initial()
  assert.equal(recordPartnerCatalogEvidence(record, definition), false)
  assert.deepEqual(record.catalogAssertions.map((row) => row.assertion),
    [...definition.assertions, ...definition.acceptanceGaps])
  assert(record.catalogAssertions.every((row) => row.status === 'GAP' && row.evidenceChecks.length > 0))
  assert.deepEqual(record.notes, initial().notes)
})

test('partner acceptance requires unique passing evidence for every role, view, CRM and isolation gate', () => {
  const record = completeRecord()
  assert.equal(recordPartnerCatalogEvidence(record, definition), true)
  assert.equal(record.catalogComplete, true)
  assert.deepEqual(record.notes, [])
  for (const name of record.checks.map((row) => row.name)) {
    for (const change of ['remove', 'fail', 'duplicate']) {
      const mutated = completeRecord()
      const check = mutated.checks.find((row) => row.name === name)
      if (change === 'remove') mutated.checks = mutated.checks.filter((row) => row !== check)
      if (change === 'fail') check.passed = false
      if (change === 'duplicate') mutated.checks.push({ ...check })
      assert.equal(recordPartnerCatalogEvidence(mutated, definition), false, `${change}: ${name}`)
    }
  }
})

test('partner acceptance cannot hide unrelated failed checks or catalog drift', () => {
  const record = completeRecord()
  record.checks.push({ name: 'Real browser failure', passed: false })
  assert.equal(recordPartnerCatalogEvidence(record, definition), false)
  assert.throws(() => recordPartnerCatalogEvidence(initial(),
    { ...definition, assertions: definition.assertions.slice(1) }), /re-audit/)
})
