import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { dimensionContracts } from '../fixtures/wms-dimension-closure.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

test('warehouse dimension contracts never accept generic service errors', () => {
  for (const contract of Object.values(dimensionContracts)) {
    assert.equal(matchesExpectedBusinessRejection({ code: 500, msg: contract.message.source }, contract), false)
    assert.equal(matchesExpectedBusinessRejection({ code: 503, msg: '系统异常' }, contract), false)
  }
  assert.equal(matchesExpectedBusinessRejection({
    code: 1001001004,
    msg: '仓库(9007199254740993)的库区维度已被库存、未完成任务或未完成单据引用，不能关闭库区开关'
  }, dimensionContracts.area), true)
})

test('browser persistence uses real save, reload and string snowflake ID', () => {
  const source = fs.readFileSync(new URL('../fixtures/wms-warehouse-browser.mjs', import.meta.url), 'utf8')
  assert.match(source, /Promise\.all/)
  assert.match(source, /page\.reload/)
  assert.match(source, /String\(request\.id\)/)
  assert.doesNotMatch(source, /Number\(request\.id\)/)
})
