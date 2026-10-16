import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { isBusinessRejection } from '../lib/api.mjs'
import {
  hasPausedWorkReadback,
  isPauseValidationRejection,
  pausedWorkRows,
  pauseWorkPageRows
} from '../suites/mes-prod-task-report.mjs'

const source = fs.readFileSync(new URL('../suites/mes-prod-task-report.mjs', import.meta.url), 'utf8')
const pause002 = source.slice(source.indexOf("if (caseId === 'MES-TASK-REPORT-002')"))

let moduleSequence = 0
const dataModule = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`

// Replace import specifiers only, leaving the actual suite implementation intact.
async function isolatedSuite (dependencies) {
  const key = `__mesPauseContract${++moduleSequence}`
  globalThis[key] = dependencies
  try {
    const body = source.replace(/from '(\.\.?\/[^']+)'/g, (match, specifier) => {
      const injected = dependencies[specifier]
      const url = injected
        ? dataModule(Object.keys(injected).map((name) =>
          `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}].${name};`
        ).join('\n'))
        : new URL(specifier, new URL('../suites/mes-prod-task-report.mjs', import.meta.url)).href
      return `from ${JSON.stringify(url)}`
    })
    return await import(dataModule(body))
  } finally {
    delete globalThis[key]
  }
}

async function pauseHarness (options = {}) {
  const calls = []
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const shared = { id: '2106200343998562305', status: 2, remark: 'shared production' }
  const originalShared = structuredClone(shared)
  let fixture
  let work
  const snapshot = (patch = {}) => ({ ...work, ...patch })
  const api = {
    async getBusiness (path) {
      calls.push({ action: 'read', path })
      assert.equal(path, `/mes/prodWork/queryById?id=${encodeURIComponent(work.id)}`)
      return { code: 0, data: snapshot() }
    },
    async request (method, path, body, requestOptions) {
      calls.push({
        action: 'negative',
        method,
        path,
        body: structuredClone(body),
        options: structuredClone(requestOptions)
      })
      assert.equal(method, 'POST')
      assert.equal(path, '/mes/prodWork/pause')
      assert.equal(body.id, work.id)
      assert.equal(body.prodWorkOrderId, work.id)
      assert.notEqual(body.id, shared.id)
      if (options.failAt === 'negative') throw new Error('unit negative transport failure')
      if (options.negativeMutation) work.status = 3
      return options.negativeResponse || {
        code: 400,
        msg: body.pauseReason ? '预计恢复时间不能为空' : '暂停原因不能为空'
      }
    }
  }
  class Fixture {
    constructor (_api, _record, caseId) {
      assert.equal(_api, api)
      assert.equal(caseId, 'MES-TASK-REPORT-002')
      this.marker = 'AUTOTEST-MES-TASK-REPORT-002-UNIT'
      this.works = []
      fixture = this
    }

    async setup () {
      calls.push({ action: 'setup' })
      work = { id: '9223372036854775806', status: 1, remark: this.marker }
      this.works = [work]
      if (options.failAt === 'setup') throw new Error('unit setup failure')
    }

    async startWork () {
      calls.push({ action: 'start' })
      if (options.failAt === 'start') throw new Error('unit start failure')
      work.status = 2
      return snapshot(options.started)
    }

    async pauseWork (reason, time) {
      calls.push({ action: 'pause', reason, time })
      if (options.failAt === 'pause') throw new Error('unit pause failure')
      Object.assign(work, { status: 3, pauseReason: reason, expectResumeTime: time })
      return snapshot(options.paused)
    }

    async resumeWork () {
      calls.push({ action: 'resume' })
      if (options.failAt === 'resume') throw new Error('unit resume failure')
      Object.assign(work, { status: 2, resumeTime: '2026-10-08T10:00:00+08:00' })
      return snapshot(options.resumed)
    }

    async cleanup () {
      calls.push({ action: 'cleanup' })
    }
  }
  const suite = await isolatedSuite({
    '../lib/api.mjs': { createApiClient: () => api, isBusinessRejection },
    '../lib/browser.mjs': {
      login: async () => 'unit-token',
      openRoute: async (_page, route, routeOptions) => {
        calls.push({ action: 'route', route, options: routeOptions })
        if (options.failAt === 'route') throw new Error('unit route failure')
      },
      saveScreenshot: async (_page, _dir, name) => {
        calls.push({ action: 'screenshot', name })
        if (options.failAt === 'screenshot') throw new Error('unit screenshot failure')
      }
    },
    '../lib/db.mjs': {
      databaseConfigured: () => assert.fail('002 must not enter 001 database branch'),
      runReadOnlySql: () => assert.fail('suite must delegate database setup to its fixture')
    },
    '../fixtures/mes-execution-write.mjs': { ExecutionWorkflowFixture: Fixture }
  })
  return {
    calls, api, caseRecord,
    run: () => suite.runCase({
      caseId: 'MES-TASK-REPORT-002', page: {}, record: {}, caseRecord, outputDir: '/unused'
    }),
    assertSharedUnchanged: () => assert.deepEqual(shared, originalShared),
    fixture: () => fixture
  }
}

test('pause prerequisite pages accept legacy success and preserve valid empty pages', () => {
  const rows = [{ id: '2106200343998562305' }]
  assert.deepEqual(pauseWorkPageRows({
    code: 200, success: true, data: { records: rows, total: 1 }
  }), rows)
  assert.deepEqual(pauseWorkPageRows({ code: 0, data: { list: [], total: 0 } }), [])
  assert.deepEqual(pauseWorkPageRows({ code: 0, data: rows }), rows)
})

test('failed or malformed work pages cannot be reported as missing formal work', () => {
  for (const result of [
    undefined,
    { code: 500, data: { records: [], total: 0 } },
    { code: 200, success: false, data: { records: [], total: 0 } },
    { code: 0, data: null },
    { code: 0, data: { total: 0 } },
    { code: 0, data: { records: [], total: 2 } },
    { code: 0, data: { records: [{ id: '1' }], total: 0 } },
    { code: 0, data: { records: [{ id: '' }], total: 1 } }
  ]) {
    assert.throws(() => pauseWorkPageRows(result), /不能视为缺少正式单据/)
  }
})

test('only explicit pause mandatory-field errors count as negative validation evidence', () => {
  for (const message of ['暂停原因不能为空', '预计恢复时间不能为空']) {
    assert.equal(isPauseValidationRejection({ code: 400, msg: message }, message), true)
    for (const result of [
      undefined,
      { code: 0, msg: message },
      { code: 200, success: true, message },
      { code: 400, success: true, msg: message },
      { code: 400, msg: '其他业务错误' },
      { code: 404, msg: '请求地址不存在' },
      { code: 500, msg: '工单不存在' },
      { code: 500, msg: '系统异常' }
    ]) {
      assert.equal(isPauseValidationRejection(result, message), false)
    }
  }
})

test('002 runs owned start, mandatory-field negatives, pause readback, resume and cleanup', async () => {
  const h = await pauseHarness()
  const result = await h.run()
  assert.equal(result.api, h.api)
  assert.notEqual(result.partial, true)
  assert.deepEqual(h.calls.map((call) => call.action), [
    'setup', 'start', 'negative', 'read', 'negative', 'pause', 'resume',
    'route', 'screenshot', 'cleanup'
  ])
  const negatives = h.calls.filter((call) => call.action === 'negative')
  assert.deepEqual(negatives.map((call) => call.body), [
    { id: '9223372036854775806', prodWorkOrderId: '9223372036854775806' },
    {
      id: '9223372036854775806', prodWorkOrderId: '9223372036854775806',
      pauseReason: h.fixture().marker
    }
  ])
  assert.deepEqual(negatives.map((call) => call.options), [
    {
      expectedBusinessRejection: {
        code: 400,
        message: '暂停原因不能为空'
      }
    },
    {
      expectedBusinessRejection: {
        code: 400,
        message: '预计恢复时间不能为空'
      }
    }
  ])
  const pause = h.calls.find((call) => call.action === 'pause')
  assert.equal(pause.reason, h.fixture().marker)
  assert.ok(Number.isFinite(Date.parse(pause.time)))
  assert.equal(h.caseRecord.checks.length, 5)
  assert.ok(h.caseRecord.checks.every((check) => check.passed))
  assert.match(h.caseRecord.evidence[0], /开工后校验暂停必填、暂停落库回读并恢复/)
  h.assertSharedUnchanged()
})

test('empty lists or negative-only results cannot prove pause field readback', () => {
  const paused = {
    id: '2106200343998562305', status: 3,
    pauseReason: 'machine inspection', expectResumeTime: '2026-10-06 18:00:00'
  }
  assert.equal(hasPausedWorkReadback([]), false)
  assert.equal(hasPausedWorkReadback([{ ...paused, status: 2 }]), false)
  assert.equal(hasPausedWorkReadback([{ ...paused, pauseReason: ' ' }]), false)
  assert.equal(hasPausedWorkReadback([{ ...paused, expectResumeTime: 'invalid' }]), false)
  assert.equal(hasPausedWorkReadback([paused, { ...paused, pauseReason: '' }]), false)
  assert.equal(hasPausedWorkReadback([paused, { ...paused, status: '3' }]), true)
  assert.equal(pausedWorkRows([{ ...paused, status: ' 3 ' }]).length, 0)
})

test('002 screenshots use the actual work-order route after resume and before cleanup', async () => {
  const h = await pauseHarness()
  await h.run()
  assert.deepEqual(h.calls.find((call) => call.action === 'route'), {
    action: 'route',
    route: '/mes/produce/work-order',
    options: { readySelector: '.search-form input[placeholder="请输入工单编号"]' }
  })
  assert.equal(h.calls.find((call) => call.action === 'screenshot').name, 'mes-prod-work-pause')
  assert.ok(h.calls.findIndex((call) => call.action === 'resume') <
    h.calls.findIndex((call) => call.action === 'screenshot'))
  assert.match(pause002, /finally\s*\{\s*await fixture\.cleanup\(caseRecord\)/)
})

test('002 business success and unrelated failures never count as mandatory-field rejection', async () => {
  for (const response of [
    { code: 0, msg: '暂停原因不能为空' },
    { code: 200, success: true, message: '暂停原因不能为空' },
    { code: 400, success: true, msg: '暂停原因不能为空' },
    { code: 404, msg: '请求地址不存在' },
    { code: 500, msg: '工单不存在' },
    { code: 500, msg: '系统异常' }
  ]) {
    const h = await pauseHarness({ negativeResponse: response })
    await h.run()
    assert.equal(h.caseRecord.checks[1].passed, false)
    assert.equal(h.caseRecord.checks[2].passed, false)
    assert.equal(h.calls.at(-1).action, 'cleanup')
    h.assertSharedUnchanged()
  }
})

test('002 rejects a mandatory-field failure that mutates the running work', async () => {
  const h = await pauseHarness({ negativeMutation: true })
  await h.run()
  assert.equal(h.caseRecord.checks[1].passed, false)
  assert.equal(h.calls.at(-1).action, 'cleanup')
})

test('002 cannot pass with wrong start ownership, missing pause fields or lost resume history', async () => {
  for (const [options, index] of [
    [{ started: { remark: 'shared marker' } }, 0],
    [{ paused: { status: 2 } }, 3],
    [{ paused: { pauseReason: '' } }, 3],
    [{ paused: { expectResumeTime: 'invalid' } }, 3],
    [{ resumed: { status: 3 } }, 4],
    [{ resumed: { pauseReason: '' } }, 4],
    [{ resumed: { resumeTime: null } }, 4]
  ]) {
    const h = await pauseHarness(options)
    await h.run()
    assert.equal(h.caseRecord.checks[index].passed, false, JSON.stringify(options))
    assert.equal(h.calls.at(-1).action, 'cleanup')
  }
})

for (const stage of ['setup', 'start', 'negative', 'pause', 'resume', 'route', 'screenshot']) {
  test(`002 ${stage} failure propagates and still cleans up exactly once`, async () => {
    const h = await pauseHarness({ failAt: stage })
    await assert.rejects(h.run, new RegExp(`unit ${stage}.*failure`))
    assert.equal(h.calls.filter((call) => call.action === 'cleanup').length, 1)
    assert.equal(h.calls.at(-1).action, 'cleanup')
    assert.equal(h.caseRecord.evidence.length, 0)
    h.assertSharedUnchanged()
  })
}
