import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { assertWriteTestSnapshot } from '../lib/db.mjs'

const fixtureUrl = new URL('../fixtures/mes-execution-write.mjs', import.meta.url)
const source = fs.readFileSync(fixtureUrl, 'utf8')
const ok = (data) => ({ code: 0, data })
const caseRecord = () => ({ checks: [], notes: [], evidence: [] })
const dataModule = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
let moduleSequence = 0

// Only module imports are substituted; all fixture methods run their real bodies.
async function isolatedFixture (dependencies) {
  const key = `__mesExecutionFixture${++moduleSequence}`
  globalThis[key] = dependencies
  try {
    const body = source.replace(/from '(\.\.?\/[^']+)'/g, (match, specifier) => {
      const injected = dependencies[specifier]
      const url = injected
        ? dataModule(Object.keys(injected).map((name) =>
          `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}].${name};`
        ).join('\n'))
        : new URL(specifier, fixtureUrl).href
      return `from ${JSON.stringify(url)}`
    })
    return await import(dataModule(body))
  } finally {
    delete globalThis[key]
  }
}

const tables = {
  '/mes/wmsWareHouse/add': 'mes_wms_ware_house',
  '/mes/wmsHouseArea/add': 'mes_wms_house_area',
  '/mes/wms-house-location/create': 'mes_wms_house_location',
  '/mes/basMaterial/add': 'mes_bas_material',
  '/mes/wmsAssemble/add': 'mes_wms_assemble',
  '/mes/wmsProcedure/add': 'mes_wms_procedure',
  '/mes/teamManage/add': 'mes_team_manage',
  '/mes/wmsTechRoute/addMain': 'mes_wms_tech_route',
  '/mes/prodOrder/add': 'mes_prod_order',
  '/mes/stkInventory/delete': 'mes_stk_inventory'
}
const sqlFields = {
  id: 'id', tenant_id: 'tenantId', prod_order_id: 'prodOrderId', work_ticket_id: 'workTicketId',
  product_id: 'productId', routing: 'routing',
  code: 'code', mark: 'mark', remark: 'remark', area_code: 'areaCode',
  location_code: 'locationCode', bill_no: 'billNo', team_id: 'teamId',
  warehouse_id: 'warehouseId', material_id: 'materialId', ware_area_id: 'wareAreaId',
  ware_location_id: 'wareLocationId', batch_no: 'batchNo'
}

async function harness (options = {}) {
  const calls = []
  const sqlCalls = []
  const rows = new Map()
  const record = {}
  let sequence = 0n
  let fixture
  const shared = [
    { id: '11', kind: 'unit' }, { id: '12', kind: 'workplace' },
    { id: '13', kind: 'line' }, { id: '14', kind: 'member' }
  ]
  const originalShared = structuredClone(shared)
  const createRow = (table, body) => {
    const row = {
      ...structuredClone(body), id: String(9223372036854775000n + ++sequence),
      table, tenantId: '1', deleted: 0, isDeleted: 0
    }
    rows.set(row.id, row)
    return row
  }
  const createInventoryForOpening = (opening) => {
    const entry = opening.stkIoEntryList[0]
    return createRow('inventory', {
      warehouseId: entry.warehouseId,
      materialId: entry.materialId,
      wareAreaId: entry.wareAreaId,
      wareLocationId: entry.wareLocationId,
      batchNo: entry.batchNo,
      qty: entry.qty,
      availableQty: entry.qty,
      lockQty: 0,
      holdQty: 0,
      frozenQty: 0,
      pendingPutawayQty: 0,
      isClosed: 0,
      sourceOpeningId: opening.id
    })
  }
  const call = (method, path, body) => {
    const item = { method, path, body: structuredClone(body) }
    calls.push(item)
    if (options.failPath === path) throw new Error(`unit transport failure ${path}`)
    return item
  }
  const rowDeleted = (row) => row?.deleted === 1 || row?.isDeleted === 1
  const ownWork = () => [...rows.values()].find((row) => row.table === 'work')
  const ownTask = () => [...rows.values()].find((row) => row.table === 'task')
  const api = {
    async getBusiness (path) {
      call('GET', path)
      if (path === '/mes/basUnit/list/enabled') return ok([shared[0]])
      if (path === '/mes/monitor/workplaces') return ok([shared[1]])
      if (path.startsWith('/mes/prodOrder/queryMesProdOrderSubByMainId?')) {
        assert.equal(new URL(path, 'http://unit').searchParams.get('id'), fixture.order.id)
        return ok([{ id: '21', prodOrderId: fixture.order.id }])
      }
      if (path.startsWith('/mes/prodWork/getWorkByProdOrderId?')) {
        assert.equal(new URL(path, 'http://unit').searchParams.get('prodOrderId'), fixture.order.id)
        return ok([{ ...ownWork(), ...options.workReadback }])
      }
      if (path.startsWith('/mes/prodWorkTask/list?')) {
        assert.equal(new URL(path, 'http://unit').searchParams.get('workTicketId'), ownWork().id)
        return ok({ records: ownTask() ? [{ ...ownTask(), ...options.taskReadback }] : [] })
      }
      if (path.startsWith('/mes/prodWorkTask/feed-pick-preview?')) {
        return ok({ taskId: fixture.tasks[0].id, materialList: options.emptyFeedPreview ? [] : [{
          materialId: fixture.component.id, requiredQty: 2, srcEntryId: '21',
          remainingPickQty: 2,
          stockQty: options.previewStockQty ?? 0
        }] })
      }
      if (path.startsWith('/mes/prodWorkTask/feed-status?')) {
        const fed = [...rows.values()].filter((row) => row.table === 'feed')
        return ok({
          allowReport: fed.length > 0, pickSatisfied: fed.length > 0,
          feedSatisfied: fed.length > 0, fedQty: fed.length > 0 ? 2 : 0,
          remainingFeedQty: fed.length > 0 ? 0 : 2, blockReason: 'unit missing feed'
        })
      }
      if (path.startsWith('/mes/prodWorkTask/feed-record/list?')) {
        return ok([...rows.values()].filter((row) => row.table === 'feed'))
      }
      if (path.startsWith('/mes/stkIo/queryEntryByMainId?')) {
        return ok(rows.get(new URL(path, 'http://unit').searchParams.get('id')).stkIoEntryList)
      }
      const id = new URL(path, 'http://unit').searchParams.get('id')
      if (!rows.has(id) || rowDeleted(rows.get(id))) {
        assert.ok(path.startsWith('/mes/prodWork/queryById?'), `Unexpected GET ${path}`)
        if (options.deletedWorkError) throw new Error(options.deletedWorkError)
        return ok(null)
      }
      const row = rows.get(id)
      if (path.startsWith('/mes/prodWork/queryById?')) {
        return options.workResponse || ok({ ...row, ...options.transitionReadback })
      }
      return ok(structuredClone(row))
    },
    async postBusiness (path, body) {
      call('POST', path, body)
      if (path.startsWith('/mes/wmsAssemble/publish?id=')) {
        const id = new URL(path, 'http://unit').searchParams.get('id')
        assert.ok(rows.has(id), `published BOM ${id} must exist`)
        rows.get(id).devStatus = 2
        return ok(true)
      }
      if (tables[path]) return ok(createRow(tables[path], body).id)
      if (path === '/mes/stkIo/add/submit') {
        const opening = createRow('opening', { ...body, isEffective: options.autoEffective ? 1 : 0 })
        if (options.autoEffective) createInventoryForOpening(opening)
        return ok(opening.id)
      }
      if (path === '/mes/prodWorkTask/generate-pick-bill') {
        const entry = fixture.opening && rows.get(fixture.opening.id).stkIoEntryList[0]
        const pick = createRow('pick', {
          stockIoType: '203', srcBillType: 'ProdWork', srcBillId: ownWork().id,
          billNo: 'OWN-PICK', billStage: '12', isEffective: 0, isVoided: 0,
          stkIoEntryList: [{ ...entry, id: '31', qty: 2, srcEntryId: '21' }]
        })
        return ok({ billId: pick.id, billNo: pick.billNo })
      }
      if (path === '/mes/prodWorkTask/feed-record') {
        const feed = createRow('feed', { ...body, pickBillId: fixture.pickBill.id })
        return ok(feed.id)
      }
      if (path === '/mes/prodWorkReport/addByTaskId') {
        const task = ownTask()
        const report = createRow('report', {
          ...body,
          workTaskId: body.taskId,
          workTicketId: task.workTicketId,
          reportNum: body.qty,
          qualifiedNum: body.qualifiedQty,
          unqualifiedNum: body.defectQty
        })
        if (options.autoProductionOutput !== false) {
          const output = createRow('output', {
            billNo: `${fixture.marker}-OUTPUT`,
            srcBillType: 'ProdWork',
            srcBillId: task.workTicketId,
            stockIoType: '104',
            billStage: '34',
            isEffective: 1,
            isVoided: 0,
            outputEntry: {
              srcEntryId: report.id,
              materialId: fixture.material.id,
              warehouseId: fixture.warehouse.id,
              wareAreaId: fixture.area.id,
              wareLocationId: fixture.location.id,
              batchNo: `${fixture.marker}-B1`
            }
          })
          createRow('inventory', {
            warehouseId: fixture.warehouse.id,
            materialId: fixture.material.id,
            wareAreaId: fixture.area.id,
            wareLocationId: fixture.location.id,
            batchNo: output.outputEntry.batchNo,
            qty: body.qualifiedQty,
            availableQty: body.qualifiedQty,
            lockQty: 0,
            holdQty: 0,
            frozenQty: 0,
            pendingPutawayQty: 0,
            isClosed: 0,
            sourceOutputId: output.id
          })
        }
        return ok(report.id)
      }
      if (path === '/mes/prodWork/transferWorkOrder') {
        assert.equal(body[0].prodOrderId, fixture.order.id)
        createRow('work', {
          prodOrderId: fixture.order.id, prodOrderSubId: body[0].prodOrderSubId,
          workTicketNo: `${fixture.marker}-WORK`, remark: fixture.marker, status: 1
        })
        return ok(true)
      }
      if (path === '/mes/prodWork/scheduleProduct') {
        assert.equal(body.id, ownWork().id)
        createRow('task', {
          workTicketId: body.id, productId: fixture.material.id, routing: fixture.route.id,
          workOrderTaskCode: `${fixture.marker}-TASK`, remark: fixture.marker
        })
        return ok(true)
      }
      assert.ok(['/mes/prodWork/start', '/mes/prodWork/pause', '/mes/prodWork/resume'].includes(path))
      assert.equal(body.id, ownWork().id)
      assert.equal(body.prodWorkOrderId, ownWork().id)
      if (options.transitionResponse) return options.transitionResponse
      Object.assign(ownWork(), path.endsWith('/start')
        ? { status: 2 }
        : path.endsWith('/pause')
          ? { status: 3, pauseReason: body.pauseReason, expectResumeTime: body.expectResumeTime }
          : { status: 2, resumeTime: '2026-10-08 10:00:00' })
      return ok(true)
    },
    async putBusiness (path, body) {
      call('PUT', path, body)
      assert.ok(rows.has(String(body.id)), `Unexpected PUT ${path}`)
      if (path === '/mes/basMaterial/edit' && options.ignoreMaterialEdit) return ok(true)
      Object.assign(rows.get(String(body.id)), body)
      if (path === '/mes/stkIo/check') {
        rows.get(body.id).isEffective = 1
        if (rows.get(body.id).table === 'opening' &&
          ![...rows.values()].some((row) => row.table === 'inventory' &&
          row.sourceOpeningId === String(body.id))) {
          createInventoryForOpening(rows.get(body.id))
        }
      }
      if (path === '/mes/stkIo/edit/submit') rows.get(body.id).billStage = '22'
      if (path === '/mes/stkIo/edit/submit') {
        assert.equal(body.billStage, '12', 'legacy submitEdit requires the actual draft stage')
        assert.equal(Number(body.isEffective), 0)
        assert.ok(!('actions' in body), 'client must not forge permitted actions')
      }
      if (path === '/mes/stkIo/void' && !options.ignoreVoid) {
        Object.assign(rows.get(body.id), { isEffective: 0, isVoided: 1 })
        for (const row of rows.values()) {
          if (row.table === 'inventory' &&
            (row.sourceOpeningId === String(body.id) || row.sourceOutputId === String(body.id)) &&
            !options.retainInventoryQty) {
            Object.assign(row, {
              qty: 0,
              availableQty: 0,
              lockQty: 0,
              holdQty: 0,
              frozenQty: 0,
              pendingPutawayQty: 0
            })
          }
        }
      }
      return ok(true)
    },
    async request (method, path, body) {
      call(method, path, body)
      if (path === '/mes/prodWork/scheduleProduct' && !fixture.withTeam) {
        return { code: 500, msg: '未找到工艺路线' }
      }
      if (path.startsWith('/mes/prodWork/preScheduleProduct?')) {
        return { code: 500, msg: '班组信息有误' }
      }
      if (path === '/mes/prodWorkTask/generate-pick-bill') {
        if (options.duplicatePickWrites) {
          const pick = [...rows.values()].find((row) => row.table === 'pick')
          createRow('pick', { ...pick, billNo: 'UNEXPECTED-DUPLICATE' })
        }
        return { code: 400, msg: '领料已满足，无需重复生成领料单' }
      }
      if (path === '/mes/prodWorkTask/feed-record') {
        if (options.duplicateFeedWrites) createRow('feed', {
          ...body, pickBillId: fixture.pickBill.id
        })
        return { code: 400, msg: '超过已领未投余额' }
      }
      if (path.startsWith('/mes/prodWorkTask/checkOnly?')) {
        const taskId = new URL(path, 'http://unit').searchParams.get('prodWorkTaskId')
        assert.equal(taskId, ownTask().id)
        Object.assign(ownTask(), { isEffective: 'Y', isFeed: Number(fixture.withFeed) })
        return options.checkOnlyResponse || ok(true)
      }
      if (path.startsWith('/mes/prodWorkTask/voidOnly?')) {
        const taskId = new URL(path, 'http://unit').searchParams.get('prodWorkTaskId')
        assert.equal(taskId, ownTask().id)
        Object.assign(ownTask(), { isEffective: 'N' })
        return options.voidOnlyResponse || ok(true)
      }
      if (path.startsWith('/mes/prodWorkTask/void?')) {
        const workId = new URL(path, 'http://unit').searchParams.get('prodWorkId')
        assert.equal(workId, ownWork().id)
        for (const row of rows.values()) {
          if (row.table === 'task' && row.workTicketId === workId) {
            row.isEffective = 'N'
          }
        }
        Object.assign(ownWork(), { status: 1 })
        return options.voidWorkResponse || ok(true)
      }
      assert.equal(path, '/mes/prodWork/revocation')
      assert.equal(body.id, ownWork().id)
      assert.equal(body.prodWorkOrderId, ownWork().id)
      if (options.revocationResponse) return options.revocationResponse
      for (const [id, row] of rows) {
        if (row.table === 'task' && row.workTicketId === ownWork().id &&
          !rowDeleted(row)) rows.delete(id)
      }
      Object.assign(ownWork(), { status: 0 })
      return ok(true)
    },
    async deleteBusiness (path, requestOptions = {}) {
      call('DELETE', path)
      const id = new URL(path, 'http://unit').searchParams.get('id')
      assert.ok(rows.has(id), `Unexpected DELETE ${path}`)
      if (path.startsWith('/mes/wmsWareHouse/delete') && options.warehouseDeleteRejection) {
        return options.warehouseDeleteRejection
      }
      if (!options.keepDeletedRows) {
        if (options.softDeleteRows) {
          const row = rows.get(id)
          if (row.table === 'task') row.isDeleted = 1
          else row.deleted = 1
        }
        else rows.delete(id)
      }
      return ok(true)
    }
  }
  const runReadOnlySql = async (sql) => {
    sqlCalls.push(sql)
    if (sql.includes('failed-migrations')) {
      return options.preflight || {
        available: true,
        rows: [['failed-migrations', '0'], ['enabled-jobs', '0'], ['active-triggers', '0'],
          ['active-database-writers', '0']]
      }
    }
    if (sql.includes('FROM mes_work_line')) return { available: true, rows: [['13']] }
    if (sql.includes('FROM mes_team_manage_sub')) return { available: true, rows: [['14']] }
    if (options.enabledBomRows && sql.includes('FROM mes_wms_assemble') &&
      sql.includes('bom.dev_status=2') && sql.includes("bom.bom_usage='PRODUCTION'")) {
      return { available: true, rows: options.enabledBomRows }
    }
    if (sql.includes("io.stock_io_type='203'")) {
      if (options.feedFactsSnapshot) return options.feedFactsSnapshot
      return { available: true, rows: [...rows.values()]
        .filter((row) => row.table === 'pick' && row.srcBillId === fixture.works[0].id)
        .flatMap((row) => row.stkIoEntryList.map((entry) => [
          row.id, row.billNo, row.billStage, String(row.isEffective), String(row.isVoided),
          entry.id, entry.materialId, String(entry.qty)
        ])) }
    }
    if (sql.includes('FROM mes_prod_task_feed_record')) {
      return { available: true, rows: [...rows.values()]
        .filter((row) => row.table === 'feed').map((row) => [
          row.id, row.taskId, row.pickBillId, row.pickEntryId,
          row.materialId, row.batchNo, String(row.feedQty)
        ]) }
    }
    if (sql.includes('JOIN mes_stk_io_entry')) {
      const sourceWorkId = /io\.src_bill_id='([^']+)'/.exec(sql)?.[1]
      const sourceReportId = /entry\.src_entry_id='([^']+)'/.exec(sql)?.[1]
      const outputRows = [...rows.values()].filter((row) =>
        row.table === 'output' && row.tenantId === '1' && !rowDeleted(row) &&
        (!sourceWorkId || row.srcBillId === sourceWorkId) &&
        (!sourceReportId || row.outputEntry?.srcEntryId === sourceReportId))
      return {
        available: true,
        rows: outputRows.map((row) => [
          row.id,
          row.billNo,
          row.isEffective ?? 0,
          row.isVoided ?? 0,
          row.billStage,
          row.outputEntry.materialId,
          row.outputEntry.warehouseId,
          row.outputEntry.wareAreaId,
          row.outputEntry.wareLocationId,
          row.outputEntry.batchNo
        ])
      }
    }
    if (options.queryRows && sql.includes('FROM mes_wms_ware_house')) {
      return { available: true, rows: options.queryRows }
    }
    const deletionProof = /^\s*SELECT id,\s*(?:is_deleted|deleted)\+0\s+FROM/i.test(sql)
    assert.match(sql, deletionProof
      ? /tenant_id=1/
      : /tenant_id=1 AND (?:deleted|is_deleted)=0/)
    const sqlTable = /FROM (\w+)/.exec(sql)?.[1]
    const table = {
      mes_prod_work: 'work',
      mes_prod_work_task: 'task',
      mes_prod_work_report: 'report',
      mes_stk_io: 'opening',
      mes_stk_inventory: 'inventory'
    }[sqlTable] || sqlTable
    if (deletionProof && sqlTable === 'mes_prod_work' && options.cleanupSnapshot) {
      return options.cleanupSnapshot
    }
    const conditions = [...sql.matchAll(/(\w+)='([^']*)'/g)]
    const found = [...rows.values()].filter((row) => row.table === table &&
      row.tenantId === '1' && (deletionProof || !rowDeleted(row)) &&
      (!/is_closed=0/.test(sql) || row.isClosed === 0) &&
      conditions.every(([, column, value]) => String(row[sqlFields[column]]) === value))
    const deletedColumn = sqlTable === 'mes_prod_work_task' ? 'isDeleted' : 'deleted'
    if (sqlTable === 'mes_stk_inventory' && !deletionProof &&
      /SELECT id, (?:warehouse_id|qty)/i.test(sql)) {
      return {
        available: true,
        rows: found.map((row) => [
          row.id,
          ...(sql.includes('warehouse_id')
            ? [
                row.warehouseId,
                row.materialId,
                row.wareAreaId,
                row.wareLocationId,
                row.batchNo,
                row.qty,
                row.availableQty,
                row.lockQty,
                row.holdQty,
                row.frozenQty,
                row.pendingPutawayQty,
                String(row.deleted),
                row.isClosed
              ]
            : [
                row.qty,
                row.availableQty,
                row.lockQty,
                row.holdQty,
                row.frozenQty,
                row.pendingPutawayQty,
                String(row.deleted),
                row.isClosed
              ])
        ])
      }
    }
    return { available: true, rows: found.map((row) =>
      deletionProof ? [row.id, String(row[deletedColumn])] : [row.id]) }
  }
  const module = await isolatedFixture({
    '../config/index.mjs': {
      config: {
        target: 'local', tenantId: '1', db: { name: 'cfor_admin_standard' },
        ...options.settings
      }
    },
    '../lib/db.mjs': {
      runReadOnlySql,
      assertLocalWriteSafety: async (targetRecord) => {
        const snapshot = await runReadOnlySql('failed-migrations enabled-jobs active-triggers')
        if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
        assertWriteTestSnapshot(snapshot.rows)
        targetRecord.database = [{ stage: 'write-preflight', ...snapshot }]
      }
    }
  })
  fixture = new module.ExecutionWorkflowFixture(api, record, 'MES-TASK-REPORT-002', options.fixture)
  return {
    fixture, module, calls, sqlCalls, rows, api, record,
    assertSharedUnchanged: () => assert.deepEqual(shared, originalShared)
  }
}

test('execution setup creates an isolated, linked API-only chain and keeps Snowflake IDs as strings', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const f = h.fixture
  assert.match(f.marker, /^AUTOTEST-MES-TASK-REPORT-002-/)
  assert.deepEqual(f.owned.map((resource) => resource.kind), [
    'warehouse', 'area', 'location', 'material', 'material', 'bom', 'opening',
    'inventory', 'team', 'procedure', 'route', 'order', 'work', 'task'
  ])
  assert.equal(h.record.executionFixture.resources, f.owned)
  assert.ok(f.owned.every((resource) => resource.marker === f.marker &&
    typeof resource.id === 'string' && BigInt(resource.id) > BigInt(Number.MAX_SAFE_INTEGER)))
  const payload = (path) => h.calls.find((item) => item.path === path).body
  assert.equal(payload('/mes/wmsHouseArea/add').houseId, f.warehouse.id)
  assert.equal(payload('/mes/wms-house-location/create').areaId, f.area.id)
  assert.equal(payload('/mes/wmsAssemble/add').stockId, f.material.id)
  assert.equal(payload('/mes/wmsAssemble/add').wmsAssembleSubList[0].stockId, f.component.id)
  assert.equal(payload('/mes/wmsAssemble/add').defaultRecord, 'Y')
  assert.equal(payload('/mes/basMaterial/add').produced, 'Y')
  assert.equal(h.calls.filter((item) => item.path === '/mes/basMaterial/add')[1].body.produced, 'N')
  assert.ok(h.calls.some((item) => item.path === `/mes/wmsAssemble/publish?id=${encodeURIComponent(f.bom.id)}`))
  const opening = payload('/mes/stkIo/add/submit')
  assert.equal(opening.stkIoEntryList[0].materialId, f.component.id)
  assert.equal(opening.stkIoEntryList[0].warehouseId, f.warehouse.id)
  assert.equal(opening.stkIoEntryList[0].wareLocationId, f.location.id)
  assert.equal(f.inventory.dimensions.batchNo, opening.stkIoEntryList[0].batchNo)
  assert.equal(payload('/mes/wmsTechRoute/addMain').wmsTechRouteSubList[0].procedureId, f.procedure.id)
  assert.equal(payload('/mes/prodOrder/add').prodOrderSubList[0].wmsAssembleId, f.bom.id)
  assert.equal(f.works[0].prodOrderId, f.order.id)
  assert.equal(f.tasks[0].workTicketId, f.works[0].id)
  const sharedIds = new Set(['11', '12', '13', '14'])
  assert.ok(!h.calls.some((item) => item.method !== 'GET' && sharedIds.has(item.body?.id)))
  assert.ok(!f.owned.some((resource) => sharedIds.has(resource.id)))
  assert.equal(cr.checks.length, 1)
  assert.equal(cr.checks[0].passed, true)
  h.assertSharedUnchanged()
})

test('production execution fixtures can omit opening inventory when the case does not own WMS stock facts', async () => {
  const h = await harness({ fixture: { withOpeningInventory: false } })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  assert.equal(h.fixture.opening, null)
  assert.ok(!h.calls.some((item) => item.path === '/mes/stkIo/add/submit'))
  assert.ok(!h.fixture.owned.some((resource) => resource.kind === 'opening'))
  await h.fixture.cleanup(cr)
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
  assert.ok(!cr.notes.some((note) => /库存事实|期初/.test(note)))
})

test('MES-BASE-004 reuses a real enabled production BOM instead of creating a draft BOM', async () => {
  const h = await harness({
    fixture: { reuseEnabledBom: true, withOpeningInventory: false },
    enabledBomRows: [['101', 'ENABLED-BOM', '201', '11', 'ENABLED-FG', '202', '11', 'ENABLED-RM']]
  })
  const cr = caseRecord()
  await h.fixture.setup(cr)

  assert.equal(h.fixture.bom.id, '101')
  assert.equal(h.fixture.bom.devStatus, 2)
  assert.equal(h.fixture.material.id, '201')
  assert.equal(h.fixture.component.id, '202')
  assert.ok(!h.calls.some((item) => item.path === '/mes/basMaterial/add'))
  assert.ok(!h.calls.some((item) => item.path === '/mes/wmsAssemble/add'))
  assert.equal(h.calls.find((item) => item.path === '/mes/prodOrder/add').body
    .prodOrderSubList[0].wmsAssembleId, '101')
  assert.ok(h.sqlCalls.some((sql) => sql.includes('bom.dev_status=2')))
  assert.ok(!h.fixture.owned.some((resource) => ['material', 'bom'].includes(resource.kind)))
  assert.equal(cr.checks[0].passed, true)
})

test('execution setup blocks nonlocal target, other tenant and wrong database before any API call', async () => {
  for (const settings of [
    { target: 'production' }, { tenantId: '2' }, { db: { name: 'cfor_admin_saas_standard' } }
  ]) {
    const h = await harness({ settings })
    await assert.rejects(() => h.fixture.setup(caseRecord()))
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.sqlCalls, [])
  }
})

test('unavailable, incomplete or nonidle database safety evidence prevents fixture writes', async () => {
  for (const preflight of [
    { available: false, reason: 'unit database unavailable' },
    { available: true, rows: [] },
    ...['failed-migrations', 'enabled-jobs', 'active-triggers', 'active-database-writers'].map((tag) => ({
      available: true,
      rows: ['failed-migrations', 'enabled-jobs', 'active-triggers', 'active-database-writers']
        .map((name) => [name, name === tag ? '1' : '0'])
    }))
  ]) {
    const h = await harness({ preflight })
    await assert.rejects(() => h.fixture.setup(caseRecord()), /BLOCKED/)
    assert.deepEqual(h.calls, [])
  }
})

test('ownership lookup must be unique and cannot substitute arbitrary warehouse IDs', async () => {
  for (const queryRows of [[], [['51'], ['52']]]) {
    const h = await harness({ queryRows })
    const cr = caseRecord()
    await assert.rejects(() => h.fixture.setup(cr), /所有权回读必须唯一/)
    assert.deepEqual(h.calls.filter((item) => item.method !== 'GET').map((item) => item.path),
      ['/mes/wmsWareHouse/add'])
    assert.equal(h.fixture.owned.length, 0)
    assert.equal(cr.checks.length, 0)
  }
})

test('already effective opening inventory is never approved twice', async () => {
  const h = await harness({ autoEffective: true })
  await h.fixture.setup(caseRecord())
  assert.ok(!h.calls.some((item) => item.path === '/mes/stkIo/check'))
  assert.equal(h.rows.get(h.fixture.opening.id).isEffective, 1)
})

test('execution start, pause and resume write only the fixture work and preserve pause history', async () => {
  const h = await harness()
  await h.fixture.setup(caseRecord())
  const id = h.fixture.works[0].id
  const start = await h.fixture.startWork()
  const paused = await h.fixture.pauseWork(h.fixture.marker, '2026-10-08T11:00:00+08:00')
  const resumed = await h.fixture.resumeWork()
  assert.equal(start.status, 2)
  assert.equal(paused.status, 3)
  assert.equal(paused.pauseReason, h.fixture.marker)
  assert.equal(paused.expectResumeTime, '2026-10-08T11:00:00+08:00')
  assert.equal(resumed.status, 2)
  assert.equal(resumed.pauseReason, h.fixture.marker)
  assert.ok(resumed.resumeTime)
  assert.deepEqual(h.calls.filter((item) =>
    ['/mes/prodWork/start', '/mes/prodWork/pause', '/mes/prodWork/resume'].includes(item.path)
  ).map((item) => [item.body.id, item.body.prodWorkOrderId]), [[id, id], [id, id], [id, id]])
  h.assertSharedUnchanged()
})

test('execution transitions propagate business rejection, no valid readback or fabricated PASS', async () => {
  for (const operation of ['startWork', 'pauseWork', 'resumeWork']) {
    const h = await harness({ transitionResponse: { code: 500, msg: 'unit business rejection' } })
    await h.fixture.setup(caseRecord())
    const before = h.calls.length
    await assert.rejects(() => h.fixture[operation]('reason', '2026-10-08T11:00:00+08:00'),
      /business failure/)
    assert.equal(h.calls.slice(before).length, 1)
  }
  const h = await harness({ transitionReadback: { status: 1 } })
  await h.fixture.setup(caseRecord())
  await assert.rejects(() => h.fixture.startWork(), /状态应为进行中/)
})

test('execution cleanup follows the formal task/work state machine and deletes only owned resources', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const ownedIds = new Set(h.fixture.owned.map((item) => item.id))
  const before = h.calls.length
  await h.fixture.cleanup(cr)
  const cleanup = h.calls.slice(before)
  assert.deepEqual(cleanup.filter((item) => item.method !== 'GET').map((item) => item.path.split('?')[0]), [
    '/mes/prodWork/revocation', '/mes/prodWork/delete',
    '/mes/prodOrder/delete', '/mes/basMaterial/edit', '/mes/basMaterial/edit',
    '/mes/stkIo/void', '/mes/stkInventory/delete', '/mes/wmsTechRoute/delete',
    '/mes/wmsProcedure/delete', '/mes/wmsAssemble/delete', '/mes/basMaterial/delete',
    '/mes/basMaterial/delete', '/mes/wms-house-location/delete', '/mes/wmsHouseArea/delete',
    '/mes/wmsWareHouse/delete', '/mes/teamManage/delete'
  ])
  assert.deepEqual(cleanup.filter((item) => item.method === 'GET')
    .map((item) => item.path.split('?')[0])
    .filter((path) => ['/mes/prodWorkTask/voidOnly', '/mes/prodWorkTask/void'].includes(path)), [
    '/mes/prodWorkTask/void'
  ])
  assert.ok(cleanup.filter((item) => item.method !== 'GET').every((item) => {
    const params = new URL(item.path, 'http://unit').searchParams
    const id = item.body?.id || params.get('id') || params.get('prodWorkTaskId') || params.get('prodWorkId')
    return ownedIds.has(String(id))
  }))
  assert.equal(h.rows.size, 1)
  assert.equal(h.rows.get(h.fixture.opening.id).isEffective, 0)
  assert.equal(h.rows.get(h.fixture.opening.id).isVoided, 1)
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
  assert.equal(cr.database.filter((item) => item.stage === 'execution-cleanup').length, 13)
  assert.ok(cr.checks.every((check) => check.passed))
  h.assertSharedUnchanged()
})

test('production report captures formal auto-output and voids its inventory before fixture cleanup', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  await h.fixture.startWork()
  const report = await h.fixture.reportTask({ qty: 2, qualifiedQty: 1, defectQty: 1 })
  const output = h.fixture.owned.find((resource) => resource.kind === 'output')
  const outputInventory = h.fixture.owned.filter((resource) =>
    resource.kind === 'inventory' && resource.id !== h.fixture.inventory.id)

  assert.equal(String(report.id), h.fixture.reportIds[0])
  assert.ok(output)
  assert.equal(output.sourceReportId, h.fixture.reportIds[0])
  assert.equal(output.stockIoType, '104')
  assert.equal(outputInventory.length, 1)
  assert.deepEqual(output.dimensions, outputInventory[0].dimensions)

  const beforeCleanup = h.calls.length
  await h.fixture.cleanup(cr)
  const cleanupWrites = h.calls.slice(beforeCleanup).filter((item) => item.method !== 'GET')
    .map((item) => item.path.split('?')[0])
  assert.deepEqual(cleanupWrites.slice(0, 2), [
    '/mes/stkIo/void',
    '/mes/prodWorkReport/delete'
  ])
  assert.equal(output.cleanup, 'VOIDED_RETAINED_AUTO_OUTPUT')
  assert.equal(h.rows.has(output.id), true)
  assert.equal(h.rows.get(output.id).isEffective, 0)
  assert.equal(h.rows.get(output.id).isVoided, 1)
  assert.equal(h.rows.has(outputInventory[0].id), false)
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
  assert.ok(cr.checks.every((check) => check.passed))
})

test('quality reports also adopt real premature output so cleanup cannot leave untracked inventory', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  h.fixture.withQuality = true
  const report = await h.fixture.reportTask({ qty: 2, qualifiedQty: 2, defectQty: 0 })
  const first = h.fixture.owned.filter((resource) => resource.kind === 'output')
  assert.equal(first.length, 1)
  const inventoryCount = h.fixture.owned.filter((resource) => resource.kind === 'inventory').length
  const output = await h.fixture.captureProductionOutput(report.id, { requireInventory: true })
  assert.equal(output, first[0])
  assert.equal(h.fixture.outputIds.length, 1)
  assert.equal(h.fixture.owned.filter((resource) => resource.kind === 'inventory').length, inventoryCount)
  await h.fixture.cleanup(cr)
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
})

test('a generated production pick draft is submitted before audit with owned entry dimensions', async () => {
  for (const autoEffective of [false, true]) {
    const h = await harness()
    await h.fixture.setup(caseRecord())
    const f = h.fixture
    f.pickBill = { id: '31' }
    const draft = {
      id: '31', stockIoType: '203', srcBillType: 'ProdWork', srcBillId: f.works[0].id,
      billStage: '12', isEffective: 0, billNo: 'OWN-PICK', version: '0',
      isVoided: 0, isClosed: 0,
      createBy: 'shared-user', billDate: '2026-10-12', remark: 'generated'
    }
    const entry = {
      id: '32', materialId: f.component.id, qty: 2, unitId: '11',
      warehouseId: f.warehouse.id, wareAreaId: f.area.id, wareLocationId: f.location.id,
      batchNo: f.inventory.dimensions.batchNo, createBy: 'shared-user'
    }
    const calls = []
    f.api = {
      async putBusiness (path, body) {
        calls.push({ path, body })
        assert.equal(body.id, '31')
        return ok(true)
      },
      async getBusiness () {
        return ok({ ...draft, billStage: autoEffective ? '34' : '22', isEffective: Number(autoEffective) })
      }
    }
    await f.submitAndApprovePick(draft, [entry])
    assert.deepEqual(calls.map((item) => item.path),
      ['/mes/stkIo/edit/submit', ...(!autoEffective ? ['/mes/stkIo/check'] : [])])
    assert.equal(calls[0].body.stkIoEntryList[0].batchNo, entry.batchNo)
    assert.equal(calls[0].body.billStage, draft.billStage)
    assert.equal(calls[0].body.isEffective, draft.isEffective)
    assert.equal(calls[0].body.isVoided, draft.isVoided)
    assert.equal(calls[0].body.isClosed, draft.isClosed)
    assert.ok(!('actions' in calls[0].body))
    assert.ok(!('createBy' in calls[0].body))
    assert.ok(!('createBy' in calls[0].body.stkIoEntryList[0]))
    for (const foreign of [
      { ...entry, materialId: '99' }, { ...entry, warehouseId: '99' },
      { ...entry, wareAreaId: '99' }, { ...entry, wareLocationId: '99' }
    ]) await assert.rejects(() => f.submitAndApprovePick(draft, [foreign]), /本轮/)
    await assert.rejects(() => f.submitAndApprovePick(draft, []), /本轮/)
  }
})

test('production feed closes its formal chain and independently proves duplicate requests leave facts unchanged', async () => {
  const h = await harness({ fixture: { withFeed: true } })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  await h.fixture.prepareFeed(cr)
  assert.ok(cr.checks.every((item) => item.passed))
  const submitted = h.calls.findIndex((item) => item.path === '/mes/stkIo/edit/submit')
  const approved = h.calls.findIndex((item, index) =>
    index > submitted && item.path === '/mes/stkIo/check')
  assert.ok(submitted > 0 && approved > submitted)
  const evidence = cr.database.filter((item) => /duplicate/.test(item.stage))
  assert.equal(evidence.length, 6)
  assert.ok(h.sqlCalls.some((sql) => sql.includes("io.stock_io_type='203'") &&
    sql.includes('entry.tenant_id=1')))
  assert.ok(h.sqlCalls.some((sql) => sql.includes('FROM mes_prod_task_feed_record') &&
    sql.includes(`task_id='${h.fixture.tasks[0].id}'`)))
})

test('an HTTP business rejection cannot prove idempotency when new pick or feed facts appeared', async () => {
  for (const [options, checkName] of [
    [{ duplicatePickWrites: true }, '重复生成生产领料单被正式拒绝且不新增单据'],
    [{ duplicateFeedWrites: true }, '重复投料超过已领未投余额被正式拒绝']
  ]) {
    const h = await harness({ ...options, fixture: { withFeed: true } })
    const cr = caseRecord()
    await h.fixture.setup(cr)
    await h.fixture.prepareFeed(cr)
    assert.equal(cr.checks.find((item) => item.name === checkName).passed, false)
  }
  for (const feedFactsSnapshot of [
    { available: false, rows: [], reason: 'unit unavailable' },
    { available: true, rows: [] },
    { available: true, rows: [['not-valid']] }
  ]) {
    const h = await harness({ feedFactsSnapshot, fixture: { withFeed: true } })
    const cr = caseRecord()
    await h.fixture.setup(cr)
    await assert.rejects(() => h.fixture.prepareFeed(cr), /独立数据库|空集或无效事实/)
    assert.ok(!cr.checks.some((item) =>
      item.name === '重复生成生产领料单被正式拒绝且不新增单据'))
  }
})

test('missing route and team are isolated business refusals with no generated task', async () => {
  const h = await harness({ fixture: { withTeam: false } })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  assert.equal(h.fixture.missingRouteBlocked, true)
  assert.equal(h.fixture.scheduleBlocked, true)
  assert.equal(h.fixture.fixtureRecord.missingRoute.taskCount, 0)
  assert.deepEqual(h.fixture.tasks, [])
  assert.ok(cr.checks.every((item) => item.passed))
  await h.fixture.cleanup(cr)
  assert.equal(h.fixture.fixtureRecord.cleanup, 'VERIFIED')
})

test('shortage fixture voids only its own opening and requires a nonempty zero-stock material readback', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const material = await h.fixture.voidOpeningInventoryForShortage(cr)
  assert.equal(material.materialId, h.fixture.component.id)
  assert.equal(material.requiredQty, 2)
  assert.equal(material.stockQty, 0)
  const voidCount = h.calls.filter((call) => call.path === '/mes/stkIo/void').length
  await h.fixture.cleanup(cr)
  assert.equal(h.calls.filter((call) => call.path === '/mes/stkIo/void').length, voidCount)
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
  for (const options of [{ emptyFeedPreview: true }, { previewStockQty: 1 }]) {
    const invalid = await harness(options)
    await invalid.fixture.setup(caseRecord())
    await assert.rejects(() => invalid.fixture.voidOpeningInventoryForShortage(caseRecord()),
      /空集|仍有库存/)
  }
})

test('each production case retains its own fixture evidence across negative-chain construction', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const mainEvidence = cr.executionFixtures[0]
  const negative = new h.module.ExecutionWorkflowFixture(h.api, h.record, 'MES-PROD-001-NO-TEAM')
  assert.notEqual(h.record.executionFixture, mainEvidence)
  assert.equal(h.record.executionFixtures[0], mainEvidence)
  assert.equal(h.record.executionFixtures[1], negative.fixtureRecord)
  await h.fixture.cleanup(cr)
  assert.equal(mainEvidence.cleanup, 'VERIFIED')
  assert.equal(negative.fixtureRecord.cleanup, undefined)
})

test('cleanup failure retains the error and continues later owned-resource cleanup', async () => {
  const h = await harness({ voidWorkResponse: { code: 500, msg: 'unit void rejection' } })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const taskId = h.fixture.tasks[0].id
  const originalDelete = h.api.deleteBusiness
  h.api.deleteBusiness = async (path) => {
    if (path.endsWith(`id=${taskId}`)) throw new Error('unit task delete rejection')
    return originalDelete(path)
  }
  await assert.doesNotReject(() => h.fixture.cleanup(cr))
  assert.ok(cr.notes.some((note) => note.includes('unit task delete rejection')))
  assert.ok(cr.notes.some((note) => note.includes('unit void rejection')))
  assert.ok(h.rows.has(taskId))
  assert.ok(!h.rows.has(h.fixture.warehouse.id))
  assert.equal(h.record.executionFixture.cleanup, 'INCOMPLETE')
  assert.ok(cr.checks.some((check) => check.passed === false))
})

test('referenced warehouse is formally disabled and retained as audit evidence', async () => {
  const h = await harness({
    warehouseDeleteRejection: { code: 500, msg: '已被引用，不能删除！' }
  })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  await h.fixture.cleanup(cr)
  const warehouse = h.rows.get(h.fixture.warehouse.id)
  assert.ok(warehouse, '被审计历史引用的仓库必须保留')
  assert.equal(warehouse.isEnabled, false)
  assert.equal(h.fixture.warehouse.cleanup, 'RETAINED_AUDIT_DISABLED')
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
  assert.ok(cr.notes.some((note) => /停用并保留审计事实/.test(note)))
  assert.ok(cr.checks.some((check) =>
    check.passed && /停用并保留审计/.test(check.name)))
})

test('shared team-member lookup must include the local tenant, not just a hardcoded team ID', async () => {
  const h = await harness()
  await h.fixture.setup(caseRecord())
  const memberSql = h.sqlCalls.find((sql) => sql.includes('FROM mes_team_manage_sub'))
  assert.ok(memberSql, 'must use an actual member prerequisite')
  assert.match(memberSql, /tenant_id\s*=\s*1\b/, 'shared member must be tenant-scoped')
})

test('foreign work readback is never adopted, started or cleaned up as a fixture work', async () => {
  const h = await harness({
    fixture: { schedule: false },
    workReadback: { id: '91', prodOrderId: '92', remark: 'shared production' }
  })
  await assert.rejects(() => h.fixture.setup(caseRecord()), /所有权|专属|归属|ownership/i)
  assert.ok(!h.fixture.owned.some((item) => item.id === '91'),
    'foreign work must be rejected before being registered for negative requests or cleanup')
})

test('a task from another work cannot be edited even when product and routing match', async () => {
  const h = await harness({ taskReadback: { workTicketId: '92', remark: 'shared task' } })
  await assert.rejects(() => h.fixture.setup(caseRecord()), /所有权|专属|归属|ownership/i)
  const task = [...h.rows.values()].find((row) => row.table === 'task')
  assert.ok(!h.calls.some((item) => item.path === '/mes/prodWorkTask/edit' &&
    item.body.id === task.id), 'foreign task must not be modified')
})

test('cleanup business success without deletion readback cannot be reported as verified cleanup', async () => {
  const h = await harness({ keepDeletedRows: true })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const before = h.calls.length
  await h.fixture.cleanup(cr)
  const cleanup = h.calls.slice(before)
  const workId = h.fixture.works[0].id
  assert.ok(!cleanup.some((item) => item.method === 'GET' &&
    item.path === `/mes/prodWork/queryById?id=${workId}`),
  'cleanup must avoid the expected 500 missing-row detail request')
  assert.ok(cr.checks.some((check) => check.passed === false) ||
    cr.notes.some((note) => /残留|未清理|未删除|未完成/.test(note)),
  'a still-existing resource must be reported as retained/incomplete')
  assert.equal(h.record.executionFixture.cleanup, 'INCOMPLETE')
})

test('cleanup accepts exact tenant-scoped logical deletion evidence, not just physical disappearance', async () => {
  const h = await harness({ softDeleteRows: true })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  await h.fixture.cleanup(cr)
  for (const resource of h.fixture.owned) {
    if (resource.kind === 'opening') {
      assert.equal(resource.cleanup, 'VOIDED_RETAINED')
      assert.equal(h.rows.get(resource.id).isVoided, 1)
    } else {
      const row = h.rows.get(resource.id)
      if (resource.kind === 'task' && !row) continue
      assert.equal(resource.kind === 'task' ? row.isDeleted : row.deleted, 1)
      assert.equal(resource.cleanup, 'DELETED_VERIFIED')
    }
  }
  assert.ok(cr.database.filter((item) => item.stage === 'execution-cleanup')
    .every((item) => item.rows.length === 0 ||
      (item.rows.length === 1 && item.rows[0][1] === '1')))
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
})

test('an API missing-row error is not deletion proof without valid independent SQL', async () => {
  for (const cleanupSnapshot of [
    { available: false, reason: 'unit cleanup SQL unavailable' },
    { available: true, rows: [['foreign-id', '1']] },
    { available: true, rows: [['9223372036854775012', 'invalid']] }
  ]) {
    const h = await harness({ cleanupSnapshot, deletedWorkError: 'unit query system exception' })
    const cr = caseRecord()
    await h.fixture.setup(cr)
    await h.fixture.cleanup(cr)
    assert.equal(h.record.executionFixture.cleanup, 'INCOMPLETE')
    assert.ok(cr.checks.some((check) => check.passed === false))
    assert.ok(cr.notes.some((note) => /残留|未清理|未完成/.test(note)))
  }
})

test('cleanup never writes an unregistered or foreign resource, even if its ID is injected', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const material = h.fixture.owned.find((item) => item.kind === 'material')
  const foreign = h.rows.get(material.id)
  foreign.remark = 'shared material'
  h.fixture.works.push({ id: '91', prodOrderId: '92', remark: 'shared work' })
  const before = h.calls.length
  await h.fixture.cleanup(cr)
  const writes = h.calls.slice(before).filter((item) => item.method !== 'GET')
  assert.ok(!writes.some((item) => item.body?.id === '91' ||
    new URL(item.path, 'http://unit').searchParams.get('id') === '91'))
  assert.ok(!writes.some((item) => item.body?.id === material.id ||
    new URL(item.path, 'http://unit').searchParams.get('id') === material.id))
  assert.ok(h.rows.has(material.id))
  assert.equal(h.record.executionFixture.cleanup, 'INCOMPLETE')
})

test('material BOM cleanup sends an explicit validation whitelist without audit, price or user fields', async () => {
  const h = await harness()
  const cr = caseRecord()
  await h.fixture.setup(cr)
  const material = h.fixture.material
  const row = h.rows.get(material.id)
  Object.assign(row, {
    defaultProdBom: h.fixture.bom.id, createBy: 'shared-user', updateBy: 'shared-user',
    customField1: 'user data', refCost: 123, tenantId: '1'
  })
  const before = structuredClone(row)
  await h.fixture.cleanup(cr)
  const edit = h.calls.find((item) => item.path === '/mes/basMaterial/edit')
  assert.ok(edit, 'must exercise the actual BOM clearing write')
  assert.deepEqual(Object.keys(edit.body).sort(), [
    'id', 'code', 'name', 'auxName', 'model', 'type', 'unitId', 'inventoryNature',
    'purchased', 'produced', 'saled', 'parented', 'isMaterial', 'assembled',
    'batchManaged', 'periodManaged', 'periodDays', 'colorManaged', 'brandManaged',
    'oneBarcode', 'leadTime', 'bufferTime', 'defaultProdBom',
    'defaultWare', 'defaultWareArea', 'defaultWareLocation'
  ].sort())
  assert.equal(edit.body.id, material.id)
  assert.equal(edit.body.defaultProdBom, '')
  for (const key of Object.keys(edit.body).filter((key) =>
    !['defaultProdBom', 'defaultWare', 'defaultWareArea', 'defaultWareLocation'].includes(key))) {
    assert.equal(edit.body[key], before[key])
  }
  assert.equal(edit.body.defaultWare, '')
  assert.equal(edit.body.defaultWareArea, '')
  assert.equal(edit.body.defaultWareLocation, '')
  assert.ok(!Object.keys(edit.body).some((key) =>
    ['remark', 'createBy', 'updateBy', 'tenantId', 'customField1', 'refCost'].includes(key)))
  assert.equal(h.record.executionFixture.cleanup, 'VERIFIED')
})

test('opening inventory code=0 without a voided readback remains incomplete', async () => {
  const h = await harness({ ignoreVoid: true })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  await h.fixture.cleanup(cr)
  assert.equal(h.fixture.opening.cleanup, 'RETAINED_UNVERIFIED')
  assert.equal(h.record.executionFixture.cleanup, 'INCOMPLETE')
  assert.ok(cr.checks.some((check) => !check.passed && /opening/.test(check.name)))
  assert.ok(h.rows.has(h.fixture.opening.id))
})

test('non-zero inventory facts are retained and never deleted during cleanup', async () => {
  const h = await harness({ retainInventoryQty: true })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  await h.fixture.cleanup(cr)
  const inventory = h.rows.get(h.fixture.inventory.id)
  assert.ok(inventory, '非零库存事实必须保留')
  assert.equal(inventory.qty, 4)
  assert.equal(h.fixture.inventory.cleanup, 'RETAINED_UNVERIFIED')
  assert.ok(!h.calls.some((item) => item.path === `/mes/stkInventory/delete?id=${h.fixture.inventory.id}`))
  assert.equal(h.record.executionFixture.cleanup, 'INCOMPLETE')
  assert.ok(cr.notes.some((note) => /库存事实仍有非零分量/.test(note)))
})

test('material edit code=0 without a cleared BOM readback remains incomplete', async () => {
  const h = await harness({ ignoreMaterialEdit: true })
  const cr = caseRecord()
  await h.fixture.setup(cr)
  h.rows.get(h.fixture.material.id).defaultProdBom = h.fixture.bom.id
  await h.fixture.cleanup(cr)
  assert.equal(h.record.executionFixture.cleanup, 'INCOMPLETE')
  assert.ok(cr.checks.some((check) => !check.passed && /默认生产 BOM/.test(check.name)))
  assert.ok(cr.notes.some((note) => /默认生产 BOM 未清空/.test(note)))
})

test('work and task ownership reject independently drifting IDs, parents, markers and tenants', async () => {
  for (const workReadback of [
    { id: null }, { id: Number.MAX_SAFE_INTEGER + 1 }, { prodOrderId: '92' },
    { remark: 'shared work' }, { tenantId: '2' }
  ]) {
    const h = await harness({ workReadback })
    await assert.rejects(() => h.fixture.setup(caseRecord()), /所有权|专属/)
    assert.equal(h.fixture.works.length, 0)
    assert.ok(!h.calls.some((item) =>
      ['/mes/prodWork/edit', '/mes/prodWork/scheduleProduct', '/mes/prodWork/start'].includes(item.path)))
  }
  for (const taskReadback of [
    { id: null }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { workTicketId: '92' }, { productId: '93' }, { routing: '94' }, { tenantId: '2' }
  ]) {
    const h = await harness({ taskReadback })
    await assert.rejects(() => h.fixture.setup(caseRecord()), /所有权|专属/)
    assert.equal(h.fixture.tasks.length, 0)
    assert.ok(!h.calls.some((item) => item.path === '/mes/prodWorkTask/edit'))
  }
})
