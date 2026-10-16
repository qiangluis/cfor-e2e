import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  finalizeProjectAfterSalesCatalogAssertions,
  runCase
} from '../suites/project-after-sales.mjs'
import {
  reminderExecutePath, reminderProtectedTables, assertReminderLocalTarget, newReminderFixture,
  prepareReminderAsset, createReminderClosureRule, reminderExpectedKeys, buildReminderProtectedSql,
  assertReminderProtectedSnapshot, assertReminderOutboxRows, verifyReminderClosure, cleanupReminderClosure,
  normalizeReminderDate, normalizeReminderDateTime
} from '../fixtures/project-after-sales-reminder-closure.mjs'

const local = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151', db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const metadata = reminderProtectedTables.flatMap((table) =>
  ['id', 'tenant_id', 'deleted'].map((column) => [table, column]))
const protectedRows = () => reminderProtectedTables.map((table) => ['table', table, '0'])
const success = (data) => ({ code: 0, data })
const caseRecord = () => ({ checks: [], notes: [], evidence: [] })
const dateTuple = (value) => value.split('-').map(Number)
const timeTuple = (value) => value.split(/[-T :]/).map(Number)

const setup = ({
  badCount = false, changeProtected = false, mutateRepeat = false, available = true,
  assetDate = (value) => value, payloadDate = (value) => value, executeTime = (value) => value
} = {}) => {
  const fixture = newReminderFixture(new Date('2026-10-13T04:00:00Z'))
  const record = caseRecord()
  const calls = []
  const events = []
  let rule, detail, snapshotReads = 0
  const sql = async (statement) => {
    calls.push(['SQL', statement])
    if (!available) return { available: false, rows: [], reason: 'not configured' }
    if (statement.includes('information_schema.STATISTICS')) {
      return { available: true, rows: [['uk_outbox_idempotency', '0', 'idempotency_key,tenant_id']] }
    }
    if (statement.includes('information_schema.COLUMNS')) return { available: true, rows: metadata }
    if (statement.startsWith('SELECT CAST(id AS CHAR)')) return { available: true, rows: structuredClone(events) }
    snapshotReads++
    const rows = protectedRows()
    if (changeProtected && snapshotReads > 1) rows[0][2] = '1'
    return { available: true, rows }
  }
  const api = {
    getBusiness: async (path) => {
      calls.push(['GET', path])
      if (path.startsWith('/mes/basMaterial/queryById')) return success({ id: '123' })
      if (path.startsWith('/after-sales/asset/get')) return success(structuredClone(detail))
      if (path === '/after-sales/modeling/reminder-rule/list') return success([{ ...rule }])
      assert.fail(`unexpected GET ${path}`)
    },
    postBusiness: async (path, body) => {
      calls.push(['POST', path, body])
      if (path === '/after-sales/asset/customer-profile/create') {
        detail = { customer: { id: '200', customerNo: fixture.customerNo },
          asset: { id: '300', customerId: '200', materialId: '123', assetNo: fixture.assetNo,
            useStartDate: assetDate(fixture.period.startDate),
            serviceStartDate: assetDate(fixture.period.startDate),
            serviceEndDate: assetDate(fixture.period.endDate), serviceStatus: 'IN_SERVICE' } }
        return success({ customerId: '200', assetIds: ['300'] })
      }
      if (path === '/after-sales/modeling/reminder-rule/create') {
        rule = { ...body, id: '400', status: 'ENABLED' }
        return success('400')
      }
      if (path.includes('/modeling/status?')) {
        rule.status = 'DISABLED'
        return success(true)
      }
      assert.equal(path, reminderExecutePath, 'must not call global automation/scan or workers')
      assert.equal(body.ruleId, '400')
      assert.equal(body.businessId, '300')
      let created = 0
      const sequence = body.now === fixture.times.first ? 0 : body.now === fixture.times.next ? 1 : null
      if (sequence != null) {
        const key = reminderExpectedKeys(fixture, fixture.rules[0])[sequence]
        if (!events.some((row) => row[4] === key)) {
          events.push([
            String(500 + sequence), 'ASSET', '300', 'REMINDER_PENDING', key,
            'PENDING', '0', 'NULL', 'NULL', JSON.stringify({
              ruleId: '400', scene: 'ASSET_SERVICE_DUE', channels: '["SYSTEM"]',
              receiverTypes: '["HANDLER"]', template: fixture.marker,
              business: { assetId: '300', assetNo: fixture.assetNo,
                serviceEndDate: payloadDate(fixture.period.endDate) }
            }), '1'
          ])
          created = 1
        } else if (mutateRepeat) events[0][5] = 'SUCCESS'
        if (badCount && created === 0) created = 1
      }
      return success({ ruleId: '400', businessId: '300', executeTime: executeTime(body.now), createdCount: created })
    },
    putBusiness: async () => assert.fail('reminder must not update business objects'),
    deleteBusiness: async () => assert.fail('reminder must not delete business objects')
  }
  const dependencies = {
    config: local, writeEnabled: 'true', runReadOnlySql: sql,
    assertLocalWriteSafety: async () => { calls.push(['SAFETY']) }
  }
  const prepare = async () => {
    await prepareReminderAsset({ api, fixture, materialId: '123', caseRecord: record, dependencies })
    const rule = await createReminderClosureRule({ api, fixture, dependencies })
    return rule
  }
  return { fixture, record, api, dependencies, calls, events, prepare, get detail() { return detail } }
}

test('PB124 guard rejects implicit writes, online targets, foreign tenant/database/ports', () => {
  assert.doesNotThrow(() => assertReminderLocalTarget(local, 'true'))
  for (const settings of [
    { ...local, target: 'online' }, { ...local, tenantId: '2' },
    { ...local, db: { ...local.db, name: 'production' } },
    { ...local, apiBase: 'http://127.0.0.1:48080' },
    { ...local, webBase: 'http://example.test:9151' }
  ]) assert.throws(() => assertReminderLocalTarget(settings, 'true'))
  assert.throws(() => assertReminderLocalTarget(local, 'false'))
})

test('PB124 fixture carries real time-boundary sequence and cannot be forged', async () => {
  const fixture = newReminderFixture(new Date('2026-10-13T04:00:00Z'))
  assert.match(fixture.marker, /^PB124-[0-9a-f]{16}$/)
  assert.equal(fixture.times.notDue, '2026-10-19 20:59:00')
  assert.equal(fixture.times.first, '2026-10-19 21:00:00')
  assert.equal(fixture.times.next, '2026-10-20 09:00:00')
  const due = new Date(`${fixture.period.endDate}T00:00:00Z`)
  assert.equal(due.getTime() - new Date(fixture.times.first.replace(' ', 'T') + 'Z').getTime(),
    180 * 60 * 1000, 'must execute at the configured lead-time boundary, not after expiry')
  const context = setup()
  await assert.rejects(prepareReminderAsset({
    api: context.api, fixture: { ...fixture }, materialId: '123',
    caseRecord: context.record, dependencies: context.dependencies
  }), /created in this run/)
  await assert.rejects(prepareReminderAsset({
    api: context.api, fixture, materialId: 2 ** 54,
    caseRecord: context.record, dependencies: context.dependencies
  }), /lossy/)
})

test('PB124 strict dates normalize ISO and LocalDate tuples including leap-year boundaries', () => {
  for (const [tuple, expected] of [
    [[2026, 10, 20], '2026-10-20'], [[2026, 1, 9], '2026-01-09'],
    [[2000, 2, 29], '2000-02-29'], [[1, 1, 1], '0001-01-01'],
    [[9999, 12, 31], '9999-12-31']
  ]) {
    const original = structuredClone(tuple)
    assert.equal(normalizeReminderDate(tuple), expected)
    assert.equal(normalizeReminderDate(expected), expected)
    assert.deepEqual(tuple, original, 'normalization must not rewrite the original evidence')
  }
})

test('PB124 strict dates reject rollover, wrong shapes, coercion, timestamps and missing values', () => {
  for (const value of [
    '2026-02-30', '1900-02-29', '2026-04-31', '0000-01-01', '2026-13-01',
    '2026-1-09', '2026-10-20T00:00:00', '2026-10-20Z', ' 2026-10-20',
    [2026, 2, 29], [100, 2, 29], [2026, 4, 31], [2026, 13, 1], [2026, 0, 1],
    [2026, 10, 0], [10000, 1, 1], [2026, 10, 20, 0], [2026, 10],
    [2026, 10, 20.5], ['2026', 10, 20], [true, 10, 20], [NaN, 10, 20],
    [Infinity, 10, 20], new Array(3), [], null, undefined, 1792454400000,
    new Date('2026-10-20T00:00:00Z'), { year: 2026, month: 10, day: 20 }
  ]) assert.throws(() => normalizeReminderDate(value), /PB124 date:/)
})

test('PB124 local date-times accept Jackson tuples and ISO without losing fractional precision', () => {
  for (const value of [
    '2026-10-20 08:30:00', '2026-10-20T08:30:00', '2026-10-20T08:30',
    '2026-10-20T08:30:00.000000000',
    [2026, 10, 20, 8, 30], [2026, 10, 20, 8, 30, 0], [2026, 10, 20, 8, 30, 0, 0]
  ]) assert.equal(normalizeReminderDateTime(value), '2026-10-20 08:30:00')
  for (const [value, expected] of [
    [[2026, 10, 20, 8, 30, 0, 1], '2026-10-20 08:30:00.000000001'],
    ['2026-10-20T08:30:00.001', '2026-10-20 08:30:00.001'],
    [[2026, 10, 20, 8, 30, 0, 100000000], '2026-10-20 08:30:00.1'],
    ['2026-10-20T08:30:00.123456789', '2026-10-20 08:30:00.123456789']
  ]) assert.equal(normalizeReminderDateTime(value), expected)
})

test('PB124 local date-times reject invalid calendar/time, offsets and malformed tuples', () => {
  for (const value of [
    '2026-02-30T08:30:00', '2026-10-20T24:00:00', '2026-10-20T08:60:00',
    '2026-10-20T08:30:60', '2026-10-20T08:30:00Z', '2026-10-20T08:30:00+08:00',
    '2026-10-20T08:30:00.1234567890', '2026-10-20T8:30:00', '2026-10-20',
    '2026-10-20T08:30:00junk', ' 2026-10-20T08:30:00', null, undefined, 1792485000000,
    [2026, 10, 20], [2026, 10, 20, 8], [2026, 10, 20, 24, 0],
    [2026, 10, 20, 8, -1], [2026, 10, 20, 8, 30, 60], [2026, 2, 30, 8, 30],
    [2026, 10, 20, 8, 30, 0, -1], [2026, 10, 20, 8, 30, 0, 1000000000],
    [2026, 10, 20, 8, 30, 0, 0, 0], [2026, 10, 20, '8', 30],
    [2026, 10, 20, 8.5, 30], [2026, 10, 20, 8, 30, NaN], new Array(5)
  ]) assert.throws(() => normalizeReminderDateTime(value), /PB124 date-time:/)
})

test('PB124 complete fixture accepts real outbox LocalDate arrays and array/ISO execution times', async () => {
  for (const options of [
    { payloadDate: dateTuple, executeTime: (value) => value.replace(' ', 'T') },
    { assetDate: dateTuple, payloadDate: dateTuple, executeTime: timeTuple },
    { assetDate: dateTuple, executeTime: (value) => [...timeTuple(value), 0] },
    { payloadDate: dateTuple, executeTime: (value) => timeTuple(value).slice(0, 5) }
  ]) {
    const context = setup(options)
    const rule = await context.prepare()
    const result = await verifyReminderClosure({
      api: context.api, fixture: context.fixture, rule,
      caseRecord: context.record, dependencies: context.dependencies
    })
    assert.equal(result.scopedReminderVerified, true)
    assert.equal(result.createdCount, 2)
    assert.equal(context.events.length, 2)
    assert.deepEqual(context.fixture.assetDetail, context.detail, 'raw asset snapshot must remain intact')
    for (const row of context.events) {
      assert.deepEqual(JSON.parse(row[9]).business.serviceEndDate,
        (options.payloadDate || ((value) => value))(context.fixture.period.endDate))
    }
    await cleanupReminderClosure({
      api: context.api, fixture: context.fixture,
      caseRecord: context.record, dependencies: context.dependencies
    })
    assert.equal(context.record.checks.every((check) => check.passed), true)
    assert.equal(context.calls.filter(([method, path]) =>
      method === 'POST' && path === reminderExecutePath).length, 7)
  }
})

test('PB124 every asset date stays exact; missing, invalid or changed dates block before execution', async () => {
  for (const field of ['useStartDate', 'serviceStartDate', 'serviceEndDate']) {
    for (const value of ['2026-10-21', [2026, 10, 21], [2026, 2, 30], null, undefined]) {
      const context = setup()
      const rule = await context.prepare()
      context.detail.asset[field] = value
      await assert.rejects(verifyReminderClosure({
        api: context.api, fixture: context.fixture, rule,
        caseRecord: context.record, dependencies: context.dependencies
      }), /PB124 asset .*mismatch|PB124 asset .*invalid|PB124 asset .*expected/)
      assert.equal(context.calls.filter(([method, path]) =>
        method === 'POST' && path === reminderExecutePath).length, 0)
    }
  }
})

test('PB124 outbox date normalization cannot accept wrong days, invalid dates or missing values', async () => {
  for (const value of ['2026-10-21', [2026, 10, 21], [2026, 2, 30], null, undefined,
    '2026-10-20T00:00:00', [2026, 10, 20, 0]]) {
    const context = setup({ payloadDate: () => value })
    const rule = await context.prepare()
    await assert.rejects(verifyReminderClosure({
      api: context.api, fixture: context.fixture, rule,
      caseRecord: context.record, dependencies: context.dependencies
    }), /PB124 payload .*mismatch|PB124 payload .*invalid|PB124 payload .*expected/)
  }
})

test('PB124 executeTime requires exact date, second and nanoseconds without timezone conversion', async () => {
  for (const executeTime of [
    () => '2026-10-20T21:59:00',
    (value) => [...timeTuple(value).slice(0, 5), 1],
    (value) => `${value}.000000001`,
    (value) => [...timeTuple(value), 1],
    (value) => `${value.replace(' ', 'T')}Z`,
    (value) => [...timeTuple(value), 1000000000],
    () => undefined
  ]) {
    const context = setup({ executeTime })
    const rule = await context.prepare()
    await assert.rejects(verifyReminderClosure({
      api: context.api, fixture: context.fixture, rule,
      caseRecord: context.record, dependencies: context.dependencies
    }), /PB124 executeTime mismatch|PB124 executeTime: expected|PB124 executeTime: invalid/)
    assert.equal(context.events.length, 0)
  }
})

test('PB124 repeats cannot rewrite raw event dates even to a semantically equivalent ISO string', async () => {
  const context = setup({ payloadDate: dateTuple })
  const rule = await context.prepare()
  const originalPost = context.api.postBusiness
  let firstExecutions = 0
  context.api.postBusiness = async (path, body) => {
    const result = await originalPost(path, body)
    if (path === reminderExecutePath && body.now === context.fixture.times.first &&
        ++firstExecutions === 2) {
      const payload = JSON.parse(context.events[0][9])
      payload.business.serviceEndDate = normalizeReminderDate(payload.business.serviceEndDate)
      context.events[0][9] = JSON.stringify(payload)
    }
    return result
  }
  await assert.rejects(verifyReminderClosure({
    api: context.api, fixture: context.fixture, rule,
    caseRecord: context.record, dependencies: context.dependencies
  }), /PB124 repeat modified its existing event/)
})

test('PB124 full-field hashes protect all tenants and exclude only the two exact owned keys', () => {
  const keys = ['PB124:400:ASSET:300:0', 'PB124:400:ASSET:300:1']
  const sql = buildReminderProtectedSql(metadata, keys)
  assert.match(sql, /NOT \(tenant_id=1 AND idempotency_key IN \('PB124:400:ASSET:300:0','PB124:400:ASSET:300:1'\)\)/)
  assert.match(sql, /SHA2\(CAST\(JSON_OBJECT/)
  assert.doesNotMatch(sql, /deleted=0|LIKE|INSERT|UPDATE|DELETE/)
  assert.throws(() => buildReminderProtectedSql(metadata, ["x' OR 1=1", 'other']))
  assert.throws(() => buildReminderProtectedSql(metadata.filter((row) =>
    row[0] !== 'after_sales_escalation_log'), keys))
})

test('PB124 protected snapshots require all tables and full count/row hashes', () => {
  assert.doesNotThrow(() => assertReminderProtectedSnapshot(protectedRows()))
  for (const rows of [[], protectedRows().slice(1),
    [...protectedRows(), ['row', 'unknown', '1', 'a'.repeat(64)]]]) {
    assert.throws(() => assertReminderProtectedSnapshot(rows))
  }
})

test('PB124 distinct sequences create two pending rows; repeats, quiet and max create none', async () => {
  const context = setup()
  const rule = await context.prepare()
  const result = await verifyReminderClosure({
    api: context.api, fixture: context.fixture, rule,
    caseRecord: context.record, dependencies: context.dependencies
  })
  assert.equal(result.scopedReminderVerified, true)
  assert.equal(result.createdCount, 2)
  assert.equal(context.events.length, 2)
  assert.equal(context.record.checks.every((check) => check.passed), true)
  assert.equal(context.calls.filter(([method, path]) => method === 'POST' && path === reminderExecutePath).length, 7)
  assert.ok(context.calls.filter(([method]) => method === 'POST').every(([, path]) =>
    !path.includes('/scan') && !path.includes('/worker') && !path.includes('/send')))
  await cleanupReminderClosure({
    api: context.api, fixture: context.fixture, caseRecord: context.record, dependencies: context.dependencies
  })
  assert.equal(context.record.checks.at(-1).name, 'PB124 专属提醒规则停用回读')
  assert.match(context.record.notes.at(-1), /未直接 SQL 清理/)
})

test('PB124 rejects the old count bug and changes to existing pending events', async () => {
  for (const options of [{ badCount: true }, { mutateRepeat: true }]) {
    const context = setup(options)
    const rule = await context.prepare()
    await assert.rejects(verifyReminderClosure({
      api: context.api, fixture: context.fixture, rule,
      caseRecord: context.record, dependencies: context.dependencies
    }), /duplicate must not claim creation|repeat modified/)
  }
})

test('PB124 missing real SQL or any protected global change cannot pass', async () => {
  for (const options of [{ available: false }, { changeProtected: true }]) {
    const context = setup(options)
    const rule = await context.prepare()
    await assert.rejects(verifyReminderClosure({
      api: context.api, fixture: context.fixture, rule,
      caseRecord: context.record, dependencies: context.dependencies
    }), /BLOCKED: PB124 real SQL|incomplete rows/)
    if (options.available === false) assert.equal(context.calls.filter(([method, path]) =>
      method === 'POST' && path === reminderExecutePath).length, 0)
  }
})

test('PB124 event assertions reject wrong tenant, payload, status, duplicate rows and result', async () => {
  const context = setup()
  const rule = await context.prepare()
  await verifyReminderClosure({
    api: context.api, fixture: context.fixture, rule, caseRecord: context.record,
    dependencies: context.dependencies
  })
  const first = context.events[0]
  for (const [index, value] of [[1, 'TICKET'], [2, '301'], [3, 'SENT'],
    [5, 'SUCCESS'], [6, '1'], [7, '{}'], [10, '2']]) {
    const row = [...first]; row[index] = value
    assert.throws(() => assertReminderOutboxRows([row], context.fixture, rule, [0]))
  }
  const badPayload = [...first]
  badPayload[9] = JSON.stringify({ ruleId: '401' })
  assert.throws(() => assertReminderOutboxRows([badPayload], context.fixture, rule, [0]))
  assert.throws(() => assertReminderOutboxRows([first, first], context.fixture, rule, [0, 1]))
})

test('PB124 suite without the exact write switch stays partial before browser or API access', async () => {
  const previous = process.env.CFOR_E2E_WRITE_FIXTURES
  try {
    for (const value of [undefined, 'false', '1', 'TRUE']) {
      if (value === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
      else process.env.CFOR_E2E_WRITE_FIXTURES = value
      const record = caseRecord()
      const result = await runCase({
        caseId: 'PB124-001', caseRecord: record,
        page: new Proxy({}, { get() { assert.fail('PB124 must not access the browser') } })
      })
      assert.equal(result.partial, true)
      assert.equal(result.passCandidate, false)
      assert.equal(result.acceptanceComplete, false)
      assert.equal(record.checks.length, 0)
      assert.ok(record.notes.some((note) => note.includes('CFOR_E2E_WRITE_FIXTURES=true')))
    }
  } finally {
    if (previous === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previous
  }
})

test('PB124 suite integrates only the scoped fixture and cleans even after rule readback fails', () => {
  const suite = readFileSync(new URL('../suites/project-after-sales.mjs', import.meta.url), 'utf8')
  const core = suite.slice(suite.indexOf('const runCaseCore ='))
  const block = core.slice(core.indexOf("if (caseId === 'PB124-001')"),
    core.indexOf("if (caseId === 'PB115-001')"))
  assert.match(block, /prepareReminderAsset\(/)
  assert.match(block, /createReminderClosureRule\(/)
  assert.match(block, /verifyReminderClosure\(/)
  assert.match(block, /fixture\.rules\.length > 0\) await cleanupReminderClosure\(/)
  assert.match(block, /partial: true/)
  assert.doesNotMatch(block, /automation\/scan|worker\/|\/send|\/escalation|executeIgnore/)
})

test('PB124 pending-event evidence cannot complete missing catalog or delivery/display/escalation evidence', async () => {
  const context = setup()
  const rule = await context.prepare()
  const closure = await verifyReminderClosure({
    api: context.api, fixture: context.fixture, rule, caseRecord: context.record,
    dependencies: context.dependencies
  })
  await cleanupReminderClosure({
    api: context.api, fixture: context.fixture, caseRecord: context.record,
    dependencies: context.dependencies
  })
  const result = finalizeProjectAfterSalesCatalogAssertions(context.record, 'PB124-001', closure)
  assert.equal(closure.scopedReminderVerified, true)
  assert.equal(result.catalogComplete, false)
  assert.equal(result.passCandidate, false)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.partial, true)
  assert.deepEqual(result.catalogAssertions, [])
  assert.ok(context.record.notes.some((note) => note.includes('不验证真实渠道、通知/待办投递或升级')))
})
