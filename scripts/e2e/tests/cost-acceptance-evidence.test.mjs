import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  costCatalogBindings,
  costCatalogEvidence,
  isSoftDeletedValue
} from '../suites/cost.mjs'

const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const definitions = Object.fromEntries(catalog.suites
  .flatMap((suite) => suite.cases)
  .filter((item) => item.id.startsWith('COST-'))
  .map((item) => [item.id, item]))

const completeCases = new Set([
  'COST-001', 'COST-002', 'COST-003', 'COST-022', 'COST-023', 'COST-028',
  'COST-030', 'COST-031', 'COST-032', 'COST-033'
])
const boundNames = (caseId) => [...new Set(Object.values(costCatalogBindings[caseId] || {}).flat())]
const record = (checks = []) => ({ checks, notes: [] })
const fact = (name, passed = true) => ({ name, passed, details: name })

test('every COST catalog assertion is retained verbatim and only exact mapped checks verify it', () => {
  for (const [caseId, definition] of Object.entries(definitions)) {
    const result = record(boundNames(caseId).map((name) => fact(name)))
    costCatalogEvidence(caseId, result)

    assert.deepEqual(result.catalogAssertions.map((item) => item.assertion), definition.assertions, caseId)
    assert.deepEqual(result.catalogAssertions.map((item) => item.index),
      definition.assertions.map((_, index) => index), caseId)
    assert.equal(result.passCandidate, completeCases.has(caseId), `${caseId}: pass candidate`)
    if (completeCases.has(caseId)) {
      assert.ok(result.catalogAssertions.every((item) => item.status === 'VERIFIED'), caseId)
      assert.deepEqual(result.remainingAssertions, [], caseId)
    } else {
      assert.ok(result.catalogAssertions.some((item) => item.status === 'GAP'), caseId)
      assert.ok(result.remainingAssertions.length > 0, caseId)
    }
  }
})

test('COST evidence fails closed for missing, failed, duplicate, or only similarly named checks', () => {
  const caseId = 'COST-030'
  const names = boundNames(caseId)

  const missing = record(names.slice(1).map((name) => fact(name)))
  costCatalogEvidence(caseId, missing)
  assert.equal(missing.catalogAssertions[0].status, 'GAP')
  assert.equal(missing.passCandidate, false)

  const failed = record(names.map((name) => fact(name, name !== '来源规则随构成项一并保存')))
  costCatalogEvidence(caseId, failed)
  assert.equal(failed.catalogAssertions[3].status, 'GAP')
  assert.equal(failed.passCandidate, false)

  const duplicate = record([...names.map((name) => fact(name)), fact('来源规则随构成项一并保存')])
  costCatalogEvidence(caseId, duplicate)
  assert.equal(duplicate.catalogAssertions[3].status, 'GAP')
  assert.equal(duplicate.passCandidate, false)

  const similarlyNamed = record([fact('分摊规则正式接口按模型版本与月份返回列表')])
  costCatalogEvidence('COST-001', similarlyNamed)
  assert.ok(similarlyNamed.catalogAssertions.every((item) => item.status === 'GAP'))
  assert.equal(similarlyNamed.passCandidate, false)
})

test('one named check cannot be reused to prove separate original assertions', () => {
  const result = record([
    fact('proof'),
    fact('other')
  ])
  costCatalogEvidence('COST-033', result, {
    'COST-033': {
      0: ['proof'],
      1: ['proof']
    }
  })
  assert.ok(result.catalogAssertions.every((item) => item.status === 'GAP'))
  assert.equal(result.passCandidate, false)
})

test('COST-001 requires the dedicated three-mode write and readback evidence', () => {
  const names = boundNames('COST-001')
  const modeNames = costCatalogBindings['COST-001'][2]
  assert.equal(modeNames.length, 1)
  for (const checks of [
    names.filter((name) => !modeNames.includes(name)).map((name) => fact(name)),
    names.map((name) => fact(name, !modeNames.includes(name))),
    [...names.map((name) => fact(name)), fact(modeNames[0])]
  ]) {
    const result = record(checks)
    costCatalogEvidence('COST-001', result)
    assert.equal(result.catalogAssertions[2].status, 'GAP')
    assert.equal(result.passCandidate, false)
  }
})

test('cost cleanup recognizes MySQL BIT(1) soft-delete representations', () => {
  assert.equal(isSoftDeletedValue(true), true)
  assert.equal(isSoftDeletedValue(1), true)
  assert.equal(isSoftDeletedValue('1'), true)
  assert.equal(isSoftDeletedValue('\u0001'), true)
  assert.equal(isSoftDeletedValue(Buffer.from([1])), true)
  assert.equal(isSoftDeletedValue({ type: 'Buffer', data: [1] }), true)
  assert.equal(isSoftDeletedValue(false), false)
  assert.equal(isSoftDeletedValue(0), false)
  assert.equal(isSoftDeletedValue('\u0000'), false)
  assert.equal(isSoftDeletedValue({ type: 'Buffer', data: [0] }), false)
})
