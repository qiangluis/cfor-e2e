import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'
import { gotoSite, login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { runEnterpriseIsolationEvidence, buildEnterpriseIsolationPackage } from './enterprise-isolation.mjs'
import { assertSafeScope } from './init-gaps.mjs'

export const localInitCases = Object.freeze([
  'INIT-002', 'INIT-003', 'INIT-004', 'PB001-001', 'PB001-002'
])

export const localInitEvidence = Object.freeze({
  'PB001-001': {
    0: { checks: ['专属 tenant_admin 真实浏览器打开企业资料页'] },
    1: { checks: ['企业类型下拉包含生产贸易混合型并正式保存回读'] }
  },
  'PB001-002': {
    0: { checks: ['企业资料三种 Logo 上传控件可选'] },
    1: { checks: ['无 Logo 专属资料保存后服务端生成并按租户持久化'] },
    2: { checks: ['刷新后品牌 Logo 地址和实际图片均可回读'] }
  },
  'INIT-002': {
    0: { checks: ['专属初始化 preview 不改变预置事实和权限快照'] },
    1: { checks: ['初始化首轮确认弹窗真实出现且确认前未写入'] },
    2: { checks: ['页面确认后真实 tenant_admin 授权立即同步且在套餐内'] },
    3: { checks: ['页面确认后无需重新登录顶部业务域立即出现'] },
    4: { checks: ['初始化确认不改共享套餐及其他角色授权'] }
  },
  'INIT-003': {
    0: { checks: ['首轮回执显示新增已存在保留修改冲突统计和逐项明细'] },
    1: { checks: ['刷新后页面从 state 恢复同一首轮回执且落库一致'] },
    2: { checks: ['第二次指定预置零新增且业务事实完整快照不变'] },
    3: { checks: ['正式修改预置配置后再次 apply 保留原值和逐项 modified 证据'] }
  },
  'INIT-004': {
    0: { checks: ['初始化页面页签严格等于已选模块'] },
    1: { checks: ['WMS 与 FMS 期初各自跳过回读并恢复原集合'] },
    2: { checks: ['正式账套跳过精确业务拒绝且 state 原值不变'] },
    3: { checks: ['设置页面按模块拆分并与初始化逐项同源'] },
    4: { checks: ['企业配置在初始化与设置页面刷新回读一致'] }
  }
})

const requireFact = (value, message) => {
  if (!value) throw new Error(`初始化专属夹具: ${message}`)
}
const dataOf = (payload) => payload?.data
export const canonicalInitValue = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item)
const same = (left, right) => canonicalInitValue(left) === canonicalInitValue(right)
const flat = (rows) => (Array.isArray(rows) ? rows : []).flatMap((row) => [row, ...flat(row.children)])
const sortedIds = (values) => [...new Set(values.map(String))].sort()
const mark = (record, name, condition, details) => {
  const passed = condition === true
  record.checks.push({ name, passed, details: String(details || '') })
  requireFact(passed, name)
}

export function buildLocalInitPackage (input) {
  // Copy only enabled/assignable menu chains within the confirmed standard package.
  const base = buildEnterpriseIsolationPackage(input)
  const allowed = new Set(input.standardPackage.menuIds.map(String))
  const assignable = new Set(flat(input.assignableMenus).map((row) => String(row.id)))
  const rows = flat(input.menus)
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  const ids = new Set(base.menuIds)
  for (const target of rows) {
    const chain = []
    const visited = new Set()
    let row = target
    let complete = false
    while (row && !visited.has(String(row.id))) {
      visited.add(String(row.id))
      if (!allowed.has(String(row.id)) || !assignable.has(String(row.id)) ||
          Number(row.status) !== 0 || Number(row.deleted ?? 0) !== 0) break
      chain.push(String(row.id))
      if (String(row.parentId) === '0') { complete = true; break }
      row = byId.get(String(row.parentId))
    }
    if (complete) for (const value of chain) ids.add(value)
  }
  return { menuIds: [...ids] }
}

export function legalProfileFromDirectories ({ industries, areas, marker }) {
  const parent = (industries || []).find((row) =>
    row.level === 'INDUSTRY' && Number(row.status) === 0 &&
    industries.some((leaf) => leaf.parentCode === row.code && leaf.level === 'SUB_INDUSTRY' &&
      leaf.selectable === true && Number(leaf.status) === 0))
  const leaf = industries?.find((row) => row.parentCode === parent?.code &&
    row.level === 'SUB_INDUSTRY' && row.selectable === true && Number(row.status) === 0)
  const province = areas?.find((row) => row.children?.some((city) => city.children?.length))
  const city = province?.children?.find((row) => row.children?.length)
  const district = city?.children?.[0]
  requireFact(parent?.code && leaf?.code && province?.id && city?.id && district?.id,
    '正式行业目录或三级行政区划前置不完整')
  requireFact(/^[A-Za-z0-9]{1,16}$/.test(marker), '专属资料 marker 不合法')
  return {
    enterpriseFullName: `CFOR E2E ${marker}`,
    enterpriseShortName: `E2E${marker}`,
    enterpriseType: '生产贸易混合型',
    unifiedSocialCreditCode: `E2E${marker}`,
    industryCategory: parent.code,
    industrySubCategory: leaf.code,
    taxpayerQualification: '一般纳税人',
    provinceCode: Number(province.id), cityCode: Number(city.id), districtCode: Number(district.id),
    registeredAddress: `E2E fixture ${marker}`
  }
}

export function validateInitialEnterpriseShape (initial, rows, tenantId) {
  const expectedTenantId = String(tenantId)
  const organization = Array.isArray(rows)
    ? rows.find((row) => row?.[0] === 'organization')
    : null
  const tenantBrand = Array.isArray(rows)
    ? rows.find((row) => row?.[0] === 'tenant-brand')
    : null
  const templateBrand = Array.isArray(rows)
    ? rows.find((row) => row?.[0] === 'template-brand')
    : null
  requireFact(organization?.[1] === '0', '新租户企业资料主表必须为空')
  const tenantBrandCount = tenantBrand ? Number(tenantBrand[1]) : 0
  requireFact(Number.isInteger(tenantBrandCount) && tenantBrandCount >= 0 && tenantBrandCount <= 1,
    '新租户品牌配置行数证据缺失或不合法')
  requireFact(templateBrand?.[1] === '1', '平台模板品牌配置缺失')
  requireFact(tenantBrandCount === 0 || tenantBrand?.[2] === expectedTenantId,
    '新租户品牌配置不属于当前租户')

  const profileFields = [
    'enterpriseFullName', 'enterpriseShortName', 'enterpriseType',
    'unifiedSocialCreditCode', 'industryCategory', 'industrySubCategory',
    'taxpayerQualification', 'provinceCode', 'cityCode', 'districtCode',
    'registeredAddress', 'enterpriseLogoUrl'
  ]
  requireFact(profileFields.every((key) => initial?.[key] == null || initial[key] === ''),
    '本轮新租户企业资料主表并非空态')

  const brandFields = ['brandMarkUrl', 'brandLogoUrl', 'brandDarkLogoUrl']
  const apiBrand = brandFields.map((key) => String(initial?.[key] ?? ''))
  const tenantValues = tenantBrand?.slice(3, 6).map((value) => String(value ?? '')) || []
  const templateValues = templateBrand?.slice(2, 5).map((value) => String(value ?? '')) || []
  requireFact(templateValues.every(Boolean), '平台模板品牌字段不完整')
  if (tenantBrandCount === 1) {
    requireFact(tenantValues.every(Boolean), '当前租户品牌配置字段不完整')
    requireFact(apiBrand.every(Boolean) && JSON.stringify(apiBrand) === JSON.stringify(tenantValues),
      '企业资料接口品牌字段与当前租户配置不一致')
    requireFact(JSON.stringify(tenantValues) === JSON.stringify(templateValues),
      '新租户品牌配置不是平台模板正式预置值')
  } else {
    requireFact(apiBrand.every((value) => value === ''),
      '无当前租户品牌配置时企业资料接口不应返回品牌值')
  }
  return {
    organizationEmpty: true,
    tenantBrandOwned: tenantBrand?.[1] === '1',
    templateBrand: templateValues
  }
}

const INITIAL_SHAPE_TABLES = Object.freeze({
  organization: 'system_enterprise_organization',
  config: 'system_config'
})

export function buildInitialEnterpriseShapeSql ({ tenantId, organizationColumns, configColumns }) {
  const organization = new Set(organizationColumns || [])
  const config = new Set(configColumns || [])
  const requiredOrganization = [
    'tenant_id', 'enterprise_full_name', 'enterprise_short_name', 'enterprise_type',
    'unified_social_credit_code', 'industry_category', 'industry_sub_category',
    'taxpayer_qualification', 'province_code', 'city_code', 'district_code',
    'registered_address', 'enterprise_logo_url'
  ]
  const requiredConfig = ['tenant_id', 'category', 'tag', 'config_data']
  requireFact(requiredOrganization.every((column) => organization.has(column)),
    '企业资料表缺少初始形状所需正式字段')
  requireFact(requiredConfig.every((column) => config.has(column)),
    '系统配置表缺少品牌快照所需正式字段')

  const organizationDeleted = deletedPredicate(organization)
  const configDeleted = deletedPredicate(config)
  return `
    SELECT 'organization', COUNT(*), '', '', '', '', '', ''
    FROM ${INITIAL_SHAPE_TABLES.organization}
    WHERE tenant_id=${tenantId}${organizationDeleted} AND (
      NULLIF(TRIM(enterprise_full_name), '') IS NOT NULL OR
      NULLIF(TRIM(enterprise_short_name), '') IS NOT NULL OR
      NULLIF(TRIM(enterprise_type), '') IS NOT NULL OR
      NULLIF(TRIM(unified_social_credit_code), '') IS NOT NULL OR
      NULLIF(TRIM(industry_category), '') IS NOT NULL OR
      NULLIF(TRIM(industry_sub_category), '') IS NOT NULL OR
      taxpayer_qualification IS NOT NULL OR province_code IS NOT NULL OR city_code IS NOT NULL OR
      district_code IS NOT NULL OR NULLIF(TRIM(registered_address), '') IS NOT NULL OR
      NULLIF(TRIM(enterprise_logo_url), '') IS NOT NULL
    );
    SELECT 'tenant-brand', COUNT(*), CAST(tenant_id AS CHAR),
      JSON_UNQUOTE(JSON_EXTRACT(config_data, '$.brandMarkUrl')),
      JSON_UNQUOTE(JSON_EXTRACT(config_data, '$.brandLogoUrl')),
      JSON_UNQUOTE(JSON_EXTRACT(config_data, '$.brandDarkLogoUrl')),
      '', ''
    FROM ${INITIAL_SHAPE_TABLES.config}
    WHERE tenant_id=${tenantId} AND category='global' AND tag='common'${configDeleted}
    GROUP BY tenant_id;
    SELECT 'template-brand', COUNT(*),
      JSON_UNQUOTE(JSON_EXTRACT(config_data, '$.brandMarkUrl')),
      JSON_UNQUOTE(JSON_EXTRACT(config_data, '$.brandLogoUrl')),
      JSON_UNQUOTE(JSON_EXTRACT(config_data, '$.brandDarkLogoUrl')),
      '', '', ''
    FROM ${INITIAL_SHAPE_TABLES.config}
    WHERE tenant_id=0 AND category='global' AND tag='common'${configDeleted};`
}

const deletedPredicate = (columns, qualifier = '') =>
  columns.has('deleted') ? ` AND ${qualifier}deleted=0` : ''

export function buildConfigSnapshotSql ({ tenantId, configColumns }) {
  const config = new Set(configColumns || [])
  requireFact(config.has('tenant_id') && config.has('category') &&
    config.has('tag') && config.has('config_data'),
  '系统配置表缺少只读快照所需正式字段')
  return `
  SELECT CAST(id AS CHAR),category,tag,SHA2(config_data,256) FROM system_config
  WHERE tenant_id=${tenantId} AND category IS NOT NULL AND tag IS NOT NULL${deletedPredicate(config)}
  ORDER BY id`
}

export function buildDedicatedLogoPersistenceSql ({ tenantId, organizationColumns, configColumns }) {
  const organization = new Set(organizationColumns || [])
  const config = new Set(configColumns || [])
  requireFact(organization.has('tenant_id') && organization.has('enterprise_logo_url'),
    '企业资料表缺少 Logo 只读快照所需正式字段')
  requireFact(config.has('tenant_id') && config.has('category') &&
    config.has('tag') && config.has('config_data'),
  '系统配置表缺少 Logo 只读快照所需正式字段')
  return `
      SELECT enterprise_logo_url FROM system_enterprise_organization
      WHERE tenant_id=${tenantId}${deletedPredicate(organization)};
      SELECT config_data FROM system_config WHERE tenant_id=${tenantId}
      AND category='global' AND tag='common'${deletedPredicate(config)}`
}

export function localPresetComplete (result, applied = true) {
  return result?.applied === applied && Array.isArray(result.contributions) &&
    result.contributions.length > 0 &&
    ['added', 'skipped', 'modified', 'conflicts'].every((key) =>
      Number.isInteger(result[key]) && result[key] >= 0) &&
    result.contributions.every((row) => row.key && row.module && row.title &&
      Array.isArray(row.messages) &&
      ['added', 'skipped', 'modified', 'conflicts'].every((key) =>
        Number.isInteger(row[key]) && row[key] >= 0))
}

export function sameInitPresetReceipt (left, right) {
  if (!localPresetComplete(left) || !localPresetComplete(right)) return false
  // Fastjson omits nullable action links in the stored JSON; Jackson restores
  // them in the typed response. Keep all business fields strictly comparable.
  const normalize = (receipt) => ({
    ...receipt,
    contributions: receipt.contributions.map((row) => ({
      ...row, actionPath: row.actionPath ?? null, actionLabel: row.actionLabel ?? null
    }))
  })
  return same(normalize(left), normalize(right))
}

export const routeByComponent = (rows, component, parent = '') => {
  for (const row of Array.isArray(rows) ? rows : []) {
    const route = String(row.path || '').startsWith('/') ? row.path
      : `/${[parent.replace(/^\/|\/$/g, ''), row.path].filter(Boolean).join('/')}`
    if (row.component === component) return route
    const child = routeByComponent(row.children, component, route)
    if (child) return child
  }
  return null
}

export const hasInitSettingsOverview = (rows, settingsPath, parent = '') => {
  for (const row of Array.isArray(rows) ? rows : []) {
    const route = String(row.path || '').startsWith('/') ? row.path
      : `/${[parent.replace(/^\/|\/$/g, ''), row.path].filter(Boolean).join('/')}`
    if (route === `/settings/${settingsPath}` &&
        row.component === 'system/systemSettings/index') return true
    if (hasInitSettingsOverview(row.children, settingsPath, route)) return true
  }
  return false
}

const formField = (page, label) => page.locator('.el-form-item')
  .filter({ has: page.locator('.el-form-item__label').filter({ hasText: new RegExp(`^${label}$`) }) })
  .first()

export async function runLocalInitClosure ({
  caseId, caseRecord, page, api, tenantId, userId, spec, readDb,
  outputDir, record, navigate = openRoute
}) {
  requireFact(localInitCases.includes(caseId), `不支持 ${caseId}`)
  requireFact(/^[1-9]\d*$/.test(String(tenantId)) && String(tenantId) !== '1',
    '只允许本轮专属非共享租户')
  const read = async (path) => dataOf(await api.getBusiness(path))
  const info = await read('/system/auth/get-permission-info')
  requireFact(String(info?.user?.id) === String(userId) && info.roles?.includes('tenant_admin'),
    '真实 tenant_admin 身份不一致')
  const navigateComponent = async (component, readySelector) => {
    const permission = await read('/system/auth/get-permission-info')
    const route = routeByComponent(permission?.menus, component)
    requireFact(route, `缺少正式页面入口 ${component}`)
    caseRecord.evidence = [...(caseRecord.evidence || []),
      `专属租户菜单 component=${component}; route=${route}; tenantId=${tenantId}`]
    try {
      await navigate(page, route, { readySelector })
    } catch (error) {
      // openRoute may warm /index after a dynamic-route failure. Capture the
      // tenant page immediately after a direct retry so the evidence is not
      // mistaken for a successful main-admin page.
      const targetUrl = `${config.webBase}${route}`
      await gotoSite(page, targetUrl, {
        goto: { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }
      }).catch(() => {})
      const actualUrl = page.url()
      const body = await page.locator('body').innerText().catch(() => '')
      const screenshot = outputDir
        ? await saveScreenshot(page, outputDir,
          `${caseId}-enterprise-page-navigation-FAIL`, record).catch(() => '')
        : ''
      caseRecord.notes.push(
        `专属企业页导航失败：component=${component}; route=${route}; ` +
        `target=${targetUrl}; actual=${actualUrl}; ` +
        `enterpriseForm=${await page.locator('.enterprise-form').count().catch(() => -1)}; ` +
        `body=${body.replace(/\s+/g, ' ').slice(0, 240)}; screenshot=${screenshot || 'none'}`)
      throw new Error(`${error.message}; 专属页 route=${route}; actual=${actualUrl}`)
    }
    requireFact(new URL(page.url()).pathname === route,
      `专属企业资料页导航被重定向：expected=${route}; actual=${page.url()}`)
    return route
  }
  const profile = legalProfileFromDirectories({
    industries: await read('/system/system-init/industry-template/options'),
    areas: await read('/system/area/tree'), marker: spec.marker
  })
  const logoFields = ['enterpriseLogoUrl', 'brandMarkUrl', 'brandLogoUrl', 'brandDarkLogoUrl']
  const initial = await read('/system/enterprise-organization/current')
  const organizationSchema = await readDb('enterprise-initial-schema-organization', `
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${INITIAL_SHAPE_TABLES.organization}'
    ORDER BY ORDINAL_POSITION`)
  const configSchema = await readDb('enterprise-initial-schema-config', `
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${INITIAL_SHAPE_TABLES.config}'
    ORDER BY ORDINAL_POSITION`)
  const initialShape = await readDb('enterprise-initial-shape', buildInitialEnterpriseShapeSql({
    tenantId,
    organizationColumns: organizationSchema.map((row) => row[0]),
    configColumns: configSchema.map((row) => row[0])
  }))
  validateInitialEnterpriseShape(initial, initialShape, tenantId)
  await navigateComponent('system/enterprise-organization/index', '.enterprise-form')
  if (caseId === 'PB001-001') {
    mark(caseRecord, '专属 tenant_admin 真实浏览器打开企业资料页',
      await formField(page, '企业类型').isVisible() &&
      new URL(page.url()).pathname.includes('enterprise-organization'),
      `tenant=${tenantId}; user=${userId}; url=${page.url()}`)
    await formField(page, '企业类型').locator('.el-select').click()
    const mixed = page.locator('.el-select-dropdown:visible')
      .getByText('生产贸易混合型', { exact: true })
    await mixed.waitFor({ state: 'visible' })
    await mixed.click()
    await api.putBusiness('/system/enterprise-organization/current', profile)
    const saved = await read('/system/enterprise-organization/current')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await formField(page, '企业类型').getByText('生产贸易混合型', { exact: true })
      .waitFor({ state: 'visible' })
    mark(caseRecord, '企业类型下拉包含生产贸易混合型并正式保存回读',
      saved?.enterpriseType === profile.enterpriseType &&
      await formField(page, '企业类型').getByText('生产贸易混合型', { exact: true }).isVisible(),
      `tenant=${tenantId}; type=${saved?.enterpriseType}`)
    return
  }
  if (caseId === 'PB001-002') {
    const optional = await page.locator('.enterprise-form .el-form-item').evaluateAll((rows) => {
      const labels = ['图形标识', '黑字完整 Logo', '白字完整 Logo']
      return labels.every((label) => {
        const row = rows.find((item) => item.querySelector('.el-form-item__label')
          ?.textContent?.trim() === label)
        return row && !row.classList.contains('is-required') &&
          Boolean(row.querySelector('.el-upload')) &&
          !row.querySelector('.el-form-item__asterisk')
      })
    })
    mark(caseRecord, '企业资料三种 Logo 上传控件可选', optional, `tenant=${tenantId}`)
  }
  await api.putBusiness('/system/enterprise-organization/current', profile)
  const saved = await read('/system/enterprise-organization/current')
  requireFact(saved?.enterpriseFullName === profile.enterpriseFullName &&
    saved?.enterpriseType === profile.enterpriseType, '合法专属企业资料保存未回读')
  if (caseId === 'PB001-002') {
    const rows = await readDb('dedicated-logo-persistence', buildDedicatedLogoPersistenceSql({
      tenantId,
      organizationColumns: organizationSchema.map((row) => row[0]),
      configColumns: configSchema.map((row) => row[0])
    }))
    const brand = rows.length === 2 ? JSON.parse(rows[1][0]) : null
    mark(caseRecord, '无 Logo 专属资料保存后服务端生成并按租户持久化',
      logoFields.every((key) => typeof saved?.[key] === 'string' && saved[key].length > 0) &&
      rows.length === 2 && rows[0][0] === saved.enterpriseLogoUrl &&
      logoFields.slice(1).every((key) => brand?.[key] === saved[key]), `tenant=${tenantId}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.enterprise-form img').first().waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.enterprise-form img')]
      return images.length >= 3 && images.every((image) => image.complete && image.naturalWidth > 0)
    })
    const images = await page.locator('.enterprise-form img').evaluateAll((rows) =>
      rows.map((image) => ({ src: image.src, complete: image.complete, width: image.naturalWidth })))
    const again = await read('/system/enterprise-organization/current')
    mark(caseRecord, '刷新后品牌 Logo 地址和实际图片均可回读',
      logoFields.every((key) => again?.[key] === saved[key]) &&
      logoFields.slice(1).every((key) => images.some((image) => image.complete &&
        image.width > 0 && image.src === new URL(saved[key], page.url()).href)), `tenant=${tenantId}`)
    return
  }

  const modules = caseId === 'INIT-004' ? ['system', 'bpm', 'erp', 'wms', 'fms'] : ['system', 'bpm', 'erp']
  await api.putBusiness('/system/system-init/state', {
    industryTemplate: profile.industrySubCategory, selectedModules: modules,
    currentStep: caseId === 'INIT-002' ? 1 : 2
  })
  if (caseId === 'INIT-002') {
    const sentinelId = String(dataOf(await api.postBusiness('/system/role/create', {
      name: `E2E${spec.marker}`, code: `e2e${spec.marker}`, sort: 9998, status: 0, remark: spec.marker
    })))
    requireFact(/^[1-9]\d*$/.test(sentinelId), '专属对照角色未返回合法 ID')
    const beforeBoundary = await readDb('init-boundary-before', boundarySnapshotSql(tenantId))
    await navigateComponent('system/systemInit/index', '.init-wizard--first')
    const previewBefore = await readDb('preview-before', presetSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    const preview = await readPreview(api, modules)
    const previewAfter = await readDb('preview-after', presetSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    mark(caseRecord, '专属初始化 preview 不改变预置事实和权限快照',
      localPresetComplete(preview, false) && same(previewBefore, previewAfter), `tenant=${tenantId}`)
    const beforeConfirm = await readDb('ui-preview-before', presetSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    await page.locator('.init-wizard__modules-primary').click()
    const dialog = page.locator('.init-preset-dialog')
    await dialog.waitFor({ state: 'visible' })
    const afterDialog = await readDb('ui-preview-after', presetSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    mark(caseRecord, '初始化首轮确认弹窗真实出现且确认前未写入',
      await dialog.getByRole('button', { name: '确认并自动初始化', exact: true }).isVisible() &&
      same(beforeConfirm, afterDialog), `tenant=${tenantId}`)
    const stateResponse = page.waitForResponse((response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/system/system-init/state'))
    await dialog.getByRole('button', { name: '确认并自动初始化', exact: true }).click()
    await stateResponse
    await page.locator('.init-wizard--second').waitFor({ state: 'visible' })
    const permission = await read('/system/auth/get-permission-info')
    const adminRows = await readDb('tenant-admin-sync', `
      SELECT CAST(r.id AS CHAR),CAST(rm.menu_id AS CHAR) FROM system_role r
      JOIN system_role_menu rm ON rm.role_id=r.id AND rm.tenant_id=r.tenant_id
      WHERE r.tenant_id=${tenantId} AND r.code='tenant_admin' AND r.deleted=0 AND rm.deleted=0
      ORDER BY rm.menu_id`)
    const allowed = new Set(spec.packagePayload.menuIds.map(String))
    const actualMenus = flat(permission?.menus).map((row) => String(row.id))
    mark(caseRecord, '页面确认后真实 tenant_admin 授权立即同步且在套餐内',
      permission.roles?.includes('tenant_admin') &&
      String(permission.user?.id) === String(userId) && actualMenus.length > 0 &&
      actualMenus.every((menuId) => allowed.has(menuId) &&
        adminRows.some((row) => row[1] === menuId)), `tenant=${tenantId}; menus=${actualMenus.length}`)
    const groups = permission.navigationGroups || []
    requireFact(groups.length > 1, '确认后没有返回正式顶部业务域')
    const topMenu = page.locator('[id$="-top-menu"] > .el-menu-item')
    await topMenu.filter({ hasText: groups.find((row) => !/工作台/.test(row.title)).title })
      .waitFor({ state: 'visible' })
    const visible = await topMenu.allTextContents()
    mark(caseRecord, '页面确认后无需重新登录顶部业务域立即出现',
      groups.filter((row) => !/工作台/.test(row.title)).some((row) =>
        visible.some((value) => value.includes(row.title))), `groups=${visible.join(',')}`)
    const afterBoundary = await readDb('init-boundary-after', boundarySnapshotSql(tenantId))
    mark(caseRecord, '初始化确认不改共享套餐及其他角色授权',
      beforeBoundary.length > 0 && same(beforeBoundary, afterBoundary),
      `tenant=${tenantId}; sentinelRole=${sentinelId}`)
    return
  }

  await navigateComponent('system/systemInit/index', '.init-wizard--second')
  if (caseId === 'INIT-003') {
    const request = { modules: ['system'], keys: ['system.config.preset'], firstRun: true }
    const first = dataOf(await api.postBusiness('/system/system-init/preset/apply', request))
    requireFact(localPresetComplete(first) && first.conflicts === 0, '专属预置首轮回执不完整或有冲突')
    await page.reload({ waitUntil: 'domcontentloaded' })
    const receipt = page.locator('.init-receipt')
    await receipt.waitFor({ state: 'visible' })
    const expand = receipt.getByRole('button', { name: '展开明细', exact: true })
    if (await expand.isVisible()) await expand.click()
    const summary = await receipt.locator('.init-receipt__summary').innerText()
    const details = await receipt.locator('.init-receipt__item').allInnerTexts()
    mark(caseRecord, '首轮回执显示新增已存在保留修改冲突统计和逐项明细',
      ['新增', '已存在', '保留修改', '冲突'].every((label) => summary.includes(label)) &&
      details.length === first.contributions.length &&
      first.contributions.every((row) => details.some((value) => value.includes(row.title))),
      `tenant=${tenantId}; contributions=${details.length}`)
    const state = await read('/system/system-init/state')
    const receiptRows = await readDb('first-run-receipt', `
      SELECT first_run_preset_result FROM system_init_state WHERE tenant_id=${tenantId} AND deleted=0`)
    mark(caseRecord, '刷新后页面从 state 恢复同一首轮回执且落库一致',
      localPresetComplete(state?.firstRunPresetResult) && same(state.firstRunPresetResult, first) &&
      receiptRows.length === 1 && sameInitPresetReceipt(JSON.parse(receiptRows[0][0]), first),
      `tenant=${tenantId}`)
    const before = await readDb('preset-second-before', configSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    const second = dataOf(await api.postBusiness('/system/system-init/preset/apply', {
      ...request, firstRun: false
    }))
    const after = await readDb('preset-second-after', configSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    mark(caseRecord, '第二次指定预置零新增且业务事实完整快照不变',
      localPresetComplete(second) && second.added === 0 && second.conflicts === 0 &&
      second.contributions.every((row) => row.added === 0) &&
      before.length > 0 && same(before, after), `tenant=${tenantId}; secondAdded=${second?.added}`)
    const common = await read('/system/config/get?category=global&tag=common')
    requireFact(common?.configData, '专属预置没有可正式修改的 global/common 配置')
    const custom = { ...JSON.parse(common.configData), companyName: `E2E MOD ${spec.marker}` }
    await api.postBusiness('/system/config/save?category=global&tag=common', {
      configData: JSON.stringify(custom)
    })
    const modifiedBefore = await readDb('modified-before', configSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    const third = dataOf(await api.postBusiness('/system/system-init/preset/apply', {
      ...request, firstRun: false
    }))
    const preserved = await read('/system/config/get?category=global&tag=common')
    const modifiedAfter = await readDb('modified-after', configSnapshotSql(
      tenantId, configSchema.map((row) => row[0])))
    const contribution = third?.contributions?.find((row) => row.key === 'system.config.preset')
    mark(caseRecord, '正式修改预置配置后再次 apply 保留原值和逐项 modified 证据',
      localPresetComplete(third) && third.conflicts === 0 && contribution?.modified > 0 &&
      contribution.messages.some((value) => value.includes('global/common')) &&
      same(JSON.parse(preserved?.configData || '{}'), custom) && same(modifiedBefore, modifiedAfter),
      `tenant=${tenantId}; modified=${contribution?.modified}`)
    return
  }
  const state = await read('/system/system-init/state')
  const readiness = await read('/system/system-init/readiness')
  requireFact(Array.isArray(state?.selectedModules) && readiness?.items?.length,
    '专属初始化 state/readiness 缺少结构化数据')
  const tabs = await page.locator('.init-tabs .el-tabs__item').evaluateAll((rows) =>
    rows.map((row) => row.id.replace(/^tab-/, '')))
  mark(caseRecord, '初始化页面页签严格等于已选模块',
    same(sortedIds(tabs), sortedIds(state.selectedModules)), `tabs=${tabs.join(',')}`)
  const originalSkipped = [...state.skippedItems]
  for (const key of ['wms.opening', 'fms.initial-balance']) {
    requireFact(readiness.items.some((row) => row.key === key && row.skippable === true),
      `正式 readiness 不支持跳过 ${key}`)
    let primaryError
    try {
      await api.postBusiness(`/system/system-init/skip?key=${key}&skipped=true`)
      const skipped = await read('/system/system-init/state')
      requireFact(skipped.skippedItems?.includes(key), `${key} 跳过未回读`)
    } catch (error) { primaryError = error } finally {
      try {
        await api.postBusiness(`/system/system-init/skip?key=${key}&skipped=${originalSkipped.includes(key)}`)
      } catch (cleanupError) {
        throw new AggregateError([primaryError, cleanupError].filter(Boolean), `${key} 跳过恢复失败`)
      }
    }
    if (primaryError) throw primaryError
    requireFact(same(sortedIds((await read('/system/system-init/state')).skippedItems),
      sortedIds(originalSkipped)), `${key} 恢复集合不一致`)
  }
  mark(caseRecord, 'WMS 与 FMS 期初各自跳过回读并恢复原集合', true, `tenant=${tenantId}`)
  const beforeFormal = await read('/system/system-init/state')
  requireFact(readiness.items.some((row) => row.key === 'fms.account-set' && row.skippable === false),
    '正式账套缺少不可跳过结构化定义')
  const contract = { code: 400, message: '仅库存期初和财务期初余额支持跳过' }
  const denied = await api.request('POST', '/system/system-init/skip?key=fms.account-set&skipped=true',
    undefined, { expectedBusinessRejection: contract })
  const afterFormal = await read('/system/system-init/state')
  mark(caseRecord, '正式账套跳过精确业务拒绝且 state 原值不变',
    matchesExpectedBusinessRejection(denied, contract) && same(beforeFormal, afterFormal), `tenant=${tenantId}`)
  const initKeys = await page.locator('[data-init-item]').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-init-item')))
  const settingKeys = []
  const settingModules = [['system', 'enterprise'], ['erp', 'erp'], ['bpm', 'bpm'],
    ['wms', 'warehouse'], ['fms', 'fms']]
  const settingPermission = await read('/system/auth/get-permission-info')
  const missingOverview = settingModules.filter(([, path]) =>
    !hasInitSettingsOverview(settingPermission?.menus, path))
  for (const [module, path] of settingModules.filter(([, path]) =>
    hasInitSettingsOverview(settingPermission?.menus, path))) {
    await navigate(page, `/settings/${path}`, { readySelector: '.system-settings' })
    const settingTabs = page.locator('.settings-tabs .el-tabs__item')
    for (let index = 0; index < await settingTabs.count(); index++) {
      await settingTabs.nth(index).click()
      const keys = await page.locator('[data-settings-item]').evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-settings-item')))
      requireFact(keys.length > 0 && keys.every((key) => key.startsWith(`${module}.`)),
        `${module} 设置没有按模块拆分`)
      settingKeys.push(...keys)
    }
  }
  if (missingOverview.length) {
    caseRecord.notes.push(
      `PARTIAL: 当前正式菜单没有以下可渲染模块设置汇总页：` +
      missingOverview.map(([, path]) => `/settings/${path}`).join(',') +
      '；无组件目录和它的叶子页面不能替代逐项同源的设置汇总页证据。' +
      '跳过不存在的旧路由，保留原设置断言 GAP，未修改菜单、权限或 catalog。')
  } else {
    mark(caseRecord, '设置页面按模块拆分并与初始化逐项同源',
      initKeys.length > 0 && same(sortedIds(initKeys), sortedIds(settingKeys)),
      `init=${initKeys.length}; settings=${settingKeys.length}`)
  }
  await navigateComponent('system/enterprise-organization/index', '.enterprise-form')
  const organization = await read('/system/enterprise-organization/current')
  const fullName = await formField(page, '企业全称').locator('input').inputValue()
  await navigateComponent('system/systemInit/index', '.init-wizard--second')
  await page.getByRole('button', { name: '修改行业与板块' }).click()
  await page.locator('.init-wizard--first').waitFor({ state: 'visible' })
  const initFullName = await formField(page, '企业全称').locator('input').inputValue()
  mark(caseRecord, '企业配置在初始化与设置页面刷新回读一致',
    fullName === profile.enterpriseFullName && initFullName === fullName &&
    organization.industryCategory === state.industryCategory &&
    organization.industrySubCategory === state.industrySubCategory, `tenant=${tenantId}`)
}

const configSnapshotSql = (tenantId, configColumns) => buildConfigSnapshotSql({ tenantId, configColumns })
const presetSnapshotSql = (tenantId, configColumns) => `
  ${configSnapshotSql(tenantId, configColumns)};
  SELECT CAST(id AS CHAR),industry_template,selected_modules,skipped_items,current_step,status,
    first_run_preset_result FROM system_init_state WHERE tenant_id=${tenantId} AND deleted=0 ORDER BY id;
  SELECT CAST(id AS CHAR),data_scope,data_scope_dept_ids FROM system_role
  WHERE tenant_id=${tenantId} AND deleted=0 ORDER BY id;
  SELECT CAST(role_id AS CHAR),CAST(menu_id AS CHAR) FROM system_role_menu
  WHERE tenant_id=${tenantId} AND deleted=0 ORDER BY role_id,menu_id`
const boundarySnapshotSql = (tenantId) => `
  SELECT CAST(id AS CHAR),name,status,menu_ids FROM system_tenant_package WHERE deleted=0 ORDER BY id;
  SELECT CAST(id AS CHAR),CAST(tenant_id AS CHAR),code,data_scope,data_scope_dept_ids
  FROM system_role WHERE deleted=0 AND NOT(tenant_id=${tenantId} AND code='tenant_admin') ORDER BY id;
  SELECT CAST(rm.tenant_id AS CHAR),CAST(rm.role_id AS CHAR),CAST(rm.menu_id AS CHAR)
  FROM system_role_menu rm JOIN system_role r ON r.id=rm.role_id AND r.tenant_id=rm.tenant_id
  WHERE rm.deleted=0 AND r.deleted=0 AND NOT(r.tenant_id=${tenantId} AND r.code='tenant_admin')
  ORDER BY rm.tenant_id,rm.role_id,rm.menu_id`
const readPreview = async (api, modules) => dataOf(await api.postBusiness(
  '/system/system-init/preset/preview', { modules, keys: ['system.config.preset'] }))

export async function runIsolatedLocalInitCase (context, dependencies = {}) {
  assertSafeScope(dependencies.config)
  const record = context.caseRecord
  if (!(dependencies.writeFixturesEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true')) {
    record.notes.push('未开启专属租户写侧夹具，未创建租户或修改共享企业资料；保留全部待执行证据。')
    return { executed: false }
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(record)
  // Reuse the runner's already authenticated platform page; do not treat the
  // login options as a second account's credentials.
  const auth = await (dependencies.login || login)(context.page, { returnContext: true })
  requireFact(typeof auth?.token === 'string' && auth.token.length > 20,
    '平台主会话未返回真实访问令牌')
  const apiFactory = dependencies.createApiClient || createApiClient
  const primaryApi = apiFactory({
    token: auth.token, tenantId: '1', record: context.record
  })
  // A directly selected init case may start without INIT-001's cached login
  // context. Verify the same token against the formal permission and tenant
  // APIs before treating it as the platform tenant session.
  const permission = dataOf(await primaryApi.getPermissionInfo())
  const tenant = dataOf(await primaryApi.getBusiness('/system/tenant/get?id=1'))
  requireFact(String(auth.tenantId || '1') === '1' &&
    Array.isArray(permission?.roles) && permission.roles.includes('super_admin') &&
    String(tenant?.id) === '1' && tenant.name === 'CFOR 标准平台',
  '平台主会话必须由正式 API 证明为标准租户 1 super_admin')
  return (dependencies.runEnterpriseIsolationEvidence || runEnterpriseIsolationEvidence)({
    context, primaryApi, dependencies, packagePlan: buildLocalInitPackage,
    verifyEnterprisePage: (session) => runLocalInitClosure({
      ...session, caseId: context.caseId, caseRecord: record, navigate: dependencies.openRoute || openRoute
      , outputDir: context.outputDir, record: context.record
    })
  })
}
