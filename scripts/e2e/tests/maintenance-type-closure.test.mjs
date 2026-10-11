import test from 'node:test'
import assert from 'node:assert/strict'
import { hasExactTypeRule, hasTaskTypeSnapshot } from '../suites/iot-maintenance.mjs'

const rule = {
  id: '101', coreDomain: 'UPKEEP', subTypeCode: 'E2E-TYPE', subTypeName: 'E2E upkeep',
  approvalRequired: true, slaHours: 24, status: 0, version: 1
}

test('type rule readback requires exact domain, approval, SLA and version values', () => {
  assert.equal(hasExactTypeRule({ ...rule }, rule), true)
  assert.equal(hasExactTypeRule(null, rule), false)
  for (const field of ['coreDomain', 'subTypeCode', 'subTypeName', 'approvalRequired', 'slaHours', 'status', 'version']) {
    assert.equal(hasExactTypeRule({ ...rule, [field]: null }, rule), false, field)
  }
  assert.equal(hasExactTypeRule({ ...rule, slaHours: '24' }, rule), false)
  assert.equal(hasExactTypeRule({ ...rule, approvalRequired: false }, rule), false)
})

test('formal task snapshots must keep the exact approval and SLA contract', () => {
  const task = {
    maintenanceDomain: rule.coreDomain, maintenanceSubTypeCode: rule.subTypeCode,
    maintenanceSubTypeName: rule.subTypeName, maintenanceTypeRuleId: rule.id,
    maintenanceTypeRuleVersion: rule.version, maintenanceTypeRuleSnapshot: JSON.stringify(rule)
  }
  assert.equal(hasTaskTypeSnapshot(task, rule), true)
  assert.equal(hasExactTypeRule(JSON.parse(task.maintenanceTypeRuleSnapshot), rule), true)
  const altered = { ...rule, approvalRequired: false }
  assert.equal(hasExactTypeRule(altered, rule), false)
  assert.equal(hasTaskTypeSnapshot({ ...task, maintenanceTypeRuleVersion: 2 }, rule), false)
})
