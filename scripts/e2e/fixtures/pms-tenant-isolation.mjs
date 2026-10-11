import { randomBytes } from 'node:crypto'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { observePage } from '../lib/browser.mjs'

import { withDedicatedTenant } from './init-gaps.mjs'

const STANDARD_PACKAGE_ID = '111'
const BASE_COMPONENTS = Object.freeze([
  'system/tenant-workbench/index',
  'system/user/index',
  'system/role/index',
  'system/dept/index',
  'system/enterprise-organization/index',
  'system/systemInit/index'
])
const PMS_PROJECT_QUERY_PERMISSION = 'pms:pm:project:query'

const dataOf = (response) => response?.data ?? response

const numericId = (value, label) => {
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

const isDescendantOf = (menu, ancestorIds, byId) => {
  const seen = new Set()
  let parentId = menu?.parentId
  while (parentId != null && String(parentId) !== '0' && seen.add(String(parentId))) {
    if (ancestorIds.has(String(parentId))) return true
    parentId = byId.get(String(parentId))?.parentId
  }
  return false
}

/**
 * 从标准套餐 111 派生一个仅包含已启用完整父链的专属套餐菜单集。
 * 强制租户管理员基础菜单不能越过 111 的既有授权边界。
 */
export const buildPmsIsolationPackage = ({ standardPackage, menus, assignableMenus = menus }) => {
  const sourceMenuIds = new Set((standardPackage?.menuIds || []).map(String))
  if (!sourceMenuIds.size) throw new Error('BLOCKED: 标准套餐 111 没有菜单授权')

  const flatMenus = flattenMenus(menus)
  const byId = new Map(flatMenus.map((menu) => [String(menu.id), menu]))
  const assignableIds = new Set(flattenMenus(assignableMenus).map((menu) => String(menu.id)))
  const baseMenus = flatMenus.filter((menu) => BASE_COMPONENTS.includes(menu.component))
  const missingComponents = BASE_COMPONENTS.filter((component) =>
    !baseMenus.some((menu) => menu.component === component))
  if (missingComponents.length) {
    throw new Error(`BLOCKED: 缺少平台强制基础菜单：${missingComponents.join(',')}`)
  }

  const baseIds = new Set(baseMenus.map((menu) => String(menu.id)))
  const forcedMenus = flatMenus.filter((menu) =>
    baseIds.has(String(menu.id)) || isDescendantOf(menu, baseIds, byId))
  const forcedIssues = []
  for (const menu of forcedMenus) {
    const { chain, reason } = menuChain(menu, byId)
    for (const node of chain) {
      if (!sourceMenuIds.has(String(node.id))) {
        forcedIssues.push(`强制菜单越过111授权：${node.id}`)
      }
      if (!menuState(node) || !assignableIds.has(String(node.id))) {
        forcedIssues.push(`强制菜单或父链已停用：${node.id}`)
      }
    }
    if (reason) forcedIssues.push(`强制菜单${menu.id}${reason}`)
  }
  if (forcedIssues.length) {
    throw new Error(`BLOCKED: ${[...new Set(forcedIssues)].join('；')}`)
  }

  const enabledMenuIds = new Set()
  const excluded = []
  for (const sourceId of sourceMenuIds) {
    const menu = byId.get(sourceId)
    const { chain, reason } = menuChain(menu, byId)
    const invalidNode = chain.find((node) => !sourceMenuIds.has(String(node.id)) ||
      !menuState(node) || !assignableIds.has(String(node.id)))
    if (!menu || reason || invalidNode) {
      excluded.push({
        sourceId,
        reason: reason || (!sourceMenuIds.has(String(invalidNode?.id))
          ? `父链超出111授权：${invalidNode?.id}`
          : `菜单或父链不可分配：${invalidNode?.id}`)
      })
      continue
    }
    chain.forEach((node) => enabledMenuIds.add(String(node.id)))
  }

  const queryMenu = flatMenus.find((menu) => menu.permission === PMS_PROJECT_QUERY_PERMISSION)
  if (!queryMenu || !enabledMenuIds.has(String(queryMenu.id))) {
    throw new Error(`BLOCKED: 专属套餐缺少 ${PMS_PROJECT_QUERY_PERMISSION} 的已启用完整父链`)
  }
  return {
    menuIds: [...enabledMenuIds].map(Number),
    sourceMenuCount: sourceMenuIds.size,
    excluded,
    baseMenuIds: baseMenus.map((menu) => String(menu.id))
  }
}

const suffixOf = (marker = '') => {
  const normalized = String(marker).replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase()
  return normalized || randomBytes(4).toString('hex').toUpperCase()
}

const packagePayload = (suffix, plan) => ({
  name: `E2E PMS ISO PKG ${suffix}`.slice(0, 30),
  status: 0,
  remark: `PMS-001 isolated tenant ${suffix}`,
  menuIds: plan.menuIds
})

const tenantPayload = (suffix, packageId, password) => ({
  name: `E2E PMS ISO TEN ${suffix}`.slice(0, 30),
  contactName: 'CFOR E2E PMS',
  contactMobile: '19900000000',
  status: 0,
  packageId: String(packageId),
  expireTime: '2099-12-31T23:59:59',
  accountCount: 1,
  username: `e2epms${suffix.toLowerCase()}`.slice(0, 30),
  password
})

const disabledPackagePayload = (fixture) => ({ ...fixture.packagePayload, id: String(fixture.packageId), status: 1 })
const disabledTenantPayload = (fixture) => ({ ...fixture.tenantPayload, id: String(fixture.tenantId), status: 1 })

/** 创建本轮专属套餐和租户；不读取、修改或扩大共享套餐 111。 */
export const createPmsIsolationTenant = async (api, { marker, password } = {}) => {
  const standardPackage = dataOf(await api.getBusiness(`/system/tenant-package/get?id=${STANDARD_PACKAGE_ID}`))
  const menus = dataOf(await api.getBusiness('/system/menu/list'))
  const assignableMenus = dataOf(await api.getBusiness('/system/menu/list-all-simple'))
  const plan = buildPmsIsolationPackage({ standardPackage, menus, assignableMenus })
  const suffix = suffixOf(marker)
  const safePassword = password || `Pms!${randomBytes(6).toString('hex')}`
  const createdPackagePayload = packagePayload(suffix, plan)
  const packageId = numericId(dataOf(await api.postBusiness(
    '/system/tenant-package/create', createdPackagePayload)), 'PMS 专属套餐')
  const createdTenantPayload = tenantPayload(suffix, packageId, safePassword)
  try {
    const tenantId = numericId(dataOf(await api.postBusiness(
      '/system/tenant/create', createdTenantPayload)), 'PMS 专属租户')
    return {
      packageId,
      tenantId,
      packagePayload: createdPackagePayload,
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
    await api.putBusiness('/system/tenant-package/update', {
      ...createdPackagePayload, id: String(packageId), status: 1
    }).catch(() => {})
    throw error
  }
}

/** 停用而非删除测试租户和套餐，保留创建、授权、登录的审计事实。 */
export const retirePmsIsolationTenant = async (api, fixture, caseRecord) => {
  if (!fixture) return
  const errors = []
  try {
    await api.putBusiness('/system/tenant/update', disabledTenantPayload(fixture))
    const saved = dataOf(await api.getBusiness(`/system/tenant/get?id=${fixture.tenantId}`))
    if (String(saved?.id) !== String(fixture.tenantId) || saved?.status !== 1) {
      throw new Error('专属租户停用状态回读不一致')
    }
  } catch (error) {
    errors.push(`停用专属租户失败：${error.message}`)
  }
  try {
    await api.putBusiness('/system/tenant-package/update', disabledPackagePayload(fixture))
    const saved = dataOf(await api.getBusiness(`/system/tenant-package/get?id=${fixture.packageId}`))
    if (String(saved?.id) !== String(fixture.packageId) || saved?.status !== 1) {
      throw new Error('专属套餐停用状态回读不一致')
    }
  } catch (error) {
    errors.push(`停用专属套餐失败：${error.message}`)
  }
  if (errors.length) {
    caseRecord.checks.push({ name: '清理：停用 PMS 专属租户与套餐', passed: false, details: errors.join('；') })
  } else {
    caseRecord.evidence.push(`清理：已停用 PMS 专属租户 ${fixture.tenantId} 与专属套餐 ${fixture.packageId}`)
  }
}

/** 使用真实第二租户登录，只读验证 tenant 1 PMS 项目在该租户分页中不可见。 */
export const verifyPmsCrossTenantInvisible = async ({ context, fixture, projectId, workItemId, marker }) => {
  return withDedicatedTenant(context, fixture.tenant, async ({ api, page }) => {
    const capture = observePage(page, context.record)
    try {
      const response = await api.getBusiness(
        `/pms/pm/project/page?pageNo=1&pageSize=100&status=1&sceneType=1&name=${encodeURIComponent(marker)}`
      )
      const data = dataOf(response) || {}
      const rows = Array.isArray(data.list) ? data.list : Array.isArray(data.records) ? data.records : []
      const leaked = rows.find((row) => String(row?.id) === String(projectId) || row?.name === marker)
      const projectContract = { code: 2050100000, message: '项目不存在' }
      const projectDetail = await api.get(`/pms/pm/project/get?id=${projectId}`, {
        expectedBusinessRejection: projectContract
      })
      const workItemContract = { code: 2050103000, message: '工作项不存在' }
      const workItemDetail = await api.get(`/pms/pm/work-item/get?id=${workItemId}`, {
        expectedBusinessRejection: workItemContract
      })
      const detailsHidden = projectDetail?.data == null && workItemDetail?.data == null &&
        matchesExpectedBusinessRejection(projectDetail, projectContract) &&
        matchesExpectedBusinessRejection(workItemDetail, workItemContract)
      return {
        passed: response?.code === 0 && Array.isArray(data.list ?? data.records) &&
          !leaked && detailsHidden,
        details: `tenant=${fixture.tenantId}, resultCount=${rows.length}, leaked=${Boolean(leaked)}, projectCode=${projectDetail?.code}, workItemCode=${workItemDetail?.code}`
      }
    } finally {
      await capture.flushResponses()
    }
  })
}
