import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// PB-283 收口：采购入库唯一事实源是 WMS 出入库单（mes_stk_io，stock_io_type=101）+ mes_stk_io_entry，
// erp_purchase_in / erp_purchase_in_items 停止写入。采购发票「关联采购入库」、付款取数、采购成本来源
// 三处必须同时切到 WMS，任何一处回退到 erp_purchase_in 都视为对齐回退。
const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../'
)
const backend = path.join(workspace, 'cfor/cfor-admin')
const web = path.join(workspace, 'cfor/cfor-admin-vue3')
const testsDir = path.dirname(fileURLToPath(import.meta.url))

const read = (base, relative) => fs.readFileSync(path.join(base, relative), 'utf8')
const readBackend = (relative) => read(backend, relative)
const readWeb = (relative) => read(web, relative)
const catalog = JSON.parse(read(testsDir, '../cases/catalog.json'))
const caseIds = (suiteId) => {
  const suite = catalog.suites.find((item) => item.id === suiteId)
  assert.ok(suite, `catalog 缺少套件 ${suiteId}`)
  return suite.cases.map((item) => item.id)
}

const purchaseInvoiceService =
  'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/service/purchase/PurchaseInvoiceServiceImpl.java'
const saveReqVO =
  'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/controller/admin/purchase/vo/purchaseRequest/PurchaseInvoiceSaveReqVO.java'
const respVO =
  'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/controller/admin/purchase/vo/purchaseRequest/PurchaseInvoiceRespVO.java'
const paymentService =
  'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/service/finance/ErpFinancePaymentServiceImpl.java'
const costSource =
  'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/api/purchase/ErpPurchaseCostSourceApiImpl.java'
const statisticsMapper =
  'cfor-module-erp/cfor-module-erp-biz/src/main/resources/mapper/statistics/ErpPurchaseStatisticsMapper.xml'
const stockIoApi =
  'cfor-module-wms/cfor-module-wms-api/src/main/java/tech/cfor17/module/wms/api/stock/WmsStockIoApi.java'

test('PB-283 采购发票「关联采购入库」改为 WMS 采购入库来源，按明细粒度回写开票进度', () => {
  const service = readBackend(purchaseInvoiceService)
  assert.match(service, /WMS_PURCHASE_IN_SOURCE_TYPE = "WMS_PURCHASE_IN"/)
  assert.match(service, /WMS_PURCHASE_IN_STOCK_IO_TYPE = "101"/)
  assert.match(service, /validateWmsPurchaseInItem/)
  assert.match(service, /alterWmsPurchaseInInvoiced/)
  assert.match(service, /wmsStockIoApi::writeBackInvoiced/)
  assert.match(service, /listWmsPurchaseInBills/)
  // 来源类型判定必须先排除 WMS，避免携带 purchaseInId 的采购入库被当成期初采购入库
  assert.match(service, /if \(isWmsPurchaseInInvoiceItem\(item\)\) \{\s*return false;\s*\}/)
  // 采购入库来源的开票金额上限来自 WMS 结算金额与已开票金额，而不是 erp_purchase_in
  assert.match(
    service,
    /amountLimit = nvl\(line\.getSettleAmt\(\)\)[\s\S]*amountLimit\.subtract\(nvl\(line\.getInvoicedAmt\(\)\)\)/
  )

  assert.match(readBackend(saveReqVO), /purchaseInEntryId/)
  const resp = readBackend(respVO)
  assert.match(resp, /wmsPurchaseInList/)
  assert.match(resp, /sourceCountMap/)

  const api = readBackend(stockIoApi)
  assert.match(api, /void writeBackInvoiced\(/)
  assert.match(api, /WmsStockIoInvoiceWriteBackReqDTO/)
  assert.match(api, /int updateSettledAmount\(String billId, java\.math\.BigDecimal settledAmount\)/)
})

test('PB-283 应付取数与采购成本来源改读 WMS 采购入库，不再读 erp_purchase_in', () => {
  const payment = readBackend(paymentService)
  assert.match(payment, /resolveWmsPurchaseIn/)
  assert.match(payment, /wmsStockIoApi\.updateSettledAmount/)
  // 历史 erp_purchase_in 单据保留只读回退，但必须先命中 WMS
  assert.match(payment, /purchaseInService\.validatePurchaseIn/)

  const cost = readBackend(costSource)
  assert.match(cost, /WMS_PURCHASE_IN_STOCK_IO_TYPE = "101"/)
  assert.match(cost, /wmsStockIoApi\.listBills/)
  assert.match(cost, /WMS 出入库单/)

  // 采购金额统计不能再从 erp_purchase_in 取数
  const statistics = readBackend(statisticsMapper)
  const activeSql = statistics.split('-->').pop()
  assert.match(activeSql, /FROM mes_stk_io io/)
  assert.doesNotMatch(activeSql, /FROM erp_purchase_in/)
})

test('PB-283 前端采购发票与付款单取数入口已切到 WMS 采购入库', () => {
  const invoiceDialog = readWeb('src/views/erp/purchase/invoice/formDialogTable.vue')
  assert.match(invoiceDialog, /popupWmsPurchaseInChange/)
  assert.match(invoiceDialog, /WMS_PURCHASE_IN/)
  assert.match(invoiceDialog, /purchaseInEntryId/)
  assert.match(invoiceDialog, /选采购入库/)
  // 期初采购入库（不进入 WMS 实物库存的纸面期初）仍保留独立入口
  assert.match(invoiceDialog, /选期初入库/)

  const picker = readWeb('src/views/erp/purchase/invoice/switchPurchaseIn.vue')
  assert.match(picker, /wmsPurchaseInPage/)
  assert.doesNotMatch(picker, /erp\/purchase-in\/page/)

  const paymentList = readWeb(
    'src/views/erp/purchase/in/components/PurchaseInPaymentEnableList.vue'
  )
  assert.match(paymentList, /wmsPurchaseInPage/)
  assert.match(paymentList, /settledAmt/)
  assert.doesNotMatch(paymentList, /getPurchaseInPage/)

  const api = readWeb('src/api/erp/purchase/in/index.ts')
  assert.match(api, /stockIoType: '101'/)
})

test('PB-283 结构变更走 Flyway，erp_purchase_in 收敛为仅历史只读', () => {
  const migration =
    'cfor-server/src/main/resources/db/migration/V202610162600__finalize_wms_purchase_in_source.sql'
  const sql = readBackend(migration)
  assert.match(sql, /erp_purchase_in/)
  assert.match(sql, /仅历史只读/)
  // 只改表注释，不允许删除表、数据或菜单行
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i)
})

test('PB-283 采购入库来源核查已登记自动化案例', () => {
  assert.ok(caseIds('purchase-wms-source').includes('PUR-WMS-001'))
})

test('PB-283 采购订单入库记录与退货可退款列表不再依赖已废弃的 erp_purchase_in', () => {
  const orderForm = readWeb('src/views/erp/purchase/order/PurchaseOrderForm.vue')
  assert.match(orderForm, /wmsPurchaseInPage/)
  assert.match(orderForm, /srcBillId: formData\.value\.id/)
  assert.match(orderForm, /startsWith\('PurOrder'\)/)
  // 历史 erp_purchase_in 单据只作为只读兜底展示，来源打标区分
  assert.match(orderForm, /getPurchaseInPage/)
  assert.match(orderForm, /source: 'ERP'/)

  const returnMapper = readBackend(
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/dal/mysql/purchase/ErpPurchaseReturnMapper.java'
  )
  assert.doesNotMatch(returnMapper, /ErpPurchaseInDO/)
  assert.match(
    returnMapper,
    /eq\(ErpPurchaseReturnDO::getStatus, ErpAuditStatus\.APPROVE\.getStatus\(\)\)/
  )
})
