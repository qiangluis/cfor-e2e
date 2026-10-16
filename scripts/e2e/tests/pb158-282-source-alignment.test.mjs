import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// PB-158~PB-282 本轮收口能力的离线源码契约：后端端点/权限/迁移、前端页面入口、
// 自动化案例登记必须同时在位，缺一项即为对齐回退。
const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../'
)
const backend = path.join(workspace, 'cfor/cfor-admin')
const web = path.join(workspace, 'cfor/cfor-admin-vue3')
const testsDir = path.dirname(fileURLToPath(import.meta.url))

const read = (base, relative) => fs.readFileSync(path.join(base, relative), 'utf8')
const migration = (name) =>
  read(backend, path.join('cfor-server/src/main/resources/db/migration', name))
const catalog = JSON.parse(read(testsDir, '../cases/catalog.json'))
const suite = (id) => {
  const found = catalog.suites.find((item) => item.id === id)
  assert.ok(found, `catalog 缺少套件 ${id}`)
  return found
}
const casesOf = (id) => suite(id).cases.map((item) => item.id)

test('PB-238 合同结果分流只经售后 API 承接服务期，CRM 不建平行表', () => {
  const controller = read(
    backend,
    'cfor-module-crm/src/main/java/tech/cfor17/module/crm/controller/admin/contract/CrmContractServicePeriodController.java'
  )
  assert.match(controller, /@RequestMapping\("\/crm\/contract-service-period"\)/)
  assert.match(controller, /crm:contract-service-period:query/)
  assert.match(controller, /crm:contract-service-period:create/)

  const service = read(
    backend,
    'cfor-module-crm/src/main/java/tech/cfor17/module/crm/service/contract/CrmContractServicePeriodServiceImpl.java'
  )
  assert.match(service, /afterSalesInboundApi\.appendAssetServicePeriod/)
  assert.match(service, /CRM_CONTRACT_SERVICE:/)
  assert.match(service, /CRM_CONTRACT/)

  const afterSalesApi = read(
    backend,
    'cfor-module-after-sales/cfor-module-after-sales-api/src/main/java/tech/cfor17/module/aftersales/api/AfterSalesAssetApi.java'
  )
  assert.match(afterSalesApi, /listAssetsByCrmCustomer/)

  const permissions = migration('V202610162410__add_crm_contract_service_period_permissions.sql')
  assert.match(permissions, /crm:contract-service-period:create/)
  assert.match(permissions, /crm:contract-service-period:query/)
  assert.match(permissions, /contract\/index\.vue/)
  assert.match(permissions, /@crm_contract_menu_id IS NOT NULL/)

  // 事实源仍是售后服务期表，迁移里不允许出现 CRM 平行服务期表。
  const migrationFiles = fs.readdirSync(
    path.join(backend, 'cfor-server/src/main/resources/db/migration')
  )
  for (const file of migrationFiles) {
    if (!file.endsWith('.sql')) continue
    const sql = migration(file)
    assert.doesNotMatch(sql, /CREATE TABLE[^;]*crm_contract_service_period/i, file)
  }

  const page = read(web, 'src/views/crm/jixu/contract/index.vue')
  assert.match(page, /ContractServicePeriodApi/)
  assert.match(page, /crm:contract-service-period:create/)

  assert.deepEqual(casesOf('crm-contract-service-period'), [
    'CRM-CONTRACT-SERVICE-PERIOD-001',
    'CRM-CONTRACT-SERVICE-PERIOD-002'
  ])
})

test('PB-164 签收凭证经独立文件通道上传并落库到签收回执', () => {
  const controller = read(
    backend,
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/controller/customer/delivery/CustomerPortalFileController.java'
  )
  assert.match(controller, /@RequestMapping\("\/customer\/file"\)/)
  assert.match(controller, /@PostMapping\("\/upload"\)/)

  const fileService = read(
    backend,
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/service/sale/portal/CustomerPortalFileServiceImpl.java'
  )
  assert.match(fileService, /requireCustomerContext/)
  assert.match(fileService, /RECEIPT/)
  assert.match(fileService, /image\/png/)

  const receiptDO = read(
    backend,
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/dal/dataobject/sale/portal/CustomerPortalDeliveryReceiptDO.java'
  )
  assert.match(receiptDO, /attachmentName/)
  assert.match(receiptDO, /attachmentUrl/)

  const flyway = migration(
    'V202610162420__harden_customer_portal_delivery_and_invoice_feedback.sql'
  )
  assert.match(flyway, /customer_portal_delivery_receipt/)
  assert.match(flyway, /attachment_name/)
  assert.match(flyway, /attachment_url/)

  const page = read(web, 'src/customer/views/CustomerDelivery.vue')
  assert.match(page, /customerPortalUploadFile/)
  assert.match(page, /attachmentUrl/)
  const api = read(web, 'src/customer/api.ts')
  assert.match(api, /customerPortalUploadFile/)
  assert.match(api, /\/customer\/file\/upload/)
})

test('PB-168 发票接收状态只写门户回执表，不回写发票财务字段', () => {
  const controller = read(
    backend,
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/controller/customer/invoice/CustomerPortalInvoiceController.java'
  )
  assert.match(controller, /@PostMapping\("\/receipt"\)/)
  assert.match(controller, /@GetMapping\("\/receipt\/list"\)/)

  const impl = read(
    backend,
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/service/sale/portal/CustomerPortalInvoiceServiceImpl.java'
  )
  assert.match(impl, /invoiceReceiptMapper\.insert/)
  assert.match(impl, /RECEIVED/)
  assert.match(impl, /DISPUTED/)
  assert.match(impl, /selectByIdempotencyKey/)

  const flyway = migration(
    'V202610162420__harden_customer_portal_delivery_and_invoice_feedback.sql'
  )
  assert.match(flyway, /CREATE TABLE IF NOT EXISTS `customer_portal_invoice_receipt`/)
  assert.match(flyway, /uk_customer_portal_invoice_receipt_idem/)

  const page = read(web, 'src/customer/views/CustomerInvoices.vue')
  assert.match(page, /customerPortalReceiptInvoice/)
  assert.match(page, /loadReceipts/)

  assert.ok(casesOf('customer-portal').includes('CP-164-168-002'))
})

test('PB-271 销售对账导出独立成权限键并带页面入口与案例', () => {
  const controller = read(
    backend,
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/controller/admin/sale/ErpSaleReconciliationController.java'
  )
  assert.match(controller, /@GetMapping\("\/export-excel"\)/)
  assert.match(controller, /erp:sale-reconciliation:export/)
  assert.match(controller, /OperateTypeEnum\.EXPORT/)

  const respVO = read(
    backend,
    'cfor-module-erp/cfor-module-erp-biz/src/main/java/tech/cfor17/module/erp/controller/admin/sale/vo/reconciliation/ErpSaleReconciliationRespVO.java'
  )
  assert.match(respVO, /@ExcelIgnoreUnannotated/)
  assert.match(respVO, /@ExcelProperty\("对账单号"\)/)

  const permission = migration(
    'V202610162400__align_crm_modeling_menu_and_reconciliation_export.sql'
  )
  assert.match(permission, /erp:sale-reconciliation:export/)

  const page = read(web, 'src/views/erp/sale/reconciliation/index.vue')
  assert.match(page, /exportReconciliation/)
  assert.ok(casesOf('erp-sale-reconciliation').includes('ERP-SALE-RECON-003'))
})
