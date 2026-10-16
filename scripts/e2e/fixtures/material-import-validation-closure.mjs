import { randomUUID } from 'node:crypto'

import * as XLSX from 'xlsx'

import { isBusinessSuccess } from '../lib/assertions.mjs'

const text = (value) => String(value ?? '').trim()
const dataOf = (response) => response?.data
const rowsOf = (response, label) => {
  if (!isBusinessSuccess(response)) throw new Error(`${label}读取失败`)
  const data = dataOf(response)
  const rows = Array.isArray(data?.records) ? data.records : data?.list
  if (!Array.isArray(rows)) throw new Error(`${label}未返回数组`)
  return rows
}
const addCheck = (record, name, passed, details) => {
  record.checks = [...(record.checks || []), { name, passed: Boolean(passed), details }]
  if (!passed) throw new Error(`${name}: ${details}`)
}

export const materialImportValidationCheck =
  '导入保存前执行 Base 档案形态、来源能力和库存控制校验'

export const materialImportRequiredHeaders = Object.freeze([
  '编码', '名称', '计量单位', '可采购', '可销售', '可生产',
  '保质期管理', '保质期天数', '提前期', '缓冲期', '档案形态', '来源'
])

export const materialImportExpectedIssues = Object.freeze({
  noUnit: /实物存货必须维护主单位/,
  purchaseCapability: /来源为外购时必须启用可采购能力/,
  periodDays: /启用保质期管理时，保质期天数必须为正整数/
})

const codeOf = (marker, suffix) => `${marker}-${suffix}`.slice(0, 64)
const exactHeaders = (headers) => {
  if (!Array.isArray(headers)) throw new Error('导入模板表头未返回数组')
  const normalized = headers.map(text).filter(Boolean)
  if (new Set(normalized).size !== normalized.length) throw new Error('导入模板存在重复表头')
  const missing = materialImportRequiredHeaders.filter((header) => !normalized.includes(header))
  if (missing.length) throw new Error(`导入模板缺少必要列：${missing.join('、')}`)
  return normalized
}
const invalidRows = (marker, unitName) => {
  const shared = {
    '档案形态': 'STOCK',
    '可销售': '否',
    '可生产': '否',
    '保质期管理': '否',
    '提前期': '1',
    '缓冲期': '1'
  }
  return [
    {
      code: codeOf(marker, 'NO-UNIT'),
      expected: materialImportExpectedIssues.noUnit,
      values: { ...shared, '名称': `${marker} 无主单位`, '可采购': '是', '来源': 'purchase' }
    },
    {
      code: codeOf(marker, 'PURCHASE-NO-CAPABILITY'),
      expected: materialImportExpectedIssues.purchaseCapability,
      values: { ...shared, '名称': `${marker} 外购能力`, '计量单位': unitName, '可采购': '否', '来源': 'purchase' }
    },
    {
      code: codeOf(marker, 'BAD-PERIOD'),
      expected: materialImportExpectedIssues.periodDays,
      values: {
        ...shared, '名称': `${marker} 非法保质期`, '计量单位': unitName, '可采购': '是',
        '来源': 'purchase', '保质期管理': '是', '保质期天数': '0'
      }
    }
  ]
}

export const buildInvalidMaterialImportWorkbook = ({ headers, marker, unitName }) => {
  const exact = exactHeaders(headers)
  if (!text(unitName)) throw new Error('缺少可复用启用计量单位名称')
  const rows = invalidRows(marker, text(unitName))
  const values = rows.map((row) => exact.map((header) => {
    if (header === '编码') return row.code
    return row.values[header] ?? ''
  }))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([exact, ...values]), '存货档案列表')
  return { buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rows }
}

const responseHasOnlyExpectedRejections = (response, rows) => {
  const data = dataOf(response)
  const issues = Array.isArray(data?.issues) ? data.issues : null
  const failureNames = data?.failureMaterialNames
  if (!issues || !failureNames || typeof failureNames !== 'object') return false
  return Number(data?.totalCount) === rows.length && Number(data?.successCount) === 0 &&
    Number(data?.failureCount) === 0 && Number(data?.skippedCount) === rows.length &&
    (!Array.isArray(data?.createMaterialNames) || data.createMaterialNames.length === 0) &&
    (!Array.isArray(data?.updateMaterialNames) || data.updateMaterialNames.length === 0) &&
    rows.every((row) => issues.some((issue) =>
      text(issue?.code) === row.code && text(issue?.issueType) === 'SKIPPED' && row.expected.test(text(issue?.reason)))) &&
    rows.every((row) => Object.values(failureNames).some((reason) => row.expected.test(text(reason))))
}

const codesAbsentFromPages = async (api, rows) => {
  for (const row of rows) {
    const found = rowsOf(await api.getBusiness(
      `/mes/basMaterial/list?pageNo=1&pageSize=100&code=${encodeURIComponent(row.code)}`
    ), '导入后物料分页').some((material) => text(material?.code) === row.code)
    if (found) return false
  }
  return true
}

/**
 * Uploads an all-invalid workbook so the formal import endpoint proves its
 * per-row validation and leaves no material record behind.
 */
export async function verifyMaterialImportValidationClosure ({ api, caseRecord, templateHeaders, unit }) {
  const marker = `E2E-PB032-IMPORT-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
  const { buffer, rows } = buildInvalidMaterialImportWorkbook({
    headers: templateHeaders,
    marker,
    unitName: unit?.name ?? unit
  })
  const formData = new FormData()
  formData.set('updateSupport', 'false')
  formData.set('file', new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), `${marker}.xlsx`)
  const response = await api.upload('/mes/basMaterial/import', formData)
  const absent = await codesAbsentFromPages(api, rows)
  const passed = isBusinessSuccess(response) && responseHasOnlyExpectedRejections(response, rows) && absent
  addCheck(caseRecord, materialImportValidationCheck, passed,
    `code=${response?.code}; total=${response?.data?.totalCount}; success=${response?.data?.successCount}; ` +
    `failure=${response?.data?.failureCount}; skipped=${response?.data?.skippedCount}; residualCodes=${!absent}`)
  return { marker, rows }
}

export const __internal = {
  exactHeaders,
  invalidRows,
  responseHasOnlyExpectedRejections
}
