import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import {
  check, dataOf, money, numericId, proof, database, reconcileMatches
} from '../fmshelper/contracts.mjs'

const unique = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`

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
async function createOpening (api, partner, batch, amount = '123.45') {
  const id = numericId(dataOf(await api.postBusiness('/finance/dealingsBeginning/add', {
    dealingsLogotype: 'receivable',
    billDate: '2026-10-07',
    openingBaseDate: '2026-10-07',
    importBatchNo: batch,
    detailsDesc: batch,
    deviceSource: 'E2E-FMS',
    finReceivables: [{
      customerId: partner.id,
      amt: amount,
      detailsDesc: batch,
      invoiceNo: `E2E-${batch}`,
      invoiceType: 'E2E',
      invoiceDate: '2026-10-07 00:00:43',
      collectionTime: '2026-10-07 00:00:43'
    }]
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

async function createReceipt (api, partnerId, accountId, key, amount = '123.45') {
  const body = {
    billNo: `${key}-RCPT`,
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
  const entries = dataOf(await api.getBusiness(
    `/finance/finReceipt/queryEntryByMainId?id=${encodeURIComponent(id)}`
  ))
  const entry = (Array.isArray(entries) ? entries : []).find((row) =>
    String(row.mid) === String(id))
  if (!entry?.id) throw new Error(`FMS-005 收款单明细未回读：${JSON.stringify(entries)}`)
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

async function createReceivableCheck (api, { partnerId, accountId, receivable, entry, receipt, receiptEntry, key }) {
  const amount = '123.45'
  const body = {
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
  const response = await api.request(method, pathname, body)
  const message = String(response?.msg || response?.message || '')
  const passed = response?.code !== 0 && message.includes(expected)
  return { response, message, passed, key }
}

async function cleanupWriteOff (api, fixture) {
  if (!fixture?.checkId) return
  try {
    await api.putBusiness('/finance/finReceivableCheck/void', { id: fixture.checkId })
    fixture.cleanup = 'CLEANED_API: 已通过核销单作废反向回写'
  } catch (error) {
    fixture.cleanup = `RETAINED_AUDIT: 核销单反向清理失败：${error.message}`
  }
}

async function cleanupOpening (api, fixture) {
  if (!fixture?.id) return
  try {
    await api.putBusiness('/finance/dealingsBeginning/void', { id: fixture.id })
    await api.deleteBusiness(
      `/finance/dealingsBeginning/delete?id=${encodeURIComponent(fixture.id)}`
    )
    fixture.cleanup = 'CLEANED_API: 期初批次已作废并删除'
  } catch (error) {
    fixture.cleanup = `RETAINED_AUDIT: 期初批次清理失败：${error.message}`
  }
}

async function buildWrittenOffOpening (api, common, key, effective) {
  const batch = unique(`E2E-FMS-005-${effective ? 'EFFECTIVE' : 'DRAFT'}`)
  const bill = await createOpening(api, common.partner, batch)
  const fixture = { id: bill.id, batch, bill, cleanup: 'PENDING' }
  try {
    if (effective) await approveOpening(api, bill, batch)
    const { receivable, entry } = await openingReceivable(api, bill.id)
    const receipt = await createReceipt(api, common.partner.id, common.accountId, `${key}-${effective ? 'A' : 'B'}`)
    const check = await createReceivableCheck(api, {
      partnerId: common.partner.id,
      accountId: common.accountId,
      receivable,
      entry,
      receipt,
      receiptEntry: receipt.entry,
      key
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
      await ctx.api.deleteBusiness(
        `/finance/dealingsBeginning/delete?id=${encodeURIComponent(bill.id)}`)
      fixture.cleanup = 'CLEANED_API: 期初批次已弃审并删除'
    }
  } finally {
    for (const fixture of batches.reverse()) {
      try {
        if (!fixture.voided) {
          await ctx.api.putBusiness('/finance/dealingsBeginning/void', { id: fixture.id })
          fixture.voided = true
        }
        await ctx.api.deleteBusiness(
          `/finance/dealingsBeginning/delete?id=${encodeURIComponent(fixture.id)}`)
        fixture.cleanup ||= 'CLEANED_API: 期初批次已弃审并删除'
      } catch (error) {
        fixture.cleanup ||= `RETAINED_AUDIT: 期初批次清理失败：${error.message}`
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

    const evidence = JSON.stringify({
      effectiveBatch: effectiveBatch.batch,
      draftBatch: draftBatch.batch,
      void: voidResult.message,
      update: updateResponse.message,
      delete: draftDelete.message,
      checkIds: [effectiveBatch.checkId, draftBatch.checkId]
    })
    const passed = voidResult.passed && updateResponse.passed && draftDelete.passed
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
      '真实期初应收、收款、应收核销执行与 checkedAmt 回写；已核销批次三类写侧拒绝探针'
    )
  } finally {
    for (const fixture of fixtures.reverse()) {
      await cleanupWriteOff(ctx.api, fixture)
      await cleanupOpening(ctx.api, fixture)
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

export async function runFmsWriteClosure ({ caseId, api, caseRecord, outputDir }) {
  if (caseId === 'FMS-005') {
    const ctx = { api, caseRecord, outputDir }
    await runFms005Summary(ctx)
    await runFms005WriteOff(ctx)
    return
  }
  if (caseId === 'FMS-006') return runFms006({ api, caseRecord, outputDir })
}
