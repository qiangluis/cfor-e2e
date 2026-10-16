import assert from 'node:assert/strict'
import { normalizeLocalDate } from '../lib/local-date.mjs'

export const PM_CHANGE_STATES = Object.freeze([
  'DRAFT', 'ASSESSING', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'VERIFIED', 'CLOSED'
])

export const assertProjectTaskFactsUnchanged = (before, after) => {
  assert.match(String(before?.id ?? ''), /^[1-9]\d*$/, 'Missing task source')
  assert.match(String(before?.projectId ?? ''), /^[1-9]\d*$/, 'Missing task project')
  assert.ok(after, 'Missing task readback')
  assert.deepEqual(after, before, 'Report generation changed formal task facts')
}

export const planMilestoneWeightUpdates = (existing, newWeight) => {
  assert.ok(Number.isFinite(newWeight) && newWeight > 0 && newWeight <= 100)
  const weightOf = (item) => {
    const value = Number(item.weightRate)
    assert.ok(Number.isFinite(value) && value > 0, 'Invalid existing milestone weight')
    return value
  }
  const total = existing.reduce((sum, item) => sum + weightOf(item), 0)
  if (total + newWeight <= 100) return []
  const lockedWeight = existing.filter((item) => item.confirmed === true)
    .reduce((sum, item) => sum + weightOf(item), 0)
  const adjustable = existing.filter((item) => item.confirmed !== true)
  const budget = 100 - newWeight - lockedWeight
  if (!adjustable.length || budget < adjustable.length) {
    throw new Error(`BLOCKED: 无法为新增里程碑预留权重 ${newWeight}（已确认权重 ${lockedWeight}）`)
  }
  const base = Math.floor(budget / adjustable.length)
  const remainder = budget - base * adjustable.length
  // Release weight before increasing any item so every intermediate save respects the cap.
  return adjustable.map((item, index) => ({ item, weight: base + (index < remainder ? 1 : 0) }))
    .filter(({ item, weight }) => weightOf(item) !== weight)
    .sort((left, right) =>
      (left.weight - weightOf(left.item)) - (right.weight - weightOf(right.item)))
}

export const assertProjectChangeLifecycle = (history) => {
  assert.deepEqual(history.map((item) => item.status), PM_CHANGE_STATES)
  const first = history[0]
  assert.match(String(first?.id ?? ''), /^[1-9]\d*$/)
  assert.match(String(first?.projectId ?? ''), /^[1-9]\d*$/)
  for (const item of history) {
    assert.equal(String(item.id), String(first.id), 'Change identity drift')
    assert.equal(String(item.projectId), String(first.projectId), 'Change project drift')
    assert.equal(item.changeNo, first.changeNo, 'Change number drift')
    assert.equal(item.createTime, first.createTime, 'Creation timestamp drift')
  }
  const [executing, verified, closed] = history.slice(-3)
  for (const field of ['executedTime', 'executionIdempotencyKey', 'executedBy',
    'executeOwnerId', 'objectVersion', 'downstreamStrategy']) {
    assert.ok(executing[field] !== null && executing[field] !== undefined && executing[field] !== '')
    assert.deepEqual(verified[field], executing[field], `Verification changed ${field}`)
    assert.deepEqual(closed[field], executing[field], `Closure changed ${field}`)
  }
  assert.ok(verified.verifiedTime, 'Verification timestamp missing')
  assert.equal(closed.verifiedTime, verified.verifiedTime, 'Verification timestamp drift')
  assert.ok(closed.closedTime, 'Closure timestamp missing')
  const timestamps = [first.createTime, executing.executedTime, verified.verifiedTime, closed.closedTime]
    .map((value) => Date.parse(value))
  assert.ok(timestamps.every(Number.isFinite), 'Invalid lifecycle timestamp')
  assert.ok(timestamps.every((value, index) => !index || value >= timestamps[index - 1]),
    'Lifecycle timestamps out of order')
}

export const assertProjectReportExportMatches = (report, row, query) => {
  assert.ok(report && row, 'Missing report/export row')
  const exportedFilters = JSON.parse(row.appliedFilters)
  assert.equal(String(report.appliedFilters?.projectId), String(query.projectId))
  assert.equal(String(exportedFilters.projectId), String(query.projectId))
  for (const field of ['startDate', 'endDate']) {
    assert.equal(normalizeLocalDate(report.appliedFilters?.[field]), normalizeLocalDate(query[field]),
      `Report ${field} filter mismatch`)
    assert.equal(normalizeLocalDate(exportedFilters[field]), normalizeLocalDate(query[field]),
      `Export ${field} filter mismatch`)
  }
  assert.equal(row.reportType, report.reportType)
  assert.equal(row.calculationMode, report.calculationMode)
  assert.equal(Number(row.metricVersion), report.metricVersion, 'Metric version mismatch')
  assert.ok(row.generatedAt, 'Missing export generation time')
  // Both queries recompute generatedAt; all other exported scalar metrics must agree.
  for (const [field, value] of Object.entries(row)) {
    if (['reportType', 'calculationMode', 'metricVersion', 'appliedFilters', 'generatedAt'].includes(field) ||
        value == null || value === '') continue
    assert.ok(Object.hasOwn(report, field), `Unknown export metric ${field}`)
    assert.equal(String(value), String(report[field]), `Export metric ${field} mismatch`)
  }
}
