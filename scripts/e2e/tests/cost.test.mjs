import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../suites/cost.mjs', import.meta.url), 'utf8')
const cost029 = source.slice(
  source.indexOf("if (caseId === 'COST-029')"),
  source.indexOf("if (caseId === 'COST-030')")
)

test('COST-029 preserves Snowflake department IDs in the request payload', () => {
  assert.match(cost029, /departmentIds:\s*\[availableDepartment\.id\]/)
  assert.doesNotMatch(cost029, /departmentIds:\s*\[Number\(availableDepartment\.id\)\]/)
})
