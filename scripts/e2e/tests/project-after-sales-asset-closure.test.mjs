import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPb125AssetSearch,
  assertPb125AssetOwner,
  assertPb125InventoryUnchanged,
  assertPb125LocalTarget,
  assertPb125ServicePeriod,
  changePb125AssetStatus,
  cleanupPb125Fixtures,
  newPb125Fixture,
  pb125DateOffset,
  preparePb125Assets,
  preparePb125Material,
  readPb125InventoryFacts,
  verifyPb125ExpiredAcceptance,
  verifyPb125StatusEvents
} from '../fixtures/project-after-sales-asset-closure.mjs'

const ok = (data) => ({ code: 0, data, msg: '' })
const fixtureState = () => ({
  ...newPb125Fixture(new Date('2026-10-11T17:30:00Z')),
  materialId: '2109000000000000001', customerId: '2109000000000000002',
  contactId: '2109000000000000003', profileCreated: true,
  assets: [
    { assetId: '2109000000000000004', assetNo: 'PB125-ACTIVE' },
    { assetId: '2109000000000000005', assetNo: 'PB125-EXPIRED' }
  ]
})
const material = (fixture) => ({
  id: fixture.materialId, code: fixture.materialCode, remark: fixture.marker,
  name: fixture.marker, unitId: '10', isEnabled: 1, purchased: 'Y',
  refCost: 0, defaultGradeId: null, allowedGradeIds: []
})
const detail = (fixture, asset, status = 'IN_SERVICE') => ({
  customer: { id: fixture.customerId, customerNo: fixture.customerNo },
  asset: {
    id: asset.assetId, assetNo: asset.assetNo, customerId: fixture.customerId,
    materialId: fixture.materialId, serviceStatus: status, version: 0,
    serviceStartDate: asset.period?.startDate, serviceEndDate: asset.period?.endDate
  },
  servicePeriods: asset.period ? [{ ...asset.period, sourceType: 'MANUAL', status: 'VALID' }] : []
})
const noInventory = async () => ({ available: true, rows: [['inventory-count', '0']] })
const inventoryApi = (fixture, report = { total: 0, list: [] }) => ({
  getBusiness: async (path) => {
    if (path.startsWith('/mes/basMaterial/queryById?')) return ok(material(fixture))
    assert.equal(path,
      `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${fixture.materialId}`)
    return ok(report)
  }
})

test('PB125 rejects non-local targets, tenant changes and alternate ports', () => {
  const target = {
    target: 'local', tenantId: '1',
    apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151'
  }
  assert.doesNotThrow(() => assertPb125LocalTarget(target))
  for (const overrides of [
    { target: 'prod' }, { tenantId: '2' }, { tenantId: '' },
    { apiBase: 'http://example.org:48083' }, { webBase: 'http://127.0.0.1:9152' }
  ]) assert.throws(() => assertPb125LocalTarget({ ...target, ...overrides }))
})

test('PB125 fixture dates use Shanghai days, not UTC or the shell timezone', () => {
  const now = new Date('2026-10-11T17:30:00Z')
  assert.equal(pb125DateOffset(0, now), '2026-10-12')
  assert.equal(pb125DateOffset(-30, now), '2026-09-12')
  const fixture = newPb125Fixture(now)
  assert.equal(fixture.today, '2026-10-12')
  assert.equal(fixture.finishTime, '2026-10-13 18:00:00')
  assert.ok(fixture.expiredPeriod.endDate < fixture.today)
  assert.notEqual(fixture.marker, newPb125Fixture(now).marker)
  assert.ok(fixture.materialCode.length <= 30)
})

test('PB125 cannot create a material without full read-evidence availability', async () => {
  const api = { postBusiness: () => { throw new Error('must not write') } }
  await assert.rejects(preparePb125Material(api, newPb125Fixture(),
    async () => ({ available: false, reason: 'mysql unavailable' })), /BLOCKED.*mysql unavailable/)
  await assert.rejects(preparePb125Material(api, newPb125Fixture(),
    async () => ({ available: true, rows: [] })), /preflight failed/)
})

const materialPreflight = async () => ({
  available: true, rows: [['PB125-read-evidence', '1']]
})

test('PB125 material creation sends purchase timing and a lossless enabled unit, then reads ownership', async () => {
  for (const unitId of [10, '2109000000000000010']) {
    const fixture = newPb125Fixture()
    const calls = []
    let created
    const api = {
      getBusiness: async (path) => {
        calls.push(path)
        if (path === '/mes/basUnit/list/enabled') return ok([{}, { id: unitId }])
        assert.equal(path, `/mes/basMaterial/queryById?id=${fixture.materialId}`)
        return ok({ ...created, id: fixture.materialId })
      },
      postBusiness: async (path, body) => {
        calls.push(path)
        assert.equal(path, '/mes/basMaterial/add')
        assert.deepEqual(body, {
          code: fixture.materialCode, name: fixture.marker, auxName: fixture.marker,
          unitId: String(unitId), inventoryNature: 'STOCK', isMaterial: 'Y',
          isEnabled: 1, purchased: 'Y', saled: 'Y', produced: 'N',
          source: 'purchase', leadTime: 1, bufferTime: 1,
          batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N',
          gradeManaged: 'N', remark: fixture.marker
        })
        created = structuredClone(body)
        return ok('2109000000000000001')
      }
    }
    const result = await preparePb125Material(api, fixture, materialPreflight)
    assert.equal(result.unitId, String(unitId))
    assert.equal(result.leadTime, 1)
    assert.equal(result.bufferTime, 1)
    assert.equal(result.id, fixture.materialId)
    assert.deepEqual(calls, [
      '/mes/basUnit/list/enabled', '/mes/basMaterial/add',
      '/mes/basMaterial/queryById?id=2109000000000000001'
    ])
  }
})

test('PB125 material creation rejects missing or lossy units before writing', async () => {
  for (const units of [[], [{}], [{ id: '' }], [{ id: 0 }],
    [{ id: Number.MAX_SAFE_INTEGER + 1 }]]) {
    const fixture = newPb125Fixture()
    let writes = 0
    await assert.rejects(preparePb125Material({
      getBusiness: async () => ok(units),
      postBusiness: async () => { writes++; return ok('1') }
    }, fixture, materialPreflight))
    assert.equal(writes, 0)
    assert.equal(fixture.materialId, undefined)
  }
})

test('PB125 failed material creation cannot register an ID or proceed to readback', async () => {
  const fixture = newPb125Fixture()
  const reads = []
  await assert.rejects(preparePb125Material({
    getBusiness: async (path) => {
      reads.push(path)
      assert.equal(path, '/mes/basUnit/list/enabled')
      return ok([{ id: '10' }])
    },
    postBusiness: async () => ({ code: 500, msg: '采购类物料必须填写提前期！' })
  }, fixture, materialPreflight), /business failure/)
  assert.equal(fixture.materialId, undefined)
  assert.deepEqual(reads, ['/mes/basUnit/list/enabled'])
})

test('PB125 material ownership and asset ownership require exact independent IDs and markers', () => {
  const fixture = fixtureState()
  const asset = fixture.assets[0]
  const owned = detail(fixture, asset)
  assert.equal(assertPb125AssetOwner(owned, fixture, asset), owned)
  for (const field of ['id', 'customerId', 'materialId', 'assetNo']) {
    const other = structuredClone(owned)
    other.asset[field] = '999'
    assert.throws(() => assertPb125AssetOwner(other, fixture, asset))
  }
  const other = structuredClone(owned)
  other.customer.customerNo = 'shared-customer'
  assert.throws(() => assertPb125AssetOwner(other, fixture, asset))
  const lossy = structuredClone(owned)
  lossy.asset.id = Number(asset.assetId)
  assert.throws(() => assertPb125AssetOwner(lossy, fixture, asset), /lossy ID/)
})

test('PB125 compares independent material facts plus all raw WMS dimensions, not qty>0 lists', async () => {
  const fixture = fixtureState()
  let sql
  const before = await readPb125InventoryFacts(inventoryApi(fixture), fixture, async (statement) => {
    sql = statement
    return noInventory()
  })
  assert.match(sql, /FROM mes_stk_inventory/)
  assert.match(sql, /tenant_id=1 AND deleted=0 AND material_id='2109000000000000001'/)
  for (const column of ['lock_qty', 'hold_qty', 'frozen_qty', 'pending_putaway_qty', 'available_qty']) {
    assert.ok(sql.includes(column))
  }
  assert.doesNotMatch(sql, /qty\s*>|\b(?:LIMIT|UPDATE|DELETE|INSERT)\b/i)
  const after = await readPb125InventoryFacts(inventoryApi(fixture), fixture, noInventory)
  assert.equal(assertPb125InventoryUnchanged(before, after), true)
  const changed = structuredClone(after)
  changed.material.refCost = 1
  assert.throws(() => assertPb125InventoryUnchanged(before, changed), /changed material\/WMS facts/)
  assert.throws(() => assertPb125InventoryUnchanged(null, after), /missing material snapshots/)
})

test('PB125 rejects malformed or partial API stock reports rather than inferring zero', async () => {
  const fixture = fixtureState()
  for (const report of [
    { list: [] }, { total: null, list: [] }, { total: '', list: [] },
    { total: '00', list: [] }, { total: false, list: [] }, { total: -1, list: [] },
    { total: 0.5, list: [] }, { total: Number.MAX_SAFE_INTEGER + 1, list: [] },
    { total: 0 }, { total: 0, list: [{}] }, { total: 1, list: [] }
  ]) await assert.rejects(readPb125InventoryFacts(inventoryApi(fixture, report), fixture, noInventory))
  const exactStringZero = await readPb125InventoryFacts(
    inventoryApi(fixture, { total: '0', list: [] }), fixture, noInventory)
  assert.equal(exactStringZero.reportTotal, 0)
})

test('PB125 search requires exactly one owned active asset and a consistent total', () => {
  const fixture = fixtureState()
  const asset = fixture.assets[0]
  const owned = detail(fixture, asset).asset
  assert.equal(assertPb125AssetSearch(ok({ total: 1, list: [owned] }), fixture, asset), owned)
  for (const page of [
    { total: 0, list: [owned] }, { total: 2, list: [owned] },
    { total: 1, list: [owned, owned] }, { total: 1, list: [] },
    { list: [owned] }, { total: 1, list: [{ ...owned, id: '999' }] },
    { total: 1, list: [{ ...owned, customerId: '999' }] },
    { total: 1, list: [{ ...owned, serviceStatus: 'RETIRED' }] }
  ]) assert.throws(() => assertPb125AssetSearch(ok(page), fixture, asset))
})

test('PB125 raw zero proof is fail-closed on missing counts, hidden rows, bad counts and read failures', async () => {
  const fixture = fixtureState()
  for (const rawRows of [
    [], [['inventory-count', '0'], ['inventory-count', '0']],
    [['inventory-count', 'NULL']], [['inventory-count', '-1']],
    [['inventory-count', '0.5']], [['inventory-count', '9007199254740992']],
    [['inventory-count', '0'], ['inventory-row', '1', fixture.materialId]],
    [['inventory-count', '1']],
    [['inventory-count', '1'], ['inventory-row', '1', fixture.materialId]],
    [['inventory-count', '0'], ['unknown', '0']]
  ]) await assert.rejects(readPb125InventoryFacts(inventoryApi(fixture), fixture,
    async () => ({ available: true, rows: rawRows })))
  await assert.rejects(readPb125InventoryFacts(inventoryApi(fixture), fixture,
    async () => ({ available: false, reason: 'disabled' })), /BLOCKED.*disabled/)
  await assert.rejects(readPb125InventoryFacts(inventoryApi(fixture), fixture,
    async () => { throw new Error('database read failed') }), /database read failed/)
})

test('PB125 stock read cannot target a foreign material or accept service/API errors', async () => {
  const fixture = fixtureState()
  await assert.rejects(readPb125InventoryFacts({
    getBusiness: async () => ok({ ...material(fixture), remark: 'shared' })
  }, fixture, noInventory))
  await assert.rejects(readPb125InventoryFacts({
    getBusiness: async () => ({ code: 500, msg: 'server failure' })
  }, fixture, noInventory), /business failure/)
  await assert.rejects(readPb125InventoryFacts({
    getBusiness: async () => { throw new Error('HTTP 401') }
  }, fixture, noInventory), /HTTP 401/)
})

test('PB125 service-period proof needs exact status, dates, persisted basis and valid history', () => {
  const fixture = fixtureState()
  const asset = { ...fixture.assets[0], period: { ...fixture.activePeriod, sourceNo: 'ORIGINAL' } }
  const initial = detail(fixture, asset)
  assert.doesNotThrow(() => assertPb125ServicePeriod(initial, asset.period, 'IN_SERVICE'))
  for (const override of [
    { serviceStatus: 'PENDING_ARCHIVE' }, { serviceStartDate: '2020-01-01' },
    { serviceEndDate: '2020-01-02' }
  ]) assert.throws(() => assertPb125ServicePeriod({
    ...initial, asset: { ...initial.asset, ...override }
  }, asset.period, 'IN_SERVICE'))
  for (const periods of [[], [{ ...asset.period, status: 'VOID' }]]) {
    assert.throws(() => assertPb125ServicePeriod({
      ...initial, servicePeriods: periods
    }, asset.period, 'IN_SERVICE'), /persisted service-period basis/)
  }
  const appended = structuredClone(initial)
  appended.asset.serviceEndDate = fixture.pagePeriod.endDate
  appended.servicePeriods.push({ ...fixture.pagePeriod, status: 'VALID' })
  assert.doesNotThrow(() => assertPb125ServicePeriod(appended, fixture.pagePeriod, 'IN_SERVICE', {
    startDate: asset.period.startDate, endDate: fixture.pagePeriod.endDate
  }))
})

test('PB125 creates two dedicated profile assets and uses the service-period-derived statuses', async () => {
  const fixture = fixtureState()
  fixture.assets = []
  const ids = ['2109000000000000004', '2109000000000000005']
  const api = {
    postBusiness: async (path, body) => {
      assert.equal(path, '/after-sales/asset/customer-profile/create')
      assert.equal(body.customerNo, fixture.customerNo)
      assert.equal(body.assets.length, 2)
      assert.equal(body.assets[0].materialId, fixture.materialId)
      assert.equal(body.assets[1].servicePeriods[0].endDate, fixture.expiredPeriod.endDate)
      return ok({ customerId: fixture.customerId, primaryContactId: fixture.contactId, assetIds: ids })
    },
    getBusiness: async (path) => {
      const index = ids.findIndex((assetId) => path.endsWith(`id=${assetId}`))
      assert.ok(index >= 0)
      return ok(detail(fixture, fixture.assets[index], fixture.assets[index].status))
    },
    putBusiness: () => { throw new Error('must not manually fake period-derived status') }
  }
  const assets = await preparePb125Assets(api, fixture)
  assert.equal(assets[0].detail.asset.serviceStatus, 'IN_SERVICE')
  assert.equal(assets[1].detail.asset.serviceStatus, 'SERVICE_EXPIRED')
})

test('PB125 explicit status update guards ownership and uses current optimistic-lock version', async () => {
  const fixture = fixtureState()
  const asset = fixture.assets[0]
  let status = 'IN_SERVICE'
  let body
  const api = {
    getBusiness: async () => ok({ ...detail(fixture, asset, status),
      asset: { ...detail(fixture, asset, status).asset, version: 7 } }),
    putBusiness: async (path, payload) => {
      assert.equal(path, '/after-sales/asset/update-status')
      body = payload
      status = payload.serviceStatus
      return ok(true)
    }
  }
  await changePb125AssetStatus(api, fixture, asset, 'SERVICE_SUSPENDED')
  assert.deepEqual(body, {
    id: asset.assetId, version: 7, serviceStatus: 'SERVICE_SUSPENDED',
    reason: `${fixture.marker}:SERVICE_SUSPENDED`
  })
  let writes = 0
  await assert.rejects(changePb125AssetStatus({
    getBusiness: async () => ok({ ...detail(fixture, asset),
      customer: { id: fixture.customerId, customerNo: 'shared' } }),
    putBusiness: () => { writes++ }
  }, fixture, asset, 'RETIRED'))
  assert.equal(writes, 0)
})

const statusRows = (fixture) => [
  [fixture.assets[0].assetId, 'IN_SERVICE', 'SERVICE_SUSPENDED', `${fixture.marker}:SERVICE_SUSPENDED`, '1'],
  [fixture.assets[0].assetId, 'SERVICE_SUSPENDED', 'IN_SERVICE', `${fixture.marker}:IN_SERVICE`, '1'],
  [fixture.assets[0].assetId, 'IN_SERVICE', 'RETIRED', `${fixture.marker}:RETIRED`, '1']
]

test('PB125 status events require exact owned transitions, reasons and real operators', async () => {
  const fixture = fixtureState()
  const read = async () => ({ available: true, rows: statusRows(fixture) })
  assert.deepEqual(await verifyPb125StatusEvents(fixture, fixture.assets[0], read), statusRows(fixture))
  for (const invalid of [
    [], statusRows(fixture).slice(1),
    statusRows(fixture).map((row, index) => index === 0 ? ['999', ...row.slice(1)] : row),
    statusRows(fixture).map((row, index) => index === 0 ? [...row.slice(0, 3), 'shared', '1'] : row),
    statusRows(fixture).map((row, index) => index === 0 ? [...row.slice(0, 4), '0'] : row)
  ]) await assert.rejects(verifyPb125StatusEvents(fixture, fixture.assets[0],
    async () => ({ available: true, rows: invalid })))
})

const acceptanceApi = (fixture, overrides = {}) => {
  fixture.assets[1].period = { ...fixture.expiredPeriod, sourceNo: fixture.assets[1].assetNo }
  let status = 'PENDING_ACCEPTANCE'
  const calls = []
  const api = {
    postBusiness: async (path, body) => {
      calls.push({ path, body })
      if (path.endsWith('/category/create')) return ok('21')
      if (path.endsWith('/sla-policy/create')) {
        assert.equal(body.assetServiceStatus, 'SERVICE_EXPIRED')
        assert.deepEqual(body.categoryIds, ['21'])
        return ok('22')
      }
      if (path.endsWith('/ticket/create')) {
        assert.equal(body.assetId, fixture.assets[1].assetId)
        assert.equal(body.customerId, fixture.customerId)
        assert.equal(body.categoryId, '21')
        return ok('23')
      }
      assert.equal(path, '/after-sales/ticket/process')
      status = body.targetStatus
      return ok(true)
    },
    getBusiness: async (path) => {
      if (path.startsWith('/after-sales/asset/get?')) {
        return ok(detail(fixture, fixture.assets[1], overrides.assetStatus || 'SERVICE_EXPIRED'))
      }
      if (path.startsWith('/after-sales/modeling/category/get?')) return ok({
        id: '21', categoryCode: fixture.categoryCode, status: 'ENABLED',
        leafFlag: true, applicableServiceStatus: 'SERVICE_EXPIRED'
      })
      if (path === '/after-sales/modeling/sla-policy/list') {
        const policies = [{
          id: '22', policyCode: fixture.policyCode, priority: 'P3', status: 'ENABLED',
          assetServiceStatus: 'SERVICE_EXPIRED', categoryIds: ['21']
        }]
        if (overrides.duplicatePolicy) policies.push({ ...policies[0], id: '24' })
        return ok(policies)
      }
      if (path.startsWith('/after-sales/sla/get?')) return ok({
        ticketId: '23', policyId: '22', policySnapshotJson: JSON.stringify({
          policyCode: fixture.policyCode, assetServiceStatus: overrides.slaStatus || 'SERVICE_EXPIRED'
        })
      })
      assert.equal(path, '/after-sales/ticket/get?id=23')
      return ok({
        id: '23', customerId: fixture.customerId,
        assetId: overrides.ticketAssetId || fixture.assets[1].assetId,
        categoryId: '21', title: `${fixture.marker}-EXPIRED-TICKET`,
        status: overrides.ticketStatus || status,
        firstResponseTime: status === 'PROCESSING' ? '2026-10-12T09:00:00' : null
      })
    }
  }
  return { api, calls }
}

test('PB125 accepts an expired asset via a uniquely matching real SLA and persisted processing state', async () => {
  const fixture = fixtureState()
  const { api, calls } = acceptanceApi(fixture)
  assert.deepEqual(await verifyPb125ExpiredAcceptance(api, fixture), {
    ticketId: '23', policyId: '22', assetId: fixture.assets[1].assetId
  })
  assert.equal(calls.filter((call) => call.path === '/after-sales/ticket/create').length, 1)
})

test('PB125 expired acceptance cannot pass with duplicate SLA, wrong asset/state or a forged SLA snapshot', async () => {
  for (const overrides of [
    { duplicatePolicy: true }, { assetStatus: 'IN_SERVICE' },
    { ticketAssetId: '999' }, { ticketStatus: 'CANCELLED' }, { slaStatus: 'IN_SERVICE' }
  ]) {
    const fixture = fixtureState()
    const { api } = acceptanceApi(fixture, overrides)
    await assert.rejects(verifyPb125ExpiredAcceptance(api, fixture))
  }
  const fixture = fixtureState()
  const { api } = acceptanceApi(fixture)
  const post = api.postBusiness
  api.postBusiness = (path, body) => path.endsWith('/ticket/create')
    ? Promise.reject(new Error('HTTP 500')) : post(path, body)
  await assert.rejects(verifyPb125ExpiredAcceptance(api, fixture), /HTTP 500/)
})

const cleanupApi = (fixture, { failedAssetId, foreignAssetId, closeFails = false } = {}) => {
  fixture.categoryId = '21'
  fixture.categoryCode = `${fixture.marker}-CATEGORY`
  fixture.policyId = '22'
  fixture.policyCode = `${fixture.marker}-SLA`
  fixture.ticketId = '23'
  const calls = []
  const statuses = new Map(fixture.assets.map((asset) => [asset.assetId, 'IN_SERVICE']))
  const disabled = new Set()
  let ticketStatus = 'PROCESSING'
  const api = {
    getBusiness: async (path) => {
      if (path.startsWith('/mes/basMaterial/queryById?')) return ok(material(fixture))
      if (path.startsWith('/after-sales/asset/get?')) {
        const asset = fixture.assets.find((asset) => path.endsWith(`id=${asset.assetId}`))
        assert.ok(asset)
        const response = detail(fixture, asset, statuses.get(asset.assetId))
        if (asset.assetId === foreignAssetId) response.asset.materialId = '999'
        return ok(response)
      }
      if (path === '/after-sales/ticket/get?id=23') return ok({
        id: '23', customerId: fixture.customerId, assetId: fixture.assets[1].assetId,
        categoryId: '21', title: `${fixture.marker}-EXPIRED-TICKET`, status: ticketStatus
      })
      const type = path.includes('/sla-policy/') ? 'SLA_POLICY' : 'CATEGORY'
      return ok([type === 'CATEGORY'
        ? { id: '21', categoryCode: fixture.categoryCode, status: disabled.has(type) ? 'DISABLED' : 'ENABLED' }
        : { id: '22', policyCode: fixture.policyCode, status: disabled.has(type) ? 'DISABLED' : 'ENABLED' }])
    },
    postBusiness: async (path, body) => {
      calls.push({ path, body })
      if (path === '/after-sales/ticket/process') ticketStatus = body.targetStatus
      else if (path === '/after-sales/ticket/customer-confirm') {
        assert.equal(ticketStatus, 'PENDING_CUSTOMER_VERIFICATION')
        ticketStatus = 'PENDING_EVALUATION'
      } else if (path.startsWith('/after-sales/ticket/close?')) {
        assert.equal(ticketStatus, 'PENDING_EVALUATION')
        if (closeFails) throw new Error('HTTP 401 close')
        ticketStatus = 'CLOSED'
      } else {
        assert.equal(ticketStatus, 'CLOSED', 'must close ticket before disabling its dependencies')
        disabled.add(new URL(`http://local${path}`).searchParams.get('configType'))
      }
      return ok(true)
    },
    putBusiness: async (path, body) => {
      calls.push({ path, body })
      assert.equal(path, '/after-sales/asset/update-status')
      if (body.id === failedAssetId) throw new Error('HTTP 401 retirement')
      statuses.set(body.id, body.serviceStatus)
      return ok(true)
    },
    deleteBusiness: () => { throw new Error('audit material must not be deleted') }
  }
  return { api, calls }
}

test('PB125 cleanup follows formal ticket transitions, retires both owned assets and rereads disabled dependencies', async () => {
  const fixture = fixtureState()
  const { api, calls } = cleanupApi(fixture)
  await cleanupPb125Fixtures(api, fixture)
  assert.deepEqual(calls.slice(0, 3).map((call) => call.path.split('?')[0]), [
    '/after-sales/ticket/process', '/after-sales/ticket/customer-confirm', '/after-sales/ticket/close'
  ])
  assert.equal(calls.filter((call) => call.path === '/after-sales/asset/update-status').length, 2)
  assert.equal(calls.filter((call) => call.path.includes('/modeling/status?')).length, 2)
})

test('PB125 cleanup continues after first retirement failure and exposes exact errors', async () => {
  const fixture = fixtureState()
  const { api, calls } = cleanupApi(fixture, { failedAssetId: fixture.assets[0].assetId })
  await assert.rejects(cleanupPb125Fixtures(api, fixture), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /HTTP 401 retirement/)
    return true
  })
  assert.ok(calls.some((call) => call.body?.id === fixture.assets[1].assetId))
  assert.equal(calls.filter((call) => call.path.includes('/modeling/status?')).length, 2)
})

test('PB125 cleanup never retires a foreign asset and preserves SLA/category when ticket closure fails', async () => {
  const fixture = fixtureState()
  const { api, calls } = cleanupApi(fixture, {
    foreignAssetId: fixture.assets[0].assetId, closeFails: true
  })
  await assert.rejects(cleanupPb125Fixtures(api, fixture), (error) => {
    assert.match(error.message, /HTTP 401 close/)
    assert.match(error.message, /preserve its dedicated category\/SLA/)
    assert.match(error.message, /PB125 asset/)
    return true
  })
  assert.ok(!calls.some((call) => call.body?.id === fixture.assets[0].assetId))
  assert.ok(calls.some((call) => call.body?.id === fixture.assets[1].assetId))
  assert.ok(!calls.some((call) => call.path.includes('/modeling/status?')))
})

test('PB125 preparation failure deletes only an unused owned material and proves exact absence without accepting 500', async () => {
  for (const remaining of [false, true]) {
    const fixture = fixtureState()
    fixture.assets = []
    fixture.profileCreated = false
    const calls = []
    const api = {
      ...inventoryApi(fixture),
      deleteBusiness: async (path) => { calls.push(path); return ok(true) }
    }
    const get = api.getBusiness
    api.getBusiness = (path) => path.startsWith('/mes/basMaterial/list?')
      ? Promise.resolve(ok({ total: remaining ? 1 : 0, records: remaining ? [material(fixture)] : [] }))
      : get(path)
    const readSql = async (statement) => /FROM (?:mes_bas_material|after_sales_customer_asset)/.test(statement)
      ? { available: true, rows: [['0']] } : noInventory()
    if (remaining) await assert.rejects(cleanupPb125Fixtures(api, fixture, readSql),
      /PB125 cleanup incomplete/)
    else await cleanupPb125Fixtures(api, fixture, readSql)
    assert.deepEqual(calls, [`/mes/basMaterial/delete?id=${fixture.materialId}`])
  }
})

test('PB125 uncertain profile-create failure cannot delete a material with retained asset references', async () => {
  const fixture = fixtureState()
  fixture.profileCreated = false
  fixture.assets = []
  let deletes = 0
  const api = { ...inventoryApi(fixture), deleteBusiness: async () => { deletes++ } }
  await assert.rejects(cleanupPb125Fixtures(api, fixture,
    async () => ({ available: true, rows: [['1']] })), /has asset references.*preserve it/)
  assert.equal(deletes, 0)
})
