import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  assertProcurementApproverCredentials,
  purchaseOrderTenantPredicate,
  resolveProcurementTenantId
} from '../suites/procurement.mjs'

test('PROC-018 requires a tenant from login or permission context', () => {
  assert.throws(
    () => resolveProcurementTenantId({ expectedTenantId: '' }),
    /未获得登录结果或权限响应中的可信 tenantId/
  )
})

test('PROC-018 rejects invalid tenant IDs before SQL interpolation', () => {
  for (const tenantId of ['', '0', '-1', '1 OR 1=1', 'tenant-2', null]) {
    assert.throws(
      () => resolveProcurementTenantId({
        loginContext: { tenantId },
        expectedTenantId: ''
      }),
      /可信 tenantId|未获得.*可信 tenantId/
    )
    assert.throws(() => purchaseOrderTenantPredicate(tenantId), /SQL tenantId/)
  }
})

test('PROC-018 rejects a tenant mismatch between trusted context and env', () => {
  assert.throws(
    () => resolveProcurementTenantId({
      loginContext: { tenantId: '135' },
      expectedTenantId: '1'
    }),
    /CFOR_TENANT_ID 与已验证登录租户不一致/
  )
})

test('PROC-018 accepts the tenant from a successful permission response when login context is reused', () => {
  assert.equal(resolveProcurementTenantId({
    permissionInfo: { code: 0, data: { user: { tenantId: '135' } } },
    expectedTenantId: '135'
  }), '135')
})

test('PROC-018 rejects conflicting login and permission tenant IDs', () => {
  assert.throws(
    () => resolveProcurementTenantId({
      loginContext: { tenantId: '135' },
      permissionInfo: { code: 0, data: { user: { tenantId: '136' } } },
      expectedTenantId: ''
    }),
    /登录结果与权限响应的 tenantId 不一致/
  )
})

test('PROC-018 interpolates only the verified tenant ID in the SQL predicate', () => {
  const tenantId = resolveProcurementTenantId({
    loginContext: { tenantId: '135' },
    expectedTenantId: '135'
  })
  assert.equal(purchaseOrderTenantPredicate(tenantId), 'po.tenant_id = 135')
})

test('PROC-018 keeps both database checks on the resolved tenant predicate', () => {
  const source = fs.readFileSync(
    new URL('../suites/procurement.mjs', import.meta.url), 'utf8'
  )
  const branch = source.slice(
    source.indexOf("if (caseId === 'PROC-018')"),
    source.indexOf("if (caseId === 'PROC-019')")
  )
  assert.equal((branch.match(/WHERE \$\{tenantPredicate\}/g) || []).length, 2)
  assert.doesNotMatch(branch, /tenant_id\s*=\s*1/)
})

test('PROC-018 rejects imprecise numbers and coerced objects without rejecting string snowflake IDs', () => {
  for (const tenantId of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity, true, { toString: () => '135' }]) {
    assert.throws(() => purchaseOrderTenantPredicate(tenantId), /SQL tenantId/)
    assert.throws(() => resolveProcurementTenantId({
      loginContext: { tenantId }, expectedTenantId: ''
    }), /可信 tenantId/)
  }
  const tenantId = '2107440015539376129'
  assert.equal(resolveProcurementTenantId({
    loginContext: { tenantId }, expectedTenantId: tenantId
  }), tenantId)
  assert.equal(purchaseOrderTenantPredicate(tenantId), `po.tenant_id = ${tenantId}`)
})

test('PROC-018 never trusts tenant IDs in a failed or malformed permission envelope', () => {
  for (const permissionInfo of [
    { code: 403, data: { user: { tenantId: '135' } } },
    { data: { user: { tenantId: '135' } } },
    { code: 0, success: false, data: { user: { tenantId: '135' } } },
    null
  ]) {
    assert.throws(() => resolveProcurementTenantId({
      permissionInfo, expectedTenantId: ''
    }), /权限上下文 business failure/)
  }
})

const credentials = {
  purchaseApproverUsername: 'purchase-test', purchaseApproverPassword: 'test-purchase-secret',
  financeApproverUsername: 'finance-test', financeApproverPassword: 'test-finance-secret',
  finalApproverUsername: 'final-test', finalApproverPassword: 'test-final-secret'
}

test('PROC-018 requires all three approval credentials before it can write', () => {
  assert.doesNotThrow(() => assertProcurementApproverCredentials(credentials))
  for (const key of Object.keys(credentials)) {
    for (const value of ['', undefined, null, '  ']) {
      assert.throws(() => assertProcurementApproverCredentials({
        ...credentials, [key]: value
      }), /BLOCKED.*尚未创建或提审请购/)
    }
  }
})

test('PROC-018 credential errors never expose configured secrets', () => {
  assert.throws(() => assertProcurementApproverCredentials({
    ...credentials, finalApproverUsername: ''
  }), (error) => !error.message.includes('test-purchase-secret') &&
      !error.message.includes('test-finance-secret') &&
      !error.message.includes('test-final-secret'))
})

test('PROC-018 checks approval credentials before login and fixture creation', () => {
  const source = fs.readFileSync(new URL('../suites/procurement.mjs', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("if (caseId === 'PROC-018')"))
  const preflight = branch.indexOf('assertProcurementApproverCredentials()')
  assert.ok(preflight >= 0)
  assert.ok(preflight < branch.indexOf('resolveProcurementTenantContext('))
  assert.ok(preflight < branch.indexOf('createPurchaseRequest('))
})
