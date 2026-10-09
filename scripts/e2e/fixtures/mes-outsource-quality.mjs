import {
  createPublishedItem,
  createPlan,
  createQualityMaterialRule
} from './mes-quality-write.mjs'

export const OUTSOURCE_QUALITY_SOURCE = 'mes-outsource-quality'
export const OUTSOURCE_QUALITY_RETAINED = 'RETAINED_AUDIT_QUALITY_CONFIGURATION'

export const isStableQualityId = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0
  }
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

const requireStableQualityId = (value, label) => {
  if (!isStableQualityId(value)) {
    throw new Error(`${label}未返回合法且安全的数字ID`)
  }
  return String(value)
}

const businessDateAsiaShanghai = (now = new Date()) => {
  const date = new Date(now)
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Asia/Shanghai业务日期输入无效')
  }
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

export { businessDateAsiaShanghai }

const ensureRecord = (caseRecord) => {
  if (!caseRecord || typeof caseRecord !== 'object') {
    throw new Error('委外104质检前置需要 caseRecord')
  }
  caseRecord.checks ||= []
  caseRecord.notes ||= []
  caseRecord.fixtures ||= []
}

const fixtureMarker = (fixture) => {
  const marker = fixture?.marker || fixture?.draft?.marker
  if (!marker || !String(marker).trim()) {
    throw new Error('委外104质检前置缺少专属 fixture marker')
  }
  return String(marker)
}

const dedicatedProductId = (fixture) => {
  const value = fixture?.product?.id ??
    fixture?.prerequisite?.product?.id ??
    fixture?.draft?.prerequisite?.product?.id ??
    fixture?.work?.materialId
  return requireStableQualityId(value, '委外专属FG')
}

const registerQualityResource = (caseRecord, resource) => {
  const id = requireStableQualityId(resource?.id, `专属${resource?.kind || '质检资源'}`)
  const entry = {
    source: OUTSOURCE_QUALITY_SOURCE,
    ...resource,
    id,
    cleanup: OUTSOURCE_QUALITY_RETAINED
  }
  const duplicate = caseRecord.fixtures.find((row) =>
    row?.source === OUTSOURCE_QUALITY_SOURCE &&
    row.kind === entry.kind &&
    String(row.id) === id)
  if (!duplicate) {
    caseRecord.fixtures.push(entry)
    return entry
  }
  Object.assign(duplicate, entry)
  return duplicate
}

const boolValue = (value) => value === true || Number(value) === 1 || value === '1'

/**
 * Create the isolated 104 configuration consumed by the outsource 110 flow.
 * Published quality artifacts are retained as audit evidence; no cleanup write
 * is attempted because an inspection may reference the rule snapshots later.
 */
export async function createDedicatedOutsourceQuality (api, caseRecord, fixture) {
  ensureRecord(caseRecord)
  const marker = fixtureMarker(fixture)
  const materialId = dedicatedProductId(fixture)
  const effectiveFrom = businessDateAsiaShanghai()
  const resources = []

  const item = await createPublishedItem(api, caseRecord, {
    kind: `${marker}-FG-104`,
    itemType: '生产入库检验项目',
    inspectionResultType: 'select',
    inspectionResult: '1',
    judgmentMode: 'ENUM',
    standardBaseValue: 1
  })
  const itemId = requireStableQualityId(item?.row?.id ?? item?.itemId, '专属104质检项目')
  resources.push(registerQualityResource(caseRecord, {
    kind: 'quality-item',
    id: itemId,
    identity: item.itemCode,
    marker,
    publishStatus: 1,
    cleanupReason: '质检方案子项可能形成正式质检快照'
  }))

  const plan = await createPlan(api, caseRecord, {
    kind: `${marker}-PLAN-104`,
    type: 104,
    itemId,
    itemSnapshot: item.row,
    planName: `${marker} 专属成品入库检方案`,
    publish: true
  })
  const planId = requireStableQualityId(plan?.row?.id ?? plan?.planId, '专属104质检方案')
  if (String(plan?.type) !== '104' ||
      !boolValue(plan?.row?.publishStatus) ||
      String(plan?.row?.remark || '') !== String(plan?.token || '') ||
      String(plan?.row?.planName || '') !== String(plan.planName)) {
    throw new Error(`专属104质检方案发布或归属回读失败：${planId}`)
  }
  resources.push(registerQualityResource(caseRecord, {
    kind: 'quality-plan',
    id: planId,
    identity: plan.planCode,
    marker,
    type: '104',
    publishStatus: 1,
    itemId,
    cleanupReason: '已发布方案保留历史质检快照来源'
  }))

  const rule = await createQualityMaterialRule(api, caseRecord, {
    materialId,
    planId,
    type: '104',
    effectiveFrom,
    effectiveTo: null,
    applyOrgId: '',
    businessSubType: '',
    isDefault: true,
    priority: 0
  })
  const ruleId = requireStableQualityId(rule?.row?.id ?? rule?.ruleId, '专属104质检存货规则')
  const ruleRow = rule?.row
  if (String(ruleRow?.id) !== ruleId ||
      String(ruleRow?.materialId) !== materialId ||
      String(ruleRow?.planId) !== planId ||
      String(ruleRow?.type) !== '104' ||
      String(ruleRow?.effectiveFrom) !== effectiveFrom ||
      !boolValue(ruleRow?.isDefault)) {
    throw new Error(`专属104质检存货规则归属回读失败：${ruleId}`)
  }
  resources.push(registerQualityResource(caseRecord, {
    kind: 'quality-material-rule',
    id: ruleId,
    identity: `${materialId}:104:${planId}`,
    marker,
    materialId,
    planId,
    type: '104',
    effectiveFrom,
    cleanupReason: '正式质检单引用后规则不可删除'
  }))

  return {
    item,
    plan,
    rule,
    materialId,
    effectiveFrom,
    resources
  }
}

const requirePayloadObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`)
  }
  return value
}

/**
 * Build the exact qualified 104 inspection edit/submit payload for a 110
 * outsource receipt. Existing source IDs and inspection plan are immutable.
 */
export const buildQualifiedInspectionPayload = (detail, entries, items) => {
  const source = requirePayloadObject(detail, '质检单详情')
  const sourceEntries = Array.isArray(entries) ? entries : null
  const sourceItems = Array.isArray(items) ? items : null
  if (!sourceEntries || sourceEntries.length !== 1) {
    throw new Error('委外104合格质检必须且只能有一条质检明细')
  }
  if (!sourceItems || sourceItems.length === 0) {
    throw new Error('委外104合格质检缺少质检项目明细')
  }
  if (String(source.type) !== '104') {
    throw new Error(`质检单类型不是104：${source.type ?? 'empty'}`)
  }
  if (String(source.srcBillType) !== 'MesStkIo:110') {
    throw new Error(`质检单来源不是 MesStkIo:110：${source.srcBillType ?? 'empty'}`)
  }
  const inspectionId = requireStableQualityId(source.id, '质检单')
  const srcBillId = requireStableQualityId(source.srcBillId, '110来源库存单')
  const inspectionPlan = requireStableQualityId(source.inspectionPlan, '质检方案')
  const entry = requirePayloadObject(sourceEntries[0], '质检明细')
  const srcEntryId = requireStableQualityId(entry.srcEntryId, '110来源库存明细')
  for (const item of sourceItems) {
    requirePayloadObject(item, '质检项目明细')
    requireStableQualityId(item.itemId, '质检项目')
  }

  return {
    ...source,
    id: inspectionId,
    type: '104',
    srcBillType: 'MesStkIo:110',
    srcBillId,
    inspectionPlan,
    inspectionQty: 1,
    qty: 1,
    passQty: 1,
    concessionQty: 0,
    pendingJudgeQty: 0,
    inspectionResult: '全部合格',
    qualityInspectionEntryList: [{
      ...entry,
      billType: '104',
      srcEntryId,
      inspectionQty: 1,
      qty: 1,
      passQty: 1,
      concessionQty: 0,
      pendingJudgeQty: 0,
      inspectionConclusion: '全部合格',
      finalResult: '全部合格'
    }],
    qualityInspectionItemList: sourceItems.map((item) => ({
      ...item,
      inspectionQty: 1,
      passQty: 1,
      ngQty: 0,
      inspectionResult: '1',
      finalInspectionResult: '1'
    }))
  }
}
