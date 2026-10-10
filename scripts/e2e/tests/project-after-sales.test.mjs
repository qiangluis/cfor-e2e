import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildDedicatedProjectHandoverPayload,
  hasProjectFixture,
  isoWeekKey,
  isDedicatedProject,
  isBusinessRejected,
  parseRiskLevelHistory,
  PROJECT_REPORT_DEFINITIONS,
  resolveReportPeriodRange,
  validTaskLibraryConfig
} from '../suites/project-after-sales.mjs'

test('project-after-sales recognizes business rejection in an HTTP-success response', () => {
  assert.equal(
    isBusinessRejected({ code: 400, data: null, msg: '引用中不能删除' }, 400, '不能删除'),
    true
  )
  assert.equal(isBusinessRejected({ code: 0, data: true }, 400, '不能删除'), false)
  assert.equal(isBusinessRejected({ code: 200, success: true, data: true }, 400, '不能删除'), false)
})

test('project-after-sales distinguishes missing project facts from a failed page response', () => {
  assert.equal(hasProjectFixture({ code: 0, data: { list: [] } }), false)
  assert.equal(hasProjectFixture({ code: 0, data: { list: [{ id: 1 }] } }), true)
  assert.equal(hasProjectFixture({ code: 0, data: [] }), false)
})

test('task library accepts backend aliases and optional dependencies', () => {
  const task = { code: 'T1', name: '任务', standardHours: 8, deliverable: '方案', acceptance: '评审' }
  assert.equal(validTaskLibraryConfig({ tasks: [task] }), true)
  assert.equal(validTaskLibraryConfig({
    items: [{
      taskCode: 'T1', taskName: '任务', standardHours: 8,
      requiredOutput: '方案', acceptanceCriteria: '评审', predecessorIds: null
    }]
  }), true)
  assert.equal(validTaskLibraryConfig({ tasks: [task, { ...task, acceptance: '' }] }), false)
  assert.equal(validTaskLibraryConfig({ tasks: [{ ...task, predecessors: 'T0' }] }), false)
  assert.equal(validTaskLibraryConfig({ tasks: [] }), false)
  assert.equal(validTaskLibraryConfig({}), false)
})

test('dedicated project handover uses the formal empty-project create contract', () => {
  const payload = buildDedicatedProjectHandoverPayload({
    marker: 'E2E_PB117_PROJECT_ABC',
    projectType: 'TYPE_DEPENDENCY'
  })
  assert.deepEqual(payload, {
    sourceType: 'MANUAL',
    sourceBusinessNo: 'E2E_PB117_PROJECT_ABC',
    projectName: 'E2E_PB117_PROJECT_ABC 专属空项目',
    projectType: 'TYPE_DEPENDENCY',
    customerNameSnapshot: 'E2E_PB117_PROJECT_ABC',
    scopeIn: 'E2E_PB117_PROJECT_ABC',
    commitments: 'E2E_PB117_PROJECT_ABC',
    acceptanceConditions: 'E2E_PB117_PROJECT_ABC',
    initialRisks: 'E2E_PB117_PROJECT_ABC'
  })
})

test('dedicated project cleanup guard requires exact project and handover ownership', () => {
  const fixture = { projectId: '101', handoverId: '202', marker: 'E2E_PROJECT' }
  assert.equal(isDedicatedProject({ id: 101, handoverId: 202, customerNameSnapshot: 'E2E_PROJECT' }, fixture), true)
  assert.equal(isDedicatedProject({ id: 101, handoverId: 303, customerNameSnapshot: 'E2E_PROJECT' }, fixture), false)
  assert.equal(isDedicatedProject({ id: 999, handoverId: 202, customerNameSnapshot: 'E2E_PROJECT' }, fixture), false)
})

test('PB117 and PB118 do not select or restore the first shared project', () => {
  const suite = readFileSync(
    fileURLToPath(new URL('../suites/project-after-sales.mjs', import.meta.url)),
    'utf8'
  )
  assert.doesNotMatch(suite, /const sampleProject\s*=\s*listOf\(projectPage\)\[0\]/)
  assert.doesNotMatch(suite, /const project\s*=\s*listOf\(pageData\)\[0\]/)
  assert.match(suite, /'\/pm\/handover\/create'/)
  assert.match(suite, /restoreDedicatedProject\(api, fixture\)/)
})

test('PB945 report period keys resolve daily, ISO week and natural month ranges', () => {
  assert.deepEqual(resolveReportPeriodRange('DAILY', '2026-10-09'), ['2026-10-09', '2026-10-09'])
  assert.equal(isoWeekKey('2026-10-09'), '2026-W41')
  assert.deepEqual(resolveReportPeriodRange('WEEKLY', '2026-W41'), ['2026-10-05', '2026-10-11'])
  assert.deepEqual(resolveReportPeriodRange('MONTHLY', '2026-10'), ['2026-10-01', '2026-10-31'])
  assert.deepEqual(resolveReportPeriodRange('MONTHLY', '2024-02'), ['2024-02-01', '2024-02-29'])
  assert.equal(resolveReportPeriodRange('DAILY', '2026-10'), null)
  assert.equal(resolveReportPeriodRange('WEEKLY', '2026-W99'), null)
  assert.equal(resolveReportPeriodRange('MONTHLY', '2026-13'), null)
})

test('PB947 risk history parser keeps only valid array snapshots', () => {
  const history = [
    { previousLevel: 'LOW', currentLevel: 'HIGH', changedTime: '2026-10-09T10:00:00' }
  ]
  assert.deepEqual(parseRiskLevelHistory(JSON.stringify(history)), history)
  assert.deepEqual(parseRiskLevelHistory('{"previousLevel":"LOW"}'), [])
  assert.deepEqual(parseRiskLevelHistory('not-json'), [])
  assert.deepEqual(parseRiskLevelHistory(null), [])
})

test('PB953 report definitions cover the eleven report routes with unique type/path pairs', () => {
  assert.equal(PROJECT_REPORT_DEFINITIONS.length, 11)
  assert.equal(new Set(PROJECT_REPORT_DEFINITIONS.map((item) => item.reportType)).size, 11)
  assert.equal(new Set(PROJECT_REPORT_DEFINITIONS.map((item) => item.path)).size, 11)
  assert.deepEqual(
    PROJECT_REPORT_DEFINITIONS.map((item) => item.reportType),
    [
      'PROJECT_PROGRESS',
      'TASK_EXECUTION',
      'RESEARCH',
      'RISK_ISSUE_BUG',
      'PLAN_CHANGE',
      'RELEASE',
      'GO_LIVE_ISSUE',
      'ACCEPTANCE_RECTIFICATION',
      'PROJECT_REVIEW',
      'AFTER_SALES_HANDOVER',
      'PROJECT_CLOSEOUT'
    ]
  )
})
