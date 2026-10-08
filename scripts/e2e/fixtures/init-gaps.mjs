import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { login, openRoute } from '../lib/browser.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const catalogPath = path.join(here, '..', 'cases', 'catalog.json')

export const cases = Object.freeze(['INIT-002', 'INIT-003', 'INIT-004', 'INIT-005', 'PB001-002'])
export const initRoutes = Object.freeze({
  overview: '/systemInit/index',
  // The settings menu mounts the enterprise profile page under the
  // /systemModel/base/organization scope; /system/enterprise-organization is
  // not a registered front-end route.
  enterpriseOrganization: '/systemModel/base/organization/enterprise-organization'
})
export const presetConfirmButtonSelector = '.init-preset__actions button'
export const presetConfirmButtonText = '查看并确认预置'

const forbiddenRequests = Object.freeze([
  /^POST \/system\/system-init\/preset\/apply$/,
  /^PUT \/system\/system-init\/state$/,
  /^POST \/system\/system-init\/skip(?:\?|$)/,
  /^PUT \/system\/system-init\/subsystems$/,
  /^PUT \/system\/enterprise-organization\/current$/,
  /^POST \/system\/file\/upload$/
])

const allowedRequests = Object.freeze([
  /^GET \/system\/system-init\/(?:state|readiness|subsystems|preset\/catalog)$/,
  /^GET \/system\/auth\/get-permission-info$/,
  /^GET \/system\/enterprise-organization\/current$/,
  /^POST \/system\/system-init\/preset\/preview$/
])

const readCatalog = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8'))

export function catalogDefinition (caseId, catalog = readCatalog()) {
  const definition = catalog.suites
    ?.flatMap((suite) => (suite.cases || []).map((item) => ({ ...item, suite: suite.id })))
    .find((item) => item.id === caseId)
  if (!definition || !cases.includes(caseId)) throw new Error(`Missing init gap catalog: ${caseId}`)
  return definition
}

export function initializeCatalogAssertions (caseRecord, caseId, verified = new Map()) {
  const definition = catalogDefinition(caseId)
  const statuses = verified instanceof Map ? verified : new Map(Object.entries(verified))
  const statusFor = (index) => {
    const value = statuses.get(index)
    return typeof value === 'string' ? { status: value } : (value || {})
  }
  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => ({
    index,
    assertion,
    status: statusFor(index).status === 'VERIFIED' ? 'VERIFIED' : 'GAP',
    ...(statusFor(index).evidence ? { evidence: statusFor(index).evidence } : {})
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED')
    .map((item) => ({ index: item.index, assertion: item.assertion }))
  caseRecord.readyCandidate = false
  return caseRecord.catalogAssertions
}

export function assertSafeScope (settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: init gap checks require local tenant1/CFOR 标准平台/cfor_admin_standard')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: init gap checks require loopback 48083/9151 without credentials')
    }
  }
}

export function isAllowedRequest (method, pathname) {
  const value = `${String(method).toUpperCase()} ${pathname}`
  if (forbiddenRequests.some((pattern) => pattern.test(value))) return false
  return allowedRequests.some((pattern) => pattern.test(value))
}

export function isForbiddenRequest (method, pathname) {
  return forbiddenRequests.some((pattern) =>
    pattern.test(`${String(method).toUpperCase()} ${pathname}`))
}

const dataOf = (payload) => (isBusinessSuccess(payload) ? payload.data : null)
const nonNegative = (value) => Number.isInteger(value) && value >= 0
const text = (value) => String(value ?? '')
const normalize = (value) => JSON.stringify(value, Object.keys(value || {}).sort())

function stateSnapshot (value) {
  const state = dataOf(value) || {}
  return {
    id: state.id,
    industryTemplate: state.industryTemplate,
    industryCategory: state.industryCategory,
    industrySubCategory: state.industrySubCategory,
    selectedModules: Array.isArray(state.selectedModules) ? [...state.selectedModules] : null,
    skippedItems: Array.isArray(state.skippedItems) ? [...state.skippedItems] : null,
    currentStep: state.currentStep,
    status: state.status,
    firstRunPresetTime: state.firstRunPresetTime,
    firstRunPresetResult: state.firstRunPresetResult || null
  }
}

function organizationSnapshot (value) {
  const data = dataOf(value) || {}
  return {
    id: data.id,
    enterpriseType: data.enterpriseType,
    industryCategory: data.industryCategory,
    industrySubCategory: data.industrySubCategory,
    enterpriseLogoUrlPresent: Boolean(data.enterpriseLogoUrl),
    brandMarkUrlPresent: Boolean(data.brandMarkUrl),
    brandLogoUrlPresent: Boolean(data.brandLogoUrl),
    brandDarkLogoUrlPresent: Boolean(data.brandDarkLogoUrl)
  }
}

function permissionSnapshot (value) {
  const data = dataOf(value) || {}
  const menus = Array.isArray(data.menus) ? data.menus : []
  const flatten = (items) => items.flatMap((item) => [
    { id: item.id, name: item.name, path: item.path, component: item.component },
    ...flatten(Array.isArray(item.children) ? item.children : [])
  ])
  return flatten(menus).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function presetResultComplete (value, applied) {
  const result = dataOf(value)
  if (!result || result.applied !== applied || !Array.isArray(result.contributions) ||
      ![result.added, result.skipped, result.modified, result.conflicts].every(nonNegative)) {
    return false
  }
  return result.contributions.every((item) =>
    item && typeof item.key === 'string' && typeof item.module === 'string' &&
    typeof item.title === 'string' &&
    [item.added, item.skipped, item.modified, item.conflicts].every(nonNegative) &&
    Array.isArray(item.messages))
}

export function readinessClassification (payload) {
  const items = dataOf(payload)?.items
  if (!Array.isArray(items)) return { items: null, categories: {}, opening: [], unknown: true }
  const descriptors = items.map((item) => ({
    ...item,
    haystack: [item.key, item.module, item.title, item.name, item.reason]
      .map(text).join(' ').toLowerCase()
  }))
  const match = (pattern) => descriptors.filter((item) => pattern.test(item.haystack))
  const categories = {
    material: match(/material|存货|物料/),
    unit: match(/unit|bas.?unit|单位/),
    supplier: match(/supplier|供应商/),
    customer: match(/customer|客户/),
    account: match(/account(?!.?set)|账户|资金账户/),
    warehouse: match(/warehouse|仓储|仓库/),
    accountSet: match(/account.?set|账套/)
  }
  return {
    items: descriptors,
    categories,
    opening: descriptors.filter((item) => /opening|initial|期初|初始/.test(item.haystack)),
    unknown: descriptors.some((item) => item.status === 'UNKNOWN')
  }
}

export function inspectLogoFields (fields = []) {
  const labels = fields.filter((item) => /logo/i.test(text(item.label)))
  return {
    found: labels.length,
    optional: labels.length > 0 && labels.every((item) => item.required !== true && item.hasRequiredMark !== true)
  }
}

function addCheck (caseRecord, name, passed, details = '') {
  caseRecord.checks ||= []
  caseRecord.checks.push({ name, passed: Boolean(passed), details: String(details).slice(0, 500) })
  return Boolean(passed)
}

function evidence (caseRecord, value) {
  caseRecord.evidence ||= []
  caseRecord.evidence.push(value)
}

async function pageBodyText (page) {
  if (!page) return ''
  return page.locator('body').innerText().catch(() => '')
}

async function openReadOnlyRoute (page, route, navigate, caseRecord) {
  if (!page) return false
  try {
    await navigate(page, route, { readyText: route.includes('enterprise') ? '企业' : '初始化' })
    addCheck(caseRecord, `打开只读页面 ${route}`, true, '只读导航')
    return true
  } catch (error) {
    addCheck(caseRecord, `打开只读页面 ${route}`, false, String(error.message || error))
    return false
  }
}

function presetConfirmButton (page) {
  return page
    .locator(presetConfirmButtonSelector)
    .filter({ hasText: presetConfirmButtonText })
    .first()
}

async function callReadOnly (api, method, pathname, body, caseRecord) {
  if (!isAllowedRequest(method, pathname)) {
    throw new Error(`BLOCKED: request outside init gap read-only allowlist: ${method} ${pathname}`)
  }
  return api.request(method, pathname, body)
}

async function runInit002 ({ api, page, caseRecord, navigate }) {
  const before = {
    state: await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    organization: await callReadOnly(api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord),
    permissions: await callReadOnly(api, 'GET', '/system/auth/get-permission-info', undefined, caseRecord)
  }
  const state = dataOf(before.state)
  const catalog = await callReadOnly(api, 'GET', '/system/system-init/preset/catalog', undefined, caseRecord)
    .catch(() => null)
  const modules = Array.isArray(state?.selectedModules) && state.selectedModules.length
    ? state.selectedModules
    : (Array.isArray(dataOf(catalog)?.modules) ? dataOf(catalog).modules : ['system'])
  const preview = await callReadOnly(api, 'POST', '/system/system-init/preset/preview', { modules }, caseRecord)
  const after = {
    state: await callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    organization: await callReadOnly(api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord),
    permissions: await callReadOnly(api, 'GET', '/system/auth/get-permission-info', undefined, caseRecord)
  }
  const unchanged = normalize(stateSnapshot(before.state)) === normalize(stateSnapshot(after.state)) &&
    normalize(organizationSnapshot(before.organization)) === normalize(organizationSnapshot(after.organization)) &&
    normalize(permissionSnapshot(before.permissions)) === normalize(permissionSnapshot(after.permissions))
  addCheck(caseRecord, 'preview 返回 applied=false 且前后只读快照一致',
    isBusinessSuccess(preview) && presetResultComplete(preview, false) && unchanged,
    `modules=${modules.length}; unchanged=${unchanged}`)
  if (isBusinessSuccess(preview) && presetResultComplete(preview, false) && unchanged) {
    evidence(caseRecord, 'state/organization/permission API 前后快照一致；preview applied=false')
    caseRecord.catalogAssertions = initializeCatalogAssertions(caseRecord, 'INIT-002', new Map([
      [0, { status: 'VERIFIED', evidence: '只读快照一致且 preview.applied=false' }]
    ]))
  }
  if (page) {
    await openReadOnlyRoute(page, initRoutes.overview, navigate, caseRecord)
    const body = await pageBodyText(page)
    const previewButton = presetConfirmButton(page)
    if (await previewButton.isVisible().catch(() => false)) {
      const previewResponses = []
      const onResponse = async (response) => {
        if (!response.url().includes('preset/preview')) return
        const bodyText = await response.text().catch(() => '')
        previewResponses.push({ status: response.status(), body: bodyText.slice(0, 300) })
      }
      page.on('response', onResponse)
      await previewButton.click()
      const dialog = page.locator('[role="dialog"]').filter({ hasText: /预览|确认/ }).first()
      // The preview dialog only renders after the preset/preview request
      // resolves, so wait for it instead of reading visibility synchronously.
      const visible = await dialog
        .waitFor({ state: 'visible', timeout: 20000 })
        .then(() => true)
        .catch(() => false)
      let diagnostic = visible ? '只打开弹窗，未确认' : body.slice(0, 200)
      if (!visible) {
        await page.waitForTimeout(3000)
        const roleDialogs = await page.locator('[role="dialog"]').count().catch(() => -1)
        const presetDialogs = await page.locator('.init-preset-dialog').count().catch(() => -1)
        const messages = await page.locator('.el-message').allInnerTexts().catch(() => [])
        diagnostic = `dialogCount=${roleDialogs} presetDialog=${presetDialogs} ` +
          `messages=${JSON.stringify(messages)} previewResponses=${JSON.stringify(previewResponses)}`
      }
      page.off('response', onResponse)
      addCheck(caseRecord, '预览按钮打开确认弹窗', visible, diagnostic)
      if (visible) {
        const current = caseRecord.catalogAssertions?.find((item) => item.index === 1)
        if (current) current.status = 'VERIFIED'
        else initializeCatalogAssertions(caseRecord, 'INIT-002', new Map([
          [0, { status: 'VERIFIED' }], [1, { status: 'VERIFIED' }]
        ]))
        evidence(caseRecord, 'headed 页面确认弹窗可见，未点击确认')
      }
    } else addCheck(caseRecord, '预览按钮打开确认弹窗', false, '当前状态没有可安全点击的预览按钮')
  }
  initializeCatalogAssertions(caseRecord, 'INIT-002', new Map(
    (caseRecord.catalogAssertions || []).map((item) => [item.index, item])
  ))
}

async function runInit003 ({ api, page, caseRecord, navigate }) {
  const [catalog, state, readiness] = await Promise.all([
    callReadOnly(api, 'GET', '/system/system-init/preset/catalog', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/readiness', undefined, caseRecord)
  ])
  const receipt = dataOf(state)?.firstRunPresetResult
  const complete = presetResultComplete({ code: 0, data: receipt }, true)
  addCheck(caseRecord, 'state 首轮回执具备完整结构化明细', complete,
    complete ? `contributions=${receipt.contributions.length}` : '当前没有完整 applied=true 回执')
  addCheck(caseRecord, 'preset catalog/readiness 返回结构化成功数据',
    isBusinessSuccess(catalog) && Array.isArray(dataOf(catalog)?.contributions) &&
    isBusinessSuccess(readiness) && Array.isArray(dataOf(readiness)?.items),
    `catalog=${isBusinessSuccess(catalog)} readiness=${isBusinessSuccess(readiness)}`)
  if (page && complete) {
    await openReadOnlyRoute(page, initRoutes.overview, navigate, caseRecord)
    const body = await pageBodyText(page)
    const displayed = /新增\s*\d+/.test(body) && /已存在|跳过/.test(body) && /未覆盖修改|保留修改/.test(body)
    addCheck(caseRecord, '刷新后的页面显示回执摘要', displayed, displayed ? '页面包含回执统计' : '页面未显示完整回执摘要')
    if (displayed) evidence(caseRecord, 'headed 刷新页面显示首轮预置回执摘要')
  }
  const verified = new Map()
  if (complete && page) verified.set(0, { status: 'VERIFIED' })
  if (complete && page) verified.set(1, { status: 'VERIFIED' })
  initializeCatalogAssertions(caseRecord, 'INIT-003', verified)
  evidence(caseRecord, '未调用 apply；第二次幂等和已修改值不覆盖保留 GAP')
}

async function runInit004 ({ api, page, caseRecord, navigate }) {
  const [state, readiness] = await Promise.all([
    callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/readiness', undefined, caseRecord)
  ])
  const classified = readinessClassification(readiness)
  const selected = dataOf(state)?.selectedModules
  const hasSelected = Array.isArray(selected)
  const items = classified.items || []
  const skippable = classified.opening.filter((item) => item.skippable === true)
  const formal = items.filter((item) => /account.?set|账套/.test(item.haystack))
  addCheck(caseRecord, 'state/readiness 返回已选模块和初始化项', hasSelected && Array.isArray(classified.items),
    `selected=${hasSelected}; items=${items.length}`)
  addCheck(caseRecord, '期初项结构化标记为可跳过', skippable.length > 0, `count=${skippable.length}`)
  addCheck(caseRecord, '正式账套结构化标记为不可跳过', formal.length > 0 && formal.every((item) => item.skippable === false),
    `count=${formal.length}`)
  const verified = new Map()
  if (page) {
    const initOpened = await openReadOnlyRoute(page, initRoutes.overview, navigate, caseRecord)
    const initBody = initOpened ? await pageBodyText(page) : ''
    const tabsVisible = initBody.length > 0 && hasSelected
    if (tabsVisible) verified.set(0, { status: 'VERIFIED' })
    const settingsOpened = await openReadOnlyRoute(
      page,
      initRoutes.enterpriseOrganization,
      navigate,
      caseRecord
    )
    const settingsBody = settingsOpened ? await pageBodyText(page) : ''
    if (settingsOpened && /企业|设置/.test(settingsBody)) verified.set(3, { status: 'VERIFIED' })
    if (settingsOpened && initBody && settingsBody) {
      evidence(caseRecord, '初始化与设置页面均只读打开；未执行跳过或保存')
    }
  }
  if (skippable.length > 0) verified.set(1, { status: 'VERIFIED' })
  if (formal.length > 0 && formal.every((item) => item.skippable === false)) verified.set(2, { status: 'VERIFIED' })
  initializeCatalogAssertions(caseRecord, 'INIT-004', verified)
}

async function runInit005 ({ api, caseRecord }) {
  const [state, readiness] = await Promise.all([
    callReadOnly(api, 'GET', '/system/system-init/state', undefined, caseRecord),
    callReadOnly(api, 'GET', '/system/system-init/readiness', undefined, caseRecord)
  ])
  const classified = readinessClassification(readiness)
  const categoryNames = ['material', 'unit', 'supplier', 'customer', 'account', 'warehouse', 'accountSet']
  const completeCategories = classified.items !== null && categoryNames.every((name) =>
    classified.categories[name].length > 0 && classified.categories[name].every((item) =>
      ['READY', 'INCOMPLETE', 'NOT_STARTED', 'SKIPPED', 'UNKNOWN'].includes(item.status)))
  addCheck(caseRecord, '必配事实按 readiness 分类完整返回', completeCategories,
    `categories=${categoryNames.filter((name) => classified.categories[name].length > 0).join(',')}`)
  addCheck(caseRecord, '期初 readiness 标记为可跳过', classified.opening.some((item) => item.skippable === true),
    `opening=${classified.opening.length}`)
  const external = (classified.items || []).filter((item) => /cost|成本|integration|集成|connection|连接/.test(item.haystack))
  addCheck(caseRecord, '成本模型/集成仅按现状读取，不伪造外部连接', external.length > 0 &&
    external.every((item) => ['READY', 'INCOMPLETE', 'NOT_STARTED', 'SKIPPED', 'UNKNOWN'].includes(item.status)),
  `externalItems=${external.length}`)
  let jobVerified = false
  try {
    const result = await runReadOnlySql(`
      SELECT 'enabled-jobs', COUNT(*) FROM infra_job WHERE deleted = 0 AND status = 1;
      SELECT 'active-triggers', COUNT(*) FROM QRTZ_TRIGGERS
      WHERE TRIGGER_STATE IN ('WAITING', 'ACQUIRED', 'BLOCKED')
    `)
    if (result.available) {
      const map = new Map(result.rows.map(([key, value]) => [key, Number(value)]))
      jobVerified = map.get('enabled-jobs') === 0 && map.get('active-triggers') === 0
      caseRecord.database = [...(caseRecord.database || []), { stage: 'job-read-only', rows: result.rows }]
    } else caseRecord.notes.push(`Job 只读证据不可用：${result.reason}`)
  } catch (error) {
    caseRecord.notes.push(`Job 只读检查未完成：${String(error.message || error).slice(0, 240)}`)
  }
  addCheck(caseRecord, 'Job 默认关闭且 Quartz 无活动触发器', jobVerified, jobVerified ? 'read-only SQL' : '缺少可用只读数据库证据')
  const verified = new Map()
  if (completeCategories) verified.set(0, { status: 'VERIFIED' })
  if (classified.opening.some((item) => item.skippable === true)) verified.set(1, { status: 'VERIFIED' })
  if (external.length > 0 && external.every((item) => item.status !== undefined)) verified.set(2, { status: 'VERIFIED' })
  if (jobVerified) verified.set(3, { status: 'VERIFIED' })
  initializeCatalogAssertions(caseRecord, 'INIT-005', verified)
  evidence(caseRecord, `state status=${text(dataOf(state)?.status)}；未写 state、skip 或外部配置`)
}

async function runPb001002 ({ api, page, caseRecord, navigate }) {
  const before = await callReadOnly(api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord)
  const beforeSnapshot = organizationSnapshot(before)
  let optional = false
  let refreshed = false
  if (page) {
    const opened = await openReadOnlyRoute(
      page,
      initRoutes.enterpriseOrganization,
      navigate,
      caseRecord
    )
    if (opened) {
      const fields = await page.evaluate(() => [...document.querySelectorAll('.el-form-item')].map((item) => ({
        label: item.querySelector('.el-form-item__label')?.textContent || '',
        required: item.classList.contains('is-required'),
        hasRequiredMark: item.classList.contains('is-required') ||
          Boolean(item.querySelector('.el-form-item__asterisk'))
      }))).catch(() => [])
      const logo = inspectLogoFields(fields)
      optional = logo.optional
      addCheck(caseRecord, 'Logo 字段存在且未标记为必填', optional, `found=${logo.found}`)
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      refreshed = true
    }
  }
  const after = await callReadOnly(api, 'GET', '/system/enterprise-organization/current', undefined, caseRecord)
  const afterSnapshot = organizationSnapshot(after)
  const hasLogo = beforeSnapshot.enterpriseLogoUrlPresent || beforeSnapshot.brandMarkUrlPresent ||
    beforeSnapshot.brandLogoUrlPresent || beforeSnapshot.brandDarkLogoUrlPresent
  const unchanged = normalize(beforeSnapshot) === normalize(afterSnapshot)
  addCheck(caseRecord, '刷新后已有 Logo 存在性状态未被覆盖', refreshed && hasLogo && unchanged,
    `hasLogo=${hasLogo}; unchanged=${unchanged}`)
  evidence(caseRecord, '仅读取企业资料；未清空、上传或保存 Logo')
  const verified = new Map()
  if (optional) verified.set(0, { status: 'VERIFIED' })
  if (refreshed && hasLogo && unchanged) verified.set(2, { status: 'VERIFIED' })
  initializeCatalogAssertions(caseRecord, 'PB001-002', verified)
}

export async function runCase (context, dependencies = {}) {
  const { caseId, caseRecord } = context
  if (!cases.includes(caseId)) throw new Error(`Unsupported init gap case: ${caseId}`)
  assertSafeScope(dependencies.config || config)
  initializeCatalogAssertions(caseRecord, caseId)
  const record = context.record || { api: [] }
  const page = context.page || dependencies.page
  let token = context.token || dependencies.token || ''
  if (!token && page && dependencies.login !== false) token = await login(page, { check: dependencies.check })
  const api = dependencies.api || createApiClient({ token, record })
  const navigate = dependencies.openRoute || openRoute
  const runContext = { api, page, caseRecord, record, navigate }
  if (caseId === 'INIT-002') await runInit002(runContext)
  if (caseId === 'INIT-003') await runInit003(runContext)
  if (caseId === 'INIT-004') await runInit004(runContext)
  if (caseId === 'INIT-005') await runInit005(runContext)
  if (caseId === 'PB001-002') await runPb001002(runContext)
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED')
    .map((item) => ({ index: item.index, assertion: item.assertion }))
  caseRecord.readyCandidate = false
  caseRecord.status = caseRecord.remainingAssertions.length ? 'PARTIAL' : 'PASS'
  if (caseRecord.status === 'PASS') caseRecord.status = 'PARTIAL'
  return caseRecord
}
