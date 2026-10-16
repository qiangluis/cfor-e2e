import { randomBytes } from 'node:crypto'

import { createApiClient, isBusinessRejection, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { observePage, login } from '../lib/browser.mjs'

const STANDARD_PACKAGE_ID = '111'
const BASE_COMPONENTS = Object.freeze([
  'system/tenant-workbench/index',
  'system/user/index',
  'system/role/index',
  'system/dept/index',
  'system/enterprise-organization/index',
  'system/systemInit/index'
])

export const IOT_ISOLATION_PERMISSIONS = Object.freeze([
  'iot:product:create', 'iot:product:update', 'iot:product:delete', 'iot:product:query',
  'iot:product-category:create', 'iot:product-category:delete', 'iot:product-category:query',
  'iot:thing-model:create', 'iot:thing-model:update', 'iot:thing-model:delete', 'iot:thing-model:query',
  'iot:device:create', 'iot:device:update', 'iot:device:delete', 'iot:device:query',
  'iot:device:message-query', 'iot:device:message-send', 'iot:device:property-query',
  'iot:alert-config:create', 'iot:alert-config:update', 'iot:alert-config:delete', 'iot:alert-config:query',
  'iot:alert-record:query', 'iot:alert-record:process',
  'iot:scene-rule:create', 'iot:scene-rule:update', 'iot:scene-rule:delete', 'iot:scene-rule:query',
  'system:notify-template:create', 'system:notify-template:delete', 'system:notify-template:query'
])

const dataOf = (response) => response && typeof response === 'object' &&
  Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response

const numericId = (value, label) => {
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
    const id = String(current.id ?? '')
    if (!/^[1-9]\d*$/.test(id)) return { chain, reason: '菜单编号非法' }
    if (!seen.add(id)) return { chain, reason: `菜单父链存在循环：${id}` }
    chain.push(current)
    if (String(current.parentId ?? '0') === '0') return { chain }
    current = byId.get(String(current.parentId))
    if (!current) return { chain, reason: `菜单父级不存在：${chain.at(-1)?.parentId}` }
  }
  return { chain, reason: '菜单父链不完整' }
}

/** Build only enabled, assignable IoT and notification menu chains from package 111. */
export const buildIotIsolationPackage = ({ standardPackage, menus, assignableMenus = menus }) => {
  const sourceMenuIds = new Set((standardPackage?.menuIds || []).map(String))
  if (!sourceMenuIds.size) throw new Error('BLOCKED: 标准套餐 111 没有菜单授权')
  const flatMenus = flattenMenus(menus)
  const assignableIds = new Set(flattenMenus(assignableMenus).map((menu) => String(menu.id)))
  const byId = new Map(flatMenus.map((menu) => [String(menu.id), menu]))
  const requested = []
  for (const component of BASE_COMPONENTS) {
    const menu = flatMenus.find((row) => row.component === component)
    if (!menu) throw new Error(`BLOCKED: 缺少平台基础菜单：${component}`)
    requested.push(menu)
  }
  for (const permission of IOT_ISOLATION_PERMISSIONS) {
    const menu = flatMenus.find((row) => row.permission === permission)
    if (!menu) throw new Error(`BLOCKED: 当前菜单缺少 ${permission}`)
    requested.push(menu)
  }

  const menuIds = new Set()
  for (const menu of requested) {
    const { chain, reason } = menuChain(menu, byId)
    if (reason) throw new Error(`BLOCKED: IoT 隔离菜单父链无效：${reason}`)
    for (const node of chain) {
      const id = String(node.id)
      if (!sourceMenuIds.has(id)) throw new Error(`BLOCKED: IoT 隔离菜单越过标准套餐 111：${id}`)
      if (!menuState(node) || !assignableIds.has(id)) {
        throw new Error(`BLOCKED: IoT 隔离菜单或父链不可分配：${id}`)
      }
      menuIds.add(id)
    }
  }
  return { menuIds: [...menuIds], permissions: [...IOT_ISOLATION_PERMISSIONS] }
}

const suffixOf = (marker = '') => {
  const value = String(marker).replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase()
  return value || randomBytes(5).toString('hex').toUpperCase()
}

const mergeErrors = (primary, errors, label) => {
  const all = [primary, ...errors].filter(Boolean)
  if (!all.length) return null
  if (all.length === 1) return all[0]
  return new AggregateError(all, `${label}；清理错误：${all.map((item) => item.message || String(item)).join('；')}`)
}

const tenantPayload = (suffix, packageId, password) => ({
  name: `E2E IOT ISO TEN ${suffix}`.slice(0, 30),
  contactName: 'CFOR E2E IOT',
  contactMobile: '19900000000',
  status: 0,
  packageId: String(packageId),
  expireTime: '2099-12-31T23:59:59',
  accountCount: 1,
  username: `e2eiot${suffix.toLowerCase()}`.slice(0, 30),
  password
})

const visitTenantOptions = (tenantId) => ({
  headers: { 'visit-tenant-id': String(tenantId) }
})

const createIotIsolationDepartment = async (api, tenantId, suffix) => {
  const payload = {
    name: `E2E IOT DEPT ${suffix}`.slice(0, 30),
    code: `E2E-IOT-${suffix}`.slice(0, 30),
    parentId: '0',
    sort: 9996,
    status: 0
  }
  const options = visitTenantOptions(tenantId)
  const departmentId = numericId(dataOf(await api.postBusiness(
    '/system/dept/create', payload, options
  )), 'IoT 隔离部门')
  const saved = dataOf(await api.getBusiness(
    `/system/dept/get?id=${departmentId}`, options
  ))
  if (String(saved?.id) !== departmentId || saved.name !== payload.name ||
      String(saved.parentId) !== '0' || Number(saved.status) !== 0) {
    throw new Error('IoT 隔离部门回读不一致')
  }
  return { id: departmentId, payload }
}

const prepareIotIsolationScope = async (api, tenantId, tenantUsername, department, suffix) => {
  const options = visitTenantOptions(tenantId)
  const userPage = dataOf(await api.getBusiness(
    `/system/user/page?pageNo=1&pageSize=100&username=${encodeURIComponent(tenantUsername)}`,
    options
  ))
  const users = Array.isArray(userPage?.list) ? userPage.list : userPage?.records
  const adminUser = Array.isArray(users)
    ? users.find((item) => item.username === tenantUsername)
    : null
  const adminUserId = numericId(adminUser?.id, 'IoT 隔离租户管理员')

  const rolePage = dataOf(await api.getBusiness(
    '/system/role/page?pageNo=1&pageSize=100&code=tenant_admin', options
  ))
  const roles = Array.isArray(rolePage?.list) ? rolePage.list : rolePage?.records
  const adminRole = Array.isArray(roles)
    ? roles.find((item) => item.code === 'tenant_admin')
    : null
  const adminRoleId = numericId(adminRole?.id, 'IoT 隔离租户管理员角色')

  const rolePayload = {
    name: `E2E IOT SCOPE ${suffix}`.slice(0, 30),
    code: `e2eiotscope${suffix.toLowerCase()}`.slice(0, 100),
    sort: 9996,
    status: 0,
    remark: `IOT-002 department scope ${suffix}`
  }
  const roleId = numericId(dataOf(await api.postBusiness(
    '/system/role/create', rolePayload, options
  )), 'IoT 隔离数据范围角色')
  await api.postBusiness('/system/permission/assign-role-data-scope', {
    roleId, dataScope: 2, dataScopeDeptIds: [department.id]
  }, options)
  await api.postBusiness('/system/permission/assign-user-role', {
    userId: adminUserId, roleIds: [adminRoleId, roleId]
  }, options)
  return {
    adminUserId,
    adminRoleId,
    role: { id: roleId, payload: rolePayload }
  }
}

export async function createIotIsolationTenant (api, { marker, password } = {}) {
  const standardPackage = dataOf(await api.getBusiness(
    `/system/tenant-package/get?id=${STANDARD_PACKAGE_ID}`
  ))
  const menus = dataOf(await api.getBusiness('/system/menu/list'))
  const assignableMenus = dataOf(await api.getBusiness('/system/menu/list-all-simple'))
  const plan = buildIotIsolationPackage({ standardPackage, menus, assignableMenus })
  const suffix = suffixOf(marker)
  const safePassword = password || `Iot!${randomBytes(5).toString('hex')}`
  if (safePassword.length < 4 || safePassword.length > 16) {
    throw new Error('BLOCKED: IoT 隔离租户密码不符合正式接口的 4-16 位约束')
  }
  const packagePayload = {
    name: `E2E IOT ISO PKG ${suffix}`.slice(0, 30),
    status: 0,
    remark: `IOT-002 tenant isolation ${suffix}`,
    menuIds: plan.menuIds
  }
  const packageId = numericId(dataOf(await api.postBusiness(
    '/system/tenant-package/create', packagePayload
  )), 'IoT 隔离套餐')
  const createdTenantPayload = tenantPayload(suffix, packageId, safePassword)
  let tenantId
  let department
  let scope
  try {
    tenantId = numericId(dataOf(await api.postBusiness(
      '/system/tenant/create', createdTenantPayload
    )), 'IoT 隔离租户')
    department = await createIotIsolationDepartment(api, tenantId, suffix)
    scope = await prepareIotIsolationScope(
      api, tenantId, createdTenantPayload.username, department, suffix
    )
    return {
      packageId,
      tenantId,
      packagePayload,
      tenantPayload: createdTenantPayload,
      department,
      scope,
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
    if (tenantId || department || scope) {
      try {
        await retireIotIsolationTenant(api, {
          packageId,
          tenantId,
          packagePayload,
          tenantPayload: createdTenantPayload,
          department,
          scope
        })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    } else {
      try {
        await api.putBusiness('/system/tenant-package/update', {
          ...packagePayload, id: packageId, status: 1
        })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    throw mergeErrors(error, cleanupErrors, 'IoT 隔离租户创建失败')
  }
}

export async function retireIotIsolationTenant (api, fixture, caseRecord) {
  if (!fixture) return
  const errors = []
  if (fixture.scope?.role?.id) {
    try {
      const options = visitTenantOptions(fixture.tenantId)
      if (fixture.scope.adminUserId && fixture.scope.adminRoleId) {
        await api.postBusiness('/system/permission/assign-user-role', {
          userId: fixture.scope.adminUserId,
          roleIds: [fixture.scope.adminRoleId]
        }, options)
      }
      await api.putBusiness('/system/role/update', {
        ...fixture.scope.role.payload, id: fixture.scope.role.id, status: 1
      }, options)
      const saved = dataOf(await api.getBusiness(
        `/system/role/get?id=${fixture.scope.role.id}`, options
      ))
      if (String(saved?.id) !== String(fixture.scope.role.id) || Number(saved.status) !== 1) {
        throw new Error('IoT 隔离数据范围角色停用状态回读不一致')
      }
      caseRecord?.evidence?.push(`清理：已撤销并停用 IoT 隔离数据范围角色 ${fixture.scope.role.id}`)
    } catch (error) {
      errors.push(`停用 IoT 隔离数据范围角色失败：${error.message}`)
    }
  }
  if (fixture.department?.id) {
    try {
      const options = visitTenantOptions(fixture.tenantId)
      await api.putBusiness('/system/dept/update', {
        ...fixture.department.payload, id: fixture.department.id, status: 1
      }, options)
      const saved = dataOf(await api.getBusiness(
        `/system/dept/get?id=${fixture.department.id}`, options
      ))
      if (String(saved?.id) !== String(fixture.department.id) || Number(saved.status) !== 1) {
        throw new Error('IoT 隔离部门停用状态回读不一致')
      }
      caseRecord?.evidence?.push(`清理：已停用 IoT 隔离部门 ${fixture.department.id}`)
    } catch (error) {
      errors.push(`停用 IoT 隔离部门失败：${error.message}`)
    }
  }
  if (fixture.tenantId) {
    try {
      await api.putBusiness('/system/tenant/update', {
        ...fixture.tenantPayload, id: fixture.tenantId, status: 1
      })
      const saved = dataOf(await api.getBusiness(`/system/tenant/get?id=${fixture.tenantId}`))
      if (String(saved?.id) !== String(fixture.tenantId) || saved.status !== 1) {
        throw new Error('专属租户停用状态回读不一致')
      }
    } catch (error) {
      errors.push(`停用专属租户失败：${error.message}`)
    }
  }
  try {
    await api.putBusiness('/system/tenant-package/update', {
      ...fixture.packagePayload, id: fixture.packageId, status: 1
    })
    const saved = dataOf(await api.getBusiness(`/system/tenant-package/get?id=${fixture.packageId}`))
    if (String(saved?.id) !== String(fixture.packageId) || saved.status !== 1) {
      throw new Error('专属套餐停用状态回读不一致')
    }
  } catch (error) {
    errors.push(`停用专属套餐失败：${error.message}`)
  }
  if (errors.length) {
    caseRecord?.checks?.push({ name: '清理：停用 IoT 专属租户与套餐', passed: false, details: errors.join('；') })
    throw new Error(errors.join('；'))
  }
  caseRecord?.evidence?.push(`清理：已停用 IoT 专属租户 ${fixture.tenantId} 与专属套餐 ${fixture.packageId}`)
}

export async function withIotIsolationTenant (context, tenant, run, dependencies = {}) {
  const browser = dependencies.browser || context.page.context().browser()
  const loginWith = dependencies.login || login
  const apiFactory = dependencies.createApiClient || createApiClient
  const observe = dependencies.observePage || observePage
  const isolated = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' })
  let page
  let capture
  let tenantApi
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
      throw new Error(`BLOCKED: IoT 隔离租户登录身份不一致：${auth?.tenantId} != ${tenant.id}`)
    }
    tenantApi = apiFactory({ token: auth.token, tenantId: tenant.id, record: context.record })
    result = await run({ page, api: tenantApi, auth })
  } catch (error) {
    operationError = error
  } finally {
    try { await capture?.flushResponses() } catch (error) { cleanupErrors.push(error) }
    try { await page?.close() } catch (error) { cleanupErrors.push(error) }
    try { await isolated.close() } catch (error) { cleanupErrors.push(error) }
    try { if (tenantApi) await tenantApi.postBusiness('/system/auth/logout') } catch (error) { cleanupErrors.push(error) }
  }
  const merged = mergeErrors(operationError, cleanupErrors, 'IoT 隔离租户会话失败')
  if (merged) throw merged
  return result
}

const pageRows = (response, label) => {
  const payload = dataOf(response)
  const rows = Array.isArray(payload?.list) ? payload.list : Array.isArray(payload?.records) ? payload.records : null
  if (!payload || !rows || !Number.isSafeInteger(payload.total)) throw new Error(`${label}分页响应无有效 list/records`)
  return rows
}

const rows = (response, label) => {
  const payload = dataOf(response)
  if (!Array.isArray(payload)) throw new Error(`${label}响应不是数组`)
  return payload
}

const waitFor = async (load, predicate, label, { timeoutMs = 15000, intervalMs = 300 } = {}) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() <= deadline) {
    last = await load()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${label}等待超时：${JSON.stringify(last)?.slice(0, 500)}`)
}

const addCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`IOT-002 ${name}`)
}

const track = (resources, id, label, cleanup) => {
  const normalized = numericId(id, label)
  resources.push({ id: normalized, label, cleanup })
  return normalized
}

const createCategory = async (api, resources, marker) => {
  const id = track(resources, dataOf(await api.postBusiness('/iot/product-category/create', {
    name: marker,
    sort: 1,
    status: 0,
    description: 'E2E-IOT-002 second tenant isolated product category'
  })), '第二租户 IoT 产品分类', async (value) => {
    if (dataOf(await api.getBusiness(`/iot/product-category/get?id=${value}`))) {
      await api.deleteBusiness(`/iot/product-category/delete?id=${value}`)
    }
  })
  const category = dataOf(await api.getBusiness(`/iot/product-category/get?id=${id}`))
  if (String(category?.id) !== id || category.name !== marker || Number(category.status) !== 0) {
    throw new Error('第二租户产品分类回读不一致')
  }
  return category
}

const createProduct = async (api, resources, marker, category) => {
  if (!category?.id) throw new Error('BLOCKED: 第二租户产品分类未准备完成')
  const body = {
    name: marker,
    categoryId: category.id,
    deviceType: 0,
    netType: 2,
    locationType: 3,
    protocolType: 'mqtt',
    serializeType: 'json',
    registerEnabled: false,
    description: 'E2E-IOT-002 second tenant isolation'
  }
  const id = track(resources, dataOf(await api.postBusiness('/iot/product/create', body)), '第二租户 IoT 产品', async (value) => {
    const existing = dataOf(await api.getBusiness(`/iot/product/get?id=${value}`))
    if (!existing) return
    if (existing.status === 1) await api.putBusiness(`/iot/product/update-status?id=${value}&status=0`)
    await api.deleteBusiness(`/iot/product/delete?id=${value}`)
  })
  const product = dataOf(await api.getBusiness(`/iot/product/get?id=${id}`))
  if (String(product?.id) !== id || product.name !== marker) throw new Error('第二租户产品回读不一致')
  return product
}

const createProperty = async (api, resources, product, identifier, name) => {
  const body = {
    productId: product.id,
    productKey: product.productKey,
    identifier,
    name,
    description: 'E2E-IOT-002 second tenant property',
    type: 1,
    property: {
      identifier, name, accessMode: 'rw', required: false, dataType: 'double',
      dataSpecs: { dataType: 'double', min: '-100', max: '1000', unit: 'C', unitName: '摄氏度' }
    }
  }
  const id = track(resources, dataOf(await api.postBusiness('/iot/thing-model/create', body)), '第二租户 IoT 物模型', async (value) => {
    const existing = dataOf(await api.getBusiness(`/iot/thing-model/get?id=${value}`))
    if (!existing) return
    const owner = dataOf(await api.getBusiness(`/iot/product/get?id=${existing.productId}`))
    if (owner?.status === 1) await api.putBusiness(`/iot/product/update-status?id=${owner.id}&status=0`)
    await api.deleteBusiness(`/iot/thing-model/delete?id=${value}`)
  })
  const model = dataOf(await api.getBusiness(`/iot/thing-model/get?id=${id}`))
  if (String(model?.id) !== id || model.identifier !== identifier || String(model.productId) !== String(product.id)) {
    throw new Error('第二租户物模型回读不一致')
  }
  return model
}

const createDevice = async (api, resources, product, marker, departmentId) => {
  if (!departmentId) throw new Error('BLOCKED: 第二租户 IoT 设备必须绑定专属部门')
  const id = track(resources, dataOf(await api.postBusiness('/iot/device/create', {
    productId: product.id, deviceName: marker, locationType: 3,
    productionLineId: '', deptId: departmentId
  })), '第二租户 IoT 设备', async (value) => {
    const existing = dataOf(await api.getBusiness(`/iot/device/get?id=${value}`))
    if (existing) await api.deleteBusiness(`/iot/device/delete?id=${value}`)
  })
  const device = dataOf(await api.getBusiness(`/iot/device/get?id=${id}`))
  if (String(device?.id) !== id || String(device.productId) !== String(product.id) ||
      device.deviceName !== marker || String(device.deptId) !== String(departmentId)) {
    throw new Error('第二租户设备回读不一致')
  }
  return device
}

const sendProperty = (api, device, identifier, value, sequenceNo) => api.postBusiness('/iot/device/message/send', {
  method: 'thing.property.post', params: { [identifier]: value }, deviceId: device.id,
  reportTime: new Date(Date.now() - 5000).toISOString().slice(0, 19), pointVersion: 1,
  sequenceNo, qualityCode: 0, preserveReportTime: true
})

const createAlertFixture = async (api, resources, product, device, identifier) => {
  const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
  const userId = numericId(profile?.id, '第二租户告警接收用户')
  const templateMarker = `E2E-IOT-002-NOTIFY-${suffixOf()}`
  const templateCode = templateMarker.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  const templateId = track(resources, dataOf(await api.postBusiness('/system/notify-template/create', {
    name: templateMarker, code: templateCode, type: 1, nickname: templateMarker,
    content: `${templateMarker} {configName} {deviceName}`, status: 0,
    remark: 'E2E-IOT-002 second tenant alert'
  })), '第二租户告警通知模板', async (value) => {
    if (dataOf(await api.getBusiness(`/system/notify-template/get?id=${value}`))) {
      await api.deleteBusiness(`/system/notify-template/delete?id=${value}`)
    }
  })
  const sceneRuleId = track(resources, dataOf(await api.postBusiness('/iot/scene-rule/create', {
    name: `E2E-IOT-002-SCENE-${suffixOf()}`,
    description: 'E2E-IOT-002 second tenant alert scene', status: 0,
    triggers: [{ type: 2, productId: product.id, deviceId: device.id, identifier, operator: '=', value: '80' }],
    actions: [{ type: 100, productId: product.id, deviceId: device.id }]
  })), '第二租户场景规则', async (value) => {
    if (dataOf(await api.getBusiness(`/iot/scene-rule/get?id=${value}`))) {
      await api.deleteBusiness(`/iot/scene-rule/delete?id=${value}`)
    }
  })
  const configId = track(resources, dataOf(await api.postBusiness('/iot/alert-config/create', {
    name: `E2E-IOT-002-CONFIG-${suffixOf()}`,
    description: 'E2E-IOT-002 second tenant alert config', level: 2, status: 0,
    sceneRuleIds: [sceneRuleId], receiveUserIds: [userId], receiveTypes: [3],
    notifyTemplateCode: templateCode, durationSeconds: 0, combineMode: 'OR', combineExpression: '',
    suppressSeconds: 0, escalateSeconds: 0, escalateLevel: 3
  })), '第二租户告警配置', async (value) => {
    if (dataOf(await api.getBusiness(`/iot/alert-config/get?id=${value}`))) {
      await api.deleteBusiness(`/iot/alert-config/delete?id=${value}`)
    }
  })
  const config = dataOf(await api.getBusiness(`/iot/alert-config/get?id=${configId}`))
  if (String(config?.id) !== configId || !config.sceneRuleIds?.map(String).includes(sceneRuleId)) {
    throw new Error('第二租户告警配置回读不一致')
  }
  return { templateId, templateCode, sceneRuleId, configId }
}

const NON_LEAKING_NOT_FOUND = Object.freeze([
  { code: 1050001000, message: '产品不存在' },
  { code: 1050003000, message: '设备不存在' },
  { code: 1050012000, message: '场景联动不存在' },
  { code: 1050013000, message: 'IoT 告警配置不存在' },
  { code: 1050014000, message: 'IoT 告警记录不存在' }
])

const isNonLeakingNotFound = (response) => NON_LEAKING_NOT_FOUND.some((expected) =>
  matchesExpectedBusinessRejection(response, { ...expected, allowServiceCode: true })) ||
  (response?.code === 500 && [response?.msg, response?.message].includes('设备不存在'))

const hiddenDetail = async (api, path) => {
  const response = await api.get(path, {
    expectedBusinessRejection: { code: 403, message: '您无权访问该租户的数据', allowServiceCode: true }
  })
  const hiddenByNull = isBusinessSuccess(response) && dataOf(response) == null
  const hiddenByEmptyList = isBusinessSuccess(response) && Array.isArray(dataOf(response)) && dataOf(response).length === 0
  const hiddenByRejection = response?.code === 403 && matchesExpectedBusinessRejection(response, {
    code: 403, message: '您无权访问该租户的数据', allowServiceCode: true
  })
  if (!hiddenByNull && !hiddenByEmptyList && !hiddenByRejection && !isNonLeakingNotFound(response)) {
    throw new Error(`主租户读取到第二租户数据或返回未约定错误：${path}`)
  }
  return { response, hidden: true }
}

const hiddenPage = async (api, path, ids) => {
  const response = await api.get(path, {
    expectedBusinessRejection: { code: 403, message: '您无权访问该租户的数据', allowServiceCode: true }
  })
  if (response?.code === 403) {
    if (!matchesExpectedBusinessRejection(response, {
      code: 403, message: '您无权访问该租户的数据', allowServiceCode: true
    })) throw new Error(`主租户分页返回非租户隔离拒绝：${path}`)
    return { response, hidden: true, count: 0 }
  }
  if (isNonLeakingNotFound(response)) {
    return { response, hidden: true, count: 0 }
  }
  const list = pageRows(response, path)
  const leaked = list.some((row) => ids.some((id) => String(row?.id) === String(id)))
  if (leaked) throw new Error(`主租户分页泄露第二租户数据：${path}`)
  return { response, hidden: true, count: list.length }
}

export const assertCrossWriteRejected = async (api, method, path, body) => {
  const response = await api.request(method, path, body)
  if (isBusinessSuccess(response)) {
    throw new Error(`主租户跨租户写入返回成功，不能当作拒绝：${method} ${path}`)
  }
  const tenantRejected = response?.code === 403 && matchesExpectedBusinessRejection(response, {
    code: 403,
    message: '您无权访问该租户的数据',
    allowServiceCode: true
  })
  const hiddenNotFound = isNonLeakingNotFound(response)
  if (!tenantRejected && !hiddenNotFound) {
    throw new Error(`主租户跨租户写入不是明确租户拒绝或非泄漏不存在：${method} ${path}`)
  }
  return response
}

const cleanupResources = async (api, resources, caseRecord) => {
  const errors = []
  for (const resource of [...resources].reverse()) {
    try {
      await resource.cleanup(resource.id)
    } catch (error) {
      errors.push(`${resource.label} ${resource.id}: ${error.message || String(error)}`)
    }
  }
  if (errors.length) {
    caseRecord.checks.push({ name: '清理：第二租户 IoT 产品、物模型、设备、消息和告警夹具', passed: false, details: errors.join('；') })
    throw new Error(`第二租户 IoT 夹具清理失败：${errors.join('；')}`)
  }
  caseRecord.evidence.push('清理：已按反向创建顺序删除第二租户 IoT 产品、物模型、设备、通知模板、场景规则和告警配置')
}

/** Run the real second-tenant IoT product/message/property/alert isolation closure. */
export async function runIotTenantIsolation ({ context, api, caseRecord }, dependencies = {}) {
  if (!context?.page || !context?.record) throw new Error('BLOCKED: IOT-002 真租户隔离需要主租户浏览器会话')
  const createTenant = dependencies.createTenant || createIotIsolationTenant
  const retireTenant = dependencies.retireTenant || retireIotIsolationTenant
  const withTenant = dependencies.withTenant || withIotIsolationTenant
  let tenantFixture
  let operationError
  let result
  try {
    tenantFixture = await createTenant(api, { marker: `IOT002-${suffixOf()}` })
    result = await withTenant(context, tenantFixture.tenant, async ({ api: tenantApi, auth }) => {
      if (String(auth?.tenantId) !== String(tenantFixture.tenantId)) {
        throw new Error(`BLOCKED: 第二租户登录身份不一致：${auth?.tenantId} != ${tenantFixture.tenantId}`)
      }
      const resources = []
      let innerError
      let innerResult
      try {
        const suffix = suffixOf()
        const category = await createCategory(
          tenantApi, resources, `E2E-IOT-002-CATEGORY-${suffix}`
        )
        const product = await createProduct(
          tenantApi, resources, `E2E-IOT-002-PRODUCT-${suffix}`, category
        )
        const identifier = `e2e_iot002_${suffix.toLowerCase()}`
        await createProperty(tenantApi, resources, product, identifier, `E2E-IOT-002-PROPERTY-${suffix}`)
        await tenantApi.putBusiness(`/iot/product/update-status?id=${product.id}&status=1`)
        const published = dataOf(await tenantApi.getBusiness(`/iot/product/get?id=${product.id}`))
        if (published?.status !== 1) throw new Error('第二租户产品发布回读失败')
        const device = await createDevice(
          tenantApi, resources, product, `E2E-IOT-002-DEVICE-${suffix}`, tenantFixture.department?.id
        )
        const alert = await createAlertFixture(tenantApi, resources, product, device, identifier)
        const sequenceNo = Number(`2${Date.now().toString().slice(-7)}`)
        await sendProperty(tenantApi, device, identifier, 80, sequenceNo)
        const ownMessages = await waitFor(
          async () => pageRows(await tenantApi.getBusiness(`/iot/device/message/page?pageNo=1&pageSize=100&deviceId=${device.id}`), '第二租户消息'),
          (list) => list.some((row) => String(row.sequenceNo) === String(sequenceNo)),
          '第二租户属性消息消费'
        )
        const ownLatest = rows(await tenantApi.getBusiness(`/iot/device/property/get-latest?deviceId=${device.id}`), '第二租户最新属性')
        const ownHistory = rows(await tenantApi.getBusiness(`/iot/device/property/history-list?deviceId=${device.id}&identifier=${identifier}`), '第二租户属性历史')
        const ownAlertRows = await waitFor(
          async () => pageRows(await tenantApi.getBusiness(`/iot/alert-record/page?pageNo=1&pageSize=100&deviceId=${device.id}&configId=${alert.configId}`), '第二租户告警'),
          (list) => list.length === 1,
          '第二租户告警生成'
        )
        const alertRecord = ownAlertRows[0]
        addCheck(caseRecord, '第二真实租户登录身份与新建产品、设备回读一致',
          String(tenantFixture.tenantId) === String(auth.tenantId) && String(product.id) !== '' && String(device.productId) === String(product.id),
          `tenantId=${tenantFixture.tenantId}; product=${product.id}; device=${device.id}`)
        addCheck(caseRecord, '第二租户可见自有产品、设备、属性消息、最新属性、属性历史和告警',
          ownMessages.some((row) => String(row.sequenceNo) === String(sequenceNo)) &&
          ownLatest.some((row) => row.identifier === identifier && Number(row.value) === 80) &&
          ownHistory.some((row) => row.identifier === identifier && Number(row.value) === 80) &&
          String(alertRecord.deviceId) === String(device.id),
          `messages=${ownMessages.length}; latest=${ownLatest.length}; history=${ownHistory.length}; alert=${alertRecord.id}`)

      await hiddenDetail(api, `/iot/product/get?id=${product.id}`)
      await hiddenDetail(api, `/iot/device/get?id=${device.id}`)
      await hiddenPage(api, `/iot/device/message/page?pageNo=1&pageSize=100&deviceId=${device.id}`, [device.id, sequenceNo])
      await hiddenDetail(api, `/iot/device/property/get-latest?deviceId=${device.id}`)
      await hiddenDetail(api, `/iot/device/property/history-list?deviceId=${device.id}&identifier=${identifier}`)
      await hiddenDetail(api, `/iot/scene-rule/get?id=${alert.sceneRuleId}`)
      await hiddenDetail(api, `/iot/alert-config/get?id=${alert.configId}`)
      await hiddenPage(api, `/iot/alert-record/page?pageNo=1&pageSize=100&deviceId=${device.id}&configId=${alert.configId}`,
        [device.id, alert.configId])
      addCheck(caseRecord, '主租户不可见第二租户产品、设备、属性消息、最新属性、历史、规则和告警', true,
        `tenantId=${tenantFixture.tenantId}; product=${product.id}; device=${device.id}; config=${alert.configId}`)

      const foreignSequence = sequenceNo + 1
      await assertCrossWriteRejected(api, 'POST', '/iot/device/message/send', {
        method: 'thing.property.post', params: { [identifier]: 81 }, deviceId: device.id,
        reportTime: new Date().toISOString().slice(0, 19), pointVersion: 1,
        sequenceNo: foreignSequence, qualityCode: 0, preserveReportTime: true
      })
      const afterForeignMessage = pageRows(await tenantApi.getBusiness(
        `/iot/device/message/page?pageNo=1&pageSize=100&deviceId=${device.id}`), '第二租户消息回读')
      if (afterForeignMessage.some((row) => String(row.sequenceNo) === String(foreignSequence))) {
        throw new Error('主租户跨租户发送属性消息产生了第二租户数据')
      }
      const beforeAlert = dataOf(await tenantApi.getBusiness(`/iot/alert-record/get?id=${alertRecord.id}`))
      await assertCrossWriteRejected(api, 'PUT', '/iot/alert-record/process', {
        id: alertRecord.id, processRemark: 'E2E-IOT-002 tenant1 forbidden process'
      })
      const afterForeignAlert = dataOf(await tenantApi.getBusiness(`/iot/alert-record/get?id=${alertRecord.id}`))
      if (JSON.stringify(beforeAlert) !== JSON.stringify(afterForeignAlert)) {
        throw new Error('主租户跨租户处理告警改变了第二租户告警')
      }
      await tenantApi.putBusiness('/iot/alert-record/process', {
        id: alertRecord.id, processRemark: 'E2E-IOT-002 tenant2 owner process'
      })
      const processed = dataOf(await tenantApi.getBusiness(`/iot/alert-record/get?id=${alertRecord.id}`))
      addCheck(caseRecord, '主租户不能写入第二租户属性消息和告警，第二租户可写自身告警',
        processed?.processRemark === 'E2E-IOT-002 tenant2 owner process',
        `messageSequence=${foreignSequence}; alert=${alertRecord.id}`)
        innerResult = { tenantId: String(tenantFixture.tenantId), product, device, identifier, alert, sequenceNo }
      } catch (error) {
        innerError = error
      } finally {
        try {
          await cleanupResources(tenantApi, resources, caseRecord)
        } catch (cleanupError) {
          innerError = mergeErrors(innerError, [cleanupError], '第二租户 IoT 夹具清理失败')
        }
      }
      if (innerError) throw innerError
      return innerResult
    }, dependencies)
  } catch (error) {
    operationError = error
  } finally {
    if (tenantFixture) {
      try {
        await retireTenant(api, tenantFixture, caseRecord)
      } catch (cleanupError) {
        operationError = mergeErrors(operationError, [cleanupError], 'IoT 隔离租户退役失败')
      }
    }
  }
  if (operationError) throw operationError
  const isolationCheckNames = [
    '第二真实租户登录身份与新建产品、设备回读一致',
    '第二租户可见自有产品、设备、属性消息、最新属性、属性历史和告警',
    '主租户不可见第二租户产品、设备、属性消息、最新属性、历史、规则和告警',
    '主租户不能写入第二租户属性消息和告警，第二租户可写自身告警'
  ]
  caseRecord.evidence.push(`IOT-002 真第二租户隔离：tenant=${result.tenantId}; product=${result.product.id}; device=${result.device.id}; alert=${result.alert.configId}`)
  result.isolationCheckNames = isolationCheckNames
  return result
}
