import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isSalesPriceFixture,
  priceCenterReadySelector,
  priceCenterRoute
} from '../suites/erp-sales.mjs'
import {
  settlementRuleReadySelector,
  settlementRuleRoute
} from '../suites/erp-settlement.mjs'
import {
  crmMenuRoute,
  crmReadOnlyViews,
  followUpRuleReadySelector,
  followUpRuleRows,
  followUpRuleRoute
} from '../suites/crm.mjs'

test('CRM customer and opportunity pages follow the authorized nested menu routes', () => {
  const menus = [{
    path: '/crm',
    children: [{
      path: 'menu',
      children: [
        { path: 'customer-operation', children: [{
          path: 'private-pool', component: 'crm/jixu/privatePool/index.vue?archive=all'
        }] },
        { path: 'sales-progress', children: [{
          path: 'chance', component: 'crm/jixu/chance/index.vue?tab=all'
        }] }
      ]
    }]
  }]
  assert.equal(crmMenuRoute(menus, crmReadOnlyViews['CRM-BASE-002'].component),
    '/crm/menu/customer-operation/private-pool')
  assert.equal(crmMenuRoute(menus, crmReadOnlyViews['CRM-BASE-006'].component),
    '/crm/menu/sales-progress/chance')
  assert.equal(crmReadOnlyViews['CRM-BASE-002'].route, undefined)
  assert.equal(crmReadOnlyViews['CRM-BASE-006'].route, undefined)
})

test('ERP and CRM settings use confirmed backend menu routes', () => {
  assert.equal(priceCenterRoute, '/settings/erp/price-center')
  assert.equal(settlementRuleRoute, '/settings/erp/settle-method-rule')
  assert.equal(followUpRuleRoute, '/settings/crm/follow-up-type-rule')
  assert.match(priceCenterReadySelector, /统一取价/)
  assert.match(settlementRuleReadySelector, /允许账户类型/)
  assert.match(followUpRuleReadySelector, /允许的附件类型/)
})

test('price fixture cleanup only matches this case and the same priority', () => {
  const base = {
    id: '101',
    priceDirection: 'SALE',
    status: 1,
    priority: 0,
    remark: 'ERP-SALES-006 automated e2e'
  }
  assert.equal(isSalesPriceFixture({ ...base, code: 'E2E_SALE_OLD' }, 0), true)
  assert.equal(isSalesPriceFixture({ ...base, code: 'AUTOTEST-ERP-SALES-006-old' }, '0'), true)
  assert.equal(isSalesPriceFixture({ ...base, code: 'E2E_SALE_OLD' }, 1), false)
  assert.equal(
    isSalesPriceFixture({ ...base, code: 'E2E_SALE_OTHER', remark: 'manual price' }, 0),
    false
  )
  assert.equal(
    isSalesPriceFixture({ ...base, code: 'SALE_DEFAULT', remark: base.remark }, 0),
    false
  )
})

test('CRM rule list unwraps data and rejects an envelope or object as rows', () => {
  assert.deepEqual(followUpRuleRows({ code: 0, data: [] }), [])
  assert.deepEqual(followUpRuleRows({ code: 0, data: [{ dictValue: 1 }] }), [{ dictValue: 1 }])
  assert.throws(() => followUpRuleRows({ code: 0, data: {} }), /data 必须为数组/)
  assert.throws(() => followUpRuleRows({ code: 0, data: null }), /data 必须为数组/)
})
