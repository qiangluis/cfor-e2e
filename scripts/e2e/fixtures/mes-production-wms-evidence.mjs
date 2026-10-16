import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

const prefix = 'MES-PROD-004 WMS evidence'
const taskPath = '/wms/operation/task'
const quantityFields = ['qty', 'availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty']
const snake = (value) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex')
const id = (value) => {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), `${prefix}: lossy ID`)
  assert.match(String(value), /^[1-9]\d*$/, `${prefix}: invalid ID`)
  return String(value)
}
const decimal = (value) => {
  assert.ok(value !== null && value !== undefined, `${prefix}: missing quantity`)
  assert.match(String(value), /^\d+(?:\.\d+)?$/, `${prefix}: invalid quantity`)
  const [whole, fraction = ''] = String(value).split('.')
  const tail = fraction.replace(/0+$/, '')
  return `${BigInt(whole)}${tail ? `.${tail}` : ''}`
}
const eqId = (actual, expected) => assert.equal(id(actual), id(expected), `${prefix}: identity mismatch`)
const eqQty = (actual, expected) => assert.equal(decimal(actual), decimal(expected), `${prefix}: quantity mismatch`)
const assertInventorySum = (row) => {
  const values = quantityFields.map((key) => decimal(row[key]))
  const scale = Math.max(...values.map((value) => value.split('.')[1]?.length || 0))
  const scaled = values.map((value) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(`${whole}${fraction.padEnd(scale, '0')}`)
  })
  assert.equal(scaled[0], scaled.slice(1).reduce((total, value) => total + value, 0n),
    `${prefix}: six inventory components do not reconcile`)
}
const flag = (actual, expected) => {
  assert.ok(actual !== null && actual !== undefined, `${prefix}: missing state flag`)
  assert.equal(String(typeof actual === 'boolean' ? Number(actual) : actual), String(expected))
}
const data = (response, label) => {
  assertBusinessSuccess(response, `${prefix}: ${label}`)
  const result = response.data ?? response.result
  assert.ok(result !== null && result !== undefined, `${prefix}: ${label} empty data`)
  return result
}
const list = (response, label) => {
  const result = data(response, label)
  const rows = Array.isArray(result) ? result : result.list ?? result.records
  assert.ok(Array.isArray(rows) && rows.length > 0, `${prefix}: ${label} empty/malformed rows`)
  if (!Array.isArray(result) && result.total != null) eqQty(result.total, rows.length)
  return rows
}
const unique = (rows, label) => {
  assert.equal(new Set(rows.map((row) => id(row.id))).size, rows.length, `${prefix}: duplicate ${label}`)
}
const get = async (api, path) => data(await api.getBusiness(path), path)
const byId = (path, value) => `${path}?id=${encodeURIComponent(id(value))}`
const check = (record, name, passed, details, { catalogName = false } = {}) => {
  record.checks ||= []
  record.checks.push({
    name: catalogName ? name : `${prefix}: ${name}`,
    passed,
    details: JSON.stringify(details)
  })
}
const gap = (evidence, code, details) => evidence.gaps.push({ code, details })

const ownedScope = (fixture) => {
  assert.equal(fixture?.caseId, 'MES-PROD-004', `${prefix}: wrong fixture case`)
  assert.match(fixture.marker || '', /^AUTOTEST-MES-PROD-004-[A-Z0-9]{6}-[A-F0-9]{6}$/)
  assert.equal(fixture.fixtureRecord?.caseId, fixture.caseId, `${prefix}: registry case mismatch`)
  assert.equal(fixture.fixtureRecord?.marker, fixture.marker, `${prefix}: registry nonce mismatch`)
  assert.equal(fixture.fixtureRecord?.resources, fixture.owned, `${prefix}: private ownership registry required`)
  const owned = (kind, value) => {
    const found = fixture.owned.filter((row) => row.kind === kind && id(row.id) === id(value))
    assert.equal(found.length, 1, `${prefix}: missing/duplicate owned ${kind}`)
    assert.equal(found[0].marker, fixture.marker, `${prefix}: foreign marker`)
    assert.ok(!found[0].cleaned && !found[0].retained, `${prefix}: fixture already cleaned/retained`)
    return found[0]
  }
  for (const key of ['works', 'tasks', 'reportIds', 'outputIds']) assert.equal(fixture[key]?.length, 1)
  const output = owned('output', fixture.outputIds[0])
  const inventory = fixture.owned.filter((row) => row.kind === 'inventory' && row.sourceOutputId === output.id)
  assert.equal(inventory.length, 1, `${prefix}: output inventory ownership must be unique`)
  const scope = {
    marker: fixture.marker, output: id(output.id), inventory: id(owned('inventory', inventory[0].id).id),
    order: id(owned('order', fixture.order.id).id), work: id(owned('work', fixture.works[0].id).id),
    report: id(owned('report', fixture.reportIds[0]).id), prodTask: id(owned('task', fixture.tasks[0].id).id),
    warehouse: id(owned('warehouse', fixture.warehouse.id).id),
    area: id(owned('area', fixture.area.id).id), location: id(owned('location', fixture.location.id).id),
    material: id(owned('material', fixture.material.id).id), route: id(owned('route', fixture.route.id).id),
    batch: `${fixture.marker}-B1`, billNo: output.identity
  }
  eqId(output.sourceReportId, scope.report)
  eqId(output.sourceWorkId, scope.work)
  assert.equal(output.stockIoType, '104')
  assert.ok(typeof scope.billNo === 'string' && scope.billNo.trim())
  for (const row of [output, inventory[0]]) {
    for (const [key, value] of Object.entries({
      warehouseId: scope.warehouse, wareAreaId: scope.area, wareLocationId: scope.location, materialId: scope.material
    })) eqId(row.dimensions?.[key], value)
    assert.equal(row.dimensions.batchNo, scope.batch)
  }
  return scope
}

const assertDimensions = (row, scope) => {
  for (const [key, value] of Object.entries({
    warehouseId: scope.warehouse, materialId: scope.material,
    wareAreaId: scope.area, wareLocationId: scope.location
  })) eqId(row[key], value)
  assert.equal(row.batchNo, scope.batch)
  if (row.tenantId != null) eqId(row.tenantId, '1')
}

const assertTask = (task, scope, quantity, withLines = true, expectation = {}) => {
  id(task.id)
  assert.ok(typeof task.taskNo === 'string' && task.taskNo.trim(), `${prefix}: missing task number`)
  assert.equal(task.sourceBillType, 'MesStkIo')
  eqId(task.sourceBillId, scope.output)
  assert.equal(task.sourceBillNo, scope.billNo)
  eqId(task.warehouseId, scope.warehouse)
  eqId(task.areaId, scope.area)
  assert.ok(['RECEIVE', 'PUTAWAY'].includes(task.taskType), `${prefix}: unexpected task type`)
  const receive = task.taskType === 'RECEIVE'
  const expectedStatus = receive ? 'COMPLETED' : (expectation.putawayStatus || 'PENDING')
  const expectedActualQuantity = receive ? quantity : (expectation.putawayActualQuantity ?? 0)
  assert.equal(task.status, expectedStatus)
  eqQty(task.plannedQuantity, quantity)
  eqQty(task.actualQuantity, expectedActualQuantity)
  if (receive) {
    assert.ok(task.startedTime && task.completedTime, `${prefix}: RECEIVE terminal timestamps required`)
  } else if (expectedStatus === 'PENDING') {
    assert.ok(task.startedTime == null && task.completedTime == null, `${prefix}: PENDING task was executed`)
  } else if (expectedStatus === 'IN_PROGRESS') {
    assert.ok(task.startedTime && task.completedTime == null, `${prefix}: IN_PROGRESS task timestamps invalid`)
  } else if (expectedStatus === 'COMPLETED') {
    assert.ok(task.startedTime && task.completedTime, `${prefix}: completed PUTAWAY timestamps required`)
  }
  if (!withLines) return
  assert.equal(task.lines?.length, 1, `${prefix}: task detail must contain one real line`)
  const line = task.lines[0]
  id(line.id)
  eqQty(line.lineNo, scope.entryNo)
  eqId(line.materialId, scope.material)
  // The current formal 104 creation passes the report ID, not the persisted 104 entry ID.
  eqId(line.sourceLineId, scope.report)
  assert.equal(line.batchNo, scope.batch)
  eqId(line.sourceLocationId, scope.location)
  eqId(line.targetLocationId, scope.location)
  eqId(line.targetAreaId, scope.area)
  eqQty(line.plannedQuantity, quantity)
  eqQty(line.actualQuantity, expectedActualQuantity)
  eqQty(line.reservedQuantity, expectation.putawayReservedQuantity ?? 0)
  if (line.reservationId != null) id(line.reservationId)
}

const readApiFacts = async (api, scope, quantity, expectation = {}) => {
  const work = await get(api, byId('/mes/prodWork/queryById', scope.work))
  eqId(work.id, scope.work)
  eqId(work.prodOrderId, scope.order)
  assert.equal(work.remark, scope.marker)
  assert.equal(work.batchNo, scope.batch)
  const prodTask = await get(api, byId('/mes/prodWorkTask/queryById', scope.prodTask))
  eqId(prodTask.id, scope.prodTask)
  eqId(prodTask.workTicketId, scope.work)
  eqId(prodTask.productId, scope.material)
  eqId(prodTask.routing, scope.route)
  const report = await get(api, byId('/mes/prodWorkReport/queryById', scope.report))
  eqId(report.id, scope.report)
  eqId(report.workTicketId, scope.work)
  eqId(report.workTaskId, scope.prodTask)
  assert.equal(report.remark, scope.marker)
  eqQty(report.qualifiedNum, quantity)
  const output = await get(api, byId('/mes/stkIo/queryById', scope.output))
  eqId(output.id, scope.output)
  assert.equal(String(output.stockIoType), '104')
  assert.equal(output.srcBillType, 'ProdWork')
  eqId(output.srcBillId, scope.work)
  assert.equal(output.billNo, scope.billNo)
  flag(output.isEffective, 1)
  flag(output.isVoided, 0)
  const entries = list(await api.getBusiness(byId('/mes/stkIo/queryEntryByMainId', scope.output)), '104 entries')
  assert.equal(entries.length, 1)
  const entry = entries[0]
  id(entry.id)
  if (scope.entryId) eqId(entry.id, scope.entryId)
  else scope.entryId = id(entry.id)
  eqId(entry.mid, scope.output)
  assert.equal(entry.srcBillType, 'ProdWork')
  eqId(entry.srcBillId, scope.work)
  eqId(entry.srcEntryId, scope.report)
  assertDimensions(entry, scope)
  eqQty(entry.qty, quantity)
  if (scope.entryNo) eqQty(entry.entryNo, scope.entryNo)
  else scope.entryNo = decimal(entry.entryNo)
  assert.ok(BigInt(scope.entryNo) > 0n, `${prefix}: entry number must be a positive integer`)
  const inventoryPage = list(await api.getBusiness(
    `/mes/stkInventory/list?pageNo=1&pageSize=100&warehouseId=${scope.warehouse}&materialId=${scope.material}&batchNo=${encodeURIComponent(scope.batch)}`
  ), 'inventory page')
  assert.equal(inventoryPage.length, 1, `${prefix}: inventory must not be empty or ambiguous`)
  eqId(inventoryPage[0].id, scope.inventory)
  const inventory = await get(api, byId('/mes/stkInventory/queryById', scope.inventory))
  for (const row of [inventoryPage[0], inventory]) {
    eqId(row.id, scope.inventory)
    assertDimensions(row, scope)
    flag(row.isClosed, 0)
    for (const key of quantityFields) decimal(row[key])
    eqQty(row.qty, quantity)
    assertInventorySum(row)
  }
  for (const key of quantityFields) eqQty(inventoryPage[0][key], inventory[key])
  const taskPage = list(await api.getBusiness(
    `${taskPath}/page?pageNo=1&pageSize=100&sourceBillType=MesStkIo&sourceBillId=${scope.output}&warehouseId=${scope.warehouse}`
  ), 'task page')
  assert.equal(taskPage.length, 2, `${prefix}: exactly RECEIVE and PUTAWAY required`)
  unique(taskPage, 'tasks')
  assert.equal(new Set(taskPage.map((row) => row.taskType)).size, 2)
  const tasks = []
  for (const row of taskPage) {
    assertTask(row, scope, quantity, false, expectation)
    const detail = await get(api, byId(`${taskPath}/get`, row.id))
    eqId(detail.id, row.id)
    assertTask(detail, scope, quantity, true, expectation)
    const identities = scope.taskIdentities ||= {}
    if (identities[detail.taskType]) {
      eqId(detail.id, identities[detail.taskType].id)
      eqId(detail.lines[0].id, identities[detail.taskType].lineId)
      assert.equal(detail.taskNo, identities[detail.taskType].taskNo)
    } else {
      identities[detail.taskType] = { id: id(detail.id), lineId: id(detail.lines[0].id), taskNo: detail.taskNo }
    }
    for (const key of ['taskNo', 'taskType', 'status', 'sourceBillType', 'sourceBillId', 'sourceBillNo',
      'warehouseId', 'areaId', 'startedTime', 'completedTime', 'plannedQuantity', 'actualQuantity']) {
      assert.equal(canonical(detail[key] ?? null), canonical(row[key] ?? null), `${prefix}: page/get ${key} drift`)
    }
    tasks.push(detail)
  }
  assert.equal(new Set(tasks.map((row) => id(row.lines[0].id))).size, 2)
  return { work, prodTask, report, output, entries, inventoryPage, inventory, taskPage, tasks }
}

const tableRequirements = {
  mes_stk_io: ['stock_io_type', 'src_bill_type', 'src_bill_id', 'is_effective', 'is_voided', 'bill_no'],
  mes_stk_io_entry: ['mid', 'src_entry_id', 'material_id', 'batch_no', 'entry_no', 'qty'],
  mes_stk_inventory: ['warehouse_id', 'material_id', 'batch_no', 'ware_area_id', 'ware_location_id',
    'is_closed', ...quantityFields.map(snake)],
  wms_task: ['source_bill_type', 'source_bill_id', 'source_bill_no', 'warehouse_id', 'area_id',
    'idempotency_key', 'status', 'task_type'],
  wms_task_line: ['task_id', 'source_line_id', 'material_id', 'batch_no', 'line_no',
    'source_location_id', 'target_location_id', 'target_area_id', 'planned_quantity', 'actual_quantity'],
  wms_putaway_reservation: ['task_id', 'task_line_id', 'idempotency_key', 'status', 'reserved_qty'],
  wms_task_log: ['task_id']
}
const tables = Object.keys(tableRequirements)
const requiredSql = async (readSql, sql) => {
  const result = await readSql(sql)
  assert.equal(result?.available, true, `${prefix}: READ ONLY evidence unavailable`)
  assert.ok(Array.isArray(result.rows), `${prefix}: missing SQL result`)
  return result.rows
}

const readSqlFacts = async (readSql, scope, facts, reservationKey) => {
  const ownership = await requiredSql(readSql, `
    /* mes-production-wms-evidence:ownership */
    SELECT CAST(wh.id AS CHAR), CAST(m.id AS CHAR), CAST(a.id AS CHAR), CAST(l.id AS CHAR),
      CAST(w.id AS CHAR), CAST(r.id AS CHAR)
    FROM mes_wms_ware_house wh
    JOIN mes_bas_material m ON m.id=${quote(scope.material)} AND m.tenant_id=1 AND m.deleted=0
    JOIN mes_wms_house_area a ON a.id=${quote(scope.area)} AND a.house_id=wh.id AND a.tenant_id=1 AND a.deleted=0
    JOIN mes_wms_house_location l ON l.id=${quote(scope.location)} AND l.house_id=wh.id
      AND l.area_id=a.id AND l.tenant_id=1 AND l.deleted=0
    JOIN mes_prod_work w ON w.id=${quote(scope.work)} AND w.tenant_id=1 AND w.deleted=0
    JOIN mes_prod_work_report r ON r.id=${quote(scope.report)} AND r.work_ticket_id=w.id AND r.tenant_id=1 AND r.deleted=0
    WHERE wh.tenant_id=1 AND wh.deleted=0 AND wh.id=${quote(scope.warehouse)} AND wh.mark=${quote(scope.marker)}
      AND m.remark=${quote(scope.marker)} AND a.remark=${quote(scope.marker)} AND l.remark=${quote(scope.marker)}
      AND w.remark=${quote(scope.marker)} AND r.remark=${quote(scope.marker)}
      AND w.prod_order_id=${quote(scope.order)} AND r.work_task_id=${quote(scope.prodTask)}
  `)
  assert.equal(ownership.length, 1, `${prefix}: SQL ownership must be unique and nonempty`)
  assert.deepEqual(ownership[0], [scope.warehouse, scope.material, scope.area, scope.location, scope.work, scope.report])
  const schema = await requiredSql(readSql, `
    /* mes-production-wms-evidence:schema */
    SELECT 'schema-count', table_name, COUNT(*) FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (${tables.map(quote).join(',')})
    GROUP BY table_name ORDER BY table_name;
    SELECT 'column', table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (${tables.map(quote).join(',')})
    ORDER BY table_name, ordinal_position
  `)
  const columns = {}
  for (const table of tables) {
    const census = schema.filter((row) => row[0] === 'schema-count' && row[1] === table)
    assert.equal(census.length, 1, `${prefix}: missing schema census ${table}`)
    columns[table] = schema.filter((row) => row[0] === 'column' && row[1] === table)
      .map(([, , name, type]) => {
        assert.match(name, /^[a-z][a-z0-9_]*$/, `${prefix}: unsafe column`)
        assert.match(type, /^[a-z]+$/, `${prefix}: unsafe type`)
        return { name, type }
      })
    eqQty(columns[table].length, census[0][2])
    assert.equal(new Set(columns[table].map((row) => row.name)).size, columns[table].length)
    for (const name of ['id', 'tenant_id', 'deleted', ...tableRequirements[table]]) {
      assert.ok(columns[table].some((row) => row.name === name), `${prefix}: incomplete ${table}.${name}`)
    }
  }
  const taskIds = facts.tasks.map((row) => quote(id(row.id))).join(',')
  const scopes = {
    mes_stk_io: `id=${quote(scope.output)}`,
    mes_stk_io_entry: `mid=${quote(scope.output)}`,
    mes_stk_inventory: `warehouse_id=${quote(scope.warehouse)} AND material_id=${quote(scope.material)} AND batch_no=${quote(scope.batch)}`,
    wms_task: `source_bill_type='MesStkIo' AND source_bill_id=${quote(scope.output)}`,
    wms_task_line: `task_id IN (${taskIds})`,
    wms_putaway_reservation: `(task_id IN (${taskIds}) OR idempotency_key=${quote(reservationKey)})`,
    wms_task_log: `task_id IN (${taskIds})`
  }
  // Count and hash every persisted field, including soft-deleted rows and audit columns.
  const sql = tables.map((table) => {
    const fields = columns[table].map(({ name, type }) => {
      const column = `\`${name}\``
      const expression = type === 'bit' ? `CAST(CAST(${column} AS UNSIGNED) AS CHAR)`
        : /^(binary|varbinary|blob|tinyblob|mediumblob|longblob)$/.test(type) ? `HEX(${column})`
          : `CAST(${column} AS CHAR)`
      return `${quote(name)}, ${expression}`
    }).join(', ')
    const where = `tenant_id=1 AND ${scopes[table]}`
    return `SELECT 'count', '${table}', COUNT(*) FROM ${table} WHERE ${where};
      SELECT 'row', '${table}', CAST(id AS CHAR), CAST(JSON_OBJECT(${fields}) AS CHAR)
      FROM ${table} WHERE ${where} ORDER BY id`
  }).join(';')
  const result = await requiredSql(readSql, `/* mes-production-wms-evidence:facts */ ${sql}`)
  const snapshot = {}
  for (const table of tables) {
    const census = result.filter((row) => row[0] === 'count' && row[1] === table)
    assert.equal(census.length, 1, `${prefix}: missing row census ${table}`)
    const rows = result.filter((row) => row[0] === 'row' && row[1] === table).map(([, , key, json]) => {
      const fields = JSON.parse(json)
      assert.deepEqual(Object.keys(fields).sort(), columns[table].map((row) => row.name).sort(),
        `${prefix}: incomplete full row ${table}`)
      eqId(fields.id, key)
      eqId(fields.tenant_id, '1')
      flag(fields.deleted, 0)
      return { id: id(key), fields, hash: hash(fields) }
    })
    unique(rows, table)
    eqQty(rows.length, census[0][2])
    snapshot[table] = { columns: columns[table], count: rows.length, rows, hash: hash(rows) }
  }
  for (const [table, values] of Object.entries({
    mes_stk_io: [facts.output], mes_stk_io_entry: facts.entries, mes_stk_inventory: [facts.inventory],
    wms_task: facts.tasks, wms_task_line: facts.tasks.map((row) => row.lines[0])
  })) {
    assert.deepEqual(snapshot[table].rows.map((row) => row.id).sort(), values.map((row) => id(row.id)).sort(),
      `${prefix}: API/SQL row set mismatch ${table}`)
  }
  const sqlMatch = (table, apiRow, keys) => {
    const fields = snapshot[table].rows.find((row) => row.id === id(apiRow.id)).fields
    for (const key of keys) {
      const actual = fields[snake(key)]
      if (quantityFields.includes(key) || ['qty', 'plannedQuantity', 'actualQuantity', 'entryNo', 'lineNo'].includes(key)) {
        eqQty(actual, apiRow[key])
      } else if (['isEffective', 'isVoided', 'isClosed'].includes(key)) {
        flag(actual, Number(apiRow[key]))
      } else assert.equal(actual, apiRow[key] == null ? null : String(apiRow[key]), `${prefix}: SQL/API ${key} mismatch`)
    }
    return fields
  }
  sqlMatch('mes_stk_io', facts.output, ['stockIoType', 'srcBillType', 'srcBillId', 'billNo', 'isEffective', 'isVoided'])
  sqlMatch('mes_stk_io_entry', facts.entries[0], ['mid', 'srcBillType', 'srcBillId', 'srcEntryId', 'entryNo',
    'warehouseId', 'wareAreaId', 'wareLocationId', 'materialId', 'batchNo', 'qty'])
  sqlMatch('mes_stk_inventory', facts.inventory, ['warehouseId', 'wareAreaId', 'wareLocationId',
    'materialId', 'batchNo', 'isClosed', ...quantityFields])
  for (const row of [facts.inventoryPage[0], facts.inventory]) {
    if (Object.hasOwn(row, 'qualityStatus')) sqlMatch('mes_stk_inventory', row, ['qualityStatus'])
  }
  for (const task of facts.tasks) {
    const fields = sqlMatch('wms_task', task, ['taskNo', 'taskType', 'status', 'sourceBillType',
      'sourceBillId', 'sourceBillNo', 'warehouseId', 'areaId'])
    assert.equal(fields.idempotency_key, `MES-PROD-STK-IN:${scope.output}:${scope.entryNo}:${task.taskType}`)
    const line = task.lines[0]
    const persisted = sqlMatch('wms_task_line', line, ['lineNo', 'sourceLineId', 'materialId', 'batchNo',
      'sourceLocationId', 'targetLocationId', 'targetAreaId', 'plannedQuantity', 'actualQuantity'])
    eqId(persisted.task_id, task.id)
  }
  assert.ok(snapshot.wms_task_log.count > 0, `${prefix}: missing formal task audit`)
  for (const row of snapshot.wms_putaway_reservation.rows) {
    const task = facts.tasks.find((item) => id(item.id) === id(row.fields.task_id))
    assert.ok(task, `${prefix}: foreign reservation key collision`)
    eqId(row.fields.task_line_id, task.lines[0].id)
  }
  for (const row of snapshot.wms_task_log.rows) {
    assert.ok(facts.tasks.some((task) => id(task.id) === id(row.fields.task_id)), `${prefix}: foreign task audit`)
  }
  return snapshot
}

const takeSnapshot = async (api, readSql, scope, quantity, reservationKey, expectation = {}) => {
  const apiFacts = await readApiFacts(api, scope, quantity, expectation)
  const sqlFacts = await readSqlFacts(readSql, scope, apiFacts, reservationKey)
  return { api: apiFacts, readOnly: sqlFacts, hashes: { api: hash(apiFacts), readOnly: hash(sqlFacts) } }
}

const readLocation = async (api, scope) => {
  const location = await get(api, byId('/mes/wms-house-location/get', scope.location))
  eqId(location.id, scope.location)
  eqId(location.houseId, scope.warehouse)
  eqId(location.areaId, scope.area)
  assert.equal(location.remark, scope.marker)
  assert.equal(typeof location.isEnabled, 'boolean', `${prefix}: missing enabled location state`)
  assert.ok(location.locationCode && location.locationName, `${prefix}: incomplete location readback`)
  return location
}

const permissionRoute = (menus) => {
  const matches = []
  const walk = (nodes, parent = '') => {
    for (const node of nodes || []) {
      if (typeof node.path !== 'string' || /[?#\\]|^(?:[\w+-]+:|\/\/)/.test(node.path)) continue
      if (node.path.split('/').some((part) => ['.', '..'].includes(part))) continue
      const path = (node.path.startsWith('/') ? node.path : `${parent}/${node.path}`).replace(/\/+/g, '/')
      if (String(node.component || '').replace(/^\/|\.vue$/g, '') === 'wms/stock/workbench') matches.push(path)
      walk(node.children, path)
    }
  }
  walk(menus)
  if (matches.length === 0) return null
  assert.deepEqual(matches, ['/wireSideWarehouse/stock'], `${prefix}: formal permission menu missing/ambiguous`)
  return matches[0]
}

const verifyPage = async ({
  page, scope, tasks, route, outputDir, record, deps, settings, expectation = {}
}) => {
  assert.ok(page && outputDir, `${prefix}: current page and screenshot directory required`)
  const context = page.context()
  await deps.openRoute(page, route, { readySelector: '[data-testid="wms-task-drilldown"]' })
  const root = page.locator('[data-testid="wms-task-drilldown"]')
  const warehouseName = `${scope.marker}-\u4ed3\u5e93`
  const warehouseSelector = page.getByRole('combobox', { name: '\u4ed3\u5e93\u7b5b\u9009', exact: true })
  await warehouseSelector.waitFor({ state: 'visible' })
  assert.equal(await warehouseSelector.count(), 1, `${prefix}: formal warehouse selector must be unique`)
  await warehouseSelector.fill(warehouseName)
  const warehouseOption = page.getByRole('option', { name: warehouseName, exact: true })
  await warehouseOption.waitFor({ state: 'visible' })
  assert.equal(await warehouseOption.count(), 1, `${prefix}: owned warehouse option must be unique`)
  const readResponse = async (response) => {
    const request = response.request()
    assert.equal(request.frame().page(), page, `${prefix}: response is not from the supplied page`)
    const headers = request.headers()
    assert.equal(headers['tenant-id'], '1', `${prefix}: browser tenant mismatch`)
    assert.match(headers.authorization || '', /^Bearer \S+$/, `${prefix}: browser authentication missing`)
    const url = new URL(response.url())
    assert.ok([new URL(settings.apiBase).origin, new URL(settings.webBase).origin].includes(url.origin),
      `${prefix}: browser response origin is outside the local Web/API pair`)
    assert.equal(url.searchParams.get('pageNo'), '1')
    assert.equal(url.searchParams.get('pageSize'), '100')
    assert.ok(!url.searchParams.get('status') && !url.searchParams.get('taskType'))
    assert.ok(response.ok(), `${prefix}: browser HTTP failure`)
    const text = await response.text()
    const body = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
      ? decryptResponse(text) : JSON.parse(text)
    const rows = list(body, 'browser task page')
    unique(rows, 'browser tasks')
    assert.equal(rows.length, 2, `${prefix}: private warehouse task page must contain exactly two tasks`)
    for (const expected of tasks) {
      const row = rows.find((item) => id(item.id) === id(expected.id))
      assert.ok(row, `${prefix}: browser missing owned task`)
      assertTask(row, scope, expected.plannedQuantity, false, expectation)
      assert.equal(row.taskNo, expected.taskNo)
    }
    return { pathname: url.pathname, warehouseId: scope.warehouse, rows, hash: hash(rows) }
  }
  const captureRequest = async (action) => {
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' && url.pathname === '/admin-api/wms/operation/task/page' &&
        url.searchParams.get('warehouseId') === scope.warehouse
    })
    const [response] = await Promise.all([responsePromise, action()])
    return readResponse(response)
  }
  const rendered = async () => {
    await page.waitForFunction((expected) => {
      const nodes = [...document.querySelectorAll('[data-testid="wms-task-drilldown"] .task-drilldown-item')]
      return expected.every((task) => nodes.filter((node) =>
        node.querySelector('.task-drilldown-main em')?.textContent.trim() === task.taskNo).length === 1)
    }, tasks.map((task) => ({ taskNo: task.taskNo })))
    const rows = []
    for (const task of tasks) {
      const card = root.locator('.task-drilldown-item').filter({ has: page.getByText(task.taskNo, { exact: true }) })
      assert.equal(await card.count(), 1, `${prefix}: rendered task must be unique`)
      assert.equal((await card.locator('.task-drilldown-main em').innerText()).trim(), task.taskNo)
      assert.equal((await card.locator('.task-drilldown-main small').innerText()).trim(), scope.billNo)
      assert.equal((await card.locator('.task-drilldown-main strong').innerText()).trim(),
        task.taskType === 'RECEIVE' ? '\u6536\u8d27' : '\u4e0a\u67b6')
      assert.equal((await card.locator('.task-drilldown-meta b').innerText()).trim(),
        task.status === 'COMPLETED' ? '\u5df2\u5b8c\u6210' : '\u5f85\u6267\u884c')
      const text = (await card.locator('.task-drilldown-meta em').innerText()).trim()
      const quantities = text.split('/').map((value) => value.trim().replaceAll(',', ''))
      assert.equal(quantities.length, 2)
      eqQty(quantities[0], task.actualQuantity)
      eqQty(quantities[1], task.plannedQuantity)
      rows.push({ id: id(task.id), taskNo: task.taskNo, sourceBillNo: scope.billNo, quantities: text })
    }
    return rows
  }
  const first = await captureRequest(() => warehouseOption.click())
  await rendered()
  await root.scrollIntoViewIfNeeded()
  const initialScreenshot = await deps.saveScreenshot(page, outputDir, 'mes-prod-004-wms-tasks-owned', record)
  const refreshed = await captureRequest(() => root.getByRole('button', { name: '\u5237\u65b0\u4efb\u52a1', exact: true }).click())
  const refreshedRows = await rendered()
  await root.scrollIntoViewIfNeeded()
  const refreshScreenshot = await deps.saveScreenshot(page, outputDir, 'mes-prod-004-wms-tasks-refreshed', record)
  assert.equal(first.hash, refreshed.hash, `${prefix}: browser refresh fact drift`)
  assert.equal(page.context(), context, `${prefix}: browser context changed`)
  assert.ok(initialScreenshot && refreshScreenshot, `${prefix}: missing screenshot evidence`)
  const viewport = page.viewportSize()
  assert.ok(viewport, `${prefix}: explicit browser viewport required`)
  const responsive = []
  try {
    for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size)
      await warehouseSelector.scrollIntoViewIfNeeded()
      const bounds = await warehouseSelector.boundingBox()
      assert.ok(bounds && bounds.width > 0 && bounds.height > 0 &&
        bounds.x >= 0 && bounds.y >= 0 &&
        bounds.x + bounds.width <= size.width && bounds.y + bounds.height <= size.height,
      `${prefix}: warehouse selector clipped at ${size.width}x${size.height}`)
      const canvas = page.locator('.warehouse-twin-scene canvas')
      assert.equal(await canvas.count(), 1, `${prefix}: unique real scene canvas required`)
      const canvasBounds = await canvas.boundingBox()
      assert.ok(canvasBounds && canvasBounds.width > 0 && canvasBounds.height > 0,
        `${prefix}: scene canvas has no visible dimensions`)
      const sceneScreenshot = await deps.saveScreenshot(page, outputDir,
        `mes-prod-004-wms-scene-${size.width}x${size.height}`, record)
      assert.ok(sceneScreenshot, `${prefix}: scene screenshot required`)
      await root.scrollIntoViewIfNeeded()
      await rendered()
      const screenshot = await deps.saveScreenshot(page, outputDir,
        `mes-prod-004-wms-tasks-${size.width}x${size.height}`, record)
      assert.ok(screenshot, `${prefix}: responsive screenshot required`)
      responsive.push({ ...size, selectorBounds: bounds, canvasBounds, sceneScreenshot, screenshot })
    }
  } finally {
    await page.setViewportSize(viewport)
  }
  return { route, selection: { method: 'formal searchable warehouse selector', warehouseId: scope.warehouse,
    warehouseName }, initial: first, refreshed, rendered: refreshedRows, responsive,
  screenshots: [initialScreenshot, refreshScreenshot,
    ...responsive.flatMap((item) => [item.sceneScreenshot, item.screenshot])] }
}

/**
 * Call before ExecutionWorkflowFixture.cleanup, using its existing API and logged-in page.
 * This evidence never satisfies the original upper-WMS assertion or executes a task.
 * Dependencies are injectable for offline behavior tests; production uses the existing guards.
 */
export async function collectMesProductionWmsEvidence ({
  fixture, page, context = page?.context(), caseRecord, outputDir, record = fixture?.record, quantity = 2
}, dependencies = {}) {
  const deps = { settings: config, environment: process.env, assertLocalWriteSafety, runReadOnlySql,
    openRoute, saveScreenshot, ...dependencies }
  const settings = deps.settings
  assert.equal(settings.target, 'local', `${prefix}: local only`)
  assert.equal(id(settings.tenantId), '1', `${prefix}: tenant1 only`)
  assert.equal(deps.environment.CFOR_E2E_WRITE_FIXTURES, 'true', `${prefix}: write flag required even for rejection probes`)
  assert.equal(settings.db.host, '127.0.0.1')
  assert.equal(String(settings.db.port), '3306')
  assert.equal(settings.db.name, 'cfor_admin_standard')
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.port, port)
  }
  const scope = ownedScope(fixture)
  assert.ok(caseRecord.executionFixtures?.includes(fixture.fixtureRecord), `${prefix}: fixture not registered in this case`)
  if (page) assert.equal(page.context(), context, `${prefix}: foreign browser context`)
  const evidence = {
    caseId: 'MES-PROD-004', marker: scope.marker, sourceId: scope.output,
    originalAssertion: 'WMS\u6536\u8d27/\u4e0a\u67b6\u72b6\u6001\u6b63\u786e',
    status: 'PARTIAL', partial: true, passCandidate: false, gaps: [], negatives: []
  }
  caseRecord.mesProductionWmsEvidence = evidence
  await deps.assertLocalWriteSafety(caseRecord)
  const reservationKey = `${scope.marker}:WMS-EVIDENCE:${scope.output}`
  const snapshot = (expectation = {}) =>
    takeSnapshot(fixture.api, deps.runReadOnlySql, scope, quantity, reservationKey, expectation)
  evidence.initial = await snapshot()
  const inventory = evidence.initial.api.inventory
  const receive = evidence.initial.api.tasks.find((row) => row.taskType === 'RECEIVE')
  const putaway = evidence.initial.api.tasks.find((row) => row.taskType === 'PUTAWAY')
  evidence.sourceConflict = {
    code: '104_RECEIVE_COMPLETED_PUTAWAY_PENDING_WITHOUT_PENDING_STOCK',
    observed: decimal(inventory.pendingPutawayQty) === '0',
    source: { type: '104', id: scope.output, billNo: scope.billNo, entryId: id(evidence.initial.api.entries[0].id),
      workId: scope.work, reportId: scope.report, taskSourceLineId: id(putaway.lines[0].sourceLineId) },
    taskStates: { receive: { id: id(receive.id), status: receive.status },
      putaway: { id: id(putaway.id), status: putaway.status } },
    inventory: { id: scope.inventory, ...Object.fromEntries(quantityFields.map((key) => [key, inventory[key]])) },
    qualityStatus: {
      apiExposed: Object.hasOwn(inventory, 'qualityStatus'),
      ...(Object.hasOwn(inventory, 'qualityStatus') ? { apiValue: inventory.qualityStatus } : {}),
      readOnlyValue: evidence.initial.readOnly.mes_stk_inventory.rows[0].fields.quality_status
    },
    requiredFact: 'Formal PUTAWAY requires actual pendingPutawayQty; available/hold balances are not putaway evidence.',
    decisionRequired: '104 automatic placement versus receipt followed by manual putaway; no product state/stock change attempted.'
  }
  const positiveClosureEnabled = deps.environment.CFOR_E2E_WMS_PUTAWAY_CLOSURE !== 'false'
  if (!positiveClosureEnabled) {
    gap(evidence, 'PUTAWAY_TERMINAL_NOT_VERIFIED', 'Positive WMS closure is disabled for this contract-only run.')
    gap(evidence, 'PUTAWAY_SUCCESS_IDEMPOTENCY_AND_STOCK_TRANSFER_NOT_VERIFIED',
      'Successful reserve/confirm and pending-to-available movement are not exercised.')
  }
  if (evidence.sourceConflict.observed) gap(evidence, '104_PENDING_STOCK_SOURCE_CONFLICT', evidence.sourceConflict.requiredFact)
  check(caseRecord, 'owned 104/source/entry, RECEIVE terminal and equal-quantity PENDING PUTAWAY', true,
    { sourceId: scope.output, receiveId: receive.id, putawayId: putaway.id, hashes: evidence.initial.hashes })

  let permission
  try {
    permission = await get(fixture.api, '/system/auth/get-permission-info')
  } catch (error) {
    evidence.permissionFailure = String(error.message)
    check(caseRecord, 'formal permission API readback', false, { error: evidence.permissionFailure })
    throw error
  }
  const permissions = permission.permissions
  const permitted = (permissionName) => Array.isArray(permissions) &&
    permissions.some((value) => ['*:*:*', permissionName].includes(value))
  let route
  try {
    route = permissionRoute(permission.menus)
  } catch (error) {
    evidence.menuFailure = String(error.message)
    check(caseRecord, 'formal permission menu identity', false, { error: evidence.menuFailure })
    throw error
  }
  if (!route) gap(evidence, 'FORMAL_TASK_PAGE_MENU_MISSING', 'No formal WMS workbench in current permission menus; page verification not executed.')
  if (!permitted('wms:operation-task:query')) {
    gap(evidence, 'FORMAL_TASK_PAGE_QUERY_PERMISSION_MISSING', 'Current formal query permission is not proven; page verification not executed.')
  }
  if (page && outputDir && route && permitted('wms:operation-task:query')) {
    evidence.browserAttempted = true
    try {
      evidence.browser = await verifyPage({ page, scope, tasks: evidence.initial.api.tasks,
        route, outputDir, record, deps, settings })
      check(caseRecord, 'same-context formal task drilldown and refresh', true, evidence.browser)
    } catch (error) {
      evidence.browserFailure = String(error.message)
      check(caseRecord, 'same-context formal task drilldown and refresh', false,
        { route, error: evidence.browserFailure, executed: true })
      throw error
    }
  } else if (!page || !outputDir) {
    gap(evidence, 'FORMAL_TASK_PAGE_NOT_VERIFIED', 'Supply the existing logged-in page and screenshot directory; no replacement context is created.')
  }

  try {
    evidence.location = await readLocation(fixture.api, scope)
  } catch (error) {
    evidence.locationFailure = String(error.message)
    check(caseRecord, 'owned location API identity readback', false, { error: evidence.locationFailure })
    throw error
  }
  if (!evidence.location.isEnabled) {
    gap(evidence, 'NEGATIVE_OWNED_LOCATION_DISABLED', 'Formal owned location was read successfully but is disabled; no probe executed.')
  }
  const mayExecute = permitted('wms:operation-task:execute')
  if (!mayExecute) gap(evidence, 'NEGATIVE_EXECUTE_PERMISSION_UNPROVEN', 'No role or authorization changes are permitted.')
  if (!evidence.location.isEnabled || !mayExecute) return evidence

  for (const [name, path, contract, body] of [
    ['PENDING_RESERVE_REJECTED', `${taskPath}/putaway/reserve`,
      { code: 500, message: '\u53ea\u6709\u6267\u884c\u4e2d\u7684\u4e0a\u67b6\u4efb\u52a1\u53ef\u4ee5\u9884\u7559\u76ee\u6807\u5e93\u4f4d', allowServiceCode: true },
      { taskId: id(putaway.id), lineId: id(putaway.lines[0].id), sourceInventoryId: scope.inventory,
        targetAreaId: scope.area, targetLocationId: scope.location, quantity, idempotencyKey: reservationKey }],
    ['NO_RESERVATION_CONFIRM_REJECTED', `${taskPath}/putaway/confirm`,
      { code: 500, message: '\u5f53\u524d\u4e0a\u67b6\u660e\u7ec6\u6ca1\u6709\u6709\u6548\u9884\u7559\uff0c\u8bf7\u5148\u9884\u7559\u76ee\u6807\u5e93\u4f4d', allowServiceCode: true },
      { taskId: id(putaway.id), lineId: id(putaway.lines[0].id), locationId: scope.location,
        materialId: scope.material, batchNo: scope.batch, serialNo: putaway.lines[0].serialNo, quantity }]
  ]) {
    const before = await snapshot()
    const currentLine = before.api.tasks.find((row) => row.taskType === 'PUTAWAY').lines[0]
    const reservations = before.readOnly.wms_putaway_reservation
    // CONSUMED reservations short-circuit confirm; an existing key short-circuits reserve.
    if (reservations.count !== 0 || currentLine.reservationId != null || currentLine.reservationStatus != null) {
      gap(evidence, `${name}_PRECONDITION_NOT_MET`, 'Reservation absence is not proven; no request sent.')
      continue
    }
    eqQty(currentLine.reservedQuantity, 0)
    let currentLocation
    try {
      currentLocation = await readLocation(fixture.api, scope)
    } catch (error) {
      evidence.locationFailure = String(error.message)
      check(caseRecord, `${name}: owned location API identity readback`, false, { error: evidence.locationFailure })
      throw error
    }
    if (!currentLocation.isEnabled) {
      gap(evidence, `${name}_LOCATION_DISABLED`, 'Formal owned location was disabled after initial readback; no probe executed.')
      continue
    }
    const probe = { name, path, request: body, contract, before }
    evidence.negatives.push(probe)
    let requestError
    try {
      probe.response = await fixture.api.post(path, body, { expectedBusinessRejection: contract })
    } catch (error) {
      requestError = error
      probe.requestError = String(error.message)
    } finally {
      try {
        probe.after = await snapshot()
      } catch (error) {
        probe.afterError = String(error.message)
        check(caseRecord, `${name}: after-request full fact readback`, false, { path, error: probe.afterError })
        throw error
      }
      probe.unchanged = canonical(probe.before.hashes) === canonical(probe.after.hashes)
    }
    probe.matched = !requestError && matchesExpectedBusinessRejection(probe.response, contract)
    check(caseRecord, `${name}: exact refusal and full API/SQL hashes unchanged`,
      probe.matched && probe.unchanged, { path, response: probe.response,
        before: probe.before.hashes, after: probe.after.hashes, requestError: probe.requestError })
    assert.ok(probe.unchanged, `${prefix}: rejected request changed task/line/inventory/reservation/audit facts`)
    if (requestError) throw requestError
    assert.ok(probe.matched, `${prefix}: unexpected refusal/success; cannot count as the intended negative`)
  }

  if (!positiveClosureEnabled) return evidence

  const positive = {
    start: { path: `${taskPath}/start`, request: { id: id(putaway.id), remark: `${scope.marker} start putaway` } },
    reserve: {
      path: `${taskPath}/putaway/reserve`,
      request: {
        taskId: id(putaway.id), lineId: id(putaway.lines[0].id), sourceInventoryId: scope.inventory,
        targetAreaId: scope.area, targetLocationId: scope.location, quantity,
        idempotencyKey: reservationKey, remark: `${scope.marker} reserve putaway`
      }
    },
    confirm: {
      path: `${taskPath}/putaway/confirm`,
      request: {
        taskId: id(putaway.id), lineId: id(putaway.lines[0].id),
        locationId: scope.location, materialId: scope.material, batchNo: scope.batch,
        serialNo: putaway.lines[0].serialNo, quantity, remark: `${scope.marker} confirm putaway`
      }
    },
    complete: {
      path: `${taskPath}/complete`,
      request: { id: id(putaway.id), actualQuantity: quantity, remark: `${scope.marker} complete putaway` }
    }
  }
  const positiveCall = async (step) => {
    const response = await fixture.api.post(step.path, step.request)
    return data(response, step.path)
  }

  const started = await positiveCall(positive.start)
  const startedSnapshot = await snapshot({ putawayStatus: 'IN_PROGRESS', putawayActualQuantity: 0 })
  check(caseRecord, '待上架任务正式开始并保留开始审计', started === true &&
    startedSnapshot.api.tasks.some((task) => task.taskType === 'PUTAWAY' && task.status === 'IN_PROGRESS'),
  { response: started, tasks: startedSnapshot.api.tasks.map((task) => ({
    id: task.id, taskType: task.taskType, status: task.status,
    startedTime: task.startedTime, completedTime: task.completedTime
  })) })

  const reservation = await positiveCall(positive.reserve)
  const reservationId = id(reservation.reservationId)
  assert.equal(reservation.status, 'ACTIVE')
  eqId(reservation.taskId, putaway.id)
  eqId(reservation.lineId, putaway.lines[0].id)
  eqId(reservation.sourceInventoryId, scope.inventory)
  eqId(reservation.targetAreaId, scope.area)
  eqId(reservation.targetLocationId, scope.location)
  eqQty(reservation.reservedQuantity, quantity)
  const duplicateReservation = await positiveCall(positive.reserve)
  eqId(duplicateReservation.reservationId, reservationId)
  assert.equal(duplicateReservation.status, 'ACTIVE')
  check(caseRecord, '上架预留重复提交幂等且不创建第二条预留', true, {
    reservationId, duplicateReservationId: duplicateReservation.reservationId,
    idempotencyKey: reservation.idempotencyKey
  })

  positive.confirm.request.reservationId = reservationId
  const confirmed = await positiveCall(positive.confirm)
  assert.equal(confirmed, true)
  const duplicateConfirmed = await positiveCall(positive.confirm)
  assert.equal(duplicateConfirmed, true)
  check(caseRecord, '上架确认重复提交幂等且只迁移一次库存', true, {
    reservationId, first: confirmed, duplicate: duplicateConfirmed
  })

  const completed = await positiveCall(positive.complete)
  assert.equal(completed, true)
  const final = await snapshot({ putawayStatus: 'COMPLETED', putawayActualQuantity: quantity })
  const finalInventory = final.api.inventory
  const finalPutaway = final.api.tasks.find((task) => task.taskType === 'PUTAWAY')
  const finalReservation = final.readOnly.wms_putaway_reservation.rows.find((row) =>
    id(row.fields.id) === reservationId)
  assert.ok(finalReservation, `${prefix}: final reservation audit missing`)
  assert.equal(finalReservation.fields.status, 'CONSUMED')
  eqQty(finalInventory.pendingPutawayQty, 0)
  eqQty(finalInventory.availableQty, quantity)
  assert.ok(final.readOnly.wms_task_log.count >= evidence.initial.readOnly.wms_task_log.count + 4,
    `${prefix}: start/reserve/confirm/complete audit logs missing`)
  evidence.positiveClosure = {
    start: { request: positive.start.request, response: started },
    reserve: { request: positive.reserve.request, response: reservation,
      duplicateResponse: duplicateReservation },
    confirm: { request: positive.confirm.request, response: confirmed,
      duplicateResponse: duplicateConfirmed },
    complete: { request: positive.complete.request, response: completed },
    startedSnapshot: startedSnapshot.hashes,
    finalSnapshot: final.hashes,
    reservationId,
    final: {
      putawayStatus: finalPutaway.status,
      putawayActualQuantity: finalPutaway.actualQuantity,
      inventory: Object.fromEntries(quantityFields.map((key) => [key, finalInventory[key]])),
      reservationStatus: finalReservation.fields.status,
      taskLogCountBefore: evidence.initial.readOnly.wms_task_log.count,
      taskLogCountAfter: final.readOnly.wms_task_log.count
    }
  }
  evidence.gaps = evidence.gaps.filter((item) =>
    !['PUTAWAY_TERMINAL_NOT_VERIFIED', 'PUTAWAY_SUCCESS_IDEMPOTENCY_AND_STOCK_TRANSFER_NOT_VERIFIED']
      .includes(item.code))
  check(caseRecord, 'WMS 收货后正式开始/预留/确认/完成并迁移库存', true,
    evidence.positiveClosure, { catalogName: true })

  if (page && outputDir && route && permitted('wms:operation-task:query')) {
    evidence.browserAfterClosure = await verifyPage({
      page, scope, tasks: final.api.tasks, route, outputDir, record, deps, settings,
      expectation: { putawayStatus: 'COMPLETED', putawayActualQuantity: quantity }
    })
    check(caseRecord, '同一浏览器上下文回读已完成上架任务', true, evidence.browserAfterClosure)
  }

  return evidence
}
