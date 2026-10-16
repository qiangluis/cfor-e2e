import assert from 'node:assert/strict'
import test from 'node:test'

import { __internal, capturePageEvidence } from '../fixtures/wms-qc-closure.mjs'

const ok = (data) => ({ code: 0, data })
const record = () => ({ checks: [], notes: [], evidence: [], fixtures: [] })
const fixture = { material: { id: '202', code: 'MT-Q001' }, warehouse: { id: '201' } }
const inbound = { wms: { id: '203' }, entry: { id: '204', qty: 1 } }
const artifacts = { plan: { planId: '205' } }

function inspectionHarness () {
  const calls = []
  const state = {
    detail: {
      id: '206', billNo: 'QC-Q001', type: '101', srcBillType: 'MesStkIo',
      srcBillId: '203', inspectionPlan: '205', isEffective: 0,
      actions: { edit: true, check: true }
    },
    entries: [{
      id: '207', mid: '206', materialId: '202', srcEntryId: '204',
      srcBillId: '203', srcBillType: 'MesStkIo', qty: 1
    }],
    items: [{ id: '208', mid: '206', entryId: '207', itemId: '209' }],
    inventory: [{
      id: '210', materialId: '202', warehouseId: '201', qty: 1,
      availableQty: 0, lockQty: 0, holdQty: 1, frozenQty: 0, pendingPutawayQty: 0
    }]
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path.startsWith('/mes/stkInventory/list?')) {
        return ok({ records: state.inventory, total: state.inventory.length })
      }
      if (path.startsWith('/mes/quality/qualityInspection/list/')) {
        return ok({ records: [state.detail], total: 1 })
      }
      if (path.includes('/queryById/')) return ok(state.detail)
      if (path.includes('queryMesQualityInspectionEntryByMainId')) return ok(state.entries)
      if (path.includes('queryMesQualityInspectionItemByMainId')) return ok(state.items)
      throw new Error(`unexpected GET ${path}`)
    },
    async putBusiness (path, payload) {
      calls.push(['PUT-BUSINESS', path, payload])
      assert.equal(path, '/mes/quality/qualityInspection/edit/submit')
      state.detail = { ...state.detail, inspectionResult: payload.inspectionResult }
      state.entries = payload.qualityInspectionEntryList
      state.items = payload.qualityInspectionItemList
      return ok(true)
    },
    async put (path, payload) {
      calls.push(['PUT', path, payload])
      assert.equal(path, '/mes/quality/qualityInspection/check')
      if (state.detail.isEffective === 1) {
        return { code: 500, message: 'QC-Q001：单据不能做该操作，可能被其他用户改变了状态！' }
      }
      state.detail.isEffective = 1
      state.detail.actions = { edit: false }
      state.inventory[0].holdQty = 0
      state.inventory[0].pendingPutawayQty = 0
      state.inventory[0].availableQty = 1
      return ok(true)
    }
  }
  return { api, state, calls }
}

test('QC001 manually releases only held stock with exact source and preserved before/after snapshots', async () => {
  const { api, state, calls } = inspectionHarness()
  const caseRecord = record()
  await __internal.releaseInboundInspection(api, caseRecord, fixture, inbound, artifacts)
  assert.equal(caseRecord.checks.every((check) => check.passed), true)
  const snapshot = caseRecord.inventorySnapshots[0]
  assert.equal(snapshot.before[0].holdQty, 1)
  assert.equal(snapshot.before[0].availableQty, 0)
  assert.equal(snapshot.after[0].holdQty, 0)
  assert.equal(snapshot.after[0].availableQty, 1)
  assert.equal(snapshot.inspectionId, '206')
  assert.equal(snapshot.sourceBillId, '203')
  state.inventory[0].availableQty = 999
  assert.equal(snapshot.after[0].availableQty, 1)
  assert.equal(calls.filter(([method]) => method === 'PUT-BUSINESS').length, 1)
  assert.equal(calls.filter(([method]) => method === 'PUT').length, 2)
  assert.equal(calls.find(([method]) => method === 'PUT-BUSINESS')[2].srcBillType, 'MesStkIo')
})

test('QC001 rejects mixed available, lock or frozen quantities before any manual write', async () => {
  for (const key of ['availableQty', 'lockQty', 'frozenQty']) {
    const { api, state, calls } = inspectionHarness()
    state.inventory[0].holdQty = 0
    state.inventory[0][key] = 1
    const caseRecord = record()
    await assert.rejects(__internal.releaseInboundInspection(api, caseRecord, fixture, inbound, artifacts),
      /缺少隔离库存/)
    assert.equal(caseRecord.checks[0].passed, false)
    assert.equal(calls.some(([method]) => method.startsWith('PUT')), false)
  }
})

test('QC001 accepts pending-putaway but never excess or incomplete quantity as the held control', async () => {
  const pending = inspectionHarness()
  pending.state.inventory[0].holdQty = 0
  pending.state.inventory[0].pendingPutawayQty = 1
  const caseRecord = record()
  await __internal.releaseInboundInspection(pending.api, caseRecord, fixture, inbound, artifacts)
  assert.equal(caseRecord.checks.every((check) => check.passed), true)
  for (const qty of [0.5, 2]) {
    const { api, state, calls } = inspectionHarness()
    state.inventory[0].holdQty = qty
    state.inventory[0].qty = qty
    await assert.rejects(__internal.releaseInboundInspection(api, record(), fixture, inbound, artifacts),
      /缺少隔离库存/)
    assert.equal(calls.some(([method]) => method.startsWith('PUT')), false)
  }
})

test('QC001 rejects a foreign inspection source, plan or item before submitting any result', async () => {
  for (const [change, expected] of [
    [(state) => { state.detail.srcBillType = 'StkIo:101' }, /必须有且只有一张正式采购入库检，实际=0/],
    [(state) => { state.detail.inspectionPlan = '999' }, /来源、方案或明细不完整/],
    [(state) => { state.entries[0].srcEntryId = '999' }, /来源、方案或明细不完整/],
    [(state) => { state.items[0].entryId = '999' }, /来源、方案或明细不完整/]
  ]) {
    const { api, state, calls } = inspectionHarness()
    change(state)
    await assert.rejects(__internal.releaseInboundInspection(api, record(), fixture, inbound, artifacts), expected)
    assert.equal(calls.some(([method]) => method.startsWith('PUT')), false)
  }
})

function pageHarness ({ body = '库存 可用 锁定 MT-Q001', visibleSample = true } = {}) {
  let route = 'about:blank'
  const calls = []
  const page = {
    url: () => route,
    getByPlaceholder (placeholder, options) {
      calls.push(['placeholder', placeholder, options])
      return {
        async fill (value) { calls.push(['fill', value]) },
        async press (key) { calls.push(['press', key]) }
      }
    },
    locator (selector) {
      if (selector === 'body') return { async innerText () { return body } }
      return {
        filter (options) {
          calls.push(['sample', selector, options])
          return {
            first: () => ({
              async waitFor () {
                if (!visibleSample) throw new Error('no dedicated sample rendered')
              }
            })
          }
        }
      }
    }
  }
  return {
    page, calls,
    async openRoute (_page, path, options) {
      calls.push(['open', path, options])
      route = `http://127.0.0.1:9151${path}`
    },
    async saveScreenshot () { calls.push(['screenshot']); return '/tmp/unit.png' }
  }
}

test('page evidence waits for the owned table row, not a filled filter', async () => {
  const browser = pageHarness()
  const caseRecord = record()
  const result = await capturePageEvidence({
    ...browser, caseRecord, route: '/warehouse/stock', marker: 'MT-Q001', fields: ['库存', '可用', '锁定'],
    readySelector: 'input[placeholder="请输入存货编码"]',
    filter: { placeholder: '请输入存货编码', value: 'MT-Q001' }, name: 'qc001-row'
  })
  assert.equal(result.passed, true)
  assert.equal(browser.calls.some(([action, selector, options]) =>
    action === 'sample' && selector === '.vxe-body--row, .el-table__row' && options.hasText === 'MT-Q001'), true)
  assert.deepEqual(browser.calls.find(([action]) => action === 'open')[2],
    { readySelector: 'input[placeholder="请输入存货编码"]', readyText: undefined })
})

test('matching shell text or filter input without a rendered sample never passes', async () => {
  for (const selection of [
    { filter: { placeholder: '请输入存货编码', value: 'MT-Q001' } },
    { sample: { selector: '.material-summary-card__code', value: 'MT-Q001' } }
  ]) {
    const browser = pageHarness({ visibleSample: false })
    const caseRecord = record()
    await assert.rejects(capturePageEvidence({
      ...browser, caseRecord, route: '/quality/order/formDetail/206', marker: 'MT-Q001',
      ...selection
    }), /no dedicated sample/)
    assert.equal(caseRecord.checks.some((check) => check.passed), false)
    assert.equal(browser.calls.some(([action]) => action === 'screenshot'), false)
  }
})

test('QC001 detail evidence requires the source, material, project and qualified conclusion', async () => {
  const fields = ['来源', '检验结论', '全部合格', 'MT-Q001', 'IO-Q001', 'QC-PROJECT']
  for (const missing of [null, 'IO-Q001', 'QC-PROJECT', '全部合格']) {
    const browser = pageHarness({ body: fields.filter((value) => value !== missing).join(' ') })
    const result = await capturePageEvidence({
      ...browser, caseRecord: record(), route: '/quality/order/formDetail/206', marker: 'MT-Q001', fields,
      sample: { selector: '.material-summary-card__code', value: 'MT-Q001' }
    })
    assert.equal(result.passed, missing === null)
    assert.deepEqual(result.missing, missing ? [missing] : [])
  }
})

test('inventory routes are resolved from permissions and missing contracts stop instead of guessing', async () => {
  const route = await __internal.resolveWmsQcMenuRoute({
    async getBusiness () {
      return ok({ menus: [{
        path: '/warehouse', children: [{
          path: 'reports', children: [{
            path: 'standing', component: 'wms/stock/reportForms/standingStock/index'
          }]
        }]
      }] })
    }
  }, 'wms/stock/reportForms/standingStock/index')
  assert.equal(route, '/warehouse/reports/standing')
  await assert.rejects(__internal.resolveWmsQcMenuRoute({
    async getBusiness () { return ok({ menus: [] }) }
  }, 'wms/stock/reportForms/standingStock/index'), /不猜测页面路由/)
})
