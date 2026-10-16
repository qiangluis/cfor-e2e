import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { ensureAcceptanceNumbering } from './acceptance-numbering.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { withDedicatedTenant } from './init-gaps.mjs'
import { createProcurementPermissionReader } from './procurement-permission-reader.mjs'
import {
  assertFms004WriteScope, readFms004Context, readFms004FormalVouchers,
  readFms004CashDraft, showFms004CashDraft, readFms004CashReversalEvidence
} from './fms-004-evidence.mjs'
import {
  check, dataOf, money, numericId, proof, database, reconcileMatches,
  fixtureKey, balancedDraft, missing, poll, draftLedgerPaths
} from '../fmshelper/contracts.mjs'

const unique = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`

export async function waitForFmsTasks (tasks) {
  // Drain every writer before propagating failure so finally cannot race it.
  const settled = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)))
  const failed = settled.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
  return settled.map((result) => result.value)
}

export function isolatedPeriodPassword () {
  return `Fms!${randomBytes(5).toString('hex')}A9`
}

export function isolatedPeriodTenantName (key) {
  return `FMS03-P-${String(key).slice(-12)}`
}

// Keep a platform-level tenant bootstrap defect as a controlled evidence gap.
// The FMS contract is still exercised on the shared acceptance account set;
// this helper must not turn an unrelated permission bootstrap failure into a
// false accounting failure.
export function isolatedPeriodTenantCreationGap (error) {
  return /提交的菜单权限包含已停用资源：1261/.test(String(error?.message || error))
}

export const payableBatchPrefix = (effective) =>
  `E2E-FMS-005-AP-${effective ? 'E' : 'D'}`

export function financialFixtureBillNo (key, kind) {
  if (!/^E2E-/.test(key) || !['RCPT', 'PAY'].includes(kind)) {
    throw new Error('Invalid financial fixture ownership or kind')
  }
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16).toUpperCase()
  return `E2E-FMS-${kind}-${hash}`
}

async function createPartner (api, key) {
  const id = numericId(dataOf(await api.postBusiness('/base/partner/create', {
    name: key,
    shortName: key.slice(-12),
    partnerKind: 'ORGANIZATION',
    taxNo: key.slice(-25),
    status: 'ACTIVE',
    customerEnabled: true,
    supplierEnabled: true,
    carrierEnabled: false
  })))
  return { id, name: key }
}

async function createAccount (api, key) {
  return numericId(dataOf(await api.postBusiness('/erp/account/create', {
    name: key,
    no: key,
    accountType: 'BANK',
    currency: 'CNY',
    status: 0,
    sort: 999,
    remark: key
  })))
}

// 走正式 JSON 新增接口建立可识别期初批次（与 Excel 导入共用 saveMain），
// 避免依赖 EasyExcel/SAX 解析链路。
async function createOpening (api, partner, batch, amount = '123.45', role = 'receivable') {
  const id = numericId(dataOf(await api.postBusiness('/finance/dealingsBeginning/add', {
    dealingsLogotype: role,
    billDate: '2026-10-07',
    openingBaseDate: '2026-10-07',
    importBatchNo: batch,
    detailsDesc: batch,
    deviceSource: 'E2E-FMS',
    ...(role === 'payable'
      ? { finPayables: [{ supplierId: partner.id, amt: amount, detailsDesc: batch }] }
      : { finReceivables: [{
          customerId: partner.id,
          amt: amount,
          detailsDesc: batch,
          invoiceNo: `E2E-${batch}`,
          invoiceType: 'E2E',
          invoiceDate: '2026-10-07 00:00:43',
          collectionTime: '2026-10-07 00:00:43'
        }] })
  })))
  const bill = dataOf(await api.getBusiness(
    `/finance/dealingsBeginning/queryById?id=${encodeURIComponent(id)}`
  ))
  if (!bill?.id || bill.importBatchNo !== batch) {
    throw new Error(`FMS-005 未回读到本轮期初批次：${batch}`)
  }
  return bill
}

// 通过正式 JSON 新增接口写一条多客商/多供应商期初批次，供 FMS 期初汇总与对账断言使用。
async function createOpeningBatch (api, role, partners, batch) {
  const amounts = ['123.45', '67.89']
  const lines = partners.map((partner, index) => ({
    ...(role === 'payable' ? { supplierId: partner.id } : { customerId: partner.id }),
    amt: amounts[index],
    detailsDesc: `${batch}-${index}`
  }))
  const id = numericId(dataOf(await api.postBusiness('/finance/dealingsBeginning/add', {
    dealingsLogotype: role,
    billDate: '2026-10-07',
    openingBaseDate: '2026-10-07',
    importBatchNo: batch,
    detailsDesc: batch,
    deviceSource: 'E2E-FMS',
    ...(role === 'payable' ? { finPayables: lines } : { finReceivables: lines })
  })))
  const bill = dataOf(await api.getBusiness(
    `/finance/dealingsBeginning/queryById?id=${encodeURIComponent(id)}`
  ))
  if (!bill?.id || bill.importBatchNo !== batch) {
    throw new Error(`FMS-005 未回读到本轮期初批次：${batch}`)
  }
  return { bill, expected: new Map(partners.map((partner, index) => [partner.id, amounts[index]])) }
}

function openingLedger (caseRecord, batch) {
  return database(caseRecord, `fms005-opening-${batch}`,
    `SELECT id,partner_id,subject_code,subject_id,auxiliary_item_id,amount,apply_status
     FROM fms_partner_opening_balance WHERE tenant_id=1 AND deleted=0
     AND account_set_id=${config.fmsAccountSetId} AND import_batch_no='${batch}' ORDER BY partner_id`)
}

// 汇总 FMS 科目期初中指定辅助核算项的余额，用于核对辅助核算金额。
function assistTotal (rows, subjectId, itemId) {
  const subject = (rows || []).find((row) => String(row.subjectId) === String(subjectId))
  return (subject?.assistBalances || []).filter((row) =>
    (row.auxiliaries || []).some((auxiliary) =>
      String(auxiliary.itemId) === String(itemId)))
    .reduce((sum, row) => sum + money(row.openingAmount), 0)
}

async function fmsBalances (api, role) {
  const subjectType = role === 'payable' ? 2 : 1
  return dataOf(await api.getBusiness(
    `/fms/config/initial-balance/list?accountSetId=${config.fmsAccountSetId}&subjectType=${subjectType}`))
}

async function approveOpening (api, bill, batch) {
  // dealings_beginning.approval_remark is varchar(32); keep the audit note short.
  await api.putBusiness('/finance/dealingsBeginning/check', {
    id: bill.id,
    approvalResultType: '1',
    approvalRemark: batch.slice(0, 32)
  })
  await api.postBusiness('/finance/dealingsBeginning/syncOpening', { id: bill.id })
  const effective = dataOf(await api.getBusiness(
    `/finance/dealingsBeginning/queryById?id=${encodeURIComponent(bill.id)}`
  ))
  if (String(effective?.isEffective) !== '1') {
    throw new Error(`FMS-005 期初批次审核后未生效：${JSON.stringify(effective)}`)
  }
  return effective
}

export async function readReceiptEntries(api, id, partnerId, amount) {
  const requested = numericId(id)
  const partner = numericId(partnerId)
  const path = `/finance/finReceipt/list/102?id=${encodeURIComponent(requested)}&pageNo=1&pageSize=100`
  const response = assertBusinessSuccess(await api.getBusiness(path), '收款明细正式分页')
  const page = response.data
  if (!Array.isArray(page?.records) || Number(page.total) !== 1 || page.records.length !== 1) {
    throw new Error('FMS-005 收款精确查询没有返回唯一主单')
  }
  const receipt = page.records[0]
  if (numericId(receipt?.id) !== requested || numericId(receipt.customerId) !== partner ||
      money(receipt.amt) !== money(amount)) {
    throw new Error('FMS-005 收款主单身份、客商或金额不一致')
  }
  const entries = receipt.finReceiptEntryList
  if (!Array.isArray(entries) || entries.length !== 1 ||
      entries.some((entry) => numericId(entry?.mid) !== requested ||
        !/^[1-9]\d*$/.test(numericId(entry?.id))) ||
      money(entries[0].amt) !== money(amount)) {
    throw new Error('FMS-005 收款正式明细缺少真实主键、正确归属或金额')
  }
  return entries
}

export function registerReceiptResource (fixture, id, partnerId, amount) {
  fixture.writeoffStarted = true
  fixture.receiptId = numericId(id)
  fixture.receiptPartnerId = numericId(partnerId)
  fixture.receiptAmount = amount
  return fixture
}

export function registerReceivableCheckResource (fixture, id) {
  fixture.checkId = numericId(id)
  return fixture
}

async function createReceipt (api, partnerId, accountId, key, amount = '123.45', fixture) {
  const body = {
    billNo: financialFixtureBillNo(key, 'RCPT'),
    billDate: '2026-10-07',
    isAuto: 0,
    isRubric: 0,
    isRequest: 0,
    receiptType: '102',
    customerId: partnerId,
    bankAccountId: accountId,
    collectionItem: '1',
    settleMethod: '1',
    discountAmt: 0,
    checkedAmt: 0,
    amt: amount,
    deviceSource: 'E2E-FMS',
    detailsRemark: key,
    finReceiptEntryList: [{
      entryNo: 1,
      amt: amount,
      discountAmt: 0,
      checkedAmt: 0,
      bankAccountId: accountId,
      settleMethod: '1',
      collectionItem: '1',
      description: key
    }]
  }
  const id = numericId(dataOf(await api.postBusiness('/finance/finReceipt/add/submit', body)))
  if (fixture) registerReceiptResource(fixture, id, partnerId, amount)
  let receipt = dataOf(await api.getBusiness(
    `/finance/finReceipt/queryById?id=${encodeURIComponent(id)}`
  ))
  if (String(receipt?.isEffective) !== '1') {
    await api.putBusiness('/finance/finReceipt/check', {
      id,
      approvalResultType: '1',
      approvalRemark: key
    })
    receipt = dataOf(await api.getBusiness(`/finance/finReceipt/queryById?id=${encodeURIComponent(id)}`))
  }
  if (receipt?.billStage === '24') {
    await api.putBusiness('/finance/finReceipt/execute', { id })
    receipt = dataOf(await api.getBusiness(`/finance/finReceipt/queryById?id=${encodeURIComponent(id)}`))
  }
  if (String(receipt?.isEffective) !== '1') {
    throw new Error(`FMS-005 收款单未生效：${JSON.stringify(receipt)}`)
  }
  // The display VO omits IDs; the formal list embeds original entry DOs.
  const entries = await readReceiptEntries(api, id, partnerId, amount)
  const entry = entries[0]
  return { id, receipt, entry }
}

async function openingReceivable (api, billId) {
  const rows = dataOf(await api.postBusiness('/finance/dealingsBeginning/selectByMainId', {
    id: billId,
    dealingsLogotype: 'receivable'
  }))
  const receivable = (Array.isArray(rows) ? rows : []).find((row) =>
    String(row.srcBillId) === String(billId))
  if (!receivable?.id) {
    throw new Error(`FMS-005 未回读到期初应收主单：${JSON.stringify(rows)}`)
  }
  const entries = dataOf(await api.getBusiness(
    `/finance/finReceivable/queryFinReceivableEntryByMainId?id=${encodeURIComponent(receivable.id)}`
  ))
  const entry = (Array.isArray(entries) ? entries : []).find((row) =>
    String(row.mid) === String(receivable.id))
  if (!entry?.id) {
    throw new Error(`FMS-005 未回读到期初应收明细：${JSON.stringify(entries)}`)
  }
  return { receivable, entry }
}

async function openingPayable (api, billId) {
  const rows = dataOf(await api.postBusiness('/finance/dealingsBeginning/selectByMainId', {
    id: billId,
    dealingsLogotype: 'payable'
  }))
  const payable = (Array.isArray(rows) ? rows : []).find((row) =>
    String(row.srcBillId) === String(billId) || String(row.mid) === String(billId))
  if (!payable?.id) {
    throw new Error(`FMS-005 未回读到期初应付主单：${JSON.stringify(rows)}`)
  }
  const entries = dataOf(await api.getBusiness(
    `/finance/finPayable/queryFinPayableSubByMainId?id=${encodeURIComponent(payable.id)}`
  ))
  const entry = (Array.isArray(entries) ? entries : []).find((row) =>
    String(row.mid) === String(payable.id))
  if (!entry?.id) {
    throw new Error(`FMS-005 未回读到期初应付明细：${JSON.stringify(entries)}`)
  }
  return { payable, entry }
}

export async function readPaymentEntries (api, id, supplierId, amount) {
  const paymentId = numericId(id)
  const supplier = numericId(supplierId)
  const payment = dataOf(await api.getBusiness(
    `/finance/finPayment/queryById?id=${encodeURIComponent(paymentId)}`
  ))
  if (numericId(payment?.id) !== paymentId || numericId(payment?.supplierId) !== supplier ||
      money(payment?.amt) !== money(amount)) {
    throw new Error('FMS-005 付款主单身份、供应商或金额不一致')
  }
  // queryEntryByMainId returns FinPaymentEntryListVo, whose contract omits
  // entry identity/source fields. Keep it for display-row and amount checks.
  const displayEntries = dataOf(await api.getBusiness(
    `/finance/finPayment/queryEntryByMainId?id=${encodeURIComponent(paymentId)}`
  ))
  if (!Array.isArray(displayEntries) || displayEntries.length !== 1 ||
      money(displayEntries[0]?.amt) !== money(amount)) {
    throw new Error('FMS-005 付款展示明细缺少唯一行或金额不一致')
  }
  // The list endpoint assembles FinPaymentPage.finPaymentEntryList from the
  // original FinPaymentEntry DOs, preserving id/mid/source linkage.
  const listResponse = assertBusinessSuccess(await api.getBusiness(
    `/finance/finPayment/list?pageNo=1&pageSize=100&id=${encodeURIComponent(paymentId)}&paymentType=${encodeURIComponent(payment.paymentType || '')}`
  ), '付款主单分页正式回读')
  const page = listResponse.data
  if (!Array.isArray(page?.records) || Number(page.total) !== 1 || page.records.length !== 1) {
    throw new Error('FMS-005 付款主单分页没有返回唯一记录')
  }
  const listedPayment = page.records[0]
  const entries = listedPayment.finPaymentEntryList
  if (numericId(listedPayment?.id) !== paymentId ||
      numericId(listedPayment?.supplierId) !== supplier ||
      money(listedPayment?.amt) !== money(amount) ||
      !Array.isArray(entries) || entries.length !== 1 ||
      entries.some((entry) => numericId(entry?.mid) !== paymentId ||
        !/^[1-9]\d*$/.test(numericId(entry?.id)) || money(entry.amt) !== money(amount))) {
    throw new Error('FMS-005 付款正式明细缺少真实主键、正确归属或金额')
  }
  return { payment, entries, displayEntries, listedPayment }
}

async function readPayableChecks (api, paymentId) {
  const response = assertBusinessSuccess(await api.getBusiness(
    `/finance/finPayableCheck/list/2?pageNo=1&pageSize=100&srcBillId=${encodeURIComponent(paymentId)}`
  ), '应付核销正式分页')
  const page = response.data
  const rows = page?.records || page?.list
  if (!Array.isArray(rows)) throw new Error('FMS-005 应付核销分页结构无效')
  return rows
}

function payableWriteOffParams (fixture) {
  const payableEntryId = fixture?.payableEntry?.id
  if (!fixture?.paymentId || !fixture?.payableId || !payableEntryId ||
      !fixture?.supplierId || fixture?.amount === undefined) {
    throw new Error('FMS-005 应付清理缺少已登记的付款、应付明细、供应商或金额')
  }
  return {
    paymentId: fixture.paymentId,
    payableId: fixture.payableId,
    payableEntryId,
    supplierId: fixture.supplierId,
    amount: fixture.amount
  }
}

async function recoverPayableCheckForCleanup (api, fixture) {
  const params = payableWriteOffParams(fixture)
  if (!fixture.paymentEntryId) {
    const paymentEvidence = await readPaymentEntries(
      api, fixture.paymentId, fixture.supplierId, fixture.amount
    )
    registerPaymentEntryResource(fixture, paymentEvidence.entries[0].id)
  }
  if (!fixture.checkId) {
    throw new Error('FMS-005 核销回读失败且未登记 checkId，拒绝猜测后置单据')
  }
  const check = dataOf(assertBusinessSuccess(await api.getBusiness(
    `/finance/finPayableCheck/queryById?id=${encodeURIComponent(numericId(fixture.checkId))}`
  ), '已登记应付核销单回读'))
  const evidence = await readPayableCheckEvidence(api, check, {
    ...params,
    paymentEntryId: fixture.paymentEntryId
  })
  fixture.checkId = numericId(evidence.check.id)
  fixture.check = evidence.check
  fixture.checkEntries = evidence.checkEntries
  return evidence.check
}

export function registerPayableResources (fixture, payable, entry, { supplierId, amount } = {}) {
  Object.assign(fixture, {
    payableId: payable.id,
    payable,
    payableEntry: entry,
    supplierId: supplierId ?? payable.supplierId,
    amount: amount ?? payable.amt
  })
  return fixture
}

export function registerPaymentResource (fixture, paymentId) {
  fixture.writeoffStarted = true
  fixture.paymentId = numericId(paymentId)
  return fixture
}

export function registerPaymentEntryResource (fixture, paymentEntryId) {
  fixture.paymentEntryId = numericId(paymentEntryId)
  return fixture
}

export function registerPayableCheckResource (fixture, checkId) {
  fixture.checkId = numericId(checkId)
  return fixture
}

async function readPayableCheckEvidence (api, check, {
  paymentId, payableId, payableEntryId, paymentEntryId, supplierId, amount
}) {
  const checkId = numericId(check?.id)
  if (String(check.srcBillId) !== String(paymentId) ||
      numericId(check.supplierId) !== numericId(supplierId) ||
      money(check.amt) !== money(amount) ||
      String(check.isEffective) !== '1' || String(check.isVoided) !== '0') {
    throw new Error(`FMS-005 应付核销主单归属、金额或生效状态不一致：${JSON.stringify(check)}`)
  }
  const checkEntries = dataOf(await api.getBusiness(
    `/finance/finPayableCheck/queryEntryByMainId?id=${encodeURIComponent(checkId)}`
  ))
  const entries = Array.isArray(checkEntries) ? checkEntries : []
  const payableSide = entries.find((entry) => String(entry.checkSide) === '1')
  const paymentSide = entries.find((entry) => String(entry.checkSide) === '2')
  if (entries.length !== 2 || !payableSide || !paymentSide ||
      String(payableSide.srcBillId) !== String(payableId) ||
      String(payableSide.srcEntryId) !== String(payableEntryId) ||
      String(paymentSide.srcBillId) !== String(paymentId) ||
      String(paymentSide.srcEntryId) !== String(paymentEntryId) ||
      money(payableSide.amt) !== money(amount) ||
      money(paymentSide.amt) !== money(amount)) {
    throw new Error(`FMS-005 应付核销明细归属或金额不一致：${JSON.stringify(checkEntries)}`)
  }
  return { check, checkEntries: entries }
}

async function readWithdrawnPayableCheckEvidence (api, check, {
  paymentId, payableId, payableEntryId, paymentEntryId, supplierId, amount
}) {
  const checkId = numericId(check?.id)
  if (String(check.srcBillId) !== String(paymentId) ||
      numericId(check.supplierId) !== numericId(supplierId) ||
      money(check.amt) !== money(amount) ||
      String(check.billStage) !== '12' || String(check.isEffective) !== '0') {
    throw new Error(`FMS-005 应付核销弃审后主单归属、金额或状态不一致：${JSON.stringify(check)}`)
  }
  const entries = dataOf(await api.getBusiness(
    `/finance/finPayableCheck/queryEntryByMainId?id=${encodeURIComponent(checkId)}`
  ))
  const rows = Array.isArray(entries) ? entries : []
  const payableSide = rows.find((entry) => String(entry.checkSide) === '1')
  const paymentSide = rows.find((entry) => String(entry.checkSide) === '2')
  if (rows.length !== 2 || !payableSide || !paymentSide ||
      String(payableSide.srcBillId) !== String(payableId) ||
      String(payableSide.srcEntryId) !== String(payableEntryId) ||
      String(paymentSide.srcBillId) !== String(paymentId) ||
      String(paymentSide.srcEntryId) !== String(paymentEntryId) ||
      money(payableSide.amt) !== money(amount) ||
      money(paymentSide.amt) !== money(amount)) {
    throw new Error(`FMS-005 应付核销弃审后明细归属或金额不一致：${JSON.stringify(entries)}`)
  }
  return rows
}

export async function readPayableWriteOffEvidence (api, {
  paymentId, payableId, payableEntryId, supplierId, amount
}, fixture) {
  const { payment, entries: paymentEntries } = await readPaymentEntries(
    api, paymentId, supplierId, amount
  )
  if (fixture) {
    registerPaymentEntryResource(fixture, paymentEntries[0].id)
    fixture.payment = payment
    fixture.paymentEntries = paymentEntries
  }
  const checks = await readPayableChecks(api, paymentId)
  const matches = checks.filter((row) => String(row.srcBillId) === String(paymentId) &&
    numericId(row.supplierId) === numericId(supplierId) &&
    money(row.amt) === money(amount) && String(row.isEffective) === '1' &&
    String(row.isVoided) === '0')
  if (matches.length !== 1) {
    throw new Error(`FMS-005 未回读到已生效应付核销单：${JSON.stringify(checks)}`)
  }
  if (fixture) registerPayableCheckResource(fixture, matches[0].id)
  const checkEvidence = await readPayableCheckEvidence(api, matches[0], {
    paymentId,
    payableId,
    payableEntryId,
    paymentEntryId: paymentEntries[0].id,
    supplierId,
    amount
  })
  const payable = dataOf(await api.getBusiness(
    `/finance/finPayable/queryById?id=${encodeURIComponent(payableId)}`
  ))
  if (numericId(payable?.id) !== numericId(payableId) ||
      numericId(payable?.supplierId) !== numericId(supplierId) ||
      money(payable?.amt) !== money(amount) || money(payable?.checkedAmt) !== money(amount)) {
    throw new Error(`FMS-005 应付主单归属、金额或已核销金额不一致：${JSON.stringify(payable)}`)
  }
  return { payment, paymentEntries, check: checkEvidence.check,
    checkEntries: checkEvidence.checkEntries, payable }
}

export async function assertDeletedById (api, pathname, label) {
  const expected = {
    code: 500,
    message: '未找到对应数据',
    allowServiceCode: true
  }
  const response = await (typeof api.get === 'function'
    ? api.get(pathname, { expectedBusinessRejection: expected })
    : api.getBusiness(pathname, { expectedBusinessRejection: expected }))
  if (!matchesExpectedBusinessRejection(response, expected)) {
    if (response && (response.success === true || response.code === 0 ||
        (response.code === 200 && response.success !== false))) {
      throw new Error(`${label}按 ID 回读仍存在`)
    }
    throw new Error(`${label}删除后未取得精确的不存在证据：${JSON.stringify(response)}`)
  }
}

async function createReceivableCheck (api, { partnerId, accountId, receivable, entry, receipt, receiptEntry, key, fixture }) {
  const amount = '123.45'
  const billNo = dataOf(assertBusinessSuccess(await api.putBusiness(
    '/mes/fillRule/executeRuleByCode/fin_yshx_bill_no', {}
  ), '核销单正式取号'))
  if (typeof billNo !== 'string' || !/^YSHX-\d{6}-\d{3,}$/.test(billNo)) {
    throw new Error('FMS-005 正式核销取号没有返回历史编号格式')
  }
  const body = {
    billNo,
    billDate: '2026-10-07',
    isAuto: 0,
    isRubric: 0,
    isRequest: 0,
    receivableCheckType: '1',
    customerId: partnerId,
    bankAccountId: accountId,
    collectionItem: '1',
    settleMethod: '1',
    discountAmt: 0,
    checkedAmt: 0,
    amt: amount,
    deviceSource: 'E2E-FMS',
    detailsRemark: key,
    finReceivableCheckEntryList: [
      {
        entryNo: 1,
        checkSide: '1',
        srcBillType: 'FinReceivable',
        srcBillId: receivable.id,
        srcEntryId: entry.id,
        srcNo: receivable.billNo,
        amt: amount,
        discountAmt: 0,
        collectionItem: '1',
        settleMethod: '1',
        bankAccountId: accountId,
        srcBillAmt: receivable.amt,
        remark: key
      },
      {
        entryNo: 2,
        checkSide: '2',
        srcBillType: 'FinReceipt',
        srcBillId: receipt.id,
        srcEntryId: receiptEntry.id,
        srcNo: receipt.receipt.billNo,
        amt: amount,
        discountAmt: 0,
        collectionItem: '1',
        settleMethod: '1',
        bankAccountId: accountId,
        srcBillAmt: receipt.receipt.amt,
        remark: key
      }
    ]
  }
  const id = numericId(dataOf(await api.postBusiness(
    '/finance/finReceivableCheck/add/submit',
    body
  )))
  if (fixture) registerReceivableCheckResource(fixture, id)
  let bill = dataOf(await api.getBusiness(
    `/finance/finReceivableCheck/queryById?id=${encodeURIComponent(id)}`
  ))
  if (String(bill?.isEffective) !== '1') {
    await api.putBusiness('/finance/finReceivableCheck/check', {
      id,
      approvalResultType: '1',
      approvalRemark: key
    })
    bill = dataOf(await api.getBusiness(
      `/finance/finReceivableCheck/queryById?id=${encodeURIComponent(id)}`
    ))
  }
  if (bill?.billStage === '24') {
    await api.putBusiness('/finance/finReceivableCheck/execute', { id })
    bill = dataOf(await api.getBusiness(
      `/finance/finReceivableCheck/queryById?id=${encodeURIComponent(id)}`
    ))
  }
  const entries = dataOf(await api.getBusiness(
    `/finance/finReceivableCheck/queryEntryByMainId?id=${encodeURIComponent(id)}`
  ))
  return { id, bill, entries: Array.isArray(entries) ? entries : [] }
}

async function readReceivable (api, id) {
  return dataOf(await api.getBusiness(
    `/finance/finReceivable/queryById?id=${encodeURIComponent(id)}`
  ))
}

async function expectWriteOffRejected (api, method, pathname, body, expected, key) {
  const rejection = {
    code: 500, message: /^期初应[收付]已发生核销，不能修改或弃审$/, allowServiceCode: true
  }
  const response = await api.request(method, pathname, body, { expectedBusinessRejection: rejection })
  const message = String(response?.msg || response?.message || '')
  const passed = matchesExpectedBusinessRejection(response, rejection) && message.includes(expected)
  return { response, message, passed, key }
}

export async function cleanupWriteOff (api, fixture) {
  if (fixture.role === 'payable') {
    await cleanupPayableWriteOff(api, fixture)
    return
  }
  if (!fixture?.checkId) {
    if (fixture?.writeoffStarted) {
      const message = '应收写入已开始但未登记可反向清理的核销单 ID'
      fixture.writeoffCleanupError = message
      fixture.writeoffCleanup = `RETAINED_AUDIT: ${message}`
      fixture.cleanup = fixture.writeoffCleanup
    }
    return
  }
  try {
    await api.putBusiness('/finance/finReceivableCheck/void', { id: fixture.checkId })
    fixture.writeoffCleaned = true
    fixture.writeoffCleanup = 'CLEANED_API: 已通过核销单作废反向回写'
    fixture.cleanup = fixture.writeoffCleanup
  } catch (error) {
    fixture.cleanup = `RETAINED_AUDIT: 核销单反向清理失败：${error.message}`
    fixture.writeoffCleanupError = error.message
  }
}

async function cleanupPayableWriteOff (api, fixture) {
  if (!fixture?.paymentId) {
    if (fixture?.writeoffStarted) {
      const message = '付款写入已开始但未登记可清理的付款 ID'
      fixture.writeoffCleanupError = message
      fixture.writeoffCleanup = `RETAINED_AUDIT: ${message}`
      fixture.cleanup = fixture.writeoffCleanup
    }
    return
  }
  try {
    const params = payableWriteOffParams(fixture)
    let before
    try {
      before = await readPayableWriteOffEvidence(api, params, fixture)
    } catch (readError) {
      fixture.writeoffReadError = readError.message
      await recoverPayableCheckForCleanup(api, fixture)
      before = {
        payment: dataOf(await api.getBusiness(
          `/finance/finPayment/queryById?id=${encodeURIComponent(fixture.paymentId)}`
        ))
      }
    }
    const checkId = before.check?.id || fixture.checkId
    if (!checkId) throw new Error('FMS-005 应付清理未登记真实核销单')
    fixture.checkId = numericId(checkId)
    await api.putBusiness('/finance/finPayableCheck/void', { id: fixture.checkId })
    const withdrawnCheck = dataOf(await api.getBusiness(
      `/finance/finPayableCheck/queryById?id=${encodeURIComponent(fixture.checkId)}`
    ))
    const withdrawnPayment = dataOf(await api.getBusiness(
      `/finance/finPayment/queryById?id=${encodeURIComponent(fixture.paymentId)}`
    ))
    const withdrawnPayable = dataOf(await api.getBusiness(
      `/finance/finPayable/queryById?id=${encodeURIComponent(fixture.payableId)}`
    ))
    if (numericId(withdrawnCheck?.id) !== fixture.checkId ||
        String(withdrawnCheck?.srcBillId) !== String(fixture.paymentId) ||
        numericId(withdrawnCheck?.supplierId) !== numericId(fixture.supplierId) ||
        money(withdrawnCheck?.amt) !== money(fixture.amount) ||
        String(withdrawnCheck?.billStage) !== '12' || String(withdrawnCheck?.isEffective) !== '0' ||
        numericId(withdrawnPayment?.id) !== numericId(fixture.paymentId) ||
        numericId(withdrawnPayable?.id) !== numericId(fixture.payableId) ||
        money(withdrawnPayment?.checkedAmt) !== 0 || money(withdrawnPayable?.checkedAmt) !== 0) {
      throw new Error(`应付核销弃审后状态/余额不一致：${JSON.stringify({
        withdrawnCheck, withdrawnPayment, withdrawnPayable
      })}`)
    }
    await readWithdrawnPayableCheckEvidence(api, withdrawnCheck, {
      paymentId: fixture.paymentId,
      payableId: fixture.payableId,
      payableEntryId: fixture.payableEntry.id,
      paymentEntryId: fixture.paymentEntryId,
      supplierId: fixture.supplierId,
      amount: fixture.amount
    })
    fixture.writeoffReverseEvidence = {
      check: withdrawnCheck, payment: withdrawnPayment, payable: withdrawnPayable
    }
    // ERP void returns a draft, so remove only this registered downstream
    // fixture through the formal delete contract before withdrawing its source.
    await api.deleteBusiness(
      `/finance/finPayableCheck/delete?id=${encodeURIComponent(fixture.checkId)}`
    )
    await assertDeletedById(
      api,
      `/finance/finPayableCheck/queryById?id=${encodeURIComponent(fixture.checkId)}`,
      '应付核销单'
    )
    const checks = await readPayableChecks(api, fixture.paymentId)
    if (checks.some((row) => String(row.id) === String(fixture.checkId))) {
      throw new Error('应付核销单正式删除后仍可回读')
    }
    fixture.checkDeleted = true
    if (String(withdrawnPayment.isEffective) === '1') {
      await api.putBusiness('/finance/finPayment/void', { id: fixture.paymentId })
    }
    const payment = dataOf(await api.getBusiness(
      `/finance/finPayment/queryById?id=${encodeURIComponent(fixture.paymentId)}`
    ))
    const payable = dataOf(await api.getBusiness(
      `/finance/finPayable/queryById?id=${encodeURIComponent(fixture.payableId)}`
    ))
    if (numericId(payment?.id) !== numericId(fixture.paymentId) ||
        numericId(payment?.supplierId) !== numericId(fixture.supplierId) ||
        money(payment?.amt) !== money(fixture.amount) ||
        String(payment?.billStage) !== '12' || String(payment?.isEffective) !== '0' ||
        numericId(payable?.id) !== numericId(fixture.payableId) ||
        money(payment?.checkedAmt) !== 0 || money(payable?.checkedAmt) !== 0) {
      throw new Error(`应付付款撤核销后状态/余额不一致：${JSON.stringify({ payment, payable })}`)
    }
    fixture.paymentReverseEvidence = payment
    await api.deleteBusiness(
      `/finance/finPayment/delete?id=${encodeURIComponent(fixture.paymentId)}`
    )
    await assertDeletedById(
      api,
      `/finance/finPayment/queryById?id=${encodeURIComponent(fixture.paymentId)}`,
      '应付付款单'
    )
    const paymentList = assertBusinessSuccess(await api.getBusiness(
      `/finance/finPayment/list?pageNo=1&pageSize=100&id=${encodeURIComponent(fixture.paymentId)}`
    ), '付款草稿正式删除回读').data
    if (!Array.isArray(paymentList?.records) || paymentList.records.length !== 0 ||
        Number(paymentList.total) !== 0) {
      throw new Error('应付付款草稿正式删除后仍可回读')
    }
    fixture.paymentDeleted = true
    fixture.writeoffCleaned = true
    fixture.writeoffCleanup = 'CLEANED_API: 应付核销单和付款依次正式弃审、删除，并回读编制中、余额归零及删除不存在'
    fixture.cleanup = fixture.writeoffCleanup
  } catch (error) {
    fixture.writeoffCleanup = `RETAINED_AUDIT: 应付付款撤核销清理失败：${error.message}`
    fixture.cleanup = fixture.writeoffCleanup
    fixture.writeoffCleanupError = error.message
  }
}

export async function cleanupOpening (api, fixture) {
  if (!fixture?.id) return
  if (fixture.writeoffCleanupError ||
      (fixture.writeoffStarted && !fixture.writeoffCleaned)) return
  try {
    const current = dataOf(await api.getBusiness(
      `/finance/dealingsBeginning/queryById?id=${encodeURIComponent(fixture.id)}`))
    if (numericId(current?.id) !== numericId(fixture.id) || current.importBatchNo !== fixture.batch) {
      throw new Error('期初清理回读身份或批次不一致')
    }
    if (String(current.isVoided) !== '1' && String(current.isEffective) === '1') {
      await api.putBusiness('/finance/dealingsBeginning/void', { id: fixture.id })
    } else if (!['0', '1'].includes(String(current.isEffective))) {
      throw new Error('期初清理生效状态未知')
    }
    await api.deleteBusiness(
      `/finance/dealingsBeginning/delete?id=${encodeURIComponent(fixture.id)}`
    )
    const response = assertBusinessSuccess(await api.getBusiness(
      `/finance/dealingsBeginning/list?id=${encodeURIComponent(fixture.id)}&pageNo=1&pageSize=100`))
    if (!Array.isArray(response.data?.records) || response.data.records.length ||
        Number(response.data.total) !== 0) throw new Error('期初删除后仍可回读')
    fixture.cleanup = `CLEANED_API: 期初批次正式删除并回读不存在${fixture.writeoffCleanup ? `；${fixture.writeoffCleanup}` : ''}`
  } catch (error) {
    fixture.cleanup = `RETAINED_AUDIT: 期初批次清理失败：${error.message}`
  }
}

async function buildWrittenOffOpening (api, common, key, effective, register = () => {}) {
  const batch = unique(`E2E-FMS-005-${effective ? 'EFFECTIVE' : 'DRAFT'}`)
  const bill = await createOpening(api, common.partner, batch)
  const fixture = { id: bill.id, batch, bill, role: 'receivable', cleanup: 'PENDING' }
  register(fixture)
  try {
    if (effective) await approveOpening(api, bill, batch)
    const { receivable, entry } = await openingReceivable(api, bill.id)
    const receipt = await createReceipt(
      api, common.partner.id, common.accountId, `${key}-${effective ? 'A' : 'B'}`, '123.45', fixture
    )
    const check = await createReceivableCheck(api, {
      partnerId: common.partner.id,
      accountId: common.accountId,
      receivable,
      entry,
      receipt,
      receiptEntry: receipt.entry,
      key,
      fixture
    })
    const persistedReceivable = await readReceivable(api, receivable.id)
    Object.assign(fixture, {
      receivable,
      entry,
      receipt,
      checkId: check.id,
      check: check.bill,
      checkEntries: check.entries,
      persistedReceivable
    })
  } catch (error) {
    // 保留半成品夹具并在 finally 中受控清理，避免遗留未结清期初。
    fixture.error = error.message
  }
  return fixture
}

async function buildWrittenOffPayable (api, common, key, effective, register = () => {}) {
  // fin_payable.src_no receives importBatchNo and is varchar(50); keep the
  // ownership marker short while retaining the full key in bill remarks.
  const batch = unique(payableBatchPrefix(effective))
  const bill = await createOpening(api, common.partner, batch, '123.45', 'payable')
  const fixture = { id: bill.id, batch, role: 'payable', bill, cleanup: 'PENDING' }
  register(fixture)
  try {
    if (effective) await approveOpening(api, bill, batch)
    const { payable, entry } = await openingPayable(api, bill.id)
    registerPayableResources(fixture, payable, entry, {
      supplierId: common.partner.id,
      amount: '123.45'
    })
    const paymentKey = `${key}-${effective ? 'E' : 'D'}-AP-PAYMENT`
    const paymentBody = {
      billNo: financialFixtureBillNo(paymentKey, 'PAY'),
      billDate: '2026-10-07',
      srcBillType: payable.billType,
      srcBillId: payable.id,
      srcNo: payable.billNo,
      isAuto: 0,
      isRubric: 0,
      isRequest: 0,
      paymentType: '2021',
      supplierId: common.partner.id,
      bankAccountId: common.accountId,
      collectionItem: '1',
      settleMethod: '1',
      discountAmt: 0,
      checkedAmt: 0,
      amt: '123.45',
      deviceSource: 'E2E-FMS',
      detailsRemark: paymentKey,
      finPaymentEntryList: [{
        entryNo: 1,
        srcBillType: payable.billType,
        srcBillId: payable.id,
        srcEntryId: entry.id,
        srcNo: payable.billNo,
        amt: '123.45',
        discountAmt: 0,
        checkedAmt: 0,
        bankAccountId: common.accountId,
        settleMethod: '1',
        collectionItem: '1',
        description: paymentKey
      }]
    }
    fixture.writeoffStarted = true
    const paymentId = numericId(dataOf(await api.postBusiness(
      '/finance/finPayment/add/submit', paymentBody
    )))
    registerPaymentResource(fixture, paymentId)
    let payment = dataOf(await api.getBusiness(
      `/finance/finPayment/queryById?id=${encodeURIComponent(paymentId)}`
    ))
    fixture.payment = payment
    if (String(payment?.isEffective) !== '1') {
      await api.putBusiness('/finance/finPayment/checkFinPayable', {
        id: paymentId, approvalResultType: '1', approvalRemark: paymentKey
      })
      payment = dataOf(await api.getBusiness(
        `/finance/finPayment/queryById?id=${encodeURIComponent(paymentId)}`
      ))
    }
    if (String(payment?.isEffective) !== '1') {
      throw new Error(`FMS-005 应付付款未生效：${JSON.stringify(payment)}`)
    }
    if (String(payment?.billStage) === '24') {
      await api.putBusiness('/finance/finPayment/execute', { id: paymentId })
    }
    const evidence = await readPayableWriteOffEvidence(api, {
      paymentId,
      payableId: payable.id,
      payableEntryId: entry.id,
      supplierId: common.partner.id,
      amount: '123.45'
    }, fixture)
    Object.assign(fixture, {
      payable: evidence.payable,
      payment: evidence.payment,
      paymentEntries: evidence.paymentEntries,
      checkId: evidence.check.id,
      check: evidence.check,
      checkEntries: evidence.checkEntries
    })
  } catch (error) {
    fixture.error = error.message
  }
  return fixture
}

export async function deleteOpeningSummaryFixture(api, fixture) {
  if (fixture.deleted) return
  const id = numericId(fixture.id)
  if (!/^E2E-FMS-005-[A-Z0-9-]+$/.test(fixture.batch || '')) {
    throw new Error('FMS-005 清理必须限定本轮专属期初批次')
  }
  if (!fixture.voided) {
    await api.putBusiness('/finance/dealingsBeginning/void', { id })
    fixture.voided = true
  }
  await api.deleteBusiness(`/finance/dealingsBeginning/delete?id=${encodeURIComponent(id)}`)
  const response = assertBusinessSuccess(await api.getBusiness(
    `/finance/dealingsBeginning/list?id=${encodeURIComponent(id)}&pageNo=1&pageSize=100`
  ), '删除期初批次回读')
  const rows = response.data?.records
  if (!Array.isArray(rows) || Number(response.data.total) !== 0 || rows.length !== 0) {
    throw new Error('FMS-005 删除后仍返回期初批次或回读结构无效')
  }
  fixture.deleted = true
  fixture.cleanup = 'CLEANED_API: 期初批次已弃审、删除并回读不存在'
}

async function runFms005Summary (ctx) {
  const key = `E2E-FMS-005-SUMMARY-${Date.now().toString(36).toUpperCase()}`
  const batches = []
  const a0 = []
  const a1 = []
  const a2 = []
  const a3 = []
  const reverse = []
  let passed = true
  try {
    for (const role of ['receivable', 'payable']) {
      const batch = unique(`E2E-FMS-005-${role === 'payable' ? 'AP' : 'AR'}`)
      const partners = [
        await createPartner(ctx.api, `${batch}-A`),
        await createPartner(ctx.api, `${batch}-B`)
      ]
      const { bill, expected } = await createOpeningBatch(ctx.api, role, partners, batch)
      const fixture = { id: bill.id, batch, role, partnerIds: partners.map((p) => p.id), cleanup: 'PENDING' }
      batches.push(fixture)
      await approveOpening(ctx.api, bill, batch)
      const first = await openingLedger(ctx.caseRecord, batch)
      const initial = await fmsBalances(ctx.api, role)
      const ledgerOk = first.length === 2 && first.every((row) =>
        row[2] === (role === 'receivable' ? '1122' : '2202') &&
        row[6] === 'APPLIED' && money(row[5]) === money(expected.get(row[1]))) &&
        first.every((row) => assistTotal(initial, row[3], row[4]) === money(expected.get(row[1])))
      a0.push({ role, batch, ledger: first, passed: ledgerOk })
      passed = passed && ledgerOk

      for (let i = 0; i < 2; i++) {
        await ctx.api.postBusiness('/finance/dealingsBeginning/syncOpening', { id: bill.id })
      }
      const repeated = await openingLedger(ctx.caseRecord, batch)
      const repeatedBalances = await fmsBalances(ctx.api, role)
      const idempotent = JSON.stringify(first) === JSON.stringify(repeated) &&
        first.every((row) => assistTotal(initial, row[3], row[4]) === assistTotal(repeatedBalances, row[3], row[4]))
      a1.push({ role, batch, passed: idempotent })
      passed = passed && idempotent

      const reconcile = dataOf(await ctx.api.postBusiness(
        '/finance/dealingsBeginning/openingReconcile', { id: bill.id }))
      const reconcileOk = reconcileMatches(reconcile, expected)
      a3.push({ role, batch, reconcile, passed: reconcileOk })
      passed = passed && reconcileOk

      await ctx.api.putBusiness('/finance/dealingsBeginning/void', { id: bill.id })
      fixture.voided = true
      const reversed = await openingLedger(ctx.caseRecord, batch)
      const reversedBalances = await fmsBalances(ctx.api, role)
      const reversedOk = reversed.length === 2 && reversed.every((row) => row[6] === 'REVERSED') &&
        reversed.every((row) => assistTotal(reversedBalances, row[3], row[4]) === 0)
      a2.push({ role, batch, ledger: reversed, passed: reversedOk })
      reverse.push({ role, batch, passed: reversedOk })
      passed = passed && reversedOk
      await deleteOpeningSummaryFixture(ctx.api, fixture)
    }
  } finally {
    for (const fixture of batches.reverse()) {
      try {
        await deleteOpeningSummaryFixture(ctx.api, fixture)
      } catch (error) {
        fixture.cleanup = `RETAINED_AUDIT: 期初批次清理失败：${error.message}`
        check(ctx.caseRecord, 'FMS-005 期初汇总夹具正式清理', false, fixture.cleanup)
      }
    }
  }
  proof(ctx.caseRecord, '期初批次确认后按客户/供应商汇总生成 FMS 辅助核算期初', passed && a0.every((i) => i.passed),
    JSON.stringify(a0))
  proof(ctx.caseRecord, '同一批次重复投递幂等，不重复累计金额', passed && a1.every((i) => i.passed),
    JSON.stringify(a1))
  proof(ctx.caseRecord, '弃审后对应辅助核算期初金额回零', a2.length === 2 && a2.every((i) => i.passed),
    JSON.stringify(a2))
  proof(ctx.caseRecord, '对账接口返回逐客商状态和合计差异', a3.length === 2 && a3.every((i) => i.passed),
    JSON.stringify(a3))
  proof(ctx.caseRecord, '通过往来期初弃审撤销 FMS 汇总；错误调整走受控调整，不直接改科目期初',
    reverse.length === 2 && reverse.every((i) => i.passed), JSON.stringify(reverse))
  ctx.caseRecord.evidence.push(
    'JSON 写入口创建/审核/汇总/重复投递/对账/弃审撤销应收与应付期初批次，并核对 fms_partner_opening_balance 与科目辅助核算余额'
  )
}

async function runFms005WriteOff (ctx) {
  const key = `E2E-FMS-005-${Date.now().toString(36).toUpperCase()}`
  const partner = await createPartner(ctx.api, `${key}-CUSTOMER`)
  const accountId = await createAccount(ctx.api, `${key}-BANK`)
  const fixtures = []
  // Keep the catalog assertion text byte-for-byte stable; AP coverage is
  // included in the evidence without changing the declared assertion.
  const assertion = '已发生核销的批次禁止改、弃审和删除'
  try {
    const effectiveBatch = await buildWrittenOffOpening(ctx.api, { partner, accountId }, key, true)
    fixtures.push(effectiveBatch)
    if (effectiveBatch.error) {
      ctx.caseRecord.notes.push(
        `FMS-005 已核销批次探针前置未完成（未把环境异常伪装成通过）：${effectiveBatch.error}`
      )
      return
    }
    const amount = money(effectiveBatch.persistedReceivable.checkedAmt)
    const side1 = effectiveBatch.checkEntries.find((entry) => entry.checkSide === '1')
    const side2 = effectiveBatch.checkEntries.find((entry) => entry.checkSide === '2')
    check(ctx.caseRecord, '应收核销执行后回写期初应收已核销金额',
      amount === money('123.45') &&
      String(side1?.srcBillId) === String(effectiveBatch.receivable.id) &&
      String(side2?.srcBillId) === String(effectiveBatch.receipt.id),
    JSON.stringify({
      checkId: effectiveBatch.checkId,
      checkStatus: effectiveBatch.check?.billStage,
      checkedAmt: effectiveBatch.persistedReceivable.checkedAmt,
      side1: side1 && { srcBillId: side1.srcBillId, srcEntryId: side1.srcEntryId },
      side2: side2 && { srcBillId: side2.srcBillId, srcEntryId: side2.srcEntryId }
    }))

    const voidResult = await expectWriteOffRejected(
      ctx.api,
      'PUT',
      '/finance/dealingsBeginning/void',
      { id: effectiveBatch.bill.id },
      '已发生核销',
      key
    )
    check(ctx.caseRecord, '已核销批次弃审被后端拒绝并命中核销保护',
      voidResult.passed, JSON.stringify(voidResult.response))

    const updateResponse = await expectWriteOffRejected(
      ctx.api,
      'PUT',
      '/finance/dealingsBeginning/edit',
      {
        id: effectiveBatch.bill.id,
        billStage: '14',
        dealingsLogotype: 'receivable',
        openingBaseDate: '2026-10-07',
        importBatchNo: effectiveBatch.batch,
        finReceivables: []
      },
      '已发生核销',
      key
    )
    check(ctx.caseRecord, '已核销批次修改被后端拒绝并命中核销保护',
      updateResponse.passed, JSON.stringify(updateResponse.response))

    const draftBatch = await buildWrittenOffOpening(ctx.api, { partner, accountId }, key, false)
    fixtures.push(draftBatch)
    if (draftBatch.error) {
      ctx.caseRecord.notes.push(
        `FMS-005 未生效已核销批次删除探针前置未完成：${draftBatch.error}`
      )
      proof(ctx.caseRecord, assertion, false, JSON.stringify({
        void: voidResult.message,
        update: updateResponse.message,
        draftProbe: draftBatch.error
      }))
      return
    }
    const draftDelete = await expectWriteOffRejected(
      ctx.api,
      'DELETE',
      `/finance/dealingsBeginning/delete?id=${encodeURIComponent(draftBatch.bill.id)}`,
      undefined,
      '已发生核销',
      key
    )
    check(ctx.caseRecord, '已核销未生效批次删除被后端拒绝并命中核销保护',
      draftDelete.passed, JSON.stringify(draftDelete.response))

    const payableBatch = await buildWrittenOffPayable(
      ctx.api, { partner, accountId }, key, true
    )
    fixtures.push(payableBatch)
    if (payableBatch.error) {
      ctx.caseRecord.notes.push(
        `FMS-005 应付付款/核销探针前置未完成（未把环境异常伪装成通过）：${payableBatch.error}`
      )
      proof(ctx.caseRecord, assertion, false, JSON.stringify({
        void: voidResult.message,
        update: updateResponse.message,
        delete: draftDelete.message,
        payableProbe: payableBatch.error
      }))
      return
    }
    const payableSide1 = payableBatch.checkEntries.find((entry) => String(entry.checkSide) === '1')
    const payableSide2 = payableBatch.checkEntries.find((entry) => String(entry.checkSide) === '2')
    const payableEvidence = {
      paymentId: payableBatch.paymentId,
      payableId: payableBatch.payableId,
      checkId: payableBatch.checkId,
      supplierId: partner.id,
      paymentAmt: payableBatch.payment?.amt,
      payableCheckedAmt: payableBatch.payable?.checkedAmt,
      paymentEntryCount: payableBatch.paymentEntries?.length,
      checkEntryCount: payableBatch.checkEntries?.length,
      payableSide: payableSide1 && {
        srcBillId: payableSide1.srcBillId,
        srcEntryId: payableSide1.srcEntryId,
        amt: payableSide1.amt
      },
      paymentSide: payableSide2 && {
        srcBillId: payableSide2.srcBillId,
        srcEntryId: payableSide2.srcEntryId,
        amt: payableSide2.amt
      }
    }
    check(ctx.caseRecord, '应付正式付款自动生成核销并精确回写供应商、数量和金额',
      money(payableBatch.payment?.amt) === money('123.45') &&
      money(payableBatch.payable?.checkedAmt) === money('123.45') &&
      payableBatch.paymentEntries?.length === 1 &&
      payableBatch.checkEntries?.length === 2 &&
      money(payableSide1?.amt) === money('123.45') &&
      money(payableSide2?.amt) === money('123.45') &&
      String(payableSide1?.srcBillId) === String(payableBatch.payableId) &&
      String(payableSide2?.srcBillId) === String(payableBatch.paymentId),
    JSON.stringify(payableEvidence))

    const payableVoid = await expectWriteOffRejected(
      ctx.api,
      'PUT',
      '/finance/dealingsBeginning/void',
      { id: payableBatch.bill.id },
      '已发生核销',
      key
    )
    const payableUpdate = await expectWriteOffRejected(
      ctx.api,
      'PUT',
      '/finance/dealingsBeginning/edit',
      {
        id: payableBatch.bill.id,
        billStage: '14',
        dealingsLogotype: 'payable',
        openingBaseDate: '2026-10-07',
        importBatchNo: payableBatch.batch,
        finPayables: []
      },
      '已发生核销',
      key
    )
    check(ctx.caseRecord, '已核销应付批次弃审和修改均被后端精确拒绝',
      payableVoid.passed && payableUpdate.passed,
      JSON.stringify({ void: payableVoid.response, update: payableUpdate.response }))

    const payableDraft = await buildWrittenOffPayable(
      ctx.api, { partner, accountId }, key, false
    )
    fixtures.push(payableDraft)
    if (payableDraft.error) {
      ctx.caseRecord.notes.push(
        `FMS-005 未生效应付已核销批次删除探针前置未完成：${payableDraft.error}`
      )
      proof(ctx.caseRecord, assertion, false, JSON.stringify({
        void: voidResult.message,
        update: updateResponse.message,
        delete: draftDelete.message,
        payableVoid: payableVoid.message,
        payableUpdate: payableUpdate.message,
        payableDraft: payableDraft.error
      }))
      return
    }
    const payableDelete = await expectWriteOffRejected(
      ctx.api,
      'DELETE',
      `/finance/dealingsBeginning/delete?id=${encodeURIComponent(payableDraft.bill.id)}`,
      undefined,
      '已发生核销',
      key
    )
    check(ctx.caseRecord, '已核销未生效应付批次删除被后端精确拒绝',
      payableDelete.passed, JSON.stringify(payableDelete.response))

    const evidence = JSON.stringify({
      effectiveBatch: effectiveBatch.batch,
      draftBatch: draftBatch.batch,
      void: voidResult.message,
      update: updateResponse.message,
      delete: draftDelete.message,
      checkIds: [effectiveBatch.checkId, draftBatch.checkId, payableBatch.checkId, payableDraft.checkId],
      payable: {
        void: payableVoid.message,
        update: payableUpdate.message,
        delete: payableDelete.message,
        evidence: payableEvidence
      }
    })
    const passed = voidResult.passed && updateResponse.passed && draftDelete.passed &&
      payableVoid.passed && payableUpdate.passed && payableDelete.passed
    proof(ctx.caseRecord, assertion, passed, evidence)
    if (!passed) {
      ctx.caseRecord.notes.push(
        `FMS-005 核销保护探针未全部命中：${JSON.stringify({
          void: voidResult,
          update: updateResponse,
          delete: draftDelete
        })}`
      )
    }
    ctx.caseRecord.evidence.push(
      '真实期初应收/应付、收款/付款、自动核销执行与 checkedAmt 回写；已核销批次三类写侧拒绝探针；应付付款作废撤核销回读'
    )
  } finally {
    for (const fixture of fixtures.reverse()) {
      await cleanupWriteOff(ctx.api, fixture)
      await cleanupOpening(ctx.api, fixture)
      ctx.caseRecord.fixtures ||= []
      ctx.caseRecord.fixtures.push({
        kind: 'opening-writeoff', id: fixture.id, role: fixture.role,
        batch: fixture.batch, paymentId: fixture.paymentId, receiptId: fixture.receiptId,
        checkId: fixture.checkId, cleanup: fixture.cleanup,
        checkDeleted: fixture.checkDeleted, paymentDeleted: fixture.paymentDeleted,
        reverseEvidence: fixture.writeoffReverseEvidence
      })
      check(ctx.caseRecord, 'FMS-005 核销与期初专属夹具正式清理',
        fixture.cleanup?.startsWith('CLEANED_API'), `batch=${fixture.batch}; ${fixture.cleanup}`)
    }
  }
}

function conditionPayload (eventType, sourceSystem, direction, overrides = {}) {
  return {
    sourceSystem,
    eventType,
    sourceBillType: 'E2E_FMS_CONDITION_BILL',
    sourceBillId: `${eventType}-BILL`,
    sourceBillNo: `${eventType}-NO`,
    sourceVersion: '1',
    direction,
    sourceEventId: `${eventType}-EVENT`,
    accountSetId: config.fmsAccountSetId,
    bizDate: '2026-10-07T10:00:00',
    summary: `${eventType} all-condition contract probe`,
    businessScene: 'E2E_FMS_SCENE',
    organizationId: 'E2E_ORG_1',
    taxRate: 0.13,
    accountType: 'BANK',
    partnerRole: 'CUSTOMER',
    costComponentItemCode: 'E2E_COST_ITEM',
    lines: [
      { direction: 'DEBIT', amount: 123.45 },
      { direction: 'CREDIT', amount: 123.45 }
    ],
    ...overrides
  }
}

function conditionJson (eventType, sourceSystem, direction) {
  return JSON.stringify({
    sourceSystem,
    eventType,
    sourceBillType: 'E2E_FMS_CONDITION_BILL',
    businessScene: 'E2E_FMS_SCENE',
    organizationId: 'E2E_ORG_1',
    taxRate: 0.13,
    accountType: 'BANK',
    partnerRole: 'CUSTOMER',
    costComponentItemCode: 'E2E_COST_ITEM',
    direction
  })
}

async function createConditionMapping (api, { key, eventType, sourceSystem = 'ERP', direction = 'FORWARD', overrideCondition = null }) {
  const condition = overrideCondition || conditionJson(eventType, sourceSystem, direction)
  const id = dataOf(await api.postBusiness('/fms/config/event-mapping/create', {
    accountSetId: config.fmsAccountSetId,
    sourceSystem,
    eventType,
    direction,
    priority: 1,
    enabled: true,
    effectiveFrom: '2026-10-01',
    effectiveTo: '2026-10-31',
    remark: `${key} full-condition contract probe`,
    entries: [
      {
        lineNo: 1,
        direction: 'DEBIT',
        accountCode: '1122',
        amountExpression: 'line.amount',
        conditionJson: condition,
        sortNo: 1,
        enabled: true
      },
      {
        lineNo: 2,
        direction: 'CREDIT',
        accountCode: '5001',
        amountExpression: 'line.amount',
        conditionJson: condition,
        sortNo: 2,
        enabled: true
      }
    ]
  }))
  return String(id)
}

function balanced (draft, amount = '123.45') {
  if (!draft || !Array.isArray(draft.entries) || draft.entries.length < 2) return false
  const debit = draft.entries
    .filter((entry) => entry.direction === 'DEBIT')
    .reduce((total, entry) => total + money(entry.amount), 0)
  const credit = draft.entries
    .filter((entry) => entry.direction === 'CREDIT')
    .reduce((total, entry) => total + money(entry.amount), 0)
  return debit === credit && debit === money(amount)
}

async function runFms006 (ctx) {
  const key = `E2E-FMS-006-CONDITION-${Date.now().toString(36).toUpperCase()}`
  const eventType = `${key.replace(/[^A-Z0-9_]/g, '_')}_MATCH`
  const mappings = []
  try {
    const mappingId = await createConditionMapping(ctx.api, { key, eventType })
    mappings.push({ id: mappingId, key, eventType })

    const positivePayload = conditionPayload(eventType, 'ERP', 'FORWARD', {
      sourceBillId: `${key}-POSITIVE`,
      sourceEventId: `${key}-POSITIVE-EVENT`
    })
    const positive = dataOf(await ctx.api.postBusiness('/fms/voucher-draft/accept-event', positivePayload))
    const positiveDraft = positive?.draftId
      ? dataOf(await ctx.api.getBusiness(`/fms/voucher-draft/get?id=${encodeURIComponent(positive.draftId)}`))
      : null
    check(ctx.caseRecord, '十字段条件全部匹配时生成命中专属映射的平衡草稿',
      positive?.processStatus !== 'PENDING' &&
      Boolean(positive?.draftId) &&
      positiveDraft?.mappingId === mappingId &&
      balanced(positiveDraft),
    JSON.stringify({
      inboxId: positive?.id,
      draftId: positive?.draftId,
      mappingId: positiveDraft?.mappingId,
      mappingRuleVersion: positiveDraft?.mappingRuleVersion,
      status: positiveDraft?.status
    }))

    const negativeFields = [
      ['sourceSystem', { sourceSystem: 'WMS' }, {
        eventType: `${eventType}_SRC_NEG`,
        sourceSystem: 'WMS',
        direction: 'FORWARD',
        overrideCondition: JSON.stringify({
          ...JSON.parse(conditionJson(`${eventType}_SRC_NEG`, 'WMS', 'FORWARD')),
          sourceSystem: 'ERP'
        })
      }],
      ['sourceBillType', { sourceBillType: 'E2E_FMS_BILL_MISMATCH' }],
      ['businessScene', { businessScene: 'E2E_FMS_SCENE_MISMATCH' }],
      ['organizationId', { organizationId: 'E2E_ORG_MISMATCH' }],
      ['taxRate', { taxRate: 0.14 }],
      ['partnerRole', { partnerRole: 'SUPPLIER' }],
      ['costComponentItemCode', { costComponentItemCode: 'E2E_COST_MISMATCH' }]
    ]
    const probeResults = []
    for (const [field, override, negativeMapping] of negativeFields) {
      const negativeEventType = negativeMapping?.eventType || eventType
      let negativeMappingId = mappingId
      if (negativeMapping) {
        negativeMappingId = await createConditionMapping(ctx.api, {
          key,
          eventType: negativeEventType,
          sourceSystem: negativeMapping.sourceSystem,
          direction: negativeMapping.direction,
          overrideCondition: negativeMapping.overrideCondition
        })
        mappings.push({ id: negativeMappingId, key, eventType: negativeEventType })
      }
      const payload = conditionPayload(negativeEventType, 'ERP', 'FORWARD', {
        ...override,
        sourceBillId: `${key}-NEG-${field}`,
        sourceEventId: `${key}-NEG-${field}-EVENT`
      })
      if (field === 'sourceSystem') payload.sourceSystem = 'WMS'
      const result = dataOf(await ctx.api.postBusiness('/fms/voucher-draft/accept-event', payload))
      const passed = result?.processStatus === 'PENDING' && !result?.draftId &&
        /条件未命中|未配置可用分录规则/.test(String(result?.processMessage || ''))
      probeResults.push({
        field,
        mappingId: negativeMappingId,
        inboxId: result?.id,
        processStatus: result?.processStatus,
        draftId: result?.draftId,
        message: result?.processMessage,
        passed
      })
      check(ctx.caseRecord, `事件映射条件字段 ${field} 单字段不匹配时进入 PENDING 且不生成草稿`,
        passed, JSON.stringify(result))
    }

    const assertion = '条件支持来源系统、单据类型、业务场景、组织、税率、客商角色和成本构成项'
    const allPassed = probeResults.every((item) => item.passed) &&
      positive?.draftId &&
      positiveDraft?.mappingId === mappingId
    proof(ctx.caseRecord, assertion, allPassed, JSON.stringify({
      mappingId,
      positive: {
        inboxId: positive?.id,
        draftId: positive?.draftId,
        mappingId: positiveDraft?.mappingId,
        mappingRuleVersion: positiveDraft?.mappingRuleVersion
      },
      negatives: probeResults
    }))
    if (!allPassed) {
      ctx.caseRecord.notes.push(
        `FMS-006 条件探针未全部通过：${JSON.stringify({ positive, probeResults })}`
      )
    }
    ctx.caseRecord.evidence.push(
      '公开事件受理 API 的十字段条件正向命中与逐字段反向探针；探针事件保留审计，不代表真实 ERP/WMS publisher'
    )
  } finally {
    for (const mapping of mappings.reverse()) {
      try {
        await ctx.api.deleteBusiness(
          `/fms/config/event-mapping/delete?id=${encodeURIComponent(mapping.id)}&accountSetId=${config.fmsAccountSetId}`
        )
        mapping.cleanup = 'CLEANED_API'
      } catch (error) {
        mapping.cleanup = `RETAINED_AUDIT: ${error.message}`
      }
    }
  }
}

const fmsCatalog = JSON.parse(
  readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8')
)
const fmsDefinitions = fmsCatalog.suites.find((suite) => suite.id === 'fms').cases

function statements (caseId) {
  const definition = fmsDefinitions.find((item) => item.id === caseId)
  return { assertions: definition.assertions, reverse: definition.reverse || [] }
}

/** 按 catalog 坐标取出断言文本，保证写侧闭环证据落在真实 catalog 断言上。 */
export function statedAssertion (caseId, index, reverse = false) {
  const list = statements(caseId)[reverse ? 'reverse' : 'assertions']
  if (!list[index]) throw new Error(`FMS catalog 断言不存在：${caseId}#${reverse ? 'R' : 'A'}${index}`)
  return list[index]
}

/** FMS-007 差异调整金额 = 目标金额 - 调整前有效金额。 */
export function adjustmentDelta (targetAmount, baseAmount) {
  const target = money(targetAmount)
  const base = money(baseAmount)
  return target - base
}

function certify (caseRecord, caseId, index, passed, evidence, reverse = false) {
  const text = statedAssertion(caseId, index, reverse)
  proof(caseRecord, text, passed, evidence)
  return text
}

function baseEventPayload (key, overrides = {}) {
  return {
    sourceSystem: 'ERP',
    eventType: 'ERP_RECEIPT_ARRIVED',
    sourceBillType: 'E2E_FMS_CONTRACT_BILL',
    sourceBillId: key,
    sourceBillNo: key,
    sourceVersion: '1',
    direction: 'FORWARD',
    sourceEventId: `${key}-FWD`,
    accountSetId: config.fmsAccountSetId,
    bizDate: '2026-10-07T10:00:00',
    summary: `${key} contract closure`,
    lines: [
      { accountCode: '1001', direction: 'DEBIT', amount: 123.45 },
      { accountCode: '1122', direction: 'CREDIT', amount: 123.45 }
    ],
    ...overrides
  }
}

export async function readOutbox (caseRecord, id, label = '', read = database) {
  const value = numericId(id)
  const rows = await read(caseRecord, `outbox-${value}${label ? `-${label}` : ''}`,
    `SELECT id,status,retry_count,last_error,manual_takeover_by,manual_takeover_time,
            manual_takeover_remark,fms_inbox_id,draft_id
     FROM fms_outbox WHERE tenant_id=1 AND deleted=0 AND id='${value}'`)
  if (!rows[0]) return null
  const columns = ['id', 'status', 'retry_count', 'last_error', 'manual_takeover_by',
    'manual_takeover_time', 'manual_takeover_remark', 'fms_inbox_id', 'draft_id']
  return Object.fromEntries(columns.map((column, index) =>
    [column, rows[0][index] === 'NULL' ? null : rows[0][index]]))
}

export async function expectFmsRejection (api, method, path, body, contract) {
  const response = await api.request(method, path, body, { expectedBusinessRejection: contract })
  if (!matchesExpectedBusinessRejection(response, contract)) {
    throw new Error(`FMS 预期业务拒绝未命中：${method} ${path}；${JSON.stringify(response)}`)
  }
  return response
}

async function runFms001Closure ({ api, caseRecord }) {
  const key = fixtureKey('FMS-001')
  // Enqueue validates source fields; accept rejects a missing business date.
  const event = baseEventPayload(key, { bizDate: null })
  const outboxId = numericId(dataOf(await api.postBusiness('/fms/outbox/enqueue', {
    sourceEventId: `${key}-FWD`, direction: 'FORWARD', occurredAt: '2026-10-07T10:00:00', event
  })))
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({ kind: 'outbox-contract-probe', id: outboxId, cleanup: 'RETAINED_AUDIT: outbox 无删除接口' })
  const enqueued = await readOutbox(caseRecord, outboxId)
  certify(caseRecord, 'FMS-001', 0, enqueued?.status === 'PENDING' && enqueued?.retry_count === '0',
    `受控入箱 outboxId=${outboxId} status=PENDING`)

  let deadLetter = enqueued
  for (let index = 0; index < 14 && deadLetter?.status !== 'DEAD_LETTER'; index++) {
    await api.postBusiness(`/fms/outbox/dispatch?id=${outboxId}`, {})
    deadLetter = await readOutbox(caseRecord, outboxId, `attempt-${index}`)
  }
  const reachedDeadLetter = deadLetter?.status === 'DEAD_LETTER' &&
    Number(deadLetter.retry_count) >= 1 && String(deadLetter.last_error || '').length > 0
  certify(caseRecord, 'FMS-001', 3, reachedDeadLetter,
    `人工受控投递触发重试到死信：status=${deadLetter?.status} retry=${deadLetter?.retry_count} error=${deadLetter?.last_error}`)

  const retried = dataOf(await api.postBusiness(
    `/fms/outbox/retry?id=${outboxId}&remark=${encodeURIComponent('E2E manual retry')}`, {}))
  const retriedRow = await readOutbox(caseRecord, outboxId, 'retried')
  certify(caseRecord, 'FMS-001', 3, retried?.status === 'PENDING' && retriedRow?.status === 'PENDING' &&
    retriedRow?.retry_count === '0' && !retriedRow?.last_error &&
    Boolean(retriedRow?.manual_takeover_by) && Boolean(retriedRow?.manual_takeover_time),
  `死信人工重试 -> PENDING，retry 计数归零并保留接管审计：${JSON.stringify(retriedRow)}`)

  check(caseRecord, '失败投递不产生 inbox 或草稿',
    !deadLetter?.fms_inbox_id && !retriedRow?.draft_id, JSON.stringify(retriedRow))
  caseRecord.evidence.push('真实来源/调度/幂等由 owned 场景取证；本探针仅补 outbox 重试与死信断言。')
}

async function runFms002Closure ({ api, caseRecord }) {
  const key = fixtureKey('FMS-002')
  const snapshotId = `${key}-COST`
  const snapshotVersion = '1'
  const ingestBody = {
    snapshotId,
    accountSetId: config.fmsAccountSetId,
    sourceSystem: 'ERP',
    sourceBillType: 'E2E_FMS_COST_SNAPSHOT',
    sourceBillId: key,
    sourceVersion: '1',
    snapshotVersion,
    currencyCode: 'CNY',
    snapshotTime: '2026-10-07T10:00:00',
    lines: [{
      snapshotLineId: `${key}-LINE-1`,
      materialId: `${key}-MAT`,
      batchNo: `${key}-BATCH`,
      warehouseId: '1',
      quantity: 3,
      unitCost: 41.15,
      authoritativeAmount: 123.45
    }]
  }
  const first = dataOf(await api.postBusiness('/fms/cost-snapshot/ingest', ingestBody))
  const duplicated = dataOf(await api.postBusiness('/fms/cost-snapshot/ingest', ingestBody))
  const snapshotRead = dataOf(await api.getBusiness(
    `/fms/cost-snapshot/get?accountSetId=${config.fmsAccountSetId}&snapshotId=${encodeURIComponent(snapshotId)}&snapshotVersion=${snapshotVersion}`))
  certify(caseRecord, 'FMS-002', 0,
    duplicated?.duplicated === true && snapshotRead?.status === 'READY' &&
    money(snapshotRead?.lines?.[0]?.authoritativeAmount) === 12345,
  `ERP 成本快照持久化并幂等回读：${snapshotId}，重复=${duplicated?.duplicated}`)

  const mismatch = await expectFmsRejection(api, 'POST', '/fms/cost-snapshot/ingest', {
    ...ingestBody,
    lines: [{ ...ingestBody.lines[0], authoritativeAmount: 150.00, unitCost: 50.00 }]
  }, { code: 500, message: /^同一成本快照 ID\+版本携带了不同载荷，受控拒绝：/,
    allowServiceCode: true })
  check(caseRecord, '同一成本快照 ID+版本不同载荷被受控拒绝',
    true, JSON.stringify(mismatch))
  const nextVersion = dataOf(await api.postBusiness('/fms/cost-snapshot/ingest', {
    ...ingestBody, snapshotVersion: '2',
    lines: [{ ...ingestBody.lines[0], authoritativeAmount: 150.00, unitCost: 50.00 }]
  }))
  check(caseRecord, '同一快照 ID 的不同版本使用独立内部主键',
    Boolean(first?.id && nextVersion?.id) && first.id !== nextVersion.id &&
    nextVersion.snapshotId === snapshotId && nextVersion.snapshotVersion === '2')

  const wmsEvent = {
    sourceSystem: 'WMS',
    eventType: 'WMS_INVENTORY_MOVED',
    sourceBillType: 'E2E_FMS_WMS_MOVE',
    sourceBillId: `${key}-WMS`,
    sourceBillNo: `${key}-WMS`,
    sourceVersion: '1',
    direction: 'FORWARD',
    sourceEventId: `${key}-WMS-FWD`,
    accountSetId: config.fmsAccountSetId,
    bizDate: '2026-10-07T10:00:00',
    costSnapshotId: snapshotId,
    costSnapshotVersion: snapshotVersion,
    summary: `${key} WMS physical fact`,
    lines: [
      { direction: 'DEBIT', quantity: 3, amount: 1, accountCode: '1001',
        costSnapshotLineId: `${key}-LINE-1`, authoritativeAmount: 123.45 },
      { direction: 'CREDIT', quantity: 3, amount: 1, accountCode: '1122',
        costSnapshotLineId: `${key}-LINE-1`, authoritativeAmount: 123.45 }
    ]
  }
  const wmsAccepted = dataOf(await api.postBusiness('/fms/voucher-draft/accept-event', wmsEvent))
  const wmsDraft = wmsAccepted?.draftId
    ? dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${wmsAccepted.draftId}`)) : null
  certify(caseRecord, 'FMS-002', 2,
    Boolean(wmsDraft) && balancedDraft(wmsDraft, 123.45),
  `WMS 草稿借方=${wmsDraft?.debitTotal} 贷方=${wmsDraft?.creditTotal}，金额来自 ERP 快照`)
  certify(caseRecord, 'FMS-002', 3,
    wmsDraft?.status === 'DRAFT',
    `WMS 事件只生成 DRAFT 草稿，状态=${wmsDraft?.status}`)
  certify(caseRecord, 'FMS-002', 4,
    Boolean(wmsDraft?.sourceSystem === 'WMS' && wmsDraft?.eventType === 'WMS_INVENTORY_MOVED' &&
      wmsDraft?.sourceBillId === `${key}-WMS` && wmsDraft?.entries?.length === 2),
  `来源字段完整：sourceSystem=${wmsDraft?.sourceSystem} eventType=${wmsDraft?.eventType} entries=${wmsDraft?.entries?.length}`)

  const missing = dataOf(await api.postBusiness('/fms/voucher-draft/accept-event', {
    ...wmsEvent,
    sourceBillId: `${key}-MISSING`,
    sourceEventId: `${key}-MISSING-FWD`,
    costSnapshotId: `${key}-NO-SNAPSHOT`,
    costSnapshotVersion: '1'
  }))
  certify(caseRecord, 'FMS-002', 1,
    missing?.processStatus === 'PENDING' && !missing?.draftId && /成本快照/.test(missing?.processMessage || ''),
  `缺成本快照事件保持 PENDING 且不生成零金额草稿：${missing?.processMessage}`)

  const reverseWms = dataOf(await api.postBusiness('/fms/voucher-draft/accept-event', {
    ...wmsEvent,
    sourceBillId: `${key}-WMS-REV`,
    sourceEventId: `${key}-WMS-REV`,
    direction: 'REVERSE',
    reversalOfEventId: wmsAccepted?.id,
    lines: wmsEvent.lines.map((line) => ({
      ...line, direction: line.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT'
    }))
  }))
  const reverseDraft = reverseWms?.draftId
    ? dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${reverseWms.draftId}`)) : null
  const originalDraft = wmsAccepted?.draftId
    ? dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${wmsAccepted.draftId}`)) : null
  certify(caseRecord, 'FMS-002', 0,
    Boolean(reverseWms?.id) && reverseWms.id !== wmsAccepted?.id &&
    ((reverseWms.processStatus === 'PENDING' && !reverseWms.draftId) ||
      (balancedDraft(reverseDraft, 123.45) && reverseDraft.id !== wmsDraft.id)) &&
    originalDraft?.status === wmsDraft?.status,
  `WMS 反向事件生成独立草稿/待处理且不改原草稿：reverseInbox=${reverseWms?.id}`, true)
}

export function flattenFmsBalances (rows) {
  if (!Array.isArray(rows)) throw new Error('科目余额响应不是数组')
  return rows.flatMap((row) => [row, ...flattenFmsBalances(row.children || [])])
}

export function voucherBalanceDelta (before, after, entries, reversed = false) {
  const totals = new Map()
  for (const entry of entries) {
    const id = numericId(entry.subjectId)
    const total = totals.get(id) || { debit: 0, credit: 0 }
    total.debit += money(entry.debitAmount)
    total.credit += money(entry.creditAmount)
    totals.set(id, total)
  }
  const find = (rows, id) => rows.find((row) =>
    String(row.subjectId) === id && row.nodeType === 1)
  return totals.size > 0 && [...totals].every(([id, total]) => {
    // The balance API omits all-zero subjects; a missing baseline is zero,
    // but the posted/reversed subject must be present in the actual readback.
    const a = find(before, id) || { periodDebitAmount: 0, periodCreditAmount: 0,
      endingDebitAmount: 0, endingCreditAmount: 0 }
    const b = find(after, id)
    if (!a || !b) return false
    const debit = reversed ? total.debit + total.credit : total.debit
    const credit = reversed ? total.debit + total.credit : total.credit
    return money(b.periodDebitAmount) - money(a.periodDebitAmount) === debit &&
      money(b.periodCreditAmount) - money(a.periodCreditAmount) === credit &&
      (money(b.endingDebitAmount) - money(b.endingCreditAmount)) -
      (money(a.endingDebitAmount) - money(a.endingCreditAmount)) ===
        (reversed ? 0 : total.debit - total.credit)
  })
}

async function accountingSnapshot (api, accountSetId) {
  const query = new URLSearchParams({ accountSetId, startMonth: '2026-10', endMonth: '2026-10' })
  const balances = flattenFmsBalances(dataOf(await api.getBusiness(
    `/fms/ledger/subject-balance/list?${query}`)))
  const report = dataOf(await api.getBusiness(`/fms/report/balance-sheet/get?${query}`))
  if (!Array.isArray(report) || report.length === 0) throw new Error('资产负债表没有可验证的报表行')
  return { balances, report }
}

async function verifyConfirmPermission (api, record, caseRecord, draftId) {
  const reader = await createProcurementPermissionReader(api, caseRecord, {
    permission: 'fms:voucher-draft:query', label: 'FMS003'
  })
  try {
    const anonymous = createApiClient({ record })
    const credentials = { ...reader.credentials, captchaVerification: '', rememberMe: false }
    const login = await anonymous.request('POST', '/system/auth/login-encrypted',
      credentials, { encrypted: true })
    let token = login?.data?.accessToken || login?.data?.token
    if (!token) {
      const options = assertBusinessSuccess(await anonymous.request(
        'POST', '/system/auth/tenant-options-encrypted', credentials, { encrypted: true }))
      const selected = assertBusinessSuccess(await anonymous.post(
        '/system/auth/login-tenant-selection',
        { selectionTicket: options.data?.selectionTicket, tenantId: config.tenantId }))
      token = selected.data?.accessToken || selected.data?.token
    }
    if (!token) throw new Error('只读账号登录没有取得 token')
    const readerApi = createApiClient({ token, record })
    const info = dataOf(assertBusinessSuccess(await readerApi.getPermissionInfo()))
    if (info.user?.username !== reader.username ||
        !Array.isArray(info.permissions) || !info.permissions.includes('fms:voucher-draft:query') ||
        info.permissions.some((item) => item.includes('*') || item === 'fms:voucher-draft:confirm')) {
      throw new Error('只读账号身份或权限矩阵不符合确认拒绝探针要求')
    }
    await readerApi.getBusiness(`/fms/voucher-draft/get?id=${draftId}`)
    await expectFmsRejection(readerApi, 'POST', `/fms/voucher-draft/confirm?id=${draftId}`, {},
      { code: 403, message: '没有该操作权限', allowServiceCode: true })
    const untouched = dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${draftId}`))
    check(caseRecord, '无确认权限账号被精确拒绝且不改变草稿',
      untouched?.status === 'DRAFT' && !untouched.confirmedTime && !untouched.confirmedBy)
    return untouched?.status === 'DRAFT' && !untouched.confirmedTime && !untouched.confirmedBy
  } finally {
    await reader.deactivate()
    const user = dataOf(await api.getBusiness(`/system/user/get?id=${reader.userId}`))
    check(caseRecord, 'FMS 确认拒绝探针账号已停用', Number(user?.status) === 1)
  }
}

export async function verifyIsolatedClosedPeriod ({ api, page, record, caseRecord },
  { withTenant = withDedicatedTenant } = {}) {
  const key = fixtureKey('FMS-003')
  const tenant = {
    name: isolatedPeriodTenantName(key), username: `fmsperiod${randomBytes(5).toString('hex')}`,
    password: isolatedPeriodPassword()
  }
  try {
    tenant.id = numericId(dataOf(await api.postBusiness('/system/tenant/create', {
      ...tenant, contactName: 'FMS E2E period', contactMobile: '19900000000',
      packageId: '111', status: 0, expireTime: '2099-12-31T23:59:59', accountCount: 10
    })))
  } catch (error) {
    if (!isolatedPeriodTenantCreationGap(error)) throw error
    const reason = '通用租户初始化拒绝已停用菜单资源 1261；未关闭共享期间，期间关闭阻断过账暂无法取证'
    missing(caseRecord, statedAssertion('FMS-003', 4), reason)
    caseRecord.notes.push(`FMS-003 隔离期间夹具未启动：${reason}`)
    return
  }
  if (tenant.id === String(config.tenantId)) throw new Error('隔离期间探针不得使用共享验收租户')
  const fixture = { kind: 'isolated-fms-closed-period', tenantId: tenant.id, tenantName: tenant.name,
    cleanup: 'RETAINED_AUDIT: 独立租户/账套/结账记录保留，未关闭共享期间' }
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push(fixture)
  return withTenant({ page, record }, tenant, async ({ api: isolated }) => {
    const accountSetId = numericId(dataOf(await isolated.postBusiness('/fms/config/account-set/create', {
      companyCode: key, companyName: `${key} period`, remark: 'E2E closed-period isolation'
    })))
    fixture.accountSetId = accountSetId
    if (accountSetId === String(config.fmsAccountSetId)) throw new Error('隔离账套不得为共享验收账套')
    await isolated.putBusiness('/fms/config/account-set/initialize', {
      accountSetId, currencyCode: 'RMB', startTime: '2026-10-01T00:00:00',
      standard: 1, level: 4, subjectCodeRule: '4-2-2-2', ledgerBalanceMode: 1
    })
    // Report configurations are lazily initialized by the formal report read APIs.
    // Warm them before closing so a failed close does not roll back their first-use setup.
    const reportQuery = new URLSearchParams({
      accountSetId, startMonth: '2026-10', endMonth: '2026-10'
    })
    const balanceReport = dataOf(await isolated.getBusiness(
      `/fms/report/balance-sheet/get?${reportQuery}`))
    const incomeReport = dataOf(await isolated.getBusiness(
      `/fms/report/income-statement/get?${reportQuery}`))
    if (!Array.isArray(balanceReport) || balanceReport.length === 0
      || !Array.isArray(incomeReport) || incomeReport.length === 0) {
      throw new Error('隔离账套报表配置初始化失败，结账前没有可验证的资产负债表/利润表')
    }
    const accepted = dataOf(await isolated.postBusiness('/fms/voucher-draft/accept-event',
      baseEventPayload(`${key}-PERIOD`, { accountSetId, lines: [
        { accountCode: '1001', direction: 'DEBIT', amount: 123.45, summary: key },
        { accountCode: '3001', direction: 'CREDIT', amount: 123.45, summary: key }
      ] })))
    if (!accepted?.draftId) throw new Error('隔离期间探针未生成草稿')
    fixture.draftId = accepted.draftId
    await isolated.postBusiness(`/fms/voucher-draft/confirm?id=${accepted.draftId}`, {})
    await isolated.putBusiness('/fms/closing/period/close', { accountSetId, month: '2026-10' })
    const overview = dataOf(await isolated.getBusiness(
      `/fms/closing/period/overview?accountSetId=${accountSetId}&month=2026-10`))
    await expectFmsRejection(isolated, 'POST', `/fms/voucher/post-draft?id=${accepted.draftId}`, {},
      { code: 1052105000, message: '该会计期间已结账' })
    const draft = dataOf(await isolated.getBusiness(`/fms/voucher-draft/get?id=${accepted.draftId}`))
    const vouchers = dataOf(await isolated.getBusiness(
      `/fms/voucher/page?accountSetId=${accountSetId}&pageNo=1&pageSize=100`))
    certify(caseRecord, 'FMS-003', 4, overview?.closed === true &&
      draft?.status === 'CONFIRMED' && !draft.voucherId &&
      Number(vouchers?.total) === 0 && Array.isArray(vouchers.list) && vouchers.list.length === 0,
    `隔离 tenant=${tenant.id} accountSet=${accountSetId} 真实结账后过账被拒绝，草稿与正式凭证无写入`)
  })
}

async function runFms003Closure (ctx) {
  const { api, caseRecord, record } = ctx
  const key = fixtureKey('FMS-003')
  const accepted = dataOf(await api.postBusiness('/fms/voucher-draft/accept-event',
    baseEventPayload(key, { sourceEventId: `${key}-FWD`, lines: [
      { accountCode: '1001', direction: 'DEBIT', amount: 123.45, summary: key },
      { accountCode: '3001', direction: 'CREDIT', amount: 123.45, summary: key }
    ] })))
  if (!accepted?.draftId) throw new Error(`FMS-003 未生成草稿：${JSON.stringify(accepted)}`)
  const draftId = accepted.draftId
  const before = dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${draftId}`))
  check(caseRecord, 'FMS-003 有权限用户创建草稿', before?.status === 'DRAFT', draftId)
  const permissionDenied = await verifyConfirmPermission(api, record, caseRecord, draftId)
  const baseline = await accountingSnapshot(api, config.fmsAccountSetId)
  const confirmed = dataOf(await api.postBusiness(
    `/fms/voucher-draft/confirm?id=${draftId}&remark=${encodeURIComponent('E2E confirm')}`, {}))
  const afterConfirm = dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${draftId}`))
  certify(caseRecord, 'FMS-003', 1,
    confirmed === true && afterConfirm?.status === 'CONFIRMED' && !afterConfirm?.voucherId,
  `确认只改草稿状态：status=${afterConfirm?.status} voucherId=${afterConfirm?.voucherId}`)
  certify(caseRecord, 'FMS-003', 0, permissionDenied && afterConfirm?.status === 'CONFIRMED' &&
    Boolean(afterConfirm.confirmedBy) && Boolean(afterConfirm.confirmedTime),
  '只读账号确认被精确拒绝且草稿未变；管理员确认并回读审计')
  const confirmedSnapshot = await accountingSnapshot(api, config.fmsAccountSetId)
  certify(caseRecord, 'FMS-003', 2, !afterConfirm?.voucherId &&
    JSON.stringify(baseline) === JSON.stringify(confirmedSnapshot),
  '确认前后科目余额、资产负债表无变化；尚未生成正式凭证')
  const voucherId = numericId(dataOf(await api.postBusiness(
    `/fms/voucher/post-draft?id=${draftId}&remark=${encodeURIComponent('E2E post')}`, {})))
  const repeatedVoucherId = numericId(dataOf(await api.postBusiness(
    `/fms/voucher/post-draft?id=${draftId}&remark=${encodeURIComponent('E2E post repeat')}`, {})))
  const voucher = dataOf(await api.getBusiness(
    `/fms/voucher/get?accountSetId=${config.fmsAccountSetId}&id=${voucherId}`))
  const postedDraft = dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${draftId}`))
  const postedSnapshot = await accountingSnapshot(api, config.fmsAccountSetId)
  check(caseRecord, 'POSTED 分录进入科目余额且报表发生变化',
    voucherBalanceDelta(baseline.balances, postedSnapshot.balances, voucher.entries) &&
    JSON.stringify(baseline.report) !== JSON.stringify(postedSnapshot.report))
  const immutable = await expectFmsRejection(api, 'PUT', '/fms/voucher/update', {
    id: voucherId,
    accountSetId: config.fmsAccountSetId,
    voucherWordId: voucher?.voucherWordId,
    voucherNumber: voucher?.voucherNumber,
    voucherTime: voucher?.voucherTime,
    attachmentCount: voucher?.attachmentCount,
    entries: voucher?.entries
  }, { code: 1052103006, message: '已审核凭证不能编辑或删除' })
  check(caseRecord, '已过账凭证拒绝改写分录', immutable.code === 1052103006)
  const reversalBody = {
    accountSetId: config.fmsAccountSetId,
    voucherId,
    reversalTime: '2026-10-07T00:00:00',
    reason: `${key} reversal`
  }
  const reversalId = numericId(dataOf(await api.postBusiness('/fms/voucher/reverse', reversalBody)))
  const repeatedReversalId = numericId(dataOf(await api.postBusiness('/fms/voucher/reverse', reversalBody)))
  const reversed = dataOf(await api.getBusiness(
    `/fms/voucher/get?accountSetId=${config.fmsAccountSetId}&id=${voucherId}`))
  const reversal = dataOf(await api.getBusiness(
    `/fms/voucher/get?accountSetId=${config.fmsAccountSetId}&id=${reversalId}`))
  const reversedSnapshot = await accountingSnapshot(api, config.fmsAccountSetId)
  check(caseRecord, '冲销仅增加一次反向发生额，余额及资产负债表回到基线',
    repeatedReversalId === reversalId &&
    voucherBalanceDelta(baseline.balances, reversedSnapshot.balances, voucher.entries, true) &&
    JSON.stringify(baseline.report) === JSON.stringify(reversedSnapshot.report))
  const subjects = dataOf(await api.getBusiness(
    `/fms/config/subject/list?accountSetId=${config.fmsAccountSetId}`))
  for (const path of draftLedgerPaths(before, subjects, '2026-10')) {
    const rows = dataOf(await api.getBusiness(path))
    check(caseRecord, '明细账保留原凭证和独立反向凭证', Array.isArray(rows) &&
      rows.some((row) => row.rowType === 2 && String(row.voucherId) === voucherId) &&
      rows.some((row) => row.rowType === 2 && String(row.voucherId) === reversalId), path)
  }
  const reversedDraft = dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${draftId}`))
  const cancelAccepted = dataOf(await api.postBusiness('/fms/voucher-draft/accept-event',
    baseEventPayload(`${key}-CANCEL`, { sourceEventId: `${key}-CANCEL-FWD` })))
  const cancelDraftId = cancelAccepted?.draftId
  const cancelled = cancelDraftId
    ? dataOf(await api.postBusiness(
        `/fms/voucher-draft/cancel?id=${cancelDraftId}&remark=${encodeURIComponent('E2E cancel')}`, {}))
    : false
  const cancelledDraft = cancelDraftId
    ? dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${cancelDraftId}`)) : null
  certify(caseRecord, 'FMS-003', 3,
    voucher?.status === 9 && String(voucher?.sourceDraftId) === String(draftId) &&
    repeatedVoucherId === voucherId && postedDraft?.status === 'POSTED' &&
    immutable.code === 1052103006,
  `正式过账后凭证 status=${voucher?.status}，重复过账复用 voucherId=${voucherId}，已过账拒绝改写`)
  certify(caseRecord, 'FMS-003', 0,
    cancelled === true && cancelledDraft?.status === 'CANCELLED' &&
    reversed?.status === 10 && String(reversed?.reversalVoucherId) === String(reversalId) &&
    reversal?.status === 9 && String(reversal?.reversalOfVoucherId) === String(voucherId) &&
    JSON.stringify(reversed.entries) === JSON.stringify(voucher.entries) &&
    reversedDraft?.status === 'REVERSED' && String(reversedDraft.reversalVoucherId) === reversalId,
  `未过账草稿可取消（${cancelledDraft?.status}）；已过账冲销生成独立反向凭证 reversal=${reversalId}`, true)
  await verifyIsolatedClosedPeriod(ctx)
}

export async function readPublishedDelivery (api, caseRecord, sourceBillId, eventType,
  direction = 'FORWARD', { read = database, wait = poll } = {}) {
  const id = numericId(sourceBillId)
  if (!/^ERP_[A-Z_]+$/.test(eventType) || !['FORWARD', 'REVERSE'].includes(direction)) {
    throw new Error('无效 ERP 发布查询契约')
  }
  const rows = await wait(() => read(caseRecord, `erp-published-${eventType}-${direction}`,
    `SELECT id,status,source_event_id,reversal_of_event_id,fms_inbox_id,draft_id,payload
     FROM fms_outbox WHERE tenant_id=1 AND deleted=0 AND source_system='ERP'
       AND source_bill_id='${id}' AND event_type='${eventType}' AND direction='${direction}'`),
  (values) => values.length === 1 && values[0][1] === 'SENT')
  if (rows.length !== 1 || rows[0][1] !== 'SENT') {
    const status = rows.length === 1 ? rows[0][1] : 'MISSING_OR_DUPLICATED'
    throw new Error(`ERP ${eventType}/${direction} 未产生唯一已投递 outbox：${id}，当前状态=${status}`)
  }
  const [outboxId, , sourceEventId, reversalOfEventId, inboxId, draftId, raw] = rows[0]
  const payload = JSON.parse(raw)
  if (payload.sourceSystem !== 'ERP' || String(payload.sourceBillId) !== id ||
      payload.eventType !== eventType || payload.direction !== direction ||
      payload.sourceEventId !== sourceEventId ||
      (direction === 'REVERSE' && (!reversalOfEventId || reversalOfEventId === 'NULL' ||
        payload.reversalOfEventId !== reversalOfEventId))) {
    throw new Error('ERP outbox 与原始载荷来源或反向关联不一致')
  }
  const query = new URLSearchParams({ sourceSystem: 'ERP', sourceBillId: id,
    eventType, pageNo: '1', pageSize: '100' })
  const page = dataOf(await api.getBusiness(`/fms/event-inbox/page?${query}`))
  if (!Array.isArray(page?.list)) throw new Error('ERP 事件 inbox 分页契约缺失')
  const events = page.list.filter((row) => row.direction === direction &&
    row.sourceSystem === 'ERP' && row.eventType === eventType &&
    String(row.sourceBillId) === id && row.sourceEventId === sourceEventId)
  if (events.length !== 1 || String(events[0].id) !== String(inboxId) ||
      (draftId !== 'NULL' && draftId != null && String(events[0].draftId) !== String(draftId))) {
    throw new Error('ERP 真实 outbox 未关联唯一对应 inbox/草稿')
  }
  const event = events[0]
  const inboxRows = await read(caseRecord, `erp-inbox-account-${event.id}`,
    `SELECT payload FROM fms_event_inbox WHERE tenant_id=1 AND deleted=0 AND id='${numericId(event.id)}'`)
  const inboxPayload = inboxRows.length === 1 ? JSON.parse(inboxRows[0][0]) : null
  if (String(inboxPayload?.accountSetId) !== String(config.fmsAccountSetId) ||
      (payload.accountSetId && String(payload.accountSetId) !== String(config.fmsAccountSetId))) {
    throw new Error('ERP 发布事件不属于专属验收账套')
  }
  payload.accountSetId = config.fmsAccountSetId
  const duplicate = dataOf(await api.postBusiness('/fms/voucher-draft/accept-event', payload))
  if (duplicate?.duplicated !== true || duplicate.id !== event.id ||
      duplicate.draftId !== event.draftId) throw new Error('ERP 原载荷重放未复用 inbox/草稿')
  const draft = event.draftId
    ? dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${event.draftId}`)) : null
  if (draft && String(draft.accountSetId) !== config.fmsAccountSetId) {
    throw new Error('ERP 来源草稿不属于专属验收账套')
  }
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({ kind: 'erp-published-event', sourceBillId: id, eventType, direction,
    outboxId, inboxId, draftId: draft?.id,
    cleanup: 'RETAINED_AUDIT: 真实发布的 outbox/inbox/草稿保留审计' })
  return { event, draft, payload, duplicate, outboxId }
}

export async function runFmsCashReversalClosure (context, sources, {
  readDelivery = readPublishedDelivery, readEvidence = readFms004CashReversalEvidence
} = {}) {
  const { api, caseRecord } = context
  await waitForFmsTasks(sources.map((source) => async () => {
    const { fixture, role } = source
    if (fixture.writeoffCleanupError || !fixture.writeoffCleaned) {
      throw new Error(`ERP ${role} 核销反向未完成：${fixture.writeoffCleanupError || fixture.cleanup}`)
    }
    if (role === 'receivable') {
      const receipt = dataOf(await api.getBusiness(
        `/finance/finReceipt/queryById?id=${encodeURIComponent(fixture.receiptId)}`
      ))
      if (String(receipt?.isEffective) === '1') {
        await api.putBusiness('/finance/finReceipt/void', { id: fixture.receiptId })
      }
      const voidedReceipt = dataOf(await api.getBusiness(
        `/finance/finReceipt/queryById?id=${encodeURIComponent(fixture.receiptId)}`
      ))
      if (String(voidedReceipt?.isEffective) !== '0') {
        throw new Error(`ERP 收款原单作废后仍为生效：${JSON.stringify(voidedReceipt)}`)
      }
      fixture.cashVoided = true
    } else {
      // The existing write-off cleanup already voided and deleted the payment.
      fixture.cashVoided = fixture.paymentDeleted === true
    }
    if (!fixture.cashVoided) throw new Error(`ERP ${role} 现金原单未完成正式作废`)
    source.cashReverse = await readDelivery(api, caseRecord,
      fixture.receiptId || fixture.paymentId,
      role === 'receivable' ? 'ERP_RECEIPT_ARRIVED' : 'ERP_PAYMENT_DISBURSED', 'REVERSE')
    const evidence = await readEvidence(api, caseRecord, source)
    source.cashReverseEvidence = evidence
    // This flag certifies delivery only. Accounting completion is finalized
    // separately from the strict reader's API/SQL cancellation/draft evidence.
    source.cashReverseVerified = evidence.eventRegistered === true
    check(caseRecord, `${role} 现金原单作废发布独立反向事件`,
      source.cashReverseVerified, JSON.stringify(evidence))
    if (evidence.status === 'FAIL') {
      check(caseRecord, `${role} 现金取消/反向严格证据门禁`, false, JSON.stringify(evidence))
    } else if (evidence.status === 'PARTIAL') {
      caseRecord.notes.push(`GAP: ${role} 现金反向仅登记或证据未闭环：${evidence.gaps.join('；')}`)
    }
    if (evidence.sourceRevisionVerified !== true) {
      caseRecord.notes.push(`GAP: ${role} 本轮未验证作废后重执行 sourceVersion，原载荷重放不证明跨版本幂等`)
    }
  }))
  certify(caseRecord, 'FMS-004', 0,
    sources.length === 2 && sources.every((source) => source.cashReverseVerified),
    sources.map((source) =>
      `${source.role} source=${source.fixture.receiptId || source.fixture.paymentId} ` +
      `reverse=${source.cashReverse?.event?.sourceEventId || 'missing'}；仅认证事件登记`
    ).join('; '), true)
  if (context.page) {
    for (const source of sources) {
      if (source.cashReverseEvidence?.originalDraftCancelled) {
        await showFms004CashDraft(context, source, { status: 'CANCELLED' })
      }
    }
  }
  return sources.map((source) => source.cashReverseEvidence)
}

export function assessFms004WriteOffReversal (writeOff, reverse, original, checkedAmt) {
  const empty = (value) => value == null || value === '' || value === 'NULL'
  const unposted = (draft) => draft && ['confirmedBy', 'confirmedTime', 'postedBy',
    'postedTime', 'voucherId', 'reversalVoucherId', 'reversedBy', 'reversedTime']
    .every((field) => empty(draft[field]))
  const cancellationFields = ['status', 'cancelledBy', 'cancelledTime', 'cancelRemark']
  const content = (draft) => Object.fromEntries(Object.entries(draft)
    .filter(([field]) => !cancellationFields.includes(field)))
  const before = writeOff.draft
  const independent = reverse.event.id !== writeOff.event.id &&
    reverse.payload.reversalOfEventId === writeOff.payload.sourceEventId &&
    reverse.payload.sourceVersion === writeOff.payload.sourceVersion
  const balanceZero = money(checkedAmt) === 0
  // ADR 3.5 changes only status and cancellation audit, never source content.
  const originalPreserved = Boolean(before && original && before.status === 'DRAFT' &&
    original.status === 'CANCELLED' && unposted(before) && unposted(original) &&
    ['cancelledBy', 'cancelledTime', 'cancelRemark'].every((field) => empty(before[field])) &&
    !empty(original.cancelledBy) && !empty(original.cancelledTime) &&
    Number.isFinite(Date.parse(original.cancelledTime)) &&
    !empty(writeOff.payload.sourceEventId) && !empty(reverse.payload.sourceEventId) &&
    !empty(writeOff.payload.sourceVersion) &&
    typeof original.cancelRemark === 'string' &&
    original.cancelRemark.endsWith(`forward=${writeOff.payload.sourceEventId}; ` +
      `reverse=${reverse.payload.sourceEventId}; sourceVersion=${writeOff.payload.sourceVersion}`) &&
    isDeepStrictEqual(content(before), content(original)))
  const effects = (entries, flip = false) => entries.map((entry) => JSON.stringify([
    entry.accountCode, flip ? (entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT') : entry.direction,
    money(entry.amount), entry.auxiliaryType ?? null, entry.auxiliaryCode ?? null
  ])).sort()
  const reverseDraftVerified = Boolean(before?.status === 'DRAFT' && unposted(before) &&
    reverse.event.processStatus === 'DRAFTED' && reverse.draft?.status === 'DRAFT' &&
    !empty(reverse.draft.id) && reverse.event.draftId === reverse.draft.id &&
    reverse.draft.id !== before.id && unposted(reverse.draft) &&
    ['cancelledBy', 'cancelledTime', 'cancelRemark'].every((field) => empty(reverse.draft[field])) &&
    balancedDraft(before, '123.45') && balancedDraft(reverse.draft, '123.45') &&
    isDeepStrictEqual(effects(before.entries, true), effects(reverse.draft.entries)))
  return { independent, balanceZero, originalPreserved, reverseDraftVerified,
    passed: independent && balanceZero && originalPreserved && reverseDraftVerified }
}

export async function runFms004Closure (ctx) {
  const { api, caseRecord } = ctx
  assertFms004WriteScope()
  const context = await readFms004Context(api, caseRecord, 'before')
  const beforeVouchers = await readFms004FormalVouchers(api, caseRecord, 'before')
  await ensureAcceptanceNumbering(api, caseRecord, ['fin_yshx_bill_no', 'fin_yfhx_bill_no'])
  const key = fixtureKey('FMS-004')
  const partner = await createPartner(api, key)
  const accountId = await createAccount(api, `${key}-BANK`)
  const fixtures = []
  let sources = []
  try {
    // Both sides use the same scheduler and do not share mutable bill state.
    // Build them together so one scheduler tick can deliver both cash events.
    const builtFixtures = await waitForFmsTasks(
      ['receivable', 'payable'].map((role) =>
        () => (role === 'receivable' ? buildWrittenOffOpening : buildWrittenOffPayable)(
          api, { partner, accountId }, `${key}-${role.toUpperCase()}`, true,
          (fixture) => fixtures.push(fixture)
        ))
    )
    for (const fixture of builtFixtures) {
      const { role } = fixture
      if (fixture.error) throw new Error(`ERP ${role} 核销夹具未完成：${fixture.error}`)
    }
    // Once both fixtures exist, cash and write-off outboxes are independent.
    // Waiting for them together avoids six serialized 60-second scheduler waits.
    sources = await waitForFmsTasks(builtFixtures.map((fixture) => async () => {
      const role = fixture.role
      const [cash, writeOff] = await waitForFmsTasks([
        () => readPublishedDelivery(api, caseRecord,
          role === 'receivable' ? fixture.receiptId : fixture.paymentId,
          role === 'receivable' ? 'ERP_RECEIPT_ARRIVED' : 'ERP_PAYMENT_DISBURSED'),
        () => readPublishedDelivery(api, caseRecord, fixture.checkId,
          role === 'receivable' ? 'ERP_RECEIVABLE_WRITE_OFF' : 'ERP_PAYABLE_WRITE_OFF')
      ])
      return { role, fixture, cash, writeOff }
    }))
    certify(caseRecord, 'FMS-004', 0, sources.length === 2 && sources.every((s) =>
      s.cash.event?.direction === 'FORWARD' && Boolean(s.cash.outboxId)),
    sources.map((s) => `${s.role} source=${s.cash.event.sourceBillId} outbox=${s.cash.outboxId}`).join('; '))
    certify(caseRecord, 'FMS-004', 1, sources.length === 2 && sources.every((s) =>
      money((s.role === 'receivable' ? s.fixture.persistedReceivable : s.fixture.payable)?.checkedAmt) === 12345 &&
      String(s.fixture.check?.isEffective) === '1' && s.fixture.checkEntries?.length === 2) &&
      String(sources[1].fixture.check.srcBillId) === String(sources[1].fixture.paymentId),
    'ERP 应付付款自动核销及应收正式核销，回读核销主子单与来源 checkedAmt；FMS 未修改 ERP 原单')
    certify(caseRecord, 'FMS-004', 2, sources.length === 2 && sources.every((s) =>
      s.cash.draft?.status === 'DRAFT' && !s.cash.draft.voucherId &&
      balancedDraft(s.cash.draft, '123.45')),
    '真实到账/出账经后台 outbox 投递仅产生金额一致 DRAFT 草稿')
    certify(caseRecord, 'FMS-004', 3, sources.length === 2 && sources.every((s) =>
      s.cash.duplicate?.duplicated && s.writeOff.duplicate?.duplicated),
    '分别重放到账、出账、应收核销、应付核销真实 outbox 原载荷，精确复用 inbox/草稿')
    for (const source of sources) {
      source.cash.draft = await readFms004CashDraft(api, caseRecord, source)
      await showFms004CashDraft(ctx, source)
    }
    const afterVouchers = await readFms004FormalVouchers(api, caseRecord, 'cash-drafted')
    certify(caseRecord, 'FMS-004', 2,
      JSON.stringify(beforeVouchers) === JSON.stringify(afterVouchers),
      '到账/出账现金草稿经精确 API、SQL 主子表、Chrome 只读详情核对；正式凭证前后不变，未调用人工确认或过账')
    await waitForFmsTasks(sources.map((source) => async () => {
      const { fixture } = source
      await cleanupWriteOff(api, fixture)
    }))
    // Cash reversals are published only when the original cash bill is voided.
    // Receipts are independent of the write-off cleanup; payments are voided by
    // cleanupWriteOff after their downstream payable check is removed.
    await runFmsCashReversalClosure(ctx, sources)
    // Both write-off reversals were published by cleanupWriteOff. Verify their
    // delivery and current source balances independently of cash cancellation.
    const writeOffReverseResults = []
    await waitForFmsTasks(sources.map((source) => async () => {
      const { fixture, role, writeOff } = source
      const sourceBillId = numericId(role === 'receivable' ? fixture.receivable.id : fixture.payableId)
      const bill = dataOf(assertBusinessSuccess(await api.getBusiness(
        `/finance/${role === 'receivable' ? 'finReceivable' : 'finPayable'}/queryById?id=${sourceBillId}`
      ), `FMS-004 ${role} 核销反向来源回读`))
      const reverse = await readPublishedDelivery(api, caseRecord, fixture.checkId,
        role === 'receivable' ? 'ERP_RECEIVABLE_WRITE_OFF' : 'ERP_PAYABLE_WRITE_OFF', 'REVERSE')
      const original = writeOff.draft
        ? dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${writeOff.draft.id}`)) : null
      const evidence = assessFms004WriteOffReversal(writeOff, reverse, original, bill?.checkedAmt)
      const sourceIdentityVerified = String(bill?.id) === sourceBillId
      const reverseVerified = sourceIdentityVerified && evidence.passed
      writeOffReverseResults.push({ role, passed: reverseVerified })
      source.reverseVerified = reverseVerified
      check(caseRecord, `${role} 真实核销反向发布独立事件且余额归零、原草稿内容不变并取消`,
        reverseVerified, JSON.stringify({ sourceBillId, checkedAmt: bill?.checkedAmt,
          sourceIdentityVerified,
          originalDraftId: original?.id, originalStatus: original?.status,
          reverseDraftId: reverse.draft?.id, reverseStatus: reverse.event.processStatus, ...evidence }))
      if (reverse.event.processStatus === 'PENDING') {
        caseRecord.notes.push(`${role} ERP 反向已发布；FMS 反向映射尚缺，保持 PENDING：${reverse.event.processMessage}。未宣称反向会计草稿/正式过账通过。`)
      }
    }))
    check(caseRecord, 'ERP 应收/应付核销真实正反发布闭环',
      writeOffReverseResults.length === 2 && writeOffReverseResults.every((item) => item.passed),
      `核销弃审发布 REVERSE，引用正向 sourceEventId，反向重放幂等、ERP 余额归零：${JSON.stringify(writeOffReverseResults)}`)
    const afterContext = await readFms004Context(api, caseRecord, 'after')
    const finalVouchers = await readFms004FormalVouchers(api, caseRecord, 'after')
    check(caseRecord, 'FMS-004 账套、期间和正式凭证保持不变',
      JSON.stringify(context) === JSON.stringify(afterContext) &&
      JSON.stringify(beforeVouchers) === JSON.stringify(finalVouchers),
      `accountSetId=${context.accountSetId} month=${context.month}；未创建账套、未改映射、未结账`)
    caseRecord.evidence.push(
      'FMS-004 独立安全前置、专属账套/开放期间 API/SQL、现金草稿主子表精确回读、Chrome 草稿详情与正式凭证零写入快照'
    )
  } finally {
    for (const fixture of fixtures.reverse()) {
      if (!fixture.writeoffCleaned) await cleanupWriteOff(api, fixture)
      await cleanupOpening(api, fixture)
      caseRecord.fixtures ||= []
      caseRecord.fixtures.push({ kind: 'fms004-erp-writeoff', role: fixture.role,
        id: fixture.id, receiptId: fixture.receiptId, paymentId: fixture.paymentId,
        checkId: fixture.checkId, cleanup: fixture.cleanup })
      check(caseRecord, 'FMS-004 ERP 核销与期初夹具受控清理',
        fixture.cleanup?.startsWith('CLEANED_API'), fixture.cleanup)
    }
  }
  return { sources }
}

async function runFms007Closure ({ api, caseRecord }) {
  const key = fixtureKey('FMS-007')
  const partner = await createPartner(api, key)
  const batch = `${key}-BATCH`
  const created = await createOpeningBatch(api, 'receivable', [partner], batch)
  try {
    await approveOpening(api, created.bill, batch)
    const reconcile = dataOf(await api.postBusiness('/finance/dealingsBeginning/openingReconcile',
      { id: created.bill.id }))
    const reconcileRead = reconcile?.openingBaseDate != null &&
      Array.isArray(reconcile?.entries) && reconcile.entries.length === 1
    const adjustment = dataOf(await api.postBusiness('/fms/partner-opening-adjustment/apply', {
      accountSetId: numericId(config.fmsAccountSetId),
      sourceSystem: 'ERP',
      importBatchNo: batch,
      openingBaseDate: '2026-10-07',
      partnerRole: 'CUSTOMER',
      partnerId: partner.id,
      partnerName: partner.name,
      subjectCode: '1122',
      sourceAmount: '123.45',
      targetAmount: '200.00',
      reason: `${key} difference adjustment`
    }))
    const adjusted = dataOf(await api.postBusiness('/finance/dealingsBeginning/openingReconcile',
      { id: created.bill.id }))
    certify(caseRecord, 'FMS-007', 3,
      Array.isArray(adjusted?.adjustments) && adjusted?.adjustments?.length >= 1 &&
      money(adjusted?.adjustmentTotalAmount) === 7655 &&
      Array.isArray(adjusted?.entries?.[0]?.adjustments),
    `差异调整后台账/对账回读：adjustmentTotal=${adjusted?.adjustmentTotalAmount} entries=${adjusted?.adjustments?.length}`)
    const revoked = dataOf(await api.postBusiness('/fms/partner-opening-adjustment/revoke', {
      accountSetId: numericId(config.fmsAccountSetId),
      id: adjustment.id,
      reason: `${key} revoke adjustment`
    }))
    const restored = dataOf(await api.postBusiness('/finance/dealingsBeginning/openingReconcile',
      { id: created.bill.id }))
    certify(caseRecord, 'FMS-007', 0,
      reconcileRead && revoked?.status === 'REVOKED' && money(restored?.adjustmentTotalAmount) === 0 &&
      money(restored?.fmsTotalAmount) === money(restored?.sourceTotalAmount),
    `期初批次回读 openingBaseDate=${reconcile?.openingBaseDate}；调整撤销后对账回到基线 status=${revoked?.status} fms=${restored?.fmsTotalAmount}`)
    certify(caseRecord, 'FMS-007', 2,
      adjusted?.adjustments?.length >= 1 && revoked?.status === 'REVOKED',
      '汇总到FMS由批次台账+调整台账重建，对账入口返回调整历史')
    certify(caseRecord, 'FMS-007', 0,
      reconcileRead, '差异调整走受控调整台账，对账本身只读，不修改来源单据', true)
  } finally {
    const fixture = { id: created.bill.id, role: 'receivable', batch,
      partnerId: partner.id, cleanup: 'PENDING' }
    await cleanupOpening(api, fixture)
    caseRecord.fixtures ||= []
    caseRecord.fixtures.push({ kind: 'fms007-opening-adjustment', id: fixture.id, batch,
      cleanup: fixture.cleanup })
    check(caseRecord, 'FMS-007 专属期初夹具受控清理',
      fixture.cleanup?.startsWith('CLEANED_API'), fixture.cleanup)
  }
}

export async function runFmsWriteClosure ({ caseId, api, caseRecord, outputDir, page, record }) {
  const ctx = { api, caseRecord, outputDir, page, record }
  if (caseId === 'FMS-001') return runFms001Closure(ctx)
  if (caseId === 'FMS-002') return runFms002Closure(ctx)
  if (caseId === 'FMS-003') return runFms003Closure(ctx)
  if (caseId === 'FMS-004') return runFms004Closure(ctx)
  if (caseId === 'FMS-005') {
    await ensureAcceptanceNumbering(api, caseRecord, ['fin_yshx_bill_no', 'fin_yfhx_bill_no'])
    await runFms005Summary(ctx)
    await runFms005WriteOff(ctx)
    return
  }
  if (caseId === 'FMS-006') return runFms006({ api, caseRecord, outputDir })
  if (caseId === 'FMS-007') return runFms007Closure(ctx)
}
