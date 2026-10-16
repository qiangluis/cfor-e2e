import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../suites/wms-quality.mjs', import.meta.url), 'utf8')
const start = source.indexOf('const wmsCatalogEvidence =')
const end = source.indexOf('\nexport const strictList', start)
const module = await import('data:text/javascript,' + encodeURIComponent(
  "import fs from 'node:fs';\n" +
  source.slice(start, end).replace(
    "new URL('../cases/catalog.json', import.meta.url)",
    JSON.stringify(new URL('../cases/catalog.json', import.meta.url).pathname)
  ) + '\nexport { wmsCatalogEvidence };'
))
const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url)))

test('WMS audit gaps cannot be erased by passed original catalog checks', () => {
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'WMS-QC-008')
  const record = {
    checks: [{ name: 'original check', passed: true }], notes: []
  }
  module.wmsCatalogEvidence('WMS-QC-008', record, Object.fromEntries(
    definition.assertions.map((_, index) => [index, ['original check']])
  ))
  assert.equal(record.passCandidate, false)
  assert.deepEqual(record.remainingAssertions, definition.acceptanceGaps)
  assert.equal(record.catalogAssertions.filter((item) => item.status === 'VERIFIED').length,
    definition.assertions.length)
})

test('WMS rule disable request does not round snowflake identifiers', () => {
  const block = source.slice(source.indexOf('const disabledRule = {'),
    source.indexOf("'QC-006 映射规则停用'"))
  assert.match(block, /id: String\(ruleId\)/)
  assert.doesNotMatch(block, /Number\(ruleId\)/)
})
