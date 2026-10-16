import assert from 'node:assert/strict'
import { ExecutionWorkflowFixture } from './mes-execution-write.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

export const PROCUREMENT_MRP_CASES = Object.freeze(['PROC-001', 'PROC-002'])

export const PROCUREMENT_MRP_CHECKS = Object.freeze({
  shortage: 'PROC-001 专属工单 MRP 返回真实缺料、净需求和采购建议',
  atp: 'PROC-001 WMS ATP 可用库存与专属投料预览一致',
  netDemand: 'PROC-001 净需求同时核对现存、锁定、在途和可用口径',
  startGate: 'PROC-001 缺料工单通过正式开工接口被阻断且状态不变',
  source: 'PROC-002 自动请购唯一引用本轮 MRP 运算及缺料物料',
  idempotency: 'PROC-002 重复生成采购计划被正式幂等拒绝且请购数量不增加',
  configGap: 'PROC-002 工单 MRP 未被旧 is_purchase_request 配置改成直接采购订单'
})

export const MRP_PLAN_PATH = '/mes/mrp/generatePurchasePlan'

export const MRP_PLAN_IDEMPOTENCY_REJECTION = Object.freeze({
  code: 500,
  message: /^生成采购计划失败：该运算已生成采购计划，生成时间: /,
  allowServiceCode: true
})

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data

const rowsOf = (payload, label) => {
  const data = dataOf(payload, label)
  const rows = Array.isArray(data)
    ? data
    : data?.records ?? data?.list
  if (!Array.isArray(rows)) throw new Error(`${label}缺少 records/list 数组`)
  return rows
}

const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))

const check = (caseRecord, name, passed, details = '') => {
  caseRecord.checks ||= []
  const result = { name, passed: Boolean(passed), details: String(details) }
  caseRecord.checks.push(result)
  return result
}

const gap = (caseRecord, name, details) => {
  const existing = caseRecord.checks?.find((item) => item.name === name)
  if (existing) {
    existing.passed = false
    existing.details = `GAP: ${details}`
  } else {
    check(caseRecord, name, false, `GAP: ${details}`)
  }
  caseRecord.notes ||= []
  const note = `GAP: ${details}`
  if (!caseRecord.notes.includes(note)) caseRecord.notes.push(note)
  return false
}

const blocked = (caseRecord, message) => {
  caseRecord.notes ||= []
  caseRecord.notes.push(`BLOCKED: ${message}`)
  throw new Error(`BLOCKED: ${message}`)
}

const unwrap = (payload, label) => dataOf(payload, label)

const exactMrpPlanPath = (calculationId) =>
  `${MRP_PLAN_PATH}?calculationId=${encodeURIComponent(calculationId)}`

export const buildMrpCalculationRequest = ({ fixture, marker }) => {
  assert(fixture?.works?.[0]?.id, 'PROC MRP 专属工单缺少 ID')
  assert(fixture?.material?.id, 'PROC MRP 专属成品缺少 ID')
  return {
    workIds: [String(fixture.works[0].id)],
    workNos: [String(fixture.works[0].workTicketNo || '')],
    materialIds: [String(fixture.material.id)],
    materialNames: [String(fixture.material.identity || '')],
    planStartDate: new Date().toISOString(),
    planEndDate: new Date(Date.now() + 86400000).toISOString(),
    leadTime: 1,
    safetyStock: 0,
    description: `${marker} MRP shortage to purchase request`,
    considerInTransitStock: true,
    considerSafetyStock: true,
    considerFinishedStock: true,
    considerOutput: true,
    calculationMode: 1,
    idempotencyKey: marker
  }
}

const materialEditPayload = (material, supplierId, fallback = {}) => {
  for (const field of [
    'id', 'code', 'name', 'unitId', 'purchased', 'produced', 'saled',
    'isMaterial', 'source', 'leadTime', 'bufferTime'
  ]) {
    if (material?.[field] == null || material[field] === '') {
      throw new Error(`PROC MRP 专属缺料子件回读缺少字段 ${field}，拒绝部分覆盖`)
    }
  }
  const parented = material?.parented ?? fallback.parented
  if (parented == null || parented === '') {
    throw new Error('PROC MRP 专属缺料子件缺少 parented 夹具值，拒绝部分覆盖')
  }
  const assembled = material?.assembled ?? fallback.assembled
  if (assembled == null || assembled === '') {
    throw new Error('PROC MRP 专属缺料子件缺少 assembled 夹具值，拒绝部分覆盖')
  }
  const payload = {
    id: String(material.id),
    code: material.code,
    name: material.name,
    auxName: material.auxName || material.name,
    model: material.model,
    type: material.type,
    unitId: material.unitId,
    inventoryNature: material.inventoryNature || 'STOCK',
    virtualGoods: material.virtualGoods,
    purchased: material.purchased,
    produced: material.produced,
    saled: material.saled,
    parented,
    isMaterial: material.isMaterial,
    assembled,
    soned: material.soned,
    batchManaged: material.batchManaged,
    oneBarcode: material.oneBarcode,
    periodManaged: material.periodManaged,
    periodDays: material.periodDays,
    colorManaged: material.colorManaged,
    brandManaged: material.brandManaged,
    backflush: material.backflush,
    participateKitting: material.participateKitting,
    source: material.source,
    leadTime: material.leadTime,
    bufferTime: material.bufferTime,
    defaultMerchant: String(supplierId)
  }
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value != null))
}

/**
 * Bind only the newly created MRP component to an existing enabled supplier.
 * Shared material records and shared procurement configuration are untouched.
 */
export async function bindDedicatedSupplier ({ api, fixture, caseRecord }) {
  const suppliers = rowsOf(
    await api.getBusiness('/erp/supplier/simple-list'),
    'PROC MRP 启用供应商'
  )
  const supplier = suppliers.find((row) => stableId(row?.id))
  if (!supplier) blocked(caseRecord, '当前租户没有可复用的启用供应商')

  const componentId = String(fixture.component?.id || '')
  if (!stableId(componentId)) blocked(caseRecord, '专属 MRP 缺料子件缺少稳定 ID')
  const current = unwrap(
    await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(componentId)}`),
    'PROC MRP 专属缺料子件回读'
  )
  if (String(current?.id) !== componentId || current?.remark !== fixture.marker) {
    blocked(caseRecord, '专属 MRP 缺料子件所有权回读不匹配，拒绝修改')
  }

  const parentedFallback = current?.parented == null ? 'N' : undefined
  const assembledFallback = current?.assembled == null ? 'N' : undefined
  if (parentedFallback || assembledFallback) {
    caseRecord.evidence ||= []
    if (parentedFallback) {
      caseRecord.evidence.push(
        `PROC MRP 专属缺料子件 API 回读缺少 parented，使用创建夹具已知值 ${parentedFallback} 继续回写`
      )
    }
    if (assembledFallback) {
      caseRecord.evidence.push(
        `PROC MRP 专属缺料子件 API 回读缺少 assembled，使用创建夹具已知值 ${assembledFallback} 继续回写`
      )
    }
  }
  await api.putBusiness(
    '/mes/basMaterial/edit',
    materialEditPayload(current, supplier.id, {
      parented: parentedFallback,
      assembled: assembledFallback
    })
  )
  const updated = unwrap(
    await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(componentId)}`),
    'PROC MRP 专属缺料子件供应商回读'
  )
  if (String(updated?.defaultMerchant) !== String(supplier.id)) {
    throw new Error('PROC MRP 专属缺料子件默认供应商回写后不一致')
  }
  fixture.mrpSupplier = { id: String(supplier.id), name: supplier.name || '' }
  caseRecord.fixtures ||= {}
  caseRecord.fixtures.procurementMrp ||= {}
  caseRecord.fixtures.procurementMrp.supplier = fixture.mrpSupplier
  return fixture.mrpSupplier
}

const findCalculation = (rows, calculationId) => rows.find((row) =>
  String(row?.id) === String(calculationId) || String(row?.calculationId) === String(calculationId)
)

const readRequests = async (api, calculationId, componentId) => {
  const rows = rowsOf(
    await api.getBusiness(
      `/erp/purchase/order/request/page?pageNo=1&pageSize=100&srcBillType=MRP&srcBillId=${encodeURIComponent(calculationId)}`
    ),
    'PROC MRP MRP来源请购列表'
  )
  const ownedRows = []
  for (const row of rows) {
    if (
      String(row?.srcBillType || '').toUpperCase() !== 'MRP' ||
      String(row?.srcBillId || '') !== String(calculationId) ||
      !stableId(row?.id)
    ) {
      continue
    }
    const detail = unwrap(
      await api.getBusiness(`/erp/purchase/order/request/get?id=${encodeURIComponent(row.id)}`),
      'PROC MRP 请购归属详情'
    )
    const items = detail?.itemsList ?? detail?.items ?? []
    if (Array.isArray(items) && items.some((item) =>
      String(item?.productId || '') === String(componentId)
    )) {
      ownedRows.push(row)
    }
  }
  return ownedRows
}

const readOrders = async (api, calculationId) => rowsOf(
  await api.getBusiness(
    `/erp/purchase-order/page?pageNo=1&pageSize=100&remark=${encodeURIComponent(`运算ID: ${calculationId}`)}`
  ),
  'PROC MRP MRP来源采购订单列表'
)

const assertShortageResult = (result, fixture) => {
  const demand = result?.demandPlan?.find((row) =>
    String(row?.materialId) === String(fixture.component.id)
  )
  const suggestion = result?.purchaseSuggestion?.find((row) =>
    String(row?.materialId) === String(fixture.component.id)
  )
  const passed = Number(result?.summary?.shortageCount) > 0 &&
    Number(result?.summary?.purchaseCount) > 0 &&
    Number(demand?.netDemand) > 0 &&
    String(demand?.status) === '缺料' &&
    Number(suggestion?.suggestQty) > 0
  return { passed, demand, suggestion }
}

const assertShortageStartGate = async ({ api, fixture, caseRecord }) => {
  const taskId = String(fixture.fixtureRecord?.shortage?.taskId || fixture.tasks?.[0]?.id || '')
  if (!stableId(taskId)) throw new Error('BLOCKED: PROC-001 缺料夹具缺少专属任务')
  const preview = dataOf(
    await api.getBusiness(`/mes/prodWorkTask/feed-pick-preview?taskId=${encodeURIComponent(taskId)}`),
    'PROC-001 缺料开工前 ATP 预览'
  )
  const material = (Array.isArray(preview?.materialList) ? preview.materialList : [])
    .find((item) => String(item?.materialId) === String(fixture.component.id))
  const atpPassed = String(preview?.taskId) === taskId &&
    material &&
    Number(material.requiredQty) > 0 &&
    Number(material.remainingPickQty) > 0 &&
    Number(material.stockQty) < Number(material.remainingPickQty)
  check(caseRecord, PROCUREMENT_MRP_CHECKS.atp, atpPassed, JSON.stringify({
    taskId,
    materialId: material?.materialId,
    requiredQty: material?.requiredQty,
    remainingPickQty: material?.remainingPickQty,
    stockQty: material?.stockQty
  }))

  const calculation = caseRecord.mrpCalculation
  const demand = calculation?.demandPlan?.find((row) =>
    String(row?.materialId) === String(fixture.component.id))
  const currentStock = Number(demand?.currentStock || 0)
  const lockStock = Number(demand?.lockStock || 0)
  const inTransitStock = Number(demand?.inTransitStock || 0)
  const availableStock = Number(demand?.availableStock)
  const netDemand = Number(demand?.netDemand)
  const netDemandPassed = Number.isFinite(availableStock) &&
    Math.abs(availableStock - (currentStock - lockStock + inTransitStock)) < 0.000001 &&
    Number(demand?.totalDemand) > 0 &&
    Math.abs(netDemand - Math.max(0, Number(demand.totalDemand) - availableStock)) < 0.000001
  check(caseRecord, PROCUREMENT_MRP_CHECKS.netDemand, netDemandPassed, JSON.stringify({
    materialId: demand?.materialId,
    currentStock,
    lockStock,
    inTransitStock,
    availableStock,
    totalDemand: demand?.totalDemand,
    netDemand,
    considerInTransitStock: true
  }))

  const workId = String(fixture.works?.[0]?.id || '')
  const before = dataOf(
    await api.getBusiness(`/mes/prodWork/queryById?id=${encodeURIComponent(workId)}`),
    'PROC-001 缺料开工前工单'
  )
  const rejected = await api.post('/mes/prodWork/start', {
    id: workId,
    prodWorkOrderId: workId
  }, {
    expectedBusinessRejection: {
      code: 400,
      message: /工单存在缺料.*不能开工/
    }
  })
  const after = dataOf(
    await api.getBusiness(`/mes/prodWork/queryById?id=${encodeURIComponent(workId)}`),
    'PROC-001 缺料开工后工单'
  )
  const startGatePassed = rejected?.data === null &&
    matchesExpectedBusinessRejection(rejected, {
      code: 400,
      message: /工单存在缺料.*不能开工/
    }) &&
    String(after?.id) === workId &&
    Number(after?.status) === Number(before?.status) &&
    Number(before?.status) === 1
  check(caseRecord, PROCUREMENT_MRP_CHECKS.startGate, startGatePassed, JSON.stringify({
    workId,
    beforeStatus: before?.status,
    afterStatus: after?.status,
    code: rejected?.code,
    message: rejected?.msg || rejected?.message
  }))
  if (!atpPassed || !netDemandPassed || !startGatePassed) {
    throw new Error('PROC-001 缺料 ATP、净需求或开工门禁断言未通过')
  }
  return { preview, demand, before, after, rejected }
}

export const assertMrpPlanIdempotencyRejection = (response) => {
  if (!matchesExpectedBusinessRejection(response, MRP_PLAN_IDEMPOTENCY_REJECTION)) {
    throw new Error(`PROC MRP 重复生成拒绝契约不符：${JSON.stringify({
      code: response?.code,
      message: response?.msg || response?.message,
      data: response?.data
    })}`)
  }
  return true
}

/**
 * Execute the real production-order MRP -> purchase-plan -> purchase-request
 * path. The worker MRP branch deliberately calls generatePurchasePlan; this
 * helper never substitutes /erp/purchase/order/request/create.
 */
export async function runProcurementMrpClosure ({
  api,
  record = {},
  caseRecord,
  executionFixture,
  fixtureFactory = (client, runRecord, caseId, options) => new ExecutionWorkflowFixture(
    client,
    runRecord,
    caseId,
    options
  ),
  cleanup = true,
  preserveSuccessfulFixture = false
} = {}) {
  if (!api?.getBusiness || !api?.postBusiness || !api?.request || !api?.putBusiness) {
    throw new Error('PROC MRP 需要正式 API client：getBusiness/postBusiness/putBusiness/request')
  }
  if (!caseRecord) throw new Error('PROC MRP 需要 caseRecord')

  const fixtureOptions = { schedule: true, withOpeningInventory: true }
  const fixture = executionFixture || fixtureFactory(api, record, 'PROC-001', fixtureOptions)
  let setupDone = false
  const generatedRequestIds = []
  const generatedOrderIds = []
  let state
  let outcome
  try {
    await fixture.setup(caseRecord)
    setupDone = true
    await fixture.voidOpeningInventoryForShortage(caseRecord)
    await bindDedicatedSupplier({ api, fixture, caseRecord })

    const requestBody = buildMrpCalculationRequest({ fixture, marker: fixture.marker })
    const calculation = unwrap(
      await api.postBusiness('/mes/mrp/calculate', requestBody),
      'PROC-001 专属工单 MRP 运算'
    )
    const calculationId = String(calculation?.calculationId || '')
    if (!calculationId) throw new Error('PROC-001 MRP 运算未返回稳定计算编号')

    const shortage = assertShortageResult(calculation, fixture)
    caseRecord.mrpCalculation = calculation
    check(caseRecord, PROCUREMENT_MRP_CHECKS.shortage, shortage.passed, JSON.stringify({
      calculationId,
      demand: shortage.demand,
      suggestion: shortage.suggestion,
      summary: calculation?.summary
    }))
    if (!shortage.passed) {
      gap(caseRecord, PROCUREMENT_MRP_CHECKS.shortage,
        '正式 MRP 未同时返回专属缺料子件、正净需求、缺料状态和正采购建议')
      outcome = { partial: true, state: { calculationId, fixture, calculation } }
      return outcome
    }

    await assertShortageStartGate({ api, fixture, caseRecord })

    const history = rowsOf(
      await api.getBusiness('/mes/mrp/history?pageNo=1&pageSize=100'),
      'PROC MRP 运算历史'
    )
    const historyRow = findCalculation(history, calculationId)
    if (!historyRow || Number(historyRow.status) !== 3) {
      throw new Error('PROC MRP 运算完成后历史回读缺少本轮已完成记录')
    }

    const generated = unwrap(
      await api.postBusiness(exactMrpPlanPath(calculationId)),
      'PROC-002 工单 MRP 生成采购计划'
    )
    const requests = await readRequests(api, calculationId, fixture.component.id)
    const orders = requests.length === 0 ? await readOrders(api, calculationId) : []
    const request = requests.length === 1 ? unwrap(
      await api.getBusiness(`/erp/purchase/order/request/get?id=${encodeURIComponent(requests[0].id)}`),
      'PROC-002 自动请购详情'
    ) : null
    const requestItem = request?.itemsList?.find((item) =>
      String(item?.productId) === String(fixture.component.id)
    )
    const sourcePassed = requests.length === 1 &&
      String(request?.srcBillType || '').toUpperCase() === 'MRP' &&
      String(request?.srcBillId) === calculationId &&
      requestItem && Number(requestItem.inCount) > 0
    check(caseRecord, PROCUREMENT_MRP_CHECKS.source, sourcePassed, JSON.stringify({
      calculationId,
      requestCount: requests.length,
      requestId: request?.id,
      srcBillType: request?.srcBillType,
      srcBillId: request?.srcBillId,
      item: requestItem,
      generated
    }))

    if (!sourcePassed) {
      const directOrder = orders.find((order) => order?.id)
      generatedRequestIds.push(...requests.map((row) => String(row?.id || '')).filter(stableId))
      generatedOrderIds.push(...orders.map((row) => String(row?.id || '')).filter(stableId))
      gap(caseRecord, PROCUREMENT_MRP_CHECKS.configGap,
        directOrder
          ? `工单 MRP 正式入口生成了采购订单而非请购单；疑似 legacy config is_purchase_request 分支。calculationId=${calculationId}; orderId=${directOrder.id}`
          : `正式入口返回成功但无法回读唯一 MRP 来源请购；未调用 direct create。calculationId=${calculationId}; requestCount=${requests.length}`)
      outcome = {
        partial: true,
        state: { calculationId, fixture, calculation, generated, requests, orders }
      }
      return outcome
    }
    generatedRequestIds.push(String(request.id))

    const duplicate = await api.request('POST', exactMrpPlanPath(calculationId), undefined, {
      expectedBusinessRejection: MRP_PLAN_IDEMPOTENCY_REJECTION
    })
    assertMrpPlanIdempotencyRejection(duplicate)
    const afterDuplicate = await readRequests(api, calculationId, fixture.component.id)
    const countStable = afterDuplicate.length === 1 &&
      String(afterDuplicate[0]?.id) === String(requests[0]?.id)
    check(caseRecord, PROCUREMENT_MRP_CHECKS.idempotency, countStable, JSON.stringify({
      calculationId,
      before: requests.length,
      after: afterDuplicate.length,
      duplicate: { code: duplicate?.code, message: duplicate?.msg || duplicate?.message }
    }))
    if (!countStable) {
      gap(caseRecord, PROCUREMENT_MRP_CHECKS.idempotency,
        '重复生成拒绝后 MRP 来源请购数量或主键发生变化')
    }

    state = {
      calculationId,
      fixture,
      calculation,
      generated,
      requests: afterDuplicate,
      request,
      duplicate
    }
    outcome = {
      partial: caseRecord.checks.some((item) => item.passed === false),
      state
    }
    return outcome
  } finally {
    const shouldCleanup = cleanup && !(preserveSuccessfulFixture && outcome?.partial === false)
    if (shouldCleanup && typeof api.deleteBusiness === 'function') {
      for (const requestId of [...new Set(generatedRequestIds)]) {
        await api.deleteBusiness(
          `/erp/purchase/order/request/delete?id=${encodeURIComponent(requestId)}`
        ).catch((error) => {
          caseRecord.notes ||= []
          caseRecord.notes.push(
            `GAP: PROC MRP 自动请购 ${requestId} 正式删除失败：${error.message}`
          )
          if (outcome) outcome.partial = true
        })
      }
      for (const orderId of [...new Set(generatedOrderIds)]) {
        await api.deleteBusiness(
          `/erp/purchase-order/delete?ids=${encodeURIComponent(orderId)}`
        ).catch((error) => {
          caseRecord.notes ||= []
          caseRecord.notes.push(
            `GAP: PROC MRP 误生成采购订单 ${orderId} 正式删除失败：${error.message}`
          )
          if (outcome) outcome.partial = true
        })
      }
    }
    if (shouldCleanup && setupDone && typeof fixture.cleanup === 'function') {
      await fixture.cleanup(caseRecord).catch((error) => {
        caseRecord.notes ||= []
        caseRecord.notes.push(`GAP: PROC MRP 专属执行夹具清理未完成：${error.message}`)
        if (outcome) outcome.partial = true
      })
    }
  }
}
