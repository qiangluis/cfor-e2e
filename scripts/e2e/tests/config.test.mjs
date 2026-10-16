import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isRunPassed } from '../lib/report.mjs'
import { redact } from '../lib/redact.mjs'

const cwd = fileURLToPath(new URL('../../../', import.meta.url))
const probe = (overrides = {}) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CFOR_')))
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { config, environmentSummary } from './scripts/e2e/config/index.mjs'
    console.log(JSON.stringify({
      target: config.target, web: config.webBase, api: config.apiBase,
      request: config.requestTimeoutMs, browser: config.browserTimeoutMs,
      hrmUsername: config.hrmApproverUsername,
      hrmPasswordConfigured: Boolean(config.hrmApproverPassword),
      hrmPasswordMatchesTest: config.hrmApproverPassword === 'hrm-unit-test-only',
      summaryHrmUsername: environmentSummary().hrmApproverUsername,
      summaryIncludesPassword: Object.keys(environmentSummary()).some((key) => /password/i.test(key))
    }))
  `], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' })
  return JSON.parse(output)
}

test('legacy files cannot implicitly select production or stale local ports', () => {
  const result = probe()
  assert.equal(result.target, 'local')
  assert.equal(result.web, 'http://127.0.0.1:9151')
  assert.equal(result.api, 'http://127.0.0.1:48083')
})

test('explicit canonical endpoints win over configured aliases', () => {
  const result = probe({
    CFOR_WEB_BASE: 'http://localhost:9151/',
    CFOR_API_BASE: 'http://localhost:48083/admin-api'
  })
  assert.equal(result.web, 'http://localhost:9151')
  assert.equal(result.api, 'http://localhost:48083')
})

test('standalone tools reject remote addresses and other local service ports', () => {
  for (const CFOR_WEB_BASE of ['http://127.0.0.1:9160', 'https://example.com']) {
    assert.throws(() => probe({ CFOR_WEB_BASE }), /Local web must use/)
  }
  assert.throws(() => probe({ CFOR_API_BASE: 'http://127.0.0.1:48080' }), /Local api must use/)
})

test('missing, zero, negative and invalid timeout values use bounded defaults', () => {
  for (const value of ['', '0', '-1', 'invalid']) {
    const result = probe({ CFOR_E2E_REQUEST_TIMEOUT_MS: value, CFOR_E2E_BROWSER_TIMEOUT_MS: value })
    assert.equal(result.request, 30000)
    assert.equal(result.browser, 60000)
  }
  assert.equal(probe({ CFOR_E2E_BROWSER_TIMEOUT_MS: '15000' }).browser, 15000)
})

test('optional HRM approval credentials require an explicit password and keep it out of summaries', () => {
  const absent = probe({
    CFOR_HRM_APPROVER_USERNAME: 'hrmgr01', CFOR_HRM_APPROVER_PASSWORD: '',
    CFOR_PASSWORD: 'hrm-unit-test-only', CFOR_FINANCE_APPROVER_PASSWORD: 'hrm-unit-test-only'
  })
  assert.equal(absent.hrmUsername, 'hrmgr01')
  assert.equal(absent.hrmPasswordConfigured, false)
  assert.equal(absent.hrmPasswordMatchesTest, false)
  assert.equal(absent.summaryIncludesPassword, false)
  const configured = probe({
    CFOR_HRM_APPROVER_USERNAME: 'hrm-test', CFOR_HRM_APPROVER_PASSWORD: 'hrm-unit-test-only'
  })
  assert.equal(configured.hrmUsername, 'hrm-test')
  assert.equal(configured.hrmPasswordConfigured, true)
  assert.equal(configured.hrmPasswordMatchesTest, true)
  assert.equal(configured.summaryHrmUsername, 'hrm-test')
  assert.equal(configured.summaryIncludesPassword, false)
})

test('empty, incomplete and skipped-only reports never pass', () => {
  for (const cases of [
    [], [{ status: 'SKIPPED' }], [{ status: 'PARTIAL' }],
    [{ status: 'PASS' }, { status: 'SKIPPED' }],
    [{ status: 'PASS' }, { status: 'FAIL' }]
  ]) assert.equal(isRunPassed({ cases }), false)
  assert.equal(isRunPassed({ cases: [{ status: 'PASS' }] }), true)
  assert.equal(isRunPassed({ cases: [
    { status: 'PASS' }, { status: 'SKIPPED', notes: ['断点续跑：此前已通过'] }
  ] }), true)
})

test('API evidence redacts credentials and personal contact information recursively', () => {
  assert.deepEqual(redact({
    code: 0, data: { id: 10, accessToken: 'secret', nested: [{ phone: '123', amount: 5 }] }
  }), {
    code: 0, data: { id: 10, accessToken: '[REDACTED]', nested: [{ phone: '[REDACTED]', amount: 5 }] }
  })
})
