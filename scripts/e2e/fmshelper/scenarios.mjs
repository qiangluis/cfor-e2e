import fs from 'node:fs'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { findMenuRouteByComponent } from '../suites/base-partner.mjs'
import { prepareOpeningBatchFilter } from './search-form.mjs'
import {
  dataOf, fixtureKey, numericId, ownedKey, money, check, proof, missing,
  preflight, database, sourceDelivery, balancedDraft, draftLedgerPaths, reconcileMatches, readEvent,
  expectRejected, receiptMappingBody, openingQuery, catalogResult
  , openingDateInputOrder
} from './contracts.mjs'
import { runFms004Closure } from '../fixtures/fms-write-closure.mjs'

const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const definitions = catalog.suites.find((suite) => suite.id === 'fms').cases

export function comparableDraftEntries (entries = []) {
  return entries.map((entry) => ({
    lineNo: entry.lineNo,
    accountCode: entry.accountCode,
    direction: entry.direction,
    amount: entry.amount,
    auxiliaryType: entry.auxiliaryType ?? null,
    auxiliaryCode: entry.auxiliaryCode ?? null,
    auxiliaryName: entry.auxiliaryName ?? null,
    summary: entry.summary ?? null
  })).sort((left, right) => Number(left.lineNo || 0) - Number(right.lineNo || 0))
}
const statement = (id, index, reverse = false) =>
  definitions.find((item) => item.id === id)[reverse ? 'reverse' : 'assertions'][index]
const certify = (ctx, index, passed, detail, reverse = false) =>
  proof(ctx.caseRecord, statement(ctx.caseId, index, reverse), passed, detail)
const defer = (ctx, index, reason, reverse = false) =>
  missing(ctx.caseRecord, statement(ctx.caseId, index, reverse), reason)
const fixturesOf = (ctx) => (ctx.caseRecord.fixtures ||= [])

async function partner (ctx, role, key) {
  ownedKey(key)
  const id = numericId(dataOf(await ctx.api.postBusiness('/base/partner/create', {
    name: key, shortName: key.slice(-12), partnerKind: 'ORGANIZATION',
    taxNo: key.slice(-25), status: 'ACTIVE', customerEnabled: role === 'receivable',
    supplierEnabled: role === 'payable', carrierEnabled: false
  })))
  const fixture = { kind: 'partner', id, name: key, role, cleanup: 'PENDING' }
  fixturesOf(ctx).push(fixture)
  return fixture
}

async function show (ctx, component, text, tag, { detail = false } = {}) {
  const permission = dataOf(await ctx.api.getPermissionInfo())
  const route = findMenuRouteByComponent(permission.menus, component)
  if (!route) throw new Error(`BLOCKED: 权限菜单缺少 ${component}`)
  await openRoute(ctx.page, route, { readyTimeoutMs: 90000 })
  if (component === 'fms/voucherDraft/index' && text) {
    await ctx.page.getByPlaceholder('请输入草稿编号').fill(text)
    await ctx.page.getByRole('button', { name: '搜索', exact: true }).click()
  }
  if (component === 'fms/config/event-mapping/index' && text) {
    await ctx.page.getByPlaceholder('请输入事件类型').fill(text)
    await ctx.page.getByRole('button', { name: '查询', exact: true }).click()
  }
  if (component === 'erp/finance/dealingsBeginning/index' && text) {
    const batchFilter = await prepareOpeningBatchFilter(ctx.page)
    await batchFilter.fill(text)
    await ctx.page.getByRole('button', { name: '查询', exact: true }).click()
  }
  if (text) {
    await ctx.page.waitForFunction((value) =>
      !document.querySelector('.el-loading-mask') &&
      [...document.querySelectorAll('.el-table__row')].some((row) =>
        row.textContent.includes(value)), text, { timeout: 30000 })
    check(ctx.caseRecord, 'Chrome 显示本轮夹具，不使用历史行充当证据', true, `${tag}: ${text}`)
    if (detail) {
      await ctx.page.locator('.el-table__row').filter({ hasText: text })
        .getByRole('button', { name: '详情', exact: true }).click()
      await ctx.page.getByText('凭证草稿详情', { exact: true }).waitFor()
    }
  }
  await saveScreenshot(ctx.page, ctx.outputDir, tag, ctx.record)
}

async function account (ctx, key) {
  const id = numericId(dataOf(await ctx.api.postBusiness('/erp/account/create', {
    name: key, no: key, accountType: 'BANK', currency: 'CNY',
    status: 0, sort: 999, remark: key
  })))
  const fixture = { kind: 'account', id, key, cleanup: 'PENDING' }
  fixturesOf(ctx).push(fixture)
  return fixture
}

async function moneySource (ctx, role = 'receivable', amount = '123.45') {
  const key = fixtureKey(ctx.caseId)
  const who = await partner(ctx, role, key)
  const bank = await account(ctx, `${key}-BANK`)
  const receipt = role === 'receivable'
  const path = `/finance/${receipt ? 'finReceipt' : 'finPayment'}`
  const body = {
    billNo: key, billDate: '2026-10-07', isAuto: 0, isRubric: 0, isRequest: 0,
    [receipt ? 'receiptType' : 'paymentType']: receipt ? '102' : '2021',
    [receipt ? 'customerId' : 'supplierId']: who.id,
    bankAccountId: bank.id, collectionItem: '1', settleMethod: '1',
    discountAmt: 0, checkedAmt: 0, amt: amount, deviceSource: 'E2E-FMS',
    detailsRemark: key,
    [receipt ? 'finReceiptEntryList' : 'finPaymentEntryList']: [{
      entryNo: 1, amt: amount, discountAmt: 0, checkedAmt: 0,
      bankAccountId: bank.id, settleMethod: '1', collectionItem: '1', description: key
    }]
  }
  const id = numericId(dataOf(await ctx.api.postBusiness(`${path}/add/submit`, body)))
  const fixture = { kind: receipt ? 'receipt' : 'payment', id, path, key,
    partnerId: who.id, accountId: bank.id, cleanup: 'PENDING' }
  fixturesOf(ctx).push(fixture)
  const read = async () => dataOf(await ctx.api.getBusiness(`${path}/queryById?id=${id}`))
  let bill = await read()
  if (String(bill.isEffective) !== '1') {
    await ctx.api.putBusiness(`${path}/check`, {
      id, approvalResultType: '1', approvalRemark: key
    })
    bill = await read()
  }
  if (bill.billStage === '24') {
    await ctx.api.putBusiness(`${path}/execute`, { id })
    bill = await read()
  }
  check(ctx.caseRecord, '来源单据正式审核/执行完成，金额回读一致',
    String(bill.isEffective) === '1' && bill.billStage.startsWith('3') &&
    money(bill.amt) === money(amount), JSON.stringify({ id, stage: bill.billStage, amount: bill.amt }))
  const eventType = receipt ? 'ERP_RECEIPT_ARRIVED' : 'ERP_PAYMENT_DISBURSED'
  const delivery = await sourceDelivery(ctx.api, ctx.caseRecord, id, eventType)
  return { ...fixture, role, amount, bill, read, delivery }
}

async function eventSnapshot (ctx, source) {
  const id = numericId(source.id)
  return database(ctx.caseRecord, 'source-unchanged',
    `SELECT id,bill_stage,is_effective,amt,checked_amt,version FROM ${source.kind === 'receipt' ? 'fin_receipt' : 'fin_payment'}
     WHERE tenant_id=1 AND id='${id}'`)
}

async function inboxRetry (ctx, delivery) {
  const id = numericId(delivery.event.id)
  const before = await database(ctx.caseRecord, 'inbox-before-retry',
    `SELECT id,process_status,retry_count,draft_id FROM fms_event_inbox WHERE tenant_id=1 AND id='${id}'`)
  await ctx.api.postBusiness(`/fms/event-inbox/retry?id=${id}`)
  const after = await database(ctx.caseRecord, 'inbox-after-retry',
    `SELECT id,process_status,retry_count,draft_id FROM fms_event_inbox WHERE tenant_id=1 AND id='${id}'`)
  return { before, after }
}

async function sourceCase (ctx) {
  const source = await moneySource(ctx)
  const d = source.delivery
  certify(ctx, 0, d.outbox.length === 1, `来源=${source.id}, outbox=${d.outbox[0][0]}`)
  certify(ctx, 1, d.sent[0][1] === 'SENT' && d.sent[0][3] === d.event.id,
    `scheduler SENT -> inbox=${d.event.id}`)
  certify(ctx, 2, d.duplicate.duplicated && d.duplicate.id === d.event.id,
    `duplicate inbox=${d.duplicate.id}`)
  const before = await eventSnapshot(ctx, source)
  const retry = await inboxRetry(ctx, d)
  const after = await eventSnapshot(ctx, source)
  certify(ctx, 4, JSON.stringify(before) === JSON.stringify(after),
    `来源状态/金额/version 未改变：${JSON.stringify(after)}`)
  certify(ctx, 0, JSON.stringify(before) === JSON.stringify(after) &&
    retry.after[0][3] === retry.before[0][3], '仅调用 inbox retry；未重复审核/执行来源单', true)
  if (d.event.processStatus === 'PENDING') {
    // Inbox processing failures are not outbox transport failures.
    check(ctx.caseRecord, 'PENDING 处理失败重试仍保留唯一 inbox',
      Number(retry.after[0][2]) > Number(retry.before[0][2]), JSON.stringify(retry))
  }
  defer(ctx, 3, '本轮真实来源投递成功；未注入 outbox 传输失败，无失败重试/死信证据。inbox PENDING 不能替代 outbox 重试')
  await show(ctx, 'fms/eventInbox/index', source.id, 'source-outbox-inbox')
}

async function missingCost (ctx) {
  const key = fixtureKey(ctx.caseId)
  const payload = {
    sourceSystem: 'WMS', eventType: 'WMS_INVENTORY_MOVED', sourceBillType: 'E2E_FMS_CONTRACT_PROBE',
    sourceBillId: key, sourceBillNo: key, sourceVersion: '1', direction: 'FORWARD',
    sourceEventId: key, accountSetId: config.fmsAccountSetId, bizDate: '2026-10-07T10:00:00',
    summary: `${key} missing-cost contract probe`,
    lines: [{ direction: 'DEBIT', quantity: 1, amount: 0 },
      { direction: 'CREDIT', quantity: 1, amount: 0 }]
  }
  const accepted = dataOf(await ctx.api.postBusiness('/fms/voucher-draft/accept-event', payload))
  fixturesOf(ctx).push({ kind: 'contract-probe', key, inboxId: accepted.id,
    cleanup: 'RETAINED_AUDIT: inbox 无删除接口；不是 WMS 来源业务证据' })
  check(ctx.caseRecord, '缺成本契约探针明确 PENDING 且不生成零金额伪草稿',
    accepted.processStatus === 'PENDING' && !accepted.draftId &&
    /成本快照/.test(accepted.processMessage), JSON.stringify(accepted))
  const reverse = dataOf(await ctx.api.postBusiness('/fms/voucher-draft/accept-event', {
    ...payload, direction: 'REVERSE', sourceEventId: `${key}-REVERSE`,
    reversalOfEventId: accepted.id
  }))
  fixturesOf(ctx).push({ kind: 'reverse-contract-probe', key, inboxId: reverse.id,
    cleanup: 'RETAINED_AUDIT: inbox 无删除接口；不是 WMS 反向业务证据' })
  check(ctx.caseRecord, '反向缺成本契约探针独立 PENDING，不覆盖正向',
    reverse.id !== accepted.id && reverse.processStatus === 'PENDING' && !reverse.draftId,
    JSON.stringify(reverse))
  const retry = await inboxRetry(ctx, { event: accepted })
  check(ctx.caseRecord, '缺成本事件重试仍 PENDING 且重试计数增加',
    retry.after[0][1] === 'PENDING' && Number(retry.after[0][2]) > Number(retry.before[0][2]),
    JSON.stringify(retry))
  await show(ctx, 'fms/eventInbox/index', key, 'missing-cost-pending')
  return accepted
}

async function costCase (ctx) {
  const tables = await database(ctx.caseRecord, 'cost-snapshot-schema',
    "SELECT table_name FROM information_schema.tables WHERE table_schema='cfor_admin_standard' AND table_name='erp_cost_snapshot'")
  await missingCost(ctx)
  const source = await moneySource(ctx)
  if (source.delivery.draft) {
    check(ctx.caseRecord, 'ERP 收款草稿借贷金额与来源一致',
      balancedDraft(source.delivery.draft, source.amount), JSON.stringify(source.delivery.draft))
    check(ctx.caseRecord, '收款事件不自动确认/过账', source.delivery.draft.status === 'DRAFT')
    await show(ctx, 'fms/voucherDraft/index', source.delivery.draft.draftNo, 'money-draft', { detail: true })
  }
  defer(ctx, 0, `真实 ERP 受控成本快照接口/表未找到（erp_cost_snapshot rows=${tables.length}），不能伪造成本来源`)
  defer(ctx, 1, '契约探针已证明缺成本 PENDING，但尚无本轮真实 WMS 出入库来源事务证据')
  defer(ctx, 2, '收款草稿平衡不是 ERP 成本快照/WMS 成本草稿证据')
  defer(ctx, 3, '缺成本探针没有草稿；完整成本路径未执行，不能外推自动确认/过账边界')
  defer(ctx, 4, '探针来源字段完整，但不冒充真实 WMS 来源字段')
  defer(ctx, 0, '已验证接口反向 PENDING 隔离；真实 WMS 反向业务事件链仍待补证据', true)
}

async function confirmationCase (ctx) {
  const source = await moneySource(ctx)
  const draft = source.delivery.draft
  if (!draft) {
    for (let i = 0; i < 5; i++) defer(ctx, i,
      `真实来源事件未生成草稿：${source.delivery.event.processMessage}`)
    defer(ctx, 0, '没有可取消/冲销的真实草稿，且无草稿取消接口', true)
    await show(ctx, 'fms/eventInbox/index', source.id, 'confirmation-pending')
    return
  }
  check(ctx.caseRecord, '确认前草稿为 DRAFT 且金额平衡', draft.status === 'DRAFT' &&
    balancedDraft(draft, source.amount), draft.draftNo)
  const subjects = dataOf(await ctx.api.getBusiness(
    `/fms/config/subject/list?accountSetId=${config.fmsAccountSetId}`))
  const ledgerPaths = draftLedgerPaths(draft, subjects, '2026-10')
  const beforeLedger = []
  for (const pathname of ledgerPaths) {
    beforeLedger.push(dataOf(await ctx.api.getBusiness(pathname)))
  }
  const beforeVouchers = await database(ctx.caseRecord, 'formal-before-confirm',
    `SELECT id,status,total FROM fms_voucher WHERE tenant_id=1 AND deleted=0 AND account_set_id=${config.fmsAccountSetId} ORDER BY id`)
  await show(ctx, 'fms/voucherDraft/index', draft.draftNo, 'draft-before-confirm', { detail: true })
  const drawer = ctx.page.locator('.el-drawer:visible').first()
  await drawer.locator('.el-drawer__close-btn:visible').first().click()
  await drawer.waitFor({ state: 'hidden' })
  const row = ctx.page.locator('.el-table__row').filter({ hasText: draft.draftNo })
  await row.getByRole('button', { name: '确认', exact: true }).click()
  const dialog = ctx.page.getByRole('dialog', { name: '确认凭证草稿', exact: true })
  await dialog.locator('input').fill(`${source.key} human confirmation`)
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await ctx.page.getByText('已确认（草稿状态更新，尚未过账）').waitFor()
  const confirmed = dataOf(await ctx.api.getBusiness(`/fms/voucher-draft/get?id=${draft.id}`))
  const permission = dataOf(await ctx.api.getPermissionInfo())
  const permissions = Array.isArray(permission?.permissions) ? permission.permissions : []
  check(ctx.caseRecord, '有权限用户通过 Chrome 确认并保留确认人/时间',
    (permissions.includes('*:*:*') || permissions.includes('fms:voucher-draft:confirm')) &&
    confirmed.status === 'CONFIRMED' && Boolean(confirmed.confirmedBy) && Boolean(confirmed.confirmedTime),
    JSON.stringify({ id: confirmed.id, status: confirmed.status, confirmedBy: confirmed.confirmedBy }))
  defer(ctx, 0, '已验证有权限用户；尚无配置的无确认权限测试账号，未证明仅有权限用户可确认')
  const afterLedger = []
  for (const pathname of ledgerPaths) {
    afterLedger.push(dataOf(await ctx.api.getBusiness(pathname)))
  }
  const afterVouchers = await database(ctx.caseRecord, 'formal-after-confirm',
    `SELECT id,status,total FROM fms_voucher WHERE tenant_id=1 AND deleted=0 AND account_set_id=${config.fmsAccountSetId} ORDER BY id`)
  certify(ctx, 1, confirmed.status === 'CONFIRMED' &&
    JSON.stringify(beforeVouchers) === JSON.stringify(afterVouchers), 'Chrome 人工确认只更新草稿，正式凭证快照未变')
  certify(ctx, 2, JSON.stringify(beforeLedger) === JSON.stringify(afterLedger) &&
    JSON.stringify(comparableDraftEntries(draft.entries)) ===
    JSON.stringify(comparableDraftEntries(confirmed.entries)), '确认前后真实账簿 API 相同，分录未改变')
  await show(ctx, 'fms/voucherDraft/index', draft.draftNo, 'draft-confirmed', { detail: true })
  defer(ctx, 3, '正式凭证有 create/review API，但没有 confirmed draft 转正式凭证/过账契约；不把审核 APPROVED 冒称 POSTED')
  defer(ctx, 4, '草稿没有过账操作，未关闭当前期间以免改变后续验证环境；不以缺接口冒称关闭阻断过账')
  defer(ctx, 0, '草稿无取消 API，正式凭证无基于草稿的冲销契约；不能直接删除/改分录替代', true)
}

async function fms004ClosureCase (ctx) {
  const result = await runFms004Closure({
    api: ctx.api,
    caseRecord: ctx.caseRecord,
    outputDir: ctx.outputDir,
    page: ctx.page,
    record: ctx.record
  })
  for (const source of result.sources || []) {
    await show(
      ctx,
      'fms/eventInbox/index',
      source.cash.event?.sourceBillId,
      `${source.role}-written-off-arrived-inbox`
    )
  }
  ctx.caseRecord.evidence.push(
    '单次 FMS-004 写侧闭环：收款/付款及核销事件并行等待后台 outbox 调度，浏览器回读本轮事件 inbox'
  )
}

async function workbook (ctx, role, partners, batch) {
  const XLSX = await import('xlsx')
  const template = await ctx.api.download('/finance/dealingsBeginning/get-import-template')
  const input = XLSX.read(template.buffer, { type: 'buffer', cellDates: true })
  const headers = XLSX.utils.sheet_to_json(input.Sheets[input.SheetNames[0]], { header: 1 })[0]
  const lines = [
    [partners[0], 100.01], [partners[0], 23.44], [partners[1], 67.89]
  ].map(([p, amount]) => ({
    往来标识: role, 单据日期: new Date('2026-10-07T00:00:00+08:00'),
    上线基准日: new Date('2026-10-07T00:00:00+08:00'), 导入批次号: batch,
    客商ID: p.id, '客商名称（校验用）': p.name, 期初金额: amount,
    明细描述: batch, 设备来源: 'E2E-FMS'
  }))
  const output = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(output, XLSX.utils.aoa_to_sheet([
    headers, ...lines.map((line) => headers.map((header) => line[header] ?? ''))
  ]), '往来期初列表')
  return XLSX.write(output, { type: 'buffer', bookType: 'xlsx', cellDates: true, dateNF: 'yyyy-mm-dd' })
}

async function openingSnapshot (ctx, batch) {
  return database(ctx.caseRecord, `opening-${batch}`,
    `SELECT id,partner_id,subject_code,auxiliary_item_id,amount,apply_status
     FROM fms_partner_opening_balance WHERE tenant_id=1 AND deleted=0
     AND account_set_id=${config.fmsAccountSetId} AND import_batch_no='${ownedKey(batch)}' ORDER BY partner_id`)
}

async function balances (ctx, role) {
  const subjectType = role === 'payable' ? 2 : 1
  return dataOf(await ctx.api.getBusiness(
    `/fms/config/initial-balance/list?accountSetId=${config.fmsAccountSetId}&subjectType=${subjectType}`))
}

export function assistAmount (rows, subjectId, itemId) {
  const subject = rows.find((row) => String(row.subjectId) === String(subjectId))
  return (subject?.assistBalances || []).filter((row) =>
    (row.auxiliaries || []).some((auxiliary) =>
      String(auxiliary.itemId) === String(itemId)))
    .reduce((sum, row) => sum + money(row.openingAmount), 0)
}

async function openingCase (ctx) {
  for (const role of ['receivable', 'payable']) {
    const batch = fixtureKey(ctx.caseId)
    const partners = [await partner(ctx, role, `${batch}-A`),
      await partner(ctx, role, `${batch}-B`)]
    const fixture = { kind: 'opening', role, key: batch, cleanup: 'PENDING' }
    fixturesOf(ctx).push(fixture)
    const form = new FormData()
    form.append('file', new Blob([await workbook(ctx, role, partners, batch)]), `${batch}.xlsx`)
    form.append('updateSupport', 'false')
    const imported = dataOf(await ctx.api.uploadBusiness('/finance/dealingsBeginning/import', form))
    check(ctx.caseRecord, '多客商三行 Excel 整批导入成功', imported.successCount === 3 &&
      imported.failureCount === 0, JSON.stringify(imported))
    const list = dataOf(await ctx.api.getBusiness(`/finance/dealingsBeginning/list?pageNo=1&pageSize=100&importBatchNo=${batch}`))
    const bill = (list.records || list.list || []).find((row) => row.importBatchNo === batch)
    if (!bill) throw new Error('本轮期初主单未回读')
    fixture.id = numericId(bill.id)
    fixture.path = '/finance/dealingsBeginning'
    const children = dataOf(await ctx.api.postBusiness(`${fixture.path}/selectByMainId`, {
      id: fixture.id, dealingsLogotype: role
    }))
    check(ctx.caseRecord, '导入主子单保持待审14/0，不自动审核', bill.billStage === '14' &&
      String(bill.isEffective) === '0' && children.every((c) =>
        c.billStage === '14' && String(c.isEffective) === '0'), JSON.stringify(children))
    await ctx.api.putBusiness(`${fixture.path}/check`, {
      id: fixture.id, approvalResultType: '1', approvalRemark: batch
    })
    const expected = new Map([[partners[0].id, '123.45'], [partners[1].id, '67.89']])
    const first = await openingSnapshot(ctx, batch)
    const initial = await balances(ctx, role)
    const links = await database(ctx.caseRecord, 'opening-subject-links',
      `SELECT partner_id,subject_id,auxiliary_item_id FROM fms_partner_opening_balance
       WHERE tenant_id=1 AND deleted=0 AND account_set_id=${config.fmsAccountSetId}
       AND import_batch_no='${batch}' ORDER BY partner_id`)
    certify(ctx, 0, first.length === 2 && first.every((row) =>
      row[2] === (role === 'receivable' ? '1122' : '2202') &&
      row[5] === 'APPLIED' && money(row[4]) === money(expected.get(row[1]))) &&
      links.every(([id, subject, item]) =>
        assistAmount(initial, subject, item) === money(expected.get(id))),
    `${role} batch=${batch}, ledger=${JSON.stringify(first)}`)
    for (let i = 0; i < 2; i++) await ctx.api.postBusiness(`${fixture.path}/syncOpening`, { id: fixture.id })
    const repeated = await openingSnapshot(ctx, batch)
    const repeatedBalances = await balances(ctx, role)
    certify(ctx, 1, JSON.stringify(first) === JSON.stringify(repeated) &&
      links.every(([, subject, item]) => assistAmount(initial, subject, item) ===
        assistAmount(repeatedBalances, subject, item)), '真实重复 syncOpening 两次，台账数量/金额与辅助余额均不累计')
    const reconcile = dataOf(await ctx.api.postBusiness(`${fixture.path}/openingReconcile`, { id: fixture.id }))
    certify(ctx, 3, reconcileMatches(reconcile, expected), JSON.stringify(reconcile))
    await show(ctx, 'erp/finance/dealingsBeginning/index', batch, `${role}-opening-batch`)
    await ctx.api.putBusiness(`${fixture.path}/void`, { id: fixture.id })
    fixture.voided = true
    const reversed = await openingSnapshot(ctx, batch)
    const reversedBalances = await balances(ctx, role)
    certify(ctx, 2, reversed.length === 2 && reversed.every((row) => row[5] === 'REVERSED') &&
      links.every(([, subject, item]) => assistAmount(reversedBalances, subject, item) === 0),
    `台账保留审计，辅助核算余额归零：${JSON.stringify(reversed)}`)
    certify(ctx, 0, reversed.every((row) => row[5] === 'REVERSED') &&
      links.every(([, subject, item]) => assistAmount(reversedBalances, subject, item) === 0),
    '仅走往来期初弃审，不直接写科目余额', true)
  }
  defer(ctx, 4, '期初子单确认后当前为24；核销要求正式执行态，需真实受控核销夹具，不通过直接SQL改checked_amt制造证据')
}

async function mappingCase (ctx) {
  const key = fixtureKey(ctx.caseId)
  const mappingBody = receiptMappingBody(key)
  const eventType = mappingBody.eventType
  const mappingSnapshot = () => database(ctx.caseRecord, 'receipt-mapping-guard',
    `SELECT id,account_set_id,direction,account_code,rule_version,priority,effective_from,effective_to
     FROM fms_event_mapping WHERE tenant_id IN (0,1) AND deleted=0 AND enabled=1
     AND source_system='ERP' AND event_type='ERP_RECEIPT_ARRIVED' ORDER BY id`)
  const existing = await mappingSnapshot()
  if (existing.some((row) => row[1] === config.fmsAccountSetId)) {
    throw new Error('BLOCKED: 收款事件已存在账套专属映射，不覆盖既有会计规则')
  }
  const defaults = existing.filter((row) => ['NULL', '', 'null'].includes(row[1]) ||
    row[1] === null || row[1] === '0')
  if (defaults.length !== 2 ||
      !defaults.some((row) => row[2] === 'DEBIT' && row[3] === '1002') ||
      !defaults.some((row) => row[2] === 'CREDIT' && row[3] === '1122')) {
    throw new Error('BLOCKED: 平台默认收款科目不是已确认的1002/1122，不自行选择会计口径')
  }
  const mappingId = String(dataOf(await ctx.api.postBusiness(
    '/fms/config/event-mapping/create', mappingBody)))
  const fixture = {
    kind: 'event-mapping', id: mappingId, key, eventType,
    cleanup: 'PENDING'
  }
  fixturesOf(ctx).push(fixture)
  try {
    const detail = dataOf(await ctx.api.getBusiness(
      `/fms/config/event-mapping/get?id=${encodeURIComponent(mappingId)}`))
    const page = dataOf(await ctx.api.getBusiness(
      `/fms/config/event-mapping/page?pageNo=1&pageSize=100&accountSetId=${config.fmsAccountSetId}&eventType=${eventType}`))
    const pageRows = page.list || page.records || []
    const listed = pageRows.find((row) => String(row.id) === mappingId)
    check(ctx.caseRecord, '本轮专属规则保存、分页与三行分录详情回读一致',
      listed?.accountSetId === config.fmsAccountSetId &&
      detail?.accountSetId === config.fmsAccountSetId &&
      detail?.priority === 200 && detail.entries?.length === 3, `账套专属映射=${mappingId}`)
    defer(ctx, 2, '真实ERP发布器仅提供sourceSystem/sourceBillType/eventType/direction；未提供业务场景、组织、税率、客商角色或成本构成项，不伪造上下文冒充条件命中')

    await show(ctx, 'fms/config/event-mapping/index', eventType, 'mapping-config')
    const mappingRow = ctx.page.locator('.el-table__row').filter({ hasText: key })
    await mappingRow.getByRole('button').first().click()
    const formDialog = ctx.page.getByRole('dialog', { name: '编辑事件映射规则', exact: true })
    const entryTable = formDialog.locator('.el-table').last()
    await formDialog.getByText('分录规则', { exact: true }).waitFor()
    await ctx.page.waitForFunction(() => {
      const dialog = [...document.querySelectorAll('.el-dialog')].find((element) =>
        element.getBoundingClientRect().width > 0 && element.textContent.includes('编辑事件映射规则'))
      const rows = dialog?.querySelectorAll('.el-table .el-table__body-wrapper .el-table__row') || []
      // 金额表达式等字段渲染在输入框 value 中，不在 textContent，必须一并采集。
      const inputValues = [...(dialog?.querySelectorAll('input') || [])]
        .map((input) => input.value).join(' ')
      const text = `${dialog?.textContent || ''} ${inputValues}`
      return dialog && !dialog.querySelector('.el-loading-mask') &&
        rows.length === 3 && text.includes('100201') && text.includes('1122') &&
        text.includes('line.amount * 0.4') && text.includes('line.amount')
    })
    const entryRows = entryTable.locator('.el-table__body-wrapper .el-table__row')
    const entryText = await entryTable.innerText()
    // 金额表达式在输入框 value 中，innerText 采集不到，需一并读取。
    const entryInputValues = await entryTable.locator('input')
      .evaluateAll((inputs) => inputs.map((input) => input.value).join(' '))
    const visibleEntryText = `${entryText} ${entryInputValues}`
    certify(ctx, 5, await entryRows.count() === 3 &&
      visibleEntryText.includes('100201') && visibleEntryText.includes('1122') &&
      visibleEntryText.includes('line.amount * 0.4') && visibleEntryText.includes('line.amount'),
    `Chrome过滤eventType=${eventType}，打开本轮${key}规则，3行末级科目100201/1122及金额表达式可见；未保存表单`)
    await saveScreenshot(ctx.page, ctx.outputDir, 'mapping-entry-details', ctx.record)
    // 共享 Dialog 组件隐藏了 Element 默认关闭按钮，改用标准 Escape 关闭弹窗。
    await ctx.page.keyboard.press('Escape')
    await formDialog.waitFor({ state: 'hidden' })
    const sourceV1 = await moneySource(ctx, 'receivable', '123.45')
    const draftV1 = sourceV1.delivery.draft
    if (!draftV1) throw new Error('FMS-006 真实 ERP 来源未生成草稿')
    certify(ctx, 0, draftV1.mappingId === mappingId && draftV1.mappingRuleVersion === 1,
      `平台默认=${JSON.stringify(defaults)}；本轮专属priority=200仍优先命中${mappingId} v1`)
    check(ctx.caseRecord, '生效期内真实ERP事件命中唯一专属规则版本',
      draftV1.mappingId === mappingId && draftV1.mappingRuleVersion === 1 &&
      detail.effectiveFrom === '2026-10-01' && detail.effectiveTo === '2026-10-31',
    `bizDate=${draftV1.bizDate}, mapping=${mappingId} v1`)
    certify(ctx, 3, balancedDraft(draftV1, sourceV1.amount) &&
      draftV1.entries.length === 3 && draftV1.status === 'DRAFT' &&
      draftV1.entries.some((entry) => entry.direction === 'DEBIT') &&
      draftV1.entries.some((entry) => entry.direction === 'CREDIT'),
    JSON.stringify(draftV1))
    await show(ctx, 'fms/voucherDraft/index', draftV1.draftNo, 'mapping-draft-v1', { detail: true })

    const updatedBody = { ...receiptMappingBody(key, 2), id: mappingId }
    await ctx.api.putBusiness('/fms/config/event-mapping/update', updatedBody)
    const sourceV2 = await moneySource(ctx, 'receivable', '123.45')
    const draftV2 = sourceV2.delivery.draft
    const historical = dataOf(await ctx.api.getBusiness(
      `/fms/voucher-draft/get?id=${encodeURIComponent(draftV1.id)}`))
    certify(ctx, 4, draftV2?.mappingId === mappingId &&
      draftV2.mappingRuleVersion === 2 &&
      historical?.mappingId === mappingId &&
      historical.mappingRuleVersion === 1,
    JSON.stringify({
      oldVersion: historical?.mappingRuleVersion,
      newVersion: draftV2?.mappingRuleVersion
    }))
    check(ctx.caseRecord, '新版规则仍为原科目原金额的四行平衡草稿，不自动确认或过账',
      draftV2?.status === 'DRAFT' && balancedDraft(draftV2, sourceV2.amount) &&
      draftV2.entries.length === 4, `新事件草稿命中映射 ${mappingId} v2`)
    certify(ctx, 0, historical?.mappingRuleVersion === 1 &&
      draftV2?.mappingRuleVersion === 2 &&
      JSON.stringify(historical.entries) === JSON.stringify(draftV1.entries),
    '规则版本变化只影响新事件，历史草稿保留v1和原分录', true)
    await show(ctx, 'fms/voucherDraft/index', draftV2.draftNo, 'mapping-draft-v2', { detail: true })
    await ctx.api.putBusiness('/fms/config/event-mapping/update', {
      ...updatedBody, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30', remark: `${key} v3 future`
    })
    const outside = await moneySource(ctx, 'receivable', '123.45')
    certify(ctx, 1, defaults.some((row) => row[0] === outside.delivery.draft?.mappingId) &&
      outside.delivery.draft?.mappingId !== mappingId &&
      balancedDraft(outside.delivery.draft, outside.amount) && outside.delivery.draft.entries.length === 2,
    `专属priority=200生效期内命中v1/v2；未来生效期v3不命中，回到平台映射${outside.delivery.draft?.mappingId}`)
    await show(ctx, 'fms/voucherDraft/index', outside.delivery.draft.draftNo,
      'mapping-outside-effective-period', { detail: true })
  } finally {
    await cleanMapping(ctx, fixture)
    const after = await mappingSnapshot()
    check(ctx.caseRecord, '临时专属规则删除，既有平台默认映射完全未变',
      JSON.stringify(existing) === JSON.stringify(after), JSON.stringify(after))
  }
}

async function openingReadSnapshot (ctx, fixture) {
  const main = dataOf(await ctx.api.getBusiness(`${fixture.path}/queryById?id=${fixture.id}`))
  const children = dataOf(await ctx.api.postBusiness(`${fixture.path}/selectByMainId`, {
    id: fixture.id, dealingsLogotype: fixture.role
  }))
  const ledger = await openingSnapshot(ctx, fixture.key)
  const links = await database(ctx.caseRecord, 'opening-readonly-links',
    `SELECT partner_id,subject_id,auxiliary_item_id FROM fms_partner_opening_balance
     WHERE tenant_id=1 AND deleted=0 AND account_set_id=${config.fmsAccountSetId}
     AND import_batch_no='${ownedKey(fixture.key)}' ORDER BY partner_id`)
  const initial = await balances(ctx, fixture.role)
  return { main, children, ledger,
    auxiliary: links.map(([id, subject, item]) => [id, subject, item, assistAmount(initial, subject, item)]) }
}

async function openingBrowserFilter (ctx, batch, overrides = {}, absent = false) {
  const query = openingQuery(batch, overrides)
  const page = ctx.page
  await page.getByPlaceholder('期初导入批次号').fill(query.get('importBatchNo'))
  const roleSelect = page.locator('.el-form-item').filter({ hasText: '往来标识' }).locator('.el-select')
  await roleSelect.click()
  await page.locator('.el-select-dropdown:visible').getByText(
    query.get('dealingsLogotype') === 'payable' ? '应付期初' : '应收期初', { exact: true }).click()
  const startInput = page.getByPlaceholder('开始日期')
  const endInput = page.getByPlaceholder('结束日期')
  const targetStart = query.get('billDate_begin').slice(0, 10)
  const targetEnd = query.get('billDate_end').slice(0, 10)
  const currentStart = await startInput.inputValue()
  const currentEnd = await endInput.inputValue()
  const order = openingDateInputOrder(currentStart, currentEnd, targetStart, targetEnd)
  const inputs = { start: startInput, end: endInput }
  const values = { start: targetStart, end: targetEnd }
  for (const field of order) {
    await inputs[field].fill(values[field])
    await inputs[field].press('Tab')
  }
  const actualStart = await startInput.inputValue()
  const actualEnd = await endInput.inputValue()
  const baseInput = page.getByPlaceholder('期初上线基准日')
  await baseInput.fill(query.get('openingBaseDate'))
  await baseInput.press('Tab')
  check(ctx.caseRecord, 'Chrome日期区间最终输入值与本轮查询一致',
    actualStart === targetStart && actualEnd === targetEnd,
    JSON.stringify({ currentStart, currentEnd, order, targetStart, targetEnd, actualStart, actualEnd }))
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'GET' &&
    response.url().includes('/finance/dealingsBeginning/list/dictText'))
  await page.getByRole('button', { name: '查询', exact: true }).click()
  const response = await responsePromise
  const actual = new URL(response.url()).searchParams
  await page.waitForFunction(() => {
    if (document.querySelector('.el-loading-mask')) return false
    const rows = [...document.querySelectorAll('.el-table__row')]
    return rows.length > 0 || !!document.querySelector('.el-table__empty-text')
  }, undefined, { timeout: 30000 })
  const texts = await page.locator('.el-table__row').allInnerTexts()
  const rowsMatch = absent ? texts.length === 0 : texts.length === 1 && texts[0].includes(batch)
  const expected = Object.fromEntries([...query]
    .filter(([key]) => !['pageNo', 'pageSize'].includes(key)))
  const actualFields = Object.fromEntries([...actual]
    .filter(([key]) => Object.hasOwn(expected, key)))
  const queryMatch = Object.entries(expected)
    .every(([key, value]) => actual.get(key) === value)
  check(ctx.caseRecord, 'Chrome筛选实际行数与本轮样本匹配', rowsMatch,
    JSON.stringify({ absent, overrides, expected, actual: actualFields, rows: texts }))
  return rowsMatch && response.ok() && queryMatch
}

async function openingDisplayCase (ctx) {
  const batch = fixtureKey(ctx.caseId)
  const partners = [await partner(ctx, 'receivable', `${batch}-A`),
    await partner(ctx, 'receivable', `${batch}-B`)]
  const fixture = { kind: 'opening', role: 'receivable', key: batch, cleanup: 'PENDING' }
  fixturesOf(ctx).push(fixture)
  {
    const form = new FormData()
    form.append('file', new Blob([await workbook(ctx, 'receivable', partners, batch)]), `${batch}.xlsx`)
    form.append('updateSupport', 'false')
    const imported = dataOf(await ctx.api.uploadBusiness('/finance/dealingsBeginning/import', form))
    check(ctx.caseRecord, 'FMS-007 非空期初批次导入成功',
      imported.successCount === 3 && imported.failureCount === 0, JSON.stringify(imported))
    const filtered = dataOf(await ctx.api.getBusiness(
      `/finance/dealingsBeginning/list?${openingQuery(batch)}`))
    const rows = filtered.records || filtered.list || []
    const bill = rows.find((row) => row.importBatchNo === batch)
    if (!bill) throw new Error('FMS-007 本轮期初主单未回读')
    fixture.id = numericId(bill.id)
    fixture.path = '/finance/dealingsBeginning'
    check(ctx.caseRecord, '四项API筛选必须返回本轮非空唯一期初主单', rows.length === 1 && rows.every((row) =>
      Object.prototype.hasOwnProperty.call(row, 'openingBaseDate') &&
      Object.prototype.hasOwnProperty.call(row, 'importBatchNo') &&
      row.importBatchNo === batch), `过滤批次=${batch}, rows=${rows.length}`)
    const beforeApproval = await openingReadSnapshot(ctx, fixture)
    const missingBalance = dataOf(await ctx.api.postBusiness(`${fixture.path}/openingReconcile`, { id: fixture.id }))
    const afterUnapprovedReconcile = await openingReadSnapshot(ctx, fixture)
    check(ctx.caseRecord, '待审批次对账不隐式审核或汇总到FMS',
      JSON.stringify(beforeApproval) === JSON.stringify(afterUnapprovedReconcile) &&
      beforeApproval.main.billStage === '14' && String(beforeApproval.main.isEffective) === '0' &&
      beforeApproval.children.length === 3 && beforeApproval.children.every((child) =>
        child.billStage === '14' && String(child.isEffective) === '0'),
    JSON.stringify(missingBalance))
    await ctx.api.putBusiness(`${fixture.path}/check`, {
      id: fixture.id, approvalResultType: '1', approvalRemark: batch
    })
    await ctx.api.postBusiness(`${fixture.path}/syncOpening`, { id: fixture.id })
    const expected = new Map([[partners[0].id, '123.45'], [partners[1].id, '67.89']])
    const before = await openingReadSnapshot(ctx, fixture)
    const reconcile = dataOf(await ctx.api.postBusiness(`${fixture.path}/openingReconcile`, { id: fixture.id }))
    check(ctx.caseRecord, '本轮非零期初API对账两个客商、191.34且差异为0',
      reconcileMatches(reconcile, expected), JSON.stringify(reconcile))
    const negatives = [
      { dealingsLogotype: 'payable' }, { openingBaseDate: '2026-10-08' },
      { importBatchNo: `${batch}-ABSENT` },
      { billDate_begin: '2026-10-08 00:00:00', billDate_end: '2026-10-08 23:59:59' }
    ]
    let apiFilters = true
    for (const negative of negatives) {
      const value = dataOf(await ctx.api.getBusiness(`${fixture.path}/list?${openingQuery(batch, negative)}`))
      const excluded = (value.records || value.list || []).length === 0
      apiFilters = excluded && apiFilters
      check(ctx.caseRecord, 'API筛选反例排除本轮已知非空样本', excluded, JSON.stringify(negative))
    }
    await show(ctx, 'erp/finance/dealingsBeginning/index', batch, 'opening-effective-list')
    let browserFilters = await openingBrowserFilter(ctx, batch)
    await saveScreenshot(ctx.page, ctx.outputDir, 'opening-four-filters-positive', ctx.record)
    for (const [index, negative] of negatives.entries()) {
      const matched = await openingBrowserFilter(ctx, batch, negative, true)
      browserFilters = matched && browserFilters
      check(ctx.caseRecord, 'Chrome真实查询参数和空集过滤反例一致', matched, JSON.stringify(negative))
      await saveScreenshot(ctx.page, ctx.outputDir, `opening-filter-negative-${index}`, ctx.record)
    }
    browserFilters = await openingBrowserFilter(ctx, batch) && browserFilters
    certify(ctx, 0, rows.length === 1 && apiFilters && browserFilters,
      'API与Chrome四项正筛选命中本轮主单，各单项错误条件排除样本；空集只用于反例')
    const row = ctx.page.locator('.el-table__row').filter({ hasText: batch })
    await row.waitFor()
    certify(ctx, 1,
      (await ctx.page.locator('.el-table th').allInnerTexts()).some((text) =>
        text.includes('上线基准日')) &&
      (await ctx.page.locator('.el-table th').allInnerTexts()).some((text) =>
        text.includes('导入批次号')), `batch=${batch}`)
    const reconcileButton = row.getByRole('button', { name: 'FMS期初对账', exact: true })
    const syncButton = row.getByRole('button', { name: '汇总到FMS', exact: true })
    certify(ctx, 2, String(before.main.isEffective) === '1' &&
      await syncButton.isVisible() && await reconcileButton.isVisible(),
    `本轮已生效batch=${batch}在Chrome提供两个入口`)
    const syncResponsePromise = ctx.page.waitForResponse((response) =>
      response.url().includes('/finance/dealingsBeginning/syncOpening') &&
      response.request().method() === 'POST')
    await syncButton.click()
    await syncResponsePromise
    await ctx.page.getByText('汇总成功', { exact: true }).waitFor()
    const afterSync = await openingReadSnapshot(ctx, fixture)
    check(ctx.caseRecord, 'Chrome重复汇总不累加本轮台账/辅助余额',
      JSON.stringify(before.ledger) === JSON.stringify(afterSync.ledger) &&
      JSON.stringify(before.auxiliary) === JSON.stringify(afterSync.auxiliary),
    JSON.stringify(afterSync.auxiliary))
    await reconcileButton.click()
    const dialog = ctx.page.locator('.el-dialog:visible').filter({ hasText: 'FMS 期初对账' }).first()
    await dialog.waitFor()
    await dialog.getByText('逐客商一致', { exact: true }).waitFor()
    for (const id of expected.keys()) await dialog.getByText(id, { exact: true }).waitFor()
    const dialogText = await dialog.innerText()
    const dialogRows = dialog.locator('.el-table__row')
    certify(ctx, 3, dialogText.includes(batch) &&
      dialogText.includes('逐客商一致') && await dialogRows.count() === 2 &&
      (dialogText.match(/191\.34/g) || []).length === 2 &&
      await dialog.getByText('一致', { exact: true }).count() === 2 &&
      await dialog.getByText('合计差异', { exact: true }).count() === 1 &&
      [...expected.values()].every((amount) => dialogText.includes(amount)),
    `dialogRows=${await dialogRows.count()}, ${dialogText}`)
    const after = await openingReadSnapshot(ctx, fixture)
    check(ctx.caseRecord, 'API/Chrome对账只读，主子单、FMS台账及本轮辅助余额快照完全相同',
      JSON.stringify(before) === JSON.stringify(afterSync) &&
      JSON.stringify(afterSync) === JSON.stringify(after), JSON.stringify(after))
    defer(ctx, 0, '非零匹配样本已证明API/Chrome对账只读；尚无差异调整受控写侧样本，不把匹配样本外推为差异调整验收', true)
    await saveScreenshot(ctx.page, ctx.outputDir, 'opening-reconcile-non-empty', ctx.record)
    ctx.caseRecord.evidence.push('非空期初批次、筛选列表、Chrome 对账弹窗逐客商与合计')
  }
}

async function cleanMapping (ctx, fixture) {
  if (fixture.cleanup === 'CLEANED_API') return
  const detail = dataOf(await ctx.api.getBusiness(
    `/fms/config/event-mapping/get?id=${encodeURIComponent(fixture.id)}`))
  if (detail?.accountSetId !== config.fmsAccountSetId ||
      detail.eventType !== fixture.eventType || !detail.remark?.startsWith(`${ownedKey(fixture.key)} `)) {
    throw new Error('映射夹具所有权不符，不能删除既有规则')
  }
  await ctx.api.deleteBusiness(
    `/fms/config/event-mapping/delete?id=${encodeURIComponent(fixture.id)}&accountSetId=${config.fmsAccountSetId}`)
  const value = dataOf(await ctx.api.getBusiness(
    `/fms/config/event-mapping/page?pageNo=1&pageSize=100&accountSetId=${config.fmsAccountSetId}&eventType=${fixture.eventType}`))
  if ((value.list || []).some((row) => row.id === fixture.id)) throw new Error('映射夹具删除后仍可查询')
  fixture.cleanup = 'CLEANED_API'
}

async function cleanup (ctx) {
  for (const fixture of [...fixturesOf(ctx)].reverse()) {
    if (fixture.cleanup?.startsWith('RETAINED') || fixture.cleanup?.startsWith('CLEANED')) continue
    try {
      if (fixture.kind === 'event-mapping') {
        await cleanMapping(ctx, fixture)
      } else if (fixture.kind === 'opening') {
        if (!fixture.id) {
          fixture.cleanup = 'RETAINED: 导入失败，无已回读主单ID；需按批次核查'
          continue
        }
        const bill = dataOf(await ctx.api.getBusiness(`${fixture.path}/queryById?id=${fixture.id}`))
        if (bill?.importBatchNo !== fixture.key) throw new Error('期初所有权不符')
        if (bill.billStage.startsWith('3')) await ctx.api.putBusiness(`${fixture.path}/void`, { id: fixture.id })
        await ctx.api.deleteBusiness(`${fixture.path}/delete?id=${fixture.id}`)
        const rows = await database(ctx.caseRecord, 'opening-cleanup',
          `SELECT id FROM dealings_beginning WHERE tenant_id=1 AND id='${numericId(fixture.id)}'`)
        if (rows.length) throw new Error('期初主单删除后仍存在')
        fixture.cleanup = 'CLEANED_API: 期初主单/子单删除；REVERSED FMS台账/辅助项目保留审计'
      } else if (['receipt', 'payment'].includes(fixture.kind)) {
        // Successful cash facts and emitted events are retained rather than changing accounting facts to hide them.
        fixture.cleanup = 'RETAINED_AUDIT: 已执行收付款/事件，未伪造退款或删除事实'
      } else if (fixture.kind === 'account') {
        const refs = await database(ctx.caseRecord, 'account-cleanup-references',
          `SELECT COUNT(*) FROM fin_receipt WHERE tenant_id=1 AND bank_account_id='${numericId(fixture.id)}';
           SELECT COUNT(*) FROM fin_payment WHERE tenant_id=1 AND bank_account_id='${fixture.id}'`)
        if (refs.some((row) => Number(row[0]) > 0)) {
          fixture.cleanup = 'RETAINED_REFERENCE: 本轮已执行来源单引用'
        } else {
          const detail = dataOf(await ctx.api.getBusiness(`/erp/account/get?id=${fixture.id}`))
          if (detail.no !== fixture.key || detail.remark !== fixture.key) throw new Error('账户所有权不符')
          await ctx.api.deleteBusiness(`/erp/account/delete?id=${fixture.id}`)
          fixture.cleanup = 'CLEANED_API'
        }
      } else if (fixture.kind === 'partner') {
        const refs = await database(ctx.caseRecord, 'partner-cleanup-references',
          `SELECT COUNT(*) FROM fin_receipt WHERE tenant_id=1 AND customer_id='${numericId(fixture.id)}';
           SELECT COUNT(*) FROM fin_payment WHERE tenant_id=1 AND supplier_id='${fixture.id}';
           SELECT COUNT(*) FROM fin_receivable WHERE tenant_id=1 AND customer_id='${fixture.id}';
           SELECT COUNT(*) FROM fin_payable WHERE tenant_id=1 AND supplier_id='${fixture.id}'`)
        if (refs.some((row) => Number(row[0]) > 0)) {
          fixture.cleanup = 'RETAINED_REFERENCE: 本轮来源单引用'
        } else {
          const detail = dataOf(await ctx.api.getBusiness(`/base/partner/get?id=${fixture.id}`))
          if (detail.name !== fixture.name) throw new Error('客商所有权不符')
          await ctx.api.deleteBusiness(`/base/partner/delete?id=${fixture.id}`)
          fixture.cleanup = 'CLEANED_API'
        }
      }
    } catch (error) {
      fixture.cleanup = `RETAINED_ERROR: ${error.message}`
      check(ctx.caseRecord, '本轮自建夹具受控清理成功', false, `${fixture.kind}:${fixture.id}: ${error.message}`)
    }
  }
}

export async function runOwnedCase (ctx) {
  const token = await login(ctx.page, { returnContext: true })
  if (token.tenantId !== '1') throw new Error('BLOCKED: Chrome 登录返回租户非1')
  ctx.api = createApiClient({ token: token.token, tenantId: token.tenantId, record: ctx.record })
  await preflight(ctx.api, ctx.caseRecord)
  if (ctx.caseId === 'FMS-004') {
    await fms004ClosureCase(ctx)
    return catalogResult(ctx.caseRecord, definitions.find((item) => item.id === ctx.caseId))
  }
  try {
    const functions = { 'FMS-001': sourceCase, 'FMS-002': costCase,
      'FMS-003': confirmationCase, 'FMS-005': openingCase,
      'FMS-006': mappingCase, 'FMS-007': openingDisplayCase }
    await functions[ctx.caseId](ctx)
    ctx.caseRecord.evidence.push('本轮真实 API、租户隔离只读 DB 快照、headed Chrome 截图与 trace')
  } finally {
    await cleanup(ctx)
  }
  return catalogResult(ctx.caseRecord, definitions.find((item) => item.id === ctx.caseId))
}
