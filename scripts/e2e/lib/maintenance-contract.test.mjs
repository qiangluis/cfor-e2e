import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createApiClient } from './api.mjs'
import { decryptLoginResponse, openRoute, waitForPageReady } from './browser.mjs'
import {
  createFixtureCleanup,
  dataOf,
  fixtureId,
  requiredRows,
  trackDeletable
} from '../suites/iot-maintenance.mjs'

test('maintenance responses preserve null data and accept both page contracts', () => {
  assert.equal(dataOf({ code: 0, data: null }), null)
  assert.deepEqual(dataOf({ id: 7 }), { id: 7 })
  assert.deepEqual(requiredRows({ code: 0, data: { records: [{ id: 7 }] } }, 'page'), [{ id: 7 }])
  assert.deepEqual(requiredRows({ code: 0, data: { list: [{ id: 8 }] } }, 'page'), [{ id: 8 }])
  assert.throws(() => requiredRows({ code: 0, data: {} }, 'page'), /未返回数组/)
})

test('fixture IDs reject envelopes, nulls, and unsafe integers', () => {
  assert.equal(fixtureId({ code: 0, data: 7 }, 'fixture'), 7)
  assert.equal(fixtureId({ code: 0, data: '9223372036854775807' }, 'fixture'), '9223372036854775807')
  for (const value of [null, 0, -1, {}, { id: 7 }, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => fixtureId({ code: 0, data: value }, 'fixture'), /无效 ID/)
  }
})

test('DELETE business helper verifies the response without changing its envelope', async (t) => {
  const requests = []
  let payload = { code: 0, data: true }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  const api = createApiClient({ token: 'test-token', record: { api: [] } })
  assert.deepEqual(await api.deleteBusiness('/fixture/delete?id=7'), payload)
  assert.equal(requests[0].options.method, 'DELETE')
  assert.equal(requests[0].options.body, undefined)
  payload = { code: 409, msg: 'not deletable' }
  await assert.rejects(api.deleteBusiness('/fixture/delete?id=7'), /business failure/)
})

test('fixtures clean up in reverse order and retain cleanup failures', async () => {
  const caseRecord = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-001', caseRecord })
  const deleted = []
  const api = {
    deleteBusiness: async (path) => {
      deleted.push(path)
      return { code: 0, data: !path.endsWith('id=1') }
    }
  }
  trackDeletable(fixtures, api, { code: 0, data: 1 }, '/fixture', 'first')
  trackDeletable(fixtures, api, { code: 0, data: 2 }, '/fixture', 'second')
  await fixtures.cleanup(true)
  assert.deepEqual(deleted, ['/fixture/delete?id=2', '/fixture/delete?id=1'])
  assert.equal(caseRecord.checks[0].passed, true)
  assert.equal(caseRecord.checks[1].passed, false)
  assert.match(caseRecord.notes[0], /清理失败/)
})

test('dynamic route warmup waits for the workbench before retrying the business title', async () => {
  const visits = []
  const texts = []
  let rejected = false
  const page = {
    goto: async (url) => visits.push(url),
    locator: () => ({ evaluate: async () => false }),
    waitForFunction: async (fn, value) => {
      if (typeof value !== 'string') return
      texts.push(value)
      if (!rejected && value === '统计周期') {
        rejected = true
        throw new Error('route not registered')
      }
    }
  }
  await openRoute(page, '/settings/iot/device-status', { readyText: '统计周期' })
  assert.deepEqual(texts, ['统计周期', '工作台', '统计周期'])
  assert.equal(new URL(visits[1]).pathname, '/index')
})

test('page readiness passes the timeout as Playwright options', async () => {
  let args
  await waitForPageReady({ waitForFunction: async (...values) => { args = values } }, 12345)
  assert.equal(args[1], undefined)
  assert.deepEqual(args[2], { timeout: 12345 })
})

test('encrypted login preserves the exact UTF-8 key and rejects lossy numeric configuration', (t) => {
  const key = '12345678901234567890123456789012'
  const previous = process.env.CFOR_API_ENCRYPT_RESPONSE_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.CFOR_API_ENCRYPT_RESPONSE_KEY
    else process.env.CFOR_API_ENCRYPT_RESPONSE_KEY = previous
  })
  process.env.CFOR_API_ENCRYPT_RESPONSE_KEY = key
  const payload = { code: 0, data: { accessToken: 'test-token' } }
  const cipher = crypto.createCipheriv('aes-256-ecb', Buffer.from(key), null)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]).toString('base64')
  const response = { headers: () => ({ 'x-api-encrypt': 'true' }) }
  assert.deepEqual(decryptLoginResponse(response, encrypted), payload)
  process.env.CFOR_API_ENCRYPT_RESPONSE_KEY = String(Number(key))
  assert.throws(() => decryptLoginResponse(response, encrypted), /32 UTF-8 bytes/)
})
