import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { asList, assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'

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
  task: { table: 'mes_prod_work_task', endpoint: '/mes/prodWorkTask/delete' },
  work: { table: 'mes_prod_work', endpoint: '/mes/prodWork/delete' },
  order: { table: 'mes_prod_order', endpoint: '/mes/prodOrder/delete' },
  opening: { table: 'mes_stk_io', endpoint: '/mes/stkIo/void' },
  route: { table: 'mes_wms_tech_route', endpoint: '/mes/wmsTechRoute/delete' },
  procedure: { table: 'mes_wms_procedure', endpoint: '/mes/wmsProcedure/delete' },
  bom: { table: 'mes_wms_assemble', endpoint: '/mes/wmsAssemble/delete' },
  material: { table: 'mes_bas_material', endpoint: '/mes/basMaterial/delete' },
  location: { table: 'mes_wms_house_location', endpoint: '/mes/wms-house-location/delete' },
  area: { table: 'mes_wms_house_area', endpoint: '/mes/wmsHouseArea/delete' },
  warehouse: { table: 'mes_wms_ware_house', endpoint: '/mes/wmsWareHouse/delete' },
  team: { table: 'mes_team_manage', endpoint: '/mes/teamManage/delete' }
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

export const executionMarker = (caseId) =>
  `AUTOTEST-${caseId}-${Date.now().toString(36).slice(-6).toUpperCase()}-${randomBytes(1).toString('hex').toUpperCase()}`

/**
 * 为任务暂停和监控用例创建一条独立的生产计划-工单-任务链路。
 *
 * 数据只通过正式 API 写入，统一使用 AUTOTEST-<catalog-id>-* 标记；清理时优先
 * 走业务删除/取消接口，接口拒绝时保留数据并在报告中写明残留。
 */
export class ExecutionWorkflowFixture {
  constructor (api, record, caseId, { overdue = false, schedule = true, withTeam = true } = {}) {
    this.api = api
    this.record = record
    this.caseId = caseId
    this.marker = executionMarker(caseId)
    this.shortCode = `AUTOTEST-${caseId}-${randomBytes(1).toString('hex').toUpperCase()}`
    this.teamCode = `AT-${caseId.split('-').pop()}-${randomBytes(1).toString('hex').toUpperCase()}-T`
    this.teamName = `AUTOTEST-${caseId.split('-').pop()}-${randomBytes(1).toString('hex').toUpperCase()}`
    this.overdue = overdue
    this.shouldSchedule = schedule
    this.withTeam = withTeam
    this.owned = []
    this.works = []
    this.tasks = []
    this.reportIds = []
    this.record.executionFixture = {
      caseId,
      marker: this.marker,
      overdue,
      schedule,
      withTeam,
      resources: this.owned
    }
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
    this.material = await this.createMaterial('FG', false)
    this.component = await this.createMaterial('RM', true)
    this.bom = await this.createBom()
    this.opening = await this.createOpeningInventory()
    this.procedure = await this.createProcedure()
    this.route = await this.createRoute()
    this.order = await this.createOrder()
    await this.approveAndSplit()
    if (this.shouldSchedule) {
      await this.scheduleTask()
    }
    addCheck(caseRecord, '专属 AUTOTEST 生产链路已正式创建并回读',
      this.owned.length >= 8 && this.works.length === 1 &&
        (!this.shouldSchedule || this.tasks.length === 1),
      JSON.stringify({
        marker: this.marker,
        orderId: this.order.id,
        workId: this.works[0]?.id,
        taskId: this.tasks[0]?.id,
        scheduled: this.shouldSchedule
      }))
    return this
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

  async createLocation () {
    const code = `${this.shortCode}-LC`
    await this.api.postBusiness('/mes/wms-house-location/create', {
      locationName: `${this.marker}-库位`,
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
      source: 'mixed',
      produced: 'Y',
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
      defaultRecord: 'N',
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
        wareLocationId: this.location.id,
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
        isFeed: 0,
        isQuality: 0,
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
    unwrap(await this.api.putBusiness('/mes/prodWork/edit', {
      id: work.id,
      processId: this.route.id
    }), '生产工单绑定工艺路线')
    if (!this.withTeam) {
      // 工序未配置班组时必须被预排产门禁明确阻断。
      const preSchedule = await this.api.request(
        'GET',
        `/mes/prodWork/preScheduleProduct?processId=${encodeURIComponent(this.route.id)}&workId=${encodeURIComponent(work.id)}`
      )
      assert.equal(preSchedule?.code, 500, '未配置班组时预排产必须返回业务错误')
      assert.match(String(preSchedule?.msg || preSchedule?.message || ''), /班组/)
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
      remark: this.marker
    }), '工单任务绑定产线')
    const taskReadback = unwrap(await this.api.getBusiness(
      `/mes/prodWorkTask/queryById?id=${encodeURIComponent(task.id)}`
    ), '工单任务绑定后回读')
    this.assertOwnedTask(taskReadback, task.id)
    assert.equal(String(taskReadback.prodLineId), this.lineId)
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
    const value = (text) => `'${sqlText(text)}'`
    let ownership
    if (resource.kind === 'work') {
      ownership = `prod_order_id=${value(this.order.id)} AND remark=${value(this.marker)}`
    } else if (resource.kind === 'task' || resource.kind === 'report') {
      ownership = `work_ticket_id=${value(this.works[0].id)}`
      if (resource.kind === 'task') {
        ownership += ` AND product_id=${value(this.material.id)} AND routing=${value(this.route.id)}`
      } else {
        ownership += ` AND remark=${value(this.marker)}`
      }
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
       WHERE tenant_id=1 AND deleted=0 AND id=${value(resource.id)} AND ${ownership}`,
      `清理 ${resource.kind}`
    )
    assert.equal(id, resource.id, '清理资源所有权主键不匹配')
  }

  async confirmDeleted (resource, caseRecord) {
    let apiActive = false
    let apiEvidence = ''
    if (resource.kind === 'work') {
      try {
        const detail = unwrap(await this.api.getBusiness(
          `/mes/prodWork/queryById?id=${encodeURIComponent(resource.id)}`
        ), '删除后工单回读')
        apiActive = detail != null && detail.deleted !== true && String(detail.deleted) !== '1'
        apiEvidence = JSON.stringify(detail)
      } catch (error) {
        // Query APIs reject missing rows; only independent SQL can prove deletion.
        apiEvidence = error.message
      }
    }
    const snapshot = await runReadOnlySql(
      `SELECT id, deleted+0 FROM ${cleanupDefinitions[resource.kind].table}
       WHERE tenant_id=1 AND id='${sqlText(resource.id)}'`
    )
    caseRecord.database = [...(caseRecord.database || []), {
      stage: 'execution-cleanup', kind: resource.kind, id: resource.id, apiEvidence, ...snapshot
    }]
    if (!snapshot.available) throw new Error(`清理未完成：${snapshot.reason}`)
    assert(Array.isArray(snapshot.rows) && snapshot.rows.length <= 1 &&
      snapshot.rows.every((row) => String(row[0]) === resource.id && String(row[1]) === '1') &&
      !apiActive, `${resource.kind}=${resource.id} 删除后仍有残留或删除证据无效`)
  }

  async cleanupResource (resource, caseRecord) {
    const label = `${resource.kind}=${resource.id}`
    try {
      await this.assertCleanupOwnership(resource)
      if (resource.kind === 'work') {
        try {
          unwrap(await this.api.request('POST', '/mes/prodWork/cancel', {
            id: resource.id, prodWorkOrderId: resource.id
          }), '取消专属工单')
        } catch (error) {
          caseRecord.notes.push(`取消工单 ${resource.id} 失败：${error.message}`)
        }
      }
      if (resource.kind === 'opening') {
        unwrap(await this.api.putBusiness('/mes/stkIo/void', { id: resource.id }), '作废专属期初库存')
        const detail = unwrap(await this.api.getBusiness(
          `/mes/stkIo/queryById?id=${encodeURIComponent(resource.id)}`
        ), '作废后期初库存回读')
        assert.equal(String(detail?.id), resource.id, '专属期初库存所有权主键不匹配')
        assert.equal(detail.remark, this.marker, '专属期初库存所有权标记不匹配')
        assert.equal(Number(detail.isVoided), 1, '专属期初库存未确认作废')
        resource.cleanup = 'VOIDED_RETAINED'
      } else {
        unwrap(await this.api.deleteBusiness(
          `${cleanupDefinitions[resource.kind].endpoint}?id=${encodeURIComponent(resource.id)}`
        ), `删除 ${label}`)
        await this.confirmDeleted(resource, caseRecord)
        resource.cleanup = 'DELETED_VERIFIED'
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
    for (const reportId of [...this.reportIds].reverse()) await clean('report', reportId)
    for (const task of this.tasks) await clean('task', task.id)
    for (const work of this.works) await clean('work', work.id)
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
        if (String(detail?.defaultProdBom || '') !== '') {
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
            defaultProdBom: ''
          }), '清理物料默认生产 BOM')
          const cleared = unwrap(await this.api.getBusiness(
            `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`
          ), '清理后物料回读')
          assert.equal(String(cleared?.id), material.id, '清理后专属物料主键不匹配')
          assert.equal(cleared.code, material.identity, '清理后专属物料编码不匹配')
          assert.equal(cleared.remark, this.marker, '清理后专属物料标记不匹配')
          assert.equal(String(cleared.defaultProdBom ?? ''), '', '专属物料默认生产 BOM 未清空')
        }
      } catch (error) {
        caseRecord.notes.push(`清理物料 ${material.id} 默认生产 BOM 失败，残留或未清理：${error.message}`)
        addCheck(caseRecord, `专属物料 ${material.id} 默认生产 BOM 清理已确认`, false, error.message)
        results.push(false)
      }
    }
    const cleanupOrder = ['opening', 'route', 'procedure', 'bom', 'material', 'location', 'area', 'warehouse']
    for (const kind of cleanupOrder) {
      for (const resource of this.owned.filter((item) => item.kind === kind).reverse()) {
        results.push(await this.cleanupResource(resource, caseRecord))
      }
    }
    for (const team of this.owned.filter((item) => item.kind === 'team')) {
      results.push(await this.cleanupResource(team, caseRecord))
    }
    const complete = results.every(Boolean)
    this.record.executionFixture.cleanup = complete ? 'VERIFIED' : 'INCOMPLETE'
    caseRecord.notes.push(complete
      ? `AUTOTEST 夹具 ${this.marker} 清理已回读确认；作废期初单保留审计历史。`
      : `AUTOTEST 夹具 ${this.marker} 清理未完成，残留与失败证据已记录。`)
  }
}
