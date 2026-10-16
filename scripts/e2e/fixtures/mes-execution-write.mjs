import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { asList, assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { createPlan, createPublishedItem } from './mes-quality-write.mjs'

const unwrap = (response, label = 'MES execution fixture') => {
  assertBusinessSuccess(response, label)
  return response && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

const rowsOf = (response, label = 'MES execution list') => asList(unwrap(response, label))

const sqlText = (value) => String(value).replaceAll("'", "''")

const stableId = (value) =>
  (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
  /^[1-9]\d*$/.test(String(value))

const cleanupDefinitions = {
  report: { table: 'mes_prod_work_report', endpoint: '/mes/prodWorkReport/delete' },
  task: { table: 'mes_prod_work_task', endpoint: '/mes/prodWorkTask/delete', deletedColumn: 'is_deleted' },
  work: { table: 'mes_prod_work', endpoint: '/mes/prodWork/delete' },
  order: { table: 'mes_prod_order', endpoint: '/mes/prodOrder/delete' },
  opening: { table: 'mes_stk_io', endpoint: '/mes/stkIo/void' },
  pickBill: { table: 'mes_stk_io', endpoint: '/mes/stkIo/void' },
  output: { table: 'mes_stk_io', endpoint: '/mes/stkIo/void' },
  inventory: { table: 'mes_stk_inventory', endpoint: '/mes/stkInventory/delete' },
  route: { table: 'mes_wms_tech_route', endpoint: '/mes/wmsTechRoute/delete' },
  procedure: { table: 'mes_wms_procedure', endpoint: '/mes/wmsProcedure/delete' },
  bom: { table: 'mes_wms_assemble', endpoint: '/mes/wmsAssemble/delete' },
  material: { table: 'mes_bas_material', endpoint: '/mes/basMaterial/delete' },
  location: { table: 'mes_wms_house_location', endpoint: '/mes/wms-house-location/delete' },
  area: { table: 'mes_wms_house_area', endpoint: '/mes/wmsHouseArea/delete' },
  warehouse: { table: 'mes_wms_ware_house', endpoint: '/mes/wmsWareHouse/delete' },
  team: { table: 'mes_team_manage', endpoint: '/mes/teamManage/delete' },
  qualityItem: { table: 'mes_quality_item', endpoint: '/mes/quality/item/delete' },
  qualityPlan: { table: 'mes_quality_plan', endpoint: '/mes/quality/qualityPlan/delete' },
  qualityBinding: {
    table: 'mes_procedure_quality_item',
    endpoint: '/mes/procedure-quality-item/delete'
  },
  qualityInspection: {
    table: 'mes_quality_inspection',
    endpoint: '/mes/quality/qualityInspection/delete'
  }
}

const productionTime = (time = new Date()) => {
  const date = new Date(time)
  assert(Number.isFinite(date.getTime()), 'Invalid production date')
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(date)
}

const addCheck = (caseRecord, name, passed, details = '') => {
  const check = { name, passed: Boolean(passed), details: String(details) }
  caseRecord.checks.push(check)
  return check
}

const queryId = async (sql, context) => {
  const result = await runReadOnlySql(sql)
  if (!result.available) throw new Error(`BLOCKED: ${result.reason}`)
  assert.equal(result.rows.length, 1, `${context} 所有权回读必须唯一`)
  return String(result.rows[0][0])
}

const queryRows = async (sql, context) => {
  const result = await runReadOnlySql(sql)
  if (!result.available) throw new Error(`BLOCKED: ${result.reason}`)
  assert(result.rows.length > 0, `${context} 所有权回读不能为空`)
  return result.rows
}

const isZeroQuantity = (value) =>
  value == null || (Number.isFinite(Number(value)) && Number(value) === 0)

export const executionMarker = (caseId) =>
  `AUTOTEST-${caseId}-${Date.now().toString(36).slice(-6).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`

/**
 * 为任务暂停和监控用例创建一条独立的生产计划-工单-任务链路。
 *
 * 数据只通过正式 API 写入，统一使用 AUTOTEST-<catalog-id>-* 标记；清理时优先
 * 走业务删除/取消接口，接口拒绝时保留数据并在报告中写明残留。
 */
export class ExecutionWorkflowFixture {
  constructor (api, record, caseId, {
    overdue = false,
    schedule = true,
    withTeam = true,
    withOpeningInventory = true,
    separateOpeningLocation = false,
    normalizeWmsOutputCleanup = false,
    reuseEnabledBom = false,
    withFeed = false,
    withQuality = false
  } = {}) {
    this.api = api
    this.record = record
    this.caseId = caseId
    this.marker = executionMarker(caseId)
    this.shortCode = `AT-${caseId.replaceAll('-', '').slice(0, 12)}-${Date.now().toString(36).slice(-5).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
    // 班组编码必须跨运行唯一；只用 1 字节随机会在历史残留后偶发重号，导致所有权回读不唯一。
    const teamSuffix = `${Date.now().toString(36).slice(-5).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`
    this.teamCode = `AT-${caseId.split('-').pop()}-${teamSuffix}-T`
    this.teamName = `AUTOTEST-${caseId.split('-').pop()}-${teamSuffix}`
    this.overdue = overdue
    this.shouldSchedule = schedule
    this.withTeam = withTeam
    this.withOpeningInventory = withOpeningInventory
    this.separateOpeningLocation = separateOpeningLocation
    this.normalizeWmsOutputCleanupEnabled = normalizeWmsOutputCleanup
    this.reuseEnabledBom = reuseEnabledBom
    this.withFeed = withFeed
    this.withQuality = withQuality
    this.owned = []
    this.works = []
    this.tasks = []
    this.reportIds = []
    this.outputIds = []
    this.feedRecordIds = []
    this.qualityInspectionIds = []
    this.scheduleBlocked = false
    this.fixtureRecord = {
      caseId,
      marker: this.marker,
      overdue,
      schedule,
      withTeam,
      withOpeningInventory,
      separateOpeningLocation,
        normalizeWmsOutputCleanup,
      reuseEnabledBom,
      withFeed,
      withQuality,
      resources: this.owned
    }
    this.record.executionFixture = this.fixtureRecord
    this.record.executionFixtures = [...(this.record.executionFixtures || []), this.fixtureRecord]
  }

  remember (kind, id, identity = '') {
    assert(stableId(id), `专属 ${kind} 所有权主键无效`)
    const resource = { kind, id: String(id), identity, marker: this.marker }
    this.owned.push(resource)
    return resource
  }

  assertOwnedWork (work, expectedId = work?.id) {
    assert(stableId(work?.id) && String(work.id) === String(expectedId),
      '专属工单所有权主键不匹配')
    assert(this.order && String(work.prodOrderId) === this.order.id,
      '专属工单所有权不属于本轮生产计划')
    assert.equal(work.remark, this.marker, '专属工单所有权标记不匹配')
    if (work.tenantId != null) assert.equal(String(work.tenantId), '1', '专属工单租户不匹配')
    return work
  }

  assertOwnedTask (task, expectedId = task?.id) {
    const work = this.assertOwnedWork(this.works[0])
    assert(stableId(task?.id) && String(task.id) === String(expectedId),
      '专属任务所有权主键不匹配')
    assert.equal(String(task.workTicketId), work.id, '专属任务所有权不属于本轮工单')
    assert.equal(String(task.productId), this.material.id, '专属任务物料不匹配')
    assert.equal(String(task.routing), this.route.id, '专属任务工艺路线不匹配')
    if (task.tenantId != null) assert.equal(String(task.tenantId), '1', '专属任务租户不匹配')
    return task
  }

  async setup (caseRecord) {
    caseRecord.executionFixtures = [...(caseRecord.executionFixtures || []), this.fixtureRecord]
    assert.equal(config.target, 'local')
    assert.equal(String(config.tenantId), '1')
    assert.equal(config.db.name, 'cfor_admin_standard')
    await assertLocalWriteSafety(caseRecord)

    const unitRows = rowsOf(await this.api.getBusiness('/mes/basUnit/list/enabled'), '启用计量单位')
    const unit = unitRows.find((row) => row?.id)
    assert(unit?.id, 'BLOCKED: 没有可复用计量单位')
    this.unit = unit

    const workplaces = rowsOf(await this.api.getBusiness('/mes/monitor/workplaces'), '车间列表')
    const workplace = workplaces.find((row) => row?.id)
    assert(workplace?.id, 'BLOCKED: 当前账号没有可见车间')
    this.workplace = workplace
    this.lineId = await queryId(
      `SELECT id FROM mes_work_line
       WHERE tenant_id=1 AND deleted=0 AND work_place_id='${sqlText(workplace.id)}'
       ORDER BY id LIMIT 1`,
      '车间产线'
    )

    this.warehouse = await this.createWarehouse()
    this.area = await this.createArea()
    this.location = await this.createLocation()
    this.openingLocation = this.separateOpeningLocation && this.withOpeningInventory
      ? await this.createLocation('OP')
      : null
    if (this.reuseEnabledBom) {
      await this.selectEnabledBom()
    } else {
      this.material = await this.createMaterial('FG', false)
      this.component = await this.createMaterial('RM', true)
      this.bom = await this.createBom()
    }
    // Production execution cases do not need stock facts; WMS suites own the
    // opening-inventory lifecycle and its audit-retained rows.
    this.opening = this.withOpeningInventory
      ? await this.createOpeningInventory()
      : null
    this.procedure = await this.createProcedure()
    if (this.withQuality) {
      await this.createQualityConfiguration(caseRecord)
    }
    this.route = await this.createRoute()
    this.order = await this.createOrder()
    await this.approveAndSplit()
    if (this.shouldSchedule) {
      await this.scheduleTask()
    }
    const chainReady = this.owned.length >= 8 && this.works.length === 1 &&
      (this.withTeam
        ? (!this.shouldSchedule || this.tasks.length === 1)
        : (this.shouldSchedule && this.tasks.length === 0 && this.scheduleBlocked))
    addCheck(caseRecord, '专属 AUTOTEST 生产链路已正式创建并回读',
      chainReady,
      JSON.stringify({
        marker: this.marker,
        orderId: this.order.id,
        workId: this.works[0]?.id,
        taskId: this.tasks[0]?.id,
        scheduled: this.shouldSchedule,
        scheduleBlocked: this.scheduleBlocked
      }))
    return this
  }

  async selectEnabledBom () {
    const rows = await runReadOnlySql(
      `SELECT bom.id, bom.code, bom.stock_id, parent.unit_id, parent.code,
              sub.stock_id, child.unit_id, child.code
       FROM mes_wms_assemble bom
       JOIN mes_bas_material parent ON parent.id=bom.stock_id
       JOIN mes_wms_assemble_sub sub ON sub.parent_id=bom.id
       JOIN mes_bas_material child ON child.id=sub.stock_id
       WHERE bom.tenant_id=1 AND bom.deleted=0 AND bom.dev_status=2
         AND bom.bom_usage='PRODUCTION'
         AND parent.tenant_id=1 AND parent.deleted=0 AND parent.is_enabled=1
         AND parent.inventory_nature='STOCK'
         AND child.tenant_id=1 AND child.deleted=0 AND child.is_enabled=1
         AND child.inventory_nature='STOCK'
       ORDER BY bom.update_time DESC, bom.id DESC LIMIT 1`
    )
    if (!rows.available) throw new Error(`BLOCKED: ${rows.reason}`)
    if (!Array.isArray(rows.rows) || rows.rows.length !== 1) {
      throw new Error('BLOCKED: 缺少可复用的已启用生产 BOM 及实物母子件')
    }
    const [bomId, bomCode, materialId, materialUnitId, materialCode,
      componentId, componentUnitId, componentCode] = rows.rows[0]
    for (const [label, value] of [
      ['BOM', bomId], ['母件', materialId], ['母件单位', materialUnitId],
      ['子件', componentId], ['子件单位', componentUnitId]
    ]) {
      if (!stableId(value)) throw new Error(`BLOCKED: 已启用生产 BOM ${label}主键无效`)
    }
    this.material = {
      id: String(materialId), unitId: String(materialUnitId), identity: String(materialCode),
      shared: true
    }
    this.component = {
      id: String(componentId), unitId: String(componentUnitId), identity: String(componentCode),
      shared: true
    }
    this.bom = { id: String(bomId), identity: String(bomCode), shared: true, devStatus: 2 }
    this.fixtureRecord.enabledBom = {
      bomId: this.bom.id,
      bomCode: this.bom.identity,
      materialId: this.material.id,
      componentId: this.component.id,
      devStatus: 2
    }
  }

  async createWarehouse () {
    const code = `${this.shortCode}-WH`
    await this.api.postBusiness('/mes/wmsWareHouse/add', {
      code,
      name: `${this.marker}-仓库`,
      mark: this.marker,
      pid: '0',
      isEnabled: true,
      areaEnabled: true,
      locationEnabled: true,
      countInAvailable: true
    })
    const id = await queryId(
      `SELECT id FROM mes_wms_ware_house
       WHERE tenant_id=1 AND deleted=0 AND code='${sqlText(code)}' AND mark='${sqlText(this.marker)}'`,
      '专属仓库'
    )
    return this.remember('warehouse', id, code)
  }

  async createArea () {
    const code = `${this.shortCode}-AR`
    await this.api.postBusiness('/mes/wmsHouseArea/add', {
      areaCode: code,
      areaName: `${this.marker}-库区`,
      houseId: this.warehouse.id,
      isEnabled: true,
      remark: this.marker
    })
    const id = await queryId(
      `SELECT id FROM mes_wms_house_area
       WHERE tenant_id=1 AND deleted=0 AND area_code='${sqlText(code)}' AND remark='${sqlText(this.marker)}'`,
      '专属库区'
    )
    return this.remember('area', id, code)
  }

  async createLocation (suffix = '') {
    const code = `${this.shortCode}-${suffix || 'LC'}`
    await this.api.postBusiness('/mes/wms-house-location/create', {
      locationName: `${this.marker}-${suffix ? '期初库位' : '库位'}`,
      locationCode: code,
      houseId: this.warehouse.id,
      areaId: this.area.id,
      isEnabled: true,
      locationType: 1,
      remark: this.marker
    })
    const id = await queryId(
      `SELECT id FROM mes_wms_house_location
       WHERE tenant_id=1 AND deleted=0 AND location_code='${sqlText(code)}' AND remark='${sqlText(this.marker)}'`,
      '专属库位'
    )
    return this.remember('location', id, code)
  }

  async createMaterial (suffix, component) {
    const code = `${this.shortCode}-${suffix}`
    await this.api.postBusiness('/mes/basMaterial/add', {
      code,
      name: `${this.marker}-${suffix}`,
      auxName: `${this.marker}-${suffix}`,
      unitId: String(this.unit.id),
      remark: this.marker,
      isEnabled: 1,
      inventoryNature: 'STOCK',
      virtualGoods: 'N',
      defaultWare: this.warehouse.id,
      defaultWareArea: this.area.id,
      defaultWareLocation: this.location.id,
      source: component ? 'purchase' : 'mixed',
      produced: component ? 'N' : 'Y',
      purchased: 'Y',
      saled: 'Y',
      parented: component ? 'N' : 'Y',
      isMaterial: component ? 'Y' : 'N',
      assembled: 'N',
      soned: 'N',
      batchManaged: 'N',
      oneBarcode: 'N',
      periodManaged: 'N',
      gradeManaged: 'N',
      colorManaged: 'N',
      brandManaged: 'N',
      backflush: 'N',
      leadTime: 1,
      bufferTime: 1,
      refCost: 10,
      refPrice: 20
    })
    const id = await queryId(
      `SELECT id FROM mes_bas_material
       WHERE tenant_id=1 AND deleted=0 AND code='${sqlText(code)}' AND remark='${sqlText(this.marker)}'`,
      '专属物料'
    )
    return this.remember('material', id, code)
  }

  async createBom () {
    const code = this.shortCode
    await this.api.postBusiness('/mes/wmsAssemble/add', {
      code,
      stockId: this.material.id,
      stockCount: 1,
      version: '1',
      versionDesc: this.marker,
      defaultRecord: 'Y',
      bomUsage: 'PRODUCTION',
      unitId: String(this.unit.id),
      mark: this.marker,
      wmsAssembleSubList: [{
        stockId: this.component.id,
        subStockCount: 1,
        unitId: String(this.unit.id),
        lossRate: 0,
        mark: this.marker
      }]
    })
    const id = await queryId(
      `SELECT id FROM mes_wms_assemble
       WHERE tenant_id=1 AND deleted=0 AND code='${sqlText(code)}' AND mark='${sqlText(this.marker)}'`,
      '专属 BOM'
    )
    await unwrap(
      await this.api.postBusiness(`/mes/wmsAssemble/publish?id=${encodeURIComponent(id)}`),
      '发布专属 BOM'
    )
    const published = unwrap(
      await this.api.getBusiness(`/mes/wmsAssemble/queryById?id=${encodeURIComponent(id)}`),
      '回读已发布专属 BOM'
    )
    assert.equal(Number(published?.devStatus), 2, '专属 BOM 发布后研发状态必须为已启用')
    return this.remember('bom', id, code)
  }

  async createOpeningInventory () {
    const billNo = `${this.shortCode}-OP`
    const submit = await this.api.postBusiness('/mes/stkIo/add/submit', {
      billNo,
      billDate: new Date().toISOString().slice(0, 10),
      subject: `${this.marker} opening inventory`,
      remark: this.marker,
      stockIoType: '106',
      isAuto: 0,
      stkIoEntryList: [{
        materialId: this.component.id,
        unitId: String(this.unit.id),
        qty: 4,
        cost: 1,
        warehouseId: this.warehouse.id,
        wareAreaId: this.area.id,
        wareLocationId: (this.openingLocation || this.location).id,
        batchNo: `${this.shortCode}-OPEN`,
        entryNo: 1,
        stockIoType: '106',
        stockIoDirection: '1',
        isQc: 0,
        settleQty: 4
      }],
      stkIoDistributionList: [],
      stkIoBomList: []
    })
    const id = String(unwrap(submit, '期初库存提交'))
    const resource = this.remember('opening', id, billNo)
    let detail = unwrap(await this.api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(id)}`
    ), '期初库存回读')
    if (Number(detail?.isEffective || 0) !== 1) {
      unwrap(await this.api.putBusiness('/mes/stkIo/check', {
        id,
        approvalResultType: '1',
        approvalRemark: `${this.marker} opening`
      }), '期初库存审核')
      detail = unwrap(await this.api.getBusiness(
        `/mes/stkIo/queryById?id=${encodeURIComponent(id)}`
      ), '期初库存审核后回读')
    }
    assert.equal(Number(detail?.isEffective || 0), 1, '专属期初库存必须正式生效')
    const inventoryRows = await queryRows(
      `SELECT id, warehouse_id, material_id, ware_area_id, ware_location_id, batch_no,
              qty, available_qty, lock_qty, hold_qty, frozen_qty, pending_putaway_qty,
              deleted+0, is_closed
       FROM mes_stk_inventory
       WHERE tenant_id=1 AND deleted=0 AND is_closed=0
         AND warehouse_id='${sqlText(this.warehouse.id)}'
         AND material_id='${sqlText(this.component.id)}'
         AND ware_area_id='${sqlText(this.area.id)}'
         AND ware_location_id='${sqlText((this.openingLocation || this.location).id)}'
         AND batch_no='${sqlText(`${this.shortCode}-OPEN`)}'`,
      '专属期初库存事实'
    )
    assert.equal(inventoryRows.length, 1, '专属期初库存必须只生成一条库存事实')
    const [inventoryId, warehouseId, materialId, wareAreaId, wareLocationId, batchNo] =
      inventoryRows[0]
    assert.equal(String(warehouseId), this.warehouse.id, '专属库存仓库归属不匹配')
    assert.equal(String(materialId), this.component.id, '专属库存物料归属不匹配')
    const inventory = this.remember('inventory', inventoryId, batchNo)
    inventory.dimensions = {
      warehouseId: String(warehouseId),
      materialId: String(materialId),
      wareAreaId: String(wareAreaId),
      wareLocationId: String(wareLocationId),
      batchNo: String(batchNo)
    }
    this.inventory = inventory
    return resource
  }

  async createProcedure () {
    const code = `${this.shortCode}-PC`
    const teamIds = this.withTeam ? await this.ensureTeam() : ''
    await this.api.postBusiness('/mes/wmsProcedure/add', {
      code,
      name: `${this.marker}-PROC`,
      mark: this.marker,
      workshopId: this.workplace.id,
      productionLineId: this.lineId,
      baseHours: 1,
      basePrice: 0,
      pieceRate: 0,
      hourlyWage: 0,
      reportBaseQuantity: 1,
      overPlanReportRatio: 0,
      beforeIntervalTimes: 0,
      afterIntervalTimes: 0,
      bufferTime: 0,
      procedureRelation: 'ES',
      isLastProcess: 'Y',
      pid: '0',
      hasChild: 'N',
      teamIds,
      defaultTeam: '',
      chargePersonId: ''
    })
    const id = await queryId(
      `SELECT id FROM mes_wms_procedure
       WHERE tenant_id=1 AND deleted=0 AND code='${sqlText(code)}' AND mark='${sqlText(this.marker)}'`,
      '专属工序'
    )
    return this.remember('procedure', id, code)
  }

  async createQualityConfiguration (caseRecord) {
    const item = await createPublishedItem(this.api, caseRecord, {
      kind: 'MES-PROD',
      itemType: '生产过程检验项目',
      unitId: this.unit.id,
      inspectionResultType: 'select',
      inspectionResult: '1',
      judgmentMode: 'ENUM',
      standardBaseValue: 1
    })
    const plan = await createPlan(this.api, caseRecord, {
      kind: 'MES-PROD',
      type: 300,
      itemId: item.itemId,
      itemSnapshot: item.row,
      planName: `${this.marker}-QC-PLAN`,
      publish: true
    })
    this.qualityItem = this.remember('qualityItem', item.itemId, item.itemCode)
    this.qualityPlan = this.remember('qualityPlan', plan.planId, plan.planCode)
    this.qualityConfig = { item, plan }

    unwrap(await this.api.postBusiness('/mes/wmsTechRoute/batchCreateProcedureQuality', [{
      procedureId: this.procedure.id,
      qualityPlanId: plan.planId,
      qualityItemId: item.itemId,
      isRequired: 'Y',
      frequency: '每批',
      target: '100%',
      sortOrder: 1,
      status: '1',
      remark: this.marker
    }]), '绑定专属工序过程检项目')
    const bindings = rowsOf(await this.api.getBusiness(
      `/mes/procedure-quality-item/page?pageNo=1&pageSize=100&procedureId=${encodeURIComponent(this.procedure.id)}`
    ), '工序过程检绑定回读')
    const binding = bindings.find((row) =>
      String(row?.procedureId) === this.procedure.id &&
      String(row?.qualityPlanId) === String(plan.planId) &&
      String(row?.qualityItemId) === String(item.itemId) &&
      row?.isRequired === 'Y'
    )
    assert(binding?.id, '专属工序过程检绑定未回读')
    this.qualityBinding = this.remember('qualityBinding', binding.id, this.procedure.id)
    this.fixtureRecord.quality = {
      itemId: String(item.itemId),
      planId: String(plan.planId),
      bindingId: String(binding.id),
      type: 300,
      required: true
    }
  }

  /**
   * 创建一条带真实成员的专属班组，供排产/预排产班组门禁使用。
   * 成员复用系统内置管理员，避免污染其它业务数据。
   */
  async ensureTeam () {
    const teamId = this.teamCode
    const memberId = await queryId(
      `SELECT member_id FROM mes_team_manage_sub
       WHERE tenant_id=1 AND deleted=0 AND mid='2106210108690620417'
       ORDER BY id LIMIT 1`,
      '可复用班组人员'
    )
    await this.api.postBusiness('/mes/teamManage/add', {
      teamId,
      teamName: this.teamName,
      teamType: 1,
      status: '0',
      remark: teamId,
      leaderId: memberId,
      shiftStartTime: '08:00:00',
      shiftEndTime: '17:00:00',
      workPlaceId: this.workplace.id,
      teamManageSubList: [{
        memberId,
        memberName: `${this.marker}-成员`
      }]
    })
    const id = await queryId(
      `SELECT id FROM mes_team_manage
       WHERE tenant_id=1 AND deleted=0 AND team_id='${sqlText(teamId)}' AND remark='${sqlText(teamId)}'`,
      '专属班组'
    )
    this.team = this.remember('team', id, teamId)
    this.memberId = String(memberId)
    return id
  }

  async createRoute () {
    const code = `${this.shortCode}-RT`
    await this.api.postBusiness('/mes/wmsTechRoute/addMain', {
      code,
      name: `${this.marker}-ROUTE`,
      version: 'V1.0',
      mark: this.marker,
      type: '1',
      designMode: 'sequential',
      inboundType: 'FINISHED',
      isStrict: 'Y',
      wmsTechRouteSubList: [{
        procedureId: this.procedure.id,
        procedureName: this.procedure.identity,
        sortOrder: 1,
        isFeed: this.withFeed ? 1 : 0,
        isQuality: this.withQuality ? 1 : 0,
        isFinished: 1,
        isVirtual: 0,
        mark: this.marker
      }]
    })
    const id = await queryId(
      `SELECT id FROM mes_wms_tech_route
       WHERE tenant_id=1 AND deleted=0 AND code='${sqlText(code)}' AND mark='${sqlText(this.marker)}'`,
      '专属工艺路线'
    )
    return this.remember('route', id, code)
  }

  async createOrder () {
    const prodNo = this.shortCode
    const start = this.overdue ? Date.now() - 5 * 3600000 : Date.now() + 3600000
    const end = this.overdue ? Date.now() - 3 * 3600000 : Date.now() + 5 * 3600000
    await this.api.postBusiness('/mes/prodOrder/add', {
      prodNo,
      billNo: prodNo,
      prodType: '1',
      remark: this.marker,
      expectStartDate: productionTime(start),
      expectEndDate: productionTime(end),
      prodOrderSubList: [{
        materialId: this.material.id,
        qty: 2,
        wmsAssembleId: this.bom.id,
        remark: this.marker,
        urgentLevel: '1'
      }],
      prodOrderMaterialList: [{
        materialId: this.component.id,
        unitId: String(this.unit.id),
        bomNum: 1,
        quantity: 2,
        claimed: 0,
        requested: 0,
        afterSaveClaimed: 0,
        afterSaveRequested: 0,
        remark: this.marker
      }]
    })
    const id = await queryId(
      `SELECT id FROM mes_prod_order
       WHERE tenant_id=1 AND deleted=0
       AND bill_no='${sqlText(prodNo)}' AND remark='${sqlText(this.marker)}'`,
      '专属生产计划'
    )
    return this.remember('order', id, prodNo)
  }

  async approveAndSplit () {
    unwrap(await this.api.putBusiness('/mes/prodOrder/check', {
      id: this.order.id,
      approvalResultType: '1',
      approvalRemark: this.marker
    }), '生产计划审核')
    const subs = rowsOf(await this.api.getBusiness(
      `/mes/prodOrder/queryMesProdOrderSubByMainId?id=${encodeURIComponent(this.order.id)}`
    ), '生产计划子表')
    assert(subs[0]?.id, '专属生产计划没有子表')
    const body = [{
      prodOrderId: this.order.id,
      prodOrderSubId: String(subs[0].id),
      qty: 2,
      prodType: '1',
      operateType: 1,
      batchNo: `${this.marker}-B1`
    }]
    unwrap(await this.api.postBusiness('/mes/prodWork/transferWorkOrder', body), '生产订单转工单')
    const works = rowsOf(await this.api.getBusiness(
      `/mes/prodWork/getWorkByProdOrderId?prodOrderId=${encodeURIComponent(this.order.id)}`
    ), '生产工单回读')
    assert.equal(works.length, 1, '专属生产计划应只拆出一张工单')
    this.assertOwnedWork(works[0])
    this.works = works.map((work) => ({ ...work, id: String(work.id) }))
    this.remember('work', this.works[0].id, this.works[0].workTicketNo)
  }

  async scheduleTask () {
    const work = this.assertOwnedWork(this.works[0])
    assert.ok(this.route.id, '专属工艺路线未创建')
    if (!this.withTeam) {
      const missingRoute = { code: 500, message: /未找到工艺路线/, allowServiceCode: true }
      const rejected = await this.api.request('POST', '/mes/prodWork/scheduleProduct', {
        id: work.id,
        prodWorkOrderId: work.id,
        qty: 2,
        startDate: productionTime(Date.now() + 3600000),
        endDate: productionTime(Date.now() + 5 * 3600000),
        remark: this.marker
      }, { expectedBusinessRejection: missingRoute })
      assert.equal(rejected?.code, missingRoute.code, '未配工艺排产必须被正式拒绝')
      assert.match(String(rejected?.msg || rejected?.message || ''), missingRoute.message)
      const tasks = rowsOf(await this.api.getBusiness(
        `/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=${encodeURIComponent(work.id)}`
      ), '未配工艺排产拒绝后任务回读')
      assert.equal(tasks.length, 0, '未配工艺排产失败后不能留下孤立任务')
      this.fixtureRecord.missingRoute = { workId: work.id, response: rejected, taskCount: tasks.length }
      this.missingRouteBlocked = true
    }
    unwrap(await this.api.putBusiness('/mes/prodWork/edit', {
      id: work.id,
      processId: this.route.id
    }), '生产工单绑定工艺路线')
    if (!this.withTeam) {
      // 工序未配置班组时必须被预排产门禁明确阻断。
      const preSchedule = await this.api.request(
        'GET',
        `/mes/prodWork/preScheduleProduct?processId=${encodeURIComponent(this.route.id)}&workId=${encodeURIComponent(work.id)}`,
        undefined,
        { expectedBusinessRejection: { code: 500, message: /班组信息有误/, allowServiceCode: true } }
      )
      assert.equal(preSchedule?.code, 500, '未配置班组时预排产必须返回业务错误')
      assert.match(String(preSchedule?.msg || preSchedule?.message || ''), /班组/)
      this.scheduleBlocked = true
      this.fixtureRecord.missingTeam = { workId: work.id, response: preSchedule }
      return
    }

    unwrap(await this.api.postBusiness('/mes/prodWork/scheduleProduct', {
      id: work.id,
      prodWorkOrderId: work.id,
      qty: 2,
      startDate: this.overdue ? productionTime(Date.now() - 3 * 3600000) : productionTime(Date.now() + 3600000),
      endDate: this.overdue ? productionTime(Date.now() - 3600000) : productionTime(Date.now() + 5 * 3600000),
      remark: this.marker
    }), '生产工单正式排产')
    const tasks = rowsOf(await this.api.getBusiness(
      `/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=${encodeURIComponent(work.id)}`
    ), '工单任务回读')
    assert.equal(tasks.length, 1, '专属工单排产应只生成一条任务')
    this.assertOwnedTask(tasks[0])
    const task = { ...tasks[0], id: String(tasks[0].id) }
    this.tasks = [task]
    this.remember('task', task.id, task.workOrderTaskCode)

    unwrap(await this.api.putBusiness('/mes/prodWorkTask/edit', {
      id: task.id,
      prodLineId: this.lineId,
      memberIds: this.memberId,
      leaderId: this.memberId,
      teamId: this.team?.id,
      remark: this.marker
    }), '工单任务绑定产线')
    const taskReadback = unwrap(await this.api.getBusiness(
      `/mes/prodWorkTask/queryById?id=${encodeURIComponent(task.id)}`
    ), '工单任务绑定后回读')
    this.assertOwnedTask(taskReadback, task.id)
    assert.equal(String(taskReadback.prodLineId), this.lineId)
    unwrap(await this.api.request(
      'GET',
      `/mes/prodWorkTask/checkOnly?prodWorkTaskId=${encodeURIComponent(task.id)}`
    ), '工单任务审核生效')
    const effectiveTask = this.assertOwnedTask(unwrap(await this.api.getBusiness(
      `/mes/prodWorkTask/queryById?id=${encodeURIComponent(task.id)}`
    ), '工单任务审核后回读'), task.id)
    assert.equal(effectiveTask.isEffective, 'Y', '正式排产任务审核后必须生效')
    if (this.withFeed) {
      assert.equal(Number(effectiveTask.isFeed), 1, '投料工序任务必须标记为投料工序')
    }
    if (this.withQuality) {
      assert.equal(Number(effectiveTask.isQuality), 1, '过程检工序任务必须标记为质量工序')
    }
  }

  async prepareFeed (caseRecord) {
    const task = this.assertOwnedTask(this.tasks[0])
    const preview = unwrap(await this.api.getBusiness(
      `/mes/prodWorkTask/feed-pick-preview?taskId=${encodeURIComponent(task.id)}`
    ), '任务投料领料预览')
    const material = asList(preview?.materialList).find((row) =>
      String(row?.materialId) === this.component.id)
    assert(material?.srcEntryId, '投料预览缺少 BOM 来源明细')
    assert(Number(material.requiredQty) > 0, '投料预览应领数量必须大于0')
    this.feedPreview = preview
    this.feedMaterialPreview = material
    addCheck(caseRecord, '投料预览返回真实 BOM 物料、来源明细和数量',
      String(preview.taskId) === task.id &&
        String(material.materialId) === this.component.id &&
        Number(material.requiredQty) > 0 &&
        Number(material.remainingPickQty) === Number(material.requiredQty),
      JSON.stringify({
        taskId: preview.taskId,
        materialId: material.materialId,
        srcEntryId: material.srcEntryId,
        requiredQty: material.requiredQty,
        stockQty: material.stockQty
      }))

    const before = unwrap(await this.api.getBusiness(
      `/mes/prodWorkTask/feed-status?taskId=${encodeURIComponent(task.id)}`
    ), '投料前置状态')
    addCheck(caseRecord, '未领料投料前置状态明确阻断报工',
      before.allowReport === false &&
        before.pickSatisfied === false &&
        typeof before.blockReason === 'string' &&
        before.blockReason.trim().length > 0,
      JSON.stringify({
        allowReport: before.allowReport,
        pickSatisfied: before.pickSatisfied,
        blockReason: before.blockReason
      }))

    const generated = unwrap(await this.api.postBusiness('/mes/prodWorkTask/generate-pick-bill', {
      taskId: task.id
    }), '生成生产领料单')
    const billId = String(generated?.billId || '')
    assert(stableId(billId), '生产领料单返回主键无效')
    assert(String(generated?.billNo || '').trim().length > 0, '生产领料单返回单号为空')
    this.pickBill = this.remember('pickBill', billId, String(generated.billNo))
    const draft = unwrap(await this.api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(billId)}`
    ), '生产领料单草稿回读')
    const draftEntries = rowsOf(await this.api.getBusiness(
      `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(billId)}`
    ), '生产领料单草稿明细回读')
    const draftEntry = draftEntries.find((row) =>
      String(row?.materialId) === this.component.id)
    assert(draftEntry?.id, '生产领料单缺少专属组件明细')
    assert.equal(String(draft?.stockIoType), '203', '生产领料单类型必须为203')
    assert.equal(String(draft?.srcBillType), 'ProdWork', '生产领料单来源类型必须为ProdWork')
    assert.equal(String(draft?.srcBillId), this.works[0].id, '生产领料单来源工单不匹配')

    await this.submitAndApprovePick(draft, draftEntries)
    const effective = unwrap(await this.api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(billId)}`
    ), '生效生产领料单回读')
    const effectiveEntries = rowsOf(await this.api.getBusiness(
      `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(billId)}`
    ), '生效生产领料单明细回读')
    const entry = effectiveEntries.find((row) =>
      String(row?.id) === String(draftEntry.id))
    assert(entry?.id, '生效生产领料单明细回读缺少原分录')
    this.pickEntry = entry
    addCheck(caseRecord, '生产领料单经 WMS 正式审核并保留来源与明细',
      Number(effective?.isEffective) === 1 &&
        String(effective?.stockIoType) === '203' &&
        String(effective?.srcBillType) === 'ProdWork' &&
        String(effective?.srcBillId) === this.works[0].id &&
        String(entry.materialId) === this.component.id &&
        Number(entry.qty) >= Number(material.requiredQty),
      JSON.stringify({
        billId,
        billNo: effective?.billNo,
        isEffective: effective?.isEffective,
        entryId: entry.id,
        materialId: entry.materialId,
        qty: entry.qty
      }))

    const feedQty = Number(material.requiredQty)
    const feedId = String(unwrap(await this.api.postBusiness('/mes/prodWorkTask/feed-record', {
      taskId: task.id,
      pickEntryId: String(entry.id),
      materialId: this.component.id,
      batchNo: entry.batchNo,
      feedQty,
      remark: this.marker
    }), '保存正式投料记录'))
    assert(stableId(feedId), '投料记录返回主键无效')
    this.feedRecordIds.push(feedId)
    const records = rowsOf(await this.api.getBusiness(
      `/mes/prodWorkTask/feed-record/list?taskId=${encodeURIComponent(task.id)}`
    ), '投料记录回读')
    const record = records.find((row) => String(row?.id) === feedId)
    addCheck(caseRecord, '正式投料记录按任务、领料分录、批次和数量回读',
      record != null &&
        String(record.taskId) === task.id &&
        String(record.pickEntryId) === String(entry.id) &&
        String(record.materialId) === this.component.id &&
        Number(record.feedQty) === feedQty &&
        record.remark === this.marker,
      JSON.stringify({
        feedId,
        taskId: record?.taskId,
        pickEntryId: record?.pickEntryId,
        feedQty: record?.feedQty,
        remark: record?.remark
      }))

    const after = unwrap(await this.api.getBusiness(
      `/mes/prodWorkTask/feed-status?taskId=${encodeURIComponent(task.id)}`
    ), '投料后置状态')
    addCheck(caseRecord, '投料完成后状态允许报工且已投数量闭合',
      after.pickSatisfied === true &&
        after.feedSatisfied === true &&
        after.allowReport === true &&
        Number(after.remainingFeedQty) === 0 &&
        Number(after.fedQty) >= feedQty,
      JSON.stringify({
        pickSatisfied: after.pickSatisfied,
        feedSatisfied: after.feedSatisfied,
        allowReport: after.allowReport,
        fedQty: after.fedQty,
        remainingFeedQty: after.remainingFeedQty
      }))

    const beforeDuplicate = await this.captureFeedWriteFacts(caseRecord, 'before-duplicate-pick')
    const duplicatePick = await this.api.request(
      'POST',
      '/mes/prodWorkTask/generate-pick-bill',
      { taskId: task.id },
      { expectedBusinessRejection: { code: 400, message: /已满足|无需重复|没有可分配库存/ } }
    )
    const afterDuplicatePick = await this.captureFeedWriteFacts(caseRecord, 'after-duplicate-pick')
    addCheck(caseRecord, '重复生成生产领料单被正式拒绝且不新增单据',
      duplicatePick?.code === 400 &&
        /已满足|无需重复|没有可分配库存/.test(String(duplicatePick?.msg || duplicatePick?.message || '')) &&
        JSON.stringify(afterDuplicatePick) === JSON.stringify(beforeDuplicate),
      JSON.stringify({
        code: duplicatePick?.code, msg: duplicatePick?.msg,
        before: beforeDuplicate, after: afterDuplicatePick
      }))

    const duplicateFeed = await this.api.request(
      'POST',
      '/mes/prodWorkTask/feed-record',
      {
        taskId: task.id,
        pickEntryId: String(entry.id),
        materialId: this.component.id,
        batchNo: entry.batchNo,
        feedQty: 1,
        remark: `${this.marker} duplicate`
      },
      { expectedBusinessRejection: { code: 400, message: /已领未投余额|超过|累计投料/ } }
    )
    const afterDuplicateFeed = await this.captureFeedWriteFacts(caseRecord, 'after-duplicate-feed')
    addCheck(caseRecord, '重复投料超过已领未投余额被正式拒绝',
      duplicateFeed?.code === 400 &&
        /已领未投余额|超过|累计投料/.test(String(duplicateFeed?.msg || duplicateFeed?.message || '')) &&
        JSON.stringify(afterDuplicateFeed) === JSON.stringify(afterDuplicatePick),
      JSON.stringify({
        code: duplicateFeed?.code, msg: duplicateFeed?.msg,
        before: afterDuplicatePick, after: afterDuplicateFeed
      }))
    this.fixtureRecord.feed = {
      pickBillId: billId,
      pickEntryId: String(entry.id),
      feedRecordId: feedId,
      requiredQty: feedQty
    }
  }

  async captureFeedWriteFacts (caseRecord, stage) {
    const task = this.assertOwnedTask(this.tasks[0])
    const pick = await runReadOnlySql(
      `SELECT io.id, io.bill_no, io.bill_stage, io.is_effective+0, io.is_voided+0,
              entry.id, entry.material_id, entry.qty
       FROM mes_stk_io io JOIN mes_stk_io_entry entry ON entry.mid=io.id
       WHERE io.tenant_id=1 AND io.deleted=0 AND entry.tenant_id=1 AND entry.deleted=0
         AND io.src_bill_type='ProdWork' AND io.src_bill_id='${sqlText(this.works[0].id)}'
         AND io.stock_io_type='203' AND entry.material_id='${sqlText(this.component.id)}'
       ORDER BY io.id, entry.id`
    )
    const feed = await runReadOnlySql(
      `SELECT id, task_id, pick_bill_id, pick_entry_id, material_id, batch_no, feed_qty
       FROM mes_prod_task_feed_record WHERE tenant_id=1 AND deleted=0
         AND task_id='${sqlText(task.id)}'
       ORDER BY id`
    )
    caseRecord.database = [...(caseRecord.database || []),
      { stage, kind: 'production-pick-facts', ...pick },
      { stage, kind: 'production-feed-facts', ...feed }]
    assert(pick.available && feed.available &&
      Array.isArray(pick.rows) && Array.isArray(feed.rows),
    '领料投料幂等必须具备独立数据库事实证据')
    assert(pick.rows.length > 0 && feed.rows.length > 0 &&
      pick.rows.every((row) => row.length === 8 && stableId(row[0]) && stableId(row[5])) &&
      feed.rows.every((row) => row.length === 7 && stableId(row[0])),
    '领料投料幂等不能使用空集或无效事实')
    assert(pick.rows.some((row) => String(row[0]) === this.pickBill.id &&
      String(row[5]) === String(this.pickEntry.id) &&
      String(row[6]) === this.component.id && Number(row[7]) > 0),
    '领料幂等回读缺少本轮生效分录')
    assert(feed.rows.some((row) => this.feedRecordIds.includes(String(row[0])) &&
      String(row[1]) === task.id && String(row[2]) === this.pickBill.id &&
      String(row[3]) === String(this.pickEntry.id) &&
      String(row[4]) === this.component.id && Number(row[6]) > 0),
    '投料幂等回读缺少本轮投料事实')
    return { pickRows: pick.rows, feedRows: feed.rows }
  }

  async submitAndApprovePick (draft, entries) {
    assert(this.pickBill && String(draft?.id) === this.pickBill.id, '提交领料单主键不属于本轮')
    assert.equal(String(draft?.stockIoType), '203', '只能提交专属生产领料单')
    assert.equal(String(draft?.srcBillType), 'ProdWork', '专属领料单来源类型不匹配')
    assert.equal(String(draft?.srcBillId), this.works[0].id, '专属领料单来源工单不匹配')
    assert(entries.length > 0 && entries.every((entry) =>
      String(entry.materialId) === this.component.id &&
      String(entry.warehouseId) === this.warehouse.id &&
      String(entry.wareAreaId) === this.area.id &&
      String(entry.wareLocationId) === this.location.id &&
      Number(entry.qty) > 0), '领料分录必须属于本轮隔离物料和仓库')
    let detail = draft
    if (String(detail.billStage) === '12' && Number(detail.isEffective) === 0) {
      const pick = (row, fields) => Object.fromEntries(fields
        .filter((field) => Object.prototype.hasOwnProperty.call(row, field))
        .map((field) => [field, row[field]]))
      unwrap(await this.api.putBusiness('/mes/stkIo/edit/submit', {
        ...pick(detail, [
          'id', 'billNo', 'billDate', 'subject', 'remark', 'stockIoType',
          'srcBillType', 'srcBillId', 'srcNo', 'isAuto', 'isQc', 'version',
          'billStage', 'isEffective', 'isVoided', 'isClosed'
        ]),
        stkIoEntryList: entries.map((entry) => pick(entry, [
          'id', 'entryNo', 'materialId', 'unitId', 'qty', 'cost', 'price', 'settleQty',
          'settleAmt', 'warehouseId', 'wareAreaId', 'wareLocationId', 'batchNo',
          'srcBillType', 'srcBillId', 'srcEntryId', 'srcNo', 'stockIoType',
          'stockIoDirection', 'isQc', 'brand', 'colorId', 'remark'
        ])),
        stkIoDistributionList: [],
        stkIoBomList: []
      }), '正式提交生产领料草稿')
      detail = unwrap(await this.api.getBusiness(
        `/mes/stkIo/queryById?id=${encodeURIComponent(this.pickBill.id)}`
      ), '生产领料提交后回读')
    }
    if (Number(detail?.isEffective) !== 1) {
      unwrap(await this.api.putBusiness('/mes/stkIo/check', {
        id: this.pickBill.id,
        approvalResultType: '1',
        approvalRemark: `${this.marker} pick`
      }), '审核生产领料单')
    }
    return detail
  }

  async voidOpeningInventoryForShortage (caseRecord) {
    assert(this.opening && this.inventory, '缺料场景必须先通过正式期初库存完成生产下达')
    assert.equal(await this.cleanupResource(this.opening, caseRecord), true,
      '缺料场景作废专属期初库存失败')
    const task = this.assertOwnedTask(this.tasks[0])
    const preview = unwrap(await this.api.getBusiness(
      `/mes/prodWorkTask/feed-pick-preview?taskId=${encodeURIComponent(task.id)}`
    ), '作废专属期初后缺料预览')
    const material = asList(preview?.materialList).find((row) =>
      String(row?.materialId) === this.component.id)
    assert(material, '缺料预览必须返回本轮 BOM 物料，不能用空集证明缺料')
    assert(Number(material.requiredQty) > 0 && Number(material.stockQty) === 0,
      '作废期初后仍有库存，不能宣称缺料')
    this.fixtureRecord.shortage = { taskId: task.id, openingId: this.opening.id, material }
    return material
  }

  registerQualityInspection (inspectionId, identity = '') {
    const id = String(inspectionId)
    assert(stableId(id), '过程检单主键无效')
    if (!this.qualityInspectionIds.includes(id)) {
      this.qualityInspectionIds.push(id)
      this.qualityInspections = this.qualityInspections || []
      this.qualityInspections.push(this.remember('qualityInspection', id, identity || id))
    }
    return id
  }

  async startWork () {
    const work = this.works[0]
    assert(work, 'BLOCKED: 专属生产工单不存在')
    this.assertOwnedWork(work)
    unwrap(await this.api.postBusiness('/mes/prodWork/start', {
      id: work.id,
      prodWorkOrderId: work.id
    }), '生产工单开工')
    const detail = unwrap(await this.api.getBusiness(
      `/mes/prodWork/queryById?id=${encodeURIComponent(work.id)}`
    ), '生产工单开工回读')
    this.assertOwnedWork(detail, work.id)
    assert.equal(Number(detail.status), 2, '生产工单开工后状态应为进行中')
    return detail
  }

  async reportTask ({
    qty = 2,
    qualifiedQty = 1,
    defectQty = 1,
    disqualificationReason = `${this.marker} defect`,
    remark = this.marker,
    startTime = `${productionTime().slice(0, 10)} 16:00:00`,
    endTime = `${productionTime().slice(0, 10)} 16:30:00`
  } = {}) {
    const task = this.assertOwnedTask(this.tasks[0])
    assert.equal(Number(qty), Number(qualifiedQty) + Number(defectQty),
      '专属报工的合格数与不合格数必须等于报工数')
    const reportCode = `${this.shortCode}-RP`
    const reportId = String(unwrap(
      await this.api.postBusiness('/mes/prodWorkReport/addByTaskId', {
        taskId: task.id,
        qty,
        qualifiedQty,
        defectQty,
        disqualificationReason,
        reportCode,
        remark,
        startTime,
        endTime
      }),
      '专属生产报工'
    ))
    assert(stableId(reportId), '专属生产报工返回主键无效')
    this.reportIds.push(reportId)
    this.remember('report', reportId, reportCode)
    const detail = unwrap(await this.api.getBusiness(
      `/mes/prodWorkReport/queryById?id=${encodeURIComponent(reportId)}`
    ), '专属生产报工回读')
    assert.equal(String(detail?.id), reportId, '专属报工主键回读不匹配')
    assert.equal(String(detail?.workTaskId), task.id, '专属报工任务关联不匹配')
    assert.equal(String(detail?.workTicketId), this.works[0].id, '专属报工工单关联不匹配')
    assert.equal(String(detail?.reportCode), reportCode, '专属报工编码回读不匹配')
    // Adopt any real output even when a quality gate was expected, so a backend
    // premature release cannot leave untracked stock facts during cleanup.
    await this.captureProductionOutput(reportId)
    return detail
  }

  async captureProductionOutput (reportId, { requireInventory = false } = {}) {
    const snapshot = await runReadOnlySql(
      `SELECT io.id, io.bill_no, io.is_effective+0, io.is_voided+0, io.bill_stage,
              entry.material_id, entry.warehouse_id, entry.ware_area_id,
              entry.ware_location_id, entry.batch_no
       FROM mes_stk_io io
       JOIN mes_stk_io_entry entry ON entry.mid=io.id
       WHERE io.tenant_id=1 AND io.deleted=0
         AND io.src_bill_type='ProdWork'
         AND io.src_bill_id='${sqlText(this.works[0].id)}'
         AND io.stock_io_type='104'
         AND entry.src_entry_id='${sqlText(reportId)}'`
    )
    if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
    assert(snapshot.rows.length <= 1, '专属报工成品入库来源必须至多唯一一张')
    if (snapshot.rows.length === 0) {
      if (requireInventory) {
        throw new Error('正式报工放行后未找到唯一104成品入库')
      }
      return null
    }

    const [id, billNo, isEffective, isVoided, billStage, materialId,
      warehouseId, wareAreaId, wareLocationId, batchNo] = snapshot.rows[0]
    assert(stableId(id), '专属报工自动成品入库主键无效')
    assert.equal(String(materialId), this.material.id, '自动成品入库物料归属不匹配')
    assert.equal(String(warehouseId), this.warehouse.id, '自动成品入库仓库归属不匹配')
    assert.equal(String(wareAreaId), this.area.id, '自动成品入库库区归属不匹配')
    assert.equal(String(wareLocationId), this.location.id, '自动成品入库库位归属不匹配')
    const existing = this.owned.find((resource) => resource.kind === 'output' && resource.id === String(id))
    const output = existing || this.remember('output', id, billNo)
    output.sourceReportId = String(reportId)
    output.sourceWorkId = this.works[0].id
    output.stockIoType = '104'
    output.billStage = String(billStage)
    output.isEffective = Number(isEffective)
    output.isVoided = Number(isVoided)
    output.dimensions = {
      warehouseId: String(warehouseId),
      materialId: String(materialId),
      wareAreaId: String(wareAreaId),
      wareLocationId: String(wareLocationId),
      batchNo: String(batchNo)
    }
    if (!this.outputIds.includes(output.id)) this.outputIds.push(output.id)
    this.fixtureRecord.productionOutputs = this.owned.filter((resource) => resource.kind === 'output')

    const inventory = await runReadOnlySql(
      `SELECT id, warehouse_id, material_id, ware_area_id, ware_location_id, batch_no,
              qty, available_qty, lock_qty, hold_qty, frozen_qty, pending_putaway_qty,
              deleted+0, is_closed
       FROM mes_stk_inventory
       WHERE tenant_id=1 AND deleted=0 AND is_closed=0
         AND warehouse_id='${sqlText(warehouseId)}'
         AND material_id='${sqlText(materialId)}'
         AND ware_area_id='${sqlText(wareAreaId)}'
         AND ware_location_id='${sqlText(wareLocationId)}'
         AND batch_no='${sqlText(batchNo)}'`
    )
    if (!inventory.available) throw new Error(`BLOCKED: ${inventory.reason}`)
    assert(inventory.rows.length <= 1, '专属自动成品入库库存事实必须至多唯一一条')
    if (inventory.rows.length === 1) {
      const [inventoryId, actualWarehouseId, actualMaterialId, actualWareAreaId,
        actualWareLocationId, actualBatchNo] = inventory.rows[0]
      assert.equal(String(actualWarehouseId), String(warehouseId), '自动成品库存仓库归属不匹配')
      assert.equal(String(actualMaterialId), String(materialId), '自动成品库存物料归属不匹配')
      const resource = this.owned.find((item) => item.kind === 'inventory' && item.id === String(inventoryId)) ||
        this.remember('inventory', inventoryId, actualBatchNo)
      resource.sourceOutputId = output.id
      resource.dimensions = {
        warehouseId: String(actualWarehouseId),
        materialId: String(actualMaterialId),
        wareAreaId: String(actualWareAreaId),
        wareLocationId: String(actualWareLocationId),
        batchNo: String(actualBatchNo)
      }
    }
    if (requireInventory && !this.owned.some((resource) =>
      resource.kind === 'inventory' && resource.sourceOutputId === output.id)) {
      throw new Error('正式104成品入库后未找到对应 WMS 库存事实')
    }
    return output
  }

  async finishWork () {
    const work = this.assertOwnedWork(this.works[0])
    unwrap(await this.api.postBusiness('/mes/prodWork/finish', {
      id: work.id
    }), '生产工单完工')
    const detail = unwrap(await this.api.getBusiness(
      `/mes/prodWork/queryById?id=${encodeURIComponent(work.id)}`
    ), '生产工单完工回读')
    this.assertOwnedWork(detail, work.id)
    assert.equal(Number(detail.status), 6, '生产工单完工后状态应为已完成')
    return detail
  }

  async pauseWork (reason, expectResumeTime) {
    const work = this.assertOwnedWork(this.works[0])
    unwrap(await this.api.postBusiness('/mes/prodWork/pause', {
      id: work.id,
      prodWorkOrderId: work.id,
      pauseReason: reason,
      expectResumeTime
    }), '生产工单暂停')
    return this.assertOwnedWork(unwrap(await this.api.getBusiness(
      `/mes/prodWork/queryById?id=${encodeURIComponent(work.id)}`
    ), '生产工单暂停回读'), work.id)
  }

  async resumeWork () {
    const work = this.assertOwnedWork(this.works[0])
    unwrap(await this.api.postBusiness('/mes/prodWork/resume', {
      id: work.id,
      prodWorkOrderId: work.id
    }), '生产工单恢复')
    return this.assertOwnedWork(unwrap(await this.api.getBusiness(
      `/mes/prodWork/queryById?id=${encodeURIComponent(work.id)}`
    ), '生产工单恢复回读'), work.id)
  }

  async assertCleanupOwnership (resource) {
    assert.equal(config.target, 'local')
    assert.equal(String(config.tenantId), '1')
    assert.equal(config.db.name, 'cfor_admin_standard')
    assert(stableId(resource?.id) && resource.marker === this.marker &&
      this.owned.includes(resource), '清理专属资源所有权未登记')
    const definition = cleanupDefinitions[resource.kind]
    assert(definition, '清理资源类型无效')
    const deletedColumn = definition.deletedColumn || 'deleted'
    const value = (text) => `'${sqlText(text)}'`
    let ownership
    if (resource.kind === 'output') {
      const output = await runReadOnlySql(
        `SELECT io.id
         FROM mes_stk_io io
         JOIN mes_stk_io_entry entry ON entry.mid=io.id
         WHERE io.tenant_id=1 AND io.deleted=0 AND io.id='${sqlText(resource.id)}'
           AND io.src_bill_type='ProdWork'
           AND io.src_bill_id='${sqlText(resource.sourceWorkId)}'
           AND io.stock_io_type='104'
           AND entry.src_entry_id='${sqlText(resource.sourceReportId)}'`
      )
      if (!output.available) throw new Error(`BLOCKED: ${output.reason}`)
      assert.equal(output.rows.length, 1, '自动成品入库所有权回读必须唯一')
      assert.equal(String(output.rows[0][0]), resource.id, '自动成品入库所有权主键不匹配')
      return
    }
    if (resource.kind === 'work') {
      ownership = `prod_order_id=${value(this.order.id)} AND remark=${value(this.marker)}`
    } else if (resource.kind === 'task' || resource.kind === 'report') {
      ownership = `work_ticket_id=${value(this.works[0].id)}`
      if (resource.kind === 'task') {
        ownership += ` AND product_id=${value(this.material.id)} AND routing=${value(this.route.id)}`
      } else {
        ownership += ` AND remark=${value(this.marker)}`
      }
    } else if (resource.kind === 'inventory') {
      const dimensions = resource.dimensions
      assert(dimensions, '专属库存事实缺少维度所有权')
      ownership = [
        `warehouse_id=${value(dimensions.warehouseId)}`,
        `material_id=${value(dimensions.materialId)}`,
        `ware_area_id=${value(dimensions.wareAreaId)}`,
        `ware_location_id=${value(dimensions.wareLocationId)}`,
        `batch_no=${value(dimensions.batchNo)}`
      ].join(' AND ')
    } else {
      const identityColumn = {
        area: 'area_code', location: 'location_code', opening: 'bill_no',
        order: 'bill_no', team: 'team_id'
      }[resource.kind] || 'code'
      const markerColumn = ['warehouse', 'route', 'procedure', 'bom'].includes(resource.kind)
        ? 'mark'
        : 'remark'
      const marker = resource.kind === 'team' ? resource.identity : this.marker
      ownership = `${identityColumn}=${value(resource.identity)} AND ${markerColumn}=${value(marker)}`
    }
    const id = await queryId(
      `SELECT id FROM ${definition.table}
       WHERE tenant_id=1 AND ${deletedColumn}=0 AND id=${value(resource.id)} AND ${ownership}`,
      `清理 ${resource.kind}`
    )
    assert.equal(id, resource.id, '清理资源所有权主键不匹配')
  }

  async confirmDeleted (resource, caseRecord) {
    const definition = cleanupDefinitions[resource.kind]
    const deletedColumn = definition.deletedColumn || 'deleted'
    const apiEvidence = resource.kind === 'work'
      ? '工单详情接口对已删除记录返回业务错误，使用租户范围数据库回读确认'
      : ''
    const snapshot = await runReadOnlySql(
      `SELECT id, ${deletedColumn}+0 FROM ${definition.table}
       WHERE tenant_id=1 AND id='${sqlText(resource.id)}'`
    )
    caseRecord.database = [...(caseRecord.database || []), {
      stage: 'execution-cleanup', kind: resource.kind, id: resource.id, apiEvidence, ...snapshot
    }]
    if (!snapshot.available) throw new Error(`清理未完成：${snapshot.reason}`)
    assert(Array.isArray(snapshot.rows) && snapshot.rows.length <= 1 &&
      snapshot.rows.every((row) => String(row[0]) === resource.id && String(row[1]) === '1'),
    `${resource.kind}=${resource.id} 删除后仍有残留或删除证据无效`)
  }

  async retainReferencedWarehouse (resource, caseRecord) {
    const detail = unwrap(await this.api.getBusiness(
      `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(resource.id)}`
    ), '引用仓库停用前回读')
    assert.equal(String(detail?.id), resource.id, '引用仓库所有权主键不匹配')
    assert.equal(detail.code, resource.identity, '引用仓库编码所有权不匹配')
    assert.equal(detail.mark, this.marker, '引用仓库标记所有权不匹配')
    unwrap(await this.api.putBusiness('/mes/wmsWareHouse/edit', {
      id: resource.id,
      pid: detail.pid,
      code: detail.code,
      name: detail.name,
      isEnabled: false
    }), '引用仓库停用')
    const disabled = unwrap(await this.api.getBusiness(
      `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(resource.id)}`
    ), '引用仓库停用后回读')
    assert.equal(String(disabled?.id), resource.id, '停用后仓库主键不匹配')
    assert.equal(disabled.code, resource.identity, '停用后仓库编码不匹配')
    assert.equal(disabled.mark, this.marker, '停用后仓库标记不匹配')
    assert(
      disabled.isEnabled === false ||
      String(disabled.isEnabled).toLowerCase() === 'false' ||
      Number(disabled.isEnabled) === 0,
      '被历史单据引用的专属仓库必须正式停用'
    )
    resource.cleanup = 'RETAINED_AUDIT_DISABLED'
    caseRecord.notes.push(
      `仓库 ${resource.id} 被作废期初单审计历史引用，已通过正式接口停用并保留审计事实。`
    )
    addCheck(caseRecord, `专属 ${resource.kind}=${resource.id} 停用并保留审计已确认`,
      true, resource.cleanup)
    return true
  }

  async cleanupSpecialResource (resource, caseRecord) {
    const label = `${resource.kind}=${resource.id}`
    if (resource.kind === 'pickBill') {
      const detail = unwrap(await this.api.getBusiness(
        `/mes/stkIo/queryById?id=${encodeURIComponent(resource.id)}`
      ), '清理前生产领料单回读')
      assert.equal(String(detail?.id), resource.id, '生产领料单主键不匹配')
      assert.equal(String(detail?.stockIoType), '203', '生产领料单类型不匹配')
      assert.equal(String(detail?.srcBillId), this.works[0].id, '生产领料单来源工单不匹配')
      unwrap(await this.api.putBusiness('/mes/stkIo/void', { id: resource.id }), '作废生产领料单')
      const voided = unwrap(await this.api.getBusiness(
        `/mes/stkIo/queryById?id=${encodeURIComponent(resource.id)}`
      ), '作废后生产领料单回读')
      assert.equal(Number(voided?.isVoided), 1, '生产领料单未确认作废')
      resource.cleanup = 'VOIDED_RETAINED'
      addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
      return true
    }
    if (resource.kind === 'qualityBinding') {
      const rows = rowsOf(await this.api.getBusiness(
        `/mes/procedure-quality-item/page?pageNo=1&pageSize=100&procedureId=${encodeURIComponent(this.procedure.id)}`
      ), '清理前工序过程检绑定回读')
      const row = rows.find((item) => String(item?.id) === resource.id)
      assert(row, '工序过程检绑定所有权回读失败')
      assert.equal(String(row.procedureId), this.procedure.id, '工序过程检绑定工序不匹配')
      unwrap(await this.api.deleteBusiness(
        `${cleanupDefinitions.qualityBinding.endpoint}?id=${encodeURIComponent(resource.id)}`
      ), '删除工序过程检绑定')
      const after = rowsOf(await this.api.getBusiness(
        `/mes/procedure-quality-item/page?pageNo=1&pageSize=100&procedureId=${encodeURIComponent(this.procedure.id)}`
      ), '删除后工序过程检绑定回读')
      assert(!after.some((item) => String(item?.id) === resource.id), '工序过程检绑定仍然存在')
      resource.cleanup = 'DELETED_VERIFIED'
      addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
      return true
    }
    if (resource.kind === 'qualityInspection') {
      const detail = unwrap(await this.api.getBusiness(
        `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(resource.id)}`
      ), '清理前过程检单回读')
      assert.equal(String(detail?.id), resource.id, '过程检单主键不匹配')
      assert.equal(String(detail?.type), '300', '过程检单类型不匹配')
      assert(
        this.reportIds.includes(String(detail?.srcBillId)) ||
        this.reportIds.includes(String(detail?.customField8)),
        '过程检单来源报工不属于本轮'
      )
      try {
        unwrap(await this.api.request('PUT', '/mes/quality/qualityInspection/void', {
          id: resource.id
        }, {
          expectedBusinessRejection: {
            code: 500,
            message: '该质检单存在对应的成品入库单，不能作废',
            allowServiceCode: true
          }
        }), '作废过程检单')
        unwrap(await this.api.deleteBusiness(
          `/mes/quality/qualityInspection/delete?id=${encodeURIComponent(resource.id)}`
        ), '删除过程检单')
        resource.cleanup = 'DELETED_VERIFIED'
        addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
        return true
      } catch (error) {
        if (!/该质检单存在对应的成品入库单/.test(error.message)) {
          throw error
        }

        // A linked 104 output is an intentional audit-retention boundary:
        // the product rejects voiding the inspection after stock write-back.
        // Verify that the retained inspection and its output both belong to
        // this fixture before treating the retention as successful cleanup.
        const relatedReportIds = new Set(
          [detail?.srcBillId, detail?.customField8]
            .map((value) => String(value || ''))
            .filter((value) => this.reportIds.includes(value))
        )
        if (relatedReportIds.size === 0) {
          const entries = rowsOf(await this.api.getBusiness(
            `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(resource.id)}`
          ), '保留过程检明细回读')
          for (const entry of entries) {
            for (const value of [entry?.srcBillId, entry?.srcEntryId]) {
              const reportId = String(value || '')
              if (this.reportIds.includes(reportId)) relatedReportIds.add(reportId)
            }
          }
        }
        const linkedOutputs = this.owned.filter((item) =>
          item.kind === 'output' && relatedReportIds.has(String(item.sourceReportId))
        )
        assert(linkedOutputs.length > 0, '被保留质检单未找到本轮已生效104成品入库')
        for (const output of linkedOutputs) {
          await this.assertCleanupOwnership(output)
        }
        const retained = unwrap(await this.api.getBusiness(
          `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(resource.id)}`
        ), '保留过程检单回读')
        assert.equal(Number(retained?.isVoided || 0), 0, '审计保留质检单不应被标记为作废')
        resource.cleanup = 'RETAINED_AUDIT_LINKED_OUTPUT'
        resource.retainedReason = 'QUALITY_INSPECTION_LINKED_TO_104_OUTPUT'
        resource.linkedOutputIds = linkedOutputs.map((item) => item.id)
        caseRecord.database = [...(caseRecord.database || []), {
          stage: 'execution-cleanup-retained-linked-output',
          inspectionId: resource.id,
          reportIds: [...relatedReportIds],
          outputIds: resource.linkedOutputIds,
          reason: resource.retainedReason
        }]
        caseRecord.notes.push(
          `质检单 ${resource.id} 已由正式规则保留：关联本轮104成品入库 ${resource.linkedOutputIds.join(',')}，不能作废，保留审计事实。`
        )
        addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
        return true
      }
    }
    if (resource.kind === 'qualityPlan') {
      const detail = unwrap(await this.api.getBusiness(
        `/mes/quality/qualityPlan/queryById/dictText?id=${encodeURIComponent(resource.id)}`
      ), '清理前过程检方案回读')
      assert.equal(String(detail?.id), resource.id, '过程检方案主键不匹配')
      assert.equal(detail?.planCode, resource.identity, '过程检方案编码不匹配')
      await this.api.postBusiness(
        `/mes/quality/qualityPlan/disable?id=${encodeURIComponent(resource.id)}`
      )
      unwrap(await this.api.deleteBusiness(
        `${cleanupDefinitions.qualityPlan.endpoint}?id=${encodeURIComponent(resource.id)}`
      ), '删除过程检方案')
      resource.cleanup = 'DELETED_VERIFIED'
      addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
      return true
    }
    if (resource.kind === 'qualityItem') {
      const rows = rowsOf(await this.api.getBusiness(
        `/mes/quality/item/list/dictText?pageNo=1&pageSize=100&itemCode=${encodeURIComponent(resource.identity)}`
      ), '清理前过程检项目回读')
      const detail = rows.find((item) => String(item?.id) === resource.id)
      assert(detail, '过程检项目所有权回读失败')
      await this.api.postBusiness(
        `/mes/quality/item/disable?id=${encodeURIComponent(resource.id)}`
      )
      unwrap(await this.api.deleteBusiness(
        `${cleanupDefinitions.qualityItem.endpoint}?id=${encodeURIComponent(resource.id)}`
      ), '删除过程检项目')
      resource.cleanup = 'DELETED_VERIFIED'
      addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
      return true
    }
    return false
  }

  async cleanupResource (resource, caseRecord) {
    const label = `${resource.kind}=${resource.id}`
    try {
      if (['pickBill', 'qualityBinding', 'qualityInspection', 'qualityPlan', 'qualityItem']
        .includes(resource.kind)) {
        return await this.cleanupSpecialResource(resource, caseRecord)
      }
      if (resource.kind === 'task') {
        // Parent work-order revocation formally removes its task. Avoid a
        // second void request after that state transition.
        const snapshot = await runReadOnlySql(
          `SELECT id, is_deleted+0 FROM mes_prod_work_task
           WHERE tenant_id=1 AND id='${sqlText(resource.id)}'`
        )
        if (!snapshot.available) throw new Error(`清理未完成：${snapshot.reason}`)
        if (snapshot.rows.length === 0 ||
          (snapshot.rows.length === 1 && String(snapshot.rows[0][1]) === '1')) {
          await this.confirmDeleted(resource, caseRecord)
          resource.cleanup = 'DELETED_VERIFIED'
          addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
          return true
        }
      }
      if (resource.kind === 'inventory') {
        await this.assertCleanupOwnership(resource)
        const snapshot = await runReadOnlySql(
          `SELECT id, qty, available_qty, lock_qty, hold_qty, frozen_qty,
                  pending_putaway_qty, deleted+0, is_closed
           FROM mes_stk_inventory
           WHERE tenant_id=1 AND deleted=0 AND id='${sqlText(resource.id)}'`
        )
        caseRecord.database = [...(caseRecord.database || []), {
          stage: 'execution-cleanup-inventory-balance',
          kind: resource.kind,
          id: resource.id,
          ...snapshot
        }]
        if (!snapshot.available) throw new Error(`清理未完成：${snapshot.reason}`)
        assert.equal(snapshot.rows.length, 1, '专属库存事实清理前必须唯一存在')
        const quantities = snapshot.rows[0].slice(1, 7)
        assert(
          quantities.every(isZeroQuantity),
          `专属库存事实仍有非零分量，拒绝删除：${JSON.stringify(quantities)}`
        )
        unwrap(await this.api.deleteBusiness(
          `${cleanupDefinitions.inventory.endpoint}?id=${encodeURIComponent(resource.id)}`
        ), `删除 ${label}`)
        await this.confirmDeleted(resource, caseRecord)
        resource.cleanup = 'DELETED_VERIFIED'
        addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
        return true
      }
      await this.assertCleanupOwnership(resource)
      if (resource.kind === 'work') {
        const taskRows = rowsOf(await this.api.getBusiness(
          `/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=${encodeURIComponent(resource.id)}`
        ), '清理前工单任务回读')
        const effectiveTasks = taskRows.filter((task) => task?.isEffective === 'Y')
        if (taskRows.length === 0 || effectiveTasks.length > 0) {
          unwrap(await this.api.request(
            'GET',
            `/mes/prodWorkTask/void?prodWorkId=${encodeURIComponent(resource.id)}`
          ), '作废专属工单任务并复位工单')
        }
        unwrap(await this.api.request('POST', '/mes/prodWork/revocation', {
          id: resource.id, prodWorkOrderId: resource.id
        }), '撤回专属工单')
      }
      if (resource.kind === 'task') {
        const task = unwrap(await this.api.getBusiness(
          `/mes/prodWorkTask/queryById?id=${encodeURIComponent(resource.id)}`
        ), '清理前工单任务回读')
        if (task?.isEffective === 'Y') {
          unwrap(await this.api.request(
            'GET',
            `/mes/prodWorkTask/voidOnly?prodWorkTaskId=${encodeURIComponent(resource.id)}`
          ), '作废专属工单任务')
        }
      }
      if (resource.kind === 'opening' || resource.kind === 'output') {
        if (resource.kind === 'output' && this.normalizeWmsOutputCleanupEnabled) {
          await this.normalizeWmsOutputCleanup(resource.id)
        }
        const before = unwrap(await this.api.getBusiness(
          `/mes/stkIo/queryById?id=${encodeURIComponent(resource.id)}`
        ), '作废前专属入库回读')
        if (Number(before?.isVoided) !== 1 || Number(before?.isEffective) !== 0) {
          unwrap(await this.api.putBusiness('/mes/stkIo/void', { id: resource.id }), '作废专属期初库存')
        }
        const detail = unwrap(await this.api.getBusiness(
          `/mes/stkIo/queryById?id=${encodeURIComponent(resource.id)}`
        ), '作废后期初库存回读')
        assert.equal(String(detail?.id), resource.id, '专属期初库存所有权主键不匹配')
        if (resource.kind === 'opening') {
          assert.equal(detail.remark, this.marker, '专属期初库存所有权标记不匹配')
        } else {
          assert.equal(String(detail?.srcBillType), 'ProdWork', '自动成品入库来源类型不匹配')
          assert.equal(String(detail?.srcBillId), resource.sourceWorkId, '自动成品入库来源工单不匹配')
          assert.equal(String(detail?.stockIoType), '104', '自动成品入库类型不匹配')
        }
        assert.equal(Number(detail.isVoided), 1, '专属期初库存未确认作废')
        assert.equal(Number(detail.isEffective), 0, '专属作废入库仍处于生效状态')
        resource.cleanup = resource.kind === 'output'
          ? 'VOIDED_RETAINED_AUTO_OUTPUT'
          : 'VOIDED_RETAINED'
      } else {
        try {
          const deleteOptions = resource.kind === 'warehouse'
            ? {
                expectedBusinessRejection: {
                  code: 500,
                  message: '已被引用，不能删除！',
                  allowServiceCode: true
                }
              }
            : undefined
          unwrap(await this.api.deleteBusiness(
            `${cleanupDefinitions[resource.kind].endpoint}?id=${encodeURIComponent(resource.id)}`,
            deleteOptions
          ), `删除 ${label}`)
          await this.confirmDeleted(resource, caseRecord)
          resource.cleanup = 'DELETED_VERIFIED'
        } catch (error) {
          if (resource.kind !== 'warehouse' || !/已被引用，不能删除/.test(error.message)) {
            throw error
          }
          return await this.retainReferencedWarehouse(resource, caseRecord)
        }
      }
      addCheck(caseRecord, `专属 ${label} 清理回读已确认`, true, resource.cleanup)
      return true
    } catch (error) {
      resource.cleanup = 'RETAINED_UNVERIFIED'
      caseRecord.notes.push(`清理 ${label} 失败，残留或未清理：${error.message}`)
      addCheck(caseRecord, `专属 ${label} 清理回读已确认`, false, error.message)
      return false
    }
  }

  async normalizeWmsOutputCleanup (outputId) {
    const rows = asList(await this.api.getBusiness(
      `/wms/operation/task/page?pageNo=1&pageSize=100&sourceBillType=MesStkIo&sourceBillId=${encodeURIComponent(outputId)}`
    ))
    for (const task of rows.filter((item) => item?.taskType === 'PUTAWAY')) {
      if (task.status === 'PENDING') {
        await this.api.postBusiness('/wms/operation/task/start', {
          id: task.id, remark: `${this.marker} cleanup start`
        })
      }
      if (task.status === 'PENDING' || task.status === 'IN_PROGRESS') {
        await this.api.postBusiness('/wms/operation/task/complete', {
          id: task.id,
          actualQuantity: task.plannedQuantity,
          remark: `${this.marker} cleanup complete`
        })
      }
    }
  }

  async cleanup (caseRecord) {
    const results = []
    const clean = async (kind, id) => {
      const resource = this.owned.find((item) => item.kind === kind && item.id === String(id))
      if (!resource) {
        caseRecord.notes.push(`清理 ${kind}=${id} 未执行：没有专属所有权登记`)
        addCheck(caseRecord, `专属 ${kind}=${id} 清理所有权已确认`, false)
        results.push(false)
        return
      }
      results.push(await this.cleanupResource(resource, caseRecord))
    }
    for (const outputId of [...this.outputIds].reverse()) await clean('output', outputId)
    for (const resource of this.owned.filter((item) => item.kind === 'pickBill').reverse()) {
      results.push(await this.cleanupResource(resource, caseRecord))
    }
    for (const resource of this.owned.filter((item) => item.kind === 'qualityInspection').reverse()) {
      results.push(await this.cleanupResource(resource, caseRecord))
    }
    for (const reportId of [...this.reportIds].reverse()) await clean('report', reportId)
    for (const work of this.works) await clean('work', work.id)
    for (const task of this.tasks) await clean('task', task.id)
    if (this.order) await clean('order', this.order.id)
    for (const material of this.owned.filter((item) => item.kind === 'material')) {
      try {
        await this.assertCleanupOwnership(material)
        const detail = unwrap(await this.api.getBusiness(
          `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`
        ), '清理前物料回读')
        assert.equal(String(detail?.id), material.id, '专属物料所有权主键不匹配')
        assert.equal(detail.code, material.identity, '专属物料所有权编码不匹配')
        assert.equal(detail.remark, this.marker, '专属物料所有权标记不匹配')
        const hasDefaultReferences = [
          detail?.defaultProdBom,
          detail?.defaultWare,
          detail?.defaultWareArea,
          detail?.defaultWareLocation
        ].some((value) => String(value ?? '') !== '')
        if (hasDefaultReferences) {
          // Preserve fields required by material validation, never replay the full entity.
          unwrap(await this.api.putBusiness('/mes/basMaterial/edit', {
            id: material.id,
            code: detail.code,
            name: detail.name,
            auxName: detail.auxName,
            model: detail.model,
            type: detail.type,
            unitId: detail.unitId,
            inventoryNature: detail.inventoryNature,
            purchased: detail.purchased,
            produced: detail.produced,
            saled: detail.saled,
            parented: detail.parented,
            isMaterial: detail.isMaterial,
            assembled: detail.assembled,
            batchManaged: detail.batchManaged,
            periodManaged: detail.periodManaged,
            periodDays: detail.periodDays,
            colorManaged: detail.colorManaged,
            brandManaged: detail.brandManaged,
            oneBarcode: detail.oneBarcode,
            leadTime: detail.leadTime,
            bufferTime: detail.bufferTime,
            defaultProdBom: '',
            defaultWare: '',
            defaultWareArea: '',
            defaultWareLocation: ''
          }), '清理物料默认生产 BOM')
          const cleared = unwrap(await this.api.getBusiness(
            `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`
          ), '清理后物料回读')
          assert.equal(String(cleared?.id), material.id, '清理后专属物料主键不匹配')
          assert.equal(cleared.code, material.identity, '清理后专属物料编码不匹配')
          assert.equal(cleared.remark, this.marker, '清理后专属物料标记不匹配')
          assert.equal(String(cleared.defaultProdBom ?? ''), '', '专属物料默认生产 BOM 未清空')
          assert.equal(String(cleared.defaultWare ?? ''), '', '专属物料默认仓库未清空')
          assert.equal(String(cleared.defaultWareArea ?? ''), '', '专属物料默认库区未清空')
          assert.equal(String(cleared.defaultWareLocation ?? ''), '', '专属物料默认库位未清空')
        }
      } catch (error) {
        caseRecord.notes.push(`清理物料 ${material.id} 默认生产 BOM 失败，残留或未清理：${error.message}`)
        addCheck(caseRecord, `专属物料 ${material.id} 默认生产 BOM 清理已确认`, false, error.message)
        results.push(false)
      }
    }
    const cleanupOrder = [
      'opening', 'inventory', 'qualityBinding', 'route', 'procedure',
      'qualityPlan', 'qualityItem', 'bom', 'material', 'location', 'area', 'warehouse'
    ]
    for (const kind of cleanupOrder) {
      for (const resource of this.owned.filter((item) => item.kind === kind).reverse()) {
        results.push(await this.cleanupResource(resource, caseRecord))
      }
    }
    for (const team of this.owned.filter((item) => item.kind === 'team')) {
      results.push(await this.cleanupResource(team, caseRecord))
    }
    const complete = results.every(Boolean)
    this.fixtureRecord.cleanup = complete ? 'VERIFIED' : 'INCOMPLETE'
    const retainedOpening = this.owned.some((resource) => resource.kind === 'opening')
    caseRecord.notes.push(complete
      ? `AUTOTEST 夹具 ${this.marker} 清理已回读确认${retainedOpening
          ? '；作废期初单保留审计历史'
          : ''}。`
      : `AUTOTEST 夹具 ${this.marker} 清理未完成，残留与失败证据已记录。`)
  }
}
