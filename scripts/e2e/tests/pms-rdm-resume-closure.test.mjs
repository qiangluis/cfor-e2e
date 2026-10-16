import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  verifyRdmBlockedResumeNegatives, RDM_ASSERTION_BINDINGS,
  initializeRdmAssertions, finalizeRdmAssertions
} from '../fixtures/rdm.mjs'

const originalFetch = globalThis.fetch
const originalWriteFlag = process.env.CFOR_E2E_WRITE_FIXTURES
before(() => {
  globalThis.fetch = () => { throw new Error('Unit tests must not access a real API') }
  process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
})
after(() => {
  globalThis.fetch = originalFetch
  if (originalWriteFlag === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
  else process.env.CFOR_E2E_WRITE_FIXTURES = originalWriteFlag
})

const record = () => ({ checks: [], notes: [], evidence: [] })
const clone = (value) => structuredClone(value)
const rejection = () => ({ code: 1055006016, data: null, msg: '项目任务阻塞必须填写解除条件' })
const taskKeys = [
  'id', 'projectId', 'ownerId', 'taskName', 'taskContent', 'status', 'blockReason',
  'blockParty', 'releaseCondition', 'actualStartTime', 'actualEndTime', 'completedTime', 'updateTime'
]

function harness (conditions = [null, '', ' \t\r\n']) {
  const caseRecord = record()
  const calls = []
  const expectedPaths = new Set()
  const samples = conditions.map((releaseCondition, index) => {
    const tag = `E2E-RDM-RDM002-1792000000000-unit${index}`
    return {
      id: `21090000000000000${index}1`, projectId: `21090000000000000${index}2`,
      handoverId: `21090000000000000${index}3`, ownerId: '1', projectManagerId: '1',
      tenantId: '1', taskName: `${tag}-task`, taskContent: tag, status: 'BLOCKED',
      blockReason: `${tag}-blocked`, blockParty: tag, releaseCondition,
      actualStartTime: index % 2 ? '2026-10-15 09:00:00' : null,
      actualEndTime: null, completedTime: null, updateTime: '2026-10-15 09:01:00',
      projectName: `规则生成-${tag}-PM`, projectStatus: 'PREPARATION', customerNameSnapshot: tag,
      handoverProjectId: `21090000000000000${index}2`, handoverProjectName: `${tag}-PM`,
      sourceType: 'MANUAL', sourceBusinessNo: tag
    }
  })
  const tasks = samples.map((row) => Object.fromEntries(taskKeys.map((key) => [key, clone(row[key])])))
  const projects = samples.map((row) => ({
    id: row.projectId, projectName: row.projectName, projectManagerId: row.projectManagerId,
    handoverId: row.handoverId, status: row.projectStatus, customerNameSnapshot: row.customerNameSnapshot
  }))
  const h = {
    caseRecord, calls, samples, tasks, projects, expectedPaths, requests: [],
    profileId: '1', reply: rejection(), mutate: () => {}, sqlResult: undefined
  }
  h.api = {
    async getBusiness (path) {
      calls.push(path)
      if (path === '/system/user/profile/get') return { code: 0, data: { id: h.profileId } }
      const url = new URL(path, 'http://unit.invalid')
      const id = url.searchParams.get('id')
      const rows = url.pathname === '/pm/task/get' ? tasks : projects
      const row = rows.find((value) => value.id === id)
      assert.ok(row, `Unexpected GET ${path}`)
      if (h.getError && h.requests.length) throw h.getError
      return { code: 0, data: clone(row) }
    },
    async request (method, path, body, options) {
      calls.push(path)
      assert.equal(method, 'PUT')
      assert.match(path, /^\/pm\/task\/resume\?id=\d+$/)
      assert.equal(body, undefined)
      assert.deepEqual(options, {
        expectedBusinessRejection: { code: 1055006016, message: '项目任务阻塞必须填写解除条件' }
      })
      h.requests.push({ method, path, body, options })
      h.mutate()
      if (h.requestError) throw h.requestError
      return clone(h.reply)
    }
  }
  h.readSql = async (sql) => {
    calls.push(sql)
    assert.match(sql.trim(), /^SELECT JSON_OBJECT\(/)
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|REPLACE)\b/i)
    assert.match(sql, /t\.tenant_id=1 AND t\.deleted=0 AND t\.owner_id=1/)
    assert.match(sql, /p\.tenant_id=1 AND p\.deleted=0/)
    assert.match(sql, /h\.tenant_id=1 AND h\.deleted=0/)
    assert.match(sql, /h\.project_id=p\.id/)
    assert.match(sql, /JSON_EXTRACT\(h\.source_snapshot_json,'\$\.sourceBusinessNo'\)/)
    assert.doesNotMatch(sql, /h\.source_business_no/)
    if (h.sqlError && h.requests.length) throw h.sqlError
    if (h.sqlResult) return clone(h.sqlResult)
    const id = sql.match(/AND t\.id=(\d+)/)?.[1]
    const rows = id ? samples.filter((row) => row.id === id) : samples
    return { available: true, rows: rows.map((row) => [JSON.stringify(row)]) }
  }
  h.run = (options = {}) => verifyRdmBlockedResumeNegatives({
    api: h.api, fixture: { ownerId: '1' }, caseRecord, expectedPaths,
    readSql: h.readSql, writeSafety: async () => { calls.push('safety') }, ...options
  })
  return h
}

test('three stored BLOCKED condition variants require exact rejection and complete unchanged API/SQL receipts', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(result.complete, true)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.samples.map((row) => row.kind), ['null', 'empty', 'blank'])
  assert.deepEqual(result.samples.map((row) => row.before.task.releaseCondition), [null, '', ' \t\r\n'])
  assert.ok(result.samples.every((row) => row.rejected && row.apiUnchanged && row.sqlUnchanged))
  assert.ok(result.samples.every((row) => JSON.stringify(row.before) === JSON.stringify(row.after)))
  assert.equal(h.requests.length, 3)
  assert.equal(h.caseRecord.checks.length, 6)
  assert.ok(h.caseRecord.checks.every((row) => row.passed))
  assert.equal(h.caseRecord.database.length, 7)
  assert.deepEqual([...h.expectedPaths], ['/pm/task/resume'])
  assert.deepEqual(h.calls.slice(0, 2), ['safety', '/system/user/profile/get'])
  assert.equal(new Set(h.requests.map((row) => row.path)).size, 3)
})

for (const whitespace of [' ', '\t\r\n', '\u2003', '\u001c', '\u3000']) {
  test(`Java isBlank whitespace ${JSON.stringify(whitespace)} is preserved verbatim in API and SQL`, async () => {
    const h = harness([whitespace])
    const result = await h.run()
    assert.equal(result.complete, false)
    assert.deepEqual(result.missing, ['null', 'empty'])
    assert.equal(result.samples[0].kind, 'blank')
    assert.equal(result.samples[0].before.sql.releaseCondition, whitespace)
    assert.equal(result.samples[0].after.task.releaseCondition, whitespace)
    assert.equal(h.requests.length, 1)
  })
}

for (const value of [undefined, 'condition', '\u00a0', '\u2007', '\u202f', '\ufeff', '\u200b']) {
  test(`non-Java-blank or missing stored condition ${JSON.stringify(value)} is never probed`, async () => {
    const h = harness([value])
    const result = await h.run()
    assert.equal(result.complete, false)
    assert.deepEqual(result.missing, ['null', 'empty', 'blank'])
    assert.equal(h.requests.length, 0)
    assert.equal(h.caseRecord.checks.length, 0)
    assert.equal(h.expectedPaths.size, 0)
  })
}

test('absent and incomplete historical samples remain explicit GAP without database mutation', async () => {
  for (const values of [[], [null], [null, '']]) {
    const h = harness(values)
    const result = await h.run()
    assert.equal(result.complete, false)
    assert.equal(h.requests.length, values.length)
    assert.match(h.caseRecord.notes.join(' '), /缺少合法专属历史 BLOCKED 样本/)
    assert.match(h.caseRecord.notes.join(' '), /未 SQL 造数/)
    assert.equal(result.samples.length + result.missing.length, 3)
  }
})

for (const [field, value] of [
  ['tenantId', '2'], ['ownerId', '2'], ['projectManagerId', '2'],
  ['taskContent', 'shared'], ['taskName', 'another-task'], ['projectName', ''],
  ['customerNameSnapshot', 'shared'], ['handoverProjectName', 'another-project'], ['handoverProjectId', '9'],
  ['sourceType', 'CRM'], ['sourceBusinessNo', 'another-handover'],
  ['status', 'IN_PROGRESS'], ['projectStatus', 'CLOSED'], ['projectStatus', 'TERMINATED'],
  ['id', '1 OR 1=1'], ['projectId', 'not-an-id'], ['handoverId', ''],
  ['updateTime', undefined], ['actualStartTime', undefined]
]) {
  test(`unowned, immutable or malformed SQL sample (${field}) stops with zero PUT`, async () => {
    const h = harness([null])
    h.samples[0][field] = value
    await assert.rejects(h.run(), /^Error: BLOCKED:/)
    assert.equal(h.requests.length, 0)
    assert.equal(h.expectedPaths.size, 0)
  })
}

for (const field of ['ownerId', 'taskName', 'taskContent', 'status', 'blockReason', 'blockParty', 'releaseCondition']) {
  test(`API/SQL disagreement for ${field} stops before resume`, async () => {
    const h = harness([null])
    h.tasks[0][field] = 'different'
    await assert.rejects(h.run(), /API\/SQL 身份、状态或字段不一致/)
    assert.equal(h.requests.length, 0)
  })
}

test('missing API fields, foreign project or mismatched actual login cannot reach PUT', async () => {
  for (const mutate of [
    (h) => { delete h.tasks[0].releaseCondition },
    (h) => { delete h.tasks[0].actualStartTime },
    (h) => { h.projects[0].handoverId = '9' },
    (h) => { h.projects[0].projectManagerId = '2' },
    (h) => { h.projects[0].status = 'CLOSED' },
    (h) => { h.profileId = '2' }
  ]) {
    const h = harness([null])
    mutate(h)
    await assert.rejects(h.run(), /^Error: BLOCKED:/)
    assert.equal(h.requests.length, 0)
  }
})

for (const reply of [
  { code: 0, data: true }, { code: 400, msg: '请求参数不正确:must not be blank' },
  { code: 1055006002, msg: '项目任务状态不允许当前操作：BLOCKED' },
  { code: 1055006016, msg: '项目任务阻塞必须填写解除条件-extra' },
  { code: '1055006016', msg: '项目任务阻塞必须填写解除条件' },
  { code: 1055006016, data: rejection(), msg: 'wrong' },
  { ...rejection(), success: true }, { ...rejection(), ok: true },
  { code: 403, msg: '无权限' }, { code: 500, msg: '系统异常' }
]) {
  test(`non-exact resume response ${JSON.stringify(reply)} fails but still captures after API/SQL`, async () => {
    const h = harness([null])
    h.reply = reply
    await assert.rejects(h.run(), /恢复未精确拒绝/)
    assert.equal(h.caseRecord.checks[0].passed, false)
    assert.equal(h.caseRecord.checks[1].passed, true)
    const receipt = h.caseRecord.rdm002ResumeNegatives.samples[0]
    assert.ok(receipt.after)
    assert.equal(receipt.apiUnchanged, true)
    assert.equal(receipt.sqlUnchanged, true)
    assert.equal(h.expectedPaths.size, 0)
  })
}

test('transport errors are rethrown after API/SQL readback and never become expected rejections', async () => {
  const h = harness([null])
  h.requestError = new Error('HTTP 503 upstream unavailable')
  await assert.rejects(h.run(), (error) => error === h.requestError)
  assert.equal(h.caseRecord.checks[0].passed, false)
  assert.equal(h.caseRecord.checks[1].passed, true)
  assert.ok(h.caseRecord.rdm002ResumeNegatives.samples[0].after)
  assert.equal(h.expectedPaths.size, 0)
})

for (const field of ['status', 'blockReason', 'blockParty', 'releaseCondition', 'actualStartTime', 'updateTime']) {
  for (const side of ['API', 'SQL']) {
    test(`${side} ${field} drift after exact rejection fails unchanged evidence`, async () => {
      const h = harness([null])
      h.mutate = () => { (side === 'API' ? h.tasks : h.samples)[0][field] = 'changed' }
      await assert.rejects(h.run(), /API\/SQL 发生变化/)
      assert.equal(h.caseRecord.checks[0].passed, true)
      assert.equal(h.caseRecord.checks[1].passed, false)
      const receipt = h.caseRecord.rdm002ResumeNegatives.samples[0]
      assert.ok(receipt.after)
      assert.equal(receipt[side === 'API' ? 'apiUnchanged' : 'sqlUnchanged'], false)
      assert.equal(h.expectedPaths.size, 0)
    })
  }
}

test('unexpected successful resume that changes BLOCKED state records both exact rejection and invariant failures', async () => {
  const h = harness([null])
  h.reply = { code: 0, data: true }
  h.mutate = () => {
    Object.assign(h.tasks[0], { status: 'PENDING_EXECUTION', releaseCondition: '' })
    Object.assign(h.samples[0], { status: 'PENDING_EXECUTION', releaseCondition: '' })
  }
  await assert.rejects(h.run(), /API\/SQL 发生变化/)
  assert.ok(h.caseRecord.checks.every((check) => check.passed === false))
  assert.equal(h.caseRecord.rdm002ResumeNegatives.samples[0].after.sql.status, 'PENDING_EXECUTION')
})

test('SQL unavailable, malformed and duplicate samples cannot prove invariance or reach a PUT', async () => {
  for (const sqlResult of [
    { available: false, reason: 'database unavailable', rows: [] },
    { available: true, rows: [['not-json']] },
    { available: true, rows: [['{}', 'extra-cell']] },
    { available: true, rows: undefined }
  ]) {
    const h = harness()
    h.sqlResult = sqlResult
    await assert.rejects(h.run())
    assert.equal(h.requests.length, 0)
  }
  const h = harness([null])
  h.samples.push(clone(h.samples[0]))
  await assert.rejects(h.run(), /回读不唯一/)
  assert.equal(h.requests.length, 0)
})

test('after-read failures cannot complete evidence even when business rejection is exact', async () => {
  for (const key of ['getError', 'sqlError']) {
    const h = harness([null])
    h[key] = new Error(`after ${key} unavailable`)
    await assert.rejects(h.run(), (error) => error === h[key])
    assert.equal(h.caseRecord.checks[0].passed, true)
    assert.equal(h.caseRecord.checks[1].passed, false)
    assert.equal(h.caseRecord.rdm002ResumeNegatives.complete, false)
    assert.equal(h.expectedPaths.size, 0)
  }
})

test('explicit opt-in and local safety gates run before business operations', async () => {
  const h = harness()
  delete process.env.CFOR_E2E_WRITE_FIXTURES
  try {
    await assert.rejects(h.run(), /CFOR_E2E_WRITE_FIXTURES=true/)
    assert.equal(h.calls.length, 0)
  } finally {
    process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  }
  await assert.rejects(h.run({ writeSafety: async () => { throw new Error('BLOCKED: unsafe DB') } }), /unsafe DB/)
  assert.equal(h.calls.length, 0)
})

const addOtherChecks = (caseRecord) => {
  for (const name of new Set(RDM_ASSERTION_BINDINGS['RDM-002'].flatMap(([, names]) => names))) {
    if (!name.startsWith('RDM002 ')) caseRecord.checks.push({ name, passed: true })
  }
}

test('only three current exact-negative receipts plus all original checks can complete RDM002 mapping', async () => {
  const h = harness()
  initializeRdmAssertions(h.caseRecord, 'RDM-002')
  addOtherChecks(h.caseRecord)
  await h.run()
  const result = finalizeRdmAssertions(h.caseRecord, 'RDM-002')
  assert.equal(result.partial, false)
  assert.equal(result.acceptanceComplete, true)
  assert.ok(h.caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'))
  assert.equal(finalizeRdmAssertions(h.caseRecord, 'RDM-002', { readOnly: true }).partial, true)
})

test('partial samples, check names alone, stale receipts and a failed exact check never complete the catalog', async () => {
  const h = harness([null, ''])
  initializeRdmAssertions(h.caseRecord, 'RDM-002')
  addOtherChecks(h.caseRecord)
  await h.run()
  assert.equal(finalizeRdmAssertions(h.caseRecord, 'RDM-002').partial, true)

  const complete = harness()
  initializeRdmAssertions(complete.caseRecord, 'RDM-002')
  addOtherChecks(complete.caseRecord)
  await complete.run()
  const failed = complete.caseRecord.checks.find((check) => check.name.startsWith('RDM002 BLOCKED'))
  failed.passed = false
  assert.equal(finalizeRdmAssertions(complete.caseRecord, 'RDM-002').partial, true)
  failed.passed = true
  const evidence = complete.caseRecord.rdm002ResumeNegatives
  delete complete.caseRecord.rdm002ResumeNegatives
  assert.equal(finalizeRdmAssertions(complete.caseRecord, 'RDM-002').partial, true)
  complete.caseRecord.rdm002ResumeNegatives = evidence
  initializeRdmAssertions(complete.caseRecord, 'RDM-002')
  assert.equal(complete.caseRecord.rdm002ResumeNegatives, undefined)
  assert.equal(finalizeRdmAssertions(complete.caseRecord, 'RDM-002').partial, true)
})

test('production fixture uses only scoped read-only SQL, real id-only resume, and no stale JVM assertion', () => {
  const source = fs.readFileSync(new URL('../fixtures/rdm.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:INSERT INTO|UPDATE pm_project_task|runLocalFixtureSql|r33 JVM)\b/i)
  assert.match(source, /await verifyRdmBlockedResumeNegatives\(\{ api, fixture, caseRecord, expectedPaths \}\)/)
  assert.match(source, /expectedCode: 1055006002/)
  assert.match(source, /expectedBusinessRejection: \{ code: 1055006016, message: '项目任务阻塞必须填写解除条件' \}/)
})
