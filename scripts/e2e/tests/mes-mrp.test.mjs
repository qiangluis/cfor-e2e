import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  assertExpectedMrpRejection,
  finalizeMrpCatalogAssertions,
  initializeMrpCatalogAssertions,
  markMrpCatalogAssertion,
  MES_MRP_CATALOG_ASSERTIONS,
  MRP_COMPLETED_CANCEL_REJECTION,
  MRP_EXECUTION_CLEANUP_PATHS,
  MRP_IDEMPOTENCY_REJECTION,
  MRP_MISSING_STATUS_REJECTION
} from '../suites/mes-mrp.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

const suiteSource = fs.readFileSync(new URL('../suites/mes-mrp.mjs', import.meta.url), 'utf8')

test('MES-MRP-001 maps each catalog assertion by exact index and assertion text', () => {
  const record = { checks: [], notes: [], evidence: [] }
  initializeMrpCatalogAssertions(record)
  assert.deepEqual(record.catalogAssertions.map(({ index, assertion, status, evidenceChecks }) => ({
    index, assertion, status, evidenceChecks
  })), MES_MRP_CATALOG_ASSERTIONS.map((assertion, index) => ({
    index, assertion, status: 'GAP', evidenceChecks: []
  })))
  assert.deepEqual(record.remainingAssertions, MES_MRP_CATALOG_ASSERTIONS)
})

test('MES-MRP-001 only verifies catalog assertions from actual passing checks', () => {
  const record = { checks: [], notes: [], evidence: [] }
  initializeMrpCatalogAssertions(record)
  record.checks.push({ name: 'history', passed: true, details: 'pageSize=100,status=3' })
  record.checks.push({ name: 'status', passed: false, details: 'progress missing' })
  assert.equal(markMrpCatalogAssertion(record, 0, ['history']), true)
  assert.equal(markMrpCatalogAssertion(record, 1, ['status']), false)
  assert.equal(record.catalogAssertions[0].status, 'VERIFIED')
  assert.equal(record.catalogAssertions[0].evidenceChecks[0], 'history')
  assert.match(record.catalogAssertions[0].details, /pageSize=100,status=3/)
  assert.equal(record.catalogAssertions[1].status, 'GAP')
  assert.match(record.catalogAssertions[1].details, /progress missing/)
  finalizeMrpCatalogAssertions(record)
  assert.deepEqual(record.remainingAssertions, MES_MRP_CATALOG_ASSERTIONS.slice(1))
  assert.equal(record.catalogComplete, false)
})

test('MES-MRP-001 does not mark an assertion verified when evidence names are missing', () => {
  const record = { checks: [], notes: [], evidence: [] }
  initializeMrpCatalogAssertions(record)
  assert.equal(markMrpCatalogAssertion(record, 2, ['missing rejection check']), false)
  assert.equal(record.catalogAssertions[2].status, 'GAP')
  assert.match(record.catalogAssertions[2].details, /缺证: missing rejection check/)
})

test('MES-MRP-001 returns partial when an actual catalog assertion remains GAP', () => {
  const record = { checks: [], notes: [], evidence: [] }
  initializeMrpCatalogAssertions(record)
  for (const name of ['history', 'status', 'missing', 'fields']) {
    record.checks.push({ name, passed: name !== 'status', details: `${name}=pass` })
  }
  markMrpCatalogAssertion(record, 0, ['history'])
  markMrpCatalogAssertion(record, 1, ['status'])
  markMrpCatalogAssertion(record, 2, ['missing'])
  markMrpCatalogAssertion(record, 3, ['fields'])

  const result = finalizeMrpCatalogAssertions(record)
  assert.equal(result.partial, true)
  assert.match(result.note, /状态接口字段证据欠缺|catalog 断言缺口/)
  assert.equal(record.catalogAssertions[0].status, 'VERIFIED')
  assert.deepEqual(record.catalogAssertions.slice(1).map((row) => row.status), [
    'GAP', 'VERIFIED', 'VERIFIED'
  ])
  assert.equal(record.notes.length, 1)
})

test('MES-MRP-001 is catalog-complete when every assertion has unique passing evidence', () => {
  const record = { checks: [], notes: [], evidence: [] }
  initializeMrpCatalogAssertions(record)
  for (const [index, name] of ['history', 'status', 'missing', 'fields'].entries()) {
    record.checks.push({ name, passed: true, details: `${name}=pass` })
    assert.equal(markMrpCatalogAssertion(record, index, [name]), true)
  }

  const result = finalizeMrpCatalogAssertions(record)
  assert.equal(result.partial, false)
  assert.equal(record.catalogComplete, true)
  assert.deepEqual(record.remainingAssertions, [])
  assert.deepEqual(record.catalogAssertions.map((row) => row.status), [
    'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED'
  ])
})

test('MES-MRP-001 uses exact code and message contracts for all negative probes', () => {
  assert.equal(matchesExpectedBusinessRejection({
    code: 500,
    msg: '系统错误，MRP运算失败：该幂等键已存在MRP运算（c16e6197-a84a-4b1c-bb4a-d35e75b414f1），请勿重复提交'
  }, MRP_IDEMPOTENCY_REJECTION), true)
  assert.equal(matchesExpectedBusinessRejection({
    code: 500,
    msg: '取消MRP运算失败：已完成的MRP运算不允许终止，请重新发起运算'
  }, MRP_COMPLETED_CANCEL_REJECTION), true)
  assert.equal(matchesExpectedBusinessRejection({
    code: 500,
    msg: '查询MRP运算状态失败：MRP运算记录不存在'
  }, MRP_MISSING_STATUS_REJECTION), true)
})

test('MES-MRP-001 never treats generic system, routing, auth, or SQL errors as expected rejection', () => {
  for (const response of [
    { code: 500, msg: '系统异常' },
    { code: 500, msg: 'SQL Exception' },
    { code: 502, msg: 'Bad Gateway' },
    { code: 404, msg: '请求地址不存在' },
    { code: 403, msg: '无权限' },
    { code: 0, msg: '查询MRP运算状态失败：MRP运算记录不存在' }
  ]) {
    assert.equal(matchesExpectedBusinessRejection(response, MRP_IDEMPOTENCY_REJECTION), false)
    assert.equal(matchesExpectedBusinessRejection(response, MRP_COMPLETED_CANCEL_REJECTION), false)
    assert.equal(matchesExpectedBusinessRejection(response, MRP_MISSING_STATUS_REJECTION), false)
  }
})

test('MES-MRP-001 rejection assertions fail when code or message is incomplete', () => {
  for (const [response, expected, label] of [
    [{ code: 500 }, MRP_IDEMPOTENCY_REJECTION, '幂等'],
    [{ code: 500, msg: '系统错误，MRP运算失败：该幂等键已存在MRP运算（not-a-uuid），请勿重复提交' }, MRP_IDEMPOTENCY_REJECTION, '幂等'],
    [{ code: 500, msg: '已完成' }, MRP_COMPLETED_CANCEL_REJECTION, '完成态终止'],
    [{ code: 500, msg: 'MRP运算记录不存在' }, MRP_MISSING_STATUS_REJECTION, '不存在状态']
  ]) {
    assert.throws(() => assertExpectedMrpRejection(response, expected, label), /契约不符/)
  }
})

test('MES-MRP-001 retains the calculation fact and delegates fixture cleanup to normal APIs', () => {
  assert.match(suiteSource, /expectedBusinessRejection: MRP_IDEMPOTENCY_REJECTION/)
  assert.match(suiteSource, /expectedBusinessRejection: MRP_COMPLETED_CANCEL_REJECTION/)
  assert.match(suiteSource, /expectedBusinessRejection: MRP_MISSING_STATUS_REJECTION/)
  assert.doesNotMatch(suiteSource, /duplicate\?\.code !== 0/)
  assert.doesNotMatch(suiteSource, /cancelCompleted\?\.code !== 0/)
  assert.doesNotMatch(suiteSource, /missing\?\.code !== 0/)
  assert.doesNotMatch(suiteSource, /deleteHistory/)
  assert.match(suiteSource, /MRP 终态计算事实保留且未调用历史删除接口/)
  assert.match(suiteSource, /\/mes\/mrp\/status\/\$\{encodeURIComponent\(calculationId\)\}/)
  assert.match(suiteSource, /fixture\.cleanup\(caseRecord\)/)
  assert.deepEqual(MRP_EXECUTION_CLEANUP_PATHS.opening, [
    '/mes/stkIo/void',
    '/mes/stkIo/queryById?id={id}'
  ])
  assert.deepEqual(MRP_EXECUTION_CLEANUP_PATHS.warehouse, [
    '/mes/wmsWareHouse/queryById?id={id}',
    '/mes/wmsWareHouse/edit',
    '/mes/wmsWareHouse/delete?id={id}'
  ])
})
