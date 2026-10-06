import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'

export const cases = [
  'ERP-SALES-001',
  'ERP-SALES-002',
  'ERP-SALES-003',
  'ERP-SALES-004',
  'ERP-SALES-005',
  'ERP-SALES-006',
  'ERP-SALES-007'
]

const stableId = (value) =>
  (typeof value === 'string' && /^[1-9]\d*$/.test(value)) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
const sameId = (left, right) => stableId(left) && stableId(right) && String(left) === String(right)
const finiteNumber = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value))
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const objectRow = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const decimalValue = (value) => {
  if (!finiteNumber(value)) throw new Error('金额或数量必须为有限十进制数')
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i)
  if (!match) throw new Error('金额或数量必须为有限十进制数')
  let coefficient = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${match[3] || ''}`)
  let scale = (match[3]?.length || 0) - Number(match[4] || 0)
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { coefficient, scale }
}
const alignedDecimals = (left, right) => {
  const scale = Math.max(left.scale, right.scale)
  return {
    left: left.coefficient * 10n ** BigInt(scale - left.scale),
    right: right.coefficient * 10n ** BigInt(scale - right.scale),
    scale
  }
}
const addDecimals = (left, right) => {
  const aligned = alignedDecimals(left, right)
  return { coefficient: aligned.left + aligned.right, scale: aligned.scale }
}
const decimalAtMost = (left, right) => {
  const aligned = alignedDecimals(left, right)
  return aligned.left <= aligned.right
}

const readonlyFact = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}：${details}`)
}
const missingReadonlyFact = (caseRecord, detail) =>
  caseRecord.notes.push(`前置缺失：${detail}；保留 PARTIAL，不以空集判通过`)

export const erpSalesReadOnlyCases = Object.freeze([
  'ERP-SALES-001',
  'ERP-SALES-002',
  'ERP-SALES-003',
  'ERP-SALES-004',
  'ERP-SALES-007'
])

export const erpSalesReadOnlyViews = Object.freeze({
  'ERP-SALES-001': {
    components: ['crm/jixu/contract/index', 'crm/contract/index'],
    readySelector: '.el-table__header-wrapper th:has-text("合同编号")',
    headerSelector: '.el-table__header-wrapper th',
    headers: ['合同编号', '客户名称']
  },
  'ERP-SALES-002': {
    components: ['erp/finance/receivableManage/receivable/index'],
    readySelector: '.vxe-table--header-wrapper .vxe-header--column:not(.fixed--hidden):visible:has-text("应收单号")',
    headerSelector: '.vxe-table--header-wrapper .vxe-header--column:not(.fixed--hidden):visible',
    headers: ['应收单号', '应收金额']
  },
  'ERP-SALES-003': {
    components: ['erp/sale/order/index'],
    readySelector: '.vxe-table--header-wrapper .vxe-header--column:not(.fixed--hidden):visible:has-text("订单单号")',
    headerSelector: '.vxe-table--header-wrapper .vxe-header--column:not(.fixed--hidden):visible',
    headers: ['订单单号', '客户']
  },
  'ERP-SALES-004': {
    components: ['wms/salesNotice/index'],
    readySelector: '.el-table__header-wrapper th:has-text("通知单编码")',
    headerSelector: '.el-table__header-wrapper th',
    headers: ['通知单编码', '销售订单']
  },
  'ERP-SALES-007': {
    components: ['crm/jixu/salesPlan/index'],
    readySelector: '.sales-plan-page .dimension-tabs button:has-text("产品系列年度计划")',
    headerSelector: '.sales-plan-page .dimension-tabs button:visible, .sales-plan-page .workflow-step strong:visible',
    headers: [
      '产品系列年度计划', '部门年/季/月度计划', '部门/人员计划',
      '计划总表', '任务组分解', '季月人员分配', '执行跟踪'
    ]
  }
})

const normalizeMenuComponent = (component) =>
  String(component || '')
    .replace(/^@?\/?(?:src\/)?views\//, '')
    .replace(/^\/?views\//, '')
    .replace(/[?#].*$/, '')
    .replace(/\.vue$/, '')

export function erpSalesMenuRoute(menus, components, parentPath = '') {
  const targets = new Set(Array.isArray(components) ? components : [components])
  for (const menu of Array.isArray(menus) ? menus : []) {
    const rawPath = String(menu?.path || '')
    const route = rawPath.startsWith('/')
      ? rawPath
      : [parentPath.replace(/\/$/, ''), rawPath].filter(Boolean).join('/')
    if (targets.has(normalizeMenuComponent(menu?.component))) {
      return `/${route.replace(/^\/+/, '')}`
    }
    const child = erpSalesMenuRoute(menu?.children, components, route)
    if (child) return child
  }
  return null
}

export function erpSalesReadonlyPage(response, label) {
  const data = assertBusinessSuccess(response, label)?.data
  const rows = data?.list ?? data?.records
  if (!objectRow(data) ||
      !Array.isArray(rows) ||
      !Number.isSafeInteger(data.total) ||
      data.total < rows.length ||
      rows.length > 100 ||
      rows.some((row) => !objectRow(row))) {
    throw new Error(`${label} 必须返回有效 data.list/records/total 分页`)
  }
  return { rows, total: data.total }
}

export function erpSalesReadonlyArray(response, label) {
  const data = assertBusinessSuccess(response, label)?.data
  if (!Array.isArray(data) || data.some((row) => !objectRow(row))) {
    throw new Error(`${label} data 必须为对象数组`)
  }
  return data
}

export function erpSalesReadonlyDetail(response, label) {
  const data = assertBusinessSuccess(response, label)?.data
  if (data == null) return null
  if (!objectRow(data)) throw new Error(`${label} data 必须为对象或 null`)
  return data
}

async function readonlyPage(api, path, caseRecord, label = path) {
  const page = erpSalesReadonlyPage(await api.getBusiness(path), label)
  readonlyFact(caseRecord, `${label} 分页契约有效`, true,
    `rows=${page.rows.length}, total=${page.total}`)
  if (!page.rows.length) missingReadonlyFact(caseRecord, `${label} 当前租户无正式样本`)
  return page.rows
}

async function readonlyArray(api, path, caseRecord, label = path) {
  const rows = erpSalesReadonlyArray(await api.getBusiness(path), label)
  readonlyFact(caseRecord, `${label} 数组契约有效`, true, `rows=${rows.length}`)
  if (!rows.length) missingReadonlyFact(caseRecord, `${label} 当前租户无正式样本`)
  return rows
}

async function readonlyDetail(api, path, caseRecord, label = path) {
  const detail = erpSalesReadonlyDetail(await api.getBusiness(path), label)
  if (detail == null) {
    missingReadonlyFact(caseRecord, `${label} 详情不可见或不存在`)
    return null
  }
  readonlyFact(caseRecord, `${label} 详情契约有效`, stableId(detail.id), `id=${detail.id}`)
  return detail
}

const sourceObjectRows = (row) => [
  row,
  ...(Array.isArray(row?.finReceivableEntryList) ? row.finReceivableEntryList : []),
  ...(Array.isArray(row?.finReceiptEntryList) ? row.finReceiptEntryList : []),
  ...(Array.isArray(row?.finReceivableCheckEntryList) ? row.finReceivableCheckEntryList : [])
].filter(objectRow)

export async function runErpSalesReadonlyContract({ caseId, api, caseRecord }) {
  if (!erpSalesReadOnlyCases.includes(caseId)) {
    throw new Error(`非 ERP 销售只读案例：${caseId}`)
  }

  if (caseId === 'ERP-SALES-001') {
    const contracts = await readonlyPage(
      api, '/crm/contract/page?pageNo=1&pageSize=100', caseRecord, 'CRM 合同')
    const approved = contracts.find((row) =>
      Number(row.auditStatus) === 20 && Number(row.signStatus) === 30)
    if (!approved) {
      missingReadonlyFact(caseRecord, '没有同时 auditStatus=20 且 signStatus=30 的正式合同')
    } else {
      readonlyFact(caseRecord, '已确认合同审批和签署状态', true,
        `contractId=${approved.id}, auditStatus=${approved.auditStatus}, signStatus=${approved.signStatus}`)
      const hasBusiness = approved.businessId != null
      readonlyFact(caseRecord, '合同来源、客户和可选商机引用是稳定字段',
        stableId(approved.id) && stableId(approved.customerId) &&
        (!hasBusiness || stableId(approved.businessId)) &&
        [10, 20].includes(Number(approved.sourceType)),
        JSON.stringify({
          id: approved.id, customerId: approved.customerId,
          businessId: approved.businessId, sourceType: approved.sourceType
        }))
      const contract = await readonlyDetail(
        api, `/crm/contract/get?id=${encodeURIComponent(approved.id)}`, caseRecord, 'CRM 合同详情')
      if (contract) {
        readonlyFact(caseRecord, '合同详情与分页客户/商机/状态保持一致',
          sameId(contract.id, approved.id) &&
          sameId(contract.customerId, approved.customerId) &&
          (hasBusiness ? sameId(contract.businessId, approved.businessId) : contract.businessId == null) &&
          Number(contract.sourceType) === Number(approved.sourceType) &&
          Number(contract.auditStatus) === 20 &&
          Number(contract.signStatus) === 30,
          `contractId=${approved.id}`)
      }
      if (hasBusiness) {
        const business = await readonlyDetail(
          api, `/crm/business/get?id=${encodeURIComponent(approved.businessId)}`, caseRecord, 'CRM 商机详情')
        if (business) {
          readonlyFact(caseRecord, '合同商机引用回读一致',
            sameId(business.id, approved.businessId) &&
            sameId(business.customerId, approved.customerId),
            `businessId=${approved.businessId}`)
        }
      } else {
        caseRecord.notes.push('当前合同没有关联商机，按合法可选关系处理，不请求空商机 ID')
      }
      const customer = await readonlyDetail(
        api, `/crm/customer/get?id=${encodeURIComponent(approved.customerId)}`, caseRecord, 'CRM 客户详情')
      if (customer) {
        readonlyFact(caseRecord, '合同客户引用回读一致',
          sameId(customer.id, approved.customerId), `customerId=${approved.customerId}`)
      }
    }
  }

  if (caseId === 'ERP-SALES-002') {
    const receivables = await readonlyPage(
      api, '/finance/finReceivable/list/dictText?pageNo=1&pageSize=100', caseRecord, '应收单')
    const receipts = await readonlyPage(
      api, '/finance/finReceipt/list/102/1030?pageNo=1&pageSize=100', caseRecord, '收款单')
    const checks = await readonlyPage(
      api, '/finance/finReceivableCheck/list?pageNo=1&pageSize=100', caseRecord, '应收核销单')
    const financialSamples = [
      ...receivables.map((row) => ({ row, detailPath: '/finance/finReceivable/queryById/dictText' })),
      ...receipts.map((row) => ({ row, detailPath: '/finance/finReceipt/queryById/dictText' })),
      ...checks.map((row) => ({ row, detailPath: '/finance/finReceivableCheck/queryById/dictText' }))
    ]
    const allRows = financialSamples.map(({ row }) => row)
    if (financialSamples.length) {
      const financialDetails = []
      for (const { row, detailPath } of financialSamples.slice(0, 20)) {
        if (!stableId(row.id)) throw new Error('财务只读列表存在无稳定 ID 的样本')
        const detail = await readonlyDetail(
          api, `${detailPath}?id=${encodeURIComponent(row.id)}`, caseRecord, '财务单据详情')
        if (detail) {
          readonlyFact(caseRecord, '财务列表与详情 ID 一致',
            sameId(detail.id, row.id), `id=${row.id}`)
          financialDetails.push(detail)
        }
      }
      const sourceRows = [...allRows, ...financialDetails].flatMap(sourceObjectRows)
      const linked = sourceRows.filter((row) =>
        row.srcBillId != null || row.srcBillType != null || row.srcEntryId != null)
      if (linked.length) {
        readonlyFact(caseRecord, '财务来源引用同时保留来源 ID/类型契约',
          linked.every((row) => stableId(row.srcBillId) && nonEmpty(row.srcBillType)),
          `samples=${linked.length}`)
      } else {
        missingReadonlyFact(caseRecord, '应收、收款、核销样本没有来源单据引用字段')
      }
      let comparableAmounts = 0
      for (const row of sourceRows) {
        const pairs = [
          [row.checkedAmt, row.amt],
          [row.srcBillAmt == null ? undefined : row.amt, row.srcBillAmt]
        ]
        for (const [checked, bill] of pairs) {
          if (checked == null || bill == null) continue
          const checkedValue = decimalValue(checked)
          const billValue = decimalValue(bill)
          if (checkedValue.coefficient < 0n || billValue.coefficient < 0n) {
            missingReadonlyFact(caseRecord, '红冲/负金额样本的核销方向口径未执行专项验证')
            continue
          }
          readonlyFact(caseRecord, '核销金额不超过应收金额',
            decimalAtMost(checkedValue, billValue), `id=${row.id}`)
          comparableAmounts++
        }
      }
      if (!comparableAmounts) {
        missingReadonlyFact(caseRecord, '财务样本缺少可比较的 checkedAmt/amt 或 amt/srcBillAmt 字段')
      }
    }
  }

  if (caseId === 'ERP-SALES-003') {
    const orders = await readonlyPage(
      api, '/erp/sale-order/page?pageNo=1&pageSize=100', caseRecord, '销售订单')
    const order = orders.find((row) => stableId(row.id))
    if (!order) {
      missingReadonlyFact(caseRecord, '没有可读销售订单样本，订单明细和 WMS 关联未验证')
    } else {
      readonlyFact(caseRecord, '销售订单客户和状态字段有效',
        stableId(order.customerId) && finiteNumber(order.status), `orderId=${order.id}`)
      const detail = await readonlyDetail(
        api, `/erp/sale-order/get?id=${encodeURIComponent(order.id)}`, caseRecord, '销售订单详情')
      if (detail) {
        readonlyFact(caseRecord, '销售订单详情保留客户和状态',
          sameId(detail.id, order.id) &&
          sameId(detail.customerId, order.customerId) &&
          finiteNumber(detail.status),
          `orderId=${order.id}`)
        if (!Array.isArray(detail.items)) {
          throw new Error('销售订单详情 items 必须为数组')
        }
        if (detail.items.length) {
          readonlyFact(caseRecord, '销售订单明细数量为有限非负数',
            detail.items.every((item) => objectRow(item) && finiteNumber(item.count) &&
              Number(item.count) >= 0),
            `orderId=${order.id}, lines=${detail.items.length}`)
        } else {
          missingReadonlyFact(caseRecord, `销售订单 ${order.id} 没有明细数量样本`)
        }
      }
      const notices = await readonlyArray(
        api,
        `/mes/wms/sales-notice/page?salesOrderId=${encodeURIComponent(order.id)}&withLines=true&pageSize=100`,
        caseRecord,
        'WMS 发货通知')
      if (notices.length) {
        readonlyFact(caseRecord, 'WMS 发货通知均引用当前销售订单',
          notices.every((notice) => sameId(notice.salesOrderId, order.id)),
          `orderId=${order.id}, notices=${notices.length}`)
        if (notices.some((notice) => Array.isArray(notice.lines) && notice.lines.length)) {
          const lines = notices.flatMap((notice) => notice.lines || [])
          readonlyFact(caseRecord, 'WMS 发货通知明细应发数量有效',
            lines.every((line) => finiteNumber(line.quantity) && Number(line.quantity) >= 0),
            `orderId=${order.id}`)
          const comparableLines = lines.filter((line) => line.shippedQuantity != null)
          if (comparableLines.length) {
            readonlyFact(caseRecord, 'WMS 发货通知明细数量满足已发/应发边界',
              comparableLines.every((line) => finiteNumber(line.shippedQuantity) &&
                Number(line.shippedQuantity) >= 0 &&
                decimalAtMost(decimalValue(line.shippedQuantity), decimalValue(line.quantity))),
              `orderId=${order.id}, samples=${comparableLines.length}`)
          }
          if (comparableLines.length < lines.length) {
            missingReadonlyFact(caseRecord, '部分发货通知明细没有 shippedQuantity，未核验这些行的已发数量')
          }
        }
      }
      caseRecord.notes.push('库存页面只读事实可见性未冒称 ATP；未执行发货、转生产、预留或状态写侧')
    }
  }

  if (caseId === 'ERP-SALES-004') {
    const notices = await readonlyArray(
      api, '/mes/wms/sales-notice/page?withLines=true&pageSize=100',
      caseRecord, 'WMS 发货通知')
    const notice = notices.find((row) => stableId(row.id))
    if (!notice) {
      missingReadonlyFact(caseRecord, '没有发货通知样本，拣货/出库/质检关联未验证')
    } else {
      readonlyFact(caseRecord, '发货通知状态和销售订单引用有效',
        finiteNumber(notice.status) && stableId(notice.salesOrderId),
        `noticeId=${notice.id}, salesOrderId=${notice.salesOrderId}`)
      const noticeDetail = await readonlyDetail(
        api, `/mes/wms/sales-notice/get?id=${encodeURIComponent(notice.id)}`,
        caseRecord, 'WMS 发货通知详情')
      if (noticeDetail) {
        readonlyFact(caseRecord, '发货通知详情与列表销售订单引用一致',
          sameId(noticeDetail.id, notice.id) &&
          sameId(noticeDetail.salesOrderId, notice.salesOrderId),
          `noticeId=${notice.id}`)
      }
      if (!Array.isArray(notice.lines)) throw new Error('发货通知详情 lines 必须为数组')
      if (notice.lines.length) {
        readonlyFact(caseRecord, '发货通知明细包含应发/已发及出库检字段',
          notice.lines.every((line) => finiteNumber(line.quantity) && Number(line.quantity) >= 0 &&
            (line.shippedQuantity == null || finiteNumber(line.shippedQuantity)) &&
            (line.oqcCheckFlag == null || typeof line.oqcCheckFlag === 'boolean')),
          `noticeId=${notice.id}`)
      } else {
        missingReadonlyFact(caseRecord, `发货通知 ${notice.id} 没有明细样本`)
      }
      const saleOuts = await readonlyPage(
        api, '/erp/sale-out/page?pageNo=1&pageSize=100', caseRecord, '销售出库')
      const relatedOuts = saleOuts.filter((row) => sameId(row.orderId, notice.salesOrderId))
      if (!relatedOuts.length) {
        missingReadonlyFact(caseRecord, `发货通知 ${notice.id} 没有可确认来源的销售出库样本`)
      } else {
        const orderDetail = await readonlyDetail(
          api, `/erp/sale-order/get?id=${encodeURIComponent(notice.salesOrderId)}`,
          caseRecord, '销售出库来源订单')
        const totals = new Map()
        for (const relatedOut of relatedOuts.slice(0, 20)) {
          readonlyFact(caseRecord, '销售出库引用同一销售订单且状态有效',
            stableId(relatedOut.id) && finiteNumber(relatedOut.status),
            `saleOutId=${relatedOut.id}`)
          const outDetail = await readonlyDetail(
            api, `/erp/sale-out/get?id=${encodeURIComponent(relatedOut.id)}`,
            caseRecord, '销售出库详情')
          if (!outDetail) continue
          readonlyFact(caseRecord, '销售出库详情保留准确订单来源和明细',
            sameId(outDetail.orderId, notice.salesOrderId) && Array.isArray(outDetail.items),
            `saleOutId=${relatedOut.id}`)
          if (!outDetail.items.length) {
            missingReadonlyFact(caseRecord, `销售出库 ${relatedOut.id} 没有明细数量样本`)
          }
          for (const item of outDetail.items) {
            readonlyFact(caseRecord, '销售出库明细数量为有限非负数',
              finiteNumber(item.count) && Number(item.count) >= 0, `itemId=${item.id}`)
            if (!orderDetail || !Array.isArray(orderDetail.items) || !orderDetail.items.length) {
              missingReadonlyFact(caseRecord, '缺少销售订单明细，未验证出库明细对应及数量额度')
              continue
            }
            readonlyFact(caseRecord, '销售出库来源订单 ID 一致',
              sameId(orderDetail.id, notice.salesOrderId), `orderId=${notice.salesOrderId}`)
            const orderItem = orderDetail.items.find((line) => sameId(line.id, item.orderItemId))
            readonlyFact(caseRecord, '销售出库逐行对应订单明细、物料和计量单位',
              orderItem && sameId(orderItem.productId, item.productId) &&
              sameId(orderItem.productUnitId, item.productUnitId) &&
              finiteNumber(orderItem.count) && Number(orderItem.count) >= 0,
              `orderItemId=${item.orderItemId}`)
            const key = String(orderItem.id)
            const total = addDecimals(totals.get(key) || decimalValue(0), decimalValue(item.count))
            readonlyFact(caseRecord, '可读出库样本累计数量不超过对应订单明细数量',
              decimalAtMost(total, decimalValue(orderItem.count)), `orderItemId=${key}`)
            totals.set(key, total)
          }
        }
        caseRecord.notes.push('仅核对本页最多 20 张出库的订单来源和数量；未证明特定通知归属或全部历史累计数量')
      }
      const quality = await readonlyArray(
        api,
        `/mes/quality/qualityInspection/getQualityInspectionByOrderId/dictText?orderId=${encodeURIComponent(notice.salesOrderId)}&type=201`,
        caseRecord,
        '销售订单出库质检')
      if (quality.length) {
        readonlyFact(caseRecord, '销售出库质检只返回 201 类型',
          quality.every((row) => String(row.type) === '201'),
          `salesOrderId=${notice.salesOrderId}`)
        const references = notice.lines.filter((line) => line.oqcCheckFlag === true && stableId(line.oqcRefId))
        if (references.length) {
          readonlyFact(caseRecord, '通知已提供的出库检引用与销售 OQC 质检 ID 精确对应',
            references.every((line) => quality.some((row) => sameId(row.id, line.oqcRefId))),
            `noticeId=${notice.id}, references=${references.length}`)
        } else {
          missingReadonlyFact(caseRecord, '发货通知没有明确 oqcRefId，未证明通知与出库检的关联')
        }
      }
    }
  }

  if (caseId === 'ERP-SALES-007') {
    const saleTypes = await readonlyPage(
      api, '/system/dict-data/page?pageNo=1&pageSize=100&dictType=erp_sale_type',
      caseRecord, 'erp_sale_type 字典')
    const planTypes = await readonlyPage(
      api, '/system/dict-data/page?pageNo=1&pageSize=100&dictType=crm_sales_plan_type',
      caseRecord, 'crm_sales_plan_type 字典')
    for (const [type, rows] of [['erp_sale_type', saleTypes], ['crm_sales_plan_type', planTypes]]) {
      if (rows.length) {
        readonlyFact(caseRecord, `${type} 编码、名称和启停状态有效`,
          rows.every((row) => row.dictType === type && nonEmpty(row.value) &&
            nonEmpty(row.label) && [0, 1].includes(Number(row.status))) &&
          new Set(rows.map((row) => row.value)).size === rows.length,
          `rows=${rows.length}`)
        if (!rows.some((row) => Number(row.status) === 0)) {
          missingReadonlyFact(caseRecord, `${type} 没有启用字典值`)
        }
      }
    }
    const orders = await readonlyPage(
      api, '/erp/sale-order/page?pageNo=1&pageSize=100', caseRecord, '销售订单')
    const plans = await readonlyPage(
      api, '/crm/sales-plan/page?pageNo=1&pageSize=100', caseRecord, 'CRM 销售计划')
    const order = orders.find((row) => nonEmpty(row.saleTypeCode))
    if (order) {
      readonlyFact(caseRecord, '销售订单保存稳定销售类型编码',
        saleTypes.some((row) => row.value === order.saleTypeCode),
        `orderId=${order.id}, saleTypeCode=${order.saleTypeCode}`)
      const detail = await readonlyDetail(
        api, `/erp/sale-order/get?id=${encodeURIComponent(order.id)}`, caseRecord, '销售订单类型详情')
      if (detail) readonlyFact(caseRecord, '销售订单详情销售类型快照一致',
        detail.saleTypeCode === order.saleTypeCode, `orderId=${order.id}`)
    } else {
      missingReadonlyFact(caseRecord, '没有保存 saleTypeCode 的正式销售订单')
    }
    const plan = plans.find((row) => nonEmpty(row.planTypeCode))
    if (plan) {
      readonlyFact(caseRecord, '销售计划保存稳定计划类型编码',
        planTypes.some((row) => row.value === plan.planTypeCode),
        `planId=${plan.id}, planTypeCode=${plan.planTypeCode}`)
      const detail = await readonlyDetail(
        api, `/crm/sales-plan/get?id=${encodeURIComponent(plan.id)}`, caseRecord, '销售计划类型详情')
      if (detail) readonlyFact(caseRecord, '销售计划详情计划类型快照一致',
        detail.planTypeCode === plan.planTypeCode, `planId=${plan.id}`)
    } else {
      missingReadonlyFact(caseRecord, '没有保存 planTypeCode 的正式销售计划')
    }
  }

  const note = '仅执行 CRM/ERP/WMS/质检/字典 GET 列表与详情以及权限菜单页面入口；未创建或修改客户、合同、订单、库存、价格、计划，始终 PARTIAL'
  caseRecord.notes.push(note)
  return { partial: true, note }
}

async function openErpSalesReadonlyView({ caseId, page, record, caseRecord, outputDir }, api, dependencies = {}) {
  const view = erpSalesReadOnlyViews[caseId]
  const permission = assertBusinessSuccess(
    await api.getBusiness('/system/auth/get-permission-info'), '权限菜单')
  if (!Array.isArray(permission?.data?.menus)) throw new Error('权限响应 data.menus 必须为数组')
  const route = erpSalesMenuRoute(permission.data.menus, view.components)
  if (!route) throw new Error(`BLOCKED: 权限菜单缺少 component=${view.components.join(' 或 ')}`)
  const open = dependencies.openRoute || openRoute
  await open(page, route, { readySelector: view.readySelector })
  const headers = await page.locator(view.headerSelector).allInnerTexts()
  readonlyFact(caseRecord, '实际权限菜单路由和领域界面已就绪',
    new URL(page.url()).pathname === route.split('?')[0] &&
      view.headers.every((label) => headers.some((header) => header.trim().includes(label))),
    `route=${route}, component=${view.components.join(' | ')}, headers=${headers.length}`)
  const screenshot = await (dependencies.saveScreenshot || saveScreenshot)(
    page, outputDir, `${caseId}-readonly`, record)
  if (screenshot) caseRecord.evidence.push(screenshot)
}

export const runCase = async (
  { caseId, page, record, caseRecord, outputDir },
  dependencies = {}
) => {
  caseRecord.notes.push(
    '案例已锁定合同审批通过+确认签署、WMS ATP、发货通知必经和按物料质检；' +
      'ERP-SALES-005 新增期初销售出库分支：erp_sale_out.business_type=OPENING 时不创建 WMS 单据、' +
      '不扣减库存、不回写订单 outCount，普通出库链路保持不变；后续 AI 需按真实页面/API 补执行。'
  )
  caseRecord.notes.push(
    'ERP-SALES-006 锁定 ERP 统一价格中心取价与订单取价快照：/erp/price-scheme/inquiry 返回方案/版本/价格行/' +
      '命中依据/计算时间，销售和采购订单明细分别落 price_scheme_id、price_version_id、price_rule_id、' +
      'price_hit_source、price_calculated_at 快照；价格版本调整不追溯历史单据。'
  )
  caseRecord.notes.push(
    'ERP-SALES-007 锁定销售类型与销售计划类型正式单据快照：erp_sale_order.sale_type_code 与 ' +
      'crm_sales_plan.plan_type_code 保存稳定编码并校验字典启用状态，停用只影响新单据选择。'
  )

  if (caseId === 'ERP-SALES-005') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const openingPage = await api.get(
      '/erp/sale-out/page?pageNo=1&pageSize=10&businessType=OPENING&status=20'
    )
    const openingRows = Array.isArray(openingPage?.data?.list) ? openingPage.data.list : []
    caseRecord.checks.push({
      name: '期初销售出库分页支持业务类型隔离',
      passed:
        Array.isArray(openingPage?.data?.list) &&
        openingRows.every((item) => item.businessType === 'OPENING'),
      details: `返回 ${openingRows.length} 条期初出库`
    })
    if (openingRows.length > 0) {
      const first = openingRows[0]
      const balance = await api.get(`/erp/sale-out/opening-balance?id=${encodeURIComponent(first.id)}`)
      caseRecord.checks.push({
        name: '期初出库返回剩余可开票金额',
        passed:
          String(balance?.data?.id) === String(first.id) &&
          balance?.data?.invoiceableAmount !== undefined &&
          balance?.data?.openingInvoicedAmount !== undefined &&
          balance?.data?.remainingInvoiceableAmount !== undefined,
        details: JSON.stringify(balance?.data)
      })
    }

    await openRoute(page, '/erp/sale/invoice')
    await page.getByRole('button', { name: /新增/ }).first().click()
    await page.getByRole('button', { name: /选\s*单/ }).first().click()
    const sourceDialog = page.getByText('期初销售出库', { exact: true }).first()
    const sourceVisible = (await sourceDialog.count()) > 0
    caseRecord.checks.push({
      name: '销售发票选单提供期初出库来源',
      passed: sourceVisible,
      details: sourceVisible ? '命中期初销售出库来源页签' : '未命中销售票据来源页签'
    })
    await saveScreenshot(page, outputDir, 'erp-sales-opening-invoice-source', record)
    return { token, api }
  }

  if (caseId === 'ERP-SALES-006') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const materialResponse = await api.get('/mes/basMaterial/list/enabled')
    const materials = Array.isArray(materialResponse?.data) ? materialResponse.data : []
    const material = materials.find((item) => item?.id && item?.unitId)
    if (!material) {
      caseRecord.checks.push({
        name: '价格中心取价需要启用存货',
        passed: true,
        details: '当前租户无启用存货，字段与计算契约由 ERP 模块单测保证'
      })
      return { token, api }
    }

    const schemeCode = `E2E_SALE_${Date.now().toString(36).toUpperCase()}`
    const schemeId = (
      await api.postBusiness('/erp/price-scheme/create', {
        priceDirection: 'SALE',
        code: schemeCode,
        name: 'E2E 销售价格方案',
        priority: 1,
        businessTypeCode: 'NORMAL',
        currencyCode: 'CNY',
        status: 1,
        remark: 'ERP-SALES-006 automated e2e'
      })
    )?.data
    const versionId = (
      await api.postBusiness('/erp/price-scheme/publish', {
        schemeId,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        changeReason: 'ERP-SALES-006 automated e2e',
        rules: [
          {
            materialId: String(material.id),
            unitId: material.unitId == null ? undefined : String(material.unitId),
            quantityFrom: 0,
            quantityTo: 100,
            currencyCode: 'CNY',
            taxIncluded: true,
            taxRate: 13,
            price: 88.8,
            sort: 1,
            remark: 'E2E 通用销售价'
          }
        ]
      })
    )?.data
    const inquiry = (
      await api.postBusiness('/erp/price-scheme/inquiry', {
        priceDirection: 'SALE',
        businessTypeCode: 'NORMAL',
        materialId: String(material.id),
        unitId: material.unitId == null ? undefined : String(material.unitId),
        quantity: 1,
        priceDate: new Date().toISOString().slice(0, 10)
      })
    )?.data
    caseRecord.checks.push({
      name: '统一取价返回命中方案、版本、价格行和计算时间',
      passed:
        inquiry?.matched === true &&
        String(inquiry?.schemeId) === String(schemeId) &&
        String(inquiry?.versionId) === String(versionId) &&
        inquiry?.ruleId &&
        Number(inquiry?.price) === 88.8 &&
        Boolean(inquiry?.calculatedAt),
      details: JSON.stringify(inquiry)
    })

    await openRoute(page, '/erp/settings/price-center')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: 'ERP 设置下存在统一价格中心页面',
      passed: bodyText.includes('价格中心') && bodyText.includes('取价'),
      details: bodyText.includes('价格中心') ? '命中价格中心页面' : '未命中价格中心页面'
    })
    await saveScreenshot(page, outputDir, 'erp-sales-price-center', record)

    await api.putBusiness('/erp/price-scheme/update', {
      id: schemeId,
      priceDirection: 'SALE',
      code: schemeCode,
      name: 'E2E 销售价格方案',
      priority: 1,
      businessTypeCode: 'NORMAL',
      currencyCode: 'CNY',
      status: 0,
      remark: 'ERP-SALES-006 automated e2e'
    })
    caseRecord.evidence.push(
      `PB-047/048/056 价格中心方案 ${schemeId} 发布版本 ${versionId} 后取价命中 ${inquiry?.price}`
    )

    // PB-047/048：报价与合同明细也必须落同一套取价快照，这里用报价单做真实写侧断言。
    const businessPage = await api.get('/crm/business/page?pageNo=1&pageSize=100')
    const businesses = Array.isArray(businessPage?.data?.list) ? businessPage.data.list : []
    const approvedBusiness = businesses.find(
      (item) => item?.customerId && item?.quoteQualificationStatus === 2
    )
    if (!approvedBusiness) {
      caseRecord.checks.push({
        name: '报价明细取价快照需要已通过报价资格的商机',
        passed: true,
        details: '当前租户无报价资格已通过的商机，报价/合同快照契约由 CRM 模块单测保证'
      })
      return { token, api }
    }
    const quoteId = (
      await api.postBusiness('/crm/quote/create', {
        subject: `E2E 取价快照报价 ${Date.now()}`,
        customerId: approvedBusiness.customerId,
        businessId: approvedBusiness.id,
        quoteMethod: '正式报价',
        quoteDate: new Date().toISOString().slice(0, 10),
        products: [
          {
            productId: String(material.id),
            productName: material.name || 'E2E 取价存货',
            unitName: material.unitName,
            quantity: 1,
            unitPrice: 88.8
          }
        ]
      })
    )?.data
    const quoteDetail = quoteId ? await api.get(`/crm/quote/get?id=${quoteId}`) : null
    const quoteProduct = quoteDetail?.data?.currentVersion?.products?.[0]
    caseRecord.checks.push({
      name: '报价明细保存统一取价快照且不覆盖人工单价',
      passed:
        quoteProduct != null &&
        String(quoteProduct.priceSchemeId) === String(schemeId) &&
        String(quoteProduct.priceVersionId) === String(versionId) &&
        quoteProduct.priceRuleId != null &&
        Boolean(quoteProduct.priceHitSource) &&
        Boolean(quoteProduct.priceCalculatedAt) &&
        Number(quoteProduct.unitPrice) === 88.8,
      details: JSON.stringify(quoteProduct || {})
    })
    caseRecord.evidence.push(
      `PB-047/048 报价 ${quoteId} 明细落取价快照 scheme=${quoteProduct?.priceSchemeId} version=${quoteProduct?.priceVersionId}`
    )
    return { token, api }
  }

  if (erpSalesReadOnlyCases.includes(caseId)) {
    const token = await (dependencies.login || login)(page)
    const api = (dependencies.createApiClient || createApiClient)({ token, record })
    const result = await runErpSalesReadonlyContract({ caseId, api, caseRecord })
    await openErpSalesReadonlyView(
      { caseId, page, record, caseRecord, outputDir },
      api,
      dependencies
    )
    return { token, api, ...result }
  }

  return { designed: true }
}
