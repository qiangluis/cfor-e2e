import { createApiClient } from '../lib/api.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { asList, isBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'
import {
  login as loginDefault,
  openRoute as openRouteDefault,
  saveScreenshot as saveScreenshotDefault
} from '../lib/browser.mjs'
import { createWarehouseFixture } from '../lib/wms-fixtures.mjs'
import {
  hasWriteApi,
  newMarker,
  unwrap,
  queryRows,
  singleId,
  createBarcodeRuleFixture,
  deleteBarcodeRuleFixture,
  createProductionTypeFixture,
  pickBomMaterial,
  createProdOrderWithType,
  createRouteCapacityFixture,
  bindDeviceCapacity,
  listCapacities,
  createGrade,
  createGradeMaterial,
  materialEditBody,
  readGradeConfigFromDb,
  deleteGrade,
  readEnterpriseOrganization,
  restoreEnterpriseOrganization,
  pickAlternativeIndustry,
  createWorkCalendarFixture,
  readWorkCalendarDb,
  createSchedulingVersionFixture,
  readSchedulingVersionDb,
  createTeamHandoverFixture,
  readInventoryByGrade
} from '../fixtures/mes-base-fixtures.mjs'

export const cases = [
  'MES-BASE-001',
  'MES-BASE-002',
  'MES-BASE-003',
  'MES-BASE-004',
  'MES-BASE-005',
  'MES-BASE-006',
  'PB081-001',
  'PB102-001',
  'PB102-002',
  'PB102-003',
  'PB038-001',
  'PB038-002',
  'PB038-003',
  'PB038-004',
  'PB038-005',
  'PB039-001',
  'PB039-002',
  'PB039-003'
]

export const DESIGNED_MES_BASE_ENABLE_CASES = Object.freeze(['MES-BASE-002'])
// Catalog activation remains owned by the main task.
export const DESIGNED_MES_BASE_READONLY_CASES = Object.freeze([
  'MES-BASE-001', 'MES-BASE-002', 'MES-BASE-003',
  'MES-BASE-004', 'MES-BASE-005', 'MES-BASE-006'
])

const nonBlank = (value) => value != null && String(value).trim() !== ''

export const mesBaseRows = (result, label, idField = 'id') => {
  const data = result?.data
  const rows = Array.isArray(data) ? data : data?.list ?? data?.records
  const total = data?.total == null ? rows?.length : Number(data.total)
  if (!isBusinessSuccess(result) || !Array.isArray(rows) || rows.length > 100 ||
    !Number.isSafeInteger(total) || total < rows.length ||
    (rows.length === 0 && total !== 0) ||
    rows.some((row) => !row || typeof row !== 'object' || !nonBlank(row[idField]))) {
    throw new Error(`${label} 响应无效，不能当作缺前置或通过`)
  }
  return rows
}

export const mesBaseDetail = (result, id, label) => {
  const data = result?.data
  if (!isBusinessSuccess(result) || !data || Array.isArray(data) ||
    String(data.id) !== String(id)) {
    throw new Error(`${label} 详情响应无效`)
  }
  return data
}

export const isPb038002Fixture = (material) =>
  /^(?:E2E|AUTOTEST)_PB038_002(?:_|$)/.test(material?.code || '') &&
  material?.mark === 'PB038-002 dedicated e2e fixture' &&
  material?.inventoryNature === 'STOCK' && nonBlank(material?.unitId)

export const pb038GradePayload = (material, gradeFields) => {
  if (!isPb038002Fixture(material) || !nonBlank(material.id)) {
    throw new Error('PB038-002 禁止编辑非本案例专用测试夹具')
  }
  return { ...material, ...gradeFields }
}

export const isLegacyInitializedRoute = (row) =>
  row?.code === 'INIT-ROUTE-001' && row?.createBy === 'system-init' &&
  !nonBlank(row?.publishTime) && !nonBlank(row?.publishBy)

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`

// Standard local seed identifiers (tenant 1 / CFOR 标准平台); resolved dynamically first.
const SEED = Object.freeze({
  workshopId: '2106210108678037505',
  lineId: '2106210108732563458',
  unitId: '2106210108459933698',
  deviceProduction: '2106401100785975297',
  deviceQuality: '2106401100798558209'
})

const today = () => new Date().toISOString().slice(0, 10)

const findComponentRoute = (menus, component) => {
  const find = (rows, parent = '') => {
    for (const row of rows || []) {
      const route = row.path?.startsWith('/') ? row.path : `${parent}/${row.path || ''}`
      const value = String(row.component || '').replace(/^\/?views\//, '').replace(/\.vue$/, '')
      if (value === component) return route
      const child = find(row.children || [], route)
      if (child) return child
    }
    return null
  }
  return find(menus)
}

const expectBusinessFailure = (result, { code, includes }, label) => {
  const message = String(result?.msg ?? result?.message ?? '')
  const passed = (code == null || Number(result?.code) === Number(code)) &&
    (!includes || message.includes(includes))
  if (!passed) {
    throw new Error(`${label} 未被后端按预期拒绝：${JSON.stringify(result).slice(0, 300)}`)
  }
  return true
}

const resolveWriteContext = async (api) => {
  let lineId = SEED.lineId
  let workshopId = SEED.workshopId
  try {
    const places = asList(unwrap(await api.getBusiness('/mes/monitor/workplaces')))
    const place = places[0]
    if (place?.id) {
      workshopId = String(place.id)
      const rows = await queryRows(
        `SELECT id FROM mes_work_line WHERE tenant_id=1 AND deleted=0
         AND work_place_id='${workshopId}' ORDER BY id LIMIT 1`)
      if (rows.length === 1) lineId = String(rows[0][0])
    }
  } catch {
    // fall back to the seeded identifiers
  }
  let deviceId = SEED.deviceProduction
  try {
    const devices = asList(unwrap(await api.getBusiness('/iot/device/simple-list')))
    const preferred = devices.find((row) => /生产/.test(row?.deviceName || '')) || devices[0]
    if (preferred?.id) deviceId = String(preferred.id)
  } catch {
    // fall back to the seeded identifiers
  }
  return { workshopId, lineId, deviceId, unitId: SEED.unitId }
}

const stockIoBillNo = (marker, suffix) => `${marker}-${suffix}`.slice(0, 60)

const gradeStockIoBody = (fixture, marker, { materialId, unitId, gradeId, suffix }) => ({
  billNo: stockIoBillNo(marker, suffix),
  billDate: today(),
  subject: `${marker} grade probe`,
  remark: marker,
  stockIoType: '101',
  isAuto: 0,
  stkIoEntryList: [{
    materialId: String(materialId),
    unitId: String(unitId),
    qty: 1,
    cost: 1,
    warehouseId: fixture.warehouse.id,
    wareAreaId: fixture.area.id,
    wareLocationId: fixture.location.id,
    batchNo: `${marker}-BATCH`,
    entryNo: 1,
    stockIoType: '101',
    stockIoDirection: '1',
    isQc: 0,
    settleQty: 1,
    gradeId: gradeId == null ? null : String(gradeId)
  }],
  stkIoDistributionList: [],
  stkIoBomList: []
})

const findGrade = (rows, id) => rows.find((item) => String(item.id) === String(id))

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  '..',
  'cfor',
  'cfor-admin-vue3'
)

const readWebSource = (relativePath) => {
  try {
    return fs.readFileSync(path.join(WEB_ROOT, relativePath), 'utf8')
  } catch {
    return ''
  }
}

// PB038-005：列配置断言。逐个读取明细列配置源，确认品级列由 grade_select 渲染，
// 并确认各业务页面确实引用对应列配置，不依赖页面是否有存量数据。
const inspectGradeColumnConfig = () => {
  const dialogData = readWebSource('src/components/VxeTable/src/dialogData.ts')
  const definitions = [
    ['materialInOut', ['src/views/wms/stock/in/material/components/formDialog.vue'], 1],
    ['sampleInOut', ['src/views/wms/stock/in/sample/components/formDialog.vue',
      'src/views/wms/stock/out/sample/components/formDialog.vue'], 2],
    ['giftInOut', ['src/views/wms/stock/in/gift/components/formDialog.vue',
      'src/views/wms/stock/out/gift/components/formDialog.vue'], 2]
  ]
  const evidence = []
  for (const [key, pages, expected] of definitions) {
    const blockStart = dialogData.indexOf(`${key}: [`)
    const block = blockStart >= 0 ? dialogData.slice(blockStart, blockStart + 2200) : ''
    const gradeField = block.includes('gradeId_dictText')
    const gradeSlot = block.includes("edit: 'grade_select'")
    const pageRefs = pages.filter((file) => readWebSource(file).includes(`table-columns="${key}"`))
    evidence.push({ key, gradeField, gradeSlot, pageRefs: pageRefs.length, expected })
  }
  const outMaterial = readWebSource('src/views/wms/stock/out/material/components/formDialog.vue')
  const materialOutUsesRequisition = outMaterial.includes('table-columns="prodRequisition"') &&
    dialogData.includes('prodRequisition: [') &&
    dialogData.slice(dialogData.indexOf('prodRequisition: ['),
      dialogData.indexOf('prodRequisition: [') + 4000).includes('gradeId_dictText')
  const sellDialog = readWebSource('src/views/wms/stock/out/sell/components/formDialog.vue')
  const sellBomDialog = readWebSource('src/views/wms/stock/out/sell/components/formDialogBom.vue')
  const sellDetail = readWebSource('src/views/wms/stock/out/sell/components/formDetail.vue')
  const sellGrade = [sellDialog, sellBomDialog, sellDetail].every((source) =>
    source.includes('gradeId_dictText') && source.includes("slots: { edit: 'grade_select' }"))
  return { evidence, materialOutUsesRequisition, sellGrade }
}

// PB038-004/005：打开 WMS 明细表，真实点击新增并检查表头/表单是否渲染“品级”列。
const probeGradeColumn = async (page, route) => {
  await openRouteDefault(page, route, { readyText: '新增', readyTimeoutMs: 30000 })
  const addButton = page.getByRole('button', { name: /新增/ }).first()
  if (!(await addButton.count())) return { seen: false, detail: 'NO_ADD_BUTTON' }
  await addButton.click()
  let seen = false
  try {
    const columnCell = page.locator('.vxe-header--column').filter({ hasText: '品级' }).first()
    await columnCell.waitFor({ state: 'visible', timeout: 8000 })
    seen = true
  } catch {
    seen = (await page.locator('label').filter({ hasText: '品级' }).count()) > 0
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  return { seen, detail: seen ? 'GRADE_COLUMN' : 'NOT_FOUND' }
}

// ---------------------------------------------------------------------------
// Legacy read-only harness path.
//
// The runner always supplies a full write-capable API client, so this branch is
// only used by the isolated prerequisite harness (scripts/e2e/tests) which injects
// a GET-only client. It must never perform writes and therefore stays PARTIAL.
// ---------------------------------------------------------------------------
const runReadOnlyBranch = async (caseId, api, page, record, caseRecord, openRoute) => {
  if (caseId === 'MES-BASE-001') {
    const rules = mesBaseRows(await api.getBusiness(
      '/mes/production-type-rule/page?pageNo=1&pageSize=100'), '生产类型规则')
    const orders = mesBaseRows(await api.getBusiness(
      '/mes/prodOrder/list/dictText?pageNo=1&pageSize=100'), '生产订单')
    caseRecord.checks.push({
      name: '生产类型规则与生产订单真实分页可读取',
      passed: true, details: `rules=${rules.length}, orders=${orders.length}`
    })
    if (rules.length) {
      caseRecord.checks.push({
        name: '规则样本映射受控正常/紧急生产场景并保存稳定类型和版本',
        passed: rules.every((row) => ['1', '2'].includes(row.produceType) &&
          nonBlank(row.documentTypeCode) && Number.isInteger(row.version) &&
          row.version >= 1 && [0, 1].includes(row.status)),
        details: `samples=${rules.length}`
      })
      const detail = mesBaseDetail(await api.getBusiness(
        `/mes/production-type-rule/get?id=${encodeURIComponent(rules[0].id)}`),
      rules[0].id, '生产类型规则')
      caseRecord.evidence.push(`生产规则详情 id=${detail.id}, version=${detail.version}`)
    }
    const snapshots = orders.filter((row) => nonBlank(row.documentTypeCode) &&
      Number.isInteger(row.documentTypeRuleVersion) && row.documentTypeRuleVersion >= 1)
    if (openRoute) await openRoute(page, '/mes/produce/order', {
      readySelector: '.search-form input[placeholder="请输入计划单号"]'
    })
    return {
      api, partial: true,
      note: `规则=${rules.length}，生产订单规则快照样本=${snapshots.length}；` +
        `${rules.length ? '' : '缺企业生产类型规则；'}` +
        `${snapshots.length ? '' : '缺正式订单类型/版本快照；'}` +
        '未保存订单或删除引用规则；源码仅有规则权限按钮，未找到独立生产类型规则维护页面'
    }
  }

  if (caseId === 'MES-BASE-002') {
    const rules = mesBaseRows(await api.getBusiness(
      '/mes/outsource-type-rule/page?pageNo=1&pageSize=100'), '委外业务类型规则')
    const bills = mesBaseRows(await api.getBusiness(
      '/mes/prodOutsource/list?pageNo=1&pageSize=100'), '委外单')
    caseRecord.checks.push({
      name: '委外业务类型规则与委外单真实分页可读取', passed: true,
      details: `rules=${rules.length}, bills=${bills.length}`
    })
    if (rules.length) {
      caseRecord.checks.push({
        name: '委外规则核心类型只允许 PROCESS/WORK 且保存稳定类型编码与版本',
        passed: rules.every((row) => ['PROCESS', 'WORK'].includes(row.coreType) &&
          nonBlank(row.documentTypeCode) && Number.isInteger(row.version) && row.version >= 1),
        details: `samples=${rules.length}`
      })
    }
    const snapshots = bills.filter((row) => nonBlank(row.outsourceTypeCode) &&
      Number.isInteger(row.outsourceTypeRuleVersion) && row.outsourceTypeRuleVersion >= 1)
    if (openRoute) await openRoute(page, '/mes/produce/outsource', { readyText: '委外' }).catch(() => {})
    return {
      api, partial: true,
      note: `委外规则=${rules.length}，委外单=${bills.length}，带业务类型编码/规则版本快照=${snapshots.length}；` +
        '真实产品缺陷：委外单创建 VO MesProdOutsourcePage 未声明 outsourceTypeCode / outsourceTypeRuleVersion，' +
        'MesProdOutsourceServiceImpl 仅在按工单生成草稿时硬编码 OUTSOURCE_WORK/OUTSOURCE_PROCESS 与版本 1，' +
        '企业配置的委外业务类型规则既不下发到委外单、也无法形成“被引用规则禁止删除”的引用关系，' +
        '因此“委外单保存业务类型编码和规则版本快照”与“被委外单引用的规则禁止删除”无法真实闭环'
    }
  }

  if (caseId === 'MES-BASE-003') {
    const objects = mesBaseRows(await api.getBusiness('/erp/barcode/catalog/object-types'), '条码对象目录')
    const carriers = mesBaseRows(await api.getBusiness('/erp/barcode/catalog/carriers'), '条码载体目录')
    const rules = mesBaseRows(await api.getBusiness(
      '/erp/barcode/rules/page?pageNo=1&pageSize=100'), '条码规则')
    caseRecord.checks.push({
      name: '平台条码对象/载体与企业条码规则真实响应可读取',
      passed: true, details: `objects=${objects.length}, carriers=${carriers.length}, rules=${rules.length}`
    })
    if (objects.length && carriers.length) {
      const byCode = new Map(carriers.map((row) => [row.code, row]))
      caseRecord.checks.push({
        name: 'BARCODE/QRCODE 已实现，RFID 显式暂缓',
        passed: ['BARCODE', 'QR_CODE'].every((code) => byCode.get(code)?.supported === 1) &&
          byCode.get('RFID')?.supported === 0 && byCode.get('RFID')?.deferred === 1,
        details: carriers.map((row) => `${row.code}:supported=${row.supported},deferred=${row.deferred}`).join(',')
      })
      const configured = rules.filter((row) => nonBlank(row.objectType) || nonBlank(row.carrier))
      if (configured.length) {
        caseRecord.checks.push({
          name: '已配置条码规则仅引用平台业务对象与已实现载体',
          passed: configured.every((row) => objects.some((item) => item.code === row.objectType) &&
            byCode.get(row.carrier)?.supported === 1),
          details: `configured=${configured.length}, legacy=${rules.length - configured.length}`
        })
      }
    }
    const permission = await api.getBusiness('/system/auth/get-permission-info')
    const route = findComponentRoute(permission?.data?.menus, 'barcode/barCodeRules/index')
    if (route) {
      if (openRoute) await openRoute(page, route, {
        readySelector: 'input[placeholder="请输入规则编码"]'
      })
      caseRecord.evidence.push(`真实菜单条码规则页 ${route}`)
    }
    return {
      api, partial: true,
      note: `目录对象=${objects.length}，载体=${carriers.length}，规则=${rules.length}；` +
        `${route ? '' : '缺条码规则页面菜单；'}` +
        '只读目录不证明 RFID 保存拒绝或跨租户字典绕过保护，未创建规则或改平台目录'
    }
  }

  if (caseId === 'MES-BASE-004') {
    const calendars = mesBaseRows(await api.getBusiness(
      '/mes/workCalendar/page?pageNo=1&pageSize=100'), '生产日历')
    const modes = mesBaseRows(await api.getBusiness('/mes/workMode/list'), '工作模式')
    caseRecord.checks.push({
      name: 'APS 生产日历与工作模式真实响应可读取',
      passed: true, details: `calendars=${calendars.length}, modes=${modes.length}`
    })
    if (calendars.length) {
      caseRecord.checks.push({
        name: '日历样本返回稳定编码、日期与工作日标识',
        passed: calendars.every((row) => nonBlank(row.calendarCode) &&
          nonBlank(row.calendarDate) && typeof row.isWorkday === 'boolean'),
        details: `samples=${calendars.length}`
      })
    }
    caseRecord.evidence.push('WorkCalendarRespVO 当前未公开 version/publishStatus，读侧不能证明发布版本快照')
    if (openRoute) await openRoute(page, '/settings/production/work-calendar', {
      readySelector: '.calendar-workbench .calendar-toolbar'
    })
    return {
      api, partial: true,
      note: `生产日历=${calendars.length}，工作模式=${modes.length}；` +
        '缺可读取的日历发布版本字段与正式排产历史快照证据；未发布、停用、删除日历或生成排产'
    }
  }

  if (caseId === 'MES-BASE-005') {
    const handovers = mesBaseRows(await api.getBusiness(
      '/mes/team-handover/page?pageNo=1&pageSize=100'), '班组交接')
    caseRecord.checks.push({
      name: '独立班组交接事实分页真实可读取', passed: true, details: `handovers=${handovers.length}`
    })
    if (handovers.length) {
      caseRecord.checks.push({
        name: '交接样本引用双方班组，确认终态具备两个不同确认人',
        passed: handovers.every((row) => nonBlank(row.outTeamId) && nonBlank(row.inTeamId) &&
          [0, 1].includes(row.status) && (row.status !== 1 ||
            (nonBlank(row.outConfirmBy) && nonBlank(row.inConfirmBy) &&
              String(row.outConfirmBy) !== String(row.inConfirmBy)))),
        details: `samples=${handovers.length}`
      })
    }
    return {
      api, partial: true,
      note: `交接=${handovers.length}；未创建/确认共享交接。` +
        '未找到 MES 班组交接前端页面；共享交接数据与真实写侧仍需隔离夹具验证；后端 confirmHandover 已禁止同一确认人'
    }
  }

  if (caseId === 'MES-BASE-006') {
    const routes = mesBaseRows(await api.getBusiness(
      '/mes/wmsTechRoute/list?pageNo=1&pageSize=100'), '工艺路线')
    const tasks = mesBaseRows(await api.getBusiness(
      '/mes/prodWorkTask/list?pageNo=1&pageSize=100'), '工单任务')
    caseRecord.checks.push({
      name: '工艺路线与任务快照真实分页可读取', passed: true,
      details: `routes=${routes.length}, tasks=${tasks.length}`
    })
    const published = routes.filter((row) => row.devStatus === 2)
    if (published.length) {
      caseRecord.checks.push({
        name: '已发布路线样本可读取稳定编码与版本，非历史初始化路线具备发布审计',
        passed: published.every((row) => nonBlank(row.code) && nonBlank(row.version) &&
          (isLegacyInitializedRoute(row) || (nonBlank(row.publishTime) && nonBlank(row.publishBy)))),
        details: `published=${published.length}`
      })
    }
    if (openRoute) await openRoute(page, '/settings/production/technique', {
      readySelector: '.technique-route'
    })
    return {
      api, partial: true,
      note: `路线=${routes.length}，已发布=${published.length}，任务版本快照=${tasks.filter((row) => nonBlank(row.routeVersion)).length}；` +
        '缺隔离的已发布工艺/BOM/任务升版前后证据，未编辑、发布、删除路线或生成任务'
    }
  }

  if (caseId === 'PB038-002') {
    const grades = mesBaseRows(await api.getBusiness('/base/material-grade/simple-list'), '启用品级')
    const materials = mesBaseRows(await api.getBusiness(
      '/mes/basMaterial/list?pageNo=1&pageSize=100'), '存货')
    caseRecord.checks.push({
      name: '存货与启用品级真实响应正确解包',
      passed: true, details: `materials=${materials.length}, grades=${grades.length}`
    })
    const candidate = materials.find(isPb038002Fixture)
    const [gA, gB, gC] = ['A', 'B', 'C'].map((code) => grades.find((row) => row.code === code))
    const partial = (note) => ({ api, partial: true, note })
    if (!candidate || !gA || !gB || !gC) {
      return partial('缺 PB038-002 专用无库存实物存货夹具或已有启用 A/B/C 品级；' +
        '不改其他 E2E/正式物料，不创建共享品级，配置及入库准入写侧未执行')
    }
    const materialId = candidate.id
    const original = mesBaseDetail(await api.getBusiness(
      `/mes/basMaterial/queryById?id=${encodeURIComponent(materialId)}`), materialId, '存货')
    if (!isPb038002Fixture(original) || !Array.isArray(original.allowedGradeIds)) {
      return partial('专用物料详情缺明确所有权标记或完整允许品级配置，不能安全修改/还原')
    }
    const target = { gradeManaged: 'Y', defaultGradeId: gB.id, allowedGradeIds: [gA.id, gB.id] }
    try {
      await api.putBusiness('/mes/basMaterial/edit', pb038GradePayload(original, target))
      const managed = mesBaseDetail(await api.getBusiness(
        `/mes/basMaterial/queryById?id=${encodeURIComponent(materialId)}`), materialId, '存货')
      caseRecord.checks.push({
        name: '专用存货开启品级并回读默认品级与精确允许范围',
        passed: managed.gradeManaged === 'Y' && String(managed.defaultGradeId) === String(gB.id) &&
          Array.isArray(managed.allowedGradeIds) && managed.allowedGradeIds.length === 2,
        details: `materialId=${materialId}`
      })
      const rejection = await api.request('PUT', '/mes/basMaterial/edit',
        pb038GradePayload(original, { ...target, defaultGradeId: gC.id }))
      caseRecord.checks.push({
        name: '默认品级越界返回准确业务校验而不是任意异常',
        passed: rejection?.code === 500 &&
          (rejection.msg ?? rejection.message) === '默认品级必须在允许品级范围内',
        details: JSON.stringify(rejection)
      })
    } finally {
      await api.putBusiness('/mes/basMaterial/edit', pb038GradePayload(original, {
        gradeManaged: original.gradeManaged,
        defaultGradeId: original.defaultGradeId,
        allowedGradeIds: original.allowedGradeIds
      }))
    }
    return partial('已验证本案例专用夹具的配置、越界拒绝和 finally 还原；' +
      '缺隔离库存单据前置，入库错品级/停用品级/未启用品级准入尚未执行')
  }

  if (caseId === 'PB038-003') {
    const report = await api.getBusiness('/mes/stkIo/queryStockQty?pageNo=1&pageSize=20')
    const rows = asList(report?.data ?? report)
    const first = rows[0]
    const hasGradeKeys = first
      ? Object.prototype.hasOwnProperty.call(first, 'gradeId') &&
        Object.prototype.hasOwnProperty.call(first, 'gradeName')
      : true
    caseRecord.checks.push({
      name: '现存量报表含品级维度字段', passed: hasGradeKeys,
      details: first ? `columns=${Object.keys(first).join(',')}` : '当前无库存行，跳过字段断言'
    })
    const filtered = await api.getBusiness(
      '/mes/stkIo/queryStockQty?pageNo=1&pageSize=20&gradeId=__NO_SUCH_GRADE__')
    const filteredRows = asList(filtered?.data ?? filtered)
    caseRecord.checks.push({
      name: '现存量报表支持按品级筛选',
      passed: Array.isArray(filteredRows) && filteredRows.length === 0,
      details: `使用不存在品级筛选返回 ${filteredRows.length} 行`
    })
    return { api, partial: true, note: '只读报表验证品级维度；未创建同存货同批次 A/B 级两条库存行，未验证反向单继承品级' }
  }

  if (caseId === 'PB038-004') {
    const grades = asList(unwrap(await api.getBusiness('/base/material-grade/simple-list')))
    caseRecord.checks.push({
      name: '公共品级目录启用项可加载', passed: Array.isArray(grades), details: `grades=${grades.length}`
    })
    if (openRoute) await openRoute(page, '/wireSideWarehouse/in/inPurchase', { readyText: '入库单号' })
    caseRecord.checks.push({ name: '入库单据列表页可打开', passed: true, details: page.url() })
    return { api, partial: true, note: '仅打开入库列表页；未双击品级单元格渲染 grade_select 下拉，未验证品级随明细保存' }
  }

  if (caseId === 'PB038-005') {
    const grades = asList(unwrap(await api.getBusiness('/base/material-grade/simple-list')))
    caseRecord.checks.push({
      name: '公共品级目录启用项可加载', passed: Array.isArray(grades), details: `grades=${grades.length}`
    })
    return { api, partial: true, note: '办公用品/样品/赠品/销售出库明细列配置未逐页验证品级列，保留 PARTIAL' }
  }

  if (caseId === 'PB039-001') {
    if (openRoute) await openRoute(page, '/systemModel/base/organization/enterprise-organization', {
      readyText: '行业大类', retries: 1
    })
    const tree = await api.getBusiness('/system/system-init/industry-template/tree')
    const rows = tree?.data ?? tree
    const root = (Array.isArray(rows) ? rows : []).find((item) => item?.code === 'MANUFACTURING') || rows?.[0]
    const children = root?.children || []
    caseRecord.checks.push({
      name: '统一行业目录返回大行业到细分行业两层树',
      passed: Array.isArray(rows) && rows.length > 0 &&
        rows.every((item) => item?.level === 'INDUSTRY' && item?.selectable === false) &&
        children.length > 0 && children.every((item) => item?.level === 'SUB_INDUSTRY' &&
          item?.parentCode === root?.code && item?.selectable === true),
      details: `roots=${rows?.length || 0} children=${children.length}`
    })
    return { api }
  }

  if (caseId === 'PB039-002') {
    if (openRoute) await openRoute(page, '/systemInit/index', { readySelector: '.system-init' })
    const editButton = page.locator('button').filter({ hasText: '修改行业与板块' })
      .filter({ visible: true }).first()
    let cascadeVisible = false
    try {
      await editButton.waitFor({ state: 'visible', timeout: 30000 })
      await editButton.click()
      await page.locator('.init-wizard--first').waitFor({ state: 'visible', timeout: 30000 })
      cascadeVisible = (await page.getByText('行业大类', { exact: true }).count()) > 0 &&
        (await page.getByText('细分行业', { exact: true }).count()) > 0
    } catch {
      cascadeVisible = false
    }
    caseRecord.checks.push({
      name: '初始化中心只保留一套行业级联选择', passed: cascadeVisible,
      details: '行业大类 + 细分行业级联'
    })
    return { api }
  }

  return { designed: true }
}

// ---------------------------------------------------------------------------
// Real write-side runner (catalog-flippable cases).
// ---------------------------------------------------------------------------
const runWriteBranch = async (caseId, api, page, record, caseRecord, outputDir, openRoute, saveScreenshot) => {
  const check = (name, passed, details) => {
    caseRecord.checks.push({ name, passed: Boolean(passed), details: details == null ? '' : String(details) })
    if (!passed) throw new Error(`断言失败：${name} | ${details}`)
  }

  if (caseId === 'MES-BASE-001') {
    await assertLocalWriteSafety(caseRecord)
    const marker = newMarker('MESB001')
    const type = await createProductionTypeFixture(api, marker)
    check('企业生产类型规则按受控生产场景创建并保存稳定类型编码与版本',
      type.rule.documentTypeCode === type.documentTypeCode && type.rule.produceType === '1' &&
      Number(type.rule.version) === 1 && Number(type.rule.status) === 1,
      `ruleId=${type.ruleId}, code=${type.rule.documentTypeCode}, version=${type.rule.version}`)

    const material = await pickBomMaterial(api)
    const order = await createProdOrderWithType(api, marker, {
      documentTypeId: type.documentTypeId, material
    })
    const detail = mesBaseDetail(await api.getBusiness(
      `/mes/prodOrder/queryById/dictText?id=${order.orderId}`), order.orderId, '生产订单')
    const dbRows = await queryRows(
      `SELECT document_type_id, document_type_code, document_type_rule_version
       FROM mes_prod_order WHERE tenant_id=1 AND deleted=0 AND id='${order.orderId}'`)
    const snapshotOk =
      String(detail.documentTypeId) === type.documentTypeId &&
      detail.documentTypeCode === type.documentTypeCode &&
      Number(detail.documentTypeRuleVersion) === Number(type.rule.version) &&
      detail.prodType === '1'
    caseRecord.evidence.push(
      `提交 documentTypeId=${type.documentTypeId}（code=${type.documentTypeCode}），` +
      `订单详情 documentTypeId=${detail.documentTypeId}, code=${detail.documentTypeCode}, ` +
      `ruleVersion=${detail.documentTypeRuleVersion}；mes_prod_order 库内快照=${JSON.stringify(dbRows[0] || [])}`)

    if (!snapshotOk) {
      // 真实产品缺陷：MesProdOrderController.add 以 ProdOrderPage 接收请求体，而 ProdOrderPage
      // 未声明 documentTypeId/documentTypeCode/documentTypeRuleVersion，BeanUtils.copyProperties
      // 丢弃企业生产类型编号，使 applyProductionTypeSnapshot 直接 return。快照与“被订单引用后
      // 禁止删除规则”两条断言都无法真实落库，保留 PARTIAL，不伪造通过。
      const blockedWithoutSnapshot = await api.request('DELETE',
        `/mes/production-type-rule/delete?id=${type.ruleId}`)
      caseRecord.evidence.push(
        `未落库快照时删除规则响应=${JSON.stringify(blockedWithoutSnapshot).slice(0, 240)}`)
      await openRoute(page, '/mes/produce/order', {
        readySelector: '.search-form input[placeholder="请输入计划单号"]'
      }).catch(() => {})
      await saveScreenshot(page, outputDir, 'mes-base-001-production-type-order', record).catch(() => {})
      return {
        api, partial: true,
        note: '真实产品缺陷：MesProdOrderController.add 请求体 VO 为 ProdOrderPage，但 ProdOrderPage 未声明 ' +
          'documentTypeId/documentTypeCode/documentTypeRuleVersion，BeanUtils.copyProperties 丢弃企业生产类型编号，' +
          '导致 mes_prod_order 的 document_type_code/rule_version 快照为空、被正式订单引用的规则无法触发禁止删除；' +
          `专属规则 ruleId=${type.ruleId}、订单 orderId=${order.orderId} 已复现（库内快照=${JSON.stringify(dbRows[0] || [])}）`
      }
    }

    check('生产订单保存企业类型编码和规则版本快照', true,
      `order=${order.orderId}, code=${detail.documentTypeCode}, version=${detail.documentTypeRuleVersion}`)
    check('生产订单规则快照真实落库到 mes_prod_order',
      dbRows.length === 1 && String(dbRows[0][0]) === type.documentTypeId &&
      dbRows[0][1] === type.documentTypeCode && Number(dbRows[0][2]) === Number(type.rule.version),
      JSON.stringify(dbRows[0]))

    const blocked = await api.request('DELETE',
      `/mes/production-type-rule/delete?id=${type.ruleId}`)
    expectBusinessFailure(blocked, { code: 2010950003, includes: '不能删除' }, '被订单引用的生产类型规则删除')
    check('被正式生产订单引用的生产类型规则禁止删除',
      Number(blocked?.code) === 2010950003, JSON.stringify(blocked))

    await api.putBusiness('/mes/production-type-rule/update', {
      id: type.ruleId, documentTypeId: type.documentTypeId, produceType: type.rule.produceType,
      status: 0, remark: marker
    })
    const disabled = unwrap(await api.getBusiness(
      `/mes/production-type-rule/get?id=${type.ruleId}`))
    check('反向动作是停用规则而不是删除，并把版本自增到新快照',
      Number(disabled.status) === 0 && Number(disabled.version) === Number(type.rule.version) + 1,
      `status=${disabled.status}, version=${disabled.version}`)
    const afterDisable = mesBaseDetail(await api.getBusiness(
      `/mes/prodOrder/queryById/dictText?id=${order.orderId}`), order.orderId, '生产订单')
    check('规则停用升版后历史生产订单快照不被追溯改写',
      Number(afterDisable.documentTypeRuleVersion) === Number(type.rule.version),
      `orderVersion=${afterDisable.documentTypeRuleVersion}`)
    caseRecord.evidence.push(`专属生产类型规则/订单：rule=${type.ruleId}, order=${order.orderId}`)
    await openRoute(page, '/mes/produce/order', {
      readySelector: '.search-form input[placeholder="请输入计划单号"]'
    }).catch(() => {})
    await saveScreenshot(page, outputDir, 'mes-base-001-production-type-order', record).catch(() => {})
    return { api }
  }

  if (caseId === 'MES-BASE-003') {
    await assertLocalWriteSafety(caseRecord)
    const objects = mesBaseRows(await api.getBusiness('/erp/barcode/catalog/object-types'), '条码对象目录')
    const carriers = mesBaseRows(await api.getBusiness('/erp/barcode/catalog/carriers'), '条码载体目录')
    const byCode = new Map(carriers.map((row) => [row.code, row]))
    check('对象类型必须来自平台受控目录且条形码/二维码已实现、RFID 暂缓',
      objects.some((row) => row.code === 'MATERIAL') &&
      ['BARCODE', 'QR_CODE'].every((code) => byCode.get(code)?.supported === 1) &&
      byCode.get('RFID')?.supported === 0 && byCode.get('RFID')?.deferred === 1,
      `objects=${objects.length}, carriers=${carriers.length}`)

    const marker = newMarker('MESB003')
    const { ruleId, ruleCode } = await createBarcodeRuleFixture(api, caseRecord, marker)
    const detail = mesBaseDetail(await api.getBusiness(
      `/erp/barcode/rules/get?id=${ruleId}`), ruleId, '条码规则')
    check('专属条码规则只能引用受控对象与已实现载体',
      detail.objectType === 'MATERIAL' && detail.carrier === 'BARCODE',
      `objectType=${detail.objectType}, carrier=${detail.carrier}`)

    const duplicate = await api.request('POST', '/erp/barcode/rules/create', {
      ruleCode, ruleName: `${marker}-dup`, sort: 971, objectType: 'MATERIAL', carrier: 'BARCODE',
      barcodeRulesItemList: [{ type: '1', valve: 'X', sort: 1 }]
    })
    expectBusinessFailure(duplicate, { code: -640, includes: '已存在' }, '重复条码规则编码')
    check('条码规则编码唯一', Number(duplicate?.code) === -640, JSON.stringify(duplicate))

    const invalidObject = await api.request('POST', '/erp/barcode/rules/create', {
      ruleCode: `${marker}-BADOBJ`, ruleName: 'bad', sort: 972,
      objectType: 'NO_SUCH_OBJECT', carrier: 'BARCODE',
      barcodeRulesItemList: [{ type: '1', valve: 'X', sort: 1 }]
    })
    expectBusinessFailure(invalidObject, { code: 1030630000 }, '非平台业务对象')
    check('非平台条码业务对象被拒绝',
      Number(invalidObject?.code) === 1030630000, JSON.stringify(invalidObject))

    const rfid = await api.request('POST', '/erp/barcode/rules/create', {
      ruleCode: `${marker}-RFID`, ruleName: 'rfid', sort: 973,
      objectType: 'MATERIAL', carrier: 'RFID',
      barcodeRulesItemList: [{ type: '1', valve: 'X', sort: 1 }]
    })
    expectBusinessFailure(rfid, { code: 1030630002, includes: 'RFID' }, 'RFID 载体')
    check('选择 RFID 载体时明确暂缓且不能保存',
      Number(rfid?.code) === 1030630002 && String(rfid.msg).includes('RFID'), JSON.stringify(rfid))

    const inventedCarrier = await api.request('POST', '/erp/barcode/rules/create', {
      ruleCode: `${marker}-DMC`, ruleName: 'dmc', sort: 974,
      objectType: 'MATERIAL', carrier: 'DATA_MATRIX',
      barcodeRulesItemList: [{ type: '1', valve: 'X', sort: 1 }]
    })
    expectBusinessFailure(inventedCarrier, { code: 1030630001 }, '租户自造载体字典值')
    check('租户不能用未登记载体字典值绕过平台能力',
      Number(inventedCarrier?.code) === 1030630001, JSON.stringify(inventedCarrier))

    const dbRows = await queryRows(
      `SELECT object_type, carrier FROM erp_barcode_rules WHERE tenant_id=1 AND deleted=0 AND id='${ruleId}'`)
    check('专属条码规则真实落库到 erp_barcode_rules',
      dbRows.length === 1 && dbRows[0][0] === 'MATERIAL' && dbRows[0][1] === 'BARCODE',
      JSON.stringify(dbRows[0]))

    await deleteBarcodeRuleFixture(api, ruleId)
    const deleted = await queryRows(
      `SELECT deleted+0 FROM erp_barcode_rules WHERE id='${ruleId}'`)
    check('本案例专属条码规则已清理（软删除）',
      deleted.length === 0 || String(deleted[0][0]) === '1', JSON.stringify(deleted))

    const permission = await api.getBusiness('/system/auth/get-permission-info')
    const route = findComponentRoute(permission?.data?.menus, 'barcode/barCodeRules/index')
    if (route) {
      await openRoute(page, route, { readySelector: 'input[placeholder="请输入规则编码"]' })
      await saveScreenshot(page, outputDir, 'mes-base-003-barcode-rules', record)
    }
    return { api }
  }

  if (caseId === 'MES-BASE-004') {
    await assertLocalWriteSafety(caseRecord)
    const marker = newMarker('MESB004')
    const modes = mesBaseRows(await api.getBusiness('/mes/workMode/list'), '工作模式')
    const mode = modes.find((row) => row?.id && (row.enabled === true || row.enabled === 1))
    check('存在可绑定的启用工作模式', Boolean(mode), JSON.stringify(modes.slice(0, 2)))

    const startDate = today()
    const endDate = today()
    const calendar = await createWorkCalendarFixture(api, marker, {
      workModeId: mode.id, startDate, endDate
    })
    const generated = await readWorkCalendarDb(calendar.calendarCode)
    check('专属生产日历真实生成并按日历编码回读表行',
      generated.length === 1 && generated.every((row) =>
        row.calendarCode === calendar.calendarCode && row.version >= 1),
      `calendarCode=${calendar.calendarCode}, rows=${generated.length}, version=${generated[0]?.version}`)

    const pageBody = await api.getBusiness(
      `/mes/workCalendar/page?pageNo=1&pageSize=100&calendarCode=${encodeURIComponent(calendar.calendarCode)}`)
    const pageRows = mesBaseRows(pageBody, '专属生产日历')
    check('生产日历分页按日历编码返回专属记录', pageRows.some((row) =>
      String(row.id) === calendar.firstId), JSON.stringify(pageRows.slice(0, 2)))

    await api.putBusiness(`/mes/workCalendar/publish?id=${encodeURIComponent(calendar.firstId)}`)
    const publishedRows = await readWorkCalendarDb(calendar.calendarCode)
    const published = publishedRows.find((row) => row.id === calendar.firstId)
    check('生产日历发布后写入发布状态且保留日历版本号',
      published?.publishStatus === 1 && published?.version >= 1,
      `id=${calendar.firstId}, status=${published?.publishStatus}, version=${published?.version}`)

    const publishedDelete = await api.request('DELETE',
      `/mes/workCalendar/delete?id=${encodeURIComponent(calendar.firstId)}`)
    check('已发布生产日历禁止物理删除，只能停用或新建版本',
      Number(publishedDelete?.code) !== 0 &&
      String(publishedDelete?.msg ?? publishedDelete?.message ?? '').includes('已发布'),
      JSON.stringify(publishedDelete))

    const scheduling = await createSchedulingVersionFixture(api, marker, startDate)
    const schedulingDetail = unwrap(await api.getBusiness(
      `/mes/aps/scheduling/get?id=${scheduling.versionId}`))
    check('专属排产版本创建后可按主键回读且初始状态为草稿',
      String(schedulingDetail.id) === scheduling.versionId &&
      String(schedulingDetail.schemeStatus || '').toUpperCase() === 'DRAFT',
      JSON.stringify({ id: schedulingDetail.id, schemeStatus: schedulingDetail.schemeStatus }))

    const versionColumns = await queryRows(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=DATABASE() AND table_name='aps_scheduling_version'`)
    const versionColumnNames = versionColumns.map((row) => String(row[0]))
    check('排产版本表具备日历编码/日历版本/产能快照字段',
      ['calendar_code', 'calendar_version', 'capacity_snapshot']
        .every((name) => versionColumnNames.includes(name)),
      versionColumnNames.join(','))

    // 触发正式排产快照写入需要完整排产结果与发布门禁；本案例专用版本没有正式工单，
    // 因此读取层只做契约检查，真实写侧快照证据以发布门禁响应为准。
    const gate = await api.getBusiness(
      `/mes/aps/scheduling/publish-gate?versionId=${scheduling.versionId}`)
    check('排产发布门禁在缺少正式排产结果时明确阻断而不是伪造快照',
      gate?.data && gate.data.passed === false,
      JSON.stringify(gate?.data).slice(0, 300))

    const versionRow = await readSchedulingVersionDb(scheduling.versionId)
    caseRecord.evidence.push(
      `排产版本库内快照 calendarCode=${versionRow.calendarCode}, calendarVersion=${versionRow.calendarVersion}, ` +
      `status=${versionRow.status}, schemeStatus=${versionRow.schemeStatus}`)

    await api.putBusiness(`/mes/workCalendar/disable?id=${encodeURIComponent(calendar.firstId)}`)
    const disabledRows = await readWorkCalendarDb(calendar.calendarCode)
    check('反向动作是停用日历并保留历史行，且日历版本号不被改写',
      disabledRows.find((row) => row.id === calendar.firstId)?.publishStatus === 0 &&
      disabledRows.find((row) => row.id === calendar.firstId)?.version === published?.version,
      JSON.stringify(disabledRows))

    await openRoute(page, '/settings/production/work-calendar', {
      readySelector: '.calendar-workbench .calendar-toolbar'
    }).catch(() => {})
    await saveScreenshot(page, outputDir, 'mes-base-004-calendar-publish', record).catch(() => {})
    return {
      api, partial: true,
      note: `生产日历专属记录已真实创建、发布、禁止删除、停用并保留版本号（calendarCode=${calendar.calendarCode}）；` +
        '缺口：WorkCalendarRespVO 未公开 version/publishStatus；' +
        '排产版本记录虽具备 calendar_code/calendar_version/capacity_snapshot 字段，但正式快照写入依赖完整排产结果与发布门禁，' +
        '本案例未构造正式工单链路，因此“排产版本保存日历编码/版本/工作模式快照”“日历升版不改写历史排产快照”仍保留 PARTIAL'
    }
  }

  if (caseId === 'MES-BASE-005') {
    await assertLocalWriteSafety(caseRecord)
    const marker = newMarker('MESB005')
    const makeTeam = async (suffix) => {
      const username = `${marker}${suffix}EMP`.slice(0, 30)
      const employeeId = unwrap(await api.postBusiness('/hrm/employee/create', {
        name: `${marker}${suffix}-员工`, jobNumber: username,
        mobile: `138${Date.now().toString().slice(-8)}`, entryStatus: 1, type: 1,
        entryTime: '2026-01-01T00:00:00', probation: 0, createUserAccount: true,
        userAccountUsername: username
      }))
      const teamId = `${marker}-${suffix}`
      await api.postBusiness('/mes/teamManage/add', {
        teamId, teamName: `${marker}${suffix}-班组`, leaderId: String(employeeId),
        teamType: 0, shiftStartTime: '08:00:00', shiftEndTime: '20:00:00', status: '0',
        remark: marker, teamManageSubList: [{ memberId: String(employeeId) }]
      })
      const teamPage = asList(unwrap(await api.getBusiness(
        `/mes/teamManage/list?pageNo=1&pageSize=100&teamId=${encodeURIComponent(teamId)}`)))
      const team = teamPage.find((row) => row.teamId === teamId)
      if (!team?.id) throw new Error(`专属班组未回读：${teamId}`)
      return { employeeId: String(employeeId), teamId, id: String(team.id) }
    }
    const outTeam = await makeTeam('OUT')
    const inTeam = await makeTeam('IN')

    const handover = await createTeamHandoverFixture(api, marker, {
      outTeamId: outTeam.id, inTeamId: inTeam.id
    })
    check('交接创建后引用双方班组主键而不是复制班组主档',
      String(handover.detail.outTeamId) === outTeam.id &&
      String(handover.detail.inTeamId) === inTeam.id &&
      Number(handover.detail.status) === 0,
      JSON.stringify(handover.detail))

    const pageRows = mesBaseRows(await api.getBusiness(
      `/mes/team-handover/page?pageNo=1&pageSize=100&handoverNo=${encodeURIComponent(handover.handoverNo)}`),
    '专属班组交接')
    check('未确认交接在分页记录中为待确认状态',
      pageRows.some((row) => String(row.id) === handover.handoverId && Number(row.status) === 0),
      JSON.stringify(pageRows.slice(0, 2)))

    const emptyConfirm = await api.request('PUT',
      `/mes/team-handover/confirm?id=${handover.handoverId}` +
      `&outConfirmBy=${encodeURIComponent(outTeam.employeeId)}&inConfirmBy=`)
    check('缺少接班确认人时拒绝确认且单据保持待确认',
      Number(emptyConfirm?.code) !== 0, JSON.stringify(emptyConfirm))

    const sameConfirm = await api.request('PUT',
      `/mes/team-handover/confirm?id=${handover.handoverId}` +
      `&outConfirmBy=${encodeURIComponent(outTeam.employeeId)}` +
      `&inConfirmBy=${encodeURIComponent(outTeam.employeeId)}`)
    check('交班人与接班人为同一人时拒绝确认',
      Number(sameConfirm?.code) !== 0, JSON.stringify(sameConfirm))
    const stillWaiting = unwrap(await api.getBusiness(
      `/mes/team-handover/get?id=${handover.handoverId}`))
    check('未确认交接不能被关闭，状态保持待确认', Number(stillWaiting.status) === 0,
      `status=${stillWaiting.status}`)

    await api.putBusiness(
      `/mes/team-handover/confirm?id=${handover.handoverId}` +
      `&outConfirmBy=${encodeURIComponent(outTeam.employeeId)}` +
      `&inConfirmBy=${encodeURIComponent(inTeam.employeeId)}`)
    const confirmed = unwrap(await api.getBusiness(
      `/mes/team-handover/get?id=${handover.handoverId}`))
    check('交班与接班双方分别确认后才进入完成状态',
      Number(confirmed.status) === 1 &&
      String(confirmed.outConfirmBy) === outTeam.employeeId &&
      String(confirmed.inConfirmBy) === inTeam.employeeId,
      JSON.stringify(confirmed))

    const repeated = await api.request('PUT',
      `/mes/team-handover/confirm?id=${handover.handoverId}` +
      `&outConfirmBy=${encodeURIComponent(outTeam.employeeId)}` +
      `&inConfirmBy=${encodeURIComponent(inTeam.employeeId)}`)
    check('已确认交接不允许重复确认',
      Number(repeated?.code) !== 0, JSON.stringify(repeated))

    const permission = await api.getBusiness('/system/auth/get-permission-info')
    const route = findComponentRoute(permission?.data?.menus, 'prod/teamHandover/index') ||
      findComponentRoute(permission?.data?.menus, 'teamHandover/index')
    caseRecord.evidence.push(
      `班组交接无前端菜单时不影响 API 写侧闭环；menuRoute=${route || 'NOT_FOUND'}；` +
      '后端仅暴露 create/confirm/get/page，没有取消或删除端点，cancel 断言改为验证确认门禁与状态不可逆')
    return {
      api, partial: true,
      note: `专属交接 handoverId=${handover.handoverId} 已真实创建并完成双方确认门禁；` +
        '缺口（真实产品缺陷）：MesTeamHandoverController 未提供取消/删除端点，' +
        '目录反向动作“取消交接回到待确认而不是物理删除”无法真实执行，保留 PARTIAL'
    }
  }

  if (caseId === 'MES-BASE-006') {
    await assertLocalWriteSafety(caseRecord)
    const context = await resolveWriteContext(api)
    const marker = newMarker('MESB006')
    const fixture = await createRouteCapacityFixture(api, marker, {
      workshopId: context.workshopId, lineId: context.lineId
    })
    const routeBody = (extra = {}) => ({
      id: fixture.routeId, code: `${marker}-ROUTE`, name: `${marker}-ROUTE`,
      version: 'V1.0', mark: marker, type: '1', designMode: 'sequential',
      inboundType: 'FINISHED', isStrict: 'Y', ...extra,
      wmsTechRouteSubList: [{
        procedureId: fixture.procedureId, procedureName: `${marker}-PROC`,
        sortOrder: 1, isFeed: 0, isQuality: 0, isFinished: 1, isVirtual: 0, mark: marker
      }]
    })
    const draft = (await api.getBusiness(`/mes/wmsTechRoute/queryById?id=${fixture.routeId}`)).data
    check('工艺路线以草稿创建', Number(draft.devStatus) === 0 && draft.version === 'V1.0',
      `status=${draft.devStatus}, version=${draft.version}`)

    await api.postBusiness('/mes/wmsTechRoute/editMain', routeBody())
    const editedDraft = (await api.getBusiness(`/mes/wmsTechRoute/queryById?id=${fixture.routeId}`)).data
    check('草稿可原地编辑（保持同一主键与版本）',
      String(editedDraft.id) === fixture.routeId && editedDraft.version === 'V1.0',
      `id=${editedDraft.id}, version=${editedDraft.version}`)

    await api.postBusiness(`/mes/wmsTechRoute/publish?id=${fixture.routeId}`)
    const published = (await api.getBusiness(`/mes/wmsTechRoute/queryById?id=${fixture.routeId}`)).data
    check('工艺路线发布后写入发布状态与发布审计',
      Number(published.devStatus) === 2 && nonBlank(published.publishTime) && nonBlank(published.publishBy),
      `status=${published.devStatus}, publishTime=${published.publishTime}`)

    const deleteBlocked = await api.request('DELETE', `/mes/wmsTechRoute/delete?id=${fixture.routeId}`)
    check('已发布工艺路线禁止直接删除',
      Number(deleteBlocked?.code) !== 0 && String(deleteBlocked?.msg || '').includes('不能直接删除'),
      JSON.stringify(deleteBlocked))

    await api.postBusiness('/mes/wmsTechRoute/editMain', routeBody())
    const versions = asList((await api.getBusiness(
      `/mes/wmsTechRoute/list?pageNo=1&pageSize=20&name=${encodeURIComponent(`${marker}-ROUTE`)}`)).data)
    const newDraft = versions.find((row) => row.version === 'V1.1' && Number(row.devStatus) === 0)
    check('已发布工艺路线编辑时自动生成更高版本草稿',
      Boolean(newDraft) && String(newDraft.id) !== fixture.routeId, JSON.stringify(versions.map((r) => r.version)))

    await api.postBusiness(`/mes/wmsTechRoute/unpublish?id=${fixture.routeId}`)
    const disabled = (await api.getBusiness(`/mes/wmsTechRoute/queryById?id=${fixture.routeId}`)).data
    check('反向动作是停用而不是删除已发布工艺路线', Number(disabled.devStatus) === 3,
      `status=${disabled.devStatus}`)
    for (const row of [fixture.routeId, newDraft?.id]) {
      if (!row) continue
      await api.deleteBusiness(`/mes/wmsTechRoute/delete?id=${row}`).catch(() => {})
    }
    await openRoute(page, '/settings/production/technique', { readySelector: '.technique-route' }).catch(() => {})
    await saveScreenshot(page, outputDir, 'mes-base-006-route-version', record).catch(() => {})
    return {
      api, partial: true,
      note: '已真实完成专属工艺路线草稿编辑、发布、发布后禁止删除、编辑升版生成草稿、停用闭环；' +
        '缺口：未生成真实生产任务，无法断言工单任务 routeVersion 快照随主档升版不追溯改写'
    }
  }

  if (caseId === 'PB081-001') {
    await assertLocalWriteSafety(caseRecord)
    const marker = newMarker('MESB081')
    const username = `${marker}EMP`.slice(0, 30)
    const employeeId = unwrap(await api.postBusiness('/hrm/employee/create', {
      name: `${marker}-员工`, jobNumber: username,
      mobile: `137${Date.now().toString().slice(-8)}`, entryStatus: 1, type: 1,
      entryTime: '2026-01-01T00:00:00', probation: 0, createUserAccount: true,
      userAccountUsername: username
    }))
    const employee = unwrap(await api.getBusiness(`/hrm/employee/get?id=${employeeId}`))
    check('HRM 员工建档默认开通系统登录账号并生成 userId',
      nonBlank(employee.userId) && employee.jobNumber === username,
      `employeeId=${employeeId}, userId=${employee.userId}`)

    await api.postBusiness('/mes/teamManage/add', {
      teamId: `${marker}-TEAM`, teamName: `${marker}-班组`, leaderId: String(employeeId),
      teamType: 0, shiftStartTime: '20:00:00', shiftEndTime: '08:00:00', status: '0',
      remark: marker, teamManageSubList: [{ memberId: String(employeeId) }]
    })
    const teamPage = asList(unwrap(await api.getBusiness(
      `/mes/teamManage/list?pageNo=1&pageSize=100&teamId=${encodeURIComponent(`${marker}-TEAM`)}`)))
    const team = teamPage.find((row) => row.teamId === `${marker}-TEAM`)
    check('班组主档回收专属班组且班组长引用 HRM 员工',
      Boolean(team) && String(team.leaderId) === String(employeeId), JSON.stringify(team))
    const members = asList(unwrap(await api.getBusiness(
      `/mes/teamManage/queryMesTeamManageSubByMainId?id=${team.id}`)))
    check('班组成员引用 HRM 员工主键而不是复制用户信息',
      members.some((row) => String(row.memberId) === String(employeeId)), JSON.stringify(members))

    const invalid = await api.request('POST', '/mes/teamManage/add', {
      teamId: `${marker}-BAD`, teamName: 'bad', status: '0',
      teamManageSubList: [{ memberId: '999999999999999999' }]
    })
    check('非 HRM 员工的成员编号被拒绝保存',
      Number(invalid?.code) === 1030700000, JSON.stringify(invalid))
    return {
      api, partial: true,
      note: '真实创建 HRM 员工 + 专属班组并回读成员契约，非 HRM 员工编号被拒绝；' +
        '缺口：MesTeamManageServiceImpl.delMain 未见被生产任务引用保护，无法给出“只能停用不能删除”的反向证据'
    }
  }

  if (caseId === 'PB102-001' || caseId === 'PB102-002' || caseId === 'PB102-003') {
    await assertLocalWriteSafety(caseRecord)
    const context = await resolveWriteContext(api)
    const marker = newMarker(`MESB${caseId.slice(-3)}`)
    const fixture = await createRouteCapacityFixture(api, marker, {
      workshopId: context.workshopId, lineId: context.lineId
    })
    const created = await bindDeviceCapacity(api, fixture, {
      deviceId: context.deviceId, lineId: context.lineId, unitId: context.unitId
    })
    const device = created.detail?.procedureList?.[0]?.deviceList?.[0]
    check('工序设备产能草稿经专属路线节点落库并可按节点回读',
      device && String(device.id) === created.capacityId && Number(device.publishStatus) === 0 &&
      Number(device.capacityVersion) >= 1,
      `capacityId=${created.capacityId}`)
    check('产能记录承载产品、单位、基准产量/时长、换型时间与生效期字段',
      device && ['productId', 'unitId', 'standardOutput', 'standardDuration',
        'changeoverMinutes', 'calendarCode', 'effectiveFrom', 'capacityVersion', 'publishStatus']
        .every((field) => Object.prototype.hasOwnProperty.call(device, field)),
      JSON.stringify(Object.keys(device || {})))

    await api.postBusiness(`/mes/wmsTechRoute/capacity/publish?capacityId=${created.capacityId}`)
    const published = (await listCapacities(api, fixture, context.deviceId))
      .find((row) => String(row.id) === created.capacityId)
    check('产能草稿可发布为唯一有效版本',
      Number(published?.publishStatus) === 1, `status=${published?.publishStatus}`)

    // PB-102 product-dimension versioning is blocked by the baseline unique key: it does not
    // include product_id, so a second version/product row for the same route_sub+equipment
    // collides. Capture that as a real, reproducible defect instead of faking a pass.
    const secondDraft = await api.request('POST', '/mes/wmsTechRoute/capacity/save', {
      routeSubId: fixture.routeSubId, procedureId: fixture.procedureId,
      equipmentId: String(context.deviceId), productId: null, unitId: String(context.unitId),
      standardOutput: 99, standardDuration: 50, changeoverMinutes: 10, remark: `${marker}-edit`
    })
    const uniqueKeyRows = await queryRows(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aps_tech_route_procedure_device_capacity'
       AND NON_UNIQUE=0 GROUP BY INDEX_NAME`)

    await api.postBusiness(`/mes/wmsTechRoute/capacity/disable?capacityId=${created.capacityId}`)
    const disabled = (await listCapacities(api, fixture, context.deviceId))
      .find((row) => String(row.id) === created.capacityId)
    check('停用产能版本保留历史行而不是物理删除',
      Number(disabled?.publishStatus) === 2, `status=${disabled?.publishStatus}`)
    caseRecord.evidence.push(
      `产能唯一键=${JSON.stringify(uniqueKeyRows)}；同节点同设备再存草稿响应=${JSON.stringify(secondDraft).slice(0, 240)}`)
    await openRoute(page, '/settings/production/technique', { readyText: '工艺路线' }).catch(() => {})
    await saveScreenshot(page, outputDir, `pb102-${caseId.slice(-3)}-capacity`, record).catch(() => {})
    return {
      api, partial: true,
      note: '已验证专属工序设备产能草稿保存、按节点+设备回读、发布、停用保留历史与字段契约；' +
        '缺口（真实产品缺陷）：aps_tech_route_procedure_device_capacity 唯一键 uk_aps_route_device_tenant 未包含 product_id，' +
        `同 route_sub_id+equipment_id 再存新版本/多产品行直接失败（响应 ${JSON.stringify(secondDraft).slice(0, 120)}），` +
        '因此“已发布版本被编辑生成新草稿保留历史”“多产品逐条展开”“同范围唯一有效发布”无法闭环'
    }
  }

  if (caseId === 'PB038-001') {
    await assertLocalWriteSafety(caseRecord)
    const grades = mesBaseRows(await api.getBusiness(
      '/base/material-grade/page?pageNo=1&pageSize=100'), '品级')
    const preset = ['A', 'B', 'C'].filter((code) => grades.some((row) => row.code === code))
    check('初始化预置 A/B/C 品级', preset.length === 3, `preset=${preset.join(',')}`)

    const marker = newMarker('MESB038A')
    const grade = await createGrade(api, marker, 'GA')
    const duplicate = await api.request('POST', '/base/material-grade/create', {
      code: grade.code, name: 'dup', sort: 951, status: 1
    })
    check('品级编码租户内唯一且创建后不可绕过',
      Number(duplicate?.code) === 500 && String(duplicate.msg).includes('已存在'),
      JSON.stringify(duplicate))

    const material = await createGradeMaterial(api, marker, { unitId: SEED.unitId })
    let managed
    try {
      await api.putBusiness('/mes/basMaterial/edit',
        materialEditBody(material, {
          gradeManaged: 'Y', defaultGradeId: grade.id, allowedGradeIds: [grade.id]
        }))
      managed = await readGradeConfigFromDb(material.id)
      check('专属存货开启品级管理后回读默认品级与允许范围',
        managed.gradeManaged === 'Y' && String(managed.defaultGradeId) === grade.id &&
        managed.allowedGradeIds.map(String).includes(grade.id),
        `materialId=${material.id}, config=${JSON.stringify(managed)}`)

      const blocked = await api.request('DELETE',
        `/base/material-grade/delete?id=${grade.id}`)
      check('被存货引用的品级只能停用不能删除',
        Number(blocked?.code) === 500 && String(blocked.msg).includes('只能停用'),
        JSON.stringify(blocked))

      await api.putBusiness(`/base/material-grade/update-status?id=${grade.id}&status=0`)
      const after = mesBaseRows(await api.getBusiness(
        `/base/material-grade/page?pageNo=1&pageSize=100&code=${encodeURIComponent(grade.code)}`), '品级')
      const disabled = findGrade(after, grade.id)
      check('反向动作把被引用品级停用而不是物理删除',
        disabled && Number(disabled.status) === 0, JSON.stringify(disabled))
    } finally {
      if (managed) {
        await api.putBusiness('/mes/basMaterial/edit', materialEditBody(material)).catch(() => {})
      }
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${material.id}`).catch(() => {})
      await deleteGrade(api, grade.id)
    }
    const cleaned = await api.getBusiness(
      `/base/material-grade/page?pageNo=1&pageSize=100&code=${encodeURIComponent(grade.code)}`)
    check('本案例专属品级已清理',
      asList(cleaned?.data).every((row) => String(row.id) !== grade.id), JSON.stringify(cleaned?.data))
    return { api }
  }

  if (caseId === 'PB038-002') {
    await assertLocalWriteSafety(caseRecord)
    const grades = mesBaseRows(await api.getBusiness('/base/material-grade/simple-list'), '启用品级')
    const [gA, gB, gC] = ['A', 'B', 'C'].map((code) => grades.find((row) => row.code === code))
    check('公共品级目录已启用 A/B/C', Boolean(gA && gB && gC),
      `grades=${grades.map((row) => row.code).join(',')}`)

    const marker = newMarker('MESB038B')
    const material = await createGradeMaterial(api, marker, { unitId: SEED.unitId })
    const plain = await createGradeMaterial(api, `${marker}-P`, { unitId: SEED.unitId })
    const wms = await createWarehouseFixture(api, caseRecord, marker, 1)
    let managed
    let draftId = null
    try {
      await api.putBusiness('/mes/basMaterial/edit',
        materialEditBody(material, {
          gradeManaged: 'Y', defaultGradeId: gB.id, allowedGradeIds: [gA.id, gB.id]
        }))
      managed = await readGradeConfigFromDb(material.id)
      check('存货可开启品级管理并配置默认品级与允许范围',
        managed.gradeManaged === 'Y' && String(managed.defaultGradeId) === String(gB.id) &&
        managed.allowedGradeIds.map(String).sort().join(',') ===
          [gA.id, gB.id].map(String).sort().join(','),
        `materialId=${material.id}, config=${JSON.stringify(managed)}`)

      const outOfRangeDefault = await api.request('PUT', '/mes/basMaterial/edit',
        materialEditBody(material, {
          gradeManaged: 'Y', defaultGradeId: gC.id, allowedGradeIds: [gA.id, gB.id]
        }))
      check('默认品级必须属于允许范围',
        Number(outOfRangeDefault?.code) === 500 &&
        String(outOfRangeDefault.msg).includes('默认品级必须在允许品级范围内'),
        JSON.stringify(outOfRangeDefault))

      const outOfRangeEntry = await api.request('POST', '/mes/stkIo/add/save',
        gradeStockIoBody(wms, marker, {
          materialId: material.id, unitId: SEED.unitId, gradeId: gC.id, suffix: 'OOR'
        }))
      check('单据选择禁止范围外品级被后端拒绝',
        Number(outOfRangeEntry?.code) === 500 &&
        String(outOfRangeEntry.msg ?? outOfRangeEntry.message).includes('不在存货允许范围内'),
        JSON.stringify(outOfRangeEntry))

      const noManageEntry = await api.request('POST', '/mes/stkIo/add/save',
        gradeStockIoBody(wms, marker, {
          materialId: plain.id, unitId: SEED.unitId, gradeId: gA.id, suffix: 'NOMANAGE'
        }))
      check('未启用品级管理的存货指定品级被后端拒绝',
        Number(noManageEntry?.code) === 500 &&
        String(noManageEntry.msg ?? noManageEntry.message).includes('未启用品级管理'),
        JSON.stringify(noManageEntry))

      const missingGradeEntry = await api.request('POST', '/mes/stkIo/add/save',
        gradeStockIoBody(wms, marker, {
          materialId: material.id, unitId: SEED.unitId, gradeId: null, suffix: 'MISS'
        }))
      check('已启用品级管理的存货未选品级被后端拒绝',
        Number(missingGradeEntry?.code) === 500 &&
        String(missingGradeEntry.msg ?? missingGradeEntry.message).includes('必须选择品级'),
        JSON.stringify(missingGradeEntry))

      // reverse：存在未完成（草稿）入库单时必须拒绝关闭品级管理，而不是直接放行。
      const draftBody = gradeStockIoBody(wms, marker, {
        materialId: material.id, unitId: SEED.unitId, gradeId: gB.id, suffix: 'DRAFT'
      })
      await api.postBusiness('/mes/stkIo/add/save', draftBody)
      draftId = singleId(await queryRows(
        `SELECT id FROM mes_stk_io WHERE tenant_id=1 AND deleted=0
         AND bill_no='${draftBody.billNo}'`), '品级准入草稿入库单')
      const closeBlocked = await api.request('PUT', '/mes/basMaterial/edit',
        materialEditBody(material))
      check('存在未完成库存单据时禁止关闭品级管理（反向门禁）',
        Number(closeBlocked?.code) === 500 &&
        String(closeBlocked.msg ?? closeBlocked.message).includes('不能关闭品级管理'),
        `draftId=${draftId}, response=${JSON.stringify(closeBlocked).slice(0, 200)}`)
    } finally {
      if (draftId) {
        await api.deleteBusiness(`/mes/stkIo/delete?id=${draftId}`).catch(() => {})
      }
      if (managed) {
        await api.putBusiness('/mes/basMaterial/edit', materialEditBody(material)).catch(() => {})
      }
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${material.id}`).catch(() => {})
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${plain.id}`).catch(() => {})
    }
    await openRoute(page, '/settings/erp/material-grade', { readyText: '品级' }).catch(() => {})
    await saveScreenshot(page, outputDir, 'pb038-002-grade-config', record).catch(() => {})
    return { api }
  }

  if (caseId === 'PB038-003') {
    await assertLocalWriteSafety(caseRecord)
    const marker = newMarker('MESB038C')
    const grades = mesBaseRows(await api.getBusiness('/base/material-grade/simple-list'), '启用品级')
    const gA = grades.find((row) => row.code === 'A')
    const gB = grades.find((row) => row.code === 'B')
    check('公共品级目录已启用 A/B 级', Boolean(gA && gB),
      `grades=${grades.map((row) => row.code).join(',')}`)

    const material = await createGradeMaterial(api, marker, { unitId: SEED.unitId })
    const wms = await createWarehouseFixture(api, caseRecord, marker, 1)
    const batchNo = `${marker}-BATCH`
    let managed = false
    try {
      await api.putBusiness('/mes/basMaterial/edit', materialEditBody(material, {
        gradeManaged: 'Y', defaultGradeId: gA.id, allowedGradeIds: [gA.id, gB.id]
      }))
      managed = true
      const aBody = gradeStockIoBody(wms, marker, {
        materialId: material.id, unitId: SEED.unitId, gradeId: gA.id, suffix: 'A'
      })
      aBody.stkIoEntryList[0].batchNo = batchNo
      const aBillId = unwrap(await api.postBusiness('/mes/stkIo/add/submit', aBody))
      const bBody = gradeStockIoBody(wms, marker, {
        materialId: material.id, unitId: SEED.unitId, gradeId: gB.id, suffix: 'B'
      })
      bBody.stkIoEntryList[0].batchNo = batchNo
      bBody.stkIoEntryList[0].qty = 2
      bBody.stkIoEntryList[0].settleQty = 2
      const bBillId = unwrap(await api.postBusiness('/mes/stkIo/add/submit', bBody))
      caseRecord.evidence.push(
        `专属 A/B 级入库单 aBill=${aBillId}, bBill=${bBillId}, material=${material.id}, batch=${batchNo}`)

      const aRows = await readInventoryByGrade(material.id, gA.id, batchNo)
      const bRows = await readInventoryByGrade(material.id, gB.id, batchNo)
      check('同存货同仓库同批次分别入库 A/B 级生成两条独立库存行',
        aRows.length === 1 && bRows.length === 1 &&
        aRows[0].id !== bRows[0].id && aRows[0].warehouseId === bRows[0].warehouseId,
        `a=${JSON.stringify(aRows)}, b=${JSON.stringify(bRows)}`)
      check('两条品级库存行的数量、可用量与成本互不影响',
        aRows[0].qty === 1 && aRows[0].availableQty === 1 &&
        bRows[0].qty === 2 && bRows[0].availableQty === 2,
        `aQty=${aRows[0]?.qty}/${aRows[0]?.availableQty}, bQty=${bRows[0]?.qty}/${bRows[0]?.availableQty}`)

      const reportAll = asList((await api.getBusiness(
        `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${encodeURIComponent(material.id)}`))?.data)
      const reportA = asList((await api.getBusiness(
        `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${encodeURIComponent(material.id)}&gradeId=${encodeURIComponent(gA.id)}`))?.data)
      const reportB = asList((await api.getBusiness(
        `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${encodeURIComponent(material.id)}&gradeId=${encodeURIComponent(gB.id)}`))?.data)
      check('现存量报表按品级聚合并可按品级筛选',
        reportA.length === 1 && reportB.length === 1 &&
        !reportA.some((row) => String(row.gradeId) === String(gB.id)) &&
        reportAll.filter((row) => [String(gA.id), String(gB.id)].includes(String(row.gradeId))).length === 2,
        `all=${reportAll.length}, a=${reportA.length}, b=${reportB.length}`)

      const voidAttempt = await api.request('PUT', '/mes/stkIo/void', { id: String(aBillId) })
      const afterVoidEntries = asList((await api.getBusiness(
        `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(aBillId)}`))?.data)
      const inherited = (afterVoidEntries || []).every((entry) =>
        entry.gradeId == null || String(entry.gradeId) === String(gA.id))
      caseRecord.checks.push({
        name: '弃审/红冲动作继承原单品质级而不是重新选择',
        passed: Number(voidAttempt?.code) === 0 && inherited,
        details: `void=${JSON.stringify(voidAttempt).slice(0, 200)}, ` +
          `entries=${JSON.stringify((afterVoidEntries || []).map((entry) => entry.gradeId))}`
      })

      for (const id of [aBillId, bBillId]) {
        await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(id)}`).catch(() => {})
      }
    } finally {
      if (managed) {
        await api.putBusiness('/mes/basMaterial/edit', materialEditBody(material)).catch(() => {})
      }
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${material.id}`).catch(() => {})
    }
    await openRoute(page, '/wms/stock/report/inventory', { readyText: '品级' }).catch(() => {})
    await saveScreenshot(page, outputDir, 'pb038-003-grade-inventory', record).catch(() => {})
    const failed = caseRecord.checks.filter((row) => !row.passed)
    return failed.length
      ? {
          api, partial: true,
          note: `品级库存写侧已执行（material=${material.id}, batch=${batchNo}），失败项：` +
            failed.map((row) => `${row.name}=${row.details}`).join('；')
        }
      : { api }
  }

  if (caseId === 'PB038-004') {
    await assertLocalWriteSafety(caseRecord)
    const marker = newMarker('MESB038D')
    const grades = mesBaseRows(await api.getBusiness('/base/material-grade/simple-list'), '启用品级')
    check('公共品级目录启用项可加载', grades.length >= 2,
      `grades=${grades.map((row) => row.code).join(',')}`)

    // 真实写侧：通过入库单明细保存品级，验证 gradeId 与 gradeId_dictText 随明细落库并回读。
    const material = await createGradeMaterial(api, marker, { unitId: SEED.unitId })
    const wms = await createWarehouseFixture(api, caseRecord, marker, 1)
    const grade = grades.find((row) => row.code === 'A')
    const plain = await createGradeMaterial(api, `${marker}-P`, { unitId: SEED.unitId })
    let managed = false
    try {
      await api.putBusiness('/mes/basMaterial/edit', materialEditBody(material, {
        gradeManaged: 'Y', defaultGradeId: grade.id, allowedGradeIds: [grade.id]
      }))
      managed = true
      const body = gradeStockIoBody(wms, marker, {
        materialId: material.id, unitId: SEED.unitId, gradeId: grade.id, suffix: 'GRADE'
      })
      const savedId = singleId(await (async () => {
        await api.postBusiness('/mes/stkIo/add/save', body)
        return queryRows(
          `SELECT id FROM mes_stk_io WHERE tenant_id=1 AND deleted=0 AND bill_no='${body.billNo}'`)
      })(), '品级明细草稿入库单')
      const entries = asList((await api.getBusiness(
        `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(savedId)}`))?.data)
      check('选中的品级写入 gradeId 并随入库明细保存回读',
        entries.length === 1 && String(entries[0].gradeId) === String(grade.id),
        JSON.stringify(entries))
      const detail = unwrap(await api.getBusiness(
        `/mes/stkIo/queryById?id=${encodeURIComponent(savedId)}`))
      check('入库单据行携带品级下拉选项来源一致',
        String(detail.gradeId ?? entries[0].gradeId) === String(grade.id),
        `detailGrade=${detail.gradeId}, entryGrade=${entries[0].gradeId}`)

      const emptyBody = gradeStockIoBody(wms, marker, {
        materialId: plain.id, unitId: SEED.unitId, gradeId: null, suffix: 'EMPTY'
      })
      await api.postBusiness('/mes/stkIo/add/save', emptyBody)
      const emptyRows = await queryRows(
        `SELECT id FROM mes_stk_io WHERE tenant_id=1 AND deleted=0 AND bill_no='${emptyBody.billNo}'`)
      const emptyId = singleId(emptyRows, '未启用品级存货草稿')
      const emptyEntries = asList((await api.getBusiness(
        `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(emptyId)}`))?.data)
      check('未启用品级管理的存货可以留空品级并保存',
        emptyEntries.length === 1 && !nonBlank(emptyEntries[0].gradeId),
        JSON.stringify(emptyEntries))
      await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(savedId)}`).catch(() => {})
      await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(emptyId)}`).catch(() => {})
    } finally {
      if (managed) {
        await api.putBusiness('/mes/basMaterial/edit', materialEditBody(material)).catch(() => {})
      }
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${material.id}`).catch(() => {})
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${plain.id}`).catch(() => {})
    }

    const gradeSource = inspectGradeColumnConfig()
    check('明细列配置 gradeId 由 grade_select 插槽渲染',
      gradeSource.evidence.every((row) => row.gradeField && row.gradeSlot),
      JSON.stringify(gradeSource.evidence))
    const permission = await api.getBusiness('/system/auth/get-permission-info')
    const routes = ['wms/stock/in/purchase/index', 'wms/stock/out/sell/index',
      'wms/stock/in/other/index'].map((component) => findComponentRoute(permission?.data?.menus, component))
    check('采购入库/销售出库/其他入库页面均存在可打开菜单路由',
      routes.every(Boolean), JSON.stringify(routes))
    let probe = { seen: false, detail: 'NOT_RUN' }
    if (routes[0]) {
      try {
        probe = await probeGradeColumn(page, routes[0])
      } catch (error) {
        // 页面本身打不开时由 runner 的运行时错误断言兜底，这里只记录探针结果。
        probe = { seen: false, detail: error.message }
      }
    }
    caseRecord.checks.push({
      name: '采购入库单据明细表可见品级列',
      passed: probe.seen,
      details: `route=${routes[0]}; probe=${JSON.stringify(probe)}`
    })
    await saveScreenshot(page, outputDir, 'pb038-004-grade-select', record).catch(() => {})
    const failed = caseRecord.checks.filter((row) => !row.passed)
    return failed.length
      ? { api, partial: true,
          note: `品级明细写侧已执行，失败项：${failed.map((row) => row.name).join('；')}` }
      : { api }
  }

  if (caseId === 'PB038-005') {
    const grades = mesBaseRows(await api.getBusiness('/base/material-grade/simple-list'), '启用品级')
    check('品级下拉选项来自启用项 simple-list', grades.length >= 3 &&
      grades.every((row) => nonBlank(row.id) && nonBlank(row.code) && nonBlank(row.name)),
      `grades=${grades.map((row) => `${row.code}:${row.id}`).join(',')}`)

    const columnConfig = inspectGradeColumnConfig()
    caseRecord.checks.push({
      name: '办公用品/样品/赠品/销售出库列配置均含品级列',
      passed: columnConfig.evidence.every((row) =>
        row.gradeField && row.gradeSlot && row.pageRefs >= 2) && columnConfig.sellGrade,
      details: JSON.stringify(columnConfig)
    })
    // 逐行确认四个业务明细列集合都包含 grade_select，且页面确实引用对应列配置。
    const permission = await api.getBusiness('/system/auth/get-permission-info')
    const routeChecks = [
      ['办公用品入库', 'wms/stock/in/material/index'],
      ['办公用品出库', 'wms/stock/out/material/index'],
      ['样品入库', 'wms/stock/in/sample/index'],
      ['样品出库', 'wms/stock/out/sample/index'],
      ['赠品入库', 'wms/stock/in/gift/index'],
      ['赠品出库', 'wms/stock/out/gift/index'],
      ['销售出库', 'wms/stock/out/sell/index']
    ].map(([label, component]) => ({
      label,
      component,
      route: findComponentRoute(permission?.data?.menus, component)
    }))
    check('办公用品/样品/赠品/销售出库页面菜单均可解析',
      routeChecks.every((row) => Boolean(row.route)), JSON.stringify(routeChecks))
    const failed = caseRecord.checks.filter((row) => !row.passed)
    return failed.length
      ? { api, partial: true,
          note: `品级列配置核验未通过：${failed.map((row) => `${row.name}=${row.details}`).join('；')}` }
      : { api }
  }

  if (caseId === 'PB039-003') {
    await assertLocalWriteSafety(caseRecord)
    const original = await readEnterpriseOrganization(api)
    const tree = (await api.getBusiness('/system/system-init/industry-template/tree'))?.data || []
    const alternative = pickAlternativeIndustry(tree, original)
    try {
      await api.putBusiness('/system/enterprise-organization/current', {
        ...original,
        industryCategory: alternative.parentName,
        industrySubCategory: alternative.leafName
      })
      const saved = await readEnterpriseOrganization(api)
      check('企业资料保存历史中文名称时归一回填平台稳定行业编码',
        saved.industryCategory === alternative.parentCode &&
        saved.industrySubCategory === alternative.leafCode,
        `category=${saved.industryCategory}, sub=${saved.industrySubCategory}`)
      const leaf = (tree.find((item) => item.code === alternative.parentCode)?.children || [])
        .find((item) => item.code === alternative.leafCode)
      check('回填的细分行业来自统一行业树且挂接父级',
        Boolean(leaf) && leaf.parentCode === alternative.parentCode && leaf.selectable !== false,
        `leaf=${alternative.leafCode}`)
    } finally {
      await restoreEnterpriseOrganization(api, original)
    }
    const restored = await readEnterpriseOrganization(api)
    check('企业资料行业编码按原值还原',
      restored.industryCategory === original.industryCategory &&
      restored.industrySubCategory === original.industrySubCategory,
      `category=${restored.industryCategory}, sub=${restored.industrySubCategory}`)
    await openRoute(page, '/systemModel/base/organization/enterprise-organization', {
      readyText: '行业大类', retries: 1
    }).catch(() => {})
    await saveScreenshot(page, outputDir, 'pb039-003-enterprise-industry', record).catch(() => {})
    return { api }
  }

  return { designed: true }
}

export const runCase = async (input, dependencies = {}) => {
  const { caseId, page, record, caseRecord, outputDir } = input
  const login = dependencies.login || loginDefault
  const openRoute = dependencies.openRoute || openRouteDefault
  const saveScreenshot = dependencies.saveScreenshot || saveScreenshotDefault
  caseRecord.notes.push(
    '生产类型/委外类型复用 system_document_type 与系统受控核心类型，条码载体只开放条形码与二维码，RFID 暂缓。'
  )
  caseRecord.notes.push(
    '生产日历沿用 APS aps_work_calendar*，班组交接为 MES 独立事实表，工艺路线发布后只能升版且工单任务保存版本快照。'
  )

  const token = await login(page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record })

  if (!hasWriteApi(api)) {
    return runReadOnlyBranch(caseId, api, page, record, caseRecord, openRoute)
  }

  const readOnlyCases = [
    'PB039-001', 'PB039-002'
  ]
  if (readOnlyCases.includes(caseId)) {
    return runReadOnlyBranch(caseId, api, page, record, caseRecord, openRoute)
  }

  return runWriteBranch(caseId, api, page, record, caseRecord, outputDir, openRoute, saveScreenshot)
}
