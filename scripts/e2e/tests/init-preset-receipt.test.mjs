import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasInitSettingsOverview, sameInitPresetReceipt
} from '../fixtures/init-local-closure.mjs'

const receipt = () => ({
  applied: true,
  modules: ['system'],
  added: 0,
  skipped: 15,
  modified: 1,
  conflicts: 0,
  contributions: [{
    key: 'system.config.preset',
    module: 'system',
    title: 'Business configuration',
    status: 'READY',
    actionPath: null,
    actionLabel: null,
    added: 0,
    skipped: 15,
    modified: 1,
    conflicts: 0,
    messages: ['Preserved tenant configuration']
  }]
})

test('persisted receipts allow only omitted nullable action links', () => {
  const api = receipt()
  const stored = receipt()
  delete stored.contributions[0].actionPath
  delete stored.contributions[0].actionLabel
  assert.equal(sameInitPresetReceipt(api, stored), true)
  assert.equal(sameInitPresetReceipt(stored, api), true)
})

test('receipt comparison retains non-null action links and all business fields', () => {
  const baseline = receipt()
  for (const change of [
    (value) => { value.added = 1 },
    (value) => { value.modules = ['erp'] },
    (value) => { value.contributions[0].modified = 0 },
    (value) => { value.contributions[0].status = 'CONFLICT' },
    (value) => { value.contributions[0].messages = [] },
    (value) => { value.contributions[0].actionPath = '/settings/enterprise' },
    (value) => { delete value.contributions[0].title },
    (value) => { delete value.contributions[0].status }
  ]) {
    const changed = receipt()
    change(changed)
    assert.equal(sameInitPresetReceipt(changed, baseline), false)
  }
})

test('malformed or unapplied receipts cannot pass persisted receipt comparison', () => {
  for (const invalid of [null, {}, { ...receipt(), applied: false }, {
    ...receipt(), contributions: []
  }]) {
    assert.equal(sameInitPresetReceipt(invalid, receipt()), false)
    assert.equal(sameInitPresetReceipt(receipt(), invalid), false)
  }
})

test('settings directories and their leaf pages are not overview evidence', () => {
  const menus = [{
    path: '/settings',
    children: [{
      path: 'business-settings',
      children: [{
        path: '/settings/erp', component: null,
        children: [{ path: 'material', component: 'base/material/index' }]
      }]
    }]
  }]
  assert.equal(hasInitSettingsOverview(menus, 'enterprise'), false)
  assert.equal(hasInitSettingsOverview(menus, 'erp'), false)
  assert.equal(hasInitSettingsOverview(null, 'erp'), false)
  menus[0].children[0].children[0].component = 'system/systemSettings/index'
  assert.equal(hasInitSettingsOverview(menus, 'erp'), true)
  assert.equal(hasInitSettingsOverview(menus, 'enterprise'), false)
})
