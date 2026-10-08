import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { runFinanceRuleReadonlyContract } from '../suites/procurement.mjs'
import { validatePayableCheckReadonly } from '../suites/erp-settlement.mjs'
import { caseOutcome } from '../lib/report.mjs'

const record = () => ({ checks: [], notes: [], evidence: [] })
const ok = (data) => ({ code: 0, data })
const paged = (list) => ok({ list, total: list.length })

test('PROC-007 is GET-only and requires independent write-side evidence', async () => {
  for (const populated of [false, true]) {
    const row = {
      id: 2, documentTypeId: 1, defaultApproval: false,
      allowManualCreate: false, requiredFields: 'bankAccountId,settleMethod'
    }
    const calls = []
    const payloads = {
      '/system/document/type/page?pageNo=1&pageSize=100':
        paged(populated ? [{ id: 1, code: 'FIN_RECEIPT' }] : []),
      '/erp/finance-document-type-rule/page?pageNo=1&pageSize=100':
        paged(populated ? [row] : []),
      '/erp/finance-document-type-rule/get?id=2': ok(row)
    }
    const caseRecord = record()
    const result = await runFinanceRuleReadonlyContract({
      caseRecord, api: { getBusiness: async (path) => {
        calls.push(path)
        assert.ok(Object.hasOwn(payloads, path))
        return payloads[path]
      } }
    })
    assert.equal(result.partial, true)
    assert.match(result.note, /四项需分别/)
    assert.ok(caseRecord.checks.every((check) => check.passed))
    assert.ok(!calls.some((path) => /create|delete|add\/save/.test(path)))
    if (!populated) {
      assert.ok(caseRecord.notes.some((note) => /没有财务类型规则/.test(note)))
      assert.ok(!calls.some((path) => path.includes('/get?id=')))
    }
  }
})

test('PROC-007 rejects broken default approval contracts rather than treating them as optional', async () => {
  await assert.rejects(() => runFinanceRuleReadonlyContract({
    caseRecord: record(), api: { getBusiness: async (path) =>
      path.startsWith('/system/')
        ? paged([{ id: 1, code: 'FIN_RECEIPT' }])
        : paged([{ id: 2, documentTypeId: 1, allowManualCreate: false }])
    }
  }), /默认审批/)
})

test('empty payable checks cannot prove automatic/manual terminal or edit restrictions', () => {
  const caseRecord = record()
  const result = validatePayableCheckReadonly(ok({ records: [], total: 0 }), caseRecord)
  assert.equal(result.partial, true)
  assert.equal(caseRecord.checks.length, 1)
  assert.ok(caseRecord.notes.some((note) => /没有核销单/.test(note)))
  assert.ok(!caseRecord.checks.some((check) => /终态|编辑/.test(check.name)))
  assert.equal(caseOutcome({ failedChecks: [], hasAssertions: true, result }).status, 'PARTIAL')
})

test('populated automatic/manual terminal facts still cannot prove actions or formal writes', () => {
  const caseRecord = record()
  const result = validatePayableCheckReadonly(ok({ records: [
    { id: '1', isAuto: 1, billStage: '34', isEffective: 1 },
    { id: '2', isAuto: 0, billStage: '34', isEffective: 1 }
  ], total: 2 }), caseRecord)
  assert.equal(result.partial, true)
  assert.ok(caseRecord.checks.every((check) => check.passed))
  assert.ok(caseRecord.checks.some((check) => /手工/.test(check.name)))
  assert.ok(!caseRecord.checks.some((check) => /不可.*编辑/.test(check.name)))
})

test('failed payloads, malformed pages and ineffective terminal records fail', () => {
  for (const payload of [
    { code: 500, data: { records: [], total: 0 } },
    ok({}), ok({ records: {}, total: 0 }), ok({ records: [], total: '0' }),
    ok({ records: [{ id: '1', isAuto: 1, billStage: '22', isEffective: 0 }], total: 1 }),
    ok({ records: [{ id: '1', isAuto: 0, billStage: '34', isEffective: 0 }], total: 1 })
  ]) assert.throws(() => validatePayableCheckReadonly(payload, record()))
})

test('PROC-009/011/012 missing business steps remain explicit PARTIAL; portal timing begins before navigation', () => {
  const source = fs.readFileSync(new URL('../suites/procurement.mjs', import.meta.url), 'utf8')
  const branch = (from, to) => source.slice(
    source.indexOf(`if (caseId === '${from}')`), source.indexOf(`if (caseId === '${to}')`))
  for (const [from, to] of [
    ['PROC-011', 'PROC-012']
  ]) assert.match(branch(from, to), /partial: true/)
  const portal = branch('PROC-009', 'PROC-011')
  assert.ok(portal.indexOf('const renderStartedAt = Date.now()') <
    portal.indexOf("await openRoute(page, '/settings/erp/supplierPortal'"))
  assert.doesNotMatch(portal, /passed:\s*!inviteCandidate/)
  const finance = branch('PROC-007', 'PROC-009')
  assert.doesNotMatch(finance, /api\.(post|put|delete|request)/)
})
