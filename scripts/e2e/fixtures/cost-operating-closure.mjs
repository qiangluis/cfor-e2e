import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import {
  cleanupCostScenarioReviewer,
  createReviewer,
  loginAs,
  prepareCostScenario,
  resetCostScenarioCache
} from './cost-scenario.mjs'

export const COST_OPERATING_CHECKS = Object.freeze({
  refresh: '经营收支刷新返回真实DRAFT且专属期间没有隐式正式事实',
  collections: '经营收入与支出按原始明细确认并保存为非空正式快照',
  calculation: '经营计算引用已发布成本批次并保存精确结果哈希与对象事实',
  confirmationGate: '经营发布在人工确认前被精确阻断，确认后才允许发布',
  publication: '正式经营发布返回非空收入销售成本经营费用经营利润与来源事实',
  rollback: '经营发布回退只改变发布状态且保留原经营对象事实',
  allocationBasis: '正式经营费用事实包含有效正数分摊依据且排除销售成本',
  invalidBasis: '缺少有效经营费用分摊依据时正式发布被精确阻断且正式事实不变',
  salesCost: '非空销售成本无需经营费用分摊依据且不计入经营费用',
  cleanup: '成本经营专属复核账号角色清理成功且正式事实审计保留',
  page: '经营页面按专属期间读取正式API并显示真实来源明细'
})

const operatingCheckNames = (caseId) => [
  ...['refresh', 'collections', 'calculation', 'confirmationGate', 'publication', 'page', 'cleanup'],
  ...(caseId === 'COST-005' ? ['rollback'] : ['allocationBasis', 'invalidBasis', 'salesCost'])
].map((key) => COST_OPERATING_CHECKS[key])

const operatingChecksComplete = (caseRecord) => {
  const checks = Array.isArray(caseRecord.checks) ? caseRecord.checks : []
  return checks.length > 0 && checks.every((check) => check?.passed === true) &&
    operatingCheckNames(caseRecord.id).every((name) => {
      const matches = checks.filter((check) => check.name === name)
      return matches.length === 1 && matches[0].passed === true &&
        typeof matches[0].details === 'string' && matches[0].details.trim().length > 0
    })
}

export function hasCostOperatingEvidence (caseRecord) {
  if (!['COST-005', 'COST-008'].includes(caseRecord?.id)) return false
  const source = caseRecord.fixtures?.costScenario
  const evidence = caseRecord.fixtures?.costOperating
  if (!source || !evidence || evidence.complete !== true || evidence.pageFormal !== true ||
      evidence.caseId !== caseRecord.id || source.caseId !== caseRecord.id ||
      evidence.tenantId !== '1' || source.tenantId !== '1' ||
      !evidence.runId || source.runId !== evidence.runId ||
      source.scenario !== 'published' ||
      typeof source.suffix !== 'string' || !source.suffix ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(source.month) ||
      source.remark !== `CFOR-E2E:costScenario:published:${source.runId}:${source.suffix}:tenant=1:org=1:month=${source.month}` ||
      evidence.month !== source.month ||
      evidence.published !== (caseRecord.id === 'COST-008')) return false
  try {
    for (const [key, sourceKey] of [
      ['periodId', 'periodId'], ['modelId', 'modelId'], ['costPublicationId', 'publicationId']
    ]) {
      if (exactId(evidence[key], key) !== exactId(source[sourceKey], sourceKey)) return false
    }
    exactId(evidence.operatingPublicationId, '经营发布')
  } catch {
    return false
  }
  return operatingChecksComplete(caseRecord)
}

export function assertCostOperatingTarget (record, {
  settings = config, env = process.env,
  writeFixtures = env.CFOR_E2E_WRITE_FIXTURES === 'true'
} = {}) {
  requireFact(writeFixtures === true && settings.target === 'local' &&
    String(settings.tenantId) === '1' && String(record.environment?.tenantId) === '1' &&
    settings.tenantName === 'CFOR 标准平台',
  'BLOCKED: 经营写侧只允许显式开启的local tenant1/CFOR 标准平台')
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    requireFact(url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.port === port && !url.username && !url.password,
    'BLOCKED: 经营写侧仅允许本地48083/9151')
  }
  if (settings.apiUrl) {
    requireFact(new URL(settings.apiUrl).origin === new URL(settings.apiBase).origin,
      'BLOCKED: 经营API前缀不得指向其他服务')
  }
  assertLocalDatabase(settings.db)
}

export const costOperatingRequestId = ({ caseId, runId, periodId, action }) => {
  for (const value of [caseId, runId, periodId, action]) {
    if (typeof value !== 'string' || !value) throw new Error('缺少经营幂等请求标识')
  }
  requireFact(['COST-005', 'COST-008'].includes(caseId), '经营请求案例不在授权范围')
  exactId(periodId, '经营请求期间')
  const hash = digestJson([caseId, runId, periodId, action]).slice(0, 40)
  return `${caseId.toLowerCase()}-op-${hash}`
}

const requireFact = (condition, message) => {
  if (!condition) throw new Error(`COST-005/008: ${message}`)
}

const dataOf = (payload, label) => {
  requireFact(payload?.code === 0 && payload.data != null, `${label}未返回成功业务数据`)
  return payload.data
}

const exactId = (value, label) => {
  const text = typeof value === 'string'
    ? value
    : Number.isSafeInteger(value) ? String(value) : ''
  requireFact(/^[1-9]\d*$/.test(text) && BigInt(text) <= 9223372036854775807n,
    `${label}未返回精确数据库ID`)
  return text
}

const digestJson = (value) => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex')

const sameMoney = (left, right) => Number(left).toFixed(2) === Number(right).toFixed(2)

const addCheck = (caseRecord, name, passed, details) => {
  const check = { name, passed: passed === true, details: String(details ?? '') }
  caseRecord.checks.push(check)
  if (!check.passed) throw new Error(`${name}: ${check.details}`)
  return check
}

const addObservedCheck = (caseRecord, name, passed, details) => {
  const check = { name, passed: passed === true, details: String(details ?? '') }
  caseRecord.checks.push(check)
  return check
}

const readPeriod = async (api, periodId) =>
  dataOf(await api.getBusiness(`/cost/periods/${exactId(periodId, '经营期间')}`), '经营期间回读')

const manualRow = ({ fixture, direction, amount }) => {
  const isIncome = direction === 'INCOME'
  const itemCode = isIncome
    ? `E2E-OP-INCOME-${fixture.suffix}`
    : `E2E-OP-EXPENSE-${fixture.suffix}`
  const itemName = isIncome ? 'E2E经营营业收入' : '办公室租金'
  return {
    rowId: `${fixture.caseId}-${fixture.suffix}-${direction}`,
    itemCode,
    itemName,
    direction,
    reportScope: isIncome ? '营业收入' : '管理费用',
    affectsProfit: true,
    sourceNo: `CFOR-E2E-${fixture.caseId}-${fixture.suffix}-${direction}`,
    sourceType: 'MANUAL',
    sourceDate: `${fixture.month}-10`,
    counterparty: isIncome ? 'E2E客户' : 'E2E供应商',
    department: `E2E-COST-SCENARIO-${fixture.suffix}`,
    originalAmount: amount,
    inclusionRate: 100,
    amount,
    status: 'CONFIRMED',
    note: fixture.remark,
    ...(isIncome
      ? {}
      : { allocationBasis: `MANUAL:${amount}|CFOR-E2E专属经营费用分摊基数` })
  }
}

const reviewerPermissions = [
  'cost:period:query',
  'cost:model:query',
  'cost:publication:query',
  'cost:operating:query',
  'cost:operating:confirm',
  'cost:operating:publish'
]

const createOperatingReviewer = async ({ api, record, fixture }) => {
  const reviewer = await createReviewer({
    api,
    record,
    fixture,
    key: 'operatingReviewer',
    loginImmediately: false,
    permissions: reviewerPermissions,
    suffix: `OP${fixture.suffix.slice(0, 8)}`
  })
  const token = await loginAs(record, reviewer.username, reviewer.password)
  return {
    ...reviewer,
    token,
    api: createApiClient({ token, record })
  }
}

const refreshDirection = async ({ api, fixture, direction }) => {
  const endpoint = direction === 'INCOME'
    ? `/cost/periods/${fixture.periodId}/operating-income-sources/refresh`
    : `/cost/periods/${fixture.periodId}/operating-expense-sources/refresh`
  const refreshed = dataOf(await api.postBusiness(endpoint), `经营${direction}来源刷新`)
  requireFact(refreshed.periodId === fixture.periodId &&
    refreshed.direction === direction &&
    refreshed.status === 'DRAFT' &&
    Array.isArray(refreshed.rows) &&
    refreshed.rowCount === refreshed.rows.length &&
    refreshed.id == null &&
    refreshed.confirmedBy == null,
  `经营${direction}刷新不是专属非空? DRAFT结构`)
  return refreshed
}

const confirmDirection = async ({ api, fixture, period, direction, rows, record }) => {
  const requestId = costOperatingRequestId({
    caseId: fixture.caseId, runId: record.runId, periodId: fixture.periodId,
    action: `collection-confirm-${direction}-${digestJson(rows)}`
  })
  const response = dataOf(await api.postBusiness(
    `/cost/periods/${fixture.periodId}/operating-collections/confirm`,
    { direction, rows },
    {
      headers: {
        'X-Request-Id': requestId,
        'If-Match': String(period.version)
      }
    }
  ), `经营${direction}确认`)
  requireFact(response.periodId === fixture.periodId && response.status === period.status,
    `经营${direction}确认期间或状态响应不一致`)
  const collection = dataOf(await api.getBusiness(
    `/cost/periods/${fixture.periodId}/operating-collections?direction=${direction}`
  ), `经营${direction}正式快照回读`)
  requireFact(collection.periodId === fixture.periodId &&
    collection.direction === direction &&
    collection.status === 'CONFIRMED' &&
    collection.rowCount === rows.length &&
    rows.length > 0 &&
    Array.isArray(collection.rows) &&
    collection.rows.length === rows.length &&
    collection.confirmedBy != null &&
    sameMoney(collection.totalAmount, rows.reduce((sum, row) => sum + row.amount, 0)),
  `经营${direction}正式快照为空或金额不一致`)
  for (const expected of rows) {
    const actual = collection.rows.find((row) => row.sourceNo === expected.sourceNo)
    requireFact(actual &&
      actual.sourceType === expected.sourceType &&
      actual.itemCode === expected.itemCode &&
      sameMoney(actual.amount, expected.amount) &&
      (direction === 'INCOME' || actual.allocationBasis === expected.allocationBasis),
    `经营${direction}来源行未按原始断言精确回读`)
  }
  return { collection, requestId }
}

const readCostPublicationTrace = async ({ api, fixture }) => {
  const period = await readPeriod(api, fixture.periodId)
  const publicationId = exactId(
    fixture.publicationId || period.currentPublicationId,
    '专属正式成本发布批次'
  )
  requireFact(String(period.currentPublicationId) === publicationId &&
    period.status === 'COST_PUBLISHED',
  '经营计算缺少专属已发布成本批次')
  const trace = dataOf(
    await api.getBusiness(`/cost/publications/${publicationId}/trace`),
    '正式成本发布追溯'
  )
  requireFact(String(trace.publicationId) === publicationId &&
    trace.status === 'PUBLISHED' &&
    typeof trace.resultHash === 'string' &&
    /^[a-f\d]{64}$/i.test(trace.resultHash),
  '正式成本发布追溯缺少有效结果哈希')
  return { period, publicationId, trace }
}

export const readOperatingSql = async ({
  fixture, caseRecord, readSql = runReadOnlySql, expectedStatus = 'PUBLISHED',
  expectedRows, expectedAmounts
}) => {
  const periodId = exactId(fixture.periodId, '经营期间')
  const publicationId = exactId(fixture.operatingPublicationId, '经营发布')
  const result = await readSql(`
    SELECT 'period', CAST(id AS CHAR), period, status, CAST(version AS CHAR),
      CAST(current_publication_id AS CHAR), CAST(current_operating_publication_id AS CHAR)
    FROM cost_period
    WHERE tenant_id=1 AND id=${periodId} AND deleted=b'0';
    SELECT 'collection', direction, status, CAST(id AS CHAR), CAST(confirmed_by AS CHAR),
      CAST(row_count AS CHAR), total_amount, snapshot_hash
    FROM cost_operating_collection
    WHERE tenant_id=1 AND period_id=${periodId} AND deleted=b'0'
    ORDER BY id;
    SELECT 'publication', CAST(id AS CHAR), status, CAST(period_id AS CHAR),
      CAST(cost_publication_id AS CHAR), result_hash, revenue, sales_cost,
      operating_expense, operating_profit, CAST(calculated_by AS CHAR),
      CAST(confirmed_by AS CHAR), CAST(published_by AS CHAR)
    FROM cost_operating_publication
    WHERE tenant_id=1 AND id=${publicationId} AND deleted=b'0';
    SELECT 'fact', direction, item_code, report_scope, source_no, amount, allocation_basis,
      SHA2(CAST(JSON_OBJECT('id', id, 'collectionId', collection_id, 'payload', payload_json,
        'amount', amount, 'allocationBasis', allocation_basis, 'createTime', create_time,
        'updateTime', update_time, 'deleted', CAST(deleted AS UNSIGNED)) AS CHAR), 256)
    FROM cost_operating_object_fact
    WHERE tenant_id=1 AND publication_id=${publicationId} AND deleted=b'0'
    ORDER BY id
  `)
  requireFact(result.available && Array.isArray(result.rows), '经营正式事实缺少只读数据库证据')
  const periodRows = result.rows.filter((row) => row[0] === 'period')
  const collectionRows = result.rows.filter((row) => row[0] === 'collection')
  const publicationRows = result.rows.filter((row) => row[0] === 'publication')
  const factRows = result.rows.filter((row) => row[0] === 'fact')
  requireFact(periodRows.length === 1 && periodRows[0][1] === periodId &&
    periodRows[0][5] === String(fixture.publicationId) &&
    periodRows[0][6] === (expectedStatus === 'PUBLISHED' ? publicationId : 'NULL'),
  '经营期间数据库绑定不完整')
  const activeCollections = collectionRows.filter((row) => row[2] === 'CONFIRMED')
  requireFact(activeCollections.length === 2 &&
    new Set(activeCollections.map((row) => row[1])).size === 2 &&
    activeCollections.every((row) => row[4] !== 'NULL' &&
      Number(row[5]) > 0),
  '经营收入/支出数据库正式快照不完整')
  requireFact(publicationRows.length === 1 && publicationRows[0][1] === publicationId &&
    publicationRows[0][2] === expectedStatus && publicationRows[0][3] === periodId &&
    publicationRows[0][4] === String(fixture.publicationId) &&
    factRows.length >= 2,
  '经营发布数据库主从事实不完整')
  if (expectedRows) {
    requireFact(expectedRows.length > 0 && factRows.length === expectedRows.length,
      '经营数据库对象事实数量与原始明细不一致')
    for (const expected of expectedRows) {
      const actual = factRows.filter((row) => row[4] === expected.sourceNo)
      requireFact(actual.length === 1 && actual[0][1] === expected.direction &&
        actual[0][2] === expected.itemCode && actual[0][3] === expected.reportScope &&
        sameMoney(actual[0][5], expected.amount) &&
        actual[0][6] === (expected.allocationBasis ?? 'NULL'),
      '经营数据库对象事实未按原始来源、金额和分摊依据精确保存')
    }
  }
  if (expectedAmounts) {
    requireFact(['revenue', 'salesCost', 'operatingExpense', 'operatingProfit']
      .every((key, index) => sameMoney(publicationRows[0][index + 6], expectedAmounts[key])),
    '经营数据库发布金额与原始断言不一致')
  }
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'cost-operating-formal-closure',
    ...result
  }]
  return { periodRows, collectionRows, publicationRows, factRows }
}

const readOperatingActors = async ({
  fixture, reviewer, caseRecord, readSql = runReadOnlySql, expectedStatus = 'CONFIRMED'
}) => {
  const publicationId = exactId(fixture.operatingPublicationId, '经营发布')
  const result = await readSql(`
    SELECT CAST(id AS CHAR), status, CAST(calculated_by AS CHAR),
      CAST(confirmed_by AS CHAR), CAST(published_by AS CHAR)
    FROM cost_operating_publication
    WHERE tenant_id=1 AND id=${publicationId} AND deleted=b'0'
  `)
  requireFact(result.available && result.rows.length === 1,
    '经营计算批次缺少审批主体只读数据库证据')
  const row = result.rows[0]
  requireFact(row[0] === publicationId && row[1] === expectedStatus &&
    row[2] !== 'NULL' && row[2] !== String(reviewer.userId) &&
    row[3] === String(reviewer.userId) &&
    (expectedStatus !== 'PUBLISHED' || row[4] === String(reviewer.userId)),
  `经营计算主体不符合双人控制：${JSON.stringify(row)}`)
  caseRecord.database = [...(caseRecord.database || []), {
    stage: `cost-operating-actors-${expectedStatus.toLowerCase()}`,
    ...result
  }]
  return row
}

const verifyInvalidExpenseBasis = async ({
  api, reviewer, fixture, period, income, expenseRows, record, caseRecord,
  readSql = runReadOnlySql
}) => {
  const invalidRows = expenseRows.map((row) => row.reportScope === '销售成本'
    ? row
    : { ...row, allocationBasis: 'MANUAL:0|CFOR-E2E无效分摊依据反例' })
  const invalidExpense = await confirmDirection({
    api, fixture, period, direction: 'EXPENSE', rows: invalidRows, record
  })
  const costPublication = await readCostPublicationTrace({ api, fixture })
  const requestId = (action) => costOperatingRequestId({
    caseId: fixture.caseId, runId: record.runId, periodId: fixture.periodId, action
  })
  dataOf(await api.postBusiness(`/cost/periods/${fixture.periodId}/operating-calculation`,
    undefined, { headers: {
      'X-Request-Id': requestId('invalid-basis-calculate'),
      'X-Input-Hash': digestJson([
        income.collection.snapshotHash, invalidExpense.collection.snapshotHash,
        costPublication.trace.resultHash
      ]),
      'If-Match': String(period.version)
    } }), '无效分摊依据反例经营计算')
  const calculation = dataOf(
    await api.getBusiness(`/cost/periods/${fixture.periodId}/operating-calculation`),
    '无效分摊依据反例计算回读'
  )
  const publicationId = exactId(calculation.id, '无效分摊依据反例批次')
  requireFact(calculation.status === 'CALCULATED' &&
    calculation.rows?.length === invalidRows.length + income.collection.rows.length,
  '无效分摊依据反例未形成真实非空计算')
  dataOf(await reviewer.api.postBusiness(
    `/cost/operating-calculations/${publicationId}/confirm`, undefined, { headers: {
      'X-Request-Id': requestId('invalid-basis-confirm'),
      'X-Input-Hash': calculation.resultHash,
      'If-Match': String(period.version)
    } }), '无效分摊依据反例独立复核确认')
  const snapshotSql = `
    SELECT 'period', CAST(id AS CHAR), CAST(current_operating_publication_id AS CHAR),
      CAST(version AS CHAR) FROM cost_period WHERE tenant_id=1 AND id=${fixture.periodId};
    SELECT 'publication', CAST(id AS CHAR), status, result_hash,
      CAST(confirmed_by AS CHAR), CAST(published_by AS CHAR)
      FROM cost_operating_publication WHERE tenant_id=1 AND id=${publicationId};
    SELECT 'fact', CAST(id AS CHAR), SHA2(CAST(payload_json AS CHAR), 256)
      FROM cost_operating_object_fact
      WHERE tenant_id=1 AND publication_id=${publicationId} ORDER BY id
  `
  const before = await readSql(snapshotSql)
  requireFact(before.available &&
    before.rows.filter((row) => row[0] === 'fact').length === calculation.rows.length,
  '无效分摊依据反例缺少数据库主从事实')
  const expected = { code: 422001, message: '经营发布缺少有效分摊基数：办公室租金' }
  const rejection = await reviewer.api.request('POST',
    `/cost/periods/${fixture.periodId}/operating-publications`, undefined, {
      headers: {
        'X-Request-Id': requestId('invalid-basis-publish'),
        'X-Input-Hash': calculation.resultHash,
        'If-Match': String(period.version)
      },
      expectedBusinessRejection: expected
    })
  const after = await readSql(snapshotSql)
  const active = await api.getBusiness(`/cost/periods/${fixture.periodId}/operating-publication`)
  addCheck(caseRecord, COST_OPERATING_CHECKS.invalidBasis,
    matchesExpectedBusinessRejection(rejection, expected) && after.available &&
      JSON.stringify(before.rows) === JSON.stringify(after.rows) &&
      active.code === 0 && active.data == null,
    `invalidPublication=${publicationId}; code=${rejection.code}; ` +
      'MANUAL:0被拒绝，期间/已确认反例批次/非空对象事实均未改变')
  caseRecord.database.push({ stage: 'invalid-basis-before', ...before },
    { stage: 'invalid-basis-after', ...after })
  const reason = `CFOR-E2E ${fixture.caseId} ${fixture.suffix} 修正专属分摊依据反例`
  dataOf(await api.postBusiness(
    `/cost/periods/${fixture.periodId}/operating-collections/EXPENSE/rollback`,
    { reason }, { headers: {
      'X-Request-Id': requestId('invalid-basis-collection-rollback'),
      'X-Input-Hash': digestJson(['EXPENSE', reason, invalidExpense.collection.snapshotHash]),
      'If-Match': String(period.version)
    } }), '无效分摊依据反例归集正式回退')
  const rolledBack = await api.getBusiness(
    `/cost/periods/${fixture.periodId}/operating-collections?direction=EXPENSE`
  )
  requireFact(rolledBack.code === 0 && rolledBack.data == null,
    '无效分摊依据反例归集正式回退后仍活动')
  fixture.invalidBasisPublicationId = publicationId
}

export function inspectOperatingPublication (publication, { requirePublished = true } = {}) {
  const rows = Array.isArray(publication?.rows) ? publication.rows : []
  const invalid = []
  if (!publication || typeof publication !== 'object') invalid.push('publication为空')
  if (requirePublished && publication?.status !== 'PUBLISHED') invalid.push('状态不是PUBLISHED')
  if (!String(publication?.id || '').match(/^[1-9]\d*$/)) invalid.push('缺少精确经营发布ID')
  if (!String(publication?.periodId || '').match(/^[1-9]\d*$/)) invalid.push('缺少精确期间ID')
  if (!String(publication?.costPublicationId || '').match(/^[1-9]\d*$/)) {
    invalid.push('缺少精确成本发布引用')
  }
  if (rows.length === 0) invalid.push('正式经营对象事实为空')
  for (const [index, row] of rows.entries()) {
    if (!row?.itemCode || !row.itemName || !row.direction || !row.reportScope) {
      invalid.push(`row[${index}]业务字段缺失`)
    }
    if (!Number.isFinite(Number(row?.amount))) invalid.push(`row[${index}]金额缺失`)
  }
  return { valid: invalid.length === 0, rows, invalid }
}

export function inspectOperatingExpenseFacts (publication) {
  const inspected = inspectOperatingPublication(publication)
  const expenseRows = inspected.rows.filter((row) =>
    row.direction === 'EXPENSE' && row.reportScope !== '销售成本' && row.affectsProfit !== false
  )
  const invalid = [...inspected.invalid]
  if (expenseRows.length === 0) invalid.push('没有非销售成本经营费用事实')
  for (const [index, row] of expenseRows.entries()) {
    const basis = String(row.allocationBasis || '')
    const amount = Number(basis.split(':')[1]?.split('|')[0])
    if (!/^(REVENUE|HEADCOUNT|AREA|MANUAL):/.test(basis) ||
        !Number.isFinite(amount) || amount <= 0) {
      invalid.push(`expense[${index}]分摊依据不是有效正数`)
    }
  }
  return { valid: invalid.length === 0, expenseRows, invalid }
}

export const verifyOperatingPage = async (
  { page, fixture, outputDir, record, caseRecord },
  dependencies = {}
) => {
  const periodId = exactId(fixture.periodId, '经营页面期间')
  const readySelector = `.operating-collection-workspace[data-period-id="${periodId}"][data-loaded="true"]`
  const formalRequests = []
  const requestListener = (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes(`/cost/periods/${periodId}/operating-`)) {
      formalRequests.push({ method: request.method(), pathname })
    }
  }
  page.on('request', requestListener)
  try {
    fs.mkdirSync(outputDir, { recursive: true })
    await (dependencies.openRoute || openRoute)(page, `/cost-management/monthly/operating-income-expense?periodId=${periodId}`, {
      readySelector,
      retries: 1
    })
    const root = page.locator(readySelector)
    await root.waitFor({ state: 'visible' })
    const renderedPeriodId = await root.getAttribute('data-period-id')
    const loaded = await root.getAttribute('data-loaded')
    const text = await root.innerText()
    const markerVisible = text.includes(fixture.suffix) ||
      text.includes(`CFOR-E2E-${fixture.caseId}`)
    const pageFormal = renderedPeriodId === periodId && loaded === 'true' &&
      formalRequests.some((request) => request.method === 'GET' &&
      request.pathname.endsWith('/operating-collections')) && markerVisible
    const observation = {
      periodId,
      requestedPeriodId: periodId,
      renderedPeriodId,
      loaded,
      formalRequests,
      markerVisible,
      textLength: text.length
    }
    caseRecord.evidence.push(`经营页面观察：${JSON.stringify(observation)}`)
    fs.writeFileSync(`${outputDir}/${fixture.caseId.toLowerCase()}-operating-page.txt`, text)
    await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, `${fixture.caseId.toLowerCase()}-operating-closure`, record
    )
    return { passed: pageFormal, observation }
  } catch (error) {
    const failure = JSON.stringify({
      periodId: fixture.periodId,
      formalRequests,
      error: String(error.message || error)
    })
    caseRecord.evidence.push(`经营页面验证异常：${failure}`)
    addObservedCheck(caseRecord, COST_OPERATING_CHECKS.page, false, failure)
    throw error
  } finally {
    page.off('request', requestListener)
  }
}

const rollbackOperatingPublication = async ({ api, fixture, publication, period, record }) => {
  const reason = `CFOR-E2E ${fixture.caseId} ${record.runId} 专属经营发布回退`
  const inputHash = digestJson([publication.resultHash, reason])
  const rolledBack = dataOf(
    await api.postBusiness(`/cost/operating-publications/${exactId(publication.id, '经营发布')}/rollback`, {
      reason
    }, {
      headers: {
        'X-Request-Id': costOperatingRequestId({
          caseId: fixture.caseId, runId: record.runId, periodId: fixture.periodId,
          action: 'publication-rollback'
        }),
        'X-Input-Hash': inputHash,
        'If-Match': String(period.version)
      }
    }),
    '经营发布回退'
  )
  requireFact(rolledBack.status === period.status, '经营发布回退响应状态不一致')
  const afterPeriod = await readPeriod(api, fixture.periodId)
  const afterPublication = await api.getBusiness(
    `/cost/periods/${fixture.periodId}/operating-publication`
  )
  requireFact(afterPeriod.currentOperatingPublicationId == null &&
    afterPublication.code === 0 &&
    afterPublication.data == null,
  '经营发布回退后期间仍绑定活动正式事实')
  return { afterPeriod, afterPublication }
}

export async function runCostOperatingClosure (
  { api, page, record, caseRecord, outputDir },
  dependencies = {}
) {
  requireFact(['COST-005', 'COST-008'].includes(caseRecord.id), '错误的经营闭环案例')
  caseRecord.fixtures ||= {}
  delete caseRecord.fixtures.costOperating
  assertCostOperatingTarget(record, dependencies)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)

  // published scenarios are otherwise reusable within one runner. Each
  // original case must own its own period/model and formal operating facts.
  resetCostScenarioCache()
  let fixture
  let reviewer
  let closureError
  try {
  fixture = await (dependencies.prepareCostScenario || prepareCostScenario)({
    api,
    record,
    caseRecord,
    scenario: 'published'
  })
  requireFact(fixture.caseId === caseRecord.id &&
    fixture.runId === record.runId &&
    fixture.tenantId === '1' &&
    fixture.periodId && fixture.modelId &&
    fixture.remark.startsWith(`CFOR-E2E:costScenario:published:${record.runId}:`),
  '经营场景夹具不是本轮专属远期模型/期间')

  const refreshIncome = await refreshDirection({ api, fixture, direction: 'INCOME' })
  const refreshExpense = await refreshDirection({ api, fixture, direction: 'EXPENSE' })
  addCheck(caseRecord, COST_OPERATING_CHECKS.refresh,
    refreshIncome.rowCount === 0 && refreshExpense.rowCount === 0,
    `incomeRows=${refreshIncome.rowCount}; expenseRows=${refreshExpense.rowCount}; ` +
      '专属远期期间无外部业务来源，随后只使用正式手工录入入口建立可追溯样本')

  const initialPeriod = await readPeriod(api, fixture.periodId)
  const incomeRows = [manualRow({ fixture, direction: 'INCOME', amount: 2000 })]
  const expenseRows = [manualRow({ fixture, direction: 'EXPENSE', amount: 200 })]
  if (caseRecord.id === 'COST-008') {
    expenseRows.push({
      ...manualRow({ fixture, direction: 'EXPENSE', amount: 500 }),
      rowId: `${fixture.caseId}-${fixture.suffix}-SALES-COST`,
      itemCode: `E2E-OP-SALES-COST-${fixture.suffix}`,
      itemName: 'E2E销售成本手工测试样本',
      reportScope: '销售成本',
      sourceNo: `CFOR-E2E-${fixture.caseId}-${fixture.suffix}-SALES-COST`,
      allocationBasis: null
    })
  }
  const expectedRows = [...incomeRows, ...expenseRows]
  const expectedAmounts = {
    revenue: 2000, salesCost: caseRecord.id === 'COST-008' ? 500 : 0,
    operatingExpense: 200, operatingProfit: caseRecord.id === 'COST-008' ? 1300 : 1800
  }
  const income = await confirmDirection({
    api, fixture, period: initialPeriod, direction: 'INCOME', rows: incomeRows, record
  })
  if (caseRecord.id === 'COST-008') {
    reviewer = await (dependencies.createOperatingReviewer || createOperatingReviewer)({
      api, record, fixture
    })
    await verifyInvalidExpenseBasis({
      api, reviewer, fixture, period: initialPeriod, income, expenseRows, record,
      caseRecord, readSql: dependencies.readSql
    })
  }
  const expense = await confirmDirection({
    api, fixture, period: initialPeriod, direction: 'EXPENSE', rows: expenseRows, record
  })
  addCheck(caseRecord, COST_OPERATING_CHECKS.collections,
    income.collection.rows.length === incomeRows.length &&
      expense.collection.rows.length === expenseRows.length &&
      income.collection.status === 'CONFIRMED' && expense.collection.status === 'CONFIRMED',
    `income=${income.collection.id}; expense=${expense.collection.id}`)

  const costPublication = await readCostPublicationTrace({ api, fixture })
  const sourceHash = digestJson([
    income.collection.snapshotHash,
    expense.collection.snapshotHash,
    costPublication.trace.resultHash
  ])
  const calculationResponse = dataOf(await api.postBusiness(
    `/cost/periods/${fixture.periodId}/operating-calculation`,
    undefined,
    {
      headers: {
        'X-Request-Id': costOperatingRequestId({
          caseId: fixture.caseId, runId: record.runId, periodId: fixture.periodId,
          action: 'calculate'
        }),
        'X-Input-Hash': sourceHash,
        'If-Match': String(initialPeriod.version)
      }
    }
  ), '经营计算')
  const calculation = dataOf(
    await api.getBusiness(`/cost/periods/${fixture.periodId}/operating-calculation`),
    '经营计算回读'
  )
  fixture.operatingPublicationId = exactId(calculation.id, '经营计算批次')
  requireFact(calculationResponse.resultHash === calculation.resultHash &&
    calculation.status === 'CALCULATED' &&
    String(calculation.periodId) === fixture.periodId &&
    String(calculation.costPublicationId) === costPublication.publicationId &&
    Array.isArray(calculation.rows) &&
    calculation.rows.length === expectedRows.length &&
    sameMoney(calculation.revenue, 2000) &&
    sameMoney(calculation.salesCost, expectedAmounts.salesCost) &&
    sameMoney(calculation.operatingExpense, 200) &&
    sameMoney(calculation.operatingProfit, expectedAmounts.operatingProfit),
  '经营计算未按收入/费用原始事实计算出非空精确结果')
  addCheck(caseRecord, COST_OPERATING_CHECKS.calculation,
    /^[a-f\d]{64}$/i.test(calculation.resultHash) &&
      calculation.rows.length > 0 &&
      String(calculation.costPublicationId) === costPublication.publicationId,
    `operating=${fixture.operatingPublicationId}; costPublication=${costPublication.publicationId}; ` +
      `resultHash=${calculation.resultHash}`)

  reviewer ||= await (dependencies.createOperatingReviewer || createOperatingReviewer)({
    api, record, fixture
  })
  const requestId = (action) => costOperatingRequestId({
    caseId: fixture.caseId, runId: record.runId, periodId: fixture.periodId, action
  })
    const beforeConfirmPublish = await reviewer.api.request(
      'POST',
      `/cost/periods/${fixture.periodId}/operating-publications`,
      undefined,
      {
        headers: {
          'X-Request-Id': requestId('publish-before-confirm'),
          'X-Input-Hash': calculation.resultHash,
          'If-Match': String(initialPeriod.version)
        },
        expectedBusinessRejection: {
          code: 422001,
          message: '只有已确认经营计算可以发布'
        }
      }
    )
    requireFact(matchesExpectedBusinessRejection(beforeConfirmPublish, {
      code: 422001,
      message: '只有已确认经营计算可以发布'
    }), '未确认经营计算时发布没有被精确阻断')

    const confirmed = dataOf(await reviewer.api.request(
      'POST',
      `/cost/operating-calculations/${fixture.operatingPublicationId}/confirm`,
      undefined,
      {
        headers: {
          'X-Request-Id': requestId('confirm'),
          'X-Input-Hash': calculation.resultHash,
          'If-Match': String(initialPeriod.version)
        }
      }
    ), '人工确认经营计算')
    requireFact(confirmed.status === initialPeriod.status, '人工确认经营计算响应期间状态异常')
    const confirmedCalculation = dataOf(
      await api.getBusiness(`/cost/periods/${fixture.periodId}/operating-calculation`),
      '人工确认经营计算回读'
    )
    requireFact(confirmedCalculation.status === 'CONFIRMED',
      '人工确认没有形成CONFIRMED经营计算正式事实')
    const confirmedActors = await readOperatingActors({
      fixture,
      reviewer,
      caseRecord,
      readSql: dependencies.readSql,
      expectedStatus: 'CONFIRMED'
    })

    const published = dataOf(await reviewer.api.request(
      'POST',
      `/cost/periods/${fixture.periodId}/operating-publications`,
      undefined,
      {
        headers: {
          'X-Request-Id': requestId('publish'),
          'X-Input-Hash': calculation.resultHash,
          'If-Match': String(initialPeriod.version)
        }
      }
    ), '正式经营发布')
    const publication = dataOf(
      await api.getBusiness(`/cost/periods/${fixture.periodId}/operating-publication`),
      '正式经营发布回读'
    )
    const inspected = inspectOperatingPublication(publication)
    requireFact(published.resultHash === publication.resultHash &&
      publication.status === 'PUBLISHED' &&
      String(publication.id) === fixture.operatingPublicationId &&
      inspected.valid &&
      sameMoney(publication.revenue, 2000) &&
      sameMoney(publication.salesCost, expectedAmounts.salesCost) &&
      sameMoney(publication.operatingExpense, 200) &&
      sameMoney(publication.operatingProfit, expectedAmounts.operatingProfit),
    `正式经营发布事实不完整：${inspected.invalid.join('|')}`)
    addCheck(caseRecord, COST_OPERATING_CHECKS.confirmationGate,
      matchesExpectedBusinessRejection(beforeConfirmPublish, {
        code: 422001,
        message: '只有已确认经营计算可以发布'
      }) && confirmedCalculation.status === 'CONFIRMED',
      `preConfirmCode=${beforeConfirmPublish.code}; confirmedBy=${confirmedActors[3]}`)
    addCheck(caseRecord, COST_OPERATING_CHECKS.publication,
      inspected.valid && publication.rows.length > 0 &&
        String(publication.costPublicationId) === costPublication.publicationId,
      `publication=${publication.id}; rows=${publication.rows.length}; ` +
        `revenue=${publication.revenue}; salesCost=${publication.salesCost}; ` +
        `operatingExpense=${publication.operatingExpense}; operatingProfit=${publication.operatingProfit}`)

    if (caseRecord.id === 'COST-008') {
      const allocation = inspectOperatingExpenseFacts(publication)
      addCheck(caseRecord, COST_OPERATING_CHECKS.allocationBasis, allocation.valid,
        `expenseRows=${allocation.expenseRows.length}; invalid=${allocation.invalid.join('|') || 'none'}`)
      const salesRows = publication.rows.filter((row) => row.reportScope === '销售成本')
      addCheck(caseRecord, COST_OPERATING_CHECKS.salesCost,
        salesRows.length === 1 && salesRows[0].allocationBasis == null &&
          sameMoney(salesRows[0].amount, 500) && sameMoney(publication.salesCost, 500) &&
          sameMoney(publication.operatingExpense, 200) &&
          !allocation.expenseRows.includes(salesRows[0]),
        '销售成本500无分摊依据；正式经营费用200；经营利润1300；销售成本不重复计入经营费用')
    }

    await readOperatingActors({
      fixture, reviewer, caseRecord, readSql: dependencies.readSql,
      expectedStatus: 'PUBLISHED'
    })
    const beforeSql = await readOperatingSql({
      fixture, caseRecord, readSql: dependencies.readSql, expectedRows, expectedAmounts
    })
    const pageEvidence = await (dependencies.verifyPage || verifyOperatingPage)({
      page, fixture, outputDir, record, caseRecord
    })
    addObservedCheck(caseRecord, COST_OPERATING_CHECKS.page, pageEvidence.passed,
      JSON.stringify(pageEvidence.observation))

    const beforeRollbackPeriod = await readPeriod(api, fixture.periodId)
    let rollbackEvidence = null
    if (caseRecord.id === 'COST-005') {
      rollbackEvidence = await rollbackOperatingPublication({
        api, fixture, publication, period: beforeRollbackPeriod, record
      })
      const afterSql = await readOperatingSql({
        fixture, caseRecord, readSql: dependencies.readSql,
        expectedStatus: 'ROLLED_BACK', expectedRows, expectedAmounts
      })
      addCheck(caseRecord, COST_OPERATING_CHECKS.rollback,
        rollbackEvidence.afterPeriod.currentOperatingPublicationId == null &&
          afterSql.factRows.length === publication.rows.length &&
          afterSql.publicationRows[0][2] === 'ROLLED_BACK' &&
          JSON.stringify(afterSql.factRows) === JSON.stringify(beforeSql.factRows) &&
          afterSql.publicationRows[0][5] === beforeSql.publicationRows[0][5] &&
          afterSql.publicationRows[0].slice(6).join('|') ===
            beforeSql.publicationRows[0].slice(6).join('|'),
        `publication=${fixture.operatingPublicationId}; factsPreserved=${afterSql.factRows.length}`)
    }

    caseRecord.fixtures.costOperating = {
      complete: false,
      caseId: caseRecord.id,
      runId: record.runId,
      tenantId: fixture.tenantId,
      periodId: fixture.periodId,
      month: fixture.month,
      modelId: fixture.modelId,
      costPublicationId: costPublication.publicationId,
      operatingPublicationId: fixture.operatingPublicationId,
      published: caseRecord.id === 'COST-008',
      pageFormal: pageEvidence.passed
    }
    caseRecord.evidence.push(
      `经营正式闭环：period=${fixture.periodId}; month=${fixture.month}; ` +
      `costPublication=${costPublication.publicationId}; operating=${fixture.operatingPublicationId}`
    )
  } catch (error) {
    closureError = error
    throw error
  } finally {
    fixture ||= caseRecord.fixtures?.costScenario
    const cleanupErrors = []
    if (reviewer?.api) {
      try { await reviewer.api.postBusiness('/system/auth/logout') } catch (error) {
        cleanupErrors.push(`operatingReviewer logout: ${String(error.message || error)}`)
      }
    }
    for (const key of ['operatingReviewer', 'reviewer', 'approvalReviewer']) {
      if (!fixture) break
      await (dependencies.cleanupReviewer || cleanupCostScenarioReviewer)({
        api, fixture, key
      }).catch((error) => {
        cleanupErrors.push(`成本经营专属${key}清理失败：${String(error.message || error)}`)
      })
    }
    caseRecord.notes.push(...cleanupErrors)
    const recordCleanup = closureError ? addObservedCheck : addCheck
    recordCleanup(caseRecord, COST_OPERATING_CHECKS.cleanup, cleanupErrors.length === 0,
      cleanupErrors.join('; ') || '专属复核账号与角色已清理；远期正式模型、期间、归集与经营事实保留，不做SQL业务删除')
  }
  caseRecord.fixtures.costOperating.complete = operatingChecksComplete(caseRecord)
  const complete = hasCostOperatingEvidence(caseRecord)
  return {
    acceptanceComplete: complete,
    partial: !complete,
    note: complete
      ? 'COST-005/008正式经营写侧与页面事实均已闭环'
      : '经营闭环缺少本轮专属正式事实、具名检查或页面证据，不登记完整通过'
  }
}
