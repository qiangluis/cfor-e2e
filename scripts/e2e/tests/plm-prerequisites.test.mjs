import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { menuRoute, releaseFacts, strictList, strictTree } from '../suites/plm.mjs'

test('PLM list parser rejects empty object masquerading as rows', () => {
  assert.deepEqual(strictList({ data: { records: [] }}), [])
  assert.throws(() => strictList({ data: {} }), /列表响应/)
  assert.throws(() => strictList({ data: [{}] }), /列表响应/)
  assert.deepEqual(strictTree({ data: { children: [] }}), [])
  assert.throws(() => strictTree({ data: [{}] }), /树响应/)
})

test('PLM route resolution uses actual menu component and nested path', () => {
  const menus = [{
    path: '/plm',
    children: [{ path: 'baseline', component: 'plm/core/baseline/index.vue' }]
  }]
  assert.equal(menuRoute(menus, ['plm/core/baseline/index']), '/plm/baseline')
  assert.equal(menuRoute(menus, ['plm/core/missing/index']), null)
  assert.equal(menuRoute([
    { path: '/legacy/product', component: 'plm/product-part/product-ledger/index' },
    { path: '/plm/product-part/product-ledger', component: 'plm/product-part/product-ledger/index' }
  ], ['plm/product-part/product-ledger']), '/plm/product-part/product-ledger')
})

test('PLM release facts require formal release evidence', () => {
  const facts = releaseFacts(
    [{ id: 1, status: 'RELEASED', versionNo: 'V1', productId: 2, releaseTime: '2026-10-06T00:00:00' }],
    [{ operationType: 'check', resultStatus: 'SUCCESS', baselineId: 1 }]
  )
  assert.equal(facts.released.length, 1)
  assert.equal(facts.receipts.length, 0)
  assert.equal(facts.partial, true)
})

test('PLM release receipts must belong to the same released baseline and product', () => {
  const facts = releaseFacts(
    [{ id: 'baseline-1', status: 'RELEASED', versionNo: 'V1', productId: 'product-1', releaseTime: '2026-10-06T00:00:00' }],
    [
      {
        operationType: 'release',
        resultStatus: 'SUCCESS',
        mesReceived: true,
        baselineId: 'baseline-2',
        productId: 'product-1',
        targetMaterialId: 'material-1',
        businessKey: 'PLM-RELEASE-2'
      },
      {
        operationType: 'release',
        resultStatus: 'SUCCESS',
        mesReceived: true,
        baselineId: 'baseline-1',
        productId: 'product-2',
        targetMaterialId: 'material-1',
        businessKey: 'PLM-RELEASE-WRONG-PRODUCT'
      },
      {
        operationType: 'release',
        resultStatus: 'SUCCESS',
        mesReceived: true,
        baselineId: 'baseline-1',
        productId: 'product-1',
        targetMaterialId: 'material-1',
        businessKey: 'PLM-RELEASE-1'
      }
    ]
  )
  assert.equal(facts.released.length, 1)
  assert.deepEqual(facts.receipts.map((row) => row.businessKey), ['PLM-RELEASE-1'])
})

test('PLM missing version and dryRun success never become formal release evidence', () => {
  const facts = releaseFacts(
    [{ id: 1, status: 'RELEASED', versionNo: null, productId: 2 }],
    [{ operationType: 'dryRun', resultStatus: 'SUCCESS', mesReceived: true }]
  )
  assert.equal(facts.released.length, 0)
  assert.equal(facts.receipts.length, 0)
  assert.equal(facts.partial, true)
})

test('PLM target suite does not call mutating release APIs', () => {
  const source = fs.readFileSync(new URL('../suites/plm.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\/(create|update|status|freeze|release|release-to-mes|mbom-release|save-line|delete-line)/)
  assert.doesNotMatch(source, /api\.(post|put|delete)/)
  assert.doesNotMatch(source, /getBusiness\([^)]*route-context/)
  assert.doesNotMatch(source, /readySelector: 'body'/)
  assert.match(source, /partial: true/)
})
