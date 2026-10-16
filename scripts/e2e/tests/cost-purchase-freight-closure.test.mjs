import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COST_PURCHASE_FREIGHT_CHECKS,
  assertPurchaseFreightSnapshot,
  buildPurchaseFreightPayable,
  runCostPurchaseFreightClosure
} from '../fixtures/cost-purchase-freight-closure.mjs'

const ok = (data) => ({ code: 0, data })

const fixture = {
  runId: 'cost011-unit',
  tenantId: '1',
  periodId: '9101',
  month: '2208-10',
  suffix: 'UNIT',
  purchaseInId: '9201',
  materialId: '9301',
  unitId: '9401',
  supplierId: '9501',
  remark: 'CFOR-E2E:costScenario:purchase:cost011-unit:UNIT:tenant=1:org=1:month=2208-10'
}

const wmsSource = {
  purchaseIn: { id: fixture.purchaseInId },
  purchaseItem: { id: '9202', count: 2 },
  purchaseItemId: '9202',
  wms: {
    id: '9601', billNo: 'WMS-9601', sourceBillType: 'ErpPurchaseIn',
    sourceBillId: fixture.purchaseInId, stockIoType: '101',
    isEffective: 1, isVoided: 0
  },
  entry: {
    id: '9602', srcEntryId: '9202', materialId: fixture.materialId,
    unitId: fixture.unitId, qty: 2
  }
}

function makeApi ({
  leaveEntries = false,
  failSubmitSuffix,
  afterDelete = ok(null),
  receiptLineAfterCleanup = '9602'
} = {}) {
  const calls = []
  const payables = new Map()
  const orphanEntries = new Map()
  const snapshots = []
  let nextId = 9700
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === `/erp/purchase-in/get?id=${fixture.purchaseInId}`) {
        return ok({ id: fixture.purchaseInId, status: 20, items: [{
          id: '9202', productId: fixture.materialId, productUnitId: fixture.unitId, count: 2
        }] })
      }
      if (path.startsWith('/mes/stkIo/list?')) {
        return ok({ records: [wmsSource.wms], total: 1 })
      }
      if (path === '/mes/stkIo/queryById?id=9601') return ok(wmsSource.wms)
      if (path === '/mes/stkIo/queryEntryByMainId?id=9601') return ok([wmsSource.entry])
      if (path.startsWith('/finance/finPayable/list/201?')) {
        const billNo = decodeURIComponent(path.split('billNo=')[1])
        return ok({ list: [...payables.values()].filter((row) => row.billNo === billNo), total: 1 })
      }
      if (path.startsWith('/finance/finPayable/queryById?id=')) {
        const id = path.split('id=')[1]
        return ok(payables.get(id))
      }
      if (path.startsWith('/finance/finPayable/queryFinPayableSubByMainId?id=')) {
        const id = path.split('id=')[1]
        return ok(payables.get(id)?.finPayableEntryList || orphanEntries.get(id) || [])
      }
      if (path.startsWith('/cost/periods/9101/source-snapshot')) {
        return ok(snapshots.at(-1))
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async get (path, options) {
      calls.push(['RAW-GET', path, options])
      return afterDelete
    },
    async postBusiness (path, body) {
      calls.push(['POST', path, body])
      if (path === '/finance/finPayable/add/save') {
        const id = String(nextId++)
        payables.set(id, {
          ...body, id, billStage: '12', isEffective: 0, isVoided: 0,
          finPayableEntryList: []
        })
        return ok('新增保存成功!')
      }
      if (path.includes('/source-snapshot/purchase/refresh')) {
        const lines = []
        for (const payable of payables.values()) {
          if (Number(payable.isEffective) !== 1) continue
          for (const entry of payable.finPayableEntryList || []) {
            if (Number(entry.freight) > 0) lines.push({
              sourceType: 'PURCHASE_FREIGHT',
              sourceId: payable.id,
              sourceLineId: entry.id,
              sourceNo: payable.billNo,
              sourceVersion: 'MesStkIoDTO:101',
              componentCode: 'PURCHASE_FREIGHT',
              quantity: 0,
              materialAmount: 0,
              expenseAmount: entry.freight,
              // 到岸费用追溯键是 fin_payable 主键，回读口径按应付的上游 src_bill_id 冻结。
              payableKeyScope: 'FREIGHT_PAYABLE',
              payableSourceBillId: wmsSource.wms.id,
              payableNo: payable.billNo,
              payableSettlementStatus: 'UNPAID',
              payableAmount: entry.freight
            })
          }
        }
        lines.push({
          sourceType: 'PURCHASE_RECEIPT',
          sourceId: wmsSource.wms.id,
          sourceLineId: payables.size ? wmsSource.entry.id : receiptLineAfterCleanup,
          quantity: 2,
          materialAmount: 123.45
        })
        const snapshot = { snapshotKey: 'PURCHASE', status: 'DRAFT', lines }
        snapshots.push(snapshot)
        return ok(snapshot)
      }
      throw new Error(`unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      calls.push(['PUT', path, body])
      if (path === '/finance/finPayable/edit/submit') {
        if (body.billNo.endsWith(`-${failSubmitSuffix}`)) {
          throw new Error(`submit failed: ${failSubmitSuffix}`)
        }
        const payable = payables.get(String(body.id))
        payable.finPayableEntryList = body.finPayableEntryList.map((entry) => ({
          ...entry, id: `${body.id}1`, mid: body.id
        }))
        payable.billStage = '14'
        payable.isEffective = 0
        payable.srcBillType = body.srcBillType
        payable.srcBillId = body.srcBillId
        payable.supplierId = body.supplierId
        payable.amt = body.amt
        return ok(true)
      }
      if (path === '/finance/finPayable/check') {
        const payable = payables.get(String(body.id))
        payable.isEffective = 1
        payable.billStage = '24'
        return ok(true)
      }
      if (path === '/finance/finPayable/void') {
        const payable = payables.get(String(body.id))
        payable.isEffective = 0
        payable.billStage = '12'
        payable.processInstanceId = null
        return ok(true)
      }
      throw new Error(`unexpected PUT ${path}`)
    },
    async deleteBusiness (path) {
      calls.push(['DELETE', path])
      const id = path.split('id=')[1]
      if (leaveEntries) orphanEntries.set(id, payables.get(id)?.finPayableEntryList || [])
      payables.delete(id)
      return ok(true)
    }
  }
  return { api, calls, payables, snapshots, orphanEntries }
}

const run = ({ api }, dependencies = {}) => {
  const caseRecord = { id: 'COST-011', fixtures: {}, checks: [], evidence: [] }
  return {
    caseRecord,
    promise: runCostPurchaseFreightClosure({
      api,
      record: { runId: fixture.runId, environment: { tenantId: '1' } },
      caseRecord,
      fixture,
      dependencies: { config: { target: 'local', tenantId: '1' }, ...dependencies }
    })
  }
}

test('COST-011 browser observes effective freight before cleanup using the existing business history', async () => {
  const mock = makeApi()
  let observed = false
  const { promise } = run(mock, {
    verifyBrowser: async ({ positive, snapshot }) => {
      assert.equal(mock.payables.get(positive.id).isEffective, 1)
      assert.equal(mock.calls.filter(([method]) => method === 'DELETE').length, 0)
      assert.equal(snapshot.lines.filter((row) => row.sourceType === 'PURCHASE_FREIGHT').length, 1)
      observed = true
      return { periodId: fixture.periodId, verified: true }
    }
  })
  const closure = await promise
  assert.equal(observed, true)
  assert.equal(closure.browser.verified, true)
  assert.equal(closure.complete, true)
  assert.equal(mock.payables.size, 0)
})

test('COST-011 still formally cleans both payables if real page validation fails', async () => {
  const mock = makeApi()
  const { promise, caseRecord } = run(mock, {
    verifyBrowser: async () => { throw new Error('page missing exact freight') }
  })
  await assert.rejects(promise, /page missing exact freight/)
  assert.equal(mock.payables.size, 0)
  assert.equal(caseRecord.fixtures.costPurchaseFreight.positive.cleanup.complete, true)
  assert.equal(caseRecord.fixtures.costPurchaseFreight.zero.cleanup.complete, true)
  assert.equal(caseRecord.fixtures.costPurchaseFreight.complete, false)
})

test('COST-011 payable payload keeps exact WMS source IDs and positive freight', () => {
  const payload = buildPurchaseFreightPayable({
    fixture, wmsSource, freight: 12.34, suffix: 'POSITIVE'
  })
  assert.equal(payload.body.srcBillType, 'MesStkIoDTO:101')
  assert.equal(payload.body.srcBillId, '9601')
  assert.equal(payload.entry.srcEntryId, '9602')
  assert.equal(payload.body.amt, '12.34')
  assert.equal(payload.entry.freight, '12.34')
  assert.ok(payload.billNo.length <= 50)
  assert.match(payload.billNo, /^E2E-C11-[A-Za-z0-9_-]+-UNIT-POSITIVE$/)
})

test('COST-011 snapshot assertion rejects empty or unowned freight lines', () => {
  const positive = { id: '9700', entryId: '97001', billNo: 'PAYABLE-9700', amount: '12.34' }
  const zero = { id: '9701' }
  const freightLine = (overrides = {}) => ({
    sourceType: 'PURCHASE_FREIGHT', sourceId: positive.id,
    sourceLineId: positive.entryId, sourceNo: positive.billNo,
    sourceVersion: 'MesStkIoDTO:101', componentCode: 'PURCHASE_FREIGHT',
    quantity: 0, materialAmount: 0, expenseAmount: positive.amount,
    payableKeyScope: 'FREIGHT_PAYABLE', payableSourceBillId: wmsSource.wms.id,
    payableNo: positive.billNo, payableSettlementStatus: 'UNPAID',
    payableAmount: positive.amount,
    ...overrides
  })
  assert.throws(
    () => assertPurchaseFreightSnapshot({
      snapshot: { snapshotKey: 'PURCHASE', status: 'DRAFT', lines: [] },
      positive, zero, wmsSource
    }),
    /非空DRAFT/
  )
  assert.throws(
    () => assertPurchaseFreightSnapshot({
      snapshot: {
        snapshotKey: 'PURCHASE',
        status: 'DRAFT',
        lines: [freightLine({ expenseAmount: '0.00' })]
      },
      positive, zero, wmsSource
    }),
    /来源字段或金额不精确/
  )
  // 到岸费用的应付追溯键必须是应付主键口径，缺少冻结字段时不能放过。
  assert.throws(
    () => assertPurchaseFreightSnapshot({
      snapshot: {
        snapshotKey: 'PURCHASE',
        status: 'DRAFT',
        lines: [{
          sourceType: 'PURCHASE_FREIGHT', sourceId: positive.id,
          sourceLineId: positive.entryId, sourceNo: positive.billNo,
          sourceVersion: 'MesStkIoDTO:101', componentCode: 'PURCHASE_FREIGHT',
          quantity: 0, materialAmount: 0, expenseAmount: positive.amount
        }]
      },
      positive, zero, wmsSource
    }),
    /到岸费用来源未按应付主键解析出应付结算状态/
  )
  assert.throws(
    () => assertPurchaseFreightSnapshot({
      snapshot: {
        snapshotKey: 'PURCHASE',
        status: 'DRAFT',
        lines: [freightLine()]
      },
      positive, zero, wmsSource
    }),
    /专属采购入库与freight/
  )
})

test('COST-011 runs the formal API closure, exact snapshot checks, and cleanup without SQL', async () => {
  const { api, calls, payables, snapshots } = makeApi()
  const caseRecord = { id: 'COST-011', fixtures: {}, checks: [], evidence: [] }
  const result = await runCostPurchaseFreightClosure({
    api,
    record: { runId: fixture.runId, environment: { tenantId: '1' } },
    caseRecord,
    fixture,
    dependencies: { config: { target: 'local', tenantId: '1' } }
  })
  assert.equal(result.complete, true)
  assert.equal(caseRecord.checks.find((item) => item.name === COST_PURCHASE_FREIGHT_CHECKS.expense).passed, true)
  assert.equal(caseRecord.checks.find((item) => item.name === COST_PURCHASE_FREIGHT_CHECKS.zero).passed, true)
  assert.equal(calls.some(([, path]) => path.includes('/finance/finPayable/add/save')), true)
  assert.equal(calls.some(([, path]) => path.includes('/finance/finPayable/edit/submit')), true)
  assert.equal(calls.some(([, path]) => path === '/finance/finPayable/check'), true)
  assert.equal(calls.some(([, path]) => path.includes('/source-snapshot/purchase/refresh')), true)
  assert.equal(payables.size, 0)
  assert.equal(result.positive.cleanup.complete, true)
  assert.equal(result.zero.cleanup.complete, true)
  const detailReads = calls.filter(([method, path]) =>
    method === 'GET' && path.startsWith('/finance/finPayable/queryFinPayableSubByMainId?'))
  assert.equal(detailReads.length, 2)
  assert.ok(snapshots.length >= 2)
})

test('COST-011 rejects missing freight instead of coercing it to a zero amount', () => {
  for (const freight of [null, undefined, '', ' ', false, {}, NaN, Infinity]) {
    assert.throws(() => buildPurchaseFreightPayable({ fixture, wmsSource, freight }),
      /缺少明确金额|不是有限金额/)
  }
})

test('COST-011 detects header-only deletion and records both orphan entry IDs', async () => {
  const mock = makeApi({ leaveEntries: true })
  const { caseRecord, promise } = run(mock)
  await assert.rejects(promise, /主单已删除但明细残留/)
  assert.equal(mock.payables.size, 0)
  assert.equal(mock.orphanEntries.size, 2)
  const closure = caseRecord.fixtures.costPurchaseFreight
  assert.equal(closure.complete, false)
  for (const payable of [closure.positive, closure.zero]) {
    assert.equal(payable.cleanup.headerDeleted, true)
    assert.equal(payable.cleanup.complete, false)
    assert.deepEqual(payable.cleanup.remainingEntryIds, [payable.entryId])
  }
  assert.equal(caseRecord.evidence.some((value) => value.includes('已通过正式接口清理')), false)
  assert.ok(mock.snapshots.length >= 2, 'snapshot still refreshed after an incomplete cleanup')
  assert.equal(mock.snapshots.at(-1).lines.length, 1)
  assert.equal(mock.snapshots.at(-1).lines[0].sourceType, 'PURCHASE_RECEIPT')
  assert.equal(caseRecord.checks.at(-1).passed, false)
})

test('COST-011 registers and cleans a saved header when positive submission fails', async () => {
  const mock = makeApi({ failSubmitSuffix: 'POSITIVE' })
  const { caseRecord, promise } = run(mock)
  await assert.rejects(promise, /submit failed: POSITIVE/)
  const closure = caseRecord.fixtures.costPurchaseFreight
  assert.equal(closure.positive.id, '9700')
  assert.equal(closure.positive.entryId, undefined)
  assert.equal(closure.positive.cleanup.complete, true)
  assert.equal(closure.zero, undefined)
  assert.equal(closure.complete, false)
  assert.equal(mock.payables.size, 0)
  assert.ok(mock.calls.some(([method, path]) =>
    method === 'DELETE' && path.endsWith('id=9700')))
})

test('COST-011 preserves a zero submission error and cleans both registered headers', async () => {
  const mock = makeApi({ failSubmitSuffix: 'ZERO' })
  const { caseRecord, promise } = run(mock)
  await assert.rejects(promise, /submit failed: ZERO/)
  const closure = caseRecord.fixtures.costPurchaseFreight
  assert.equal(closure.positive.cleanup.complete, true)
  assert.equal(closure.zero.cleanup.complete, true)
  assert.equal(mock.payables.size, 0)
  assert.equal(closure.complete, false)
  assert.equal(mock.calls.filter(([method]) => method === 'DELETE').length, 2)
})

test('COST-011 accepts only the exact legacy not-found contract during deletion', async () => {
  const mock = makeApi({
    afterDelete: { code: 500, success: false, message: '未找到对应数据', data: null }
  })
  const { promise } = run(mock)
  const closure = await promise
  assert.equal(closure.complete, true)
  const read = mock.calls.find(([method]) => method === 'RAW-GET')
  assert.deepEqual(read[2].expectedBusinessRejection, {
    code: 500, message: '未找到对应数据', allowServiceCode: true
  })
})

test('COST-011 never treats auth, service, malformed, or live-header responses as successful deletion', async () => {
  for (const afterDelete of [
    { code: 401, message: 'unauthorized' },
    { code: 500, message: '数据库异常' },
    { code: 500, message: '未找到对应数据', success: true },
    { code: 0 },
    null,
    ok({ id: '9700' })
  ]) {
    const mock = makeApi({ afterDelete })
    const { caseRecord, promise } = run(mock)
    await assert.rejects(promise, /COST-011正式清理失败/)
    assert.equal(caseRecord.fixtures.costPurchaseFreight.complete, false)
    assert.equal(caseRecord.evidence.some((value) => value.includes('已通过正式接口清理')), false)
  }
})

test('COST-011 cleanup requires the exact receipt line rather than any line of the receipt', async () => {
  const mock = makeApi({ receiptLineAfterCleanup: '9999' })
  const { caseRecord, promise } = run(mock)
  await assert.rejects(promise, /专属采购入库明细来源丢失/)
  assert.equal(caseRecord.fixtures.costPurchaseFreight.complete, false)
})

test('COST-011 preserves the primary failure when cleanup also fails', async () => {
  const mock = makeApi({
    failSubmitSuffix: 'ZERO',
    afterDelete: { code: 500, message: '数据库异常' }
  })
  const { caseRecord, promise } = run(mock)
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /原始错误：submit failed: ZERO/)
    assert.equal(error.errors[0].message, 'submit failed: ZERO')
    assert.equal(error.errors.length, 3)
    return true
  })
  assert.equal(caseRecord.fixtures.costPurchaseFreight.complete, false)
})
