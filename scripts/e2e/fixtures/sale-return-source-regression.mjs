import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SALE_RETURN_SOURCE_CASE = Object.freeze({
  id: 'SALE-RETURN-SOURCE-001',
  suite: 'sale-return-source-regression',
  title: '正式 ErpSaleOut/201 来源映射、SalReturn/302 扣减及同批多次出库'
})
export const SOURCE_SCENARIO = Object.freeze({ opening: 8, shipments: Object.freeze([2, 3]), returned: 1 })
const componentFields = ['qty', 'availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty']
const same = (left, right) => left != null && right != null && String(left) === String(right)
const now = () => new Date().toISOString().slice(0, 19)

export function sourceId (value) {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), 'Missing or lossy source ID')
  assert.match(String(value), /^[1-9]\d*$/, 'Invalid source ID')
  return String(value)
}

function quantity (value) {
  assert.ok((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '',
    'Missing quantity')
  assert.ok(Number.isFinite(Number(value)) && Number(value) >= 0, 'Invalid quantity')
  return Number(value)
}

const sqlId = (value) => `'${sourceId(value)}'`
const dimensions = (row, expected) => {
  for (const key of ['materialId', 'unitId', 'warehouseId', 'wareAreaId', 'wareLocationId']) {
    assert.equal(sourceId(row[key]), sourceId(expected[key]), `Wrong ${key}`)
  }
  assert.equal(row.batchNo, expected.batchNo, 'Wrong original shipment batch')
}

export function sourceMarker (suffix = randomBytes(5).toString('hex').toUpperCase()) {
  assert.match(suffix, /^[A-Z0-9]{10}$/)
  // The existing 106 helper appends "-OPENING-BATCH"; the complete batch must fit 32 characters.
  return `E2E-SR-${suffix}`
}

export function buildSourceOrder (expected) {
  const { marker } = expected
  const count = SOURCE_SCENARIO.shipments.reduce((sum, value) => sum + value, 0)
  return {
    billNo: `${marker}-SO`, billDate: now().slice(0, 10), orderTime: now(),
    customerId: sourceId(expected.customerId), accountId: sourceId(expected.accountId),
    saleTypeCode: 'NORMAL', discountPercent: 0, depositPrice: 0, totalPrice: count * 10, remark: marker,
    items: [{ productId: sourceId(expected.materialId), productUnitId: sourceId(expected.unitId),
      count, productPrice: 10, totalPrice: count * 10, taxPercent: 0, remark: marker }]
  }
}

export function buildSourceReturn (expected, option) {
  dimensions(option, expected)
  assert.equal(sourceId(option.orderItemId), sourceId(expected.orderItemId))
  assert.ok(quantity(option.availableQty) >= SOURCE_SCENARIO.returned, 'Insufficient actual source quantity')
  const { marker } = expected
  assert.ok(typeof expected.batchNo === 'string' && expected.batchNo.length <= 32 && expected.batchNo.length > 0)
  return {
    billNo: `${marker}-SR`, billDate: now().slice(0, 10), returnTime: now(),
    returnType: 2, customerId: sourceId(expected.customerId), accountId: sourceId(expected.accountId),
    srcBillType: 'SalOrder', srcBillId: sourceId(expected.orderId),
    discountPercent: 0, otherPrice: 0, remark: marker,
    items: [{ entryNo: 1, srcBillType: 'SalOrder', srcBillId: sourceId(expected.orderId),
      srcEntryId: sourceId(expected.orderItemId), productId: sourceId(expected.materialId),
      productUnitId: sourceId(expected.unitId), warehouseId: sourceId(expected.warehouseId),
      areaHouseId: sourceId(expected.wareAreaId), wareLocationId: sourceId(expected.wareLocationId),
      batchNo: expected.batchNo, count: 1, productPrice: 10, totalPrice: 10,
      productTotalPrice: 10, productTaxPrice: 0, taxPrice: 0, taxPercent: 0, remark: marker }],
    saleReturnBomList: [{ saleOrderId: sourceId(expected.orderId),
      saleOrderItemId: sourceId(expected.orderItemId), srcEntryId: sourceId(expected.orderItemId),
      sourceEntryNo: 1, entryNo: 1, materialId: sourceId(expected.materialId),
      productId: sourceId(expected.materialId), unitId: sourceId(expected.unitId),
      warehouseId: sourceId(expected.warehouseId), areaHouseId: sourceId(expected.wareAreaId),
      wareLocationId: sourceId(expected.wareLocationId), batchNo: expected.batchNo, qty: 1, bomNum: 1,
      srcStkIoId: sourceId(option.srcStkIoId), srcStkIoEntryId: sourceId(option.srcStkIoEntryId),
      remark: marker }]
  }
}

export function assertWmsSource (source, expected) {
  const { head, entries } = source
  assert.equal(head.srcBillType, expected.sourceType)
  assert.equal(sourceId(head.srcBillId), sourceId(expected.sourceId))
  assert.equal(head.srcNo, expected.sourceNo)
  assert.equal(String(head.stockIoType), expected.type)
  assert.equal(Number(head.isEffective), 1, 'WMS source must be effective')
  assert.ok(head.isVoided === 0 || head.isVoided === '0', 'WMS source must explicitly be unvoided')
  assert.ok(['32', '34'].includes(String(head.billStage)), 'WMS source must be executed')
  assert.equal(entries.length, 1, 'Dedicated single-batch source must have one real entry')
  const entry = entries[0]
  sourceId(entry.id)
  assert.equal(sourceId(entry.mid), sourceId(head.id))
  assert.equal(entry.srcBillType, expected.sourceType)
  assert.equal(sourceId(entry.srcBillId), sourceId(expected.sourceId))
  assert.equal(sourceId(entry.srcEntryId), sourceId(expected.sourceEntryId))
  assert.equal(String(entry.stockIoType), expected.type)
  assert.equal(String(entry.stockIoDirection), expected.type === '201' ? '2' : '1')
  assert.equal(quantity(entry.qty), expected.quantity, 'WMS quantity must be positive, without abs conversion')
  assert.ok(entry.inStockTime && Number.isFinite(Date.parse(entry.inStockTime)), 'Missing actual execution time')
  dimensions(entry, expected)
  return source
}

export function assertBatchOptions (rows, expected, shipments, returned = 0) {
  assert.ok(Array.isArray(rows), 'Batch options must be an array')
  assert.equal(rows.length, shipments.length, 'Both shipments must remain visible in this 2+3 / return 1 scenario')
  const actual = new Map()
  for (const row of rows) {
    dimensions(row, expected)
    assert.equal(sourceId(row.orderItemId), sourceId(expected.orderItemId), 'Must map back to the order item')
    assert.equal(sourceId(row.saleOrderItemId), sourceId(expected.orderItemId))
    const key = sourceId(row.srcStkIoEntryId)
    assert.ok(!actual.has(key), 'Duplicate WMS source entry')
    const shipment = shipments.find((item) => same(item.entries[0].id, key))
    assert.ok(shipment, 'Batch option is not from an actual formal shipment')
    assert.equal(sourceId(row.srcStkIoId), sourceId(shipment.head.id))
    const available = quantity(row.availableQty)
    assert.ok(available > 0 && available <= quantity(shipment.entries[0].qty))
    actual.set(key, available)
  }
  const shipped = shipments.reduce((sum, item) => sum + quantity(item.entries[0].qty), 0)
  assert.equal([...actual.values()].reduce((sum, value) => sum + value, 0), shipped - returned,
    'Returned quantity must be deducted once across shipments of the same batch')
  return [...actual].sort(([left], [right]) => left.localeCompare(right))
}

export function inventoryTotals (rows, expected) {
  assert.ok(Array.isArray(rows))
  const result = Object.fromEntries(componentFields.map((key) => [key, 0]))
  const seen = new Set()
  for (const row of rows) {
    dimensions(row, expected)
    assert.ok(!seen.has(sourceId(row.id)), 'Duplicate inventory row')
    seen.add(sourceId(row.id))
    for (const key of componentFields) result[key] += quantity(row[key])
    assert.equal(quantity(row.qty), componentFields.slice(1).reduce((sum, key) => sum + quantity(row[key]), 0),
      'WMS inventory components must reconcile')
  }
  return result
}

export function assertReturnInventoryDelta (before, after) {
  assert.equal(after.qty, before.qty + SOURCE_SCENARIO.returned, '302 must increase physical stock once')
  assert.equal(after.availableQty, before.availableQty + SOURCE_SCENARIO.returned,
    'Existing non-QC return must increase available stock once')
  for (const key of componentFields.slice(2)) assert.equal(after[key], before[key], `${key} changed`)
}

export function regressionPlan () {
  return {
    case: SALE_RETURN_SOURCE_CASE, mode: 'PLAN_ONLY', ...SOURCE_SCENARIO,
    command: 'CFOR_E2E_WRITE_FIXTURES=true CFOR_TENANT_ID=1 node scripts/e2e/fixtures/sale-return-source-regression.mjs --execute --headed',
    target: 'local 9151/48083; tenant 1; read-only DB 3306/cfor_admin_standard',
    evidence: ['106 opening -> two formal ErpSaleOut/201 shipments -> order/order-item batch mapping',
      'Browser order selection and real batch chooser before/after return: 5 -> 4',
      'RETURN_ONLY SalReturn/302 positive 1; order/item returnCount=1; physical stock 8 -> 6 -> 3 -> 4',
      'Repeat source reads: same remaining quantities, source IDs and WMS balances'],
    boundary: 'No RQC/needQc/config/SQL writes/restart; retain dedicated audit documents; pending approval is BLOCKED'
  }
}

export function readReusableSource (report, { readbackOnly = false } = {}) {
  assert.equal(report.environment.target, 'local')
  assert.equal(report.environment.webBase, 'http://127.0.0.1:9151')
  assert.equal(report.environment.apiBase, 'http://127.0.0.1:48083/admin-api')
  assert.equal(String(report.environment.tenantId), '1')
  assert.equal(report.environment.dbName, 'cfor_admin_standard')
  const previous = report.cases.find((row) => row.id === SALE_RETURN_SOURCE_CASE.id)
  assert.match(previous?.marker || '', /^E2E-SR-[A-F0-9]{10}$/)
  const returns = previous.fixtures.filter((row) => row.kind === 'sale-return')
  if (readbackOnly) {
    assert.equal(returns.length, 1, 'Readback requires exactly one previously-created return')
    assert.ok(previous.checks.some((row) => row.name ===
      'Same-batch shipments deduct return only once: 5 -> 4' && row.passed))
  } else {
    assert.equal(returns.length, 0, 'Cannot replay an already-created return')
  }
  assert.ok(previous.checks.some((row) => row.name ===
    'Both formal 201 shipments appear as order-item return candidates' && row.passed))
  const one = (kind) => {
    const rows = previous.fixtures.filter((row) => row.kind === kind)
    assert.equal(rows.length, 1, `Missing or ambiguous owned ${kind}`)
    sourceId(rows[0].id)
    return rows[0]
  }
  const opening = one('opening')
  assert.equal(opening.quantity, SOURCE_SCENARIO.opening)
  const outIds = previous.fixtures.filter((row) => row.kind === 'sale-out').map((row) => sourceId(row.id))
  assert.equal(new Set(outIds).size, 2)
  const before = previous.evidence.find((row) => row.stage === 'before-return-options')
  assert.equal(before?.options?.length, 2)
  return {
    marker: previous.marker, fixtures: previous.fixtures, opening,
    warehouse: one('warehouse'), area: one('area'), location: one('location'), material: one('material'),
    partner: one('partner'), order: one('sale-order'), outIds,
    unitId: sourceId(before.options[0].unitId), accountId: sourceId(one('sale-order').body.accountId),
    sourceRunId: report.runId,
    completedReturn: readbackOnly ? one('sale-return') : null,
    priorChecks: previous.checks
  }
}

export async function runSaleReturnSourceRegression ({ headed = false, sourceReport, readbackOnly = false } = {}) {
  const { config } = await import('../config/index.mjs')
  const { createApiClient, serverApiFailures } = await import('../lib/api.mjs')
  const { launchBrowser, login, observePage, openRoute, saveScreenshot } = await import('../lib/browser.mjs')
  const { decryptResponse, ENCRYPT_HEADER } = await import('../lib/crypto.mjs')
  const { assertLocalWriteSafety, runReadOnlySql } = await import('../lib/db.mjs')
  const { assertLocalWmsWriteTarget, isWmsWriteEnabled, prepareWmsFixture,
    createOpeningInventory, inventorySnapshot, dataOf, rowsOf } = await import('../lib/wms-fixtures.mjs')
  const { createRunRecord, createCaseRecord, finishCase, writeProgress, writeReport } = await import('../lib/report.mjs')
  const record = createRunRecord({ selectedSuites: [SALE_RETURN_SOURCE_CASE.suite],
    selectedCases: [SALE_RETURN_SOURCE_CASE.id] })
  const caseRecord = createCaseRecord(SALE_RETURN_SOURCE_CASE)
  record.cases.push(caseRecord)
  const outputDir = path.resolve(config.outputRoot, record.runId)
  let handle
  const fact = (name, verify, details = '') => {
    try {
      const value = verify()
      caseRecord.checks.push({ name, passed: true, details })
      return value
    } catch (error) {
      caseRecord.checks.push({ name, passed: false, details: `${details}; ${error.message}` })
      throw error
    }
  }
  const checkpoint = (stage, evidence) => {
    caseRecord.evidence.push({ stage, ...evidence })
    writeProgress(record, { caseRecord })
  }
  const remember = (kind, id, body) => {
    const fixture = { kind, id: sourceId(id), owned: true, tenantId: '1', marker, retained: true, body }
    caseRecord.fixtures ||= []
    caseRecord.fixtures.push(fixture)
    checkpoint(`created-${kind}`, { id: fixture.id })
    return fixture.id
  }
  assert.ok(!readbackOnly || sourceReport, 'Readback-only requires a source report')
  const reusable = sourceReport
    ? readReusableSource(JSON.parse(fs.readFileSync(sourceReport, 'utf8')), { readbackOnly }) : null
  const marker = reusable?.marker || sourceMarker()
  caseRecord.marker = marker
  if (reusable) {
    caseRecord.fixtures = structuredClone(reusable.fixtures)
    caseRecord.notes.push(`Reusing verified dedicated sources from ${reusable.sourceRunId}; every source is reread live.`)
    if (readbackOnly) {
      caseRecord.priorWriteEvidence = { runId: reusable.sourceRunId, sourceReport, checks: reusable.priorChecks }
      caseRecord.notes.push('Readback-only continuation: no business write, approval or return execution is permitted.')
    }
  }
  const readSql = async (stage, sql) => {
    const result = await runReadOnlySql(sql)
    if (!result.available) throw new Error(`BLOCKED: ${result.reason}`)
    caseRecord.database ||= []
    caseRecord.database.push({ stage, ...result })
    return result.rows
  }
  try {
    assertLocalWmsWriteTarget()
    if (!isWmsWriteEnabled()) throw new Error('BLOCKED: CFOR_E2E_WRITE_FIXTURES=true is required')
    await assertLocalWriteSafety(caseRecord)
    handle = await launchBrowser({ headed, record })
    const { page } = handle
    const observer = observePage(page, record)
    const flush = observer.flushResponses.bind(observer)
    observer.flushResponses = (options = {}) => flush({ timeoutMs: 60000, ...options })
    handle.flushResponses = observer.flushResponses
    const auth = await login(page, { returnContext: true, dumpDir: outputDir })
    assert.equal(String(auth.tenantId), '1', 'Authenticated tenant must be 1')
    const api = createApiClient({ token: auth.token, tenantId: auth.tenantId, record })
    const fixtureApi = {
      ...api,
      postBusiness: async (url, body, options) => {
        checkpoint('fixture-write-intent', { url, body })
        const response = await api.postBusiness(url, body, options)
        checkpoint('fixture-write-result', { url, response })
        return response
      }
    }
    const get = async (url) => dataOf(await api.getBusiness(url), url)
    const detail = (kind, id) => get(`/erp/${kind}/get?id=${sourceId(id)}`)
    const batchOptions = () => get(`/erp/sale-return/bom-batch-options?saleOrderId=${sourceId(expected.orderId)}`)
    const requireApproved = async (kind, id) => {
      let row = await detail(kind, id)
      // Match the existing UI: only a submitted stage-14 document can request approval.
      if (!readbackOnly && Number(row.status) !== 20 && Number(row.isEffective) !== 1 && String(row.billStage) === '14') {
        await api.putBusiness(`/erp/${kind}/update-status?id=${sourceId(id)}&status=10`)
        row = await detail(kind, id)
      }
      checkpoint(`${kind}-approval-readback`, { detail: row })
      if (Number(row.status) !== 20 || Number(row.isEffective) !== 1) {
        throw new Error(`BLOCKED: ${kind}/${id} awaiting existing approval/execution; ` +
          `stage=${row.billStage}, status=${row.status}, process=${row.processInstanceId || row.bpmiInstanceId || ''}`)
      }
      return row
    }
    const fixture = reusable
      ? { warehouse: reusable.warehouse, area: reusable.area, location: reusable.location,
          material: await get(`/mes/basMaterial/queryById?id=${reusable.material.id}`),
          unit: { id: reusable.unitId } }
      : await prepareWmsFixture(fixtureApi, caseRecord, 302)
    if (reusable) {
      assert.equal(fixture.material.code, reusable.material.code, 'Reused material ownership changed')
      assert.equal(sourceId(fixture.material.unitId), reusable.unitId)
    }
    const expected = {
      marker, materialId: sourceId(fixture.material.id), unitId: sourceId(fixture.unit.id),
      warehouseId: sourceId(fixture.warehouse.id), wareAreaId: sourceId(fixture.area.id),
      wareLocationId: sourceId(fixture.location.id), batchNo: `${marker}-OPENING-BATCH`
    }
    const readInventory = async (stage, qty) => {
      const rows = await inventorySnapshot(api, fixture, expected.materialId)
      const totals = fact(`${stage}: API inventory quantity and components`, () => {
        const value = inventoryTotals(rows, expected)
        assert.equal(value.qty, qty)
        return value
      })
      const db = await readSql(`${stage}-inventory`,
        `SELECT id,material_id,unit_id,warehouse_id,ware_area_id,ware_location_id,batch_no,
          qty,available_qty,lock_qty,hold_qty,frozen_qty,pending_putaway_qty
         FROM mes_stk_inventory WHERE tenant_id=1 AND deleted=0
          AND warehouse_id=${sqlId(expected.warehouseId)} AND material_id=${sqlId(expected.materialId)}
         ORDER BY id`)
      const keys = ['id', 'materialId', 'unitId', 'warehouseId', 'wareAreaId', 'wareLocationId',
        'batchNo', ...componentFields]
      const dbRows = db.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index]])))
      fact(`${stage}: API and authoritative WMS DB agree`, () => {
        assert.deepEqual(inventoryTotals(dbRows, expected), totals)
        assert.deepEqual(rows.map((row) => sourceId(row.id)).sort(), dbRows.map((row) => sourceId(row.id)).sort())
      })
      checkpoint(stage, { inventory: rows, totals })
      return totals
    }
    if (!reusable) await readInventory('owned-zero-baseline', 0)
    const opening = reusable
      ? { ...reusable.opening, detail: await get(`/mes/stkIo/queryById?id=${reusable.opening.id}`) }
      : await createOpeningInventory(api, caseRecord, { ...fixture, token: marker },
          fixture.material, fixture.unit.id, SOURCE_SCENARIO.opening)
    if (reusable) {
      opening.approved = Number(opening.detail.isEffective) === 1 && Number(opening.detail.isVoided) === 0
      assert.equal(String(opening.detail.stockIoType), '106')
      assert.ok(opening.detail.remark.includes(marker))
    }
    checkpoint('opening-106', { opening })
    if (!opening.approved) throw new Error('BLOCKED: dedicated real 106 opening is not effective')
    assert.equal(opening.batchNo, expected.batchNo)
    if (!reusable) {
      const opened = await readInventory('opening-executed', SOURCE_SCENARIO.opening)
      assert.equal(opened.availableQty, SOURCE_SCENARIO.opening)
    } else {
      await readInventory('reused-source-inventory', readbackOnly ? 4 : 3)
    }

    const accounts = rowsOf(await api.getBusiness('/erp/account/page?pageNo=1&pageSize=100&status=0'))
    const account = accounts.find((row) => row.id && Number(row.status) === 0 &&
      (!reusable || same(row.id, reusable.accountId)))
    if (!account) throw new Error('BLOCKED: no existing enabled settlement account')
    expected.accountId = sourceId(account.id)
    const customerBody = { name: `${marker}-CUSTOMER`, shortName: marker, partnerKind: 'ORGANIZATION',
      status: 'ACTIVE', supplierEnabled: false, customerEnabled: true, carrierEnabled: false, remark: marker }
    expected.customerId = reusable?.partner.id ||
      remember('partner', dataOf(await api.postBusiness('/base/partner/create', customerBody)), customerBody)
    const customer = await get(`/base/partner/get?id=${expected.customerId}`)
    fact('Dedicated customer ownership', () => {
      assert.equal(sourceId(customer.id), expected.customerId)
      assert.equal(customer.remark, marker)
      assert.equal(customer.customerEnabled, true)
    })
    const orderBody = buildSourceOrder(expected)
    expected.orderId = reusable?.order.id ||
      remember('sale-order', dataOf(await api.postBusiness('/erp/sale-order/create', orderBody)), orderBody)
    const order = await requireApproved('sale-order', expected.orderId)
    fact('Real order and single order item', () => {
      assert.equal(order.remark, marker)
      assert.equal(sourceId(order.customerId), expected.customerId)
      assert.equal(order.items.length, 1)
      assert.equal(sourceId(order.items[0].productId), expected.materialId)
      assert.equal(quantity(order.items[0].count), 5)
    })
    expected.orderItemId = sourceId(order.items[0].id)

    const readSource = async (sourceType, sourceIdValue, sourceNo, sourceEntryId, type, count) => {
      const id = sourceId(sourceIdValue)
      const heads = rowsOf(await api.getBusiness(`/mes/stkIo/list?pageNo=1&pageSize=100&srcBillType=${sourceType}&srcBillId=${id}`))
        .filter((row) => row.srcBillType === sourceType && same(row.srcBillId, id))
      assert.equal(heads.length, 1, 'Expected exactly one real WMS source; no exchange or duplicate execution')
      const head = await get(`/mes/stkIo/queryById?id=${sourceId(heads[0].id)}`)
      const entries = rowsOf(await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${sourceId(head.id)}`))
      const source = { head, entries }
      fact(`${sourceType}/${id}: effective ${type} source and exact original dimensions`,
        () => assertWmsSource(source, { ...expected, sourceType, sourceId: id, sourceNo, sourceEntryId, type, quantity: count }))
      const dbHeads = await readSql(`${sourceType}-${id}-head`,
        `SELECT id,stock_io_type,src_bill_type,src_bill_id,src_no,is_effective,is_voided
         FROM mes_stk_io WHERE tenant_id=1 AND deleted=0
          AND src_bill_type='${sourceType}' AND src_bill_id=${sqlId(id)} ORDER BY id`)
      const dbEntries = await readSql(`${sourceType}-${id}-entries`,
        `SELECT id,mid,src_bill_type,src_bill_id,src_entry_id,stock_io_type,stock_io_direction,
          material_id,unit_id,warehouse_id,ware_area_id,ware_location_id,batch_no,qty,in_stock_time
         FROM mes_stk_io_entry WHERE tenant_id=1 AND deleted=0 AND mid=${sqlId(head.id)} ORDER BY id`)
      fact(`${sourceType}/${id}: WMS head/entry API agree with DB`, () => {
        assert.deepEqual(dbHeads, [[sourceId(head.id), type, sourceType, id, sourceNo, '1', '0']])
        assert.equal(dbEntries.length, 1)
        assert.deepEqual(dbEntries[0].slice(0, 13), [sourceId(entries[0].id), sourceId(head.id), sourceType,
          id, sourceId(sourceEntryId), type, type === '201' ? '2' : '1', expected.materialId, expected.unitId,
          expected.warehouseId, expected.wareAreaId, expected.wareLocationId, expected.batchNo])
        assert.equal(quantity(dbEntries[0][13]), count)
        assert.ok(dbEntries[0][14] && dbEntries[0][14] !== 'NULL')
      })
      checkpoint(`${sourceType}-${id}-source`, source)
      return source
    }
    const shipments = []
    let shipped = 0
    for (const count of SOURCE_SCENARIO.shipments) {
      const body = { businessType: 'NORMAL', orderId: expected.orderId, accountId: expected.accountId,
        outTime: now(), discountPercent: 0, otherPrice: 0, remark: marker,
        items: [{ orderItemId: expected.orderItemId, warehouseId: expected.warehouseId,
          productId: expected.materialId, productUnitId: expected.unitId,
          productPrice: 10, count, taxPercent: 0, remark: marker }] }
      const id = reusable?.outIds[shipments.length] ||
        remember('sale-out', dataOf(await api.postBusiness('/erp/sale-out/create', body)), body)
      if (!reusable) await api.putBusiness(`/erp/sale-out/update-status?id=${id}&status=20`)
      const out = await detail('sale-out', id)
      fact('Formal NORMAL sale out maps to exact order/item', () => {
        assert.equal(out.remark, marker)
        assert.equal(out.businessType, 'NORMAL')
        assert.equal(Number(out.status), 20)
        assert.equal(sourceId(out.orderId), expected.orderId)
        assert.equal(out.items.length, 1)
        assert.equal(sourceId(out.items[0].orderItemId), expected.orderItemId)
        assert.equal(quantity(out.items[0].count), count)
      })
      shipments.push(await readSource('ErpSaleOut', id, out.no, out.items[0].id, '201', count))
      shipped += count
      if (!reusable) await readInventory(`after-shipment-${shipments.length}`, SOURCE_SCENARIO.opening - shipped)
    }
    assert.notEqual(shipments[0].head.id, shipments[1].head.id)
    const beforeOptions = await batchOptions()
    const beforeNormalized = fact('Both formal 201 shipments appear as order-item return candidates',
      () => assertBatchOptions(beforeOptions, expected, shipments, readbackOnly ? 1 : 0))
    checkpoint('before-return-options', { options: beforeOptions })

    const browserBatchOptions = async (stage, returned, apiNormalized) => {
      await openRoute(page, '/erp/sale/return', { readySelector: 'input[placeholder="请输入退货单号"]' })
      await page.getByRole('button', { name: '新增', exact: true }).click()
      const form = page.locator('.com-dialog:visible')
      await form.getByRole('button', { name: /选\s*单/ }).click()
      const chooser = page.locator('.el-dialog:visible').filter({ hasText: '选择销售订单（仅展示可退货）' })
      await chooser.getByPlaceholder('请输入订单单号').fill(order.billNo)
      const orderResponse = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/sale-order/page') && url.searchParams.get('billNo') === order.billNo
      })
      await chooser.getByRole('button', { name: '搜索', exact: true }).click()
      assert.equal((await orderResponse).status(), 200)
      const orderRow = chooser.locator('.el-table').first().locator('.el-table__body-wrapper tbody tr')
        .filter({ hasText: order.billNo })
      await orderRow.waitFor({ state: 'visible' })
      assert.equal(await orderRow.count(), 1, 'Browser must select exactly this dedicated order')
      await orderRow.locator('td').first().click()
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/sale-return/bom-batch-options') &&
          url.searchParams.get('saleOrderId') === expected.orderId
      })
      await chooser.getByRole('button', { name: /确\s*定/ }).click()
      const response = await responsePromise
      assert.equal(response.status(), 200)
      const body = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(await response.text()) : await response.json()
      const rows = rowsOf(body, 'Real browser formal batch endpoint')
      fact(`${stage}: browser formal endpoint matches API candidates`, () => {
        assert.deepEqual(assertBatchOptions(rows, expected, shipments, returned), apiNormalized)
      })
      checkpoint(`${stage}-formal-response`, { browserOptions: rows })
      const bottomGrid = form.locator('.vxe-table--main-wrapper').last()
      await bottomGrid.scrollIntoViewIfNeeded()
      await bottomGrid.locator('.vxe-table--body-wrapper').evaluate((element) => { element.scrollLeft = 800 })
      const header = bottomGrid.locator('.vxe-header--column')
        .filter({ has: page.getByText('原出库批次', { exact: true }) })
      await header.waitFor({ state: 'visible' })
      const column = await header.getAttribute('colid')
      assert.match(column || '', /^[A-Za-z0-9_-]+$/, 'Missing real batch grid column')
      const grid = header.locator('xpath=ancestor::div[contains(@class,"vxe-table--main-wrapper")]')
      await grid.locator(`.vxe-body--row td[colid="${column}"]`).first().click()
      await form.getByPlaceholder('请选择原出库批次').first().focus()
      const batches = page.locator('.el-dialog:visible').filter({ hasText: '选择退货批次' })
      await batches.waitFor({ state: 'visible' })
      const visibleRows = batches.locator('.vxe-table--main-wrapper .vxe-body--row')
      await visibleRows.first().waitFor({ state: 'visible' })
      assert.equal(await visibleRows.count(), 2, 'Both real shipments must be rendered')
      const qtyHeader = batches.locator('.vxe-table--main-wrapper .vxe-header--column')
        .filter({ has: page.getByText('可退数量', { exact: true }) })
      const qtyColumn = await qtyHeader.getAttribute('colid')
      assert.match(qtyColumn || '', /^[A-Za-z0-9_-]+$/)
      const rendered = []
      for (let index = 0; index < 2; index++) {
        const row = visibleRows.nth(index)
        const text = await row.innerText()
        assert.ok(shipments.some((item) => text.includes(item.head.billNo)), 'Browser displayed a foreign shipment')
        rendered.push(quantity((await row.locator(`td[colid="${qtyColumn}"]`).innerText()).trim()))
      }
      fact(`${stage}: actual batch chooser shows the remaining quantities`, () => {
        assert.deepEqual(rendered.sort((a, b) => a - b), rows.map((row) => quantity(row.availableQty)).sort((a, b) => a - b))
      })
      await saveScreenshot(page, path.join(outputDir, 'screenshots'), stage, record)
      checkpoint(stage, { browserOptions: rows, renderedQuantities: rendered })
      await batches.getByRole('button', { name: /取\s*消/ }).click()
      // Navigating discards the unsaved browser form; it does not create another return document.
      await openRoute(page, '/erp/sale/return', { readySelector: 'input[placeholder="请输入退货单号"]' })
    }
    if (!readbackOnly) await browserBatchOptions('browser-before-return', 0, beforeNormalized)
    const beforeInventory = readbackOnly ? null : await readInventory('before-return', 3)
    const returnBody = buildSourceReturn(expected, beforeOptions[0])
    const returnId = reusable?.completedReturn?.id ||
      remember('sale-return', dataOf(await api.postBusiness('/erp/sale-return/create', returnBody)), returnBody)
    const returned = await requireApproved('sale-return', returnId)
    fact('Return preserves exact order, original batch and real WMS provenance', () => {
      assert.equal(returned.remark, marker)
      assert.equal(Number(returned.returnType), 2)
      assert.equal(sourceId(returned.srcBillId), expected.orderId)
      assert.equal(returned.items.length, 1)
      assert.equal(sourceId(returned.items[0].srcEntryId), expected.orderItemId)
      assert.equal(quantity(returned.items[0].count), 1)
      assert.equal(returned.saleReturnBomList.length, 1)
      const bom = returned.saleReturnBomList[0]
      assert.equal(sourceId(bom.saleOrderItemId), expected.orderItemId)
      assert.equal(sourceId(bom.saleReturnItemId), sourceId(returned.items[0].id))
      assert.equal(quantity(bom.qty), 1)
      assert.equal(sourceId(bom.srcStkIoId), sourceId(beforeOptions[0].srcStkIoId))
      assert.equal(sourceId(bom.srcStkIoEntryId), sourceId(beforeOptions[0].srcStkIoEntryId))
      assert.equal(bom.batchNo, expected.batchNo)
    })
    const returnSource = await readSource('SalReturn', returnId, returned.billNo, returned.items[0].id, '302', 1)
    const afterInventory = await readInventory('after-positive-302', 4)
    if (!readbackOnly) {
      fact('302 returns one physical/available unit without changing other components',
        () => assertReturnInventoryDelta(beforeInventory, afterInventory))
    }
    const afterOrder = await detail('sale-order', expected.orderId)
    fact('Order and order-item returnCount read back the real 302 once', () => {
      assert.equal(quantity(afterOrder.outCount), 5)
      assert.equal(quantity(afterOrder.items[0].outCount), 5)
      assert.equal(quantity(afterOrder.returnCount), 1)
      assert.equal(quantity(afterOrder.items[0].returnCount), 1)
    })
    checkpoint('order-counts-after-302', { order: afterOrder })
    const afterOptions = await batchOptions()
    const afterNormalized = fact('Same-batch shipments deduct return only once: 5 -> 4',
      () => assertBatchOptions(afterOptions, expected, shipments, 1))
    checkpoint('after-return-options', { options: afterOptions })
    await browserBatchOptions('browser-after-return', 1, afterNormalized)
    for (let read = 1; read <= 2; read++) {
      const options = await batchOptions()
      fact(`Repeat read ${read}: unchanged source allocation`,
        () => assert.deepEqual(assertBatchOptions(options, expected, shipments, 1), afterNormalized))
      checkpoint(`repeat-options-${read}`, { options })
    }
    const reread = await readSource('SalReturn', returnId, returned.billNo, returned.items[0].id, '302', 1)
    assert.equal(sourceId(reread.head.id), sourceId(returnSource.head.id))
    assert.equal(sourceId(reread.entries[0].id), sourceId(returnSource.entries[0].id))
    const finalInventory = await readInventory('after-browser-and-repeat-reads', 4)
    fact('Browser and repeated reads do not duplicate WMS execution', () => assert.deepEqual(finalInventory, afterInventory))
    await handle.flushResponses()
    fact('No browser/API failures during real source regression', () => {
      for (const key of ['pageErrors', 'consoleErrors', 'requestFailures', 'failedApiResponses']) {
        assert.deepEqual(record[key], [], key)
      }
      assert.deepEqual(serverApiFailures(record.api), [])
      assert.ok(caseRecord.checks.every((check) => check.passed), 'A prerequisite check failed')
    })
    finishCase(caseRecord, 'PASS', readbackOnly
      ? `Real browser/API/WMS readback continuation passed; original write evidence: ${reusable.sourceRunId}. No business writes in this continuation.`
      : 'Real browser/API/read-only WMS DB source regression passed; dedicated audit documents retained.')
  } catch (error) {
    if (handle) {
      try { await saveScreenshot(handle.page, path.join(outputDir, 'screenshots'), 'failure', record) } catch {}
    }
    caseRecord.error = { name: error.name, message: error.message, stack: error.stack }
    finishCase(caseRecord, error.message.startsWith('BLOCKED:') ? 'BLOCKED' : 'FAIL', error.message)
  } finally {
    caseRecord.durationMs = Date.now() - Date.parse(caseRecord.startedAt)
    caseRecord.notes.push('Retained this run’s dedicated master data and formal source chain for audit; no SQL writes, forced reversal, RQC or policy changes.')
    try {
      if (handle) {
        try { await handle.flushResponses() } finally { await handle.browser.close() }
      }
    } catch (error) {
      finishCase(caseRecord, 'FAIL', `Browser close/flush failed: ${error.message}`)
    }
    await writeReport(record)
  }
  return { status: caseRecord.status, outputDir, marker }
}

async function main () {
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--reuse-source-report')
  const sourceReport = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined
  if (sourceIndex >= 0) {
    assert.ok(sourceReport && !sourceReport.startsWith('--'), 'Missing source report path')
    args.splice(sourceIndex, 2)
  }
  assert.ok(args.every((arg) => ['--execute', '--headed', '--help', '--readback-only'].includes(arg)), 'Unknown argument')
  if (!args.includes('--execute') || args.includes('--help')) {
    console.log(JSON.stringify(regressionPlan(), null, 2))
    return
  }
  const result = await runSaleReturnSourceRegression({ headed: args.includes('--headed'), sourceReport,
    readbackOnly: args.includes('--readback-only') })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'PASS') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
