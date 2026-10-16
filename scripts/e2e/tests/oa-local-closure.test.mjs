import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { OA_LOCAL_ASSERTIONS, OA_LOCAL_REJECTIONS, expectOaLocalRejection,
  runOaLocalClosure, submitOaLocalLeave, cleanupOaLocalBooking,
  oaLocalApproverCredentials, approveOaLocalLeave, OA_LOCAL_CHECKS } from '../fixtures/oa-local-closure.mjs'
import { finalizeLocalAssertions, closureGap, installHrmOaLocalApiBridge,
  createLocalClosureCleanup, createClosureResource } from '../fixtures/hrm-local-closure.mjs'
import { cases, runCase } from '../suites/oa.mjs'
import { launchBrowser, login } from '../lib/browser.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { createRunRecord, createCaseRecord } from '../lib/report.mjs'
import { redact } from '../lib/redact.mjs'

test('OA preserves original assertions; booking evidence cannot replace comments or BPM', () => {
  assert.deepEqual(OA_LOCAL_ASSERTIONS, [
    '提交生成流程', '只能 BPM 回写结论', '审批完成回写状态', '评论和资源预约权限隔离'
  ])
  const record = { checks: [{ name: 'booking', passed: true }] }
  closureGap(record, 3, 'comment scope undecided')
  const result = finalizeLocalAssertions(record, OA_LOCAL_ASSERTIONS, { 3: ['booking'] })
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.catalogAssertions[3].status, 'GAP')
  assert.equal(result.catalogAssertions[2].status, 'GAP')
})

test('OA exclusive suite dispatches only OA-001 and preserves partial evidence', async () => {
  assert.deepEqual(cases, ['OA-001'])
  const result = { partial: true, acceptanceComplete: false }
  assert.equal(await runCase({ caseId: 'OA-001' }, {
    runOaLocalClosure: async (context) => {
      assert.equal(context.caseId, 'OA-001')
      return result
    }
  }), result)
  await assert.rejects(runCase({ caseId: 'HRM-001' }), /Unsupported/)
})

test('OA and HRM rejection contracts use exact code plus exact/anchored message', () => {
  assert.equal(OA_LOCAL_REJECTIONS.owner.code, 1054200011)
  assert.equal(OA_LOCAL_REJECTIONS.roomInUse.code, 1054200003)
  assert.equal(OA_LOCAL_REJECTIONS.overlap.code, 2041300031)
  assert.equal(matchesExpectedBusinessRejection({
    code: 1054200012, msg: '该会议室在 2026-10-18 09:00 至 2026-10-18 10:00 已被占用'
  }, OA_LOCAL_REJECTIONS.conflict), true)
  for (const payload of [
    { code: 0, data: true }, { code: 200, msg: '成功' }, { code: 403, msg: '没有该操作权限' },
    { code: 500, msg: '服务器错误' }, { code: 1054200011, msg: '错误' }
  ]) assert.equal(matchesExpectedBusinessRejection(payload, OA_LOCAL_REJECTIONS.owner), false)
})

test('exact refusal also requires unchanged owned facts and no success data', async () => {
  for (const scenario of [
    { payload: { code: 1054200011, msg: OA_LOCAL_REJECTIONS.owner.message }, changed: false, passed: true },
    { payload: { code: 0, data: true }, changed: false, passed: false },
    { payload: { code: 1054200011, msg: OA_LOCAL_REJECTIONS.owner.message }, changed: true, passed: false },
    { payload: { code: 1054200011, msg: OA_LOCAL_REJECTIONS.owner.message, data: true }, changed: false, passed: false },
    { payload: { code: 1054200011, msg: 'wrong reason' }, changed: false, passed: false }
  ]) {
    const record = { checks: [] }
    let reads = 0
    const promise = expectOaLocalRejection({
      api: { request: async () => scenario.payload }, method: 'PUT', path: '/oa/meeting-booking/update',
      contract: OA_LOCAL_REJECTIONS.owner, record, name: 'owned refusal',
      snapshot: async () => ({ status: scenario.changed && reads++ ? 30 : 20, count: 1 })
    })
    if (scenario.passed) await promise
    else await assert.rejects(promise, /owned refusal/)
    assert.equal(record.checks[0].passed, scenario.passed)
  }
})

test('transport and service failures never become successful negative assertions', async () => {
  const record = { checks: [] }
  await assert.rejects(expectOaLocalRejection({
    api: { request: async () => { throw new Error('HTTP 500') } },
    method: 'POST', path: '/oa/meeting-booking/create', contract: OA_LOCAL_REJECTIONS.conflict,
    snapshot: async () => ({ count: 1 }), record, name: 'conflict'
  }), /HTTP 500/)
  assert.deepEqual(record.checks, [])
})

const missingEmployee = () => ({ code: 2040100000, msg: '员工不存在', data: null })
const selfBinding = () => ({ verified: true, roleDataScope: 5, employeeId: '14',
  userId: '13', roleId: '12', selfResponse: missingEmployee() })
const recordOf = () => ({ checks: [], notes: [], evidence: [] })

test('OA SELF blocker requires exact submit, self-read and independently verified binding evidence', async () => {
  const record = recordOf()
  const result = await submitOaLocalLeave({
    ownerApi: { post: async (path, body) => {
      assert.equal(path, '/hrm/portal/attendance/leave/create')
      assert.deepEqual(body, { reason: 'owned leave' })
      return missingEmployee()
    } },
    body: { reason: 'owned leave' }, binding: selfBinding(), caseRecord: record
  })
  assert.equal(result, null)
  assert.equal(record.leaveSubmissionBlocker.adminBindingVerified, true)
  assert.equal(record.leaveSubmissionBlocker.roleDataScope, 5)
  assert.equal(record.leaveSubmissionBlocker.selfReadCode, 2040100000)
  assert.equal(record.checks.length, 0)
  const resultAssertions = finalizeLocalAssertions(record, OA_LOCAL_ASSERTIONS, {})
  assert.equal(resultAssertions.partial, true)
  assert.ok(resultAssertions.catalogAssertions.every((row) => row.status === 'GAP'))
})

test('OA never swallows unrelated code, missing proof, successful data or scope changes as SELF blocker', async () => {
  for (const changed of [
    { response: { code: 500, msg: '2040100000 server error' } },
    { response: { code: 2040100000, msg: 'other reason' } },
    { response: { ...missingEmployee(), data: true } },
    { binding: { ...selfBinding(), verified: false } },
    { binding: { ...selfBinding(), roleDataScope: 1 } },
    { binding: { ...selfBinding(), selfResponse: { code: 0, data: { id: '14' } } } },
    { binding: { ...selfBinding(), selfResponse: { ...missingEmployee(), data: true } } }
  ]) {
    const record = recordOf()
    await assert.rejects(submitOaLocalLeave({
      ownerApi: { post: async () => changed.response || missingEmployee() },
      body: {}, binding: changed.binding || selfBinding(), caseRecord: record
    }))
    assert.equal(record.leaveSubmissionBlocker, undefined)
    assert.equal(record.localAssertionGaps, undefined)
  }
  const record = recordOf()
  await assert.rejects(submitOaLocalLeave({
    ownerApi: { post: async () => { throw new Error('network failed 2040100000') } },
    body: {}, binding: selfBinding(), caseRecord: record
  }), /network failed/)
  assert.equal(record.leaveSubmissionBlocker, undefined)
})

test('OA successful submission preserves precise formal ID, never HTTP-only or lossy ID evidence', async () => {
  const record = recordOf()
  const id = '2110674491764727809'
  assert.equal(await submitOaLocalLeave({
    ownerApi: { post: async () => ({ code: 0, data: id }) },
    body: {}, binding: selfBinding(), caseRecord: record
  }), id)
  assert.equal(record.leaveSubmissionBlocker, undefined)
  for (const response of [{ status: 200 }, { code: 0, data: 2 ** 54 }]) {
    await assert.rejects(submitOaLocalLeave({
      ownerApi: { post: async () => response }, body: {}, binding: selfBinding(), caseRecord: record
    }))
  }
})

test('OA guard initializes all original gaps before stopping any write', async () => {
  const record = { checks: [] }
  let calls = 0
  await assert.rejects(runOaLocalClosure({
    caseRecord: record, api: { postBusiness: async () => { calls++ } }
  }, { env: {}, config: { target: 'online' } }), /BLOCKED/)
  assert.equal(calls, 0)
  assert.deepEqual(record.remainingAssertions, OA_LOCAL_ASSERTIONS)
})

test('OA booking cleanup re-reads a committed cancel timeout, retains failure evidence and never recancels', async () => {
  const marker = 'E2E-OA001-123456789ABC'
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  let status = 20
  let writes = 0
  const args = {
    api: { getBusiness: async () => ({ code: 0, data: {
      id: '3', subject: marker, description: marker, organizerUserId: '1', roomId: '2', status
    } }) },
    ownerApi: { putBusiness: async (path) => {
      writes++
      assert.equal(path, '/oa/meeting-booking/cancel?id=3')
      status = 30
      throw new Error('cancel response timeout')
    } },
    id: '3', marker, roomId: '2', userId: '1'
  }
  cleanup.track('booking', '3', async (_, entry) => cleanupOaLocalBooking({ ...args, entry }))
  await cleanup.cleanup()
  assert.match(record.fixtures[0].cleanup, /RETAINED_AUDIT/)
  assert.deepEqual(record.fixtures[0].transportErrors, ['cancel response timeout'])
  assert.equal(record.checks.some((row) => row.passed === false), true)
  await cleanupOaLocalBooking({ ...args, entry: {} })
  assert.equal(writes, 1)
  assert.equal(finalizeLocalAssertions(record, ['booking'], {}).acceptanceComplete, false)
})

test('OA booking cleanup refuses changed ownership and missing records without writing', async () => {
  const marker = 'E2E-OA001-123456789ABC'
  for (const changed of [
    null, { id: '4' }, { subject: 'shared' }, { description: 'shared' },
    { organizerUserId: '4' }, { roomId: '4' }
  ]) {
    let writes = 0
    const row = changed === null ? null : { id: '3', subject: marker, description: marker,
      organizerUserId: '1', roomId: '2', status: 20, ...changed }
    await assert.rejects(cleanupOaLocalBooking({
      api: { getBusiness: async () => ({ code: 0, data: row }) },
      ownerApi: { putBusiness: async () => { writes++ } },
      id: '3', marker, roomId: '2', userId: '1', entry: {}
    }), /所有权不符/)
    assert.equal(writes, 0)
  }
})

test('OA uncommitted cancel timeout blocks its room and owner until explicit cleanup reentry', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  const marker = 'E2E-OA001-123456789ABC'
  let status = 20
  let cancels = 0
  const parents = []
  cleanup.track('user', '1', async () => { parents.push('user') })
  cleanup.track('room', '2', async () => { parents.push('room') })
  cleanup.track('booking', '3', async (_, entry) => cleanupOaLocalBooking({
    api: { getBusiness: async () => ({ code: 0, data: {
      id: '3', subject: marker, description: marker, organizerUserId: '1', roomId: '2', status
    } }) },
    ownerApi: { putBusiness: async () => { cancels++; throw new Error('timeout') } },
    id: '3', marker, roomId: '2', userId: '1', entry
  }), { blocks: ['1', '2'] })
  await assert.rejects(cleanup.cleanup(), AggregateError)
  assert.equal(cancels, 1)
  assert.deepEqual(parents, [])
  status = 30
  await cleanup.cleanup()
  assert.equal(cancels, 1)
  assert.deepEqual(parents, ['room', 'user'])
})

test('OA controlled SELF refusal records no created resource and never fabricates a BPM cleanup', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  const id = await createClosureResource({
    record, cleanup, label: 'owned leave', recovery: { kind: 'leave', marker: 'E2E-OA001-123456789ABC' },
    find: async () => [], owns: () => false, allowNoResource: true,
    create: () => submitOaLocalLeave({ ownerApi: { post: async () => missingEmployee() },
      caseRecord: record, binding: selfBinding(), body: {} }),
    remove: async () => { assert.fail('no BPM resource exists') }
  })
  await cleanup.cleanup()
  assert.equal(id, null)
  assert.equal(record.resourceIntents[0].state, 'NOT_CREATED_BUSINESS_GAP')
  assert.equal(record.fixtures, undefined)
  assert.equal(record.leaveSubmissionBlocker.selfReadCode, 2040100000)
})

const approvalScenario = (options = {}) => {
  const marker = 'E2E-OA001-123456789ABC'
  const processId = 'leave-process-1'
  const definitionId = 'hrm-leave-approval:1:definition-1'
  const leaveId = '2110674491764727809'
  const employeeId = '14'
  const ownerUserId = '13'
  const stages = options.stages || ['hr', 'hr', 'ops']
  const userIds = { hr: '21', ops: '22' }
  const calls = { approvals: [], logins: [], logouts: [], reads: 0 }
  let stage = 0
  const complete = () => stage === stages.length
  const fact = () => ({ id: leaveId, employeeId, processInstanceId: processId,
    reason: `${marker}-APPROVE`, remark: `${marker}-APPROVE`,
    approvalStatus: complete() ? 2 : 1, approvalTime: complete() ? '2026-10-15T14:00:00' : null,
    ...(options.fact?.(stage) || {}) })
  const tasks = () => stages.slice(0, Math.min(stage + 1, stages.length)).map((username, index) => ({
    id: `task-${index}`, processInstanceId: processId, taskDefinitionKey: `node-${index}`,
    assigneeUser: options.candidate ? null : { id: userIds[username] },
    status: index < stage ? 2 : 1, endTime: index < stage ? '2026-10-15T14:00:00' : null
  }))
  const ok = (data) => ({ code: 0, data })
  const ownerApi = { getBusiness: async (path) => {
    if (path.startsWith('/bpm/process-instance/get-approval-detail?')) return ok({
      processInstance: { id: processId }, activityNodes: [{
        id: `node-${stage}`, tasks: [{ id: `task-${stage}` }],
        candidateUsers: [{ id: userIds[stages[stage]] }]
      }]
    })
    assert.equal(path, `/bpm/process-instance/get?id=${processId}`)
    return ok({ id: processId, businessKey: leaveId, startUser: { id: ownerUserId },
      processDefinitionId: definitionId, status: complete() ? 2 : 1,
      endTime: complete() ? '2026-10-15T14:00:00' : null,
      ...(options.process?.(stage) || {}) })
  } }
  const api = { getBusiness: async (path) => {
    calls.reads++
    if (path.startsWith('/hrm/attendance/leave/get?')) return ok(fact())
    if (path.startsWith('/bpm/task/list-by-process-instance-id?')) {
      return ok(options.tasks ? options.tasks(tasks(), stage) : tasks())
    }
    const username = Object.keys(userIds).find((name) => path === `/system/user/get?id=${userIds[name]}`)
    assert.ok(username, `unexpected readonly API ${path}`)
    return ok({ id: userIds[username], username })
  } }
  const apiFactory = ({ token, tenantId }) => {
    assert.equal(tenantId, '1')
    if (!token) return { postBusiness: async (path, body, flags) => {
      assert.equal(path, '/system/auth/login-encrypted')
      assert.equal(flags.encrypted, true)
      assert.equal(body.password, 'unit-test-only')
      calls.logins.push(body.username)
      return ok({ accessToken: body.username, tenantId: '1' })
    } }
    return {
      getBusiness: async (path) => {
        if (path === '/system/auth/get-permission-info') {
          return ok({ user: { id: options.wrongIdentity ? '99' : userIds[token], username: token } })
        }
        assert.equal(path, `/bpm/task/my-todo?processInstanceId=${processId}&taskId=task-${stage}`)
        if (options.noTodo) return ok(null)
        return ok({ ...tasks()[stage],
          ...(options.candidate ? { assigneeUser: { id: userIds[token] } } : {}),
          signEnable: options.sign === true, ...(options.todo || {}) })
      },
      putBusiness: async (path, body) => {
        assert.equal(path, '/bpm/task/approve')
        assert.deepEqual(Object.keys(body).sort(), ['id', 'reason'])
        assert.equal(body.id, `task-${stage}`)
        assert.ok(body.reason.includes(marker))
        calls.approvals.push({ taskId: body.id, username: token })
        if (options.timeout) throw new Error('approval transport timeout')
        if (!options.noProgress) stage++
        return options.response || ok(true)
      },
      postBusiness: async (path) => {
        assert.equal(path, '/system/auth/logout')
        calls.logouts.push(token)
        if (options.logoutFailure) throw new Error('logout failed')
        return ok(true)
      }
    }
  }
  const caseRecord = recordOf()
  const args = {
    api, ownerApi, marker, employeeId, ownerUserId, leave: { id: leaveId, fact: fact() }, caseRecord,
    apiFactory, approvers: [['hr', 'unit-test-only'], ['ops', 'unit-test-only']],
    pause: async () => {}, pollAttempts: 2,
    read: async (sql) => {
      assert.ok(sql.includes(`l.id=${leaveId}`))
      assert.ok(sql.includes("h.TENANT_ID_='1'"))
      return { available: true, rows: [[leaveId, employeeId, complete() ? '2' : '1',
        processId, options.wrongDbKey ? '99' : leaveId, definitionId,
        complete() ? (options.activeAfterEnd ? '1' : '0') : '1']] }
    }
  }
  return { args, calls, caseRecord }
}

test('OA uses only configured exact credential pairs, without guessing another account password', () => {
  assert.deepEqual(oaLocalApproverCredentials({
    hrmApproverUsername: 'hrmgr01', hrmApproverPassword: 'unit-hrm',
    purchaseApproverUsername: 'purchase', purchaseApproverPassword: 'unit-a',
    financeApproverUsername: 'finance', financeApproverPassword: '',
    finalApproverUsername: 'ops', finalApproverPassword: 'unit-b',
    username: 'admin', password: 'unit-c'
  }), [['hrmgr01', 'unit-hrm'], ['purchase', 'unit-a'], ['ops', 'unit-b'], ['admin', 'unit-c']])
})

test('OA never borrows another configured password when the optional HRM credential is absent', () => {
  for (const hrm of [
    { hrmApproverUsername: 'hrmgr01', hrmApproverPassword: '' },
    { hrmApproverUsername: '', hrmApproverPassword: 'unit-hrm' },
    {}
  ]) {
    assert.deepEqual(oaLocalApproverCredentials({
      ...hrm, financeApproverUsername: 'finance', financeApproverPassword: 'unit-finance'
    }), [['finance', 'unit-finance']])
  }
})

test('OA formally approves successive real assignees and verifies linked HRM/BPM terminal state', async () => {
  const { args, calls, caseRecord } = approvalScenario()
  const result = await approveOaLocalLeave(args)
  assert.equal(result.completed, true)
  assert.deepEqual(calls.approvals, [
    { taskId: 'task-0', username: 'hr' }, { taskId: 'task-1', username: 'hr' },
    { taskId: 'task-2', username: 'ops' }
  ])
  assert.deepEqual(calls.logins, ['hr', 'ops'])
  assert.deepEqual(calls.logouts, ['hr', 'ops'])
  assert.equal(caseRecord.checks.find((row) => row.name === OA_LOCAL_CHECKS.approve)?.passed, true)
  assert.deepEqual(caseRecord.database.map((row) => row.stage), ['oa-approve-link-before', 'oa-approve-link-after'])
  assert.equal(caseRecord.evidence.length, 3)
})

test('OA can match an exact candidate only when the official API returns that exact executable todo', async () => {
  const success = approvalScenario({ candidate: true })
  assert.equal((await approveOaLocalLeave(success.args)).completed, true)
  const blocked = approvalScenario({ candidate: true, noTodo: true })
  assert.equal((await approveOaLocalLeave(blocked.args)).completed, false)
  assert.deepEqual(blocked.calls.approvals, [])
  assert.deepEqual(blocked.calls.logouts, ['hr'])
  assert.match(blocked.caseRecord.localAssertionGaps[2], /本人可执行待办/)
})

test('OA missing actual assignee credentials gives a precise GAP with no approval or login', async () => {
  const { args, calls, caseRecord } = approvalScenario()
  args.approvers = [['ops', 'unit-test-only']]
  assert.equal((await approveOaLocalLeave(args)).completed, false)
  assert.deepEqual(calls.approvals, [])
  assert.deepEqual(calls.logins, [])
  assert.match(caseRecord.localAssertionGaps[2], /21\/hr/)
  assert.equal(caseRecord.checks.some((row) => row.name === OA_LOCAL_CHECKS.approve), false)
})

test('OA next-stage credential GAP preserves prior formal approval evidence and closes its session', async () => {
  const { args, calls, caseRecord } = approvalScenario({ stages: ['hr', 'ops'] })
  args.approvers = [['hr', 'unit-test-only']]
  assert.equal((await approveOaLocalLeave(args)).completed, false)
  assert.equal(calls.approvals.length, 1)
  assert.equal(caseRecord.evidence.length, 1)
  assert.deepEqual(calls.logouts, ['hr'])
  assert.match(caseRecord.localAssertionGaps[2], /22\/ops/)
})

test('OA rejects foreign HRM facts, process ownership, definition, tasks and database business keys before writes', async () => {
  for (const options of [
    { fact: () => ({ reason: 'shared leave' }) },
    { process: () => ({ businessKey: '99' }) },
    { process: () => ({ startUser: { id: '99' } }) },
    { process: () => ({ processDefinitionId: 'oa-leave-approval:1:foreign' }) },
    { tasks: (rows) => rows.map((row) => ({ ...row, processInstanceId: 'foreign' })) },
    { wrongDbKey: true }
  ]) {
    const { args, calls } = approvalScenario(options)
    await assert.rejects(approveOaLocalLeave(args), /不符|精确请假流程/)
    assert.deepEqual(calls.approvals, [])
    assert.deepEqual(calls.logins, [])
  }
})

test('OA login identity and my-todo fallback mismatches never authorize an approval', async () => {
  for (const options of [{ wrongIdentity: true }, { todo: { id: 'other-task' } },
    { todo: { processInstanceId: 'foreign' } }, { todo: { status: 0 } }]) {
    const { args, calls } = approvalScenario(options)
    await assert.rejects(approveOaLocalLeave(args), /身份|精确流程待办/)
    assert.deepEqual(calls.approvals, [])
    assert.deepEqual(calls.logouts, ['hr'])
  }
})

test('OA signature requirement is an explicit GAP and never fabricates a signature', async () => {
  const { args, calls, caseRecord } = approvalScenario({ sign: true })
  assert.equal((await approveOaLocalLeave(args)).completed, false)
  assert.deepEqual(calls.approvals, [])
  assert.match(caseRecord.localAssertionGaps[2], /真实签名/)
})

test('OA approval timeout remains failure, is never retried and still logs out the session', async () => {
  const { args, calls, caseRecord } = approvalScenario({ timeout: true })
  await assert.rejects(approveOaLocalLeave(args), /approval transport timeout/)
  assert.equal(calls.approvals.length, 1)
  assert.deepEqual(calls.logouts, ['hr'])
  assert.equal(caseRecord.localAssertionGaps, undefined)
})

test('OA HTTP 200, nonzero success code and absent committed task history never prove closure', async () => {
  for (const options of [
    { response: { status: 200 } }, { response: { code: 200, data: true } },
    { response: { code: 0, data: false } }, { noProgress: true }
  ]) {
    const { args, calls, caseRecord } = approvalScenario(options)
    await assert.rejects(approveOaLocalLeave(args))
    assert.equal(calls.approvals.length, 1)
    assert.equal(caseRecord.checks.some((row) => row.name === OA_LOCAL_CHECKS.approve && row.passed), false)
  }
})

test('OA terminal approval still requires timestamp, same HRM binding and zero real active tasks', async () => {
  for (const options of [
    { activeAfterEnd: true },
    { fact: (stage) => stage === 3 ? { approvalTime: null } : {} },
    { fact: (stage) => stage === 3 ? { processInstanceId: 'foreign' } : {} },
    { process: (stage) => stage === 3 ? { endTime: null } : {} }
  ]) {
    const { args, caseRecord } = approvalScenario(options)
    await assert.rejects(approveOaLocalLeave(args))
    assert.equal(caseRecord.checks.some((row) => row.name === OA_LOCAL_CHECKS.approve && row.passed), false)
  }
})

test('OA preserves approval and logout failures together instead of disguising either as GAP', async () => {
  const { args, calls } = approvalScenario({ timeout: true, logoutFailure: true })
  await assert.rejects(approveOaLocalLeave(args), (error) =>
    error instanceof AggregateError && error.errors.some((row) => /transport timeout/.test(row.message)) &&
    error.errors.some((row) => /logout failed/.test(row.message)))
  assert.equal(calls.approvals.length, 1)
})

test('OA local headed formal booking/HRM leave/BPM/cleanup evidence', {
  skip: process.env.CFOR_HRM_OA_LOCAL_HEADED !== '1', timeout: 240000
}, async () => {
  const outputDir = path.join(process.env.CFOR_HRM_OA_LOCAL_OUT || '/tmp/cfor-e2e/hrm-oa-local-closure',
    `OA-001-${Date.now()}`)
  await fs.mkdir(outputDir, { recursive: true })
  const record = createRunRecord({ selectedCases: ['OA-001'] })
  const caseRecord = createCaseRecord({ id: 'OA-001', suite: 'hrm-pms-oa', title: 'OA local closure' })
  record.cases.push(caseRecord)
  let handle
  let error
  try {
    handle = await launchBrowser({ headed: true, record })
    await installHrmOaLocalApiBridge(handle.context, record)
    const api = createApiClient({ token: await login(handle.page), tenantId: '1', record })
    const result = await runCase({ caseId: 'OA-001', api, page: handle.page, record, caseRecord, outputDir })
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.ok(caseRecord.checks.every((row) => row.passed))
    assert.ok(caseRecord.fixtures.every((row) => row.cleanup !== 'PENDING' && row.cleanup !== 'FAILED'))
    caseRecord.status = 'PARTIAL'
  } catch (failure) {
    error = failure
    caseRecord.status = 'FAIL'
    caseRecord.notes.push(failure.message)
  } finally {
    try { await handle?.flushResponses() } finally { await handle?.browser.close() }
    record.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(redact(record), null, 2))
    console.log(`OA real report: ${outputDir}/report.json`)
  }
  if (error) throw error
})
