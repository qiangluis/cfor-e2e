import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WMS_FIXTURE_MARK,
  assertLocalWmsWriteTarget,
  fixtureCode,
  fixtureToken,
  isOwnedFixture,
  isWmsWriteEnabled,
  pageRows,
  cleanupWmsFixtures
} from '../lib/wms-fixtures.mjs'

test('WMS write fixtures require exact opt-in and local tenant target', () => {
  assert.equal(isWmsWriteEnabled({ CFOR_E2E_WRITE_FIXTURES: 'true' }), true)
  assert.equal(isWmsWriteEnabled({ CFOR_E2E_WRITE_FIXTURES: '1' }), false)
  assert.throws(() => assertLocalWmsWriteTarget({ tenantId: '2' }), /租户 1/)
  assert.doesNotThrow(() => assertLocalWmsWriteTarget({ tenantId: '1', tenantName: 'CFOR 标准平台' }))
})

test('WMS fixture ownership is token and marker scoped', () => {
  const token = fixtureToken('TEST')
  assert.match(token, /^E2E-WMS-TEST-/)
  assert.equal(isOwnedFixture({ code: `${token}-WH-1`, name: 'warehouse' }, token), true)
  assert.equal(isOwnedFixture({ code: 'shared', name: 'shared' }, token), false)
  assert.equal(isOwnedFixture({ remark: WMS_FIXTURE_MARK }, 'other-token'), true)
})

test('WMS fixture codes are stable, distinct, and within the 32 character limit', () => {
  const token = fixtureToken('CODE')
  const codes = ['WH', 'AR', 'LC', 'MT'].map((kind) => fixtureCode(token, kind, 1))
  assert.deepEqual(fixtureCode(token, 'WH', 1), fixtureCode(token, 'WH', 1))
  assert.equal(new Set(codes).size, codes.length)
  assert.ok(codes.every((code) => code.length <= 32))
  assert.notEqual(fixtureCode(token, 'WH', 1), fixtureCode(token, 'WH', 2))
})

test('WMS stock IO bill numbers are short and deterministic per fixture kind', () => {
  const token = fixtureToken('IO')
  const billNo = fixtureCode(token, 'IO', 106)
  assert.equal(billNo, fixtureCode(token, 'IO', 106))
  assert.ok(billNo.length <= 32)
})

test('WMS pageRows rejects malformed page and preserves empty valid page', () => {
  assert.deepEqual(pageRows({ code: 0, data: { list: [] }}).rows, [])
  assert.deepEqual(pageRows({ code: 0, data: { records: [{ id: '1' }] }}).rows, [{ id: '1' }])
  assert.throws(() => pageRows({ code: 0, data: {} }), /未返回数组/)
})

test('cleanup preserves effective opening dependencies without attempting forbidden deletes', async () => {
  const calls = []
  const caseRecord = {
    fixtures: [
      { kind: 'warehouse', id: 'wh-1' },
      { kind: 'area', id: 'area-1' },
      { kind: 'location', id: 'loc-1' },
      { kind: 'material', id: 'mat-1', code: 'MT-1', token: 'fixture-token' },
      {
        kind: 'opening', id: 'opening-1', status: 'EFFECTIVE',
        warehouseId: 'wh-1', areaId: 'area-1', locationId: 'loc-1', materialId: 'mat-1'
      }
    ],
    notes: []
  }
  const api = {
    getBusiness: async (path) => {
      calls.push(`GET ${path}`)
      return { code: 0, data: { id: 'opening-1', isEffective: 1 } }
    },
    deleteBusiness: async (path) => {
      calls.push(`DELETE ${path}`)
      throw new Error(`unexpected delete: ${path}`)
    }
  }
  await cleanupWmsFixtures(api, caseRecord)
  assert.equal(calls.filter((call) => call.startsWith('DELETE ')).length, 0)
  assert.ok(caseRecord.notes.some((note) => note.includes('库存依赖')))
})

test('cleanup protects dependencies of effective or non-draft stock, transfer, and borrow fixtures', async () => {
  const calls = []
  const caseRecord = {
    fixtures: [
      { kind: 'warehouse', id: 'wh-1' },
      { kind: 'area', id: 'area-1' },
      { kind: 'location', id: 'loc-1' },
      { kind: 'material', id: 'mat-1', code: 'MT-1', token: 'fixture-token' },
      {
        kind: 'stockIo', id: 'stock-1', warehouseId: 'wh-1', areaId: 'area-1',
        locationId: 'loc-1', materialId: 'mat-1'
      },
      {
        kind: 'transfer', id: 'transfer-1', warehouseId: 'wh-1', areaId: 'area-1',
        locationId: 'loc-1', targetWarehouseId: 'wh-2', targetAreaId: 'area-2',
        targetLocationId: 'loc-2', materialId: 'mat-1'
      },
      {
        kind: 'borrow', id: 'borrow-1', warehouseId: 'wh-1', areaId: 'area-1',
        locationId: 'loc-1', materialId: 'mat-1'
      }
    ],
    notes: []
  }
  const api = {
    getBusiness: async (path) => {
      calls.push(`GET ${path}`)
      if (path.includes('/mes/stkIo/queryById')) {
        return { code: 0, data: { id: 'stock-1', billStage: '34', isEffective: 1, isVoided: 0 } }
      }
      if (path.includes('/wms/transfer-bill/get')) {
        return { code: 0, data: { id: 'transfer-1', transferStatus: 'UNDER_EXECUTION', isEffective: 0 } }
      }
      return { code: 0, data: { id: 'borrow-1', borrowStatus: 'APPROVING', isEffective: 0 } }
    },
    deleteBusiness: async (path) => {
      calls.push(`DELETE ${path}`)
      throw new Error(`unexpected delete: ${path}`)
    }
  }
  await cleanupWmsFixtures(api, caseRecord)
  assert.equal(calls.filter((call) => call.startsWith('DELETE ')).length, 0)
  assert.equal(calls.filter((call) => call.startsWith('GET ')).length, 3)
  assert.ok(caseRecord.notes.some((note) => note.includes('业务夹具')))
})
