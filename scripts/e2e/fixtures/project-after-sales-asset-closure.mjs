import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

const data = (response, label) => assertBusinessSuccess(response, label).data
const id = (value, label) => {
  assert.match(String(value ?? ''), /^[1-9]\d*$/, `${label}: missing ID`)
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value), `${label}: lossy ID`)
  return String(value)
}
const rows = (response, label) => {
  const value = data(response, label)
  assert.ok(Array.isArray(value), `${label}: missing array`)
  return value
}
const total = (value, label) => {
  assert.ok((typeof value === 'number' ||
    (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value))) &&
    Number.isSafeInteger(Number(value)) && Number(value) >= 0,
    `${label}: invalid total`)
  return Number(value)
}

export const assertPb125LocalTarget = (target = config) => {
  assert.equal(target.target, 'local', 'PB125 only allows the local target')
  assert.equal(String(target.tenantId), '1', 'PB125 only allows tenant 1')
  for (const [base, port] of [[target.apiBase, '48083'], [target.webBase, '9151']]) {
    const url = new URL(base)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    assert.equal(url.port, port, 'PB125 local port mismatch')
  }
}

export const pb125DateOffset = (days, now = new Date()) => {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
  const date = new Date(`${local}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export const newPb125Fixture = (now = new Date()) => {
  const marker = `PB125-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  return {
    marker,
    customerNo: `${marker}-CUSTOMER`,
    materialCode: `${marker}-MAT`,
    assets: [],
    today: pb125DateOffset(0, now),
    activePeriod: {
      startDate: pb125DateOffset(-7, now), endDate: pb125DateOffset(365, now)
    },
    expiredPeriod: {
      startDate: pb125DateOffset(-90, now), endDate: pb125DateOffset(-30, now)
    },
    pagePeriod: {
      startDate: pb125DateOffset(-1, now), endDate: pb125DateOffset(400, now),
      sourceNo: `${marker}-PAGE`, sourceName: 'PB125 dedicated page service period'
    },
    finishTime: `${pb125DateOffset(1, now)} 18:00:00`
  }
}

export const assertPb125AssetOwner = (detail, fixture, asset) => {
  assert.equal(id(detail?.customer?.id, 'customer'), fixture.customerId)
  assert.equal(detail.customer.customerNo, fixture.customerNo)
  assert.equal(id(detail?.asset?.id, 'asset'), asset.assetId)
  assert.equal(id(detail.asset.customerId, 'asset customer'), fixture.customerId)
  assert.equal(id(detail.asset.materialId, 'asset material'), fixture.materialId)
  assert.equal(detail.asset.assetNo, asset.assetNo)
  return detail
}

export const readPb125Asset = async (api, fixture, asset) => assertPb125AssetOwner(
  data(await api.getBusiness(`/after-sales/asset/get?id=${asset.assetId}`), 'PB125 asset'),
  fixture, asset
)

export const assertPb125ServicePeriod = (detail, expected, status, aggregateRange = expected) => {
  assert.equal(detail.asset.serviceStartDate, aggregateRange.startDate)
  assert.equal(detail.asset.serviceEndDate, aggregateRange.endDate)
  assert.equal(detail.asset.serviceStatus, status)
  assert.ok(Array.isArray(detail.servicePeriods) && detail.servicePeriods.some((period) =>
    period.startDate === expected.startDate && period.endDate === expected.endDate &&
    period.sourceNo === expected.sourceNo && period.status === 'VALID'),
  'PB125 service state must have the exact persisted service-period basis')
}

const materialOwner = (material, fixture) => {
  assert.equal(id(material?.id, 'material'), fixture.materialId)
  assert.equal(material.code, fixture.materialCode)
  assert.equal(material.remark, fixture.marker)
  return material
}

export const preparePb125Material = async (api, fixture, readSql = runReadOnlySql) => {
  const readiness = await readSql("SELECT 'PB125-read-evidence', 1")
  if (!readiness.available) throw new Error(`BLOCKED: PB125 read evidence unavailable: ${readiness.reason}`)
  assert.deepEqual(readiness.rows, [['PB125-read-evidence', '1']], 'PB125 read evidence preflight failed')
  const unit = rows(await api.getBusiness('/mes/basUnit/list/enabled'), 'PB125 enabled units')
    .find((row) => row?.id != null)
  if (!unit) throw new Error('BLOCKED: PB125 has no enabled unit for a dedicated material')
  fixture.materialId = id(data(await api.postBusiness('/mes/basMaterial/add', {
    code: fixture.materialCode, name: fixture.marker, auxName: fixture.marker,
    unitId: id(unit.id, 'unit'), inventoryNature: 'STOCK', isMaterial: 'Y',
    isEnabled: 1, purchased: 'Y', saled: 'Y', produced: 'N',
    source: 'purchase', leadTime: 1, bufferTime: 1, batchManaged: 'N', oneBarcode: 'N',
    periodManaged: 'N', gradeManaged: 'N', remark: fixture.marker
  }), 'PB125 dedicated material'), 'material')
  return materialOwner(data(await api.getBusiness(
    `/mes/basMaterial/queryById?id=${fixture.materialId}`
  ), 'PB125 material readback'), fixture)
}

// Keep raw physical dimensions: a qty>0 list or grouped report alone misses zero/negative rows.
export const readPb125InventoryFacts = async (api, fixture, readSql = runReadOnlySql) => {
  id(fixture.materialId, 'material')
  const material = materialOwner(data(await api.getBusiness(
    `/mes/basMaterial/queryById?id=${fixture.materialId}`
  ), 'PB125 material facts'), fixture)
  const report = data(await api.getBusiness(
    `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${fixture.materialId}`
  ), 'PB125 WMS stock report')
  assert.ok(Array.isArray(report?.list), 'PB125 WMS report missing list')
  assert.equal(total(report.total, 'PB125 WMS report'), 0,
    'PB125 dedicated material must have no WMS quantity report rows')
  assert.equal(report.list.length, 0, 'PB125 WMS report contradicts total=0')
  const snapshot = await readSql(`
    SELECT 'inventory-count', COUNT(*) FROM mes_stk_inventory
    WHERE tenant_id=1 AND deleted=0 AND material_id='${fixture.materialId}';
    SELECT 'inventory-row', id, material_id, warehouse_id, batch_no, color_id, brand,
      grade_id, ware_area_id, ware_location_id, unit_id, qty, available_qty,
      lock_qty, hold_qty, frozen_qty, pending_putaway_qty, cost, version, is_closed
    FROM mes_stk_inventory
    WHERE tenant_id=1 AND deleted=0 AND material_id='${fixture.materialId}'
    ORDER BY id
  `)
  if (!snapshot.available) throw new Error(`BLOCKED: PB125 full WMS facts unavailable: ${snapshot.reason}`)
  assert.ok(Array.isArray(snapshot.rows), 'PB125 raw inventory missing rows')
  const countRows = snapshot.rows.filter((row) => row[0] === 'inventory-count')
  assert.equal(countRows.length, 1, 'PB125 raw inventory missing unique count')
  assert.match(String(countRows[0][1]), /^(?:0|[1-9]\d*)$/, 'PB125 raw inventory invalid count')
  const count = total(Number(countRows[0][1]), 'PB125 raw inventory')
  const inventory = snapshot.rows.filter((row) => row[0] === 'inventory-row')
  assert.equal(snapshot.rows.length, inventory.length + 1, 'PB125 raw inventory unknown rows')
  assert.equal(count, inventory.length, 'PB125 raw inventory count/rows mismatch')
  assert.equal(count, 0, 'PB125 dedicated material unexpectedly has physical inventory rows')
  return { material: structuredClone(material), reportTotal: total(report.total, 'PB125 WMS report'), inventory }
}

export const assertPb125AssetSearch = (response, fixture, asset) => {
  const page = data(response, 'PB125 dedicated asset search')
  assert.equal(total(page?.total, 'PB125 asset search'), 1)
  assert.ok(Array.isArray(page.list) && page.list.length === 1, 'PB125 asset search must be unique')
  const found = page.list[0]
  assert.equal(id(found?.id, 'listed asset'), asset.assetId)
  assert.equal(id(found.customerId, 'listed customer'), fixture.customerId)
  assert.equal(found.assetNo, asset.assetNo)
  assert.equal(found.serviceStatus, 'IN_SERVICE')
  return found
}

export const assertPb125InventoryUnchanged = (before, after) => {
  assert.ok(before?.material && after?.material, 'PB125 missing material snapshots')
  assert.deepEqual(after, before, 'PB125 after-sales operation changed material/WMS facts')
  return true
}

export const preparePb125Assets = async (api, fixture) => {
  const descriptions = [
    { assetNo: `${fixture.marker}-ACTIVE`, period: fixture.activePeriod, status: 'IN_SERVICE' },
    { assetNo: `${fixture.marker}-EXPIRED`, period: fixture.expiredPeriod, status: 'SERVICE_EXPIRED' }
  ]
  const profile = data(await api.postBusiness('/after-sales/asset/customer-profile/create', {
    customerNo: fixture.customerNo, fullName: fixture.customerNo, shortName: fixture.marker,
    primaryContactName: `${fixture.marker}-CONTACT`, primaryContactMobile: '13800000125',
    assets: descriptions.map((asset) => ({
      assetNo: asset.assetNo, materialId: fixture.materialId, assetName: fixture.marker,
      assetContent: fixture.marker, useStartDate: asset.period.startDate,
      storageAddress: fixture.marker,
      managers: [{
        departmentName: 'E2E', managerName: `${fixture.marker}-MANAGER`,
        managerMobile: '13800000126', primary: true
      }],
      servicePeriods: [{
        ...asset.period, sourceType: 'MANUAL', sourceNo: asset.assetNo,
        sourceName: fixture.marker, idempotencyKey: asset.assetNo
      }]
    }))
  }), 'PB125 customer profile')
  fixture.profileCreated = true
  fixture.customerId = id(profile?.customerId, 'customer')
  fixture.contactId = id(profile?.primaryContactId, 'contact')
  assert.ok(Array.isArray(profile.assetIds) && profile.assetIds.length === 2,
    'PB125 profile must return both dedicated assets')
  for (const [index, asset] of descriptions.entries()) {
    fixture.assets.push({
      ...asset, assetId: id(profile.assetIds[index], 'asset'),
      period: { ...asset.period, sourceNo: asset.assetNo }
    })
  }
  assert.equal(new Set(fixture.assets.map((asset) => asset.assetId)).size, 2,
    'PB125 profile returned duplicate asset IDs')
  for (const asset of fixture.assets) {
    const detail = await readPb125Asset(api, fixture, asset)
    assertPb125ServicePeriod(detail, asset.period, asset.status)
    asset.detail = detail
  }
  return fixture.assets
}

export const changePb125AssetStatus = async (api, fixture, asset, serviceStatus) => {
  const before = await readPb125Asset(api, fixture, asset)
  const reason = `${fixture.marker}:${serviceStatus}`
  await api.putBusiness('/after-sales/asset/update-status', {
    id: asset.assetId, serviceStatus, reason, version: before.asset.version
  })
  const after = await readPb125Asset(api, fixture, asset)
  assert.equal(after.asset.serviceStatus, serviceStatus, 'PB125 status event did not persist')
  return after
}

export const verifyPb125StatusEvents = async (fixture, asset, readSql = runReadOnlySql) => {
  id(asset.assetId, 'asset')
  const snapshot = await readSql(`
    SELECT asset_id, before_status, after_status, change_reason, operator_id
    FROM after_sales_asset_status_log WHERE tenant_id=1 AND asset_id=${asset.assetId}
    ORDER BY id
  `)
  if (!snapshot.available) throw new Error(`BLOCKED: PB125 status history unavailable: ${snapshot.reason}`)
  assert.ok(Array.isArray(snapshot.rows), 'PB125 status history missing rows')
  const transitions = [
    ['IN_SERVICE', 'SERVICE_SUSPENDED'],
    ['SERVICE_SUSPENDED', 'IN_SERVICE'],
    ['IN_SERVICE', 'RETIRED']
  ]
  assert.equal(snapshot.rows.length, transitions.length, 'PB125 status history event count mismatch')
  snapshot.rows.forEach((row, index) => {
    assert.equal(row.length, 5, 'PB125 malformed status history')
    assert.equal(id(row[0], 'history asset'), asset.assetId)
    assert.deepEqual(row.slice(1, 3), transitions[index])
    assert.equal(row[3], `${fixture.marker}:${transitions[index][1]}`)
    id(row[4], 'history operator')
  })
  return snapshot.rows
}

const readConfig = async (api, path, configId) => {
  const matches = rows(await api.getBusiness(path), 'PB125 configuration list')
    .filter((row) => String(row.id) === configId)
  assert.equal(matches.length, 1, 'PB125 configuration ID must resolve uniquely')
  assert.equal(id(matches[0].id, 'configuration'), configId)
  return matches[0]
}

const assertTicketOwner = (ticket, fixture) => {
  assert.equal(id(ticket?.id, 'ticket'), fixture.ticketId)
  assert.equal(id(ticket.customerId, 'ticket customer'), fixture.customerId)
  assert.equal(id(ticket.assetId, 'ticket asset'), fixture.assets[1].assetId)
  assert.equal(id(ticket.categoryId, 'ticket category'), fixture.categoryId)
  assert.equal(ticket.title, `${fixture.marker}-EXPIRED-TICKET`)
  return ticket
}

export const readPb125Ticket = async (api, fixture) => assertTicketOwner(
  data(await api.getBusiness(`/after-sales/ticket/get?id=${fixture.ticketId}`), 'PB125 ticket'),
  fixture
)

export const verifyPb125ExpiredAcceptance = async (api, fixture) => {
  const expired = await readPb125Asset(api, fixture, fixture.assets[1])
  assertPb125ServicePeriod(expired, fixture.assets[1].period, 'SERVICE_EXPIRED')
  fixture.categoryCode = `${fixture.marker}-CATEGORY`
  fixture.categoryId = id(data(await api.postBusiness('/after-sales/modeling/category/create', {
    categoryCode: fixture.categoryCode, categoryName: fixture.categoryCode,
    defaultPriority: 'P3', applicableServiceStatus: 'SERVICE_EXPIRED', sortNo: 925
  }), 'PB125 expired category'), 'category')
  const category = data(await api.getBusiness(
    `/after-sales/modeling/category/get?id=${fixture.categoryId}`
  ), 'PB125 expired category readback')
  assert.equal(id(category?.id, 'category'), fixture.categoryId)
  assert.equal(category.categoryCode, fixture.categoryCode)
  assert.equal(category.leafFlag, true)
  assert.equal(category.status, 'ENABLED')
  assert.equal(category.applicableServiceStatus, 'SERVICE_EXPIRED')

  fixture.policyCode = `${fixture.marker}-SLA`
  fixture.policyId = id(data(await api.postBusiness('/after-sales/modeling/sla-policy/create', {
    policyCode: fixture.policyCode, policyName: fixture.policyCode,
    categoryIds: [fixture.categoryId], priority: 'P3', assetServiceStatus: 'SERVICE_EXPIRED',
    responseMinutes: 30, resolutionCommitted: true, resolutionMinutes: 240,
    warningRatio: 80, effectiveType: 'IMMEDIATE', remark: fixture.marker
  }), 'PB125 expired SLA'), 'SLA')
  const policies = rows(await api.getBusiness('/after-sales/modeling/sla-policy/list'), 'PB125 SLA policies')
  const matches = policies.filter((policy) => policy.status === 'ENABLED' &&
    policy.priority === 'P3' && policy.assetServiceStatus === 'SERVICE_EXPIRED' &&
    policy.categoryIds?.some((categoryId) => String(categoryId) === fixture.categoryId))
  assert.equal(matches.length, 1, 'PB125 expired ticket must have exactly one matching SLA')
  assert.equal(id(matches[0].id, 'SLA'), fixture.policyId)
  assert.equal(matches[0].policyCode, fixture.policyCode)

  fixture.ticketId = id(data(await api.postBusiness('/after-sales/ticket/create', {
    title: `${fixture.marker}-EXPIRED-TICKET`, description: fixture.marker,
    sourceChannel: 'MANUAL', priority: 'P3', requiredFinishTime: fixture.finishTime,
    customerId: fixture.customerId, assetId: fixture.assets[1].assetId,
    contactId: fixture.contactId, categoryId: fixture.categoryId, categoryName: fixture.categoryCode,
    urgency: 'NORMAL', importance: 'NORMAL', impactScope: fixture.marker,
    submitterName: `${fixture.marker}-CONTACT`
  }), 'PB125 expired ticket create'), 'ticket')
  const created = await readPb125Ticket(api, fixture)
  assert.equal(created.status, 'PENDING_ACCEPTANCE', 'PB125 expired asset must not reject ticket intake')
  const sla = data(await api.getBusiness(
    `/after-sales/sla/get?ticketId=${fixture.ticketId}`
  ), 'PB125 expired ticket SLA')
  assert.equal(id(sla?.ticketId, 'SLA ticket'), fixture.ticketId)
  assert.equal(id(sla.policyId, 'SLA policy'), fixture.policyId)
  const snapshot = JSON.parse(sla.policySnapshotJson)
  assert.equal(snapshot.policyCode, fixture.policyCode)
  assert.equal(snapshot.assetServiceStatus, 'SERVICE_EXPIRED')
  await api.postBusiness('/after-sales/ticket/process', {
    ticketId: fixture.ticketId, targetStatus: 'PROCESSING',
    processMethod: fixture.marker, resolution: `${fixture.marker} dedicated expired service intake`
  })
  const accepted = await readPb125Ticket(api, fixture)
  assert.equal(accepted.status, 'PROCESSING', 'PB125 expired ticket processing was rejected')
  assert.ok(accepted.firstResponseTime, 'PB125 expired ticket missing persisted first response')
  assert.equal((await readPb125Asset(api, fixture, fixture.assets[1])).asset.serviceStatus, 'SERVICE_EXPIRED',
    'PB125 intake must not silently extend service or clear expiry risk')
  return { ticketId: fixture.ticketId, policyId: fixture.policyId, assetId: fixture.assets[1].assetId }
}

export const cleanupPb125Fixtures = async (api, fixture, readSql = runReadOnlySql) => {
  const errors = []
  const attempt = async (label, operation) => {
    try {
      await operation()
    } catch (error) {
      errors.push(new Error(`${label}: ${error.message}`, { cause: error }))
    }
  }
  let ticketClosed = !fixture.ticketId
  if (fixture.profileCreated && fixture.assets.length !== 2) {
    errors.push(new Error(`PB125 profile ${fixture.customerNo} returned incomplete asset ownership; preserve audit dependencies`))
  }
  if (fixture.ticketId) await attempt('PB125 dedicated ticket', async () => {
    let ticket = await readPb125Ticket(api, fixture)
    if (['PENDING_ACCEPTANCE', 'PROCESSING'].includes(ticket.status)) {
      await api.postBusiness('/after-sales/ticket/process', {
        ticketId: fixture.ticketId, targetStatus: 'PENDING_CUSTOMER_VERIFICATION',
        processMethod: fixture.marker, resolution: `${fixture.marker} dedicated test completed`
      })
      ticket = await readPb125Ticket(api, fixture)
      assert.equal(ticket.status, 'PENDING_CUSTOMER_VERIFICATION')
    }
    if (ticket.status === 'PENDING_CUSTOMER_VERIFICATION') {
      await api.postBusiness('/after-sales/ticket/customer-confirm', {
        ticketId: fixture.ticketId, resolved: true, feedback: `${fixture.marker} dedicated test customer`
      })
      ticket = await readPb125Ticket(api, fixture)
      assert.equal(ticket.status, 'PENDING_EVALUATION')
    }
    if (ticket.status === 'PENDING_EVALUATION') {
      await api.postBusiness(
        `/after-sales/ticket/close?id=${fixture.ticketId}&reason=${encodeURIComponent(fixture.marker)}`
      )
      ticket = await readPb125Ticket(api, fixture)
    }
    assert.equal(ticket.status, 'CLOSED', 'PB125 dedicated ticket is still active')
    ticketClosed = true
  })
  for (const asset of fixture.assets) await attempt(`PB125 asset ${asset.assetId}`, async () => {
    const detail = await readPb125Asset(api, fixture, asset)
    if (detail.asset.serviceStatus !== 'RETIRED') {
      await changePb125AssetStatus(api, fixture, asset, 'RETIRED')
    }
    assert.equal((await readPb125Asset(api, fixture, asset)).asset.serviceStatus, 'RETIRED')
  })
  if (ticketClosed) {
    for (const [type, configId, path, key, expected] of [
      ['SLA_POLICY', fixture.policyId, '/after-sales/modeling/sla-policy/list', 'policyCode', fixture.policyCode],
      ['CATEGORY', fixture.categoryId, '/after-sales/modeling/category/list', 'categoryCode', fixture.categoryCode]
    ]) {
      if (configId) await attempt(`PB125 ${type} ${configId}`, async () => {
        const before = await readConfig(api, path, configId)
        assert.equal(before[key], expected, 'PB125 cleanup config ownership mismatch')
        await api.postBusiness(`/after-sales/modeling/status?configType=${type}&id=${configId}&enabled=false`)
        const after = await readConfig(api, path, configId)
        assert.equal(after[key], expected)
        assert.equal(after.status, 'DISABLED')
      })
    }
  } else {
    errors.push(new Error('PB125 ticket close failed; preserve its dedicated category/SLA dependencies'))
  }
  // Assets/customer/service history have no delete API; retain the material reference for audit.
  if (fixture.materialId) await attempt('PB125 retained material ownership', async () => {
    materialOwner(data(await api.getBusiness(
      `/mes/basMaterial/queryById?id=${fixture.materialId}`
    ), 'PB125 cleanup material'), fixture)
    if (!fixture.profileCreated) {
      const references = await readSql(`SELECT COUNT(*) FROM after_sales_customer_asset
        WHERE tenant_id=1 AND deleted=0 AND material_id='${fixture.materialId}'`)
      if (!references.available) throw new Error(`BLOCKED: PB125 material references unavailable: ${references.reason}`)
      assert.deepEqual(references.rows, [['0']],
        'PB125 material has asset references; preserve it after an uncertain profile-create response')
      await readPb125InventoryFacts(api, fixture, readSql)
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${fixture.materialId}`)
      // This legacy queryById reports absence as code 500; use exact list + raw count instead.
      const missing = data(await api.getBusiness(
        `/mes/basMaterial/list?pageNo=1&pageSize=100&id=${fixture.materialId}`
      ), 'PB125 deleted material list')
      assert.equal(total(missing?.total, 'PB125 deleted material'), 0)
      assert.deepEqual(missing.records, [])
      const absence = await readSql(`SELECT COUNT(*) FROM mes_bas_material
        WHERE tenant_id=1 AND deleted=0 AND id=${fixture.materialId}`)
      if (!absence.available) throw new Error(`BLOCKED: PB125 material absence unavailable: ${absence.reason}`)
      assert.deepEqual(absence.rows, [['0']], 'PB125 deleted material still exists')
    }
  })
  if (errors.length) throw new AggregateError(errors,
    `PB125 cleanup incomplete: ${errors.map((error) => error.message).join('; ')}`)
}
