import fs from 'node:fs'
import { checkHealth, createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { unwrapWebStorageValue } from '../lib/assertions.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { config } from '../config/index.mjs'
import { runSmokeOnboardingEvidence } from '../fixtures/smoke-onboarding.mjs'
import { verifyTenantListReadability } from '../fixtures/tenant-list-readability.mjs'

const binding = (index, assertion, evidenceChecks) => Object.freeze({
  index, assertion, evidenceChecks: Object.freeze(evidenceChecks)
})

export const smokeCatalogBindings = Object.freeze({
  'SMOKE-001': Object.freeze([
    binding(0, 'actuator health=UP', ['后端健康检查']),
    binding(1, '登录 code=0', ['真实登录成功', '本次浏览器登录响应 code=0 且令牌对应当前会话']),
    binding(2, 'tenantId=1', ['登录响应、浏览器缓存及实际权限请求租户均为1']),
    binding(3, '初始化未确认进入引导中心，已确认进入工作台', [
      '初始化确认事实与权限引导标志一致',
      '登录后按真实初始化状态进入引导中心或普通工作台',
      '未确认初始化真实登录进入引导中心',
      '已确认初始化真实登录进入普通工作台'
    ])
  ]),
  'SMOKE-002': Object.freeze([
    binding(0, '顶部工作台可进入', ['顶部工作台入口对应普通工作台']),
    binding(1, '引导中心存在', ['引导中心真实加载且保留在二级入口']),
    binding(2, '已确认模块菜单可见', [
      '已确认模块具有对应的真实菜单及导航授权',
      '已确认模块顶部导航与各模块设置菜单逐项可见'
    ]),
    binding(3, '无 4xx/5xx', ['实际浏览器响应、健康端点与本用例 Node API 无 4xx/5xx'])
  ])
})

// Both the original text and index are pinned. Catalog changes cannot silently
// reuse an old binding; duplicate mappings/checks and truthy values fail closed.
export function smokeCatalogEvidence (caseId, caseRecord, bindings = smokeCatalogBindings) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.find((suite) => suite.id === 'smoke')
    ?.cases.find((item) => item.id === caseId)
  if (!definition || !smokeCatalogBindings[caseId]) throw new Error(`未注册的 smoke 原断言：${caseId}`)
  const checks = Array.isArray(caseRecord.checks) ? Array.from(caseRecord.checks) : []
  const mappings = Array.isArray(bindings?.[caseId]) ? Array.from(bindings[caseId]) : []
  const names = mappings.flatMap((item) => Array.isArray(item?.evidenceChecks) ? item.evidenceChecks : [])
  const repeated = new Set(names.filter((name, index) => names.indexOf(name) !== index))
  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => {
    const canonical = smokeCatalogBindings[caseId].find((item) =>
      item.index === index && item.assertion === assertion)
    const matches = mappings.filter((item) => item?.index === index && item.assertion === assertion)
    const mapping = matches.length === 1 ? matches[0] : null
    const evidenceChecks = Array.isArray(mapping?.evidenceChecks) ? Array.from(mapping.evidenceChecks) : []
    const matchedChecks = evidenceChecks.map((name) => checks.filter((check) => check?.name === name))
    const exactNames = canonical && evidenceChecks.length === canonical.evidenceChecks.length &&
      evidenceChecks.every((name, position) => name === canonical.evidenceChecks[position])
    const verified = Boolean(exactNames) && evidenceChecks.length > 0 &&
      mappings.filter((item) => item?.index === index).length === 1 &&
      mappings.filter((item) => item?.assertion === assertion).length === 1 &&
      evidenceChecks.every((name) => typeof name === 'string' && name.trim() && !repeated.has(name)) &&
      matchedChecks.every((items) => items.length === 1 && items[0].passed === true)
    const missingChecks = (canonical?.evidenceChecks || [])
      .filter((name) => !checks.some((check) => check?.name === name))
    const invalidChecks = evidenceChecks.filter((_, position) =>
      matchedChecks[position].length !== 1 || matchedChecks[position][0].passed !== true)
    return {
      index, assertion, evidenceChecks: [...evidenceChecks],
      status: verified ? 'VERIFIED' : 'GAP',
      ...(!verified ? { missingChecks, invalidChecks } : {}),
      details: verified
        ? matchedChecks.flat().map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : '缺少完整且唯一的必需具名真实检查；不以标题、配置、空列表或 HTTP 200 替代原断言'
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED').map((item) => item.assertion)
  caseRecord.catalogComplete = caseRecord.catalogAssertions.length > 0 &&
    caseRecord.remainingAssertions.length === 0 && mappings.length === definition.assertions.length
  caseRecord.passCandidate = caseRecord.catalogComplete && checks.length > 0 &&
    checks.every((check) => check?.passed === true && typeof check.name === 'string' && check.name.trim()) &&
    new Set(checks.map((check) => check.name)).size === checks.length
  caseRecord.acceptanceComplete = caseRecord.passCandidate
  return caseRecord
}

export const smokeInitializationFact = (payload, permission) => {
  const state = payload?.data
  const known = payload?.code === 0 && Number.isInteger(state?.currentStep) &&
    state.currentStep >= 1 &&
    (state.industryTemplate == null || typeof state.industryTemplate === 'string') &&
    typeof permission?.data?.onboardingRequired === 'boolean'
  const confirmed = known && state.currentStep >= 2 && Boolean(state.industryTemplate?.trim())
  return {
    known, confirmed,
    consistent: known && permission?.code === 0 &&
      permission.data.onboardingRequired === !confirmed
  }
}

export const smokeLoginFact = ({ logins, token, loginTenantId, storage, permissionRequests }) => {
  const normalizedTenant = (value) => (
    typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
  ) ? String(value).trim() : ''
  const login = Array.isArray(logins) && logins.length === 1 ? logins[0] : null
  const tenantId = normalizedTenant(unwrapWebStorageValue(storage?.tenantId))
  const rawVisitTenantId = unwrapWebStorageValue(storage?.visitTenantId)
  const visitTenantId = normalizedTenant(rawVisitTenantId)
  const hasVisitTenant = rawVisitTenantId != null && rawVisitTenantId !== ''
  const requests = Array.isArray(permissionRequests) ? permissionRequests : []
  const codeZero = typeof token === 'string' && token.length > 0 &&
    Number.isInteger(login?.status) && login.status >= 200 && login.status < 300 &&
    login.code === 0 && login.tokenMatches === true
  return {
    codeZero,
    tenantOne: codeZero && normalizedTenant(loginTenantId) === '1' &&
      normalizedTenant(login?.tenantId) === '1' && tenantId === '1' &&
      (!hasVisitTenant || visitTenantId === '1') && requests.length > 0 &&
      requests.every((request) => request.tenantId === '1' &&
        (!request.visitTenantId || request.visitTenantId === '1') && request.tokenMatches === true),
    details: `登录响应数=${logins?.length || 0}，code=${login?.code ?? 'missing'}，` +
      `响应租户=${normalizedTenant(login?.tenantId) || 'missing'}，缓存租户=${tenantId || 'missing'}，` +
      `访问租户=${visitTenantId || 'none'}，权限请求数=${requests.length}`
  }
}

// These are the module settings routes and business navigation keys used by
// CFOR's system-init modules and NavigationGroupServiceImpl, not menu IDs.
const moduleMenus = Object.freeze({
  system: ['business-settings', []], bpm: ['bpm', []],
  erp: ['erp', ['sales', 'supply-chain', 'finance']],
  wms: ['warehouse', ['inventory']], mes: ['production', ['production']],
  quality: ['quality', ['quality']], fms: ['fms', ['finance']],
  cost: ['cost', ['cost']], crm: ['crm', ['crm']], hrm: ['hrm', ['hrm']],
  pms: ['pms', ['project']], plm: ['plm', ['research']],
  iot: ['iot', []], integration: ['plugin-settings', []], 'after-sales': ['after-sales', []]
})

// IoT and integrations expose their formal business pages inside Settings;
// they have no independent top group in GROUP_MODULES.
const settingsBusinessPages = Object.freeze({
  iot: { pathname: '/settings/iot/device', component: 'iot/device/device/index' },
  integration: {
    pathname: '/settings/plugin-settings/platform', component: 'integration/platform/index'
  },
  'after-sales': {
    pathname: '/settings/after-sales', component: 'after-sales/settings/index'
  }
})

export function smokeSidebarPaths (setting, routes, group) {
  if (!Array.isArray(group?.sidebarTree) || group.sidebarTree.length === 0) {
    return [setting.pathname]
  }
  const displayed = []
  const visit = (nodes, key = '') => {
    nodes.forEach((node, index) => {
      const keyPath = key ? `${key}_${index}` : String(index)
      if (Array.isArray(node.children)) {
        displayed.push({ pathname: `/__top-menu__/${keyPath}`, name: node.title })
        visit(node.children, keyPath)
      } else if (typeof node.source === 'string') {
        const source = routes.find((route) => route.pathname === node.source)
        if (!source) return
        displayed.push({ ...source, name: node.title || source.name })
        if (!node.flatten) displayed.push(...routes.filter((route) =>
          route.ancestors.includes(node.source)))
      }
    })
  }
  visit(group.sidebarTree)
  return [...new Set(displayed.filter((route) =>
    route.pathname === setting.pathname ||
    (setting.component && route.component?.replace(/\.vue$/, '') ===
      setting.component.replace(/\.vue$/, '')) ||
    (!setting.component && route.pathname.startsWith('/__top-menu__/') &&
      route.name === setting.name)
  ).map((route) => route.pathname))]
}

export function smokeMenuExpectation (statePayload, permission) {
  const fact = smokeInitializationFact(statePayload, permission)
  const modules = statePayload?.data?.selectedModules
  const groups = permission?.data?.navigationGroups
  const menus = permission?.data?.menus
  const gaps = []
  if (!fact.consistent || !fact.confirmed) gaps.push('缺少当前租户已确认初始化的真实事实')
  if (!Array.isArray(modules) || modules.length === 0 ||
      modules.some((module) => typeof module !== 'string' || !module.trim()) ||
      new Set(modules).size !== modules.length) gaps.push('已确认模块列表缺失、为空或重复')
  if (!Array.isArray(groups) || groups.length === 0 ||
      new Set(groups.map((group) => group?.key)).size !== groups.length) gaps.push('真实导航列表缺失或重复')
  if (!Array.isArray(menus) || menus.length === 0) gaps.push('真实菜单权限列表缺失或为空')
  const routes = []
  const flatten = (items, parent = '/', ancestors = []) => {
    for (const item of items || []) {
      if (!item || item.visible === false || typeof item.path !== 'string') continue
      const pathname = new URL(item.path, `http://smoke.invalid${parent.replace(/\/$/, '')}/`).pathname
      routes.push({ pathname, name: item.name, ancestors, component: item.component })
      if (Array.isArray(item.children)) flatten(item.children, pathname, [...ancestors, pathname])
    }
  }
  if (Array.isArray(menus)) flatten(menus)
  const requiredGroups = new Set(['settings'])
  const settings = []
  for (const module of Array.isArray(modules) ? modules : []) {
    const spec = moduleMenus[module]
    if (!spec) {
      gaps.push(`模块 ${module} 没有已核对的菜单映射`)
      continue
    }
    const pathname = `/settings/${spec[0]}`
    const matches = routes.filter((route) => route.pathname === pathname)
    if (matches.length !== 1 || typeof matches[0].name !== 'string' || !matches[0].name.trim()) {
      gaps.push(`模块 ${module} 缺少唯一可见的真实菜单 ${pathname}`)
    } else {
      settings.push({
        module, pathname, name: matches[0].name, ancestors: matches[0].ancestors,
        component: matches[0].component
      })
    }
    const businessPage = settingsBusinessPages[module]
    if (businessPage) {
      const pages = routes.filter((route) => route.pathname === businessPage.pathname &&
        route.component?.replace(/\.vue$/, '') === businessPage.component)
      if (pages.length !== 1 || !pages[0].name?.trim()) {
        gaps.push(`模块 ${module} 缺少真实业务页面菜单 ${businessPage.pathname}`)
      } else if (businessPage.pathname !== pathname) {
        settings.push({
          module, pathname: pages[0].pathname, name: pages[0].name,
          ancestors: pages[0].ancestors, component: pages[0].component
        })
      }
    }
    spec[1].forEach((key) => requiredGroups.add(key))
  }
  const navigation = []
  for (const key of requiredGroups) {
    const matches = Array.isArray(groups) ? groups.filter((group) => group?.key === key) : []
    const group = matches.length === 1 ? matches[0] : null
    if (!group || typeof group.title !== 'string' || !group.title.trim() ||
        !Array.isArray(group.sources) || group.sources.length === 0 ||
        !group.sources.some((source) => routes.some((route) => route.pathname === source))) {
      gaps.push(`导航 ${key} 缺少真实授权来源菜单`)
    } else {
      navigation.push({ key, title: group.title })
    }
  }
  const settingsGroup = Array.isArray(groups) ? groups.find((group) => group.key === 'settings') : null
  for (const setting of settings) {
    setting.displayPaths = smokeSidebarPaths(setting, routes, settingsGroup)
    if (setting.displayPaths.length === 0) {
      gaps.push(`模块 ${setting.module} 的授权导航未展示菜单 ${setting.pathname}`)
    }
  }
  return { complete: gaps.length === 0, gaps, navigation, settings }
}

export async function smokeObserveSidebarMenu (sidebar, setting) {
  const selectors = setting.displayPaths.map((pathname) =>
    `span.v-menu__title[data-menu-path="${pathname}"]`)
  const item = sidebar.locator(selectors.join(','))
  if (await item.count() !== 1) return { ...setting, visible: false, reason: '展示项不唯一' }
  const ancestors = await item.evaluate((label) => {
    const paths = []
    let parent = label.parentElement?.closest('.el-sub-menu')
    if (parent?.querySelector(':scope > .el-sub-menu__title')?.contains(label)) {
      parent = parent.parentElement?.closest('.el-sub-menu')
    }
    while (parent) {
      paths.unshift(parent.getAttribute('data-submenu-index'))
      parent = parent.parentElement?.closest('.el-sub-menu')
    }
    return paths
  })
  for (const pathname of ancestors) {
    if (!pathname) throw new Error(`设置菜单缺少实际父目录标识：${setting.pathname}`)
    const submenu = sidebar.locator(`[data-submenu-index="${pathname}"]`)
    if (await submenu.count() !== 1) throw new Error(`设置父目录不唯一：${pathname}`)
    const title = submenu.locator(':scope > .el-sub-menu__title')
    await title.waitFor({ state: 'visible' })
    if (!(await submenu.getAttribute('class')).includes('is-opened')) await title.click()
  }
  await item.scrollIntoViewIfNeeded()
  return {
    module: setting.module, pathname: setting.pathname,
    displayPath: await item.getAttribute('data-menu-path'),
    ancestors, visible: await item.isVisible()
  }
}

export const smokeHttpFact = (browserResponses, nodeResponses, healthStatus) => {
  const browser = Array.isArray(browserResponses) ? browserResponses : []
  const node = Array.isArray(nodeResponses) ? nodeResponses : []
  const statuses = [...browser, ...node, { status: healthStatus }]
  const failures = statuses.filter((entry) =>
    !Number.isInteger(entry?.status) || entry.status < 100 || entry.status >= 400)
  return {
    passed: browser.length > 0 && node.length > 0 && failures.length === 0,
    details: JSON.stringify({
      browserResponses: browser.length, nodeResponses: node.length, healthStatus,
      failures: failures.map(({ status, pathname }) => ({ status, pathname }))
    })
  }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (!smokeCatalogBindings[caseId]) throw new Error(`未注册的 smoke 用例：${caseId}`)
  smokeCatalogEvidence(caseId, caseRecord)
  const browserResponses = []
  const loginResponses = []
  const permissionRequests = []
  const responseTasks = []
  const apiStart = record.api.length
  let token = ''
  let healthStatus
  let result
  const observeResponse = (response) => {
    const pathname = new URL(response.url()).pathname
    browserResponses.push({ status: response.status(), pathname })
    const request = response.request()
    if (pathname.endsWith('/system/auth/get-permission-info')) {
      const headers = request.headers()
      permissionRequests.push({
        tenantId: headers['tenant-id'], visitTenantId: headers['visit-tenant-id'],
        matchesToken: (value) => Boolean(value) && headers.authorization === `Bearer ${value}`
      })
    }
    if (pathname.endsWith('/system/auth/login-encrypted') && request.method() === 'POST') {
      responseTasks.push((async () => {
        try {
          const text = await response.text()
          const payload = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
            ? decryptResponse(text) : JSON.parse(text)
          loginResponses.push({
            status: response.status(), code: payload?.code, tenantId: payload?.data?.tenantId,
            // Compare after login() has read and returned the browser token.
            matchesToken: (value) => Boolean(value) && payload?.data?.accessToken === value
          })
        } catch {
          loginResponses.push({ status: response.status(), code: null })
        }
      })())
    }
  }
  page.on('response', observeResponse)
  try {
    result = await runObservedCase()
  } finally {
    page.off('response', observeResponse)
    await Promise.all(responseTasks)
    if (caseId === 'SMOKE-002') {
      caseRecord.checks.push({
        name: '实际浏览器响应、健康端点与本用例 Node API 无 4xx/5xx',
        ...smokeHttpFact(browserResponses, record.api.slice(apiStart), healthStatus)
      })
    }
    smokeCatalogEvidence(caseId, caseRecord)
    if (result) {
      result.acceptanceComplete = caseRecord.passCandidate
      result.partial = !caseRecord.passCandidate
    }
  }
  return result

  async function runObservedCase () {
    const { response, body } = await checkHealth()
    healthStatus = response?.status
    caseRecord.checks.push({
      name: '后端健康检查',
      passed: Boolean(response && response.ok && body?.status === 'UP'),
      details: response
        ? `${config.apiHealthUrl}，HTTP=${response.status}，status=${body?.status}`
        : '健康端点不可用或超时；继续通过真实登录和业务 API 验证主链路'
    })

    const loginContext = await login(page, { returnContext: true })
    token = loginContext.token
    const api = createApiClient({ token, tenantId: loginContext.tenantId, record })
    const permission = await api.getPermissionInfo()
    if (permission?.code !== 0) throw new Error(`权限回读失败：code=${permission?.code}`)
    caseRecord.checks.push({
      name: '真实登录成功',
      passed: Boolean(token) && permission?.code === 0 &&
        String(permission?.data?.user?.username || '') === config.username,
      details: `登录响应租户=${loginContext.tenantId || 'missing'}`
    })
    caseRecord.checks.push({
      name: '当前租户具有真实菜单权限',
      passed: Array.isArray(permission?.data?.menus) && permission.data.menus.length > 0,
      details: `菜单数=${permission?.data?.menus?.length || 0}`
    })

    if (caseId === 'SMOKE-001') {
      await Promise.all(responseTasks)
      const storage = await page.evaluate(() => ({
        tenantId: window.localStorage.getItem('tenantId'),
        visitTenantId: window.localStorage.getItem('visitTenantId')
      }))
      const loginFact = smokeLoginFact({
        logins: loginResponses.map(({ matchesToken, ...entry }) => ({
          ...entry, tokenMatches: matchesToken?.(token) === true
        })),
        token, loginTenantId: loginContext.tenantId, storage,
        permissionRequests: permissionRequests.map(({ matchesToken, ...entry }) => ({
          ...entry, tokenMatches: matchesToken(token)
        }))
      })
      if (loginResponses.length > 0) {
        caseRecord.checks.push({
          name: '本次浏览器登录响应 code=0 且令牌对应当前会话',
          passed: loginFact.codeZero, details: loginFact.details
        })
        caseRecord.checks.push({
          name: '登录响应、浏览器缓存及实际权限请求租户均为1',
          passed: loginFact.tenantOne,
          details: loginFact.details
        })
      } else {
        caseRecord.notes.push('GAP: 本次复用会话，未观测真实登录响应，不能证明登录 code=0 或响应 tenantId=1')
      }
      const state = await api.get('/system/system-init/state')
      const initFact = smokeInitializationFact(state, permission)
      caseRecord.checks.push({
        name: '初始化确认事实与权限引导标志一致',
        passed: initFact.consistent,
        details: `currentStep=${state?.data?.currentStep}，confirmed=${initFact.confirmed}，` +
          `onboardingRequired=${permission.data.onboardingRequired}`
      })
      const onboardingRequired = Boolean(permission.data.onboardingRequired)
      const expectedPath = onboardingRequired ? '/systemInit/index' : '/index'
      await page.locator(onboardingRequired ? '.system-init .init-wizard' : '.todo-panel')
        .first().waitFor({ state: 'visible' })
      caseRecord.checks.push({
        name: '登录后按真实初始化状态进入引导中心或普通工作台',
        passed:
          !new URL(page.url()).pathname.startsWith('/login') &&
          new URL(page.url()).pathname === expectedPath &&
          new URL(page.url()).searchParams.get('mode') !== 'collaboration',
        details: `onboardingRequired=${onboardingRequired}，${page.url()}`
      })
      if (initFact.consistent && loginFact.codeZero) {
        caseRecord.checks.push({
          name: initFact.confirmed
            ? '已确认初始化真实登录进入普通工作台'
            : '未确认初始化真实登录进入引导中心',
          passed: new URL(page.url()).pathname === expectedPath &&
            new URL(page.url()).searchParams.get('mode') !== 'collaboration' &&
            await page.locator(onboardingRequired ? '.system-init .init-wizard' : '.todo-panel')
              .first().isVisible(),
          details: `本次仅覆盖${initFact.confirmed ? '已确认' : '未确认'}状态；${page.url()}`
        })
      }
      if (!onboardingRequired) {
        const inactiveHomes = [
          '/src/views/mes/workbench/portal.vue',
          '/src/views/erp/home/index.vue',
          '/src/views/iot/home/index.vue',
          '/src/views/plm/workbench/dashboard/index.vue',
          '/src/views/quality/workbench/index.vue',
          '/src/views/project-management/workbench/index.vue'
        ]
        const requestedHomes = await page.evaluate((paths) =>
          performance.getEntriesByType('resource')
            .map((entry) => new URL(entry.name).pathname)
            .filter((pathname) => paths.includes(pathname)),
        inactiveHomes)
        caseRecord.checks.push({
          name: '普通工作台不提前加载未访问的六个业务域首页',
          passed: requestedHomes.length === 0,
          details: JSON.stringify(requestedHomes)
        })
      }
      await saveScreenshot(page, outputDir, 'smoke-login', record)
      if (initFact.consistent && initFact.confirmed && loginFact.codeZero) {
        await runSmokeOnboardingEvidence({
          context: { page, caseRecord, record }, primaryApi: api, outputDir
        })
      } else {
        caseRecord.notes.push('GAP: 当前登录未覆盖已确认真实分支，不能用专属租户替代租户1的登录证据')
      }
    } else {
      await openRoute(page, '/systemInit/index')
      await page.locator('.system-init .init-wizard').first().waitFor({ state: 'visible' })
      const workbenchEntry = page.locator('.tool-header__top-menu .el-menu-item')
        .filter({ has: page.getByText('工作台', { exact: true }) })
      await workbenchEntry.click()
      await page.locator('.todo-panel').first().waitFor({ state: 'visible' })
      caseRecord.checks.push({
        name: '顶部工作台入口对应普通工作台',
        passed: new URL(page.url()).pathname === '/index' &&
          new URL(page.url()).searchParams.get('mode') !== 'governance' &&
          (await workbenchEntry.getAttribute('class')).includes('is-active') &&
          await page.locator('.todo-panel').first().isVisible(),
        details: page.url()
      })
      await openRoute(page, '/system/tenant-workbench')
      await page.locator('.personal-workbench .todo-panel').waitFor()
      caseRecord.checks.push({
        name: '旧租户管理入口归并到统一工作台，不渲染第二套首页',
        passed: new URL(page.url()).pathname === '/index' &&
          await page.locator('.personal-workbench').isVisible() &&
          await page.locator('.tenant-workbench').count() === 0,
        details: page.url()
      })
      const quickLabels = await page.locator('.quick-actions-strip .quick-action-label')
        .allTextContents()
      caseRecord.checks.push({
        name: '快捷栏同一入口不重复展示',
        passed: quickLabels.length > 0 && new Set(quickLabels).size === quickLabels.length,
        details: quickLabels.join(' / ')
      })
      await saveScreenshot(page, outputDir, 'smoke-workbench', record)
      await page.locator('[class*="-setting"].fixed').click()
      const settings = page.locator('.el-drawer:visible').filter({ hasText: '项目配置' })
      await settings.locator('[class*="-layout-radio-picker__classic"]').waitFor({ state: 'visible' })
      await settings.locator('[class*="-interface-display"] .el-switch').first()
        .waitFor({ state: 'visible' })
      await settings.locator('[class*="-color-radio-picker"]').first().waitFor({ state: 'visible' })
      caseRecord.checks.push({
        name: '首次打开设置抽屉，异步布局、颜色与界面控件可用',
        passed: true,
        details: '只打开并关闭，不修改用户设置'
      })
      await saveScreenshot(page, outputDir, 'smoke-settings-first-open', record)
      await settings.getByRole('button', { name: /关闭此对话框|Close this dialog/ }).click()
      await settings.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '唤醒企业 AI 助手', exact: true }).click()
      const assistant = page.getByRole('complementary', { name: '企业 AI 助手' })
      await assistant.waitFor({ state: 'visible' })
      await assistant.locator('.chroma-key-video canvas').waitFor({ state: 'visible' })
      await page.waitForFunction(() => {
        const root = document.querySelector('aside[aria-label="企业 AI 助手"]')
        const video = root?.querySelector('video')
        const canvas = root?.querySelector('canvas')
        if (!video || !canvas || video.readyState < 2 || video.paused) return false
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        let visiblePixels = 0
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 128 &&
            Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 240) visiblePixels++
        }
        return visiblePixels > 100
      })
      const playbackStartedAt = await assistant.locator('video').evaluate((video) => video.currentTime)
      await page.waitForFunction((startedAt) => {
        const video = document.querySelector('aside[aria-label="企业 AI 助手"] video')
        return video && !video.paused && Math.abs(video.currentTime - startedAt) > 0.125
      }, playbackStartedAt)
      caseRecord.checks.push({
        name: 'AI 助手首次打开，人物 canvas 非空、视频播放推进且输入框可用',
        passed: await assistant.locator('textarea').isVisible(),
        details: '不发送 AI 查询或业务动作，不代表模型及 AI 业务验收'
      })
      await saveScreenshot(page, outputDir, 'smoke-assistant-first-open', record)
      await assistant.getByRole('button', { name: '缩起', exact: true }).click()
      await assistant.waitFor({ state: 'hidden' })
      await openRoute(page, '/systemInit/index')
      await page.locator('.system-init .init-wizard').first().waitFor({ state: 'visible' })
      caseRecord.checks.push({
        name: '引导中心真实加载且保留在二级入口',
        passed: new URL(page.url()).pathname.startsWith('/systemInit') &&
          await page.locator('.system-init .init-wizard').first().isVisible(),
        details: page.url()
      })
      await saveScreenshot(page, outputDir, 'smoke-guide', record)
      const state = await api.get('/system/system-init/state')
      const menuPlan = smokeMenuExpectation(state, permission)
      if (menuPlan.complete) {
        caseRecord.checks.push({
          name: '已确认模块具有对应的真实菜单及导航授权',
          passed: menuPlan.settings.length > 0 && menuPlan.navigation.length > 0,
          details: JSON.stringify(menuPlan)
        })
        const topMenu = page.locator('.tool-header__top-menu')
        const visibleGroups = []
        for (const group of menuPlan.navigation) {
          const item = topMenu.locator('.el-menu-item')
            .filter({ has: page.getByText(group.title, { exact: true }) })
          visibleGroups.push({
            key: group.key, visible: await item.count() === 1 && await item.isVisible()
          })
        }
        const settingsGroup = menuPlan.navigation.find((group) => group.key === 'settings')
        await topMenu.locator('.el-menu-item')
          .filter({ has: page.getByText(settingsGroup.title, { exact: true }) }).click()
        await topMenu.locator('.el-menu-item.is-active')
          .filter({ has: page.getByText(settingsGroup.title, { exact: true }) })
          .waitFor({ state: 'visible' })
        await page.locator('[class*="-user-info"]').first().waitFor({ state: 'visible' })
        await page.waitForFunction(() => !document.documentElement.classList.contains('nprogress-busy'))
        const sidebar = page.locator('[id$="-menu"]:not([id$="-top-menu"])')
        await sidebar.waitFor({ state: 'visible' })
        const visibleModules = []
        for (const setting of menuPlan.settings) {
          visibleModules.push(await smokeObserveSidebarMenu(sidebar, setting))
        }
        caseRecord.checks.push({
          name: '已确认模块顶部导航与各模块设置菜单逐项可见',
          passed: visibleGroups.length > 0 && visibleModules.length > 0 &&
            !['/index', '/system/tenant-workbench'].includes(new URL(page.url()).pathname) &&
            [...visibleGroups, ...visibleModules].every((item) => item.visible === true),
          details: JSON.stringify({ route: page.url(), visibleGroups, visibleModules })
        })
        await saveScreenshot(page, outputDir, 'smoke-confirmed-module-menus', record)
        await verifyTenantListReadability({ page, caseRecord, outputDir, record })
      } else {
        caseRecord.notes.push(`GAP: ${menuPlan.gaps.join('；')}`)
      }
    }
    caseRecord.evidence.push('真实登录、健康检查、路由和截图')
    return { token, api }
  }
}

export const cases = ['SMOKE-001', 'SMOKE-002']
