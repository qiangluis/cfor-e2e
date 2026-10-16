import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __internal,
  materialCommercialValidationCheckNames,
  materialCommercialValidationContracts,
  materialCommercialValidationSemantics,
  verifyMaterialCommercialValidationClosure
} from '../fixtures/material-commercial-validation-closure.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

const ok = (data) => ({ code: 0, data })
const records = (rows = []) => ok({ total: rows.length, records: rows })

test('PB032 commercial contracts bind the exact capability domain code and do not negate legal non-physical order semantics', () => {
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(M-1)不能用于采购订单：未启用可采购能力', data: null },
    materialCommercialValidationContracts.purchaseDisabled
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100007, msg: '存货(M-2)不能用于销售订单：未启用可销售能力', data: null },
    materialCommercialValidationContracts.saleDisabled
  ), true)
  assert.equal(materialCommercialValidationSemantics.purchaseOrderAllowsService, true)
  assert.equal(materialCommercialValidationSemantics.saleOrderDoesNotRequireStockNature, true)
})

test('commercial order payload has real draft fields but never forges status or inventory facts', () => {
  const payload = __internal.orderBody({
    kind: 'purchase', billNo: 'E2E-BILL', marker: 'E2E-MARK', partnerId: '12',
    material: { id: '22', unitId: '33' }
  })
  assert.equal(payload.supplierId, '12')
  assert.equal(payload.items[0].entryNo, 1)
  assert.equal(payload.items[0].productId, '22')
  for (const forbidden of ['status', 'isEffective', 'warehouseId', 'wareAreaId', 'wareLocationId', 'stockIoType']) {
    assert.equal(forbidden in payload, false)
    assert.equal(forbidden in payload.items[0], false)
  }
})

test('commercial material ownership and snapshots include legal source and production capability', () => {
  const material = {
    id: '22', code: 'E2E-MATERIAL', marker: 'E2E-MARK', unitId: '33',
    purchased: 'N', saled: 'Y', source: 'manufacture', produced: 'Y'
  }
  const row = { ...__internal.materialBody(material), id: material.id }
  assert.equal(__internal.ownsMaterial(row, material), true)
  assert.equal(__internal.ownsMaterial({ ...row, source: 'mixed' }, material), false)
  assert.equal(__internal.ownsMaterial({ ...row, produced: 'N' }, material), false)
  assert.equal(__internal.materialSnapshot(row).source, 'manufacture')
  assert.equal(__internal.materialSnapshot(row).produced, 'Y')
})

test('commercial order pages accept both formal envelopes but reject missing rows and totals', async () => {
  for (const key of ['list', 'records']) {
    const api = { getBusiness: async () => ok({ total: 0, [key]: [] }) }
    assert.deepEqual(await __internal.readOrderPage(api, 'purchase', 'E2E-BILL', '22', 'page'),
      { total: 0, rows: [] })
  }
  for (const data of [{ total: 0 }, { list: [] }, { list: [], total: -1 }]) {
    const api = { getBusiness: async () => ok(data) }
    await assert.rejects(() => __internal.readOrderPage(api, 'purchase', 'E2E-BILL', '22', 'page'))
  }
})

test('commercial closure uses formal order APIs, exact rejection, before/after zero pages, and cleans only owned materials', async () => {
  const calls = []
  const state = { nextId: 900, materials: new Map(), deleted: [] }
  const api = {
    async getBusiness (pathname) {
      calls.push(['GET', pathname])
      const url = new URL(pathname, 'http://local')
      if (url.pathname === '/base/partner/get') {
        const id = url.searchParams.get('id')
        return ok(id === '11'
          ? { id, name: 'supplier', status: 'ACTIVE', supplierEnabled: true }
          : { id, name: 'customer', status: 'ACTIVE', customerEnabled: true })
      }
      if (url.pathname === '/mes/basMaterial/queryById') return ok(state.materials.get(url.searchParams.get('id')))
      if (url.pathname === '/mes/basMaterial/list') {
        const code = url.searchParams.get('code')
        return records([...state.materials.values()].filter((row) => row.code === code))
      }
      if (url.pathname.endsWith('/page')) return records([])
      throw new Error(`unexpected GET ${pathname}`)
    },
    async postBusiness (pathname, body) {
      calls.push(['POST-BUSINESS', pathname, body])
      assert.equal(pathname, '/mes/basMaterial/add')
      const id = String(++state.nextId)
      state.materials.set(id, { ...body, id })
      return ok(id)
    },
    async post (pathname, body, options) {
      calls.push(['POST', pathname, body, options])
      const isPurchase = pathname === '/erp/purchase-order/create'
      return isPurchase
        ? { code: 2010100007, msg: `存货(${body.items[0].productId})不能用于采购订单：未启用可采购能力`, data: null }
        : { code: 2010100007, msg: `存货(${body.items[0].productId})不能用于销售订单：未启用可销售能力`, data: null }
    },
    async deleteBusiness (pathname) {
      calls.push(['DELETE-BUSINESS', pathname])
      const id = new URL(pathname, 'http://local').searchParams.get('id')
      state.deleted.push(id)
      state.materials.delete(id)
      return ok(true)
    }
  }
  const record = { checks: [], evidence: [], fixtures: [] }
  await verifyMaterialCommercialValidationClosure({
    api, caseRecord: record, unit: { id: '10' }, supplier: { id: '11' }, customer: { id: '12' }
  })
  assert.deepEqual(new Set(state.deleted), new Set(['901', '902']))
  assert.equal(state.materials.size, 0)
  assert.equal(record.checks.every((check) => check.passed), true)
  assert.deepEqual(record.checks.map((check) => check.name), [
    materialCommercialValidationCheckNames.purchase,
    materialCommercialValidationCheckNames.sale,
    materialCommercialValidationCheckNames.cleanup
  ])
  const posts = calls.filter(([method]) => method === 'POST')
  assert.deepEqual(posts.map(([, pathname]) => pathname), [
    '/erp/purchase-order/create', '/erp/sale-order/create'
  ])
  assert.equal(posts.every(([, , body]) => !('status' in body) && !('stockIoType' in body)), true)
  assert.equal(posts.every(([, , , options]) => options.expectedBusinessRejection.code === 2010100007), true)
  assert.equal(calls.some(([, pathname]) => pathname.includes('/erp/purchase-order/page?')), true)
  assert.equal(calls.some(([, pathname]) => pathname.includes('/erp/sale-order/page?')), true)
  const materials = calls.filter(([method]) => method === 'POST-BUSINESS').map(([, , body]) => body)
  assert.deepEqual(materials.map(({ source, purchased, produced, saled }) => ({ source, purchased, produced, saled })), [
    { source: 'manufacture', purchased: 'N', produced: 'Y', saled: 'Y' },
    { source: 'purchase', purchased: 'Y', produced: 'N', saled: 'N' }
  ])
})

test('commercial closure fails rather than accepting a non-domain rejection, while still cleaning every owned material', async () => {
  const state = { nextId: 20, materials: new Map(), deleted: [] }
  let orderPost = 0
  const api = {
    async getBusiness (pathname) {
      const url = new URL(pathname, 'http://local')
      if (url.pathname === '/base/partner/get') {
        const id = url.searchParams.get('id')
        return ok(id === '11'
          ? { id, status: 'ACTIVE', supplierEnabled: true }
          : { id, status: 'ACTIVE', customerEnabled: true })
      }
      if (url.pathname === '/mes/basMaterial/queryById') return ok(state.materials.get(url.searchParams.get('id')))
      if (url.pathname === '/mes/basMaterial/list') {
        const code = url.searchParams.get('code')
        return records([...state.materials.values()].filter((row) => row.code === code))
      }
      if (url.pathname.endsWith('/page')) return records([])
      throw new Error(`unexpected GET ${pathname}`)
    },
    async postBusiness (_pathname, body) {
      const id = String(++state.nextId)
      state.materials.set(id, { ...body, id })
      return ok(id)
    },
    async post () {
      orderPost += 1
      return orderPost === 1
        ? { code: 2010100007, msg: '存货(X)不能用于采购订单：未启用可采购能力', data: null }
        : { code: 500, msg: '系统异常', data: null }
    },
    async deleteBusiness (pathname) {
      const id = new URL(pathname, 'http://local').searchParams.get('id')
      state.deleted.push(id)
      state.materials.delete(id)
      return ok(true)
    }
  }
  const record = { checks: [] }
  await assert.rejects(() => verifyMaterialCommercialValidationClosure({
    api, caseRecord: record, unit: '10', supplier: '11', customer: '12'
  }), /销售订单引用未启用可销售专属物料被精确拒绝/)
  assert.deepEqual(new Set(state.deleted), new Set(['21', '22']))
  assert.equal(state.materials.size, 0)
  assert.equal(record.checks.at(-1).name, materialCommercialValidationCheckNames.cleanup)
  assert.equal(record.checks.at(-1).passed, true)
})
