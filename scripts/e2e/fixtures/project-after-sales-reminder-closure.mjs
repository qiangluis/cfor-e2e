import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { normalizeLocalDate } from '../lib/local-date.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'

export const reminderExecutePath = '/after-sales/automation/reminder/execute'
const owned = new WeakSet()
const data = (response, label) => assertBusinessSuccess(response, label).data
const id = (value, label = 'reminder ID') => {
  assert.ok(typeof value === 'string' || typeof value === 'number', `${label}: invalid type`)
  assert.match(String(value), /^[1-9]\d*$/, `${label}: missing positive ID`)
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value), `${label}: lossy ID`)
  assert.ok(BigInt(value) <= 9223372036854775807n, `${label}: ID exceeds Long`)
  return String(value)
}

export const normalizeReminderDate = (value, label = 'PB124 date') => normalizeLocalDate(value, label)

export const normalizeReminderDateTime = (value, label = 'PB124 date-time') => {
  let date, time
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(value)
    assert.ok(match, `${label}: expected an ISO local date-time without a timezone`)
    date = normalizeReminderDate(match[1], label)
    time = [Number(match[2]), Number(match[3]), Number(match[4] ?? 0),
      Number((match[5] || '').padEnd(9, '0'))]
  } else {
    assert.ok(Array.isArray(value) && value.length >= 5 && value.length <= 7 &&
      Array.from(value).every(Number.isSafeInteger), `${label}: expected a LocalDateTime tuple`)
    date = normalizeReminderDate(value.slice(0, 3), label)
    time = [value[3], value[4], value[5] ?? 0, value[6] ?? 0]
  }
  const [hour, minute, second, nanos] = time
  assert.ok(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 &&
    second >= 0 && second <= 59 && nanos >= 0 && nanos <= 999999999,
  `${label}: invalid local time`)
  // Preserve fractional precision so a nonzero fraction cannot pass an exact second comparison.
  const fraction = nanos === 0 ? '' : `.${String(nanos).padStart(9, '0').replace(/0+$/, '')}`
  return `${date} ${time.slice(0, 3).map((part) => String(part).padStart(2, '0')).join(':')}${fraction}`
}

const sqlIdentifier = (value) => {
  assert.match(value, /^[a-z][a-z0-9_]*$/, 'Unsafe snapshot identifier')
  return `\`${value}\``
}
export const reminderProtectedTables = Object.freeze([
  'after_sales_reminder_rule', 'after_sales_ticket', 'after_sales_ticket_sla',
  'after_sales_sla_clock_log', 'after_sales_escalation_log', 'after_sales_inspection_task',
  'after_sales_work_report', 'after_sales_customer_asset', 'after_sales_asset_service_period',
  'after_sales_external_outbox', 'after_sales_external_callback_log'
])

export const assertReminderLocalTarget = (settings = config, write = process.env.CFOR_E2E_WRITE_FIXTURES) => {
  assert.equal(write, 'true', 'PB124 requires explicit CFOR_E2E_WRITE_FIXTURES=true')
  assert.equal(settings.target, 'local', 'PB124 requires local target')
  assert.equal(String(settings.tenantId), '1', 'PB124 requires tenant 1')
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'PB124 requires loopback')
    assert.equal(url.port, port, 'PB124 port mismatch')
  }
  assertLocalDatabase(settings.db)
}
const requireOwned = (fixture) => assert.ok(owned.has(fixture), 'PB124 requires a fixture created in this run')
const day = (offset, now) => {
  const date = new Date(`${new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai'
  }).format(now)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export const newReminderFixture = (now = new Date()) => {
  const marker = `PB124-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const fixture = {
    marker, customerNo: `${marker}-CUSTOMER`, assetNo: `${marker}-ASSET`,
    period: { startDate: day(-7, now), endDate: day(7, now) },
    times: {
      notDue: `${day(6, now)} 20:59:00`, quiet: `${day(7, now)} 00:00:00`,
      first: `${day(6, now)} 21:00:00`, next: `${day(7, now)} 09:00:00`,
      max: `${day(7, now)} 21:00:00`
    },
    rules: []
  }
  owned.add(fixture)
  return fixture
}

const requireAsset = async (api, fixture) => {
  requireOwned(fixture)
  const detail = data(await api.getBusiness(`/after-sales/asset/get?id=${id(fixture.assetId)}`), 'PB124 asset')
  assert.equal(id(detail?.asset?.id), fixture.assetId)
  assert.equal(id(detail.asset.customerId), fixture.customerId)
  assert.equal(id(detail.asset.materialId), fixture.materialId)
  assert.equal(detail.asset.assetNo, fixture.assetNo, 'PB124 foreign asset')
  assert.equal(detail.customer?.customerNo, fixture.customerNo, 'PB124 foreign customer')
  assert.equal(normalizeReminderDate(detail.asset.useStartDate, 'PB124 asset useStartDate'),
    fixture.period.startDate, 'PB124 asset useStartDate mismatch')
  assert.equal(normalizeReminderDate(detail.asset.serviceStartDate, 'PB124 asset serviceStartDate'),
    fixture.period.startDate, 'PB124 asset serviceStartDate mismatch')
  assert.equal(normalizeReminderDate(detail.asset.serviceEndDate, 'PB124 asset serviceEndDate'),
    fixture.period.endDate, 'PB124 asset serviceEndDate mismatch')
  assert.equal(detail.asset.serviceStatus, 'IN_SERVICE')
  return detail
}

// The referenced material is read-only; this helper creates only a dedicated after-sales aggregate.
export const prepareReminderAsset = async ({ api, fixture, materialId, caseRecord, dependencies = {} }) => {
  requireOwned(fixture)
  assertReminderLocalTarget(dependencies.config || config, dependencies.writeEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  assert.equal(fixture.assetId, undefined, 'PB124 asset is already prepared')
  fixture.materialId = id(materialId, 'PB124 referenced material')
  const material = data(await api.getBusiness(`/mes/basMaterial/queryById?id=${fixture.materialId}`), 'PB124 material')
  assert.equal(id(material?.id), fixture.materialId)
  const profile = data(await api.postBusiness('/after-sales/asset/customer-profile/create', {
    customerNo: fixture.customerNo, fullName: fixture.customerNo, shortName: fixture.marker,
    primaryContactName: `${fixture.marker}-CONTACT`, primaryContactMobile: '13800000124',
    assets: [{
      assetNo: fixture.assetNo, materialId: fixture.materialId, assetName: fixture.marker,
      assetContent: fixture.marker, useStartDate: fixture.period.startDate,
      storageAddress: fixture.marker,
      managers: [{ departmentName: 'E2E', managerName: fixture.marker,
        managerMobile: '13800000124', primary: true }],
      servicePeriods: [{ ...fixture.period, sourceType: 'MANUAL', sourceNo: fixture.assetNo,
        sourceName: fixture.marker, idempotencyKey: fixture.assetNo }]
    }]
  }), 'PB124 dedicated customer profile')
  assert.ok(Array.isArray(profile?.assetIds) && profile.assetIds.length === 1)
  fixture.customerId = id(profile.customerId)
  fixture.assetId = id(profile.assetIds[0])
  fixture.assetDetail = structuredClone(await requireAsset(api, fixture))
  caseRecord.notes.push(`PB124 专属客户=${fixture.customerId}，资产=${fixture.assetId}；无正式删除入口，保留验收来源。`)
  return fixture.assetDetail
}

const requireRule = async (api, fixture, rule) => {
  requireOwned(fixture)
  assert.ok(fixture.rules.includes(rule), 'PB124 foreign rule')
  const rules = data(await api.getBusiness('/after-sales/modeling/reminder-rule/list'), 'PB124 reminder rules')
  assert.ok(Array.isArray(rules), 'PB124 missing rule list')
  const matches = rules.filter((row) => String(row?.id) === rule.id || row?.ruleCode === rule.body.ruleCode)
  assert.equal(matches.length, 1, 'PB124 owned rule not uniquely visible')
  const found = matches[0]
  assert.equal(id(found.id), rule.id)
  assert.equal(found.ruleCode, rule.body.ruleCode)
  assert.equal(found.reminderScene, 'ASSET_SERVICE_DUE')
  assert.equal(found.firstDelayMinutes, rule.body.firstDelayMinutes)
  assert.equal(found.idempotencyKeyTemplate, rule.body.idempotencyKeyTemplate)
  assert.equal(found.quietHoursStart, '22:00')
  assert.equal(found.quietHoursEnd, '08:00')
  assert.equal(found.repeatIntervalMinutes, 720)
  assert.equal(found.maxTimes, 2)
  assert.equal(found.repeatEnabled, true)
  return found
}

export const createReminderClosureRule = async ({ api, fixture, dependencies = {} }) => {
  requireOwned(fixture)
  assertReminderLocalTarget(dependencies.config || config, dependencies.writeEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES)
  await requireAsset(api, fixture)
  assert.equal(fixture.rules.length, 0, 'PB124 only creates one explicit owned rule')
  const rule = { body: {
    ruleCode: `${fixture.marker}-RULE`, ruleName: fixture.marker, reminderScene: 'ASSET_SERVICE_DUE',
    applicableStatuses: ['IN_SERVICE', 'SERVICE_EXPIRED'], firstDelayMinutes: 180,
    repeatEnabled: true, repeatIntervalMinutes: 720, maxTimes: 2,
    channels: ['SYSTEM'], receiverTypes: ['HANDLER'], stopCondition: 'SERVICE_RENEWED',
    messageTemplate: fixture.marker, idempotencyKeyTemplate: 'PB124:{ruleId}:{bizType}:{bizId}:{sequence}',
    quietHoursStart: '22:00', quietHoursEnd: '08:00', remark: fixture.marker
  } }
  fixture.rules.push(rule)
  rule.id = id(data(await api.postBusiness('/after-sales/modeling/reminder-rule/create', rule.body), 'PB124 rule'))
  assert.equal((await requireRule(api, fixture, rule)).status, 'ENABLED')
  return rule
}

export const reminderExpectedKeys = (fixture, rule) => {
  requireOwned(fixture)
  assert.ok(fixture.rules.includes(rule))
  return [0, 1].map((sequence) => `PB124:${id(rule.id)}:ASSET:${id(fixture.assetId)}:${sequence}`)
}

export const buildReminderProtectedSql = (metadata, keys) => {
  assert.ok(Array.isArray(keys) && keys.length === 2 &&
    keys.every((key) => /^PB124:[1-9]\d*:ASSET:[1-9]\d*:[01]$/.test(key)))
  return reminderProtectedTables.map((table) => {
    const columns = metadata.filter((row) => row[0] === table).map((row) => row[1])
    assert.ok(columns.includes('id') && columns.includes('tenant_id') &&
      new Set(columns).size === columns.length, `PB124 incomplete schema ${table}`)
    const fields = columns.map((column) => `'${sqlIdentifier(column).slice(1, -1)}', HEX(${sqlIdentifier(column)})`)
      .join(', ')
    const where = table === 'after_sales_external_outbox'
      ? ` WHERE NOT (tenant_id=1 AND idempotency_key IN ('${keys.join("','")}'))` : ''
    return `SELECT 'table', '${table}', COUNT(*) FROM ${sqlIdentifier(table)}${where};
      SELECT 'row', '${table}', CAST(id AS CHAR), SHA2(CAST(JSON_OBJECT(${fields}) AS CHAR),256)
      FROM ${sqlIdentifier(table)}${where} ORDER BY id`
  }).join(';\n')
}

const requiredRead = async (sql, read, caseRecord, stage) => {
  const result = await read(sql)
  if (!result.available) throw new Error(`BLOCKED: PB124 real SQL evidence unavailable: ${result.reason}`)
  assert.ok(Array.isArray(result.rows), 'PB124 missing DB rows')
  caseRecord.database = [...(caseRecord.database || []), { stage, ...result }]
  return result.rows
}

export const assertReminderProtectedSnapshot = (rows) => {
  assert.ok(Array.isArray(rows) && rows.every((row) => reminderProtectedTables.includes(row[1])))
  for (const table of reminderProtectedTables) {
    const totals = rows.filter((row) => row[0] === 'table' && row[1] === table)
    const facts = rows.filter((row) => row[0] === 'row' && row[1] === table)
    assert.equal(totals.length, 1, `PB124 missing count ${table}`)
    assert.match(totals[0][2], /^(?:0|[1-9]\d*)$/)
    assert.equal(Number(totals[0][2]), facts.length, `PB124 incomplete rows ${table}`)
    assert.equal(new Set(facts.map((row) => row[2])).size, facts.length)
    assert.ok(facts.every((row) => row.length === 4 && /^[1-9]\d*$/.test(row[2]) &&
      /^[a-f0-9]{64}$/i.test(row[3])), `PB124 invalid row hash ${table}`)
    assert.equal(rows.filter((row) => row[1] === table).length, totals.length + facts.length)
  }
}

export const assertReminderOutboxRows = (rows, fixture, rule, sequences) => {
  const keys = reminderExpectedKeys(fixture, rule)
  assert.equal(rows.length, sequences.length, 'PB124 must have exactly one row per executed sequence')
  const byKey = new Map(rows.map((row) => [row[4], row]))
  assert.equal(byKey.size, rows.length, 'PB124 duplicate event rows')
  for (const sequence of sequences) {
    const row = byKey.get(keys[sequence])
    assert.ok(row, `PB124 missing event sequence ${sequence}`)
    assert.equal(row.length, 11)
    id(row[0], 'PB124 event'); assert.equal(row[1], 'ASSET')
    assert.equal(row[2], fixture.assetId); assert.equal(row[3], 'REMINDER_PENDING')
    assert.equal(row[5], 'PENDING'); assert.equal(row[6], '0')
    assert.equal(row[7], 'NULL'); assert.equal(row[8], 'NULL')
    assert.equal(row[10], '1')
    const payload = JSON.parse(row[9])
    assert.equal(id(payload.ruleId), rule.id); assert.equal(payload.scene, 'ASSET_SERVICE_DUE')
    assert.equal(payload.channels, '["SYSTEM"]'); assert.equal(payload.receiverTypes, '["HANDLER"]')
    assert.equal(payload.template, fixture.marker)
    assert.equal(id(payload.business?.assetId), fixture.assetId)
    assert.equal(payload.business.assetNo, fixture.assetNo)
    assert.equal(normalizeReminderDate(payload.business.serviceEndDate, 'PB124 payload serviceEndDate'),
      fixture.period.endDate, 'PB124 payload serviceEndDate mismatch')
  }
}

export const verifyReminderClosure = async ({ api, fixture, rule, caseRecord, dependencies = {} }) => {
  requireOwned(fixture)
  assertReminderLocalTarget(dependencies.config || config, dependencies.writeEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  await requireAsset(api, fixture)
  assert.equal((await requireRule(api, fixture, rule)).status, 'ENABLED')
  const read = dependencies.runReadOnlySql || runReadOnlySql
  const keys = reminderExpectedKeys(fixture, rule)
  const unique = await requiredRead(`SELECT INDEX_NAME, NON_UNIQUE,
      GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME='after_sales_external_outbox'
    GROUP BY INDEX_NAME, NON_UNIQUE`, read, caseRecord, 'PB124-outbox-unique-index')
  assert.ok(unique.some((row) => row[1] === '0' &&
    ['idempotency_key,tenant_id', 'tenant_id,idempotency_key'].includes(row[2])),
  'PB124 requires the actual tenant/idempotency-key unique index')
  const metadata = await requiredRead(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('${reminderProtectedTables.join("','")}')
    ORDER BY TABLE_NAME,ORDINAL_POSITION`, read, caseRecord, 'PB124-protected-schema')
  const protectedSql = buildReminderProtectedSql(metadata, keys)
  const before = await requiredRead(protectedSql, read, caseRecord, 'PB124-protected-before')
  assertReminderProtectedSnapshot(before)
  const eventsSql = `SELECT CAST(id AS CHAR),biz_type,CAST(biz_id AS CHAR),event_type,idempotency_key,
    status,retry_count,IFNULL(response_payload,'NULL'),IFNULL(last_error,'NULL'),request_payload,tenant_id
    FROM after_sales_external_outbox WHERE tenant_id=1 AND deleted=0
      AND idempotency_key IN ('${keys.join("','")}') ORDER BY id`
  const readEvents = (stage) => requiredRead(eventsSql, read, caseRecord, stage)
  const initial = await readEvents('PB124-outbox-before')
  assertReminderOutboxRows(initial, fixture, rule, [])
  const execute = async (now, expected, stage) => {
    const result = data(await api.postBusiness(reminderExecutePath, {
      ruleId: rule.id, businessId: fixture.assetId, now
    }), 'PB124 explicit reminder execution')
    assert.equal(id(result?.ruleId), rule.id)
    assert.equal(id(result.businessId), fixture.assetId)
    assert.equal(normalizeReminderDateTime(result.executeTime, 'PB124 executeTime'),
      normalizeReminderDateTime(now, 'PB124 requested time'), 'PB124 executeTime mismatch')
    assert.equal(result.createdCount, expected, `${stage}: duplicate must not claim creation`)
    caseRecord.checks.push({ name: `PB124 ${stage} 返回实际新增数 ${expected}`, passed: true,
      details: `${rule.id}/${fixture.assetId}/${now}` })
  }
  await execute(fixture.times.notDue, 0, '未到期')
  // Probe quiet hours before creating sequence 0 so deduplication cannot mask the quiet-hour gate.
  await execute(fixture.times.quiet, 0, '跨午夜免打扰')
  assertReminderOutboxRows(await readEvents('PB124-outbox-suppressed'), fixture, rule, [])
  await execute(fixture.times.first, 1, '到期前180分钟边界新建')
  const first = await readEvents('PB124-outbox-first')
  assertReminderOutboxRows(first, fixture, rule, [0])
  await execute(fixture.times.first, 0, '重复执行')
  assert.deepEqual(await readEvents('PB124-outbox-repeat'), first, 'PB124 repeat modified its existing event')
  await execute(fixture.times.next, 1, '下一频率')
  const next = await readEvents('PB124-outbox-next')
  assertReminderOutboxRows(next, fixture, rule, [0, 1])
  await execute(fixture.times.next, 0, '重复下一频率')
  await execute(fixture.times.max, 0, '次数上限')
  assert.deepEqual(await readEvents('PB124-outbox-max'), next, 'PB124 max/repeat modified existing events')
  const after = await requiredRead(protectedSql, read, caseRecord, 'PB124-protected-after')
  assertReminderProtectedSnapshot(after)
  assert.deepEqual(after, before, 'PB124 altered business facts, global events, escalation, worker or callbacks')
  assert.deepEqual(await requireAsset(api, fixture), fixture.assetDetail, 'PB124 altered asset aggregate')
  caseRecord.checks.push({ name: 'PB124 实库唯一索引、每序列单行及事件内容幂等',
    passed: true, details: `keys=${keys.join(',')}; created=2; delivered=0` },
  { name: 'PB124 规则/业务事实/升级/其他对象事件/回调逐行哈希完全不变',
    passed: true, details: `protectedRows=${before.length}; pending only; no worker or global scan` })
  caseRecord.notes.push('本夹具仅验证指定规则对象的待发送事件，不验证真实渠道、通知/待办投递或升级。')
  return { scopedReminderVerified: true, createdCount: 2, keys, events: next }
}

export const cleanupReminderClosure = async ({ api, fixture, caseRecord, dependencies = {} }) => {
  requireOwned(fixture)
  assertReminderLocalTarget(dependencies.config || config, dependencies.writeEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES)
  for (const rule of fixture.rules) {
    if (!rule.id) {
      caseRecord.notes.push(`PB124 未取得规则 ID，需人工核对 ${rule.body.ruleCode}；不按模糊编码批量清理。`)
      continue
    }
    await requireRule(api, fixture, rule)
    data(await api.postBusiness(
      `/after-sales/modeling/status?configType=REMINDER_RULE&id=${rule.id}&enabled=false`), 'PB124 disable rule')
    assert.equal((await requireRule(api, fixture, rule)).status, 'DISABLED')
    caseRecord.checks.push({ name: 'PB124 专属提醒规则停用回读', passed: true, details: rule.id })
  }
  caseRecord.notes.push(`PB124 客户=${fixture.customerId || '未创建'}，资产=${fixture.assetId || '未创建'}及待发送事件保留；
    无正式删除/取消接口，未直接 SQL 清理、未触发发送。`)
}
