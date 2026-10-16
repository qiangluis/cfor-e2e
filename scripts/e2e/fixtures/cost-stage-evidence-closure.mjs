import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'
import {
  assertCostStageCollectDatabase,
  assertCostRuleStageTarget,
  COST_STAGE_RULES,
  inspectCostRuleStages,
  prepareCostRuleStageFixture,
  runCostRuleStageClosure
} from './cost-rule-stage-closure.mjs'
import { assertPurchaseReceipt, assertPurchaseConfirmed } from './cost-purchase-source-closure.mjs'

export const COST_STAGE_EVIDENCE_CHECKS = Object.freeze({
  stages: 'COST-034 专属期间四阶段当次执行均有完整PASS/CLOSED证据',
  evidence: 'COST-034 规则模型ID版本及来源快照哈希试算哈希发布批次API/SQL一致',
  queue: 'COST-034 真实三等级队列分页优先级与PASS排除统计页面一致',
  replay: 'COST-034 四阶段同请求成功重放且规则主键数量及业务身份不变'
})
export const COST_STAGE_EVIDENCE_BINDINGS = Object.freeze(Object.fromEntries(
  Object.values(COST_STAGE_EVIDENCE_CHECKS).map((name, index) => [index, Object.freeze([name])])
))

// These are observation points in the shared executor, not simulated stages.
const frames = Object.freeze({
  取数: [0, 1, 2], 试算: [3, 4, 5], 确认: [6, 7, 8], 发布: [9, 10, 11]
})
const replayRejections = Object.freeze({
  试算: { code: 422001, message: 'Only accounting periods can start a trial; roll back the current trial or publication first' },
  确认: { code: 409003, message: '同一 requestId 已用于不同输入，拒绝覆盖原请求' },
  发布: { code: 422001, message: '只有已确认试算的期间可以发布正式成本' }
})
const rank = Object.freeze({ BLOCK: 0, WARN: 1, PASS: 2 })
const requireFact = (condition, message) => {
  if (!condition) throw new Error(`COST-034: ${message}`)
}
const exactId = (value) => {
  requireFact(typeof value === 'string' && /^[1-9]\d*$/.test(value) &&
    BigInt(value) <= 9223372036854775807n, '缺少精确字符串ID')
  return value
}
const apiId = (value) => exactId(Number.isSafeInteger(value) ? String(value) : value)
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const identity = ({ id, level, status }) => ({ id: apiId(id), level, status })
const pending = (row) => ['BLOCK', 'WARN'].includes(row.level) && row.status === 'OPEN'
const successful = (response) => response?.code === 0 && response.success !== false && response.data != null
const digest = (tokens) => createHash('sha256')
  .update(tokens.slice().sort().map((token) => `${token}|`).join('')).digest('hex')

const assertOwned = (fixture, runId) => {
  requireFact(fixture?.caseId === 'COST-034' && fixture.runId === runId && Boolean(runId) &&
    fixture.tenantId === '1' && fixture.scenario === 'rule-stage' &&
    /^22\d{2}-(0[1-9]|1[0-2])$/.test(fixture.month) &&
    /^E2E-C034-[A-F0-9]{12}$/.test(fixture.versionNo) &&
    fixture.versionNo === `E2E-C034-${fixture.suffix}` &&
    fixture.remark === `CFOR-E2E:costScenario:rule-stage:${runId}:${fixture.suffix}:tenant=1:org=1:month=${fixture.month}`,
  '拒绝共享、历史或其他用例的成本场景')
  exactId(fixture.modelId)
  exactId(fixture.periodId)
}

const stageOf = (method, endpoint) => {
  if (method === 'PUT' && /^\/cost\/periods\/\d+\/source-snapshot$/.test(endpoint)) return '取数'
  if (method !== 'POST') return null
  if (/^\/cost\/periods\/\d+\/source-snapshot\/purchase\/refresh$/.test(endpoint)) return '取数'
  if (/^\/cost\/periods\/\d+\/trials$/.test(endpoint)) return '试算'
  if (/^\/cost\/trials\/\d+\/confirm$/.test(endpoint)) return '确认'
  if (/^\/cost\/periods\/\d+\/publications$/.test(endpoint)) return '发布'
  return null
}

// Keep only business inputs. Never retain login tokens or unrelated user APIs.
const observeApi = (api, actor, observations) => new Proxy(api, {
  get (target, property) {
    const original = target[property]
    if (typeof original !== 'function') return original
    if (!['putBusiness', 'postBusiness', 'post'].includes(property)) return original.bind(target)
    return async (endpoint, body, options) => {
      const method = property === 'putBusiness' ? 'PUT' : 'POST'
      const stage = stageOf(method, endpoint)
      const observation = stage && {
        stage, actor, method, endpoint, body: structuredClone(body),
        headers: Object.fromEntries(['X-Request-Id', 'X-Input-Hash', 'If-Match']
          .filter((name) => options?.headers?.[name] !== undefined)
          .map((name) => [name, options.headers[name]]))
      }
      const response = await original.call(target, endpoint, body, options)
      if (observation) observations.push({ ...observation, response: structuredClone(response) })
      return response
    }
  }
})

export async function prepareCostStageEvidenceFixture (context, dependencies = {}) {
  assertCostRuleStageTarget(context, {
    settings: dependencies.settings || config,
    writeFixtures: dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
  })
  requireFact(!context.caseRecord.fixtures?.costScenario, '必须在通用cost-scenario准备之前接入')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(context.caseRecord)
  const fixture = await prepareCostRuleStageFixture(context)
  assertOwned(fixture, context.record.runId)
  return fixture
}

export async function verifyCostStageEvidencePage (
  { page, fixture, hits, record, outputDir }, dependencies = {}
) {
  const requests = []
  const listener = (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/cost/')) requests.push({ pathname, method: request.method() })
  }
  const waitForRows = async (expected) => page.waitForFunction(({ periodId, ids }) => {
    const root = document.querySelector(`.exception-workspace[data-period-id="${periodId}"]`)
    return root && JSON.stringify(Array.from(root.querySelectorAll('[data-rule-hit-id]'))
      .map((element) => element.dataset.ruleHitId)) === JSON.stringify(ids)
  }, { periodId: fixture.periodId, ids: expected.map((row) => row.id) }, { timeout: 30000 })
  page.on('request', listener)
  try {
    await (dependencies.openRoute || openRoute)(page,
      `/cost-management/monthly/exception-queue?periodId=${fixture.periodId}`, {
        readySelector: `.exception-workspace[data-period-id="${fixture.periodId}"][data-loaded="true"]`,
        retries: 1
      })
    const root = page.locator('.exception-workspace')
    requireFact(await root.getAttribute('data-error') === '', '正式规则页面读取失败')
    assert.equal(await root.getAttribute('data-period-id'), fixture.periodId)
    const readRows = () => root.locator('[data-rule-hit-id]').evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.dataset.ruleHitId, level: element.dataset.level, status: element.dataset.status
      })))
    const defaultExpected = hits.filter(pending).slice(0, 8).map(identity)
    await waitForRows(defaultExpected)
    const defaultVisible = await readRows()
    assert.deepEqual(defaultVisible, defaultExpected)
    const blocking = hits.filter((row) => row.level === 'BLOCK' && pending(row)).length
    const warning = hits.filter((row) => row.level === 'WARN' && pending(row)).length
    assert.equal(await root.getAttribute('data-blocking-count'), String(blocking))
    assert.equal(await root.getAttribute('data-warning-count'), String(warning))
    const includeClosed = root.locator('.el-checkbox[data-testid="cost-rule-include-closed"]')
    const checkbox = includeClosed.locator('input[type="checkbox"]')
    assert.equal(await checkbox.isChecked(), false, '默认队列不得勾选包含通过及已关闭')
    await includeClosed.getByText('包含通过及已关闭', { exact: true }).click()
    assert.equal(await checkbox.isChecked(), true, '点击可见标签后必须真实选中包含通过及已关闭')
    const allVisible = []
    fs.mkdirSync(outputDir, { recursive: true })
    for (let offset = 0; offset < hits.length; offset += 8) {
      const expected = hits.slice(offset, offset + 8).map(identity)
      await waitForRows(expected)
      const visible = await readRows()
      assert.deepEqual(visible, expected)
      allVisible.push(...visible)
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir,
        `cost034-stage-evidence-${offset / 8 + 1}`, record)
      if (offset + 8 < hits.length) {
        await root.locator('.el-pagination .btn-next').click()
      }
    }
    requireFact(requests.some((row) => row.method === 'GET' &&
      row.pathname === `/admin-api/cost/periods/${fixture.periodId}/rule-hits`),
    '页面未读取正式规则API')
    requireFact(requests.every((row) => ['GET', 'HEAD', 'OPTIONS'].includes(row.method)),
      '只读规则页面发起了成本写请求')
    return { passed: true, periodId: fixture.periodId, blocking, warning,
      defaultVisible, allVisible, requests }
  } finally {
    page.off('request', listener)
  }
}

export function assessCostStageEvidence ({ fixture, closure, observations, runId }) {
  assertOwned(fixture, runId)
  requireFact(closure?.caseId === 'COST-034' && closure.runId === runId &&
    closure.tenantId === '1' && closure.periodId === fixture.periodId &&
    closure.cleanupComplete === true, '闭环归属或复核账号清理证据不完整')
  const proofs = { stages: false, evidence: false, queue: false, replay: false }
  const gaps = []
  const gap = (assertionIndex, code, details) => gaps.push({ assertionIndex, code, details })
  requireFact(closure.history?.length === 13, '缺少四阶段执行前后完整观测，不能使用最终快照代替')
  const { source, trace } = closure
  const collectSource = closure.collectSource || source
  if (closure.collectSource) {
    const draft = observations.find((row) => row.stage === '取数' && row.method === 'POST' &&
      row.endpoint === `/cost/periods/${fixture.periodId}/source-snapshot/purchase/refresh`)?.response?.data
    requireFact(closure.collectPreparation?.available === true, '缺少正式采购取数前置')
    assertPurchaseReceipt(draft, fixture, closure.collectPreparation.receipt,
      closure.collectPreparation.wms || { wmsId: fixture.wmsReceiptId, entryId: fixture.wmsReceiptEntryId })
    assertPurchaseConfirmed(collectSource, fixture, draft)
    requireFact(collectSource.id !== source.id && collectSource.lines.length === 1 &&
      typeof collectSource.lines[0].sourceVersion === 'string' && collectSource.lines[0].sourceVersion.length > 0,
    '独立采购取数缺少精确来源版本或与生产快照混用')
  }
  requireFact(source?.status === 'CONFIRMED' && source.periodId === fixture.periodId &&
    source.snapshotKey === 'DEFAULT' && source.versionNo === fixture.versionNo && sha(source.snapshotHash) &&
    source.lines?.length === 1 && source.lines[0].sourceVersion === '1',
  '来源快照身份版本或哈希缺失')
  exactId(source.id)
  requireFact(trace?.periodId === fixture.periodId && trace.publicationId === closure.publicationId &&
    trace.batchNo === closure.batchNo && /^PUB-/.test(trace.batchNo) && sha(trace.resultHash) &&
    trace.status === 'PUBLISHED', '缺少同期间正式发布证据')
  exactId(closure.trialId)
  exactId(closure.publicationId)
  for (const state of closure.history) {
    requireFact(state.period.id === fixture.periodId &&
      state.period.modelVersionId === fixture.modelId && state.period.modelVersionNo === fixture.versionNo &&
      state.period.period === fixture.month && String(state.period.accountingOrgId) === '1' &&
      state.period.enterpriseType === 'MANUFACTURING', '执行过程中期间归属改变')
    requireFact(Array.isArray(state.database) && Array.isArray(state.hits), '缺少真实API/SQL观测')
    const apiHits = state.hits.map((row) => {
      requireFact(apiId(row.periodId) === fixture.periodId && row.ruleVersion === fixture.modelId &&
        Object.hasOwn(rank, row.level) && (row.level !== 'PASS' || row.status === 'CLOSED'),
      '规则版本必须为模型ID，且PASS必须CLOSED')
      return [apiId(row.id), apiId(row.periodId), row.ruleCode, row.ruleVersion, row.level, row.status, row.basis]
    }).sort((a, b) => BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)
    requireFact(new Set(apiHits.map((row) => row[0])).size === apiHits.length, '规则主键重复')
    assert.deepEqual(state.database.filter((row) => row[0] === 'hit').map((row) => row.slice(1)), apiHits)
  }
  const initial = closure.history[0]
  requireFact(initial.period.status === 'ACCOUNTING' && initial.hits.length === 0 &&
    !initial.database.some((row) => ['snapshot', 'trial', 'publication'].includes(row[0])),
  '拒绝已执行或共享期间')
  const final = closure.history.at(-1)
  requireFact(final.period.status === 'COST_PUBLISHED' && final.period.currentTrialId === closure.trialId &&
    final.period.currentPublicationId === closure.publicationId, '期间未引用本轮正式试算发布')
  assert.deepEqual(final.database.filter((row) => row[0] === 'snapshot'),
    [source, ...(closure.collectSource ? [collectSource] : [])]
      .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
      .map((row) => ['snapshot', row.id, row.snapshotKey, row.versionNo, row.snapshotHash, 'CONFIRMED']))
  if (closure.collectSource) {
    for (const index of [1, 2, 3, 12]) {
      assertCostStageCollectDatabase(closure.history[index], index < 3 ? {
        ...collectSource, status: 'DRAFT'
      } : collectSource)
    }
  }
  const trials = final.database.filter((row) => row[0] === 'trial')
  requireFact(trials.length === 1 && trials[0][1] === closure.trialId &&
    trials[0][2] === trace.resultHash && trials[0][3] === 'CONFIRMED' &&
    exactId(trials[0][4]) !== exactId(trials[0][5]), '缺少独立人工确认或同试算哈希SQL证据')
  const hashes = final.database.filter((row) => row[0] === 'hash').map((row) => row[1])
  requireFact(hashes.length === (closure.collectSource ? 2 : 1) && hashes.every(sha) &&
    hashes.includes(source.snapshotHash) && hashes.includes(collectSource.snapshotHash),
    '缺少已确认来源快照真实哈希，禁止本地构造替代')
  const sourceSnapshotHash = digest(hashes)
  assert.deepEqual(final.database.filter((row) => row[0] === 'publication'), [
    ['publication', closure.publicationId, closure.trialId, trace.resultHash,
      closure.batchNo, 'PUBLISHED', sourceSnapshotHash]
  ])
  assert.equal(trace.sourceSnapshotHash, sourceSnapshotHash)
  const sourceLine = source.lines[0]
  requireFact(trace.sources?.length === 1 && String(trace.sources[0].sourceSnapshotId) === source.id &&
    trace.sources[0].sourceModule === sourceLine.sourceModule &&
    trace.sources[0].sourceType === sourceLine.sourceType &&
    trace.sources[0].sourceId === sourceLine.sourceId &&
    trace.sources[0].sourceBusinessLineId === sourceLine.sourceLineId &&
    trace.sources[0].sourceVersion === sourceLine.sourceVersion &&
    Number(trace.sources[0].amount) === Number(sourceLine.laborAmount),
  '正式发布来源业务身份、版本或金额与已确认快照不一致')

  const inspect = (hits) => inspectCostRuleStages(hits, fixture, collectSource, trace.resultHash, trace.batchNo)
  const inspected = inspect(final.hits)
  requireFact(inspected.invalid.length === 0, `阶段证据错误：${JSON.stringify(inspected.invalid)}`)
  const missing = [...inspected.missing]
  let replayComplete = true
  for (const [stage, [before, first, repeated]] of Object.entries(frames)) {
    const firstState = closure.history[first]
    const firstStage = inspect(firstState.hits)
    requireFact(firstStage.invalid.length === 0, '当次执行出现错误阶段证据')
    requireFact(inspect(closure.history[before].hits).stageRows[stage].length === 0,
      `${stage}执行前已有相同证据，不能使用历史记录`)
    const current = firstStage.stageRows[stage]
    if (current.length !== COST_STAGE_RULES[stage].length) {
      missing.push({ stage, reason: '执行成功当时没有完整规则记录' })
    }
    assert.deepEqual(inspected.stageRows[stage], current)
    assert.deepEqual(closure.history[repeated], firstState)
    const attempts = observations.filter((row) => row.stage === stage &&
      (stage !== '取数' || row.method === (closure.collectSource ? 'POST' : 'PUT')))
    requireFact(attempts.length === 2, `${stage}缺少两次真实API调用`)
    const [original, retry] = attempts
    assert.deepEqual({ ...retry, response: null }, { ...original, response: null })
    requireFact(original.actor === (stage === '取数' || stage === '试算' ? 'operator' : 'reviewer') &&
      original.endpoint === (stage === '确认' ? `/cost/trials/${closure.trialId}/confirm` :
        `/cost/periods/${fixture.periodId}/${stage === '取数' ? `source-snapshot${closure.collectSource ? '/purchase/refresh' : ''}` :
          stage === '试算' ? 'trials' : 'publications'}`) &&
      original.method === (stage === '取数' && !closure.collectSource ? 'PUT' : 'POST') &&
      successful(original.response),
    `${stage}调用不属于本轮正式业务身份`)
    if (stage !== '取数') {
      requireFact(typeof original.headers['X-Request-Id'] === 'string' &&
        original.headers['X-Request-Id'].length > 0 && /^\d+$/.test(original.headers['If-Match']),
      '工作流重放必须保留原requestId和If-Match')
      const result = original.response.data
      requireFact(result.periodId === fixture.periodId && result.trialId === closure.trialId &&
        result.resultHash === trace.resultHash, '工作流响应不属于同一期间试算及结果哈希')
      if (stage === '试算') assert.deepEqual(original.body, {
        enterpriseType: 'MANUFACTURING', periodId: fixture.periodId, modelVersion: fixture.versionNo
      })
      if (stage === '发布') requireFact(result.publicationId === closure.publicationId &&
        result.batchNo === trace.batchNo, '发布响应的正式批次身份不符')
    } else {
      if (closure.collectSource) {
        assert.equal(original.body, undefined, '采购取数必须由正式ERP来源生成，不能提交人工来源行')
        assert.deepEqual(original.headers, {})
      } else requireFact(original.body.snapshotKey === source.snapshotKey &&
        original.body.versionNo === source.versionNo, '来源重放改变快照键版本')
      for (const field of ['id', 'periodId', 'snapshotKey', 'versionNo', 'snapshotHash']) {
        assert.equal(original.response.data[field], collectSource[field])
      }
      if (closure.collectSource) {
        assertPurchaseReceipt(original.response.data, fixture, closure.collectPreparation.receipt,
          closure.collectPreparation.wms || { wmsId: fixture.wmsReceiptId, entryId: fixture.wmsReceiptEntryId })
        assertPurchaseConfirmed(collectSource, fixture, original.response.data)
      }
    }
    if (successful(retry.response)) assert.deepEqual(retry.response.data, original.response.data)
    else {
      requireFact(replayRejections[stage] &&
        matchesExpectedBusinessRejection(retry.response, replayRejections[stage]), '重放出现非既定业务失败')
      replayComplete = false
      gap(3, `STAGE_REPLAY_REJECTED_${stage}`, retry.response)
    }
  }
  if (!closure.collectSource) {
    missing.push({ stage: '取数', reason: '人工PUT未调用正式collect入口，不得用其他阶段的PASS补证' })
    replayComplete = false
  }
  if (missing.length) {
    gap(0, 'STAGE_PASS_EVIDENCE_MISSING', missing)
    gap(1, 'STAGE_EVIDENCE_CHAIN_INCOMPLETE', missing)
    if (!closure.collectSource) gap(0, 'COLLECT_SAVE_HAS_NO_STAGE_RECORDER', {
      entry: 'CostSourceSnapshotServiceImpl.save/confirm',
      availableCollectEntries: ['source-snapshot/purchase/refresh', 'source-snapshot/outsource/refresh'],
      reason: '正式人工草稿保存/确认未调用recordCollectStage；未建立本轮专属ERP/MES取数时不伪造取数PASS',
      preparation: closure.collectPreparation
    })
  } else {
    proofs.stages = true
    proofs.evidence = true
    proofs.replay = replayComplete
  }
  for (let index = 1; index < final.hits.length; index++) {
    const left = final.hits[index - 1]
    const right = final.hits[index]
    requireFact(rank[left.level] < rank[right.level] ||
      (left.level === right.level && BigInt(left.id) > BigInt(right.id)),
    '正式API未按BLOCK/WARN/PASS、同等级ID倒序展示')
  }
  const blocking = final.hits.filter((row) => row.level === 'BLOCK' && pending(row)).length
  const warning = final.hits.filter((row) => row.level === 'WARN' && pending(row)).length
  assert.deepEqual(final.database.filter((row) => row[0] === 'blocking'), [['blocking', String(blocking)]])
  const page = closure.page
  if (!page?.passed || !Array.isArray(page.allVisible) || !Array.isArray(page.defaultVisible) ||
    !Array.isArray(page.requests)) gap(2, 'PAGE_EVIDENCE_MISSING', '缺少正式页面完整分页/默认过滤/请求证据')
  else {
    assert.equal(page.periodId, fixture.periodId)
    assert.equal(page.blocking, blocking)
    assert.equal(page.warning, warning)
    assert.deepEqual(page.defaultVisible, final.hits.filter(pending).slice(0, 8).map(identity))
    assert.deepEqual(page.allVisible, final.hits.map(identity))
    requireFact(page.requests.some((row) => row.method === 'GET' &&
      row.pathname === `/admin-api/cost/periods/${fixture.periodId}/rule-hits`) &&
      page.requests.every((row) => ['GET', 'HEAD', 'OPTIONS'].includes(row.method)),
    '页面必须读取正式规则API且不能写入成本')
    const observed = [...new Set(final.hits.map((row) => row.level))]
    if (Object.keys(rank).every((level) => observed.includes(level))) proofs.queue = true
    else gap(2, 'REAL_BLOCK_WARN_SAMPLES_MISSING', {
      observed, reason: '无正式WARN触发链和本轮真实三等级样本，不能以空集合证明优先级',
      productEntry: 'CostWorkflowServiceImpl.recordCalculationFailure只登记BLOCK；CostRuleStageEvaluator明确排除未实现的CV/CW/PRICE-ESTIMATE；配置规则或handle不会生成WARN',
      blockedRecovery: '锁定模型和已确认来源不可改写；不能用handle备注替代真实规则条件修复'
    })
  }
  return { proofs, gaps, complete: Object.values(proofs).every(Boolean),
    stages: inspected.stageRows, sourceSnapshotHash }
}

export async function runCostStageEvidenceClosure (context, dependencies = {}) {
  const { record, caseRecord } = context
  caseRecord.fixtures ||= {}
  caseRecord.notes ||= []
  caseRecord.checks ||= []
  const addGap = (gap) => {
    caseRecord.gaps ||= []
    caseRecord.gaps.push({ ...gap, caseId: 'COST-034', status: 'GAP' })
    caseRecord.notes.push(`COST-034 GAP ${gap.code}: ${JSON.stringify(gap.details)}`)
  }
  const writeFixtures = dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
  if (writeFixtures !== true) {
    addGap({ assertionIndex: 0, code: 'CONTROLLED_WRITE_DISABLED', details: '未执行四阶段，不能按只读历史记录通过' })
    return { acceptanceComplete: false, partial: true }
  }
  assertCostRuleStageTarget(context, { settings: dependencies.settings || config, writeFixtures })
  requireFact(!caseRecord.fixtures.costScenario && !caseRecord.fixtures.costStageEvidence &&
    !caseRecord.fixtures.costRuleStage, '拒绝复用已准备的共享/完成态场景，须在通用prepare之前接入')
  const observations = []
  const scoped = { ...caseRecord, fixtures: {}, notes: [], checks: [], gaps: [], database: [] }
  try {
    await runCostRuleStageClosure({ ...context, caseRecord: scoped,
      api: observeApi(context.api, 'operator', observations) }, {
      ...dependencies, writeFixtures,
      prepareFixture: async (input) => {
        const fixture = await (dependencies.prepareFixture
          ? dependencies.prepareFixture(input)
          : prepareCostStageEvidenceFixture(input, { ...dependencies, writeFixtures }))
        assertOwned(fixture, record.runId)
        return fixture
      },
      verifyPage: dependencies.verifyPage || verifyCostStageEvidencePage,
      createApiClient: (input) => observeApi(
        (dependencies.createApiClient || createApiClient)(input), 'reviewer', observations)
    })
    const closure = scoped.fixtures.costRuleStage
    const fixture = scoped.fixtures.costScenario
    const assessment = assessCostStageEvidence({ fixture, closure, observations, runId: record.runId })
    caseRecord.fixtures.costStageEvidence = { ...closure, ...assessment, observations }
    for (const [key, name] of Object.entries(COST_STAGE_EVIDENCE_CHECKS)) {
      if (assessment.proofs[key]) caseRecord.checks.push({
        name, passed: true, details: JSON.stringify({
          runId: record.runId, periodId: fixture.periodId,
          evidence: key === 'stages' ? assessment.stages : key === 'queue' ? closure.page :
            key === 'replay' ? observations : { source: closure.source, trace: closure.trace }
        })
      })
    }
    assessment.gaps.forEach(addGap)
    return { acceptanceComplete: assessment.complete, partial: !assessment.complete,
      note: assessment.complete ? 'COST-034四阶段严格证据完成' : 'COST-034正式契约/真实样本仍有GAP，未降低原断言' }
  } finally {
    if (scoped.fixtures.costScenario) caseRecord.fixtures.costScenario = scoped.fixtures.costScenario
    caseRecord.fixtures.costStageExecution = {
      ...scoped.fixtures.costRuleStage, observations, checks: scoped.checks, gaps: scoped.gaps
    }
    caseRecord.notes.push(...scoped.notes)
    caseRecord.database ||= []
    caseRecord.database.push(...scoped.database)
  }
}

export function costStageEvidenceBindings (caseRecord) {
  const closure = caseRecord?.fixtures?.costStageEvidence
  const fixture = caseRecord?.fixtures?.costScenario
  if (caseRecord?.id !== 'COST-034' || caseRecord?.caseId !== 'COST-034' ||
    closure?.caseId !== 'COST-034' || !closure.runId || closure.runId !== fixture?.runId ||
    closure.tenantId !== '1' || fixture?.tenantId !== '1' || fixture.caseId !== 'COST-034' ||
    closure.periodId !== fixture.periodId || closure.cleanupComplete !== true) return {}
  return Object.fromEntries(Object.keys(COST_STAGE_EVIDENCE_CHECKS).flatMap((key, index) =>
    closure.proofs?.[key] === true && caseRecord.checks?.some((row) =>
      row.name === COST_STAGE_EVIDENCE_CHECKS[key] && row.passed === true)
      ? [[index, COST_STAGE_EVIDENCE_BINDINGS[index]]] : []))
}
