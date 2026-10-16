import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertLocalDatabase, assertLocalWriteSafety } from '../lib/db.mjs'

const preciseId = (value, label) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw new Error(`${label} did not return an exact database ID`)
  }
  return text
}

export const COST_OPENING_CASE_ID = 'COST-002'
export const COST_OPENING_FIXTURE_MONTH = '2099-12'
const COST_OPENING_FALLBACK_START_YEAR = 2100
const COST_OPENING_FALLBACK_END_YEAR = 2199
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export const isCostOpeningFixtureMonth = (month) =>
  typeof month === 'string' && MONTH_PATTERN.test(month) &&
  month >= COST_OPENING_FIXTURE_MONTH

export const costModelPayload = ({ versionNo, effectiveMonth, remark }) => ({
  accountingOrgId: 1,
  versionNo,
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
  effectiveMonth,
  remark
})

const requireOpeningWriteScope = ({
  record, caseRecord, effectiveMonth, writeFixtures = process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
}, dependencies) => {
  if (!writeFixtures) throw new Error('BLOCKED: COST-002 requires CFOR_E2E_WRITE_FIXTURES=true')
  if (config.target !== 'local' || String(config.tenantId) !== '1' ||
      String(record?.environment?.target) !== 'local' ||
      String(record?.environment?.tenantId) !== '1' ||
      caseRecord?.id !== COST_OPENING_CASE_ID ||
      caseRecord?.caseId !== COST_OPENING_CASE_ID ||
      !/^[A-Za-z0-9_-]+$/.test(record?.runId || '') ||
      !isCostOpeningFixtureMonth(effectiveMonth)) {
    throw new Error(
      'BLOCKED: COST-002 fixtures require local tenant 1, the exact case/run scope, and a future month'
    )
  }
  return (dependencies.assertLocalDatabase || assertLocalDatabase)()
}

const openingFixtureRemark = (fixture) =>
  `CFOR-E2E:costScenario:accounting:${fixture.runId}:${fixture.suffix}` +
  `:tenant=1:org=1:month=${fixture.month}`

const readBusinessData = (response, label) => {
  if (response?.code !== 0 || response?.data == null) {
    throw new Error(`${label} did not return a successful business payload`)
  }
  return response.data
}

const listCostRows = async (api, pathname, label) => {
  const rows = []
  for (let pageNo = 1; pageNo <= 1000; pageNo++) {
    const page = readBusinessData(
      await api.getBusiness(`${pathname}?accountingOrgId=1&pageNo=${pageNo}&pageSize=100`),
      label
    )
    if (!Array.isArray(page?.list) || !Number.isSafeInteger(page.total) ||
        page.total < rows.length + page.list.length) {
      throw new Error(`${label}分页结构异常，不能分配专属测试月份`)
    }
    rows.push(...page.list)
    if (rows.length === page.total) return rows
    if (page.list.length === 0) {
      throw new Error(`${label}分页提前返回空列表，不能分配专属测试月份`)
    }
  }
  throw new Error(`${label}分页超过安全上限，不能分配专属测试月份`)
}

export async function resolveCostOpeningFixtureMonth (
  api, preferredMonth = COST_OPENING_FIXTURE_MONTH
) {
  if (!isCostOpeningFixtureMonth(preferredMonth)) {
    throw new Error('COST-002 专属月份必须是 2099-12 或更晚的 YYYY-MM')
  }
  const [models, periods] = await Promise.all([
    listCostRows(api, '/cost/model-versions', '成本模型版本'),
    listCostRows(api, '/cost/periods', '成本期间')
  ])
  const used = new Set([
    ...models.map((row) => row.effectiveMonth).filter(Boolean),
    ...periods.map((row) => row.period).filter(Boolean)
  ])
  if (!used.has(preferredMonth)) return preferredMonth
  for (let year = COST_OPENING_FALLBACK_START_YEAR;
    year <= COST_OPENING_FALLBACK_END_YEAR; year++) {
    for (let month = 1; month <= 12; month++) {
      const candidate = `${year}-${String(month).padStart(2, '0')}`
      if (!used.has(candidate)) return candidate
    }
  }
  throw new Error('COST-002 没有可用的远期专属测试月份')
}

/**
 * Build the COST-002 model, center, locked model and accounting period before
 * the opening-WIP state machine runs. This is intentionally separate from the
 * generic COST-030..032 model fixture so COST-002 can never reuse a model
 * created for another assertion or silently fall back to a shared period.
 */
export async function prepareCostOpeningFixture ({
  api, record, caseRecord, effectiveMonth = COST_OPENING_FIXTURE_MONTH,
  writeFixtures = process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
}, dependencies = {}) {
  const existing = caseRecord?.fixtures?.costOpening
  if (existing?.caseId === COST_OPENING_CASE_ID &&
      existing.runId === record?.runId &&
      isCostOpeningFixtureMonth(existing.month) &&
      existing.effectiveMonth === existing.month) {
    return existing
  }

  const fixtureMonth = await resolveCostOpeningFixtureMonth(api, effectiveMonth)
  await requireOpeningWriteScope({
    record, caseRecord, effectiveMonth: fixtureMonth, writeFixtures
  }, dependencies)

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const fixture = {
    caseId: COST_OPENING_CASE_ID,
    scenario: 'accounting',
    runId: record.runId,
    fixtureId: `E2E-${COST_OPENING_CASE_ID}-${record.runId}-${suffix}`,
    tenantId: '1',
    accountingOrgId: '1',
    month: fixtureMonth,
    effectiveMonth: fixtureMonth,
    suffix,
    exclusive: true,
    remark: ''
  }
  fixture.remark = openingFixtureRemark(fixture)
  caseRecord.fixtures = {
    ...(caseRecord.fixtures || {}),
    costOpening: fixture,
    costScenario: fixture
  }

  const department = await api.postBusiness('/system/dept/create', {
    name: `E2E-COST002-${suffix}`,
    code: `E2E-COST002-${suffix}`,
    unitType: 'DEPARTMENT',
    parentId: '0',
    sort: 9999,
    status: 0
  })
  fixture.departmentId = preciseId(department.data, 'COST-002 department')

  const center = await api.postBusiness('/cost/centers', {
    accountingOrgId: 1,
    code: `E2E-SC-${suffix}`,
    name: `E2E成本场景中心${suffix}`,
    enabledAt: `${fixtureMonth}-01`,
    departmentIds: [fixture.departmentId],
    remark: fixture.remark
  })
  fixture.costCenterId = preciseId(center.data?.id, 'COST-002 cost center')

  const model = await api.postBusiness('/cost/model-versions', costModelPayload({
    versionNo: `E2E-SC-ACCOUNTING-${suffix}`,
    effectiveMonth: fixtureMonth,
    remark: fixture.remark
  }))
  fixture.modelId = preciseId(model.data?.id, 'COST-002 model')
  fixture.versionNo = `E2E-SC-ACCOUNTING-${suffix}`

  const components = await api.putBusiness(`/cost/model-versions/${fixture.modelId}/components`, {
    categories: [{
      id: 'opening-category',
      parentId: '',
      code: `E2E-SCAT-${suffix}`,
      name: 'E2E期初在制分类',
      sortNo: 100,
      status: 'ENABLED'
    }],
    items: [{
      id: 'opening-item',
      categoryId: 'opening-category',
      code: `E2E-SITEM-${suffix}`,
      name: 'E2E期初在制构成项',
      inclusionRate: 100,
      fetchMode: 'MANUAL',
      resultScope: 'FORMAL_COST',
      businessDirection: 'COST',
      systemItem: false,
      participateWip: true,
      status: 'ENABLED',
      remark: fixture.remark
    }],
    sourceRules: [{
      id: 'opening-source',
      componentItemId: 'opening-item',
      sourceType: 'E2E_MANUAL',
      sourcePriority: 1,
      effectiveFrom: `${fixtureMonth}-01`,
      status: 'ENABLED'
    }]
  })
  if (components.data?.items?.length !== 1) {
    throw new Error('COST-002 component fixture did not return its dedicated item')
  }
  fixture.componentItemId = preciseId(components.data.items[0].id, 'COST-002 component')

  const locked = await api.postBusiness(`/cost/model-versions/${fixture.modelId}/lock`)
  const lockedModel = readBusinessData(locked, 'COST-002 locked model')
  if (String(lockedModel.id) !== fixture.modelId ||
      lockedModel.status !== 'LOCKED' ||
      lockedModel.effectiveMonth !== fixtureMonth ||
      lockedModel.remark !== fixture.remark) {
    throw new Error('COST-002 dedicated model was not locked with the expected ownership')
  }

  const periodResponse = await api.postBusiness('/cost/periods', {
    accountingOrgId: 1,
    period: fixtureMonth,
    enterpriseType: 'MANUFACTURING',
    modelVersion: fixture.versionNo,
    requestId: `e2e-cost002-period-${record.runId}-${suffix}`
  })
  const periodResult = readBusinessData(periodResponse, 'COST-002 accounting period')
  fixture.periodId = preciseId(periodResult.periodId || periodResult.id, 'COST-002 period')
  fixture.period = readBusinessData(
    await api.getBusiness(`/cost/periods/${fixture.periodId}`),
    'COST-002 accounting period readback'
  )
  if (String(fixture.period.id) !== fixture.periodId ||
      String(fixture.period.modelVersionId) !== fixture.modelId ||
      fixture.period.modelVersionNo !== fixture.versionNo ||
      fixture.period.period !== fixtureMonth ||
      fixture.period.enterpriseType !== 'MANUFACTURING' ||
      fixture.period.status !== 'ACCOUNTING' ||
      fixture.period.currentPublicationId != null) {
    throw new Error('COST-002 accounting period ownership or status is invalid')
  }

  caseRecord.evidence.push(`COST-002 专属夹具：${JSON.stringify({
    runId: fixture.runId,
    tenantId: fixture.tenantId,
    month: fixture.month,
    departmentId: fixture.departmentId,
    costCenterId: fixture.costCenterId,
    modelId: fixture.modelId,
    periodId: fixture.periodId,
    componentItemId: fixture.componentItemId
  })}`)
  caseRecord.checks.push({
    name: 'COST-002 通过正式 API 建立 tenant 1/远期专属月份模型、期间、中心和构成项',
    passed: true,
    details: `model=${fixture.modelId}; period=${fixture.periodId}; center=${fixture.costCenterId}`
  })
  return fixture
}

export async function prepareCostModelFixture ({
  api, caseId, record, caseRecord, effectiveMonth, remarkForFixture
}, dependencies = {}) {
  if (caseRecord.fixtures?.cost) return caseRecord.fixtures.cost
  if (config.target !== 'local' || config.tenantId !== '1' ||
      String(record.environment?.tenantId) !== '1' ||
      !['COST-030', 'COST-031', 'COST-032'].includes(caseId) ||
      caseRecord.id !== caseId || caseRecord.caseId !== caseId ||
      !/^[A-Za-z0-9_-]+$/.test(record.runId || '') ||
      effectiveMonth !== COST_OPENING_FIXTURE_MONTH) {
    throw new Error('BLOCKED: cost fixtures require the authorized local tenant and exact case/run scope')
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const fixture = {
    caseId, runId: record.runId,
    fixtureId: `E2E-${caseId}-${record.runId}-${suffix}`,
    tenantId: '1', accountingOrgId: '1', effectiveMonth, exclusive: true
  }
  const remark = remarkForFixture(fixture)
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), cost: fixture }
  const department = await api.postBusiness('/system/dept/create', {
    name: `E2E-COST-${suffix}`, code: `E2E-COST-${suffix}`,
    unitType: 'DEPARTMENT', parentId: '0', sort: 9999, status: 0
  })
  fixture.departmentId = preciseId(department.data, 'Cost fixture department')
  const center = await api.postBusiness('/cost/centers', {
    accountingOrgId: 1,
    code: `E2E-COST-${suffix}`,
    name: `E2E成本专属中心${suffix}`,
    enabledAt: `${effectiveMonth}-01`,
    departmentIds: [fixture.departmentId],
    remark
  })
  fixture.costCenterId = preciseId(center.data?.id, 'Cost fixture center')
  const model = await api.postBusiness('/cost/model-versions', costModelPayload({
    versionNo: `E2E-${caseId}-${suffix}`, effectiveMonth, remark
  }))
  fixture.modelVersionId = preciseId(model.data?.id, 'Cost fixture model')
  const components = await api.putBusiness(`/cost/model-versions/${fixture.modelVersionId}/components`, {
    categories: [{
      id: 'fixture-category', parentId: '', code: `E2E-CAT-${suffix}`,
      name: 'E2E成本专属分类', sortNo: 100, status: 'ENABLED'
    }],
    items: [{
      id: 'fixture-item', categoryId: 'fixture-category', code: `E2E-ITEM-${suffix}`,
      name: 'E2E成本专属构成项', inclusionRate: 100, fetchMode: 'MANUAL',
      resultScope: 'FORMAL_COST', businessDirection: 'COST',
      systemItem: false, participateWip: true, status: 'ENABLED', remark
    }],
    sourceRules: [{
      id: 'fixture-source', componentItemId: 'fixture-item',
      sourceType: 'E2E_MANUAL', sourcePriority: 1,
      effectiveFrom: `${effectiveMonth}-01`, status: 'ENABLED'
    }]
  })
  if (components.data?.items?.length !== 1) {
    throw new Error('Cost fixture component creation did not return the dedicated item')
  }
  fixture.componentItemId = preciseId(components.data.items[0].id, 'Cost fixture component')
  caseRecord.evidence.push(`专属成本前置：${JSON.stringify(fixture)}`)
  caseRecord.checks.push({
    name: '通过正式 API 建立本案例本轮专属部门、远期成本中心、草稿模型和构成项',
    passed: true,
    details: `tenant=1 department=${fixture.departmentId} center=${fixture.costCenterId} model=${fixture.modelVersionId} item=${fixture.componentItemId}`
  })
  return fixture
}

export async function createLockedCostModelFixture ({ api, record, caseRecord, remark }) {
  const lockedMonths = new Set()
  let pageNo = 1
  while (true) {
    const response = await api.getBusiness(`/cost/model-versions?accountingOrgId=1&pageNo=${pageNo}&pageSize=100`)
    if (!Array.isArray(response.data?.list) || !Number.isSafeInteger(response.data?.total)) {
      throw new Error('Locked model preflight returned a malformed page')
    }
    for (const model of response.data.list) {
      if (model.status === 'LOCKED' && model.enterpriseType === 'MANUFACTURING') {
        lockedMonths.add(model.effectiveMonth)
      }
    }
    if (pageNo * 100 >= response.data.total) break
    pageNo++
  }
  const year = 2100 + Math.floor(lockedMonths.size / 12)
  const effectiveMonth = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    .find((month) => !lockedMonths.has(month))
  if (!effectiveMonth) throw new Error('No unused future month for the dedicated locked model')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const created = await api.postBusiness('/cost/model-versions', costModelPayload({
    versionNo: `E2E-LOCK-${suffix}`, effectiveMonth, remark
  }))
  const id = preciseId(created.data?.id, 'Locked cost fixture')
  caseRecord.fixtures.cost.lockedModelId = id
  caseRecord.fixtures.cost.lockedModelMonth = effectiveMonth
  const locked = await api.postBusiness(`/cost/model-versions/${id}/lock`)
  if (locked.data?.status !== 'LOCKED' || locked.data?.remark !== remark) {
    throw new Error('Dedicated cost model was not locked with the expected ownership')
  }
  caseRecord.evidence.push(`专属锁定模型：id=${id} month=${effectiveMonth} run=${record.runId}`)
  return { id, effectiveMonth }
}
