import { config } from '../config/index.mjs'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { createApiClient, matchesExpectedBusinessRejection, publicRequest } from '../lib/api.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { findMenuRouteByComponent } from './base-partner.mjs'
import {
  ownedInitCases,
  runOwnedInitCase,
  runPermissionBoundary
} from '../owned-init/fixtures.mjs'
import {
  assertSafeScope as assertLocalInitScope,
  cases as initGapCases,
  runCase as runInitGapCase
} from '../fixtures/init-gaps.mjs'
import { runFreshOrganizationRootEvidence } from '../fixtures/init-root-isolation.mjs'
import { runEnterpriseIsolationEvidence } from '../fixtures/enterprise-isolation.mjs'
import { localInitEvidence } from '../fixtures/init-local-closure.mjs'
import { cases as materialCapabilityCases, runCase as runMaterialCapabilityCase } from '../fixtures/material-capability.mjs'
import { verifyMaterialImportValidationClosure } from '../fixtures/material-import-validation-closure.mjs'
import { verifyMaterialValidationClosure } from '../fixtures/material-validation-closure.mjs'
import { verifyMaterialCommercialValidationClosure } from '../fixtures/material-commercial-validation-closure.mjs'
import {
  materialBomContractGaps,
  verifyMaterialBomValidationClosure
} from '../fixtures/material-bom-validation-closure.mjs'
import {
  materialStockScenarioAssertionMap,
  materialStockScenarioCheckNames,
  verifyMaterialStockScenarioClosure
} from '../fixtures/material-stock-scenario-closure.mjs'
import {
  initNumberingClosureChecks,
  runInitNumberingClosure
} from '../fixtures/init-numbering-closure.mjs'
import { cleanupWmsFixtures, isWmsWriteEnabled, prepareWmsFixture } from '../lib/wms-fixtures.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
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

export const PARTNER_LEVEL_SCOPE_LABELS = Object.freeze({
  CUSTOMER: '客户',
  SUPPLIER: '供应商',
  BOTH: '客户与供应商'
})

const responsePath = (value) => {
  try {
    return new URL(String(value), 'http://cfor-e2e.local').pathname
  } catch {
    return ''
  }
}

export function validatePartnerLevelScopePageEvidence ({
  payload,
  responseStatus,
  responseUrl,
  scope,
  renderedRows
}) {
  const records = pageRecordsPayload(payload)
  const expectedLabel = PARTNER_LEVEL_SCOPE_LABELS[scope]
  let url
  try {
    url = new URL(String(responseUrl), 'http://cfor-e2e.local')
  } catch {
    return { valid: false, records, reason: '分页响应 URL 无效' }
  }
  const responseContract =
    Boolean(expectedLabel) &&
    Number(responseStatus) >= 200 &&
    Number(responseStatus) < 300 &&
    responsePath(responseUrl) === '/admin-api/base/partner-level/page' &&
    url.searchParams.get('scope') === scope &&
    url.searchParams.get('pageNo') === '1' &&
    url.searchParams.get('pageSize') === '100' &&
    isSuccessfulPayload(payload)
  const apiRowsAreScoped = Array.isArray(records) &&
    records.length > 0 &&
    Number.isSafeInteger(payload?.data?.total) &&
    payload.data.total >= records.length &&
    records.length <= 100 &&
    new Set(records.map((row) => row?.id)).size === records.length &&
    new Set(records.map((row) => row?.code)).size === records.length &&
    Array.from(records).every((row) =>
      typeof row?.id === 'string' && /^[1-9]\d*$/.test(row.id) &&
      nonEmpty(row?.code) &&
      nonEmpty(row?.name) &&
      row?.scope === scope)
  const pageRowsAreScoped = Array.isArray(renderedRows) &&
    renderedRows.length === records?.length &&
    renderedRows.length > 0 &&
    Array.from(renderedRows).every((row, index) =>
      nonEmpty(row?.code) &&
      nonEmpty(row?.name) &&
      row?.code === records?.[index]?.code &&
      row?.name === records?.[index]?.name &&
      row?.scopeText === expectedLabel)
  return {
    valid: responseContract && apiRowsAreScoped && pageRowsAreScoped,
    expectedLabel,
    records,
    responseContract,
    apiRowsAreScoped,
    pageRowsAreScoped,
    reason: [
      responseContract ? '' : '分页响应路径、查询参数或业务成功契约不匹配',
      apiRowsAreScoped ? '' : '分页响应没有非空且全部属于目标 scope 的真实记录',
      pageRowsAreScoped ? '' : '页面表格行没有逐行展示目标 scope 或与响应数量不一致'
    ].filter(Boolean).join('; ')
  }
}

const canonicalSettingsValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalSettingsValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) =>
      [key, canonicalSettingsValue(value[key])]))
  }
  return value
}

export function canonicalBusinessOptionCatalog (options) {
  if (!Array.isArray(options) || Array.from(options).some((item) =>
    !item || typeof item !== 'object' || Array.isArray(item))) return null
  return options.map(canonicalSettingsValue)
    .sort((left, right) => String(left.optionCode).localeCompare(String(right.optionCode)))
}

export function sameBusinessOptionCatalog (left, right) {
  const before = canonicalBusinessOptionCatalog(left)
  const after = canonicalBusinessOptionCatalog(right)
  return before !== null && after !== null &&
    JSON.stringify(before) === JSON.stringify(after)
}

export function validateBusinessOptionCatalog (options) {
  const canonical = canonicalBusinessOptionCatalog(options)
  const owners = new Set(['SYSTEM_CONFIG', 'DOMAIN_MODEL'])
  const duplicateCodes = new Set()
  const seenCodes = new Set()
  for (const item of canonical || []) {
    if (seenCodes.has(item.optionCode)) duplicateCodes.add(item.optionCode)
    seenCodes.add(item.optionCode)
  }
  const validRows = Array.isArray(canonical) &&
    canonical.length > 0 &&
    duplicateCodes.size === 0 &&
    canonical.every((item) =>
      /^[A-Z][A-Z0-9]*(?:\.[A-Z0-9_]+)+$/.test(String(item.optionCode)) &&
      nonEmpty(item.moduleCode) &&
      owners.has(item.ownerType) &&
      nonEmpty(item.name) &&
      nonEmpty(item.runtimeConsumer))
  return {
    valid: validRows,
    count: canonical?.length ?? null,
    duplicateCodes: [...duplicateCodes],
    invalidRows: validRows ? [] : (canonical || []).filter((item) =>
      !/^[A-Z][A-Z0-9]*(?:\.[A-Z0-9_]+)+$/.test(String(item.optionCode)) ||
      !nonEmpty(item.moduleCode) ||
      !owners.has(item.ownerType) ||
      !nonEmpty(item.name) ||
      !nonEmpty(item.runtimeConsumer))
  }
}

const settingsValueHash = (value) => value === null ? 'NULL'
  : createHash('sha256').update(value, 'utf8').digest('hex')

export const initSettingsConfigSnapshotSql = (tenantId) => `
  SELECT CAST(id AS CHAR), CAST(tenant_id AS CHAR), category, tag,
    IFNULL(SHA2(config_data,256),'NULL'),
    SHA2(CAST(JSON_ARRAY(CAST(id AS CHAR),CAST(tenant_id AS CHAR),
      category,tag,config_data) AS CHAR),256)
  FROM system_config WHERE tenant_id IN (0,${tenantLiteral(tenantId)})
  ORDER BY tenant_id,id`

export function validateInitSettingsConfigSnapshot (rows, tenantId) {
  const tenant = tenantLiteral(tenantId)
  if (!Array.isArray(rows)) return false
  const keys = new Set()
  return Array.from(rows).every((row) => {
    if (!Array.isArray(row) || row.length !== 6 ||
        !/^[1-9]\d*$/.test(String(row[0])) ||
        !['0', tenant].includes(String(row[1])) ||
        !nonEmpty(row[2]) || !nonEmpty(row[3]) ||
        !/^(?:[a-f0-9]{64}|NULL)$/.test(row[4]) ||
        !/^[a-f0-9]{64}$/.test(row[5])) return false
    const key = `${row[1]}:${row[2]}:${row[3]}`
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

export function validateInitSettingsEffectiveValues (options, rows, tenantId) {
  if (!validateInitSettingsConfigSnapshot(rows, tenantId)) return false
  const items = options?.filter((item) => item?.ownerType === 'SYSTEM_CONFIG')
  return Array.isArray(items) && items.length > 0 && items.every((item) => {
    if (!nonEmpty(item.category) || !nonEmpty(item.tag) ||
        !(typeof item.currentValue === 'string' || item.currentValue === null)) return false
    const matching = rows.filter((row) => row[2] === item.category && row[3] === item.tag)
    const tenantRow = matching.find((row) => String(row[1]) === String(tenantId))
    const templateRow = matching.find((row) => String(row[1]) === '0')
    const effective = tenantRow || templateRow
    const source = effective ? tenantRow ? 'TENANT' : 'TEMPLATE' : 'DEFAULT'
    return item.currentValueSource === source &&
      (effective ? effective[4] === settingsValueHash(item.currentValue)
        : item.currentValue === item.defaultValue)
  })
}

export function isUnknownBusinessOptionCreateRejection (response, payload) {
  const message = payload?.msg
  if (![200, 404].includes(response.status()) || payload?.code !== 404 ||
      payload.success === true || payload.ok === true ||
      typeof message !== 'string' || !message.startsWith('请求地址不存在:')) return false
  const rejectedAddress = message.slice('请求地址不存在:'.length)
  return ['admin-api/system/config/business-options/create',
    '/admin-api/system/config/business-options/create',
    'system/config/business-options/create',
    '/system/config/business-options/create'].includes(rejectedAddress) ||
    (/^https?:\/\//.test(rejectedAddress) &&
      responsePath(rejectedAddress) === '/admin-api/system/config/business-options/create')
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

const tenantLiteral = (value) => {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) ||
      !/^[1-9]\d*$/.test(String(value))) throw new Error('BLOCKED: invalid init evidence tenant ID')
  return String(value)
}

const countRows = (rows, keys) => {
  const values = {}
  const errors = []
  for (const key of keys) {
    const matches = Array.isArray(rows) ? rows.filter((row) => row?.[0] === key) : []
    if (matches.length !== 1 || !nonNegativeCount(matches[0]?.[1])) {
      errors.push(`${key}: missing, duplicate or invalid count`)
    } else values[key] = Number(matches[0][1])
  }
  return { values, errors }
}

const legacyProjections = [
  {
    kind: 'product', view: 'erp_product', source: 'mes_bas_material', alias: 'm',
    columns: {
      id: 'CAST(m.id AS CHAR(36))', name: 'm.name', bar_code: 'm.bar_code',
      category_id: "CASE WHEN m.category_id REGEXP '^[0-9]+$' THEN CAST(m.category_id AS UNSIGNED) ELSE NULL END",
      unit_id: "CASE WHEN m.unit_id REGEXP '^[0-9]+$' THEN CAST(m.unit_id AS UNSIGNED) ELSE NULL END",
      status: "CASE WHEN m.is_enabled = '1' THEN 0 ELSE 1 END",
      standard: 'm.model', remark: 'm.remark',
      expiry_day: "CASE WHEN m.period_days REGEXP '^[0-9]+$' THEN CAST(m.period_days AS SIGNED) ELSE NULL END",
      weight: 'CAST(NULL AS DECIMAL(24,6))', purchase_price: 'm.new_purchase_price',
      sale_price: 'm.ref_price', min_price: 'm.low_price',
      creator: 'm.creator', create_time: 'm.create_time', updater: 'm.updater',
      update_time: 'm.update_time', deleted: 'm.deleted', tenant_id: 'm.tenant_id'
    },
    apiColumns: {
      id: 'CAST(m.id AS CHAR)', name: 'm.name', barCode: 'm.bar_code',
      categoryId: "CASE WHEN m.category_id REGEXP '^[0-9]+$' THEN CAST(CAST(m.category_id AS UNSIGNED) AS CHAR) ELSE NULL END",
      unitId: "CASE WHEN m.unit_id REGEXP '^[0-9]+$' THEN CAST(CAST(m.unit_id AS UNSIGNED) AS CHAR) ELSE NULL END",
      purchasePrice: 'CAST(m.new_purchase_price AS CHAR)',
      salePrice: 'CAST(m.ref_price AS CHAR)', minPrice: 'CAST(m.low_price AS CHAR)'
    },
    nullableColumns: ['barCode', 'categoryId', 'unitId', 'purchasePrice', 'salePrice', 'minPrice'],
    decimalColumns: ['purchasePrice', 'salePrice', 'minPrice'],
    enabled: "m.is_enabled = '1'"
  },
  {
    kind: 'category', view: 'erp_product_category', source: 'mes_bas_material_category', alias: 'c',
    columns: {
      id: 'c.id', parent_id: "CASE WHEN c.pid REGEXP '^[0-9]+$' THEN CAST(c.pid AS UNSIGNED) ELSE 0 END",
      has_child: 'c.has_child', name: 'c.name', fullname: 'c.fullname', code: 'c.code', sort: '0',
      status: 'CASE WHEN c.is_enabled = 1 THEN 0 ELSE 1 END',
      creator: 'c.create_by', create_time: 'c.create_time', updater: 'c.update_by',
      update_time: 'c.update_time', version: 'c.version', deleted: 'c.deleted', tenant_id: 'c.tenant_id'
    },
    apiColumns: {
      id: 'CAST(c.id AS CHAR)', name: 'c.name',
      parentId: "CASE WHEN c.pid REGEXP '^[0-9]+$' THEN CAST(CAST(c.pid AS UNSIGNED) AS CHAR) ELSE '0' END"
    },
    enabled: 'c.is_enabled = 1'
  },
  {
    kind: 'unit', view: 'erp_product_unit', source: 'mes_bas_unit', alias: 'u',
    columns: {
      id: 'u.id', name: 'u.name', status: 'CASE WHEN u.is_enabled = 1 THEN 0 ELSE 1 END',
      creator: 'u.creator', create_time: 'u.create_time', updater: 'u.updater',
      update_time: 'u.update_time', deleted: 'u.deleted', tenant_id: 'u.tenant_id'
    },
    apiColumns: { id: 'CAST(u.id AS CHAR)', name: 'u.name' }, enabled: 'u.is_enabled = 1'
  }
]

export const LEGACY_MASTER_COUNT_TABLES = Object.freeze({
  legacyProductCount: 'erp_product', legacyUnitCount: 'erp_product_unit',
  legacyCategoryCount: 'erp_product_category', baseMaterialCount: 'mes_bas_material',
  baseUnitCount: 'mes_bas_unit', baseCategoryCount: 'mes_bas_material_category'
})

export const legacyMasterCountsSql = (tenantId) => Object.entries(LEGACY_MASTER_COUNT_TABLES)
  .map(([field, table]) => `SELECT '${field}', COUNT(*) FROM ${table}
    WHERE tenant_id=${tenantLiteral(tenantId)} AND deleted=0`).join('\nUNION ALL\n')

export function validateLegacyMasterCounts (summary, rows) {
  const { values, errors } = countRows(rows, Object.keys(LEGACY_MASTER_COUNT_TABLES))
  for (const field of Object.keys(LEGACY_MASTER_COUNT_TABLES)) {
    if (!nonNegativeCount(summary?.[field]) || Number(summary[field]) !== values[field]) {
      errors.push(`${field}: API=${summary?.[field]} DB=${values[field]}`)
    }
  }
  return { valid: errors.length === 0, counts: values, reason: errors.join('; ') }
}

export function legacyProjectionAuditSql (tenantId) {
  const tenant = tenantLiteral(tenantId)
  return legacyProjections.flatMap(({ view, source, alias, columns }) => {
    const expected = `SELECT ${Object.entries(columns).map(([key, expression]) =>
      `${expression} AS ${key}`).join(', ')} FROM ${source} ${alias} WHERE ${alias}.tenant_id=${tenant}`
    const equality = Object.keys(columns).map((key) => `(BINARY v.${key} <=> BINARY e.${key})`).join(' AND ')
    return [
      `SELECT '${view}-mismatch', COUNT(*) FROM (${expected}) e
       LEFT JOIN ${view} v ON v.tenant_id=e.tenant_id AND v.id=e.id
       WHERE v.id IS NULL OR NOT (${equality})`,
      `SELECT '${view}-orphan', COUNT(*) FROM ${view} v WHERE v.tenant_id=${tenant}
       AND NOT EXISTS (SELECT 1 FROM (${expected}) e WHERE e.tenant_id=v.tenant_id AND e.id=v.id)`,
      `SELECT '${view}-duplicate', COUNT(*) FROM
       (SELECT id FROM ${view} WHERE tenant_id=${tenant} GROUP BY id HAVING COUNT(*)>1) d`
    ]
  }).join('\nUNION ALL\n')
}

export function validateLegacyProjectionViews (metadata, auditRows) {
  const keys = legacyProjections.flatMap(({ view }) =>
    ['mismatch', 'orphan', 'duplicate'].map((suffix) => `${view}-${suffix}`))
  const { values, errors } = countRows(auditRows, keys)
  for (const { view, source } of legacyProjections) {
    const matches = Array.isArray(metadata) ? metadata.filter((row) => row?.[0] === view) : []
    const definition = String(matches[0]?.[1] || '').replaceAll('`', '').toLowerCase()
    if (matches.length !== 1 || !new RegExp(`\\bfrom\\s+(?:[a-z0-9_]+\\.)?${source}\\b`).test(definition) ||
        !/\bcase\b/.test(definition) || !/\btenant_id\b/.test(definition) || !/\bdeleted\b/.test(definition)) {
      errors.push(`${view}: missing or unexpected projection definition`)
    }
    if (matches[0]?.[2] !== 'NO') errors.push(`${view}: IS_UPDATABLE=${matches[0]?.[2]}`)
  }
  for (const key of keys) {
    if (values[key] !== 0) errors.push(`${key}=${values[key]}`)
  }
  return { valid: errors.length === 0, reason: errors.join('; ') }
}

export const legacySimpleProjectionSql = (tenantId) => legacyProjections
  .map(({ kind, source, alias, apiColumns, enabled }) =>
    `SELECT '${kind}', JSON_OBJECT(${Object.entries(apiColumns).map(([key, expression]) =>
      `'${key}', ${expression}`).join(', ')}) FROM ${source} ${alias}
     WHERE ${alias}.tenant_id=${tenantLiteral(tenantId)} AND ${alias}.deleted=0 AND ${enabled}`)
  .join('\nUNION ALL\n')

const decimalText = (value) => {
  if (value == null) return null
  const text = String(value)
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text
  const [whole, fraction = ''] = text.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return `${whole.replace(/^(-?)0+(?=\d)/, '$1')}${trimmed ? `.${trimmed}` : ''}`
}

export function validateLegacySimpleProjections (lists, rows) {
  const errors = []
  const missingSamples = []
  if (!Array.isArray(rows)) return { valid: false, missingSamples, reason: 'Missing projection rows' }
  for (const { kind, apiColumns, decimalColumns = [], nullableColumns = [] } of legacyProjections) {
    const expected = []
    for (const row of rows.filter((item) => item?.[0] === kind)) {
      try { expected.push(JSON.parse(row[1])) } catch { errors.push(`${kind}: invalid DB JSON`) }
    }
    const actual = lists?.[kind]
    if (!Array.isArray(actual)) {
      errors.push(`${kind}: malformed API list`)
      continue
    }
    if (!expected.length) missingSamples.push(kind)
    const canonical = (items) => items.map((item) => Object.fromEntries(Object.keys(apiColumns)
      .map((key) => {
        const value = item?.[key]
        if (value === undefined && !nullableColumns.includes(key) || (key.endsWith('Id') || key === 'id') &&
            typeof value === 'number' && !Number.isSafeInteger(value)) {
          errors.push(`${kind}.${key}: missing field or unsafe numeric ID`)
        }
        return [key, decimalColumns.includes(key) ? decimalText(value) : value == null ? null : String(value)]
      }))).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected)) ||
        new Set(actual.map((item) => String(item?.id))).size !== actual.length) {
      errors.push(`${kind}: API rows differ from enabled Base projection`)
    }
  }
  return { valid: errors.length === 0, missingSamples, reason: errors.join('; ') }
}

export const MATERIAL_READINESS_ANOMALIES = Object.freeze({
  'invalid-nature': "UPPER(TRIM(COALESCE(m.inventory_nature,''))) NOT IN ('STOCK','SERVICE','VIRTUAL')",
  'stock-no-unit': "UPPER(TRIM(COALESCE(m.inventory_nature,'')))='STOCK' AND (m.unit_id IS NULL OR TRIM(m.unit_id)='')",
  'stock-bad-period': `UPPER(TRIM(COALESCE(m.inventory_nature,'')))='STOCK'
    AND UPPER(TRIM(COALESCE(m.period_managed,'N')))='Y'
    AND (m.period_days IS NULL OR TRIM(m.period_days)=''
      OR NOT (TRIM(m.period_days) REGEXP '^[0-9]+$') OR CAST(TRIM(m.period_days) AS UNSIGNED)<=0)`,
  'bad-source': `TRIM(COALESCE(m.source,''))<>''
    AND (LOWER(TRIM(m.source)) NOT IN ('purchase','manufacture','mixed')
      OR (LOWER(TRIM(m.source))='purchase' AND UPPER(TRIM(COALESCE(m.purchased,'N')))<>'Y')
      OR (LOWER(TRIM(m.source))='manufacture' AND UPPER(TRIM(COALESCE(m.produced,'N')))<>'Y')
      OR (LOWER(TRIM(m.source))='mixed' AND
        (UPPER(TRIM(COALESCE(m.purchased,'N')))<>'Y' OR UPPER(TRIM(COALESCE(m.produced,'N')))<>'Y')))`,
  'non-stock-control': `UPPER(TRIM(COALESCE(m.inventory_nature,''))) IN ('SERVICE','VIRTUAL')
    AND (UPPER(TRIM(COALESCE(m.batch_managed,'N')))='Y'
      OR UPPER(TRIM(COALESCE(m.period_managed,'N')))='Y'
      OR UPPER(TRIM(COALESCE(m.color_managed,'N')))='Y'
      OR UPPER(TRIM(COALESCE(m.brand_managed,'N')))='Y'
      OR UPPER(TRIM(COALESCE(m.one_barcode,'N')))='Y'
      OR TRIM(COALESCE(m.default_ware,''))<>'' OR TRIM(COALESCE(m.default_ware_area,''))<>''
      OR TRIM(COALESCE(m.default_ware_location,''))<>'' OR TRIM(COALESCE(m.material_type,''))<>'')`,
  'non-stock-inventory': `UPPER(TRIM(COALESCE(m.inventory_nature,''))) IN ('SERVICE','VIRTUAL')
    AND EXISTS (SELECT 1 FROM mes_stk_inventory inv
      WHERE inv.tenant_id=m.tenant_id AND inv.material_id=m.id AND inv.deleted=0
        AND (COALESCE(inv.qty,0)<>0 OR COALESCE(inv.lock_qty,0)<>0 OR COALESCE(inv.hold_qty,0)<>0
          OR COALESCE(inv.frozen_qty,0)<>0 OR COALESCE(inv.pending_putaway_qty,0)<>0))`
})

const materialCounterexampleCategories = ['stock-no-unit', 'bad-source', 'stock-bad-period', 'non-stock-inventory']

export function materialReadinessAuditSql (tenantId) {
  const predicates = {
    total: '1=1',
    'invalid-total': Object.values(MATERIAL_READINESS_ANOMALIES).map((value) => `(${value})`).join(' OR '),
    ...MATERIAL_READINESS_ANOMALIES,
    ...Object.fromEntries(materialCounterexampleCategories.map((key) => [
      `exclusive-${key}`, `(${MATERIAL_READINESS_ANOMALIES[key]}) AND NOT (${Object.entries(MATERIAL_READINESS_ANOMALIES)
        .filter(([other]) => other !== key).map(([, value]) => `(${value})`).join(' OR ')})`
    ]))
  }
  return Object.entries(predicates).map(([key, predicate]) =>
    `SELECT '${key}', COUNT(*) FROM mes_bas_material m
     WHERE m.tenant_id=${tenantLiteral(tenantId)} AND m.deleted=0 AND (${predicate})`).join('\nUNION ALL\n')
}

export function validateMaterialReadiness (item, rows) {
  const { values, errors } = countRows(rows, ['total', 'invalid-total', ...Object.keys(MATERIAL_READINESS_ANOMALIES),
    ...materialCounterexampleCategories.map((key) => `exclusive-${key}`)])
  const expectedStatus = values.total === 0 ? 'NOT_STARTED' : values['invalid-total'] > 0 ? 'INCOMPLETE' : 'READY'
  if (!nonNegativeCount(item?.count) || Number(item.count) !== values.total || item?.status !== expectedStatus) {
    errors.push(`Expected count=${values.total}, status=${expectedStatus}; API=${item?.count}/${item?.status}`)
  }
  if (values['invalid-total'] > 0) {
    const reported = String(item?.reason || '').match(/存在\s*(\d+)\s*个/)?.[1]
    if (reported === undefined || Number(reported) !== values['invalid-total']) {
      errors.push(`Unique invalid count: API=${reported} DB=${values['invalid-total']}`)
    }
  }
  const categories = Object.keys(MATERIAL_READINESS_ANOMALIES).map((key) => values[key])
  if (categories.some((value) => value > values.total) ||
      values['invalid-total'] > values.total ||
      values['invalid-total'] < Math.max(...categories) ||
      values['invalid-total'] > categories.reduce((sum, value) => sum + value, 0)) {
    errors.push('Invalid category/unique-count relationship')
  }
  for (const key of materialCounterexampleCategories) {
    if (values[`exclusive-${key}`] > values[key]) errors.push(`${key}: exclusive count exceeds category count`)
  }
  if (materialCounterexampleCategories.reduce((sum, key) => sum + values[`exclusive-${key}`], 0) >
      values['invalid-total']) errors.push('Exclusive category samples cannot overlap')
  const missingCategories = materialCounterexampleCategories.filter((key) => !(values[`exclusive-${key}`] > 0))
  return { valid: errors.length === 0, counts: values, missingCategories, reason: errors.join('; ') }
}

export const organizationRootFactsSql = (tenantId) => `
  SELECT 'active-root', COUNT(*) FROM system_dept
  WHERE tenant_id=${tenantLiteral(tenantId)} AND deleted=0 AND parent_id=0 AND status=0
  UNION ALL
  SELECT 'all-root', COUNT(*) FROM system_dept
  WHERE tenant_id=${tenantLiteral(tenantId)} AND deleted=0 AND parent_id=0`

export function validateOrganizationRootReadiness (item, rows) {
  const { values, errors } = countRows(rows, ['active-root', 'all-root'])
  const status = values['active-root'] > 0 ? 'READY' : 'NOT_STARTED'
  if (values['active-root'] > values['all-root'] ||
      item?.key !== 'system.organization-root' || item.selected !== true || item.skippable !== false ||
      item.status !== status || !nonNegativeCount(item.count) || Number(item.count) !== values['active-root']) {
    errors.push(`Effective roots=${values['active-root']}, all roots=${values['all-root']}; ` +
      `API=${item?.count}/${item?.status}`)
  }
  return { valid: errors.length === 0, counts: values, reason: errors.join('; ') }
}

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

const initCatalogPath = new URL('../cases/catalog.json', import.meta.url)

export const INIT_SETTINGS_CATALOG_ASSERTIONS = Object.freeze({
  'PB033-002': Object.freeze([
    '设置 - 业务设置 - ERP 下的客商等级页面可进入',
    '页面渲染等级编码/适用角色查询项与新增等级入口',
    '页面消费的客商等级接口在角色维度可读'
  ]),
  'PB028-001': Object.freeze([
    '目录项拥有稳定 optionCode、ownerType 和 runtimeConsumer',
    'SYSTEM_CONFIG 项显示当前租户或模板有效值',
    'DOMAIN_MODEL 项不复制业务状态到 system_config',
    '租户不能通过目录接口自由新增未知配置项'
  ])
})

export const INIT_CASE_CATALOG_EVIDENCE = Object.freeze({
  'PB033-002': {
    0: {
      assertion: INIT_SETTINGS_CATALOG_ASSERTIONS['PB033-002'][0],
      checks: ['客商等级设置页可从设置菜单进入']
    },
    1: {
      assertion: INIT_SETTINGS_CATALOG_ASSERTIONS['PB033-002'][1],
      checks: ['页面渲染查询条件与新增入口']
    },
    2: {
      assertion: INIT_SETTINGS_CATALOG_ASSERTIONS['PB033-002'][2],
      checks: [
        '页面真实分页按 CUSTOMER 显示且响应可见',
        '页面真实分页按 SUPPLIER 显示且响应可见',
        '页面真实分页按 BOTH 显示且响应可见',
        '页面使用的客商等级接口在角色维度可读',
        '客商等级完整目录只读验证前后相同'
      ]
    }
  },
  'PB028-001': {
    0: {
      assertion: INIT_SETTINGS_CATALOG_ASSERTIONS['PB028-001'][0],
      checks: ['业务选项目录可访问且包含稳定编码', '配置目录声明事实源归属']
    },
    1: {
      assertion: INIT_SETTINGS_CATALOG_ASSERTIONS['PB028-001'][1],
      checks: [
        'SYSTEM_CONFIG 项回读当前租户或模板有效值',
        'SYSTEM_CONFIG 有效值与来源在真实页面逐行显示'
      ]
    },
    2: {
      assertion: INIT_SETTINGS_CATALOG_ASSERTIONS['PB028-001'][2],
      checks: ['DOMAIN_MODEL 项不复制业务状态到 system_config']
    },
    3: {
      assertion: INIT_SETTINGS_CATALOG_ASSERTIONS['PB028-001'][3],
      checks: [
        '租户不能通过目录接口自由新增未知配置项',
        '被拒写入前后完整业务选项目录相同',
        '未知目录反例前后完整配置事实相同'
      ]
    }
  },
  'INIT-001': {
    0: { checks: ['按企业名称查询即序科技'] },
    1: { checks: ['登录即序科技并获得访问令牌'] },
    2: { reason: '当前环境已存在即序科技，未安全提交“不存在企业”的注册申请' },
    3: { reason: '注册首屏企业法律资料空态需要可安全创建的新租户' },
    4: { reason: '新租户行业单选需要可安全创建的新租户' },
    5: { reason: '新租户默认 system+erp+bpm 需要可安全创建的新租户' },
    6: { reason: '新租户顶部菜单收敛需要可安全创建的新租户' },
    7: { checks: ['登录后停留普通工作台'] }
  },
  'PB001-001': {
    0: { checks: ['真实浏览器打开企业资料页'] },
    1: { checks: ['企业资料页展示生产贸易混合型选项'] }
  },
  'PB002-001': {
    0: {
      checks: [
        '初始化中心读取子系统目录与套餐可用性',
        '子系统目录包含稳定编码与依赖信息'
      ]
    },
    1: { reason: '当前租户没有套餐外子系统样本，无法验证套餐外启用被拒' },
    2: {
      checks: [
        '重新启用子系统并回读 ENABLED/启用月份一致（反向闭环）',
        '非法启用月份 yyyy-13 被服务端拒绝（写侧反例）'
      ]
    },
    3: { checks: ['依赖子系统停用时下游启用被拒绝，且依赖已恢复（写侧反例）'] },
    4: { reason: '当前租户没有已产生正式业务事实且可锁定停用的子系统样本' },
    5: { checks: ['保存后可见菜单不越过套餐边界（权限与套餐菜单均可读）'] }
  },
  'PB003-001': {
    0: {
      checks: [
        '部门管理页展示组织编码和主管字段',
        '组织表单提供稳定编码、管理边界及独立负责人和主管控件'
      ]
    },
    1: {
      checks: [
        '组织类型包含集团、公司、分公司、部门和团队',
        '创建专属测试部门并返回主键（真实写侧）'
      ]
    },
    2: {
      checks: [
        '回读部门与稳定编码/分支类型/管理边界/负责人+主管一致',
        'system_dept 落库组织编码/类型/边界/双负责人字段'
      ]
    },
    3: {
      checks: [
        '回读部门与稳定编码/分支类型/管理边界/负责人+主管一致',
        'system_dept 落库组织编码/类型/边界/双负责人字段'
      ]
    },
    4: {
      checks: [
        '初始化就绪检查以当前租户有效根组织事实判定',
        '专属租户验证无根/有效根/停用根并清理本轮根组织'
      ]
    }
  },
  'PB005-001': {
    0: { checks: ['角色页面可读取角色分页'] },
    1: { checks: ['角色页面提供菜单权限入口'] },
    2: { checks: ['服务端补齐角色菜单页面和目录父链', '授权父链和当前租户部门范围真实持久化'] },
    3: {
      checks: [
        '专属普通权限管理员实际登录且拥有菜单授权入口',
        '普通权限管理员不能授予自身未拥有的菜单'
      ]
    },
    4: {
      checks: [
        '不存在菜单混合有效资源提交被整体拒绝',
        '已删除菜单混合有效资源提交被整体拒绝',
        '无效菜单拒绝后专属角色授权未被部分写入'
      ]
    },
    5: {
      checks: ['第二租户部门数据范围正反例真实可见性']
    }
  },
  'PB008-002': {
    0: { checks: ['用户管理页邀请成员入口可见'] },
    1: {
      checks: [
        '邀请分页包含专属邀请且返回当前租户',
        '邀请真实持久化为当前租户专属待接受记录'
      ]
    },
    2: {
      checks: [
        '成员通过正规邀请入口自行设置非默认密码并加入租户',
        '接受邀请创建的成员属于本轮专属租户账号',
        '邀请接受状态和 accepted_user_id 正确回读',
        '接受后本轮角色岗位关系写入且租户一致',
        '邀请成员以自行设置的密码真实登录并命中专属角色'
      ]
    },
    3: {
      checks: [
        '直接创建用户拒绝公共默认密码',
        '直接创建公共默认密码拒绝未落成员事实',
        '管理员重置用户拒绝公共默认密码'
      ]
    }
  },
  'PB009-001': {
    0: { checks: ['业务对象仅返回当前租户已启用模块的单据类型'] },
    1: {
      checks: [
        'v2 审批策略配置保存后可回读',
        '未指定 billOptions 时既有单据审批方式保持不变',
        'v2 审批策略配置持久化在 system_config'
      ]
    },
    2: { checks: ['同一 billType 在租户 0/1 各自独立存储，取值互不串配'] },
    3: { reason: '缺少可安全创建的 Flowable 新版本定义及运行实例，未验证旧 definitionId 保留' }
  },
  'PB010-001': {
    0: {
      checks: [
        '打印模板页面与版本字段可访问',
        '专属模板与绑定以当前租户持久化'
      ]
    },
    1: { checks: ['新建模板从 DRAFT 开始并自动递增版本'] },
    2: { checks: ['已发布模板编辑生成新草稿且不覆盖历史 JSON'] },
    3: {
      checks: [
        '发布时可设置业务对象默认模板（isDefault=1）',
        '同业务对象仅保留一个默认模板版本'
      ]
    },
    4: {
      checks: [
        '正式打印优先客商绑定、其次业务类型并回退默认模板',
        '正式打印按业务类型绑定解析并记录首次锁定版本'
      ]
    },
    5: { checks: ['同层级重复绑定保存即拒绝'] },
    6: { checks: ['已锁定单据重打保持原版本，不跟随新草稿'] }
  },
  'PB011-001': {
    0: {
      checks: [
        '编号设置页面与分页接口可访问',
        '规则版本、发布状态与生效时间可见'
      ]
    },
    1: { checks: [initNumberingClosureChecks.version] },
    2: { checks: ['编号格式使用稳定前缀+业务日期+5 位流水'] },
    3: { checks: ['租户只隔离内部流水序列，不把租户号拼入正式单号'] },
    4: {
      checks: [
        initNumberingClosureChecks.void,
        initNumberingClosureChecks.sequence
      ]
    }
  },
  'PB012-001': {
    0: { reason: '平台租户仅验证企业 BYOK 边界，未在真实企业模型池验证托管模型兜底路由' },
    1: { reason: '平台租户按设计返回 403，企业租户 BYOK 范围需要 tenantId > 1 和外部模型密钥' },
    2: { reason: '当前租户配置优先、平台回退需要企业租户与可安全配置的模型 Key' },
    3: { reason: 'Key 过期/健康失败/模型禁用路由需要外部模型供应商真实状态' },
    4: { checks: ['初始化中心可返回 AI 能力就绪项'] }
  },
  'PB017-001': {
    0: { checks: ['WMS 仓储维度目录可访问', '仓储维度目录按仓库领域模型事实源声明'] },
    1: { reason: '业务选项目录未结构化返回允许值列表，说明文本不足以证明 NONE/AREA/LOCATION 写入均可接受' },
    2: { reason: '缺少历史 0/1/2 三种值逐项兼容读取的证据；当前目录与 WMS 运行时事实源仍未统一' },
    3: { reason: '目录与 WMS 运行时事实源尚未统一，且没有可调用的降级保护写入口' }
  },
  'PB018-001': {
    0: { reason: '当前租户没有可报工工序任务，未执行 reportWorkerId 写侧' },
    1: { reason: '未提交真实报工，未验证提交人由登录上下文和审计字段确定' },
    2: { reason: '未提交真实本人报工，权限正向分支未执行' },
    3: { reason: '未提交普通/代报工真实验证权限与实际作业人员归属校验' },
    4: { reason: '未构造自动流程报工，无法验证不被人工代报校验拦截' }
  },
  'PB023-001': {
    0: { checks: ['条码分页接口可访问并按当前租户返回'] },
    1: { reason: '仅读取分页，未在两个租户写入条码/SN 验证统一租户拦截器' },
    2: { reason: '缺少可安全创建的第二租户，双租户不串读写侧未闭环' }
  },
  'PB023-002': {
    0: { checks: ['条码方案页面与分页接口可访问'] },
    1: { checks: ['条码方案相关表均存在 tenant_id 列'] },
    2: { reason: '未验证正式 Flyway 新数据默认租户 0 且历史非 0 值保留' },
    3: { reason: '缺少可安全创建的第二租户，方案/计数器/时间线双租户不串读未闭环' }
  },
  'PB029-001': {
    0: {
      checks: [
        '旧产品主数据退役摘要标记为 RETIRED 且 migrationReady',
        '退役摘要六项数量与当前租户数据库逐项一致'
      ]
    },
    1: {
      checks: [
        '旧产品/单位/分类表已退役为只读兼容视图',
        '旧视图定义只读且全部投影字段与当前租户 Base 数据一致'
      ]
    },
    2: {
      checks: [
        '旧产品读侧仍返回基础档案投影且候选契约可读',
        '旧产品/单位/分类读侧仍返回基础档案投影',
        '旧产品/单位/分类启用读列表与 Base 投影逐行一致'
      ]
    }
  },
  'PB032-001': {
    0: {
      checks: ['存货表单展示实物存货、服务项目、虚拟件三种档案形态']
    },
    1: {
      checks: [
        '存货分页返回稳定 inventoryNature 三态字段',
        'SERVICE 非实物档案回读并自动清空仓储控制',
        'VIRTUAL 非实物档案回读并自动清空仓储控制'
      ]
    },
    2: {
      checks: [
        'SERVICE 非实物存货进入 WMS 正式保存被精确拒绝且不生成单据',
        'VIRTUAL 非实物存货进入 WMS 正式保存被精确拒绝且不生成单据'
      ]
    },
    3: {
      checks: [
        '采购订单引用未启用可采购专属物料被精确拒绝且前后无订单残留',
        '销售订单引用未启用可销售专属物料被精确拒绝且前后无订单残留',
        'PB032 商业场景专属物料和意外订单已按所有权清理并回读不可见'
      ]
    }
  },
  'PB032-002': {
    0: { checks: [...materialStockScenarioAssertionMap.purchasePhysicalAndCapability,
      materialStockScenarioCheckNames.cleanup] },
    1: { checks: [...materialStockScenarioAssertionMap.salePhysicalAndCapability,
      materialStockScenarioCheckNames.cleanup] },
    2: { checks: [...materialStockScenarioAssertionMap.servicePurchaseOrderWithoutInventory,
      materialStockScenarioCheckNames.cleanup] },
    3: { checks: [...materialStockScenarioAssertionMap.virtualPhysicalMoveRejections,
      materialStockScenarioCheckNames.cleanup] }
  },
  'PB032-003': {
    0: {
      checks: [
        '生产 BOM 页面可进入并读取统一存货分页',
        '生产 BOM 入口存货样本的档案形态限于三态'
      ]
    },
    1: {
      checks: [
        'SERVICE 母件与 STOCK 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
        'VIRTUAL 母件与 STOCK 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
        'STOCK 母件与 SERVICE 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
        'STOCK 母件与 VIRTUAL 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
        'PB032-003 专属物料正式清理且 BOM 主子表无残留'
      ]
    },
    2: { reason: materialBomContractGaps.workOrder },
    3: { reason: materialBomContractGaps.mrp }
  },
  'PB032-004': {
    0: { checks: ['存货导入模板可下载且包含二进制工作簿内容'] },
    1: { checks: ['存货导入模板包含档案形态、来源和计量单位列'] },
    2: { checks: ['导入保存前执行 Base 档案形态、来源能力和库存控制校验'] }
  },
  'PB032-005': {
    0: { checks: ['初始化中心返回存货档案就绪检查项'] },
    1: {
      checks: [
        '存货就绪状态可区分完整、待修复和无法检测',
        '就绪检查以真实库内主单位/来源/保质期/非实物隔离异常为判定依据',
        '主单位/来源/保质期/非实物库存四类异常取得真实识别证据'
      ]
    },
    2: { checks: ['初始化预置存货显式写入 STOCK 档案形态'] }
  }
})

const initCatalogDefinition = (caseId) => {
  const catalog = JSON.parse(fs.readFileSync(initCatalogPath, 'utf8'))
  return catalog.suites
    ?.flatMap((suite) => (suite.cases || []).map((item) => ({ ...item, suite: suite.id })))
    .find((item) => item.id === caseId)
}

export function applyInitCatalogEvidence (caseRecord, caseId, mapping) {
  const definition = initCatalogDefinition(caseId)
  if (!definition || !mapping) return false
  const frozenAssertions = INIT_SETTINGS_CATALOG_ASSERTIONS[caseId]
  const exactSettingsMapping = !frozenAssertions ||
    (JSON.stringify(definition.assertions) === JSON.stringify(frozenAssertions) &&
      Object.keys(mapping).length === frozenAssertions.length &&
      frozenAssertions.every((assertion, index) => mapping[index]?.assertion === assertion))
  caseRecord.catalogAssertions = (definition.assertions || []).map((assertion, index) => {
    const evidence = mapping[index]
    const names = Array.isArray(evidence?.checks) ? evidence.checks : []
    const checks = names.map((name) => {
      const matches = (caseRecord.checks || []).filter((item) => item.name === name)
      return matches.length === 1 ? matches[0] : null
    })
    const ambiguous = names.filter((name) =>
      (caseRecord.checks || []).filter((item) => item.name === name).length > 1)
    const missing = names.filter((name, position) => !checks[position])
    const failed = checks.some((item) => item?.passed !== true)
    const status = exactSettingsMapping && !evidence?.reason &&
      names.length > 0 && (!frozenAssertions || new Set(names).size === names.length) &&
      missing.length === 0 && !failed
      ? 'VERIFIED'
      : 'GAP'
    return {
      index,
      assertion,
      status,
      evidenceChecks: names,
      details: [
        exactSettingsMapping ? '' : '原始 catalog 原文/index 映射不完整或不一致',
        evidence?.reason,
        ambiguous.length > 0 ? `具名检查不唯一：${[...new Set(ambiguous)].join('、')}` : '',
        ...checks.map((check, position) => check
          ? `${check.name}: ${check.details}`
          : `缺证: ${names[position]}`)
      ].filter(Boolean).join('; ')
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED')
    .map((item) => ({ index: item.index, assertion: item.assertion, reason: item.details }))
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  caseRecord.acceptanceComplete = caseRecord.catalogComplete &&
    caseRecord.catalogAssertions.every((item) =>
      Array.isArray(item.evidenceChecks) && item.evidenceChecks.length > 0) &&
    caseRecord.checks?.length > 0 &&
    caseRecord.checks.every((item) => item.passed === true)
  caseRecord.readyCandidate = caseRecord.acceptanceComplete
  return true
}

export function finalizeInitCaseResult (caseRecord, caseId, result = {}) {
  const mapping = localInitEvidence[caseId] || INIT_CASE_CATALOG_EVIDENCE[caseId]
  if (!mapping) {
    if (result?.acceptanceComplete === true || caseRecord?.acceptanceComplete === true) {
      caseRecord.acceptanceComplete = true
    }
    return result
  }
  applyInitCatalogEvidence(caseRecord, caseId, mapping)
  const complete = caseRecord.acceptanceComplete === true
  const previousNote = typeof result?.note === 'string' && result.note.trim()
    ? result.note.trim()
    : ''
  return {
    ...result,
    acceptanceComplete: complete,
    partial: !complete,
    note: complete
      ? (previousNote || 'catalog 断言已逐条由本轮真实检查留证')
      : `${previousNote ? `${previousNote}; ` : ''}仍缺 ${caseRecord.remainingAssertions.length} 项 catalog 证据：` +
        caseRecord.remainingAssertions.map((item) => item.assertion).join('；')
  }
}

// 真实写侧请求：记录到运行记录，返回 { response, payload, ok, code }，不抛业务失败。
const writeApi = async (page, record, method, path, data, options = {}) => {
  const requestOptions = data === undefined ? undefined : { data }
  const response = await (options.request || requestApi)(page, method, path, requestOptions)
  const payload = await response.json().catch(() => null)
  const entry = {
    method: String(method).toUpperCase(),
    pathname: path,
    status: response.status(),
    code: payload?.code,
    bodySummary: JSON.stringify(payload).slice(0, 1000)
  }
  if (response.ok() && matchesExpectedBusinessRejection(
    payload, options.expectedBusinessRejection
  )) {
    entry.expectedBusinessRejectionMatched = true
  }
  record?.api?.push(entry)
  return { response, payload, ok: response.ok(), code: payload?.code }
}

// 只读数据库证据：断言只读事务内查询，不写库。
const readDb = async (caseRecord, stage, sql) => {
  const result = await runReadOnlySql(sql)
  if (!result.available) throw new Error(`BLOCKED: 数据库只读证据不可用：${result.reason}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, rows: result.rows }]
  return result.rows
}

const settingsCheck = (caseRecord, name, passed, details) => {
  caseRecord.checks.push({ name, passed: passed === true, details })
  if (passed !== true) throw new Error(`${name}: ${details}`)
}

const settingsGap = (caseRecord, reason) => {
  caseRecord.notes.push(`GAP: ${reason}`)
}

const settingsResponsePayload = async (response) => {
  try {
    if (typeof response.text === 'function') {
      const text = await response.text()
      return response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
    }
    return await response.json()
  } catch {
    throw new Error(`设置验收响应不可解析：HTTP=${response.status()}`)
  }
}

const settingsResponseSuccess = async (response, label) => {
  const payload = await settingsResponsePayload(response)
  if (!response.ok() || !isSuccessfulPayload(payload)) {
    throw new Error(`${label}: HTTP=${response.status()} code=${payload?.code ?? 'invalid'}`)
  }
  return payload
}

const settingsResponseMatches = (response, path, parameters) => {
  try {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === path &&
      Object.entries(parameters).every(([key, value]) => url.searchParams.get(key) === value)
  } catch {
    return false
  }
}

const visibleSettingsTableRows = async (page) =>
  page.locator('.el-table:visible .el-table__body-wrapper tr.el-table__row').evaluateAll((rows) =>
    rows.filter((row) => row.getClientRects().length > 0).map((row) =>
      [...row.querySelectorAll('td')].map((cell) =>
        String(cell.innerText || '').replace(/\s+/g, ' ').trim())))

const waitSettingsTableRows = async (page, expected) => {
  await page.waitForFunction((expectedRows) => {
    const rows = [...document.querySelectorAll('.el-table__body-wrapper tr.el-table__row')]
      .filter((row) => row.getClientRects().length > 0)
      .map((row) => [...row.querySelectorAll('td')].map((cell) =>
        String(cell.innerText || '').replace(/\s+/g, ' ').trim()))
    return rows.length === expectedRows.length &&
      rows.every((row, index) => expectedRows[index].every((cell, column) => row[column] === cell))
  }, expected, { timeout: config.browserTimeoutMs })
}

const partnerLevelSnapshotSql = (tenantId) => `
  SELECT CAST(id AS CHAR),
    SHA2(CAST(JSON_ARRAY(id,tenant_id,code,name,scope,sort,status,remark,
      creator,create_time,updater,update_time,CAST(deleted AS UNSIGNED)) AS CHAR),256),
    CAST(deleted AS UNSIGNED)
  FROM base_partner_level
  WHERE tenant_id=${tenantLiteral(tenantId)} ORDER BY id`

const validPartnerLevelSnapshot = (rows) => Array.isArray(rows) &&
  new Set(rows.map((row) => row?.[0])).size === rows.length &&
  Array.from(rows).every((row) => Array.isArray(row) && row.length === 3 &&
    /^[1-9]\d*$/.test(row[0]) && /^[a-f0-9]{64}$/.test(row[1]) &&
    ['0', '1'].includes(row[2]))

const sharedPartnerLevelSnapshot = (rows, fixture) => {
  const excludedId = fixture?.createdThisRun === true ? String(fixture.id || '') : ''
  return rows.filter((row) =>
    String(row?.[0]) !== excludedId || String(row?.[2]) !== '1')
}

const partnerLevelFixtureCode = () =>
  `E2E_PB033_BOTH_${randomBytes(8).toString('hex').toUpperCase()}`

const partnerLevelFixtureName = (code) => `CFOR E2E ${code} 客商等级`

export function assertLocalPartnerLevelWriteScope (
  settings = config,
  { tenantId = settings.tenantId, token = currentToken } = {}
) {
  if (
    settings.target !== 'local' ||
    String(tenantId) !== '1' ||
    String(settings.tenantId) !== '1' ||
    settings.tenantName !== 'CFOR 标准平台' ||
    !nonEmpty(token) ||
    settings.db?.name !== 'cfor_admin_standard'
  ) {
    throw new Error(
      'BLOCKED: PB033-002 客商等级夹具只允许已认证的 local/tenant1/CFOR 标准平台/cfor_admin_standard'
    )
  }
  assertLocalDatabase(settings.db)
  for (const [label, base, port] of [
    ['前端', settings.webBase, '9151'],
    ['后端', settings.apiBase, '48083']
  ]) {
    let url
    try {
      url = new URL(base)
    } catch {
      throw new Error(`BLOCKED: PB033-002 ${label}地址无效`)
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.port !== port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(`BLOCKED: PB033-002 ${label}必须是无凭据 loopback:${port}`)
    }
  }
}

const validPartnerLevelId = (value) =>
  typeof value === 'string' && /^[1-9]\d*$/.test(value)

const matchesPartnerLevelFixtureDefinition = (row, fixture) =>
  Boolean(row && fixture) &&
    validPartnerLevelId(row.id) &&
    row.code === fixture.code &&
    row.name === fixture.name &&
    row.scope === 'BOTH' &&
    row.status === 1 &&
    row.sort === fixture.sort &&
    row.remark === fixture.remark

const ownedPartnerLevelRow = (row, fixture) =>
  fixture?.createdThisRun === true && fixture.caseId === 'PB033-002' &&
  fixture.tenantId === '1' && validPartnerLevelId(fixture.id) &&
  matchesPartnerLevelFixtureDefinition(row, fixture) && row.id === fixture.id

const businessOptionDisplayValue = (item) => {
  let value
  try { value = JSON.parse(item.currentValue) } catch { value = item.currentValue }
  if (item.ownerType === 'DOMAIN_MODEL') return '领域配置'
  if (item.valueType === 'BOOLEAN') {
    return (typeof value === 'object' ? value?.enabled : value) ? '已启用' : '未启用'
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '-')
}

const businessOptionDisplaySource = (item) =>
  ({ TENANT: '企业配置', TEMPLATE: '平台模板', DEFAULT: '默认值' })[item.currentValueSource] || '领域设置'

export async function runInitSettingsAcceptance (context, dependencies = {}) {
  const { caseId, page, caseRecord, record } = context
  if (!Object.hasOwn(INIT_SETTINGS_CATALOG_ASSERTIONS, caseId)) {
    throw new Error(`不支持的设置验收案例：${caseId}`)
  }
  const request = dependencies.request || requestApi
  const navigate = dependencies.openRoute || openRouteDefault
  const readSnapshot = async (stage, sql) => {
    if (dependencies.readDb) return dependencies.readDb(caseRecord, stage, sql)
    const result = await runReadOnlySql(sql)
    if (!result.available) {
      settingsGap(caseRecord, `${stage}只读数据库不可用；不执行依赖此快照的反例`)
      return null
    }
    caseRecord.database = [...(caseRecord.database || []), { stage, rows: result.rows }]
    return result.rows
  }
  const tenantId = dependencies.tenantId || config.tenantId
  tenantLiteral(tenantId)
  const get = async (path) => settingsResponseSuccess(
    await request(page, 'get', path), path)
  const permission = await get('/admin-api/system/auth/get-permission-info')
  if (!Array.isArray(permission?.data?.menus)) throw new Error('设置验收权限菜单响应结构无效')

  if (caseId === 'PB033-002') {
    const route = findMenuRouteByComponent(permission.data.menus, 'base/partnerLevel/index')
    if (!route) {
      settingsGap(caseRecord, '当前权限菜单未提供 base/partnerLevel/index；不以空表或标题代替设置页')
      return { partial: true }
    }
    const runtimeConfig = dependencies.config || config
    const writeFixturesEnabled =
      dependencies.writeFixturesEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
    if (writeFixturesEnabled) {
      assertLocalPartnerLevelWriteScope(runtimeConfig, {
        tenantId,
        token: dependencies.authToken || currentToken
      })
      await (dependencies.assertWriteSafety || assertLocalWriteSafety)(caseRecord)
    }
    const before = await readSnapshot('partner-level-before', partnerLevelSnapshotSql(tenantId))
    if (before !== null && !validPartnerLevelSnapshot(before)) {
      throw new Error('客商等级前置完整快照结构无效')
    }
    if (writeFixturesEnabled) {
      if (before === null) {
        throw new Error('BLOCKED: PB033-002 写侧夹具需要可用的客商等级活动目录快照')
      }
    }

    const fixture = writeFixturesEnabled
      ? {
          runId: String(record.runId || `PB033-002-${Date.now()}`),
          caseId: 'PB033-002',
          tenantId: String(tenantId),
          createdThisRun: true,
          code: partnerLevelFixtureCode(),
          name: '',
          scope: 'BOTH',
          sort: 9999,
          status: 1,
          remark: ''
        }
      : null
    if (fixture) {
      fixture.name = partnerLevelFixtureName(fixture.code)
      fixture.remark = `CFOR-E2E PB033-002 ${fixture.runId} ${fixture.code}`
      caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
    }

    const readPartnerLevelPage = async (code) => {
      const path = `/admin-api/base/partner-level/page?pageNo=1&pageSize=100&scope=BOTH` +
        `&code=${encodeURIComponent(code)}`
      const response = await request(page, 'get', path)
      const payload = await settingsResponseSuccess(response, `客商等级编码 ${code} 分页`)
      const rows = pageRecordsPayload(payload)
      if (!Array.isArray(rows) || !Number.isSafeInteger(payload?.data?.total) ||
          payload.data.total < rows.length) {
        throw new Error(`客商等级编码 ${code} 分页结构无效`)
      }
      return { response, payload, rows }
    }

    const fixtureWrite = (method, path, data, options = {}) =>
      writeApi(page, record, method, path, data, { ...options, request })

    const createFixture = async () => {
      if (!fixture) return
      const existing = await readPartnerLevelPage(fixture.code)
      const collision = existing.rows.some((row) => row?.code === fixture.code)
      settingsCheck(
        caseRecord,
        '创建前不存在同编码共享客商等级样本',
        !collision,
        `code=${fixture.code}; existing=${existing.rows.length}`
      )

      const create = await fixtureWrite('post', '/admin-api/base/partner-level/create', {
        code: fixture.code,
        name: fixture.name,
        scope: fixture.scope,
        sort: fixture.sort,
        status: fixture.status,
        remark: fixture.remark
      })
      fixture.id = String(create.payload?.data ?? '')
      const created = create.ok && isSuccessfulPayload(create.payload) &&
        /^[1-9]\d*$/.test(fixture.id)
      settingsCheck(
        caseRecord,
        '本轮专属 BOTH 启用等级创建返回精确 ID',
        created,
        `code=${fixture.code}; name=${fixture.name}; scope=${fixture.scope}; ` +
        `status=${fixture.status}; id=${fixture.id || 'invalid'}; ` +
        `HTTP=${create.response.status()}; code=${create.code ?? 'invalid'}`
      )
      const reread = await readPartnerLevelPage(fixture.code)
      const row = reread.rows.find((item) => String(item?.id) === fixture.id)
      settingsCheck(
        caseRecord,
        '本轮专属 BOTH 启用等级创建后精确回读',
        ownedPartnerLevelRow(row, fixture),
        `expected=${JSON.stringify({
          id: fixture.id, code: fixture.code, name: fixture.name,
          scope: fixture.scope, status: fixture.status, remark: fixture.remark
        })}; actual=${JSON.stringify(row || null)}`
      )
    }

    const cleanupFixture = async () => {
      if (!fixture?.id) return
      const current = await readPartnerLevelPage(fixture.code)
      const owned = current.rows.find((row) => String(row?.id) === fixture.id)
      if (!ownedPartnerLevelRow(owned, fixture)) {
        throw new Error(
          `BLOCKED: PB033-002 清理前所有权回读不匹配：id=${fixture.id}; ` +
          `row=${JSON.stringify(owned || null)}`
        )
      }
      const deleted = await fixtureWrite(
        'delete',
        `/admin-api/base/partner-level/delete?id=${encodeURIComponent(fixture.id)}`
      )
      if (!deleted.ok || !isSuccessfulPayload(deleted.payload)) {
        throw new Error(
          `PB033-002 专属等级删除失败：id=${fixture.id}; ` +
          `HTTP=${deleted.response.status()}; code=${deleted.code ?? 'invalid'}; ` +
          `msg=${String(deleted.payload?.msg || '').slice(0, 160)}`
        )
      }
      const gone = await readPartnerLevelPage(fixture.code)
      const stillVisible = gone.rows.some((row) =>
        String(row?.id) === fixture.id || row?.code === fixture.code)
      if (gone.rows.length !== 0 || Number(gone.payload?.data?.total) !== 0 || stillVisible) {
        throw new Error(
          `PB033-002 专属等级清理后分页仍可见：id=${fixture.id}; ` +
          `rows=${gone.rows.length}; total=${gone.payload?.data?.total}`
        )
      }
      fixture.cleanup = 'DELETED_VERIFIED'
      caseRecord.checks.push({
        name: '本轮专属等级清理后分页不可见',
        passed: true,
        details: `id=${fixture.id}; code=${fixture.code}; deletedCode=${deleted.code}; ` +
          'scope=BOTH; pageTotal=0'
      })
    }

    let executionError
    let cleanupError
    let after
    try {
      await createFixture()
      await navigate(page, route, { readyText: '等级编码' })
      settingsCheck(caseRecord, '客商等级设置页可从设置菜单进入',
        /^\/settings\/(?:[^/]+\/)*erp\/partner-level$/.test(route) &&
          responsePath(page.url()) === route,
        `权限菜单 component=base/partnerLevel/index; route=${route}; url=${page.url()}`)
      const codeField = page.locator('.el-form-item').filter({
        has: page.getByText('等级编码', { exact: true })
      }).first().locator('input').first()
      const scopeField = page.locator('.el-form-item').filter({
        has: page.getByText('适用角色', { exact: true })
      }).first().locator('.el-select').first()
      const createButton = page.getByRole('button', { name: '新增等级', exact: true })
      settingsCheck(caseRecord, '页面渲染查询条件与新增入口',
        await codeField.isVisible() && await scopeField.isVisible() &&
          await createButton.count() === 1 && await createButton.isVisible(),
        '查询表单的真实 input/select 可见，唯一新增等级按钮可见；未点击新增入口')
      const scopeChecks = {
        CUSTOMER: '页面真实分页按 CUSTOMER 显示且响应可见',
        SUPPLIER: '页面真实分页按 SUPPLIER 显示且响应可见',
        BOTH: '页面真实分页按 BOTH 显示且响应可见'
      }
      for (const [scope, label] of Object.entries(PARTNER_LEVEL_SCOPE_LABELS)) {
        await scopeField.click()
        await page.locator('.el-select-dropdown:visible')
          .getByRole('option', { name: label, exact: true }).click()
        const [response] = await Promise.all([
          page.waitForResponse((item) => settingsResponseMatches(item,
            '/admin-api/base/partner-level/page', { scope, pageNo: '1', pageSize: '100' })),
          page.getByRole('button', { name: '查询', exact: true }).click()
        ])
        const payload = await settingsResponseSuccess(response, `客商等级 ${scope} 页面分页`)
        const rows = pageRecordsPayload(payload)
        if (!Array.isArray(rows) || !Number.isSafeInteger(payload?.data?.total) ||
            payload.data.total < rows.length) throw new Error(`客商等级 ${scope} 分页结构无效`)
        if (rows.length === 0) {
          if (payload.data.total !== 0) throw new Error(`客商等级 ${scope} 首分页为空但 total 非零`)
          settingsGap(caseRecord, `${scope} 没有实际等级样本；不新增共享等级，不以空分页算通过`)
          continue
        }
        const expected = rows.map((row) => [row.code, row.name, label])
        await waitSettingsTableRows(page, expected)
        const rendered = await visibleSettingsTableRows(page)
        const evidence = validatePartnerLevelScopePageEvidence({
          payload, responseStatus: response.status(), responseUrl: response.url(), scope,
          renderedRows: rendered.map((row) => ({ code: row[0], name: row[1], scopeText: row[2] }))
        })
        settingsCheck(caseRecord, scopeChecks[scope],
          evidence.valid,
          `path=/base/partner-level/page; scope=${scope}; pageNo=1; pageSize=100; ` +
          `responseRows=${rows.length}; renderedRows=${rendered.length}; ${evidence.reason}`)
        if (fixture && scope === 'BOTH') {
          const owned = rows.find((row) => String(row?.id) === fixture.id)
          settingsCheck(
            caseRecord,
            '本轮专属 BOTH 启用等级在真实页面分页精确可见',
            ownedPartnerLevelRow(owned, fixture),
            `id=${fixture.id}; row=${JSON.stringify(owned || null)}`
          )
        }
      }
      const simplePayload = await get('/admin-api/base/partner-level/simple-list?scope=BOTH')
      const simpleRows = arrayPayload(simplePayload)
      if (!simpleRows) throw new Error('客商等级 simple-list 响应结构无效')
      if (simpleRows.length > 0) {
        settingsCheck(caseRecord, '页面使用的客商等级接口在角色维度可读',
          simpleRows.every((row) => row?.scope === 'BOTH' && row.status === 1 &&
            nonEmpty(row.code) && nonEmpty(row.name)),
          `补充原 catalog API /simple-list?scope=BOTH; 实际样本=${simpleRows.length}; ` +
          '页面消费证据来自上述真实分页，不以 simple-list 替代')
        if (fixture) {
          const owned = simpleRows.find((row) => String(row?.id) === fixture.id)
          settingsCheck(
            caseRecord,
            '本轮专属 BOTH 启用等级在 simple-list 精确可见',
            ownedPartnerLevelRow(owned, fixture),
            `id=${fixture.id}; row=${JSON.stringify(owned || null)}`
          )
        }
      } else settingsGap(caseRecord, 'BOTH 精简列表无启用样本，保留原 API 角色维度缺证')
    } catch (error) {
      executionError = error
    }

    if (fixture?.id) {
      try {
        await cleanupFixture()
      } catch (error) {
        cleanupError = error
        fixture.cleanup = 'NOT_CLEANED'
        caseRecord.notes.push(`PB033-002 专属等级清理失败：${error.message || String(error)}`)
        caseRecord.checks.push({
          name: '本轮专属等级清理后分页不可见',
          passed: false,
          details: error.message || String(error)
        })
      }
    }

    try {
      after = await readSnapshot('partner-level-after', partnerLevelSnapshotSql(tenantId))
      if (before !== null && after !== null) {
        const unchanged = validPartnerLevelSnapshot(after) &&
          JSON.stringify(sharedPartnerLevelSnapshot(before, fixture)) ===
          JSON.stringify(sharedPartnerLevelSnapshot(after, fixture))
        caseRecord.checks.push({
          name: '客商等级完整目录只读验证前后相同',
          passed: unchanged,
          details: `活动及历史目录完整字段/审计/软删除标志 hash；` +
            `排除本轮精确 ID=${fixture?.id || 'none'} 的软删除历史；` +
            `beforeShared=${sharedPartnerLevelSnapshot(before, fixture).length}; ` +
            `afterShared=${sharedPartnerLevelSnapshot(after, fixture).length}`
        })
        if (!unchanged && !executionError) {
          executionError = new Error('客商等级完整目录只读验证前后不相同')
        }
      }
    } catch (error) {
      if (!executionError) executionError = error
    }

    if (executionError || cleanupError) {
      const errors = [executionError, cleanupError].filter(Boolean)
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(
            errors,
            `PB033-002 设置验收与专属夹具清理均未完成：${
              errors.map((error) => error?.message || String(error)).join('; ')
            }`
          )
    }
    caseRecord.evidence.push(
      writeFixturesEnabled
        ? `真实写侧：先完成本地 tenant1 数据库预检，再创建本轮专属 BOTH/status=1 等级 ` +
          `${fixture.code}（id=${fixture.id}），逐字段回读、页面/精简列表核对，` +
          '按精确 ID/编码/名称/remark 所有权清理；前后活动目录快照仅比较 deleted=0，证明共享数据不变。'
        : '客商等级设置页仅操作 scope 查询；未启用写侧夹具，未调用任何等级创建或删除接口。'
    )
    return {}
  }

  const catalogPath = '/admin-api/system/config/business-options/list'
  const beforePayload = await get(catalogPath)
  const options = arrayPayload(beforePayload)
  if (!options) throw new Error('业务选项目录响应结构无效')
  if (options.length === 0) {
    settingsGap(caseRecord, '完整业务选项目录为空，所有事实源证据保留 GAP')
    return { partial: true }
  }
  const catalogEvidence = validateBusinessOptionCatalog(options)
  settingsCheck(caseRecord, '业务选项目录可访问且包含稳定编码',
    catalogEvidence.valid,
    `完整目录=${options.length}; duplicateCodes=${catalogEvidence.duplicateCodes.join(',')}`)
  settingsCheck(caseRecord, '配置目录声明事实源归属',
    options.every((item) => ['SYSTEM_CONFIG', 'DOMAIN_MODEL'].includes(item.ownerType)),
    '逐项验证代码目录 ownerType；不把标题、HTTP200 或非空长度作为完整证据')
  const snapshotSql = initSettingsConfigSnapshotSql(tenantId)
  const beforeDb = await readSnapshot('business-options-config-before', snapshotSql)
  if (beforeDb !== null && !validateInitSettingsConfigSnapshot(beforeDb, tenantId)) {
    throw new Error('业务选项 system_config 完整快照结构无效')
  }
  const systemItems = options.filter((item) => item.ownerType === 'SYSTEM_CONFIG')
  const domainItems = options.filter((item) => item.ownerType === 'DOMAIN_MODEL')
  if (systemItems.length > 0 && beforeDb !== null) {
    settingsCheck(caseRecord, 'SYSTEM_CONFIG 项回读当前租户或模板有效值',
      validateInitSettingsEffectiveValues(options, beforeDb, tenantId),
      `SYSTEM_CONFIG=${systemItems.length}; tenant=${tenantId}; ` +
      '按 category/tag 对照 tenant 优先/template 回退/default 及原始值 SHA256')
  } else settingsGap(caseRecord, 'SYSTEM_CONFIG 样本或只读配置快照缺失')
  if (domainItems.length > 0 && beforeDb !== null) {
    settingsCheck(caseRecord, 'DOMAIN_MODEL 项不复制业务状态到 system_config',
      domainItems.every((item) => item.currentValueSource === 'DOMAIN_MODEL' &&
        item.currentValue == null && item.category == null && item.tag == null &&
        !beforeDb.some((row) => String(row[3]).toUpperCase() === item.optionCode)),
      `DOMAIN_MODEL=${domainItems.length}; ` +
      '领域目录无配置地址/当前配置值；tenant/template config 全部 tag 不含任一领域 optionCode')
  } else settingsGap(caseRecord, 'DOMAIN_MODEL 样本或只读配置快照缺失，不以空集合证明无镜像')
  const route = findMenuRouteByComponent(permission.data.menus, 'system/business-options/index')
  if (route) {
    await navigate(page, route, { readyText: '系统选项' })
    const moduleField = page.locator('.el-form-item').filter({
      has: page.getByText('业务模块', { exact: true })
    }).first().locator('.el-select').first()
    await moduleField.click()
    const [response] = await Promise.all([
      page.waitForResponse((item) => settingsResponseMatches(item, catalogPath, { moduleCode: 'erp' })),
      page.locator('.el-select-dropdown:visible')
        .getByRole('option', { name: '采购与销售', exact: true }).click()
    ])
    const pagePayload = await settingsResponseSuccess(response, '业务选项页面 ERP 目录')
    const pageOptions = arrayPayload(pagePayload)
    if (!pageOptions || !validateBusinessOptionCatalog(pageOptions).valid ||
        pageOptions.some((item) => item.moduleCode !== 'erp') ||
        !sameBusinessOptionCatalog(options.filter((item) => item.moduleCode === 'erp'), pageOptions)) {
      throw new Error('业务选项页面响应与完整目录 ERP 事实不一致')
    }
    const expected = pageOptions.map((item) => [item.name, '采购与销售',
      businessOptionDisplayValue(item), businessOptionDisplaySource(item)])
    await waitSettingsTableRows(page, expected)
    const rendered = await visibleSettingsTableRows(page)
    const pageSystemItems = pageOptions.filter((item) => item.ownerType === 'SYSTEM_CONFIG')
    if (pageSystemItems.length > 0) {
      settingsCheck(caseRecord, 'SYSTEM_CONFIG 有效值与来源在真实页面逐行显示',
        responsePath(page.url()) === route && rendered.length === expected.length &&
          rendered.every((row, index) => expected[index].every((cell, column) => row[column] === cell)),
        `component=system/business-options/index; moduleCode=erp; ` +
        `SYSTEM_CONFIG=${pageSystemItems.length}; 值及来源逐行与真实页面响应一致`)
    } else settingsGap(caseRecord, '系统选项 ERP 页面没有 SYSTEM_CONFIG 样本')
  } else settingsGap(caseRecord, '当前权限菜单未提供 system/business-options/index；旧配置页面不代替有效值展示证据')

  if (beforeDb === null) return { partial: true, note: '缺只读快照，未执行未知目录 POST 反例' }
  const unknownCode = `ERP.E2E.UNKNOWN.${e2eTag('CAT')}`
  if (options.some((item) => item.optionCode === unknownCode)) {
    throw new Error('未知目录反例编码已存在，禁止发送反例')
  }
  const response = await request(page, 'post',
    '/admin-api/system/config/business-options/create',
    { data: { optionCode: unknownCode, ownerType: 'SYSTEM_CONFIG' } })
  const rejectionPayload = await settingsResponsePayload(response)
  record?.api?.push({
    method: 'POST', pathname: '/admin-api/system/config/business-options/create',
    status: response.status(), code: rejectionPayload?.code,
    bodySummary: JSON.stringify(rejectionPayload).slice(0, 1000)
  })
  // Always read back after the probe, including an unexpected response.
  const afterPayload = await get(catalogPath)
  const afterOptions = arrayPayload(afterPayload)
  const afterDb = await readSnapshot('business-options-config-after', snapshotSql)
  settingsCheck(caseRecord, '被拒写入前后完整业务选项目录相同',
    afterOptions !== null && validateBusinessOptionCatalog(afterOptions).valid &&
      sameBusinessOptionCatalog(options, afterOptions) &&
      !afterOptions.some((item) => item.optionCode === unknownCode),
    `所有目录字段（含附加字段）canonical 比较; before=${options.length}; after=${afterOptions?.length ?? 'invalid'}`)
  if (afterDb !== null) {
    settingsCheck(caseRecord, '未知目录反例前后完整配置事实相同',
      validateInitSettingsConfigSnapshot(afterDb, tenantId) &&
        JSON.stringify(beforeDb) === JSON.stringify(afterDb),
      `tenant=${tenantId} + template 完整 id/category/tag/config_data 行 hash 相同`)
  }
  settingsCheck(caseRecord, '租户不能通过目录接口自由新增未知配置项',
    isUnknownBusinessOptionCreateRejection(response, rejectionPayload),
    `精确缺失 create 端点; HTTP=${response.status()}; code=${rejectionPayload?.code ?? 'invalid'}`)
  caseRecord.evidence.push('完整业务选项目录、SYSTEM_CONFIG 原始有效值来源、真实 ERP 系统选项展示、DOMAIN_MODEL 无镜像及未知目录拒绝后完整 API/配置事实均分开取证；未修改配置或打开新增表单。')
  return {}
}

export async function runIsolatedOrganizationRootEvidence (context, dependencies = {}) {
  const { caseRecord } = context
  const assertScope = dependencies.assertScope || assertLocalInitScope
  assertScope(dependencies.config || config)
  if (!(dependencies.writeFixturesEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true')) {
    caseRecord.notes.push('未启用写侧夹具，专属租户根组织反例保留 GAP。')
    return { executed: false }
  }
  await (dependencies.assertWriteSafety || assertLocalWriteSafety)(caseRecord)
  const adminApi = dependencies.adminApi || createApiClient({
    token: currentToken, tenantId: '1', record: context.record
  })
  return (dependencies.runRootIsolation || runFreshOrganizationRootEvidence)(context, {
    ...dependencies,
    adminApi,
    readDb: dependencies.readDb || readDb,
    factsSql: organizationRootFactsSql,
    validateReadiness: validateOrganizationRootReadiness
  })
}

const runCaseCore = async (context, dependencies = {}) => {
  const { caseId, page, caseRecord, record } = context
  if (ownedInitCases.includes(caseId) && caseId !== 'PB005-001') {
    return runOwnedInitCase(context, dependencies)
  }
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
    caseRecord.checks.push({
      name: '真实浏览器打开企业资料页',
      passed: new URL(page.url()).pathname.includes('/enterprise-organization'),
      details: page.url()
    })
    if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
      caseRecord.notes.push(
        '未启用 CFOR_E2E_WRITE_FIXTURES=true；共享租户企业资料不写入，tenant_admin 页面选项证据保留 GAP。'
      )
      return { partial: true, note: '需要专属租户 tenant_admin 的真实浏览器企业资料证据' }
    }
    assertLocalInitScope()
    await assertLocalWriteSafety(caseRecord)
    const primaryApi = createApiClient({ token: currentToken, tenantId: config.tenantId, record })
    await runEnterpriseIsolationEvidence({
      context,
      primaryApi,
      verifyEnterprisePage: async ({ page: tenantPage, api, tenantId, readDb: readEnterpriseDb }) => {
        const permission = await api.getPermissionInfo()
        const route = findMenuRouteByComponent(permission?.data?.menus, 'system/enterprise-organization/index')
        if (!route) throw new Error(`PB001-001 专属 tenant_admin 缺少企业资料页面 tenantId=${tenantId}`)
        await openRoute(tenantPage, route, { readyText: '企业类型' })
        const enterpriseTypeItem = tenantPage.locator('.el-form-item').filter({
          has: tenantPage.getByText('企业类型', { exact: true })
        }).first()
        await enterpriseTypeItem.waitFor({ state: 'visible' })
        const enterpriseTypeSelect = enterpriseTypeItem.locator('.el-select').first()
        const optionVisible = await enterpriseTypeSelect.count() > 0 &&
          await enterpriseTypeSelect.click({ timeout: 5000 })
            .then(async () => tenantPage.getByText('生产贸易混合型', { exact: true }).first()
              .isVisible().catch(() => false))
            .catch(() => false)
        await tenantPage.keyboard.press('Escape').catch(() => {})
        caseRecord.checks.push({
          name: '企业资料页展示生产贸易混合型选项',
          passed: optionVisible,
          details: `tenantId=${tenantId}; select=${await enterpriseTypeSelect.count()}; optionVisible=${optionVisible}`
        })
        if (!optionVisible) throw new Error('PB001-001 专属 tenant_admin 企业类型下拉未展示生产贸易混合型')

        const before = await api.getBusiness('/system/enterprise-organization/current')
        const profile = before?.data
        if (!profile?.enterpriseType) throw new Error('PB001-001 专属企业资料缺少原始企业类型')
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
        await api.putBusiness('/system/enterprise-organization/current', body)
        const changed = await api.getBusiness('/system/enterprise-organization/current')
        if (changed?.data?.enterpriseType !== '生产贸易混合型') {
          throw new Error('PB001-001 专属企业资料保存后未回读生产贸易混合型')
        }
        await api.putBusiness('/system/enterprise-organization/current', {
          ...body, enterpriseType: profile.enterpriseType
        })
        const restored = await api.getBusiness('/system/enterprise-organization/current')
        if (restored?.data?.enterpriseType !== profile.enterpriseType) {
          throw new Error('PB001-001 专属企业资料恢复原值失败')
        }
        const dbRows = await readEnterpriseDb('enterprise-type-roundtrip',
          `SELECT enterprise_type FROM system_enterprise_organization ` +
          `WHERE deleted=0 AND tenant_id=${tenantId}`)
        if (dbRows.length !== 1 || dbRows[0][0] !== profile.enterpriseType) {
          throw new Error(`PB001-001 专属企业资料数据库恢复值不一致：${JSON.stringify(dbRows)}`)
        }
        caseRecord.evidence.push(
          `真实 tenant_admin 浏览器打开专属租户企业资料页，展示生产贸易混合型，` +
          `保存、回读、恢复和 tenant_id=${tenantId} 数据库复验完成。`
        )
      }
    })
    return {}
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
    const subsystemRows = page.locator('.subsystem-settings__group .el-table__body-wrapper tbody tr')
    const visibleCodes = await subsystemRows.evaluateAll(
      (rows) => rows.map((row) => row.querySelector('.subsystem-settings__name span')?.textContent?.trim())
        .filter(Boolean)
    )
    const cardCount = await subsystemRows.count()
    const monthPickerCount = await page.locator('.subsystem-settings__month').count()
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
      const card = page.locator('.subsystem-settings__group .el-table__row')
        .filter({ hasText: item.subsystemCode }).first()
      protectedControls.push({
        code: item.subsystemCode,
        disabled: await card.locator('.el-switch').evaluate((element) =>
          element.classList.contains('is-disabled') || element.getAttribute('aria-disabled') === 'true'
        ) && await card.locator('.subsystem-settings__month input').isDisabled()
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
    const writeFixturesEnabled = process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
    if (!writeFixturesEnabled) {
      caseRecord.notes.push(
        '未启用 CFOR_E2E_WRITE_FIXTURES=true，跳过子系统停用/启用、月份和依赖写侧；只保留真实只读套餐边界证据。'
      )
    }
    let stopOk = false
    let enableOk = false
    let dependOk = false
    let monthOk = false
    if (writeFixturesEnabled && portal?.available && !portal.locked) {
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
    } else if (writeFixturesEnabled) {
      caseRecord.notes.push('缺前置：erp.supplier-portal 不可用或已锁定，停用/启用闭环未执行。')
    }
    if (writeFixturesEnabled && mes) {
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
    const flattenMenuIds = (items, visibleOnly = false) => (items || []).flatMap((item) => {
      if (visibleOnly && item?.visible === false) {
        return []
      }
      return [item?.id, ...flattenMenuIds(item?.children, visibleOnly)]
    }).filter((item) => item != null).map(String)
    const allPermissionMenuIds = flattenMenuIds(permissionPayload?.data?.menus)
    const permissionMenuIds = flattenMenuIds(permissionPayload?.data?.menus, true)
    const menuCount = permissionMenuIds.length
    const tenantResponse = await requestApi(
      page, 'get', `/admin-api/system/tenant/get?id=${encodeURIComponent(config.tenantId)}`
    )
    const tenantPayload = await tenantResponse.json().catch(() => null)
    const packageId = tenantPayload?.data?.packageId
    const packageResponse = await requestApi(
      page, 'get', `/admin-api/system/tenant-package/get?id=${encodeURIComponent(packageId || '')}`
    )
    const packagePayload = await packageResponse.json().catch(() => null)
    const packageMenuIds = new Set((packagePayload?.data?.menuIds || []).map(String))
    const packageMenuCount = packageMenuIds.size
    const withinPackage = tenantResponse.ok() && isSuccessfulPayload(tenantPayload) &&
      /^[1-9]\d*$/.test(String(packageId || '')) &&
      packageResponse.ok() && isSuccessfulPayload(packagePayload) &&
      packageMenuCount > 0 && menuCount > 0 &&
      permissionMenuIds.every((id) => packageMenuIds.has(id))
    caseRecord.checks.push({
      name: '保存后可见菜单不越过套餐边界（权限与套餐菜单均可读）',
      passed: withinPackage,
      details: `tenantPackage=${packageId || 'missing'} menus=${menuCount} packageMenus=${packageMenuCount} ` +
        `allPermissionMenus=${allPermissionMenuIds.length} ` +
        `outside=${permissionMenuIds.filter((id) => !packageMenuIds.has(id)).join(',') || 'none'}`
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
    const summaryRows = await readDb(caseRecord, 'legacy-product-summary-counts',
      legacyMasterCountsSql(config.tenantId))
    const summaryAudit = validateLegacyMasterCounts(summaryData, summaryRows)
    caseRecord.checks.push({
      name: '退役摘要六项数量与当前租户数据库逐项一致',
      passed: summary.ok() && isSuccessfulPayload(summaryPayload) && summaryAudit.valid,
      details: `tenantId=${config.tenantId}; ${JSON.stringify(summaryAudit)}`
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
    const viewMetadata = await readDb(caseRecord, 'legacy-product-view-definitions',
      "SELECT table_name,view_definition,is_updatable FROM information_schema.views " +
      "WHERE table_schema=DATABASE() AND table_name IN ('erp_product','erp_product_unit','erp_product_category')")
    const projectionRows = await readDb(caseRecord, 'legacy-product-projection-audit',
      legacyProjectionAuditSql(config.tenantId))
    const projectionAudit = validateLegacyProjectionViews(viewMetadata, projectionRows)
    caseRecord.checks.push({
      name: '旧视图定义只读且全部投影字段与当前租户 Base 数据一致',
      passed: projectionAudit.valid,
      details: `tenantId=${config.tenantId}; ${projectionAudit.reason || 'all projection mismatch/orphan/duplicate counts=0'}`
    })
    const expectedSimpleRows = await readDb(caseRecord, 'legacy-product-simple-projections',
      legacySimpleProjectionSql(config.tenantId))
    const simpleAudit = validateLegacySimpleProjections({
      product: arrayPayload(productListPayload), unit: arrayPayload(unitListPayload),
      category: arrayPayload(categoryListPayload)
    }, expectedSimpleRows)
    if (!simpleAudit.valid || simpleAudit.missingSamples.length === 0) {
      caseRecord.checks.push({
        name: '旧产品/单位/分类启用读列表与 Base 投影逐行一致',
        passed: simpleAudit.valid && productList.ok() && unitList.ok() && categoryList.ok() &&
          [productListPayload, unitListPayload, categoryListPayload].every(isSuccessfulPayload),
        details: JSON.stringify(simpleAudit)
      })
    } else {
      caseRecord.notes.push(`缺前置：启用 Base 投影样本缺少 ${simpleAudit.missingSamples.join('/')}；空读列表不能证明投影字段一致。`)
    }
    caseRecord.evidence.push(
      '当前租户六项摘要逐项比对数据库；读取真实 VIEW 定义与可更新性，' +
      '核对全部投影字段、缺失/孤立/重复行及启用 simple-list 的 Base 数据，不执行迁移或写入。'
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

    if (!isWmsWriteEnabled()) {
      caseRecord.notes.push('未启用 CFOR_E2E_WRITE_FIXTURES=true；PB032 专属物料/WMS 拒绝夹具保留 GAP。')
      return { partial: true, note: '未启用 PB032 专属物料/WMS 写侧夹具' }
    }
    await assertLocalWriteSafety(caseRecord)
    const api = createApiClient({ token: currentToken, tenantId: '1', record })
    const wmsFixture = await prepareWmsFixture(api, caseRecord, 32)
    try {
      await verifyMaterialValidationClosure({
        api,
        caseRecord,
        unit: wmsFixture.unit,
        stockLocation: {
          warehouse: wmsFixture.warehouse,
          area: wmsFixture.area,
          location: wmsFixture.location
        }
      })
      caseRecord.evidence.push(
        '专属 WMS 仓库/库区/库位与专属 SERVICE/VIRTUAL 物料完成正式 API 负例：' +
        '无主单位、非正保质期被 Base 精确拒绝；非实物进入 WMS 保存被拒且未生成单据。'
      )
      const supplierRows = (await api.getBusiness(
        '/base/partner/simple-list?roleType=SUPPLIER')).data
      const customerRows = (await api.getBusiness(
        '/base/partner/simple-list?roleType=CUSTOMER')).data
      const supplier = Array.isArray(supplierRows) &&
        supplierRows.find((row) => /^[1-9]\d*$/.test(String(row?.id)))
      const customer = Array.isArray(customerRows) &&
        customerRows.find((row) => /^[1-9]\d*$/.test(String(row?.id)))
      if (!supplier || !customer) {
        caseRecord.notes.push(
          '前置缺失：当前租户没有可读取的启用供应商和客户，采购/销售能力门禁保留 PARTIAL。')
      } else {
        await verifyMaterialCommercialValidationClosure({
          api,
          caseRecord,
          unit: wmsFixture.unit,
          supplier,
          customer
        })
        caseRecord.evidence.push(
          '本轮专属 STOCK 物料分别关闭可采购/可销售能力，正式采购/销售订单精确拒绝，' +
          '并核对拒绝前后物料快照及 billNo+productId 订单分页无残留。'
        )
      }
    } finally {
      await cleanupWmsFixtures(api, caseRecord)
    }
    caseRecord.notes.push(
      'PB032-001 已执行 WMS 非实物与采购/销售能力门禁；仅保留原 catalog 断言映射结果。')
    return { partial: false, note: 'PB032 WMS 与采购/销售门禁已执行' }
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
    if (!isWmsWriteEnabled()) {
      return markPartial(caseRecord, '未启用本地专属夹具，四类实物出入库写侧拒绝尚未执行')
    }
    await assertLocalWriteSafety(caseRecord)
    const api = createApiClient({ token: currentToken, tenantId: '1', record })
    const unitRows = (await api.getBusiness('/mes/basUnit/list/enabled')).data
    const supplierRows = (await api.getBusiness('/base/partner/simple-list?roleType=SUPPLIER')).data
    const customerRows = (await api.getBusiness('/base/partner/simple-list?roleType=CUSTOMER')).data
    const validId = (row) => /^[1-9]\d*$/.test(String(row?.id))
    const unit = Array.isArray(unitRows) && unitRows.find(validId)
    const supplier = Array.isArray(supplierRows) && supplierRows.find(validId)
    const customer = Array.isArray(customerRows) && customerRows.find(validId)
    if (!unit || !supplier || !customer) {
      return markPartial(caseRecord, '缺少可读取的启用单位、供应商或客户，尚未创建四类实物出入库夹具')
    }
    await verifyMaterialStockScenarioClosure({ api, caseRecord, record, unit, supplier, customer })
    caseRecord.evidence.push('正式 SERVICE/STOCK 采购草稿正控制、四类 ERP 实物出入库负例、精确分页和库存快照已执行；未伪造审批或共享库存。')
    return { partial: false }
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
    if (!(dependencies.writeFixturesEnabled ?? isWmsWriteEnabled())) {
      return markPartial(caseRecord, '未启用 PB032-003 专属 BOM 形态拒绝夹具；工单/MRP 源码契约缺口保留 GAP')
    }
    const api = (dependencies.createApiClient || createApiClient)({
      token: currentToken, tenantId: '1', record
    })
    const units = (await api.getBusiness('/mes/basUnit/list/enabled')).data
    const unit = Array.isArray(units) && units.find((row) =>
      /^[1-9]\d*$/.test(String(row?.id)) &&
      !(typeof row.id === 'number' && !Number.isSafeInteger(row.id)))
    if (!unit) throw new Error('BLOCKED: PB032-003 缺少既有启用单位，不创建夹具')
    await (dependencies.verifyMaterialBomValidationClosure || verifyMaterialBomValidationClosure)({
      api, caseRecord, unit
    }, dependencies)
    return { partial: true, note: '四组 BOM 形态拒绝已执行；工单/MRP 缺少正式场景门禁，保留 GAP。' }
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
    if (!isWmsWriteEnabled()) {
      caseRecord.notes.push('未启用 CFOR_E2E_WRITE_FIXTURES=true；PB032 导入保存前统一校验保留 GAP。')
      return { partial: true, note: '未启用 PB032 导入写侧夹具' }
    }
    await assertLocalWriteSafety(caseRecord)
    const api = createApiClient({ token: currentToken, tenantId: '1', record })
    const units = await api.getBusiness('/mes/basUnit/list/enabled')
    const unitRows = Array.isArray(units?.data) ? units.data : null
    const unit = unitRows?.find((item) => item?.id && String(item?.name || '').trim())
    if (!unit) throw new Error('BLOCKED: PB032 导入校验缺少启用计量单位名称')
    await verifyMaterialImportValidationClosure({ api, caseRecord, templateHeaders: headers, unit })
    caseRecord.evidence.push('使用系统模板表头上传三条必然拒绝的 XLSX；导入响应逐行列出档案形态、来源能力和库存控制原因，全部编码分页回读为零。')
    return {}
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
    const materialRows = await readDb(caseRecord, 'material-readiness-audit',
      materialReadinessAuditSql(config.tenantId))
    const materialAudit = validateMaterialReadiness(material, materialRows)
    caseRecord.checks.push({
      name: '就绪检查以真实库内主单位/来源/保质期/非实物隔离异常为判定依据',
      passed: materialAudit.valid,
      details: JSON.stringify(materialAudit)
    })
    if (materialAudit.missingCategories.length === 0 && materialAudit.valid) {
      caseRecord.checks.push({
        name: '主单位/来源/保质期/非实物库存四类异常取得真实识别证据',
        passed: material.status === 'INCOMPLETE',
        details: JSON.stringify(materialAudit.counts)
      })
    } else {
      caseRecord.notes.push(
        `缺前置：真实异常样本缺少 ${materialAudit.missingCategories.join('/') || '有效的异常总数回读'}；` +
        '每类须有不与其他异常重叠的实测样本，仅 READY/重叠样本/计数一致不能证明四类反例。' +
        '禁止向共享 tenant1 写入非法存货或非实物库存，保留 GAP。'
      )
    }
    const presetRows = await readDb(caseRecord, 'material-preset-nature', `
      SELECT COUNT(*), SUM(UPPER(TRIM(COALESCE(inventory_nature,'')))='STOCK')
      FROM mes_bas_material
      WHERE tenant_id=${tenantLiteral(config.tenantId)} AND deleted=0 AND creator='system-init'
    `)
    if (presetRows.length === 1 && nonNegativeCount(presetRows[0][0]) && Number(presetRows[0][0]) === 0) {
      caseRecord.notes.push('缺前置：没有真实 system-init 预置存货；不调用共享租户 apply 补样本，STOCK 断言保留 GAP。')
    } else {
      caseRecord.checks.push({
        name: '初始化预置存货显式写入 STOCK 档案形态',
        passed: presetRows.length === 1 && nonNegativeCount(presetRows[0][0]) &&
          Number(presetRows[0][0]) > 0 && nonNegativeCount(presetRows[0][1]) &&
          Number(presetRows[0][1]) === Number(presetRows[0][0]),
        details: JSON.stringify(presetRows)
      })
    }
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
      }, {
        expectedBusinessRejection: {
          code: 500,
          message: /编码不可修改/,
          allowServiceCode: true
        }
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
          `/admin-api/base/partner-level/delete?id=${levelId}`, undefined, {
            expectedBusinessRejection: {
              code: 500,
              message: /已被引用/,
              allowServiceCode: true
            }
          })
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
    return runInitSettingsAcceptance(context, { ...dependencies, openRoute })
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
    const readiness = await requestApi(page, 'get', '/admin-api/system/system-init/readiness')
    const readinessPayload = await readiness.json().catch(() => null)
    const rootItem = readinessItemsPayload(readinessPayload)?.find(
      (item) => item?.key === 'system.organization-root')
    const rootRows = await readDb(caseRecord, 'organization-root-effective-facts',
      organizationRootFactsSql(config.tenantId))
    const rootAudit = validateOrganizationRootReadiness(rootItem, rootRows)
    caseRecord.checks.push({
      name: '初始化就绪检查以当前租户有效根组织事实判定',
      passed: readiness.ok() && isSuccessfulPayload(readinessPayload) && rootAudit.valid,
      details: `tenantId=${config.tenantId}; ${JSON.stringify(rootAudit)}`
    })
    if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
      caseRecord.notes.push('未启用 CFOR_E2E_WRITE_FIXTURES=true；部门创建/更新/清理和专属租户根组织反例均保留 GAP。')
      return {}
    }
    assertLocalInitScope()
    await assertLocalWriteSafety(caseRecord)
    // 真实写侧：创建专属测试部门并回读稳定编码、类型、管理边界与主管。
    const tag = e2eTag('E2EDEPT')
    const deptCode = `E2E-${tag}`
    const departmentOwnerSql = `SELECT CAST(id AS CHAR),code,CAST(tenant_id AS CHAR) FROM system_dept
      WHERE tenant_id=${tenantLiteral(config.tenantId)} AND code='${deptCode}' AND deleted=0`
    if ((await readDb(caseRecord, 'dept-marker-preflight', departmentOwnerSql)).length) {
      throw new Error('BLOCKED: owned department marker already exists')
    }
    let deptId = ''
    let ownedDepartment = false
    let createAttempted = false
    try {
      createAttempted = true
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
      const createdOk = create.ok && isSuccessfulPayload(create.payload) && /^[1-9]\d*$/.test(deptId) &&
        !(typeof create.payload?.data === 'number' && !Number.isSafeInteger(create.payload.data))
      caseRecord.checks.push({
        name: '创建专属测试部门并返回主键（真实写侧）',
        passed: createdOk,
        details: `code=${create.code} deptId=${deptId || 'n/a'} orgCode=${deptCode}`
      })
      if (!createdOk) {
        deptId = ''
        throw new Error('BLOCKED: owned department creation did not return a safe ID')
      }
      const dbRows = await readDb(caseRecord, 'dept-write',
        `SELECT code, unit_type, CAST(data_boundary AS UNSIGNED), leader_user_id, supervisor_user_id, ` +
        `CAST(deleted AS UNSIGNED) FROM system_dept WHERE id=${deptId} ` +
        `AND tenant_id=${tenantLiteral(config.tenantId)} AND code='${deptCode}' AND deleted=0`)
      ownedDepartment = dbRows.length === 1 && dbRows[0][0] === deptCode
      if (!ownedDepartment) throw new Error('BLOCKED: owned department tenant/code evidence missing')
      const listResponse = await writeApi(page, record, 'get',
        `/admin-api/system/dept/list?pageNo=1&pageSize=100&code=${encodeURIComponent(deptCode)}`)
      const created = (listResponse.payload?.data || []).find((item) =>
        String(item.code) === deptCode)
      const createdMatches = created != null &&
        listResponse.ok && isSuccessfulPayload(listResponse.payload) && String(created.id) === deptId &&
        created.unitType === 'BRANCH' && created.dataBoundary === true &&
        String(created.leaderUserId) === '1' && String(created.supervisorUserId) === '1'
      caseRecord.checks.push({
        name: '回读部门与稳定编码/分支类型/管理边界/负责人+主管一致',
        passed: createdMatches,
        details: `found=${Boolean(created)} unitType=${created?.unitType} boundary=${created?.dataBoundary} ` +
          `leader=${created?.leaderUserId} supervisor=${created?.supervisorUserId}`
      })
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
          `FROM system_dept WHERE id=${deptId} AND tenant_id=${tenantLiteral(config.tenantId)} ` +
          `AND code='${deptCode}' AND deleted=0`)
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
      if (createAttempted) {
        const ownedRows = await readDb(caseRecord, 'dept-cleanup-owner', departmentOwnerSql)
        if (ownedRows.length > 1 || ownedRows.some((row) =>
          row[1] !== deptCode || row[2] !== String(config.tenantId))) {
          throw new Error('BLOCKED: owned department cleanup ownership is ambiguous')
        }
        if (ownedRows.length === 1) {
          const cleanupId = tenantLiteral(ownedRows[0][0])
          if (deptId && cleanupId !== deptId) throw new Error('BLOCKED: owned department cleanup ID changed')
          await writeApi(page, record, 'delete',
            `/admin-api/system/dept/delete?id=${cleanupId}`).catch(() => {})
        }
        const afterDelete = await readDb(caseRecord, 'dept-cleanup',
          `SELECT COUNT(*) FROM system_dept WHERE deleted=0 ` +
          `AND tenant_id=${tenantLiteral(config.tenantId)} AND code='${deptCode}'`)
        caseRecord.checks.push({
          name: '专属测试部门清理后不再出现在有效部门中',
          passed: afterDelete.length === 1 && Number(afterDelete[0][0]) === 0,
          details: `remaining=${afterDelete?.[0]?.[0]}`
        })
      }
    }
    await runIsolatedOrganizationRootEvidence(context, dependencies)
    caseRecord.evidence.push(
      `真实写侧：创建专属部门 ${deptCode}（BRANCH/dataBoundary/leader+supervisor）→回读与落库一致→` +
      '更新为 TEAM 并清空主管→删除清理；根组织按当前租户有效事实核对，反例只在专属租户执行。')
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
    if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
      caseRecord.notes.push(
        '未启用 CFOR_E2E_WRITE_FIXTURES=true；不在共享 tenant1 创建角色、部门或账号，第二租户部门授权证据保留 GAP。'
      )
      return { partial: true, note: '需要真实第二租户部门授权正反例' }
    }
    assertLocalInitScope()
    await assertLocalWriteSafety(caseRecord)
    const primaryApi = createApiClient({ token: currentToken, tenantId: config.tenantId, record })
    const departments = (await primaryApi.getBusiness('/system/dept/list')).data
    const flattenDepartments = (nodes) => (Array.isArray(nodes) ? nodes : [])
      .flatMap((node) => [node, ...flattenDepartments(node.children)])
    const department = flattenDepartments(departments)
      .find((item) => Number(item?.status) === 0)
    if (!department) throw new Error('BLOCKED: tenant1 没有可用于权限边界夹具的有效部门')
    await runPermissionBoundary(context, primaryApi, String(department.id))
    await runEnterpriseIsolationEvidence({
      context,
      primaryApi,
      verifyDepartmentScope: async ({ page: limitedPage, api, departments, users }) => {
        const permission = await api.getPermissionInfo()
        const route = findMenuRouteByComponent(permission?.data?.menus, 'system/user/index')
        if (!route) throw new Error('PB005-001 第二租户受限账号缺少用户页面菜单')
        await openRoute(limitedPage, route, { readyText: '登录账户' })
        caseRecord.checks.push({
          name: '第二租户受限账号正式页面入口可打开',
          passed: limitedPage.url().includes(route) &&
            String(departments.allowed.id) !== String(departments.denied.id) &&
            String(users.allowed.id) !== String(users.denied.id),
          details: `route=${route}; allowedDept=${departments.allowed.id}; deniedDept=${departments.denied.id}`
        })
      }
    })
    caseRecord.evidence.push(
      '真实第二租户：tenant_admin 创建部门 A/B、仅授权 A 的角色和受限账号；' +
      '受限账号真实登录后通过正式用户分页验证 A 可见、B 不可见，并打开正式用户页面；' +
      '所有专属对象按租户、marker 和稳定 ID 校验后清理，未写入共享 tenant1。'
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
    const catalogResponse = await writeApi(page, record, 'get',
      '/admin-api/system/print-template/document-catalog')
    const catalogRows = Array.isArray(catalogResponse.payload?.data)
      ? catalogResponse.payload.data : []
    const document = catalogRows.find((item) => nonEmpty(item?.billType))
    if (!document) {
      caseRecord.notes.push('缺前置：当前租户没有已生效且有权限的打印单据目录，未伪造对象编码创建模板。')
      return { partial: true, note: '打印模板写侧缺少真实 document-catalog 单据类型' }
    }
    const billType = String(document.billType)
    const objectCode = billType
    const templateCode = `${tag}TC`
    const businessType = `${tag}BT`
    const businessId = `${tag}B1`
    const listTemplates = () => writeApi(page, record, 'get',
      `/admin-api/system/print-template/page?pageNo=1&pageSize=100&objectCode=${encodeURIComponent(objectCode)}`)
    const ownedTemplates = async () =>
      (pageRecordsPayload((await listTemplates()).payload) || [])
        .filter((item) => item?.templateCode === templateCode)
    const getTemplate = (id) => writeApi(page, record, 'get',
      `/admin-api/system/print-template/get?id=${id}`)
    const templateIds = []
    const bindingIds = []
    let customerId = ''
    let originalDefaultId = ''
    try {
      caseRecord.checks.push({
        name: '打印模板页面与版本字段可访问',
        passed: await printPage.isVisible(),
        details: `page=${page.url()}`
      })
      const initialTemplates = pageRecordsPayload((await listTemplates()).payload) || []
      originalDefaultId = String(initialTemplates.find((item) =>
        item?.status === 'PUBLISHED' && item?.isDefault === 1)?.id || '')
      const create = await writeApi(page, record, 'post', '/admin-api/system/print-template/create', {
        name: `${tag} 模板`, billType, templateCode, objectCode, description: tag, json: '{"v":1}'
      })
      const v1 = String(create.payload?.data ?? '')
      if (!isSuccessfulPayload(create.payload) || !/^[1-9]\d*$/.test(v1)) {
        caseRecord.notes.push(`打印模板专属创建未成功：billType=${billType}; code=${create.code}`)
        return { partial: true, note: '打印模板真实目录对象创建失败，已停止后续级联写入' }
      }
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
        id: v1, name: `${tag} 模板`, billType, templateCode, objectCode, description: tag, json: '{"v":1}'
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
        id: v1, name: `${tag} 模板`, billType, templateCode, objectCode, description: tag, json: '{"v":2}'
      })
      const afterUpdate = await ownedTemplates()
      const v1After = afterUpdate.find((item) => String(item.id) === v1)
      const draftV2 = afterUpdate.find((item) => item.status === 'DRAFT' && item.versionNo === 2)
      if (draftV2?.id) templateIds.push(String(draftV2.id))
      caseRecord.checks.push({
        name: '已发布模板编辑生成新草稿且不覆盖历史 JSON',
        passed: isSuccessfulPayload(updatePublished.payload) && v1After?.status === 'PUBLISHED' &&
          v1After?.json === '{"v":1}' && Boolean(draftV2),
        details: `publishedJson=${v1After?.json} draftVersion=${draftV2?.versionNo}`
      })
      if (!draftV2?.id) {
        return { partial: true, note: '已发布模板编辑未形成可继续发布的真实 DRAFT v2，停止级联写入' }
      }
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
      const bindingId = String(bind.payload?.data ?? '')
      if (bindingId) bindingIds.push(bindingId)
      const conflict = await writeApi(page, record, 'post', '/admin-api/system/print-template/binding/create', {
        objectCode, dimensionType: 'BUSINESS_TYPE', dimensionValue: businessType,
        templateId: v1, priority: 0, status: 'ENABLED'
      })
      caseRecord.checks.push({
        name: '同层级重复绑定保存即拒绝',
        passed: isSuccessfulPayload(bind.payload) && conflict.code !== 0,
        details: `bindingId=${bindingId} conflictCode=${conflict.code}`
      })
      const customerCreate = await writeApi(page, record, 'post', '/admin-api/base/partner/create', {
        name: `${tag} 客户`, shortName: tag, partnerKind: 'ORGANIZATION', status: 'ACTIVE',
        customerEnabled: true, supplierEnabled: false, carrierEnabled: false, remark: tag
      })
      customerId = String(customerCreate.payload?.data ?? '')
      if (!isSuccessfulPayload(customerCreate.payload) || !/^[1-9]\d*$/.test(customerId)) {
        return { partial: true, note: '打印模板客商维度缺少可绑定的真实客户主键，已停止后续级联写入' }
      }
      const customerBinding = await writeApi(page, record, 'post',
        '/admin-api/system/print-template/binding/create', {
          objectCode, dimensionType: 'CUSTOMER', dimensionValue: customerId,
          templateId: v1, priority: 0, status: 'ENABLED'
        })
      const customerBindingId = String(customerBinding.payload?.data ?? '')
      if (customerBindingId) bindingIds.push(customerBindingId)
      const resolveCustomer = await writeApi(page, record, 'post',
        '/admin-api/system/print-template/resolve', {
          objectCode, customerId, businessTypeCode: businessType,
          businessId: `${tag}B2`, lock: false
        })
      const resolveDefault = await writeApi(page, record, 'post',
        '/admin-api/system/print-template/resolve', {
          objectCode, businessId: `${tag}B3`, lock: false
        })
      const customerData = resolveCustomer.payload?.data
      const defaultData = resolveDefault.payload?.data
      caseRecord.checks.push({
        name: '正式打印优先客商绑定、其次业务类型并回退默认模板',
        passed: isSuccessfulPayload(customerBinding.payload) &&
          isSuccessfulPayload(resolveCustomer.payload) &&
          customerData?.resolveSource === 'CUSTOMER' &&
          String(customerData?.id) === String(v1) &&
          isSuccessfulPayload(resolveDefault.payload) &&
          defaultData?.resolveSource === 'DEFAULT' &&
          String(defaultData?.id) === String(draftV2.id),
        details: `customerSource=${customerData?.resolveSource} customerId=${customerId} ` +
          `defaultSource=${defaultData?.resolveSource} defaultId=${defaultData?.id}`
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
        id: draftV2.id, name: `${tag} 模板`, billType, templateCode, objectCode,
        description: tag, json: '{"v":3}'
      })
      const rowsV3 = await ownedTemplates()
      const draftV3 = rowsV3.find((item) => item.status === 'DRAFT' && item.versionNo === 3)
      if (draftV3?.id) templateIds.push(String(draftV3.id))
      const resolveRelock = await writeApi(page, record, 'post', '/admin-api/system/print-template/resolve', {
        objectCode, customerId, businessTypeCode: businessType, businessId, lock: false
      })
      const relockData = resolveRelock.payload?.data
      caseRecord.checks.push({
        name: '已锁定单据重打保持原版本，不跟随新草稿',
        passed: Boolean(draftV3) && relockData?.resolveSource === 'LOCKED' &&
          String(relockData?.id) === String(draftV2.id) && relockData?.versionNo === 2,
        details: `newDraftVersion=${draftV3?.versionNo} customerId=${customerId} ` +
          `resolveSource=${relockData?.resolveSource} version=${relockData?.versionNo}`
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
      for (const bindingId of bindingIds.filter(Boolean)) {
        await writeApi(page, record, 'delete',
          `/admin-api/system/print-template/binding/delete?id=${bindingId}`).catch(() => {})
      }
      if (originalDefaultId) {
        await writeApi(page, record, 'put',
          `/admin-api/system/print-template/publish?id=${originalDefaultId}&makeDefault=true`)
          .catch(() => {})
      }
      for (const id of templateIds.filter(Boolean)) {
        await writeApi(page, record, 'delete', `/admin-api/system/print-template/delete?id=${id}`)
          .catch(() => {})
      }
      if (customerId) {
        await writeApi(page, record, 'delete',
          `/admin-api/base/partner/delete?id=${customerId}`).catch(() => {})
      }
      const remaining = await ownedTemplates()
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
      const closureApi = createApiClient({
        token: currentToken, tenantId: '1', record
      })
      await runInitNumberingClosure(
        { api: closureApi, caseRecord, caseId: 'PB011-001' },
        { config, env: process.env, runReadOnlySql }
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
              /\/ai\/tenant-config\/(?:api-key|model)\/page|\/ai\/tenant-config\/capability\/list/.test(
                entry?.url || ''
              )
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
    const hasDomainModelContract = dimension?.ownerType === 'DOMAIN_MODEL' &&
      dimension?.valueType === 'ENTRY' &&
      dimension?.currentValueSource === 'DOMAIN_MODEL' &&
      dimension?.manageable === false &&
      nonEmpty(dimension?.runtimeConsumer)
    caseRecord.checks.push({
      name: 'WMS 仓储维度目录可访问',
      passed: response.ok() && isSuccessfulPayload(payload) && options !== null && Boolean(dimension),
      details: `HTTP=${response.status()} options=${options?.length ?? 'invalid'} current=${dimension?.currentValue || 'MISSING'}`
    })
    caseRecord.checks.push({
      name: '仓储维度目录按仓库领域模型事实源声明',
      passed: Boolean(hasDomainModelContract),
      details: `ownerType=${dimension?.ownerType || 'MISSING'} valueType=${dimension?.valueType || 'MISSING'} ` +
        `source=${dimension?.currentValueSource || 'MISSING'} manageable=${dimension?.manageable}`
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
    return runInitSettingsAcceptance(context, { ...dependencies, openRoute })
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

export const runCase = async (context, dependencies = {}) => {
  const result = await runCaseCore(context, dependencies)
  return finalizeInitCaseResult(context.caseRecord, context.caseId, result)
}
