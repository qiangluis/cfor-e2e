import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hydrateWarehouseFixture, locationFacts, verifyLocationOccupied
} from '../fixtures/wms-location-closure.mjs'

test('warehouse tree without a code is hydrated from owned formal detail', async () => {
  const fixture = { token: 'RUN', warehouse: { id: '9007199254740993', name: 'Tree label' } }
  const record = { fixtures: [{
    kind: 'warehouse', id: fixture.warehouse.id, code: 'OWNED-WH', token: 'RUN'
  }] }
  const api = { getBusiness: async (path) => {
    assert.equal(path, `/mes/wmsWareHouse/queryById?id=${fixture.warehouse.id}`)
    return { code: 0, data: { id: fixture.warehouse.id, code: 'OWNED-WH', mark: 'fixture RUN' } }
  } }
  const hydrated = await hydrateWarehouseFixture(api, record, fixture)
  assert.equal(hydrated.warehouse.code, 'OWNED-WH')
  assert.equal(hydrated.warehouse.id, fixture.warehouse.id)
  assert.equal(fixture.warehouse.code, undefined)
})

test('warehouse hydration rejects foreign ownership or mismatched codes', async () => {
  const fixture = { token: 'RUN', warehouse: { id: '9007199254740993' } }
  const record = { fixtures: [{
    kind: 'warehouse', id: fixture.warehouse.id, code: 'OWNED-WH', token: 'RUN'
  }] }
  for (const detail of [
    { id: fixture.warehouse.id, code: 'FOREIGN-WH', mark: 'RUN' },
    { id: fixture.warehouse.id, code: 'OWNED-WH', mark: 'OTHER' },
    { id: '9007199254740995', code: 'OWNED-WH', mark: 'RUN' }
  ]) {
    await assert.rejects(hydrateWarehouseFixture({
      getBusiness: async () => ({ code: 0, data: detail })
    }, record, fixture), /编码和所有权/)
  }
  await assert.rejects(hydrateWarehouseFixture({
    getBusiness: async () => { throw new Error('must not read an unregistered warehouse') }
  }, { fixtures: [] }, fixture), /登记的 ID 和 token/)
})

test('location facts reject absent records and preserve all fields', () => {
  assert.throws(() => locationFacts(null), /原记录/)
  assert.deepEqual(locationFacts({ houseId: '9007199254740993', id: '9007199254740995' }), {
    houseId: '9007199254740993', id: '9007199254740995'
  })
})

test('occupancy rejection cannot pass if the original location changes', async () => {
  const record = { checks: [] }
  const row = { id: '9007199254740993', houseId: 'wh1', areaId: 'a1', locationCode: 'LC' }
  let reads = 0
  const rejection = { code: 1001001003, msg: '库位已被库存、未完成任务或未完成单据引用' }
  const api = {
    getBusiness: async () => ({ code: 0, data: { ...row, areaId: reads++ ? 'mutated' : 'a1' } }),
    delete: async () => rejection,
    put: async (path, payload) => {
      assert.equal(payload.id, row.id)
      return rejection
    }
  }
  await verifyLocationOccupied(api, record, {
    location: { id: row.id, locationCode: 'LC', locationName: 'fixture' }
  }, { warehouse: { id: 'wh2' }, area: { id: 'a2' } }, '库存占用')
  assert.equal(record.checks.every((check) => check.passed === false), true)
})

test('exact domain rejection and unchanged full record pass both probes', async () => {
  const record = { checks: [] }
  const row = { id: '9007199254740993', houseId: 'wh1', areaId: 'a1', locationCode: 'LC' }
  const rejection = { code: 1001001003, msg: '库位已被库存、未完成任务或未完成单据引用' }
  const api = {
    getBusiness: async () => ({ code: 0, data: row }),
    delete: async () => rejection,
    put: async () => rejection
  }
  await verifyLocationOccupied(api, record, {
    location: { id: row.id, locationCode: 'LC', locationName: 'fixture' }
  }, { warehouse: { id: 'wh2' }, area: { id: 'a2' } }, '装箱占用')
  assert.equal(record.checks.length, 2)
  assert.equal(record.checks.every((check) => check.passed), true)
})
