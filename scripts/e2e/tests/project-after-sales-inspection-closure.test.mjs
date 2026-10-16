import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  assertInspectionSnapshotUnchanged,
  assertInspectionTaskSnapshot,
  queryInspectionTaskInBrowser,
  readOtherInspectionFacts
} from '../fixtures/project-after-sales-inspection-closure.mjs'
import {
  finalizeProjectAfterSalesCatalogAssertions,
  PROJECT_AFTER_SALES_ACCEPTANCE_GAPS
} from '../suites/project-after-sales.mjs'

const sample = () => {
  const assetFixture = {
    assetId: '10', customerId: '20', contactId: '40', materialId: '50',
    detail: { asset: {
      assetNo: 'OWNED_ASSET', assetName: 'Own asset', serviceStatus: 'IN_SERVICE',
      serviceStartDate: '2026-01-01', serviceEndDate: '2027-01-01'
    } }
  }
  const plan = { id: '30', planCode: 'OWNED_PLAN', publishedVersion: 1 }
  const item = { id: '60', itemCode: 'OWNED_ITEM', itemName: 'Own item', resultType: 'BOOLEAN',
    execRequirement: 'Inspect', standardHours: 0.5, attachmentRequired: true }
  const refs = {
    planServiceContractRef: 'OWNED_PERIOD', planServiceEntitlementRef: 'OWNED_PLAN_RIGHT',
    assignmentServiceContractRef: 'OWNED_PERIOD', assignmentServiceEntitlementRef: 'OWNED_RIGHT'
  }
  const snapshot = {
    planId: plan.id, planCode: plan.planCode, planVersion: 1, ...refs,
    appointmentRequired: true, customerConfirmRequired: true, signatureRequired: true,
    items: [{ ...item, itemId: item.id, standard: 'No defect' }],
    cycles: [{ cycleType: 'TIME', cycleValue: 30, cycleUnit: 'DAY', dataSource: 'CALENDAR' }],
    assetSnapshot: { ...assetFixture.detail.asset, assetId: '10', customerId: '20',
      contactId: '40', materialId: '50' }
  }
  const task = {
    id: '70', sourceType: 'QUARTER_AUTO', assetId: '10', customerId: '20',
    contactId: '40', configPlanId: '30', configPlanVersion: 1, assetName: 'Own asset',
    configSnapshot: JSON.stringify(snapshot)
  }
  return { task, snapshot, expected: { assetFixture, plan, item, refs, standard: 'No defect' } }
}

test('PB122 snapshots require exact source IDs, item rules, cycles and every execution/entitlement field', () => {
  const { task, snapshot, expected } = sample()
  assert.doesNotThrow(() => assertInspectionTaskSnapshot(task, expected))
  for (const field of ['appointmentRequired', 'customerConfirmRequired', 'signatureRequired',
    ...Object.keys(expected.refs)]) {
    assert.throws(() => assertInspectionTaskSnapshot({
      ...task, configSnapshot: JSON.stringify({ ...snapshot, [field]: null })
    }, expected))
  }
  assert.throws(() => assertInspectionTaskSnapshot({ ...task, assetId: '999' }, expected))
  assert.throws(() => assertInspectionTaskSnapshot({
    ...task, configSnapshot: JSON.stringify({ ...snapshot, cycles: [] })
  }, expected))
  assert.throws(() => assertInspectionTaskSnapshot({
    ...task, configSnapshot: JSON.stringify({ ...snapshot, assetSnapshot: {} })
  }, expected))
})

test('PB122 historical snapshot validation rejects missing tasks and changed source/version/content', () => {
  const { task } = sample()
  assert.doesNotThrow(() => assertInspectionSnapshotUnchanged(task, { ...task }))
  for (const field of ['id', 'assetId', 'customerId', 'contactId', 'sourceType',
    'configPlanVersion', 'configSnapshot']) {
    assert.throws(() => assertInspectionSnapshotUnchanged(task, { ...task, [field]: 'changed' }))
  }
  assert.throws(() => assertInspectionSnapshotUnchanged(task, null))
})

test('PB122 SQL snapshots exclude only the exact owned asset and never issue writes', async () => {
  const calls = []
  const readSql = async (sql) => { calls.push(sql); return { available: true, rows: [['OTHER']] } }
  assert.deepEqual((await readOtherInspectionFacts('10', readSql)).rows, [['OTHER']])
  assert.match(calls[0], /tenant_id=1 AND asset_id<>'10'/)
  assert.doesNotMatch(calls[0], /\b(INSERT|UPDATE|DELETE|TRUNCATE|REPLACE)\b/i)
  await assert.rejects(readOtherInspectionFacts("10' OR 1=1", readSql))
  await assert.rejects(readOtherInspectionFacts('10', async () =>
    ({ available: false, reason: 'DB offline' })), /^Error: BLOCKED:/)
})

test('PB122 retains all original acceptance gaps and does not borrow other-case evidence', () => {
  const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
    .suites.flatMap((suite) => suite.cases).find((item) => item.id === 'PB122-001')
  assert.deepEqual(PROJECT_AFTER_SALES_ACCEPTANCE_GAPS['PB122-001'].map((row) => row.assertion),
    catalog.acceptanceGaps)
  const record = { checks: catalog.assertions.map((name) => ({ name, passed: true })), notes: [] }
  assert.equal(finalizeProjectAfterSalesCatalogAssertions(record, catalog.id).acceptanceComplete, false)
  record.checks.push(...PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[catalog.id]
    .map((gap) => ({ name: gap.check, passed: true })))
  assert.equal(finalizeProjectAfterSalesCatalogAssertions(record, catalog.id).acceptanceComplete, true)
})

const browserQueryFixture = (status = 200, finished = null) => {
  const calls = []
  const response = (path, keyword, pageSize = '10', method = 'GET') => ({
    url: () => `http://127.0.0.1:48083/admin-api${path}?keyword=${keyword}&pageSize=${pageSize}`,
    request: () => ({ method: () => method }),
    status: () => status,
    finished: async () => { calls.push('finished'); return finished }
  })
  const page = {
    getByPlaceholder: () => ({ fill: async (value) => { calls.push(`fill:${value}`) } }),
    getByRole: () => ({ click: async () => { calls.push('click') } }),
    waitForResponse: async (predicate) => {
      calls.push('listen')
      assert.equal(predicate(response('/after-sales/inspection/page', 'OTHER')), false)
      assert.equal(predicate(response('/after-sales/inspection/list', 'OWNED')), false)
      assert.equal(predicate(response('/after-sales/inspection/page', 'OWNED', '1')), false)
      assert.equal(predicate(response('/after-sales/inspection/page', 'OWNED', '10', 'POST')), false)
      const own = response('/after-sales/inspection/page', 'OWNED')
      assert.equal(predicate(own), true)
      return own
    },
    locator: (selector) => ({
      waitFor: async (options) => {
        assert.equal(selector, '.inspection-task-table .el-loading-mask:visible')
        assert.equal(options.state, 'hidden')
        calls.push('loading-hidden')
      }
    })
  }
  return { page, calls }
}

test('PB122 listens before querying and waits for the owned page response and loading mask', async () => {
  const { page, calls } = browserQueryFixture()
  await queryInspectionTaskInBrowser(page, 'OWNED')
  assert.deepEqual(calls, ['fill:OWNED', 'listen', 'click', 'finished', 'loading-hidden'])
})

test('PB122 does not capture a failed or incomplete page response', async () => {
  for (const [status, finished] of [[500, null], [200, new Error('response interrupted')]]) {
    const { page, calls } = browserQueryFixture(status, finished)
    await assert.rejects(queryInspectionTaskInBrowser(page, 'OWNED'))
    assert.ok(!calls.includes('loading-hidden'))
  }
  await assert.rejects(queryInspectionTaskInBrowser({}, ''))
})
