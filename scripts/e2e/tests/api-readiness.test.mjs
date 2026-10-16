import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_API_READY_TIMEOUT_MS,
  runnerHealthUrl,
  waitForApiReady
} from '../lib/api-readiness.mjs'

const local = {
  target: 'local',
  apiBase: 'http://127.0.0.1:48083',
  apiHealthUrl: ''
}

function response (status = 200, body = { status: 'UP' }) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

function virtualTransport (request) {
  let time = 0
  let nextTimer = 0
  const timers = new Map()
  const calls = []
  const sleeps = []
  const tools = {
    now: () => time,
    fetch: async (url, options) => {
      calls.push({ url, options, time })
      return request(calls.length, { time, advance, options })
    },
    sleep: async (ms) => {
      sleeps.push(ms)
      advance(ms)
    },
    setTimeout: (callback, ms) => {
      const id = ++nextTimer
      timers.set(id, { callback, at: time + ms })
      return id
    },
    clearTimeout: (id) => timers.delete(id)
  }
  function advance (ms) {
    time += ms
    for (const [id, timer] of timers) {
      if (timer.at <= time) {
        timers.delete(id)
        timer.callback()
      }
    }
  }
  return { tools, calls, sleeps, timers, advance }
}

async function until (predicate) {
  for (let turn = 0; turn < 50 && !predicate(); turn++) await Promise.resolve()
  assert.ok(predicate(), 'virtual operation did not reach the expected state')
}

test('local readiness uses the fixed actuator endpoint even when health is blank or overridden', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    for (const apiHealthUrl of ['', undefined, 'https://other.invalid/health']) {
      assert.equal(runnerHealthUrl({
        ...local, apiBase: `http://${host}:48083/admin-api`, apiHealthUrl
      }), `http://${host}:48083/actuator/health`)
    }
  }
  for (const apiBase of [
    'http://example.invalid:48083', 'http://127.0.0.1:48084',
    'http://user:secret@127.0.0.1:48083', 'ftp://127.0.0.1:48083'
  ]) assert.throws(() => runnerHealthUrl({ ...local, apiBase }), /BLOCKED:/)
})

test('an immediately UP response performs exactly one read-only request without login headers', async () => {
  const h = virtualTransport(() => response())
  const evidence = await waitForApiReady({ settings: local }, h.tools)
  assert.equal(evidence.status, 'UP')
  assert.equal(evidence.attempts.length, 1)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, 'http://127.0.0.1:48083/actuator/health')
  assert.equal(h.calls[0].options.method, 'GET')
  assert.equal(h.calls[0].options.redirect, 'manual')
  assert.equal(h.calls[0].options.cache, 'no-store')
  assert.equal(h.calls[0].options.headers, undefined)
  assert.equal(h.calls[0].options.body, undefined)
  assert.equal(h.calls[0].options.signal.aborted, false)
  assert.deepEqual(h.sleeps, [])
  assert.equal(h.timers.size, 0)
})

test('the default bounded wait tolerates initialization longer than five minutes', async () => {
  const h = virtualTransport((attempt, { time }) => response(200, {
    status: time < 360000 ? 'DOWN' : 'UP'
  }))
  const observed = []
  const evidence = await waitForApiReady({
    settings: local, intervalMs: 60000, onAttempt: (attempt) => observed.push(attempt)
  }, h.tools)
  assert.equal(evidence.timeoutMs, DEFAULT_API_READY_TIMEOUT_MS)
  assert.equal(evidence.status, 'UP')
  assert.equal(evidence.elapsedMs, 360000)
  assert.equal(evidence.attempts.length, 7)
  assert.equal(observed.length, 7)
  assert.deepEqual(h.calls.map((call) => call.time), [
    0, 60000, 120000, 180000, 240000, 300000, 360000
  ])
  assert.equal(h.timers.size, 0)
})

test('HTTP errors, DOWN, unknown JSON, and transport errors never count as readiness', async () => {
  const refused = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:48083'), {
      code: 'ECONNREFUSED'
    })
  })
  const invalidJson = new SyntaxError('Unexpected token < in JSON')
  const outcomes = [
    () => { throw refused },
    () => response(503, { status: 'UP' }),
    () => response(200, { status: 'DOWN' }),
    () => response(200, {}),
    () => ({ ...response(), json: async () => { throw invalidJson } }),
    () => response(401, { status: 'UP' }),
    () => response(302, { status: 'UP' }),
    () => response(200, { status: 'up' }),
    () => response()
  ]
  const h = virtualTransport((attempt) => outcomes[attempt - 1]())
  const evidence = await waitForApiReady({
    settings: local, timeoutMs: 100, intervalMs: 10
  }, h.tools)
  assert.equal(evidence.status, 'UP')
  assert.equal(h.calls.length, outcomes.length)
  assert.equal(evidence.attempts[0].networkError, true)
  assert.equal(evidence.attempts[0].error, refused)
  assert.equal(evidence.attempts[0].error.cause.code, 'ECONNREFUSED')
  assert.equal(evidence.attempts[1].httpStatus, 503)
  assert.equal(evidence.attempts[1].httpOk, false)
  assert.equal(evidence.attempts[2].healthStatus, 'DOWN')
  assert.equal(evidence.attempts[4].httpStatus, 200)
  assert.equal(evidence.attempts[4].responseError, true)
  assert.equal(evidence.attempts[4].error, invalidJson)
  assert.equal(evidence.attempts[5].httpStatus, 401)
  assert.equal(evidence.attempts[6].httpStatus, 302)
  assert.equal(evidence.elapsedMs, 80)
})

for (const [label, makeResponse] of [
  ['DOWN', () => response(200, { status: 'DOWN' })],
  ['HTTP failure with UP JSON', () => response(503)],
  ['missing status', () => response(200, null)]
]) {
  test(`${label} times out at the batch deadline without a final extra probe`, async () => {
    const h = virtualTransport(makeResponse)
    await assert.rejects(
      waitForApiReady({ settings: local, timeoutMs: 25, intervalMs: 10 }, h.tools),
      (error) => {
        assert.equal(error.code, 'E2E_API_NOT_READY')
        assert.equal(error.status, 'BLOCKED')
        assert.match(error.message, /^BLOCKED: API not ready after 25ms/)
        assert.equal(error.readiness.status, 'BLOCKED')
        assert.equal(error.readiness.elapsedMs, 25)
        assert.equal(error.readiness.attempts.length, 3)
        return true
      }
    )
    assert.deepEqual(h.calls.map((call) => call.time), [0, 10, 20])
    assert.deepEqual(h.sleeps, [10, 10, 5])
    assert.equal(h.timers.size, 0)
  })
}

test('a late UP response after the overall deadline does not release the gate', async () => {
  const h = virtualTransport((attempt, { advance }) => {
    advance(26)
    return response()
  })
  await assert.rejects(
    waitForApiReady({ settings: local, timeoutMs: 25 }, h.tools),
    (error) => error.code === 'E2E_API_NOT_READY' &&
      error.readiness.attempts[0].healthStatus === 'UP'
  )
  assert.equal(h.calls.length, 1)
})

for (const phase of ['connect', 'body']) {
  test(`a hung ${phase} read is aborted and bounded by the remaining batch time`, async () => {
    const never = new Promise(() => {})
    const h = virtualTransport(() => phase === 'connect'
      ? never
      : { ...response(), json: () => never })
    const execution = waitForApiReady({
      settings: local, timeoutMs: 25, intervalMs: 5, requestTimeoutMs: 10
    }, h.tools)
    const rejection = assert.rejects(execution, (error) => {
      assert.equal(error.code, 'E2E_API_NOT_READY')
      assert.equal(error.readiness.elapsedMs, 25)
      assert.equal(error.readiness.attempts.length, 2)
      assert.equal(error.readiness.attempts[0].error.code, 'E2E_API_HEALTH_REQUEST_TIMEOUT')
      assert.equal(error.readiness.attempts[0].httpStatus, phase === 'connect' ? null : 200)
      assert.equal(error.readiness.attempts[0][phase === 'connect' ? 'networkError' : 'responseError'], true)
      return true
    })
    await until(() => h.calls.length === 1 && h.timers.size === 1)
    h.advance(10)
    await until(() => h.calls.length === 2 && h.timers.size === 1)
    h.advance(10)
    await rejection
    assert.ok(h.calls.every((call) => call.options.signal.aborted))
    assert.equal(h.timers.size, 0)
  })
}

test('a single hung request is capped by a batch budget shorter than its own timeout', async () => {
  const h = virtualTransport(() => new Promise(() => {}))
  const execution = waitForApiReady({
    settings: local, timeoutMs: 7, requestTimeoutMs: 5000
  }, h.tools)
  const rejection = assert.rejects(execution, (error) => {
    assert.equal(error.readiness.elapsedMs, 7)
    assert.equal(error.readiness.attempts.length, 1)
    assert.match(error.cause.message, /exceeded 7ms/)
    return true
  })
  await until(() => h.timers.size === 1)
  assert.equal([...h.timers.values()][0].at, 7)
  h.advance(7)
  await rejection
  assert.equal(h.calls[0].options.signal.aborted, true)
  assert.equal(h.timers.size, 0)
})

test('an unconfigured remote health endpoint is skipped without inventing an actuator URL', async () => {
  for (const apiHealthUrl of [undefined, '', '   ']) {
    const evidence = await waitForApiReady({
      settings: { target: 'prod', apiBase: 'https://example.invalid', apiHealthUrl }
    }, { fetch: () => assert.fail('unconfigured remote health must not use the network') })
    assert.equal(evidence.status, 'SKIPPED')
    assert.equal(evidence.url, null)
    assert.deepEqual(evidence.attempts, [])
  }
})

test('a configured remote health URL is checked using the same strict HTTP and UP contract', async () => {
  const h = virtualTransport((attempt) => response(attempt === 1 ? 503 : 200))
  const evidence = await waitForApiReady({
    settings: {
      target: 'prod', apiBase: 'https://example.invalid',
      apiHealthUrl: 'https://example.invalid/ops/health'
    },
    timeoutMs: 25,
    intervalMs: 10
  }, h.tools)
  assert.equal(evidence.status, 'UP')
  assert.equal(h.calls.length, 2)
  assert.ok(h.calls.every((call) => call.url === 'https://example.invalid/ops/health'))
})

test('invalid or unbounded wait settings are refused before any network call', async () => {
  for (const name of ['timeoutMs', 'intervalMs', 'requestTimeoutMs']) {
    for (const value of [0, -1, NaN, Infinity, 1.5, 2147483648]) {
      await assert.rejects(
        waitForApiReady({ settings: local, [name]: value }, {
          fetch: () => assert.fail('invalid durations must not use the network')
        }),
        /BLOCKED:.*positive bounded integer/
      )
    }
  }
})
