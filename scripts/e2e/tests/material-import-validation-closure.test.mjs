import assert from 'node:assert/strict'
import test from 'node:test'

import * as XLSX from 'xlsx'

import {
  __internal,
  buildInvalidMaterialImportWorkbook,
  materialImportValidationCheck,
  verifyMaterialImportValidationClosure
} from '../fixtures/material-import-validation-closure.mjs'

const headers = [
  '编码', '名称', '计量单位', '可采购', '可销售', '可生产',
  '保质期管理', '保质期天数', '提前期', '缓冲期', '档案形态', '来源'
]

test('PB032 import workbook uses the downloaded template headers and three non-persistent invalid rows', () => {
  const { buffer, rows } = buildInvalidMaterialImportWorkbook({ headers, marker: 'E2E-PB032-IMPORT-UNIT', unitName: '件' })
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const values = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' })
  assert.deepEqual(values[0], headers)
  assert.equal(rows.length, 3)
  assert.deepEqual(values.slice(1).map((row) => row[0]), rows.map((row) => row.code))
  assert.equal(values[1][2], '')
  assert.equal(values[2][3], '否')
  assert.equal(values[3][7], '0')
  assert.throws(() => buildInvalidMaterialImportWorkbook({ headers: ['编码'], marker: 'x', unitName: '件' }), /缺少必要列/)
})

test('PB032 import closure requires all three structured rejections and zero residual codes', async () => {
  let uploaded = false
  const api = {
    async upload (path, formData) {
      uploaded = true
      assert.equal(path, '/mes/basMaterial/import')
      assert.equal(formData.get('updateSupport'), 'false')
      assert.ok(formData.get('file') instanceof Blob)
      const workbook = XLSX.read(Buffer.from(await formData.get('file').arrayBuffer()), { type: 'buffer' })
      const values = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' })
      const codes = values.slice(1).map((row) => row[0])
      return {
        code: 0,
        data: {
          totalCount: 3, successCount: 0, failureCount: 0, skippedCount: 3,
          createMaterialNames: [], updateMaterialNames: [],
          failureMaterialNames: Object.fromEntries([
            [codes[0], '实物存货必须维护主单位'],
            [codes[1], '来源为外购时必须启用可采购能力'],
            [codes[2], '启用保质期管理时，保质期天数必须为正整数']
          ]),
          issues: [
            { code: codes[0], issueType: 'SKIPPED', reason: '实物存货必须维护主单位' },
            { code: codes[1], issueType: 'SKIPPED', reason: '来源为外购时必须启用可采购能力' },
            { code: codes[2], issueType: 'SKIPPED', reason: '启用保质期管理时，保质期天数必须为正整数' }
          ]
        }
      }
    },
    async getBusiness () { return { code: 0, data: { records: [] } } }
  }
  const caseRecord = { checks: [] }
  const result = await verifyMaterialImportValidationClosure({
    api, caseRecord, templateHeaders: headers, unit: { name: '件' }
  })
  assert.equal(uploaded, true)
  assert.equal(result.rows.length, 3)
  assert.deepEqual(caseRecord.checks, [{
    name: materialImportValidationCheck,
    passed: true,
    details: caseRecord.checks[0].details
  }])
})

test('PB032 import closure refuses incomplete response evidence or residual materials', async () => {
  const response = { code: 0, data: { totalCount: 3, successCount: 0, failureCount: 0, skippedCount: 3, issues: [], failureMaterialNames: {} } }
  assert.equal(__internal.responseHasOnlyExpectedRejections(response, __internal.invalidRows('E2E', '件')), false)
  await assert.rejects(() => verifyMaterialImportValidationClosure({
    api: {
      async upload () { return response },
      async getBusiness () { return { code: 0, data: { records: [{ code: 'residual' }] } } }
    },
    caseRecord: { checks: [] }, templateHeaders: headers, unit: { name: '件' }
  }), new RegExp(materialImportValidationCheck))
})
