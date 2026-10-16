import { randomBytes } from 'node:crypto'

import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { observePage, login } from '../lib/browser.mjs'

export const PROCUREMENT_QUERY_PERMISSION = 'erp:purchase-order-request:query'
export const PROCUREMENT_CREATE_PERMISSION = 'erp:purchase-order-request:create'
export const PROCUREMENT_REQUEST_NOT_EXISTS = Object.freeze({
  code: -636,
  message: 'ERP 采购订单申请不存在',
  allowServiceCode: true
})

const STANDARD_PACKAGE_ID = '111'
const BASE_COMPONENTS = Object.freeze([
  'system/tenant-workbench/index',
  'system/user/index',
  'system/role/index',
  'system/dept/index',
  'system/enterprise-organization/index',
  'system/systemInit/index'
])

export const PROCUREMENT_ORGANIZATION_GATE = Object.freeze({
  supported: false,
  reason: '请购分页请求和查询 XML 未提供 sysOrgCode/组织数据范围过滤；当前只能证明租户隔离'
})

export const dataOf = (response) => {
  if (response === null || response === undefined) return response
  return Object.prototype.hasOwnProperty.call(Object(response), 'data')
    ? response.data
    : response
}

export const numericId = (value, label) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`BLOCKED: ${label}必须是安全整数或原字符串 ID`)
  }
  const text = String(value ?? '')
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`BLOCKED: ${label}未返回合法 ID`)
  return text
}

const flattenMenus = (rows, result = []) => {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    result.push(row)
    flattenMenus(row.children, result)
  }
  return result
}

const menuState = (menu) => Number(menu?.status) === 0 && Number(menu?.deleted || 0) === 0

const menuChain = (menu, byId) => {
  const chain = []
  const seen = new Set()
  let current = menu
  while (current) {
    if (typeof current.id === 'number' && !Number.isSafeInteger(current.id)) {
      return { chain, reason: '菜单编号必须是安全整数或原字符串 ID' }
    }
    if (typeof current.parentId === 'number' && !Number.isSafeInteger(current.parentId)) {
      return { chain, reason: '菜单父编号必须是安全整数或原字符串 ID' }
    }
    const id = String(current.id ?? '')
    if (!/^[1-9]\d*$/.test(id)) return { chain, reason: '菜单编号非法' }
    if (seen.has(id)) return { chain, reason: `菜单父链存在循环：${id}` }
    seen.add(id)
    chain.push(current)
    if (String(current.parentId ?? '0') === '0') return { chain }
    current = byId.get(String(current.parentId))
    if (!current) return { chain, reason: `菜单父级不存在：${chain.at(-1)?.parentId}` }
  }
  return { chain, reason: '菜单父链不完整' }
}

const permissionMenu = (menus, permission) => {
  const menu = menus.find((row) => row.permission === permission)
  if (!menu) throw new Error(`BLOCKED: 当前套餐菜单缺少 ${permission}`)
  return menu
}

/** Build a tenant package from package 111 without changing package 111 itself. */
export const buildProcurementIsolationPackage = ({ standardPackage, menus, assignableMenus = menus }) => {
  const sourceMenuIds = new Set((standardPackage?.menuIds || []).map(String))
  if (!sourceMenuIds.size) throw new Error('BLOCKED: 标准套餐 111 没有菜单授权')

  const flatMenus = flattenMenus(menus)
  const assignableIds = new Set(flattenMenus(assignableMenus).map((menu) => String(menu.id)))
  const byId = new Map(flatMenus.map((menu) => [String(menu.id), menu]))
  const baseMenus = BASE_COMPONENTS.map((component) =>
    flatMenus.find((menu) => menu.component === component)
  )
  const missingBase = BASE_COMPONENTS.filter((component, index) => !baseMenus[index])
  if (missingBase.length) throw new Error(`BLOCKED: 缺少平台基础菜单：${missingBase.join(',')}`)

  const requested = [
    ...baseMenus,
    permissionMenu(flatMenus, PROCUREMENT_QUERY_PERMISSION)
  ]
  const enabledMenuIds = new Set()
  for (const menu of requested) {
    const { chain, reason } = menuChain(menu, byId)
    if (reason) throw new Error(`BLOCKED: 采购隔离菜单父链无效：${reason}`)
    for (const node of chain) {
      if (!sourceMenuIds.has(String(node.id))) {
        throw new Error(`BLOCKED: 采购隔离菜单越过标准套餐 111：${node.id}`)
      }
      if (!menuState(node) || !assignableIds.has(String(node.id))) {
        throw new Error(`BLOCKED: 采购隔离菜单或父链不可分配：${node.id}`)
      }
      enabledMenuIds.add(String(node.id))
    }
  }
  return {
    menuIds: [...enabledMenuIds],
    queryPermission: PROCUREMENT_QUERY_PERMISSION,
    createPermissionAvailable: flatMenus.some((menu) =>
      menu.permission === PROCUREMENT_CREATE_PERMISSION && enabledMenuIds.has(String(menu.id)))
  }
}

const suffixOf = (marker = '') => {
  const value = String(marker).replace(/[^A-Za-z0-9]/g, '').slice(-10)
  return value || randomBytes(5).toString('hex').toUpperCase()
}

const tenantPayload = (suffix, packageId, password) => ({
  name: `E2E PROC ISO TEN ${suffix}`.slice(0, 30),
  contactName: 'CFOR E2E PROC',
  contactMobile: '19900000000',
  status: 0,
  packageId: String(packageId),
  expireTime: '2099-12-31T23:59:59',
  accountCount: 1,
  username: `e2eproc${suffix.toLowerCase()}`.slice(0, 30),
  password
})

export async function createProcurementIsolationTenant (api, { marker, password } = {}) {
  const standardPackage = dataOf(await api.getBusiness(
    `/system/tenant-package/get?id=${STANDARD_PACKAGE_ID}`
  ))
  const menus = dataOf(await api.getBusiness('/system/menu/list'))
  const assignableMenus = dataOf(await api.getBusiness('/system/menu/list-all-simple'))
  const plan = buildProcurementIsolationPackage({ standardPackage, menus, assignableMenus })
  const suffix = suffixOf(marker)
  const safePassword = password || `Proc!${randomBytes(5).toString('hex')}`
  if (typeof safePassword !== 'string' || safePassword.length < 4 || safePassword.length > 16) {
    throw new Error('BLOCKED: 采购隔离租户密码不符合正式接口的 4-16 位约束')
  }
  const packagePayload = {
    name: `E2E PROC ISO PKG ${suffix}`.slice(0, 30),
    status: 0,
    remark: `PROC-014 tenant isolation ${suffix}`,
    menuIds: plan.menuIds
  }
  const packageId = numericId(dataOf(await api.postBusiness(
    '/system/tenant-package/create', packagePayload
  )), '采购隔离套餐')
  const createdTenantPayload = tenantPayload(suffix, packageId, safePassword)
  try {
    const tenantId = numericId(dataOf(await api.postBusiness(
      '/system/tenant/create', createdTenantPayload
    )), '采购隔离租户')
    return {
      packageId,
      tenantId,
      packagePayload,
      tenantPayload: createdTenantPayload,
      tenant: {
        id: tenantId,
        name: createdTenantPayload.name,
        username: createdTenantPayload.username,
        password: safePassword
      },
      plan
    }
  } catch (error) {
    const cleanupErrors = []
    try {
      await api.putBusiness('/system/tenant-package/update', {
        ...packagePayload, id: packageId, status: 1
      })
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    throw mergeCleanupErrors(error, cleanupErrors, '采购隔离租户创建失败')
  }
}

export async function retireProcurementIsolationTenant (api, fixture) {
  if (!fixture) return
  const cleanupErrors = []
  try {
    await api.putBusiness('/system/tenant/update', {
      ...fixture.tenantPayload, id: fixture.tenantId, status: 1
    })
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await api.putBusiness('/system/tenant-package/update', {
      ...fixture.packagePayload, id: fixture.packageId, status: 1
    })
  } catch (error) {
    cleanupErrors.push(error)
  }
  const mergedError = mergeCleanupErrors(null, cleanupErrors, '采购隔离租户退役失败')
  if (mergedError) throw mergedError
}

const mergeCleanupErrors = (primaryError, cleanupErrors, label) => {
  const errors = [primaryError, ...cleanupErrors].filter(Boolean)
  if (!errors.length) return null
  if (errors.length === 1) return errors[0]
  return new AggregateError(
    errors,
    `${label}；清理错误：${errors.map((error) => error.message || String(error)).join('；')}`
  )
}

/**
 * Run the isolated tenant session with response draining before context close
 * and token logout after the browser session is no longer active.
 */
export async function withProcurementTenant (context, tenant, run, dependencies = {}) {
  const browser = dependencies.browser || context.page.context().browser()
  const observe = dependencies.observePage || observePage
  const loginWith = dependencies.login || login
  const apiFactory = dependencies.createApiClient || createApiClient
  const isolated = await browser.newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
  })
  let page
  let tenantApi
  let capture
  let result
  let operationError
  const cleanupErrors = []
  try {
    page = await isolated.newPage()
    capture = observe(page, context.record)
    const auth = await loginWith(page, {
      credentials: { tenantName: tenant.name, username: tenant.username, password: tenant.password },
      returnContext: true,
      check: context.check
    })
    if (String(auth?.tenantId) !== String(tenant.id)) {
      throw new Error(`BLOCKED: 采购隔离租户登录身份不一致：${auth?.tenantId} != ${tenant.id}`)
    }
    tenantApi = apiFactory({ token: auth.token, tenantId: tenant.id, record: context.record })
    result = await run({ page, api: tenantApi, auth })
  } catch (error) {
    operationError = error
  } finally {
    try {
      await capture?.flushResponses()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    try {
      await page?.close()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    try {
      await isolated.close()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    try {
      if (tenantApi) await tenantApi.postBusiness('/system/auth/logout')
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
  }
  const mergedError = mergeCleanupErrors(operationError, cleanupErrors, '采购隔离租户会话失败')
  if (mergedError) throw mergedError
  return result
}

export const procurementPageRows = (response) => {
  const pageData = dataOf(response)
  if (!pageData || typeof pageData !== 'object' || Array.isArray(pageData)) {
    throw new Error('BLOCKED: 采购请购分页响应缺少明确 records/list 数组')
  }
  if (Array.isArray(pageData.records)) return pageData.records
  if (Array.isArray(pageData.list)) return pageData.list
  throw new Error('BLOCKED: 采购请购分页响应缺少明确 records/list 数组')
}

/**
 * Verify a tenant-1 request cannot be read by a real isolated tenant login.
 * This function is opt-in and is not called by the current procurement suite.
 */
export async function verifyProcurementTenantIsolation ({
  context,
  api,
  tenant1Fixture,
  dependencies = {}
}) {
  if (!context?.page || !context?.record) throw new Error('BLOCKED: 采购租户隔离需要真实主会话')
  const requestId = numericId(tenant1Fixture?.id, 'tenant1 请购单')
  const billNo = String(tenant1Fixture?.billNo || '').trim()
  const createTenant = dependencies.createTenant || createProcurementIsolationTenant
  const retireTenant = dependencies.retireTenant || retireProcurementIsolationTenant
  const withTenant = dependencies.withTenant || withProcurementTenant
  let tenantFixture
  let result
  let operationError
  try {
    tenantFixture = await createTenant(api, {
      marker: `PROC014-${randomBytes(5).toString('hex').toUpperCase()}`
    })
    result = await withTenant(context, tenantFixture.tenant, async ({ api: tenantApi, auth }) => {
      if (String(auth?.tenantId) !== String(tenantFixture.tenantId)) {
        throw new Error(`BLOCKED: 采购隔离租户登录身份不一致：${auth?.tenantId} != ${tenantFixture.tenantId}`)
      }
      const detail = await tenantApi.get(
        `/erp/purchase/order/request/get?id=${encodeURIComponent(requestId)}`,
        { expectedBusinessRejection: PROCUREMENT_REQUEST_NOT_EXISTS }
      )
      const hidden = detail?.data == null &&
        matchesExpectedBusinessRejection(detail, PROCUREMENT_REQUEST_NOT_EXISTS)
      if (!hidden) throw new Error('第二租户可以读取 tenant1 请购单详情')
      let pageHidden = true
      let pageRows = []
      if (billNo) {
        const page = await tenantApi.get(
          `/erp/purchase/order/request/page?pageNo=1&pageSize=100&billNo=${encodeURIComponent(billNo)}`
        )
        pageRows = procurementPageRows(page)
        pageHidden = isBusinessSuccess(page) && !pageRows.some((row) =>
          String(row?.id) === requestId || String(row?.billNo) === billNo)
        if (!pageHidden) throw new Error('第二租户请购分页泄露 tenant1 单据')
      }
      return {
        tenantId: String(tenantFixture.tenantId),
        requestId,
        billNo: billNo || undefined,
        hidden,
        detailCode: detail.code,
        detailMessage: detail.msg || detail.message,
        pageHidden,
        pageRowCount: pageRows.length
      }
    })
  } catch (error) {
    operationError = error
  } finally {
    if (tenantFixture) {
      try {
        await retireTenant(api, tenantFixture)
      } catch (cleanupError) {
        operationError = mergeCleanupErrors(operationError, [cleanupError], '采购隔离租户退役失败')
      }
    }
  }
  if (operationError) throw operationError
  return result
}

export const procurementOrganizationGateStatus = () => ({
  ...PROCUREMENT_ORGANIZATION_GATE,
  evidence: [
    'PurchaseOrderRequestPageReqVO 未提供 sysOrgCode/orgId 过滤字段',
    'PurchaseOrderRequestMapper.xml whereCondition 未包含 sys_org_code 组织条件',
    '采购请购查询链路未发现 @DataPermission 组织范围注解'
  ]
})
