import { assertBusinessSuccess } from '../lib/assertions.mjs'
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
    `SELECT id, unit_id, default_prod_bom FROM mes_bas_material
     WHERE tenant_id=1 AND deleted=0 AND is_enabled=1
     AND default_prod_bom IS NOT NULL AND default_prod_bom<>'' LIMIT 5`)
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

export const bindDeviceCapacity = async (api, fixture, { deviceId, lineId, unitId }) => {
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
  const capacityId = unwrap(await api.postBusiness('/mes/wmsTechRoute/capacity/save', {
    routeSubId: fixture.routeSubId,
    procedureId: String(fixture.procedureId),
    equipmentId: String(deviceId),
    productId: null,
    unitId: String(unitId),
    standardOutput: 88,
    standardDuration: 60,
    changeoverMinutes: 15,
    calendarCode: 'INIT-CALENDAR',
    effectiveFrom: '2026-01-01',
    remark: fixture.marker
  }))
  return {
    capacityId: String(capacityId),
    detail: unwrap(await api.getBusiness(
      `/mes/wmsTechRoute/getRouteCapacityDetail?routeId=${fixture.routeId}`))
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
  await api.deleteBusiness(`/base/material-grade/delete?id=${encodeURIComponent(gradeId)}`).catch(() => {})
}

// ---------------------------------------------------------------------------
// MES-BASE-004 生产日历发布/排产快照
// ---------------------------------------------------------------------------

export const createWorkCalendarFixture = async (api, marker, { workModeId, startDate, endDate }) => {
  const calendarCode = `${marker}-CAL`
  await api.postBusiness('/mes/workCalendar/create', {
    calendarCode,
    calendarName: `${marker}-日历`,
    startDate,
    endDate,
    workday: '1,2,3,4,5,6,0',
    workModeId: Number(workModeId),
    priority: 900,
    isEnabled: true,
    remark: marker,
    resourceScopes: []
  })
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

// ---------------------------------------------------------------------------
// MES-BASE-005 班组交接
// ---------------------------------------------------------------------------

export const createTeamHandoverFixture = async (api, marker, { outTeamId, inTeamId }) => {
  const handoverNo = `${marker}-TH`
  const id = unwrap(await api.postBusiness('/mes/team-handover/create', {
    handoverNo,
    outTeamId: String(outTeamId),
    inTeamId: String(inTeamId),
    handoverTime: '2026-01-01 08:00:00',
    handoverContent: marker,
    remark: marker
  }))
  const detail = unwrap(await api.getBusiness(
    `/mes/team-handover/get?id=${encodeURIComponent(id)}`))
  return { handoverId: String(id), handoverNo, detail }
}

// ---------------------------------------------------------------------------
// PB038-003 品级库存拆分
// ---------------------------------------------------------------------------

export const readInventoryByGrade = async (materialId, gradeId, batchNo) => {
  const rows = await queryRows(
    `SELECT id, material_id, grade_id, batch_no, qty, available_qty,
            in_qty, out_qty, warehouse_id, ware_area_id, ware_location_id
     FROM mes_stk_inventory
     WHERE tenant_id=1 AND deleted=0 AND material_id='${escapeSql(materialId)}'
       AND grade_id='${escapeSql(gradeId)}' AND batch_no='${escapeSql(batchNo)}'`)
  return rows.map((row) => ({
    id: String(row[0]),
    materialId: String(row[1]),
    gradeId: row[2] == null ? null : String(row[2]),
    batchNo: row[3],
    qty: row[4] == null ? 0 : Number(row[4]),
    availableQty: row[5] == null ? 0 : Number(row[5]),
    inQty: row[6] == null ? 0 : Number(row[6]),
    outQty: row[7] == null ? 0 : Number(row[7]),
    warehouseId: row[8] == null ? null : String(row[8]),
    wareAreaId: row[9] == null ? null : String(row[9]),
    wareLocationId: row[10] == null ? null : String(row[10])
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
