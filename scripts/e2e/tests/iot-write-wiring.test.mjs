import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createDomContentLoadedPage, runCase } from '../suites/iot.mjs'

const runtime = {
  target: 'local',
  tenantName: 'CFOR 标准平台',
  tenantId: '1',
  apiBase: 'http://127.0.0.1:48083',
  apiUrl: 'http://127.0.0.1:48083/admin-api',
  webBase: 'http://127.0.0.1:9151',
  iotRuntimeEnabled: true
}

const caseRecord = (id) => ({
  id,
  caseId: id,
  checks: [],
  notes: [],
  evidence: []
})

const page = {
  url: () => 'about:blank'
}

test('IOT-002/009/010/011/013 dispatch to the injected write closure without browser/API calls', async () => {
  const calls = []
  for (const caseId of ['IOT-002', 'IOT-009', 'IOT-010', 'IOT-011', 'IOT-013']) {
    const record = caseRecord(caseId)
    const result = await runCase({
      caseId,
      page,
      record: { api: [] },
      caseRecord: record,
      outputDir: '/unused'
    }, {
      runtime,
      login: async () => {
        calls.push(`${caseId}:login`)
        return { token: `unit-${caseId}`, tenantId: '1' }
      },
      createApiClient: ({ token, tenantId }) => {
        calls.push(`${caseId}:api:${token}:${tenantId}`)
        return { token, tenantId }
      },
      runIotSecurityE2e: async ({ caseId: dispatchedCaseId, fixtures }) => {
        calls.push(`${caseId}:write:${dispatchedCaseId}`)
        assert.equal(dispatchedCaseId, caseId)
        await fixtures.cleanup(true)
        return { partial: true, note: 'unit wiring only' }
      }
    })
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.ok(record.catalogAssertions.every((row) => row.status === 'GAP'))
  }
  assert.deepEqual(calls.filter((entry) => entry.includes(':write:')), [
    'IOT-002:write:IOT-002',
    'IOT-009:write:IOT-009',
    'IOT-010:write:IOT-010',
    'IOT-011:write:IOT-011',
    'IOT-013:write:IOT-013'
  ])
})

test('IOT-001 navigation proxy forces domcontentloaded but preserves timeout and predicate', async () => {
  let received
  const target = {
    waitForURL: async (predicate, options) => {
      received = { predicate, options }
      assert.equal(predicate(new URL('http://127.0.0.1:9151/iot/target')), true)
    },
    url: () => 'http://127.0.0.1:9151/iot/target'
  }
  const proxy = createDomContentLoadedPage(target)
  await proxy.waitForURL(
    (url) => url.pathname === '/iot/target',
    { timeout: 1234, waitUntil: 'load' }
  )
  assert.equal(received.options.waitUntil, 'domcontentloaded')
  assert.equal(received.options.timeout, 1234)
  assert.equal(proxy.url(), target.url())
})

test('suite source no longer routes target write cases through the old readonly wrappers', () => {
  const source = fs.readFileSync(new URL('../suites/iot.mjs', import.meta.url), 'utf8')
  for (const caseId of ['IOT-002', 'IOT-009', 'IOT-010', 'IOT-011', 'IOT-013']) {
    assert.match(source, new RegExp(`caseId === '${caseId}'[\\s\\S]{0,180}runIotWriteCase`))
  }
  assert.match(source, /page: createDomContentLoadedPage\(page\)/)
  assert.doesNotMatch(source, /if \(caseId === 'IOT-001'\) \{\s+return await runIotWriteCase/)
})
