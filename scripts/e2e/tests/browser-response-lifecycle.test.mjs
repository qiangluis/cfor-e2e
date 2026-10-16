import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { gotoSite, isReleasedResponseBodyError, observePage } from '../lib/browser.mjs'

const responseFor = (request, text, status = 200) => ({
  url: () => 'http://127.0.0.1:48083/admin-api/pms/pm/project/get?id=101',
  status: () => status,
  request: () => request,
  headers: () => ({ 'content-type': 'application/json' }),
  text
})
const requestFor = () => ({
  url: () => 'http://127.0.0.1:48083/admin-api/pms/pm/project/get?id=101',
  method: () => 'GET',
  resourceType: () => 'fetch',
  failure: () => ({ errorText: 'net::ERR_ABORTED' })
})

test('response observer reads JSON only after requestfinished and captures domain failures', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [] }
  const observer = observePage(page, record)
  const request = requestFor()
  let reads = 0
  page.emit('response', responseFor(request, async () => {
    reads++
    return JSON.stringify({ code: 2050100000, msg: '项目不存在', data: null })
  }))
  await Promise.resolve()
  assert.equal(reads, 0)
  page.emit('requestfinished', request)
  await observer.flushResponses()
  assert.equal(reads, 1)
  assert.equal(record.failedApiResponses[0].code, 2050100000)
})

test('cancelled JSON response records the request failure without leaving a body read pending', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [], requestFailures: [] }
  const observer = observePage(page, record)
  const request = requestFor()
  page.emit('response', responseFor(request, async () => assert.fail('aborted body must not be read')))
  page.emit('requestfailed', request)
  await observer.flushResponses()
  assert.equal(record.requestFailures.length, 1)
  assert.equal(record.requestFailures[0].error, 'net::ERR_ABORTED')
  assert.equal(record.failedApiResponses.length, 0)
})

test('response body read failures cannot disappear from runtime evidence', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [] }
  const observer = observePage(page, record)
  const request = requestFor()
  page.emit('response', responseFor(request, async () => { throw new Error('body unavailable') }))
  page.emit('requestfinished', request)
  await observer.flushResponses()
  assert.equal(record.failedApiResponses[0].responseError, true)
  assert.match(record.failedApiResponses[0].error, /body unavailable/)
})

test('navigation-released successful response bodies do not become API failures', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [] }
  const observer = observePage(page, record)
  const request = requestFor()
  page.emit('response', responseFor(request, async () => {
    throw new Error(
      'Protocol error (Network.getResponseBody): No resource with given identifier found'
    )
  }))
  page.emit('requestfinished', request)
  await observer.flushResponses()
  assert.deepEqual(record.failedApiResponses, [])
})

test('browser-close response bodies do not become API failures', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [] }
  const observer = observePage(page, record)
  const request = requestFor()
  page.emit('response', responseFor(request, async () => {
    throw new Error('Target page, context or browser has been closed')
  }))
  page.emit('requestfinished', request)
  await observer.flushResponses()
  assert.equal(isReleasedResponseBodyError(
    new Error('Target page, context or browser has been closed')
  ), true)
  assert.deepEqual(record.failedApiResponses, [])
})

test('HTTP failures are recorded without waiting for a response body', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [] }
  const observer = observePage(page, record)
  page.emit('response', responseFor(requestFor(), async () => assert.fail('HTTP failure body'), 500))
  await observer.flushResponses()
  assert.equal(record.failedApiResponses[0].status, 500)
})

test('flush waits for an API request whose response headers have not arrived', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [] }
  const observer = observePage(page, record)
  const request = requestFor()
  page.emit('request', request)
  let flushed = false
  const pending = observer.flushResponses().then(() => { flushed = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(flushed, false)
  page.emit('response', responseFor(request, async () => '{"code":500}'))
  page.emit('requestfinished', request)
  await pending
  assert.equal(record.failedApiResponses[0].code, 500)
})

test('flush drains responses added while an earlier response body is still reading', async () => {
  const page = new EventEmitter()
  const record = { failedApiResponses: [] }
  const observer = observePage(page, record)
  const first = requestFor()
  const second = requestFor()
  let finishFirst
  page.emit('response', responseFor(first, () => new Promise((resolve) => { finishFirst = resolve })))
  page.emit('requestfinished', first)
  await Promise.resolve()
  const pending = observer.flushResponses()
  page.emit('response', responseFor(second, async () => '{"code":2050100000}'))
  page.emit('requestfinished', second)
  finishFirst('{"code":0}')
  await pending
  assert.equal(record.failedApiResponses.length, 1)
  assert.equal(record.failedApiResponses[0].code, 2050100000)
})

test('navigation drains response bodies before Chrome can release the old document', async () => {
  const page = new EventEmitter()
  const observer = observePage(page, { failedApiResponses: [] })
  const request = requestFor()
  let bodyRead = false
  page.emit('response', responseFor(request, async () => {
    bodyRead = true
    return '{"code":0}'
  }))
  page.emit('requestfinished', request)
  page.goto = async () => assert.equal(bodyRead, true)
  await gotoSite(page, 'http://127.0.0.1:9151/index')
  assert.equal(observePage(page, {}), observer)
})

test('non-JSON streaming responses do not block case or navigation drains', async () => {
  const page = new EventEmitter()
  const observer = observePage(page, { failedApiResponses: [] })
  const request = requestFor()
  page.emit('request', request)
  page.emit('response', {
    ...responseFor(request, async () => assert.fail('stream body must not be read')),
    headers: () => ({ 'content-type': 'text/event-stream' })
  })
  await observer.flushResponses()
})

test('shared material-grade prefetch does not block case reuse', async () => {
  const page = new EventEmitter()
  const observer = observePage(page, { failedApiResponses: [] })
  page.emit('request', {
    url: () => 'http://127.0.0.1:48083/admin-api/base/material-grade/simple-list',
    method: () => 'GET',
    resourceType: () => 'fetch',
    failure: () => null
  })
  await observer.flushResponses({ timeoutMs: 20, quietMs: 0 })
})

test('portal announcement polling does not block case reuse', async () => {
  const page = new EventEmitter()
  const observer = observePage(page, { failedApiResponses: [] })
  page.emit('request', {
    url: () => 'http://127.0.0.1:48083/admin-api/oa/announcement/received-page?pageNo=1&pageSize=10',
    method: () => 'GET',
    resourceType: () => 'fetch',
    failure: () => null
  })
  await observer.flushResponses({ timeoutMs: 20, quietMs: 0 })
})

test('portal home workspace prefetch burst does not block case reuse', async () => {
  const page = new EventEmitter()
  page.url = () => 'http://127.0.0.1:9151/index'
  const observer = observePage(page, { failedApiResponses: [] })
  // 登录后门户首页会并发预取这批聚合小部件；用例随即整页跳转时它们会被浏览器取消，
  // Playwright 不会补发 requestfinished/requestfailed，必须不阻塞上下文复用。
  const prefetch = [
    'workbench/todo/page?category=all&pageNo=1&pageSize=8',
    'bpm/task/done-page?pageNo=1&pageSize=8',
    'bpm/process-instance/my-page?pageNo=1&pageSize=8',
    'bpm/process-instance/copy/page?pageNo=1&pageSize=8',
    'system/notify-message/my-page?pageNo=1&pageSize=8',
    'system/notice/page?pageNo=1&pageSize=6',
    'hrm/survey/my-pending',
    'oa/schedule/my-page?pageNo=1&pageSize=100',
    'oa/schedule/received-page?pageNo=1&pageSize=100',
    'oa/meeting-booking/my-range?rangeStart=2026-10-01&rangeEnd=2026-10-31',
    'oa/task/received-page?pageNo=1&pageSize=5',
    'oa/plan/page?pageNo=1&pageSize=5',
    'oa/contact/my-page?pageNo=1&pageSize=6',
    'erp/sale-order/page?pageNo=1&pageSize=5&tracked=true',
    'pms/pm/project/page?pageNo=1&pageSize=5',
    'pms/kb/favorite/page?pageNo=1&pageSize=6',
    'pm/daily-report/page?pageNo=1&pageSize=100&reportType=DAILY&reporterId=1',
    'crm/work-report/page?pageNo=1&pageSize=100&reportType=WEEKLY&ownerUserId=1',
    'system/user-favorite/page?pageNo=1&pageSize=5'
  ]
  for (const path of prefetch) {
    page.emit('request', {
      url: () => `http://127.0.0.1:9151/admin-api/${path}`,
      method: () => 'GET',
      resourceType: () => 'xhr',
      failure: () => null
    })
  }
  await observer.flushResponses({ timeoutMs: 50, quietMs: 0 })
})

test('the same list endpoints still block when a business page issues them', async () => {
  const page = new EventEmitter()
  page.url = () => 'http://127.0.0.1:9151/pms/pm/project'
  const observer = observePage(page, { failedApiResponses: [] })
  // 首页聚合预取的放行条件是「路径命中且发起时就在门户首页文档」。
  page.emit('request', {
    url: () => 'http://127.0.0.1:9151/admin-api/pms/pm/project/page?pageNo=1&pageSize=20',
    method: () => 'GET',
    resourceType: () => 'xhr',
    failure: () => null
  })
  await assert.rejects(observer.flushResponses({ timeoutMs: 50, quietMs: 0 }),
    /禁止复用当前上下文.*project\/page/)
})

test('a drain timeout rejects navigation reuse and reports the pending request', async () => {
  const page = new EventEmitter()
  const observer = observePage(page, { failedApiResponses: [] })
  const request = requestFor()
  page.emit('request', request)
  await assert.rejects(observer.flushResponses({ timeoutMs: 20, quietMs: 0 }),
    /禁止复用当前上下文.*pms\/pm\/project\/get/)
  page.emit('requestfailed', request)
  await observer.flushResponses()
})
