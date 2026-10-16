import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { createOpeningInventory, prepareWmsFixture } from '../lib/wms-fixtures.mjs'
import { createPublishedItem, createPlan, createQualityMaterialRule } from './mes-quality-write.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { ensureProcurement016PurchaseOrderSubmitted } from './procurement-016-opening-closure.mjs'
import {
  buildPurchaseOrderPayload,
  buildSaleOrderPayload,
  buildSaleReturnPayload
} from './wms-qc-closure.mjs'
import { ExecutionWorkflowFixture } from './mes-execution-write.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import {
  parseProcurementRequisitionConfig,
  PROCUREMENT_REQUISITION_CONFIG_PATH
} from './procurement-direct-create-gate.mjs'

const blocked = (message) => new Error(`BLOCKED: QUALITY-PENDING-001 ${message}`)
const dataOf = (body) => assertBusinessSuccess(body, 'quality pending source').data

export function pendingSourceId (value, label = 'ID') {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value
  throw blocked(`${label} 缺失或不是无精度损失的正式 ID`)
}

export function pendingRows (body, label = '列表') {
  const data = dataOf(body)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.records)) return data.records
  throw blocked(`${label} 响应不是正式列表，不能当作空列表`)
}

export function assertPendingPermissions (info, required) {
  const userId = pendingSourceId(info?.user?.id, '真实登录用户')
  if (!info?.user?.username || !Array.isArray(info.permissions) || !Array.isArray(info.roles)) {
    throw blocked('正式 permission-info 缺少身份、权限或角色')
  }
  // PermissionServiceImpl:77-90 filters enabled roles, then delegates to
  // RoleServiceImpl.hasAnySuperAdmin. Use only roles from authenticated API,
  // never an environment override. This does not prove least privilege.
  if (info.roles.includes('super_admin')) return { userId, mode: 'existing-super-admin' }
  const missing = required.filter((permission) =>
    !info.permissions.includes(permission) && !info.permissions.includes('*:*:*')
  )
  if (missing.length) throw blocked(`现有账号缺少权限：${missing.join(', ')}`)
  return { userId, mode: 'existing-permissions' }
}

export function classifyPendingProbe ({ status, body }) {
  if (status === 403 || body?.code === 403) return 'FORBIDDEN'
  if (status === 401 || body?.code === 401) return 'UNAUTHENTICATED'
  // The register DTO has no field constraints. Empty JSON reaches
  // validateRegister before all selects/inserts and rejects null qcType.
  if (status === 200 && body?.code === 2010920003 &&
      /不支持的检验类型/.test(body?.msg || '')) return 'PRE_WRITE_SERVICE_REJECTION'
  if (status === 400 || body?.code === 400) return 'DTO_REJECTION_NOT_PERMISSION_PROOF'
  return 'UNEXPECTED'
}

export async function verifyPendingAccess (api, caseRecord, required) {
  const info = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
  const access = assertPendingPermissions(info, required)
  pendingRows(await api.getBusiness('/mes/quality/pending-inspect/list?limit=1'), '待检 query')
  let body
  try {
    body = await api.post('/mes/quality/pending-inspect/register', {}, {
      expectedBusinessRejection: { code: 2010920003, message: /不支持的检验类型/ }
    })
  } catch (error) {
    throw blocked(`无副作用 register 探针被拒绝或传输失败：${error.message}`)
  }
  // createApiClient throws on non-2xx. The service rejection is not a
  // successful register, but proves method security allowed this identity.
  const classification = classifyPendingProbe({ status: 200, body })
  if (classification !== 'PRE_WRITE_SERVICE_REJECTION') {
    throw blocked(`register 探针未到达预写服务校验：${classification} code=${body?.code}`)
  }
  caseRecord.evidence.push(
    `正式身份 user=${access.userId}, roles=${info.roles.join(',')}, authorization=${access.mode}; ` +
    `query code=0; empty register code=${body.code} (写前拒绝，非登记成功)`
  )
  caseRecord.notes.push('既有 super_admin 仅证明本账号业务调用；低权限与跨租户隔离未验证。')
  return { info, ...access }
}

export function assertPublishedIqcPlan (plan, binding, materialId, planId, now = new Date()) {
  if (pendingSourceId(plan?.id, '方案') !== planId ||
      String(plan.type) !== '101' || Number(plan.publishStatus) !== 1 ||
      !Number.isSafeInteger(Number(plan.versionNo)) || Number(plan.versionNo) <= 0 ||
      !plan.planCode) throw blocked('101 方案必须已发布且具有正式编码和正整数版本')
  if (pendingSourceId(binding?.materialId, '规则物料') !== materialId ||
      pendingSourceId(binding?.planId, '规则方案') !== planId ||
      String(binding.type) !== '101' || ![true, 1, '1'].includes(binding.isDefault) ||
      binding.applyOrgId || binding.businessSubType) {
    throw blocked('物料必须有本轮专属的默认101方案绑定')
  }
  const day = now.toISOString().slice(0, 10)
  const date = (value) => {
    if (Array.isArray(value) && value.length === 3 &&
        value.slice(0, 3).every((part) => Number.isInteger(part))) {
      const normalized = value.slice(0, 3).map((part) => String(part).padStart(2, '0'))
      value = `${normalized[0]}-${normalized[1]}-${normalized[2]}`
    }
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value) ||
        Number.isNaN(Date.parse(value.replace(' ', 'T')))) {
      throw blocked('方案绑定有效日期不合法')
    }
    const calendar = value.slice(0, 10)
    if (new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar) {
      throw blocked('方案绑定有效日期不合法')
    }
    return calendar
  }
  if (!binding.effectiveFrom || date(binding.effectiveFrom) > day ||
      binding.effectiveTo && date(binding.effectiveTo) < day) {
    throw blocked('101 方案绑定尚未生效或已过期')
  }
  return { id: planId, code: plan.planCode, version: Number(plan.versionNo) }
}

export function assertOwnedIqcDraft ({ detail, entries, notice, order, context }) {
  const { sourceId, noticeId, noticeLineId, orderId, orderItemId, materialId,
    warehouseId, areaId, locationId, supplierId, marker, batchNo, unitId } = context
  const same = (value, expected) => pendingSourceId(value) === expected
  if (!same(detail?.id, sourceId) || String(detail.stockIoType) !== '101' ||
      detail.srcBillType !== 'MesWmsArrivalNotice' || !same(detail.srcBillId, noticeId) ||
      !String(detail.srcNo || '').includes(marker) ||
      String(detail.billStage) !== '12' || Number(detail.isEffective) !== 0 ||
      Number(detail.isVoided) !== 0 || Number(detail.isQc) !== 0 ||
      !same(detail.supplierId, supplierId)) throw blocked('来源不是本轮101 ASN待检草稿，拒绝使用共享/106/已生效单据')
  if (!same(notice?.id, noticeId) || !same(notice.purchaseOrderId, orderId) ||
      !same(notice.vendorId, supplierId) || !String(notice.code).includes(marker) ||
      Number(notice.status) !== 10 || notice.lines?.length !== 1 ||
      !same(notice.lines[0].id, noticeLineId) ||
      !same(notice.lines[0].purchaseOrderItemId, orderItemId) ||
      !same(notice.lines[0].itemId, materialId) || notice.lines[0].iqcCheckFlag !== true ||
      Number(notice.lines[0].arrivalQuantity) !== 1 ||
      Number(notice.lines[0].receivedQuantity) !== 0 ||
      !same(order?.id, orderId) || Number(order.isEffective) !== 1 ||
      Number(order.isVoided) !== 0 || order.remark !== marker ||
      !same(order.supplierId, supplierId) || order.items?.length !== 1 ||
      !same(order.items[0].id, orderItemId) || !same(order.items[0].productId, materialId)) {
    throw blocked('101来源的真实采购/ASN链和专属所有权不一致')
  }
  if (entries.length !== 1) throw blocked('本轮101来源明细必须唯一')
  const entry = entries[0]
  if (!same(entry.mid, sourceId) || !same(entry.srcBillId, noticeId) ||
      entry.srcBillType !== 'MesWmsArrivalNotice' || !same(entry.srcEntryId, noticeLineId) ||
      !same(entry.materialId, materialId) || !same(entry.warehouseId, warehouseId) ||
      !same(entry.wareAreaId, areaId) || !same(entry.wareLocationId, locationId) ||
      !same(entry.unitId, unitId) || entry.batchNo !== batchNo ||
      Number(entry.qty) !== 1 || Number(entry.isQc) !== 1) {
    throw blocked('101来源明细的专属物料/仓库/批次/需检链不一致')
  }
  return { detail, entry, materialId, pendingQty: 1 }
}

export const IQC_SOURCE_PERMISSIONS = [
  'wms:arrival-notice:query', 'wms:arrival-notice:create',
  'wms:arrival-notice:submit', 'wms:arrival-notice:receipt', 'base:partner:create',
  'base:partner:query', 'system:config:query'
]

const purchaseProcessKey = 'erp-purchase-order-approval'

export function qualityPendingPurchaseApprovalStages (decision, settings = config) {
  if (String(decision?.tenantId) !== '1' ||
      !['NONE', 'MANUAL', 'WORKFLOW'].includes(decision?.mode)) {
    throw blocked('采购审批预览缺失或口径不明确')
  }
  if (decision.mode !== 'WORKFLOW') return []
  if (decision.processDefinitionKey !== purchaseProcessKey) {
    throw blocked('采购审批流程不是已核实的标准采购订单三段流程')
  }
  const stages = [
    ['FirstApprove_purchase-order', 'purchaseApprover'],
    ['SecondApprove_purchase-order', 'financeApprover'],
    ['FinalApprove_purchase-order', 'finalApprover']
  ].map(([taskDefinitionKey, prefix]) => ({
    taskDefinitionKey, username: settings[`${prefix}Username`], password: settings[`${prefix}Password`]
  }))
  if (stages.some(stage => !stage.username?.trim() || !stage.password?.trim())) {
    throw blocked('采购订单 BPM 三段审批账号或密码未配置')
  }
  return stages
}

export async function approveQualityPendingPurchaseOrder ({
  api, order, decision, settings = config, caseRecord, record, dependencies = {}
}) {
  const stages = qualityPendingPurchaseApprovalStages(decision, settings)
  const orderId = pendingSourceId(order?.id, '采购订单')
  if (!/^E2E-QP-[A-Z0-9-]+$/.test(order?.remark || '') ||
      ![0, '0'].includes(order.isVoided)) {
    throw blocked('采购审批前专属订单所有权或状态不一致')
  }
  // Reuse the verified formal submit entry (status=10), never status=20.
  const submitted = await (dependencies.ensureSubmitted || ensureProcurement016PurchaseOrderSubmitted)(
    api, orderId, 'QUALITY-PENDING-001 采购订单'
  )
  if (Number(submitted.order?.isEffective) !== 1) {
    if (decision.mode !== 'WORKFLOW') {
      throw blocked('非流程采购正式提交后未生效，拒绝绕过策略补状态')
    }
    await (dependencies.approveWmsProcess || approveWmsProcess)({
      api, processId: submitted.order.processInstanceId, caseRecord, record,
      label: 'QUALITY-PENDING-001 采购订单',
      taskDefinitionKey: stages[0].taskDefinitionKey,
      stageApprovers: stages,
      reason: 'QUALITY-PENDING-001 专属采购订单正式审批通过'
    })
  }
  const approved = dataOf(await api.getBusiness(`/erp/purchase-order/get?id=${orderId}`))
  if (pendingSourceId(approved?.id, '审批后采购订单') !== orderId ||
      approved.remark !== order.remark ||
      pendingSourceId(approved.supplierId, '审批后供应商') !== pendingSourceId(order.supplierId) ||
      Number(approved.status) !== 20 || Number(approved.isEffective) !== 1 ||
      Number(approved.isVoided) !== 0) {
    throw blocked(`采购订单正式审批后未生效或所有权不一致：${orderId}`)
  }
  caseRecord.evidence.push(
    `采购正式审批：order=${orderId}; action=${submitted.action}; mode=${decision.mode}; ` +
    `process=${approved.processInstanceId || '(manual)'}; status=20; effective=1`
  )
  return approved
}

export async function prepareQualityPendingIqcSource ({
  api, caseRecord, ledger, access, env = process.env, settings = config,
  dependencies = {}, record
}) {
  if (env.CFOR_QUALITY_PENDING_PREPARE_IQC !== 'true' ||
      env.CFOR_E2E_WRITE_FIXTURES !== 'true' ||
      env.CFOR_E2E_ENABLE_QUALITY_PENDING_CLOSURE !== 'true' ||
      env.CFOR_QUALITY_PENDING_CONFIRM !== 'QUALITY-PENDING-001') {
    throw blocked('准备专属101来源需要显式写侧确认及 PREPARE_IQC=true')
  }
  assertPendingPermissions(access?.info, IQC_SOURCE_PERMISSIONS)
  const requisition = parseProcurementRequisitionConfig(
    dataOf(await api.getBusiness(PROCUREMENT_REQUISITION_CONFIG_PATH))
  )
  if (!requisition.valid) throw blocked(requisition.reason)
  if (requisition.enabled) assertPendingPermissions(access.info, ['erp:purchase-order:direct-create'])
  const decision = dataOf(await api.postBusiness('/bpm/approval-policy/preview', {
    billType: 'PurOrder', sourceType: 'MANUAL',
    businessData: { isAuto: 0, type: 0, totalCount: 1, totalPrice: 10, directCreate: 1 }
  }))
  qualityPendingPurchaseApprovalStages(decision, settings)
  const helpers = { prepareWmsFixture, createPublishedItem, createPlan, createQualityMaterialRule,
    approveOrder: approveQualityPendingPurchaseOrder,
    ...dependencies }
  const marker = `E2E-QP-${randomUUID().slice(0, 8).toUpperCase()}`
  ledger.sourceCreatedByCase = true
  ledger.marker = marker
  ledger.prepared = {}
  const remember = (kind, value) => {
    ledger.prepared[kind] = value
    caseRecord.notes.push(`QUALITY-PENDING owned ${kind}: ${JSON.stringify(value)}`)
    return value
  }
  const fixture = await helpers.prepareWmsFixture(api, caseRecord)
  const materialId = pendingSourceId(fixture.material.id)
  const unitId = pendingSourceId(fixture.unit.id)
  const warehouseId = pendingSourceId(fixture.warehouse.id)
  const areaId = pendingSourceId(fixture.area.id)
  const locationId = pendingSourceId(fixture.location.id)
  remember('masters', { materialId, warehouseId, areaId, locationId, fixtureToken: fixture.token })
  const item = await helpers.createPublishedItem(api, caseRecord, { kind: 'PENDING-ITEM', unitId })
  remember('item', { id: pendingSourceId(item.itemId), token: item.token })
  const createdPlan = await helpers.createPlan(api, caseRecord, {
    kind: 'PENDING-PLAN', type: 101, itemId: item.itemId, itemSnapshot: item.row, publish: true,
    // mes_quality_plan_sub.remark is varchar(32); the parent keeps the full token.
    subOverrides: { remark: marker }
  })
  const planId = pendingSourceId(createdPlan.planId)
  remember('plan', { id: planId, token: createdPlan.token })
  const binding = await helpers.createQualityMaterialRule(api, caseRecord, {
    materialId, planId, type: '101', isDefault: true
  })
  remember('binding', { id: pendingSourceId(binding.ruleId) })
  const plan = assertPublishedIqcPlan(createdPlan.row, binding.row, materialId, planId)
  const supplierId = pendingSourceId(dataOf(await api.postBusiness('/base/partner/create', {
    name: `${marker}-SUPPLIER`, shortName: marker, partnerKind: 'ORGANIZATION',
    status: 'ACTIVE', supplierEnabled: true, customerEnabled: false, carrierEnabled: false, remark: marker
  })), '供应商')
  remember('supplier', { id: supplierId })
  const supplier = dataOf(await api.getBusiness(`/base/partner/get?id=${supplierId}`))
  if (pendingSourceId(supplier?.id) !== supplierId || supplier.remark !== marker ||
      supplier.supplierEnabled !== true) throw blocked('供应商专属所有权回读失败')
  const orderId = pendingSourceId(dataOf(await api.postBusiness('/erp/purchase-order/create',
    buildPurchaseOrderPayload({ marker, supplierId, materialId, unitId }))), '采购订单')
  remember('order', { id: orderId, decision })
  const readOrder = async () => dataOf(await api.getBusiness(`/erp/purchase-order/get?id=${orderId}`))
  let order = await readOrder()
  if (pendingSourceId(order?.id) !== orderId || order.remark !== marker ||
      order.items?.length !== 1 || pendingSourceId(order.items[0].productId) !== materialId) {
    throw blocked('专属采购订单创建后回读失败')
  }
  if (Number(order.isEffective) !== 1) {
    if (decision.mode === 'NONE') {
      throw blocked('采购预览免审但实际未生效，保留专属订单并要求核实审批口径')
    }
    await helpers.approveOrder({ api, order, decision, settings, caseRecord, record })
    order = await readOrder()
  }
  if (Number(order.isEffective) !== 1 || Number(order.isVoided) !== 0) {
    throw blocked('采购订单未由既有正式策略生效，不允许生成ASN')
  }
  const orderItemId = pendingSourceId(order.items[0].id)
  const batchNo = `${marker}-BATCH`
  const now = new Date().toISOString().slice(0, 19)
  const noticeId = pendingSourceId(dataOf(await api.postBusiness('/mes/wms/arrival-notice/create', {
    code: `AUTOTEST-${marker}-ASN`, name: `AUTOTEST-${marker}-ASN`,
    purchaseOrderId: orderId, purchaseOrderCode: order.billNo, vendorId: supplierId,
    supplierShipmentKey: `${marker}-SHIPMENT`, arrivalDate: now, shippedAt: now, remark: marker,
    lines: [{ itemId: materialId, purchaseOrderItemId: orderItemId, unitId,
      arrivalQuantity: 1, iqcCheckFlag: true, batchNo }]
  })), 'ASN')
  remember('notice', { id: noticeId })
  await api.postBusiness(`/mes/wms/arrival-notice/submit?id=${noticeId}`)
  const notice = dataOf(await api.getBusiness(`/mes/wms/arrival-notice/get?id=${noticeId}`))
  if (Number(notice?.status) !== 10 || notice.lines?.length !== 1 ||
      notice.lines[0].iqcCheckFlag !== true || pendingSourceId(notice.purchaseOrderId) !== orderId) {
    throw blocked('ASN正式提交未产生本轮待检状态')
  }
  const noticeLineId = pendingSourceId(notice.lines[0].id)
  ledger.sourceId = pendingSourceId(dataOf(await api.postBusiness(
    `/mes/wms/arrival-notice/create-receipt-bill?id=${noticeId}`,
    [{ lineId: noticeLineId, warehouseId, areaId, locationId, receivedQuantity: 1,
      qualifiedQuantity: null, batchNo, idempotentKey: `${marker}-RECEIPT` }]
  )), '101 WMS草稿')
  const detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById/dictText?id=${ledger.sourceId}`))
  const entries = pendingRows(await api.getBusiness(
    `/mes/stkIo/queryEntryByMainId/dictText?id=${ledger.sourceId}`
  ), '101明细')
  const context = { sourceId: ledger.sourceId, noticeId, noticeLineId, orderId, orderItemId,
    materialId, warehouseId, areaId, locationId, supplierId, marker, batchNo, unitId }
  const source = assertOwnedIqcDraft({ detail, entries, notice, order, context })
  ledger.sourceEntryId = pendingSourceId(source.entry.id)
  remember('source', { ...context, sourceEntryId: ledger.sourceEntryId })
  caseRecord.evidence.push(
    `正式采购=${orderId}/${orderItemId} -> ASN=${noticeId}/${noticeLineId} -> ` +
    `101待检草稿=${ledger.sourceId}/${ledger.sourceEntryId}; stage=12, effective=0, qty=1, IQC=1`
  )
  return { source, plan, context, marker }
}

export async function loadQualityPendingIqcSource (api, ledger, env = process.env) {
  const sourceId = pendingSourceId(env.CFOR_QUALITY_PENDING_SOURCE_ID, '预置来源')
  const sourceEntryId = pendingSourceId(env.CFOR_QUALITY_PENDING_SOURCE_ENTRY_ID, '预置来源明细')
  const planId = pendingSourceId(env.CFOR_QUALITY_PENDING_PLAN_ID, '预置方案')
  const marker = env.CFOR_QUALITY_PENDING_OWNERSHIP_MARKER
  if (!/^E2E-QP-[A-Z0-9-]+$/.test(marker || '')) throw blocked('预置来源缺少专属本轮标记')
  ledger.sourceId = sourceId
  ledger.sourceEntryId = sourceEntryId
  ledger.marker = marker
  const detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById/dictText?id=${sourceId}`))
  const entries = pendingRows(await api.getBusiness(
    `/mes/stkIo/queryEntryByMainId/dictText?id=${sourceId}`
  ), '预置来源明细')
  if (String(detail?.stockIoType) !== '101' || detail.srcBillType !== 'MesWmsArrivalNotice' ||
      entries.length !== 1 || pendingSourceId(entries[0]?.id) !== sourceEntryId) {
    throw blocked('仅允许有专属ASN采购链的101来源；106或其它场景保持GAP')
  }
  const entry = entries[0]
  const noticeId = pendingSourceId(detail.srcBillId)
  const notice = dataOf(await api.getBusiness(`/mes/wms/arrival-notice/get?id=${noticeId}`))
  const orderId = pendingSourceId(notice?.purchaseOrderId)
  const order = dataOf(await api.getBusiness(`/erp/purchase-order/get?id=${orderId}`))
  const context = {
    sourceId, noticeId, noticeLineId: pendingSourceId(entry.srcEntryId), orderId,
    orderItemId: pendingSourceId(notice?.lines?.[0]?.purchaseOrderItemId),
    materialId: pendingSourceId(entry.materialId), unitId: pendingSourceId(entry.unitId),
    warehouseId: pendingSourceId(entry.warehouseId), areaId: pendingSourceId(entry.wareAreaId),
    locationId: pendingSourceId(entry.wareLocationId), supplierId: pendingSourceId(detail.supplierId),
    batchNo: `${marker}-BATCH`, marker
  }
  const source = assertOwnedIqcDraft({ detail, entries, notice, order, context })
  const bindings = pendingRows(await api.getBusiness(
    `/mes/quality/qualityMaterial/list/dictText?pageNo=1&pageSize=100&types=101&materialId=${context.materialId}`
  ), '预置101方案绑定').filter(row => String(row.type) === '101')
  if (bindings.length !== 1) throw blocked('专属物料101方案绑定必须唯一')
  const planRow = dataOf(await api.getBusiness(
    `/mes/quality/qualityPlan/queryById/dictText?id=${planId}`
  ))
  const plan = assertPublishedIqcPlan(planRow, bindings[0], context.materialId, planId)
  return { source, plan, context, marker }
}

export const QUALITY_PENDING_SOURCE_GAPS = Object.freeze({
  SALES_RETURN: 'RQC 仍缺正式来源契约（源码证据，非本轮API实测）：ERP销售出库使用 ErpSaleOut/201，而销售退货批次接口按订单ID只筛 SalOrder/201，已退量仍按旧201负数统计；退货路径以 needQc=false 创建并执行 SalReturn/302，明细 isQc=0，保存钩子仅回写退货量，未提供正式RQC待检入口。不得以空批次、手工302或待检直登替代真实销售退货。',
  QUALITY_PLAN: '源码仅有QUALITY_PLAN场景枚举，未发现质量计划执行任务及来源明细契约；已发布质检方案不是执行来源。'
})

function requireAdditionalSourceOptIn (access, env) {
  if (env.CFOR_E2E_WRITE_FIXTURES !== 'true' ||
      env.CFOR_E2E_ENABLE_QUALITY_PENDING_CLOSURE !== 'true' ||
      env.CFOR_QUALITY_PENDING_CONFIRM !== 'QUALITY-PENDING-001' ||
      env.CFOR_QUALITY_PENDING_PREPARE_IQC !== 'true') {
    throw blocked('扩展专属来源需要本轮完整写侧确认')
  }
  assertPendingPermissions(access?.info, ['mes:quality-pending:register', 'mes:quality-pending:query'])
}

export function assertOwnedPendingWmsDraft ({ detail, entries, context }) {
  const same = (value, expected) => pendingSourceId(value) === expected
  if (!same(detail?.id, context.sourceId) ||
      String(detail.stockIoType) !== context.type ||
      detail.srcBillType !== context.sourceType || !same(detail.srcBillId, context.upstreamId) ||
      detail.remark !== context.marker || String(detail.billStage) !== '12' ||
      Number(detail.isEffective) !== 0 || Number(detail.isVoided) !== 0 ||
      !detail.billNo || entries.length !== 1) {
    throw blocked('扩展来源不是本轮真实上游对应的唯一未生效WMS草稿')
  }
  const entry = entries[0]
  if (!same(entry.mid, context.sourceId) ||
      entry.srcBillType !== context.sourceType ||
      !same(entry.srcBillId, context.upstreamId) ||
      !same(entry.srcEntryId, context.upstreamEntryId) ||
      !same(entry.materialId, context.materialId) || !same(entry.unitId, context.unitId) ||
      !same(entry.warehouseId, context.warehouseId) ||
      !same(entry.wareAreaId, context.areaId) || !same(entry.wareLocationId, context.locationId) ||
      entry.batchNo !== context.batchNo || Number(entry.qty) !== 1 || Number(entry.isQc) !== 1) {
    throw blocked('扩展来源明细的上游行、物料、需检、批次或库存维度不匹配')
  }
  return { detail, entry, materialId: context.materialId, pendingQty: 1 }
}

function salesReturnQuantity (value, label) {
  if (!['number', 'string'].includes(typeof value) ||
      typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value) ||
      !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw blocked(`${label} 必须是非负有限数量，禁止缺值或隐式转换`)
  }
  return Number(value)
}

export function assertOwnedDeliveredSalesSource ({
  order, saleOut, detail, entries, inventoryBefore, inventoryAfter, context
}) {
  if (!context || !/^E2E-QP-[A-Z0-9-]+$/.test(context.marker || '') ||
      typeof context.batchNo !== 'string' || !context.batchNo.trim() ||
      context.batchNo.length > 32) {
    throw blocked('已交付销售来源缺少专属标记或正式批次')
  }
  const ids = Object.fromEntries([
    'saleOrderId', 'orderItemId', 'saleOutId', 'saleOutItemId',
    'saleOutWmsId', 'saleOutWmsEntryId', 'customerId', 'materialId', 'unitId',
    'warehouseId', 'areaId', 'locationId'
  ].map(key => [key, pendingSourceId(context[key], key)]))
  const same = (value, key) => pendingSourceId(value, key) === ids[key]
  const one = (value) => salesReturnQuantity(value, '本轮销售交付数量') === 1
  const priced = (item) => salesReturnQuantity(item?.productPrice, '销售单价') === 10 &&
    salesReturnQuantity(item?.taxPercent, '销售税率') === 0
  if (!same(order?.id, 'saleOrderId') || order.remark !== context.marker ||
      !same(order.customerId, 'customerId') ||
      ![1, '1'].includes(order.isEffective) || ![0, '0'].includes(order.isVoided) ||
      order.saleTypeCode !== 'NORMAL' || order.items?.length !== 1 ||
      !same(order.items[0].id, 'orderItemId') ||
      !same(order.items[0].productId, 'materialId') ||
      !same(order.items[0].productUnitId, 'unitId') ||
      !one(order.items[0].count) || !priced(order.items[0]) ||
      !same(saleOut?.id, 'saleOutId') || saleOut.remark !== context.marker ||
      !same(saleOut.orderId, 'saleOrderId') || !same(saleOut.customerId, 'customerId') ||
      saleOut.businessType !== 'NORMAL' || ![20, '20'].includes(saleOut.status) ||
      typeof saleOut.no !== 'string' || !saleOut.no.trim() ||
      !one(saleOut.totalCount) || salesReturnQuantity(saleOut.totalPrice, '销售出库金额') !== 10 ||
      salesReturnQuantity(saleOut.discountPercent, '销售出库折扣') !== 0 ||
      salesReturnQuantity(saleOut.otherPrice, '销售出库其他金额') !== 0 ||
      saleOut.items?.length !== 1 || !same(saleOut.items[0].id, 'saleOutItemId') ||
      !same(saleOut.items[0].orderItemId, 'orderItemId') ||
      !same(saleOut.items[0].productId, 'materialId') ||
      !same(saleOut.items[0].productUnitId, 'unitId') ||
      !same(saleOut.items[0].warehouseId, 'warehouseId') ||
      !one(saleOut.items[0].count) || !priced(saleOut.items[0])) {
    throw blocked('已交付来源的专属订单 -> NORMAL已审核销售出库 -> 明细/单件金额不一致')
  }
  const dimensions = (row) => same(row?.materialId, 'materialId') &&
    same(row.warehouseId, 'warehouseId') && same(row.wareAreaId, 'areaId') &&
    same(row.wareLocationId, 'locationId') && row.batchNo === context.batchNo
  if (!same(detail?.id, 'saleOutWmsId') || String(detail.stockIoType) !== '201' ||
      detail.srcBillType !== 'ErpSaleOut' || !same(detail.srcBillId, 'saleOutId') ||
      detail.srcNo !== saleOut.no || !same(detail.customerId, 'customerId') ||
      typeof detail.billNo !== 'string' || !detail.billNo.trim() ||
      !['32', '34'].includes(String(detail.billStage)) ||
      ![1, '1'].includes(detail.isEffective) || ![0, '0'].includes(detail.isVoided) ||
      !Array.isArray(entries) || entries.length !== 1) {
    throw blocked('仅审核订单或WMS201草稿不等于交付，必须回读ErpSaleOut正式已执行来源')
  }
  const entry = entries[0]
  if (!same(entry?.id, 'saleOutWmsEntryId') || !same(entry.mid, 'saleOutWmsId') ||
      entry.srcBillType !== 'ErpSaleOut' || !same(entry.srcBillId, 'saleOutId') ||
      !same(entry.srcEntryId, 'saleOutItemId') || !same(entry.unitId, 'unitId') ||
      !dimensions(entry) || String(entry.stockIoDirection) !== '2' || !one(entry.qty) ||
      typeof entry.inStockTime !== 'string' || !entry.inStockTime.trim() ||
      Number.isNaN(Date.parse(entry.inStockTime.replace(' ', 'T')))) {
    throw blocked('已交付WMS行必须关联销售出库行、真实批次维度和库存执行时间')
  }
  const keys = ['qty', 'availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty']
  const stockValues = (rows) => {
    if (!Array.isArray(rows) || rows.length > 1) throw blocked('单件交付库存快照缺失或不是唯一专属批次')
    if (!rows.length) return keys.map(() => 0)
    if (!dimensions(rows[0])) throw blocked('交付库存快照包含外来物料、仓库或批次维度')
    pendingSourceId(rows[0].id, '交付库存行')
    const values = keys.map(key => salesReturnQuantity(rows[0][key], `交付库存${key}`))
    if (Math.abs(values[0] - values.slice(1).reduce((sum, value) => sum + value, 0)) > 0.000001) {
      throw blocked('交付库存总量与各分量不守恒')
    }
    return values
  }
  const before = stockValues(inventoryBefore)
  const after = stockValues(inventoryAfter)
  if (before[0] !== 1 || before[1] !== 1 || before.slice(2).some(value => value !== 0) ||
      after.some(value => value !== 0) ||
      inventoryAfter.length === 1 &&
        pendingSourceId(inventoryAfter[0].id) !== pendingSourceId(inventoryBefore[0].id)) {
    throw blocked('已交付来源缺少专属库存qty/available 1->0及其他分量归零证据')
  }
  return { order, saleOut, detail, entry, inventoryBefore, inventoryAfter, deliveredQty: 1 }
}

export function assertOwnedSalesReturnBatchOption ({ options, context }) {
  if (!Array.isArray(options)) {
    throw blocked('销售退货批次接口响应不是正式数组，不能按空集继续')
  }
  const expected = {
    orderItemId: pendingSourceId(context.orderItemId, '销售订单行'),
    materialId: pendingSourceId(context.materialId, '销售退货物料'),
    unitId: pendingSourceId(context.unitId, '销售退货单位'),
    saleOutWmsId: pendingSourceId(context.saleOutWmsId, '销售出库WMS单'),
    saleOutWmsEntryId: pendingSourceId(context.saleOutWmsEntryId, '销售出库WMS明细'),
    warehouseId: pendingSourceId(context.warehouseId, '销售退货仓库'),
    areaId: pendingSourceId(context.areaId, '销售退货库区'),
    locationId: pendingSourceId(context.locationId, '销售退货库位'),
    billNo: context.saleOutWmsBillNo,
    batchNo: context.batchNo,
    quantity: salesReturnQuantity(context.quantity === undefined ? 1 : context.quantity, '退货数量')
  }
  if (typeof expected.batchNo !== 'string' || !expected.batchNo.trim() ||
      expected.batchNo.length > 32 || typeof expected.billNo !== 'string' ||
      !expected.billNo.trim() || expected.quantity !== 1) {
    throw blocked('销售退货批次候选必须保留真实批次/WMS单号，且仅允许本用例单件退货')
  }
  const matches = options.filter((row) => {
    const orderItemId = pendingSourceId(row?.saleOrderItemId ?? row?.orderItemId, '销售退货批次订单行')
    if (row?.saleOrderItemId != null && row?.orderItemId != null &&
        pendingSourceId(row.orderItemId) !== orderItemId) {
      throw blocked('销售退货批次订单行别名冲突')
    }
    return orderItemId === expected.orderItemId &&
      pendingSourceId(row?.materialId, '销售退货批次物料') === expected.materialId &&
      pendingSourceId(row?.unitId, '销售退货批次单位') === expected.unitId &&
      pendingSourceId(row?.srcStkIoId, '销售退货批次WMS单') === expected.saleOutWmsId &&
      pendingSourceId(row?.srcStkIoEntryId, '销售退货批次WMS明细') === expected.saleOutWmsEntryId &&
      pendingSourceId(row?.warehouseId, '销售退货批次仓库') === expected.warehouseId &&
      pendingSourceId(row?.wareAreaId, '销售退货批次库区') === expected.areaId &&
      pendingSourceId(row?.wareLocationId, '销售退货批次库位') === expected.locationId &&
      row.batchNo === expected.batchNo && row.billNo === expected.billNo
  })
  if (matches.length !== 1) {
    throw blocked(
      `销售退货没有唯一可退专属批次：expected=${JSON.stringify(expected)}; matches=${matches.length}`
    )
  }
  const availableQty = salesReturnQuantity(matches[0].availableQty, '正式批次可退量')
  if (availableQty !== 1) throw blocked('正式批次可退量必须等于本轮唯一已交付单件，不能超退或部分替代')
  return matches[0]
}

export function buildQualityPendingSalesReturnPayload ({
  marker, customerId, saleOrderId, orderItemId, materialId, unitId,
  warehouseId, areaId, locationId, accountId, batchOptions, saleOutWmsId,
  saleOutWmsEntryId, saleOutId, saleOutItemId, batchNo, quantity = 1, delivery
}) {
  // Pure payload preparation is not a return write or an RQC source contract.
  if (salesReturnQuantity(quantity, '退货数量') !== 1) throw blocked('本用例仅允许单件退货，不扩展金额口径')
  const delivered = assertOwnedDeliveredSalesSource({
    ...delivery,
    context: { marker, customerId, saleOrderId, orderItemId, saleOutId, saleOutItemId,
      saleOutWmsId, saleOutWmsEntryId, materialId, unitId, warehouseId, areaId, locationId, batchNo }
  })
  const batch = assertOwnedSalesReturnBatchOption({
    options: batchOptions,
    context: {
      orderItemId, materialId, unitId, saleOutWmsId, saleOutWmsEntryId,
      saleOutWmsBillNo: delivered.detail.billNo, warehouseId, areaId, locationId, batchNo, quantity
    }
  })
  const payload = buildSaleReturnPayload({
    marker, customerId, saleOrderId, orderItemId, materialId, unitId,
    warehouseId, areaId, locationId, accountId, batchNo: batch.batchNo,
    billNo: `${marker}-SR`
  })
  return { payload, batch }
}

async function preparePendingPlan (api, caseRecord, { type, materialId, unitId, marker }, helpers) {
  const item = await helpers.createPublishedItem(api, caseRecord, { kind: 'QP-EXT', unitId })
  const created = await helpers.createPlan(api, caseRecord, {
    kind: 'QP-EXT', type: Number(type), itemId: item.itemId, itemSnapshot: item.row,
    publish: true, subOverrides: { remark: marker.slice(0, 32) }
  })
  const binding = await helpers.createQualityMaterialRule(api, caseRecord, {
    materialId, planId: created.planId, type, isDefault: true
  })
  if (String(created.row?.type) !== type || Number(created.row?.publishStatus) !== 1 ||
      !created.row?.planCode || !Number.isSafeInteger(Number(created.row?.versionNo)) ||
      Number(created.row.versionNo) < 1 ||
      pendingSourceId(binding.row?.materialId) !== materialId ||
      pendingSourceId(binding.row?.planId) !== pendingSourceId(created.planId) ||
      String(binding.row?.type) !== type || ![true, 1, '1'].includes(binding.row?.isDefault)) {
    throw blocked('扩展来源的专属已发布方案和默认物料绑定回读失败')
  }
  return { id: pendingSourceId(created.planId), code: created.row.planCode,
    version: Number(created.row.versionNo), item, created, binding }
}

async function createPendingWmsDraft (api, caseRecord, context) {
  const billNo = `${context.marker}-${context.type}`
  // Save, not submit: no stock execution and no shared approval/config changes.
  await api.postBusiness('/mes/stkIo/add/save', {
    billNo, billDate: new Date().toISOString().slice(0, 10), remark: context.marker,
    subject: context.marker, stockIoType: context.type, isAuto: 0,
    srcBillType: context.sourceType, srcBillId: context.upstreamId, srcNo: context.upstreamNo,
    customerId: context.customerId,
    stkIoEntryList: [{
      entryNo: 1, materialId: context.materialId, unitId: context.unitId, qty: 1, cost: 10,
      settleQty: 1, isQc: 1, stockIoType: context.type,
      stockIoDirection: context.type === '201' ? '2' : '1',
      srcBillType: context.sourceType, srcBillId: context.upstreamId,
      srcEntryId: context.upstreamEntryId, srcNo: context.upstreamNo,
      warehouseId: context.warehouseId, wareAreaId: context.areaId,
      wareLocationId: context.locationId, batchNo: context.batchNo
    }],
    stkIoDistributionList: [], stkIoBomList: []
  })
  const rows = pendingRows(await api.getBusiness(
    `/mes/stkIo/list?pageNo=1&pageSize=100&srcBillType=${context.sourceType}&srcBillId=${context.upstreamId}`
  )).filter(row => row.billNo === billNo && row.remark === context.marker &&
    String(row.srcBillId) === context.upstreamId && row.srcBillType === context.sourceType)
  if (rows.length !== 1) throw blocked('保存WMS来源后未精确回读唯一专属草稿')
  context.sourceId = pendingSourceId(rows[0].id)
  const source = await readPendingWmsDraft(api, context)
  caseRecord.evidence.push(
    `真实${context.sourceType}=${context.upstreamId}/${context.upstreamEntryId} -> ` +
    `${context.type}专属需检草稿=${context.sourceId}/${source.entry.id}; qty=1, stage=12, effective=0（未执行库存）`
  )
  return source
}

export async function readPendingWmsDraft (api, context) {
  const detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById/dictText?id=${context.sourceId}`))
  const entries = pendingRows(await api.getBusiness(
    `/mes/stkIo/queryEntryByMainId/dictText?id=${context.sourceId}`
  ))
  return assertOwnedPendingWmsDraft({ detail, entries, context })
}

export async function prepareQualityPendingSalesSource ({
  api, caseRecord, access, owned, env = process.env, dependencies = {}
}) {
  requireAdditionalSourceOptIn(access, env)
  const helpers = { prepareWmsFixture, createPublishedItem, createPlan, createQualityMaterialRule,
    createOpeningInventory, readSql: runReadOnlySql, ...dependencies }
  const fixture = await helpers.prepareWmsFixture(api, caseRecord, 93)
  const marker = `E2E-QP-${randomUUID().slice(0, 8).toUpperCase()}`
  const context = { marker, type: '201', sourceType: 'SalOrder',
    materialId: pendingSourceId(fixture.material.id), unitId: pendingSourceId(fixture.unit.id),
    warehouseId: pendingSourceId(fixture.warehouse.id), areaId: pendingSourceId(fixture.area.id),
    locationId: pendingSourceId(fixture.location.id), fixture }
  owned.context = context
  const plan = await preparePendingPlan(api, caseRecord, context, helpers)
  owned.plan = plan
  const customerId = pendingSourceId(dataOf(await api.postBusiness('/base/partner/create', {
    name: `${marker}-CUSTOMER`, shortName: marker, partnerKind: 'ORGANIZATION',
    status: 'ACTIVE', supplierEnabled: false, customerEnabled: true, carrierEnabled: false, remark: marker
  })))
  context.customerId = customerId
  const customer = dataOf(await api.getBusiness(`/base/partner/get?id=${customerId}`))
  if (pendingSourceId(customer?.id) !== customerId || customer.remark !== marker ||
      customer.customerEnabled !== true) throw blocked('专属销售客户回读失败')
  context.upstreamId = pendingSourceId(dataOf(await api.postBusiness('/erp/sale-order/create',
    buildSaleOrderPayload({ marker, customerId, materialId: context.materialId, unitId: context.unitId }))))
  const order = dataOf(await api.getBusiness(`/erp/sale-order/get?id=${context.upstreamId}`))
  if (pendingSourceId(order?.id) !== context.upstreamId || order.remark !== marker ||
      pendingSourceId(order.customerId) !== customerId || order.items?.length !== 1 ||
      pendingSourceId(order.items[0]?.productId) !== context.materialId ||
      Number(order.items[0]?.count) !== 1 || Number(order.isVoided) !== 0) {
    throw blocked('正式专属销售订单和明细回读失败')
  }
  context.upstreamEntryId = pendingSourceId(order.items[0].id)
  context.upstreamNo = order.billNo
  context.opening = await helpers.createOpeningInventory(
    api, caseRecord, fixture, fixture.material, fixture.unit.id, 1
  )
  if (!context.opening?.approved) throw blocked('销售来源专属期初库存未真实生效')
  context.batchNo = context.opening.batchNo
  const stock = await helpers.readSql(`
    SELECT id, qty, available_qty FROM mes_stk_inventory
    WHERE tenant_id=1 AND deleted=0 AND material_id='${context.materialId}'
      AND warehouse_id='${context.warehouseId}' AND batch_no='${context.batchNo}'
  `)
  caseRecord.database ||= []
  caseRecord.database.push({ stage: 'quality-pending-sales-owned-stock', ...stock })
  if (!stock.available || stock.rows?.length !== 1 ||
      Number(stock.rows[0][1]) !== 1 || Number(stock.rows[0][2]) !== 1) {
    throw blocked('销售来源没有本轮真实专属可用库存前态')
  }
  const source = await createPendingWmsDraft(api, caseRecord, context)
  return { source, plan, context, marker, qcType: 'OQC', sourceScene: 'SALES_OUTBOUND',
    sourceBillType: 'MesStkIo', sourceBillId: context.sourceId,
    sourceEntryId: pendingSourceId(source.entry.id), sourceBillNo: source.detail.billNo }
}

export async function cleanupQualityPendingSalesSource ({
  api, caseRecord, owned, readSql = runReadOnlySql
}) {
  const context = owned.context
  if (!context?.opening?.id) return
  if (context.sourceId) {
    await readPendingWmsDraft(api, context)
    await api.putBusiness('/mes/stkIo/void', { id: context.sourceId })
    const after = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${context.sourceId}`))
    if (pendingSourceId(after?.id) !== context.sourceId || after.remark !== context.marker ||
        Number(after.isVoided) !== 1 || Number(after.isEffective) !== 0) {
      throw blocked('销售来源草稿作废未确认，停止库存反向清理')
    }
  }
  const openingId = pendingSourceId(context.opening.id)
  const before = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${openingId}`))
  if (pendingSourceId(before?.id) !== openingId || String(before.stockIoType) !== '106' ||
      !String(before.remark).includes(context.fixture.token)) throw blocked('期初清理所有权回读失败')
  await api.putBusiness('/mes/stkIo/void', { id: openingId })
  const after = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${openingId}`))
  const stock = await readSql(`
    SELECT id, qty, available_qty, lock_qty, hold_qty, frozen_qty, pending_putaway_qty
    FROM mes_stk_inventory WHERE tenant_id=1 AND deleted=0
      AND material_id='${context.materialId}' AND warehouse_id='${context.warehouseId}'
  `)
  caseRecord.database ||= []
  caseRecord.database.push({ stage: 'quality-pending-sales-cleanup-zero-stock', ...stock })
  if (Number(after?.isVoided) !== 1 || Number(after?.isEffective) !== 0 ||
      !stock.available || !Array.isArray(stock.rows) ||
      !stock.rows.every(row => row.slice(1).every(value => Number(value) === 0))) {
    throw blocked('正式作废专属期初后库存分量未回到零')
  }
  owned.cleanupVerified = true
  caseRecord.evidence.push(`销售来源及专属106=${openingId}已正式作废并回读零库存；来源审计、订单及主数据保留`)
}

export async function prepareQualityPendingProductionSources ({
  api, record, caseRecord, access, owned, env = process.env, dependencies = {}
}) {
  requireAdditionalSourceOptIn(access, env)
  const helpers = { createPublishedItem, createPlan, createQualityMaterialRule,
    ExecutionWorkflowFixture, ...dependencies }
  const fixture = new helpers.ExecutionWorkflowFixture(api, record, 'QUALITY-PENDING-001', {
    withOpeningInventory: true, withQuality: true, withFeed: false
  })
  owned.fixture = fixture
  // Reuse the formal production fixture, supplying a bounded plan-sub remark.
  fixture.createQualityConfiguration = async () => {
    const plan = await preparePendingPlan(api, caseRecord, {
      type: '300', materialId: fixture.material.id, unitId: pendingSourceId(fixture.unit.id),
      marker: fixture.shortCode
    }, helpers)
    fixture.qualityConfig = { item: plan.item, plan: plan.created }
    owned.processPlan = plan
    caseRecord.notes.push(`QUALITY-PENDING process plan=${plan.id}, binding=${plan.binding.ruleId}`)
  }
  await fixture.setup(caseRecord)
  await fixture.startWork()
  const report = await fixture.reportTask({ qty: 1, qualifiedQty: 1, defectQty: 0 })
  if (pendingSourceId(report?.materialId) !== fixture.material.id ||
      pendingSourceId(report?.workTaskId) !== fixture.tasks[0].id ||
      Number(report.reportNum) !== 1 || Number(report.isEffective) !== 0 ||
      fixture.outputIds.length !== 0) {
    throw blocked('过程检报工来源没有处于真实待检状态或已提前产生成品库存')
  }
  const direct = pendingRows(await api.getBusiness(
    `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100&type=300&srcBillId=${report.id}`
  ))
  const taskSource = pendingRows(await api.getBusiness(
    `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100&type=300&srcBillId=${fixture.tasks[0].id}`
  ))
  // The product normalizes process inspections to task sources while retaining
  // the report key in customField8. Match that exact owned key, not any task QC.
  const linked = [...new Map([...direct, ...taskSource].filter(row =>
    String(row.type) === '300' && (
      String(row.srcBillId) === String(report.id) ||
      String(row.srcBillId) === fixture.tasks[0].id && String(row.customField8) === String(report.id)
    )).map(row => [pendingSourceId(row.id), row])).values()]
  caseRecord.productionPendingDiagnostic = {
    reportId: report.id, taskId: fixture.tasks[0].id,
    direct, taskSource, expectedPlanId: owned.processPlan.id
  }
  if (linked.length !== 1) {
    throw blocked(`报工没有唯一真实过程检来源：direct=${direct.length}, taskSource=${taskSource.length}, linked=${linked.length}`)
  }
  const inspection = dataOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${pendingSourceId(linked[0].id)}`
  ))
  if (Number(inspection.isEffective) !== 0 ||
      pendingSourceId(inspection.inspectionPlan) !== owned.processPlan.id) {
    throw blocked('真实过程检来源未处于未生效状态或专属方案不匹配')
  }
  const reportId = pendingSourceId(report.id)
  const process = {
    qcType: 'IPQC', sourceScene: 'PROCESS_INSPECTION', sourceBillType: report.billType,
    sourceBillId: reportId, sourceEntryId: reportId, sourceBillNo: report.reportCode,
    marker: fixture.marker, plan: owned.processPlan,
    source: { materialId: fixture.material.id, pendingQty: 1,
      entry: { materialId: fixture.material.id, unitId: fixture.unit.id, entryNo: 1,
        batchNo: fixture.works[0].batchNo },
      detail: { billNo: report.reportCode } },
    context: { reportId, inspectionId: pendingSourceId(inspection.id),
      workId: fixture.works[0].id, processId: fixture.procedure.id, taskId: fixture.tasks[0].id }
  }
  if (!process.sourceBillType || !process.sourceBillNo) throw blocked('真实报工来源类型或单号缺失')
  owned.process = process
  caseRecord.evidence.push(`正式生产计划=${fixture.order.id} -> 工单=${fixture.works[0].id} -> ` +
    `任务=${fixture.tasks[0].id} -> 待检报工=${reportId} -> 300草稿=${process.context.inspectionId}；未放行、未写库存`)
  const type = '104'
  const context = { marker: fixture.shortCode, type, sourceType: 'ProdWork',
    upstreamId: fixture.works[0].id, materialId: fixture.material.id,
    unitId: pendingSourceId(fixture.unit.id), warehouseId: fixture.warehouse.id,
    areaId: fixture.area.id, locationId: fixture.location.id, batchNo: `${fixture.shortCode}-IN` }
  const candidates = pendingRows(await api.getBusiness(
    `/mes/prodWork/returnProdOrderMsg/dictText?ids=${context.upstreamId}`
  ))
  if (candidates.length !== 1 ||
      pendingSourceId(candidates[0].orderId) !== context.upstreamId ||
      pendingSourceId(candidates[0].materialId) !== context.materialId ||
      Number(candidates[0].orderQty) < 1) throw blocked('正式104入库来源回显不匹配')
  context.upstreamEntryId = pendingSourceId(candidates[0].orderEntryId)
  context.upstreamNo = candidates[0].orderNo
  const plan = await preparePendingPlan(api, caseRecord, context, helpers)
  owned.inboundPlan = plan
  owned.inboundContext = context
  const source = await createPendingWmsDraft(api, caseRecord, context)
  return [process, { source, plan, context, marker: context.marker,
    qcType: 'IPQC', sourceScene: 'PRODUCTION_INBOUND', sourceBillType: 'MesStkIo',
    sourceBillId: context.sourceId, sourceEntryId: pendingSourceId(source.entry.id),
    sourceBillNo: source.detail.billNo }]
}
