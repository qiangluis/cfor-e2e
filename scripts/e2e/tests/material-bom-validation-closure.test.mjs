import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import {
  __internal,
  assertMaterialBomScope,
  materialBomCheckNames,
  materialBomContractGaps,
  materialBomRejection,
  verifyMaterialBomValidationClosure
} from '../fixtures/material-bom-validation-closure.mjs'
import { INIT_CASE_CATALOG_EVIDENCE, runCase } from '../suites/init.mjs'

const local = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
  db: { name: 'cfor_admin_standard' }
}
const copy = (value) => structuredClone(value)
const ok = (data) => ({ code: 0, data: copy(data) })
const paged = (rows) => ok({ total: rows.length, records: rows })
const fixtureRecord = () => ({ id: 'PB032-003', checks: [], evidence: [], notes: [] })

const harness = (options = {}) => {
  const record = fixtureRecord()
  const state = {
    nextId: 9007199254740992n, materials: new Map(), boms: [], subs: [],
    posts: [], deleted: [], queries: [], apiReads: [], sqlRevision: 'original', safetyChecks: 0
  }
  const api = {
    async getBusiness (pathname) {
      state.apiReads.push(pathname)
      const url = new URL(pathname, 'http://local')
      const id = url.searchParams.get('id')
      if (url.pathname === '/mes/basUnit/list/enabled') return ok(options.noUnit ? [] : [{ id: '7' }])
      if (url.pathname === '/mes/basMaterial/list') {
        const code = url.searchParams.get('code')
        return paged([...state.materials.values()].filter((row) => !row.deleted && row.code === code))
      }
      if (url.pathname === '/mes/basMaterial/queryById') {
        const row = state.materials.get(id)
        const detail = options.readDetail ? options.readDetail(copy(row), state) : row
        return ok(detail?.deleted ? null : detail)
      }
      if (url.pathname === '/mes/wmsAssemble/list') {
        return paged(state.boms.filter((row) => row.stockId === url.searchParams.get('stockId')))
      }
      throw new Error(`unexpected GET ${pathname}`)
    },
    async postBusiness (pathname, body) {
      assert.equal(pathname, '/mes/basMaterial/add')
      state.posts.push({ pathname, body: copy(body) })
      const id = String(++state.nextId)
      state.materials.set(id, { ...copy(body), id, tenantId: '1', deleted: false, defaultProdBom: null })
      if (options.createFailureAt === state.materials.size) throw new Error('injected lost create response')
      return ok(id)
    },
    async post (pathname, body, init) {
      assert.equal(pathname, '/mes/wmsAssemble/add')
      state.posts.push({ pathname, body: copy(body), options: copy(init) })
      const pair = [body.stockId, body.wmsAssembleSubList[0].stockId].map((id) => state.materials.get(id))
      assert.ok(pair.every(Boolean), 'BOM must reference only existing material IDs')
      const invalid = pair.find((row) => row.inventoryNature !== 'STOCK')
      const contract = materialBomRejection(invalid.name)
      assert.deepEqual(init.expectedBusinessRejection, contract)
      if (options.afterPost) options.afterPost(body, state)
      if (options.networkFailure) throw new Error('ECONNRESET original network evidence')
      return Object.hasOwn(options, 'response') ? copy(options.response)
        : { code: contract.code, msg: contract.message, data: null }
    },
    async deleteBusiness (pathname) {
      const url = new URL(pathname, 'http://local')
      assert.equal(url.pathname, '/mes/basMaterial/delete')
      const id = url.searchParams.get('id')
      assert.ok(state.materials.has(id), 'cleanup must not invent IDs')
      if (options.deleteFailure) return { code: 500, msg: 'injected cleanup failure' }
      state.materials.get(id).deleted = true
      state.deleted.push(id)
      return ok(true)
    }
  }
  const readSql = async (sql) => {
    state.queries.push(sql)
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|REPLACE)\b/i)
    if (sql.includes('material-active-count')) {
      const id = sql.match(/AND id='(\d+)'/)?.[1]
      const active = state.materials.has(id) && !state.materials.get(id).deleted
      return { available: true, rows: [['material-active-count', active ? '1' : '0']] }
    }
    let rows = [
      ['bom-main-count', String(state.boms.length)],
      ...state.boms.map((row) => ['bom-main', JSON.stringify(row)]),
      ['bom-sub-count', String(state.subs.length)],
      ...state.subs.map((row) => ['bom-sub', JSON.stringify(row)]),
      ...[...state.materials.values()].map((row) => ['material', JSON.stringify(row), state.sqlRevision])
    ]
    if (options.sqlRows) rows = options.sqlRows(rows, state)
    return { available: true, rows }
  }
  const dependencies = {
    config: local, writeFixturesEnabled: true, runReadOnlySql: readSql,
    assertLocalWriteSafety: async () => {
      state.safetyChecks++
      assert.equal(state.posts.length, 0)
      if (options.safetyFailure) throw new Error('BLOCKED: unsafe database')
    }
  }
  return {
    api, state, record, readSql, dependencies,
    run: () => verifyMaterialBomValidationClosure({ api, caseRecord: record, unit: { id: '7' } }, dependencies)
  }
}

test('PB032-003 scope, write switch and exact IDs are fail-closed', () => {
  assert.doesNotThrow(() => assertMaterialBomScope(local, true))
  assert.throws(() => assertMaterialBomScope(local, false), /BLOCKED/)
  for (const change of [
    { target: 'online' }, { tenantId: '2' }, { tenantName: 'other' },
    { db: { name: 'cfor_admin_saas_standard' } }, { apiBase: 'http://localhost:48084' },
    { webBase: 'https://example.com:9151' }, { apiBase: 'http://user:secret@localhost:48083' }
  ]) assert.throws(() => assertMaterialBomScope({ ...local, ...change }, true), /BLOCKED/)
  assert.equal(__internal.exactId('9007199254740993'), '9007199254740993')
  for (const id of [9007199254740993, '', null, '1 OR 1', '-1']) {
    assert.throws(() => __internal.exactId(id), /BLOCKED/)
  }
})

test('PB032-003 exact rejection uses the offending material name and formal scenario description', () => {
  const contract = materialBomRejection('SERVICE-NAME')
  assert.equal(contract.code, 2010100007)
  assert.equal(contract.message,
    '存货(SERVICE-NAME)不能用于生产 BOM 用料：服务项目和虚拟件不参与生产与物料需求计划')
  assert.equal(matchesExpectedBusinessRejection({ code: contract.code, msg: contract.message }, contract), true)
  for (const response of [
    { code: 500, msg: contract.message }, { code: 2010100006, msg: contract.message },
    { code: 2010100007, msg: contract.message.replace('SERVICE-NAME', 'wrong-material') },
    { code: 2010100007, msg: contract.message.replace(' BOM 用料', ' BOM') },
    { code: 2010100007, msg: '服务暂时不可用' },
    { code: 0, data: '123' }, { code: 2010100007, success: true, msg: contract.message }
  ]) assert.equal(matchesExpectedBusinessRejection(response, contract), false)
})

test('PB032-003 four parent/child rejects use only current owned materials and leave API/SQL unchanged', async () => {
  const h = harness()
  const fixture = await h.run()
  assert.equal(h.state.safetyChecks, 1)
  assert.equal(fixture.materials.length, 3)
  const [stock, service, virtual] = fixture.materials
  assert.deepEqual(fixture.attempts.map(({ body }) => [body.stockId, body.wmsAssembleSubList[0].stockId]), [
    [service.id, stock.id], [virtual.id, stock.id], [stock.id, service.id], [stock.id, virtual.id]
  ])
  for (const attempt of fixture.attempts) {
    assert.equal(attempt.body.bomUsage, 'PRODUCTION')
    assert.equal(attempt.body.stockCount, 1)
    assert.equal(attempt.body.wmsAssembleSubList[0].subStockCount, 1)
    assert.equal('id' in attempt.body, false)
    assert.equal('parentId' in attempt.body.wmsAssembleSubList[0], false)
    assert.deepEqual(attempt.before, attempt.after)
  }
  assert.deepEqual(h.record.checks.map(({ name, passed }) => [name, passed]),
    Object.values(materialBomCheckNames).map((name) => [name, true]))
  assert.deepEqual(h.state.deleted, [virtual.id, service.id, stock.id])
  assert.ok(fixture.materials.every((row) => row.status === 'cleaned'))
  assert.equal(fixture.cleanup.passed, true)
  assert.equal(h.record.fixtures[0], fixture)
  assert.equal(h.state.posts.filter((row) => row.pathname === '/mes/wmsAssemble/add').length, 4)
  assert.equal(h.state.queries.filter((sql) => sql.includes('bom-main-count')).length, 9)
  assert.equal(h.record.database.length, 12)
})

test('PB032-003 material bodies respect nonphysical capability rules instead of failing during setup', () => {
  const fixture = { marker: 'E2E-PB032003-ABCDEF0123456789' }
  for (const nature of ['STOCK', 'SERVICE', 'VIRTUAL']) {
    const body = __internal.materialBody(fixture, nature, '7')
    assert.equal(body.produced, nature === 'STOCK' ? 'Y' : 'N')
    assert.equal(body.isMaterial, nature === 'STOCK' ? 'Y' : 'N')
    assert.equal(body.virtualGoods, nature === 'VIRTUAL' ? 'Y' : 'N')
    assert.equal(body.unitId, '7')
    assert.equal(body.periodManaged, 'N')
    assert.equal(body.batchManaged, 'N')
  }
})

for (const [name, response] of [
  ['success', { code: 0, data: '987' }],
  ['service error', { code: 500, msg: '系统异常' }],
  ['wrong scenario', { code: 2010100007, msg: '存货不能用于生产工单' }],
  ['permission failure', { code: 403, msg: '没有权限' }],
  ['malformed response', {}],
  ['empty response', null]
]) {
  test(`PB032-003 ${name} remains a hard failure, not an expected rejection or GAP`, async () => {
    const h = harness({ response })
    await assert.rejects(h.run(), /SERVICE 母件与 STOCK 子件/)
    assert.equal(h.record.checks[0].passed, false)
    assert.equal(h.state.deleted.length, 3)
    assert.equal(h.record.fixtures[0].attempts.length, 1)
  })
}

test('PB032-003 network errors retain their original evidence and still capture after state', async () => {
  const h = harness({ networkFailure: true })
  await assert.rejects(h.run(), /SERVICE 母件与 STOCK 子件/)
  const attempt = h.record.fixtures[0].attempts[0]
  assert.match(attempt.requestError, /ECONNRESET original network evidence/)
  assert.deepEqual(attempt.before, attempt.after)
  assert.equal(h.record.checks[0].passed, false)
})

for (const source of ['API', 'SQL']) {
  test(`PB032-003 exact rejection with changed ${source} facts must fail`, async () => {
    const h = harness({
      afterPost: (_body, state) => {
        if (source === 'API') [...state.materials.values()][0].refCost = 25
        else state.sqlRevision = 'changed'
      }
    })
    await assert.rejects(h.run(), /SERVICE 母件与 STOCK 子件/)
    assert.equal(h.record.checks[0].passed, false)
    assert.equal(h.state.deleted.length, 3)
  })
}

test('PB032-003 unexpected committed BOM/default reference is retained, not erased by cleanup', async () => {
  const h = harness({
    afterPost: (body, state) => {
      state.boms.push({ ...copy(body), id: '987' })
      state.subs.push({ id: '988', parentId: '987', ...body.wmsAssembleSubList[0] })
      state.materials.get(body.stockId).defaultProdBom = '987'
    }
  })
  await assert.rejects(h.run(), /SERVICE 母件与 STOCK 子件.*清理失败/)
  assert.equal(h.state.deleted.length, 0)
  assert.equal(h.state.boms.length, 1)
  assert.equal(h.record.checks.find((row) => row.name === materialBomCheckNames.cleanup).passed, false)
})

test('PB032-003 orphan subrows are not hidden by a main-table-only absence check', async () => {
  const h = harness({
    afterPost: (body, state) => { state.subs.push({ ...body.wmsAssembleSubList[0], id: '999' }) }
  })
  await assert.rejects(h.run(), /SERVICE 母件与 STOCK 子件.*清理失败/)
  assert.equal(h.state.deleted.length, 0)
  assert.equal(h.record.checks[0].passed, false)
})

test('PB032-003 refuses malformed SQL evidence even if the endpoint rejected exactly', async () => {
  const h = harness({ sqlRows: (rows) => rows.filter((row) => row[0] !== 'bom-sub-count') })
  await assert.rejects(h.run(), /缺少 SQL 计数 bom-sub-count/)
  assert.equal(h.state.posts.filter((row) => row.pathname === '/mes/wmsAssemble/add').length, 0)
  assert.equal(h.state.deleted.length, 0)
})

test('PB032-003 scope and database safety failures perform zero writes', async () => {
  for (const change of [{ config: { ...local, tenantId: '2' } }, { writeFixturesEnabled: false }]) {
    const h = harness()
    Object.assign(h.dependencies, change)
    await assert.rejects(h.run(), /BLOCKED/)
    assert.equal(h.state.posts.length, 0)
  }
  const h = harness({ safetyFailure: true })
  await assert.rejects(h.run(), /unsafe database/)
  assert.equal(h.state.posts.length, 0)
})

test('PB032-003 recovers lost create responses only by exact owned code/marker and cleans before rethrow', async () => {
  const h = harness({ createFailureAt: 2 })
  await assert.rejects(h.run(), /injected lost create response/)
  assert.equal(h.record.fixtures[0].materials.length, 2)
  assert.equal(h.state.deleted.length, 2)
  assert.ok(h.record.fixtures[0].materials.every((row) => row.status === 'cleaned'))
  assert.equal(h.record.fixtures[0].attempts.length, 0)
})

test('PB032-003 changed owner marker refuses all BOM writes and material deletes', async () => {
  const h = harness({ readDetail: (row) => ({ ...row, remark: 'not-owned' }) })
  await assert.rejects(h.run(), /所有权\/形态不匹配/)
  assert.equal(h.state.posts.filter((row) => row.pathname === '/mes/wmsAssemble/add').length, 0)
  assert.equal(h.state.deleted.length, 0)
})

test('PB032-003 cleanup API failure remains a failed named check', async () => {
  const h = harness({ deleteFailure: true })
  await assert.rejects(h.run(), /专属物料正式清理/)
  assert.equal(h.record.checks.at(-1).passed, false)
  assert.equal(h.record.fixtures[0].cleanup.passed, false)
})

test('PB032-003 SQL is tenant-scoped, snapshots deleted rows and discovers orphan child inserts', () => {
  const marker = 'E2E-PB032003-ABCDEF0123456789'
  const sql = __internal.scopeSql({ marker, materials: [{ id: '9007199254740993' }] })
  assert.match(sql, /SELECT 'bom-main',b\.\*/)
  assert.match(sql, /SELECT 'bom-sub',s\.\*/)
  assert.match(sql, /SELECT 'material',m\.\*/)
  assert.match(sql, /s\.stock_id IN \('9007199254740993'\)/)
  assert.match(sql, /s\.parent_id IN/)
  assert.doesNotMatch(sql, /deleted=0/)
  assert.match(sql, /b\.tenant_id=1/)
  assert.match(sql, /s\.tenant_id=1/)
  assert.match(sql, /m\.tenant_id=1/)
  assert.throws(() => __internal.scopeSql({ marker: 'shared', materials: [{ id: '1' }] }), /BLOCKED/)
  assert.throws(() => __internal.scopeSql({ marker, materials: [{ id: '1 OR 1' }] }), /BLOCKED/)
})

const suiteHarness = (options = {}) => {
  const h = harness(options)
  const navigation = []
  const page = {
    request: {
      async get (url) {
        assert.match(url, /\/mes\/basMaterial\/list\?pageNo=1&pageSize=100$/)
        return { ok: () => true, status: () => 200, json: async () =>
          paged([{ id: '42', inventoryNature: 'STOCK' }]) }
      }
    }
  }
  return {
    ...h,
    context: { caseId: 'PB032-003', caseRecord: h.record, record: { environment: {} }, page },
    dependencies: {
      ...h.dependencies,
      createApiClient: () => h.api,
      loginWithCredentials: async () => 'offline-only-token',
      openRoute: async (_page, route) => { navigation.push(route) }
    },
    navigation
  }
}

test('PB032-003 init dispatch maps exactly four real BOM rejects plus cleanup but retains work/MRP GAP', async () => {
  const h = suiteHarness()
  const result = await runCase(h.context, h.dependencies)
  assert.deepEqual(h.navigation, ['/mes/base/assemble'])
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.deepEqual(h.record.catalogAssertions.map((row) => [row.index, row.status]), [
    [0, 'VERIFIED'], [1, 'VERIFIED'], [2, 'GAP'], [3, 'GAP']
  ])
  assert.deepEqual(INIT_CASE_CATALOG_EVIDENCE['PB032-003'][1].checks, Object.values(materialBomCheckNames))
  assert.match(h.record.remainingAssertions[0].reason, /MES_WORK_ORDER/)
  assert.match(h.record.remainingAssertions[1].reason, /MRP_DEMAND/)
  assert.match(materialBomContractGaps.workOrder, /未调用 MES_WORK_ORDER 场景校验/)
  assert.match(materialBomContractGaps.mrp, /未调用 MRP_DEMAND 场景校验/)
})

test('PB032-003 removing any single group or cleanup evidence cannot verify the BOM assertion', async () => {
  for (const missing of Object.values(materialBomCheckNames)) {
    const h = suiteHarness()
    h.dependencies.verifyMaterialBomValidationClosure = async ({ caseRecord }) => {
      caseRecord.checks.push(...Object.values(materialBomCheckNames).filter((name) => name !== missing)
        .map((name) => ({ name, passed: true, details: 'offline test only' })))
    }
    const result = await runCase(h.context, h.dependencies)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(h.record.catalogAssertions[1].status, 'GAP', missing)
    assert.equal(h.state.posts.length, 0)
  }
})

test('PB032-003 disabled writes and missing units never start fixture creation', async () => {
  const disabled = suiteHarness()
  disabled.dependencies.writeFixturesEnabled = false
  const result = await runCase(disabled.context, disabled.dependencies)
  assert.equal(result.partial, true)
  assert.equal(disabled.state.apiReads.length, 0)
  assert.equal(disabled.state.posts.length, 0)
  assert.equal(disabled.record.catalogAssertions[1].status, 'GAP')
  const missing = suiteHarness({ noUnit: true })
  await assert.rejects(runCase(missing.context, missing.dependencies), /缺少既有启用单位/)
  assert.equal(missing.state.posts.length, 0)
})
