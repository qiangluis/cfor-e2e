import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  COST_APPROVAL_CHECKS,
  COST_OUTBOX_CHECKS,
  COST_OUTBOX_MANAGEMENT_ENTRIES,
  COST_OUTBOX_RUNTIME_GAPS,
  COST_OUTBOX_TRIGGER_ENTRIES,
  COST_SEPARATION_CHECKS,
  COST_WORKFLOW_CHECKS,
  costActionHash,
  costApprovalHash,
  costDecisionRequestId,
  costOutboxRetryDelaySeconds,
  inspectCostOutboxRows,
  runCostOutboxClosure,
  runCostPublicationApprovalClosure,
  runCostSeparationClosure,
  runCostWorkflowClosure
} from '../fixtures/cost-workflow-closure.mjs'
import { costCatalogEvidence, runCase } from '../suites/cost.mjs'
import { costWorkflowReviewerPermissions, resolveCostWorkflowMenus } from '../fixtures/cost-scenario.mjs'

test('workflow roles use tenant-assignable formal permissions and navigation ancestors only', () => {
  const full = [
    { id: '10', parentId: '0', type: 1 },
    { id: '11', parentId: '10', type: 2, path: 'cost-publish' },
    { id: '12', parentId: '11', type: 3, permission: 'cost:publication:approve' },
    { id: '13', parentId: '11', type: 3, permission: 'cost:publication:query' },
    { id: '14', parentId: '11', type: 3, permission: 'unrelated:write' }
  ]
  assert.deepEqual(resolveCostWorkflowMenus(full, full,
    ['cost:publication:approve', 'cost:publication:query']), ['12', '11', '10', '13'])
  assert.throws(() => resolveCostWorkflowMenus(full.filter((row) => row.id !== '12'),
    full, ['cost:publication:approve']), /BLOCKED/)
  assert.throws(() => resolveCostWorkflowMenus(full.filter((row) => row.id !== '10'),
    full, ['cost:publication:approve']), /BLOCKED/)
  assert.equal(costWorkflowReviewerPermissions('COST-006', 'reviewer'), null)
  assert.deepEqual(costWorkflowReviewerPermissions('COST-028', 'approvalReviewer'), [
    'cost:period:query', 'cost:model:query', 'cost:publication:query', 'cost:publication:approve'
  ])
})

const setup = ({ serviceFailure = false } = {}) => {
  const period = { id: '1', status: 'TRIAL_PENDING', version: 1 }
  const trial = { id: '2', status: 'PENDING', resultHash: 'owned-hash' }
  const fixture = {
    tenantId: '1', runId: 'run', suffix: 'own', periodId: '1', currentTrialId: '2',
    month: '2200-01', versionNo: 'owned'
  }
  const api = {
    async getBusiness (path) {
      return { code: 0, data: structuredClone(path.endsWith('/current') ? trial : period) }
    },
    async postBusiness (path, body, options) {
      return { code: 0, data: { requestId: options.headers['X-Request-Id'], version: 1 } }
    },
    async post () {
      return { code: 409003, msg: '同一 requestId 已用于不同输入，拒绝覆盖原请求' }
    },
    async request (method, path, body, options) {
      if (serviceFailure) return { code: 500, msg: '系统异常' }
      if (options.headers['X-Input-Hash'] === 'INVALID_E2E_HASH') {
        return { code: 409003, msg: '输入哈希已变化，请刷新成本期间后重试' }
      }
      assert.equal(options.headers['X-Input-Hash'], costActionHash(['TRIAL_CONFIRM', '2', 'owned-hash', '1']))
      return { code: 409003, msg: '期间版本已变化，If-Match=101，当前版本=1' }
    }
  }
  return {
    api, record: { runId: 'run' },
    caseRecord: { fixtures: { costScenario: fixture }, checks: [] }
  }
}

test('workflow closure proves replay, hash headers and precise If-Match rejection without changing state', async () => {
  const input = setup()
  await runCostWorkflowClosure(input)
  assert.equal(input.caseRecord.checks.length, 3)
  assert.ok(input.caseRecord.checks.every((row) => row.passed))
  assert.deepEqual(input.caseRecord.checks.map((row) => row.name), [
    COST_WORKFLOW_CHECKS.replay, COST_WORKFLOW_CHECKS.headers, COST_WORKFLOW_CHECKS.version
  ])
})

test('workflow closure never substitutes service errors for contractual negative evidence', async () => {
  const input = setup({ serviceFailure: true })
  await assert.rejects(() => runCostWorkflowClosure(input), /X-Input-Hash/)
  assert.equal(input.caseRecord.checks.at(-1).passed, false)
})

test('action hash matches sorted pipe-terminated server inputs', () => {
  assert.equal(costActionHash(['b', 'a']), costActionHash(['a', 'b']))
  assert.notEqual(costActionHash(['ab']), costActionHash(['a', 'b']))
})

test('publication approval hash preserves backend token order and has no trailing delimiter', () => {
  assert.equal(
    costApprovalHash(['ROLLBACK', '101', 'result', 'reason', '7']),
    '255bd0ccb0f3225b8d2fe72093e52386492a47f0e89a647492563b56b042d9b4'
  )
  assert.notEqual(
    costApprovalHash(['ROLLBACK', '101', 'result', 'reason', '7']),
    costActionHash(['ROLLBACK', '101', 'result', 'reason', '7'])
  )
})

test('decision request IDs are stable, distinct and fit the 64-character audit contract', () => {
  const input = {
    runId: '20261013113235334-77925', approvalId: '9223372036854775807',
    action: 'withdraw', note: 'COST-028 rollback-withdraw '.repeat(20)
  }
  const requestId = costDecisionRequestId(input)
  assert.ok(requestId.length <= 64)
  assert.equal(requestId, costDecisionRequestId({ ...input }))
  for (const change of [
    { runId: 'another-run' }, { approvalId: '9223372036854775806' },
    { action: 'approve' }, { note: 'failure-cleanup' }
  ]) assert.notEqual(requestId, costDecisionRequestId({ ...input, ...change }))
})

test('COST-023 closure keeps catalog evidence names distinct', () => {
  assert.notEqual(COST_SEPARATION_CHECKS.creator, COST_SEPARATION_CHECKS.selfConfirm)
  assert.notEqual(COST_SEPARATION_CHECKS.selfConfirm, COST_SEPARATION_CHECKS.publicationActors)
})

test('COST-004 evidence exposes only the formal trigger and management entry points', () => {
  assert.deepEqual(COST_OUTBOX_TRIGGER_ENTRIES.map((entry) => entry.path), [
    '/cost/periods',
    '/cost/periods/{periodId}/trials',
    '/cost/trials/{trialId}/confirm',
    '/cost/trials/{trialId}/rollback',
    '/cost/periods/{periodId}/publications',
    '/cost/publications/{publicationId}/rollback',
    '/cost/periods/{periodId}/publications/reopen'
  ])
  assert.deepEqual(COST_OUTBOX_MANAGEMENT_ENTRIES.map((entry) => entry.path), [
    '/cost/outbox/dead-letters?limit=100',
    '/cost/outbox/{id}',
    '/cost/outbox/dispatch?batchSize=50',
    '/cost/outbox/{id}/retry',
    '/cost/outbox/{id}/complete'
  ])
  assert.equal(COST_OUTBOX_TRIGGER_ENTRIES.every((entry) =>
    entry.method === 'POST' && entry.permission.startsWith('cost:')), true)
  assert.equal(COST_OUTBOX_MANAGEMENT_ENTRIES.every((entry) =>
    entry.permission === 'cost:outbox:query' || entry.permission === 'cost:outbox:handle'), true)
})

test('COST-004 retry evidence follows the formal bounded exponential schedule', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((count) => costOutboxRetryDelaySeconds(count)),
    [30, 60, 120, 240, 480, 960, 1920, 1920]
  )
  assert.throws(() => costOutboxRetryDelaySeconds(0), /positive integer/)
  assert.throws(() => costOutboxRetryDelaySeconds(1, { baseSeconds: 60, capSeconds: 30 }),
    /invalid retry delay bounds/)
})

test('COST-004 empty formal dead-letter result is recorded as BLOCKED without writes', async () => {
  const calls = []
  const caseRecord = { checks: [], evidence: [], notes: [] }
  const result = await runCostOutboxClosure({
    api: {
      async getBusiness (path) {
        calls.push(['GET', path])
        return { code: 0, data: [] }
      },
      async post () { throw new Error('unexpected POST') },
      async put () { throw new Error('unexpected PUT') },
      async delete () { throw new Error('unexpected DELETE') }
    },
    caseRecord
  })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.observedDeadLetters, 0)
  assert.deepEqual(calls, [['GET', '/cost/outbox/dead-letters?limit=100']])
  assert.equal(caseRecord.checks[0].name, COST_OUTBOX_CHECKS.query)
  assert.equal(caseRecord.checks[0].passed, true)
  assert.equal(caseRecord.checks.at(-1).name, COST_OUTBOX_CHECKS.blocked)
  assert.equal(caseRecord.checks.at(-1).passed, true)
  assert.equal(caseRecord.gaps[0].status, 'BLOCKED')
  assert.deepEqual(caseRecord.gaps[0].reasons, [...COST_OUTBOX_RUNTIME_GAPS])
})

test('COST-004 formal dead-letter rows are validated but do not hide missing causal evidence', async () => {
  const row = {
    id: 'outbox-1',
    periodId: '100',
    action: 'TRIAL_CONFIRM',
    requestId: 'request-1',
    eventKey: 'request-1|TRIAL_CONFIRM|100',
    payloadHash: 'a'.repeat(64),
    status: 'DEAD',
    retryCount: 5,
    maxRetry: 5,
    nextRetryTime: '2026-10-13T10:00:00',
    lastError: 'IllegalStateException: listener unavailable',
    manualOperator: null,
    manualAt: null,
    manualNote: null
  }
  const inspected = inspectCostOutboxRows([row])
  assert.equal(inspected.valid, true)
  const caseRecord = { checks: [], evidence: [], notes: [] }
  const result = await runCostOutboxClosure({
    api: { async getBusiness () { return { code: 0, data: [row] } } },
    caseRecord
  })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.observedDeadLetters, 1)
  assert.equal(caseRecord.checks[1].name, COST_OUTBOX_CHECKS.fields)
  assert.equal(caseRecord.checks[1].passed, true)
  assert.match(caseRecord.notes[0], /BLOCKED/)
})

test('COST-004 malformed dead-letter data cannot be certified', async () => {
  const invalid = {
    id: 'outbox-1',
    periodId: '100',
    action: 'TRIAL_CONFIRM',
    requestId: 'request-1',
    eventKey: 'request-1|TRIAL_CONFIRM|100',
    payloadHash: 'bad',
    status: 'RETRY_WAIT',
    retryCount: 1,
    maxRetry: 5,
    nextRetryTime: '2026-10-13T10:00:00',
    lastError: ''
  }
  assert.equal(inspectCostOutboxRows([invalid]).valid, false)
  await assert.rejects(
    () => runCostOutboxClosure({
      api: { async getBusiness () { return { code: 0, data: [invalid] } } },
      caseRecord: { checks: [], evidence: [], notes: [] }
    }),
    /死信查询接口/
  )
})

// These doubles exercise the fixture's safety and evidence gates, not delivery.
const outboxContext = () => {
  const record = { runId: 'unit-outbox', environment: { tenantId: '1' } }
  const caseRecord = { id: 'COST-004', checks: [], notes: [], evidence: [] }
  const fixture = {
    caseId: 'COST-004', scenario: 'accounting', runId: record.runId, tenantId: '1',
    month: '2200-01', modelId: '102', periodId: '101', versionNo: 'unit-model',
    remark: `CFOR-E2E:costScenario:accounting:${record.runId}:UNIT:tenant=1:org=1:month=2200-01`
  }
  const model = {
    id: '102', accountingOrgId: '1', versionNo: fixture.versionNo, status: 'LOCKED',
    effectiveMonth: fixture.month, remark: fixture.remark
  }
  const period = {
    id: '101', accountingOrgId: '1', modelVersionId: '102', modelVersionNo: fixture.versionNo,
    period: fixture.month, enterpriseType: 'MANUFACTURING', status: 'ACCOUNTING', version: 0
  }
  const payload = {
    periodId: '101', requestId: 'real-create-request', status: 'ACCOUNTING',
    version: 0, message: '核算期间已建立'
  }
  const event = {
    id: 'event-owned-101', periodId: '101', action: 'PERIOD_CREATE',
    requestId: payload.requestId, eventKey: `${payload.requestId}|PERIOD_CREATE|101`,
    payloadJson: JSON.stringify(payload), payloadHash: createHash('sha256')
      .update(JSON.stringify(payload)).digest('hex'),
    status: 'PENDING', retryCount: 0, maxRetry: 5, nextRetryTime: '2026-10-15T10:00:00',
    manualOperator: null, manualAt: null, manualNote: null
  }
  const calls = []
  const sqlCalls = []
  const steps = []
  const ok = (data) => ({ code: 0, data: structuredClone(data) })
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/cost/model-versions/102') return ok(model)
      if (path === '/cost/periods/101') return ok(period)
      if (path === '/cost/outbox/event-owned-101') return ok(event)
      if (path === '/cost/outbox/dead-letters?limit=100') return ok([])
      throw new Error(`unexpected GET ${path}`)
    },
    async postBusiness (path, body, options) {
      calls.push(['POST', path, body, options])
      assert.equal(path, '/cost/periods')
      assert.equal(body.period, fixture.month)
      assert.equal(body.modelVersion, fixture.versionNo)
      assert.equal(options.headers['X-Request-Id'], event.requestId)
      return ok(payload)
    },
    async post (path, body, options) {
      calls.push(['POST', path, body, options])
      if (path === '/cost/periods') {
        return options.headers['X-Request-Id'] === event.requestId
          ? { code: 409003, msg: '同一 requestId 已用于不同输入，拒绝覆盖原请求' }
          : { code: 422001, msg: '该核算期间已绑定其他模型版本，不能直接替换' }
      }
      assert.match(path, /^\/cost\/outbox\/event-owned-101\/(retry|complete)$/)
      assert.match(body.note, /non-DEAD/)
      return { code: 422003, msg: '仅死信成本事件允许人工接管' }
    }
  }
  const dependencies = {
    config: { target: 'local', tenantId: '1' }, writeFixtures: true,
    assertLocalWriteSafety: async () => { steps.push('safety') },
    resetCostScenarioCache: () => { steps.push('reset') },
    async prepareCostScenario ({ scenario }) {
      steps.push('prepare')
      assert.equal(scenario, 'accounting')
      caseRecord.fixtures = { costScenario: fixture }
    },
    async verifyOwnedPeriodPage ({ fixture: selected }) {
      steps.push('page')
      assert.equal(selected.periodId, '101')
    },
    async runReadOnlySql (sql) {
      sqlCalls.push(sql)
      assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|REPLACE|TRUNCATE|ALTER)\b/i)
      let rows
      if (sql.includes('SELECT id,CAST(period_id')) {
        rows = [[event.id, '101', event.action, event.requestId, event.eventKey,
          event.payloadJson, event.payloadHash, event.status, String(event.retryCount), String(event.maxRetry)]]
      } else if (sql.includes('cost004') && sql.includes('SELECT * FROM cost_period')) {
        rows = [[JSON.stringify(period)], [JSON.stringify(model)], [JSON.stringify(event)], ['unchanged-request-audit']]
      } else if (sql.includes('SELECT request_id,action,input_hash')) {
        rows = [
          [event.requestId, 'PERIOD_CREATE',
            costActionHash(['1', fixture.month, period.enterpriseType, fixture.versionNo]),
            'SUCCEEDED', '101', '0', 'ACCOUNTING'],
          ['PERIOD_READY', event.requestId, 'PERIOD', '101']
        ]
      } else if (sql.includes('GROUP BY status')) {
        rows = [['PENDING', '201', '1']]
      } else throw new Error(`unexpected SQL ${sql}`)
      return { available: true, rows: structuredClone(rows) }
    }
  }
  return { record, caseRecord, fixture, model, period, payload, event, calls, sqlCalls, steps, api, dependencies }
}

test('COST-004 owned closure preserves real event facts and deliberately leaves delivery/audit acceptance incomplete', async () => {
  const input = outboxContext()
  const result = await runCostOutboxClosure(input)
  assert.equal(result.status, 'PARTIAL')
  assert.ok(result.reasons.some((reason) => reason.includes('dispatch')))
  assert.ok(input.caseRecord.checks.every((row) => row.passed === true))
  assert.deepEqual(input.caseRecord.checks.map((row) => row.name), [
    COST_OUTBOX_CHECKS.owned, COST_OUTBOX_CHECKS.replay,
    `${COST_OUTBOX_CHECKS.manualGate} retry`, `${COST_OUTBOX_CHECKS.manualGate} complete`,
    COST_OUTBOX_CHECKS.page, COST_OUTBOX_CHECKS.query
  ])
  assert.deepEqual(input.steps.slice(0, 5), ['safety', 'reset', 'prepare', 'reset', 'safety'])
  assert.equal(input.caseRecord.costOutboxClosure.dispatchInvoked, false)
  assert.equal(input.caseRecord.costOutboxClosure.outboxId, input.event.id)
  assert.equal(input.calls.filter(([method]) => method === 'POST').length, 6)
  assert.ok(input.calls.every(([, path]) => !/dispatch|job|permissions|workspace-states/.test(path)))
  costCatalogEvidence('COST-004', input.caseRecord)
  assert.deepEqual(input.caseRecord.catalogAssertions.map((row) => row.status),
    ['GAP', 'VERIFIED', 'GAP', 'GAP', 'GAP'])
  assert.equal(input.caseRecord.passCandidate, false)
})

test('COST-004 local run and write-safety gates stop before allocating any fixture', async () => {
  for (const mutate of [
    (input) => { input.dependencies.config.target = 'production' },
    (input) => { input.dependencies.config.tenantId = '2' },
    (input) => { input.record.environment.tenantId = '2' },
    (input) => { input.record.runId = "invalid'run" },
    (input) => { input.caseRecord.id = 'COST-023' },
    (input) => { input.dependencies.assertLocalWriteSafety = async () => { throw new Error('BLOCKED unsafe') } }
  ]) {
    const input = outboxContext()
    mutate(input)
    await assert.rejects(() => runCostOutboxClosure(input), /BLOCKED/)
    assert.ok(!input.steps.includes('prepare'))
    assert.equal(input.calls.length, 0)
  }
})

test('COST-004 persisted ownership and event identity/hash gates reject drift before POST', async () => {
  for (const mutate of [
    (input) => { input.fixture.tenantId = '2' },
    (input) => { input.fixture.runId = 'previous-run' },
    (input) => { input.fixture.month = '2026-10' },
    (input) => { input.fixture.caseId = 'COST-003' },
    (input) => { input.model.remark = 'shared model' },
    (input) => { input.period.modelVersionId = '103' },
    (input) => { input.period.currentTrialId = '104' },
    (input) => { input.event.periodId = '999' },
    (input) => { input.event.requestId = "invalid'input" },
    (input) => { input.event.payloadHash = 'a'.repeat(64) },
    (input) => { input.event.eventKey = 'wrong-key' }
  ]) {
    const input = outboxContext()
    mutate(input)
    await assert.rejects(() => runCostOutboxClosure(input))
    assert.ok(input.calls.every(([method]) => method === 'GET'))
  }
})

test('COST-004 replay/rejection/manual errors and changed facts can never certify negative evidence', async () => {
  for (const mutation of ['replay', 'collision', 'business', 'retry', 'complete', 'manual-drift', 'page-drift']) {
    const input = outboxContext()
    const post = input.api.post
    input.api.post = async (path, body, options) => {
      const failure = mutation === 'collision' && path === '/cost/periods' &&
          options.headers['X-Request-Id'] === input.event.requestId ||
        mutation === 'business' && path === '/cost/periods' &&
          options.headers['X-Request-Id'] !== input.event.requestId ||
        path.endsWith(`/${mutation}`)
      if (failure) return { code: 500, msg: '系统异常' }
      const result = await post(path, body, options)
      if (mutation === 'manual-drift' && path.endsWith('/retry')) input.event.manualNote = 'unexpected mutation'
      return result
    }
    if (mutation === 'replay') input.api.postBusiness = async () => ({ code: 0, data: { ...input.payload, version: 1 } })
    if (mutation === 'page-drift') input.dependencies.verifyOwnedPeriodPage = async () => { input.period.version++ }
    await assert.rejects(() => runCostOutboxClosure(input))
    assert.equal(input.caseRecord.checks.at(-1).passed, false)
    costCatalogEvidence('COST-004', input.caseRecord)
    assert.equal(input.caseRecord.passCandidate, false)
    assert.equal(input.caseRecord.catalogAssertions[4].status, 'GAP')
  }
})

test('COST-004 suite invokes its owned closure once and never falls through to shared scenario discovery', async () => {
  const input = outboxContext()
  const result = await runCase({
    caseId: 'COST-004', page: {}, record: input.record, caseRecord: input.caseRecord, outputDir: '/unused'
  }, {
    login: async () => 'unit-token', createApiClient: () => input.api, writeFixtures: true,
    costOutboxDependencies: input.dependencies
  })
  assert.equal(result.partial, true)
  assert.equal(result.token, 'unit-token')
  assert.equal(input.steps.filter((step) => step === 'prepare').length, 1)
  assert.equal(input.caseRecord.passCandidate, false)
})

// These doubles test fixture control flow only; acceptance evidence comes from
// the locked headed runner and its real API/database records.
const approvalContext = ({
  failDecision = false,
  dirtyTokens = false,
  lostActiveRead = false,
  history = new Map(),
  periodId = '101',
  publicationId = '104',
  republishedPublicationId = '105'
} = {}) => {
  const record = { runId: 'unit-workflow', environment: { tenantId: '1' } }
  const fixture = {
    caseId: 'COST-028', scenario: 'published', tenantId: '1', runId: record.runId,
    suffix: 'UNIT', month: '2200-01', periodId, modelId: '102',
    currentTrialId: '103', publicationId, versionNo: 'unit-model',
    remark: `CFOR-E2E:costScenario:published:${record.runId}:UNIT:tenant=1:org=1:month=2200-01`,
    reviewerUserId: '201', reviewerUsername: 'reviewer', reviewerPassword: 'unit-only',
    approvalReviewerUserId: '202', approvalReviewerUsername: 'approvalReviewer',
    approvalReviewerPassword: 'unit-only'
  }
  const model = {
    id: '102', accountingOrgId: 1, versionNo: fixture.versionNo, remark: fixture.remark,
    status: 'LOCKED', effectiveMonth: fixture.month
  }
  const period = {
    id: periodId, accountingOrgId: 1, modelVersionId: '102', modelVersionNo: fixture.versionNo,
    period: fixture.month, status: 'COST_PUBLISHED', version: 3,
    currentTrialId: '103', currentPublicationId: publicationId
  }
  const trial = {
    periodId, trialVersion: 'unit-trial', creatorId: '1', status: 'CONFIRMED',
    resultHash: 'unit-result', objects: [{ objectKey: 'unit' }], inputAmount: 10
  }
  const trace = {
    publicationId, periodId, batchNo: 'unit-batch', status: 'PUBLISHED',
    resultHash: trial.resultHash, configSnapshotHash: 'unit-config', sourceSnapshotHash: 'unit-source',
    components: [{ amount: 10 }], sources: [{ amount: 10 }], allocations: [{ amount: 10 }]
  }
  const caseRecord = { id: 'COST-028', fixtures: { costScenario: fixture }, checks: [], notes: [] }
  const calls = []
  const loggedOut = []
  let pending = null
  let last = null
  let currentTrialId = '103'
  let activeReadLost = false
  const ok = (data) => ({ code: 0, data: structuredClone(data) })
  const result = (approval) => ({
    periodId: approval.periodId, publicationId: approval.publicationId, approvalId: approval.id,
    status: approval.status === 'PENDING' ? 'APPROVAL_PENDING' : approval.status,
    approvalStatus: approval.status
  })
  const client = (userId) => {
    const api = {
      async getBusiness (path) {
        calls.push({ userId, method: 'GET', path })
        if (path === '/system/auth/get-permission-info') return ok({
          user: { id: userId }, roles: userId === '1' ? ['super_admin'] : [`dedicated-${userId}`],
          permissions: [
            'cost:trial:run', 'cost:trial:confirm', 'cost:publication:publish',
            'cost:publication:approve', 'cost:publication:query', 'cost:period:query',
            'cost:model:query'
          ]
        })
        if (path === '/cost/model-versions/102') return ok(model)
        if (path === `/cost/periods/${periodId}`) return ok(period)
        if (path === `/cost/periods/${periodId}/trials/current`) return ok(trial)
        if (/^\/cost\/publications\/\d+\/trace$/.test(path)) return ok(trace)
        if (path === `/cost/publication-approvals/periods/${periodId}/active`) {
          assert.equal(userId, '1', 'approval/query permission must not be added to the other actors')
          if (lostActiveRead && pending && !activeReadLost) {
            activeReadLost = true
            throw new Error('temporary active read failure')
          }
          return ok(pending)
        }
        throw new Error(`unexpected GET ${path}`)
      },
      async request (method, path, body, options) {
        calls.push({ userId, method, path, body: structuredClone(body), options: structuredClone(options) })
        if (path === '/system/auth/logout') {
          loggedOut.push(userId)
          return ok(true)
        }
        if (path === `/cost/trials/${currentTrialId}/rollback`) {
          assert.equal(userId, '1')
          trial.status = 'ROLLED_BACK'
          period.status = 'ACCOUNTING'
          period.currentTrialId = null
          period.version++
          return ok({ status: 'ACCOUNTING', trialId: currentTrialId })
        }
        if (path === `/cost/periods/${periodId}/trials`) {
          assert.equal(userId, '202')
          currentTrialId = '106'
          trial.status = 'PENDING'
          trial.creatorId = userId
          period.status = 'TRIAL_PENDING'
          period.currentTrialId = currentTrialId
          period.version++
          return ok({ status: 'TRIAL_PENDING', trialId: currentTrialId })
        }
        if (path === `/cost/trials/${currentTrialId}/confirm`) {
          if (userId === '1') return {
            code: 422001,
            msg: currentTrialId === '106'
              ? '模型维护人与试算复核人不能相同'
              : '试算执行人与复核确认人不能相同'
          }
          assert.equal(userId, '201')
          trial.status = 'CONFIRMED'
          period.status = 'TRIAL_CONFIRMED'
          period.version++
          return ok({ status: 'CONFIRMED' })
        }
        if (path === `/cost/periods/${periodId}/publications`) {
          assert.equal(userId, '201')
          const publicationId = period.status === 'TRIAL_CONFIRMED' && caseRecord.id === 'COST-023'
            ? fixture.publicationId : republishedPublicationId
          trace.publicationId = publicationId
          trace.status = 'PUBLISHED'
          period.status = 'COST_PUBLISHED'
          period.currentPublicationId = publicationId
          period.version++
          return ok({ publicationId })
        }
        if (path.endsWith('/rollback') || path.endsWith('/reopen')) {
          const requestId = options.headers['X-Request-Id']
          const actionType = path.endsWith('/rollback') ? 'ROLLBACK' : 'REOPEN'
          const reason = body.reason.trim()
          const existing = history.get(requestId)
          if (existing) {
            const storedHash = costApprovalHash([
              actionType, trace.publicationId, trace.resultHash, reason, String(existing.periodVersion)
            ])
            if (existing.actionType !== actionType || existing.publicationId !== trace.publicationId ||
                existing.requestedBy !== userId || existing.reason !== reason || existing.hash !== storedHash) {
              return { code: 422001, msg: '同一 requestId 已用于不同的回退或反月结申请' }
            }
            if (options.headers['X-Input-Hash'] &&
                options.headers['X-Input-Hash'] !== existing.hash) {
              return { code: 422001, msg: '输入哈希与已提交的审批申请不一致' }
            }
            return ok(result(existing))
          }
          if (userId === '201') return {
            code: 422001,
            msg: path.endsWith('/rollback')
              ? '正式成本发布人与回退操作人不能相同'
              : '正式成本发布人与反月结重开操作人不能相同'
          }
          if (pending) return {
            code: 422001, msg: '该正式批次已存在待审批申请，请先等待审批或撤回原申请'
          }
          assert.equal(options.headers['X-Input-Hash'], costApprovalHash([
            actionType, trace.publicationId, trace.resultHash, reason, String(period.version)
          ]))
          pending = {
            id: String(301 + history.size), periodId, publicationId: trace.publicationId,
            status: 'PENDING', actionType, requestedBy: userId, reason, periodVersion: period.version,
            batchNo: trace.batchNo, canApprove: false, canWithdraw: true, version: 0,
            hash: options.headers['X-Input-Hash'], requestId
          }
          last = pending
          history.set(requestId, pending)
          return ok(result(pending))
        }
        const decision = path.match(/^\/cost\/publication-approvals\/(\d+)\/(approve|reject|withdraw)$/)
        assert.ok(decision, `unexpected write ${method} ${path}`)
        assert.equal(decision[1], pending.id)
        assert.equal(options.headers['If-Match'], '0')
        assert.ok(options.headers['X-Request-Id'].length <= 64)
        if (decision[2] === 'approve' && userId !== '202') return {
          code: 422001, msg: userId === '1'
            ? '审批人不能是申请发起人'
            : '正式成本发布人与回退或反月结审批人不能相同'
        }
        if (failDecision && decision[2] === 'approve') return { code: 500, msg: 'system failure' }
        if (decision[2] === 'approve') {
          assert.equal(userId, '202')
          last.status = 'EXECUTED'
          last.approverId = userId
          last.executionRequestId = `cost-approval-${last.id}-0`
          period.status = last.actionType === 'ROLLBACK' ? 'TRIAL_CONFIRMED' : 'ACCOUNTING'
          last.executionStatus = period.status
          period.currentPublicationId = null
          period.version++
          trace.status = last.actionType === 'ROLLBACK' ? 'ROLLED_BACK' : 'REVERSED'
          trial.status = last.actionType === 'ROLLBACK' ? 'CONFIRMED' : 'SUPERSEDED'
          if (last.actionType === 'REOPEN') period.currentTrialId = null
        } else if (decision[2] === 'reject') {
          assert.equal(userId, '202')
          last.status = 'REJECTED'
          last.rejectedBy = userId
        } else {
          assert.equal(userId, '1')
          last.status = 'WITHDRAWN'
          last.withdrawnBy = userId
        }
        const response = result(last)
        pending = null
        return ok(response)
      }
    }
    for (const name of ['postBusiness', 'post']) api[name] = (path, body, options) =>
      api.request('POST', path, body, options)
    return api
  }
  const api = client('1')
  const dependencies = {
    config: { target: 'local', tenantId: '1' }, writeFixtures: true,
    assertLocalWriteSafety: async () => {},
    loginAs: async (ignored, username) => username === 'reviewer' ? '201' : '202',
    createApiClient: ({ token }) => client(token),
    prepareCostWorkflowReviewers: async () => {},
    runCostOperatingSeparationClosure: async ({ caseRecord }) => {
      caseRecord.checks.push(
        { name: COST_SEPARATION_CHECKS.operatingConfirm, passed: true, details: 'unit stub' },
        { name: COST_SEPARATION_CHECKS.operatingRollback, passed: true, details: 'unit stub' }
      )
    },
    async runReadOnlySql (sql) {
      let rows
      if (sql.includes('system_oauth2_access_token')) {
        rows = [['access', dirtyTokens ? '1' : '0'], ['refresh', '0']]
      } else if (sql.includes('CAST(trial_id AS CHAR)')) {
        rows = [[trace.publicationId, periodId, currentTrialId, '201']]
      } else if (sql.includes('FROM cost_model_version')) {
        rows = [['102', '1']]
      } else if (sql.includes('creator,trial_version')) {
        rows = [['103', periodId, '1', trial.trialVersion, trial.resultHash, trial.status]]
      } else if (sql.includes('SELECT * FROM cost_period')) {
        rows = [[JSON.stringify(period)], [JSON.stringify(trial)], [JSON.stringify(trace)]]
      } else if (sql.includes('execution_result_status')) {
        const timestamp = (condition) => condition ? '2026-10-13 00:00:00' : 'NULL'
        rows = [[last.status, '1', last.approverId || 'NULL', last.rejectedBy || 'NULL',
          last.withdrawnBy || 'NULL', timestamp(last.approverId), timestamp(last.rejectedBy),
          timestamp(last.withdrawnBy), timestamp(last.approverId),
          last.executionStatus || 'NULL', last.executionRequestId || 'NULL']]
      } else if (sql.includes("SELECT 'publication'")) {
        rows = [['publication', trace.status, '201', '202'], ['trial', trial.status, '1', '201']]
      } else if (sql.includes('SELECT COUNT(*)')) {
        rows = [[pending ? '1' : '0']]
      } else if (sql.includes('input_hash,request_id')) {
        rows = [[last.id, periodId, last.publicationId, last.actionType, last.status,
          last.reason, String(last.periodVersion), last.hash, last.requestId, '1']]
      } else throw new Error(`unexpected SQL ${sql}`)
      return { available: true, rows: structuredClone(rows) }
    }
  }
  return { api, record, caseRecord, dependencies, fixture, model, period, trial, trace, calls, loggedOut, history }
}

test('COST-028 exercises six decisions with three actors, scoped real-contract hashes and zero tokens', async () => {
  const input = approvalContext()
  await runCostPublicationApprovalClosure(input)
  assert.deepEqual(input.caseRecord.checks.map((row) => row.name), Object.values(COST_APPROVAL_CHECKS))
  assert.equal(input.caseRecord.costApprovalEvidence.length, 6)
  assert.equal(input.period.status, 'ACCOUNTING')
  assert.deepEqual(input.loggedOut, ['201', '202'])
  assert.equal(input.caseRecord.database.filter((row) => row.stage.includes('session-zero')).length, 2)
  assert.ok(input.calls.every((row) => !/outbox|assign-role|workspace-states/.test(row.path)))
  assert.ok(input.caseRecord.costWorkflowActors.approvalReviewer.permissions.includes('cost:publication:query'))
  costCatalogEvidence('COST-028', input.caseRecord)
  assert.deepEqual(input.caseRecord.catalogAssertions.map((row) => row.status),
    ['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'GAP', 'GAP'])
  assert.equal(input.caseRecord.passCandidate, false)
})

test('COST-023 proves creator and self-confirm denial but does not substitute approval denial for application denial', async () => {
  const input = approvalContext()
  input.caseRecord.id = input.fixture.caseId = 'COST-023'
  input.period.status = 'TRIAL_PENDING'
  input.period.currentPublicationId = null
  input.period.version = 1
  input.trial.status = 'PENDING'
  await runCostSeparationClosure(input)
  assert.deepEqual(input.caseRecord.checks.map((row) => row.name), [
    COST_SEPARATION_CHECKS.creator,
    COST_SEPARATION_CHECKS.selfConfirm,
    COST_SEPARATION_CHECKS.maintainer,
    COST_SEPARATION_CHECKS.operatingConfirm,
    COST_SEPARATION_CHECKS.operatingRollback,
    COST_SEPARATION_CHECKS.publicationRequest,
    COST_SEPARATION_CHECKS.publicationActors
  ])
  assert.equal(input.caseRecord.costApprovalEvidence.length, 2)
  assert.equal(input.period.status, 'COST_PUBLISHED')
  assert.deepEqual(input.loggedOut, ['202', '201', '201', '202'])
  costCatalogEvidence('COST-023', input.caseRecord)
  assert.deepEqual(input.caseRecord.catalogAssertions.map((row) => row.status),
    ['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED'])
  assert.equal(input.caseRecord.passCandidate, true)
})

test('COST-023 then COST-028 share tenant-wide history without request or decision collisions', async () => {
  const history = new Map()
  const separation = approvalContext({ history, periodId: '130', publicationId: '62' })
  separation.caseRecord.id = separation.fixture.caseId = 'COST-023'
  separation.period.status = 'TRIAL_PENDING'
  separation.period.currentPublicationId = null
  separation.period.version = 1
  separation.trial.status = 'PENDING'
  await runCostSeparationClosure(separation)
  const originalHistory = structuredClone([...history.entries()])
  assert.equal(originalHistory.length, 2)

  const approval = approvalContext({
    history, periodId: '133', publicationId: '64', republishedPublicationId: '65'
  })
  assert.equal(separation.record.runId, approval.record.runId)
  await runCostPublicationApprovalClosure(approval)
  const separationEvidence = separation.caseRecord.costApprovalEvidence
  const approvalEvidence = approval.caseRecord.costApprovalEvidence
  assert.equal(separationEvidence.length, 2)
  assert.equal(approvalEvidence.length, 6)
  assert.equal(history.size, 8)
  assert.deepEqual([...history.entries()].slice(0, 2), originalHistory)
  assert.equal(separation.period.status, 'COST_PUBLISHED')
  assert.equal(approval.period.status, 'ACCOUNTING')

  const expected = [
    ...['rollback-withdraw', 'reopen-withdraw'].map((suffix) =>
      `cost023-${separation.record.runId}-${suffix}`),
    ...['rollback-withdraw', 'rollback-reject', 'rollback-approve',
      'reopen-withdraw', 'reopen-reject', 'reopen-approve'].map((suffix) =>
      `cost028-${approval.record.runId}-${suffix}`)
  ]
  assert.deepEqual([...history.keys()], expected)
  assert.deepEqual(separationEvidence.map((row) => row.publicationId), ['62', '62'])
  assert.deepEqual(approvalEvidence.map((row) => row.publicationId), ['64', '64', '64', '65', '65', '65'])

  const calls = [...separation.calls, ...approval.calls]
  for (const [requestId, application] of history) {
    const submissions = calls.filter((row) =>
      row.options?.headers?.['X-Request-Id'] === requestId)
    assert.equal(submissions.length, 2, `${requestId} must submit once and replay once`)
    assert.deepEqual(submissions[0], submissions[1])
    assert.equal(submissions[0].options.headers['X-Input-Hash'], application.hash)
    assert.equal(submissions[0].options.headers['If-Match'], String(application.periodVersion))
    assert.equal(submissions[0].body.reason, application.reason)
    assert.equal(submissions[0].path, application.actionType === 'ROLLBACK'
      ? `/cost/publications/${application.publicationId}/rollback`
      : `/cost/periods/${application.periodId}/publications/reopen`)
    assert.ok(requestId.length <= 64, 'submission also writes a 64-character audit request ID')
  }
  const decisions = calls.filter((row) =>
    /^\/cost\/publication-approvals\/\d+\/(approve|reject|withdraw)$/.test(row.path) &&
    !row.options.expectedBusinessRejection)
  assert.equal(decisions.length, 8)
  const decisionIds = decisions.map((row) => row.options.headers['X-Request-Id'])
  assert.equal(new Set([...expected, ...decisionIds]).size, 16)
  assert.ok(decisionIds.every((id) => id.length <= 64))
  const writeRequestIds = (context) => context.calls.filter((row) => row.method === 'POST')
    .map((row) => row.options?.headers?.['X-Request-Id'] || row.body?.requestId).filter(Boolean)
  const separationRequestIds = new Set(writeRequestIds(separation))
  const approvalRequestIds = new Set(writeRequestIds(approval))
  assert.ok(separationRequestIds.size > 2 && approvalRequestIds.size > 6)
  assert.deepEqual([...approvalRequestIds].filter((id) => separationRequestIds.has(id)), [])
})

test('shared history rejects a legacy cost028 key from COST-023 reused for a different COST-028 application', async () => {
  const history = new Map()
  const separation = approvalContext({ history, periodId: '130', publicationId: '62' })
  separation.caseRecord.id = separation.fixture.caseId = 'COST-023'
  await runCostPublicationApprovalClosure({ ...separation, separationOnly: true })
  const legacyHistory = new Map([...history.entries()].map(([id, application]) => {
    const requestId = id.replace(/^cost023-/, 'cost028-')
    return [requestId, { ...structuredClone(application), requestId }]
  }))
  const originalHistory = structuredClone([...legacyHistory.entries()])
  const approval = approvalContext({ history: legacyHistory, periodId: '133', publicationId: '64' })
  const legacyRequestId = `cost028-${approval.record.runId}-rollback-withdraw`
  const reason = `COST-028 ${approval.record.runId} rollback-withdraw`
  const response = await approval.api.postBusiness('/cost/publications/64/rollback', { reason }, {
    headers: {
      'X-Request-Id': legacyRequestId,
      'X-Input-Hash': costApprovalHash(['ROLLBACK', '64', approval.trace.resultHash,
        reason, String(approval.period.version)]),
      'If-Match': String(approval.period.version)
    }
  })
  assert.equal(response.code, 422001)
  assert.equal(response.msg, '同一 requestId 已用于不同的回退或反月结申请')
  assert.deepEqual([...legacyHistory.entries()], originalHistory)
  assert.equal((await approval.api.getBusiness('/cost/publication-approvals/periods/133/active')).data, null)
  assert.deepEqual(approval.caseRecord.checks, [])
})

test('workflow ownership and distinct actor gates fail before any login or write', async () => {
  for (const mutate of [
    (input) => { input.fixture.caseId = 'COST-023' },
    (input) => { input.fixture.runId = 'prior-run' },
    (input) => { input.fixture.tenantId = '2' },
    (input) => { input.fixture.periodId = Number.MAX_SAFE_INTEGER + 1 },
    (input) => { input.model.remark = 'shared-model' },
    (input) => { input.model.status = 'DRAFT' },
    (input) => { input.period.modelVersionId = '999' },
    (input) => { input.fixture.approvalReviewerUserId = '201' }
  ]) {
    const input = approvalContext()
    mutate(input)
    await assert.rejects(() => runCostPublicationApprovalClosure(input), /BLOCKED/)
    assert.ok(input.calls.every((row) => row.method === 'GET'))
    assert.deepEqual(input.loggedOut, [])
  }
})

test('a decision service error cannot certify closure and its owned pending request is withdrawn', async () => {
  const input = approvalContext({ failDecision: true })
  await assert.rejects(() => runCostPublicationApprovalClosure(input), /missing successful business data/)
  assert.deepEqual(input.caseRecord.checks, [])
  assert.deepEqual(input.loggedOut, ['201', '202'])
  assert.ok(input.caseRecord.database.some((row) => row.stage === 'cost-workflow-cleanup-after'))
  assert.equal(input.period.status, 'COST_PUBLISHED')
})

test('a lost active read after successful submission still registers and cleans the owned request', async () => {
  const input = approvalContext({ lostActiveRead: true })
  await assert.rejects(() => runCostPublicationApprovalClosure(input), /temporary active read failure/)
  assert.deepEqual(input.caseRecord.checks, [])
  assert.ok(input.caseRecord.database.some((row) => row.stage === 'cost-workflow-cleanup-after'))
  assert.deepEqual(input.loggedOut, ['201', '202'])
})

test('nonzero token readback fails closure even when all business decisions succeeded', async () => {
  const input = approvalContext({ dirtyTokens: true })
  await assert.rejects(() => runCostPublicationApprovalClosure(input), /dedicated actor tokens not zero/)
  assert.deepEqual(input.loggedOut, ['201', '202'])
})
