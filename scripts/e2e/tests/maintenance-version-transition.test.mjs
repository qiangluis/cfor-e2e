import assert from 'node:assert/strict'
import test from 'node:test'
import { hasVersionTransitionSnapshots } from '../suites/iot-maintenance.mjs'

const scenario = () => {
  const device = { id: '123', deviceName: 'E2E', productId: '456', deviceType: 0 }
  const config = {
    version: 1, items: [{
      itemVersion: 1, standard: 'E2E 目视无异常', resultType: 'BOOLEAN',
      execRequirement: 'E2E 按正式标准检查并记录结果',
      standardHours: 0.5, attachmentRequired: false
    }]
  }
  const cycle = { cycleType: 'TIME', cycleValue: 1, cycleUnit: 'DAY', dataSource: 'CALENDAR' }
  const originalRuntime = {
    id: '9007199254740993', sourcePlanId: '9007199254740995', assignmentId: '789',
    sourcePlanVersion: 1, configSnapshot: JSON.stringify(config), cycleRuleSnapshot: JSON.stringify(cycle)
  }
  const originalTask = {
    ...originalRuntime, id: '1001', planId: originalRuntime.id, deviceSnapshot: JSON.stringify([device])
  }
  const runtime = {
    ...originalRuntime, sourcePlanVersion: 2,
    configSnapshot: JSON.stringify({
      ...config, version: 2, items: [{ ...config.items[0], standard: 'E2E V2 目视无异常' }]
    }),
    cycleRuleSnapshot: JSON.stringify({ ...cycle, cycleValue: 2 })
  }
  return {
    device, originalRuntime, originalTask, runtime,
    draft: { status: 'DRAFT', currentVersion: 2, publishedVersion: 1 },
    assignment: { id: '789', planVersion: 2 },
    task: { ...originalTask },
    newTask: { ...runtime, id: '1002', planId: runtime.id },
    record: {
      taskId: originalTask.id, maintenancePlanId: originalTask.sourcePlanId,
      maintenancePlanVersion: 1, assignmentId: '789',
      configSnapshot: originalTask.configSnapshot, cycleRuleSnapshot: originalTask.cycleRuleSnapshot,
      deviceSnapshot: originalTask.deviceSnapshot
    }
  }
}

test('version transition requires V2 runtime, assignment and new task with unchanged V1 history', () => {
  assert.equal(hasVersionTransitionSnapshots(scenario()), true)
})

test('a V1 assignment cannot be claimed as following V2', () => {
  const value = scenario()
  value.assignment.planVersion = 1
  assert.equal(hasVersionTransitionSnapshots(value), false)
})

test('a new task with another assignment or another runtime cannot pass', () => {
  const value = scenario()
  value.newTask.assignmentId = '790'
  assert.equal(hasVersionTransitionSnapshots(value), false)
  value.newTask.assignmentId = '789'
  value.newTask.planId = 'other'
  assert.equal(hasVersionTransitionSnapshots(value), false)
})

test('a migrated historical task or record cannot pass', () => {
  const value = scenario()
  value.task.configSnapshot = value.runtime.configSnapshot
  assert.equal(hasVersionTransitionSnapshots(value), false)
  value.task = { ...value.originalTask }
  value.record.maintenancePlanVersion = 2
  assert.equal(hasVersionTransitionSnapshots(value), false)
})

test('a malformed or unchanged V2 cycle snapshot cannot pass', () => {
  const value = scenario()
  value.newTask.cycleRuleSnapshot = '{'
  assert.equal(hasVersionTransitionSnapshots(value), false)
  value.newTask.cycleRuleSnapshot = value.originalRuntime.cycleRuleSnapshot
  assert.equal(hasVersionTransitionSnapshots(value), false)
})
