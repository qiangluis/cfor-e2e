import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { createApiClient, isBusinessRejection } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { cases as aiDataCases, runCase as runAiDataCase } from '../fixtures/ai-data-permission.mjs'

export const cases = ['AUTH-DATA-003', 'AUTH-DATA-005', 'AUTH-DATA-006', 'PB006-001', ...aiDataCases]
export const catalogAssertions = {
  'AUTH-DATA-003': [
    '当前租户部门清单可读取',
    '不存在的部门编号提交自定义数据范围被拒绝',
    '当前租户有效部门可保存并回读自定义范围'
  ],
  'AUTH-DATA-005': [
    '权限节点 sensitive:amount:view 存在且挂在角色管理下',
    '新建角色默认不包含 sensitive:amount:view（安全默认值）',
    '有权限账号读取销售/采购订单列表时 totalPrice、productPrice 等金额为数值',
    '无权限账号读取同一接口时被 @SensitiveAmount 标记的金额字段为 null，数量字段不受影响',
    '导出、打印、汇总卡片复用同一权限判定，不先下发真实金额再前端遮挡'
  ],
  'AUTH-DATA-006': [
    '给自建角色授予 sensitive:amount:view 后回读角色菜单包含该权限',
    '撤回该权限后回读角色菜单不再包含该权限',
    '权限变更在下次请求立即生效，不依赖前端缓存'
  ],
  'AUTH-DATA-007': [
    'AI Tool 与报表 SQL 查询按发起人数据范围过滤',
    'AI/异步结果复用发起人的 sensitive:amount:view 判定，不在后端另起特权上下文',
    '敏感字段权限快照随查询、导出与 AI 调用写入审计'
  ],
  'PB006-001': [
    '覆盖清单与汇总接口可读取且口径一致',
    'system 用户与部门表已登记通用数据权限规则',
    '库存唯一事实源明确不挂通用行级规则',
    'HRM 员工档案与 PMS 知识库成员按 dept_id 注册行级规则',
    'pms_project_group 无 dept_id，仅按负责人 user_id 收敛',
    '计划接入项不存在缺少归属字段的风险项'
  ]
}

const amountPermission = 'sensitive:amount:view'
const flatten = (rows) => (Array.isArray(rows) ? rows : [])
  .flatMap((row) => [row, ...flatten(row.children)])
const dataOf = (response) => {
  assertBusinessSuccess(response, '数据权限响应')
  return response.data
}
const id = (value) => {
  if (!/^[1-9]\d*$/.test(String(value ?? '')) ||
      (typeof value === 'number' && !Number.isSafeInteger(value))) {
    throw new Error('BLOCKED: invalid or imprecise fixture ID')
  }
  return String(value)
}
const sameIds = (actual, expected) => Array.isArray(actual) &&
  JSON.stringify(actual.map(String).sort()) === JSON.stringify(expected.map(String).sort())
const check = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  return name
}

const map = (record, index, evidenceChecks, gap = '') => {
  const row = record.catalogAssertions[index]
  const checks = evidenceChecks.map((name) => record.checks.find((item) => item.name === name))
  row.evidenceChecks = evidenceChecks
  row.status = checks.some((item) => item?.passed === false) ? 'FAILED'
    : !gap && checks.length > 0 && checks.every((item) => item?.passed === true) ? 'VERIFIED' : 'GAP'
  row.details = gap || (row.status === 'GAP' ? '本轮缺少完整检查证据' : '')
}

export function assertPermissionLocal (settings = config, env = process.env) {
  if (env.CFOR_E2E_WRITE_FIXTURES !== 'true' || settings.target !== 'local' ||
      String(settings.tenantId) !== '1' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: permission fixtures require opt-in local tenant1/cfor_admin_standard')
  }
  assertLocalDatabase(settings.db)
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083']]) {
    const url = new URL(base)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password || url.search || url.hash ||
        !['/', '/admin-api', '/admin-api/'].includes(url.pathname)) {
      throw new Error('BLOCKED: permission fixtures require loopback 9151/48083')
    }
  }
}

// Reuse the runner's headed browser with an isolated actor session.
export async function openPermissionActor ({ page, credentials, settings = config }) {
  const context = await page.context().browser().newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block'
  })
  try {
    const actorPage = await context.newPage()
    const auth = await loginWithCredentials(actorPage,
      { ...credentials, tenantName: settings.tenantName }, { returnContext: true })
    if (!auth?.token || String(auth.tenantId) !== '1') throw new Error('actor tenant/token mismatch')
    return { token: auth.token, page: actorPage, close: () => context.close() }
  } catch (error) {
    await context.close()
    throw error
  }
}

// Audit IDs before readback, including when creation succeeds but the read fails.
export function ownedPermissionResources (api, caseRecord, marker) {
  const resources = []
  const remember = (kind, value, payload) => {
    const item = { kind, id: id(value), marker, payload: { ...payload }, cleanup: 'PENDING' }
    delete item.payload.password
    resources.push(item)
    caseRecord.fixtureResiduals = [...(caseRecord.fixtureResiduals || []), item]
    caseRecord.businessIds = caseRecord.businessIds || {}
    caseRecord.businessIds[kind] = [...(caseRecord.businessIds[kind] || []), item.id]
    return item
  }
  const read = async (item) => {
    const row = dataOf(await api.getBusiness(`/system/${item.kind}/get?id=${item.id}`))
    const keys = item.kind === 'role' ? ['name', 'code', 'remark'] : ['username', 'nickname', 'remark']
    if (String(row?.id) !== item.id || keys.some((key) => row?.[key] !== item.payload[key]) ||
        (item.kind === 'role' && Number(row.type) !== 2)) {
      throw new Error(`Owned ${item.kind} identity mismatch; mutation refused`)
    }
    return row
  }
  return {
    remember, read,
    retainForAudit () {
      for (const item of resources) item.retainForAudit = true
    },
    async cleanup () {
      for (const item of [...resources].reverse()) {
        try {
          if (item.kind === 'role' && !item.retainForAudit && resources.some((row) =>
            row.kind === 'user' && row.cleanup !== 'DELETED_VERIFIED')) {
            throw new Error('Owned user retained; retain role for attribution')
          }
          await read(item)
          if (item.retainForAudit) {
            const path = item.kind === 'user' ? '/system/user/update-status' : '/system/role/update'
            dataOf(await api.putBusiness(path, item.kind === 'user'
              ? { id: item.id, status: 1 } : { ...item.payload, id: item.id, status: 1 }))
            if (Number((await read(item)).status) !== 1) throw new Error('Audit account/role disable readback failed')
            item.cleanup = 'RETAINED_AUDIT_DISABLED'
            check(caseRecord, `专属 ${item.kind} ${item.id} 审计保留并停用`, true)
            continue
          }
          dataOf(await api.deleteBusiness(`/system/${item.kind}/delete?id=${item.id}`))
          const after = dataOf(await api.getBusiness(`/system/${item.kind}/get?id=${item.id}`))
          if (after != null) throw new Error('Deletion readback still present')
          item.cleanup = 'DELETED_VERIFIED'
          check(caseRecord, `专属 ${item.kind} ${item.id} 删除回读`, true)
        } catch (error) {
          item.cleanup = 'RETAINED_UNVERIFIED'
          item.reason = error.message
          check(caseRecord, `专属 ${item.kind} ${item.id} 删除回读`, false, error.message)
        }
      }
    }
  }
}

export function selectAmountMenus (menuRows, assignableRows) {
  const rows = flatten(menuRows)
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  const assignable = new Set(flatten(assignableRows).map((row) => String(row.id)))
  const required = ['erp:sale-order:query', 'erp:purchase-order:query', 'system:role:query']
  const allowed = new Set([...required, 'system:settings:query', amountPermission])
  const chain = (permission) => {
    let row = rows.find((item) => item.permission === permission)
    if (!row || !assignable.has(String(row.id))) throw new Error(`BLOCKED: permission not assignable: ${permission}`)
    const selected = new Set()
    while (row) {
      const key = id(row.id)
      if (selected.has(key) || Number(row.status) !== 0 ||
          (row.permission && !allowed.has(row.permission))) {
        throw new Error('BLOCKED: invalid or privileged menu ancestor')
      }
      selected.add(key)
      if (String(row.parentId ?? '0') === '0') break
      row = byId.get(String(row.parentId))
      if (!row) throw new Error('BLOCKED: incomplete menu hierarchy')
    }
    return [...selected]
  }
  const amount = rows.find((row) => row.permission === amountPermission)
  return {
    base: [...new Set(required.flatMap(chain))],
    granted: [...new Set([...required, amountPermission].flatMap(chain))],
    amountId: id(amount?.id),
    underRole: byId.get(String(amount?.parentId))?.permission === 'system:role:query',
    allowed
  }
}

const amountFields = [
  'totalPrice', 'totalProductPrice', 'totalTaxPrice', 'discountPrice', 'depositPrice',
  'invoiceMount', 'checkedAmt', 'thisInvoiceMount', 'unInvoiceMount', 'unCheckedAmt'
]
const itemAmountFields = [
  'productPrice', 'totalPrice', 'taxPrice', 'productTaxPrice', 'checkedAmt',
  'productTotalPrice', 'onlyReturnAmount', 'unCheckedAmt'
]
export function orderAmountEvidence (rows, baseline, allowed) {
  if (!Array.isArray(rows) || rows.length === 0 || !baseline) return false
  const row = rows.find((item) => String(item?.id) === String(baseline.id))
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value)
  if (!row || !numeric(baseline.totalPrice) || baseline.totalPrice === 0 ||
      !numeric(baseline.totalProductPrice) ||
      !numeric(baseline.totalCount) || baseline.totalCount <= 0 ||
      !numeric(row.totalCount) || row.totalCount !== baseline.totalCount ||
      !amountFields.every((key) => Object.hasOwn(baseline, key) && Object.hasOwn(row, key) &&
        (allowed ? row[key] === baseline[key] && (baseline[key] == null || numeric(row[key])) : row[key] === null))) {
    return false
  }
  if (!Array.isArray(baseline.items) || baseline.items.length === 0 ||
      !Array.isArray(row.items) || row.items.length !== baseline.items.length) return false
  return baseline.items.every((item) => {
    const actual = row.items.find((value) => String(value.id) === String(item.id))
    return actual && numeric(item.count) && actual.count === item.count &&
      numeric(item.productPrice) && numeric(item.totalPrice) &&
      itemAmountFields.every((key) =>
        Object.hasOwn(item, key) && Object.hasOwn(actual, key) &&
        (allowed ? actual[key] === item[key] && (item[key] == null || numeric(actual[key])) : actual[key] === null))
  })
}

export const runCase = async (context, dependencies = {}) => {
  const { caseId, page, record, caseRecord, outputDir } = context
  if (!cases.includes(caseId)) throw new Error(`Unsupported data permission case: ${caseId}`)
  caseRecord.catalogAssertions = catalogAssertions[caseId].map((assertion, index) => ({
    index, assertion, status: 'GAP', evidenceChecks: [], details: '本轮尚未执行原断言'
  }))
  let result
  try {
    if (aiDataCases.includes(caseId)) {
      result = await (dependencies.runAiDataCase || runAiDataCase)(context, dependencies)
      for (const row of caseRecord.catalogAssertions) {
        const original = caseRecord.assertionMappings?.find((item) =>
          item.index === row.index + 1 && item.assertion === row.assertion)
        map(caseRecord, row.index, original?.checks || [],
          (original?.gaps || []).join('；') || 'AI/报表/异步及权限审计原断言尚未完整闭环')
      }
    } else {
      const token = await (dependencies.login || login)(page)
      const apiFactory = dependencies.createApiClient || createApiClient
      const api = apiFactory({ token, record })
      if (caseId === 'PB006-001') {
        await runCoverage(api, caseRecord)
      } else {
        const settings = dependencies.settings || config
        assertPermissionLocal(settings, dependencies.env || process.env)
        await (dependencies.writeSafety || assertLocalWriteSafety)(caseRecord)
        const marker = `E2E-DATA-${randomBytes(6).toString('hex')}`
        const owned = ownedPermissionResources(api, caseRecord, marker)
        try {
          const rolePayload = { name: marker, code: marker.replaceAll('-', '_'), sort: 99, status: 0, remark: marker }
          const role = owned.remember('role', dataOf(await api.postBusiness('/system/role/create', rolePayload)), rolePayload)
          await owned.read(role)
          if (caseId === 'AUTH-DATA-003') {
            await runDepartment(api, caseRecord, role, dependencies.sql || runReadOnlySql)
          } else {
            await runAmounts({ ...context, api, apiFactory, settings, owned, role, marker }, dependencies)
          }
        } finally {
          await owned.cleanup()
        }
      }
      await (dependencies.openRoute || openRoute)(page, '/system/role')
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, `data-permission-${caseId}`, record)
      result = { token, api }
    }
  } finally {
    caseRecord.remainingAssertions = caseRecord.catalogAssertions
      .filter((row) => row.status !== 'VERIFIED').map((row) => row.assertion)
    caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  }
  return { ...result, partial: result?.partial === true || !caseRecord.catalogComplete }
}

async function runDepartment (api, record, role, sql) {
  const depts = dataOf(await api.getBusiness('/system/dept/list'))
  map(record, 0, [check(record, '当前租户部门非空清单', Array.isArray(depts) && depts.length > 0)])
  const valid = Array.isArray(depts) && depts.find((row) => Number(row.status) === 0 && row.id != null)
  if (!valid) throw new Error('BLOCKED: no enabled tenant department')
  const absent = await sql('SELECT COUNT(*) FROM system_dept WHERE id=999999999 AND deleted=0')
  if (!absent.available || absent.rows?.[0]?.[0] !== '0') throw new Error('BLOCKED: nonexistent department prerequisite missing')
  const rejection = { code: 400, message: '数据范围包含不存在或不属于当前租户的部门' }
  const invalid = await api.request('POST', '/system/permission/assign-role-data-scope', {
    roleId: role.id, dataScope: 2, dataScopeDeptIds: [999999999]
  }, { expectedBusinessRejection: rejection })
  map(record, 1, [check(record, '不存在部门精确业务拒绝',
    isBusinessRejection(invalid) && invalid.code === rejection.code &&
      (invalid.msg ?? invalid.message) === rejection.message)])
  dataOf(await api.postBusiness('/system/permission/assign-role-data-scope', {
    roleId: role.id, dataScope: 2, dataScopeDeptIds: [valid.id]
  }))
  const persisted = dataOf(await api.getBusiness(`/system/role/get?id=${role.id}`))
  map(record, 2, [check(record, '自定义范围及部门编号完整回读',
    Number(persisted?.dataScope) === 2 && sameIds(persisted.dataScopeDeptIds, [valid.id]))])
}

async function runAmounts (context, dependencies) {
  const { api, apiFactory, caseId, caseRecord, settings, owned, role, marker } = context
  const selected = selectAmountMenus(dataOf(await api.getBusiness('/system/menu/list')),
    dataOf(await api.getBusiness('/system/menu/list-all-simple')))
  const node = check(caseRecord, '金额权限存在且直属角色管理', selected.underRole)
  const defaultMenus = dataOf(await api.getBusiness(`/system/permission/list-role-menus?roleId=${role.id}`))
  const defaults = check(caseRecord, '专属角色安全默认无菜单', sameIds(defaultMenus, []))
  if (caseId === 'AUTH-DATA-005') {
    map(caseRecord, 0, [node])
    map(caseRecord, 1, [defaults])
    map(caseRecord, 4, [], '尚未执行销售/采购真实导出文件、打印与汇总卡片完整金额对照；不以列表通过代替')
  }
  const menus = async (allowed, stage) => {
    await owned.read(role)
    const expected = allowed ? selected.granted : selected.base
    dataOf(await api.postBusiness('/system/permission/assign-role-menu', { roleId: role.id, menuIds: expected }))
    const actual = dataOf(await api.getBusiness(`/system/permission/list-role-menus?roleId=${role.id}`))
    return check(caseRecord, `${stage} 角色完整菜单回读`, sameIds(actual, expected))
  }
  await menus(false, 'BASE')
  dataOf(await api.postBusiness('/system/permission/assign-role-data-scope', {
    roleId: role.id, dataScope: 1, dataScopeDeptIds: []
  }))
  const suffix = randomBytes(6).toString('hex')
  const credentials = {
    username: `e2edata${suffix}`, nickname: marker, remark: marker,
    password: `Dt!${randomBytes(5).toString('hex')}`, sex: 0, postIds: [], roleIds: [role.id]
  }
  const user = owned.remember('user', dataOf(await api.postBusiness('/system/user/create', credentials)), credentials)
  await owned.read(user)
  const roles = dataOf(await api.getBusiness(`/system/permission/list-user-roles?userId=${user.id}`))
  if (!sameIds(roles, [role.id])) throw new Error('Owned user must have exactly its isolated role')
  const actor = await (dependencies.headedActor || openPermissionActor)({ ...context, credentials })
  try {
    const actorApi = apiFactory({ token: actor.token, record: context.record })
    const samples = []
    for (const kind of ['sale', 'purchase']) {
      const sample = await (dependencies.sql || runReadOnlySql)(
        `SELECT CAST(id AS CHAR),bill_no FROM erp_${kind}_order WHERE tenant_id=1 AND deleted=0 AND total_price<>0 AND total_count>0 ORDER BY id DESC LIMIT 1`)
      if (!sample.available || sample.rows?.length !== 1) throw new Error(`BLOCKED: no nonzero ${kind} order sample`)
      const sampleId = id(sample.rows[0][0])
      const query = new URLSearchParams({ pageNo: '1', pageSize: '100', billNo: sample.rows[0][1] })
      const endpoint = `/erp/${kind}-order/page?${query}`
      const orderPage = dataOf(await api.getBusiness(endpoint))
      const baseline = orderPage?.list?.find((row) => String(row.id) === sampleId)
      if (!orderAmountEvidence(orderPage?.list, baseline, true)) throw new Error(`BLOCKED: ${kind} baseline lacks nonempty numeric amounts/items/quantities`)
      samples.push({ kind, endpoint, baseline })
    }
    const transitions = []
    for (const [stage, allowed] of [['NO_AMOUNT', false], ['GRANTED', true], ['REVOKED', false]]) {
      const menuCheck = await menus(allowed, stage)
      if (caseId === 'AUTH-DATA-006' && stage !== 'NO_AMOUNT') {
        map(caseRecord, stage === 'GRANTED' ? 0 : 1, [menuCheck])
      }
      const info = dataOf(await actorApi.getBusiness('/system/auth/get-permission-info'))
      const permissions = info?.permissions?.filter(Boolean)
      const identity = check(caseRecord, `${stage} 同一发起人权限快照`,
        String(info?.user?.id) === user.id && sameIds(info.roles, [role.payload.code]) &&
        Array.isArray(permissions) && permissions.includes(amountPermission) === allowed &&
        permissions.every((permission) => selected.allowed.has(permission)))
      transitions.push(identity)
      for (const { kind, endpoint, baseline } of samples) {
        const rows = dataOf(await actorApi.getBusiness(endpoint))?.list
        const name = check(caseRecord, `${stage} ${kind} 原始响应金额及数量对照`,
          orderAmountEvidence(rows, baseline, allowed),
          `sampleId=${baseline.id}; sameToken=true; allowed=${allowed}; 原始金额不写入证据`)
        transitions.push(name)
      }
      if (caseId === 'AUTH-DATA-005' && stage === 'GRANTED') map(caseRecord, 2, transitions.slice(-3))
      if (caseId === 'AUTH-DATA-005' && stage === 'REVOKED') {
        map(caseRecord, 3, [defaults, ...transitions.filter((name) => !name.startsWith('GRANTED'))])
      }
    }
    if (caseId === 'AUTH-DATA-006') map(caseRecord, 2, [defaults, ...transitions])
    caseRecord.evidence.push(`本轮专属账号 ${user.id}、角色 ${role.id}；同一 headed 登录 token 连续 NO_AMOUNT/GRANTED/REVOKED；业务订单仅只读`)
  } finally {
    await actor.close()
  }
}

async function runCoverage (api, record) {
  const items = dataOf(await api.getBusiness('/system/data-permission/coverage'))
  const summary = dataOf(await api.getBusiness('/system/data-permission/coverage/summary'))
  if (!Array.isArray(items) || items.length === 0) throw new Error('Coverage list must be nonempty')
  const registered = items.filter((item) => item.status === 'REGISTERED')
  const risk = items.filter((item) => item.status === 'PLANNED' &&
    item.deptColumn == null && item.userColumn == null)
  const expected = {
    total: items.length, registered: registered.length,
    planned: items.filter((item) => item.status === 'PLANNED').length,
    notApplicable: items.filter((item) => item.status === 'NOT_APPLICABLE').length,
    riskCount: risk.length
  }
  map(record, 0, [check(record, '清单与汇总所有计数口径一致',
    Object.entries(expected).every(([key, count]) => summary?.[key] === count) &&
      expected.total === expected.registered + expected.planned + expected.notApplicable,
    JSON.stringify({ expected, summary }))])
  const table = (name) => items.find((item) => item.tableName === name)
  map(record, 1, [check(record, 'system 用户与部门通用规则',
    ['system_users', 'system_dept'].every((name) => table(name)?.status === 'REGISTERED' &&
      table(name)?.ownerRule?.includes('DeptDataPermissionRule')))])
  map(record, 2, [check(record, '库存沿用唯一 WMS 事实源边界',
    table('mes_stk_inventory')?.status === 'NOT_APPLICABLE' &&
      table('mes_stk_inventory')?.moduleCode === 'wms' && Boolean(table('mes_stk_inventory')?.ownerRule))])
  map(record, 3, [check(record, 'HRM 员工和 PMS 知识库部门归属列',
    ['hrm_employee', 'pms_knowledge_library_member'].every((name) =>
      table(name)?.status === 'REGISTERED' && table(name)?.deptColumn === 'dept_id'))])
  map(record, 4, [check(record, 'PMS 协作组仅负责人归属列',
    table('pms_project_group')?.status === 'REGISTERED' &&
      table('pms_project_group')?.deptColumn == null && table('pms_project_group')?.userColumn === 'user_id')])
  map(record, 5, [check(record, '逐项扫描计划项缺失归属字段风险', risk.length === 0 && summary?.riskCount === 0)])
}
