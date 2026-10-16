import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  PROCUREMENT_014_ORIGINAL_ASSERTIONS,
  PROCUREMENT_014_ORIGINAL_EVIDENCE,
  PROCUREMENT_014_ORGANIZATION_SCOPE,
  PROCUREMENT_014_ORGANIZATION_WIRING,
  auditProcurement014OriginalAssertions,
  evaluateProcurement014OrganizationScope,
  locateProcurement014WiringAnchors,
  procurement014OrganizationScopeOf,
  runProcurement014OrganizationScopeProbe
} from '../fixtures/procurement-014-organization-scope.mjs'

const expected = Object.freeze({
  tenantId: '1',
  requestId: '2100000000000000001',
  billNo: 'AUTOTEST-PROC-014-ORG-001',
  orgId: '1001',
  sysOrgCode: 'ORG-A'
})
const sameOrgViewer = Object.freeze({
  userId: '2100000000000000002',
  tenantId: '1',
  orgId: '1001',
  sysOrgCode: 'ORG-A',
  permissions: ['', 'erp:purchase-order-request:query']
})
const foreignOrgViewer = Object.freeze({
  userId: '2100000000000000003',
  tenantId: '1',
  orgId: '1002',
  sysOrgCode: 'ORG-B',
  permissions: ['', 'erp:purchase-order-request:query']
})
const sourceRow = (overrides = {}) => ({
  id: expected.requestId,
  billNo: expected.billNo,
  tenantId: expected.tenantId,
  orgId: expected.orgId,
  sysOrgCode: expected.sysOrgCode,
  ...overrides
})
const ok = (data) => ({ code: 0, data })
const hidden = () => ({ code: -636, data: null, msg: 'ERP 采购订单申请不存在' })
const policy = { confirmed: true, reference: 'CFOR-ORG-DATA-SCOPE-DECISION-001' }

const readers = ({ foreignDetail = hidden(), foreignPage = [] } = {}) => ({
  readDetail: async ({ viewer }) =>
    viewer.orgId === sameOrgViewer.orgId ? ok(sourceRow()) : foreignDetail,
  readPage: async ({ viewer }) =>
    viewer.orgId === sameOrgViewer.orgId
      ? ok({ records: [sourceRow()], total: 1 })
      : ok({ records: foreignPage, total: foreignPage.length })
})

test('PROC-014 保留原 catalog 11 条断言和既有 evidence 映射', () => {
  const catalog = JSON.parse(fs.readFileSync(
    new URL('../cases/catalog.json', import.meta.url), 'utf8'
  ))
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'PROC-014')
  assert.deepEqual(definition.assertions, PROCUREMENT_014_ORIGINAL_ASSERTIONS)
  assert.equal(PROCUREMENT_014_ORIGINAL_EVIDENCE.length, 11)
  const checks = [...new Set(PROCUREMENT_014_ORIGINAL_EVIDENCE.flat())]
    .map((name) => ({ name, passed: true }))
  const audited = auditProcurement014OriginalAssertions({ definition, checks })
  assert.equal(audited.originalAssertionsComplete, true)
  assert.ok(audited.catalogAssertions.every((item) => item.status === 'VERIFIED'))
})

test('PROC-014 组织范围策略未确认时只登记 PARTIAL，不访问读取器', async () => {
  let calls = 0
  const result = await evaluateProcurement014OrganizationScope({
    expected,
    sameOrgViewer,
    foreignOrgViewer,
    readDetail: async () => { calls++; return ok(sourceRow()) },
    readPage: async () => { calls++; return ok({ records: [], total: 0 }) }
  })
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.policyDecisionRequired, true)
  assert.equal(calls, 0)
  assert.match(result.probes[0].details, /不读接口、不创建账号/)
})

test('PROC-014 组织范围夹具覆盖同租户同组织可见及跨组织详情/分页不可见', async () => {
  const result = await evaluateProcurement014OrganizationScope({
    expected,
    sameOrgViewer,
    foreignOrgViewer,
    organizationPolicy: policy,
    ...readers()
  })
  assert.equal(result.status, 'PASS')
  assert.ok(result.probes.every((item) => item.status === 'PASS'))
  assert.equal(result.calls.length, 4)
  assert.equal(result.remainingAssertions.length, 0)
})

test('PROC-014 详情或分页缺少组织字段保持 PARTIAL，不以租户隔离冒充组织隔离', async () => {
  const result = await evaluateProcurement014OrganizationScope({
    expected,
    sameOrgViewer,
    foreignOrgViewer,
    organizationPolicy: policy,
    readDetail: async ({ viewer }) => viewer.orgId === '1001'
      ? ok(sourceRow({ orgId: undefined, sysOrgCode: undefined }))
      : hidden(),
    readPage: async ({ viewer }) => viewer.orgId === '1001'
      ? ok({ records: [sourceRow({ orgId: undefined, sysOrgCode: undefined })], total: 1 })
      : ok({ records: [], total: 0 })
  })
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.probes.filter((item) => item.status === 'PARTIAL').length, 2)
  assert.match(result.remainingAssertions[0], /组织/)
})

test('PROC-014 同租户跨组织详情泄露直接 FAIL', async () => {
  const result = await evaluateProcurement014OrganizationScope({
    expected,
    sameOrgViewer,
    foreignOrgViewer,
    organizationPolicy: policy,
    ...readers({ foreignDetail: ok(sourceRow()) })
  })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.probes.find((item) => item.name === '同租户跨组织详情不可见').status, 'FAIL')
  assert.equal(result.probes.find((item) => item.name === '同租户跨组织分页不可见').status, 'PASS')
})

test('PROC-014 同租户跨组织分页泄露直接 FAIL', async () => {
  const result = await evaluateProcurement014OrganizationScope({
    expected,
    sameOrgViewer,
    foreignOrgViewer,
    organizationPolicy: policy,
    ...readers({ foreignPage: [sourceRow()] })
  })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.probes.find((item) => item.name === '同租户跨组织分页不可见').status, 'FAIL')
  assert.equal(result.probes.find((item) => item.name === '同租户跨组织详情不可见').status, 'PASS')
})

test('PROC-014 服务错误、认证错误、缺 records/list 都不能冒充隔离通过', async () => {
  const result = await evaluateProcurement014OrganizationScope({
    expected,
    sameOrgViewer,
    foreignOrgViewer,
    organizationPolicy: policy,
    readDetail: async ({ viewer }) => viewer.orgId === '1001'
      ? ok(sourceRow())
      : { code: 403, data: null, msg: '无权限' },
    readPage: async ({ viewer }) => viewer.orgId === '1001'
      ? ok({ total: 1 })
      : { code: 500, data: null, msg: '服务异常' }
  })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.probes.find((item) => item.name === '同租户跨组织详情不可见').status, 'FAIL')
  assert.equal(result.probes.find((item) => item.name === '同租户同组织分页可见').status, 'PARTIAL')
})

test('PROC-014 组织矩阵必须是两个不同用户、同租户、不同组织和查询权限', async () => {
  const result = await evaluateProcurement014OrganizationScope({
    expected,
    sameOrgViewer,
    foreignOrgViewer: { ...foreignOrgViewer, userId: sameOrgViewer.userId },
    organizationPolicy: policy,
    ...readers()
  })
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.calls.length, 0)
})

test('PROC-014 probe 写入 caseRecord 时保留 FAIL 和组织 GAP', async () => {
  const caseRecord = { checks: [], evidence: [], notes: [], remainingAssertions: [], passCandidate: true }
  const result = await runProcurement014OrganizationScopeProbe({
    caseRecord,
    expected,
    sameOrgViewer,
    foreignOrgViewer,
    organizationPolicy: policy,
    ...readers({ foreignPage: [sourceRow()] })
  })
  assert.equal(result.status, 'FAIL')
  assert.equal(caseRecord.passCandidate, false)
  assert.equal(caseRecord.checks.find((item) => item.name === '同租户跨组织分页不可见').passed, false)
  assert.ok(caseRecord.remainingAssertions.some((item) => /组织/.test(item)))
})

test('PROC-014 组织范围缺口和源码接线建议明确不扩大套餐', () => {
  assert.equal(PROCUREMENT_014_ORGANIZATION_SCOPE.status, 'PARTIAL')
  assert.equal(PROCUREMENT_014_ORGANIZATION_SCOPE.policyDecisionRequired, true)
  assert.equal(PROCUREMENT_014_ORGANIZATION_SCOPE.queryPermission, 'erp:purchase-order-request:query')
  assert.match(PROCUREMENT_014_ORGANIZATION_SCOPE.settings.join('\n'), /不扩大套餐/)
  const source = fs.readFileSync(
    new URL('../suites/procurement.mjs', import.meta.url), 'utf8'
  )
  const anchors = locateProcurement014WiringAnchors(source)
  assert.equal(anchors.valid, true)
  assert.match(PROCUREMENT_014_ORGANIZATION_WIRING.call, /organizationPolicy/)
  assert.ok(anchors.organizationGateIndex > anchors.catalogIndex)
})

test('PROC-014 组织字段别名必须同时一致，避免返回冲突 scope', () => {
  assert.deepEqual(procurement014OrganizationScopeOf({
    tenantId: '1',
    tenant_id: '1',
    orgId: '1001',
    org_id: '1001',
    sysOrgCode: 'ORG-A',
    sys_org_code: 'ORG-A'
  }), { tenantId: '1', orgId: '1001', sysOrgCode: 'ORG-A' })
  assert.deepEqual(procurement014OrganizationScopeOf({
    tenantId: '1',
    tenant_id: '2',
    orgId: '1001'
  }), { tenantId: null, orgId: '1001', sysOrgCode: null })
})
