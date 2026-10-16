import { createHash } from 'node:crypto'

import { isBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { isCostOpeningFixtureMonth } from './cost-model.mjs'

export const COST_OPENING_BROWSER_ASSERTION =
  '页面改读后端正式 API，浏览器状态只保留未提交草稿'

export const COST_OPENING_BROWSER_CHECKS = Object.freeze({
  formal: 'COST-002 浏览器按本轮正式模型和月份精确读取期初在制并展示同一后端行',
  cancel: 'COST-002 未提交期初表单取消后页面正式行及完整 API/SQL 不变',
  refresh: 'COST-002 未提交期初表单刷新后丢弃草稿并重新读取同一正式行',
  boundary: 'COST-002 浏览器无成本写请求且共享 workspace 完整只读快照不变'
})

// Missing adapters must remain a GAP, never fall back to shared browser state.
export const COST_OPENING_BROWSER_SOURCE_GAPS = Object.freeze([
  '缺少通过真实正式模型及期间选择器操作的浏览器适配器',
  '缺少从正式页面可见行读取精确 ID、存货、成本中心及金额的浏览器适配器'
])

export class CostOpeningBrowserGap extends Error {
  constructor (gaps) {
    super(`GAP: COST-002 浏览器闭环不能安全接线：${gaps.join('；')}`)
    this.name = 'CostOpeningBrowserGap'
    this.gaps = [...gaps]
  }
}

const need = (condition, message) => {
  if (!condition) throw new Error(`COST-002 browser: ${message}`)
}
const id = (value, label) => {
  need(typeof value === 'string' && /^[1-9]\d*$/.test(value) &&
    BigInt(value) <= 9223372036854775807n, `${label}必须为精确字符串 ID`)
  return value
}
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const number = (value, label) => {
  need(value != null && value !== '' &&
    ['number', 'string'].includes(typeof value) && Number.isFinite(Number(value)),
  `${label}缺少有效数值`)
  return Number(value)
}
const data = (payload, label) => {
  need(isBusinessSuccess(payload), `${label}正式 API 读取失败`)
  return payload.data
}
const addCheck = (caseRecord, name, passed, details) => {
  caseRecord.checks ||= []
  caseRecord.checks.push({ name, passed: passed === true, details })
}
const amountFields = [
  'quantity', 'materialAmount', 'laborAmount', 'expenseAmount', 'totalAmount', 'unitCost'
]
const columnOf = (field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const statusText = { DRAFT: '草稿', REVERSED: '首次期间已回退至试算' }

function ownedFixture (fixture, record) {
  const modelId = fixture?.modelId || fixture?.modelVersionId
  need(fixture?.tenantId === '1' && record?.environment?.tenantId === '1' &&
    record.environment.target === 'local' &&
    fixture.scenario === 'accounting' && fixture.runId === record.runId &&
    /^[A-Za-z0-9_-]+$/.test(record.runId) && /^[A-Z0-9]+$/.test(fixture.suffix || ''),
  '缺少本轮租户 1 accounting 专属夹具')
  for (const [field, value] of [
    ['periodId', fixture?.periodId], ['modelId', modelId], ['costCenterId', fixture?.costCenterId]
  ]) id(value, field)
  need(isCostOpeningFixtureMonth(fixture.month) &&
    fixture.effectiveMonth === fixture.month &&
    fixture.modelId === modelId &&
    fixture.versionNo === `E2E-SC-ACCOUNTING-${fixture.suffix}` &&
    fixture.remark === `CFOR-E2E:costScenario:accounting:${record.runId}:` +
      `${fixture.suffix}:tenant=1:org=1:month=${fixture.month}`,
  '本轮未来月份、模型版本或所有权标记不匹配')
}

async function readApi (api, fixture, openingRow) {
  const model = data(await api.getBusiness(`/cost/model-versions/${fixture.modelId}`), '模型')
  const period = data(await api.getBusiness(`/cost/periods/${fixture.periodId}`), '期间')
  const center = data(await api.getBusiness(`/cost/centers/${fixture.costCenterId}`), '成本中心')
  const rows = data(await api.getBusiness(
    `/cost/periods/${fixture.periodId}/opening-wip?stage=OPENING`
  ), '期初在制')
  need(model && id(model.id, '模型') === fixture.modelId &&
    String(model.accountingOrgId) === '1' && model.versionNo === fixture.versionNo &&
    model.effectiveMonth === fixture.month && model.enterpriseType === 'MANUFACTURING' &&
    model.status === 'LOCKED' && model.remark === fixture.remark, '正式模型归属或状态漂移')
  need(period && id(period.id, '期间') === fixture.periodId &&
    String(period.accountingOrgId) === '1' && period.period === fixture.month &&
    id(period.modelVersionId, '期间模型') === fixture.modelId &&
    period.modelVersionNo === fixture.versionNo && period.enterpriseType === 'MANUFACTURING' &&
    period.status === 'ACCOUNTING' && period.currentPublicationId == null,
  '正式期间归属或状态漂移')
  need(center && id(center.id, '成本中心') === fixture.costCenterId &&
    String(center.accountingOrgId) === '1' && center.code === `E2E-SC-${fixture.suffix}` &&
    center.name === `E2E成本场景中心${fixture.suffix}` && center.remark === fixture.remark &&
    center.enabledAt === `${fixture.month}-01` && center.status === 'ENABLED',
  '本轮成本中心归属或状态漂移')
  need(Array.isArray(rows) && rows.length === 1, '本轮期初在制不是唯一正式行')
  const row = rows[0]
  id(row.id, '在制行')
  id(row.materialId, '物料')
  need(row.periodId === fixture.periodId && row.stage === 'OPENING' &&
    row.objectKey === `E2E-COST002-${fixture.suffix}` && row.remark === fixture.remark &&
    row.sourceType === 'MANUAL' && ['DRAFT', 'CONFIRMED', 'LOCKED', 'REVERSED'].includes(row.status) &&
    Number.isSafeInteger(row.version) && row.version >= 0 &&
    typeof row.productCode === 'string' && row.productCode.length > 0,
  '期初在制行所有权、身份或状态不匹配')
  for (const field of amountFields) number(row[field], field)
  if (row.costCenterCode || row.costCenterName) {
    need(row.costCenterCode === center.code && row.costCenterName === center.name,
      '期初行成本中心不是本轮专属中心')
  }
  need(number(row.quantity) > 0 && number(row.totalAmount) ===
    number(row.materialAmount) + number(row.laborAmount) + number(row.expenseAmount) &&
    Math.abs(number(row.unitCost) - number(row.totalAmount) / number(row.quantity)) <= 1e-10,
  '正式行金额或单位成本不一致')
  if (openingRow) need(equal(row, openingRow), '传入 opening 行与正式 API 全字段不一致')
  return { model, period, center, rows }
}

async function sqlRows (readSql, sql) {
  const result = await readSql(sql)
  need(result?.available === true && Array.isArray(result.rows), '完整只读 SQL 证据不可用')
  return result.rows
}

async function fullRows (readSql, table, where) {
  const columns = await sqlRows(readSql, `SELECT COLUMN_NAME, DATA_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`)
  need(columns.length > 0 && columns.every((row) => row.length === 2 &&
    /^[a-z][a-z0-9_]*$/.test(row[0]) && typeof row[1] === 'string') &&
    new Set(columns.map(([key]) => key)).size === columns.length &&
    ['id', 'tenant_id', 'deleted'].every((key) => columns.some(([name]) => key === name)),
  `${table}完整字段元数据无效`)
  const fields = columns.map(([key, type]) =>
    `'${key}',CAST(${type.toLowerCase() === 'bit' ? `CAST(\`${key}\` AS UNSIGNED)` : `\`${key}\``} AS CHAR)`)
  const rows = await sqlRows(readSql, `SELECT JSON_OBJECT(${fields.join(',')})
    FROM \`${table}\` WHERE tenant_id = 1 AND (${where}) ORDER BY id`)
  const values = rows.map((row) => {
    need(row.length === 1, `${table}完整行 JSON 结构无效`)
    const value = JSON.parse(row[0])
    need(value && equal(Object.keys(value).sort(), columns.map(([key]) => key).sort()) &&
      value.tenant_id === '1', `${table}完整行缺字段或租户漂移`)
    id(value.id, `${table}.id`)
    return value
  })
  need(new Set(values.map((row) => row.id)).size === values.length, `${table}重复 ID`)
  return { columns, rows: values }
}

async function snapshot ({ api, fixture, openingRow, readSql }) {
  const facts = await readApi(api, fixture, openingRow)
  const sql = {
    model: await fullRows(readSql, 'cost_model_version', `id = ${fixture.modelId}`),
    period: await fullRows(readSql, 'cost_period', `id = ${fixture.periodId}`),
    center: await fullRows(readSql, 'cost_center', `id = ${fixture.costCenterId}`),
    opening: await fullRows(readSql, 'cost_opening_wip_record', `period_id = ${fixture.periodId}`),
    workspace: await fullRows(readSql, 'cost_workspace_state', 'accounting_org_id = 1')
  }
  const onlyActive = (entry, label) => {
    const rows = entry.rows.filter((row) => row.deleted === '0')
    need(rows.length === 1, `${label}SQL 活动行不唯一`)
    return rows[0]
  }
  const model = onlyActive(sql.model, '模型')
  const period = onlyActive(sql.period, '期间')
  const center = onlyActive(sql.center, '成本中心')
  const row = onlyActive(sql.opening, '期初')
  need(model.id === fixture.modelId && model.accounting_org_id === '1' &&
    model.version_no === fixture.versionNo && model.effective_month === fixture.month &&
    model.status === facts.model.status && model.remark === fixture.remark,
  '模型 SQL/API 不一致')
  need(period.id === fixture.periodId && period.accounting_org_id === '1' &&
    period.model_version_id === fixture.modelId && period.model_version_no === fixture.versionNo &&
    period.period === fixture.month && period.status === facts.period.status,
  '期间 SQL/API 不一致')
  need(center.id === fixture.costCenterId && center.accounting_org_id === '1' &&
    center.center_code === facts.center.code && center.center_name === facts.center.name &&
    center.status === facts.center.status && center.remark === fixture.remark,
  '成本中心 SQL/API 不一致')
  for (const field of [
    'id', 'periodId', 'stage', 'objectKey', 'materialId', 'productCode', 'costCenterCode',
    'costCenterName', 'sourceType', 'remark', 'status', 'version'
  ]) {
    need(Object.hasOwn(row, columnOf(field)) &&
      (row[columnOf(field)] ?? null) ===
        (facts.rows[0][field] == null ? null : String(facts.rows[0][field])),
    `期初 SQL/API ${field} 不一致`)
  }
  for (const field of amountFields) {
    need(number(row[columnOf(field)], `SQL ${field}`) === number(facts.rows[0][field], field),
      `期初 SQL/API ${field} 不一致`)
  }
  return { facts, sql, apiHash: hash(facts), sqlHash: hash(sql) }
}

export function costOpeningBrowserReadiness (fixture, row, browserActions = {}) {
  const gaps = []
  if (!row?.costCenterCode || !row.costCenterName) {
    gaps.push('本轮 opening payload 缺 costCenterCode/costCenterName，页面中心筛选无法显示该正式行')
  }
  if (!['DRAFT', 'REVERSED'].includes(row?.status)) {
    gaps.push('需在 DRAFT 确认前接线，或在 REVERSED 回读后接线；CONFIRMED/LOCKED 不允许手工草稿')
  }
  if (typeof browserActions.selectFormalContext !== 'function' ||
      typeof browserActions.observeFormalRow !== 'function') {
    gaps.push(...COST_OPENING_BROWSER_SOURCE_GAPS)
  }
  return { ready: gaps.length === 0, gaps, periodId: fixture?.periodId, status: row?.status }
}

const defaultActions = {
  async editDraft ({ page, draft }) {
    const create = page.locator('.opening-wip-workspace')
      .getByRole('button', { name: '手工新增', exact: true })
    need(await create.count() === 1 && await create.isEnabled(), '手工新增不可用')
    await create.click()
    const dialog = page.locator('.el-dialog:has(.opening-wip-form):visible')
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    const quantity = dialog.locator('.el-form-item').filter({ hasText: '期初数量' }).locator('input')
    const remark = dialog.locator('.el-form-item').filter({ hasText: '备注' }).locator('input, textarea')
    need(await quantity.count() === 1 && await remark.count() === 1, '未提交表单输入框不唯一')
    need(number(await quantity.inputValue(), '新表单数量') === 1 &&
      await remark.inputValue() === '', '重新打开的表单泄漏上次未提交草稿')
    await quantity.fill(String(draft.quantity))
    await quantity.press('Tab')
    await remark.fill(draft.remark)
    return {
      dialogVisible: await dialog.isVisible(),
      quantity: number(await quantity.inputValue(), '草稿数量'),
      remark: await remark.inputValue()
    }
  },
  async cancelDraft ({ page }) {
    const dialog = page.locator('.el-dialog:has(.opening-wip-form):visible')
    need(await dialog.count() === 1, '取消前未提交表单不唯一')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10000 })
  },
  async refresh ({ page }) {
    await page.reload({ waitUntil: 'domcontentloaded' })
  },
  async dialogVisible ({ page }) {
    return await page.locator('.el-dialog:has(.opening-wip-form):visible').count() > 0
  },
  async flushUiTasks ({ page }) {
    // useCostRemoteStorage schedules a save after 350 ms.
    await page.waitForTimeout(750)
  }
}

function assertObservation (observation, fixture, row) {
  need(observation?.modelId === fixture.modelId && observation.versionNo === fixture.versionNo &&
    observation.month === fixture.month && observation.periodId === fixture.periodId &&
    observation.stage === 'OPENING', '页面正式模型/月/期间上下文不精确')
  const visible = observation.row
  need(observation.matchedRowCount === 1 && visible &&
    id(visible.backendId, '页面后端行') === row.id &&
    id(visible.materialId, '页面物料') === row.materialId &&
    ['productCode', 'costCenterCode', 'costCenterName']
      .every((field) => visible[field] === row[field]) &&
    visible.statusText === statusText[row.status], '页面正式行 ID、物料、中心或状态不匹配')
  for (const field of amountFields) {
    need(number(visible[field], `页面 ${field}`) === number(row[field], field),
      `页面正式行 ${field} 不一致`)
  }
}

/**
 * Call after the owned draft readback, before confirm; REVERSED is also readable.
 * selectFormalContext must use real model/month UI and await its real GET, never
 * mutate remote/local storage or inject Vue state. observeFormalRow must read
 * exact IDs from a product-owned DOM contract, not copy IDs from this fixture.
 * The optional browserActions overrides are for Node mocks or the real
 * adapter. They are not an alternative source of acceptance evidence.
 * Observation: { modelId, versionNo, month, periodId, stage, matchedRowCount,
 * row: { backendId, materialId, productCode, costCenterCode, costCenterName,
 * statusText, quantity, materialAmount, laborAmount, expenseAmount, totalAmount,
 * unitCost } }. statusText is the displayed Chinese label, not a fixture value.
 */
export async function verifyCostOpeningBrowserClosure ({
  api, page, fixture, openingRow, caseRecord, record, dependencies = {}
}) {
  fixture = {
    ...fixture,
    modelId: fixture?.modelId || fixture?.modelVersionId,
    month: fixture?.month || fixture?.effectiveMonth,
    effectiveMonth: fixture?.effectiveMonth || fixture?.month
  }
  ownedFixture(fixture, record)
  need(api && page && caseRecord?.id === 'COST-002', '缺少 API/页面/COST-002 案例记录')
  const readSql = dependencies.readSql || runReadOnlySql
  const actions = { ...defaultActions, ...(dependencies.browserActions || {}) }
  const before = await snapshot({ api, fixture, openingRow, readSql })
  const row = before.facts.rows[0]
  const readiness = costOpeningBrowserReadiness(fixture, row, actions)
  caseRecord.costOpeningBrowserEvidence = {
    assertionIndex: 5, assertion: COST_OPENING_BROWSER_ASSERTION, readiness,
    baseline: { apiHash: before.apiHash, sqlHash: before.sqlHash }, phases: []
  }
  if (!readiness.ready) {
    caseRecord.notes ||= []
    caseRecord.notes.push(`GAP: ${readiness.gaps.join('；')}`)
    throw new CostOpeningBrowserGap(readiness.gaps)
  }
  for (const method of ['on', 'off', 'route', 'unroute']) {
    need(typeof page[method] === 'function', `页面缺少 ${method}，不能验证真实请求边界`)
  }
  const evidence = caseRecord.costOpeningBrowserEvidence
  const mutations = []
  const errors = []
  const pending = []
  let formalReads = 0
  let currentCheck = COST_OPENING_BROWSER_CHECKS.formal
  const costUrl = (url) => {
    const parsed = new URL(url)
    return /\/cost\//.test(parsed.pathname) ? parsed : null
  }
  const guard = async (route) => {
    const request = route.request()
    const url = costUrl(request.url())
    if (url && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      mutations.push({ method: request.method(), pathname: url.pathname })
      await route.abort('blockedbyclient')
    } else {
      await route.fallback()
    }
  }
  const onResponse = (response) => {
    const url = costUrl(response.url())
    if (!url) return
    pending.push((async () => {
      need(response.status() >= 200 && response.status() < 300, '浏览器成本读取 HTTP 异常')
      const request = response.request()
      if (!/\/cost\/periods\/[^/]+\/opening-wip$/.test(url.pathname)) return
      need(request.method() === 'GET' &&
        url.pathname.endsWith(`/cost/periods/${fixture.periodId}/opening-wip`) &&
        url.searchParams.get('stage') === 'OPENING' &&
        request.headers()['tenant-id'] === '1', '浏览器期初请求期间、阶段或租户不精确')
      const payload = data(await response.json(), '浏览器期初')
      need(equal(payload, before.facts.rows), '浏览器正式响应与完整 API 基线不一致')
      formalReads++
    })().catch((error) => errors.push(error)))
  }
  const onPageError = (error) => errors.push(error)
  const onConsole = (message) => {
    if (message.type() === 'error') errors.push(new Error('浏览器控制台 error，不能作为正常页面证据'))
  }
  const onRequestFailed = (request) => {
    if (costUrl(request.url())) errors.push(new Error('浏览器成本请求失败，不能忽略读取异常'))
  }
  const settle = async () => {
    for (let index = 0; index < pending.length; index++) await pending[index]
    need(errors.length === 0, errors.map((error) => error.message).join('; '))
    need(mutations.length === 0, '发现成本写请求；已阻止转发，不能视为草稿隔离通过')
  }
  const phase = async (name, mustRead) => {
    const previousReads = formalReads
    if (mustRead) await actions.selectFormalContext({ page, fixture, phase: name })
    const observation = await actions.observeFormalRow({ page, fixture, phase: name })
    await actions.flushUiTasks({ page })
    await settle()
    if (mustRead) need(formalReads > previousReads, '缺少本阶段真实浏览器正式 API 响应')
    assertObservation(observation, fixture, row)
    need(await actions.dialogVisible({ page }) === false, '取消/刷新后未提交表单仍存在')
    const after = await snapshot({ api, fixture, openingRow: row, readSql })
    need(before.apiHash === after.apiHash && before.sqlHash === after.sqlHash,
      '完整正式事实或共享 workspace 在浏览器操作后改变')
    evidence.phases.push({ name, formalReads, apiHash: after.apiHash, sqlHash: after.sqlHash,
      rowId: observation.row.backendId, periodId: observation.periodId, month: observation.month })
    addCheck(caseRecord, currentCheck, true, `phase=${name}; id=${row.id}; period=${fixture.periodId}`)
  }
  const edit = async () => {
    const draft = { quantity: number(row.quantity) + 7,
      remark: `E2E-UNSUBMITTED-${record.runId}-${fixture.suffix}` }
    const observation = await actions.editDraft({ page, fixture, draft })
    need(observation?.dialogVisible === true &&
      number(observation.quantity, '未提交数量') === draft.quantity &&
      observation.remark === draft.remark, '没有实际填写并观测未提交草稿')
    await actions.flushUiTasks({ page })
    await settle()
    const during = await snapshot({ api, fixture, openingRow: row, readSql })
    need(before.apiHash === during.apiHash && before.sqlHash === during.sqlHash,
      '尚未取消/刷新时草稿已污染正式事实或共享 workspace')
  }
  let operationError
  let boundaryError
  await page.route('**/cost/**', guard)
  page.on('response', onResponse)
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  page.on('requestfailed', onRequestFailed)
  try {
    await phase('formal', true)
    currentCheck = COST_OPENING_BROWSER_CHECKS.cancel
    await edit()
    await actions.cancelDraft({ page })
    await phase('cancel', false)
    currentCheck = COST_OPENING_BROWSER_CHECKS.refresh
    await edit()
    await actions.refresh({ page })
    await phase('refresh', true)
  } catch (error) {
    operationError = error
    addCheck(caseRecord, currentCheck, false, error.message)
  } finally {
    try {
      const finalErrors = []
      try {
        await actions.flushUiTasks({ page })
        await settle()
      } catch (error) {
        finalErrors.push(error)
      }
      // Even a page/transport failure still requires a final independent readback.
      try {
        const after = await snapshot({ api, fixture, openingRow: row, readSql })
        evidence.final = { apiHash: after.apiHash, sqlHash: after.sqlHash }
        need(before.apiHash === after.apiHash && before.sqlHash === after.sqlHash,
          '结束时完整 API/SQL 不变性失败')
      } catch (error) {
        finalErrors.push(error)
      }
      if (finalErrors.length) throw new AggregateError(finalErrors,
        finalErrors.map((error) => error.message).join('; '))
      addCheck(caseRecord, COST_OPENING_BROWSER_CHECKS.boundary, true,
        `attemptedCostWrites=0; fullApiSqlUnchanged=true; formalReads=${formalReads}`)
    } catch (error) {
      boundaryError = error
      addCheck(caseRecord, COST_OPENING_BROWSER_CHECKS.boundary, false, error.message)
    } finally {
      evidence.attemptedMutations = mutations
      page.off('response', onResponse)
      page.off('pageerror', onPageError)
      page.off('console', onConsole)
      page.off('requestfailed', onRequestFailed)
      await page.unroute('**/cost/**', guard)
    }
  }
  if (operationError || boundaryError) {
    throw new AggregateError([operationError, boundaryError].filter(Boolean),
      [operationError?.message, boundaryError?.message].filter(Boolean).join('; '))
  }
  return evidence
}
