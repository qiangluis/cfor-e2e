import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// PB-283 采购买卖退货收口：采购退货的来源单据从历史 erp_purchase_in 切到 WMS 采购入库单
// （mes_stk_io，stock_io_type=101）。退货单头 srcBillType=WMS_PURCHASE_IN、srcBillId=mes_stk_io.id、
// 退货明细 srcEntryId=mes_stk_io_entry.id；历史 PurOrder 来源保留只读兼容，不再作为新建退货的入口。
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
const backend = path.join(workspace, 'cfor/cfor-admin')
const web = path.join(workspace, 'cfor/cfor-admin-vue3')
const testsDir = path.dirname(fileURLToPath(import.meta.url))

const read = (base, relative) => fs.readFileSync(path.join(base, relative), 'utf8')
const readBackend = (relative) => read(backend, relative)
const readWeb = (relative) => read(web, relative)
const existsWeb = (relative) => fs.existsSync(path.join(web, relative))
const catalog = JSON.parse(read(testsDir, '../cases/catalog.json'))
const caseIds = (suiteId) => {
  const suite = catalog.suites.find((item) => item.id === suiteId)
  assert.ok(suite, `catalog 缺少套件 ${suiteId}`)
  return suite.cases.map((item) => item.id)
}

const returnService =
  'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/service/purchase/ErpPurchaseReturnServiceImpl.java'
const returnController =
  'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/controller/admin/purchase/ErpPurchaseReturnController.java'
const errorCodes =
  'cfor-module-erp/cfor-module-erp-api/src/main/java/tech/cfor17/module/erp/enums/ErrorCodeConstants.java'
const stockIoApi =
  'cfor-module-wms/cfor-module-wms-api/src/main/java/tech/cfor17/module/wms/api/stock/WmsStockIoApi.java'
const orderLinkDto =
  'cfor-module-wms/cfor-module-wms-api/src/main/java/tech/cfor17/module/wms/api/stock/dto/WmsPurchaseInOrderLinkDTO.java'
const stockIoApiImpl =
  'cfor-module-wms/cfor-module-wms-biz/src/main/java/tech/cfor17/module/wms/service/stock/impl/WmsStockIoApiImpl.java'

test('PB-283 采购退货来源改为 WMS 采购入库单，且不再读取已废弃的 erp_purchase_in', () => {
  const service = readBackend(returnService)
  assert.match(service, /SRC_BILL_TYPE_WMS_PURCHASE_IN = "WMS_PURCHASE_IN"/)
  assert.match(service, /STOCK_IO_TYPE_PURCHASE_IN = "101"/)
  assert.match(service, /isWmsPurchaseInSource\(/)
  assert.match(service, /requireEffectivePurchaseIn\(/)
  assert.match(service, /wmsStockIoApi\.resolvePurchaseInOrderLink\(/)
  assert.match(service, /validateWmsPurchaseInReturnCount\(/)
  assert.match(service, /applyWmsReturnLimits|sumReturnedCountByPurchaseInEntryIds/)
  // 退货域不得再依赖已废弃的采购入库单服务或表
  assert.doesNotMatch(service, /ErpPurchaseInService/)
  assert.doesNotMatch(service, /erp_purchase_in/)
})

test('PB-283 采购退货明细以入库明细主键落库，历史采购订单来源保留只读兼容', () => {
  const service = readBackend(returnService)
  // 新口径：明细的来源分录是 mes_stk_io_entry.id，逐条校验属于所选入库单
  assert.match(service, /PURCHASE_RETURN_WMS_PURCHASE_IN_ITEM_NOT_EXISTS/)
  assert.match(service, /PURCHASE_RETURN_WMS_PURCHASE_IN_COUNT_EXCEED/)
  assert.match(service, /PURCHASE_RETURN_WMS_PURCHASE_IN_SUPPLIER_MISMATCH/)
  // 历史口径仍按采购订单建单（source 不为 WMS 时走 PurOrder 分支）
  assert.match(service, /purchaseOrderService\.getById\(createReqVO\.getSrcBillId\(\)\)/)

  const codes = readBackend(errorCodes)
  assert.match(codes, /PURCHASE_RETURN_WMS_PURCHASE_IN_NOT_EFFECTIVE/)
  assert.match(codes, /PURCHASE_RETURN_WMS_PURCHASE_IN_SUPPLIER_MISMATCH/)
})

test('PB-283 可退货视图接口暴露在采购退货控制器上', () => {
  const controller = readBackend(returnController)
  assert.match(controller, /@GetMapping\("\/wms-purchase-in\/returnable"\)/)
  assert.match(controller, /getReturnableWmsPurchaseIn/)
  assert.match(controller, /ErpPurchaseReturnWmsInRespVO/)
})

test('PB-283 采购订单退货数量回写走 WMS 归集关系，而不是退货表双存订单行', () => {
  const api = readBackend(stockIoApi)
  assert.match(api, /WmsPurchaseInOrderLinkDTO resolvePurchaseInOrderLink/)

  const dto = readBackend(orderLinkDto)
  assert.match(dto, /entryToOrderItemId/)
  assert.match(dto, /mes_stk_io_entry\.id/)
  assert.match(dto, /erp_purchase_order_item\.id/)

  // 采购订单直推与到货通知收货两种入库来源的归集规则统一由 WMS 解析
  const apiImpl = readBackend(stockIoApiImpl)
  assert.match(apiImpl, /PURCHASE_ORDER_SRC_BILL_TYPE/)
  assert.match(apiImpl, /ARRIVAL_NOTICE_SRC_BILL_TYPE/)
})

test('PB-283 前端采购退货选单改为选 WMS 采购入库单', () => {
  const dialog = readWeb('src/views/erp/purchase/return/formDialog.vue')
  assert.match(dialog, /WMS_PURCHASE_IN_SRC_BILL_TYPE = 'WMS_PURCHASE_IN'/)
  assert.match(dialog, /PurchaseInReturnEnableList/)
  assert.match(dialog, /selectPurchaseIn\.vue/)
  assert.match(dialog, /handlePurchaseInChange/)
  assert.match(dialog, /getWmsPurchaseInReturnable/)
  assert.match(dialog, /srcEntryId = item\.entryId/)
  assert.match(dialog, /来源单据/)
  assert.doesNotMatch(dialog, /selectOrder\.vue/)
  // 历史 PurOrder 来源仍可打开编辑（只读兼容）
  assert.match(dialog, /getSrcOrderInfoSetMaxReturnQty/)

  assert.ok(existsWeb('src/views/erp/purchase/return/selectPurchaseIn.vue'))
  assert.ok(!existsWeb('src/views/erp/purchase/return/selectOrder.vue'))

  const picker = readWeb('src/views/erp/purchase/return/selectPurchaseIn.vue')
  assert.match(picker, /wmsPurchaseInPage/)
  assert.match(picker, /getWmsPurchaseInReturnable/)
  assert.match(picker, /canReturnCount/)

  const api = readWeb('src/api/erp/purchase/return/index.ts')
  assert.match(api, /getWmsPurchaseInReturnable/)
  assert.match(api, /erp\/purchase-return\/wms-purchase-in\/returnable/)
})

test('PB-283 采购退货来源核查已登记自动化案例', () => {
  assert.ok(caseIds('purchase-wms-source').includes('PUR-WMS-002'))
})
