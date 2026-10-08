import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PARTNER_ROLE_IN_USE_CODE,
  PARTNER_CODE_IMMUTABLE_CODE,
  assertPartnerCodeImmutableRejected,
  assertPartnerRoleDeleteRejected,
  findMenuRouteByComponent,
  isStableId,
  partnerRoleFilterMatches
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
  assert.equal(assertPartnerCodeImmutableRejected({ code: PARTNER_CODE_IMMUTABLE_CODE }), true)
  for (const code of [0, 200, 400, 500, undefined]) {
    assert.throws(() => assertPartnerCodeImmutableRejected({ code }), /1001003005/)
  }
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
  assert.equal(assertPartnerRoleDeleteRejected({ code: PARTNER_ROLE_IN_USE_CODE }), true)
  assert.throws(
    () => assertPartnerRoleDeleteRejected({ code: 0 }),
    /1001003007/
  )
})
