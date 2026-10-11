import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  IOT_WRITE_ASSERTIONS,
  finalizeIotCatalogAssertions,
  initializeIotCatalogAssertions
} from '../fixtures/iot-write-closure.mjs'

test('IOT-013 keeps the four original assertions and requires real runtime and snapshot evidence', () => {
  const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url)))
  const row = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'IOT-013')
  assert.deepEqual(row.assertions, [...IOT_WRITE_ASSERTIONS['IOT-013']])
  assert.equal(row.acceptanceEvidence.runId, '20261011065719697-12469')
  assert.ok(row.routes.includes('/iot/device/detail/:id'))
  for (const path of ['/mes/device-status-event/start', '/mes/device-status-event/active',
    '/mes/device-status-event/end']) assert.ok(row.api.includes(path))
  assert.ok(row.preconditions.every((text) => !text.includes('无设备时仅')))
})

test('IOT-013 cannot be complete when a required runtime check is absent or cleanup fails', () => {
  for (const checks of [[], [{ name: 'runtime', passed: true }, { name: 'cleanup', passed: false }]]) {
    const record = { id: 'IOT-013', checks, notes: [] }
    initializeIotCatalogAssertions(record, 'IOT-013')
    for (const row of record.catalogAssertions) {
      row.details = ''
      row.evidenceChecks = ['runtime', 'cleanup']
    }
    const result = finalizeIotCatalogAssertions(record)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(result.partial, true)
    assert.equal(record.catalogComplete, false)
  }
})
