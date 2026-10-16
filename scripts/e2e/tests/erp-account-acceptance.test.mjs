import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildAcceptanceGapReport } from '../acceptance-gap-report.mjs'
import { RESP_KEY } from '../lib/crypto.mjs'
import {
  ACCOUNT_CATALOG_ASSERTIONS,
  ACCOUNT_REFERENCE_COLUMNS,
  ACCOUNT_REQUIRED_CHECKS,
  ACCOUNT_SETTING_HEADERS,
  accountCatalogEvidence,
  accountPageEvidence,
  accountRowEvidence,
  accountSettingEvidence,
  checkExpectedAccountRejection,
  cleanupAccountFixture,
  createAccountApiClient,
  isExpectedAccountRejection,
  maskAccountNo,
  readAccountPageResponse,
  withAccountPagePrivacy
} from '../suites/erp-account.mjs'

const fixture = {
  id: '17',
  no: 'E2E-ERP-A001-UNIT',
  accountType: 'BANK',
  accountNo: '99990000123456789',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2099-12-31',
  remark: 'CFOR-E2E:ERP-ACCOUNT-001:UNIT'
}
const maskedRow = () => ({
  ...fixture, accountNo: maskAccountNo(fixture.accountNo),
  status: 0, defaultStatus: false, currency: 'CNY'
})
const pageResponse = (rows = [maskedRow()]) => ({
  code: 0, data: { list: rows, total: rows.length }
})
const setting = () => ({
  url: 'http://127.0.0.1:9151/systemModel/base/account',
  headers: [...ACCOUNT_SETTING_HEADERS],
  rows: [[fixture.no, '银行账户', maskAccountNo(fixture.accountNo),
    `${fixture.effectiveFrom} ~ ${fixture.effectiveTo}`]],
  bodyText: `${fixture.no} 银行账户 ${maskAccountNo(fixture.accountNo)}`
})
const newRecord = () => ({ checks: [], notes: [], evidence: [] })
const completeRecord = () => {
  const row = { ...accountRowEvidence(maskedRow(), fixture), currencyMatched: true }
  const page = accountPageEvidence(pageResponse(), fixture)
  const browser = accountSettingEvidence(setting(), fixture)
  const evidence = {
    '正式 API 回读账户主档字段、启用状态和默认脱敏': row,
    '敏感详情权限接口仅在显式敏感权限下回读完整账号': {
      sampleMatched: true, fullAccountMatched: true
    },
    '账户分页按唯一编码回读自建账户并保持脱敏': page,
    '企业资金账户设置页真实列头包含账户编码、账户类型和有效期': browser,
    '设置页按专属编码显示账户类型与有效期': browser,
    '设置页自建账户真实账号默认脱敏且完整号不出现': browser
  }
  return {
    ...newRecord(),
    checks: ACCOUNT_REQUIRED_CHECKS.map((name) => ({
      name, passed: true, ...(evidence[name] ? { evidence: evidence[name] } : {})
    }))
  }
}
const completeOptions = { writeEnabled: true, sampleObserved: true }
const assertGap = (record) => {
  assert.equal(record.acceptanceComplete, false)
  assert.equal(record.passCandidate, false)
  assert.equal(record.partial, true)
  assert.ok(record.remainingAssertions.length > 0)
}

test('account catalog mapping retains both original assertions verbatim at exact indexes', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'ERP-ACCOUNT-001')
  assert.deepEqual([...ACCOUNT_CATALOG_ASSERTIONS], definition.assertions)
  const record = accountCatalogEvidence(completeRecord(), completeOptions)
  assert.deepEqual(record.catalogAssertions.map(({ index, assertion, status }) =>
    ({ index, assertion, status })), definition.assertions.map((assertion, index) =>
    ({ index, assertion, status: 'VERIFIED' })))
  assert.equal(record.acceptanceComplete, true)
  assert.equal(record.partial, false)
  assert.deepEqual(record.remainingAssertions, [])
  assert.doesNotMatch(JSON.stringify(record), new RegExp(fixture.accountNo))
})

test('missing write opt-in or current-run sample keeps both assertions GAP', () => {
  for (const options of [
    undefined, {}, { ...completeOptions, writeEnabled: false },
    { ...completeOptions, writeEnabled: 'true' },
    { ...completeOptions, sampleObserved: false }
  ]) {
    const record = accountCatalogEvidence(completeRecord(), options)
    assertGap(record)
    assert.ok(record.catalogAssertions.every((item) => item.status === 'GAP'))
  }
})

test('every required check must occur exactly once and pass strictly', () => {
  for (const name of ACCOUNT_REQUIRED_CHECKS) {
    for (const mutation of ['missing', 'duplicate', 'false', 'undefined', 'truthy']) {
      const record = completeRecord()
      const check = record.checks.find((item) => item.name === name)
      if (mutation === 'missing') record.checks = record.checks.filter((item) => item !== check)
      if (mutation === 'duplicate') record.checks.push(structuredClone(check))
      if (mutation === 'false') check.passed = false
      if (mutation === 'undefined') delete check.passed
      if (mutation === 'truthy') check.passed = 'true'
      assertGap(accountCatalogEvidence(record, completeOptions))
    }
  }
})

test('passing check names, page title and HTTP 200 cannot replace structured observations', () => {
  const record = completeRecord()
  record.checks.forEach((check) => { delete check.evidence })
  record.checks.push({ name: '页面标题 / HTTP 200', passed: true })
  accountCatalogEvidence(record, completeOptions)
  assertGap(record)
  assert.ok(record.catalogAssertions.every((item) => item.status === 'GAP'))
})

test('each failed structured observation blocks verification even when check.passed is true', () => {
  for (const check of completeRecord().checks.filter((item) => item.evidence)) {
    for (const key of Object.keys(check.evidence).filter((key) => check.evidence[key] === true)) {
      const record = completeRecord()
      record.checks.find((item) => item.name === check.name).evidence[key] = false
      assertGap(accountCatalogEvidence(record, completeOptions))
    }
  }
})

test('unrelated failures and duplicate check names also prevent full acceptance', () => {
  for (const checks of [
    [{ name: 'API 500', passed: false }],
    [{ name: 'extra', passed: true }, { name: 'extra', passed: true }],
    [{ name: 'incomplete check' }]
  ]) {
    const record = completeRecord()
    record.checks.push(...checks)
    assertGap(accountCatalogEvidence(record, completeOptions))
  }
})

test('stale VERIFIED mappings and completion flags are replaced from current evidence', () => {
  const record = completeRecord()
  accountCatalogEvidence(record, completeOptions)
  record.checks = []
  accountCatalogEvidence(record)
  assertGap(record)
  assert.equal(record.catalogAssertions.length, 2)
  assert.ok(record.catalogAssertions.every((item) => item.status === 'GAP'))
})

test('strict report consumes new exact mappings and preserves incomplete current-run evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-acceptance-unit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const catalogPath = path.join(root, 'unit-catalog.json')
  const coveragePath = path.join(root, 'unit-coverage.json')
  const sourcePath = path.join(root, 'unit-source.json')
  const caseId = 'ERP-ACCOUNT-001'
  fs.writeFileSync(catalogPath, JSON.stringify({
    suites: [{ id: 'erp-account', cases: [{
      id: caseId, assertions: [...ACCOUNT_CATALOG_ASSERTIONS]
    }] }]
  }))
  fs.writeFileSync(coveragePath, JSON.stringify({ cases: [{
    id: caseId, actualStatus: 'PASS', executed: true,
    latestExecution: { runId: 'account-unit-only', sourcePath }
  }] }))
  for (const options of [completeOptions, { ...completeOptions, writeEnabled: false }]) {
    const record = accountCatalogEvidence(completeRecord(), options)
    fs.writeFileSync(sourcePath, JSON.stringify({
      runId: 'account-unit-only',
      environment: {
        target: 'local', tenantId: '1',
        webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083'
      },
      cases: [{
        ...record, caseId, status: 'PASS',
        runtimeErrors: { console: [], page: [], api: [], request: [], nodeApi: [] }
      }]
    }))
    const report = buildAcceptanceGapReport({ coveragePath, catalogPath })
    const result = report.cases[0]
    assert.equal(result.completeAcceptance, options.writeEnabled)
    assert.equal(result.acceptanceStatus, options.writeEnabled ? 'RECORDED_VERIFIED' : 'GAP')
    assert.deepEqual(result.assertions.map((item) => item.index), [0, 1])
    assert.doesNotMatch(JSON.stringify(report), new RegExp(fixture.accountNo))
  }
})

test('targeted API page proves stable identity, both dates and exact default masking', () => {
  const evidence = accountPageEvidence(pageResponse(), fixture)
  assert.equal(evidence.sampleCount, 1)
  assert.ok(Object.values(evidence).every((value) => value === true || value === 1))
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(fixture.accountNo))
})

test('API page rejects empty, malformed, duplicate, foreign and unmasked samples', () => {
  const empty = accountPageEvidence(pageResponse([]), fixture)
  assert.equal(empty.uniqueSample, false)
  assert.equal(empty.sampleMatched, false)
  assert.equal(accountPageEvidence({ code: 0, data: {} }, fixture).pageValid, false)
  assert.equal(accountPageEvidence(pageResponse([maskedRow(), maskedRow()]), fixture).uniqueSample, false)
  assert.equal(accountPageEvidence({ ...pageResponse(), code: 500 }, fixture).businessSuccess, false)
  for (const [field, value, key] of [
    ['id', '18', 'sampleMatched'], ['no', 'OTHER', 'codeMatched'],
    ['accountType', undefined, 'typeMatched'],
    ['effectiveFrom', undefined, 'validityMatched'],
    ['effectiveTo', undefined, 'validityMatched'],
    ['accountNo', fixture.accountNo, 'masked'],
    ['accountNo', '****', 'masked']
  ]) {
    const evidence = accountPageEvidence(pageResponse([{ ...maskedRow(), [field]: value }]), fixture)
    assert.equal(evidence[key], false, field)
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(fixture.accountNo))
  }
})

test('full account number in any page field fails absence even if accountNo is masked', () => {
  const evidence = accountPageEvidence(pageResponse([{ ...maskedRow(), remark: fixture.accountNo }]), fixture)
  assert.equal(evidence.masked, true)
  assert.equal(evidence.fullAccountAbsent, false)
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(fixture.accountNo))
})

test('formal settings use the actual 有效期 header and render both dates in its cell', () => {
  assert.deepEqual([...ACCOUNT_SETTING_HEADERS], ['账户编码', '账户类型', '真实账号', '有效期'])
  const evidence = accountSettingEvidence(setting(), fixture)
  assert.equal(evidence.sampleCount, 1)
  assert.ok(Object.values(evidence).every((value) => value === true || value === 1))
})

test('date placeholders, body labels and duplicate headers cannot substitute table headers', () => {
  for (const headers of [
    [], ['账户编码', '账户类型', '真实账号', '生效日期', '失效日期'],
    [...ACCOUNT_SETTING_HEADERS, '有效期']
  ]) {
    const snapshot = setting()
    snapshot.headers = headers
    snapshot.bodyText += ' 账户编码 账户类型 有效期 生效日期 失效日期'
    assert.equal(accountSettingEvidence(snapshot, fixture).headersMatched, false)
  }
})

test('settings require one filtered row with a visible type and exact date values', () => {
  for (const mutate of [
    (snapshot) => { snapshot.rows = [] },
    (snapshot) => { snapshot.rows.push([...snapshot.rows[0]]) },
    (snapshot) => { snapshot.rows[0][0] = 'OTHER' },
    (snapshot) => { snapshot.rows[0][1] = '' },
    (snapshot) => { snapshot.rows[0][3] = '不限 ~ 不限' }
  ]) {
    const snapshot = setting()
    mutate(snapshot)
    const evidence = accountSettingEvidence(snapshot, fixture)
    assert.equal(evidence.uniqueSample && evidence.codeMatched &&
      evidence.typeVisible && evidence.validityMatched, false)
  }
})

test('settings reject raw account cells or a full number elsewhere on the page without logging it', () => {
  for (const mutate of [
    (snapshot) => { snapshot.rows[0][2] = fixture.accountNo },
    (snapshot) => { snapshot.bodyText += ` ${fixture.accountNo}` }
  ]) {
    const snapshot = setting()
    mutate(snapshot)
    const evidence = accountSettingEvidence(snapshot, fixture)
    assert.equal(evidence.fullAccountAbsent, false)
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(fixture.accountNo))
  }
})

test('negative assertions never accept HTTP, authentication or backend failures as domain evidence', async () => {
  for (const code of [0, 200, 401, 403, 500, 503, '500', undefined]) {
    assert.equal(isExpectedAccountRejection({ code, msg: '已存在编码' }, '已存在编码'), false)
  }
  assert.equal(isExpectedAccountRejection({
    code: 1030600002, msg: '系统异常：已存在编码'
  }, '已存在编码'), false)
  const record = newRecord()
  await checkExpectedAccountRejection(record, async () => {
    throw new Error('HTTP=500')
  }, '重复账户编码被正式 API 拒绝', '已存在编码')
  assert.equal(record.checks[0].passed, false)
  assert.match(record.checks[0].details, /500/)
  await checkExpectedAccountRejection(record, async () => ({
    code: 500, msg: `已存在编码 ${fixture.accountNo}`
  }), '日期反例', '已存在编码')
  assert.equal(record.checks[1].passed, false)
  assert.doesNotMatch(JSON.stringify(record), new RegExp(fixture.accountNo))
})

test('account API records status and code but omits response bodies including sensitive-query', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ code: 0, data: fixture }), {
      status: 200, headers: { 'content-type': 'application/json' }
    }))
  const record = { api: [] }
  const api = createAccountApiClient({ token: 'unit-token', record })
  const response = await api.getBusiness('/erp/account/get-sensitive?id=17')
  assert.equal(response.data.accountNo, fixture.accountNo)
  assert.equal(record.api[0].status, 200)
  assert.equal(record.api[0].code, 0)
  assert.doesNotMatch(JSON.stringify(record), new RegExp(fixture.accountNo))
  assert.doesNotMatch(JSON.stringify(record), /unit-token/)
})

test('HTTP and application 500 stay visible in sanitized API failures and runtime records', async (t) => {
  for (const status of [200, 500]) {
    const mock = t.mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ code: 500, msg: `backend error ${fixture.accountNo}` }), {
        status, headers: { 'content-type': 'application/json' }
      }))
    const record = { api: [] }
    const api = createAccountApiClient({ record })
    await assert.rejects(api.getBusiness('/erp/account/get?id=17'), (error) => {
      assert.match(error.message, /code=500/)
      assert.match(error.message, new RegExp(`HTTP=${status}`))
      assert.doesNotMatch(error.message, new RegExp(fixture.accountNo))
      return true
    })
    assert.equal(record.api[0].code, 500)
    assert.doesNotMatch(JSON.stringify(record), new RegExp(fixture.accountNo))
    mock.mock.restore()
  }
})

test('expected domain rejection is recorded explicitly while service errors remain unmatched', async (t) => {
  for (const code of [1030600002, 500]) {
    const mock = t.mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ code, msg: '已存在编码' }), { status: 200 }))
    const record = { api: [] }
    await createAccountApiClient({ record }).post('/erp/account/create', {}, {
      expectedBusinessRejection: { code: 1030600002, message: '已存在编码' }
    })
    assert.equal(record.api[0].expectedBusinessRejectionMatched === true, code === 1030600002)
    mock.mock.restore()
  }
})

test('browser page response decodes the configured encrypted transport without recording plaintext', async () => {
  const payload = JSON.stringify(pageResponse())
  const cipher = crypto.createCipheriv('aes-256-ecb',
    Buffer.from(process.env.CFOR_API_ENCRYPT_RESPONSE_KEY || RESP_KEY), null)
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('base64')
  for (const [text, headers] of [[payload, {}], [encrypted, { 'x-api-encrypt': 'true' }]]) {
    const response = await readAccountPageResponse({
      text: async () => text, headers: () => headers, status: () => 200
    })
    assert.equal(accountPageEvidence(response, fixture).masked, true)
  }
  await assert.rejects(readAccountPageResponse({
    text: async () => `invalid backend body ${fixture.accountNo}`,
    headers: () => ({}), status: () => 500
  }), (error) => {
    assert.match(error.message, /HTTP=500/)
    assert.doesNotMatch(error.message, new RegExp(fixture.accountNo))
    return true
  })
})

test('page privacy stops tracing before inspection and resumes only after a blank page', async () => {
  for (const fail of [false, true]) {
    const calls = []
    const page = {
      context: () => ({ tracing: {
        stop: async (...args) => { calls.push(['stop', ...args]) },
        start: async (options) => { calls.push(['start', options]) }
      } }),
      goto: async (url) => { calls.push(['goto', url]) }
    }
    const action = () => withAccountPagePrivacy(page, async () => {
      calls.push(['inspect'])
      if (fail) throw new Error('page API HTTP=500')
      return 'observed'
    })
    if (fail) await assert.rejects(action(), /HTTP=500/)
    else assert.equal(await action(), 'observed')
    assert.deepEqual(calls.map(([name]) => name), ['stop', 'inspect', 'goto', 'start'])
    assert.deepEqual(calls[0], ['stop'])
    assert.equal(calls[2][1], 'about:blank')
  }
})

test('missing privacy controls block inspection before a sensitive route can open', async () => {
  let inspected = false
  await assert.rejects(withAccountPagePrivacy({
    context: () => ({})
  }, () => { inspected = true }), /BLOCKED/)
  assert.equal(inspected, false)
})

test('privacy preserves earlier suite traces before entering the untraced account page', async () => {
  const calls = []
  const tracePath = '/unit-only/erp-account-before-private-page.zip'
  await withAccountPagePrivacy({
    context: () => ({ tracing: {
      stop: async (options) => { calls.push(options) },
      start: async () => {}
    } }),
    goto: async () => {}
  }, async () => { calls.push('inspect') }, { tracePath })
  assert.deepEqual(calls, [{ path: tracePath }, 'inspect'])
})

const referenceRows = () => ACCOUNT_REFERENCE_COLUMNS.map(([table, column]) => [`${table}.${column}`, '0'])
const cleanupApi = ({ detailAfter = { code: 0, data: null }, pageAfter = pageResponse([]) } = {}) => {
  const calls = []
  let detailReads = 0
  return {
    calls,
    async get (path) {
      calls.push(['GET', path])
      if (path.startsWith('/erp/account/page?')) return pageAfter
      return detailReads++ === 0 ? { code: 0, data: maskedRow() } : detailAfter
    },
    async deleteBusiness (path) {
      calls.push(['DELETE', path])
      return { code: 0, data: true }
    }
  }
}

test('cleanup requires complete unique zero-reference evidence before deleting the owned fixture', async () => {
  for (const rows of [
    [], referenceRows().slice(1), [...referenceRows(), referenceRows()[0]],
    referenceRows().map((row, index) => index === 0 ? [row[0], 'NaN'] : row),
    referenceRows().map((row, index) => index === 0 ? [row[0], '1'] : row)
  ]) {
    const api = cleanupApi()
    const record = newRecord()
    await cleanupAccountFixture({
      api, fixture, caseRecord: record,
      readReferences: async () => ({ available: true, rows })
    })
    assert.equal(api.calls.some(([method]) => method === 'DELETE'), false)
    assert.equal(record.checks.at(-1).passed, false)
  }
})

test('cleanup checks successful null detail and an explicitly empty filtered page', async () => {
  const api = cleanupApi()
  const record = newRecord()
  await cleanupAccountFixture({
    api, fixture, caseRecord: record,
    readReferences: async () => ({ available: true, rows: referenceRows() })
  })
  assert.equal(api.calls.filter(([method]) => method === 'DELETE').length, 1)
  assert.ok(record.checks.every((check) => check.passed === true))
  assert.doesNotMatch(JSON.stringify(record), new RegExp(fixture.accountNo))
})

test('delete readback 500 or a malformed page cannot close acceptance', async () => {
  for (const options of [
    { detailAfter: { code: 500, data: null } },
    { pageAfter: { code: 0, data: {} } },
    { pageAfter: { code: 500, data: { list: [], total: 0 } } }
  ]) {
    const record = completeRecord()
    record.checks = record.checks.filter((check) =>
      !['删除后账户详情接口返回成功且不再有数据', '仅清理本轮自建且未引用的账户夹具'].includes(check.name))
    await cleanupAccountFixture({
      api: cleanupApi(options), fixture, caseRecord: record,
      readReferences: async () => ({ available: true, rows: referenceRows() })
    })
    assertGap(accountCatalogEvidence(record, completeOptions))
    if (options.detailAfter) assert.match(JSON.stringify(record), /500/)
  }
})
