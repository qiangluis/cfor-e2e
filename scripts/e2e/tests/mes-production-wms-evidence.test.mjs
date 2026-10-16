import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { collectMesProductionWmsEvidence } from '../fixtures/mes-production-wms-evidence.mjs'

const ok = (data) => ({ code: 0, data })
const copy = (value) => structuredClone(value)
const ids = Object.fromEntries(['order', 'work', 'prodTask', 'report', 'warehouse', 'area', 'location',
  'material', 'route', 'output', 'entry', 'inventory', 'receive', 'putaway', 'receiveLine', 'putawayLine', 'log']
  .map((name, index) => [name, String(2109841331347861505n + BigInt(index))]))
const marker = 'AUTOTEST-MES-PROD-004-63DQTM-7524F3'
const batch = `${marker}-B1`
const billNo = 'CP261013-005'
const dims = { warehouseId: ids.warehouse, wareAreaId: ids.area, wareLocationId: ids.location,
  materialId: ids.material, batchNo: batch }
const quantityFields = ['qty', 'availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty']
const snake = (value) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const sqlRow = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) =>
  [snake(key), item == null ? null : String(typeof item === 'boolean' ? Number(item) : item)]))
const fields = {
  mes_stk_io: ['stock_io_type', 'src_bill_type', 'src_bill_id', 'bill_no', 'is_effective', 'is_voided'],
  mes_stk_io_entry: ['mid', 'src_bill_type', 'src_bill_id', 'src_entry_id', 'material_id', 'batch_no',
    'entry_no', 'qty', 'warehouse_id', 'ware_area_id', 'ware_location_id'],
  mes_stk_inventory: ['warehouse_id', 'material_id', 'batch_no', 'ware_area_id', 'ware_location_id',
    'is_closed', 'quality_status', ...quantityFields.map(snake)],
  wms_task: ['task_no', 'task_type', 'status', 'source_bill_type', 'source_bill_id', 'source_bill_no',
    'warehouse_id', 'area_id', 'idempotency_key', 'version', 'started_time', 'completed_time'],
  wms_task_line: ['task_id', 'source_line_id', 'material_id', 'batch_no', 'line_no', 'source_location_id',
    'target_location_id', 'target_area_id', 'planned_quantity', 'actual_quantity'],
  wms_putaway_reservation: ['task_id', 'task_line_id', 'idempotency_key', 'status', 'reserved_qty', 'version'],
  wms_task_log: ['task_id', 'action']
}

function harness (options = {}) {
  const calls = []
  const sqlCalls = []
  const fixture = { caseId: 'MES-PROD-004', marker, owned: [], works: [], tasks: [],
    reportIds: [ids.report], outputIds: [ids.output], record: { screenshots: [] } }
  const own = (kind, name = kind) => {
    const resource = { kind, id: ids[name], marker, identity: `${marker}-${kind}` }
    fixture.owned.push(resource)
    return resource
  }
  for (const kind of ['order', 'warehouse', 'area', 'location', 'material', 'route']) fixture[kind] = own(kind)
  fixture.works = [own('work')]
  fixture.tasks = [own('task', 'prodTask')]
  own('report')
  Object.assign(own('output'), { identity: billNo, sourceReportId: ids.report, sourceWorkId: ids.work,
    stockIoType: '104', dimensions: copy(dims) })
  Object.assign(own('inventory'), { sourceOutputId: ids.output, dimensions: copy(dims) })
  fixture.fixtureRecord = { caseId: fixture.caseId, marker, resources: fixture.owned }
  const caseRecord = { checks: [], notes: [], evidence: [], executionFixtures: [fixture.fixtureRecord] }
  const inventory = { id: ids.inventory, tenantId: '1', deleted: false, isClosed: 0, ...dims,
    qty: '2.000000', availableQty: '2.000000', lockQty: '0.000000', holdQty: '0.000000',
    frozenQty: '0.000000', pendingPutawayQty: '0.000000', qualityStatus: '1', updateTime: '2026-10-13 02:58:49' }
  const output = { id: ids.output, tenantId: '1', deleted: false, stockIoType: '104', billNo,
    srcBillType: 'ProdWork', srcBillId: ids.work, isEffective: 1, isVoided: 0 }
  const entry = { id: ids.entry, mid: ids.output, tenantId: '1', deleted: false, ...dims,
    srcBillType: 'ProdWork', srcBillId: ids.work, srcEntryId: ids.report, entryNo: 1, qty: 2 }
  const task = (type) => {
    const receive = type === 'RECEIVE'
    const name = receive ? 'receive' : 'putaway'
    return {
      id: ids[name], taskNo: `WMS-${name}-unique`, taskType: type, sourceBillType: 'MesStkIo',
      sourceBillId: ids.output, sourceBillNo: billNo, warehouseId: ids.warehouse, areaId: ids.area,
      status: receive ? 'COMPLETED' : 'PENDING', plannedQuantity: 2, actualQuantity: receive ? 2 : 0,
      startedTime: receive ? '2026-10-13 02:58:49' : null,
      completedTime: receive ? '2026-10-13 02:58:50' : null,
      remark: `production ${type}`, lines: [{
        id: ids[`${name}Line`], lineNo: 1, materialId: ids.material, sourceLineId: ids.report,
        batchNo: batch, serialNo: null, sourceLocationId: ids.location, targetLocationId: ids.location,
        targetAreaId: ids.area, plannedQuantity: 2, actualQuantity: receive ? 2 : 0,
        reservationId: null, reservationStatus: null, reservedQuantity: 0, remark: null
      }]
    }
  }
  const facts = {
    work: { id: ids.work, prodOrderId: ids.order, remark: marker, batchNo: batch },
    prodTask: { id: ids.prodTask, workTicketId: ids.work, productId: ids.material, routing: ids.route },
    report: { id: ids.report, workTicketId: ids.work, workTaskId: ids.prodTask, remark: marker, qualifiedNum: 2 },
    output, entry, inventory, tasks: [task('RECEIVE'), task('PUTAWAY')], reservations: [],
    logs: [{ id: ids.log, task_id: ids.receive, action: 'COMPLETE' }],
    location: { id: ids.location, houseId: ids.warehouse, areaId: ids.area, isEnabled: true,
      locationCode: `${marker}-LC`, locationName: `${marker}-location`, remark: marker },
    permission: { permissions: ['wms:operation-task:query', 'wms:operation-task:execute'],
      menus: [{ path: '/wireSideWarehouse', children: [{ path: 'stock', component: 'wms/stock/workbench' }] }] }
  }
  options.changeFacts?.(facts)
  if (options.positiveClosure) {
    facts.inventory.availableQty = '0.000000'
    facts.inventory.pendingPutawayQty = '2.000000'
  }
  const snapshotRows = () => {
    const persisted = (row) => ({ ...sqlRow(row), tenant_id: '1', deleted: '0', update_time: '2026-10-13 02:58:49' })
    const taskRows = facts.tasks.map((row) => {
      const { lines, plannedQuantity, actualQuantity, ...rest } = row
      return { ...persisted(rest), version: '1',
        idempotency_key: `MES-PROD-STK-IN:${ids.output}:1:${row.taskType}` }
    })
    return {
      mes_stk_io: [persisted(facts.output)], mes_stk_io_entry: [persisted(facts.entry)],
      mes_stk_inventory: [persisted(facts.inventory)], wms_task: taskRows,
      wms_task_line: facts.tasks.map((row) => {
        const { reservationId, reservationStatus, reservedQuantity, ...line } = row.lines[0]
        return { ...persisted(line), task_id: row.id }
      }),
      wms_putaway_reservation: copy(facts.reservations),
      wms_task_log: facts.logs.map((row) => ({
        ...persisted({ id: row.id }), task_id: row.task_id, action: row.action
      }))
    }
  }
  let probes = 0
  const api = {
    async getBusiness (path) {
      calls.push({ method: 'GET', path })
      const url = new URL(path, 'http://unit')
      const endpoints = {
        '/mes/prodWork/queryById': ['work', ids.work],
        '/mes/prodWorkTask/queryById': ['prodTask', ids.prodTask],
        '/mes/prodWorkReport/queryById': ['report', ids.report],
        '/mes/stkIo/queryById': ['output', ids.output],
        '/mes/stkInventory/queryById': ['inventory', ids.inventory],
        '/mes/wms-house-location/get': ['location', ids.location]
      }
      if (endpoints[url.pathname]) {
        const [key, expected] = endpoints[url.pathname]
        assert.equal(url.searchParams.get('id'), expected)
        if (key === 'location' && options.locationUnavailable) throw new Error('location contract unavailable')
        return ok(copy(facts[key]))
      }
      if (url.pathname === '/system/auth/get-permission-info') {
        if (options.permissionUnavailable) throw new Error('unit permission API failure')
        return ok(copy(facts.permission))
      }
      if (url.pathname === '/mes/stkIo/queryEntryByMainId') {
        assert.equal(url.searchParams.get('id'), ids.output)
        return ok(options.emptyEntries ? [] : [copy(facts.entry)])
      }
      if (url.pathname === '/mes/stkInventory/list') {
        assert.equal(url.searchParams.get('warehouseId'), ids.warehouse)
        assert.equal(url.searchParams.get('materialId'), ids.material)
        assert.equal(url.searchParams.get('batchNo'), batch)
        const rows = options.emptyInventory ? [] : [copy(facts.inventory)]
        return ok({ records: rows, total: rows.length })
      }
      if (url.pathname === '/wms/operation/task/page') {
        assert.equal(url.searchParams.get('sourceBillId'), ids.output)
        assert.equal(url.searchParams.get('warehouseId'), ids.warehouse)
        const rows = options.emptyTasks ? [] : facts.tasks.map(({ lines, ...row }) => copy(row))
        return ok({ list: rows, total: rows.length })
      }
      if (url.pathname === '/wms/operation/task/get') {
        const row = facts.tasks.find((row) => row.id === url.searchParams.get('id'))
        assert.ok(row)
        return ok(copy(row))
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async post (path, body, requestOptions) {
      calls.push({ method: 'POST', path, body: copy(body), options: requestOptions })
      probes++
      options.onPost?.({ facts, probes, path, body })
      if (options.postError) throw new Error('unit transport failed')
      if (options.response) return options.response
      if (options.positiveClosure && path === '/wms/operation/task/start') {
        assert.equal(body.id, ids.putaway)
        facts.tasks[1].status = 'IN_PROGRESS'
        facts.tasks[1].startedTime = '2026-10-13 03:00:00'
        facts.logs.push({ id: '2110019776332775426', task_id: ids.putaway, action: 'START' })
        return ok(true)
      }
      if (options.positiveClosure && facts.tasks[1].status !== 'PENDING') {
        if (path === '/wms/operation/task/putaway/reserve') {
          assert.equal(body.taskId, ids.putaway)
          assert.equal(body.lineId, ids.putawayLine)
          assert.equal(body.quantity, 2)
          const current = facts.reservations[0] || {
            id: '2110019776332775427', tenant_id: '1', deleted: '0',
            task_id: ids.putaway, task_line_id: ids.putawayLine,
            idempotency_key: body.idempotencyKey, status: 'ACTIVE',
            reserved_qty: '2', version: '1', update_time: '2026-10-13 03:00:01'
          }
          if (!facts.reservations.length) {
            facts.reservations.push(current)
            facts.tasks[1].lines[0].reservationId = current.id
            facts.tasks[1].lines[0].reservationStatus = 'ACTIVE'
            facts.logs.push({ id: '2110019776332775428', task_id: ids.putaway, action: 'PUTAWAY_RESERVE' })
          }
          return ok({
            reservationId: current.id, taskId: ids.putaway, lineId: ids.putawayLine,
            sourceInventoryId: ids.inventory, sourceAreaId: ids.area, sourceLocationId: ids.location,
            warehouseId: ids.warehouse, targetAreaId: ids.area, targetLocationId: ids.location,
            materialId: ids.material, batchNo: batch, serialNo: null, reservedQuantity: 2,
            status: current.status, idempotencyKey: current.idempotency_key
          })
        }
        if (path === '/wms/operation/task/putaway/confirm') {
          assert.equal(body.taskId, ids.putaway)
          assert.equal(body.lineId, ids.putawayLine)
          if (facts.reservations[0]?.status === 'ACTIVE') {
            facts.reservations[0].status = 'CONSUMED'
            facts.reservations[0].version = '2'
            facts.tasks[1].lines[0].actualQuantity = 2
            facts.tasks[1].lines[0].reservationStatus = 'CONSUMED'
            facts.inventory.availableQty = '2.000000'
            facts.inventory.pendingPutawayQty = '0.000000'
            facts.logs.push({ id: '2110019776332775429', task_id: ids.putaway, action: 'PUTAWAY_CONFIRM' })
          }
          return ok(true)
        }
        if (path === '/wms/operation/task/complete') {
          assert.equal(body.id, ids.putaway)
          facts.tasks[1].status = 'COMPLETED'
          facts.tasks[1].completedTime = '2026-10-13 03:00:02'
          facts.tasks[1].actualQuantity = 2
          facts.logs.push({ id: '2110019776332775430', task_id: ids.putaway, action: 'COMPLETE' })
          return ok(true)
        }
      }
      assert.ok(['/wms/operation/task/putaway/reserve', '/wms/operation/task/putaway/confirm'].includes(path))
      assert.equal(body.taskId, ids.putaway)
      assert.equal(body.lineId, ids.putawayLine)
      assert.equal(body.quantity, 2)
      return { code: 500, msg: path.endsWith('/reserve')
        ? '\u53ea\u6709\u6267\u884c\u4e2d\u7684\u4e0a\u67b6\u4efb\u52a1\u53ef\u4ee5\u9884\u7559\u76ee\u6807\u5e93\u4f4d'
        : '\u5f53\u524d\u4e0a\u67b6\u660e\u7ec6\u6ca1\u6709\u6709\u6548\u9884\u7559\uff0c\u8bf7\u5148\u9884\u7559\u76ee\u6807\u5e93\u4f4d' }
    }
  }
  fixture.api = api
  const readSql = async (sql) => {
    sqlCalls.push(sql)
    assert.ok(!/\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|CALL|TRUNCATE)\b/i.test(sql), 'no SQL writes')
    if (sql.includes(':ownership')) {
      for (const key of ['warehouse', 'material', 'area', 'location', 'work', 'report', 'order', 'prodTask']) {
        assert.ok(sql.includes(`'${ids[key]}'`), `ownership scoped by ${key}`)
      }
      assert.ok(sql.includes(`wh.mark='${marker}'`) && sql.includes(`r.remark='${marker}'`))
      return { available: true, rows: options.noOwnership ? [] :
        [[ids.warehouse, ids.material, ids.area, ids.location, ids.work, ids.report]] }
    }
    const rowsByTable = snapshotRows()
    if (sql.includes(':schema')) {
      const rows = []
      for (const [table, required] of Object.entries(fields)) {
        const names = [...new Set(['id', 'tenant_id', 'deleted', 'update_time', ...required,
          ...Object.keys(rowsByTable[table][0] || {})])]
        rows.push(['schema-count', table, String(names.length)])
        for (const name of names) rows.push(['column', table, name, name === 'deleted' ? 'bit' : 'varchar'])
      }
      if (options.incompleteSchema) rows.pop()
      return { available: true, rows }
    }
    assert.ok(sql.includes(':facts'))
    assert.ok(sql.includes(`source_bill_id='${ids.output}'`))
    assert.ok(sql.includes(`batch_no='${batch}'`))
    assert.ok(sql.includes('CAST(CAST(`deleted` AS UNSIGNED) AS CHAR)'))
    assert.ok(!sql.includes('SELECT *') && !sql.includes('WHERE tenant_id=1;'))
    const rows = []
    for (const [table, required] of Object.entries(fields)) {
      let items = rowsByTable[table]
      if (options.emptySqlTable === table) items = []
      if (options.mutateSql && probes > 0) items = options.mutateSql(table, items) || items
      const names = [...new Set(['id', 'tenant_id', 'deleted', 'update_time', ...required,
        ...Object.keys(rowsByTable[table][0] || {})])]
      rows.push(['count', table, String(items.length)])
      for (const item of items) {
        const values = Object.fromEntries(names.map((name) => [name, item[name] ?? null]))
        options.changeSqlRow?.(table, values)
        rows.push(['row', table, item.id, JSON.stringify(values)])
      }
    }
    return { available: !options.sqlUnavailable && !(options.afterSqlUnavailable && probes > 0), rows }
  }
  const settings = { target: 'local', tenantId: '1',
    apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
    db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }, ...options.settings }
  const context = {}
  let page
  let screenshots = 0
  let pageRefreshes = 0
  let warehouseSearch
  let warehouseSelections = 0
  let viewport = { width: 1600, height: 900 }
  const locator = (selector, wanted) => ({
    filter ({ has }) { return locator(selector, has.wanted) },
    wanted,
    async waitFor () {},
    async count () {
      if (options.missingCanvas && selector === '.warehouse-twin-scene canvas') return 0
      return (options.duplicateCard && selector === '.task-drilldown-item') ||
        (options.duplicateWarehouse && selector === 'warehouse-option') ? 2 : 1
    },
    async fill (value) {
      assert.equal(selector, 'warehouse-selector')
      warehouseSearch = value
    },
    async click () {
      if (selector === 'refresh-button') pageRefreshes++
      if (selector === 'warehouse-option') {
        assert.equal(warehouseSearch, `${marker}-\u4ed3\u5e93`)
        warehouseSelections++
      }
    },
    async scrollIntoViewIfNeeded () {},
    async boundingBox () {
      if (options.blankCanvas && selector === '.warehouse-twin-scene canvas') return null
      return { x: options.clippedSelector ? viewport.width : 24, y: 120,
        width: Math.min(240, viewport.width - 48), height: 32 }
    },
    getByRole () { return locator('refresh-button') },
    locator (child) { return locator(child, wanted) },
    async innerText () {
      const task = facts.tasks.find((row) => row.taskNo === wanted)
      assert.ok(task, `known rendered task ${wanted}`)
      if (selector === '.task-drilldown-main em') return task.taskNo
      if (selector === '.task-drilldown-main small') return options.wrongPageSource ? 'OTHER-SOURCE' : billNo
      if (selector === '.task-drilldown-main strong') return task.taskType === 'RECEIVE' ? '\u6536\u8d27' : '\u4e0a\u67b6'
      if (selector === '.task-drilldown-meta b') return task.status === 'COMPLETED' ? '\u5df2\u5b8c\u6210' : '\u5f85\u6267\u884c'
      if (selector === '.task-drilldown-meta em') return `${task.actualQuantity} / ${task.plannedQuantity}`
      throw new Error(`unexpected selector ${selector}`)
    }
  })
  page = {
    context: () => context,
    viewportSize: () => ({ ...viewport }),
    async setViewportSize (value) { viewport = { ...value } },
    locator: (selector) => locator(selector),
    getByText: (text) => ({ wanted: text }),
    getByRole (role, { name, exact }) {
      assert.equal(exact, true)
      if (role === 'combobox') {
        assert.equal(name, '\u4ed3\u5e93\u7b5b\u9009')
        return locator('warehouse-selector')
      }
      assert.equal(role, 'option')
      assert.equal(name, `${marker}-\u4ed3\u5e93`)
      return locator('warehouse-option')
    },
    async waitForFunction () {},
    async waitForResponse (predicate) {
      const response = {
        url: () => `${settings.apiBase}/admin-api/wms/operation/task/page?pageNo=1&pageSize=100&warehouseId=${ids.warehouse}`,
        ok: () => true, headers: () => ({}),
        request: () => ({ method: () => 'GET', frame: () => ({ page: () => page }),
          headers: () => ({ 'tenant-id': options.browserTenant || '1', authorization: 'Bearer unit-auth-token-not-for-storage' }) }),
        text: async () => JSON.stringify(ok({ list: options.emptyBrowser ? [] : facts.tasks.map(({ lines, ...row }) =>
          ({ ...row, sourceBillId: options.wrongBrowserSource ? ids.work : row.sourceBillId })), total: options.emptyBrowser ? 0 : 2 }))
      }
      assert.equal(predicate(response), true)
      return response
    }
  }
  const dependencies = {
    settings, environment: {
      CFOR_E2E_WRITE_FIXTURES: options.writeFlag ?? 'true',
      CFOR_E2E_WMS_PUTAWAY_CLOSURE: options.positiveClosure ? 'true' : 'false'
    },
    async assertLocalWriteSafety (record) {
      calls.push({ method: 'GUARD' })
      assert.equal(record, caseRecord)
      if (options.guardFailure) throw new Error('unit unsafe jobs')
    },
    runReadOnlySql: readSql,
    async openRoute (samePage, path) {
      assert.equal(samePage, page)
      assert.equal(path, '/wireSideWarehouse/stock')
      calls.push({ method: 'PAGE', path })
    },
    async saveScreenshot (samePage, outputDir, name) {
      assert.equal(samePage, page)
      screenshots++
      return `${outputDir}/${name}.png`
    }
  }
  const run = () => collectMesProductionWmsEvidence({
    fixture, page: options.noPage ? undefined : page, context, caseRecord,
    outputDir: '/tmp/unit-only-not-written', record: fixture.record
  }, dependencies)
  return { run, facts, fixture, caseRecord, calls, sqlCalls, dependencies, context,
    get screenshots () { return screenshots }, get pageRefreshes () { return pageRefreshes },
    get warehouseSelections () { return warehouseSelections },
    get viewport () { return viewport } }
}

test('collects owned formal facts, full field hashes, scoped web refresh, and two exact unchanged refusals; never PASS', async () => {
  const h = harness()
  const evidence = await h.run()
  assert.equal(evidence.status, 'PARTIAL')
  assert.equal(evidence.partial, true)
  assert.equal(evidence.passCandidate, false)
  assert.equal(evidence.sourceConflict.observed, true)
  assert.equal(evidence.sourceConflict.source.taskSourceLineId, ids.report)
  assert.equal(evidence.sourceConflict.source.entryId, ids.entry)
  assert.equal(evidence.initial.api.inventory.qty, '2.000000')
  assert.deepEqual(evidence.sourceConflict.qualityStatus, { apiExposed: true, apiValue: '1', readOnlyValue: '1' })
  assert.equal(evidence.initial.readOnly.mes_stk_inventory.count, 1)
  assert.equal(evidence.negatives.length, 2)
  assert.ok(evidence.negatives.every((row) => row.matched && row.unchanged))
  assert.equal(h.screenshots, 6)
  assert.equal(h.pageRefreshes, 1)
  assert.equal(h.calls[0].method, 'GUARD')
  assert.ok(!h.calls.some((row) => /\/(?:start|cancel|complete|create|suggest)$/.test(row.path || '')))
  assert.equal(h.caseRecord.checks.some((row) => row.name === evidence.originalAssertion), false)
  assert.match(evidence.initial.hashes.api, /^[a-f0-9]{64}$/)
  assert.match(evidence.initial.hashes.readOnly, /^[a-f0-9]{64}$/)
  assert.ok(evidence.gaps.some((row) => row.code === 'PUTAWAY_SUCCESS_IDEMPOTENCY_AND_STOCK_TRANSFER_NOT_VERIFIED'))
})

test('executes the formal positive putaway closure with one browser context and idempotent retries', async () => {
  const h = harness({ positiveClosure: true })
  const evidence = await h.run()
  assert.equal(evidence.status, 'PARTIAL')
  assert.equal(evidence.sourceConflict.observed, false)
  assert.equal(evidence.initial.api.inventory.availableQty, '0.000000')
  assert.equal(evidence.initial.api.inventory.pendingPutawayQty, '2.000000')
  assert.equal(evidence.negatives.length, 2)
  assert.ok(evidence.negatives.every((row) => row.matched && row.unchanged))
  assert.equal(evidence.positiveClosure.reservationId, '2110019776332775427')
  assert.equal(evidence.positiveClosure.final.putawayStatus, 'COMPLETED')
  assert.equal(evidence.positiveClosure.final.putawayActualQuantity, 2)
  assert.equal(evidence.positiveClosure.final.inventory.availableQty, '2.000000')
  assert.equal(evidence.positiveClosure.final.inventory.pendingPutawayQty, '0.000000')
  assert.equal(evidence.positiveClosure.final.reservationStatus, 'CONSUMED')
  assert.equal(evidence.positiveClosure.final.taskLogCountAfter,
    evidence.positiveClosure.final.taskLogCountBefore + 4)
  assert.equal(h.screenshots, 12)
  assert.equal(h.pageRefreshes, 2)
  assert.ok(h.calls.some((row) => row.method === 'POST' && row.path === '/wms/operation/task/start'))
  assert.ok(h.calls.some((row) => row.method === 'POST' && row.path === '/wms/operation/task/complete'))
  assert.equal(h.calls.filter((row) => row.method === 'POST' &&
    row.path === '/wms/operation/task/putaway/reserve').length, 3)
  assert.equal(h.calls.filter((row) => row.method === 'POST' &&
    row.path === '/wms/operation/task/putaway/confirm').length, 3)
  assert.ok(!evidence.gaps.some((row) =>
    ['PUTAWAY_TERMINAL_NOT_VERIFIED', 'PUTAWAY_SUCCESS_IDEMPOTENCY_AND_STOCK_TRANSFER_NOT_VERIFIED']
      .includes(row.code)))
})

test('formal warehouse search selects the exact owned option without relying on camera-visible hotspots', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(h.warehouseSelections, 1)
  assert.equal(result.browser.selection.warehouseId, ids.warehouse)
  assert.equal(result.browser.selection.warehouseName, `${marker}-\u4ed3\u5e93`)
  assert.equal(result.browser.selection.method, 'formal searchable warehouse selector')
})

test('responsive visual evidence restores the supplied browser viewport without a new context', async () => {
  const h = harness()
  const result = await h.run()
  assert.deepEqual(result.browser.responsive.map(({ width, height }) => [width, height]),
    [[1280, 720], [390, 844]])
  assert.equal(result.browser.screenshots.length, 6)
  assert.deepEqual(h.viewport, { width: 1600, height: 900 })
})

for (const [label, options] of [
  ['online target', { settings: { target: 'online' } }],
  ['tenant2', { settings: { tenantId: '2' } }],
  ['write flag off', { writeFlag: 'false' }],
  ['different local database', { settings: { db: { host: '127.0.0.1', port: '3306', name: 'other' } } }],
  ['different database port', { settings: { db: { host: '127.0.0.1', port: '3307', name: 'cfor_admin_standard' } } }],
  ['nonloopback API', { settings: { apiBase: 'http://example.test:48083' } }],
  ['unsafe scheduler preflight', { guardFailure: true }]
]) {
  test(`safety blocks ${label} before business requests`, async () => {
    const h = harness(options)
    await assert.rejects(h.run)
    assert.ok(!h.calls.some((row) => ['GET', 'POST', 'PAGE'].includes(row.method)))
    assert.equal(h.sqlCalls.length, 0)
  })
}

for (const [label, options] of [
  ['empty 104 entries', { emptyEntries: true }],
  ['empty task page', { emptyTasks: true }],
  ['empty inventory', { emptyInventory: true }],
  ['empty READ ONLY ownership', { noOwnership: true }],
  ['unavailable READ ONLY evidence', { sqlUnavailable: true }],
  ['incomplete schema census', { incompleteSchema: true }],
  ['missing task audit', { emptySqlTable: 'wms_task_log' }],
  ['source wrong', { changeFacts: (facts) => { facts.output.srcBillId = ids.order } }],
  ['entry wrong report', { changeFacts: (facts) => { facts.entry.srcEntryId = ids.prodTask } }],
  ['task line wrong report', { changeFacts: (facts) => { facts.tasks[1].lines[0].sourceLineId = ids.entry } }],
  ['task list has duplicate IDs', { changeFacts: (facts) => { facts.tasks[1].id = facts.tasks[0].id } }],
  ['RECEIVE overquantity', { changeFacts: (facts) => { facts.tasks[0].actualQuantity = 3 } }],
  ['PUTAWAY already in progress', { changeFacts: (facts) => { facts.tasks[1].status = 'IN_PROGRESS' } }],
  ['PUTAWAY overquantity', { changeFacts: (facts) => { facts.tasks[1].plannedQuantity = 3 } }],
  ['RECEIVE missing terminal time', { changeFacts: (facts) => { facts.tasks[0].completedTime = null } }],
  ['missing one of six quantities', { changeFacts: (facts) => { delete facts.inventory.holdQty } }],
  ['unsafe numeric snowflake', { changeFacts: (facts) => { facts.tasks[0].id = Number(ids.receive) } }],
  ['API/SQL quantity drift', { changeSqlRow: (table, row) => { if (table === 'mes_stk_inventory') row.available_qty = '1' } }]
]) {
  test(`rejects ${label}, never sending a probe`, async () => {
    const h = harness(options)
    await assert.rejects(h.run)
    assert.ok(!h.calls.some((row) => row.method === 'POST'))
  })
}

test('foreign/private registry ownership and cleaned fixtures cannot be adopted', async () => {
  for (const mutate of [
    (h) => { h.fixture.owned.find((row) => row.kind === 'warehouse').marker = 'SHARED' },
    (h) => { h.fixture.owned.find((row) => row.kind === 'output').cleaned = true },
    (h) => { h.fixture.fixtureRecord.resources = [...h.fixture.owned] },
    (h) => { h.caseRecord.executionFixtures = [] }
  ]) {
    const h = harness()
    mutate(h)
    await assert.rejects(h.run)
    assert.equal(h.calls.length, 0)
  }
})

test('disabled owned location and missing execute permission are explicit GAPs with no POST', async () => {
  for (const options of [
    { changeFacts: (facts) => { facts.location.isEnabled = false } },
    { changeFacts: (facts) => { facts.permission.permissions = ['wms:operation-task:query'] } }
  ]) {
    const h = harness(options)
    const result = await h.run()
    assert.equal(result.status, 'PARTIAL')
    assert.equal(result.passCandidate, false)
    assert.ok(result.gaps.some((row) => row.code.startsWith('NEGATIVE_')))
    assert.equal(result.negatives.length, 0)
    assert.ok(!h.calls.some((row) => row.method === 'POST'))
  }
})

test('existing ACTIVE, CONSUMED or RELEASED reservation cannot be passed off as absence', async () => {
  for (const status of ['ACTIVE', 'CONSUMED', 'RELEASED']) {
    const h = harness({ changeFacts: (facts) => {
      facts.reservations.push({ id: '2110019776332775425', tenant_id: '1', deleted: '0',
        task_id: ids.putaway, task_line_id: ids.putawayLine, idempotency_key: `${marker}:old`,
        status, reserved_qty: '2', version: '1', update_time: '2026-10-13 02:58:49' })
      facts.tasks[1].lines[0].reservationId = '2110019776332775425'
      facts.tasks[1].lines[0].reservationStatus = status
    } })
    const result = await h.run()
    assert.equal(result.negatives.length, 0)
    assert.equal(result.gaps.filter((row) => row.code.endsWith('_PRECONDITION_NOT_MET')).length, 2)
    assert.ok(!h.calls.some((row) => row.method === 'POST'))
  }
})

for (const [label, options] of [
  ['authentication refusal', { response: { code: 403, msg: 'forbidden' } }],
  ['wrong business precondition', { response: { code: 500, msg: '\u6ca1\u6709\u53ef\u4e0a\u67b6\u7684\u5f85\u5904\u7406\u5e93\u5b58' } }],
  ['HTTP200 business success', { response: { code: 0, data: true } }],
  ['service error', { response: { code: 500, msg: 'Internal Server Error' } }],
  ['transport error', { postError: true }]
]) {
  test(`${label} is not the intended negative and after-snapshot is still collected`, async () => {
    const h = harness(options)
    await assert.rejects(h.run)
    assert.equal(h.caseRecord.mesProductionWmsEvidence.negatives.length, 1)
    const probe = h.caseRecord.mesProductionWmsEvidence.negatives[0]
    assert.ok(probe.after)
    assert.equal(probe.matched, false)
    assert.equal(probe.unchanged, true)
  })
}

for (const table of ['wms_task', 'wms_task_line', 'mes_stk_inventory', 'wms_task_log']) {
  test(`detects persisted audit-only mutation in ${table}`, async () => {
    const h = harness({ mutateSql: (name, rows) => name === table
      ? rows.map((row) => ({ ...row, update_time: '2026-10-13 03:00:00' })) : rows })
    await assert.rejects(h.run, /changed task\/line\/inventory\/reservation\/audit facts/)
    const probe = h.caseRecord.mesProductionWmsEvidence.negatives[0]
    assert.equal(probe.matched, true)
    assert.equal(probe.unchanged, false)
  })
}

test('detects API-only arbitrary field mutation; hash is not limited to quantity/status', async () => {
  const h = harness({ onPost: ({ facts }) => { facts.tasks[1].remark = 'unexpected mutation' } })
  await assert.rejects(h.run, /changed task\/line\/inventory\/reservation\/audit facts/)
  assert.equal(h.caseRecord.mesProductionWmsEvidence.negatives[0].unchanged, false)
})

for (const [label, options] of [
  ['empty page response', { emptyBrowser: true }],
  ['wrong source response', { wrongBrowserSource: true }],
  ['wrong rendered source', { wrongPageSource: true }],
  ['duplicate rendered task', { duplicateCard: true }],
  ['duplicate warehouse option', { duplicateWarehouse: true }],
  ['clipped warehouse selector', { clippedSelector: true }],
  ['missing real scene canvas', { missingCanvas: true }],
  ['zero-size scene canvas', { blankCanvas: true }],
  ['wrong browser tenant', { browserTenant: '2' }]
]) {
  test(`${label} after page execution is a recorded real failure, not a silent GAP`, async () => {
    const h = harness(options)
    await assert.rejects(h.run)
    const result = h.caseRecord.mesProductionWmsEvidence
    assert.equal(result.browser, undefined)
    assert.equal(result.browserAttempted, true)
    assert.equal(result.passCandidate, false)
    assert.ok(result.browserFailure)
    assert.ok(!result.gaps.some((row) => /FORMAL_TASK_PAGE/.test(row.code)))
    assert.ok(h.caseRecord.checks.some((row) => row.name.endsWith('same-context formal task drilldown and refresh') && !row.passed))
    assert.ok(!h.calls.some((row) => row.method === 'POST'))
  })
}

test('positive pending stock does not fabricate a reproduced source conflict or complete upper assertion', async () => {
  const h = harness({ changeFacts: (facts) => {
    facts.inventory.availableQty = 0
    facts.inventory.pendingPutawayQty = 2
  } })
  const result = await h.run()
  assert.equal(result.sourceConflict.observed, false)
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.passCandidate, false)
  assert.ok(!result.gaps.some((row) => row.code === '104_PENDING_STOCK_SOURCE_CONFLICT'))
})

test('canonical full-field hash is SHA256, covers audit/deletion columns, and contains no auth token', async () => {
  const h = harness()
  const result = await h.run()
  const row = result.initial.readOnly.mes_stk_inventory.rows[0]
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(row.fields).sort().map((key) => [key, row.fields[key]])))
  assert.equal(row.hash, createHash('sha256').update(canonical).digest('hex'))
  assert.ok(Object.hasOwn(row.fields, 'deleted') && Object.hasOwn(row.fields, 'update_time'))
  assert.ok(!JSON.stringify(result).includes('unit-auth-token-not-for-storage'))
  assert.equal(result.initial.readOnly.wms_putaway_reservation.count, 0)
  assert.ok(result.negatives.every((row) => row.before.readOnly.wms_putaway_reservation.count === 0 &&
    row.after.readOnly.wms_putaway_reservation.count === 0))
})

test('inventory six-component mismatch cannot be used as stock evidence', async () => {
  const h = harness({ changeFacts: (facts) => { facts.inventory.holdQty = '1.000000' } })
  await assert.rejects(h.run, /six inventory components do not reconcile/)
  assert.ok(!h.calls.some((row) => row.method === 'POST'))
})

test('task identity changes between initial evidence and a probe block that probe', async () => {
  const h = harness()
  const originalLocation = h.facts.location
  let read = 0
  Object.defineProperty(h.facts, 'location', {
    get () {
      if (++read === 1) h.facts.tasks[1].lines[0].id = '2110019776332775425'
      return originalLocation
    }
  })
  await assert.rejects(h.run, /identity mismatch/)
  assert.ok(!h.calls.some((row) => row.method === 'POST'))
})

test('missing page/menu/query permission is a precise unexecuted GAP', async () => {
  for (const options of [
    { noPage: true },
    { changeFacts: (facts) => { facts.permission.menus = [] } },
    { changeFacts: (facts) => { facts.permission.permissions = ['wms:operation-task:execute'] } }
  ]) {
    const h = harness(options)
    const result = await h.run()
    assert.ok(!result.browserAttempted)
    assert.ok(result.gaps.some((row) => row.code.startsWith('FORMAL_TASK_PAGE_')))
    assert.equal(result.passCandidate, false)
    assert.ok(!h.calls.some((row) => row.method === 'PAGE'))
    assert.ok(!h.caseRecord.checks.some((row) => !row.passed))
  }
})

test('location API/identity failures and permission API failures are recorded failures, not missing preconditions', async () => {
  for (const options of [
    { locationUnavailable: true },
    { changeFacts: (facts) => { facts.location.houseId = ids.order } },
    { changeFacts: (facts) => { facts.location.remark = 'SHARED' } },
    { changeFacts: (facts) => { delete facts.location.isEnabled } },
    { permissionUnavailable: true }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run)
    assert.ok(h.caseRecord.checks.some((row) => !row.passed && /API.*readback/.test(row.name)))
    assert.ok(!h.calls.some((row) => row.method === 'POST'))
  }
})

test('an API qualityStatus is cross-checked against READ ONLY instead of assuming qualified stock', async () => {
  const h = harness({ changeSqlRow: (table, row) => {
    if (table === 'mes_stk_inventory') row.quality_status = '0'
  } })
  await assert.rejects(h.run, /SQL\/API qualityStatus mismatch/)
  assert.ok(!h.calls.some((row) => row.method === 'POST'))
})

test('no API qualityStatus is represented as unexposed, not converted to a quality outcome', async () => {
  const h = harness({ changeFacts: (facts) => { delete facts.inventory.qualityStatus } })
  const result = await h.run()
  assert.equal(result.sourceConflict.qualityStatus.apiExposed, false)
  assert.ok(!Object.hasOwn(result.sourceConflict.qualityStatus, 'apiValue'))
  assert.equal(result.sourceConflict.qualityStatus.readOnlyValue, null)
})

test('nonce must match the private registry and every owned identity before any guard or request', async () => {
  for (const mutate of [
    (h) => { h.fixture.fixtureRecord.marker = 'AUTOTEST-MES-PROD-004-63DQTM-FFFFFF' },
    (h) => { h.fixture.owned.find((row) => row.kind === 'report').marker = 'AUTOTEST-MES-PROD-004-63DQTM-FFFFFF' },
    (h) => { h.fixture.marker = 'AUTOTEST-MES-PROD-004-63DQTM-INVALID' }
  ]) {
    const h = harness()
    mutate(h)
    await assert.rejects(h.run)
    assert.equal(h.calls.length, 0)
    assert.equal(h.sqlCalls.length, 0)
  }
})

test('all probes use nonce-owned IDs, allow-listed endpoints only, and never start/cancel', async () => {
  const h = harness()
  await h.run()
  const probes = h.calls.filter((row) => row.method === 'POST')
  assert.deepEqual(probes.map((row) => row.path), [
    '/wms/operation/task/putaway/reserve', '/wms/operation/task/putaway/confirm'
  ])
  assert.equal(probes[0].body.idempotencyKey, `${marker}:WMS-EVIDENCE:${ids.output}`)
  assert.equal(probes[0].body.sourceInventoryId, ids.inventory)
  assert.equal(probes[0].body.targetAreaId, ids.area)
  assert.equal(probes[0].body.targetLocationId, ids.location)
  assert.equal(probes[1].body.materialId, ids.material)
  assert.equal(probes[1].body.batchNo, batch)
  for (const probe of probes) {
    assert.equal(typeof probe.body.taskId, 'string')
    assert.equal(typeof probe.body.lineId, 'string')
    assert.equal(probe.body.taskId, ids.putaway)
    assert.equal(probe.body.lineId, ids.putawayLine)
    assert.ok(!Object.hasOwn(probe.body, 'reservationId'))
  }
  assert.ok(!h.calls.some((row) => /\/(?:start|cancel|complete|create|suggest)(?:[/?]|$)/.test(row.path || '')))
})

test('a reservation inserted by a rejected request is detected by full-table scoped hashes', async () => {
  const h = harness({ onPost: ({ facts }) => {
    facts.reservations.push({ id: '2110019776332775425', tenant_id: '1', deleted: '0',
      task_id: ids.putaway, task_line_id: ids.putawayLine, idempotency_key: `${marker}:unexpected`,
      status: 'RELEASED', reserved_qty: '2', version: '1', update_time: '2026-10-13 02:58:49' })
  } })
  await assert.rejects(h.run, /changed task\/line\/inventory\/reservation\/audit facts/)
  const probe = h.caseRecord.mesProductionWmsEvidence.negatives[0]
  assert.equal(probe.before.readOnly.wms_putaway_reservation.count, 0)
  assert.equal(probe.after.readOnly.wms_putaway_reservation.count, 1)
  assert.equal(probe.unchanged, false)
})

test('nonce reservation key collision with a foreign task is not adopted or probed', async () => {
  const h = harness({ changeFacts: (facts) => {
    facts.reservations.push({ id: '2110019776332775425', tenant_id: '1', deleted: '0',
      task_id: ids.work, task_line_id: ids.putawayLine, idempotency_key: `${marker}:WMS-EVIDENCE:${ids.output}`,
      status: 'ACTIVE', reserved_qty: '2', version: '1', update_time: '2026-10-13 02:58:49' })
  } })
  await assert.rejects(h.run, /foreign reservation key collision/)
  assert.ok(!h.calls.some((row) => row.method === 'POST'))
})

test('unavailable after-request snapshot is a recorded failure, never unchanged success', async () => {
  const h = harness({ afterSqlUnavailable: true })
  await assert.rejects(h.run, /READ ONLY evidence unavailable/)
  const probe = h.caseRecord.mesProductionWmsEvidence.negatives[0]
  assert.ok(probe.afterError)
  assert.equal(probe.after, undefined)
  assert.notEqual(probe.unchanged, true)
  assert.ok(h.caseRecord.checks.some((row) => !row.passed && row.name.endsWith('after-request full fact readback')))
  assert.equal(h.calls.filter((row) => row.method === 'POST').length, 1)
})
