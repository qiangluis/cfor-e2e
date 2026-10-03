import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from './config/index.mjs'
import { createApiClient } from './lib/api.mjs'
import { launchBrowser, login } from './lib/browser.mjs'
import { assertLocalDatabase, runReadOnlySql } from './lib/db.mjs'
import { createRunRecord, createCaseRecord, finishCase, writeReport } from './lib/report.mjs'

assert.equal(config.target, 'local', 'Numbering preparation is local-only')
assert.equal(config.tenantId, '1', 'Only the local acceptance tenant may be prepared')
assertLocalDatabase()

const record = createRunRecord({ selectedCases: ['PREP-PROC-NUMBER'] })
const caseRecord = createCaseRecord({
  id: 'PREP-PROC-NUMBER', suite: 'preparation', title: '本地测试租户请购编号前置'
})
record.cases.push(caseRecord)
const started = Date.now()
let handle

const snapshot = () => runReadOnlySql(`
  SELECT id, tenant_id, rule_code, version_no, status, rule_params,
         (effective_from IS NULL OR effective_from <= NOW()) AS is_effective
  FROM mes_sys_fill_rule
  WHERE tenant_id IN (0, 1) AND rule_code = 'erp_purchase_request_no'
  ORDER BY tenant_id, version_no
`)

try {
  const before = await snapshot()
  assert.equal(before.available, true, 'Local database evidence must be configured before preparation')
  caseRecord.database = [{ stage: 'before', ...before }]
  if (before.rows.length) {
    assert(before.rows.some((row) =>
      (row[4] === 'PUBLISHED' || row[4] === 'NULL') && row[6] === '1'
    ), 'Existing numbering configuration is not effective; do not overwrite or publish it automatically')
    caseRecord.checks.push({ name: '已有生效规则保持不变', passed: true })
  } else {
    handle = await launchBrowser({ record })
    const api = createApiClient({ token: await login(handle.page), record })
    const id = randomUUID().replaceAll('-', '')
    caseRecord.fixtures = [{ kind: 'purchase-request-numbering', id, tenantId: 1 }]
    // Reuse the historical purchase-request definition, never invent a new numbering convention.
    await api.postBusiness('/mes/fillRule/add', {
      id,
      tenantId: 1,
      ruleName: 'ERP管理-采购管理-采购申请',
      ruleCode: 'erp_purchase_request_no',
      ruleClass: 'tech.cfor17.module.bpm.handler.BillNoRule',
      ruleParams: JSON.stringify({ prefix: 'CGSQ', period: 'yyMMdd', seqLen: 3 }),
      status: 'DRAFT',
      effectiveFrom: Date.now() - 60000
    })
    await api.putBusiness(`/mes/fillRule/publish/${id}`)
    const response = await api.getBusiness(`/mes/fillRule/queryById?id=${id}`)
    const rule = response.data ?? response.result
    assert.equal(rule.id, id)
    assert.equal(String(rule.tenantId), '1')
    assert.equal(rule.status, 'PUBLISHED')
    const after = await snapshot()
    caseRecord.database.push({ stage: 'after', ...after })
    assert.equal(after.rows.length, 1)
    assert.equal(after.rows[0][0], id)
    assert.equal(after.rows[0][4], 'PUBLISHED')
    assert.equal(after.rows[0][6], '1')
    caseRecord.checks.push({
      name: '真实新增并发布仅租户 1 的请购规则，未修改平台模板或已有配置',
      passed: true,
      details: `ruleId=${id}; CGSQ + yyMMdd + seqLen=3`
    })
  }
  caseRecord.evidence.push(
    '规则参数来源为后端历史初始化数据；独立前置准备，不计入业务流程验收通过数'
  )
  finishCase(caseRecord, 'PASS')
} catch (error) {
  finishCase(caseRecord, 'FAIL', error.message)
} finally {
  await handle?.browser.close()
  caseRecord.durationMs = Date.now() - started
}
const report = await writeReport(record)
console.log(`[${caseRecord.status}] PREP-PROC-NUMBER report=${report.resultFile}`)
process.exitCode = record.passed ? 0 : 1
