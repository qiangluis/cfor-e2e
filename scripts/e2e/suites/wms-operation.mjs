import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['WMS-OP-001']
export const ASN_BASE = '/mes/wms/arrival-notice'
export const ASN_ROUTE = '/wireSideWarehouse/arrivalNotice'
export const FIXTURE_MARK = 'WMS-OP-001 dedicated e2e fixture'
const SOURCE_TYPE = 'MesWmsArrivalNotice'
const RECEIPT_STATUSES = [10, 20, 30]
const validId = (value) => typeof value === 'string'
  ? value.trim() !== ''
  : Number.isSafeInteger(value) && value > 0
const sameId = (left, right) => validId(left) && validId(right) && String(left) === String(right)
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

const dataOf = (payload, label) => {
  assertBusinessSuccess(payload, label)
  if (!Object.hasOwn(payload, 'data')) throw new Error(`${label} 缺少 data；HTTP 200 不能代替业务响应`)
  return payload.data
}

export const operationRows = (payload, label, paged = false) => {
  const data = dataOf(payload, label)
  const rows = paged ? data?.records ?? data?.list : data
  if (!Array.isArray(rows) || rows.length > 100 || rows.some((row) => !object(row) || !validId(row.id))) {
    throw new Error(`${label} 列表响应无效；不能把错误或缺失字段视为空集`)
  }
  if (paged && (!Number.isSafeInteger(data.total) || data.total < rows.length ||
    (rows.length === 0 && data.total !== 0))) {
    throw new Error(`${label} 分页 total 与当前第一页不一致`)
  }
  return rows
}

export const operationDetail = (payload, id, label, nullable = false) => {
  const data = dataOf(payload, label)
  if (nullable && data === null) return null
  if (!object(data) || !sameId(data.id, id)) throw new Error(`${label} 详情缺失、ID 不一致或数字 ID 已丢失精度`)
  return data
}

// Match the page's six-decimal quantity input without rounding away a discrepancy.
export const quantityUnits = (value) => {
  if (!['string', 'number'].includes(typeof value) ||
    (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))) return null
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value))
  return match ? BigInt(match[1]) * 1000000n + BigInt((match[2] || '').padEnd(6, '0')) : null
}
const quantityText = (units) => `${units / 1000000n}.${String(units % 1000000n).padStart(6, '0')}`

export const fixturePrefix = (notice) => {
  const match = /^AUTOTEST-WMS-OP-001-([A-Za-z0-9]+)-ASN$/.exec(notice?.code || '')
  const prefix = match ? `AUTOTEST-WMS-OP-001-${match[1]}` : null
  return prefix && notice.remark === FIXTURE_MARK && notice.supplierShipmentKey === `${prefix}-SHIP`
    ? prefix : null
}

export const arrivalRoute = (menus) => {
  if (!Array.isArray(menus)) throw new Error('权限信息缺少菜单树')
  const matches = new Set()
  const walk = (nodes, parent = '') => {
    for (const node of nodes) {
      if (!object(node) || typeof node.path !== 'string' || /^https?:/.test(node.path)) continue
      const route = node.path.startsWith('/') ? node.path : `${parent}/${node.path}`.replace(/\/+/g, '/')
      const component = String(node.component || '').replace(/^\/?(?:src\/)?views\//, '')
        .replace(/^\/+/, '').replace(/\.vue$/, '').replace(/\/index$/, '')
      if (component === 'wms/arrivalNotice') matches.add(route)
      if (Array.isArray(node.children)) walk(node.children, route)
    }
  }
  walk(menus)
  if (matches.has(ASN_ROUTE)) return ASN_ROUTE
  if (matches.size > 1) throw new Error('BLOCKED: 到货通知菜单入口不唯一，未猜测路由')
  return [...matches][0] || null
}

export const purchaseLinkMissing = (notice, order) => {
  const missing = []
  if (!order) return ['关联采购订单详情为空']
  if (!sameId(notice.purchaseOrderId, order.id)) throw new Error('ASN 与采购订单主键不一致')
  if (!validId(notice.vendorId) || !validId(order.supplierId)) missing.push('ASN/采购订单供应商')
  else if (!sameId(notice.vendorId, order.supplierId)) throw new Error('ASN 与采购订单供应商不一致')
  if (!notice.purchaseOrderCode || !order.billNo) missing.push('ASN/采购订单来源单号')
  else if (notice.purchaseOrderCode !== order.billNo) throw new Error('ASN 与采购订单来源单号不一致')
  if (!Array.isArray(notice.lines) || !notice.lines.length) missing.push('非空 ASN 明细')
  if (!Array.isArray(order.items) || !order.items.length) missing.push('非空采购订单明细')
  if (!Array.isArray(notice.lines) || !notice.lines.length ||
    !Array.isArray(order.items) || !order.items.length) return missing
  const seen = new Set()
  for (const line of notice.lines) {
    if (!object(line) || !validId(line.id) || seen.has(String(line.id))) throw new Error('ASN 明细主键缺失或重复')
    seen.add(String(line.id))
    if (!validId(line.purchaseOrderItemId)) {
      missing.push(`ASN 行 ${line.id} 缺采购订单行 ID`)
      continue
    }
    const item = order.items.find((row) => sameId(row?.id, line.purchaseOrderItemId))
    if (!item || !sameId(item.mid, order.id) || !sameId(item.productId, line.itemId) ||
      !sameId(item.productUnitId, line.unitId)) throw new Error(`ASN 行 ${line.id} 的订单行、物料或单位关联错误`)
    const arrival = quantityUnits(line.arrivalQuantity)
    const received = quantityUnits(line.receivedQuantity)
    const qualified = quantityUnits(line.qualifiedQuantity)
    if (arrival === null || received === null || qualified === null ||
      arrival <= 0n || received > arrival || qualified > received) throw new Error(`ASN 行 ${line.id} 数量事实无效`)
  }
  return missing
}

export const receiptPlan = (notice, warehouseId, key) => {
  if (!RECEIPT_STATUSES.includes(notice.status) || !validId(warehouseId) || !key ||
    !Array.isArray(notice.lines) || !notice.lines.length) throw new Error('BLOCKED: 缺已提交 ASN、收货仓库、统一幂等键或明细')
  const seen = new Set()
  const lines = notice.lines.flatMap((line) => {
    const arrival = quantityUnits(line?.arrivalQuantity)
    const received = quantityUnits(line?.receivedQuantity)
    if (!validId(line?.id) || seen.has(String(line.id)) || !validId(line.itemId) || !validId(line.unitId) ||
      typeof line.iqcCheckFlag !== 'boolean' || arrival === null || received === null ||
      arrival <= 0n || received > arrival) throw new Error('BLOCKED: ASN 明细、数量或需检标志不完整')
    seen.add(String(line.id))
    return arrival === received ? [] : [{
      lineId: String(line.id), warehouseId: String(warehouseId),
      receivedQuantity: quantityText(arrival - received), idempotentKey: key,
      ...(line.batchNo ? { batchNo: line.batchNo } : {})
    }]
  })
  if (!lines.length) throw new Error('BLOCKED: ASN 无正数未收数量')
  return lines
}

export const assertPurchaseRemaining = (notice, order, request) => {
  const requested = new Map()
  for (const line of request) {
    const source = notice.lines.find((row) => sameId(row.id, line.lineId))
    const units = quantityUnits(line.receivedQuantity)
    if (!source || units === null || units <= 0n) throw new Error('BLOCKED: 收货申请缺采购订单行或正数数量')
    const id = String(source.purchaseOrderItemId)
    requested.set(id, (requested.get(id) || 0n) + units)
  }
  for (const [id, units] of requested) {
    const item = order.items.find((row) => sameId(row.id, id))
    const count = quantityUnits(item?.count)
    const received = quantityUnits(item?.inCount)
    const documented = quantityUnits(item?.afterSaveCount)
    if (count === null || received === null || documented === null ||
      units > count - (received > documented ? received : documented)) {
      throw new Error(`BLOCKED: 采购订单行 ${id} 缺数量基线或未入库余量不足`)
    }
  }
}

export const assertReceiptDraft = (bill, entries, notice, request) => {
  if (!validId(bill?.id) || !bill.billNo || String(bill.stockIoType) !== '101' ||
    bill.srcBillType !== SOURCE_TYPE || !sameId(bill.srcBillId, notice.id) || bill.srcNo !== notice.code ||
    String(bill.billStage) !== '12' || bill.isEffective !== 0 || bill.isVoided !== 0 ||
    bill.actions?.delete !== true || bill.idempotentKey !== request[0]?.idempotentKey ||
    !sameId(bill.supplierId, notice.vendorId)) throw new Error('101 草稿来源、幂等键、阶段或可删除状态不符合真实契约')
  if (!request.length || !Array.isArray(entries) || entries.length !== request.length ||
    new Set(request.map((line) => line.idempotentKey)).size !== 1 ||
    new Set(entries.map((line) => String(line?.srcEntryId))).size !== entries.length) {
    throw new Error('101 草稿明细为空、重复或请求幂等键不统一')
  }
  for (const line of request) {
    const source = notice.lines.find((row) => sameId(row.id, line.lineId))
    const entry = entries.find((row) => sameId(row?.srcEntryId, line.lineId))
    const requested = quantityUnits(line.receivedQuantity)
    if (!source || !entry || !validId(entry.id) || !sameId(entry.mid, bill.id) ||
      entry.srcBillType !== SOURCE_TYPE || !sameId(entry.srcBillId, notice.id) || entry.srcNo !== notice.code ||
      String(entry.stockIoType) !== '101' || String(entry.stockIoDirection) !== '1' ||
      !sameId(entry.materialId, source.itemId) || !sameId(entry.unitId, source.unitId) ||
      !sameId(entry.warehouseId, line.warehouseId) || (entry.batchNo || '') !== (line.batchNo || '') ||
      entry.isQc !== (source.iqcCheckFlag ? 1 : 0) ||
      requested === null || requested <= 0n || quantityUnits(source.arrivalQuantity) === null ||
      quantityUnits(source.receivedQuantity) === null ||
      requested > quantityUnits(source.arrivalQuantity) - quantityUnits(source.receivedQuantity) ||
      quantityUnits(entry.qty) === null || quantityUnits(entry.qty) !== requested) {
      throw new Error(`101 草稿明细 ${line.lineId} 未保持 ASN 来源、仓库、物料、单位、批次、质检或数量`)
    }
  }
}

const sourceSnapshot = (notice, order) => JSON.stringify({
  id: notice.id, code: notice.code, status: notice.status, vendorId: notice.vendorId,
  purchaseOrderId: notice.purchaseOrderId, purchaseOrderCode: notice.purchaseOrderCode,
  supplierShipmentKey: notice.supplierShipmentKey, remark: notice.remark,
  lines: notice.lines.map((line) => ({
    id: String(line.id), itemId: line.itemId, unitId: line.unitId, purchaseOrderItemId: line.purchaseOrderItemId,
    arrival: String(quantityUnits(line.arrivalQuantity)), received: String(quantityUnits(line.receivedQuantity)),
    qualified: String(quantityUnits(line.qualifiedQuantity)), iqcCheckFlag: line.iqcCheckFlag, batchNo: line.batchNo
  })).sort((a, b) => a.id.localeCompare(b.id)),
  orderId: order.id, billNo: order.billNo, supplierId: order.supplierId,
  inCount: String(quantityUnits(order.inCount)), afterSaveCount: String(quantityUnits(order.afterSaveCount)),
  items: order.items.map((line) => ({
    id: String(line.id), count: String(quantityUnits(line.count)), inCount: String(quantityUnits(line.inCount)),
    afterSaveCount: String(quantityUnits(line.afterSaveCount))
  })).sort((a, b) => a.id.localeCompare(b.id))
})

export const runCase = async (args = {}, dependencies = {}) => {
  const { page, record, caseRecord, outputDir } = args
  if (!page || !caseRecord) throw new Error('BLOCKED: WMS-OP-001 必须由真实登录上下文执行，缺少页面与证据记录')
  const token = await (dependencies.login || login)(page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record })
  const env = dependencies.env || process.env
  const missing = []
  const check = (name, passed, details) => {
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
    if (!passed) throw new Error(name)
  }
  const readNotice = async (id) => operationDetail(
    await api.getBusiness(`${ASN_BASE}/get?id=${encodeURIComponent(id)}`), id, 'ASN', true)
  const readOrder = async (id) => operationDetail(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(id)}`), id, '采购订单', true)
  const readBills = async (id) => {
    const payload = await api.getBusiness(`/mes/stkIo/list?pageNo=1&pageSize=100&stockIoType=101&srcBillType=${SOURCE_TYPE}&srcBillId=${encodeURIComponent(id)}`)
    const rows = operationRows(payload, '来源 101 单据', true)
    check('101 查询样本严格限定同一 ASN 来源', rows.every((row) =>
      String(row.stockIoType) === '101' && row.srcBillType === SOURCE_TYPE && sameId(row.srcBillId, id)), `ASN=${id}; rows=${rows.length}`)
    return { rows, total: payload.data.total }
  }
  const permissions = dataOf(await api.getBusiness('/system/auth/get-permission-info'), '权限信息')
  if (!object(permissions) || !Array.isArray(permissions.permissions)) throw new Error('权限信息缺少权限列表')
  const route = arrivalRoute(permissions.menus)
  const notices = operationRows(await api.getBusiness(`${ASN_BASE}/page?pageSize=100&withLines=false`), 'ASN')
  const owned = operationRows(await api.getBusiness(`${ASN_BASE}/page?pageSize=100&withLines=false&code=AUTOTEST-WMS-OP-001-`), '专属 ASN')
  const orders = operationRows(await api.getBusiness('/erp/purchase-order/page?pageNo=1&pageSize=100&billNo=AUTOTEST-WMS-OP-001-'), '专属采购订单', true)
  check('ASN 数组与采购订单分页响应契约有效（非业务闭环）', true,
    `ASN sample=${notices.length}; dedicated ASN=${owned.length}; purchase sample=${orders.length}`)
  caseRecord.evidence.push('真实 ASN/采购订单只读响应记录于 result.json 的 api；空集仅是缺前置证据')
  if (!notices.length) missing.push('ASN 分页样本为空')
  if (!orders.length) missing.push('专属采购订单分页样本为空')
  if (!route) missing.push('权限菜单未暴露 wms/arrivalNotice/index')
  else {
    await (dependencies.openRoute || openRoute)(page, route, { readySelector: 'input[placeholder="采购订单编号"]' })
    const headers = await page.locator('.el-table__header-wrapper').innerText()
    check('真实权限菜单到货通知页渲染业务表头', new URL(page.url()).pathname === route &&
      ['通知单编码', '采购订单', '预约月台', '操作'].every((text) => headers.includes(text)), `${route} -> ${page.url()}`)
    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'wms-op-001-readonly', record)
  }
  const selected = env.CFOR_WMS_OP_ASN_ID
    ? [...owned, ...notices].find((row) => sameId(row.id, env.CFOR_WMS_OP_ASN_ID))
    : owned.find((row) => fixturePrefix(row)) || notices[0]
  const notice = env.CFOR_WMS_OP_ASN_ID ? await readNotice(env.CFOR_WMS_OP_ASN_ID)
    : selected ? await readNotice(selected.id) : null
  let order = null
  let bills = { rows: [], total: 0 }
  if (!notice) missing.push('非空 ASN 详情')
  else {
    if (selected && (selected.code !== notice.code || !sameId(selected.purchaseOrderId, notice.purchaseOrderId))) {
      throw new Error('ASN 列表与详情的来源信息不一致')
    }
    order = validId(notice.purchaseOrderId) ? await readOrder(notice.purchaseOrderId) : null
    const linkMissing = purchaseLinkMissing(notice, order)
    missing.push(...linkMissing)
    if (!linkMissing.length) check('ASN 明细关联同一采购订单行、物料、单位及数量事实', true,
      `ASN=${notice.id}; order=${order.id}; lines=${notice.lines.length}`)
    bills = await readBills(notice.id)
    for (const row of bills.rows.slice(0, 3)) {
      const bill = operationDetail(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(row.id)}`), row.id, '101 单据')
      const entries = operationRows(await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(row.id)}`), '101 明细')
      if (!entries.length) missing.push(`101 单据 ${row.id} 明细为空`)
      else if (!linkMissing.length && String(bill.billStage) === '12' && bill.isEffective === 0) {
        const request = entries.map((entry) => ({
          lineId: entry.srcEntryId, warehouseId: entry.warehouseId,
          receivedQuantity: entry.qty, idempotentKey: bill.idempotentKey, batchNo: entry.batchNo
        }))
        assertReceiptDraft(bill, entries, notice, request)
        check('已有 101 草稿详情与 ASN 明细真实关联', true, `bill=${bill.id}; entries=${entries.length}`)
      } else missing.push(`101 单据 ${row.id} 非草稿；仅回读，不推断审核和库存闭环`)
    }
    caseRecord.fixtures = [...(caseRecord.fixtures || []), {
      kind: 'arrival-notice-readonly', id: String(notice.id), code: notice.code,
      purchaseOrderId: notice.purchaseOrderId, receiptBillIds: bills.rows.map((row) => String(row.id))
    }]
  }
  const prefix = fixturePrefix(notice)
  if (!prefix) missing.push('带专属编码、remark 和 supplierShipmentKey 的 AUTOTEST ASN')
  const writeRequested = env.CFOR_WMS_OP_WRITE_FIXTURE === '1'
  if (!writeRequested && !bills.rows.length) {
    missing.push('没有已存在的非空 101 草稿证据（仅可在明确写侧夹具下生成）')
  }
  if (writeRequested) {
    if (config.target !== 'local') missing.push('本地验证环境（禁止生产写侧）')
    if (!env.CFOR_WMS_OP_ASN_ID || !env.CFOR_WMS_OP_WAREHOUSE_ID) missing.push('显式 ASN ID 与专属仓库 ID')
    if (!order || !prefix || order.billNo !== `${prefix}-PO` || order.remark !== FIXTURE_MARK ||
      order.isEffective !== 1 || order.isVoided !== 0 || order.isClosed !== 0) missing.push('同一 AUTOTEST 已生效、未作废且未关闭的采购订单')
    if (!RECEIPT_STATUSES.includes(notice?.status)) missing.push('待质检/待入库/部分入库 ASN')
    if (!Array.isArray(notice?.lines) || notice.lines.some((line) => line.iqcCheckFlag !== false)) {
      missing.push('免检 ASN 行；需检链缺可回收质检单夹具，仅允许只读')
    }
    if (!order || [order.inCount, order.afterSaveCount, ...(order.items || []).flatMap((line) =>
      [line.inCount, line.afterSaveCount])].some((value) => quantityUnits(value) === null)) {
      missing.push('采购订单主表/明细的 inCount 和 afterSaveCount 数量基线')
    }
    if (bills.total !== 0) missing.push('ASN 下已有 101 单据；禁止复用或清理历史单据')
    if (!['wms:arrival-notice:query', 'wms:arrival-notice:receipt', 'ware:inproduct:delete']
      .every((permission) => permissions.permissions.includes(permission))) missing.push('ASN 查询/收货及现有采购入库删除权限')
    if (typeof api.deleteBusiness !== 'function') missing.push('可清理 101 草稿的 DELETE API')
    if (missing.length) throw new Error(`BLOCKED: 未执行任何写侧；缺前置：${[...new Set(missing)].join('；')}`)
    const warehouse = operationDetail(await api.getBusiness(`/mes/wmsWareHouse/queryById?id=${encodeURIComponent(env.CFOR_WMS_OP_WAREHOUSE_ID)}`),
      env.CFOR_WMS_OP_WAREHOUSE_ID, '仓库')
    if (warehouse.code !== `${prefix}-WH` || warehouse.isEnabled !== true ||
      warehouse.areaEnabled !== false || warehouse.locationEnabled !== false) {
      throw new Error('BLOCKED: 缺同一 AUTOTEST 启用的仅仓库维度夹具；未修改仓库主档')
    }
    for (const id of new Set(notice.lines.map((line) => String(line.itemId)))) {
      const material = operationDetail(await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(id)}`), id, '专属物料')
      const lines = notice.lines.filter((line) => sameId(line.itemId, id))
      if (!String(material.code || '').startsWith(`${prefix}-MAT-`) || material.remark !== FIXTURE_MARK ||
        material.inventoryNature !== 'STOCK' || material.isEnabled !== 1 || material.purchased !== 'Y' ||
        material.periodManaged !== 'N' || material.gradeManaged !== 'N' || material.oneBarcode !== 'N' ||
        !lines.every((line) => sameId(line.unitId, material.unitId)) ||
        !['N', 'Y'].includes(material.batchManaged) ||
        (material.batchManaged === 'Y' && lines.some((line) => !line.batchNo))) {
        throw new Error(`BLOCKED: 缺同一 AUTOTEST 可采购实物物料及单位/批次前置 ${id}；未写主数据`)
      }
    }
    // Full remaining quantities avoid creating non-reversible shortage exceptions.
    const key = `${prefix}:RECEIPT:${randomUUID()}`
    const request = receiptPlan(notice, warehouse.id, key)
    assertPurchaseRemaining(notice, order, request)
    const before = sourceSnapshot(notice, order)
    const refreshedNotice = await readNotice(notice.id)
    const refreshedOrder = await readOrder(order.id)
    if (!refreshedNotice || !refreshedOrder || before !== sourceSnapshot(refreshedNotice, refreshedOrder) ||
      (await readBills(notice.id)).total !== 0) {
      throw new Error('BLOCKED: 写前来源或数量已变化，未执行任何收货开单')
    }
    caseRecord.fixtures.push({
      kind: 'receipt-draft-intent', sourceId: String(notice.id), idempotentKey: key, request
    })
    let createdId
    let operationError
    try {
      const created = dataOf(await api.postBusiness(`${ASN_BASE}/create-receipt-bill?id=${encodeURIComponent(notice.id)}`, request), '收货开单')
      if (!validId(created)) throw new Error('收货开单未返回真实草稿 ID')
      createdId = String(created)
      caseRecord.fixtures.push({ kind: 'receipt-draft', id: createdId, sourceId: String(notice.id), idempotentKey: key, request })
      const bill = operationDetail(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(createdId)}`), createdId, '新建 101')
      const entries = operationRows(await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(createdId)}`), '新建 101 明细')
      assertReceiptDraft(bill, entries, notice, request)
      check('真实收货开单只生成可删除的 101 未审核草稿', true, `bill=${createdId}; key=${key}; entries=${entries.length}`)
      const retried = dataOf(await api.postBusiness(`${ASN_BASE}/create-receipt-bill?id=${encodeURIComponent(notice.id)}`, request), '收货幂等重试')
      check('同一收货请求幂等返回同一草稿 ID', sameId(retried, createdId), `first=${createdId}; retry=${retried}`)
      const after = await readBills(notice.id)
      check('同一 ASN 仅新增一张真实 101 草稿', after.total === 1 && after.rows.length === 1 &&
        sameId(after.rows[0].id, createdId), `total=${after.total}`)
      check('草稿未推进 ASN 收货数量或采购订单入库数量', before === sourceSnapshot(
        await readNotice(notice.id), await readOrder(order.id)), `ASN=${notice.id}; order=${order.id}`)
    } catch (error) {
      operationError = error
      caseRecord.notes.push(`收货草稿步骤失败：${error.message}；继续核对并清理本轮来源。`)
    } finally {
      // Recover only this run's key when the server committed but its response was lost.
      const current = await readBills(notice.id)
      if (current.total > current.rows.length) throw new Error(`清理阻塞：101 列表未覆盖全部来源单据，ASN=${notice.id}; key=${key}`)
      const candidates = []
      // The list VO omits idempotentKey; ownership must be read from each real detail.
      for (const row of current.rows) {
        const detail = operationDetail(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(row.id)}`), row.id, '清理候选 101')
        if (detail.idempotentKey === key) candidates.push(detail)
      }
      if (candidates.length > 1 ||
        (createdId && (candidates.length !== 1 || !sameId(candidates[0].id, createdId)))) {
        throw new Error(`清理阻塞：无法唯一定位本轮 101，ASN=${notice.id}; key=${key}; createdId=${createdId || '未知'}`)
      }
      for (const candidate of candidates) {
        const bill = operationDetail(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(candidate.id)}`), candidate.id, '清理前 101')
        if (bill.srcBillType !== SOURCE_TYPE || !sameId(bill.srcBillId, notice.id) || bill.srcNo !== notice.code ||
          bill.idempotentKey !== key || String(bill.stockIoType) !== '101' || String(bill.billStage) !== '12' ||
          bill.isEffective !== 0 || bill.isVoided !== 0 || bill.actions?.delete !== true) {
          throw new Error(`清理阻塞：本轮草稿状态/来源已变化，未删除 ${candidate.id}`)
        }
        dataOf(await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(candidate.id)}`), '清理本轮 101')
        const entries = operationRows(await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(candidate.id)}`), '删除后 101 明细')
        const after = await readBills(notice.id)
        check('DELETE API 已清理本轮 101 主表及明细', after.total === 0 && entries.length === 0, `bill=${candidate.id}`)
        caseRecord.notes.push(`已清理本轮 API 草稿 ${candidate.id}；未删除 ASN、订单、物料或仓库。`)
      }
      check('清理后 ASN 与采购订单来源数量保持不变', before === sourceSnapshot(
        await readNotice(notice.id), await readOrder(order.id)), `ASN=${notice.id}; order=${order.id}`)
    }
    if (operationError) throw operationError
  } else missing.push('写侧未显式启用；未生成、重试或删除入库草稿')
  missing.push('未执行审核/弃审、质检放行、库存余额及流水对账；未覆盖 catalog 其余现场作业断言')
  const note = `PARTIAL：${[...new Set(missing)].join('；')}。HTTP 200、页面渲染及空集不视为完整 PASS。`
  caseRecord.notes.push(note)
  return { token, api, partial: true, note }
}
