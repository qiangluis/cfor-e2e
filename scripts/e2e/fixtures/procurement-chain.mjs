import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { launchBrowser, loginWithCredentials, openRoute as defaultOpenRoute } from '../lib/browser.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { createWarehouseFixture, inventorySnapshot } from '../lib/wms-fixtures.mjs'
import { withProcurementManualIqc } from './procurement-manual-iqc.mjs'
import {
  PROCUREMENT_MRP_CHECKS,
  runProcurementMrpClosure
} from './procurement-mrp-closure.mjs'
import {
  checkInspection,
  createPlan,
  createPublishedItem,
  createQualityMaterialRule
} from './mes-quality-write.mjs'
import { PROCUREMENT_016_CONTRACTS } from './procurement-016-opening-closure.mjs'

export const procurementChainCases = Object.freeze([
  'PROC-001', 'PROC-002', 'PROC-003', 'PROC-004'
])

export const PROCUREMENT_ARRIVAL_NOTICE_REQUIRED = Object.freeze({
  code: 1_020_205_013,
  message: /采购入库必须来源于已提交的到货通知/
})

export const PROCUREMENT_CHAIN_ROUTES = Object.freeze({
  request: '/erp/purchase/purchaseRequest',
  order: '/erp/purchase/order',
  arrival: '/wireSideWarehouse/arrivalNotice',
  inbound: '/erp/purchase/in',
  return: '/erp/purchase/return'
})

const routeReadyText = Object.freeze({
  [PROCUREMENT_CHAIN_ROUTES.request]: '请购',
  [PROCUREMENT_CHAIN_ROUTES.order]: '采购订单',
  [PROCUREMENT_CHAIN_ROUTES.arrival]: '到货通知',
  [PROCUREMENT_CHAIN_ROUTES.inbound]: '采购入库',
  [PROCUREMENT_CHAIN_ROUTES.return]: '采购退货',
  '/mes/produce/mrpCalculation': 'MRP',
  '/erp/purchase/invoice': '采购发票'
})

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const stableId = (value, label) => {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error(`${label}未返回稳定 ID`)
  return String(value)
}
const now = () => new Date().toISOString().slice(0, 19)
const date = () => now().slice(0, 10)
const tagOf = () => `PROC_CHAIN_${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`
const PROCUREMENT_REQUISITION_CONFIG_PATH = '/system/config/get?category=purchase&tag=requisition'
const PROCUREMENT_REQUISITION_SAVE_PATH = '/system/config/save?category=purchase&tag=requisition'
const PROCUREMENT_ERP_OPTIONS_PATH = '/system/config/business-options/list?moduleCode=erp'

const enabledConfig = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0' || normalized === '') return false
  try {
    return JSON.parse(normalized)?.enabled === true
  } catch {
    return false
  }
}

const rowsOf = (payload, label) => {
  const value = dataOf(payload, label)
  const rows = value?.records ?? value?.list ?? value
  if (!Array.isArray(rows)) throw new Error(`${label}缺少 records/list 数组`)
  return rows
}

const purchaseOrderPayables = async (api, orderId, label) => {
  const rows = dataOf(
    await api.getBusiness(`/finance/finPayable/getPayableByPurId?id=${encodeURIComponent(orderId)}`),
    label
  )
  if (!Array.isArray(rows)) throw new Error(`${label}返回值不是数组`)
  return rows
}

const createProc003PurchaseInvoice = async ({ api, caseRecord, chain, record }) => {
  const invoiceId = stableId(
    dataOf(
      await api.postBusiness('/erp/purchase-invoice/create', {
        supplierId: chain.supplierId,
        companyName: '',
        taxNo: '',
        invoiceNo: `${chain.tag}-PUR-INV`,
        invoiceType: 1,
        taxRate: 0,
        invoiceMoney: Number(chain.quantity) * 10,
        invoicePrice: 10,
        isRubric: 0,
        remark: `${chain.tag} purchase invoice`,
        items: [{
          purchaseOrderId: String(chain.orderId),
          srcBillType: 'ERP_PURCHASE_ORDER',
          invoiceMoneyItem: Number(chain.quantity) * 10
        }]
      }),
      'PROC-003 采购发票创建'
    ),
    'PROC-003 采购发票'
  )
  const created = dataOf(
    await api.getBusiness(`/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`),
    'PROC-003 采购发票创建回读'
  )
  const sourcePassed = String(created?.srcBillType) === 'ERP_PURCHASE_ORDER' &&
    String(created?.srcBillId) === String(chain.orderId) &&
    String(created?.details || '').includes(String(chain.orderId)) &&
    Object.prototype.hasOwnProperty.call(created || {}, 'isEffective')
  const beforePayables = await purchaseOrderPayables(
    api, invoiceId, 'PROC-003 采购发票审核前应付反查'
  )
  let approved = await api.putBusiness(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoiceId)}`
  )
  let afterInvoice = dataOf(
    await api.getBusiness(`/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`),
    'PROC-003 采购发票审核后回读'
  )
  if (Number(afterInvoice?.isEffective) !== 1) {
    if (!uuid(afterInvoice?.processInstanceId)) {
      throw new Error(
        `BLOCKED: PROC-003 采购发票审核后未生效且缺少 BPM 流程：invoiceId=${invoiceId}`
      )
    }
    await approveWmsProcess({
      api,
      processId: afterInvoice.processInstanceId,
      caseRecord,
      record,
      label: 'PROC-003 采购发票',
      taskDefinitionKey: 'FirstApprove_purchase-invoice',
      stageApprovers: [
        {
          taskDefinitionKey: 'FirstApprove_purchase-invoice',
          username: config.financeApproverUsername,
          password: config.financeApproverPassword
        },
        {
          taskDefinitionKey: 'SecondApprove_purchase-invoice',
          username: config.financeApproverUsername,
          password: config.financeApproverPassword
        },
        {
          taskDefinitionKey: 'FinalApprove_purchase-invoice',
          username: config.finalApproverUsername,
          password: config.finalApproverPassword
        }
      ],
      reason: 'PROC-003 采购发票复核通过'
    })
    afterInvoice = await waitFor(
      async () => dataOf(
        await api.getBusiness(`/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`),
        'PROC-003 采购发票 BPM 审核回读'
      ),
      (value) => Number(value?.isEffective) === 1,
      60000,
      'PROC-003 采购发票复核生效'
    )
  }
  const afterPayables = await purchaseOrderPayables(
    api, invoiceId, 'PROC-003 采购发票审核后应付反查'
  )
  const generatedOnce = afterPayables.length === 1 &&
    String(afterPayables[0]?.srcBillType) === 'PurInvoice' &&
    String(afterPayables[0]?.srcBillId) === String(invoiceId)
  const duplicate = await api.put(
    `/erp/purchase-invoice/update-status?id=${encodeURIComponent(invoiceId)}`,
    undefined,
    { expectedBusinessRejection: PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved }
  )
  const afterDuplicatePayables = await purchaseOrderPayables(
    api, invoiceId, 'PROC-003 采购发票重复复核后应付反查'
  )
  const duplicateStable = afterDuplicatePayables.length === 1 &&
    String(afterDuplicatePayables[0]?.id) === String(afterPayables[0]?.id) &&
    matchesExpectedBusinessRejection(duplicate, PROCUREMENT_016_CONTRACTS.invoiceAlreadyApproved)
  const passed = sourcePassed && Number(afterInvoice?.isEffective) === 1 &&
    beforePayables.length === 0 && generatedOnce && duplicateStable
  addCheck(
    caseRecord,
    'PROC-003 采购发票复核后生成唯一采购应付，重复复核不重复生成',
    passed,
    JSON.stringify({
      invoiceId,
      sourcePassed,
      beforePayables: beforePayables.length,
      afterPayables: afterPayables.length,
      afterDuplicatePayables: afterDuplicatePayables.length,
      isEffective: afterInvoice?.isEffective,
      duplicate: { code: duplicate?.code, message: duplicate?.msg || duplicate?.message }
    })
  )
  if (!passed) throw new Error(`PROC-003 采购发票复核唯一应付断言未通过：invoiceId=${invoiceId}`)
  Object.assign(chain, {
    invoiceId,
    invoice: afterInvoice,
    invoicePayables: afterPayables,
    invoiceApproval: { beforePayables, afterPayables, duplicate }
  })
  return { invoiceId, invoice: afterInvoice, payables: afterPayables, approved }
}

async function prepareProcurementRequisitionMode ({ api, caseRecord, chain }) {
  if (chain.requisitionConfig?.prepared) return chain.requisitionConfig
  const configRow = dataOf(
    await api.getBusiness(PROCUREMENT_REQUISITION_CONFIG_PATH),
    '采购请购配置原值'
  )
  const originalValue = configRow?.configData == null
    ? 'false'
    : String(configRow.configData)
  const originalEnabled = enabledConfig(originalValue)
  const state = {
    prepared: true,
    originalValue,
    originalEnabled,
    temporaryOverride: !originalEnabled,
    optionCode: 'ERP.PURCHASE.REQUISITION',
    restored: false
  }
  chain.requisitionConfig = state
  caseRecord.evidence.push(
    `采购链记录 purchase/requisition 原值：${originalValue}; enabled=${originalEnabled}`
  )
  if (!originalEnabled) {
    await api.postBusiness(PROCUREMENT_REQUISITION_SAVE_PATH, { configData: 'true' })
    const options = rowsOf(
      await api.getBusiness(PROCUREMENT_ERP_OPTIONS_PATH),
      '采购链启用采购请购配置回读'
    )
    const option = options.find((item) => item?.optionCode === state.optionCode)
    if (!enabledConfig(option?.currentValue)) {
      throw new Error('BLOCKED: 采购链开始前采购请购配置写入后回读仍未启用')
    }
    caseRecord.evidence.push('PROC-001 开始前通过正式系统配置接口临时启用采购请购')
  }
  return state
}

async function restoreProcurementRequisitionMode ({ api, caseRecord, chain }) {
  const state = chain.requisitionConfig
  if (!state?.prepared || state.restored || !state.temporaryOverride) return
  await api.postBusiness(PROCUREMENT_REQUISITION_SAVE_PATH, {
    configData: state.originalValue
  })
  const restored = dataOf(
    await api.getBusiness(PROCUREMENT_REQUISITION_CONFIG_PATH),
    '采购链恢复采购请购配置回读'
  )
  if (String(restored?.configData ?? '') !== state.originalValue) {
    throw new Error(
      `BLOCKED: 采购链结束后采购请购配置恢复失败：expected=${state.originalValue}; ` +
      `actual=${restored?.configData ?? ''}`
    )
  }
  state.restored = true
  caseRecord.evidence.push(`PROC-004 结束后恢复 purchase/requisition 原值：${state.originalValue}`)
}

const planContext = (context = {}) => ({
  tag: context.tag || 'PROC_CHAIN_PLAN',
  requestId: context.requestId || '<approved-request-id>',
  requestBillNo: context.requestBillNo || '<request-bill-no>',
  mrpId: context.mrpId || '<mrp-calculation-id>',
  orderId: context.orderId || '<approved-order-id>',
  orderBillNo: context.orderBillNo || '<order-bill-no>',
  orderItemId: context.orderItemId || '<order-item-id>',
  materialId: context.materialId || '<material-id>',
  unitId: context.unitId || '<unit-id>',
  supplierId: context.supplierId || '<supplier-id>',
  warehouseId: context.warehouseId || '<warehouse-id>',
  areaId: context.areaId || null,
  locationId: context.locationId || null,
  qualityItemId: context.qualityItemId || null,
  qualityPlanId: context.qualityPlanId || null,
  quantity: context.quantity || 1
})

export function buildProcurementChainPlan (caseId, context = {}) {
  const value = planContext(context)
  const orderPayload = {
    type: 0,
    supplierId: value.supplierId,
    orderTime: now(),
    billDate: date(),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: value.quantity,
    totalProductPrice: value.quantity * 10,
    totalTaxPrice: 0,
    totalPrice: value.quantity * 10,
    directCreate: 0,
    remark: `${value.tag} order from approved request`,
    items: [{
      entryNo: 1,
      srcBillType: 'PURCHASE_REQUEST',
      srcBillId: value.requestId,
      srcEntryId: value.requestItemId || '<request-item-id>',
      productId: value.materialId,
      productUnitId: value.unitId,
      productPrice: 10,
      count: value.quantity,
      taxPercent: 0,
      totalPrice: value.quantity * 10,
      taxPrice: 0,
      remark: `${value.tag} order line`
    }]
  }
  const arrivalPayload = {
    code: `AUTOTEST-${value.tag}-ASN`,
    name: `AUTOTEST-${value.tag}-ASN`,
    purchaseOrderId: value.orderId,
    purchaseOrderCode: value.orderBillNo,
    vendorId: value.supplierId,
    supplierShipmentKey: `${value.tag}-SHIPMENT`,
    supplierShipmentNo: `${value.tag}-SHIPMENT-NO`,
    arrivalDate: now(),
    shippedAt: now(),
    remark: `${value.tag} arrival notice`,
    lines: [{
      itemId: value.materialId,
      purchaseOrderItemId: value.orderItemId,
      unitId: value.unitId,
      arrivalQuantity: value.quantity,
      iqcCheckFlag: true,
      batchNo: `${value.tag}-BATCH`
    }]
  }
  const receiptLines = [{
    lineId: '<arrival-line-id>',
    warehouseId: value.warehouseId,
    areaId: value.areaId,
    locationId: value.locationId,
    receivedQuantity: value.quantity,
    qualifiedQuantity: null,
    batchNo: `${value.tag}-BATCH`,
    idempotentKey: `${value.tag}-RECEIPT`
  }]
  const returnPayload = {
    billNo: `AUTOTEST-${value.tag}-RETURN`,
    billDate: date(),
    srcBillType: 'PurOrder',
    srcBillId: value.orderId,
    srcNo: value.orderBillNo,
    supplierId: value.supplierId,
    returnTime: now(),
    returnType: 2,
    status: 0,
    discountPercent: 0,
    otherPrice: 0,
    totalCount: value.quantity,
    totalProductPrice: value.quantity * 10,
    totalTaxPrice: 0,
    totalPrice: value.quantity * 10,
    remark: `${value.tag} return draft`,
    items: [{
      entryNo: 1,
      srcBillType: 'PURCHASE_ORDER',
      srcBillId: value.orderId,
      srcEntryId: value.orderItemId,
      warehouseId: value.warehouseId,
      areaHouseId: value.areaId,
      wareLocationId: value.locationId,
      productId: value.materialId,
      productUnitId: value.unitId,
      productPrice: 10,
      count: value.quantity,
      taxPercent: 0,
      totalPrice: value.quantity * 10,
      taxPrice: 0,
      remark: `${value.tag} return line`
    }]
  }

  const plans = {
    'PROC-001': {
      caseId, writes: [
        { method: 'POST', path: '/mes/mrp/calculate', body: { ownedExecutionFixture: true } },
        { method: 'POST', path: '/mes/mrp/generatePurchasePlan?calculationId=<mrp-id>' }
      ],
      reads: ['/mes/mrp/history?pageNo=1&pageSize=100', '/erp/purchase/order/request/get?id=<request-id>'],
      routes: [PROCUREMENT_CHAIN_ROUTES.request, '/mes/produce/mrpCalculation']
    },
    'PROC-002': {
      caseId, writes: [
        { method: 'PUT', path: '/erp/purchase/order/request/update-status?id=<request-id>&status=10' },
        { method: 'PUT', path: '/erp/purchase/order/request/place/an/order?ids=<request-id>&isSeparate=0' }
      ],
      reads: ['/erp/purchase/order/request/get?id=<request-id>', '/erp/purchase-order/page?pageNo=1&pageSize=100'],
      routes: [PROCUREMENT_CHAIN_ROUTES.request, PROCUREMENT_CHAIN_ROUTES.order]
    },
    'PROC-003': {
      caseId, writes: [
        { method: 'POST', path: '/mes/wms/arrival-notice/create', body: arrivalPayload },
        { method: 'POST', path: '/mes/wms/arrival-notice/submit?id=<arrival-id>' },
        { method: 'POST', path: '/mes/wms/arrival-notice/create-receipt-bill?id=<arrival-id>', body: receiptLines },
        { method: 'POST', path: '/erp/purchase-return/create', body: returnPayload }
      ],
      reads: ['/mes/wms/arrival-notice/get?id=<arrival-id>', '/mes/stkIo/queryById?id=<101-id>', '/mes/stkIo/queryEntryByMainId?id=<101-id>', '/erp/purchase-return/get?id=<return-id>'],
      routes: [PROCUREMENT_CHAIN_ROUTES.order, PROCUREMENT_CHAIN_ROUTES.arrival, PROCUREMENT_CHAIN_ROUTES.inbound, PROCUREMENT_CHAIN_ROUTES.return],
      note: '101 草稿与退货草稿通过正式 WMS/ERP API 创建；质检放行、库存可用量和退货审核必须由后续正式 WMS 流程驱动。'
    },
    'PROC-004': {
      caseId, writes: [
        { method: 'POST', path: '/erp/purchase-order/create', body: { ...orderPayload, directCreate: 0, items: [{ ...orderPayload.items[0], srcBillId: null, srcEntryId: null }] }, expected: 'business rejection' }
      ],
      reads: ['/system/config/business-options/list?moduleCode=erp', '/erp/purchase-order/get?id=<rejected-id>'],
      routes: [PROCUREMENT_CHAIN_ROUTES.order, '/erp/purchase/invoice'],
      note: '负向请求只能验证后端拒绝；采购/销售对账正向分支需要已有确认事实，不能伪造确认记录。'
    }
  }
  if (!plans[caseId]) throw new Error(`不支持采购串联案例 ${caseId}`)
  return plans[caseId]
}

const addCheck = (caseRecord, name, passed, details) => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  return passed
}

const taskRowsOf = (payload, label) => {
  const value = dataOf(payload, label)
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.records)) return value.records
  throw new Error(`${label}缺少任务数组`)
}

const activeTask = (tasks, taskDefinitionKey) => (Array.isArray(tasks) ? tasks : []).find((task) =>
  task?.taskDefinitionKey === taskDefinitionKey &&
  task?.endTime == null &&
  Number(task?.status) === 1
) || null

const waitFor = async (read, predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await read()
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`BLOCKED: ${label}等待超时：${JSON.stringify(latest).slice(0, 1200)}`)
}

const purchaseApproverStages = Object.freeze([
  {
    label: '采购负责人',
    username: () => config.purchaseApproverUsername,
    password: () => config.purchaseApproverPassword,
    taskDefinitionKey: 'FirstApprove_purchase-request'
  },
  {
    label: '财务复核',
    username: () => config.financeApproverUsername,
    password: () => config.financeApproverPassword,
    taskDefinitionKey: 'SecondApprove_purchase-request'
  },
  {
    label: '负责人终审',
    username: () => config.finalApproverUsername,
    password: () => config.finalApproverPassword,
    taskDefinitionKey: 'FinalApprove_purchase-request'
  }
])

export const approvePurchaseRequestProcess = async ({
  api,
  processId,
  requestId,
  caseRecord,
  record,
  openRoute
}) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(processId || ''))) {
    throw new Error(`BLOCKED: PROC-002 缺少有效采购请购 BPM 流程实例：${processId || ''}`)
  }
  if (!/^[1-9]\d*$/.test(String(requestId || ''))) {
    throw new Error(`BLOCKED: PROC-002 缺少有效采购请购 ID：${requestId || ''}`)
  }
  if (purchaseApproverStages.some((stage) => !stage.username()?.trim() || !stage.password()?.trim())) {
    throw new Error('BLOCKED: PROC-002 缺少采购请购三段审批账号或密码')
  }

  const sessions = []
  const readTasks = async () => taskRowsOf(
    await api.getBusiness(
      `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`
    ),
    'PROC-002 采购请购流程任务'
  )
  const closeSessions = async () => {
    for (const session of sessions) {
      await session.browser.browser.close().catch(() => {})
    }
  }

  try {
    for (const [index, stage] of purchaseApproverStages.entries()) {
      const task = await waitFor(
        readTasks,
        (tasks) => activeTask(tasks, stage.taskDefinitionKey),
        60000,
        `PROC-002 ${stage.label} BPM 待办`
      ).then((tasks) => activeTask(tasks, stage.taskDefinitionKey))
      const expectedUsername = stage.username()
      const actualAssigneeId = task?.assigneeUser?.id ?? task?.assignee
      if (!task?.id || !actualAssigneeId) {
        throw new Error(`BLOCKED: PROC-002 ${stage.label}待办缺少实际 assignee`)
      }

      const browser = await launchBrowser({ headed: false, record })
      sessions.push({ browser })
      const loginContext = await loginWithCredentials(browser.page, {
        tenantName: config.tenantName,
        username: expectedUsername,
        password: stage.password()
      }, { returnContext: true })
      if (String(loginContext?.tenantId || '') !== String(config.tenantId || '1')) {
        throw new Error(
          `BLOCKED: PROC-002 ${stage.label}审批账号租户不一致：` +
          `expected=${config.tenantId || '1'}, actual=${loginContext?.tenantId || ''}`
        )
      }
      const approverApi = createApiClient({
        token: loginContext.token,
        tenantId: config.tenantId || '1',
        record
      })
      const permission = dataOf(
        await approverApi.getBusiness('/system/auth/get-permission-info'),
        `PROC-002 ${stage.label}权限`
      )
      const user = permission?.user
      if (!user?.id || String(user.username || '') !== expectedUsername ||
          String(user.id) !== String(actualAssigneeId)) {
        throw new Error(
          `BLOCKED: PROC-002 ${stage.label}实际 assignee 与配置账号不一致：` +
          `configured=${expectedUsername}, actual=${user?.username || ''}, ` +
          `configuredId=${user?.id || ''}, taskAssigneeId=${actualAssigneeId}`
        )
      }

      const todo = await waitFor(
        async () => dataOf(
          await approverApi.getBusiness(
            `/bpm/task/my-todo?processInstanceId=${encodeURIComponent(processId)}&taskId=${encodeURIComponent(task.id)}`
          ),
          `PROC-002 ${stage.label}待办`
        ),
        (value) => value?.id === task.id &&
          String(value.processInstanceId) === String(processId) &&
          Number(value.status) === 1,
        30000,
        `PROC-002 ${stage.label}准确待办`
      )
      caseRecord.evidence.push(
        `PROC-002 ${stage.label}真实审批：username=${expectedUsername}, ` +
        `taskId=${task.id}, node=${task.taskDefinitionKey}, assigneeId=${actualAssigneeId}`
      )
      addCheck(
        caseRecord,
        `PROC-002 ${stage.label}收到同流程同节点准确待办并核对实际 assignee`,
        true,
        `requestId=${requestId}; processInstanceId=${processId}; taskId=${todo.id}; ` +
        `node=${todo.taskDefinitionKey}; username=${expectedUsername}; assigneeId=${actualAssigneeId}`
      )

      const routeOpener = openRoute || defaultOpenRoute
      await routeOpener(
        browser.page,
        `/bpm/process-instance/detail?id=${encodeURIComponent(processId)}&taskId=${encodeURIComponent(task.id)}`,
        { readySelector: '.processInstance-wrap-main', readyTimeoutMs: 30000, retries: 2 }
      )
      const approveButton = browser.page.getByRole('button', { name: '通过', exact: true }).first()
      await approveButton.waitFor({ state: 'visible', timeout: 30000 })
      await approveButton.click()
      const approvalPopover = browser.page.locator('.el-popover:visible').last()
      await approvalPopover.waitFor({ state: 'visible', timeout: 30000 })
      const opinion = approvalPopover.getByPlaceholder(/请输入.*意见/).first()
      if (await opinion.count()) {
        await opinion.fill(`PROC-002 ${stage.label}正式审批通过`)
      }
      const approvalResponse = browser.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/bpm/task/approve') &&
          response.request().method() === 'PUT',
        { timeout: 60000 }
      )
      await approvalPopover.getByRole('button', { name: '通过', exact: true }).click()
      const response = await approvalResponse
      if (!response.ok()) {
        throw new Error(`PROC-002 ${stage.label}页面审批失败：HTTP ${response.status()}`)
      }
      assertBusinessSuccess(await response.json(), `PROC-002 ${stage.label}正式审批`)
      await waitFor(
        readTasks,
        (tasks) => {
          const completed = tasks.find((item) => String(item.id) === String(task.id))
          const next = purchaseApproverStages[index + 1]
          return completed?.endTime != null &&
            (!next || Boolean(activeTask(tasks, next.taskDefinitionKey)))
        },
        60000,
        `PROC-002 ${stage.label}审批回写`
      )
      addCheck(
        caseRecord,
        `PROC-002 ${stage.label}通过页面正式审批接口完成且当前任务结束`,
        true,
        `taskId=${task.id}; processInstanceId=${processId}`
      )
    }

    const approved = await waitFor(
      async () => dataOf(
        await api.getBusiness(`/erp/purchase/order/request/get?id=${encodeURIComponent(requestId)}`),
        'PROC-002 审批后请购回读'
      ),
      (request) => Number(request?.status) === 20 &&
        Number(request?.isEffective) === 1 &&
        String(request?.billStage) === '24',
      60000,
      'PROC-002 请购审批状态'
    )
    addCheck(
      caseRecord,
      'PROC-002 三段 BPM 审批回写请购为已生效',
      true,
      `requestId=${requestId}; billStage=${approved.billStage}; status=${approved.status}; ` +
      `isEffective=${approved.isEffective}; processInstanceId=${processId}`
    )
    return approved
  } finally {
    await closeSessions()
  }
}

async function captureRoute ({ page, route, caseId, outputDir, record, openRoute, saveScreenshot }) {
  if (!page || typeof openRoute !== 'function' || typeof saveScreenshot !== 'function') return null
  try {
    await openRoute(page, route, {
      readyText: routeReadyText[route] || '工作台',
      readyTimeoutMs: 30000,
      retries: 1
    })
  } catch (error) {
    // A valid route may render an empty-state page without the legacy heading text.
    // Keep the browser evidence useful while still rejecting a wrong route or blank page.
    const expectedPath = new URL(`${route}`, 'http://e2e.local').pathname.replace(/\/+$/, '') || '/'
    const actualPath = new URL(page.url()).pathname.replace(/\/+$/, '') || '/'
    const bodyText = await page.locator('body').innerText().catch(() => '')
    if (actualPath !== expectedPath || bodyText.trim().length < 100) throw error
    record?.notes?.push?.(
      `${caseId} 浏览器页面已到达 ${actualPath}，但未命中就绪文案“${routeReadyText[route] || '工作台'}”；` +
      '已使用真实页面内容和截图作为证据。'
    )
  }
  return saveScreenshot(page, outputDir, `${caseId}-${route.replaceAll('/', '-').replace(/^-/, '')}`, record)
}

export async function captureProcurementChainBrowserEvidence ({ page, caseId, outputDir, record, caseRecord, openRoute, saveScreenshot }) {
  const plan = buildProcurementChainPlan(caseId, caseRecord.chain || {})
  const screenshots = []
  for (const route of plan.routes) {
    const shot = await captureRoute({ page, route, caseId, outputDir, record, openRoute, saveScreenshot })
    if (shot) screenshots.push(shot)
    caseRecord.evidence.push(`浏览器复用当前登录会话打开 ${route}`)
  }
  caseRecord.evidence.push(...screenshots)
  return screenshots
}

async function runProc001 ({ api, caseRecord, chain, record, runMrpClosure }) {
  const requisitionConfig = chain.requisitionConfig
  for (const key of Object.keys(chain)) delete chain[key]
  if (requisitionConfig) chain.requisitionConfig = requisitionConfig
  const closure = await runMrpClosure({
    api,
    record,
    caseRecord,
    cleanup: true,
    preserveSuccessfulFixture: true
  })
  const { calculationId, fixture, request } = closure?.state || {}
  if (closure?.partial || !calculationId || !fixture?.component?.id || !request?.id) {
    caseRecord.notes.push(
      'PROC-001 owned MRP 未形成可续用的正规请购；禁止回退到共享 MRP/物料手工创建请购。'
    )
    return { chain, partial: true, deferred: 'owned MRP 自动请购闭环未通过' }
  }
  const requestItem = request.itemsList?.find((item) =>
    String(item?.productId) === String(fixture.component.id)
  )
  if (!requestItem?.id || Number(requestItem.inCount) <= 0) {
    throw new Error('BLOCKED: PROC-001 owned MRP 请购缺少专属缺料物料明细')
  }
  const ownedMaterial = fixture.owned?.find((resource) =>
    resource?.kind === 'material' &&
    String(resource?.id) === String(fixture.component.id) &&
    resource?.marker === fixture.marker
  )
  if (!ownedMaterial) {
    throw new Error('BLOCKED: PROC-001 Execution fixture 未登记专属缺料物料所有权')
  }
  Object.assign(chain, {
    tag: fixture.marker,
    mrpId: String(calculationId),
    requestId: String(request.id),
    requestBillNo: request.billNo,
    requestItemId: String(requestItem.id),
    request,
    materialId: String(fixture.component.id),
    unitId: String(requestItem.productUnitId || fixture.component.unitId),
    supplierId: String(requestItem.supplierId || fixture.mrpSupplier?.id || ''),
    quantity: Number(requestItem.inCount),
    ownedMarker: fixture.marker,
    executionFixture: fixture,
    mrpClosure: {
      sourceVerified: caseRecord.checks.some((item) =>
        item.name === PROCUREMENT_MRP_CHECKS.source && item.passed === true),
      idempotencyVerified: caseRecord.checks.some((item) =>
        item.name === PROCUREMENT_MRP_CHECKS.idempotency && item.passed === true)
    }
  })
  addCheck(
    caseRecord,
    'PROC-001 owned Execution 物料通过正式 MRP 自动请购保留来源和明细',
    true,
    `marker=${fixture.marker}; mrpId=${calculationId}; requestId=${request.id}; ` +
    `materialId=${fixture.component.id}; supplierId=${chain.supplierId}; quantity=${chain.quantity}`
  )
  return { chain, partial: true, deferred: '已形成 owned MRP 正规请购；缺料禁止开工仍待独立证据' }
}

export function assertOwnedProcurementRequest ({ request, chain, caseRecord }) {
  const fixture = chain?.executionFixture
  const ownedMaterial = fixture?.owned?.find((resource) =>
    resource?.kind === 'material' &&
    String(resource?.id) === String(chain?.materialId || '') &&
    resource?.marker === chain?.ownedMarker
  )
  const sourceItem = request.itemsList?.find((item) =>
    String(item?.id) === String(chain.requestItemId) &&
    String(item?.productId) === String(chain.materialId)
  )
  if (!chain?.requestId || !chain?.ownedMarker ||
      fixture?.marker !== chain.ownedMarker || !ownedMaterial ||
      String(request.srcBillType || '').toUpperCase() !== 'MRP' ||
      String(request.srcBillId) !== String(chain.mrpId) || !sourceItem) {
    throw new Error('BLOCKED: PROC-002 请购不属于 PROC-001 本轮 owned MRP 来源链')
  }
  addCheck(
    caseRecord,
    'PROC-002 续用 PROC-001 本轮 owned MRP 自动请购来源',
    true,
    `marker=${chain.ownedMarker}; mrpId=${chain.mrpId}; requestId=${chain.requestId}; materialId=${chain.materialId}`
  )
  return sourceItem
}

async function runProc002 ({ api, page, caseRecord, chain, record, openRoute }) {
  if (!chain.requestId) throw new Error('BLOCKED: PROC-002 缺少 PROC-001 专属请购，不能脱离链路生成订单')
  let request = dataOf(await api.getBusiness(`/erp/purchase/order/request/get?id=${encodeURIComponent(chain.requestId)}`), 'PROC-002 请购回读')
  assertOwnedProcurementRequest({ request, chain, caseRecord })
  addCheck(
    caseRecord,
    'PROC-002 本轮 owned MRP 重复生成未新增请购',
    chain.mrpClosure?.idempotencyVerified === true,
    `mrpId=${chain.mrpId}; requestId=${chain.requestId}; verified=${chain.mrpClosure?.idempotencyVerified === true}`
  )
  if (Number(request.status) !== 20 &&
      (Number(request.status) !== 10 ||
       !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(request.processInstanceId || '')))) {
    await api.putBusiness(`/erp/purchase/order/request/update-status?id=${encodeURIComponent(chain.requestId)}&status=10`)
    request = dataOf(await api.getBusiness(`/erp/purchase/order/request/get?id=${encodeURIComponent(chain.requestId)}`), 'PROC-002 请购提交后回读')
  }
  if (Number(request.status) !== 20) {
    request = await approvePurchaseRequestProcess({
      api,
      processId: request.processInstanceId,
      requestId: chain.requestId,
      caseRecord,
      record,
      openRoute
    })
  }
  if (Number(request.status) !== 20) {
    throw new Error(`BLOCKED: PROC-002 请购审批后仍未完成：status=${request.status}; process=${request.processInstanceId || ''}`)
  }
  if (Number(request.isPlaceOrder) !== 1) {
    await api.putBusiness(`/erp/purchase/order/request/place/an/order?ids=${encodeURIComponent(chain.requestId)}&isSeparate=0`)
  }
  const orders = rowsOf(await api.getBusiness('/erp/purchase-order/page?pageNo=1&pageSize=100'), 'PROC-002 采购订单列表')
  let order
  let item
  for (const row of orders.filter((candidate) => candidate?.id)) {
    const candidate = dataOf(
      await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(row.id)}`),
      'PROC-002 采购订单回读'
    )
    const candidateItem = candidate.items?.find((entry) =>
      String(entry.srcBillId || '') === String(chain.requestId) &&
      (!chain.requestItemId || String(entry.srcEntryId || '') === String(chain.requestItemId))
    )
    if (candidateItem) {
      order = candidate
      item = candidateItem
      break
    }
  }
  if (!order?.id || !item) throw new Error('BLOCKED: PROC-002 下单后未在正式采购订单中找到请购主表及明细来源')
  const orderPayablesBeforeApproval = await purchaseOrderPayables(
    api, order.id, 'PROC-002 采购订单审核前应付反查'
  )
  if (Number(order.status) !== 20) {
    await api.putBusiness(
      `/erp/purchase-order/update-status?id=${encodeURIComponent(order.id)}&status=20`
    )
    order = dataOf(
      await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(order.id)}`),
      'PROC-002 采购订单审核后回读'
    )
    item = order.items?.find((entry) => String(entry.id) === String(item.id)) || item
  }
  const orderPayablesAfterApproval = await purchaseOrderPayables(
    api, order.id, 'PROC-002 采购订单审核后应付反查'
  )
  Object.assign(chain, {
    orderId: String(order.id),
    orderBillNo: order.billNo,
    orderItemId: String(item.id),
    supplierId: String(order.supplierId),
    order,
    request,
    orderApproval: {
      before: orderPayablesBeforeApproval,
      after: orderPayablesAfterApproval,
      status: order.status
    }
  })
  addCheck(
    caseRecord,
    'PROC-002 只有正式审批完成的请购才能生成采购订单且保留主表及明细来源',
    true,
    `requestId=${chain.requestId}; requestItemId=${chain.requestItemId}; orderId=${order.id}; orderItemId=${item.id}`
  )
  return { chain, partial: false }
}

const uuid = (value) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ''))

export async function executeApprovedProcurementReturn ({ api, purchaseReturn, caseRecord }) {
  const id = stableId(purchaseReturn?.id, 'PROC-003 采购退货执行')
  if (Number(purchaseReturn.isEffective) !== 1) {
    throw new Error('PROC-003 采购退货尚未审核通过，不能执行')
  }
  if (['32', '34'].includes(String(purchaseReturn.billStage))) return purchaseReturn
  if (!purchaseReturn.actions?.execute) {
    throw new Error(`PROC-003 审核后缺少可执行动作：returnId=${id}; stage=${purchaseReturn.billStage}`)
  }
  await api.putBusiness(`/erp/purchase-return/execute?id=${encodeURIComponent(id)}`)
  const executed = await waitFor(
    async () => dataOf(await api.getBusiness(`/erp/purchase-return/get?id=${encodeURIComponent(id)}`),
      'PROC-003 采购退货执行后回读'),
    (value) => Number(value?.isEffective) === 1 &&
      ['32', '34'].includes(String(value?.billStage)) && Number(value?.status) === 20,
    30000,
    'PROC-003 采购退货执行'
  )
  addCheck(caseRecord, 'PROC-003 已审核采购退货通过正式执行入口完成状态推进', true,
    `returnId=${id}; billStage=${executed.billStage}; status=${executed.status}`)
  return executed
}

const inspectionRowsForStockIo = async (api, stockIoId) => rowsOf(
  await api.getBusiness(
    `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100` +
    `&srcBillId=${encodeURIComponent(stockIoId)}&type=101`
  ),
  'PROC-003 采购入库检查询'
)

const readInspectionEvidence = async (api, inspectionId) => {
  const [detail, entries, items] = await Promise.all([
    dataOf(
      await api.getBusiness(
        `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(inspectionId)}`
      ),
      'PROC-003 采购入库检主单回读'
    ),
    rowsOf(
      await api.getBusiness(
        `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(inspectionId)}`
      ),
      'PROC-003 采购入库检明细回读'
    ),
    rowsOf(
      await api.getBusiness(
        `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${encodeURIComponent(inspectionId)}`
      ),
      'PROC-003 采购入库检项目回读'
    )
  ])
  return { detail, entries, items }
}

const inventoryConserved = (row) => {
  if (!row) return false
  const total = Number(row.qty || 0)
  const parts = ['availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty']
    .map((key) => Number(row[key] || 0))
  return Math.abs(total - parts.reduce((sum, value) => sum + value, 0)) < 0.000001
}

const ownedMaterialResource = (chain) => {
  const fixture = chain?.executionFixture
  const materialId = String(chain?.materialId || '')
  const marker = String(chain?.ownedMarker || '')
  const owned = fixture?.owned?.find((resource) =>
    resource?.kind === 'material' &&
    String(resource?.id) === materialId &&
    resource?.marker === marker
  )
  return { fixture, materialId, marker, owned }
}

export async function assertOwnedProcurementMaterial ({ api, chain, caseRecord }) {
  const { fixture, materialId, marker, owned } = ownedMaterialResource(chain)
  if (!fixture || !marker || marker !== fixture.marker ||
      String(fixture.component?.id || '') !== materialId || !owned) {
    throw new Error(
      'BLOCKED: PROC-003 只允许本轮 Execution owned 物料创建 qualityRule，禁止共享物料兜底'
    )
  }
  const material = dataOf(
    await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(materialId)}`),
    'PROC-003 owned 物料所有权回读'
  )
  if (String(material?.id) !== materialId || material?.remark !== marker) {
    throw new Error(
      'BLOCKED: PROC-003 owned 物料标记回读不匹配，禁止创建 qualityRule'
    )
  }
  addCheck(
    caseRecord,
    'PROC-003 qualityRule 仅绑定本轮 Execution owned 物料',
    true,
    `marker=${marker}; materialId=${materialId}; requestId=${chain.requestId}; orderId=${chain.orderId}`
  )
  return material
}

async function runProc003 ({ api, page, caseRecord, chain, record, openRoute }) {
  if (!chain.orderId || !chain.orderItemId) throw new Error('BLOCKED: PROC-003 缺少已审批采购订单及明细')
  const orderBeforeReceipt = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(chain.orderId)}`),
    'PROC-003 到货前采购订单回读'
  )
  const directInboundProbe = await api.post('/erp/purchase-in/create', {
    businessType: 'NORMAL',
    orderId: String(chain.orderId),
    accountId: '',
    inTime: now(),
    items: [{
      orderItemId: String(chain.orderItemId),
      warehouseId: '__PROC003_NO_ASN__',
      productId: String(chain.materialId),
      productUnitId: String(chain.unitId),
      productPrice: 10,
      count: Number(chain.quantity),
      taxPercent: 0
    }]
  }, {
    expectedBusinessRejection: PROCUREMENT_ARRIVAL_NOTICE_REQUIRED
  })
  const directInboundRejected = directInboundProbe?.data === null &&
    matchesExpectedBusinessRejection(directInboundProbe, PROCUREMENT_ARRIVAL_NOTICE_REQUIRED)
  addCheck(
    caseRecord,
    'PROC-003 无到货通知不得直接创建采购入库',
    directInboundRejected,
    `orderId=${chain.orderId}; code=${directInboundProbe?.code}; msg=${directInboundProbe?.msg || ''}`
  )
  if (!directInboundRejected) {
    throw new Error(
      `PROC-003 无到货通知直接创建采购入库未被精确拒绝：${JSON.stringify(directInboundProbe)}`
    )
  }
  const tree = rowsOf(await api.getBusiness('/mes/wmsWareHouse/allTree'), 'PROC-003 仓库树')
  if (!tree.some((row) => /^[1-9]\d*$/.test(String(row?.id)))) {
    throw new Error('BLOCKED: PROC-003 当前租户没有可用仓库')
  }

  const fixtureToken = `${chain.tag || tagOf()}-WMS`
  const warehouseFixture = await createWarehouseFixture(api, caseRecord, fixtureToken, 31)
  const { warehouse, area, location } = warehouseFixture

  const qualityItem = await createPublishedItem(api, caseRecord, {
    kind: 'PROC003',
    itemType: '采购入库检验项目',
    unitId: chain.unitId
  })
  const qualityPlan = await createPlan(api, caseRecord, {
    kind: 'PROC003',
    type: 101,
    itemId: qualityItem.itemId,
    itemSnapshot: qualityItem.row,
    planName: `${fixtureToken}-QC-PLAN`,
    publish: true
  })
  const qualityRule = await createQualityMaterialRule(api, caseRecord, {
    materialId: chain.materialId,
    planId: qualityPlan.planId,
    type: '101',
    isDefault: true,
    priority: 999
  })
  caseRecord.evidence.push(
    `PROC-003 已仅为本轮 owned 物料通过正式质检 API 准备 101 质检项目/方案/物料规则：` +
    `materialId=${chain.materialId}; itemId=${qualityItem.itemId}; ` +
    `planId=${qualityPlan.planId}; ruleId=${qualityRule.ruleId}`
  )

  const plan = buildProcurementChainPlan('PROC-003', {
    ...chain,
    warehouseId: warehouse.id,
    areaId: area.id,
    locationId: location.id,
    qualityItemId: qualityItem?.itemId || null,
    qualityPlanId: qualityPlan.planId
  })
  const noticeId = stableId(
    dataOf(
      await api.postBusiness('/mes/wms/arrival-notice/create', plan.writes[0].body),
      'PROC-003 到货通知创建'
    ),
    'PROC-003 到货通知'
  )
  await api.postBusiness(`/mes/wms/arrival-notice/submit?id=${encodeURIComponent(noticeId)}`)
  const notice = dataOf(
    await api.getBusiness(`/mes/wms/arrival-notice/get?id=${encodeURIComponent(noticeId)}`),
    'PROC-003 到货通知回读'
  )
  const line = notice.lines?.[0]
  if (!line?.id) throw new Error('PROC-003 到货通知回读缺少明细')

  const receiptLines = plan.writes[2].body.map((item) => ({ ...item, lineId: line.id }))
  const receiptId = stableId(
    dataOf(
      await api.postBusiness(
        `/mes/wms/arrival-notice/create-receipt-bill?id=${encodeURIComponent(noticeId)}`,
        receiptLines
      ),
      'PROC-003 101入库草稿创建'
    ),
    'PROC-003 101入库草稿'
  )
  let receipt = dataOf(
    await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(receiptId)}`),
    'PROC-003 101入库主单回读'
  )
  let entries = dataOf(
    await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(receiptId)}`),
    'PROC-003 101入库明细回读'
  )
  if (!Array.isArray(entries) || !entries.length) throw new Error('PROC-003 101入库草稿没有明细')
  const entry = entries.find((item) =>
    String(item?.materialId) === String(chain.materialId)
  ) || entries[0]
  addCheck(
    caseRecord,
    'PROC-003 到货通知生成的 101 入库明细保留库区、库位和待检标记',
    String(entry?.warehouseId) === String(warehouse.id) &&
      String(entry?.wareAreaId) === String(area.id) &&
      String(entry?.wareLocationId) === String(location.id) &&
      Number(entry?.isQc) === 1,
    `receiptId=${receiptId}; entryId=${entry?.id}; warehouseId=${entry?.warehouseId}; ` +
    `areaId=${entry?.wareAreaId}; locationId=${entry?.wareLocationId}; isQc=${entry?.isQc}`
  )

  const beforeInventory = await inventorySnapshot(api, warehouseFixture, chain.materialId)
  const beforeRow = beforeInventory.find((item) =>
    String(item?.materialId) === String(chain.materialId)
  )
  addCheck(
    caseRecord,
    'PROC-003 101 入库未完成质检放行时不进入可用库存',
    !beforeRow ||
      (Number(beforeRow.availableQty || 0) === 0 &&
        (Number(beforeRow.holdQty || 0) > 0 || Number(beforeRow.pendingPutawayQty || 0) > 0)),
    `receiptId=${receiptId}; available=${beforeRow?.availableQty}; hold=${beforeRow?.holdQty}; ` +
    `pendingPutaway=${beforeRow?.pendingPutawayQty}`
  )

  // The receipt endpoint creates an editing draft (12). The formal submit action
  // is edit/submit, which rebuilds the entry snapshot and starts BPM as configured.
  await api.putBusiness('/mes/stkIo/edit/submit', {
    ...receipt,
    stkIoEntryList: entries,
    stkIoDistributionList: [],
    stkIoBomList: []
  })
  receipt = dataOf(
    await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(receiptId)}`),
    'PROC-003 101入库正式提交回读'
  )
  addCheck(
    caseRecord,
    'PROC-003 101 入库通过正式编辑提交 API 进入核批阶段',
    ['22', '24', '32', '34'].includes(String(receipt?.billStage)) ||
      Number(receipt?.isEffective) === 1,
    `receiptId=${receiptId}; billStage=${receipt?.billStage}; isEffective=${receipt?.isEffective}; ` +
    `processInstanceId=${receipt?.processInstanceId || ''}`
  )

  if (Number(receipt?.isEffective) !== 1) {
    if (!uuid(receipt?.processInstanceId)) {
      throw new Error(
        `BLOCKED: PROC-003 101 入库提审后缺少有效 BPM 流程实例：` +
        `receiptId=${receiptId}; billStage=${receipt?.billStage}`
      )
    }
    await approveWmsProcess({
      api,
      processId: receipt.processInstanceId,
      caseRecord,
      record,
      label: 'PROC-003 采购入库',
      taskDefinitionKey: 'FirstApprove_purchase-in',
      stageApprovers: [
        {
          taskDefinitionKey: 'FirstApprove_purchase-in',
          username: config.warehouseApproverUsername,
          password: config.warehouseApproverPassword
        },
        {
          taskDefinitionKey: 'SecondApprove_purchase-in',
          username: config.warehouseApproverUsername,
          password: config.warehouseApproverPassword
        },
        {
          taskDefinitionKey: 'FinalApprove_purchase-in',
          username: config.warehouseFinalApproverUsername,
          password: config.warehouseFinalApproverPassword
        }
      ],
      reason: 'PROC-003 采购入库 BPM 审批通过'
    })
  }

  receipt = await waitFor(
    async () => dataOf(
      await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(receiptId)}`),
      'PROC-003 101入库生效回读'
    ),
    (value) => Number(value?.isEffective) === 1 &&
      ['24', '32', '34'].includes(String(value?.billStage)),
    60000,
    'PROC-003 101 入库正式生效'
  )
  const orderAfterReceipt = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(chain.orderId)}`),
    'PROC-003 入库后采购订单回读'
  )
  const orderAfterReceiptItem = orderAfterReceipt.items?.find((item) =>
    String(item?.id) === String(chain.orderItemId))
  const orderApproval = chain.orderApproval || {}
  const activeOrderPayables = (rows) => rows.filter((item) =>
    String(item?.srcBillType) === 'PurOrder' && Number(item?.isVoided) !== 1)
  addCheck(
    caseRecord,
    'PROC-003 采购订单审核不新增应付，历史订单应付保留且不重复生成',
    Number(orderBeforeReceipt?.status) === 20 &&
      activeOrderPayables(orderApproval.before || []).length === 0 &&
      activeOrderPayables(orderApproval.after || []).length === 0 &&
      activeOrderPayables(await purchaseOrderPayables(
        api, chain.orderId, 'PROC-003 入库后采购订单应付反查'
      )).length === 0,
    `orderId=${chain.orderId}; status=${orderAfterReceipt?.status}; ` +
    `before=${orderApproval.before?.length || 0}; after=${orderApproval.after?.length || 0}`
  )
  await createProc003PurchaseInvoice({ api, caseRecord, chain, record })
  addCheck(
    caseRecord,
    'PROC-003 采购入库回写订单 inCount',
    Number(orderAfterReceiptItem?.inCount || 0) === Number(chain.quantity),
    `orderId=${chain.orderId}; orderItemId=${chain.orderItemId}; ` +
    `expected=${chain.quantity}; actual=${orderAfterReceiptItem?.inCount}`
  )
  entries = dataOf(
    await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(receiptId)}`),
    'PROC-003 101入库生效明细回读'
  )
  const effectiveEntry = entries.find((item) =>
    String(item?.materialId) === String(chain.materialId)
  ) || entries[0]
  addCheck(
    caseRecord,
    'PROC-003 101 入库审批完成后正式生效并保留来源明细',
    Number(receipt.isEffective) === 1 &&
      ['24', '32', '34'].includes(String(receipt.billStage)) &&
      String(effectiveEntry?.srcBillId) === String(noticeId),
    `receiptId=${receiptId}; billStage=${receipt.billStage}; isEffective=${receipt.isEffective}; ` +
    `srcBillId=${effectiveEntry?.srcBillId}`
  )

  const beforeQualityInventory = await waitFor(
    () => inventorySnapshot(api, warehouseFixture, chain.materialId),
    (rows) => rows.some((item) => String(item?.materialId) === String(chain.materialId)),
    30000,
    'PROC-003 入库生效后待检库存'
  )
  const beforeQualityRow = beforeQualityInventory.find((item) =>
    String(item?.materialId) === String(chain.materialId)
  )
  addCheck(
    caseRecord,
    'PROC-003 101 入库生效后未完成质检时数量停留在待检隔离量',
    Boolean(beforeQualityRow) &&
      Number(beforeQualityRow.availableQty || 0) === 0 &&
      Number(beforeQualityRow.holdQty || 0) > 0,
    `receiptId=${receiptId}; available=${beforeQualityRow?.availableQty}; ` +
    `hold=${beforeQualityRow?.holdQty}; pendingPutaway=${beforeQualityRow?.pendingPutawayQty}`
  )

  // 到货通知收货接口先落草稿，正式提审/审批完成后由 WMS 执行链补建采购入库检。
  // 这里必须在入库生效后等待，不能把草稿阶段误判为产品缺陷。
  const inspections = await waitFor(
    () => inspectionRowsForStockIo(api, receiptId),
    (rows) => rows.some((item) => item?.id),
    30000,
    'PROC-003 自动生成采购入库检'
  )
  const inspectionRow = inspections.find((item) => item?.id)
  if (!inspectionRow?.id) {
    throw new Error(`BLOCKED: PROC-003 101 入库已生效，但没有自动生成采购入库检：receiptId=${receiptId}`)
  }
  let inspection = await readInspectionEvidence(api, inspectionRow.id)
  addCheck(
    caseRecord,
    'PROC-003 101 入库正式生成带来源的采购入库检及审批明细',
    String(inspection.detail?.srcBillId) === String(receiptId) &&
      ['MesStkIo', 'StkIo:101', 'MesStkIo:101'].includes(String(inspection.detail?.srcBillType)) &&
      String(inspection.detail?.type) === '101' &&
      inspection.entries.length > 0 &&
      inspection.items.length > 0,
    `inspectionId=${inspectionRow.id}; srcBillType=${inspection.detail?.srcBillType}; ` +
    `srcBillId=${inspection.detail?.srcBillId}; entries=${inspection.entries.length}; items=${inspection.items.length}`
  )

  await api.putBusiness('/mes/quality/qualityInspection/edit/submit', {
    ...inspection.detail,
    inspectionQty: chain.quantity,
    passQty: chain.quantity,
    concessionQty: 0,
    pendingJudgeQty: 0,
    inspector: '1',
    inspectionResult: '全部合格',
    qualityInspectionEntryList: inspection.entries.map((item) => ({
      ...item,
      inspectionQty: item.qty,
      passQty: item.qty,
      concessionQty: 0,
      pendingJudgeQty: 0,
      finalResult: '全部合格',
      inspectionConclusion: '全部合格'
    })),
    qualityInspectionItemList: inspection.items.map((item) => ({
      ...item,
      inspectionQty: chain.quantity,
      passQty: chain.quantity,
      ngQty: 0,
      finalInspectionResult: item.inspectionResult || '1'
    }))
  })
  const inspectionAudit = await checkInspection(api, caseRecord, inspectionRow.id)
  assertBusinessSuccess(inspectionAudit.response, 'PROC-003 人工采购入库检核批')
  inspection = await readInspectionEvidence(api, inspectionRow.id)
  const afterInventory = await inventorySnapshot(api, warehouseFixture, chain.materialId)
  const afterRow = afterInventory.find((item) =>
    String(item?.materialId) === String(chain.materialId)
  )
  const releasedQty = Number(beforeQualityRow?.holdQty || 0) - Number(afterRow?.holdQty || 0)
  addCheck(
    caseRecord,
    'PROC-003 采购入库检正式审核后 availableQty 增加且 holdQty 等量减少',
    Number(inspectionAudit.detail?.isEffective) === 1 &&
      Boolean(beforeQualityRow) &&
      releasedQty > 0 &&
      Math.abs(releasedQty - (
        Number(afterRow?.availableQty || 0) - Number(beforeQualityRow?.availableQty || 0)
      )) < 0.000001,
    `inspectionId=${inspectionRow.id}; beforeHold=${beforeQualityRow?.holdQty}; afterHold=${afterRow?.holdQty}; ` +
    `beforeAvailable=${beforeQualityRow?.availableQty}; afterAvailable=${afterRow?.availableQty}; released=${releasedQty}`
  )
  addCheck(
    caseRecord,
    'PROC-003 采购入库检审核前后库存总量守恒',
    inventoryConserved(beforeQualityRow) &&
      inventoryConserved(afterRow) &&
      Number(beforeQualityRow?.qty || 0) === Number(afterRow?.qty || 0),
    `beforeQty=${beforeQualityRow?.qty}; afterQty=${afterRow?.qty}`
  )

  const returnId = stableId(
    dataOf(
      await api.postBusiness('/erp/purchase-return/create', plan.writes[3].body),
      'PROC-003 采购退货草稿创建'
    ),
    'PROC-003 采购退货'
  )
  const purchaseReturn = dataOf(
    await api.getBusiness(`/erp/purchase-return/get?id=${encodeURIComponent(returnId)}`),
    'PROC-003 采购退货回读'
  )
  const returnItem = purchaseReturn?.items?.[0]
  addCheck(
    caseRecord,
    'PROC-003 可用库存形成后采购退货草稿保留订单来源、库区库位和物料明细',
    String(purchaseReturn?.srcBillId) === String(chain.orderId) &&
      String(returnItem?.srcEntryId) === String(chain.orderItemId) &&
      String(returnItem?.warehouseId) === String(warehouse.id) &&
      String(returnItem?.areaHouseId) === String(area.id) &&
      String(returnItem?.wareLocationId) === String(location.id),
    `noticeId=${noticeId}; receiptId=${receiptId}; returnId=${returnId}; ` +
    `srcBillId=${purchaseReturn?.srcBillId}; srcEntryId=${returnItem?.srcEntryId}; ` +
    `warehouseId=${returnItem?.warehouseId}; areaId=${returnItem?.areaHouseId}; locationId=${returnItem?.wareLocationId}`
  )
  const returnBefore = await inventorySnapshot(api, warehouseFixture, chain.materialId)
  const returnBeforeRow = returnBefore.find((item) =>
    String(item?.materialId) === String(chain.materialId) &&
    String(item?.warehouseId) === String(warehouse.id)
  )
  if (!returnBeforeRow) {
    throw new Error(`BLOCKED: PROC-003 采购退货审核前缺少可用库存行：materialId=${chain.materialId}`)
  }

  await api.putBusiness(
    `/erp/purchase-return/update-status?id=${encodeURIComponent(returnId)}&status=10`,
    undefined
  )
  let purchaseReturnAfterSubmit = dataOf(
    await api.getBusiness(`/erp/purchase-return/get?id=${encodeURIComponent(returnId)}`),
    'PROC-003 采购退货提审回读'
  )
  if (uuid(purchaseReturnAfterSubmit?.processInstanceId) &&
      Number(purchaseReturnAfterSubmit?.isEffective) !== 1) {
    await approveWmsProcess({
      api,
      processId: purchaseReturnAfterSubmit.processInstanceId,
      caseRecord,
      record,
      label: 'PROC-003 采购退货',
      taskDefinitionKey: 'FirstApprove_purchase-return',
      stageApprovers: [
        {
          taskDefinitionKey: 'FirstApprove_purchase-return',
          username: config.warehouseApproverUsername,
          password: config.warehouseApproverPassword
        },
        {
          taskDefinitionKey: 'SecondApprove_purchase-return',
          username: config.warehouseApproverUsername,
          password: config.warehouseApproverPassword
        },
        {
          taskDefinitionKey: 'FinalApprove_purchase-return',
          username: config.warehouseFinalApproverUsername,
          password: config.warehouseFinalApproverPassword
        }
      ],
      reason: 'PROC-003 采购退货 BPM 审批通过'
    })
  } else if (Number(purchaseReturnAfterSubmit?.isEffective) !== 1) {
    throw new Error(
      `PROC-003 采购退货未形成有效审核结果或 BPM 实例：returnId=${returnId}; ` +
      `billStage=${purchaseReturnAfterSubmit?.billStage}`
    )
  }
  purchaseReturnAfterSubmit = await waitFor(
    async () => dataOf(
      await api.getBusiness(`/erp/purchase-return/get?id=${encodeURIComponent(returnId)}`),
      'PROC-003 采购退货审核后回读'
    ),
    (value) => Number(value?.isEffective) === 1 &&
      ['24', '32', '34'].includes(String(value?.billStage)),
    60000,
    'PROC-003 采购退货生效'
  )
  purchaseReturnAfterSubmit = await executeApprovedProcurementReturn({
    api, purchaseReturn: purchaseReturnAfterSubmit, caseRecord
  })
  const returnWmsRows = rowsOf(
    await api.getBusiness(
      `/mes/stkIo/list?pageNo=1&pageSize=100&srcBillType=PurReturn&srcBillId=${encodeURIComponent(returnId)}`
    ),
    'PROC-003 采购退货 WMS 来源单'
  )
  const returnWms = returnWmsRows.find((row) =>
    String(row?.srcBillType) === 'PurReturn' && String(row?.srcBillId) === String(returnId)
  )
  if (!returnWms?.id) {
    throw new Error(`BLOCKED: PROC-003 采购退货生效后缺少 PurReturn WMS 来源单：returnId=${returnId}`)
  }
  const returnWmsDetail = dataOf(
    await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(returnWms.id)}`),
    'PROC-003 采购退货 WMS 来源单回读'
  )
  const returnWmsEntries = rowsOf(
    await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(returnWms.id)}`),
    'PROC-003 采购退货 WMS 明细回读'
  )
  const returnAfter = await inventorySnapshot(api, warehouseFixture, chain.materialId)
  const returnAfterRow = returnAfter.find((item) =>
    String(item?.materialId) === String(chain.materialId) &&
    String(item?.warehouseId) === String(warehouse.id)
  )
  const returnedQty = Number(returnBeforeRow.availableQty || 0) -
    Number(returnAfterRow?.availableQty || 0)
  addCheck(
    caseRecord,
    'PROC-003 采购退货审核执行后生成 PurReturn/301 WMS 出库并扣减可用库存',
    String(returnWmsDetail?.stockIoType) === '301' &&
      String(returnWmsDetail?.srcBillType) === 'PurReturn' &&
      String(returnWmsDetail?.srcBillId) === String(returnId) &&
      returnWmsEntries.some((entry) => String(entry?.srcBillId) === String(returnId)) &&
      returnedQty === Number(chain.quantity),
    `returnId=${returnId}; wmsId=${returnWms.id}; stockIoType=${returnWmsDetail?.stockIoType}; ` +
    `beforeAvailable=${returnBeforeRow.availableQty}; afterAvailable=${returnAfterRow?.availableQty}; ` +
    `returnedQty=${returnedQty}`
  )
  if (returnedQty !== Number(chain.quantity)) {
    throw new Error(`BLOCKED: PROC-003 采购退货 WMS 扣减数量不一致：expected=${chain.quantity}; actual=${returnedQty}`)
  }

  await api.putBusiness('/erp/purchase-return/void', { id: returnId })
  const returnAfterVoid = await inventorySnapshot(api, warehouseFixture, chain.materialId)
  const returnAfterVoidRow = returnAfterVoid.find((item) =>
    String(item?.materialId) === String(chain.materialId) &&
    String(item?.warehouseId) === String(warehouse.id)
  )
  const restoredQty = Number(returnAfterVoidRow?.availableQty || 0) -
    Number(returnAfterRow?.availableQty || 0)
  const voidedWms = dataOf(
    await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(returnWms.id)}`),
    'PROC-003 采购退货作废后 WMS 回读'
  )
  addCheck(
    caseRecord,
    'PROC-003 采购退货正式作废后 WMS 出库作废且可用库存回退',
    Number(voidedWms?.isVoided) === 1 &&
      restoredQty === Number(chain.quantity) &&
      Number(returnAfterVoidRow?.availableQty || 0) === Number(returnBeforeRow.availableQty || 0),
    `returnId=${returnId}; wmsId=${returnWms.id}; isVoided=${voidedWms?.isVoided}; ` +
    `beforeAvailable=${returnBeforeRow.availableQty}; afterVoidAvailable=${returnAfterVoidRow?.availableQty}; ` +
    `restoredQty=${restoredQty}`
  )
  await api.putBusiness('/mes/quality/qualityInspection/void', {
    id: inspectionRow.id
  })
  await api.putBusiness(
    `/mes/stkIo/update-bill-stage?id=${encodeURIComponent(receiptId)}&billStage=14`
  )
  const orderAfterInboundVoid = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(chain.orderId)}`),
    'PROC-003 采购入库弃审后采购订单回读'
  )
  const orderAfterInboundVoidItem = orderAfterInboundVoid.items?.find((item) =>
    String(item?.id) === String(chain.orderItemId))
  const receiptAfterInboundVoid = dataOf(
    await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(receiptId)}`),
    'PROC-003 采购入库弃审后 WMS 回读'
  )
  addCheck(
    caseRecord,
    'PROC-003 采购入库弃审后回退库存并重算订单 inCount',
    Number(orderAfterInboundVoidItem?.inCount || 0) === 0 &&
      Number(receiptAfterInboundVoid?.isEffective || 0) === 0 &&
      String(receiptAfterInboundVoid?.billStage) === '12',
    `receiptId=${receiptId}; orderId=${chain.orderId}; ` +
    `inCount=${orderAfterInboundVoidItem?.inCount}; ` +
    `receiptEffective=${receiptAfterInboundVoid?.isEffective}; ` +
    `receiptStage=${receiptAfterInboundVoid?.billStage}`
  )
  Object.assign(chain, {
    warehouseId: String(warehouse.id),
    areaId: String(area.id),
    locationId: String(location.id),
    qualityItemId: qualityItem?.itemId || null,
    qualityPlanId: qualityPlan.planId,
    qualityRuleId: qualityRule.ruleId,
    noticeId,
    notice,
    receiptId,
    receipt,
    receiptEntries: entries,
    inspectionId: String(inspectionRow.id),
    inspection,
    returnId,
    purchaseReturn,
    purchaseReturnAfterSubmit,
    returnWmsId: String(returnWms.id),
    returnWms: returnWmsDetail,
    orderAfterReceipt,
    orderAfterInboundVoid,
    receiptAfterInboundVoid
  })
  addCheck(
    caseRecord,
    'PROC-003 到货通知、WMS 101 入库、自动采购入库检、库存放行和采购退货完整保留来源明细',
    Boolean(noticeId) && Boolean(receiptId) && Boolean(inspectionRow.id) && Boolean(returnId) &&
      String(returnWmsDetail?.srcBillId) === String(returnId),
    `noticeId=${noticeId}; receiptId=${receiptId}; inspectionId=${inspectionRow.id}; ` +
    `returnId=${returnId}; returnWmsId=${returnWms.id}`
  )
  return { chain, partial: false, deferred: '采购订单、采购发票、WMS 入库质检和退货链已执行' }
}

async function runProc004 ({ api, caseRecord, chain, writeEnabled }) {
  let standaloneOverride = false
  if (!chain.requisitionConfig?.prepared) {
    if (!writeEnabled) {
      throw new Error('BLOCKED: PROC-004 采购请购开关未在 PROC-001 前准备，且当前未开启写侧')
    }
    await prepareProcurementRequisitionMode({ api, caseRecord, chain })
    standaloneOverride = true
  }
  const options = rowsOf(
    await api.getBusiness(PROCUREMENT_ERP_OPTIONS_PATH),
    'PROC-004 ERP 业务选项目录'
  )
  const requisition = options.find((item) =>
    item?.optionCode === 'ERP.PURCHASE.REQUISITION' &&
    item?.category === 'purchase' &&
    item?.tag === 'requisition'
  )
  if (!requisition) throw new Error('BLOCKED: PROC-004 业务选项目录缺少 ERP.PURCHASE.REQUISITION')
  if (!enabledConfig(requisition.currentValue)) {
    throw new Error(
      `BLOCKED: PROC-004 采购请购开关未启用：currentValue=${requisition.currentValue ?? ''}; ` +
      `source=${requisition.currentValueSource ?? ''}`
    )
  }

  try {
    const plan = buildProcurementChainPlan('PROC-004', chain)
    const response = await api.post('/erp/purchase-order/create', plan.writes[0].body, { expectedBusinessRejection: true })
    const rejected = response?.data === null && response?.code !== 0 && response?.code !== 200
    if (!rejected) throw new Error('PROC-004 绕过有效请购来源的采购订单未被正式 API 拒绝')
    addCheck(
      caseRecord,
      'PROC-004 请购开关启用时无有效来源的普通采购订单被后端拒绝',
      true,
      `option=${requisition.optionCode}; currentValue=true; ` +
      `source=${standaloneOverride ? 'TEMPORARY_TENANT_OVERRIDE' : requisition.currentValueSource}; ` +
      `code=${response.code}; msg=${response.msg || ''}`
    )
    return { chain, partial: true, deferred: '销售/采购对账正向来源快照依赖现有确认事实，未伪造财务数据' }
  } finally {
    if (standaloneOverride) {
      await restoreProcurementRequisitionMode({ api, caseRecord, chain })
    }
  }
}

export async function runProcurementChainFixture ({
  caseId,
  api,
  page,
  caseRecord,
  outputDir,
  record,
  chain = {},
  writeEnabled = false,
  openRoute,
  saveScreenshot,
  runMrpClosure = runProcurementMrpClosure,
  runProcurementSourceGates
} = {}) {
  if (!procurementChainCases.includes(caseId)) throw new Error(`不支持采购串联案例 ${caseId}`)
  const plan = buildProcurementChainPlan(caseId, chain)
  caseRecord.chain = chain
  caseRecord.chainPlan = plan
  caseRecord.evidence.push(`API 写侧计划 ${plan.writes.map((item) => `${item.method} ${item.path}`).join('；')}`)
  if (!writeEnabled) {
    caseRecord.notes.push('本轮只生成正式 API 串联计划，未执行真实写侧；服务稳定后需用同一登录会话按 PROC-001→004 执行。')
    if (plan.note) caseRecord.notes.push(plan.note)
    return { chain, plan, partial: true, deferred: true }
  }
  try {
    if (caseId === 'PROC-001') {
      await prepareProcurementRequisitionMode({ api, caseRecord, chain })
    }
    const result = caseId === 'PROC-001'
      ? await runProc001({ api, caseRecord, chain, record, runMrpClosure })
      : caseId === 'PROC-002'
        ? await runProc002({ api, page, caseRecord, chain, record, openRoute })
        : caseId === 'PROC-003'
          ? (await assertOwnedProcurementMaterial({ api, chain, caseRecord }),
            await withProcurementManualIqc(api, caseRecord,
              () => runProc003({ api, page, caseRecord, chain, record, openRoute })))
          : await runProc004({ api, caseRecord, chain, writeEnabled })
    if (caseId === 'PROC-004' && typeof runProcurementSourceGates === 'function') {
      const sourceGateResult = await runProcurementSourceGates({
        api, page, caseRecord, chain, record
      })
      Object.assign(result, sourceGateResult)
    }
    await captureProcurementChainBrowserEvidence({ page, caseId, outputDir, record, caseRecord, openRoute, saveScreenshot })
    if (plan.note) caseRecord.notes.push(plan.note)
    return { ...result, plan }
  } finally {
    if (caseId === 'PROC-004') {
      await restoreProcurementRequisitionMode({ api, caseRecord, chain })
    }
  }
}
