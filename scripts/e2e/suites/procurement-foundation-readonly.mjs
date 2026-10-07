import { isBusinessSuccess } from '../lib/assertions.mjs'

const freeze = (value) => {
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') freeze(item)
  }
  return Object.freeze(value)
}

export const procurementFoundationReadonlyRegistry = freeze([
  {
    id: 'PROC-001', title: 'MRP 缺料与 WMS 库存只读前置', pbScope: ['PB-306'],
    safeGet: ['/mes/mrp/history', '/mes/mrp/status/{calculationId}', '/mes/stkInventory/list'],
    unverified: [
      '同一业务时点 WMS ATP、现存/预留/在途参与净需求及建议数量重算',
      '缺料禁止开工、缺料流程触发'
    ]
  },
  {
    id: 'PROC-002', title: 'MRP 请购、订单来源与当前用户待办', pbScope: ['PB-306', 'PB-138', 'PB-139'],
    safeGet: [
      '/erp/purchase/order/request/page', '/erp/purchase/order/request/get',
      '/erp/purchase-order/page', '/erp/purchase-order/get',
      '/mes/mrp/status/{calculationId}', '/bpm/task/todo-page'
    ],
    unverified: [
      '缺料自动生成请购、审批后生成订单、重复 MRP 不重复请购',
      '已预置缺料 BPM 流程及指定审批角色收到待办'
    ]
  },
  {
    id: 'PROC-003', title: '采购发票应付与 ASN 来源只读追溯', pbScope: ['PB-139', 'PB-140', 'PB-141', 'PB-144'],
    safeGet: [
      '/erp/purchase-invoice/page', '/erp/purchase-invoice/get',
      '/finance/finPayable/list', '/finance/finPayable/queryById',
      '/mes/wms/arrival-notice/page', '/mes/wms/arrival-notice/get', '/erp/purchase-order/get'
    ],
    unverified: [
      '订单审核不新增应付、历史订单应付保留与重复挂账阻断',
      '发票复核唯一生成采购应付、重复复核幂等',
      '到货通知必经、WMS 101 入库检未放行阻断可用库存、入库回写订单 inCount及弃审回退'
    ]
  },
  {
    id: 'PROC-004', title: '请购及购销对账开关只读前置', pbScope: ['PB-015', 'PB-016', 'PB-138', 'PB-140', 'PB-141', 'PB-144'],
    safeGet: [
      '/system/config/get', '/erp/purchase/order/request/page', '/erp/purchase/order/request/get',
      '/erp/purchase-order/page', '/erp/purchase-order/get',
      '/erp/purchase-reconciliation/page', '/erp/purchase-reconciliation/get',
      '/erp/purchase-invoice/page', '/erp/purchase-invoice/get',
      '/erp/sale-invoice/page', '/erp/sale-invoice/get'
    ],
    unverified: [
      '请购开启后无有效来源的普通订单拒绝、紧急直采权限与原因门禁',
      '购销对账开关开启后未确认来源开票拒绝、确认来源允许开票',
      '发票持久化对账来源类型/ID/版本快照；当前购销发票 RespVO 未暴露这些字段'
    ]
  },
  {
    id: 'PROC-005', title: '购销订单结算方式与版本快照只读回读', pbScope: ['PB-064', 'PB-139'],
    safeGet: [
      '/system/dict-data/page', '/erp/settle-method-rule/page', '/erp/settle-method-rule/get',
      '/erp/settle-method-rule/list-by-code', '/erp/purchase-order/page', '/erp/purchase-order/get',
      '/erp/sale-order/page', '/erp/sale-order/get'
    ],
    unverified: [
      '订单保存稳定编码、按业务日期命中规则并落版本快照',
      '停用字典值拒绝新建订单、规则调整或停用后历史快照不回溯'
    ]
  }
].map((item) => ({
  ...item, mode: 'READ_ONLY', resultCeiling: 'PARTIAL', auditedOn: '2026-10-06',
  businessSideEffects: '查询链只有 select/Flowable 查询及响应拼装，不创建业务实体或推进状态；通用访问审计不在此结论内',
  prerequisites: ['已有认证 API 客户端与当前租户读权限', '完整验收仍需批准的隔离夹具、流程与角色'],
  evidenceScope: '首100条；各类主样本最多3条、每单最多3条来源回读；非事务快照，不证明全量唯一性'
})))

export const cases = Object.freeze(procurementFoundationReadonlyRegistry.map((item) => item.id))
export const caseRegistry = procurementFoundationReadonlyRegistry

const resources = freeze({
  mrp: { base: '/mes/mrp', page: 'history', shape: 'records', label: 'MRP 历史' },
  inventory: { base: '/mes/stkInventory', page: 'list', shape: 'records', label: 'WMS 实物库存' },
  request: { base: '/erp/purchase/order/request', shape: 'records', label: '请购单' },
  purchase: { base: '/erp/purchase-order', shape: 'list', label: '采购订单' },
  sale: { base: '/erp/sale-order', shape: 'list', label: '销售订单' },
  purchaseInvoice: { base: '/erp/purchase-invoice', shape: 'list', label: '采购发票' },
  saleInvoice: { base: '/erp/sale-invoice', shape: 'list', label: '销售发票' },
  payable: { base: '/finance/finPayable', page: 'list', detail: 'queryById', shape: 'records', label: '应付单' },
  reconciliation: { base: '/erp/purchase-reconciliation', shape: 'list', label: '采购对账' },
  rule: { base: '/erp/settle-method-rule', shape: 'list', label: '结算规则' },
  dict: { base: '/system/dict-data', shape: 'list', label: '结算方式字典' },
  todo: {
    base: '/bpm/task', page: 'todo-page', shape: 'list', label: '当前用户待办',
    identityField: 'processInstanceId', uniqueIdentity: false
  },
  asn: { base: '/mes/wms/arrival-notice', shape: 'array', label: 'ASN 到货通知' }
})

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0
const stable = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) &&
  !['null', 'undefined'].includes(value)) || (Number.isSafeInteger(value) && value > 0)
const sameId = (a, b) => stable(a) && stable(b) && String(a) === String(b)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const decimal = (value) => (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)))
const nullable = (value, predicate) => value == null || predicate(value)
const fact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`FAIL: ${name}${details ? `；${details}` : ''}`)
}
const missing = (record, detail) =>
  record.notes.push(`前置/证据缺口：${detail}；保留 PARTIAL，不以空集判字段、关联或门禁通过`)

function dataOf(payload, label) {
  if (!isBusinessSuccess(payload) || !Object.hasOwn(payload, 'data')) {
    throw new Error(`FAIL: ${label} 业务响应失败或缺少 data`)
  }
  return payload.data
}

export function procurementFoundationReadonlyPage(payload, label, shape = 'list') {
  const data = dataOf(payload, label)
  const rows = shape === 'array' ? data : data?.[shape]
  if (!['array', 'list', 'records'].includes(shape) || !Array.isArray(rows) ||
    (shape !== 'array' && (!object(data) || !count(data.total) ||
      data.total < rows.length || (!rows.length && data.total !== 0))) ||
    rows.length > 100 || rows.some((row) => !object(row))) {
    throw new Error(`FAIL: ${label} 必须返回有效 data.${shape}/total 首100条契约`)
  }
  return { list: rows, total: shape === 'array' ? null : data.total }
}

// Audited controller -> service -> mapper on 2026-10-06. Result uses data,
// IPage uses records; ASN is a limit-100 list without a total or pageNo.
async function get(ctx, path, label) {
  const pathname = path.split('?')[0]
  const permitted = ctx.metadata.safeGet.some((allowed) =>
    allowed === pathname || (allowed === '/mes/mrp/status/{calculationId}' &&
      /^\/mes\/mrp\/status\/[A-Za-z0-9_-]+$/.test(pathname)))
  fact(ctx.record, `${label} GET 白名单`, permitted)
  let payload
  try {
    payload = await ctx.api.getBusiness(path)
  } catch {
    // Shared clients can include financial bodies in errors. Do not echo them.
    fact(ctx.record, `${label} GET 请求成功`, false, pathname)
  }
  fact(ctx.record, `${label} 业务响应成功`,
    isBusinessSuccess(payload) && Object.hasOwn(payload, 'data'), pathname)
  return payload
}

function identities(ctx, rows, label, field = 'id', uniqueIdentity = true) {
  if (!rows.length) return
  fact(ctx.record, `${label} 非空记录稳定 ${field}`,
    rows.every((row) => stable(row[field])) &&
      (!uniqueIdentity ||
        new Set(rows.map((row) => String(row[field]))).size === rows.length))
}

async function readPage(ctx, kind) {
  const resource = resources[kind]
  const query = kind === 'asn' ? 'pageSize=100&withLines=true'
    : `pageNo=1&pageSize=100${kind === 'dict' ? '&dictType=x_settle_method' : ''}`
  const path = `${resource.base}/${resource.page || 'page'}?${query}`
  const result = procurementFoundationReadonlyPage(await get(ctx, path, resource.label),
    resource.label, resource.shape)
  fact(ctx.record, `${resource.label} 只读列表结构`, true,
    `rows=${result.list.length}, total=${result.total ?? '未提供'}；仅查询样本`)
  identities(ctx, result.list, resource.label,
    resource.identityField || 'id', resource.uniqueIdentity !== false)
  if (!result.list.length) missing(ctx.record, `${resource.label} 没有真实样本，详情及正向关联未验证`)
  if (result.total > result.list.length || (kind === 'asn' && result.list.length === 100)) {
    missing(ctx.record, `${resource.label} 查询受首100条限制，未覆盖全量历史`)
  }
  return result.list
}

async function detail(ctx, kind, id, pageRow, fields = []) {
  const resource = resources[kind]
  const key = `${kind}:${id}`
  if (!ctx.details.has(key)) {
    fact(ctx.record, `${resource.label} 详情请求 ID 有效`, stable(id))
    const path = `${resource.base}/${resource.detail || 'get'}?id=${encodeURIComponent(id)}`
    const row = dataOf(await get(ctx, path, `${resource.label}详情`), `${resource.label}详情`)
    fact(ctx.record, `${resource.label} 详情精确回读`, object(row) && sameId(row.id, id))
    ctx.details.set(key, row)
  }
  const row = ctx.details.get(key)
  if (pageRow) fact(ctx.record, `${resource.label} 分页详情契约一致`,
    fields.every((field) => (row[field] ?? null) === (pageRow[field] ?? null)),
    '瞬时回读，不证明保存或状态转移')
  return row
}

function lines(ctx, row, field, label, identityField = 'id') {
  fact(ctx.record, `${label} 明细数组或合法空值`,
    nullable(row[field], (value) => Array.isArray(value) && value.every(object)))
  const result = row[field] || []
  if (!result.length) missing(ctx.record, `${label} 无 ${field} 明细样本`)
  if (identityField) identities(ctx, result, `${label}明细`, identityField)
  return result
}

function mrpFields(ctx, row, label) {
  fact(ctx.record, `${label} 状态、进度及汇总字段契约`,
    nullable(row.status, (value) => [1, 2, 3, 4, 5].includes(value)) &&
    nullable(row.progress, (value) => count(value) && value <= 100) &&
    ['totalMaterials', 'shortageCount', 'purchaseCount'].every((key) => nullable(row[key], count)) &&
    nullable(row.purchasePlanGenerated, (value) => typeof value === 'boolean'))
  if (row.status == null) missing(ctx.record, `${label} 状态为空，真实状态尚未验证`)
}

async function mrpStatus(ctx, id) {
  const path = `/mes/mrp/status/${encodeURIComponent(id)}`
  const row = dataOf(await get(ctx, path, 'MRP 状态'), 'MRP 状态')
  fact(ctx.record, 'MRP 状态精确引用运算 ID', object(row) && sameId(row.calculationId, id))
  mrpFields(ctx, row, 'MRP 状态')
  fact(ctx.record, 'MRP cancelable 与当前状态契约一致',
    typeof row.cancelable === 'boolean' && row.cancelable === [1, 2].includes(row.status),
    '仅字段计算，不验证取消动作')
  return row
}

async function runMrp(ctx) {
  const history = await readPage(ctx, 'mrp')
  for (const row of history) {
    mrpFields(ctx, row, 'MRP 历史')
    fact(ctx.record, 'MRP 历史 resultJson 为字符串或合法空值',
      nullable(row.resultJson, (value) => typeof value === 'string'))
  }
  for (const row of history.slice(0, 3)) {
    await mrpStatus(ctx, row.id)
    if (!text(row.resultJson)) {
      missing(ctx.record, '抽样 MRP 无结果 JSON，需求及建议行尚未验证')
      continue
    }
    let result
    try { result = JSON.parse(row.resultJson) } catch {
      fact(ctx.record, 'MRP 结果 JSON 可解析', false)
    }
    fact(ctx.record, 'MRP 结果为真实结构对象', object(result))
    if (result.calculationId != null) fact(ctx.record, 'MRP 结果运算 ID 对应历史',
      sameId(result.calculationId, row.id))
    else missing(ctx.record, '结果未记录 calculationId，结果身份关联未验证')
    // The production-result VO uses singular purchaseSuggestion; the
    // sales-order-result VO uses plural purchaseSuggestions. Result rows have
    // no row id, so materialId is the only stable read-only association key.
    const resultLists = text(row.saleOrderId)
      ? [{ field: 'purchaseSuggestions', quantityFields: ['suggestQty'] }]
      : [
          { field: 'demandPlan', quantityFields: ['netDemand', 'currentStock', 'totalDemand', 'suggestPurchase'] },
          { field: 'purchaseSuggestion', quantityFields: ['suggestQty'] }
        ]
    for (const { field, quantityFields } of resultLists) {
      const rows = lines(ctx, result, field, `MRP 结果 ${field}`, 'materialId')
      for (const item of rows) fact(ctx.record, 'MRP 结果行物料与数量类型',
        stable(item.materialId) && quantityFields.every((key) => nullable(item[key], decimal)),
        '仅历史结果类型，不重算净需求')
    }
  }
  if (!history.some((row) => row.shortageCount > 0)) {
    missing(ctx.record, '首100条无明确 shortageCount>0 的缺料结果')
  }
  const inventory = await readPage(ctx, 'inventory')
  for (const row of inventory) {
    fact(ctx.record, 'WMS 库存样本物料、仓库及数量类型',
      stable(row.materialId) && stable(row.warehouseId) && decimal(row.qty) && Number(row.qty) > 0 &&
      ['availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty']
        .every((key) => nullable(row[key], decimal)), '不把库存列表当 ATP 或 MRP 时点快照')
    if (row.availableQty == null) missing(ctx.record, '库存样本 availableQty 为空，可用量事实未验证')
  }
}

async function requestOrderSources(ctx) {
  const requests = await readPage(ctx, 'request')
  const orders = await readPage(ctx, 'purchase')
  const mrpRequests = requests.filter((row) => ['MRP', 'SALE_ORDER_MRP'].includes(row.srcBillType))
  for (const row of requests) fact(ctx.record, '请购来源字段类型',
    nullable(row.srcBillType, (value) => typeof value === 'string') &&
      nullable(row.srcBillId, (value) => typeof value === 'string'))
  const sample = [...mrpRequests, ...requests.filter((row) => !mrpRequests.includes(row))].slice(0, 3)
  const readRequests = []
  for (const row of sample) {
    const current = await detail(ctx, 'request', row.id, row, ['srcBillType', 'srcBillId'])
    lines(ctx, current, 'itemsList', '请购单')
    readRequests.push(current)
  }
  let associations = 0
  for (const row of orders.slice(0, 3)) {
    const current = await detail(ctx, 'purchase', row.id)
    const items = lines(ctx, current, 'items', '采购订单')
    for (const item of items.filter((entry) => text(entry.srcEntryId)).slice(0, 3)) {
      fact(ctx.record, '订单来源请购 ID/行 ID 有效', stable(item.srcBillId) && stable(item.srcEntryId))
      const source = await detail(ctx, 'request', item.srcBillId)
      const sourceItems = lines(ctx, source, 'itemsList', '来源请购')
      const sourceItem = sourceItems.find((entry) => sameId(entry.id, item.srcEntryId))
      fact(ctx.record, '订单来源行精确引用请购明细', Boolean(sourceItem))
      if (stable(item.productId) && stable(sourceItem.productId)) {
        fact(ctx.record, '请购至订单来源物料一致', sameId(item.productId, sourceItem.productId))
      } else missing(ctx.record, '请购/订单来源行缺少物料 ID，物料关联未验证')
      associations++
    }
  }
  if (!associations) missing(ctx.record, '订单详情抽样无请购 srcBillId/srcEntryId 正向关联')
  if (!mrpRequests.length) missing(ctx.record, '请购首100条无 MRP 或 SALE_ORDER_MRP 来源')
  return { mrpRequests: readRequests.filter((row) =>
    ['MRP', 'SALE_ORDER_MRP'].includes(row.srcBillType)) }
}

async function runRequests(ctx) {
  const { mrpRequests } = await requestOrderSources(ctx)
  for (const row of mrpRequests) {
    const ids = typeof row.srcBillId === 'string' ? row.srcBillId.split(',') : []
    fact(ctx.record, 'MRP 请购引用真实运算 ID 集合',
      ids.length > 0 && ids.every(stable) && new Set(ids).size === ids.length)
    for (const id of ids.slice(0, 3)) await mrpStatus(ctx, id)
    if (ids.length > 3) missing(ctx.record, '请购来源运算超过3条，其余关联未回读')
  }
  const tasks = await readPage(ctx, 'todo')
  for (const row of tasks) fact(ctx.record, '真实待办流程实例字段',
    stable(row.processInstanceId))
  if (!mrpRequests.some((row) => stable(row.processInstanceId))) {
    missing(ctx.record, 'MRP 请购抽样无 BPM processInstanceId，缺料流程/角色待办未验证')
  } else if (!tasks.some((task) => mrpRequests.some((row) =>
    sameId(row.processInstanceId, task.processInstanceId)))) {
    missing(ctx.record, '当前用户首100条待办无抽样 MRP 请购流程，不能据此判定角色待办不存在')
  } else fact(ctx.record, '当前用户待办关联已有 MRP 请购流程实例', true,
    '仅当前用户关联，不证明指定审批角色或新流程触发')
}

async function runInvoiceArrival(ctx) {
  const invoices = await readPage(ctx, 'purchaseInvoice')
  for (const row of invoices.slice(0, 3)) await detail(ctx, 'purchaseInvoice', row.id, row,
    ['srcBillType', 'srcBillId', 'isRubric'])
  const payables = await readPage(ctx, 'payable')
  const sourced = payables.filter((row) => row.srcBillType === 'PurInvoice')
  for (const row of sourced.slice(0, 3)) {
    const current = await detail(ctx, 'payable', row.id, row, ['srcBillType', 'srcBillId', 'isRubric'])
    fact(ctx.record, '发票应付来源 ID 有效', stable(current.srcBillId))
    const invoice = await detail(ctx, 'purchaseInvoice', current.srcBillId)
    if (stable(current.supplierId) && stable(invoice.supplierId)) {
      fact(ctx.record, 'PurInvoice 应付精确引用采购发票及同一供应商',
        sameId(current.supplierId, invoice.supplierId), '不证明唯一生成点或重复复核幂等')
    } else missing(ctx.record, '发票/应付供应商字段为空，供应商关联未验证')
  }
  if (!sourced.length) missing(ctx.record, '应付首100条无 PurInvoice 发票复核来源样本')
  const notices = await readPage(ctx, 'asn')
  let associated = 0
  for (const row of notices.slice(0, 3)) {
    const current = await detail(ctx, 'asn', row.id, row, ['purchaseOrderId', 'vendorId'])
    const noticeLines = lines(ctx, current, 'lines', 'ASN')
    if (!text(current.purchaseOrderId)) {
      missing(ctx.record, 'ASN 抽样无 purchaseOrderId，订单追溯未验证')
      continue
    }
    const order = await detail(ctx, 'purchase', current.purchaseOrderId)
    const items = lines(ctx, order, 'items', 'ASN 来源订单')
    for (const line of noticeLines.slice(0, 3)) {
      fact(ctx.record, 'ASN 行数量及质检标记类型',
        ['arrivalQuantity', 'receivedQuantity', 'qualifiedQuantity'].every((key) =>
          nullable(line[key], decimal)) && nullable(line.iqcCheckFlag, (value) => typeof value === 'boolean'))
      if (!text(line.purchaseOrderItemId)) {
        missing(ctx.record, 'ASN 行无 purchaseOrderItemId，来源行关联未验证')
        continue
      }
      const item = items.find((entry) => sameId(entry.id, line.purchaseOrderItemId))
      fact(ctx.record, 'ASN 行引用真实采购订单行',
        Boolean(item) && sameId(item.productId, line.itemId))
      associated++
    }
  }
  if (!associated) missing(ctx.record, 'ASN 抽样未取得到货行至采购订单行正向关联')
  missing(ctx.record, '未读取 WMS 101 入库及质检放行/库存前后快照，ASN 存在不证明必经或质量门禁')
}

function enabledConfig(raw) {
  if (raw == null || raw.trim() === '') return false
  if (['true', '1'].includes(raw.trim().toLowerCase())) return true
  if (['false', '0'].includes(raw.trim().toLowerCase())) return false
  try {
    const value = JSON.parse(raw)
    return object(value) && [true, 'true', 1, '1'].includes(value.enabled)
  } catch { return false }
}

async function runOptions(ctx) {
  for (const [category, tag] of [['purchase', 'requisition'], ['purchase', 'reconciliation'], ['sales', 'reconciliation']]) {
    const label = `${category}/${tag} 配置`
    const row = dataOf(await get(ctx, `/system/config/get?category=${category}&tag=${tag}`, label), label)
    if (row == null) {
      missing(ctx.record, `${label} 未配置；运行时按关闭，不修改配置`)
      continue
    }
    fact(ctx.record, `${label} 真实 category/tag/configData 契约`,
      object(row) && row.category === category && row.tag === tag &&
      nullable(row.configData, (value) => typeof value === 'string'))
    if (!enabledConfig(row.configData)) missing(ctx.record, `${label} 未启用或配置按策略降级关闭，开启门禁尚未验证`)
  }
  await requestOrderSources(ctx)
  const reconciliations = await readPage(ctx, 'reconciliation')
  for (const row of reconciliations.slice(0, 3)) {
    const current = await detail(ctx, 'reconciliation', row.id, row, ['supplierId', 'status', 'confirmVersion'])
    fact(ctx.record, '采购对账状态和确认版本响应类型',
      nullable(current.status, (value) => typeof value === 'string') &&
      nullable(current.confirmVersion, count))
    lines(ctx, current, 'lines', '采购对账')
  }
  if (!reconciliations.some((row) => row.status === 'CONFIRMED')) {
    missing(ctx.record, '采购对账首100条无 CONFIRMED 样本，确认来源开票前置未验证')
  }
  for (const kind of ['purchaseInvoice', 'saleInvoice']) {
    const rows = await readPage(ctx, kind)
    for (const row of rows.slice(0, 3)) await detail(ctx, kind, row.id, row,
      ['srcBillType', 'srcBillId', 'srcBillVersion'])
  }
  missing(ctx.record, '购销发票 RespVO 不暴露 reconciliationSourceType/Ids/Versions，未断言数据库快照')
  ctx.record.notes.push('PB-140/141 实际采购对账为 ASN 行级确认；不把 catalog 旧应付对账描述当新 API 契约。紧急直采原因亦未在订单 RespVO 暴露。')
}

function ruleFields(ctx, row) {
  const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  fact(ctx.record, '结算规则稳定编码、版本及启停契约',
    stable(row.id) && text(row.settleMethodCode) && Number.isSafeInteger(row.version) &&
    row.version > 0 && [0, 1].includes(row.status) &&
    ['RECEIPT', 'PAYMENT', 'BOTH'].includes(row.direction) &&
    ['requireBillNo', 'requireDueDate', 'allowCredit'].every((key) => typeof row[key] === 'boolean') &&
    nullable(row.allowedAccountTypes, (value) => typeof value === 'string') &&
    nullable(row.defaultCreditDays, count))
  fact(ctx.record, '结算规则生效日期契约',
    nullable(row.effectiveFrom, date) && nullable(row.effectiveTo, date) &&
    (!row.effectiveFrom || !row.effectiveTo || row.effectiveFrom <= row.effectiveTo))
}

async function ruleList(ctx, code) {
  if (!ctx.versions.has(code)) {
    const rows = dataOf(await get(ctx, `/erp/settle-method-rule/list-by-code?settleMethodCode=${encodeURIComponent(code)}`,
      '结算规则版本列表'), '结算规则版本列表')
    if (!Array.isArray(rows)) {
      fact(ctx.record, '结算规则版本列表对象数组', false)
    } else if (!rows.length) {
      missing(ctx.record, '该结算编码无当前规则，不能追溯历史版本')
    } else {
      fact(ctx.record, '结算规则版本列表对象数组', rows.every(object))
      identities(ctx, rows, '结算规则版本列表')
      for (const row of rows) {
        ruleFields(ctx, row)
        fact(ctx.record, '版本列表限定真实结算编码', row.settleMethodCode === code)
      }
      fact(ctx.record, '同编码版本降序且至多一条启用',
        rows.filter((row) => row.status === 1).length <= 1 &&
          rows.every((row, index) => !index || rows[index - 1].version >= row.version))
    }
    ctx.versions.set(code, rows)
  }
  return ctx.versions.get(code)
}

async function runSnapshots(ctx) {
  const dictionary = await readPage(ctx, 'dict')
  for (const row of dictionary) fact(ctx.record, '结算字典编码、类型和状态契约',
    text(row.value) && row.dictType === 'x_settle_method' && [0, 1].includes(row.status))
  const rules = await readPage(ctx, 'rule')
  for (const row of rules) ruleFields(ctx, row)
  if (!rules.some((row) => row.status === 1 && dictionary.some((item) =>
    item.value === row.settleMethodCode && item.status === 0))) {
    missing(ctx.record, '未取得启用字典值(status=0)及启用规则(status=1)同编码前置')
  }
  for (const row of rules.slice(0, 3)) {
    await detail(ctx, 'rule', row.id, row, ['settleMethodCode', 'version', 'status', 'effectiveFrom', 'effectiveTo'])
    const versions = await ruleList(ctx, row.settleMethodCode)
    if (!versions.length) continue
    if (versions.some((item) => sameId(item.id, row.id) && item.version === row.version)) {
      fact(ctx.record, '编码版本列表包含当前规则', true)
    } else {
      missing(ctx.record, '当前规则未在编码版本列表保留，历史版本快照未验证')
    }
  }
  for (const kind of ['purchase', 'sale']) {
    const orders = await readPage(ctx, kind)
    let snapshots = 0
    const sample = [...orders.filter((row) => text(row.settleMethodCode)),
      ...orders.filter((row) => !text(row.settleMethodCode))].slice(0, 3)
    for (const row of sample) {
      const current = await detail(ctx, kind, row.id, row, ['settleMethodCode', 'settleMethodRuleVersion'])
      fact(ctx.record, '订单结算编码及合法可空版本契约',
        nullable(current.settleMethodCode, (value) => typeof value === 'string') &&
        nullable(current.settleMethodRuleVersion, (value) => Number.isSafeInteger(value) && value > 0) &&
        (current.settleMethodRuleVersion == null || text(current.settleMethodCode)))
      if (!text(current.settleMethodCode) || current.settleMethodRuleVersion == null) {
        missing(ctx.record, `${resources[kind].label} 抽样无完整结算版本快照；旧单/无命中规则允许空值`)
        continue
      }
      snapshots++
      const found = dictionary.find((item) => item.value === current.settleMethodCode)
      if (!found) missing(ctx.record, '历史订单编码未在当前字典首100条找到，不能断言保存时字典有效性')
      else fact(ctx.record, '历史订单引用当前可读字典编码', true, '停用历史引用合法，不证明新建可用性')
      const versions = await ruleList(ctx, current.settleMethodCode)
      if (versions.some((item) => item.version === current.settleMethodRuleVersion)) {
        fact(ctx.record, '历史订单版本在当前可读规则中有对应', true, '不要求等于当前启用版本')
      } else missing(ctx.record, '历史订单版本未在当前规则列表保留；规则 updateById 递增版本/delete 不构成完整版本档案')
    }
    if (!snapshots) missing(ctx.record, `${resources[kind].label} 抽样无完整结算快照正向样本`)
  }
}

export async function runProcurementFoundationReadonlyContract({ caseId, api, caseRecord }) {
  const metadata = procurementFoundationReadonlyRegistry.find((item) => item.id === caseId)
  if (!metadata) throw new Error('非目标采购基础只读案例')
  if (typeof api?.getBusiness !== 'function') throw new Error('必须注入已认证的 GET API 客户端；不自动登录')
  if (!Array.isArray(caseRecord?.checks) || !Array.isArray(caseRecord?.notes)) {
    throw new Error('caseRecord 必须提供 checks/notes 数组')
  }
  const note = `${caseId} 仅真实 GET 只读前置，始终 PARTIAL`
  caseRecord.notes.push(note, metadata.evidenceScope, ...metadata.unverified.map((item) => `未验证：${item}`),
    '未提供或执行隔离写侧夹具、流程部署、角色切换及权限/跨租户反例；不据管理员可读判权限通过')
  const ctx = { api, record: caseRecord, metadata, details: new Map(), versions: new Map() }
  await ({
    'PROC-001': runMrp, 'PROC-002': runRequests, 'PROC-003': runInvoiceArrival,
    'PROC-004': runOptions, 'PROC-005': runSnapshots
  })[caseId](ctx)
  return { partial: true, note, unverified: [...metadata.unverified] }
}

export const runCase = (context, dependencies = {}) =>
  runProcurementFoundationReadonlyContract({ ...context, api: dependencies.api || context.api })
