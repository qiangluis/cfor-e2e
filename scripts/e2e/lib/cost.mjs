import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'

const MAX_SIGNED_BIGINT = 9223372036854775807n
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export const COST_FIXTURE_START_MONTH = '2099-12'

export const preciseCostId = (value, label = '成本 ID') => {
  const text =
    typeof value === 'string'
      ? value
      : Number.isSafeInteger(value)
        ? String(value)
        : ''
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > MAX_SIGNED_BIGINT) {
    throw new Error(`${label}不是可安全保留的数据库 ID`)
  }
  return text
}

export const isCostFixtureMonth = (value) =>
  typeof value === 'string' && MONTH_PATTERN.test(value) && value >= COST_FIXTURE_START_MONTH

export const unwrapCostData = (payload, label = '成本业务响应') => {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${label}不是对象响应`)
  }
  const code = payload.code
  if (!(code === 0 || code === 200 || code === '0' || (code === '200' && payload.success === true))) {
    throw new Error(`${label}业务失败：${payload.msg || payload.message || JSON.stringify(payload)}`)
  }
  let data = payload.data
  for (let depth = 0; depth < 2; depth += 1) {
    if (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Object.keys(data).length === 1 &&
      Object.prototype.hasOwnProperty.call(data, 'data')
    ) {
      data = data.data
    } else {
      break
    }
  }
  return data
}

export const unwrapCostList = (payload, label = '成本列表响应') => {
  const data = unwrapCostData(payload, label)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.records)) return data.records
  if (Array.isArray(data?.rows)) return data.rows
  throw new Error(`${label}缺少数组数据`)
}

export const costPage = (payload, label = '成本分页响应') => {
  const data = unwrapCostData(payload, label)
  if (!Array.isArray(data?.list) || !Number.isSafeInteger(data.total)) {
    throw new Error(`${label}缺少 list/total 分页结构`)
  }
  return data
}

const withQuery = (pathname, query) => {
  const url = new URL(pathname, 'http://cost.local')
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  return `${url.pathname}${url.search}`
}

export const listCostRows = async (api, pathname, label = pathname) => {
  const rows = []
  for (let pageNo = 1; pageNo <= 1000; pageNo += 1) {
    const page = costPage(
      await api.getBusiness(
        withQuery(pathname, { accountingOrgId: 1, pageNo, pageSize: 100 })
      ),
      label
    )
    if (page.total < rows.length + page.list.length) {
      throw new Error(`${label}分页总数不一致`)
    }
    rows.push(...page.list)
    if (rows.length === page.total) return rows
    if (page.list.length === 0) {
      throw new Error(`${label}分页提前返回空列表`)
    }
  }
  throw new Error(`${label}分页超过安全上限`)
}

export const findCostPeriod = (periods, predicate, label = '成本期间') => {
  const matches = (periods || []).filter(predicate)
  if (matches.length === 0) return null
  return [...matches].sort((left, right) =>
    String(right.period || '').localeCompare(String(left.period || ''))
  )[0]
}

export const requireCostPeriod = (periods, predicate, label = '成本期间') => {
  const period = findCostPeriod(periods, predicate, label)
  if (!period?.id) throw new Error(`当前租户没有符合条件的${label}`)
  return period
}

export const findCostModel = (models, predicate, label = '成本模型') => {
  const matches = (models || []).filter(predicate)
  if (matches.length === 0) return null
  return [...matches].sort((left, right) =>
    String(right.effectiveMonth || '').localeCompare(String(left.effectiveMonth || ''))
  )[0]
}

export const costModelPayload = ({ versionNo, effectiveMonth, remark, enterpriseType = 'MANUFACTURING' }) => ({
  accountingOrgId: 1,
  versionNo,
  enterpriseType,
  dimensionMode: enterpriseType === 'TRADE' ? '商品' : '产品',
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

export const nextCostMonth = (month, offset = 1) => {
  const [year, monthNumber] = String(month).split('-').map(Number)
  const total = year * 12 + monthNumber - 1 + offset
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

export const allocateCostMonth = async (api, preferred = COST_FIXTURE_START_MONTH) => {
  if (!isCostFixtureMonth(preferred)) {
    throw new Error('成本夹具月份必须是 2099-12 或更晚')
  }
  const [models, periods] = await Promise.all([
    listCostRows(api, '/cost/model-versions', '成本模型版本'),
    listCostRows(api, '/cost/periods', '成本期间')
  ])
  const used = new Set([
    ...models.map((row) => row.effectiveMonth).filter(Boolean),
    ...periods.map((row) => row.period).filter(Boolean)
  ])
  let candidate = preferred
  for (let index = 0; index < 1200; index += 1) {
    if (!used.has(candidate)) return candidate
    candidate = nextCostMonth(candidate)
  }
  throw new Error('没有可用的远期成本夹具月份')
}

export const assertCostWriteScope = ({ record, caseRecord, caseId, allowWrite = true }) => {
  const configured = new URL(config.apiBase)
  const recorded = new URL(record?.environment?.apiBase || config.apiBase)
  const localHost = ['127.0.0.1', 'localhost'].includes(configured.hostname)
  if (
    !allowWrite ||
    process.env.CFOR_E2E_WRITE_FIXTURES !== 'true' ||
    !localHost ||
    configured.port !== '48083' ||
    recorded.hostname !== configured.hostname ||
    recorded.port !== configured.port ||
    String(config.tenantId) !== '1' ||
    String(record?.environment?.tenantId) !== '1' ||
    caseRecord?.id !== caseId ||
    !/^[A-Za-z0-9_-]+$/.test(record?.runId || '')
  ) {
    throw new Error(
      `BLOCKED: ${caseId} 写侧只允许显式 local:48083 tenant 1、精确案例和本轮 run`
    )
  }
}

const fixtureRemark = ({ caseId, runId, suffix, month }) =>
  `CFOR-E2E:${caseId}:${runId}:${suffix}:tenant=1:org=1:month=${month}`

const createDepartment = async (api, suffix, caseId) => {
  const response = unwrapCostData(
    await api.postBusiness('/system/dept/create', {
      name: `E2E-${caseId}-${suffix}`,
      code: `E2E-${caseId}-${suffix}`,
      unitType: 'DEPARTMENT',
      parentId: '0',
      sort: 9999,
      status: 0
    }),
    `${caseId} 专属部门`
  )
  return preciseCostId(response, `${caseId} 部门`)
}

const createCenter = async ({ api, caseId, suffix, month, departmentId, remark }) => {
  const response = unwrapCostData(
    await api.postBusiness('/cost/centers', {
      accountingOrgId: 1,
      code: `E2E-${caseId}-${suffix}`,
      name: `E2E${caseId}成本中心${suffix}`,
      enabledAt: `${month}-01`,
      departmentIds: [departmentId],
      remark
    }),
    `${caseId} 专属成本中心`
  )
  return preciseCostId(response?.id, `${caseId} 成本中心`)
}

const createComponents = async ({ api, modelId, caseId, suffix, month, remark }) => {
  const response = unwrapCostData(
    await api.putBusiness(`/cost/model-versions/${modelId}/components`, {
      categories: [{
        id: 'e2e-category',
        parentId: '',
        code: `E2E-${caseId}-CAT-${suffix}`,
        name: `E2E${caseId}成本分类`,
        sortNo: 100,
        status: 'ENABLED'
      }],
      items: [{
        id: 'e2e-item',
        categoryId: 'e2e-category',
        code: `E2E-${caseId}-ITEM-${suffix}`,
        name: `E2E${caseId}成本构成项`,
        inclusionRate: 100,
        fetchMode: 'MANUAL',
        resultScope: 'FORMAL_COST',
        businessDirection: 'COST',
        systemItem: false,
        participateWip: true,
        status: 'ENABLED',
        remark
      }],
      sourceRules: [{
        id: 'e2e-source',
        componentItemId: 'e2e-item',
        sourceType: 'E2E_MANUAL',
        sourcePriority: 1,
        effectiveFrom: `${month}-01`,
        status: 'ENABLED'
      }]
    }),
    `${caseId} 成本构成项`
  )
  const item = response?.items?.[0]
  return preciseCostId(item?.id, `${caseId} 构成项`)
}

export async function prepareCostModelFixture({ api, record, caseRecord, caseId }) {
  assertCostWriteScope({ record, caseRecord, caseId })
  if (caseRecord.fixtures?.costModel?.runId === record.runId) {
    return caseRecord.fixtures.costModel
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const month = await allocateCostMonth(api)
  const remark = fixtureRemark({ caseId, runId: record.runId, suffix, month })
  const departmentId = await createDepartment(api, suffix, caseId)
  const costCenterId = await createCenter({
    api, caseId, suffix, month, departmentId, remark
  })
  const versionNo = `E2E-${caseId}-${suffix}`
  const model = unwrapCostData(
    await api.postBusiness('/cost/model-versions', costModelPayload({
      versionNo, effectiveMonth: month, remark
    })),
    `${caseId} 草稿模型`
  )
  const modelId = preciseCostId(model?.id, `${caseId} 草稿模型`)
  const componentItemId = await createComponents({
    api, modelId, caseId, suffix, month, remark
  })
  const fixture = {
    caseId,
    runId: record.runId,
    suffix,
    month,
    effectiveMonth: month,
    remark,
    departmentId,
    costCenterId,
    modelId,
    modelVersionId: modelId,
    componentItemId,
    versionNo,
    status: 'DRAFT',
    exclusive: true,
    tenantId: '1',
    accountingOrgId: '1'
  }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costModel: fixture }
  caseRecord.evidence ||= []
  caseRecord.evidence.push(`成本专属草稿模型夹具：${JSON.stringify(fixture)}`)
  caseRecord.checks.push({
    name: `${caseId} 通过正式 API 建立远期专属部门、成本中心、草稿模型和构成项`,
    passed: true,
    details: `model=${modelId}; center=${costCenterId}; item=${componentItemId}`
  })
  return fixture
}

export async function prepareCostPeriodFixture({ api, record, caseRecord, caseId }) {
  assertCostWriteScope({ record, caseRecord, caseId })
  if (caseRecord.fixtures?.costPeriod?.runId === record.runId) {
    return caseRecord.fixtures.costPeriod
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const month = await allocateCostMonth(api)
  const remark = fixtureRemark({ caseId, runId: record.runId, suffix, month })
  const departmentId = await createDepartment(api, suffix, caseId)
  const costCenterId = await createCenter({
    api, caseId, suffix, month, departmentId, remark
  })
  const versionNo = `E2E-${caseId}-${suffix}`
  const model = unwrapCostData(
    await api.postBusiness('/cost/model-versions', costModelPayload({
      versionNo, effectiveMonth: month, remark
    })),
    `${caseId} 成本模型`
  )
  const modelId = preciseCostId(model?.id, `${caseId} 成本模型`)
  const componentItemId = await createComponents({
    api, modelId, caseId, suffix, month, remark
  })
  const locked = unwrapCostData(
    await api.postBusiness(`/cost/model-versions/${modelId}/lock`),
    `${caseId} 锁定成本模型`
  )
  if (locked?.status !== 'LOCKED') throw new Error(`${caseId} 成本模型锁定失败`)
  const created = unwrapCostData(
    await api.postBusiness('/cost/periods', {
      accountingOrgId: 1,
      period: month,
      enterpriseType: 'MANUFACTURING',
      modelVersion: versionNo,
      requestId: `e2e-${caseId.toLowerCase()}-${record.runId}-${suffix}`
    }),
    `${caseId} 成本期间`
  )
  const periodId = preciseCostId(created?.periodId || created?.id, `${caseId} 成本期间`)
  const period = unwrapCostData(
    await api.getBusiness(`/cost/periods/${periodId}`),
    `${caseId} 成本期间回读`
  )
  if (
    String(period?.id) !== periodId ||
    period.period !== month ||
    String(period.modelVersionId) !== modelId ||
    period.modelVersionNo !== versionNo ||
    period.status !== 'ACCOUNTING'
  ) {
    throw new Error(`${caseId} 专属成本期间归属或状态不正确`)
  }
  const fixture = {
    caseId,
    runId: record.runId,
    suffix,
    month,
    remark,
    departmentId,
    costCenterId,
    modelId,
    componentItemId,
    versionNo,
    periodId,
    period,
    exclusive: true,
    tenantId: '1',
    accountingOrgId: '1'
  }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costPeriod: fixture }
  caseRecord.evidence ||= []
  caseRecord.evidence.push(`成本专属核算中期间夹具：${JSON.stringify({
    caseId, month, modelId, periodId, costCenterId
  })}`)
  caseRecord.checks.push({
    name: `${caseId} 通过正式 API 建立远期专属核算中期间`,
    passed: true,
    details: `period=${periodId}; month=${month}`
  })
  return fixture
}

export async function prepareCostMaterialFixture({ api, record, caseRecord, caseId }) {
  assertCostWriteScope({ record, caseRecord, caseId })
  if (caseRecord.fixtures?.costMaterial?.runId === record.runId) {
    return caseRecord.fixtures.costMaterial
  }
  const template = unwrapCostData(
    await api.getBusiness('/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'),
    `${caseId} 物料模板`
  )
  const sample = (template?.records || template?.list || []).find(
    (row) => row?.id && row?.unitId
  )
  if (!sample) throw new Error(`${caseId} 没有可复用的启用采购物料模板`)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const materialId = preciseCostId(
    unwrapCostData(
      await api.postBusiness('/mes/basMaterial/add', {
        code: `E2E-${caseId}-MAT-${suffix}`,
        name: `E2E${caseId}期初物料${suffix}`,
        auxName: `E2E${caseId}期初物料${suffix}`,
        unitId: String(sample.unitId),
        inventoryNature: 'STOCK',
        isMaterial: 'Y',
        isEnabled: 1,
        purchased: 'Y',
        saled: 'Y',
        produced: 'N',
        source: 'purchase',
        leadTime: 1,
        bufferTime: 1,
        batchManaged: 'N',
        oneBarcode: 'N',
        periodManaged: 'N',
        gradeManaged: 'N',
        remark: `CFOR-E2E ${caseId} material ${record.runId}`
      }),
      `${caseId} 物料`
    ),
    `${caseId} 物料`
  )
  const material = unwrapCostData(
    await api.getBusiness(`/mes/basMaterial/queryById?id=${materialId}`),
    `${caseId} 物料回读`
  )
  if (
    String(material?.id) !== materialId ||
    Number(material?.isEnabled) !== 1 ||
    !material.code ||
    !material.name
  ) {
    throw new Error(`${caseId} 物料夹具未回读为启用 Base 存货`)
  }
  const fixture = {
    caseId,
    runId: record.runId,
    materialId,
    productCode: material.code,
    productName: material.name,
    unitId: String(material.unitId),
    exclusive: true,
    tenantId: '1'
  }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costMaterial: fixture }
  caseRecord.evidence ||= []
  caseRecord.evidence.push(`成本期初物料夹具：${JSON.stringify(fixture)}`)
  return fixture
}

export async function prepareCostDepartmentFixture({ api, record, caseRecord, caseId }) {
  assertCostWriteScope({ record, caseRecord, caseId })
  if (caseRecord.fixtures?.costDepartment?.runId === record.runId) {
    return caseRecord.fixtures.costDepartment
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const name = `E2E-${caseId}-DEPT-${suffix}`
  const departmentId = preciseCostId(
    unwrapCostData(
      await api.postBusiness('/system/dept/create', {
        name,
        code: name,
        unitType: 'DEPARTMENT',
        parentId: '0',
        sort: 9999,
        status: 0
      }),
      `${caseId} 专属部门`
    ),
    `${caseId} 专属部门`
  )
  const fixture = {
    caseId,
    runId: record.runId,
    departmentId,
    name,
    code: name,
    tenantId: '1',
    exclusive: true
  }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costDepartment: fixture }
  caseRecord.evidence ||= []
  caseRecord.evidence.push(`成本中心专属部门夹具：${JSON.stringify(fixture)}`)
  return fixture
}

export const visibleTitleContains = async (page, selector, expected) => {
  const titles = await page.locator(`${selector}:visible`).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('title') || '').filter(Boolean)
  )
  return titles.some((title) => title.includes(expected))
}
