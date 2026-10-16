import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'

export const ownedCases = [
  'FMS-001', 'FMS-002', 'FMS-003', 'FMS-004', 'FMS-005', 'FMS-006', 'FMS-007'
]
export const dataOf = (response) => response?.data ?? response
export const fixtureKey = (caseId) =>
  `E2E-FMS-${caseId}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`

export function assertEnvironment (environment = config) {
  if (environment.target !== 'local' || environment.tenantId !== '1' ||
      environment.tenantName !== 'CFOR 标准平台' ||
      environment.fmsAccountSetId !== '2107455388355596289' ||
      environment.db.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: FMS 写侧仅授权本地 tenant1 专属验收账套')
  }
  for (const [base, port] of [[environment.webBase, '9151'], [environment.apiBase, '48083']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== port) {
      throw new Error('BLOCKED: FMS 写侧端点不属于本轮授权本地环境')
    }
  }
}

export function money (value) {
  const text = String(value ?? '')
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`无效金额：${text}`)
  const negative = text.startsWith('-')
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new Error('金额超出安全精度')
  return negative ? -cents : cents
}

export const numericId = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('ID 已丢失精度')
  }
  if (!/^\d+$/.test(String(value))) throw new Error('无效单据 ID')
  return String(value)
}

export const ownedKey = (value) => {
  if (!/^E2E-FMS-[A-Z0-9-]+$/.test(value || '')) throw new Error('非本组 E2E-FMS 夹具')
  return value
}

export function check (caseRecord, name, passed, details = '') {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  return Boolean(passed)
}

// Only evidence explicitly assigned to a catalog assertion can complete it.
export function catalogResult (caseRecord, definition) {
  const proofs = caseRecord.catalogEvidence || {}
  const row = (assertion, index) => ({
    index,
    assertion,
    // catalogEvidence preserves the internal PASS/FAIL audit trail. The
    // acceptance report accepts only this explicit catalog mapping status.
    status: proofs[assertion]?.status === 'PASS' ? 'VERIFIED' : 'GAP',
    evidence: proofs[assertion]?.evidence || '尚无本轮真实闭环证据'
  })
  // The report maps these rows against the catalog's declared assertions by
  // original index. Reverse assertions have a separate index namespace.
  const catalogAssertions = (definition.assertions || []).map(row)
  const reverseAssertions = (definition.reverse || []).map(row)
  caseRecord.catalogAssertions = catalogAssertions
  caseRecord.catalogReverseAssertions = reverseAssertions
  caseRecord.remainingAssertions = [
    ...catalogAssertions.filter((item) => item.status !== 'VERIFIED'),
    ...reverseAssertions
      .filter((item) => item.status !== 'VERIFIED')
      .map((item) => ({ ...item, reverse: true }))
  ]
  const failed = caseRecord.checks.some((item) => item.passed === false) ||
    Object.values(proofs).some((item) => item?.status === 'FAIL')
  caseRecord.passCandidate = !failed && caseRecord.remainingAssertions.length === 0
  return {
    partial: !caseRecord.passCandidate,
    note: caseRecord.passCandidate
      ? '本轮全部 catalog 原断言及 reverse 具备证据；catalog 状态未修改，候选待主线程审核'
      : `剩余 ${caseRecord.remainingAssertions.length} 项 catalog 断言，不能升级完整 PASS`
  }
}

export function proof (caseRecord, assertion, passed, evidence) {
  caseRecord.catalogEvidence ||= {}
  const previous = caseRecord.catalogEvidence[assertion]
  // 同一断言可能由主场景与写侧闭环分别取证；一旦出现失败即保持 FAIL，否则取并集 PASS。
  const status = passed && previous?.status !== 'FAIL' ? 'PASS'
    : passed && previous?.status === 'FAIL' ? 'FAIL' : 'FAIL'
  caseRecord.catalogEvidence[assertion] = {
    status,
    evidence: [previous?.evidence, evidence].filter(Boolean).join('; ')
  }
  check(caseRecord, assertion, passed, evidence)
}

export function missing (caseRecord, assertion, reason) {
  caseRecord.catalogEvidence ||= {}
  if (!caseRecord.catalogEvidence[assertion]) {
    caseRecord.catalogEvidence[assertion] = { status: 'UNVERIFIED', evidence: reason }
  }
  caseRecord.notes.push(`${assertion}：${reason}`)
}

export async function database (caseRecord, stage, sql) {
  const snapshot = await runReadOnlySql(sql)
  if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
  caseRecord.database ||= []
  caseRecord.database.push({ stage, ...snapshot })
  return snapshot.rows
}

export async function preflight (api, caseRecord) {
  assertEnvironment()
  const sets = dataOf(await api.getBusiness('/fms/config/account-set/list'))
  const own = sets?.find((item) => String(item.id) === config.fmsAccountSetId)
  if (!own?.initialized || ![1, 2].includes(own.level)) {
    throw new Error('BLOCKED: 专属账套未初始化或当前用户无账套写权限')
  }
  // ERP publishers omit accountSetId: prove their resolver cannot select another account set.
  const all = await database(caseRecord, 'tenant-account-set-guard',
    'SELECT id FROM fms_account_set WHERE tenant_id=1 AND deleted=0')
  if (all.length !== 1 || all[0][0] !== config.fmsAccountSetId) {
    throw new Error('BLOCKED: ERP 来源未传账套，tenant1 非唯一专属账套；不能擅自选账套')
  }
  const month = dataOf(await api.getBusiness(
    `/fms/closing/period/current-month?accountSetId=${config.fmsAccountSetId}`))
  if (month !== '2026-10') throw new Error(`BLOCKED: 本轮夹具期间非开放的 2026-10：${month}`)
  check(caseRecord, 'tenant1 唯一专属账套、权限与当前期间通过真实 API/DB 核对', true,
    `accountSetId=${own.id}, month=${month}`)
  return { own, month }
}

export async function poll (read, ready, { attempts = 35, delayMs = 2000 } = {}) {
  let value
  for (let index = 0; index < attempts; index++) {
    value = await read()
    if (ready(value)) return value
    if (index + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return value
}

export function balancedDraft (draft, amount) {
  if (!draft || !Array.isArray(draft.entries) || draft.entries.length < 2) return false
  const debit = draft.entries.filter((entry) => entry.direction === 'DEBIT')
    .reduce((total, entry) => total + money(entry.amount), 0)
  const credit = draft.entries.filter((entry) => entry.direction === 'CREDIT')
    .reduce((total, entry) => total + money(entry.amount), 0)
  return debit > 0 && debit === credit &&
    debit === money(draft.debitTotal) && credit === money(draft.creditTotal) &&
    (amount === undefined || debit === money(amount))
}

export function draftLedgerPaths (draft, subjects, month) {
  const codes = [...new Set(draft.entries.map((entry) => entry.accountCode))]
  if (!codes.length) throw new Error('草稿没有可核对的科目')
  return codes.map((code) => {
    const matches = subjects.filter((subject) => subject.code === code)
    if (matches.length !== 1) throw new Error(`BLOCKED: 草稿科目 ${code} 未唯一匹配现有账套科目`)
    const query = new URLSearchParams({
      accountSetId: numericId(draft.accountSetId),
      subjectId: numericId(matches[0].id), startMonth: month, endMonth: month
    })
    return `/fms/ledger/detail/list?${query}`
  })
}

export function reconcileMatches (value, expected) {
  if (!(expected instanceof Map) || expected.size === 0 ||
      !value?.reconciled || String(value.accountSetId) !== String(config.fmsAccountSetId) ||
      !Array.isArray(value.entries) || value.entries.length !== expected.size) return false
  const total = [...expected.values()].reduce((sum, amount) => sum + money(amount), 0)
  return total > 0 && new Set(value.entries.map((entry) => String(entry.partnerId))).size === expected.size &&
    money(value.sourceTotalAmount) === total && money(value.fmsTotalAmount) === total &&
    money(value.differenceAmount) === 0 && value.entries.every((entry) =>
    expected.has(String(entry.partnerId)) && entry.status === 'MATCHED' &&
    money(entry.sourceAmount) === money(expected.get(String(entry.partnerId))) &&
    money(entry.fmsAmount) === money(expected.get(String(entry.partnerId))) &&
    money(entry.difference) === 0)
}

export function receiptMappingBody (key, version = 1) {
  ownedKey(key)
  const lines = version === 1
    ? [['DEBIT', '100201', 'line.amount * 0.4'], ['DEBIT', '100201', 'line.amount * 0.6'],
        ['CREDIT', '1122', 'line.amount']]
    : [['DEBIT', '100201', 'line.amount * 0.4'], ['DEBIT', '100201', 'line.amount * 0.6'],
        ['CREDIT', '1122', 'line.amount * 0.4'], ['CREDIT', '1122', 'line.amount * 0.6']]
  return {
    accountSetId: config.fmsAccountSetId, sourceSystem: 'ERP', eventType: 'ERP_RECEIPT_ARRIVED',
    direction: 'FORWARD', priority: 200, enabled: true,
    effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', remark: `${key} v${version}`,
    entries: lines.map(([direction, accountCode, amountExpression], index) => ({
      lineNo: index + 1, direction, accountCode, amountExpression, sortNo: index + 1, enabled: true,
      conditionJson: JSON.stringify({
        sourceSystem: { eq: 'ERP' }, sourceBillType: { eq: 'FinReceipt' },
        eventType: { eq: 'ERP_RECEIPT_ARRIVED' }, direction: { eq: 'FORWARD' }
      })
    }))
  }
}

export function openingQuery (batch, overrides = {}) {
  ownedKey(batch)
  return new URLSearchParams({
    pageNo: '1', pageSize: '100', importBatchNo: batch, dealingsLogotype: 'receivable',
    openingBaseDate: '2026-10-07', billDate_begin: '2026-10-07 00:00:00',
    billDate_end: '2026-10-07 23:59:59', ...overrides
  })
}

export function openingDateInputOrder (currentStart, currentEnd, targetStart, targetEnd) {
  if (!currentStart || !currentEnd) return ['start', 'end']
  if (targetStart > currentStart) return ['end', 'start']
  if (targetEnd < currentEnd) return ['start', 'end']
  return ['start', 'end']
}

export async function expectRejected (api, caseRecord, method, pathname, body, pattern) {
  const response = await api.request(method, pathname, body)
  const rejected = !isBusinessSuccess(response) &&
    pattern.test(String(response.msg || response.message || ''))
  check(caseRecord, `${method} ${pathname} 受控拒绝`, rejected, JSON.stringify(response))
  return rejected
}

export async function readEvent (api, sourceBillId, eventType) {
  const query = new URLSearchParams({ pageNo: '1', pageSize: '100', sourceBillId, eventType })
  const result = dataOf(await api.getBusiness(`/fms/event-inbox/page?${query}`))
  return result.list.filter((item) =>
    String(item.sourceBillId) === sourceBillId && item.eventType === eventType)
}

export async function sourceDelivery (api, caseRecord, sourceBillId, eventType) {
  if (!/^ERP_[A-Z_]+$/.test(eventType)) throw new Error('无效来源事件类型')
  const id = numericId(sourceBillId)
  const outbox = await database(caseRecord, 'source-transaction-outbox',
    `SELECT id,event_type,status,retry_count,fms_inbox_id,draft_id,payload
     FROM fms_outbox WHERE tenant_id=1 AND deleted=0 AND source_bill_id='${id}'
       AND event_type='${eventType}'`)
  check(caseRecord, '来源业务成功后真实 outbox 唯一落库', outbox.length === 1,
    `sourceBillId=${id}, outboxRows=${outbox.length}`)
  if (outbox.length !== 1) throw new Error('来源事务没有唯一 outbox')
  const events = await poll(() => readEvent(api, id, eventType), (rows) => rows.length === 1)
  const sent = await poll(() => database(caseRecord, 'scheduler-delivery',
    `SELECT id,status,retry_count,fms_inbox_id,draft_id FROM fms_outbox
     WHERE tenant_id=1 AND deleted=0 AND id='${numericId(outbox[0][0])}'`),
  (rows) => rows[0]?.[1] === 'SENT', { attempts: 5, delayMs: 1000 })
  check(caseRecord, '后台调度投递关联唯一 inbox，不手动 dispatch', events.length === 1 &&
    sent[0]?.[1] === 'SENT' && sent[0]?.[3] === events[0]?.id,
  JSON.stringify(sent))
  if (events.length !== 1) throw new Error('后台调度未产生来源 inbox')
  const payload = JSON.parse(outbox[0][6])
  payload.accountSetId = config.fmsAccountSetId
  const duplicate = dataOf(await api.postBusiness('/fms/voucher-draft/accept-event', payload))
  check(caseRecord, '真实 outbox 原事件重复受理复用 inbox/草稿', duplicate.duplicated === true &&
    duplicate.id === events[0].id && duplicate.draftId === events[0].draftId,
  JSON.stringify(duplicate))
  const draft = events[0].draftId
    ? dataOf(await api.getBusiness(`/fms/voucher-draft/get?id=${events[0].draftId}`)) : null
  if (draft && draft.accountSetId !== config.fmsAccountSetId) {
    throw new Error('来源草稿不属于专属账套')
  }
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({
    kind: 'source-outbox-inbox-draft', sourceBillId: id, eventType,
    outboxId: outbox[0][0], inboxId: events[0].id, draftId: draft?.id,
    cleanup: 'RETAINED_AUDIT: outbox/inbox/草稿无受控删除接口，未直接改数据库'
  })
  return { outbox, sent, event: events[0], payload, duplicate, draft }
}
