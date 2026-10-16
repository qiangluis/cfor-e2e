import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  arrayPayload,
  applyInitCatalogEvidence,
  finalizeInitCaseResult,
  importTemplateHeaders,
  INIT_CASE_CATALOG_EVIDENCE,
  initRouteComponents,
  isSuccessfulPayload,
  LEGACY_MASTER_COUNT_TABLES,
  legacyMasterCountsSql,
  legacyProjectionAuditSql,
  legacySimpleProjectionSql,
  listPayload,
  MATERIAL_READINESS_ANOMALIES,
  materialReadinessAuditSql,
  organizationRootFactsSql,
  readinessItemsPayload,
  runIsolatedOrganizationRootEvidence,
  validateLegacyMasterCounts,
  validateLegacyProjectionViews,
  validateLegacySimpleProjections,
  validateMaterialReadiness,
  validateOrganizationRootReadiness
} from '../suites/init.mjs'
import * as XLSX from 'xlsx'
import {
  materialStockScenarioAssertionMap,
  materialStockScenarioCheckNames
} from '../fixtures/material-stock-scenario-closure.mjs'
import { localInitEvidence } from '../fixtures/init-local-closure.mjs'
import { initNumberingClosureChecks } from '../fixtures/init-numbering-closure.mjs'

test('init suite recognizes only successful CommonResult payloads', () => {
  assert.equal(isSuccessfulPayload({ code: 0, data: [] }), true)
  assert.equal(isSuccessfulPayload({ code: 200, success: true, data: [] }), true)
  assert.equal(isSuccessfulPayload({ code: 500, data: [] }), false)
  assert.equal(isSuccessfulPayload({ code: 0, success: false, data: [] }), false)
})

test('init suite preserves response shape and does not turn malformed data into empty evidence', () => {
  assert.deepEqual(listPayload({ code: 0, data: { list: [] } }), [])
  assert.equal(listPayload({ code: 0, data: { error: 'failed' } }), null)
  assert.deepEqual(arrayPayload({ code: 0, data: [] }), [])
  assert.equal(arrayPayload({ code: 0, data: { list: [] } }), null)
  assert.deepEqual(readinessItemsPayload({ code: 0, data: { items: [] } }), [])
  assert.equal(readinessItemsPayload({ code: 0, data: {} }), null)
})

test('init configuration routes resolve actual menu components, not obsolete paths', () => {
  assert.equal(initRouteComponents['/print/index'], 'print/index')
  assert.equal(initRouteComponents['/mes/base/fillRule'], 'mes/styCode/index')
  assert.equal(initRouteComponents['/base/material'], 'base/material/index')
})

test('material template evidence requires a parseable workbook and rejects text errors', () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['档案形态', '来源', '计量单位']
  ]), 'template')
  assert.deepEqual(importTemplateHeaders(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })),
    ['档案形态', '来源', '计量单位'])
  assert.equal(importTemplateHeaders(Buffer.from('{"code":500,"data":[]}')), null)
  assert.equal(importTemplateHeaders(Buffer.from('<html>Error</html>')), null)
})

test('every mapped catalog evidence check name exists in its actual suite or owned fixture', () => {
  const source = fs.readFileSync(new URL('../suites/init.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/init-numbering-closure.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../owned-init/fixtures.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/init-root-isolation.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/enterprise-isolation.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/material-import-validation-closure.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/material-validation-closure.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/material-commercial-validation-closure.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/material-bom-validation-closure.mjs', import.meta.url), 'utf8') +
    fs.readFileSync(new URL('../fixtures/material-stock-scenario-closure.mjs', import.meta.url), 'utf8')
  const stockCheckNames = new Set(Object.values(materialStockScenarioCheckNames))
  const numberingClosureCheckNames = new Set(Object.values(initNumberingClosureChecks))
  const dynamicCheckNames = new Set([
    '不存在菜单混合有效资源提交被整体拒绝',
    '已删除菜单混合有效资源提交被整体拒绝'
  ])
  for (const [caseId, mapping] of Object.entries(INIT_CASE_CATALOG_EVIDENCE)) {
    for (const [index, evidence] of Object.entries(mapping)) {
      for (const name of evidence.checks || []) {
        if (stockCheckNames.has(name)) {
          assert.ok(source.includes(name), `${caseId}[${index}] missing stock scenario check: ${name}`)
          continue
        }
        if (numberingClosureCheckNames.has(name)) {
          const property = Object.entries(initNumberingClosureChecks)
            .find(([, value]) => value === name)?.[0]
          assert.ok(property, `${caseId}[${index}] missing numbering closure property: ${name}`)
          assert.ok(source.includes(name), `${caseId}[${index}] missing numbering closure check: ${name}`)
          assert.ok(
            (source.match(new RegExp(`initNumberingClosureChecks\\.${property}`, 'g'))?.length || 0) >= 2,
            `${caseId}[${index}] missing numbering closure usage: ${name}`
          )
          continue
        }
        if (dynamicCheckNames.has(name)) {
          assert.match(source, /\$\{label\}菜单混合有效资源提交被整体拒绝/)
          continue
        }
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const occurrences = source.match(new RegExp(escaped, 'g'))?.length || 0
        assert.ok(occurrences >= 2, `${caseId}[${index}] missing actual check: ${name}`)
      }
    }
  }
})

test('PB001 and PB005 map their remaining isolation assertions to the independent enterprise fixture', () => {
  assert.deepEqual(INIT_CASE_CATALOG_EVIDENCE['PB001-001'][1], {
    checks: ['企业资料页展示生产贸易混合型选项']
  })
  assert.deepEqual(INIT_CASE_CATALOG_EVIDENCE['PB005-001'][5], {
    checks: ['第二租户部门数据范围正反例真实可见性']
  })
})

test('PB032-002 maps the four frozen assertions to their actual commercial inventory evidence', () => {
  const mapping = INIT_CASE_CATALOG_EVIDENCE['PB032-002']
  const expected = [
    materialStockScenarioAssertionMap.purchasePhysicalAndCapability,
    materialStockScenarioAssertionMap.salePhysicalAndCapability,
    materialStockScenarioAssertionMap.servicePurchaseOrderWithoutInventory,
    materialStockScenarioAssertionMap.virtualPhysicalMoveRejections
  ]
  for (const [index, checks] of expected.entries()) {
    assert.deepEqual(mapping[index].checks, [...checks, materialStockScenarioCheckNames.cleanup])
  }
})

test('catalog evidence marks a case complete only when every assertion has structured checks', () => {
  const complete = { checks: [] }
  const completeMapping = INIT_CASE_CATALOG_EVIDENCE['PB029-001']
  for (const evidence of Object.values(completeMapping)) {
    for (const name of evidence.checks || []) {
      complete.checks.push({ name, passed: true, details: 'contract-test' })
    }
  }
  assert.equal(applyInitCatalogEvidence(complete, 'PB029-001', completeMapping), true)
  assert.equal(complete.catalogComplete, true)
  assert.equal(complete.acceptanceComplete, true)
  assert.ok(complete.catalogAssertions.every((item) =>
    item.status === 'VERIFIED' && item.evidenceChecks.length > 0))

  const incomplete = { checks: [] }
  const incompleteMapping = INIT_CASE_CATALOG_EVIDENCE['PB001-001']
  for (const evidence of Object.values(incompleteMapping)) {
    for (const name of (evidence.checks || []).filter((value) =>
      value !== '企业资料页展示生产贸易混合型选项')) {
      incomplete.checks.push({ name, passed: true, details: 'contract-test' })
    }
  }
  // PB001-001 缺少专属 tenant_admin 浏览器选项证据时仍必须保持不完整。
  assert.equal(applyInitCatalogEvidence(incomplete, 'PB001-001', incompleteMapping), true)
  assert.equal(incomplete.catalogComplete, false)
  assert.equal(incomplete.acceptanceComplete, false)
})

test('catalog evidence rejects duplicate named checks instead of reusing ambiguous evidence', () => {
  const mapping = INIT_CASE_CATALOG_EVIDENCE['PB029-001']
  const checks = Object.values(mapping).flatMap((evidence) => evidence.checks || [])
    .map((name) => ({ name, passed: true, details: 'contract-test' }))
  checks.push({ ...checks[0] })
  const record = { checks }
  applyInitCatalogEvidence(record, 'PB029-001', mapping)
  assert.equal(record.catalogAssertions[0].status, 'GAP')
  assert.match(record.catalogAssertions[0].details, /具名检查不唯一/)
  assert.equal(record.acceptanceComplete, false)
})

test('finalizeInitCaseResult returns acceptanceComplete only for fully evidenced cases', () => {
  const complete = { checks: [] }
  const completeMapping = INIT_CASE_CATALOG_EVIDENCE['PB029-001']
  for (const evidence of Object.values(completeMapping)) {
    for (const name of evidence.checks || []) {
      complete.checks.push({ name, passed: true, details: 'contract-test' })
    }
  }
  const completeResult = finalizeInitCaseResult(complete, 'PB029-001', { designed: true })
  assert.equal(completeResult.acceptanceComplete, true)
  assert.equal(completeResult.partial, false)

  const incomplete = { checks: [] }
  const incompleteMapping = INIT_CASE_CATALOG_EVIDENCE['PB009-001']
  for (const evidence of Object.values(incompleteMapping)) {
    for (const name of evidence.checks || []) {
      incomplete.checks.push({ name, passed: true, details: 'contract-test' })
    }
  }
  const incompleteResult = finalizeInitCaseResult(incomplete, 'PB009-001', {
    designed: true,
    note: '精确阻塞：缺少可安全运行的 Flowable 实例'
  })
  assert.equal(incompleteResult.acceptanceComplete, false)
  assert.equal(incompleteResult.partial, true)
  assert.match(incompleteResult.note, /精确阻塞/)
  assert.match(incompleteResult.note, /Flowable/)
})

test('init finalization retains the isolated enterprise closure evidence mapping', () => {
  for (const [caseId, mapping] of Object.entries(localInitEvidence)) {
    const names = [...new Set(Object.values(mapping).flatMap((entry) => entry.checks))]
    const record = {
      checks: names.map((name) => ({ name, passed: true, details: 'isolated closure' }))
    }
    const result = finalizeInitCaseResult(record, caseId, { acceptanceComplete: true })
    assert.equal(result.acceptanceComplete, true, caseId)
    assert.equal(result.partial, false, caseId)
    assert.ok(record.catalogAssertions.every((entry) => entry.status === 'VERIFIED'), caseId)
    record.checks[0].passed = false
    assert.equal(finalizeInitCaseResult(record, caseId, result).acceptanceComplete, false, caseId)
  }
})

const readOnlySql = (sql) => {
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|REPLACE)\b/i)
}

test('PB029 counts use exactly the six tenant/deletion predicates from the formal audit mapper', () => {
  const sql = legacyMasterCountsSql(1)
  readOnlySql(sql)
  for (const [field, table] of Object.entries(LEGACY_MASTER_COUNT_TABLES)) {
    assert.match(sql, new RegExp(`'${field}', COUNT\\(\\*\\) FROM ${table}\\s+WHERE tenant_id=1 AND deleted=0`))
  }
  assert.throws(() => legacyMasterCountsSql('1 OR 1=1'), /BLOCKED/)
  assert.throws(() => legacyMasterCountsSql(9007199254740992), /BLOCKED/)
})

test('PB029 rejects one wrong count, unscoped totals, duplicate rows and missing fields', () => {
  const fields = Object.keys(LEGACY_MASTER_COUNT_TABLES)
  const summary = Object.fromEntries(fields.map((field, index) => [field, index + 1]))
  const rows = fields.map((field) => [field, String(summary[field])])
  assert.equal(validateLegacyMasterCounts(summary, rows).valid, true)
  for (const field of fields) {
    assert.equal(validateLegacyMasterCounts({ ...summary, [field]: summary[field] + 1 }, rows).valid, false, field)
  }
  assert.equal(validateLegacyMasterCounts(summary, [...rows, rows[0]]).valid, false)
  assert.equal(validateLegacyMasterCounts(summary, rows.slice(1)).valid, false)
  assert.equal(validateLegacyMasterCounts({ ...summary, legacyProductCount: null }, rows).valid, false)
})

const projectionMetadata = () => [
  ['erp_product', 'select cast(id as char), case when is_enabled=1 then 0 else 1 end, tenant_id, deleted from `cfor_admin_standard`.`mes_bas_material`', 'NO'],
  ['erp_product_category', 'select case when is_enabled=1 then 0 else 1 end, tenant_id, deleted from `mes_bas_material_category`', 'NO'],
  ['erp_product_unit', 'select case when is_enabled=1 then 0 else 1 end, tenant_id, deleted from `mes_bas_unit`', 'NO']
]
const projectionAuditRows = () => ['erp_product', 'erp_product_category', 'erp_product_unit']
  .flatMap((view) => ['mismatch', 'orphan', 'duplicate'].map((suffix) => [`${view}-${suffix}`, '0']))

test('PB029 projection SQL checks every canonical column, missing rows, extra rows and duplicate IDs', () => {
  const sql = legacyProjectionAuditSql(1)
  readOnlySql(sql)
  for (const column of [
    'id', 'name', 'bar_code', 'category_id', 'unit_id', 'status', 'standard', 'remark',
    'expiry_day', 'weight', 'purchase_price', 'sale_price', 'min_price', 'creator', 'create_time',
    'updater', 'update_time', 'deleted', 'tenant_id', 'parent_id', 'has_child', 'fullname',
    'code', 'sort', 'version'
  ]) assert.match(sql, new RegExp(`BINARY v\\.${column} <=> BINARY e\\.${column}`), column)
  assert.match(sql, /NOT EXISTS/)
  assert.match(sql, /HAVING COUNT\(\*\)>1/)
  assert.match(sql, /m\.tenant_id=1/)
  assert.match(sql, /c\.tenant_id=1/)
  assert.match(sql, /u\.tenant_id=1/)
})

test('PB029 view evidence rejects writable views, wrong sources, unreadable definitions and data drift', () => {
  const metadata = projectionMetadata()
  const rows = projectionAuditRows()
  assert.equal(validateLegacyProjectionViews(metadata, rows).valid, true)
  for (let index = 0; index < metadata.length; index++) {
    const writable = structuredClone(metadata)
    writable[index][2] = 'YES'
    assert.equal(validateLegacyProjectionViews(writable, rows).valid, false)
  }
  const wrongSource = structuredClone(metadata)
  wrongSource[0][1] = wrongSource[0][1].replace('mes_bas_material`', 'legacy_material`')
  assert.equal(validateLegacyProjectionViews(wrongSource, rows).valid, false)
  const missingDefinition = structuredClone(metadata)
  missingDefinition[0][1] = null
  assert.equal(validateLegacyProjectionViews(missingDefinition, rows).valid, false)
  for (let index = 0; index < rows.length; index++) {
    const drift = structuredClone(rows)
    drift[index][1] = '1'
    assert.equal(validateLegacyProjectionViews(metadata, drift).valid, false, rows[index][0])
  }
  assert.equal(validateLegacyProjectionViews(metadata, rows.slice(1)).valid, false)
  assert.equal(validateLegacyProjectionViews(metadata, [...rows, rows[0]]).valid, false)
})

function simpleProjectionEvidence () {
  const lists = {
    product: [{ id: '2108246701542690817', name: 'M', barCode: null, categoryId: '3', unitId: '4',
      purchasePrice: 2.5, salePrice: 3, minPrice: null }],
    category: [{ id: '3', name: 'C', parentId: '0' }],
    unit: [{ id: '4', name: 'U' }]
  }
  const rows = Object.entries(lists).flatMap(([kind, items]) =>
    items.map((item) => [kind, JSON.stringify({
      ...item, ...(kind === 'product' ? { purchasePrice: '2.500000', salePrice: '3.000000' } : {})
    })]))
  return { lists, rows }
}

test('PB029 simple-list SQL follows enabled Base projections and preserves snowflake IDs as strings', () => {
  const sql = legacySimpleProjectionSql(1)
  readOnlySql(sql)
  assert.match(sql, /m\.tenant_id=1 AND m\.deleted=0 AND m\.is_enabled = '1'/)
  assert.match(sql, /c\.tenant_id=1 AND c\.deleted=0 AND c\.is_enabled = 1/)
  assert.match(sql, /u\.tenant_id=1 AND u\.deleted=0 AND u\.is_enabled = 1/)
  assert.match(sql, /JSON_OBJECT/)
  assert.match(sql, /CAST\(m\.id AS CHAR\)/)
})

test('PB029 simple-list comparison rejects changed names/IDs/fields, extras, duplicates and malformed rows', () => {
  const { lists, rows } = simpleProjectionEvidence()
  assert.equal(validateLegacySimpleProjections(lists, rows).valid, true)
  for (const [kind, field, value] of [
    ['product', 'id', '1'], ['product', 'categoryId', null], ['product', 'purchasePrice', 9],
    ['category', 'parentId', '1'], ['unit', 'name', 'wrong']
  ]) {
    const changed = structuredClone(lists)
    changed[kind][0][field] = value
    assert.equal(validateLegacySimpleProjections(changed, rows).valid, false, `${kind}.${field}`)
  }
  const unsafe = structuredClone(lists)
  unsafe.product[0].id = Number(unsafe.product[0].id)
  assert.equal(validateLegacySimpleProjections(unsafe, rows).valid, false)
  assert.equal(validateLegacySimpleProjections({ ...lists, unit: [] }, rows).valid, false)
  assert.equal(validateLegacySimpleProjections({ ...lists, unit: [...lists.unit, ...lists.unit] }, rows).valid, false)
  assert.equal(validateLegacySimpleProjections({ ...lists, unit: null }, rows).valid, false)
  assert.equal(validateLegacySimpleProjections(lists, [...rows, ['unit', '{broken']]).valid, false)
  const omittedNull = structuredClone(lists)
  delete omittedNull.product[0].barCode
  delete omittedNull.product[0].minPrice
  assert.equal(validateLegacySimpleProjections(omittedNull, rows).valid, true)
  delete omittedNull.product[0].purchasePrice
  assert.equal(validateLegacySimpleProjections(omittedNull, rows).valid, false)
})

test('PB029 empty projections remain a sample gap even when empty API and DB sets agree', () => {
  const result = validateLegacySimpleProjections({ product: [], category: [], unit: [] }, [])
  assert.equal(result.valid, true)
  assert.deepEqual(result.missingSamples, ['product', 'category', 'unit'])
  const mapping = INIT_CASE_CATALOG_EVIDENCE['PB029-001']
  const record = { checks: Object.values(mapping).flatMap((entry) => entry.checks || [])
    .filter((name) => name !== '旧产品/单位/分类启用读列表与 Base 投影逐行一致')
    .map((name) => ({ name, passed: true, details: 'unit-test only' })) }
  assert.equal(finalizeInitCaseResult(record, 'PB029-001').acceptanceComplete, false)
  assert.deepEqual(record.remainingAssertions.map((item) => item.index), [2])
})

function materialRows (values = {}) {
  return ['total', 'invalid-total', ...Object.keys(MATERIAL_READINESS_ANOMALIES),
    ...['stock-no-unit', 'bad-source', 'stock-bad-period', 'non-stock-inventory'].map((key) => `exclusive-${key}`)]
    .map((key) => [key, String(values[key] ?? 0)])
}

test('PB032 SQL counts the union of bad materials once and keeps inventory subqueries tenant-scoped', () => {
  const sql = materialReadinessAuditSql(1)
  readOnlySql(sql)
  assert.match(sql, /'invalid-total', COUNT\(\*\)/)
  assert.match(sql, /inv\.tenant_id=m\.tenant_id AND inv\.material_id=m\.id AND inv\.deleted=0/)
  assert.match(sql, /pending_putaway_qty/)
  assert.equal((sql.match(/m\.tenant_id=1 AND m\.deleted=0/g) || []).length, 12)
  assert.match(sql, /'exclusive-stock-no-unit'/)
  assert.match(sql, /AND NOT/)
})

test('PB032 exact unique anomaly count cannot be replaced by maximum category count or a lower bound', () => {
  const rows = materialRows({ total: 10, 'invalid-total': 5, 'stock-no-unit': 3, 'bad-source': 3 })
  assert.equal(validateMaterialReadiness({ count: 10, status: 'INCOMPLETE', reason: '存在 5 个不合规的存货' }, rows).valid, true)
  for (const reported of [3, 4, 6]) {
    assert.equal(validateMaterialReadiness({
      count: 10, status: 'INCOMPLETE', reason: `存在 ${reported} 个不合规的存货`
    }, rows).valid, false)
  }
  assert.equal(validateMaterialReadiness({ count: 10, status: 'READY' }, rows).valid, false)
})

test('PB032 recognizes the actual healthy/empty response contract without inventing anomaly coverage', () => {
  const healthy = validateMaterialReadiness({
    count: 10, status: 'READY', reason: '存货档案形态、来源能力与库存控制已配置'
  }, materialRows({ total: 10 }))
  assert.equal(healthy.valid, true)
  assert.equal(healthy.missingCategories.length, 4)
  assert.equal(validateMaterialReadiness({ count: 0, status: 'NOT_STARTED' }, materialRows()).valid, true)
  assert.equal(validateMaterialReadiness({ count: 0, status: 'READY' }, materialRows()).valid, false)
  assert.equal(validateMaterialReadiness({ count: 10, status: 'UNKNOWN' }, materialRows({ total: 10 })).valid, false)
})

test('PB032 requires all four real anomaly categories, complete SQL rows and consistent totals', () => {
  const rows = materialRows({
    total: 8, 'invalid-total': 4, 'stock-no-unit': 1, 'bad-source': 1,
    'stock-bad-period': 1, 'non-stock-inventory': 1,
    'exclusive-stock-no-unit': 1, 'exclusive-bad-source': 1,
    'exclusive-stock-bad-period': 1, 'exclusive-non-stock-inventory': 1
  })
  const item = { count: 8, status: 'INCOMPLETE', reason: '存在 4 个不合规的存货' }
  assert.deepEqual(validateMaterialReadiness(item, rows).missingCategories, [])
  assert.equal(validateMaterialReadiness(item, rows).valid, true)
  assert.equal(validateMaterialReadiness(item, rows.slice(1)).valid, false)
  assert.equal(validateMaterialReadiness(item, [...rows, rows[0]]).valid, false)
  assert.equal(validateMaterialReadiness(item, materialRows({
    total: 8, 'invalid-total': 4, 'stock-no-unit': 9
  })).valid, false)
})

test('PB032 overlapping stock anomalies cannot close distinct four-category counterexamples', () => {
  const rows = materialRows({
    total: 2, 'invalid-total': 2, 'stock-no-unit': 1, 'bad-source': 1,
    'stock-bad-period': 1, 'non-stock-inventory': 1, 'exclusive-non-stock-inventory': 1
  })
  const result = validateMaterialReadiness({ count: 2, status: 'INCOMPLETE', reason: '存在 2 个不合规的存货' }, rows)
  assert.equal(result.valid, true)
  assert.equal(result.missingCategories.length, 3)
})

test('PB032 mapped readiness stays PARTIAL without real four-category evidence or preset samples', () => {
  const mapping = INIT_CASE_CATALOG_EVIDENCE['PB032-005']
  for (const missing of [
    '主单位/来源/保质期/非实物库存四类异常取得真实识别证据',
    '初始化预置存货显式写入 STOCK 档案形态'
  ]) {
    const record = { checks: Object.values(mapping).flatMap((entry) => entry.checks || [])
      .filter((name) => name !== missing).map((name) => ({ name, passed: true, details: 'unit-test only' })) }
    assert.equal(finalizeInitCaseResult(record, 'PB032-005').acceptanceComplete, false, missing)
    assert.ok(record.remainingAssertions.length > 0)
  }
})

test('PB032 WMS rejection evidence cannot upgrade PB032-005 readiness', () => {
  const materialMapping = INIT_CASE_CATALOG_EVIDENCE['PB032-001']
  const readinessMapping = INIT_CASE_CATALOG_EVIDENCE['PB032-005']
  const record = { checks: Object.values(materialMapping).flatMap((entry) => entry.checks || [])
    .map((name) => ({ name, passed: true, details: 'material closure only' })) }
  assert.equal(finalizeInitCaseResult(record, 'PB032-005').acceptanceComplete, false)
  assert.ok(readinessMapping[1].checks.includes('主单位/来源/保质期/非实物库存四类异常取得真实识别证据'))
})

const rootItem = (count, status = count > 0 ? 'READY' : 'NOT_STARTED') => ({
  key: 'system.organization-root', selected: true, skippable: false, count, status
})
const rootRows = (active, all = active) => [['active-root', String(active)], ['all-root', String(all)]]

test('PB003 effective root evidence requires current tenant, non-deleted, enabled root facts', () => {
  const sql = organizationRootFactsSql(1)
  readOnlySql(sql)
  assert.match(sql, /tenant_id=1 AND deleted=0 AND parent_id=0 AND status=0/)
  assert.equal(validateOrganizationRootReadiness(rootItem(2), rootRows(2)).valid, true)
  assert.equal(validateOrganizationRootReadiness(rootItem(0), rootRows(0, 1)).valid, true)
  assert.equal(validateOrganizationRootReadiness(rootItem(1), rootRows(0, 1)).valid, false)
  assert.equal(validateOrganizationRootReadiness(rootItem(0, 'READY'), rootRows(0)).valid, false)
  assert.equal(validateOrganizationRootReadiness({ key: 'system.organization-root' }, rootRows(1)).valid, false)
  assert.equal(validateOrganizationRootReadiness({ ...rootItem(1), selected: false }, rootRows(1)).valid, false)
  assert.equal(validateOrganizationRootReadiness(rootItem(1), [...rootRows(1), rootRows(1)[0]]).valid, false)
})

test('PB003 wrapper enforces local write guards before entering the fresh root lifecycle', async () => {
  const calls = []
  const context = { caseRecord: { checks: [], notes: [], database: [] }, record: { api: [] } }
  const dependencies = {
    config: { target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
      apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
      db: { name: 'cfor_admin_standard' } },
    writeFixturesEnabled: true,
    async assertWriteSafety () { calls.push('PREFLIGHT') },
    adminApi: {},
    async runRootIsolation (receivedContext, options) {
      calls.push('FRESH')
      assert.equal(receivedContext, context)
      assert.equal(options.adminApi, dependencies.adminApi)
      assert.equal(options.factsSql, organizationRootFactsSql)
      assert.equal(options.validateReadiness, validateOrganizationRootReadiness)
      return { executed: true }
    }
  }
  assert.deepEqual(await runIsolatedOrganizationRootEvidence(context, dependencies), { executed: true })
  assert.deepEqual(calls, ['PREFLIGHT', 'FRESH'])
  calls.length = 0
  assert.deepEqual(await runIsolatedOrganizationRootEvidence(context,
    { ...dependencies, writeFixturesEnabled: false }), { executed: false })
  assert.deepEqual(calls, [])
  assert.match(context.caseRecord.notes.join('; '), /GAP/)
  await assert.rejects(runIsolatedOrganizationRootEvidence(context,
    { ...dependencies, config: { ...dependencies.config, target: 'production' } }), /仅允许|local|本地/)
  assert.deepEqual(calls, [])
  await assert.rejects(runIsolatedOrganizationRootEvidence(context, {
    ...dependencies,
    async assertWriteSafety () { throw new Error('unsafe jobs') }
  }), /unsafe jobs/)
  assert.deepEqual(calls, [])
})

test('PB003 root key alone or missing isolated negative evidence cannot upgrade the catalog assertion', () => {
  const mapping = INIT_CASE_CATALOG_EVIDENCE['PB003-001']
  const names = [...new Set(Object.values(mapping).flatMap((entry) => entry.checks || []))]
  const record = { checks: names.filter((name) => name !== '专属租户验证无根/有效根/停用根并清理本轮根组织')
    .map((name) => ({ name, passed: true, details: 'unit-test only' })) }
  assert.equal(finalizeInitCaseResult(record, 'PB003-001').acceptanceComplete, false)
  assert.deepEqual(record.remainingAssertions.map((item) => item.index), [4])
})
