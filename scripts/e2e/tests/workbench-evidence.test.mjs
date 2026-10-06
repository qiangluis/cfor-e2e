import test from 'node:test'
import assert from 'node:assert/strict'
import {
  captureWorkbenchReports,
  runCase,
  summarizeWorkbenchReports,
  validateWorkbenchReportPage,
  validateWorkbenchTodoPage
} from '../suites/workbench.mjs'
import { caseOutcome } from '../lib/report.mjs'

function response (url, { ok = true, method = 'GET' } = {}) {
  return {
    url: () => url,
    ok: () => ok,
    request: () => ({ method: () => method })
  }
}

function pagePayload (list, total = list.length) {
  return { code: 0, data: { list, total } }
}

function todoPayload (list, total = list.length, code = 0) {
  return { code, data: { list, total, counts: { all: total } } }
}

const todoUrl = 'http://127.0.0.1:48083/admin-api/workbench/todo/page?category=all&pageNo=1&pageSize=8'

const dailyQuery = {
  type: 'DAILY',
  label: '日报',
  path: '/pm/daily-report/page',
  owner: 'reporterId'
}

test('empty self report page is valid evidence for read success, not permission isolation', () => {
  const result = validateWorkbenchReportPage(
    response('http://127.0.0.1:48083/admin-api/pm/daily-report/page?pageNo=1&pageSize=100&reportType=DAILY&reporterId=7'),
    pagePayload([]),
    dailyQuery,
    7,
    'self'
  )
  assert.deepEqual(result.list, [])
  assert.equal(result.total, 0)
})

test('report evidence rejects wrong owner, type, pagination, and non-GET responses', () => {
  const baseUrl = 'http://127.0.0.1:48083/admin-api/pm/daily-report/page'
  const validRow = {
    id: 1,
    reportType: 'DAILY',
    reporterId: 7,
    periodKey: '2026-10-06',
    status: 'SUBMITTED'
  }

  assert.throws(
    () => validateWorkbenchReportPage(
      response(`${baseUrl}?pageNo=1&pageSize=100&reportType=DAILY&reporterId=8`),
      pagePayload([validRow]),
      dailyQuery,
      7,
      'self'
    ),
    /请求范围不符/
  )
  assert.throws(
    () => validateWorkbenchReportPage(
      response(`${baseUrl}?pageNo=1&pageSize=100&reportType=DAILY&reporterId=7`),
      pagePayload([{ ...validRow, reporterId: 8 }]),
      dailyQuery,
      7,
      'self'
    ),
    /非当前用户报告/
  )
  assert.throws(
    () => validateWorkbenchReportPage(
      response(`${baseUrl}?pageNo=1&pageSize=101&reportType=DAILY&reporterId=7`),
      pagePayload([validRow]),
      dailyQuery,
      7,
      'self'
    ),
    /分页响应/
  )
  assert.throws(
    () => validateWorkbenchReportPage(
      response(`${baseUrl}?pageNo=1&pageSize=100&reportType=DAILY&reporterId=7`, { method: 'POST' }),
      pagePayload([validRow]),
      dailyQuery,
      7,
      'self'
    ),
    /分页响应/
  )
})

test('team report request requires an omitted owner filter and does not claim an empty permission negative', () => {
  const result = validateWorkbenchReportPage(
    response('http://127.0.0.1:48083/admin-api/pm/daily-report/page?pageNo=1&pageSize=100&reportType=DAILY'),
    pagePayload([]),
    dailyQuery,
    7,
    'team'
  )
  assert.equal(result.total, 0)
  assert.throws(
    () => validateWorkbenchReportPage(
      response('http://127.0.0.1:48083/admin-api/pm/daily-report/page?pageNo=1&pageSize=100&reportType=DAILY&reporterId=7'),
      pagePayload([]),
      dailyQuery,
      7,
      'team'
    ),
    /请求范围不符/
  )
})

test('report statistic summary uses browser date period boundaries and status counts', () => {
  const pages = {
    DAILY: {
      list: [
        { reportType: 'DAILY', periodKey: '2026-10-01', status: 'SUBMITTED' },
        { reportType: 'DAILY', periodKey: '2026-10-31', status: 'APPROVED' },
        { reportType: 'DAILY', periodKey: '2026-11-01', status: 'REJECTED' }
      ]
    },
    WEEKLY: {
      list: [
        { reportType: 'WEEKLY', periodStart: '2026-09-28', periodEnd: '2026-10-04', status: 'APPROVED' },
        { reportType: 'WEEKLY', periodStart: '2026-10-26', periodEnd: '2026-11-01', status: 'OVERDUE' }
      ]
    },
    MONTHLY: {
      list: [
        { reportType: 'MONTHLY', periodStart: '2026-10-01', periodEnd: '2026-10-31', status: 'DRAFT' },
        { reportType: 'MONTHLY', periodStart: '2026-11-01', periodEnd: '2026-11-30', status: 'SUBMITTED' }
      ]
    }
  }

  assert.deepEqual(
    summarizeWorkbenchReports(pages, 'month', '2026-10-06'),
    [
      ['日报', '2', '1', '1', '0'],
      ['周报', '2', '0', '1', '1'],
      ['月报', '1', '0', '0', '0']
    ]
  )
  assert.deepEqual(
    summarizeWorkbenchReports(pages, 'quarter', '2026-10-06'),
    [
      ['日报', '3', '1', '1', '1'],
      ['周报', '2', '0', '1', '1'],
      ['月报', '2', '1', '0', '0']
    ]
  )
  assert.deepEqual(
    summarizeWorkbenchReports(pages, 'year', '2026-10-06'),
    [
      ['日报', '3', '1', '1', '1'],
      ['周报', '2', '0', '1', '1'],
      ['月报', '2', '1', '0', '0']
    ]
  )
})

test('todo evidence requires a successful business envelope and preserves the real current-page row count', () => {
  const rows = [{ id: 'todo-1', title: '待处理采购', targetType: 'BPM_PROCESS', targetId: '1' }]
  const result = validateWorkbenchTodoPage(response(todoUrl), todoPayload(rows, 2))
  assert.equal(result.total, 2)
  assert.equal(result.list.length, 1)

  assert.throws(
    () => validateWorkbenchTodoPage(response(todoUrl), todoPayload(rows, 2, 403)),
    /不能用空态替代失败请求/
  )
  assert.throws(
    () => validateWorkbenchTodoPage(response(todoUrl), { code: 0, data: { list: [], total: -1 } }),
    /不能用空态替代失败请求/
  )
  assert.throws(
    () => validateWorkbenchTodoPage(response(todoUrl), { code: 0, data: { list: rows, total: 0 } }),
    /不能用空态替代失败请求/
  )
})

const queries = [
  dailyQuery,
  { type: 'WEEKLY', label: '周报', path: '/crm/work-report/page', owner: 'ownerUserId' },
  { type: 'MONTHLY', label: '月报', path: '/crm/work-report/page', owner: 'ownerUserId' }
]

function browserResponse (path, data = { list: [], total: 0 }, code = 0) {
  return {
    ...response(`http://127.0.0.1:48083/admin-api${path}`),
    headers: () => ({}),
    text: async () => JSON.stringify({ code, data })
  }
}

function reportBatch (scope = 'self', override = {}) {
  return queries.map((query) => browserResponse(
    `${query.path}?pageNo=1&pageSize=100&reportType=${query.type}${scope === 'self' ? `&${query.owner}=7` : ''}`,
    override[query.type] || { list: [], total: 0 }
  ))
}

function browserFixture ({
  permissions = ['*:*:*'],
  batches,
  purchase = true,
  todo = { list: [{ id: 'todo-1', title: '待处理采购' }], total: 1 }
} = {}) {
  const events = []
  const listeners = []
  const queue = batches?.slice() || []
  const evaluations = []
  const caseRecord = { checks: [], notes: [], evidence: [] }
  let dialogVisible = false
  const emit = (responses) => {
    for (const listener of listeners.splice(0)) {
      const matched = responses.find(listener.predicate)
      if (matched) listener.resolve(matched)
      else listener.reject(new Error('unit-only missing response'))
    }
  }
  const locator = (name) => ({
    first () { return this },
    filter ({ hasText }) { return locator(hasText) },
    locator (child) { return locator(child) },
    getByRole (_role, { name }) { return locator(name) },
    waitFor: async ({ state }) => events.push(`wait:${name}:${state}`),
    count: async () => {
      if (name === '.el-checkbox') return 4
      if (name === '.todo-body .work-list-row') return todo.list.length
      if (name === '.todo-body .el-empty') return todo.list.length === 0 ? 1 : 0
      return purchase ? 1 : 0
    },
    isVisible: async () => name === '.report-stats-dialog' ? dialogVisible : true,
    innerText: async () => '今日日报未填写 本周周报未填写 本月月报未填写 待审批 0',
    click: async () => {
      events.push(`click:${name}`)
      assert.notEqual(name, '新增采购订单', 'Opening allocates a formal number')
      assert.notEqual(name, '保存', 'Shared user preference writes are forbidden')
      if (name === '.todo-body .work-list-row') dialogVisible = true
      if (name === '统计') dialogVisible = true
      if (name === '关闭') dialogVisible = false
      if (['统计', '本季度', '本年度', '团队（按数据权限）', '本人'].includes(name)) {
        emit(queue.shift() || reportBatch(name === '团队（按数据权限）' ? 'team' : 'self'))
      }
      if (name === '采购执行表') emit([
        browserResponse('/erp/purchase-order/page?pageNo=1&pageSize=10&status=20')
      ])
      if (name === '.el-dialog__headerbtn') emit([
        browserResponse('/workbench/todo/page?category=all&pageNo=1&pageSize=8', todo)
      ])
    }
  })
  const api = {
    get: async (path) => {
      assert.equal(path, '/system/auth/get-permission-info')
      return { code: 0, data: { user: { id: 7 }, permissions } }
    },
    put: async () => assert.fail('Unexpected PUT'),
    post: async () => assert.fail('Unexpected POST'),
    delete: async () => assert.fail('Unexpected DELETE')
  }
  const page = {
    url: () => 'http://127.0.0.1:9151/index',
    locator,
    getByRole: (_role, { name }) => locator(name),
    waitForResponse: (predicate) => new Promise((resolve, reject) => {
      events.push('listen')
      listeners.push({ predicate, resolve, reject })
    }),
    waitForFunction: async (_predicate, args) => { evaluations.push(args); events.push('rendered') },
    evaluate: async () => '2026-10-06'
  }
  const dependencies = {
    login: async () => 'unit-only-token',
    createApiClient: () => api,
    openRoute: async () => {
      events.push('navigate')
      emit([
        ...reportBatch(),
        browserResponse('/workbench/todo/page?category=all&pageNo=1&pageSize=8', todo),
        browserResponse('/system/user-preference/get?key=workbench.quick-actions', '[]')
      ])
    },
    saveScreenshot: async () => { events.push('screenshot') }
  }
  return { page, api, caseRecord, dependencies, events, evaluations, emit }
}

async function runFixture (caseId, options) {
  const fixture = browserFixture(options)
  const result = await runCase({
    caseId, page: fixture.page, record: {}, caseRecord: fixture.caseRecord, outputDir: '/unit-only'
  }, fixture.dependencies)
  return { ...fixture, result }
}

test('WBF-002 waits for the real non-empty todo response before accepting a row', async () => {
  const fixture = await runFixture('WBF-002')
  assert.equal(fixture.result.partial, undefined)
  assert.deepEqual(fixture.evaluations, [{ expectedRowCount: 1 }])
  assert.match(fixture.caseRecord.checks[1].details, /响应 rows=1，DOM rows=1/)
})

test('WBF-004 skips report reads when the exact CRM permission is absent without wildcard access', async () => {
  const fixture = await runFixture('WBF-004', {
    permissions: ['pm:daily-report:query']
  })
  assertPartial(fixture)
  assert.match(fixture.result.note, /crm:work-report:query/)
  assert.deepEqual(fixture.events, [])
})

test('WBF-003 revalidates the refreshed todo response and DOM count after closing the dialog', async () => {
  const fixture = await runFixture('WBF-003')
  assert.equal(fixture.result.partial, undefined)
  assert.deepEqual(fixture.evaluations, [{ expectedRowCount: 1 }, { expectedRowCount: 1 }])
  assert.match(fixture.caseRecord.checks.at(-2).details, /刷新响应 total=1，响应 rows=1，DOM rows=1/)
})

test('WBF-003 keeps a genuinely empty todo response BLOCKED after synchronized empty rendering', async () => {
  const fixture = browserFixture({ todo: { list: [], total: 0 } })
  await assert.rejects(
    () => runCase({
      caseId: 'WBF-003',
      page: fixture.page,
      record: {},
      caseRecord: fixture.caseRecord,
      outputDir: '/unit-only'
    }, fixture.dependencies),
    /BLOCKED: 需先通过真实 BPM 流程创建待办/
  )
  assert.deepEqual(fixture.evaluations, [{ expectedRowCount: 0 }])
  assert.match(fixture.caseRecord.notes[0], /真实待办 total=0\/当前页 rows=0/)
})

function assertPartial ({ result, caseRecord }) {
  assert.equal(result.partial, true)
  assert.equal(caseOutcome({
    failedChecks: caseRecord.checks.filter((check) => !check.passed),
    partial: false, hasAssertions: true, result
  }).status, 'PARTIAL')
  assert.match(result.note, /未验收/)
}

test('WBF-004 listens before navigation and really clicks all three cached tabs, even when empty', async () => {
  const fixture = await runFixture('WBF-004')
  assertPartial(fixture)
  assert.deepEqual(fixture.events.slice(0, 4), ['listen', 'listen', 'listen', 'navigate'])
  assert.deepEqual(fixture.events.filter((event) => event.startsWith('click:')),
    ['click:日报', 'click:周报', 'click:月报'])
  assert.deepEqual(fixture.evaluations.map(({ label, titles }) => [label, titles]),
    [['日报', []], ['周报', []], ['月报', []]])
  assert.match(fixture.result.note, /空列表合法但不证明/)
})

test('WBF-005 never opens the number-allocating form and closes the read-only execution dialog', async () => {
  const fixture = await runFixture('WBF-005')
  assertPartial(fixture)
  assert.deepEqual(fixture.events.filter((event) => event.startsWith('click:')),
    ['click:采购执行表', 'click:.el-dialog__headerbtn'])
  assert.match(fixture.result.note, /mes_bas_sequence/)
})

test('WBF-005 missing configured actions returns PARTIAL without a false failing prerequisite', async () => {
  const fixture = await runFixture('WBF-005', { purchase: false })
  assertPartial(fixture)
  assert.ok(!fixture.events.some((event) => event.startsWith('click:')))
})

test('WBF-008 opens and cancels the format without toggling, saving or restoring shared preferences', async () => {
  const fixture = await runFixture('WBF-008')
  assertPartial(fixture)
  assert.deepEqual(fixture.events.filter((event) => event.startsWith('click:')),
    ['click:格式', 'click:取消'])
  assert.match(fixture.result.note, /精确保存值、刷新后回显、用户隔离/)
})

test('WBF-012 waits for real batches and checks all three periods, team and self data', async () => {
  const fixture = await runFixture('WBF-012')
  assertPartial(fixture)
  assert.deepEqual(fixture.events.filter((event) => event.startsWith('click:')), [
    'click:统计', 'click:本季度', 'click:本年度', 'click:团队（按数据权限）', 'click:本人', 'click:关闭'
  ])
  assert.deepEqual(fixture.evaluations.map(({ periodLabel, scopeLabel }) => [periodLabel, scopeLabel]), [
    ['本月', '本人'], ['本季度', '本人'], ['本年度', '本人'], ['本年度', '团队（按数据权限）'], ['本年度', '本人']
  ])
  assert.ok(fixture.events.filter((event) => event.endsWith('.el-loading-mask:hidden')).length >= 5)
  assert.match(fixture.result.note, /权限反例/)
})

test('WBF-012 restricted users never request unverified broad PMS team data', async () => {
  const fixture = await runFixture('WBF-012', {
    permissions: ['pm:daily-report:query', 'crm:work-report:query']
  })
  assertPartial(fixture)
  assert.ok(!fixture.events.includes('click:团队（按数据权限）'))
  assert.match(fixture.result.note, /未点击团队/)
})

test('WBF-012 truncated response is a complete-summary gap rather than full PASS', async () => {
  const fixture = await runFixture('WBF-012', {
    batches: [reportBatch('self', { DAILY: { list: [], total: 101 } })]
  })
  assertPartial(fixture)
  assert.match(fixture.result.note, /0\/101.*完整汇总未验收/)
})

test('missing real report responses remain explicit gaps; HTTP 200 business errors cannot pass', async () => {
  const fixture = browserFixture()
  const captured = await captureWorkbenchReports(fixture.page, async () => fixture.emit([]), 7)
  assert.equal(captured.missing.length, 3)
  assert.deepEqual(captured.pages, {})
  const failed = browserFixture()
  await assert.rejects(() => captureWorkbenchReports(failed.page, async () => failed.emit([
    browserResponse('/pm/daily-report/page?pageNo=1&pageSize=100&reportType=DAILY&reporterId=7',
      { list: [], total: 0 }, 403),
    ...reportBatch().slice(1)
  ]), 7), /不能用空态替代失败请求/)
})
