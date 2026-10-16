import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  assertSalesLocalScope,
  assertSalesOrderEvidence,
  assertSalesPriceSnapshot,
  approveOwnedSalesProcess,
  cancelOwnedSalesProcess,
  createSalesFixture,
  createSalesSettlementAccount,
  createSalesTypeDictionary,
  cleanupTypeSalesFixtures,
  disableSalesTypeDictionary,
  expectSalesRejection,
  openingSalesEvidenceRoute,
  runCase,
  salesCatalogEvidence,
  salesBootstrapCredential,
  salesContractOrders,
  salesFinancialDetail,
  salesFinancialSnapshotMatches,
  salesMaterialBody,
  salesOpeningInvoiceBody,
  salesOrderBody,
  salesOrderHasContractSource,
  salesPlanSnapshot,
  salesPriceFixtureBodies,
  salesPriceSnapshot,
  salesProcessDetail,
  salesQuoteSnapshot,
  salesStockSnapshot,
  salesTypeDictionaryBody,
  salesTime
} from '../suites/erp-sales.mjs'
import { caseFailureAction, parseRunnerArgs } from '../lib/runner-options.mjs'
import { caseErrorStatus } from '../lib/report.mjs'
import { config } from '../config/index.mjs'

const record = (checks = []) => ({ checks, notes: [], evidence: [] })
const fact = (name, passed = true) => ({ name, passed })
const local = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
  db: { name: 'cfor_admin_standard' }
}
const fixture = {
  tag: 'E2E-SALES-UNIT', partnerId: '101',
  material: { id: '201', unitId: '301' }
}
const expected = {
  customerId: '101', materialId: '201', unitId: '301',
  count: 2, price: 88.8, amount: 177.6, contractId: '401'
}
const order = () => ({
  id: '501', customerId: '101', contractId: '401', srcBillType: 'CRM_CONTRACT',
  srcBillId: '401', totalPrice: 177.6,
  items: [{ id: '511', productId: '201', productUnitId: '301', count: 2, productPrice: 88.8 }]
})

test('contract sources use official source fields and reject conflicting optional contract IDs', () => {
  const contractId = '2108229190466129921'
  const source = { srcBillId: contractId, srcBillType: 'CRM_CONTRACT' }
  assert.equal(salesOrderHasContractSource(source, contractId), true)
  assert.equal(salesOrderHasContractSource({ ...source, contractId }, contractId), true)
  for (const candidate of [
    null, {}, { contractId },
    { ...source, srcBillId: '2108229190466129922' },
    { ...source, srcBillType: 'SalOrder' },
    { ...source, contractId: '2108229190466129922' },
    { ...source, srcBillId: Number(contractId) }
  ]) {
    assert.equal(salesOrderHasContractSource(candidate, contractId), false)
  }
  assert.equal(salesOrderHasContractSource(source, Number(contractId)), false)
})

test('financial evidence reads separate official header/entry APIs and verifies every entry owner', async () => {
  for (const [kind, endpoint, field] of [
    ['finReceivable', 'queryFinReceivableEntryByMainId', 'finReceivableEntryList'],
    ['finReceivableCheck', 'queryEntryByMainId', 'finReceivableCheckEntryList']
  ]) {
    const calls = []
    const detail = await salesFinancialDetail({
      getBusiness: async (path) => {
        calls.push(path)
        return { code: 200, success: true, data: path.includes('/queryById?')
          ? { id: '501', amt: 177.6 }
          : [{ id: '511', mid: '501', amt: 177.6, checkedAmt: 0 }] }
      }
    }, kind, '501')
    assert.deepEqual(calls, [
      `/finance/${kind}/queryById?id=501`, `/finance/${kind}/${endpoint}?id=501`
    ])
    assert.equal(detail[field][0].id, '511')
    assert.equal(detail[field][0].amt, detail.amt)
    for (const entries of [[{ id: '511', mid: '999' }], [{ mid: '501' }],
      [{ id: Number.MAX_SAFE_INTEGER + 1, mid: '501' }], null, {}]) {
      await assert.rejects(salesFinancialDetail({
        getBusiness: async (path) => ({ code: 0, data: path.includes('/queryById?')
          ? { id: '501' } : entries })
      }, kind, '501'))
    }
  }
})

test('financial evidence never substitutes API or header identity failures with empty entries', async () => {
  for (const response of [{ code: 500, msg: '系统异常' }, { code: 0, data: { id: '999' } }]) {
    let calls = 0
    await assert.rejects(salesFinancialDetail({
      getBusiness: async () => { calls++; return response }
    }, 'finReceivable', '501'))
    assert.equal(calls, 1)
  }
  let calls = 0
  for (const [kind, id] of [['unknown', '501'], ['finReceivable', 'unsafe'],
    ['finReceivable', Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(salesFinancialDetail({
      getBusiness: async () => { calls++; throw new Error('unexpected API') }
    }, kind, id))
  }
  assert.equal(calls, 0)
})

test('financial SQL evidence compares exact string/numeric IDs and verifies both source sides and amounts', () => {
  const rows = [
    ['receivable', '601', 'SalOrder', '501', '101', '177.60', '177.60'],
    ['receivable_entry', '611', '601', '501', '511', '177.60000000', '177.60000000'],
    ['receipt', '701', 'SalOrder', '501', '101', '177.60', '1'],
    ['check', '801', 'FinReceipt:102', '701', '1', '177.60'],
    ['check_entry', '811', '801', 'FinReceivable:101', '601', '611', '177.60'],
    ['check_entry', '812', '801', 'FinReceipt:102', '701', '711', '177.60']
  ]
  const expected = { order: { ...order(), id: 501 }, entry: { id: 611, amt: 177.6 },
    receivableId: 601, receiptId: 701, checkId: 801 }
  assert.equal(salesFinancialSnapshotMatches(rows, expected), true)
  assert.equal(salesFinancialSnapshotMatches(rows.toReversed(), expected), true)
  for (const [row, field, value] of [
    [0, 1, '999'], [0, 4, '999'], [1, 2, '999'], [1, 4, '999'],
    [1, 6, '187.60'], [2, 3, '999'], [3, 3, '999'], [3, 4, '0'],
    [4, 2, '999'], [4, 4, '999'], [5, 4, '999'], [5, 6, '178.60']
  ]) {
    const bad = structuredClone(rows)
    bad[row][field] = value
    assert.equal(salesFinancialSnapshotMatches(bad, expected), false)
  }
  assert.equal(salesFinancialSnapshotMatches(rows.slice(0, 5), expected), false)
  assert.equal(salesFinancialSnapshotMatches(rows, { ...expected, checkId: '999' }), false)
})

const snapshotHelpers = [
  {
    label: 'sales plan', helper: salesPlanSnapshot, path: '/crm/sales-plan/get', id: '601',
    detail: () => ({
      id: '601', planTypeCode: 'E2E-SALES-UNIT-P', status: '执行中',
      contractTarget: '177.6', receivableTarget: '177.6',
      items: [{ id: '611', targetId: '201', targetType: 'PRODUCT', contractTarget: '177.6' }]
    }),
    invalidDetails: () => [
      { id: '601' }, { id: '601', items: null }, { id: '601', items: {} },
      { id: '601', items: [null] }, { id: '601', items: [[]] },
      { id: '601', items: ['item'] }
    ]
  },
  {
    label: 'sales quote', helper: salesQuoteSnapshot, path: '/crm/quote/get', id: '701',
    detail: () => ({
      id: '701', subject: 'E2E-SALES-UNIT-QUOTE', currentVersionNo: 1,
      currentVersion: { id: '711', versionNo: 1, products: [{
        id: '721', productId: '201', quantity: '2', unitPrice: '77.7',
        priceSchemeId: '801', priceSchemeCode: 'E2E-SALES-UNIT', priceVersionId: '811',
        priceVersionNo: 1, priceRuleId: '821', priceHitSource: 'PARTNER',
        priceCalculatedAt: '2026-10-08T12:00:00'
      }] }
    }),
    invalidDetails: () => [
      { id: '701' }, { id: '701', currentVersion: null }, { id: '701', currentVersion: [] },
      { id: '701', currentVersion: { products: [] } },
      { id: '701', currentVersion: { id: 'unsafe', products: [] } },
      { id: '701', currentVersion: { id: '711' } },
      { id: '701', currentVersion: { id: '711', products: null } },
      { id: '701', currentVersion: { id: '711', products: {} } },
      { id: '701', currentVersion: { id: '711', products: [null] } },
      { id: '701', currentVersion: { id: '711', products: [[]] } },
      { id: '701', currentVersion: { id: '711', products: ['product'] } }
    ]
  }
]

for (const { label, helper, path, id, detail, invalidDetails } of snapshotHelpers) {
  test(`${label} snapshot keeps API 500 and thrown errors as FAIL without SQL fallback`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(config.db, 'host')
    let databaseReads = 0
    // Trap the SQL boundary before a regression can execute a real database query.
    Object.defineProperty(config.db, 'host', {
      configurable: true,
      get() {
        databaseReads++
        throw new Error('Unexpected SQL fallback')
      }
    })
    try {
      for (const response of [
        { code: 500, msg: '翻译组件异常' },
        { code: 500, msg: '详情异常', data: detail() },
        { code: 0, success: false, data: detail() }
      ]) {
        const evidence = record()
        const calls = []
        await assert.rejects(helper({
          getBusiness: async (requested) => { calls.push(requested); return response }
        }, evidence, id), (error) => {
          assert.match(error.message, /business failure/)
          assert.equal(caseErrorStatus(error, evidence.checks), 'FAIL')
          return true
        })
        assert.deepEqual(calls, [`${path}?id=${id}`])
        assert.deepEqual(evidence, record())
      }
      for (const failure of [
        new Error(`HTTP 500 GET ${path}`), new Error('network failed')
      ]) {
        const evidence = record()
        await assert.rejects(helper({
          getBusiness: async () => { throw failure }
        }, evidence, id), (error) => {
          assert.equal(error, failure)
          assert.equal(caseErrorStatus(error, evidence.checks), 'FAIL')
          return true
        })
        assert.deepEqual(evidence, record())
      }
      assert.equal(databaseReads, 0)
    } finally {
      Object.defineProperty(config.db, 'host', descriptor)
    }
  })

  test(`${label} snapshot returns the exact official detail with validated shape and identity`, async () => {
    for (const responseId of [id, Number(id)]) {
      const data = { ...detail(), id: responseId }
      const evidence = record()
      const calls = []
      const actual = await helper({
        getBusiness: async (requested) => {
          calls.push(requested)
          return { code: 0, data }
        }
      }, evidence, id)
      assert.equal(actual, data)
      assert.deepEqual(calls, [`${path}?id=${id}`])
      assert.equal(evidence.checks.length, 1)
      assert.ok(evidence.checks[0].passed)
      assert.deepEqual(evidence.notes, [])
      assert.equal(evidence.database, undefined)
    }
  })

  test(`${label} snapshot rejects empty, malformed or foreign official details as FAIL`, async () => {
    for (const data of [
      null, [], 'detail', {}, { ...detail(), id: '999' }, { ...detail(), id: null },
      { ...detail(), id: Number.MAX_SAFE_INTEGER + 1 }, ...invalidDetails()
    ]) {
      const evidence = record()
      await assert.rejects(helper({
        getBusiness: async () => ({ code: 0, data })
      }, evidence, id), (error) => {
        assert.equal(caseErrorStatus(error, evidence.checks), 'FAIL')
        return true
      })
      assert.ok(evidence.checks.every((check) => check.passed === false))
      assert.deepEqual(evidence.notes, [])
      assert.equal(evidence.database, undefined)
    }
  })

  test(`${label} snapshot rejects unsafe request identities before API access`, async () => {
    let reads = 0
    for (const requestId of [null, undefined, '', 0, -1, 'x;DELETE', Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(helper({
        getBusiness: async () => { reads++; return { code: 0, data: detail() } }
      }, record(), requestId), /稳定 ID/)
    }
    assert.equal(reads, 0)
  })
}

test('sales JSON LocalDateTime matches the frontend T format and keeps local business date', () => {
  const date = new Date(2026, 9, 7, 11, 34, 5)
  assert.equal(salesTime(date), '2026-10-07T11:34:05')
  assert.match(salesOrderBody(fixture).orderTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  assert.throws(() => salesTime(new Date(NaN)), /BLOCKED:/)
})

test('sales material payload has legal purchase lead/buffer and stock supply capabilities without shared references', () => {
  const body = salesMaterialBody({
    unitId: '301', categoryId: '302', leadTime: null, bufferTime: -1,
    source: 'manufacture', inventoryNature: 'VIRTUAL', defaultWare: '999',
    defaultWareArea: '998', defaultWareLocation: '997', defaultMerchant: '996',
    id: '201', tenantId: '2'
  }, fixture.tag)
  assert.equal(body.leadTime, 1)
  assert.equal(body.bufferTime, 1)
  assert.equal(body.inventoryNature, 'STOCK')
  assert.equal(body.source, 'mixed')
  assert.equal(body.purchased, 'Y')
  assert.equal(body.produced, 'Y')
  assert.equal(body.saled, 'Y')
  assert.equal(body.parented, 'Y')
  assert.equal(body.unitId, '301')
  assert.equal(body.categoryId, '302')
  for (const key of ['id', 'tenantId', 'defaultWare', 'defaultWareArea',
    'defaultWareLocation', 'defaultMerchant']) assert.equal(key in body, false)
  for (const input of [null, {}, { unitId: 999999999999999999 }]) {
    assert.throws(() => salesMaterialBody(input, fixture.tag), /BLOCKED:/)
  }
  assert.throws(() => salesMaterialBody({ unitId: '301' }, 'SHARED'), /BLOCKED:/)
})

test('real fixture POST receives legal material fields and every invocation owns separate material/partner', async () => {
  const writes = []
  const materials = new Map()
  const partners = new Map()
  let id = 500
  const ok = (data) => ({ code: 0, data })
  const api = {
    getBusiness: async (path) => {
      if (path === '/mes/basMaterial/list/enabled') return ok([{ unitId: '301', saled: 'Y' }])
      if (path.startsWith('/mes/basMaterial/queryById?id=')) return ok(materials.get(path.split('=')[1]))
      if (path.startsWith('/base/partner/get?id=')) return ok(partners.get(path.split('=')[1]))
      throw new Error(`Unexpected GET ${path}`)
    },
    postBusiness: async (path, body) => {
      writes.push({ path, body })
      const nextId = String(++id)
      if (path === '/mes/basMaterial/add') {
        assert.ok(Number.isInteger(body.leadTime) && body.leadTime >= 0)
        assert.ok(Number.isInteger(body.bufferTime) && body.bufferTime >= 0)
        materials.set(nextId, { ...body, id: nextId })
      } else if (path === '/base/partner/create') {
        partners.set(nextId, { ...body, id: nextId, partnerCode: nextId })
      } else throw new Error(`Unexpected POST ${path}`)
      return ok(nextId)
    }
  }
  const firstRecord = record()
  const secondRecord = record()
  const first = await createSalesFixture(api, firstRecord, '1')
  const second = await createSalesFixture(api, secondRecord, '1')
  assert.equal(writes.length, 4)
  assert.notEqual(first.material.id, second.material.id)
  assert.notEqual(first.partnerId, second.partnerId)
  assert.notEqual(first.tag, second.tag)
  assert.ok(firstRecord.fixtures.every((row) => row.owned && row.tenantId === 1))
  assert.ok(firstRecord.checks.every((row) => row.passed))
})

test('seven-case sales batch continues with isolated contexts after FAIL/BLOCKED and has no cross-case failure cache', () => {
  const args = parseRunnerArgs([
    '--suite', 'erp-sales', '--headed', '--fresh', '--no-reuse-session',
    '--continue-on-failure', '--case-timeout-ms', '240000'
  ])
  assert.equal(args.suite, 'erp-sales')
  assert.equal(args.continueOnFailure, true)
  assert.equal(args.headed, true)
  assert.equal(args.reuseSession, false)
  assert.equal(args.caseTimeoutMs, 240000)
  assert.equal(caseFailureAction('FAIL', args.continueOnFailure), 'continue-isolated')
  assert.equal(caseFailureAction('BLOCKED', args.continueOnFailure), 'continue-isolated')
  const source = fs.readFileSync(new URL('../suites/erp-sales.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /contractFailures/)
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  assert.equal(catalog.suites.find((suite) => suite.id === args.suite).cases.length, 7)
})

test('sales source uses UUID-aware BPM detail and dedicated ERP settlement account for opening sales out', () => {
  const source = fs.readFileSync(new URL('../suites/erp-sales.mjs', import.meta.url), 'utf8')
  assert.match(source, /salesProcessDetail/)
  assert.match(source, /\/erp\/account\/create/)
  assert.equal(openingSalesEvidenceRoute, '/erp/sale/invoice')
  assert.match(source, /openingSalesEvidenceRoute/)
  assert.match(source, /accountId: account\.id/)
  assert.match(source, /\/erp\/account\/delete\?id=\$\{account\.id\}/)
  assert.doesNotMatch(source, /fmsAccountSetId.*accountId/)
})

const processId = 'd48f24b7-c202-11f1-a1ca-1edbf7daea22'
const taskId = 'd48f24b8-c202-11f1-a1ca-1edbf7daea22'
const ownedProcessRecord = () => ({
  ...record(),
  fixtures: [{
    kind: 'contract-bpm', id: processId, tenantId: 1, owned: true,
    tag: 'E2E-SALES-UNIT', businessId: '401'
  }]
})

function approvalFixture({ todo = {}, task = {}, history = {}, process = {}, approved = true } = {}) {
  const calls = []
  const active = {
    id: taskId, processInstanceId: processId, taskDefinitionKey: 'FirstApprove_contract',
    status: 1, endTime: null, assigneeUser: { id: '1' }, ...task
  }
  let completed = false
  const api = {
    getBusiness: async (path) => {
      if (path === '/system/auth/get-permission-info') {
        return { code: 0, data: { user: { id: '1', username: 'admin' } } }
      }
      if (path.startsWith('/bpm/task/my-todo?')) {
        return { code: 0, data: {
          ...active, assigneeUser: null, ...todo
        } }
      }
      if (path.startsWith('/bpm/task/list-by-process-instance-id?')) {
        return { code: 0, data: [completed
          ? { ...active, status: 2, endTime: '2026-10-07T15:30:00', ...history }
          : active] }
      }
      if (path.startsWith('/bpm/process-instance/get?')) {
        return { code: 0, data: {
          id: processId, status: 2, endTime: '2026-10-07T15:30:00', ...process
        } }
      }
      throw new Error(`Unexpected GET ${path}`)
    },
    putBusiness: async (path, body) => {
      calls.push({ path, body })
      completed = true
      return { code: 0, data: approved }
    }
  }
  return { api, calls }
}

test('sales approval accepts the official my-todo contract without assignee enrichment', async () => {
  const { api, calls } = approvalFixture()
  const evidence = ownedProcessRecord()
  await approveOwnedSalesProcess({ api, processId, page: {}, caseRecord: evidence }, {
    salesSql: async () => [['admin']]
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/bpm/task/approve')
  assert.equal(calls[0].body.id, taskId)
  assert.ok(evidence.checks.every((check) => check.passed))
  assert.ok(evidence.checks.some((check) => check.name.includes('历史任务通过')))
  assert.ok(evidence.checks.some((check) => check.name.includes('终态通过')))
})

test('sales approval rejects a foreign process/node, ended task or contradictory assignee before writing', async () => {
  for (const todo of [
    { id: 'foreign' }, { processInstanceId: 'foreign' }, { taskDefinitionKey: 'foreign' },
    { status: 2 }, { endTime: '2026-10-07T15:00:00' }, { assigneeUser: { id: '999' } }
  ]) {
    const { api, calls } = approvalFixture({ todo })
    await assert.rejects(approveOwnedSalesProcess({
      api, processId, page: {}, caseRecord: ownedProcessRecord()
    }, { salesSql: async () => [['admin']] }), /未收到准确待办/)
    assert.equal(calls.length, 0)
  }
  const { api, calls } = approvalFixture({ task: { processInstanceId: 'foreign' } })
  await assert.rejects(approveOwnedSalesProcess({
    api, processId, page: {}, caseRecord: ownedProcessRecord()
  }, { salesSql: async () => [['admin']] }), /缺少准确任务/)
  assert.equal(calls.length, 0)
})

test('sales approval still requires a successful API, ended history with actual assignee and PASS process', async () => {
  for (const options of [
    { approved: false }, { history: { status: 3 } }, { history: { endTime: null } },
    { history: { assigneeUser: { id: '999' } } }, { process: { status: 4 } },
    { process: { endTime: null } }
  ]) {
    const { api } = approvalFixture(options)
    await assert.rejects(approveOwnedSalesProcess({
      api, processId, page: {}, caseRecord: ownedProcessRecord()
    }, { salesSql: async () => [['admin']] }))
  }
})

test('BPM UUID details reject invalid IDs before API and mismatched response identities', async () => {
  let reads = 0
  const api = { getBusiness: async () => { reads++; return { code: 0, data: { id: processId } } } }
  for (const id of ['123', '', 'x;DELETE', undefined]) {
    await assert.rejects(salesProcessDetail(api, id), /UUID/)
  }
  assert.equal(reads, 0)
  assert.equal((await salesProcessDetail(api, processId)).id, processId)
  await assert.rejects(salesProcessDetail({
    getBusiness: async () => ({ code: 0, data: { id: 'foreign' } })
  }, processId), /准确 UUID/)
})

test('sales cancellation sends the real DELETE body and verifies CANCEL plus zero active tasks', async () => {
  const calls = []
  let canceled = false
  const api = {
    getBusiness: async (path) => ({ code: 0, data: path.includes('/task/')
      ? [{ id: 'task', status: 4, endTime: '2026-10-07T12:00:00' }]
      : { id: processId, status: canceled ? 4 : 1, endTime: canceled ? '2026-10-07T12:00:00' : null } }),
    request: async (...args) => { calls.push(args); canceled = true; return { code: 0, data: true } }
  }
  const evidence = record()
  evidence.fixtures = [{
    kind: 'contract-bpm',
    id: processId,
    tenantId: 1,
    owned: true,
    tag: 'E2E-SALES-UNIT',
    businessId: '401'
  }]
  await cancelOwnedSalesProcess(api, processId, evidence)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'DELETE')
  assert.equal(calls[0][1], '/bpm/process-instance/cancel-by-start-user')
  assert.equal(calls[0][2].id, processId)
  assert.ok(evidence.checks.every((row) => row.passed))
  await cancelOwnedSalesProcess(api, processId, evidence)
  assert.equal(calls.length, 1)
})

test('sales cancellation never treats a rejected API, wrong terminal state or remaining todo as cleaned', async () => {
  for (const failure of ['rejection', 'wrong-status', 'active-task']) {
    let reads = 0
    const api = {
      request: async () => failure === 'rejection' ? { code: 1001, msg: '取消失败' } : { code: 0, data: true },
      getBusiness: async (path) => ({ code: 0, data: path.includes('/task/')
        ? [{ id: 'task', status: failure === 'active-task' ? 1 : 4, endTime: null }]
        : { id: processId, status: ++reads === 1 ? 1 : failure === 'wrong-status' ? 2 : 4,
            endTime: reads === 1 ? null : '2026-10-07T12:00:00' } })
    }
    await assert.rejects(cancelOwnedSalesProcess(api, processId, record()))
  }
})

test('settlement fixture creates and reads a dedicated enabled ERP account without shared bank/default binding', async () => {
  const calls = []
  let body
  const api = {
    getBusiness: async (path) => {
      calls.push(['GET', path])
      return { code: 0, data: path.includes('/dict-data/')
        ? { list: [{ status: 1, value: 'DISABLED' }, { status: 0, value: 'BANK' }], total: 2 }
        : { ...body, id: '901' } }
    },
    postBusiness: async (path, value) => { calls.push(['POST', path]); body = value; return { code: 0, data: '901' } }
  }
  const evidence = record()
  const account = await createSalesSettlementAccount(api, evidence, fixture.tag)
  assert.equal(account.id, '901')
  assert.equal(body.accountType, 'BANK')
  assert.equal(body.status, 0)
  assert.equal(body.remark, fixture.tag)
  assert.deepEqual(calls.map((call) => call[1]), [
    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=erp_account_type',
    '/erp/account/create', '/erp/account/get?id=901'
  ])
  for (const field of ['defaultStatus', 'bankAccountId', 'accountSetId']) assert.equal(field in body, false)
  await assert.rejects(createSalesSettlementAccount(api, record(), 'SHARED'), /BLOCKED/)
})

test('sales write scope rejects production, other tenants, databases and ports before login', async () => {
  assert.doesNotThrow(() => assertSalesLocalScope(local))
  for (const change of [
    { target: 'production' }, { tenantId: '2' }, { tenantName: '其它租户' },
    { db: { name: 'cfor_admin_saas_standard' } }, { webBase: 'http://127.0.0.1:9152' },
    { apiBase: 'https://jixu-ai.com:48083' }, { apiBase: 'http://user:secret@localhost:48083' }
  ]) {
    let logins = 0
    await assert.rejects(runCase({ caseRecord: record() }, {
      config: { ...local, ...change }, login: async () => { logins++ }
    }), /^Error: BLOCKED:/)
    assert.equal(logins, 0)
  }
})

test('sales order body uses the dedicated unified partner, material and exact two-line amount', () => {
  const body = salesOrderBody(fixture, 'SAMPLE')
  assert.equal(body.customerId, '101')
  assert.equal(body.saleTypeCode, 'SAMPLE')
  assert.equal(body.totalPrice, 177.6)
  assert.equal(body.items.length, 1)
  assert.equal(body.items[0].totalPrice, 177.6)
  assert.equal(body.items[0].productUnitId, '301')
  assert.throws(() => salesOrderBody({ ...fixture, partnerId: null }), /BLOCKED:/)
  assert.throws(() => salesOrderBody({ ...fixture, partnerId: 999999999999999999 }), /BLOCKED:/)
})

test('sales order evidence rejects foreign sources, wrong customer, quantities, unit and amounts', () => {
  assert.doesNotThrow(() => assertSalesOrderEvidence(order(), expected, record()))
  for (const change of [
    { customerId: '999' }, { srcBillId: '999' }, { srcBillType: 'MANUAL' }, { contractId: '999' },
    { totalPrice: 178 }, { items: [] },
    { items: [{ ...order().items[0], count: 3 }] },
    { items: [{ ...order().items[0], productUnitId: '999' }] },
    { items: [{ ...order().items[0], productPrice: null }] }
  ]) assert.throws(() => assertSalesOrderEvidence({ ...order(), ...change }, expected, record()))
})

test('expected sales exceptions require exact domain envelope, not SQL/network/empty failures', async () => {
  const rejects = { code: 1001, msg: '合同必须审批通过后签署' }
  const call = (response) => expectSalesRejection(
    { request: async () => response }, 'POST', '/crm/contract/confirm-signed',
    { id: 401 }, /审批/, record(), '未经审批不签署'
  )
  await assert.doesNotReject(call(rejects))
  for (const response of [
    null, {}, { code: 0, data: null }, { code: 500, msg: '审批 SQL Exception' },
    { code: 403, msg: '审批权限不足' }, { code: 1001, msg: '无关错误' },
    { code: 1001, msg: '审批 SQL failed' }
  ]) await assert.rejects(call(response))
  await assert.rejects(expectSalesRejection(
    { request: async () => { throw new Error('network failed') } },
    'POST', '/any', {}, /failed/, record(), 'domain'), /network failed/)
})

test('type business rejections are marked expected while transport failures stay visible', async () => {
  let options
  const evidence = record()
  await expectSalesRejection({
    request: async (...args) => {
      options = args[3]
      return { code: 1002007002, msg: '字典数据不处于开启状态，不允许选择' }
    }
  }, 'POST', '/erp/sale-order/create', {}, /字典|开启/, evidence, '停用类型拒绝', {
    code: 1002007002
  })
  assert.deepEqual(options.expectedBusinessRejection, {
    code: 1002007002, message: /字典|开启/
  })
  await assert.rejects(() => expectSalesRejection({
    request: async () => { throw new Error('network failed') }
  }, 'POST', '/erp/sale-order/create', {}, /字典/, record(), '停用类型拒绝', {
    code: 1002007002
  }), /network failed/)
})

test('over-limit receipt proves actual capped amounts and never substitutes state rejection evidence', () => {
  const source = fs.readFileSync(new URL('../suites/erp-sales.mjs', import.meta.url), 'utf8')
  const financial = source.slice(source.indexOf('async function runFinancialSalesWrite('),
    source.indexOf('export function salesPriceFixtureBodies('))
  assert.match(financial, /if \(Number\(overReceipt\.isEffective\) !== 1\)/)
  assert.match(financial, /Number\(checked\.checkedAmt\) === Number\(overEntry\.amt\)/)
  assert.match(financial, /Number\(overReceipt\.checkedAmt\) === Number\(overEntry\.amt\)/)
  assert.match(financial, /Number\(overReceipt\.amt\) - Number\(overReceipt\.checkedAmt\)/)
  assert.doesNotMatch(financial, /overLimitContract|单据不能做该操作|matchesExpectedBusinessRejection/)
})

test('ERP-SALES-007 cleanup is tenant-owned, reverse ordered and confirms deletion', async () => {
  const evidence = record()
  evidence.fixtures = [
    { kind: 'material', id: '11', tenantId: 1, owned: true, code: 'E2E-SALES-UNIT' },
    { kind: 'base-partner', id: '12', tenantId: 1, owned: true, name: 'E2E-SALES-UNIT' },
    { kind: 'sales-type-dictionary', id: '13', tenantId: 1, owned: true,
      tag: 'E2E-SALES-UNIT', dictType: 'erp_sale_type', value: 'E2E-SALES-UNIT-S' },
    { kind: 'sales-type-dictionary', id: '14', tenantId: 1, owned: true,
      tag: 'E2E-SALES-UNIT', dictType: 'crm_sales_plan_type', value: 'E2E-SALES-UNIT-P' },
    { kind: 'sale-order', id: '15', tenantId: 1, owned: true, tag: 'E2E-SALES-UNIT' },
    { kind: 'sales-plan', id: '16', tenantId: 1, owned: true, tag: 'E2E-SALES-UNIT' }
  ]
  const calls = []
  const api = {
    getBusiness: async (path) => {
      calls.push(`GETB ${path}`)
      if (path.includes('/sales-plan/get')) return { code: 0, data: { id: '16', status: '执行中' } }
      if (path.includes('/base/partner/get')) {
        return { code: 0, data: {
          id: '12', name: 'E2E-SALES-UNIT', shortName: 'E2E-SALES',
          partnerKind: 'ORGANIZATION', status: 'ACTIVE', remark: 'E2E-SALES-UNIT'
        } }
      }
      return { code: 0, data: {} }
    },
    putBusiness: async (path) => { calls.push(`PUT ${path}`); return { code: 0, data: true } },
    deleteBusiness: async (path) => { calls.push(`DELETE ${path}`); return { code: 0, data: true } },
    get: async () => { throw new Error('cleanup must verify with SQL, not detail GET') }
  }
  assert.deepEqual(await cleanupTypeSalesFixtures(api, evidence, {
    salesSql: async () => [['0']]
  }), [])
  assert.deepEqual(calls.map((call) => call.split(' ')[0] + ' ' + call.split('/')[1]), [
    'GETB crm', 'PUT crm', 'DELETE crm',
    'PUT erp', 'DELETE erp', 'DELETE system', 'DELETE system', 'DELETE mes',
    'GETB base', 'PUT base', 'DELETE base'
  ])
  assert.ok(evidence.fixtures.every((fixture) => fixture.cleaned === true))
  assert.ok(evidence.checks.every((check) => check.passed))
})

test('all seven catalog assertions are preserved verbatim and gaps prevent PASS candidates', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  for (const definition of catalog.suites.find((suite) => suite.id === 'erp-sales').cases) {
    const evidence = record()
    evidence.checks.push({ name: 'unit check', passed: true })
    salesCatalogEvidence(definition.id, evidence, [0])
    assert.deepEqual(evidence.catalogAssertions.map((row) => row.assertion), definition.assertions)
    assert.equal(evidence.catalogAssertions[0].status, 'VERIFIED')
    assert.equal(evidence.remainingAssertions.length, definition.assertions.length - 1)
    assert.equal(evidence.passCandidate, false)
    salesCatalogEvidence(definition.id, evidence, definition.assertions.map((_, index) => index))
    assert.equal(evidence.passCandidate, true)
    evidence.checks.push({ passed: false })
    salesCatalogEvidence(definition.id, evidence, definition.assertions.map((_, index) => index))
    assert.equal(evidence.passCandidate, false)
  }
})

test('ERP-SALES-007 binds original assertions to named checks and preserves plan snapshots across status changes', async () => {
  const { salesCatalogEvidenceChecks, salesPlanTypeSnapshot, sameSalesPlanTypeSnapshot } =
    await import('../suites/erp-sales.mjs')
  const plan = { id: '41', name: 'E2E', planYear: 2026, planTypeCode: 'E2E-P', ownerUserId: '7',
    contractTarget: 10, receivableTarget: 9, status: '草稿', items: [{ layerType: 'PRODUCT',
      targetType: 'PRODUCT', targetId: '81', targetName: 'M', periodType: 'YEAR',
      periodValue: '2026', contractTarget: 10, receivableTarget: 9 }] }
  assert.equal(sameSalesPlanTypeSnapshot(plan, { ...plan, status: '执行中' }), true)
  assert.equal(sameSalesPlanTypeSnapshot(plan, { ...plan, planTypeCode: 'OTHER' }), false)
  assert.equal(salesPlanTypeSnapshot(plan).items.length, 1)
  const originalChecks = [
    fact('销售订单正式保存销售类型稳定编码'), fact('本轮停用销售类型拒绝新订单'),
    fact('销售计划正式保存计划类型和目标快照'), fact('本轮停用计划类型拒绝新计划'),
    fact('停用专属类型后历史订单/计划仍可查询且稳定编码和金额快照不变'),
    fact('停用专属类型后销售计划完整稳定快照不回溯改写'),
    fact('订单/计划稳定编码历史快照数据库证据完整')
  ]
  const bindings = {
    0: ['销售订单正式保存销售类型稳定编码', '本轮停用销售类型拒绝新订单'],
    1: ['销售计划正式保存计划类型和目标快照', '本轮停用计划类型拒绝新计划'],
    2: ['停用专属类型后历史订单/计划仍可查询且稳定编码和金额快照不变',
      '停用专属类型后销售计划完整稳定快照不回溯改写',
      '订单/计划稳定编码历史快照数据库证据完整']
  }
  const cleanupChecks = [
    fact('销售计划清理完成'), fact('销售订单清理完成'),
    fact('erp_sale_type字典清理完成'), fact('crm_sales_plan_type字典清理完成'),
    fact('销售物料清理完成'), fact('销售客商清理完成')
  ]
  const gapBindings = { 0: [...Object.values(bindings).flat(), ...cleanupChecks.map((check) => check.name)] }
  const evidence = record([...originalChecks, ...cleanupChecks])
  salesCatalogEvidenceChecks('ERP-SALES-007', evidence, bindings, gapBindings)
  assert.equal(evidence.passCandidate, true)
  assert.deepEqual(evidence.catalogAssertions[2].evidenceChecks, [
    '停用专属类型后历史订单/计划仍可查询且稳定编码和金额快照不变',
    '停用专属类型后销售计划完整稳定快照不回溯改写',
    '订单/计划稳定编码历史快照数据库证据完整'
  ])
  assert.deepEqual(evidence.acceptanceGapAssertions, [{
    index: 0,
    assertion: '已补脚本，尚缺统一后端真实复验',
    status: 'VERIFIED',
    evidenceChecks: gapBindings[0]
  }])

  for (const checks of [
    [...originalChecks, ...cleanupChecks.filter((check) => check.name !== '销售客商清理完成')],
    [...originalChecks, ...cleanupChecks.map((check) =>
      check.name === '销售客商清理完成' ? fact(check.name, false) : check)],
    [...originalChecks, ...cleanupChecks, fact('销售客商清理完成')]
  ]) {
    const partial = record(checks)
    salesCatalogEvidenceChecks('ERP-SALES-007', partial, bindings, gapBindings)
    assert.equal(partial.acceptanceGapAssertions[0].status, 'GAP')
    assert.equal(partial.passCandidate, false)
  }
})

test('sales snapshots include all catalog fields and reject partial or another rule/version', () => {
  const line = {
    priceSchemeId: '601', priceSchemeCode: 'E2E-SALES-UNIT', priceVersionId: '701',
    priceVersionNo: 1, priceRuleId: '801', priceHitSource: 'SCHEME_RULE',
    priceCalculatedAt: [2026, 10, 7, 1, 2, 3]
  }
  const inquiry = { schemeId: '601', versionId: '701', ruleId: '801' }
  assert.doesNotThrow(() => assertSalesPriceSnapshot(line, inquiry, record(), 'snapshot'))
  assert.equal(Object.keys(salesPriceSnapshot(line)).length, 7)
  for (const change of [
    { priceSchemeId: '999' }, { priceVersionId: '999' }, { priceRuleId: null },
    { priceSchemeCode: '' }, { priceCalculatedAt: null }, { priceVersionNo: null }
  ]) assert.throws(() => assertSalesPriceSnapshot({ ...line, ...change }, inquiry, record(), 'snapshot'))
})

test('inventory snapshot refuses missing or shared dimensions before running SQL', async () => {
  for (const input of [
    {}, fixture, { ...fixture, tag: 'STANDARD', warehouseId: '901' },
    { ...fixture, warehouseId: 'x;DELETE' }
  ]) await assert.rejects(salesStockSnapshot(input, record(), 'unit'))
})

test('default sales runner executes the write contract while readonly is explicit', () => {
  const source = fs.readFileSync(new URL('../suites/erp-sales.mjs', import.meta.url), 'utf8')
  const wrapper = source.slice(source.lastIndexOf('export const runCase'))
  assert.match(wrapper, /dependencies\.readonly === true/)
  assert.match(wrapper, /assertLocalWriteSafety/)
  assert.match(wrapper, /return runSalesWriteCase/)
  assert.doesNotMatch(wrapper, /runErpSalesReadonlyContract/)
})

test('sales bootstrap credential requires the explicit initializer account and create-only password branch', () => {
  const source = [
    'private static final String DEFAULT_PASSWORD = "unit-only-secret";',
    'member("销售部", "apv_sales_mgr", "sales manager", "salemgr01");',
    'if (user == null) { createReqVO.setPassword(DEFAULT_PASSWORD);',
    'adminUserService.createUser(createReqVO); }'
  ].join('\n')
  const result = salesBootstrapCredential(source)
  assert.equal(result.username, 'salemgr01')
  assert.equal(result.password, 'unit-only-secret')
  for (const input of ['', source.replace('salemgr01', 'foreign'),
    source.replace('if (user == null)', 'if (user != null)'),
    source.replace('createReqVO.setPassword(DEFAULT_PASSWORD);', '')]) {
    assert.throws(() => salesBootstrapCredential(input), /BLOCKED:/)
  }
})

test('contract order lookup uses supported exact partner query and verifies all source identities', async () => {
  const fixture = { partnerId: '101', contractId: '401' }
  const linked = { ...order(), contractId: '401' }
  const calls = []
  const api = {
    getBusiness: async (path) => {
      calls.push(path)
      return { code: 0, data: { total: 5, list: [
        linked, { ...linked, customerId: '999' }, { ...linked, srcBillType: 'MANUAL' },
        { ...linked, srcBillId: '999' }, { ...linked, contractId: '999' }
      ] } }
    }
  }
  assert.deepEqual(await salesContractOrders(api, fixture), [linked])
  assert.deepEqual(calls, ['/erp/sale-order/page?pageNo=1&pageSize=100&customerId=101'])
  await assert.rejects(salesContractOrders(api, { partnerId: '101' }), /BLOCKED:/)
  await assert.rejects(salesContractOrders({
    getBusiness: async () => ({ code: 0, data: { list: [linked], total: 101 } })
  }, fixture), /超过单页/)
})

test('contract order response does not require an internal contractId absent from the official VO', async () => {
  const linked = order()
  delete linked.contractId
  assert.doesNotThrow(() => assertSalesOrderEvidence(linked, expected, record()))
  const rows = await salesContractOrders({
    getBusiness: async () => ({ code: 0, data: { list: [
      linked, { ...linked, srcBillId: '999' }, { ...linked, customerId: '999' }
    ], total: 3 } })
  }, { partnerId: '101', contractId: '401' })
  assert.deepEqual(rows, [linked])
  const source = fs.readFileSync(new URL('../suites/erp-sales.mjs', import.meta.url), 'utf8')
  assert.match(source, /salesSql\(caseRecord, 'contract-order-source'/)
  assert.match(source, /SELECT id, contract_id, customer_id FROM erp_sale_order/)
})

test('price fixture uses one CRM partner and a general business-type scheme that CRM can legally inquire', () => {
  const crmFixture = { ...fixture, customerId: '401' }
  const payload = salesPriceFixtureBodies(crmFixture, '501', 99.9)
  assert.equal(payload.scheme.businessTypeCode, '')
  assert.equal(payload.publish.rules[0].partnerId, '101')
  assert.equal(payload.inquiry.partnerId, '101')
  assert.equal(payload.publish.rules[0].materialId, '201')
  assert.equal(payload.publish.rules[0].unitId, '301')
  assert.equal(payload.publish.rules[0].price, 99.9)
  assert.equal(payload.publish.schemeId, '501')
  assert.throws(() => salesPriceFixtureBodies(fixture, '501'), /BLOCKED:/)
  const source = fs.readFileSync(new URL('../suites/erp-sales.mjs', import.meta.url), 'utf8')
  const priceWrite = source.slice(source.indexOf('async function runPriceSalesWrite'),
    source.indexOf('export function salesTypeDictionaryBody'))
  assert.match(priceWrite, /createSalesFixture\(api, caseRecord, userId, \{ crm: true, dualRole: true \}\)/)
  assert.match(priceWrite, /customerId: fixture\.customerId/)
  assert.doesNotMatch(priceWrite, /\/crm\/customer\/create/)
})

test('opening invoice payload preserves the formal OPENING_SALE_OUT source, exact partner and amount', () => {
  const source = { id: '501', no: 'OUT-UNIT', customerId: '101', businessType: 'OPENING' }
  const body = salesOpeningInvoiceBody(fixture, source, '0', 59.2)
  assert.equal(body.srcBillType, 'OPENING_SALE_OUT')
  assert.equal(body.customerId, '101')
  assert.match(body.taxNo, /^E2E[A-Z0-9]+$/)
  assert.equal(body.invoiceType, 0)
  assert.equal(body.invoiceMoney, 59.2)
  assert.deepEqual(body.items, [{ saleOrderId: '501', invoiceMoneyItem: 59.2 }])
  assert.equal(body.isAuto, 0)
  assert.equal(body.isRubric, 0)
  for (const row of [null, { ...source, customerId: '999' }, { ...source, businessType: 'NORMAL' }]) {
    assert.throws(() => salesOpeningInvoiceBody(fixture, row, '0', 59.2), /BLOCKED:/)
  }
  for (const amount of [0, -1, NaN, null]) {
    assert.throws(() => salesOpeningInvoiceBody(fixture, source, '0', amount), /BLOCKED:/)
  }
})

test('sales type fixture refuses shared dictionary types and verifies tenant1 ownership before disabling', async () => {
  const body = salesTypeDictionaryBody(fixture.tag, 'erp_sale_type')
  const calls = []
  let saved = { ...body, id: '701' }
  const api = {
    postBusiness: async (path, value) => {
      calls.push([path, value])
      saved = { ...value, id: '701' }
      return { code: 0, data: '701' }
    },
    putBusiness: async (path, value) => {
      calls.push([path, value])
      saved = value
      return { code: 0, data: true }
    },
    getBusiness: async () => ({ code: 0, data: saved })
  }
  const evidence = record()
  const dictionary = await createSalesTypeDictionary(api, evidence, fixture.tag, 'erp_sale_type', {
    salesSql: async () => [['1', body.dictType, body.value, '0', fixture.tag]]
  })
  await disableSalesTypeDictionary(api, evidence, dictionary, {
    salesSql: async () => [['1', body.dictType, body.value, fixture.tag]]
  })
  assert.equal(calls[1][0], '/system/dict-data/update')
  assert.equal(calls[1][1].status, 1)
  assert.ok(evidence.checks.every((row) => row.passed))
  for (const type of ['system_status', 'common_status', 'invoice_type']) {
    assert.throws(() => salesTypeDictionaryBody(fixture.tag, type), /BLOCKED:/)
  }
  assert.throws(() => salesTypeDictionaryBody('SHARED', 'erp_sale_type'), /BLOCKED:/)
  await assert.rejects(disableSalesTypeDictionary(api, evidence, dictionary, {
    salesSql: async () => [['0', body.dictType, body.value, fixture.tag]]
  }), /未停用/)
  await assert.rejects(disableSalesTypeDictionary(api, record(), dictionary), /非本轮/)
  assert.equal(calls.length, 2)
})
