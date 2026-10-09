import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiClient, serverApiFailures } from '../lib/api.mjs'
import { caseRuntimeErrors } from '../runner.mjs'

test('service errors cannot be confused with explicit business rejections', () => {
  const failures = [
    { status: 500, code: 0 }, { status: 503 },
    { status: 200, code: 500 }, { status: 200, code: '503' },
    { networkError: true }, { responseError: true }
  ]
  assert.deepEqual(serverApiFailures([
    { status: 200, code: 0 }, { status: 200, code: 200 },
    { status: 200, code: 1005000001 }, { status: 403, code: 403 },
    ...failures
  ]), failures)
})

async function withFetch (fetch, operation) {
  const original = globalThis.fetch
  try {
    globalThis.fetch = fetch
    return await operation()
  } finally {
    globalThis.fetch = original
  }
}

test('caught HTTP and business 500 responses remain in the per-case error evidence', async () => {
  for (const status of [200, 500]) {
    const record = { api: [] }
    const api = createApiClient({ record })
    await withFetch(async () => new Response(JSON.stringify({
      code: 500, msg: 'system error'
    }), { status }), async () => {
      await assert.rejects(() => api.getBusiness('/unit-only'), /500/)
    })
    assert.equal(serverApiFailures(record.api).length, 1)
  }
})

test('only an explicitly matched valid 2xx business rejection leaves Node runtime evidence clean', async () => {
  const record = {
    api: [],
    consoleErrors: [],
    pageErrors: [],
    failedApiResponses: [],
    requestFailures: []
  }
  const api = createApiClient({ record })
  await withFetch(
    async () => new Response(JSON.stringify({
      code: 422001,
      msg: 'locked model configuration cannot be changed'
    })),
    async () => {
      const result = await api.put('/unit-only', {}, {
        expectedBusinessRejection: {
          code: 422001,
          message: 'locked model configuration cannot be changed'
        }
      })
      assert.equal(result.code, 422001)
    }
  )
  assert.equal(record.api[0].expectedBusinessRejectionMatched, true)
  assert.deepEqual(serverApiFailures(record.api), [])
  assert.deepEqual(
    caseRuntimeErrors(record, {
      console: 0, page: 0, api: 0, request: 0, apiRequests: 0
    }).nodeApi,
    []
  )
})

test('an explicitly matched legacy service code can be treated as a business rejection', async () => {
  const record = { api: [] }
  const api = createApiClient({ record })
  await withFetch(
    async () => new Response(JSON.stringify({
      code: 500, msg: 'legacy business validation'
    })),
    async () => {
      const result = await api.post('/unit-only', {}, {
        expectedBusinessRejection: {
          code: 500,
          message: 'legacy business validation',
          allowServiceCode: true
        }
      })
      assert.equal(result.code, 500)
    }
  )
  assert.equal(record.api[0].expectedBusinessRejectionMatched, true)
  assert.deepEqual(serverApiFailures(record.api), [])
})

test('success, system errors, and service codes never match an expected business rejection', async () => {
  for (const payload of [
    { code: 0, data: { id: 'success' } },
    { code: 200, success: true, data: { id: 'success' } },
    { code: 500, msg: 'business-looking system failure' },
    { code: 503, message: 'Service Unavailable' },
    { code: 422001, msg: '系统异常' }
  ]) {
    const record = { api: [] }
    const api = createApiClient({ record })
    await withFetch(
      async () => new Response(JSON.stringify(payload)),
      async () => {
        const result = await api.post('/unit-only', {}, {
          expectedBusinessRejection: true
        })
        assert.deepEqual(result, payload)
      }
    )
    assert.equal(record.api[0].expectedBusinessRejectionMatched, undefined)
    if (payload.code === 500 || payload.code === 503) {
      assert.deepEqual(serverApiFailures(record.api), record.api)
    } else {
      assert.deepEqual(serverApiFailures(record.api), [])
    }
  }
})

test('HTTP 500 and transport failures remain failures even when a rejection is expected', async () => {
  const httpRecord = { api: [] }
  const httpApi = createApiClient({ record: httpRecord })
  await withFetch(
    async () => new Response(JSON.stringify({ code: 422001, msg: 'valid-looking rejection' }), { status: 500 }),
    async () => {
      await assert.rejects(
        () => httpApi.post('/unit-only', {}, { expectedBusinessRejection: true }),
        /HTTP 500/
      )
    }
  )
  assert.equal(httpRecord.api[0].expectedBusinessRejectionMatched, undefined)
  assert.deepEqual(serverApiFailures(httpRecord.api), httpRecord.api)

  const transportRecord = { api: [] }
  const transportApi = createApiClient({ record: transportRecord })
  const failure = new TypeError('unit-only connection failure')
  await withFetch(async () => { throw failure }, async () => {
    await assert.rejects(
      () => transportApi.post('/unit-only', {}, { expectedBusinessRejection: true }),
      (caught) => caught === failure
    )
  })
  assert.equal(transportRecord.api[0].networkError, true)
  assert.deepEqual(serverApiFailures(transportRecord.api), transportRecord.api)
})

test('caught request and download transport errors remain in the evidence', async () => {
  for (const method of ['get', 'download']) {
    const record = { api: [] }
    const api = createApiClient({ record })
    await withFetch(async () => { throw new Error('unit-only connection failure') }, async () => {
      await assert.rejects(() => api[method]('/unit-only'), /connection failure/)
    })
    assert.equal(record.api[0].networkError, true)
    assert.equal(serverApiFailures(record.api).length, 1)
  }
})

test('success and permission-denied responses are not classified as service failures', async () => {
  for (const code of [0, 403, 1005000001]) {
    const record = { api: [] }
    await withFetch(async () => new Response(JSON.stringify({ code })), async () => {
      const result = await createApiClient({ record }).get('/unit-only')
      assert.equal(result.code, code)
    })
    assert.deepEqual(serverApiFailures(record.api), [])
  }
})

test('the runner counts only current-case Node errors, including errors caught by a suite', () => {
  const currentError = { method: 'GET', pathname: '/unit-current', status: 200, code: 500 }
  const record = {
    api: [{ status: 500 }, { status: 200, code: 0 }, currentError],
    consoleErrors: [], pageErrors: [], failedApiResponses: [], requestFailures: []
  }
  const errors = caseRuntimeErrors(record, {
    console: 0, page: 0, api: 0, request: 0, apiRequests: 1
  })
  assert.deepEqual(errors.nodeApi, [currentError])
  assert.equal(Object.values(errors).every((items) => items.length === 0), false)
})
