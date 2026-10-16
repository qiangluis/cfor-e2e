import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  rdmMetricTruth, matchesRdmMetricTruth, RDM_COMPATIBLE_STATUSES,
  RDM_ALLOWED_TRANSITIONS, RDM_LEGACY_STAGES, RDM_ASSERTION_BINDINGS, createRdmFixture
} from '../fixtures/rdm.mjs'

test('independent facts calculate cycles, cancelled task exclusion, on-time denominator and density', () => {
  const rows = [
    ['requirement', '1', 'ACCEPTED', '1000', '87400'],
    ['requirement', '2', 'CONFIRMED', '1000', ''],
    ['requirement', '3', 'DRAFT', '1000', ''],
    ['task', '4', 'COMPLETED'],
    ['task', '5', 'IN_PROGRESS'],
    ['task', '6', 'CANCELLED'],
    ['iteration', '7', 'COMPLETED', '2026-10-13', '2026-10-13'],
    ['iteration', '8', 'COMPLETED', '2026-10-12', '2026-10-13'],
    ['iteration', '9', 'DRAFT', '2026-10-13', ''],
    ['bug', '10', 'OPEN'],
    ['worklog', '11', '7']
  ]
  assert.deepEqual(rdmMetricTruth(rows, true), {
    requirementAverageCycleDays: 1, taskCompletionRate: 50,
    versionOnTimeRate: 50, defectDensity: 0.5, rdWorkHours: 7
  })
  assert.equal(rdmMetricTruth(rows, false).rdWorkHours, null)
})

test('empty denominators remain null rather than false successful zero metrics', () => {
  assert.deepEqual(rdmMetricTruth([], false), {
    requirementAverageCycleDays: null, taskCompletionRate: null,
    versionOnTimeRate: null, defectDensity: null, rdWorkHours: null
  })
  assert.equal(rdmMetricTruth([], true).rdWorkHours, 0)
})

test('metric comparison rejects missing, wrong numeric values and stringified/null values', () => {
  const truth = rdmMetricTruth([['worklog', '1', '7']], true)
  assert.equal(matchesRdmMetricTruth(truth, truth), true)
  for (const invalid of [{}, { ...truth, rdWorkHours: 0 }, { ...truth, rdWorkHours: '7' },
    { ...truth, defectDensity: 0 }]) {
    assert.equal(matchesRdmMetricTruth(invalid, truth), false)
  }
})

test('RDM003 covers every existing compatibility alias and stage plus all 36 standard pairs', () => {
  assert.equal(Object.values(RDM_COMPATIBLE_STATUSES).flat().length, 27)
  assert.deepEqual(RDM_LEGACY_STAGES, ['REVIEW', 'APPROVING', 'PILOT', 'MASS'])
  assert.deepEqual(RDM_ALLOWED_TRANSITIONS.CLOSED, ['CLOSED'])
  assert.deepEqual(RDM_ALLOWED_TRANSITIONS.CANCELLED, ['CANCELLED'])
  assert.equal(Object.keys(RDM_ALLOWED_TRANSITIONS).length ** 2, 36)
  const source = fs.readFileSync(new URL('../fixtures/rdm.mjs', import.meta.url), 'utf8')
  assert.match(source, /expectedCode: 2003005006/)
  assert.match(source, /matrix\.length === 36/)
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE pm_project_task|UPDATE plm_rdm_project)/i)
})

test('RDM002 unreachable blank-condition BLOCKED sample stays GAP, RDM005/006 stay GAP', () => {
  assert.match(RDM_ASSERTION_BINDINGS['RDM-002'][2][2], /不能替代/)
  assert.match(RDM_ASSERTION_BINDINGS['RDM-005'][2][2], /dry-run/)
  assert.match(RDM_ASSERTION_BINDINGS['RDM-006'][2][2], /备份或回滚/)
})

test('RDM007 evidence requires browser query, nonempty owned facts and explicit mapping control', () => {
  const source = fs.readFileSync(new URL('../fixtures/rdm.mjs', import.meta.url), 'utf8')
  const suite = fs.readFileSync(new URL('../suites/pms-rdm.mjs', import.meta.url), 'utf8')
  assert.match(source, /actualHours: 7/)
  assert.match(source, /createRdmFixture\(\{ api, caseRecord, caseId: 'RDM-007' \}\)/)
  assert.match(source, /mapped\?\.rdWorkHours === 7/)
  assert.match(source, /pm\?\.pmsProjectId != null/)
  assert.match(suite, /getByRole\('button', \{ name: '查询', exact: true \}\)\.click/)
  assert.match(suite, /controlProjectId/)
  assert.match(suite, /matchesRdmMetricTruth\(browserReport, fixture\.metricTruth\)/)
})

test('RDM007 owned same-name project fits the formal PMS 31-character limit', async () => {
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const fixture = await createRdmFixture({
    caseId: 'RDM-007', caseRecord, writeSafety: async () => {},
    api: { getBusiness: async (path) => ({ code: 0, data: path === '/system/user/profile/get'
      ? { id: '1', username: 'admin' } : [{ configCode: 'DIGITAL', versionNo: 1 }] }) }
  })
  assert.match(fixture.tag, /^E2E-RDM-RDM007-[a-f0-9]{12}$/)
  assert.ok(`${fixture.tag}-PM`.length <= 31)
})
