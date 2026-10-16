import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import test from 'node:test'
import {
  assessCostStageEvidence,
  COST_STAGE_EVIDENCE_BINDINGS,
  COST_STAGE_EVIDENCE_CHECKS,
  costStageEvidenceBindings,
  prepareCostStageEvidenceFixture,
  runCostStageEvidenceClosure,
  verifyCostStageEvidencePage
} from '../fixtures/cost-stage-evidence-closure.mjs'
import { COST_STAGE_RULES } from '../fixtures/cost-rule-stage-closure.mjs'

const clone = (value) => structuredClone(value)
const ok = (data) => ({ code: 0, data: clone(data) })
const identity = ({ id, level, status }) => ({ id, level, status })
const pending = (row) => ['BLOCK', 'WARN'].includes(row.level) && row.status === 'OPEN'
const rejected = {
  试算: { code: 422001, msg: 'Only accounting periods can start a trial; roll back the current trial or publication first' },
  确认: { code: 409003, msg: '同一 requestId 已用于不同输入，拒绝覆盖原请求' },
  发布: { code: 422001, msg: '只有已确认试算的期间可以发布正式成本' }
}

// These observations are offline doubles, never a substitute for a real run.
const evidence = ({
  missingCollect = false, missingLevels = false, rejectReplay = false, formalCollect = !missingCollect
} = {}) => {
  const runId = 'unit-cost034'
  const suffix = 'ABCDEF123456'
  const fixture = {
    caseId: 'COST-034', runId, tenantId: '1', scenario: 'rule-stage', suffix,
    month: '2200-01', versionNo: `E2E-C034-${suffix}`, periodId: '101', modelId: '102',
    remark: `CFOR-E2E:costScenario:rule-stage:${runId}:${suffix}:tenant=1:org=1:month=2200-01`
  }
  const source = {
    id: '103', periodId: '101', snapshotKey: 'DEFAULT', versionNo: fixture.versionNo,
    snapshotHash: 'a'.repeat(64), status: 'CONFIRMED',
    lines: [{
      sourceModule: 'MANUAL', sourceType: 'LABOR', sourceId: `C034-${suffix}`,
      sourceLineId: `C034-${suffix}-1`, sourceNo: `C034-${suffix}`, sourceVersion: '1',
      laborAmount: 123.45, sourceStatus: 'CONFIRMED'
    }]
  }
  const draft = { ...clone(source), status: 'DRAFT',
    lines: source.lines.map((line) => ({ ...line, sourceStatus: 'DRAFT' })) }
  const receipt = { id: '301', orderId: '302', status: 20, businessType: 'NORMAL',
    no: `IN-${suffix}`, inTime: '2200-01-06T10:00:00',
    items: [{ id: '304', productId: '303', count: 2, totalPrice: 123.45 }] }
  // 采购来源主从 ID 是 WMS 采购入库（mes_stk_io）主从 ID。
  const wms = { wmsId: '305', entryId: '306' }
  const collectSource = { id: '106', periodId: '101', snapshotKey: 'PURCHASE',
    versionNo: fixture.versionNo, snapshotHash: 'c'.repeat(64), status: 'CONFIRMED',
    lines: [{ sourceModule: 'ERP', sourceType: 'PURCHASE_RECEIPT', sourceId: wms.wmsId,
      sourceLineId: wms.entryId, sourceNo: receipt.no, sourceVersion: 'receipt-v1',
      productCode: '303', quantity: 2, materialAmount: 123.45, sourceStatus: 'CONFIRMED' }] }
  const collectDraft = { ...clone(collectSource), status: 'DRAFT',
    lines: collectSource.lines.map((row) => ({ ...row, sourceStatus: 'DRAFT' })) }
  if (formalCollect) Object.assign(fixture, {
    materialId: '303', purchaseInId: '301', purchaseOrderId: '302',
    wmsReceiptId: wms.wmsId, wmsReceiptEntryId: wms.entryId
  })
  const resultHash = 'b'.repeat(64)
  const sourceSnapshotHash = createHash('sha256')
    .update(`${source.snapshotHash}|${formalCollect ? `${collectSource.snapshotHash}|` : ''}`).digest('hex')
  const trace = {
    publicationId: '105', periodId: '101', batchNo: 'PUB-20261016000000000',
    resultHash, sourceSnapshotHash, status: 'PUBLISHED',
    sources: [{ sourceSnapshotId: '103', sourceModule: 'MANUAL', sourceType: 'LABOR',
      sourceId: source.lines[0].sourceId, sourceBusinessLineId: source.lines[0].sourceLineId,
      sourceVersion: '1', amount: 123.45 }]
  }
  const root = '/cost/periods/101'
  const observations = Object.keys(COST_STAGE_RULES).flatMap((stage, index) => {
    const endpoint = stage === '确认' ? '/cost/trials/104/confirm' : `${root}/${
      stage === '取数' ? `source-snapshot${formalCollect ? '/purchase/refresh' : ''}` :
        stage === '试算' ? 'trials' : 'publications'}`
    const response = stage === '取数' ? formalCollect ? collectDraft : draft : {
      periodId: '101', trialId: '104', resultHash, version: index, requestId: `request-${index}`,
      ...(stage === '发布' ? { publicationId: '105', batchNo: trace.batchNo } : {})
    }
    const input = { stage, actor: index < 2 ? 'operator' : 'reviewer',
      method: index === 0 && !formalCollect ? 'PUT' : 'POST', endpoint,
      body: index === 0 ? formalCollect ? undefined :
        { snapshotKey: 'DEFAULT', versionNo: fixture.versionNo, lines: draft.lines } :
        index === 1 ? { enterpriseType: 'MANUFACTURING', periodId: '101', modelVersion: fixture.versionNo } : undefined,
      headers: index === 0 ? {} : { 'X-Request-Id': `request-${index}`, 'If-Match': String(index - 1) }
    }
    return [{ ...clone(input), response: ok(response) },
      { ...clone(input), response: rejectReplay && index > 0 ? clone(rejected[stage]) : ok(response) }]
  })
  let nextId = 1000
  const stageHits = Object.fromEntries(Object.entries(COST_STAGE_RULES).map(([stage, rules]) => [
    stage, stage === '取数' && missingCollect ? [] : rules.map((ruleCode) => ({
      id: String(++nextId), periodId: '101', ruleCode, ruleVersion: fixture.modelId,
      level: 'PASS', status: 'CLOSED',
      basis: `${stage}通过，规则未命中异常；证据：${stage === '取数' ? `${formalCollect ? 'PURCHASE' : 'DEFAULT'}@${fixture.versionNo}` :
        stage === '发布' ? trace.batchNo : resultHash}`
    }))
  ]))
  const levels = missingLevels ? [] : [
    { id: '2000', periodId: '101', ruleCode: 'CI-002', ruleVersion: fixture.modelId,
      level: 'BLOCK', status: 'HANDLED', basis: 'offline handled blocker' },
    { id: '2001', periodId: '101', ruleCode: 'CV-001', ruleVersion: fixture.modelId,
      level: 'WARN', status: 'OPEN', basis: 'offline warning' }
  ]
  const ranking = { BLOCK: 0, WARN: 1, PASS: 2 }
  const history = Array.from({ length: 13 }, (_, index) => {
    const phase = index < 1 ? 0 : index < 4 ? 1 : index < 7 ? 2 : index < 10 ? 3 : 4
    const hits = [
      ...Object.keys(COST_STAGE_RULES).slice(0, phase).flatMap((stage) => stageHits[stage]),
      ...(phase >= 2 ? levels : [])
    ].sort((a, b) => ranking[a.level] - ranking[b.level] || Number(BigInt(b.id) - BigInt(a.id)))
    const period = {
      id: '101', modelVersionId: fixture.modelId, modelVersionNo: fixture.versionNo,
      period: fixture.month, accountingOrgId: '1', enterpriseType: 'MANUFACTURING',
      status: ['ACCOUNTING', 'ACCOUNTING', 'TRIAL_PENDING', 'TRIAL_CONFIRMED', 'COST_PUBLISHED'][phase],
      version: Math.max(0, phase - 1),
      ...(phase >= 2 ? { currentTrialId: '104' } : {}),
      ...(phase === 4 ? { currentPublicationId: '105' } : {})
    }
    const database = [
      ...hits.slice().sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))).map((row) => [
        'hit', row.id, row.periodId, row.ruleCode, row.ruleVersion, row.level, row.status, row.basis
      ]),
      ...(phase > 0 ? [['snapshot', '103', 'DEFAULT', fixture.versionNo, source.snapshotHash,
        index < 3 ? 'DRAFT' : 'CONFIRMED']] : []),
      ...(formalCollect && phase > 0 ? [['snapshot', collectSource.id, 'PURCHASE', fixture.versionNo,
        collectSource.snapshotHash, index < 3 ? 'DRAFT' : 'CONFIRMED']] : []),
      ...(phase >= 2 ? [['trial', '104', resultHash, phase >= 3 ? 'CONFIRMED' : 'PENDING',
        '10', phase >= 3 ? '20' : 'NULL']] : []),
      ...(phase === 4 ? [['publication', '105', '104', resultHash, trace.batchNo, 'PUBLISHED', sourceSnapshotHash]] : []),
      ...(index >= 3 ? [['hash', source.snapshotHash],
        ...(formalCollect ? [['hash', collectSource.snapshotHash]] : [])] : []),
      ['blocking', '0'],
      ...(formalCollect && phase > 0 ? [['collect-line', '106', 'ERP', 'PURCHASE_RECEIPT',
        wms.wmsId, wms.entryId, 'receipt-v1', '303', '2.000000', '123.450000',
        index < 3 ? 'DRAFT' : 'CONFIRMED']] : [])
    ]
    return { period, hits, database }
  })
  const hits = history.at(-1).hits
  const page = { passed: true, periodId: '101', blocking: 0, warning: missingLevels ? 0 : 1,
    allVisible: hits.map(identity), defaultVisible: hits.filter(pending).slice(0, 8).map(identity),
    requests: [{ method: 'GET', pathname: '/admin-api/cost/periods/101/rule-hits' }] }
  return {
    fixture, observations, runId,
    closure: { caseId: 'COST-034', runId, tenantId: '1', periodId: '101',
      trialId: '104', publicationId: '105', batchNo: trace.batchNo, cleanupComplete: true,
      collectPreparation: formalCollect ? { available: true, receipt, wms } : {
        available: false, code: 'COLLECT_PURCHASE_PREREQUISITES_MISSING', details: { publishedQualityPlan: false }
      },
      ...(formalCollect ? { collectSource } : {}),
      source, trace, history, page }
  }
}

test('strict offline assessment requires all four actual rule sets and frozen hashes', () => {
  const result = assessCostStageEvidence(evidence())
  assert.equal(result.complete, true)
  assert.deepEqual(result.proofs, { stages: true, evidence: true, queue: true, replay: true })
  assert.deepEqual(result.gaps, [])
  assert.deepEqual(Object.values(result.stages).map((rows) => rows.length), [2, 9, 9, 10])
})

test('formal manual save without collect recorder stays GAP, even if all API calls succeed', () => {
  const result = assessCostStageEvidence(evidence({ missingCollect: true }))
  assert.deepEqual(result.proofs, { stages: false, evidence: false, queue: true, replay: false })
  assert.ok(result.gaps.some((gap) => gap.code === 'COLLECT_SAVE_HAS_NO_STAGE_RECORDER'))
  assert.equal(result.complete, false)
})

test('state/version replay rejections never count as successful idempotency', () => {
  const result = assessCostStageEvidence(evidence({ rejectReplay: true }))
  assert.equal(result.proofs.stages, true)
  assert.equal(result.proofs.evidence, true)
  assert.equal(result.proofs.replay, false)
  assert.deepEqual(result.gaps.filter((gap) => gap.assertionIndex === 3).map((gap) => gap.code),
    ['STAGE_REPLAY_REJECTED_试算', 'STAGE_REPLAY_REJECTED_确认', 'STAGE_REPLAY_REJECTED_发布'])
})

test('PASS-only results do not prove BLOCK/WARN/PASS ordering vacuously', () => {
  const result = assessCostStageEvidence(evidence({ missingLevels: true }))
  assert.equal(result.proofs.queue, false)
  assert.ok(result.gaps.some((gap) => gap.code === 'REAL_BLOCK_WARN_SAMPLES_MISSING'))
})

test('ownership rejects cached/shared scenarios, other cases, stale runs and imprecise IDs', async (t) => {
  for (const mutation of [
    (input) => { input.fixture.scenario = 'published' },
    (input) => { input.fixture.caseId = 'COST-012' },
    (input) => { input.fixture.tenantId = '2' },
    (input) => { input.fixture.runId = 'old-run' },
    (input) => { input.fixture.month = '2026-10' },
    (input) => { input.fixture.modelId = 102 },
    (input) => { input.fixture.periodId = '9223372036854775808' },
    (input) => { input.closure.cleanupComplete = false },
    (input) => { input.closure.history[0].period.status = 'COST_PUBLISHED' },
    (input) => { input.closure.history[0].period.modelVersionId = '999' }
  ]) await t.test(mutation.toString(), () => {
    const input = evidence()
    mutation(input)
    assert.throws(() => assessCostStageEvidence(input), /COST-034/)
  })
})

test('hash, source identity, reviewer and API/SQL conflicts fail rather than become GAP', async (t) => {
  for (const mutation of [
    (input) => { input.closure.source.snapshotHash = 'not-a-hash' },
    (input) => { input.closure.trace.sourceSnapshotHash = 'c'.repeat(64) },
    (input) => { input.closure.trace.sources[0].sourceVersion = '2' },
    (input) => { input.closure.trace.sources[0].sourceBusinessLineId = 'different-line' },
    (input) => { input.closure.trace.sources[0].amount = 0 },
    (input) => { input.closure.history.at(-1).period.currentPublicationId = '999' },
    (input) => { input.closure.history.at(-1).database.find((row) => row[0] === 'trial')[5] = '10' },
    (input) => { input.closure.history.at(-1).database.find((row) => row[0] === 'hit')[4] = 'other-version' },
    (input) => { input.closure.history.at(-1).hits[0].ruleVersion = input.fixture.versionNo },
    (input) => { input.closure.history.at(-1).hits.find((row) => row.level === 'PASS').status = 'OPEN' }
  ]) await t.test(mutation.toString(), () => {
    const input = evidence()
    mutation(input)
    assert.throws(() => assessCostStageEvidence(input))
  })
})

test('late aggregated stage evidence cannot replace evidence at stage completion', () => {
  const input = evidence()
  for (const index of [1, 2]) {
    input.closure.history[index].hits = []
    input.closure.history[index].database = input.closure.history[index].database.filter((row) => row[0] !== 'hit')
  }
  assert.throws(() => assessCostStageEvidence(input))
  const incomplete = evidence()
  incomplete.closure.history.pop()
  assert.throws(() => assessCostStageEvidence(incomplete), /完整观测/)
})

test('replay preserves payload, headers, actor, successful result and exact rule identities', async (t) => {
  for (const mutation of [
    (input) => { input.observations[1].body = { versionNo: 'different-version' } },
    (input) => { input.observations[3].headers['If-Match'] = '99' },
    (input) => { input.observations[5].headers['X-Request-Id'] = 'new-request' },
    (input) => { input.observations[5].actor = 'operator' },
    (input) => {
      input.observations[4].response.data.trialId = '999'
      input.observations[5].response.data.trialId = '999'
    },
    (input) => {
      input.observations[6].response.data.batchNo = 'PUB-WRONG'
      input.observations[7].response.data.batchNo = 'PUB-WRONG'
    },
    (input) => {
      input.observations[2].body.modelVersion = 'different-model'
      input.observations[3].body.modelVersion = 'different-model'
    },
    (input) => { input.observations[7].response.data.publicationId = '999' },
    (input) => { input.observations[3].response = { code: 500, msg: 'service error' } },
    (input) => { input.observations.pop() },
    (input) => { input.closure.history[5].hits[0].basis = 'changed-on-retry' }
  ]) await t.test(mutation.toString(), () => {
    const input = evidence()
    mutation(input)
    assert.throws(() => assessCostStageEvidence(input))
  })
})

test('queue checks full pagination, exact counts, default PASS exclusion and read-only requests', async (t) => {
  for (const mutation of [
    (input) => { input.closure.page.allVisible.pop() },
    (input) => { input.closure.page.allVisible.reverse() },
    (input) => { input.closure.page.defaultVisible.push(input.closure.page.allVisible.at(-1)) },
    (input) => { input.closure.page.blocking = 30 },
    (input) => { input.closure.page.warning = 0 },
    (input) => { input.closure.page.periodId = '999' },
    (input) => { input.closure.page.requests.push({ method: 'PUT', pathname: '/admin-api/cost/workspace' }) },
    (input) => { input.closure.page.requests = [] }
  ]) await t.test(mutation.toString(), () => {
    const input = evidence()
    mutation(input)
    assert.throws(() => assessCostStageEvidence(input))
  })
  const noPage = evidence()
  noPage.closure.page = { passed: true }
  const result = assessCostStageEvidence(noPage)
  assert.equal(result.proofs.queue, false)
  assert.ok(result.gaps.some((gap) => gap.code === 'PAGE_EVIDENCE_MISSING'))
})

const settings = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083', apiUrl: 'http://127.0.0.1:48083/admin-api',
  webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}

const runtime = (options = {}) => {
  const input = evidence(options)
  const { fixture, closure, observations } = input
  let stateIndex = 0
  let currentState
  const events = []
  const calls = []
  const resultFor = (stage, replay = false) => clone(observations.find((row, index) =>
    row.stage === stage && index % 2 === (replay ? 1 : 0)).response)
  const operator = {
    async getBusiness (endpoint) {
      calls.push(['GET', endpoint])
      if (endpoint === '/cost/model-versions/102') return ok({
        ...fixture, versionNo: fixture.versionNo, remark: fixture.remark,
        enterpriseType: 'MANUFACTURING', status: 'LOCKED'
      })
      if (endpoint === '/cost/periods/101') {
        currentState = closure.history[stateIndex++]
        assert.ok(currentState, 'unexpected extra state read')
        return ok(currentState.period)
      }
      if (endpoint.startsWith('/cost/periods/101/rule-hits?')) {
        assert.match(endpoint, /pageSize=100/)
        return ok({ list: currentState.hits, total: currentState.hits.length })
      }
      if (endpoint.startsWith('/cost/periods/101/source-snapshot?')) {
        return ok(endpoint.includes('snapshotKey=PURCHASE') ? closure.collectSource : closure.source)
      }
      if (endpoint === '/cost/periods/101/trials/current') return ok({
        resultHash: closure.trace.resultHash, objects: [{}], inputAmount: 123.45,
        finishedAmount: 123.45, differenceAmount: 0
      })
      if (endpoint === '/cost/publications/105/trace') return ok(closure.trace)
      throw new Error(`unexpected GET ${endpoint}`)
    },
    async putBusiness (endpoint) {
      calls.push(['PUT', endpoint])
      return ok({ ...clone(closure.source), status: 'DRAFT',
        lines: closure.source.lines.map((row) => ({ ...row, sourceStatus: 'DRAFT' })) })
    },
    async postBusiness (endpoint) {
      calls.push(['POST', endpoint])
      if (endpoint.endsWith('source-snapshot/purchase/refresh')) return resultFor('取数')
      if (endpoint.includes('source-snapshot/confirm?')) {
        return ok(endpoint.includes('snapshotKey=PURCHASE') ? closure.collectSource : closure.source)
      }
      assert.equal(endpoint, '/cost/periods/101/trials')
      return resultFor('试算')
    },
    async post (endpoint) {
      calls.push(['POST-replay', endpoint])
      assert.equal(endpoint, '/cost/periods/101/trials')
      return resultFor('试算', true)
    }
  }
  const reviewer = {
    async postBusiness (endpoint) {
      calls.push(['reviewer-POST', endpoint])
      if (endpoint === '/system/auth/logout') {
        events.push('logout')
        return ok(true)
      }
      return resultFor(endpoint.endsWith('/confirm') ? '确认' : '发布')
    },
    async post (endpoint) {
      calls.push(['reviewer-replay', endpoint])
      return resultFor(endpoint.endsWith('/confirm') ? '确认' : '发布', true)
    }
  }
  const context = {
    api: operator, page: {}, token: 'offline-operator-secret',
    record: { runId: input.runId, environment: { tenantId: '1' } },
    caseRecord: { id: 'COST-034', caseId: 'COST-034', checks: [], notes: [] }
  }
  const dependencies = {
    settings, writeFixtures: true,
    async assertLocalWriteSafety () { events.push('safety') },
    async prepareFixture ({ caseRecord }) {
      events.push('prepare-owned')
      caseRecord.fixtures.costScenario = clone(fixture)
      return caseRecord.fixtures.costScenario
    },
    async preparePurchase () { return clone(closure.collectPreparation) },
    async readSql (sql) {
      assert.match(sql, /tenant_id=1/)
      assert.match(sql, /period_id=101/)
      assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|INSERT)\b/i)
      return { available: true, rows: clone(currentState.database) }
    },
    async createReviewer ({ permissions, fixture }) {
      events.push('create-reviewer')
      assert.ok(permissions.includes('cost:trial:confirm'))
      assert.ok(permissions.includes('cost:publication:publish'))
      assert.ok(!permissions.some((value) => /approve|rollback|admin/.test(value)))
      fixture.reviewer = { userId: '20', username: 'offline-reviewer', password: 'offline-password' }
      return fixture.reviewer
    },
    async loginAs () { return 'offline-reviewer-secret' },
    createApiClient () { return reviewer },
    async cleanupReviewer () { events.push('cleanup-reviewer') },
    async verifyPage () { events.push('verify-page'); return clone(closure.page) }
  }
  return { input, context, dependencies, events, calls }
}

test('new entry reuses formal owned executor and only emits independently assessed bindings', async () => {
  const { context, dependencies, events, calls } = runtime()
  const result = await runCostStageEvidenceClosure(context, dependencies)
  assert.equal(result.acceptanceComplete, true)
  assert.deepEqual(costStageEvidenceBindings(context.caseRecord), COST_STAGE_EVIDENCE_BINDINGS)
  assert.deepEqual(context.caseRecord.checks.map((row) => row.name), Object.values(COST_STAGE_EVIDENCE_CHECKS))
  assert.deepEqual(events, ['safety', 'prepare-owned', 'create-reviewer', 'logout', 'verify-page', 'cleanup-reviewer'])
  assert.equal(calls.filter(([method]) => method === 'PUT').length, 1)
  assert.equal(calls.filter(([method, endpoint]) =>
    method === 'POST' && endpoint.endsWith('source-snapshot/purchase/refresh')).length, 2)
  assert.equal(context.caseRecord.database.length, 13)
  const closure = context.caseRecord.fixtures.costStageEvidence
  assert.equal(closure.observations.length, 9)
  assert.doesNotMatch(JSON.stringify(closure.observations), /offline-(?:operator|reviewer)-secret/)
  assert.ok(context.caseRecord.fixtures.costStageExecution.checks.length > 0)
})

test('current contract gaps remain partial with no successful catalog bindings', async () => {
  const { context, dependencies } = runtime({ missingCollect: true, missingLevels: true, rejectReplay: true })
  const result = await runCostStageEvidenceClosure(context, dependencies)
  assert.equal(result.partial, true)
  assert.deepEqual(costStageEvidenceBindings(context.caseRecord), {})
  assert.equal(context.caseRecord.checks.length, 0)
  assert.ok(context.caseRecord.gaps.some((gap) => gap.code === 'COLLECT_SAVE_HAS_NO_STAGE_RECORDER'))
  assert.equal(context.caseRecord.gaps.filter((gap) => gap.assertionIndex === 3).length, 3)
  assert.ok(context.caseRecord.fixtures.costScenario)
})

test('disabled controlled writes do not touch API, browser, SQL or preparers', async () => {
  const { context, dependencies, events, calls } = runtime()
  dependencies.writeFixtures = false
  const result = await runCostStageEvidenceClosure(context, dependencies)
  assert.equal(result.partial, true)
  assert.deepEqual(events, [])
  assert.deepEqual(calls, [])
  assert.equal(context.caseRecord.gaps[0].code, 'CONTROLLED_WRITE_DISABLED')
})

test('unsafe targets and preexisting scenarios stop before preparation or writes', async (t) => {
  for (const mutation of [
    (run) => { run.dependencies.settings = { ...settings, tenantId: '2' } },
    (run) => { run.dependencies.settings = { ...settings, apiBase: 'http://example.com:48083' } },
    (run) => { run.context.caseRecord.fixtures = { costScenario: clone(run.input.fixture) } }
  ]) await t.test(mutation.toString(), async () => {
    const run = runtime()
    mutation(run)
    await assert.rejects(() => runCostStageEvidenceClosure(run.context, run.dependencies))
    assert.deepEqual(run.events, [])
    assert.deepEqual(run.calls, [])
  })
})

test('standalone preparer cannot bypass local write safety by skipping the closure entry', async () => {
  const run = runtime()
  await assert.rejects(() => prepareCostStageEvidenceFixture(run.context, {
    settings, writeFixtures: false
  }), /BLOCKED/)
  await assert.rejects(() => prepareCostStageEvidenceFixture(run.context, {
    settings, writeFixtures: true,
    async assertLocalWriteSafety () { throw new Error('offline database gate rejected') }
  }), /database gate rejected/)
  assert.deepEqual(run.calls, [])
})

test('cleanup failure cannot retain successful top-level checks or bindings', async () => {
  const run = runtime()
  run.dependencies.cleanupReviewer = async () => { throw new Error('offline cleanup failure') }
  await assert.rejects(() => runCostStageEvidenceClosure(run.context, run.dependencies), /cleanup failure/)
  assert.deepEqual(costStageEvidenceBindings(run.context.caseRecord), {})
  assert.equal(run.context.caseRecord.checks.length, 0)
  assert.equal(run.context.caseRecord.fixtures.costScenario.periodId, '101')
  assert.equal(run.context.caseRecord.fixtures.costStageExecution.cleanupComplete, undefined)
})

test('entry awaits page verification before publishing acceptance', async () => {
  const run = runtime()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const original = run.dependencies.verifyPage
  run.dependencies.verifyPage = async () => { await gate; return original() }
  let settled = false
  const executing = runCostStageEvidenceClosure(run.context, run.dependencies)
    .then((result) => { settled = true; return result })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(run.context.caseRecord.checks.length, 0)
  release()
  assert.equal((await executing).acceptanceComplete, true)
})

test('bindings require matching scope, cleanup and named passing checks, not proof flags alone', async () => {
  const run = runtime()
  await runCostStageEvidenceClosure(run.context, run.dependencies)
  for (const mutation of [
    (record) => { record.caseId = 'COST-012' },
    (record) => { record.fixtures.costStageEvidence.runId = 'stale' },
    (record) => { record.fixtures.costStageEvidence.periodId = '999' },
    (record) => { record.fixtures.costStageEvidence.cleanupComplete = false },
    (record) => { record.checks = [] }
  ]) {
    const record = clone(run.context.caseRecord)
    mutation(record)
    assert.deepEqual(costStageEvidenceBindings(record), {})
  }
})

const browserDouble = ({
  writeRequest = false, brokenSecondPage = false, checkboxStartsChecked = false,
  checkboxDoesNotToggle = false, passOnly = false
} = {}) => {
  const input = evidence({ missingCollect: passOnly, missingLevels: passOnly })
  const hits = input.closure.history.at(-1).hits
  const listeners = new Set()
  const screenshots = []
  const interactions = []
  let includeClosed = checkboxStartsChecked
  let offset = 0
  const visible = () => (includeClosed ? hits : hits.filter(pending)).slice(offset, offset + 8)
    .map((row) => ({ ...identity(row), id: String(row.id) }))
  const checkbox = {
    async isChecked () {
      interactions.push({ action: 'checked', value: includeClosed })
      return includeClosed
    },
    async check () { assert.fail('Element Plus native input is hidden') },
    async click () { assert.fail('Element Plus native input is hidden') }
  }
  const includeClosedLabel = {
    locator (selector) {
      assert.equal(selector, 'input[type="checkbox"]')
      return checkbox
    },
    getByText (text, options) {
      assert.equal(text, '包含通过及已关闭')
      assert.deepEqual(options, { exact: true })
      return {
        async click (options) {
          assert.equal(options, undefined, 'visible label clicks must use normal actionability checks')
          interactions.push({ action: 'label-click' })
          if (!checkboxDoesNotToggle) includeClosed = !includeClosed
        }
      }
    }
  }
  const root = {
    async getAttribute (name) {
      return { 'data-error': '', 'data-period-id': '101',
        'data-blocking-count': String(hits.filter((row) => row.level === 'BLOCK' && pending(row)).length),
        'data-warning-count': String(hits.filter((row) => row.level === 'WARN' && pending(row)).length) }[name]
    },
    locator (selector) {
      if (selector === '[data-rule-hit-id]') return {
        async evaluateAll () { return clone(visible()) }
      }
      if (selector === '.el-checkbox[data-testid="cost-rule-include-closed"]') return includeClosedLabel
      assert.equal(selector, '.el-pagination .btn-next')
      return {
        async click () {
          assert.equal(includeClosed, true, 'pagination requires a genuinely checked input')
          interactions.push({ action: 'next-page' })
          if (!brokenSecondPage) offset += 8
        }
      }
    },
    getByRole (role, { name }) {
      assert.equal(role, 'checkbox')
      assert.equal(name, '包含通过及已关闭')
      return checkbox
    }
  }
  const page = {
    on (event, listener) { assert.equal(event, 'request'); listeners.add(listener) },
    off (event, listener) { assert.equal(event, 'request'); listeners.delete(listener) },
    locator (selector) { assert.equal(selector, '.exception-workspace'); return root },
    async waitForFunction (fn, { periodId, ids }, options) {
      assert.equal(typeof fn, 'function')
      assert.equal(periodId, '101')
      assert.equal(options.timeout, 30000)
      assert.deepEqual(visible().map((row) => row.id), ids)
    }
  }
  const dependencies = {
    async openRoute (currentPage, route, options) {
      assert.equal(currentPage, page)
      assert.equal(route, '/cost-management/monthly/exception-queue?periodId=101')
      assert.match(options.readySelector, /data-loaded="true"/)
      for (const listener of listeners) {
        listener({ url: () => 'http://127.0.0.1:48083/admin-api/cost/periods/101/rule-hits', method: () => 'GET' })
        if (writeRequest) listener({
          url: () => 'http://127.0.0.1:48083/admin-api/cost/workspace', method: () => 'PUT'
        })
      }
    },
    async saveScreenshot (page, dir, name) { screenshots.push({ dir, name }) }
  }
  return { context: { page, hits, fixture: input.fixture, record: {}, outputDir: os.tmpdir() },
    dependencies, listeners, screenshots, interactions }
}

test('page verifier clicks visible label, verifies checked input and reads all four exact pages', async () => {
  const run = browserDouble()
  const proof = await verifyCostStageEvidencePage(run.context, run.dependencies)
  assert.deepEqual(proof.allVisible, run.context.hits.map(identity))
  assert.equal(proof.defaultVisible.length, 1)
  assert.equal(proof.defaultVisible[0].level, 'WARN')
  assert.equal(proof.blocking, 0)
  assert.equal(proof.warning, 1)
  assert.deepEqual(run.interactions, [
    { action: 'checked', value: false },
    { action: 'label-click' },
    { action: 'checked', value: true },
    { action: 'next-page' },
    { action: 'next-page' },
    { action: 'next-page' }
  ])
  assert.equal(run.screenshots.length, 4)
  assert.equal(run.listeners.size, 0)
})

test('page verifier rejects a visible label click that does not check the native input before pagination', async () => {
  const run = browserDouble({ checkboxDoesNotToggle: true })
  await assert.rejects(() => verifyCostStageEvidencePage(run.context, run.dependencies),
    /点击可见标签后必须真实选中/)
  assert.deepEqual(run.interactions, [
    { action: 'checked', value: false },
    { action: 'label-click' },
    { action: 'checked', value: false }
  ])
  assert.equal(run.screenshots.length, 0)
  assert.equal(run.listeners.size, 0)
})

test('page verifier rejects a checked default filter before clicking or paginating even with an empty pending queue', async () => {
  const run = browserDouble({ checkboxStartsChecked: true })
  run.context.hits.splice(0)
  await assert.rejects(() => verifyCostStageEvidencePage(run.context, run.dependencies),
    /默认队列不得勾选/)
  assert.deepEqual(run.interactions, [{ action: 'checked', value: true }])
  assert.equal(run.screenshots.length, 0)
  assert.equal(run.listeners.size, 0)
})

test('page verifier compares safe numeric API IDs against exact DOM strings across all pages', async () => {
  const run = browserDouble()
  for (const hit of run.context.hits) hit.id = Number(hit.id)
  const proof = await verifyCostStageEvidencePage(run.context, run.dependencies)
  assert.deepEqual(proof.allVisible, run.context.hits.map((row) => ({ ...identity(row), id: String(row.id) })))
  assert.equal(run.screenshots.length, 4)
  assert.equal(run.listeners.size, 0)
})

test('page verifier handles r44-shaped 28 PASS rows, empty default queue and a partial final page', async () => {
  const run = browserDouble({ passOnly: true })
  for (const hit of run.context.hits) hit.id = Number(hit.id)
  const proof = await verifyCostStageEvidencePage(run.context, run.dependencies)
  assert.deepEqual(proof.defaultVisible, [])
  assert.equal(proof.blocking, 0)
  assert.equal(proof.warning, 0)
  assert.equal(proof.allVisible.length, 28)
  assert.deepEqual(proof.allVisible, run.context.hits.map((row) => ({ ...identity(row), id: String(row.id) })))
  assert.equal(run.screenshots.length, 4)
  assert.equal(run.interactions.filter((row) => row.action === 'next-page').length, 3)
  assert.equal(run.listeners.size, 0)
})

test('assessment reconciles safe numeric rule API IDs without changing fixture IDs or SQL strings', () => {
  const input = evidence()
  for (const state of input.closure.history) {
    for (const hit of state.hits) {
      hit.id = Number(hit.id)
      hit.periodId = Number(hit.periodId)
    }
  }
  assert.equal(assessCostStageEvidence(input).complete, true)
})

test('r44-shaped numeric API identities keep missing collect, rejected replays and missing levels as GAP', () => {
  const input = evidence({ missingCollect: true, missingLevels: true, rejectReplay: true })
  for (const state of input.closure.history) {
    for (const hit of state.hits) {
      hit.id = Number(hit.id)
      hit.periodId = Number(hit.periodId)
    }
  }
  const result = assessCostStageEvidence(input)
  assert.equal(result.complete, false)
  assert.deepEqual(result.proofs, { stages: false, evidence: false, queue: false, replay: false })
  for (const code of ['STAGE_PASS_EVIDENCE_MISSING', 'STAGE_EVIDENCE_CHAIN_INCOMPLETE',
    'COLLECT_SAVE_HAS_NO_STAGE_RECORDER', 'STAGE_REPLAY_REJECTED_试算', 'STAGE_REPLAY_REJECTED_确认',
    'STAGE_REPLAY_REJECTED_发布', 'REAL_BLOCK_WARN_SAMPLES_MISSING']) {
    assert.ok(result.gaps.some((gap) => gap.code === code), code)
  }
})

test('assessment rejects lossy, noncanonical or foreign rule API identities', async (t) => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1, '001', '9223372036854775808', '999']) {
    for (const field of ['id', 'periodId']) await t.test(`${field}=${value}`, () => {
      const input = evidence()
      input.closure.history.at(-1).hits[0][field] = value
      assert.throws(() => assessCostStageEvidence(input))
    })
  }
})

test('page verifier rejects unsafe numeric API IDs instead of comparing rounded DOM text', async () => {
  const run = browserDouble()
  run.context.hits[0].id = Number.MAX_SAFE_INTEGER + 1
  await assert.rejects(() => verifyCostStageEvidencePage(run.context, run.dependencies), /精确字符串ID/)
  assert.equal(run.screenshots.length, 0)
  assert.equal(run.listeners.size, 0)
})

test('page verifier rejects later-page drift and unexpected writes and always removes listeners', async (t) => {
  for (const option of [{ brokenSecondPage: true }, { writeRequest: true }]) {
    await t.test(JSON.stringify(option), async () => {
      const run = browserDouble(option)
      await assert.rejects(() => verifyCostStageEvidencePage(run.context, run.dependencies))
      assert.equal(run.listeners.size, 0)
    })
  }
})
