import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { createApiClient, apiHealth } from '../lib/api.mjs'
import { assertBusinessSuccess, asList } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { launchBrowser, login, openRoute, saveScreenshot, waitForPageReady } from '../lib/browser.mjs'
import { findMenuRouteByComponent } from '../suites/base-partner.mjs'
import { createOpeningInventory, createWarehouseFixture } from '../lib/wms-fixtures.mjs'
import {
  addCheck, caseOutcome, createCaseRecord, createRunRecord, ensureDir, finishCase, writeReport
} from '../lib/report.mjs'

const unwrap = (body) => assertBusinessSuccess(body, 'production fixture').data
const resources = {
  material: ['mes_bas_material', 'code', 'remark', '/mes/basMaterial/add'],
  bom: ['mes_wms_assemble', 'code', 'mark', '/mes/wmsAssemble/add'],
  procedure: ['mes_wms_procedure', 'code', 'mark', '/mes/wmsProcedure/add'],
  route: ['mes_wms_tech_route', 'code', 'mark', '/mes/wmsTechRoute/addMain'],
  order: ['mes_prod_order', 'bill_no', 'remark', '/mes/prodOrder/add']
}
export const productionId = (value) => {
  assert(!Number.isInteger(value) || Number.isSafeInteger(value), 'Unsafe production ID')
  assert(/^[1-9]\d*$/.test(String(value ?? '')), 'Invalid production ID')
  return String(value)
}
export function assertProductionScope(settings = config) {
  assert.equal(settings.target, 'local')
  assert.equal(String(settings.tenantId), '1')
  assert.equal(settings.tenantName, 'CFOR 标准平台')
  assert.equal(settings.db.name, 'cfor_admin_standard')
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083']]) {
    const url = new URL(base)
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local endpoints required')
    assert.equal(url.port, port)
    assert(!url.username && !url.password)
  }
}
export function productionMarker(value) {
  assert(/^E2E-PROD-[A-Z0-9-]+$/.test(value), 'Exclusive production marker required')
  return value
}
export function productionTime(time = new Date()) {
  const date = new Date(time)
  assert(Number.isFinite(date.getTime()), 'Invalid production date')
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(date)
}
const check = (caseRecord, name, passed, details) => {
  addCheck(caseRecord, name, passed, JSON.stringify(details))
  assert(passed, name)
}
export function productionOrderBody(marker, material, component, unitId, bom) {
  productionMarker(marker)
  return {
    prodNo: `${marker}-PLAN`, billNo: `${marker}-PLAN`, prodType: '1', remark: marker,
    // Keep the fixture overdue by the backend's "before today's midnight" rule.
    expectStartDate: productionTime(Date.now() - 5 * 3600000),
    expectEndDate: productionTime(Date.now() - 3 * 3600000),
    prodOrderSubList: [{
      materialId: productionId(material.id), qty: 4,
      wmsAssembleId: productionId(bom.id), remark: marker, urgentLevel: '1'
    }],
    prodOrderMaterialList: [{
      materialId: productionId(component.id),
      unitId: productionId(unitId),
      bomNum: 1,
      quantity: 4,
      claimed: 0,
      requested: 0,
      afterSaveClaimed: 0,
      afterSaveRequested: 0,
      remark: marker
    }]
  }
}
export class ProductionFixtures {
  constructor(api, record, sql = runReadOnlySql) {
    this.api = api
    this.record = record
    this.sql = sql
    this.marker = `E2E-PROD-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
    this.owned = []
    this.works = []
    this.tasks = []
    record.productionFixture = { marker: this.marker, resources: this.owned,
      retention: 'Retained E2E facts for browser inspection; no shared documents modified.' }
  }
  async query(stage, statement) {
    const result = await this.sql(statement)
    assert(result.available, 'BLOCKED: local database evidence required')
    this.record.database = [...(this.record.database || []), { stage, ...result }]
    return result.rows
  }
  async ownership(resource) {
    productionMarker(this.marker)
    const id = productionId(resource?.id)
    if (resource.kind === 'work' || resource.kind === 'task') {
      await this.ownership(this.order)
      const rows = resource.kind === 'work'
        ? await this.query('own-work', `SELECT id,prod_order_id,material_id,remark FROM mes_prod_work
          WHERE tenant_id=1 AND deleted=0 AND id='${id}'`)
        : await this.query('own-task', `SELECT task.id,work.prod_order_id,task.product_id,work.remark
          FROM mes_prod_work_task task JOIN mes_prod_work work ON work.id=task.work_ticket_id
          WHERE task.tenant_id=1 AND work.tenant_id=1 AND task.is_deleted=0 AND work.deleted=0
          AND task.id='${id}'`)
      assert.equal(rows.length, 1, 'Exclusive generated resource missing')
      assert.equal(rows[0][1], this.order.id)
      assert.equal(rows[0][2], this.material.id)
      assert.equal(rows[0][3], this.marker)
      return resource
    }
    const [table, identity, markerColumn] = resources[resource.kind] || []
    assert(table, 'Unknown production resource')
    const rows = await this.query(`own-${resource.kind}`,
      `SELECT id,tenant_id,${identity},${markerColumn} FROM ${table}
       WHERE tenant_id=1 AND deleted=0 AND id='${id}'`)
    assert.equal(rows.length, 1, 'Exclusive production resource missing')
    assert.deepEqual(rows[0], [id, '1', resource.identity, this.marker], 'Production ownership mismatch')
    return resource
  }
  async create(kind, body) {
    const [table, identity, markerColumn, endpoint] = resources[kind]
    const name = kind === 'order' ? body.prodNo : body.code
    assert(name?.startsWith(`${productionMarker(this.marker)}-`), 'Exclusive identity required')
    assert.equal(body[markerColumn], this.marker)
    const resource = { kind, identity: name, marker: this.marker, status: 'creating',
      request: { method: 'POST', endpoint, body } }
    this.owned.push(resource)
    const response = await this.api.postBusiness(endpoint, body)
    const rows = await this.query(`recover-${kind}`,
      `SELECT id FROM ${table} WHERE tenant_id=1 AND deleted=0
       AND ${identity}='${name}' AND ${markerColumn}='${this.marker}'`)
    assert.equal(rows.length, 1, `Create ${kind} must persist exactly one owned fact`)
    resource.id = productionId(rows[0][0])
    resource.response = response
    await this.ownership(resource)
    resource.status = 'created'
    return resource
  }
  async setup(caseRecord = this.record) {
    assertProductionScope()
    await assertLocalWriteSafety(caseRecord)
    const templates = asList(unwrap(await this.api.getBusiness('/mes/basMaterial/list/enabled')))
    const unit = templates.find((item) => /^[1-9]\d*$/.test(String(item.unitId || '')))?.unitId
    assert(unit, 'BLOCKED: existing valid unit required')
    const workplaces = asList(unwrap(await this.api.getBusiness('/mes/monitor/workplaces')))
    assert(workplaces.length, 'BLOCKED: authorized workplace required')
    this.workplace = workplaces[0]
    const lines = await this.query('existing-line',
      `SELECT id FROM mes_work_line WHERE tenant_id=1 AND deleted=0
       AND work_place_id='${productionId(this.workplace.id)}' ORDER BY id LIMIT 1`)
    assert.equal(lines.length, 1, 'BLOCKED: existing authorized line required')
    this.lineId = productionId(lines[0][0])
    const wmsFixture = await createWarehouseFixture(this.api, caseRecord, this.marker, 1)
    const materialBody = (suffix, component) => ({
      code: `${this.marker}-${suffix}`, name: `${this.marker}-${suffix}`, unitId: productionId(unit),
      remark: this.marker, isEnabled: 1, inventoryNature: 'STOCK', virtualGoods: 'N',
      defaultWare: wmsFixture.warehouse.id,
      defaultWareArea: wmsFixture.area.id,
      defaultWareLocation: wmsFixture.location.id,
      source: 'mixed', produced: 'Y', purchased: 'Y', saled: 'Y',
      parented: component ? 'N' : 'Y', isMaterial: component ? 'Y' : 'N',
      assembled: 'N', soned: 'N', batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N',
      gradeManaged: 'N', colorManaged: 'N', brandManaged: 'N', backflush: 'N',
      leadTime: 1, bufferTime: 1, refCost: 10, refPrice: 20
    })
    this.material = await this.create('material', materialBody('FG', false))
    this.component = await this.create('material', materialBody('RM', true))
    const opening = await createOpeningInventory(
      this.api, caseRecord, wmsFixture, this.component, unit, 4)
    assert(opening.approved, 'BLOCKED: 专属 BOM 子件期初库存未正式生效')
    this.wmsFixture = wmsFixture
    this.openingInventory = opening
    const employeeCode = `${this.marker}-EMP`
    const employeeBody = {
      name: `${this.marker}-员工`,
      jobNumber: employeeCode,
      mobile: `137${Date.now().toString().slice(-8)}`,
      entryStatus: 1,
      type: 1,
      entryTime: '2026-01-01T00:00:00',
      probation: 0,
      createUserAccount: true,
      userAccountUsername: employeeCode,
      userAccountPassword: `${this.marker.slice(-10)}Aa1!`
    }
    const employeeResponse = await this.api.postBusiness('/hrm/employee/create', employeeBody)
    const employeeId = productionId(unwrap(employeeResponse))
    const employee = unwrap(await this.api.getBusiness(`/hrm/employee/get?id=${employeeId}`))
    assert.equal(String(employee.id), employeeId, '专属 HRM 员工回读失败')
    assert.equal(employee.jobNumber, employeeCode, '专属 HRM 员工工号不匹配')
    assert(employee.userId, '专属 HRM 员工未生成系统登录账号')
    this.employee = {
      id: employeeId,
      userId: productionId(employee.userId),
      identity: employeeCode,
      name: employee.name
    }
    this.teamCode = `${this.marker}-TEAM`
    await this.api.postBusiness('/mes/teamManage/add', {
      teamId: this.teamCode,
      teamName: `${this.marker}-班组`,
      leaderId: employeeId,
      teamType: 0,
      shiftStartTime: '20:00:00',
      shiftEndTime: '08:00:00',
      status: '0',
      workPlaceId: this.workplace.id,
      remark: this.marker,
      teamManageSubList: [{ memberId: employeeId }]
    })
    const teamPage = asList(unwrap(await this.api.getBusiness(
      `/mes/teamManage/list?pageNo=1&pageSize=100&teamId=${encodeURIComponent(this.teamCode)}`)))
    const team = teamPage.find((item) => String(item.teamId) === this.teamCode)
    assert(team?.id, '专属生产班组创建后无法回读')
    const teamId = productionId(team.id)
    const teamMembers = asList(unwrap(await this.api.getBusiness(
      `/mes/teamManage/queryMesTeamManageSubByMainId?id=${teamId}`)))
    assert(teamMembers.some((item) => String(item.memberId) === employeeId),
      '专属生产班组未回读 HRM 员工成员')
    this.team = { id: teamId, identity: this.teamCode, name: team.teamName }
    this.record.productionFixture.employee = this.employee
    this.record.productionFixture.team = this.team
    this.bom = await this.create('bom', {
      code: `${this.marker}-BOM`, stockId: this.material.id, stockCount: 1,
      version: '1', versionDesc: this.marker, defaultRecord: 'N', bomUsage: 'PRODUCTION',
      unitId: productionId(unit), mark: this.marker,
      wmsAssembleSubList: [{ stockId: this.component.id, subStockCount: 1,
        unitId: productionId(unit), lossRate: 0, mark: this.marker }]
    })
    this.procedure = await this.create('procedure', {
      code: `${this.marker}-PROC`, name: `${this.marker}-PROC`, mark: this.marker,
      workshopId: this.workplace.id, productionLineId: this.lineId, baseHours: 1,
      basePrice: 0, pieceRate: 0, hourlyWage: 0, reportBaseQuantity: 1,
      overPlanReportRatio: 0, beforeIntervalTimes: 0, afterIntervalTimes: 0,
      bufferTime: 0, procedureRelation: 'ES', isLastProcess: 'Y', pid: '0', hasChild: 'N',
      teamIds: this.team.id, defaultTeam: this.team.id,
      chargePersonId: this.employee.id
    })
    this.route = await this.create('route', {
      code: `${this.marker}-ROUTE`, name: `${this.marker}-ROUTE`, version: 'V1.0',
      mark: this.marker, type: '1', designMode: 'sequential', inboundType: 'FINISHED',
      isStrict: 'Y', wmsTechRouteSubList: [{
        procedureId: this.procedure.id, procedureName: this.procedure.identity,
        sortOrder: 1, isFeed: 0, isQuality: 0, isFinished: 1, isVirtual: 0, mark: this.marker
      }]
    })
    this.order = await this.create('order', productionOrderBody(
      this.marker, this.material, this.component, unit, this.bom))
    return this
  }
  async readOrder() {
    await this.ownership(this.order)
    return unwrap(await this.api.getBusiness(`/mes/prodOrder/queryById/dictText?id=${this.order.id}`))
  }
  async splitAndSchedule(caseRecord) {
    assert(this.order, 'BLOCKED: owned production order required')
    await this.ownership(this.order)
    unwrap(await this.api.putBusiness('/mes/prodOrder/check', {
      id: this.order.id, approvalResultType: '1', approvalRemark: this.marker
    }))
    const approved = await this.readOrder()
    check(caseRecord, '专属计划通过正式审核且可下达', String(approved.billStage ?? approved.docStage) === '24', approved)
    const subs = asList(unwrap(await this.api.getBusiness(
      `/mes/prodOrder/queryMesProdOrderSubByMainId?id=${this.order.id}`)))
    assert.equal(subs.length, 1)
    const body = [2, 2].map((qty, index) => ({
      prodOrderId: this.order.id, prodOrderSubId: productionId(subs[0].id),
      qty, prodType: '1', operateType: 1, batchNo: `${this.marker}-B${index + 1}`
    }))
    await this.ownership(this.order)
    unwrap(await this.api.postBusiness('/mes/prodWork/transferWorkOrder', body))
    const works = asList(unwrap(await this.api.getBusiness(
      `/mes/prodWork/getWorkByProdOrderId?prodOrderId=${this.order.id}`)))
    this.works = works.map((work) => ({ kind: 'work', id: productionId(work.id), ...work }))
    check(caseRecord, '4 件专属计划拆成两张 2 件工单，关联同一计划且数量守恒',
      works.length === 2 && works.every((work) => String(work.prodOrderId) === this.order.id) &&
      works.reduce((sum, work) => sum + Number(work.qty), 0) === 4, works)
    for (const work of this.works) {
      await this.ownership(work)
      const before = await this.api.request('POST', '/mes/prodWork/scheduleProduct', {
        id: work.id, prodWorkOrderId: work.id, qty: 2,
        startDate: productionTime(Date.now() - 3 * 3600000),
        endDate: productionTime(Date.now() - 3600000), remark: this.marker
      })
      check(caseRecord, '未配工艺的专属工单排产明确拒绝且未生成任务',
        before?.code === 500 && String(before.message || before.msg).includes('未找到工艺路线'), before)
      const noTasks = asList(unwrap(await this.api.getBusiness(
        `/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=${work.id}`)))
      check(caseRecord, '失败排产回滚，没有孤立任务', noTasks.length === 0, noTasks)
      await this.ownership(work)
      unwrap(await this.api.putBusiness('/mes/prodWork/edit', { id: work.id, processId: this.route.id }))
      await this.ownership(work)
      unwrap(await this.api.postBusiness('/mes/prodWork/scheduleProduct', {
        id: work.id, prodWorkOrderId: work.id, qty: 2,
        startDate: productionTime(Date.now() - 3 * 3600000),
        endDate: productionTime(Date.now() - 3600000), remark: this.marker
      }))
      const tasks = asList(unwrap(await this.api.getBusiness(
        `/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=${work.id}`)))
      check(caseRecord, '正式排产生成关联工单、产品、工序及路线的任务',
        tasks.length === 1 && String(tasks[0].productId) === this.material.id &&
        String(tasks[0].routing) === this.route.id &&
        String(tasks[0].processId) === this.procedure.id && Number(tasks[0].taskNum) === 2, tasks)
      const task = { ...tasks[0], kind: 'task', id: productionId(tasks[0].id) }
      await this.ownership(task)
      unwrap(await this.api.putBusiness('/mes/prodWorkTask/edit', {
        id: task.id, prodLineId: this.lineId, remark: this.marker
      }))
      this.tasks.push(task)
    }
  }
}

const pageSpecs = {
  order: ['mes/produce/order/index', '请输入计划单号'],
  work: ['mes/produce/workorder/index', '请输入工单编号'],
  task: ['mes/produce/productionTask/index', '请输入工序名称'],
  report: ['mes/produce/reportWork/index', '请输入工单编号']
}

async function fixedRightActionRow(page, mainRow) {
  const rowMeta = await mainRow.evaluate((element) => {
    const body = element.closest('.vxe-table--body-wrapper')
    if (!body) return { rowIndex: -1, rowKeys: [] }
    const isVisible = (row) => {
      const rect = row.getBoundingClientRect()
      return row.offsetParent !== null && rect.width > 0 && rect.height > 0
    }
    const rowIndex = [...body.querySelectorAll('.vxe-body--row')]
      .filter(isVisible)
      .indexOf(element)
    const rowKeys = ['rowid', 'data-rowid', 'row-index', 'data-index', 'aria-rowindex']
      .map((name) => [name, element.getAttribute(name)])
      .filter(([, value]) => value)
    return { rowIndex, rowKeys }
  })
  assert(rowMeta.rowIndex >= 0, 'Unable to resolve VXE main row index')

  // VXE renders fixed columns as sibling wrappers, so the main row's closest
  // table node is not always the owner of the fixed-right rows.
  const wrappers = page.locator('.vxe-table--fixed-right-wrapper')
  const wrapperCount = await wrappers.count()
  for (let wrapperIndex = 0; wrapperIndex < wrapperCount; wrapperIndex += 1) {
    const wrapper = wrappers.nth(wrapperIndex)
    const rows = wrapper.locator('.vxe-body--row')
    const matchingIndex = await rows.evaluateAll((items, rowKeys) => items.findIndex((row) => {
      const rect = row.getBoundingClientRect()
      if (row.offsetParent === null || rect.width <= 0 || rect.height <= 0) return false
      if (!row.querySelector('.cell-actives')) return false
      return rowKeys.some(([name, value]) => row.getAttribute(name) === value)
    }), rowMeta.rowKeys)
    if (matchingIndex >= 0) {
      const actionRow = rows.nth(matchingIndex)
      await actionRow.scrollIntoViewIfNeeded()
      await actionRow.waitFor({ state: 'visible', timeout: 20000 })
      return actionRow
    }

    const visibleIndices = await rows.evaluateAll((items) => items
      .map((row, index) => {
        const rect = row.getBoundingClientRect()
        return row.offsetParent !== null && rect.width > 0 && rect.height > 0 &&
          row.querySelector('.cell-actives') ? index : -1
      })
      .filter((index) => index >= 0))
    if (rowMeta.rowIndex < visibleIndices.length) {
      const actionRow = rows.nth(visibleIndices[rowMeta.rowIndex])
      await actionRow.scrollIntoViewIfNeeded()
      await actionRow.waitFor({ state: 'visible', timeout: 20000 })
      return actionRow
    }
  }

  throw new Error(`Unable to resolve VXE fixed-right row index=${rowMeta.rowIndex}`)
}

export async function verifyProductionPage(context, kind, text) {
  const { page, api, caseRecord, outputDir, record } = context
  const [component, placeholder] = pageSpecs[kind]
  const menus = unwrap(await api.getPermissionInfo()).menus
  const route = findMenuRouteByComponent(menus, component)
  assert(route, `BLOCKED: no authorized route for ${component}`)
  await openRoute(page, route, { readySelector: `input[placeholder="${placeholder}"]` })
  if (text) {
    await page.getByPlaceholder(placeholder, { exact: true }).first().fill(text)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await waitForPageReady(page)
    await page.locator('.vxe-table--body, .el-table__body').getByText(text, { exact: false })
      .first().waitFor({ state: 'visible', timeout: 20000 })
  }
  check(caseRecord, `${kind} 真实业务页${text ? '可见专属数据' : '控件可用'}且不是 404/空壳`,
    !(await page.locator('body').innerText()).includes('页面不存在'),
    { route, searched: text })
  caseRecord.evidence.push(await saveScreenshot(page, outputDir, `${caseRecord.id}-${kind}`, record))
  return route
}

export async function verifyProductionCreateDialog(context) {
  const { page, caseRecord, outputDir, record } = context
  await verifyProductionPage(context, 'order')
  const button = page.getByRole('button', { name: '新增', exact: true })
  check(caseRecord, '生产计划新增按钮可见且可用',
    await button.isVisible() && await button.isEnabled(), {})
  await button.click()
  const dialog = page.locator('.el-dialog:visible').last()
  try {
    await dialog.waitFor({ state: 'visible', timeout: 20000 })
    await dialog.getByText('生产单号', { exact: true }).first().waitFor({ state: 'visible' })
    const text = await dialog.innerText()
    const normalizedText = text.replace(/\s+/g, '')
    check(caseRecord, '新增弹窗真实展示生产单号、单据类型、物料和保存控件',
      ['生产单号', '单据类型', '存货', '保存'].every((label) => normalizedText.includes(label)), text)
    caseRecord.evidence.push(await saveScreenshot(page, outputDir, 'production-order-create-dialog', record))
  } finally {
    if (await dialog.isVisible().catch(() => false)) {
      const close = dialog.locator('.el-dialog__headerbtn').first()
      if (await close.isVisible()) await close.click()
    }
  }
}

export async function verifyProductionReportDialog(context, fixture) {
  const { page, caseRecord, outputDir, record } = context
  assert(fixture?.tasks?.length, 'BLOCKED: owned scheduled task required for report dialog')
  await verifyProductionPage(context, 'task', fixture.procedure.identity)
  const task = fixture.tasks[0]
  const row = page.locator(
    '.vxe-table--body-wrapper.body--wrapper:visible .vxe-body--row:visible'
  ).filter({ hasText: task.workOrderTaskCode }).first()
  const actionRow = await fixedRightActionRow(page, row)
  await actionRow.locator('.cell-actives').getByText('报工', { exact: true }).first().click()
  const dialog = page.locator('.el-dialog:visible').last()
  try {
    await dialog.waitFor({ state: 'visible', timeout: 20000 })
    // The dialog shell renders before the task queue/detail requests finish.
    // Wait for the selected task before asserting the loaded workbench state.
    await dialog.getByText(task.workOrderTaskCode, { exact: true }).first()
      .waitFor({ state: 'visible', timeout: 20000 })
    await dialog.getByPlaceholder('请输入作业员名称', { exact: true }).waitFor({ state: 'visible' })
    check(caseRecord, '专属任务报工弹窗正确带出任务、作业员和可报工数量',
      (await dialog.innerText()).includes(fixture.procedure.identity) &&
      (await dialog.getByPlaceholder('请输入作业员名称', { exact: true }).inputValue()).trim().length > 0,
      await dialog.innerText())
    caseRecord.evidence.push(await saveScreenshot(page, outputDir, 'production-report-dialog', record))
  } finally {
    if (await dialog.isVisible().catch(() => false)) await dialog.locator('.el-dialog__headerbtn').first().click()
  }
}

export async function verifyProductionReport(context, fixture) {
  const { api, caseRecord } = context
  assert(fixture.tasks.length, 'BLOCKED: owned scheduled task required')
  const task = fixture.tasks[0]
  const work = fixture.works.find((row) => String(row.id) === String(task.workTicketId))
  await fixture.ownership(work)
  unwrap(await api.postBusiness('/mes/prodWork/start', { id: work.id, prodWorkOrderId: work.id }))
  const readTask = async () => unwrap(await api.getBusiness(`/mes/prodWorkTask/queryById?id=${task.id}`))
  const before = await readTask()
  const body = {
    taskId: task.id, qty: 1, qualifiedQty: 1, defectQty: 0,
    reportWorkerId: fixture.employee.userId,
    reportCode: `${fixture.marker}-R1`, remark: fixture.marker,
    startTime: productionTime(Date.now() - 50 * 60000),
    endTime: productionTime(Date.now() - 40 * 60000)
  }
  await fixture.ownership(task)
  const response = await api.request('POST', '/mes/prodWorkReport/addByTaskId', body)
  const id = productionId(unwrap(response))
  const after = await readTask()
  const report = unwrap(await api.getBusiness(`/mes/prodWorkReport/queryById?id=${id}`))
  check(caseRecord, '报工主单关联任务、工单和产品，合格 + 不合格 = 报工数量',
    String(report.workTaskId) === task.id && String(report.workTicketId) === String(work.id) &&
    Number(report.reportNum) === 1 &&
    Number(report.qualifiedNum) + Number(report.unqualifiedNum) === Number(report.reportNum), report)
  check(caseRecord, '真实报工将并发版本加一', Number.isInteger(after.reportVersion) &&
    after.reportVersion === before.reportVersion + 1, { before: before.reportVersion, after: after.reportVersion })
  await fixture.ownership(task)
  const duplicate = await api.request('POST', '/mes/prodWorkReport/addByTaskId', {
    ...body, reportCode: `${fixture.marker}-DUP`
  })
  check(caseRecord, '同工序同人员同时间段重复报工明确拒绝',
    duplicate?.code === 500 &&
    String(duplicate.message || duplicate.msg).includes('该时间段已有报工记录'), duplicate)
  const reports = asList(unwrap(await api.getBusiness(
    `/mes/prodWorkReport/list?pageNo=1&pageSize=100&workTaskId=${task.id}`)))
  check(caseRecord, '重复请求不增加报工记录且版本未再变化',
    reports.length === 1 && (await readTask()).reportVersion === after.reportVersion, reports)
  fixture.report = report
  await verifyProductionPage(context, 'report', work.workTicketNo)
  await verifyProductionPage(context, 'task', fixture.procedure.identity)
}

export async function verifyProductionPause(context, fixture) {
  const { api, caseRecord, page, outputDir, record } = context
  const work = fixture.works[0]
  assert(work, 'BLOCKED: owned work required')
  await fixture.ownership(work)
  const detail = unwrap(await api.getBusiness(`/mes/prodWork/queryById?id=${work.id}`))
  if (Number(detail.status) === 1) {
    await fixture.ownership(work)
    unwrap(await api.postBusiness('/mes/prodWork/start', { id: work.id, prodWorkOrderId: work.id }))
  }
  await verifyProductionPage(context, 'work', work.workTicketNo)
  const row = page.locator(
    '.vxe-table--body-wrapper.body--wrapper:visible .vxe-body--row:visible'
  ).first()
  const actionRow = await fixedRightActionRow(page, row)
  await actionRow.locator('.cell-actives').getByText('更多', { exact: true }).first().click()
  await page.getByRole('button', { name: '暂停', exact: true }).last().click()
  const dialog = page.getByRole('dialog', { name: '暂停工单', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: /确.*定/ }).click()
  check(caseRecord, '真实暂停表单阻断空原因及空预计恢复时间',
    (await dialog.innerText()).includes('请输入暂停原因') &&
    (await dialog.innerText()).includes('请选择预计恢复时间'), await dialog.innerText())
  const expected = productionTime(Date.now() + 3600000)
  await fixture.ownership(work)
  await dialog.getByPlaceholder('请输入暂停原因', { exact: true }).fill(fixture.marker)
  await dialog.getByPlaceholder('请选择预计恢复时间', { exact: true }).fill(expected)
  await dialog.getByPlaceholder('请选择预计恢复时间', { exact: true }).press('Tab')
  const saved = page.waitForResponse((response) => response.url().includes('/mes/prodWork/pause') &&
    response.request().method() === 'POST')
  await dialog.getByRole('button', { name: /确.*定/ }).click()
  await saved
  await dialog.waitFor({ state: 'hidden' })
  const paused = unwrap(await api.getBusiness(`/mes/prodWork/queryById?id=${work.id}`))
  check(caseRecord, 'UI 暂停后真实回读状态、原因和预计恢复时间',
    Number(paused.status) === 3 && paused.pauseReason === fixture.marker &&
    typeof paused.expectResumeTime === 'string' && Number.isFinite(Date.parse(paused.expectResumeTime)), paused)
  caseRecord.evidence.push(await saveScreenshot(page, outputDir, 'production-paused', record))
  await fixture.ownership(work)
  unwrap(await api.postBusiness('/mes/prodWork/resume', { id: work.id, prodWorkOrderId: work.id }))
  const resumed = unwrap(await api.getBusiness(`/mes/prodWork/queryById?id=${work.id}`))
  check(caseRecord, '正式恢复记录恢复时间且保留暂停历史',
    Number(resumed.status) === 2 && resumed.pauseReason === fixture.marker &&
    resumed.resumeTime != null, resumed)
}

export async function verifyProductionMonitor(context, fixture) {
  const { api, caseRecord } = context
  assert(fixture.works.length && fixture.tasks.length, 'BLOCKED: owned work/task required')
  const dashboard = unwrap(await api.getBusiness(
    `/mes/monitor/production-dashboard?workplaceId=${productionId(fixture.workplace.id)}`))
  const ownIds = new Set(fixture.works.map((work) => work.id))
  const orders = asList(dashboard.orders)
    .filter((order) => ownIds.has(String(order.orderId)))
  const alarms = asList(dashboard.alarms).filter((alarm) => ownIds.has(String(alarm.sourceId)))
  check(caseRecord, '生产看板确实聚合专属产线工单，非仅检查空数组结构', orders.length > 0,
    { workplace: dashboard.workplace, orders, lines: dashboard.lines })
  check(caseRecord, '真实逾期专属工单产生可下钻预警',
    alarms.length > 0 && alarms.every((alarm) => alarm.sourceType === 'WORK' &&
      alarm.alarmKey === `WORK_OVERDUE:${alarm.sourceId}`), alarms)
  const detail = unwrap(await api.getBusiness(`/mes/prodWork/queryById?id=${alarms[0].sourceId}`))
  check(caseRecord, '预警 sourceId 下钻回读相同专属工单',
    ownIds.has(String(detail.id)) && detail.remark === fixture.marker, detail)
  caseRecord.notes.push('未派发预警通知；部门隔离负向账号未验证。')
  return { partial: true, note: '专属工单聚合和逾期下钻通过，第二账号权限隔离与通知派发未验证' }
}

export async function runProductionHeaded() {
  assertProductionScope()
  const record = createRunRecord({ selectedSuites: ['production-owned-continuous'] })
  record.runId = `production-flow-${record.runId}`
  record.officialCatalogChanged = false
  const outputDir = ensureDir(path.join(config.outputRoot, record.runId, 'screenshots'))
  const trace = path.join(ensureDir(path.join(config.outputRoot, record.runId, 'trace')), 'production.zip')
  let handle
  let fixture
  let api
  const step = async (id, operation) => {
    const caseRecord = createCaseRecord({ id, suite: 'production-owned-continuous', title: id })
    record.cases.push(caseRecord)
    const before = {
      console: record.consoleErrors.length, page: record.pageErrors.length,
      api: record.failedApiResponses.length, request: record.requestFailures.length
    }
    const started = Date.now()
    console.log(`[RUN ] ${id}`)
    let result
    try {
      result = await operation({ page: handle.page, context: handle.context, record, caseRecord,
        outputDir, api, productionFixture: fixture })
    } catch (error) {
      addCheck(caseRecord, '执行未被业务或页面错误阻断', false, error.message)
      await saveScreenshot(handle.page, outputDir, `${id}-FAIL`, record).catch(() => {})
    }
    await handle.flushResponses()
    caseRecord.runtimeErrors = {
      console: record.consoleErrors.slice(before.console), page: record.pageErrors.slice(before.page),
      api: record.failedApiResponses.slice(before.api), request: record.requestFailures.slice(before.request)
    }
    addCheck(caseRecord, '真实页面没有控制台、渲染、业务接口或请求异常',
      Object.values(caseRecord.runtimeErrors).every((errors) => errors.length === 0),
      JSON.stringify(caseRecord.runtimeErrors))
    const outcome = caseOutcome({ result, hasAssertions: caseRecord.checks.length > 0,
      failedChecks: caseRecord.checks.filter((item) => !item.passed) })
    finishCase(caseRecord, outcome.status, outcome.note)
    caseRecord.durationMs = Date.now() - started
    console.log(`[${caseRecord.status}] ${id}`)
  }
  try {
    await apiHealth()
    handle = await launchBrowser({ headed: true, record })
    await handle.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    const auth = await login(handle.page, { returnContext: true })
    assert.equal(String(auth.tenantId), '1', 'Actual login tenant mismatch')
    api = createApiClient({ token: auth.token, tenantId: '1', record })
    fixture = new ProductionFixtures(api, record)
    await step('PRODUCTION-CREATE-DIALOG', verifyProductionCreateDialog)
    await step('PRODUCTION-FIXTURE', async ({ caseRecord }) => {
      await fixture.setup(caseRecord)
      check(caseRecord, '正式 API 创建专属产品、BOM、工序、工艺和生产计划并回读归属',
        fixture.owned.length === 6, fixture.owned)
    })
    await step('PRODUCTION-CHAIN', async (context) => {
      await fixture.splitAndSchedule(context.caseRecord)
      await verifyProductionPage(context, 'order', fixture.order.identity)
      for (const work of fixture.works) await verifyProductionPage(context, 'work', work.workTicketNo)
      await verifyProductionPage(context, 'task', fixture.procedure.identity)
      return { partial: true, note: '计划拆单排产完成；销售选单、班组缺失门禁未覆盖，不能宣称 MES-PROD-001 全部通过' }
    })
    await step('PRODUCTION-REPORT-DIALOG', (context) => verifyProductionReportDialog(context, fixture))
    await step('PRODUCTION-REPORT', (context) => verifyProductionReport(context, fixture))
    await step('PRODUCTION-PAUSE', (context) => verifyProductionPause(context, fixture))
    await step('PRODUCTION-MONITOR', (context) => verifyProductionMonitor(context, fixture))
    // Page checks still run after a business-chain failure in the same logged-in browser.
    await step('PRODUCTION-PAGES', async (context) => {
      for (const kind of Object.keys(pageSpecs)) await verifyProductionPage(context, kind)
      return { partial: true, note: '只验证页面控件；空列表不证明业务数据展示或闭环' }
    })
    record.remainingBusinessAcceptance = [
      'WMS 领料/投料及缺料开工门禁', '过程检/安灯阻断及不合格追溯',
      '过程检放行后成品入库与 WMS 库存回写', '销售订单选单转生产',
      '第二账号部门权限隔离', '预警通知派发'
    ]
  } finally {
    if (handle) {
      await handle.flushResponses()
      await handle.context.tracing.stop({ path: trace }).catch(() => {})
      await handle.context.close()
      await handle.browser.close()
    }
    const report = await writeReport(record)
    console.log(JSON.stringify({ ...report, marker: fixture?.marker, trace,
      PASS: record.cases.filter((item) => item.status === 'PASS').length,
      PARTIAL: record.cases.filter((item) => item.status === 'PARTIAL').length,
      FAIL: record.cases.filter((item) => item.status === 'FAIL').length }))
    process.exitCode = record.cases.some((item) => item.status === 'FAIL') ? 1 : 0
  }
}

export async function runProductionUiHeaded() {
  assertProductionScope()
  const record = createRunRecord({ selectedSuites: ['production-ui-readonly'] })
  record.runId = `production-ui-${record.runId}`
  const caseRecord = createCaseRecord({ id: 'PRODUCTION-CREATE-DIALOG', suite: 'production-ui-readonly',
    title: '生产计划新增弹窗只读检查' })
  record.cases.push(caseRecord)
  const outputDir = ensureDir(path.join(config.outputRoot, record.runId, 'screenshots'))
  const handle = await launchBrowser({ headed: true, record })
  const trace = path.join(ensureDir(path.join(config.outputRoot, record.runId, 'trace')), 'ui.zip')
  try {
    await handle.context.tracing.start({ screenshots: true, snapshots: true })
    const auth = await login(handle.page, { returnContext: true })
    assert.equal(String(auth.tenantId), '1')
    const api = createApiClient({ token: auth.token, tenantId: '1', record })
    await verifyProductionCreateDialog({ page: handle.page, api, record, caseRecord, outputDir })
  } catch (error) {
    addCheck(caseRecord, '新增弹窗没有页面/接口异常', false, error.message)
    await saveScreenshot(handle.page, outputDir, 'create-dialog-FAIL', record).catch(() => {})
  } finally {
    await handle.flushResponses()
    const errors = { console: record.consoleErrors, page: record.pageErrors,
      api: record.failedApiResponses, request: record.requestFailures }
    addCheck(caseRecord, '浏览器无运行时异常', Object.values(errors).every((items) => !items.length), JSON.stringify(errors))
    await handle.context.tracing.stop({ path: trace })
    await handle.context.close()
    await handle.browser.close()
    const outcome = caseOutcome({ failedChecks: caseRecord.checks.filter((item) => !item.passed),
      hasAssertions: true, result: { partial: true, note: '只打开新增表单，未保存；报工弹窗因正式任务前置阻断未验证' } })
    finishCase(caseRecord, outcome.status, outcome.note)
    console.log(JSON.stringify({ ...(await writeReport(record)), status: caseRecord.status, trace }))
    process.exitCode = outcome.status === 'FAIL' ? 1 : 0
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.join(' ') === '--headed --ui-only') await runProductionUiHeaded()
  else {
    assert.deepEqual(args, ['--headed'], 'Only --headed [--ui-only] is supported')
    await runProductionHeaded()
  }
}
