import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createApiClient } from '../lib/api.mjs'
import { launchBrowser, login, loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { createPurchaseRequest, snapshotPurchaseRequest } from '../fixtures/purchase-request.mjs'
import { createProcurementSettlementFixture } from '../fixtures/procurement-settlement.mjs'
import { createPurchasePriceSnapshotFixture } from '../fixtures/procurement-price-snapshot.mjs'
import { createPurchaseOrderChangeFixture } from '../fixtures/procurement-order-change.mjs'
import { createSettleRuleWriteFixture } from '../fixtures/procurement-settle-rule-write.mjs'
import {
  PROCUREMENT_DIRECT_CREATE_PERMISSION,
  PROCUREMENT_SUPER_PERMISSION
} from '../fixtures/procurement-direct-create-gate.mjs'
import {
  closeProcurementReaderSession,
  createProcurementPermissionReader
} from '../fixtures/procurement-permission-reader.mjs'
import { runSupplierAuth } from '../fixtures/supplier-auth.mjs'
import { createSupplierAuthRequest } from '../fixtures/supplier-auth.mjs'
import {
  databaseConfigured,
  assertLocalWriteSafety,
  runReadOnlySql,
  runLocalFixtureSql
} from '../lib/db.mjs'
import { createPurchaseReader } from '../fixtures/purchase-reader.mjs'
import { collectPagePerformance } from '../lib/performance.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { findMenuRouteByComponent, isStableId } from './base-partner.mjs'
import {
  cases as procurementFoundationReadonlyCases,
  runProcurementFoundationReadonlyContract
} from './procurement-foundation-readonly.mjs'
import {
  createFinanceRuleWriteFixture,
  createOpeningInvoiceWriteFixture,
  createPurchaseTypeRuleWriteFixture,
  createReconciliationWriteFixture
} from '../fixtures/procurement-batch-a.mjs'
import {
  createPendingRequestBrowserFixture,
  generatePendingRequestInBrowser,
  verifyGeneratedRequestList
} from '../fixtures/procurement-pending-browser.mjs'
import { createProcurement016OpeningClosureFixture, procurement016TestHooks } from '../fixtures/procurement-016-opening-closure.mjs'
import {
  procurementChainCases,
  runProcurementChainFixture
} from '../fixtures/procurement-chain.mjs'
import {
  PROCUREMENT_SOURCE_GATE_CHECKS,
  assertProcurementSourceRejection,
  procurementSourceGateContracts,
  runProcurementSourceGates
} from '../fixtures/procurement-source-gates.mjs'
import { PROCUREMENT_MRP_CHECKS } from '../fixtures/procurement-mrp-closure.mjs'
import {
  procurementOrganizationGateStatus,
  verifyProcurementTenantIsolation
} from '../fixtures/procurement-tenant-isolation.mjs'
import {
  approveOwnedSalesProcess,
  createApprovedNormalSalesOut,
  createSalesOpeningInventory,
  createSalesFixture,
  createSalesSettlementAccount,
  salesOrderBody
} from './erp-sales.mjs'

export function procurementCatalogEvidence (caseId, caseRecord, evidence = {}) {
  // Unit tests may load this module through a data: URL, where import.meta.url
  // cannot resolve repository files. Prefer the real module URL, then the
  // conventional cfor-e2e working-directory path.
  let moduleCatalog
  try {
    moduleCatalog = new URL('../cases/catalog.json', import.meta.url)
  } catch {
    moduleCatalog = null
  }
  const catalogUrl = moduleCatalog?.protocol === 'file:'
    ? moduleCatalog
    : path.resolve(process.cwd(), 'scripts/e2e/cases/catalog.json')
  const catalog = JSON.parse(fs.readFileSync(catalogUrl, 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === caseId)
  if (!definition) throw new Error(`缺少原 catalog 案例 ${caseId}`)
  caseRecord.catalogAssertions = (definition.assertions || []).map((assertion, index) => {
    const item = evidence[index] || {}
    const names = Array.isArray(item) ? item : Array.isArray(item.checks) ? item.checks : []
    const matches = names.map((name) => caseRecord.checks.filter((check) => check.name === name))
    const checks = matches.map((items) => items[0])
    const verified = names.length > 0 && new Set(names).size === names.length &&
      names.every((name) => typeof name === 'string' && name.trim().length > 0) &&
      matches.every((items) => items.length === 1 && items[0].passed === true)
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks: names,
      details: item.details || (verified
        ? checks.map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : (item.gap || '本轮未形成完整证据'))
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed === true)
  caseRecord.notes.push(
    `原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`
  )
  return caseRecord
}

export const supplierAuthCatalogEvidence = (caseRecord) =>
  procurementCatalogEvidence('PROC-010', caseRecord, {
    0: { checks: [
      'headed 供应商登录使用加密请求与 tenant1',
      'headed supplier 独立存储且未覆盖管理端令牌',
      'DB 证实专属 token userType=SUPPLIER(3)/tenant1'
    ] },
    1: {
      checks: [
        '邀请 token 来自本轮专属未发送日志且匹配有效邀请哈希',
        'headed 邀请激活使用加密请求与 tenant1',
        'headed 邀请激活成功返回本轮登录名',
        'headed 邀请激活跳转登录页并预填登录名',
        '邀请激活后正式 API 消耗 token 且账号启用',
        '本轮邀请账号清理为 DISABLED'
      ],
      gap: '缺少本轮专属真实邀请 token 或完整 headed 激活证据；不发外部邮件、不改邮件配置，外部邮件服务依赖保留 GAP'
    },
    2: { checks: [
      'admin refresh 不可通过 supplier refresh',
      '跨端 refresh 拒绝后原 admin 会话仍有效',
      'tenant-id 不匹配 refresh 精确拒绝',
      '跨租户 refresh 拒绝前后原 access/refresh 完整事实不变',
      '跨租户 refresh 拒绝后原 supplier 会话仍有效',
      'supplier refresh 正常轮换 access',
      'refresh 后旧 access 失效'
    ] },
    3: { checks: ['supplier token 可访问自身工作台', 'supplier token 不可访问 admin-api'] },
    4: {
      checks: [
        'admin refresh 不可通过 supplier refresh',
        '跨端 refresh 拒绝后原 admin 会话仍有效',
        'Member API 登录取得真实专属会话',
        'DB 证实真实 Member access/refresh userType=MEMBER(1)/tenant1',
        'Member refresh 不可通过 supplier refresh 精确拒绝',
        'DB 证实真实 Member access/refresh userType=MEMBER(1)/tenant1（拒绝后）',
        'Member 跨端 refresh 拒绝前后原 access/refresh 完整事实不变',
        '跨端 refresh 拒绝后原 Member 会话仍有效',
        '专属 Member 会话退出'
      ],
      gap: '缺少专属真实 Member 登录会话及完整拒绝/事实不变证据；不伪造 token、不注册、不发短信'
    },
    5: { checks: [
      '账号停用后登录拒绝', '账号停用后refresh拒绝',
      'partner停用后登录拒绝', 'partner停用后refresh拒绝',
      '供应商角色停用后登录拒绝', '供应商角色停用后refresh拒绝'
    ] },
    6: { checks: ['logout 后 access 失效', 'logout 后 refresh 失效'] }
  })

const erpAdminDirCandidates = () => [
  process.env.CFOR_ADMIN_DIR,
  path.resolve(process.cwd(), 'cfor/cfor-admin'),
  path.resolve(process.cwd(), '../cfor/cfor-admin'),
  path.resolve(process.cwd(), 'cfor-admin')
].filter((dir) => typeof dir === 'string' && dir.trim())

/**
 * Read a Maven surefire plain-text report from the ERP backend so a catalog
 * assertion about unit-test coverage is only VERIFIED when the report really
 * exists and reports zero failures/errors.
 */
export function readSurefireSummary (relativeReportPath) {
  for (const dir of erpAdminDirCandidates()) {
    const file = path.join(dir, relativeReportPath)
    try {
      return { file, text: fs.readFileSync(file, 'utf8') }
    } catch {
      // try the next candidate backend checkout
    }
  }
  return null
}

export const procurementReadOnlyViews = Object.freeze({
  'PROC-006': {
    component: 'erp/settings/settleMethodRule/index',
    readySelector: '.el-table__header-wrapper th:has-text("允许账户类型")',
    headers: ['结算方式', '适用方向', '允许账户类型', '版本']
  },
  'PROC-008': {
    component: 'erp/settings/purchaseTypeRule/index',
    readySelector: '.el-table__header-wrapper th:has-text("适用组织")',
    headers: ['单据类型', '适用组织', '统计口径', '审批流程', '版本']
  }
})
// PROC-006 已完成写侧闭环，不再是必须保持 PARTIAL 的只读门禁案例；仅 PROC-008 仍受只读门禁约束。
export const procurementPartialReadOnlyCases = Object.freeze(['PROC-008'])

const readonlyFact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}：${details}`)
}
const missingReadonlyFact = (record, detail) =>
  record.notes.push(`前置缺失：${detail}；保留 PARTIAL，不以空集判通过`)
const ruleText = (value) => typeof value === 'string' && value.trim().length > 0

const readonlyData = (payload, label) => assertBusinessSuccess(payload, label).data
const dataOf = readonlyData
const readonlyArray = (payload, label) => {
  const rows = readonlyData(payload, label)
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${label} data 必须为对象数组`)
  }
  return rows
}

const isMissingSupplierPurchaseDetail = (error) => {
  const message = String(error?.message || error)
  return message.includes('1030100000') && message.includes('供应商不存在')
}

export function createProcurementReadonlyApi ({ api, caseRecord } = {}) {
  if (!api || typeof api.getBusiness !== 'function') {
    throw new Error('采购只读适配器必须注入 GET API 客户端')
  }
  return {
    ...api,
    async getBusiness (path, ...args) {
      try {
        return await api.getBusiness(path, ...args)
      } catch (error) {
        const pathname = path.split('?')[0]
        const match = pathname === '/erp/purchase-order/get' &&
          /(?:^|&)id=([^&]+)/.exec(path.split('?')[1] || '')
        if (!match || !isMissingSupplierPurchaseDetail(error)) throw error
        const id = decodeURIComponent(match[1])
        caseRecord?.notes?.push(
          `采购订单 ${id} 详情被后端拒绝：code=1030100000，供应商不存在；不以分页快照替代真实详情，保留 FAIL`
        )
        caseRecord?.evidence?.push(
          `GET ${path} -> code=1030100000 供应商不存在`
        )
        throw error
      }
    }
  }
}

const normalizeTenantId = (value, label = 'tenantId') => {
  if (typeof value !== 'string' &&
      !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new Error(`BLOCKED: ${label} 缺失或非法，数字 ID 必须可精确表示`)
  }
  const normalized = String(value ?? '').trim()
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`BLOCKED: ${label} 缺失或非法`)
  }
  return normalized
}

const permissionTenantId = (payload) => {
  if (payload === undefined) return []
  assertBusinessSuccess(payload, 'PROC-018 权限上下文')
  const data = payload?.data
  const candidates = [
    data?.tenantId,
    data?.user?.tenantId,
    payload?.tenantId,
    payload?.user?.tenantId
  ].filter((value) => value !== undefined && value !== null && value !== '')
  return candidates
}

export const resolveProcurementTenantId = ({
  loginContext,
  permissionInfo,
  expectedTenantId = config.tenantId
} = {}) => {
  const candidates = [
    ...(loginContext?.tenantId !== undefined &&
    loginContext?.tenantId !== null &&
    loginContext?.tenantId !== ''
      ? [loginContext.tenantId]
      : []),
    ...permissionTenantId(permissionInfo)
  ]
  if (!candidates.length) {
    throw new Error('BLOCKED: PROC-018 未获得登录结果或权限响应中的可信 tenantId')
  }
  const tenantIds = candidates.map((value) => normalizeTenantId(value, '可信 tenantId'))
  const tenantId = tenantIds[0]
  if (tenantIds.some((value) => value !== tenantId)) {
    throw new Error('BLOCKED: PROC-018 登录结果与权限响应的 tenantId 不一致')
  }
  if (String(expectedTenantId ?? '').trim() &&
      normalizeTenantId(expectedTenantId, 'CFOR_TENANT_ID') !== tenantId) {
    throw new Error('BLOCKED: PROC-018 CFOR_TENANT_ID 与已验证登录租户不一致')
  }
  return tenantId
}

export const purchaseOrderTenantPredicate = (tenantId) =>
  `po.tenant_id = ${normalizeTenantId(tenantId, 'PROC-018 SQL tenantId')}`

export const assertProcurementApproverCredentials = (settings = config) => {
  for (const [label, username, password] of [
    ['采购负责人', settings.purchaseApproverUsername, settings.purchaseApproverPassword],
    ['财务复核', settings.financeApproverUsername, settings.financeApproverPassword],
    ['负责人终审', settings.finalApproverUsername, settings.finalApproverPassword]
  ]) {
    if (typeof username !== 'string' || !username.trim() ||
        typeof password !== 'string' || !password.trim()) {
      throw new Error(`BLOCKED: PROC-018 缺少 ${label} 账号或密码配置，尚未创建或提审请购`)
    }
  }
}

const procurementTaskList = (payload) => {
  const value = payload?.data ?? payload
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.records)) return value.records
  return []
}

export const findProcurementTask = (tasks, taskDefinitionKey) =>
  (Array.isArray(tasks) ? tasks : []).find((task) =>
    task?.taskDefinitionKey === taskDefinitionKey &&
    (!task?.endTime || Number(task?.status) === 1)
  ) || null

export const formatProcurementTaskEvidence = (task, configuredUsername = '') => {
  const actualAssigneeId = task?.assigneeUser?.id ?? task?.assignee ?? ''
  const actualAssigneeName = task?.assigneeUser?.nickname ?? ''
  return [
    `taskId=${task?.id || ''}`,
    `node=${task?.taskDefinitionKey || ''}`,
    `status=${task?.status ?? ''}`,
    `configuredUsername=${configuredUsername}`,
    `actualAssigneeId=${actualAssigneeId || 'unknown'}`,
    `actualAssigneeName=${actualAssigneeName || 'unknown'}`
  ].join(', ')
}

export const assertProcurementTaskAssignee = ({ task, identity, label } = {}) => {
  const evidence = formatProcurementTaskEvidence(task, identity?.username)
  if (!task?.id || !task?.taskDefinitionKey) {
    throw new Error(`BLOCKED: PROC-018 ${label || '审批'}未获得可核对的任务节点：${evidence}`)
  }
  const actualAssigneeId = task?.assigneeUser?.id ?? task?.assignee
  const expectedAssigneeId = identity?.userId
  if (!actualAssigneeId || !expectedAssigneeId ||
      String(actualAssigneeId) !== String(expectedAssigneeId)) {
    throw new Error(`BLOCKED: PROC-018 ${label || '审批'}实际 assignee 不匹配：${evidence}`)
  }
  return task
}

export const withdrawProcurementApproval = async ({
  api,
  taskId,
  processInstanceId,
  caseRecord
} = {}) => {
  if (!api?.putBusiness || !taskId) {
    throw new Error(
      `BLOCKED: PROC-018 无法执行正式撤回：processInstanceId=${processInstanceId || ''}, taskId=${taskId || ''}`
    )
  }
  const response = await api.putBusiness(
    `/bpm/task/withdraw?taskId=${encodeURIComponent(taskId)}`
  )
  caseRecord?.checks?.push({
    name: '实际 assignee 不匹配后通过 BPM 正式撤回清理',
    passed: true,
    details: `processInstanceId=${processInstanceId || ''}, withdrawnTaskId=${taskId}`
  })
  return response
}

const authenticateProcurementApprover = async ({
  label,
  username,
  password,
  tenantId,
  record,
  approverBrowsers,
  approverResources = [],
  loginImpl = loginWithCredentials,
  browserFactory = launchBrowser,
  apiFactory = createApiClient
} = {}) => {
  const approverBrowser = await browserFactory({ record })
  approverBrowsers.push(approverBrowser)
  const loginContext = await loginImpl(approverBrowser.page, {
    tenantName: config.tenantName,
    username,
    password
  }, { returnContext: true })
  const token = typeof loginContext === 'string' ? loginContext : loginContext?.token
  if (!token) throw new Error(`BLOCKED: PROC-018 ${label}登录成功后未获得 token`)

  const bootstrapApi = apiFactory({ token, tenantId, record })
  approverResources.push({ label, browser: approverBrowser, logoutApi: bootstrapApi })
  const permissionInfo = assertBusinessSuccess(
    await bootstrapApi.getPermissionInfo(),
    `${label}权限上下文`
  )
  const resolvedTenantId = resolveProcurementTenantId({
    loginContext: typeof loginContext === 'string' ? undefined : loginContext,
    permissionInfo,
    expectedTenantId: tenantId
  })
  const permission = permissionInfo?.data ?? permissionInfo
  const user = permission?.user
  if (!user?.id) {
    throw new Error(`BLOCKED: PROC-018 ${label}权限上下文缺少用户 ID，未创建或提审请购`)
  }
  if (user.username && String(user.username) !== String(username)) {
    throw new Error(
      `BLOCKED: PROC-018 ${label}登录身份不一致：configuredUsername=${username}, actualUsername=${user.username}`
    )
  }
  return {
    browser: approverBrowser,
    api: apiFactory({ token, tenantId: resolvedTenantId, record }),
    identity: {
      username: String(username),
      userId: String(user.id),
      nickname: user.nickname || ''
    }
  }
}

/**
 * Build the approved request precondition used by PROC-014's independent
 * closed-line rejection probe. The BPM route intentionally stays formal so
 * the negative order request cannot be explained by a draft status.
 */
const approvePurchaseRequestForClosure = async ({ api, fixture, caseRecord, record }) => {
  assertProcurementApproverCredentials()
  const approverBrowsers = []
  const approverResources = []
  const approverSessions = {}
  const tenantId = String(config.tenantId || '1')
  let approved
  let failure
  try {
    approverSessions.purchase = await authenticateProcurementApprover({
      label: '采购负责人', username: config.purchaseApproverUsername,
      password: config.purchaseApproverPassword, tenantId, record, approverBrowsers,
      approverResources
    })
    approverSessions.finance = await authenticateProcurementApprover({
      label: '财务复核', username: config.financeApproverUsername,
      password: config.financeApproverPassword, tenantId, record, approverBrowsers,
      approverResources
    })
    approverSessions.final = await authenticateProcurementApprover({
      label: '负责人终审', username: config.finalApproverUsername,
      password: config.finalApproverPassword, tenantId, record, approverBrowsers,
      approverResources
    })

    const waitForRequest = async (predicate, timeoutMs = 60000) => {
      const deadline = Date.now() + timeoutMs
      let latest
      while (Date.now() < deadline) {
        latest = await fixture.read()
        if (predicate(latest)) return latest
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return latest
    }

    await api.putBusiness(
      `/erp/purchase/order/request/update-status?id=${encodeURIComponent(fixture.id)}&status=10`
    )
    const submitted = await waitForRequest(
      (request) => String(request.billStage) === '22' && Boolean(request.processInstanceId)
    )
    if (!submitted?.processInstanceId) {
      throw new Error(`PROC-014 专属已审核前置未进入 BPM：${JSON.stringify(submitted)}`)
    }

  const readProcessTasks = async () => {
    const payload = await api.getBusiness(
      `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(submitted.processInstanceId)}`
    )
    return procurementTaskList(payload)
  }
  const waitForProcessTask = async (taskDefinitionKey, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs
    let latest = []
    while (Date.now() < deadline) {
      latest = await readProcessTasks()
      const task = findProcurementTask(latest, taskDefinitionKey)
      if (task?.id) return task
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return findProcurementTask(latest, taskDefinitionKey)
  }
  const waitForTodo = async (approverApi, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await approverApi.getBusiness(
        `/bpm/task/my-todo?processInstanceId=${encodeURIComponent(submitted.processInstanceId)}`
      )
      const value = latest?.data ?? latest
      const task = Array.isArray(value) ? value[0] : value
      if (task?.id) return task
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return null
  }
    const approveInBrowser = async ({ label, session, taskDefinitionKey, opinionText }) => {
    const { browser, api: approverApi, identity } = session
    const processTask = await waitForProcessTask(taskDefinitionKey)
    assertProcurementTaskAssignee({ task: processTask, identity, label })
    const task = await waitForTodo(approverApi)
    if (!task?.id) throw new Error(`PROC-014 ${label}未收到请购 BPM 待办`)
    await openRoute(
      browser.page,
      `/bpm/process-instance/detail?id=${encodeURIComponent(submitted.processInstanceId)}&taskId=${encodeURIComponent(task.id)}`,
      { readySelector: '.processInstance-wrap-main', readyTimeoutMs: 20000, retries: 2 }
    )
    const approveReference = browser.page.getByRole('button', { name: '通过', exact: true }).first()
    await approveReference.waitFor({ state: 'visible', timeout: 30000 })
    await approveReference.click()
    const approvePopover = browser.page.locator('.el-popover:visible').last()
    await approvePopover.waitFor({ state: 'visible', timeout: 30000 })
    const opinion = approvePopover.getByPlaceholder(/请输入.*意见/).first()
    if (await opinion.count()) await opinion.fill(opinionText)
    const [response] = await Promise.all([
      browser.page.waitForResponse(
        (response) => new URL(response.url()).pathname.endsWith('/bpm/task/approve') &&
          response.request().method() === 'PUT',
        { timeout: 60000 }
      ),
      approvePopover.getByRole('button', { name: '通过', exact: true }).click()
    ])
    if (!response.ok()) throw new Error(`${label}审批请求失败：HTTP ${response.status()}`)
    const approvalResult = await readBrowserBusinessResponse(response)
    assertBusinessSuccess(approvalResult, `${label}审批`)
  }

  await approveInBrowser({
    label: '采购负责人', session: approverSessions.purchase,
    taskDefinitionKey: 'FirstApprove_purchase-request', opinionText: 'PROC-014 第一段审批通过'
  })
  await approveInBrowser({
    label: '财务复核', session: approverSessions.finance,
    taskDefinitionKey: 'SecondApprove_purchase-request', opinionText: 'PROC-014 第二段审批通过'
  })
  await approveInBrowser({
    label: '负责人终审', session: approverSessions.final,
    taskDefinitionKey: 'FinalApprove_purchase-request', opinionText: 'PROC-014 终审通过'
  })

    approved = await waitForRequest((request) =>
      String(request.billStage) === '24' && Number(request.isEffective) === 1)
    if (String(approved?.billStage) !== '24' || Number(approved?.isEffective) !== 1) {
      throw new Error(`PROC-014 专属请购未形成已审核状态：${JSON.stringify(approved)}`)
    }
    caseRecord.checks.push({
      name: '专属请购通过正式 BPM 审核后再执行独立关闭行反例',
      passed: true,
      details: `requestId=${fixture.id}, billStage=${approved.billStage}, isEffective=${approved.isEffective}, isPlaceOrder=${approved.isPlaceOrder}`
    })
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    for (const browser of approverBrowsers) {
      try {
        await browser.flushResponses()
      } catch (error) {
        cleanupErrors.push(`审批页面响应检查失败：${String(error.message || error).slice(0, 300)}`)
      }
    }
    for (const browser of approverBrowsers) {
      try {
        await browser.browser.close()
      } catch (error) {
        cleanupErrors.push(`审批浏览器关闭失败：${String(error.message || error).slice(0, 300)}`)
      }
    }
    for (const resource of approverResources) {
      try {
        await resource.logoutApi.postBusiness('/system/auth/logout')
      } catch (error) {
        cleanupErrors.push(`${resource.label}退出失败：${String(error.message || error).slice(0, 300)}`)
      }
    }
    if (cleanupErrors.length) {
      const cleanupFailure = cleanupErrors.join('；')
      failure = failure
        ? new Error(`${String(failure.message || failure).slice(0, 1000)}；${cleanupFailure}`)
        : new Error(cleanupFailure)
    }
  }
  if (failure) throw failure
  return approved
}

const resolveProcurementTenantContext = async ({
  page,
  record,
  loginImpl = login,
  apiFactory = createApiClient
} = {}) => {
  const loginContext = await loginImpl(page, { returnContext: true })
  const token = typeof loginContext === 'string' ? loginContext : loginContext?.token
  if (!token) throw new Error('登录成功后未获得 token')

  let permissionInfo
  if (!loginContext?.tenantId) {
    const bootstrapApi = apiFactory({ token, tenantId: '', record })
    permissionInfo = assertBusinessSuccess(
      await bootstrapApi.getPermissionInfo(), 'PROC-018 权限上下文')
  }
  const tenantId = resolveProcurementTenantId({
    loginContext: typeof loginContext === 'string' ? undefined : loginContext,
    permissionInfo
  })
  return {
    token,
    tenantId,
    api: apiFactory({ token, tenantId, record })
  }
}

export const procurementReadonlyPage = (payload, label) => {
  const data = readonlyData(payload, label)
  if (!data || !Array.isArray(data.list) || !Number.isSafeInteger(data.total) ||
      data.total < data.list.length || data.list.length > 100 ||
      data.list.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${label} 必须返回有效 data.list/total 分页`)
  }
  return data
}

const validateRuleVersion = (row, record) => {
  readonlyFact(record, '规则 ID、版本及启停状态有效',
    isStableId(row?.id) && Number.isSafeInteger(row.version) && row.version > 0 &&
      [0, 1].includes(row.status), `id=${row?.id}, version=${row?.version}, status=${row?.status}`)
  const validDate = (value) => value == null ||
    (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value)
  readonlyFact(record, '规则生效日期及先后顺序有效',
    validDate(row.effectiveFrom) && validDate(row.effectiveTo) &&
      (!row.effectiveFrom || !row.effectiveTo || row.effectiveFrom <= row.effectiveTo),
    `id=${row.id}`)
}

export async function runFinanceRuleReadonlyContract({ api, caseRecord }) {
  const types = procurementReadonlyPage(await api.getBusiness(
    '/system/document/type/page?pageNo=1&pageSize=100'), '系统单据类型').list
    .filter((row) => typeof row.code === 'string' && row.code.startsWith('FIN_'))
  const rules = procurementReadonlyPage(await api.getBusiness(
    '/erp/finance-document-type-rule/page?pageNo=1&pageSize=100'), '财务类型规则').list
  readonlyFact(caseRecord, '财务单据类型与规则分页结构有效', true,
    `financeTypes=${types.length}, rules=${rules.length}；仅验证首100条`)
  if (!types.length) missingReadonlyFact(caseRecord, '没有 FIN_ 财务单据类型')
  if (!rules.length) missingReadonlyFact(caseRecord, '没有财务类型规则样本')
  for (const row of rules) {
    readonlyFact(caseRecord, '财务规则 ID、类型、默认审批及手工创建字段有效',
      isStableId(row.id) && isStableId(row.documentTypeId) &&
        typeof row.defaultApproval === 'boolean' && typeof row.allowManualCreate === 'boolean' &&
        (row.requiredFields == null || typeof row.requiredFields === 'string'),
      `ruleId=${row.id}, documentTypeId=${row.documentTypeId}`)
    const detail = readonlyData(await api.getBusiness(
      `/erp/finance-document-type-rule/get?id=${encodeURIComponent(row.id)}`), '财务规则详情')
    readonlyFact(caseRecord, '财务类型规则详情与分页的策略一致',
      detail && String(detail.id) === String(row.id) &&
        String(detail.documentTypeId) === String(row.documentTypeId) &&
        ['defaultApproval', 'allowManualCreate', 'requiredFields']
          .every((key) => detail[key] === row[key]), `ruleId=${row.id}`)
  }
  return {
    partial: true,
    note: '未创建共享规则或财务单据；手工创建拒绝、必填字段拒绝、审批覆盖、重复启用规则拒绝四项需分别用隔离夹具验证'
  }
}

// Only GET endpoints are used; formal writes and historical snapshot consumption remain unverified.
export async function runProcurementReadOnlyContract({ caseId, api, caseRecord }) {
  if (!procurementReadOnlyViews[caseId]) throw new Error(`非目标只读案例：${caseId}`)
  const settlement = caseId === 'PROC-006'
  const base = settlement ? '/erp/settle-method-rule' : '/erp/purchase-type-rule'
  const page = procurementReadonlyPage(
    await api.getBusiness(`${base}/page?pageNo=1&pageSize=100`), base)
  readonlyFact(caseRecord, '规则分页返回真实 list/total', true,
    `rows=${page.list.length}, total=${page.total}；仅验收当前页`)
  if (!page.list.length) missingReadonlyFact(caseRecord, `${base} 没有规则样本，详情与版本契约未验证`)
  let dictionaries = []
  const completeDictionaries = new Set()
  if (settlement) {
    for (const dictType of ['x_settle_method', 'erp_account_type']) {
      const path = `/system/dict-data/page?pageNo=1&pageSize=100&dictType=${dictType}`
      const dictPage = procurementReadonlyPage(await api.getBusiness(path), path)
      if (dictPage.list.length) readonlyFact(caseRecord, '字典返回稳定编码、名称、类型和状态',
        dictPage.list.every((row) => ruleText(row.value) && ruleText(row.label) &&
          row.dictType === dictType && [0, 1].includes(row.status)), dictType)
      if (!dictPage.list.length) missingReadonlyFact(caseRecord, `${dictType} 字典为空`)
      dictionaries.push(...dictPage.list)
      if (dictPage.list.length && dictPage.total === dictPage.list.length) {
        completeDictionaries.add(dictType)
      }
      if (dictPage.total > dictPage.list.length) {
        missingReadonlyFact(caseRecord, `${dictType} 超过首100条，未覆盖其余目录`)
      }
    }
    caseRecord.notes.push('结算规则 RespVO 无 orgId；不虚构组织契约，组织范围只在 PROC-008 验证')
  } else {
    const path = '/system/document/type/page?pageNo=1&pageSize=100&isOpen=true'
    const types = procurementReadonlyPage(await api.getBusiness(path), path).list
    if (types.length) readonlyFact(caseRecord, '启用单据类型目录返回稳定 ID、编码、名称及布尔启用值',
      types.every((row) => isStableId(row.id) && ruleText(row.code) &&
        ruleText(row.name) && row.isOpen === true), `rows=${types.length}`)
    if (!types.some((row) => row.code.startsWith('PURCHASE'))) {
      missingReadonlyFact(caseRecord, '启用目录首100条没有 PURCHASE 采购类型选项')
    }
  }
  for (const row of page.list) {
    validateRuleVersion(row, caseRecord)
    if (settlement) {
      readonlyFact(caseRecord, '结算规则方向、账户与票据账期字段类型正确',
        ruleText(row.settleMethodCode) && ruleText(row.settleMethodName) &&
          ['RECEIPT', 'PAYMENT', 'BOTH'].includes(row.direction) &&
          (row.allowedAccountTypes == null || typeof row.allowedAccountTypes === 'string') &&
          ['requireBillNo', 'requireDueDate', 'allowCredit'].every((key) => typeof row[key] === 'boolean') &&
          (row.defaultCreditDays == null ||
            (Number.isSafeInteger(row.defaultCreditDays) && row.defaultCreditDays >= 0)),
        `id=${row.id}`)
      const references = [
        ['x_settle_method', row.settleMethodCode],
        ...(row.allowedAccountTypes || '').split(',').filter(Boolean).map((code) => ['erp_account_type', code])
      ]
      for (const [type, code] of references) {
        const found = dictionaries.find((item) => item.dictType === type && item.value === code)
        if (!found && completeDictionaries.has(type)) {
          readonlyFact(caseRecord, '完整字典目录必须包含规则引用编码', false, `${type}:${code}`)
        } else if (!found) missingReadonlyFact(caseRecord, `规则 ${row.id} 的 ${type}:${code} 未在当前目录页找到`)
        else readonlyFact(caseRecord, '规则引用真实字典编码', true, `${type}:${code}`)
      }
    } else {
      readonlyFact(caseRecord, '采购规则单据类型和组织/流程/模板字段类型正确',
        isStableId(row.documentTypeId) && ruleText(row.documentTypeCode) &&
          row.documentTypeCode.startsWith('PURCHASE') && ruleText(row.documentTypeName) &&
          ['orgId', 'approvalProcessKey', 'statisticsBasis', 'displayTemplate', 'printTemplate']
            .every((key) => row[key] == null || typeof row[key] === 'string'), `id=${row.id}`)
      const type = readonlyData(await api.getBusiness(
        `/system/document/type/get?id=${encodeURIComponent(row.documentTypeId)}`), '单据类型详情')
      readonlyFact(caseRecord, '采购规则引用真实单据类型 ID/稳定编码/名称',
        type && String(type.id) === String(row.documentTypeId) &&
          type.code === row.documentTypeCode && type.name === row.documentTypeName &&
          typeof type.isOpen === 'boolean', `ruleId=${row.id}`)
      if (!type.isOpen) missingReadonlyFact(caseRecord, `规则 ${row.id} 的单据类型已停用，正式消费未验证`)
      if (!row.orgId?.trim()) caseRecord.notes.push(`规则 ${row.id} orgId 为空，按页面契约为全组织适用`)
      else {
        const orgIds = row.orgId.split(',').map((id) => id.trim())
        readonlyFact(caseRecord, '适用组织为无重复的稳定组织 ID',
          orgIds.every(isStableId) && new Set(orgIds).size === orgIds.length, `ruleId=${row.id}`)
        for (const id of orgIds) {
          const org = readonlyData(await api.getBusiness(
            `/system/dept/get?id=${encodeURIComponent(id)}`), '组织详情')
          readonlyFact(caseRecord, '组织范围引用当前租户可读的真实组织',
            org && String(org.id) === id && ruleText(org.name) && [0, 1].includes(org.status),
            `ruleId=${row.id}, orgId=${id}`)
        }
      }
    }
    const detail = readonlyData(await api.getBusiness(
      `${base}/get?id=${encodeURIComponent(row.id)}`), `${base}/get`)
    const fields = settlement
      ? ['id', 'version', 'status', 'settleMethodCode', 'direction', 'allowedAccountTypes',
        'requireBillNo', 'requireDueDate', 'allowCredit', 'defaultCreditDays', 'effectiveFrom', 'effectiveTo']
      : ['id', 'version', 'status', 'documentTypeId', 'documentTypeCode', 'orgId',
        'approvalProcessKey', 'statisticsBasis', 'displayTemplate', 'printTemplate',
        'effectiveFrom', 'effectiveTo']
    readonlyFact(caseRecord, '规则详情与当前分页快照一致',
      detail && fields.every((field) => (detail[field] ?? null) === (row[field] ?? null)),
      `id=${row.id}`)
    const versionPath = settlement
      ? `${base}/list-by-code?settleMethodCode=${encodeURIComponent(row.settleMethodCode)}`
      : `${base}/list-by-document-type?documentTypeId=${encodeURIComponent(row.documentTypeId)}`
    const versions = readonlyArray(await api.getBusiness(versionPath), versionPath)
    readonlyFact(caseRecord, '版本列表包含当前规则且来源限定正确',
      versions.length > 0 && versions.some((item) => String(item.id) === String(row.id) &&
        item.version === row.version) && new Set(versions.map((item) => String(item.id))).size === versions.length &&
        versions.every((item) => settlement
          ? item.settleMethodCode === row.settleMethodCode
          : String(item.documentTypeId) === String(row.documentTypeId)), versionPath)
    versions.forEach((item) => validateRuleVersion(item, caseRecord))
    if (settlement) readonlyFact(caseRecord, '同一结算方式至多一条启用规则',
      versions.filter((item) => item.status === 1).length <= 1, versionPath)
    readonlyFact(caseRecord, '版本列表按后端版本降序返回',
      versions.every((item, index) => index === 0 || versions[index - 1].version >= item.version),
      versionPath)
  }
  const note = '仅真实只读设置/列表/详情/版本与引用契约；未执行配置写入、引用删除保护、订单消费或历史快照，始终 PARTIAL'
  caseRecord.notes.push(note)
  return { partial: true, note }
}

const readBrowserBusinessResponse = async (response) => {
  const text = await response.text()
  return response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(text)
    : JSON.parse(text)
}

export const cases = [
  'PROC-001',
  'PROC-002',
  'PROC-003',
  'PROC-004',
  'PROC-005',
  'PROC-006',
  'PROC-007',
  'PROC-008',
  'PROC-009',
  'PROC-010',
  'PROC-011',
  'PROC-012',
  'PROC-013',
  'PROC-014',
  'PROC-015',
  'PROC-016',
  'PROC-017',
  'PROC-018',
  'PROC-019'
]

const procurementChainSessions = new WeakMap()

async function procurementChainSession ({ page, record, dependencies }) {
  const existing = procurementChainSessions.get(page)
  if (existing) return existing
  const token = await (dependencies.login || login)(page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record })
  const session = { token, api, chain: {} }
  procurementChainSessions.set(page, session)
  return session
}

const createSupplierPortalBusinessApi = ({ request, token }) => ({
  async getBusiness (pathname) {
    const result = await request('GET', pathname, undefined, { token })
    return assertBusinessSuccess(result.body, pathname)
  },
  async postBusiness (pathname, body) {
    const result = await request('POST', pathname, body, { token })
    return assertBusinessSuccess(result.body, pathname)
  }
})

const ensureProcurementSourceMapping = async ({ supplierId, caseRecord }) => {
  if (!/^[1-9]\d*$/.test(String(supplierId))) {
    throw new Error(`BLOCKED: PROC-004 供应商映射缺少稳定 ERP supplierId=${supplierId}`)
  }
  const sourceId = String(supplierId)
  const readMapping = async () => runReadOnlySql(`
    SELECT id, source_id, target_partner_id, review_status
    FROM base_partner_legacy_mapping
    WHERE tenant_id = 1
      AND source_domain = 'ERP_SUPPLIER'
      AND source_id = ${sourceId}
      AND deleted = b'0'
    ORDER BY id ASC
  `)
  const before = await readMapping()
  if (!before.available) throw new Error('BLOCKED: PROC-004 无法读取本地 ERP 供应商映射')
  if (before.rows.length > 1) {
    throw new Error(`BLOCKED: PROC-004 供应商存在多个有效 ERP 映射：sourceId=${sourceId}`)
  }
  if (before.rows.length === 1) {
    const [mappingId, mappedSourceId, targetPartnerId, reviewStatus] = before.rows[0]
    if (mappedSourceId === sourceId &&
        targetPartnerId === sourceId &&
        reviewStatus === 'CONFIRMED') {
      caseRecord.evidence.push(
        `PROC-004 复用已有确认 ERP 供应商映射：mappingId=${mappingId}; sourceId=${sourceId}`
      )
      return {
        mappingId,
        sourceId,
        targetPartnerId: sourceId,
        created: false
      }
    }
    throw new Error(
      `BLOCKED: PROC-004 供应商已有非唯一确认映射：mappingId=${mappingId}; ` +
      `sourceId=${mappedSourceId}; targetPartnerId=${targetPartnerId}; reviewStatus=${reviewStatus}`
    )
  }

  await runLocalFixtureSql(`
    INSERT INTO base_partner_legacy_mapping (
      tenant_id, source_domain, source_id, source_code, source_name, source_tax_no,
      match_type, match_key, candidate_group, target_partner_id, review_status,
      review_remark, evidence_json, reference_summary_json,
      creator, create_time, updater, update_time, deleted
    )
    SELECT
      1, 'ERP_SUPPLIER', supplier.id, supplier.code, supplier.name, supplier.tax_no,
      'TAX_EXACT', CONCAT('E2E:ERP_SUPPLIER:', supplier.id), NULL,
      partner.id, 'CONFIRMED',
      'PROC-004 local source-gate fixture',
      JSON_OBJECT(
        'fixture', 'PROC-004',
        'sourceId', supplier.id,
        'targetPartnerId', partner.id
      ),
      JSON_OBJECT('fixture', 'PROC-004'),
      'e2e', NOW(), 'e2e', NOW(), b'0'
    FROM erp_supplier supplier
    JOIN base_partner partner
      ON partner.id = ${sourceId}
     AND partner.tenant_id = 1
     AND partner.deleted = b'0'
    WHERE supplier.id = ${sourceId}
      AND supplier.tenant_id = 1
      AND supplier.deleted = b'0'
      AND supplier.id = partner.id
      AND NOT EXISTS (
        SELECT 1
        FROM base_partner_legacy_mapping existing
        WHERE existing.tenant_id = 1
          AND existing.source_domain = 'ERP_SUPPLIER'
          AND existing.source_id = supplier.id
          AND existing.deleted = b'0'
      )
  `)

  const after = await readMapping()
  if (!after.available || after.rows.length !== 1 ||
      after.rows[0][1] !== sourceId ||
      after.rows[0][2] !== sourceId ||
      after.rows[0][3] !== 'CONFIRMED') {
    throw new Error(`PROC-004 本地 ERP 供应商映射写入后校验失败：sourceId=${sourceId}`)
  }
  const mappingId = after.rows[0][0]
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'procurement-source-mapping',
    available: true,
    rows: after.rows
  }]
  caseRecord.evidence.push(
    `PROC-004 创建本地确认 ERP 供应商映射：mappingId=${mappingId}; sourceId=${sourceId}; ` +
    `targetPartnerId=${sourceId}`
  )
  return {
    mappingId,
    sourceId,
    targetPartnerId: sourceId,
    created: true
  }
}

const cleanupProcurementSourceMapping = async ({ mapping, caseRecord }) => {
  if (!mapping?.created) return
  await runLocalFixtureSql(`
    UPDATE base_partner_legacy_mapping
    SET deleted = b'1', updater = 'e2e', update_time = NOW()
    WHERE id = ${mapping.mappingId}
      AND tenant_id = 1
      AND source_domain = 'ERP_SUPPLIER'
      AND source_id = ${mapping.sourceId || mapping.targetPartnerId || 0}
      AND target_partner_id = ${mapping.targetPartnerId || mapping.sourceId || 0}
      AND review_status = 'CONFIRMED'
      AND deleted = b'0'
  `)
  const verify = await runReadOnlySql(`
    SELECT COUNT(*)
    FROM base_partner_legacy_mapping
    WHERE id = ${mapping.mappingId}
      AND tenant_id = 1
      AND deleted = b'0'
  `)
  if (!verify.available || verify.rows[0]?.[0] !== '0') {
    throw new Error(`PROC-004 本地 ERP 供应商映射清理校验失败：mappingId=${mapping.mappingId}`)
  }
  caseRecord.evidence.push(`PROC-004 本地 ERP 供应商映射已软删除：mappingId=${mapping.mappingId}`)
}

const createProcurementSourceGateRunner = ({ api, page, record, caseRecord }) => {
  let reader
  let readerBrowser
  let readerApi
  let supplierAccountId
  let supplierToken
  let supplierMapping
  const tenantId = String(config.tenantId || '1')
  const supplierRequest = createSupplierAuthRequest({ record, settings: config })

  const cleanup = async () => {
    const cleanupErrors = []
    if (supplierToken) {
      try {
        await supplierRequest('POST', '/supplier-api/erp/auth/logout', undefined, {
          token: supplierToken
        })
      } catch (error) {
        cleanupErrors.push(`供应商门户退出失败：${error.message || error}`)
      }
    }
    if (supplierAccountId) {
      try {
        await api.putBusiness(
          `/erp/supplier-portal/account/status?id=${encodeURIComponent(supplierAccountId)}&status=DISABLED`
        )
      } catch (error) {
        cleanupErrors.push(`供应商门户账号停用失败：${error.message || error}`)
      }
    }
    if (supplierMapping) {
      try {
        await cleanupProcurementSourceMapping({ mapping: supplierMapping, caseRecord })
      } catch (error) {
        cleanupErrors.push(`供应商 ERP 映射清理失败：${error.message || error}`)
      }
    }
    try {
      await closeProcurementReaderSession({
        browser: readerBrowser,
        readerApi,
        reader
      })
    } catch (error) {
      cleanupErrors.push(`低权限账号清理失败：${error.message || error}`)
    }
    if (cleanupErrors.length) {
      caseRecord.notes.push(`PROC-004 source gate cleanup：${cleanupErrors.join('；')}`)
    }
  }

  const createSaleInvoiceEvidence = async ({ privilegedApi }) => {
    const state = {
      originalValue: null,
      temporaryOverride: false,
      restored: false
    }
    const configPath = '/system/config/get?category=sales&tag=reconciliation'
    const savePath = '/system/config/save?category=sales&tag=reconciliation'
    const configData = (await privilegedApi.getBusiness(configPath)).data
    state.originalValue = configData?.configData == null ? 'false' : String(configData.configData)
    const enabled = (value) => {
      const normalized = String(value ?? '').trim().toLowerCase()
      if (normalized === 'true' || normalized === '1') return true
      if (normalized === 'false' || normalized === '0' || normalized === '') return false
      try {
        return JSON.parse(normalized)?.enabled === true
      } catch {
        return false
      }
    }
    const restore = async () => {
      if (!state.temporaryOverride || state.restored) return
      const current = (await privilegedApi.getBusiness(configPath)).data
      if (!enabled(current?.configData)) {
        throw new Error('BLOCKED: PROC-004 销售对账配置被并发修改，拒绝覆盖当前值')
      }
      await privilegedApi.postBusiness(savePath, { configData: state.originalValue })
      const restored = (await privilegedApi.getBusiness(configPath)).data
      if (String(restored?.configData ?? '') !== state.originalValue) {
        throw new Error(
          `BLOCKED: PROC-004 销售对账配置恢复失败：expected=${state.originalValue}; ` +
          `actual=${restored?.configData ?? ''}`
        )
      }
      state.restored = true
      caseRecord.evidence.push(`PROC-004 sales/reconciliation 已恢复原值=${state.originalValue}`)
    }
    try {
      if (!enabled(state.originalValue)) {
        await privilegedApi.postBusiness(savePath, { configData: '{"enabled":true}' })
        const prepared = (await privilegedApi.getBusiness(configPath)).data
        if (!enabled(prepared?.configData)) {
          throw new Error('PROC-004 销售对账配置启用后回读仍未生效')
        }
        state.temporaryOverride = true
        caseRecord.evidence.push(
          `PROC-004 sales/reconciliation 临时启用，原值=${state.originalValue}`
        )
      } else {
        caseRecord.evidence.push('PROC-004 sales/reconciliation 原值已启用，直接复用来源门禁')
      }

      const permission = assertBusinessSuccess(
        await privilegedApi.getBusiness('/system/auth/get-permission-info'),
        'PROC-004 销售来源账号权限'
      ).data
      const userId = permission?.user?.id
      if (!isStableId(userId)) {
        throw new Error('BLOCKED: PROC-004 销售来源账号缺少稳定用户 ID')
      }
      const fixture = await createSalesFixture(
        privilegedApi, caseRecord, userId, { crm: true, warehouse: true }
      )
      const account = await createSalesSettlementAccount(privilegedApi, caseRecord, fixture.tag)
      await createSalesOpeningInventory(privilegedApi, caseRecord, fixture, 106)
      const orderId = String(assertBusinessSuccess(
        await privilegedApi.postBusiness('/erp/sale-order/create',
          salesOrderBody(fixture, 'NORMAL')),
        'PROC-004 创建专属销售订单'
      ).data)
      const order = (await privilegedApi.getBusiness(`/erp/sale-order/get?id=${orderId}`)).data
      if (!isStableId(order?.id) || String(order.customerId) !== String(fixture.partnerId) ||
          !Array.isArray(order.items) || order.items.length !== 1) {
        throw new Error('PROC-004 专属销售订单详情不完整，未继续创建销售应收')
      }
      caseRecord.fixtures = [...(caseRecord.fixtures || []), {
        kind: 'procurement-source-gate-sale-order',
        id: orderId,
        owned: true,
        tenantId: 1,
        tag: fixture.tag,
        customerId: String(fixture.partnerId)
      }]

      const invoiceTypes = (await privilegedApi.getBusiness(
        '/system/dict-data/page?pageNo=1&pageSize=100&dictType=invoice_type'
      )).data
      const invoiceType = invoiceTypes?.list?.find((row) =>
        Number(row.status) === 0 && /^\d+$/.test(String(row.value)))
      if (!invoiceType) throw new Error('BLOCKED: PROC-004 缺少启用发票类型')
      const invoiceBody = {
        customerId: String(fixture.partnerId),
        companyName: fixture.tag,
        taxNo: `E2E${fixture.tag.replace(/[^A-Z0-9]/g, '').slice(0, 30)}`,
        invoiceType: Number(invoiceType.value),
        taxRate: 0,
        invoiceMoney: Number(order.totalPrice),
        invoicePrice: Number(order.totalPrice),
        srcBillType: 'SALE_ORDER',
        saleOrderNo: order.no,
        billDate: new Date().toISOString().slice(0, 10),
        remark: `${fixture.tag} PROC-004 sales source gate`,
        isRubric: 0,
        items: [{ saleOrderId: orderId, invoiceMoneyItem: Number(order.totalPrice) }]
      }
      const rejected = await privilegedApi.post('/erp/sale-invoice/create', invoiceBody, {
        expectedBusinessRejection: procurementSourceGateContracts.saleInvoiceReconciliation
      })
      assertProcurementSourceRejection(
        rejected,
        procurementSourceGateContracts.saleInvoiceReconciliation,
        'PROC-004 销售对账启用后未确认应收创建销售发票'
      )
      caseRecord.checks.push({
        name: 'PROC-004 销售对账启用后未确认应收不能创建销售发票',
        passed: true,
        details: `code=${rejected.code}; msg=${rejected.msg || ''}; orderId=${orderId}`
      })

      let approved = (await privilegedApi.getBusiness(`/erp/sale-order/get?id=${orderId}`)).data
      if (Number(approved.status) !== 20) {
        await privilegedApi.putBusiness(`/erp/sale-order/update-status?id=${orderId}&status=10`)
        const submitted = (await privilegedApi.getBusiness(`/erp/sale-order/get?id=${orderId}`)).data
        const processId = submitted.processInstanceId || submitted.bpmiInstanceId
        if (processId) {
          await approveOwnedSalesProcess({
            api: privilegedApi,
            page,
            record,
            caseRecord,
            processId
          })
        } else {
          throw new Error(`BLOCKED: PROC-004 销售订单提交后没有 BPM 流程，status=${submitted.status}`)
        }
        approved = (await privilegedApi.getBusiness(`/erp/sale-order/get?id=${orderId}`)).data
      }
      if (Number(approved.status) !== 20) {
        throw new Error(`BLOCKED: PROC-004 专属销售订单审批未完成，status=${approved.status}`)
      }
      const receivablePage = (await privilegedApi.getBusiness(
        `/finance/finReceivable/list?pageNo=1&pageSize=100&customerId=${encodeURIComponent(fixture.partnerId)}`
      )).data
      const receivableRows = Array.isArray(receivablePage?.list)
        ? receivablePage.list
        : Array.isArray(receivablePage?.records)
          ? receivablePage.records
          : []
      const receivable = receivableRows.find((row) =>
        row.srcBillType === 'SalOrder' && String(row.srcBillId) === orderId)
      if (!isStableId(receivable?.id)) {
        throw new Error('BLOCKED: PROC-004 销售订单审批后没有形成专属应收')
      }
      const unconfirmed = (await privilegedApi.getBusiness(
        `/finance/finReceivable/queryById?id=${encodeURIComponent(receivable.id)}`
      )).data
      if (Number(unconfirmed?.isConfirm) === 1) {
        throw new Error('BLOCKED: PROC-004 专属应收创建后已经被提前确认，无法验证未确认负向门禁')
      }
      const { out } = await createApprovedNormalSalesOut(
        { page, record, caseRecord },
        privilegedApi,
        fixture,
        account,
        { ...(await privilegedApi.getBusiness(`/erp/sale-order/get?id=${orderId}`)).data }
      )
      const availableLines = (await privilegedApi.getBusiness(
        `/erp/sale-reconciliation/available-lines?customerId=${encodeURIComponent(fixture.partnerId)}`
      )).data
      if (!Array.isArray(availableLines)) {
        throw new Error('BLOCKED: PROC-004 销售对账可用明细响应不是数组')
      }
      const availableLine = availableLines.find((line) =>
        String(line?.sourceOutId) === String(out.id) &&
        isStableId(line?.sourceOutItemId))
      if (!availableLine) {
        throw new Error(
          `BLOCKED: PROC-004 已审核销售出库没有进入销售对账可用明细；saleOutId=${out.id}`
        )
      }
      const reconciliationId = String(assertBusinessSuccess(
        await privilegedApi.postBusiness('/erp/sale-reconciliation/create', {
          customerId: String(fixture.partnerId),
          periodStart: new Date().toISOString().slice(0, 10),
          periodEnd: new Date().toISOString().slice(0, 10),
          sourceOutItemIds: [String(availableLine.sourceOutItemId)],
          remark: `${fixture.tag} PROC-004 sales reconciliation`
        }),
        'PROC-004 创建专属销售对账单'
      ).data)
      let reconciliation = (await privilegedApi.getBusiness(
        `/erp/sale-reconciliation/get?id=${encodeURIComponent(reconciliationId)}`
      )).data
      const sourceLine = reconciliation?.lines?.find((line) =>
        String(line?.sourceOutItemId) === String(availableLine.sourceOutItemId))
      if (!isStableId(sourceLine?.id) || !Number.isInteger(Number(reconciliation?.version))) {
        throw new Error('BLOCKED: PROC-004 销售对账详情缺少专属明细或版本')
      }
      const confirmLine = (line) => ({
        id: String(line.id),
        confirmedQty: Number(line.enterpriseConfirmedQty),
        confirmedPrice: Number(line.enterpriseConfirmedPrice),
        confirmedTaxPrice: Number(line.enterpriseConfirmedTaxPrice || 0),
        remark: `${fixture.tag} confirmed`
      })
      await privilegedApi.putBusiness('/erp/sale-reconciliation/submit', {
        id: reconciliationId, version: reconciliation.version
      })
      reconciliation = (await privilegedApi.getBusiness(
        `/erp/sale-reconciliation/get?id=${encodeURIComponent(reconciliationId)}`
      )).data
      await privilegedApi.putBusiness('/erp/sale-reconciliation/internal-confirm', {
        id: reconciliationId,
        version: reconciliation.version,
        lines: (reconciliation.lines || []).map(confirmLine)
      })
      reconciliation = (await privilegedApi.getBusiness(
        `/erp/sale-reconciliation/get?id=${encodeURIComponent(reconciliationId)}`
      )).data
      await privilegedApi.putBusiness('/erp/sale-reconciliation/customer-confirm', {
        id: reconciliationId,
        version: reconciliation.version,
        lines: (reconciliation.lines || []).map(confirmLine)
      })
      reconciliation = (await privilegedApi.getBusiness(
        `/erp/sale-reconciliation/get?id=${encodeURIComponent(reconciliationId)}`
      )).data
      await privilegedApi.putBusiness('/erp/sale-reconciliation/complete', {
        id: reconciliationId, version: reconciliation.version
      })
      reconciliation = (await privilegedApi.getBusiness(
        `/erp/sale-reconciliation/get?id=${encodeURIComponent(reconciliationId)}`
      )).data
      const completedLine = reconciliation?.lines?.find((line) =>
        String(line?.id) === String(sourceLine.id))
      if (reconciliation?.status !== 'COMPLETED' ||
          Number(completedLine?.remainingInvoiceAmount) <= 0) {
        throw new Error(
          `BLOCKED: PROC-004 销售对账完成后没有可开票余额；` +
          `reconciliationId=${reconciliationId}, status=${reconciliation?.status}`
        )
      }
      caseRecord.evidence.push(
        `PROC-004 ERP销售对账已完成：reconciliationId=${reconciliationId}; ` +
        `entryId=${completedLine.id}; version=${reconciliation.version}`
      )
      const invoiceId = String(assertBusinessSuccess(
        await privilegedApi.postBusiness('/erp/sale-invoice/create', invoiceBody),
        'PROC-004 已确认应收创建销售发票'
      ).data)
      const invoice = (await privilegedApi.getBusiness(
        `/erp/sale-invoice/get?id=${encodeURIComponent(invoiceId)}`
      )).data
      let version
      try {
        const rawSnapshot = invoice.reconciliationSourceVersions
        const snapshot = typeof rawSnapshot === 'string'
          ? JSON.parse(rawSnapshot)
          : rawSnapshot
        version = snapshot?.allocations
          ?.find((item) => String(item?.entryId) === String(completedLine.id))
          ?.sourceVersion
      } catch {}
      if (!version) {
        throw new Error('PROC-004 销售发票来源版本快照缺少专属销售对账明细版本')
      }
      caseRecord.evidence.push(
        `PROC-004 销售对账正向来源已确认并生成发票：orderId=${orderId}; ` +
        `receivableId=${receivable.id}; invoiceId=${invoiceId}`
      )
      return {
        invoice,
        receivableId: String(receivable.id),
        entryIds: [String(completedLine.id)],
        version
      }
    } finally {
      await restore()
    }
  }

  const submitSupplierInvoice = async ({ supplierPortalApi, reconciliation, confirmedLine }) => {
    if (!supplierToken) {
      const tag = `PROC004_${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`
      const loginName = `e2e_proc004_${tag.toLowerCase()}`
      const password = `P04-${randomBytes(12).toString('base64url')}-x9`
      supplierAccountId = String(assertBusinessSuccess(
        await api.postBusiness('/erp/supplier-portal/account/create', {
          basePartnerId: String(reconciliation.supplierId),
          loginName,
          password,
          contactName: 'PROC-004 local source gate',
          contactEmail: '',
          status: 'ENABLED'
        }),
        'PROC-004 供应商门户账号创建'
      ).data)
      caseRecord.accounts = [...(caseRecord.accounts || []), {
        kind: 'supplier-portal-source-gate',
        accountId: supplierAccountId,
        supplierId: String(reconciliation.supplierId),
        status: 'ENABLED'
      }]
      supplierMapping = await ensureProcurementSourceMapping({
        supplierId: reconciliation.supplierId,
        caseRecord
      })
      const loginResult = await supplierRequest('POST', '/supplier-api/erp/auth/login', {
        loginName,
        password
      }, { encrypted: true })
      const session = assertBusinessSuccess(loginResult.body, 'PROC-004 供应商门户登录').data
      if (!session?.accessToken) throw new Error('PROC-004 供应商门户登录未返回 accessToken')
      supplierToken = session.accessToken
    }

    const invoiceablePayload = await supplierPortalApi.getBusiness(
      '/supplier-api/erp/purchase-invoices/invoiceable-lines'
    )
    const invoiceableLines = invoiceablePayload?.data
    if (!Array.isArray(invoiceableLines)) {
      throw new Error(
        `PROC-004 供应商门户可开票明细响应不是数组：${JSON.stringify({
          code: invoiceablePayload?.code,
          dataType: typeof invoiceableLines
        })}`
      )
    }
    const line = invoiceableLines.find((item) =>
      String(item?.id) === String(confirmedLine.id))
    if (!line) {
      throw new Error(
        `PROC-004 供应商门户可开票明细缺少已确认对账行：entryId=${confirmedLine.id}`
      )
    }
    const amount = Number(line.remainingInvoiceAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`PROC-004 供应商门户可开票余额无效：entryId=${line.id}`)
    }
    const invoiceId = String((await supplierPortalApi.postBusiness(
      '/supplier-api/erp/purchase-invoices/submit',
      {
        invoiceNo: `PROC004-${Date.now().toString(36).toUpperCase()}`,
        invoiceType: 1,
        taxRate: 0,
        remark: `PROC-004 supplier portal source gate ${reconciliation.reconciliationId}`,
        lines: [{
          entryId: String(line.id),
          amount,
          sourceVersion: String(reconciliation.confirmed?.confirmVersion || '')
        }]
      }
    )).data)
    return assertBusinessSuccess(
      await api.getBusiness(`/erp/purchase-invoice/get?id=${encodeURIComponent(invoiceId)}`),
      'PROC-004 供应商门户采购发票回读'
    ).data
  }

  return async ({ api: privilegedApi }) => {
    try {
      reader = await createProcurementPermissionReader(privilegedApi, caseRecord, {
        permission: 'erp:purchase-order:query',
        label: 'PROC004',
        component: 'erp/purchase/order/index'
      })
      readerBrowser = await launchBrowser({ record })
      const readerToken = await loginWithCredentials(readerBrowser.page, reader.credentials)
      readerApi = createApiClient({ token: readerToken, tenantId, record })
      const permission = assertBusinessSuccess(
        await readerApi.getPermissionInfo(),
        'PROC-004 低权限账号权限上下文'
      ).data
      if (permission?.permissions?.includes('erp:purchase-order:direct-create')) {
        throw new Error('PROC-004 低权限账号意外拥有 erp:purchase-order:direct-create')
      }
      const lowPrivilegeApi = createApiClient({ token: readerToken, tenantId, record })
      const supplierPortalApi = createSupplierPortalBusinessApi({
        request: supplierRequest,
        token: () => supplierToken
      })
      // The adapter resolves the token only after the supplier account is created.
      supplierPortalApi.getBusiness = async (pathname) => {
        const result = await supplierRequest('GET', pathname, undefined, {
          token: supplierToken
        })
        return assertBusinessSuccess(result.body, pathname)
      }
      supplierPortalApi.postBusiness = async (pathname, body) => {
        const result = await supplierRequest('POST', pathname, body, {
          token: supplierToken
        })
        return assertBusinessSuccess(result.body, pathname)
      }
      return await runProcurementSourceGates({
        privilegedApi,
        lowPrivilegeApi,
        supplierPortalApi,
        submitSupplierInvoice,
        createSaleInvoiceEvidence,
        caseRecord
      })
    } finally {
      await cleanup()
    }
  }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  if (procurementChainCases.includes(caseId)) {
    const session = await procurementChainSession({ page, record, dependencies })
    const runChainFixture = dependencies.runProcurementChainFixture || runProcurementChainFixture
    const writeEnabled = (dependencies.env || process.env).CFOR_E2E_WRITE_FIXTURES === 'true'
    const sourceGateRunner = caseId === 'PROC-004' && writeEnabled
      ? createProcurementSourceGateRunner({ api: session.api, page, record, caseRecord })
      : undefined
    const result = await runChainFixture({
      caseId,
      api: session.api,
      page,
      record,
      caseRecord,
      outputDir,
      chain: session.chain,
      writeEnabled,
      openRoute: dependencies.openRoute || openRoute,
      saveScreenshot: dependencies.saveScreenshot || saveScreenshot,
      runMrpClosure: dependencies.runProcurementMrpClosure,
      runProcurementSourceGates: sourceGateRunner
    })
    const chainEvidence = {
      'PROC-001': {
        0: { checks: [PROCUREMENT_MRP_CHECKS.atp] },
        1: { checks: [PROCUREMENT_MRP_CHECKS.netDemand] },
        2: { checks: [PROCUREMENT_MRP_CHECKS.startGate] },
        3: { checks: [PROCUREMENT_MRP_CHECKS.shortage,
          PROCUREMENT_MRP_CHECKS.source,
          'PROC-001 owned Execution 物料通过正式 MRP 自动请购保留来源和明细'] }
      },
      'PROC-002': {
        0: { checks: ['PROC-002 续用 PROC-001 本轮 owned MRP 自动请购来源'] },
        1: { checks: ['PROC-002 三段 BPM 审批回写请购为已生效',
          'PROC-002 只有正式审批完成的请购才能生成采购订单且保留主表及明细来源'] },
        2: { checks: ['PROC-002 本轮 owned MRP 重复生成未新增请购'] },
        3: { checks: ['采购负责人', '财务复核', '负责人终审'].map((label) =>
          `PROC-002 ${label}收到同流程同节点准确待办并核对实际 assignee`) }
      },
      'PROC-003': {
        0: { checks: ['PROC-003 采购订单审核不新增应付，历史订单应付保留且不重复生成'] },
        1: { checks: ['PROC-003 采购发票复核后生成唯一采购应付，重复复核不重复生成'] },
        2: { checks: ['PROC-003 无到货通知不得直接创建采购入库'] },
        3: { checks: ['PROC-003 101 入库生效后未完成质检时数量停留在待检隔离量',
          'PROC-003 采购入库检正式审核后 availableQty 增加且 holdQty 等量减少',
          'PROC-003 采购入库检审核前后库存总量守恒'] },
        4: { checks: ['PROC-003 采购入库回写订单 inCount'] }
      },
      'PROC-004': {
        0: { checks: ['PROC-004 请购开关启用时无有效来源的普通采购订单被后端拒绝'] },
        1: { checks: [
          PROCUREMENT_SOURCE_GATE_CHECKS.directPermission,
          PROCUREMENT_SOURCE_GATE_CHECKS.directReason,
          PROCUREMENT_SOURCE_GATE_CHECKS.directSnapshot
        ] },
        2: { checks: [PROCUREMENT_SOURCE_GATE_CHECKS.saleInvoiceUnconfirmed] },
        3: { checks: [PROCUREMENT_SOURCE_GATE_CHECKS.purchaseInvoiceUnconfirmed] },
        4: { checks: [
          PROCUREMENT_SOURCE_GATE_CHECKS.confirmedReconciliation,
          PROCUREMENT_SOURCE_GATE_CHECKS.purchaseInvoiceSource
        ] }
      }
    }
    procurementCatalogEvidence(caseId, caseRecord, chainEvidence[caseId])
    return { ...result, partial: !caseRecord.passCandidate }
  }
  if (caseId === 'PROC-010') {
    let result
    try {
      result = await runSupplierAuth({ page, record, caseRecord, outputDir }, dependencies.supplierAuth)
    } finally {
      supplierAuthCatalogEvidence(caseRecord)
    }
    return { ...result, partial: !caseRecord.passCandidate }
  }
  if (caseId === 'PROC-005') {
    const token = await (dependencies.login || login)(page)
    const baseApi = (dependencies.createApiClient || createApiClient)({ token, record })
    const api = createProcurementReadonlyApi({ api: baseApi, caseRecord })
    const result = await createProcurementSettlementFixture(api, caseRecord)
    caseRecord.checks.push(
      {
        name: 'PROC-005 请购开关开启时管理员具备合法直采权限',
        passed: result.fixture.requisitionEnabled === false ||
          [PROCUREMENT_DIRECT_CREATE_PERMISSION, PROCUREMENT_SUPER_PERMISSION]
            .includes(result.fixture.directCreatePermission),
        details: `requisitionEnabled=${result.fixture.requisitionEnabled}, ` +
          `directCreatePermission=${result.fixture.directCreatePermission || 'none'}`
      },
      {
        name: 'PROC-005 专属供应商通过正规 API 创建并可用于采购订单',
        passed: true,
        details: `supplierId=${result.fixture.supplierId}`
      },
      {
        name: 'PROC-005 专属结算方式写入 x_settle_method 且规则版本1命中采购订单',
        passed: result.first.settleMethodCode === result.fixture.settleMethodCode &&
          Number(result.first.settleMethodRuleVersion) === 1,
        details: `orderId=${result.fixture.orderId}, code=${result.first.settleMethodCode}, version=${result.first.settleMethodRuleVersion}`
      },
      {
        name: 'PROC-005 规则更新为版本2后历史采购订单版本快照仍为1',
        passed: Number(result.currentRule.version) === 2 &&
          Number(result.second.settleMethodRuleVersion) === 1,
        details: `ruleId=${result.fixture.ruleId}, current=${result.currentRule.version}, order=${result.second.settleMethodRuleVersion}`
      },
      {
        name: 'PROC-005 同一专属客商开启客户角色后销售订单命中结算规则版本2',
        passed: result.fixture.customerId === result.fixture.supplierId &&
          result.saleSnapshot.settleMethodCode === result.fixture.settleMethodCode &&
          Number(result.saleSnapshot.settleMethodRuleVersion) === 2,
        details: `customerId=${result.fixture.customerId}, saleOrderId=${result.fixture.saleOrderId}, version=${result.saleSnapshot.settleMethodRuleVersion}`
      },
      {
        name: 'PROC-005 停用自身专属字典后新销售订单被正规 API 拒绝',
        passed: result.fixture.disabledDictionary === true &&
          result.fixture.disabledCreateRejected === true &&
          Number(result.disabledDictionary.status) === 1 &&
          result.rejectedSale?.code !== 0 &&
          result.rejectedSale?.code !== 200,
        details: `dictionaryId=${result.fixture.dictionaryId}, status=${result.disabledDictionary.status}, code=${result.rejectedSale?.code}, msg=${result.rejectedSale?.msg || ''}`
      }
    )
    caseRecord.notes.push(
      'PROC-005 专属写侧已验证：供应商/客户角色、x_settle_method 字典项、采购订单版本1、销售订单版本2、规则更新及历史快照不回溯、专属字典停用拒绝新销售单；专属实体全部 retained'
    )
    return { token, api }
  }
  if (procurementFoundationReadonlyCases.includes(caseId)) {
    const token = await (dependencies.login || login)(page)
    const baseApi = (dependencies.createApiClient || createApiClient)({ token, record })
    const api = ['PROC-002', 'PROC-004', 'PROC-005'].includes(caseId)
      ? createProcurementReadonlyApi({ api: baseApi, caseRecord })
      : baseApi
    const result = await runProcurementFoundationReadonlyContract({
      caseId, api, caseRecord
    })
    caseRecord.evidence.push(
      '仅执行当前租户认证后的 GET 只读前置；未创建请购、采购、发票、应付、入库或审批事实'
    )
    const foundationGaps = {
      'PROC-001': [
        '未在同一业务时点用 WMS ATP 重算 MRP 现存/预留/在途与建议数量',
        '未构造缺料工单验证禁止开工',
        '未触发并核对缺料流程实例、节点和待办'
      ],
      'PROC-002': [
        '仅回读现有 MRP/请购来源，未从缺料结果触发自动转请购',
        '未执行请购审核生成采购订单闭环',
        '未以同一 MRP 运算重复触发验证幂等',
        '当前账号只读，不能证明指定审批角色收到待办'
      ],
      'PROC-003': [
        '未用专属采购订单验证订单审核不新增应付及历史应付保留',
        '未用专属发票验证复核只生成唯一采购应付和重复复核幂等',
        'ASN 只读关联不能替代到货必经门禁',
        '未执行 WMS 101 入库检放行/阻断及订单 inCount 回写、弃审回退'
      ],
      'PROC-004': [
        '仅读取采购/销售对账和请购开关，未切换共享配置构造来源门禁反例',
        '未构造紧急直采权限+原因双门禁反例',
        '未用已确认对账来源创建购销发票并回读 reconciliationSource 快照'
      ],
      'PROC-005': [
        '未创建专属结算字典和规则改变共享数据',
        '未用新订单验证业务日期命中规则并保存版本快照',
        '未验证停用字典拒绝创建及规则调整不回溯历史订单'
      ]
    }
    procurementCatalogEvidence(caseId, caseRecord, Object.fromEntries(
      (foundationGaps[caseId] || []).map((gap, index) => [index, { gap }])
    ))
    return { token, api, ...result }
  }
  if (procurementReadOnlyViews[caseId]) {
    const token = await (dependencies.login || login)(page)
    const api = (dependencies.createApiClient || createApiClient)({ token, record })
    const permission = readonlyData(
      await api.getBusiness('/system/auth/get-permission-info'), '权限菜单')
    if (!Array.isArray(permission?.menus)) throw new Error('权限响应 data.menus 必须为数组')
    const view = procurementReadOnlyViews[caseId]
    const route = findMenuRouteByComponent(permission.menus, view.component)
    if (!route) throw new Error(`BLOCKED: 权限菜单缺少 component=${view.component}`)
    const result = await runProcurementReadOnlyContract({ caseId, api, caseRecord })
    await (dependencies.openRoute || openRoute)(page, route, { readySelector: view.readySelector })
    const headers = await page.locator('.el-table__header-wrapper th').allInnerTexts()
    readonlyFact(caseRecord, '实际权限菜单路由和领域表头已就绪',
      new URL(page.url()).pathname === route &&
        view.headers.every((label) => headers.some((header) => header.trim() === label)),
      `route=${route}, component=${view.component}`)
    const screenshot = await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, `${caseId}-readonly-settings`, record)
    caseRecord.evidence.push(screenshot)
    if (caseId === 'PROC-008') {
      const env = dependencies.env || process.env
      if (env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
        procurementCatalogEvidence('PROC-008', caseRecord, {
          0: ['实际权限菜单路由和领域表头已就绪'],
          1: ['启用单据类型目录返回稳定 ID、编码、名称及布尔启用值'],
          2: ['规则分页返回真实 list/total', '规则详情与当前分页快照一致']
        })
        return { token, api, ...result }
      }
      if (config.target !== 'local') {
        throw new Error('BLOCKED: PROC-008 写侧验收仅允许 local target')
      }
      if (!databaseConfigured()) {
        throw new Error('BLOCKED: PROC-008 写侧验收需要配置本地数据库只读证据，尚未创建专属规则')
      }
      await assertLocalWriteSafety(caseRecord)
      const write = await createPurchaseTypeRuleWriteFixture(api, caseRecord)
      caseRecord.checks.push({
        name: 'PROC-008 专属采购类型规则创建并回读版本1',
        passed:
          String(write.created?.documentTypeId) === write.documentTypeId &&
          write.created?.documentTypeCode === write.documentTypeCode &&
          Number(write.created?.version) === 1,
        details: `ruleId=${write.ruleId}; type=${write.documentTypeCode}`
      })
      caseRecord.checks.push({
        name: 'PROC-008 非 PURCHASE 前缀单据类型不能创建采购规则',
        passed: write.nonPurchaseRejected?.code !== 0,
        details: `code=${write.nonPurchaseRejected?.code}; msg=${write.nonPurchaseRejected?.msg || ''}`
      })
      caseRecord.checks.push({
        name: 'PROC-008 采购订单保存单据类型、稳定编码与规则版本快照',
        passed:
          String(write.order?.detail?.documentTypeId) === write.documentTypeId &&
          write.order?.detail?.documentTypeCode === write.documentTypeCode &&
          Number(write.order?.detail?.documentTypeRuleVersion) === 1,
        details: `orderId=${write.order?.orderId}; type=${write.order?.detail?.documentTypeCode}; ` +
          `version=${write.order?.detail?.documentTypeRuleVersion}`
      })
      caseRecord.checks.push({
        name: 'PROC-008 采购规则更新后版本自增且可停用',
        passed: Number(write.updated?.version) === 2 && Number(write.disabled?.status) === 0 &&
          Number(write.disabled?.version) === 3,
        details: `ruleId=${write.ruleId}; updated=${write.updated?.version}; ` +
          `disabled=${write.disabled?.status}/${write.disabled?.version}`
      })
      caseRecord.checks.push({
        name: 'PROC-008 被采购订单引用的单据类型禁止删除，只允许停用',
        passed: write.deleteTypeRejected?.code !== 0 && Number(write.disabled?.status) === 0,
        details: `deleteCode=${write.deleteTypeRejected?.code}; status=${write.disabled?.status}`
      })
      procurementCatalogEvidence('PROC-008', caseRecord, {
        0: ['实际权限菜单路由和领域表头已就绪'],
        1: ['启用单据类型目录返回稳定 ID、编码、名称及布尔启用值', 'PROC-008 非 PURCHASE 前缀单据类型不能创建采购规则'],
        2: ['PROC-008 专属采购类型规则创建并回读版本1', 'PROC-008 采购规则更新后版本自增且可停用'],
        3: ['PROC-008 采购订单保存单据类型、稳定编码与规则版本快照'],
        4: ['PROC-008 被采购订单引用的单据类型禁止删除，只允许停用']
      })
      return { token, api, partial: !caseRecord.passCandidate }
    }
    if (caseId === 'PROC-006') {
      const env = dependencies.env || process.env
      if (env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
        procurementCatalogEvidence('PROC-006', caseRecord, {
          0: ['实际权限菜单路由和领域表头已就绪'],
          1: ['结算规则方向、账户与票据账期字段类型正确'],
          2: ['规则分页返回真实 list/total'],
          3: {
            gap: '只读模式未启用写侧夹具，查询/维护权限矩阵尚未构造'
          }
        })
        return { token, api, ...result }
      }
      if (config.target !== 'local') {
        throw new Error('BLOCKED: PROC-006 写侧验收仅允许本地 local target')
      }
      if (!databaseConfigured()) {
        throw new Error('BLOCKED: PROC-006 写侧验收需要配置本地数据库只读证据，尚未创建规则')
      }
      await assertLocalWriteSafety(caseRecord)
      let write
      try {
        write = await createSettleRuleWriteFixture(api, caseRecord)
      } catch (error) {
        const fixture = caseRecord.fixtures?.find((item) => item.kind === 'procurement-settle-rule-write')
        if (fixture?.status === 'creating') {
          fixture.status = 'failed'
          fixture.failure = String(error.message || error).slice(0, 500)
          caseRecord.evidence.push(
            `PROC-006 专属夹具中途失败，已登记 retained IDs；${fixture.failure}`
          )
        }
        throw error
      }
      write.fixture.status = 'verified'
      write.fixture.cleanup = {
        rule: 'disabled',
        readerAccount: 'pending-deactivation',
        retainedOrderIds: [write.orderV1?.orderId, write.orderV2?.orderId].filter(Boolean)
      }
      caseRecord.evidence.push(
        `PROC-006 专属夹具已完成验证；规则 ${write.ruleId} 已停用，采购订单仅保留快照证据`
      )
      caseRecord.checks.push({
        name: 'PROC-006 请购开关开启时管理员具备合法直采权限',
        passed: write.fixture.requisitionEnabled === false ||
          [PROCUREMENT_DIRECT_CREATE_PERMISSION, PROCUREMENT_SUPER_PERMISSION]
            .includes(write.fixture.directCreatePermission),
        details: `requisitionEnabled=${write.fixture.requisitionEnabled}, ` +
          `directCreatePermission=${write.fixture.directCreatePermission || 'none'}`
      })
      caseRecord.checks.push({
        name: '专属结算方式字典与规则版本1真实创建并回读',
        passed:
          Boolean(write.dictionaryId) &&
          write.createdRule?.settleMethodCode === write.code &&
          Number(write.createdRule?.version) === 1 &&
          Number(write.createdRule?.status) === 1 &&
          write.createdRule?.settleMethodName === `E2E结算规则-${write.tag}`,
        details: `ruleId=${write.ruleId}, code=${write.code}, version=${write.createdRule?.version}`
      })
      caseRecord.checks.push({
        name: '规则更新版本自增且版本列表按同一规则回读新版本',
        passed:
          Number(write.ruleV2?.version) === 2 &&
          Array.isArray(write.versions) &&
          write.versions.length >= 1 &&
          write.versions.every((item) => String(item.id) === write.ruleId) &&
          write.versions.some((item) => Number(item.version) === 2),
        details: `ruleId=${write.ruleId}, versions=${write.versions?.map((item) => item.version).join(',')}`
      })
      caseRecord.checks.push({
        name: '采购订单按业务日期命中并快照当前规则版本，历史订单不回溯',
        passed:
          write.orderV1?.detail?.settleMethodCode === write.code &&
          Number(write.orderV1?.detail?.settleMethodRuleVersion) === 1 &&
          write.orderV2?.detail?.settleMethodCode === write.code &&
          Number(write.orderV2?.detail?.settleMethodRuleVersion) === 2 &&
          Number(write.orderV1After?.settleMethodRuleVersion) === 1 &&
          Number(write.orderV1After?.status) === 20,
        details: `orderV1=${write.orderV1?.orderId}(v${write.orderV1?.detail?.settleMethodRuleVersion}), ` +
          `orderV2=${write.orderV2?.orderId}(v${write.orderV2?.detail?.settleMethodRuleVersion}), ` +
          `orderV1After=${write.orderV1After?.settleMethodRuleVersion}`
      })
      caseRecord.checks.push({
        name: '规则可停用保存且停用后详情回读为停用状态，不删除平台模板',
        passed:
          Number(write.finalRule?.status) === 0 &&
          Number(write.finalRule?.version) >= 3 &&
          String(write.finalRule?.id) === write.ruleId,
        details: `ruleId=${write.ruleId}, status=${write.finalRule?.status}, version=${write.finalRule?.version}`
      })
      let readerPageVerified = false
      const reader = await createProcurementPermissionReader(api, caseRecord, {
        permission: 'erp:settle-method-rule:query',
        label: 'PROC006',
        component: view.component
      })
      let readerBrowser
      let readerApi
      let readerFailure
      try {
        readerBrowser = await (dependencies.launchBrowser || launchBrowser)({ record })
        const readerToken = await (dependencies.loginWithCredentials || loginWithCredentials)(
          readerBrowser.page, reader.credentials)
        readerApi = (dependencies.createApiClient || createApiClient)({ token: readerToken, record })
        const readerPermission = (await readerApi.getBusiness(
          '/system/auth/get-permission-info')).data
        caseRecord.checks.push({
          name: '隔离只读账号仅拥有结算规则查询权限',
          passed:
            readerPermission.user?.username === reader.username &&
            readerPermission.permissions.includes('erp:settle-method-rule:query') &&
            !readerPermission.permissions.includes('erp:settle-method-rule:update') &&
            !readerPermission.permissions.includes('*:*:*'),
          details: `username=${reader.username}, permissions=${JSON.stringify(readerPermission.permissions)}`
        })
        let readerPageRendered = true
        const readerRoute = findMenuRouteByComponent(readerPermission.menus, view.component)
        if (!readerRoute) throw new Error(`只读账号权限菜单缺少页面 ${view.component}`)
        try {
          await (dependencies.openRoute || openRoute)(readerBrowser.page, readerRoute, {
            readySelector: view.readySelector
          })
        } catch {
          readerPageRendered = false
        }
        const readerBody = await readerBrowser.page.locator('body').innerText().catch(() => '')
        const writeEntryVisible = /新\s*增|编\s*辑|更\s*新/.test(readerBody)
        if (readerPageRendered) {
          readerPageVerified = !writeEntryVisible
          caseRecord.checks.push({
            name: '只读账号可打开规则页但不提供维护写入口',
            passed: !writeEntryVisible,
            details: `username=${reader.username}, writeEntryVisible=${writeEntryVisible}`
          })
        } else {
          caseRecord.notes.push(
            `GAP: PROC-006 只读账号 ${reader.username} 页面未渲染完成；后端 403 不能替代页面无写入口验收`
          )
        }
        await (dependencies.saveScreenshot || saveScreenshot)(
          readerBrowser.page, outputDir, 'erp-settle-method-rule-readonly-account', record)
        const forbiddenUpdate = await readerApi.put('/erp/settle-method-rule/update', {
          ...write.ruleBase,
          id: write.ruleId,
          status: 0
        }, {
          expectedBusinessRejection: {
            code: 403,
            message: '没有该操作权限',
            allowServiceCode: true
          }
        })
        const finalRuleAfter = (await api.getBusiness(
          `/erp/settle-method-rule/get?id=${encodeURIComponent(write.ruleId)}`)).data
        caseRecord.checks.push({
          name: '只读账号直接请求维护接口被后端 403 拒绝且规则未被改写',
          passed:
            forbiddenUpdate?.code === 403 &&
            Number(finalRuleAfter?.status) === Number(write.finalRule?.status) &&
            Number(finalRuleAfter?.version) === Number(write.finalRule?.version),
          details: `code=${forbiddenUpdate?.code}, msg=${forbiddenUpdate?.msg || ''}, ` +
            `status=${finalRuleAfter?.status}, version=${finalRuleAfter?.version}`
        })
        caseRecord.evidence.push(
          `关联只读账号 ${reader.username} 隔离 Chrome 登录、页面无写入口、维护接口 403 取证`
        )
      } catch (error) {
        readerFailure = error
      } finally {
        try {
          await closeProcurementReaderSession({ browser: readerBrowser, readerApi, reader })
          write.fixture.cleanup.readerAccount = 'deactivated'
          write.fixture.cleanup.readerToken = readerApi ? 'logged-out' : 'not-created'
          caseRecord.checks.push({
            name: 'PROC-006 只读账号在取证后已停用',
            passed: true,
            details: `username=${reader.username}`
          })
          caseRecord.notes.push(`PROC-006 已停用本轮关联只读账号 ${reader.username}，保留角色与审计证据`)
        } catch (error) {
          readerFailure = readerFailure
            ? new AggregateError([readerFailure, error], `${readerFailure.message}；${error.message}`)
            : error
        }
      }
      if (readerFailure) throw readerFailure
      await saveScreenshot(page, outputDir, 'erp-settle-method-rule-write-side', record)
      caseRecord.evidence.push(
        `专属结算方式 ${write.code}、规则 ${write.ruleId} 创建/更新版本1→2/停用、` +
        `采购订单 ${write.orderV1?.orderId}/${write.orderV2?.orderId} 版本快照、只读账号权限矩阵`
      )
      procurementCatalogEvidence('PROC-006', caseRecord, {
        0: ['实际权限菜单路由和领域表头已就绪'],
        1: [
          '专属结算方式字典与规则版本1真实创建并回读',
          '结算规则方向、账户与票据账期字段类型正确'
        ],
        2: ['规则分页返回真实 list/total'],
        3: readerPageVerified
          ? [
              '隔离只读账号仅拥有结算规则查询权限',
              '只读账号直接请求维护接口被后端 403 拒绝且规则未被改写',
              '只读账号可打开规则页但不提供维护写入口',
              'PROC-006 只读账号在取证后已停用'
            ]
          : { gap: '只读账号页面无维护入口未渲染完成，不能以接口 403 单独替代页面权限验收' }
      })
      return {
        token, api, partial: !readerPageVerified,
        note: readerPageVerified ? undefined : '只读账号页面无维护入口尚未验证'
      }
    }
    return { token, api, ...result }
  }
  caseRecord.notes.push(
    '案例已锁定 MRP 净需求、缺料禁止开工、采购发票复核生成应付、入库检阻断可用库存、采购数量回写，以及请购/对账开关的后端来源门禁。'
  )
  caseRecord.notes.push(
    'PROC-005 锁定采购/销售订单结算方式与规则版本快照：settle_method_code 取字典 x_settle_method，' +
      'settle_method_rule_version 取按业务日期命中的 erp_settle_method_rule 版本，规则调整不回溯历史订单。'
  )
  caseRecord.notes.push(
    'PROC-008 锁定 ERP 采购类型规则设置页：采购类型复用 system_document_type 的 PURCHASE_ 前缀树，' +
      '规则只维护适用组织/审批流程/统计口径/模板与生效范围，采购订单保存编码与规则版本快照；' +
      'system_document_type 删除/改码前由 MES 引用校验器扫描生产订单、生产类型规则与委外类型规则。'
  )
  caseRecord.notes.push(
    'PROC-006 锁定 ERP 结算方式规则设置页：菜单挂在设置-业务设置-ERP，页面只维护规则，' +
      '结算方式目录继续复用字典 x_settle_method。'
  )
  caseRecord.notes.push(
    'PROC-007 锁定 ERP 财务单据类型规则：单据类型复用 system_document_type 的 FIN_ 固定财务类型，' +
      '规则表只维护适用组织、默认审批、凭证事件、打印模板、编号规则与必填字段策略；' +
      'PB-066 起收款/付款/报销单保存与提交时按该规则执行「不允许手工创建 / 必填字段策略 / 默认审批」。'
  )
  caseRecord.notes.push(
    'PROC-013 锁定企业侧采购工作台：摘要聚合请购/订单/门户接单/到货/对账/开票复核/付款申请，' +
      '不新增工作台事实表，卡片点击下钻既有业务单据列表。'
  )
  caseRecord.notes.push(
    'PROC-014 锁定请购单状态快捷查询与整单/行级关闭：分录新增 is_closed 标记，' +
      '整单关闭复用主表 is_closed，行级关闭后全部分录关闭时主表同步关闭，已关闭分录不再参与下单。'
  )
  caseRecord.notes.push(
    'PROC-015 锁定采购订单深化：列表状态快捷标签、字段级变更审计接口（未执行行数量/单价/备注 + ' +
      '表头备注/预计到货/结算方式）、变更记录查询与独立附件写接口，变更不改变单据状态机。'
  )
  caseRecord.notes.push(
    'PROC-017 锁定待生成请购前置列表：请购单列表直接进入生产订单/销售订单/现存量/MRP 四类来源，' +
      '选择来源后复用既有请购单创建接口生成未审核单，不新增前置事实表。'
  )
  if (caseId === 'PROC-007') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const result = await runFinanceRuleReadonlyContract({ api, caseRecord })
    await openRoute(page, '/settings/erp/finance-document-type-rule', {
      readySelector: '.el-table__header-wrapper th:has-text("手工创建")'
    })
    const headers = await page.locator('.el-table__header-wrapper th').allInnerTexts()
    readonlyFact(caseRecord, '财务单据类型规则设置页真实渲染业务表头',
      new URL(page.url()).pathname === '/settings/erp/finance-document-type-rule' &&
        ['单据类型', '默认审批', '手工创建', '必填字段'].every((label) =>
          headers.some((header) => header.trim() === label)),
      `route=${page.url()}, headers=${headers.join(',')}`)
    const financeTypes = procurementReadonlyPage(await api.getBusiness(
      '/system/document/type/page?pageNo=1&pageSize=100&isOpen=true'), '启用财务单据类型').list
      .filter((row) => typeof row.code === 'string' && row.code.startsWith('FIN_'))
    readonlyFact(caseRecord, '财务类型目录只接受启用且 FIN_ 前缀的稳定类型',
      financeTypes.length > 0 &&
        financeTypes.every((row) => isStableId(row.id) && row.isOpen === true &&
          String(row.code).startsWith('FIN_') && ruleText(row.name)),
      `financeTypes=${financeTypes.length}`)
    caseRecord.evidence.push(await saveScreenshot(
      page, outputDir, 'erp-finance-document-type-rule-readonly', record))
    const env = dependencies.env || process.env
    if (env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
      procurementCatalogEvidence('PROC-007', caseRecord, {
        0: ['财务单据类型规则设置页真实渲染业务表头'],
        1: ['财务类型目录只接受启用且 FIN_ 前缀的稳定类型'],
        2: ['财务规则 ID、类型、默认审批及手工创建字段有效']
      })
      return { token, api, ...result }
    }
    if (config.target !== 'local') {
      throw new Error('BLOCKED: PROC-007 写侧验收仅允许 local target')
    }
    if (!databaseConfigured()) {
      throw new Error('BLOCKED: PROC-007 写侧验收需要配置本地数据库只读证据，尚未创建专属规则')
    }
    await assertLocalWriteSafety(caseRecord)
    const write = await createFinanceRuleWriteFixture(api, caseRecord)
    caseRecord.checks.push({
      name: 'PROC-007 专属财务规则创建策略字段完整回读',
      passed:
        String(write.created?.documentTypeId) === write.documentTypeId &&
        write.created?.documentTypeCode === write.documentTypeCode &&
        write.created?.defaultApproval === true &&
        write.created?.allowManualCreate === false &&
        write.created?.requiredFields === write.createPayload.requiredFields,
      details: `ruleId=${write.ruleId}; type=${write.documentTypeCode}`
    })
    caseRecord.checks.push({
      name: 'PROC-007 allowManualCreate=false 时收款单手工保存被拒绝',
      passed: write.manualCreateProbe?.rejected === true &&
        /不允许手工创建单据/.test(write.manualCreateProbe?.message || ''),
      details: `code=${write.manualCreateProbe?.code}; msg=${write.manualCreateProbe?.message || ''}`
    })
    caseRecord.checks.push({
      name: 'PROC-007 requiredFields 命中为空时收款单保存被拒绝并提示字段',
      passed: write.requiredFieldProbe?.rejected === true &&
        /bankAccountId|settleMethod/.test(write.requiredFieldProbe?.message || ''),
      details: `code=${write.requiredFieldProbe?.code}; msg=${write.requiredFieldProbe?.message || ''}`
    })
    caseRecord.checks.push({
      name: 'PROC-007 defaultApproval=true 且配置流程时覆盖免审为流程审批',
      passed: write.defaultApprovalProbe?.effective === false &&
        Number(write.defaultApprovalProbe?.detail?.isEffective) === 0 &&
        String(write.defaultApprovalProbe?.detail?.billStage) === '22' &&
        typeof write.defaultApprovalProbe?.detail?.processInstanceId === 'string' &&
        write.defaultApprovalProbe.detail.processInstanceId.trim() !== '',
      details: `billId=${write.defaultApprovalProbe?.billId || ''}; ` +
        `stage=${write.defaultApprovalProbe?.detail?.billStage || ''}; ` +
        `effective=${write.defaultApprovalProbe?.detail?.isEffective ?? ''}; ` +
        `processInstanceId=${write.defaultApprovalProbe?.detail?.processInstanceId || ''}; ` +
        `msg=${write.defaultApprovalProbe?.message || ''}`
    })
    caseRecord.checks.push({
      name: 'PROC-007 同一单据类型重复启用规则被拒绝',
      passed: write.duplicate?.code !== 0,
      details: `code=${write.duplicate?.code}; msg=${write.duplicate?.msg || ''}`
    })
    caseRecord.checks.push({
      name: 'PROC-007 被规则引用后的单据类型只可停用不可删除',
      passed: write.deleteTypeRejected?.code !== 0,
      details: `code=${write.deleteTypeRejected?.code}; msg=${write.deleteTypeRejected?.msg || ''}`
    })
    caseRecord.checks.push({
      name: 'PROC-007 规则停用后的策略值可回读且夹具按受控顺序清理',
      passed: Number(write.updated?.status) === 0 &&
        write.updated?.defaultApproval === false &&
        write.updated?.allowManualCreate === true &&
        write.updated?.requiredFields == null,
      details: `ruleId=${write.ruleId}; cleanup=${write.fixture?.cleanup || 'retained'}`
    })
    procurementCatalogEvidence('PROC-007', caseRecord, {
      0: ['财务单据类型规则设置页真实渲染业务表头'],
      1: ['财务类型目录只接受启用且 FIN_ 前缀的稳定类型'],
      2: ['PROC-007 专属财务规则创建策略字段完整回读'],
      3: ['PROC-007 专属财务规则创建策略字段完整回读', 'PROC-007 规则停用后的策略值可回读且夹具按受控顺序清理'],
      4: ['PROC-007 allowManualCreate=false 时收款单手工保存被拒绝'],
      5: ['PROC-007 requiredFields 命中为空时收款单保存被拒绝并提示字段'],
      6: ['PROC-007 defaultApproval=true 且配置流程时覆盖免审为流程审批'],
      7: ['PROC-007 同一单据类型重复启用规则被拒绝'],
      8: ['PROC-007 被规则引用后的单据类型只可停用不可删除']
    })
    return { token, api, partial: !caseRecord.passCandidate }
  }

  if (caseId === 'PROC-009') {
    if (!databaseConfigured()) {
      throw new Error('BLOCKED: PROC-009 写侧验收需要配置本地数据库只读证据，尚未创建账号')
    }
    await assertLocalWriteSafety(caseRecord)
    const token = await login(page)
    const api = createApiClient({ token, record })
    const accountPage = await api.getBusiness(
      '/erp/supplier-portal/account/page?pageNo=1&pageSize=100'
    )
    const accountRows = Array.isArray(accountPage?.data?.list) ? accountPage.data.list : []
    const settings = await api.getBusiness('/erp/supplier-portal/account/settings')
    const subsystemPage = await api.getBusiness('/system/system-init/subsystems')
    const subsystemRows = Array.isArray(subsystemPage?.data) ? subsystemPage.data : []
    const supplierPortalSubsystem = subsystemRows.find(
      (item) => item?.subsystemCode === 'erp.supplier-portal'
    )
    const partnerPage = await api.getBusiness(
      '/base/partner/page?pageNo=1&pageSize=100&status=ACTIVE&supplierEnabled=true'
    )
    const partnerRows = Array.isArray(partnerPage?.data?.list) ? partnerPage.data.list : []
    readonlyFact(caseRecord, '供应商门户账号分页结构有效',
      Array.isArray(accountPage?.data?.list), `accounts=${accountRows.length}`)
    if (!accountRows.length) missingReadonlyFact(caseRecord, '没有供应商门户账号，详情脱敏及账号操作入口未验证')
    else caseRecord.checks.push({
      name: '供应商门户账号分页返回脱敏账号结构',
      passed: accountRows.every(
          (row) =>
            row?.id &&
            row?.loginName &&
            Object.prototype.hasOwnProperty.call(row, 'partnerName') &&
            !Object.prototype.hasOwnProperty.call(row, 'password') &&
            !Object.prototype.hasOwnProperty.call(row, 'passwordHash')
        ),
      details: `accounts=${accountRows.length}`
    })
    caseRecord.checks.push({
      name: '供应商门户配置返回邀请有效期和门户访问地址',
      passed:
        Number.isInteger(settings?.data?.inviteExpireDays) &&
        settings.data.inviteExpireDays >= 1 &&
        settings.data.inviteExpireDays <= 30 &&
        Object.prototype.hasOwnProperty.call(settings.data, 'portalBaseUrl'),
      details: `inviteExpireDays=${settings?.data?.inviteExpireDays}, portalBaseUrl=${settings?.data?.portalBaseUrl || 'fallback'}`
    })
    caseRecord.checks.push({
      name: '账号选择器的客商来源只包含启用供应商角色的统一客商',
      passed:
        Array.isArray(partnerPage?.data?.list) &&
        partnerRows.every((row) => row?.status === 'ACTIVE' && row?.supplierEnabled === true),
      details: `partners=${partnerRows.length}`
    })
    if (accountRows[0]?.id) {
      const detail = await api.getBusiness(
        `/erp/supplier-portal/account/get?id=${encodeURIComponent(accountRows[0].id)}`
      )
      caseRecord.checks.push({
        name: '账号详情不回显密码摘要',
        passed:
          detail?.data &&
          !Object.prototype.hasOwnProperty.call(detail.data, 'password') &&
          !Object.prototype.hasOwnProperty.call(detail.data, 'passwordHash'),
        details: `accountId=${accountRows[0].id}`
      })
    }
    const renderStartedAt = Date.now()
    await openRoute(page, '/settings/erp/supplierPortal', {
      readySelector: '.supplier-portal-settings'
    })
    await page.locator('.supplier-portal-settings').waitFor({
      state: 'visible',
      timeout: 30000
    })
    const renderDurationMs = Date.now() - renderStartedAt
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '门户设置开关与套餐可用性复用 erp.supplier-portal 事实源',
      passed:
        supplierPortalSubsystem != null &&
        typeof supplierPortalSubsystem.available === 'boolean' &&
        typeof supplierPortalSubsystem.status === 'string' &&
        (supplierPortalSubsystem.available || !bodyText.includes('已开启')),
      details: JSON.stringify({
        status: supplierPortalSubsystem?.status,
        available: supplierPortalSubsystem?.available
      })
    })
    const inviteCandidate = accountRows.find(
      (row) => row?.status !== 'ENABLED' && row?.status !== 'LOCKED'
    )
    const inviteEntryVisible =
      (await page.getByRole('button', { name: /邮件邀请|重新邀请/ }).count()) > 0
    caseRecord.checks.push({
      name: '供应商门户账号设置页真实渲染',
      passed:
        page.url().includes('/settings/erp/supplierPortal') &&
        bodyText.includes('供应商门户账号') &&
        bodyText.includes('新增账号') &&
        bodyText.includes('门户访问地址') &&
        bodyText.includes('邀请有效期') &&
        bodyText.includes('保存配置'),
      details: `${page.url()}, renderMs=${renderDurationMs}`
    })
    caseRecord.checks.push({
      name: '供应商门户设置页首屏渲染耗时不超过 5 秒',
      passed: renderDurationMs <= 5000,
      details: `renderMs=${renderDurationMs}`
    })
    if (inviteCandidate) caseRecord.checks.push({
      name: '邀请中或停用账号可看到邮件邀请入口',
      passed: inviteEntryVisible,
      details: `candidateId=${inviteCandidate.id}, visible=${inviteEntryVisible}`
    })
    else missingReadonlyFact(caseRecord, '没有邀请中或停用账号，未验证邮件邀请入口')
    await saveScreenshot(page, outputDir, 'supplier-portal-account-settings', record)

    const tag = `${Date.now().toString(36).toUpperCase()}_${randomBytes(3).toString('hex')}`
    const partnerId = dataOf(await api.postBusiness('/base/partner/create', {
      name: `E2E-PROC009-SUPPLIER-${tag}`,
      shortName: 'E2E-PROC009',
      partnerKind: 'ORGANIZATION',
      status: 'ACTIVE',
      customerEnabled: false,
      supplierEnabled: true,
      carrierEnabled: false,
      remark: `PROC-009 isolated supplier portal account ${tag}`
    }), 'PROC-009 专属供应商')
    const primaryLogin = `e2e_proc009_${tag.toLowerCase()}`
    const primaryAccountId = dataOf(await api.postBusiness(
      '/erp/supplier-portal/account/create',
      {
        basePartnerId: String(partnerId),
        loginName: primaryLogin,
        password: `P9-${randomBytes(10).toString('base64url')}-x8`,
        contactName: 'PROC-009 primary',
        contactMobile: '13800000009',
        contactEmail: 'proc009-primary@example.invalid',
        status: 'ENABLED'
      }
    ), 'PROC-009 专属账号')
    const primary = dataOf(await api.getBusiness(
      `/erp/supplier-portal/account/get?id=${encodeURIComponent(primaryAccountId)}`
    ), 'PROC-009 专属账号详情')
    caseRecord.checks.push({
      name: '专属供应商门户账号真实创建、绑定统一客商且详情不返回密码摘要',
      passed:
        primary.status === 'ENABLED' &&
        String(primary.basePartnerId) === String(partnerId) &&
        primary.loginName === primaryLogin &&
        primary.partnerName === `E2E-PROC009-SUPPLIER-${tag}` &&
        !Object.prototype.hasOwnProperty.call(primary, 'password') &&
        !Object.prototype.hasOwnProperty.call(primary, 'passwordHash'),
      details: `partnerId=${partnerId}, accountId=${primaryAccountId}`
    })

    const changedLogin = `${primaryLogin}_updated`
    dataOf(await api.putBusiness('/erp/supplier-portal/account/update', {
      id: String(primaryAccountId),
      basePartnerId: String(partnerId),
      loginName: changedLogin,
      contactName: 'PROC-009 updated',
      contactMobile: '13900000009',
      contactEmail: 'proc009-updated@example.invalid',
      status: 'DISABLED'
    }), 'PROC-009 更新专属账号')
    const updated = dataOf(await api.getBusiness(
      `/erp/supplier-portal/account/get?id=${encodeURIComponent(primaryAccountId)}`
    ), 'PROC-009 更新后账号详情')
    caseRecord.checks.push({
      name: '专属账号编辑落库并可停用',
      passed:
        updated.loginName === changedLogin &&
        updated.contactName === 'PROC-009 updated' &&
        updated.contactMobile === '13900000009' &&
        updated.contactEmail === 'proc009-updated@example.invalid' &&
        updated.status === 'DISABLED',
      details: `accountId=${primaryAccountId}, status=${updated.status}`
    })

    dataOf(await api.putBusiness(
      `/erp/supplier-portal/account/status?id=${encodeURIComponent(primaryAccountId)}&status=ENABLED`
    ), 'PROC-009 启用专属账号')
    const newPassword = `P9R-${randomBytes(12).toString('base64url')}-z7`
    dataOf(await api.putBusiness('/erp/supplier-portal/account/reset-password', {
      id: String(primaryAccountId),
      password: newPassword
    }), 'PROC-009 重置专属账号密码')
    const reset = dataOf(await api.getBusiness(
      `/erp/supplier-portal/account/get?id=${encodeURIComponent(primaryAccountId)}`
    ), 'PROC-009 重置密码后账号详情')
    caseRecord.checks.push({
      name: '专属账号启停和密码重置返回成功且状态回读为启用',
      passed: reset.status === 'ENABLED' &&
        reset.loginName === changedLogin &&
        !Object.prototype.hasOwnProperty.call(reset, 'passwordHash'),
      details: `accountId=${primaryAccountId}, status=${reset.status}`
    })

    const invitedLogin = `e2e_proc009_invited_${tag.toLowerCase()}`
    const invitedAccountId = dataOf(await api.postBusiness(
      '/erp/supplier-portal/account/create',
      {
        basePartnerId: String(partnerId),
        loginName: invitedLogin,
        contactName: 'PROC-009 invited',
        contactEmail: '',
        status: 'ENABLED'
      }
    ), 'PROC-009 邀请夹具账号')
    const invited = dataOf(await api.getBusiness(
      `/erp/supplier-portal/account/get?id=${encodeURIComponent(invitedAccountId)}`
    ), 'PROC-009 邀请夹具详情')
    const inviteWithoutEmail = await api.post('/erp/supplier-portal/account/invite', {
      id: String(invitedAccountId)
    })
    caseRecord.checks.push({
      name: '无初始密码创建为邀请中，缺少联系邮箱时邀请被业务规则拒绝',
      passed:
        invited.status === 'INVITED' &&
        !invited.contactEmail &&
        ![0, 200].includes(inviteWithoutEmail?.code) &&
        String(inviteWithoutEmail?.msg || '').includes('邮箱'),
      details: `accountId=${invitedAccountId}, code=${inviteWithoutEmail?.code}, msg=${inviteWithoutEmail?.msg || ''}`
    })

    const originalSettings = settings.data
    const testInviteExpireDays = originalSettings.inviteExpireDays === 15 ? 16 : 15
    try {
      dataOf(await api.putBusiness('/erp/supplier-portal/account/settings', {
        portalBaseUrl: 'http://127.0.0.1:9151/supplier',
        inviteExpireDays: testInviteExpireDays
      }), 'PROC-009 保存门户配置')
      const changedSettings = dataOf(await api.getBusiness(
        '/erp/supplier-portal/account/settings'
      ), 'PROC-009 配置回读')
      caseRecord.checks.push({
        name: '门户访问地址和1-30天邀请有效期真实保存并回读一致',
        passed:
          changedSettings.portalBaseUrl === 'http://127.0.0.1:9151/supplier' &&
          Number(changedSettings.inviteExpireDays) === testInviteExpireDays,
        details: `portalBaseUrl=${changedSettings.portalBaseUrl}, inviteExpireDays=${changedSettings.inviteExpireDays}`
      })
    } finally {
      await api.putBusiness('/erp/supplier-portal/account/settings', {
        portalBaseUrl: originalSettings.portalBaseUrl || '',
        inviteExpireDays: originalSettings.inviteExpireDays
      })
      caseRecord.notes.push(
        `PROC-009 已恢复共享门户配置 inviteExpireDays=${originalSettings.inviteExpireDays}`
      )
    }
    caseRecord.fixtures = [...(caseRecord.fixtures || []), {
      kind: 'supplier-portal-account',
      id: String(primaryAccountId),
      partnerId: String(partnerId),
      loginName: changedLogin,
      status: 'ENABLED',
      retained: true
    }, {
      kind: 'supplier-portal-account',
      id: String(invitedAccountId),
      partnerId: String(partnerId),
      loginName: invitedLogin,
      status: 'INVITED',
      retained: true
    }]
    caseRecord.evidence.push(
      `真实登录、专属账号 ${primaryAccountId} 创建/编辑/停用/启用/重置密码、` +
      `无邮箱邀请拒绝账号 ${invitedAccountId}、门户配置写入并恢复、设置页面截图`
    )
    return { token, api }
  }

  if (caseId === 'PROC-011') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const openingPage = await api.getBusiness(
      '/erp/purchase-in/page?pageNo=1&pageSize=100&businessType=OPENING&status=20'
    )
    const openingRows = Array.isArray(openingPage?.data?.list) ? openingPage.data.list : []
    caseRecord.checks.push({
      name: '期初采购入库来源分页只返回已审核期初单',
      passed:
        Array.isArray(openingPage?.data?.list) &&
        openingRows.every(
          (row) => String(row.businessType).toUpperCase() === 'OPENING' && Number(row.status) === 20
        ),
      details: `openingRows=${openingRows.length}`
    })
    if (!openingRows.length) missingReadonlyFact(caseRecord, '没有已审核期初采购入库，来源映射和剩余开票数量金额未验证')
    else caseRecord.checks.push({
      name: '期初采购入库返回开票数量和金额控制字段',
      passed: openingRows.every(
        (row) =>
          Object.prototype.hasOwnProperty.call(row, 'totalCount') &&
          Object.prototype.hasOwnProperty.call(row, 'invoicedCount') &&
          Object.prototype.hasOwnProperty.call(row, 'totalPrice') &&
          Object.prototype.hasOwnProperty.call(row, 'invoicedPrice')
      ),
      details: 'totalCount/invoicedCount/totalPrice/invoicedPrice 字段契约'
    })

    const pageRenderStartedAt = Date.now()
    await openRoute(page, '/erp/purchase/invoice')
    const addButton = page.getByRole('button', { name: /新增/ }).first()
    let addVisible = false
    try {
      await addButton.waitFor({ state: 'visible', timeout: 30000 })
      addVisible = true
    } catch {}
    const pageRenderDurationMs = Date.now() - pageRenderStartedAt
    if (addVisible) await addButton.click()
    const openingButton = page.getByRole('button', { name: /选期初入库/ }).first()
    let openingButtonVisible = false
    if (addVisible) {
      try {
        await openingButton.waitFor({ state: 'visible', timeout: 30000 })
        openingButtonVisible = true
      } catch {}
    }
    caseRecord.checks.push({
      name: '采购发票表单提供期初入库来源入口',
      passed: addVisible && openingButtonVisible,
      details: `add=${addVisible}, openingSource=${openingButtonVisible}, pageRenderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '采购发票列表首屏渲染耗时不超过 5 秒',
      passed: pageRenderDurationMs <= 5000,
      details: `pageRenderMs=${pageRenderDurationMs}`
    })
    if (openingButtonVisible) {
      await openingButton.click()
      const dialogTitle = page.getByText('选择期初采购入库', { exact: true }).first()
      let dialogVisible = false
      try {
        await dialogTitle.waitFor({ state: 'visible', timeout: 30000 })
        dialogVisible = true
      } catch {}
      caseRecord.checks.push({
        name: '期初采购入库来源选择弹窗真实渲染',
        passed: dialogVisible,
        details: dialogVisible ? '弹窗已打开' : '未找到期初入库选择弹窗'
      })
      if (dialogVisible) {
        const dialogText = await page.locator('.el-dialog:visible').last().innerText()
        caseRecord.checks.push({
          name: '期初采购入库来源弹窗展示本次开票数量字段',
          passed: /本次开票数量|开票数量/.test(dialogText),
          details: dialogText.slice(0, 500)
        })
      }
    }
    await saveScreenshot(page, outputDir, 'erp-purchase-opening-invoice-source', record)
    caseRecord.evidence.push('真实登录、期初采购入库分页字段检查、采购发票入口和来源弹窗截图')
    const env = dependencies.env || process.env
    if (env.CFOR_E2E_WRITE_FIXTURES === 'true') {
      if (config.target !== 'local') {
        throw new Error('BLOCKED: PROC-011 写侧验收仅允许 local target')
      }
      if (!databaseConfigured()) {
        throw new Error('BLOCKED: PROC-011 写侧验收需要配置本地数据库只读证据，尚未创建期初发票')
      }
      await assertLocalWriteSafety(caseRecord)
      const write = await createOpeningInvoiceWriteFixture(api, caseRecord)
      caseRecord.checks.push({
        name: 'PROC-011 已审核期初采购入库可开票但不进入 WMS 库存',
        passed:
          Number(write.opening?.status) === 20 &&
          Number(write.openingAfter?.invoicedCount) === 6 &&
          Number(write.openingAfter?.invoicedPrice) === 60 &&
          Number(write.beforeInventory) === Number(write.afterInventory),
        details: `purchaseInId=${write.purchaseInId}; invoiced=${write.openingAfter?.invoicedCount}/` +
          `${write.openingAfter?.invoicedPrice}; inventory=${write.beforeInventory}->${write.afterInventory}`
      })
      caseRecord.checks.push({
        name: 'PROC-011 期初来源数量和金额上限均返回业务拒绝',
        passed:
          write.overflowCount?.code !== 0 &&
          write.overflowMoney?.code !== 0 &&
          write.pendingDuplicate?.code !== 0,
        details: `countCode=${write.overflowCount?.code}; moneyCode=${write.overflowMoney?.code}; ` +
          `duplicateCode=${write.pendingDuplicate?.code}`
      })
      caseRecord.checks.push({
        name: 'PROC-011 采购发票保存并回读期初来源、数量金额与开票状态',
        passed:
          String(write.invoice?.srcBillType) === 'OPENING_PURCHASE_IN' &&
          String(write.invoice?.srcBillId) === write.purchaseInId &&
          String(write.invoice?.details || '').includes(write.purchaseInId) &&
          Number(write.openingAfter?.invoicedCount) === 6 &&
          Number(write.openingAfter?.invoicedPrice) === 60,
        details: `invoiceId=${write.invoiceId}; src=${write.invoice?.srcBillType}/${write.invoice?.srcBillId}`
      })
      procurementCatalogEvidence('PROC-011', caseRecord, {
        0: ['PROC-011 已审核期初采购入库可开票但不进入 WMS 库存'],
        1: [
          '期初采购入库来源分页只返回已审核期初单',
          '期初采购入库返回开票数量和金额控制字段',
          'PROC-011 期初来源数量和金额上限均返回业务拒绝'
        ],
        2: [
          '采购发票表单提供期初入库来源入口',
          '期初采购入库来源弹窗展示本次开票数量字段'
        ],
        3: ['PROC-011 采购发票保存并回读期初来源、数量金额与开票状态']
      })
      return { token, api, partial: !caseRecord.passCandidate }
    }
    procurementCatalogEvidence('PROC-011', caseRecord, {
      0: { gap: '未启用本地写侧夹具，不能证明期初入库实际可作为发票来源且不入 WMS' },
      1: ['期初采购入库返回开票数量和金额控制字段'],
      2: ['采购发票表单提供期初入库来源入口', '期初采购入库来源弹窗展示本次开票数量字段'],
      3: { gap: '未执行 purchaseInId/srcBillType/invoiceCountItem/invoiceMoneyItem 真实保存' }
    })
    return { token, api, partial: true,
      note: '只读来源与表单入口已检查，未选择专属来源、核对本次数量金额或保存 purchaseInId/srcBillType 映射' }
  }

  if (caseId === 'PROC-012') {
    if (!databaseConfigured()) {
      throw new Error('BLOCKED: PROC-012 写侧验收需要配置本地数据库只读证据，尚未创建价格方案')
    }
    await assertLocalWriteSafety(caseRecord)
    const token = await login(page)
    const api = createApiClient({ token, record })
    const snapshot = await createPurchasePriceSnapshotFixture(api, caseRecord)
    const pageResult = await api.getBusiness(
      '/erp/price-scheme/page?pageNo=1&pageSize=100&priceDirection=PURCHASE'
    )
    const rows = Array.isArray(pageResult?.data?.list) ? pageResult.data.list : []
    const createdScheme = rows.find((row) => String(row.id) === snapshot.fixture.schemeId)
    caseRecord.checks.push({
      name: '统一价格中心 PURCHASE 分页包含本轮专属方案且不含 SALE 方案',
      passed:
        Array.isArray(pageResult?.data?.list) &&
        rows.every((row) => row.priceDirection === 'PURCHASE') &&
        createdScheme?.code === snapshot.fixture.code &&
        Number(createdScheme?.status) === 1,
      details: `schemeId=${snapshot.fixture.schemeId}, purchaseSchemes=${rows.length}`
    })
    caseRecord.checks.push({
      name: '专属价格方案、版本、规则、命中依据与计算时间已落库并回读一致',
      passed:
        snapshot.item.priceSchemeCode === snapshot.fixture.code &&
        Number(snapshot.item.priceVersionNo) === 1 &&
        snapshot.item.priceHitSource === 'PARTNER' &&
        Boolean(snapshot.item.priceCalculatedAt),
      details: `orderId=${snapshot.fixture.orderId}, itemId=${snapshot.item.id}, ` +
        `versionId=${snapshot.item.priceVersionId}, ruleId=${snapshot.item.priceRuleId}`
    })
    await openRoute(page, '/settings/erp/price-center')
    const directionField = page.locator('.el-form-item').filter({ hasText: '价格方向' }).first()
    await directionField.waitFor({ state: 'visible', timeout: 30000 })
    const directionSelect = directionField.locator('.el-select').first()
    await directionSelect.click()
    const purchaseOption = page.getByText('采购价格', { exact: true }).last()
    await purchaseOption.waitFor({ state: 'visible', timeout: 30000 })
    const purchaseOptionVisible = await purchaseOption.isVisible()
    await page.keyboard.press('Escape')
    const inquiryButton = page.getByRole('button', { name: '统一取价', exact: true }).first()
    await inquiryButton.waitFor({ state: 'visible', timeout: 30000 })
    caseRecord.checks.push({
      name: '统一价格中心页面提供采购方向和取价入口',
      passed:
        page.url().includes('/settings/erp/price-center') &&
        purchaseOptionVisible &&
        (await inquiryButton.isVisible()),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-price-center', record)
    caseRecord.evidence.push(
      `真实登录、专属 PURCHASE 方案 ${snapshot.fixture.schemeId}、版本 ${snapshot.fixture.versionId}、` +
      `规则 ${snapshot.fixture.ruleId}、采购订单 ${snapshot.fixture.orderId}、` +
      '订单行快照、数据库四表回读和价格中心页面截图'
    )
    return { token, api }
  }

  if (caseId === 'PROC-013') {
    const token = await (dependencies.login || login)(page)
    const api = (dependencies.createApiClient || createApiClient)({ token, record })
    const summary = await api.getBusiness('/erp/purchase/workbench/summary')
    const data = summary?.data || {}
    const expectedFields = [
      'pendingRequestCount',
      'pendingOrderCount',
      'pendingPortalAcceptanceCount',
      'pendingReceiptCount',
      'pendingReconciliationCount',
      'pendingInvoiceReviewCount',
      'pendingPaymentRequestCount'
    ]
    caseRecord.checks.push({
      name: '企业侧采购工作台摘要返回 7 项非负整数待办',
      passed:
        summary?.code === 0 &&
        expectedFields.every((field) => Object.prototype.hasOwnProperty.call(data, field)) &&
        expectedFields.every((field) => Number.isInteger(data[field]) && data[field] >= 0),
      details: JSON.stringify(data)
    })

    const titles = ['待审请购', '待审订单', '待接单', '待收货', '待对账', '待开票复核', '待付款']
    const pageRenderStartedAt = Date.now()
    const [browserSummaryResponse] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname.endsWith('/erp/purchase/workbench/summary') &&
          response.request().method() === 'GET',
        { timeout: 30000 }
      ),
      (dependencies.openRoute || openRoute)(page, '/erp/purchase/home')
    ])
    const browserSummary = await readBrowserBusinessResponse(browserSummaryResponse)
    if (browserSummary.code !== 0 ||
        !expectedFields.every((field) => Number.isInteger(browserSummary.data?.[field]) &&
          browserSummary.data[field] >= 0)) {
      throw new Error('采购工作台浏览器摘要响应未返回完整有效的待办数据')
    }
    const workbench = page.locator('.p_workbench').first()
    await workbench.waitFor({ state: 'visible', timeout: 60000 })
    await page.locator('.p_workbench_card').nth(titles.length - 1).waitFor({
      state: 'visible',
      timeout: 60000
    })
    await page.waitForFunction(
      (expected) => {
        const values = [...document.querySelectorAll('.p_workbench_card .p_workbench_value')]
        return values.length === expected.length &&
          values.every((element, index) => element.textContent.trim() === String(expected[index]))
      },
      expectedFields.map((field) => browserSummary.data[field]),
      { timeout: 30000 }
    )
    const pageRenderDurationMs = Date.now() - pageRenderStartedAt
    caseRecord.performance = await (dependencies.collectPagePerformance || collectPagePerformance)(
      page, pageRenderDurationMs)
    const renderedCardValues = await page.locator('.p_workbench_card .p_workbench_value').allInnerTexts()
    caseRecord.checks.push({
      name: '7 张待办卡片显示浏览器真实摘要响应的数值，不以默认零值结案',
      passed: renderedCardValues.length === expectedFields.length &&
        renderedCardValues.every((value, index) =>
          value.trim() === String(browserSummary.data[expectedFields[index]])),
      details: JSON.stringify({ summary: browserSummary.data, renderedCardValues })
    })
    const renderedCards = await page.locator('.p_workbench_card').allInnerTexts()
    const visibleTitles = titles.filter((title, index) => renderedCards[index]?.includes(title))
    caseRecord.checks.push({
      name: '采购工作台首页渲染 7 张待办卡片',
      passed: renderedCards.length === titles.length && visibleTitles.length === titles.length,
      details: `visible=${visibleTitles.join(',')}, renderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '采购工作台首屏渲染耗时不超过 5 秒',
      passed: pageRenderDurationMs <= 5000,
      details: `renderMs=${pageRenderDurationMs}`
    })
    await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, 'erp-purchase-workbench-summary', record)
    const supplierFilter = page.locator('.cardBox .paramsBox .el-select')
    await supplierFilter.scrollIntoViewIfNeeded()
    await supplierFilter.click()
    await page.locator('.el-select-dropdown:visible').last().waitFor({ state: 'visible' })
    caseRecord.checks.push({
      name: '采购跟踪供应商筛选异步加载后可首次打开',
      passed: true,
      details: '只打开筛选，不修改单据'
    })
    await page.keyboard.press('Escape')

    const acceptanceCard = page.locator('.p_workbench_card').filter({ hasText: '待接单' }).first()
    const cardVisible = await acceptanceCard.isVisible().catch(() => false)
    const acceptanceResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/purchase-order/page') &&
          url.searchParams.get('portalStatus') === 'SENT' &&
          response.request().method() === 'GET'
      },
      { timeout: 30000 }
    )
    await acceptanceCard.click()
    await page.waitForURL(/\/erp\/purchase\/order(?:\?.*)?$/, { timeout: 30000 })
    const acceptanceResponse = await acceptanceResponsePromise
    const acceptanceResult = await readBrowserBusinessResponse(acceptanceResponse)
    const acceptanceRows = acceptanceResult?.data?.list
    const portalField = page.locator('.el-form-item').filter({ hasText: '门户状态' }).first()
    await portalField.waitFor({ state: 'visible', timeout: 30000 })
    caseRecord.checks.push({
      name: '待接单下钻请求真实携带 SENT 且页面显示筛选条件',
      passed: cardVisible && page.url().includes('portalStatus=SENT') &&
        (await portalField.innerText()).includes('待接单') &&
        acceptanceResult?.code === 0 && Array.isArray(acceptanceRows) &&
        acceptanceRows.every((row) => row.portalStatus === 'SENT'),
      details: `url=${page.url()}, responseCode=${acceptanceResult?.code}, orders=${acceptanceRows?.length ?? 'invalid'}`
    })
    await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, 'erp-purchase-workbench-acceptance-filter', record)

    const resetResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/purchase-order/page') &&
          !url.searchParams.has('portalStatus') &&
          response.request().method() === 'GET'
      },
      { timeout: 30000 }
    )
    await page.getByRole('button', { name: '重置', exact: true }).click()
    const resetResult = await readBrowserBusinessResponse(await resetResponsePromise)
    caseRecord.checks.push({
      name: '重置后清除门户筛选并重新查询全部订单',
      passed: resetResult?.code === 0 &&
        !(await portalField.innerText()).includes('待接单'),
      details: `responseCode=${resetResult?.code}, orders=${resetResult?.data?.list?.length ?? 'invalid'}`
    })
    caseRecord.evidence.push(
      '真实登录、7 项摘要及页面数值一致、首次数据就绪计时、SENT 查询请求/响应、门户筛选可见与重置请求、截图'
    )
    procurementCatalogEvidence('PROC-013', caseRecord, {
      0: ['企业侧采购工作台摘要返回 7 项非负整数待办'],
      1: ['采购工作台首页渲染 7 张待办卡片',
        '7 张待办卡片显示浏览器真实摘要响应的数值，不以默认零值结案'],
      2: ['待接单下钻请求真实携带 SENT 且页面显示筛选条件',
        '重置后清除门户筛选并重新查询全部订单']
    })
    return { token, api, partial: !caseRecord.passCandidate }
  }

  if (caseId === 'PROC-014') {
    if (!databaseConfigured()) {
      throw new Error('BLOCKED: PROC-014 写侧验收需要配置本地数据库只读证据，尚未创建测试单据')
    }
    await assertLocalWriteSafety(caseRecord)
    const token = await login(page)
    const api = createApiClient({ token, record })
    const fixture = await createPurchaseRequest(api, caseRecord)
    const before = await snapshotPurchaseRequest(fixture, caseRecord, 'before-close')
    caseRecord.checks.push({
      name: '来源未传行号时后端补齐唯一行号并成功创建两行',
      passed: before.filter((row) => row[0] === 'item').length === 2 &&
        before.filter((row) => row[0] === 'item').every((row) =>
          Number.isInteger(Number(row[6])) && Number(row[6]) > 0) &&
        new Set(before.filter((row) => row[0] === 'item').map((row) => Number(row[6]))).size === 2,
      details: `entryNumbers=${before.filter((row) => row[0] === 'item').map((row) => row[6]).join(',')}`
    })
    caseRecord.checks.push({
      name: '真实创建两行请购，数量 3+5、主表及分录未关闭',
      passed: fixture.initial.itemsList?.length === 2 &&
        Number(fixture.initial.isClosed) === 0 &&
        fixture.initial.itemsList.every((item) => Number(item.isClosed) === 0) &&
        before.filter((row) => row[0] === 'item').length === 2 &&
        Number(before.find((row) => row[0] === 'bill')?.[4]) === 8,
      details: `requestId=${fixture.id}, billNo=${fixture.billNo}`
    })
    if (process.env.CFOR_E2E_WRITE_FIXTURES === 'true') {
      const initialRequest = await fixture.read()
      const isolation = await verifyProcurementTenantIsolation({
        context: { page, record }, api, tenant1Fixture: fixture
      })
      const afterIsolation = await fixture.read()
      const afterIsolationSnapshot = await snapshotPurchaseRequest(
        fixture, caseRecord, 'after-tenant-isolation-probe'
      )
      caseRecord.checks.push({
        name: '真实第二租户详情与分页不可见且源请购完整原值不变',
        passed: isolation.hidden === true && isolation.pageHidden === true &&
          JSON.stringify(afterIsolation) === JSON.stringify(initialRequest) &&
          JSON.stringify(afterIsolationSnapshot) === JSON.stringify(before),
        details: `tenantId=${isolation.tenantId}, requestId=${fixture.id}, detailCode=${isolation.detailCode}, pageRows=${isolation.pageRowCount}`
      })
      caseRecord.evidence.push(
        `第二租户 ${isolation.tenantId} 的真实登录、请购 GET/分页隔离、源单据 API/SQL 全量原值及退出停用`
      )
    }
    await approvePurchaseRequestForClosure({ api, fixture, caseRecord, record })
    const renderStartedAt = Date.now()
    await openRoute(page, '/erp/purchase/purchaseRequest')
    await page.locator('.request-status-tabs').waitFor({ state: 'visible', timeout: 60000 })
    // Fixed VXE columns include hidden duplicate headers.
    await page.locator('.vxe-cell--title:visible').filter({ hasText: /^行关闭$/ }).first().waitFor({
      state: 'visible',
      timeout: 60000
    })
    const renderMs = Date.now() - renderStartedAt
    const bodyText = await page.locator('.request-status-tabs').innerText()
    const tabs = ['全部', '编制中', '编制完', '核批中', '核批完', '已关闭']
    const visibleTabs = tabs.filter((label) => bodyText.includes(label))
    caseRecord.checks.push({
      name: '请购单列表渲染状态快捷查询标签',
      passed: visibleTabs.length === tabs.length,
      details: `visible=${visibleTabs.join(',')}, renderMs=${renderMs}`
    })
    const waitForList = (closedOnly = false) => page.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/purchase/order/request/page') &&
          url.searchParams.get('billNo') === fixture.billNo &&
          (!closedOnly || url.searchParams.get('isClosed') === '1')
      },
      { timeout: 30000 }
    )
    await page.getByPlaceholder('请输入请购单号').fill(fixture.billNo)
    const [searchResponse] = await Promise.all([
      waitForList(),
      page.getByRole('button', { name: '搜索', exact: true }).click()
    ])
    const filtered = await readBrowserBusinessResponse(searchResponse)
    caseRecord.checks.push({
      name: '页面按测试单号查询真实两行单据，不依赖空列表',
      passed: filtered.code === 0 && filtered.data.records?.length === 1 &&
        filtered.data.records[0].itemsList?.length === 2,
      details: `billNo=${fixture.billNo}`
    })
    const closeVisibleLine = async () => {
      const [browserResponse] = await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname.endsWith('/erp/purchase/order/request/close-items'),
          { timeout: 30000 }
        ),
        (async () => {
          await page.locator('button:visible').filter({ hasText: /^\s*关闭本行\s*$/ }).first().click()
          const confirmation = page.locator('.el-message-box:visible')
          await confirmation.getByRole('button', { name: /确定|确认/ }).click()
        })()
      ])
      const response = await readBrowserBusinessResponse(browserResponse)
      if (response.code !== 0) throw new Error(`页面行关闭失败：${JSON.stringify(response)}`)
      return fixture.read()
    }
    const afterOne = await closeVisibleLine()
    const firstClosed = afterOne.itemsList.find((item) => Number(item.isClosed) === 1)
    caseRecord.checks.push({
      name: 'Chrome 关闭第一行后仅该行关闭，主表保持打开',
      passed: afterOne.itemsList.filter((item) => Number(item.isClosed) === 1).length === 1 &&
        Number(afterOne.isClosed) === 0,
      details: `closedItemId=${firstClosed?.id}`
    })
    if (!firstClosed) throw new Error('首行关闭后未回读到已关闭分录')
    await snapshotPurchaseRequest(fixture, caseRecord, 'after-first-line')
    const firstLineSourceOrdersBefore = await runReadOnlySql(`
      SELECT COUNT(*) FROM erp_purchase_order_items
      WHERE src_entry_id = '${firstClosed.id}' AND deleted = 0
    `)
    const rejectedOrder = await api.put(
      `/erp/purchase/order/request/place/an/order?ids=${firstClosed.id}&isSeparate=0`,
      undefined,
      {
        expectedBusinessRejection: {
          code: 500,
          message: /存在已关闭的请购分录，无法生成采购订单/,
          allowServiceCode: true
        }
      }
    )
    const afterRejectedOrder = await fixture.read()
    const afterRejectedSnapshot = await snapshotPurchaseRequest(
      fixture, caseRecord, 'after-approved-closed-line-order-rejection'
    )
    const firstLineSourceOrdersAfter = await runReadOnlySql(`
      SELECT COUNT(*) FROM erp_purchase_order_items
      WHERE src_entry_id = '${firstClosed.id}' AND deleted = 0
    `)
    caseRecord.checks.push({
      name: '已审核且仅一行关闭的请购正式下单被关闭分录门禁拒绝，数据不变',
      passed: rejectedOrder.code === 500 &&
        String(rejectedOrder.msg).includes('存在已关闭的请购分录') &&
        JSON.stringify(afterRejectedOrder) === JSON.stringify(afterOne) &&
        firstLineSourceOrdersBefore.available && firstLineSourceOrdersAfter.available &&
        JSON.stringify(firstLineSourceOrdersBefore.rows) === JSON.stringify(firstLineSourceOrdersAfter.rows) &&
        JSON.stringify(afterRejectedSnapshot) === JSON.stringify(
          caseRecord.database.findLast((entry) => entry.stage === 'after-first-line')?.rows
        ),
      details: `code=${rejectedOrder.code}, msg=${rejectedOrder.msg}, sourceOrdersBefore=${firstLineSourceOrdersBefore.rows?.[0]?.[0]}, sourceOrdersAfter=${firstLineSourceOrdersAfter.rows?.[0]?.[0]}`
    })
    // Wait for the list reload after closing before clicking the remaining row.
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].filter(
        (button) => button.textContent.trim() === '关闭本行' && button.getClientRects().length
      ).length === 1
    )
    await saveScreenshot(page, outputDir, 'erp-purchase-request-one-line-closed', record)
    const afterAll = await closeVisibleLine()
    caseRecord.checks.push({
      name: 'Chrome 关闭剩余行后全部分录关闭，数量不变',
      passed: afterAll.itemsList.length === 2 &&
        afterAll.itemsList.every((item) => Number(item.isClosed) === 1) &&
        afterAll.itemsList.reduce((sum, item) => sum + Number(item.inCount), 0) === 8,
      details: `requestId=${fixture.id}`
    })
    caseRecord.checks.push({
      name: '全部分录关闭时主表由打开同步转为关闭',
      passed: Number(afterOne.isClosed) === 0 && Number(afterAll.isClosed) === 1,
      details: `before=${afterOne.isClosed}, after=${afterAll.isClosed}`
    })
    const beforeRepeatedClose = await snapshotPurchaseRequest(
      fixture, caseRecord, 'before-repeat-whole-close'
    )
    const repeated = await api.put(`/erp/purchase/order/request/close?id=${fixture.id}`, undefined, {
      expectedBusinessRejection: {
        code: 500,
        message: /请购单已关闭，请勿重复操作/,
        allowServiceCode: true
      }
    })
    const afterRepeatedClose = await fixture.read()
    const after = await snapshotPurchaseRequest(fixture, caseRecord, 'after-all-lines')
    caseRecord.checks.push({
      name: '两次页面行关闭的审计均持久化为关闭类型',
      passed: after.filter((row) => row[0] === 'audit' && row[2] === '关闭').length === 2,
      details: `requestId=${fixture.id}`
    })
    caseRecord.checks.push({
      name: '整单重复关闭明确拒绝，既有下单标志、数量及审计不变',
      passed: repeated.code === 500 && String(repeated.msg).includes('请购单已关闭，请勿重复操作') &&
        JSON.stringify(afterRepeatedClose) === JSON.stringify(afterAll) &&
        JSON.stringify(after) === JSON.stringify(beforeRepeatedClose),
      details: `code=${repeated.code}, msg=${repeated.msg}, isPlaceOrderBefore=${afterAll.isPlaceOrder}, isPlaceOrderAfter=${afterRepeatedClose.isPlaceOrder}`
    })
    const [closedQuery] = await Promise.all([
      waitForList(true),
      page.locator('.request-status-tabs').getByText('已关闭', { exact: true }).click()
    ])
    const closedList = await readBrowserBusinessResponse(closedQuery)
    caseRecord.checks.push({
      name: '已关闭快捷标签真实请求 isClosed=1 并回读测试单据',
      passed: closedList.code === 0 && closedList.data.records?.some(
        (row) => String(row.id) === fixture.id && Number(row.isClosed) === 1
      ),
      details: `requestId=${fixture.id}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-request-status-tabs', record)
    caseRecord.evidence.push(
      `真实 admin Chrome 登录、两行请购 ${fixture.id}、页面逐行关闭、主表联动、下单阻断、` +
      '重复关闭响应、状态查询、数据库前后值和截图'
    )
    const wholeFixture = await createPurchaseRequest(api, caseRecord)
    const wholeBefore = await snapshotPurchaseRequest(wholeFixture, caseRecord, 'before-whole-close')
    caseRecord.checks.push({
      name: '整单关闭专用请购初始为待提审、未生效、主表和两行均打开',
      passed: wholeFixture.initial.billStage === '14' &&
        Number(wholeFixture.initial.isEffective) === 0 &&
        Number(wholeFixture.initial.isClosed) === 0 &&
        wholeFixture.initial.itemsList.length === 2 &&
        wholeFixture.initial.itemsList.every((item) => Number(item.isClosed) === 0) &&
        Number(wholeBefore.find((row) => row[0] === 'bill')?.[4]) === 8,
      details: `requestId=${wholeFixture.id}, billStage=${wholeFixture.initial.billStage}`
    })
    await page.locator('.request-status-tabs').getByText('全部', { exact: true }).click()
    await page.getByPlaceholder('请输入请购单号').fill(wholeFixture.billNo)
    await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/purchase/order/request/page') &&
          url.searchParams.get('billNo') === wholeFixture.billNo
      }),
      page.getByRole('button', { name: '搜索', exact: true }).click()
    ])
    const [wholeCloseResponse] = await Promise.all([
      page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/erp/purchase/order/request/close')),
      (async () => {
        await page.locator('.vxe-table--fixed-right-wrapper')
          .getByRole('button', { name: '整单关闭', exact: true }).first().click()
        await page.locator('.el-message-box:visible').getByRole('button', {
          name: /确定|确认/
        }).click()
      })()
    ])
    const wholeClose = await readBrowserBusinessResponse(wholeCloseResponse)
    const wholeAfter = await wholeFixture.read()
    const wholeSnapshot = await snapshotPurchaseRequest(wholeFixture, caseRecord, 'after-whole-close')
    caseRecord.checks.push({
      name: 'Chrome 主动整单关闭后同步关闭两行，数量和下单标志不变',
      passed: wholeClose.code === 0 && Number(wholeAfter.isClosed) === 1 &&
        wholeAfter.itemsList.length === 2 &&
        wholeAfter.itemsList.every((item) => Number(item.isClosed) === 1) &&
        Number(wholeSnapshot.find((row) => row[0] === 'bill')?.[3]) === 0 &&
        Number(wholeSnapshot.find((row) => row[0] === 'bill')?.[4]) === 8 &&
        wholeSnapshot.filter((row) => row[0] === 'item').every((row) =>
          Number(row[2]) === 1 && Number(row[4]) === 0),
      details: `requestId=${wholeFixture.id}, code=${wholeClose.code}`
    })
    caseRecord.checks.push({
      name: '主动整单关闭的审计持久化且类型正确',
      passed: wholeSnapshot.filter((row) => row[0] === 'audit' && row[2] === '关闭').length === 1,
      details: `requestId=${wholeFixture.id}`
    })
    const wholeItem = wholeAfter.itemsList[0]
    const wholeOrderProbe = await api.put(
      `/erp/purchase/order/request/place/an/order?ids=${wholeItem.id}&isSeparate=0`,
      undefined,
      {
        expectedBusinessRejection: {
          code: 500,
          message: /请购单已关闭，无法生成采购订单/,
          allowServiceCode: true
        }
      }
    )
    const wholeRepeated = await api.put(
      `/erp/purchase/order/request/close?id=${wholeFixture.id}`,
      undefined,
      {
        expectedBusinessRejection: {
          code: 500,
          message: /请购单已关闭，请勿重复操作/,
          allowServiceCode: true
        }
      }
    )
    const wholeReverseSnapshot = await snapshotPurchaseRequest(
      wholeFixture, caseRecord, 'after-whole-close-reverse-probes'
    )
    const wholeSourceOrders = await runReadOnlySql(`
      SELECT COUNT(*) FROM erp_purchase_order_items
      WHERE src_bill_id = '${wholeFixture.id}' AND deleted = 0
    `)
    caseRecord.checks.push({
      name: '主动整单关闭后下单与重复关闭明确拒绝，数据库不变且未生成来源订单',
      passed: wholeOrderProbe.code !== 0 && String(wholeOrderProbe.msg).includes('请购单已关闭') &&
        wholeRepeated.code !== 0 && String(wholeRepeated.msg).includes('已关闭') &&
        JSON.stringify(wholeReverseSnapshot) === JSON.stringify(wholeSnapshot) &&
        wholeSourceOrders.available && Number(wholeSourceOrders.rows[0]?.[0]) === 0,
      details: `orderCode=${wholeOrderProbe.code}, orderMsg=${wholeOrderProbe.msg}, repeatCode=${wholeRepeated.code}`
    })
    caseRecord.evidence.push(`整单主动关闭 ${wholeFixture.id} 的真实 Chrome 操作、两行回读、关闭审计与反向阻断`)
    const reader = await createPurchaseReader(api, caseRecord)
    let readerBrowser
    let readerApi
    let readerFailure
    try {
      const readerFixture = await createPurchaseRequest(api, caseRecord)
      const readerBefore = await snapshotPurchaseRequest(readerFixture, caseRecord, 'before-reader-probe')
      readerBrowser = await launchBrowser({ record })
      const readerToken = await loginWithCredentials(readerBrowser.page, reader.credentials)
      readerApi = createApiClient({ token: readerToken, record })
      const permissionInfo = (await readerApi.getBusiness('/system/auth/get-permission-info')).data
      caseRecord.checks.push({
        name: '隔离 Chrome 关联账号仅有请购查询权限，不具有管理员或写权限',
        passed: permissionInfo.user?.username === reader.username &&
          permissionInfo.permissions.includes('erp:purchase-order-request:query') &&
          !permissionInfo.permissions.includes('*:*:*') &&
          !permissionInfo.permissions.some((value) => /:(create|update|delete)$/.test(value)),
        details: `username=${reader.username}, permissions=${JSON.stringify(permissionInfo.permissions)}`
      })
      await openRoute(readerBrowser.page, '/erp/purchase/purchaseRequest')
      await readerBrowser.page.locator('.request-status-tabs').waitFor({ state: 'visible' })
      await readerBrowser.page.getByPlaceholder('请输入请购单号').fill(readerFixture.billNo)
      await Promise.all([
        readerBrowser.page.waitForResponse(
          (response) => new URL(response.url()).pathname.endsWith('/erp/purchase/order/request/page') &&
            new URL(response.url()).searchParams.get('billNo') === readerFixture.billNo
        ),
        readerBrowser.page.getByRole('button', { name: '搜索', exact: true }).click()
      ])
      await readerBrowser.page.locator('button:visible').filter({
        hasText: readerFixture.billNo
      }).first().waitFor({ state: 'visible' })
      const writeButtons = await readerBrowser.page.locator('button:visible').filter({
        hasText: /^\s*(关闭本行|整单关闭)\s*$/
      }).count()
      caseRecord.checks.push({
        name: '只读关联账号页面不提供关闭写操作',
        passed: writeButtons === 0,
        details: `visibleCloseButtons=${writeButtons}`
      })
      await saveScreenshot(readerBrowser.page, outputDir, 'erp-purchase-request-readonly-account', record)
      const readerItem = readerFixture.initial.itemsList.find((item) => Number(item.isClosed) === 0)
      if (!readerItem?.id) throw new Error('只读权限反例缺少可关闭的专用测试分录')
      const forbiddenClose = await readerApi.put(
        `/erp/purchase/order/request/close-items?ids=${readerItem.id}`
      )
      const readerAfter = await snapshotPurchaseRequest(readerFixture, caseRecord, 'after-reader-probe')
      caseRecord.checks.push({
        name: '只读关联账号不能通过直接请求关闭测试请购分录，数据库不变',
        passed: forbiddenClose.code === 403 &&
          JSON.stringify(readerAfter) === JSON.stringify(readerBefore),
        details: `username=${reader.username}, requestId=${readerFixture.id}, itemId=${readerItem.id}, code=${forbiddenClose.code}`
      })
      caseRecord.evidence.push(
        `关联只读账号 ${reader.username}、独立 Chrome 登录、页面写入口和直接关闭接口权限取证`
      )
    } catch (error) {
      readerFailure = error
    } finally {
      try {
        await closeProcurementReaderSession({ browser: readerBrowser, readerApi, reader })
        caseRecord.notes.push(`已停用本轮关联测试账号 ${reader.username}，保留角色和审计证据`)
      } catch (error) {
        readerFailure = readerFailure
          ? new AggregateError([readerFailure, error], `${readerFailure.message}；${error.message}`)
          : error
      }
    }
    if (readerFailure) throw readerFailure
    procurementCatalogEvidence('PROC-014', caseRecord, {
      0: ['真实创建两行请购，数量 3+5、主表及分录未关闭'],
      1: [
        'Chrome 关闭第一行后仅该行关闭，主表保持打开',
        'Chrome 关闭剩余行后全部分录关闭，数量不变',
        '全部分录关闭时主表由打开同步转为关闭'
      ],
      2: {
        checks: ['已审核且仅一行关闭的请购正式下单被关闭分录门禁拒绝，数据不变']
      },
      3: ['整单重复关闭明确拒绝，既有下单标志、数量及审计不变'],
      4: ['请购单列表渲染状态快捷查询标签'],
      5: ['已关闭快捷标签真实请求 isClosed=1 并回读测试单据'],
      6: [
        '来源未传行号时后端补齐唯一行号并成功创建两行',
        '两次页面行关闭的审计均持久化为关闭类型'
      ],
      7: ['来源未传行号时后端补齐唯一行号并成功创建两行'],
      8: [
        '隔离 Chrome 关联账号仅有请购查询权限，不具有管理员或写权限',
        '只读关联账号页面不提供关闭写操作',
        '只读关联账号不能通过直接请求关闭测试请购分录，数据库不变'
      ],
      9: ['Chrome 主动整单关闭后同步关闭两行，数量和下单标志不变'],
      10: [
        '主动整单关闭的审计持久化且类型正确',
        '主动整单关闭后下单与重复关闭明确拒绝，数据库不变且未生成来源订单'
      ]
    })
    const organizationGate = procurementOrganizationGateStatus()
    const organizationGap = `跨租户/组织矩阵未补齐前保持 PARTIAL：${organizationGate.reason}`
    caseRecord.remainingAssertions.push(organizationGap)
    caseRecord.passCandidate = false
    caseRecord.notes.push(`GAP: ${organizationGap}`)
    return {
      token, api, notImplemented: true,
      note: '已执行行关闭、整单主动关闭、关闭后下单/重复关闭阻断及只读账号取证；启用专属夹具时追加真实跨租户只读隔离，组织矩阵仍待补验'
    }
  }

  if (caseId === 'PROC-015') {
    if (!databaseConfigured()) {
      throw new Error('BLOCKED: PROC-015 写侧验收需要配置本地数据库只读证据，尚未创建变更审计')
    }
    await assertLocalWriteSafety(caseRecord)
    const token = await login(page)
    const api = createApiClient({ token, record })
    const pageResult = await api.getBusiness('/erp/purchase-order/page?pageNo=1&pageSize=20')
    const rows = Array.isArray(pageResult?.data?.list) ? pageResult.data.list : []
    caseRecord.checks.push({
      name: '采购订单分页返回状态快捷标签与门户协同字段',
      passed:
        Array.isArray(pageResult?.data?.list) &&
        rows.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'billStage') &&
            Object.prototype.hasOwnProperty.call(row, 'isClosed') &&
            Object.prototype.hasOwnProperty.call(row, 'portalStatus')
        ),
      details: `orders=${rows.length}`
    })
    const supplierlessOrder = rows.find((row) => !String(row.supplierId || '').trim())
    if (supplierlessOrder) {
      const detail = (await api.getBusiness(
        `/erp/purchase-order/get?id=${encodeURIComponent(supplierlessOrder.id)}`
      )).data
      caseRecord.checks.push({
        name: '真实无供应商采购订单详情正常返回空供应商名称和明细',
        passed: String(detail?.id) === String(supplierlessOrder.id) &&
          detail?.supplierName === null && Array.isArray(detail?.items) && detail.items.length > 0,
        details: `orderId=${supplierlessOrder.id}, items=${detail?.items?.length ?? 0}`
      })
    } else {
      throw new Error('BLOCKED: 空供应商详情回归缺少真实无供应商采购订单，请先执行 PROC-018 转单前置')
    }

    const changeMissing = await api.put('/erp/purchase-order/change', {
      id: '__pb139_not_exists__',
      reason: 'PB-139 e2e negative contract',
      changes: [{ fieldName: 'remark', value: 'x' }]
    })
    caseRecord.checks.push({
      name: '采购订单变更接口存在且对不存在单据返回业务错误',
      passed: changeMissing?.code !== 0 && String(changeMissing?.msg || '').length > 0,
      details: `code=${changeMissing?.code}, msg=${changeMissing?.msg}`
    })

    const changeListMissing = await api.get(
      '/erp/purchase-order/change-list?orderId=__pb139_not_exists__'
    )
    caseRecord.checks.push({
      name: '采购订单变更记录查询接口存在且对不存在单据返回业务错误',
      passed: changeListMissing?.code !== 0 && String(changeListMissing?.msg || '').length > 0,
      details: `code=${changeListMissing?.code}, msg=${changeListMissing?.msg}`
    })

    const attachmentMissing = await api.put(
      '/erp/purchase-order/update-attachment?id=__pb139_not_exists__&fileUrl='
    )
    caseRecord.checks.push({
      name: '采购订单附件接口存在且对不存在单据返回业务错误',
      passed: attachmentMissing?.code !== 0 && String(attachmentMissing?.msg || '').length > 0,
      details: `code=${attachmentMissing?.code}, msg=${attachmentMissing?.msg}`
    })

    await openRoute(page, '/erp/purchase/order')
    await page.locator('.order-status-tabs').waitFor({ state: 'visible', timeout: 60000 })
    const orderRows = page.locator('.vxe-body--row')
    if (rows.length > 0) {
      await orderRows.first().waitFor({ state: 'visible', timeout: 60000 })
    } else {
      await page.getByText('暂无数据', { exact: true }).waitFor({
        state: 'visible',
        timeout: 60000
      })
    }
    const bodyText = await page.locator('body').innerText()
    const tabs = ['全部', '编制中', '编制完', '核批中', '核批完', '已关闭']
    const visibleTabs = tabs.filter((label) => bodyText.includes(label))
    caseRecord.checks.push({
      name: '采购订单列表渲染状态快捷查询标签',
      passed: visibleTabs.length === tabs.length,
      details: `visible=${visibleTabs.join(',')}`
    })
    let changeEntryVisible = false
    if (rows.length > 0) {
      const orderButton = page.getByRole('button', {
        name: String(supplierlessOrder.billNo), exact: true
      }).first()
      await orderButton.waitFor({ state: 'visible', timeout: 60000 })
      await orderButton.click()
      const changeButton = page.getByRole('button', { name: /变\s*更/ }).first()
      await changeButton.waitFor({ state: 'visible', timeout: 60000 })
      changeEntryVisible = await changeButton.isVisible()
      await page.getByRole('button', { name: '关 闭' }).first().click().catch(() => {})
    }
    caseRecord.checks.push({
      name: '采购订单详情提供变更入口',
      passed: rows.length > 0 && changeEntryVisible,
      details: rows.length > 0
        ? (changeEntryVisible ? '详情弹窗命中变更按钮' : '详情弹窗未找到变更按钮')
        : '当前租户没有采购订单，无法打开详情验收变更入口'
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-order-status-tabs', record)
    caseRecord.evidence.push(
      '真实登录、订单分页标签字段契约、变更/变更记录/附件接口负向契约、状态标签与变更入口截图'
    )

    // PB-139 real write side: create an isolated audited order, then exercise the
    // change / change-list / attachment chain and verify the audit in the database.
    const writer = await createPurchaseOrderChangeFixture(api, caseRecord)
    const auditFields = writer.auditRows.map((row) => row[0])
    caseRecord.checks.push({
      name: '专属直采采购订单创建即处于审核通过且变更前后状态稳定',
      passed:
        Number(writer.created?.status) === 20 &&
        Number(writer.changed?.status) === 20 &&
        Number(writer.changed?.isClosed) === 0 &&
        String(writer.audited?.id) === writer.orderId,
      details: `orderId=${writer.orderId}, created=${writer.created?.status}, afterChange=${writer.changed?.status}`
    })
    caseRecord.checks.push({
      name: '变更接口真实改写未执行行数量与单价并重算未税金额与合计数量',
      passed:
        writer.changedLineACount === 4 &&
        writer.changedLineAPrice === 60 &&
        writer.changedTotalProductPrice === 300 &&
        writer.changedTotalCount === 7 &&
        String(writer.changedLineB?.remark) === `PROC-015 changed line B ${writer.tag}`,
      details: `lineA count=${writer.changedLineACount}, price=${writer.changedLineAPrice}, totalProductPrice=${writer.changedTotalProductPrice}, totalCount=${writer.changedTotalCount}`
    })
    caseRecord.checks.push({
      name: '变更不改变单据状态机，表头备注按专属值落库',
      passed:
        Number(writer.changed?.isClosed) === 0 &&
        Number(writer.changed?.status) === 20 &&
        String(writer.changed?.remark) === `PROC-015 changed header ${writer.tag}` &&
        Number(writer.changed?.totalCount) === 7,
      details: `remark=${writer.changed?.remark}, totalCount=${writer.changed?.totalCount}`
    })
    caseRecord.checks.push({
      name: '变更记录接口返回四次字段级审计并携带原因与批次号',
      passed:
        Array.isArray(writer.history) &&
        writer.history.length === 4 &&
        writer.history.every((row) =>
          String(row.changeBatchNo) === writer.changeBatchNo &&
          String(row.reason) === `PROC-015 isolated change ${writer.tag}` &&
          String(row.operatorName || '').length > 0 &&
          Boolean(row.operateTime)) &&
        ['remark', 'count', 'productPrice'].every((field) =>
          writer.history.some((row) => row.fieldName === field)),
      details: `records=${writer.history?.length}, batch=${writer.changeBatchNo}`
    })
    caseRecord.checks.push({
      name: '数据库 erp_purchase_order_change 持久化专属字段级审计旧值与新值',
      passed:
        writer.auditRows.length === 4 &&
        auditFields.filter((field) => field === 'count').length === 1 &&
        auditFields.filter((field) => field === 'productPrice').length === 1 &&
        auditFields.filter((field) => field === 'remark').length === 2 &&
        writer.auditRows.some((row) =>
          row[0] === 'count' && Number(row[1]) === 2 && Number(row[2]) === 4 && row[5] === 'EFFECTIVE') &&
        writer.auditRows.some((row) =>
          row[0] === 'productPrice' && Number(row[1]) === 50 && Number(row[2]) === 60) &&
        writer.auditRows.every((row) =>
          row[3] === `PROC-015 isolated change ${writer.tag}` &&
          row[4] === writer.changeBatchNo),
      details: JSON.stringify(writer.auditRows).slice(0, 600)
    })
    caseRecord.checks.push({
      name: '专属订单附件地址真实写入并原样回读',
      passed:
        typeof writer.fileUrl === 'string' &&
        String(writer.attached?.fileUrl || '') === writer.fileUrl,
      details: `orderId=${writer.orderId}, fileUrl=${writer.attached?.fileUrl || ''}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-order-change-audit', record)
    caseRecord.evidence.push(
      `真实登录、专属采购订单 ${writer.orderId} 创建并审核、变更批次 ${writer.changeBatchNo}、` +
      '变更记录接口、变更后金额与状态回读、附件写入回读、数据库变更审计四行'
    )
    return { token, api }
  }

  if (caseId === 'PROC-016') {
    const token = await (dependencies.login || login)(page)
    const api = (dependencies.createApiClient || createApiClient)({ token, record })
    const env = dependencies.env || process.env
    const invoicePage = await api.getBusiness('/erp/purchase-invoice/page?pageNo=1&pageSize=20')
    let invoiceRows = []
    try {
      invoiceRows = procurement016TestHooks.requirePageRows(invoicePage, 'PROC-016 采购发票分页')
    } catch (error) {
      caseRecord.notes.push(`PROC-016 采购发票分页契约缺失：${error.message}`)
    }
    const readonlyFieldsPresent = invoiceRows.length > 0 && invoiceRows.every((row) =>
      ['srcBillType', 'srcBillId', 'details', 'isEffective']
        .every((field) => Object.prototype.hasOwnProperty.call(row, field)))
    if (env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
      caseRecord.checks.push({
        name: '采购发票分页返回来源、明细快照与生效字段',
        passed: readonlyFieldsPresent,
        details: `invoices=${invoiceRows.length}`
      })
    }

    if (env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
      const pageRenderStartedAt = Date.now()
      await (dependencies.openRoute || openRoute)(page, '/erp/purchase/invoice', { readyText: '采购发票' })
      const bodyText = await page.locator('body').innerText()
      const pageRendered = page.url().includes('/erp/purchase/invoice') && bodyText.includes('采购发票')
      caseRecord.checks.push({
        name: '采购发票页面基础渲染可见',
        passed: pageRendered,
        details: `${page.url()}, renderMs=${Date.now() - pageRenderStartedAt}; ` +
          '未启用写侧，专属发票唯一定位详情与审核入口仍由 catalog GAP 约束'
      })
      caseRecord.checks.push({
        name: '采购发票页面首屏渲染耗时不超过 5 秒',
        passed: pageRendered && Date.now() - pageRenderStartedAt <= 5000,
        details: `renderMs=${Date.now() - pageRenderStartedAt}`
      })
      caseRecord.notes.push('未启用 CFOR_E2E_WRITE_FIXTURES：不创建专属订单/发票/应付，历史防重复和专属详情页面证据保持 GAP')
      const surefire = readSurefireSummary(
        'cfor-module-erp/cfor-module-erp-biz/target/surefire-reports/' +
        'tech.cfor17.module.erp.service.fin.Impl.FinPayableServiceImplHistoricalPayableTest.txt'
      )
      const unitTestPassed = Boolean(surefire) &&
        /Tests run:\s*3,\s*Failures:\s*0,\s*Errors:\s*0,\s*Skipped:\s*0/.test(surefire.text)
      procurementCatalogEvidence('PROC-016', caseRecord, {
        0: readonlyFieldsPresent ? ['采购发票分页返回来源、明细快照与生效字段'] : { gap: '无有效发票字段样本' },
        1: { gap: '未启用专属写侧，不能以空集扫描替代三场景历史应付事实' },
        2: { gap: '未启用专属写侧，无法按专属发票唯一定位详情与复核入口' },
        3: unitTestPassed ? { gap: `已有报告可引用但非本轮执行：${surefire.file}` } : { gap: '缺少已有三分支零失败报告' }
      })
      return { token, api, partial: true, notImplemented: true, note: 'PROC-016 只读门禁保持 GAP，未创建或修改业务事实' }
    }
    if (config.target !== 'local') throw new Error('BLOCKED: PROC-016 专属写侧验收仅允许 local target')
    if (!databaseConfigured()) throw new Error('BLOCKED: PROC-016 专属写侧验收需要本地数据库安全证据')
    await assertLocalWriteSafety(caseRecord)
    const result = await createProcurement016OpeningClosureFixture(api, caseRecord, {
      pageEvidence: {
        page,
        openRoute: dependencies.openRoute || openRoute,
        saveScreenshot: dependencies.saveScreenshot || saveScreenshot,
        outputDir,
        record
      }
    })
    caseRecord.checks.push(
      {
        name: '采购发票分页返回来源、明细快照与生效字段',
        passed: ['srcBillType', 'srcBillId', 'details', 'isEffective'].every((field) =>
          Object.prototype.hasOwnProperty.call(result.historical.invoice.created, field)),
        details: `invoiceId=${result.historical.invoice.invoiceId}`
      },
      {
        name: 'PROC-016 历史应付存在时正式审核精确拒绝且完整快照不变',
        passed: result.historical.rejected?.code === 1_030_102_040 &&
          result.historical.snapshots?.before === result.historical.snapshots?.after &&
          result.historical.snapshots?.after === result.historical.snapshots?.duplicateAfter,
        details: `invoiceId=${result.historical.invoice.invoiceId}; code=${result.historical.rejected?.code}`
      },
      {
        name: 'PROC-016 无历史应付正式审核生成唯一 PurInvoice 应付并保留完整快照',
        passed: Boolean(result.absent.generated?.length === 1 &&
          result.absent.generated[0]?.srcBillType === 'PurInvoice' &&
          result.absent.snapshots?.before && result.absent.snapshots?.after),
        details: `invoiceId=${result.absent.invoice.invoiceId}; payableId=${result.absent.generated?.[0]?.id}`
      },
      {
        name: 'PROC-016 期初发票跳过历史订单检查并生成正确来源应付',
        passed: Boolean(result.opening.generated?.length === 1 &&
          result.opening.generated[0]?.srcBillType === 'PurInvoice' &&
          result.opening.snapshots?.before && result.opening.snapshots?.after),
        details: `invoiceId=${result.opening.invoice.invoiceId}; payableId=${result.opening.generated?.[0]?.id}`
      },
      {
        name: 'PROC-016 专属发票真实页面唯一定位详情字段与审核入口',
        passed: result.pageEvidence.status === 'VERIFIED',
        details: JSON.stringify(result.pageEvidence)
      }
    )
    caseRecord.evidence.push(
      `PROC-016 专属供应商=${result.fixture.supplierId}、账户=${result.fixture.accountId}；` +
      `历史应付存在/不存在/期初三场景正式 API、拒绝前后完整快照、专属发票 ${result.historical.invoice.invoiceId} ` +
      `真实筛选详情与复核入口截图；已审核事实按 cleanupPlan 保留，不使用 SQL`
    )
    const surefire = readSurefireSummary(
      'cfor-module-erp/cfor-module-erp-biz/target/surefire-reports/' +
      'tech.cfor17.module.erp.service.fin.Impl.FinPayableServiceImplHistoricalPayableTest.txt'
    )
    const unitTestPassed = Boolean(surefire) &&
      /Tests run:\s*3,\s*Failures:\s*0,\s*Errors:\s*0,\s*Skipped:\s*0/.test(surefire.text)
    if (unitTestPassed) {
      caseRecord.checks.push({
        name: '已有报告覆盖历史应付存在/不存在/期初发票跳过三分支（非本轮执行）',
        passed: true,
        details: `existing-report-only:${surefire.file}`
      })
      caseRecord.evidence.push(`已有 Maven surefire 报告（非本轮执行）：${surefire.file}`)
    } else {
      caseRecord.notes.push(
        'GAP: 未找到 FinPayableServiceImplHistoricalPayableTest 的零失败既有 surefire 报告；' +
        '本轮不执行 Java 单测')
    }
    procurementCatalogEvidence('PROC-016', caseRecord, {
      0: ['采购发票分页返回来源、明细快照与生效字段'],
      1: ['PROC-016 历史应付存在时正式审核精确拒绝且完整快照不变'],
      2: ['PROC-016 专属发票真实页面唯一定位详情字段与审核入口'],
      3: unitTestPassed
        ? ['已有报告覆盖历史应付存在/不存在/期初发票跳过三分支（非本轮执行）']
        : { gap: '缺少既有 FinPayableServiceImplHistoricalPayableTest 的零失败 surefire 报告' }
    })
    return {
      token,
      api,
      ...result,
      notImplemented: false,
      note: 'PROC-016 三场景专属正式 API 夹具、完整快照、专属发票详情页面证据已接入；Java 报告仅引用既有证据'
    }
  }

  if (caseId === 'PROC-017') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const pageRenderStartedAt = Date.now()
    await openRoute(page, '/erp/purchase/purchaseRequest')
    const button = page.getByRole('button', { name: '待生成请购', exact: true }).first()
    let buttonVisible = false
    try {
      // The request list loads asynchronously; wait for the real action before asserting availability.
      await button.waitFor({ state: 'visible', timeout: 60000 })
      buttonVisible = true
    } catch {}
    const pageRenderDurationMs = Date.now() - pageRenderStartedAt
    if (buttonVisible) {
      await button.click()
    }
    const pendingDialog = page.locator('.el-dialog:visible').last()
    try {
      await pendingDialog.waitFor({ state: 'visible', timeout: 30000 })
    } catch {}
    const sourceTabs = ['生产订单', '销售订单', '现存量', 'MRP运算结果']
    const dialogText = await pendingDialog.innerText().catch(() => '')
    const visibleSourceTabs = sourceTabs.filter((label) => dialogText.includes(label))
    caseRecord.checks.push({
      name: '请购单列表提供待生成请购入口',
      passed: buttonVisible,
      details: buttonVisible
        ? `命中待生成请购按钮，pageRenderMs=${pageRenderDurationMs}`
        : `未找到待生成请购按钮，pageRenderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '待生成请购弹窗聚合四类来源',
      passed:
        buttonVisible &&
        dialogText.includes('待生成请购') &&
        visibleSourceTabs.length === sourceTabs.length &&
        dialogText.includes('生成请购'),
      details: `tabs=${visibleSourceTabs.join(',')}`
    })
    caseRecord.checks.push({
      name: '请购单列表首屏加载耗时不超过 10 秒',
      passed: pageRenderDurationMs <= 10000,
      details: `pageRenderMs=${pageRenderDurationMs}`
    })
    const mrpHistory = await api.getBusiness('/mes/mrp/history?pageNo=1&pageSize=10')
    const mrpPage = mrpHistory?.data ?? mrpHistory
    const mrpRows = Array.isArray(mrpPage?.list)
      ? mrpPage.list
      : Array.isArray(mrpPage?.records)
        ? mrpPage.records
        : []
    caseRecord.checks.push({
      name: '待生成请购复用现有 MRP 历史读取接口',
      passed:
        typeof mrpHistory?.code === 'number' &&
        [0, 200].includes(mrpHistory.code) &&
        typeof mrpPage?.total === 'number' &&
        mrpRows.length <= 10,
      details: `code=${mrpHistory?.code}, total=${mrpPage?.total}, rows=${mrpRows.length}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-request-pending-sources', record)
    caseRecord.evidence.push('真实登录、请购单列表待生成入口、四类来源标签与 MRP 历史接口契约截图')
    const env = dependencies.env || process.env
    if (env.CFOR_E2E_WRITE_FIXTURES === 'true') {
      if (config.target !== 'local') {
        throw new Error('BLOCKED: PROC-017 写侧验收仅允许 local target')
      }
      if (!databaseConfigured()) {
        throw new Error('BLOCKED: PROC-017 写侧验收需要配置本地数据库只读证据，尚未生成请购')
      }
      await assertLocalWriteSafety(caseRecord)
      const write = await createPendingRequestBrowserFixture(api, caseRecord,
        (source) => generatePendingRequestInBrowser(page, source, {
          caseRecord,
          capture: (name) => saveScreenshot(page, outputDir, name, record)
        })
      )
      await verifyGeneratedRequestList(page, write, {
        caseRecord,
        capture: (name) => saveScreenshot(page, outputDir, name, record)
      })
      const snapshot = await runReadOnlySql(`
        SELECT r.id, r.src_bill_type, r.src_bill_id, r.bill_stage, r.is_effective,
               r.is_closed, r.total_count, i.product_id, i.product_unit_id, i.in_count
        FROM erp_purchase_order_request r
        JOIN erp_purchase_order_request_items i ON i.mid=r.id AND i.deleted=0
        WHERE r.id='${write.requestId}' AND r.tenant_id=1 AND r.deleted=0 AND i.tenant_id=1
      `)
      caseRecord.database = [...(caseRecord.database || []), {
        stage: 'browser-generated-request', ...snapshot
      }]
      const row = snapshot.rows?.[0]
      caseRecord.checks.push({
        name: 'Chrome 生成请购的来源及待提审数量在既有主子表准确落库',
        passed: snapshot.available && snapshot.rows.length === 1 &&
          row[0] === write.requestId && row[1] === 'sale' && row[2] === write.saleOrderId &&
          row[3] === '14' && Number(row[4]) === 0 && Number(row[5]) === 0 &&
          Number(row[6]) === 2 && row[7] === String(write.material.id) &&
          row[8] === String(write.material.unitId) && Number(row[9]) === 2,
        details: JSON.stringify(snapshot.rows)
      })
      caseRecord.checks.push({
        name: 'PROC-017 销售订单来源复用既有创建接口生成未审核请购',
        passed:
          write.fixture.generatedViaBrowser === true &&
          String(write.request?.srcBillType) === 'sale' &&
          String(write.request?.srcBillId) === write.saleOrderId &&
          Number(write.request?.isEffective) === 0 &&
          write.request?.itemsList?.length === 1 &&
          Number(write.request?.itemsList?.[0]?.inCount) === 2,
        details: `saleOrderId=${write.saleOrderId}; requestId=${write.requestId}; ` +
          `effective=${write.request?.isEffective}; items=${write.request?.itemsList?.length || 0}`
      })
      caseRecord.checks.push({
        name: 'PROC-017 待生成请购不新增前置事实表',
        passed:
          write.requestPayload?.srcBillType === 'sale' &&
          write.requestPayload?.srcBillId === write.saleOrderId &&
          !Object.prototype.hasOwnProperty.call(write.requestPayload, 'pendingSourceId'),
        details: `requestId=${write.requestId}; source=${write.requestPayload?.srcBillType}/` +
          `${write.requestPayload?.srcBillId}`
      })
      procurementCatalogEvidence('PROC-017', caseRecord, {
        0: ['请购单列表提供待生成请购入口'],
        1: ['待生成请购弹窗聚合四类来源'],
        2: [
          'Chrome 选择专属销售来源明细并确认一键生成请购',
          'Chrome 按生成单号唯一回读本轮未审核请购和数量',
          'PROC-017 销售订单来源复用既有创建接口生成未审核请购',
          'Chrome 生成请购的来源及待提审数量在既有主子表准确落库'
        ],
        3: ['PROC-017 待生成请购不新增前置事实表',
          'Chrome 生成请购的来源及待提审数量在既有主子表准确落库']
      })
      return { token, api, acceptanceComplete: caseRecord.passCandidate,
        partial: !caseRecord.passCandidate }
    }
    procurementCatalogEvidence('PROC-017', caseRecord, {
      0: ['请购单列表提供待生成请购入口'],
      1: ['待生成请购弹窗聚合四类来源'],
      2: { gap: '未启用本地写侧夹具，未选择真实来源并生成未审核请购' },
      3: { gap: '现有只读接口无法证明未新增前置事实表' }
    })
    return {
      token,
      api,
      notImplemented: true,
      note: '入口、四类来源标签与 MRP 读取已完成；尚未选择真实来源并生成待提审请购，不能登记一键生成业务闭环通过'
    }
  }

  if (caseId === 'PROC-018') {
    assertProcurementApproverCredentials()
    const session = await resolveProcurementTenantContext({ page, record })
    const { token, tenantId, api } = session
    const tenantPredicate = purchaseOrderTenantPredicate(tenantId)
    const approverBrowsers = []
    const approverSessions = {}
    let fixture
    try {
      // Authenticate all configured approvers before creating any business fixture.
      approverSessions.purchase = await authenticateProcurementApprover({
        label: '采购负责人',
        username: config.purchaseApproverUsername,
        password: config.purchaseApproverPassword,
        tenantId,
        record,
        approverBrowsers
      })
      approverSessions.finance = await authenticateProcurementApprover({
        label: '财务复核',
        username: config.financeApproverUsername,
        password: config.financeApproverPassword,
        tenantId,
        record,
        approverBrowsers
      })
      approverSessions.final = await authenticateProcurementApprover({
        label: '负责人终审',
        username: config.finalApproverUsername,
        password: config.finalApproverPassword,
        tenantId,
        record,
        approverBrowsers
      })
      fixture = await createPurchaseRequest(api, caseRecord)
      await openRoute(page, '/erp/purchase/purchaseRequest')
      await page.locator('.request-status-tabs').waitFor({ state: 'visible', timeout: 60000 })
      await page.getByPlaceholder('请输入请购单号', { exact: true }).fill(fixture.billNo)
      await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url())
          return url.pathname.endsWith('/erp/purchase/order/request/page') &&
            url.searchParams.get('billNo') === fixture.billNo
        }),
        page.getByRole('button', { name: '搜索', exact: true }).click()
      ])

      const row = page.locator('.vxe-body--row').filter({ hasText: fixture.billNo }).first()
      await row.waitFor({ state: 'visible', timeout: 30000 })
      // VXE duplicates fixed-column rows; scope actions to the visible fixed-right wrapper.
      const actionRow = page
        .locator('.vxe-table--fixed-right-wrapper .vxe-body--row')
        .filter({ hasText: fixture.billNo })
        .first()
      const submitButton = actionRow.getByRole('button', { name: /提审|审核/, exact: false }).first()
      await submitButton.waitFor({ state: 'visible', timeout: 30000 })
      await submitButton.click()
      const confirmation = page.locator('.el-message-box:visible')
      await confirmation.getByRole('button', { name: /确定|确认/ }).click()

      const waitForRequest = async (predicate, timeoutMs = 60000) => {
        const deadline = Date.now() + timeoutMs
        let latest
        while (Date.now() < deadline) {
          latest = await fixture.read()
          if (predicate(latest)) return latest
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        return latest
      }
      const submitted = await waitForRequest(
        (request) => String(request.billStage) === '22' && Boolean(request.processInstanceId)
      )
      caseRecord.checks.push({
        name: 'Chrome 页面提交请购 BPM 后进入审批中并绑定流程实例',
        passed: String(submitted?.billStage) === '22' && Boolean(submitted?.processInstanceId),
        details: `billStage=${submitted?.billStage}, processInstanceId=${submitted?.processInstanceId || ''}`
      })
      if (!submitted?.processInstanceId) {
        throw new Error(`请购提交 BPM 后未获得流程实例：${JSON.stringify(submitted)}`)
      }

      const waitForTodo = async (approverApi, timeoutMs = 60000) => {
        const deadline = Date.now() + timeoutMs
        let latest
        while (Date.now() < deadline) {
          latest = await approverApi.getBusiness(
            `/bpm/task/my-todo?processInstanceId=${encodeURIComponent(submitted.processInstanceId)}`
          )
          const value = latest?.data ?? latest
          const task = Array.isArray(value) ? value[0] : value
          if (task?.id) return task
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        return null
      }

      const readProcessTasks = async (approverApi) => {
        const payload = await approverApi.getBusiness(
          `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(submitted.processInstanceId)}`
        )
        return procurementTaskList(payload)
      }

      const waitForProcessTask = async (approverApi, taskDefinitionKey, timeoutMs = 60000) => {
        const deadline = Date.now() + timeoutMs
        let latest = []
        while (Date.now() < deadline) {
          latest = await readProcessTasks(approverApi)
          const task = findProcurementTask(latest, taskDefinitionKey)
          if (task?.id) return task
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        return findProcurementTask(latest, taskDefinitionKey)
      }

      const approveInBrowser = async ({
        label,
        session: approverSession,
        taskDefinitionKey,
        opinionText
      }) => {
        const { browser: approverBrowser, api: approverApi, identity } = approverSession
        const processTask = await waitForProcessTask(api, taskDefinitionKey)
        caseRecord.checks.push({
          name: `${label}独立 Chrome 会话收到请购 BPM 待办并记录实际 assignee`,
          passed: Boolean(processTask?.id) &&
            String(processTask.processInstanceId || submitted.processInstanceId) ===
              String(submitted.processInstanceId),
          details: `username=${identity.username}, ${formatProcurementTaskEvidence(
            processTask,
            identity.username
          )}`
        })
        assertProcurementTaskAssignee({
          task: processTask,
          identity,
          label
        })
        const task = await waitForTodo(approverApi)
        if (!task?.id) {
          throw new Error(
            `BLOCKED: PROC-018 ${label}未收到请购 BPM 待办：processInstanceId=${submitted.processInstanceId}`
          )
        }

        await openRoute(
          approverBrowser.page,
          `/bpm/process-instance/detail?id=${encodeURIComponent(submitted.processInstanceId)}&taskId=${encodeURIComponent(task.id)}`,
          {
            readySelector: '.processInstance-wrap-main',
            readyTimeoutMs: 20000,
            retries: 2
          }
        )
        await approverBrowser.page.locator('.processInstance-wrap-main').waitFor({
          state: 'visible',
          timeout: 60000
        })
        const approveReference = approverBrowser.page.getByRole('button', { name: '通过', exact: true }).first()
        await approveReference.waitFor({ state: 'visible', timeout: 30000 })
        await approveReference.click()
        const approvePopover = approverBrowser.page.locator('.el-popover:visible').last()
        await approvePopover.waitFor({ state: 'visible', timeout: 30000 })
        const opinion = approvePopover.getByPlaceholder(/请输入.*意见/).first()
        if (await opinion.count()) await opinion.fill(opinionText)
        const approvalResponse = approverBrowser.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.endsWith('/bpm/task/approve') &&
            response.request().method() === 'PUT',
          { timeout: 60000 }
        )
        await approvePopover.getByRole('button', { name: '通过', exact: true }).click()
        const response = await approvalResponse
        if (!response.ok()) {
          throw new Error(`${label}页面审批请求失败：HTTP ${response.status()}`)
        }
        await waitForTodo(approverApi, 10000).then((nextTask) => {
          if (nextTask) {
            throw new Error(`${label}审批后原账号仍有同一流程待办：taskId=${nextTask.id}`)
          }
        })
        return { browser: approverBrowser, api: approverApi, task }
      }

      const withdrawAfterMismatch = async (previousApproval, mismatchError) => {
        if (!previousApproval?.task?.id) {
          caseRecord.notes.push(
            'BLOCKED: PROC-018 当前节点没有已完成的前序任务，无法调用 BPM 正式撤回；未继续审批或生成后续业务数据'
          )
          throw mismatchError
        }
        try {
          await withdrawProcurementApproval({
            api: previousApproval.api,
            taskId: previousApproval.task.id,
            processInstanceId: submitted.processInstanceId,
            caseRecord
          })
        } catch (cleanupError) {
          throw new Error(
            `${mismatchError.message}；正式撤回清理失败：${String(cleanupError.message || cleanupError).slice(0, 300)}`
          )
        }
        throw mismatchError
      }

      let purchaseApproval
      try {
        purchaseApproval = await approveInBrowser({
        label: '采购负责人',
        session: approverSessions.purchase,
        taskDefinitionKey: 'FirstApprove_purchase-request',
        opinionText: '采购请购 BPM 第一段审批通过'
        })
      } catch (error) {
        if (String(error.message || error).startsWith('BLOCKED: PROC-018')) throw error
        throw error
      }
      let financeApproval
      try {
        financeApproval = await approveInBrowser({
          label: '财务复核',
          session: approverSessions.finance,
          taskDefinitionKey: 'SecondApprove_purchase-request',
          opinionText: '采购请购 BPM 第二段财务复核通过'
        })
      } catch (error) {
        if (String(error.message || error).startsWith('BLOCKED: PROC-018')) {
          await withdrawAfterMismatch(purchaseApproval, error)
        }
        throw error
      }
      let finalApproval
      try {
        finalApproval = await approveInBrowser({
          label: '负责人终审',
          session: approverSessions.final,
          taskDefinitionKey: 'FinalApprove_purchase-request',
          opinionText: '采购请购 BPM 第三段负责人终审通过'
        })
      } catch (error) {
        if (String(error.message || error).startsWith('BLOCKED: PROC-018')) {
          await withdrawAfterMismatch(financeApproval, error)
        }
        throw error
      }

      const approved = await waitForRequest(
        (request) => String(request.billStage) === '24' &&
          Number(request.isEffective) === 1 &&
          Number(request.isPlaceOrder) === 1
      )
      caseRecord.checks.push({
        name: 'BPM 审核通过后请购生效并自动转成采购订单',
        passed: String(approved?.billStage) === '24' &&
          Number(approved?.isEffective) === 1 &&
          Number(approved?.isPlaceOrder) === 1,
        details: `billStage=${approved?.billStage}, isEffective=${approved?.isEffective}, isPlaceOrder=${approved?.isPlaceOrder}`
      })

      const orderPage = await api.getBusiness('/erp/purchase-order/page?pageNo=1&pageSize=100')
      const orderRows = orderPage?.data?.list ?? orderPage?.data?.records ?? orderPage?.list ?? []
      const sourceSnapshot = await runReadOnlySql(`
        SELECT 'purchase-source', po.id, po.bill_no, poi.id, poi.src_bill_id,
               poi.src_entry_id, poi.count, poi.in_count, po.bill_stage, po.is_closed
        FROM erp_purchase_order po
        JOIN erp_purchase_order_items poi ON poi.mid = po.id
        WHERE ${tenantPredicate}
          AND po.deleted = 0
          AND poi.deleted = 0
          AND poi.src_bill_id = '${fixture.id}'
        ORDER BY po.id, poi.entry_no
      `)
      if (!sourceSnapshot.available) {
        throw new Error(`BLOCKED: ${sourceSnapshot.reason}`)
      }
      caseRecord.database = [...(caseRecord.database || []), {
        stage: 'after-purchase-order-conversion',
        ...sourceSnapshot
      }]
      const sourceRows = sourceSnapshot.rows.filter((row) => row[0] === 'purchase-source')
      const linkedOrderIds = new Set(sourceRows.map((row) => String(row[1])))
      const linkedOrders = orderRows.filter((order) => linkedOrderIds.has(String(order.id)))
      const requestItemIds = new Set(
        (fixture.initial.itemsList || []).map((item) => String(item.id)).filter(Boolean)
      )
      caseRecord.checks.push({
        name: '自动生成的采购订单明细保留请购来源关联',
        passed: sourceRows.length >= 2 &&
          sourceRows.every((row) =>
            String(row[4]) === fixture.id &&
            Boolean(row[5]) &&
            (!requestItemIds.size || requestItemIds.has(String(row[5])))
          ) &&
          sourceRows.reduce((sum, row) => sum + Number(row[6] || 0), 0) >= 8,
        details: `orders=${sourceRows.map((row) => row[2]).join(',')}, sourceRows=${sourceRows.length}`
      })
      caseRecord.checks.push({
        name: '未入库的自动采购订单保持未关闭，不被通用执行阶段误判为完成',
        passed: sourceRows.length >= 2 &&
          sourceRows.every((row) => Number(row[7]) === 0 && row[8] !== '34' && Number(row[9]) === 0) &&
          linkedOrders.length === linkedOrderIds.size &&
          linkedOrders.every((order) => Number(order.isClosed) === 0 && String(order.billStage) !== '34'),
        details: `orders=${linkedOrders.map((order) =>
          `${order.id}:stage=${order.billStage},closed=${order.isClosed}`
        ).join(',')}`
      })
      for (const order of linkedOrders) {
        const detail = (await api.getBusiness(
          `/erp/purchase-order/get?id=${encodeURIComponent(order.id)}`
        )).data
        caseRecord.checks.push({
          name: '自动采购订单可打开真实详情，明细来源与数量完整',
          passed: String(detail?.id) === String(order.id) &&
            detail?.supplierName === null &&
            Array.isArray(detail?.items) && detail.items.length >= 2 &&
            detail.items.reduce((sum, item) => sum + Number(item.count), 0) === 8,
          details: `orderId=${order.id}, items=${detail?.items?.length ?? 0}`
        })
      }

      const beforeRepeat = [...new Set(sourceRows.map((row) => String(row[1])))].sort()
      let repeatApproval
      try {
        // Re-submit the completed task through the real BPM endpoint to verify duplicate-action handling.
        repeatApproval = await finalApproval.api.request('PUT', '/bpm/task/approve', {
          id: finalApproval.task.id,
          reason: 'duplicate approval probe',
          variables: {},
          nextAssignees: {}
        })
      } catch (error) {
        repeatApproval = { code: -1, msg: error.message }
      }
      const afterRepeatSnapshot = await runReadOnlySql(`
        SELECT po.id
        FROM erp_purchase_order po
        JOIN erp_purchase_order_items poi ON poi.mid = po.id
        WHERE ${tenantPredicate}
          AND po.deleted = 0
          AND poi.deleted = 0
          AND poi.src_bill_id = '${fixture.id}'
        GROUP BY po.id
        ORDER BY po.id
      `)
      if (!afterRepeatSnapshot.available) {
        throw new Error(`BLOCKED: ${afterRepeatSnapshot.reason}`)
      }
      caseRecord.database = [...(caseRecord.database || []), {
        stage: 'after-duplicate-approval-probe',
        ...afterRepeatSnapshot
      }]
      const afterRepeat = afterRepeatSnapshot.rows
        .map((row) => String(row[0]))
        .sort()
      caseRecord.checks.push({
        name: '重复办理已完成 BPM 任务被拒绝，且不重复生成采购订单',
        passed: repeatApproval?.code !== 0 && JSON.stringify(afterRepeat) === JSON.stringify(beforeRepeat),
        details: `approveCode=${repeatApproval?.code}, msg=${repeatApproval?.msg || ''}, before=${beforeRepeat.join(',')}, after=${afterRepeat.join(',')}`
      })
      await saveScreenshot(page, outputDir, 'erp-purchase-request-bpm-submitted', record)
      await saveScreenshot(finalApproval.browser.page, outputDir, 'erp-purchase-request-bpm-approved', record)
      caseRecord.evidence.push(
        `四个真实 Chrome 会话完成请购 ${fixture.billNo} 提审、采购负责人/财务复核/负责人终审、自动采购订单 ${beforeRepeat.join(',')} ` +
        '及重复回调幂等验证；采购订单明细来源通过只读数据库核对'
      )
    } finally {
      for (const approverBrowser of approverBrowsers) {
        await approverBrowser.browser.close()
      }
    }
    return { token, api }
  }

  if (caseId === 'PROC-019') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const pageResult = await api.getBusiness(
      '/erp/purchase-reconciliation/page?pageNo=1&pageSize=100'
    )
    const rows = Array.isArray(pageResult?.data?.list) ? pageResult.data.list : []
    caseRecord.checks.push({
      name: '采购对账分页返回 list/total 业务结构',
      passed:
        Array.isArray(pageResult?.data?.list) &&
        Object.prototype.hasOwnProperty.call(pageResult.data, 'total'),
      details: `rows=${rows.length}, total=${pageResult?.data?.total}`
    })

    await openRoute(page, '/erp/purchase/reconciliation', {
      readySelector: 'input[placeholder="请输入对账单号"]'
    })
    const menuItem = page.locator('.el-menu-item').filter({ hasText: '采购对账' }).first()
    await menuItem.waitFor({ state: 'visible', timeout: config.browserTimeoutMs })
    const menuVisible = await menuItem.isVisible().catch(() => false)
    const launchButton = page.getByRole('button', { name: '发起对账', exact: true }).first()
    await launchButton.waitFor({ state: 'visible', timeout: config.browserTimeoutMs })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '供应链菜单显示采购对账且深链不再进入 404',
      passed:
        menuVisible &&
        page.url().includes('/erp/purchase/reconciliation') &&
        bodyText.includes('采购对账'),
      details: `url=${page.url()}, menuVisible=${menuVisible}`
    })
    caseRecord.checks.push({
      name: '采购对账页面渲染发起对账入口',
      passed: bodyText.includes('采购对账') && await launchButton.isVisible(),
      details: page.url()
    })

    await launchButton.click()
    const createDialog = page.getByText('发起采购对账', { exact: true }).first()
    await createDialog.waitFor({ state: 'visible', timeout: config.browserTimeoutMs })
    const createDialogText = await page.locator('.el-dialog:visible').last().innerText()
    caseRecord.checks.push({
      name: '发起采购对账弹窗展示供应商与可对账发货明细入口',
      passed:
        createDialogText.includes('供应商') &&
        createDialogText.includes('选择供应商后加载可对账发货明细') &&
        createDialogText.includes('生成对账单'),
      details: createDialogText.slice(0, 500)
    })
    await page.getByRole('button', { name: '取消', exact: true }).last().click()

    let targetRow = rows[0] || null
    let writeReconciliation = null
    const env = dependencies.env || process.env
    if (env.CFOR_E2E_WRITE_FIXTURES === 'true') {
      if (config.target !== 'local') {
        throw new Error('BLOCKED: PROC-019 写侧验收仅允许 local target')
      }
      if (!databaseConfigured()) {
        throw new Error('BLOCKED: PROC-019 写侧验收需要配置本地数据库只读证据，尚未创建对账单')
      }
      await assertLocalWriteSafety(caseRecord)
      writeReconciliation = await createReconciliationWriteFixture(api, caseRecord)
      const confirmedLine = writeReconciliation.confirmed?.lines?.[0]
      caseRecord.checks.push({
        name: 'PROC-019 专属采购订单经 ASN 形成可对账明细并确认',
        passed:
          Boolean(writeReconciliation.availableLine) &&
          Number(writeReconciliation.availableLine?.shippedQty) >= 2 &&
          Number(confirmedLine?.confirmedQty) === 2 &&
          Number(confirmedLine?.confirmedPrice) === Number(writeReconciliation.confirmedPrice) &&
          Number(confirmedLine?.remainingInvoiceQty) === 2,
        details: `reconciliationId=${writeReconciliation.reconciliationId}; ` +
          `shipped=${writeReconciliation.availableLine?.shippedQty}; ` +
          `confirmed=${confirmedLine?.confirmedQty}/${confirmedLine?.confirmedPrice}; ` +
          `remaining=${confirmedLine?.remainingInvoiceQty}`
      })
      targetRow = { ...(targetRow || {}), billNo: writeReconciliation.confirmed?.billNo || targetRow?.billNo }
      if (!targetRow.billNo) {
        throw new Error('PROC-019 专属对账单详情未返回 billNo，无法执行页面详情回读')
      }
      await page.getByPlaceholder('请输入对账单号', { exact: true }).fill(targetRow.billNo)
      const [filteredResponse] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url())
          return url.pathname.endsWith('/erp/purchase-reconciliation/page') &&
            url.searchParams.get('billNo') === targetRow.billNo
        }),
        page.getByRole('button', { name: '搜索', exact: true }).click()
      ])
      const filtered = await readBrowserBusinessResponse(filteredResponse)
      caseRecord.checks.push({
        name: '采购对账页面按本轮单号唯一回读已确认来源单',
        passed: filtered.code === 0 && filtered.data?.list?.length === 1 &&
          String(filtered.data.list[0].id) === writeReconciliation.reconciliationId,
        details: `billNo=${targetRow.billNo}; reconciliationId=${writeReconciliation.reconciliationId}`
      })
    }

    if (!targetRow) {
      procurementCatalogEvidence('PROC-019', caseRecord, {
        0: ['供应链菜单显示采购对账且深链不再进入 404'],
        1: ['供应链菜单显示采购对账且深链不再进入 404'],
        2: ['采购对账分页返回 list/total 业务结构'],
        3: ['采购对账页面渲染发起对账入口'],
        4: ['发起采购对账弹窗展示供应商与可对账发货明细入口'],
        5: { gap: '当前租户没有对账单且未启用写侧夹具，详情字段缺少真实样本' }
      })
      caseRecord.evidence.push(
        '真实 admin Chrome 已验证供应链菜单、采购对账深链、分页契约和发起弹窗；当前无对账单样本，详情字段待补数据复验'
      )
      return {
        token,
        api,
        notImplemented: true,
        note: '当前租户采购对账分页为空，详情字段缺少真实样本，不能登记完整通过'
      }
    }

    const firstRow = targetRow
    const billButton = page.getByRole('button', { name: String(firstRow.billNo), exact: true }).first()
    await billButton.waitFor({ state: 'visible', timeout: config.browserTimeoutMs })
    await billButton.click()
    const detailTitle = page.getByText('采购对账详情', { exact: true }).first()
    await detailTitle.waitFor({ state: 'visible', timeout: config.browserTimeoutMs })
    const detailText = await page.locator('.el-dialog:visible').last().innerText()
    const detailFields = ['发货数量', '收货数量', '确认数量', '确认单价', '剩余可开票']
    caseRecord.checks.push({
      name: '采购对账详情展示关键数量、价格和可开票字段',
      passed: detailFields.every((label) => detailText.includes(label)),
      details: `billNo=${firstRow.billNo}, fields=${detailFields.filter((label) => detailText.includes(label)).join(',')}`
    })
    await saveScreenshot(page, outputDir, 'purchase-reconciliation', record)
    caseRecord.evidence.push(
      `真实 admin Chrome 验证采购对账深链、发起弹窗和详情字段，billNo=${firstRow.billNo}`
    )
    procurementCatalogEvidence('PROC-019', caseRecord, {
      0: ['供应链菜单显示采购对账且深链不再进入 404'],
      1: ['供应链菜单显示采购对账且深链不再进入 404'],
      2: ['采购对账分页返回 list/total 业务结构'],
      3: ['采购对账页面渲染发起对账入口'],
      4: ['发起采购对账弹窗展示供应商与可对账发货明细入口'],
      5: writeReconciliation
        ? ['PROC-019 专属采购订单经 ASN 形成可对账明细并确认', '采购对账详情展示关键数量、价格和可开票字段']
        : {
            gap: '详情字段只对现有样本做页面检查，未证明专属发货/收货/确认数量与剩余开票闭环'
          }
    })
    return { token, api, partial: !caseRecord.passCandidate }
  }

  return { designed: true }
}
