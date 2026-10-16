import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  MES_ROUTE_VERSION_ASSERTIONS, MES_ROUTE_VERSION_CHECKS, MES_ROUTE_VERSION_OPTIONS,
  MES_ROUTE_TASK_API_FIELDS, MES_ROUTE_RESOURCE_GAP, assertMesRouteVersionTarget,
  MES_ROUTE_CONFIGURATION_REJECTION, assertMesRouteConfigurationWrite,
  prepareMesRouteConfiguration, readMesRouteConfiguration, verifyMesRouteConfigurationFrozen,
  prepareMesRouteConfigurationCleanup, auditMesRouteConfigurationCleanup,
  assertMesRouteTaskSnapshot, assertMesRouteTaskUnchanged, finalizeMesRouteVersionAssertions,
  mesRouteFactHash, mesRouteVersionScopedApi, readMesRouteFullRows,
  selectMesRouteReadyBom, verifyMesRouteReleaseGate, auditMesRouteOwnedCleanup,
  runMesRouteVersionClosure, verifyMesRouteVersionPage
} from '../fixtures/mes-route-version-closure.mjs'
import { runCase } from '../suites/mes-base.mjs'

const ok = (data) => ({ code: 0, data })
const ids = Object.fromEntries(['route', 'newRoute', 'node', 'newNode', 'procedure', 'team', 'work',
  'task', 'product', 'line', 'order', 'bom', 'component', 'unit']
  .map((key, index) => [key, `21000000000000000${10 + index}`]))
const marker = 'AUTOTEST-MESB006-UNIT'
const column = (field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const settings = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const newCase = () => ({ checks: [], notes: [], evidence: [] })
const taskData = () => ({
  ...Object.fromEntries(MES_ROUTE_TASK_API_FIELDS.map((field) => [field, null])),
  id: ids.task, workTicketId: ids.work, productId: ids.product, routing: ids.route,
  processId: ids.procedure, routeNodeId: ids.node, routeVersion: 'V1.0', status: 5,
  isDeleted: 0, isEffective: 'Y', taskNum: 2, workTicketTotal: 2, remark: marker,
  teamId: ids.team, memberIds: '7', leaderId: '7', prodLineId: ids.line,
  taskFields: [], taskMaterials: [], materialAggregates: [], maxReportableQty: 2,
  updateTime: '2026-10-14 08:00:00'
})
const sqlData = (task) => ({
  ...Object.fromEntries(MES_ROUTE_TASK_API_FIELDS.map((field) =>
    [column(field), task[field] == null ? null : String(task[field])])),
  tenant_id: '1', extra_actual_column: null
})
const taskFixture = () => ({
  tasks: [{ id: ids.task }], works: [{ id: ids.work }],
  material: { id: ids.product }, procedure: { id: ids.procedure }, marker
})
const route = (upgraded = false) => ({
  id: upgraded ? ids.newRoute : ids.route, code: 'UNIT-RT', name: `${marker}-ROUTE`, mark: marker,
  version: upgraded ? 'V1.1' : 'V1.0', devStatus: 0, publishTime: null, publishBy: null,
  notes: null, type: '1', isStrict: 'Y', designMode: 'sequential', inboundType: 'FINISHED'
})
const node = (upgraded = false) => ({
  id: upgraded ? ids.newNode : ids.node, parentId: upgraded ? ids.newRoute : ids.route,
  procedureId: ids.procedure, procedureName: 'UNIT-PROC', mark: marker,
  sortOrder: 1, isFeed: 0, isQuality: 0, isFinished: 1, isVirtualNode: 0, outsourceFlag: 0
})
const readyBom = () => ({
  bomId: ids.bom, bomCode: 'UNIT-BOM', parentId: ids.product, parentCode: 'UNIT-PARENT',
  childId: ids.component, childCode: 'UNIT-CHILD', bomUsage: 'PRODUCTION', devStatus: '2',
  stockCount: '1.000000', subStockCount: '1.000000', lossRate: '0.00', hasChild: 'N',
  bomUnitId: ids.unit, parentUnitId: ids.unit, subUnitId: ids.unit, childUnitId: ids.unit,
  activeSubCount: '1', availableQty: '2.000000', inventoryRows: '2', inventoryUnitRows: '2',
  inventoryUnitId: ids.unit, inventoryMaxUnitId: ids.unit
})
const releaseGate = () => ({
  prodOrderId: ids.order, enabled: true, passed: true,
  items: [{ code: 'BOM', passed: true }, { code: 'MATERIAL', passed: true }]
})

function harness (options = {}) {
  const calls = []
  const record = { runId: 'offline-unit', environment: { tenantId: '1' } }
  const caseRecord = newCase()
  const routes = new Map([[ids.route, route()]])
  const nodes = new Map([[ids.route, node()]])
  let task
  let reads = 0
  const fixture = {
    marker, shortCode: 'UNIT', withOpeningInventory: false, reuseEnabledBom: true, opening: null,
    route: { kind: 'route', id: ids.route, identity: 'UNIT-RT' },
    procedure: { kind: 'procedure', id: ids.procedure, identity: 'UNIT-PROC' },
    material: { id: ids.product }, works: [{ id: ids.work }], tasks: [], owned: [],
    fixtureRecord: { cleanup: null },
    selectEnabledBom () { throw new Error('shared selector must not run for this case') },
    remember (kind, id, identity) {
      const resource = { kind, id, identity, marker }
      this.owned.push(resource)
      return resource
    },
    async setup () {
      calls.push(['setup'])
      await this.selectEnabledBom()
      for (const kind of ['team', 'procedure', 'route', 'work']) this.remember(kind, ids[kind], kind === 'route' ? 'UNIT-RT' : kind)
      this.order = this.remember('order', ids.order, 'UNIT-ORDER')
      if (options.partialSetup) {
        this.route = undefined
        throw new Error('unit setup response failure')
      }
      await this.api.postBusiness('/mes/prodWork/transferWorkOrder', [{ prodOrderId: ids.order }])
    },
    async scheduleTask () {
      calls.push(['schedule'])
      assert.equal(routes.get(ids.route).devStatus, 2, 'test fixture must be published first')
      assert.ok(routes.get(ids.route).publishBy)
      task = taskData()
      if (options.scheduleResponseLost) throw new Error('unit schedule response failure')
      this.tasks = [{ id: ids.task }]
      this.remember('task', ids.task, 'UNIT-TASK')
    },
    assertOwnedTask (value) {
      assert.equal(value.workTicketId, ids.work)
      assert.equal(value.routing, ids.route)
      assert.equal(value.productId, ids.product)
    },
    async assertCleanupOwnership (resource) {
      calls.push(['ownership', resource.kind, resource.id])
      if (options.ownershipFailure && resource.kind === 'team') throw new Error('unit ownership failed')
    },
    async cleanupResource (resource) {
      calls.push(['clean', resource.kind, resource.id])
      resource.cleanup = 'DELETED_VERIFIED'
      return true
    },
    async cleanup (caseRecord) {
      calls.push(['cleanup'])
      const results = []
      for (const resource of [...this.owned].reverse()) results.push(await this.cleanupResource(resource, caseRecord))
      this.fixtureRecord.cleanup = results.every(Boolean) ? 'VERIFIED' : 'INCOMPLETE'
    }
  }
  const originalCleanup = fixture.cleanupResource
  const originalSelector = fixture.selectEnabledBom
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      const url = new URL(path, 'http://unit.test')
      if (url.pathname === '/mes/basUnit/list/enabled') {
        if (options.unitApiError) throw new Error('BLOCKED: unit official API execution failed')
        if (options.unitApiFailure) return { code: 403, msg: 'permission denied' }
        return ok([{ id: ids.line }, { id: ids.unit, name: 'actual unit' }])
      }
      if (url.pathname === '/mes/prodOrder/release-gate') {
        if (options.gateApiFailure) return { code: 403, msg: 'permission denied' }
        if (options.gateFailure) return ok({ ...releaseGate(), passed: false,
          items: [{ code: 'BOM', passed: true }, { code: 'MATERIAL', passed: false }] })
        return ok(releaseGate())
      }
      if (url.pathname === '/mes/wmsTechRoute/queryById') {
        const value = structuredClone(routes.get(url.searchParams.get('id')))
        if (options.wrongIdentity) value.mark = 'another-owner'
        return ok(value)
      }
      if (url.pathname === '/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId') {
        const value = nodes.get(url.searchParams.get('parentId'))
        return ok({ records: [structuredClone(value)], total: options.incompletePage ? 2 : 1 })
      }
      if (url.pathname === '/mes/wmsTechRoute/list') return ok({ records: [...routes.values()], total: routes.size })
      if (url.pathname === '/mes/prodWorkTask/list') return ok({ records: task ? [task] : [], total: task ? 1 : 0 })
      if (url.pathname === '/mes/prodWorkTask/queryById') {
        reads++
        const value = structuredClone(task)
        if (options.missingField) delete value[options.missingField]
        if (options.apiDrift && reads > 1) value.customField20 = 'drift'
        return ok(value)
      }
      throw new Error('unexpected offline API')
    },
    async postBusiness (path, payload) {
      calls.push(['POST', path, payload])
      const url = new URL(path, 'http://unit.test')
      if (url.pathname === '/mes/prodWork/transferWorkOrder') {
        return ok(true)
      } else if (url.pathname === '/mes/wmsTechRoute/editMain') {
        if (routes.get(ids.route).devStatus === 0) routes.get(ids.route).notes = payload.notes
        else {
          routes.set(ids.newRoute, { ...route(true), notes: payload.notes })
          nodes.set(ids.newRoute, node(true))
          if (options.cloneResponseLost) throw new Error('unit clone response failure')
        }
      } else if (url.pathname === '/mes/wmsTechRoute/publish') {
        const value = routes.get(url.searchParams.get('id'))
        if (!options.noPublication) Object.assign(value, { devStatus: 2, publishBy: '1', publishTime: '2026-10-14 08:00:00' })
      } else if (url.pathname === '/mes/wmsTechRoute/unpublish') {
        routes.get(url.searchParams.get('id')).devStatus = 3
      } else throw new Error('unexpected offline write')
      return ok(true)
    },
    async request (method, path, _payload, requestOptions) {
      calls.push([method, path, requestOptions])
      if (options.rejection) return options.rejection
      return { code: requestOptions.expectedBusinessRejection.code, msg: requestOptions.expectedBusinessRejection.message }
    }
  }
  const sql = async (query) => {
    calls.push(['SQL', query])
    assert.match(query.trim(), /^SELECT\b/)
    if (query.includes('FROM mes_wms_assemble bom')) {
      return { available: true, rows: options.noReadyBom ? [] : [[JSON.stringify(readyBom())]] }
    }
    if (query.includes("SELECT 'order'")) {
      return { available: true, rows: options.cleanupResidue
        ? [['task', ids.task, '0', ids.work, '1']] : [] }
    }
    let table
    let rows
    if (query.includes('information_schema.COLUMNS')) table = query.match(/TABLE_NAME='([^']+)'/)[1]
    else table = query.match(/FROM `([^`]+)`/)[1]
    if (table === 'mes_prod_work_task') {
      const value = sqlData(task ?? taskData())
      if (options.sqlDrift && reads > 1) value.extra_actual_column = 'drift'
      rows = [value]
    } else if (table === 'mes_wms_tech_route') {
      rows = [...routes.values()].map((value) => ({
        ...Object.fromEntries(Object.entries(value).map(([key, value]) =>
          [column(key), value == null ? null : String(value)])), tenant_id: '1', deleted: '0'
      }))
    } else {
      rows = [...nodes.values()].map((value) => ({
        ...Object.fromEntries(Object.entries(value).map(([key, value]) =>
          [column(key), value == null ? null : String(value)])), tenant_id: '1', deleted: '0'
      }))
    }
    if (query.includes('information_schema.COLUMNS')) {
      return { available: true, rows: Object.keys(rows[0]).map((key) => [key, key === 'deleted' ? 'bit' : 'varchar']) }
    }
    const where = query.match(/(?:parent_id|(?<!tenant_)id)='(\d+)'/)?.[1]
    if (table !== 'mes_prod_work_task') rows = rows.filter((value) => (value.parent_id ?? value.id) === where)
    return { available: true, rows: rows.map((value) => [JSON.stringify(value)]) }
  }
  const dependencies = {
    settings, writeFlag: 'true', assertLocalWriteSafety: async () => { calls.push(['safety']) },
    runReadOnlySql: sql,
    prepareConfiguration: async (_fixture, _sql, target) => {
      calls.push(['configurationDraft'])
      target.checks.push({ name: MES_ROUTE_VERSION_CHECKS.configurationDraft, passed: true, details: 'offline draft' })
    },
    verifyConfigurationFrozen: async (_fixture, _sql, target) => {
      calls.push(['configurationFrozen'])
      for (const key of ['equipmentFrozen', 'qualityFrozen', 'resourceFrozen']) {
        target.checks.push({ name: MES_ROUTE_VERSION_CHECKS[key], passed: !options.configurationFailure,
          details: 'offline precise configuration proof' })
      }
    },
    prepareConfigurationCleanup: async () => { calls.push(['configurationCleanupPrepare']) },
    auditConfigurationCleanup: async (_fixture, _sql, target) => {
      target.checks.push({ name: MES_ROUTE_VERSION_CHECKS.configurationCleanup, passed: true, details: 'offline audit' })
    },
    createFixture: (scoped, _record, caseId, setupOptions) => {
      assert.equal(caseId, 'MES-BASE-006')
      assert.deepEqual(setupOptions, MES_ROUTE_VERSION_OPTIONS)
      fixture.api = scoped
      return fixture
    }
  }
  const run = (extra = {}) => runMesRouteVersionClosure({
    api, record, caseRecord, tenantId: '1', dependencies,
    verifyPage: async () => {
      calls.push(['page'])
      if (options.pageFailure) throw new Error(options.pageFailure === 'blocked'
        ? 'BLOCKED: unit page failed after official menu' : 'unit page failed')
      return { available: true, route: '/formal/route', domAndApiSucceeded: true, configurationSucceeded: true }
    }, ...extra
  })
  return { run, fixture, api, record, caseRecord, calls, routes, originalCleanup, originalSelector, dependencies }
}

test('MESB006 maps original assertions to unique configuration checks and requires page/cleanup evidence', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((row) => row.id === 'MES-BASE-006')
  assert.deepEqual(MES_ROUTE_VERSION_ASSERTIONS, definition.assertions)
  const record = newCase()
  for (const name of Object.values(MES_ROUTE_VERSION_CHECKS)) record.checks.push({ name, passed: true, details: 'offline' })
  const result = finalizeMesRouteVersionAssertions(record)
  assert.deepEqual(record.catalogAssertions.map((row) => row.status), ['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED'])
  assert.equal(result.partial, false)
  assert.equal(result.passCandidate, true)
  assert.equal(result.acceptanceComplete, true)
  for (const name of Object.values(MES_ROUTE_VERSION_CHECKS)) {
    const incomplete = { ...newCase(), checks: record.checks.filter((row) => row.name !== name) }
    assert.equal(finalizeMesRouteVersionAssertions(incomplete).acceptanceComplete, false, name)
  }
  const failedConfiguration = { ...newCase(), checks: record.checks.map((row) =>
    row.name === MES_ROUTE_VERSION_CHECKS.qualityFrozen ? { ...row, passed: false } : row) }
  finalizeMesRouteVersionAssertions(failedConfiguration)
  assert.equal(failedConfiguration.catalogAssertions[0].status, 'GAP')
  assert.ok(failedConfiguration.catalogAssertions[0].details.includes(MES_ROUTE_RESOURCE_GAP))
  record.checks.push({ name: MES_ROUTE_VERSION_CHECKS.snapshot, passed: true })
  finalizeMesRouteVersionAssertions(record)
  assert.equal(record.catalogAssertions[2].status, 'GAP', 'duplicate checks cannot prove an assertion')
})

test('MESB006 guard rejects nonlocal/tenant/write/DB targets before any operations', async () => {
  for (const change of [
    { settings: { ...settings, target: 'online' } },
    { settings: { ...settings, tenantId: '2' } },
    { settings: { ...settings, apiBase: 'http://example.test:48083' } },
    { settings: { ...settings, webBase: 'http://127.0.0.1:9152' } },
    { settings: { ...settings, db: { ...settings.db, name: 'other' } } },
    { writeFlag: 'false' }
  ]) {
    const h = harness()
    await assert.rejects(h.run({ dependencies: { ...h.dependencies, ...change } }))
    assert.deepEqual(h.calls, [])
  }
  assert.throws(() => assertMesRouteVersionTarget({ environment: { tenantId: '2' } }, settings, 'true', '1'))
  for (const tenantId of [undefined, '2']) {
    const h = harness()
    await assert.rejects(h.run({ tenantId }), /formal login tenant1/)
    assert.deepEqual(h.calls, [])
  }
})

test('MESB006 scoped API blocks stock/execution/authorization/material writes only within this helper', async () => {
  const calls = []
  const underlying = { request: async (...args) => { calls.push(args); return ok(true) } }
  const scoped = mesRouteVersionScopedApi(underlying)
  for (const path of ['/mes/stkIo/add', '/mes/stkInventory/list', '/mes/prodWorkTask/start',
    '/mes/prodWorkReport/add', '/mes/wmsTechRoute/batchCreateProcedureQuality',
    '/mes/wmsTechRoute/saveprocedureEquipmentRelation', '/system/permission/assign-role-menu',
    '/system/tenant-package/update', '/mes/basMaterial/edit', '/mes/wmsAssemble/add']) {
    assert.throws(() => scoped.request('POST', path, {}), path)
  }
  await scoped.request('GET', '/mes/wmsAssemble/queryById?id=1')
  await underlying.request('POST', '/mes/wmsTechRoute/saveprocedureEquipmentRelation', {})
  assert.equal(calls.length, 2, 'shared API and procedure policy remain untouched')
})

function bomHarness (overrides = {}) {
  const calls = []
  const caseRecord = { ...newCase(), mesRouteVersionEvidence: {} }
  const fixture = { unit: { id: ids.line }, owned: [], fixtureRecord: {}, api: {
    getBusiness: async (path) => { calls.push(['GET', path]); return ok([{ id: ids.line }, { id: ids.unit }]) }
  } }
  const readSql = async (query) => {
    calls.push(['SQL', query])
    return { available: true, rows: [[JSON.stringify({ ...readyBom(), ...overrides })]] }
  }
  return { fixture, caseRecord, calls, readSql, run: () => selectMesRouteReadyBom(fixture, readSql, caseRecord) }
}

test('MESB006 ready BOM SQL strictly scopes existing cross-warehouse stock and the unique legal unit-consumption child', async () => {
  const h = bomHarness()
  const evidence = await h.run()
  assert.equal(h.fixture.unit.id, ids.unit, 'replace randomly selected setup unit with actual component unit')
  assert.equal(h.fixture.component.unitId, h.fixture.unit.id)
  assert.equal(h.fixture.material.unitId, h.fixture.unit.id)
  assert.equal(h.fixture.bom.shared, true)
  assert.equal(h.fixture.component.shared, true)
  assert.equal(h.fixture.material.shared, true)
  assert.deepEqual(h.fixture.owned, [], 'shared BOM/material/stock must never enter cleanup registry')
  assert.equal(evidence.availableQty, '2.000000')
  assert.equal(evidence.requiredQty, '2')
  const sql = h.calls.find(([method]) => method === 'SQL')[1]
  for (const contract of [
    /SUM\(COALESCE\(available_qty,qty\)\)/, /tenant_id=1 AND deleted=0 AND is_closed=0 GROUP BY material_id/,
    /sub\.tenant_id=1 AND sub\.deleted=0 AND COALESCE\(sub\.is_deleted,0\)=0/,
    /WHERE tenant_id=1 AND deleted=0 AND COALESCE\(is_deleted,0\)=0 GROUP BY parent_id/,
    /active_sub\.sub_count=1/, /bom\.stock_count=1/, /sub\.sub_stock_count=1/, /sub\.has_child='N'/,
    /parent\.inventory_nature='STOCK'/, /child\.inventory_nature='STOCK'/,
    /parent\.is_enabled=1/, /child\.is_enabled=1/, /bom\.unit_id=parent\.unit_id/,
    /sub\.unit_id=child\.unit_id/, /parent\.unit_id=child\.unit_id/,
    /stock\.available_qty>=2/, /stock\.min_unit_id=child\.unit_id AND stock\.max_unit_id=child\.unit_id/,
    /REGEXP '\^0\+\(\[\.\]0\+\)\?\$'/
  ]) assert.match(sql, contract)
  assert.ok(!/warehouse_id\s*=|\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql), 'do not restrict stock to fixture warehouse or write stock')
})

test('MESB006 invalid BOM ratios/loss/units/stock or malformed SQL facts cannot pass readiness', async () => {
  for (const overrides of [
    { stockCount: '2' }, { subStockCount: '0.5' }, { activeSubCount: '2' },
    { hasChild: 'Y' }, { hasChild: '0' },
    { lossRate: '0.1' }, { lossRate: 'not-a-rate' }, { devStatus: '0' }, { bomUsage: 'SALES' },
    { bomUnitId: ids.line }, { subUnitId: ids.line }, { inventoryMaxUnitId: ids.line },
    { inventoryRows: '0' }, { inventoryUnitRows: '1' }, { availableQty: '1.99999999999999999999' },
    { availableQty: 'NaN' }, { childId: ids.product }, { childUnitId: ids.line },
    { parentId: Number(ids.product) }, { bomCode: '' }
  ]) {
    const h = bomHarness(overrides)
    await assert.rejects(h.run(), undefined, JSON.stringify(overrides))
    assert.deepEqual(h.fixture.owned, [])
    assert.equal(h.fixture.unit.id, ids.line, 'do not bind partially validated facts')
    assert.equal(h.caseRecord.checks.length, 0)
  }
  const missing = bomHarness()
  const candidate = readyBom()
  delete candidate.childUnitId
  await assert.rejects(selectMesRouteReadyBom(missing.fixture, async () => ({
    available: true, rows: [[JSON.stringify(candidate)]]
  }), missing.caseRecord), /READY_BOM_FIELD_UNAVAILABLE/)
  await assert.rejects(selectMesRouteReadyBom(missing.fixture, async () => ({
    available: true, rows: []
  }), missing.caseRecord), /READY_BOM_SAMPLE_UNAVAILABLE/)
  await assert.rejects(selectMesRouteReadyBom(missing.fixture, async () => {
    throw new Error('unit SQL execution failed')
  }, missing.caseRecord), /unit SQL execution failed/)
  missing.fixture.api.getBusiness = async () => ({ code: 403 })
  await assert.rejects(missing.run(), /official API business failure/)
})

test('MESB006 both transfer API surfaces await the exact owned release-gate and block gaps before POST', async () => {
  for (const surface of ['postBusiness', 'request']) {
    for (const gate of [
      releaseGate(), { ...releaseGate(), enabled: false },
      { ...releaseGate(), passed: false, items: [{ code: 'BOM', passed: true }, { code: 'MATERIAL', passed: false }] }
    ]) {
      const calls = []
      const caseRecord = { ...newCase(), mesRouteVersionEvidence: {} }
      const order = { kind: 'order', id: ids.order, marker, identity: 'UNIT-ORDER' }
      const fixture = { order, owned: [order], marker }
      const api = {
        getBusiness: async (path) => { calls.push(['GET', path]); return ok(gate) },
        postBusiness: async () => { calls.push(['POST']); return ok(true) },
        request: async () => { calls.push(['POST']); return ok(true) }
      }
      const scoped = mesRouteVersionScopedApi(api, {
        beforeTransfer: (body) => verifyMesRouteReleaseGate({ api: scoped, fixture, body, caseRecord })
      })
      const body = [{ prodOrderId: ids.order }]
      const invoke = () => surface === 'request'
        ? scoped.request('POST', '/mes/prodWork/transferWorkOrder', body)
        : scoped.postBusiness('/mes/prodWork/transferWorkOrder', body)
      if (gate.enabled && gate.passed) {
        await invoke()
        assert.deepEqual(calls.map(([method]) => method), ['GET', 'POST'])
        assert.equal(caseRecord.checks[0].name, MES_ROUTE_VERSION_CHECKS.gate)
      } else {
        await assert.rejects(invoke(), /RELEASE_GATE_NOT_(?:ENABLED|PASSED)/)
        assert.deepEqual(calls.map(([method]) => method), ['GET'])
        assert.equal(caseRecord.checks.length, 0)
      }
      assert.equal(calls[0][1], `/mes/prodOrder/release-gate?prodOrderId=${ids.order}`)
    }
  }
})

test('MESB006 gate API failures, foreign identity and inconsistent or duplicate existing fields remain failures', async () => {
  const order = { kind: 'order', id: ids.order, marker, identity: 'UNIT-ORDER' }
  const fixture = { order, owned: [order], marker }
  const caseRecord = { ...newCase(), mesRouteVersionEvidence: {} }
  const verify = (response, body = [{ prodOrderId: ids.order }]) => verifyMesRouteReleaseGate({
    api: { getBusiness: async () => response }, fixture, body, caseRecord
  })
  for (const response of [
    { code: 403 }, { code: 500 }, ok(null), ok({ ...releaseGate(), prodOrderId: ids.product }),
    ok({ ...releaseGate(), enabled: 'true' }), ok({ ...releaseGate(), passed: false }),
    ok({ ...releaseGate(), items: [] }),
    ok({ ...releaseGate(), items: [{ code: 'BOM', passed: true }, { code: 'BOM', passed: true }] })
  ]) await assert.rejects(verify(response), (error) =>
    !/RELEASE_GATE_NOT_/.test(error.message) && error.code === 'ERR_ASSERTION')
  await assert.rejects(verify(ok(releaseGate()), [{ prodOrderId: ids.product }]), /ownership mismatch/)
  const missing = releaseGate()
  delete missing.enabled
  await assert.rejects(verify(ok(missing)), /RELEASE_GATE_FIELD_UNAVAILABLE/)
})

test('MESB006 no ready sample or failed gate stays PARTIAL with no transfer and finally zero-residue audit', async () => {
  for (const options of [{ noReadyBom: true }, { gateFailure: true }]) {
    const h = harness(options)
    const result = await h.run()
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(result.passCandidate, false)
    assert.ok(h.caseRecord.notes.some((text) => /READY_BOM_SAMPLE_UNAVAILABLE|RELEASE_GATE_NOT_PASSED/.test(text)))
    assert.ok(!h.calls.some(([method, path]) => method === 'POST' && path.includes('/transferWorkOrder')))
    assert.ok(!h.calls.some(([method]) => method === 'schedule'))
    assert.equal(h.fixture.fixtureRecord.cleanup, 'VERIFIED')
    assert.equal(h.fixture.selectEnabledBom, h.originalSelector)
    assert.equal(h.caseRecord.checks.find((row) => row.name === MES_ROUTE_VERSION_CHECKS.cleanupSnapshot).passed, true)
    assert.deepEqual(h.caseRecord.mesRouteVersionEvidence.cleanupSnapshot.counts.task, { any: 0, live: 0, retained: 0 })
  }
  for (const options of [{ gateApiFailure: true }, { unitApiFailure: true },
    { unitApiError: true }, { cleanupResidue: true }]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.ok(h.caseRecord.checks.some((row) => row.passed === false))
    assert.equal(h.fixture.selectEnabledBom, h.originalSelector)
  }
})

test('MESB006 only exact missing setup prerequisites are GAP; generic BLOCKED execution errors remain FAIL', async () => {
  for (const message of ['BLOCKED: 没有可复用计量单位', 'BLOCKED: 当前账号没有可见车间']) {
    const h = harness()
    h.fixture.setup = async () => { assert.fail(message) }
    const result = await h.run()
    assert.equal(result.partial, true)
    assert.ok(h.caseRecord.notes.some((text) => text === `MESB006 GAP: ${message}`))
    assert.equal(h.fixture.fixtureRecord.cleanup, 'VERIFIED')
    assert.equal(h.caseRecord.mesRouteVersionEvidence.cleanupSnapshot.counts.task.any, 0)
  }
  for (const message of ['BLOCKED: unexpected setup API exception', 'BLOCKED: 没有可复用计量单位']) {
    const h = harness()
    h.fixture.setup = async () => { throw new Error(message) }
    await assert.rejects(h.run(), (error) => error.message === message)
    assert.ok(h.caseRecord.checks.some((row) => row.passed === false))
    assert.ok(h.calls.some(([method]) => method === 'cleanup'))
  }
})

test('MESB006 independent cleanup SELECT reconciles deleted/retained registry rows and rejects unregistered facts', async () => {
  const owned = [
    { kind: 'order', id: ids.order, identity: 'UNIT-ORDER', marker, cleanup: 'DELETED_VERIFIED' },
    { kind: 'work', id: ids.work, marker, cleanup: 'DELETED_VERIFIED' },
    { kind: 'task', id: ids.task, marker, cleanup: 'RETAINED_AUDIT_TASK_HISTORY' }
  ]
  const fixture = { marker, owned }
  const caseRecord = { ...newCase(), mesRouteVersionEvidence: {} }
  const rows = [
    ['order', ids.order, '1', 'NULL', '1'],
    ['work', ids.work, '1', ids.order, '1'],
    ['task', ids.task, '0', ids.work, '1']
  ]
  let query
  const evidence = await auditMesRouteOwnedCleanup(fixture, async (sql) => {
    query = sql
    return { available: true, rows }
  }, caseRecord)
  assert.match(query.trim(), /^SELECT\b/)
  assert.match(query, /remark='AUTOTEST-MESB006-UNIT'/)
  assert.equal((query.match(/tenant_id=1/g) || []).length, 4)
  assert.deepEqual(evidence.counts.task, { any: 1, live: 1, retained: 1 })
  for (const invalid of [
    [...rows, ['task', ids.line, '0', ids.work, '1']],
    rows.map((row) => row[0] === 'work' ? [...row.slice(0, 2), '0', ...row.slice(3)] : row),
    rows.map((row) => row[0] === 'task' ? [row[0], row[1], row[2], ids.product, '1'] : row),
    rows.filter(([kind]) => kind !== 'task')
  ]) await assert.rejects(auditMesRouteOwnedCleanup(fixture,
    async () => ({ available: true, rows: invalid }), { ...newCase(), mesRouteVersionEvidence: {} }))
})

test('MESB006 complete task snapshots require every persisted API/SQL field, including nullable fields', () => {
  const data = taskData()
  const sql = sqlData(data)
  const capture = (api, row) => assertMesRouteTaskSnapshot(api, row, taskFixture(), route(), node())
  assert.ok(capture(data, sql))
  for (const field of [...MES_ROUTE_TASK_API_FIELDS, 'taskFields', 'taskMaterials', 'materialAggregates', 'maxReportableQty']) {
    const incomplete = { ...data }
    delete incomplete[field]
    assert.throws(() => capture(incomplete, sql), /FIELD_UNAVAILABLE/, field)
  }
  for (const field of [...MES_ROUTE_TASK_API_FIELDS.map(column), 'tenant_id']) {
    const incomplete = { ...sql }
    delete incomplete[field]
    assert.throws(() => capture(data, incomplete), /FIELD_UNAVAILABLE/, field)
  }
  for (const change of [{ status: 0 }, { routeVersion: null }, { routeNodeId: ids.newNode },
    { id: Number(ids.task) }, { workTicketId: ids.product }, { isEffective: 'N' }, { remark: 'other' }]) {
    assert.throws(() => capture({ ...data, ...change }, sql))
  }
})

test('MESB006 full-row reader preserves actual columns, nulls, bit values and Snowflake IDs', async () => {
  const calls = []
  const rows = await readMesRouteFullRows(async (query) => {
    calls.push(query)
    return { available: true, rows: query.includes('information_schema')
      ? [['id', 'bigint'], ['tenant_id', 'bigint'], ['deleted', 'bit'], ['extra', 'varchar']]
      : [[JSON.stringify({ id: ids.task, tenant_id: '1', deleted: '0', extra: null })]] }
  }, 'mes_prod_work_task', `id='${ids.task}'`)
  assert.equal(rows[0].id, ids.task)
  assert.equal(rows[0].extra, null)
  assert.match(calls[1], /CAST\(\(`deleted`\+0\) AS CHAR\)/)
  await assert.rejects(readMesRouteFullRows(async () => ({ available: false }), 'mes_prod_work_task', '1=1'), /READ_ONLY_SQL_UNAVAILABLE/)
  await assert.rejects(readMesRouteFullRows(async () => ({ available: true, rows: [] }), 'mes_prod_work_task', '1=1'), /SQL_TABLE_UNAVAILABLE/)
})

test('MESB006 any API or actual SQL field drift fails the full snapshot hash', () => {
  const before = { api: taskData(), sql: sqlData(taskData()) }
  const after = structuredClone(before)
  assertMesRouteTaskUnchanged(before, after)
  after.api.customField20 = 'changed'
  assert.throws(() => assertMesRouteTaskUnchanged(before, after), /Complete task API changed/)
  after.api = before.api
  after.sql.extra_actual_column = 'changed'
  assert.throws(() => assertMesRouteTaskUnchanged(before, after), /Complete task SQL row changed/)
  assert.equal(mesRouteFactHash({ a: 1, b: 2 }), mesRouteFactHash({ b: 2, a: 1 }))
})

test('MESB006 published scheduling, draft/published upgrade and disabled cleanup prove immutable task hashes', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(result.partial, false)
  assert.equal(result.passCandidate, true)
  assert.deepEqual(h.caseRecord.catalogAssertions.map((row) => row.status), ['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED'])
  const snapshots = h.caseRecord.mesRouteVersionEvidence.snapshots
  assert.deepEqual(snapshots.map((row) => row.phase),
    ['published-before-upgrade', 'upgraded-draft', 'upgraded-published', 'configuration-probed', 'disabled-before-cleanup'])
  assert.equal(new Set(snapshots.map((row) => row.apiHash)).size, 1)
  assert.equal(new Set(snapshots.map((row) => row.sqlHash)).size, 1)
  assert.ok(snapshots.every((row) => row.routeVersion === 'V1.0' && row.routeNodeId === ids.node))
  assert.ok(h.calls.findIndex(([method, path]) => method === 'POST' && path.includes('/publish')) <
    h.calls.findIndex(([method]) => method === 'schedule'))
  assert.equal(h.fixture.fixtureRecord.cleanup, 'VERIFIED')
  assert.equal(h.fixture.cleanupResource, h.originalCleanup)
  assert.ok(h.fixture.owned.every((row) => row.cleanup))
  for (const key of [ids.route, ids.newRoute]) assert.equal(h.routes.get(key).devStatus, 3)
  assert.equal(h.caseRecord.mesRouteVersionEvidence.retained.length, 4)
  assert.ok(!JSON.stringify(h.caseRecord).includes('"customField20":'), 'store hashes/field names, not task body')
})

test('MESB006 failed configuration proof stays incomplete while page, task and cleanup still run', async () => {
  const h = harness({ configurationFailure: true })
  const result = await h.run()
  assert.equal(result.acceptanceComplete, false)
  assert.equal(h.caseRecord.catalogAssertions[0].status, 'GAP')
  assert.equal(h.caseRecord.catalogAssertions[2].status, 'VERIFIED')
  assert.ok(h.calls.some(([name]) => name === 'page'))
  assert.equal(h.fixture.fixtureRecord.cleanup, 'VERIFIED')
  assert.ok(h.caseRecord.notes.some((note) => note.includes(MES_ROUTE_RESOURCE_GAP)))
  const noPage = harness()
  assert.equal((await noPage.run({ verifyPage: undefined })).acceptanceComplete, false)
  assert.ok(noPage.caseRecord.remainingEvidence.includes(MES_ROUTE_VERSION_CHECKS.page))
})

test('MESB006 absent task field remains GAP, but anomalous existing readbacks and page failures stay FAIL', async () => {
  const missing = harness({ missingField: 'routeVersion' })
  const result = await missing.run()
  assert.equal(result.partial, true)
  assert.equal(missing.caseRecord.catalogAssertions[2].status, 'GAP')
  assert.ok(missing.caseRecord.notes.some((text) => text.includes('TASK_FIELD_UNAVAILABLE: routeVersion')))
  assert.equal(missing.fixture.fixtureRecord.cleanup, 'VERIFIED')
  for (const options of [{ noPublication: true }, { apiDrift: true }, { sqlDrift: true },
    { wrongIdentity: true }, { incompletePage: true }, { pageFailure: true }, { pageFailure: 'blocked' },
    { rejection: { code: 403, msg: '无权限' } }, { rejection: { code: 500, msg: '系统异常' } },
    { rejection: { code: 400, msg: '不同拒绝原因' } }]) {
    const h = harness(options)
    await assert.rejects(h.run(), undefined, JSON.stringify(options))
    assert.ok(h.calls.some(([method]) => method === 'cleanup'), JSON.stringify(options))
    assert.ok(h.caseRecord.checks.some((row) => row.passed === false))
    assert.equal(h.caseRecord.passCandidate, false)
    if (options.noPublication) assert.ok(!h.calls.some(([method]) => method === 'schedule'))
  }
})

test('MESB006 partial setup or lost schedule/clone responses are registered and cleanup always runs', async () => {
  for (const options of [{ partialSetup: true }, { scheduleResponseLost: true }, { cloneResponseLost: true },
    { ownershipFailure: true }]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.ok(h.calls.some(([method]) => method === 'cleanup'))
    assert.equal(h.fixture.cleanupResource, h.originalCleanup)
    if (options.cloneResponseLost) {
      const resource = h.fixture.owned.find((row) => row.kind === 'route' && row.id === ids.newRoute)
      assert.equal(resource.cleanup, 'DELETED_VERIFIED', 'unpublished clone is registered and removed')
    }
    if (options.scheduleResponseLost) assert.ok(h.fixture.owned.some((row) => row.kind === 'task'))
    if (options.ownershipFailure) {
      assert.equal(h.fixture.fixtureRecord.cleanup, 'INCOMPLETE')
      assert.equal(h.caseRecord.checks.find((row) => row.name === MES_ROUTE_VERSION_CHECKS.cleanup).passed, false)
    }
  }
})

function configurationHarness (options = {}) {
  const calls = []
  const db = Object.fromEntries([
    'mes_procedure_equipment_relation', 'mes_procedure_quality_item',
    'mes_wms_procedure_main_resource', 'mes_wms_procedure_aux_resource',
    'mes_wms_procedure_material_usage', 'mes_wms_procedure_auto_split',
    'mes_wms_procedure_switch_config', 'mes_wms_procedure'
  ].map((table) => [table, []]))
  db.mes_wms_procedure.push({ id: ids.procedure, code: 'UNIT-PROC', mark: marker,
    name: 'UNIT-PROC', tenant_id: '1', deleted: '0' })
  const caseRecord = { ...newCase(), mesRouteVersionEvidence: { retained: [] } }
  const fixture = { marker, lineId: ids.line,
    procedure: { id: ids.procedure, identity: 'UNIT-PROC' },
    owned: [{ kind: 'procedure', id: ids.procedure, identity: 'UNIT-PROC', marker },
      { kind: 'route', id: ids.route, identity: 'UNIT-RT', marker },
      { kind: 'route', id: ids.newRoute, identity: 'UNIT-RT', marker }]
  }
  const toApi = (row) => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['deleted', 'tenant_id'].includes(key))
    .map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]))
  const active = (table) => db[table].filter((row) => row.deleted === '0').map(toApi)
  let sequence = 100
  let published = false
  const paths = {
    '/mes/wmsTechRoute/saveprocedureEquipmentRelation': 'mes_procedure_equipment_relation',
    '/mes/wmsTechRoute/batchCreateProcedureQuality': 'mes_procedure_quality_item',
    '/mes/wmsProcedure/editDetail': 'mes_wms_procedure_main_resource'
  }
  const mutate = (path, payload) => {
    const table = paths[path]
    for (const row of db[table]) row.deleted = '1'
    const values = path === '/mes/wmsProcedure/editDetail'
      ? payload.mainResources.map((row) => ({ ...row, procedureId: payload.id })) : payload
    for (const item of values) {
      db[table].push({ id: String(sequence++), tenant_id: '1', deleted: '0', extra_actual_column: null,
        ...Object.fromEntries(Object.entries(item).map(([key, value]) =>
          [column(key), typeof value === 'number' ? value.toFixed(6) : String(value)])) })
    }
  }
  const underlying = {
    async getBusiness (pathname) {
      calls.push(['GET', pathname])
      const url = new URL(pathname, 'http://unit.test')
      switch (url.pathname) {
        case '/mes/wmsProcedure/queryDetailById':
          return ok({ ...toApi(db.mes_wms_procedure[0]),
            mainResources: active('mes_wms_procedure_main_resource'),
            auxiliaryResources: [], materialUsages: [], autoSplit: null, switchConfig: null })
        case '/mes/procedure-equipment-relation/page':
          return ok({ list: active('mes_procedure_equipment_relation'),
            total: active('mes_procedure_equipment_relation').length })
        case '/mes/procedure-quality-item/page':
          return ok({ list: active('mes_procedure_quality_item'), total: active('mes_procedure_quality_item').length })
        case '/mes/quality/qualityPlan/queryById/dictText':
          return ok({ id: '201', publishStatus: 1 })
        case '/mes/main-resource/page':
          return ok({ records: [{ id: '204', resourceCode: 'UNIT-RESOURCE' }], total: 1 })
        default: throw new Error('Unexpected configuration read')
      }
    },
    async postBusiness (path, payload) {
      calls.push(['POST', path, payload])
      mutate(path, payload)
      if (options.lostResponse) throw new Error('unit configuration response lost')
      return ok(true)
    },
    async request (method, path, payload, requestOptions) {
      calls.push([method, path, payload, requestOptions])
      assert.equal(published, true, 'freeze probes must follow publication')
      if (options.acceptPublishedWrite || options.mutateDespiteRejection) mutate(path, payload)
      if (options.acceptPublishedWrite) return ok(true)
      return options.rejection ?? { code: 400, msg: MES_ROUTE_CONFIGURATION_REJECTION.message }
    },
    async deleteBusiness (path) {
      calls.push(['DELETE', path])
      const url = new URL(path, 'http://unit.test')
      const table = url.pathname.includes('equipment')
        ? 'mes_procedure_equipment_relation' : 'mes_procedure_quality_item'
      const row = db[table].find((item) => item.id === url.searchParams.get('id'))
      assert.ok(row)
      row.deleted = '1'
      return ok(true)
    }
  }
  fixture.api = mesRouteVersionScopedApi(underlying, {
    allowConfigurationWrite: (...args) => assertMesRouteConfigurationWrite(fixture, ...args)
  })
  const readSql = async (query) => {
    assert.match(query.trim(), /^SELECT\b/)
    calls.push(['SQL', query])
    if (query.includes('FROM mes_quality_plan p')) return { available: true,
      rows: options.noReferences ? [] : [['201', '202', 'UNIT-PLAN', 'UNIT-ITEM']] }
    if (query.includes('FROM iot_device')) return { available: true, rows: [['203', 'UNIT-DEVICE']] }
    if (query.includes('FROM aps_main_resource')) return { available: true, rows: [['204', 'UNIT-RESOURCE', 'UNIT MACHINE']] }
    if (query.includes('FROM mes_wms_tech_route_sub n')) {
      assert.ok(query.includes(`n.procedure_id='${ids.procedure}'`) &&
        query.includes('n.tenant_id=1') && query.includes('n.deleted=0') &&
        query.includes('r.tenant_id=n.tenant_id') && query.includes('r.deleted=0'))
      return { available: true, rows: options.routeReferences ?? [
        [ids.node, ids.route, 'UNIT-RT', marker, 'V1.0', published ? '2' : '0'],
        ...(published ? [[ids.newNode, ids.newRoute, 'UNIT-RT', marker, 'V1.1', '2']] : [])
      ] }
    }
    const metadata = query.includes('information_schema.COLUMNS')
    const table = metadata ? query.match(/TABLE_NAME='([^']+)'/)[1] : query.match(/FROM `([^`]+)`/)[1]
    assert.ok(Object.hasOwn(db, table), 'Only actual configuration tables are permitted')
    const rows = db[table]
    if (metadata) return { available: true,
      rows: [...new Set(['id', 'tenant_id', 'procedure_id', 'deleted', ...rows.flatMap(Object.keys)])]
        .filter((field) => table !== 'mes_wms_procedure' || field !== 'procedure_id')
        .map((field) => [field, field === 'deleted' ? 'bit' : 'varchar']) }
    return { available: true, rows: rows.map((row) => [JSON.stringify(row)]) }
  }
  // Keep an actual schema for empty tables and every persisted row.
  const normalizedSql = async (query) => {
    const result = await readSql(query)
    if (!query.includes('information_schema') && query.includes('FROM `')) {
      const table = query.match(/FROM `([^`]+)`/)[1]
      const fields = (await readSql(`SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_NAME='${table}'`))
        .rows.map(([key]) => key)
      result.rows = result.rows.map(([row]) => {
        const value = JSON.parse(row)
        return [JSON.stringify(Object.fromEntries(fields.map((field) => [field, value[field] ?? null])))]
      })
    }
    return result
  }
  return { fixture, caseRecord, calls, db, readSql: normalizedSql,
    prepare: () => prepareMesRouteConfiguration(fixture, normalizedSql, caseRecord),
    freeze: () => { published = true; return verifyMesRouteConfigurationFrozen(fixture, normalizedSql, caseRecord) } }
}

test('MESB006 configuration writes require one current registry-owned procedure and preserve shared API policy', () => {
  const h = configurationHarness()
  const path = '/mes/wmsTechRoute/batchCreateProcedureQuality'
  const body = [{ procedureId: ids.procedure, remark: marker }]
  assertMesRouteConfigurationWrite(h.fixture, 'POST', path, body)
  assert.throws(() => assertMesRouteConfigurationWrite(h.fixture, 'POST', '/mes/wmsProcedure/edit', body))
  for (const [method, endpoint, payload] of [
    ['PUT', path, body],
    ['POST', path, []], ['POST', path, [...body, ...body]],
    ['POST', path, [{ ...body[0], procedureId: ids.product }]],
    ['POST', path, [{ ...body[0], remark: 'foreign' }]],
    ['POST', '/mes/wmsProcedure/editDetail', { id: ids.product, mark: marker }]
  ]) assert.throws(() => h.fixture.api.request(method, endpoint, payload))
  h.fixture.owned = []
  assert.throws(() => assertMesRouteConfigurationWrite(h.fixture, 'POST', path, body), /registry/)
  assert.equal(h.calls.length, 0, 'invalid scope never reaches the underlying API')
})

test('MESB006 nonempty draft configuration uses official writes with exact decimal-safe API/full SQL proof', async () => {
  const h = configurationHarness()
  await h.prepare()
  assert.equal(h.caseRecord.checks[0].name, MES_ROUTE_VERSION_CHECKS.configurationDraft)
  assert.equal(h.caseRecord.checks[0].passed, true)
  assert.equal(h.fixture.routeConfiguration.baseline.sql.mes_wms_procedure_main_resource[0].capacity, '1.000000')
  assert.equal(h.fixture.routeConfiguration.baseline.api.equipment[0].procedureId, ids.procedure)
  assert.equal(h.fixture.routeConfiguration.references.readOnly, true)
  assert.equal(h.calls.filter(([method]) => method === 'POST').length, 3)
  assert.ok(h.calls.filter(([method]) => method === 'POST')
    .every(([, path]) => /\/mes\/(?:wmsTechRoute|wmsProcedure)\//.test(path)))
  const noReference = configurationHarness({ noReferences: true })
  await assert.rejects(noReference.prepare(), /CONFIGURATION_REFERENCE_UNAVAILABLE/)
  assert.ok(!noReference.calls.some(([method]) => method === 'POST'))
})

test('MESB006 only exact publish rejection with unchanged complete configuration passes all three freeze checks', async () => {
  const h = configurationHarness()
  await h.prepare()
  await h.freeze()
  const probes = h.caseRecord.mesRouteVersionEvidence.configuration.probes
  assert.equal(probes.length, 3)
  assert.ok(probes.every((row) => row.rejected && row.apiUnchanged && row.sqlUnchanged))
  assert.ok(probes.every((row) => row.classification === 'FROZEN_VERIFIED'))
  assert.equal(h.caseRecord.mesRouteVersionEvidence.configuration.diagnosis.policyDecisionRequired, false)
  assert.ok(h.caseRecord.checks.every((row) => row.passed))
  for (const options of [
    { acceptPublishedWrite: true }, { mutateDespiteRejection: true },
    { rejection: { code: 403, msg: '无权限' } },
    { rejection: { code: 500, msg: '系统异常' } },
    { rejection: { code: 400, msg: '其他业务错误' } }
  ]) {
    const invalid = configurationHarness(options)
    await invalid.prepare()
    await invalid.freeze()
    assert.equal(invalid.caseRecord.mesRouteVersionEvidence.configuration.probes.length, 3,
      'one failed configuration probe must not skip the remaining probes')
    assert.ok(invalid.caseRecord.checks.slice(1).every((row) => row.passed === false))
  }
})

test('MESB006 configuration refuses foreign, dangling or unregistered actual route references before writes', async () => {
  for (const routeReferences of [
    [],
    [[ids.node, ids.route, 'UNIT-RT', 'foreign-marker', 'V1.0', '0']],
    [[ids.node, ids.product, 'UNIT-RT', marker, 'V1.0', '0']],
    [[ids.node, ids.route, 'foreign-code', marker, 'V1.0', '0']],
    [[ids.node, ids.route, null, null, null, null]]
  ]) {
    const h = configurationHarness({ routeReferences })
    await assert.rejects(h.prepare(), /owned route reference|foreign or unregistered/)
    assert.ok(!h.calls.some(([method]) => method === 'POST'))
  }
  const h = configurationHarness()
  await h.prepare()
  h.fixture.owned = h.fixture.owned.filter((row) => row.id !== ids.newRoute)
  const writesBefore = h.calls.filter(([method]) => method === 'POST').length
  await assert.rejects(h.freeze(), /foreign or unregistered/)
  assert.equal(h.calls.filter(([method]) => method === 'POST').length, writesBefore)
})

test('MESB006 shared-procedure mutation requires policy decision without downgrading FAIL or claiming acceptance', async () => {
  const h = configurationHarness({ acceptPublishedWrite: true })
  await h.prepare()
  await h.freeze()
  const evidence = h.caseRecord.mesRouteVersionEvidence.configuration
  assert.equal(evidence.draftScope.scope, 'CURRENT_RUN_ONLY')
  assert.deepEqual(evidence.draftScope.references.map((row) => row.devStatus), [0])
  assert.equal(evidence.probes.length, 3)
  for (const probe of evidence.probes) {
    assert.equal(probe.classification, 'SHARED_PROCEDURE_FREEZE_DECISION_REQUIRED')
    assert.equal(probe.apiUnchanged, false)
    assert.equal(probe.sqlUnchanged, false)
    assert.deepEqual(probe.scope.references.map((row) => row.version), ['V1.0', 'V1.1'])
    assert.ok(probe.scope.references.every((row) => row.devStatus === 2))
  }
  assert.equal(evidence.diagnosis.policyDecisionRequired, true)
  assert.equal(h.caseRecord.checks.filter((row) => row.passed === false).length, 3)
  assert.ok(h.caseRecord.notes.some((note) => note.startsWith('MESB006 DECISION_REQUIRED:')))
  assert.equal(finalizeMesRouteVersionAssertions(h.caseRecord).acceptanceComplete, false)
  assert.equal(h.caseRecord.catalogAssertions[0].status, 'GAP')
  for (const [options, classification] of [
    [{ mutateDespiteRejection: true }, 'REJECTED_BUT_FACTS_CHANGED'],
    [{ rejection: { code: 403, msg: '无权限' } }, 'UNEXPECTED_BUSINESS_REJECTION'],
    [{ rejection: { code: 0, data: true } }, 'ACCEPTED_WITHOUT_FREEZE_REJECTION'],
    [{ mutateDespiteRejection: true, rejection: { code: 500, msg: '系统异常' } }, 'FAILED_RESPONSE_WITH_FACT_CHANGES']
  ]) {
    const invalid = configurationHarness(options)
    await invalid.prepare()
    await invalid.freeze()
    const actual = invalid.caseRecord.mesRouteVersionEvidence.configuration
    assert.ok(actual.probes.every((probe) => probe.classification === classification))
    assert.equal(actual.diagnosis.policyDecisionRequired, false)
    assert.ok(invalid.caseRecord.checks.slice(1).every((row) => row.passed === false))
  }
})

test('MESB006 cleanup reconciles every actual configuration row and keeps published references only with audited routes', async () => {
  const h = configurationHarness({ acceptPublishedWrite: true })
  await h.prepare()
  await h.freeze()
  const published = new Set([ids.route, ids.newRoute])
  await prepareMesRouteConfigurationCleanup(h.fixture, h.readSql, published)
  h.fixture.owned[0].cleanup = 'RETAINED_AUDIT_ROUTE_REFERENCE'
  h.caseRecord.mesRouteVersionEvidence.retained = [...published].map((id) =>
    ({ kind: 'route', id, cleanup: 'RETAINED_AUDIT_DISABLED' }))
  await auditMesRouteConfigurationCleanup(h.fixture, h.readSql, h.caseRecord, published)
  const evidence = h.caseRecord.mesRouteVersionEvidence.configuration.cleanup
  assert.equal(evidence.cleanup, 'RETAINED_AUDIT_ROUTE_REFERENCE')
  assert.equal(evidence.tables.mes_wms_procedure_main_resource.ids.length, 2, 'include replaced soft-deleted rows')
  assert.equal(evidence.tables.mes_wms_procedure_main_resource.liveIds.length, 1)
  assert.ok(!h.calls.some(([method]) => method === 'DELETE'))
  h.db.mes_wms_procedure_main_resource[1].extra_actual_column = 'unexpected drift'
  await assert.rejects(auditMesRouteConfigurationCleanup(h.fixture, h.readSql, h.caseRecord, published), /SQL drifted/)

  for (const options of [{}, { lostResponse: true }]) {
    const draft = configurationHarness(options)
    if (options.lostResponse) await assert.rejects(draft.prepare(), /response lost/)
    else await draft.prepare()
    assert.ok(draft.fixture.routeConfiguration, 'register scope before any configuration write')
    await prepareMesRouteConfigurationCleanup(draft.fixture, draft.readSql, new Set())
    // Model the official procedure delete cascading its five owned detail tables.
    for (const [table, rows] of Object.entries(draft.db)) {
      if (!table.startsWith('mes_procedure_')) for (const row of rows) row.deleted = '1'
    }
    await auditMesRouteConfigurationCleanup(draft.fixture, draft.readSql, draft.caseRecord, new Set())
    assert.equal(draft.caseRecord.mesRouteVersionEvidence.configuration.cleanup.cleanup, 'DELETED_VERIFIED')
    draft.db.mes_procedure_equipment_relation[0].deleted = '0'
    await assert.rejects(auditMesRouteConfigurationCleanup(draft.fixture, draft.readSql, draft.caseRecord, new Set()),
      /live residue/)
  }
})

test('MESB006 configuration reader rejects API/SQL mismatches rather than treating empty pages as evidence', async () => {
  const h = configurationHarness()
  await h.prepare()
  h.db.mes_wms_procedure_main_resource[0].procedure_id = ids.product
  const previousGet = h.fixture.api.getBusiness
  h.fixture.api = { getBusiness: async (path) => path.includes('procedure-quality-item')
    ? ok({ list: [], total: 0 }) : previousGet(path) }
  await assert.rejects(readMesRouteConfiguration(h.fixture, h.readSql), /API\/SQL IDs mismatch/)
})

function pageHarness (options = {}) {
  const page = new EventEmitter()
  const calls = []
  let loadingMasks = [0]
  let lastLoadingMaskCount = 0
  const rows = [route(), route(true)]
  const configuration = {
    references: { planId: '201', itemId: '202', planName: 'UNIT-PLAN', itemName: 'UNIT-ITEM',
      resourceCode: 'UNIT-RESOURCE', resourceName: 'UNIT MACHINE' },
    latest: { api: {
      detail: { id: ids.procedure, mainResources: [{ id: '101', resourceId: '204', code: 'UNIT-RESOURCE', capacity: 2 }] },
      quality: [{ id: '102', procedureId: ids.procedure, qualityPlanId: '201', qualityItemId: '202',
        target: '99%', frequency: '每批', isRequired: 'Y' }]
    } }
  }
  const locator = (selector) => ({
    waitFor: async () => { if (options.domFailure) throw new Error('unit DOM load failed') },
    fill: async (text) => { calls.push(['fill', selector, text]) },
    innerText: async () => selector.includes('td')
      ? options.configurationCapacity ?? '2' : options.errorText ?? marker,
    allTextContents: async () => ['1 UNIT-RESOURCE UNIT MACHINE 1 2'],
    count: async () => {
      if (!selector.endsWith('.el-loading-mask:visible')) return options.configurationItemCount ?? 1
      lastLoadingMaskCount = loadingMasks.length > 1 ? loadingMasks.shift() : loadingMasks[0]
      calls.push(['loading', lastLoadingMaskCount])
      return lastLoadingMaskCount
    },
    evaluate: async () => {
      calls.push(['layout', lastLoadingMaskCount])
      return { passed: !options.configurationLayoutBlocked && lastLoadingMaskCount === 0,
        viewport: { width: 1600, height: 900 },
        basic: { width: 760 }, detail: { width: options.configurationLayoutBlocked ? 0 : 400 } }
    },
    nth: (index) => locator(`${selector}:nth(${index})`),
    click: async () => {
      calls.push(['click', selector])
      if (!options.configuration || options.noConfigurationResponse) return
      loadingMasks = [...(options.configurationLoadingMasks ?? [0])]
      const detail = structuredClone(configuration.latest.api.detail)
      if (options.configurationApiDrift) detail.mainResources[0].capacity = 42
      for (const [path, data] of [
        [`/mes/wmsProcedure/queryDetailById?id=${ids.procedure}`, detail],
        [`/mes/procedure-quality-item/page?procedureId=${ids.procedure}&pageNo=1&pageSize=100`,
          { list: configuration.latest.api.quality, total: 1 }]
      ]) page.emit('response', { ...response,
        url: () => `http://127.0.0.1:48083/admin-api${path}`, text: async () => JSON.stringify(ok(data)) })
    },
    getByRole: (_role, { name }) => ({ click: async () => { calls.push(['tab', name]) } }),
    locator: (child) => locator(`${selector} ${child}`),
    boundingBox: async () => selector === '.vue-flow-container'
      ? { x: 0, y: 0, width: 500, height: 500 }
      : options.noNodeBounds ? null : { x: options.offCanvas ? 600 : 20, y: 20, width: 100, height: 100 },
    getByText: (text) => ({
      waitFor: async () => {
        if (options.configurationDomFailure && selector.includes('.scheme-name')) {
          throw new Error('unit quality DOM missing')
        }
        calls.push(['DOM', text])
      },
      click: async () => {
        calls.push(['click', text])
        if (options.noProcesses) return
        const upgraded = text.endsWith('V1.1')
        const process = node(upgraded)
        if (options.processIdentityDrift) process.procedureId = ids.product
        page.emit('response', {
          ...response,
          url: () => `http://127.0.0.1:48083/admin-api/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?parentId=${process.parentId}&pageNo=1&pageSize=${options.processSize ?? 100}`,
          ok: () => !options.processHttpFailure,
          text: async () => JSON.stringify(ok({ records: [process], total: 1 }))
        })
      }
    })
  })
  page.locator = locator
  const response = {
    url: () => `http://127.0.0.1:48083/admin-api/mes/wmsTechRoute/list?pageNo=${options.pageNo ?? 1}&pageSize=${options.pageSize ?? 100}`,
    request: () => ({ isNavigationRequest: () => false, resourceType: () => 'xhr' }),
    ok: () => !options.httpFailure, status: () => options.httpFailure ? 403 : 200,
    headers: () => ({}),
    text: async () => JSON.stringify(options.apiFailure ? { code: 403 } :
      ok({ records: rows, total: options.total ?? 2 }))
  }
  const api = { getBusiness: async () => ok({ menus: options.noMenu ? [] : [{
    path: '/settings', children: [{ path: 'production', children: [{
      path: 'technique', component: '/src/views/mes/produce/technique/index.vue'
    }] }]
  }, ...(options.businessAlias ? [{
    path: '/production', children: [{ path: 'prod', children: [{
      path: 'technique-route', component: 'mes/produce/technique/index',
      componentName: 'MesProduceTechniqueRoute'
    }] }]
  }] : [])] }) }
  const fixture = { marker, route: { id: ids.route, identity: 'UNIT-RT' },
    procedure: { id: ids.procedure, identity: 'UNIT-PROC' },
    ...(options.configuration ? { routeConfiguration: configuration } : {}) }
  const run = () => verifyMesRouteVersionPage({
    api, page, fixture, timeoutMs: 50,
    openRoute: async (_page, path) => {
      calls.push(['open', path])
      if (options.navigationFailure) throw new Error('unit navigation failed')
      if (options.pendingNavigationFailure) {
        page.emit('response', { ...response, text: async () => new Promise(() => {}) })
        throw new Error('unit navigation failed with pending response')
      }
      if (options.requestFailure) {
        const expected = options.requestFailure === 'expected'
        page.emit('requestfailed', {
          url: () => expected ? 'http://127.0.0.1:9151/' :
            'http://127.0.0.1:48083/admin-api/mes/wmsTechRoute/list',
          resourceType: () => 'fetch',
          isNavigationRequest: () => false,
          failure: () => ({ errorText: expected ? 'net::ERR_ABORTED' : 'net::ERR_CONNECTION_RESET' })
        })
      }
      if (!options.noResponse) page.emit('response', response)
      if (options.pageError) page.emit('pageerror', new Error('unit page exception'))
    },
    saveScreenshot: async () => {
      if (options.screenshotFailure) throw new Error('unit screenshot failed')
      calls.push(['screenshot'])
    }, record: {}, outputDir: ''
  })
  return { run, page, calls, fixture }
}

test('MESB006 page uses the official component menu and successful API plus both owned version DOMs', async () => {
  const h = pageHarness()
  const evidence = await h.run()
  assert.equal(evidence.route, '/settings/production/technique')
  assert.equal(evidence.domAndApiSucceeded, true)
  assert.deepEqual(evidence.ownedRouteIds, [ids.route, ids.newRoute])
  assert.deepEqual(evidence.pagination, [{ pageNo: 1, pageSize: 100, total: 2, rowCount: 2 }])
  assert.deepEqual(evidence.processViews.map(({ version, nodeId }) => ({ version, nodeId })),
    [{ version: 'V1.0', nodeId: ids.node }, { version: 'V1.1', nodeId: ids.newNode }])
  assert.ok(h.calls.some(([method]) => method === 'screenshot'))
  for (const name of ['response', 'requestfailed', 'pageerror']) assert.equal(h.page.listenerCount(name), 0)
  const absent = pageHarness({ noMenu: true })
  assert.deepEqual(await absent.run(), { available: false, reason: 'PAGE_ROUTE_UNAVAILABLE' })
  assert.deepEqual(absent.calls, [])
  const aliased = pageHarness({ businessAlias: true })
  assert.equal((await aliased.run()).route, '/production/prod/technique-route',
    'Prefer the official business componentName over its settings alias')
})

test('MESB006 a usable menu never masks page DOM/API/navigation/runtime/screenshot failures as GAP', async () => {
  for (const options of [{ httpFailure: true }, { apiFailure: true }, { domFailure: true },
    { navigationFailure: true }, { pageError: true }, { noResponse: true },
    { screenshotFailure: true }, { errorText: '模块配置异常，请联系管理员' },
    { pageSize: 1000 }, { pageSize: 101 }, { pageNo: 0 }, { pageNo: 'invalid' },
    { total: 'invalid' }, { total: 101 }, { total: 0 }, { noProcesses: true },
    { processSize: 1000 }, { processHttpFailure: true }, { processIdentityDrift: true },
    { offCanvas: true }, { noNodeBounds: true }]) {
    const h = pageHarness(options)
    await assert.rejects(h.run(), undefined, JSON.stringify(options))
    for (const name of ['response', 'requestfailed', 'pageerror']) assert.equal(h.page.listenerCount(name), 0)
  }
})

test('MESB006 configuration page proof requires nonempty resource/quality DOM and matching actual browser API on both versions', async () => {
  const h = pageHarness({ configuration: true })
  const evidence = await h.run()
  assert.equal(evidence.configurationSucceeded, true)
  assert.deepEqual(evidence.processViews.map((view) => view.configuration.target), ['99%', '99%'])
  assert.ok(evidence.processViews.every((view) => view.configuration.domAndApiSucceeded))
  for (const options of [
    { noConfigurationResponse: true }, { configurationApiDrift: true },
    { configurationDomFailure: true }, { configurationCapacity: '1' },
    { configurationItemCount: 0 }, { configurationItemCount: 2 }
  ]) {
    const invalid = pageHarness({ configuration: true, ...options })
    await assert.rejects(invalid.run(), undefined, JSON.stringify(options))
    for (const event of ['response', 'requestfailed', 'pageerror']) assert.equal(invalid.page.listenerCount(event), 0)
  }
  const blocked = pageHarness({ configuration: true, configurationLayoutBlocked: true })
  const blockedEvidence = await blocked.run()
  assert.equal(blockedEvidence.domAndApiSucceeded, true, 'the route DOM does not prove the configuration panel')
  assert.equal(blockedEvidence.configurationSucceeded, false)
  assert.equal(blockedEvidence.processViews.length, 2)
  assert.ok(blockedEvidence.processViews.every((view) =>
    view.configuration.reason === 'CONFIGURATION_PANEL_LAYOUT_BLOCKED'))
  assert.ok(!blocked.calls.some(([action]) => action === 'tab'), 'never force-click obscured controls')
})

test('MESB006 waits for both configuration masks before layout checks and fails persistent loading', async () => {
  const h = pageHarness({ configuration: true, configurationLoadingMasks: [2, 1, 0] })
  const evidence = await h.run()
  assert.equal(evidence.configurationSucceeded, true)
  assert.deepEqual(h.calls.filter(([action]) => action === 'loading').map(([, count]) => count),
    [2, 1, 0, 2, 1, 0])
  assert.ok(h.calls.filter(([action]) => action === 'layout').every(([, count]) => count === 0))
  const stuck = pageHarness({ configuration: true, configurationLoadingMasks: [2] })
  await assert.rejects(stuck.run(), /configuration API\/loading did not finish/)
  assert.ok(!stuck.calls.some(([action]) => action === 'tab' || action === 'layout'))
  for (const name of ['response', 'requestfailed', 'pageerror']) assert.equal(stuck.page.listenerCount(name), 0)
})

test('MESB006 preserves navigation failures with pending responses and still rejects actual read failures', async () => {
  const pending = pageHarness({ pendingNavigationFailure: true })
  await assert.rejects(pending.run(), /unit navigation failed with pending response/)
  assert.equal(pending.fixture.routePageEvidence.stage, 'navigation')
  assert.equal(pending.fixture.routePageEvidence.error.message, 'unit navigation failed with pending response')
  for (const name of ['response', 'requestfailed', 'pageerror']) assert.equal(pending.page.listenerCount(name), 0)
  const expected = pageHarness({ requestFailure: 'expected' })
  assert.equal((await expected.run()).domAndApiSucceeded, true)
  const actual = pageHarness({ requestFailure: 'actual' })
  await assert.rejects(actual.run(), /official page request failed/)
})

test('MESB006 suite alone dispatches the scoped closure with record and formal-page verifier', async () => {
  const caseRecord = newCase()
  const record = { runId: 'unit', environment: { tenantId: '1' } }
  const api = { getBusiness () {}, postBusiness () {}, putBusiness () {}, deleteBusiness () {}, request () {} }
  let received
  const result = await runCase({ caseId: 'MES-BASE-006', caseRecord, record, page: {}, outputDir: '' }, {
    login: async (_page, options) => {
      assert.equal(options.returnContext, true)
      return { token: 'offline', tenantId: '1' }
    },
    createApiClient: (input) => {
      assert.equal(input.token, 'offline')
      assert.equal(input.tenantId, '1')
      return api
    },
    runMesRouteVersionClosure: async (input) => {
      received = input
      return { partial: true, acceptanceComplete: false, passCandidate: false, note: 'resource gap' }
    }
  })
  assert.equal(received.api, api)
  assert.equal(received.record, record)
  assert.equal(received.caseRecord, caseRecord)
  assert.equal(received.tenantId, '1')
  assert.equal(typeof received.verifyPage, 'function')
  assert.equal(result.api, api)
  assert.equal(result.partial, true)
})
