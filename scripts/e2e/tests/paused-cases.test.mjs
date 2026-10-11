import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadPausedCatalog, pauseReasonFor } from '../lib/paused.mjs'

const catalogPath = fileURLToPath(new URL('../cases/catalog.json', import.meta.url))
const pausedPath = fileURLToPath(new URL('../cases/paused.json', import.meta.url))

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const allCases = catalog.suites.flatMap((suite) =>
  suite.cases.map((item) => ({ ...item, suite: suite.id })))
const byId = new Map(allCases.map((item) => [item.id, item]))
const paused = loadPausedCatalog(pausedPath)

test('paused catalog carries an explicit reason', () => {
  assert.ok(paused.reason.trim().length > 0, 'reason must be non-blank')
})

test('paused suite ids and case ids all exist in catalog', () => {
  const suiteIds = new Set(catalog.suites.map((suite) => suite.id))
  for (const suiteId of paused.suites) {
    assert.ok(suiteIds.has(suiteId), `unknown paused suite: ${suiteId}`)
  }
  for (const caseId of paused.cases) {
    assert.ok(byId.has(caseId), `unknown paused case: ${caseId}`)
  }
})

test('project management and workbench report cases are runnable', () => {
  assert.ok(!paused.suites.includes('project-after-sales'), 'project-after-sales suite is runnable')
  assert.ok(!paused.cases.includes('PMS-001'), 'PMS-001 is runnable')
  for (const caseId of ['WBF-004', 'WBF-008', 'WBF-012']) {
    assert.ok(!paused.cases.includes(caseId), `${caseId} runnable`)
  }
})

test('project-after-sales cases resolve to runnable', () => {
  const suite = catalog.suites.find((item) => item.id === 'project-after-sales')
  assert.ok(suite.cases.length > 0, 'project-after-sales has cases')
  for (const item of suite.cases) {
    assert.equal(pauseReasonFor({ ...item, suite: suite.id }, paused), '',
      `${item.id} must stay runnable`)
  }
})

test('workbench reports have no stale pause reason', () => {
  for (const caseId of ['WBF-004', 'WBF-008', 'WBF-012']) {
    const item = byId.get(caseId)
    assert.equal(pauseReasonFor(item, paused), '', `${caseId} runnable`)
  }
  assert.equal(pauseReasonFor(byId.get('PMS-001'), paused), '', 'PMS-001 stays runnable')
  assert.equal(pauseReasonFor(byId.get('WBF-005'), paused), '', 'non-paused case stays runnable')
  assert.equal(pauseReasonFor(byId.get('ERP-SALES-001'), paused), '', 'non-paused case stays runnable')
})

test('synthetic explicit pauses still resolve the reason without pausing real cases', () => {
  const synthetic = { reason: 'isolated pause mechanism test', suites: [], cases: ['WBF-004'] }
  assert.equal(pauseReasonFor(byId.get('WBF-004'), synthetic), synthetic.reason)
  assert.equal(pauseReasonFor(byId.get('WBF-008'), synthetic), '')
  const suitePause = { reason: 'isolated suite pause test', suites: ['project-after-sales'], cases: [] }
  assert.equal(pauseReasonFor({ id: 'PB111-001', suite: 'project-after-sales' }, suitePause), suitePause.reason)
})

test('missing pause file disables pausing entirely', () => {
  const empty = loadPausedCatalog(fileURLToPath(new URL('../cases/__absent__.json', import.meta.url)))
  assert.deepEqual(empty, { reason: '', suites: [], cases: [] })
  assert.equal(pauseReasonFor(byId.get('PB111-001'), empty), '')
})
