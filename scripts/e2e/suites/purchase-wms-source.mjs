import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-283 收口：采购发票「关联采购入库」与应付取数统一到 WMS 采购入库（mes_stk_io，stock_io_type=101）。
export const cases = ['PUR-WMS-001']

const INVOICE_ROUTE = '/erp/purchase/invoice'
const WMS_PURCHASE_IN_ROUTE = '/wireSideWarehouse/in/inPurchase'
const LEGACY_PURCHASE_IN_COMPONENT = 'erp/purchase/in/index'
const WMS_PURCHASE_IN_COMPONENT = 'wms/stock/in/purchase/index'
const INVOICE_SOURCE_TYPES = [
  'ERP_PURCHASE_ORDER',
  'WMS_PURCHASE_IN',
  'MesOutsourcePayable',
  'OPENING_PURCHASE_IN'
]

const dataOf = (payload, label) => {
  assertBusinessSuccess(payload, label)
  if (!Object.hasOwn(payload, 'data')) throw new Error(`${label} 缺少 data；HTTP 200 不能代替业务响应`)
  return payload.data
}

const rowsOf = (payload, label) => {
  const data = dataOf(payload, label)
  const rows = data?.records ?? data?.list
  if (!Array.isArray(rows)) throw new Error(`${label} 列表响应缺少 records/list 数组`)
  if (!Number.isFinite(Number(data.total))) throw new Error(`${label} 分页缺少 total`)
  return rows
}

// 递归收集权限菜单树里可见的菜单组件到路由，用于断言采购入库入口唯一。
export const visibleComponentRoutes = (menus) => {
  if (!Array.isArray(menus)) throw new Error('权限信息缺少菜单树')
  const routes = new Map()
  const walk = (nodes, parent = '') => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const path = typeof node.path === 'string' ? node.path : ''
      const route = path.startsWith('http')
        ? path
        : (path.startsWith('/') ? path : `${parent}/${path}`).replace(/\/+/g, '/')
      const component = String(node.component || '')
        .replace(/^\/?(?:src\/)?views\//, '')
        .replace(/^\/+/, '')
        .replace(/\.vue$/, '')
      if (component) {
        if (!routes.has(component)) routes.set(component, [])
        routes.get(component).push(route)
      }
      if (Array.isArray(node.children)) walk(node.children, route)
    }
  }
  walk(menus)
  return routes
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId !== 'PUR-WMS-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const check = (name, passed, details) => caseRecord.checks.push({ name, passed: passed === true, details })
  const missing = []

  // 1) 采购入库事实源：mes_stk_io（101）+ mes_stk_io_entry 必须承载结算与开票进度。
  const stockRows = rowsOf(
    // 与前端「选采购入库」「添加采购入库单」两个取数入口同参数
    await api.getBusiness(
      '/mes/stkIo/list?pageNo=1&pageSize=100&stockIoType=101&isEffective=1&isVoided=0'
    ),
    'WMS 采购入库分页'
  )
  const stockHeaderFields = ['settleAmt', 'settledAmt', 'invoicedAmt']
  const stockEntryFields = ['invoicedQty', 'invoicedAmt', 'settleAmt', 'price', 'taxRate']
  const stockEntryMissing = stockRows
    .flatMap((row) => (Array.isArray(row.stkIoEntryList) ? row.stkIoEntryList : []))
    .flatMap((entry) => stockEntryFields.filter((field) => !Object.hasOwn(entry, field)))
  check(
    'PB-283 采购入库事实源为 mes_stk_io（101），单据头返回结算/开票金额，明细返回开票数量与金额',
    stockRows.length > 0 &&
      stockRows.every((row) => String(row.stockIoType) === '101' &&
        stockHeaderFields.every((field) => Object.hasOwn(row, field))) &&
      stockEntryMissing.length === 0,
    `rows=${stockRows.length}; 明细缺失字段=${[...new Set(stockEntryMissing)].join(',') || '无'}`
  )
  if (!stockRows.length) missing.push('mes_stk_io 无非作废的 101 采购入库样本，无法证明开票/付款取数字段')

  // 2) 采购发票分页仍保留来源字段，来源类型收敛到受控集合（新增 WMS_PURCHASE_IN）。
  const invoiceRows = rowsOf(
    await api.getBusiness('/erp/purchase-invoice/page?pageNo=1&pageSize=100'),
    '采购发票分页'
  )
  const invoiceSourceTypes = [...new Set(invoiceRows.map((row) => row.srcBillType).filter(Boolean))]
  check(
    'PB-283 采购发票分页返回 srcBillType/srcBillId，来源类型收敛在受控集合内',
    invoiceRows.every((row) => Object.hasOwn(row, 'srcBillType') && Object.hasOwn(row, 'srcBillId')) &&
      invoiceSourceTypes.every((type) => INVOICE_SOURCE_TYPES.includes(type)),
    `invoices=${invoiceRows.length}; 来源类型=${invoiceSourceTypes.join('|') || '空集'}`
  )

  // 3) 入口唯一：供应链 › 采购入库 停止显示，仓库 › 入库管理 › 采购入库 独立存在。
  const permissions = dataOf(await api.getBusiness('/system/auth/get-permission-info'), '权限信息')
  const routes = visibleComponentRoutes(permissions.menus)
  const legacyRoutes = routes.get(LEGACY_PURCHASE_IN_COMPONENT) || []
  const wmsRoutes = routes.get(WMS_PURCHASE_IN_COMPONENT) || []
  check(
    'PB-283 采购入库只保留「仓库 › 入库管理 › 采购入库」一个在用入口',
    legacyRoutes.length === 0 && wmsRoutes.length === 1,
    `旧入口=${legacyRoutes.join('|') || '无'}; WMS 入口=${wmsRoutes.join('|') || '无'}`
  )
  if (legacyRoutes.length) missing.push('供应链 › 采购入库（erp/purchase/in/index）仍对用户可见')

  // 4) 采购发票页面真实可打开（「选采购入库」入口的宿主页面）。
  await openRoute(page, INVOICE_ROUTE, { readyText: '采购发票' })
  const invoiceRendered = new URL(page.url()).pathname.startsWith(INVOICE_ROUTE)
  check('PB-283 采购发票页面可打开并渲染', invoiceRendered, page.url())
  await saveScreenshot(page, outputDir, 'purchase-invoice-list', record)

  // 5) 采购入库页面真实可打开（采购入库登记与开票来源同源）。
  await openRoute(page, WMS_PURCHASE_IN_ROUTE, { readyText: '入库单号' })
  const wmsRendered = new URL(page.url()).pathname.startsWith(WMS_PURCHASE_IN_ROUTE)
  check('PB-283 仓库 › 入库管理 › 采购入库页面可打开并渲染', wmsRendered, page.url())
  await saveScreenshot(page, outputDir, 'wms-purchase-in-list', record)

  caseRecord.evidence.push(
    '事实源：mes_stk_io + mes_stk_io_entry（stock_io_type=101）；erp_purchase_in/erp_purchase_in_items 停止写入，仅历史只读'
  )
  caseRecord.notes.push(
    `采购入库样本=${stockRows.length}；采购发票样本=${invoiceRows.length}；缺失前置=${missing.join('；') || '无'}`
  )
  return { token, api, missing }
}
