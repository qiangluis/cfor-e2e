import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { isMissingProductionWork, productionPageRows } from '../suites/mes-production.mjs'
import { caseOutcome } from '../lib/report.mjs'

const source = fs.readFileSync(new URL('../suites/mes-production.mjs', import.meta.url), 'utf8')
const production001 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-001')"),
  source.indexOf("if (caseId === 'MES-PROD-002')")
)
const production002 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-002')"),
  source.indexOf("if (caseId === 'MES-PROD-003')")
)

test('production pages accept CommonResult and legacy Result without losing string IDs', () => {
  const rows = [{ id: '2106200343998562305' }]
  assert.deepEqual(productionPageRows({ code: 0, data: { list: rows, total: 1 } }, 'work'), rows)
  assert.deepEqual(productionPageRows({
    code: 200, success: true, data: { records: rows, total: 1 }
  }, 'work'), rows)
  assert.deepEqual(productionPageRows({ code: 0, data: rows }, 'work'), rows)
  assert.deepEqual(productionPageRows({
    code: 200, success: true, data: { records: [], total: 0 }
  }, 'work'), [])
})

test('production errors, malformed pages and inconsistent totals cannot become empty prerequisites', () => {
  for (const result of [
    undefined,
    { code: 200, success: false, data: { records: [], total: 0 } },
    { code: 404, data: { records: [], total: 0 } },
    { code: 0, data: null },
    { code: 0, data: { total: 0 } },
    { code: 0, data: { records: [], total: 1 } },
    { code: 0, data: { records: [{ id: '1' }], total: 0 } },
    { code: 0, data: { records: [{}], total: 1 } },
    { code: 0, data: { records: Array.from({ length: 101 }, (_, id) => ({ id })), total: 101 } }
  ]) {
    assert.throws(() => productionPageRows(result, 'work'), /不能视为缺少正式单据/)
  }
})

test('route/task rejection must identify the missing work rather than missing input or system errors', () => {
  assert.equal(isMissingProductionWork({ code: 500, msg: '工单不存在' }), true)
  for (const result of [
    undefined,
    { code: 0 },
    { code: 200, success: true },
    { code: 404, msg: '请求地址不存在' },
    { code: 500, msg: '工单编号为空' },
    { code: 500, msg: '系统异常' }
  ]) {
    assert.equal(isMissingProductionWork(result), false)
  }
  assert.match(production001, /prodWorkOrderId: '__not_exists__'/)
  assert.match(production001, /\/mes\/prodWorkTask\/list\?pageNo=1&pageSize=100/)
  assert.doesNotMatch(production001, /scheduleProduct|generateWorkTicket/)
})

test('production pages wait for real page controls, not sidebar workbench text', () => {
  assert.match(production001, /openRoute\(page, '\/mes\/produce\/order', \{/)
  assert.match(production001, /readySelector: '\.search-form input\[placeholder="请输入计划单号"\]'/)
  assert.match(production002, /openRoute\(page, '\/mes\/produce\/work-order', \{/)
  assert.match(production002, /readySelector: '\.search-form input\[placeholder="请输入工单编号"\]'/)
})

test('read-only production and material issue probes remain PARTIAL and never create stock documents', () => {
  for (const branch of [production001, production002]) {
    assert.match(branch, /partial: true/)
    assert.equal(caseOutcome({
      failedChecks: [], hasAssertions: true, result: { partial: true }
    }).status, 'PARTIAL')
  }
  assert.doesNotMatch(production002, /api\.(?:request|post|postBusiness|put|putBusiness|delete)\(/)
  assert.equal(caseOutcome({
    failedChecks: [{ passed: false }], hasAssertions: true, result: { partial: true }
  }).status, 'FAIL')
})
