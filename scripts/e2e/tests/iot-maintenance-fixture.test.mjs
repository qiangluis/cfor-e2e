import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createFixtureCleanup,
  checkMaintenancePage,
  dataOf,
  fixtureId,
  isolatedDeviceId,
  isE2eFixture,
  isExpectedRejection,
  MAINT_010_LIFECYCLE_ROUTE,
  MAINT_010_COMPENSATION_ROUTE,
  trackDeletable,
  trackEvent
} from '../suites/iot-maintenance.mjs'

const caseRecord = () => ({ checks: [], notes: [] })

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

test('a retained repair fixture is not recorded as deleted', async () => {
  const record = caseRecord()
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-008', caseRecord: record })
  fixtures.track(7, 'repair fixture', async () => ({ retained: true }))

  await fixtures.cleanup(false)

  assert.equal(record.checks[0].passed, true)
  assert.match(record.checks[0].name, /已保留/)
  assert.doesNotMatch(record.checks[0].name, /已清理/)
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
