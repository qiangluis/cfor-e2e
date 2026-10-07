import { createApiClient } from '../lib/api.mjs'
import { launchBrowser, login, loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { createPurchaseRequest, snapshotPurchaseRequest } from '../fixtures/purchase-request.mjs'
import { databaseConfigured, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { createPurchaseReader } from '../fixtures/purchase-reader.mjs'
import { collectPagePerformance } from '../lib/performance.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { findMenuRouteByComponent, isStableId } from './base-partner.mjs'
import {
  cases as procurementFoundationReadonlyCases,
  runProcurementFoundationReadonlyContract
} from './procurement-foundation-readonly.mjs'

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

const readonlyFact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}：${details}`)
}
const missingReadonlyFact = (record, detail) =>
  record.notes.push(`前置缺失：${detail}；保留 PARTIAL，不以空集判通过`)
const ruleText = (value) => typeof value === 'string' && value.trim().length > 0

const readonlyData = (payload, label) => assertBusinessSuccess(payload, label).data
const readonlyArray = (payload, label) => {
  const rows = readonlyData(payload, label)
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${label} data 必须为对象数组`)
  }
  return rows
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

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  if (procurementFoundationReadonlyCases.includes(caseId)) {
    const token = await (dependencies.login || login)(page)
    const api = (dependencies.createApiClient || createApiClient)({ token, record })
    const result = await runProcurementFoundationReadonlyContract({
      caseId, api, caseRecord
    })
    caseRecord.evidence.push(
      '仅执行当前租户认证后的 GET 只读前置；未创建请购、采购、发票、应付、入库或审批事实'
    )
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
    caseRecord.evidence.push(await saveScreenshot(
      page, outputDir, 'erp-finance-document-type-rule-readonly', record))
    return { token, api, ...result }
  }

  if (caseId === 'PROC-009') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const accountPage = await api.getBusiness(
      '/erp/supplier-portal/account/page?pageNo=1&pageSize=100'
    )
    const accountRows = Array.isArray(accountPage?.data?.list) ? accountPage.data.list : []
    const settings = await api.getBusiness('/erp/supplier-portal/account/settings')
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
    caseRecord.evidence.push(
      '真实登录、账号/客商分页、配置及设置页面；仅在存在样本时验证详情和邀请按钮，不发送邀请邮件'
    )
    return { token, api, partial: true,
      note: '未执行账号创建、编辑、启停、密码重置及独立供应商身份隔离，不能将设置页面冒称完整 PASS' }
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
    }
    await saveScreenshot(page, outputDir, 'erp-purchase-opening-invoice-source', record)
    caseRecord.evidence.push('真实登录、期初采购入库分页字段检查、采购发票入口和来源弹窗截图')
    return { token, api, partial: true,
      note: '只读来源与表单入口已检查，未选择专属来源、核对本次数量金额或保存 purchaseInId/srcBillType 映射' }
  }

  if (caseId === 'PROC-012') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const pageResult = await api.getBusiness(
      '/erp/price-scheme/page?pageNo=1&pageSize=100&priceDirection=PURCHASE'
    )
    const rows = Array.isArray(pageResult?.data?.list) ? pageResult.data.list : []
    if (!rows.length) missingReadonlyFact(caseRecord, '没有采购价格方案样本，方案字段和版本未验证')
    caseRecord.checks.push({
      name: '统一价格中心提供 PURCHASE 方向方案分页',
      passed:
        Array.isArray(pageResult?.data?.list) &&
        rows.every((row) => row.priceDirection === 'PURCHASE'),
      details: `purchaseSchemes=${rows.length}`
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
    caseRecord.evidence.push('真实登录、PURCHASE 方向分页和价格中心页面截图')
    return { token, api, partial: true,
      note: '价格中心入口不代表采购订单取价成功；方案、版本、规则、命中依据和计算时间的正式订单快照未验证' }
  }

  if (caseId === 'PROC-013') {
    const token = await login(page)
    const api = createApiClient({ token, record })
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
      openRoute(page, '/erp/purchase/home')
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
    caseRecord.performance = await collectPagePerformance(page, pageRenderDurationMs)
    caseRecord.checks.push({
      name: '7 张待办卡片显示浏览器真实摘要响应的数值，不以默认零值结案',
      passed: true,
      details: JSON.stringify(browserSummary.data)
    })
    const bodyText = await page.locator('body').innerText()
    const visibleTitles = titles.filter((title) => bodyText.includes(title))
    caseRecord.checks.push({
      name: '采购工作台首页渲染 7 张待办卡片',
      passed: visibleTitles.length === titles.length,
      details: `visible=${visibleTitles.join(',')}, renderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '采购工作台首屏渲染耗时不超过 5 秒',
      passed: pageRenderDurationMs <= 5000,
      details: `renderMs=${pageRenderDurationMs}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-workbench-summary', record)
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
    await saveScreenshot(page, outputDir, 'erp-purchase-workbench-acceptance-filter', record)

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
    return { token, api }
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
    const rejectedOrder = await api.put(
      `/erp/purchase/order/request/place/an/order?ids=${firstClosed.id}&isSeparate=0`
    )
    caseRecord.checks.push({
      name: '真实已关闭分录所在请购不能绕过后端下单门禁',
      passed: rejectedOrder.code !== 0,
      details: `code=${rejectedOrder.code}, msg=${rejectedOrder.msg}（未审核单据优先命中审核门禁时仍应拒绝）`
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
    const repeated = await api.put(`/erp/purchase/order/request/close?id=${fixture.id}`)
    const after = await snapshotPurchaseRequest(fixture, caseRecord, 'after-all-lines')
    caseRecord.checks.push({
      name: '两次页面行关闭的审计均持久化为关闭类型',
      passed: after.filter((row) => row[0] === 'audit' && row[2] === '关闭').length === 2,
      details: `requestId=${fixture.id}`
    })
    caseRecord.checks.push({
      name: '整单重复关闭明确拒绝，未设置下单标志、未修改数量',
      passed: repeated.code !== 0 && String(repeated.msg).includes('已关闭') &&
        Number(after.find((row) => row[0] === 'bill')?.[3]) === 0 &&
        Number(after.find((row) => row[0] === 'bill')?.[4]) === 8,
      details: `code=${repeated.code}, msg=${repeated.msg}`
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
      `/erp/purchase/order/request/place/an/order?ids=${wholeItem.id}&isSeparate=0`
    )
    const wholeRepeated = await api.put(`/erp/purchase/order/request/close?id=${wholeFixture.id}`)
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
    try {
      const readerFixture = await createPurchaseRequest(api, caseRecord)
      const readerBefore = await snapshotPurchaseRequest(readerFixture, caseRecord, 'before-reader-probe')
      readerBrowser = await launchBrowser({ record })
      const readerToken = await loginWithCredentials(readerBrowser.page, reader.credentials)
      const readerApi = createApiClient({ token: readerToken, record })
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
    } finally {
      try {
        await reader.deactivate()
        caseRecord.notes.push(`已停用本轮关联测试账号 ${reader.username}，保留角色和审计证据`)
      } finally {
        await readerBrowser?.browser.close()
      }
    }
    return {
      token, api, notImplemented: true,
      note: '已执行行关闭、整单主动关闭、关闭后下单/重复关闭阻断及只读账号取证；跨租户/组织矩阵仍待补验'
    }
  }

  if (caseId === 'PROC-015') {
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
    return {
      token,
      api,
      notImplemented: true,
      note: '状态标签、无供应商实单详情与变更入口已验证；尚未完成真实字段变更审计、附件写入及写权限矩阵，不能登记 PB-139 完整通过'
    }
  }

  if (caseId === 'PROC-016') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const invoicePage = await api.getBusiness('/erp/purchase-invoice/page?pageNo=1&pageSize=100')
    const invoiceRows = Array.isArray(invoicePage?.data?.list) ? invoicePage.data.list : []
    if (invoiceRows.length) caseRecord.checks.push({
      name: '采购发票分页返回来源、明细快照与生效字段',
      passed:
        Array.isArray(invoicePage?.data?.list) &&
        invoiceRows.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'srcBillType') &&
            Object.prototype.hasOwnProperty.call(row, 'srcBillId') &&
            Object.prototype.hasOwnProperty.call(row, 'details') &&
            Object.prototype.hasOwnProperty.call(row, 'isEffective')
        ),
      details: `invoices=${invoiceRows.length}`
    })
    else caseRecord.notes.push('当前没有采购发票样本，来源与明细字段的实单契约尚未验证')

    const payablePage = await api.getBusiness(
      '/finance/finPayable/list/dictText?pageNo=1&pageSize=100'
    )
    const payableRows = Array.isArray(payablePage?.data?.list)
      ? payablePage.data.list
      : Array.isArray(payablePage?.data?.records)
        ? payablePage.data.records
        : []
    const historicalOrderIds = new Set(
      payableRows
        .filter(
          (row) =>
            row?.srcBillType === 'PurOrder' && Number(row?.isVoided || 0) !== 1 && row?.srcBillId
        )
        .map((row) => String(row.srcBillId))
    )
    const invoiceById = new Map(invoiceRows.map((row) => [String(row.id), row]))
    const duplicateInvoicePayables = payableRows.filter((row) => {
      if (row?.srcBillType !== 'PurInvoice' || Number(row?.isVoided || 0) === 1) {
        return false
      }
      const invoice = invoiceById.get(String(row.srcBillId))
      if (!invoice?.details) {
        return false
      }
      try {
        const sourceOrderIds = Object.keys(JSON.parse(invoice.details))
        return sourceOrderIds.some((orderId) => historicalOrderIds.has(String(orderId)))
      } catch {
        return false
      }
    })
    if (payableRows.length && invoiceRows.length) caseRecord.checks.push({
      name: '不存在同一采购订单同时挂历史应付和发票应付',
      passed: duplicateInvoicePayables.length === 0,
      details: `historicalOrderPayables=${historicalOrderIds.size}, invoicePayables=${payableRows.filter((row) => row?.srcBillType === 'PurInvoice').length}, duplicates=${duplicateInvoicePayables.length}`
    })
    else caseRecord.notes.push('当前发票或应付样本为空，空集扫描不能证明防重复业务通过')

    const pageRenderStartedAt = Date.now()
    await openRoute(page, '/erp/purchase/invoice')
    const createButton = page.getByRole('button', { name: '新增', exact: true }).first()
    const reconciliationButton = page.getByRole('button', { name: '待开票对账', exact: true }).first()
    await createButton.waitFor({ state: 'visible', timeout: 60000 })
    await reconciliationButton.waitFor({ state: 'visible', timeout: 60000 })
    const pageRenderDurationMs = Date.now() - pageRenderStartedAt
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '采购发票页面正常渲染并保留复核入口',
      passed:
        page.url().includes('/erp/purchase/invoice') &&
        bodyText.includes('采购发票') &&
        bodyText.includes('待开票对账'),
      details: `${page.url()}, renderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '采购发票页面首屏渲染耗时不超过 5 秒',
      passed: pageRenderDurationMs <= 5000,
      details: `renderMs=${pageRenderDurationMs}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-invoice-historical-payable-guard', record)
    caseRecord.evidence.push(
      '真实登录、采购发票来源字段契约、历史订单应付与发票应付重复扫描、发票页面截图'
    )
    return {
      token,
      api,
      notImplemented: true,
      note: `页面与当前数据扫描已完成（发票=${invoiceRows.length}、历史订单应付=${historicalOrderIds.size}）；` +
        '尚未通过专用单据执行历史应付存在/不存在/期初跳过三类真实复核，不能以空列表或页面通过代替防重复业务验收'
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

    await page.goto(`${config.webBase}/erp/purchase/reconciliation`, {
      waitUntil: 'domcontentloaded',
      timeout: config.browserTimeoutMs
    })
    await page.waitForFunction(
      (expectedPath) => window.location.pathname === expectedPath,
      '/erp/purchase/reconciliation',
      { timeout: config.browserTimeoutMs }
    )
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

    if (!rows.length) {
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

    const firstRow = rows[0]
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
    return { token, api }
  }

  return { designed: true }
}
