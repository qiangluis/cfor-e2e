import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasAssignmentDrivenArtifact,
  hasImmutableMaintenanceSnapshot,
  hasMaintenanceRepairOrderSnapshot,
  hasMaintenanceTaskVersionSnapshot,
  hasNoNewMaintenanceArtifacts,
  hasPublishedMaintenanceVersions
} from '../fixtures/maintenance-version.mjs'

const device = { id: '9007199254740993', deviceName: 'E2E device', productId: '456' }
const configV1 = JSON.stringify({ version: 1, items: [{ standard: 'V1 standard' }] })
const cycleV1 = JSON.stringify({ cycleType: 'TIME', cycleValue: 1, cycleUnit: 'DAY' })
const configV2 = JSON.stringify({ version: 2, items: [{ standard: 'V2 standard' }] })
const cycleV2 = JSON.stringify({ cycleType: 'TIME', cycleValue: 1, cycleUnit: 'DAY' })

const runtime = {
  id: '101', sourcePlanId: '201', sourcePlanVersion: 2, assignmentId: '301',
  configSnapshot: configV2, cycleRuleSnapshot: cycleV2
}

test('inspection task evidence requires version, assignment and complete JSON snapshots', () => {
  const task = {
    id: '401', planId: '101', sourcePlanId: '201', sourcePlanVersion: 2,
    assignmentId: '301', configSnapshot: configV2, cycleRuleSnapshot: cycleV2,
    deviceSnapshot: JSON.stringify([device])
  }
  assert.equal(hasMaintenanceTaskVersionSnapshot({
    task, runtime, device, version: 2, standard: 'V2 standard', cycleValue: 1
  }), true)
  assert.equal(hasMaintenanceTaskVersionSnapshot({
    task: { ...task, sourcePlanVersion: 1 }, runtime, device, version: 2
  }), false)
  assert.equal(hasMaintenanceTaskVersionSnapshot({
    task: { ...task, assignmentId: '302' }, runtime, device, version: 2
  }), false)
  assert.equal(hasMaintenanceTaskVersionSnapshot({
    task: { ...task, deviceSnapshot: '{}' }, runtime, device, version: 2
  }), false)
})

test('repair order evidence requires the actual assignment source and device snapshot', () => {
  const order = {
    id: '501', sourcePlanId: '201', sourcePlanVersion: 2, sourceAssignmentId: '301',
    deviceId: device.id, cycleRuleSnapshot: cycleV2,
    deviceSnapshot: JSON.stringify({ deviceId: device.id }), idempotentKey: 'MP:201:2:301:9007199254740993'
  }
  assert.equal(hasMaintenanceRepairOrderSnapshot({
    order, planId: '201', version: 2, assignmentId: '301', deviceId: device.id
  }), true)
  assert.equal(hasMaintenanceRepairOrderSnapshot({
    order: { ...order, sourceAssignmentId: '302' },
    planId: '201', version: 2, assignmentId: '301', deviceId: device.id
  }), false)
})

test('historical snapshots remain byte-for-byte unchanged and disabled generation cannot add artifacts', () => {
  const oldTask = {
    id: '401', sourcePlanId: '201', sourcePlanVersion: 1,
    assignmentId: '301', configSnapshot: configV1, cycleRuleSnapshot: cycleV1,
    deviceSnapshot: JSON.stringify([device])
  }
  assert.equal(hasImmutableMaintenanceSnapshot(oldTask, { ...oldTask }), true)
  assert.equal(hasImmutableMaintenanceSnapshot(oldTask, { ...oldTask, configSnapshot: configV2 }), false)
  assert.equal(hasNoNewMaintenanceArtifacts([{ id: '401' }], [{ id: '401' }]), true)
  assert.equal(hasNoNewMaintenanceArtifacts([{ id: '401' }], [{ id: '401' }, { id: '402' }]), false)
})

test('version rows and assignment-driven artifact checks reject incomplete evidence', () => {
  assert.equal(hasPublishedMaintenanceVersions([[1, 1, '{"version":1}'], [2, 2, '{"version":2}']]), true)
  assert.equal(hasPublishedMaintenanceVersions([[1, 1, '']]), false)
  const artifact = {
    planId: '101', sourcePlanId: '201', sourcePlanVersion: 2,
    assignmentId: '301', deviceId: device.id
  }
  assert.equal(hasAssignmentDrivenArtifact({
    artifact, planId: '201', runtimeId: '101', version: 2, assignmentId: '301', deviceId: device.id
  }), true)
  assert.equal(hasAssignmentDrivenArtifact({
    artifact: { ...artifact, assignmentId: '302' }, planId: '201', runtimeId: '101',
    version: 2, assignmentId: '301', deviceId: device.id
  }), false)
})
