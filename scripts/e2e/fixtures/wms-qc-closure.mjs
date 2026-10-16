import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { config } from '../config/index.mjs'
import { createApiClient, isBusinessRejection, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { assertLocalWmsWriteTarget, cleanupWmsFixtures, createMaterialFixture, isOwnedFixture, isWmsWriteEnabled, prepareWmsFixture } from '../lib/wms-fixtures.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { withManualOqcScenario } from './quality-manual-scenario.mjs'
import { withLoggedInTenant } from './enterprise-isolation.mjs'
import { createPmsIsolationTenant, retirePmsIsolationTenant } from './pms-tenant-isolation.mjs'
import { createProcurementPermissionReader } from './procurement-permission-reader.mjs'
import {
  createPlan,
  createPublishedItem,
  createQualityMaterialRule
} from './mes-quality-write.mjs'

export const WMS_QC_CLOSURE_CASES = Object.freeze([
  'WMS-QC-001',
  'WMS-QC-002',
  'WMS-QC-003',
  'WMS-QC-005',
  'WMS-QC-009',
  'WMS-QC-010'
])

export const WMS_QC_FORMAL_CONTRACTS = Object.freeze({
  purchaseInbound: Object.freeze({
    erpCreate: '/erp/purchase-in/create',
    erpGet: '/erp/purchase-in/get',
    erpStatus: '/erp/purchase-in/update-status',
    wmsType: '101',
    wmsSource: 'ErpPurchaseIn',
    direction: 'IN',
    needQuality: true
  }),
  purchaseReturn: Object.freeze({
    erpCreate: '/erp/purchase-return/create',
    erpGet: '/erp/purchase-return/get',
    erpStatus: '/erp/purchase-return/update-status',
    wmsType: '301',
    wmsSource: 'PurReturn',
    direction: 'OUT',
    needQuality: false
  }),
  saleReturn: Object.freeze({
    erpCreate: '/erp/sale-return/create',
    erpGet: '/erp/sale-return/get',
    erpStatus: '/erp/sale-return/update-status',
    wmsType: '302',
    wmsSource: 'SalReturn',
    direction: 'IN',
    needQuality: false
  })
})

export const WMS_QC_DEFERRED_CONTRACTS = Object.freeze({
  redInvoice: Object.freeze({
    status: 'DEFERRED',
    reason: '当前正式 API 目录未发现库存期初红冲专用契约；不得用弃审或 ERP void 冒充红冲。'
  }),
  lowPrivilegeAccount: Object.freeze({
    status: 'READY',
    reason: '复用正式只读账号 helper 和隔离登录，验证精确 403 与管理员前后回读；未真实执行。'
  }),
  secondTenant: Object.freeze({
    status: 'READY',
    reason: '复用专属租户和真实隔离登录 helper，不能仅替换 tenant-id 请求头。'
  }),
  wmsAtp: Object.freeze({
    status: 'READY',
    reason: '销售订单 get 的 items[].stockCount 调用 getSaleAtpCount -> WmsStockQueryApi.getAtp；/erp/stock/get-count 不是 ATP。'
  }),
  wmsOutboundInspection: Object.freeze({
    status: 'READY',
    reason: '201 来源检验 edit/submit、check、recheck 与 WMS execute 已按源码接线；仍需真实执行，不替代发货通知完成验收。'
  }),
  legacyMirrorJob: Object.freeze({
    status: 'DEFERRED',
    reason: '仅凭旧 ERP 仓库写接口退役码不能证明镜像任务停写；需要后台任务或只读 SQL 证据。'
  })
})

export const WMS_QC_SOURCE_CONTRACTS = Object.freeze({
  qualityVoidRetainsDraft: Object.freeze({
    status: 'OBSERVED',
    sources: [
      'cfor-admin/cfor-module-mes/cfor-module-mes-biz/src/main/java/tech/cfor17/module/mes/service/quality/impl/MesQualityInspectionServiceImpl.java:2153-2160',
      'cfor-admin/cfor-module-mes/cfor-module-mes-biz/src/main/java/tech/cfor17/module/mes/service/quality/impl/MesQualityInspectionServiceImpl.java:2171-2189',
      'cfor-admin/cfor-module-bpm/src/main/java/tech/cfor17/module/bpm/service/bill/impl/BillServiceImpl.java:991-1004'
    ],
    reason: '质检弃审调用基类 voidBill 并清理派生不良数据/明细数据，未删除质检主单；主单应回到可录入草稿。'
  }),
  wmsManualExecute: Object.freeze({
    status: 'OBSERVED',
    sources: [
      'cfor-admin/cfor-module-wms/cfor-module-wms-biz/src/main/java/tech/cfor17/module/wms/controller/admin/stock/MesStkIoController.java:1331-1339',
      'cfor-admin/cfor-module-wms/cfor-module-wms-biz/src/main/java/tech/cfor17/module/wms/service/stock/impl/StkIoServiceImpl.java:3012-3029'
    ],
    reason: 'WMS 单据未开启自动执行时只推进审核状态，不写库存；必须通过正式 check/execute 链路完成执行。'
  })
})

const nowDate = () => new Date().toISOString().slice(0, 10)
const nowDateTime = () => new Date().toISOString().slice(0, 19)
const text = (value) => String(value ?? '').trim()
const sameId = (left, right) => text(left) !== '' && text(left) === text(right)
const stableId = (value) => typeof value === 'number'
  ? Number.isSafeInteger(value) && value > 0
  : typeof value === 'string' && /^[1-9]\d*$/.test(value)
const dataOf = (response) => response?.data

const pageRows = (response, label) => {
  if (!isBusinessSuccess(response)) throw new Error(`${label}业务失败：${response?.code} ${response?.msg || response?.message || ''}`)
  const data = dataOf(response)
  const rows = Array.isArray(data) ? data : data?.list ?? data?.records
  if (!Array.isArray(rows)) throw new Error(`${label}未返回数组`)
  return rows
}

const addCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks ||= []
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  return Boolean(passed)
}

const addEvidence = (caseRecord, value) => {
  caseRecord.evidence ||= []
  caseRecord.evidence.push(value)
}

const addNote = (caseRecord, value) => {
  caseRecord.notes ||= []
  caseRecord.notes.push(value)
}

const addGap = (caseRecord, key, reason, status = 'GAP', sources = []) => {
  caseRecord.contractGaps ||= []
  caseRecord.contractGaps.push({ key, status, reason, sources })
  addNote(caseRecord, `${status}: ${reason}${sources.length ? `；源码=${sources.join('; ')}` : ''}`)
}

const serviceRejection = (message) => ({ code: 500, message, allowServiceCode: true })
const requireSuccess = (response, label) => {
  if (!isBusinessSuccess(response)) throw new Error(`${label}业务失败：${response?.code} ${response?.msg || response?.message || ''}`)
  return response.data
}
const canonicalRows = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))

const remember = (caseRecord, fixture) => {
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push(fixture)
  return fixture
}

export const wmsQcMarker = (caseId = 'WMS-QC') =>
  `E2E-Q${caseId.slice(-3)}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 5).toUpperCase()}`

export function assertWmsQcScope (settings = config) {
  if (settings.target !== 'local' || text(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: WMS-QC 写侧仅允许 local tenant1 / CFOR 标准平台')
  }
  for (const [label, base, port] of [
    ['前端', settings.webBase, '9151'],
    ['后端', settings.apiBase, '48083']
  ]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error(`BLOCKED: WMS-QC ${label}必须使用本地回环端口 ${port}`)
    }
  }
}

const requireId = (value, label) => {
  if (!stableId(value)) throw new Error(`BLOCKED: ${label}未返回稳定 ID：${value}`)
  return String(value)
}

const requireApiSuccessId = (response, label) => requireId(requireSuccess(response, label), label)

const isEffectiveBill = (detail) => detail?.isEffective != null
  ? text(detail.isEffective) === '1'
  : detail?.effectiveTime != null && text(detail.effectiveTime) !== ''
const inspectionPath = (id) =>
  `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(id)}`
const billStateRejection = (detail, label) => {
  if (!text(detail?.billNo)) throw new Error(`BLOCKED: ${label}没有单号，不能建立精确状态拒绝契约`)
  return serviceRejection(`${detail.billNo}：单据不能做该操作，可能被其他用户改变了状态！`)
}
const inspectionStateRejection = (detail) => billStateRejection(detail, '质检单')
const exactStateRejection = (response, expected) => {
  const messages = [response?.msg, response?.message]
    .filter((value) => typeof value === 'string' && value !== '')
  return matchesExpectedBusinessRejection(response, expected) &&
    response?.success !== true && response?.ok !== true && response?.data == null &&
    messages.length > 0 && messages.every((value) => value === expected.message)
}
const stockInspectionSource = (value, type) =>
  text(value) === 'MesStkIo' || text(value) === `MesStkIo:${type}`

export async function withWmsManualOqcScenario (api, caseRecord, run, dependencies = {}) {
  const runner = dependencies.withManualOqcScenario || withManualOqcScenario
  return runner(api, caseRecord, run, {
    ...dependencies,
    config: dependencies.config || dependencies.settings || config
  })
}

const defaultMoney = 10
const defaultQty = 1
const MAX_BOM_BATCH_LENGTH = 32

const boundedReturnBatchNo = (marker, kind) => {
  const digest = createHash('sha256').update(String(marker)).digest('hex').slice(0, 20)
  const value = `E2E-${kind}-${digest}`
  if (value.length > MAX_BOM_BATCH_LENGTH) {
    throw new Error(`BLOCKED: ${kind} 退货批次号超过 ${MAX_BOM_BATCH_LENGTH} 个字符`)
  }
  return value
}

const resolveReturnBatchNo = (batchNo, marker, kind) => {
  const value = batchNo ?? boundedReturnBatchNo(marker, kind)
  if (typeof value !== 'string' || value.trim().length === 0 ||
      Array.from(value).length > MAX_BOM_BATCH_LENGTH) {
    throw new Error(`BLOCKED: ${kind} 退货批次号必须为 1-${MAX_BOM_BATCH_LENGTH} 个字符`)
  }
  return value
}

const quantity = (value) => {
  if (!['number', 'string'].includes(typeof value) || value === '' ||
      (typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(value))) return NaN
  return Number(value)
}

const inventoryConserved = (row) => {
  if (!row) return false
  const total = quantity(row.qty)
  const components = [
    row.availableQty,
    row.lockQty,
    row.holdQty,
    row.frozenQty,
    row.pendingPutawayQty
  ].map(quantity)
  return [total, ...components].every((value) => Number.isFinite(value) && value >= 0) &&
    Math.abs(total - components.reduce((sum, value) => sum + value, 0)) < 0.000001
}

// Read all pages: a truncated positive-stock page cannot prove absence or ATP.
const readAll = async (api, path, label) => {
  const rows = []
  const ids = new Set()
  let expectedTotal
  for (let page = 1; page <= 100; page++) {
    const response = await api.getBusiness(`${path}${path.includes('?') ? '&' : '?'}pageNo=${page}&pageSize=100`)
    const batch = pageRows(response, label)
    const total = response.data?.total
    if (!Number.isSafeInteger(total) || total < 0 || batch.length > 100 ||
        (expectedTotal !== undefined && expectedTotal !== total)) {
      throw new Error(`${label}分页不完整或查询期间总数变化`)
    }
    expectedTotal = total
    for (const row of batch) {
      const id = requireId(row?.id, label)
      if (ids.has(id)) throw new Error(`${label}重复分页 ID：${id}`)
      ids.add(id)
      rows.push(structuredClone(row))
    }
    if (rows.length === total) return canonicalRows(rows)
    if (!batch.length || rows.length > total) throw new Error(`${label}分页总数不一致`)
  }
  throw new Error(`${label}超过安全分页上限`)
}

const inventorySnapshot = async (api, fixture, materialId) => {
  const rows = await readAll(api, `/mes/stkInventory/list?materialId=${encodeURIComponent(materialId)}` +
    (fixture?.warehouse?.id ? `&warehouseId=${encodeURIComponent(fixture.warehouse.id)}` : ''), 'WMS 专属库存')
  if (rows.some((row) => !sameId(row.materialId, materialId) ||
      (fixture?.warehouse?.id && !sameId(row.warehouseId, fixture.warehouse.id)) ||
      !inventoryConserved(row))) throw new Error('WMS 库存维度或守恒字段不完整')
  return rows
}

const readStockState = async (api, fixture, wmsId) => {
  const id = requireId(wmsId, 'WMS 来源单据')
  const main = requireSuccess(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(id)}`), 'WMS 单据')
  const entries = canonicalRows(await readSourceEntries(api, id))
  if (!sameId(main?.id, id) || entries.some((entry) =>
    !stableId(entry.id) || !sameId(entry.mid, id) ||
    !sameId(entry.materialId, fixture.material.id) ||
    !sameId(entry.warehouseId, fixture.warehouse.id))) {
    throw new Error('BLOCKED: WMS 来源主单或明细不属于本轮专属仓库物料')
  }
  return structuredClone({
    main,
    entries,
    inventory: await inventorySnapshot(api, fixture, fixture.material.id)
  })
}

export async function verifyWmsQcDuplicateAudit (api, caseRecord, fixture, inbound) {
  const before = await readStockState(api, fixture, inbound.wms.id)
  const actions = before.main.actions
  const checkDisabled = actions && typeof actions === 'object' && !Array.isArray(actions) &&
    (!Object.hasOwn(actions, 'check') || actions.check === false || actions.check === null)
  if (!isEffectiveBill(before.main) || !checkDisabled ||
      text(before.main.stockIoType) !== '101' ||
      text(before.main.srcBillType) !== 'ErpPurchaseIn' ||
      !sameId(before.main.srcBillId, inbound.id)) {
    throw new Error('BLOCKED: 重复审核负例必须使用本轮已生效且不可 check 的正式采购入库来源')
  }
  const expected = billStateRejection(before.main, 'WMS 单据')
  const response = await api.put('/mes/stkIo/check', {
    id: String(inbound.wms.id),
    approvalResultType: '1',
    approvalRemark: `${fixture.marker} deliberate duplicate WMS approval`
  }, { expectedBusinessRejection: expected })
  const after = await readStockState(api, fixture, inbound.wms.id)
  const rejected = exactStateRejection(response, expected)
  const unchanged = isDeepStrictEqual(before, after)
  addCheck(caseRecord, '重复审核正式 WMS 单据不允许二次执行', rejected,
    `id=${inbound.wms.id}; code=${response?.code}; expected=${expected.message}; exact=${rejected}`)
  addCheck(caseRecord, '重复审核前后正式主单、来源明细和专属库存完全不变', unchanged,
    `id=${inbound.wms.id}; main=${isDeepStrictEqual(before.main, after.main)}; ` +
    `entries=${isDeepStrictEqual(before.entries, after.entries)}; inventory=${isDeepStrictEqual(before.inventory, after.inventory)}`)
  if (!rejected || !unchanged) throw new Error('WMS 重复审核未精确拒绝或正式数据发生变化，停止后续写侧')
  addEvidence(caseRecord, `WMS 重复审核精确状态拒绝且前后回读不变：${inbound.wms.id}；未以泛化 500 作为幂等证据`)
  return { rejected, unchanged, before, after }
}

export async function verifyWmsQcInvalidPurchaseLine (api, caseRecord, fixture, inbound) {
  const orderId = requireId(inbound.payload?.orderId, '多行拒绝来源采购订单')
  if (!Array.isArray(inbound.payload?.items) || inbound.payload.items.length !== 1 ||
      !sameId(inbound.payload.items[0].productId, fixture.material.id) ||
      !sameId(inbound.payload.items[0].warehouseId, fixture.warehouse.id)) {
    throw new Error('BLOCKED: 多行拒绝必须基于本轮专属采购订单、仓库和物料')
  }
  const invalidMaterialId = '999999999999999999'
  const missingExpected = serviceRejection('未找到对应数据')
  const missing = await api.get(`/mes/basMaterial/queryById?id=${invalidMaterialId}`, {
    expectedBusinessRejection: missingExpected
  })
  if (!exactStateRejection(missing, missingExpected)) {
    throw new Error('BLOCKED: 非法第二行物料未精确回读不存在，未发送负例请求')
  }
  const marker = `${fixture.marker}-INVALID-LINE`
  const readProbe = async () => readAll(api,
    `/erp/purchase-in/page?remark=${encodeURIComponent(marker)}`, '非法第二行采购入库回读')
  const baseline = await readProbe()
  if (baseline.length !== 0) throw new Error('BLOCKED: 非法第二行探针备注已存在，不能验证未落库')
  const before = {
    order: structuredClone(requireSuccess(await api.getBusiness(
      `/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`), '非法第二行来源订单回读')),
    stock: await readStockState(api, fixture, inbound.wms.id)
  }
  if (!sameId(before.order?.id, orderId)) throw new Error('BLOCKED: 多行拒绝来源订单回读 ID 不匹配')
  const expected = { code: 1030500000, message: '产品不存在' }
  const payload = {
    ...inbound.payload,
    remark: marker,
    items: [
      { ...inbound.payload.items[0], remark: marker },
      { ...inbound.payload.items[0], productId: invalidMaterialId, remark: marker }
    ]
  }
  const response = await api.post('/erp/purchase-in/create', payload, {
    expectedBusinessRejection: expected
  })
  const rows = await readProbe()
  const after = {
    order: structuredClone(requireSuccess(await api.getBusiness(
      `/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`), '非法第二行来源订单后态')),
    stock: await readStockState(api, fixture, inbound.wms.id)
  }
  const rejected = exactStateRejection(response, expected)
  const unchanged = isDeepStrictEqual(before, after)
  const absent = rows.length === 0
  addCheck(caseRecord, '多行正式采购入库失败后不留下孤儿单据', rejected && absent,
    `code=${response?.code}; expected=1030500000/产品不存在; remark=${marker}; rows=${rows.length}`)
  addCheck(caseRecord, '非法第二行拒绝后来源订单、WMS 单据明细及库存均不变', unchanged,
    `order=${orderId}; wms=${inbound.wms.id}; unchanged=${unchanged}`)
  addNote(caseRecord, '非法物料在插入主单前被全量校验拒绝；该检查不计入事务中途失败整体回滚证据。')
  if (!rejected || !unchanged || !absent) throw new Error('非法第二行未精确拒绝、出现孤儿单据或正式数据变化')
  return { rejected, unchanged, absent, marker }
}

const qc003Sources = Object.freeze({
  execute: 'cfor-admin/cfor-module-wms/cfor-module-wms-biz/src/main/java/tech/cfor17/module/wms/controller/admin/stock/MesStkIoController.java:1335',
  stock: 'cfor-admin/cfor-module-wms/cfor-module-wms-biz/src/main/java/tech/cfor17/module/wms/service/stock/impl/StkInventoryServiceImpl.java:722',
  flow: 'cfor-admin/cfor-module-wms/cfor-module-wms-biz/src/main/java/tech/cfor17/module/wms/controller/admin/stock/StkIoReportViewController.java:68'
})

const qc003Scope = (caseRecord, fixture) => {
  requireOwnedStockDimensions(caseRecord, fixture)
  if (!/^E2E-/.test(fixture.marker || '') || !text(fixture.token)) {
    throw new Error('BLOCKED: QC003 缺少本轮 marker/token')
  }
  return {
    warehouse: requireId(fixture.warehouse.id, 'QC003 仓库'),
    material: requireId(fixture.material.id, 'QC003 物料')
  }
}

// The view exposes bill IDs, not entry IDs. Preserve repeated rows as a multiset.
const readQc003Flows = async (api, fixture) => {
  const path = `/mes/stk/report/view/list?materialId=${requireId(fixture.material.id, '流水物料')}` +
    `&warehouseId=${requireId(fixture.warehouse.id, '流水仓库')}`
  const rows = []
  let total
  for (let pageNo = 1; pageNo <= 100; pageNo++) {
    const response = await api.getBusiness(`${path}&pageNo=${pageNo}&pageSize=100`)
    const batch = pageRows(response, 'QC003 正式出入库流水')
    const count = response.data?.total
    if (!Number.isSafeInteger(count) || count < 0 || batch.length > 100 ||
        (total !== undefined && count !== total)) throw new Error('QC003 流水分页不完整或总数变化')
    total = count
    if (batch.some((row) => !stableId(row.id) || !sameId(row.materialId, fixture.material.id) ||
        !sameId(row.warehouseId, fixture.warehouse.id))) throw new Error('QC003 流水查询越出专属维度')
    rows.push(...structuredClone(batch))
    if (rows.length === total) return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    if (!batch.length || rows.length > total) throw new Error('QC003 流水分页总数不一致')
  }
  throw new Error('QC003 流水超过安全分页上限')
}

const readQc003Facts = async (api, caseRecord, fixture, wmsId, dependencies = {}, probeBillNo) => {
  const { warehouse, material } = qc003Scope(caseRecord, fixture)
  const id = requireId(wmsId, 'QC003 来源单')
  if (probeBillNo && !/^E2E-[A-Za-z0-9-]+$/.test(probeBillNo)) {
    throw new Error('BLOCKED: QC003 事务探针单号不安全')
  }
  const stock = await readStockState(api, fixture, id)
  const flow = await readQc003Flows(api, fixture)
  const sql = dependencies.runReadOnlySql || runReadOnlySql
  const headWhere = `tenant_id=1 AND (id='${id}' OR id IN (` +
    `SELECT mid FROM mes_stk_io_entry WHERE tenant_id=1 AND warehouse_id='${warehouse}' AND material_id='${material}')` +
    (probeBillNo ? ` OR bill_no='${probeBillNo}'` : '') + ')'
  const inventoryWhere = `tenant_id=1 AND warehouse_id='${warehouse}' AND material_id='${material}'`
  const queries = {
    main: `SELECT * FROM mes_stk_io WHERE ${headWhere} ORDER BY id`,
    entries: `SELECT * FROM mes_stk_io_entry WHERE tenant_id=1 AND mid IN (` +
      `SELECT id FROM mes_stk_io WHERE ${headWhere}) ORDER BY id`,
    inventory: `SELECT * FROM mes_stk_inventory WHERE ${inventoryWhere} ORDER BY id`,
    adjustments: `SELECT * FROM mes_stk_inventory_adjust_log WHERE tenant_id=1 AND (` +
      `inventory_id IN (SELECT id FROM mes_stk_inventory WHERE ${inventoryWhere}) OR ` +
      `source_bill_id IN (SELECT id FROM mes_stk_io WHERE ${headWhere})) ORDER BY id`
  }
  const persisted = {}
  for (const [table, query] of Object.entries(queries)) {
    const result = await sql(query)
    if (result?.available !== true || !Array.isArray(result.rows) ||
        result.rows.some((row) => !Array.isArray(row)) ||
        (table !== 'adjustments' && result.rows.length === 0)) {
      throw new Error(`BLOCKED: QC003 缺少 ${table} 完整只读 SQL 证据`)
    }
    persisted[table] = result.rows
  }
  const facts = structuredClone({ stock, flow, persisted })
  caseRecord.qc003Facts ||= []
  caseRecord.qc003Facts.push({ sourceBillId: id, probeBillNo, facts })
  return facts
}

const assertQc003Unchanged = (caseRecord, name, before, after) => {
  const unchanged = isDeepStrictEqual(before, after)
  addCheck(caseRecord, name, unchanged, '正式主单、明细、库存六分量、流水与全列 SQL 前后对照')
  if (!unchanged) throw new Error(`${name}：正式事实发生变化，停止后续探针`)
  return unchanged
}

// TenantRespVO omits contactUserId. Resolve the expected browser principal from
// an authenticated profile, never from a guessed ID or a privileged tenant switch.
async function readQc003TenantAdminProfile (context, tenant, dependencies) {
  const tenantId = requireId(tenant?.id, 'QC003 管理员登录租户')
  if (tenantId === '1' || !text(tenant.username) || !text(tenant.password)) {
    throw new Error('BLOCKED: QC003 第二租户管理员凭据或独立租户缺失')
  }
  const client = dependencies.createApiClient || createApiClient
  // Login responses contain tokens; keep them out of the shared run record.
  const anonymous = client({ tenantId })
  const auth = requireSuccess(await anonymous.postBusiness('/system/auth/login-encrypted', {
    username: tenant.username, password: tenant.password, captchaVerification: ''
  }, { encrypted: true }), 'QC003 第二租户管理员加密登录')
  if (typeof auth?.accessToken !== 'string' || auth.accessToken.length <= 20) {
    throw new Error('BLOCKED: QC003 第二租户管理员登录未返回真实访问令牌')
  }
  const profileApi = client({
    token: auth.accessToken,
    tenantId: stableId(auth.tenantId) ? text(auth.tenantId) : tenantId,
    record: context.record
  })
  let operationError
  try {
    const userId = requireId(auth.userId, 'QC003 第二租户管理员登录')
    if (requireId(auth.tenantId, 'QC003 管理员登录回包租户') !== tenantId) {
      throw new Error('BLOCKED: QC003 第二租户管理员登录租户不一致')
    }
    const profile = requireSuccess(await profileApi.getBusiness('/system/user/profile/get'),
      'QC003 第二租户管理员 profile')
    const info = requireSuccess(await profileApi.getBusiness('/system/auth/get-permission-info'),
      'QC003 第二租户管理员权限')
    if (requireId(profile?.id, 'QC003 第二租户管理员 profile') !== userId ||
        requireId(info?.user?.id, 'QC003 第二租户管理员权限') !== userId ||
        profile.username !== tenant.username || info.user.username !== tenant.username ||
        !Array.isArray(info.roles) || !info.roles.includes('tenant_admin') ||
        [profile, info.user].some((row) => row.tenantId != null &&
          requireId(row.tenantId, 'QC003 管理员归属租户') !== tenantId)) {
      throw new Error('BLOCKED: QC003 第二租户管理员 profile/权限身份未核实')
    }
    return userId
  } catch (error) {
    operationError = error
    throw error
  } finally {
    try {
      requireSuccess(await profileApi.postBusiness('/system/auth/logout'), 'QC003 管理员 profile 会话退出')
    } catch (error) {
      if (operationError) throw new AggregateError([operationError, error],
        `${operationError.message}; QC003 管理员 profile 会话退出失败：${error.message}`)
      throw error
    }
  }
}

export async function verifyWmsQcTenantIsolation (
  api, context, caseRecord, fixture, inbound, dependencies = {}
) {
  const before = await readQc003Facts(api, caseRecord, fixture, inbound.wms.id, dependencies)
  if (!before.stock.inventory.length) throw new Error('BLOCKED: 跨租户负例缺少真实专属库存')
  const createTenant = dependencies.createPmsIsolationTenant || createPmsIsolationTenant
  const retireTenant = dependencies.retirePmsIsolationTenant || retirePmsIsolationTenant
  const session = dependencies.withLoggedInTenant || withLoggedInTenant
  let tenant
  let verified = false
  try {
    tenant = await createTenant(api, { marker: fixture.marker })
    const tenantId = requireId(tenant.tenantId, 'QC003 第二租户')
    if (tenantId === '1' || !sameId(tenant.tenant?.id, tenantId)) {
      throw new Error('BLOCKED: QC003 第二租户身份不独立')
    }
    remember(caseRecord, { kind: 'qc003Tenant', id: tenantId, marker: fixture.marker, retained: true })
    const tenantRecord = requireSuccess(await api.getBusiness(`/system/tenant/get?id=${tenantId}`), 'QC003 第二租户身份')
    if (!sameId(tenantRecord?.id, tenantId) || tenantRecord.name !== tenant.tenant.name ||
        tenantRecord.status !== 0) throw new Error('BLOCKED: QC003 第二租户正式身份未核实')
    const userId = await readQc003TenantAdminProfile(context, tenant.tenant, dependencies)
    await session(context, tenant.tenant, async ({ api: foreignApi, auth, info }) => {
      if (!sameId(auth?.tenantId, tenantId) || !stableId(info?.user?.id) ||
          !sameId(info.user.id, userId) || info.user.username !== tenant.tenant.username ||
          !Array.isArray(info.roles) || !info.roles.includes('tenant_admin') ||
          (info.user.tenantId != null && !sameId(info.user.tenantId, tenantId))) {
        throw new Error('BLOCKED: QC003 第二租户真实登录身份未核实')
      }
      const missing = serviceRejection('未找到对应数据')
      for (const path of [
        `/mes/stkIo/queryById?id=${inbound.wms.id}`,
        ...before.stock.inventory.map((row) => `/mes/stkInventory/queryById?id=${requireId(row.id, '库存')}`)
      ]) {
        const response = await foreignApi.get(path, { expectedBusinessRejection: missing })
        const passed = exactStateRejection(response, missing)
        addCheck(caseRecord, `第二租户不可读取指定 WMS 单据/库存：${path}`, passed,
          `tenant=${tenantId}; code=${response?.code}; message=${response?.msg || response?.message || ''}`)
        if (!passed) throw new Error('QC003 跨租户详情泄漏或拒绝契约不匹配')
      }
      for (const path of [
        `/mes/stkIo/list?id=${inbound.wms.id}&pageNo=1&pageSize=100`,
        `/mes/stkInventory/list?materialId=${fixture.material.id}&warehouseId=${fixture.warehouse.id}&pageNo=1&pageSize=100`,
        `/mes/stk/report/view/list?materialId=${fixture.material.id}&warehouseId=${fixture.warehouse.id}&pageNo=1&pageSize=100`
      ]) {
        const response = await foreignApi.getBusiness(path)
        const rows = pageRows(response, '第二租户 WMS 列表')
        if (!addCheck(caseRecord, `第二租户列表不暴露指定单据/库存/流水：${path}`,
          rows.length === 0 && response.data?.total === 0, `tenant=${tenantId}; rows=${rows.length}`)) {
          throw new Error('QC003 第二租户列表泄漏')
        }
      }
      const entries = requireSuccess(await foreignApi.getBusiness(
        `/mes/stkIo/queryEntryByMainId?id=${inbound.wms.id}`), '第二租户来源明细')
      if (!Array.isArray(entries) || entries.length !== 0) throw new Error('QC003 跨租户来源明细未隔离')
      const expected = serviceRejection('单据未找到，可能被其他用户删除了！')
      const response = await foreignApi.put('/mes/stkIo/execute', { id: String(inbound.wms.id) },
        { expectedBusinessRejection: expected })
      if (!addCheck(caseRecord, '第二租户 execute 精确拒绝不存在的外租户单据',
        exactStateRejection(response, expected), `tenant=${tenantId}; code=${response?.code}`)) {
        throw new Error('QC003 跨租户 execute 拒绝不符合正式契约')
      }
      verified = true
    }, { platformApi: api, tenantRecord, userId })
  } finally {
    try {
      const after = await readQc003Facts(api, caseRecord, fixture, inbound.wms.id, dependencies)
      assertQc003Unchanged(caseRecord, '跨租户探针后管理员 API/SQL 完整事实不变', before, after)
    } finally {
      if (tenant) await retireTenant(api, tenant, caseRecord)
    }
  }
  addCheck(caseRecord, '跨租户读写隔离已由独立会话证明', verified, '真实第二租户登录；未替换主账号 tenant-id')
  return { verified }
}

export async function verifyWmsQcLowPrivilege (
  api, context, caseRecord, fixture, inbound, dependencies = {}
) {
  const before = await readQc003Facts(api, caseRecord, fixture, inbound.wms.id, dependencies)
  // A missing authorization guard must not turn this negative probe into a stock write.
  const { main, entries } = before.stock
  const actions = main.actions
  const executeDisabled = actions && typeof actions === 'object' && !Array.isArray(actions) &&
    (!Object.hasOwn(actions, 'execute') || actions.execute === false)
  if (!isEffectiveBill(main) || text(main.billStage) !== '34' || text(main.isClosed) !== '1' ||
      text(main.isVoided) !== '0' || !executeDisabled ||
      text(main.stockIoType) !== '101' || text(main.srcBillType) !== 'ErpPurchaseIn' ||
      !sameId(main.srcBillId, inbound.id) || !entries.length ||
      entries.some((entry) => !text(entry.inStockTime))) {
    throw new Error('BLOCKED: 低权限 execute 只读探针必须使用已生效且明确不可执行的本轮单据')
  }
  const createReader = dependencies.createProcurementPermissionReader || createProcurementPermissionReader
  const session = dependencies.withLoggedInTenant || withLoggedInTenant
  const permission = 'erp:settle-method-rule:query'
  let reader
  let verified = false
  try {
    reader = await createReader(api, caseRecord, { permission, label: 'WMSQC003' })
    const tenantRecord = requireSuccess(await api.getBusiness('/system/tenant/get?id=1'), 'QC003 当前租户身份')
    await session(context, { id: '1', name: tenantRecord.name,
      username: reader.credentials.username, password: reader.credentials.password }, async ({ api: readerApi, auth, info }) => {
      if (!sameId(auth?.tenantId, '1') || !sameId(info?.user?.id, reader.userId) ||
          info.user.username !== reader.username || !Array.isArray(info.permissions) ||
          !info.permissions.includes(permission) ||
          info.permissions.some((value) => typeof value !== 'string' ||
            (value !== '' && (!value.endsWith(':query') || value.includes('*')))) ||
          !Array.isArray(info.roles) || info.roles.some((role) => /admin|^wms$/.test(role))) {
        throw new Error('BLOCKED: QC003 只读账号真实权限或身份不满足严格约束，未执行探针')
      }
      const response = await readerApi.put('/mes/stkIo/execute', { id: String(inbound.wms.id) },
        { expectedBusinessRejection: {
          codes: [403, 500], allowServiceCode: true,
          message: new RegExp(`^(?:没有该操作权限|${billStateRejection(before.stock.main, '低权限探针').message
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`)
        } })
      verified = exactStateRejection(response, { code: 403, message: '没有该操作权限', allowServiceCode: true })
      caseRecord.qc003PermissionProbe = {
        userId: String(reader.userId), roleId: String(reader.roleId), method: 'PUT',
        path: '/mes/stkIo/execute', billId: String(inbound.wms.id),
        response: { code: response?.code, msg: response?.msg, message: response?.message }, verified
      }
      if (verified) {
        addCheck(caseRecord, '低权限账号业务拒绝已由正式账号证明', true, 'execute 精确 403/没有该操作权限')
      } else if (exactStateRejection(response, billStateRejection(before.stock.main, '低权限探针'))) {
        addGap(caseRecord, 'low-privilege',
          `PUT /mes/stkIo/execute 未返回权限拒绝，而是到达单据状态校验：${response.code}/${response.msg || response.message}；不计权限通过。`,
          'BLOCKED', [qc003Sources.execute])
      } else {
        addCheck(caseRecord, '低权限 execute 未发生授权通过或非契约拒绝', false,
          `code=${response?.code}; message=${response?.msg || response?.message || ''}`)
        throw new Error('QC003 低权限 execute 返回成功或非契约响应')
      }
    }, { tenantRecord, userId: requireId(reader.userId, '只读账号'), requireTenantAdmin: false })
  } finally {
    try {
      const after = await readQc003Facts(api, caseRecord, fixture, inbound.wms.id, dependencies)
      assertQc003Unchanged(caseRecord, '低权限探针后管理员 API/SQL 完整事实不变', before, after)
    } finally {
      if (reader) {
        requireSuccess(await reader.deactivate(), 'QC003 停用只读账号')
        const user = requireSuccess(await api.getBusiness(`/system/user/get?id=${reader.userId}`), 'QC003 账号停用回读')
        if (!sameId(user?.id, reader.userId) || user.username !== reader.username || Number(user.status) !== 1) {
          throw new Error('QC003 只读账号停用未确认')
        }
      }
    }
  }
  return { verified }
}

const stockDimension = (row) => JSON.stringify([
  'materialId', 'warehouseId', 'wareAreaId', 'wareLocationId', 'batchNo', 'colorId', 'brand', 'gradeId'
].map((key) => text(row[key])))
const flowProjection = (row, qty) => JSON.stringify([
  row.id, row.materialId, row.warehouseId, row.wareAreaId, row.wareLocationId,
  row.unitId, row.stockIoDirection, quantity(qty), text(row.isEffective), text(row.isVoided)
].map((value) => text(value)))

const readQc003DefaultStorage = async (api, fixture, entry) => {
  const value = requireSuccess(await api.getBusiness(
    '/infra/config/get-value-by-key?key=area_location_switch'), 'QC003 正式仓储维度配置')
  if (value != null && typeof value !== 'string') throw new Error('QC003 仓储维度配置类型错误')
  const setting = text(value).toUpperCase()
  // Keep the formal WmsWarehouseDimensionModeEnum legacy/default interpretation.
  const mode = ['NONE', 'N', '3'].includes(setting) ? 'NONE'
    : ['AREA', 'A', '1'].includes(setting) ? 'AREA' : 'LOCATION'
  let areaId = text(entry.wareAreaId)
  let locationId = text(entry.wareLocationId)
  const evidence = { value, mode, warehouseId: String(entry.warehouseId) }
  const enabled = (row) => row.isEnabled === true || text(row.isEnabled) === '1'
  const warehouse = requireId(fixture.warehouse.id, 'QC003 默认维度仓库')
  if (!sameId(entry.warehouseId, warehouse)) throw new Error('QC003 默认维度越出本轮仓库')
  if (mode !== 'NONE' && !areaId) {
    const areas = await readAll(api, `/mes/wmsHouseArea/list?houseId=${warehouse}`, 'QC003 启用库区')
    if (areas.some((row) => !sameId(row.houseId, warehouse))) throw new Error('QC003 库区查询越出本轮仓库')
    const active = areas.filter(enabled)
    if (active.length !== 1 || !sameId(active[0].id, fixture.area.id)) {
      throw new Error('QC003 正式默认库区无法唯一核实，拒绝猜测余额事实')
    }
    areaId = String(active[0].id)
    evidence.area = active[0]
  }
  if (mode === 'LOCATION' && !locationId) {
    const locations = await readAll(api,
      `/mes/wms-house-location/page?houseId=${warehouse}&areaId=${requireId(areaId, 'QC003 默认库区')}`,
      'QC003 启用库位')
    if (locations.some((row) => !sameId(row.houseId, warehouse) || !sameId(row.areaId, areaId))) {
      throw new Error('QC003 库位查询越出正式仓库/库区')
    }
    const active = locations.filter(enabled)
    if (active.length !== 1 || !sameId(active[0].id, fixture.location.id)) {
      throw new Error('QC003 正式默认库位无法唯一核实，拒绝猜测余额事实')
    }
    locationId = String(active[0].id)
    evidence.location = active[0]
  }
  return { areaId, locationId, evidence }
}

export async function verifyWmsQcFlowBalance (api, caseRecord, fixture, inbound, dependencies = {}) {
  const before = await readQc003Facts(api, caseRecord, fixture, inbound.wms.id, dependencies)
  if (!before.flow.length || !before.stock.inventory.length) throw new Error('BLOCKED: 流水对账禁止空集通过')
  const projected = []
  const ledger = new Map()
  const ledgerUnits = new Map()
  const inventoryByDimension = new Map()
  const normalizedDimensions = []
  const defaultStorage = new Map()
  for (const row of before.stock.inventory) {
    const key = stockDimension(row)
    const previous = inventoryByDimension.get(key)
    if (!stableId(row.unitId) || (previous && !sameId(previous.unitId, row.unitId))) {
      throw new Error('BLOCKED: 库存缺少正式主单位或同库存维度主单位不一致')
    }
    inventoryByDimension.set(key, { unitId: row.unitId, qty: (previous?.qty || 0) + quantity(row.qty) })
  }
  for (const id of new Set(before.flow.map((row) => String(row.id)))) {
    const state = await readStockState(api, fixture, id)
    if (!['0', '1'].includes(text(state.main.isEffective)) || !['0', '1'].includes(text(state.main.isVoided))) {
      throw new Error('BLOCKED: 流水主单缺少生效/作废状态')
    }
    for (const entry of state.entries) {
      if (!stableId(entry.unitId) || !Number.isFinite(quantity(entry.qty)) ||
          !['1', '2'].includes(text(entry.stockIoDirection))) {
        throw new Error('BLOCKED: 流水明细缺少正式业务数量、单位或方向')
      }
      projected.push(flowProjection(
        { ...entry, id, isEffective: state.main.isEffective, isVoided: state.main.isVoided }, entry.qty))
      if (text(state.main.isEffective) !== '1' || text(state.main.isVoided) !== '0') continue
      const sourceKey = stockDimension(entry)
      let key = sourceKey
      if (!inventoryByDimension.has(key) && (!text(entry.wareAreaId) || !text(entry.wareLocationId))) {
        const cacheKey = JSON.stringify([entry.warehouseId, text(entry.wareAreaId), text(entry.wareLocationId)])
        if (!defaultStorage.has(cacheKey)) {
          defaultStorage.set(cacheKey, { entry, resolved: await readQc003DefaultStorage(api, fixture, entry) })
        }
        const { resolved } = defaultStorage.get(cacheKey)
        key = stockDimension({ ...entry, wareAreaId: resolved.areaId, wareLocationId: resolved.locationId })
        if (key !== sourceKey) normalizedDimensions.push({ sourceKey, balanceKey: key, id, entryId: entry.id })
      }
      const balance = inventoryByDimension.get(key)
      const ledgerUnit = ledgerUnits.get(key)
      if (!stableId(entry.baseUnitId) || !Number.isFinite(quantity(entry.baseQty)) ||
          (balance && !sameId(entry.baseUnitId, balance.unitId)) ||
          (ledgerUnit && !sameId(entry.baseUnitId, ledgerUnit))) {
        throw new Error('BLOCKED: 流水明细缺少正式 baseQty/baseUnitId 或方向快照')
      }
      ledgerUnits.set(key, entry.baseUnitId)
      ledger.set(key, (ledger.get(key) || 0) + quantity(entry.baseQty) * (text(entry.stockIoDirection) === '1' ? 1 : -1))
    }
  }
  const actualProjection = before.flow.map((row) => {
    const direction = text(row.stockIoDirection)
    const inQty = quantity(row.inQty)
    const outQty = quantity(row.outQty)
    // The report DTO exposes business-unit in/out quantities, not qty or baseQty.
    if (!['1', '2'].includes(direction) || !stableId(row.unitId) ||
        !Number.isFinite(inQty) || !Number.isFinite(outQty) ||
        (direction === '1' ? outQty !== 0 : inQty !== 0)) {
      throw new Error('QC003 正式流水入出数量与方向不一致')
    }
    return flowProjection(row, direction === '1' ? inQty : outQty)
  }).sort()
  const rowsMatch = isDeepStrictEqual(projected.sort(), actualProjection)
  const keys = new Set([...ledger.keys(), ...inventoryByDimension.keys()])
  const balances = [...keys].sort().map((key) => ({
    dimension: JSON.parse(key), ledgerQty: ledger.get(key) || 0,
    inventoryQty: inventoryByDimension.get(key)?.qty || 0
  }))
  const balanced = balances.every((row) => Math.abs(row.ledgerQty - row.inventoryQty) < 0.000001)
  caseRecord.qc003BalanceEvidence = {
    rowsMatch, balanced, balances, normalizedDimensions,
    defaultStorage: [...defaultStorage.values()].map(({ resolved }) => resolved)
  }
  for (const { entry, resolved } of defaultStorage.values()) {
    const current = await readQc003DefaultStorage(api, fixture, entry)
    if (!isDeepStrictEqual(resolved, current)) throw new Error('QC003 流水对账期间正式默认库区/库位配置变化')
  }
  const after = await readQc003Facts(api, caseRecord, fixture, inbound.wms.id, dependencies)
  assertQc003Unchanged(caseRecord, '流水余额查询不改变管理员 API/SQL 完整事实', before, after)
  addCheck(caseRecord, '正式 report/view 流水逐行匹配主单明细与方向', rowsMatch, `rows=${before.flow.length}`)
  addCheck(caseRecord, '正式 report/view 有效流水与库存完整物理维度余额一致', balanced,
    `dimensions=${keys.size}; 已生效未作废；按 baseQty/baseUnitId 快照对账；` +
    `mismatches=${JSON.stringify(balances.filter((row) => Math.abs(row.ledgerQty - row.inventoryQty) >= 0.000001))}`)
  if (!rowsMatch || !balanced) throw new Error('QC003 正式流水与明细/库存余额不一致')
  if (normalizedDimensions.length) {
    addEvidence(caseRecord,
      `WMS 默认库区/库位归一化 ${normalizedDimensions.length} 条：仅按正式配置与本轮唯一启用库区/库位补齐来源空维度；` +
      '未修改 API、SQL 或库存事实源。')
  }
  addEvidence(caseRecord, '流水事实源=/mes/stk/report/view/list（单据视图）；未查询臆造 inventory_flow，也未用 adjust_log 冒充全部流水。')
  addGap(caseRecord, 'immutable-flow',
    'report/view/list 已完成单据流水与余额对账，但它是可变单据视图；原 reverse「保留不可变流水，按业务冲销恢复」未验证，不升级该反向要求。',
    'BLOCKED', [qc003Sources.flow])
  return { verified: true, rowsMatch, balanced }
}

const qc003StockBody = (fixture, billNo, batchNo, type, quantities) => ({
  billNo, billDate: nowDate(), subject: fixture.marker, remark: fixture.marker, stockIoType: type, isAuto: 0,
  stkIoEntryList: quantities.map((qty, index) => ({
    materialId: requireId(fixture.material.id, 'QC003 事务物料'),
    unitId: requireId(fixture.material.unitId, 'QC003 事务单位'),
    warehouseId: requireId(fixture.warehouse.id, 'QC003 事务仓库'),
    wareAreaId: requireId(fixture.area.id, 'QC003 事务库区'),
    wareLocationId: requireId(fixture.location.id, 'QC003 事务库位'),
    qty, cost: 1, settleQty: qty, batchNo, entryNo: index + 1, isQc: 0,
    stockIoType: type, stockIoDirection: type === '106' ? '1' : '2', remark: fixture.marker
  })),
  stkIoDistributionList: [], stkIoBomList: []
})

const qc003EditPayload = (body, state) => {
  const { main, entries } = state
  const hasVersion = (value) => typeof value === 'string' ? /^\d+$/.test(value)
    : Number.isSafeInteger(value) && value >= 0
  if (!['12', '14'].includes(text(main.billStage)) || main.actions?.edit !== true ||
      !hasVersion(main.version) || !['isEffective', 'isClosed', 'isVoided', 'isAuto']
        .every((key) => text(main[key]) === '0') || main.billNo !== body.billNo ||
      main.remark !== body.remark || main.subject !== body.subject) {
    throw new Error('BLOCKED: QC003 编辑提交缺少正式草稿状态、版本或本轮所有权，未发送 PUT')
  }
  // submitEdit checks the request state before loading the persisted bill.
  const payload = { ...body, id: requireId(main.id, 'QC003 草稿') }
  for (const key of ['billStage', 'version', 'isEffective', 'isClosed', 'isVoided', 'isAuto']) {
    payload[key] = main[key]
  }
  payload.stkIoEntryList = body.stkIoEntryList.map((line) => {
    const matches = entries.filter((entry) => text(entry.entryNo) === text(line.entryNo))
    const entry = matches[0]
    if (matches.length !== 1 || !stableId(entry?.id) || !sameId(entry.mid, main.id) ||
        !hasVersion(entry.version)) {
      throw new Error('BLOCKED: QC003 编辑提交缺少正式明细身份或版本，未发送 PUT')
    }
    return { ...line, id: String(entry.id), mid: String(entry.mid), version: entry.version }
  })
  return payload
}

export async function verifyWmsQcTransactionRollback (api, caseRecord, fixture, inbound, dependencies = {}) {
  qc003Scope(caseRecord, fixture)
  const digest = createHash('sha256').update(fixture.marker).digest('hex').slice(0, 16)
  const batchNo = `E2E-RB-${digest}`
  const openingBody = qc003StockBody(fixture, `E2E-RB-${digest}-106`, batchNo, '106', [10])
  const billNo = `E2E-RB-${digest}-299`
  const body = qc003StockBody(fixture, billNo, batchNo, '299', [6, 6])
  if ((await inventorySnapshot(api, fixture, fixture.material.id)).some((row) => row.batchNo === batchNo) ||
      (await readAll(api, `/mes/stkIo/list?billNo=${billNo}`, '事务探针单')).length) {
    throw new Error('BLOCKED: QC003 回滚批次或单号已存在，不复用历史余额')
  }
  const openingId = requireApiSuccessId(await api.postBusiness('/mes/stkIo/add/submit', openingBody), 'QC003 正式期初')
  remember(caseRecord, { kind: 'opening', id: openingId, marker: fixture.marker, token: fixture.token,
    body: openingBody, retained: true })
  let opening = (await readStockState(api, fixture, openingId)).main
  if (!isEffectiveBill(opening) && opening.actions?.check === true) {
    requireSuccess(await api.putBusiness('/mes/stkIo/check', {
      id: openingId, approvalResultType: '1', approvalRemark: `${fixture.marker} rollback opening`
    }), 'QC003 期初审核')
    opening = (await readStockState(api, fixture, openingId)).main
  }
  if (opening.actions?.execute === true) {
    requireSuccess(await api.putBusiness('/mes/stkIo/execute', { id: openingId }), 'QC003 期初执行')
  }
  const seeded = await readStockState(api, fixture, openingId)
  const seed = seeded.inventory.filter((row) => row.batchNo === batchNo)
  if (!isEffectiveBill(seeded.main) || seed.length !== 1 || !inventoryConserved(seed[0]) ||
      quantity(seed[0].qty) !== 10 || quantity(seed[0].availableQty) !== 10 ||
      !sameId(seed[0].unitId, fixture.material.unitId) ||
      seeded.entries.length !== 1 || quantity(seeded.entries[0].baseQty) !== 10 ||
      !sameId(seeded.entries[0].baseUnitId, seed[0].unitId)) {
    throw new Error('BLOCKED: QC003 正式期初未形成独立可用量10及单位快照；不改审批/自动执行策略')
  }
  requireSuccess(await api.postBusiness('/mes/stkIo/add/save', body), 'QC003 两行其他出库草稿')
  const drafts = await readAll(api, `/mes/stkIo/list?billNo=${billNo}`, 'QC003 两行草稿回读')
  if (drafts.length !== 1 || drafts[0].billNo !== billNo) throw new Error('BLOCKED: QC003 草稿单号回读不唯一')
  const id = requireId(drafts[0].id, 'QC003 两行草稿')
  remember(caseRecord, { kind: 'stockIo', id, marker: fixture.marker, token: fixture.token, body, retained: true })
  const read = () => readQc003Facts(api, caseRecord, fixture, id, dependencies, billNo)
  let before = await read()
  const validEntries = (state) => state.stock.entries.length === 2 &&
    new Set(state.stock.entries.map((entry) => text(entry.entryNo))).size === 2 &&
    state.stock.entries.every((entry) => ['1', '2'].includes(text(entry.entryNo)) &&
      entry.batchNo === batchNo && quantity(entry.qty) === 6 && quantity(entry.baseQty) === 6 &&
      sameId(entry.baseUnitId, seed[0].unitId) && text(entry.stockIoDirection) === '2' &&
      !text(entry.inStockTime) && stockDimension(entry) === stockDimension(seed[0]))
  if (text(before.stock.main.stockIoType) !== '299' || before.stock.main.billNo !== billNo ||
      !validEntries(before) || before.stock.main.actions?.edit !== true) {
    throw new Error('BLOCKED: QC003 两行草稿维度、单位或可编辑状态不满足真实回滚前提')
  }
  const messages = [1, 2].map((entryNo) =>
    `【分录号：${entryNo}】“仓库+存货+批次号”的库存数不足！仓库=${fixture.warehouse.id} ` +
    `存货=${fixture.material.id} 批次=${batchNo} 本次变动后现存量=-2，已拒绝负库存写入。`)
  const reservationMessage = `可用库存不足，无法提审：可用量=4，本次占用=6（存货=${fixture.material.id} 批次=${batchNo}）`
  const requests = [
    ['/mes/stkIo/edit/submit', 'edit'],
    ['/mes/stkIo/check', 'check'],
    ['/mes/stkIo/execute', 'execute']
  ]
  for (const [path, action] of requests) {
    if (before.stock.main.actions?.[action] !== true) continue
    if (!validEntries(before) ||
        !['isClosed', 'isVoided'].every((key) => text(before.stock.main[key]) === '0')) break
    const payload = action === 'edit' ? qc003EditPayload(body, before.stock)
      : action === 'check'
        ? { id, approvalResultType: '1', approvalRemark: `${fixture.marker} rollback negative` }
        : { id }
    caseRecord.qc003RollbackRequests ||= []
    caseRecord.qc003RollbackRequests.push({
      path, id, billStage: before.stock.main.billStage, version: before.stock.main.version,
      isEffective: before.stock.main.isEffective,
      entryVersions: before.stock.entries.map((entry) => ({ id: entry.id, version: entry.version }))
    })
    const expected = serviceRejection(new RegExp(`^(?:${[
      ...messages, reservationMessage, billStateRejection(before.stock.main, '事务探针').message
    ].map((message) => message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`))
    const response = await api.put(path, payload, { expectedBusinessRejection: expected })
    const after = await read()
    const exact = messages.some((message) => exactStateRejection(response, serviceRejection(message)))
    if (exact) {
      assertQc003Unchanged(caseRecord, '两明细合计不足拒绝后主单明细库存流水及 SQL 全部回滚', before, after)
      addCheck(caseRecord, '两明细各自足量但合计不足触发库存循环中途精确拒绝', true,
        `path=${path}; bill=${id}; baseline=10; lines=6+6; code=${response.code}; ${response.msg || response.message}`)
      addEvidence(caseRecord, '同维度两条6、余额10：任意处理顺序均先写一行，再于后处理行产生-2；不是非法物料前置校验。')
      return { verified: true, id, path }
    }
    if (!isBusinessSuccess(response)) {
      if (exactStateRejection(response, serviceRejection(reservationMessage))) {
        assertQc003Unchanged(caseRecord, '两行提审占用不足拒绝后完整事实不变', before, after)
        addGap(caseRecord, 'post-persist-rollback',
          `正式 ${path} 在提审占用门禁拒绝：${reservationMessage}；占用回滚不能替代执行扣减中途回滚。`,
          'BLOCKED', [qc003Sources.stock])
        return { verified: false, id }
      }
      if (exactStateRejection(response, billStateRejection(before.stock.main, '事务探针'))) {
        assertQc003Unchanged(caseRecord, '事务状态前置拒绝后完整事实不变', before, after)
        addGap(caseRecord, 'post-persist-rollback', `正式 ${path} 在状态前置门禁拒绝，未到逐行扣减；${response.msg || response.message}`,
          'BLOCKED', [qc003Sources.stock])
        return { verified: false }
      }
      throw new Error(`QC003 回滚负例非契约失败：${path}; ${response?.code}/${response?.msg || response?.message || ''}`)
    }
    const pendingExecution = isEffectiveBill(after.stock.main) &&
      ['14', '24'].includes(text(after.stock.main.billStage)) &&
      after.stock.main.actions?.execute === true &&
      ['isClosed', 'isVoided'].every((key) => text(after.stock.main[key]) === '0')
    if (!isDeepStrictEqual(before.stock.inventory, after.stock.inventory) ||
        !isDeepStrictEqual(before.persisted.inventory, after.persisted.inventory) ||
        !isDeepStrictEqual(before.persisted.adjustments, after.persisted.adjustments) ||
        (isEffectiveBill(after.stock.main) && !pendingExecution) || !validEntries(after)) {
      addCheck(caseRecord, '不足库存不得形成成功执行或部分扣减', false, `path=${path}; bill=${id}`)
      throw new Error('QC003 合计不足却成功扣减或改变库存事实')
    }
    before = after
  }
  addGap(caseRecord, 'post-persist-rollback',
    `两行其他出库 ${id} 停在 stage=${before.stock.main.billStage}/effective=${before.stock.main.isEffective}；` +
    '现有审批链未提供合法 check/execute，未更改流程或自动执行配置。',
    'BLOCKED', [qc003Sources.stock])
  return { verified: false, id }
}

export async function verifyWmsAtp (api, caseRecord, { orderId, materialId }) {
  requireId(orderId, 'ATP 销售订单')
  requireId(materialId, 'ATP 物料')
  const read = async () => {
    const inventory = await inventorySnapshot(api, null, materialId)
    const transfers = await readAll(api, '/wms/transfer-bill/page?transferStatus=IN_TRANSIT', 'ATP 在途调拨')
    let inTransit = 0
    const sourceIds = []
    for (const transfer of transfers) {
      const detail = requireSuccess(await api.getBusiness(
        `/wms/transfer-bill/get?id=${encodeURIComponent(transfer.id)}`), 'ATP 在途明细')
      if (detail?.transferStatus !== 'IN_TRANSIT' || !Array.isArray(detail.lines)) {
        throw new Error('ATP 调拨状态或明细不完整')
      }
      for (const line of detail.lines.filter((row) => sameId(row.materialId, materialId))) {
        const remaining = quantity(line.qty) - quantity(line.inPostedQty)
        if (!Number.isFinite(remaining) || remaining < 0) throw new Error('ATP 在途数量无效')
        inTransit += remaining
        sourceIds.push(String(transfer.id))
      }
    }
    return { inventory, inTransit, sourceIds }
  }
  const before = await read()
  const order = requireSuccess(await api.getBusiness(`/erp/sale-order/get?id=${encodeURIComponent(orderId)}`), 'ATP 销售订单回读')
  if (!sameId(order?.id, orderId) || !Array.isArray(order.items)) {
    throw new Error('BLOCKED: ATP 正式销售订单主键或明细不完整')
  }
  const lines = order.items.filter((row) => sameId(row.productId, materialId))
  const after = await read()
  const available = before.inventory.reduce((sum, row) => sum + quantity(row.availableQty), 0)
  const reserved = before.inventory.reduce((sum, row) => sum + quantity(row.lockQty), 0)
  const passed = before.inventory.length > 0 && lines.length > 0 &&
    lines.every((row) => stableId(row.id)) &&
    isDeepStrictEqual(before, after) &&
    lines.every((row) => Number.isFinite(quantity(row.stockCount)) &&
      Math.abs(quantity(row.stockCount) - available - before.inTransit) < 0.000001)
  addCheck(caseRecord, '销售订单 ATP 等于 WMS 可用量加正式调拨在途且查询不写库存', passed,
    `order=${orderId}; material=${materialId}; available=${available}; reserved=${reserved}; inTransit=${before.inTransit}`)
  if (reserved > 0 && before.inTransit > 0) {
    addCheck(caseRecord, 'ATP 正数预留及在途对照且未二次扣减 lockQty', passed,
      `reserved=${reserved}; inTransit=${before.inTransit}; transfers=${before.sourceIds.join(',')}`)
  } else {
    addGap(caseRecord, 'atp-components', 'ATP 查询已接线，但必须另有正数 lockQty 与 IN_TRANSIT 样本，零分量不能证明预留和在途。',
      'DEFERRED', ['WmsStockQueryApiImpl.java:274-318'])
  }
  return { passed, available, reserved, inTransit: before.inTransit }
}

export function buildPurchaseOrderPayload ({ marker, supplierId, materialId, unitId, billNo = `${marker}-PO` }) {
  if (![supplierId, materialId, unitId].every(stableId)) {
    throw new Error('BLOCKED: 采购订单夹具缺少稳定供应商、物料或单位 ID')
  }
  return {
    type: 0,
    supplierId: String(supplierId),
    orderTime: nowDateTime(),
    billDate: nowDate(),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: defaultQty,
    totalProductPrice: defaultMoney,
    totalTaxPrice: 0,
    totalPrice: defaultMoney,
    settleMethodCode: '1',
    directCreate: 1,
    directCreateReason: `${marker} formal WMS-QC purchase order`,
    billNo,
    remark: marker,
    items: [{
      entryNo: 1,
      productId: String(materialId),
      productUnitId: String(unitId),
      productPrice: defaultMoney,
      count: defaultQty,
      taxPercent: 0,
      totalPrice: defaultMoney,
      taxPrice: 0,
      remark: marker
    }]
  }
}

export function buildPurchaseInboundPayload ({
  marker, supplierId, purchaseOrderId, orderItemId, materialId, unitId, warehouseId, accountId,
  quantity = defaultQty
}) {
  if (![supplierId, purchaseOrderId, orderItemId, materialId, unitId, warehouseId, accountId].every(stableId)) {
    throw new Error('BLOCKED: 采购入库夹具缺少正式采购订单、结算账户、仓库或物料 ID')
  }
  return {
    inTime: nowDateTime(),
    businessType: 'NORMAL',
    supplierId: String(supplierId),
    orderId: String(purchaseOrderId),
    accountId: String(accountId),
    discountPercent: 0,
    otherPrice: 0,
    remark: marker,
    items: [{
      orderItemId: String(orderItemId),
      warehouseId: String(warehouseId),
      productId: String(materialId),
      productUnitId: String(unitId),
      productPrice: defaultMoney,
      count: quantity,
      taxPercent: 0,
      remark: marker
    }]
  }
}

export function buildPurchaseReturnPayload ({
  marker, supplierId, purchaseOrderId, orderItemId, materialId, unitId, warehouseId, areaId, locationId,
  accountId, batchNo, billNo = `${marker}-PR`
}) {
  if (![supplierId, purchaseOrderId, orderItemId, materialId, unitId, warehouseId, areaId, locationId, accountId].every(stableId)) {
    throw new Error('BLOCKED: 采购退货夹具缺少正式采购订单、结算账户、库存维度或物料 ID')
  }
  const resolvedBatchNo = resolveReturnBatchNo(batchNo, marker, 'PR')
  return {
    billNo,
    billDate: nowDate(),
    srcBillId: String(purchaseOrderId),
    srcBillType: 'PurOrder',
    supplierId: String(supplierId),
    returnTime: nowDateTime(),
    returnType: 2,
    accountId: String(accountId),
    discountPercent: 0,
    otherPrice: 0,
    remark: marker,
    items: [{
      entryNo: 1,
      srcBillType: 'PurOrder',
      srcBillId: String(purchaseOrderId),
      srcEntryId: String(orderItemId),
      warehouseId: String(warehouseId),
      areaHouseId: String(areaId),
      wareLocationId: String(locationId),
      productId: String(materialId),
      productUnitId: String(unitId),
      productPrice: defaultMoney,
      count: defaultQty,
      taxPercent: 0,
      batchNo: resolvedBatchNo,
      totalPrice: defaultMoney,
      productTotalPrice: defaultMoney,
      productTaxPrice: 0,
      taxPrice: 0,
      remark: marker
    }]
  }
}

export function buildSaleOrderPayload ({ marker, customerId, materialId, unitId, billNo = `${marker}-SO` }) {
  if (![customerId, materialId, unitId].every(stableId)) {
    throw new Error('BLOCKED: 销售订单夹具缺少稳定客户、物料或单位 ID')
  }
  return {
    customerId: String(customerId),
    orderTime: nowDateTime(),
    saleTypeCode: 'NORMAL',
    discountPercent: 0,
    depositPrice: 0,
    totalPrice: defaultMoney,
    billNo,
    remark: marker,
    items: [{
      productId: String(materialId),
      productUnitId: String(unitId),
      count: defaultQty,
      productPrice: defaultMoney,
      taxPercent: 0,
      totalPrice: defaultMoney,
      remark: marker
    }]
  }
}

export function buildSaleReturnPayload ({
  marker, customerId, saleOrderId, orderItemId, materialId, unitId, warehouseId, areaId, locationId,
  accountId, batchNo, billNo = `${marker}-SR`
}) {
  if (![customerId, saleOrderId, orderItemId, materialId, unitId, warehouseId, areaId, locationId, accountId].every(stableId)) {
    throw new Error('BLOCKED: 销售退货夹具缺少正式销售订单、结算账户、库存维度或物料 ID')
  }
  const resolvedBatchNo = resolveReturnBatchNo(batchNo, marker, 'SR')
  return {
    billNo,
    billDate: nowDate(),
    srcBillId: String(saleOrderId),
    srcBillType: 'SalOrder',
    customerId: String(customerId),
    returnTime: nowDateTime(),
    returnType: 2,
    accountId: String(accountId),
    discountPercent: 0,
    otherPrice: 0,
    remark: marker,
    items: [{
      entryNo: 1,
      srcBillType: 'SalOrder',
      srcBillId: String(saleOrderId),
      srcEntryId: String(orderItemId),
      warehouseId: String(warehouseId),
      areaHouseId: String(areaId),
      wareLocationId: String(locationId),
      productId: String(materialId),
      productUnitId: String(unitId),
      productPrice: defaultMoney,
      count: defaultQty,
      taxPercent: 0,
      batchNo: resolvedBatchNo,
      totalPrice: defaultMoney,
      productTotalPrice: defaultMoney,
      productTaxPrice: 0,
      taxPrice: 0,
      remark: marker
    }]
  }
}

const getFirst = async (api, paths, label) => {
  let lastError
  for (const path of paths) {
    try {
      const rows = pageRows(await api.getBusiness(path), label)
      const row = rows.find((item) => stableId(item?.id))
      if (row) return row
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`BLOCKED: ${label}没有可用正式主数据${lastError ? `：${lastError.message}` : ''}`)
}

const createPartner = async (api, caseRecord, marker, role) => {
  const body = {
    name: `${marker}-${role}`,
    shortName: `${marker}-${role}`.slice(0, 20),
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    supplierEnabled: role === 'SUPPLIER' || role === 'BOTH',
    customerEnabled: role === 'CUSTOMER' || role === 'BOTH',
    carrierEnabled: false,
    remark: marker
  }
  const id = requireApiSuccessId(
    await api.postBusiness('/base/partner/create', body),
    `WMS-QC ${role}专属客商`
  )
  remember(caseRecord, { kind: 'partner', id, role, marker, body, retained: false })
  const row = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(id)}`))
  if (!row || !sameId(row.id, id) || !isOwnedFixture(row, marker)) {
    throw new Error(`WMS-QC ${role}专属客商所有权回读失败：${id}`)
  }
  return row
}

const readAccount = async (api) => getFirst(api, [
  '/erp/account/page?pageNo=1&pageSize=100&status=0',
  '/erp/account/page?pageNo=1&pageSize=100'
], '结算账户')

const readSourceWmsBill = async (api, sourceType, sourceId) => {
  const rows = pageRows(await api.getBusiness(
    `/mes/stkIo/list?pageNo=1&pageSize=100&srcBillType=${encodeURIComponent(sourceType)}&srcBillId=${encodeURIComponent(sourceId)}`
  ), `WMS ${sourceType}来源单`)
  const row = rows.find((item) => sameId(item?.srcBillId, sourceId) && text(item?.srcBillType) === sourceType)
  if (!row?.id) throw new Error(`BLOCKED: 正式 ${sourceType}/${sourceId} 未回读 WMS 来源单`)
  return dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(row.id)}`))
}

const executeWmsStockBillWhenNeeded = async (
  api, caseRecord, fixture, saleOut, wmsId, baseline
) => {
  requireOwnedStockDimensions(caseRecord, fixture)
  const id = requireId(wmsId, 'WMS 执行单据')
  const owned = (caseRecord.fixtures || []).some((row) =>
    row.kind === 'saleOut' && sameId(row.id, saleOut.id) && row.marker === fixture.marker)
  const erp = requireSuccess(await api.getBusiness(
    `/erp/sale-out/get?id=${encodeURIComponent(saleOut.id)}`), '销售出库执行来源回读')
  const item = erp?.items?.[0]
  const qty = quantity(saleOut.payload?.items?.[0]?.count)
  if (!owned || !sameId(erp?.id, saleOut.id) || !isOwnedFixture(erp, fixture.marker) ||
      quantity(erp.status) !== 20 || erp.items?.length !== 1 ||
      !stableId(item?.id) || !sameId(item.productId, fixture.material.id) ||
      !sameId(item.warehouseId, fixture.warehouse.id) || quantity(item.count) !== qty ||
      !Number.isFinite(qty) || qty <= 0 || !Array.isArray(baseline) || !baseline.length ||
      baseline.some((row) => !sameId(row.materialId, fixture.material.id) ||
        !sameId(row.warehouseId, fixture.warehouse.id) || !inventoryConserved(row)) ||
      inventoryTotals(baseline).availableQty < qty) {
    throw new Error('BLOCKED: WMS201 必须基于本轮正式销售出库和完整可用库存前态')
  }

  const assertSource = (state) => {
    if (text(state.main.stockIoType) !== '201' ||
        text(state.main.srcBillType) !== 'ErpSaleOut' || !sameId(state.main.srcBillId, saleOut.id) ||
        text(state.main.isVoided) !== '0' || state.entries.length !== 1 ||
        text(state.entries[0].srcBillType) !== 'ErpSaleOut' ||
        !sameId(state.entries[0].srcBillId, saleOut.id) ||
        !sameId(state.entries[0].srcEntryId, item.id) ||
        text(state.entries[0].stockIoDirection) !== '2' ||
        quantity(state.entries[0].qty) !== qty) {
      throw new Error('BLOCKED: WMS201 来源、明细或正式出库数量不匹配')
    }
  }
  const executed = (state) => isEffectiveBill(state.main) &&
    ['32', '34'].includes(text(state.main.billStage)) &&
    state.entries.every((entry) => text(entry.inStockTime) !== '')
  const before = await readStockState(api, fixture, id)
  assertSource(before)
  let state = before
  let checkCalled = false
  let executeCalled = false
  if (!executed(state) && !isEffectiveBill(state.main) && state.main.actions?.check === true) {
    if (text(state.main.billStage) !== '14') {
      throw new Error('BLOCKED: WMS201 check 动作与正式核批阶段不一致')
    }
    requireSuccess(await api.putBusiness('/mes/stkIo/check', {
      id,
      approvalResultType: '1',
      approvalRemark: 'E2E WMS-QC formal WMS201 audit'
    }), 'WMS201 正式核批')
    checkCalled = true
    state = await readStockState(api, fixture, id)
    assertSource(state)
  }
  if (!executed(state)) {
    if (state.main.actions?.execute !== true) {
      addGap(caseRecord, 'wms201-execute-action',
        `WMS201 ${id} 尚未执行且无正式 execute 动作；` +
        `billStage=${state.main.billStage}; isEffective=${state.main.isEffective}`,
        'GAP', WMS_QC_SOURCE_CONTRACTS.wmsManualExecute.sources)
      throw new Error(`BLOCKED: WMS201 未生效且没有正式 execute 动作：${id}`)
    }
    requireSuccess(await api.putBusiness('/mes/stkIo/execute', { id }),
      'WMS201 正式执行')
    executeCalled = true
    state = await readStockState(api, fixture, id)
    assertSource(state)
  }
  const effective = executed(state)
  addCheck(caseRecord, 'WMS201 来源单经正式 check/execute 生效并回写库存',
    effective,
    `wms=${id}; check=${checkCalled}; execute=${executeCalled}; ` +
    `billStage=${state.main.billStage}; isEffective=${state.main.isEffective}`)
  if (!effective) throw new Error(`BLOCKED: WMS201 正式 execute 后仍未生效：${id}`)
  const initial = inventoryTotals(baseline)
  const final = inventoryTotals(state.inventory)
  const deducted = final.availableQty === initial.availableQty - qty &&
    final.qty === initial.qty - qty && final.holdQty === initial.holdQty &&
    final.pendingPutawayQty === initial.pendingPutawayQty && final.frozenQty === initial.frozenQty
  addCheck(caseRecord, '正式销售出库后专属可用库存按行扣减', deducted,
    `wms=${id}; before=${initial.availableQty}; after=${final.availableQty}; quantity=${qty}; ` +
    `beforeQty=${initial.qty}; afterQty=${final.qty}`)
  caseRecord.outboundExecutionEvidence ||= []
  caseRecord.outboundExecutionEvidence.push({
    sourceBillId: id, saleOutId: String(saleOut.id), checkCalled, executeCalled,
    baseline: structuredClone(baseline), before: structuredClone(before), after: structuredClone(state)
  })
  if (!deducted) throw new Error('WMS201 正式执行后未产生本轮专属库存扣减')
  return { detail: state.main, after: state.inventory, checkCalled, executeCalled }
}

const readSourceEntries = async (api, wmsId) => {
  const data = requireSuccess(await api.getBusiness(
    `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(wmsId)}`
  ), 'WMS 来源明细')
  if (!Array.isArray(data) || data.length === 0) throw new Error(`BLOCKED: WMS 来源单 ${wmsId} 没有明细`)
  return data
}

const approveWhenNeeded = async (
  api, getPath, statusPath, id, label, approvedStatus = 20, submitStatus = approvedStatus
) => {
  let detail = requireSuccess(await api.getBusiness(`${getPath}?id=${encodeURIComponent(id)}`), label)
  if (!sameId(detail?.id, id)) throw new Error(`BLOCKED: ${label}回读 ID 不匹配：${id}`)
  if (Number(detail.status) !== approvedStatus && !isEffectiveBill(detail)) {
    requireSuccess(await api.putBusiness(`${statusPath}?id=${encodeURIComponent(id)}&status=${submitStatus}`),
      `${label}审批`)
    detail = requireSuccess(await api.getBusiness(`${getPath}?id=${encodeURIComponent(id)}`), label)
  }
  if (!sameId(detail?.id, id) || (Number(detail.status) !== approvedStatus && !isEffectiveBill(detail))) {
    throw new Error(`BLOCKED: ${label}审批后未形成可确认的正式生效状态：${id}`)
  }
  return detail
}

const createPurchaseOrder = async (api, caseRecord, fixture, supplier, material) => {
  const payload = buildPurchaseOrderPayload({
    marker: fixture.marker,
    supplierId: supplier.id,
    materialId: material.id,
    unitId: material.unitId,
    billNo: `${fixture.marker}-PO`
  })
  const owned = remember(caseRecord, {
    kind: 'purchaseOrder', marker: fixture.marker, payload, retained: false, createAttempted: true
  })
  const id = requireApiSuccessId(await api.postBusiness('/erp/purchase-order/create', payload), '专属采购订单')
  owned.id = id
  const detail = await approveWhenNeeded(
    api,
    '/erp/purchase-order/get',
    '/erp/purchase-order/update-status',
    id,
    '专属采购订单',
    20,
    10
  )
  const item = detail?.items?.[0]
  if (!item?.id || !isOwnedFixture(detail, fixture.marker)) {
    throw new Error(`BLOCKED: 专属采购订单明细/所有权回读失败：${id}`)
  }
  addCheck(caseRecord, '正式采购订单创建、审核和明细来源回读', true,
    `orderId=${id}; itemId=${item.id}; billNo=${detail.billNo || ''}`)
  return { id, detail, item }
}

const createSubmittedPurchaseArrivalNotice = async (api, caseRecord, fixture, order, inboundPayload) => {
  const source = inboundPayload.items[0]
  const ownedOrder = (caseRecord.fixtures || []).some((item) =>
    item.kind === 'purchaseOrder' && sameId(item.id, order.id) && item.marker === fixture.marker)
  if (!text(fixture.marker) || !ownedOrder || !sameId(order.id, inboundPayload.orderId) ||
      !sameId(order.item?.id, source.orderItemId)) {
    throw new Error('BLOCKED: ASN 必须基于本轮已登记的专属采购订单和明细')
  }
  const currentOrder = requireSuccess(await api.getBusiness(
    `/erp/purchase-order/get?id=${encodeURIComponent(order.id)}`), 'ASN 采购订单来源回读')
  const orderItem = currentOrder?.items?.[0]
  if (!sameId(currentOrder?.id, order.id) || currentOrder.remark !== fixture.marker ||
      quantity(currentOrder.status) !== 20 || !text(currentOrder.billNo) ||
      !sameId(currentOrder.supplierId, inboundPayload.supplierId) ||
      currentOrder.items?.length !== 1 || !sameId(orderItem?.id, source.orderItemId) ||
      !sameId(orderItem.productId, source.productId) ||
      !sameId(orderItem.productUnitId, source.productUnitId) ||
      !Number.isFinite(quantity(orderItem.count)) || quantity(orderItem.count) < quantity(source.count)) {
    throw new Error('BLOCKED: ASN 采购订单所有权、审核状态或来源明细不匹配')
  }
  const code = `${fixture.marker}-ASN`
  const payload = {
    code,
    name: code,
    purchaseOrderId: String(order.id),
    purchaseOrderCode: currentOrder.billNo,
    vendorId: inboundPayload.supplierId,
    supplierShipmentKey: `${code}-SHIP`,
    supplierShipmentNo: `${code}-NO`,
    arrivalDate: nowDateTime(),
    shippedAt: nowDateTime(),
    remark: fixture.marker,
    lines: [{
      itemId: source.productId,
      purchaseOrderItemId: source.orderItemId,
      arrivalQuantity: source.count,
      iqcCheckFlag: true,
      unitId: source.productUnitId,
      batchNo: fixture.marker,
      remark: fixture.marker
    }]
  }
  const owned = remember(caseRecord, {
    kind: 'arrivalNotice', marker: fixture.marker, payload, retained: false, createAttempted: true
  })
  const id = requireApiSuccessId(await api.postBusiness('/mes/wms/arrival-notice/create', payload),
    '专属采购 ASN 创建')
  owned.id = id
  const readNotice = async (statuses, label) => {
    const detail = requireSuccess(await api.getBusiness(
      `/mes/wms/arrival-notice/get?id=${encodeURIComponent(id)}`), label)
    const line = detail?.lines?.[0]
    if (!sameId(detail?.id, id) || detail.code !== code || detail.remark !== fixture.marker ||
        !sameId(detail.purchaseOrderId, order.id) ||
        detail.purchaseOrderCode !== currentOrder.billNo ||
        !sameId(detail.vendorId, payload.vendorId) ||
        detail.supplierShipmentKey !== payload.supplierShipmentKey ||
        !statuses.includes(text(detail.status)) || detail.lines?.length !== 1 ||
        !stableId(line?.id) || !sameId(line.purchaseOrderItemId, source.orderItemId) ||
        !sameId(line.itemId, source.productId) || !sameId(line.unitId, source.productUnitId) ||
        quantity(line.arrivalQuantity) !== quantity(source.count) || line.iqcCheckFlag !== true) {
      throw new Error(`BLOCKED: ${label}状态、所有权或采购来源关联不匹配：${id}`)
    }
    return structuredClone(detail)
  }
  const draft = await readNotice(['0'], '专属采购 ASN 草稿回读')
  requireSuccess(await api.postBusiness(`/mes/wms/arrival-notice/submit?id=${encodeURIComponent(id)}`),
    '专属采购 ASN 提交')
  const detail = await readNotice(['10', '20', '30'], '专属采购 ASN 提交后回读')
  caseRecord.purchaseArrivalEvidence ||= []
  caseRecord.purchaseArrivalEvidence.push({
    noticeId: id, purchaseOrderId: String(order.id), orderItemId: source.orderItemId,
    payload: structuredClone(payload), draft, submitted: structuredClone(detail)
  })
  addCheck(caseRecord, '本轮采购订单正式 ASN 创建、提交和来源明细回读', true,
    `order=${order.id}; orderItem=${source.orderItemId}; asn=${id}; line=${detail.lines[0].id}; status=${detail.status}`)
  return { id, detail, payload }
}

const createPurchaseInbound = async (api, caseRecord, fixture, supplier, material, order, account) => {
  const payload = buildPurchaseInboundPayload({
    marker: fixture.marker,
    supplierId: supplier.id,
    purchaseOrderId: order.id,
    orderItemId: order.item.id,
    materialId: material.id,
    unitId: material.unitId,
    warehouseId: fixture.warehouse.id,
    accountId: account.id
  })
  const arrival = await createSubmittedPurchaseArrivalNotice(api, caseRecord, fixture, order, payload)
  const owned = remember(caseRecord, {
    kind: 'purchaseInbound', marker: fixture.marker, payload, retained: false, createAttempted: true
  })
  const id = requireApiSuccessId(await api.postBusiness('/erp/purchase-in/create', payload), '正式采购入库')
  owned.id = id
  const assertInboundSource = (detail) => {
    const item = detail?.items?.[0]
    if (!sameId(detail?.id, id) || detail.remark !== fixture.marker ||
        text(detail.businessType) !== 'NORMAL' ||
        !sameId(detail.orderId, arrival.detail.purchaseOrderId) ||
        detail.orderNo !== arrival.detail.purchaseOrderCode ||
        !sameId(detail.supplierId, arrival.detail.vendorId) || detail.items?.length !== 1 ||
        !stableId(item?.id) || !sameId(item.orderItemId, arrival.detail.lines[0].purchaseOrderItemId) ||
        !sameId(item.productId, material.id) || !sameId(item.productUnitId, material.unitId) ||
        !sameId(item.warehouseId, fixture.warehouse.id) || quantity(item.count) !== defaultQty) {
      throw new Error(`BLOCKED: 正式采购入库与本轮 ASN 的订单、供应商或明细来源回读不匹配：${id}`)
    }
  }
  // Validate ownership before approving a source-generated stock document.
  assertInboundSource(requireSuccess(await api.getBusiness(
    `/erp/purchase-in/get?id=${encodeURIComponent(id)}`), '正式采购入库创建后来源回读'))
  const detail = await approveWhenNeeded(
    api,
    '/erp/purchase-in/get',
    '/erp/purchase-in/update-status',
    id,
    '正式采购入库'
  )
  assertInboundSource(detail)
  const wms = await readSourceWmsBill(api, WMS_QC_FORMAL_CONTRACTS.purchaseInbound.wmsSource, id)
  const entries = await readSourceEntries(api, wms.id)
  const entry = entries.find((item) => sameId(item?.materialId, material.id)) || entries[0]
  if (!entry?.id) throw new Error(`BLOCKED: 正式采购入库 WMS 明细缺失：${id}`)
  const linked = addCheck(caseRecord, '正式采购入库生成 101 WMS 来源单和明细', text(wms.stockIoType) === '101' &&
    text(wms.srcBillType) === 'ErpPurchaseIn' && sameId(wms.srcBillId, id) &&
    entries.length === 1 && sameId(entry.materialId, material.id) &&
    sameId(entry.mid, wms.id) && text(entry.srcBillType) === 'ErpPurchaseIn' &&
    sameId(entry.srcBillId, id) && sameId(entry.srcEntryId, detail.items[0].id),
  `purchaseIn=${id}; wms=${wms.id}; entry=${entry.id}; sourceEntry=${entry.srcEntryId}`)
  if (!linked) throw new Error(`正式采购入库 WMS 主单或明细来源关联不匹配：${id}`)
  addEvidence(caseRecord, `专属采购来源回读：ASN ${arrival.id}/${arrival.detail.lines[0].id} -> ` +
    `采购订单 ${detail.orderId}/${detail.items[0].orderItemId} -> ERP采购入库 ${id}/${detail.items[0].id} -> ` +
    `WMS ErpPurchaseIn ${wms.id}/${entry.id}；ERP入库契约无ASN外键，未伪造字段或另建WMS入库`)
  return { id, detail, payload, wms, entry, arrival }
}

const createQualityArtifacts = async (api, caseRecord, fixture, material, type = '101') => {
  if (type === '201') {
    requireOwnedStockDimensions(caseRecord, fixture)
    if (!sameId(material?.id, fixture.material.id)) {
      throw new Error('BLOCKED: 201 OQC 规则只能绑定本轮专属物料')
    }
  }
  const owned = remember(caseRecord, { kind: 'qualityArtifact', marker: fixture.marker,
    type, materialId: String(material.id), createAttempted: true, retained: true,
    reason: '正式质检方案及可能已创建的项目保留审计，不删除来源依赖' })
  const item = await createPublishedItem(api, caseRecord, {
    kind: 'WMSQC',
    itemType: type === '201' ? '销售出库检验项目' : '采购入库检验项目',
    standardBaseValue: 1
  })
  owned.itemId = item.itemId
  const plan = await createPlan(api, caseRecord, {
    kind: 'WMSQC',
    type: Number(type),
    itemId: item.itemId,
    itemSnapshot: item.row,
    planName: `${fixture.marker}-${type}-PLAN`,
    publish: true
  })
  owned.planId = plan.planId
  const rule = await createQualityMaterialRule(api, caseRecord, {
    materialId: material.id,
    planId: plan.planId,
    type,
    isDefault: true,
    priority: 999
  })
  owned.ruleId = rule.ruleId
  return { item, plan, rule }
}

const readOutboundInspections = async (api, fixture, wmsId, artifacts) => {
  const rows = await readAll(api,
    `/mes/quality/qualityInspection/list/dictText?srcBillId=${encodeURIComponent(wmsId)}&type=201`,
    '本轮 201 来源检验')
  if (!rows.length || rows.some((row) => !sameId(row.srcBillId, wmsId) ||
      text(row.type) !== '201' || !stockInspectionSource(row.srcBillType, '201'))) {
    throw new Error('BLOCKED: 201 来源检验缺失或包含其他来源')
  }
  const inspections = []
  for (const row of rows) {
    const id = requireId(row.id, '201 检验')
    const detail = requireSuccess(await api.getBusiness(inspectionPath(id)), '201 检验主单')
    const entries = canonicalRows(pageRows(await api.getBusiness(
      `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${id}`), '201 检验来源行'))
    const items = canonicalRows(pageRows(await api.getBusiness(
      `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${id}`), '201 检验项目'))
    if (!sameId(detail?.id, id) || text(detail.type) !== '201' ||
        !stockInspectionSource(detail.srcBillType, '201') || !sameId(detail.srcBillId, wmsId) ||
        !sameId(detail.inspectionPlan, artifacts.plan.planId) ||
        entries.length !== 1 || !sameId(entries[0].mid, id) ||
        !sameId(entries[0].materialId, fixture.material.id) ||
        !sameId(entries[0].srcBillId, wmsId) || !stockInspectionSource(entries[0].srcBillType, '201') ||
        !stableId(entries[0].id) || !stableId(entries[0].srcEntryId) ||
        !items.length || items.some((item) => !sameId(item.mid, id) ||
          !sameId(item.entryId, entries[0].id) || !sameId(item.itemId, artifacts.item.itemId) ||
          !stableId(item.id))) {
      throw new Error(`BLOCKED: 201 检验来源、方案或项目不完整：${id}`)
    }
    inspections.push(structuredClone({ inspectionId: id, detail, entries, items }))
  }
  return inspections
}

const outboundInspectionPayload = (inspection, qty, passed) => {
  const payload = qualifiedInboundPayload(inspection, qty)
  const result = passed ? '全部合格' : '全部不合格'
  payload.passQty = passed ? qty : 0
  payload.inspectionResult = result
  for (const entry of payload.qualityInspectionEntryList) {
    entry.passQty = payload.passQty
    entry.finalResult = result
    entry.inspectionConclusion = result
  }
  for (const item of payload.qualityInspectionItemList) {
    item.passQty = payload.passQty
    item.ngQty = passed ? 0 : qty
    item.inspectionResult = passed ? '1' : '0'
    item.finalInspectionResult = item.inspectionResult
  }
  return payload
}

export async function verifyWmsQcOutboundClosure (
  api, caseRecord, fixture, saleOut, wmsId, baseline, artifacts, dependencies = {}
) {
  requireOwnedStockDimensions(caseRecord, fixture)
  const id = requireId(wmsId, '201 出库')
  const saleOutId = requireId(saleOut.id, '专属销售出库')
  const orderId = requireId(saleOut.payload?.orderId, '专属销售订单')
  const qty = quantity(saleOut.payload?.items?.[0]?.count)
  for (const [kind, ownedId] of [['saleOut', saleOutId], ['saleOrder', orderId]]) {
    if (!(caseRecord.fixtures || []).some((row) =>
      row.kind === kind && sameId(row.id, ownedId) && row.marker === fixture.marker)) {
      throw new Error(`BLOCKED: 201 OQC ${kind} 不属于本轮`)
    }
  }
  if (!(caseRecord.fixtures || []).some((row) => row.kind === 'qualityArtifact' &&
      row.marker === fixture.marker && row.type === '201' &&
      sameId(row.materialId, fixture.material.id) && sameId(row.planId, artifacts.plan.planId)) ||
      !Number.isFinite(qty) || qty <= 0 || !Array.isArray(baseline) || !baseline.length ||
      baseline.some((row) => !sameId(row.materialId, fixture.material.id) ||
        !sameId(row.warehouseId, fixture.warehouse.id) || !inventoryConserved(row))) {
    throw new Error('BLOCKED: 201 OQC 缺少专属规则或完整库存前态')
  }
  const sql = dependencies.runReadOnlySql || runReadOnlySql
  const snapshot = async () => {
    const stock = await readStockState(api, fixture, id)
    const erp = requireSuccess(await api.getBusiness(`/erp/sale-out/get?id=${saleOutId}`), '201 ERP 来源')
    const order = requireSuccess(await api.getBusiness(`/erp/sale-order/get?id=${orderId}`), '201 销售订单')
    const inspections = await readOutboundInspections(api, fixture, id, artifacts)
    if (!sameId(erp?.id, saleOutId) || !sameId(erp.orderId, orderId) ||
        !isOwnedFixture(erp, fixture.marker) || !sameId(order?.id, orderId) ||
        !isOwnedFixture(order, fixture.marker) || quantity(erp.status) !== 20 ||
        erp.items?.length !== 1 || !sameId(erp.items[0].productId, fixture.material.id) ||
        !sameId(erp.items[0].warehouseId, fixture.warehouse.id) || quantity(erp.items[0].count) !== qty ||
        text(stock.main.stockIoType) !== '201' || text(stock.main.srcBillType) !== 'ErpSaleOut' ||
        !sameId(stock.main.srcBillId, saleOutId) || stock.entries.length !== 1 ||
        text(stock.entries[0].srcBillType) !== 'ErpSaleOut' ||
        !sameId(stock.entries[0].srcBillId, saleOutId) ||
        !sameId(stock.entries[0].srcEntryId, erp.items[0].id) ||
        quantity(stock.entries[0].qty) !== qty || text(stock.entries[0].stockIoDirection) !== '2' ||
        text(stock.entries[0].isQc) !== '1' ||
        inspections.some((row) => !sameId(row.entries[0].srcEntryId, stock.entries[0].id))) {
      throw new Error('BLOCKED: 201 OQC ERP/WMS/质检来源链不匹配')
    }
    const inventoryWhere = `tenant_id = 1 AND material_id = '${requireId(fixture.material.id, '物料')}' ` +
      `AND warehouse_id = '${requireId(fixture.warehouse.id, '仓库')}'`
    const inventorySql = await sql(`SELECT * FROM mes_stk_inventory WHERE ${inventoryWhere} ORDER BY id`)
    // The formal audit table is adjust_log; there is no assumed inventory_flow endpoint.
    const auditSql = await sql(`SELECT * FROM mes_stk_inventory_adjust_log WHERE tenant_id = 1 AND ` +
      `(source_bill_id = '${id}' OR inventory_id IN ` +
      `(SELECT id FROM mes_stk_inventory WHERE ${inventoryWhere})) ORDER BY id`)
    if (inventorySql?.available !== true || auditSql?.available !== true ||
        !Array.isArray(inventorySql.rows) || !Array.isArray(auditSql.rows)) {
      throw new Error('BLOCKED: 201 OQC 缺少库存及调整审计只读 SQL 证据')
    }
    return structuredClone({ stock, erp, order, inspections,
      sql: { inventory: inventorySql.rows, audit: auditSql.rows } })
  }
  let before = await snapshot()
  if (before.inspections.length !== 1 || text(before.inspections[0].detail.isRecheck) === '1' ||
      !['14', '24'].includes(text(before.stock.main.billStage)) ||
      text(before.stock.main.isEffective) !== '0' || text(before.stock.main.isVoided) !== '0' ||
      text(before.stock.main.isClosed) !== '0' ||
      before.stock.entries.some((entry) => text(entry.inStockTime) !== '') ||
      !isDeepStrictEqual(before.stock.inventory, baseline)) {
    throw new Error('BLOCKED: OQC 负例必须使用本轮尚未执行的 201 与唯一原检验')
  }
  if (before.stock.main.actions?.check === true && text(before.stock.main.billStage) === '14') {
    requireSuccess(await api.putBusiness('/mes/stkIo/check', {
      id, approvalResultType: '1', approvalRemark: `${fixture.marker} OQC audit before execution`
    }), '201 手工核批')
    before = await snapshot()
  }
  if (before.stock.main.actions?.execute !== true || text(before.stock.main.billStage) !== '24' ||
      text(before.stock.main.isEffective) !== '0') {
    throw new Error('BLOCKED: 201 OQC 负例缺少正式 execute 动作')
  }
  const original = before.inspections[0]
  remember(caseRecord, { kind: 'qualityArtifact', inspectionId: original.inspectionId,
    marker: fixture.marker, retained: true, reason: '保留正式 OQC 原结论及复检链' })
  const submit = async (inspection, passed) => {
    if (isEffectiveBill(inspection.detail) || inspection.detail.actions?.edit !== true) {
      throw new Error('BLOCKED: OQC 结论必须通过本轮可编辑检验提交')
    }
    requireSuccess(await api.putBusiness('/mes/quality/qualityInspection/edit/submit',
      outboundInspectionPayload(inspection, qty, passed)), '201 正式检验结论提交')
    await auditInboundInspectionWhenNeeded(api, caseRecord, inspection.inspectionId)
    const result = (await readOutboundInspections(api, fixture, id, artifacts))
      .find((row) => sameId(row.inspectionId, inspection.inspectionId))
    const valid = result && isEffectiveBill(result.detail) &&
      quantity(result.detail.passQty) === (passed ? qty : 0) &&
      result.entries.every((entry) => quantity(entry.inspectionQty) === qty &&
        quantity(entry.passQty) === (passed ? qty : 0) && quantity(entry.concessionQty) === 0 &&
        quantity(entry.pendingJudgeQty) === 0) &&
      result.items.every((item) => quantity(item.inspectionQty) === qty &&
        quantity(item.passQty) === (passed ? qty : 0) && quantity(item.ngQty) === (passed ? 0 : qty) &&
        text(item.finalInspectionResult) === (passed ? '1' : '0'))
    addCheck(caseRecord, passed ? '正式 OQC 复检合格结论审核生效' : '正式 OQC 不合格结论审核生效',
      valid, `inspection=${inspection.inspectionId}`)
    if (!valid) throw new Error('201 OQC 结论回读不完整')
    return result
  }
  await submit(original, false)
  const rejectedBefore = await snapshot()
  // MesStkIoController.execute catches the service error (1001003000) and returns Result.error(message).
  const expected = serviceRejection('当前出入库单还需销售出库检')
  const response = await api.put('/mes/stkIo/execute', { id }, { expectedBusinessRejection: expected })
  const rejectedAfter = await snapshot()
  const rejected = exactStateRejection(response, expected)
  const unchanged = isDeepStrictEqual(rejectedBefore, rejectedAfter)
  addCheck(caseRecord, 'OQC 不合格 execute 精确拒绝', rejected,
    `code=${response?.code}; expected=${expected.message}`)
  addCheck(caseRecord, 'OQC 拒绝前后 ERP、WMS、质检、库存及调整审计完整不变', unchanged)
  caseRecord.outboundOqcEvidence ||= []
  const evidence = { sourceBillId: id, rejection: structuredClone(response), rejectedBefore, rejectedAfter }
  caseRecord.outboundOqcEvidence.push(evidence)
  if (!rejected || !unchanged) throw new Error('OQC 未精确拒绝或完整事实发生变化')
  addCheck(caseRecord, '出库检不合格阻断发货完成的正式契约已确认', true,
    '201 库存执行被正式 OQC 门禁阻断；未据此证明独立发货通知完成接口')
  const ownedRecheck = remember(caseRecord, { kind: 'qualityArtifact', marker: fixture.marker,
    createAttempted: true, retained: true, reason: '正式 OQC 复检保留审计链' })
  const created = requireSuccess(await api.postBusiness('/mes/quality/qualityInspection/recheck',
    { id: original.inspectionId }), '201 正式发起复检')
  ownedRecheck.inspectionId = requireId(created?.id, '201 复检')
  if (!sameId(created.reinspectOfId, original.inspectionId)) throw new Error('201 复检响应原单关联不匹配')
  const rechecks = await readOutboundInspections(api, fixture, id, artifacts)
  const recheck = rechecks.find((row) => sameId(row.inspectionId, ownedRecheck.inspectionId))
  if (rechecks.length !== 2 || !recheck || text(recheck.detail.isRecheck) !== '1' ||
      !sameId(recheck.detail.reinspectOfId, original.inspectionId) ||
      quantity(recheck.detail.inspectionRound) <= quantity(original.detail.inspectionRound ?? 1) ||
      !isDeepStrictEqual(rejectedBefore.inspections.find((row) => sameId(row.inspectionId, original.inspectionId)),
        rechecks.find((row) => sameId(row.inspectionId, original.inspectionId)))) {
    throw new Error('201 复检链未保持原结论或轮次关联不正确')
  }
  await submit(recheck, true)
  const released = await snapshot()
  // A formal recheck updates afterSaveQcQty; only execution/stock facts must stay unchanged here.
  const executionFacts = (stock) => ({
    main: Object.fromEntries(['id', 'billStage', 'isEffective', 'effectiveTime', 'isVoided', 'isClosed']
      .map((key) => [key, stock.main[key] ?? null])),
    entries: stock.entries.map((entry) => Object.fromEntries(
      ['id', 'qty', 'materialId', 'warehouseId', 'inStockTime'].map((key) => [key, entry[key] ?? null]))),
    inventory: stock.inventory
  })
  if (!isDeepStrictEqual(executionFacts(rejectedAfter.stock), executionFacts(released.stock)) ||
      !isDeepStrictEqual(rejectedAfter.sql, released.sql)) {
    throw new Error('201 复检审核提前改变库存执行事实或库存调整审计')
  }
  const execution = await executeWmsStockBillWhenNeeded(api, caseRecord, fixture, saleOut, id, baseline)
  const executed = await snapshot()
  const duplicateExpected = billStateRejection(executed.stock.main, '201 已执行单')
  const duplicate = await api.put('/mes/stkIo/execute', { id },
    { expectedBusinessRejection: duplicateExpected })
  const repeated = await snapshot()
  const duplicateSafe = exactStateRejection(duplicate, duplicateExpected) &&
    isDeepStrictEqual(executed, repeated)
  addCheck(caseRecord, 'OQC 放行出库重复 execute 精确拒绝且完整事实不变', duplicateSafe)
  if (!duplicateSafe) throw new Error('201 重复执行未精确拒绝或完整事实发生变化')
  const initial = inventoryTotals(baseline)
  const final = inventoryTotals(executed.stock.inventory)
  const conserved = executed.stock.inventory.every(inventoryConserved) &&
    initial.qty - final.qty === qty && initial.availableQty - final.availableQty === qty &&
    ['lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty'].every((key) => initial[key] === final[key])
  addCheck(caseRecord, 'OQC 复检放行后出库数量与库存六分量守恒', conserved)
  if (!conserved) throw new Error('201 OQC 放行后库存不守恒')
  Object.assign(evidence, { released, executed, repeated, duplicate: structuredClone(duplicate) })
  return execution
}

// Read the source-generated inspection instead of creating a second release bill.
const readInboundInspection = async (api, inbound, fixture, artifacts) => {
  const sourceId = requireId(inbound.wms.id, '采购入库库存来源')
  const rows = await readAll(api,
    `/mes/quality/qualityInspection/list/dictText?srcBillId=${encodeURIComponent(sourceId)}&type=101`,
    '来源生成的采购入库检')
  const matches = rows.filter((row) => sameId(row.srcBillId, sourceId) &&
    text(row.type) === '101' && stockInspectionSource(row.srcBillType, '101'))
  if (matches.length !== 1) {
    throw new Error(`BLOCKED: MesStkIo/${sourceId} 必须有且只有一张正式采购入库检，实际=${matches.length}`)
  }
  const id = requireId(matches[0].id, '采购入库检')
  const detail = requireSuccess(await api.getBusiness(inspectionPath(id)), '采购入库检主单')
  const entries = pageRows(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(id)}`),
  '采购入库检来源明细')
  const items = pageRows(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${encodeURIComponent(id)}`),
  '采购入库检项目明细')
  if (!sameId(detail?.id, id) || text(detail.type) !== '101' ||
      !stockInspectionSource(detail.srcBillType, '101') ||
      !sameId(detail.srcBillId, sourceId) || !sameId(detail.inspectionPlan, artifacts.plan.planId) ||
      entries.length !== 1 || !sameId(entries[0].srcEntryId, inbound.entry.id) ||
      !sameId(entries[0].srcBillId, sourceId) || !stockInspectionSource(entries[0].srcBillType, '101') ||
      !sameId(entries[0].materialId, fixture.material.id) ||
      items.length === 0 || items.some((item) => !stableId(item.id) || !stableId(item.itemId) ||
        !sameId(item.entryId, entries[0].id) || !sameId(item.mid, id))) {
    throw new Error(`BLOCKED: 采购入库检来源、方案或明细不完整：${id}`)
  }
  // Keep the pre-action inspection evidence immutable even when a test double reuses response objects.
  return {
    inspectionId: id,
    detail: structuredClone(detail),
    entries: structuredClone(entries),
    items: structuredClone(items)
  }
}

const qualifiedInboundPayload = (inspection, qty) => ({
  ...inspection.detail,
  srcBillType: 'MesStkIo',
  inspectionQty: qty,
  qty,
  passQty: qty,
  concessionQty: 0,
  pendingJudgeQty: 0,
  inspector: '1',
  inspectionResult: '全部合格',
  qualityInspectionEntryList: inspection.entries.map((entry) => ({
    ...entry,
    srcBillType: 'MesStkIo',
    inspectionQty: qty,
    qty,
    passQty: qty,
    concessionQty: 0,
    pendingJudgeQty: 0,
    finalResult: '全部合格',
    inspectionConclusion: '全部合格'
  })),
  qualityInspectionItemList: inspection.items.map((item) => ({
    ...item,
    inspectionQty: qty,
    passQty: qty,
    ngQty: 0,
    inspectionResult: '1',
    finalInspectionResult: '1'
  }))
})

const auditInboundInspectionWhenNeeded = async (api, caseRecord, inspectionId) => {
  const id = requireId(inspectionId, '采购入库检核批')
  const before = requireSuccess(await api.getBusiness(inspectionPath(id)), '质检核批前回读')
  if (!sameId(before?.id, id)) throw new Error('BLOCKED: 质检核批前回读 ID 不匹配')
  if (isEffectiveBill(before)) {
    addCheck(caseRecord, '已生效质检单仅回读不重复 check', true,
      `id=${id}; isEffective=${before.isEffective}; effectiveTime=${before.effectiveTime ?? ''}`)
    return { detail: before, skipped: true }
  }
  if (before.actions?.check !== true) {
    throw new Error(`BLOCKED: 质检单 ${id} 不允许手工核批；保留现有审批策略，不猜测状态`)
  }
  const expected = inspectionStateRejection(before)
  const response = await api.put('/mes/quality/qualityInspection/check', {
    id,
    approvalResultType: '1',
    approvalRemark: 'E2E WMS-QC manual inspection audit'
  }, { expectedBusinessRejection: expected })
  if (!isBusinessSuccess(response)) {
    const rejected = exactStateRejection(response, expected)
    addCheck(caseRecord, '质检核批业务请求成功', false,
      `id=${id}; code=${response?.code}; exactStateRejection=${rejected}`)
    if (rejected) addEvidence(caseRecord, `质检核批精确状态拒绝：${expected.message}；不计为核批通过`)
    throw new Error(`质检核批业务失败：${response?.code} ${response?.msg || response?.message || ''}`)
  }
  const detail = requireSuccess(await api.getBusiness(inspectionPath(id)), '质检核批后回读')
  const effective = sameId(detail?.id, id) && isEffectiveBill(detail)
  addCheck(caseRecord, '质检核批业务请求成功且回读生效', effective, `id=${id}; isEffective=${detail?.isEffective}`)
  if (!effective) throw new Error(`BLOCKED: 质检核批成功但未形成生效事实：${id}`)
  return { response, detail, skipped: false }
}

const inventoryTotals = (rows) => Object.fromEntries(
  ['qty', 'availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty'].map((key) =>
    [key, rows.reduce((sum, row) => sum + quantity(row[key]), 0)]))

const releaseInboundInspection = async (api, caseRecord, fixture, inbound, artifacts) => {
  let inspection = await readInboundInspection(api, inbound, fixture, artifacts)
  const qty = quantity(inbound.entry.qty)
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('BLOCKED: 正式采购入库来源数量必须为正数')
  const before = await inventorySnapshot(api, fixture, fixture.material.id)
  const initial = inventoryTotals(before)
  const held = before.length > 0 && initial.qty === qty && initial.availableQty === 0 &&
    initial.lockQty === 0 && initial.frozenQty === 0 &&
    initial.holdQty + initial.pendingPutawayQty === qty
  addCheck(caseRecord, '采购入库审核后质检库存先进入 hold/pendingPutaway', held,
    `wms=${inbound.wms.id}; available=${initial.availableQty}; hold=${initial.holdQty}; pending=${initial.pendingPutawayQty}`)
  let audited
  if (isEffectiveBill(inspection.detail)) {
    audited = await auditInboundInspectionWhenNeeded(api, caseRecord, inspection.inspectionId)
    addGap(caseRecord, 'manual-inbound-release',
      '来源质检已生效，未发送 edit/check；没有本轮人工放行前态证据，不能以已审事实替代人工闭环。',
      'DEFERRED')
  } else {
    if (!held || inspection.detail.actions?.edit !== true) {
      throw new Error('BLOCKED: 人工采购入库检缺少隔离库存或可编辑动作，停止后续写操作')
    }
    requireSuccess(await api.putBusiness('/mes/quality/qualityInspection/edit/submit',
      qualifiedInboundPayload(inspection, qty)), '采购入库检合格结果正式提交')
    audited = await auditInboundInspectionWhenNeeded(api, caseRecord, inspection.inspectionId)
  }
  inspection = await readInboundInspection(api, inbound, fixture, artifacts)
  const qualified = isEffectiveBill(inspection.detail) &&
    inspection.entries.every((entry) => quantity(entry.qty) === qty &&
      quantity(entry.inspectionQty) === qty && quantity(entry.passQty) === qty &&
      quantity(entry.concessionQty) === 0 && quantity(entry.pendingJudgeQty) === 0) &&
    inspection.items.every((item) => quantity(item.inspectionQty) === qty &&
      quantity(item.passQty) === qty && quantity(item.ngQty) === 0 &&
      text(item.finalInspectionResult) === '1')
  addCheck(caseRecord, '正式质检单含来源明细和项目明细并审核生效', qualified,
    `inspection=${inspection.inspectionId}; source=MesStkIo/${inbound.wms.id}; skippedCheck=${audited.skipped}`)
  if (!qualified) throw new Error('BLOCKED: 质检生效回读没有完整合格数量和项目结论，停止退货/出库')
  const after = await inventorySnapshot(api, fixture, fixture.material.id)
  caseRecord.inventorySnapshots ||= []
  caseRecord.inventorySnapshots.push({
    sourceBillId: String(inbound.wms.id),
    inspectionId: inspection.inspectionId,
    warehouseId: String(fixture.warehouse.id),
    materialId: String(fixture.material.id),
    before: structuredClone(before),
    after: structuredClone(after)
  })
  const final = inventoryTotals(after)
  const released = initial.holdQty + initial.pendingPutawayQty - final.holdQty - final.pendingPutawayQty
  addCheck(caseRecord, '正式质检放行后 available 增量等于 hold 减量',
    held && released === qty && Math.abs(released - (final.availableQty - initial.availableQty)) < 0.000001,
    `beforeHold=${initial.holdQty}; afterHold=${final.holdQty}; beforePending=${initial.pendingPutawayQty}; afterPending=${final.pendingPutawayQty}`)
  addCheck(caseRecord, '质检放行前后库存总量守恒', before.length > 0 && after.length > 0 &&
    initial.qty === final.qty && before.every(inventoryConserved) && after.every(inventoryConserved),
  `beforeQty=${initial.qty}; afterQty=${final.qty}`)
  const duplicateBefore = await inventorySnapshot(api, fixture, fixture.material.id)
  const duplicateExpected = inspectionStateRejection(inspection.detail)
  const duplicate = await api.put('/mes/quality/qualityInspection/check', {
    id: String(inspection.inspectionId),
    approvalResultType: '1',
    approvalRemark: 'E2E WMS-QC deliberate duplicate check rejection'
  }, { expectedBusinessRejection: duplicateExpected })
  const duplicateAfter = await inventorySnapshot(api, fixture, fixture.material.id)
  const duplicateRejected = exactStateRejection(duplicate, duplicateExpected)
  const duplicateUnchanged = isDeepStrictEqual(duplicateBefore, duplicateAfter)
  addCheck(caseRecord, '已生效质检重复 check 返回精确状态拒绝且库存不变',
    duplicateRejected && duplicateUnchanged,
    `inspection=${inspection.inspectionId}; code=${duplicate?.code}; exact=${duplicateRejected}; inventoryUnchanged=${duplicateUnchanged}`)
  if (!duplicateRejected || !duplicateUnchanged) {
    throw new Error(`BLOCKED: 已生效质检重复 check 未形成精确拒绝或库存发生变化：${inspection.inspectionId}`)
  }
  // The normal guard is also exercised after the deliberate negative request.
  const afterRepeat = await auditInboundInspectionWhenNeeded(api, caseRecord, inspection.inspectionId)
  addCheck(caseRecord, '已生效质检正常路径不重复发送 check', afterRepeat.skipped === true,
    `inspection=${inspection.inspectionId}; skipped=${afterRepeat.skipped}`)
  return inspection
}

const prepareQualifiedPurchaseInbound = async (api, caseRecord, fixture) => {
  const supplier = await createPartner(api, caseRecord, fixture.marker, 'SUPPLIER')
  const account = await readAccount(api)
  const order = await createPurchaseOrder(api, caseRecord, fixture, supplier, fixture.material)
  const artifacts = await createQualityArtifacts(api, caseRecord, fixture, fixture.material)
  const inbound = await createPurchaseInbound(api, caseRecord, fixture, supplier, fixture.material, order, account)
  const inspection = await releaseInboundInspection(api, caseRecord, fixture, inbound, artifacts)
  return { supplier, account, order, inbound, inspection, artifacts }
}

const requireOwnedStockDimensions = (caseRecord, fixture) => {
  for (const [kind, value] of [
    ['warehouse', fixture.warehouse], ['area', fixture.area],
    ['location', fixture.location], ['material', fixture.material]
  ]) {
    requireId(value?.id, `QC001 专属 ${kind}`)
    if (!(caseRecord.fixtures || []).some((row) =>
      row.kind === kind && sameId(row.id, value.id) && row.token === fixture.token)) {
      throw new Error(`BLOCKED: QC001 ${kind} 未登记为本轮专属维度`)
    }
  }
}

const readSourceInspections = async (api, wmsId) => {
  const id = requireId(wmsId, '入库检来源')
  const rows = await readAll(api,
    `/mes/quality/qualityInspection/list/dictText?srcBillId=${encodeURIComponent(id)}&type=101`,
    '专属来源入库检完整回读')
  if (rows.some((row) => !sameId(row.srcBillId, id) || text(row.type) !== '101' ||
      !stockInspectionSource(row.srcBillType, '101'))) {
    throw new Error('BLOCKED: 入库检查询返回其他来源，不能证明专属来源不存在检验单')
  }
  return rows
}

const qualityVoidDraftMatchesSourceContract = (rows, inspectionId) =>
  Array.isArray(rows) && rows.length === 1 &&
  sameId(rows[0]?.id, inspectionId) &&
  text(rows[0].isEffective) === '0' &&
  text(rows[0].billStage) === '12' &&
  text(rows[0].isVoided) === '0'

const saveInventoryStage = (caseRecord, fixture, sourceBillId, stage, inventory) => {
  caseRecord.inventorySnapshots ||= []
  caseRecord.inventorySnapshots.push({
    sourceBillId: String(sourceBillId),
    warehouseId: String(fixture.warehouse.id),
    materialId: String(fixture.material.id),
    stage,
    inventory: structuredClone(inventory)
  })
}

const buildNonQcInboundPayload = (fixture, supplier, order) => ({
  billNo: `${fixture.marker}-101`,
  billDate: nowDate(),
  subject: `${fixture.marker} non-quality purchase receipt`,
  remark: fixture.marker,
  stockIoType: '101',
  isAuto: 0,
  srcBillType: 'PurOrder',
  srcBillId: String(order.id),
  srcNo: order.detail.billNo,
  supplierId: String(supplier.id),
  stkIoEntryList: [{
    materialId: String(fixture.material.id),
    unitId: String(fixture.material.unitId),
    qty: defaultQty,
    cost: defaultMoney,
    warehouseId: String(fixture.warehouse.id),
    wareAreaId: String(fixture.area.id),
    wareLocationId: String(fixture.location.id),
    batchNo: `${fixture.marker}-BATCH`,
    entryNo: 1,
    stockIoType: '101',
    stockIoDirection: '1',
    isQc: 0,
    settleQty: defaultQty,
    srcBillType: 'PurOrder',
    srcBillId: String(order.id),
    srcEntryId: String(order.item.id),
    srcNo: order.detail.billNo,
    supplierId: String(supplier.id),
    remark: fixture.marker
  }],
  stkIoDistributionList: [],
  stkIoBomList: []
})

const completeOwnedInboundApproval = async (api, caseRecord, fixture, wmsId, dependencies) => {
  let detail = (await readStockState(api, fixture, wmsId)).main
  if (!isEffectiveBill(detail) && text(detail.billStage) !== '22') {
    if (detail.actions?.check !== true) {
      throw new Error('BLOCKED: 非质检来源不允许正式审核；不修改审批策略')
    }
    requireSuccess(await api.putBusiness('/mes/stkIo/check', {
      id: String(wmsId), approvalResultType: '1', approvalRemark: `${fixture.marker} owned non-QC receipt`
    }), '非质检来源正式审核')
    detail = (await readStockState(api, fixture, wmsId)).main
  }
  if (!isEffectiveBill(detail) && text(detail.billStage) === '22') {
    const settings = dependencies.settings || config
    await (dependencies.approveWmsProcess || approveWmsProcess)({
      api, caseRecord, record: dependencies.record,
      processId: detail.processInstanceId,
      label: 'QC001 非质检专属入库',
      taskDefinitionKey: 'FirstApprove_purchase-in',
      stageApprovers: [
        { taskDefinitionKey: 'FirstApprove_purchase-in',
          username: settings.warehouseApproverUsername, password: settings.warehouseApproverPassword },
        { taskDefinitionKey: 'SecondApprove_purchase-in',
          username: settings.warehouseApproverUsername, password: settings.warehouseApproverPassword },
        { taskDefinitionKey: 'FinalApprove_purchase-in',
          username: settings.warehouseFinalApproverUsername, password: settings.warehouseFinalApproverPassword }
      ]
    })
    detail = (await readStockState(api, fixture, wmsId)).main
  }
  if (!isEffectiveBill(detail)) {
    throw new Error('BLOCKED: 非质检正式入库尚未生效；不把提审或已创建视作库存执行')
  }
  return detail
}

export async function createWmsQcNonInspectionControl (api, caseRecord, fixture, supplier, dependencies = {}) {
  requireOwnedStockDimensions(caseRecord, fixture)
  const positiveBefore = await inventorySnapshot(api, fixture, fixture.material.id)
  const token = `${fixture.token}-NONQC`
  const material = await (dependencies.createMaterialFixture || createMaterialFixture)(
    api, caseRecord, token, fixture.material.unitId)
  const control = { ...fixture, token, material, marker: `${fixture.marker}-NONQC` }
  const owned = (caseRecord.fixtures || []).find((row) =>
    row.kind === 'material' && sameId(row.id, material?.id) && row.token === token)
  if (!owned || material.code !== owned.code || sameId(material.id, fixture.material.id) ||
      !sameId(material.unitId, fixture.material.unitId)) {
    throw new Error('BLOCKED: 非质检对照必须使用新建专属实物物料，不复用正样本或共享物料')
  }
  const readRules = () => readAll(api,
    `/mes/quality/qualityMaterial/list/dictText?types=101&materialId=${encodeURIComponent(material.id)}`,
    '非质检专属物料规则')
  const beforeRules = await readRules()
  if (beforeRules.length) throw new Error('BLOCKED: 非质检专属物料已有质检规则，不删除规则制造对照')
  const before = await inventorySnapshot(api, control, material.id)
  if (inventoryTotals(before).qty !== 0) throw new Error('BLOCKED: 非质检专属物料已有库存，不混用余额')
  const order = await createPurchaseOrder(api, caseRecord, control, supplier, material)
  if (!sameId(order.item.productId, material.id) || quantity(order.item.count) !== defaultQty) {
    throw new Error('BLOCKED: 非质检专属采购订单行与物料或数量不匹配')
  }
  const payload = buildNonQcInboundPayload(control, supplier, order)
  const ownedBill = remember(caseRecord, {
    kind: 'stockIo', marker: control.marker, token, createAttempted: true, retained: true,
    warehouseId: String(control.warehouse.id), areaId: String(control.area.id),
    locationId: String(control.location.id), materialId: String(material.id), payload
  })
  const id = requireApiSuccessId(await api.postBusiness('/mes/stkIo/add/submit', payload), '非质检正式 101 入库')
  ownedBill.id = id
  const assertSource = (state) => {
    const main = state.main
    const entry = state.entries[0]
    if (!isOwnedFixture(main, control.marker) || text(main.stockIoType) !== '101' ||
        text(main.srcBillType) !== 'PurOrder' || !sameId(main.srcBillId, order.id) ||
        main.billNo !== payload.billNo || state.entries.length !== 1 ||
        text(entry.isQc) !== '0' || text(entry.stockIoType) !== '101' ||
        text(entry.stockIoDirection) !== '1' || quantity(entry.qty) !== defaultQty ||
        !sameId(entry.wareAreaId, control.area.id) || !sameId(entry.wareLocationId, control.location.id) ||
        text(entry.srcBillType) !== 'PurOrder' || !sameId(entry.srcBillId, order.id) ||
        !sameId(entry.srcEntryId, order.item.id)) {
      throw new Error('BLOCKED: 非质检正式来源、存储维度或 isQc=0 回读不匹配')
    }
  }
  assertSource(await readStockState(api, control, id))
  const submittedInspections = await readSourceInspections(api, id)
  if (submittedInspections.length) throw new Error('非质检正式提交意外生成采购入库检，停止审核')
  await completeOwnedInboundApproval(api, caseRecord, control, id, dependencies)
  const state = await readStockState(api, control, id)
  assertSource(state)
  const inspections = await readSourceInspections(api, id)
  const afterRules = await readRules()
  const after = state.inventory
  const totals = inventoryTotals(after)
  const passed = isEffectiveBill(state.main) && inspections.length === 0 && afterRules.length === 0 &&
    after.length > 0 && totals.qty === defaultQty && totals.availableQty === defaultQty &&
    totals.holdQty === 0 && totals.pendingPutawayQty === 0 && totals.lockQty === 0 && totals.frozenQty === 0
  addCheck(caseRecord, '非质检存货不生成采购入库检', passed,
    `material=${material.id}; order=${order.id}; source=PurOrder; wms=${id}; isQc=0; ` +
    `submittedInspections=${submittedInspections.length}; effectiveInspections=${inspections.length}; ` +
    `rules=${afterRules.length}; available=${totals.availableQty}`)
  if (!passed) throw new Error('非质检正式入库生成检验单或库存未直接进入 available')
  saveInventoryStage(caseRecord, control, id, 'NON_QC_BEFORE', before)
  saveInventoryStage(caseRecord, control, id, 'NON_QC_AVAILABLE', after)
  const unchanged = isDeepStrictEqual(positiveBefore, await inventorySnapshot(api, fixture, fixture.material.id))
  addCheck(caseRecord, '非质检对照不改变质检正样本库存', unchanged, `positiveMaterial=${fixture.material.id}`)
  if (!unchanged) throw new Error('非质检对照改变了质检正样本库存')
  addEvidence(caseRecord, `非质检对照：新建物料 ${material.id} 无 101 规则，正式采购订单 ${order.id} -> ` +
    `WMS 101/${id}（PurOrder 来源、明细 isQc=0）提交及生效均无入库检；未冒充 ERP needQc=false`)
  return { fixture: control, order, wms: state.main, inventory: after }
}

export async function verifyWmsQcInboundReversal (api, caseRecord, fixture, prepared, baseline) {
  requireOwnedStockDimensions(caseRecord, fixture)
  const { inbound, inspection, artifacts } = prepared
  const owned = (caseRecord.fixtures || []).some((row) =>
    row.kind === 'purchaseInbound' && sameId(row.id, inbound.id) && row.marker === fixture.marker)
  if (!owned || !Array.isArray(baseline) || inventoryTotals(baseline).qty !== 0 ||
      baseline.some((row) => !sameId(row.materialId, fixture.material.id) ||
        !sameId(row.warehouseId, fixture.warehouse.id) || !inventoryConserved(row))) {
    throw new Error('BLOCKED: 反向流程必须基于本轮专属采购入库和完整零库存前态')
  }
  const readErp = async () => {
    const row = requireSuccess(await api.getBusiness(
      `/erp/purchase-in/get?id=${encodeURIComponent(inbound.id)}`), '反向采购入库回读')
    if (!sameId(row?.id, inbound.id) || !isOwnedFixture(row, fixture.marker) ||
        !sameId(row.orderId, inbound.payload.orderId) || row.items?.length !== 1 ||
        !sameId(row.items[0].productId, fixture.material.id) ||
        !sameId(row.items[0].warehouseId, fixture.warehouse.id) ||
        quantity(row.items[0].count) !== quantity(inbound.entry.qty)) {
      throw new Error('BLOCKED: 反向采购入库所有权、来源订单或明细不匹配')
    }
    return row
  }
  const assertStockSource = (state) => {
    if (text(state.main.stockIoType) !== '101' || text(state.main.srcBillType) !== 'ErpPurchaseIn' ||
        !sameId(state.main.srcBillId, inbound.id) || state.entries.length !== 1 ||
        !sameId(state.entries[0].id, inbound.entry.id) ||
        text(state.entries[0].isQc) !== '1' || text(state.entries[0].stockIoDirection) !== '1' ||
        quantity(state.entries[0].qty) !== quantity(inbound.entry.qty)) {
      throw new Error('BLOCKED: 反向 WMS 来源或明细不匹配')
    }
  }
  // Preserve the first ERP read as immutable evidence before later mock/API state changes.
  const erpBefore = structuredClone(await readErp())
  const before = await readStockState(api, fixture, inbound.wms.id)
  assertStockSource(before)
  const inspectionBefore = await readInboundInspection(api, inbound, fixture, artifacts)
  const qty = quantity(inbound.entry.qty)
  const totals = inventoryTotals(before.inventory)
  if (!Number.isFinite(qty) || qty <= 0 || !isEffectiveBill(before.main) ||
      (quantity(erpBefore.status) !== 20 && !isEffectiveBill(erpBefore)) ||
      !isEffectiveBill(inspectionBefore.detail) || inspectionBefore.detail.actions?.void !== true ||
      !sameId(inspectionBefore.inspectionId, inspection.inspectionId) ||
      before.main.actions?.void !== true || quantity(erpBefore.paymentPrice) !== 0 ||
      before.inventory.length === 0 || totals.qty !== qty || totals.availableQty !== qty ||
      totals.holdQty !== 0 || totals.pendingPutawayQty !== 0 || totals.lockQty !== 0 || totals.frozenQty !== 0) {
    throw new Error('BLOCKED: 反向样本未完整放行或不可质检弃审，不撤销共享/占用库存')
  }
  saveInventoryStage(caseRecord, fixture, inbound.wms.id, 'REVERSE_AVAILABLE', before.inventory)
  requireSuccess(await api.putBusiness('/mes/quality/qualityInspection/void', {
    id: inspection.inspectionId
  }), 'QC001 质检正式弃审')
  const heldInspection = await readInboundInspection(api, inbound, fixture, artifacts)
  const held = await readStockState(api, fixture, inbound.wms.id)
  assertStockSource(held)
  const heldTotals = inventoryTotals(held.inventory)
  const restoredHold = !isEffectiveBill(heldInspection.detail) &&
    text(heldInspection.detail.billStage) === '12' && text(heldInspection.detail.isVoided) === '0' &&
    isEffectiveBill(held.main) && heldTotals.qty === qty && heldTotals.availableQty === 0 &&
    heldTotals.holdQty === qty && heldTotals.pendingPutawayQty === 0 &&
    heldTotals.lockQty === 0 && heldTotals.frozenQty === 0 &&
    quantity(held.main.qcQty) === 0 && quantity(held.entries[0].qcQty) === 0
  addCheck(caseRecord, '质检弃审 available 等量回退 hold 且总量守恒', restoredHold,
    `inspection=${inspection.inspectionId}; source=${inbound.wms.id}; ` +
    `beforeAvailable=${totals.availableQty}; afterAvailable=${heldTotals.availableQty}; hold=${heldTotals.holdQty}`)
  saveInventoryStage(caseRecord, fixture, inbound.wms.id, 'REVERSE_HOLD', held.inventory)
  if (!restoredHold) throw new Error('质检弃审未恢复 hold 或库存不守恒，停止采购入库弃审')
  requireSuccess(await api.putBusiness(
    `/erp/purchase-in/update-status?id=${encodeURIComponent(inbound.id)}&status=0`), 'QC001 采购入库正式弃审')
  const erpAfter = await readErp()
  const after = await readStockState(api, fixture, inbound.wms.id)
  assertStockSource(after)
  const inspectionsAfter = await readSourceInspections(api, inbound.wms.id)
  const afterTotals = inventoryTotals(after.inventory)
  const retainedQualityDraft = qualityVoidDraftMatchesSourceContract(
    inspectionsAfter, inspection.inspectionId)
  const inspectionAfter = await readInboundInspection(api, inbound, fixture, artifacts)
  const retainedTrace = retainedQualityDraft &&
    text(inspectionAfter.detail.isEffective) === '0' && text(inspectionAfter.detail.billStage) === '12' &&
    text(inspectionAfter.detail.isVoided) === '0' &&
    isDeepStrictEqual(heldInspection.entries, inspectionAfter.entries) &&
    isDeepStrictEqual(heldInspection.items, inspectionAfter.items)
  addCheck(caseRecord, '质检弃审保留可重新录入的草稿符合正式源码契约',
    retainedTrace,
    `inspection=${inspection.inspectionId}; retained=${inspectionsAfter.length}; ` +
    `billStage=${inspectionsAfter[0]?.billStage}; isEffective=${inspectionsAfter[0]?.isEffective}; ` +
    `traceUnchanged=${retainedTrace}; source=MesQualityInspectionServiceImpl.java:2153-2189`)
  const reversed = quantity(erpAfter.status) === 0 && !isEffectiveBill(erpAfter) &&
    !isEffectiveBill(after.main) && text(after.main.billStage) === '12' &&
    text(after.main.isVoided) === '0' && retainedTrace &&
    Object.values(afterTotals).every((value) => value === 0)
  addCheck(caseRecord, '采购入库弃审撤销本轮库存且来源单据回读未生效', reversed,
    `purchaseIn=${inbound.id}; status=${erpAfter.status}; wms=${inbound.wms.id}; ` +
    `stage=${after.main.billStage}; inspections=${inspectionsAfter.length}; totals=${JSON.stringify(afterTotals)}`)
  saveInventoryStage(caseRecord, fixture, inbound.wms.id, 'REVERSE_ZERO', after.inventory)
  caseRecord.reversalEvidence ||= []
  caseRecord.reversalEvidence.push({
    sourceBillId: String(inbound.wms.id), purchaseInboundId: String(inbound.id),
    inspectionId: inspection.inspectionId,
    before: structuredClone(before), held: structuredClone(held), after: structuredClone(after),
    inspectionBefore: structuredClone(inspectionBefore), inspectionHeld: structuredClone(heldInspection),
    inspectionAfter: structuredClone(inspectionAfter),
    erpBefore: structuredClone(erpBefore), erpAfter: structuredClone(erpAfter),
    inspectionsAfter: structuredClone(inspectionsAfter), baseline: structuredClone(baseline)
  })
  if (!reversed) throw new Error('采购入库弃审未撤销专属库存或正式来源状态未回退')
  addEvidence(caseRecord,
    '源码契约：质检 voidBill 弃审清理派生数据而保留主单；' +
    '原 catalog 未要求删除质检单。本轮完整回读同一来源草稿及明细/项目追溯不变，库存归零。')
  addEvidence(caseRecord, `QC001 两步反向正式 API：质检 ${inspection.inspectionId} 弃审 ` +
    `available→hold（总量 ${qty} 不变），采购入库 ${inbound.id} 弃审撤销 WMS/${inbound.wms.id} ` +
    '库存归零；保留回读证据，不以 cleanup 或直接改余额代替')
  return { before, held, after, reversed }
}

const createPurchaseReturn = async (
  api, caseRecord, fixture, supplier, material, order, account
) => {
  const payload = buildPurchaseReturnPayload({
    marker: fixture.marker,
    supplierId: supplier.id,
    purchaseOrderId: order.id,
    orderItemId: order.item.id,
    materialId: material.id,
    unitId: material.unitId,
    warehouseId: fixture.warehouse.id,
    areaId: fixture.area.id,
    locationId: fixture.location.id,
    accountId: account.id
  })
  const ownedFixture = remember(caseRecord, {
    kind: 'purchaseReturn', marker: fixture.marker, payload, retained: false, createAttempted: true
  })
  const id = requireApiSuccessId(
    await api.postBusiness(WMS_QC_FORMAL_CONTRACTS.purchaseReturn.erpCreate, payload),
    '正式采购退货创建'
  )
  ownedFixture.id = id
  const detail = requireSuccess(await api.getBusiness(
    `${WMS_QC_FORMAL_CONTRACTS.purchaseReturn.erpGet}?id=${encodeURIComponent(id)}`
  ), '采购退货创建后状态回读')
  const item = detail?.items?.[0]
  const owned = Boolean(item?.id) &&
    sameId(detail?.srcBillId, order.id) &&
    sameId(item.srcEntryId, order.item.id) &&
    isOwnedFixture(detail, fixture.marker)
  addCheck(caseRecord, '正式采购退货创建后回读订单来源及实际生效状态', owned &&
    text(detail?.srcBillType) === 'PurOrder' && sameId(detail?.id, id),
  `returnId=${id}; orderId=${order.id}; itemId=${item?.id || ''}; status=${detail?.status}; billStage=${detail?.billStage}; isEffective=${detail?.isEffective}`)
  return { id, detail, item, payload }
}

const createSaleReturn = async (
  api, caseRecord, fixture, customer, material, order, account
) => {
  const payload = buildSaleReturnPayload({
    marker: fixture.marker,
    customerId: customer.id,
    saleOrderId: order.id,
    orderItemId: order.item.id,
    materialId: material.id,
    unitId: material.unitId,
    warehouseId: fixture.warehouse.id,
    areaId: fixture.area.id,
    locationId: fixture.location.id,
    accountId: account.id
  })
  const id = requireApiSuccessId(
    await api.postBusiness(WMS_QC_FORMAL_CONTRACTS.saleReturn.erpCreate, payload),
    '正式销售退货创建'
  )
  remember(caseRecord, { kind: 'saleReturn', id, marker: fixture.marker, payload, retained: false })
  const detail = requireSuccess(await api.getBusiness(
    `${WMS_QC_FORMAL_CONTRACTS.saleReturn.erpGet}?id=${encodeURIComponent(id)}`
  ), '销售退货创建后状态回读')
  const item = detail?.items?.[0]
  const owned = Boolean(item?.id) &&
    sameId(detail?.srcBillId, order.id) &&
    sameId(item.srcEntryId, order.item.id) &&
    isOwnedFixture(detail, fixture.marker)
  addCheck(caseRecord, '正式销售退货创建后回读订单来源及实际生效状态', owned &&
    text(detail?.srcBillType) === 'SalOrder' && sameId(detail?.id, id),
  `returnId=${id}; orderId=${order.id}; itemId=${item?.id || ''}; status=${detail?.status}; billStage=${detail?.billStage}; isEffective=${detail?.isEffective}`)
  return { id, detail, item, payload }
}

const runQc001 = async (api, page, record, caseRecord, outputDir, deps, fixture) => {
  const { supplier, account, order, inbound, inspection, artifacts } = await prepareQualifiedPurchaseInbound(api, caseRecord, fixture)
  const control = await createWmsQcNonInspectionControl(api, caseRecord, fixture, supplier, { ...deps, record })
  const positiveBefore = await inventorySnapshot(api, fixture, fixture.material.id)
  const controlBefore = await inventorySnapshot(api, control.fixture, control.fixture.material.id)
  const reverseFixture = await (deps.prepareWmsFixture || prepareWmsFixture)(api, caseRecord, 12)
  reverseFixture.marker = `${wmsQcMarker('WMS-QC-001')}-REVERSE`
  if (sameId(reverseFixture.material.id, fixture.material.id) ||
      sameId(reverseFixture.material.id, control.fixture.material.id) ||
      sameId(reverseFixture.warehouse.id, fixture.warehouse.id)) {
    throw new Error('BLOCKED: QC001 反向样本必须独立仓库物料，不能复用正样本余额')
  }
  requireOwnedStockDimensions(caseRecord, reverseFixture)
  const baseline = await inventorySnapshot(api, reverseFixture, reverseFixture.material.id)
  if (inventoryTotals(baseline).qty !== 0) throw new Error('BLOCKED: QC001 反向样本已有库存')
  const reversePrepared = await prepareQualifiedPurchaseInbound(api, caseRecord, reverseFixture)
  await verifyWmsQcInboundReversal(api, caseRecord, reverseFixture, reversePrepared, baseline)
  const unaffected = isDeepStrictEqual(positiveBefore, await inventorySnapshot(api, fixture, fixture.material.id)) &&
    isDeepStrictEqual(controlBefore, await inventorySnapshot(api, control.fixture, control.fixture.material.id))
  addCheck(caseRecord, 'QC001 反向流程不影响正样本和非质检对照', unaffected)
  if (!unaffected) throw new Error('QC001 反向流程改变了其他样本余额')
  const purchaseReturn = await createPurchaseReturn(
    api, caseRecord, fixture, supplier, fixture.material, order, account
  )
  await capturePageEvidence({
    page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot, outputDir, record, caseRecord,
    route: '/erp/purchase/return', marker: fixture.marker,
    fields: ['采购退货', '退货类型', '退货单号'],
    readySelector: 'input[placeholder="请输入退货单号"]',
    filter: { placeholder: '请输入退货单号', value: purchaseReturn.detail.billNo },
    name: 'wms-qc-001-purchase-return'
  })
  await capturePageEvidence({
    page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot, outputDir, record, caseRecord,
    route: `/quality/order/formDetail/${inspection.inspectionId}`, marker: inspection.detail.billNo,
    fields: ['质检', '来源', '检验结论', '全部合格', fixture.material.code,
      inbound.wms.billNo, artifacts.item.row.itemName],
    sample: { selector: '.material-summary-card__code', value: fixture.material.code },
    readyText: inspection.detail.billNo,
    name: 'wms-qc-001-inbound'
  })
  const inventoryRoute = await resolveWmsQcMenuRoute(api, 'wms/stock/reportForms/standingStock/index')
  await capturePageEvidence({
    page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot, outputDir, record, caseRecord,
    route: inventoryRoute, marker: control.fixture.material.code,
    fields: ['库存', '可用', '锁定'],
    readySelector: 'input[placeholder="请输入存货编码"]',
    filter: { placeholder: '请输入存货编码', value: control.fixture.material.code },
    name: 'wms-qc-001-non-qc-inventory'
  })
  addEvidence(caseRecord, `采购入库 ${inbound.id} -> WMS 101/${inbound.wms.id} -> 来源质检 ${inspection.inspectionId} -> 采购退货 ${purchaseReturn.id}（按实际状态回读），含库存前后快照和页面截图`)
  return { fixture, inbound, inspection, purchaseReturn, control, reversePrepared }
}

const createSalesOrder = async (api, caseRecord, fixture, customer) => {
  const payload = buildSaleOrderPayload({
    marker: fixture.marker,
    customerId: customer.id,
    materialId: fixture.material.id,
    unitId: fixture.material.unitId,
    billNo: `${fixture.marker}-SO`
  })
  const id = requireApiSuccessId(await api.postBusiness('/erp/sale-order/create', payload), '正式销售订单')
  remember(caseRecord, { kind: 'saleOrder', id, marker: fixture.marker, payload, retained: false })
  const detail = await approveWhenNeeded(
    api,
    '/erp/sale-order/get',
    '/erp/sale-order/update-status',
    id,
    '正式销售订单',
    20,
    10
  )
  const item = detail?.items?.[0]
  if (!item?.id || !isOwnedFixture(detail, fixture.marker)) throw new Error(`BLOCKED: 正式销售订单回读失败：${id}`)
  addCheck(caseRecord, '正式销售订单审核和行来源回读', true, `orderId=${id}; itemId=${item.id}`)
  return { id, detail, item }
}

const runQc002 = async (api, page, record, caseRecord, outputDir, deps, fixture, inbound) => {
  const artifacts = await (deps.createQualityArtifacts || createQualityArtifacts)(
    api, caseRecord, fixture, fixture.material, '201')
  const customer = await createPartner(api, caseRecord, fixture.marker, 'CUSTOMER')
  const account = await readAccount(api)
  const order = await createSalesOrder(api, caseRecord, fixture, customer)
  const atp = await verifyWmsAtp(api, caseRecord, {
    orderId: order.id,
    materialId: fixture.material.id
  })
  if (!atp.passed) {
    throw new Error(`BLOCKED: ATP 反向校验未通过，停止销售出库写侧：order=${order.id}`)
  }
  const before = await inventorySnapshot(api, fixture, fixture.material.id)
  const availableBefore = before.reduce((sum, row) => sum + Number(row.availableQty || 0), 0)
  addCheck(caseRecord, '销售订单前置拥有可用库存样本', availableBefore > 0,
    `material=${fixture.material.id}; available=${availableBefore}; inbound=${inbound.id}`)
  const outboundPayload = {
    businessType: 'NORMAL',
    orderId: String(order.id),
    accountId: String(account.id),
    outTime: nowDateTime(),
    discountPercent: 0,
    otherPrice: 0,
    remark: fixture.marker,
    items: [{
      orderItemId: String(order.item.id),
      warehouseId: String(fixture.warehouse.id),
      productId: String(fixture.material.id),
      productUnitId: String(fixture.material.unitId),
      productPrice: defaultMoney,
      count: defaultQty,
      taxPercent: 0,
      remark: fixture.marker
    }]
  }
  const saleOutId = requireApiSuccessId(
    await api.postBusiness('/erp/sale-out/create', outboundPayload),
    '正式销售出库'
  )
  remember(caseRecord, { kind: 'saleOut', id: saleOutId, marker: fixture.marker, payload: outboundPayload, retained: false })
  const saleOut = await approveWhenNeeded(
    api,
    '/erp/sale-out/get',
    '/erp/sale-out/update-status',
    saleOutId,
    '正式销售出库'
  )
  const wms = await readSourceWmsBill(api, 'ErpSaleOut', saleOutId)
  addCheck(caseRecord, '正式销售出库生成 201 WMS 来源流水', Boolean(wms) &&
    text(wms.stockIoType) === '201' && text(wms.srcBillType) === 'ErpSaleOut',
  `saleOut=${saleOutId}; wms=${wms?.id || ''}; status=${saleOut?.status}`)
  const execution = await (deps.verifyWmsQcOutboundClosure || verifyWmsQcOutboundClosure)(api, caseRecord, fixture,
    { id: saleOutId, payload: outboundPayload }, wms.id, before, artifacts, deps)
  const after = execution.after
  addGap(caseRecord, 'multi-line-partial-execution',
    '原断言「按行部分执行」/检查「正式销售出库按多行部分执行且各行来源可回读」未执行：' +
    '本轮仅创建一条销售订单明细，单行扣减不能证明多行部分执行。')
  addCheck(caseRecord, '正式销售出库后库存总量守恒', after.every(inventoryConserved),
    `rows=${after.length}`)
  addNote(caseRecord, `DEFERRED ${WMS_QC_DEFERRED_CONTRACTS.wmsAtp.reason}`)
  const saleReturn = await createSaleReturn(
    api, caseRecord, fixture, customer, fixture.material, order, account
  )
  await captureQc002Pages({
    api, page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot,
    outputDir, record, caseRecord, wms, saleReturn
  })
  addEvidence(caseRecord, `销售订单 ${order.id} -> 销售出库 ${saleOutId} -> WMS 201 来源 -> 销售退货 ${saleReturn.id}（按实际状态回读），库存前后按行快照已留证`)
  return { saleOut, saleReturn, partial: true }
}

const runQc003 = async (api, page, record, caseRecord, outputDir, deps, fixture, inbound) => {
  await verifyWmsQcDuplicateAudit(api, caseRecord, fixture, inbound)
  await verifyWmsQcInvalidPurchaseLine(api, caseRecord, fixture, inbound)
  const inventory = await inventorySnapshot(api, fixture, fixture.material.id)
  addCheck(caseRecord, '专属库存余额可回读并保留库存守恒字段',
    inventory.length > 0 && inventory.every(inventoryConserved),
    `wms=${inbound.wms.id}; inventory=${inventory.length}`)
  const context = { page, record, check: deps.check }
  const results = {}
  for (const [key, run] of [
    ['tenant-isolation', () => verifyWmsQcTenantIsolation(api, context, caseRecord, fixture, inbound, deps)],
    ['low-privilege', () => verifyWmsQcLowPrivilege(api, context, caseRecord, fixture, inbound, deps)],
    ['post-persist-rollback', () => verifyWmsQcTransactionRollback(api, caseRecord, fixture, inbound, deps)],
    ['flow-balance-match', () => verifyWmsQcFlowBalance(api, caseRecord, fixture, inbound, deps)]
  ]) {
    try {
      results[key] = await run()
    } catch (error) {
      if (!String(error?.message).startsWith('BLOCKED:')) throw error
      addGap(caseRecord, key, error.message, 'BLOCKED')
    }
  }
  const route = await resolveWmsQcMenuRoute(api, 'wms/stock/reportForms/standingStock/index')
  await capturePageEvidence({
    page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot, outputDir, record, caseRecord,
    route, marker: fixture.material.code,
    fields: ['库存', '可用', '锁定'],
    readySelector: 'input[placeholder="请输入存货编码"]',
    filter: { placeholder: '请输入存货编码', value: fixture.material.code },
    name: 'wms-qc-003-inventory'
  })
  addEvidence(caseRecord, 'QC003 已按真实隔离登录、状态安全的低权限 execute、正式流水及两行不足编排；只按实际精确结果映射，产品门禁缺口保留。')
  return { partial: true, results }
}

const runQc005 = async (api, page, record, caseRecord, outputDir, deps, fixture) => {
  const openingBody = {
    billNo: `${fixture.marker}-106`,
    billDate: nowDate(),
    subject: fixture.marker,
    remark: fixture.marker,
    stockIoType: '106',
    isAuto: 0,
    stkIoEntryList: [{
      materialId: String(fixture.material.id),
      unitId: String(fixture.material.unitId),
      qty: 106,
      cost: 1,
      warehouseId: String(fixture.warehouse.id),
      wareAreaId: String(fixture.area.id),
      wareLocationId: String(fixture.location.id),
      batchNo: `${fixture.marker}-OPENING`,
      entryNo: 1,
      stockIoType: '106',
      stockIoDirection: '1',
      isQc: 0,
      settleQty: 106
    }],
    stkIoDistributionList: [],
    stkIoBomList: []
  }
  const id = requireApiSuccessId(await api.postBusiness('/mes/stkIo/add/submit', openingBody), '正式 106 期初')
  remember(caseRecord, { kind: 'opening', id, marker: fixture.marker, retained: true, body: openingBody })
  let detail = dataOf(await api.getBusiness(
    `/mes/stkIo/queryById?id=${encodeURIComponent(id)}`
  ))
  if (Number(detail?.isEffective || 0) !== 1) {
    await api.putBusiness('/mes/stkIo/check', {
      id: String(id),
      approvalResultType: '1',
      approvalRemark: `${fixture.marker} approve opening`
    })
    detail = dataOf(await api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(id)}`
    ))
  }
  if (Number(detail?.isEffective || 0) !== 1) {
    throw new Error(`BLOCKED: 正式 106 期初审核后未生效：${id}`)
  }
  const duplicate = await api.post('/mes/stkIo/add/submit', openingBody, {
    expectedBusinessRejection: { code: 500, message: /Duplicate entry|已存在|重复/, allowServiceCode: true }
  })
  addCheck(caseRecord, '同库存维度重复提交 106 期初被拒绝且不产生第二单', isBusinessRejection(duplicate),
    `code=${duplicate?.code}; message=${duplicate?.msg || duplicate?.message || ''}`)
  const edit = await api.put('/mes/stkIo/edit/submit', { ...openingBody, id }, {
    expectedBusinessRejection: { code: 500, message: /不能直接修改|反审核|生效/, allowServiceCode: true }
  })
  addCheck(caseRecord, '106 期初生效后直接编辑被正式 API 拒绝', isBusinessRejection(edit),
    `code=${edit?.code}; message=${edit?.msg || edit?.message || ''}`)
  addCheck(caseRecord, '106 期初错误修正红冲链路', false, WMS_QC_DEFERRED_CONTRACTS.redInvoice.reason)
  addNote(caseRecord, `DEFERRED ${WMS_QC_DEFERRED_CONTRACTS.redInvoice.reason}`)
  await capturePageEvidence({
    page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot, outputDir, record, caseRecord,
    route: '/wms/stock/beginningInventory', marker: fixture.marker,
    fields: ['库存期初', '导入'],
    name: 'wms-qc-005-opening'
  })
  addEvidence(caseRecord, `106 期初 ${id} 已生效=${detail.isEffective}; 重复提交/生效编辑拒绝和页面入口已留证`)
  return { partial: true }
}

const runQc009 = async (api, page, record, caseRecord, outputDir, deps, fixture) => {
  const value = `${fixture.marker}-BUSINESS-IN`
  const dictionaryBody = {
    sort: 9999,
    label: `${fixture.marker} 企业入库`,
    value,
    dictType: 'wms_business_io_type',
    status: 0,
    colorType: 'default',
    cssClass: '',
    remark: fixture.marker
  }
  const dictionaryId = requireApiSuccessId(await api.postBusiness('/system/dict-data/create', dictionaryBody), 'QC-009 专属字典')
  remember(caseRecord, { kind: 'dictionary', id: dictionaryId, marker: fixture.marker, body: dictionaryBody, retained: false })
  const invalid = await api.post('/mes/stkIo/add/save', {
    billNo: `${fixture.marker}-INVALID`,
    businessTypeCode: `${value}-UNKNOWN`,
    stockIoType: '106',
    stkIoEntryList: []
  }, { expectedBusinessRejection: { code: 500, message: /业务出入库类型/, allowServiceCode: true } })
  addCheck(caseRecord, '企业业务类型不在字典时正式保存被拒绝', isBusinessRejection(invalid),
    `code=${invalid?.code}; message=${invalid?.msg || invalid?.message || ''}`)
  const draftBody = {
    billNo: `${fixture.marker}-DRAFT`,
    billDate: nowDate(),
    subject: fixture.marker,
    remark: fixture.marker,
    stockIoType: '106',
    businessTypeCode: value,
    isAuto: 0,
    stkIoEntryList: [{
      materialId: String(fixture.material.id),
      unitId: String(fixture.material.unitId),
      qty: 1,
      cost: 1,
      warehouseId: String(fixture.warehouse.id),
      wareAreaId: String(fixture.area.id),
      wareLocationId: String(fixture.location.id),
      batchNo: `${fixture.marker}-QC009`,
      entryNo: 1,
      stockIoType: '106',
      stockIoDirection: '1',
      isQc: 0,
      settleQty: 1
    }],
    stkIoDistributionList: [],
    stkIoBomList: []
  }
  const saved = await api.postBusiness('/mes/stkIo/add/save', draftBody)
  const draftRows = pageRows(await api.getBusiness(
    `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(draftBody.billNo)}`
  ), 'QC-009 正式草稿')
  const draft = draftRows.find((row) => sameId(row?.billNo, draftBody.billNo))
  addCheck(caseRecord, '合法企业业务类型正式保存并按单号回读草稿', isBusinessSuccess(saved) && Boolean(draft?.id),
    `billNo=${draftBody.billNo}; id=${draft?.id || ''}`)
  const coreTypes = pageRows(await api.getBusiness('/wms/business-io-type-rule/core-types'), 'QC-009 核心类型')
  const inbound = coreTypes.find((row) => text(row.direction).toUpperCase() === 'IN' && text(row.code) !== '106')
  const mapping = inbound
    ? await api.postBusiness('/wms/business-io-type-rule/create', {
      businessTypeCode: value,
      businessTypeName: dictionaryBody.label,
      coreStockIoType: inbound.code,
      active: true,
      remark: fixture.marker
    })
    : null
  const mappingId = mapping ? requireApiSuccessId(mapping, 'QC-009 专属映射') : null
  if (mappingId) remember(caseRecord, { kind: 'mapping', id: mappingId, marker: fixture.marker, retained: false })
  addCheck(caseRecord, '企业业务类型启用映射后核心方向来自正式规则', Boolean(mappingId) &&
    text(inbound.direction).toUpperCase() === 'IN', `mappingId=${mappingId || ''}; core=${inbound?.code || ''}`)
  await capturePageEvidence({
    page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot, outputDir, record, caseRecord,
    route: '/wms/settings/business-io-type', marker: fixture.marker,
    fields: ['业务出入库类型', '映射规则'],
    name: 'wms-qc-009-business-type'
  })
  addEvidence(caseRecord, `字典 ${dictionaryId}、草稿 ${draft?.id || ''}、映射 ${mappingId || ''} 使用正式 API 串行验证`)
  return { partial: true }
}

const runQc010 = async (api, page, record, caseRecord, outputDir, deps, fixture) => {
  const response = await api.getBusiness('/erp/warehouse/page?pageNo=1&pageSize=100')
  const rows = pageRows(response, '旧 ERP 仓库兼容视图')
  const projection = rows.length === 0 || rows.every((row) =>
    row?.id != null && typeof row?.name === 'string' &&
    Object.prototype.hasOwnProperty.call(row, 'status'))
  addCheck(caseRecord, '旧 ERP 仓库兼容视图读侧返回主键、名称和状态投影', projection,
    `rows=${rows.length}`)
  const retiredCode = 1030400002
  const probeId = rows[0]?.id ?? '1'
  const writes = [
    ['create', (options) => api.post('/erp/warehouse/create', {
      name: `${fixture.marker} retired probe`,
      sort: '1',
      status: 0
    }, options)],
    ['update', (options) => api.put('/erp/warehouse/update', {
      id: String(probeId),
      name: `${fixture.marker} retired probe`,
      sort: '1',
      status: 0
    }, options)],
    ['delete', (options) => api.delete(
      `/erp/warehouse/delete?id=${encodeURIComponent(probeId)}`, options)],
    ['update-default-status', (options) => api.put(
      `/erp/warehouse/update-default-status?id=${encodeURIComponent(probeId)}&defaultStatus=false`,
      options)]
  ]
  const retiredChecks = []
  for (const [label, invoke] of writes) {
    const response = await invoke({ expectedBusinessRejection: true })
    const passed = isBusinessRejection(response) && Number(response?.code) === retiredCode
    retiredChecks.push(passed)
    addCheck(caseRecord, `旧 ERP 仓库写侧 ${label} 返回退役错误码`, passed,
      `code=${response?.code}; msg=${response?.msg || response?.message || ''}`)
  }
  addCheck(caseRecord, '旧 ERP 仓库四个写接口统一返回退役错误码',
    retiredChecks.length === writes.length && retiredChecks.every(Boolean),
    `retiredCode=${retiredCode}; passed=${retiredChecks.filter(Boolean).length}/${writes.length}`)
  addCheck(caseRecord, '旧 erp_warehouse 视图主键和历史单据引用已完成 SQL 对账', false,
    '需要后端只读 SQL/迁移证据，fixture 不越权猜测')
  addCheck(caseRecord, '镜像补齐任务已停止旧表写入', false, WMS_QC_DEFERRED_CONTRACTS.legacyMirrorJob.reason)
  addNote(caseRecord, `DEFERRED ${WMS_QC_DEFERRED_CONTRACTS.legacyMirrorJob.reason}`)
  await capturePageEvidence({
    page, openRoute: deps.openRoute, saveScreenshot: deps.saveScreenshot, outputDir, record, caseRecord,
    route: '/base/warehouseConfig/archives', marker: fixture.marker,
    fields: ['仓库', '仓库编码'],
    name: 'wms-qc-010-warehouse'
  })
  addEvidence(caseRecord, `旧 ERP 仓库分页读侧 ${rows.length} 行及仓库档案页面已留证；视图/镜像任务缺口保留`)
  return { partial: true }
}

const catalogContract = Object.freeze({
  'WMS-QC-001': [
    ['入库检只对质检存货触发', [
      '正式采购入库生成 101 WMS 来源单和明细',
      '正式质检单含来源明细和项目明细并审核生效',
      '非质检存货不生成采购入库检'
    ]],
    ['未放行只有 hold/pendingPutaway', ['采购入库审核后质检库存先进入 hold/pendingPutaway']],
    ['放行后进入 available', ['正式质检放行后 available 增量等于 hold 减量']],
    ['库存守恒', ['质检放行前后库存总量守恒']]
  ],
  'WMS-QC-002': [
    ['ATP 由 WMS 提供', ['销售订单 ATP 等于 WMS 可用量加正式调拨在途且查询不写库存']],
    ['考虑预留和在途', ['ATP 正数预留及在途对照且未二次扣减 lockQty']],
    ['按行部分执行', ['正式销售出库按多行部分执行且各行来源可回读']],
    ['出库检不合格阻断发货完成', [
      '正式 OQC 不合格结论审核生效',
      'OQC 不合格 execute 精确拒绝',
      'OQC 拒绝前后 ERP、WMS、质检、库存及调整审计完整不变'
    ]],
    ['发运后库存守恒', [
      '正式 OQC 复检合格结论审核生效',
      'WMS201 来源单经正式 check/execute 生效并回写库存',
      'OQC 复检放行后出库数量与库存六分量守恒',
      'OQC 放行出库重复 execute 精确拒绝且完整事实不变'
    ]]
  ],
  'WMS-QC-003': [
    ['跨租户不可读写', ['跨租户读写隔离已由独立会话证明']],
    ['无权限返回业务拒绝', ['低权限账号业务拒绝已由正式账号证明']],
    ['重复审核不重复扣减', [
      '重复审核正式 WMS 单据不允许二次执行',
      '重复审核前后正式主单、来源明细和专属库存完全不变'
    ]],
    ['多行失败整体回滚', [
      '两明细各自足量但合计不足触发库存循环中途精确拒绝',
      '两明细合计不足拒绝后主单明细库存流水及 SQL 全部回滚'
    ]],
    ['流水和余额同时一致', [
      '正式 report/view 流水逐行匹配主单明细与方向',
      '正式 report/view 有效流水与库存完整物理维度余额一致',
      '流水余额查询不改变管理员 API/SQL 完整事实'
    ]]
  ],
  'WMS-QC-005': [
    ['同一上线基准日、仓库、库区、库位、存货和批次的库存维度不能跨导入重复生成 106 草稿', ['同库存维度重复提交 106 期初被拒绝且不产生第二单']],
    ['重复导入行返回失败明细和已存在的期初单号，不写入新单据', ['同库存维度重复提交 106 期初被拒绝且不产生第二单']],
    ['106 期初已生效时不能直接编辑，必须先反审核', ['106 期初生效后直接编辑被正式 API 拒绝']],
    ['上线基准日之后已有正式库存业务时，期初单据不能继续直接编辑', []],
    ['错误修正只能走反审核、红冲或库存调整的受控链路', ['106 期初错误修正红冲链路']],
    ['期初库存审核后仍只通过 mes_stk_inventory 形成唯一实物库存事实', []]
  ],
  'WMS-QC-009': [
    ['企业自定义出入库类型可直接在字典新增，不强制要求配置映射规则', ['合法企业业务类型正式保存并按单号回读草稿']],
    ['未配置映射规则时仅快照企业业务类型名称，核心出入库类型与库存方向沿用表单选择', ['合法企业业务类型正式保存并按单号回读草稿']],
    ['企业业务类型编码必须来自字典 wms_business_io_type，非字典编码被后端拒绝', ['企业业务类型不在字典时正式保存被拒绝']],
    ['已配置启用状态的映射规则时，核心库存类型收敛到规则值并做方向一致性校验', ['企业业务类型启用映射后核心方向来自正式规则']]
  ],
  'WMS-QC-010': [
    ['仓库主档唯一事实源为 mes_wms_ware_house，旧 erp_warehouse 已停写并退役为只读视图', ['旧 ERP 仓库兼容视图读侧返回主键、名称和状态投影']],
    ['旧 erp_warehouse 视图主键与 mes_wms_ware_house.id 同源，ERP 单据既有仓库 ID 语义不变', []],
    ['视图 status 按 is_enabled 投影为 0/1，仓储费/搬运费/排序/默认标记投影为默认值', ['旧 ERP 仓库兼容视图读侧返回主键、名称和状态投影']],
    ['镜像补齐任务改为只读对账，不再向旧表写入', ['镜像补齐任务已停止旧表写入']],
    ['旧 erp_warehouse 分页读侧仍返回公共仓库数据', ['旧 ERP 仓库兼容视图读侧返回主键、名称和状态投影']],
    ['新增/更新/删除/切换默认状态四个旧写接口统一返回退役错误码 1030400002，而不是底层视图不可更新的 500', ['旧 ERP 仓库四个写接口统一返回退役错误码']]
  ]
})

export function mapWmsQcCatalogAssertions (caseRecord, caseId) {
  const definitions = catalogContract[caseId] || []
  const assertions = definitions.map(([assertion, names], index) => {
    const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
    const passed = names.length > 0 && checks.every((check) => check?.passed === true)
    return {
      index,
      assertion,
      status: passed ? 'VERIFIED' : 'GAP',
      evidenceChecks: names,
      details: passed
        ? checks.map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : '本轮未形成完整正式写侧证据'
    }
  })
  caseRecord.catalogAssertions = assertions
  caseRecord.remainingAssertions = assertions.filter((item) => item.status !== 'VERIFIED')
    .map((item) => item.assertion)
  if (caseId === 'WMS-QC-001') {
    const names = [
      '质检弃审 available 等量回退 hold 且总量守恒',
      '采购入库弃审撤销本轮库存且来源单据回读未生效',
      'QC001 反向流程不影响正样本和非质检对照'
    ]
    const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
    const passed = checks.every((check) => check?.passed === true)
    caseRecord.catalogReverseAssertions = [{
      assertion: '入库弃审先 available→hold，再撤销入库',
      status: passed ? 'VERIFIED' : 'GAP',
      evidenceChecks: names,
      details: passed ? '独立专属样本分两步正式 API 回退并回读，未修改其他样本余额'
        : '本轮尚未完成 available→hold→撤销入库的正式反向证据'
    }]
    if (!passed) caseRecord.remainingAssertions.push(caseRecord.catalogReverseAssertions[0].assertion)
  }
  if (caseId === 'WMS-QC-003') {
    caseRecord.catalogReverseAssertions = [{
      assertion: '保留不可变流水，按业务冲销恢复',
      status: 'GAP',
      evidenceChecks: [],
      details: '正式 report/view 是单据视图；余额对账不代替不可变日志或正式冲销恢复证据'
    }]
    caseRecord.remainingAssertions.push(caseRecord.catalogReverseAssertions[0].assertion)
  }
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed === true) &&
    !(caseRecord.contractGaps || []).length
  addNote(caseRecord, `WMS-QC 独立 fixture 已接线；PASS候选=${caseRecord.passCandidate}；剩余=${caseRecord.remainingAssertions.join('；') || '无'}`)
  return caseRecord
}

export async function capturePageEvidence ({
  page, openRoute, saveScreenshot, outputDir, record, caseRecord, route, marker, fields = [], name,
  readySelector, readyText, filter, sample
} = {}) {
  if (!page || typeof openRoute !== 'function' || typeof saveScreenshot !== 'function') {
    addCheck(caseRecord, `${name || route}页面证据可执行`, false, '缺少真实 browser/openRoute/saveScreenshot，未伪造页面通过')
    return { passed: false, deferred: true }
  }
  await openRoute(page, route, { readySelector, readyText })
  if (filter) {
    if (!text(filter.value) || !text(filter.placeholder)) {
      throw new Error('BLOCKED: 页面筛选缺少本轮正式样本标识')
    }
    const input = page.getByPlaceholder(filter.placeholder, { exact: true })
    await input.fill(filter.value)
    await input.press('Enter')
    // Require a real grid row, not the filter input, to carry the sample marker.
    const match = filter.exact === true
      ? { has: page.getByText(filter.value, { exact: true }) } : { hasText: filter.value }
    await page.locator('.vxe-body--row, .el-table__row').filter(match)
      .first().waitFor({ state: 'visible', timeout: 30000 })
  }
  if (sample) {
    if (!text(sample.selector) || !text(sample.value)) {
      throw new Error('BLOCKED: 页面详情缺少本轮正式样本标识')
    }
    await page.locator(sample.selector).filter({ hasText: sample.value })
      .first().waitFor({ state: 'visible', timeout: 30000 })
  }
  const pathname = new URL(page.url()).pathname
  const bodyText = await page.locator('body').innerText()
  const missing = fields.filter((field) => !bodyText.includes(field))
  const markerVisible = !marker || bodyText.includes(marker)
  const passed = pathname === route && missing.length === 0 && markerVisible
  addCheck(caseRecord, `${name || route}页面字段、专属标记和截图证据`, passed,
    `${pathname}; missing=${missing.join(',') || 'none'}; marker=${markerVisible}`)
  const screenshot = await saveScreenshot(page, outputDir, name || 'wms-qc-page', record)
  addEvidence(caseRecord, screenshot)
  return { passed, pathname, missing, markerVisible, screenshot }
}

const resolveWmsQcMenuRoute = async (api, component) => {
  const menus = requireSuccess(await api.getBusiness('/system/auth/get-permission-info'), 'WMS 页面权限菜单')?.menus
  const matches = []
  const walk = (nodes, parent = '') => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (typeof node.path !== 'string' || /^https?:\/\//.test(node.path)) continue
      const path = node.path.startsWith('/') ? node.path : `${parent}/${node.path}`.replace(/\/+/g, '/')
      if (node.component === component) matches.push(path)
      walk(node.children, path)
    }
  }
  walk(menus)
  if (!matches.length) throw new Error(`BLOCKED: 真实菜单未暴露 ${component}，不猜测页面路由`)
  return matches[0]
}

const captureQc002Pages = async ({ api, wms, saleReturn, ...options }) => {
  const outboundNo = text(wms?.billNo)
  const returnNo = text(saleReturn?.detail?.billNo)
  if (!outboundNo || !returnNo) throw new Error('BLOCKED: QC002 页面取证缺少正式出库/销售退货回读单号')
  const pages = [
    { component: 'wms/stock/out/sell/index', billNo: outboundNo, placeholder: '请输入出库单号',
      fields: ['出库单号', '单据日期', '客户', '单据阶段'], name: 'wms-qc-002-outbound' },
    { component: 'erp/sale/return/index', billNo: returnNo, placeholder: '请输入退货单号',
      fields: ['退货单号', '退货类型', '客户'], name: 'wms-qc-002-sale-return' }
  ]
  const results = []
  for (const item of pages) {
    const route = await resolveWmsQcMenuRoute(api, item.component)
    results.push(await capturePageEvidence({
      ...options, route, marker: item.billNo, fields: item.fields, name: item.name,
      readySelector: `input[placeholder="${item.placeholder}"]`,
      filter: { placeholder: item.placeholder, value: item.billNo, exact: true }
    }))
  }
  return results
}

const formalKinds = new Set(['purchaseOrder', 'arrivalNotice', 'purchaseInbound', 'purchaseReturn', 'saleOrder', 'saleOut', 'saleReturn'])
const dependencyKinds = new Set(['warehouse', 'area', 'location', 'material', 'qualityMaterial', 'partner', 'qualityArtifact'])

const retainFormalDependencies = (caseRecord) => {
  const fixtures = caseRecord.fixtures || []
  const formal = fixtures.filter((item) => formalKinds.has(item.kind))
  if (!formal.length) return
  // An owned formal document may already have downstream facts even after an interrupted response.
  for (const item of fixtures) {
    if (!formalKinds.has(item.kind) && !dependencyKinds.has(item.kind) && item.kind !== 'stockIo') continue
    item.retained = true
    item.reason = '正式业务审计样本及其依赖保留；cleanup 不弃审、不删除库存事实'
    addNote(caseRecord, `保留 ${item.kind}/${item.id || item.ruleId || item.planId || '创建响应未确认ID'}：${item.reason}`)
  }
}

const cleanupOwnedFormalFixtures = async (api, caseRecord) => {
  retainFormalDependencies(caseRecord)
  const errors = []
  for (const fixture of [...(caseRecord.fixtures || [])].reverse()) {
    if (fixture.retained === true) continue
    try {
      if (fixture.kind === 'dictionary') {
        requireSuccess(await api.deleteBusiness(`/system/dict-data/delete?id=${encodeURIComponent(fixture.id)}`),
          'WMS-QC 临时字典清理')
      } else if (fixture.kind === 'mapping') {
        requireSuccess(await api.deleteBusiness(`/wms/business-io-type-rule/delete?id=${encodeURIComponent(fixture.id)}`),
          'WMS-QC 临时映射清理')
      } else if (fixture.kind === 'partner') {
        const current = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(fixture.id)}`))
        if (current && isOwnedFixture(current, fixture.marker)) {
          requireSuccess(await api.deleteBusiness(`/base/partner/delete?id=${encodeURIComponent(fixture.id)}`),
            'WMS-QC 未引用专属客商清理')
        }
      }
    } catch (error) {
      errors.push(`${fixture.kind}/${fixture.id}: ${error.message}`)
    }
  }
  addCheck(caseRecord, 'WMS-QC 临时非事实夹具清理且正式依赖完整保留', errors.length === 0, errors.join('；'))
  if (errors.length) throw new Error(`正式业务样本清理未完成：${errors.join('；')}`)
}

const cleanupWmsQcFixtures = async (api, caseRecord, cleanup = cleanupWmsFixtures) => {
  await cleanupOwnedFormalFixtures(api, caseRecord)
  await cleanup(api, {
    ...caseRecord,
    fixtures: (caseRecord.fixtures || []).filter((item) => item.retained !== true)
  })
}

export async function runWmsQcClosure ({
  caseId, api, page, record, caseRecord, outputDir, dependencies = {}
} = {}) {
  if (!WMS_QC_CLOSURE_CASES.includes(caseId)) return { designed: true }
  const settings = dependencies.settings || config
  assertWmsQcScope(settings)
  assertLocalWmsWriteTarget(settings)
  if (!isWmsWriteEnabled() && dependencies.allowWrite !== true) {
    addNote(caseRecord, 'BLOCKED: 未设置 CFOR_E2E_WRITE_FIXTURES=true，独立 WMS-QC 写侧未执行。')
    mapWmsQcCatalogAssertions(caseRecord, caseId)
    return { partial: true }
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  addEvidence(caseRecord,
    `WMS-QC 专属 closure 写侧入口：${caseId}；` +
    '正式 ERP 采购入库生成 WMS 来源单，非质检对照单独提交；入口证据不代表案例通过。')
  const prepare = dependencies.prepareWmsFixture || prepareWmsFixture
  let fixture
  let inbound
  let result
  try {
    fixture = await prepare(api, caseRecord, 11)
    fixture.marker = wmsQcMarker(caseId)
    if (caseId === 'WMS-QC-001') {
      result = await withWmsManualOqcScenario(api, caseRecord,
        () => runQc001(api, page, record, caseRecord, outputDir, dependencies, fixture),
        { ...dependencies, settings, config: settings })
    } else if (caseId === 'WMS-QC-002') {
      result = await withWmsManualOqcScenario(api, caseRecord, async () => {
        const prepared = await prepareQualifiedPurchaseInbound(api, caseRecord, fixture)
        inbound = prepared.inbound
        return runQc002(api, page, record, caseRecord, outputDir, dependencies, fixture, inbound)
      }, { ...dependencies, settings, config: settings })
    } else if (caseId === 'WMS-QC-003') {
      const supplier = await createPartner(api, caseRecord, fixture.marker, 'SUPPLIER')
      const account = await readAccount(api)
      const order = await createPurchaseOrder(api, caseRecord, fixture, supplier, fixture.material)
      await createQualityArtifacts(api, caseRecord, fixture, fixture.material)
      inbound = await createPurchaseInbound(api, caseRecord, fixture, supplier, fixture.material, order, account)
      result = await runQc003(api, page, record, caseRecord, outputDir, dependencies, fixture, inbound)
    } else if (caseId === 'WMS-QC-005') {
      result = await runQc005(api, page, record, caseRecord, outputDir, dependencies, fixture)
    } else if (caseId === 'WMS-QC-009') {
      result = await runQc009(api, page, record, caseRecord, outputDir, dependencies, fixture)
    } else {
      result = await runQc010(api, page, record, caseRecord, outputDir, dependencies, fixture)
    }
  } finally {
    if (dependencies.cleanup !== false) {
      try {
        await cleanupWmsQcFixtures(api, caseRecord)
      } catch (error) {
        addNote(caseRecord, `正式 WMS-QC 业务样本清理异常：${error.message}`)
        addCheck(caseRecord, 'WMS-QC 专属清理没有业务异常', false, error.message)
      }
    }
    mapWmsQcCatalogAssertions(caseRecord, caseId)
  }
  return {
    ...(result || {}),
    partial: result?.partial === true || caseRecord.passCandidate !== true
  }
}

export const __internal = {
  auditInboundInspectionWhenNeeded,
  captureQc002Pages,
  catalogContract,
  createPurchaseInbound,
  createPurchaseOrder,
  createQualityArtifacts,
  createSubmittedPurchaseArrivalNotice,
  buildNonQcInboundPayload,
  cleanupOwnedFormalFixtures,
  cleanupWmsQcFixtures,
  dataOf,
  exactStateRejection,
  executeWmsStockBillWhenNeeded,
  inspectionStateRejection,
  qualityVoidDraftMatchesSourceContract,
  pageRows,
  qualifiedInboundPayload,
  releaseInboundInspection,
  requireId,
  runQc002,
  runQc003,
  runQc005,
  runQc010,
  sameId,
  resolveWmsQcMenuRoute,
  stableId,
  stockInspectionSource
}
