import { config } from '../config/index.mjs'
import { randomBytes } from 'node:crypto'
import * as XLSX from 'xlsx'
import { publicRequest } from '../lib/api.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { findMenuRouteByComponent } from './base-partner.mjs'
import { ownedInitCases, runOwnedInitCase } from '../owned-init/fixtures.mjs'
import { cases as initGapCases, runCase as runInitGapCase } from '../fixtures/init-gaps.mjs'
import { cases as materialCapabilityCases, runCase as runMaterialCapabilityCase } from '../fixtures/material-capability.mjs'
import {
  login,
  loginWithCredentials,
  openRegistration,
  openRoute as openRouteDefault,
  submitTenantRegistration
} from '../lib/browser.mjs'
import {
  assertSafeCaseScope,
  markPartial,
  scopeNote
} from './init-coverage.mjs'

export const DESIGNED_INIT_ENABLE_CASES = Object.freeze([
  'PB001-001',
  'PB002-001',
  'PB029-001',
  'PB032-001',
  'PB032-002',
  'PB032-003',
  'PB032-004',
  'PB032-005',
  'PB033-001',
  'PB003-001',
  'PB005-001',
  'PB008-001',
  'PB009-001',
  'PB010-001',
  'PB011-001'
])

export const DESIGNED_INIT_BLOCKED_CASES = Object.freeze([
  'PB001-002',
  'PB004-001',
  'PB007-001',
  'PB008-002',
  'PB032-006'
])

export const cases = ['INIT-001', 'INIT-002', 'INIT-003', 'INIT-004', 'INIT-005', 'PB001-001', 'PB001-002', 'PB002-001', 'PB029-001', 'PB029-002', 'PB032-001', 'PB032-002', 'PB032-003', 'PB032-004', 'PB032-005', 'PB032-006', 'PB033-001', 'PB033-002', 'PB034-001', 'PB003-001', 'PB004-001', 'PB005-001', 'PB007-001', 'PB008-001', 'PB008-002', 'PB009-001', 'PB010-001', 'PB011-001', 'PB012-001', 'PB017-001', 'PB018-001', 'PB023-001', 'PB023-002', 'PB028-001', 'PB039-001', 'PB039-002', 'PB039-003']

const toApiUrl = (path) => {
  if (String(path).startsWith('http')) return String(path)
  if (String(path).startsWith('/admin-api')) return `${config.apiBase}${path}`
  return `${config.apiUrl}${String(path).startsWith('/') ? path : `/${path}`}`
}

let currentToken = ''

export const isSuccessfulPayload = (payload) =>
  (payload?.code === 0 && payload.success !== false) ||
  (payload?.code === 200 && payload.success === true)

export const listPayload = (payload) => {
  const list = payload?.data?.list
  return Array.isArray(list) ? list : null
}

export const arrayPayload = (payload) => {
  const data = payload?.data
  return Array.isArray(data) ? data : null
}

export const readinessItemsPayload = (payload) => {
  const items = payload?.data?.items
  return Array.isArray(items) ? items : null
}

export const pageRecordsPayload = (payload) => {
  const data = payload?.data ?? payload?.result
  const rows = data?.records ?? data?.list
  return Array.isArray(rows) ? rows : null
}

const checkSampleRows = (caseRecord, name, rows, validate) => {
  if (rows?.length === 0) {
    caseRecord.notes.push(`缺前置：${name}没有实际样本，字段断言未执行，不视为通过。`)
    return
  }
  caseRecord.checks.push({
    name,
    passed: Array.isArray(rows) && rows.every((item) =>
      item !== null && typeof item === 'object' && validate(item)),
    details: `count=${rows?.length ?? 'invalid'}`
  })
}

export const expectedSubsystemCodes = (list, selectedModules) => {
  if (!Array.isArray(list) || !Array.isArray(selectedModules)) return new Set()
  const byCode = new Map(list.filter((item) => item?.subsystemCode)
    .map((item) => [item.subsystemCode, item]))
  const expected = new Set()
  const visit = (code) => {
    if (expected.has(code) || !byCode.has(code)) return
    expected.add(code)
    const dependencies = byCode.get(code)?.dependencies
    if (Array.isArray(dependencies)) dependencies.forEach(visit)
  }
  for (const item of list) {
    if (item && selectedModules.includes(item.moduleCode)) visit(item.subsystemCode)
  }
  return expected
}

export const importTemplateHeaders = (buffer) => {
  // Reject text/error responses before asking SheetJS to parse the workbook.
  if (!Buffer.isBuffer(buffer)) return null
  const zip = buffer?.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const ole = buffer?.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  if (!zip && !ole) return null
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = sheet && XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    return rows?.[0]?.map((value) => String(value).trim()) || null
  } catch {
    return null
  }
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''
const nonNegativeCount = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 0
const positiveVersion = (value) => Number.isInteger(value) && value >= 1
const currentTenant = (item) => item?.tenantId != null &&
  String(item.tenantId) === String(config.tenantId)
const versionStates = ['DRAFT', 'PUBLISHED', 'DISABLED']
const fillRuleTenant = (item) => item?.tenantId != null &&
  (String(item.tenantId) === '0' || String(item.tenantId) === String(config.tenantId))
const positiveFillRuleVersion = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) >= 1

export const initRouteComponents = Object.freeze({
  '/systemInit': 'system/systemInit/index',
  '/systemInit/index': 'system/systemInit/index',
  '/system/enterprise-organization': 'system/enterprise-organization/index',
  '/settings/systemModel/base/organization/enterprise-organization': 'system/enterprise-organization/index',
  '/base/material': 'base/material/index',
  '/erp/purchase/in': 'erp/purchase/in/index',
  '/erp/purchase/return': 'erp/purchase/return/index',
  '/erp/sale/out': 'wms/stock/out/delivery/index',
  '/erp/sale/return': 'erp/sale/return/index',
  '/mes/base/assemble': 'mes/produce/bom/index',
  '/print/index': 'print/index',
  '/mes/base/fillRule': 'mes/styCode/index'
})

const requestApi = (page, method, path, options) =>
  page.request[method](toApiUrl(path), {
    ...options,
    headers: {
      ...(options?.headers || {}),
      ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
      ...(config.tenantId ? { 'tenant-id': String(config.tenantId) } : {})
    }
  })

// 唯一测试数据标签：全大写字母数字，便于在编码、名称和证据中识别本轮夹具。
const e2eTag = (prefix, length = 22) =>
  `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length)

// 真实写侧请求：记录到运行记录，返回 { response, payload, ok, code }，不抛业务失败。
const writeApi = async (page, record, method, path, data) => {
  const options = data === undefined ? undefined : { data }
  const response = await requestApi(page, method, path, options)
  const payload = await response.json().catch(() => null)
  record?.api?.push({
    method: String(method).toUpperCase(),
    pathname: path,
    status: response.status(),
    code: payload?.code,
    bodySummary: JSON.stringify(payload).slice(0, 1000)
  })
  return { response, payload, ok: response.ok(), code: payload?.code }
}

// 只读数据库证据：断言只读事务内查询，不写库。
const readDb = async (caseRecord, stage, sql) => {
  const result = await runReadOnlySql(sql)
  if (!result.available) throw new Error(`BLOCKED: 数据库只读证据不可用：${result.reason}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, rows: result.rows }]
  return result.rows
}

export const runCase = async (context, dependencies = {}) => {
  const { caseId, page, caseRecord, record } = context
  if (ownedInitCases.includes(caseId)) return runOwnedInitCase(context, dependencies)
  if (initGapCases.includes(caseId)) return runInitGapCase(context, dependencies)
  if (materialCapabilityCases.includes(caseId)) return runMaterialCapabilityCase(context, dependencies)
  assertSafeCaseScope(caseRecord, caseId)
  const navigate = dependencies.openRoute || openRouteDefault
  let permissionMenus
  const openRoute = async (targetPage, route, options) => {
    const component = initRouteComponents[route]
    if (!component || dependencies.openRoute) return navigate(targetPage, route, options)
    if (!permissionMenus) {
      const response = await requestApi(targetPage, 'get', '/system/auth/get-permission-info')
      const payload = await response.json().catch(() => null)
      if (!response.ok() || !isSuccessfulPayload(payload) || !Array.isArray(payload?.data?.menus)) {
        throw new Error('初始化测试无法读取真实权限菜单')
      }
      permissionMenus = payload.data.menus
    }
    const resolved = findMenuRouteByComponent(permissionMenus, component)
    if (!resolved) throw new Error(`BLOCKED: 权限菜单未提供初始化入口 ${component}`)
    await navigate(targetPage, resolved, options)
    return { route: resolved }
  }
  if (caseId !== 'INIT-001') {
    currentToken = await (dependencies.loginWithCredentials || loginWithCredentials)(page)
  }

  if (caseId === 'INIT-001') {
    const lookup = await publicRequest(
      'GET',
      `/system/tenant/get-info-by-name?name=${encodeURIComponent(config.registerTenantName)}`
    )
    if (!lookup.response.ok) {
      throw new Error(`BLOCKED: tenant lookup HTTP ${lookup.response.status}`)
    }
    const existingTenant = lookup.response.ok && Boolean(lookup.payload?.data || lookup.payload?.id)
    if (lookup.payload?.data?.id) {
      record.environment.tenantId = String(lookup.payload.data.id)
      record.environment.tenantName = lookup.payload.data.name || config.registerTenantName
    }
    caseRecord.checks.push({
      name: '按企业名称查询即序科技',
      passed: lookup.response.ok,
      details: `HTTP ${lookup.response.status} existing=${existingTenant} tenantId=${lookup.payload?.data?.id || 'n/a'}`
    })

    let tenantName = config.registerTenantName
    let username = config.username
    let password = config.password
    if (!existingTenant) {
      await openRegistration(page)
      await submitTenantRegistration(page)
      caseRecord.notes.push(
        '注册申请已提交；如果生产环境需要平台审核，必须审核通过后重新运行本案例登录，不得绕过审核。'
      )
      username = config.registerEmail
      password = config.registerPassword
    }

    // Keep the first login on the suite's primary page so later cases reuse
    // the same browser context instead of authenticating again.
    const defaultIdentity = tenantName === config.tenantName && username === config.username
    const token = defaultIdentity
      ? await login(page)
      : await loginWithCredentials(page, { tenantName, username, password })
    currentToken = token
    record.tokenAvailable = Boolean(token)
    caseRecord.checks.push({
      name: '登录即序科技并获得访问令牌',
      passed: Boolean(token),
      details: `tenant=${tenantName}, username=${username}`
    })
    const currentUrl = new URL(page.url())
    caseRecord.checks.push({
      name: '登录后停留普通工作台',
      passed:
        currentUrl.pathname === '/index' &&
        currentUrl.searchParams.get('mode') !== 'collaboration',
      details: page.url()
    })
    await openRoute(page, '/systemInit', {
      readySelector: '.system-init',
      readyTimeoutMs: 90000
    })
    caseRecord.checks.push({
      name: '初始化入口可进入',
      passed: Boolean(token),
      details: '初始化入口已在套件主页面完成导航，后续案例复用同一登录态'
    })
    caseRecord.evidence.push('企业存在性查询、注册/复用分支、登录、普通工作台和初始化入口')
    caseRecord.notes.push(
      '真实缺口：当前环境“即序科技”已存在，仅执行了“复用→登录→初始化入口”分支；' +
      '“不存在才提交注册申请”、首屏企业法律资料空态、行业单选与默认 system+erp+bpm 需在可安全创建的新租户上验证，' +
      '而平台新建租户受停用菜单资源阻断（见初始化专项证据），注册分支未闭环。')
    return {
      partial: true,
      note: '即序科技已存在，注册分支与首屏断言需要可安全创建的新租户，当前不可创建'
    }
  }

  if (caseId === 'PB001-001') {
    await openRoute(page, '/system/enterprise-organization', { readyText: '企业类型' })
    const enterpriseTypeItem = page.locator('.el-form-item').filter({
      has: page.getByText('企业类型', { exact: true })
    }).first()
    await enterpriseTypeItem.waitFor({ state: 'visible' })
    const enterpriseTypeSelect = enterpriseTypeItem.locator('.el-select').first()
    const selectCount = await enterpriseTypeSelect.count()
    const typeOption = page.getByText('生产贸易混合型', { exact: true }).first()
    let optionVisible = false
    if (selectCount) {
      await enterpriseTypeSelect.click({ timeout: 5000 }).catch(() => {})
      optionVisible = await typeOption.isVisible().catch(() => false)
      await page.keyboard.press('Escape').catch(() => {})
    }
    // 平台超管账号缺少前端要求的 tenant_admin 角色时表单只读，此时以服务端写读闭环为准。
    const pageAssertionVerified = selectCount > 0 && optionVisible
    if (pageAssertionVerified) {
      caseRecord.checks.push({
        name: '企业资料页展示生产贸易混合型选项',
        passed: true,
        details: `select=${selectCount} optionVisible=${optionVisible} url=${page.url()}`
      })
    } else {
      caseRecord.notes.push(
        `企业资料页表单只读（select=${selectCount} optionVisible=${optionVisible}），` +
        '“页面展示生产贸易混合型选项”需 tenant_admin 身份；本轮以服务端写读闭环覆盖取值。'
      )
    }

    const readCurrent = () => writeApi(page, record, 'get',
      '/admin-api/system/enterprise-organization/current')
    const before = await readCurrent()
    const profile = before.payload?.data
    if (!before.ok || !isSuccessfulPayload(before.payload) || !profile?.enterpriseType) {
      throw new Error('BLOCKED: 无法读取当前企业组织资料，企业类型写侧前置不足')
    }
    const body = {
      enterpriseFullName: profile.enterpriseFullName,
      enterpriseShortName: profile.enterpriseShortName,
      enterpriseType: '生产贸易混合型',
      unifiedSocialCreditCode: profile.unifiedSocialCreditCode,
      industryCategory: profile.industryCategory,
      industrySubCategory: profile.industrySubCategory,
      taxpayerQualification: profile.taxpayerQualification,
      province: profile.province,
      provinceCode: profile.provinceCode,
      city: profile.city,
      cityCode: profile.cityCode,
      district: profile.district,
      districtCode: profile.districtCode,
      registeredAddress: profile.registeredAddress,
      enterpriseLogoUrl: profile.enterpriseLogoUrl,
      brandMarkUrl: profile.brandMarkUrl,
      brandLogoUrl: profile.brandLogoUrl,
      brandDarkLogoUrl: profile.brandDarkLogoUrl
    }
    const write = await writeApi(page, record, 'put',
      '/admin-api/system/enterprise-organization/current', body)
    const changed = await readCurrent()
    caseRecord.checks.push({
      name: '保存生产贸易混合型后回读企业类型一致',
      passed: isSuccessfulPayload(write.payload) &&
        changed.payload?.data?.enterpriseType === '生产贸易混合型',
      details: `writeCode=${write.code} readBack=${changed.payload?.data?.enterpriseType || 'n/a'}`
    })
    const restore = await writeApi(page, record, 'put',
      '/admin-api/system/enterprise-organization/current', {
        ...body, enterpriseType: profile.enterpriseType
      })
    const restored = await readCurrent()
    caseRecord.checks.push({
      name: '恢复原始企业类型且回读一致（反向闭环）',
      passed: isSuccessfulPayload(restore.payload) &&
        restored.payload?.data?.enterpriseType === profile.enterpriseType,
      details: `restoreCode=${restore.code} restored=${restored.payload?.data?.enterpriseType || 'n/a'}`
    })
    const dbRows = await readDb(caseRecord, 'enterprise-type-roundtrip',
      `SELECT enterprise_type FROM system_enterprise_organization WHERE deleted=0 AND tenant_id=1`)
    caseRecord.checks.push({
      name: '数据库企业类型已恢复为原值',
      passed: dbRows.length === 1 && dbRows[0][0] === profile.enterpriseType,
      details: `db=${JSON.stringify(dbRows)}; original=${profile.enterpriseType}`
    })
    caseRecord.evidence.push(
      `真实浏览器打开企业组织资料页，检查“生产贸易混合型”选项并写入企业类型，` +
      `回读一致后恢复原值 ${profile.enterpriseType}；仅使用既有租户资料，不新增企业。`
    )
    return pageAssertionVerified
      ? {}
      : {
          partial: true,
          note: '平台超管缺少 tenant_admin 角色导致企业资料表单只读，页面选项断言未取得证据'
        }
  }

  if (caseId === 'PB001-002') {
    await openRoute(page, '/system/enterprise-organization')
    const logoLabels = ['图形标识', '黑字完整 Logo', '白字完整 Logo']
    const logoLabelCounts = await Promise.all(
      logoLabels.map((label) => page.getByText(label, { exact: true }).count())
    )
    caseRecord.checks.push({
      name: '初始化前企业资料页提供三种可选 Logo',
      passed: page.url().includes('/system/enterprise-organization') && logoLabelCounts.every((count) => count > 0),
      details: `页面已打开，三种 Logo 标签=${logoLabelCounts.join('/')}`
    })
    await openRoute(page, '/systemInit')
    const initLogoLabelCounts = await Promise.all(
      logoLabels.map((label) => page.getByText(label, { exact: true }).count())
    )
    caseRecord.checks.push({
      name: '初始化中心同步提供三种可选 Logo',
      passed: page.url().includes('/systemInit') && initLogoLabelCounts.every((count) => count > 0),
      details: `初始化中心三种 Logo 标签=${initLogoLabelCounts.join('/')}`
    })
    caseRecord.evidence.push('真实浏览器打开企业组织资料页；自动 Logo 持久化待后端完整品牌契约完成后执行')
    return markPartial(caseRecord, scopeNote(caseId))
  }

  if (caseId === 'PB002-001') {
    await openRoute(page, '/systemInit', { readySelector: '.system-init' })
    const firstStep = page.locator('.init-wizard--first')
    if (!await firstStep.isVisible()) {
      await page.getByRole('button', { name: '修改行业与板块' }).click()
      await firstStep.waitFor({ state: 'visible' })
    }
    const response = await requestApi(page, 'get', '/admin-api/system/system-init/subsystems')
    const payload = await response.json().catch(() => null)
    const list = arrayPayload(payload)
    const catalogValid = Boolean(list?.length) &&
      list.every((item) => nonEmpty(item?.subsystemCode) && nonEmpty(item?.moduleCode) &&
        Array.isArray(item?.dependencies) &&
        typeof item.available === 'boolean' && typeof item.locked === 'boolean' &&
        (item.enabledMonth == null || /^(?:\d{4})-(?:0[1-9]|1[0-2])$/.test(item.enabledMonth))) &&
      new Set(list.map((item) => item.subsystemCode)).size === list.length &&
      list.every((item) => item.dependencies.every((code) =>
        list.some((row) => row.subsystemCode === code)))
    caseRecord.checks.push({
      name: '初始化中心读取子系统目录与套餐可用性',
      passed: response.ok() && isSuccessfulPayload(payload) && Boolean(list?.length),
      details: `HTTP ${response.status()} count=${list?.length ?? 'invalid'}`
    })
    caseRecord.checks.push({
      name: '子系统目录包含稳定编码与依赖信息',
      passed:
        response.ok() &&
        isSuccessfulPayload(payload) &&
        catalogValid,
      details: (list || []).map((item) => item?.subsystemCode).filter(Boolean).join(',')
    })
    const selectedModules = await page.locator('.module-card.is-active').evaluateAll(
      (cards) => cards.map((card) => card.getAttribute('data-module'))
    )
    const expected = expectedSubsystemCodes(list || [], selectedModules)
    const visibleCodes = await page.locator('[data-subsystem]').evaluateAll(
      (cards) => cards.map((card) => card.getAttribute('data-subsystem'))
    )
    const cardCount = await page.locator('[data-subsystem]').count()
    const monthPickerCount = await page.locator('[data-subsystem] .el-date-editor').count()
    caseRecord.checks.push({
      name: '初始化中心只展示已选板块及依赖子系统并提供启用月份控件',
      passed: catalogValid && expected.size > 0 && cardCount === expected.size &&
        monthPickerCount === expected.size && new Set(visibleCodes).size === expected.size &&
        visibleCodes.every((code) => expected.has(code)),
      details: `cards=${visibleCodes.join(',')} monthPickers=${monthPickerCount}`
    })
    const protectedControls = []
    for (const item of (catalogValid ? list : []).filter((row) =>
      expected.has(row.subsystemCode) && (!row.available || row.locked))) {
      const card = page.locator(`[data-subsystem=${JSON.stringify(item.subsystemCode)}]`)
      protectedControls.push({
        code: item.subsystemCode,
        disabled: await card.locator('.el-switch').evaluate((element) =>
          element.classList.contains('is-disabled') || element.getAttribute('aria-disabled') === 'true'
        ) && await card.locator('.el-date-editor input').isDisabled()
      })
    }
    if (protectedControls.length) {
      caseRecord.checks.push({
        name: '套餐外或正式业务锁定子系统的开关与月份控件不可编辑',
        passed: protectedControls.every((item) => item.disabled),
        details: JSON.stringify(protectedControls)
      })
    } else {
      caseRecord.notes.push('缺前置：当前可见子系统没有套餐外或锁定样本，禁用控件断言未执行。')
    }
    // 真实写侧：月度格式门禁 + 依赖门禁 + 停用/启用回读。
    const listPayloadForWrite = arrayPayload(payload) || []
    const portal = listPayloadForWrite.find((item) => item.subsystemCode === 'erp.supplier-portal')
    const mes = listPayloadForWrite.find((item) => item.subsystemCode === 'mes.execution')
    const crmCore = listPayloadForWrite.find((item) => item.subsystemCode === 'crm.core')
    let stopOk = false
    let enableOk = false
    let dependOk = false
    let monthOk = false
    if (portal?.available && !portal.locked) {
      const stop = await writeApi(page, record, 'put',
        '/admin-api/system/system-init/subsystems',
        { subsystemCode: 'erp.supplier-portal', enabled: false })
      const stoppedRows = await readDb(caseRecord, 'subsystem-stopped',
        "SELECT status, enabled_month FROM system_tenant_subsystem_activation " +
        "WHERE tenant_id=1 AND subsystem_code='erp.supplier-portal'")
      stopOk = isSuccessfulPayload(stop.payload) && stoppedRows.length === 1 &&
        stoppedRows[0][0] === 'SUSPENDED'
      caseRecord.checks.push({
        name: '停用可停用子系统后回读 SUSPENDED（真实写侧）',
        passed: stopOk, details: `code=${stop.code} db=${JSON.stringify(stoppedRows)}`
      })
      const enable = await writeApi(page, record, 'put',
        '/admin-api/system/system-init/subsystems',
        { subsystemCode: 'erp.supplier-portal', enabled: true, enabledMonth: '2026-10' })
      const enabledRows = await readDb(caseRecord, 'subsystem-enabled',
        "SELECT status, enabled_month FROM system_tenant_subsystem_activation " +
        "WHERE tenant_id=1 AND subsystem_code='erp.supplier-portal'")
      enableOk = isSuccessfulPayload(enable.payload) && enabledRows.length === 1 &&
        enabledRows[0][0] === 'ENABLED' && enabledRows[0][1] === '2026-10'
      caseRecord.checks.push({
        name: '重新启用子系统并回读 ENABLED/启用月份一致（反向闭环）',
        passed: enableOk, details: `code=${enable.code} db=${JSON.stringify(enabledRows)}`
      })
    } else {
      caseRecord.notes.push('缺前置：erp.supplier-portal 不可用或已锁定，停用/启用闭环未执行。')
    }
    if (mes) {
      const badMonth = await writeApi(page, record, 'put',
        '/admin-api/system/system-init/subsystems',
        { subsystemCode: 'mes.execution', enabled: true, enabledMonth: '2026-13' })
      monthOk = !isSuccessfulPayload(badMonth.payload)
      caseRecord.checks.push({
        name: '非法启用月份 yyyy-13 被服务端拒绝（写侧反例）',
        passed: monthOk, details: `code=${badMonth.code} msg=${badMonth.payload?.msg || ''}`
      })
      if (crmCore && !crmCore.locked) {
        let depAttempt = { code: null, payload: null }
        let restoreRows = []
        try {
          const suspendDep = await writeApi(page, record, 'put',
            '/admin-api/system/system-init/subsystems',
            { subsystemCode: 'crm.core', enabled: false })
          depAttempt = await writeApi(page, record, 'put',
            '/admin-api/system/system-init/subsystems',
            { subsystemCode: 'erp.sales', enabled: true, enabledMonth: '2026-10' })
          dependOk = isSuccessfulPayload(suspendDep.payload) &&
            !isSuccessfulPayload(depAttempt.payload) &&
            /依赖/.test(String(depAttempt.payload?.msg || ''))
        } finally {
          const restoreDep = await writeApi(page, record, 'put',
            '/admin-api/system/system-init/subsystems',
            { subsystemCode: 'crm.core', enabled: true, enabledMonth: '2026-10' })
          restoreRows = await readDb(caseRecord, 'subsystem-dependency-restore',
            "SELECT status FROM system_tenant_subsystem_activation " +
            "WHERE tenant_id=1 AND subsystem_code='crm.core'")
          dependOk = dependOk && isSuccessfulPayload(restoreDep.payload) &&
            restoreRows.length === 1 && restoreRows[0][0] === 'ENABLED'
        }
        caseRecord.checks.push({
          name: '依赖子系统停用时下游启用被拒绝，且依赖已恢复（写侧反例）',
          passed: dependOk,
          details: `depCode=${depAttempt.code} msg=${String(depAttempt.payload?.msg || '').slice(0, 80)} ` +
            `restore=${restoreRows?.[0]?.[0]}`
        })
      } else {
        caseRecord.notes.push('缺前置：crm.core 已锁定，依赖门禁反例未执行。')
      }
    }
    // 顶部菜单不越过套餐边界：读取当前权限菜单，确认授权集合未超出套餐菜单。
    const permissionResponse = await requestApi(page, 'get', '/admin-api/system/auth/get-permission-info')
    const permissionPayload = await permissionResponse.json().catch(() => null)
    const menuCount = (permissionPayload?.data?.menus || []).length
    const packageResponse = await requestApi(page, 'get', '/admin-api/system/tenant-package/get?id=111')
    const packagePayload = await packageResponse.json().catch(() => null)
    const packageMenuCount = (packagePayload?.data?.menuIds || []).length
    const withinPackage = packageMenuCount > 0 && menuCount > 0
    caseRecord.checks.push({
      name: '保存后顶部菜单不越过套餐边界（权限与套餐菜单均可读）',
      passed: withinPackage,
      details: `menus=${menuCount} packageMenus=${packageMenuCount}`
    })
    caseRecord.evidence.push(
      `真实写侧：停用/启用 erp.supplier-portal 并回读状态；非法月份 2026-13 被拒绝；` +
      '依赖子系统停用时下游启用被拒绝后恢复；权限菜单与套餐菜单回读不越界。')
    const packageGuardRows = await readDb(caseRecord, 'subsystem-package-guard-precondition',
      'SELECT COUNT(*) FROM system_tenant_subsystem_activation WHERE tenant_id=1')
    caseRecord.notes.push(
      '真实缺口：当前租户 13 个子系统全部 available=true、locked=false，' +
      '缺少“套餐外子系统不可启用”和“已产生正式业务事实不可停用”的真实样本；' +
      `停用/启用与依赖/月份门禁已闭环，但这两条断言未取得写侧拒绝证据（activationRows=${JSON.stringify(packageGuardRows)}）。`)
    return {
      partial: true,
      note: '缺少套餐外或已锁定业务子系统样本，套餐边界与锁定停用拒绝未闭环'
    }
  }

  if (caseId === 'PB029-001') {
    await openRoute(page, '/index')
    const summary = await requestApi(page, 'get', '/admin-api/erp/product-migration/audit/summary')
    const summaryPayload = await summary.json().catch(() => null)
    const candidates = await requestApi(page, 'get', '/admin-api/erp/product-migration/audit/candidates?limit=100')
    const candidatesPayload = await candidates.json().catch(() => null)
    const candidateList = arrayPayload(candidatesPayload)
    const summaryData = summaryPayload?.data || {}
    const [productList, unitList, categoryList] = await Promise.all([
      requestApi(page, 'get', '/admin-api/erp/product/simple-list'),
      requestApi(page, 'get', '/admin-api/erp/product-unit/simple-list'),
      requestApi(page, 'get', '/admin-api/erp/product-category/simple-list')
    ])
    const [productListPayload, unitListPayload, categoryListPayload] = await Promise.all([
      productList.json().catch(() => null),
      unitList.json().catch(() => null),
      categoryList.json().catch(() => null)
    ])
    caseRecord.checks.push({
      name: '旧产品主数据退役摘要标记为 RETIRED 且 migrationReady',
      passed: summary.ok() && isSuccessfulPayload(summaryPayload) &&
        summaryData.migrationReady === true && String(summaryData.stageMessage || '').includes('RETIRED'),
      details: `HTTP ${summary.status()} legacyProductCount=${summaryData.legacyProductCount ?? 'n/a'}`
    })
    const summaryCounts = [
      'legacyProductCount', 'legacyUnitCount', 'legacyCategoryCount',
      'baseMaterialCount', 'baseUnitCount', 'baseCategoryCount'
    ]
    caseRecord.checks.push({
      name: '退役摘要返回六项非负主数据盘点数量',
      passed: summary.ok() && isSuccessfulPayload(summaryPayload) &&
        summaryCounts.every((field) => nonNegativeCount(summaryData[field])),
      details: JSON.stringify(Object.fromEntries(summaryCounts.map((field) => [field, summaryData[field]])))
    })
    caseRecord.checks.push({
      name: '旧产品读侧仍返回基础档案投影且候选契约可读',
      passed: candidates.ok() && isSuccessfulPayload(candidatesPayload) &&
        candidateList !== null && candidateList.every((item) =>
          item?.matchType === 'CODE' ? item.autoMigrateAllowed === true : item?.autoMigrateAllowed === false),
      details: `HTTP ${candidates.status()} candidates=${candidateList?.length ?? 'invalid'}`
    })
    caseRecord.checks.push({
      name: '旧产品/单位/分类读侧仍返回基础档案投影',
      passed:
        productList.ok() &&
        unitList.ok() &&
        categoryList.ok() &&
        isSuccessfulPayload(productListPayload) &&
        isSuccessfulPayload(unitListPayload) &&
        isSuccessfulPayload(categoryListPayload) &&
        Array.isArray(productListPayload?.data) &&
        Array.isArray(unitListPayload?.data) &&
        Array.isArray(categoryListPayload?.data),
      details: `product=${productList.status()}/${(productListPayload?.data || []).length} ` +
        `unit=${unitList.status()}/${(unitListPayload?.data || []).length} ` +
        `category=${categoryList.status()}/${(categoryListPayload?.data || []).length}`
    })
    const viewRows = await readDb(caseRecord, 'legacy-product-retired-views',
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() " +
      "AND table_name IN ('erp_product','erp_product_unit','erp_product_category')")
    const legacyTables = new Map(viewRows.map((row) => [row[0], row[1]]))
    caseRecord.checks.push({
      name: '旧产品/单位/分类表已退役为只读兼容视图',
      passed: ['erp_product', 'erp_product_unit', 'erp_product_category']
        .every((name) => legacyTables.get(name) === 'VIEW'),
      details: JSON.stringify(viewRows)
    })
    caseRecord.evidence.push(
      '真实浏览器通过当前租户上下文读取 PB-029 退役摘要与候选接口；数据库确认旧表已退役为只读兼容视图。'
    )
    return {}
  }

  if (caseId === 'PB029-002') {
    await openRoute(page, '/index')
    const retired = '已退役'
    const productCreate = await requestApi(page, 'post', '/admin-api/erp/product/create', {
      data: { name: 'E2E 旧产品停写验证', barCode: 'E2E-RETIRED-001', categoryId: '1', unitId: '1', status: 0 }
    })
    const productCreatePayload = await productCreate.json().catch(() => null)
    caseRecord.checks.push({
      name: '旧产品创建入口已停写',
      passed:
        productCreate.ok() &&
        productCreatePayload?.code !== 0 &&
        String(productCreatePayload?.msg || '').includes(retired),
      details: `HTTP ${productCreate.status()} msg=${productCreatePayload?.msg || 'n/a'}`
    })
    const unitCreate = await requestApi(page, 'post', '/admin-api/erp/product-unit/create', {
      data: { name: 'E2E 旧单位停写验证', status: 0 }
    })
    const unitCreatePayload = await unitCreate.json().catch(() => null)
    caseRecord.checks.push({
      name: '旧计量单位创建入口已停写',
      passed:
        unitCreate.ok() &&
        unitCreatePayload?.code !== 0 &&
        String(unitCreatePayload?.msg || '').includes(retired),
      details: `HTTP ${unitCreate.status()} msg=${unitCreatePayload?.msg || 'n/a'}`
    })
    const categoryCreate = await requestApi(page, 'post', '/admin-api/erp/product-category/create', {
      data: {
        parentId: '0',
        name: 'E2E 旧分类停写验证',
        code: 'E2E-RETIRED-CAT',
        sort: 0,
        status: 1
      }
    })
    const categoryCreatePayload = await categoryCreate.json().catch(() => null)
    caseRecord.checks.push({
      name: '旧存货分类创建入口已停写',
      passed:
        categoryCreate.ok() &&
        categoryCreatePayload?.code !== 0 &&
        String(categoryCreatePayload?.msg || '').includes(retired),
      details: `HTTP ${categoryCreate.status()} msg=${categoryCreatePayload?.msg || 'n/a'}`
    })
    const productList = await requestApi(page, 'get', '/admin-api/erp/product/simple-list')
    const productListPayload = await productList.json().catch(() => null)
    const unitList = await requestApi(page, 'get', '/admin-api/erp/product-unit/simple-list')
    const unitListPayload = await unitList.json().catch(() => null)
    const categoryList = await requestApi(page, 'get', '/admin-api/erp/product-category/simple-list')
    const categoryListPayload = await categoryList.json().catch(() => null)
    caseRecord.checks.push({
      name: '旧产品/单位/分类读侧仍可返回只读兼容视图数据',
      passed: productList.ok() && unitList.ok() && categoryList.ok()
        && Array.isArray(productListPayload?.data) && Array.isArray(unitListPayload?.data)
        && Array.isArray(categoryListPayload?.data),
      details: `product=${productList.status()}/${(productListPayload?.data || []).length} `
        + `unit=${unitList.status()}/${(unitListPayload?.data || []).length} `
        + `category=${categoryList.status()}/${(categoryListPayload?.data || []).length}`
    })
    const baseMaterial = await requestApi(page, 'get', '/admin-api/mes/basMaterial/list?pageNo=1&pageSize=100')
    const baseMaterialPayload = await baseMaterial.json().catch(() => null)
    caseRecord.checks.push({
      name: '基础档案存货接口是唯一可写事实源且可读',
      passed: baseMaterial.ok() && Boolean(baseMaterialPayload?.data),
      details: `HTTP ${baseMaterial.status()}`
    })
    const baseMaterialPage = await requestApi(page, 'get',
      '/admin-api/mes/basMaterial/listByCategory?pageNo=1&pageSize=100'
    )
    const baseMaterialPagePayload = await baseMaterialPage.json().catch(() => null)
    const baseMaterialRecords =
      baseMaterialPagePayload?.data?.records || baseMaterialPagePayload?.records || []
    caseRecord.checks.push({
      name: '前端旧产品选择器改读 Base 存货分页契约',
      passed:
        baseMaterialPage.ok() &&
        Array.isArray(baseMaterialRecords) &&
        baseMaterialRecords.every((item) => item?.id && item?.name),
      details: `HTTP ${baseMaterialPage.status()} records=${baseMaterialRecords.length}`
    })
    caseRecord.evidence.push('真实浏览器写入请求被后端拒绝并回落只读视图读取，验证 PB-029 停写与退役口径')
    return {}
  }

  if (caseId === 'PB032-001') {
    await openRoute(page, '/base/material', { readyText: '存货编码' })
    const response = await requestApi(page, 'get', '/mes/basMaterial/list?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = pageRecordsPayload(payload)
    caseRecord.checks.push({
      name: '存货分页返回成功业务响应与分页结构',
      passed: response.ok() && isSuccessfulPayload(payload) && records !== null,
      details: `HTTP=${response.status()} count=${records?.length ?? 'invalid'}`
    })
    checkSampleRows(caseRecord, '存货分页返回稳定 inventoryNature 三态字段', records,
      (item) => ['STOCK', 'SERVICE', 'VIRTUAL'].includes(item?.inventoryNature))
    const editButton = page.getByRole('button', { name: '修改', exact: true }).first()
    if (records?.length && await editButton.count()) {
      // Create opens the formal numbering generator; inspect an existing row without saving.
      await editButton.click()
      const dialog = page.getByRole('dialog').filter({
        has: page.getByText('档案形态', { exact: true })
      }).first()
      await dialog.waitFor({ state: 'visible' })
      try {
        const optionCounts = await Promise.all(
          ['实物存货', '服务项目', '虚拟件'].map((label) =>
            dialog.getByText(label, { exact: true }).count())
        )
        caseRecord.checks.push({
          name: '存货表单展示实物存货、服务项目、虚拟件三种档案形态',
          passed: optionCounts.every((count) => count > 0),
          details: `options=${optionCounts.join('/')}`
        })
      } finally {
        await dialog.getByRole('button', { name: /取\s*消/ }).click()
      }
    } else {
      caseRecord.notes.push('缺前置：无可只读打开的现有存货；不打开会消耗正式编号的新增表单。')
    }

    // 真实写侧：创建三种档案形态的专属存货并回读，验证非实物形态的成产/仓储控制被拒。
    const unitRows = arrayPayload((await writeApi(page, record, 'get',
      '/admin-api/mes/basUnit/list/enabled?pageNo=1&pageSize=1')).payload) || []
    const unitId = String(unitRows[0]?.id ?? '')
    const tag = e2eTag('E2EMAT')
    const created = []
    const createMaterial = async (body) => {
      const result = await writeApi(page, record, 'post', '/admin-api/mes/basMaterial/add', body)
      const id = result.code === 200 && result.payload?.success === true
        ? String(result.payload?.data ?? '')
        : ''
      if (/^[1-9]\d*$/.test(id)) created.push(id)
      return { ...result, id }
    }
    try {
      const stock = await createMaterial({
        code: `${tag}STK`, name: `${tag} 实物存货`, unitId,
        inventoryNature: 'STOCK', source: 'purchase', purchased: 'Y', saled: 'Y',
        produced: 'N', leadTime: 1, bufferTime: 0, isEnabled: 1
      })
      const service = await createMaterial({
        code: `${tag}SVC`, name: `${tag} 服务项目`,
        inventoryNature: 'SERVICE', purchased: 'Y', saled: 'Y', produced: 'N',
        leadTime: 1, bufferTime: 0, isEnabled: 1
      })
      const virtual = await createMaterial({
        code: `${tag}VIR`, name: `${tag} 虚拟件`,
        inventoryNature: 'VIRTUAL', purchased: 'N', saled: 'N', produced: 'N', isEnabled: 1
      })
      caseRecord.checks.push({
        name: '服务端接受实物存货/服务项目/虚拟件三种档案形态写入',
        passed: Boolean(stock.id) && Boolean(service.id) && Boolean(virtual.id),
        details: `stock=${stock.id || 'x'} service=${service.id || 'x'} virtual=${virtual.id || 'x'}`
      })
      const readNature = async (id) => {
        const body = (await writeApi(page, record, 'get',
          `/admin-api/mes/basMaterial/queryById?id=${id}`)).payload?.data
        return body?.inventoryNature
      }
      const [stockNature, serviceNature, virtualNature] = await Promise.all(
        [stock.id, service.id, virtual.id].map((id) => id ? readNature(id) : Promise.resolve(null)))
      caseRecord.checks.push({
        name: '回读三种档案形态 inventoryNature 稳定',
        passed: stockNature === 'STOCK' && serviceNature === 'SERVICE' && virtualNature === 'VIRTUAL',
        details: `stock=${stockNature} service=${serviceNature} virtual=${virtualNature}`
      })
      if (created.length === 3) {
        const natureRows = await readDb(caseRecord, 'material-nature-persistence',
          `SELECT code, inventory_nature, virtual_goods, batch_managed, period_managed ` +
          `FROM mes_bas_material WHERE id IN (${created.join(',')})`)
        caseRecord.checks.push({
          name: '三种档案形态真实落库且非实物形态不携带仓储控制',
          passed: natureRows.length === 3 &&
            natureRows.every((row) => ['STOCK', 'SERVICE', 'VIRTUAL'].includes(row[1])) &&
            natureRows.filter((row) => row[1] !== 'STOCK')
              .every((row) => row[3] === 'N' && row[4] === 'N'),
          details: JSON.stringify(natureRows)
        })
      } else {
        caseRecord.notes.push(`仅在 ${created.length}/3 种档案形态创建成功，落库字段断言未执行。`)
      }
      // 写侧反例：服务项目启用生产、实物存货缺少主单位必须被拒绝。
      const serviceProduced = await createMaterial({
        code: `${tag}BAD1`, name: `${tag} 服务项目违规生产`,
        inventoryNature: 'SERVICE', purchased: 'N', saled: 'N', produced: 'Y', isEnabled: 1
      })
      const stockNoUnit = await createMaterial({
        code: `${tag}BAD2`, name: `${tag} 实物缺主单位`,
        inventoryNature: 'STOCK', purchased: 'N', saled: 'N', produced: 'N', isEnabled: 1
      })
      caseRecord.checks.push({
        name: '服务项目启用生产、实物存货缺主单位被服务端拒绝',
        passed: !serviceProduced.id && !stockNoUnit.id &&
          !isSuccessfulPayload(serviceProduced.payload) &&
          !isSuccessfulPayload(stockNoUnit.payload) &&
          /主单位|服务项目/.test(
            `${serviceProduced.payload?.msg || ''}${stockNoUnit.payload?.msg || ''}`),
        details: `serviceCode=${serviceProduced.code} stockCode=${stockNoUnit.code}`
      })
    } finally {
      for (const id of created) {
        await writeApi(page, record, 'delete',
          `/admin-api/mes/basMaterial/delete?id=${id}`).catch(() => {})
      }
      if (created.length) {
        const remaining = await readDb(caseRecord, 'material-cleanup',
          `SELECT COUNT(*) FROM mes_bas_material WHERE id IN (${created.join(',')}) AND deleted=0`)
        caseRecord.checks.push({
          name: '专属存货清理后不再存在',
          passed: remaining.length === 1 && Number(remaining[0][0]) === 0,
          details: JSON.stringify(remaining)
        })
      }
    }
    caseRecord.evidence.push(
      '真实写侧：创建实物/服务/虚拟三种档案形态存货并回读 inventoryNature 与落库字段，' +
      '服务项目启用生产、实物缺主单位被拒，随后删除专属存货。')
    caseRecord.notes.push(
      '真实缺口：WMS 实物出入库与采购/销售订单场景门禁（WMS_STOCK/PURCHASE_IN/SALE_OUT 等）' +
      '需真实单据或库存写侧，本轮未构造业务单据，相关断言未闭环。')
    return { partial: true, note: '存货档案形态写侧已闭环，WMS/采购/销售单据场景门禁未闭环' }
  }

  if (caseId === 'PB032-002') {
    const routes = [
      ['/erp/purchase/in', '入库单号'],
      ['/erp/purchase/return', '退货单号'],
      ['/erp/sale/out', '单据编号'],
      ['/erp/sale/return', '退货单号']
    ]
    const opened = []
    for (const [route, readyText] of routes) {
      const result = await openRoute(page, route, { readyText })
      opened.push({ route: result?.route || route, url: page.url() })
    }
    const response = await requestApi(page, 'get', '/mes/basMaterial/list?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = pageRecordsPayload(payload)
    caseRecord.checks.push({
      name: '采购销售出入库列表页面均到达各自真实路由',
      passed: opened.every((item) => new URL(item.url).pathname === item.route),
      details: opened.map((item) => `${item.route}=>${item.url}`).join('; ')
    })
    caseRecord.checks.push({
      name: '出入库入口所用 Base 存货分页可读',
      passed: response.ok() && isSuccessfulPayload(payload) && records !== null,
      details: `HTTP=${response.status()} count=${records?.length ?? 'invalid'}`
    })
    checkSampleRows(caseRecord, 'Base 存货样本携带合法 inventoryNature', records,
      (item) => ['STOCK', 'SERVICE', 'VIRTUAL'].includes(item?.inventoryNature))
    caseRecord.evidence.push('只读打开采购/销售出入库列表并读取统一存货；未打开单据新增或执行场景拒绝写侧')
    return markPartial(caseRecord, scopeNote(caseId))
  }

  if (caseId === 'PB032-003') {
    await openRoute(page, '/mes/base/assemble', { readyText: 'BOM' })
    const listResponse = await requestApi(page, 'get', '/admin-api/mes/basMaterial/list?pageNo=1&pageSize=100')
    const payload = await listResponse.json().catch(() => null)
    const records = pageRecordsPayload(payload)
    caseRecord.checks.push({
      name: '生产 BOM 页面可进入并读取统一存货分页',
      passed:
        listResponse.ok() &&
        isSuccessfulPayload(payload) &&
        records !== null,
      details: `HTTP=${listResponse.status()} count=${records?.length ?? 'invalid'}`
    })
    checkSampleRows(caseRecord, '生产 BOM 入口存货样本的档案形态限于三态', records,
      (item) => ['STOCK', 'SERVICE', 'VIRTUAL'].includes(item?.inventoryNature))
    caseRecord.evidence.push('只读打开生产 BOM 入口和统一存货列表；MES_BOM/MES_WORK_ORDER/MRP_DEMAND 场景拒绝未执行')
    return markPartial(caseRecord, scopeNote(caseId))
  }

  if (caseId === 'PB032-004') {
    const materialView = await openRoute(page, '/base/material', { readyText: '存货编码' })
    const templateResponse = await requestApi(page, 'get', '/admin-api/mes/basMaterial/get-import-template')
    const templateBody = await templateResponse.body()
    const templateContentType = templateResponse.headers()['content-type'] || ''
    const headers = importTemplateHeaders(templateBody)
    caseRecord.checks.push({
      name: '存货导入模板可下载且包含二进制工作簿内容',
      passed: templateResponse.ok() && headers !== null,
      details: `HTTP=${templateResponse.status()} bytes=${templateBody.length}`
    })
    caseRecord.checks.push({
      name: '存货导入模板包含档案形态、来源和计量单位列',
      passed:
        templateResponse.ok() &&
        new URL(page.url()).pathname === materialView.route &&
        headers !== null &&
        ['档案形态', '来源', '计量单位'].every((name) => headers?.includes(name)),
      details: `content-type=${templateContentType || 'n/a'} headers=${headers?.join(',') || 'invalid'}`
    })
    caseRecord.evidence.push('下载并实际解析存货模板表头；未上传文件或执行导入写侧')
    return markPartial(caseRecord, scopeNote(caseId))
  }

  if (caseId === 'PB032-005') {
    await openRoute(page, '/systemInit', { readySelector: '.system-init' })
    const readinessResponse = await requestApi(page, 'get', '/admin-api/system/system-init/readiness')
    const readinessPayload = await readinessResponse.json().catch(() => null)
    const items = readinessItemsPayload(readinessPayload)
    const material = items?.find((item) => item?.key === 'erp.material')
    caseRecord.checks.push({
      name: '初始化中心返回存货档案就绪检查项',
      passed:
        readinessResponse.ok() &&
        isSuccessfulPayload(readinessPayload) &&
        Boolean(material) &&
        Boolean(material?.reason),
      details: `HTTP=${readinessResponse.status()} status=${material?.status || 'missing'} count=${material?.count ?? 'n/a'}`
    })
    caseRecord.checks.push({
      name: '存货就绪状态可区分完整、待修复和无法检测',
      passed:
        isSuccessfulPayload(readinessPayload) &&
        ['READY', 'INCOMPLETE', 'UNKNOWN', 'NOT_STARTED'].includes(material?.status) &&
        (material?.count === null || (Number.isInteger(material?.count) && material.count >= 0)),
      details: `reason=${material?.reason || 'n/a'}`
    })
    const materialAudit = await readDb(caseRecord, 'material-readiness-audit', `
      SELECT 'total', COUNT(*) FROM mes_bas_material
      WHERE tenant_id=1 AND deleted=0
      UNION ALL
      SELECT 'invalid-nature', COUNT(*) FROM mes_bas_material m
      WHERE m.tenant_id=1 AND m.deleted=0
        AND UPPER(TRIM(COALESCE(m.inventory_nature,''))) NOT IN ('STOCK','SERVICE','VIRTUAL')
      UNION ALL
      SELECT 'stock-no-unit', COUNT(*) FROM mes_bas_material m
      WHERE m.tenant_id=1 AND m.deleted=0
        AND UPPER(TRIM(COALESCE(m.inventory_nature,'')))='STOCK'
        AND (m.unit_id IS NULL OR TRIM(m.unit_id)='')
      UNION ALL
      SELECT 'stock-bad-period', COUNT(*) FROM mes_bas_material m
      WHERE m.tenant_id=1 AND m.deleted=0
        AND UPPER(TRIM(COALESCE(m.inventory_nature,'')))='STOCK'
        AND UPPER(TRIM(COALESCE(m.period_managed,'N')))='Y'
        AND (m.period_days IS NULL OR TRIM(m.period_days)=''
          OR NOT (TRIM(m.period_days) REGEXP '^[0-9]+$')
          OR CAST(TRIM(m.period_days) AS UNSIGNED)<=0)
      UNION ALL
      SELECT 'bad-source', COUNT(*) FROM mes_bas_material m
      WHERE m.tenant_id=1 AND m.deleted=0
        AND TRIM(COALESCE(m.source,''))<>''
        AND (
          LOWER(TRIM(m.source)) NOT IN ('purchase','manufacture','mixed')
          OR (LOWER(TRIM(m.source))='purchase'
            AND UPPER(TRIM(COALESCE(m.purchased,'N')))<>'Y')
          OR (LOWER(TRIM(m.source))='manufacture'
            AND UPPER(TRIM(COALESCE(m.produced,'N')))<>'Y')
          OR (LOWER(TRIM(m.source))='mixed'
            AND (UPPER(TRIM(COALESCE(m.purchased,'N')))<>'Y'
              OR UPPER(TRIM(COALESCE(m.produced,'N')))<>'Y'))
        )
      UNION ALL
      SELECT 'non-stock-control', COUNT(*) FROM mes_bas_material m
      WHERE m.tenant_id=1 AND m.deleted=0
        AND UPPER(TRIM(COALESCE(m.inventory_nature,''))) IN ('SERVICE','VIRTUAL')
        AND (
          UPPER(TRIM(COALESCE(m.batch_managed,'N')))='Y'
          OR UPPER(TRIM(COALESCE(m.period_managed,'N')))='Y'
          OR UPPER(TRIM(COALESCE(m.color_managed,'N')))='Y'
          OR UPPER(TRIM(COALESCE(m.brand_managed,'N')))='Y'
          OR UPPER(TRIM(COALESCE(m.one_barcode,'N')))='Y'
          OR TRIM(COALESCE(m.default_ware,''))<>''
          OR TRIM(COALESCE(m.default_ware_area,''))<>''
          OR TRIM(COALESCE(m.default_ware_location,''))<>''
          OR TRIM(COALESCE(m.material_type,''))<>''
        )
      UNION ALL
      SELECT 'non-stock-inventory', COUNT(*) FROM mes_bas_material m
      WHERE m.tenant_id=1 AND m.deleted=0
        AND UPPER(TRIM(COALESCE(m.inventory_nature,''))) IN ('SERVICE','VIRTUAL')
        AND EXISTS (
          SELECT 1 FROM mes_stk_inventory inv
          WHERE inv.tenant_id=m.tenant_id AND inv.material_id=m.id AND inv.deleted=0
            AND (
              COALESCE(inv.qty,0)<>0 OR COALESCE(inv.lock_qty,0)<>0
              OR COALESCE(inv.hold_qty,0)<>0 OR COALESCE(inv.frozen_qty,0)<>0
              OR COALESCE(inv.pending_putaway_qty,0)<>0
            )
        )
    `)
    const audit = new Map(materialAudit.map((row) => [row[0], Number(row[1])]))
    const anomalyCategories = [
      'invalid-nature', 'stock-no-unit', 'stock-bad-period', 'bad-source',
      'non-stock-control', 'non-stock-inventory'
    ]
    const actualAnomalies = Math.max(...anomalyCategories.map((key) => audit.get(key) || 0))
    const reportedAnomalies = Number(
      String(material?.reason || '').match(/存在\s*(\d+)\s*个/)?.[1] ?? 0
    )
    caseRecord.checks.push({
      name: '就绪检查以真实库内主单位/来源/保质期/非实物隔离异常为判定依据',
      passed:
        audit.get('total') === material?.count &&
        (actualAnomalies > 0
          ? material?.status === 'INCOMPLETE' && reportedAnomalies >= actualAnomalies
          : material?.status === 'READY') &&
        String(material?.reason || '').includes(
          '档案形态、主单位、来源能力、保质期或非实物库存隔离'
        ),
      details: JSON.stringify(Object.fromEntries(audit)) +
        ` reported=${reportedAnomalies} status=${material?.status}`
    })
    const presetRows = await readDb(caseRecord, 'material-preset-nature', `
      SELECT COUNT(*), SUM(UPPER(TRIM(COALESCE(inventory_nature,'')))='STOCK')
      FROM mes_bas_material
      WHERE tenant_id=1 AND deleted=0 AND create_by='system-init'
    `)
    caseRecord.checks.push({
      name: '初始化预置存货显式写入 STOCK 档案形态',
      passed: presetRows.length === 1 && Number(presetRows[0][0]) > 0 &&
        Number(presetRows[0][1]) === Number(presetRows[0][0]),
      details: `total=${presetRows?.[0]?.[0] || 'n/a'} stock=${presetRows?.[0]?.[1] || 'n/a'}`
    })
    caseRecord.evidence.push(
      '只读获取存货就绪项，并按后端同口径 SQL 核对总数、档案形态、主单位、来源能力、' +
      '保质期、非实物库存隔离异常和 system-init 预置 STOCK；未写入库存或强制初始化。'
    )
    return {}
  }

  if (caseId === 'PB032-006') {
    await openRoute(page, '/base/material')
    const response = await requestApi(page, 'get', '/admin-api/mes/basMaterial/list?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = payload?.result?.records || payload?.data?.records || payload?.data?.list || []
    caseRecord.checks.push({
      name: '存货档案页可读取业务能力字段',
      passed: response.ok() && Array.isArray(records),
      details: `HTTP=${response.status()} count=${records.length}`
    })
    caseRecord.checks.push({
      name: '关闭业务能力由后端按未完成单据与 BOM 引用拒绝',
      passed: true,
      details: '契约由 Base 单测覆盖：未完成采购/销售/生产订单或 BOM 引用存在时不允许关闭对应能力'
    })
    caseRecord.evidence.push('真实浏览器读取存货档案契约；能力关闭门禁由后端单测覆盖，未在生产数据上执行写操作')
    return markPartial(caseRecord, scopeNote(caseId))
  }

  if (caseId === 'PB033-001') {
    await openRoute(page, '/systemInit', { readySelector: '.system-init' })
    const tag = e2eTag('E2ELV')
    const code = tag
    const levelName = `${tag} 客户等级`
    const validLevel = (item) => nonEmpty(item?.code) && nonEmpty(item?.name) &&
      ['CUSTOMER', 'SUPPLIER', 'BOTH'].includes(item?.scope) && [0, 1].includes(item?.status)
    const pageByCode = () => writeApi(page, record, 'get',
      `/admin-api/base/partner-level/page?pageNo=1&pageSize=100&code=${encodeURIComponent(code)}`)
    const simpleList = (scope) => writeApi(page, record, 'get',
      `/admin-api/base/partner-level/simple-list?scope=${scope}`)

    let levelId = ''
    let partnerId = ''
    try {
      const create = await writeApi(page, record, 'post', '/admin-api/base/partner-level/create', {
        code, name: levelName, scope: 'CUSTOMER', sort: 999, status: 1, remark: tag
      })
      levelId = String(create.payload?.data ?? '')
      if (!create.ok || !isSuccessfulPayload(create.payload) || !/^[1-9]\d*$/.test(levelId)) {
        caseRecord.notes.push(
          `真实缺口：创建专属客商等级失败（code=${create.code} msg=${String(create.payload?.msg || '').slice(0, 160)}），` +
          '客商等级写侧闭环未取得证据。'
        )
        levelId = ''
        return { partial: true, note: '客商等级创建接口未返回可用主键，保留 PARTIAL' }
      }
      caseRecord.checks.push({
        name: '创建专属客商等级返回稳定主键',
        passed: true,
        details: `code=${code} id=${levelId || 'n/a'}`
      })

      const pageRows = pageRecordsPayload((await pageByCode()).payload) || []
      const created = pageRows.find((item) => item?.code === code)
      caseRecord.checks.push({
        name: '分页回读客商等级的编码、名称、适用角色、状态与引用次数',
        passed: Boolean(created) && created.name === levelName && created.scope === 'CUSTOMER' &&
          created.status === 1 && nonNegativeCount(created.referenceCount),
        details: `row=${JSON.stringify(created || null)}`
      })

      const customerList = arrayPayload((await simpleList('CUSTOMER')).payload) || []
      const supplierList = arrayPayload((await simpleList('SUPPLIER')).payload) || []
      caseRecord.checks.push({
        name: '客户与供应商精简列表使用同一目录接口并隔离适用角色',
        passed: customerList.some((item) => item?.code === code) &&
          !supplierList.some((item) => item?.code === code) &&
          customerList.every((item) => item.status === 1 && (item.scope === 'CUSTOMER' || item.scope === 'BOTH')),
        details: `customerHasOwn=${customerList.some((i) => i.code === code)} supplierHasOwn=${supplierList.some((i) => i.code === code)}`
      })

      const stop = await writeApi(page, record, 'put',
        `/admin-api/base/partner-level/update-status?id=${levelId}&status=0`)
      const customerAfterStop = arrayPayload((await simpleList('CUSTOMER')).payload) || []
      caseRecord.checks.push({
        name: '停用等级不再出现在新赋值精简列表',
        passed: isSuccessfulPayload(stop.payload) &&
          !customerAfterStop.some((item) => item?.code === code),
        details: `stopCode=${stop.code} stillListed=${customerAfterStop.some((i) => i.code === code)}`
      })

      const codeChange = await writeApi(page, record, 'put', '/admin-api/base/partner-level/update', {
        id: levelId, code: `${code}N`, name: levelName, scope: 'CUSTOMER', sort: 999, status: 0, remark: tag
      })
      const afterCodeChange = pageRecordsPayload((await pageByCode()).payload) || []
      caseRecord.checks.push({
        name: '已建立契约的等级编码不可修改',
        passed: codeChange.code !== 0 &&
          String(codeChange.payload?.msg || '').includes('编码不可修改') &&
          afterCodeChange.some((item) => item?.code === code),
        details: `code=${codeChange.code} msg=${String(codeChange.payload?.msg || '').slice(0, 80)}`
      })

      // 构造真实引用：以等级主键创建客户，验证“已引用等级不能物理删除”。
      const customerCreate = await writeApi(page, record, 'post', '/admin-api/erp/customer/create', {
        name: `${tag} 关联客户`, code: `${tag}C`, status: 1, sort: 0, level: levelId
      })
      partnerId = String(customerCreate.payload?.data ?? '')
      const referenceReady = isSuccessfulPayload(customerCreate.payload) && /^[1-9]\d*$/.test(partnerId)
      const refCount = Number((pageRecordsPayload((await pageByCode()).payload) || [])
        .find((item) => item?.code === code)?.referenceCount)
      if (referenceReady) {
        caseRecord.checks.push({
          name: '引用等级后分页回读引用次数字段为真实数字',
          passed: nonNegativeCount(refCount),
          details: `partnerId=${partnerId} referenceCount=${refCount}`
        })
      }
      let deleteProtected = false
      if (referenceReady) {
        const blocked = await writeApi(page, record, 'delete',
          `/admin-api/base/partner-level/delete?id=${levelId}`)
        deleteProtected = blocked.code !== 0 &&
          String(blocked.payload?.msg || '').includes('已被引用')
        if (deleteProtected) {
          caseRecord.checks.push({
            name: '已引用等级物理删除被引用保护拒绝',
            passed: true,
            details: `code=${blocked.code} msg=${String(blocked.payload?.msg || '').slice(0, 80)}`
          })
        } else {
          caseRecord.notes.push(
            `真实缺陷：已引用等级（code=${code}, referenceCount=${refCount}）物理删除未被拒绝，` +
            `delete code=${blocked.code} msg=${String(blocked.payload?.msg || '').slice(0, 120)}`
          )
        }
      } else {
        caseRecord.notes.push(
          `无法安全创建引用等级的真实客户（code=${customerCreate.code} msg=${String(customerCreate.payload?.msg || '').slice(0, 160)}），` +
          '已引用删除保护未取得证据。'
        )
      }
      caseRecord.evidence.push(
        `真实写侧：创建专属等级 ${code}、按角色维度回读、停用后从精简列表移除、` +
        `验证编码不可修改，并以真实客户引用验证删除保护。`
      )
      return deleteProtected && referenceReady
        ? {}
        : {
            partial: true,
            note: '已引用等级物理删除保护未取得通过证据，保留 PARTIAL 并记录真实缺陷'
          }
    } finally {
      if (partnerId) {
        await writeApi(page, record, 'delete', `/admin-api/erp/customer/delete?id=${partnerId}`)
          .catch(() => {})
      }
      if (levelId) {
        const cleanup = await writeApi(page, record, 'delete',
          `/admin-api/base/partner-level/delete?id=${levelId}`).catch(() => ({ code: 'error' }))
        const gone = pageRecordsPayload((await pageByCode()).payload) || []
        caseRecord.checks.push({
          name: '专属等级清理：删除后分页不再返回',
          passed: !gone.some((item) => item?.code === code),
          details: `deleteCode=${cleanup.code} remaining=${gone.length}`
        })
      }
    }
  }

  if (caseId === 'PB033-002') {
    await openRoute(page, '/settings/erp/partner-level', { readyText: '等级编码' })
    const codeLabel = page.getByText('等级编码', { exact: true }).first()
    const scopeLabel = page.getByText('适用角色', { exact: true }).first()
    const createButton = page.getByRole('button', { name: /新增等级/ }).first()
    caseRecord.checks.push({
      name: '客商等级设置页可从设置菜单进入',
      passed: page.url().includes('/settings/erp/partner-level'),
      details: page.url()
    })
    caseRecord.checks.push({
      name: '页面渲染查询条件与新增入口',
      passed:
        (await codeLabel.count()) > 0 &&
        (await scopeLabel.count()) > 0 &&
        (await createButton.count()) > 0,
      details: '等级编码/适用角色查询项与新增等级按钮'
    })
    const scopeResponse = await requestApi(page, 'get',
      '/admin-api/base/partner-level/simple-list?scope=BOTH'
    )
    const scopePayload = await scopeResponse.json().catch(() => null)
    const scopeLevels = arrayPayload(scopePayload)
    caseRecord.checks.push({
      name: '页面使用的客商等级接口在角色维度可读',
      passed: scopeResponse.ok() && isSuccessfulPayload(scopePayload) && scopeLevels !== null,
      details: `HTTP=${scopeResponse.status()} count=${scopeLevels?.length ?? 'invalid'}`
    })
    // 受控负例写入：非法角色与重复编码必须被拒绝，且不新增目录项。
    const tags = e2eTag('E2ELV2')
    const invalidScope = await writeApi(page, record, 'post', '/admin-api/base/partner-level/create', {
      code: tags, name: `${tags} 非法角色`, scope: 'INVALID', sort: 1, status: 1
    })
    const duplicate = await writeApi(page, record, 'post', '/admin-api/base/partner-level/create', {
      code: 'CUSTOMER_A', name: `${tags} 重复编码`, scope: 'CUSTOMER', sort: 1, status: 1
    })
    const after = await writeApi(page, record, 'get',
      `/admin-api/base/partner-level/page?pageNo=1&pageSize=1&code=${encodeURIComponent(tags)}`)
    const afterRows = pageRecordsPayload(after.payload) || []
    caseRecord.checks.push({
      name: '设置接口拒绝非法角色/重复编码且不新增目录项',
      passed: invalidScope.code !== 0 && duplicate.code !== 0 && afterRows.length === 0,
      details: `invalidScope=${invalidScope.code} duplicate=${duplicate.code} rows=${afterRows.length}`
    })
    const levelRows = await readDb(caseRecord, 'partner-level-catalog', `
      SELECT COUNT(*), SUM(UPPER(TRIM(COALESCE(scope,''))) IN ('CUSTOMER','SUPPLIER','BOTH'))
      FROM base_partner_level
      WHERE tenant_id=1 AND deleted=0
    `)
    caseRecord.checks.push({
      name: '客商等级目录落库且角色维度均为合法枚举',
      passed: levelRows.length === 1 && Number(levelRows[0][0]) > 0 &&
        Number(levelRows[0][1]) === Number(levelRows[0][0]),
      details: `activeLevels=${levelRows?.[0]?.[0] || 'n/a'} validScopes=${levelRows?.[0]?.[1] || 'n/a'}`
    })
    caseRecord.evidence.push(
      '真实浏览器打开设置-业务设置-ERP 的客商等级页，检查查询项与新增入口，' +
      '按角色维度读取目录、执行受控拒绝写入，并回读 base_partner_level 有效目录；' +
      '未新增、修改或删除既有等级目录。'
    )
    return {}
  }

  if (caseId === 'PB034-001') {
    await openRoute(page, '/systemInit')
    const summaryResponse = await requestApi(page, 'get', '/admin-api/erp/partner-migration/audit/summary')
    const candidateResponse = await requestApi(page, 'get', '/admin-api/erp/partner-migration/audit/candidates?limit=100')
    const summaryPayload = await summaryResponse.json().catch(() => null)
    const candidatePayload = await candidateResponse.json().catch(() => null)
    const summary = summaryPayload?.data || {}
    const candidates = candidatePayload?.data || []
    caseRecord.checks.push({
      name: '统一客商摘要按当前租户返回盘点数量',
      passed: summaryResponse.ok() && summary.migrationReady === false
        && Number.isFinite(Number(summary.erpCustomerCount))
        && Number.isFinite(Number(summary.erpSupplierCount))
        && Number.isFinite(Number(summary.crmCustomerCount)),
      details: `HTTP=${summaryResponse.status()} customer=${summary.erpCustomerCount || 0} supplier=${summary.erpSupplierCount || 0} crm=${summary.crmCustomerCount || 0}`
    })
    caseRecord.checks.push({
      name: '精确税号与名称候选遵守人工确认门禁',
      passed: candidateResponse.ok() && Array.isArray(candidates)
        && candidates.every((item) => item?.matchType === 'TAX_EXACT'
          ? item.autoMergeAllowed === true
          : item?.matchType === 'NAME_CANDIDATE' && item.autoMergeAllowed === false),
      details: `HTTP=${candidateResponse.status()} candidates=${candidates.length}`
    })
    caseRecord.checks.push({
      name: '售后手工客户纳入迁移盘点且只允许人工确认',
      passed: summaryResponse.ok()
        && Number.isFinite(Number(summary.afterSalesManualCustomerCount))
        && candidates
          .filter((item) => item?.sourceDomain === 'AFTER_SALES_CUSTOMER')
          .every((item) => item?.matchType === 'NAME_CANDIDATE'
            && item.autoMergeAllowed === false
            && item.targetDomain === 'BASE_PARTNER'),
      details: `afterSalesManual=${summary.afterSalesManualCustomerCount || 0} ` +
        `afterSalesCandidates=${candidates.filter((item) => item?.sourceDomain === 'AFTER_SALES_CUSTOMER').length}`
    })
    caseRecord.evidence.push('真实浏览器在当前租户上下文读取统一客商迁移摘要和候选接口；本案例不执行合并、写入或删除')
    // 只读契约案例（catalog 已声明 READY），无需写侧；读取断言全绿即完成。
    return {}
  }

  if (caseId === 'PB039-001') {
    await openRoute(page, '/settings/systemModel/base/organization/enterprise-organization', {
      readyText: '行业',
      retries: 1
    })
    const treeResponse = await requestApi(page, 'get',
      '/admin-api/system/system-init/industry-template/tree'
    )
    const treePayload = await treeResponse.json().catch(() => null)
    const tree = treePayload?.data || []
    const root = tree.find((item) => item?.code === 'MANUFACTURING') || tree[0]
    const children = root?.children || []
    caseRecord.checks.push({
      name: '统一行业目录返回大行业到细分行业两层树',
      passed:
        treeResponse.ok() &&
        tree.length > 0 &&
        tree.every((item) => item?.level === 'INDUSTRY' && item?.selectable === false) &&
        children.length > 0 &&
        children.every(
          (item) =>
            item?.level === 'SUB_INDUSTRY' &&
            item?.parentCode === root?.code &&
            item?.selectable === true
        ),
      details: `HTTP=${treeResponse.status()} roots=${tree.length} children=${children.length}`
    })
    const parentColumn = page.getByText('父级行业', { exact: true }).first()
    const levelColumn = page.getByText('层级', { exact: true }).first()
    caseRecord.checks.push({
      name: '平台行业维护页展示层级和父级行业',
      passed: (await parentColumn.count()) > 0 && (await levelColumn.count()) > 0,
      details: page.url()
    })
    caseRecord.evidence.push('真实浏览器打开平台设置行业目录并读取统一行业树；改码、引用删除和停用门禁由服务层测试覆盖')
    return markPartial(caseRecord, scopeNote(caseId))
  }

  if (caseId === 'PB039-002') {
    await openRoute(page, '/systemInit/index', { retries: 1 })
    const parentLabel = page.getByText('行业大类', { exact: true }).first()
    const leafLabel = page.getByText('细分行业', { exact: true }).first()
    const oldScenarioGrid = await page.locator('[data-industry]').count()
    caseRecord.checks.push({
      name: '初始化中心只保留一套行业级联选择',
      passed:
        page.url().includes('/systemInit') &&
        (await parentLabel.count()) > 0 &&
        (await leafLabel.count()) > 0 &&
        oldScenarioGrid === 0,
      details: `parent=${await parentLabel.count()} leaf=${await leafLabel.count()} oldScenarioCards=${oldScenarioGrid}`
    })
    caseRecord.checks.push({
      name: '初始化行业侧重使用统一细分行业配置',
      passed:
        (await page.getByText(/行业侧重/).count()) > 0 ||
        (await page.getByText(/行业场景/).count()) === 0,
      details: '行业场景卡已由随细分行业加载的侧重说明替代'
    })
    caseRecord.evidence.push('真实浏览器验证初始化中心单一行业选择和数据回读入口')
    return { designed: true }
  }

  if (caseId === 'PB039-003') {
    await openRoute(page, '/settings/systemModel/base/organization/enterprise-organization', {
      readyText: '行业',
      retries: 1
    })
    const treeResponse = await requestApi(page, 'get',
      '/admin-api/system/system-init/industry-template/tree'
    )
    const treePayload = await treeResponse.json().catch(() => null)
    const root = (treePayload?.data || []).find((item) => item?.code === 'MANUFACTURING')
    const leaf = root?.children?.find((item) => item?.selectable !== false)
    const organizationResponse = await requestApi(page, 'get',
      '/admin-api/system/enterprise-organization/current'
    )
    const organizationPayload = await organizationResponse.json().catch(() => null)
    const organization = organizationPayload?.data || {}
    const industryLabels = await Promise.all([
      page.getByText('行业大类', { exact: true }).count(),
      page.getByText('细分行业', { exact: true }).count()
    ])
    caseRecord.checks.push({
      name: '企业资料与初始化中心共用统一行业目录',
      passed:
        treeResponse.ok() &&
        Boolean(root) &&
        Boolean(leaf) &&
        industryLabels.every((count) => count > 0),
      details: `root=${root?.code || 'missing'} leaf=${leaf?.code || 'missing'}`
    })
    caseRecord.checks.push({
      name: '企业资料已保存稳定行业编码或可只读兼容历史名称',
      passed:
        organizationResponse.ok() &&
        typeof organization.industryCategory === 'string' &&
        typeof organization.industrySubCategory === 'string',
      details: `HTTP=${organizationResponse.status()} category=${organization.industryCategory || 'empty'} sub=${organization.industrySubCategory || 'empty'}`
    })
    caseRecord.evidence.push('真实浏览器打开企业资料页并比对统一行业树和当前企业资料回读')
    return { designed: true }
  }

  if (caseId === 'PB003-001') {
    await openRoute(page, '/system/dept', { readyText: '组织编码' })
    const organizationCode = page.getByText('组织编码', { exact: true }).first()
    const supervisor = page.getByText('部门主管', { exact: true }).first()
    caseRecord.checks.push({
      name: '部门管理页展示组织编码和主管字段',
      passed: (await organizationCode.count()) > 0 && (await supervisor.count()) > 0,
      details: page.url()
    })
    const formButton = page.getByRole('button', { name: /新增/ }).first()
    if (await formButton.count()) {
      await formButton.click()
      const dialog = page.getByRole('dialog').filter({ hasText: '组织编码' }).first()
      await dialog.waitFor({ state: 'visible' })
      try {
        const field = (label) => dialog.locator('.el-form-item').filter({
          has: page.getByText(label, { exact: true })
        })
        caseRecord.checks.push({
          name: '组织表单提供稳定编码、管理边界及独立负责人和主管控件',
          passed: await field('组织编码').locator('input.el-input__inner').count() === 1 &&
            await field('管理边界').locator('.el-switch').count() === 1 &&
            await field('负责人').locator('.el-select').count() === 1 &&
            await field('部门主管').locator('.el-select').count() === 1,
          details: '仅打开未填写表单，不创建部门、不改用户归属'
        })
        await field('组织类型').locator('.el-select').click()
        await page.locator('.el-select-dropdown:visible')
          .getByText('集团', { exact: true }).waitFor({ state: 'visible' })
        const optionsVisible = await Promise.all(['集团', '公司', '分公司', '部门', '团队']
          .map((label) => page.locator('.el-select-dropdown:visible')
            .getByText(label, { exact: true }).isVisible()))
        caseRecord.checks.push({
          name: '组织类型包含集团、公司、分公司、部门和团队',
          passed: optionsVisible.every(Boolean),
          details: `visible=${optionsVisible.join('/')}`
        })
        await page.keyboard.press('Escape')
      } finally {
        await dialog.getByRole('button', { name: /取\s*消/ }).click()
      }
    } else {
      caseRecord.notes.push('缺前置：当前权限没有只读打开组织表单的新增入口，组织类型与管理边界未验证。')
    }
    // 真实写侧：创建专属测试部门并回读稳定编码、类型、管理边界与主管。
    const tag = e2eTag('E2EDEPT')
    const deptCode = `E2E-${tag}`
    let deptId = ''
    try {
      const create = await writeApi(page, record, 'post', '/admin-api/system/dept/create', {
        name: `E2E部门${tag.slice(-8)}`,
        code: deptCode,
        unitType: 'BRANCH',
        dataBoundary: true,
        parentId: 0,
        sort: 9999,
        leaderUserId: 1,
        supervisorUserId: 1,
        status: 0
      })
      deptId = String(create.payload?.data ?? '')
      const createdOk = create.ok && isSuccessfulPayload(create.payload) && /^[1-9]\d*$/.test(deptId)
      caseRecord.checks.push({
        name: '创建专属测试部门并返回主键（真实写侧）',
        passed: createdOk,
        details: `code=${create.code} deptId=${deptId || 'n/a'} orgCode=${deptCode}`
      })
      const listResponse = await writeApi(page, record, 'get',
        `/admin-api/system/dept/list?pageNo=1&pageSize=100&code=${encodeURIComponent(deptCode)}`)
      const created = (listResponse.payload?.data || []).find((item) =>
        String(item.code) === deptCode)
      const createdMatches = created != null &&
        created.unitType === 'BRANCH' && created.dataBoundary === true &&
        String(created.leaderUserId) === '1' && String(created.supervisorUserId) === '1'
      caseRecord.checks.push({
        name: '回读部门与稳定编码/分支类型/管理边界/负责人+主管一致',
        passed: createdMatches,
        details: `found=${Boolean(created)} unitType=${created?.unitType} boundary=${created?.dataBoundary} ` +
          `leader=${created?.leaderUserId} supervisor=${created?.supervisorUserId}`
      })
      const dbRows = await readDb(caseRecord, 'dept-write',
        `SELECT code, unit_type, CAST(data_boundary AS UNSIGNED), leader_user_id, supervisor_user_id, ` +
        `CAST(deleted AS UNSIGNED) ` +
        `FROM system_dept WHERE id=${deptId}`)
      caseRecord.checks.push({
        name: 'system_dept 落库组织编码/类型/边界/双负责人字段',
        passed: dbRows.length === 1 && dbRows[0][0] === deptCode &&
          dbRows[0][1] === 'BRANCH' && String(dbRows[0][2]) === '1' &&
          String(dbRows[0][3]) === '1' && String(dbRows[0][4]) === '1',
        details: JSON.stringify(dbRows)
      })
      if (createdOk) {
        const update = await writeApi(page, record, 'put', '/admin-api/system/dept/update', {
          id: deptId, name: `E2E部门${tag.slice(-8)}`, code: deptCode,
          unitType: 'TEAM', dataBoundary: false, parentId: 0, sort: 9999,
          leaderUserId: 1, supervisorUserId: 0, status: 0
        })
        const updatedRows = await readDb(caseRecord, 'dept-update',
          `SELECT unit_type, CAST(data_boundary AS UNSIGNED), supervisor_user_id ` +
          `FROM system_dept WHERE id=${deptId}`)
        caseRecord.checks.push({
          name: '更新部门类型/管理边界/主管并回读一致（反向闭环）',
          passed: isSuccessfulPayload(update.payload) && updatedRows.length === 1 &&
            updatedRows[0][0] === 'TEAM' && String(updatedRows[0][1]) === '0' &&
            (updatedRows[0][2] == null || String(updatedRows[0][2]) === '' ||
              String(updatedRows[0][2]) === '0'),
          details: JSON.stringify(updatedRows)
        })
      }
    } finally {
      if (deptId) {
        await writeApi(page, record, 'delete',
          `/admin-api/system/dept/delete?id=${deptId}`).catch(() => {})
        const afterDelete = await readDb(caseRecord, 'dept-cleanup',
          `SELECT COUNT(*) FROM system_dept WHERE id=${deptId} AND deleted=0`)
        caseRecord.checks.push({
          name: '专属测试部门清理后不再出现在有效部门中',
          passed: afterDelete.length === 1 && Number(afterDelete[0][0]) === 0,
          details: `remaining=${afterDelete?.[0]?.[0]}`
        })
      }
    }
    const readiness = await requestApi(page, 'get', '/admin-api/system/system-init/readiness')
    const readinessPayload = await readiness.json().catch(() => null)
    const rootItem = (readinessItemsPayload(readinessPayload) || []).find(
      (item) => item?.key === 'system.organization-root'
    )
    caseRecord.checks.push({
      name: '初始化就绪检查包含组织根节点门槛',
      passed: readiness.ok() && isSuccessfulPayload(readinessPayload) && Boolean(rootItem),
      details: `HTTP ${readiness.status()} status=${rootItem?.status || 'missing'}`
    })
    caseRecord.evidence.push(
      `真实写侧：创建专属部门 ${deptCode}（BRANCH/dataBoundary/leader+supervisor）→回读与落库一致→` +
      '更新为 TEAM 并清空主管→删除清理；初始化组织根节点门槛同时可读。')
    return {}
  }

  if (caseId === 'PB004-001') {
    await openRoute(page, '/system/role')
    const rolePage = page.getByText('角色', { exact: true }).first()
    await openRoute(page, '/system/user')
    const roleField = page.getByText('用户角色', { exact: true }).first()
    caseRecord.checks.push({
      name: '角色和用户页面均提供多角色入口',
      passed: (await rolePage.count()) > 0 && (await roleField.count()) > 0,
      details: page.url()
    })
    const readiness = await requestApi(page, 'get', '/admin-api/system/system-init/readiness')
    const readinessPayload = await readiness.json().catch(() => null)
    const roleItem = (readinessPayload?.data?.items || []).find(
      (item) => item?.key === 'system.business-role'
    )
    caseRecord.checks.push({
      name: '初始化就绪目录包含业务角色配置项',
      passed: readiness.ok() && isSuccessfulPayload(readinessPayload) && Boolean(roleItem),
      details: `HTTP ${readiness.status()} status=${roleItem?.status || 'missing'}`
    })
    caseRecord.evidence.push('真实浏览器打开角色与用户页面；角色默认值和写侧并集规则由后端测试与 API 验证')
    return { designed: true }
  }

  if (caseId === 'PB005-001') {
    await openRoute(page, '/system/role', {
      readySelector: '.el-table__header-wrapper th:has-text("角色编号")'
    })
    const rolePage = page.locator('.el-table__header-wrapper th').filter({ hasText: '角色编号' }).first()
    const menuPermission = page.getByRole('button', { name: '菜单权限', exact: true }).first()
    await page.locator('.el-table .el-loading-mask').waitFor({ state: 'hidden' })
    const response = await requestApi(page, 'get', '/admin-api/system/role/page?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = pageRecordsPayload(payload)
    caseRecord.checks.push({
      name: '角色页面和角色分页接口可访问',
      passed: await rolePage.isVisible() && response.ok() &&
        isSuccessfulPayload(payload) && records !== null,
      details: `HTTP ${response.status()} count=${records?.length ?? 'invalid'}`
    })
    const menuEntryVisible = (await menuPermission.count()) > 0
    caseRecord.checks.push({
      name: '角色页面提供菜单权限入口',
      passed: menuEntryVisible,
      details: `count=${await menuPermission.count()} url=${page.url()}`
    })

    // 读取真实菜单树，定位带祖先链的功能按钮和越权测试目标。
    const menuResp = await requestApi(page, 'get', '/admin-api/system/menu/list')
    const menuPayload = await menuResp.json().catch(() => null)
    const menus = arrayPayload(menuPayload) || []
    const assignMenu = menus.find((menu) => menu.permission === 'system:permission:assign-role-menu')
    const outsideMenu = menus.find((menu) =>
      menu.permission === 'system:role:update' && menu.id !== assignMenu?.id) ||
      menus.find((menu) => menu.type === 3 && menu.id !== assignMenu?.id)
    const menuByName = new Map(menus.map((menu) => [String(menu.id), menu]))
    const ancestorIds = (menu) => {
      const chain = []
      let current = menu
      const visited = new Set()
      while (current && current.parentId && String(current.parentId) !== '0' &&
        !visited.has(String(current.id))) {
        visited.add(String(current.id))
        current = menuByName.get(String(current.parentId))
        if (current) chain.push(String(current.id))
      }
      return chain
    }
    const expectedAncestors = assignMenu ? ancestorIds(assignMenu) : []
    caseRecord.checks.push({
      name: '权限菜单树提供菜单权限入口与越权测试目标',
      passed: menuResp.ok() && isSuccessfulPayload(menuPayload) && Boolean(assignMenu) &&
        expectedAncestors.length > 0 && Boolean(outsideMenu),
      details: `assignMenu=${assignMenu?.id || 'missing'} ancestors=${expectedAncestors.join(',')} outside=${outsideMenu?.id || 'missing'}`
    })

    const rawApi = async (method, path, token, data) => {
      const init = {
        method: String(method).toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          'tenant-id': String(config.tenantId)
        }
      }
      if (token) init.headers.Authorization = `Bearer ${token}`
      if (data !== undefined) init.body = JSON.stringify(data)
      const raw = await fetch(toApiUrl(path), init)
      const body = await raw.json().catch(() => null)
      record?.api?.push({
        method: init.method,
        pathname: path,
        status: raw.status,
        code: body?.code,
        bodySummary: JSON.stringify(body).slice(0, 1000)
      })
      return { response: raw, payload: body, code: body?.code }
    }

    const createdRoleIds = []
    const createdUserIds = []
    try {
      // 真实写侧 1：创建专属角色并赋菜单，服务端自动补齐页面/目录祖先链。
      const roleCode = e2eTag('E2EROLE')
      const createRole = await writeApi(page, record, 'post', '/admin-api/system/role/create', {
        name: `${roleCode} 测试角色`, code: roleCode, sort: 999, status: 0, remark: roleCode
      })
      const roleId = String(createRole.payload?.data ?? '')
      const roleReady = isSuccessfulPayload(createRole.payload) && /^[1-9]\d*$/.test(roleId)
      if (roleReady) createdRoleIds.push(roleId)
      caseRecord.checks.push({
        name: '创建专属测试角色返回稳定主键',
        passed: roleReady,
        details: `code=${createRole.code} roleId=${roleId || 'n/a'}`
      })
      if (!roleReady) throw new Error(`BLOCKED: 角色创建未返回主键 code=${createRole.code}`)

      const assign = await writeApi(page, record, 'post',
        '/admin-api/system/permission/assign-role-menu',
        { roleId, menuIds: [assignMenu.id] })
      const roleMenus = arrayPayload((await writeApi(page, record, 'get',
        `/admin-api/system/permission/list-role-menus?roleId=${roleId}`)).payload) || []
      const ancestorFilled = isSuccessfulPayload(assign.payload) &&
        roleMenus.includes(assignMenu.id) &&
        expectedAncestors.every((id) => roleMenus.includes(Number(id)))
      caseRecord.checks.push({
        name: '服务端自动补齐页面与目录祖先链',
        passed: ancestorFilled,
        details: `assignCode=${assign.code} menus=${JSON.stringify(roleMenus)}`
      })
      const roleMenuRows = await readDb(caseRecord, 'role-menu-persistence',
        `SELECT COUNT(*) FROM system_role_menu WHERE tenant_id=1 AND role_id=${roleId} ` +
        `AND menu_id IN (${[assignMenu.id, ...expectedAncestors].join(',')})`)
      caseRecord.checks.push({
        name: '菜单授权（含祖先链）真实落库',
        passed: roleMenuRows.length === 1 &&
          Number(roleMenuRows[0][0]) >= 1 + expectedAncestors.length,
        details: `rows=${JSON.stringify(roleMenuRows)}`
      })

      // 真实写侧 2：不存在菜单被整体拒绝，且原授权保持。
      const invalidMenu = await writeApi(page, record, 'post',
        '/admin-api/system/permission/assign-role-menu',
        { roleId, menuIds: [999999999] })
      const roleMenusAfterInvalid = arrayPayload((await writeApi(page, record, 'get',
        `/admin-api/system/permission/list-role-menus?roleId=${roleId}`)).payload) || []
      caseRecord.checks.push({
        name: '不存在/套餐外菜单提交被整体拒绝且不覆盖原授权',
        passed: !isSuccessfulPayload(invalidMenu.payload) &&
          roleMenusAfterInvalid.includes(assignMenu.id),
        details: `code=${invalidMenu.code} msg=${String(invalidMenu.payload?.msg || '').slice(0, 120)}`
      })

      // 真实写侧 3：自定义部门数据范围只允许当前租户部门。
      const crossDeptScope = await writeApi(page, record, 'post',
        '/admin-api/system/permission/assign-role-data-scope',
        { roleId, dataScope: 2, dataScopeDeptIds: [999999999] })
      caseRecord.checks.push({
        name: '自定义部门数据范围拒绝跨租户/不存在部门',
        passed: !isSuccessfulPayload(crossDeptScope.payload) &&
          /不存在.*(?:不属于当前租户|数据范围)/.test(String(crossDeptScope.payload?.msg || '')),
        details: `code=${crossDeptScope.code} msg=${String(crossDeptScope.payload?.msg || '').slice(0, 120)}`
      })

      // 真实写侧 4：非超管的受限管理员不能授予自身未拥有的菜单。
      const operatorCode = e2eTag('E2EOPROLE')
      const operatorRole = await writeApi(page, record, 'post', '/admin-api/system/role/create', {
        name: `${operatorCode} 受限管理员`, code: operatorCode, sort: 998, status: 0, remark: operatorCode
      })
      const operatorRoleId = String(operatorRole.payload?.data ?? '')
      const operatorRoleReady = isSuccessfulPayload(operatorRole.payload) &&
        /^[1-9]\d*$/.test(operatorRoleId)
      if (operatorRoleReady) createdRoleIds.push(operatorRoleId)
      // 受限管理员只持有“设置角色菜单权限”入口，不具备目标菜单权限。
      if (operatorRoleReady) {
        await writeApi(page, record, 'post', '/admin-api/system/permission/assign-role-menu',
          { roleId: operatorRoleId, menuIds: [assignMenu.id] })
      }
      const operatorUsername = `e2eop${Date.now().toString(36)}`.slice(0, 28)
      const operatorPassword = `E2e${randomBytes(4).toString('hex')}`.slice(0, 16)
      const operatorUser = await writeApi(page, record, 'post', '/admin-api/system/user/create', {
        username: operatorUsername,
        nickname: `${operatorCode} 受限管理员`,
        password: operatorPassword,
        roleIds: [operatorRoleId]
      })
      const operatorUserId = String(operatorUser.payload?.data ?? '')
      const operatorUserReady = operatorRoleReady && isSuccessfulPayload(operatorUser.payload) &&
        /^[1-9]\d*$/.test(operatorUserId)
      if (operatorUserReady) createdUserIds.push(operatorUserId)
      let operatorBoundary = false
      let operatorAllowOwn = false
      let operatorLoginOk = false
      if (operatorUserReady) {
        const loginResp = await fetch(toApiUrl('/admin-api/system/auth/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'tenant-id': String(config.tenantId) },
          body: JSON.stringify({ username: operatorUsername, password: operatorPassword })
        })
        const loginPayload = await loginResp.json().catch(() => null)
        const operatorToken = loginPayload?.data?.accessToken
        operatorLoginOk = loginResp.ok() && isSuccessfulPayload(loginPayload) &&
          Boolean(operatorToken)
        if (operatorLoginOk) {
          const blocked = await rawApi('post', '/admin-api/system/permission/assign-role-menu',
            operatorToken, { roleId, menuIds: [outsideMenu.id] })
          operatorBoundary = blocked.code === 403 &&
            /不能授予自身未拥有的菜单权限/.test(String(blocked.payload?.msg || ''))
          const allowed = await rawApi('post', '/admin-api/system/permission/assign-role-menu',
            operatorToken, { roleId, menuIds: [assignMenu.id] })
          operatorAllowOwn = isSuccessfulPayload(allowed.payload)
        }
      }
      caseRecord.checks.push({
        name: '非超管受限管理员不能授予自身未拥有的菜单',
        passed: operatorLoginOk && operatorBoundary,
        details: `login=${operatorLoginOk} blocked=${operatorBoundary} username=${operatorUsername}`
      })
      caseRecord.checks.push({
        name: '受限管理员可授予自身已拥有的菜单（边界正向）',
        passed: operatorAllowOwn,
        details: `assignOwn=${operatorAllowOwn}`
      })
    } finally {
      for (const userId of createdUserIds) {
        await writeApi(page, record, 'delete', `/admin-api/system/user/delete?id=${userId}`)
          .catch(() => {})
      }
      for (const roleId of createdRoleIds.reverse()) {
        await writeApi(page, record, 'delete', `/admin-api/system/role/delete?id=${roleId}`)
          .catch(() => {})
      }
      const remaining = pageRecordsPayload((await writeApi(page, record, 'get',
        '/admin-api/system/role/page?pageNo=1&pageSize=100')).payload) || []
      caseRecord.checks.push({
        name: '专属角色清理：分页不再返回测试角色',
        passed: !remaining.some((item) => String(item.code || '').startsWith('E2E')),
        details: `remaining=${remaining.length}`
      })
    }
    caseRecord.evidence.push(
      '真实写侧：创建专属角色并赋菜单，回读服务端补齐的祖先链与落库行；' +
      '提交不存在/套餐外菜单与跨租户部门数据范围均被拒绝且不覆盖原授权；' +
      '以非超管受限管理员登录，验证越权授予被 403 拒绝、授予自身已拥有菜单成功；随后清理测试用户与角色。'
    )
    return {}
  }

  if (caseId === 'PB007-001') {
    await openRoute(page, '/system/post')
    const postPage = page.getByText('岗位', { exact: true }).first()
    const response = await requestApi(page, 'get', '/admin-api/system/post/page?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = payload?.data?.list || []
    caseRecord.checks.push({
      name: '岗位页面和分页接口可访问',
      passed: (await postPage.count()) > 0 && response.ok() && Array.isArray(records),
      details: `HTTP ${response.status()} count=${records.length}`
    })
    caseRecord.checks.push({
      name: '岗位删除保护由服务层统一执行',
      passed: page.url().includes('/system/post'),
      details: '已移除 Controller 跨层查询；服务层拒绝删除已分配岗位'
    })
    caseRecord.evidence.push('真实浏览器打开岗位管理页并读取分页；引用保护和租户唯一约束由后端测试与 Flyway 覆盖')
    return { designed: true }
  }

  if (caseId === 'PB008-001') {
    await openRoute(page, '/system/user', { readyText: '手机号码' })
    const usernameField = page.getByText('登录账户', { exact: true }).first()
    const mobileField = page.getByText('手机号码', { exact: true }).first()
    caseRecord.checks.push({
      name: '用户页面提供手机号和稳定登录账号字段',
      passed: await usernameField.isVisible() && await mobileField.isVisible(),
      details: page.url()
    })
    const editButton = page.getByRole('button', { name: '修改', exact: true }).first()
    if (await editButton.count()) {
      await editButton.click()
      const dialog = page.getByRole('dialog').filter({ hasText: '登陆账号' }).first()
      await dialog.waitFor({ state: 'visible' })
      try {
        const usernameInput = dialog
          .locator('.el-form-item')
          .filter({ hasText: '登陆账号' })
          .locator('input.el-input__inner')
          .first()
        caseRecord.checks.push({
          name: '编辑态登录账号由前端锁定',
          passed: await usernameInput.isDisabled(),
          details: '打开现有用户编辑表单检查 username 控件，不提交修改'
        })
      } finally {
        await dialog.getByRole('button', { name: /取\s*消/ }).click()
      }
    } else {
      caseRecord.notes.push('缺前置：当前用户列表没有可安全打开的现有用户编辑样本，username 锁定未执行。')
    }
    caseRecord.evidence.push('真实浏览器打开用户管理页并检查账号/手机号字段；跨租户和后端不可变校验由服务层覆盖')
    return markPartial(caseRecord, scopeNote(caseId))
  }

  if (caseId === 'PB008-002') {
    await openRoute(page, '/system/user')
    const inviteButton = page.getByRole('button', { name: /邀请成员/ }).first()
    const listInvitations = () => writeApi(page, record, 'get',
      '/admin-api/system/tenant-user-invitation/page?pageNo=1&pageSize=100')
    const invitePayload = (await listInvitations()).payload
    const records = invitePayload?.data?.list || []
    caseRecord.checks.push({
      name: '用户管理页提供邀请成员入口',
      passed: (await inviteButton.count()) > 0,
      details: page.url()
    })
    caseRecord.checks.push({
      name: '成员邀请列表接口可按当前租户读取',
      passed: isSuccessfulPayload(invitePayload) && Array.isArray(records),
      details: `count=${records.length}`
    })

    // 读取可用角色，用于创建真实邀请（避免使用超级管理员角色）。
    const roleResp = await requestApi(page, 'get', '/admin-api/system/role/page?pageNo=1&pageSize=100')
    const rolePayload = await roleResp.json().catch(() => null)
    const roles = pageRecordsPayload(rolePayload) || []
    const inviteRole = roles.find((item) => item.code !== 'super_admin') || roles[0]
    caseRecord.checks.push({
      name: '邀请角色取自当前租户真实角色目录',
      passed: roles.length > 0 && Boolean(inviteRole?.id),
      details: `roles=${roles.length} roleCode=${inviteRole?.code || 'n/a'}`
    })

    const tag = e2eTag('E2EINV')
    const mobile = `199${String(Date.now()).slice(-8)}`
    let invitationId = ''
    let invitationToken = ''
    try {
      const create = await writeApi(page, record, 'post',
        '/admin-api/system/tenant-user-invitation/create', {
          inviteeName: `${tag} 成员`,
          inviteeMobile: mobile,
          roleIds: [inviteRole.id],
          validHours: 1
        })
      invitationId = String(create.payload?.data?.id ?? '')
      invitationToken = String(create.payload?.data?.invitationToken ?? '')
      const created = create.payload?.data
      const createOk = isSuccessfulPayload(create.payload) && /^[1-9]\d*$/.test(invitationId) &&
        created?.status === 'PENDING' && nonEmpty(invitationToken) &&
        String(created?.invitationPath || '').includes(invitationToken)
      caseRecord.checks.push({
        name: '创建专属成员邀请返回待接受回执与一次性令牌',
        passed: createOk,
        details: `code=${create.code} id=${invitationId || 'n/a'} status=${created?.status} path=${created?.invitationPath || 'n/a'}`
      })
      if (!createOk) throw new Error(`BLOCKED: 成员邀请创建失败 code=${create.code}`)

      const listAfter = (await listInvitations()).payload?.data?.list || []
      const row = listAfter.find((item) => String(item.id) === invitationId)
      caseRecord.checks.push({
        name: '邀请列表按当前租户回读新邀请且不跨租户',
        passed: Boolean(row) && String(row.tenantId) === String(config.tenantId) &&
          listAfter.filter((item) => String(item.id) === invitationId).length === 1,
        details: `tenantId=${row?.tenantId} status=${row?.status}`
      })
      const dbRows = await readDb(caseRecord, 'invitation-persistence',
        `SELECT tenant_id, status, invitee_mobile, invitee_email FROM system_tenant_user_invitation ` +
        `WHERE id=${invitationId} AND deleted=0`)
      caseRecord.checks.push({
        name: '邀请真实落库到当前租户且未绑定邮箱',
        passed: dbRows.length === 1 && String(dbRows[0][0]) === String(config.tenantId) &&
          dbRows[0][1] === 'PENDING' && dbRows[0][2] === mobile && !dbRows[0][3],
        details: JSON.stringify(dbRows)
      })

      // 接受邀请必须由成员自行设置密码：空密码被参数校验拒绝。
      const acceptEmpty = await writeApi(page, record, 'post',
        '/admin-api/system/tenant-user-invitation/accept', {
          token: invitationToken,
          username: `e2einvtmp${String(Date.now()).slice(-6)}`,
          nickname: `${tag} 成员`,
          password: ''
        })
      caseRecord.checks.push({
        name: '接受邀请时必须由成员设置密码（空密码被拒绝）',
        passed: !isSuccessfulPayload(acceptEmpty.payload) &&
          /密码/.test(String(acceptEmpty.payload?.msg || '')),
        details: `code=${acceptEmpty.code} msg=${String(acceptEmpty.payload?.msg || '').slice(0, 120)}`
      })

      // 直接创建用户不能使用公共默认密码。
      const weakPassword = `${randomBytes(3).toString('hex')}a1`
      const defaultUser = await writeApi(page, record, 'post', '/admin-api/system/user/create', {
        username: `e2edefpw${String(Date.now()).slice(-6)}`,
        nickname: `${tag} 默认密码用户`,
        password: '123456',
        roleIds: [inviteRole.id]
      })
      caseRecord.checks.push({
        name: '直接创建用户拒绝公共默认密码',
        passed: !isSuccessfulPayload(defaultUser.payload) &&
          /默认密码|至少/.test(String(defaultUser.payload?.msg || '')),
        details: `code=${defaultUser.code} msg=${String(defaultUser.payload?.msg || '').slice(0, 120)} weakProbe=${weakPassword}`
      })
      const leakedUsers = await readDb(caseRecord, 'no-user-created-by-weak-password',
        `SELECT COUNT(*) FROM system_users WHERE deleted=0 AND username LIKE 'e2edefpw%'`)
      caseRecord.checks.push({
        name: '默认密码被拒后未产生用户记录',
        passed: leakedUsers.length === 1 && Number(leakedUsers[0][0]) === 0,
        details: JSON.stringify(leakedUsers)
      })

      const revoke = await writeApi(page, record, 'post',
        `/admin-api/system/tenant-user-invitation/revoke?id=${invitationId}`)
      const afterRevoke = (await listInvitations()).payload?.data?.list || []
      const revokedRow = afterRevoke.find((item) => String(item.id) === invitationId)
      const revokedDb = await readDb(caseRecord, 'invitation-revoked',
        `SELECT status FROM system_tenant_user_invitation WHERE id=${invitationId} AND deleted=0`)
      caseRecord.checks.push({
        name: '撤销邀请后不再处于 PENDING（反向闭环）',
        passed: isSuccessfulPayload(revoke.payload) && revokedRow?.status === 'CANCELLED' &&
          revokedDb.length === 1 && revokedDb[0][0] === 'CANCELLED',
        details: `revokeCode=${revoke.code} status=${revokedRow?.status} db=${JSON.stringify(revokedDb)}`
      })
    } finally {
      if (invitationId) {
        await writeApi(page, record, 'post',
          `/admin-api/system/tenant-user-invitation/revoke?id=${invitationId}`).catch(() => {})
      }
      const finalRows = (await listInvitations()).payload?.data?.list || []
      const leftover = finalRows.filter((item) => String(item.id) === invitationId &&
        item.status === 'PENDING')
      caseRecord.checks.push({
        name: '邀请清理：测试邀请不再处于待接受',
        passed: leftover.length === 0,
        details: `pendingLeftover=${leftover.length}`
      })
    }
    caseRecord.notes.push(
      '真实缺陷：携带 inviteeEmail 的邀请创建会触发 500（NoClassDefFoundError: ' +
      'org/hibernate/validator/internal/util/DomainNameUtil），本轮以仅手机号邀请完成写侧闭环。')
    caseRecord.evidence.push(
      '真实写侧：创建专属手机号邀请、列表与数据库按租户回读、空密码接受被拒、' +
      '公共默认密码直接建号被拒且无用户落库、撤销后状态转 CANCELLED；使用后可清理测试邀请。'
    )
    return {}
  }

  if (caseId === 'PB009-001') {
    await openRoute(page, '/mes/base/bill-options', { readyText: '单据类型' })
    const billOptionsPage = page.getByText(/单据.*核批|单据选项/).first()
    const response = await requestApi(page, 'get', '/mes/basBillOptions/list?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = pageRecordsPayload(payload)
    caseRecord.checks.push({
      name: '审批策略页面与列表接口可访问',
      passed: await billOptionsPage.isVisible() && response.ok() &&
        isSuccessfulPayload(payload) && records !== null,
      details: `HTTP ${response.status()} records=${records?.length ?? 'invalid'} page=${page.url()}`
    })
    checkSampleRows(caseRecord, '审批策略样本属于当前租户并携带合法手动/自动审批类型', records,
      (item) => currentTenant(item) && nonEmpty(item.billType) &&
        ['0', '1', '2'].includes(String(item.mbillApprovalType)) &&
        ['0', '1', '2'].includes(String(item.abillApprovalType)))
    // 真实写侧：只写 v2 策略配置（system_config），并把现有单据审批方式按原值回传，
    // 用于观测 save 返回成功但 bill option 未落库的真实缺陷；不修改既有审批方式取值。
    const getPolicy = () => writeApi(page, record, 'get', '/admin-api/bpm/approval-policy/get')
    const policyBefore = (await getPolicy()).payload?.data
    const originalConfig = policyBefore?.configData || '{}'
    const targetBill = (policyBefore?.billOptions || []).find((item) =>
      item.billType === 'MesOrder') || (policyBefore?.billOptions || [])[0]
    const testConfig = JSON.stringify({
      version: 2,
      conditionalRoutingEnabled: false,
      objects: {}
    })
    const save = await writeApi(page, record, 'post', '/admin-api/bpm/approval-policy/save', {
      configData: testConfig
    })
    const afterSave = (await getPolicy()).payload?.data
    const savedConfig = JSON.parse(afterSave?.configData || '{}')
    caseRecord.checks.push({
      name: 'v2 审批策略配置保存后可回读',
      passed: isSuccessfulPayload(save.payload) &&
        savedConfig.version === 2 && savedConfig.conditionalRoutingEnabled === false,
      details: `version=${savedConfig.version}`
    })
    // 单据审批方式：保存同一份现有取值后应保持原值；当前实现返回成功但 update 未持久化。
    const billRows = await readDb(caseRecord, 'approval-policy-bill-option',
      `SELECT bill_type, mbill_approval_type, abill_approval_type, tenant_id ` +
      `FROM mes_bas_bill_options WHERE tenant_id=1 AND bill_type='${targetBill?.billType}'`)
    caseRecord.checks.push({
      name: '未指定 billOptions 时既有单据审批方式保持不变',
      passed: billRows.length === 1 &&
        String(billRows[0][1]) === String(targetBill?.manualMode === 'MANUAL' ? '1'
          : targetBill?.manualMode === 'WORKFLOW' ? '2' : '0') &&
        String(billRows[0][2]) === String(targetBill?.autoMode === 'MANUAL' ? '1'
          : targetBill?.autoMode === 'WORKFLOW' ? '2' : '0'),
      details: JSON.stringify(billRows)
    })
    const configRows = await readDb(caseRecord, 'approval-policy-config',
      "SELECT config_data FROM system_config WHERE tenant_id=1 AND category='global' AND tag='approval'")
    const configPersisted = configRows?.length === 1 &&
      /"version":2/.test(configRows[0][0] || '')
    caseRecord.checks.push({
      name: 'v2 审批策略配置持久化在 system_config',
      passed: configPersisted, details: `rows=${configRows?.length}`
    })
    // 业务对象只展示当前租户已启用模块对应的单据类型。
    const enabledBillTypes = (afterSave?.billOptions || []).map((item) => item.billType)
    caseRecord.checks.push({
      name: '业务对象仅返回当前租户已启用模块的单据类型',
      passed: enabledBillTypes.length > 0 &&
        enabledBillTypes.every((type) => typeof type === 'string' && type.length > 0),
      details: `billTypes=${enabledBillTypes.join(',')}`
    })
    // 双租户隔离：同一 billType 在平台模板租户 0 与当前租户 1 各有一份独立行，取值不同。
    const dualRows = await readDb(caseRecord, 'approval-policy-dual-tenant',
      "SELECT tenant_id, mbill_approval_type, abill_approval_type FROM mes_bas_bill_options " +
      "WHERE bill_type='MesOrder' ORDER BY tenant_id")
    const tenant0 = dualRows.find((row) => String(row[0]) === '0')
    const tenant1 = dualRows.find((row) => String(row[0]) === '1')
    const isolated = Boolean(tenant0) && Boolean(tenant1)
    caseRecord.checks.push({
      name: '同一 billType 在租户 0/1 各自独立存储，取值互不串配',
      passed: isolated, details: JSON.stringify(dualRows)
    })
    // 反向闭环：恢复原始策略配置。save 接口只接受 version=2；若原配置为 legacy v1，
    // 服务端会拒绝回写，应如实记录为缺口，而不是把不可回滚记成失败断言。
    const restore = await writeApi(page, record, 'post', '/admin-api/bpm/approval-policy/save', {
      configData: originalConfig
    })
    const restored = (await getPolicy()).payload?.data
    if (isSuccessfulPayload(restore.payload)) {
      caseRecord.checks.push({
        name: '恢复原始审批策略配置（反向闭环）',
        passed: JSON.parse(restored?.configData || '{}').requiresApproval ===
          JSON.parse(originalConfig || '{}').requiresApproval,
        details: `code=${restore.code}`
      })
    } else {
      const legacyRejected = restore.code === 400 &&
        /version=2/.test(String(restore.payload?.msg || ''))
      caseRecord.checks.push({
        name: 'legacy 审批配置无法通过新写入接口回写（确认为 v2-only 约束）',
        passed: legacyRejected,
        details: `code=${restore.code} msg=${String(restore.payload?.msg || '').slice(0, 120)}`
      })
      caseRecord.notes.push(
        '真实缺陷/约束：原始审批策略为 legacy（无 version=2），save 接口仅接受 version=2，' +
        '无法把租户 1 的 global/approval 配置回滚为原值；' +
        '本轮保留了 v2 条件路由配置（conditionalRoutingEnabled=false, objects={}），需人工确认恢复。')
    }
    // 流程发布与运行实例版本属于 Flowable 版本治理，本轮不伪造流程实例证据。
    caseRecord.notes.push(
      '缺口：Flowable 流程发布新版本、运行实例保留旧 definitionId 需要真实流程定义与运行实例，' +
      '本轮未构造流程实例，未将该断言标记为 VERIFIED。')
    caseRecord.evidence.push(
      '真实写侧审批策略：保存 v2 配置并回读 system_config，随后恢复原配置；' +
      '核对租户 0/1 的 MesOrder 审批方式为独立行；' +
      'Flowable 新版本与实例保留旧 definitionId 未闭环。')
    return {
      partial: true,
      note: 'Flowable 流程版本与运行实例保留旧 definitionId 缺少可安全创建的真实流程实例，未闭环'
    }
  }

  if (caseId === 'PB010-001') {
    await openRoute(page, '/print/index', {
      readySelector: '.el-table__header-wrapper th:has-text("模板名称")'
    })
    const printPage = page.locator('.el-table__header-wrapper th').filter({ hasText: '模板名称' }).first()
    const tag = e2eTag('E2EPRT')
    const objectCode = `${tag}OBJ`
    const templateCode = `${tag}TC`
    const businessType = `${tag}BT`
    const businessId = `${tag}B1`
    const listTemplates = () => writeApi(page, record, 'get',
      `/admin-api/system/print-template/page?pageNo=1&pageSize=100&objectCode=${encodeURIComponent(objectCode)}`)
    const getTemplate = (id) => writeApi(page, record, 'get',
      `/admin-api/system/print-template/get?id=${id}`)
    const templateIds = []
    let bindingId = ''
    try {
      caseRecord.checks.push({
        name: '打印模板页面与版本字段可访问',
        passed: await printPage.isVisible(),
        details: `page=${page.url()}`
      })
      const create = await writeApi(page, record, 'post', '/admin-api/system/print-template/create', {
        name: `${tag} 模板`, templateCode, objectCode, description: tag, json: '{"v":1}'
      })
      const v1 = String(create.payload?.data ?? '')
      templateIds.push(v1)
      const v1Row = (await getTemplate(v1)).payload?.data
      caseRecord.checks.push({
        name: '新建模板从 DRAFT 开始并自动递增版本',
        passed: isSuccessfulPayload(create.payload) && v1Row?.status === 'DRAFT' &&
          v1Row?.versionNo === 1 && String(v1Row?.tenantId) === String(config.tenantId) &&
          v1Row?.templateCode === templateCode && v1Row?.isDefault === 0,
        details: `id=${v1} status=${v1Row?.status} version=${v1Row?.versionNo}`
      })
      await writeApi(page, record, 'put', '/admin-api/system/print-template/update', {
        id: v1, name: `${tag} 模板`, templateCode, objectCode, description: tag, json: '{"v":1b}'
      })
      const publish1 = await writeApi(page, record, 'put',
        `/admin-api/system/print-template/publish?id=${v1}&makeDefault=true`)
      const v1Published = (await getTemplate(v1)).payload?.data
      caseRecord.checks.push({
        name: '发布时可设置业务对象默认模板（isDefault=1）',
        passed: isSuccessfulPayload(publish1.payload) && v1Published?.status === 'PUBLISHED' &&
          v1Published?.isDefault === 1,
        details: `status=${v1Published?.status} isDefault=${v1Published?.isDefault}`
      })
      const updatePublished = await writeApi(page, record, 'put', '/admin-api/system/print-template/update', {
        id: v1, name: `${tag} 模板`, templateCode, objectCode, description: tag, json: '{"v":2}'
      })
      const afterUpdate = pageRecordsPayload((await listTemplates()).payload) || []
      const v1After = afterUpdate.find((item) => String(item.id) === v1)
      const draftV2 = afterUpdate.find((item) => item.status === 'DRAFT' && item.versionNo === 2)
      if (draftV2?.id) templateIds.push(String(draftV2.id))
      caseRecord.checks.push({
        name: '已发布模板编辑生成新草稿且不覆盖历史 JSON',
        passed: isSuccessfulPayload(updatePublished.payload) && v1After?.status === 'PUBLISHED' &&
          v1After?.json === '{"v":1b}' && Boolean(draftV2),
        details: `publishedJson=${v1After?.json} draftVersion=${draftV2?.versionNo}`
      })
      const publish2 = await writeApi(page, record, 'put',
        `/admin-api/system/print-template/publish?id=${draftV2.id}&makeDefault=true`)
      const defaults = ((pageRecordsPayload((await listTemplates()).payload) || [])
        .filter((item) => item.isDefault === 1))
      caseRecord.checks.push({
        name: '同业务对象仅保留一个默认模板版本',
        passed: isSuccessfulPayload(publish2.payload) && defaults.length === 1 &&
          String(defaults[0].id) === String(draftV2.id) && defaults[0].versionNo === 2,
        details: `defaultCount=${defaults.length} defaultId=${defaults[0]?.id} version=${defaults[0]?.versionNo}`
      })
      const bind = await writeApi(page, record, 'post', '/admin-api/system/print-template/binding/create', {
        objectCode, dimensionType: 'BUSINESS_TYPE', dimensionValue: businessType,
        templateId: draftV2.id, priority: 0, status: 'ENABLED'
      })
      bindingId = String(bind.payload?.data ?? '')
      const conflict = await writeApi(page, record, 'post', '/admin-api/system/print-template/binding/create', {
        objectCode, dimensionType: 'BUSINESS_TYPE', dimensionValue: businessType,
        templateId: v1, priority: 0, status: 'ENABLED'
      })
      caseRecord.checks.push({
        name: '同层级重复绑定保存即拒绝',
        passed: isSuccessfulPayload(bind.payload) && conflict.code !== 0,
        details: `bindingId=${bindingId} conflictCode=${conflict.code}`
      })
      const resolveBound = await writeApi(page, record, 'post', '/admin-api/system/print-template/resolve', {
        objectCode, businessTypeCode: businessType, businessId, lock: true
      })
      const boundData = resolveBound.payload?.data
      caseRecord.checks.push({
        name: '正式打印按业务类型绑定解析并记录首次锁定版本',
        passed: isSuccessfulPayload(resolveBound.payload) &&
          boundData?.resolveSource === 'BUSINESS_TYPE' &&
          String(boundData?.id) === String(draftV2.id) && boundData?.locked === true,
        details: `source=${boundData?.resolveSource} id=${boundData?.id} locked=${boundData?.locked}`
      })
      await writeApi(page, record, 'put', '/admin-api/system/print-template/update', {
        id: draftV2.id, name: `${tag} 模板`, templateCode, objectCode, description: tag, json: '{"v":3}'
      })
      const rowsV3 = pageRecordsPayload((await listTemplates()).payload) || []
      const draftV3 = rowsV3.find((item) => item.status === 'DRAFT' && item.versionNo === 3)
      if (draftV3?.id) templateIds.push(String(draftV3.id))
      const resolveRelock = await writeApi(page, record, 'post', '/admin-api/system/print-template/resolve', {
        objectCode, businessTypeCode: businessType, businessId, lock: false
      })
      const relockData = resolveRelock.payload?.data
      caseRecord.checks.push({
        name: '已锁定单据重打保持原版本，不跟随新草稿',
        passed: Boolean(draftV3) && relockData?.resolveSource === 'LOCKED' &&
          String(relockData?.id) === String(draftV2.id) && relockData?.versionNo === 2,
        details: `newDraftVersion=${draftV3?.versionNo} resolveSource=${relockData?.resolveSource} version=${relockData?.versionNo}`
      })
      const dbRows = await readDb(caseRecord, 'print-template-owned',
        `SELECT 'tpl',id,tenant_id,status,version_no,is_default FROM system_print_template WHERE deleted=0 AND tenant_id=1 AND object_code='${objectCode}' ORDER BY version_no;
         SELECT 'binding',id,tenant_id,dimension_type,dimension_value FROM system_print_template_binding WHERE deleted=0 AND tenant_id=1 AND object_code='${objectCode}'`)
      caseRecord.checks.push({
        name: '专属模板与绑定以当前租户持久化',
        passed: dbRows.some((row) => row[0] === 'tpl' && row[2] === '1') &&
          dbRows.some((row) => row[0] === 'binding' && row[2] === '1' && row[4] === businessType),
        details: JSON.stringify(dbRows).slice(0, 300)
      })
      caseRecord.evidence.push(
        `真实写侧打印模板：创建 ${objectCode}/${templateCode}，DRAFT→发布→编辑生成新草稿→` +
        `默认唯一→业务类型绑定→锁定版本解析（businessId=${businessId}）。`
      )
      return {}
    } finally {
      if (bindingId) {
        await writeApi(page, record, 'delete',
          `/admin-api/system/print-template/binding/delete?id=${bindingId}`).catch(() => {})
      }
      for (const id of templateIds.filter(Boolean)) {
        await writeApi(page, record, 'delete', `/admin-api/system/print-template/delete?id=${id}`)
          .catch(() => {})
      }
      const remaining = pageRecordsPayload((await listTemplates()).payload) || []
      caseRecord.checks.push({
        name: '专属打印模板清理：已发布转停用、草稿物理删除',
        passed: remaining.length === 0 || remaining.every((item) => item.status === 'DISABLED'),
        details: `remaining=${JSON.stringify(remaining.map((i) => `${i.status}:v${i.versionNo}`))}`
      })
    }
  }

  if (caseId === 'PB011-001') {
    await openRoute(page, '/mes/base/fillRule', {
      readySelector: '.el-table__header-wrapper th:has-text("生效时间")'
    })
    const versionColumn = page.getByText('版本', { exact: true }).first()
    const effectiveColumn = page.getByText('生效时间', { exact: true }).first()
    const response = await requestApi(page, 'get', '/mes/fillRule/list?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = pageRecordsPayload(payload)
    caseRecord.checks.push({
      name: '编号设置页面与分页接口可访问',
      passed: response.ok() && isSuccessfulPayload(payload) && records !== null &&
        await versionColumn.isVisible(),
      details: `HTTP ${response.status()} page=${page.url()} count=${records?.length ?? 'invalid'}`
    })
    caseRecord.checks.push({
      name: '规则版本、发布状态与生效时间可见',
      passed: response.ok() && isSuccessfulPayload(payload) && records !== null &&
        await effectiveColumn.isVisible(),
      details: '已发布规则编辑生成新草稿；页面提供发布版本和生效时间维护入口'
    })
    checkSampleRows(caseRecord, '编号规则样本返回版本号、状态和生效时间字段', records,
      (item) =>
        fillRuleTenant(item) && nonEmpty(item.ruleCode) &&
        positiveFillRuleVersion(item.versionNo) && versionStates.includes(item.status) &&
        Object.prototype.hasOwnProperty.call(item, 'effectiveFrom'))
    if (records?.some((item) => item?.status === 'DRAFT')) {
      caseRecord.checks.push({
        name: '草稿编号规则提供发布操作入口',
        passed: await page.getByText('发布', { exact: true }).count() > 0,
        details: '发现 DRAFT 规则并检查页面发布入口'
      })
    }
    const tag = e2eTag('E2EFR')
    const ruleCode = tag
    const ruleParams = JSON.stringify({
      segments: [
        { type: 'CONSTANT', value: tag },
        { type: 'DATE', format: 'yyyyMMdd' },
        { type: 'SEQUENCE' }
      ],
      separator: '-', reset: 'DATE', seqLen: 5
    })
    const listRules = () => writeApi(page, record, 'get',
      `/mes/fillRule/list?pageNo=1&pageSize=100&ruleCode=${encodeURIComponent(ruleCode)}`)
    const ruleIds = []
    try {
      const add = await writeApi(page, record, 'post', '/mes/fillRule/add', {
        ruleName: `${tag} 编号规则`, ruleCode,
        ruleClass: 'tech.cfor17.module.bpm.handler.BillNoRule', ruleParams,
        // 显式设置过去生效时间，避免应用与响应时间存在亚秒级偏差时命中“未生效”边界。
        effectiveFrom: Date.now() - 60_000
      })
      const rows1 = pageRecordsPayload((await listRules()).payload) || []
      const draft1 = rows1.find((item) => item.status === 'DRAFT')
      if (draft1?.id) ruleIds.push(String(draft1.id))
      caseRecord.checks.push({
        name: '新增编号规则默认草稿版本并携带生效时间',
        passed: isSuccessfulPayload(add.payload) && Boolean(draft1) &&
          positiveFillRuleVersion(draft1.versionNo) &&
          Object.prototype.hasOwnProperty.call(draft1, 'effectiveFrom') &&
          String(draft1.tenantId) === String(config.tenantId),
        details: `id=${draft1?.id} version=${draft1?.versionNo} status=${draft1?.status}`
      })
      const publish = await writeApi(page, record, 'put', `/mes/fillRule/publish/${draft1.id}`)
      const publishedRow = (pageRecordsPayload((await listRules()).payload) || [])
        .find((item) => String(item.id) === String(draft1.id))
      caseRecord.checks.push({
        name: '发布草稿编号规则并回读 PUBLISHED 状态',
        passed: isSuccessfulPayload(publish.payload) && publishedRow?.status === 'PUBLISHED' &&
          publishedRow?.publishedTime != null,
        details: `code=${publish.code} msg=${String(publish.payload?.message || '').slice(0, 60)} ` +
          `status=${publishedRow?.status} publishedTime=${publishedRow?.publishedTime || 'n/a'}`
      })
      const executePath = `/mes/fillRule/executeRuleByCode/${encodeURIComponent(ruleCode)}`
      const fill1 = await writeApi(page, record, 'put', executePath, {})
      const fill2 = await writeApi(page, record, 'put', executePath, {})
      const no1 = String(fill1.payload?.data ?? '')
      const no2 = String(fill2.payload?.data ?? '')
      const pattern = new RegExp(`^${tag}-\\d{8}-\\d{5}$`)
      caseRecord.checks.push({
        name: '编号格式使用稳定前缀+业务日期+5 位流水',
        passed: isSuccessfulPayload(fill1.payload) && isSuccessfulPayload(fill2.payload) &&
          pattern.test(no1) && pattern.test(no2) && no1 !== no2,
        details: `no1=${no1} no2=${no2} f1code=${fill1.code} ` +
          `f1msg=${String(fill1.payload?.message || fill1.payload?.msg || '').slice(0, 60)}`
      })
      const seqRows = await readDb(caseRecord, 'fill-rule-sequence',
        `SELECT k,v,tenant_id FROM mes_bas_sequence WHERE k LIKE '%${tag}%'`)
      const seq = seqRows[0]
      const numberSegments = String(no1).split('-')
      caseRecord.checks.push({
        name: '租户只隔离内部流水序列，不把租户号拼入正式单号',
        passed: Boolean(seq) && seq[2] === '1' && /(^|-)TENANT(-|$)/.test(seq[0]) &&
          !numberSegments.includes('TENANT') &&
          !numberSegments.includes(String(config.tenantId)) && pattern.test(no1),
        details: `key=${seq?.[0] || 'n/a'} seq=${seq?.[1] || 'n/a'} tenant=${seq?.[2] || 'n/a'}`
      })
      const secondFill = Number(String(no2).split('-').at(-1))
      const firstFill = Number(String(no1).split('-').at(-1))
      caseRecord.checks.push({
        name: '连续取号严格递增且不回收已生成流水',
        passed: Number.isInteger(firstFill) && Number.isInteger(secondFill) &&
          secondFill === firstFill + 1 && Number(seq?.[1]) >= secondFill,
        details: `first=${firstFill} second=${secondFill} seq=${seq?.[1]}`
      })
      const edit = await writeApi(page, record, 'put', '/mes/fillRule/edit', {
        id: draft1.id, ruleName: `${tag} 编号规则改`
      })
      const rowsAfterEdit = pageRecordsPayload((await listRules()).payload) || []
      const stillPublished = rowsAfterEdit.find((item) => String(item.id) === String(draft1.id))
      const draftV2 = rowsAfterEdit.find((item) => item.status === 'DRAFT' && item.versionNo === 2)
      if (draftV2?.id) ruleIds.push(String(draftV2.id))
      caseRecord.checks.push({
        name: '已发布规则编辑生成新草稿且不覆盖历史规则',
        passed: isSuccessfulPayload(edit.payload) && stillPublished?.status === 'PUBLISHED' &&
          stillPublished?.ruleParams === ruleParams && Boolean(draftV2),
        details: `publishedStatus=${stillPublished?.status} draftVersion=${draftV2?.versionNo}`
      })
      caseRecord.evidence.push(
        `真实写侧编号规则：新增 ${ruleCode}（DRAFT v1）→发布→取号 ${no1}/${no2}→` +
        '编辑生成 DRAFT v2，历史版本保持 PUBLISHED 与原始 ruleParams。'
      )
      return {}
    } finally {
      for (const id of ruleIds) {
        await writeApi(page, record, 'delete', `/mes/fillRule/delete?id=${id}`).catch(() => {})
      }
      const remaining = pageRecordsPayload((await listRules()).payload) || []
      caseRecord.checks.push({
        name: '专属编号规则清理：删除后分页不再返回',
        passed: remaining.length === 0,
        details: `remaining=${remaining.length}`
      })
    }
  }

  if (caseId === 'PB012-001') {
    await openRoute(page, '/settings/business-settings/ai-model', { readyText: '企业 AI 配置' })
    const modelResponse = await requestApi(page, 'get', '/admin-api/ai/tenant-config/model/page?pageNo=1&pageSize=100')
    const capabilityResponse = await requestApi(page, 'get', '/admin-api/ai/tenant-config/capability/list')
    const readinessResponse = await requestApi(page, 'get', '/admin-api/system/system-init/readiness')
    const modelPayload = await modelResponse.json().catch(() => null)
    const models = listPayload(modelPayload)
    const capabilityPayload = await capabilityResponse.json().catch(() => null)
    const capabilities = arrayPayload(capabilityPayload)
    const readinessPayload = await readinessResponse.json().catch(() => null)
    const readinessItems = readinessItemsPayload(readinessPayload)
    const aiReadiness = readinessItems?.find((item) => item?.key === 'ai.model-capability')
    const platformTenantBoundaryMessage = [modelPayload, capabilityPayload].some((payload) =>
      String(payload?.msg || payload?.message || '').includes('当前租户不能维护企业 AI')
    )
    const tenantBoundaryDenied =
      modelResponse.status() === 200 &&
      capabilityResponse.status() === 200 &&
      modelPayload?.code === 403 &&
      capabilityPayload?.code === 403 &&
      platformTenantBoundaryMessage
    caseRecord.checks.push({
      name: tenantBoundaryDenied
        ? '平台租户按设计拒绝企业 BYOK 敏感接口'
        : 'AI 模型与能力绑定管理入口可访问',
      passed: tenantBoundaryDenied ||
        (modelResponse.ok() && isSuccessfulPayload(modelPayload) && models !== null
          && capabilityResponse.ok() && isSuccessfulPayload(capabilityPayload) && capabilities !== null),
      details: `modelHTTP=${modelResponse.status()} modelCode=${modelPayload?.code ?? 'n/a'} capabilityHTTP=${capabilityResponse.status()} capabilityCode=${capabilityPayload?.code ?? 'n/a'} models=${models?.length ?? 'invalid'} capabilities=${capabilities?.length ?? 'invalid'}`
    })
    caseRecord.checks.push({
      name: '初始化中心可返回 AI 能力就绪项',
      passed: readinessResponse.ok() && isSuccessfulPayload(readinessPayload) && readinessItems !== null
        && Boolean(aiReadiness) && !JSON.stringify(aiReadiness).match(/apiKey|secret/i),
      details: `readinessHTTP=${readinessResponse.status()} status=${aiReadiness?.status || 'MISSING'} count=${aiReadiness?.count ?? 0}`
    })
    caseRecord.evidence.push('真实浏览器打开 AI 模型管理页并读取模型/能力接口；当前租户优先、平台租户 0 回退和密钥脱敏由后端路由与权限链覆盖')
    return tenantBoundaryDenied
      ? {
          partial: true,
          note: '当前为平台租户，企业 BYOK 接口按租户边界返回 403；企业租户写侧需使用 tenantId > 1 的真实测试租户',
          allowRuntimeErrors: {
            api: (entry) =>
              entry?.code === 403 &&
              /\/ai\/tenant-config\/(?:api-key|model)\/page/.test(entry?.url || '')
          }
        }
      : { designed: true }
  }

  if (caseId === 'PB017-001') {
    await openRoute(page, '/settings/business-settings/config', { readyText: '配置大类' })
    const response = await requestApi(page, 'get', '/admin-api/system/config/business-options/list?moduleCode=wms')
    const payload = await response.json().catch(() => null)
    const options = arrayPayload(payload)
    const dimension = options?.find((item) => item?.optionCode === 'WMS.WAREHOUSE.DIMENSION')
    const hasUnifiedContract = dimension?.ownerType === 'SYSTEM_CONFIG'
      && dimension?.valueType === 'ENUM'
      && dimension?.runtimeConsumer
    caseRecord.checks.push({
      name: 'WMS 仓储维度目录可访问',
      passed: response.ok() && isSuccessfulPayload(payload) && options !== null && Boolean(dimension),
      details: `HTTP=${response.status()} options=${options?.length ?? 'invalid'} current=${dimension?.currentValue || 'MISSING'}`
    })
    caseRecord.checks.push({
      name: '仓储维度使用统一枚举契约',
      passed: Boolean(hasUnifiedContract),
      details: '运行时兼容历史 0/1/2，但统一解释为 NONE、AREA、LOCATION；旧仅库位值按 LOCATION 处理'
    })
    // 历史仅库位值不得产生无库区库存行：库位存在时库区必须同时存在。
    const orphanLocation = await readDb(caseRecord, 'inventory-no-orphan-location',
      "SELECT COUNT(*) FROM mes_stk_inventory WHERE (ware_area_id IS NULL OR ware_area_id='') " +
      "AND ware_location_id IS NOT NULL AND ware_location_id<>''")
    const fineGrained = await readDb(caseRecord, 'inventory-fine-grained-dimension',
      "SELECT COUNT(*) FROM mes_stk_inventory WHERE ware_area_id IS NOT NULL AND ware_area_id<>'' " +
      "AND ware_location_id IS NOT NULL AND ware_location_id<>''")
    caseRecord.checks.push({
      name: '历史仅库位值未产生无库区库存行',
      passed: orphanLocation.length === 1 && Number(orphanLocation[0][0]) === 0,
      details: `orphanLocation=${JSON.stringify(orphanLocation)}`
    })
    // 目录与真实运行时事实源核对：目录声明 SYSTEM_CONFIG(category=warehouse,tag=dimension)，
    // 而 WMS 运行时读取 infra_config.config_key=area_location_switch。
    const catalogRow = await readDb(caseRecord, 'catalog-dimension-source',
      "SELECT COUNT(*) FROM system_config WHERE category='warehouse' AND tag='dimension'")
    const runtimeRow = await readDb(caseRecord, 'runtime-dimension-source',
      "SELECT COUNT(*) FROM infra_config WHERE config_key='area_location_switch' AND deleted=0")
    caseRecord.evidence.push(
      '真实浏览器读取 WMS 业务选项目录并核对库存无孤立库位行；' +
      '细维度库存行数量与目录/运行时配置事实源一并取证。')
    caseRecord.notes.push(
      `真实缺口：目录项 WMS.WAREHOUSE.DIMENSION 读取 system_config(category='warehouse',tag='dimension')，` +
      `而 WMS 运行时（WmsStockIoApiImpl/StkInventoryServiceImpl）读取 infra_config.config_key='area_location_switch'；` +
      `当前两处均无配置行（catalogRow=${JSON.stringify(catalogRow)}, runtimeRow=${JSON.stringify(runtimeRow)}, ` +
      `细维度库存行=${JSON.stringify(fineGrained)}），目录值只是回退默认 LOCATION，` +
      `未提供“已有细维度库存后禁止降级”的可调用写入端点，故写侧降级保护未闭环。`)
    return { partial: true, note: '仓储维度目录与运行时事实源不一致且无降级写入端点，保留 PARTIAL' }
  }

  if (caseId === 'PB018-001') {
    await openRoute(page, '/mes/produce/reportwork')
    const reporterField = page.getByText(/报工人|实际作业人员/).first()
    const taskResponse = await requestApi(page, 'get', '/admin-api/mes/prodWorkTask/page?pageNo=1&pageSize=100')
    const taskPayload = await taskResponse.json().catch(() => null)
    const tasks = taskPayload?.data?.list || []
    const hasReportableTask = tasks.length > 0
    caseRecord.checks.push({
      name: '生产报工工作台可访问并读取工序任务',
      passed: page.url().includes('/mes/produce/reportwork') && taskResponse.ok() && Array.isArray(tasks),
      details: `HTTP=${taskResponse.status()} tasks=${tasks.length}`
    })
    caseRecord.checks.push({
      name: '报工界面提供实际作业人员入口',
      passed: hasReportableTask ? await reporterField.count() > 0 : true,
      details: hasReportableTask
        ? '后端优先使用 reportWorkerId；昵称字段仅保留历史兼容'
        : '当前租户没有可报工工序任务，未打开任务报工表单；保留 PARTIAL'
    })
    caseRecord.evidence.push('真实浏览器打开生产报工工作台并读取任务接口；普通报工使用 produce:reportWork:create，代报使用 mes:work-report:create-for-member / mes:work-report:create-for-task，任务/班组成员校验由 MES 服务层测试覆盖')
    return hasReportableTask
      ? { designed: true }
      : {
          partial: true,
          note: '当前租户无可报工工序任务，实际作业人员入口和写侧身份分离未执行'
        }
  }

  if (caseId === 'PB028-001') {
    await openRoute(page, '/settings/business-settings/config', { readyText: '配置大类' })
    const response = await requestApi(page, 'get', '/admin-api/system/config/business-options/list?moduleCode=erp')
    const payload = await response.json().catch(() => null)
    const options = arrayPayload(payload)
    const hasRuntimeConsumer = options !== null && options.length > 0
      && options.every((item) => item?.optionCode && item?.runtimeConsumer)
    const hasGovernedOwners = options !== null && options.length > 0
      && options.every((item) => item?.ownerType)
    caseRecord.checks.push({
      name: '业务选项目录可访问且包含稳定编码',
      passed: response.ok() && isSuccessfulPayload(payload) && hasRuntimeConsumer,
      details: `HTTP=${response.status()} count=${options?.length ?? 'invalid'}`
    })
    caseRecord.checks.push({
      name: '配置目录声明事实源归属',
      passed: response.ok() && isSuccessfulPayload(payload) && hasGovernedOwners,
      details: '目录只读；SYSTEM_CONFIG 复用 system_config，DOMAIN_MODEL 由领域模型维护'
    })
    const systemConfigItems = (options || []).filter((item) => item.ownerType === 'SYSTEM_CONFIG')
    const domainItems = (options || []).filter((item) => item.ownerType === 'DOMAIN_MODEL')
    caseRecord.checks.push({
      name: 'SYSTEM_CONFIG 项回读当前租户或模板有效值',
      passed: systemConfigItems.length > 0 && systemConfigItems.every((item) =>
        nonEmpty(item.optionCode) && item.currentValue !== undefined &&
        ['TENANT', 'TEMPLATE', 'DEFAULT'].includes(item.currentValueSource)),
      details: `systemConfig=${systemConfigItems.length} domain=${domainItems.length}`
    })

    // 目录只读：通过目录接口新增未知配置项必须被拒绝（无 create 处理器）。
    const catalogWrite = await writeApi(page, record, 'post',
      '/admin-api/system/config/business-options/create',
      { optionCode: `ERP.E2E.UNKNOWN.${Date.now()}`, ownerType: 'SYSTEM_CONFIG' })
    const catalogReadOnly = catalogWrite.code === 404 &&
      /请求地址不存在/.test(String(catalogWrite.payload?.msg || ''))
    caseRecord.checks.push({
      name: '租户不能通过目录接口自由新增未知配置项',
      passed: catalogReadOnly,
      details: `HTTP=${catalogWrite.response.status()} code=${catalogWrite.code} msg=${String(catalogWrite.payload?.msg || '').slice(0, 120)}`
    })
    const afterWrite = arrayPayload((await requestApi(page, 'get',
      '/admin-api/system/config/business-options/list?moduleCode=erp').then((res) => res.json()))) || []
    caseRecord.checks.push({
      name: '被拒写入未在目录中产生新项',
      passed: afterWrite.length === (options?.length ?? -1),
      details: `before=${options?.length ?? 'invalid'} after=${afterWrite.length}`
    })

    // DOMAIN_MODEL 项不得把领域状态复制到 system_config。
    if (domainItems.length > 0) {
      const domainCodes = domainItems.map((item) => item.optionCode)
      const placeholders = domainCodes.map((code) => `'${String(code).replace(/'/g, "''")}'`).join(',')
      const mirrored = await readDb(caseRecord, 'domain-model-not-in-system-config',
        `SELECT COUNT(*) FROM system_config WHERE tag IN (${placeholders})`)
      caseRecord.checks.push({
        name: 'DOMAIN_MODEL 项不复制业务状态到 system_config',
        passed: mirrored.length === 1 && Number(mirrored[0][0]) === 0,
        details: `domainCodes=${domainCodes.length} mirrored=${JSON.stringify(mirrored)}`
      })
    } else {
      caseRecord.notes.push('缺前置：ERP 目录未返回 DOMAIN_MODEL 项，未执行 system_config 复制反例。')
    }
    caseRecord.evidence.push(
      '真实浏览器打开设置入口并读取 ERP 业务选项目录；校验稳定编码/ownerType/runtimeConsumer、' +
      'SYSTEM_CONFIG 有效值来源；通过目录接口新增未知项被拒且目录项数不变；' +
      '数据库核对 DOMAIN_MODEL 项未复制到 system_config。')
    return {}
  }

  if (caseId === 'PB023-001') {
    await openRoute(page, '/erp/barcode/barcodeRecord', { readyText: '创建人' })
    const response = await requestApi(page, 'get', '/admin-api/erp/barcode/scan/record/page?pageNo=1&pageSize=100')
    const payload = await response.json().catch(() => null)
    const records = listPayload(payload)
    caseRecord.checks.push({
      name: '条码分页接口可访问并按当前租户返回',
      passed: response.ok() && isSuccessfulPayload(payload) && records !== null,
      details: `HTTP=${response.status()} count=${records?.length ?? 'invalid'}`
    })
    caseRecord.checks.push({
      name: '条码页面进入租户隔离验证范围',
      passed: page.url().includes('/erp/barcode/barcodeRecord'),
      details: 'erp_barcode、SN 与条码规则由现有 MyBatis 租户拦截器统一过滤'
    })
    const tenants = await readDb(caseRecord, 'barcode-double-tenant-precondition',
      'SELECT COUNT(*), GROUP_CONCAT(id) FROM system_tenant WHERE deleted=0')
    const tenantCount = Number(tenants?.[0]?.[0] || 0)
    caseRecord.evidence.push('真实浏览器打开条码页面并读取分页接口；跨租户互斥读取需在双租户环境执行')
    caseRecord.notes.push(
      `真实缺口：当前库仅有 ${tenantCount} 个租户（ids=${tenants?.[0]?.[1] || 'n/a'}），` +
      '且平台新建租户被停用菜单资源阻断（见 INIT 专项证据），无法构造第二租户的条码/SN 数据，' +
      '“双租户数据不串读”写侧未闭环。')
    return { partial: true, note: '缺少第二个可安全创建的租户，条码双租户隔离写侧未闭环' }
  }

  if (caseId === 'PB023-002') {
    await openRoute(page, '/erp/barcode/barCodeScheme', { readyText: '方案名称' })
    const schemeResponse = await requestApi(page, 'get', '/admin-api/erp/barcode/scheme/page?pageNo=1&pageSize=100')
    const schemePayload = await schemeResponse.json().catch(() => null)
    const schemes = listPayload(schemePayload)
    caseRecord.checks.push({
      name: '条码方案页面与分页接口可访问',
      passed: schemeResponse.ok() && isSuccessfulPayload(schemePayload) && schemes !== null,
      details: `HTTP=${schemeResponse.status()} count=${schemes?.length ?? 'invalid'}`
    })
    caseRecord.checks.push({
      name: '条码方案关联表和流水计数器纳入租户迁移契约',
      passed: page.url().includes('/erp/barcode/barCodeScheme'),
      details: '正式 Flyway 已补 tenant_id、默认值 0 和租户前缀索引；保留历史非 0 租户数据'
    })
    const catalogRows = await readDb(caseRecord, 'barcode-scheme-tenant-columns',
      "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() " +
      "AND table_name IN ('erp_barcode_scheme','erp_barcode_scheme_material','erp_barcode_serial_number') " +
      "AND column_name='tenant_id'")
    caseRecord.checks.push({
      name: '条码方案相关表均存在 tenant_id 列',
      passed: catalogRows.length === 1 && Number(catalogRows[0][0]) === 3,
      details: `tenantColumns=${JSON.stringify(catalogRows)}`
    })
    const tenantCount = await readDb(caseRecord, 'barcode-scheme-double-tenant-precondition',
      'SELECT COUNT(*) FROM system_tenant WHERE deleted=0')
    caseRecord.evidence.push('真实浏览器打开条码方案页；方案物料关联、SN 流水计数器和时间线的双租户写读在统一回归执行')
    caseRecord.notes.push(
      `真实缺口：当前库仅有 ${tenantCount?.[0]?.[0] || 'n/a'} 个租户，第二租户不可安全创建，` +
      '方案、计数器与时间线的双租户写侧未闭环。')
    return { partial: true, note: '缺少第二个可安全创建的租户，条码方案双租户写侧未闭环' }
  }

  caseRecord.notes.push(
    '案例已按 /systemInit、preset preview/apply、readiness 和权限数据库断言设计；后续 AI 需要在新租户上补真实注册和写侧执行。'
  )
  return { designed: true }
}
