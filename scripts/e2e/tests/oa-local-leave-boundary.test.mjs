import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OA_LOCAL_ASSERTIONS, OA_LOCAL_CHECKS, OA_LOCAL_EVIDENCE, OA_LOCAL_REJECTIONS,
  oaLocalLeaveForgery, preflightOaLocalLeaveForgery, readOaLocalLeaveBoundary,
  verifyOaLocalLeaveBoundary, submitOaLocalLeave, expectOaLocalRejection
} from '../fixtures/oa-local-closure.mjs'
import { closureData, finalizeLocalAssertions } from '../fixtures/hrm-local-closure.mjs'

const marker = 'E2E-OA001-123456789ABC'
const employeeId = '2110674491764727809'
const otherEmployeeId = '2110674491764727810'
const ownerUserId = '13'
const otherUserId = '23'
const leaveId = '2110674491764727811'
const processId = 'hrm-leave-process-1'
const definitionId = 'hrm-leave-approval:1:definition-1'
const recordOf = () => ({ checks: [], notes: [], evidence: [] })
const ok = (data) => ({ code: 0, data })

// All writes below modify only this in-memory model. No API client or DB process is created.
const scenario = (options = {}) => {
  const caseRecord = recordOf()
  const calls = { writes: [], reads: [] }
  let phase = 'preflight'
  const fact = () => ({
    id: leaveId, employeeId, reason: `${marker}-CANCEL`, remark: `${marker}-CANCEL`,
    processInstanceId: processId, approvalStatus: phase === 'cancel' ? 4 : 1,
    approvalTime: phase === 'cancel' ? '2026-10-15T17:00:00' : null,
    approvalReason: phase === 'cancel' ? `${marker} 本人取消` : null,
    ...(options.fact?.(phase) || {})
  })
  const process = () => ({
    id: processId, businessKey: leaveId, startUser: { id: ownerUserId },
    processDefinitionId: definitionId, status: phase === 'cancel' ? 4 : 1,
    endTime: phase === 'cancel' ? '2026-10-15T17:00:00' : null,
    ...(options.process?.(phase) || {})
  })
  const preflightRows = [
    ['actor', employeeId, ownerUserId, marker],
    ['actor', otherEmployeeId, otherUserId, `${marker}-OTHER`],
    ['marked-leaves', '0'], ['fake-history', '0'], ['fake-runtime', '0'], ['fake-leaves', '0']
  ]
  const read = async (sql) => {
    calls.reads.push(sql)
    assert.match(sql, /tenant_id=1/)
    if (sql.includes("SELECT 'actor'")) {
      assert.match(sql, /JOIN system_users/)
      return { available: true, rows: options.preflightRows?.(structuredClone(preflightRows)) || structuredClone(preflightRows) }
    }
    assert.match(sql, /h\.TENANT_ID_='1'/)
    assert.match(sql, /v\.NAME_='PROCESS_STATUS' AND v\.TASK_ID_ IS NULL/)
    assert.match(sql, /v\.EXECUTION_ID_=h\.PROC_INST_ID_/)
    assert.match(sql, /ACT_RU_EXECUTION/)
    assert.match(sql, /l\.id=2110674491764727811/)
    const cancelled = phase === 'cancel'
    const rows = [
      ['link', leaveId, employeeId, ownerUserId, cancelled ? '4' : '1',
        processId, leaveId, definitionId, ownerUserId,
        cancelled ? '1' : '0', cancelled ? '1' : '0', cancelled ? '0' : '2',
        cancelled ? '0' : '3', cancelled ? '4' : '1', cancelled ? '1' : '0', '0', '0'],
      ['marked-leaves', '1'], ['business-processes', '1'],
      ['fake-history', '0'], ['fake-runtime', '0'], ['fake-leaves', '0']
    ]
    return { available: true, rows: options.rows?.(rows, phase) || rows }
  }
  const api = { getBusiness: async (path) => {
    assert.equal(path, `/hrm/attendance/leave/get?id=${leaveId}`)
    return ok(fact())
  } }
  const ownerApi = {
    post: async (path, body) => {
      assert.equal(path, '/hrm/portal/attendance/leave/create')
      calls.writes.push({ method: 'POST', path, body: structuredClone(body) })
      if (options.createError) throw options.createError
      phase = 'create'
      return options.createResponse || ok(leaveId)
    },
    putBusiness: async (path, body) => {
      assert.equal(path, '/hrm/portal/attendance/leave/cancel')
      calls.writes.push({ method: 'PUT', path, body: structuredClone(body) })
      if (options.cancelError) throw options.cancelError
      phase = 'cancel'
      return ok(true)
    },
    getBusiness: async (path) => {
      assert.equal(path, `/bpm/process-instance/get?id=${fact().processInstanceId}`)
      return ok(process())
    }
  }
  const outsiderApi = {
    request: async (method, path, body, flags) => {
      assert.equal(method, 'PUT')
      assert.equal(path, '/hrm/portal/attendance/leave/cancel')
      assert.deepEqual(flags.expectedBusinessRejection, OA_LOCAL_REJECTIONS.otherLeave)
      calls.writes.push({ method, path, body: structuredClone(body), actor: 'outsider' })
      if (options.outsiderError) throw options.outsiderError
      if (options.outsiderMutates) phase = 'cancel'
      return options.outsiderResponse || { code: 2041300030, msg: '请假申请不存在', data: null }
    }
  }
  const args = { marker, employeeId, ownerUserId, otherEmployeeId, otherUserId, caseRecord, read }
  return { args, api, ownerApi, outsiderApi, calls, caseRecord }
}

const create = async (env) => {
  const probe = await preflightOaLocalLeaveForgery(env.args)
  const body = {
    type: '事假', startTime: '2026-10-18T09:00:00', endTime: '2026-10-18T10:00:00',
    day: 0.13, reason: probe.reason, remark: probe.reason, ...probe.forged
  }
  const id = await submitOaLocalLeave({ ownerApi: env.ownerApi, body, caseRecord: env.caseRecord })
  const state = await verifyOaLocalLeaveBoundary({
    stage: 'create', body, probe, leaveId: id, api: env.api, ownerApi: env.ownerApi,
    caseRecord: env.caseRecord, read: env.args.read
  })
  return { probe, body, state }
}

const otherCancel = (env, probe) => expectOaLocalRejection({
  api: env.outsiderApi, method: 'PUT', path: '/hrm/portal/attendance/leave/cancel',
  body: { id: leaveId, reason: marker, ...oaLocalLeaveForgery({ marker, employeeId, userId: ownerUserId }) },
  contract: OA_LOCAL_REJECTIONS.otherLeave, record: env.caseRecord, name: OA_LOCAL_CHECKS.forgedOtherCancel,
  snapshot: () => readOaLocalLeaveBoundary({
    api: env.api, ownerApi: env.ownerApi, leaveId, probe,
    stage: 'outsider-cancel', caseRecord: env.caseRecord, read: env.args.read
  })
})

const cancel = async (env, probe) => {
  const body = { id: leaveId, reason: `${marker} 本人取消`, ...probe.forged }
  assert.equal(closureData(await env.ownerApi.putBusiness('/hrm/portal/attendance/leave/cancel', body)), true)
  return verifyOaLocalLeaveBoundary({
    stage: 'cancel', body, probe, leaveId, api: env.api, ownerApi: env.ownerApi,
    caseRecord: env.caseRecord, read: env.args.read
  })
}

const verified = (record) => finalizeLocalAssertions(record, OA_LOCAL_ASSERTIONS, OA_LOCAL_EVIDENCE)
  .catalogAssertions[1].status === 'VERIFIED'

test('OA known public create/cancel mass assignment probes map assertion #1 only with all three proofs', async () => {
  const env = scenario()
  const { probe } = await create(env)
  assert.equal(verified(env.caseRecord), false)
  await otherCancel(env, probe)
  assert.equal(verified(env.caseRecord), false)
  await cancel(env, probe)
  assert.equal(verified(env.caseRecord), true)
  assert.deepEqual(env.calls.writes.map((row) => [row.method, row.path]), [
    ['POST', '/hrm/portal/attendance/leave/create'],
    ['PUT', '/hrm/portal/attendance/leave/cancel'],
    ['PUT', '/hrm/portal/attendance/leave/cancel']
  ])
  assert.equal(env.calls.writes[0].body.employeeId, otherEmployeeId)
  assert.equal(env.calls.writes[0].body.approvalStatus, 2)
  assert.equal(env.calls.writes[1].body.employeeId, employeeId)
  assert.equal(env.calls.writes[1].body.userId, ownerUserId)
  assert.equal(env.calls.writes[2].body.processInstanceId, `${marker}-FORGED-PROCESS`)
  assert.ok(env.caseRecord.database.every((row) => row.available === true))
})

test('OA preflight requires exact same-run synthetic actor bindings and no existing marker or fake process', async () => {
  const mutations = [
    (rows) => rows.filter((row) => row[0] !== 'actor'),
    (rows) => { rows[0][3] = 'shared'; return rows },
    (rows) => { rows[1][2] = ownerUserId; return rows },
    ...['marked-leaves', 'fake-history', 'fake-runtime', 'fake-leaves'].map((tag) =>
      (rows) => { rows.find((row) => row[0] === tag)[1] = '1'; return rows })
  ]
  for (const preflightRows of mutations) {
    const env = scenario({ preflightRows })
    await assert.rejects(create(env))
    assert.equal(env.calls.writes.length, 0)
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA malformed, lossy, repeated or non-owned identities fail before any probe SQL or write', async () => {
  for (const changed of [
    { marker: 'shared' }, { employeeId: 2 ** 54 }, { employeeId: '14 OR 1=1' },
    { otherEmployeeId: employeeId }, { otherUserId: ownerUserId }
  ]) {
    const env = scenario()
    await assert.rejects(preflightOaLocalLeaveForgery({ ...env.args, ...changed }))
    assert.equal(env.calls.reads.length, 0)
    assert.equal(env.calls.writes.length, 0)
  }
})

test('OA create cannot accept forged terminal state, employee, process or approval fields', async () => {
  for (const changed of [
    { approvalStatus: 2 }, { employeeId: otherEmployeeId },
    { processInstanceId: `${marker}-FORGED-PROCESS` },
    { approvalTime: '2000-01-01T00:00:00' }, { approvalReason: `${marker}-FORGED-APPROVE` }
  ]) {
    const env = scenario({ fact: () => changed })
    await assert.rejects(create(env))
    assert.equal(verified(env.caseRecord), false)
    assert.equal(env.caseRecord.checks.some((row) => row.name === OA_LOCAL_CHECKS.forgedCreate && row.passed), false)
  }
})

test('OA create needs matching BPM initiator, business key, definition and RUNNING status', async () => {
  for (const changed of [
    { startUser: { id: otherUserId } }, { businessKey: '99' }, { status: 2 },
    { processDefinitionId: 'oa-leave-approval:1:wrong' },
    { endTime: '2026-10-15T17:00:00' }, { id: `${marker}-FORGED-PROCESS` }
  ]) {
    const env = scenario({ process: () => changed })
    await assert.rejects(create(env))
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA missing, duplicate or malformed SQL evidence never proves either public write boundary', async () => {
  for (const rows of [
    () => [],
    (rows) => rows.filter((row) => row[0] !== 'link'),
    (rows) => [rows[0], ...rows],
    (rows) => { rows[0].pop(); return rows },
    ...['marked-leaves', 'business-processes', 'fake-history', 'fake-runtime', 'fake-leaves'].map((tag) =>
      (rows) => rows.filter((row) => row[0] !== tag)),
    (rows) => { rows.find((row) => row[0] === 'marked-leaves')[1] = 'invalid'; return rows }
  ]) {
    const env = scenario({ rows })
    await assert.rejects(create(env))
    assert.equal(verified(env.caseRecord), false)
  }
  const env = scenario()
  env.args.read = async () => ({ available: false, rows: [] })
  await assert.rejects(create(env), /只读数据库证据/)
  assert.equal(env.calls.writes.length, 0)
})

test('OA SQL must independently corroborate actual identities, business key and server RUNNING state', async () => {
  for (const [index, value] of [
    [1, '99'], [2, otherEmployeeId], [3, otherUserId], [4, '2'], [5, `${marker}-FORGED-PROCESS`],
    [6, '99'], [7, 'foreign:1:definition'], [8, otherUserId], [9, '1'], [10, '1'],
    [11, '0'], [12, '0'], [13, '2'], [14, '1'], [15, '1'], [16, '1']
  ]) {
    const env = scenario({ rows: (rows) => { rows[0][index] = value; return rows } })
    await assert.rejects(create(env))
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA one exact new marker fact and one real BPM are mandatory; fake history or runtime is forbidden', async () => {
  for (const [tag, count] of [
    ['marked-leaves', '0'], ['marked-leaves', '2'], ['business-processes', '0'], ['business-processes', '2'],
    ['fake-history', '1'], ['fake-runtime', '1'], ['fake-leaves', '1']
  ]) {
    const env = scenario({ rows: (rows) => { rows.find((row) => row[0] === tag)[1] = count; return rows } })
    await assert.rejects(create(env))
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA a stripped/changed probe request or absent preflight SQL cannot produce a passing check', async () => {
  for (const changed of [
    (probe, body) => { delete body.approvalStatus },
    (probe, body) => { body.employeeId = employeeId },
    (probe) => { probe.preflight = [] },
    (probe) => { probe.reason = 'shared' },
    (probe) => { probe.forged.processInstanceId = "fake' OR 1=1" }
  ]) {
    const env = scenario()
    const probe = await preflightOaLocalLeaveForgery(env.args)
    const body = { ...probe.forged, reason: probe.reason, remark: probe.reason }
    changed(probe, body)
    await assert.rejects(verifyOaLocalLeaveBoundary({
      stage: 'create', probe, body, leaveId, api: env.api, ownerApi: env.ownerApi,
      caseRecord: env.caseRecord, read: env.args.read
    }))
    assert.equal(env.caseRecord.checks.length, 0)
    assert.equal(env.calls.reads.length, 1)
  }
})

test('OA outsider forged owner fields cannot mask mutation, missing SQL, HTTP errors or unrelated refusal', async () => {
  for (const options of [
    { outsiderMutates: true },
    { outsiderResponse: ok(true) },
    { outsiderResponse: { code: 403, msg: '没有该操作权限' } },
    { outsiderResponse: { code: 2041300030, msg: 'wrong reason' } },
    { outsiderResponse: { code: 2041300030, msg: '请假申请不存在', data: true } },
    { outsiderError: new Error('HTTP 404') }
  ]) {
    const env = scenario(options)
    const { probe } = await create(env)
    await assert.rejects(otherCancel(env, probe))
    assert.equal(verified(env.caseRecord), false)
    assert.equal(env.caseRecord.checks.some((row) => row.name === OA_LOCAL_CHECKS.forgedOtherCancel && row.passed), false)
  }
  const env = scenario()
  const { probe } = await create(env)
  env.args.read = async () => ({ available: true, rows: [] })
  await assert.rejects(otherCancel(env, probe), /SQL/)
  assert.equal(env.calls.writes.length, 1)
})

test('OA owner cancel must produce CANCEL on the same actual HRM/BPM, never APPROVE or a fake process', async () => {
  for (const options of [
    { fact: (phase) => phase === 'cancel' ? { approvalStatus: 2 } : {} },
    { fact: (phase) => phase === 'cancel' ? { employeeId: otherEmployeeId } : {} },
    { fact: (phase) => phase === 'cancel' ? { processInstanceId: `${marker}-FORGED-PROCESS` } : {} },
    { fact: (phase) => phase === 'cancel' ? { approvalTime: null } : {} },
    { fact: (phase) => phase === 'cancel' ? { approvalTime: '2000-01-01T00:00:00' } : {} },
    { fact: (phase) => phase === 'cancel' ? { approvalReason: `${marker}-FORGED-APPROVE` } : {} },
    { process: (phase) => phase === 'cancel' ? { status: 2 } : {} },
    { process: (phase) => phase === 'cancel' ? { id: 'other-real-process' } : {} },
    { process: (phase) => phase === 'cancel' ? { endTime: null } : {} }
  ]) {
    const env = scenario(options)
    const { probe } = await create(env)
    await otherCancel(env, probe)
    await assert.rejects(cancel(env, probe))
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA owner cancel SQL must prove BPM CANCEL, ended history, timestamp and zero active tasks/executions', async () => {
  for (const [index, value] of [
    [4, '2'], [5, `${marker}-FORGED-PROCESS`], [9, '0'], [10, '0'],
    [11, '1'], [12, '1'], [13, '2'], [15, '1'], [16, '1']
  ]) {
    const env = scenario({ rows: (rows, phase) => {
      if (phase === 'cancel') rows[0][index] = value
      return rows
    } })
    const { probe } = await create(env)
    await otherCancel(env, probe)
    await assert.rejects(cancel(env, probe))
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA cancel cannot substitute a different genuine process or definition after create', async () => {
  for (const changed of [
    (probe) => { probe.created.processId = 'different-process' },
    (probe) => { probe.created.definitionId = 'hrm-leave-approval:2:different' },
    (probe) => { delete probe.created }
  ]) {
    const env = scenario()
    const { probe } = await create(env)
    changed(probe)
    await assert.rejects(cancel(env, probe))
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA HTTP 200/404, missing success data and transport errors are not successful create negative evidence', async () => {
  for (const options of [
    { createResponse: { status: 200 } }, { createResponse: { code: 0, data: null } },
    { createResponse: { code: 404, msg: 'not found' } }, { createError: new Error('HTTP 404') },
    { createError: new Error('network timeout') }
  ]) {
    const env = scenario(options)
    await assert.rejects(create(env))
    assert.equal(env.calls.writes.length, 1)
    assert.equal(verified(env.caseRecord), false)
  }
})

test('OA cancel transport failure never retries or fabricates a cancelled boundary check', async () => {
  const env = scenario({ cancelError: new Error('cancel transport timeout') })
  const { probe } = await create(env)
  await assert.rejects(cancel(env, probe), /transport timeout/)
  assert.equal(env.calls.writes.length, 2)
  assert.equal(env.caseRecord.checks.some((row) => row.name === OA_LOCAL_CHECKS.forgedCancel), false)
  assert.equal(verified(env.caseRecord), false)
})
