import { createHash } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertLocalDatabase, runReadOnlySql } from '../lib/db.mjs'

const tables = Object.freeze([
  'equipment_info', 'mes_wms_site_equipment', 'iot_device', 'mes_device_legacy_mapping'
])
const statuses = Object.freeze(['MATCHED', 'AMBIGUOUS', 'UNMATCHED'])
const sources = Object.freeze(['equipment_info', 'mes_wms_site_equipment'])
const candidateSourceTables = Object.freeze(['equipment_info', 'mes_wms_site_equipment'])
const count = (value) => /^(?:0|[1-9]\d*)$/.test(String(value)) &&
  Number.isSafeInteger(Number(value)) ? Number(value) : NaN
const identifier = (value) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Invalid legacy snapshot identifier')
  return `\`${value}\``
}
const databaseIdentifier = (value) => {
  if (!/^[a-z][a-z0-9_-]*$/i.test(String(value))) {
    throw new Error('Invalid legacy candidate database identifier')
  }
  return `\`${value}\``
}
const dataOf = (response) => response?.data

export const resolveLegacyMappingMenuRoute = (menus) => {
  if (!Array.isArray(menus)) throw new Error('Missing real legacy mapping permission menus')
  const matches = []
  const walk = (nodes, parent = '') => {
    for (const menu of nodes) {
      if (typeof menu.path !== 'string' || /[?#\\]|^(?:\w+:|\/\/)/.test(menu.path) ||
          menu.path.split('/').some((part) => part === '.' || part === '..')) continue
      const route = (menu.path.startsWith('/') ? menu.path : `${parent}/${menu.path}`)
        .replace(/\/+/g, '/')
      if (menu.children?.length) {
        walk(menu.children, route)
      } else if (menu.component === 'mes/device/legacyMapping/index') {
        matches.push({ route, menuId: menu.id, title: menu.name, component: menu.component })
      }
    }
  }
  walk(menus)
  if (matches.length !== 1) {
    throw new Error(`Expected one real legacy mapping menu, found ${matches.length}`)
  }
  return matches[0]
}

// Resolve the relocated menu in this focused test; never create routes or
// replace permission menus in the application to satisfy an obsolete URL.
export const createLegacyMappingPageOpener = ({ api, caseRecord, openRoute }) => {
  let menu
  return async (page, requestedRoute, options = {}) => {
    menu ||= resolveLegacyMappingMenuRoute(dataOf(
      await api.getBusiness('/system/auth/get-permission-info'))?.menus)
    if (![menu.route, '/settings/iot/device-legacy-mapping'].includes(requestedRoute)) {
      throw new Error(`Unexpected legacy mapping test route: ${requestedRoute}`)
    }
    await openRoute(page, menu.route, options)
    const actualPath = new URL(page.url()).pathname
    caseRecord.legacyPageRoute = { ...menu, requestedRoute, actualPath }
    caseRecord.checks.push({
      name: '对账页面路径来自真实权限菜单且未创建路由或替换组件',
      passed: actualPath === menu.route,
      details: JSON.stringify(caseRecord.legacyPageRoute)
    })
    return menu
  }
}

export const hasLegacyBrowserReadEvidence = (entries) =>
  Array.isArray(entries) && entries.length > 0 &&
  entries.every((entry) => entry.method === 'GET' &&
    ['/admin-api/mes/device-legacy-mapping/summary', '/admin-api/mes/device-legacy-mapping/page']
      .includes(entry.pathname)) &&
  entries.some((entry) => entry.pathname.endsWith('/summary')) &&
  entries.some((entry) => entry.pathname.endsWith('/page') &&
    new URLSearchParams(entry.query).get('pageNo') === '1' &&
    new URLSearchParams(entry.query).get('pageSize') === '100')

export const legacyMetadataSql = `
  SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME IN ('equipment_info','mes_wms_site_equipment','iot_device','mes_device_legacy_mapping')
  ORDER BY TABLE_NAME, ORDINAL_POSITION
`

export const legacyLedgerSql = `
  SELECT 'source', 'equipment_info', COUNT(*) FROM equipment_info;
  SELECT 'source', 'mes_wms_site_equipment', COUNT(*) FROM mes_wms_site_equipment
    WHERE tenant_id=1 AND deleted=0;
  SELECT 'summary', COUNT(*), COALESCE(SUM(match_status='MATCHED'),0),
    COALESCE(SUM(match_status='AMBIGUOUS'),0), COALESCE(SUM(match_status='UNMATCHED'),0)
  FROM mes_device_legacy_mapping WHERE tenant_id=1 AND deleted=0
`

// This inventory is read-only and only identifies separate local databases that
// may contain retired source rows. It never switches the application data
// source, copies rows, or invokes the legacy reconcile endpoint.
export const legacyCandidateMetadataSql = `
  SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA <> DATABASE()
    AND TABLE_SCHEMA REGEXP '^cfor[-_a-z0-9]+$'
    AND TABLE_NAME IN ('equipment_info','mes_wms_site_equipment')
  ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
`

export const buildLegacyCandidateCountSql = (metadata) => {
  if (!Array.isArray(metadata)) throw new Error('Invalid legacy candidate metadata')
  const grouped = new Map()
  for (const row of metadata) {
    const [schema, table, column] = row || []
    if (!schema || !candidateSourceTables.includes(table) ||
        !/^[a-z][a-z0-9_-]*$/i.test(String(schema)) ||
        !/^[a-z][a-z0-9_]*$/.test(String(column))) {
      throw new Error('Invalid legacy candidate metadata row')
    }
    const key = `${schema}\u0000${table}`
    if (!grouped.has(key)) grouped.set(key, {
      schema: String(schema), table: String(table), columns: new Set()
    })
    grouped.get(key).columns.add(String(column))
  }
  return [...grouped.values()]
    .sort((left, right) => `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`))
    .map(({ schema, table, columns }) => {
      if (!columns.has('id')) throw new Error(`Incomplete legacy candidate schema: ${schema}.${table}`)
      const tenantColumn = columns.has('tenant_id') ? `COUNT(DISTINCT ${identifier('tenant_id')})` : 'NULL'
      const tenantOneActive = columns.has('tenant_id') && columns.has('deleted')
        ? `SUM(${identifier('tenant_id')}=1 AND ${identifier('deleted')}=0)`
        : 'NULL'
      return `SELECT 'candidate-source', '${schema}', '${table}', COUNT(*), ${tenantColumn}, ${tenantOneActive}` +
        ` FROM ${databaseIdentifier(schema)}.${identifier(table)}`
    }).join(';\n')
}

export const summarizeLegacyCandidates = (metadata, counts, targetDatabase = '') => {
  if (!Array.isArray(metadata) || !Array.isArray(counts)) {
    return {
      available: false,
      targetDatabase,
      candidateDatabases: [],
      sourceRows: [],
      approved: false,
      usableReadOnlyFixture: false,
      reason: '候选历史库盘点结果不完整'
    }
  }
  const columns = new Map()
  for (const row of metadata) {
    const [schema, table, column] = row || []
    if (!schema || !candidateSourceTables.includes(table) || !column) continue
    const key = `${schema}\u0000${table}`
    if (!columns.has(key)) columns.set(key, new Set())
    columns.get(key).add(column)
  }
  const sourceRows = counts
    .filter((row) => row?.[0] === 'candidate-source')
    .map((row) => {
      const total = count(row[3])
      const tenantCount = row[4] === 'NULL' ? null : count(row[4])
      const tenantOneActive = row[5] === 'NULL' ? null : count(row[5])
      return {
        database: row[1],
        table: row[2],
        total,
        tenantColumn: columns.get(`${row[1]}\u0000${row[2]}`)?.has('tenant_id') === true,
        tenantCount,
        tenantOneActive
      }
    })
    .filter((row) => Number.isSafeInteger(row.total) && row.total > 0)
  const candidateDatabases = [...new Set(
    sourceRows.filter((row) => row.total > 0).map((row) => row.database)
  )].sort()
  const hasRows = sourceRows.some((row) => row.total > 0)
  return {
    available: true,
    targetDatabase,
    candidateDatabases,
    sourceRows,
    approved: false,
    usableReadOnlyFixture: false,
    isolatedFromTarget: candidateDatabases.every((database) => database !== targetDatabase),
    reason: hasRows
      ? '发现独立数据库中的历史来源候选，但未确认数据归属、脱敏和使用授权；本轮不切换数据源、不复制样本、不执行 reconcile'
      : '未发现含历史来源行的独立 cfor 数据库候选'
  }
}

export const legacySafetyBlocks = Object.freeze([
  '现有 reconcile 无来源 ID 白名单，调用会 deleteAll 后重建共享租户全部派生映射，本轮未调用',
  'equipment_info 与 mes_wms_site_equipment 的新增/编辑/导入入口已关闭，没有正式旧设备样本写入口',
  'equipment_info 无 tenant_id 且 Mapper 忽略租户过滤，历史来源归属需先正式确认',
  '本机其他数据库即使含旧来源样本，也只能作为未授权候选；没有经批准的脱敏快照或隔离应用数据源，不能用于本租户真实对账'
])

export const legacyMinimumPlan = Object.freeze([
  '先确认无租户字段历史来源的归属，不能按当前登录租户默认认领',
  '提供带来源表和来源 ID 白名单的正式预览/对账入口；事务内仅更新该范围映射，范围外逐行快照不变',
  '在隔离本地验收库准备经批准的只读历史快照，覆盖二维码优先、SN、站点编码、名称唯一、多义、未命中；不重新开放旧设备 CRUD',
  '对相同白名单连续执行两次，比较逻辑映射及设备名称快照，并核对全部来源事实和范围外映射不变'
])

export const assertLegacyLocalTarget = (settings = config) => {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1') {
    throw new Error('BLOCKED: MAINT-012 只允许本地 CFOR 标准平台租户 1')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== port) {
      throw new Error('BLOCKED: MAINT-012 只允许本地后端 48083 / Web 9151')
    }
  }
  assertLocalDatabase(settings.db)
}

export const buildLegacySnapshotSql = (metadata) => tables.map((table) => {
  const columns = metadata.filter((row) => row[0] === table).map((row) => row[1])
  if (!columns.includes('id') || new Set(columns).size !== columns.length ||
      (table !== 'equipment_info' && !columns.includes('tenant_id'))) {
    throw new Error(`Incomplete legacy snapshot schema: ${table}`)
  }
  // Hash every column inside SQL so device credentials never enter the report.
  const fields = columns.map((column) =>
    `'${identifier(column).slice(1, -1)}', HEX(${identifier(column)})`).join(', ')
  const where = ['mes_wms_site_equipment', 'iot_device'].includes(table) ? ' WHERE tenant_id=1' : ''
  return `SELECT 'table', '${table}', COUNT(*) FROM ${identifier(table)}${where};
    SELECT 'row', '${table}', CAST(id AS CHAR),
      SHA2(CAST(JSON_OBJECT(${fields}) AS CHAR),256)
    FROM ${identifier(table)}${where} ORDER BY id`
}).join(';\n')

export const hasCompleteLegacySnapshot = (rows) => {
  if (!Array.isArray(rows) || rows.some((row) => !tables.includes(row?.[1]))) return false
  return tables.every((table) => {
    const totals = rows.filter((row) => row[0] === 'table' && row[1] === table)
    const entries = rows.filter((row) => row[0] === 'row' && row[1] === table)
    return totals.length === 1 && totals[0].length === 3 &&
      count(totals[0][2]) === entries.length &&
      new Set(entries.map((row) => row[2])).size === entries.length &&
      entries.every((row) => row.length === 4 && typeof row[2] === 'string' && row[2].length > 0 &&
        /^[a-f0-9]{64}$/i.test(row[3])) &&
      rows.filter((row) => row[1] === table).length === entries.length + 1
  })
}

export const legacySnapshotDigest = (rows) => {
  if (!hasCompleteLegacySnapshot(rows)) throw new Error('Incomplete legacy row snapshot')
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

export const hasConservedLegacySummary = (summary) => {
  const values = ['total', 'matched', 'ambiguous', 'unmatched'].map((key) => count(summary?.[key]))
  return values.every(Number.isSafeInteger) && values[0] === values[1] + values[2] + values[3]
}

export const hasLegacyPageContract = (payload, expectedTotal, filter = {}) => {
  const rows = payload?.list
  const total = count(payload?.total)
  if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total !== expectedTotal ||
      rows.length !== Math.min(total, 100) ||
      new Set(rows.map((row) => String(row?.id))).size !== rows.length) return false
  return rows.every((row) => {
    const id = String(row?.id)
    const deviceId = String(row?.iotDeviceId)
    if (!/^[1-9]\d*$/.test(id) ||
        (typeof row.id === 'number' && !Number.isSafeInteger(row.id)) ||
        !sources.includes(row.legacyTable) || !statuses.includes(row.matchStatus) ||
        row.legacyId == null || String(row.legacyId).length === 0 ||
        Object.entries(filter).some(([key, value]) => row[key] !== value)) return false
    if (row.matchStatus === 'MATCHED') {
      return /^[1-9]\d*$/.test(deviceId) &&
        (typeof row.iotDeviceId !== 'number' || Number.isSafeInteger(row.iotDeviceId)) &&
        typeof row.iotDeviceName === 'string' && row.iotDeviceName.trim().length > 0 &&
        ['CODE', 'NAME'].includes(row.matchType)
    }
    return row.iotDeviceId == null && row.iotDeviceName == null &&
      (row.matchStatus !== 'AMBIGUOUS' || row.matchType === 'NAME') &&
      typeof row.remark === 'string' && row.remark.includes('人工确认')
  })
}

export const verifyLegacyReadonly = async ({ api, caseRecord, checkPage, dependencies = {} }) => {
  assertLegacyLocalTarget(dependencies.config || config)
  const read = dependencies.runReadOnlySql || runReadOnlySql
  const requiredRead = async (sql, stage) => {
    const result = await read(sql)
    if (!result.available) throw new Error(`BLOCKED: ${result.reason}`)
    caseRecord.database = [...(caseRecord.database || []), { stage, ...result }]
    return result.rows
  }
  const optionalRead = async (sql) => {
    try {
      const result = await read(sql)
      return result?.available
        ? { available: true, rows: result.rows }
        : { available: false, rows: [], reason: result?.reason || '只读数据库不可用' }
    } catch (error) {
      return { available: false, rows: [], reason: error.message }
    }
  }
  const add = (name, passed, details) =>
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
  const metadata = await requiredRead(legacyMetadataSql, 'legacy-schema')
  const snapshotSql = buildLegacySnapshotSql(metadata)
  const before = await requiredRead(snapshotSql, 'legacy-full-row-hash-before')
  const beforeDigest = legacySnapshotDigest(before)
  const ledger = await requiredRead(legacyLedgerSql, 'legacy-local-ledger')
  const candidateMetadataResult = await optionalRead(legacyCandidateMetadataSql)
  let candidateInventory = {
    available: false,
    targetDatabase: dependencies.config?.db?.name || config.db.name,
    candidateDatabases: [],
    sourceRows: [],
    approved: false,
    usableReadOnlyFixture: false,
    reason: candidateMetadataResult.reason
  }
  if (candidateMetadataResult.available) {
    try {
      const candidateCountSql = buildLegacyCandidateCountSql(candidateMetadataResult.rows)
      const candidateCounts = candidateCountSql
        ? await optionalRead(candidateCountSql)
        : { available: true, rows: [] }
      candidateInventory = candidateCounts.available
        ? summarizeLegacyCandidates(
          candidateMetadataResult.rows,
          candidateCounts.rows,
          dependencies.config?.db?.name || config.db.name
        )
        : {
            ...candidateInventory,
            reason: candidateCounts.reason
          }
    } catch (error) {
      candidateInventory.reason = error.message
    }
  }
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'legacy-historical-candidate-inventory',
    ...candidateInventory
  }]
  const summary = dataOf(await api.getBusiness('/mes/device-legacy-mapping/summary'))
  const sqlSummary = ledger.find((row) => row[0] === 'summary')
  add('对账汇总字段有效且口径守恒', hasConservedLegacySummary(summary), JSON.stringify(summary))
  add('对账汇总与本租户数据库状态计数逐项一致',
    sqlSummary?.length === 5 &&
      ['total', 'matched', 'ambiguous', 'unmatched'].every((key, index) =>
        count(summary?.[key]) === count(sqlSummary[index + 1])), JSON.stringify(sqlSummary))

  const page = dataOf(await api.getBusiness('/mes/device-legacy-mapping/page?pageNo=1&pageSize=100'))
  add('对账分页总数及非空行契约与汇总一致',
    hasLegacyPageContract(page, count(summary?.total)),
    `rows=${page?.list?.length}; total=${page?.total}; 空页仅证明分页契约，不证明匹配分支`)
  for (const [status, field] of [['MATCHED', 'matched'], ['AMBIGUOUS', 'ambiguous'], ['UNMATCHED', 'unmatched']]) {
    const filtered = dataOf(await api.getBusiness(
      `/mes/device-legacy-mapping/page?pageNo=1&pageSize=100&matchStatus=${status}`))
    add(`${status} 筛选计数与汇总一致`,
      hasLegacyPageContract(filtered, count(summary?.[field]), { matchStatus: status }),
      `rows=${filtered?.list?.length}; total=${filtered?.total}; 空筛选不作为状态样本证据`)
  }
  await checkPage()
  const again = dataOf(await api.getBusiness('/mes/device-legacy-mapping/summary'))
  add('重复只读汇总返回稳定，未冒充重建幂等证据',
    hasConservedLegacySummary(again) &&
      ['total', 'matched', 'ambiguous', 'unmatched'].every((key) =>
        count(summary?.[key]) === count(again?.[key])), JSON.stringify(again))
  const after = await requiredRead(snapshotSql, 'legacy-full-row-hash-after')
  const afterDigest = legacySnapshotDigest(after)
  add('只读复验前后全部来源与所有租户派生映射逐行哈希不变',
    beforeDigest === afterDigest, `before=${beforeDigest}; after=${afterDigest}`)
  const sourceCounts = Object.fromEntries(sources.map((table) =>
    [table, count(ledger.find((row) => row[0] === 'source' && row[1] === table)?.[2])]))
  add('旧来源样本数量已取得数据库证据',
    Object.values(sourceCounts).every(Number.isSafeInteger), JSON.stringify(sourceCounts))
  add('历史来源候选盘点为只读且未冒充可用验收夹具',
    candidateInventory.available &&
      candidateInventory.approved === false &&
      candidateInventory.usableReadOnlyFixture === false &&
      candidateInventory.candidateDatabases.every((database) =>
        database !== (dependencies.config?.db?.name || config.db.name)),
    JSON.stringify({
      candidateDatabases: candidateInventory.candidateDatabases,
      sourceRows: candidateInventory.sourceRows,
      reason: candidateInventory.reason
    }))
  caseRecord.legacySafety = {
    sourceCounts,
    historicalCandidateInventory: candidateInventory,
    mutationRequests: 0,
    reconcileExecuted: false,
    blockers: [...legacySafetyBlocks],
    minimumPlan: [...legacyMinimumPlan]
  }
  caseRecord.notes.push(...legacySafetyBlocks, ...legacyMinimumPlan.map((item) => `最小正式方案：${item}`))
  caseRecord.evidence.push(
    '只执行 GET、页面只读加载及 READ ONLY 事务；逐行全字段哈希包含软删除记录，派生映射覆盖所有租户。' +
    '另对本机独立 cfor 数据库做只读候选盘点，但不切换数据源、不复制样本、不执行候选库 reconcile。' +
    '未执行 reconcile，未创建或改写旧设备来源，空清单不作为 CODE/SN/名称/多义/未命中或重建幂等证据。'
  )
  return { summary, sourceCounts }
}
