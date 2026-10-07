import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_REFERENCE_COLUMNS,
  assertLocalAccountWriteTarget,
  buildAccountReferenceSql,
  dataOf,
  isExpectedAccountRejection,
  isStableAccountId,
  isWriteFixturesEnabled,
  maskAccountNo
} from '../suites/erp-account.mjs'

test('write fixture requires the exact explicit opt-in', () => {
  assert.equal(isWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: 'true' }), true)
  assert.equal(isWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: 'TRUE' }), true)
  assert.equal(isWriteFixturesEnabled({ CFOR_E2E_WRITE_FIXTURES: '1' }), false)
  assert.equal(isWriteFixturesEnabled({}), false)
})

test('write fixture target rejects remote hosts, wrong ports, and wrong tenant', () => {
  assert.equal(assertLocalAccountWriteTarget({
    target: 'local',
    webBase: 'http://127.0.0.1:9151',
    apiBase: 'http://127.0.0.1:48083',
    tenantId: '1',
    tenantName: 'CFOR 标准平台'
  }), true)
  for (const input of [
    { webBase: 'https://jixu-ai.com' },
    { apiBase: 'http://127.0.0.1:48080' },
    { tenantId: '2' },
    { tenantName: '其他租户' }
  ]) {
    assert.throws(() => assertLocalAccountWriteTarget({
      target: 'local',
      webBase: input.webBase || 'http://127.0.0.1:9151',
      apiBase: input.apiBase || 'http://127.0.0.1:48083',
      tenantId: input.tenantId || '1',
      tenantName: input.tenantName || 'CFOR 标准平台'
    }), /^Error: BLOCKED:/)
  }
})

test('account IDs and masked account numbers use strict cleanup-safe contracts', () => {
  assert.equal(isStableAccountId(7), true)
  assert.equal(isStableAccountId('9223372036854775807'), true)
  assert.equal(isStableAccountId('0'), false)
  assert.equal(isStableAccountId('1 OR 1=1'), false)
  assert.equal(maskAccountNo('6222020200112233445'), '****3445')
  assert.equal(maskAccountNo('1234'), '****')
  assert.equal(maskAccountNo(null), null)
})

test('business rejection must include a non-success code and expected domain message', () => {
  assert.equal(
    isExpectedAccountRejection({ code: 400, msg: '已存在编码为【E2E】的结算账户' }, '已存在编码'),
    true
  )
  assert.equal(
    isExpectedAccountRejection({ code: 0, msg: '已存在编码为【E2E】的结算账户' }, '已存在编码'),
    false
  )
  assert.equal(
    isExpectedAccountRejection({ code: 500, msg: '已存在编码为【E2E】的结算账户' }, '已存在编码'),
    false
  )
  assert.equal(
    isExpectedAccountRejection({ code: 400, msg: '其他校验失败' }, '已存在编码'),
    false
  )
})

test('reference SQL is limited to known ERP finance references and rejects unsafe IDs', () => {
  const sql = buildAccountReferenceSql('17')
  assert.equal(ACCOUNT_REFERENCE_COLUMNS.length, 15)
  assert.match(sql, /erp_finance_payment.*account_id/)
  assert.match(sql, /fin_receivable_check_entry.*bank_account_id/)
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE|INSERT/i)
  assert.throws(() => buildAccountReferenceSql('17 OR 1=1'), /无效的 ERP 账户 ID/)
})

test('common response data unwrap preserves falsy and object payloads', () => {
  assert.equal(dataOf({ code: 0, data: null }), null)
  assert.equal(dataOf({ code: 0, data: '17' }), '17')
  assert.deepEqual(dataOf({ code: 0, data: { id: '17' } }), { id: '17' })
  assert.deepEqual(dataOf({ id: '17' }), { id: '17' })
})
