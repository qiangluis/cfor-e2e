import { assertBusinessSuccess } from '../lib/assertions.mjs'

export const OUTSOURCE_FINANCE_SOURCE = 'mes-outsource-finance'

const dataOf = (response, label) => assertBusinessSuccess(response, label).data

const idOf = (value, label) => {
  const candidate = typeof value === 'object' && value !== null
    ? value.id ?? value.data?.id
    : value
  const id = candidate === undefined || candidate === null ? '' : String(candidate)
  if (!/^\d+$/.test(id)) throw new Error(`${label} 未返回稳定数字 ID：${JSON.stringify(value)}`)
  return id
}

const money = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`金额不是有限数字：${value}`)
  return number.toFixed(2)
}

const sameMoney = (left, right) => money(left) === money(right)

const sameId = (left, right) => String(left ?? '') === String(right ?? '')

const rowsOf = (value) => {
  const data = value?.data ?? value
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.records)) return data.records
  if (Array.isArray(data?.list)) return data.list
  return []
}

const requireFunction = (value, name) => {
  if (!value || typeof value[name] !== 'function') throw new Error(`缺少 api.${name} 正式调用方法`)
}

function ensureRecord (caseRecord) {
  if (!caseRecord || typeof caseRecord !== 'object') throw new Error('缺少 caseRecord')
  caseRecord.fixtures ||= []
  caseRecord.financeManifest ||= []
  caseRecord.checks ||= []
  caseRecord.evidence ||= []
}

function snapshot (value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function recordManifest (caseRecord, entry) {
  caseRecord.financeManifest.push({
    source: OUTSOURCE_FINANCE_SOURCE,
    at: new Date().toISOString(),
    ...entry
  })
}

function registerResource (caseRecord, fixture, kind, id, extra = {}) {
  const resource = {
    source: OUTSOURCE_FINANCE_SOURCE,
    kind,
    id: String(id),
    sourceKey: fixture.sourceKey,
    supplierId: String(fixture.supplierId),
    cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP',
    ...extra
  }
  caseRecord.fixtures.push(resource)
  recordManifest(caseRecord, {
    stage: 'resource-registered',
    status: 'SUCCESS',
    resource: { kind, id: String(id) },
    sourceKey: fixture.sourceKey
  })
  return resource
}

async function callBusiness (api, caseRecord, method, pathname, body, stage, resource = {}) {
  const name = `${method}Business`
  requireFunction(api, name)
  const request = body === undefined ? undefined : snapshot(body)
  try {
    const response = body === undefined
      ? await api[name](pathname)
      : await api[name](pathname, body)
    recordManifest(caseRecord, {
      stage,
      status: 'SUCCESS',
      method,
      pathname,
      request,
      response: snapshot(response),
      resource
    })
    return response
  } catch (error) {
    recordManifest(caseRecord, {
      stage,
      status: 'FAILED',
      method,
      pathname,
      request,
      resource,
      error: String(error?.message || error)
    })
    throw error
  }
}

export function buildOutsourceSourceKey (flow) {
  const receiptId = flow?.receipt?.id
  const receiptEntry = flow?.receiptEntries?.[0]
  const inspectionId = flow?.inspection?.id
  if (!receiptId || !receiptEntry?.id || !inspectionId) {
    throw new Error('委外财务闭环缺少收货单、收货明细或 104 质检单 ID')
  }
  const linkedEntry = flow?.entries?.[0]
  if (!linkedEntry?.srcEntryId || !sameId(linkedEntry.srcEntryId, receiptEntry.id)) {
    throw new Error('委外财务闭环 104 明细未精确关联本轮收货明细')
  }
  return `${receiptId}:${receiptEntry.id}:${inspectionId}`
}

function validateInputs (api, caseRecord, fixture, flow) {
  for (const name of ['getBusiness', 'postBusiness', 'putBusiness']) requireFunction(api, name)
  ensureRecord(caseRecord)
  if (!fixture || typeof fixture !== 'object' || !fixture.supplierId) {
    throw new Error('委外财务闭环缺少专属 supplierId')
  }
  const sourceKey = buildOutsourceSourceKey(flow)
  fixture.sourceKey = sourceKey
  return sourceKey
}

function payableFromRows (rows, sourceKey, supplierId) {
  const matches = rows.filter((row) =>
    String(row?.srcBillType) === 'MesOutsourceReceipt' &&
    String(row?.srcBillId) === sourceKey &&
    sameId(row?.supplierId, supplierId))
  if (matches.length !== 1) {
    throw new Error(`205 委外应付来源键未精确命中唯一单据：${JSON.stringify({ sourceKey, matches })}`)
  }
  const payable = matches[0]
  if (String(payable.payableType) !== '205' || String(payable.isVoided ?? 0) === '1') {
    throw new Error(`205 委外应付类型或作废状态不正确：${JSON.stringify(payable)}`)
  }
  if (!payable.id || !(Number(payable.amt) > 0)) {
    throw new Error(`205 委外应付缺少合法主键或金额：${JSON.stringify(payable)}`)
  }
  return payable
}

async function readPayable (api, caseRecord, fixture, sourceKey) {
  const path = '/finance/finPayable/list/205?pageNo=1&pageSize=100' +
    '&srcBillType=MesOutsourceReceipt' + `&srcBillId=${encodeURIComponent(sourceKey)}`
  const page = dataOf(await callBusiness(api, caseRecord, 'get', path, undefined, 'read-payable-list'), '205 委外应付列表')
  const payable = payableFromRows(rowsOf(page), sourceKey, fixture.supplierId)
  const payableId = idOf(payable.id, '205 委外应付')
  const detail = dataOf(await callBusiness(
    api, caseRecord, 'get', `/finance/finPayable/queryById?id=${encodeURIComponent(payableId)}`,
    undefined, 'read-payable', { kind: 'payable205', id: payableId }
  ), '205 委外应付主单')
  if (!sameId(detail.id, payableId) || String(detail.payableType) !== '205' ||
      String(detail.srcBillType) !== 'MesOutsourceReceipt' || String(detail.srcBillId) !== sourceKey ||
      !sameId(detail.supplierId, fixture.supplierId) || String(detail.isVoided ?? 0) === '1') {
    throw new Error(`205 委外应付主单归属不一致：${JSON.stringify(detail)}`)
  }
  const entries = Array.isArray(detail.finPayableEntryList) && detail.finPayableEntryList.length
    ? detail.finPayableEntryList
    : rowsOf(dataOf(await callBusiness(
      api, caseRecord, 'get', `/finance/finPayable/queryFinPayableSubByMainId?id=${encodeURIComponent(payableId)}`,
      undefined, 'read-payable-entry', { kind: 'payable205', id: payableId }
    ), '205 委外应付明细'))
  const matchedEntries = entries.filter((entry) => sameId(entry?.mid, payableId))
  if (matchedEntries.length !== 1 || !matchedEntries[0].id ||
      !sameMoney(matchedEntries[0].amt, detail.amt)) {
    throw new Error(`205 委外应付明细未精确归属或金额不一致：${JSON.stringify(entries)}`)
  }
  const entry = matchedEntries[0]
  return {
    payable: detail,
    entry,
    amount: money(detail.amt),
    checkedAmt: money(detail.checkedAmt ?? 0),
    uncheckedAmt: money(Number(entry.amt) - Number(entry.checkedAmt ?? 0))
  }
}

async function ensurePayableEffective (api, caseRecord, fixture, payableEvidence) {
  let payable = payableEvidence.payable
  const payableId = idOf(payable.id, '205 委外应付')
  if (String(payable.isEffective) !== '1') {
    await callBusiness(api, caseRecord, 'put', '/finance/finPayable/check', {
      id: payableId,
      approvalResultType: '1',
      approvalRemark: String(fixture.marker || fixture.sourceKey).slice(0, 32)
    }, 'approve-payable', { kind: 'payable205', id: payableId })
    payable = dataOf(await callBusiness(
      api, caseRecord, 'get', `/finance/finPayable/queryById?id=${encodeURIComponent(payableId)}`,
      undefined, 'reread-payable-after-check', { kind: 'payable205', id: payableId }
    ), '审核后 205 委外应付')
  }
  if (String(payable.billStage) === '24') {
    await callBusiness(api, caseRecord, 'put', '/finance/finPayable/execute', { id: payableId },
      'execute-payable', { kind: 'payable205', id: payableId })
    payable = dataOf(await callBusiness(
      api, caseRecord, 'get', `/finance/finPayable/queryById?id=${encodeURIComponent(payableId)}`,
      undefined, 'reread-payable-after-execute', { kind: 'payable205', id: payableId }
    ), '执行后 205 委外应付')
  }
  if (String(payable.isEffective) !== '1' || String(payable.isVoided ?? 0) === '1') {
    throw new Error(`205 委外应付无法证明已生效且未作废：${JSON.stringify(payable)}`)
  }
  return { ...payableEvidence, payable, amount: money(payable.amt), checkedAmt: money(payable.checkedAmt ?? 0) }
}

export function buildOutsourceInvoicePayload ({
  fixture,
  payable,
  amount,
  billDate,
  invoiceType = 1,
  companyName,
  taxNo,
  taxRate
}) {
  const invoiceNo = fixture.invoiceNo || `E2E-${fixture.marker || fixture.sourceKey}-INV`
  return {
    billNo: fixture.invoiceBillNo || invoiceNo,
    billDate,
    supplierId: fixture.supplierId,
    companyName,
    taxNo,
    taxRate,
    invoiceNo,
    invoiceType,
    invoiceMoney: Number(amount),
    isRubric: 0,
    items: [{
      outsourcePayableId: String(payable.id),
      srcBillType: 'MesOutsourcePayable',
      invoiceMoneyItem: Number(amount)
    }]
  }
}

async function createAndAuditInvoice (api, caseRecord, fixture, payableEvidence, config) {
  const amount = config.invoiceAmount ?? payableEvidence.uncheckedAmt
  if (!(Number(amount) > 0) || Number(amount) > Number(payableEvidence.uncheckedAmt)) {
    throw new Error(`委外发票金额超出应付未核销余额：${amount}/${payableEvidence.uncheckedAmt}`)
  }
  const supplier = dataOf(await callBusiness(
    api,
    caseRecord,
    'get',
    `/erp/supplier/get?id=${encodeURIComponent(fixture.supplierId)}`,
    undefined,
    'read-supplier-invoice-header',
    { kind: 'supplier', id: String(fixture.supplierId) }
  ), '委外发票供应商主档')
  if (!supplier?.id || !sameId(supplier.id, fixture.supplierId) ||
      typeof supplier.name !== 'string' || supplier.name.trim() === '') {
    throw new Error(`委外发票供应商主档缺少可落库抬头：${JSON.stringify(supplier)}`)
  }
  const payload = buildOutsourceInvoicePayload({
    fixture,
    payable: payableEvidence.payable,
    amount,
    billDate: config.billDate,
    invoiceType: config.invoiceType ?? fixture.invoiceType ?? 1,
    companyName: supplier.name.trim(),
    taxNo: supplier.taxNo || undefined,
    taxRate: supplier.taxPercent ?? undefined
  })
  const invoiceId = idOf(dataOf(await callBusiness(
    api, caseRecord, 'post', '/erp/purchase-invoice/create', payload, 'create-invoice'
  ), '委外发票创建'), '委外采购发票')
  registerResource(caseRecord, fixture, 'purchase-invoice', invoiceId, {
    payableId: String(payableEvidence.payable.id), amount: money(amount), invoiceNo: payload.invoiceNo
  })
  let invoice = dataOf(await callBusiness(
    api, caseRecord, 'get', `/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`,
    undefined, 'read-invoice-before-audit', { kind: 'purchase-invoice', id: invoiceId }
  ), '委外发票回读')
  if (!sameId(invoice.id, invoiceId) || String(invoice.srcBillType) !== 'MesOutsourcePayable' ||
      String(invoice.srcBillId) !== String(payableEvidence.payable.id) ||
      !sameId(invoice.supplierId, fixture.supplierId) || !sameMoney(invoice.invoiceMoney, amount)) {
    throw new Error(`委外发票来源、供应商或金额不一致：${JSON.stringify(invoice)}`)
  }
  // 采购发票的审批方式由 mes_bas_bill_options + 审批策略决定：
  // 免审（NONE）时 submitAdd 已直接生效，此时再调用 update-status 会被 actions.check 拒绝；
  // 手工核批（MANUAL）时才调用复核接口；流程审批（WORKFLOW）需走 BPM 待办完成复核。
  let approvalPath
  if (String(invoice.isEffective) === '1') {
    approvalPath = 'AUTO_EFFECT_ON_CREATE'
  } else {
    const processId = invoice.processInstanceId || invoice.bpmiInstanceId
    if (processId) {
      throw new Error(`委外发票进入流程审批，需通过 BPM 待办完成复核：processInstanceId=${processId}`)
    }
    await callBusiness(api, caseRecord, 'put', `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoiceId)}`,
      undefined, 'audit-invoice', { kind: 'purchase-invoice', id: invoiceId })
    invoice = dataOf(await callBusiness(
      api, caseRecord, 'get', `/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`,
      undefined, 'reread-invoice-after-audit', { kind: 'purchase-invoice', id: invoiceId }
    ), '复核后委外发票')
    approvalPath = 'MANUAL_CHECK'
  }
  if (String(invoice.isEffective) !== '1') throw new Error(`委外发票复核后未生效：${JSON.stringify(invoice)}`)
  recordManifest(caseRecord, {
    stage: 'invoice-approval-resolved',
    status: 'SUCCESS',
    resource: { kind: 'purchase-invoice', id: invoiceId },
    invoiceApprovalPath: approvalPath,
    billStage: invoice.billStage,
    isEffective: invoice.isEffective
  })
  return { id: invoiceId, invoice, amount: money(amount), payload, approvalPath }
}

export function buildOutsourcePaymentRequestPayload ({ fixture, payable, entry, amount, billDate }) {
  const bankAccountId = fixture.bankAccountId
  if (!bankAccountId) throw new Error('委外付款申请缺少专属 bankAccountId')
  const paymentType = fixture.paymentType || '2021'
  const collectionItem = fixture.collectionItem || '1'
  const settleMethod = fixture.settleMethod || '1'
  const billNo = fixture.paymentBillNo || `E2E-${fixture.marker || fixture.sourceKey}-PAY`
  const line = {
    entryNo: 1,
    srcBillType: 'FinPayable:205',
    srcBillId: String(payable.id),
    srcEntryId: String(entry.id),
    amt: Number(amount),
    discountAmt: 0,
    checkedAmt: 0,
    bankAccountId,
    settleMethod,
    collectionItem
  }
  return {
    billNo,
    billDate,
    isAuto: 0,
    isRubric: 0,
    isRequest: 1,
    paymentType,
    supplierId: fixture.supplierId,
    bankAccountId,
    collectionItem,
    settleMethod,
    discountAmt: 0,
    checkedAmt: 0,
    amt: Number(amount),
    srcBillType: 'FinPayable:205',
    srcBillId: String(payable.id),
    finPaymentEntryList: [line]
  }
}

function assertPaymentIdentity (payment, paymentId, fixture, payableId, amount, request) {
  if (!sameId(payment?.id, paymentId) || !sameId(payment?.supplierId, fixture.supplierId) ||
      !sameMoney(payment?.amt, amount) || String(payment?.srcBillType) !== 'FinPayable:205' ||
      !sameId(payment?.srcBillId, payableId)) {
    throw new Error(`委外付款主单归属、来源或金额不一致：${JSON.stringify(payment)}`)
  }
  if (request && String(payment.isRequest) !== String(request)) {
    throw new Error(`委外付款申请状态不正确：${JSON.stringify(payment)}`)
  }
}

async function readPayment (api, caseRecord, paymentId, fixture, payableId, amount, request) {
  const payment = dataOf(await callBusiness(
    api, caseRecord, 'get', `/finance/finPayment/queryById?id=${encodeURIComponent(paymentId)}`,
    undefined, 'read-payment', { kind: 'payment', id: paymentId }
  ), '委外付款主单')
  assertPaymentIdentity(payment, paymentId, fixture, payableId, amount, request)
  const displayEntries = rowsOf(dataOf(await callBusiness(
    api, caseRecord, 'get', `/finance/finPayment/queryEntryByMainId?id=${encodeURIComponent(paymentId)}`,
    undefined, 'read-payment-display-entry', { kind: 'payment', id: paymentId }
  ), '委外付款展示明细'))
  if (displayEntries.length !== 1 || !sameMoney(displayEntries[0].amt, amount)) {
    throw new Error(`委外付款展示明细数量或金额不一致：${JSON.stringify(displayEntries)}`)
  }
  const page = dataOf(await callBusiness(
    api, caseRecord, 'get', `/finance/finPayment/list?pageNo=1&pageSize=100&id=${encodeURIComponent(paymentId)}&paymentType=${encodeURIComponent(payment.paymentType || '')}`,
    undefined, 'read-payment-real-entry', { kind: 'payment', id: paymentId }
  ), '委外付款分页')
  const rows = rowsOf(page)
  if (rows.length !== 1) throw new Error(`委外付款分页未返回唯一主单：${JSON.stringify(rows)}`)
  const listed = rows[0]
  const entries = listed.finPaymentEntryList
  if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].id ||
      !sameId(entries[0].mid, paymentId) || !sameId(entries[0].srcBillId, payableId) ||
      !sameId(entries[0].srcBillType, 'FinPayable:205') || !sameMoney(entries[0].amt, amount)) {
    throw new Error(`委外付款真实明细缺少主键、归属或金额：${JSON.stringify(listed)}`)
  }
  return { payment, entry: entries[0], displayEntries, listed }
}

async function readWriteOff (api, caseRecord, fixture, paymentEvidence, payableEvidence, amount) {
  const paymentId = paymentEvidence.payment.id
  const path = `/finance/finPayableCheck/list/2?pageNo=1&pageSize=100&srcBillId=${encodeURIComponent(paymentId)}`
  const rows = rowsOf(dataOf(await callBusiness(api, caseRecord, 'get', path, undefined,
    'read-payable-check-list', { kind: 'payable-check', paymentId }), '委外应付核销列表'))
  const matches = rows.filter((row) => sameId(row.srcBillId, paymentId) &&
    String(row.payableCheckType) === '2' && String(row.isAuto) === '1' &&
    String(row.isEffective) === '1' && String(row.isVoided ?? 0) === '0' &&
    sameId(row.supplierId, fixture.supplierId) && sameMoney(row.amt, amount))
  if (matches.length !== 1) throw new Error(`委外付款未回读到唯一自动核销单：${JSON.stringify(rows)}`)
  const checkId = idOf(matches[0].id, '委外自动核销单')
  registerResource(caseRecord, fixture, 'payable-check', checkId, { paymentId, payableId: String(payableEvidence.payable.id), amount: money(amount) })
  const entries = rowsOf(dataOf(await callBusiness(
    api, caseRecord, 'get', `/finance/finPayableCheck/queryEntryByMainId?id=${encodeURIComponent(checkId)}`,
    undefined, 'read-payable-check-entry', { kind: 'payable-check', id: checkId }
  ), '委外核销明细'))
  const payableSide = entries.find((row) => String(row.checkSide) === '1')
  const paymentSide = entries.find((row) => String(row.checkSide) === '2')
  if (entries.length !== 2 || !payableSide || !paymentSide ||
      !sameId(payableSide.srcBillId, payableEvidence.payable.id) ||
      !sameId(payableSide.srcEntryId, payableEvidence.entry.id) ||
      !sameId(paymentSide.srcBillId, paymentId) || !sameId(paymentSide.srcEntryId, paymentEvidence.entry.id) ||
      !sameMoney(payableSide.amt, amount) || !sameMoney(paymentSide.amt, amount)) {
    throw new Error(`委外核销两侧明细归属或金额不一致：${JSON.stringify(entries)}`)
  }
  return { id: checkId, check: matches[0], entries, payableSide, paymentSide }
}

export async function runOutsourceFinanceClosure (api, caseRecord, fixture, flow) {
  const sourceKey = validateInputs(api, caseRecord, fixture, flow)
  const config = { ...(flow.finance || {}), ...(fixture.finance || {}) }
  const billDate = config.billDate || new Date().toISOString().slice(0, 10)
  const initialPayable = await readPayable(api, caseRecord, fixture, sourceKey)
  const effectivePayable = await ensurePayableEffective(api, caseRecord, fixture, initialPayable)
  fixture.payableId = idOf(effectivePayable.payable.id, '205 委外应付')
  fixture.payableEntryId = idOf(effectivePayable.entry.id, '205 委外应付明细')
  fixture.payable = effectivePayable.payable
  fixture.payableEntry = effectivePayable.entry
  fixture.amount = effectivePayable.amount
  registerResource(caseRecord, fixture, 'payable205', fixture.payableId, {
    entryId: fixture.payableEntryId, amount: effectivePayable.amount
  })
  const financeFixture = { ...fixture, ...config }
  const invoice = await createAndAuditInvoice(api, caseRecord, financeFixture, effectivePayable, { ...config, billDate })
  const amount = money(config.paymentAmount ?? effectivePayable.uncheckedAmt)
  if (Number(amount) <= 0 || Number(amount) > Number(effectivePayable.uncheckedAmt)) {
    throw new Error(`委外付款金额超出应付未核销余额：${amount}/${effectivePayable.uncheckedAmt}`)
  }
  const paymentPayload = buildOutsourcePaymentRequestPayload({
    fixture: financeFixture,
    payable: effectivePayable.payable,
    entry: effectivePayable.entry,
    amount,
    billDate
  })
  const paymentId = idOf(dataOf(await callBusiness(
    api, caseRecord, 'post', '/finance/finPayment/add/submit', paymentPayload, 'create-payment-request'
  ), '委外付款申请创建'), '委外付款申请')
  fixture.paymentId = paymentId
  registerResource(caseRecord, fixture, 'payment', paymentId, { payableId: fixture.payableId, amount })
  let paymentEvidence = await readPayment(api, caseRecord, paymentId, fixture, fixture.payableId, amount, '1')
  fixture.paymentEntryId = idOf(paymentEvidence.entry.id, '委外付款明细')
  registerResource(caseRecord, fixture, 'payment-entry', fixture.paymentEntryId, { paymentId, amount })
  // 付款单的审批方式同样由 mes_bas_bill_options + 审批策略决定：
  // 免审（NONE）时 add/submit 已直接生效并自动执行，此时再调用 checkFinPayableRequest 会被状态机拒绝；
  // 手工核批（MANUAL）时才依次走 申请审核 -> 正式审核 -> 执行。
  let paymentApprovalPath
  if (String(paymentEvidence.payment.isEffective) === '1') {
    if (String(paymentEvidence.payment.billStage) === '24') {
      await callBusiness(api, caseRecord, 'put', '/finance/finPayment/execute', { id: paymentId },
        'execute-payment', { kind: 'payment', id: paymentId })
      paymentEvidence = await readPayment(api, caseRecord, paymentId, fixture, fixture.payableId, amount)
    }
    paymentApprovalPath = 'AUTO_EFFECT_ON_CREATE'
  } else {
    if (String(paymentEvidence.payment.billStage) === '12') {
      await callBusiness(api, caseRecord, 'put', '/finance/finPayment/checkFinPayableRequest', {
        id: paymentId, approvalResultType: '1', approvalRemark: String(fixture.marker || sourceKey).slice(0, 32)
      }, 'approve-payment-request', { kind: 'payment', id: paymentId })
      paymentEvidence = await readPayment(api, caseRecord, paymentId, fixture, fixture.payableId, amount, '0')
    }
    if (String(paymentEvidence.payment.billStage) !== '14' || String(paymentEvidence.payment.isEffective) !== '0') {
      throw new Error(`委外付款申请审核后未转换为正式待审核付款：${JSON.stringify(paymentEvidence.payment)}`)
    }
    await callBusiness(api, caseRecord, 'put', '/finance/finPayment/checkFinPayable', {
      id: paymentId, approvalResultType: '1', approvalRemark: String(fixture.marker || sourceKey).slice(0, 32)
    }, 'approve-payment', { kind: 'payment', id: paymentId })
    paymentEvidence = await readPayment(api, caseRecord, paymentId, fixture, fixture.payableId, amount)
    if (String(paymentEvidence.payment.billStage) === '24') {
      await callBusiness(api, caseRecord, 'put', '/finance/finPayment/execute', { id: paymentId },
        'execute-payment', { kind: 'payment', id: paymentId })
      paymentEvidence = await readPayment(api, caseRecord, paymentId, fixture, fixture.payableId, amount)
    }
    paymentApprovalPath = 'MANUAL_CHECK'
  }
  if (String(paymentEvidence.payment.isEffective) !== '1') {
    throw new Error(`委外正式付款未生效：${JSON.stringify(paymentEvidence.payment)}`)
  }
  recordManifest(caseRecord, {
    stage: 'payment-approval-resolved',
    status: 'SUCCESS',
    resource: { kind: 'payment', id: paymentId },
    paymentApprovalPath,
    billStage: paymentEvidence.payment.billStage,
    isEffective: paymentEvidence.payment.isEffective
  })
  const writeOff = await readWriteOff(api, caseRecord, fixture, paymentEvidence, effectivePayable, amount)
  const afterPayable = dataOf(await callBusiness(
    api, caseRecord, 'get', `/finance/finPayable/queryById?id=${encodeURIComponent(fixture.payableId)}`,
    undefined, 'read-payable-balance-after-writeoff', { kind: 'payable205', id: fixture.payableId }
  ), '核销后委外应付')
  if (!sameId(afterPayable.id, fixture.payableId) || !sameMoney(afterPayable.checkedAmt, amount)) {
    throw new Error(`核销后委外应付余额事实不一致：${JSON.stringify(afterPayable)}`)
  }
  const result = {
    partial: false,
    sourceKey,
    payable: {
      id: fixture.payableId,
      entryId: fixture.payableEntryId,
      amount: effectivePayable.amount,
      checkedAmt: money(afterPayable.checkedAmt ?? 0),
      uncheckedAmt: money(Number(afterPayable.amt) - Number(afterPayable.checkedAmt ?? 0)),
      supplierId: String(fixture.supplierId)
    },
    invoice: {
      ...invoice.invoice,
      amount: invoice.amount,
      approvalPath: invoice.approvalPath
    },
    payment: {
      id: paymentId,
      entryId: fixture.paymentEntryId,
      amount,
      isEffective: paymentEvidence.payment.isEffective,
      approvalPath: paymentApprovalPath
    },
    writeOff: { id: writeOff.id, type: '2', isAuto: 1, amount, entries: writeOff.entries },
    balances: {
      before: { amount: effectivePayable.amount, checkedAmt: effectivePayable.checkedAmt, uncheckedAmt: effectivePayable.uncheckedAmt },
      after: { amount: money(afterPayable.amt), checkedAmt: money(afterPayable.checkedAmt), uncheckedAmt: money(Number(afterPayable.amt) - Number(afterPayable.checkedAmt)) }
    },
    manifest: caseRecord.financeManifest.filter((entry) => entry.source === OUTSOURCE_FINANCE_SOURCE)
  }
  caseRecord.evidence.push(`委外财务闭环 sourceKey=${sourceKey} payable=${fixture.payableId} invoice=${invoice.id} payment=${paymentId} check=${writeOff.id}`)
  return result
}
