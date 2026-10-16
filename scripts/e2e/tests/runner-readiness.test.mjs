import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { main } from '../runner.mjs'
import { waitForApiReady } from '../lib/api-readiness.mjs'

function harness (t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-e2e-runner-readiness-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const events = []
  const settings = {
    target: 'local',
    webBase: 'http://127.0.0.1:9151',
    apiBase: 'http://127.0.0.1:48083',
    apiUrl: 'http://127.0.0.1:48083/admin-api',
    apiHealthUrl: '',
    password: 'unit-only-password',
    outputRoot: root
  }
  const dependencies = {
    config: settings,
    argv: ['--case', 'SMOKE-001', '--case', 'SMOKE-002'],
    clearCheckpoint: () => {},
    loadCheckpoint: () => new Set(),
    saveCheckpoint: () => events.push('checkpoint'),
    reconcileCheckpoint: () => {},
    loadSuite: async () => {
      events.push('suite:load')
      return {
        cases: ['SMOKE-001', 'SMOKE-002'],
        runCase: async ({ caseId, caseRecord }) => {
          events.push(`login:${caseId}`)
          events.push(`fixture:${caseId}`)
          caseRecord.checks.push({ name: 'offline contract assertion', passed: true })
          return { status: 'PASS', acceptanceComplete: true }
        }
      }
    },
    launchBrowser: async () => {
      events.push('browser:launch')
      return {
        page: {},
        context: { tracing: { start: async () => events.push('trace:start') } },
        flushResponses: async () => {}
      }
    },
    closeBrowserHandle: async () => events.push('browser:close'),
    saveScreenshot: async () => assert.fail('no real or fake screenshot is expected'),
    ...overrides
  }
  return { root, events, settings, dependencies }
}

function offlineReadiness (events, probe) {
  let time = 0
  return (options) => {
    events.push('gate:start')
    return waitForApiReady({
      ...options, timeoutMs: 25, intervalMs: 10, requestTimeoutMs: 5
    }, {
      now: () => time,
      sleep: async (ms) => { time += ms },
      setTimeout: () => 1,
      clearTimeout: () => {},
      fetch: async (url, options) => {
        events.push('health:GET')
        return probe(url, options)
      }
    })
  }
}

function healthy () {
  return { status: 200, ok: true, json: async () => ({ status: 'UP' }) }
}

for (const reuse of [true, false]) {
  test(`batch readiness runs once before suite imports, browser launches, login and fixtures (reuse=${reuse})`, async (t) => {
    const h = harness(t)
    h.dependencies.argv.push(reuse ? '--reuse-session' : '--no-reuse-session')
    let probes = 0
    h.dependencies.waitForApiReady = offlineReadiness(h.events, (url, options) => {
      assert.equal(url, 'http://127.0.0.1:48083/actuator/health')
      assert.equal(options.method, 'GET')
      probes++
      return probes === 1
        ? { status: 503, ok: false, json: async () => ({ status: 'DOWN' }) }
        : healthy()
    })

    const { record } = await main(h.dependencies)

    assert.equal(record.passed, true)
    assert.equal(record.apiReadiness.status, 'UP')
    assert.equal(record.apiReadiness.attempts.length, 2)
    assert.deepEqual(h.events.slice(0, 5), [
      'gate:start', 'health:GET', 'health:GET', 'suite:load', 'browser:launch'
    ])
    assert.equal(h.events.filter((event) => event === 'gate:start').length, 1)
    assert.equal(h.events.filter((event) => event === 'health:GET').length, 2)
    assert.equal(h.events.filter((event) => event === 'browser:launch').length, reuse ? 1 : 2)
    assert.equal(h.events.filter((event) => event.startsWith('login:')).length, 2)
    assert.equal(h.events.filter((event) => event.startsWith('fixture:')).length, 2)
    assert.ok(h.events.indexOf('suite:load') < h.events.indexOf('login:SMOKE-001'))
  })
}

test('an unresolved gate is awaited before loading a suite or starting any browser work', async (t) => {
  const h = harness(t)
  let release
  h.dependencies.waitForApiReady = () => {
    h.events.push('gate:waiting')
    return new Promise((resolve) => { release = resolve })
  }
  const execution = main(h.dependencies)
  await Promise.resolve()
  assert.deepEqual(h.events, ['gate:waiting'])
  const dirs = fs.readdirSync(h.root)
  const progress = JSON.parse(fs.readFileSync(path.join(h.root, dirs[0], 'progress.json'), 'utf8'))
  assert.equal(progress.phase, 'API_READINESS')
  assert.equal(progress.counts.executed, 0)
  release({ status: 'UP', attempts: [] })
  await execution
  assert.equal(h.events.filter((event) => event === 'gate:waiting').length, 1)
  assert.ok(h.events.includes('browser:launch'))
})

test('health timeout persists one batch blocker with transport evidence and no fabricated case FAILs', async (t) => {
  const h = harness(t)
  h.dependencies.argv.push('--continue-on-failure')
  const refused = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:48083'), {
      code: 'ECONNREFUSED'
    })
  })
  h.dependencies.waitForApiReady = offlineReadiness(h.events, () => { throw refused })

  await assert.rejects(main(h.dependencies), (error) => {
    assert.equal(error.code, 'E2E_API_NOT_READY')
    assert.equal(error.status, 'BLOCKED')
    assert.equal(error.cause, refused)
    return true
  })

  assert.deepEqual(h.events, ['gate:start', 'health:GET', 'health:GET', 'health:GET'])
  const dirs = fs.readdirSync(h.root)
  assert.equal(dirs.length, 1)
  const directory = path.join(h.root, dirs[0])
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
  const progress = JSON.parse(fs.readFileSync(path.join(directory, 'progress.json'), 'utf8'))
  assert.equal(result.passed, false)
  assert.equal(result.runStatus, 'INCOMPLETE')
  assert.equal(result.runError.status, 'BLOCKED')
  assert.equal(result.runError.code, 'E2E_API_NOT_READY')
  assert.equal(result.runError.cause.cause.code, 'ECONNREFUSED')
  assert.equal(result.apiReadiness.status, 'BLOCKED')
  assert.equal(result.apiReadiness.attempts.length, 3)
  assert.ok(result.apiReadiness.attempts.every((attempt) =>
    attempt.networkError === true && attempt.error.cause.code === 'ECONNREFUSED'))
  assert.deepEqual(result.cases, [])
  assert.deepEqual(progress.results, [])
  assert.deepEqual(progress.pendingCases, ['SMOKE-001', 'SMOKE-002'])
  assert.equal(progress.phase, 'STOPPED')
  assert.equal(progress.counts.FAIL, 0)
  assert.equal(progress.counts.executed, 0)
  assert.equal(progress.counts.pending, 2)
  assert.equal(fs.existsSync(path.join(directory, 'cases')), false)
})

test('a recovered startup network error remains evidence without becoming a product-case failure', async (t) => {
  const h = harness(t)
  let probes = 0
  h.dependencies.waitForApiReady = offlineReadiness(h.events, () => {
    if (++probes === 1) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connection reset during startup'), { code: 'ECONNRESET' })
      })
    }
    return healthy()
  })
  const { record, report } = await main(h.dependencies)
  const result = JSON.parse(fs.readFileSync(report.resultFile, 'utf8'))
  assert.equal(record.passed, true)
  assert.ok(record.cases.every((entry) => entry.status === 'PASS'))
  assert.equal(result.apiReadiness.attempts[0].networkError, true)
  assert.equal(result.apiReadiness.attempts[0].error.cause.code, 'ECONNRESET')
  assert.deepEqual(result.api, [])
  assert.ok(result.cases.every((entry) => entry.runtimeErrors.nodeApi.length === 0))
})

test('a remote batch with no configured health URL does not contact a guessed endpoint', async (t) => {
  const h = harness(t)
  Object.assign(h.settings, {
    target: 'prod', apiBase: 'https://example.invalid',
    apiUrl: 'https://example.invalid/admin-api', webBase: 'https://example.invalid'
  })
  t.mock.method(globalThis, 'fetch', () => assert.fail('unconfigured remote health must not fetch'))
  const { record } = await main(h.dependencies)
  assert.equal(record.apiReadiness.status, 'SKIPPED')
  assert.equal(record.passed, true)
  assert.equal(record.environment.target, 'prod')
})

for (const option of ['--list', '--help', '-h']) {
  test(`${option} never enters readiness, network, suite loading, or browser startup`, async (t) => {
    const h = harness(t)
    t.mock.method(console, 'log', () => {})
    t.mock.method(globalThis, 'fetch', () => assert.fail(`${option} must not fetch`))
    h.dependencies.argv = [option]
    Object.assign(h.settings, { password: '', apiBase: 'not a URL' })
    h.dependencies.waitForApiReady = () => assert.fail(`${option} must not enter readiness`)

    assert.equal(await main(h.dependencies), undefined)
    assert.deepEqual(h.events, [])
    assert.deepEqual(fs.readdirSync(h.root), [])
  })
}
