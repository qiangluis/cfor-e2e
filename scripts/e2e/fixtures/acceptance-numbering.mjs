import assert from 'node:assert/strict'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalDatabase, runReadOnlySql } from '../lib/db.mjs'

const definitions = Object.freeze({
  fin_cgap_bill_no: {
    name: '采购应付单编号',
    params: { prefix: 'CGAP-', period: 'yyMMdd-', seqLen: 3 }
  },
  fin_yshx_bill_no: {
    name: '应收核销单号',
    params: { prefix: 'YSHX-', period: 'yyMMdd-', seqLen: 3 }
  },
  fin_yfhx_bill_no: {
    name: '应付核销单号',
    params: { prefix: 'YFHX-', period: 'yyMMdd-', seqLen: 3 }
  },
  batch_no: {
    name: '批次',
    params: { prefix: 'BATCH-', period: 'yyMMdd-', seqLen: 3 }
  }
})
export const numberingDefinitionSource =
  'cfor-server/src/main/resources/db/legacy-migration/20260928/V202604141107__insert_data_mes_sys_fill_rule.sql'

export async function ensureAcceptanceNumbering(api, caseRecord, codes, dependencies = {}) {
  const settings = dependencies.config || config
  assert.equal(settings.target, 'local', 'Numbering preparation is local-only')
  assert.equal(String(settings.tenantId), '1', 'Only acceptance tenant 1 may be prepared')
  assert.equal(settings.tenantName, 'CFOR 标准平台', 'Unexpected acceptance tenant')
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083']]) {
    const url = new URL(base)
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === port && !url.username && !url.password, 'Only local acceptance endpoints are allowed')
  }
  assertLocalDatabase(settings.db)
  assert(Array.isArray(codes) && codes.length > 0 &&
    new Set(codes).size === codes.length &&
    codes.every((code) => Object.hasOwn(definitions, code)), 'Unsupported numbering preparation')
  const read = dependencies.runReadOnlySql || runReadOnlySql
  const snapshot = async (code, stage) => {
    const result = await read(`
      SELECT id, tenant_id, rule_code, version_no, status, rule_params,
             (effective_from IS NULL OR effective_from <= NOW()) AS is_effective
      FROM mes_sys_fill_rule
      WHERE tenant_id IN (0, 1) AND rule_code = '${code}'
      ORDER BY tenant_id, version_no`)
    assert.equal(result.available, true, 'Local database evidence must be available')
    assert(Array.isArray(result.rows) && result.rows.every((row) =>
      Array.isArray(row) && row.length === 7 && ['0', '1'].includes(row[1]) &&
      row[2] === code), 'Invalid numbering snapshot')
    caseRecord.database = [...(caseRecord.database || []), { stage: `${stage}:${code}`, ...result }]
    return result.rows
  }
  const effective = (row) => ['PUBLISHED', 'NULL'].includes(row[4]) && row[6] === '1'
  const before = new Map()
  // Preflight every rule before creating anything; existing inactive versions need review.
  for (const code of codes) {
    const rows = await snapshot(code, 'numbering-before')
    assert(!rows.length || rows.some(effective),
      `Existing ${code} configuration is not effective; never overwrite or publish it automatically`)
    before.set(code, rows)
  }
  for (const code of codes) {
    if (before.get(code).length) {
      caseRecord.notes.push(`保留已有生效编号规则 ${code}，未修改配置`)
      continue
    }
    const definition = definitions[code]
    assertBusinessSuccess(await api.postBusiness('/mes/fillRule/add', {
      ruleName: definition.name, ruleCode: code,
      ruleClass: 'tech.cfor17.module.bpm.handler.BillNoRule',
      ruleParams: JSON.stringify(definition.params),
      effectiveFrom: Date.now() - 60000
    }), `创建本地编号规则 ${code}`)
    // Management creation discards client IDs and returns a message, not an ID.
    const created = await snapshot(code, 'numbering-created')
    assert.equal(created.length, 1, 'Created rule must have a unique independent identity')
    const [id, tenant, , , status, params] = created[0]
    assert(/^[0-9a-f]{32}$/.test(id), 'Missing server-generated numbering identity')
    assert.equal(tenant, '1')
    assert.equal(status, 'DRAFT')
    assert.deepEqual(JSON.parse(params), definition.params)
    caseRecord.fixtures = [...(caseRecord.fixtures || []), {
      kind: 'acceptance-numbering', id, ruleCode: code, tenantId: 1
    }]
    assertBusinessSuccess(await api.putBusiness(`/mes/fillRule/publish/${id}`), `发布编号规则 ${code}`)
    const response = assertBusinessSuccess(
      await api.getBusiness(`/mes/fillRule/queryById?id=${id}`), `回读编号规则 ${code}`)
    const rule = response.data ?? response.result
    assert.equal(rule?.id, id)
    assert.equal(String(rule.tenantId), '1')
    assert.equal(rule.ruleCode, code)
    assert.equal(rule.status, 'PUBLISHED')
    assert.deepEqual(JSON.parse(rule.ruleParams), definition.params)
    const after = await snapshot(code, 'numbering-after')
    assert.equal(after.length, 1, 'Concurrent numbering changes must not be ignored')
    assert.equal(after[0][0], id)
    assert.equal(after[0][1], '1')
    assert(effective(after[0]))
    assert.deepEqual(JSON.parse(after[0][5]), definition.params)
    caseRecord.checks.push({
      name: `正式 API 补齐租户 1 缺失编号 ${code} 并验证生效`,
      passed: true, details: `ruleId=${id}; source=${numberingDefinitionSource}`
    })
    caseRecord.notes.push(`本地编号前置 ${code} 按历史参数新增并发布，保留供后续测试；不单独计为业务验收通过`)
  }
}
