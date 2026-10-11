import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PMS_CATALOG_ASSERTIONS, initializePmsCatalogAssertions, markPmsCatalogAssertion } from '../suites/hrm-pms-oa.mjs'

const suite = readFileSync(
  fileURLToPath(new URL('../suites/hrm-pms-oa.mjs', import.meta.url)),
  'utf8'
)

test('PMS-001 uses the formal /pms/pm domain instead of the customer-delivery /pm domain', () => {
  assert.match(suite, /\/pms\/pm\/project\/create/)
  assert.match(suite, /\/pms\/pm\/project\/page\?pageNo=1&pageSize=100&status=1&sceneType=1/)
  assert.match(suite, /\/pms\/pm\/project-member\/list\?projectId=/)
  assert.match(suite, /\/pms\/pm\/work-item\/create/)
  assert.match(suite, /\/pms\/pm\/work-item\/update-status/)
  assert.match(suite, /\/pms\/pm\/work-item-comment\/create/)
  assert.match(suite, /\/pms\/pm\/work-item-work-log\/create/)
  assert.match(suite, /\/pms\/pm\/work-item-work-log\/summary\?workItemId=/)
  assert.match(suite, /\/pms\/pm\/project\/recycle\?id=/)
  assert.match(suite, /\/pms\/pm\/project\/restore\?id=/)
  assert.doesNotMatch(suite, /getBusiness\('\/pm\/project\/page/)
  assert.doesNotMatch(suite, /getBusiness\('\/pm\/project-role\/list/)
  assert.doesNotMatch(suite, /getBusiness\('\/pm\/task\/page/)
  assert.doesNotMatch(suite, /getBusiness\('\/pm\/project\/workbench-summary/)
})

test('PMS-001 opens the formal PMS project list route and keeps catalog completion evidence-based', () => {
  assert.match(suite, /openRoute\(page, '\/pms\/pm\/project\/list'/)
  assert.match(suite, /PMS-001 catalog 断言未验证/)
  assert.match(suite, /catalogComplete = caseRecord\.catalogAssertions\.length > 0/)
  assert.doesNotMatch(suite, /openRoute\(page, '\/project\/execution\/project\/list'\)/)
})

test('PMS-001 preserves all five original assertions and records the verified closure run', () => {
  const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === 'PMS-001')
  assert.deepEqual(definition.assertions, ['成员权限', '状态流转', '评论参与权', '实际工时非负', '跨租户不可见'])
  assert.deepEqual([...PMS_CATALOG_ASSERTIONS], definition.assertions)
  assert.equal(definition.status, 'READY')
  assert.equal(definition.acceptanceEvidence.runId, '20261011064621779-86524')
  assert.equal(definition.acceptanceEvidence.checks.length, 8)
  assert.deepEqual(definition.reverse, ['回收站恢复而非直接删除'])
  assert.ok(definition.database.includes('pms_work_item_work_log'))
})

test('PMS catalog assertions cannot complete without every exact successful evidence check', () => {
  const record = { checks: [] }
  initializePmsCatalogAssertions(record)
  assert.equal(markPmsCatalogAssertion(record, 0, []), false)
  assert.equal(markPmsCatalogAssertion(record, 0, ['missing']), false)
  record.checks.push({ name: 'failed', passed: false, details: 'failure' })
  assert.equal(markPmsCatalogAssertion(record, 0, ['failed']), false)
  record.checks.push({ name: 'verified', passed: true, details: 'readback' })
  assert.equal(markPmsCatalogAssertion(record, 0, ['verified']), true)
  assert.equal(markPmsCatalogAssertion(record, 0, ['verified'], 'remaining gap'), false)
})
