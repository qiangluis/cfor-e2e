import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'

/**
 * Shared write-side fixtures for the COST suites that need real published /
 * accounting periods. Each scenario owns a far-future month so it can never
 * collide with business data, and every artefact is created through the
 * public API only.
 */

export const COST_SCENARIO_BY_CASE = {
  ...Object.fromEntries([
    'COST-002', 'COST-003', 'COST-005', 'COST-008', 'COST-009', 'COST-013',
    'COST-015', 'COST-016', 'COST-017', 'COST-018', 'COST-019', 'COST-026',
    'COST-027', 'COST-033'
  ].map((caseId) => [caseId, 'accounting'])),
  'COST-006': 'published',
  'COST-012': 'published',
  'COST-014': 'published',
  'COST-022': 'published',
  'COST-025': 'published',
  'COST-028': 'published',
  'COST-034': 'published',
  'COST-010': 'purchase',
  'COST-011': 'purchase',
  'COST-020': 'purchase',
  'COST-021': 'purchase',
  'COST-023': 'trialPending',
  'COST-003': 'trialPending',
  'COST-024': 'carryover'
}

/** 复核角色必须拿到试算确认与正式发布两类权限菜单。 */
const COST_REVIEW_MENU_IDS = ['291010', '291013', '291015', '291017', '58800303']

export const costWorkflowReviewerPermissions = (caseId, key) => {
  if (!['COST-023', 'COST-028'].includes(caseId)) return null
  const read = ['cost:period:query', 'cost:model:query', 'cost:publication:query']
  if (key === 'approvalReviewer') return [
    ...read, 'cost:publication:approve',
    ...(caseId === 'COST-023' ? ['cost:trial:run'] : [])
  ]
  return [
    ...read, 'cost:trial:confirm', 'cost:publication:publish', 'cost:publication:approve',
    ...(caseId === 'COST-023' ? [
      'cost:publication:rollback', 'cost:publication:reopen',
      'cost:operating:confirm', 'cost:operating:publish', 'cost:operating:rollback'
    ] : [])
  ]
}

// Only tenant-assignable menus and their existing navigation ancestors are used.
export const resolveCostWorkflowMenus = (available, full, permissions) => {
  const assignable = new Set(available.map((row) => preciseId(row.id, '可分配菜单')))
  const rows = new Map(full.map((row) => [preciseId(row.id, '正式菜单'), row]))
  const selected = new Set()
  const add = (row) => {
    const visited = new Set()
    while (row) {
      const id = preciseId(row.id, '正式菜单')
      if (!assignable.has(id) || visited.has(id)) {
        throw new Error(`BLOCKED: 成本职责菜单不在租户可分配范围或祖先循环：${id}`)
      }
      visited.add(id)
      selected.add(id)
      if (String(row.parentId) === '0') break
      row = rows.get(String(row.parentId))
      if (!row) throw new Error('BLOCKED: 成本职责菜单缺少正式祖先')
    }
  }
  for (const permission of permissions) {
    const matches = full.filter((row) => row.permission === permission && assignable.has(String(row.id)))
    if (matches.length !== 1) throw new Error(`BLOCKED: 租户正式可分配成本权限缺失或歧义：${permission}`)
    add(matches[0])
  }
  const publishPage = full.filter((row) =>
    row.type === 2 && (row.path === 'cost-publish' ||
      /"page"\s*:\s*"cost-publish"/.test(row.query || '')) && assignable.has(String(row.id)))
  if (publishPage.length !== 1) throw new Error('BLOCKED: 租户正式成本发布页面缺失或歧义')
  add(publishPage[0])
  return [...selected]
}

const isOk = (payload) => isBusinessSuccess(payload) || payload?.code === '0'
const fail = (payload, label) => {
  const message = payload?.msg || payload?.message || JSON.stringify(payload).slice(0, 300)
  throw new Error(`${label} failed: ${message}`)
}

const preciseId = (value, label) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw new Error(`${label} did not return an exact database ID`)
  }
  return text
}

export const findPublishedPeriod = (periods) =>
  (periods || []).find(
    (row) => row.status === 'COST_PUBLISHED' && row.currentPublicationId
  ) || null

export const findAccountingPeriod = (periods) =>
  (periods || []).find((row) => row.status === 'ACCOUNTING') || null

export const findTrialPendingPeriod = (periods) =>
  (periods || []).find(
    (row) => row.status === 'TRIAL_PENDING' && row.currentTrialId
  ) || null

const shiftMonth = (month, offset) => {
  const [year, index] = month.split('-').map(Number)
  const total = year * 12 + (index - 1) + offset
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

export const shiftCostMonth = shiftMonth

export const loadCostScenario = (caseRecord) => caseRecord?.fixtures?.costScenario || null

const responseData = (payload, label) => {
  if (!isOk(payload)) fail(payload, label)
  return payload.data
}

const listAllCostPages = async (api, path) => {
  const rows = []
  for (let pageNo = 1; pageNo <= 1000; pageNo++) {
    const page = responseData(
      await api.getBusiness(`${path}?accountingOrgId=1&pageNo=${pageNo}&pageSize=100`),
      path
    )
    if (!Array.isArray(page?.list) || !Number.isSafeInteger(page.total) ||
        page.total < rows.length + page.list.length) {
      throw new Error('成本列表结构异常，不能继续补齐夹具')
    }
    rows.push(...page.list)
    if (rows.length === page.total) return rows
    if (page.list.length === 0) throw new Error('成本分页提前返回空列表')
  }
  throw new Error('成本分页超过安全上限')
}

/** 未来月份池：只排除已被 LOCKED 模型或既有期间占用的月份，并保证多月份场景连续。 */
const allocateMonths = async (api, count, { afterExisting = false } = {}) => {
  const models = await listAllCostPages(api, '/cost/model-versions')
  const periods = await listAllCostPages(api, '/cost/periods')
  const used = new Set([
    ...models.map((row) => row.effectiveMonth),
    ...periods.map((row) => row.period)
  ])
  const available = new Set()
  for (let year = 2200; year < 2260; year++) {
    for (let index = 1; index <= 12; index++) {
      const month = `${year}-${String(index).padStart(2, '0')}`
      if (!used.has(month)) available.add(month)
    }
  }
  const pool = []
  for (let year = 2200; year < 2260; year++) {
    for (let index = 1; index <= 12; index++) {
      const month = `${year}-${String(index).padStart(2, '0')}`
      if (!available.has(month)) continue
      if (afterExisting) {
        const latestExisting = [...used].sort().at(-1)
        if (latestExisting && month <= latestExisting) continue
      }
      const candidate = [month]
      for (let offset = 1; offset < count; offset++) {
        const next = shiftMonth(month, offset)
        if (!available.has(next)) break
        candidate.push(next)
      }
      if (candidate.length === count) return candidate
    }
  }
  throw new Error(`No ${count} consecutive unused far-future months for the cost scenario fixture`)
}

export const loginAs = async (record, username, password) => {
  const anonymous = createApiClient({ token: '', record })
  const login = await anonymous.request(
    'POST',
    '/system/auth/login-encrypted',
    {
      tenantName: config.tenantName,
      username,
      password,
      captchaVerification: '',
      rememberMe: true
    },
    { encrypted: true }
  )
  const direct = login?.data?.accessToken || login?.data?.token
  if (direct) return direct
  const options = await anonymous.request(
    'POST',
    '/system/auth/tenant-options-encrypted',
    { tenantName: config.tenantName, username, password },
    { encrypted: true }
  )
  const selected = await anonymous.request('POST', '/system/auth/login-tenant-selection', {
    selectionTicket: options?.data?.selectionTicket,
    tenantId: Number(config.tenantId)
  })
  const token = selected?.data?.accessToken || selected?.data?.token
  if (!token) throw new Error(`reviewer login failed: ${JSON.stringify(selected).slice(0, 300)}`)
  return token
}

/** 复核人必须与试算执行人（admin）分离，因此为本轮单独建角色与账号。 */
export const createReviewer = async ({
  api, record, suffix, fixture, key = 'reviewer', loginImmediately = true,
  permissions = null
}) => {
  const available = responseData(
    await api.getBusiness('/system/menu/list-all-simple'),
    '可分配菜单'
  )
  const assignable = new Set((available || []).map((row) => String(row.id)))
  const menuIds = permissions
    ? resolveCostWorkflowMenus(available, responseData(
      await api.getBusiness('/system/menu/list'), '正式菜单权限'), permissions)
    : COST_REVIEW_MENU_IDS.filter((id) => assignable.has(id))
  if (!permissions && menuIds.length !== COST_REVIEW_MENU_IDS.length) {
    throw new Error(
      `成本复核权限菜单缺失：${COST_REVIEW_MENU_IDS.filter((id) => !assignable.has(id)).join(',')}`
    )
  }
  const roleId = preciseId(
    responseData(
      await api.postBusiness('/system/role/create', {
        name: `E2E成本复核${suffix}`,
        code: `e2e_cost_reviewer_${suffix.toLowerCase()}`,
        sort: 999,
        status: 0,
        remark: `CFOR-E2E cost reviewer ${suffix}`
      }),
      '成本复核角色'
    ),
    '成本复核角色'
  )
  fixture[`${key}RoleId`] = roleId
  fixture[`${key}RoleCode`] = `e2e_cost_reviewer_${suffix.toLowerCase()}`
  if (permissions) fixture[`${key}Authorization`] = {
    permissions: [...permissions], menuIds, source: 'tenant-assignable formal menu intersection'
  }
  responseData(
    await api.postBusiness('/system/permission/assign-role-menu', { roleId, menuIds }),
    '成本复核角色菜单'
  )
  const username = `e2ecost${suffix.toLowerCase()}`
  // 平台密码策略为 4-16 位，夹具口令必须落在该区间内。
  const password = `E2e!${suffix.slice(0, 8)}A9`
  fixture[`${key}Password`] = password
  const userId = preciseId(
    responseData(
      await api.postBusiness('/system/user/create', {
        username,
        nickname: `E2E成本复核${suffix}`,
        password,
        sex: 0,
        postIds: [],
        roleIds: [roleId],
        remark: `CFOR-E2E cost reviewer ${suffix}`
      }),
      '成本复核账号'
    ),
    '成本复核账号'
  )
  fixture[`${key}UserId`] = userId
  fixture[`${key}Username`] = username
  const token = loginImmediately ? await loginAs(record, username, password) : null
  return { roleId, userId, username, password, token }
}

export async function prepareCostWorkflowReviewers ({ api, record, caseRecord }) {
  const fixture = loadCostScenario(caseRecord)
  if (!['COST-023', 'COST-028'].includes(caseRecord.id) ||
      fixture?.caseId !== caseRecord.id || fixture?.runId !== record.runId ||
      fixture?.tenantId !== '1' || config.target !== 'local' || config.tenantId !== '1') {
    throw new Error('BLOCKED: workflow reviewers require an exclusive local case/run fixture')
  }
  for (const key of ['reviewer', 'approvalReviewer']) {
    if (fixture[`${key}UserId`]) continue
    await createReviewer({
      api, record, fixture, key, loginImmediately: false,
      permissions: costWorkflowReviewerPermissions(caseRecord.id, key),
      suffix: key === 'reviewer' ? fixture.suffix : `${fixture.suffix.slice(0, 8)}AP`
    })
  }
}

const createDepartment = async (api, suffix) => preciseId(
  responseData(
    await api.postBusiness('/system/dept/create', {
      name: `E2E-COST-SCENARIO-${suffix}`,
      code: `E2E-COST-SCENARIO-${suffix}`,
      unitType: 'DEPARTMENT',
      parentId: '0',
      sort: 9999,
      status: 0
    }),
    '成本场景部门'
  ),
  '成本场景部门'
)

const createCenter = async ({ api, suffix, month, departmentId, remark, code }) =>
  preciseId(
    responseData(
      await api.postBusiness('/cost/centers', {
        accountingOrgId: 1,
        code: code || `E2E-SC-${suffix}`,
        name: `E2E成本场景中心${suffix}`,
        enabledAt: `${month}-01`,
        departmentIds: [departmentId],
        remark
      }),
      '成本场景中心'
    )?.id,
    '成本场景中心'
  )

const createModel = async ({ api, suffix, month, remark, enterpriseType, dimensionMode, versionNo }) =>
  preciseId(
    responseData(
      await api.postBusiness('/cost/model-versions', {
        accountingOrgId: 1,
        versionNo,
        enterpriseType,
        dimensionMode,
        valuationScopeMode: 'GLOBAL',
        valuationMethod: 'MOVING_AVERAGE',
        valuationScopeConfigJson: JSON.stringify({
          finishedDataSourceMode: 'MANUAL',
          productionOrderDataSourceMode: 'MANUAL'
        }),
        finishedIoScopeJson: '[]',
        productionOrderScopeJson: '[]',
        effectiveMonth: month,
        remark
      }),
      '成本场景模型'
    )?.id,
    '成本场景模型'
  )

const putComponents = async ({ api, modelId, suffix, month, sourceType, remark, itemName }) => {
  const components = responseData(
    await api.putBusiness(`/cost/model-versions/${modelId}/components`, {
      categories: [{
        id: 'scenario-category',
        parentId: '',
        code: `E2E-SCAT-${suffix}`,
        name: 'E2E成本场景分类',
        sortNo: 100,
        status: 'ENABLED'
      }],
      items: [{
        id: 'scenario-item',
        categoryId: 'scenario-category',
        code: `E2E-SITEM-${suffix}`,
        name: itemName,
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
        id: 'scenario-source',
        componentItemId: 'scenario-item',
        sourceType,
        sourcePriority: 1,
        effectiveFrom: `${month}-01`,
        status: 'ENABLED'
      }]
    }),
    '成本场景构成项'
  )
  const item = components?.items?.[0]
  if (!item?.id) throw new Error('成本场景构成项未返回主键')
  return preciseId(item.id, '成本场景构成项')
}

const lockModel = async ({ api, modelId }) => {
  const locked = responseData(
    await api.postBusiness(`/cost/model-versions/${modelId}/lock`),
    '成本模型锁定'
  )
  if (locked?.status !== 'LOCKED') throw new Error('成本模型未进入 LOCKED 状态')
}

const createPeriod = async ({ api, month, enterpriseType, versionNo }) => {
  const created = responseData(
    await api.postBusiness('/cost/periods', {
      accountingOrgId: 1,
      period: month,
      enterpriseType,
      modelVersion: versionNo
    }),
    '成本期间创建'
  )
  if (!created?.periodId) throw new Error('成本期间创建未返回 periodId')
  return preciseId(created.periodId, '成本期间')
}

const readPeriod = async (api, periodId) =>
  responseData(await api.getBusiness(`/cost/periods/${periodId}`), '成本期间详情')

/**
 * 采购成本只在贸易型期间成立：MANUFACTURING 期间的试算与发布都会过滤采购来源。
 * 生产型企业禁止新建 TRADE 轨道，因此这里按平台已支持的企业类型，在建模型期间把企业类型
 * 临时切到"生产贸易混合型"，模型锁定并建好本期期间后立即恢复原值（含保存前回读）。
 * 官方 API 只接受企业资料完整字段，不能直接回写 id/审计字段。
 */
export const withMixedEnterpriseType = async (api, action) => {
  const profile = responseData(
    await api.getBusiness('/system/enterprise-organization/current'),
    '企业资料'
  )
  const original = profile?.enterpriseType
  if (!original) throw new Error('成本场景缺少企业类型，无法构造贸易型成本期间')
  const body = {
    enterpriseFullName: profile.enterpriseFullName,
    enterpriseShortName: profile.enterpriseShortName,
    unifiedSocialCreditCode: profile.unifiedSocialCreditCode,
    industryCategory: profile.industryCategory,
    industrySubCategory: profile.industrySubCategory,
    taxpayerQualification: profile.taxpayerQualification,
    province: profile.province,
    provinceCode: profile.provinceCode,
    city: profile.city,
    cityCode: profile.cityCode,
    district: profile.district,
    districtCode: profile.districtCode,
    registeredAddress: profile.registeredAddress,
    enterpriseLogoUrl: profile.enterpriseLogoUrl,
    brandMarkUrl: profile.brandMarkUrl,
    brandLogoUrl: profile.brandLogoUrl,
    brandDarkLogoUrl: profile.brandDarkLogoUrl
  }
  if (original === '生产贸易混合型' || original === '贸易型') {
    return { original, switched: false, result: await action() }
  }
  await api.putBusiness('/system/enterprise-organization/current', {
    ...body, enterpriseType: '生产贸易混合型'
  })
  try {
    const switched = responseData(
      await api.getBusiness('/system/enterprise-organization/current'),
      '企业类型切换回读'
    )
    if (switched?.enterpriseType !== '生产贸易混合型') {
      throw new Error('企业类型未切换到生产贸易混合型，无法构造贸易型成本期间')
    }
    return { original, switched: true, result: await action() }
  } finally {
    await api.putBusiness('/system/enterprise-organization/current', {
      ...body, enterpriseType: original
    })
    const restored = responseData(
      await api.getBusiness('/system/enterprise-organization/current'),
      '企业类型恢复回读'
    )
    if (restored?.enterpriseType !== original) {
      throw new Error(`企业类型未恢复到原值 ${original}`)
    }
  }
}

/**
 * 采购入库必须走真实审批链路才会计入成本来源；质检方案、存货规则与单号规则
 * 属于租户级基础配置，缺失时按正式接口补齐（幂等）。
 */
const ensureQualityFixtures = async ({ api, materialId }) => {
  const plans = responseData(
    await api.getBusiness('/mes/quality/qualityPlan/list/dictText?pageNo=1&pageSize=100&type=101'),
    '采购入库检方案'
  )
  const plan = (plans?.records || plans?.list || []).find((row) => row?.id)
  if (!plan) throw new Error('租户缺少采购入库检方案(101)，无法构造带质检的采购入库')
  if (Number(plan.publishStatus) !== 1) {
    throw new Error('BLOCKED: cost fixture cannot publish a shared quality plan')
  }
  // 场景物料是每次新建的，质检存货规则必然不存在，直接按正式接口补一条默认规则。
  responseData(
    await api.postBusiness('/mes/quality/qualityMaterial/addBatch', [{
      materialId: String(materialId),
      planId: String(plan.id),
      type: '101',
      effectiveFrom: new Date().toISOString().slice(0, 10),
      isDefault: true,
      priority: 999
    }]),
    '质检存货规则批量新增'
  )
  const findBillNoRule = async () =>
    responseData(
      await api.getBusiness('/mes/fillRule/list?pageNo=1&pageSize=20&ruleCode=qc_zjd_bill_no'),
      '质检单号规则'
    )?.records || []
  const billNoRules = await findBillNoRule()
  if (!billNoRules.length) {
    throw new Error('BLOCKED: cost fixture cannot create or publish shared bill-number rules')
  }
  return plan.id
}

const createDedicatedMaterial = async ({ api, suffix }) => {
  const template = responseData(
    await api.getBusiness('/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'),
    '物料模板'
  )
  const sample = (template?.records || template?.list || []).find((row) => row?.id && row?.unitId)
  if (!sample) throw new Error('租户缺少可复用的采购物料模板，无法构造专属成本物料')
  const materialId = preciseId(
    responseData(
      await api.postBusiness('/mes/basMaterial/add', {
        code: `E2E-COST-MAT-${suffix}`,
        name: `E2E成本物料${suffix}`,
        auxName: `E2E成本物料${suffix}`,
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
        remark: `CFOR-E2E cost scenario material ${suffix}`
      }),
      '成本场景物料'
    ),
    '成本场景物料'
  )
  const material = responseData(
    await api.getBusiness(`/mes/basMaterial/queryById?id=${materialId}`),
    '成本场景物料详情'
  )
  if (!material?.unitId) throw new Error('成本场景物料缺少计量单位')
  return { materialId, unitId: String(material.unitId) }
}

/** 创建并审核一张真实采购入库单，返回可用于成本来源刷新的期间内事实。 */
export const createAuditedPurchaseReceipt = async ({
  api, suffix, month, material, warehouseId, accountId, fixture = {}
}) => {
  const supplierId = preciseId(
    responseData(
      await api.postBusiness('/base/partner/create', {
        name: `E2E-COST-SUP-${suffix}`,
        shortName: 'E2E-COST-SUP',
        partnerKind: 'ORGANIZATION',
        status: 'ACTIVE',
        customerEnabled: false,
        supplierEnabled: true,
        carrierEnabled: false,
        remark: `CFOR-E2E cost scenario supplier ${suffix}`
      }),
      '成本场景供应商'
    ),
    '成本场景供应商'
  )
  fixture.supplierId = supplierId
  const orderId = preciseId(
    responseData(
      await api.postBusiness('/erp/purchase-order/create', {
        type: 0,
        supplierId,
        accountId: String(accountId),
        orderTime: `${month}-05T10:00:00`,
        billDate: `${month}-05`,
        discountPercent: 0,
        discountPrice: 0,
        depositPrice: 0,
        totalCount: 2,
        totalProductPrice: 123.45,
        totalTaxPrice: 0,
        totalPrice: 123.45,
        directCreate: 1,
        directCreateReason: 'CFOR E2E cost scenario',
        remark: `CFOR-E2E cost scenario order ${suffix}`,
        items: [{
          entryNo: 1,
          productId: material.materialId,
          productUnitId: material.unitId,
          productPrice: 61.725,
          count: 2,
          taxPercent: 0,
          totalPrice: 123.45,
          taxPrice: 0,
          remark: 'CFOR E2E cost scenario line'
        }]
      }),
      '成本场景采购订单'
    ),
    '成本场景采购订单'
  )
  fixture.purchaseOrderId = orderId
  const order = responseData(
    await api.getBusiness(`/erp/purchase-order/get?id=${orderId}`),
    '成本场景采购订单详情'
  )
  const orderItemId = order?.items?.[0]?.id
  if (!orderItemId) throw new Error('成本场景采购订单缺少明细主键')
  fixture.orderItemId = preciseId(orderItemId, '成本场景采购订单明细')
  const noticeCode = `AUTOTEST-COST-${suffix}-ASN`
  const noticeId = preciseId(
    responseData(
      await api.postBusiness('/mes/wms/arrival-notice/create', {
        code: noticeCode,
        name: noticeCode,
        purchaseOrderId: String(orderId),
        purchaseOrderCode: order.billNo,
        vendorId: String(supplierId),
        supplierShipmentKey: `${suffix}-SHIP`,
        supplierShipmentNo: `${suffix}-NO`,
        arrivalDate: `${month}-06T09:00:00`,
        shippedAt: `${month}-05T10:00:00`,
        remark: `CFOR-E2E cost scenario ASN ${suffix}`,
        lines: [{
          itemId: material.materialId,
          purchaseOrderItemId: String(orderItemId),
          unitId: material.unitId,
          arrivalQuantity: 2,
          iqcCheckFlag: false,
          batchNo: `E2E-COST-${suffix}-B`,
          remark: 'CFOR E2E cost scenario ASN line'
        }]
      }),
      '成本场景到货通知'
    ),
    '成本场景到货通知'
  )
  fixture.noticeId = noticeId
  responseData(
    await api.postBusiness(`/mes/wms/arrival-notice/submit?id=${encodeURIComponent(noticeId)}`),
    '成本场景到货通知提交'
  )
  const notice = responseData(
    await api.getBusiness(`/mes/wms/arrival-notice/get?id=${encodeURIComponent(noticeId)}`),
    '成本场景到货通知详情'
  )
  if (String(notice?.purchaseOrderId) !== String(orderId) ||
      !Array.isArray(notice?.lines) || notice.lines.length !== 1 ||
      String(notice.lines[0]?.purchaseOrderItemId) !== String(orderItemId) ||
      String(notice.lines[0]?.itemId) !== material.materialId ||
      Number(notice.lines[0]?.arrivalQuantity) !== 2 ||
      ![10, 20, 30].includes(Number(notice?.status))) {
    throw new Error('成本场景到货通知未形成有效的订单来源明细')
  }
  const purchaseInId = preciseId(
    responseData(
      await api.postBusiness('/erp/purchase-in/create', {
        inTime: `${month}-06T10:00:00`,
        businessType: 'NORMAL',
        supplierId,
        accountId: String(accountId),
        orderId: String(orderId),
        discountPercent: 0,
        otherPrice: 0,
        remark: `CFOR-E2E cost scenario receipt ${suffix}`,
        items: [{
          orderItemId: String(orderItemId),
          warehouseId: String(warehouseId),
          productId: material.materialId,
          productUnitId: material.unitId,
          productPrice: 61.725,
          count: 2,
          taxPercent: 0,
          remark: 'CFOR E2E cost scenario receipt line'
        }]
      }),
      '成本场景采购入库'
    ),
    '成本场景采购入库'
  )
  fixture.purchaseInId = purchaseInId
  responseData(
    await api.putBusiness(`/erp/purchase-in/update-status?id=${purchaseInId}&status=20`),
    '成本场景采购入库审核'
  )
  const purchaseIn = responseData(
    await api.getBusiness(`/erp/purchase-in/get?id=${encodeURIComponent(purchaseInId)}`),
    '成本场景采购入库审核回读'
  )
  if (String(purchaseIn?.orderId) !== orderId || Number(purchaseIn.status) !== 20 ||
      purchaseIn.items?.length !== 1 ||
      String(purchaseIn.items[0]?.productId) !== material.materialId ||
      Number(purchaseIn.items[0]?.count) !== 2) {
    throw new Error('成本场景采购入库审核状态或来源明细不一致')
  }
  return { orderId, noticeId, purchaseInId, supplierId }
}

const buildManufacturingModel = async ({ api, suffix, month, remark, versionNo, sourceType, itemName }) => {
  const modelId = await createModel({
    api, suffix, month, remark, versionNo,
    enterpriseType: 'MANUFACTURING',
    dimensionMode: '产品'
  })
  const componentItemId = await putComponents({
    api, modelId, suffix, month, sourceType, remark, itemName
  })
  return { modelId, componentItemId }
}

const moduleScenarioCache = new Map()
/**
 * 这些案例会推进同一采购期间的状态机（草稿确认、试算、正式发布、反月结），
 * 必须各自持有独立期间，否则先执行的案例会把来源快照确认掉，后续案例无法再刷新。
 */
const PER_CASE_SCENARIOS = ['COST-012', 'COST-020', 'COST-021', 'COST-023', 'COST-028']
const cacheKey = (record, scenario, caseId) =>
  `${record?.runId || 'unknown'}:${scenario}` +
  (PER_CASE_SCENARIOS.includes(caseId) ? `:${caseId}` : '')

export const resetCostScenarioCache = () => moduleScenarioCache.clear()

/**
 * 构造 COST 写侧夹具。返回 { period, publicationId, ... }，其中 period 已处于
 * 目标状态，调用方可以直接拿去做正式报表 / 来源刷新 / 反月结等断言。
 */
export async function prepareCostScenario (
  { api, record, caseRecord, scenario },
  dependencies = {}
) {
  const existing = loadCostScenario(caseRecord)
  if (existing && existing.scenario === scenario) return existing
  const key = cacheKey(record, scenario, caseRecord.id)
  const cached = moduleScenarioCache.get(key)
  if (cached) {
    caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costScenario: cached }
    return cached
  }
  if (config.target !== 'local' || String(config.tenantId) !== '1' ||
      String(record?.environment?.tenantId) !== '1' ||
      !/^[A-Za-z0-9_-]+$/.test(record?.runId || '')) {
    throw new Error('BLOCKED: cost scenario fixtures require the authorized local tenant and a run id')
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)

  const scenarioUnderTest = scenario
  if (!['accounting', 'published', 'purchase', 'trialPending', 'carryover'].includes(scenarioUnderTest)) {
    throw new Error(`未知成本场景：${scenarioUnderTest}`)
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const months = await allocateMonths(
    api,
    scenarioUnderTest === 'carryover' ? 2 : 1,
    {
      // 采购场景复用既有 TRADE 模型，月份必须晚于该模型来源规则的生效日期。
      afterExisting: ['published', 'purchase'].includes(scenarioUnderTest) ||
        caseRecord.id === 'COST-023'
    }
  )
  const month = months[0]
  const remark = `CFOR-E2E:costScenario:${scenarioUnderTest}:${record.runId}:${suffix}:tenant=1:org=1:month=${month}`
  const departmentId = await createDepartment(api, suffix)
  const fixture = {
    scenario: scenarioUnderTest, month, suffix, departmentId, remark,
    runId: record.runId, tenantId: '1', caseId: caseRecord.id
  }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costScenario: fixture }

  if (scenarioUnderTest === 'accounting') {
    const versionNo = `E2E-SC-ACCOUNTING-${suffix}`
    fixture.versionNo = versionNo
    fixture.costCenterId = await createCenter({ api, suffix, month, departmentId, remark })
    const { modelId, componentItemId } = await buildManufacturingModel({
      api, suffix, month, remark, versionNo, sourceType: 'E2E_MANUAL',
      itemName: 'E2E核算中专属构成项'
    })
    fixture.modelId = modelId
    fixture.componentItemId = componentItemId
    await lockModel({ api, modelId })
    fixture.periodId = await createPeriod({
      api, month, enterpriseType: 'MANUFACTURING', versionNo
    })
  } else if (scenarioUnderTest === 'purchase') {
    const versionNo = `E2E-SC-PURCHASE-${suffix}`
    fixture.versionNo = versionNo
    fixture.costCenterId = await createCenter({
      api, suffix, month, departmentId, remark,
      code: `E2E-SC-P-${suffix}`
    })
    const trade = await withMixedEnterpriseType(api, async () => {
      const modelId = await createModel({
        api, suffix, month, remark, versionNo,
        enterpriseType: 'TRADE',
        dimensionMode: '商品'
      })
      fixture.modelId = modelId
      fixture.componentItemId = await putComponents({
        api, modelId, suffix, month, sourceType: 'PURCHASE_RECEIPT', remark,
        itemName: 'E2E场景采购成本'
      })
      responseData(
        await api.putBusiness('/cost/allocation-rules', {
          modelVersionId: String(modelId),
          costCenterId: String(fixture.costCenterId),
          effectiveMonth: month,
          status: 'CONFIRMED',
          lines: [{
            componentItemId: String(fixture.componentItemId),
            finishedRatio: 100,
            wipRatio: 0,
            allocationMode: 'AMOUNT',
            roundingPolicy: 'MAX_AMOUNT_OBJECT'
          }]
        }),
        '成本场景分摊规则'
      )
      await lockModel({ api, modelId })
      fixture.periodId = await createPeriod({
        api, month, enterpriseType: 'TRADE', versionNo
      })
      return modelId
    })
    fixture.enterpriseTypeSwitch = { original: trade.original, switched: trade.switched }

    const warehouses = responseData(
      await api.getBusiness('/mes/wmsWareHouse/allTree'),
      '仓库树'
    )
    const warehouse = (Array.isArray(warehouses) ? warehouses : warehouses?.list || [])
      .find((row) => row?.id)
    if (!warehouse) throw new Error('租户缺少可用于采购入库的仓库')
    const accountPage = responseData(
      await api.getBusiness('/erp/account/page?pageNo=1&pageSize=100'),
      '结算账户'
    )
    const account = (accountPage?.list || []).find((row) => row?.id)
    if (!account) throw new Error('租户缺少可用于采购入库的结算账户')
    const material = await createDedicatedMaterial({ api, suffix })
    await ensureQualityFixtures({ api, materialId: material.materialId })
    fixture.materialId = material.materialId
    fixture.unitId = material.unitId
    fixture.warehouseId = String(warehouse.id)
    fixture.accountId = String(account.id)
    const receipt = await createAuditedPurchaseReceipt({
      api, suffix, month, material,
      warehouseId: warehouse.id,
      accountId: account.id,
      fixture
    })
    fixture.purchaseOrderId = receipt.orderId
    fixture.noticeId = receipt.noticeId
    fixture.purchaseInId = receipt.purchaseInId
  } else {
    const versionNo = `E2E-SC-${scenarioUnderTest.toUpperCase()}-${suffix}`
    fixture.versionNo = versionNo
    fixture.costCenterId = await createCenter({ api, suffix, month, departmentId, remark })
    const { modelId, componentItemId } = await buildManufacturingModel({
      api, suffix, month, remark, versionNo,
      sourceType: 'LABOR',
      itemName: 'E2E场景人工成本'
    })
    fixture.modelId = modelId
    fixture.componentItemId = componentItemId
    // 期末在制必须大于零，上期结转才可能派生出 CARRYOVER 明细。
    responseData(
      await api.putBusiness('/cost/allocation-rules', {
        modelVersionId: String(modelId),
        costCenterId: String(fixture.costCenterId),
        effectiveMonth: month,
        status: 'CONFIRMED',
        lines: [{
          componentItemId: String(componentItemId),
          finishedRatio: 50,
          wipRatio: 50,
          allocationMode: 'AMOUNT',
          roundingPolicy: 'MAX_AMOUNT_OBJECT'
        }]
      }),
      '成本场景分摊规则'
    )
    await lockModel({ api, modelId })
    fixture.periodId = await createPeriod({
      api, month, enterpriseType: 'MANUFACTURING', versionNo
    })
    responseData(
      await api.putBusiness(`/cost/periods/${fixture.periodId}/source-snapshot`, {
        snapshotKey: 'DEFAULT',
        versionNo,
        lines: [{
          sourceModule: 'MANUAL',
          sourceType: 'LABOR',
          sourceId: `E2E-SC-${suffix}`,
          sourceLineId: `E2E-SC-${suffix}-1`,
          sourceNo: `E2E-SC-${suffix}`,
          componentCode: `E2E-SITEM-${suffix}`,
          componentName: 'E2E场景人工成本',
          allocationRatio: 100,
          costCenterCode: `E2E-SC-${suffix}`,
          productCode: `E2E-SC-PROD-${suffix}`,
          productName: 'E2E场景产品',
          orderNo: `E2E-SC-MO-${suffix}`,
          batchNo: `E2E-SC-B-${suffix}`,
          quantity: 1,
          laborAmount: 1234.56,
          priceStatus: 'FORMAL',
          sourceStatus: 'CONFIRMED'
        }]
      }),
      '成本场景来源快照'
    )
    responseData(
      await api.postBusiness(
        `/cost/periods/${fixture.periodId}/source-snapshot/confirm?snapshotKey=DEFAULT&versionNo=${encodeURIComponent(versionNo)}`
      ),
      '成本场景来源快照确认'
    )

    responseData(
      await api.postBusiness(`/cost/periods/${fixture.periodId}/trials`, {
        enterpriseType: 'MANUFACTURING',
        periodId: String(fixture.periodId),
        modelVersion: versionNo,
        requestId: `e2e-scenario-trial-${suffix}`
      }),
      '成本场景试算'
    )
    const afterTrial = await readPeriod(api, fixture.periodId)
    fixture.currentTrialId = afterTrial?.currentTrialId
    fixture.afterTrialStatus = afterTrial?.status

    if (scenarioUnderTest === 'published' || scenarioUnderTest === 'carryover') {
      const ownedWorkflow = caseRecord.id === 'COST-028'
      const reviewer = await createReviewer({
        api, record, suffix, fixture, key: 'reviewer',
        loginImmediately: !ownedWorkflow,
        permissions: costWorkflowReviewerPermissions(caseRecord.id, 'reviewer')
      })
      const reviewerApi = createApiClient({
        token: reviewer.token || await loginAs(record, reviewer.username, reviewer.password), record
      })
      try {
      const beforeConfirm = await readPeriod(api, fixture.periodId)
      responseData(
        await reviewerApi.request(
          'POST',
          `/cost/trials/${beforeConfirm.currentTrialId}/confirm`,
          undefined,
          {
            headers: {
              'If-Match': String(beforeConfirm.version),
              'X-Request-Id': `e2e-scenario-confirm-${suffix}`
            }
          }
        ),
        '成本场景试算确认'
      )
      const beforePublish = await readPeriod(api, fixture.periodId)
      const published = responseData(
        await reviewerApi.request(
          'POST',
          `/cost/periods/${fixture.periodId}/publications`,
          undefined,
          {
            headers: {
              'If-Match': String(beforePublish.version),
              'X-Request-Id': `e2e-scenario-publish-${suffix}`
            }
          }
        ),
        '成本场景正式发布'
      )
      fixture.publicationId = published?.publicationId
      const publishedPeriod = await readPeriod(api, fixture.periodId)
      if (publishedPeriod?.status !== 'COST_PUBLISHED') {
        throw new Error(`成本场景发布后期间状态异常：${publishedPeriod?.status}`)
      }
      fixture.publishedStatus = publishedPeriod.status
      } finally {
        if (ownedWorkflow) await reviewerApi.postBusiness('/system/auth/logout')
      }
      await createReviewer({
        api,
        record,
        suffix: `${suffix.slice(0, 8)}AP`,
        fixture,
        key: 'approvalReviewer',
        loginImmediately: !ownedWorkflow,
        permissions: costWorkflowReviewerPermissions(caseRecord.id, 'approvalReviewer')
      })
    }

    if (scenarioUnderTest === 'carryover') {
      const accountingMonth = months[1]
      if (shiftMonth(month, 1) !== accountingMonth) {
        throw new Error('上期结转场景需要连续的上一已发布期间与核算中期间')
      }
      fixture.previousMonth = month
      fixture.accountingMonth = accountingMonth
      fixture.publishedPeriodId = fixture.periodId
      fixture.accountingPeriodId = await createPeriod({
        api, month: accountingMonth, enterpriseType: 'MANUFACTURING', versionNo
      })
      fixture.period = null
      fixture.periodId = fixture.accountingPeriodId
    }
  }

  fixture.period = fixture.period || await readPeriod(api, fixture.periodId)
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costScenario: fixture }
  moduleScenarioCache.set(cacheKey(record, scenarioUnderTest, caseRecord.id), fixture)
  caseRecord.evidence.push(`成本场景夹具(${scenarioUnderTest})：${JSON.stringify({
    month: fixture.month,
    periodId: fixture.periodId,
    modelId: fixture.modelId,
    enterpriseTypeSwitch: fixture.enterpriseTypeSwitch || null,
    publicationId: fixture.publicationId || null,
    purchaseInId: fixture.purchaseInId || null
  })}`)
  caseRecord.checks.push({
    name: `通过正式 API 建立${scenarioUnderTest}成本场景（远期月份 ${fixture.month}）`,
    passed: true,
    details: `period=${fixture.periodId} status=${fixture.period?.status} month=${fixture.month}`
  })
  return fixture
}

export async function cleanupCostScenarioReviewer ({ api, fixture, key = 'reviewer' }) {
  const userId = fixture[`${key}UserId`]
  const username = fixture[`${key}Username`]
  const roleId = fixture[`${key}RoleId`]
  const roleCode = fixture[`${key}RoleCode`]
  if (userId) {
    const user = responseData(
      await api.getBusiness(`/system/user/get?id=${userId}`), '专属成本复核人回读'
    )
    // A prior verified deletion still requires a successful, explicit null read.
    if (!(user === null && fixture[`${key}Deleted`] === true)) {
      if (String(user?.id) !== userId || user.username !== username) {
        throw new Error('成本复核账号清理所有权不符')
      }
      await api.deleteBusiness(`/system/user/delete?id=${userId}`)
      const after = await api.get(`/system/user/get?id=${userId}`)
      if (!(after?.code === 0 && after.success !== false && after.data === null)) {
        throw new Error('成本复核账号删除后仍可读取')
      }
      fixture[`${key}Deleted`] = true
    }
  }
  if (roleId) {
    const role = responseData(
      await api.getBusiness(`/system/role/get?id=${roleId}`), '专属成本复核角色回读'
    )
    if (!(role === null && fixture[`${key}RoleDeleted`] === true)) {
      if (String(role?.id) !== roleId || role.code !== roleCode) {
        throw new Error('成本复核角色清理所有权不符')
      }
      await api.deleteBusiness(`/system/role/delete?id=${roleId}`)
      const after = await api.get(`/system/role/get?id=${roleId}`)
      if (!(after?.code === 0 && after.success !== false && after.data === null)) {
        throw new Error('成本复核角色删除后仍可读取')
      }
      fixture[`${key}RoleDeleted`] = true
    }
  }
}
