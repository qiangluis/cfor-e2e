import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  DESIGNED_INIT_ENABLE_CASES,
  DESIGNED_INIT_BLOCKED_CASES
} from '../suites/init.mjs'
import { DESIGNED_MES_BASE_ENABLE_CASES } from '../suites/mes-base.mjs'
import { crmReadOnlyCases } from '../suites/crm.mjs'
import { procurementReadOnlyViews } from '../suites/procurement.mjs'
import { cases as iotFoundationReadonlyCases } from '../suites/iot-foundation-readonly.mjs'
import { ownedInitCases } from '../owned-init/fixtures.mjs'
import { cases as initGapCases } from '../fixtures/init-gaps.mjs'

const catalog = JSON.parse(fs.readFileSync(
  new URL('../cases/catalog.json', import.meta.url), 'utf8'
))
const definitions = new Map(catalog.suites.flatMap((suite) =>
  suite.cases.map((item) => [item.id, item])
))

test('implemented read-only cases are executable but retain incomplete acceptance', () => {
  for (const id of [...DESIGNED_INIT_ENABLE_CASES, ...DESIGNED_MES_BASE_ENABLE_CASES,
    ...crmReadOnlyCases, ...Object.keys(procurementReadOnlyViews), ...iotFoundationReadonlyCases]) {
    if (ownedInitCases.includes(id)) {
      assert.ok(['PARTIAL', 'READY'].includes(definitions.get(id)?.status), id)
    } else {
      assert.equal(definitions.get(id)?.status, 'PARTIAL', id)
    }
  }
})

test('IoT foundation integration exposes telemetry and capacity as read-only partial cases', () => {
  const source = fs.readFileSync(new URL('../suites/iot.mjs', import.meta.url), 'utf8')
  assert.match(source, /if \(caseId === 'IOT-001'\) \{\s+return await runIotFoundationReadonlyCase\(/)
  assert.match(source, /if \(caseId === 'IOT-002' \|\| caseId === 'IOT-003'\) \{\s+return await runIotReadonlyCase\(/)
  for (const id of ['IOT-002', 'IOT-003']) assert.equal(definitions.get(id)?.status, 'PARTIAL', id)
})

test('unsafe initialization writes are not silently enabled by read-only coverage', () => {
  for (const id of [...DESIGNED_INIT_BLOCKED_CASES, 'INIT-002', 'INIT-003', 'INIT-004', 'INIT-005', 'PB032-006']) {
    if (ownedInitCases.includes(id) || initGapCases.includes(id) || id === 'PB032-006') continue
    assert.ok(['DESIGNED', 'BLOCKED'].includes(definitions.get(id)?.status), id)
  }
})

test('registered gap fixtures are executable but keep incomplete acceptance explicit', () => {
  for (const id of [...initGapCases, 'AUTH-DATA-007']) {
    assert.equal(definitions.get(id)?.status, 'PARTIAL', id)
  }
  assert.equal(definitions.get('PB032-006')?.status, 'READY')
})

test('only registered local owned initialization fixtures are executable without full acceptance', () => {
  assert.deepEqual(ownedInitCases, [
    'PB004-001', 'PB005-001', 'PB007-001', 'PB008-001', 'PB008-002'
  ])
  const source = fs.readFileSync(new URL('../suites/init.mjs', import.meta.url), 'utf8')
  assert.match(source, /if \(ownedInitCases\.includes\(caseId\)\) return runOwnedInitCase/)
  for (const id of ownedInitCases) {
    assert.ok(['PARTIAL', 'READY'].includes(definitions.get(id)?.status), id)
    assert.ok(definitions.get(id)?.assertions?.length > 0, id)
  }
})

test('catalog case ids are unique and source requirements remain present', () => {
  const cases = catalog.suites.flatMap((suite) => suite.cases)
  assert.equal(definitions.size, cases.length)
  assert.ok(Array.isArray(catalog.source) && catalog.source.length > 0)
  for (const item of cases) {
    assert.ok(typeof item.title === 'string' && item.title.trim(), item.id)
    const status = item.status || 'READY'
    assert.ok(['READY', 'PARTIAL', 'DESIGNED', 'BLOCKED'].includes(status), item.id)
    if (status === 'READY') {
      assert.ok(Array.isArray(item.assertions) && item.assertions.length > 0, item.id)
    }
  }
})
