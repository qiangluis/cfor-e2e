import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  procurementReadOnlyViews,
  procurementReadonlyPage,
  runCase,
  runProcurementReadOnlyContract
} from '../suites/procurement.mjs'

const ok = (data) => ({ code: 0, data })
const paged = (rows) => ok({ list: rows, total: rows.length })
const record = () => ({ checks: [], notes: [], evidence: [] })
const settlement = () => ({
  id: 1, version: 2, status: 1, settleMethodCode: 'BANK', settleMethodName: '银行转账',
  direction: 'BOTH', allowedAccountTypes: 'BANK_ACCOUNT',
  requireBillNo: true, requireDueDate: false, allowCredit: true, defaultCreditDays: 30,
  effectiveFrom: '2026-01-01', effectiveTo: null
})
const purchase = () => ({
  id: 2, version: 3, status: 1, documentTypeId: 10,
  documentTypeCode: 'PURCHASE_STANDARD', documentTypeName: '标准采购',
  orgId: '7,8', approvalProcessKey: 'purchase', statisticsBasis: 'PURCHASE',
  displayTemplate: null, printTemplate: 'purchase',
  effectiveFrom: null, effectiveTo: null
})

// These are unit-test fixtures, not substituted responses in a real E2E run.
function fixture(caseId, row, overrides = {}) {
  const isSettlement = caseId === 'PROC-006'
  const base = isSettlement ? '/erp/settle-method-rule' : '/erp/purchase-type-rule'
  const paths = {
    [`${base}/page?pageNo=1&pageSize=100`]: paged(row ? [row] : []),
    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=x_settle_method':
      paged([{ value: 'BANK', label: '银行转账', dictType: 'x_settle_method', status: 0 }]),
    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=erp_account_type':
      paged([{ value: 'BANK_ACCOUNT', label: '银行', dictType: 'erp_account_type', status: 0 }]),
    '/system/document/type/page?pageNo=1&pageSize=100&isOpen=true':
      paged([{ id: 10, code: 'PURCHASE_STANDARD', name: '标准采购', isOpen: true }]),
    '/system/document/type/get?id=10':
      ok({ id: 10, code: 'PURCHASE_STANDARD', name: '标准采购', isOpen: true }),
    '/system/dept/get?id=7': ok({ id: 7, name: '采购部', status: 0 }),
    '/system/dept/get?id=8': ok({ id: 8, name: '总部', status: 0 })
  }
  if (row) {
    paths[`${base}/get?id=${row.id}`] = ok({ ...row })
    paths[isSettlement
      ? `${base}/list-by-code?settleMethodCode=${encodeURIComponent(row.settleMethodCode)}`
      : `${base}/list-by-document-type?documentTypeId=${row.documentTypeId}`] = ok([{ ...row }])
  }
  const view = procurementReadOnlyViews[caseId]
  paths['/system/auth/get-permission-info'] = ok({ menus: [{
    path: '/settings', children: [{
      path: 'erp', children: [{
        path: isSettlement ? 'settle-method-rule' : 'purchase-type-rule',
        component: view.component
      }]
    }]
  }] })
  Object.assign(paths, overrides)
  const calls = []
  const api = {
    async getBusiness(path) {
      calls.push(path)
      assert.ok(Object.hasOwn(paths, path), `Unexpected GET ${path}`)
      return structuredClone(paths[path])
    }
  }
  return { api, calls }
}

const run = async (caseId, row, overrides) => {
  const f = fixture(caseId, row, overrides)
  const caseRecord = record()
  const result = await runProcurementReadOnlyContract({ caseId, api: f.api, caseRecord })
  return { ...f, caseRecord, result }
}

test('read-only page rejects failed business codes, envelopes and malformed rows/counts', () => {
  for (const payload of [
    { code: 500, data: { list: [], total: 0 } },
    ok({}), ok({ list: {}, total: 0 }), ok({ list: [{}], total: 0 }),
    ok({ list: [], total: '0' }), ok({ list: [null], total: 1 }),
    ok({ list: [[]], total: 1 }), ok({ list: [], total: -1 })
  ]) assert.throws(() => procurementReadonlyPage(payload, '规则分页'))
  assert.deepEqual(procurementReadonlyPage(paged([]), '规则分页'), { list: [], total: 0 })
})

for (const caseId of ['PROC-006', 'PROC-008']) {
  test(`${caseId} valid GET contracts always return PARTIAL, including populated data`, async () => {
    const { result, calls, caseRecord } = await run(
      caseId, caseId === 'PROC-006' ? settlement() : purchase())
    assert.equal(result.partial, true)
    assert.ok(caseRecord.checks.every((check) => check.passed))
    assert.match(result.note, /未执行配置写入/)
    assert.ok(calls.some((path) => path.includes('/get?id=')))
    assert.ok(calls.some((path) => path.includes('/list-by-')))
    assert.ok(!calls.some((path) => /create|update|delete|save|publish/.test(path)))
  })

  test(`${caseId} empty rule data records missing prerequisites, no fake detail/version pass`, async () => {
    const { result, calls, caseRecord } = await run(caseId, null)
    assert.equal(result.partial, true)
    assert.ok(caseRecord.notes.some((note) => /前置缺失.*没有规则样本/.test(note)))
    assert.ok(!calls.some((path) => path.includes('/get?id=') || path.includes('/list-by-')))
    assert.ok(!caseRecord.checks.some((check) => /详情|版本/.test(check.name)))
  })

  test(`${caseId} malformed version and status are rejected`, async () => {
    const valid = caseId === 'PROC-006' ? settlement() : purchase()
    for (const change of [{ version: 0 }, { version: '2' }, { status: 2 }, { id: null }]) {
      await assert.rejects(() => run(caseId, { ...valid, ...change }), /规则 ID、版本及启停状态/)
    }
  })

  test(`${caseId} missing detail and drifting page/detail version fail`, async () => {
    const row = caseId === 'PROC-006' ? settlement() : purchase()
    const base = caseId === 'PROC-006' ? '/erp/settle-method-rule' : '/erp/purchase-type-rule'
    for (const detail of [null, {}, { ...row, version: row.version + 1 }]) {
      await assert.rejects(() => run(caseId, row, {
        [`${base}/get?id=${row.id}`]: ok(detail)
      }), /详情与当前分页快照/)
    }
  })

  test(`${caseId} invalid dates and reversed periods are rejected`, async () => {
    const row = caseId === 'PROC-006' ? settlement() : purchase()
    for (const change of [
      { effectiveFrom: '2026-02-30' },
      { effectiveFrom: '2026-10-06', effectiveTo: '2026-01-01' }
    ]) await assert.rejects(() => run(caseId, { ...row, ...change }), /生效日期/)
  })

  test(`${caseId} version list rejects empty/wrong source/missing current/unsorted entries`, async () => {
    const row = caseId === 'PROC-006' ? settlement() : purchase()
    const path = caseId === 'PROC-006'
      ? '/erp/settle-method-rule/list-by-code?settleMethodCode=BANK'
      : '/erp/purchase-type-rule/list-by-document-type?documentTypeId=10'
    const otherSource = caseId === 'PROC-006'
      ? { ...row, settleMethodCode: 'CASH' }
      : { ...row, documentTypeId: 99 }
    for (const versions of [[], [{}], [otherSource], [{ ...row, id: 99 }],
      [{ ...row }, { ...row, id: 99, version: row.version + 1 }]
    ]) await assert.rejects(() => run(caseId, row, { [path]: ok(versions) }))
  })

  test(`${caseId} wrapper uses actual nested menu component route and specific ready selector`, async () => {
    const f = fixture(caseId, caseId === 'PROC-006' ? settlement() : purchase())
    const caseRecord = record()
    let currentUrl = 'http://127.0.0.1:9151/'
    const page = {
      url: () => currentUrl,
      locator: (selector) => {
        assert.equal(selector, '.el-table__header-wrapper th')
        return { allInnerTexts: async () => procurementReadOnlyViews[caseId].headers }
      }
    }
    let opened
    const result = await runCase({ caseId, page, caseRecord, record: {}, outputDir: '/unused' }, {
      login: async () => 'unit-token',
      createApiClient: () => f.api,
      openRoute: async (_page, route, options) => {
        opened = { route, options }
        currentUrl = `http://127.0.0.1:9151${route}`
      },
      saveScreenshot: async () => '/unit-only/screenshot.png'
    })
    assert.equal(opened.route, `/settings/erp/${caseId === 'PROC-006'
      ? 'settle-method-rule' : 'purchase-type-rule'}`)
    assert.equal(opened.options.readySelector, procurementReadOnlyViews[caseId].readySelector)
    assert.equal(result.partial, true)
    assert.deepEqual(caseRecord.evidence, ['/unit-only/screenshot.png'])
  })

  test(`${caseId} missing menu blocks before rule requests or navigation`, async () => {
    const f = fixture(caseId, null, {
      '/system/auth/get-permission-info': ok({ menus: [] })
    })
    await assert.rejects(() => runCase({
      caseId, page: {}, caseRecord: record(), record: {}
    }, {
      login: async () => 'unit-token',
      createApiClient: () => f.api,
      openRoute: async () => assert.fail('must not navigate')
    }), /BLOCKED.*component=/)
    assert.equal(f.calls.length, 1)
  })
}

test('PROC-006 rejects invalid direction, boolean flags and account type structure', async () => {
  for (const change of [
    { direction: 'SALE' }, { requireBillNo: 'true' },
    { allowedAccountTypes: [] }, { defaultCreditDays: -1 }
  ]) await assert.rejects(() => run('PROC-006', { ...settlement(), ...change }), /方向、账户与票据账期/)
})

test('PROC-006 missing dictionary reports missing prerequisites rather than field PASS', async () => {
  const { result, caseRecord } = await run('PROC-006', settlement(), {
    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=x_settle_method': paged([]),
    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=erp_account_type': paged([])
  })
  assert.equal(result.partial, true)
  assert.ok(caseRecord.notes.some((note) => /前置缺失.*字典为空/.test(note)))
  assert.ok(!caseRecord.checks.some((check) => /字典返回稳定编码/.test(check.name)))
})

test('PROC-006 rule code absent from a complete nonempty dictionary is a contract failure', async () => {
  await assert.rejects(() => run('PROC-006', { ...settlement(), settleMethodCode: 'UNKNOWN' }),
    /完整字典目录必须包含/)
  await assert.rejects(() => run('PROC-006', { ...settlement(), allowedAccountTypes: 'UNKNOWN' }),
    /完整字典目录必须包含/)
})

test('PROC-006 same-code version list cannot contain two enabled rules', async () => {
  const row = settlement()
  await assert.rejects(() => run('PROC-006', row, {
    '/erp/settle-method-rule/list-by-code?settleMethodCode=BANK':
      ok([row, { ...row, id: 99, version: 1 }])
  }), /至多一条启用规则/)
})

test('PROC-008 rejects wrong document type reference and non-PURCHASE type', async () => {
  await assert.rejects(() => run('PROC-008', purchase(), {
    '/system/document/type/get?id=10': ok({
      id: 10, code: 'SALE_STANDARD', name: '销售', isOpen: true
    })
  }), /引用真实单据类型/)
  await assert.rejects(() => run('PROC-008', {
    ...purchase(), documentTypeCode: 'SALE_STANDARD'
  }), /单据类型和组织/)
})

test('PROC-008 validates concrete organization IDs, rejects duplicate/missing/wrong references', async () => {
  for (const orgId of ['7,7', '7,', 'HQ-SALES']) {
    await assert.rejects(() => run('PROC-008', { ...purchase(), orgId }), /稳定组织 ID/)
  }
  await assert.rejects(() => run('PROC-008', purchase(), {
    '/system/dept/get?id=7': ok(null)
  }), /真实组织/)
  await assert.rejects(() => run('PROC-008', purchase(), {
    '/system/dept/get?id=7': ok({ id: 99, name: '其他', status: 0 })
  }), /真实组织/)
})

test('PROC-008 blank orgId means global applicability, no fabricated department query', async () => {
  const { result, calls, caseRecord } = await run('PROC-008', { ...purchase(), orgId: null })
  assert.equal(result.partial, true)
  assert.ok(caseRecord.notes.some((note) => /全组织适用/.test(note)))
  assert.ok(!calls.some((path) => path.startsWith('/system/dept/')))
})

test('PROC-008 empty enabled document directory records prerequisite gap', async () => {
  const { result, caseRecord } = await run('PROC-008', null, {
    '/system/document/type/page?pageNo=1&pageSize=100&isOpen=true': paged([])
  })
  assert.equal(result.partial, true)
  assert.ok(caseRecord.notes.some((note) => /前置缺失.*没有 PURCHASE/.test(note)))
  assert.ok(!caseRecord.checks.some((check) => /启用单据类型目录返回稳定/.test(check.name)))
})

test('PROC-008 redirect or generic shell headers do not count as page readiness', async () => {
  for (const [url, headers] of [
    ['http://127.0.0.1:9151/404', procurementReadOnlyViews['PROC-008'].headers],
    ['http://127.0.0.1:9151/settings/erp/purchase-type-rule', ['首页']]
  ]) {
    const f = fixture('PROC-008', purchase())
    await assert.rejects(() => runCase({
      caseId: 'PROC-008', record: {}, caseRecord: record(), page: {
        url: () => url,
        locator: () => ({ allInnerTexts: async () => headers })
      }
    }, {
      login: async () => 'unit-token',
      createApiClient: () => f.api,
      openRoute: async () => {},
      saveScreenshot: async () => assert.fail('must not capture a failed page')
    }), /实际权限菜单路由和领域表头/)
  }
})

test('only the two target cases enter the added branch; contract contains no write APIs', () => {
  assert.deepEqual(Object.keys(procurementReadOnlyViews), ['PROC-006', 'PROC-008'])
  const source = fs.readFileSync(new URL('../suites/procurement.mjs', import.meta.url), 'utf8')
  const contract = source.slice(source.indexOf('export async function runProcurementReadOnlyContract'),
    source.indexOf('const readBrowserBusinessResponse'))
  assert.doesNotMatch(contract, /api\.(post|put|delete|request)|runReadOnlySql|readySelector: ['"]body/)
  assert.match(contract, /partial: true/)
})
