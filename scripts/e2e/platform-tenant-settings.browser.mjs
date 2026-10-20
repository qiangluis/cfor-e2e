#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright-core'
import { config } from './config/index.mjs'
import { loginWithCredentials } from './lib/browser.mjs'

for (const base of [config.webBase, config.apiBase]) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname),
    'Settings regression is local-only')
}
const api = async (method, path, data, token) => {
  const response = await fetch(`${config.apiBase}/admin-api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'tenant-id': '1',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(30000)
  })
  assert.equal(response.status, 200, `${method} ${path}`)
  return response.json()
}
const success = async (...args) => {
  const result = await api(...args)
  assert.equal(result.code, 0, `${args[1]}: ${result.code} ${result.msg || ''}`)
  return result.data
}
const login = await success('POST', '/system/auth/login', {
  username: process.env.CFOR_USERNAME || 'admin',
  password: process.env.CFOR_PASSWORD || 'admin123'
})
const admin = login.accessToken
const menus = await success('GET', '/system/menu/list', undefined, admin)
const find = (name) => {
  const found = menus.find((menu) => menu.componentName === name)
  assert.ok(found, `Missing menu ${name}`)
  return found
}
assert.ok(find('SettingsPlatformManagement'))
assert.equal(String(menus.find((menu) => String(menu.id) === '102').parentId), '58801647')
assert.equal(String(menus.find((menu) => String(menu.id) === '100').parentId), '29412502')
const backup = find('SettingsDataBackup')
assert.equal(backup.sort, 80)
assert.equal(backup.visible, true)
assert.equal(backup.path, '/settings/data-backup')
const globalTenantTags = await success('GET', '/system/config/get-tags?category=global', undefined, admin)
const globalPlatformTags = await success(
  'GET', '/system/config/platform/get-tags?category=global', undefined, admin)
assert.deepEqual(globalTenantTags.map((tag) => tag.value),
  ['common', 'approval', 'portal', 'mobile_home', 'fields'])
assert.deepEqual(globalPlatformTags.map((tag) => tag.value),
  ['auth', 'sms', 'tenant_lifecycle', 'desktop_release'])
assert.equal((await api('GET', '/system/config/get?category=global&tag=auth',
  undefined, admin)).code, 403)
assert.equal((await api('GET', '/system/config/get-from-cache?category=global&tag=sms',
  undefined, admin)).code, 403)
const platformAuth = await success(
  'GET', '/system/config/platform/get?category=global&tag=auth', undefined, admin)
assert.match(platformAuth.configData, /"loginMaxFailCount"/)
assert.equal((await api('GET',
  '/system/config/platform/get?category=purchase&tag=reconciliationSla',
  undefined, admin)).code, 400)
await success('POST', '/system/config/save?category=global&tag=auth',
  { configData: platformAuth.configData }, admin)
const savedPlatformAuth = await success(
  'GET', '/system/config/platform/get?category=global&tag=auth', undefined, admin)
assert.equal(savedPlatformAuth.configData, platformAuth.configData)
const reconciliationSla = await success(
  'GET', '/system/config/get?category=purchase&tag=reconciliationSla', undefined, admin)
assert.ok(reconciliationSla?.configData)
await success('POST', '/system/config/save?category=purchase&tag=reconciliationSla',
  { configData: reconciliationSla.configData }, admin)
const savedReconciliationSla = await success(
  'GET', '/system/config/get?category=purchase&tag=reconciliationSla', undefined, admin)
assert.equal(savedReconciliationSla.configData, reconciliationSla.configData)
const report = {
  menuOwnership: true,
  backupIndependentAndTenantVisible: true,
  platformTenantConfigSplit: true,
  platformTenantConfigPersistence: true
}

if (process.argv.includes('--allow-local-fixtures')) {
  let roleId
  let userId
  const username = `settings${Date.now()}`
  const password = `T9${randomBytes(5).toString('hex')}!`
  try {
    roleId = await success('POST', '/system/role/create',
      { name: username, code: username, sort: 999, status: 0 }, admin)
    const neededPermissions = new Set(['system:dict:query', 'system:dict:update',
      'base:order-type:update'])
    const menuIds = menus.filter((menu) => neededPermissions.has(menu.permission)).map((menu) => menu.id)
    menuIds.push(find('SettingsSpec_dictionary').id, find('SettingsSpec_document_types').id,
      find('busConfig').id)
    await success('POST', '/system/permission/assign-role-menu', { roleId, menuIds }, admin)
    userId = await success('POST', '/system/user/create', {
      username, password, nickname: '设置范围临时验证', roleIds: [roleId], postIds: []
    }, admin)
    const tenantLogin = await success('POST', '/system/auth/login', { username, password })
    const tenantToken = tenantLogin.accessToken
    const tenant = await success('GET', '/system/auth/get-permission-info', undefined, tenantToken)
    const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children || [])])
    const routes = flatten(tenant.menus)
    assert.ok(routes.some((menu) => menu.path === '/settings/spec/dictionaries'))
    assert.ok(!routes.some((menu) => [
      '/settings/system-settings',
      '/settings/platform-management',
      '/system/config/platform',
      '/system/menu'
    ].includes(menu.path)))
    for (const path of ['/system/menu/list', '/infra/config/page?pageNo=1&pageSize=1',
      '/system/tenant/page?pageNo=1&pageSize=1', '/system/ai-runtime/admin/options']) {
      assert.equal((await api('GET', path, undefined, tenantToken)).code, 403, path)
    }
    for (const path of [
      '/system/config/platform/get-tags?category=global',
      '/system/config/platform/get?category=global&tag=auth',
      '/system/config/platform/get-fields?category=global&tag=auth',
      '/system/config/get?category=global&tag=auth',
      '/system/config/get-from-cache?category=global&tag=auth',
      '/system/config/get-fields?category=global&tag=auth'
    ]) {
      assert.equal((await api('GET', path, undefined, tenantToken)).code, 403, path)
    }
    assert.equal((await api('POST', '/system/config/save?category=global&tag=auth',
      { configData: platformAuth.configData }, tenantToken)).code, 403)
    const tenantConfigList = await success('GET', '/system/config/getConfigList',
      undefined, tenantToken)
    const tenantConfigKeys = tenantConfigList.map((config) => `${config.category}:${config.tag}`)
    for (const key of ['global:auth', 'global:sms', 'global:tenant_lifecycle',
      'global:desktop_release']) {
      assert.ok(!tenantConfigKeys.includes(key), key)
    }
    const tenantCommon = await success(
      'GET', '/system/config/get?category=global&tag=common', undefined, tenantToken)
    assert.ok(tenantCommon?.configData)
    const dictionaries = await success('GET',
      '/system/dict-type/page?pageNo=1&pageSize=100&scope=business', undefined, tenantToken)
    assert.ok(dictionaries.total > 0)
    assert.equal((await api('GET', '/system/dict-type/page?pageNo=1&pageSize=1&scope=platform',
      undefined, tenantToken)).code, 403)
    const types = await success('GET', '/system/document/type/page?pageNo=1&pageSize=100',
      undefined, tenantToken)
    assert.ok(types.list.length > 0)
    const shared = types.list.find((row) => row.writable === false && row.code && row.name)
    assert.ok(shared)
    assert.equal((await api('PUT', '/system/document/type/update',
      { ...shared, name: shared.name }, tenantToken)).code, 403)
    report.tenantIsolationAndPlatformApiDenial = true
  } finally {
    if (userId) await success('DELETE', `/system/user/delete?id=${userId}`, undefined, admin)
    if (roleId) await success('DELETE', `/system/role/delete?id=${roleId}`, undefined, admin)
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await loginWithCredentials(page, {
    tenantName: config.tenantName,
    username: process.env.CFOR_USERNAME || 'admin',
    password: process.env.CFOR_PASSWORD || 'admin123'
  })
  const pages = [
    ['/system/menu', '菜单名称'],
    ['/settings/spec/dictionaries', '字典名称'],
    ['/system/dict', '字典名称'],
    ['/system/post', '岗位名称']
  ]
  for (const [route, text] of pages) {
    await page.goto(`${config.webBase}${route}`, { waitUntil: 'domcontentloaded' })
    await page.getByText(text, { exact: true }).first().waitFor({ timeout: 60000 })
    assert.equal(new URL(page.url()).pathname, route)
  }
  await page.goto(`${config.webBase}/system/bus-config`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '旧版扩展字段', exact: true }).waitFor({ timeout: 60000 })
  const businessTabs = (await page.getByRole('tab').allTextContents()).map((text) => text.trim())
  assert.deepEqual(businessTabs,
    ['通用配置', '审批流', '门户品牌', '小程序首页', '旧版扩展字段'])
  await page.getByRole('tab', { name: '旧版扩展字段', exact: true }).click()
  await page.getByText('新增字段请到「设置 / 业务基础 / 自定义项中心」创建', { exact: false })
    .waitFor()
  await page.goto(`${config.webBase}/system/config/platform`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '登录与注册', exact: true }).waitFor({ timeout: 60000 })
  const platformTabs = (await page.getByRole('tab').allTextContents()).map((text) => text.trim())
  assert.deepEqual(platformTabs,
    ['登录与注册', '短信保护', '租户生命周期', '客户端发布'])
  await page.screenshot({ path: '/tmp/cfor-platform-tenant-settings.png', fullPage: true })
  report.browserRoutes = pages.map(([route]) => route)
  report.businessOptionAndPlatformTabs = true
} finally {
  await browser.close()
}
console.log(JSON.stringify(report, null, 2))
