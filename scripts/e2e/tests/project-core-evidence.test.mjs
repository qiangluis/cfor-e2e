import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertProjectChangeLifecycle,
  assertProjectReportExportMatches,
  assertProjectTaskFactsUnchanged,
  planMilestoneWeightUpdates,
  PM_CHANGE_STATES
} from '../fixtures/project-core-evidence.mjs'
import { finalizeProjectAfterSalesCatalogAssertions } from '../suites/project-after-sales.mjs'

test('report read-only checks cover all formal dates, status and source identity', () => {
  const before = {
    id: '1', projectId: '2', status: 'PENDING_DISPATCH',
    plannedStartDate: '2026-10-01', plannedEndDate: '2026-10-02',
    actualStartTime: null, actualEndTime: null, completedTime: null,
    receiveTime: null, rejectedTime: null, reconfirmTime: null
  }
  assert.doesNotThrow(() => assertProjectTaskFactsUnchanged(before, { ...before }))
  for (const field of Object.keys(before)) {
    assert.throws(() => assertProjectTaskFactsUnchanged(before, { ...before, [field]: 'changed' }))
  }
  assert.throws(() => assertProjectTaskFactsUnchanged(before, null))
})

test('weight updates decrease first and respect the cap at every intermediate save', () => {
  const existing = [
    { id: '1', weightRate: 10, confirmed: false },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 2), weightRate: 15, confirmed: false
    }))
  ]
  let total = 100
  const updates = planMilestoneWeightUpdates(existing, 10)
  assert.ok(updates[0].weight < updates[0].item.weightRate)
  for (const { item, weight } of updates) {
    total += weight - item.weightRate
    assert.ok(total <= 100)
    assert.ok(weight > 0)
  }
  assert.equal(total + 10, 100)
})

test('weight planning never edits confirmed milestones and blocks exhausted budgets', () => {
  const locked = { id: '1', weightRate: 50, confirmed: true }
  const updates = planMilestoneWeightUpdates([
    locked, { id: '2', weightRate: 50, confirmed: false }
  ], 10)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].item.id, '2')
  assert.equal(updates[0].weight, 40)
  assert.deepEqual(planMilestoneWeightUpdates([], 10), [])
  assert.throws(() => planMilestoneWeightUpdates([{ ...locked, weightRate: 100 }], 10), /BLOCKED/)
  assert.throws(() => planMilestoneWeightUpdates([{ weightRate: 0 }], 10))
})

const changeHistory = () => PM_CHANGE_STATES.map((status, index) => ({
  id: '1', projectId: '2', changeNo: 'CHG-1', status,
  createTime: '2026-10-13T10:00:00',
  ...(index >= 3 ? { objectVersion: 1, downstreamStrategy: 'MANUAL' } : {}),
  ...(index >= 4 ? {
    executedTime: '2026-10-13T10:00:01', executionIdempotencyKey: 'OWNED',
    executedBy: '3', executeOwnerId: '3'
  } : {}),
  ...(index >= 5 ? { verifiedTime: '2026-10-13T10:00:02' } : {}),
  ...(index >= 6 ? { closedTime: '2026-10-13T10:00:03' } : {})
}))

test('lifecycle evidence requires every state and preserves all formal timestamps and execution facts', () => {
  assert.doesNotThrow(() => assertProjectChangeLifecycle(changeHistory()))
  assert.throws(() => assertProjectChangeLifecycle(changeHistory().slice(1)))
  for (const field of ['id', 'projectId', 'createTime', 'executedTime', 'verifiedTime',
    'executionIdempotencyKey', 'objectVersion', 'downstreamStrategy', 'executeOwnerId']) {
    const rows = changeHistory()
    rows.at(-1)[field] = 'changed'
    assert.throws(() => assertProjectChangeLifecycle(rows), field)
  }
  const reversed = changeHistory()
  reversed.at(-1).closedTime = '2026-10-13T09:00:00'
  assert.throws(() => assertProjectChangeLifecycle(reversed), /out of order/)
})

test('report export requires exact project/date/version and nonempty scalar metric agreement', () => {
  const query = { projectId: '2', startDate: '2026-10-12', endDate: '2026-10-14' }
  const report = {
    reportType: 'PROJECT_PROGRESS', metricVersion: 1, calculationMode: 'RECHECKED',
    appliedFilters: query, generatedAt: '2026-10-13T10:00:00', projectCount: 1,
    averageProgressRate: 0
  }
  const row = {
    ...report, appliedFilters: JSON.stringify(query), generatedAt: '2026-10-13T10:00:02'
  }
  assert.doesNotThrow(() => assertProjectReportExportMatches(report, row, query))
  assert.doesNotThrow(() => assertProjectReportExportMatches(report, {
    ...row, appliedFilters: JSON.stringify({
      ...query, startDate: [2026, 10, 12], endDate: [2026, 10, 14]
    })
  }, query))
  for (const field of Object.keys(query)) {
    assert.throws(() => assertProjectReportExportMatches(report, {
      ...row, appliedFilters: JSON.stringify({ ...query, [field]: 'changed' })
    }, query))
  }
  for (const field of ['metricVersion', 'projectCount', 'averageProgressRate', 'reportType']) {
    assert.throws(() => assertProjectReportExportMatches(report, { ...row, [field]: 'changed' }, query))
  }
})

test('new exact evidence completes each formerly incomplete assertion without accepting legacy checks', () => {
  const checks = {
    'PB945-001': [
      ...['DAILY', 'WEEKLY', 'MONTHLY'].map((type) =>
        `${type} 生成周期范围并由服务端构造只读来源快照`),
      '日报来源按当天过滤，周期外任务不进入快照',
      '报告生成不修改内外周期任务的完整正式事实和全部日期'
    ],
    'PB949-001': [
      '变更七个状态逐步正式回读且身份版本和全链路时间保持一致',
      '变更审批通过冻结对象版本并记录下游处理策略',
      '服务端一次性执行写入幂等键、执行人和执行时间',
      '重复幂等键被领域拒绝，不产生第二次执行',
      '重复执行拒绝后第二条变更仍停留在 APPROVED'
    ]
  }
  for (const [id, names] of Object.entries(checks)) {
    const result = { checks: names.map((name) => ({ name, passed: true })), notes: [] }
    assert.equal(finalizeProjectAfterSalesCatalogAssertions(result, id).acceptanceComplete, true)
    result.checks[0].passed = false
    assert.equal(finalizeProjectAfterSalesCatalogAssertions(result, id).acceptanceComplete, false)
  }
})

test('PB953 API and Excel success cannot complete the case without eleven real report pages', () => {
  const record = { checks: [], notes: [] }
  finalizeProjectAfterSalesCatalogAssertions(record, 'PB953-001')
  const required = [...new Set(record.catalogAssertions.flatMap((row) => row.evidenceChecks))]
  record.checks = required.map((name) => ({ name, passed: true }))
  assert.equal(finalizeProjectAfterSalesCatalogAssertions(record, 'PB953-001').acceptanceComplete, true)
  record.checks = record.checks.filter((check) =>
    check.name !== '十一类项目报表真实页面按专属项目日期逐项展示且指标匹配正式查询')
  assert.equal(finalizeProjectAfterSalesCatalogAssertions(record, 'PB953-001').acceptanceComplete, false)
  assert.equal(record.catalogAssertions[3].status, 'GAP')
})
