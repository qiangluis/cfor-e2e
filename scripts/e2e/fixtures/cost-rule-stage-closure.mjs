import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { costModelPayload } from './cost-model.mjs'
import { cleanupCostScenarioReviewer, createAuditedPurchaseReceipt, createReviewer, loginAs } from './cost-scenario.mjs'
import { assertPurchaseReceipt, assertPurchaseConfirmed, costSourceDecimal } from './cost-purchase-source-closure.mjs'

export const COST_RULE_STAGE_CHECKS = Object.freeze({
  stages: 'COST-034 同期间四阶段真实执行的全部规则均精确落PASS/CLOSED',
  evidence: 'COST-034 规则模型版本与来源键版本哈希试算哈希发布批次逐项关联API及SQL',
  queue: 'COST-034 真实BLOCK/WARN/PASS排序且PASS不计未处理及页面准确展示',
  replay: 'COST-034 四阶段同证据真实重复成功且规则ID数量及业务身份不变'
})
export const COST_RULE_STAGE_BINDINGS = Object.freeze(Object.fromEntries(
  Object.values(COST_RULE_STAGE_CHECKS).map((name, index) => [index, Object.freeze([name])])
))
const trialRules = ['CI-001', 'CI-002', 'CI-004', 'CI-005', 'CI-006', 'CI-007', 'AR-001', 'AR-002', 'TP-001']
export const COST_STAGE_RULES = Object.freeze({
  取数: Object.freeze(['CI-004', 'CI-005']),
  试算: Object.freeze([...trialRules]),
  确认: Object.freeze([...trialRules]),
  发布: Object.freeze([...trialRules, 'TP-002'])
})
const requireFact = (condition, message) => {
  if (!condition) throw new Error(`COST-034: ${message}`)
}
const id = (value) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  requireFact(/^[1-9]\d*$/.test(text) && BigInt(text) <= 9223372036854775807n, '缺少精确ID')
  return text
}
const data = (response) => {
  requireFact(isBusinessSuccess(response) && response.data != null,
    '正式API未返回成功业务数据')
  return response.data
}
const hash = (value) => createHash('sha256').update(value).digest('hex')
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const same = (left, right) => assert.deepEqual(left, right)
const basis = (stage, evidence) => `${stage}通过，规则未命中异常；证据：${evidence}`
const check = (record, name, details) => record.checks.push({
  name, passed: true, details: JSON.stringify(details)
})
const gap = (record, index, code, details) => {
  record.gaps ||= []
  record.gaps.push({ caseId: 'COST-034', assertionIndex: index, code, details, status: 'GAP' })
  record.notes.push(`COST-034 GAP ${code}: ${JSON.stringify(details)}`)
}

export function assertCostRuleStageTarget ({ record, caseRecord }, {
  settings = config, writeFixtures = process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
} = {}) {
  requireFact(writeFixtures === true && settings.target === 'local' &&
    String(settings.tenantId) === '1' && settings.tenantName === 'CFOR 标准平台' &&
    String(record?.environment?.tenantId) === '1' &&
    caseRecord?.id === 'COST-034' && caseRecord?.caseId === 'COST-034' &&
    /^[A-Za-z0-9_-]+$/.test(record?.runId || ''),
  'BLOCKED: 必须显式启用本地tenant1/COST-034本轮专属写侧')
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    requireFact(url.protocol === 'http:' && !url.username && !url.password &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === port,
    'BLOCKED: 仅允许本地48083/9151')
  }
  requireFact(new URL(settings.apiUrl).origin === new URL(settings.apiBase).origin &&
    new URL(settings.apiUrl).pathname === '/admin-api', 'BLOCKED: API前缀不符')
  assertLocalDatabase(settings.db)
}

const listAll = async (api, endpoint) => {
  const result = []
  const ids = new Set()
  let total
  for (let pageNo = 1; pageNo <= 1000; pageNo++) {
    const page = data(await api.getBusiness(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}pageNo=${pageNo}&pageSize=100`))
    requireFact(Array.isArray(page.list) && Number.isSafeInteger(page.total) &&
      page.total >= result.length + page.list.length &&
      (total === undefined || total === page.total), '正式分页不完整或执行期间发生变化')
    total = page.total
    for (const row of page.list) {
      requireFact(!ids.has(id(row.id)), '正式分页主键重复')
      ids.add(id(row.id))
      result.push(row)
    }
    if (result.length === total) return result
    requireFact(page.list.length > 0, '正式分页提前结束')
  }
  throw new Error('COST-034: 正式分页超过安全上限')
}

export async function prepareCostRuleStageFixture ({ api, record, caseRecord }) {
  const [models, periods] = await Promise.all([
    listAll(api, '/cost/model-versions?accountingOrgId=1'),
    listAll(api, '/cost/periods?accountingOrgId=1')
  ])
  const months = [...models.map((row) => row.effectiveMonth), ...periods.map((row) => row.period)]
  requireFact(months.every((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)), '月份结构无效')
  const latest = months.sort().at(-1) || '2199-12'
  const absolute = Math.max(2200 * 12, Number(latest.slice(0, 4)) * 12 + Number(latest.slice(5)))
  const month = `${Math.floor(absolute / 12)}-${String(absolute % 12 + 1).padStart(2, '0')}`
  requireFact(month <= '2299-12', '专属远期月份池已耗尽')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const fixture = {
    caseId: 'COST-034', runId: record.runId, tenantId: '1', scenario: 'rule-stage',
    suffix, month, versionNo: `E2E-C034-${suffix}`,
    remark: `CFOR-E2E:costScenario:rule-stage:${record.runId}:${suffix}:tenant=1:org=1:month=${month}`
  }
  caseRecord.fixtures ||= {}
  caseRecord.fixtures.costScenario = fixture
  fixture.departmentId = id(data(await api.postBusiness('/system/dept/create', {
    name: `E2E-COST034-${suffix}`, code: `E2E-COST034-${suffix}`,
    parentId: '0', unitType: 'DEPARTMENT', sort: 9999, status: 0
  })))
  fixture.costCenterId = id(data(await api.postBusiness('/cost/centers', {
    accountingOrgId: 1, code: `E2E-C034-${suffix}`, name: `E2E-C034-${suffix}`,
    enabledAt: `${month}-01`, departmentIds: [fixture.departmentId], remark: fixture.remark
  })).id)
  fixture.modelId = id(data(await api.postBusiness('/cost/model-versions', costModelPayload({
    versionNo: fixture.versionNo, effectiveMonth: month, remark: fixture.remark
  }))).id)
  const components = data(await api.putBusiness(`/cost/model-versions/${fixture.modelId}/components`, {
    categories: [{ id: 'stage-category', code: `C034-CAT-${suffix}`, name: 'E2E人工成本',
      parentId: '', sortNo: 100, status: 'ENABLED' }],
    items: [{ id: 'stage-item', categoryId: 'stage-category', code: `C034-LABOR-${suffix}`,
      name: 'E2E人工成本', inclusionRate: 100, fetchMode: 'MANUAL', resultScope: 'FORMAL_COST',
      businessDirection: 'COST', systemItem: false, participateWip: true,
      status: 'ENABLED', remark: fixture.remark }],
    sourceRules: [{ id: 'stage-source', componentItemId: 'stage-item', sourceType: 'LABOR',
      sourcePriority: 1, effectiveFrom: `${month}-01`, status: 'ENABLED' }]
  }))
  requireFact(components.items?.length === 1, '专属模型构成项不唯一')
  fixture.componentItemId = id(components.items[0].id)
  data(await api.putBusiness('/cost/allocation-rules', {
    modelVersionId: fixture.modelId, costCenterId: fixture.costCenterId,
    effectiveMonth: month, status: 'CONFIRMED',
    lines: [{ componentItemId: fixture.componentItemId, finishedRatio: 100, wipRatio: 0,
      allocationMode: 'AMOUNT', roundingPolicy: 'MAX_AMOUNT_OBJECT' }]
  }))
  requireFact(data(await api.postBusiness(`/cost/model-versions/${fixture.modelId}/lock`))
    .status === 'LOCKED', '专属模型未锁定')
  fixture.periodId = id(data(await api.postBusiness('/cost/periods', {
    accountingOrgId: 1, enterpriseType: 'MANUFACTURING', modelVersion: fixture.versionNo,
    period: fixture.month
  }, { headers: { 'X-Request-Id': `cost034-period-${suffix}` } })).periodId)
  return fixture
}

export async function prepareCostRuleStagePurchase (context, fixture, dependencies = {}) {
  assertCostRuleStageTarget(context, {
    settings: dependencies.settings || config,
    writeFixtures: dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
  })
  requireFact(fixture === context.caseRecord.fixtures?.costScenario &&
    fixture.caseId === 'COST-034' && fixture.runId === context.record.runId &&
    fixture.tenantId === '1' && fixture.scenario === 'rule-stage' &&
    /^22\d{2}-(0[1-9]|1[0-2])$/.test(fixture.month) &&
    fixture.versionNo === `E2E-C034-${fixture.suffix}` &&
    fixture.remark === `CFOR-E2E:costScenario:rule-stage:${fixture.runId}:${fixture.suffix}:tenant=1:org=1:month=${fixture.month}`,
  '采购取数拒绝共享或其他运行的场景')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(context.caseRecord)
  const { api } = context
  const period = data(await api.getBusiness(`/cost/periods/${id(fixture.periodId)}`))
  const model = data(await api.getBusiness(`/cost/model-versions/${id(fixture.modelId)}`))
  requireFact(id(period.modelVersionId) === fixture.modelId && period.period === fixture.month &&
    period.status === 'ACCOUNTING' && id(model.id) === fixture.modelId &&
    model.versionNo === fixture.versionNo && model.remark === fixture.remark && model.status === 'LOCKED',
  '采购取数写前专属模型期间归属改变')
  const templates = data(await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'))
  const sample = (templates.records || templates.list || []).find((row) => row.id && row.unitId)
  const accounts = data(await api.getBusiness('/erp/account/page?pageNo=1&pageSize=100'))
  const account = accounts.list?.find((row) => row.id && row.status !== 1)
  const plans = data(await api.getBusiness(
    '/mes/quality/qualityPlan/list/dictText?pageNo=1&pageSize=100&type=101'))
  const plan = (plans.records || plans.list || []).find((row) => row.id && Number(row.publishStatus) === 1)
  const rules = data(await api.getBusiness('/mes/fillRule/list?pageNo=1&pageSize=20&ruleCode=qc_zjd_bill_no'))
  if (!sample || !account || !plan || !rules.records?.length) {
    return { available: false, code: 'COLLECT_PURCHASE_PREREQUISITES_MISSING', details: {
      materialTemplate: Boolean(sample), account: Boolean(account), publishedQualityPlan: Boolean(plan),
      existingQualityNumberRule: Boolean(rules.records?.length),
      reason: '缺少正式采购前置；不发布共享质检方案、不创建共享编号规则'
    } }
  }
  const code = `E2E-C034-MAT-${fixture.suffix}`
  fixture.unitId = id(sample.unitId)
  fixture.accountId = id(account.id)
  fixture.materialId = id(data(await api.postBusiness('/mes/basMaterial/add', {
    code, name: code, auxName: code, unitId: fixture.unitId,
    inventoryNature: 'STOCK', isMaterial: 'Y', isEnabled: 1, purchased: 'Y', saled: 'Y',
    produced: 'N', source: 'purchase', leadTime: 1, bufferTime: 1,
    batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N', gradeManaged: 'N', remark: fixture.remark
  })))
  const material = data(await api.getBusiness(`/mes/basMaterial/queryById?id=${fixture.materialId}`))
  requireFact(id(material.id) === fixture.materialId && material.code === code &&
    id(material.unitId) === fixture.unitId && material.remark === fixture.remark, '采购物料所有权回读失败')
  data(await api.postBusiness('/mes/quality/qualityMaterial/addBatch', [{
    materialId: fixture.materialId, planId: id(plan.id), type: '101',
    effectiveFrom: `${fixture.month}-01`, isDefault: true, priority: 999
  }]))
  const warehouseCode = `E2E-C034-WH-${fixture.suffix}`
  data(await api.postBusiness('/mes/wmsWareHouse/add', {
    code: warehouseCode, name: warehouseCode, mark: fixture.remark, pid: '0',
    isEnabled: true, areaEnabled: false, locationEnabled: false, countInAvailable: true
  }))
  const warehouses = data(await api.getBusiness('/mes/wmsWareHouse/allTree'))
  const flatten = (rows, result = []) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      result.push(row)
      flatten(row.children, result)
    }
    return result
  }
  const candidates = flatten(Array.isArray(warehouses) ? warehouses : warehouses.list)
    .filter((row) => row.name === warehouseCode)
  requireFact(candidates.length === 1 && candidates[0].pid === '0',
    '采购专属仓库树节点唯一性或根节点归属回读失败')
  const warehouse = data(await api.getBusiness(
    `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(id(candidates[0].id))}`))
  requireFact(id(warehouse.id) === id(candidates[0].id) &&
    warehouse.code === warehouseCode && warehouse.name === warehouseCode &&
    warehouse.mark === fixture.remark && warehouse.pid === '0' &&
    warehouse.isEnabled === true && warehouse.areaEnabled === false &&
    warehouse.locationEnabled === false && warehouse.countInAvailable === true,
  '采购专属仓库详情所有权回读失败')
  fixture.warehouseId = id(warehouse.id)
  const receipt = await (dependencies.createAuditedPurchaseReceipt || createAuditedPurchaseReceipt)({
    api, suffix: fixture.suffix, month: fixture.month, fixture,
    material: { materialId: fixture.materialId, unitId: fixture.unitId },
    warehouseId: fixture.warehouseId, accountId: fixture.accountId
  })
  fixture.purchaseOrderId = id(receipt.orderId)
  fixture.purchaseInId = id(receipt.purchaseInId)
  const detail = data(await api.getBusiness(`/erp/purchase-in/get?id=${fixture.purchaseInId}`))
  requireFact(id(detail.id) === fixture.purchaseInId && Number(detail.status) === 20 &&
    id(detail.orderId) === fixture.purchaseOrderId && detail.businessType === 'NORMAL' &&
    detail.inTime?.slice(0, 7) === fixture.month, '采购来源未在本专属期间正式审核')
  return { available: true, receipt: detail }
}

export function assertCostStageCollectDatabase (state, source) {
  const line = source.lines[0]
  const rows = state.database.filter((row) => row[0] === 'collect-line')
  requireFact(source.lines.length === 1 && rows.length === 1 &&
    rows[0][1] === source.id && rows[0][2] === line.sourceModule &&
    rows[0][3] === line.sourceType && rows[0][4] === line.sourceId &&
    rows[0][5] === line.sourceLineId && rows[0][6] === line.sourceVersion &&
    rows[0][7] === line.productCode &&
    costSourceDecimal(rows[0][8]) === costSourceDecimal(line.quantity) &&
    costSourceDecimal(rows[0][9]) === costSourceDecimal(line.materialAmount) &&
    rows[0][10] === source.status, '采购取数SQL来源身份、版本、数量金额或状态不符')
}

export function inspectCostRuleStages (hits, fixture, source, resultHash, batchNo) {
  const evidence = {
    取数: `${source.snapshotKey}@${source.versionNo}`, 试算: resultHash, 确认: resultHash, 发布: batchNo
  }
  const missing = []
  const invalid = []
  const stageRows = {}
  for (const [stage, rules] of Object.entries(COST_STAGE_RULES)) {
    const expectedBasis = basis(stage, evidence[stage])
    const matching = hits.filter((row) => row.basis === expectedBasis && row.level === 'PASS')
    stageRows[stage] = matching
    for (const rule of rules) {
      const rows = matching.filter((row) => row.ruleCode === rule)
      if (!rows.length) missing.push({ stage, rule, expectedBasis })
      else if (rows.length !== 1 || rows[0].status !== 'CLOSED' ||
        rows[0].ruleVersion !== fixture.modelId || id(rows[0].periodId) !== fixture.periodId) {
        invalid.push({ stage, rule, rows })
      }
    }
    if (matching.some((row) => !rules.includes(row.ruleCode))) invalid.push({ stage, reason: '未实际执行规则' })
    if (hits.some((row) => row.level === 'PASS' && String(row.basis).startsWith(`${stage}通过`) &&
      row.basis !== expectedBasis)) invalid.push({ stage, reason: '阶段证据与本轮正式结果不符' })
  }
  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid, stageRows }
}

export async function readCostRuleStageState ({ api, fixture, caseRecord, readSql = runReadOnlySql }) {
  const period = data(await api.getBusiness(`/cost/periods/${id(fixture.periodId)}`))
  requireFact(id(period.id) === fixture.periodId && id(period.modelVersionId) === fixture.modelId &&
    period.modelVersionNo === fixture.versionNo && period.period === fixture.month &&
    period.enterpriseType === 'MANUFACTURING' && String(period.accountingOrgId) === '1',
  '专属期间归属发生变化')
  const hits = await listAll(api, `/cost/periods/${fixture.periodId}/rule-hits`)
  const database = await readSql(`
    SELECT 'hit', CAST(id AS CHAR), CAST(period_id AS CHAR), rule_code, rule_version, level, status, basis
    FROM cost_rule_hit WHERE tenant_id=1 AND deleted=0 AND period_id=${fixture.periodId} ORDER BY id;
    SELECT 'snapshot', CAST(id AS CHAR), snapshot_key, version_no, snapshot_hash, status
    FROM cost_period_snapshot WHERE tenant_id=1 AND deleted=0 AND period_id=${fixture.periodId}
      AND snapshot_type='SOURCE' ORDER BY id;
    SELECT 'trial', CAST(id AS CHAR), result_hash, status, creator, CAST(confirmed_by AS CHAR)
    FROM cost_trial WHERE tenant_id=1 AND deleted=0 AND period_id=${fixture.periodId} ORDER BY id;
    SELECT 'publication', CAST(id AS CHAR), CAST(trial_id AS CHAR), result_hash, batch_no, status, source_snapshot_hash
    FROM cost_publication WHERE tenant_id=1 AND deleted=0 AND period_id=${fixture.periodId} ORDER BY id;
    SELECT 'hash', snapshot_hash FROM cost_period_snapshot
    WHERE tenant_id=1 AND deleted=0 AND period_id=${fixture.periodId} AND status='CONFIRMED'
    ORDER BY snapshot_type, snapshot_key, version_no;
    SELECT 'blocking', COUNT(*) FROM cost_rule_hit WHERE tenant_id=1 AND deleted=0
      AND period_id=${fixture.periodId} AND level='BLOCK' AND status='OPEN';
    SELECT 'collect-line', CAST(l.snapshot_id AS CHAR), l.source_module, l.source_type,
      l.source_id, l.source_line_id, l.source_version, l.product_code,
      l.quantity, l.material_amount, l.source_status
    FROM cost_source_snapshot_line l JOIN cost_period_snapshot s ON s.id=l.snapshot_id
      AND s.tenant_id=l.tenant_id AND s.deleted=0 AND s.snapshot_key='PURCHASE'
    WHERE l.tenant_id=1 AND l.deleted=0 AND l.period_id=${fixture.periodId} ORDER BY l.id
  `)
  caseRecord.database ||= []
  caseRecord.database.push({ stage: 'cost034-rule-stage', ...database })
  requireFact(database?.available === true && Array.isArray(database.rows), '缺少真实只读SQL证据')
  const dbHits = database.rows.filter((row) => row[0] === 'hit')
  const apiHits = hits.map((row) => [id(row.id), id(row.periodId), row.ruleCode,
    row.ruleVersion ?? 'NULL', row.level, row.status, row.basis])
    .sort((a, b) => BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)
  same(dbHits.map((row) => row.slice(1)), apiHits)
  const blocking = database.rows.filter((row) => row[0] === 'blocking')
  same(blocking, [['blocking', String(hits.filter((row) => row.level === 'BLOCK' && row.status === 'OPEN').length)]])
  return { period, hits, database: database.rows }
}

export async function verifyCostRuleStagePage ({ page, fixture, hits, record, outputDir }, dependencies = {}) {
  const requests = []
  const listener = (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/cost/')) requests.push({ pathname, method: request.method() })
  }
  page.on('request', listener)
  try {
    await (dependencies.openRoute || openRoute)(page,
      `/cost-management/monthly/exception-queue?periodId=${fixture.periodId}`, {
        readySelector: `.exception-workspace[data-period-id="${fixture.periodId}"][data-loaded="true"]`,
        retries: 1
      })
    const root = page.locator('.exception-workspace')
    requireFact(await root.getAttribute('data-error') === '', '正式规则页面加载失败')
    requireFact(await root.getAttribute('data-period-id') === fixture.periodId, '页面期间不符')
    requireFact(await root.locator('[data-rule-hit-id][data-level="PASS"]').count() === 0,
      '默认未处理队列展示了PASS')
    const blocking = hits.filter((row) => row.level === 'BLOCK' && row.status === 'OPEN').length
    const warning = hits.filter((row) => row.level === 'WARN' && row.status === 'OPEN').length
    same(await root.getAttribute('data-blocking-count'), String(blocking))
    same(await root.getAttribute('data-warning-count'), String(warning))
    await root.getByRole('checkbox', { name: '包含通过及已关闭' }).check()
    const visible = await root.locator('[data-rule-hit-id]').evaluateAll((elements) =>
      elements.map((el) => ({ id: el.dataset.ruleHitId, level: el.dataset.level, status: el.dataset.status })))
    requireFact(visible.length > 0, '真实页面没有规则行')
    same(visible, hits.slice(0, 8).map(({ id, level, status }) => ({ id, level, status })))
    requireFact(requests.some((row) => row.method === 'GET' &&
      row.pathname === `/admin-api/cost/periods/${fixture.periodId}/rule-hits`), '页面未读取正式规则API')
    requireFact(requests.every((row) => ['GET', 'HEAD', 'OPTIONS'].includes(row.method)),
      '只读验收页面尝试写入成本或共享workspace')
    fs.mkdirSync(outputDir, { recursive: true })
    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'cost034-rule-stages', record)
    return { passed: true, periodId: fixture.periodId, blocking, warning, visible, requests }
  } finally {
    page.off('request', listener)
  }
}

// Current workflow endpoints reject these exact retries before reaching the
// recorder. Rejection is evidence of a missing replay, never of dedup success.
const replayRejections = {
  试算: { code: 422001, message: 'Only accounting periods can start a trial; roll back the current trial or publication first' },
  确认: { code: 409003, message: '同一 requestId 已用于不同输入，拒绝覆盖原请求' },
  发布: { code: 422001, message: '只有已确认试算的期间可以发布正式成本' }
}

export async function runCostRuleStageClosure (context, dependencies = {}) {
  const { api, page, record, caseRecord } = context
  const settings = dependencies.settings || config
  const writeFixtures = dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
  caseRecord.fixtures ||= {}
  if (writeFixtures !== true) {
    gap(caseRecord, 0, 'CONTROLLED_WRITE_DISABLED', '未创建期间或来源，不以只读API可用代替闭环')
    return { partial: true, acceptanceComplete: false }
  }
  assertCostRuleStageTarget(context, { settings, writeFixtures })
  requireFact(page && context.token, '必须复用主会话page/token，禁止内部启动浏览器')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const closure = { caseId: 'COST-034', runId: record.runId, tenantId: '1', complete: false,
    proofs: {}, replays: [], history: [] }
  caseRecord.fixtures.costRuleStage = closure
  let fixture
  let reviewer
  try {
    fixture = await (dependencies.prepareFixture || prepareCostRuleStageFixture)(context)
    const model = data(await api.getBusiness(`/cost/model-versions/${id(fixture.modelId)}`))
    requireFact(fixture.caseId === 'COST-034' && fixture.tenantId === '1' &&
      fixture.runId === record.runId && model.remark === fixture.remark &&
      model.versionNo === fixture.versionNo && model.enterpriseType === 'MANUFACTURING' &&
      model.status === 'LOCKED', '模型与本轮专属登记不符')
    closure.periodId = id(fixture.periodId)
    const root = `/cost/periods/${fixture.periodId}`
    const snapshotPath = `${root}/source-snapshot?snapshotKey=DEFAULT&versionNo=${encodeURIComponent(fixture.versionNo)}`
    const capture = async () => {
      const state = await readCostRuleStageState({ api, fixture, caseRecord, readSql: dependencies.readSql })
      closure.history.push(state)
      return state
    }
    const initial = await capture()
    requireFact(initial.hits.length === 0 && initial.period.status === 'ACCOUNTING' &&
      initial.database.filter((row) => ['snapshot', 'trial', 'publication'].includes(row[0])).length === 0,
    '新专属期间不是空核算期间，拒绝复用共享事实')
    const purchase = await (dependencies.preparePurchase || prepareCostRuleStagePurchase)(context, fixture, dependencies)
    closure.collectPreparation = purchase
    if (!purchase.available) gap(caseRecord, 0, purchase.code, purchase.details)
    const lines = [{
      sourceModule: 'MANUAL', sourceType: 'LABOR', sourceId: `C034-${fixture.suffix}`,
      sourceLineId: `C034-${fixture.suffix}-1`, sourceNo: `C034-${fixture.suffix}`,
      sourceVersion: '1', componentCode: `C034-LABOR-${fixture.suffix}`, componentName: 'E2E人工成本',
      allocationRatio: 100, costCenterCode: `E2E-C034-${fixture.suffix}`,
      productCode: `C034-PROD-${fixture.suffix}`, productName: 'E2E专属成本对象',
      quantity: 1, laborAmount: 123.45, priceStatus: 'FORMAL', sourceStatus: 'DRAFT'
    }]
    const sourceBody = { snapshotKey: 'DEFAULT', versionNo: fixture.versionNo, lines }
    const source = data(await api.putBusiness(`${root}/source-snapshot`, sourceBody))
    requireFact(source.periodId === fixture.periodId && source.snapshotKey === 'DEFAULT' &&
      source.versionNo === fixture.versionNo && source.status === 'DRAFT' && sha(source.snapshotHash) &&
      source.lines?.length === 1 && source.lines[0].sourceId === lines[0].sourceId &&
      source.lines[0].laborAmount === 123.45, '来源不是本期间非空正式人工草稿')
    id(source.id)
    let collectSource = source
    if (purchase.available) {
      collectSource = data(await api.postBusiness(`${root}/source-snapshot/purchase/refresh`))
      closure.collectDraft = collectSource
      assertPurchaseReceipt(collectSource, fixture, purchase.receipt)
      requireFact(collectSource.lines.length === 1 && collectSource.lines[0].sourceVersion,
        '采购取数必须只有本轮真实来源且保留来源版本')
    }
    const beforeCollect = await capture()
    if (purchase.available) assertCostStageCollectDatabase(beforeCollect, collectSource)
    const repeatedSource = data(purchase.available
      ? await api.postBusiness(`${root}/source-snapshot/purchase/refresh`)
      : await api.putBusiness(`${root}/source-snapshot`, sourceBody))
    same(repeatedSource, collectSource)
    const afterCollect = await capture()
    same(afterCollect, beforeCollect)
    closure.replays.push({ stage: '取数', succeeded: purchase.available,
      endpoint: purchase.available ? `${root}/source-snapshot/purchase/refresh` : `${root}/source-snapshot` })
    if (purchase.available) {
      const collected = data(await api.postBusiness(`${root}/source-snapshot/confirm?` +
        `snapshotKey=PURCHASE&versionNo=${encodeURIComponent(fixture.versionNo)}`))
      assertPurchaseConfirmed(collected, fixture, collectSource)
      same(data(await api.getBusiness(`${root}/source-snapshot?` +
        `snapshotKey=PURCHASE&versionNo=${encodeURIComponent(fixture.versionNo)}`)), collected)
      closure.collectSource = collected
      caseRecord.notes.push('COST-034采购取数为独立PURCHASE快照；按正式制造业路由排除采购金额，生产试算仍只纳入123.45人工成本，发布来源总哈希保留两份已确认快照')
    }
    const confirmed = data(await api.postBusiness(`${root}/source-snapshot/confirm?` +
      `snapshotKey=DEFAULT&versionNo=${encodeURIComponent(fixture.versionNo)}`))
    requireFact(confirmed.status === 'CONFIRMED' && confirmed.snapshotHash === source.snapshotHash &&
      confirmed.id === source.id && confirmed.lines.length === 1 &&
      confirmed.lines[0].sourceStatus === 'CONFIRMED', '来源确认改变身份或哈希')
    same(data(await api.getBusiness(snapshotPath)), confirmed)
    closure.source = confirmed

    const action = async (stage, actorApi, endpoint, body) => {
      const before = await capture()
      const options = { headers: {
        'X-Request-Id': `cost034-${fixture.suffix}-${stage === '试算' ? 'trial' : stage === '确认' ? 'confirm' : 'publish'}`,
        'If-Match': String(before.period.version)
      } }
      const result = data(await actorApi.postBusiness(endpoint, body, options))
      requireFact(result.periodId === fixture.periodId && sha(result.resultHash), '工作流结果身份/哈希不符')
      const first = await capture()
      const retry = await actorApi.post(endpoint, body,
        { ...options, expectedBusinessRejection: replayRejections[stage] })
      const second = await capture()
      same(second.period, first.period)
      same(second.hits, first.hits)
      same(second.database, first.database)
      if (retry?.code === 0) same(data(retry), result)
      else {
        requireFact(matchesExpectedBusinessRejection(retry, replayRejections[stage]), '重复执行出现非既定业务失败')
        gap(caseRecord, 3, `STAGE_REPLAY_REJECTED_${stage}`, retry)
      }
      closure.replays.push({ stage, succeeded: retry?.code === 0, response: retry })
      return result
    }
    const trial = await action('试算', api, `${root}/trials`, {
      enterpriseType: 'MANUFACTURING', periodId: fixture.periodId, modelVersion: fixture.versionNo
    })
    closure.trialId = id(trial.trialId)
    const actualTrial = data(await api.getBusiness(`${root}/trials/current`))
    requireFact(actualTrial.resultHash === trial.resultHash && actualTrial.objects?.length === 1 &&
      Number(actualTrial.inputAmount) === 123.45 && Number(actualTrial.finishedAmount) === 123.45 &&
      Number(actualTrial.differenceAmount) === 0, '专属试算没有精确纳入人工来源')
    reviewer = await (dependencies.createReviewer || createReviewer)({
      api, record, fixture, key: 'reviewer', suffix: `34${fixture.suffix.slice(0, 10)}`,
      loginImmediately: false,
      permissions: ['cost:period:query', 'cost:model:query', 'cost:publication:query',
        'cost:trial:confirm', 'cost:publication:publish']
    })
    const reviewerToken = await (dependencies.loginAs || loginAs)(record, reviewer.username, reviewer.password)
    const reviewerApi = (dependencies.createApiClient || createApiClient)({ token: reviewerToken, record })
    try {
      const confirmation = await action('确认', reviewerApi, `/cost/trials/${closure.trialId}/confirm`)
      same(confirmation.resultHash, trial.resultHash)
      const publication = await action('发布', reviewerApi, `${root}/publications`)
      same(publication.resultHash, trial.resultHash)
      closure.publicationId = id(publication.publicationId)
      requireFact(typeof publication.batchNo === 'string' && publication.batchNo.startsWith('PUB-'),
        '正式发布缺少真实批次号')
      closure.batchNo = publication.batchNo
      const trace = data(await api.getBusiness(`/cost/publications/${closure.publicationId}/trace`))
      requireFact(trace.publicationId === closure.publicationId && trace.periodId === fixture.periodId &&
        trace.resultHash === trial.resultHash && trace.batchNo === closure.batchNo &&
        trace.status === 'PUBLISHED' && trace.sources?.length === 1 &&
        id(trace.sources[0].sourceSnapshotId) === source.id &&
        trace.sources[0].sourceId === lines[0].sourceId &&
        trace.sources[0].sourceBusinessLineId === lines[0].sourceLineId &&
        Number(trace.sources[0].amount) === 123.45, '正式发布未冻结同一真实来源')
      closure.trace = trace
    } finally {
      data(await reviewerApi.postBusiness('/system/auth/logout'))
    }
    const final = await capture()
    const inspected = inspectCostRuleStages(final.hits, fixture, collectSource, trial.resultHash, closure.batchNo)
    closure.stages = inspected
    requireFact(inspected.invalid.length === 0, `规则记录内容错误：${JSON.stringify(inspected.invalid)}`)
    const headers = final.database.filter((row) => row[0] === 'snapshot')
    same(headers, [source, ...(closure.collectSource ? [closure.collectSource] : [])]
      .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
      .map((row) => ['snapshot', row.id, row.snapshotKey, row.versionNo, row.snapshotHash, 'CONFIRMED']))
    if (closure.collectSource) assertCostStageCollectDatabase(final, closure.collectSource)
    const trials = final.database.filter((row) => row[0] === 'trial')
    requireFact(trials.length === 1 && trials[0][1] === closure.trialId &&
      trials[0][2] === trial.resultHash && trials[0][3] === 'CONFIRMED' &&
      trials[0][4] !== trials[0][5] && trials[0][5] === id(reviewer.userId),
    '数据库未证明独立人工确认和同试算哈希')
    const publications = final.database.filter((row) => row[0] === 'publication')
    const digest = hash(final.database.filter((row) => row[0] === 'hash')
      .map((row) => row[1]).sort().map((value) => `${value}|`).join(''))
    same(publications, [['publication', closure.publicationId, closure.trialId,
      trial.resultHash, closure.batchNo, 'PUBLISHED', digest]])
    same(closure.trace.sourceSnapshotHash, digest)
    if (inspected.valid) {
      closure.proofs.stages = true
      closure.proofs.evidence = true
      check(caseRecord, COST_RULE_STAGE_CHECKS.stages, inspected.stageRows)
      check(caseRecord, COST_RULE_STAGE_CHECKS.evidence, {
        source: closure.source, resultHash: trial.resultHash, batchNo: closure.batchNo, database: final.database
      })
    } else {
      gap(caseRecord, 0, 'PRODUCT_STAGE_PASS_MISSING', inspected.missing)
      gap(caseRecord, 1, 'INCOMPLETE_STAGE_EVIDENCE', inspected.missing)
    }
    const rank = { BLOCK: 0, WARN: 1, PASS: 2 }
    requireFact(final.hits.length > 0 && final.hits.every((row, i, rows) =>
      Object.hasOwn(rank, row.level) && (i === 0 || rank[rows[i - 1].level] <= rank[row.level])),
    '正式队列未按BLOCK/WARN/PASS排序')
    const pageProof = await (dependencies.verifyPage || verifyCostRuleStagePage)({
      ...context, fixture, hits: final.hits
    }, dependencies.pageDependencies)
    requireFact(pageProof?.passed === true, '页面证据未通过')
    closure.page = pageProof
    if (['BLOCK', 'WARN', 'PASS'].every((level) => final.hits.some((row) => row.level === level))) {
      closure.proofs.queue = true
      check(caseRecord, COST_RULE_STAGE_CHECKS.queue, { pageProof, hits: final.hits })
    } else gap(caseRecord, 2, 'REAL_BLOCK_WARN_SAMPLES_MISSING', {
      observed: [...new Set(final.hits.map((row) => row.level))], pageProof,
      warn: 'CostWorkflowServiceImpl.recordCalculationFailure仅写BLOCK；CostRuleStageEvaluator明确未实现CV/CW/PRICE-ESTIMATE，规则配置与handle接口不产生WARN',
      block: '只接受正式规则失败；已确认来源与锁定模型不可修改，禁止以handle备注替代来源修复或伪造历史命中'
    })
    if (inspected.valid && closure.replays.length === 4 &&
      closure.replays.every((row) => row.succeeded === true)) {
      closure.proofs.replay = true
      check(caseRecord, COST_RULE_STAGE_CHECKS.replay, closure.replays)
    }
  } finally {
    if (fixture) {
      await (dependencies.cleanupReviewer || cleanupCostScenarioReviewer)({ api, fixture, key: 'reviewer' })
      closure.cleanupComplete = true
      caseRecord.notes.push('COST-034复核账号角色已清理；专属模型期间来源与正式发布保留审计，由成本整轮清理停用中心/删除部门')
      if (fixture.materialId) caseRecord.notes.push(`COST-034正式采购来源保留审计：material=${fixture.materialId} warehouse=${fixture.warehouseId || '未创建'} supplier=${fixture.supplierId || '未创建'} order=${fixture.purchaseOrderId || '未创建'} receipt=${fixture.purchaseInId || '未创建'}；未删除已审核库存/ERP事实，未修改共享方案编号规则或其他运行资源`)
    }
  }
  closure.complete = Object.keys(COST_RULE_STAGE_CHECKS).every((key) => closure.proofs[key] === true) &&
    closure.cleanupComplete === true
  return { acceptanceComplete: closure.complete, partial: !closure.complete,
    note: closure.complete ? 'COST-034严格闭环完成' : 'COST-034真实证据仍有GAP，未降低原断言' }
}

export function costRuleStageBindings (caseRecord) {
  const closure = caseRecord?.fixtures?.costRuleStage
  const fixture = caseRecord?.fixtures?.costScenario
  if (caseRecord?.id !== 'COST-034' || closure?.caseId !== 'COST-034' ||
    fixture?.caseId !== 'COST-034' || closure.runId !== fixture.runId ||
    !closure.runId || closure.tenantId !== '1' || fixture.tenantId !== '1' ||
    closure.periodId !== fixture.periodId || closure.cleanupComplete !== true) return {}
  return Object.fromEntries(Object.keys(COST_RULE_STAGE_CHECKS)
    .flatMap((key, index) => closure.proofs?.[key] === true
      ? [[index, COST_RULE_STAGE_BINDINGS[index]]] : []))
}
