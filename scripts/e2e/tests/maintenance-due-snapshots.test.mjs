import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasDueTaskSnapshots, hasRecordTaskSnapshots, hasExactMaintenanceReadPermissions
} from '../suites/iot-maintenance.mjs'

const device = { id: '9007199254740993', deviceName: 'E2E owned', productId: '9007199254740995', deviceType: 0 }
const runtime = {
  id: '101', sourcePlanId: '201', sourcePlanVersion: 1, assignmentId: '301',
  configSnapshot: JSON.stringify({ version: 1, items: [{
    itemVersion: 1, standard: 'E2E 目视无异常', resultType: 'BOOLEAN',
    execRequirement: 'E2E 按正式标准检查并记录结果', standardHours: 0.5, attachmentRequired: false
  }] }),
  cycleRuleSnapshot: JSON.stringify({ cycleType: 'TIME', cycleValue: 1, cycleUnit: 'DAY', dataSource: 'CALENDAR' })
}
const task = () => ({
  id: '401', planId: runtime.id, sourcePlanId: runtime.sourcePlanId,
  sourcePlanVersion: runtime.sourcePlanVersion, assignmentId: runtime.assignmentId,
  configSnapshot: runtime.configSnapshot, cycleRuleSnapshot: runtime.cycleRuleSnapshot,
  deviceSnapshot: JSON.stringify([device])
})

test('due task evidence requires exact structured cycle, configured standard and device snapshots', () => {
  assert.equal(hasDueTaskSnapshots(task(), runtime, device), true)
  for (const field of ['configSnapshot', 'cycleRuleSnapshot', 'deviceSnapshot']) {
    for (const value of [null, '', '{}', '[]', '{broken}']) {
      assert.equal(hasDueTaskSnapshots({ ...task(), [field]: value }, runtime, device), false, `${field}:${value}`)
    }
  }
  assert.equal(hasDueTaskSnapshots({ ...task(), assignmentId: '302' }, runtime, device), false)
  assert.equal(hasDueTaskSnapshots({ ...task(), sourcePlanVersion: 2 }, runtime, device), false)
  assert.equal(hasDueTaskSnapshots(task(), runtime, { ...device, deviceName: 'another' }), false)
})

test('execution record must inherit all three complete snapshots and the exact source identity', () => {
  const source = task()
  const record = {
    taskId: source.id, maintenancePlanId: source.sourcePlanId,
    maintenancePlanVersion: source.sourcePlanVersion, assignmentId: source.assignmentId,
    configSnapshot: source.configSnapshot, cycleRuleSnapshot: source.cycleRuleSnapshot,
    deviceSnapshot: source.deviceSnapshot
  }
  assert.equal(hasRecordTaskSnapshots(record, source), true)
  for (const field of Object.keys(record)) {
    assert.equal(hasRecordTaskSnapshots({ ...record, [field]: null }, source), false, field)
  }
})

test('permission probes accept empty directory markers but reject every extra grant or write capability', () => {
  const permission = 'mes:maintenance-plan:query'
  const expected = [permission, 'system:settings:query']
  assert.equal(hasExactMaintenanceReadPermissions(['', ...expected], expected, permission), true)
  for (const extra of ['*:*:*', 'mes:maintenance-plan:update', 'mes:maintenance-plan:publish',
    'other:query', null, undefined]) {
    assert.equal(hasExactMaintenanceReadPermissions([...expected, extra], expected, permission), false)
  }
  assert.equal(hasExactMaintenanceReadPermissions(['system:settings:query'], expected, permission), false)
})
