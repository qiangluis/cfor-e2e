import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  cases, caseRegistry, developmentGapGroups, unconfirmedCaseGroups, excludedCaseGroups,
  validateTagUsage, tagTableMatches,
  tagIdentity, isTagResponse, captureTagUsage, readTagUsage, waitForTagTable
} from '../suites/crm-missing-readonly.mjs'
import { caseOutcome } from '../lib/report.mjs'
import { config } from '../config/index.mjs'

const success = (data) => ({ code: 0, data })
const definition = { id: '9007199254740993', code: 'MANUAL_A', name: 'A', tagType: 'MANUAL', status: 1 }
const summary = { tagId: definition.id, code: definition.code, name: definition.name,
  tagType: definition.tagType, status: definition.status, customerCount: 0 }
const page = (rows = [definition], total = rows.length) => success({ list: rows, total })
const usage = (rows = [summary]) => success(rows)
const record = () => ({ checks: [], notes: [], evidence: [] })
const response = (endpoint, data, options = {}) => ({
  url: () => `${config.apiUrl}${endpoint}${options.query || ''}`,
  request: () => ({ method: () => options.method || 'GET' }),
  ok: () => options.ok !== false,
  headers: () => ({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(data)
})
const definitionPath = '/crm/customer-tag/definition/page'
const summaryPath = '/crm/customer-tag/report/summary'

test('only PB052 is runnable; 9 documented cases are deployment gaps and 23 remain unconfirmed', () => {
  assert.deepEqual(cases, ['PB052-001'])
  const metadata = caseRegistry[0]
  assert.equal(metadata.suite, 'crm-missing-readonly')
  assert.equal(metadata.resultCeiling, 'PARTIAL')
  assert.equal(metadata.mode, 'READ_ONLY')
  assert.deepEqual(metadata.pbScope, ['PB-052'])
  const deploymentGaps = developmentGapGroups.flatMap((group) => group.ids)
  const unconfirmed = unconfirmedCaseGroups.flatMap((group) => group.ids)
  const excluded = excludedCaseGroups.flatMap((group) => group.ids)
  assert.equal(deploymentGaps.length, 9)
  assert.equal(unconfirmed.length, 23)
  assert.equal(excluded.length, 32)
  assert.equal(new Set(excluded).size, 32)
  assert(developmentGapGroups.every((group) =>
    !group.runnable && group.documentEvidence.includes('CFOR-PB-') &&
      group.currentSourceEvidence.length > 0 && group.registrationAction.includes('再登记')
  ))
  assert(unconfirmedCaseGroups.every((group) =>
    !group.runnable && group.documentEvidence.includes('未确认') &&
      group.currentSourceEvidence.length > 0
  ))
  assert(excluded.every((id) => !cases.includes(id) && !/^CRM-BASE-/.test(id)))
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url)))
  const registered = catalog.suites.flatMap((suite) => suite.cases
    .filter((item) => cases.includes(item.id))
    .map((item) => ({ id: item.id, suite: suite.id })))
  assert(registered.length <= 1, 'PB052 must not be registered twice')
  for (const item of registered) {
    assert.equal(item.suite, 'crm-missing-readonly')
  }
})

test('CommonResult is unwrapped and long string IDs and zero counts are retained', () => {
  const actual = validateTagUsage(page(), usage())
  assert.equal(actual.definitions[0].id, definition.id)
  assert.deepEqual(actual.displayRows, [{ code: 'MANUAL_A', customerCount: 0 }])
  assert.deepEqual(actual.gaps, [])
})

test('empty lists are valid but cannot prove zero-customer tags or fields', () => {
  const actual = validateTagUsage(page([], 0), usage([]))
  assert.equal(actual.displayRows.length, 0)
  assert(actual.gaps.some((gap) => gap.includes('定义为空')))
})

test('business failure or raw data must not become vacuous success', () => {
  for (const payload of [{}, { list: [], total: 0 }, { code: 403, data: { list: [], total: 0 } },
    { code: 0, success: false, data: { list: [], total: 0 } }]) {
    assert.throws(() => validateTagUsage(payload, usage([])))
  }
  assert.throws(() => validateTagUsage(page(), [summary]))
  assert.throws(() => validateTagUsage(page(), { code: 500, data: [] }))
  assert.throws(() => validateTagUsage(page(), success({})))
})

test('malformed pages, fake empty totals and oversized samples are rejected', () => {
  for (const payload of [
    success({ list: null, total: 0 }), success({ list: [], total: 2 }),
    success({ list: [null], total: 1 }), success({ list: [], total: -1 }),
    success({ list: [], total: '0' }), page(Array(101).fill(definition), 101)
  ]) assert.throws(() => validateTagUsage(payload, usage([])))
})

test('numeric precision loss, missing fields and duplicate IDs/codes are rejected', () => {
  for (const patch of [{ id: Number(definition.id) }, { id: 0 }, { id: '01' },
    { code: '' }, { name: '' }, { tagType: 'AUTO' }, { status: '1' }]) {
    assert.throws(() => validateTagUsage(page([{ ...definition, ...patch }]), usage()))
  }
  assert.throws(() => validateTagUsage(page([definition, definition], 2), usage([summary, summary])))
  for (const patch of [{ tagId: Number(definition.id) }, { customerCount: -1 },
    { customerCount: 1.2 }, { customerCount: '0' }, { customerCount: Number.MAX_SAFE_INTEGER + 1 },
    { tagType: 'AUTO' }]) {
    assert.throws(() => validateTagUsage(page(), usage([{ ...summary, ...patch }])))
  }
})

test('summary must cover the exact definitions including code, source and status', () => {
  for (const patch of [{ tagId: '2' }, { code: 'OTHER' }, { name: 'B' },
    { tagType: 'SYSTEM' }, { status: 0 }]) {
    assert.throws(() => validateTagUsage(page(), usage([{ ...summary, ...patch }])))
  }
  assert.throws(() => validateTagUsage(page(), usage([])))
  assert.throws(() => validateTagUsage(page(), usage([summary, summary])))
  assert.throws(() => validateTagUsage(page([], 0), usage()))
})

test('no zero sample and uninspected pages are explicit gaps, not fabricated fixtures', () => {
  assert(validateTagUsage(page(), usage([{ ...summary, customerCount: 3 }]))
    .gaps.some((gap) => gap.includes('无零客户')))
  const summaries = Array.from({ length: 101 }, (_, index) => ({
    ...summary, tagId: String(index + 1), code: `TAG_${index}`
  }))
  const definitions = summaries.slice(0, 100).map(({ tagId, customerCount, ...row }) => ({ ...row, id: tagId }))
  assert(validateTagUsage(page(definitions, 101), usage(summaries)).gaps.some((gap) => gap.includes('首页100')))
})

test('DOM requires loaded mask, exact row count/code/value; transient empty cannot pass', () => {
  const snapshot = { headers: ['标签编码', '当前客户数'], rows: [{ code: 'MANUAL_A', customerCount: '0' }],
    loading: false, empty: false }
  const expected = [{ code: 'MANUAL_A', customerCount: 0 }]
  assert.equal(tagTableMatches(snapshot, expected), true)
  for (const patch of [{ loading: true }, { rows: [] }, { headers: ['标签编码'] },
    { rows: [{ code: 'MANUAL_A', customerCount: '-' }] },
    { rows: [{ code: 'MANUAL_A', customerCount: '1' }] },
    { rows: [{ code: 'OTHER', customerCount: '0' }] },
    { rows: [...snapshot.rows, ...snapshot.rows] }]) {
    assert.equal(tagTableMatches({ ...snapshot, ...patch }, expected), false)
  }
  assert.equal(tagTableMatches({ ...snapshot, rows: [], empty: false }, []), false)
  assert.equal(tagTableMatches({ ...snapshot, rows: [], empty: true }, []), true)
})

test('identity resolves only real component routes; roles do not invent permission', () => {
  const payload = success({
    user: { id: 1 }, permissions: ['crm:customer-tag:query'],
    menus: [{ path: '/settings', children: [{ path: 'crm/customer-tag', component: 'crm/config/customerTag/index' }] }]
  })
  assert.deepEqual(tagIdentity(payload), { route: '/settings/crm/customer-tag', advertisedQuery: true })
  assert.equal(tagIdentity(success({ ...payload.data, permissions: ['*:*:*'] })).advertisedQuery, true)
  assert.equal(tagIdentity(success({ ...payload.data, permissions: [], roles: ['super_admin'] })).advertisedQuery, false)
  assert.equal(tagIdentity(success({ ...payload.data, menus: [] })).route, null)
  assert.throws(() => tagIdentity({ code: 403, data: payload.data }))
  assert.throws(() => tagIdentity(success({ ...payload.data, user: { id: Number(definition.id) } })))
})

test('browser responses must be real GET, correct endpoint and unfiltered page1/100', () => {
  assert(isTagResponse(response(definitionPath, page(), { query: '?pageNo=1&pageSize=100' }), definitionPath))
  for (const options of [{ method: 'POST', query: '?pageNo=1&pageSize=100' },
    { query: '?pageNo=2&pageSize=100' }, { query: '?pageNo=1&pageSize=101' },
    { query: '?pageNo=1&pageSize=100&code=FILTER' }, { query: '' }]) {
    assert.equal(isTagResponse(response(definitionPath, page(), options), definitionPath), false)
  }
  assert.equal(isTagResponse(response('/crm/customer/page', page()), definitionPath), false)
  assert.equal(isTagResponse(response(summaryPath, usage(), { query: '?customerId=1' }), summaryPath), false)
})

test('listeners are armed before navigation and both browser bodies are checked', async () => {
  const calls = []
  const replies = [response(definitionPath, page(), { query: '?pageNo=1&pageSize=100' }),
    response(summaryPath, usage())]
  const fakePage = {
    waitForResponse(predicate) {
      calls.push('listen')
      const reply = replies[calls.length - 1]
      assert(predicate(reply))
      return Promise.resolve(reply)
    }
  }
  const actual = await captureTagUsage(fakePage, async () => {
    assert.deepEqual(calls, ['listen', 'listen'])
    calls.push('navigate')
  })
  assert.equal(actual.displayRows[0].customerCount, 0)
})

test('missing browser requests are BLOCKED; failing HTTP/business bodies cannot pass', async () => {
  await assert.rejects(() => captureTagUsage({
    waitForResponse: async () => { throw new Error('timeout') }
  }, async () => {}), /^Error: BLOCKED:/)
  for (const failedReply of [response(summaryPath, usage(), { ok: false }),
    response(summaryPath, { code: 500, data: [] })]) {
    const replies = [response(definitionPath, page(), { query: '?pageNo=1&pageSize=100' }), failedReply]
    await assert.rejects(() => captureTagUsage({
      waitForResponse: async () => replies.shift()
    }, async () => {}))
  }
})

test('readonly API execution calls only two GETs and reports actual empty evidence gaps', async () => {
  const called = []
  const caseRecord = record()
  const api = {
    async getBusiness(pathname) {
      called.push(pathname)
      return pathname.startsWith(definitionPath) ? page([], 0) : usage([])
    },
    postBusiness() { assert.fail('business write forbidden') },
    putBusiness() { assert.fail('business write forbidden') },
    deleteBusiness() { assert.fail('business write forbidden') }
  }
  await readTagUsage({ api, caseRecord })
  assert.deepEqual(called, [`${definitionPath}?pageNo=1&pageSize=100`, summaryPath])
  assert(caseRecord.notes.some((gap) => gap.includes('定义为空')))
  assert(caseRecord.checks.every((check) => check.passed))
  assert(!caseRecord.checks.some((check) => check.name.includes('非空样本')))
  assert.equal(caseOutcome({ result: { partial: true }, hasAssertions: true }).status, 'PARTIAL')
})

test('nonempty real-shaped samples add field/coverage evidence without raising result ceiling', async () => {
  const caseRecord = record()
  await readTagUsage({
    api: { getBusiness: async (pathname) => pathname.startsWith(definitionPath) ? page() : usage() },
    caseRecord
  })
  assert(caseRecord.checks.some((check) => check.name.includes('非空样本') && check.passed))
  assert.equal(caseRegistry[0].resultCeiling, 'PARTIAL')
})

test('denied/undeployed endpoints block and API errors are redacted', async () => {
  for (const message of ['HTTP 403 GET path: secret', 'HTTP 404 GET path: secret']) {
    await assert.rejects(() => readTagUsage({
      api: { getBusiness: async () => { throw new Error(message) } }, caseRecord: record()
    }), (error) => error.message.startsWith('BLOCKED:') && !error.message.includes('secret'))
  }
})

test('browser wait uses the tested predicate with response row counts', async () => {
  const expected = [{ code: 'A', customerCount: 0 }]
  let waited = false
  await waitForTagTable({
    async waitForFunction(fn, args, options) {
      waited = true
      assert.equal(typeof fn, 'function')
      assert.deepEqual(args.expectedRows, expected)
      const matches = (0, eval)(`(${args.matchesSource})`)
      assert(matches({ headers: ['标签编码', '当前客户数'], rows: [{ code: 'A', customerCount: '0' }] }, expected))
      assert.equal(options.timeout, 15000)
    }
  }, expected)
  assert(waited)
})

test('runnable source contains no business mutations, request mocks or invented routes', () => {
  const source = fs.readFileSync(new URL('../suites/crm-missing-readonly.mjs', import.meta.url), 'utf8')
  assert(!/\.(?:postBusiness|putBusiness|deleteBusiness|post|put|delete|route|fill|click)\s*\(/.test(source))
  assert(!/\/(?:system\/tenant\/create|crm\/task\/create|definition\/create)/.test(source))
  assert(source.includes('partial: true'))
  assert(source.includes('crmMenuRoute'))
})
