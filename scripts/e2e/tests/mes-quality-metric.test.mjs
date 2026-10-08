import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  QUALITY_METRIC_DETAIL_PAGE_SIZE,
  QUALITY_METRIC_FIXTURE_INSPECTION_COUNT,
  QUALITY_METRIC_OVERSIZED_PAGE_SIZE,
  assertQualityMetricFixtureScope,
  assertQualityMetricWritePreflight,
  evaluateMetricPageClamp
} from '../suites/mes-quality.mjs'

const local = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}

test('quality metric writes reject a remote target, another tenant or another database', () => {
  assert.doesNotThrow(() => assertQualityMetricFixtureScope(local))
  for (const change of [
    { target: 'production' }, { tenantId: '2' }, { tenantName: 'Other' },
    { apiBase: 'http://example.invalid:48083' }, { webBase: 'http://127.0.0.1:9152' },
    { apiBase: 'http://user:secret@127.0.0.1:48083' },
    { db: { ...local.db, name: 'cfor_admin_saas_standard' } },
    { db: { ...local.db, host: '192.168.110.252' } }
  ]) assert.throws(() => assertQualityMetricFixtureScope({ ...local, ...change }), /BLOCKED:/)
})

test('quality metric preflight requires a matching live tenant and safety checks before fixture writes', async () => {
  let safetyCalls = 0
  const dependencies = {
    config: local,
    assertLocalWriteSafety: async () => { safetyCalls++ }
  }
  const context = {
    auth: { token: 'unit-token', tenantId: '1' }, caseRecord: {},
    api: { tenantIdByName: async () => '1' }
  }
  await assertQualityMetricWritePreflight(context, dependencies)
  assert.equal(safetyCalls, 1)
  for (const auth of [{}, { token: 'unit-token', tenantId: '2' }]) {
    await assert.rejects(assertQualityMetricWritePreflight({ ...context, auth }, dependencies), /BLOCKED:/)
  }
  await assert.rejects(assertQualityMetricWritePreflight({
    ...context, api: { tenantIdByName: async () => '2' }
  }, dependencies), /BLOCKED:/)
  assert.equal(safetyCalls, 1)
  await assert.rejects(assertQualityMetricWritePreflight(context, {
    ...dependencies, assertLocalWriteSafety: async () => { throw new Error('BLOCKED: enabled jobs') }
  }), /BLOCKED: enabled jobs/)
})

test('quality metric page contract uses 100 rows and clamps pageSize=500', () => {
  assert.equal(QUALITY_METRIC_DETAIL_PAGE_SIZE, 100)
  assert.equal(QUALITY_METRIC_OVERSIZED_PAGE_SIZE, 500)
  assert.notEqual(QUALITY_METRIC_DETAIL_PAGE_SIZE, QUALITY_METRIC_OVERSIZED_PAGE_SIZE)
  assert.equal(QUALITY_METRIC_FIXTURE_INSPECTION_COUNT, 101)
})

test('quality metric page clamp requires exactly 100 rows and stable total', () => {
  assert.equal(
    evaluateMetricPageClamp({
      response: { code: 0, data: { list: Array.from({ length: 100 }, () => ({})), total: 101 } },
      apiEntry: { status: 200 },
      expectedRows: 100,
      expectedTotal: 101
    }).passed,
    true
  )
  assert.equal(
    evaluateMetricPageClamp({
      response: { code: 0, data: { list: Array.from({ length: 101 }, () => ({})), total: 101 } },
      apiEntry: { status: 200 },
      expectedRows: 100,
      expectedTotal: 101
    }).passed,
    false
  )
  assert.equal(
    evaluateMetricPageClamp({
      response: { code: 0, data: { list: Array.from({ length: 100 }, () => ({})), total: 100 } },
      apiEntry: { status: 200 },
      expectedRows: 100,
      expectedTotal: 101
    }).passed,
    false
  )
})

test('quality metric page evidence rejects HTTP-only success, empty rows and business errors', () => {
  const response = {
    code: 0,
    data: { list: Array.from({ length: 100 }, () => ({})), total: 101 }
  }
  for (const candidate of [
    { response: {}, apiEntry: { status: 200 } },
    { response: { code: 0, data: { list: [], total: 0 } }, apiEntry: { status: 200 } },
    { response: { code: 0, data: { list: [], total: 101 } }, apiEntry: { status: 200 } },
    { response: { code: 0, data: { total: 101 } }, apiEntry: { status: 200 } },
    { response: { ...response, code: 403 }, apiEntry: { status: 200 } },
    { response, apiEntry: { status: 403 } }
  ]) {
    assert.equal(evaluateMetricPageClamp({
      ...candidate,
      expectedRows: QUALITY_METRIC_DETAIL_PAGE_SIZE,
      expectedTotal: QUALITY_METRIC_FIXTURE_INSPECTION_COUNT
    }).passed, false)
  }
})

test('quality metric case creates an owned legal fixture before aggregating and cleans it afterwards', () => {
  const source = fs.readFileSync(new URL('../suites/mes-quality.mjs', import.meta.url), 'utf8')
  const fixtureStart = source.indexOf('const createQualityMetricFixture')
  const metricStart = source.indexOf('const runQualityMetricCase')
  assert.ok(fixtureStart >= 0)
  assert.ok(metricStart > fixtureStart)
  const metricSource = source.slice(metricStart)
  assert.ok(metricSource.indexOf('assertQualityMetricWritePreflight') <
    metricSource.indexOf('createQualityMetricFixture({ api, caseRecord })'))
  assert.ok(metricSource.indexOf('createQualityMetricFixture({ api, caseRecord })') < metricSource.indexOf("/mes/quality/metric/report"))
  assert.match(source, /\/mes\/quality\/item\/add/)
  assert.match(source, /\/mes\/quality\/qualityPlan\/add/)
  assert.match(source, /\/mes\/quality\/qualityMaterial\/addBatch/)
  assert.match(source, /\/mes\/quality\/qualityInspection\/add\/submit/)
  assert.match(source, /billNo:\s*`\$\{token\}-QC-/)
  assert.match(source, /qualityInspection\/void/)
  assert.match(source, /QUALITY_METRIC_FIXTURE_INSPECTION_COUNT/)
  assert.match(source, /pageNo=\$\{pageNo\}&pageSize=\$\{QUALITY_METRIC_OVERSIZED_PAGE_SIZE\}/)
  assert.match(source, /page1Rows=/)
  assert.match(source, /page2Rows=/)
  assert.match(source, /materialId=/)
  assert.match(source, /finally\s*\{\s*await metricFixture\.cleanup\(\)/s)
  assert.doesNotMatch(source, /UPDATE\s+mes_quality|INSERT\s+INTO\s+mes_quality/i)
})
