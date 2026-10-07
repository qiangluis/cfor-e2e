import assert from 'node:assert/strict'
import test from 'node:test'

import {
  arrayPayload,
  importTemplateHeaders,
  initRouteComponents,
  isSuccessfulPayload,
  listPayload,
  readinessItemsPayload
} from '../suites/init.mjs'
import * as XLSX from 'xlsx'

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
