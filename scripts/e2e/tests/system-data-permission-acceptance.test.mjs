import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  runCase, catalogAssertions, orderAmountEvidence, selectAmountMenus, assertPermissionLocal
} from '../suites/system-data-permission.mjs'

const settings = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const env = { CFOR_E2E_WRITE_FIXTURES: 'true' }
const ok = (data) => ({ code: 0, data })
const menuRows = [
  { id: 1, parentId: 0, permission: '', status: 0 },
  { id: 2, parentId: 1, permission: 'system:settings:query', status: 0 },
  { id: 3, parentId: 2, permission: 'system:role:query', status: 0 },
  { id: 4, parentId: 1, permission: 'erp:sale-order:query', status: 0 },
  { id: 5, parentId: 1, permission: 'erp:purchase-order:query', status: 0 },
  { id: 6, parentId: 3, permission: 'sensitive:amount:view', status: 0 }
]
const rootAmounts = [
  'totalPrice', 'totalProductPrice', 'totalTaxPrice', 'discountPrice', 'depositPrice',
  'invoiceMount', 'checkedAmt', 'thisInvoiceMount', 'unInvoiceMount', 'unCheckedAmt'
]
const itemAmounts = [
  'productPrice', 'totalPrice', 'taxPrice', 'productTaxPrice', 'checkedAmt',
  'productTotalPrice', 'onlyReturnAmount', 'unCheckedAmt'
]
const order = (id) => ({
  id, totalCount: 2, ...Object.fromEntries(rootAmounts.map((key) => [key, 10])),
  items: [{ id: `${id}1`, count: 2, ...Object.fromEntries(itemAmounts.map((key) => [key, 5])) }]
})
const masked = (source) => ({
  ...source, ...Object.fromEntries(rootAmounts.map((key) => [key, null])),
  items: source.items.map((item) => ({
    ...item, ...Object.fromEntries(itemAmounts.map((key) => [key, null]))
  }))
})

function harness (caseId, options = {}) {
  const record = { api: [], screenshots: [] }
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const calls = []
  let role, user, menus = [], firstRoleRead = true
  const get = async (path, actor = false) => {
    calls.push(['get', path, actor ? 'actor-token' : 'admin-token'])
    if (path === '/system/dept/list') return ok([{ id: 7, status: 1 }, { id: 8, status: 0 }])
    if (path === '/system/menu/list') return ok(menuRows)
    if (path === '/system/menu/list-all-simple') return ok(menuRows.filter((row) => [3, 4, 5, 6].includes(row.id)))
    if (path.startsWith('/system/permission/list-role-menus')) return ok(menus)
    if (path.startsWith('/system/role/get')) {
      if (role && firstRoleRead) {
        assert.equal(caseRecord.businessIds.role[0], '100')
        firstRoleRead = false
        if (options.readbackFailure) throw new Error('unit role readback failed')
      }
      return ok(options.wrongDept && role?.dataScope === 2 ? { ...role, dataScopeDeptIds: [9] } : role)
    }
    if (path.startsWith('/system/user/get')) return ok(user)
    if (path.startsWith('/system/permission/list-user-roles')) return ok(['100'])
    if (path === '/system/auth/get-permission-info') {
      return ok({ user: { id: '200' }, roles: [role.code], permissions: [
        'erp:sale-order:query', 'erp:purchase-order:query',
        ...(menus.includes('6') ? ['sensitive:amount:view'] : [])
      ] })
    }
    if (/^\/erp\/(sale|purchase)-order\/page\?/.test(path)) {
      if (options.emptyOrders) return ok({ list: [] })
      const row = order(path.includes('/sale-') ? '300' : '400')
      return ok({ list: [actor && !menus.includes('6') && !options.leakAmount ? masked(row) : row] })
    }
    throw new Error(`Unexpected GET: ${path}`)
  }
  const api = {
    getBusiness: (path) => get(path),
    async postBusiness (path, body) {
      calls.push(['post', path, structuredClone(body)])
      if (path === '/system/role/create') {
        role = { ...body, id: '100', type: 2, status: 0 }
        menus = options.unsafeDefault ? ['6'] : []
        return ok('100')
      }
      if (path === '/system/user/create') {
        user = { ...body, id: '200', status: 0 }
        return ok('200')
      }
      if (path === '/system/permission/assign-role-menu') { menus = body.menuIds; return ok(true) }
      if (path === '/system/permission/assign-role-data-scope') {
        Object.assign(role, body)
        return ok(true)
      }
      throw new Error(`Unexpected POST: ${path}`)
    },
    async request (method, path, body, requestOptions) {
      calls.push(['negative', method, path, body, requestOptions])
      return options.rejection || { code: 400, msg: '数据范围包含不存在或不属于当前租户的部门' }
    },
    async deleteBusiness (path) {
      calls.push(['delete', path])
      if (path.includes('/user/')) user = null
      else role = null
      return ok(true)
    }
  }
  return {
    calls, caseRecord,
    run: () => runCase({ caseId, page: {}, record, caseRecord, outputDir: '/unused' }, {
      settings, env, login: async () => 'admin-token', writeSafety: async () => {},
      createApiClient: ({ token }) => token === 'actor-token' ? { getBusiness: (path) => get(path, true) } : api,
      headedActor: async () => {
        calls.push(['headed-login'])
        return { token: 'actor-token', close: async () => calls.push(['actor-close']) }
      },
      sql: async (sql) => sql.includes('system_dept') ? { available: true, rows: [['0']] }
        : { available: true, rows: [[sql.includes('erp_sale_order') ? '300' : '400', 'UNIT-BILL']] },
      openRoute: async () => {}, saveScreenshot: async () => {}
    })
  }
}

test('all system mappings preserve exact zero-based original catalog assertions', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url)))
  for (const [caseId, assertions] of Object.entries(catalogAssertions)) {
    assert.deepEqual(assertions, catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === caseId).assertions)
  }
})

test('permission fixture guard rejects port, tenant, DB, missing opt-in and external hosts', () => {
  assert.doesNotThrow(() => assertPermissionLocal(settings, env))
  for (const patch of [
    { tenantId: 2 }, { target: 'online' }, { webBase: 'http://127.0.0.1:9160' },
    { apiBase: 'http://example.com:48083' }, { db: { ...settings.db, name: 'other' } }
  ]) assert.throws(() => assertPermissionLocal({ ...settings, ...patch }, env), /BLOCKED|Database/)
  assert.throws(() => assertPermissionLocal(settings, {}), /BLOCKED/)
})

test('menu selection accounts for normalized ancestors and refuses privileged or cyclic parents', () => {
  const selected = selectAmountMenus(menuRows, menuRows.slice(2))
  assert.equal(selected.underRole, true)
  assert.deepEqual(selected.base.sort(), ['1', '2', '3', '4', '5'])
  assert.deepEqual(selected.granted.sort(), ['1', '2', '3', '4', '5', '6'])
  for (const patch of [{ permission: 'system:user:update' }, { parentId: 3 }]) {
    assert.throws(() => selectAmountMenus(menuRows.map((row) => row.id === 2 ? { ...row, ...patch } : row), menuRows), /BLOCKED/)
  }
})

test('amount evidence rejects empty/missing samples, omitted nulls, leaked nested amounts and altered quantity', () => {
  const baseline = order('300')
  assert.equal(orderAmountEvidence([baseline], baseline, true), true)
  assert.equal(orderAmountEvidence([masked(baseline)], baseline, false), true)
  const omitted = masked(baseline)
  delete omitted.items[0].productPrice
  const nestedLeak = masked(baseline)
  nestedLeak.items[0].productTaxPrice = 12
  const quantity = masked(baseline)
  quantity.items[0].count = null
  for (const rows of [[], [order('301')], [omitted], [nestedLeak], [quantity], [baseline]]) {
    assert.equal(orderAmountEvidence(rows, baseline, false), false)
  }
  assert.equal(orderAmountEvidence([masked(baseline)], masked(baseline), true), false)
})

test('003 verifies exact rejection and actual department IDs, with owned role finally cleanup', async () => {
  const h = harness('AUTH-DATA-003')
  const result = await h.run()
  assert.equal(result.partial, false)
  assert.deepEqual(h.caseRecord.catalogAssertions.map((row) => [row.index, row.status]), [
    [0, 'VERIFIED'], [1, 'VERIFIED'], [2, 'VERIFIED']
  ])
  assert.deepEqual(h.calls.find((call) => call[0] === 'post' && call[1].endsWith('data-scope'))[2].dataScopeDeptIds, [8])
  assert.equal(h.caseRecord.fixtureResiduals[0].cleanup, 'DELETED_VERIFIED')
})

test('003 unrelated rejection and wrong persisted department never verify the original assertion', async () => {
  for (const [options, index] of [
    [{ rejection: { code: 500, msg: '数据库异常' } }, 1],
    [{ rejection: { code: 400, msg: '其他错误' } }, 1], [{ wrongDept: true }, 2]
  ]) {
    const h = harness('AUTH-DATA-003', options)
    await h.run()
    assert.equal(h.caseRecord.catalogAssertions[index].status, 'FAILED')
    assert.equal(h.caseRecord.remainingAssertions.includes(catalogAssertions['AUTH-DATA-003'][index]), true)
  }
})

test('creation readback failure retains immediate ID audit and executes finally cleanup', async () => {
  const h = harness('AUTH-DATA-003', { readbackFailure: true })
  await assert.rejects(h.run, /readback failed/)
  assert.deepEqual(h.caseRecord.businessIds.role, ['100'])
  assert.equal(h.caseRecord.fixtureResiduals[0].cleanup, 'DELETED_VERIFIED')
  assert.equal(h.caseRecord.catalogAssertions.every((row) => row.status === 'GAP'), true)
})

test('005 only maps list originals after same-token positive/negative checks; export/print remains GAP', async () => {
  const h = harness('AUTH-DATA-005')
  const result = await h.run()
  assert.equal(result.partial, true)
  assert.deepEqual(h.caseRecord.catalogAssertions.map((row) => row.status), ['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'GAP'])
  assert.deepEqual(h.caseRecord.remainingAssertions, [catalogAssertions['AUTH-DATA-005'][4]])
  assert.equal(h.calls.filter((call) => call[0] === 'headed-login').length, 1)
  assert.equal(h.calls.filter((call) => call[0] === 'get' && call[1].startsWith('/erp/') && call[2] === 'actor-token').length, 6)
  assert.ok(h.calls.findIndex((call) => call[0] === 'actor-close') < h.calls.findIndex((call) => call[0] === 'delete'))
  assert.ok(h.caseRecord.fixtureResiduals.every((row) => row.cleanup === 'DELETED_VERIFIED'))
  assert.equal(JSON.stringify(h.caseRecord).includes('Dt!'), false)
})

test('006 proves same existing actor token reacts to grants and revocations', async () => {
  const h = harness('AUTH-DATA-006')
  assert.equal((await h.run()).partial, false)
  assert.equal(h.caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'), true)
})

test('empty orders, leaked amounts, or unsafe default roles cannot become verified acceptance', async () => {
  const empty = harness('AUTH-DATA-005', { emptyOrders: true })
  await assert.rejects(empty.run, /baseline lacks/)
  assert.notEqual(empty.caseRecord.catalogAssertions[2].status, 'VERIFIED')
  for (const options of [{ leakAmount: true }, { unsafeDefault: true }]) {
    const h = harness('AUTH-DATA-005', options)
    await h.run()
    assert.equal(h.caseRecord.catalogAssertions[3].status, 'FAILED')
  }
})

test('AI partial checks are translated to exact originals without promoting known composite gaps', async () => {
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const result = await runCase({ caseId: 'AUTH-DATA-007', caseRecord }, {
    runAiDataCase: async () => {
      caseRecord.checks.push({ name: 'tool only', passed: true })
      caseRecord.assertionMappings = catalogAssertions['AUTH-DATA-007'].map((assertion, index) => ({
        index: index + 1, assertion, checks: ['tool only'], status: 'PARTIAL', gaps: ['not executed: report/async/audit']
      }))
      return { partial: true }
    }
  })
  assert.equal(result.partial, true)
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.index), [0, 1, 2])
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
})

test('coverage summary compares every counter and scans planned ownership risk independently', async () => {
  const items = [
    ...['system_users', 'system_dept'].map((tableName) => ({ tableName, status: 'REGISTERED', ownerRule: 'DeptDataPermissionRule' })),
    ...['hrm_employee', 'pms_knowledge_library_member'].map((tableName) => ({ tableName, status: 'REGISTERED', deptColumn: 'dept_id' })),
    { tableName: 'pms_project_group', status: 'REGISTERED', userColumn: 'user_id', deptColumn: null },
    { tableName: 'mes_stk_inventory', status: 'NOT_APPLICABLE', ownerRule: 'WMS', moduleCode: 'wms' }
  ]
  for (const bad of [false, true]) {
    const caseRecord = { checks: [], notes: [], evidence: [] }
    await runCase({ caseId: 'PB006-001', page: {}, caseRecord }, {
      login: async () => 'admin',
      createApiClient: () => ({
        getBusiness: async (path) => ok(path.endsWith('/summary')
          ? { total: 6, registered: 5, planned: bad ? 1 : 0, notApplicable: 1, riskCount: 0 } : items)
      }),
      openRoute: async () => {}, saveScreenshot: async () => {}
    })
    assert.equal(caseRecord.catalogAssertions[0].status, bad ? 'FAILED' : 'VERIFIED')
    assert.ok(caseRecord.catalogAssertions.slice(1).every((row) => row.status === 'VERIFIED'))
  }
})
