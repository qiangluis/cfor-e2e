import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { matchesExpectedBusinessRejection, serverApiFailures } from '../lib/api.mjs'
import { __internal as quality } from '../suites/wms-quality.mjs'
import { __internal as transfer } from '../suites/wms-transfer.mjs'
import { __internal as borrow } from '../suites/wms-borrow.mjs'

const protectedResponses = {
  material: {
    success: false,
    code: 500,
    message: '存货 [E2E-WMS material] 被以下单据引用：库存记录，不允许删除'
  },
  location: {
    code: 1001001003,
    msg: '库位已被库存、未完成任务或未完成单据引用，不能删除或调整所属仓库/库区'
  },
  area: {
    code: 500,
    msg: '该库区下存在库位，请先删除库位后再删除库区！'
  },
  warehouse: {
    code: 500,
    msg: '已被引用，不能删除！'
  }
}

const cleanupPaths = [
  ['/mes/basMaterial/delete?id=material-1', 'material'],
  ['/mes/wms-house-location/delete?id=location-1', 'location'],
  ['/mes/wmsHouseArea/delete?id=area-1', 'area'],
  ['/mes/wmsWareHouse/delete?id=warehouse-1', 'warehouse']
]

const wrapperCases = [
  ['quality', quality.withCleanupRejectionContracts],
  ['transfer', transfer.withCleanupRejectionContracts],
  ['borrow', borrow.withCleanupRejectionContracts]
]

test('WMS suite cleanup wrappers declare only the matching protected-delete contract', async () => {
  for (const [suite, wrap] of wrapperCases) {
    const calls = []
    const wrapped = wrap({
      deleteBusiness: async (pathname, options) => {
        calls.push({ pathname, options })
        return protectedResponses[cleanupPaths.find(([path]) => path === pathname)?.[1]]
      }
    })

    for (const [pathname, responseKey] of cleanupPaths) {
      await wrapped.deleteBusiness(pathname, { expectedBusinessRejection: { code: 123 } })
      const options = calls.at(-1).options
      const expected = options.expectedBusinessRejection
      const response = protectedResponses[responseKey]
      assert.equal(expected.code, response.code, `${suite}:${responseKey} code`)
      assert.equal(expected.allowServiceCode, responseKey === 'location' ? undefined : true, `${suite}:${responseKey} service-code policy`)
      assert.equal(matchesExpectedBusinessRejection(response, expected), true, `${suite}:${responseKey} exact rejection`)
    }

    const passthrough = { expectedBusinessRejection: { code: 422001, message: 'unrelated' } }
    await wrapped.deleteBusiness('/wms/transfer-bill/delete?id=draft-1', passthrough)
    assert.deepEqual(calls.at(-1).options, passthrough, `${suite}: unrelated delete options`)
  }
})

test('WMS cleanup contracts reject wrong messages, wrong codes, and successful responses', () => {
  const expected = quality.expectedCleanupRejection('/mes/wmsWareHouse/delete?id=warehouse-1').expectedBusinessRejection
  for (const response of [
    { code: 500, msg: '系统异常' },
    { code: 503, msg: '已被引用，不能删除！' },
    { code: 500, msg: '其他业务拒绝' },
    { code: 0, data: { id: 'deleted' } }
  ]) {
    assert.equal(matchesExpectedBusinessRejection(response, expected), false)
  }
})

test('BR-001 over-return accepts only the legacy service-code business rejection', () => {
  const expected = borrow.borrowOverReturnRejection
  assert.equal(matchesExpectedBusinessRejection({
    code: 500,
    msg: '归还数量不能超过未归还数量'
  }, expected), true)
  for (const response of [
    { code: 500, msg: '系统异常' },
    { code: 500, msg: '其他归还失败' },
    { code: 503, msg: '归还数量不能超过未归还数量' },
    { code: 0, data: { id: 'success' } }
  ]) {
    assert.equal(matchesExpectedBusinessRejection(response, expected), false)
  }
})

test('QC-009 accepts only the declared legacy service-code validation message', () => {
  const expected = quality.qc009Rejection.expectedBusinessRejection
  assert.equal(matchesExpectedBusinessRejection({
    code: 500,
    msg: '业务出入库类型不存在或已停用：E2E_UNKNOWN_TEST'
  }, expected), true)
  for (const response of [
    { code: 500, msg: '系统异常' },
    { code: 500, msg: '业务出入库类型已存在' },
    { code: 503, msg: '业务出入库类型不存在或已停用' },
    { code: 0, data: { id: 'success' } }
  ]) {
    assert.equal(matchesExpectedBusinessRejection(response, expected), false)
  }
})

test('explicitly matched cleanup rejection is excluded from Node service failures', () => {
  const expected = quality.expectedCleanupRejection('/mes/basMaterial/delete?id=material-1').expectedBusinessRejection
  const entry = {
    status: 200,
    code: 500,
    expectedBusinessRejectionMatched: matchesExpectedBusinessRejection(protectedResponses.material, expected)
  }
  assert.equal(entry.expectedBusinessRejectionMatched, true)
  assert.deepEqual(serverApiFailures([entry]), [])
})

const verifiedRecord = (bindings) => ({
  checks: [...new Set(Object.values(bindings).flat())].map((name) => ({
    name, passed: true, details: `evidence:${name}`
  })),
  notes: []
})

test('TR-001 and BR-001 map every frozen catalog assertion to exact named runtime evidence', () => {
  for (const [label, mapper, bindings] of [
    ['TR-001', transfer.transferCatalogEvidence, transfer.transferCatalogBindings],
    ['BR-001', borrow.borrowCatalogEvidence, borrow.borrowCatalogBindings]
  ]) {
    const record = verifiedRecord(bindings)
    mapper(record)
    assert.equal(record.catalogAssertions.length, Object.keys(bindings).length, `${label}: catalog size`)
    assert.ok(record.catalogAssertions.every((item) => item.status === 'VERIFIED'), `${label}: mapped`)
    assert.deepEqual(record.remainingAssertions, [], `${label}: no remaining assertion`)
    assert.equal(record.passCandidate, true, `${label}: PASS candidate`)
  }
})

test('TR-001 and BR-001 mapping fails closed for missing, failed, or duplicate named evidence', () => {
  for (const [label, mapper, bindings] of [
    ['TR-001', transfer.transferCatalogEvidence, transfer.transferCatalogBindings],
    ['BR-001', borrow.borrowCatalogEvidence, borrow.borrowCatalogBindings]
  ]) {
    const missing = verifiedRecord(bindings)
    missing.checks.shift()
    mapper(missing)
    assert.equal(missing.passCandidate, false, `${label}: missing evidence`)
    assert.ok(missing.remainingAssertions.length > 0, `${label}: missing remains GAP`)

    const failed = verifiedRecord(bindings)
    failed.checks[0].passed = false
    mapper(failed)
    assert.equal(failed.passCandidate, false, `${label}: failed evidence`)

    const duplicate = verifiedRecord(bindings)
    duplicate.checks.push({ ...duplicate.checks[0] })
    mapper(duplicate)
    assert.equal(duplicate.passCandidate, false, `${label}: duplicate evidence`)
  }
})

test('BR-001 builds overdue workbench evidence from an owned fixture through the official update API', () => {
  const source = fs.readFileSync(new URL('../suites/wms-borrow.mjs', import.meta.url), 'utf8')
  assert.match(source, /putBusiness\('\/wms\/borrow-bill\/update'/)
  assert.match(source, /expectedReturnDate: overdueDate/)
  assert.match(source, /openRoute\(page, '\/index'/)
  assert.match(source, /todo-source-filter \.el-select/)
  assert.match(source, /todoItem\.click\(\)/)
  assert.match(source, /url\.searchParams\.get\('id'\) === String\(borrow\.id\)/)
  assert.match(source, /工作台仓库待办跳回带 marker 的借用详情/)
  assert.doesNotMatch(source, /UPDATE\s+wms_borrow_bill|borrowStatus\s*[:=]\s*['"]OVERDUE/)
})
