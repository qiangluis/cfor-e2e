import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import {
  WMS_FIXTURE_MARK, assertLocalWmsWriteTarget, createMaterialFixture,
  createWarehouseFixture, dataOf, fixtureCode, isWmsWriteEnabled, rowsOf
} from '../lib/wms-fixtures.mjs'

export const initNumberingClosureChecks = Object.freeze({
  version: '已发布规则编辑生成新草稿且不覆盖历史规则',
  draft: 'PB011 专属 WMS 主单和非空明细正式回读为未执行纯草稿',
  void: 'PB011 专属草稿正式作废后回读作废状态且保留主单明细',
  sequence: 'PB011 正式作废不减少流水且同日期桶下一号严格递增不回收',
  history: 'PB011 新编号版本实际生效后历史主单和明细号码均不重算',
  inventory: 'PB011 纯草稿保存作废及规则换版前后专属库存与展望完整快照不变',
  retention: 'PB011 专属审计数据保留且未删除或重置 sequence'
})

export const initNumberingClosureEvidence = Object.freeze({
  'PB011-001': Object.freeze({
    1: Object.freeze({ checks: Object.freeze([initNumberingClosureChecks.version]) }),
    4: Object.freeze({ checks: Object.freeze([
      initNumberingClosureChecks.draft, initNumberingClosureChecks.void,
      initNumberingClosureChecks.sequence, initNumberingClosureChecks.history,
      initNumberingClosureChecks.inventory, initNumberingClosureChecks.retention
    ]) })
  })
})

export const initNumberingClosurePrerequisites = Object.freeze([
  'CFOR_E2E_WRITE_FIXTURES=true; local 9151/48083; tenant 1 / CFOR 标准平台',
  'Loopback:3306/cfor_admin_standard read-only SQL evidence and existing write-safety preflight',
  'Caller supplies its authenticated tenant-1 API client; no login or browser is created here',
  'Enabled unit; fillRule add/edit/publish/execute/query and WMS master/save/void/read API access',
  'Versioned numbering schema; BillNoRule and server day agree with Asia/Shanghai',
  'Serial execution; no shared settings, opening stock, approvals or inventory writes',
  'Retain private rules, WMS audit documents, referenced masters and sequence after success or failure'
])

const RULE_CLASS = 'tech.cfor17.module.bpm.handler.BillNoRule'
const text = (value) => String(value ?? '')
const empty = (value) => value == null || value === ''
const same = (a, b) => assert.deepEqual(a, b)
const sqlText = (value) => {
  assert.match(text(value), /^[A-Za-z0-9 ._:-]+$/, 'Unsafe PB011 SQL literal')
  return `'${value}'`
}
const idOf = (value, label) => {
  assert(!(typeof value === 'number' && !Number.isSafeInteger(value)), `${label}: unsafe numeric ID`)
  assert.match(text(value), /^[1-9]\d*$/, `${label}: missing positive ID`)
  return text(value)
}
const ruleId = (value) => {
  assert.match(text(value), /^[a-f0-9]{32}$/, 'Missing server-generated rule identity')
  return text(value)
}
const check = (record, name, condition, details) => {
  record.checks.push({ name, passed: condition === true, details: text(details) })
  assert.equal(condition, true, name)
}
const rejectUnsafeIds = (value, key = '') => {
  if (typeof value === 'number' && /(^id$|Id$)/.test(key)) {
    assert(Number.isSafeInteger(value), `${key}: unsafe numeric ID`)
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) rejectUnsafeIds(child, childKey)
  }
}
const dateBucket = (time) => {
  assert(Number.isFinite(time), 'Invalid fixture clock')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(time))
  const get = (key) => parts.find((item) => item.type === key).value
  return `${get('year')}${get('month')}${get('day')}`
}
const epoch = (value) => {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d{13}$/.test(value)) return Number(value)
  const local = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text(value))
  return Date.parse(local ? `${value.replace(' ', 'T')}+08:00` : value)
}
const paramsFor = (prefix) => ({
  segments: [
    { type: 'CONSTANT', value: prefix },
    { type: 'DATE', format: 'yyyyMMdd' },
    { type: 'SEQUENCE', length: 5 }
  ],
  separator: '-', reset: 'DATE', seqLen: 5
})
const ruleView = (row) => ({
  id: ruleId(row?.id), tenantId: idOf(row?.tenantId, 'Rule tenant'),
  ruleCode: text(row?.ruleCode), ruleName: text(row?.ruleName), ruleClass: text(row?.ruleClass),
  versionNo: Number(row?.versionNo), status: text(row?.status),
  ruleParams: JSON.parse(row?.ruleParams), effectiveFrom: epoch(row?.effectiveFrom),
  publishedTime: empty(row?.publishedTime) ? null : epoch(row.publishedTime)
})

// Cast database IDs to strings before JSON encoding to preserve Snowflake precision.
const projection = (columns) => `JSON_OBJECT(${Object.entries(columns).map(([key, column]) =>
  `'${key}',${/^(id|mid|.*Id)$/.test(key) ? `CAST(${column} AS CHAR)` : column}`).join(',')})`
const RULE_COLUMNS = {
  id: 'id', tenantId: 'tenant_id', ruleCode: 'rule_code', ruleName: 'rule_name',
  ruleClass: 'rule_class', versionNo: 'version_no', status: 'status', ruleParams: 'rule_params',
  effectiveFrom: 'UNIX_TIMESTAMP(effective_from)*1000', publishedTime: 'UNIX_TIMESTAMP(published_time)*1000'
}
const BILL_COLUMNS = {
  id: 'id', tenantId: 'tenant_id', billNo: 'bill_no', billDate: 'DATE_FORMAT(bill_date,\'%Y-%m-%d\')',
  subject: 'subject', remark: 'remark', stockIoType: 'stock_io_type', isAuto: 'is_auto',
  billStage: 'bill_stage', isEffective: 'is_effective', isClosed: 'is_closed', isVoided: 'is_voided',
  srcBillType: 'src_bill_type', srcBillId: 'src_bill_id', effectiveTime: 'effective_time',
  processInstanceId: 'process_instance_id', bpmiInstanceId: 'bpmi_instance_id', deleted: 'CAST(deleted AS UNSIGNED)'
}
const ENTRY_COLUMNS = {
  id: 'id', tenantId: 'tenant_id', mid: 'mid', billNo: 'bill_no', entryNo: 'entry_no',
  materialId: 'material_id', unitId: 'unit_id', warehouseId: 'warehouse_id',
  wareAreaId: 'ware_area_id', wareLocationId: 'ware_location_id', batchNo: 'batch_no',
  qty: 'qty', cost: 'cost', stockIoType: 'stock_io_type', stockIoDirection: 'stock_io_direction',
  isQc: 'is_qc', inStockTime: 'in_stock_time', executedQty: 'executed_qty',
  srcBillType: 'src_bill_type', srcBillId: 'src_bill_id', deleted: 'CAST(deleted AS UNSIGNED)'
}
const INVENTORY_COLUMNS = {
  id: 'id', tenantId: 'tenant_id', materialId: 'material_id', warehouseId: 'warehouse_id',
  wareAreaId: 'ware_area_id', wareLocationId: 'ware_location_id', batchNo: 'batch_no', unitId: 'unit_id',
  qty: 'qty', cost: 'cost', availableQty: 'available_qty', lockQty: 'lock_qty', holdQty: 'hold_qty',
  frozenQty: 'frozen_qty', pendingPutawayQty: 'pending_putaway_qty', inQty: 'in_qty', outQty: 'out_qty',
  qualityStatus: 'quality_status', version: 'version', isClosed: 'is_closed', deleted: 'CAST(deleted AS UNSIGNED)'
}
const OUTLOOK_COLUMNS = {
  id: 'id', tenantId: 'tenant_id', materialId: 'material_id', inQty: 'in_qty', outQty: 'out_qty',
  prodQty: 'prod_qty', availableQty: 'available_qty', otherInQty: 'other_in_qty', otherOutQty: 'other_out_qty'
}
const REF_DEFINITIONS = Object.freeze({
  warehouse: { table: 'mes_wms_ware_house', code: 'code', mark: 'mark', kind: 'WH' },
  area: { table: 'mes_wms_house_area', code: 'area_code', mark: 'remark', kind: 'AR',
    parent: { warehouseId: 'house_id' } },
  location: { table: 'mes_wms_house_location', code: 'location_code', mark: 'remark', kind: 'LC',
    parent: { warehouseId: 'house_id', areaId: 'area_id' } },
  material: { table: 'mes_bas_material', code: 'code', mark: 'remark', kind: 'MT',
    parent: { unitId: 'unit_id', inventoryNature: 'inventory_nature' } }
})
const jsonRows = (rows) => rows.map((row) => {
  assert(Array.isArray(row) && row.length === 1 && typeof row[0] === 'string', 'Invalid SQL JSON row')
  const parsed = JSON.parse(row[0])
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid SQL object')
  rejectUnsafeIds(parsed)
  return parsed
})

/**
 * Opt-in API/data evidence only. This does not award a case status or cover UI,
 * arbitrary business dates or a second tenant. Finally is read-only retention,
 * not generic WMS cleanup (which deletes/edits drafts and can write back stock).
 */
export async function runInitNumberingClosure ({ api, caseRecord, caseId = 'PB011-001' }, dependencies = {}) {
  assert.equal(caseId, 'PB011-001', 'Unsupported numbering closure case')
  assert(caseRecord && Array.isArray(caseRecord.checks), 'caseRecord.checks is required')
  const settings = dependencies.config || config
  assert(isWmsWriteEnabled(dependencies.env || process.env), 'BLOCKED: CFOR_E2E_WRITE_FIXTURES=true is required')
  assertLocalWmsWriteTarget(settings)
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083'],
    [settings.apiUrl || `${settings.apiBase}/admin-api`, '48083']]) {
    const url = new URL(base)
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === port &&
      url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash,
    'BLOCKED: Only credential-free local HTTP endpoints are allowed')
  }
  assertLocalDatabase(settings.db)
  for (const method of ['getBusiness', 'postBusiness', 'putBusiness']) {
    assert.equal(typeof api?.[method], 'function', `Missing authenticated API ${method}`)
  }
  const read = dependencies.runReadOnlySql || runReadOnlySql
  const clock = dependencies.now || Date.now
  const seed = (dependencies.randomUUID || randomUUID)().replaceAll('-', '').toUpperCase()
  assert.match(seed, /^[A-F0-9]{32}$/, 'Invalid private fixture UUID')
  const marker = `E2E-PB011-${seed.slice(0, 16)}`
  const code = `E2EPB011${seed}`
  const prefixes = [`PB011A${seed.slice(0, 16)}`, `PB011B${seed.slice(0, 16)}`]
  const started = clock()
  const bucket = dateBucket(started)
  const billDate = `${bucket.slice(0, 4)}-${bucket.slice(4, 6)}-${bucket.slice(6)}`
  const report = {
    caseId, marker, ruleCode: code, prefixes, dateBucket: bucket, billDate,
    executed: false, attempts: [], rules: [], numbers: [], bills: [], resources: [],
    inventory: [], retention: { policy: 'read-only-audit-retention', completed: false },
    notCovered: ['UI/display', 'arbitrary business-date numbering', 'second-tenant numbering isolation']
  }
  caseRecord.numberingClosure = report
  const query = async (stage, sql) => {
    const result = await read(sql)
    caseRecord.database = [...(caseRecord.database || []), { stage: `pb011:${stage}`, sql, ...result }]
    assert.equal(result?.available, true, `BLOCKED: Database evidence unavailable (${stage})`)
    assert(Array.isArray(result.rows), `Invalid SQL evidence (${stage})`)
    return result.rows
  }
  const objects = async (stage, sql) => jsonRows(await query(stage, sql))
  const call = async (method, path, body) => {
    if (method !== 'getBusiness') report.attempts.push({ method, path, body })
    const payload = await api[method](path, body)
    assertBusinessSuccess(payload, path)
    rejectUnsafeIds(payload)
    if (method !== 'getBusiness' && /\/(create|add)$/.test(path) && typeof payload.data === 'number') {
      assert(Number.isSafeInteger(payload.data), `${path}: unsafe numeric ID`)
    }
    return payload
  }
  const guardedApi = Object.fromEntries(['getBusiness', 'postBusiness', 'putBusiness'].map((method) =>
    [method, (path, body) => call(method, path, body)]))
  const ruleSql = `SELECT ${projection(RULE_COLUMNS)} FROM mes_sys_fill_rule
    WHERE rule_code=${sqlText(code)} ORDER BY version_no,id`
  const readRules = async (stage) => {
    const db = (await objects(`${stage}:rules`, ruleSql)).map(ruleView)
    const listed = rowsOf(await call('getBusiness',
      `/mes/fillRule/list?pageNo=1&pageSize=100&ruleCode=${code}`), 'PB011 rule list').map(ruleView)
    assert.equal(listed.length, db.length, 'Rule list/SQL count mismatch')
    for (const row of db) {
      assert.equal(row.tenantId, '1', 'Rule belongs to another tenant or template')
      assert.equal(row.ruleCode, code, 'Rule code ownership mismatch')
      assert.equal(listed.filter((item) => item.id === row.id).length, 1, 'Ambiguous rule list identity')
      same(listed.find((item) => item.id === row.id), row)
      const detail = ruleView(dataOf(await call('getBusiness', `/mes/fillRule/queryById?id=${row.id}`)))
      same(detail, row)
    }
    return db
  }
  const refsSql = () => Object.entries(REF_DEFINITIONS).map(([kind, def]) => {
    const columns = { id: 'id', tenantId: 'tenant_id', code: def.code, mark: def.mark,
      deleted: 'CAST(deleted AS UNSIGNED)', ...def.parent }
    return `SELECT '${kind}',${projection(columns)} FROM ${def.table}
      WHERE tenant_id=1 AND ${def.code}=${sqlText(fixtureCode(marker, def.kind, 1))}`
  }).join(';\n')
  const readRefs = async (stage) => {
    const rows = await query(stage, refsSql())
    const resources = rows.map((row) => {
      assert(Array.isArray(row) && row.length === 2, 'Invalid master SQL evidence')
      const [kind, json] = row
      const parsed = JSON.parse(json)
      assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid master SQL object')
      rejectUnsafeIds(parsed)
      return { kind, ...parsed }
    })
    for (const row of resources) {
      const def = REF_DEFINITIONS[row.kind]
      assert(def, 'Unexpected resource kind')
      row.id = idOf(row.id, row.kind)
      assert.equal(text(row.tenantId), '1', 'Resource tenant mismatch')
      assert.equal(text(row.deleted), '0', 'Audit resource was deleted')
      assert.equal(row.code, fixtureCode(marker, def.kind, 1), 'Resource code mismatch')
      assert.equal(row.mark, row.kind === 'warehouse' ? `${WMS_FIXTURE_MARK} ${marker}` : WMS_FIXTURE_MARK,
        'Resource marker mismatch')
      assert.equal(resources.filter((other) => other.kind === row.kind).length, 1, 'Ambiguous private resource')
      if (def.parent?.warehouseId) {
        assert.equal(idOf(row.warehouseId, 'Master warehouse parent'), resources.find((item) => item.kind === 'warehouse')?.id)
      }
      if (def.parent?.areaId) {
        assert.equal(idOf(row.areaId, 'Master area parent'), resources.find((item) => item.kind === 'area')?.id)
      }
      if (row.kind === 'material') {
        assert.equal(idOf(row.unitId, 'Master unit'), unitId)
        assert.equal(row.inventoryNature, 'STOCK')
      }
    }
    for (const fixture of (caseRecord.fixtures || []).filter((row) => row.token === marker)) {
      assert(resources.some((row) => row.kind === fixture.kind && row.id === fixture.id), 'Known audit resource disappeared')
    }
    return resources
  }
  let material, warehouse, unitId, baseline, v1, v2
  const inventorySnapshot = async (stage) => {
    const where = `tenant_id=1 AND material_id=${sqlText(material.id)}`
    const rows = await query(stage, `
      SELECT 'inventory-count',COUNT(*) FROM mes_stk_inventory WHERE ${where};
      SELECT 'inventory-row',${projection(INVENTORY_COLUMNS)} FROM mes_stk_inventory WHERE ${where} ORDER BY id;
      SELECT 'outlook-count',COUNT(*) FROM mes_stk_inventory_out_look WHERE ${where};
      SELECT 'outlook-row',${projection(OUTLOOK_COLUMNS)} FROM mes_stk_inventory_out_look WHERE ${where} ORDER BY id`)
    assert(rows.every((row) => Array.isArray(row) && row.length === 2), 'Invalid stock SQL evidence')
    const snapshot = {}
    for (const kind of ['inventory', 'outlook']) {
      const counts = rows.filter((row) => row[0] === `${kind}-count`)
      const values = rows.filter((row) => row[0] === `${kind}-row`).map((row) => JSON.parse(row[1]))
      assert.equal(counts.length, 1, `Missing ${kind} count sentinel`)
      assert.match(text(counts[0][1]), /^\d+$/, `Invalid ${kind} count`)
      assert.equal(Number(counts[0][1]), values.length, `Incomplete ${kind} rows`)
      for (const row of values) {
        assert(row && typeof row === 'object' && !Array.isArray(row), `Invalid ${kind} object`)
        rejectUnsafeIds(row)
        assert.equal(text(row.tenantId), '1')
        assert.equal(text(row.materialId), material.id)
        idOf(row.id, `${kind} ID`)
      }
      snapshot[kind] = { count: Number(counts[0][1]), rows: values }
    }
    assert(rows.every((row) => /^(inventory|outlook)-(count|row)$/.test(row[0])), 'Unexpected stock snapshot row')
    report.inventory.push({ stage, ...snapshot })
    if (baseline) same(snapshot, baseline)
    return snapshot
  }
  const sequenceRows = async (stage) => objects(stage, `
    SELECT ${projection({ k: 'k', v: 'v', tenantId: 'tenant_id' })} FROM mes_bas_sequence
    WHERE k LIKE '${prefixes[0]}-%' OR k LIKE '${prefixes[1]}-%' ORDER BY k`)
  const readSequence = async (number, stage) => {
    const rows = await sequenceRows(stage)
    const row = rows.find((item) => item.k === number.key)
    assert(row && rows.filter((item) => item.k === number.key).length === 1, 'Missing/ambiguous exact sequence key')
    assert.equal(text(row.tenantId), '1', 'Sequence tenant mismatch')
    assert.equal(Number(row.v), number.sequence, 'Persisted sequence differs from allocated number')
    return rows
  }
  const allocate = async (prefix) => {
    assert.equal(dateBucket(clock()), bucket, 'BLOCKED: Date bucket crossed midnight; do not reset sequences')
    const number = dataOf(await call('putBusiness', `/mes/fillRule/executeRuleByCode/${code}`, {}))
    assert.equal(typeof number, 'string', 'Numbering API did not return a number string')
    const match = new RegExp(`^${prefix}-(\\d{8})-(\\d{5})$`).exec(number)
    assert(match, 'Numbering format/published version mismatch')
    assert.equal(match[1], bucket, 'Server number date differs from the current fixture date bucket')
    assert.equal(dateBucket(clock()), bucket, 'BLOCKED: Number allocation crossed midnight')
    const result = { billNo: number, prefix, bucket: match[1], sequence: Number(match[2]),
      key: `${prefix}-${match[1]}-RESET-${match[1]}-TENANT-1` }
    report.numbers.push(result)
    await readSequence(result, `allocated:${report.numbers.length}`)
    return result
  }
  const assertBill = (row, bill, voided, db = false) => {
    assert.equal(idOf(row?.id, 'WMS bill'), bill.id)
    if (db) assert.equal(text(row.tenantId), '1')
    else if (row.tenantId != null) assert.equal(text(row.tenantId), '1')
    for (const key of ['billNo', 'subject', 'remark', 'stockIoType']) assert.equal(row[key], bill.body[key])
    assert.equal(row.billDate, bill.body.billDate, 'Historical bill date changed')
    assert.equal(text(row.billStage), voided ? '0' : '12', 'Formal WMS state mismatch')
    for (const key of ['isAuto', 'isEffective', 'isClosed']) assert.equal(text(row[key]), '0', `${key}: not a pure draft/void`)
    assert.equal(text(row.isVoided), voided ? '1' : '0', 'Formal void flag mismatch')
    for (const key of ['srcBillType', 'srcBillId', 'effectiveTime', 'processInstanceId', 'bpmiInstanceId']) {
      assert(empty(row[key]), `${key}: draft has source/execution side effects`)
    }
    if (db) assert.equal(text(row.deleted), '0')
  }
  const assertEntry = (row, bill, db = false) => {
    idOf(row?.id, 'WMS entry')
    if (db || row.tenantId != null) assert.equal(text(row.tenantId), '1')
    assert.equal(text(row.mid), bill.id)
    assert.equal(row.billNo, bill.body.billNo, 'Historical entry number changed')
    const expected = bill.body.stkIoEntryList[0]
    for (const key of ['entryNo', 'materialId', 'unitId', 'warehouseId', 'wareAreaId', 'wareLocationId',
      'batchNo', 'stockIoType', 'stockIoDirection', 'isQc']) assert.equal(text(row[key]), text(expected[key]), key)
    for (const key of ['qty', 'cost']) assert.equal(Number(row[key]), expected[key], key)
    assert(empty(row.inStockTime), 'Draft entry was executed')
    assert(row.executedQty == null || Number(row.executedQty) === 0, 'Draft has executed quantity')
    for (const key of ['srcBillType', 'srcBillId']) assert(empty(row[key]), 'Draft entry has a source')
    if (db) assert.equal(text(row.deleted), '0')
  }
  const readBill = async (bill, voided, stage) => {
    const main = dataOf(await call('getBusiness', `/mes/stkIo/queryById?id=${bill.id}`))
    const entries = rowsOf(await call('getBusiness', `/mes/stkIo/queryEntryByMainId?id=${bill.id}`), 'PB011 WMS entries')
    const dbMain = await objects(`${stage}:main`, `SELECT ${projection(BILL_COLUMNS)} FROM mes_stk_io
      WHERE tenant_id=1 AND bill_no=${sqlText(bill.body.billNo)}`)
    const dbEntries = await objects(`${stage}:entries`, `SELECT ${projection(ENTRY_COLUMNS)} FROM mes_stk_io_entry
      WHERE tenant_id=1 AND mid=${sqlText(bill.id)} ORDER BY entry_no,id`)
    assert.equal(dbMain.length, 1, 'WMS bill must be uniquely persisted')
    assert.equal(entries.length, 1, 'WMS entries must not be empty or ambiguous')
    assert.equal(dbEntries.length, 1, 'Persisted WMS entries must not be empty or ambiguous')
    assertBill(main, bill, voided)
    assertBill(dbMain[0], bill, voided, true)
    assertEntry(entries[0], bill)
    assertEntry(dbEntries[0], bill, true)
    assert.equal(idOf(entries[0].id, 'API entry'), dbEntries[0].id)
    if (bill.entryId) assert.equal(dbEntries[0].id, bill.entryId, 'Historical entry identity changed')
    bill.entryId = dbEntries[0].id
    bill.state = voided ? 'VOIDED' : 'DRAFT'
    bill.readbacks = [...(bill.readbacks || []), { stage, main, entries, dbMain, dbEntries }]
    return bill
  }
  const saveDraft = async (number, label) => {
    const body = {
      billNo: number.billNo, billDate, subject: `${marker} draft ${label}`, remark: marker,
      stockIoType: '199', isAuto: 0,
      stkIoEntryList: [{
        entryNo: 1, materialId: material.id, unitId, qty: 1, cost: 1, settleQty: 1,
        warehouseId: warehouse.warehouse.id, wareAreaId: warehouse.area.id,
        wareLocationId: warehouse.location.id, batchNo: `${marker}-BATCH`,
        stockIoType: '199', stockIoDirection: '1', isQc: 0
      }],
      stkIoDistributionList: [], stkIoBomList: []
    }
    const bill = { id: null, label, body, state: 'SAVE_ATTEMPTED' }
    report.bills.push(bill)
    await call('postBusiness', '/mes/stkIo/add/save', body)
    const listed = rowsOf(await call('getBusiness',
      `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(number.billNo)}`), 'PB011 WMS list')
    assert.equal(listed.length, 1, 'Saved draft must have a unique formal list row')
    assert.equal(listed[0].billNo, number.billNo, 'WMS list filter/number mismatch')
    bill.id = idOf(listed[0].id, 'Saved draft')
    await readBill(bill, false, `saved:${label}`)
    await inventorySnapshot(`saved:${label}:stock`)
    return bill
  }

  let failure
  try {
    await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
    const permission = dataOf(await call('getBusiness', '/system/auth/get-permission-info'))
    const userId = idOf(permission?.user?.id, 'Current authenticated user')
    const identity = await query('identity', `SELECT CAST(u.id AS CHAR),CAST(u.tenant_id AS CHAR),t.name
      FROM system_users u JOIN system_tenant t ON t.id=u.tenant_id
      WHERE u.id=${userId} AND u.tenant_id=1 AND u.deleted=0 AND u.status=0 AND t.deleted=0 AND t.status=0`)
    same(identity, [[userId, '1', settings.tenantName]])
    const collisions = await query('collision-preflight', `
      SELECT 'rule',COUNT(*) FROM mes_sys_fill_rule WHERE rule_code=${sqlText(code)};
      SELECT 'prefix-rule',COUNT(*) FROM mes_sys_fill_rule
        WHERE rule_params LIKE '%${prefixes[0]}%' OR rule_params LIKE '%${prefixes[1]}%';
      SELECT 'sequence',COUNT(*) FROM mes_bas_sequence WHERE k LIKE '${prefixes[0]}-%' OR k LIKE '${prefixes[1]}-%';
      SELECT 'bill',COUNT(*) FROM mes_stk_io WHERE remark=${sqlText(marker)};
      ${Object.entries(REF_DEFINITIONS).map(([kind, def]) => `SELECT '${kind}',COUNT(*) FROM ${def.table}
        WHERE ${def.code}=${sqlText(fixtureCode(marker, def.kind, 1))}`).join(';\n')}`)
    same([...collisions].sort(), ['rule', 'prefix-rule', 'sequence', 'bill', ...Object.keys(REF_DEFINITIONS)]
      .map((kind) => [kind, '0']).sort())
    // Parse every required column before creating masters; missing migrations fail without writes.
    await query('schema-preflight', [
      [RULE_COLUMNS, 'mes_sys_fill_rule'], [BILL_COLUMNS, 'mes_stk_io'], [ENTRY_COLUMNS, 'mes_stk_io_entry'],
      [INVENTORY_COLUMNS, 'mes_stk_inventory'], [OUTLOOK_COLUMNS, 'mes_stk_inventory_out_look']
    ].map(([columns, table]) => `SELECT ${projection(columns)} FROM ${table} WHERE 1=0`).join(';\n'))
    const units = rowsOf(await call('getBusiness', '/mes/basUnit/list/enabled'), 'Enabled units')
    assert(units.length > 0, 'BLOCKED: Missing enabled unit')
    unitId = idOf(units[0].id, 'Unit')
    warehouse = await createWarehouseFixture(guardedApi, caseRecord, marker)
    material = await createMaterialFixture(guardedApi, caseRecord, marker, unitId)
    material.id = idOf(material.id, 'Material')
    report.resources = await readRefs('owned-masters')
    assert.equal(report.resources.length, 4, 'Missing private master ownership evidence')
    for (const [kind, id] of [['material', material.id], ['warehouse', warehouse.warehouse.id],
      ['area', warehouse.area.id], ['location', warehouse.location.id]]) {
      assert.equal(report.resources.find((row) => row.kind === kind)?.id, id, 'Master API/SQL identity mismatch')
    }
    const materialOwner = report.resources.find((row) => row.kind === 'material')
    assert.equal(materialOwner.unitId, unitId)
    assert.equal(materialOwner.inventoryNature, 'STOCK')
    baseline = await inventorySnapshot('baseline')
    assert.equal(baseline.inventory.count, 0, 'BLOCKED: Fresh dedicated material unexpectedly has inventory')

    const effective1 = Math.floor(started / 1000) * 1000 - 120000
    await call('postBusiness', '/mes/fillRule/add', {
      ruleCode: code, ruleName: `${marker} v1`, ruleClass: RULE_CLASS,
      ruleParams: JSON.stringify(paramsFor(prefixes[0])), effectiveFrom: effective1
    })
    let rules = await readRules('created-v1')
    assert.equal(rules.length, 1, 'Expected unique private v1')
    same({ ...rules[0], id: 'server-id' }, {
      id: 'server-id', tenantId: '1', ruleCode: code, ruleName: `${marker} v1`, ruleClass: RULE_CLASS,
      versionNo: 1, status: 'DRAFT', ruleParams: paramsFor(prefixes[0]), effectiveFrom: effective1, publishedTime: null
    })
    const draft1 = rules[0]
    await call('putBusiness', `/mes/fillRule/publish/${draft1.id}`)
    rules = await readRules('published-v1')
    assert.equal(rules.length, 1)
    v1 = rules[0]
    same({ ...v1, status: draft1.status, publishedTime: draft1.publishedTime }, draft1)
    assert.equal(v1.status, 'PUBLISHED')
    assert(Number.isFinite(v1.publishedTime) && v1.effectiveFrom <= clock(), 'V1 is not published/effective')
    report.rules.push(v1)
    const first = await allocate(prefixes[0])
    assert.equal(first.sequence, 1, 'Fresh private prefix must start at 00001')
    const a = await saveDraft(first, 'A')
    check(caseRecord, initNumberingClosureChecks.draft, true, `id=${a.id}; entry=${a.entryId}; stage=12`)
    // Recheck ownership/state and stock immediately before the only WMS state transition.
    await readBill(a, false, 'before-void')
    await inventorySnapshot('before-void:stock')
    await readSequence(first, 'before-void:sequence')
    await call('putBusiness', '/mes/stkIo/void', { id: a.id })
    await readBill(a, true, 'voided-A')
    await inventorySnapshot('voided-A:stock')
    await readSequence(first, 'voided-A:sequence')
    check(caseRecord, initNumberingClosureChecks.void, true, `id=${a.id}; stage=0; isVoided=1; billNo=${first.billNo}`)
    const second = await allocate(prefixes[0])
    check(caseRecord, initNumberingClosureChecks.sequence,
      second.key === first.key && second.bucket === first.bucket && second.sequence === first.sequence + 1,
      `voided=${first.billNo}; next=${second.billNo}; key=${first.key}`)
    const b = await saveDraft(second, 'B')

    const effective2 = effective1 + 60000
    await call('putBusiness', '/mes/fillRule/edit', {
      id: v1.id, ruleName: `${marker} v2`, ruleParams: JSON.stringify(paramsFor(prefixes[1])), effectiveFrom: effective2
    })
    rules = await readRules('edited-v2')
    assert.equal(rules.length, 2, 'Published edit must create exactly one new draft')
    same(rules.find((row) => row.id === v1.id), v1)
    v2 = rules.find((row) => row.id !== v1.id)
    same({ ...v2, id: 'server-id' }, {
      id: 'server-id', tenantId: '1', ruleCode: code, ruleName: `${marker} v2`, ruleClass: RULE_CLASS,
      versionNo: 2, status: 'DRAFT', ruleParams: paramsFor(prefixes[1]), effectiveFrom: effective2, publishedTime: null
    })
    check(caseRecord, initNumberingClosureChecks.version, true, `v1=${v1.id}; v2=${v2.id}`)
    const draft2 = v2
    await call('putBusiness', `/mes/fillRule/publish/${v2.id}`)
    rules = await readRules('published-v2')
    assert.equal(rules.length, 2)
    same(rules.find((row) => row.id === v1.id), v1)
    v2 = rules.find((row) => row.id === v2.id)
    same({ ...v2, status: draft2.status, publishedTime: draft2.publishedTime }, draft2)
    assert.equal(v2.status, 'PUBLISHED')
    assert(Number.isFinite(v2.publishedTime) && v2.effectiveFrom > v1.effectiveFrom &&
      v2.effectiveFrom <= clock(), 'V2 is not published/effective')
    report.rules.push(v2)
    const third = await allocate(prefixes[1])
    assert.equal(third.sequence, 1, 'New private prefix must start in its own sequence bucket')
    await readBill(a, true, 'history-A')
    await readBill(b, false, 'history-B')
    await readSequence(second, 'history:v1-sequence')
    check(caseRecord, initNumberingClosureChecks.history, true,
      `activeV2=${third.billNo}; historical=${first.billNo}/${second.billNo}`)
    await inventorySnapshot('history:stock')
    check(caseRecord, initNumberingClosureChecks.inventory, true,
      `material=${material.id}; snapshots=${report.inventory.length}; inventoryCount=0; outlookCount=${baseline.outlook.count}`)
  } catch (error) {
    failure = error
  } finally {
    if (report.attempts.length > 0) {
      const errors = []
      const retained = { policy: 'read-only-audit-retention', completed: false, deleted: false, errors: [] }
      // Discover even committed-but-unacknowledged creates by exact private codes/numbers.
      for (const [stage, audit] of [
        ['rules', async () => {
          retained.rules = await objects('retention:rules', ruleSql)
          for (const row of retained.rules) {
            const view = ruleView(row)
            assert.equal(view.tenantId, '1')
            assert.equal(view.ruleCode, code)
            const known = report.rules.find((item) => item.id === view.id)
            if (known) same(view, known)
          }
          for (const known of report.rules) assert(retained.rules.some((row) => row.id === known.id), 'Known rule disappeared')
        }],
        ['resources', async () => { retained.resources = await readRefs('retention:resources') }],
        ['bills', async () => {
          const expectedNumbers = report.bills.map((bill) => sqlText(bill.body.billNo))
          const where = `tenant_id=1 AND (remark=${sqlText(marker)}${expectedNumbers.length
            ? ` OR bill_no IN (${expectedNumbers.join(',')})` : ''})`
          retained.bills = await objects('retention:bills', `SELECT ${projection(BILL_COLUMNS)}
            FROM mes_stk_io WHERE ${where} ORDER BY id`)
          retained.entries = []
          for (const row of retained.bills) {
            idOf(row.id, 'Retained bill')
            assert.equal(row.remark, marker, 'Retained bill ownership mismatch')
            assert.equal(text(row.tenantId), '1')
            assert.equal(text(row.deleted), '0', 'Audit bill was deleted')
            const known = report.bills.find((bill) => bill.body.billNo === row.billNo)
            assert(known && (!known.id || known.id === row.id), 'Retained bill number/identity mismatch')
            const entries = await objects('retention:entries', `SELECT ${projection(ENTRY_COLUMNS)}
              FROM mes_stk_io_entry WHERE tenant_id=1 AND mid=${sqlText(row.id)} ORDER BY entry_no,id`)
            assert.equal(entries.length, 1, 'Audit bill is missing its unique persisted entry')
            for (const entry of entries) {
              idOf(entry.id, 'Retained entry')
              assert.equal(text(entry.tenantId), '1')
              assert.equal(text(entry.deleted), '0', 'Audit entry was deleted')
              assert.equal(entry.mid, row.id)
              assert.equal(entry.billNo, known.body.billNo, 'Audit entry number changed')
            }
            if (known.entryId) assert(entries.some((entry) => entry.id === known.entryId), 'Known entry disappeared')
            retained.entries.push(...entries)
          }
          for (const known of report.bills.filter((bill) => bill.id)) {
            assert(retained.bills.some((row) => row.id === known.id), 'Known bill disappeared')
          }
        }],
        ['sequences', async () => {
          retained.sequences = await sequenceRows('retention:sequences')
          for (const row of retained.sequences) {
            assert.equal(text(row.tenantId), '1', 'Retained sequence tenant mismatch')
            assert(Number.isSafeInteger(Number(row.v)) && Number(row.v) > 0, 'Invalid retained sequence')
          }
          for (const number of report.numbers) {
            const last = report.numbers.filter((item) => item.key === number.key).at(-1)
            assert(retained.sequences.some((row) => row.k === last.key && Number(row.v) === last.sequence),
              'Known sequence deleted, reset or unexpectedly consumed')
          }
        }],
        ['inventory', async () => {
          if (baseline) retained.inventory = await inventorySnapshot('retention:stock')
        }]
      ]) {
        try { await audit() } catch (error) {
          errors.push(error)
          retained.errors.push({ stage, message: error.message })
        }
      }
      retained.completed = errors.length === 0
      retained.draftIds = (retained.bills || []).filter((row) => text(row.billStage) === '12').map((row) => row.id)
      report.retention = retained
      caseRecord.fixtures = [...(caseRecord.fixtures || []), {
        kind: 'init-numbering-closure-audit', marker, ruleCode: code, tenantId: '1',
        retention: retained, status: retained.completed ? 'RETAINED_FOR_AUDIT' : 'AUDIT_INCOMPLETE'
      }]
      if (errors.length) {
        caseRecord.checks.push({
          name: initNumberingClosureChecks.retention, passed: false, details: JSON.stringify(retained.errors)
        })
        failure = new AggregateError([...(failure ? [failure] : []), ...errors],
          'PB011 closure/audit failed; retained resources require inspection; never delete/reset sequence')
      } else {
        check(caseRecord, initNumberingClosureChecks.retention, true,
          `rules=${retained.rules.length}; bills=${retained.bills.length}; sequences=${retained.sequences.length}; no cleanup writes`)
      }
    }
  }
  if (failure) {
    failure.numberingEvidence = report
    throw failure
  }
  report.executed = true
  caseRecord.evidence = [...(caseRecord.evidence || []),
    `PB011 API/data closure: ${report.numbers.map((row) => row.billNo).join(' -> ')}; audit retained; UI/date/dual-tenant coverage unchanged`]
  return report
}
