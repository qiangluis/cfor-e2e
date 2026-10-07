import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  hasPausedWorkReadback,
  isPauseValidationRejection,
  pausedWorkRows,
  pauseWorkPageRows
} from '../suites/mes-prod-task-report.mjs'

const source = fs.readFileSync(new URL('../suites/mes-prod-task-report.mjs', import.meta.url), 'utf8')
const pause002 = source.slice(source.indexOf("if (caseId === 'MES-TASK-REPORT-002')"))

test('pause prerequisite pages accept legacy success and preserve valid empty pages', () => {
  const rows = [{ id: '2106200343998562305' }]
  assert.deepEqual(pauseWorkPageRows({
    code: 200, success: true, data: { records: rows, total: 1 }
  }), rows)
  assert.deepEqual(pauseWorkPageRows({ code: 0, data: { list: [], total: 0 } }), [])
  assert.deepEqual(pauseWorkPageRows({ code: 0, data: rows }), rows)
})

test('failed or malformed work pages cannot be reported as missing formal work', () => {
  for (const result of [
    undefined,
    { code: 500, data: { records: [], total: 0 } },
    { code: 200, success: false, data: { records: [], total: 0 } },
    { code: 0, data: null },
    { code: 0, data: { total: 0 } },
    { code: 0, data: { records: [], total: 2 } },
    { code: 0, data: { records: [{ id: '1' }], total: 0 } },
    { code: 0, data: { records: [{ id: '' }], total: 1 } }
  ]) {
    assert.throws(() => pauseWorkPageRows(result), /不能视为缺少正式单据/)
  }
})

test('only explicit pause mandatory-field errors count as negative validation evidence', () => {
  for (const message of ['暂停原因不能为空', '预计恢复时间不能为空']) {
    assert.equal(isPauseValidationRejection({ code: 500, msg: message }, message), true)
    for (const result of [
      undefined,
      { code: 0, msg: message },
      { code: 200, success: true, message },
      { code: 404, msg: '请求地址不存在' },
      { code: 500, msg: '工单不存在' },
      { code: 500, msg: '系统异常' }
    ]) {
      assert.equal(isPauseValidationRejection(result, message), false)
    }
  }
})

test('pause negative requests never target any real work or order ID', () => {
  assert.equal((pause002.match(/id: '__not_exists__'/g) || []).length, 2)
  assert.equal((pause002.match(/prodWorkOrderId: '__not_exists__'/g) || []).length, 2)
  assert.doesNotMatch(pause002, /works\[[^\]]+\]\.(?:id|prodOrderId)/)
  assert.doesNotMatch(pause002, /api\.(?:put|putBusiness|delete)\(|\/mes\/prodWork\/(?:start|resume|add)/)
})

test('empty lists or negative-only results cannot prove pause field readback', () => {
  const paused = {
    id: '2106200343998562305', status: 3,
    pauseReason: 'machine inspection', expectResumeTime: '2026-10-06 18:00:00'
  }
  assert.equal(hasPausedWorkReadback([]), false)
  assert.equal(hasPausedWorkReadback([{ ...paused, status: 2 }]), false)
  assert.equal(hasPausedWorkReadback([{ ...paused, pauseReason: ' ' }]), false)
  assert.equal(hasPausedWorkReadback([{ ...paused, expectResumeTime: 'invalid' }]), false)
  assert.equal(hasPausedWorkReadback([paused, { ...paused, pauseReason: '' }]), false)
  assert.equal(hasPausedWorkReadback([paused, { ...paused, status: '3' }]), true)
  assert.equal(pausedWorkRows([{ ...paused, status: ' 3 ' }]).length, 0)
  assert.match(pause002, /return pausedWorks\.length > 0/)
  assert.match(pause002, /partial: true/)
})

test('pause screenshots use the real work-order page and page-specific readiness control', () => {
  assert.match(pause002, /openRoute\(page, '\/mes\/produce\/work-order', \{/)
  assert.match(pause002, /readySelector: '\.search-form input\[placeholder="请输入工单编号"\]'/)
  assert.doesNotMatch(pause002, /passed: false/)
})
