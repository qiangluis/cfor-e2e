import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { config } from '../config/index.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

export const cases = [
  'ERP-SALES-001',
  'ERP-SALES-002',
  'ERP-SALES-003',
  'ERP-SALES-004',
  'ERP-SALES-005',
  'ERP-SALES-006',
  'ERP-SALES-007'
]

export const priceCenterRoute = '/settings/erp/price-center'
export const priceCenterReadySelector = 'button:has-text("统一取价")'
export const openingSalesEvidenceRoute = '/erp/sale/invoice'
const fixtureRemark = 'ERP-SALES-006 automated e2e'

export const isSalesPriceFixture = (row, priority) =>
  row?.id != null &&
  row.priceDirection === 'SALE' &&
  Number(row.status) === 1 &&
  Number(row.priority) === Number(priority) &&
  row.remark === fixtureRemark &&
  /^(E2E_SALE_[A-Z0-9]+|AUTOTEST[-_]ERP[-_]SALES[-_]006[-_][A-Za-z0-9_-]+)$/.test(row.code)

const disabledScheme = (scheme) => ({
  id: scheme.id,
  priceDirection: scheme.priceDirection,
  code: scheme.code,
  name: scheme.name,
  priority: scheme.priority,
  businessTypeCode: scheme.businessTypeCode,
  currencyCode: scheme.currencyCode,
  status: 0,
  remark: scheme.remark
})

export async function stopPreviousSalesPriceFixtures(api, priority, caseRecord) {
  const fixtures = []
  // Read all pages before disabling rows, otherwise status filtering shifts pages.
  for (let pageNo = 1; ; pageNo++) {
    const response = await api.getBusiness(
      `/erp/price-scheme/page?pageNo=${pageNo}&pageSize=100&priceDirection=SALE&status=1`
    )
    const data = response?.data
    if (!Array.isArray(data?.list) || !Number.isInteger(data.total) || data.total < 0) {
      throw new Error('价格方案分页响应结构无效，未停用任何已有方案')
    }
    fixtures.push(...data.list.filter((row) => isSalesPriceFixture(row, priority)))
    if (pageNo * 100 >= data.total) break
    if (data.list.length === 0) throw new Error('价格方案分页提前为空，未停用任何已有方案')
  }
  for (const scheme of fixtures) {
    await api.putBusiness('/erp/price-scheme/update', disabledScheme(scheme))
    caseRecord.notes.push(`已停用 ERP-SALES-006 同优先级历史测试夹具 ${scheme.code} (${scheme.id})`)
  }
}

export async function withSalesPriceFixture(api, scheme, caseRecord, run) {
  let id
  let failed = false
  try {
    id = (await api.postBusiness('/erp/price-scheme/create', scheme))?.data
    if (!/^[1-9]\d*$/.test(String(id))) throw new Error('价格方案创建未返回有效 ID')
    return await run(id)
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (/^[1-9]\d*$/.test(String(id))) {
      try {
        await api.putBusiness('/erp/price-scheme/update', disabledScheme({ ...scheme, id }))
        caseRecord.notes.push(`已停用 ERP-SALES-006 本轮专用方案 ${scheme.code} (${id})`)
      } catch (error) {
        caseRecord.checks.push({
          name: 'ERP-SALES-006 专用价格方案已停用',
          passed: false,
          details: `schemeId=${id}, ${error.message}`
        })
        caseRecord.notes.push(`价格方案清理失败：${error.message}`)
        if (!failed) throw error
      }
    }
  }
}

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

const runLegacySalesCase = async (
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
      caseRecord.notes.push('当前租户无启用存货，未执行真实取价和报价/订单快照，保留 PARTIAL')
      return { token, api, partial: true }
    }

    const schemeCode = `E2E_SALE_${Date.now().toString(36).toUpperCase()}`
    const scheme = {
      priceDirection: 'SALE',
      code: schemeCode,
      name: 'E2E 销售价格方案',
      // Keep the fixture ahead of existing tenant schemes so inquiry proves
      // the version created by this case instead of an older equal-priority rule.
      priority: 0,
      businessTypeCode: 'NORMAL',
      currencyCode: 'CNY',
      status: 1,
      remark: fixtureRemark
    }
    await stopPreviousSalesPriceFixtures(api, scheme.priority, caseRecord)
    return withSalesPriceFixture(api, scheme, caseRecord, async (schemeId) => {
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

    await openRoute(page, priceCenterRoute, { readySelector: priceCenterReadySelector })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: 'ERP 设置下存在统一价格中心页面',
      passed:
        new URL(page.url()).pathname === priceCenterRoute &&
        bodyText.includes('方案编码') &&
        bodyText.includes('统一取价'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'erp-sales-price-center', record)

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
      caseRecord.notes.push('当前租户无报价资格已通过的商机，未执行报价/合同及订单快照，保留 PARTIAL')
      return { token, api, partial: true }
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
    caseRecord.notes.push('已验证报价明细快照；销售/采购订单及合同快照未执行，不能登记完整验收')
    return { token, api, partial: true }
    })
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

export function assertSalesLocalScope(settings = config) {
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083']]) {
    const url = new URL(base)
    if (!loopback.has(url.hostname) || url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: E2E-SALES 只允许本地 loopback:9151/48083')
    }
  }
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' ||
      settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: E2E-SALES 只允许 tenant1/CFOR 标准平台/cfor_admin_standard')
  }
}

const salesData = (response, label) => assertBusinessSuccess(response, label).data
const salesId = (response, label) => {
  const id = salesData(response, label)
  if (!stableId(id)) throw new Error(`${label} 未返回可精确表示的稳定 ID`)
  return String(id)
}
const salesDetail = async (api, path) => {
  const data = salesData(await api.getBusiness(path), path)
  if (!objectRow(data) || !stableId(data.id)) throw new Error(`${path} 缺少真实详情，不能以空集判通过`)
  return data
}
export const salesProcessDetail = async (api, processId) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(processId || '')) {
    throw new Error('BLOCKED: 销售 BPM 流程 ID 必须为准确 UUID')
  }
  const data = salesData(
    await api.getBusiness(`/bpm/process-instance/get?id=${encodeURIComponent(processId)}`),
    '销售 BPM 流程详情'
  )
  if (!objectRow(data) || String(data.id) !== String(processId)) {
    throw new Error(`销售 BPM 流程详情缺少准确 UUID；processInstanceId=${processId}`)
  }
  return data
}
const salesRows = async (api, path) => erpSalesReadonlyPage(await api.getBusiness(path), path).rows
const salesArray = async (api, path) => erpSalesReadonlyArray(await api.getBusiness(path), path)
const salesStamp = () => `E2E-SALES-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
export function salesTime(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('BLOCKED: 销售夹具日期无效')
  }
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
const salesDate = () => salesTime().slice(0, 10)
const localCredentialFiles = [
  process.env.CFOR_E2E_CREDENTIALS_FILE,
  '/tmp/cfor-e2e/tenant1-bootstrap-20261006/credentials.json'
].filter(Boolean)
let localCredentials
function credentialForUsername(username) {
  if (!username) return null
  if (localCredentials === undefined) {
    localCredentials = new Map()
    for (const file of localCredentialFiles) {
      try {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (String(payload?.tenantId) !== '1') continue
        for (const user of payload?.users || []) {
          if (user?.username && user?.password) {
            localCredentials.set(String(user.username), {
              username: String(user.username),
              password: String(user.password)
            })
          }
        }
      } catch {}
    }
  }
  return localCredentials.get(String(username)) || null
}

export function salesBootstrapCredential(initializer) {
  const source = String(initializer || '')
  const password = source.match(/private\s+static\s+final\s+String\s+DEFAULT_PASSWORD\s*=\s*"([^"\\\r\n]+)"\s*;/)?.[1]
  const account = /member\("销售部",\s*"apv_sales_mgr",[^;\n]*"salemgr01"/.test(source)
  const createBranch = /if \(user == null\) \{[\s\S]*?createReqVO\.setPassword\(DEFAULT_PASSWORD\);[\s\S]*?adminUserService\.createUser\(createReqVO\)/.test(source)
  if (!password || !account || !createBranch) {
    throw new Error('BLOCKED: 初始化源码未明确提供 salemgr01 的新建用户密码来源')
  }
  return { username: 'salemgr01', password }
}

export function resolveSalesApproverCredential(username, {
  configured = [
    { username: config.financeApproverUsername, password: config.financeApproverPassword },
    { username: config.finalApproverUsername, password: config.finalApproverPassword },
    { username: config.purchaseApproverUsername, password: config.purchaseApproverPassword }
  ],
  env = process.env,
  credentialLookup = credentialForUsername
} = {}) {
  if (!nonEmpty(username)) return null
  const candidates = [
    { username: env.CFOR_SALES_APPROVER_USERNAME, password: env.CFOR_SALES_APPROVER_PASSWORD },
    ...configured
  ]
  const exact = (item) => item?.username === username && nonEmpty(item.password)
  const configuredCredential = candidates.find(exact)
  if (configuredCredential) {
    return { username, password: configuredCredential.password }
  }
  const localCredential = credentialLookup(username)
  return exact(localCredential) ? { username, password: localCredential.password } : null
}

const sqlId = (id) => {
  if (!stableId(id)) throw new Error('非法销售夹具 SQL ID')
  return `'${id}'`
}
const owned = (caseRecord, kind, id, extra = {}) => {
  const fixture = { kind, id: String(id), tenantId: 1, owned: true, ...extra }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  return fixture
}
const salesFact = readonlyFact

export function assertOwnedSalesProcess(processId, caseRecord) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(processId || '') ||
      !caseRecord.fixtures?.some((fixture) =>
        ['contract-bpm', 'sale-order-bpm', 'sale-out-bpm', 'sale-invoice-bpm'].includes(fixture.kind) &&
        fixture.id === processId && fixture.owned === true && String(fixture.tenantId) === '1' &&
        /^E2E-SALES-[A-Z0-9-]+$/.test(fixture.tag || '') && stableId(fixture.businessId))) {
    throw new Error('BLOCKED: 销售审批/撤回只能处理本轮 tenant1 专属单据流程')
  }
}

export function assertSalesOrderEvidence(order, expected, caseRecord) {
  salesFact(caseRecord, '专属订单客商、物料、单位、逐行数量和金额准确',
    sameId(order.customerId, expected.customerId) &&
    Array.isArray(order.items) && order.items.length === 1 &&
    sameId(order.items[0].productId, expected.materialId) &&
    sameId(order.items[0].productUnitId, expected.unitId) &&
    finiteNumber(order.items[0].count) && Number(order.items[0].count) === expected.count &&
    finiteNumber(order.items[0].productPrice) && Number(order.items[0].productPrice) === expected.price &&
    finiteNumber(order.totalPrice) && Number(order.totalPrice) === expected.amount,
    `orderId=${order.id}, customerId=${order.customerId}, materialId=${order.items?.[0]?.productId}, ` +
    `count=${order.items?.[0]?.count}, price=${order.items?.[0]?.productPrice}, amount=${order.totalPrice}`)
  if (expected.contractId) {
    salesFact(caseRecord, '签署合同生成订单保留唯一合同来源',
      (order.contractId == null || sameId(order.contractId, expected.contractId)) &&
      sameId(order.srcBillId, expected.contractId) &&
      order.srcBillType === 'CRM_CONTRACT',
      `contractId=${expected.contractId}, orderId=${order.id}, srcBillType=${order.srcBillType}, srcBillId=${order.srcBillId}`)
  }
}

export async function salesContractOrders(api, fixture) {
  if (!stableId(fixture.partnerId) || !stableId(fixture.contractId)) {
    throw new Error('BLOCKED: 合同订单查询缺少专属客商/合同 ID')
  }
  // The official page request supports customerId, not contractId.
  const response = await api.getBusiness(
    `/erp/sale-order/page?pageNo=1&pageSize=100&customerId=${encodeURIComponent(fixture.partnerId)}`)
  const { rows, total } = erpSalesReadonlyPage(response, '专属客商合同订单')
  if (total > 100) throw new Error('BLOCKED: 专属客商订单超过单页，不能据截断结果判断唯一性')
  return rows.filter((row) => sameId(row.customerId, fixture.partnerId) &&
    (row.contractId == null || sameId(row.contractId, fixture.contractId)) &&
    sameId(row.srcBillId, fixture.contractId) && row.srcBillType === 'CRM_CONTRACT')
}

export function salesOrderBody(fixture, saleTypeCode = 'NORMAL', price = 88.8, count = 2) {
  if (!stableId(fixture.partnerId) || !stableId(fixture.material?.id) || !stableId(fixture.material?.unitId)) {
    throw new Error('BLOCKED: 专属订单缺少稳定客商/物料/单位 ID')
  }
  return {
    customerId: String(fixture.partnerId), orderTime: salesTime(), saleTypeCode,
    discountPercent: 0, depositPrice: 0, totalPrice: Number((price * count).toFixed(2)),
    remark: fixture.tag,
    items: [{ productId: String(fixture.material.id), productUnitId: String(fixture.material.unitId),
      count, productPrice: price, taxPercent: 0, totalPrice: Number((price * count).toFixed(2)) }]
  }
}

export async function expectSalesRejection(api, method, path, body, expected, caseRecord, label) {
  // Only a domain rejection is evidence. Network/500/SQL failures must not pass.
  const response = await api.request(method, path, body)
  const message = String(response?.msg || response?.message || '')
  salesFact(caseRecord, label,
    objectRow(response) && Number.isInteger(response.code) && !isBusinessSuccess(response) &&
    response.code !== 500 && response.code !== 401 && response.code !== 403 &&
    !/SQL|Exception|系统异常|服务器异常/i.test(message) && expected.test(message),
    `code=${response?.code}, message=${message.slice(0, 240)}`)
  return response
}

const snapshotFields = ['priceSchemeId', 'priceSchemeCode', 'priceVersionId', 'priceVersionNo',
  'priceRuleId', 'priceHitSource', 'priceCalculatedAt']
export const salesPriceSnapshot = (line) => Object.fromEntries(
  snapshotFields.map((key) => [key, line?.[key] ?? null]))
export function assertSalesPriceSnapshot(line, inquiry, caseRecord, label) {
  salesFact(caseRecord, label,
    snapshotFields.every((key) => line?.[key] != null && String(line[key]).length > 0) &&
    sameId(line.priceSchemeId, inquiry.schemeId) && sameId(line.priceVersionId, inquiry.versionId) &&
    sameId(line.priceRuleId, inquiry.ruleId),
    JSON.stringify(salesPriceSnapshot(line)))
}

export function salesCatalogEvidence(caseId, caseRecord, verified = []) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === caseId)
  if (!definition) throw new Error(`缺少原 catalog 案例 ${caseId}`)
  caseRecord.catalogAssertions = (definition.assertions || []).map((assertion, index) => ({
    index, assertion, status: verified.includes(index) ? 'VERIFIED' : 'GAP'
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed)
  caseRecord.notes.push(`原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`)
}

async function salesSql(caseRecord, stage, sql) {
  const evidence = await runReadOnlySql(sql)
  if (!evidence.available) throw new Error(`BLOCKED: ${evidence.reason}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, ...evidence }]
  return evidence.rows
}

export async function salesStockSnapshot(fixture, caseRecord, stage) {
  if (!fixture.warehouseId || !fixture.material?.id || !fixture.tag?.startsWith('E2E-SALES-')) {
    throw new Error('BLOCKED: 库存断言只能使用本轮专属仓库和物料')
  }
  return salesSql(caseRecord, stage, `SELECT id,warehouse_id,material_id,qty,available_qty,
    lock_qty,hold_qty,frozen_qty,pending_putaway_qty,quality_status FROM mes_stk_inventory
    WHERE tenant_id=1 AND deleted=0 AND warehouse_id=${sqlId(fixture.warehouseId)}
    AND material_id=${sqlId(fixture.material.id)} ORDER BY id`)
}

async function createSalesOpeningInventory(api, caseRecord, fixture, quantity = 106) {
  if (!fixture.areaId || !fixture.locationId) {
    throw new Error('BLOCKED: 005 专属期初库存缺少库区/库位，未写入库存')
  }
  const billNo = `${fixture.tag}-OPENING`
  const body = {
    billNo,
    billDate: salesDate(),
    subject: `${fixture.tag} opening inventory`,
    remark: fixture.tag,
    stockIoType: '106',
    isAuto: 0,
    stkIoEntryList: [{
      materialId: String(fixture.material.id),
      unitId: String(fixture.material.unitId),
      qty: quantity,
      cost: 1,
      warehouseId: String(fixture.warehouseId),
      wareAreaId: String(fixture.areaId),
      wareLocationId: String(fixture.locationId),
      batchNo: `${fixture.tag}-OPENING-BATCH`,
      entryNo: 1,
      stockIoType: '106',
      stockIoDirection: '1',
      isQc: 0,
      settleQty: quantity
    }],
    stkIoDistributionList: [],
    stkIoBomList: []
  }
  let id
  try {
    id = salesId(await api.postBusiness('/mes/stkIo/add/submit', body), '创建专属106期初库存')
    owned(caseRecord, 'sales-opening-inventory', id, {
      tag: fixture.tag, stockIoType: '106', quantity
    })
    let detail = await salesDetail(api, `/mes/stkIo/queryById?id=${id}`)
    salesFact(caseRecord, '专属106期初库存正式提交并回读所有权',
      String(detail.stockIoType) === '106' &&
      String(detail.billNo) === billNo &&
      String(detail.remark) === fixture.tag,
      `stockIoId=${id}, billNo=${detail.billNo}, stockIoType=${detail.stockIoType}`)
    if (Number(detail.isEffective) !== 1) {
      await api.putBusiness('/mes/stkIo/check', {
        id, approvalResultType: '1', approvalRemark: `${fixture.tag} 106 inventory approval`
      })
      detail = await salesDetail(api, `/mes/stkIo/queryById?id=${id}`)
    }
    if (Number(detail.isEffective) !== 1) {
      throw new Error(`BLOCKED: 专属106期初库存审批后仍未生效；stockIoId=${id}, billStage=${detail.billStage}`)
    }
    salesFact(caseRecord, '专属106期初库存审批后正式生效',
      Number(detail.isEffective) === 1, `stockIoId=${id}, billStage=${detail.billStage}`)
    return { id, detail, body, effective: true }
  } catch (error) {
    if (id) {
      try {
        const detail = await salesDetail(api, `/mes/stkIo/queryById?id=${id}`)
        if (Number(detail.isEffective) !== 1) {
          await api.deleteBusiness(`/mes/stkIo/delete?id=${id}`)
        } else {
          caseRecord.notes.push(`专属106库存已生效，保留证据 stockIoId=${id}`)
        }
      } catch (cleanup) {
        caseRecord.notes.push(`专属106库存清理未完成 stockIoId=${id}：${cleanup.message}`)
      }
    }
    throw error
  }
}

export function salesMaterialBody(template, tag) {
  if (!stableId(template?.unitId) || !/^E2E-SALES-[A-Z0-9-]+$/.test(tag || '')) {
    throw new Error('BLOCKED: 专属销售物料缺少合法单位或本轮编码')
  }
  return {
    code: tag, name: tag, unitId: String(template.unitId),
    ...(stableId(template.categoryId) ? { categoryId: String(template.categoryId) } : {}),
    isEnabled: 1, inventoryNature: 'STOCK', virtualGoods: 'N',
    source: 'mixed', saled: 'Y', purchased: 'Y', produced: 'Y',
    parented: 'Y', soned: 'N', assembled: 'N', isMaterial: 'N',
    batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N',
    gradeManaged: 'N', colorManaged: 'N', brandManaged: 'N', backflush: 'N',
    leadTime: 1, bufferTime: 1, refPrice: 88.8, refCost: 50, remark: tag
  }
}

export async function createSalesFixture(api, caseRecord, userId, { crm = false, warehouse = false } = {}) {
  const tag = salesStamp()
  const materialTemplate = (await salesArray(api, '/mes/basMaterial/list/enabled'))
    .find((row) => row.saled === 'Y' && stableId(row.unitId))
  if (!materialTemplate) throw new Error('BLOCKED: 无启用可销售物料/单位，未创建销售夹具')
  const materialBody = salesMaterialBody(materialTemplate, tag)
  const materialId = salesId(await api.postBusiness('/mes/basMaterial/add', materialBody), '创建专属物料')
  owned(caseRecord, 'material', materialId, { code: tag, retained: '保留被正式单据引用的证据，不删除历史事实' })
  const material = await salesDetail(api, `/mes/basMaterial/queryById?id=${materialId}`)
  salesFact(caseRecord, '本轮创建独立销售物料且供给能力/提前期回读合法', material.code === tag &&
    material.saled === 'Y' && material.purchased === 'Y' && material.produced === 'Y' &&
    material.inventoryNature === 'STOCK' && material.source === 'mixed' &&
    Number(material.leadTime) === 1 && Number(material.bufferTime) === 1 &&
    sameId(material.unitId, materialBody.unitId),
    `materialId=${materialId}, code=${tag}, source=${material.source}, leadTime=${material.leadTime}, bufferTime=${material.bufferTime}`)
  let customerId
  let partnerId
  if (crm) {
    customerId = salesId(await api.postBusiness('/crm/customer/create', {
      name: tag, ownerUserId: userId, remark: tag
    }), '创建专属 CRM 客户')
    owned(caseRecord, 'crm-customer', customerId, { name: tag })
    const customer = await salesDetail(api, `/crm/customer/get?id=${customerId}`)
    partnerId = String(customer.partnerId || '')
    if (!stableId(partnerId)) {
      const rows = await salesSql(caseRecord, 'crm-customer-partner',
        `SELECT partner_id FROM crm_customer WHERE tenant_id=1 AND deleted=0 AND id=${sqlId(customerId)}`)
      partnerId = rows[0]?.[0]
    }
  } else {
    partnerId = salesId(await api.postBusiness('/base/partner/create', {
      name: tag, shortName: 'E2E-SALES', partnerKind: 'ORGANIZATION', status: 'ACTIVE',
      customerEnabled: true, supplierEnabled: true, carrierEnabled: false, remark: tag
    }), '创建专属客商')
  }
  owned(caseRecord, 'base-partner', partnerId, { name: tag })
  const partner = await salesDetail(api, `/base/partner/get?id=${partnerId}`)
  salesFact(caseRecord, '专属客商客户角色正式回读', partner.name === tag && partner.customerEnabled === true,
    `crmCustomerId=${customerId || ''}, partnerId=${partnerId}, partnerCode=${partner.partnerCode}`)
  const fixture = { tag, material, partnerId, customerId }
  if (warehouse) {
    await api.postBusiness('/mes/wmsWareHouse/add', {
      code: tag, name: tag, wareType: 'entity', isEnabled: true, countInAvailable: true,
      areaEnabled: true, locationEnabled: true, pid: '0', hasChild: '0', mark: tag
    })
    const rows = await salesSql(caseRecord, 'owned-warehouse',
      `SELECT id FROM mes_wms_ware_house WHERE tenant_id=1 AND deleted=0 AND code='${tag}'`)
    if (rows.length !== 1 || !stableId(rows[0][0])) throw new Error('专属仓库创建后无法唯一回读')
    fixture.warehouseId = rows[0][0]
    owned(caseRecord, 'warehouse', fixture.warehouseId, { code: tag })
    const areaCode = `${tag}-AR`
    await api.postBusiness('/mes/wmsHouseArea/add', {
      areaCode, areaName: `${tag} area`, houseId: String(fixture.warehouseId),
      isEnabled: true, remark: tag
    })
    const areas = await salesRows(api,
      `/mes/wmsHouseArea/list?pageNo=1&pageSize=100&houseId=${encodeURIComponent(fixture.warehouseId)}`)
    const area = areas.find((row) => String(row.areaCode) === areaCode)
    if (!area?.id) throw new Error(`专属库区创建后无法唯一回读；areaCode=${areaCode}`)
    fixture.areaId = String(area.id)
    owned(caseRecord, 'warehouse-area', fixture.areaId, {
      code: areaCode, warehouseId: fixture.warehouseId
    })
    const locationCode = `${tag}-LC`
    const locationId = salesId(await api.postBusiness('/mes/wms-house-location/create', {
      locationName: `${tag} location`, locationCode,
      houseId: String(fixture.warehouseId), areaId: fixture.areaId,
      isEnabled: true, locationType: 1, remark: tag
    }), '创建专属库位')
    fixture.locationId = locationId
    owned(caseRecord, 'warehouse-location', fixture.locationId, {
      code: locationCode, warehouseId: fixture.warehouseId, areaId: fixture.areaId
    })
    const baseline = await salesStockSnapshot(fixture, caseRecord, 'owned-stock-zero-baseline')
    salesFact(caseRecord, '本轮专属仓库/物料库存基线为空，不借共享库存', baseline.length === 0,
      `warehouseId=${fixture.warehouseId}, materialId=${materialId}`)
  }
  return fixture
}

export async function approveOwnedSalesProcess({ api, processId, page, caseRecord, record }, dependencies = {}) {
  assertOwnedSalesProcess(processId, caseRecord)
  const permission = salesData(await api.getBusiness('/system/auth/get-permission-info'), '权限')
  if (!stableId(permission?.user?.id) || !nonEmpty(permission.user.username)) {
    throw new Error('BLOCKED: 销售审批发起账号缺少可信身份')
  }
  const sessions = new Map([[String(permission.user.id), { api, page, username: permission.user.username }]])
  const contexts = []
  const readSql = dependencies.salesSql || salesSql
  try {
    for (let step = 0; step < 12; step++) {
      const tasks = await salesArray(api,
        `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`)
      const active = tasks.filter((task) => task.endTime == null && Number(task.status) === 1)
      if (!active.length) {
        const process = await salesProcessDetail(api, processId)
        salesFact(caseRecord, '销售 BPM 终态通过且无剩余待办',
          Boolean(process.endTime) && Number(process.status) === 2,
          `processInstanceId=${processId}, status=${process.status}, endTime=${process.endTime}`)
        return
      }
      for (const task of active) {
        const assigneeId = String(task.assigneeUser?.id || '')
        const rows = stableId(assigneeId) ? await readSql(caseRecord, 'approval-actual-assignee',
          `SELECT username FROM system_users WHERE tenant_id=1 AND deleted=0 AND status=0 AND id=${sqlId(assigneeId)}`) : []
        const username = rows.length === 1 ? rows[0]?.[0] || '' : ''
        const taskEvidence = `processInstanceId=${processId}, taskId=${task.id}, node=${task.taskDefinitionKey}, ` +
          `actualAssigneeId=${assigneeId}, actualUsername=${username}`
        caseRecord.evidence.push(taskEvidence)
        if (!nonEmpty(task.id) || !nonEmpty(username) || task.processInstanceId !== processId ||
            !nonEmpty(task.taskDefinitionKey)) {
          throw new Error(`BLOCKED: 销售审批缺少准确任务/启用账号；${taskEvidence}`)
        }
        if (!sessions.has(assigneeId)) {
          const credentials = resolveSalesApproverCredential(username, dependencies.credentialOptions)
          if (!credentials) throw new Error(`BLOCKED: 销售审批实际账号无现有本地凭据；${taskEvidence}；未猜密码/转派任务`)
          const context = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' })
          contexts.push(context)
          const approvalPage = await context.newPage()
          let auth
          try {
            auth = await (dependencies.login || login)(approvalPage,
              { credentials: { ...credentials, tenantName: config.tenantName }, returnContext: true })
          } catch {
            throw new Error(`BLOCKED: 实际审批账号一次登录失败；${taskEvidence}；未尝试其他密码/重置/转派`)
          }
          const approverApi = (dependencies.createApiClient || createApiClient)({ token: auth.token, tenantId: '1', record })
          const identity = salesData(await approverApi.getBusiness('/system/auth/get-permission-info'), '审批账号权限').user
          if (String(auth.tenantId) !== '1' || !sameId(identity?.id, assigneeId) || identity.username !== username) {
            throw new Error(`BLOCKED: 实际审批身份/租户不一致；${taskEvidence}`)
          }
          sessions.set(assigneeId, { api: approverApi, page: approvalPage, username: identity.username })
        }
        const approver = sessions.get(assigneeId)
        if (approver.username !== username) {
          throw new Error(`BLOCKED: 实际审批会话账号不一致；${taskEvidence}`)
        }
        const todo = salesData(await approver.api.getBusiness(
          `/bpm/task/my-todo?processInstanceId=${encodeURIComponent(processId)}&taskId=${encodeURIComponent(task.id)}`),
          '实际账号待办')
        // my-todo is scoped to the authenticated user; its converter omits assigneeUser.
        if (!todo || todo.id !== task.id || todo.processInstanceId !== processId ||
            todo.taskDefinitionKey !== task.taskDefinitionKey ||
            Number(todo.status) !== 1 || todo.endTime != null ||
            (todo.assigneeUser != null && !sameId(todo.assigneeUser.id, assigneeId))) {
          throw new Error(`BLOCKED: 实际账号未收到准确待办；${taskEvidence}`)
        }
        salesFact(caseRecord, '实际审批身份取得同流程同节点准确待办', true,
          `${taskEvidence}, todoProcessInstanceId=${todo.processInstanceId}, todoStatus=${todo.status}`)
        const approved = salesData(await approver.api.putBusiness('/bpm/task/approve',
          { id: task.id, reason: 'E2E-SALES tenant1 专属数据验收' }), '正式销售 BPM 审批')
        salesFact(caseRecord, '正式审批 API 返回业务通过', approved === true, taskEvidence)
        const history = await salesArray(api,
          `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`)
        const completed = history.find((row) => row.id === task.id)
        salesFact(caseRecord, '实际 assignee 正式审批后历史任务通过且已结束',
          Boolean(completed?.endTime) && Number(completed.status) === 2 &&
          sameId(completed.assigneeUser?.id, assigneeId),
          `${taskEvidence}, status=${completed?.status}, endTime=${completed?.endTime}`)
      }
    }
    throw new Error(`BLOCKED: 销售审批超过 12 节点，processInstanceId=${processId}`)
  } finally {
    for (const context of contexts) await context.close()
  }
}

export async function cancelOwnedSalesProcess(api, processId, caseRecord) {
  assertOwnedSalesProcess(processId, caseRecord)
  const process = await salesProcessDetail(api, processId)
  if (process.endTime) {
    salesFact(caseRecord, '销售流程已正式终结无需重复撤回', [2, 3, 4].includes(Number(process.status)),
      `processInstanceId=${processId}, status=${process.status}, endTime=${process.endTime}`)
    return
  }
  await api.request('DELETE', '/bpm/process-instance/cancel-by-start-user',
    { id: processId, reason: 'E2E-SALES 阻塞后通过发起人正式取消清理' }).then((response) =>
    assertBusinessSuccess(response, '正式取消销售审批'))
  const after = await salesProcessDetail(api, processId)
  const tasks = await salesArray(api,
    `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`)
  const active = tasks.filter((task) => task.endTime == null && Number(task.status) === 1)
  salesFact(caseRecord, '阻塞流程通过发起人正式取消且终态/任务回读',
    Boolean(after.endTime) && Number(after.status) === 4 && active.length === 0,
    `processInstanceId=${processId}, status=${after.status}, endTime=${after.endTime}, activeTasks=${active.length}`)
}

export async function createSalesSettlementAccount(api, caseRecord, tag) {
  if (!/^E2E-SALES-[A-Z0-9-]+$/.test(tag || '')) {
    throw new Error('BLOCKED: ERP settlementAccount 只允许专属销售测试编码')
  }
  const types = await salesRows(api, '/system/dict-data/page?pageNo=1&pageSize=100&dictType=erp_account_type')
  const type = types.find((row) => Number(row.status) === 0 && nonEmpty(row.value))
  if (!type) throw new Error('BLOCKED: ERP settlementAccount 缺少启用的 erp_account_type')
  const id = salesId(await api.postBusiness('/erp/account/create', {
    name: `${tag}-SETTLEMENT`, no: tag, accountType: type.value, currency: 'CNY',
    status: 0, sort: 1, purpose: 'E2E销售期初验收', remark: tag,
    effectiveFrom: salesDate()
  }), '创建专属 ERP settlementAccount')
  owned(caseRecord, 'erp-settlement-account', id, { no: tag, accountType: type.value })
  const account = await salesDetail(api, `/erp/account/get?id=${id}`)
  salesFact(caseRecord, '专属 ERP settlementAccount 启用且非 FMS bank 账套', sameId(account.id, id) &&
    account.name === `${tag}-SETTLEMENT` && Number(account.status) === 0 &&
    account.accountType === type.value, `accountId=${id}, accountType=${account.accountType}`)
  return account
}

async function createSignedSalesContract(context, api, userId) {
  const { caseRecord } = context
  const fixture = await createSalesFixture(api, caseRecord, userId, { crm: true })
  let processId
  let contractId
  try {
    const types = await salesArray(api, '/crm/business-status/type-simple-list')
    if (!types[0]?.id) throw new Error('BLOCKED: 当前账号没有适用商机状态组')
    const businessId = salesId(await api.postBusiness('/crm/business/create', {
      name: fixture.tag, customerId: fixture.customerId, ownerUserId: userId, statusTypeId: types[0].id,
      discountPercent: 0, quoteQualificationStatus: '未申请', remark: fixture.tag,
      products: [{ productId: fixture.material.id, productPrice: 88.8, businessPrice: 88.8, count: 2 }]
    }), '创建专属商机')
    fixture.businessId = businessId
    owned(caseRecord, 'crm-business', businessId)
    const business = await salesDetail(api, `/crm/business/get?id=${businessId}`)
    salesFact(caseRecord, '专属商机保留客户、物料与金额', sameId(business.customerId, fixture.customerId) &&
      Number(business.totalPrice) === 177.6, `businessId=${businessId}, customerId=${fixture.customerId}, totalPrice=${business.totalPrice}`)
    contractId = salesId(await api.postBusiness('/crm/contract/create', {
      name: fixture.tag, customerId: fixture.customerId, businessId, sourceType: 10, ownerUserId: userId,
      orderDate: salesTime(), discountPercent: 0, remark: fixture.tag,
      products: [{ productId: fixture.material.id, productPrice: 88.8, contractPrice: 88.8, count: 2 }],
      receivablePlans: [{ sequenceNo: 1, conditionName: 'E2E-SALES 签署后全款',
        planDate: salesTime(), percentage: 100, amount: 177.6, remindDays: 0, remark: fixture.tag }]
    }), '创建专属商机合同')
    fixture.contractId = contractId
    owned(caseRecord, 'crm-contract', contractId)
    const draft = await salesDetail(api, `/crm/contract/get?id=${contractId}`)
    salesFact(caseRecord, '商机合同草稿来源、明细和收款计划金额一致',
      sameId(draft.businessId, businessId) && sameId(draft.customerId, fixture.customerId) &&
      Number(draft.totalPrice) === 177.6 && Number(draft.receivablePlans?.[0]?.amount) === 177.6,
      `contractId=${contractId}, businessId=${businessId}, totalPrice=${draft.totalPrice}`)
    await expectSalesRejection(api, 'POST', '/crm/contract/confirm-signed', { id: contractId },
      /审批|审核/, caseRecord, '未经审批的合同不允许直接签署')
    await api.putBusiness(`/crm/contract/submit?id=${contractId}`)
    const submitted = await salesDetail(api, `/crm/contract/get?id=${contractId}`)
    processId = submitted.processInstanceId
    owned(caseRecord, 'contract-bpm', processId, {
      tag: fixture.tag, businessId, contractId
    })
    await approveOwnedSalesProcess({ ...context, api, processId })
    const approved = await salesDetail(api, `/crm/contract/get?id=${contractId}`)
    salesFact(caseRecord, '合同正式 BPM 通过后 auditStatus=20', Number(approved.auditStatus) === 20,
      `contractId=${contractId}, processInstanceId=${processId}, auditStatus=${approved.auditStatus}`)
    const firstPlans = salesData(await api.postBusiness('/crm/contract/confirm-signed', { id: contractId }), '签署合同')
    const signed = await salesDetail(api, `/crm/contract/get?id=${contractId}`)
    salesFact(caseRecord, '合同同时已审已签', Number(signed.auditStatus) === 20 && Number(signed.signStatus) === 30,
      `contractId=${contractId}, auditStatus=${signed.auditStatus}, signStatus=${signed.signStatus}`)
    const linked = await salesContractOrders(api, fixture)
    salesFact(caseRecord, '合同仅生成一张销售订单', linked.length === 1, `contractId=${contractId}, count=${linked.length}`)
    fixture.order = await salesDetail(api, `/erp/sale-order/get?id=${linked[0].id}`)
    owned(caseRecord, 'contract-sale-order', fixture.order.id)
    assertSalesOrderEvidence(fixture.order, {
      customerId: fixture.partnerId, materialId: fixture.material.id, unitId: fixture.material.unitId,
      count: 2, price: 88.8, amount: 177.6, contractId
    }, caseRecord)
    const orderSource = await salesSql(caseRecord, 'contract-order-source', `
      SELECT id, contract_id, customer_id FROM erp_sale_order
      WHERE tenant_id=1 AND deleted=0 AND contract_id=${sqlId(contractId)}
    `)
    salesFact(caseRecord, '数据库合同关联与正式来源响应一致且有效订单唯一',
      orderSource.length === 1 && sameId(orderSource[0][0], fixture.order.id) &&
      sameId(orderSource[0][1], contractId) && sameId(orderSource[0][2], fixture.partnerId),
      `contractId=${contractId}, orderId=${fixture.order.id}, count=${orderSource.length}`)
    const secondPlans = salesData(await api.postBusiness('/crm/contract/confirm-signed', { id: contractId }), '重复签署')
    const repeatedOrders = await salesContractOrders(api, fixture)
    salesFact(caseRecord, '重复确认签署不重复生成订单和回款计划',
      Array.isArray(firstPlans) && firstPlans.length === 1 && Array.isArray(secondPlans) &&
      JSON.stringify(firstPlans.map(String)) === JSON.stringify(secondPlans.map(String)) &&
      repeatedOrders.length === 1,
      `contractId=${contractId}, orderId=${fixture.order.id}, planIds=${JSON.stringify(firstPlans)}`)
    fixture.planIds = firstPlans
    return fixture
  } catch (error) {
    const cleanupErrors = []
    if (processId) {
      try { await cancelOwnedSalesProcess(api, processId, caseRecord) } catch (cleanup) {
        cleanupErrors.push(cleanup.message)
        caseRecord.checks.push({ name: '正式取消阻塞销售流程', passed: false, details: cleanup.message })
      }
    }
    if (contractId) {
      try {
        await api.postBusiness('/crm/contract/void', { id: contractId, reason: 'E2E-SALES 阻塞链路正式作废' })
        const voided = await salesDetail(api, `/crm/contract/get?id=${contractId}`)
        salesFact(caseRecord, '阻塞专属合同正式作废回读', Number(voided.signStatus) === 40,
          `contractId=${contractId}, signStatus=${voided.signStatus}`)
      } catch (cleanup) {
        cleanupErrors.push(cleanup.message)
        caseRecord.checks.push({ name: '阻塞专属合同正式作废', passed: false, details: cleanup.message })
        caseRecord.notes.push(`合同正式作废未完成 contractId=${contractId}：${cleanup.message}`)
      }
    }
    if (cleanupErrors.length) {
      throw new Error(`${error.message}; BLOCKED: 正式清理失败；${cleanupErrors.join('；')}`)
    }
    throw error
  }
}

async function createOwnedSalesOrder(api, fixture, saleTypeCode, caseRecord) {
  const body = salesOrderBody(fixture, saleTypeCode)
  const id = salesId(await api.postBusiness('/erp/sale-order/create', body), '创建专属销售订单')
  owned(caseRecord, 'sale-order', id)
  const order = await salesDetail(api, `/erp/sale-order/get?id=${id}`)
  assertSalesOrderEvidence(order, { customerId: fixture.partnerId, materialId: fixture.material.id,
    unitId: fixture.material.unitId, count: 2, price: 88.8, amount: 177.6 }, caseRecord)
  return order
}

async function openSalesEvidence(context, api, dependencies) {
  if (erpSalesReadOnlyViews[context.caseId]) {
    await openErpSalesReadonlyView(context, api, dependencies)
  } else {
    const route = context.caseId === 'ERP-SALES-006'
      ? priceCenterRoute
      : openingSalesEvidenceRoute
    await (dependencies.openRoute || openRoute)(context.page, route,
      { readyText: context.caseId === 'ERP-SALES-006' ? '统一取价' : '出库' })
    const screenshot = await (dependencies.saveScreenshot || saveScreenshot)(
      context.page, context.outputDir, `${context.caseId}-write`, context.record)
    if (screenshot) context.caseRecord.evidence.push(screenshot)
  }
}

export async function runSalesWriteCase(context, api, userId, dependencies = {}) {
  const { caseId, caseRecord } = context
  salesCatalogEvidence(caseId, caseRecord)
  if (['ERP-SALES-001', 'ERP-SALES-002', 'ERP-SALES-003', 'ERP-SALES-004'].includes(caseId)) {
    const fixture = await createSignedSalesContract(context, api, userId)
    if (caseId === 'ERP-SALES-001') {
      const business = await salesDetail(api, `/crm/business/get?id=${fixture.businessId}`)
      const customer = await salesDetail(api, `/crm/customer/get?id=${fixture.customerId}`)
      salesFact(caseRecord, '合同签署回写客户成交及商机赢单', customer.dealStatus === true &&
        Number(business.endStatus) === 1, `customerId=${customer.id}, businessId=${business.id}, endStatus=${business.endStatus}`)
      salesCatalogEvidence(caseId, caseRecord, [1, 2, 3])
      caseRecord.notes.push('客户创建与成交回写已验证；当前 CRM 客户没有独立审核入口，原“客户审核”仍为 GAP')
    } else if (caseId === 'ERP-SALES-002') {
      const plans = await salesRows(api, `/crm/receivable-plan/page?pageNo=1&pageSize=100&contractId=${fixture.contractId}`)
      salesFact(caseRecord, '签署合同回款计划来源唯一且总额不超合同',
        plans.length === 1 && sameId(plans[0].contractId, fixture.contractId) &&
        Number(plans[0].price) === 177.6, `contractId=${fixture.contractId}, plans=${JSON.stringify(plans)}`)
      const accounts = await salesArray(api, '/erp/account/simple-list')
      caseRecord.notes.push(`资金账户可用数=${accounts.length}；未将 CRM 回款计划冒充财务应收或自动核销`)
      salesCatalogEvidence(caseId, caseRecord)
    } else {
      const processId = fixture.order.processInstanceId || fixture.order.bpmiInstanceId
      if (Number(fixture.order.status) !== 20) {
        if (!processId) throw new Error(`BLOCKED: 合同订单未审核且无流程 ID，orderId=${fixture.order.id}`)
        owned(caseRecord, 'sale-order-bpm', processId, {
          tag: fixture.tag, businessId: fixture.order.id, orderId: fixture.order.id
        })
        await approveOwnedSalesProcess({ ...context, api, processId })
      }
      caseRecord.notes.push('库存充足/不足、预留/在途和完整 OQC 需本轮专属库存基线；未使用共享库存')
      salesCatalogEvidence(caseId, caseRecord)
    }
  } else if (caseId === 'ERP-SALES-005') {
    await runOpeningSalesWrite(context, api, userId)
  } else if (caseId === 'ERP-SALES-006') {
    await runPriceSalesWrite(context, api, userId)
  } else if (caseId === 'ERP-SALES-007') {
    await runTypeSalesWrite(context, api, userId)
  } else throw new Error(`未知销售案例 ${caseId}`)
  await openSalesEvidence(context, api, dependencies)
  return { partial: !caseRecord.passCandidate, note: caseRecord.notes.at(-1) }
}

async function runOpeningSalesWrite(context, api, userId) {
  const { caseRecord, caseId } = context
  const fixture = await createSalesFixture(api, caseRecord, userId, { warehouse: true })
  const account = await createSalesSettlementAccount(api, caseRecord, fixture.tag)
  let before
  let id
  let invoiceId
  let approved = false
  let retainOpening = false
  try {
    await createSalesOpeningInventory(api, caseRecord, fixture, 106)
    before = await salesStockSnapshot(fixture, caseRecord, 'opening-before')
    const seeded = before.find((row) =>
      sameId(row[1], fixture.warehouseId) &&
      sameId(row[2], fixture.material.id) &&
      Number(row[3]) > 0)
    salesFact(caseRecord, '005 专属 mes_stk_inventory 非零基线已建立',
      Boolean(seeded), `warehouseId=${fixture.warehouseId}, materialId=${fixture.material.id}, rows=${before.length}`)
    if (!seeded) {
      throw new Error(
        `BLOCKED: ERP-SALES-005 专属 mes_stk_inventory 基线仍为空或数量为零；` +
        `warehouseId=${fixture.warehouseId}, materialId=${fixture.material.id}`
      )
    }
    const request = {
    businessType: 'OPENING', customerId: fixture.partnerId, accountId: account.id, outTime: salesTime(),
    goLiveBaseDate: salesDate(), openingInvoicedAmount: 0, discountPercent: 0, otherPrice: 0,
    remark: fixture.tag, items: [{ warehouseId: fixture.warehouseId, productId: fixture.material.id,
      productUnitId: fixture.material.unitId, productPrice: 88.8, count: 2, taxPercent: 0 }]
    }
    id = salesId(await api.postBusiness('/erp/sale-out/create', request), '创建专属期初销售出库')
    owned(caseRecord, 'opening-sale-out', id)
    await api.putBusiness(`/erp/sale-out/update-status?id=${id}&status=20`)
    approved = true
    const detail = await salesDetail(api, `/erp/sale-out/get?id=${id}`)
    salesFact(caseRecord, '期初出库无需订单但保存客商/明细并已审核', detail.businessType === 'OPENING' &&
      detail.orderId == null && sameId(detail.customerId, fixture.partnerId) &&
      Number(detail.status) === 20 && detail.items?.length === 1 &&
      Number(detail.totalPrice) === 177.6, `saleOutId=${id}, status=${detail.status}, amount=${detail.totalPrice}`)
    const after = await salesStockSnapshot(fixture, caseRecord, 'opening-after-approve')
    salesFact(caseRecord, '期初销售出库审核前后专属实物库存完全不变',
      JSON.stringify(before) === JSON.stringify(after), `warehouseId=${fixture.warehouseId}, materialId=${fixture.material.id}`)
    const links = await salesSql(caseRecord, 'opening-no-wms-no-order',
      `SELECT 'wms',COUNT(*) FROM mes_stk_io WHERE tenant_id=1 AND src_bill_id=${sqlId(id)};
       SELECT 'orders',COUNT(*) FROM erp_sale_order WHERE tenant_id=1 AND deleted=0 AND customer_id=${sqlId(fixture.partnerId)}`)
    salesFact(caseRecord, '期初出库不创建 WMS 单据且无订单可回写', links.length === 2 &&
      links.every((row) => row[1] === '0'), JSON.stringify(links))
    const balance = salesData(await api.getBusiness(`/erp/sale-out/opening-balance?id=${id}`), '期初可开票余额')
    salesFact(caseRecord, '期初可开票/已开票/剩余金额准确', sameId(balance.id, id) &&
      Number(balance.invoiceableAmount) === 177.6 && Number(balance.openingInvoicedAmount) === 0 &&
      Number(balance.remainingInvoiceableAmount) === 177.6, JSON.stringify(balance))
    await runNormalSalesOut(context, api, fixture, account, before)
    const candidates = await salesRows(api,
      `/erp/sale-out/page?pageNo=1&pageSize=100&businessType=OPENING&status=20&customerId=${fixture.partnerId}`)
    const selected = candidates.find((row) => sameId(row.id, id))
    salesFact(caseRecord, '正式发票选单接口返回本轮期初来源及剩余金额',
      selected?.businessType === 'OPENING' && Number(selected.totalPrice) === 177.6 &&
      Number(selected.openingInvoicedAmount) === 0 &&
      Number(selected.remainingInvoiceableAmount) === 177.6,
      `saleOutId=${id}, customerId=${fixture.partnerId}`)
    const invoiceTypes = await salesRows(api,
      '/system/dict-data/page?pageNo=1&pageSize=100&dictType=invoice_type')
    const invoiceType = invoiceTypes.find((row) => Number(row.status) === 0 && /^\d+$/.test(row.value))
    if (!invoiceType) throw new Error('BLOCKED: 缺少启用发票类型，未创建发票')
    const invoiceBody = salesOpeningInvoiceBody(fixture, detail, invoiceType.value, 59.2)
    await expectSalesRejection(api, 'POST', '/erp/sale-invoice/create',
      salesOpeningInvoiceBody(fixture, detail, invoiceType.value, 177.61),
      /超过|超出|可开票|金额/, caseRecord, '期初来源不允许超剩余金额开票')
    invoiceId = salesId(await api.postBusiness('/erp/sale-invoice/create', invoiceBody), '期初来源正式创建销售发票')
    owned(caseRecord, 'opening-sale-invoice', invoiceId, { tag: fixture.tag, saleOutId: id })
    retainOpening = true
    let invoice = await salesDetail(api, `/erp/sale-invoice/get?id=${invoiceId}`)
    if (Number(invoice.isEffective) !== 1) {
      const processId = invoice.processInstanceId || invoice.bpmiInstanceId
      if (processId) {
        owned(caseRecord, 'sale-invoice-bpm', processId, { tag: fixture.tag, businessId: invoiceId })
        await approveOwnedSalesProcess({ ...context, api, processId })
      } else {
        await api.putBusiness(`/erp/sale-invoice/update-status?id=${invoiceId}`)
      }
      invoice = await salesDetail(api, `/erp/sale-invoice/get?id=${invoiceId}`)
    }
    const invoiceDetails = JSON.parse(invoice.details || '{}')
    salesFact(caseRecord, '正式期初销售发票来源/金额/生效状态正确',
      invoice.srcBillType === 'OPENING_SALE_OUT' && String(invoice.srcBillId) === id &&
      sameId(invoice.customerId, fixture.partnerId) && Number(invoice.invoiceMoney) === 59.2 &&
      Number(invoiceDetails[id]) === 59.2 && Number(invoice.isEffective) === 1,
      `invoiceId=${invoiceId}, saleOutId=${id}, isEffective=${invoice.isEffective}, amount=${invoice.invoiceMoney}`)
    const invoiced = salesData(await api.getBusiness(`/erp/sale-out/opening-balance?id=${id}`), '期初开票后余额')
    salesFact(caseRecord, '期初真实开票后已开票及剩余金额正式回写',
      Number(invoiced.invoiceableAmount) === 177.6 && Number(invoiced.openingInvoicedAmount) === 59.2 &&
      Number(invoiced.remainingInvoiceableAmount) === 118.4, JSON.stringify(invoiced))
    await salesSql(caseRecord, 'opening-invoice-persisted',
      `SELECT id,src_bill_type,src_bill_id,invoice_money,is_effective,details FROM erp_sale_invoice
       WHERE tenant_id=1 AND id=${sqlId(invoiceId)};
       SELECT id,opening_invoiced_amount,total_price FROM erp_sale_out WHERE tenant_id=1 AND id=${sqlId(id)}`)
    const invoiceStock = await salesStockSnapshot(fixture, caseRecord, 'opening-invoice-no-stock-write')
    salesFact(caseRecord, '期初发票仅回写开票余额不改实物库存',
      JSON.stringify(before) === JSON.stringify(invoiceStock), `invoiceId=${invoiceId}`)
    salesCatalogEvidence(caseId, caseRecord, [0, 1, 2, 3, 4])
  } finally {
    if (id && !retainOpening) {
      if (approved) await api.putBusiness(`/erp/sale-out/update-status?id=${id}&status=0`)
      await api.deleteBusiness(`/erp/sale-out/delete?ids=${id}`)
      if (before) {
        const after = await salesStockSnapshot(fixture, caseRecord, 'opening-after-reverse')
        salesFact(caseRecord, '期初弃审/删除仅回退本轮单据且库存不变',
          JSON.stringify(before) === JSON.stringify(after), `saleOutId=${id}`)
      }
    } else if (id) {
      caseRecord.notes.push(`期初发票与来源均为专属历史事实，保留证据：saleOutId=${id}, invoiceId=${invoiceId}`)
    }
    if (!retainOpening) {
      await api.deleteBusiness(`/erp/account/delete?id=${account.id}`)
      const deletedAccount = await api.getBusiness(`/erp/account/get?id=${account.id}`)
      salesFact(caseRecord, '专属 ERP settlementAccount 正式删除清理', deletedAccount.data == null,
        `accountId=${account.id}`)
    }
  }
}

export function salesOpeningInvoiceBody(fixture, saleOut, invoiceType, amount) {
  if (!stableId(fixture.partnerId) || !stableId(saleOut?.id) ||
      !sameId(saleOut.customerId, fixture.partnerId) || saleOut.businessType !== 'OPENING' ||
      !/^E2E-SALES-[A-Z0-9-]+$/.test(fixture.tag || '') ||
      !/^\d+$/.test(String(invoiceType)) || !finiteNumber(amount) || Number(amount) <= 0) {
    throw new Error('BLOCKED: 期初开票仅允许专属客商/期初出库来源和有效金额')
  }
  return {
    customerId: String(fixture.partnerId), companyName: fixture.tag,
    taxNo: `E2E${String(fixture.tag).replace(/[^A-Z0-9]/g, '').slice(0, 30)}`,
    invoiceType: Number(invoiceType), invoiceMoney: Number(amount), taxRate: 0,
    srcBillType: 'OPENING_SALE_OUT', srcNo: saleOut.no, saleOrderNo: saleOut.no,
    billDate: salesDate(), subject: `${fixture.tag} opening invoice`, remark: fixture.tag,
    isAuto: 0, isRubric: 0, items: [{ saleOrderId: String(saleOut.id), invoiceMoneyItem: Number(amount) }]
  }
}

async function runNormalSalesOut(context, api, fixture, account, baseline) {
  const { caseRecord } = context
  const order = await createOwnedSalesOrder(api, fixture, 'NORMAL', caseRecord)
  let approvedOrder = order
  if (Number(order.status) !== 20) {
    await api.putBusiness(`/erp/sale-order/update-status?id=${order.id}&status=10`)
    approvedOrder = await salesDetail(api, `/erp/sale-order/get?id=${order.id}`)
    const processId = approvedOrder.processInstanceId || approvedOrder.bpmiInstanceId
    if (processId && Number(approvedOrder.status) !== 20) {
      owned(caseRecord, 'sale-order-bpm', processId, { tag: fixture.tag, businessId: order.id })
      await approveOwnedSalesProcess({ ...context, api, processId })
      approvedOrder = await salesDetail(api, `/erp/sale-order/get?id=${order.id}`)
    }
  }
  salesFact(caseRecord, '005 专属普通订单正式审核通过', Number(approvedOrder.status) === 20,
    `orderId=${order.id}, status=${approvedOrder.status}`)
  let outId
  let approved = false
  try {
    const request = { businessType: 'NORMAL', orderId: order.id, accountId: account.id,
      outTime: salesTime(), discountPercent: 0, otherPrice: 0, remark: fixture.tag,
      items: [{ orderItemId: approvedOrder.items[0].id, warehouseId: fixture.warehouseId,
        productId: fixture.material.id, productUnitId: fixture.material.unitId,
        productPrice: 88.8, count: 2, taxPercent: 0, remark: fixture.tag }] }
    caseRecord.evidence.push(`普通出库请求：${JSON.stringify(request)}`)
    outId = salesId(await api.postBusiness('/erp/sale-out/create', request), '创建专属普通销售出库')
    owned(caseRecord, 'normal-sale-out', outId, { tag: fixture.tag, orderId: order.id })
    await api.putBusiness(`/erp/sale-out/update-status?id=${outId}&status=20`)
    approved = true
    const out = await salesDetail(api, `/erp/sale-out/get?id=${outId}`)
    const stock = await salesStockSnapshot(fixture, caseRecord, 'normal-out-stock')
    const total = (rows) => rows.reduce((sum, row) => sum + Number(row[3]), 0)
    const afterOrder = await salesDetail(api, `/erp/sale-order/get?id=${order.id}`)
    salesFact(caseRecord, '普通销售出库正式扣减 WMS 库存并回写订单及明细 outCount',
      out.businessType === 'NORMAL' && Number(out.status) === 20 && sameId(out.orderId, order.id) &&
      total(baseline) - total(stock) === 2 && Number(afterOrder.outCount) === 2 &&
      Number(afterOrder.items?.[0]?.outCount) === 2,
      `saleOutId=${outId}, orderId=${order.id}, stockBefore=${total(baseline)}, stockAfter=${total(stock)}, outCount=${afterOrder.outCount}`)
    const wms = await salesSql(caseRecord, 'normal-out-wms-source',
      `SELECT id,stock_io_type,src_bill_type,src_bill_id,is_effective FROM mes_stk_io
       WHERE tenant_id=1 AND deleted=0 AND src_bill_type='ErpSaleOut' AND src_bill_id=${sqlId(outId)}`)
    salesFact(caseRecord, '普通出库以准确 ERP 来源生成生效 WMS 单据',
      wms.length === 1 && wms[0][1] === '201' && wms[0][3] === outId && wms[0][4] === '1',
      JSON.stringify(wms))
  } finally {
    if (outId) {
      if (approved) await api.putBusiness(`/erp/sale-out/update-status?id=${outId}&status=0`)
      await api.deleteBusiness(`/erp/sale-out/delete?ids=${outId}`)
      if (approved) {
        const restored = await salesStockSnapshot(fixture, caseRecord, 'normal-out-reversed')
        const afterOrder = await salesDetail(api, `/erp/sale-order/get?id=${order.id}`)
        salesFact(caseRecord, '普通出库正式弃审恢复专属库存且清除订单出库量',
          JSON.stringify(restored) === JSON.stringify(baseline) && Number(afterOrder.outCount) === 0,
          `saleOutId=${outId}, orderId=${order.id}, outCount=${afterOrder.outCount}`)
      }
    }
  }
}

export function salesPriceFixtureBodies(fixture, schemeId, price = 88.8) {
  if (!stableId(fixture.customerId) || !stableId(fixture.partnerId) ||
      !stableId(fixture.material?.id) || !stableId(fixture.material?.unitId) ||
      !/^E2E-SALES-[A-Z0-9-]+$/.test(fixture.tag || '')) {
    throw new Error('BLOCKED: 价格链必须使用同一个专属 CRM 客户/公共客商/物料')
  }
  return {
    // CRM has no saleTypeCode; a cross-domain scheme must not restrict business type.
    scheme: { priceDirection: 'SALE', code: fixture.tag, name: fixture.tag, priority: 0,
      businessTypeCode: '', currencyCode: 'CNY', status: 1, remark: fixtureRemark },
    publish: {
      schemeId, effectiveFrom: salesDate(), changeReason: fixture.tag,
      rules: [{ partnerId: String(fixture.partnerId), materialId: String(fixture.material.id),
        unitId: String(fixture.material.unitId), quantityFrom: 0, quantityTo: 100,
        currencyCode: 'CNY', taxIncluded: true, taxRate: 0, price, sort: 1, remark: fixture.tag }]
    },
    inquiry: { priceDirection: 'SALE', businessTypeCode: 'NORMAL',
      partnerId: String(fixture.partnerId), materialId: String(fixture.material.id),
      unitId: String(fixture.material.unitId), quantity: 2, priceDate: salesDate() }
  }
}

async function runPriceSalesWrite(context, api, userId) {
  const { caseRecord, caseId } = context
  const fixture = await createSalesFixture(api, caseRecord, userId, { crm: true })
  const { scheme } = salesPriceFixtureBodies(fixture)
  await withSalesPriceFixture(api, scheme, caseRecord, async (schemeId) => {
    const publish = (price) => api.postBusiness('/erp/price-scheme/publish',
      salesPriceFixtureBodies(fixture, schemeId, price).publish)
    const versionId = salesId(await publish(88.8), '发布专属销售价版本')
    owned(caseRecord, 'sale-price-scheme', schemeId, { code: fixture.tag, versionId })
    const inquiry = salesData(await api.postBusiness('/erp/price-scheme/inquiry',
      salesPriceFixtureBodies(fixture, schemeId).inquiry), '统一销售取价')
    salesFact(caseRecord, '专属销售取价实际命中方案/版本/价格行/依据/时间',
      inquiry.matched === true && sameId(inquiry.schemeId, schemeId) &&
      sameId(inquiry.versionId, versionId) && stableId(inquiry.ruleId) &&
      inquiry.hitSource === 'PARTNER' && inquiry.calculatedAt != null && Number(inquiry.price) === 88.8,
      JSON.stringify(inquiry))
    const order = await createOwnedSalesOrder(api, fixture, 'NORMAL', caseRecord)
    assertSalesPriceSnapshot(order.items[0], inquiry, caseRecord, '销售订单完整取价快照')
    const snapshot = salesPriceSnapshot(order.items[0])
    const contract = salesId(await api.postBusiness('/crm/contract/create', {
      name: fixture.tag, customerId: fixture.customerId, ownerUserId: userId, orderDate: salesTime(),
      discountPercent: 0, remark: fixture.tag, products: [{
        productId: fixture.material.id, productPrice: 88.8, contractPrice: 88.8, count: 2 }]
    }), '创建专属价格合同')
    owned(caseRecord, 'price-contract', contract)
    const contractBefore = await salesDetail(api, `/crm/contract/get?id=${contract}`)
    salesFact(caseRecord, '价格合同、订单与方案使用同一 CRM 客户映射的专属公共客商',
      sameId(contractBefore.customerId, fixture.customerId) && sameId(order.customerId, fixture.partnerId),
      `crmCustomerId=${fixture.customerId}, partnerId=${fixture.partnerId}, contractId=${contract}, orderId=${order.id}`)
    assertSalesPriceSnapshot(contractBefore.products?.[0], inquiry, caseRecord, 'CRM 合同完整取价快照')
    await publish(99.9)
    const updatedInquiry = salesData(await api.postBusiness('/erp/price-scheme/inquiry',
      salesPriceFixtureBodies(fixture, schemeId).inquiry), '销售新版本取价')
    const history = await salesDetail(api, `/erp/sale-order/get?id=${order.id}`)
    const contractAfter = await salesDetail(api, `/crm/contract/get?id=${contract}`)
    salesFact(caseRecord, '发布新版本实际取价改变且历史订单/合同快照不变',
      Number(updatedInquiry.price) === 99.9 && !sameId(updatedInquiry.versionId, versionId) &&
      JSON.stringify(salesPriceSnapshot(history.items[0])) === JSON.stringify(snapshot) &&
      JSON.stringify(salesPriceSnapshot(contractAfter.products[0])) ===
      JSON.stringify(salesPriceSnapshot(contractBefore.products[0])) &&
      Number(history.items[0].productPrice) === 88.8, `orderId=${order.id}, contractId=${contract}, oldVersion=${versionId}, newVersion=${updatedInquiry.versionId}`)
    salesCatalogEvidence(caseId, caseRecord, [0, 1, 4, 5])
    caseRecord.notes.push('采购订单、CRM 报价、已审核历史订单和取价不可用/未命中异常未冒称完整通过')
  })
}

export function salesTypeDictionaryBody(tag, dictType) {
  if (!/^E2E-SALES-[A-Z0-9-]+$/.test(tag || '') ||
      !['erp_sale_type', 'crm_sales_plan_type'].includes(dictType)) {
    throw new Error('BLOCKED: 只允许创建 E2E-SALES 专属业务字典值')
  }
  return { dictType, value: `${tag}-${dictType === 'erp_sale_type' ? 'S' : 'P'}`,
    label: tag, status: 0, sort: 9999, colorType: 'default', cssClass: '', remark: tag }
}

export async function createSalesTypeDictionary(api, caseRecord, tag, dictType, dependencies = {}) {
  const body = salesTypeDictionaryBody(tag, dictType)
  const readSql = dependencies.salesSql || salesSql
  const id = salesId(await api.postBusiness('/system/dict-data/create', body), '创建专属销售业务字典')
  owned(caseRecord, 'sales-type-dictionary', id, { tag, dictType, value: body.value })
  const row = await salesDetail(api, `/system/dict-data/get?id=${id}`)
  const rows = await readSql(caseRecord, 'owned-sales-dictionary',
    `SELECT tenant_id,dict_type,value,status,remark FROM system_dict_data WHERE deleted=0 AND id=${sqlId(id)}`)
  salesFact(caseRecord, '专属销售业务字典创建仅属于 tenant1，不覆盖平台模板',
    row.value === body.value && row.dictType === dictType && Number(row.status) === 0 &&
    rows.length === 1 && rows[0][0] === '1' && rows[0][1] === dictType &&
    rows[0][2] === body.value && rows[0][3] === '0' && rows[0][4] === tag,
    `dictId=${id}, dictType=${dictType}, value=${body.value}`)
  return { ...body, id }
}

export async function disableSalesTypeDictionary(api, caseRecord, dictionary, dependencies = {}) {
  const { id, dictType, value, remark } = dictionary
  const expected = salesTypeDictionaryBody(remark, dictType)
  const proof = caseRecord.fixtures?.find((row) => row.kind === 'sales-type-dictionary' &&
    sameId(row.id, id) && row.owned === true && row.tenantId === 1 &&
    row.tag === remark && row.dictType === dictType && row.value === value)
  if (!proof || expected.value !== value) throw new Error('BLOCKED: 禁止停用非本轮专属字典')
  const readSql = dependencies.salesSql || salesSql
  const rows = await readSql(caseRecord, 'sales-dictionary-disable-owner',
    `SELECT tenant_id,dict_type,value,remark FROM system_dict_data WHERE deleted=0 AND id=${sqlId(id)}`)
  if (rows.length !== 1 || rows[0][0] !== '1' || rows[0][1] !== dictType ||
      rows[0][2] !== value || rows[0][3] !== remark) {
    throw new Error('BLOCKED: 专属字典租户/所有权不一致，未停用')
  }
  await api.putBusiness('/system/dict-data/update', { ...expected, id, status: 1 })
  const disabled = await salesDetail(api, `/system/dict-data/get?id=${id}`)
  salesFact(caseRecord, '仅停用本轮销售业务字典且正式回读一致',
    disabled.value === value && disabled.dictType === dictType && Number(disabled.status) === 1,
    `dictId=${id}, dictType=${dictType}, value=${value}`)
}

async function runTypeSalesWrite(context, api, userId) {
  const { caseRecord, caseId } = context
  const fixture = await createSalesFixture(api, caseRecord, userId)
  const dictionaries = []
  try {
  for (const type of ['erp_sale_type', 'crm_sales_plan_type']) {
    dictionaries.push(await createSalesTypeDictionary(api, caseRecord, fixture.tag, type))
  }
  const [saleType, planType] = dictionaries
  const order = await createOwnedSalesOrder(api, fixture, saleType.value, caseRecord)
  salesFact(caseRecord, '销售订单正式保存销售类型稳定编码', order.saleTypeCode === saleType.value,
    `orderId=${order.id}, saleTypeCode=${order.saleTypeCode}`)
  const request = { name: fixture.tag, planYear: new Date().getFullYear(), planTypeCode: planType.value,
    contractTarget: 177.6, receivableTarget: 177.6, ownerUserId: userId, remark: fixture.tag,
    items: [{ layerType: 'PRODUCT', targetType: 'PRODUCT', targetId: fixture.material.id,
      targetName: fixture.material.name, periodType: 'YEAR', periodValue: String(new Date().getFullYear()),
      contractTarget: 177.6, receivableTarget: 177.6 }] }
  const planId = salesId(await api.postBusiness('/crm/sales-plan/create', request), '创建专属类型销售计划')
  owned(caseRecord, 'sales-plan', planId)
  const plan = await salesDetail(api, `/crm/sales-plan/get?id=${planId}`)
  salesFact(caseRecord, '销售计划正式保存计划类型和目标快照', plan.planTypeCode === planType.value &&
    Number(plan.contractTarget) === 177.6 && plan.items?.length === 1 &&
    String(plan.items[0].targetId) === String(fixture.material.id),
    `planId=${planId}, planTypeCode=${plan.planTypeCode}, contractTarget=${plan.contractTarget}`)
  for (const [action, status] of [['submit', '待审批'], ['publish', '已发布'], ['start', '执行中']]) {
    await api.putBusiness(`/crm/sales-plan/${action}?id=${planId}`)
    const next = await salesDetail(api, `/crm/sales-plan/get?id=${planId}`)
    salesFact(caseRecord, `销售计划正式${action}状态准确`, next.status === status &&
      next.planTypeCode === planType.value, `planId=${planId}, status=${next.status}, planTypeCode=${next.planTypeCode}`)
  }
  for (const dictionary of dictionaries) await disableSalesTypeDictionary(api, caseRecord, dictionary)
  await expectSalesRejection(api, 'POST', '/erp/sale-order/create',
    salesOrderBody(fixture, saleType.value), /字典|启用|不存在|禁用|停用/, caseRecord, '本轮停用销售类型拒绝新订单')
  await expectSalesRejection(api, 'POST', '/crm/sales-plan/create',
    { ...request, name: `${fixture.tag}-REJECTED` }, /字典|启用|不存在|禁用|停用/,
    caseRecord, '本轮停用计划类型拒绝新计划')
  const historicalOrder = await salesDetail(api, `/erp/sale-order/get?id=${order.id}`)
  const historicalPlan = await salesDetail(api, `/crm/sales-plan/get?id=${planId}`)
  salesFact(caseRecord, '停用专属类型后历史订单/计划仍可查询且稳定编码和金额快照不变',
    historicalOrder.saleTypeCode === saleType.value && historicalPlan.planTypeCode === planType.value &&
    Number(historicalOrder.totalPrice) === Number(order.totalPrice) &&
    Number(historicalPlan.contractTarget) === Number(plan.contractTarget),
    `orderId=${order.id}, saleTypeCode=${historicalOrder.saleTypeCode}, planId=${planId}, planTypeCode=${historicalPlan.planTypeCode}`)
  const historyRows = await salesSql(caseRecord, 'sales-type-history-snapshot',
    `SELECT 'order',sale_type_code FROM erp_sale_order WHERE tenant_id=1 AND id=${sqlId(order.id)};
     SELECT 'plan',plan_type_code FROM crm_sales_plan WHERE tenant_id=1 AND deleted=0 AND id=${sqlId(planId)}`)
  salesFact(caseRecord, '订单/计划稳定编码历史快照数据库证据完整',
    historyRows.length === 2 && historyRows[0][1] === saleType.value && historyRows[1][1] === planType.value,
    JSON.stringify(historyRows))
  salesCatalogEvidence(caseId, caseRecord, [0, 1, 2])
  } finally {
    for (const dictionary of dictionaries) {
      const row = await salesDetail(api, `/system/dict-data/get?id=${dictionary.id}`)
      if (Number(row.status) !== 1) await disableSalesTypeDictionary(api, caseRecord, dictionary)
    }
  }
}

export const runCase = async (context, dependencies = {}) => {
  if (dependencies.readonly === true) return runLegacySalesCase(context, dependencies)
  assertSalesLocalScope(dependencies.config || config)
  const { page, record, caseRecord } = context
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const auth = await (dependencies.login || login)(page, { returnContext: true })
  const token = typeof auth === 'string' ? auth : auth?.token
  const api = (dependencies.createApiClient || createApiClient)({ token, tenantId: '1', record })
  const tenantId = await api.tenantIdByName(config.tenantName)
  if (String(tenantId) !== '1' || (auth?.tenantId && String(auth.tenantId) !== '1')) {
    throw new Error('BLOCKED: 销售登录租户不匹配，未创建夹具')
  }
  const permission = salesData(await api.getBusiness('/system/auth/get-permission-info'), '销售权限')
  if (!stableId(permission?.user?.id)) throw new Error('BLOCKED: 销售认证缺少可信用户 ID')
  return runSalesWriteCase(context, api, permission.user.id, dependencies)
}
