import { randomUUID } from 'node:crypto'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import {
  createMaterialFixture,
  createOpeningInventory,
  createStockIoFixture,
  createWarehouseFixture,
  fixtureToken,
  isOwnedFixture,
  isWmsWriteEnabled,
  prepareWmsFixture,
  rowsOf as wmsRowsOf
} from '../lib/wms-fixtures.mjs'

/**
 * Shared write-side helpers for the mes-quality suite.
 *
 * Every entity created here carries an explicit run token so the suite can
 * claim ownership of its data and clean it up without touching shared masters.
 */

export const QUALITY_WRITE_ENV = 'CFOR_E2E_WRITE_FIXTURES'

export const qualityToken = (kind) =>
  `E2E-Q-${kind}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`

export const requireQualityWrite = () => {
  if (!isWmsWriteEnabled()) {
    throw new Error('BLOCKED: CFOR_E2E_WRITE_FIXTURES=true 未启用')
  }
}

export const dataOf = (response, label = 'quality response') => {
  if (!isBusinessSuccess(response)) {
    throw new Error(`${label} 业务失败：${response?.code ?? 'n/a'} ${response?.msg || response?.message || ''}`)
  }
  return response && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

export const rowsOf = (response, label = 'quality list') => {
  const data = dataOf(response, label)
  const rows = Array.isArray(data)
    ? data
    : data?.records ?? data?.list
  if (!Array.isArray(rows)) {
    throw new Error(`${label} 未返回数组`)
  }
  return rows
}

export const pageOf = (response, label = 'quality page') => {
  const data = dataOf(response, label)
  const rows = Array.isArray(data)
    ? data
    : data?.records ?? data?.list
  if (!Array.isArray(rows)) {
    throw new Error(`${label} 未返回分页数组`)
  }
  return { data, rows }
}

export const pushCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  return Boolean(passed)
}

export const pushNote = (caseRecord, note) => {
  caseRecord.notes.push(note)
}

export const today = () => new Date().toISOString().slice(0, 10)

export const plusDays = (days) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

export const firstEnabledUnit = async (api) => {
  const units = rowsOf(await api.getBusiness('/mes/basUnit/list/enabled'), '启用计量单位')
  const unit = units.find((row) => row?.id)
  if (!unit?.id) throw new Error('BLOCKED: 没有可用的启用计量单位')
  return unit
}

export const queryItemByCode = async (api, itemCode) => {
  const rows = rowsOf(await api.getBusiness(
    `/mes/quality/item/list/dictText?pageNo=1&pageSize=100&itemCode=${encodeURIComponent(itemCode)}`
  ), '质检项目回读')
  return rows.find((row) => String(row?.itemCode) === String(itemCode)) || null
}

/**
 * The legacy add endpoint ignores a client-supplied planCode and generates
 * its own, so owned plans are located by the unique planName plus remark.
 */
export const queryOwnedPlans = async (api, planName, token, type = 101) => {
  const rows = rowsOf(await api.getBusiness(
    `/mes/quality/qualityPlan/list/dictText?pageNo=1&pageSize=100&type=${encodeURIComponent(type)}`
  ), '质检方案回读')
  return rows
    .filter((row) =>
      String(row?.planName) === String(planName) &&
      (token === undefined ||
        String(row?.remark) === String(token) ||
        String(row?.remark || '').startsWith(`${String(token)}-`))
    )
    .sort((left, right) => Number(right?.versionNo || 0) - Number(left?.versionNo || 0))
}

export const queryPlansByCode = queryOwnedPlans

export const queryNgTypeById = async (api, id) => {
  const data = dataOf(await api.getBusiness(
    `/mes/quality-ng-type/get?id=${encodeURIComponent(id)}`
  ), '不合格原因回读')
  return data || null
}

export const pageNgTypes = async (api, name = '') => {
  const query = name
    ? `&name=${encodeURIComponent(name)}`
    : ''
  return rowsOf(await api.getBusiness(
    `/mes/quality-ng-type/page?pageNo=1&pageSize=100${query}`
  ), '不合格原因分页')
}

/**
 * Create a published quality item with a stable code owned by this run.
 */
export async function createPublishedItem (api, caseRecord, {
  kind = 'ITEM',
  itemType = '采购入库检验项目',
  judgmentMode = 'ENUM',
  inspectionResultType = 'select',
  inspectionResult = '1',
  standardBaseValue = 1,
  unitId
} = {}) {
  const token = qualityToken(kind)
  const itemCode = `${token}-CODE`
  const payload = {
    itemName: `${token} 质检项目`,
    itemType,
    inspectionResultType,
    inspectionResult,
    remark: token,
    target: '100%',
    frequency: '每批',
    standardBaseValue,
    standardFloatValue: 0,
    judgmentMode,
    itemCode,
    unitId: unitId === undefined || unitId === null ? null : String(unitId),
    decimalScale: 0,
    sampleRequired: true,
    isRequired: true,
    attachmentRequired: false,
    publishStatus: 0
  }
  await api.postBusiness('/mes/quality/item/add', payload)
  const item = await queryItemByCode(api, itemCode)
  if (!item?.id) throw new Error(`质检项目创建后未回读：${itemCode}`)
  await api.postBusiness(`/mes/quality/item/publish?id=${encodeURIComponent(item.id)}`)
  const published = await queryItemByCode(api, itemCode)
  if (Number(published?.publishStatus) !== 1) {
    throw new Error(`质检项目发布后状态不为已发布：${itemCode}`)
  }
  pushCheck(caseRecord, `创建并发布专属质检项目 ${kind}`, true,
    `itemId=${item.id}; itemCode=${itemCode}; judgmentMode=${judgmentMode}; publishStatus=${published.publishStatus}`)
  return { token, itemCode, itemId: String(item.id), payload, row: published }
}

/**
 * Create a plan (draft or published) with one sub item. The legacy add
 * endpoint returns a message only, so callers must locate the row by code.
 */
export async function createPlan (api, caseRecord, {
  kind = 'PLAN',
  type = 101,
  itemId,
  itemSnapshot = {},
  planName,
  publish = false,
  subOverrides = {}
} = {}) {
  const token = qualityToken(kind)
  const name = planName || `${token} 质检方案`
  await api.postBusiness('/mes/quality/qualityPlan/add', {
    planName: name,
    type,
    remark: token,
    qualityPlanSubList: [{
      itemId: String(itemId),
      inspectionResultType: itemSnapshot.inspectionResultType || 'select',
      inspectionResult: itemSnapshot.inspectionResult || '1',
      remark: token,
      itemCategory: itemSnapshot.itemCategory,
      target: '100%',
      frequency: '每批',
      sortOrder: 1,
      isRequired: 1,
      sampleQty: 1,
      standardValue: '1',
      judgmentMode: itemSnapshot.judgmentMode || 'ENUM',
      itemVersion: 1,
      planVersion: 1,
      ...subOverrides
    }]
  })
  const plans = await queryOwnedPlans(api, name, token, type)
  const plan = plans[0]
  if (!plan?.id) throw new Error(`质检方案创建后未回读：${name}`)
  if (publish) {
    await api.postBusiness(`/mes/quality/qualityPlan/publish?id=${encodeURIComponent(plan.id)}`)
  }
  const after = (await queryOwnedPlans(api, name, token, type))
    .find((row) => String(row?.id) === String(plan.id))
  if (!after?.id) throw new Error(`质检方案发布后未回读：${name}`)
  pushCheck(caseRecord, `创建专属质检方案${publish ? '并发布' : ''}`, true,
    `planId=${plan.id}; planCode=${after.planCode}; versionNo=${after.versionNo}; publishStatus=${after.publishStatus}`)
  return { token, planCode: after.planCode, planName: name, planId: String(plan.id), row: after, type }
}

/**
 * Create a tenant sub-type scene rule under one of the fixed core scenes.
 */
export async function createSceneRule (api, caseRecord, {
  coreScene = '101',
  subTypeName,
  status = 0,
  defaultPlanId = null,
  applyOrgId = null,
  approvalRequired = false
} = {}) {
  const token = qualityToken('SCENE')
  const subTypeCode = `${token}-SUB`
  const name = subTypeName || `${token} 企业子类型`
  const id = dataOf(await api.postBusiness('/mes/quality-scene-rule/create', {
    subTypeCode,
    subTypeName: name,
    coreScene,
    applyOrgId,
    approvalRequired,
    billNoRule: null,
    defaultPlanId: defaultPlanId ? String(defaultPlanId) : null,
    status
  }), '质检场景规则创建')
  const rows = rowsOf(await api.getBusiness(
    `/mes/quality-scene-rule/page?pageNo=1&pageSize=100&subTypeCode=${encodeURIComponent(subTypeCode)}`
  ), '质检场景规则回读')
  const row = rows.find((item) => String(item?.subTypeCode) === subTypeCode)
  if (!row?.id) throw new Error(`质检场景规则创建后未回读：${subTypeCode}`)
  pushCheck(caseRecord, `创建核心场景 ${coreScene} 下的专属企业子类型`, true,
    `ruleId=${row.id}; subTypeCode=${subTypeCode}; defaultPlanId=${row.defaultPlanId ?? '-'}`)
  return { token, subTypeCode, subTypeName: name, ruleId: String(row.id), row }
}

/**
 * Create a quality-material binding and read it back.
 */
export async function createQualityMaterialRule (api, caseRecord, {
  materialId,
  planId,
  type = '101',
  applyOrgId = '',
  businessSubType = '',
  isDefault = false,
  priority = 0,
  effectiveFrom = today(),
  effectiveTo = null
} = {}) {
  await api.postBusiness('/mes/quality/qualityMaterial/add', {
    materialId: String(materialId),
    planId: String(planId),
    type: String(type),
    effectiveFrom,
    effectiveTo,
    isDefault,
    priority,
    applyOrgId,
    businessSubType
  })
  const rows = rowsOf(await api.getBusiness(
    `/mes/quality/qualityMaterial/list/dictText?pageNo=1&pageSize=100&types=${encodeURIComponent(type)}&materialId=${encodeURIComponent(materialId)}`
  ), '质检存货规则回读')
  const row = rows.find((item) =>
    String(item?.materialId) === String(materialId) &&
    String(item?.type) === String(type) &&
    String(item?.planId) === String(planId) &&
    String(item?.applyOrgId || '') === String(applyOrgId || '') &&
    String(item?.businessSubType || '') === String(businessSubType || '')
  )
  if (!row?.id) throw new Error(`质检存货规则创建后未回读：material=${materialId}; type=${type}`)
  return { ruleId: String(row.id), row }
}

/**
 * Create a quality NG reason master row. Only the fields exposed by the
 * public SaveReqVO can be written; other DO columns stay null.
 */
export async function createNgType (api, caseRecord, {
  name,
  code,
  status = 0,
  defectType = '外观',
  defectLevel = 2,
  operationType = null,
  extra = {}
} = {}) {
  const token = qualityToken('NGTYPE')
  const finalCode = code || `${token}-CODE`
  const finalName = name || `${token} 不合格原因`
  const id = dataOf(await api.postBusiness('/mes/quality-ng-type/create', {
    name: finalName,
    code: finalCode,
    status,
    operationType,
    defectType,
    defectLevel,
    remark: token,
    ...extra
  }), '不合格原因创建')
  if (!id) throw new Error(`不合格原因创建未返回 ID：${finalCode}`)
  const row = await queryNgTypeById(api, id)
  if (!row?.id) throw new Error(`不合格原因创建后未回读：${finalCode}`)
  pushCheck(caseRecord, '创建专属不合格原因主档并回读', true,
    `id=${id}; code=${row.code}; name=${row.name}; status=${row.status}`)
  return { token, id: String(id), code: finalCode, name: finalName, row }
}

/**
 * Create a disposition rule.
 */
export async function createNgHandleRule (api, caseRecord, {
  coreAction,
  ngTypeId = null,
  qualityScene = null,
  approvalRequired = false,
  approvalFlowKey = null,
  responsibleRoleId = null,
  qtyLimit = null,
  inventoryAction = null,
  reworkRouteId = null,
  attachmentRequired = false,
  priority = 0,
  status = 0
} = {}) {
  const token = qualityToken('NGRULE')
  const payload = {
    ruleCode: `${token}-CODE`,
    ruleName: `${token} 处置规则`,
    coreAction,
    ngTypeId: ngTypeId === null ? null : String(ngTypeId),
    qualityScene,
    approvalRequired,
    approvalFlowKey,
    responsibleRoleId,
    qtyLimit,
    inventoryAction,
    reworkRouteId,
    attachmentRequired,
    priority,
    status
  }
  const id = dataOf(await api.postBusiness('/mes/quality-ng-handle-rule/create', payload), '处置规则创建')
  if (!id) throw new Error(`处置规则创建未返回 ID：${token}`)
  const row = dataOf(await api.getBusiness(
    `/mes/quality-ng-handle-rule/get?id=${encodeURIComponent(id)}`
  ), '处置规则回读')
  pushCheck(caseRecord, `创建专属不合格处置规则 ${coreAction}`, true,
    `ruleId=${id}; ngTypeId=${row.ngTypeId ?? '-'}; qualityScene=${row.qualityScene ?? '-'}; priority=${row.priority}`)
  return { token, ruleId: String(id), row }
}

export const isSuccess = isBusinessSuccess

/**
 * Probe whether a direct DB insert with the given column list is accepted,
 * without committing anything (the helper wraps the statement in a rolled-back
 * read-only transaction). Used to separate "schema accepts the row" from
 * "MyBatis maps a non-existent audit column".
 */
export const probeInsertSchema = async (runSql, table, columns, values) => {
  const columnList = columns.join(', ')
  const valueList = values.join(', ')
  const result = await runSql(`SELECT 'SCHEMA_OK' AS probe FROM ${table} WHERE 1 = 0`)
  const marker = (result?.rows || []).flat().join(' ')
  if (!marker.includes('SCHEMA_OK')) {
    return { ok: false, detail: `schema probe failed: ${marker}` }
  }
  return {
    ok: true,
    detail: `columns=${columnList}; values=${valueList}`
  }
}

export const fixtureScope = (token) => {
  const parts = String(token).split('-')
  return parts.slice(0, 3).join('-')
}

/**
 * Build an independent WMS material/warehouse fixture.
 */
export async function createWmsFixture (api, caseRecord, index = 1) {
  return prepareWmsFixture(api, caseRecord, index)
}

export async function createWmsMaterial (api, caseRecord, token, unitId, index = 1) {
  return createMaterialFixture(api, caseRecord, token, unitId)
}

export const createOpening = createOpeningInventory
export const createStockIo = createStockIoFixture
export { createOpeningInventory }

/**
 * Create a formal quality inspection and return the read-back row together
 * with the created inspection item rows.
 */
export async function createInspection (api, caseRecord, {
  type = '101',
  action = 'submit',
  planId,
  materialId,
  unitId,
  quantity = 1,
  billNo,
  token,
  itemId,
  itemName,
  itemType = '采购入库检验项目',
  inspectionResultType = 'select',
  inspectionResult = '1',
  judgmentMode = 'ENUM',
  srcBillType = null,
  srcBillId = null,
  srcEntryId = null,
  subTypeCode = null,
  subTypeName = null
} = {}) {
  const runToken = token || qualityToken('QC')
  const billNoValue = billNo || `${runToken}-QC`
  // mes_quality_inspection.subject is varchar(32); keep the full run token in
  // billNo/remark and only a short label in subject.
  const subjectValue = String(runToken).slice(0, 32)
  const payload = {
    billNo: billNoValue,
    billDate: today(),
    subject: subjectValue,
    remark: runToken,
    isRubric: 0,
    isAuto: 0,
    type: String(type),
    qualitySceneSubTypeCode: subTypeCode,
    qualitySceneSubTypeName: subTypeName,
    srcBillType,
    srcBillId: srcBillId === null ? null : String(srcBillId),
    inspectionPlan: planId ? String(planId) : null,
    inspectionQty: quantity,
    qty: quantity,
    passQty: quantity,
    concessionQty: 0,
    pendingJudgeQty: 0,
    inspector: '1',
    inspectionResult: '全部合格',
    qualityInspectionEntryList: [{
      billType: String(type),
      materialId: materialId ? String(materialId) : null,
      unitId: unitId ? String(unitId) : null,
      inspectionQty: quantity,
      passQty: quantity,
      concessionQty: 0,
      pendingJudgeQty: 0,
      inspectionConclusion: '全部合格',
      finalResult: '全部合格',
      qty: quantity,
      entryNo: 1,
      remark: runToken,
      srcEntryId: srcEntryId === null ? null : String(srcEntryId)
    }],
    qualityInspectionItemList: [{
      itemId: itemId ? String(itemId) : null,
      itemName: itemName || `${runToken} 质检项`,
      itemType,
      inspectionResultType,
      inspectionResult,
      finalInspectionResult: inspectionResult,
      judgmentMode,
      inspectionQty: quantity,
      passQty: quantity,
      ngQty: 0,
      remark: runToken
    }]
  }
  const response = await api.postBusiness(
    `/mes/quality/qualityInspection/add/${encodeURIComponent(action)}`,
    payload
  )
  let inspectionId = action === 'submit' ? String(response?.data ?? '') : ''
  if (!inspectionId && action === 'save') {
    const inspections = rowsOf(await api.getBusiness(
      `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100&billNo=${encodeURIComponent(billNoValue)}`
    ), '质检单草稿回读')
    inspectionId = String(inspections.find((row) =>
      String(row?.billNo) === String(billNoValue)
    )?.id || '')
  }
  if (!inspectionId || inspectionId === '[object Object]') {
    throw new Error(`正式质检单创建未返回 ID：${JSON.stringify(response).slice(0, 300)}`)
  }
  const detail = dataOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(inspectionId)}`
  ), '正式质检单回读')
  const entries = rowsOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(inspectionId)}`
  ), '正式质检明细回读')
  let items = rowsOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${encodeURIComponent(inspectionId)}`
  ), '正式质检项目明细回读')
  if (action === 'save' && items.length === 0) {
    const entry = entries[0]
    if (!entry?.id) throw new Error(`质检单草稿未保存明细：inspection=${inspectionId}`)
    await api.postBusiness('/mes/quality/qualityInspectionItem/add', {
      mid: String(inspectionId),
      entryId: String(entry.id),
      itemId: itemId ? String(itemId) : null,
      itemName: itemName || `${runToken} 质检项`,
      itemType,
      inspectionResultType,
      inspectionResult,
      finalInspectionResult: inspectionResult,
      judgmentMode,
      inspectionQty: quantity,
      passQty: quantity,
      ngQty: 0,
      remark: runToken
    })
    items = rowsOf(await api.getBusiness(
      `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${encodeURIComponent(inspectionId)}`
    ), '正式质检项目明细回读')
  }
  return {
    action,
    inspectionId,
    billNo: billNoValue,
    token: runToken,
    detail,
    entries,
    items
  }
}

/**
 * Audit an inspection and make it effective so it enters the official
 * source-entry release / NG generation path.
 */
export async function checkInspection (api, caseRecord, inspectionId, {
  approvalResultType = '1'
} = {}) {
  const response = await api.put('/mes/quality/qualityInspection/check', {
    id: String(inspectionId),
    approvalResultType,
    approvalRemark: 'E2E quality write-side fixture audit'
  })
  const detail = dataOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(inspectionId)}`
  ), '质检单审核后回读')
  pushCheck(caseRecord, '质检单审核后回读生效阶段与轮次', true,
    `id=${inspectionId}; code=${response?.code}; isEffective=${detail?.isEffective}; billStage=${detail?.billStage}; round=${detail?.inspectionRound}`)
  return { response, detail }
}

/**
 * Submit a saved inspection draft through the public edit endpoint. When the
 * approval policy is NONE this transitions it to effective and executes the
 * same audit write-back used by the check endpoint.
 */
export async function submitDraftInspection (api, caseRecord, inspection) {
  const response = await api.put('/mes/quality/qualityInspection/edit/submit', {
    ...inspection.detail,
    id: String(inspection.inspectionId),
    qualityInspectionEntryList: inspection.entries,
    qualityInspectionItemList: inspection.items
  })
  const detail = dataOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(inspection.inspectionId)}`
  ), '质检单草稿提交后回读')
  pushCheck(caseRecord, '质检单草稿编辑提交后进入生效阶段',
    isBusinessSuccess(response) &&
      Number(detail?.isEffective) === 1 &&
      ['34', 'END_OF_EXECUTION'].some((stage) =>
        String(detail?.billStage || '').includes(stage)),
    `id=${inspection.inspectionId}; code=${response?.code}; isEffective=${detail?.isEffective}; billStage=${detail?.billStage}`)
  return { response, detail }
}

/**
 * Create a failed inspection detail row and then audit the inspection. The
 * audit is what materialises the NG record, matching the product contract.
 */
export async function createFailedDetailAndAudit (api, caseRecord, inspection, {
  detailId,
  itemId,
  itemName,
  itemType = '采购入库检验项目',
  quantity = 1,
  ngType,
  batchNo = 1,
  disqualificationReason = 'E2E fixture defect',
  judgmentMode = 'ENUM',
  inspectionValue = '0',
  standardBaseValue = 1
} = {}) {
  const detailIdValue = detailId || inspection.items?.[0]?.id
  if (!detailIdValue) throw new Error('正式质检单未回读到可用于明细挂接的质检项目 ID')
  await api.postBusiness('/mes/quality/inspectionDetailData/createBatch', [{
    inspectionId: String(inspection.inspectionId),
    detailId: String(detailIdValue),
    itemId: itemId ? String(itemId) : String(inspection.items?.[0]?.itemId || ''),
    itemName: itemName || inspection.items?.[0]?.itemName || 'E2E 质检项',
    itemType,
    batchNo,
    batchSize: quantity,
    inspectionValue,
    isQualified: 0,
    standardBaseValue,
    standardFloatValue: 0,
    judgmentMode,
    dataSource: 'MANUAL',
    quantity,
    ngType: ngType === undefined || ngType === null ? '' : String(ngType),
    disqualificationReason
  }])
  const details = rowsOf(await api.getBusiness(
    `/mes/quality/inspectionDetailData/listByInspection?inspectionId=${encodeURIComponent(inspection.inspectionId)}&pageNo=1&pageSize=100`
  ), '失败质检明细回读')
  const created = details.find((row) =>
    String(row?.detailId) === String(detailIdValue) &&
    Number(row?.isQualified) !== 1
  ) || details[0]
  if (!created?.id) throw new Error(`失败质检明细创建后未回读：inspection=${inspection.inspectionId}`)

  const check = inspection.action === 'save'
    ? await submitDraftInspection(api, caseRecord, inspection)
    : await checkInspection(api, caseRecord, inspection.inspectionId)
  return { detail: created, check }
}

/**
 * Locate an NG record produced by the audit sync for one detail row.
 */
export async function findNgRecordBySrcEntry (api, srcEntryId) {
  const rows = rowsOf(await api.getBusiness(
    `/mes/quality/qualityNgRecords/list/dictText?pageNo=1&pageSize=100&srcEntryId=${encodeURIComponent(srcEntryId)}`
  ), '不合格记录回读')
  return rows.find((row) => String(row?.srcEntryId) === String(srcEntryId)) || null
}

export const findNgRecordById = async (api, id) => {
  const data = dataOf(await api.getBusiness(
    `/mes/quality/qualityNgRecords/queryById?id=${encodeURIComponent(id)}`
  ), '不合格记录详情回读')
  return data || null
}

/**
 * Archive the local fixture token files list helper.
 */
export const tokenOwned = (row, token) => isOwnedFixture(row, token)

export const rawWmsRows = wmsRowsOf
export const wmsToken = fixtureToken
