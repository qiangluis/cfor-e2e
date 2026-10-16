import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  PROCUREMENT_016_ACCEPTANCE_GAPS,
  PROCUREMENT_016_CONTRACTS,
  PROCUREMENT_016_PAGE_EVIDENCE,
  assertProcurement016Rejection,
  assertProcurement016Unchanged,
  captureProcurement016PageEvidence,
  canonicalSnapshot,
  exactProcurement016Rejection,
  procurement016TestHooks
} from '../fixtures/procurement-016-opening-closure.mjs'

const ok = (data) => ({ code: 0, data })

const procurementSuiteSource = fs.readFileSync(
  new URL('../suites/procurement.mjs', import.meta.url), 'utf8')
const catalogSource = JSON.parse(fs.readFileSync(
  new URL('../cases/catalog.json', import.meta.url), 'utf8'))

test('PROC-016 exposes one evidence mapping per acceptance gap', () => {
  assert.deepEqual(PROCUREMENT_016_ACCEPTANCE_GAPS.map((item) => item.index), [0, 1, 2, 3])
  assert.ok(PROCUREMENT_016_ACCEPTANCE_GAPS.every((item) => item.assertion && item.evidence))
  assert.equal(PROCUREMENT_016_PAGE_EVIDENCE.route, '/erp/purchase/invoice')
  assert.deepEqual(PROCUREMENT_016_PAGE_EVIDENCE.fields,
    ['srcBillType', 'srcBillId', 'details', 'isEffective'])
})

test('PROC-016 suite branch is write-gated, page-evidence-backed and maps all four catalog assertions', () => {
  const start = procurementSuiteSource.indexOf("if (caseId === 'PROC-016')")
  const end = procurementSuiteSource.indexOf("if (caseId === 'PROC-017')", start)
  const branch = procurementSuiteSource.slice(start, end)
  assert.match(procurementSuiteSource, /createProcurement016OpeningClosureFixture/)
  assert.match(branch, /CFOR_E2E_WRITE_FIXTURES/)
  assert.match(branch, /assertLocalWriteSafety\(caseRecord\)/)
  assert.match(branch, /pageEvidence\.status === 'VERIFIED'/)
  assert.match(branch, /existing-report-only:/)
  assert.match(branch, /procurementCatalogEvidence\('PROC-016'/)
  assert.equal(catalogSource.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'PROC-016').assertions.length, 4)
})

test('exact historical rejection requires the domain code/message and data:null', () => {
  const accepted = {
    code: PROCUREMENT_016_CONTRACTS.historicalOrderPayable.code,
    msg: '来源采购订单已存在历史应付单(YF-1)，为避免重复挂账，请先处理历史应付',
    data: null
  }
  assert.equal(exactProcurement016Rejection(accepted, PROCUREMENT_016_CONTRACTS.historicalOrderPayable), true)
  assert.doesNotThrow(() => assertProcurement016Rejection(
    accepted, PROCUREMENT_016_CONTRACTS.historicalOrderPayable, 'history'))
  for (const leaked of [
    { ...accepted, data: { id: 'source-leak' } },
    { ...accepted, code: 500, msg: 'Internal Server Error' },
    { ...accepted, msg: '没有权限' }
  ]) {
    assert.equal(exactProcurement016Rejection(leaked, PROCUREMENT_016_CONTRACTS.historicalOrderPayable), false)
  }
})

test('full snapshots compare nested source facts without Number coercion', () => {
  const before = {
    id: '9223372036854775807',
    details: { '9223372036854775806': '10.00' },
    entries: [{ srcBillId: '9223372036854775805', amt: '10.00' }]
  }
  const same = JSON.parse(JSON.stringify(before))
  assert.equal(canonicalSnapshot(before), canonicalSnapshot(same))
  assert.doesNotThrow(() => assertProcurement016Unchanged(before, same, 'snowflake'))
  assert.throws(() => assertProcurement016Unchanged(before, {
    ...same,
    entries: [{ ...same.entries[0], srcBillId: '9223372036854775804' }]
  }, 'snowflake'), /完整快照不一致/)
})

test('stableId accepts exact strings and safe integers but rejects unsafe snowflake numbers', () => {
  assert.equal(procurement016TestHooks.stableId('9223372036854775807'), '9223372036854775807')
  assert.equal(procurement016TestHooks.stableId(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER))
  assert.equal(procurement016TestHooks.stableId(Number.MAX_SAFE_INTEGER + 1), null)
  assert.equal(procurement016TestHooks.stableId(9223372036854775807), null)
  for (const value of [0, -1, '', ' 1001', '1.0', null, undefined, {}, 1.5]) {
    assert.equal(procurement016TestHooks.stableId(value), null, `value=${String(value)}`)
  }
})

test('PROC-016 purchase-order approval contract submits draft with status=10 only', async () => {
  const calls = []
  let order = {
    id: '1001',
    status: PROCUREMENT_016_CONTRACTS.purchaseOrderApproval.draftStatus,
    billStage: '12',
    processInstanceId: null
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      return ok(order)
    },
    async putBusiness (path) {
      calls.push(['PUT-BUSINESS', path])
      assert.equal(path,
        `/erp/purchase-order/update-status?id=1001&status=${PROCUREMENT_016_CONTRACTS.purchaseOrderApproval.submitStatus}`)
      assert.equal(path.includes('status=20'), false)
      order = { ...order, status: 10, billStage: '22', processInstanceId: 'proc-1001' }
      return ok(true)
    }
  }
  const result = await procurement016TestHooks.ensureProcurement016PurchaseOrderSubmitted(api, '1001', 'contract')
  assert.equal(result.action, 'formal-submit')
  assert.equal(result.submitted, true)
  assert.equal(result.order.processInstanceId, 'proc-1001')
  assert.equal(calls.filter(([method]) => method === 'PUT-BUSINESS').length, 1)
})

test('PROC-016 purchase-order approval contract reuses an existing formal BPM instance', async () => {
  const calls = []
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      return ok({ id: '1002', status: 0, billStage: '22', processInstanceId: 'proc-1002' })
    },
    async putBusiness (path) {
      calls.push(['PUT-BUSINESS', path])
      throw new Error(`existing BPM must not submit again: ${path}`)
    }
  }
  const result = await procurement016TestHooks.ensureProcurement016PurchaseOrderSubmitted(api, '1002', 'existing-bpm')
  assert.equal(result.action, 'existing-formal-bpm')
  assert.equal(result.submitted, false)
  assert.equal(calls.filter(([method]) => method === 'PUT-BUSINESS').length, 0)
})

test('PROC-016 purchase-order approval contract never reverse-approves an already approved order', async () => {
  const calls = []
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      return ok({ id: '1003', status: PROCUREMENT_016_CONTRACTS.purchaseOrderApproval.approvedStatus, isEffective: 1, billStage: '24' })
    },
    async putBusiness (path) {
      calls.push(['PUT-BUSINESS', path])
      throw new Error(`approved order must not reverse-approve: ${path}`)
    }
  }
  const result = await procurement016TestHooks.ensureProcurement016PurchaseOrderSubmitted(api, '1003', 'approved')
  assert.equal(result.action, 'already-approved')
  assert.equal(result.submitted, false)
  assert.equal(calls.filter(([method]) => method === 'PUT-BUSINESS').length, 0)
})

test('PROC-016 creates dedicated material and warehouse through formal APIs and records zero stock baseline', async () => {
  const tag = 'PROC016-DEDICATED-UNIT'
  const ids = {
    unit: '9223372036854775801',
    material: '9223372036854775802',
    warehouse: '9223372036854775803'
  }
  const calls = []
  const api = {
    async getBusiness (path) {
      calls.push({ method: 'GET', path })
      if (path === '/mes/basUnit/list/enabled') return ok([{ id: ids.unit, name: 'kg', isEnabled: 1 }])
      if (path === '/mes/wmsWareHouse/allTree') {
        return ok([{ id: ids.warehouse, code: `${tag}-WH`, name: `${tag}-PROCUREMENT-WH`, mark: tag }])
      }
      if (path === `/mes/wmsWareHouse/queryById?id=${ids.warehouse}`) {
        return ok({ id: ids.warehouse, code: `${tag}-WH`, name: `${tag}-PROCUREMENT-WH`, mark: tag, isEnabled: true })
      }
      if (path === `/mes/basMaterial/queryById?id=${ids.material}`) {
        return ok({ id: ids.material, code: `${tag}-MAT`, name: `${tag}-PROCUREMENT-MATERIAL`,
          unitId: ids.unit, remark: tag, isEnabled: 1 })
      }
      if (path === `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${ids.material}&warehouseId=${ids.warehouse}`) {
        return ok({ list: [], total: 0 })
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      calls.push({ method: 'POST', path, body })
      if (path === '/mes/basMaterial/add') return ok(ids.material)
      if (path === '/mes/wmsWareHouse/add') return ok(true)
      throw new Error(`unexpected POST ${path}`)
    }
  }
  const fixture = { tag, cleanupPlan: [], resources: [] }
  const result = await procurement016TestHooks.createDedicatedResources(api, fixture, tag)
  assert.equal(result.unitId, ids.unit)
  assert.equal(result.material.id, ids.material)
  assert.equal(result.warehouse.id, ids.warehouse)
  assert.deepEqual(result.stockBaseline, { total: 0, rows: [] })
  const materialAdd = calls.find((call) => call.path === '/mes/basMaterial/add')
  const warehouseAdd = calls.find((call) => call.path === '/mes/wmsWareHouse/add')
  assert.equal(materialAdd.body.code, `${tag}-MAT`)
  assert.equal(materialAdd.body.remark, tag)
  assert.equal(materialAdd.body.unitId, ids.unit)
  assert.equal(warehouseAdd.body.code, `${tag}-WH`)
  assert.equal(warehouseAdd.body.name, `${tag}-PROCUREMENT-WH`)
  assert.equal(warehouseAdd.body.mark, tag)
  assert.equal(warehouseAdd.body.areaEnabled, false)
  assert.equal(warehouseAdd.body.locationEnabled, false)
  assert.equal(calls.some((call) => call.path.includes('/mes/basMaterial/list/')), false)
  assert.deepEqual(fixture.resources.map((resource) => [resource.kind, resource.id, resource.ownership]), [
    ['unit', ids.unit, 'shared-readonly-dependency'],
    ['material', ids.material, 'dedicated'],
    ['warehouse', ids.warehouse, 'dedicated']
  ])
  assert.equal(fixture.cleanupPlan.some((item) => item.kind === 'unit'), false)
  assert.equal(fixture.cleanupPlan.filter((item) => item.kind === 'material').length, 1)
  assert.equal(fixture.cleanupPlan.filter((item) => item.kind === 'warehouse').length, 1)
})

test('PROC-016 stock baseline rejects missing pagination shape instead of treating it as zero', async () => {
  const api = {
    async getBusiness () { return ok({}) }
  }
  await assert.rejects(
    procurement016TestHooks.readDedicatedStockBaseline(api, '9223372036854775802', '9223372036854775803'),
    /缺少明确 list\/records 数组/
  )
})

test('PROC-016 stock baseline rejects any existing dedicated stock row', async () => {
  const api = {
    async getBusiness () {
      return ok({ list: [{ materialId: '9223372036854775802', warehouseId: '9223372036854775803', qty: 0 }], total: 1 })
    }
  }
  await assert.rejects(
    procurement016TestHooks.readDedicatedStockBaseline(api, '9223372036854775802', '9223372036854775803'),
    /必须为零/
  )
})

test('PROC-016 historical payable request includes a tag-scoped bill number on main and entry', async () => {
  const tag = 'PROC016-HISTORICAL-BILL-NO'
  const order = {
    orderId: '9223372036854775801',
    approved: { billNo: 'PO-PROC016-001' },
    item: { id: '9223372036854775802' }
  }
  const material = {
    id: '9223372036854775803',
    unitId: '9223372036854775804'
  }
  const calls = []
  let requestBody
  const api = {
    async postBusiness (path, body) {
      calls.push(['POST', path, body])
      assert.equal(path, '/finance/finPayable/add/submit')
      requestBody = body
      return ok('9223372036854775805')
    },
    async getBusiness (path) {
      calls.push(['GET', path])
      assert.equal(path, '/finance/finPayable/queryById?id=9223372036854775805')
      return ok({
        id: '9223372036854775805',
        srcBillType: 'PurOrder',
        srcBillId: order.orderId,
        isVoided: 0
      })
    }
  }

  const result = await procurement016TestHooks.createHistoricalPayable(
    api, { cleanupPlan: [] }, { tag, supplierId: '9223372036854775806', order, material })

  const expectedBillNo = `${tag}-HISTORICAL-PAYABLE`
  assert.equal(result.payableId, '9223372036854775805')
  assert.equal(requestBody.billNo, expectedBillNo)
  assert.equal(requestBody.payableType, '201')
  assert.equal(requestBody.srcBillType, 'PurOrder')
  assert.equal(requestBody.srcBillId, order.orderId)
  assert.equal(requestBody.srcNo, order.approved.billNo)
  assert.equal(requestBody.finPayableEntryList.length, 1)
  assert.equal(requestBody.finPayableEntryList[0].billNo, expectedBillNo)
  assert.equal(requestBody.finPayableEntryList[0].srcBillType, 'PurOrder')
  assert.equal(requestBody.finPayableEntryList[0].srcBillId, order.orderId)
  assert.equal(requestBody.finPayableEntryList[0].srcEntryId, order.item.id)
  assert.equal(requestBody.finPayableEntryList[0].srcNo, `${order.approved.billNo}:1`)
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1)
})

test('positive approval transition keeps source identity and full snapshots', () => {
  const before = {
    order: { id: '1001', totalPrice: '10.00', invoicedCount: 0 },
    invoice: {
      id: '2001', srcBillType: 'ERP_PURCHASE_ORDER', srcBillId: '1001',
      details: '{"1001":10}', invoiceMoney: '10.00', isEffective: 0
    }
  }
  const after = {
    ...before,
    order: { ...before.order, invoicedCount: 1 },
    invoice: { ...before.invoice, isEffective: 1, billStage: '20' },
    payable: { id: '3001', srcBillType: 'PurInvoice', srcBillId: '2001', amt: '10.00' }
  }
  const generated = [after.payable]
  assert.doesNotThrow(() => procurement016TestHooks.assertProcurement016ApprovedTransition(
    before, after, generated, '2001', 'positive'))
  assert.notEqual(canonicalSnapshot(before), canonicalSnapshot(after))
  assert.equal(after.invoice.srcBillId, before.invoice.srcBillId)
})

test('page evidence helpers require one dedicated invoice and all source fields', () => {
  const invoice = {
    invoiceId: '9223372036854775807',
    created: {
      id: '9223372036854775807',
      invoiceNo: 'PROC016-HIST-INV',
      srcBillType: 'ERP_PURCHASE_ORDER',
      srcBillId: '9223372036854775806',
      details: '{"9223372036854775806":10}',
      isEffective: 0
    }
  }
  const rows = [invoice.created]
  assert.deepEqual(procurement016TestHooks.findUniqueProcurement016Invoice(rows, invoice), invoice.created)
  assert.equal(procurement016TestHooks.findUniqueProcurement016Invoice([...rows, invoice.created], invoice), null)
  assert.doesNotThrow(() => procurement016TestHooks.assertProcurement016InvoiceDetail(
    invoice.created, invoice, 'detail'))
  assert.throws(() => procurement016TestHooks.assertProcurement016InvoiceDetail(
    { ...invoice.created, details: '{}' }, invoice, 'detail'), /明细或生效字段/)
  assert.throws(() => procurement016TestHooks.assertProcurement016InvoiceDetail(
    { ...invoice.created, data: { id: 'leaked' }, srcBillId: 'other' }, invoice, 'detail'), /来源、明细/)
})

test('page evidence uses dedicated row, rendered detail dialog and review control', async () => {
  const invoice = {
    invoiceId: '2001',
    created: {
      id: '2001', invoiceNo: 'PROC016-HIST-INV', srcBillType: 'ERP_PURCHASE_ORDER',
      srcBillId: '1001', details: '{"1001":10}', isEffective: 0
    }
  }
  const response = (payload) => ({
    url: () => 'http://127.0.0.1:48083/admin-api/erp/purchase-invoice/page',
    async text () { return JSON.stringify(payload) },
    headers () { return {} }
  })
  const button = (label) => ({
    async click () {},
    async count () { return 1 },
    async innerText () { return label },
    first () { return this }
  })
  const row = {
    async count () { return 1 },
    async waitFor () {},
    first () { return this },
    getByRole (_role, options) { return button(options.name instanceof RegExp ? '审核' : options.name) }
  }
  let responseNo = 0
  const page = {
    getByPlaceholder () { return { first () { return { async fill () {} } } } },
    getByRole () { return { first () { return button('搜索') } } },
    waitForResponse () {
      responseNo += 1
      return Promise.resolve(response({ code: 0, data: { list: [invoice.created] } }))
    },
    locator (selector) {
      if (selector === '.vxe-table--main-wrapper .vxe-body--row') return { filter () { return row } }
      if (selector === '.el-dialog:visible') return {
        last () {
          return {
            async waitFor () {},
            async innerText () { return `采购发票 ${invoice.created.invoiceNo}` }
          }
        }
      }
      return { async innerText () { return `采购发票 ${invoice.created.invoiceNo}` } }
    },
    url () { return 'http://127.0.0.1:9151/erp/purchase/invoice' }
  }
  const screenshots = []
  const evidence = await captureProcurement016PageEvidence({
    page,
    invoice,
    openRoute: async () => {},
    saveScreenshot: async (_page, _dir, name) => screenshots.push(name),
    outputDir: '/tmp/unit-only',
    record: { screenshots: [] }
  })
  assert.equal(responseNo, 1)
  assert.equal(evidence.status, 'VERIFIED')
  assert.equal(evidence.uniqueInvoiceId, '2001')
  assert.equal(evidence.reviewEntry, '审核')
  assert.deepEqual(screenshots, [PROCUREMENT_016_PAGE_EVIDENCE.screenshotName])
})

test('page evidence reports a GAP when dedicated invoice row cannot be found', async () => {
  const invoice = { invoiceId: '2001', created: { id: '2001', invoiceNo: 'PROC016-MISSING' } }
  const page = {
    getByPlaceholder () { return { first () { return { async fill () {} } } } },
    getByRole () { return { first () { return { async click () {} } } } },
    waitForResponse () {
      return Promise.resolve({
        url: () => 'http://127.0.0.1/admin-api/erp/purchase-invoice/page',
        async text () { return JSON.stringify({ code: 0, data: { list: [] } }) },
        headers () { return {} }
      })
    }
  }
  const evidence = await captureProcurement016PageEvidence({
    page,
    invoice,
    openRoute: async () => {},
    saveScreenshot: async () => assert.fail('missing invoice must not be captured as verified')
  })
  assert.equal(evidence.status, 'GAP')
  assert.match(evidence.reason, /未在唯一分页行中命中/)
})

test('page evidence rejects a dedicated row without a review entry', async () => {
  const invoice = {
    invoiceId: '2001',
    created: {
      id: '2001', invoiceNo: 'PROC016-NO-REVIEW', srcBillType: 'ERP_PURCHASE_ORDER',
      srcBillId: '1001', details: '{"1001":10}', isEffective: 0
    }
  }
  const button = (count) => ({
    first () { return this },
    async count () { return count },
    async click () {}
  })
  const page = {
    getByPlaceholder () { return { first () { return { async fill () {} } } } },
    getByRole (_role, options) { return { first () { return button(options.name === '搜索' ? 1 : 0) } } },
    waitForResponse () {
      return Promise.resolve({
        url: () => 'http://127.0.0.1/admin-api/erp/purchase-invoice/page',
        async text () { return JSON.stringify({ code: 0, data: { list: [invoice.created] } }) },
        headers () { return {} }
      })
    },
    locator () {
      return {
        filter () {
          return {
            first () { return this },
            async waitFor () {},
            async count () { return 1 },
            getByRole (_role, options) { return button(options.name === '详情' ? 1 : 0) }
          }
        }
      }
    }
  }
  const evidence = await captureProcurement016PageEvidence({
    page,
    invoice,
    openRoute: async () => {},
    saveScreenshot: async () => assert.fail('missing review entry must not be captured')
  })
  assert.equal(evidence.status, 'GAP')
  assert.match(evidence.reason, /缺少详情或审核\/提审复核入口/)
})

test('page contract rejects malformed pagination instead of treating it as empty evidence', () => {
  assert.throws(() => procurement016TestHooks.requirePageRows(ok({}), 'malformed'), /records\/list 数组/)
  assert.deepEqual(procurement016TestHooks.requirePageRows(ok({ records: [] }), 'empty'), [])
  assert.deepEqual(procurement016TestHooks.requirePageRows(ok({ list: [{ id: '1' }] }), 'list'), [{ id: '1' }])
})

test('page evidence is explicitly deferred without a headed page and never performs writes', async () => {
  const evidence = await captureProcurement016PageEvidence()
  assert.equal(evidence.status, 'DEFERRED')
  assert.match(evidence.reason, /未注入真实页面/)
})

test('historical rejection probe keeps source/order/payable state unchanged and rejects leaked data', async () => {
  const calls = []
  const state = {
    order: { id: '1001', billNo: 'PO-1001', totalPrice: '10.00', status: 20 },
    invoice: {
      id: '2001', srcBillType: 'ERP_PURCHASE_ORDER', srcBillId: '1001',
      details: '{"1001":10}', isEffective: 0, billStage: '14'
    },
    payable: {
      id: '3001', srcBillType: 'PurOrder', srcBillId: '1001',
      amt: '10.00', checkedAmt: '0.00', isVoided: 0
    }
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/erp/purchase-order/get?id=1001') return ok(state.order)
      if (path === '/erp/purchase-invoice/get?id=2001') return ok(state.invoice)
      if (path === '/finance/finPayable/queryById?id=3001') return ok(state.payable)
      if (path === '/finance/finPayable/getPayableByPurId?id=1001') return ok([state.payable])
      if (path === '/finance/finPayable/getPayableByPurId?id=2001') return ok([])
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      calls.push(['POST', path, body])
      if (path === '/erp/purchase-order/create') return ok('1001')
      if (path === '/finance/finPayable/add/submit') return ok('3001')
      if (path === '/erp/purchase-invoice/create') return ok('2001')
      throw new Error(`unexpected POST ${path}`)
    },
    async putBusiness (path) {
      calls.push(['PUT-BUSINESS', path])
      if (path.includes('/erp/purchase-order/update-status')) {
        throw new Error(`PROC-016 order approval must not use reverse-approval status: ${path}`)
      }
      throw new Error(`unexpected PUT business ${path}`)
    },
    async put (path, body, options) {
      calls.push(['PUT', path, body, options])
      assert.equal(body, undefined)
      assert.equal(options.expectedBusinessRejection.code,
        PROCUREMENT_016_CONTRACTS.historicalOrderPayable.code)
      return {
        code: 1_030_102_040,
        msg: '来源采购订单已存在历史应付单(YF-HIST)，为避免重复挂账，请先处理历史应付',
        data: null
      }
    }
  }
  const fixture = { cleanupPlan: [] }
  const result = await procurement016TestHooks.runHistoricalOrderPayableScenario(api, fixture, {
    tag: 'PROC016-MOCK',
    supplierId: '7001',
    material: { id: '8001', unitId: '9001' },
    suffix: 'MOCK'
  })
  assert.equal(result.rejected.code, 1_030_102_040)
  assert.equal(result.duplicate.code, 1_030_102_040)
  assert.equal(calls.filter(([method]) => method === 'PUT').length, 2)
  assert.equal(result.snapshots.before, canonicalSnapshot(state))
  assert.equal(result.snapshots.before, result.snapshots.after)
  assert.equal(result.snapshots.after, result.snapshots.duplicateAfter)
})

test('no-historical scenario creates one PurInvoice payable and rejects repeated approval unchanged', async () => {
  const calls = []
  const state = {
    order: { id: '1101', billNo: 'PO-1101', totalPrice: '10.00', status: 20 },
    invoice: {
      id: '2101', srcBillType: 'ERP_PURCHASE_ORDER', srcBillId: '1101',
      details: '{"1101":10}', isEffective: 0, billStage: '14'
    },
    payables: []
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/erp/purchase-order/get?id=1101') return ok(state.order)
      if (path === '/erp/purchase-invoice/get?id=2101') return ok(state.invoice)
      if (path === '/finance/finPayable/getPayableByPurId?id=1101') return ok([])
      if (path === '/finance/finPayable/getPayableByPurId?id=2101') return ok(state.payables)
      if (path === '/finance/finPayable/queryById?id=3101') return ok(state.payables[0])
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path) {
      calls.push(['POST', path])
      if (path === '/erp/purchase-order/create') return ok('1101')
      if (path === '/erp/purchase-invoice/create') return ok('2101')
      throw new Error(`unexpected POST ${path}`)
    },
    async putBusiness (path) {
      calls.push(['PUT-BUSINESS', path])
      if (path.includes('/erp/purchase-order/update-status')) {
        throw new Error(`PROC-016 order approval must not use reverse-approval status: ${path}`)
      }
      if (path === '/erp/purchase-invoice/update-status?id=2101') {
        state.invoice = { ...state.invoice, isEffective: 1, billStage: '20' }
        state.payables = [{ id: '3101', srcBillType: 'PurInvoice', srcBillId: '2101', amt: '10.00' }]
        return ok(true)
      }
      throw new Error(`unexpected PUT business ${path}`)
    },
    async put (path, body, options) {
      calls.push(['PUT', path, body, options])
      assert.equal(options.expectedBusinessRejection.code, PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved.code)
      return {
        code: 1_030_102_003,
        msg: '审核失败，只有未审核的采购发票才能审核',
        data: null
      }
    }
  }
  const result = await procurement016TestHooks.runNoHistoricalPayableScenario(api, { cleanupPlan: [] }, {
    tag: 'PROC016-MOCK',
    supplierId: '7001',
    material: { id: '8001', unitId: '9001' },
    suffix: 'ABSENT'
  })
  assert.equal(result.generated.length, 1)
  assert.equal(result.generated[0].srcBillType, 'PurInvoice')
  assert.equal(result.duplicate.code, PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved.code)
})

test('opening scenario skips historical-order rejection and preserves source/payable identity', async () => {
  const state = {
    opening: { id: '4101', businessType: 'OPENING', status: 20, invoicedCount: 0, invoicedPrice: '0.00' },
    invoice: {
      id: '5101', srcBillType: 'OPENING_PURCHASE_IN', srcBillId: '4101',
      details: '{"4101":10}', isEffective: 0, billStage: '14'
    },
    payables: []
  }
  const api = {
    async getBusiness (path) {
      if (path === '/erp/purchase-in/get?id=4101') return ok(state.opening)
      if (path === '/erp/purchase-invoice/get?id=5101') return ok(state.invoice)
      if (path === '/finance/finPayable/queryById?id=6101') return ok(state.payables[0])
      if (path === '/finance/finPayable/getPayableByPurId?id=5101') return ok(state.payables)
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path) {
      if (path === '/erp/purchase-in/create') return ok('4101')
      if (path === '/erp/purchase-invoice/create') return ok('5101')
      throw new Error(`unexpected POST ${path}`)
    },
    async putBusiness (path) {
      if (path === '/erp/purchase-in/update-status?id=4101&status=20') return ok(true)
      if (path === '/erp/purchase-invoice/update-status?id=5101') {
        state.opening = { ...state.opening, invoicedCount: 1, invoicedPrice: '10.00' }
        state.invoice = { ...state.invoice, isEffective: 1, billStage: '20' }
        state.payables = [{ id: '6101', srcBillType: 'PurInvoice', srcBillId: '5101', amt: '10.00' }]
        return ok(true)
      }
      throw new Error(`unexpected PUT business ${path}`)
    },
    async put (_path, _body, options) {
      assert.equal(options.expectedBusinessRejection.code, PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved.code)
      return { code: 1_030_102_003, msg: '审核失败，只有未审核的采购发票才能审核', data: null }
    }
  }
  const result = await procurement016TestHooks.runOpeningInvoiceScenario(api, { cleanupPlan: [] }, {
    tag: 'PROC016-MOCK',
    supplierId: '7001',
    accountId: '7201',
    warehouseId: '7301',
    material: { id: '8001', unitId: '9001' }
  })
  assert.equal(result.generated.length, 1)
  assert.equal(result.generated[0].srcBillType, 'PurInvoice')
  assert.equal(result.generated[0].srcBillId, '5101')
  assert.equal(result.duplicate.code, PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved.code)
})

test('opening scenario contract remains separate from historical order source', () => {
  assert.equal(PROCUREMENT_016_CONTRACTS.historicalOrderPayable.code, 1_030_102_040)
  assert.equal(PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved.code, 1_030_102_003)
  assert.equal(PROCUREMENT_016_PAGE_EVIDENCE.route, '/erp/purchase/invoice')
})
