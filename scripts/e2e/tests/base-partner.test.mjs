import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  PARTNER_ROLE_IN_USE_CODE,
  PARTNER_ROLE_IN_USE_MESSAGE,
  PARTNER_CODE_IMMUTABLE_CODE,
  PARTNER_CODE_IMMUTABLE_MESSAGE,
  PARTNER_ROLE_DELETE_REJECTION,
  PARTNER_CODE_IMMUTABLE_REJECTION,
  assertPartnerCodeImmutableRejected,
  assertPartnerRoleDeleteRejected,
  findMenuRouteByComponent,
  isStableId,
  partnerRoleFilterMatches,
  partnerAcceptanceBoundary
} from '../suites/base-partner.mjs'

test('PB034-002 accepts only a stable positive partner id', () => {
  assert.equal(isStableId(123), true)
  assert.equal(isStableId('123456789012345678'), true)
  assert.equal(isStableId(0), false)
  assert.equal(isStableId('0'), false)
  assert.equal(isStableId('partner-1'), false)
  assert.equal(isStableId({ data: 123 }), false)
})

test('PB034-002 code immutability rejects only its exact business code, not a server error', () => {
  assert.equal(assertPartnerCodeImmutableRejected({
    code: PARTNER_CODE_IMMUTABLE_CODE, msg: PARTNER_CODE_IMMUTABLE_MESSAGE
  }), true)
  for (const response of [
    { code: PARTNER_CODE_IMMUTABLE_CODE },
    { code: PARTNER_CODE_IMMUTABLE_CODE, msg: '服务器异常' },
    { code: 0, msg: PARTNER_CODE_IMMUTABLE_MESSAGE },
    { code: 500, msg: PARTNER_CODE_IMMUTABLE_MESSAGE },
    { code: undefined, msg: PARTNER_CODE_IMMUTABLE_MESSAGE }
  ]) {
    assert.throws(() => assertPartnerCodeImmutableRejected(response), /1001003005/)
  }
  assert.deepEqual(PARTNER_CODE_IMMUTABLE_REJECTION, {
    code: PARTNER_CODE_IMMUTABLE_CODE, message: PARTNER_CODE_IMMUTABLE_MESSAGE
  })
})

test('PB034-002 role filtering must prove both inclusion and exclusion with valid rows', () => {
  assert.equal(partnerRoleFilterMatches([{ id: '10' }], '10', true), true)
  assert.equal(partnerRoleFilterMatches([{ id: '11' }], '10', false), true)
  assert.equal(partnerRoleFilterMatches([{ id: '10' }], '10', false), false)
  assert.equal(partnerRoleFilterMatches([], '10', true), false)
  assert.equal(partnerRoleFilterMatches(null, '10', false), false)
  assert.equal(partnerRoleFilterMatches([{}], '10', false), false)
})

test('PB034-002 resolves the complete route from the authorized menu component', () => {
  const menus = [{
    path: 'settings',
    children: [{
      path: 'erp',
      children: [{ path: 'partner', component: 'base/partner/index' }]
    }]
  }]
  assert.equal(findMenuRouteByComponent(menus, 'base/partner/index'), '/settings/erp/partner')
  assert.equal(findMenuRouteByComponent(menus, 'missing/index'), null)
})

test('PB034-002 requires the multi-role business rejection code after an HTTP-successful request', () => {
  assert.equal(assertPartnerRoleDeleteRejected({
    code: PARTNER_ROLE_IN_USE_CODE, msg: PARTNER_ROLE_IN_USE_MESSAGE
  }), true)
  for (const response of [
    { code: PARTNER_ROLE_IN_USE_CODE },
    { code: PARTNER_ROLE_IN_USE_CODE, msg: '系统异常' },
    { code: 0, msg: PARTNER_ROLE_IN_USE_MESSAGE },
    { code: 500, msg: PARTNER_ROLE_IN_USE_MESSAGE }
  ]) {
    assert.throws(() => assertPartnerRoleDeleteRejected(response), /1001003007/)
  }
  assert.deepEqual(PARTNER_ROLE_DELETE_REJECTION, {
    code: PARTNER_ROLE_IN_USE_CODE, message: PARTNER_ROLE_IN_USE_MESSAGE
  })
})

test('PB034-002 keeps PARTIAL until backend and cross-tenant evidence are explicit', () => {
  assert.deepEqual(partnerAcceptanceBoundary(), {
    acceptanceComplete: false,
    blockers: [
      '当前后端实例尚未完成真实 API/数据库复验',
      '尚缺第二租户真实身份的读取/写入拒绝证据'
    ]
  })
  assert.deepEqual(partnerAcceptanceBoundary({ backendRevalidated: true }), {
    acceptanceComplete: false,
    blockers: ['尚缺第二租户真实身份的读取/写入拒绝证据']
  })
  assert.deepEqual(partnerAcceptanceBoundary({
    backendRevalidated: true,
    crossTenantEvidence: true
  }), {
    acceptanceComplete: true,
    blockers: []
  })
})

test('PB034-002 legacy customer page is queried by the owned legacy code', () => {
  const source = fs.readFileSync(new URL('../suites/base-partner.mjs', import.meta.url), 'utf8')
  assert.match(source, /erp\/customer\/page\?pageNo=1&pageSize=100&keyword=.*legacyCode/)
  assert.match(source, /base\/partner\/page\?pageNo=1&pageSize=100&keyword=.*legacyCode/)
})

test('PB034-002 suite uses the real second-tenant fixture and does not leave token recovery undefined', () => {
  const suite = fs.readFileSync(new URL('../suites/base-partner.mjs', import.meta.url), 'utf8')
  const fixture = fs.readFileSync(new URL('../fixtures/partner-isolation.mjs', import.meta.url), 'utf8')
  assert.match(suite, /export const runCase = async \(context\) =>/)
  assert.match(suite, /const \{ caseId, page, record, caseRecord, outputDir \} = context/)
  assert.match(suite, /runPartnerIsolationEvidence\(\{\s*context,/)
  assert.match(suite, /runPartnerIsolationEvidence/)
  assert.match(suite, /crossTenantEvidence/)
  assert.match(suite, /tenantPage/)
  assert.match(suite, /saveScreenshot\(tenantPage, outputDir, `pb034-owned-partner-\$\{tenantId\}`, record\)/)
  assert.match(fixture, /const loggedOutTokens = new Set\(\)/)
  assert.match(fixture, /id\(auth\.tenantId\) === fixture\.tenantId/)
})
