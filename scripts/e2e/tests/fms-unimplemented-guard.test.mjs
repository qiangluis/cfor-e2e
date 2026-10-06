import test from 'node:test'
import assert from 'node:assert/strict'
import { runCase } from '../suites/fms.mjs'
import { caseOutcome, createCaseRecord } from '../lib/report.mjs'

for (const caseId of ['FMS-003', 'FMS-004']) {
  for (const hasAssertions of [false, true]) {
    test(`${caseId} stays PARTIAL with hasAssertions=${hasAssertions} without login or API access`, async () => {
      const caseRecord = createCaseRecord({ id: caseId, suite: 'fms' })
      if (hasAssertions) {
        caseRecord.checks.push({ name: 'Configured account set exists', passed: true })
      }
      const checksBefore = [...caseRecord.checks]
      const forbiddenAccess = new Proxy({}, {
        get () { throw new Error('Browser or API access is forbidden') }
      })
      const result = await runCase({
        caseId,
        caseRecord,
        page: forbiddenAccess,
        record: forbiddenAccess
      })

      assert.equal(result.notImplemented, true)
      assert.match(result.note, new RegExp(caseId))
      assert.deepEqual(caseRecord.checks, checksBefore)
      assert.deepEqual(caseRecord.evidence, [])
      const outcome = caseOutcome({
        failedChecks: [],
        partial: false,
        hasAssertions,
        result
      })
      assert.equal(outcome.status, 'PARTIAL')
      assert.equal(outcome.note, result.note)
    })
  }

  test(`${caseId} unimplemented guard does not mask failed assertions`, async () => {
    const result = await runCase({ caseId })
    assert.equal(caseOutcome({
      failedChecks: [{ name: 'Existing failure', passed: false }],
      partial: false,
      hasAssertions: true,
      result
    }).status, 'FAIL')
  })
}
