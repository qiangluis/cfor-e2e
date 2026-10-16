import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assertWmsQcScope,
  buildPurchaseInboundPayload,
  buildPurchaseReturnPayload,
  buildSaleReturnPayload,
  capturePageEvidence,
  mapWmsQcCatalogAssertions,
  verifyWmsQcFlowBalance,
  verifyWmsQcLowPrivilege,
  verifyWmsQcTenantIsolation,
  verifyWmsQcTransactionRollback,
  WMS_QC_CLOSURE_CASES,
  WMS_QC_DEFERRED_CONTRACTS,
  WMS_QC_FORMAL_CONTRACTS,
  wmsQcMarker
} from '../fixtures/wms-qc-closure.mjs'
import { __internal as fixtureInternal } from '../fixtures/wms-qc-closure.mjs'
import { caseErrorStatus, caseOutcome } from '../lib/report.mjs'
import { runCase } from '../suites/wms-quality.mjs'

const localSettings = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { name: 'cfor_admin_standard' }
}

const ok = (data) => ({ code: 0, data })
const rejection = (msg = '业务拒绝') => ({ code: 1001000001, msg })
const caseRecord = () => ({ checks: [], notes: [], evidence: [], fixtures: [] })

const originalFetch = globalThis.fetch
test.before(() => {
  globalThis.fetch = async () => { throw new Error('Offline WMS-QC unit tests forbid network access') }
})
test.after(() => { globalThis.fetch = originalFetch })

const pageHarness = (body = '', options = {}) => {
  let currentUrl = 'about:blank'
  const calls = []
  const page = {
    url: () => currentUrl,
    getByPlaceholder: (placeholder, settings) => ({
      fill: async (value) => { calls.push(['fill', placeholder, value, settings]) },
      press: async (key) => { calls.push(['press', placeholder, key]) }
    }),
    getByText: (value, settings) => ({ value, ...settings }),
    locator: (selector) => {
      if (selector === 'body') return { innerText: async () => typeof body === 'function' ? body(currentUrl) : body }
      assert.equal(selector, '.vxe-body--row, .el-table__row')
      return {
        filter: (match) => ({ first: () => ({
          waitFor: async (settings) => {
            calls.push(['row', match, settings])
            if (options.rowValues && !options.rowValues.includes(match.has?.value || match.hasText)) {
              throw new Error('no exact owned row')
            }
          }
        }) })
      }
    }
  }
  return {
    page,
    calls,
    openRoute: async (_page, route, settings) => {
      calls.push(['open', route, settings])
      currentUrl = `http://127.0.0.1:9151${route}`
    },
    saveScreenshot: async (_page, _outputDir, name) => {
      calls.push(['screenshot', name])
      return `/tmp/${name}.png`
    }
  }
}

const formalIds = {
  supplierId: '9223372036854775801',
  customerId: '9223372036854775802',
  purchaseOrderId: '9223372036854775803',
  saleOrderId: '9223372036854775804',
  orderItemId: '9223372036854775805',
  materialId: '9223372036854775806',
  unitId: '9223372036854775807',
  warehouseId: '9223372036854775808',
  areaId: '9223372036854775809',
  locationId: '9223372036854775810',
  accountId: '9223372036854775811'
}

test('WMS-QC dedicated fixture is limited to the requested cases and local target', () => {
  assert.deepEqual(WMS_QC_CLOSURE_CASES, [
    'WMS-QC-001',
    'WMS-QC-002',
    'WMS-QC-003',
    'WMS-QC-005',
    'WMS-QC-009',
    'WMS-QC-010'
  ])
  assert.doesNotThrow(() => assertWmsQcScope(localSettings))
  for (const change of [
    { target: 'production' },
    { tenantId: '2' },
    { tenantName: '福奇科技' },
    { apiBase: 'http://127.0.0.1:48082' },
    { webBase: 'http://127.0.0.1:9152' }
  ]) {
    assert.throws(() => assertWmsQcScope({ ...localSettings, ...change }), /BLOCKED:/)
  }
})

test('formal purchase inbound and return payloads keep source, account, and stock dimensions', () => {
  const marker = wmsQcMarker('WMS-QC-001')
  const inbound = buildPurchaseInboundPayload({
    marker,
    supplierId: formalIds.supplierId,
    purchaseOrderId: formalIds.purchaseOrderId,
    orderItemId: formalIds.orderItemId,
    materialId: formalIds.materialId,
    unitId: formalIds.unitId,
    warehouseId: formalIds.warehouseId,
    accountId: formalIds.accountId
  })
  assert.equal(inbound.businessType, 'NORMAL')
  assert.equal(inbound.orderId, formalIds.purchaseOrderId)
  assert.equal(inbound.accountId, formalIds.accountId)
  assert.equal(inbound.items[0].warehouseId, formalIds.warehouseId)
  assert.equal(inbound.items[0].count, 1)

  const purchaseReturn = buildPurchaseReturnPayload({
    marker,
    supplierId: formalIds.supplierId,
    purchaseOrderId: formalIds.purchaseOrderId,
    orderItemId: formalIds.orderItemId,
    materialId: formalIds.materialId,
    unitId: formalIds.unitId,
    warehouseId: formalIds.warehouseId,
    areaId: formalIds.areaId,
    locationId: formalIds.locationId,
    accountId: formalIds.accountId
  })
  assert.equal(purchaseReturn.srcBillType, 'PurOrder')
  assert.equal(purchaseReturn.items[0].srcBillType, 'PurOrder')
  assert.equal(WMS_QC_FORMAL_CONTRACTS.purchaseReturn.wmsType, '301')
  assert.equal(WMS_QC_FORMAL_CONTRACTS.purchaseReturn.direction, 'OUT')

  const saleReturn = buildSaleReturnPayload({
    marker,
    customerId: formalIds.customerId,
    saleOrderId: formalIds.saleOrderId,
    orderItemId: formalIds.orderItemId,
    materialId: formalIds.materialId,
    unitId: formalIds.unitId,
    warehouseId: formalIds.warehouseId,
    areaId: formalIds.areaId,
    locationId: formalIds.locationId,
    accountId: formalIds.accountId
  })
  assert.equal(saleReturn.srcBillType, 'SalOrder')
  assert.equal(saleReturn.items[0].srcBillType, 'SalOrder')
  assert.equal(WMS_QC_FORMAL_CONTRACTS.saleReturn.wmsType, '302')
  assert.equal(WMS_QC_FORMAL_CONTRACTS.saleReturn.direction, 'IN')

  assert.throws(() => buildPurchaseInboundPayload({
    marker,
    ...formalIds,
    accountId: Number.MAX_SAFE_INTEGER + 1
  }), /夹具缺少正式采购订单/)
})

test('page evidence records route, visible marker, fields, and screenshot path', async () => {
  const record = caseRecord()
  const browser = pageHarness('库存期初 E2E-MARKER 仓库')
  const result = await capturePageEvidence({
    page: browser.page,
    openRoute: browser.openRoute,
    saveScreenshot: browser.saveScreenshot,
    outputDir: '/tmp/wms-qc-unit',
    record: { screenshots: [] },
    caseRecord: record,
    route: '/wms/stock/beginningInventory',
    marker: 'E2E-MARKER',
    fields: ['库存期初', '仓库'],
    name: 'wms-qc-page-evidence'
  })
  assert.equal(result.passed, true)
  assert.equal(result.screenshot, '/tmp/wms-qc-page-evidence.png')
  assert.deepEqual(record.evidence, ['/tmp/wms-qc-page-evidence.png'])
  assert.equal(record.checks[0].passed, true)
})

const qc002PageMenus = [{
  path: '/warehouse-v2',
  children: [{ path: 'outbound', children: [
    { path: 'sales', component: 'wms/stock/out/sell/index' }
  ] }]
}, {
  path: '/sales-v2',
  children: [{ path: 'returns', component: 'erp/sale/return/index' }]
}]

test('QC002 pages use actual permission components, explicit readiness and exact readback bill rows', async () => {
  const record = caseRecord()
  const outboundNo = 'XSCK-261016-031'
  const returnNo = 'XSTH-261016-009'
  const browser = pageHarness((url) => url.includes('warehouse-v2')
    ? `出库单号 单据日期 客户 单据阶段 ${outboundNo}`
    : `退货单号 退货类型 客户 ${returnNo}`, { rowValues: [outboundNo, returnNo] })
  const api = {
    async getBusiness(path) {
      assert.equal(path, '/system/auth/get-permission-info')
      return ok({ menus: qc002PageMenus })
    }
  }
  const results = await fixtureInternal.captureQc002Pages({
    api, ...browser, caseRecord: record, outputDir: '/tmp/wms-qc-unit', record: {},
    wms: { billNo: outboundNo }, saleReturn: { detail: { billNo: returnNo } }
  })
  assert.equal(results.every((result) => result.passed), true)
  assert.deepEqual(browser.calls.filter(([action]) => action === 'open'), [
    ['open', '/warehouse-v2/outbound/sales',
      { readySelector: 'input[placeholder="请输入出库单号"]', readyText: undefined }],
    ['open', '/sales-v2/returns',
      { readySelector: 'input[placeholder="请输入退货单号"]', readyText: undefined }]
  ])
  assert.deepEqual(browser.calls.filter(([action]) => action === 'fill'), [
    ['fill', '请输入出库单号', outboundNo, { exact: true }],
    ['fill', '请输入退货单号', returnNo, { exact: true }]
  ])
  assert.deepEqual(browser.calls.filter(([action]) => action === 'row').map(([, match]) => match), [
    { has: { value: outboundNo, exact: true } }, { has: { value: returnNo, exact: true } }
  ])
  assert.deepEqual(browser.calls.filter(([action]) => action === 'press'), [
    ['press', '请输入出库单号', 'Enter'], ['press', '请输入退货单号', 'Enter']
  ])
  assert.deepEqual(record.evidence, [
    '/tmp/wms-qc-002-outbound.png', '/tmp/wms-qc-002-sale-return.png'
  ])
})

test('QC002 shell/filter-only matches, missing bill numbers or missing menus never produce page PASS', async () => {
  for (const mode of ['input-only', 'different-row', 'missing-menu', 'missing-outbound', 'missing-return']) {
    const record = caseRecord()
    const browser = pageHarness('出库单号 单据日期 客户 单据阶段 XSCK-001', {
      rowValues: mode === 'different-row' ? ['XSCK-001-suffix'] : []
    })
    const api = {
      async getBusiness(path) {
        assert.equal(path, '/system/auth/get-permission-info')
        return ok({ menus: mode === 'missing-menu' ? [] : qc002PageMenus })
      }
    }
    await assert.rejects(fixtureInternal.captureQc002Pages({
      api, ...browser, caseRecord: record, outputDir: '/tmp/wms-qc-unit', record: {},
      wms: { billNo: mode === 'missing-outbound' ? '' : 'XSCK-001' },
      saleReturn: { detail: { billNo: mode === 'missing-return' ? '' : 'XSTH-001' } }
    }), /no exact owned row|BLOCKED:/, mode)
    assert.equal(record.checks.some((check) => check.passed), false, mode)
    assert.equal(browser.calls.some(([action]) => action === 'screenshot'), false, mode)
    if (mode.startsWith('missing-')) assert.deepEqual(browser.calls, [], mode)
  }
})

test('QC-003 proves rejection with unchanged dedicated data without claiming post-persist rollback', async () => {
  const record = caseRecord()
  const browser = pageHarness('库存 可用 锁定 E2E-QC-003')
  const calls = []
  const api = {
    async put(path, body, options) {
      calls.push(['PUT', path, body])
      assert.equal(options.expectedBusinessRejection.code, 500)
      return { code: 500, message: 'E2E-QC-003-IO：单据不能做该操作，可能被其他用户改变了状态！' }
    },
    async post(path, body, options) {
      calls.push(['POST', path, body])
      assert.equal(options.expectedBusinessRejection.code, 1030500000)
      return { code: 1030500000, msg: '产品不存在' }
    },
    async get(path, options) {
      calls.push(['GET', path])
      assert.equal(options.expectedBusinessRejection.message, '未找到对应数据')
      return { code: 500, message: '未找到对应数据' }
    },
    async getBusiness(path) {
      calls.push(['GET', path])
      if (path === '/system/auth/get-permission-info') return ok({
        menus: [{
          path: '/warehouse',
          children: [{
            path: 'standing-stock',
            component: 'wms/stock/reportForms/standingStock/index'
          }]
        }]
      })
      if (path.startsWith('/erp/purchase-in/page')) return ok({ list: [], total: 0 })
      if (path.startsWith('/erp/purchase-order/get')) return ok({ id: formalIds.purchaseOrderId, items: [] })
      if (path.startsWith('/mes/stkIo/queryById')) return ok({
        id: '9223372036854775812',
        billNo: 'E2E-QC-003-IO',
        isEffective: 1,
        actions: { check: false },
        stockIoType: '101',
        srcBillType: 'ErpPurchaseIn',
        srcBillId: '9223372036854775816'
      })
      if (path.startsWith('/mes/stkIo/queryEntryByMainId')) return ok([{
        id: '9223372036854775817',
        mid: '9223372036854775812',
        materialId: formalIds.materialId,
        warehouseId: formalIds.warehouseId,
        qty: 1
      }])
      if (path.startsWith('/mes/stkInventory/list')) {
        return ok({
          list: [{
            id: '9223372036854775815',
            materialId: formalIds.materialId,
            warehouseId: formalIds.warehouseId,
            qty: 1,
            availableQty: 1,
            lockQty: 0,
            holdQty: 0,
            frozenQty: 0,
            pendingPutawayQty: 0
          }],
          total: 1
        })
      }
      throw new Error(`unexpected GET ${path}`)
    }
  }
  const result = await fixtureInternal.runQc003(
    api,
    browser.page,
    {},
    record,
    '/tmp/wms-qc-unit',
    { openRoute: browser.openRoute, saveScreenshot: browser.saveScreenshot },
    {
      marker: 'E2E-QC-003',
      material: { id: formalIds.materialId, code: 'E2E-QC-003' },
      warehouse: { id: formalIds.warehouseId },
      area: { id: formalIds.areaId },
      location: { id: formalIds.locationId }
    },
    {
      id: '9223372036854775816',
      wms: { id: '9223372036854775812' },
      payload: {
        orderId: formalIds.purchaseOrderId,
        remark: 'E2E-QC-003',
        items: [{ productId: formalIds.materialId, warehouseId: formalIds.warehouseId }]
      }
    }
  )
  assert.equal(record.checks.find((check) => check.name === '多行正式采购入库失败后不留下孤儿单据').passed, true)
  assert.equal(record.checks.find((check) => check.name === '重复审核正式 WMS 单据不允许二次执行').passed, true)
  assert.equal(record.checks.find((check) =>
    check.name === '重复审核前后正式主单、来源明细和专属库存完全不变').passed, true)
  assert.equal(calls.filter(([method, path]) => method === 'GET' && path.startsWith('/erp/purchase-in/page')).length, 2)
  assert.deepEqual(record.contractGaps.map((gap) => [gap.key, gap.status]), [
    ['tenant-isolation', 'BLOCKED'], ['low-privilege', 'BLOCKED'],
    ['post-persist-rollback', 'BLOCKED'], ['flow-balance-match', 'BLOCKED']
  ])
  assert.equal(record.contractGaps.every((gap) => /未登记为本轮专属维度/.test(gap.reason)), true)
  assert.equal(record.notes.some((note) => note.startsWith('DEFERRED:')), false)
  mapWmsQcCatalogAssertions(record, 'WMS-QC-003')
  assert.deepEqual(record.catalogAssertions.map((assertion) => assertion.status),
    ['GAP', 'GAP', 'VERIFIED', 'GAP', 'GAP'])
  assert.equal(record.passCandidate, false)
  assert.equal(caseOutcome({
    failedChecks: record.checks.filter((check) => !check.passed),
    hasAssertions: record.checks.length > 0, result
  }).status, 'PARTIAL')
})

const qc003Harness = (options = {}) => {
  const record = caseRecord()
  const fixture = {
    marker: 'E2E-QC-003', token: 'E2E-QC003-UNIT',
    material: { id: formalIds.materialId, unitId: formalIds.unitId, code: 'E2E-QC-003' },
    warehouse: { id: formalIds.warehouseId }, area: { id: formalIds.areaId },
    location: { id: formalIds.locationId }
  }
  record.fixtures = ['warehouse', 'area', 'location', 'material'].map((kind) => ({
    kind, id: fixture[kind].id, token: fixture.token
  }))
  const inbound = { id: '9223372036854775816', wms: { id: '9223372036854775812' } }
  const dimensions = {
    materialId: fixture.material.id, warehouseId: fixture.warehouse.id,
    wareAreaId: fixture.area.id, wareLocationId: fixture.location.id,
    batchNo: 'BASE', colorId: null, brand: null, gradeId: null
  }
  const main = new Map([[inbound.wms.id, {
    id: inbound.wms.id, billNo: 'E2E-QC-003-IO', remark: fixture.marker, tenantId: '1',
    isEffective: 1, isVoided: 0, isClosed: 1, version: '1', billStage: '34',
    actions: { check: false, execute: false }, stockIoType: '101',
    srcBillType: 'ErpPurchaseIn', srcBillId: inbound.id
  }]])
  const entries = new Map([[inbound.wms.id, [{
    id: '9223372036854775817', mid: inbound.wms.id, entryNo: 1,
    ...dimensions, qty: 1, unitId: formalIds.unitId, baseQty: 1, baseUnitId: formalIds.unitId,
    stockIoDirection: '1', inStockTime: '2026-10-15T07:00:00'
  }]]])
  const inventory = [{
    id: '9223372036854775815', ...dimensions, unitId: formalIds.unitId,
    qty: 1, availableQty: 1, lockQty: 0, holdQty: 0, frozenQty: 0, pendingPutawayQty: 0
  }]
  let sequence = 40n
  const nextId = () => String(9223372036854775800n + sequence++)
  const calls = []
  const events = []
  const adminIdentity = {
    login: { userId: '42', tenantId: '2', accessToken: 'offline-tenant-admin-token-0000001' },
    profile: { id: '42', username: 'tenantadmin', roles: [{ id: '43', name: '租户管理员' }] },
    info: { user: { id: '42', username: 'tenantadmin' }, roles: ['tenant_admin'] },
    browserInfo: { user: { id: '42', username: 'tenantadmin' }, roles: ['tenant_admin'] }
  }
  let disabled = false
  const clone = (value) => structuredClone(value)
  const page = (rows) => ok({ records: clone(rows), total: rows.length })
  const flows = () => [...entries].flatMap(([id, lines]) => lines.map((entry) => ({
    id, materialId: entry.materialId, warehouseId: entry.warehouseId,
    wareAreaId: entry.wareAreaId, wareLocationId: entry.wareLocationId,
    unitId: entry.unitId, stockIoDirection: entry.stockIoDirection,
    inQty: entry.stockIoDirection === '1' ? entry.qty : 0,
    outQty: entry.stockIoDirection === '2' ? entry.qty : 0,
    isEffective: main.get(id).isEffective, isVoided: main.get(id).isVoided
  })))
  const api = {
    async getBusiness(path) {
      calls.push(['GET', path])
      const url = new URL(path, 'http://offline')
      const id = url.searchParams.get('id')
      if (url.pathname === '/system/tenant/get') return ok(id === '1'
        ? { id: '1', name: 'CFOR 标准平台', status: 0 }
        : { id: '2', name: 'E2E SECOND', status: 0 })
      if (url.pathname === '/system/user/get') return ok({ id: '52', username: 'unitreader', status: disabled ? 1 : 0 })
      if (url.pathname === '/infra/config/get-value-by-key') {
        assert.equal(url.searchParams.get('key'), 'area_location_switch')
        return options.storageResponse || ok(Object.hasOwn(options, 'storageMode') ? options.storageMode : '0')
      }
      if (url.pathname === '/mes/wmsHouseArea/list') {
        assert.equal(url.searchParams.get('houseId'), fixture.warehouse.id)
        return page(options.areas || [{
          id: fixture.area.id, houseId: fixture.warehouse.id, isEnabled: true
        }])
      }
      if (url.pathname === '/mes/wms-house-location/page') {
        assert.equal(url.searchParams.get('houseId'), fixture.warehouse.id)
        assert.equal(url.searchParams.get('areaId'), fixture.area.id)
        return page(options.locations || [{
          id: fixture.location.id, houseId: fixture.warehouse.id, areaId: fixture.area.id, isEnabled: true
        }])
      }
      if (url.pathname === '/mes/stkIo/queryById') return ok(clone(main.get(id)))
      if (url.pathname === '/mes/stkIo/queryEntryByMainId') return ok(clone(entries.get(id)))
      if (url.pathname === '/mes/stkIo/list') {
        const billNo = url.searchParams.get('billNo')
        return page([...main.values()].filter((row) => !billNo || row.billNo === billNo))
      }
      if (url.pathname === '/mes/stkInventory/list') return page(inventory)
      if (url.pathname === '/mes/stk/report/view/list') {
        const rows = options.flowRows ? options.flowRows(flows()) : flows()
        return page(rows)
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness(path, body) {
      calls.push(['POST', path, clone(body)])
      assert.ok(['/mes/stkIo/add/submit', '/mes/stkIo/add/save'].includes(path))
      const id = nextId()
      const opening = body.stockIoType === '106'
      main.set(id, { id, ...clone(body), isEffective: opening ? 1 : 0, isVoided: 0, isClosed: 0,
        version: '0', billStage: opening ? '34' : '12', actions: opening ? { execute: false } : { edit: true },
        ...(opening ? {} : options.draftState) })
      const lines = body.stkIoEntryList.map((line) => ({
        ...clone(line), id: nextId(), mid: id, baseUnitId: line.unitId, baseQty: line.qty,
        version: '0', inStockTime: opening ? '2026-10-15T08:00:00' : null,
        ...(opening ? {} : options.draftEntry)
      }))
      entries.set(id, lines)
      if (opening) {
        inventory.push({ id: nextId(), ...dimensions, batchNo: lines[0].batchNo, unitId: formalIds.unitId,
          qty: 10, availableQty: 10, lockQty: 0, holdQty: 0, frozenQty: 0, pendingPutawayQty: 0 })
      }
      return ok(opening ? id : true)
    },
    async put(path, body, requestOptions) {
      calls.push(['PUT', path, clone(body)])
      const detail = main.get(body.id)
      const lines = entries.get(body.id)
      if (path === '/mes/stkIo/edit/submit') {
        for (const key of ['billStage', 'version', 'isAuto', 'isEffective', 'isClosed', 'isVoided']) {
          assert.equal(body[key], detail[key], `request must preserve persisted ${key}`)
          assert.notEqual(body[key], undefined)
        }
        assert.deepEqual(body.stkIoEntryList.map(({ id, mid, version }) => ({ id, mid, version })),
          lines.map(({ id, mid, version }) => ({ id, mid, version })))
        assert.equal(Object.hasOwn(body, 'actions'), false)
      }
      const failAt = options.failAt || '/mes/stkIo/edit/submit'
      if (options.workflow && path === '/mes/stkIo/edit/submit') {
        Object.assign(detail, { billStage: '22', actions: {} })
        return ok(true)
      }
      if (path !== failAt) {
        assert.ok(['/mes/stkIo/edit/submit', '/mes/stkIo/check'].includes(path))
        if (options.manualCheck && path === '/mes/stkIo/edit/submit') {
          Object.assign(detail, { billStage: '14', version: '1', actions: { check: true } })
        } else {
          Object.assign(detail, { billStage: '24', version: '2',
            isEffective: options.approvedEffective ? 1 : 0, actions: { execute: true } })
        }
        return ok(true)
      }
      if (options.dirtyRollback) detail.version = '2'
      if (options.rollbackError) throw options.rollbackError
      if (options.executedRollback) {
        Object.assign(detail, { isEffective: 1, billStage: '34', actions: { execute: false } })
      }
      const response = options.rollbackResponse || { code: 500, message:
        `【分录号：${options.reverseOrder ? 1 : 2}】“仓库+存货+批次号”的库存数不足！仓库=${fixture.warehouse.id} ` +
        `存货=${fixture.material.id} 批次=${lines[0].batchNo} 本次变动后现存量=-2，已拒绝负库存写入。` }
      if (options.reservation) response.message =
        `可用库存不足，无法提审：可用量=4，本次占用=6（存货=${fixture.material.id} 批次=${lines[0].batchNo}）`
      if (!options.rollbackResponse) assert.match(response.message, requestOptions.expectedBusinessRejection.message)
      return response
    }
  }
  const foreignApi = {
    async get(path) {
      events.push(['foreign GET', path])
      return options.foreignLeak ? ok({ id: inbound.wms.id }) : { code: 500, message: '未找到对应数据' }
    },
    async getBusiness(path) {
      events.push(['foreign GET-business', path])
      return path.startsWith('/mes/stkIo/queryEntryByMainId') ? ok([]) : page([])
    },
    async put(path, body) {
      events.push(['foreign PUT', path, body])
      return { code: 500, message: '单据未找到，可能被其他用户删除了！' }
    }
  }
  const dependencies = {
    createApiClient(settings) {
      assert.equal(settings.record, undefined)
      if (!settings.token) {
        assert.equal(settings.tenantId, '2')
        return {
          async postBusiness(path, body, requestOptions) {
            assert.equal(path, '/system/auth/login-encrypted')
            assert.deepEqual(body, {
              username: 'tenantadmin', password: 'offline-secret', captchaVerification: ''
            })
            assert.deepEqual(requestOptions, { encrypted: true })
            events.push(['identity login', settings.tenantId])
            if (options.adminLoginError) throw options.adminLoginError
            return options.adminLoginResponse || ok(clone(adminIdentity.login))
          }
        }
      }
      assert.equal(settings.token, adminIdentity.login.accessToken)
      assert.equal(settings.tenantId, adminIdentity.login.tenantId == null ? '2' : String(adminIdentity.login.tenantId))
      return {
        async getBusiness(path) {
          events.push(['identity GET', path])
          if (options.adminProfileError) throw options.adminProfileError
          if (path === '/system/user/profile/get') return options.adminProfileResponse || ok(clone(adminIdentity.profile))
          assert.equal(path, '/system/auth/get-permission-info')
          return options.adminInfoResponse || ok(clone(adminIdentity.info))
        },
        async postBusiness(path) {
          assert.equal(path, '/system/auth/logout')
          events.push(['identity logout', settings.tenantId])
          if (options.adminLogoutError) throw options.adminLogoutError
          return options.adminLogoutResponse || ok(true)
        }
      }
    },
    async runReadOnlySql(sql) {
      calls.push(['SQL', sql])
      assert.match(sql, /^SELECT \* FROM /)
      assert.match(sql, /tenant_id=1/)
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b|inventory_flow/i)
      if (options.sqlUnavailable) return { available: false, rows: [] }
      const rows = sql.startsWith('SELECT * FROM mes_stk_inventory_adjust_log') ? []
        : sql.startsWith('SELECT * FROM mes_stk_inventory ') ? inventory
          : sql.startsWith('SELECT * FROM mes_stk_io_entry ') ? [...entries.values()].flat()
            : [...main.values()]
      const persisted = rows.map((row) => [JSON.stringify(row)])
      if (options.dirtySqlRollback && sql.startsWith('SELECT * FROM mes_stk_io_entry ') &&
          calls.some(([method]) => method === 'PUT')) persisted[0].push('SQL-only changed column')
      return { available: true, rows: persisted }
    },
    async createPmsIsolationTenant(_api, { marker }) {
      events.push(['create tenant', marker])
      return { tenantId: '2', packageId: '30',
        tenant: { id: '2', name: 'E2E SECOND', username: 'tenantadmin', password: 'offline-secret' } }
    },
    async retirePmsIsolationTenant(_api, tenant) {
      events.push(['retire tenant', tenant.tenantId])
    },
    async createProcurementPermissionReader(_api, _record, { permission }) {
      events.push(['create reader', permission])
      return { userId: '52', roleId: '53', username: 'unitreader',
        credentials: { username: 'unitreader', password: 'offline-secret' },
        async deactivate() { events.push(['deactivate reader']); disabled = true; return ok(true) } }
    },
    async withLoggedInTenant(_context, tenant, run, settings) {
      events.push(['login', tenant.id])
      try {
        if (tenant.id === '2') {
          assert.equal(settings.userId, String(adminIdentity.login.userId))
          assert.equal(settings.platformApi, api)
          assert.equal(Object.hasOwn(settings.tenantRecord, 'contactUserId'), false)
          return await run({ api: foreignApi, auth: { tenantId: options.wrongTenant ? '1' : '2' },
            info: clone(adminIdentity.browserInfo) })
        }
        assert.equal(settings.requireTenantAdmin, false)
        assert.equal(settings.userId, '52')
        return await run({
          api: {
            async put(path, body, requestOptions) {
              events.push(['reader PUT', path, body])
              if (options.permissionError) throw options.permissionError
              const response = options.permissionResponse || { code: 403, msg: '没有该操作权限' }
              if (options.mutatePermissionInventory) {
                inventory[0].qty = 99
                inventory[0].availableQty = 99
              }
              if (options.corruptPermissionInventory) inventory[0].qty = 99
              assert.equal(requestOptions.expectedBusinessRejection.allowServiceCode, true)
              return response
            }
          },
          auth: { tenantId: '1' },
          info: { user: { id: '52', username: 'unitreader' }, roles: ['e2e_reader'],
            permissions: options.permissions || ['erp:settle-method-rule:query'] }
        })
      } finally { events.push(['logout', tenant.id]) }
    }
  }
  return { api, dependencies, record, fixture, inbound, main, entries, inventory, calls, events, flows, adminIdentity }
}

test('QC-003 resolves the API profile then logs the browser in once for bill/entries/inventory/flow isolation', async () => {
  const h = qc003Harness()
  const result = await verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies)
  assert.equal(result.verified, true)
  assert.equal(h.events.filter(([event]) => event === 'login').length, 1)
  assert.equal(h.events.filter(([event]) => event === 'foreign GET').length, 2)
  assert.equal(h.events.filter(([event]) => event === 'foreign GET-business').length, 4)
  assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
  assert.equal(h.record.checks.every((check) => check.passed), true)
  assert.equal(h.calls.filter(([method]) => method === 'SQL').length, 8)
  assert.equal(JSON.stringify(h.record).includes('offline-secret'), false)
  assert.equal(JSON.stringify(h.record).includes(h.adminIdentity.login.accessToken), false)
  assert.deepEqual(h.events.slice(1, 6), [
    ['identity login', '2'],
    ['identity GET', '/system/user/profile/get'],
    ['identity GET', '/system/auth/get-permission-info'],
    ['identity logout', '2'],
    ['login', '2']
  ])
})

test('QC-003 cross-tenant leak fails without execute and still retires the tenant', async () => {
  const h = qc003Harness({ foreignLeak: true })
  await assert.rejects(verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies), /详情泄漏/)
  assert.equal(h.events.some(([event]) => event === 'foreign PUT'), false)
  assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
})

test('QC-003 wrong real-login tenant is blocked before foreign probes', async () => {
  const h = qc003Harness({ wrongTenant: true })
  await assert.rejects(verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies), /BLOCKED:.*登录身份/)
  assert.equal(h.events.some(([event]) => event.startsWith('foreign')), false)
  assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
})

test('QC-003 resolves a string snowflake administrator ID without tenant contactUserId', async () => {
  const h = qc003Harness()
  const id = '2110787600656027650'
  h.adminIdentity.login.userId = id
  for (const row of [h.adminIdentity.profile, h.adminIdentity.info.user, h.adminIdentity.browserInfo.user]) {
    row.id = id
  }
  const result = await verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies)
  assert.equal(result.verified, true)
  assert.equal(h.events.filter(([event]) => event === 'identity login').length, 1)
  assert.equal(h.events.filter(([event]) => event === 'identity logout').length, 1)
  assert.equal(h.events.filter(([event]) => event === 'login').length, 1)
})

for (const source of ['login', 'profile', 'info']) {
  test(`QC-003 missing or unstable ${source} administrator IDs block before browser or foreign probes`, async () => {
    for (const value of [undefined, null, '', 'undefined', '0', '42x', Number.MAX_SAFE_INTEGER + 1]) {
      const h = qc003Harness()
      const row = source === 'info' ? h.adminIdentity.info.user : h.adminIdentity[source]
      row[source === 'login' ? 'userId' : 'id'] = value
      await assert.rejects(
        verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
        /BLOCKED:.*未返回稳定 ID/,
        `${source} ID=${value} must not fall back to an arbitrary user`
      )
      assert.equal(h.events.some(([event]) => event === 'login' || event.startsWith('foreign')), false)
      assert.equal(h.events.filter(([event]) => event === 'identity logout').length, 1)
      assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
      assert.equal(h.record.checks.find((check) =>
        check.name === '跨租户探针后管理员 API/SQL 完整事实不变').passed, true)
    }
  })
}

for (const [label, mutate] of [
  ['missing login tenant', (identity) => { delete identity.login.tenantId }],
  ['foreign login tenant', (identity) => { identity.login.tenantId = '1' }],
  ['different profile ID', (identity) => { identity.profile.id = '43' }],
  ['different permission ID', (identity) => { identity.info.user.id = '43' }],
  ['missing profile username', (identity) => { delete identity.profile.username }],
  ['different profile username', (identity) => { identity.profile.username = 'admin' }],
  ['missing permission username', (identity) => { delete identity.info.user.username }],
  ['different permission username', (identity) => { identity.info.user.username = 'admin' }],
  ['foreign profile tenant', (identity) => { identity.profile.tenantId = '1' }],
  ['foreign permission tenant', (identity) => { identity.info.user.tenantId = '1' }],
  ['missing tenant_admin', (identity) => { identity.info.roles = ['reader'] }],
  ['missing roles', (identity) => { delete identity.info.roles }],
  ['roles as string', (identity) => { identity.info.roles = 'tenant_admin' }],
  ['roles as object', (identity) => { identity.info.roles = { tenant_admin: true } }]
]) {
  test(`QC-003 ${label} blocks administrator identity before browser or foreign probes`, async () => {
    const h = qc003Harness()
    mutate(h.adminIdentity)
    await assert.rejects(
      verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      /BLOCKED: QC003/
    )
    assert.equal(h.events.some(([event]) => event === 'login' || event.startsWith('foreign')), false)
    assert.equal(h.events.filter(([event]) => event === 'identity logout').length, 1)
    assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
  })
}

test('QC-003 absent access tokens cannot enter profile or browser identity gates', async () => {
  for (const accessToken of [undefined, null, '', 'short', true]) {
    const h = qc003Harness()
    h.adminIdentity.login.accessToken = accessToken
    await assert.rejects(
      verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      /BLOCKED:.*未返回真实访问令牌/
    )
    assert.equal(h.events.some(([event]) => event === 'login' ||
      event === 'identity GET' || event.startsWith('foreign')), false)
    assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
  }
})

for (const source of ['adminLoginResponse', 'adminProfileResponse', 'adminInfoResponse']) {
  test(`QC-003 ${source} keeps the formal API rejection and still retires its owned tenant`, async () => {
    const h = qc003Harness({ [source]: { code: 403, msg: '没有该操作权限', data: null } })
    await assert.rejects(
      verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      /业务失败：403 没有该操作权限/
    )
    assert.equal(h.events.some(([event]) => event === 'login' || event.startsWith('foreign')), false)
    assert.equal(h.events.filter(([event]) => event === 'identity logout').length,
      source === 'adminLoginResponse' ? 0 : 1)
    assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
  })
}

test('QC-003 profile transport and logout errors remain evidence, not a fabricated administrator', async () => {
  const network = new Error('ECONNREFUSED: tenant profile')
  for (const options of [
    { adminLoginError: network },
    { adminProfileError: network },
    { adminProfileError: network, adminLogoutError: new Error('profile logout failed') },
    { adminLogoutError: new Error('profile logout failed') }
  ]) {
    const h = qc003Harness(options)
    await assert.rejects(
      verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => {
        if (options.adminProfileError && options.adminLogoutError) {
          assert.equal(error instanceof AggregateError, true)
          assert.deepEqual(error.errors, [network, options.adminLogoutError])
        } else assert.equal(error, options.adminLogoutError || network)
        return true
      }
    )
    assert.equal(h.events.some(([event]) => event === 'login' || event.startsWith('foreign')), false)
    assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
  }
})

test('QC-003 a profile-session logout rejection blocks subsequent browser probes', async () => {
  const h = qc003Harness({ adminLogoutResponse: { code: 500, message: 'logout failed' } })
  await assert.rejects(
    verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
    /profile 会话退出业务失败：500 logout failed/
  )
  assert.equal(h.events.some(([event]) => event === 'login' || event.startsWith('foreign')), false)
  assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
})

for (const [label, mutate] of [
  ['missing user ID', (info) => { delete info.user.id }],
  ['different user ID', (info) => { info.user.id = '43' }],
  ['different username', (info) => { info.user.username = 'admin' }],
  ['missing username', (info) => { delete info.user.username }],
  ['foreign explicit tenant', (info) => { info.user.tenantId = '1' }],
  ['missing tenant_admin', (info) => { info.roles = ['reader'] }],
  ['malformed roles', (info) => { info.roles = 'tenant_admin' }]
]) {
  test(`QC-003 browser ${label} cannot bypass the resolved profile identity`, async () => {
    const h = qc003Harness()
    mutate(h.adminIdentity.browserInfo)
    await assert.rejects(
      verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      /BLOCKED: QC003 第二租户真实登录身份未核实/
    )
    assert.equal(h.events.some(([event]) => event.startsWith('foreign')), false)
    assert.deepEqual(h.events.at(-1), ['retire tenant', '2'])
  })
}

test('QC-003 low-privilege execute only accepts exact 403 and deactivates the isolated account', async () => {
  const h = qc003Harness()
  const result = await verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies)
  assert.equal(result.verified, true)
  assert.deepEqual(h.events.filter(([event]) => event === 'reader PUT'), [
    ['reader PUT', '/mes/stkIo/execute', { id: h.inbound.wms.id }]
  ])
  assert.deepEqual(h.events.at(-1), ['deactivate reader'])
  assert.equal(h.record.checks.every((check) => check.passed), true)
  assert.equal(JSON.stringify(h.record).includes('offline-secret'), false)
})

test('QC-003 empty navigation permissions allow the r45 query-only reader to reach the exact 403 probe', async () => {
  for (const permissions of [
    ['', 'erp:settle-method-rule:query', 'system:settings:query'],
    ['', 'erp:settle-method-rule:query', '']
  ]) {
    const original = [...permissions]
    const h = qc003Harness({ permissions })
    const result = await verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies)
    assert.equal(result.verified, true)
    assert.deepEqual(h.events.filter(([event]) => event === 'reader PUT'), [
      ['reader PUT', '/mes/stkIo/execute', { id: h.inbound.wms.id }]
    ])
    assert.equal(h.record.qc003PermissionProbe.verified, true)
    assert.equal(h.record.qc003PermissionProbe.response.code, 403)
    assert.equal(h.record.qc003PermissionProbe.response.msg, '没有该操作权限')
    assert.equal(h.record.checks.find((check) =>
      check.name === '低权限探针后管理员 API/SQL 完整事实不变').passed, true)
    assert.equal(h.record.contractGaps, undefined)
    assert.deepEqual(h.events.at(-1), ['deactivate reader'])
    assert.deepEqual(permissions, original)
  }
})

test('QC-003 empty navigation permissions cannot mask missing query, wildcard, write or malformed permissions', async () => {
  const query = 'erp:settle-method-rule:query'
  for (const permissions of [
    [],
    [''],
    ['', 'system:settings:query'],
    ...[
      '*:*:*', '*:query', 'wms:*:query', 'wms:operation-task:execute',
      'system:settings:create', 'system:settings:update', 'system:settings:delete',
      'system:settings:query:execute', 'system:settings:QUERY', 'system:settings:query ',
      ' ', null, undefined, false, 0, {}, []
    ].map((value) => ['', query, value])
  ]) {
    const h = qc003Harness({ permissions })
    await assert.rejects(verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      /BLOCKED: QC003 只读账号真实权限或身份不满足严格约束，未执行探针/)
    assert.equal(h.events.some(([event]) => event === 'reader PUT'), false)
    assert.equal(h.record.qc003PermissionProbe, undefined)
    assert.equal(h.record.checks.find((check) =>
      check.name === '低权限探针后管理员 API/SQL 完整事实不变').passed, true)
    assert.deepEqual(h.events.at(-1), ['deactivate reader'])
  }
})

test('QC-003 completed inbound may omit execute but still needs closed executed source facts', async () => {
  const h = qc003Harness()
  delete h.main.get(h.inbound.wms.id).actions.execute
  const result = await verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies)
  assert.equal(result.verified, true)
  assert.equal(h.events.filter(([event]) => event === 'reader PUT').length, 1)
  assert.equal(h.record.checks.find((check) =>
    check.name === '低权限探针后管理员 API/SQL 完整事实不变').passed, true)

  for (const mode of ['stage', 'effective', 'closed', 'voided', 'actions', 'executed-time', 'source']) {
    const unsafe = qc003Harness()
    const main = unsafe.main.get(unsafe.inbound.wms.id)
    delete main.actions.execute
    if (mode === 'stage') main.billStage = '24'
    if (mode === 'effective') main.isEffective = 0
    if (mode === 'closed') main.isClosed = 0
    if (mode === 'voided') main.isVoided = 1
    if (mode === 'actions') delete main.actions
    if (mode === 'executed-time') unsafe.entries.get(unsafe.inbound.wms.id)[0].inStockTime = null
    if (mode === 'source') main.srcBillId = '999'
    await assert.rejects(verifyWmsQcLowPrivilege(
      unsafe.api, {}, unsafe.record, unsafe.fixture, unsafe.inbound, unsafe.dependencies),
    /BLOCKED:.*只读探针/, mode)
    assert.deepEqual(unsafe.events, [], mode)
    assert.equal(unsafe.calls.some(([method]) => ['PUT', 'POST'].includes(method)), false, mode)
  }
})

test('QC-003 low-privilege state rejection is a product BLOCKED, never permission PASS', async () => {
  const h = qc003Harness({ permissionResponse: { code: 500,
    message: 'E2E-QC-003-IO：单据不能做该操作，可能被其他用户改变了状态！' } })
  const result = await verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies)
  assert.equal(result.verified, false)
  assert.equal(h.record.contractGaps[0].key, 'low-privilege')
  assert.equal(h.record.contractGaps[0].status, 'BLOCKED')
  assert.match(h.record.contractGaps[0].sources[0], /MesStkIoController.java:1335$/)
  assert.equal(h.record.checks.some((check) => check.name === '低权限账号业务拒绝已由正式账号证明'), false)
})

test('QC-003 executable samples, wildcard and write permissions never reach the reader execute probe', async () => {
  for (const mode of ['executable', 'wildcard', 'write']) {
    const h = qc003Harness({ permissions: mode === 'wildcard' ? ['*:*:*']
      : mode === 'write' ? ['erp:settle-method-rule:query', 'wms:operation-task:execute'] : undefined })
    if (mode === 'executable') h.main.get(h.inbound.wms.id).actions.execute = true
    await assert.rejects(verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies), /BLOCKED:/)
    assert.equal(h.events.some(([event]) => event === 'reader PUT'), false)
    if (mode !== 'executable') assert.deepEqual(h.events.at(-1), ['deactivate reader'])
  }
})

test('QC-003 unexpected permission responses and changed facts fail instead of becoming BLOCKED', async () => {
  for (const options of [
    { permissionResponse: ok(true) },
    { permissionResponse: { code: 401, msg: '未登录' } },
    { permissionResponse: { code: 403, msg: '没有该操作权限', message: 'different' } },
    { mutatePermissionInventory: true }
  ]) {
    const h = qc003Harness(options)
    await assert.rejects(verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => caseErrorStatus(error, h.record.checks) === 'FAIL')
    assert.deepEqual(h.events.at(-1), ['deactivate reader'])
    assert.equal(h.record.checks.some((check) => check.passed === false), true)
    assert.equal(h.record.contractGaps, undefined)
  }
})

test('QC-003 invalid after-facts and reader transport failures remain FAIL with cleanup', async () => {
  for (const [options, message] of [
    [{ corruptPermissionInventory: true }, 'WMS 库存维度或守恒字段不完整'],
    [{ permissionError: new Error('offline ECONNRESET') }, 'offline ECONNRESET']
  ]) {
    const h = qc003Harness(options)
    await assert.rejects(verifyWmsQcLowPrivilege(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => error.message === message && caseErrorStatus(error, h.record.checks) === 'FAIL')
    assert.deepEqual(h.events.at(-1), ['deactivate reader'])
    assert.equal(h.record.contractGaps, undefined)
    assert.equal(h.record.checks.some((check) =>
      check.name === '低权限探针后管理员 API/SQL 完整事实不变' && check.passed),
    options.corruptPermissionInventory !== true)
    assert.equal(h.record.checks.some((check) =>
      check.name === '低权限账号业务拒绝已由正式账号证明' && check.passed),
    options.permissionError === undefined)
  }
})

test('QC-003 formal inQty/outQty projection reconciles base units but cannot claim immutable logs', async () => {
  const h = qc003Harness()
  const result = await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)
  assert.equal(result.verified, true)
  assert.equal(h.record.contractGaps[0].key, 'immutable-flow')
  assert.equal(h.record.contractGaps[0].status, 'BLOCKED')
  assert.equal(h.record.checks.every((check) => check.passed), true)
  assert.equal(h.calls.some(([method]) => method === 'PUT' || method === 'POST'), false)
})

test('QC-003 formal DTO without qty/baseQty verifies balance while retaining the reverse GAP', async () => {
  const h = qc003Harness()
  assert.equal(['qty', 'baseQty', 'baseUnitId'].some((key) => Object.hasOwn(h.flows()[0], key)), false)
  assert.equal(h.flows()[0].inQty, 1)
  assert.equal(h.flows()[0].outQty, 0)
  const result = await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)
  assert.deepEqual(result, { verified: true, rowsMatch: true, balanced: true })
  mapWmsQcCatalogAssertions(h.record, 'WMS-QC-003')
  assert.equal(h.record.catalogAssertions[4].status, 'VERIFIED')
  assert.equal(h.record.catalogReverseAssertions[0].status, 'GAP')
  assert.equal(h.record.passCandidate, false)
  assert.equal(h.calls.some(([method]) => method === 'PUT' || method === 'POST'), false)
})

test('QC-003 normalizes null source storage dimensions only through the formal unique default area/location', async () => {
  const h = qc003Harness()
  const entry = h.entries.get(h.inbound.wms.id)[0]
  entry.wareAreaId = null
  entry.wareLocationId = null
  const result = await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)
  assert.deepEqual(result, { verified: true, rowsMatch: true, balanced: true })
  assert.equal(h.record.qc003BalanceEvidence.normalizedDimensions.length, 1)
  assert.deepEqual(h.record.qc003BalanceEvidence.defaultStorage[0], {
    areaId: h.fixture.area.id,
    locationId: h.fixture.location.id,
    evidence: {
      value: '0',
      mode: 'LOCATION',
      warehouseId: h.fixture.warehouse.id,
      area: { id: h.fixture.area.id, houseId: h.fixture.warehouse.id, isEnabled: true },
      location: {
        id: h.fixture.location.id, houseId: h.fixture.warehouse.id,
        areaId: h.fixture.area.id, isEnabled: true
      }
    }
  })
  assert.equal(h.calls.some(([method, path]) =>
    method === 'GET' && path.startsWith('/infra/config/get-value-by-key?key=area_location_switch')), true)
  assert.equal(h.calls.some(([method, path]) =>
    method === 'GET' && path.startsWith('/mes/wmsHouseArea/list?houseId=')), true)
  assert.equal(h.calls.some(([method, path]) =>
    method === 'GET' && path.startsWith('/mes/wms-house-location/page?houseId=')), true)
  assert.equal(h.calls.some(([method]) => method === 'PUT' || method === 'POST'), false)
})

test('QC-003 r45 shape reconciles effective 101 plus 106 while excluding both failed 299 draft lines', async () => {
  const h = qc003Harness()
  const incoming = h.entries.get(h.inbound.wms.id)[0]
  Object.assign(incoming, { batchNo: '0', wareAreaId: null, wareLocationId: null })
  h.inventory[0].batchNo = '0'
  const batchNo = 'E2E-RB-138c43a1e7b05b24'
  const openingId = '9223372036854775830'
  const draftId = '9223372036854775831'
  h.main.set(openingId, { ...h.main.get(h.inbound.wms.id), id: openingId,
    billNo: `${batchNo}-106`, stockIoType: '106' })
  h.main.set(draftId, { ...h.main.get(h.inbound.wms.id), id: draftId,
    billNo: `${batchNo}-299`, stockIoType: '299', billStage: '12', isEffective: 0, isClosed: 0,
    actions: { edit: true } })
  const dimensions = {
    ...incoming, batchNo, wareAreaId: h.fixture.area.id, wareLocationId: h.fixture.location.id
  }
  h.entries.set(openingId, [{ ...dimensions, id: '9223372036854775832', mid: openingId,
    qty: 10, baseQty: 10 }])
  h.entries.set(draftId, [1, 2].map((entryNo) => ({
    ...dimensions, id: String(9223372036854775832n + BigInt(entryNo)), mid: draftId,
    entryNo, qty: 6, baseQty: 6, stockIoDirection: '2', inStockTime: null
  })))
  h.inventory.push({ ...h.inventory[0], id: '9223372036854775835', batchNo,
    qty: 10, availableQty: 10 })
  const before = structuredClone({ main: [...h.main], entries: [...h.entries], inventory: h.inventory })
  const result = await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)
  assert.deepEqual(result, { verified: true, rowsMatch: true, balanced: true })
  assert.equal(h.record.qc003BalanceEvidence.balances.length, 2)
  assert.deepEqual(h.record.qc003BalanceEvidence.balances.map(({ ledgerQty, inventoryQty }) =>
    [ledgerQty, inventoryQty]).sort((a, b) => a[0] - b[0]), [[1, 1], [10, 10]])
  assert.equal(h.flows().length, 4)
  assert.equal(h.record.qc003BalanceEvidence.normalizedDimensions.length, 1)
  assert.deepEqual({ main: [...h.main], entries: [...h.entries], inventory: h.inventory }, before)
  assert.equal(h.record.checks.every((check) => check.passed), true)
  assert.equal(h.record.contractGaps[0].key, 'immutable-flow')
  assert.equal(h.calls.some(([method]) => ['POST', 'PUT', 'DELETE'].includes(method)), false)
})

test('QC-003 default storage normalization cannot hide wrong locations, batches, dimensions or quantities', async () => {
  for (const mode of ['wrong-location', 'wrong-area', 'explicit-location', 'explicit-area',
    'qty', 'batch', 'color', 'brand', 'grade', 'none', 'extra-row']) {
    const h = qc003Harness({ storageMode: mode === 'none' ? 'NONE' : 'LOCATION' })
    const entry = h.entries.get(h.inbound.wms.id)[0]
    Object.assign(entry, { wareAreaId: null, wareLocationId: null })
    if (mode === 'wrong-location') h.inventory[0].wareLocationId = '99'
    if (mode === 'wrong-area') h.inventory[0].wareAreaId = '99'
    if (mode === 'explicit-location') entry.wareLocationId = '99'
    if (mode === 'explicit-area') Object.assign(entry, { wareAreaId: '99', wareLocationId: h.fixture.location.id })
    if (mode === 'qty') Object.assign(h.inventory[0], { qty: 2, availableQty: 2 })
    if (mode === 'batch') h.inventory[0].batchNo = 'OTHER'
    if (mode === 'color') h.inventory[0].colorId = '99'
    if (mode === 'brand') h.inventory[0].brand = 'OTHER'
    if (mode === 'grade') h.inventory[0].gradeId = '99'
    if (mode === 'extra-row') h.inventory.push({
      ...h.inventory[0], id: '9223372036854775830', wareLocationId: '99'
    })
    await assert.rejects(verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => /正式流水与明细\/库存余额不一致/.test(error.message) &&
        caseErrorStatus(error, h.record.checks) === 'FAIL', mode)
    assert.equal(h.record.qc003BalanceEvidence.balanced, false, mode)
    assert.equal(h.record.checks.some((check) => check.passed === false), true, mode)
    assert.equal(h.record.contractGaps, undefined, mode)
    assert.equal(h.calls.some(([method]) => ['POST', 'PUT', 'DELETE'].includes(method)), false, mode)
  }
})

test('QC-003 default storage must be owned, enabled, unique and available through successful formal APIs', async () => {
  const area = { id: formalIds.areaId, houseId: formalIds.warehouseId, isEnabled: true }
  const location = {
    id: formalIds.locationId, houseId: formalIds.warehouseId, areaId: formalIds.areaId, isEnabled: true
  }
  for (const options of [
    { areas: [] }, { locations: [] },
    { areas: [{ ...area, isEnabled: false }] },
    { locations: [{ ...location, isEnabled: false }] },
    { areas: [area, { ...area, id: '99' }] },
    { locations: [location, { ...location, id: '99' }] },
    { areas: [{ ...area, houseId: '99' }] },
    { locations: [{ ...location, areaId: '99' }] },
    { areas: [{ ...area, id: '99' }] },
    { locations: [{ ...location, id: '99' }] },
    { storageMode: 0 },
    { storageResponse: { code: 500, msg: '配置读取失败' } }
  ]) {
    const h = qc003Harness(options)
    Object.assign(h.entries.get(h.inbound.wms.id)[0], { wareAreaId: null, wareLocationId: null })
    await assert.rejects(verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => caseErrorStatus(error, h.record.checks) === 'FAIL')
    assert.equal(h.record.contractGaps, undefined)
    assert.equal(h.record.checks.some((check) =>
      check.name === '正式 report/view 有效流水与库存完整物理维度余额一致' && check.passed), false)
  }
})

test('QC-003 follows formal AREA/LOCATION aliases without changing explicit storage or legacy exact matches', async () => {
  for (const storageMode of [null, '', 'LOCATION', 'L', '0', '2', 'UNKNOWN', 'AREA', 'A', '1']) {
    const h = qc003Harness({ storageMode })
    Object.assign(h.entries.get(h.inbound.wms.id)[0], { wareAreaId: null, wareLocationId: null })
    const areaOnly = ['AREA', 'A', '1'].includes(storageMode)
    if (areaOnly) h.inventory[0].wareLocationId = null
    const result = await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)
    assert.equal(result.balanced, true, String(storageMode))
    assert.equal(h.calls.some(([method, path]) => method === 'GET' &&
      path.startsWith('/mes/wms-house-location/page?')), !areaOnly)
  }
  for (const areaId of [formalIds.areaId, null]) {
    const h = qc003Harness()
    Object.assign(h.entries.get(h.inbound.wms.id)[0], { wareAreaId: areaId, wareLocationId: null })
    if (!areaId) Object.assign(h.inventory[0], { wareAreaId: null, wareLocationId: null })
    assert.equal((await verifyWmsQcFlowBalance(
      h.api, h.record, h.fixture, h.inbound, h.dependencies)).balanced, true)
    assert.equal(h.calls.some(([method, path]) => method === 'GET' &&
      path.startsWith('/mes/wmsHouseArea/list?')), false)
    assert.equal(h.calls.some(([method, path]) => method === 'GET' &&
      path.startsWith('/infra/config/')), areaId !== null)
  }
})

test('QC-003 default storage drift and request failures remain FAIL rather than GAP', async () => {
  for (const mode of ['drift', 'network']) {
    const h = qc003Harness()
    Object.assign(h.entries.get(h.inbound.wms.id)[0], { wareAreaId: null, wareLocationId: null })
    const get = h.api.getBusiness
    let reads = 0
    h.api.getBusiness = async (path) => {
      const response = await get(path)
      if (path.startsWith('/mes/wms-house-location/page?')) {
        if (mode === 'network') throw new Error('offline ECONNRESET')
        if (++reads > 1) response.data.records[0].updateTime = 'changed'
      }
      return response
    }
    await assert.rejects(verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => caseErrorStatus(error, h.record.checks) === 'FAIL' &&
        /配置变化|offline ECONNRESET/.test(error.message))
    assert.equal(h.record.contractGaps, undefined)
  }
})

test('QC-003 report business quantities match entries while signed base snapshots determine stock', async () => {
  const h = qc003Harness()
  const incoming = h.entries.get(h.inbound.wms.id)[0]
  Object.assign(incoming, { unitId: '9223372036854775822', qty: '12.000000',
    baseQty: '1.000000', conversionRateSnapshot: '12' })
  const outboundId = '9223372036854775823'
  h.main.set(outboundId, { ...h.main.get(h.inbound.wms.id), id: outboundId,
    billNo: 'E2E-QC-003-OUT', stockIoType: '299' })
  h.entries.set(outboundId, [{ ...incoming, id: '9223372036854775824', mid: outboundId,
    qty: '3.000000', baseQty: '0.250000', stockIoDirection: '2' }])
  h.inventory[0].qty = '0.750000'
  h.inventory[0].availableQty = '0.750000'
  const result = await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)
  assert.deepEqual(result, { verified: true, rowsMatch: true, balanced: true })
  assert.deepEqual(h.flows().map((row) => [row.inQty, row.outQty]),
    [['12.000000', 0], [0, '3.000000']])
  assert.equal(h.calls.some(([method, path]) => method === 'GET' && ![
    '/mes/stkIo/queryById', '/mes/stkIo/queryEntryByMainId',
    '/mes/stkInventory/list', '/mes/stk/report/view/list'
  ].includes(new URL(path, 'http://offline').pathname)), false)
  assert.equal(h.calls.some(([method]) => method === 'PUT' || method === 'POST'), false)
})

test('QC-003 preserves source quantity signs without claiming a formal reversal closure', async () => {
  const h = qc003Harness()
  const incoming = h.entries.get(h.inbound.wms.id)[0]
  Object.assign(incoming, { qty: 3, baseQty: 3 })
  h.entries.get(h.inbound.wms.id).push({
    ...incoming, id: '9223372036854775821', entryNo: 2, qty: -2, baseQty: -2
  })
  const result = await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)
  assert.deepEqual(result, { verified: true, rowsMatch: true, balanced: true })
  assert.deepEqual(h.flows().map((row) => [row.inQty, row.outQty]), [[3, 0], [-2, 0]])
  mapWmsQcCatalogAssertions(h.record, 'WMS-QC-003')
  assert.equal(h.record.catalogReverseAssertions[0].status, 'GAP')
  assert.equal(h.record.passCandidate, false)
})

test('QC-003 missing or malformed report quantities cannot fall back to qty or baseQty', async () => {
  const patches = [
    { inQty: undefined, qty: 1, baseQty: 1 },
    ...[null, '', ' ', 'NaN', Infinity, -1].map((value) => ({ inQty: value })),
    ...[undefined, null, '', ' ', 'NaN', Infinity, -1, 1].map((value) => ({ outQty: value })),
    { inQty: 2 }, { stockIoDirection: '2' }, { stockIoDirection: '9' },
    { unitId: undefined }, { unitId: '99' }
  ]
  for (const patch of patches) {
    const h = qc003Harness({ flowRows: (rows) => rows.map((row) => ({ ...row, ...patch })) })
    await assert.rejects(verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => caseErrorStatus(error, h.record.checks) === 'FAIL', JSON.stringify(patch))
    mapWmsQcCatalogAssertions(h.record, 'WMS-QC-003')
    assert.equal(h.record.catalogAssertions[4].status, 'GAP')
    assert.equal(h.record.passCandidate, false)
  }
})

test('QC-003 repeated view bill IDs represent separate entries, not deduplicated flow facts', async () => {
  const h = qc003Harness()
  h.entries.get(h.inbound.wms.id).push({
    ...h.entries.get(h.inbound.wms.id)[0], id: '9223372036854775821', entryNo: 2
  })
  h.inventory[0].qty = 2
  h.inventory[0].availableQty = 2
  assert.equal((await verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies)).verified, true)
})

test('QC-003 flow only counts effective nonvoid documents and rejects balance/direction/unit mismatches', async () => {
  for (const mode of [
    'draft', 'void', 'balance', 'direction', 'unit', 'baseQty', 'entryQty', 'entryUnit',
    'inventoryUnit', 'negativeBaseQty', 'empty', 'foreign'
  ]) {
    const h = qc003Harness({
      flowRows: mode === 'empty' ? () => []
        : mode === 'foreign' ? (rows) => rows.map((row) => ({ ...row, materialId: '99' })) : undefined
    })
    if (mode === 'draft') h.main.get(h.inbound.wms.id).isEffective = 0
    if (mode === 'void') h.main.get(h.inbound.wms.id).isVoided = 1
    if (mode === 'balance') { h.inventory[0].qty = 2; h.inventory[0].availableQty = 2 }
    if (mode === 'direction') h.entries.get(h.inbound.wms.id)[0].stockIoDirection = '9'
    if (mode === 'unit') h.entries.get(h.inbound.wms.id)[0].baseUnitId = '88'
    if (mode === 'baseQty') delete h.entries.get(h.inbound.wms.id)[0].baseQty
    if (mode === 'entryQty') delete h.entries.get(h.inbound.wms.id)[0].qty
    if (mode === 'entryUnit') delete h.entries.get(h.inbound.wms.id)[0].unitId
    if (mode === 'inventoryUnit') delete h.inventory[0].unitId
    if (mode === 'negativeBaseQty') h.entries.get(h.inbound.wms.id)[0].baseQty = -1
    await assert.rejects(verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies), undefined, mode)
  }
})

test('QC-003 zero-net dimensions still require consistent base units across their entries', async () => {
  const h = qc003Harness()
  const incoming = h.entries.get(h.inbound.wms.id)[0]
  h.entries.get(h.inbound.wms.id).push(
    { ...incoming, id: '9223372036854775821', entryNo: 2, batchNo: 'ZERO', baseUnitId: '88' },
    { ...incoming, id: '9223372036854775822', entryNo: 3, batchNo: 'ZERO',
      stockIoDirection: '2', baseUnitId: '99' })
  await assert.rejects(verifyWmsQcFlowBalance(h.api, h.record, h.fixture, h.inbound, h.dependencies),
    /BLOCKED:.*baseQty\/baseUnitId/)
  assert.equal(h.record.checks.some((check) =>
    check.name === '正式 report/view 有效流水与库存完整物理维度余额一致' && check.passed), false)
})

test('QC-003 rollback creates formal 106 and two owned 299 lines, accepts either processing order', async () => {
  for (const reverseOrder of [false, true]) {
    const h = qc003Harness({ reverseOrder })
    const result = await verifyWmsQcTransactionRollback(h.api, h.record, h.fixture, h.inbound, h.dependencies)
    assert.equal(result.verified, true)
    const requests = h.calls.filter(([method]) => method === 'POST')
    assert.deepEqual(requests.map(([, path, body]) => [path, body.stockIoType]), [
      ['/mes/stkIo/add/submit', '106'], ['/mes/stkIo/add/save', '299']
    ])
    assert.deepEqual(requests[1][2].stkIoEntryList.map((line) => line.qty), [6, 6])
    assert.ok(requests[0][2].stkIoEntryList[0].batchNo.length <= 32)
    assert.equal(h.record.checks.every((check) => check.passed), true)
    assert.equal(h.record.fixtures.filter((row) => ['stockIo', 'opening'].includes(row.kind))
      .every((row) => row.retained === true), true)
    assert.equal(h.record.contractGaps, undefined)
    const submitted = h.calls.find(([method, path]) => method === 'PUT' && path === '/mes/stkIo/edit/submit')[2]
    assert.equal(submitted.billStage, '12')
    assert.equal(submitted.version, '0')
    assert.deepEqual(['isEffective', 'isClosed', 'isVoided', 'isAuto'].map((key) => submitted[key]),
      [0, 0, 0, 0])
    assert.equal(submitted.stkIoEntryList.every((line) => line.id && line.mid && line.version === '0'), true)
    assert.equal(h.record.qc003RollbackRequests[0].billStage, '12')
    assert.equal(h.record.qc003RollbackRequests[0].version, '0')
  }
})

test('QC-003 rollback also follows existing legal manual execute action without changing policy', async () => {
  for (const approvedEffective of [false, true]) {
    for (const manualCheck of [false, true]) {
      const h = qc003Harness({ failAt: '/mes/stkIo/execute', approvedEffective, manualCheck })
      const result = await verifyWmsQcTransactionRollback(h.api, h.record, h.fixture, h.inbound, h.dependencies)
      assert.equal(result.verified, true)
      assert.equal(result.path, '/mes/stkIo/execute')
      assert.deepEqual(h.calls.filter(([method]) => method === 'PUT').map(([, path]) => path), [
        '/mes/stkIo/edit/submit', ...(manualCheck ? ['/mes/stkIo/check'] : []), '/mes/stkIo/execute'
      ])
      assert.deepEqual(h.record.qc003RollbackRequests.at(-1), {
        path: '/mes/stkIo/execute', id: result.id, billStage: '24', version: '2',
        isEffective: approvedEffective ? 1 : 0,
        entryVersions: h.entries.get(result.id).map(({ id, version }) => ({ id, version }))
      })
    }
  }
})

test('QC-003 missing draft state/version, foreign ownership or entry identity blocks before edit PUT', async () => {
  for (const options of [
    { draftState: { billStage: null } },
    { draftState: { version: null } },
    { draftState: { version: '' } },
    { draftState: { version: ' ' } },
    { draftState: { version: -1 } },
    { draftState: { remark: 'E2E-OTHER-RUN' } },
    { draftState: { subject: 'E2E-OTHER-RUN' } },
    { draftEntry: { version: null } },
    { draftEntry: { version: '' } }
  ]) {
    const h = qc003Harness(options)
    await assert.rejects(verifyWmsQcTransactionRollback(
      h.api, h.record, h.fixture, h.inbound, h.dependencies), /BLOCKED:.*未发送 PUT/)
    assert.equal(h.calls.some(([method]) => method === 'PUT'), false)
    assert.equal(h.record.checks.some((check) =>
      check.name === '两明细各自足量但合计不足触发库存循环中途精确拒绝'), false)
  }
})

test('QC-003 approval/reservation preconditions stay BLOCKED and do not claim execution rollback', async () => {
  for (const options of [{ workflow: true }, { reservation: true }]) {
    const h = qc003Harness(options)
    const result = await verifyWmsQcTransactionRollback(h.api, h.record, h.fixture, h.inbound, h.dependencies)
    assert.equal(result.verified, false)
    assert.equal(h.record.contractGaps[0].key, 'post-persist-rollback')
    assert.equal(h.record.contractGaps[0].status, 'BLOCKED')
    assert.equal(h.record.checks.some((check) => check.name === '两明细各自足量但合计不足触发库存循环中途精确拒绝'), false)
  }
})

test('QC-003 partial rollback, network/system errors and unexpected success are never accepted', async () => {
  for (const options of [
    { dirtyRollback: true },
    { dirtySqlRollback: true },
    { rollbackError: new Error('offline ECONNRESET') },
    { rollbackResponse: { code: 500, message: '系统异常' } },
    { rollbackResponse: { code: 500, message: '单据前置状态错误！' } },
    { rollbackResponse: ok(true), executedRollback: true }
  ]) {
    const h = qc003Harness(options)
    await assert.rejects(verifyWmsQcTransactionRollback(h.api, h.record, h.fixture, h.inbound, h.dependencies),
      (error) => caseErrorStatus(error, h.record.checks) === 'FAIL')
    assert.equal(h.record.checks.some((check) => check.name === '两明细各自足量但合计不足触发库存循环中途精确拒绝'), false)
    assert.equal(h.record.contractGaps, undefined)
  }
})

test('QC-003 successful submit without state progress is BLOCKED, not execution rollback evidence', async () => {
  const h = qc003Harness({ rollbackResponse: ok(true) })
  const result = await verifyWmsQcTransactionRollback(h.api, h.record, h.fixture, h.inbound, h.dependencies)
  assert.equal(result.verified, false)
  assert.equal(h.record.contractGaps[0].key, 'post-persist-rollback')
  assert.equal(h.record.contractGaps[0].status, 'BLOCKED')
  assert.match(h.record.contractGaps[0].reason, /停在 stage=12\/effective=0/)
  assert.deepEqual(h.calls.filter(([method]) => method === 'PUT').map(([, path]) => path),
    ['/mes/stkIo/edit/submit'])
  mapWmsQcCatalogAssertions(h.record, 'WMS-QC-003')
  assert.equal(h.record.catalogAssertions[3].status, 'GAP')
  assert.equal(h.record.passCandidate, false)
})

test('QC-003 unowned data or unavailable SQL cannot authorize further account/tenant probes', async () => {
  for (const options of [{ unowned: true }, { sqlUnavailable: true }]) {
    const h = qc003Harness(options)
    if (options.unowned) h.record.fixtures[0].token = 'another-run'
    await assert.rejects(verifyWmsQcTenantIsolation(h.api, {}, h.record, h.fixture, h.inbound, h.dependencies), /BLOCKED:/)
    assert.deepEqual(h.events, [])
    assert.equal(h.calls.some(([method]) => method === 'PUT' || method === 'POST'), false)
  }
})

test('QC-003 catalog maps only exact complete checks and keeps immutable reverse unverified', () => {
  const record = caseRecord()
  const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'WMS-QC-003')
  assert.equal(definition.status, 'PARTIAL')
  assert.deepEqual(fixtureInternal.catalogContract['WMS-QC-003'].map(([assertion]) => assertion),
    definition.assertions)
  record.checks = fixtureInternal.catalogContract['WMS-QC-003']
    .flatMap(([, names]) => names.map((name) => ({ name, passed: true })))
  mapWmsQcCatalogAssertions(record, 'WMS-QC-003')
  assert.equal(record.catalogAssertions.every((assertion) => assertion.status === 'VERIFIED'), true)
  assert.equal(record.passCandidate, false)
  assert.deepEqual(record.remainingAssertions, definition.reverse)
  assert.deepEqual(record.catalogReverseAssertions.map((assertion) => assertion.status), ['GAP'])
  record.checks.find((check) => check.name === '两明细合计不足拒绝后主单明细库存流水及 SQL 全部回滚').passed = false
  mapWmsQcCatalogAssertions(record, 'WMS-QC-003')
  assert.equal(record.catalogAssertions[3].status, 'GAP')
})

test('QC-003 GAP, BLOCKED and historical DEFERRED reasons never replace missing catalog evidence', () => {
  for (const status of ['GAP', 'BLOCKED', 'DEFERRED']) {
    const record = caseRecord()
    record.checks = fixtureInternal.catalogContract['WMS-QC-003'][2][1]
      .map((name) => ({ name, passed: true }))
    record.contractGaps = [{ key: 'post-persist-rollback', status, reason: '未到执行扣减阶段' }]
    mapWmsQcCatalogAssertions(record, 'WMS-QC-003')
    assert.deepEqual(record.catalogAssertions.map((assertion) => assertion.status),
      ['GAP', 'GAP', 'VERIFIED', 'GAP', 'GAP'])
    assert.equal(record.remainingAssertions.length, 5)
    assert.equal(record.passCandidate, false)
    assert.equal(record.contractGaps[0].status, status)
    assert.equal(caseOutcome({
      failedChecks: [], hasAssertions: true, result: { partial: !record.passCandidate }
    }).status, 'PARTIAL')
  }
})

test('QC-005 approves 106 opening through PUT body and keeps red-invoice deferred', async () => {
  const record = caseRecord()
  const browser = pageHarness('库存期初 导入 E2E-QC-005')
  const calls = []
  let effective = false
  const api = {
    async postBusiness(path) {
      calls.push(['POST-BUSINESS', path])
      return ok('9223372036854775813')
    },
    async post(path) {
      calls.push(['POST', path])
      return rejection('Duplicate entry for key mes_stk_io.uk_mes_stk_io_tenant_bill_no')
    },
    async putBusiness(path, body) {
      calls.push(['PUT-BUSINESS', path, body])
      effective = true
      return ok(true)
    },
    async put(path) {
      calls.push(['PUT', path])
      return rejection('库存期初已生效，不能直接修改；请先反审核')
    },
    async getBusiness(path) {
      calls.push(['GET', path])
      if (path.startsWith('/mes/stkIo/queryById')) {
        return ok({ id: '9223372036854775813', isEffective: effective ? 1 : 0 })
      }
      throw new Error(`unexpected GET ${path}`)
    }
  }
  await fixtureInternal.runQc005(
    api,
    browser.page,
    {},
    record,
    '/tmp/wms-qc-unit',
    { openRoute: browser.openRoute, saveScreenshot: browser.saveScreenshot },
    {
      marker: 'E2E-QC-005',
      material: { id: formalIds.materialId, unitId: formalIds.unitId },
      warehouse: { id: formalIds.warehouseId },
      area: { id: formalIds.areaId },
      location: { id: formalIds.locationId }
    }
  )
  const approval = calls.find(([method, path]) => method === 'PUT-BUSINESS' && path === '/mes/stkIo/check')
  assert.deepEqual(approval[2], {
    id: '9223372036854775813',
    approvalResultType: '1',
    approvalRemark: 'E2E-QC-005 approve opening'
  })
  assert.equal(record.checks.find((check) => check.name === '106 期初生效后直接编辑被正式 API 拒绝').passed, true)
  assert.equal(record.checks.find((check) => check.name === '106 期初错误修正红冲链路').passed, false)
  assert.equal(WMS_QC_DEFERRED_CONTRACTS.redInvoice.status, 'DEFERRED')
})

test('QC-010 verifies all four retired ERP warehouse writes with code 1030400002', async () => {
  const record = caseRecord()
  const browser = pageHarness('仓库 仓库编码 E2E-QC-010')
  const calls = []
  const retired = { code: 1030400002, msg: '旧 ERP 仓库写接口已退役' }
  const api = {
    async getBusiness(path) {
      calls.push(['GET-BUSINESS', path])
      return ok({ list: [{ id: '9223372036854775814', name: 'E2E warehouse', status: 1 }] })
    },
    async post(path, body) {
      calls.push(['POST', path, body])
      return retired
    },
    async put(path, body) {
      calls.push(['PUT', path, body])
      return retired
    },
    async delete(path) {
      calls.push(['DELETE', path])
      return retired
    }
  }
  await fixtureInternal.runQc010(
    api,
    browser.page,
    {},
    record,
    '/tmp/wms-qc-unit',
    { openRoute: browser.openRoute, saveScreenshot: browser.saveScreenshot },
    { marker: 'E2E-QC-010' }
  )
  assert.equal(record.checks.find((check) => check.name === '旧 ERP 仓库四个写接口统一返回退役错误码').passed, true)
  assert.equal(record.checks.filter((check) => check.name.includes('写侧') && check.name.includes('退役错误码')).length, 4)
  assert.equal(calls.filter(([method]) => ['POST', 'PUT', 'DELETE'].includes(method)).length, 4)
})

test('formal cleanup retains ERP orders and returns without void or delete', async () => {
  const calls = []
  const api = {
    async putBusiness(path, body) {
      calls.push(['PUT', path, body])
      return ok(true)
    },
    async deleteBusiness(path) {
      calls.push(['DELETE', path])
      return ok(true)
    }
  }
  const record = {
    fixtures: [
      { kind: 'purchaseOrder', id: '1', marker: 'm' },
      { kind: 'saleOrder', id: '2', marker: 'm' },
      { kind: 'purchaseReturn', id: '3', marker: 'm' },
      { kind: 'saleReturn', id: '4', marker: 'm' }
    ],
    notes: []
  }
  await fixtureInternal.cleanupOwnedFormalFixtures(api, record)
  assert.deepEqual(calls, [])
  assert.equal(record.fixtures.every((item) => item.retained === true), true)
  assert.equal(record.notes.some((note) => note.includes('不删除库存事实')), true)
})

test('suite only activates the dedicated WMS-QC fixture behind an explicit switch', async () => {
  const previousWrite = process.env.CFOR_E2E_WRITE_FIXTURES
  const previousEnable = process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE
  delete process.env.CFOR_E2E_WRITE_FIXTURES
  delete process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE
  try {
    let apiCreated = 0
    let apiCalls = 0
    const result = await runCase(
      {
        caseId: 'WMS-QC-001',
        page: {},
        record: {},
        caseRecord: caseRecord(),
        outputDir: '/tmp/wms-qc-unit'
      },
      {
        runWmsQcClosure: true,
        settings: localSettings,
        login: async () => 'unit-token',
        createApiClient: () => {
          apiCreated += 1
          return new Proxy({}, {
            get: () => async () => {
              apiCalls += 1
              throw new Error('write fixture must stop before API access')
            }
          })
        }
      }
    )
    assert.equal(result.partial, true)
    assert.equal(apiCreated, 1)
    assert.equal(apiCalls, 0)
  } finally {
    if (previousWrite === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
    else process.env.CFOR_E2E_WRITE_FIXTURES = previousWrite
    if (previousEnable === undefined) delete process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE
    else process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE = previousEnable
  }
})
