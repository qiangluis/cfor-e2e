import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  CRM_ACTOR_CASES,
  CRM_ACTOR_CASE_PROFILES
} from '../fixtures/crm-acceptance-actor.mjs'
import { cases, crmReadOnlyViews } from '../suites/crm.mjs'

const suiteSource = fs.readFileSync(
  new URL('../suites/crm.mjs', import.meta.url), 'utf8'
)
const actorSource = fs.readFileSync(
  new URL('../fixtures/crm-acceptance-actor.mjs', import.meta.url), 'utf8'
)

function caseSource(caseId) {
  const current = suiteSource.indexOf(`async function crmCase${caseId.slice(-3)}`)
  const next = suiteSource.indexOf('\nasync function crmCase', current + 1)
  return suiteSource.slice(current, next === -1 ? suiteSource.length : next)
}

test('CRM actor owns exactly the four formal acceptance cases and their current pages', () => {
  assert.deepEqual(CRM_ACTOR_CASES, [
    'CRM-BASE-001', 'CRM-BASE-002', 'CRM-BASE-003', 'CRM-BASE-005'
  ])
  for (const caseId of CRM_ACTOR_CASES) {
    assert.ok(cases.includes(caseId), `${caseId} must remain in the CRM suite`)
    assert.deepEqual(CRM_ACTOR_CASE_PROFILES[caseId].pageComponents,
      [crmReadOnlyViews[caseId].component], caseId)
  }
})

test('CRM-BASE-002 and CRM-BASE-005 create owned customers directly with the actor userId', () => {
  const customerFixture = suiteSource.slice(
    suiteSource.indexOf('async function createCrmCustomerFixture'),
    suiteSource.indexOf('\nasync function createOrReuseCrmCustomerFixture')
  )
  assert.match(customerFixture, /ownerUserId: userId/)
  for (const caseId of ['CRM-BASE-002', 'CRM-BASE-005']) {
    const source = caseSource(caseId)
    assert.match(source, /createCrmCustomerFixture\(api, caseRecord, userId/)
    assert.doesNotMatch(source, /createOrReuseCrmCustomerFixture/)
    assert.doesNotMatch(source, /customer-limit-config|tenant-package/)
  }
})

test('suite routes the four actor cases through the actor callback and preserves the owner callback', () => {
  const runCaseSource = suiteSource.slice(suiteSource.indexOf('export const runCase'))
  assert.match(runCaseSource, /CRM_ACTOR_CASES\.includes\(context\.caseId\)/)
  assert.match(runCaseSource, /actorContext, actorApi, actorId/)
  assert.match(runCaseSource, /runCrmWriteCase\(actorContext, actorApi, actorId/)
  assert.doesNotMatch(actorSource, /customer-limit-config/)
  assert.match(actorSource, /system\/tenant-package\/get/)
  assert.doesNotMatch(actorSource, /system\/tenant-package\/(?:create|update|delete)/)
})
