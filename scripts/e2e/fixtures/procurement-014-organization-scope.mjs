import { isBusinessSuccess } from '../lib/assertions.mjs'

export const PROCUREMENT_014_ORIGINAL_ASSERTIONS = Object.freeze([
  '真实创建两行请购，数量 3+5，关闭前主表及分录 isClosed=0',
  'Chrome 逐行关闭：第一行关闭后主表未关闭，全部分录关闭后主表自动关闭',
  '已关闭真实分录下单被拒绝，不改变下单标志及原数量',
  '重复整单关闭被拒绝',
  '列表渲染全部/编制中/编制完/核批中/核批完/已关闭状态标签',
  '已关闭标签真实请求 isClosed=1 并回读测试单据',
  '数据库前后状态和数量与接口回读一致，两次行关闭审计持久化',
  '来源不传行号仍可创建，数据库行号为唯一正整数',
  '独立 Chrome 的关联账号仅有请购查询权限，不能看到或直接请求关闭写操作',
  'Chrome 主动整单关闭新的两行请购，主表及分录同步关闭、原数量和下单标志不变',
  '主动整单关闭审计持久化，重复关闭与下单明确拒绝且没有来源采购订单'
])

export const PROCUREMENT_014_ORIGINAL_EVIDENCE = Object.freeze([
  ['真实创建两行请购，数量 3+5、主表及分录未关闭'],
  [
    'Chrome 关闭第一行后仅该行关闭，主表保持打开',
    'Chrome 关闭剩余行后全部分录关闭，数量不变',
    '全部分录关闭时主表由打开同步转为关闭'
  ],
  ['已审核且仅一行关闭的请购正式下单被关闭分录门禁拒绝，数据不变'],
  ['整单重复关闭明确拒绝，既有下单标志、数量及审计不变'],
  ['请购单列表渲染状态快捷查询标签'],
  ['已关闭快捷标签真实请求 isClosed=1 并回读测试单据'],
  [
    '来源未传行号时后端补齐唯一行号并成功创建两行',
    '两次页面行关闭的审计均持久化为关闭类型'
  ],
  ['来源未传行号时后端补齐唯一行号并成功创建两行'],
  [
    '隔离 Chrome 关联账号仅有请购查询权限，不具有管理员或写权限',
    '只读关联账号页面不提供关闭写操作',
    '只读关联账号不能通过直接请求关闭测试请购分录，数据库不变'
  ],
  ['Chrome 主动整单关闭后同步关闭两行，数量和下单标志不变'],
  [
    '主动整单关闭的审计持久化且类型正确',
    '主动整单关闭后下单与重复关闭明确拒绝，数据库不变且未生成来源订单'
  ]
].map(Object.freeze))

export function auditProcurement014OriginalAssertions ({ definition, checks = [] }) {
  if (definition?.id !== 'PROC-014' ||
      JSON.stringify(definition.assertions) !== JSON.stringify(PROCUREMENT_014_ORIGINAL_ASSERTIONS)) {
    throw new Error('PROC-014 原断言发生变化，必须重新审核，不能沿用旧映射')
  }
  const catalogAssertions = definition.assertions.map((assertion, index) => {
    const evidenceChecks = PROCUREMENT_014_ORIGINAL_EVIDENCE[index]
    const verified = evidenceChecks.every((name) => {
      const matches = checks.filter((item) => item.name === name)
      return matches.length === 1 && matches[0].passed === true
    })
    return {
      index,
      assertion,
      evidenceChecks: [...evidenceChecks],
      status: verified ? 'VERIFIED' : 'GAP'
    }
  })
  return {
    catalogAssertions,
    originalAssertionsComplete: catalogAssertions.every((item) => item.status === 'VERIFIED'),
    remainingAssertions: catalogAssertions
      .filter((item) => item.status === 'GAP')
      .map((item) => item.assertion)
  }
}

export const PROCUREMENT_014_ORGANIZATION_SCOPE = Object.freeze({
  caseId: 'PROC-014',
  status: 'PARTIAL',
  policyDecisionRequired: true,
  queryPermission: 'erp:purchase-order-request:query',
  gap: '请购详情和分页尚未形成同租户跨组织数据范围证据；仅有租户隔离不能升级 PROC-014',
  settings: Object.freeze([
    '用户管理（组件 system/user/index）：准备两个不同组织的专属查询账号',
    '角色管理（组件 system/role/index）> 菜单权限/数据权限：核对既有查询授权，不扩大套餐',
    '请购组织范围策略尚未确认，无可验证的专用组织开关；不能声称配置角色即可补齐'
  ]),
  sourceEvidence: Object.freeze([
    'PurchaseOrderRequestPageReqVO 未声明 sysOrgCode/orgId',
    'PurchaseOrderRequestMapper.xml whereCondition 未见 sys_org_code/org_id 过滤',
    'PurchaseOrderRequestServiceImpl 详情 selectById 与分页调用链未见显式组织范围约束',
    '上述是源码定位，不代替框架拦截器的运行时隔离验证'
  ])
})

export const PROCUREMENT_014_ORGANIZATION_WIRING = Object.freeze({
  file: 'scripts/e2e/suites/procurement.mjs',
  after: "procurementCatalogEvidence('PROC-014', caseRecord, { ... })",
  before: 'const organizationGate = procurementOrganizationGateStatus()',
  call: 'runProcurement014OrganizationScopeProbe({ caseRecord, expected, sameOrgViewer, foreignOrgViewer, organizationPolicy, readDetail, readPage })',
  reason: '本夹具不会清除现有组织 GAP，也不会将原断言通过升级为全案例 PASS'
})

const textOf = (value) => typeof value === 'string' && value.trim() ? value.trim() : null
const idOf = (value) => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null
}
const aliasOf = (row, camel, snake, normalize) => {
  const values = [row?.[camel], row?.[snake]].filter((value) => value != null)
  const normalized = values.map(normalize)
  return normalized.length && normalized.every((value) => value && value === normalized[0])
    ? normalized[0] : null
}

const invalidScope = (row) => [
  ['tenantId', 'tenant_id', idOf],
  ['orgId', 'org_id', idOf],
  ['sysOrgCode', 'sys_org_code', textOf]
].some(([camel, snake, normalize]) =>
  (row?.[camel] != null || row?.[snake] != null) && !aliasOf(row, camel, snake, normalize))

export const procurement014OrganizationScopeOf = (row) => ({
  tenantId: aliasOf(row, 'tenantId', 'tenant_id', idOf),
  orgId: aliasOf(row, 'orgId', 'org_id', idOf),
  sysOrgCode: aliasOf(row, 'sysOrgCode', 'sys_org_code', textOf)
})

const hasScope = (scope) => Boolean(scope.tenantId && (scope.orgId || scope.sysOrgCode))
const matchesScope = (actual, expected) => ['tenantId', 'orgId', 'sysOrgCode']
  .every((key) => !expected[key] || actual[key] === expected[key])
const sameOrganization = (left, right) => {
  const keys = ['orgId', 'sysOrgCode'].filter((key) => left[key] && right[key])
  return keys.length > 0 && keys.every((key) => left[key] === right[key])
}
const differentOrganization = (left, right) => {
  const keys = ['orgId', 'sysOrgCode'].filter((key) => left[key] && right[key])
  return keys.length > 0 && keys.every((key) => left[key] !== right[key])
}
const exactTarget = (row, expected) =>
  idOf(row?.id) === expected.requestId && row?.billNo === expected.billNo
const leaksTarget = (row, expected) =>
  idOf(row?.id) === expected.requestId || row?.billNo === expected.billNo
const queryOnly = (viewer) =>
  Array.isArray(viewer?.permissions) &&
  viewer.permissions.includes(PROCUREMENT_014_ORGANIZATION_SCOPE.queryPermission) &&
  viewer.permissions.every((permission) =>
    permission === '' || permission === PROCUREMENT_014_ORGANIZATION_SCOPE.queryPermission)
const observation = (name, status, details) => ({ name, status, details })

const visibleRow = (row, expected, name) => {
  if (!exactTarget(row, expected)) return observation(name, 'FAIL', '详情/分页不是指定 ID 与单号的专属请购')
  if (invalidScope(row)) return observation(name, 'PARTIAL', '组织归属字段非法或同名别名冲突，不能选择性忽略')
  const actual = procurement014OrganizationScopeOf(row)
  if (!hasScope(actual)) return observation(name, 'PARTIAL', '缺少 tenantId 与 orgId/sysOrgCode 组织归属字段')
  const expectedScope = procurement014OrganizationScopeOf(expected)
  if (actual.tenantId !== expectedScope.tenantId ||
      !['orgId', 'sysOrgCode'].some((key) => actual[key] && expectedScope[key])) {
    return observation(name, 'FAIL', '租户归属不匹配或组织字段无法对照')
  }
  if (['orgId', 'sysOrgCode'].some((key) =>
    expectedScope[key] && actual[key] && actual[key] !== expectedScope[key])) {
    return observation(name, 'FAIL', '组织归属与专属夹具不匹配')
  }
  return observation(name, 'PASS', '专属请购 ID、单号、租户与组织归属一致')
}

const detailObservation = (payload, expected, name, own) => {
  if (own) {
    if (!isBusinessSuccess(payload)) return observation(name, 'FAIL', '同组织详情业务失败，不能算可见证据')
    return payload.data == null ? observation(name, 'PARTIAL', '成功响应缺少详情')
      : visibleRow(payload.data, expected, name)
  }
  // Only the existing exact request-not-found contract proves scoped invisibility.
  if (payload?.code === -636 && payload.data === null &&
      (payload.msg === 'ERP 采购订单申请不存在' || payload.message === 'ERP 采购订单申请不存在') &&
      [payload.msg, payload.message].every((message) =>
        message == null || message === '' || message === 'ERP 采购订单申请不存在') &&
      payload.success !== true && payload.ok !== true) {
    return observation(name, 'PASS', '跨组织详情返回精确请购不存在领域拒绝')
  }
  if (payload?.data != null) return observation(name, 'FAIL', '跨组织详情返回了数据')
  if (payload?.code != null && !isBusinessSuccess(payload)) {
    return observation(name, 'FAIL', '认证/权限/服务异常或非预期领域码，不能冒充组织隔离')
  }
  return observation(name, 'PARTIAL', '没有精确详情不可见响应')
}

const pageObservation = (payload, expected, name, own) => {
  if (!isBusinessSuccess(payload)) return observation(name, 'FAIL', '分页业务失败，不能冒充组织隔离')
  const data = payload.data
  if (Array.isArray(data?.records) && Array.isArray(data?.list)) {
    return observation(name, 'PARTIAL', '分页同时返回 records/list，响应契约不明确')
  }
  const rows = Array.isArray(data?.records) ? data.records : data?.list
  if (!Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    return observation(name, 'PARTIAL', '分页缺少明确 records/list 行对象数组')
  }
  if (!own && rows.some((row) => leaksTarget(row, expected))) {
    return observation(name, 'FAIL', '跨组织分页泄露专属请购 ID 或单号')
  }
  if ((data.current != null && data.current !== 1) ||
      (data.pageNo != null && data.pageNo !== 1) ||
      !Number.isSafeInteger(data.total) || data.total < 0 || data.total !== rows.length ||
      rows.length > 100) {
    return observation(name, 'PARTIAL', '分页 total 缺失或未完整读取筛选结果')
  }
  if (!own) return observation(name, 'PASS', '完整分页未返回跨组织专属请购')
  const matches = rows.filter((row) => leaksTarget(row, expected))
  return matches.length === 1
    ? visibleRow(matches[0], expected, name)
    : observation(name, 'FAIL', `同组织专属请购命中数=${matches.length}，期望 1`)
}

export async function evaluateProcurement014OrganizationScope ({
  expected, sameOrgViewer, foreignOrgViewer, organizationPolicy, readDetail, readPage
} = {}) {
  const result = {
    caseId: 'PROC-014',
    status: 'PARTIAL',
    probes: [],
    checks: [],
    evidence: [],
    remainingAssertions: [],
    calls: [],
    policyDecisionRequired: false
  }
  const finish = () => {
    result.status = result.probes.some((item) => item.status === 'FAIL') ? 'FAIL'
      : result.probes.length > 0 && result.probes.every((item) => item.status === 'PASS') ? 'PASS'
        : 'PARTIAL'
    result.checks = result.probes
      .filter((item) => item.status !== 'PARTIAL')
      .map(({ name, status, details }) => ({ name, passed: status === 'PASS', details }))
    result.evidence = result.probes
      .filter((item) => item.status === 'PASS')
      .map((item) => `${item.name}: ${item.details}`)
    if (result.status !== 'PASS') result.remainingAssertions.push(PROCUREMENT_014_ORGANIZATION_SCOPE.gap)
    return result
  }

  if (organizationPolicy?.confirmed !== true || !textOf(organizationPolicy.reference)) {
    result.policyDecisionRequired = true
    result.probes.push(observation(
      '请购组织范围策略已确认',
      'PARTIAL',
      '缺少已确认的组织范围策略引用；不读接口、不创建账号或扩大权限'
    ))
    return finish()
  }

  const expectedScope = procurement014OrganizationScopeOf(expected)
  const same = procurement014OrganizationScopeOf(sameOrgViewer)
  const foreign = procurement014OrganizationScopeOf(foreignOrgViewer)
  const valid = idOf(expected?.requestId) &&
    textOf(expected?.billNo) &&
    hasScope(expectedScope) &&
    ![expected, sameOrgViewer, foreignOrgViewer].some(invalidScope) &&
    idOf(sameOrgViewer?.userId) &&
    idOf(foreignOrgViewer?.userId) &&
    idOf(sameOrgViewer.userId) !== idOf(foreignOrgViewer.userId) &&
    same.tenantId === expectedScope.tenantId &&
    foreign.tenantId === expectedScope.tenantId &&
    matchesScope(same, expectedScope) &&
    sameOrganization(same, expectedScope) &&
    differentOrganization(foreign, expectedScope) &&
    queryOnly(sameOrgViewer) &&
    queryOnly(foreignOrgViewer)
  if (!valid || typeof readDetail !== 'function' || typeof readPage !== 'function') {
    result.probes.push(observation(
      '同租户组织矩阵账号夹具归属有效',
      'PARTIAL',
      '需要精确单据、可核对的组织归属、两个不同的同租户查询账号与详情/分页读取器'
    ))
    return finish()
  }

  const normalized = { ...expected, requestId: idOf(expected.requestId) }
  for (const [own, viewer] of [[true, sameOrgViewer], [false, foreignOrgViewer]]) {
    for (const operation of ['detail', 'page']) {
      const name = `同租户${own ? '同组织' : '跨组织'}${operation === 'detail' ? '详情' : '分页'}${own ? '可见' : '不可见'}`
      const query = operation === 'detail'
        ? { id: normalized.requestId }
        : { pageNo: 1, pageSize: 100, billNo: normalized.billNo }
      result.calls.push({ operation, userId: idOf(viewer.userId), query })
      try {
        const payload = await (operation === 'detail' ? readDetail : readPage)({ viewer, query })
        result.probes.push(operation === 'detail'
          ? detailObservation(payload, normalized, name, own)
          : pageObservation(payload, normalized, name, own))
      } catch {
        result.probes.push(observation(
          name,
          'FAIL',
          '读取器异常，未形成有效响应；原始异常可能含凭据，不写入证据'
        ))
      }
    }
  }
  return finish()
}

export async function runProcurement014OrganizationScopeProbe ({ caseRecord, ...options } = {}) {
  if (!caseRecord || typeof caseRecord !== 'object') {
    throw new Error('PROC-014 组织范围夹具需要 caseRecord')
  }
  const result = await evaluateProcurement014OrganizationScope(options)
  caseRecord.checks = [...(caseRecord.checks || []), ...result.checks]
  caseRecord.evidence = [...(caseRecord.evidence || []), ...result.evidence]
  caseRecord.remainingAssertions = [
    ...new Set([...(caseRecord.remainingAssertions || []), ...result.remainingAssertions])
  ]
  caseRecord.organizationScope = result
  if (result.status !== 'PASS') caseRecord.passCandidate = false
  caseRecord.notes = [
    ...(caseRecord.notes || []),
    `PROC-014 组织范围探针=${result.status}；不清除原 catalog/租户/组织 GAP，不单独升级全案例 PASS`
  ]
  return result
}

export const locateProcurement014WiringAnchors = (source) => {
  const text = String(source ?? '')
  const catalogIndex = text.indexOf("procurementCatalogEvidence('PROC-014'")
  const organizationGateIndex = text.indexOf('const organizationGate = procurementOrganizationGateStatus()')
  return {
    catalogIndex,
    organizationGateIndex,
    valid: catalogIndex >= 0 && organizationGateIndex > catalogIndex
  }
}
