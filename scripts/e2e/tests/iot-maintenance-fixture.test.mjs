import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createFixtureCleanup,
  createOtherInStock,
  checkMaintenancePage,
  dataOf,
  fixtureId,
  isolatedDeviceId,
  isE2eFixture,
  isExpectedRejection,
  MAINT_010_LIFECYCLE_ROUTE,
  MAINT_010_COMPENSATION_ROUTE,
  trackDeletable,
  trackEvent,
  retainInventoryMaster,
  hasTaskTypeSnapshot,
  hasRepairWorkflowAudit,
  hasStatusEventPageEvidence,
  hasSingleActiveStatusEvent,
  trackOwnedStatusEvent
} from '../suites/iot-maintenance.mjs'

const caseRecord = () => ({ checks: [], notes: [] })

test('repair workflow audit requires the exact nonempty sequence and actor/tenant evidence', () => {
  const rows = [
    ['CREATE', 'NULL', 'REPORTED'],
    ['DISPATCH', 'REPORTED', 'DISPATCHED'],
    ['ACCEPT', 'DISPATCHED', 'ACCEPTED'],
    ['START_REPAIR', 'ACCEPTED', 'REPAIRING'],
    ['SPARE_OUT', 'REPAIRING', 'REPAIRING'],
    ['COMPLETE_REPAIR', 'REPAIRING', 'PENDING_ACCEPT'],
    ['CLOSE', 'PENDING_ACCEPT', 'CLOSED']
  ].map((row) => [...row, '1', '1', '2026-10-07 14:30:00'])
  assert.equal(hasRepairWorkflowAudit(rows, 1, 1), true)
  assert.equal(hasRepairWorkflowAudit([], 1, 1), false)
  assert.equal(hasRepairWorkflowAudit(rows.slice(1), 1, 1), false)
  assert.equal(hasRepairWorkflowAudit([...rows, rows[4]], 1, 1), false)
  assert.equal(hasRepairWorkflowAudit(rows, 2, 1), false)
  assert.equal(hasRepairWorkflowAudit(rows, 1, 2), false)
  assert.equal(hasRepairWorkflowAudit(rows.toReversed(), 1, 1), false)
})

test('CommonResult data=null unwraps to null instead of returning the envelope', () => {
  assert.equal(dataOf({ code: 0, data: null, msg: '' }), null)
  assert.deepEqual(dataOf({ code: 0, data: { id: 7 }, msg: '' }), { id: 7 })
  assert.deepEqual(dataOf({ code: 200, success: true, data: { id: 8 }, message: '' }), { id: 8 })
  assert.deepEqual(dataOf({ id: 7 }), { id: 7 })
})

test('fixtureId accepts only positive database IDs', () => {
  assert.equal(fixtureId({ code: 0, data: 7 }, 'fixture'), 7)
  assert.equal(fixtureId({ code: 0, data: '9223372036854775807' }, 'fixture'), '9223372036854775807')
  assert.throws(() => fixtureId({ code: 0, data: null }, 'fixture'), /无效 ID/)
  assert.throws(() => fixtureId({ code: 0, data: 0 }, 'fixture'), /无效 ID/)
  assert.throws(() => fixtureId({ code: 0, data: -1 }, 'fixture'), /无效 ID/)
  assert.throws(() => fixtureId({ code: 0, data: '9223372036854775808' }, 'fixture'), /无效 ID/)
})

test('deletable fixture verifies the cleanup business response', async () => {
  const record = caseRecord()
  const deleted = []
  const api = {
    deleteBusiness: async (path) => {
      deleted.push(path)
      return { code: 0, data: true, msg: '' }
    }
  }
  const fixtures = createFixtureCleanup({ caseId: 'IOT-006', caseRecord: record })
  const id = trackDeletable(fixtures, api, { code: 0, data: 17 }, '/mes/device-status-mapping', '映射')

  await fixtures.cleanup(false)

  assert.deepEqual(deleted, ['/mes/device-status-mapping/delete?id=17'])
  assert.equal(record.notes.length, 0)
  assert.equal(record.checks.at(-1).passed, true)
})

test('cleanup failure is recorded without replacing the original failure', async () => {
  const record = caseRecord()
  const api = {
    deleteBusiness: async () => ({ code: 0, data: false, msg: '' })
  }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-001', caseRecord: record })
  trackDeletable(fixtures, api, { code: 0, data: 23 }, '/mes/maintenance-type-rule', '规则')

  await assert.doesNotReject(() => fixtures.cleanup(true))
  assert.equal(record.checks.at(-1).passed, false)
  assert.match(record.notes[0], /清理失败/)
})

test('event cleanup ends only the fixture event ID', async () => {
  const record = caseRecord()
  const ended = []
  const api = {
    getBusiness: async (path) => ({
      code: 0,
      data: path.includes('id=202')
        ? { endTime: '2026-10-05T21:00:00' }
        : { startTime: '2026-10-05T21:00:00', endTime: null },
      msg: ''
    }),
    putBusiness: async (path, body) => {
      ended.push({ path, body })
      return { code: 0, data: true, msg: '' }
    }
  }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-006', caseRecord: record })
  trackEvent(fixtures, api, { code: 0, data: 101 })
  trackEvent(fixtures, api, { code: 0, data: 202 })

  await fixtures.cleanup(false)

  assert.deepEqual(ended.map(({ body }) => body.id), [101])
  assert.match(ended[0].body.endTime, /^2026-10-05T21:01:00$/)
  assert.equal(ended.every(({ path }) => path === '/mes/device-status-event/end'), true)
})

test('isolated device IDs are checked against every requested state layer', async () => {
  const queries = []
  const api = {
    getBusiness: async (path) => {
      queries.push(path)
      return { code: 0, data: null, msg: '' }
    }
  }

  const id = await isolatedDeviceId(api, ['RUNTIME', 'ASSET', 'CONNECTION'])

  assert.equal(Number.isSafeInteger(id), true)
  assert.equal(queries.length, 3)
  assert.equal(new Set(queries.map((path) => path.match(/deviceId=(\d+)/)?.[1])).size, 1)
})

test('MAINT-010 uses the actual settings routes', () => {
  assert.equal(MAINT_010_LIFECYCLE_ROUTE, '/settings/iot/device-lifecycle')
  assert.equal(MAINT_010_COMPENSATION_ROUTE, '/settings/iot/device-compensation')
})

test('shared master data and incidental E2E text cannot be used as write fixtures', () => {
  assert.equal(isE2eFixture({ code: 'E2E_MATERIAL', name: 'fixture' }), true)
  assert.equal(isE2eFixture({ name: 'E2E-WAREHOUSE' }), true)
  assert.equal(isE2eFixture({ name: 'raw material warehouse', remark: 'E2E' }), false)
  assert.equal(isE2eFixture({ name: 'userE2Edevice' }), false)
})

test('only the expected domain rejection satisfies a negative assertion', () => {
  assert.equal(isExpectedRejection({ code: 400, msg: 'expected validation' }, 'expected'), true)
  assert.equal(isExpectedRejection({ code: 500, msg: 'expected validation' }, 'expected'), false)
  assert.equal(isExpectedRejection({ code: 400, msg: 'different validation' }, 'expected'), false)
  assert.equal(isExpectedRejection({ code: 0, data: null }, 'expected'), false)
})

test('status event page evidence requires nonempty same-device rows and expected event IDs', () => {
  const payload = {
    total: 2,
    list: [
      { id: '101', deviceId: '9001', statusCode: 'RUNNING', startTime: '2026-10-07 10:00:00' },
      { id: '102', deviceId: '9001', statusCode: 'STOPPED', startTime: '2026-10-07 10:01:00' }
    ]
  }
  assert.equal(hasStatusEventPageEvidence(payload, '9001', ['101', '102']), true)
  assert.equal(hasStatusEventPageEvidence(payload, '9001', ['101', '999']), false)
  assert.equal(hasStatusEventPageEvidence({ total: 1, list: [] }, '9001'), false)
  assert.equal(hasStatusEventPageEvidence({
    total: 2,
    list: [{ ...payload.list[0], deviceId: '9002' }, payload.list[1]]
  }, '9001'), false)
  assert.equal(hasStatusEventPageEvidence({
    total: 1,
    list: payload.list
  }, '9001'), false)
  assert.equal(hasStatusEventPageEvidence({ ...payload, total: 'bad' }, '9001', ['101']), false)
  assert.equal(hasStatusEventPageEvidence({
    total: 2, list: [payload.list[0], payload.list[0]]
  }, '9001', ['101']), false)
  assert.equal(hasStatusEventPageEvidence(payload, '9001', []), false)
})

test('unique active evidence rejects duplicate active events, incomplete pages and inconsistent flags', () => {
  const row = { id: '101', deviceId: '9001', coreLayer: 'RUNTIME',
    statusCode: 'RUNNING', startTime: '2026-10-07T10:00:00', endTime: null, active: true }
  const closed = { ...row, id: '102', endTime: '2026-10-07T10:07:00', active: false }
  const payload = { total: 2, list: [row, closed] }
  assert.equal(hasSingleActiveStatusEvent(payload, '9001', ['101', '102'], '101'), true)
  assert.equal(hasSingleActiveStatusEvent({
    total: 2, list: [row, { ...row, id: '102' }]
  }, '9001', ['101', '102'], '101'), false)
  assert.equal(hasSingleActiveStatusEvent({ total: 2, list: [row] }, '9001', ['101', '102'], '101'), false)
  assert.equal(hasSingleActiveStatusEvent({
    total: 2, list: [row, { ...closed, active: true }]
  }, '9001', ['101', '102'], '101'), false)
})

test('MAINT-006 cleanup refuses foreign event ownership and reports ended history as retained', async () => {
  const foreignRecord = caseRecord()
  const foreignFixtures = createFixtureCleanup({ caseId: 'MAINT-006', caseRecord: foreignRecord })
  trackOwnedStatusEvent(foreignFixtures, {
    getBusiness: async () => ({ code: 0, data: { id: '101', deviceId: '9002' } }),
    putBusiness: async () => assert.fail('must not end a foreign event')
  }, '101', '9001')
  await assert.rejects(() => foreignFixtures.cleanup(false), /清理失败/)
  assert.equal(foreignRecord.checks[0].passed, false)

  const record = caseRecord()
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-006', caseRecord: record })
  let ended = false
  trackOwnedStatusEvent(fixtures, {
    getBusiness: async () => ({ code: 0, data: { id: '101', deviceId: '9001',
      startTime: '2026-10-07T10:00:00', endTime: ended ? '2026-10-07T10:01:00' : null, active: !ended } }),
    putBusiness: async (path, body) => {
      assert.equal(path, '/mes/device-status-event/end')
      assert.equal(body.id, '101')
      ended = true
      return { code: 0, data: true }
    }
  }, '101', '9001')
  await fixtures.cleanup(false)
  assert.equal(ended, true)
  assert.match(record.checks[0].name, /已保留/)
  assert.match(record.checks[0].details, /无历史删除入口/)
})

test('a retained repair fixture is not recorded as deleted', async () => {
  const record = caseRecord()
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-008', caseRecord: record })
  fixtures.track(7, 'repair fixture', async () => ({ retained: true }))

  await fixtures.cleanup(false)

  assert.equal(record.checks[0].passed, true)
  assert.match(record.checks[0].name, /已保留/)
  assert.doesNotMatch(record.checks[0].name, /已清理/)
})

test('inventory master cleanup retains positive and zero-quantity references without writes', async () => {
  for (const field of ['materialId', 'warehouseId']) {
    for (const qty of [2, 0]) {
      const api = {
        getBusiness: async (path) => {
          assert.match(path, new RegExp(`${field}=2107681797636288514`))
          return { code: 0, data: { records: [{ [field]: '2107681797636288514', qty }] } }
        }
      }
      assert.deepEqual(await retainInventoryMaster(api, field, '2107681797636288514'),
        { retained: true, reason: 'inventory-reference' })
    }
  }
  await assert.rejects(() => retainInventoryMaster({
    getBusiness: async () => ({ code: 0, data: null })
  }, 'warehouseId', '7'))
})

test('automatically effective 199 is never approved again or deleted during cleanup', async () => {
  const record = caseRecord()
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-008', caseRecord: record })
  const api = {
    postBusiness: async (path, body) => {
      assert.equal(body.stkIoEntryList[0].entryNo, 1)
      return { code: 0, data: '1991' }
    },
    getBusiness: async (path) => ({ code: 0, data: path.includes('queryEntry')
      ? [{ materialId: '71', warehouseId: '81', qty: 2 }]
      : path.includes('stkInventory')
        ? { records: [{ materialId: '71', warehouseId: '81', qty: 2 }] }
        : { stockIoType: '199', remark: 'E2E-MAINT 专属备件库存', billStage: '34', isEffective: 1 } }),
    putBusiness: async () => assert.fail('effective stock must not be approved or rolled back'),
    deleteBusiness: async () => assert.fail('effective stock must not be deleted')
  }
  await createOtherInStock(api, fixtures, { id: '71', unitId: '91' }, { id: '81' }, record)
  await fixtures.cleanup(false)
  assert.equal(record.checks.every((check) => check.passed), true)
  assert.match(record.checks.at(-1).name, /已保留/)
})

test('type snapshot requires exact historical rule identity, version, name and JSON contents', () => {
  const rule = { id: '2107681797636288514', version: 1, coreDomain: 'UPKEEP',
    subTypeCode: 'E2E-MAINT-UPKEEP', subTypeName: 'E2E periodic upkeep' }
  const task = { maintenanceDomain: rule.coreDomain, maintenanceSubTypeCode: rule.subTypeCode,
    maintenanceSubTypeName: rule.subTypeName, maintenanceTypeRuleId: rule.id,
    maintenanceTypeRuleVersion: 1, maintenanceTypeRuleSnapshot: JSON.stringify(rule) }
  assert.equal(hasTaskTypeSnapshot(task, rule), true)
  assert.equal(hasTaskTypeSnapshot(task, { ...rule, version: 2 }), false)
  assert.equal(hasTaskTypeSnapshot({ ...task, maintenanceTypeRuleSnapshot: '{}' }, rule), false)
  assert.equal(hasTaskTypeSnapshot({ ...task, maintenanceTypeRuleId: '2107681797636288515' }, rule), false)
  assert.equal(hasTaskTypeSnapshot({ ...task, maintenanceTypeRuleSnapshot: 'bad JSON' }, rule), false)
})

test('a page timeout remains a failed check while preserving screenshots and API follow-up', async () => {
  const record = caseRecord()
  const captured = []
  const page = { locator: () => ({ innerText: async () => 'app shell only' }) }

  await checkMaintenancePage({ page, caseRecord: record, record: {}, outputDir: '/unused' }, {
    route: '/iot/maintenance/repair-order',
    labels: ['expected table'],
    name: 'page contract',
    screenshot: 'page-failure'
  }, {
    openRoute: async () => { throw new Error('page timeout') },
    saveScreenshot: async (...args) => { captured.push(args[2]) }
  })

  assert.equal(record.checks[0].passed, false)
  assert.match(record.checks[0].details, /page timeout/)
  assert.deepEqual(captured, ['page-failure'])
})
