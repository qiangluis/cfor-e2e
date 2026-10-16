import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { config } from '../config/index.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

export const COST_ENTERPRISE_CHECKS = Object.freeze({
  trade: '生产验证接口拒绝贸易型企业',
  purchase: '生产验证接口拒绝采购来源混入生产成本',
  tradeUnchanged: 'COST-007 TRADE 精确拒绝后正式期间与工作流请求台账不变',
  purchaseUnchanged: 'COST-007 六类采购来源精确拒绝后正式期间与工作流请求台账不变',
  inventory: 'COST-007 全量菜单与权限菜单交叉回读既有成本工作台组件',
  workbench: 'COST-007 真实页面复用权限菜单绑定的既有成本工作台'
})
export const COST_ENTERPRISE_TRADE_REJECTION = Object.freeze({
  code: 422001, message: '生产型成本试算仅支持MANUFACTURING企业类型'
})
export const COST_ENTERPRISE_PURCHASE_SOURCES = Object.freeze([
  'PURCHASE', 'PURCHASE_RECEIPT', 'PURCHASE_RECEIVE',
  'PURCHASE_INBOUND', 'PURCHASE_RETURN', 'PURCHASE_FREIGHT'
])
export const costEnterprisePurchaseRejection = (sourceNo) => ({
  code: 422001, message: `采购成本不能直接等于生产材料成本：${sourceNo}`
})
const tables = ['cost_period', 'cost_workflow_request']
const hash = (value) => createHash('sha256').update(value).digest('hex')
const exactId = (value, zero = false) => {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), 'COST-007 lossy ID')
  const result = String(value)
  assert.match(result, zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/, 'COST-007 invalid ID')
  return result
}
const count = (value) => {
  assert.match(String(value), /^\d+$/, 'COST-007 missing census count')
  assert.ok(Number.isSafeInteger(Number(value)), 'COST-007 unsafe census count')
  return Number(value)
}
const addCheck = (record, name, passed, details) => {
  record.checks ||= []
  record.checks.push({ name, passed, details: JSON.stringify(details) })
}
const localTenant = (tenantId) => {
  assert.equal(config.target, 'local', 'COST-007 evidence is restricted to the local target')
  assert.equal(String(tenantId), '1', 'COST-007 formal fact evidence requires tenant1 context')
}

// Schema-driven JSON hashes include every persisted column, including audit and deletion fields.
export const readCostEnterpriseFactSnapshot = async (readSql = runReadOnlySql) => {
  const schema = await readSql(`
    SELECT 'schema-count', table_name, COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name IN ('cost_period', 'cost_workflow_request')
    GROUP BY table_name ORDER BY table_name;
    SELECT 'column', table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name IN ('cost_period', 'cost_workflow_request')
    ORDER BY table_name, ordinal_position
  `)
  assert.equal(schema.available, true, 'COST-007 requires local read-only database evidence')
  const columns = {}
  for (const table of tables) {
    const census = schema.rows.filter((row) => row[0] === 'schema-count' && row[1] === table)
    assert.equal(census.length, 1, `COST-007 missing ${table} schema census`)
    columns[table] = schema.rows.filter((row) => row[0] === 'column' && row[1] === table)
      .map(([, , name, type]) => {
        assert.match(name, /^[a-z][a-z0-9_]*$/, 'COST-007 unsafe column name')
        return { name, type }
      })
    assert.equal(columns[table].length, count(census[0][2]), 'COST-007 incomplete schema inventory')
    assert.equal(new Set(columns[table].map((row) => row.name)).size, columns[table].length)
    assert.ok(['id', 'tenant_id'].every((name) => columns[table].some((row) => row.name === name)),
      `COST-007 missing ${table} identity/tenant columns`)
  }
  const sql = tables.map((table) => {
    const fields = columns[table].map(({ name, type }) =>
      `'${name}', ${type === 'bit' ? `CAST(\`${name}\` AS UNSIGNED)` : `\`${name}\``}`).join(', ')
    return `
      SELECT 'count', '${table}', COUNT(*) FROM ${table} WHERE tenant_id = 1;
      SELECT 'row', '${table}', CAST(id AS CHAR),
        SHA2(CAST(JSON_OBJECT(${fields}) AS CHAR), 256)
      FROM ${table} WHERE tenant_id = 1 ORDER BY id
    `
  }).join(';')
  const result = await readSql(sql)
  assert.equal(result.available, true, 'COST-007 missing formal fact snapshot')
  const snapshot = {}
  for (const table of tables) {
    const census = result.rows.filter((row) => row[0] === 'count' && row[1] === table)
    assert.equal(census.length, 1, `COST-007 missing ${table} row census`)
    const rows = result.rows.filter((row) => row[0] === 'row' && row[1] === table)
      .map(([, , value, digest]) => {
        assert.match(digest || '', /^[a-f0-9]{64}$/, 'COST-007 invalid row hash')
        return { id: exactId(value), hash: digest }
      })
    assert.equal(rows.length, count(census[0][2]), `COST-007 incomplete ${table} snapshot`)
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'COST-007 duplicate fact ID')
    snapshot[table] = {
      columns: columns[table], count: rows.length,
      rows: rows.sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : 1)
    }
  }
  return snapshot
}

export const verifyCostEnterpriseRejections = async ({
  api, caseRecord, period, tenantId, readSnapshot = readCostEnterpriseFactSnapshot
}) => {
  localTenant(tenantId)
  assert.match(period || '', /^\d{4}-\d{2}$/)
  const groups = [
    { key: 'trade', unchanged: 'tradeUnchanged', inputs: [{
      enterpriseType: 'TRADE', periodId: period, modelVersion: 'E2E-TRADE-REJECT',
      sourceFacts: [], finishedRatios: {}
    }], contracts: [COST_ENTERPRISE_TRADE_REJECTION] },
    { key: 'purchase', unchanged: 'purchaseUnchanged',
      inputs: COST_ENTERPRISE_PURCHASE_SOURCES.map((sourceType) => ({
        enterpriseType: 'MANUFACTURING', periodId: period, modelVersion: 'E2E-PURCHASE-REJECT',
        sourceFacts: [{ sourceType, sourceNo: sourceType === 'PURCHASE_RECEIPT'
          ? 'E2E-GR-001' : `E2E-COST-007-${sourceType}` }], finishedRatios: {}
      })) }
  ]
  const evidence = {}
  caseRecord.costEnterpriseRejections = evidence
  for (const group of groups) {
    const before = await readSnapshot()
    const attempts = []
    let requestError
    try {
      for (const [index, body] of group.inputs.entries()) {
        const expected = group.contracts?.[index] ||
          costEnterprisePurchaseRejection(body.sourceFacts[0].sourceNo)
        const response = await api.request('POST', '/cost/verification/production-trial', body, {
          expectedBusinessRejection: expected
        })
        attempts.push({ body, expected, code: response?.code, msg: response?.msg,
          matched: matchesExpectedBusinessRejection(response, expected) &&
            response?.msg === expected.message })
      }
    } catch (error) {
      requestError = error
    } finally {
      const after = await readSnapshot()
      const unchanged = JSON.stringify(before) === JSON.stringify(after)
      const positiveControl = before.cost_period?.count > 0 && after.cost_period?.count > 0
      evidence[group.key] = { before, after, attempts, unchanged, positiveControl }
      addCheck(caseRecord, COST_ENTERPRISE_CHECKS[group.key],
        !requestError && attempts.length === group.inputs.length &&
          attempts.every((attempt) => attempt.matched), attempts)
      if (!unchanged || positiveControl) {
        addCheck(caseRecord, COST_ENTERPRISE_CHECKS[group.unchanged], unchanged,
          { before, after, positiveControl })
      } else {
        caseRecord.notes ||= []
        caseRecord.notes.push(`COST-007 ${group.key} 缺少非空正式期间正控制，空表不变不计入验收`)
      }
    }
    if (requestError) throw requestError
  }
  return evidence
}

export const COST_ENTERPRISE_MENU_SQL = `
  SELECT 'total', COUNT(*) FROM system_menu WHERE deleted = 0;
  SELECT 'menu', CAST(JSON_OBJECT(
    'id', CAST(id AS CHAR), 'parentId', CAST(parent_id AS CHAR), 'name', name,
    'path', path, 'component', component, 'componentName', component_name,
    'permission', permission, 'type', type, 'status', status, 'visible', visible + 0
  ) AS CHAR) FROM system_menu WHERE deleted = 0 ORDER BY id
`
export const parseCostEnterpriseMenuInventory = (result) => {
  assert.equal(result.available, true, 'COST-007 missing complete database menu inventory')
  const census = result.rows.filter((row) => row[0] === 'total')
  assert.equal(census.length, 1, 'COST-007 missing database menu count')
  const rows = result.rows.filter((row) => row[0] === 'menu').map((row) => JSON.parse(row[1]))
  assert.equal(rows.length, count(census[0][1]), 'COST-007 truncated database menu inventory')
  assert.ok(rows.length > 0, 'COST-007 empty menu inventory is not absence evidence')
  const byId = new Map()
  for (const row of rows) {
    row.id = exactId(row.id)
    row.parentId = exactId(row.parentId, true)
    assert.ok(!byId.has(row.id), 'COST-007 duplicate database menu ID')
    assert.ok(typeof row.path === 'string' && [1, 2, 3].includes(row.type) &&
      [0, 1].includes(row.status) && [0, 1].includes(row.visible), 'COST-007 invalid menu row')
    byId.set(row.id, row)
  }
  const resolve = (row, seen = new Set()) => {
    assert.ok(!seen.has(row.id), 'COST-007 cyclic database menu hierarchy')
    seen.add(row.id)
    const parent = row.parentId === '0' ? null : byId.get(row.parentId)
    assert.ok(row.parentId === '0' || parent, 'COST-007 incomplete parent menu inventory')
    const context = parent ? resolve(parent, seen) : { route: '', enabled: true, visible: true }
    return {
      route: (row.path.startsWith('/') ? row.path : `${context.route}/${row.path}`)
        .replace(/\/+/g, '/'),
      enabled: context.enabled && row.status === 0,
      visible: context.visible && row.visible === 1
    }
  }
  return rows.map((row) => ({ ...row, ...resolve(row) }))
}

const componentPath = (value) => String(value || '').split('?')[0]
  .replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\.vue$/, '')
const pageKey = (value) => new URLSearchParams(String(value || '').split('?').slice(1).join('?')).get('page')
const permissionLeaves = (nodes, parent = '') => (nodes || []).flatMap((node) => {
  assert.ok(typeof node.path === 'string', 'COST-007 malformed permission route')
  const route = (node.path.startsWith('/') ? node.path : `${parent}/${node.path}`).replace(/\/+/g, '/')
  return [{ ...node, route }, ...permissionLeaves(node.children, route)]
})

export const readCostEnterpriseSourceBoundaries = () => {
  const files = {
    workbench: ['cfor/cfor-admin-vue3/src/views/cost-management/index.vue', [
      '<div class="cost-workbench">', '<h1>成本工作台</h1>'
    ]],
    section: ['cfor/cfor-admin-vue3/src/views/cost-management/section/index.vue', [
      '<CostControlRuleWorkspace v-if="config.key === \'control-rules\'" />', 'getCostPageConfig(pageKey.value)'
    ]],
    registry: ['cfor/cfor-admin-vue3/src/views/cost-management/pageRegistry.ts', [
      "'validation-threshold': page({", "kind: 'settings'", 'export const costLegacyPageMap'
    ]],
    controlApi: ['cfor/cfor-admin-vue3/src/api/cost-management/control-rule/index.ts', [
      "url: '/cost/control-rules'"
    ]],
    access: ['cfor/cfor-admin-vue3/src/router/access.ts', [
      "'/cost-management'", 'routes.forEach((route) => router.addRoute(route))', 'addFallbackChildren'
    ]]
  }
  return Object.fromEntries(Object.entries(files).map(([key, [relative, markers]]) => {
    const file = new URL(`../../../../${relative}`, import.meta.url)
    const source = fs.readFileSync(file, 'utf8')
    assert.ok(markers.every((marker) => source.includes(marker)),
      `COST-007 source boundary changed: ${relative}`)
    return [key, { path: file.pathname, sha256: hash(source), markers,
      ...(key === 'registry' ? {
        thresholdAliasedToFormalRules: /['"]validation-threshold['"]\s*:\s*['"]control-rules['"]/.test(source)
      } : {}) }]
  }))
}

export const auditCostEnterpriseRoutes = async ({
  api, tenantId, readSql = runReadOnlySql, readSources = readCostEnterpriseSourceBoundaries
}) => {
  localTenant(tenantId)
  const inventory = parseCostEnterpriseMenuInventory(await readSql(COST_ENTERPRISE_MENU_SQL))
  const info = assertBusinessSuccess(await api.getBusiness('/system/auth/get-permission-info'),
    'COST-007 real permission menus').data
  assert.ok(Array.isArray(info?.menus) && info.menus.length, 'COST-007 empty permission menus')
  const leaves = permissionLeaves(info.menus)
  const workbenches = inventory.filter((row) => row.type === 2 &&
    componentPath(row.component) === 'cost-management/index')
  const canonical = workbenches.filter((row) =>
    row.route === '/cost-management/workbench' && row.enabled && row.visible)
  assert.equal(canonical.length, 1, 'COST-007 canonical workbench must resolve uniquely in complete menu inventory')
  const permitted = leaves.filter((row) => exactId(row.id) === canonical[0].id &&
    row.route === canonical[0].route &&
    componentPath(row.component) === componentPath(canonical[0].component))
  assert.equal(permitted.length, 1, 'COST-007 real actor menu must bind the canonical workbench')
  const sections = inventory.filter((row) =>
    row.type === 2 && componentPath(row.component) === 'cost-management/section/index')
  const costMenus = inventory.filter((row) => /成本|cost/i.test(
    `${row.name} ${row.path} ${row.component || ''} ${row.permission || ''}`))
  const controlRules = sections.filter((row) => pageKey(row.component) === 'control-rules')
  const thresholds = sections.filter((row) => pageKey(row.component) === 'validation-threshold')
  assert.ok(controlRules.some((row) => row.enabled && row.visible),
    'COST-007 missing positive formal control-rule entry')
  const sources = readSources()
  const gaps = [
    '全量当前菜单和组件复用证据不能单独证明“不新增”这一历史断言，未擅自改为“当前可打开”'
  ]
  if (workbenches.length > 1) gaps.push('公开工作台之外还存在 legacy 工作台路由；共用组件不能替代入口范围确认')
  if (thresholds.some((row) => row.enabled) && !sources.registry.thresholdAliasedToFormalRules) {
    gaps.push('正式 control-rules 与通用 validation-threshold 设置入口并存且未做别名映射，是否为平行设置需确认')
  }
  const foreign = costMenus.filter((row) => row.type === 2 && row.component &&
    !['cost-management/index', 'cost-management/section/index'].includes(componentPath(row.component)))
  if (foreign.length) gaps.push('完整菜单库存发现其他成本页面组件，不能按名称忽略其设置边界')
  return {
    workbench: { id: canonical[0].id, route: canonical[0].route, component: permitted[0].component },
    inventory: { count: inventory.length, sha256: hash(JSON.stringify(inventory)), costMenus },
    workbenches, controlRules, thresholds, foreignComponents: foreign, sources,
    reusedComponent: true, noParallelSettingsVerified: false, assertionStatus: 'GAP', gaps
  }
}

export const verifyCostEnterpriseWorkbench = async (page, audit) => {
  assert.equal(new URL(page.url()).pathname, audit.workbench.route, 'COST-007 unexpected workbench route')
  const root = page.locator('.cost-workbench')
  await root.waitFor({ state: 'visible' })
  assert.equal(await root.count(), 1, 'COST-007 missing/duplicate official workbench root')
  assert.equal(await root.getByRole('heading', { name: '成本工作台', exact: true }).count(), 1)
  const text = await page.locator('body').innerText()
  assert.doesNotMatch(text, /模块配置异常|页面加载失败|页面不存在|\b404\b|\b403\b|无权限|权限不足|拒绝访问/)
  assert.ok(text.includes('成本可计算') && text.includes('正式写入需人工确认'),
    'COST-007 missing existing workbench content')
  return { route: audit.workbench.route, component: audit.workbench.component, text }
}
