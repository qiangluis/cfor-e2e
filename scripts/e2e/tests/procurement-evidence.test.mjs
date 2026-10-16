import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import {
  procurementCatalogEvidence, runFinanceRuleReadonlyContract, supplierAuthCatalogEvidence
} from '../suites/procurement.mjs'
import { validatePayableCheckReadonly } from '../suites/erp-settlement.mjs'
import { caseOutcome } from '../lib/report.mjs'
import { buildAcceptanceGapReport } from '../acceptance-gap-report.mjs'

const record = () => ({ checks: [], notes: [], evidence: [] })
const ok = (data) => ({ code: 0, data })
const paged = (list) => ok({ list, total: list.length })

const supplierAuthEvidenceChecks = [
  'headed 供应商登录使用加密请求与 tenant1',
  'headed supplier 独立存储且未覆盖管理端令牌',
  'DB 证实专属 token userType=SUPPLIER(3)/tenant1',
  'supplier token 可访问自身工作台', 'supplier token 不可访问 admin-api',
  '账号停用后登录拒绝', '账号停用后refresh拒绝',
  'partner停用后登录拒绝', 'partner停用后refresh拒绝',
  '供应商角色停用后登录拒绝', '供应商角色停用后refresh拒绝',
  'logout 后 access 失效', 'logout 后 refresh 失效'
]

test('PROC-010 maps only observed auth checks and keeps invite, tenant refresh and Member gaps', () => {
  const caseRecord = record()
  caseRecord.checks = supplierAuthEvidenceChecks.map((name) => ({ name, passed: true }))
  supplierAuthCatalogEvidence(caseRecord)
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'PROC-010')
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.assertion), definition.assertions)
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.status),
    ['VERIFIED', 'GAP', 'GAP', 'VERIFIED', 'GAP', 'VERIFIED', 'VERIFIED'])
  assert.deepEqual(caseRecord.remainingAssertions, [1, 2, 4].map((index) => definition.assertions[index]))
  assert.equal(caseRecord.passCandidate, false)
})

test('PROC-010 auth mapping requires unique boolean evidence and never infers missing checks', () => {
  const empty = record()
  supplierAuthCatalogEvidence(empty)
  assert.ok(empty.catalogAssertions.every((row) => row.status === 'GAP'))
  for (const value of [false, undefined, 'true', 1]) {
    const caseRecord = record()
    caseRecord.checks = supplierAuthEvidenceChecks.map((name) => ({ name, passed: true }))
    caseRecord.checks.find((row) => row.name === 'supplier token 可访问自身工作台').passed = value
    supplierAuthCatalogEvidence(caseRecord)
    assert.equal(caseRecord.catalogAssertions[3].status, 'GAP')
  }
  const duplicate = record()
  duplicate.checks = supplierAuthEvidenceChecks.map((name) => ({ name, passed: true }))
  duplicate.checks.push({ name: 'logout 后 access 失效', passed: true })
  supplierAuthCatalogEvidence(duplicate)
  assert.equal(duplicate.catalogAssertions[6].status, 'GAP')
})

test('PROC-010 tenant refresh mapping requires precise rejection, unchanged facts and live source session', () => {
  const names = [
    'admin refresh 不可通过 supplier refresh',
    '跨端 refresh 拒绝后原 admin 会话仍有效',
    'tenant-id 不匹配 refresh 精确拒绝',
    '跨租户 refresh 拒绝前后原 access/refresh 完整事实不变',
    '跨租户 refresh 拒绝后原 supplier 会话仍有效',
    'supplier refresh 正常轮换 access',
    'refresh 后旧 access 失效'
  ]
  const caseRecord = record()
  caseRecord.checks = names.map((name) => ({ name, passed: true }))
  supplierAuthCatalogEvidence(caseRecord)
  assert.equal(caseRecord.catalogAssertions[2].status, 'VERIFIED')
  assert.equal(caseRecord.catalogAssertions[1].status, 'GAP')
  assert.equal(caseRecord.catalogAssertions[4].status, 'GAP')
  for (const name of names) {
    const incomplete = record()
    incomplete.checks = names.filter((value) => value !== name).map((value) => ({ name: value, passed: true }))
    supplierAuthCatalogEvidence(incomplete)
    assert.equal(incomplete.catalogAssertions[2].status, 'GAP', name)
  }
})

const supplierInviteChecks = [
  '邀请 token 来自本轮专属未发送日志且匹配有效邀请哈希',
  'headed 邀请激活使用加密请求与 tenant1',
  'headed 邀请激活成功返回本轮登录名',
  'headed 邀请激活跳转登录页并预填登录名',
  '邀请激活后正式 API 消耗 token 且账号启用',
  '本轮邀请账号清理为 DISABLED'
]
const memberRefreshChecks = [
  'admin refresh 不可通过 supplier refresh',
  '跨端 refresh 拒绝后原 admin 会话仍有效',
  'Member API 登录取得真实专属会话',
  'DB 证实真实 Member access/refresh userType=MEMBER(1)/tenant1',
  'Member refresh 不可通过 supplier refresh 精确拒绝',
  'DB 证实真实 Member access/refresh userType=MEMBER(1)/tenant1（拒绝后）',
  'Member 跨端 refresh 拒绝前后原 access/refresh 完整事实不变',
  '跨端 refresh 拒绝后原 Member 会话仍有效',
  '专属 Member 会话退出'
]
const supplierTenantRefreshChecks = [
  'tenant-id 不匹配 refresh 精确拒绝',
  '跨租户 refresh 拒绝前后原 access/refresh 完整事实不变',
  '跨租户 refresh 拒绝后原 supplier 会话仍有效',
  'supplier refresh 正常轮换 access',
  'refresh 后旧 access 失效'
]

test('PROC-010 only complete observed invite/Member evidence closes both remaining assertions', () => {
  const caseRecord = record()
  const names = [...new Set([...supplierAuthEvidenceChecks, ...supplierTenantRefreshChecks,
    ...supplierInviteChecks, ...memberRefreshChecks])]
  caseRecord.checks = names.map((name) => ({ name, passed: true }))
  supplierAuthCatalogEvidence(caseRecord)
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'))
  assert.equal(caseRecord.passCandidate, true)
  assert.deepEqual(caseRecord.remainingAssertions, [])
})

test('PROC-010 missing, nonboolean or duplicate invitation/Member observations remain GAP', () => {
  for (const [index, names] of [[1, supplierInviteChecks], [4, memberRefreshChecks]]) {
    for (const name of names) {
      for (const fault of ['missing', 'duplicate', false, 'true', 1, undefined]) {
        const caseRecord = record()
        caseRecord.checks = names.map((value) => ({ name: value, passed: true }))
        if (fault === 'missing') caseRecord.checks = caseRecord.checks.filter((row) => row.name !== name)
        else if (fault === 'duplicate') caseRecord.checks.push({ name, passed: true })
        else caseRecord.checks.find((row) => row.name === name).passed = fault
        supplierAuthCatalogEvidence(caseRecord)
        assert.equal(caseRecord.catalogAssertions[index].status, 'GAP', `${name}: ${fault}`)
        assert.equal(caseRecord.passCandidate, false)
      }
    }
  }
})

test('PROC-010 API activation without headed redirect/prefill and Admin-only refresh never close gaps', () => {
  const caseRecord = record()
  caseRecord.checks = [
    ...supplierAuthEvidenceChecks,
    ...supplierTenantRefreshChecks,
    'admin refresh 不可通过 supplier refresh',
    '跨端 refresh 拒绝后原 admin 会话仍有效',
    '邀请 token 来自本轮专属未发送日志且匹配有效邀请哈希',
    'headed 邀请激活成功返回本轮登录名',
    '邀请激活后正式 API 消耗 token 且账号启用',
    '本轮邀请账号清理为 DISABLED'
  ].map((name) => ({ name, passed: true }))
  caseRecord.notes.push('unit-only: no real invite UI or Member session')
  supplierAuthCatalogEvidence(caseRecord)
  assert.equal(caseRecord.catalogAssertions[1].status, 'GAP')
  assert.equal(caseRecord.catalogAssertions[2].status, 'VERIFIED')
  assert.equal(caseRecord.catalogAssertions[4].status, 'GAP')
  assert.equal(caseRecord.passCandidate, false)
})

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

test('populated automatic/manual terminal facts close the settlement state contract', () => {
  const caseRecord = record()
  const result = validatePayableCheckReadonly(ok({ records: [
    { id: '1', isAuto: 1, billStage: '34', isEffective: 1 },
    { id: '2', isAuto: 0, billStage: '34', isEffective: 1 }
  ], total: 2 }), caseRecord)
  assert.equal(result.partial, false)
  assert.ok(caseRecord.checks.every((check) => check.passed))
  assert.ok(caseRecord.checks.some((check) => /手工/.test(check.name)))
  assert.equal(caseOutcome({ failedChecks: [], hasAssertions: true, result }).status, 'PASS')
})

test('failed payloads and malformed pages throw; ineffective terminals surface as failed checks', () => {
  for (const payload of [
    { code: 500, data: { records: [], total: 0 } },
    ok({}), ok({ records: {}, total: 0 }), ok({ records: [], total: '0' })
  ]) assert.throws(() => validatePayableCheckReadonly(payload, record()))

  const caseRecord = record()
  const result = validatePayableCheckReadonly(ok({ records: [
    { id: '1', isAuto: 1, billStage: '22', isEffective: 0 },
    { id: '1b', isAuto: 1, billStage: '34', isEffective: 0 },
    { id: '2', isAuto: 0, billStage: '34', isEffective: 0 }
  ], total: 3 }), caseRecord)
  const failed = caseRecord.checks.filter((check) => check.passed === false)
  assert.ok(failed.length >= 2)
  assert.equal(caseOutcome({ failedChecks: failed, hasAssertions: true, result }).status, 'FAIL')
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

const suiteSource = fs.readFileSync(new URL('../suites/procurement.mjs', import.meta.url), 'utf8')
const procurement016Branch = suiteSource.slice(
  suiteSource.indexOf("if (caseId === 'PROC-016')"),
  suiteSource.indexOf("if (caseId === 'PROC-017')")
)
const procurement016ChecksSource = procurement016Branch.slice(
  procurement016Branch.indexOf('    caseRecord.checks.push(\n      {'),
  procurement016Branch.indexOf('    caseRecord.evidence.push(')
)

const procurement016Result = () => ({
  historical: {
    invoice: { invoiceId: '1001', created: {
      srcBillType: 'ERP_PURCHASE_ORDER', srcBillId: '2001', details: '{"2001":10}', isEffective: 0
    } },
    rejected: { code: 1_030_102_040 },
    snapshots: { before: '{"historical":true}', after: '{"historical":true}',
      duplicateAfter: '{"historical":true}' }
  },
  absent: {
    invoice: { invoiceId: '1002' },
    generated: [{ id: '3002', srcBillType: 'PurInvoice' }],
    snapshots: { before: '{"isEffective":0}', after: '{"isEffective":1}' }
  },
  opening: {
    invoice: { invoiceId: '1003' },
    generated: [{ id: '3003', srcBillType: 'PurInvoice' }],
    snapshots: { before: '{"isEffective":0}', after: '{"isEffective":1}' }
  },
  pageEvidence: { status: 'VERIFIED' }
})

// Evaluate the production recording block only; no fixture, API, browser or SQL is invoked.
const recordProcurement016Checks = (result) => {
  assert.match(procurement016ChecksSource, /result\.absent\.snapshots/)
  assert.match(procurement016ChecksSource, /result\.opening\.snapshots/)
  const caseRecord = record()
  vm.runInNewContext(procurement016ChecksSource, { result, caseRecord }, { timeout: 1000 })
  return caseRecord
}

test('PROC-016 snapshot-backed positive checks record boolean true, never snapshot strings', () => {
  const caseRecord = recordProcurement016Checks(procurement016Result())
  assert.equal(caseRecord.checks.length, 5)
  assert.ok(caseRecord.checks.every((check) => check.passed === true))
  assert.ok(caseRecord.checks.every((check) => typeof check.passed === 'boolean'))
  assert.match(caseRecord.checks[2].details, /invoiceId=1002; payableId=3002/)
  assert.match(caseRecord.checks[3].details, /invoiceId=1003; payableId=3003/)
})

for (const [scenario, checkIndex] of [['absent', 2], ['opening', 3]]) {
  test(`PROC-016 ${scenario} missing snapshots or non-unique/wrong-source payable remain boolean false`, () => {
    const mutations = [
      (item) => { delete item.snapshots },
      (item) => { delete item.snapshots.before },
      (item) => { delete item.snapshots.after },
      (item) => { item.snapshots.before = '' },
      (item) => { item.snapshots.after = '' },
      (item) => { item.snapshots.after = null },
      (item) => { delete item.generated },
      (item) => { item.generated = [] },
      (item) => { item.generated.push({ ...item.generated[0] }) },
      (item) => { item.generated[0].srcBillType = 'PurOrder' }
    ]
    for (const mutate of mutations) {
      const result = procurement016Result()
      mutate(result[scenario])
      const caseRecord = recordProcurement016Checks(result)
      assert.equal(caseRecord.checks[checkIndex].passed, false)
      assert.ok(caseRecord.checks.every((check) => typeof check.passed === 'boolean'))
      assert.equal(caseRecord.checks[scenario === 'absent' ? 3 : 2].passed, true)
    }
  })
}

test('PROC-016 historical domain rejection and unchanged snapshots are not weakened by boolean recording', () => {
  for (const mutate of [
    (item) => { item.rejected.code = 500 },
    (item) => { item.snapshots.after = '{"changed":true}' },
    (item) => { item.snapshots.duplicateAfter = '{"changed":true}' }
  ]) {
    const result = procurement016Result()
    mutate(result.historical)
    assert.equal(recordProcurement016Checks(result).checks[1].passed, false)
  }
})

test('procurement catalog PASS candidate rejects non-boolean auxiliary checks even with complete mappings', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const assertions = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'PROC-016').assertions
  const evidence = Object.fromEntries(assertions.map((_assertion, index) => [index, [`evidence-${index}`]]))
  for (const passed of [undefined, null, 'snapshot', 1, false, true]) {
    const caseRecord = record()
    caseRecord.checks = assertions.map((_assertion, index) => ({
      name: `evidence-${index}`, passed: true
    }))
    caseRecord.checks.push({ name: 'positive scenario', passed })
    procurementCatalogEvidence('PROC-016', caseRecord, evidence)
    assert.ok(caseRecord.catalogAssertions.every((item) => item.status === 'VERIFIED'))
    assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.assertion), assertions)
    assert.equal(caseRecord.passCandidate, passed === true)
    assert.equal(caseRecord.checks.at(-1).passed, passed)
  }
})

test('PROC-016 strict report preserves INCOMPLETE_CHECK for old strings and accepts observed boolean checks', (t) => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'PROC-016')
  const catalogPath = '/unit-only/procurement-catalog.json'
  const sourcePath = '/unit-only/procurement-result.json'
  const coveragePath = '/unit-only/procurement-coverage.json'
  const caseRecord = recordProcurement016Checks(procurement016Result())
  caseRecord.checks.push({ name: 'unit-only existing Java report observation', passed: true })
  procurementCatalogEvidence('PROC-016', caseRecord, {
    0: [caseRecord.checks[0].name],
    1: [caseRecord.checks[1].name],
    2: [caseRecord.checks[4].name],
    3: [caseRecord.checks[5].name]
  })
  const unitRecord = {
    ...caseRecord,
    caseId: 'PROC-016', status: 'PASS',
    runtimeErrors: { console: [], page: [], api: [], request: [], nodeApi: [] }
  }
  const inputs = {
    [catalogPath]: { suites: [{ id: 'procurement', cases: [definition] }] },
    [sourcePath]: {
      runId: 'unit-only',
      environment: { target: 'local', tenantId: '1', webBase: 'http://127.0.0.1:9151',
        apiBase: 'http://127.0.0.1:48083' },
      cases: [unitRecord]
    },
    [coveragePath]: { cases: [{
      id: 'PROC-016', actualStatus: 'PASS', executed: true,
      latestExecution: { runId: 'unit-only', sourcePath }
    }] }
  }
  const readFileSync = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) =>
    Object.hasOwn(inputs, file) ? JSON.stringify(inputs[file]) : readFileSync(file, ...args))
  const build = () => buildAcceptanceGapReport({ coveragePath, catalogPath }).cases[0]
  assert.equal(build().completeAcceptance, true)
  assert.deepEqual(build().completionBlockers, [])
  for (const index of [2, 3]) {
    unitRecord.checks[index].passed = '{"oldSnapshot":true}'
    assert.equal(build().completeAcceptance, false)
    assert.ok(build().completionBlockers.includes('INCOMPLETE_CHECK'))
    unitRecord.checks[index].passed = true
  }
  assert.equal(build().completeAcceptance, true)
})
