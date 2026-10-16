import { readFileSync } from 'node:fs'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { openRoute, saveScreenshot, waitForPageReady } from '../lib/browser.mjs'
import { decryptResponse } from '../lib/crypto.mjs'
import { findMenuRouteByComponent } from '../suites/base-partner.mjs'
import {
  assertEnvironment, balancedDraft, check, dataOf, database, money, numericId, proof
} from '../fmshelper/contracts.mjs'

const month = '2026-10'
const billDate = '2026-10-07'
const empty = (value) => value == null || value === '' || value === 'NULL'
const requireEvidence = (record, name, passed, details = '') => {
  if (!check(record, name, passed, details)) throw new Error(`${name}：${details}`)
}
const responseData = (response, label) => dataOf(assertBusinessSuccess(response, label))

export function assertFms004WriteScope (settings = config, writeFlag = process.env.CFOR_E2E_WRITE_FIXTURES) {
  assertEnvironment(settings)
  if (writeFlag !== 'true') throw new Error('BLOCKED: FMS-004 需要 CFOR_E2E_WRITE_FIXTURES=true')
  if (!['127.0.0.1', 'localhost', '::1'].includes(settings.db.host) ||
      String(settings.db.port) !== '3306') {
    throw new Error('BLOCKED: FMS-004 数据库必须为本地 3306/cfor_admin_standard')
  }
}

export async function readFms004Context (api, caseRecord, stage, { read = database } = {}) {
  const accountSetId = numericId(config.fmsAccountSetId)
  const sets = responseData(await api.getBusiness('/fms/config/account-set/list'), 'FMS-004 账套')
  const own = Array.isArray(sets) && sets.find((row) => String(row.id) === accountSetId)
  if (!own?.initialized || ![1, 2].includes(own.level)) {
    throw new Error('BLOCKED: FMS-004 专属验收账套未初始化或没有写权限')
  }
  // Publishers resolve an omitted accountSetId. A second tenant1 account would
  // make that resolution unsafe, even if the caller could read both accounts.
  const accounts = await read(caseRecord, `fms004-account-${stage}`,
    `SELECT id,company_code,company_name,initialized+0,DATE_FORMAT(start_time,'%Y-%m-%d')
     FROM fms_account_set WHERE tenant_id=1 AND deleted=0 ORDER BY id`)
  if (accounts.length !== 1 || accounts[0][0] !== accountSetId ||
      !/^E2E/.test(accounts[0][1]) || accounts[0][3] !== '1' ||
      accounts[0][4] > billDate || !/^\d{4}-\d{2}-\d{2}$/.test(accounts[0][4])) {
    throw new Error('BLOCKED: FMS-004 唯一 E2E 验收账套、初始化或启用日期不符')
  }
  const currentMonth = responseData(await api.getBusiness(
    `/fms/closing/period/current-month?accountSetId=${accountSetId}`), 'FMS-004 当前期间')
  const periods = await read(caseRecord, `fms004-period-${stage}`,
    `SELECT id,DATE_FORMAT(closing_time,'%Y-%m-%d %H:%i:%s')
     FROM fms_closing_period WHERE tenant_id=1 AND deleted=0
       AND account_set_id='${accountSetId}' ORDER BY id`)
  if (currentMonth !== month || periods.some((row) =>
    !/^\d{4}-\d{2}/.test(row[1]) || row[1].slice(0, 7) >= month)) {
    throw new Error('BLOCKED: FMS-004 来源日期不在开放的 2026-10，禁止结账或改期间')
  }
  check(caseRecord, 'FMS-004 专属账套与开放期间 API/SQL 一致', true,
    `stage=${stage} accountSetId=${accountSetId} companyCode=${accounts[0][1]} month=${currentMonth}`)
  // The existing final-context read is also the fail-closed acceptance boundary.
  if (stage === 'after') finalizeFms004CashReversalEvidence(caseRecord)
  return { accountSetId, month: currentMonth, accounts, periods }
}

const voucherValue = (row) => [
  numericId(row.id), String(row.status), empty(row.sourceDraftId) ? null : numericId(row.sourceDraftId),
  money(row.debitAmount), money(row.creditAmount), money(row.total)
]

export async function readFms004FormalVouchers (api, caseRecord, stage, { read = database } = {}) {
  const accountSetId = numericId(config.fmsAccountSetId)
  const rows = []
  let total
  for (let pageNo = 1; ; pageNo++) {
    const query = new URLSearchParams({ accountSetId, pageNo: String(pageNo), pageSize: '100' })
    const page = responseData(await api.getBusiness(`/fms/voucher/page?${query}`), 'FMS-004 正式凭证')
    if (!Array.isArray(page?.list) || !Number.isSafeInteger(Number(page.total)) ||
        Number(page.total) < 0 || (total !== undefined && total !== Number(page.total)) ||
        page.list.some((row) => String(row.accountSetId) !== accountSetId)) {
      throw new Error('FMS-004 正式凭证分页结构、账套或总数不一致')
    }
    total = Number(page.total)
    rows.push(...page.list)
    if (rows.length === total) break
    if (page.list.length !== 100 || rows.length > total || pageNo >= 100) {
      throw new Error('FMS-004 正式凭证分页不完整，拒绝以首屏代替全量快照')
    }
  }
  const formal = await read(caseRecord, `fms004-formal-${stage}`,
    `SELECT id,status,source_draft_id,debit_amount,credit_amount,total FROM fms_voucher
     WHERE tenant_id=1 AND deleted=0 AND account_set_id='${accountSetId}' ORDER BY id`)
  const apiRows = rows.map(voucherValue).sort((a, b) => a[0].localeCompare(b[0]))
  const sqlRows = formal.map(([id, status, sourceDraftId, debitAmount, creditAmount, total]) =>
    voucherValue({ id, status, sourceDraftId, debitAmount, creditAmount, total }))
    .sort((a, b) => a[0].localeCompare(b[0]))
  requireEvidence(caseRecord, 'FMS-004 正式凭证 API/SQL 精确一致',
    new Set(apiRows.map((row) => row[0])).size === total &&
    JSON.stringify(apiRows) === JSON.stringify(sqlRows), `stage=${stage} vouchers=${total}`)
  return apiRows
}

function assertCashDraft (draft, cash, withEntries = true, expectedStatus = 'DRAFT') {
  const event = cash.event
  if (!['DRAFT', 'CANCELLED'].includes(expectedStatus) || event.processStatus !== 'DRAFTED' ||
      !draft || numericId(draft.id) !== numericId(event.draftId) ||
      numericId(draft.inboxId) !== numericId(event.id) ||
      String(draft.accountSetId) !== String(config.fmsAccountSetId) ||
      draft.sourceSystem !== 'ERP' || draft.eventType !== event.eventType ||
      draft.sourceBillType !== event.sourceBillType ||
      String(draft.sourceBillId) !== String(event.sourceBillId) ||
      draft.bizDate !== billDate || !draft.draftNo ||
      draft.status !== expectedStatus || !empty(draft.voucherId) ||
      (expectedStatus === 'CANCELLED' && (empty(draft.cancelledBy) || empty(draft.cancelledTime))) ||
      !empty(draft.confirmedBy) || !empty(draft.confirmedTime) ||
      !empty(draft.postedBy) || !empty(draft.postedTime) ||
      money(draft.debitTotal) !== 12345 || money(draft.creditTotal) !== 12345 ||
      (withEntries && (!balancedDraft(draft, '123.45') ||
        new Set(draft.entries.map((entry) => numericId(entry.id))).size !== draft.entries.length ||
        new Set(draft.entries.map((entry) => entry.lineNo)).size !== draft.entries.length ||
        draft.entries.some((entry) => !Number.isSafeInteger(entry.lineNo) || entry.lineNo <= 0 ||
          !entry.accountCode || !['DEBIT', 'CREDIT'].includes(entry.direction) ||
          money(entry.amount) <= 0)))) {
    throw new Error('FMS-004 现金草稿身份、日期、金额或未确认/未过账状态不符')
  }
  return draft
}

const entriesValue = (entries) => entries.map((row) => [
  numericId(row.id), Number(row.lineNo), row.accountCode, row.direction, money(row.amount)
]).sort((a, b) => a[1] - b[1])

export async function readFms004CashDraft (api, caseRecord, source,
  { read = database, direction = 'FORWARD' } = {}) {
  const { cash, role } = source
  const expectedType = role === 'receivable' ? 'FinReceipt' : 'FinPayment'
  const expectedEvent = role === 'receivable' ? 'ERP_RECEIPT_ARRIVED' : 'ERP_PAYMENT_DISBURSED'
  if (!['receivable', 'payable'].includes(role) || !['FORWARD', 'REVERSE'].includes(direction) ||
      cash.event.sourceSystem !== 'ERP' || cash.event.sourceBillType !== expectedType ||
      cash.event.eventType !== expectedEvent || cash.event.direction !== direction) {
    throw new Error('FMS-004 必须使用真实收款到账/付款出账事件，不得用核销事件替代')
  }
  const stage = direction === 'REVERSE' ? 'cash-reverse' : 'cash'
  const id = numericId(cash.event.draftId)
  const draft = assertCashDraft(responseData(await api.getBusiness(
    `/fms/voucher-draft/get?id=${id}`), 'FMS-004 现金草稿详情'), cash)
  // A cash bill also emits a confirmation event; identify the arrived/disbursed
  // draft by number and independently reject duplicate cash events in SQL.
  const query = new URLSearchParams({ pageNo: '1', pageSize: '100', sourceSystem: 'ERP',
    sourceBillType: expectedType, sourceBillId: numericId(cash.event.sourceBillId),
    draftNo: draft.draftNo })
  const page = responseData(await api.getBusiness(
    `/fms/voucher-draft/page?${query}`), 'FMS-004 来源草稿精确分页')
  if (!Array.isArray(page?.list) || Number(page.total) !== 1 || page.list.length !== 1) {
    throw new Error('FMS-004 来源现金单没有返回唯一草稿')
  }
  const listed = assertCashDraft(page.list[0], cash, false)
  if (listed.id !== draft.id || listed.draftNo !== draft.draftNo) {
    throw new Error('FMS-004 草稿详情与分页身份不一致')
  }
  const sourceRows = await read(caseRecord, `fms004-${role}-${stage}-source-drafts`,
    `SELECT id,event_type,source_bill_type,source_bill_id,draft_no
     FROM fms_voucher_draft
     WHERE tenant_id=1 AND deleted=0 AND source_system='ERP'
       AND event_type='${expectedEvent}' AND source_bill_type='${expectedType}'
       AND source_bill_id='${numericId(cash.event.sourceBillId)}'
       AND draft_no='${draft.draftNo}' ORDER BY id`)
  requireEvidence(caseRecord, `FMS-004 ${role} 现金事件来源草稿唯一`,
    sourceRows.length === 1 &&
    sourceRows[0][0] === id &&
    sourceRows[0][1] === expectedEvent &&
    sourceRows[0][2] === expectedType &&
    sourceRows[0][3] === numericId(cash.event.sourceBillId) &&
    sourceRows[0][4] === draft.draftNo,
    `sourceBillId=${draft.sourceBillId} eventType=${expectedEvent} draftId=${id}`)
  const sql = await read(caseRecord, `fms004-${role}-${stage}-draft`,
    `SELECT id,inbox_id,account_set_id,status,biz_date,debit_total,credit_total,
            confirmed_by,confirmed_time,voucher_id,posted_by,posted_time
     FROM fms_voucher_draft WHERE tenant_id=1 AND deleted=0 AND id='${id}'`)
  const row = sql[0]
  requireEvidence(caseRecord, `FMS-004 ${role} 草稿 API/SQL 无确认和过账`,
    sql.length === 1 && row.length === 12 && row[0] === id && row[1] === String(draft.inboxId) &&
    row[2] === String(draft.accountSetId) && row[3] === 'DRAFT' && row[4] === billDate &&
    money(row[5]) === 12345 && money(row[6]) === 12345 && row.slice(7).every(empty),
    `sourceBillId=${draft.sourceBillId} inboxId=${draft.inboxId} draftId=${id}`)
  const entries = await read(caseRecord, `fms004-${role}-${stage}-entries`,
    `SELECT e.id,e.line_no,e.account_code,e.direction,e.amount FROM fms_voucher_draft_entry e
     JOIN fms_voucher_draft d ON d.id=e.draft_id AND d.tenant_id=e.tenant_id
     WHERE e.tenant_id=1 AND e.deleted=0 AND d.deleted=0
       AND d.account_set_id='${numericId(draft.accountSetId)}' AND d.id='${id}' ORDER BY e.line_no,e.id`)
  requireEvidence(caseRecord, `FMS-004 ${role} 草稿分录 API/SQL 精确一致`,
    entries.length >= 2 && entries.every((entry) => entry.length === 5) &&
    JSON.stringify(entriesValue(draft.entries)) === JSON.stringify(entriesValue(
      entries.map(([id, lineNo, accountCode, direction, amount]) =>
        ({ id, lineNo, accountCode, direction, amount })))),
    `draftId=${id} entries=${entries.length}`)
  const vouchers = await read(caseRecord, `fms004-${role}-${stage}-no-formal-voucher`,
    `SELECT id,source_draft_id FROM fms_voucher WHERE tenant_id=1 AND deleted=0
       AND account_set_id='${numericId(draft.accountSetId)}' AND source_draft_id='${id}'`)
  requireEvidence(caseRecord, `FMS-004 ${role} 草稿没有正式凭证`,
    vouchers.length === 0, `draftId=${id} formalVouchers=${vouchers.length}`)
  return draft
}

export function assertFms004CashRevision (previous, next) {
  for (const key of ['sourceSystem', 'eventType', 'sourceBillType', 'sourceBillId', 'direction']) {
    if (previous.event[key] !== next.event[key]) throw new Error('重执行必须核对同一现金来源正向事件')
  }
  if (next.event.direction !== 'FORWARD' || empty(next.event.sourceVersion) ||
      next.event.sourceVersion === previous.event.sourceVersion ||
      next.payload.sourceVersion !== next.event.sourceVersion ||
      next.event.sourceEventId === previous.event.sourceEventId ||
      next.payload.sourceEventId !== next.event.sourceEventId ||
      numericId(next.outboxId) === numericId(previous.outboxId) ||
      numericId(next.event.id) === numericId(previous.event.id) ||
      numericId(next.event.draftId) === numericId(previous.event.draftId)) {
    throw new Error('作废后重执行未升 sourceVersion，或错误复用旧 outbox/inbox/草稿')
  }
  assertCashDraft(next.draft, next)
  return true
}

export function assessFms004CashReversalEvidence (source) {
  const { role, cash, cashReverse: reverse, originalDraftAfterReversal: original } = source
  const defects = []
  const gaps = []
  const expect = (condition, reason) => { if (!condition) defects.push(reason) }
  let eventRegistered = false
  let accountingDraftVerified = false
  let originalDraftCancelled = false
  let sourceRevisionVerified = null
  try {
    const expectedType = role === 'receivable' ? 'FinReceipt' : 'FinPayment'
    const expectedEvent = role === 'receivable' ? 'ERP_RECEIPT_ARRIVED' : 'ERP_PAYMENT_DISBURSED'
    expect(['receivable', 'payable'].includes(role), '现金来源角色无效')
    for (const [delivery, direction] of [[cash, 'FORWARD'], [reverse, 'REVERSE']]) {
      const event = delivery.event
      const payload = delivery.payload
      numericId(delivery.outboxId)
      numericId(event.id)
      expect(event.sourceSystem === 'ERP' && event.sourceBillType === expectedType &&
        event.eventType === expectedEvent && event.direction === direction, '现金事件来源或方向不符')
      for (const key of ['sourceEventId', 'sourceSystem', 'eventType', 'sourceBillType',
        'sourceBillId', 'sourceVersion', 'direction']) {
        expect(!empty(event[key]) && event[key] === payload[key], `事件与载荷 ${key} 不一致`)
      }
      expect(String(payload.accountSetId) === String(config.fmsAccountSetId), '事件账套不符')
      expect(delivery.duplicate?.duplicated === true &&
        delivery.duplicate.id === event.id &&
        (empty(event.draftId) ? empty(delivery.duplicate.draftId)
          : delivery.duplicate.draftId === event.draftId), '事件重投未精确复用 inbox/草稿')
    }
    expect(numericId(cash.event.sourceBillId) === numericId(reverse.event.sourceBillId) &&
      cash.event.sourceVersion === reverse.event.sourceVersion, '反向未引用相同来源版本')
    expect(cash.event.id !== reverse.event.id && cash.outboxId !== reverse.outboxId &&
      cash.event.sourceEventId !== reverse.event.sourceEventId, '正反向事件未独立登记')
    expect(reverse.event.reversalOfEventId === cash.event.sourceEventId &&
      reverse.payload.reversalOfEventId === cash.event.sourceEventId, '反向事件引用错误')
    eventRegistered = defects.length === 0
    const forwardReady = cash.event.processStatus === 'DRAFTED' && !empty(cash.event.draftId)
    if (forwardReady) assertCashDraft(cash.draft, cash)
    else gaps.push('正向事件未形成草稿；PENDING/无 draft 仅为事件登记证据')
    if (reverse.event.processStatus === 'DRAFTED' || !empty(reverse.event.draftId) || reverse.draft) {
      expect(forwardReady, '正向尚未生成草稿，反向却已生成会计草稿')
      assertCashDraft(reverse.draft, reverse)
      expect(reverse.draft.id !== cash.draft?.id, '反向复用了正向草稿')
      if (forwardReady) {
        const effects = (entries, flip = false) => entries.map((entry) => JSON.stringify([
          entry.accountCode, flip ? (entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT') : entry.direction,
          money(entry.amount), entry.auxiliaryType ?? null, entry.auxiliaryCode ?? null
        ])).sort()
        expect(JSON.stringify(effects(cash.draft.entries, true)) ===
          JSON.stringify(effects(reverse.draft.entries)), '反向科目、辅助核算、金额或借贷方向未精确抵消正向')
      }
      accountingDraftVerified = forwardReady && defects.length === 0
    } else {
      expect(reverse.event.processStatus === 'PENDING', '反向未处于可解释的待处理状态')
      gaps.push('反向事件已登记但无反向草稿，不能宣称反向会计草稿闭环')
    }
    if (forwardReady) {
      if (!original) gaps.push('缺少作废后的原草稿回读，未验证原草稿按来源版本取消')
      else {
        expect(original.id === cash.draft.id && original.inboxId === cash.draft.inboxId &&
          original.accountSetId === cash.draft.accountSetId &&
          original.sourceBillId === cash.draft.sourceBillId &&
          original.sourceBillType === cash.draft.sourceBillType &&
          original.eventType === cash.draft.eventType, '作废后回读的原草稿身份不符')
        // ADR 3.5 already requires cancellation of an unconfirmed source draft.
        expect(original.status === 'CANCELLED', '来源已作废，未确认原草稿仍未取消（ADR 3.5）')
        expect(!empty(original.cancelledBy) && !empty(original.cancelledTime), '原草稿取消缺少审计')
        expect(['confirmedBy', 'confirmedTime', 'postedBy', 'postedTime', 'voucherId']
          .every((field) => empty(original[field])), '原草稿被隐式确认或过账')
        expect(JSON.stringify(entriesValue(original.entries)) ===
          JSON.stringify(entriesValue(cash.draft.entries)), '取消原草稿改写或丢失分录审计')
        originalDraftCancelled = defects.length === 0
      }
    }
    if (source.reexecutedCash) {
      sourceRevisionVerified = assertFms004CashRevision(cash, source.reexecutedCash)
    }
  } catch (error) {
    defects.push(`现金反向证据结构无效：${error.message}`)
  }
  return { role, sourceBillId: cash?.event?.sourceBillId, eventRegistered,
    accountingDraftVerified, originalDraftCancelled, sourceRevisionVerified, defects, gaps,
    status: defects.length ? 'FAIL' : gaps.length ? 'PARTIAL' : 'PASS' }
}

export async function readFms004CashReversalEvidence (api, caseRecord, source, { read = database } = {}) {
  const cashReverse = { ...source.cashReverse }
  if (cashReverse.event?.processStatus === 'DRAFTED' || !empty(cashReverse.event?.draftId)) {
    cashReverse.draft = await readFms004CashDraft(api, caseRecord,
      { role: source.role, cash: cashReverse }, { read, direction: 'REVERSE' })
  }
  const original = empty(source.cash.event.draftId) ? null : responseData(await api.getBusiness(
    `/fms/voucher-draft/get?id=${numericId(source.cash.event.draftId)}`), 'FMS-004 作废后原草稿')
  if (original) {
    const rows = await read(caseRecord, `fms004-${source.role}-original-after-reversal`,
      `SELECT id,status,cancelled_by,DATE_FORMAT(cancelled_time,'%Y-%m-%d %H:%i:%s')
       FROM fms_voucher_draft
       WHERE tenant_id=1 AND deleted=0 AND account_set_id='${numericId(config.fmsAccountSetId)}'
         AND id='${numericId(source.cash.event.draftId)}'`)
    requireEvidence(caseRecord, `FMS-004 ${source.role} 作废后原草稿状态 API/SQL 一致`,
      rows.length === 1 && rows[0].length === 4 && rows[0][0] === original.id &&
      rows[0][1] === original.status && (empty(rows[0][2]) ? empty(original.cancelledBy)
        : rows[0][2] === String(original.cancelledBy)) &&
      (empty(rows[0][3]) ? empty(original.cancelledTime)
        : rows[0][3].replace('T', ' ') === String(original.cancelledTime).replace('T', ' ')),
      `draftId=${original.id} status=${original.status}`)
  }
  if (source.reexecutedCash) {
    await readFms004CashDraft(api, caseRecord,
      { role: source.role, cash: source.reexecutedCash }, { read })
  }
  const evidence = assessFms004CashReversalEvidence({
    ...source, cashReverse, originalDraftAfterReversal: original
  })
  caseRecord.fms004CashReversalEvidence ||= []
  caseRecord.fms004CashReversalEvidence.push(evidence)
  return evidence
}

export function finalizeFms004CashReversalEvidence (caseRecord) {
  const definition = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
    .suites.flatMap((suite) => suite.cases).find((item) => item.id === 'FMS-004')
  const draftAssertion = definition.assertions[2]
  const reverseAssertion = definition.reverse[0]
  const results = caseRecord.fms004CashReversalEvidence || []
  const complete = results.length === 2 &&
    new Set(results.map((item) => item.role)).size === 2 &&
    results.some((item) => item.role === 'receivable') && results.some((item) => item.role === 'payable') &&
    new Set(results.map((item) => numericId(item.sourceBillId))).size === 2
  const gap = (assertion, reason) => {
    caseRecord.catalogEvidence ||= {}
    const prior = caseRecord.catalogEvidence[assertion]
    if (prior?.status !== 'FAIL') {
      caseRecord.catalogEvidence[assertion] = { status: 'UNVERIFIED',
        evidence: [prior?.evidence, reason].filter(Boolean).join('; ') }
    }
    caseRecord.notes ||= []
    caseRecord.notes.push(`${assertion}：${reason}`)
    caseRecord.passCandidate = false
  }
  const details = JSON.stringify(results)
  if (results.some((item) => item.sourceRevisionVerified == null)) {
    caseRecord.notes ||= []
    caseRecord.notes.push('原载荷重放不等于作废后重执行；本轮未验证新 sourceVersion，不宣称跨版本幂等已通过')
  }
  if (!complete) {
    gap(reverseAssertion, '缺少收款/付款各一份严格反向证据；旧 PASS/空集合不能代替门禁')
    gap(draftAssertion, '尚未验证反向草稿及未确认原草稿取消；不能宣称会计闭环')
  } else {
    proof(caseRecord, reverseAssertion, results.every((item) => item.eventRegistered), details)
  }
  if (results.some((item) => item.status === 'FAIL')) {
    proof(caseRecord, draftAssertion, false, details)
  } else if (complete && results.every((item) => item.status === 'PASS' &&
    item.accountingDraftVerified && item.originalDraftCancelled)) {
    proof(caseRecord, draftAssertion, true, details)
  } else if (complete) gap(draftAssertion, details)
  return { partial: !complete || results.some((item) => item.status !== 'PASS' ||
    !item.eventRegistered || !item.accountingDraftVerified || !item.originalDraftCancelled) ||
    caseRecord.catalogEvidence[draftAssertion]?.status !== 'PASS' ||
    caseRecord.catalogEvidence[reverseAssertion]?.status !== 'PASS', results }
}

async function browserData (response) {
  if (!response.ok()) throw new Error(`FMS-004 浏览器 API HTTP ${response.status()}`)
  const raw = await response.text()
  const value = response.headers()['x-api-encrypt'] === 'true' ? decryptResponse(raw) : JSON.parse(raw)
  return responseData(value, 'FMS-004 浏览器草稿')
}

export async function showFms004CashDraft ({ api, caseRecord, page, record, outputDir }, source,
  { navigate = openRoute, screenshot = saveScreenshot, status = 'DRAFT' } = {}) {
  if (!page || !outputDir) throw new Error('FMS-004 草稿 UI 取证需要真实浏览器和证据目录')
  const { cash, role } = source
  const draft = assertCashDraft(status === 'CANCELLED'
    ? responseData(await api.getBusiness(
      `/fms/voucher-draft/get?id=${numericId(cash.draft.id)}`), 'FMS-004 已取消草稿')
    : cash.draft, cash, true, status)
  const statusText = status === 'CANCELLED' ? '已取消' : '草稿'
  const stage = status === 'CANCELLED' ? '已取消现金草稿' : '本轮未确认现金草稿'
  const permission = responseData(await api.getPermissionInfo(), 'FMS-004 页面菜单')
  const route = findMenuRouteByComponent(permission.menus, 'fms/voucherDraft/index')
  if (!route) throw new Error('BLOCKED: FMS-004 权限菜单缺少凭证草稿页面')
  await navigate(page, route, { readySelector: 'input[placeholder="请输入草稿编号"]', readyTimeoutMs: 90000 })
  await page.getByPlaceholder('请输入草稿编号').fill(draft.draftNo)
  const response = page.waitForResponse((res) => {
    const url = new URL(res.url())
    return res.request().method() === 'GET' && url.pathname.endsWith('/fms/voucher-draft/page') &&
      url.searchParams.get('draftNo') === draft.draftNo
  })
  const [listResponse] = await Promise.all([
    response, page.getByRole('button', { name: '搜索', exact: true }).click()
  ])
  const list = await browserData(listResponse)
  if (!Array.isArray(list?.list) || Number(list.total) !== 1 || list.list.length !== 1) {
    throw new Error('FMS-004 浏览器精确草稿搜索未返回唯一行')
  }
  assertCashDraft(list.list[0], cash, false, status)
  await waitForPageReady(page)
  const row = page.locator('.el-table__row').filter({ hasText: draft.draftNo })
  await row.waitFor({ state: 'visible' })
  const text = await row.innerText()
  requireEvidence(caseRecord, `FMS-004 ${role} Chrome 显示${stage}`,
    await row.count() === 1 && text.includes(draft.eventType) &&
    text.includes(draft.sourceBillId) && text.includes('123.45') &&
    await row.locator('.el-tag').filter({ hasText: new RegExp(`^${statusText}$`) }).count() === 1 &&
    (status !== 'CANCELLED' || await row.getByRole('button', { name: /确认/ }).count() === 0),
    `draftId=${draft.id} sourceBillId=${draft.sourceBillId}`)
  const detailResponse = page.waitForResponse((res) => {
    const url = new URL(res.url())
    return res.request().method() === 'GET' && url.pathname.endsWith('/fms/voucher-draft/get') &&
      url.searchParams.get('id') === draft.id
  })
  const [detailResult] = await Promise.all([
    detailResponse, row.getByRole('button', { name: '详情', exact: true }).click()
  ])
  const detail = assertCashDraft(await browserData(detailResult), cash, true, status)
  const drawer = page.locator('.el-drawer:visible').filter({ hasText: '凭证草稿详情' })
  await drawer.waitFor({ state: 'visible' })
  const detailText = await drawer.innerText()
  const lines = await drawer.locator('.el-table__row').allInnerTexts()
  requireEvidence(caseRecord, `FMS-004 ${role} Chrome ${status === 'CANCELLED' ? '已取消' : ''}详情分录与真实草稿一致`,
    detailText.includes(draft.draftNo) && detailText.includes(draft.eventType) &&
    detailText.includes(billDate) && detailText.includes(statusText) &&
    lines.length === detail.entries.length &&
    detail.entries.every((entry) => lines.some((line) =>
      line.includes(entry.accountCode) && line.includes(entry.direction === 'DEBIT' ? '借' : '贷') &&
      line.includes(String(entry.amount)))),
    `draftId=${draft.id} entries=${lines.length}`)
  if (status === 'CANCELLED') {
    requireEvidence(caseRecord, `FMS-004 ${role} Chrome 取消审计与真实草稿一致`,
      detailText.includes('取消人') && detailText.includes('取消时间') &&
      detailText.includes(String(detail.cancelledBy)) &&
      detailText.includes(String(detail.cancelledTime)) &&
      detailText.includes(detail.cancelRemark),
      `draftId=${draft.id}; cancelledTime=${detail.cancelledTime}`)
  }
  await screenshot(page, outputDir, `fms004-${role}-cash-${status === 'CANCELLED' ? 'cancelled-' : ''}draft-detail`, record)
  await drawer.locator('.el-drawer__close-btn').click()
  await drawer.waitFor({ state: 'hidden' })
  const unchanged = responseData(await api.getBusiness(
    `/fms/voucher-draft/get?id=${numericId(draft.id)}`), 'FMS-004 UI 后草稿回读')
  requireEvidence(caseRecord, `FMS-004 ${role} UI 只读不确认、不改分录`,
    JSON.stringify(unchanged) === JSON.stringify(draft), `draftId=${draft.id}`)
}
