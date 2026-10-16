import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { runCase, catalogAssertions } from '../suites/mes-prod-task-report.mjs'

const ok = (data) => ({ code: 0, data })
function harness (options = {}) {
  const calls = []
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const task = { id: '102', workTicketId: '101', reportVersion: 0 }
  const work = { id: '101', status: 1, remark: 'AUTOTEST-UNIT' }
  class Fixture {
    constructor (_api, _record, _caseId, settings) {
      assert.equal(settings.withOpeningInventory, true)
      this.works = [work]
      this.tasks = [task]
      this.marker = work.remark
    }

    async setup () { calls.push('setup') }
    async cleanup () { calls.push('cleanup') }
    async startWork () { work.status = 2; return { ...work } }
    async pauseWork (reason, time) {
      Object.assign(work, { status: 3, pauseReason: reason, expectResumeTime: time })
      return { ...work }
    }

    async resumeWork () {
      Object.assign(work, { status: 2, resumeTime: '2026-10-15 01:00:00' })
      return { ...work }
    }
  }
  return {
    calls, caseRecord,
    run: (caseId = 'MES-TASK-REPORT-001') => runCase({
      caseId, caseRecord, page: {}, record: {}, outputDir: '/unused'
    }, {
      ExecutionWorkflowFixture: Fixture,
      login: async () => 'unit',
      createApiClient: () => ({
        async getBusiness (path) {
          if (path.startsWith('/mes/prodWork/queryById')) return ok({ ...work })
          assert.equal(path, '/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=101')
          calls.push('owned-page')
          if (options.malformed) return { code: 500, data: { records: [] } }
          return ok({ records: options.rows ?? [task], total: options.rows?.length ?? 1 })
        },
        async request (_method, _path, body) {
          return options.rejection || { code: 400, msg: body.pauseReason ? '预计恢复时间不能为空' : '暂停原因不能为空' }
        }
      }),
      databaseConfigured: () => options.database !== false,
      sql: async (sql) => ({
        available: true,
        rows: sql.includes('information_schema.COLUMNS')
          ? [['report_version', 'NO', options.defaultValue ?? '0']]
          : options.noIndex ? [] : [['idx_mes_work_report_process_worker_time']]
      }),
      openRoute: async () => {}, saveScreenshot: async () => {}
    })
  }
}

test('task report mapping strings exactly match unchanged catalog order', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url)))
  for (const [caseId, assertions] of Object.entries(catalogAssertions)) {
    assert.deepEqual(assertions, catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === caseId).assertions)
  }
})

test('001 requires an owned nonempty task page, exact database default zero, and real index', async () => {
  const h = harness()
  assert.equal((await h.run()).partial, false)
  assert.deepEqual(h.calls, ['setup', 'owned-page', 'cleanup'])
  assert.deepEqual(h.caseRecord.catalogAssertions.map((row) => [row.index, row.status]), [
    [0, 'VERIFIED'], [1, 'VERIFIED'], [2, 'VERIFIED']
  ])
  assert.deepEqual(h.caseRecord.remainingAssertions, [])
})

test('001 empty, foreign task or invalid version is failed evidence instead of vacuous PASS', async () => {
  for (const rows of [
    [], [{ id: '102', workTicketId: 'other', reportVersion: 0 }],
    [{ id: '102', workTicketId: '101', reportVersion: -1 }],
    [{ id: '102', workTicketId: '101', reportVersion: '0' }]
  ]) {
    const h = harness({ rows })
    assert.equal((await h.run()).partial, true)
    assert.equal(h.caseRecord.catalogAssertions[0].status, 'FAILED')
    assert.equal(h.calls.at(-1), 'cleanup')
  }
})

test('001 malformed pages throw and retain unmapped originals while cleanup still runs', async () => {
  const h = harness({ malformed: true })
  await assert.rejects(h.run, /分页响应无效/)
  assert.equal(h.calls.at(-1), 'cleanup')
  assert.equal(h.caseRecord.catalogAssertions[0].status, 'GAP')
})

test('001 nonzero/null default, absent index and unavailable DB cannot verify schema originals', async () => {
  for (const [options, index, expected] of [
    [{ defaultValue: '1' }, 1, 'FAILED'], [{ defaultValue: 'NULL' }, 1, 'FAILED'],
    [{ noIndex: true }, 2, 'FAILED'], [{ database: false }, 1, 'GAP']
  ]) {
    const h = harness(options)
    assert.equal((await h.run()).partial, true)
    assert.equal(h.caseRecord.catalogAssertions[index].status, expected)
    assert.ok(h.caseRecord.remainingAssertions.includes(catalogAssertions['MES-TASK-REPORT-001'][index]))
  }
})

test('002 maps only successful mandatory-field rejection and real paused readback checks', async () => {
  const good = harness()
  assert.equal((await good.run('MES-TASK-REPORT-002')).partial, false)
  assert.ok(good.caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'))
  const bad = harness({ rejection: { code: 500, msg: '系统错误' } })
  assert.equal((await bad.run('MES-TASK-REPORT-002')).partial, true)
  assert.deepEqual(bad.caseRecord.catalogAssertions.map((row) => row.status), ['FAILED', 'FAILED', 'VERIFIED'])
})
