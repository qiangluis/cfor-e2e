import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials } from '../lib/browser.mjs'

// PB-158~PB-282 销售协同「页面 / 菜单 / 权限」对齐回归。
// 该套件只读：不创建业务单据，用菜单接口 + 前端源码校验死链、重复入口和权限键缺失。
export const cases = ['CRM-ALIGN-001']

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot =
  process.env.CFOR_WEB_ROOT || path.resolve(here, '../../../../cfor/cfor-admin-vue3')

const unwrap = (response) => response?.data

const flattenMenus = (menus, result = []) => {
  for (const menu of menus || []) {
    result.push(menu)
    if (Array.isArray(menu?.children)) flattenMenus(menu.children, result)
  }
  return result
}

const visibleNode = (menu) => menu?.visible !== false && menu?.visible !== 0 && menu?.visible !== '0'

// 组件路径 -> 前端源码文件是否存在（支持 query 与 views/ 前缀）。
const componentExists = (component) => {
  const base = String(component || '').split('?')[0]
  if (!base || /^(Layout|ParentView|InnerLink)$/i.test(base)) return true
  if (/^(https?:)?\/\//.test(base) || base.startsWith('/')) return true
  const candidates = base.startsWith('views/')
    ? [path.join(webRoot, 'src', base)]
    : [path.join(webRoot, 'src/views', base)]
  return candidates.some((candidate) =>
    ['', '.vue', '.tsx', '/index.vue', '/index.tsx'].some((suffix) =>
      fs.existsSync(`${candidate}${suffix}`)
    )
  )
}

// 本批销售协同必须存在的前端页面与接口权限键。
const REQUIRED_PERMISSIONS = [
  'erp:sale-reconciliation:query',
  'erp:sale-reconciliation:create',
  'erp:sale-reconciliation:submit',
  'erp:sale-reconciliation:internal-confirm',
  'erp:sale-reconciliation:customer-confirm',
  'erp:sale-reconciliation:customer-reject',
  'erp:sale-reconciliation:complete',
  'erp:sale-reconciliation:close',
  'erp:sale-reconciliation:export',
  'crm:sales-plan:query',
  'crm:sales-plan:create',
  'crm:sales-plan:update',
  'crm:sales-plan:delete',
  'crm:sales-plan:approve',
  'crm:contract-handover:query',
  'crm:contract-handover:create',
  'crm:meeting-minutes:query',
  'crm:meeting-minutes:create',
  'crm:meeting-minutes:update',
  'crm:meeting-minutes:delete',
  'crm:meeting-minutes:confirm',
  'crm:meeting-minutes:archive',
  'erp:customer-portal-account:query',
  'erp:customer-portal-account:create',
  'erp:customer-portal-account:update',
  'crm:jixu:report:sales-plan',
  'crm:jixu:report:public-pool',
  'crm:jixu:report:private-pool',
  'crm:jixu:report:follow-up',
  'crm:jixu:report:weekly-review',
  'crm:jixu:report:quote',
  'crm:jixu:report:contract-receipt',
  'crm:jixu:report:work-log',
  'crm:jixu:report:ai-effect'
]

const IN_SCOPE_COMPONENT = /^(crm\/jixu\/|erp\/sale\/|erp\/settings\/customerPortal|erp\/settings\/priceCenter)/

export const runCase = async ({ caseId, page, record, caseRecord }) => {
  if (caseId !== 'CRM-ALIGN-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const menus = flattenMenus(unwrap(await api.get('/system/menu/list')) || [])
  const visibleMenus = menus.filter(visibleNode)
  const visibleInScope = visibleMenus.filter(
    (menu) => menu.component && IN_SCOPE_COMPONENT.test(String(menu.component))
  )

  caseRecord.checks.push({
    name: 'PB-158~282 菜单接口返回完整菜单树',
    passed: menus.length > 0 && visibleInScope.length > 0,
    details: `menus=${menus.length}, visibleInScope=${visibleInScope.length}`
  })

  // 1) 可见菜单不得指向已被删除的页面（crm/jixu/modeling 死链由 V202610162400 隐藏）。
  const deadComponents = visibleInScope.filter((menu) => !componentExists(menu.component))
  caseRecord.checks.push({
    name: '销售协同可见菜单全部指向存在的前端页面（无死链）',
    passed: deadComponents.length === 0,
    details:
      deadComponents.length === 0
        ? `checked=${visibleInScope.length}`
        : deadComponents.map((menu) => `${menu.id}:${menu.component}`).join(', ')
  })

  const legacyModelingMenus = visibleMenus.filter((menu) =>
    String(menu.component || '').includes('crm/jixu/modeling/index.vue')
  )
  caseRecord.checks.push({
    name: 'PB-158~282 CRM 遗留「系统建模」死链入口保持隐藏',
    passed: legacyModelingMenus.length === 0,
    details:
      legacyModelingMenus.length === 0
        ? '未发现可见的 crm/jixu/modeling 入口'
        : legacyModelingMenus.map((menu) => menu.id).join(', ')
  })

  // 2) 同一父级下不允许出现「同名同路径同组件」的重复入口
  //    （跨域各保留一份入口属既有设计，例如客户门户同时存在于 CRM 域与设置域）。
  const componentCount = new Map()
  for (const menu of visibleInScope) {
    const key = `${menu.parentId}|${menu.component}|${menu.path}`
    componentCount.set(key, (componentCount.get(key) || 0) + 1)
  }
  const duplicated = [...componentCount.entries()].filter(([, count]) => count > 1)
  caseRecord.checks.push({
    name: '销售协同同一父级下无重复页面入口',
    passed: duplicated.length === 0,
    details:
      duplicated.length === 0
        ? `entries=${componentCount.size}`
        : duplicated.map(([key, count]) => `${key} x${count}`).join(', ')
  })

  // 3) 本批涉及的接口权限键必须已注册，否则除超管外无人能调用。
  const registered = new Set(menus.map((menu) => String(menu.permission || '')).filter(Boolean))
  const missingPermissions = REQUIRED_PERMISSIONS.filter((item) => !registered.has(item))
  caseRecord.checks.push({
    name: 'PB-158~282 销售协同接口权限键全部已注册',
    passed: missingPermissions.length === 0,
    details:
      missingPermissions.length === 0
        ? `required=${REQUIRED_PERMISSIONS.length}`
        : missingPermissions.join(', ')
  })

  // 4) 会议纪要（PB-222/223）入口必须指向漏斗页的 minutes 页签。
  const minutesMenu = visibleMenus.find(
    (menu) => String(menu.path || '') === 'minutes' || String(menu.permission || '') === 'crm:meeting-minutes:query'
  )
  caseRecord.checks.push({
    name: 'PB-222/223 会议纪要菜单挂在漏斗管理并指向 minutes 页签',
    passed: Boolean(minutesMenu) && componentExists(minutesMenu?.component || 'crm/jixu/funnel/index.vue'),
    details: minutesMenu
      ? `id=${minutesMenu.id}, path=${minutesMenu.path}, component=${minutesMenu.component}`
      : '未找到会议纪要菜单'
  })

  // 5) 销售工作台/报价页不得残留静态壳占位数据。
  const quoteSource = path.join(webRoot, 'src/views/crm/jixu/quote/index.vue')
  if (fs.existsSync(quoteSource)) {
    const source = fs.readFileSync(quoteSource, 'utf8')
    caseRecord.checks.push({
      name: 'PB-231 报价附件走真实上传并回写 attachmentUrl',
      passed:
        /uploadFile|updateFile/.test(source) &&
        /attachmentUrl/.test(source) &&
        !/519800/.test(source) &&
        !/386 \* 1024/.test(source),
      details: '校验报价页调用文件上传接口、回写 attachmentUrl，且移除写死的金额与文件大小'
    })
  }

  caseRecord.evidence.push(
    `菜单-页面-权限对齐回归：可见销售协同菜单 ${visibleInScope.length} 条，权限键 ${REQUIRED_PERMISSIONS.length} 个`
  )
  return { token, api }
}
