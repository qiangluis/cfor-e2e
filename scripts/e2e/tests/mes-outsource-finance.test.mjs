import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOutsourceInvoicePayload,
  buildOutsourcePaymentRequestPayload,
  buildOutsourceSourceKey,
  runOutsourceFinanceClosure,
  OUTSOURCE_FINANCE_SOURCE
} from '../fixtures/mes-outsource-finance.mjs'

const ok = (data) => ({ code: 0, success: true, data })

const baseFixture = () => ({
  marker: 'PB155-156-UT',
  supplierId: '501',
  bankAccountId: '601'
})

const baseFlow = () => ({
  receipt: { id: '101' },
  receiptEntries: [{ id: '102' }],
  inspection: { id: '104' },
  entries: [{ id: '105', srcEntryId: '102' }],
  finance: { billDate: '2026-10-09' }
})

function makeApi ({ autoEffectInvoice = false, autoEffectPayment = false } = {}) {
  const calls = []
  const state = {
    payable: {
      id: '2051', payableType: '205', srcBillType: 'MesOutsourceReceipt', srcBillId: '101:102:104',
      supplierId: '501', amt: '7.00', checkedAmt: '0.00', isEffective: 0, isVoided: 0, billStage: '14'
    },
    payableEntry: { id: '20511', mid: '2051', amt: '7.00', checkedAmt: '0.00', quantity: '1', processPrice: '7.00' },
    invoice: null,
    payment: null,
    paymentEntry: null,
    check: null,
    supplier: {
      id: '501',
      name: '委外供应商 UT',
      taxNo: '91330000MA2XXXXX1A',
      taxPercent: 13
    }
  }
  const api = {
    calls,
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path.startsWith('/finance/finPayable/list/205?')) return ok({ records: [state.payable], total: 1 })
      if (path === '/finance/finPayable/queryById?id=2051') return ok(state.payable)
      if (path === '/finance/finPayable/queryFinPayableSubByMainId?id=2051') return ok([state.payableEntry])
      if (path === '/erp/supplier/get?id=501') return ok(state.supplier)
      if (path === '/erp/purchase-invoice/get?id=3001') return ok(state.invoice)
      if (path === '/finance/finPayment/queryById?id=4001') return ok(state.payment)
      if (path === '/finance/finPayment/queryEntryByMainId?id=4001') return ok([{ amt: state.payment.amt }])
      if (path.startsWith('/finance/finPayment/list?')) return ok({ records: [{ ...state.payment, finPaymentEntryList: [state.paymentEntry] }], total: 1 })
      if (path.startsWith('/finance/finPayableCheck/list/2?')) return ok({ records: [state.check], total: 1 })
      if (path === '/finance/finPayableCheck/queryEntryByMainId?id=5001') return ok([
        { id: '50011', checkSide: '1', srcBillId: '2051', srcEntryId: '20511', amt: '7.00' },
        { id: '50012', checkSide: '2', srcBillId: '4001', srcEntryId: '40011', amt: '7.00' }
      ])
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      calls.push(['POST', path, body])
      if (path === '/erp/purchase-invoice/create') {
        state.invoice = {
          id: '3001', supplierId: body.supplierId, srcBillType: 'MesOutsourcePayable', srcBillId: '2051',
          invoiceMoney: body.invoiceMoney, invoiceNo: body.invoiceNo,
          isEffective: autoEffectInvoice ? 1 : 0,
          billStage: autoEffectInvoice ? '24' : '14'
        }
        return ok('3001')
      }
      if (path === '/finance/finPayment/add/submit') {
        const autoPay = autoEffectPayment
        state.payment = {
          id: '4001', supplierId: body.supplierId, srcBillType: body.srcBillType, srcBillId: body.srcBillId,
          amt: body.amt, paymentType: body.paymentType, isRequest: 1,
          isEffective: autoPay ? 1 : 0, billStage: autoPay ? '34' : '12'
        }
        state.paymentEntry = { id: '40011', mid: '4001', srcBillType: body.srcBillType, srcBillId: body.srcBillId, srcEntryId: body.finPaymentEntryList[0].srcEntryId, amt: body.amt }
        if (autoPay) {
          state.check = { id: '5001', srcBillId: '4001', payableCheckType: '2', isAuto: 1, isEffective: 1, isVoided: 0, supplierId: '501', amt: '7.00' }
          state.payable.checkedAmt = '7.00'
        }
        return ok('4001')
      }
      throw new Error(`unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      calls.push(['PUT', path, body])
      if (path === '/finance/finPayable/check') { state.payable.isEffective = 1; return ok(true) }
      if (path.startsWith('/erp/purchase-invoice/update-status')) { state.invoice.isEffective = 1; return ok(true) }
      if (path === '/finance/finPayment/checkFinPayableRequest') { state.payment.isRequest = 0; state.payment.billStage = '14'; return ok(true) }
      if (path === '/finance/finPayment/checkFinPayable') { state.payment.billStage = '24'; return ok(true) }
      if (path === '/finance/finPayment/execute') {
        state.payment.isEffective = 1; state.payment.billStage = '30'
        state.check = { id: '5001', srcBillId: '4001', payableCheckType: '2', isAuto: 1, isEffective: 1, isVoided: 0, supplierId: '501', amt: '7.00' }
        state.payable.checkedAmt = '7.00'
        return ok(true)
      }
      throw new Error(`unexpected PUT ${path}`)
    }
  }
  return api
}

test('构造委外 sourceKey 严格绑定收货、明细、104质检', () => {
  assert.equal(buildOutsourceSourceKey(baseFlow()), '101:102:104')
  assert.throws(() => buildOutsourceSourceKey({ ...baseFlow(), entries: [{ srcEntryId: '999' }] }), /未精确关联/)
})

test('发票与付款申请 payload 使用正式来源字段和真实明细 ID', () => {
  const fixture = baseFixture()
  const payable = { id: '2051' }
  const entry = { id: '20511' }
  const invoice = buildOutsourceInvoicePayload({ fixture, payable, amount: '7.00', billDate: '2026-10-09' })
  assert.equal(invoice.items[0].srcBillType, 'MesOutsourcePayable')
  assert.equal(invoice.items[0].outsourcePayableId, '2051')
  assert.equal(invoice.items[0].invoiceMoneyItem, 7)
  assert.equal(invoice.companyName, undefined)
  const payment = buildOutsourcePaymentRequestPayload({ fixture, payable, entry, amount: '7.00', billDate: '2026-10-09' })
  assert.equal(payment.isRequest, 1)
  assert.equal(payment.srcBillType, 'FinPayable:205')
  assert.equal(payment.srcBillId, '2051')
  assert.equal(payment.finPaymentEntryList[0].srcEntryId, '20511')
})

test('委外财务 helper 完成 205→发票→付款申请→自动核销闭环并即时登记资源', async () => {
  const api = makeApi()
  const caseRecord = { fixtures: [], evidence: [], checks: [] }
  const fixture = baseFixture()
  const result = await runOutsourceFinanceClosure(api, caseRecord, fixture, baseFlow())
  assert.equal(result.partial, false)
  assert.equal(result.sourceKey, '101:102:104')
  assert.equal(result.payable.uncheckedAmt, '0.00')
  assert.equal(result.invoice.id, '3001')
  assert.equal(result.invoice.approvalPath, 'MANUAL_CHECK')
  assert.equal(result.payment.id, '4001')
  assert.equal(result.payment.approvalPath, 'MANUAL_CHECK')
  assert.equal(result.writeOff.id, '5001')
  assert.ok(api.calls.some(([method, path]) => method === 'PUT' && path.startsWith('/erp/purchase-invoice/update-status')))
  const invoiceCreate = api.calls.find(([, path]) => path === '/erp/purchase-invoice/create')
  assert.equal(invoiceCreate[2].companyName, '委外供应商 UT')
  assert.equal(invoiceCreate[2].taxNo, '91330000MA2XXXXX1A')
  assert.equal(invoiceCreate[2].taxRate, 13)
  assert.deepEqual(caseRecord.fixtures.map((row) => row.kind), [
    'payable205', 'purchase-invoice', 'payment', 'payment-entry', 'payable-check'
  ])
  assert.ok(caseRecord.financeManifest.length >= 15)
  assert.ok(caseRecord.financeManifest.every((row) => row.source === OUTSOURCE_FINANCE_SOURCE))
  const paymentCreate = api.calls.findIndex(([, path]) => path === '/finance/finPayment/add/submit')
  const paymentRead = api.calls.findIndex(([, path]) => path === '/finance/finPayment/queryById?id=4001')
  assert.ok(paymentCreate >= 0 && paymentRead > paymentCreate)
})

test('采购发票免审自动生效时不重复调用 update-status，仍完成后续付款核销闭环', async () => {
  const api = makeApi({ autoEffectInvoice: true })
  const caseRecord = { fixtures: [], evidence: [], checks: [] }
  const fixture = baseFixture()
  const result = await runOutsourceFinanceClosure(api, caseRecord, fixture, baseFlow())
  assert.equal(result.partial, false)
  assert.equal(result.invoice.isEffective, 1)
  assert.equal(result.invoice.approvalPath, 'AUTO_EFFECT_ON_CREATE')
  assert.equal(
    api.calls.some(([method, path]) => method === 'PUT' && path.startsWith('/erp/purchase-invoice/update-status')),
    false
  )
  assert.ok(caseRecord.financeManifest.some((row) =>
    row.stage === 'invoice-approval-resolved' && row.invoiceApprovalPath === 'AUTO_EFFECT_ON_CREATE'))
  assert.equal(result.writeOff.id, '5001')
})

test('付款单免审自动生效时不重复调用审批接口，直接完成自动核销闭环', async () => {
  const api = makeApi({ autoEffectInvoice: true, autoEffectPayment: true })
  const caseRecord = { fixtures: [], evidence: [], checks: [] }
  const fixture = baseFixture()
  const result = await runOutsourceFinanceClosure(api, caseRecord, fixture, baseFlow())
  assert.equal(result.partial, false)
  assert.equal(result.payment.isEffective, 1)
  assert.equal(result.payment.approvalPath, 'AUTO_EFFECT_ON_CREATE')
  assert.equal(
    api.calls.some(([method, path]) => method === 'PUT' && path === '/finance/finPayment/checkFinPayableRequest'),
    false
  )
  assert.equal(
    api.calls.some(([method, path]) => method === 'PUT' && path === '/finance/finPayment/checkFinPayable'),
    false
  )
  assert.ok(caseRecord.financeManifest.some((row) =>
    row.stage === 'payment-approval-resolved' && row.paymentApprovalPath === 'AUTO_EFFECT_ON_CREATE'))
  assert.equal(result.writeOff.id, '5001')
  assert.equal(result.balances.after.checkedAmt, '7.00')
})

test('缺少专属 bankAccountId 明确阻断，不伪造付款或 PASS', async () => {
  const fixture = baseFixture()
  delete fixture.bankAccountId
  assert.throws(() => buildOutsourcePaymentRequestPayload({
    fixture, payable: { id: '2051' }, entry: { id: '20511' }, amount: '7.00', billDate: '2026-10-09'
  }), /bankAccountId/)
})
