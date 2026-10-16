import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertOwnedPartnerPage, matchesOwnedPartnerQuery
} from '../fixtures/partner-browser.mjs'

const partner = {
  id: '2110003386787905538', partnerCode: 'PB034owned', name: 'PB034 OWNED',
  taxNo: 'PB034TAXowned',
  customerEnabled: true, supplierEnabled: true, carrierEnabled: true
}
const response = (query, method = 'GET', path = '/admin-api/base/partner/page') => ({
  url: () => `http://127.0.0.1:48083${path}?${query}`,
  request: () => ({ method: () => method })
})
const payload = () => ({ code: 0, data: { list: [structuredClone(partner)], total: 1 } })

test('partner browser waits for the exact submitted keyword and bounded first page', () => {
  const query = 'keyword=PB034owned&pageNo=1&pageSize=100'
  assert.equal(matchesOwnedPartnerQuery(response(query), partner.partnerCode), true)
  for (const candidate of [
    response('pageNo=1&pageSize=100'),
    response(query.replace('PB034owned', 'foreign')),
    response(query.replace('pageNo=1', 'pageNo=2')),
    response(query.replace('pageSize=100', 'pageSize=200')),
    response(query, 'POST'),
    response(query, 'GET', '/admin-api/crm/customer/page')
  ]) assert.equal(matchesOwnedPartnerQuery(candidate, partner.partnerCode), false)
})

test('partner browser requires a unique owned positive control and every rendered role', () => {
  assert.deepEqual(assertOwnedPartnerPage(payload(), partner), partner)
  const mutations = [
    (value) => { value.code = 500 },
    (value) => { value.success = false },
    (value) => { value.data.list = [] },
    (value) => { value.data.total = 101 },
    (value) => { value.data.list.push(structuredClone(partner)) },
    (value) => { value.data.list[0].id = '2110003397428854786' },
    (value) => { value.data.list[0].partnerCode = 'foreign' },
    (value) => { value.data.list[0].name = 'foreign' },
    (value) => { value.data.list[0].taxNo = 'foreign' },
    ...['customerEnabled', 'supplierEnabled', 'carrierEnabled']
      .map((field) => (value) => { value.data.list[0][field] = false })
  ]
  for (const mutate of mutations) {
    const value = payload()
    mutate(value)
    assert.throws(() => assertOwnedPartnerPage(value, partner))
  }
})
