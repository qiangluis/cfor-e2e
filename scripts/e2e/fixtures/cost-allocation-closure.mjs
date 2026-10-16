import { randomUUID } from 'node:crypto'

import { config as defaultConfig } from '../config/index.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'

export const COST_ALLOCATION_CLOSURE_CHECKS = Object.freeze({
  fixture:
    'COST-001 专属未来月份模型、成本中心和构成项通过正式 API 创建并回读',
  saveReadback:
    'COST-001 正式 API 保存专属分摊规则后按模型版本、成本中心和生效月份精确回读',
  modes:
    'COST-001 三种基础分摊模式均通过正式接口保存并回读',
  invalidMode:
    'COST-001 非法分摊模式精确拒绝且正式规则值保持不变',
  browserRoute:
    'COST-001 成本分摊规则正式页面入口可达且展示专属模型对象',
  browserCancel:
    'COST-001 浏览器未提交草稿取消/离开后正式规则值不变',
  browserRefresh:
    'COST-001 浏览器未提交草稿刷新后正式规则值不变',
  browserModes:
    'COST-001 三种桌面宽度的七种模式均未遮挡且只修改未提交草稿',
  cleanup:
    'COST-001 专属夹具可清理资源清理成功且不可删除正式对象已登记审计保留'
})

export const COST_ALLOCATION_INVALID_MODE = Object.freeze({
  code: 422001,
  message: 'unsupported allocation mode'
})

// Keep the backend-supported enum separate from the three modes covered by
// COST-001. Factor modes need a factorSource and belong to COST-032.
export const COST_ALLOCATION_MODES = Object.freeze([
  'QUANTITY',
  'AMOUNT',
  'MANUAL',
  'LABOR_HOUR',
  'MACHINE_HOUR',
  'AREA',
  'OUTPUT'
])

export const COST_ALLOCATION_BASE_MODES = Object.freeze([
  'QUANTITY',
  'AMOUNT',
  'MANUAL'
])

export const COST_ALLOCATION_FACTOR_MODES = Object.freeze([
  'LABOR_HOUR',
  'MACHINE_HOUR',
  'AREA',
  'OUTPUT'
])

export const allocationModeEvidence = ({ savedModes = [], finalMode = null } = {}) => {
  const observedModes = [...new Set(savedModes.map((mode) => text(mode)).filter(Boolean))]
  return {
    supportedModes: [...COST_ALLOCATION_MODES],
    acceptanceModes: [...COST_ALLOCATION_BASE_MODES],
    factorModes: [...COST_ALLOCATION_FACTOR_MODES],
    observedModes,
    allAcceptanceModesObserved: COST_ALLOCATION_BASE_MODES.every((mode) =>
      observedModes.includes(mode)),
    finalMode: finalMode == null ? null : text(finalMode)
  }
}

const ACCOUNTING_ORG_ID = '1'
const CASE_ID = 'COST-001'
const MAX_DATABASE_ID = 9223372036854775807n
const ID_PATTERN = /^[1-9]\d*$/

const text = (value) => String(value ?? '').trim()
const dataOf = (payload) => payload?.data

const fail = (message) => {
  throw new Error(`COST-001: ${message}`)
}

const requireFact = (condition, message) => {
  if (!condition) fail(message)
}

const exactId = (value, label) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    fail(`${label}返回不安全数字 ID，必须使用字符串`)
  }
  const id = text(value)
  if (!ID_PATTERN.test(id) || BigInt(id) > MAX_DATABASE_ID) {
    fail(`${label}未返回合法精确数据库 ID`)
  }
  return id
}

const businessData = (payload, label) => {
  if (!isBusinessSuccess(payload)) {
    fail(`${label}失败：${text(payload?.msg || payload?.message) || JSON.stringify(payload)}`)
  }
  return dataOf(payload)
}

const pageData = (payload, label) => {
  const data = businessData(payload, label)
  requireFact(
    data && typeof data === 'object' && !Array.isArray(data) &&
      Array.isArray(data.list) && Number.isSafeInteger(data.total) &&
      data.total >= data.list.length,
    `${label}未返回合法分页对象`
  )
  return data
}

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  )
}

const sameValue = (left, right) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

const addCheck = (caseRecord, name, passed, details) => {
  const check = { name, passed: Boolean(passed), details: String(details ?? '') }
  caseRecord.checks = [...(caseRecord.checks || []), check]
  return check.passed
}

const requireCheck = (caseRecord, name, passed, details) => {
  if (!addCheck(caseRecord, name, passed, details)) {
    fail(`${name}：${details}`)
  }
}

const mergeErrors = (errors, label) => {
  const values = errors.filter(Boolean)
  if (values.length === 0) return null
  if (values.length === 1) return values[0]
  return new AggregateError(values, `${label}：${values.map((item) => item.message).join('；')}`)
}

const monthFromOffset = (year, monthIndex, offset) => {
  const absolute = year * 12 + monthIndex + offset
  return `${Math.floor(absolute / 12)}-${String((absolute % 12) + 1).padStart(2, '0')}`
}

export const chooseFutureCostMonth = ({ models = [], periods = [], now = new Date() } = {}) => {
  const used = new Set([
    ...models.map((row) => text(row?.effectiveMonth)).filter(Boolean),
    ...periods.map((row) => text(row?.period)).filter(Boolean)
  ])
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth()
  for (let offset = 24; offset < 24 + 1200; offset++) {
    const candidate = monthFromOffset(currentYear, currentMonth, offset)
    if (!used.has(candidate)) return candidate
  }
  fail('没有找到未占用的未来成本月份')
}

export const allocationRuleSignature = (rule) => {
  if (!rule) return null
  return canonical({
    id: exactId(rule.id, '分摊规则 ID'),
    modelVersionId: exactId(rule.modelVersionId, '分摊规则模型 ID'),
    costCenterId: exactId(rule.costCenterId, '分摊规则成本中心 ID'),
    effectiveMonth: text(rule.effectiveMonth),
    status: text(rule.status),
    confirmedBy: rule.confirmedBy == null ? null : text(rule.confirmedBy),
    confirmedAt: rule.confirmedAt ?? null,
    lines: (rule.lines || []).map((line) => ({
      id: exactId(line.id, '分摊规则明细 ID'),
      componentItemId: exactId(line.componentItemId, '分摊规则构成项 ID'),
      finishedRatio: text(line.finishedRatio),
      wipRatio: text(line.wipRatio),
      allocationMode: text(line.allocationMode),
      roundingPolicy: text(line.roundingPolicy),
      factorSource: line.factorSource == null ? null : text(line.factorSource)
    }))
  })
}

const rulePath = (fixture) =>
  `/cost/allocation-rules?modelVersionId=${encodeURIComponent(fixture.modelVersionId)}` +
  `&effectiveMonth=${encodeURIComponent(fixture.effectiveMonth)}`

const selectOwnedRule = (rows, fixture) => {
  requireFact(Array.isArray(rows), '专属分摊规则回读不是数组')
  const owned = rows.filter((row) =>
    text(row.modelVersionId) === fixture.modelVersionId &&
    text(row.costCenterId) === fixture.costCenterId &&
    text(row.effectiveMonth) === fixture.effectiveMonth
  )
  requireFact(owned.length === 1, `专属分摊规则应唯一，实际为 ${owned.length} 条`)
  return owned[0]
}

const readOwnedRules = async (api, fixture) =>
  selectOwnedRule(businessData(await api.getBusiness(rulePath(fixture)), '专属分摊规则回读'), fixture)

const assertOwnedRule = (rule, fixture, expectedMode = 'QUANTITY') => {
  requireFact(text(rule.modelVersionId) === fixture.modelVersionId, '规则模型版本归属漂移')
  requireFact(text(rule.costCenterId) === fixture.costCenterId, '规则成本中心归属漂移')
  requireFact(text(rule.effectiveMonth) === fixture.effectiveMonth, '规则生效月份归属漂移')
  requireFact(Array.isArray(rule.lines) && rule.lines.length === 1, '规则明细数量不是专属单行')
  const line = rule.lines[0]
  requireFact(text(line.componentItemId) === fixture.componentItemId, '规则构成项归属漂移')
  requireFact(text(line.finishedRatio) === '100', '规则完工比例不是 100')
  requireFact(text(line.wipRatio) === '0', '规则在制比例不是 0')
  requireFact(text(line.allocationMode) === expectedMode, `规则分摊模式不是 ${expectedMode}`)
  return rule
}

const modelPayload = (fixture) => ({
  accountingOrgId: Number(fixture.accountingOrgId),
  versionNo: `E2E-COST-001-${fixture.suffix}`,
  enterpriseType: 'MANUFACTURING',
  dimensionMode: '产品',
  valuationScopeMode: 'GLOBAL',
  valuationMethod: 'MOVING_AVERAGE',
  valuationScopeConfigJson: JSON.stringify({
    finishedDataSourceMode: 'MANUAL',
    productionOrderDataSourceMode: 'MANUAL'
  }),
  finishedIoScopeJson: '[]',
  productionOrderScopeJson: '[]',
  effectiveMonth: fixture.effectiveMonth,
  remark: fixture.marker
})

const componentPayload = (fixture) => ({
  categories: [{
    id: 'cost-closure-category',
    parentId: '',
    code: `E2E-COST-001-CAT-${fixture.suffix}`,
    name: `E2E成本专属分类${fixture.suffix}`,
    sortNo: 100,
    status: 'ENABLED'
  }],
  items: [{
    id: 'cost-closure-item',
    categoryId: 'cost-closure-category',
    code: `E2E-COST-001-ITEM-${fixture.suffix}`,
    name: `E2E成本专属构成项${fixture.suffix}`,
    inclusionRate: 100,
    fetchMode: 'MANUAL',
    resultScope: 'FORMAL_COST',
    businessDirection: 'COST',
    systemItem: false,
    participateWip: true,
    status: 'ENABLED',
    remark: fixture.marker
  }],
  sourceRules: [{
    id: 'cost-closure-source',
    componentItemId: 'cost-closure-item',
    sourceType: 'E2E_MANUAL',
    sourcePriority: 1,
    effectiveFrom: `${fixture.effectiveMonth}-01`,
    status: 'ENABLED'
  }]
})

const validRulePayload = (fixture, allocationMode = 'QUANTITY') => ({
  modelVersionId: fixture.modelVersionId,
  costCenterId: fixture.costCenterId,
  effectiveMonth: fixture.effectiveMonth,
  status: 'DRAFT',
  lines: [{
    componentItemId: fixture.componentItemId,
    finishedRatio: 100,
    wipRatio: 0,
    allocationMode,
    roundingPolicy: 'MAX_AMOUNT_OBJECT'
  }]
})

export const costAllocationFixtureSpec = ({
  caseId = CASE_ID,
  runId,
  tenantId = '1',
  accountingOrgId = ACCOUNTING_ORG_ID,
  effectiveMonth
} = {}) => {
  requireFact(caseId === CASE_ID, `只允许建立 ${CASE_ID} 专属夹具`)
  requireFact(typeof runId === 'string' && /^[A-Za-z0-9_-]+$/.test(runId), 'runId 不安全')
  requireFact(text(tenantId) === '1', '成本写侧夹具只允许安全测试租户 1')
  requireFact(text(accountingOrgId) === ACCOUNTING_ORG_ID, '成本写侧夹具只允许核算组织 1')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
  const month = effectiveMonth || chooseFutureCostMonth()
  return {
    caseId,
    runId,
    suffix,
    tenantId: '1',
    accountingOrgId: ACCOUNTING_ORG_ID,
    effectiveMonth: month,
    marker: `CFOR-E2E:${CASE_ID}:${runId}:${suffix}:tenant=1:org=1:month=${month}`,
    fixtureId: `E2E-${CASE_ID}-${runId}-${suffix}`,
    departmentId: null,
    departmentCode: `E2E-COST-001-D-${suffix}`,
    departmentName: `E2E成本专属部门${suffix}`,
    costCenterId: null,
    costCenterCode: `E2E-COST-001-CC-${suffix}`,
    costCenterName: `E2E成本专属中心${suffix}`,
    modelVersionId: null,
    componentItemId: null,
    componentItemCode: null,
    componentCategoryId: null,
    componentSourceRuleId: null,
    ruleId: null,
    cleanupPlan: {
      retainedFormalObjects: [
        '成本模型版本：后端没有删除接口',
        '成本构成分类/构成项/来源规则：后端只有替换接口，不能安全删除历史事实',
        '分摊规则及明细：后端没有删除接口'
      ],
      deactivated: false,
      departmentDeleted: false
    }
  }
}

const assertScope = async ({ record, caseRecord, settings, writeSafety }) => {
  requireFact(settings.target === 'local', '成本写侧必须运行在 local 目标')
  requireFact(text(settings.tenantId) === '1', '成本写侧必须使用租户 1')
  requireFact(text(record?.environment?.tenantId) === '1', '运行环境租户不是 1')
  requireFact(record?.runId && /^[A-Za-z0-9_-]+$/.test(record.runId), '运行 runId 不安全')
  requireFact(caseRecord?.id === CASE_ID && caseRecord?.caseId === CASE_ID,
    'caseRecord 未绑定 COST-001')
  await writeSafety(caseRecord)
}

const departmentPayload = (fixture) => ({
  name: fixture.departmentName,
  code: fixture.departmentCode,
  unitType: 'DEPARTMENT',
  parentId: 0,
  sort: 9999,
  status: 0
})

const centerPayload = (fixture) => ({
  accountingOrgId: Number(fixture.accountingOrgId),
  code: fixture.costCenterCode,
  name: fixture.costCenterName,
  enabledAt: `${fixture.effectiveMonth}-01`,
  departmentIds: [fixture.departmentId],
  remark: fixture.marker
})

const assertDepartment = (row, fixture) => {
  requireFact(
    row &&
      text(row.id) === fixture.departmentId &&
      text(row.name) === fixture.departmentName &&
      text(row.code) === fixture.departmentCode &&
      text(row.parentId || '0') === '0' &&
      Number(row.status) === 0,
    '专属部门回读的租户内稳定编码或状态不匹配'
  )
}

const assertCenter = (row, fixture, status = 'ENABLED') => {
  requireFact(
    row &&
      text(row.id) === fixture.costCenterId &&
      text(row.accountingOrgId) === fixture.accountingOrgId &&
      text(row.code) === fixture.costCenterCode &&
      text(row.name) === fixture.costCenterName &&
      text(row.status) === status &&
      text(row.remark) === fixture.marker &&
      Array.isArray(row.departmentIds) &&
      row.departmentIds.length === 1 &&
      text(row.departmentIds[0]) === fixture.departmentId,
    `专属成本中心回读不匹配：status=${status}`
  )
}

const assertModel = (row, fixture) => {
  requireFact(
    row &&
      text(row.id) === fixture.modelVersionId &&
      text(row.accountingOrgId) === fixture.accountingOrgId &&
      text(row.effectiveMonth) === fixture.effectiveMonth &&
      text(row.enterpriseType) === 'MANUFACTURING' &&
      text(row.status) === 'DRAFT' &&
      text(row.remark) === fixture.marker,
    '专属成本模型回读不匹配'
  )
}

const assertComponents = (row, fixture) => {
  requireFact(
    row &&
      text(row.modelVersionId) === fixture.modelVersionId &&
      Array.isArray(row.categories) &&
      Array.isArray(row.items) &&
      Array.isArray(row.sourceRules) &&
      row.categories.length === 1 &&
      row.items.length === 1 &&
      row.sourceRules.length === 1,
    '专属成本构成配置不是唯一三段结构'
  )
  const category = row.categories[0]
  const item = row.items[0]
  const source = row.sourceRules[0]
  fixture.componentCategoryId = exactId(category.id, '专属成本分类')
  fixture.componentItemId = exactId(item.id, '专属成本构成项')
  fixture.componentItemCode = text(item.code)
  fixture.componentSourceRuleId = exactId(source.id, '专属成本来源规则')
  requireFact(text(category.code) === `E2E-COST-001-CAT-${fixture.suffix}`,
    '专属成本分类编码不匹配')
  requireFact(text(item.code) === `E2E-COST-001-ITEM-${fixture.suffix}` &&
    text(item.categoryId) === fixture.componentCategoryId &&
    text(item.remark) === fixture.marker &&
    item.systemItem === false &&
    text(item.status) === 'ENABLED',
  '专属成本构成项所有权或状态不匹配')
  requireFact(
    text(source.componentItemId) === fixture.componentItemId &&
      text(source.sourceType) === 'E2E_MANUAL' &&
      text(source.status) === 'ENABLED',
    '专属成本来源规则所有权或状态不匹配'
  )
}

const readAllPages = async (api, path, label) => {
  const list = []
  for (let pageNo = 1; pageNo <= 1000; pageNo++) {
    const page = pageData(
      await api.getBusiness(`${path}&pageNo=${pageNo}&pageSize=100`), label
    )
    list.push(...page.list)
    if (list.length >= page.total) return { list, total: page.total }
    requireFact(page.list.length > 0, `${label}分页提前返回空列表`)
  }
  fail(`${label}分页超出安全上限`)
}

const readModelPage = async (api) => readAllPages(
  api, `/cost/model-versions?accountingOrgId=${ACCOUNTING_ORG_ID}`, '成本模型版本列表'
)

const readDepartment = async (api, fixture) => businessData(
  await api.getBusiness(`/system/dept/get?id=${encodeURIComponent(fixture.departmentId)}`),
  '专属成本部门详情'
)

const readCenter = async (api, fixture) => businessData(
  await api.getBusiness(`/cost/centers/${encodeURIComponent(fixture.costCenterId)}`),
  '专属成本中心详情'
)

const readModel = async (api, fixture) => businessData(
  await api.getBusiness(`/cost/model-versions/${encodeURIComponent(fixture.modelVersionId)}`),
  '专属成本模型详情'
)

const readComponents = async (api, fixture) => businessData(
  await api.getBusiness(
    `/cost/model-versions/${encodeURIComponent(fixture.modelVersionId)}/components`
  ),
  '专属成本构成配置'
)

const createDepartment = async (api, fixture) => {
  fixture.departmentId = exactId(
    businessData(await api.postBusiness('/system/dept/create', departmentPayload(fixture)),
      '专属成本部门创建'),
    '专属成本部门'
  )
  assertDepartment(await readDepartment(api, fixture), fixture)
}

const createCenter = async (api, fixture) => {
  fixture.costCenterId = exactId(
    businessData(await api.postBusiness('/cost/centers', centerPayload(fixture)),
      '专属成本中心创建')?.id,
    '专属成本中心'
  )
  assertCenter(await readCenter(api, fixture), fixture)
}

const createModel = async (api, fixture) => {
  fixture.modelVersionId = exactId(
    businessData(await api.postBusiness('/cost/model-versions', modelPayload(fixture)),
      '专属成本模型创建')?.id,
    '专属成本模型'
  )
  assertModel(await readModel(api, fixture), fixture)
}

const createComponents = async (api, fixture) => {
  const stored = businessData(
    await api.putBusiness(
      `/cost/model-versions/${encodeURIComponent(fixture.modelVersionId)}/components`,
      componentPayload(fixture)
    ),
    '专属成本构成保存'
  )
  assertComponents(stored, fixture)
  const reread = await readComponents(api, fixture)
  assertComponents(reread, fixture)
}

export async function readOwnedCostAllocationRule (api, fixture) {
  return assertOwnedRule(await readOwnedRules(api, fixture), fixture)
}

const saveRuleForMode = async (api, fixture, allocationMode) => {
  requireFact(COST_ALLOCATION_MODES.includes(allocationMode),
    `未注册的成本分摊模式：${allocationMode}`)
  const saved = businessData(
    await api.putBusiness('/cost/allocation-rules', validRulePayload(fixture, allocationMode)),
    `专属分摊规则保存（${allocationMode}）`
  )
  const reread = await readOwnedRules(api, fixture)
  assertOwnedRule(reread, fixture, allocationMode)
  return { saved, reread, allocationMode }
}

export async function verifyInvalidAllocationMode ({ api, fixture, caseRecord }) {
  const before = await readOwnedCostAllocationRule(api, fixture)
  const response = await api.put('/cost/allocation-rules', {
    ...validRulePayload(fixture),
    lines: [{
      ...validRulePayload(fixture).lines[0],
      allocationMode: 'UNKNOWN_FACTOR'
    }]
  }, { expectedBusinessRejection: COST_ALLOCATION_INVALID_MODE })
  const rejected = matchesExpectedBusinessRejection(response, COST_ALLOCATION_INVALID_MODE)
  const after = await readOwnedCostAllocationRule(api, fixture)
  const unchanged = sameValue(allocationRuleSignature(before), allocationRuleSignature(after))
  requireCheck(
    caseRecord,
    COST_ALLOCATION_CLOSURE_CHECKS.invalidMode,
    rejected && unchanged,
    `code=${response?.code}; message=${response?.msg || response?.message}; unchanged=${unchanged}`
  )
  return after
}

const formalAllocationPutCount = (record) =>
  (record?.api || []).filter((entry) =>
    entry.method === 'PUT' && String(entry.pathname || '').includes('/cost/allocation-rules')
  ).length

const defaultBrowserActions = {
  async open (page) {
    await openRoute(page, '/cost-management/modeling/allocation-rule', {
      readySelector: '.allocation-workspace',
      retries: 1
    })
  },

  async assertDedicatedRows (page, fixture) {
    const modelId = exactId(fixture.modelVersionId, '浏览器专属模型 ID')
    const modelLabel = `${modelPayload(fixture).versionNo} · ${fixture.effectiveMonth} · 生产`
    const modelSelect = page.locator(
      '.model-context-meta .el-select:has(input[aria-label="成本模型版本"])'
    )
    await modelSelect.waitFor({ state: 'visible', timeout: 15000 })
    requireFact(await modelSelect.count() === 1, '页面没有唯一的成本模型版本正式 select')
    const input = modelSelect.getByRole('combobox', { name: '成本模型版本', exact: true })
    await input.fill(modelPayload(fixture).versionNo, { timeout: 30000 })
    const option = page.getByRole('option', { name: modelLabel, exact: true })
    await option.waitFor({ state: 'visible', timeout: 15000 })
    const componentResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' &&
        url.pathname.endsWith(`/cost/model-versions/${modelId}/components`)
    }, { timeout: 15000 })
    const ruleResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' &&
        url.pathname.endsWith('/cost/allocation-rules') &&
        url.searchParams.get('modelVersionId') === modelId &&
        url.searchParams.get('effectiveMonth') === fixture.effectiveMonth
    }, { timeout: 15000 })
    const centerResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' &&
        url.pathname.endsWith('/cost/centers') &&
        url.searchParams.get('accountingOrgId') === fixture.accountingOrgId
    }, { timeout: 30000 })
    const [components, rules, centers] = await Promise.all([
      componentResponse, ruleResponse, centerResponse, option.click()
    ])
    const browserComponents = { ...fixture }
    assertComponents(businessData(await components.json(), '浏览器正式构成读取'), browserComponents)
    requireFact(['componentCategoryId', 'componentItemId', 'componentSourceRuleId']
      .every((key) => browserComponents[key] === fixture[key]),
    '浏览器读取的正式构成项 ID 与专属夹具不一致')
    assertOwnedRule(selectOwnedRule(
      businessData(await rules.json(), '浏览器正式分摊规则读取'), fixture
    ), fixture)
    const formalCenters = businessData(await centers.json(), '浏览器正式成本中心读取')
    requireFact(Array.isArray(formalCenters), '浏览器成本中心接口没有返回正式列表')
    const ownedCenters = formalCenters.filter((row) => text(row.id) === fixture.costCenterId)
    requireFact(ownedCenters.length === 1, '浏览器成本中心接口缺少唯一的专属中心')
    assertCenter(ownedCenters[0], fixture)
    const center = page.locator('.center-list-item').filter({ hasText: fixture.costCenterCode })
    await center.waitFor({ state: 'visible', timeout: 30000 })
    requireFact(await center.count() === 1,
      '页面没有唯一展示本轮专属正式成本中心')
    await center.first().click()
    const rows = page.locator('.allocation-table .el-table__row')
      .filter({ hasText: fixture.componentItemCode })
    await rows.waitFor({ state: 'visible', timeout: 10000 })
    requireFact(await rows.count() === 1, '页面没有展示本轮专属成本构成项，不能伪造浏览器证据')
  },

  async assertFormalValues (page, fixture) {
    await page.waitForFunction(({ itemCode, month }) => {
      const row = [...document.querySelectorAll('.allocation-table .el-table__row')]
        .find((element) => element.textContent.includes(itemCode))
      const inputs = row?.querySelectorAll('.el-input-number input')
      const selectedMode = row?.querySelector('.el-radio-button.is-active')
      const monthInput = document.querySelector('.rule-period-field input')
      return inputs?.length === 2 && Number(inputs[0].value) === 100 &&
        Number(inputs[1].value) === 0 && selectedMode?.textContent.trim() === '按数量' &&
        monthInput?.value === month
    }, { itemCode: fixture.componentItemCode, month: fixture.effectiveMonth }, { timeout: 30000 })
  },

  async editDraft (page) {
    const inputs = page.locator('.allocation-table .el-input-number input')
    requireFact(await inputs.count() >= 2, '页面没有可编辑的完工/在制比例输入框')
    await inputs.nth(0).fill('80')
    await inputs.nth(0).press('Tab')
    await inputs.nth(1).fill('20')
    await inputs.nth(1).press('Tab')
  },

  async cancelDraft (page) {
    const url = page.url()
    const cancel = page.locator('.workspace-actions')
      .getByRole('button', { name: '取消', exact: true })
    await cancel.waitFor({ state: 'visible', timeout: 10000 })
    requireFact(await cancel.count() === 1, '缺少唯一的本页明确取消按钮，禁止导航至共享成本工作台')
    await cancel.click()
    requireFact(page.url() === url, '取消草稿意外导航离开正式分摊页面')
    return 'button'
  },

  async refresh (page) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.allocation-workspace').waitFor({ state: 'visible' })
  },

  async verifyModeControls (page, fixture, { outputDir, record }) {
    const viewport = page.viewportSize()
    const labels = ['按数量', '按金额', '手工', '按工时', '按机器时', '按面积', '按产量']
    const verified = []
    try {
      for (const width of [1280, 1600, 1920]) {
        await page.setViewportSize({ width, height: 900 })
        const row = page.locator('.allocation-table .el-table__row')
          .filter({ hasText: fixture.componentItemCode })
        const group = row.locator('.allocation-mode')
        await page.locator('.allocation-table .el-scrollbar__wrap').first()
          .evaluate((element) => { element.scrollLeft = element.scrollWidth })
        for (const label of labels) {
          const button = group.locator('.el-radio-button').filter({ hasText: new RegExp(`^${label}$`) })
          await button.click()
          requireFact(await button.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            if (!element.classList.contains('is-active') || rect.width <= 0 || rect.height <= 0 ||
                rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight) return false
            return [[rect.left + 2, rect.top + 2], [rect.right - 2, rect.top + 2],
              [rect.left + 2, rect.bottom - 2], [rect.right - 2, rect.bottom - 2]]
              .every(([x, y]) => element.contains(document.elementFromPoint(x, y)))
          }), `${width}px 分摊模式 ${label} 被遮挡、裁切或无法选中`)
          if (['按工时', '按机器时', '按面积', '按产量'].includes(label)) {
            await row.locator('.factor-source').waitFor({ state: 'visible' })
          }
        }
        await group.locator('.el-radio-button').filter({ hasText: /^按数量$/ }).click()
        if (outputDir) await saveScreenshot(page, outputDir, `cost-allocation-controls-${width}`, record)
        verified.push(width)
      }
    } finally {
      if (viewport) await page.setViewportSize(viewport)
    }
    return verified
  }
}

export async function verifyBrowserDraftBoundaries ({
  api,
  page,
  fixture,
  record,
  caseRecord,
  outputDir,
  dependencies = {}
}) {
  requireFact(page, '浏览器页面缺失，不能完成 COST-001 浏览器边界')
  const browser = { ...defaultBrowserActions, ...(dependencies.browserActions || {}) }
  const before = allocationRuleSignature(await readOwnedCostAllocationRule(api, fixture))
  const formalWritesBefore = formalAllocationPutCount(record)
  const browserFixture = {
    ...fixture,
    componentItemCode: fixture.componentItemCode || `E2E-COST-001-ITEM-${fixture.suffix}`
  }
  await browser.open(page)
  try {
    await browser.assertDedicatedRows(page, browserFixture)
    await browser.assertFormalValues(page, browserFixture)
  } catch (error) {
    addCheck(caseRecord, COST_ALLOCATION_CLOSURE_CHECKS.browserRoute, false, error.message)
    throw error
  }
  requireCheck(
    caseRecord,
    COST_ALLOCATION_CLOSURE_CHECKS.browserRoute,
    true,
    `正式 select 选择 model=${fixture.modelVersionId}; month=${fixture.effectiveMonth}; ` +
      '正式 API 对象与页面 100/0、QUANTITY 一致'
  )
  await browser.editDraft(page, fixture)
  const cancelMode = await browser.cancelDraft(page, fixture)
  await browser.assertFormalValues(page, browserFixture)
  const afterCancel = allocationRuleSignature(await readOwnedCostAllocationRule(api, fixture))
  const writesAfterCancel = formalAllocationPutCount(record)
  requireCheck(
    caseRecord,
    COST_ALLOCATION_CLOSURE_CHECKS.browserCancel,
    cancelMode === 'button' && sameValue(before, afterCancel) &&
      writesAfterCancel === formalWritesBefore,
    `mode=${cancelMode}; formalUnchanged=${sameValue(before, afterCancel)}; ` +
      `allocationPuts=${writesAfterCancel - formalWritesBefore}`
  )

  await browser.editDraft(page, fixture)
  await browser.refresh(page)
  await browser.assertDedicatedRows(page, browserFixture)
  await browser.assertFormalValues(page, browserFixture)
  const afterRefresh = allocationRuleSignature(await readOwnedCostAllocationRule(api, fixture))
  const writesAfterRefresh = formalAllocationPutCount(record)
  requireCheck(
    caseRecord,
    COST_ALLOCATION_CLOSURE_CHECKS.browserRefresh,
    sameValue(before, afterRefresh) && writesAfterRefresh === formalWritesBefore,
    `formalUnchanged=${sameValue(before, afterRefresh)}; ` +
      `allocationPuts=${writesAfterRefresh - formalWritesBefore}`
  )
  const viewports = await browser.verifyModeControls(page, browserFixture, { outputDir, record })
  requireCheck(caseRecord, COST_ALLOCATION_CLOSURE_CHECKS.browserModes,
    sameValue(viewports, [1280, 1600, 1920]) &&
      formalAllocationPutCount(record) === formalWritesBefore &&
      sameValue(before, allocationRuleSignature(await readOwnedCostAllocationRule(api, fixture))),
    `widths=${viewports.join(',')}; modes=7; factorModesOnlyDraft=true`)

  if (dependencies.saveScreenshot || outputDir) {
    await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, 'cost-allocation-closure', record
    )
  }
  return { before, afterCancel, afterRefresh }
}

export async function readSharedCostWorkspaceSnapshot (readSql = runReadOnlySql) {
  const snapshot = await readSql(`
    SELECT id, tenant_id, accounting_org_id, state_key, version, update_time,
      SHA2(CAST(payload_json AS CHAR), 256), CHAR_LENGTH(CAST(payload_json AS CHAR))
    FROM cost_workspace_state
    WHERE tenant_id = 1 AND accounting_org_id = 1 AND id IN (13, 4) AND deleted = 0
    ORDER BY id
  `)
  requireFact(snapshot.available && snapshot.rows.length === 2,
    '缺少 shared workspace id4/id13 的完整只读证据')
  const rows = snapshot.rows.map(([id, tenantId, orgId, key, version, updatedAt, hash, length]) => {
    requireFact(['4', '13'].includes(id) && tenantId === '1' && orgId === '1' &&
      /^\d+$/.test(version) && /^[a-f0-9]{64}$/.test(hash) && /^\d+$/.test(length),
    'shared workspace 只读证据字段无效')
    return { id, tenantId, orgId, key, version, updatedAt, hash, length }
  })
  requireFact(new Set(rows.map((row) => row.id)).size === 2, 'shared workspace 证据 ID 重复')
  return rows
}

export async function verifyCostSharedWorkspaceBoundary ({
  page, caseRecord, operation, dependencies = {}
}) {
  const snapshot = dependencies.readSnapshot || readSharedCostWorkspaceSnapshot
  const before = await snapshot()
  const attemptedPuts = []
  const listener = (request) => {
    if (request.method() === 'PUT' &&
        new URL(request.url()).pathname.endsWith('/cost/workspace-states/save')) {
      attemptedPuts.push({ method: 'PUT', pathname: new URL(request.url()).pathname })
    }
  }
  page.on('request', listener)
  let result
  let operationError
  let evidenceError
  try {
    result = await operation()
  } catch (error) {
    operationError = error
  } finally {
    try {
      const after = await snapshot()
      const unchanged = sameValue(before, after)
      caseRecord.sharedWorkspaceBoundary = { before, after, attemptedPuts, unchanged }
      requireCheck(caseRecord, '成本浏览器 shared workspace 无 PUT 且 id4/id13 哈希/版本未变化',
        attemptedPuts.length === 0 && unchanged,
        JSON.stringify(caseRecord.sharedWorkspaceBoundary))
    } catch (error) {
      evidenceError = error
    } finally {
      page.off('request', listener)
    }
  }
  const error = mergeErrors([operationError, evidenceError], '成本执行或共享配置边界失败')
  if (error) throw error
  return result
}

const lastDayOfMonth = (month) => {
  const [year, monthNumber] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`
}

const cleanupDepartment = async (api, fixture) => {
  const current = await readDepartment(api, fixture)
  assertDepartment(current, fixture)
  await api.deleteBusiness(`/system/dept/delete?id=${encodeURIComponent(fixture.departmentId)}`)
  if (api.request) {
    const after = await api.request(
      'GET',
      `/system/dept/get?id=${encodeURIComponent(fixture.departmentId)}`
    )
    requireFact(after?.code === 0 && after.data == null ||
      matchesExpectedBusinessRejection(after, { code: 1002004002, message: '当前部门不存在' }),
    '专属成本部门删除后未证明正式不可见')
  }
  fixture.cleanupPlan.departmentDeleted = true
}

const cleanupCenter = async (api, fixture) => {
  const current = await readCenter(api, fixture)
  assertCenter(current, fixture, current.status === 'DISABLED' ? 'DISABLED' : 'ENABLED')
  if (current.status === 'ENABLED') {
    await api.postBusiness(
      `/cost/centers/${encodeURIComponent(fixture.costCenterId)}/deactivate`,
      {
        disabledAt: lastDayOfMonth(fixture.effectiveMonth),
        reason: fixture.marker
      }
    )
  }
  const after = await readCenter(api, fixture)
  assertCenter(after, fixture, 'DISABLED')
  fixture.cleanupPlan.deactivated = true
}

export async function cleanupCostAllocationClosureFixture ({
  api,
  fixture,
  caseRecord,
  recordCheck = true
}) {
  const errors = []
  if (fixture?.costCenterId) {
    try {
      await cleanupCenter(api, fixture)
    } catch (error) {
      errors.push(new Error(`成本中心清理失败：${error.message}`))
    }
  }
  if (fixture?.departmentId) {
    try {
      await cleanupDepartment(api, fixture)
    } catch (error) {
      errors.push(new Error(`专属部门清理失败：${error.message}`))
    }
  }
  if (errors.length === 0) {
    const details =
      `deactivated=${fixture?.cleanupPlan?.deactivated === true}; ` +
      `departmentDeleted=${fixture?.cleanupPlan?.departmentDeleted === true}; ` +
      `retained=${fixture?.cleanupPlan?.retainedFormalObjects.join('|')}`
    caseRecord.notes = [...(caseRecord.notes || []),
      `COST-001 清理计划：${details}`]
    if (recordCheck) addCheck(caseRecord, COST_ALLOCATION_CLOSURE_CHECKS.cleanup, true, details)
    return fixture
  }
  if (recordCheck) {
    addCheck(caseRecord, COST_ALLOCATION_CLOSURE_CHECKS.cleanup, false,
      errors.map((error) => error.message).join('；'))
  }
  throw mergeErrors(errors, 'COST-001 专属夹具清理失败')
}

export async function createCostAllocationClosureFixture ({
  api,
  record,
  caseRecord,
  dependencies = {}
}) {
  const settings = dependencies.config || defaultConfig
  const writeSafety = dependencies.assertLocalWriteSafety || assertLocalWriteSafety
  await assertScope({ record, caseRecord, settings, writeSafety })

  const modelsPage = await readModelPage(api)
  const periodsPage = await readAllPages(
    api, `/cost/periods?accountingOrgId=${ACCOUNTING_ORG_ID}`, '成本期间列表'
  )
  const fixture = costAllocationFixtureSpec({
    caseId: CASE_ID,
    runId: record.runId,
    tenantId: record.environment.tenantId,
    accountingOrgId: ACCOUNTING_ORG_ID,
    effectiveMonth: dependencies.effectiveMonth ||
      chooseFutureCostMonth({
        models: modelsPage.list,
        periods: periodsPage.list,
        now: dependencies.now || new Date()
      })
  })
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costAllocationClosure: fixture }

  try {
    await createDepartment(api, fixture)
    await createCenter(api, fixture)
    await createModel(api, fixture)
    await createComponents(api, fixture)
    const modeProofs = []
    for (const allocationMode of COST_ALLOCATION_BASE_MODES) {
      modeProofs.push(await saveRuleForMode(api, fixture, allocationMode))
    }
    // Leave the formal object in the mode expected by the browser boundary.
    const restored = await saveRuleForMode(api, fixture, 'QUANTITY')
    const saved = restored.saved
    fixture.ruleId = exactId(saved?.id, '专属分摊规则')
    const reread = assertOwnedRule(restored.reread, fixture, 'QUANTITY')
    fixture.modeEvidence = allocationModeEvidence({
      savedModes: modeProofs.map((proof) => proof.allocationMode),
      finalMode: reread.lines[0].allocationMode
    })
    requireCheck(
      caseRecord,
      COST_ALLOCATION_CLOSURE_CHECKS.modes,
      fixture.modeEvidence.allAcceptanceModesObserved,
      JSON.stringify({
        acceptanceModes: fixture.modeEvidence.acceptanceModes,
        observedModes: fixture.modeEvidence.observedModes,
        finalMode: fixture.modeEvidence.finalMode
      })
    )
    requireCheck(
      caseRecord,
      COST_ALLOCATION_CLOSURE_CHECKS.fixture,
      true,
      `tenant=1; month=${fixture.effectiveMonth}; department=${fixture.departmentId}; ` +
        `center=${fixture.costCenterId}; model=${fixture.modelVersionId}; item=${fixture.componentItemId}`
    )
    requireCheck(
      caseRecord,
      COST_ALLOCATION_CLOSURE_CHECKS.saveReadback,
      sameValue(allocationRuleSignature(saved), allocationRuleSignature(reread)),
      `rule=${fixture.ruleId}; model=${fixture.modelVersionId}; center=${fixture.costCenterId}; ` +
        `month=${fixture.effectiveMonth}; item=${fixture.componentItemId}; ` +
        `observedModes=${fixture.modeEvidence.observedModes.join(',')}; ` +
        `supportedModes=${fixture.modeEvidence.supportedModes.join(',')}`
    )
    caseRecord.evidence = [
      ...(caseRecord.evidence || []),
      `COST-001 专属正式写侧：${JSON.stringify({
        fixtureId: fixture.fixtureId,
        tenantId: fixture.tenantId,
        accountingOrgId: fixture.accountingOrgId,
        effectiveMonth: fixture.effectiveMonth,
        departmentId: fixture.departmentId,
        costCenterId: fixture.costCenterId,
        modelVersionId: fixture.modelVersionId,
        componentItemId: fixture.componentItemId,
        ruleId: fixture.ruleId,
        allocationModeEvidence: fixture.modeEvidence
      })}`
    ]
    return fixture
  } catch (error) {
    try {
      await cleanupCostAllocationClosureFixture({
        api, fixture, caseRecord, recordCheck: false
      })
    } catch (cleanupError) {
      throw mergeErrors([error, cleanupError], 'COST-001 创建失败且清理失败')
    }
    throw error
  }
}

export async function runCostAllocationClosure ({
  api,
  page,
  record,
  caseRecord,
  outputDir,
  dependencies = {}
}) {
  let fixture
  let operationError
  let cleanupError
  try {
    fixture = await createCostAllocationClosureFixture({
      api, record, caseRecord, dependencies
    })
    await verifyInvalidAllocationMode({ api, fixture, caseRecord })
    await verifyBrowserDraftBoundaries({
      api, page, fixture, record, caseRecord, outputDir, dependencies
    })
  } catch (error) {
    operationError = error
  }
  if (fixture) {
    try {
      await cleanupCostAllocationClosureFixture({ api, fixture, caseRecord })
    } catch (error) {
      cleanupError = error
    }
  }
  const merged = mergeErrors([operationError, cleanupError], 'COST-001 闭环失败')
  if (merged) throw merged
  return fixture
}

export const __internal = Object.freeze({
  assertOwnedRule,
  componentPayload,
  modelPayload,
  validRulePayload,
  saveRuleForMode,
  canonical,
  sameValue,
  defaultBrowserActions,
  readModelPage,
  pageData,
  businessData
})
