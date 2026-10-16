import { asList, assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

// Dedicated write-side fixtures for the mes-base suite (MES-BASE/PB038/PB039/PB102).
// Every resource is created with a unique marker so parallel suites can never collide,
// and each fixture exposes the identifiers needed for a deterministic cleanup/restore.

export const hasWriteApi = (api) =>
  typeof api?.postBusiness === 'function' && typeof api?.deleteBusiness === 'function'

export const unwrap = (body) => assertBusinessSuccess(body, 'mes-base fixture').data

export const newMarker = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

export const queryRows = async (statement) => {
  const result = await runReadOnlySql(statement)
  if (!result.available) {
    throw new Error(`BLOCKED: ${result.reason}`)
  }
  return result.rows
}

export const singleId = (rows, label) => {
  if (!Array.isArray(rows) || rows.length !== 1 || !/^[1-9]\d*$/.test(String(rows[0]?.[0] ?? ''))) {
    throw new Error(`专属${label}创建后无法在数据库中唯一定位`)
  }
  return String(rows[0][0])
}

const escapeSql = (value) => String(value).replace(/'/g, "''")

// ---------------------------------------------------------------------------
// MES-BASE-003 条码规则
// ---------------------------------------------------------------------------

export const createBarcodeRuleFixture = async (api, caseRecord, marker) => {
  const ruleCode = `${marker}-RULE`
  const createBody = {
    ruleCode,
    ruleName: `${marker}-规则`,
    ruleType: '1',
    sort: 970,
    remark: marker,
    objectType: 'MATERIAL',
    carrier: 'BARCODE',
    barcodeRulesItemList: [{ type: '1', valve: 'MATERIAL_CODE', sort: 1, isUnique: 1 }]
  }
  const created = await api.postBusiness('/erp/barcode/rules/create', createBody)
  const ruleId = unwrap(created)
  if (!/^[1-9]\d*$/.test(String(ruleId))) throw new Error('条码规则创建未返回有效主键')
  caseRecord.evidence.push(`专属条码规则 id=${ruleId}, code=${ruleCode}`)
  return { ruleId: String(ruleId), ruleCode, createBody }
}

export const deleteBarcodeRuleFixture = async (api, ruleId) => {
  if (!ruleId) return
  await api.deleteBusiness(`/erp/barcode/rules/delete?id=${encodeURIComponent(ruleId)}`).catch(() => {})
}

// ---------------------------------------------------------------------------
// MES-BASE-001 生产类型规则 + 生产订单快照
// ---------------------------------------------------------------------------

export const createProductionTypeFixture = async (api, marker) => {
  // system_document_type.code/name are varchar(30); keep a compact stable code.
  const token = marker.replace(/[^A-Z0-9]/g, '').slice(-14)
  const documentTypeCode = `E2EMB-${token}`
  const documentTypeId = unwrap(await api.postBusiness('/system/document/type/create', {
    code: documentTypeCode,
    name: `E2EMB-${token}`,
    isOpen: true,
    sort: 970
  }))
  const ruleId = unwrap(await api.postBusiness('/mes/production-type-rule/create', {
    documentTypeId: String(documentTypeId),
    produceType: '1',
    status: 1,
    effectiveFrom: '2026-01-01',
    remark: marker
  }))
  const rule = unwrap(await api.getBusiness(`/mes/production-type-rule/get?id=${ruleId}`))
  return {
    documentTypeId: String(documentTypeId),
    documentTypeCode,
    ruleId: String(ruleId),
    rule
  }
}

// 选择一条已启用、已配置生产 BOM 的存货作为只读引用；订单本身仍是专属新单据。
export const pickBomMaterial = async (api) => {
  const rows = await queryRows(
    `SELECT material.id, material.unit_id, material.default_prod_bom
     FROM mes_bas_material material
     JOIN mes_wms_assemble bom ON bom.id=material.default_prod_bom
       AND bom.tenant_id=1 AND bom.deleted=0
       AND bom.stock_id=material.id AND bom.dev_status=2
       AND bom.bom_usage='PRODUCTION'
     WHERE material.tenant_id=1 AND material.deleted=0 AND material.is_enabled=1
       AND material.inventory_nature='STOCK'
       AND material.default_prod_bom IS NOT NULL AND material.default_prod_bom<>''
       AND EXISTS (
         SELECT 1 FROM mes_wms_assemble_sub sub
         WHERE sub.tenant_id=1 AND sub.deleted=0 AND sub.parent_id=bom.id
       )
     ORDER BY bom.update_time DESC, bom.id DESC LIMIT 5`)
  const hit = rows.find((row) => /^[1-9]\d*$/.test(String(row[0] ?? '')) &&
    /^[1-9]\d*$/.test(String(row[1] ?? '')) && /^[1-9]\d*$/.test(String(row[2] ?? '')))
  if (!hit) throw new Error('BLOCKED: 缺少已配置生产 BOM 的启用存货，无法创建专属生产订单')
  return { id: String(hit[0]), unitId: String(hit[1]), defaultProdBom: String(hit[2]) }
}

export const createProdOrderWithType = async (api, marker, { documentTypeId, material }) => {
  const billNo = `${marker}-PLAN`
  const orderId = unwrap(await api.postBusiness('/mes/prodOrder/add', {
    prodNo: billNo,
    billNo,
    prodType: '1',
    documentTypeId: String(documentTypeId),
    remark: marker,
    prodOrderSubList: [{
      materialId: String(material.id),
      qty: 3,
      wmsAssembleId: String(material.defaultProdBom),
      remark: marker,
      urgentLevel: '1'
    }]
  }))
  return { orderId: String(orderId), billNo }
}

// ---------------------------------------------------------------------------
// MES-BASE-002 委外业务类型规则 + 委外单快照
// ---------------------------------------------------------------------------

export const createOutsourceTypeRuleFixture = async (
  api, marker, { coreType = 'WORK', status = 1 } = {}
) => {
  const token = marker.replace(/[^A-Z0-9]/g, '').slice(-12)
  const documentTypeCode = `E2EOS-${token}`
  const documentTypeId = unwrap(await api.postBusiness('/system/document/type/create', {
    code: documentTypeCode,
    name: documentTypeCode,
    isOpen: true,
    sort: 972
  }))
  const payload = {
    documentTypeId: String(documentTypeId),
    coreType,
    effectiveFrom: '2026-01-01',
    status,
    remark: marker
  }
  const ruleId = unwrap(await api.postBusiness('/mes/outsource-type-rule/create', payload))
  const rule = unwrap(await api.getBusiness(
    `/mes/outsource-type-rule/get?id=${encodeURIComponent(ruleId)}`))
  return {
    documentTypeId: String(documentTypeId),
    documentTypeCode,
    ruleId: String(ruleId),
    payload,
    rule
  }
}

export const createOutsourceBillWithType = async (
  api, marker, rule, { material, unitId } = {}
) => {
  const reference = material || await pickBomMaterial(api)
  const billNo = `${marker}-OS`.slice(0, 60)
  const payload = {
    billDate: new Date().toISOString().slice(0, 10),
    billNo,
    subject: `${marker}-委外`,
    remark: marker,
    sourceType: 'WORK',
    outsourceTypeCode: rule.documentTypeCode,
    materialId: String(reference.id),
    unitId: String(unitId || reference.unitId),
    planQty: 1,
    status: 0,
    items: []
  }
  const billId = unwrap(await api.postBusiness('/mes/prodOutsource/add', payload))
  const detail = unwrap(await api.getBusiness(
    `/mes/prodOutsource/queryById?id=${encodeURIComponent(billId)}`))
  return { billId: String(billId), billNo, payload, detail }
}

// ---------------------------------------------------------------------------
// PB102-001/002/003 工艺路线 + 工序 + 设备 + 产能
// ---------------------------------------------------------------------------

export const createRouteCapacityFixture = async (api, marker, options = {}) => {
  const workshopId = String(options.workshopId)
  const lineId = String(options.lineId)
  const procedureId = options.procedureId
    ? String(options.procedureId)
    : await (async () => {
        await api.postBusiness('/mes/wmsProcedure/add', {
          code: `${marker}-PROC`,
          name: `${marker}-PROC`,
          mark: marker,
          workshopId,
          productionLineId: lineId,
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
          hasChild: 'N'
        })
        return singleId(await queryRows(
          `SELECT id FROM mes_wms_procedure WHERE tenant_id=1 AND deleted=0
           AND code='${escapeSql(marker)}-PROC' AND mark='${escapeSql(marker)}'`), '工序')
      })()

  await api.postBusiness('/mes/wmsTechRoute/addMain', {
    code: `${marker}-ROUTE`,
    name: `${marker}-ROUTE`,
    version: 'V1.0',
    mark: marker,
    type: '1',
    designMode: 'sequential',
    inboundType: 'FINISHED',
    isStrict: 'Y',
    wmsTechRouteSubList: [{
      procedureId,
      procedureName: `${marker}-PROC`,
      sortOrder: 1,
      isFeed: 0,
      isQuality: 0,
      isFinished: 1,
      isVirtual: 0,
      mark: marker
    }]
  })
  const routeId = singleId(await queryRows(
    `SELECT id FROM mes_wms_tech_route WHERE tenant_id=1 AND deleted=0
     AND code='${escapeSql(marker)}-ROUTE' AND mark='${escapeSql(marker)}'`), '工艺路线')
  const subPage = await api.getBusiness(
    `/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?parentId=${routeId}&pageNo=1&pageSize=50`)
  const routeSubId = subPage?.data?.records?.[0]?.id
  if (!String(routeSubId || '').match(/^[1-9]\d*$/)) {
    throw new Error('专属工艺路线工序节点创建后无法回读')
  }
  return { procedureId, routeId, routeSubId: String(routeSubId), marker }
}

export const capacityProductPayload = (marker, unitId, suffix) => {
  const code = `${marker}-${suffix}`
  return {
    code,
    name: code,
    auxName: code,
    unitId: String(unitId),
    inventoryNature: 'STOCK',
    isMaterial: 'N',
    isEnabled: 1,
    purchased: 'N',
    saled: 'Y',
    produced: 'Y',
    parented: 'Y',
    source: 'manufacture',
    leadTime: 1,
    bufferTime: 1,
    refCost: 10,
    refPrice: 20,
    batchManaged: 'N',
    oneBarcode: 'N',
    periodManaged: 'N',
    gradeManaged: 'N',
    colorManaged: 'N',
    brandManaged: 'N',
    backflush: 'N',
    remark: marker
  }
}

export const createCapacityProductFixture = async (api, marker, unitId, suffix) => {
  const code = `${marker}-${suffix}`
  const body = capacityProductPayload(marker, unitId, suffix)
  const id = String(unwrap(await api.postBusiness('/mes/basMaterial/add', body)))
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`专属产品${suffix}未返回合法ID`)
  const detail = (await api.getBusiness(
    `/mes/basMaterial/queryById?id=${encodeURIComponent(id)}`))?.data
  if (!detail || String(detail.id) !== id || String(detail.code) !== code ||
      !String(detail.remark || '').includes(marker)) {
    throw new Error(`专属产品${suffix}归属回读失败：${id}`)
  }
  return { id, code, body, detail }
}

export const bindDeviceCapacity = async (api, fixture, { deviceId, lineId }) => {
  await api.postBusiness('/mes/wmsTechRoute/saveprocedureEquipmentRelation', [{
    productionLineId: String(lineId),
    procedureId: String(fixture.procedureId),
    equipmentId: String(deviceId),
    sortOrder: 1,
    bindType: 'primary',
    status: '1',
    standardCapacityPerHour: 10,
    remark: fixture.marker
  }])
  return { deviceId: String(deviceId), lineId: String(lineId) }
}

export const capacitySavePayload = (fixture, {
  id, deviceId, unitId, productId, standardOutput = 88, standardDuration = 60,
  changeoverMinutes = 15, suffix = ''
}) => ({
  ...(id == null ? {} : { id: String(id) }),
  routeSubId: fixture.routeSubId,
  procedureId: String(fixture.procedureId),
  equipmentId: String(deviceId),
  productId: String(productId),
  unitId: String(unitId),
  standardOutput,
  standardDuration,
  changeoverMinutes,
  calendarCode: 'INIT-CALENDAR',
  effectiveFrom: '2026-01-01',
  remark: `${fixture.marker}${suffix ? `-${suffix}` : ''}`
})

export const saveDeviceCapacity = async (api, fixture, options) => {
  const capacityId = unwrap(await api.postBusiness('/mes/wmsTechRoute/capacity/save',
    capacitySavePayload(fixture, options)))
  return String(capacityId)
}

export const readRouteCapacityDetail = async (api, fixture) =>
  unwrap(await api.getBusiness(
    `/mes/wmsTechRoute/getRouteCapacityDetail?routeId=${fixture.routeId}`))

export const capacityProductScope = (row) =>
  row?.productId == null || String(row.productId).trim() === '' ? null : String(row.productId)

export const capacityRowsForProduct = (detail, productId) => {
  const expectedProductId = productId == null ? null : String(productId)
  return (detail?.procedureList || []).flatMap((procedure) => procedure.deviceList || [])
    .filter((row) => capacityProductScope(row) === expectedProductId)
}

export const capacityMinimum = (rows) => {
  const values = rows.map((row) => Number(row.mockCapacity)).filter(Number.isFinite)
  return values.length ? Math.min(...values) : null
}

export const cleanupRouteCapacityFixture = async (api, fixture) => {
  const errors = []
  const actions = []
  const retainedCapacityIds = []
  const retainedProductIds = new Set()
  const manifest = {
    status: 'RETAINED_AUDIT',
    cleaned: false,
    routeId: String(fixture.routeId),
    procedureId: String(fixture.procedureId),
    reason: '产能历史必须保留关联产品、工艺路线和工序主档，避免悬空审计'
  }

  let detail = null
  try {
    detail = await readRouteCapacityDetail(api, fixture)
  } catch (error) {
    errors.push(`专属产能详情回读: ${error.message}`)
  }
  const capacityRows = (detail?.procedureList || [])
    .flatMap((procedure) => procedure.deviceList || [])
    .filter((row) => row?.id != null)
  for (const row of capacityRows) {
    const capacityId = String(row.id)
    retainedCapacityIds.push(capacityId)
    if (row.productId != null && String(row.productId).trim() !== '') {
      retainedProductIds.add(String(row.productId))
    }
    if (Number(row.publishStatus) !== 1) continue
    try {
      await api.postBusiness(
        `/mes/wmsTechRoute/capacity/disable?capacityId=${encodeURIComponent(capacityId)}`)
      actions.push({ action: 'disableCapacity', capacityId, status: 'APPLIED' })
    } catch (error) {
      errors.push(`专属产能${capacityId}停用: ${error.message}`)
    }
  }

  let route = null
  try {
    route = (await api.getBusiness(
      `/mes/wmsTechRoute/queryById?id=${encodeURIComponent(fixture.routeId)}`))?.data
    if (Number(route?.devStatus) === 2) {
      await api.postBusiness(`/mes/wmsTechRoute/unpublish?id=${encodeURIComponent(fixture.routeId)}`)
      actions.push({ action: 'unpublishRoute', routeId: String(fixture.routeId), status: 'APPLIED' })
    } else {
      actions.push({
        action: 'unpublishRoute', routeId: String(fixture.routeId),
        status: Number(route?.devStatus) === 3 ? 'ALREADY_DISABLED' : 'NOT_PUBLISHED'
      })
    }
  } catch (error) {
    errors.push(`专属工艺路线停用: ${error.message}`)
  }

  let finalDetail = null
  try {
    finalDetail = await readRouteCapacityDetail(api, fixture)
  } catch (error) {
    errors.push(`专属产能停用后回读: ${error.message}`)
  }
  const finalCapacityRows = (finalDetail?.procedureList || [])
    .flatMap((procedure) => procedure.deviceList || [])
    .filter((row) => retainedCapacityIds.includes(String(row.id)))
  const missingCapacityIds = retainedCapacityIds.filter((id) =>
    !finalCapacityRows.some((row) => String(row.id) === id))
  if (missingCapacityIds.length > 0) {
    errors.push(`专属产能历史回读缺失: ${missingCapacityIds.join(',')}`)
  }
  const stillPublishedIds = finalCapacityRows
    .filter((row) => Number(row.publishStatus) === 1)
    .map((row) => String(row.id))
  if (stillPublishedIds.length > 0) {
    errors.push(`专属产能停用后仍为已发布: ${stillPublishedIds.join(',')}`)
  }
  const disabledPublishedIds = finalCapacityRows
    .filter((row) => Number(row.publishStatus) === 2)
    .map((row) => String(row.id))

  let routeAfter = null
  try {
    routeAfter = (await api.getBusiness(
      `/mes/wmsTechRoute/queryById?id=${encodeURIComponent(fixture.routeId)}`))?.data
    if (Number(routeAfter?.devStatus) === 2) {
      errors.push(`专属工艺路线停用后仍为已发布: ${fixture.routeId}`)
    }
  } catch (error) {
    errors.push(`专属工艺路线停用后回读: ${error.message}`)
  }
  if (!routeAfter || String(routeAfter.id) !== String(fixture.routeId)) {
    errors.push(`专属工艺路线停用后无法回读主档: ${fixture.routeId}`)
  }

  return {
    manifest: 'RETAINED_AUDIT',
    status: 'RETAINED_AUDIT',
    cleaned: false,
    errors,
    actions,
    retained: {
      productIds: [...retainedProductIds],
      routeId: String(fixture.routeId),
      procedureId: String(fixture.procedureId),
      capacityIds: retainedCapacityIds
    },
    verification: {
      routeStatusBefore: route?.devStatus ?? null,
      routeStatusAfter: routeAfter?.devStatus ?? null,
      disabledPublishedCapacityIds: disabledPublishedIds,
      allKnownCapacityRowsDisabled: finalCapacityRows
        .filter((row) => Number(row.publishStatus) !== 0)
        .every((row) => Number(row.publishStatus) === 2)
    }
  }
}

export const listCapacities = async (api, fixture, deviceId) => {
  const body = await api.getBusiness(
    `/mes/wmsTechRoute/capacity/list?routeSubId=${encodeURIComponent(fixture.routeSubId)}` +
    `&equipmentId=${encodeURIComponent(deviceId)}`)
  return Array.isArray(body?.data) ? body.data : []
}

// ---------------------------------------------------------------------------
// PB038-001/002 存货品级
// ---------------------------------------------------------------------------

export const createGrade = async (api, marker, suffix = 'G') => {
  const code = `${marker}-${suffix}`
  const id = unwrap(await api.postBusiness('/base/material-grade/create', {
    code,
    name: `${marker}${suffix}级`,
    description: `${marker} dedicated e2e fixture`,
    sort: 950,
    status: 1
  }))
  return { id: String(id), code }
}

export const createGradeMaterial = async (api, marker, { unitId, defaultGradeId, allowedGradeIds }) => {
  const body = {
    code: `${marker}-MAT`,
    name: `${marker}-品级夹具存货`,
    unitId: String(unitId),
    remark: marker,
    isEnabled: 1,
    inventoryNature: 'STOCK',
    virtualGoods: 'N',
    purchased: 'Y',
    saled: 'N',
    produced: 'N',
    parented: 'N',
    soned: 'N',
    assembled: 'N',
    batchManaged: 'N',
    oneBarcode: 'N',
    periodManaged: 'N',
    backflush: 'N',
    gradeManaged: 'N',
    colorManaged: 'N',
    brandManaged: 'N',
    leadTime: 1,
    bufferTime: 1,
    refCost: 1,
    refPrice: 1,
    defaultGradeId: null,
    allowedGradeIds: []
  }
  const id = unwrap(await api.postBusiness('/mes/basMaterial/add', body))
  return { id: String(id), code: body.code, body }
}

export const readMaterial = async (api, materialId) => {
  const body = await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(materialId)}`)
  const data = body?.data
  if (!data || Array.isArray(data) || String(data.id) !== String(materialId)) {
    throw new Error('存货详情响应无效')
  }
  return data
}

// 存货详情接口 /mes/basMaterial/queryById 对已配置允许品级（allowedGradeIds 非空）的
// 存货会命中 DictAspect 的 ClassCastException（List<String> 递归解析）。写侧断言因此
// 直接读取 mes_bas_material 与 base_material_grade_scope，绕开该缺陷，只读不写。
export const materialEditBody = (material, gradeFields = {}) => ({
  ...material.body,
  id: String(material.id),
  gradeManaged: 'N',
  defaultGradeId: null,
  allowedGradeIds: [],
  ...gradeFields
})

export const readGradeConfigFromDb = async (materialId) => {
  const rows = await queryRows(
    `SELECT grade_managed, default_grade_id FROM mes_bas_material
     WHERE tenant_id=1 AND id='${escapeSql(materialId)}'`)
  if (rows.length !== 1) {
    throw new Error('专属存货品级配置无法在数据库中唯一定位')
  }
  const scope = await queryRows(
    `SELECT grade_id FROM base_material_grade_scope
     WHERE material_id='${escapeSql(materialId)}' AND deleted=0`)
  return {
    gradeManaged: rows[0][0] ? String(rows[0][0]) : 'N',
    defaultGradeId: rows[0][1] ? String(rows[0][1]) : null,
    allowedGradeIds: scope.map((row) => String(row[0]))
  }
}

export const restoreMaterialGrade = async (api, original) => {
  await api.putBusiness('/mes/basMaterial/edit', {
    ...original,
    gradeManaged: original.gradeManaged,
    defaultGradeId: original.defaultGradeId,
    allowedGradeIds: original.allowedGradeIds
  })
}

export const deleteGrade = async (api, gradeId) => {
  if (!gradeId) return
  await api.request(
    'DELETE',
    `/base/material-grade/delete?id=${encodeURIComponent(gradeId)}`,
    undefined,
    {
      expectedBusinessRejection: {
        code: 500,
        message: /品级已被引用，只能停用，不能删除/,
        allowServiceCode: true
      }
    }
  ).catch(() => {})
}

// ---------------------------------------------------------------------------
// MES-BASE-004 生产日历发布/排产快照
// ---------------------------------------------------------------------------

export const workCalendarPayload = (marker, { workModeId, startDate, endDate }) => ({
  calendarCode: `${marker}-CAL`,
  calendarName: `${marker}-日历`,
  startDate,
  endDate,
  workday: '1,2,3,4,5,6,0',
  // Snowflake IDs must remain strings until the JSON boundary.
  workModeId: String(workModeId),
  priority: 900,
  isEnabled: true,
  remark: marker,
  resourceScopes: []
})

export const createWorkCalendarFixture = async (api, marker, options) => {
  const payload = workCalendarPayload(marker, options)
  const calendarCode = `${marker}-CAL`
  await api.postBusiness('/mes/workCalendar/create', payload)
  const rows = await queryRows(
    `SELECT id, version, publish_status FROM aps_work_calendar
     WHERE calendar_code='${escapeSql(calendarCode)}' AND deleted=0 ORDER BY id`)
  if (!rows.length) throw new Error('专属生产日历创建后无法在数据库中定位')
  return {
    calendarCode,
    firstId: String(rows[0][0]),
    version: Number(rows[0][1]),
    calendarIds: rows.map((row) => String(row[0]))
  }
}

export const readWorkCalendarDb = async (calendarCode) => {
  const rows = await queryRows(
    `SELECT id, calendar_code, calendar_date, version, publish_status, updater, update_time
     FROM aps_work_calendar WHERE calendar_code='${escapeSql(calendarCode)}' AND deleted=0
     ORDER BY id`)
  return rows.map((row) => ({
    id: String(row[0]),
    calendarCode: row[1],
    calendarDate: row[2],
    version: Number(row[3]),
    publishStatus: Number(row[4]),
    updater: row[5],
    updateTime: row[6]
  }))
}

export const createSchedulingVersionFixture = async (api, marker, schedulingStartDate) => {
  const versionId = unwrap(await api.postBusiness('/mes/aps/scheduling/create', {
    schedulingVersionName: `${marker}-排产`,
    schedulingStartDate,
    schedulingDayCount: 1,
    capacityLimitType: 'equipment'
  }))
  return { versionId: String(versionId) }
}

export const readSchedulingVersionDb = async (versionId) => {
  const rows = await queryRows(
    `SELECT id, calendar_code, calendar_version, capacity_snapshot, status, scheme_status
     FROM aps_scheduling_version WHERE id='${escapeSql(versionId)}' AND deleted=0`)
  if (rows.length !== 1) throw new Error('专属排产版本无法在数据库中唯一定位')
  return {
    id: String(rows[0][0]),
    calendarCode: rows[0][1],
    calendarVersion: rows[0][2] == null ? null : Number(rows[0][2]),
    capacitySnapshot: rows[0][3],
    status: rows[0][4] == null ? null : Number(rows[0][4]),
    schemeStatus: rows[0][5]
  }
}

export const createSchedulingSnapshotFixture = async (
  api, caseRecord, marker, {
    workOrderId, workOrderNo, routeId, routeName, procedureId, productId,
    unitId, deviceId, lineId, calendarCode, calendarVersion, startDate
  }
) => {
  const versionId = unwrap(await api.postBusiness('/mes/aps/scheduling/create', {
    schedulingVersionName: `${marker}-正式排产`,
    schedulingStartDate: startDate,
    calendarCode: String(calendarCode),
    calendarVersion: Number(calendarVersion),
    schedulingDayCount: 1,
    capacityLimitType: 'equipment',
    workOrderIds: String(workOrderId)
  }))
  const subPage = await api.getBusiness(
    `/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?parentId=${encodeURIComponent(routeId)}` +
    '&pageNo=1&pageSize=50'
  )
  const routeSub = asList(subPage?.data).find((row) => String(row?.procedureId) === String(procedureId))
  if (!routeSub?.id) {
    return {
      versionId: String(versionId),
      snapshotReady: false,
      reason: `专属工艺路线 ${routeId} 未回读到工序 ${procedureId} 的节点`
    }
  }
  await api.postBusiness('/mes/wmsTechRoute/saveprocedureEquipmentRelation', [{
    productionLineId: String(lineId),
    procedureId: String(procedureId),
    equipmentId: String(deviceId),
    sortOrder: 1,
    bindType: 'primary',
    status: '1',
    standardCapacityPerHour: 10,
    remark: marker
  }])
  const capacityId = String(unwrap(await api.postBusiness('/mes/wmsTechRoute/capacity/save', {
    routeSubId: String(routeSub.id),
    procedureId: String(procedureId),
    equipmentId: String(deviceId),
    productId: String(productId),
    unitId: String(unitId),
    standardOutput: 88,
    standardDuration: 60,
    changeoverMinutes: 0,
    calendarCode: String(calendarCode),
    effectiveFrom: startDate,
    remark: marker
  })))
  await api.postBusiness(
    `/mes/wmsTechRoute/capacity/publish?capacityId=${encodeURIComponent(capacityId)}`)
  const calculateResponse = await api.postBusiness('/mes/aps/scheduling/calculate', {
    versionId,
    forceSchedule: true,
    compareAlgorithms: false,
    algorithmType: 'GREEDY_LOCAL',
    workOrders: [{
      workOrderId: String(workOrderId),
      sortOrder: 1,
      processId: String(routeId),
      processName: String(routeName)
    }]
  })
  const result = calculateResponse?.data ?? calculateResponse
  const resultRows = Array.isArray(result?.results)
    ? result.results
    : Object.values(result?.workOrderResults || {}).flat()
  if (result?.success !== true || resultRows.length === 0) {
    return {
      versionId: String(versionId),
      capacityId,
      snapshotReady: false,
      reason: `正式排产计算未产生结果：${JSON.stringify(result).slice(0, 500)}`
    }
  }
  await api.postBusiness('/mes/aps/scheduling/publish', {
    versionId,
    overrideExisting: true,
    viewType: 'equipment',
    overrideCanReportNum: true
  })
  const snapshot = await readSchedulingVersionDb(String(versionId))
  const capacityRows = await queryRows(
    `SELECT id, publish_status FROM aps_tech_route_procedure_device_capacity
     WHERE tenant_id=1 AND deleted=0 AND id='${escapeSql(capacityId)}'`)
  caseRecord.evidence.push(
    `正式排产快照 version=${versionId}, calendar=${snapshot.calendarCode}@${snapshot.calendarVersion}, ` +
    `capacity=${capacityId}, capacityPublish=${capacityRows[0]?.[1]}`
  )
  return {
    versionId: String(versionId),
    capacityId,
    snapshotReady: true,
    routeSubId: String(routeSub.id),
    snapshot,
    expectedCalendarCode: String(calendarCode),
    expectedCalendarVersion: Number(calendarVersion)
  }
}

// ---------------------------------------------------------------------------
// MES-BASE-005 班组交接
// ---------------------------------------------------------------------------

export const teamHandoverPayload = (marker, { outTeamId, inTeamId }) => ({
  handoverNo: `${marker}-TH`,
  outTeamId: String(outTeamId),
  inTeamId: String(inTeamId),
  handoverTime: '2026-01-01T08:00:00',
  handoverContent: marker,
  remark: marker
})

export const createTeamHandoverFixture = async (api, marker, options) => {
  const payload = teamHandoverPayload(marker, options)
  const { handoverNo } = payload
  const id = unwrap(await api.postBusiness('/mes/team-handover/create', payload))
  const detail = unwrap(await api.getBusiness(
    `/mes/team-handover/get?id=${encodeURIComponent(id)}`))
  return { handoverId: String(id), handoverNo, detail }
}

// ---------------------------------------------------------------------------
// PB038-003 品级库存拆分
// ---------------------------------------------------------------------------

export const readInventoryByGrade = async (materialId, gradeId, batchNo, dimensions = {}) => {
  const filters = [
    `material_id='${escapeSql(materialId)}'`,
    `grade_id='${escapeSql(gradeId)}'`,
    `batch_no='${escapeSql(batchNo)}'`
  ]
  for (const [column, value] of [
    ['warehouse_id', dimensions.warehouseId],
    ['ware_area_id', dimensions.wareAreaId],
    ['ware_location_id', dimensions.wareLocationId]
  ]) {
    if (value != null && String(value) !== '') filters.push(`${column}='${escapeSql(value)}'`)
  }
  if (!dimensions.includeDeleted) filters.push('deleted=0')
  const rows = await queryRows(
    `SELECT id, material_id, grade_id, batch_no, qty, available_qty, cost,
            in_qty, out_qty, warehouse_id, ware_area_id, ware_location_id,
            CASE WHEN deleted = 1 THEN 1 WHEN deleted = 0 THEN 0 ELSE NULL END AS deleted,
            is_closed
     FROM mes_stk_inventory
     WHERE tenant_id=1 AND ${filters.join(' AND ')}`)
  return rows.map((row) => ({
    id: String(row[0]),
    materialId: String(row[1]),
    gradeId: row[2] == null ? null : String(row[2]),
    batchNo: row[3],
    qty: row[4] == null ? 0 : Number(row[4]),
    availableQty: row[5] == null ? 0 : Number(row[5]),
    cost: row[6] == null ? null : Number(row[6]),
    inQty: row[7] == null ? 0 : Number(row[7]),
    outQty: row[8] == null ? 0 : Number(row[8]),
    warehouseId: row[9] == null ? null : String(row[9]),
    wareAreaId: row[10] == null ? null : String(row[10]),
    wareLocationId: row[11] == null ? null : String(row[11]),
    deleted: row[12] == null ? null : Number(row[12]),
    isClosed: row[13] == null ? 0 : Number(row[13])
  }))
}

// ---------------------------------------------------------------------------
// PB039-003 企业资料行业编码回填
// ---------------------------------------------------------------------------

export const readEnterpriseOrganization = async (api) => {
  const body = await api.getBusiness('/system/enterprise-organization/current')
  if (!body?.data || Array.isArray(body.data)) throw new Error('企业组织资料响应无效')
  return body.data
}

export const restoreEnterpriseOrganization = async (api, original) => {
  await api.putBusiness('/system/enterprise-organization/current', {
    enterpriseFullName: original.enterpriseFullName,
    enterpriseShortName: original.enterpriseShortName,
    enterpriseType: original.enterpriseType,
    unifiedSocialCreditCode: original.unifiedSocialCreditCode,
    industryCategory: original.industryCategory,
    industrySubCategory: original.industrySubCategory,
    taxpayerQualification: original.taxpayerQualification,
    province: original.province,
    provinceCode: original.provinceCode,
    city: original.city,
    cityCode: original.cityCode,
    district: original.district,
    districtCode: original.districtCode,
    registeredAddress: original.registeredAddress,
    enterpriseLogoUrl: original.enterpriseLogoUrl
  })
}

// 从统一行业树中挑选一个与当前企业资料不同的可选细分行业，返回父/叶的编码与中文名称。
export const pickAlternativeIndustry = (tree, current) => {
  const roots = Array.isArray(tree) ? tree : []
  for (const root of roots) {
    if (root?.level !== 'INDUSTRY') continue
    for (const leaf of root.children || []) {
      if (leaf?.selectable === false) continue
      if (String(leaf.code) === String(current?.industrySubCategory)) continue
      return {
        parentCode: root.code,
        parentName: root.name,
        leafCode: leaf.code,
        leafName: leaf.name
      }
    }
  }
  throw new Error('BLOCKED: 统一行业目录没有可回填的备选细分行业')
}
