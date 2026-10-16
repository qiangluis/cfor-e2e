import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { loginWithCredentials, observePage, openRoute, saveScreenshot } from '../lib/browser.mjs'
import {
  loginAs, prepareCostScenario, prepareCostWorkflowReviewers, resetCostScenarioCache
} from './cost-scenario.mjs'

export const COST_WORKFLOW_CHECKS = Object.freeze({
  headers: 'COST-003 X-Request-Id 生效且 X-Input-Hash 不匹配精确拒绝并保持正式期间不变',
  replay: 'COST-003 相同 requestId 重放原结果且不同输入不得覆盖首次请求',
  version: 'COST-003 If-Match 版本冲突精确拒绝且期间与试算状态不变'
})

export const COST_SEPARATION_CHECKS = Object.freeze({
  creator: 'COST-023 专属试算执行人精确绑定当前账号及数据库 creator',
  selfConfirm: 'COST-023 同人确认精确拒绝且专属期间与试算完整事实不变',
  maintainer: 'COST-023 独立主体重算后模型维护人确认精确拒绝且期间试算与模型事实不变',
  publicationRequest: 'COST-023 正式发布人发起回退及反月结精确拒绝且审批与正式事实不变',
  operatingConfirm: 'COST-023 专属经营计算执行人自确认精确拒绝且独立复核状态与事实可追溯',
  operatingRollback: 'COST-023 专属经营发布人自回退精确拒绝且独立回退保留全部经营对象事实',
  publicationActors: 'COST-023 正式发布人不能审批自己发布批次的回退及反月结且正式事实不变'
})

export const COST_APPROVAL_CHECKS = Object.freeze({
  pending: 'COST-028 回退和反月结申请仅创建或重放待审批单且正式事实不变',
  binding: 'COST-028 审批单精确绑定专属期间批次原因版本哈希与申请人',
  actors: 'COST-028 申请人与发布人分离且申请人和发布人均不能审批',
  execution: 'COST-028 独立审批人执行回退与反月结且撤回驳回不改变正式事实',
  unique: 'COST-028 同一正式批次仅有一条待审批申请且不同请求精确拒绝'
})

export const COST_APPROVAL_PAGE_CHECKS = Object.freeze({
  strip: 'COST-028 真实正式期间审批条常驻政策与动作批次申请人原因精确回显',
  dialogs: 'COST-028 真实通过驳回撤回影响弹窗及执行后果确认门禁并由页面执行六次决策'
})

export const COST_OUTBOX_CHECKS = Object.freeze({
  query: 'COST-004 正式 Outbox 死信查询接口返回结构化列表',
  fields: 'COST-004 正式死信包含幂等、重试、失败摘要和人工审计字段',
  owned: 'COST-004 本轮期间可靠事件的请求号幂等键载荷哈希与请求台账审计精确关联',
  replay: 'COST-004 同请求回放不重复入箱且业务拒绝不遗留请求或重试事件',
  manualGate: 'COST-004 本轮非死信事件重放和人工终止精确拒绝且全字段不变',
  page: 'COST-004 真实页面显式选择本轮模型期间且正式事实不变',
  blocked: 'COST-004 同事务入箱、指数退避和人工审计闭环证据边界明确记录为 BLOCKED'
})

export const COST_OUTBOX_TRIGGER_ENTRIES = Object.freeze([
  Object.freeze({
    method: 'POST',
    path: '/cost/periods',
    permission: 'cost:period:create',
    action: 'PERIOD_CREATE'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/periods/{periodId}/trials',
    permission: 'cost:trial:run',
    action: 'TRIAL_RUN'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/trials/{trialId}/confirm',
    permission: 'cost:trial:confirm',
    action: 'TRIAL_CONFIRM'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/trials/{trialId}/rollback',
    permission: 'cost:trial:rollback',
    action: 'TRIAL_ROLLBACK'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/periods/{periodId}/publications',
    permission: 'cost:publication:publish',
    action: 'PUBLICATION_PUBLISH'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/publications/{publicationId}/rollback',
    permission: 'cost:publication:rollback',
    action: 'PUBLICATION_ROLLBACK'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/periods/{periodId}/publications/reopen',
    permission: 'cost:publication:reopen',
    action: 'PUBLICATION_REOPEN'
  })
])

export const COST_OUTBOX_MANAGEMENT_ENTRIES = Object.freeze([
  Object.freeze({
    method: 'GET',
    path: '/cost/outbox/dead-letters?limit=100',
    permission: 'cost:outbox:query'
  }),
  Object.freeze({
    method: 'GET',
    path: '/cost/outbox/{id}',
    permission: 'cost:outbox:query'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/outbox/dispatch?batchSize=50',
    permission: 'cost:outbox:handle'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/outbox/{id}/retry',
    permission: 'cost:outbox:handle'
  }),
  Object.freeze({
    method: 'POST',
    path: '/cost/outbox/{id}/complete',
    permission: 'cost:outbox:handle'
  })
])

export const COST_OUTBOX_RUNTIME_GAPS = Object.freeze([
  '没有在本轮正式状态变更事务中制造失败，因此不能声称同事务入箱回滚已被 E2E 证明',
  '没有通过正式调度失败链取得连续 retryCount/nextRetryTime 快照，因此不能声称指数退避已被 E2E 证明',
  '没有通过正式 retry/complete 写接口取得人工操作后的回读，因此不能声称死信人工审计闭环已被 E2E 证明'
])

export const costActionHash = (values) => createHash('sha256')
  .update(values.filter(Boolean).sort().map((value) => `${value}|`).join('')).digest('hex')

// Publication approval uses ordered tokens, unlike the workflow digest.
export const costApprovalHash = (values) => createHash('sha256')
  .update(values.join('|')).digest('hex')

// The operating service hashes the JSON array directly, unlike the sorted
// pipe-terminated cost workflow digest.
export const costOperatingHash = (values) => createHash('sha256')
  .update(JSON.stringify(values)).digest('hex')

// Approval decisions also write cost_audit_log.request_id (varchar(64)).
export const costDecisionRequestId = ({ runId, approvalId, action, note }) =>
  `cost-${action}-${createHash('sha256')
    .update(JSON.stringify([runId, approvalId, action, note])).digest('hex').slice(0, 32)}`

export const costOutboxRetryDelaySeconds = (
  retryCount,
  { baseSeconds = 30, capSeconds = 3600 } = {}
) => {
  if (!Number.isInteger(retryCount) || retryCount < 1) {
    throw new TypeError('retryCount must be a positive integer')
  }
  if (!Number.isInteger(baseSeconds) || baseSeconds < 1 ||
      !Number.isInteger(capSeconds) || capSeconds < baseSeconds) {
    throw new TypeError('invalid retry delay bounds')
  }
  return Math.min(capSeconds, baseSeconds * (2 ** Math.min(retryCount - 1, 6)))
}

export const inspectCostOutboxRows = (rows) => {
  const invalid = []
  if (!Array.isArray(rows)) {
    return { valid: false, count: 0, invalid: ['死信接口 data 不是数组'], rows: [] }
  }
  rows.forEach((row, index) => {
    const prefix = `row[${index}]`
    const requiredTextFields = [
      'id', 'periodId', 'action', 'requestId', 'eventKey',
      'payloadHash', 'nextRetryTime', 'lastError'
    ]
    for (const field of requiredTextFields) {
      if (String(row?.[field] ?? '').trim() === '') invalid.push(`${prefix}.${field} 缺失`)
    }
    if (String(row?.status ?? '') !== 'DEAD') invalid.push(`${prefix}.status 不是 DEAD`)
    if (!Number.isInteger(row?.retryCount) || row.retryCount < 1) {
      invalid.push(`${prefix}.retryCount 无效`)
    }
    if (!Number.isInteger(row?.maxRetry) || row.maxRetry < 1) {
      invalid.push(`${prefix}.maxRetry 无效`)
    }
    if (!/^[a-f0-9]{64}$/.test(String(row?.payloadHash ?? ''))) {
      invalid.push(`${prefix}.payloadHash 不是 SHA-256`)
    }
    for (const field of ['manualOperator', 'manualAt', 'manualNote']) {
      if (!Object.prototype.hasOwnProperty.call(row || {}, field)) {
        invalid.push(`${prefix}.${field} 缺少人工审计字段`)
      }
    }
  })
  return { valid: invalid.length === 0, count: rows.length, invalid, rows }
}

const addOutboxCheck = (caseRecord, name, passed, details) => {
  const check = { name, passed: Boolean(passed), details: String(details ?? '') }
  caseRecord.checks = [...(caseRecord.checks || []), check]
  return check
}

export async function runCostOutboxClosure ({ api, record, caseRecord, dependencies = {}, page, outputDir }) {
  if (record && (dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true')) {
    return runOwnedCostOutboxClosure({ api, record, caseRecord, dependencies, page, outputDir })
  }
  const response = await api.getBusiness('/cost/outbox/dead-letters?limit=100')
  const rows = response?.data
  const inspected = inspectCostOutboxRows(rows)
  addOutboxCheck(
    caseRecord,
    COST_OUTBOX_CHECKS.query,
    inspected.valid,
    `rows=${inspected.count}; invalid=${inspected.invalid.join('|') || 'none'}`
  )
  if (!inspected.valid) {
    throw new Error(`${COST_OUTBOX_CHECKS.query}: ${inspected.invalid.join('；')}`)
  }
  if (inspected.count > 0) {
    addOutboxCheck(
      caseRecord,
      COST_OUTBOX_CHECKS.fields,
      true,
      `validated=${inspected.count}; status=DEAD; auditFields=manualOperator,manualAt,manualNote`
    )
  }
  const gap = {
    status: 'BLOCKED',
    caseId: 'COST-004',
    reasons: [...COST_OUTBOX_RUNTIME_GAPS],
    observedDeadLetters: inspected.count
  }
  caseRecord.gaps = [...(caseRecord.gaps || []), gap]
  caseRecord.notes = [
    ...(caseRecord.notes || []),
    `COST-004 BLOCKED：${JSON.stringify(gap)}`
  ]
  caseRecord.evidence = [
    ...(caseRecord.evidence || []),
    `COST-004 正式入口：${JSON.stringify({
      triggerEntries: COST_OUTBOX_TRIGGER_ENTRIES,
      managementEntries: COST_OUTBOX_MANAGEMENT_ENTRIES,
      retryDelay: 'Math.min(3600, 30 * 2 ** Math.min(retryCount - 1, 6))'
    })}`
  ]
  addOutboxCheck(
    caseRecord,
    COST_OUTBOX_CHECKS.blocked,
    true,
    `status=BLOCKED; observedDeadLetters=${inspected.count}; ` +
      `gaps=${COST_OUTBOX_RUNTIME_GAPS.join('；')}`
  )
  return { ...gap, inspected }
}

export async function runCostWorkflowClosure ({ api, record, caseRecord }) {
  const fixture = caseRecord.fixtures?.costScenario
  if (fixture?.runId !== record.runId || fixture.tenantId !== '1' ||
      !fixture.currentTrialId) {
    throw new Error('COST-003 缺少本轮专属待复核试算')
  }
  const periodPath = `/cost/periods/${fixture.periodId}`
  const before = (await api.getBusiness(periodPath)).data
  const trialPath = `${periodPath}/trials/current`
  const trialBefore = (await api.getBusiness(trialPath)).data
  const unchanged = async () =>
    JSON.stringify((await api.getBusiness(periodPath)).data) === JSON.stringify(before) &&
    JSON.stringify((await api.getBusiness(trialPath)).data) === JSON.stringify(trialBefore)
  const add = (name, passed, details) => {
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
    if (!passed) throw new Error(`${name}: ${details}`)
  }
  const requestId = `e2e-contract-${record.runId}-${fixture.suffix}`
  const payload = {
    accountingOrgId: 1, period: fixture.month,
    enterpriseType: 'MANUFACTURING', modelVersion: fixture.versionNo,
    requestId: 'body-must-not-win'
  }
  const options = { headers: { 'X-Request-Id': requestId } }
  const first = (await api.postBusiness('/cost/periods', payload, options)).data
  const replay = (await api.postBusiness('/cost/periods', payload, options)).data
  const differentInput = await api.post('/cost/periods', {
    ...payload, enterpriseType: 'TRADE'
  }, { ...options, expectedBusinessRejection: {
    code: 409003, message: '同一 requestId 已用于不同输入，拒绝覆盖原请求'
  } })
  add(COST_WORKFLOW_CHECKS.replay,
    first.requestId === requestId && JSON.stringify(first) === JSON.stringify(replay) &&
    matchesExpectedBusinessRejection(differentInput, {
      code: 409003, message: '同一 requestId 已用于不同输入，拒绝覆盖原请求'
    }) && await unchanged(),
  `period=${fixture.periodId}; requestId=${first.requestId}; changedInputCode=${differentInput.code}`)
  const confirmPath = `/cost/trials/${fixture.currentTrialId}/confirm`
  const invalidHash = await api.request('POST', confirmPath, undefined, {
    headers: {
      'X-Request-Id': `${requestId}-hash`,
      'X-Input-Hash': 'INVALID_E2E_HASH', 'If-Match': String(before.version)
    },
    expectedBusinessRejection: { code: 409003, message: '输入哈希已变化，请刷新成本期间后重试' }
  })
  add(COST_WORKFLOW_CHECKS.headers,
    matchesExpectedBusinessRejection(invalidHash, {
      code: 409003, message: '输入哈希已变化，请刷新成本期间后重试'
    }) && await unchanged(),
  `X-Request-Id=${first.requestId}; code=${invalidHash.code}; unchanged=true`)
  const correctHash = costActionHash([
    'TRIAL_CONFIRM', fixture.currentTrialId, trialBefore.resultHash, String(before.version)
  ])
  const staleVersion = Number(before.version) + 100
  const conflict = await api.request('POST', confirmPath, undefined, {
    headers: {
      'X-Request-Id': `${requestId}-version`, 'X-Input-Hash': correctHash,
      'If-Match': String(staleVersion)
    },
    expectedBusinessRejection: {
      code: 409003,
      message: `期间版本已变化，If-Match=${staleVersion}，当前版本=${before.version}`
    }
  })
  add(COST_WORKFLOW_CHECKS.version,
    matchesExpectedBusinessRejection(conflict, {
      code: 409003,
      message: `期间版本已变化，If-Match=${staleVersion}，当前版本=${before.version}`
    }) && await unchanged(),
  `period=${fixture.periodId}; trial=${fixture.currentTrialId}; code=${conflict.code}; unchanged=true`)
}

const requireClosureFact = (condition, message) => {
  if (!condition) throw new Error(`BLOCKED: cost workflow closure ${message}`)
}
const exactWorkflowId = (value) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  requireClosureFact(/^[1-9]\d*$/.test(text) && BigInt(text) <= 9223372036854775807n, 'imprecise ID')
  return text
}
const closureData = (response) => {
  requireClosureFact(response?.code === 0 && response.data != null, 'missing successful business data')
  return response.data
}
const closureCheck = (caseRecord, name, passed, details) => {
  caseRecord.checks.push({ name, passed: passed === true, details })
  requireClosureFact(passed === true, `${name}: ${details}`)
}
const readClosureDb = async (caseRecord, stage, sql, readSql) => {
  const result = await readSql(sql)
  requireClosureFact(result.available && Array.isArray(result.rows), `SQL evidence unavailable: ${stage}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, ...result }]
  return result.rows
}

async function ownedWorkflowPeriod ({ api, record, caseRecord, dependencies }) {
  const fixture = caseRecord.fixtures?.costScenario
  const settings = dependencies.config || config
  requireClosureFact((dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true') &&
    ['COST-004', 'COST-023', 'COST-028'].includes(caseRecord.id) && fixture?.caseId === caseRecord.id &&
    settings.target === 'local' && String(settings.tenantId) === '1' &&
    String(record.environment?.tenantId) === '1' && fixture?.tenantId === '1' &&
    fixture?.runId === record.runId && /^[A-Za-z0-9_-]+$/.test(record.runId) &&
    fixture.remark?.startsWith(`CFOR-E2E:costScenario:${fixture.scenario}:${record.runId}:`) &&
    /^22[0-5]\d-(0[1-9]|1[0-2])$/.test(fixture.month), 'not an owned far-future local tenant1 fixture')
  const periodId = exactWorkflowId(fixture.periodId)
  const modelId = exactWorkflowId(fixture.modelId)
  const model = closureData(await api.getBusiness(`/cost/model-versions/${modelId}`))
  const period = closureData(await api.getBusiness(`/cost/periods/${periodId}`))
  requireClosureFact(String(model.id) === modelId && model.remark === fixture.remark &&
    String(model.accountingOrgId) === '1' && model.versionNo === fixture.versionNo &&
    model.status === 'LOCKED' && model.effectiveMonth === fixture.month &&
    String(period.id) === periodId && String(period.accountingOrgId) === '1' &&
    String(period.modelVersionId) === modelId && period.modelVersionNo === fixture.versionNo &&
    period.period === fixture.month && Number.isInteger(period.version), 'persisted ownership drift')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  return { fixture, period, periodId }
}

async function verifyOwnedOutboxPeriodPage ({ page, fixture, record, caseRecord, outputDir }) {
  await openRoute(page, '/cost-management/monthly/opening-wip', {
    readySelector: '[data-testid="formal-opening-wip"]', retries: 1
  })
  const root = page.locator('[data-testid="formal-opening-wip"]')
  for (const [kind, id, attribute] of [
    ['model', fixture.modelId, 'data-model-id'],
    ['period', fixture.periodId, 'data-period-id']
  ]) {
    const selector = `[data-testid="opening-${kind}-select"]`
    await page.waitForFunction((selector) => {
      const input = document.querySelector(`${selector} input`)
      return input && !input.disabled
    }, selector)
    await root.locator(selector).click()
    const option = page.locator(`.el-select-dropdown:visible [${attribute}="${id}"]`)
    await option.first().waitFor({ state: 'visible' })
    requireClosureFact(await option.count() === 1, `owned ${kind} option missing or ambiguous`)
    await option.click()
  }
  await page.waitForFunction((periodId) => {
    const root = document.querySelector('[data-testid="formal-opening-wip"]')
    return root?.dataset.loaded === 'true' && root.dataset.periodId === periodId &&
      root.dataset.error === ''
  }, fixture.periodId)
  const observation = await root.evaluate((element) => ({
    modelId: element.dataset.modelId, versionNo: element.dataset.modelVersion,
    periodId: element.dataset.periodId, month: element.dataset.month,
    status: element.dataset.periodStatus,
    text: element.querySelector('.opening-context-strip')?.textContent || ''
  }))
  requireClosureFact(observation.modelId === fixture.modelId &&
    observation.versionNo === fixture.versionNo && observation.periodId === fixture.periodId &&
    observation.month === fixture.month && observation.status === 'ACCOUNTING' &&
    [fixture.versionNo, fixture.month, fixture.periodId].every((value) => observation.text.includes(value)),
  'owned period did not render its real model/month/ID/status')
  await saveScreenshot(page, outputDir, 'cost004-owned-period', record)
  caseRecord.costOutboxPage = observation
}

async function runOwnedCostOutboxClosure ({ api, record, caseRecord, dependencies, page, outputDir }) {
  const settings = dependencies.config || config
  requireClosureFact(caseRecord.id === 'COST-004' && settings.target === 'local' &&
    String(settings.tenantId) === '1' && String(record.environment?.tenantId) === '1' &&
    /^[A-Za-z0-9_-]+$/.test(record.runId), 'outbox requires the owned local tenant1 run')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  // The accounting scenario creates only model/period prerequisites, never
  // inventory, source snapshots, trials or synthetic delivery failures.
  requireClosureFact(!caseRecord.fixtures?.costScenario, 'outbox must allocate a fresh scenario')
  const resetScenarioCache = dependencies.resetCostScenarioCache || resetCostScenarioCache
  resetScenarioCache()
  try {
    await (dependencies.prepareCostScenario || prepareCostScenario)({
      api, record, caseRecord, scenario: 'accounting'
    }, { assertLocalWriteSafety: dependencies.assertLocalWriteSafety || assertLocalWriteSafety })
  } finally {
    // Other COST cases must never inherit this case's accounting fixture.
    resetScenarioCache()
  }
  const { fixture, period, periodId } = await ownedWorkflowPeriod({ api, record, caseRecord, dependencies })
  requireClosureFact(fixture.scenario === 'accounting' && period.status === 'ACCOUNTING' &&
    period.version === 0 && period.currentTrialId == null && period.currentPublicationId == null,
  'outbox period has unexpected workflow facts')
  const readSql = dependencies.runReadOnlySql || runReadOnlySql
  const check = (name, passed, details) => {
    addOutboxCheck(caseRecord, name, passed, details)
    if (!passed) throw new Error(`${name}: ${details}`)
  }
  const outboxRows = await readClosureDb(caseRecord, 'cost004-owned-event', `
    SELECT id,CAST(period_id AS CHAR),action,request_id,event_key,payload_json,payload_hash,status,
      CAST(retry_count AS CHAR),CAST(max_retry AS CHAR)
    FROM cost_workflow_outbox
    WHERE tenant_id=1 AND period_id=${periodId} AND deleted=b'0' ORDER BY id`, readSql)
  requireClosureFact(outboxRows.length === 1, 'owned period must have exactly one real event')
  const [outboxId, outboxPeriod, action, requestId, eventKey, payloadJson, payloadHash, status, retryCount, maxRetry] = outboxRows[0]
  requireClosureFact(/^[A-Za-z0-9_-]{1,64}$/.test(outboxId) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(requestId) && outboxPeriod === periodId &&
    action === 'PERIOD_CREATE' && status === 'PENDING' && retryCount === '0' && maxRetry === '5',
  'owned newly enqueued event identity or initial retry state mismatch')
  const payload = JSON.parse(payloadJson)
  const eventPath = `/cost/outbox/${outboxId}`
  const event = closureData(await api.getBusiness(eventPath))
  const requests = await readClosureDb(caseRecord, 'cost004-request-audit-link', `
    SELECT request_id,action,input_hash,status,CAST(response_period_id AS CHAR),
      CAST(response_version AS CHAR),response_status
    FROM cost_workflow_request WHERE tenant_id=1 AND request_id='${requestId}' AND deleted=b'0';
    SELECT action,request_id,target_type,target_id
    FROM cost_audit_log WHERE tenant_id=1 AND period_id=${periodId} ORDER BY id`, readSql)
  const createBody = {
    accountingOrgId: 1, period: fixture.month,
    enterpriseType: period.enterpriseType, modelVersion: fixture.versionNo
  }
  check(COST_OUTBOX_CHECKS.owned,
    String(payload.periodId) === periodId && payload.requestId === requestId &&
    payload.status === 'ACCOUNTING' && payload.version === 0 &&
    eventKey === `${requestId}|PERIOD_CREATE|${periodId}` &&
    payloadHash === createHash('sha256').update(payloadJson).digest('hex') &&
    String(event.id) === outboxId && String(event.periodId) === periodId &&
    event.action === action && event.requestId === requestId && event.eventKey === eventKey &&
    event.payloadHash === payloadHash && event.payloadJson === payloadJson &&
    event.status === 'PENDING' && event.retryCount === 0 && event.maxRetry === 5 &&
    event.nextRetryTime != null && ['manualOperator', 'manualAt', 'manualNote'].every((key) =>
      Object.hasOwn(event, key) && event[key] == null) &&
    isDeepStrictEqual(requests, [
      [requestId, 'PERIOD_CREATE', costActionHash(['1', fixture.month, period.enterpriseType, fixture.versionNo]),
        'SUCCEEDED', periodId, '0', 'ACCOUNTING'],
      ['PERIOD_READY', requestId, 'PERIOD', periodId]
    ]),
  `period=${periodId}; outbox=${outboxId}; request=${requestId}; eventKey=${eventKey}; payloadHash=${payloadHash}`)
  const rejectedId = `cost004-reject-${createHash('sha256').update(record.runId).digest('hex').slice(0, 32)}`
  const factSql = `
    SELECT * FROM cost_period WHERE tenant_id=1 AND id=${periodId};
    SELECT * FROM cost_model_version WHERE tenant_id=1 AND id=${exactWorkflowId(fixture.modelId)};
    SELECT * FROM cost_workflow_outbox WHERE tenant_id=1 AND period_id=${periodId} ORDER BY id;
    SELECT * FROM cost_workflow_request WHERE tenant_id=1
      AND request_id IN ('${requestId}','${rejectedId}') ORDER BY id;
    SELECT * FROM cost_audit_log WHERE tenant_id=1 AND period_id=${periodId} ORDER BY id`
  const snapshot = async (stage) => ({
    period: closureData(await api.getBusiness(`/cost/periods/${periodId}`)),
    event: closureData(await api.getBusiness(eventPath)),
    rows: await readClosureDb(caseRecord, stage, factSql, readSql)
  })
  const before = await snapshot('cost004-before')
  requireClosureFact(isDeepStrictEqual(before.period, period) && isDeepStrictEqual(before.event, event),
    'owned facts changed before the negative checks')
  const original = closureData(await api.postBusiness('/cost/periods', createBody, {
    headers: { 'X-Request-Id': requestId }
  }))
  const replay = closureData(await api.postBusiness('/cost/periods', createBody, {
    headers: { 'X-Request-Id': requestId }
  }))
  const changedBody = { ...createBody, modelVersion: `${fixture.versionNo}-invalid` }
  const collision = { code: 409003, message: '同一 requestId 已用于不同输入，拒绝覆盖原请求' }
  const collisionResult = await api.post('/cost/periods', changedBody, {
    headers: { 'X-Request-Id': requestId }, expectedBusinessRejection: collision
  })
  const invalidModel = { code: 422001, message: '该核算期间已绑定其他模型版本，不能直接替换' }
  const invalidResult = await api.post('/cost/periods', changedBody, {
    headers: { 'X-Request-Id': rejectedId }, expectedBusinessRejection: invalidModel
  })
  check(COST_OUTBOX_CHECKS.replay,
    isDeepStrictEqual(original, payload) && isDeepStrictEqual(replay, payload) &&
    matchesExpectedBusinessRejection(collisionResult, collision) &&
    matchesExpectedBusinessRejection(invalidResult, invalidModel) &&
    isDeepStrictEqual(before, await snapshot('cost004-after-replay-and-business-rejection')),
  `outbox=${outboxId}; replayedRequest=${requestId}; rejectedRequest=${rejectedId}; codes=${collisionResult.code},${invalidResult.code}; unchanged=true`)
  const rejection = { code: 422003, message: '仅死信成本事件允许人工接管' }
  for (const action of ['retry', 'complete']) {
    const denied = await api.post(`${eventPath}/${action}`, {
      note: `COST-004 ${record.runId} non-DEAD ${action} must be rejected`
    }, { expectedBusinessRejection: rejection })
    check(`${COST_OUTBOX_CHECKS.manualGate} ${action}`,
      matchesExpectedBusinessRejection(denied, rejection) &&
        isDeepStrictEqual(before, await snapshot(`cost004-after-denied-${action}`)),
    `outbox=${outboxId}; status=PENDING; code=${denied.code}; unchanged=true`)
  }
  await (dependencies.verifyOwnedPeriodPage || verifyOwnedOutboxPeriodPage)({
    page, fixture, record, caseRecord, outputDir
  })
  check(COST_OUTBOX_CHECKS.page, isDeepStrictEqual(before, await snapshot('cost004-after-page')),
    `period=${periodId}; model=${fixture.modelId}; month=${fixture.month}; unchanged=true`)
  const dead = await api.getBusiness('/cost/outbox/dead-letters?limit=100')
  const inspected = inspectCostOutboxRows(dead?.data)
  check(COST_OUTBOX_CHECKS.query, dead?.code === 0 && inspected.valid,
    `rows=${inspected.count}; invalid=${inspected.invalid.join('|') || 'none'}`)
  if (inspected.count) check(COST_OUTBOX_CHECKS.fields, true, `validated=${inspected.count}; readOnly=true`)
  const queue = await readClosureDb(caseRecord, 'cost004-tenant-queue-read-only', `
    SELECT status,CAST(COUNT(*) AS CHAR),CAST(SUM(CASE WHEN period_id=${periodId} THEN 1 ELSE 0 END) AS CHAR)
    FROM cost_workflow_outbox WHERE tenant_id=1 AND deleted=b'0' GROUP BY status ORDER BY status`, readSql)
  const reasons = [
    ...COST_OUTBOX_RUNTIME_GAPS,
    '正式 dispatch 只支持租户级批量认领，不能限定本轮事件；本轮未调用、未启用任何全局 Job',
    '当前本地事件没有可供本轮安全触发的真实瞬态故障入口；未伪造 DEAD 或修改重试时间/次数'
  ]
  const gap = { caseId: 'COST-004', status: 'PARTIAL', reasons, observedDeadLetters: inspected.count }
  caseRecord.gaps = [...(caseRecord.gaps || []), gap]
  caseRecord.costOutboxClosure = {
    status: 'PARTIAL', periodId, modelId: fixture.modelId, outboxId, requestId, eventKey, payloadHash,
    dispatchInvoked: false, queue, reasons
  }
  caseRecord.notes.push(`COST-004 PARTIAL: ${reasons.join('；')}`)
  return gap
}

const trialFactSql = (periodId, trialId) => `
  SELECT * FROM cost_period WHERE tenant_id=1 AND id=${periodId};
  SELECT * FROM cost_trial WHERE tenant_id=1 AND id=${trialId} AND period_id=${periodId};
  SELECT * FROM cost_trial_object_result WHERE tenant_id=1 AND trial_id=${trialId} ORDER BY id`

const logoutWorkflowActor = async ({ client, userId, caseRecord, readSql, stage }) => {
  await client.postBusiness('/system/auth/logout')
  const rows = await readClosureDb(caseRecord, `${stage}-session-zero-${userId}`, `
    SELECT 'access',COUNT(*) FROM system_oauth2_access_token
      WHERE tenant_id=1 AND user_id=${userId} AND deleted=b'0'
    UNION ALL SELECT 'refresh',COUNT(*) FROM system_oauth2_refresh_token
      WHERE tenant_id=1 AND user_id=${userId} AND deleted=b'0'`, readSql)
  requireClosureFact(rows.length === 2 && rows[0][0] === 'access' &&
    rows[1][0] === 'refresh' && rows.every((row) => row[1] === '0'),
  'dedicated actor tokens not zero')
}

const loginWorkflowActor = async ({ key, fixture, record, caseRecord, dependencies, sessions, permissions, token: browserToken }) => {
  const userId = exactWorkflowId(fixture[`${key}UserId`])
  requireClosureFact(fixture[`${key}Username`] && fixture[`${key}Password`],
    `${key} credentials not registered`)
  const token = browserToken || await (dependencies.loginAs || loginAs)(
    record, fixture[`${key}Username`], fixture[`${key}Password`])
  const client = (dependencies.createApiClient || createApiClient)({ token, record })
  sessions.push({ client, userId })
  const info = closureData(await client.getBusiness('/system/auth/get-permission-info'))
  requireClosureFact(exactWorkflowId(info.user?.id) === userId &&
    Array.isArray(info.permissions) && permissions.every((permission) => info.permissions.includes(permission)) &&
    Array.isArray(info.roles) && !info.roles.includes('super_admin'),
  `${key} identity or existing permissions missing`)
  caseRecord.costWorkflowActors = {
    ...(caseRecord.costWorkflowActors || {}),
    [key]: { userId, roles: info.roles, permissions: info.permissions.filter((value) => value.startsWith('cost:')) }
  }
  return client
}

export async function runCostSeparationClosure ({
  api, actorApi = api, record, caseRecord, dependencies = {}
}) {
  requireClosureFact(caseRecord.id === 'COST-023', 'wrong separation case')
  const { fixture, period, periodId } = await ownedWorkflowPeriod({ api, record, caseRecord, dependencies })
  let trialId = exactWorkflowId(fixture.currentTrialId)
  const path = `/cost/periods/${periodId}/trials/current`
  const trial = closureData(await api.getBusiness(path))
  const operator = closureData(await api.getBusiness('/system/auth/get-permission-info'))
  requireClosureFact(period.status === 'TRIAL_PENDING' && String(period.currentTrialId) === trialId &&
    String(trial.periodId) === periodId && trial.status === 'PENDING' &&
    String(trial.creatorId) === exactWorkflowId(operator.user?.id) &&
    Array.isArray(trial.objects) && trial.objects.length > 0 && Number(trial.inputAmount) > 0,
  'pending trial was not executed by the current actor')
  const readSql = dependencies.runReadOnlySql || runReadOnlySql
  const identity = await readClosureDb(caseRecord, 'cost023-creator', `
    SELECT CAST(id AS CHAR),CAST(period_id AS CHAR),creator,trial_version,result_hash,status
      FROM cost_trial WHERE tenant_id=1 AND id=${trialId} AND period_id=${periodId} AND deleted=b'0'`, readSql)
  closureCheck(caseRecord, COST_SEPARATION_CHECKS.creator,
    identity.length === 1 && JSON.stringify(identity[0]) === JSON.stringify([
      trialId, periodId, String(trial.creatorId), trial.trialVersion, trial.resultHash, 'PENDING'
    ]), `period=${periodId}; trial=${trialId}; creator=${trial.creatorId}`)
  const sql = trialFactSql(periodId, trialId)
  const before = await readClosureDb(caseRecord, 'cost023-before', sql, readSql)
  requireClosureFact(before.length >= 3, 'missing period/trial/object database facts')
  const rejection = { code: 422001, message: '试算执行人与复核确认人不能相同' }
  const response = await api.request('POST', `/cost/trials/${trialId}/confirm`, undefined, {
    headers: { 'If-Match': String(period.version), 'X-Request-Id': `cost023-self-${record.runId}` },
    expectedBusinessRejection: rejection
  })
  const after = await readClosureDb(caseRecord, 'cost023-after', sql, readSql)
  closureCheck(caseRecord, COST_SEPARATION_CHECKS.selfConfirm,
    matchesExpectedBusinessRejection(response, rejection) &&
      JSON.stringify(closureData(await api.getBusiness(`/cost/periods/${periodId}`))) === JSON.stringify(period) &&
      JSON.stringify(closureData(await api.getBusiness(path))) === JSON.stringify(trial) &&
      JSON.stringify(before) === JSON.stringify(after),
    `period=${periodId}; trial=${trialId}; creator=${trial.creatorId}; code=${response.code}; unchanged=true`)
  await (dependencies.prepareCostWorkflowReviewers || prepareCostWorkflowReviewers)({
    api: actorApi, record, caseRecord
  })
  const sessions = []
  try {
    const executor = await loginWorkflowActor({
      key: 'approvalReviewer', fixture, record, caseRecord, dependencies, sessions,
      permissions: ['cost:trial:run']
    })
    const reviewer = await loginWorkflowActor({
      key: 'reviewer', fixture, record, caseRecord, dependencies, sessions,
      permissions: ['cost:trial:confirm', 'cost:publication:publish']
    })
    requireClosureFact(new Set([
      exactWorkflowId(operator.user?.id), exactWorkflowId(fixture.reviewerUserId),
      exactWorkflowId(fixture.approvalReviewerUserId)
    ]).size === 3, 'three distinct actors required before confirmation')
    const rolledBack = closureData(await api.postBusiness(`/cost/trials/${trialId}/rollback`, {
      reason: `COST-023 ${record.runId} independent model-maintainer check`
    }, { headers: { 'If-Match': String(period.version), 'X-Request-Id': `cost023-reset-${record.runId}` } }))
    const accounting = closureData(await api.getBusiness(`/cost/periods/${periodId}`))
    requireClosureFact(rolledBack.status === 'ACCOUNTING' && accounting.status === 'ACCOUNTING' &&
      accounting.currentTrialId == null && accounting.version === period.version + 1,
    'owned trial reset did not persist')
    const oldTrialId = trialId
    const rerun = closureData(await executor.postBusiness(`/cost/periods/${periodId}/trials`, {
      enterpriseType: accounting.enterpriseType,
      periodId,
      modelVersion: fixture.versionNo,
      requestId: `cost023-independent-${record.runId}`
    }, { headers: { 'If-Match': String(accounting.version) } }))
    const independentPeriod = closureData(await api.getBusiness(`/cost/periods/${periodId}`))
    trialId = exactWorkflowId(independentPeriod.currentTrialId)
    fixture.currentTrialId = trialId
    const independentTrial = closureData(await api.getBusiness(path))
    requireClosureFact(trialId !== oldTrialId && String(rerun.trialId) === trialId &&
      independentPeriod.status === 'TRIAL_PENDING' && independentTrial.status === 'PENDING' &&
      String(independentTrial.periodId) === periodId &&
      String(independentTrial.creatorId) === String(fixture.approvalReviewerUserId),
    'independent trial executor not persisted')
    const maintainerSql = `${trialFactSql(periodId, trialId)};
      SELECT * FROM cost_model_version WHERE tenant_id=1 AND id=${exactWorkflowId(fixture.modelId)};
      SELECT status,creator FROM cost_trial WHERE tenant_id=1 AND id=${oldTrialId}`
    const maintainerBefore = await readClosureDb(caseRecord, 'cost023-maintainer-before', maintainerSql, readSql)
    const modelCreator = await readClosureDb(caseRecord, 'cost023-model-creator', `
      SELECT CAST(id AS CHAR),creator FROM cost_model_version
        WHERE tenant_id=1 AND id=${exactWorkflowId(fixture.modelId)} AND deleted=b'0'`, readSql)
    requireClosureFact(modelCreator.length === 1 &&
      JSON.stringify(modelCreator[0]) === JSON.stringify([String(fixture.modelId), String(operator.user.id)]),
    'model maintainer not the tested admin actor')
    const maintainerRejection = { code: 422001, message: '模型维护人与试算复核人不能相同' }
    const maintainerDenied = await api.request('POST', `/cost/trials/${trialId}/confirm`, undefined, {
      headers: { 'If-Match': String(independentPeriod.version), 'X-Request-Id': `cost023-maintainer-${record.runId}` },
      expectedBusinessRejection: maintainerRejection
    })
    closureCheck(caseRecord, COST_SEPARATION_CHECKS.maintainer,
      matchesExpectedBusinessRejection(maintainerDenied, maintainerRejection) &&
        JSON.stringify(closureData(await api.getBusiness(`/cost/periods/${periodId}`))) === JSON.stringify(independentPeriod) &&
        JSON.stringify(closureData(await api.getBusiness(path))) === JSON.stringify(independentTrial) &&
        JSON.stringify(maintainerBefore) === JSON.stringify(
          await readClosureDb(caseRecord, 'cost023-maintainer-after', maintainerSql, readSql)),
      `model=${fixture.modelId}; maintainer=${operator.user.id}; trial=${trialId}; executor=${independentTrial.creatorId}; unchanged=true`)
    closureData(await reviewer.postBusiness(`/cost/trials/${trialId}/confirm`, undefined, {
      headers: { 'If-Match': String(independentPeriod.version), 'X-Request-Id': `cost023-confirm-${record.runId}` }
    }))
    const confirmed = closureData(await api.getBusiness(`/cost/periods/${periodId}`))
    requireClosureFact(confirmed.status === 'TRIAL_CONFIRMED' &&
      String(confirmed.currentTrialId) === trialId, 'independent confirmation not persisted')
    fixture.publicationId = exactWorkflowId(closureData(await reviewer.postBusiness(
      `/cost/periods/${periodId}/publications`, undefined, {
        headers: { 'If-Match': String(confirmed.version), 'X-Request-Id': `cost023-publish-${record.runId}` }
      })).publicationId)
    await (dependencies.runCostOperatingSeparationClosure || runCostOperatingSeparationClosure)({
      api, publisherApi: reviewer, record, caseRecord, dependencies,
      requester: String(operator.user.id), publisher: String(fixture.reviewerUserId)
    })
  } finally {
    for (const session of sessions) await logoutWorkflowActor({
      ...session, caseRecord, readSql, stage: 'cost023-publish'
    })
  }
  await runCostPublicationApprovalClosure({
    api, actorApi, record, caseRecord, dependencies, separationOnly: true
  })
}

export async function runCostOperatingSeparationClosure ({
  api, publisherApi, record, caseRecord, dependencies = {}, requester, publisher
}) {
  requireClosureFact(caseRecord.id === 'COST-023', 'wrong operating separation case')
  const { fixture, period, periodId } = await ownedWorkflowPeriod({ api, record, caseRecord, dependencies })
  const costPublicationId = exactWorkflowId(fixture.publicationId)
  const identities = await Promise.all([
    api.getBusiness('/system/auth/get-permission-info'),
    publisherApi.getBusiness('/system/auth/get-permission-info')
  ])
  requireClosureFact(exactWorkflowId(closureData(identities[0]).user?.id) === requester &&
    exactWorkflowId(closureData(identities[1]).user?.id) === publisher && requester !== publisher &&
    period.status === 'COST_PUBLISHED' && String(period.currentPublicationId) === costPublicationId &&
    period.currentOperatingPublicationId == null, 'operating actors or current cost ownership mismatch')
  const readSql = dependencies.runReadOnlySql || runReadOnlySql
  const periodPath = `/cost/periods/${periodId}`
  for (const direction of ['INCOME', 'EXPENSE']) {
    requireClosureFact((await api.getBusiness(`${periodPath}/operating-collections?direction=${direction}`)).data == null,
      'owned period already has operating collections')
    const amount = direction === 'INCOME' ? 2000 : 200
    closureData(await api.postBusiness(`${periodPath}/operating-collections/confirm`, {
      direction, rows: [{
        rowId: `E2E-${fixture.suffix}-${direction}`,
        itemCode: `E2E-${fixture.suffix}-${direction}`,
        itemName: `E2E职责分离${direction}`,
        direction, reportScope: direction === 'INCOME' ? '营业收入' : '经营费用',
        affectsProfit: true, sourceNo: `E2E-${fixture.suffix}-${direction}`,
        sourceType: 'MANUAL', sourceDate: `${fixture.month}-01`,
        department: `E2E-COST-SCENARIO-${fixture.suffix}`,
        originalAmount: amount, inclusionRate: 100, amount,
        status: 'CONFIRMED', note: fixture.remark,
        allocationBasis: direction === 'EXPENSE' ? 'MANUAL:1|E2E exclusive manual allocation' : null
      }]
    }, { headers: { 'If-Match': String(period.version), 'X-Request-Id': `cost023-op-${direction}-${record.runId}` } }))
    const collection = closureData(await api.getBusiness(`${periodPath}/operating-collections?direction=${direction}`))
    requireClosureFact(String(collection.periodId) === periodId && collection.status === 'CONFIRMED' &&
      String(collection.confirmedBy) === requester && collection.rowCount === 1 &&
      collection.rows?.[0]?.sourceNo === `E2E-${fixture.suffix}-${direction}` &&
      collection.rows[0].sourceType === 'MANUAL' && Number(collection.totalAmount) === amount,
    'owned manual operating collection did not persist')
  }
  closureData(await api.postBusiness(`${periodPath}/operating-calculation`, undefined, {
    headers: { 'If-Match': String(period.version), 'X-Request-Id': `cost023-opcalc-${record.runId}` }
  }))
  const calculation = closureData(await api.getBusiness(`${periodPath}/operating-calculation`))
  const operatingId = exactWorkflowId(calculation.id)
  fixture.operatingPublicationId = operatingId
  requireClosureFact(calculation.status === 'CALCULATED' && String(calculation.periodId) === periodId &&
    String(calculation.costPublicationId) === costPublicationId && calculation.rows?.length === 2 &&
    Number(calculation.revenue) === 2000 && Number(calculation.operatingExpense) === 200 &&
    Number(calculation.operatingProfit) === 1800, 'owned operating calculation empty or incorrect')
  const factSql = `
    SELECT * FROM cost_period WHERE tenant_id=1 AND id=${periodId};
    SELECT * FROM cost_operating_publication WHERE tenant_id=1 AND id=${operatingId} AND period_id=${periodId};
    SELECT * FROM cost_operating_object_fact WHERE tenant_id=1 AND publication_id=${operatingId} ORDER BY id;
    SELECT * FROM cost_operating_collection WHERE tenant_id=1 AND period_id=${periodId} ORDER BY id`
  const objectFactSql = `
    SELECT object_key,direction,item_code,item_name,report_scope,affects_profit,
      source_no,source_type,original_amount,inclusion_rate,amount,allocation_basis
    FROM cost_operating_object_fact
    WHERE tenant_id=1 AND publication_id=${operatingId} AND deleted=b'0' ORDER BY id`
  const snapshot = async (stage) => ({
    period: closureData(await api.getBusiness(periodPath)),
    calculation: (await api.getBusiness(`${periodPath}/operating-calculation`)).data,
    rows: await readClosureDb(caseRecord, stage, factSql, readSql),
    facts: await readClosureDb(caseRecord, `${stage}-object-facts`, objectFactSql, readSql)
  })
  const actorSql = `SELECT CAST(id AS CHAR),CAST(period_id AS CHAR),CAST(cost_publication_id AS CHAR),
      status,CAST(calculated_by AS CHAR),CAST(confirmed_by AS CHAR),CAST(published_by AS CHAR),
      CAST(rollback_by AS CHAR),calculated_at,confirmed_at,published_at,rollback_at
    FROM cost_operating_publication WHERE tenant_id=1 AND id=${operatingId} AND deleted=b'0'`
  const calculatedActors = await readClosureDb(caseRecord, 'cost023-operating-calculated-actor', actorSql, readSql)
  requireClosureFact(calculatedActors.length === 1 && calculatedActors[0][3] === 'CALCULATED' &&
    calculatedActors[0][4] === requester, 'persisted operating calculator not the denial actor')
  const beforeConfirm = await snapshot('cost023-operating-confirm-before')
  const confirmRejection = { code: 422001, message: '经营计算执行人与复核确认人不能相同' }
  const deniedConfirm = await api.request('POST', `/cost/operating-calculations/${operatingId}/confirm`, undefined, {
    headers: {
      'If-Match': String(period.version),
      'X-Input-Hash': calculation.resultHash,
      'X-Request-Id': `cost023-opself-${record.runId}`
    },
    expectedBusinessRejection: confirmRejection
  })
  requireClosureFact(matchesExpectedBusinessRejection(deniedConfirm, confirmRejection) &&
    JSON.stringify(beforeConfirm) === JSON.stringify(await snapshot('cost023-operating-confirm-after')),
  'self operating confirmation not precisely denied or changed facts')
  closureData(await publisherApi.postBusiness(`/cost/operating-calculations/${operatingId}/confirm`, undefined, {
    headers: {
      'If-Match': String(period.version),
      'X-Input-Hash': calculation.resultHash,
      'X-Request-Id': `cost023-opconfirm-${record.runId}`
    }
  }))
  const confirmedActors = await readClosureDb(caseRecord, 'cost023-operating-confirmed-actor', actorSql, readSql)
  closureCheck(caseRecord, COST_SEPARATION_CHECKS.operatingConfirm,
    confirmedActors.length === 1 && confirmedActors[0][3] === 'CONFIRMED' &&
      confirmedActors[0][4] === requester && confirmedActors[0][5] === publisher &&
      confirmedActors[0][8] !== 'NULL' && confirmedActors[0][9] !== 'NULL',
    `period=${periodId}; operating=${operatingId}; calculator=${requester}; confirmer=${publisher}; selfDenied=true`)
  closureData(await publisherApi.postBusiness(`${periodPath}/operating-publications`, undefined, {
    headers: {
      'If-Match': String(period.version),
      'X-Input-Hash': calculation.resultHash,
      'X-Request-Id': `cost023-oppublish-${record.runId}`
    }
  }))
  const beforeRollback = await snapshot('cost023-operating-rollback-before')
  const published = closureData(await api.getBusiness(`${periodPath}/operating-publication`))
  requireClosureFact(published.status === 'PUBLISHED' && String(published.id) === operatingId &&
    String(published.publishedBy) === publisher &&
    String(beforeRollback.period.currentOperatingPublicationId) === operatingId,
  'operating publisher binding not persisted')
  const reason = `COST-023 ${record.runId} owned operating rollback`
  const rollbackHash = costOperatingHash([beforeRollback.calculation.resultHash, reason])
  const rollbackRejection = { code: 422001, message: '经营发布人与回退操作人不能相同' }
  const deniedRollback = await publisherApi.request('POST', `/cost/operating-publications/${operatingId}/rollback`, {
    reason
  }, {
    headers: {
      'If-Match': String(beforeRollback.period.version),
      'X-Input-Hash': rollbackHash,
      'X-Request-Id': `cost023-oprollbackself-${record.runId}`
    },
    expectedBusinessRejection: rollbackRejection
  })
  requireClosureFact(matchesExpectedBusinessRejection(deniedRollback, rollbackRejection) &&
    JSON.stringify(beforeRollback) === JSON.stringify(await snapshot('cost023-operating-rollback-after')) &&
    JSON.stringify(published) === JSON.stringify(closureData(await api.getBusiness(`${periodPath}/operating-publication`))),
  'self operating rollback not precisely denied or changed facts')
  closureData(await api.postBusiness(`/cost/operating-publications/${operatingId}/rollback`, { reason }, {
    headers: {
      'If-Match': String(beforeRollback.period.version),
      'X-Input-Hash': rollbackHash,
      'X-Request-Id': `cost023-oprollback-${record.runId}`
    }
  }))
  const after = await snapshot('cost023-operating-independent-rollback')
  const rolledBackActors = await readClosureDb(caseRecord, 'cost023-operating-rollback-actor', actorSql, readSql)
  closureCheck(caseRecord, COST_SEPARATION_CHECKS.operatingRollback,
    after.period.currentOperatingPublicationId == null &&
      after.period.version === beforeRollback.period.version + 1 &&
      after.calculation == null &&
      JSON.stringify(after.facts) === JSON.stringify(beforeRollback.facts) &&
      rolledBackActors.length === 1 && JSON.stringify(rolledBackActors[0].slice(0, 8)) === JSON.stringify([
        operatingId, periodId, costPublicationId, 'ROLLED_BACK', requester, publisher, publisher, requester
      ]) && rolledBackActors[0][10] !== 'NULL' && rolledBackActors[0][11] !== 'NULL',
    `period=${periodId}; operating=${operatingId}; publisher=${publisher}; rollback=${requester}; selfDenied=true; historicalFactsPreserved=true`)
}

export async function runCostPublicationApprovalClosure ({
  api, actorApi = api, record, caseRecord, dependencies = {}, separationOnly = false,
  page, outputDir
}) {
  requireClosureFact(caseRecord.id === (separationOnly ? 'COST-023' : 'COST-028'), 'wrong approval case')
  const { fixture, period, periodId } = await ownedWorkflowPeriod({ api, record, caseRecord, dependencies })
  const readSql = dependencies.runReadOnlySql || runReadOnlySql
  const trialId = exactWorkflowId(fixture.currentTrialId)
  const firstPublicationId = exactWorkflowId(fixture.publicationId)
  requireClosureFact(period.status === 'COST_PUBLISHED' && String(period.currentTrialId) === trialId &&
    String(period.currentPublicationId) === firstPublicationId, 'not an owned current published trial')
  const requester = exactWorkflowId(closureData(
    await actorApi.getBusiness('/system/auth/get-permission-info')).user?.id)
  const publisher = exactWorkflowId(fixture.reviewerUserId)
  const approver = exactWorkflowId(fixture.approvalReviewerUserId)
  requireClosureFact(new Set([requester, publisher, approver]).size === 3 &&
    fixture.reviewerUsername && fixture.reviewerPassword &&
    fixture.approvalReviewerUsername && fixture.approvalReviewerPassword, 'three distinct registered actors required')
  const publicationActors = await readClosureDb(caseRecord, 'cost-workflow-publication-actors', `
    SELECT CAST(id AS CHAR),CAST(period_id AS CHAR),CAST(trial_id AS CHAR),CAST(published_by AS CHAR)
      FROM cost_publication WHERE tenant_id=1 AND id=${firstPublicationId} AND deleted=b'0'`, readSql)
  requireClosureFact(publicationActors.length === 1 &&
    JSON.stringify(publicationActors[0]) === JSON.stringify([firstPublicationId, periodId, trialId, publisher]),
  'persisted publication actor or trial binding mismatch')
  const tokens = []
  const sessions = []
  const browserContexts = []
  const pageEvidence = []
  let approvalPage
  const database = async (stage, sql) => readClosureDb(caseRecord, stage, sql, readSql)
  const actor = (key, permissions) => loginWorkflowActor({
    key, fixture, record, caseRecord, dependencies, sessions: tokens, permissions
  })
  let publicationId = firstPublicationId
  const activePath = `/cost/publication-approvals/periods/${periodId}/active`
  const active = async () => (await api.getBusiness(activePath)).data
  const snapshot = async (stage) => ({
    period: closureData(await api.getBusiness(`/cost/periods/${periodId}`)),
    trial: closureData(await api.getBusiness(`/cost/periods/${periodId}/trials/current`)),
    trace: closureData(await api.getBusiness(`/cost/publications/${publicationId}/trace`)),
    rows: await database(stage, `
      ${trialFactSql(periodId, trialId)};
      SELECT * FROM cost_publication WHERE tenant_id=1 AND id=${publicationId} AND period_id=${periodId};
      SELECT * FROM cost_publication_object_fact WHERE tenant_id=1 AND publication_id=${publicationId} ORDER BY id;
      SELECT * FROM cost_publication_component_fact WHERE tenant_id=1 AND publication_id=${publicationId} ORDER BY id;
      SELECT * FROM cost_publication_source_fact WHERE tenant_id=1 AND publication_id=${publicationId} ORDER BY id;
      SELECT * FROM cost_publication_allocation_fact WHERE tenant_id=1 AND publication_id=${publicationId} ORDER BY id`)
  })
  const identical = async (before, stage) =>
    JSON.stringify(before) === JSON.stringify(await snapshot(stage))
  const pendingIds = new Set()
  const decision = async (client, approval, action, body, rejection) => {
    const approvalId = exactWorkflowId(approval.id)
    requireClosureFact(pendingIds.has(approvalId), 'unregistered approval mutation')
    const current = await active()
    requireClosureFact(String(current?.id) === approvalId &&
      String(current.periodId) === periodId && String(current.publicationId) === publicationId &&
      current.status === 'PENDING', 'active approval ownership drift')
    return client.request('POST', `/cost/publication-approvals/${approvalId}/${action}`, body, {
      headers: {
        'If-Match': String(current.version),
        'X-Request-Id': costDecisionRequestId({ runId: record.runId, approvalId, action, note: body.note })
      },
      ...(rejection ? { expectedBusinessRejection: rejection } : {})
    })
  }
  const submit = async (actionType, suffix) => {
    const before = await snapshot(`cost028-${suffix}-before`)
    requireClosureFact(before.period.status === 'COST_PUBLISHED' &&
      String(before.period.currentPublicationId) === publicationId &&
      String(before.trace.publicationId) === publicationId && String(before.trace.periodId) === periodId &&
      ['components', 'sources', 'allocations'].every((key) =>
        Array.isArray(before.trace[key]) && before.trace[key].length > 0),
    'current publication changed or has empty formal facts')
    const reason = `COST-028 ${record.runId} ${suffix}`
    // COST-023 invokes this closure in separation-only mode before COST-028
    // runs in the same process. Keep request IDs distinct because the
    // approval idempotency contract is tenant-wide, not publication-scoped.
    const requestPrefix = separationOnly ? 'cost023' : 'cost028'
    const requestId = `${requestPrefix}-${record.runId}-${suffix}`
    const hash = costApprovalHash([actionType, publicationId, before.trace.resultHash, reason, String(before.period.version)])
    const path = actionType === 'ROLLBACK'
      ? `/cost/publications/${publicationId}/rollback`
      : `/cost/periods/${periodId}/publications/reopen`
    const options = { headers: {
      'X-Request-Id': requestId, 'X-Input-Hash': hash, 'If-Match': String(before.period.version)
    } }
    const first = closureData(await actorApi.postBusiness(path, { reason }, options))
    requireClosureFact(String(first.periodId) === periodId && String(first.publicationId) === publicationId,
      'submitted approval ownership mismatch')
    pendingIds.add(exactWorkflowId(first.approvalId))
    const approval = await active()
    const approvalId = exactWorkflowId(approval?.id)
    requireClosureFact(pendingIds.has(approvalId), 'active approval does not match submitted approval')
    const replay = closureData(await actorApi.postBusiness(path, { reason }, options))
    requireClosureFact(first.status === 'APPROVAL_PENDING' && first.approvalStatus === 'PENDING' &&
      String(first.approvalId) === approvalId && JSON.stringify(first) === JSON.stringify(replay) &&
      await identical(before, `cost028-${suffix}-pending`), 'request/replay changed formal facts')
    requireClosureFact(approval.actionType === actionType && approval.status === 'PENDING' &&
      String(approval.periodId) === periodId && String(approval.publicationId) === publicationId &&
      String(approval.requestedBy) === requester && approval.reason === reason &&
      approval.periodVersion === before.period.version && approval.batchNo === before.trace.batchNo &&
      approval.canApprove === false && approval.canWithdraw === true, 'approval binding mismatch')
    const bindingRows = await database(`cost028-${suffix}-binding`, `
      SELECT CAST(id AS CHAR),CAST(period_id AS CHAR),CAST(publication_id AS CHAR),
        action_type,status,reason,CAST(period_version AS CHAR),input_hash,request_id,
        CAST(requested_by AS CHAR)
      FROM cost_publication_approval WHERE tenant_id=1 AND id=${approvalId} AND deleted=b'0'`)
    requireClosureFact(bindingRows.length === 1 && JSON.stringify(bindingRows[0]) === JSON.stringify([
      approvalId, periodId, publicationId, actionType, 'PENDING', reason,
      String(before.period.version), hash, requestId, requester
    ]), 'persisted approval hash/request binding mismatch')
    const rejection = { code: 422001, message: '该正式批次已存在待审批申请，请先等待审批或撤回原申请' }
    const duplicate = await actorApi.post(path, { reason }, {
      headers: { ...options.headers, 'X-Request-Id': `${requestId}-other` },
      expectedBusinessRejection: rejection
    })
    const count = await database(`cost028-${suffix}-unique`, `
      SELECT COUNT(*) FROM cost_publication_approval WHERE tenant_id=1
        AND publication_id=${publicationId} AND status='PENDING' AND deleted=b'0'`)
    requireClosureFact(matchesExpectedBusinessRejection(duplicate, rejection) &&
      count.length === 1 && count[0][0] === '1' && await identical(before, `cost028-${suffix}-duplicate`),
    'unique pending approval not proven')
    sessions.push({ actionType, approvalId, publicationId, hash, reason, requestId })
    return { before, approval }
  }
  const browserDecision = async ({ approval, actionType, outcome, note }) => {
    const actorPage = outcome === 'withdraw' ? page : approvalPage
    requireClosureFact(actorPage && outputDir, 'real approval page/output unavailable')
    await openRoute(actorPage, `/cost-management/monthly/cost-publish?periodId=${periodId}`, {
      readySelector: '.formal-cost-approval'
    })
    const strip = actorPage.locator('.formal-cost-approval .approval-strip')
    await strip.waitFor({ state: 'visible' })
    requireClosureFact(await strip.getAttribute('data-period-id') === periodId &&
      await strip.getAttribute('data-approval-id') === String(approval.id), 'browser approval identity drift')
    const text = await strip.innerText()
    const label = actionType === 'REOPEN' ? '反月结重开' : '回退正式成本'
    requireClosureFact([label, approval.batchNo, String(requester), approval.reason].every((part) =>
      text.includes(part)) &&
      (await actorPage.locator('.approval-policy').innerText()).includes('审批通过并执行前不改变正式成本'),
    'browser persistent policy or exact approval context missing')
    const screenshots = [await saveScreenshot(actorPage, outputDir, `cost028-${actionType}-${outcome}-strip`, record)]
    const buttonLabel = outcome === 'approve' ? '审批通过并执行' : outcome === 'reject' ? '驳回申请' : '撤回申请'
    await strip.getByRole('button', { name: buttonLabel, exact: true }).click()
    const dialog = actorPage.locator('.cost-publication-approval-dialog:visible')
    await dialog.waitFor({ state: 'visible' })
    const impact = outcome === 'approve'
      ? '审批通过后才执行正式成本回退或反月结'
      : outcome === 'reject' ? '不改变正式成本状态' : '正式成本状态保持不变'
    requireClosureFact((await dialog.innerText()).includes(impact), 'browser decision impact missing')
    const confirm = dialog.getByRole('button', {
      name: outcome === 'approve' ? '确认通过并执行' : outcome === 'reject' ? '确认驳回' : '确认撤回', exact: true
    })
    requireClosureFact(await confirm.isDisabled(), 'empty decision note allowed')
    await dialog.locator('textarea').fill(note)
    if (outcome === 'approve') {
      requireClosureFact(await confirm.isDisabled(), 'approval allowed without consequence acknowledgement')
      await dialog.locator('.decision-check').click()
      requireClosureFact(await dialog.getByRole('checkbox').isChecked(), 'visible acknowledgement did not select checkbox')
    }
    requireClosureFact(await confirm.isEnabled(), 'completed decision cannot submit')
    screenshots.push(await saveScreenshot(actorPage, outputDir, `cost028-${actionType}-${outcome}-dialog`, record))
    const responsePromise = actorPage.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/cost/publication-approvals/${approval.id}/${outcome}`))
    await confirm.click()
    const response = await responsePromise
    const request = response.request()
    const headers = await request.allHeaders()
    const body = request.postDataJSON()
    requireClosureFact(response.status() === 200 && body.note === note &&
      headers['if-match'] === String(approval.version) &&
      headers['x-request-id']?.startsWith(`cost-${outcome}-`) &&
      headers['x-request-id'].length <= 64, 'browser exact decision request missing')
    const result = await response.json()
    closureData(result)
    await strip.waitFor({ state: 'hidden' })
    pageEvidence.push({
      periodId, approvalId: String(approval.id), publicationId,
      actionType, outcome, actorId: outcome === 'withdraw' ? requester : approver,
      requestId: headers['x-request-id'], ifMatch: headers['if-match'],
      url: actorPage.url(), screenshots, impact, acknowledged: outcome === 'approve'
    })
    return result
  }
  let operationError
  const cleanupErrors = []
  try {
    const publisherApi = await actor('reviewer', ['cost:publication:publish', 'cost:publication:approve'])
    let approverApi
    if (page && !separationOnly) {
      const context = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' })
      browserContexts.push(context)
      approvalPage = await context.newPage()
      const observer = observePage(approvalPage, record)
      context.costObserver = observer
      const token = await loginWithCredentials(approvalPage, {
        tenantName: config.tenantName,
        username: fixture.approvalReviewerUsername,
        password: fixture.approvalReviewerPassword
      }, { dumpDir: outputDir })
      approverApi = await loginWorkflowActor({
        key: 'approvalReviewer', fixture, record, caseRecord, dependencies,
        sessions: tokens, token,
        permissions: ['cost:publication:approve', 'cost:publication:query', 'cost:period:query', 'cost:model:query']
      })
    } else approverApi = await actor('approvalReviewer', ['cost:publication:approve'])
    for (const actionType of ['ROLLBACK', 'REOPEN']) {
      if (separationOnly) {
        const before = await snapshot(`cost023-${actionType}-publisher-request-before`)
        const path = actionType === 'ROLLBACK'
          ? `/cost/publications/${publicationId}/rollback`
          : `/cost/periods/${periodId}/publications/reopen`
        const rejection = { code: 422001, message: actionType === 'ROLLBACK'
          ? '正式成本发布人与回退操作人不能相同'
          : '正式成本发布人与反月结重开操作人不能相同' }
        const reason = `COST-023 ${record.runId} publisher ${actionType}`
        const denied = await publisherApi.request('POST', path, { reason }, {
          headers: {
            'If-Match': String(before.period.version),
            'X-Input-Hash': costApprovalHash([actionType, publicationId, before.trace.resultHash, reason, String(before.period.version)]),
            'X-Request-Id': `cost023-${actionType}-${record.runId}`
          },
          expectedBusinessRejection: rejection
        })
        const deniedRows = await database(`cost023-${actionType}-publisher-request-zero`, `
          SELECT COUNT(*) FROM cost_publication_approval
            WHERE tenant_id=1 AND publication_id=${publicationId}
              AND requested_by=${publisher} AND deleted=b'0'`)
        requireClosureFact(matchesExpectedBusinessRejection(denied, rejection) &&
          deniedRows.length === 1 && deniedRows[0][0] === '0' && await active() == null &&
          await identical(before, `cost023-${actionType}-publisher-request-after`),
        'publisher rollback/reopen request denial not proven')
      }
      for (const outcome of separationOnly ? ['withdraw'] : ['withdraw', 'reject', 'approve']) {
        const suffix = `${actionType.toLowerCase()}-${outcome}`
        const { before, approval } = await submit(actionType, suffix)
        for (const [client, message] of [
          [actorApi, '审批人不能是申请发起人'],
          [publisherApi, '正式成本发布人与回退或反月结审批人不能相同']
        ]) {
          const rejection = { code: 422001, message }
          const denied = await decision(client, approval, 'approve', { note: suffix }, rejection)
          requireClosureFact(matchesExpectedBusinessRejection(denied, rejection) &&
            await identical(before, `cost028-${suffix}-actor-denied`), 'actor rejection changed formal facts')
        }
        const note = `COST-028 ${suffix}`
        const result = closureData(page && !separationOnly
          ? await browserDecision({ approval, actionType, outcome, note })
          : await decision(outcome === 'withdraw' ? actorApi : approverApi, approval, outcome, { note }))
        requireClosureFact(await active() == null, 'processed approval is still active')
        pendingIds.delete(exactWorkflowId(approval.id))
        const expected = outcome === 'withdraw' ? 'WITHDRAWN' : outcome === 'reject' ? 'REJECTED' : 'EXECUTED'
        const history = await database(`cost028-${suffix}-history`, `
          SELECT status,CAST(requested_by AS CHAR),CAST(approver_id AS CHAR),CAST(rejected_by AS CHAR),
            CAST(withdrawn_by AS CHAR),approved_at,rejected_at,withdrawn_at,executed_at,
            execution_result_status,execution_request_id
          FROM cost_publication_approval WHERE tenant_id=1 AND id=${exactWorkflowId(approval.id)} AND deleted=b'0'`)
        const row = history[0]
        requireClosureFact(result.approvalStatus === expected && history.length === 1 &&
          row[0] === expected && row[1] === requester, 'missing decision history')
        if (outcome !== 'approve') {
          const index = outcome === 'withdraw' ? 4 : 3
          requireClosureFact(row[index] === (outcome === 'withdraw' ? requester : approver) &&
            row[index + 3] !== 'NULL' && row[8] === 'NULL' &&
            await identical(before, `cost028-${suffix}-unchanged`), 'withdraw/reject mutated formal facts')
        } else {
          const after = closureData(await api.getBusiness(`/cost/periods/${periodId}`))
          const target = actionType === 'ROLLBACK' ? 'TRIAL_CONFIRMED' : 'ACCOUNTING'
          const states = await database(`cost028-${suffix}-states`, `
            SELECT 'publication',status,CAST(published_by AS CHAR),CAST(rollback_by AS CHAR)
              FROM cost_publication WHERE tenant_id=1 AND id=${publicationId} AND deleted=b'0'
            UNION ALL SELECT 'trial',status,creator,CAST(confirmed_by AS CHAR)
              FROM cost_trial WHERE tenant_id=1 AND id=${trialId} AND deleted=b'0'`)
          requireClosureFact(after.status === target && after.currentPublicationId == null &&
            after.version === before.period.version + 1 && row[2] === approver &&
            row[5] !== 'NULL' && row[8] !== 'NULL' && row[9] === target &&
            row[10] === `cost-approval-${approval.id}-${approval.version}` &&
            states.length === 2 && states[0][1] === (actionType === 'ROLLBACK' ? 'ROLLED_BACK' : 'REVERSED') &&
            states[0][2] === publisher && states[0][3] === approver &&
            states[1][1] === (actionType === 'ROLLBACK' ? 'CONFIRMED' : 'SUPERSEDED') &&
            (actionType === 'REOPEN' ? after.currentTrialId == null : String(after.currentTrialId) === trialId),
          'approved execution state/actor mismatch')
          const afterTrace = closureData(await api.getBusiness(`/cost/publications/${publicationId}/trace`))
          for (const key of ['resultHash', 'configSnapshotHash', 'sourceSnapshotHash', 'components', 'sources', 'allocations']) {
            requireClosureFact(JSON.stringify(afterTrace[key]) === JSON.stringify(before.trace[key]), `historical ${key} overwritten`)
          }
          if (actionType === 'ROLLBACK') {
            const published = closureData(await publisherApi.postBusiness(
              `/cost/periods/${periodId}/publications`, undefined, {
                headers: { 'If-Match': String(after.version), 'X-Request-Id': `cost028-republish-${record.runId}` }
              }))
            publicationId = exactWorkflowId(published.publicationId)
            const republished = closureData(await api.getBusiness(`/cost/periods/${periodId}`))
            requireClosureFact(publicationId !== firstPublicationId && republished.status === 'COST_PUBLISHED' &&
              String(republished.currentPublicationId) === publicationId, 'new owned publication not bound')
          }
        }
      }
    }
    for (const name of separationOnly
      ? [COST_SEPARATION_CHECKS.publicationRequest, COST_SEPARATION_CHECKS.publicationActors]
      : Object.values(COST_APPROVAL_CHECKS)) {
      closureCheck(caseRecord, name, true,
        `period=${periodId}; requester=${requester}; publisher=${publisher}; approver=${approver}; decisions=${sessions.length}`)
    }
    caseRecord.costApprovalEvidence = sessions
    if (page && !separationOnly) {
      requireClosureFact(pageEvidence.length === 6, 'six real browser decisions not observed')
      caseRecord.costApprovalPageEvidence = pageEvidence
      for (const name of Object.values(COST_APPROVAL_PAGE_CHECKS)) {
        closureCheck(caseRecord, name, true, `period=${periodId}; realBrowserDecisions=${pageEvidence.length}; noWorkspaceMock=true`)
      }
    }
  } catch (error) {
    operationError = error
  } finally {
    if (pendingIds.size) {
      try {
        const current = await active()
        if (current != null) {
          requireClosureFact(pendingIds.has(exactWorkflowId(current.id)) &&
            String(current.requestedBy) === requester, 'cleanup active approval ownership drift')
          const before = await snapshot('cost-workflow-cleanup-before')
          closureData(await decision(actorApi, current, 'withdraw', { note: 'failure-cleanup' }))
          requireClosureFact(await active() == null &&
            await identical(before, 'cost-workflow-cleanup-after'), 'cleanup changed formal facts')
        }
      } catch (error) { cleanupErrors.push(error) }
    }
    for (const { client, userId } of tokens) {
      try {
        await logoutWorkflowActor({ client, userId, caseRecord, readSql, stage: caseRecord.id })
      } catch (error) { cleanupErrors.push(error) }
    }
    for (const context of browserContexts) {
      try {
        await context.costObserver.flushResponses()
        await context.close()
      } catch (error) { cleanupErrors.push(error) }
    }
  }
  if (operationError || cleanupErrors.length) throw new AggregateError(
    [operationError, ...cleanupErrors].filter(Boolean),
    [operationError?.message, ...cleanupErrors.map((error) => error.message)].filter(Boolean).join('; ')
  )
}
