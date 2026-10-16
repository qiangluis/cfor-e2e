import {
  createPublishedItem,
  createPlan,
  createQualityMaterialRule,
  qualityToken
} from './mes-quality-write.mjs'

export const OUTSOURCE_QUALITY_SOURCE = 'mes-outsource-quality'
export const OUTSOURCE_QUALITY_RETAINED = 'RETAINED_AUDIT_QUALITY_CONFIGURATION'
export const OUTSOURCE_INBOUND_SOURCE_TYPES = Object.freeze([
  'MesStkIo',
  'MesStkIo:110'
])

/**
 * The WMS/MES handoff uses the typed source, while quality write-back
 * normalizes it to the entity source name. Both are valid for one 110 receipt.
 */
export const isOutsourceInboundSourceBillType = (value) =>
  OUTSOURCE_INBOUND_SOURCE_TYPES.includes(String(value ?? ''))

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

/** Normalize the API's ISO string or LocalDate tuple without allowing rollover. */
export const normalizeQualityDate = (value, label = '质检生效日期') => {
  let parts
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) throw new Error(`${label}不是合法ISO日期：${value}`)
    parts = match.slice(1).map(Number)
  } else if (Array.isArray(value) && value.length === 3 &&
      value.every((part) => typeof part === 'number' && Number.isInteger(part))) {
    parts = value
  } else {
    throw new Error(`${label}必须是ISO日期字符串或[年,月,日]数组`)
  }
  const [year, month, day] = parts
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const maxDay = [4, 6, 9, 11].includes(month)
    ? 30
    : month === 2
      ? (leapYear ? 29 : 28)
      : 31
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw new Error(`${label}包含非法年月日：${JSON.stringify(value)}`)
  }
  return [year, month, day].map((part, index) =>
    String(part).padStart(index === 0 ? 4 : 2, '0')).join('-')
}

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

const assertSchemaLength = (value, max, label) => {
  if (String(value ?? '').length > max) {
    throw new Error(`${label}超过${max}字符：${String(value).length}`)
  }
}

/**
 * Create the isolated 104 configuration consumed by the outsource 110 flow.
 * Published quality artifacts are retained as audit evidence; no cleanup write
 * is attempted because an inspection may reference the rule snapshots later.
 */
export async function createDedicatedOutsourceQuality (api, caseRecord, fixture) {
  ensureRecord(caseRecord)
  const marker = fixtureMarker(fixture)
  const materialId = dedicatedProductId(fixture)
  // The local Java service may calculate billDate in UTC while the browser
  // fixture runs in Asia/Shanghai. Start the owned rule a few days earlier so
  // the rule matches both representations of the current business date.
  const effectiveFrom = fixture.effectiveFrom ??
    businessDateAsiaShanghai(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const resources = []

  const item = await createPublishedItem(api, caseRecord, {
    kind: 'OS104',
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
    token: item.token,
    publishStatus: 1,
    cleanupReason: '质检方案子项可能形成正式质检快照'
  }))
  assertSchemaLength(item?.payload?.itemName, 32, '专属104质检项目名称')
  assertSchemaLength(item?.itemCode, 64, '专属104质检项目编码')

  const planNameToken = qualityToken('OS')
  const plan = await createPlan(api, caseRecord, {
    kind: 'OS',
    type: 104,
    itemId,
    itemSnapshot: item.row,
    planName: planNameToken,
    publish: true
  })
  const planId = requireStableQualityId(plan?.row?.id ?? plan?.planId, '专属104质检方案')
  resources.push(registerQualityResource(caseRecord, {
    kind: 'quality-plan',
    id: planId,
    identity: plan.planCode,
    marker,
    token: planNameToken,
    planRemarkToken: plan.token,
    planNameToken,
    type: '104',
    publishStatus: 1,
    itemId,
    cleanupReason: '已发布方案保留历史质检快照来源'
  }))
  assertSchemaLength(plan?.planName, 32, '专属104质检方案名称')
  assertSchemaLength(plan?.planCode, 64, '专属104质检方案编码')
  if (String(plan?.type) !== '104' ||
      !boolValue(plan?.row?.publishStatus) ||
      String(plan?.row?.remark || '') !== String(plan?.token || '') ||
      String(plan?.row?.planName || '') !== String(plan.planName)) {
    throw new Error(`专属104质检方案发布或归属回读失败：${planId}`)
  }
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
  resources.push(registerQualityResource(caseRecord, {
    kind: 'quality-material-rule',
    id: ruleId,
    identity: `${materialId}:104:${planId}`,
    marker,
    token: planNameToken,
    planRemarkToken: plan.token,
    materialId,
    planId,
    type: '104',
    effectiveFrom,
      cleanupReason: '正式质检单引用后规则不可删除'
  }))
  // The stock submit endpoint validates the raw 110 scene, while the
  // generated inspection normalizes that scene to 104. Keep both bindings
  // explicit so the normal WMS -> MES contract can pass its own guards.
  const inboundRule = await createQualityMaterialRule(api, caseRecord, {
    materialId,
    planId,
    type: '110',
    effectiveFrom,
    effectiveTo: null,
    applyOrgId: '',
    businessSubType: '',
    isDefault: true,
    priority: 0
  })
  const inboundRuleId = requireStableQualityId(
    inboundRule?.row?.id ?? inboundRule?.ruleId,
    '专属110质检存货规则'
  )
  resources.push(registerQualityResource(caseRecord, {
    kind: 'quality-material-rule',
    id: inboundRuleId,
    identity: `${materialId}:110:${planId}`,
    marker,
    token: planNameToken,
    planRemarkToken: plan.token,
    materialId,
    planId,
    type: '110',
    effectiveFrom,
    cleanupReason: '正式收货单引用后规则不可删除'
  }))
  const ruleRow = rule?.row
  const actualEffectiveFrom = normalizeQualityDate(ruleRow?.effectiveFrom)
  if (String(ruleRow?.id) !== ruleId ||
      String(ruleRow?.materialId) !== materialId ||
      String(ruleRow?.planId) !== planId ||
      String(ruleRow?.type) !== '104' ||
      actualEffectiveFrom !== normalizeQualityDate(effectiveFrom) ||
      !boolValue(ruleRow?.isDefault)) {
    throw new Error(`专属104质检存货规则归属回读失败：${ruleId}`)
  }

  return {
    item,
    plan,
    rule,
    inboundRule,
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

export const requiresOutsourceInspectionSubmit = (detail, entries, quantity = 1) => {
  const qty = Number(quantity)
  requirePayloadObject(detail, '质检单详情')
  if (Number(detail.isEffective) === 1) {
    if (String(detail.billStage) !== '34' || Number(detail.isVoided) !== 0 ||
        String(detail.type) !== '104' || !isOutsourceInboundSourceBillType(detail.srcBillType) ||
        !Array.isArray(entries) || entries.length !== 1 ||
        Number(entries[0].qty) !== qty || Number(entries[0].inspectionQty) !== qty ||
        Number(entries[0].passQty) !== qty || Number(entries[0].concessionQty) !== 0 ||
        Number(entries[0].pendingJudgeQty) !== 0) {
      throw new Error(`已生效委外104质检不是本轮合格${qty}/让步0/待判0的完成事实`)
    }
    return false
  }
  if (Number(detail.isEffective) !== 0 || detail.actions?.edit !== true) {
    throw new Error('未生效委外104质检不允许编辑提交')
  }
  return true
}

/**
 * Build the exact qualified 104 inspection edit/submit payload for a 110
 * outsource receipt. Existing source IDs and inspection plan are immutable.
 */
export const buildQualifiedInspectionPayload = (detail, entries, items, quantity = 1) => {
  const qty = Number(quantity)
  if (!(qty > 0)) {
    throw new Error(`委外104合格质检数量必须为正数：${quantity}`)
  }
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
  if (!isOutsourceInboundSourceBillType(source.srcBillType)) {
    throw new Error(`质检单来源不是 MesStkIo 或 MesStkIo:110：${source.srcBillType ?? 'empty'}`)
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
    srcBillType: source.srcBillType,
    srcBillId,
    inspectionPlan,
    inspectionQty: qty,
    qty,
    passQty: qty,
    concessionQty: 0,
    pendingJudgeQty: 0,
    inspectionResult: '全部合格',
    qualityInspectionEntryList: [{
      ...entry,
      billType: '104',
      srcEntryId,
      inspectionQty: qty,
      qty,
      passQty: qty,
      concessionQty: 0,
      pendingJudgeQty: 0,
      inspectionConclusion: '全部合格',
      finalResult: '全部合格'
    }],
    qualityInspectionItemList: sourceItems.map((item) => ({
      ...item,
      inspectionQty: qty,
      passQty: qty,
      ngQty: 0,
      inspectionResult: '1',
      finalInspectionResult: '1'
    }))
  }
}
