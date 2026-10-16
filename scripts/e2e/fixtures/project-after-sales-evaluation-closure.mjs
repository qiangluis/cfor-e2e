import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

export const EVALUATION_ACCEPTANCE_GAPS = Object.freeze({
  'PB128-001': [
    {
      assertion: 'PB-128：尚未验证被启用模板引用的评价项目禁止删除，以及更新时稳定编码不可改',
      check: 'PB128/GAP1 stable-code-and-reference-protection'
    },
    {
      assertion: '尚未通过真实页面保存刷新题型、选项、必填、分值和适用分类并精确回读',
      check: 'PB128/GAP2 browser-save-reload-all-item-fields'
    },
    {
      assertion: '尚未创建正式评价记录并验证固定引用模板版本',
      check: 'PB128/GAP3 persisted-evaluation-template-version'
    }
  ],
  'PB129-001': [
    {
      assertion: 'PB-129：尚未精确比较题型、选项、顺序和分值完整模板快照，证明项目主档变更及模板新版本不改旧快照；名称冻结不能替代完整内容冻结',
      check: 'PB129/GAP1 complete-snapshot-frozen-across-new-version'
    },
    {
      assertion: '尚未验证正式评价记录固定模板版本，模板更新后历史统计口径不变',
      check: 'PB129/GAP2 historical-evaluation-and-customer-statistics'
    },
    {
      assertion: '尚未验证启用模板对评价项目的引用保护',
      check: 'PB129/GAP3 enabled-template-reference-protection'
    }
  ]
})

const data = (response, label) => assertBusinessSuccess(response, label).data
export const evaluationId = (value, label = 'evaluation ID') => {
  assert.ok(typeof value === 'string' || typeof value === 'number', `${label}: invalid ID type`)
  assert.match(String(value), /^[1-9]\d*$/, `${label}: missing ID`)
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value), `${label}: lossy ID`)
  return String(value)
}
const list = (response, label) => {
  const value = data(response, label)
  assert.ok(Array.isArray(value), `${label}: missing array`)
  const ids = value.map((row) => evaluationId(row?.id, label))
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate IDs`)
  return value
}
const number = (value, label) => {
  assert.ok((typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) &&
    Number.isFinite(Number(value)) && Number(value) >= 0, `${label}: invalid number`)
  return Number(value)
}
const day = (offset, now) => {
  const date = new Date(`${new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai'
  }).format(now)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export const assertEvaluationLocalTarget = (target = config) => {
  assert.equal(target.target, 'local')
  assert.equal(String(target.tenantId), '1')
  assert.equal(target.db?.name, 'cfor_admin_standard')
  for (const [base, port] of [[target.apiBase, '48083'], [target.webBase, '9151']]) {
    const url = new URL(base)
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    assert.equal(url.port, port)
  }
}
const assertFixture = (fixture) => {
  assertEvaluationLocalTarget()
  assert.ok(Object.hasOwn(EVALUATION_ACCEPTANCE_GAPS, fixture?.caseId))
  assert.equal(fixture.prefix, fixture.caseId.slice(0, 5))
  assert.match(fixture.marker, new RegExp(`^${fixture.prefix}-[0-9a-f]{16}$`))
}

export const newEvaluationFixture = (caseId, now = new Date()) => {
  assert.ok(Object.hasOwn(EVALUATION_ACCEPTANCE_GAPS, caseId), 'unsupported evaluation case')
  const prefix = caseId.slice(0, 5)
  const marker = `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  return {
    caseId, prefix, marker, resources: [], items: [], templates: [],
    customerNo: `${marker}-CUSTOMER`, materialCode: `${marker}-MAT`,
    assetNo: `${marker}-ASSET`, ticketTitle: `${marker}-TICKET`,
    period: { startDate: day(-7, now), endDate: day(365, now) },
    reportStart: day(-1, now), reportEnd: day(1, now),
    finishTime: `${day(1, now)} 18:00:00`
  }
}

const paths = Object.freeze({
  CATEGORY: ['category', 'categoryCode'],
  SLA_POLICY: ['sla-policy', 'policyCode'],
  EVALUATION_ITEM_CATEGORY: ['evaluation-item-category', 'categoryCode'],
  EVALUATION_ITEM: ['evaluation-item', 'itemCode'],
  EVALUATION_TEMPLATE: ['evaluation-template', 'templateCode']
})
const resourcePath = (resource) => `/after-sales/modeling/${paths[resource.type][0]}`
const owner = (row, resource, fixture) => {
  const key = paths[resource.type][1]
  assert.equal(row?.[key], resource.body[key], `${fixture.prefix}: foreign ${resource.type}`)
  assert.ok(row[key].startsWith(`${fixture.marker}-`), 'foreign fixture marker')
  const foundId = evaluationId(row.id)
  if (resource.id) assert.equal(foundId, resource.id, 'foreign configuration ID')
  if (row.tenantId != null) assert.equal(String(row.tenantId), '1', 'foreign tenant')
  if (resource.type === 'EVALUATION_ITEM') {
    assert.ok(fixture.resources.some((category) =>
      category.type === 'EVALUATION_ITEM_CATEGORY' && category.id === evaluationId(row.categoryId)),
    'foreign evaluation category')
  }
  return row
}

export const readEvaluationConfig = async (api, fixture, resource) => {
  const values = list(await api.getBusiness(`${resourcePath(resource)}/list`), resource.type)
  const key = paths[resource.type][1]
  const found = values.filter((row) => row[key] === resource.body[key] ||
    (resource.id && evaluationId(row.id) === resource.id))
  assert.equal(found.length, 1, `${fixture.prefix}: ${resource.type} must resolve uniquely; LIMIT 100 is not absence evidence`)
  return owner(found[0], resource, fixture)
}

export const createEvaluationConfig = async (api, fixture, type, body) => {
  assertFixture(fixture)
  assert.ok(Object.hasOwn(paths, type))
  const resource = { type, body: structuredClone(body), pending: true }
  fixture.resources.push(resource)
  resource.id = evaluationId(data(await api.postBusiness(`${resourcePath(resource)}/create`, body), type))
  resource.pending = false
  await readEvaluationConfig(api, fixture, resource)
  return resource
}

const materialOwner = (material, fixture) => {
  assert.equal(fixture.materialCode, `${fixture.marker}-MAT`)
  assert.equal(evaluationId(material?.id), fixture.materialId)
  assert.equal(material.code, fixture.materialCode)
  assert.equal(material.remark, fixture.marker)
  return material
}
export const readEvaluationAsset = async (api, fixture) => {
  const detail = data(await api.getBusiness(`/after-sales/asset/get?id=${fixture.assetId}`), 'evaluation asset')
  assert.equal(evaluationId(detail?.asset?.id), fixture.assetId)
  assert.equal(evaluationId(detail.asset.customerId), fixture.customerId)
  assert.equal(evaluationId(detail.asset.materialId), fixture.materialId)
  assert.equal(detail.asset.assetNo, fixture.assetNo)
  assert.equal(evaluationId(detail.customer?.id), fixture.customerId)
  assert.equal(detail.customer.customerNo, fixture.customerNo)
  return detail
}
export const readEvaluationTicket = async (api, fixture) => {
  const ticket = data(await api.getBusiness(`/after-sales/ticket/get?id=${fixture.ticketId}`), 'evaluation ticket')
  assert.equal(evaluationId(ticket?.id), fixture.ticketId)
  assert.equal(evaluationId(ticket.customerId), fixture.customerId)
  assert.equal(evaluationId(ticket.assetId), fixture.assetId)
  assert.equal(evaluationId(ticket.categoryId), fixture.issueCategory.id)
  assert.equal(ticket.title, fixture.ticketTitle)
  return ticket
}

export const prepareEvaluationFixtures = async (api, fixture) => {
  assertFixture(fixture)
  // These modeling lists are capped at 100; require headroom before creating owned resources.
  for (const [type, addition] of [
    ['EVALUATION_ITEM_CATEGORY', 2], ['EVALUATION_ITEM', 4],
    ['EVALUATION_TEMPLATE', 2], ['SLA_POLICY', 1]
  ]) {
    const current = list(await api.getBusiness(`${resourcePath({ type })}/list`), type)
    assert.ok(current.length + addition < 100, `BLOCKED: ${type} list capacity cannot prove complete readback`)
  }
  const units = list(await api.getBusiness('/mes/basUnit/list/enabled'), 'enabled units')
  assert.ok(units.length, 'BLOCKED: no enabled unit')
  fixture.materialAttempted = true
  fixture.materialId = evaluationId(data(await api.postBusiness('/mes/basMaterial/add', {
    code: fixture.materialCode, name: fixture.marker, auxName: fixture.marker,
    unitId: evaluationId(units[0].id), inventoryNature: 'STOCK', isMaterial: 'Y',
    isEnabled: 1, purchased: 'Y', saled: 'Y', produced: 'N', source: 'purchase',
    leadTime: 1, bufferTime: 1, batchManaged: 'N', oneBarcode: 'N',
    periodManaged: 'N', gradeManaged: 'N', remark: fixture.marker
  }), 'evaluation material'))
  materialOwner(data(await api.getBusiness(
    `/mes/basMaterial/queryById?id=${fixture.materialId}`), 'evaluation material readback'), fixture)
  fixture.profileAttempted = true
  const profile = data(await api.postBusiness('/after-sales/asset/customer-profile/create', {
    customerNo: fixture.customerNo, fullName: fixture.customerNo, shortName: fixture.marker,
    primaryContactName: `${fixture.marker}-CONTACT`, primaryContactMobile: '13800000128',
    assets: [{
      assetNo: fixture.assetNo, materialId: fixture.materialId, assetName: fixture.marker,
      assetContent: fixture.marker, useStartDate: fixture.period.startDate, storageAddress: fixture.marker,
      managers: [{ departmentName: 'E2E', managerName: fixture.marker,
        managerMobile: '13800000129', primary: true }],
      servicePeriods: [{ ...fixture.period, sourceType: 'MANUAL',
        sourceNo: fixture.assetNo, sourceName: fixture.marker, idempotencyKey: fixture.assetNo }]
    }]
  }), 'evaluation dedicated customer profile')
  fixture.customerId = evaluationId(profile?.customerId)
  fixture.contactId = evaluationId(profile?.primaryContactId)
  assert.ok(Array.isArray(profile.assetIds) && profile.assetIds.length === 1, 'profile must return one owned asset')
  fixture.assetId = evaluationId(profile.assetIds[0])
  const detail = await readEvaluationAsset(api, fixture)
  assert.equal(detail.asset.serviceStatus, 'IN_SERVICE')
  assert.equal(detail.asset.serviceStartDate, fixture.period.startDate)
  assert.equal(detail.asset.serviceEndDate, fixture.period.endDate)
  assert.ok(Array.isArray(detail.servicePeriods) && detail.servicePeriods.some((period) =>
    period.sourceNo === fixture.assetNo && period.startDate === fixture.period.startDate &&
    period.endDate === fixture.period.endDate && period.status === 'VALID'), 'missing persisted service basis')
  fixture.issueCategory = await createEvaluationConfig(api, fixture, 'CATEGORY', {
    categoryCode: `${fixture.marker}-ISSUE`, categoryName: `${fixture.marker}-ISSUE`,
    defaultPriority: 'P3', applicableServiceStatus: 'IN_SERVICE', sortNo: 0
  })
  const issue = await readEvaluationConfig(api, fixture, fixture.issueCategory)
  assert.equal(issue.leafFlag, true)
  assert.equal(issue.status, 'ENABLED')
  fixture.sla = await createEvaluationConfig(api, fixture, 'SLA_POLICY', {
    policyCode: `${fixture.marker}-SLA`, policyName: `${fixture.marker}-SLA`,
    categoryIds: [fixture.issueCategory.id], priority: 'P3', assetServiceStatus: 'IN_SERVICE',
    responseMinutes: 30, resolutionCommitted: true, resolutionMinutes: 240,
    warningRatio: 80, effectiveType: 'IMMEDIATE', remark: fixture.marker
  })
  const matched = list(await api.getBusiness('/after-sales/modeling/sla-policy/list'), 'SLA')
    .filter((row) => row.status === 'ENABLED' && row.priority === 'P3' &&
      row.assetServiceStatus === 'IN_SERVICE' &&
      row.categoryIds?.some((id) => evaluationId(id) === fixture.issueCategory.id))
  assert.equal(matched.length, 1, 'dedicated ticket requires one matching SLA')
  assert.equal(evaluationId(matched[0].id), fixture.sla.id)
  fixture.evaluationCategory = await createEvaluationConfig(api, fixture, 'EVALUATION_ITEM_CATEGORY', {
    categoryCode: `${fixture.marker}-EVAL-A`, categoryName: `${fixture.marker}-EVAL-A`, sortNo: 0
  })
  fixture.alternateCategory = await createEvaluationConfig(api, fixture, 'EVALUATION_ITEM_CATEGORY', {
    categoryCode: `${fixture.marker}-EVAL-B`, categoryName: `${fixture.marker}-EVAL-B`, sortNo: 0
  })
  for (const [suffix, type, options, maxScore, required] of [
    ['RESOLVED', 'RESOLUTION_CONFIRM', [], 0, true],
    ['STAR', 'STAR', ['1', '2', '3', '4', '5'], 5, true],
    ['CHOICE', 'SINGLE', ['SATISFIED', 'NEUTRAL', 'UNSATISFIED'], 40, false],
    ['TEXT', 'TEXT', [], 0, true]
  ]) {
    fixture.items.push(await createEvaluationConfig(api, fixture, 'EVALUATION_ITEM', {
      categoryId: fixture.evaluationCategory.id, itemCode: `${fixture.marker}-${suffix}`,
      itemName: `${fixture.marker}-${suffix}`, evaluationType: type, options,
      maxScore, required, sortNo: fixture.items.length + 1
    }))
  }
  return fixture
}

const parsedOptions = (value, type) => {
  assert.ok(value === null || typeof value === 'string', 'missing/invalid snapshot options')
  const options = value === null ? [] : JSON.parse(value)
  assert.ok(Array.isArray(options) && options.every((option) => typeof option === 'string'), 'invalid options array')
  if (['SINGLE', 'MULTIPLE'].includes(type)) assert.ok(options.length, 'missing selectable options')
  return options
}

export const evaluationTemplateSnapshot = (template, fixture, resource) => {
  const templateId = evaluationId(template?.templateId ?? template?.id)
  assert.equal(templateId, resource.id)
  assert.equal(template.templateCode, resource.body.templateCode)
  assert.equal(template.templateName, resource.body.templateName)
  assert.equal(template.versionNo, resource.body.versionNo)
  assert.equal(number(template.totalScore, 'totalScore'), 100)
  assert.ok(Array.isArray(template.items) && template.items.length === resource.body.items.length,
    'incomplete template snapshot')
  const seen = new Set()
  let previousSort = -1
  const items = template.items.map((item) => {
    const itemId = evaluationId(item.itemId)
    assert.ok(!seen.has(itemId), 'duplicate snapshot item ID')
    seen.add(itemId)
    assert.ok(fixture.items.some((owned) => owned.id === itemId), 'foreign snapshot item')
    assert.equal(evaluationId(item.templateId), resource.id)
    evaluationId(item.id)
    assert.ok(typeof item.itemNameSnapshot === 'string' && item.itemNameSnapshot.length, 'missing snapshot name')
    assert.ok(['RESOLUTION_CONFIRM', 'STAR', 'SINGLE', 'MULTIPLE', 'TEXT'].includes(item.evaluationTypeSnapshot))
    parsedOptions(item.optionsSnapshotJson, item.evaluationTypeSnapshot)
    assert.equal(typeof item.requiredFlag, 'boolean', 'missing snapshot required flag')
    const sortNo = number(item.sortNo, 'sortNo')
    assert.ok(Number.isSafeInteger(sortNo) && sortNo > previousSort, 'snapshot order is not strictly ascending')
    previousSort = sortNo
    const result = structuredClone(item)
    result.id = evaluationId(item.id)
    result.itemId = itemId
    result.templateId = resource.id
    if (item.tenantId != null) {
      assert.equal(String(item.tenantId), '1', 'foreign snapshot tenant')
      result.tenantId = '1'
    }
    result.score = number(item.score, 'snapshot score')
    result.sortNo = sortNo
    return result
  })
  assert.equal(items.reduce((sum, item) => sum + item.score, 0), 100)
  return {
    templateId, templateCode: template.templateCode, templateName: template.templateName,
    versionNo: template.versionNo, totalScore: 100, items
  }
}

export const createOwnedEvaluationTemplate = async (api, fixture, versionNo = 'V1', entries) => {
  const items = entries || fixture.items.map((item, index) => ({
    itemId: item.id, score: [0, 60, 40, 0][index],
    required: item.body.required, sortNo: index + 1
  }))
  const resource = await createEvaluationConfig(api, fixture, 'EVALUATION_TEMPLATE', {
    templateCode: `${fixture.marker}-${versionNo}`, templateName: `${fixture.marker}-TEMPLATE`,
    versionNo, items
  })
  fixture.templates.push(resource)
  data(await api.postBusiness(`/after-sales/modeling/evaluation-template/enable?id=${resource.id}`), 'enable template')
  const enabled = await readEvaluationConfig(api, fixture, resource)
  assert.equal(enabled.status, 'ENABLED')
  const snapshot = evaluationTemplateSnapshot(enabled, fixture, resource)
  const expected = [...items].sort((left, right) => left.sortNo - right.sortNo).map((entry) => {
    const item = fixture.items.find((row) => row.id === entry.itemId)
    assert.ok(item, 'template references unowned item')
    return {
      itemId: item.id, itemNameSnapshot: item.body.itemName,
      evaluationTypeSnapshot: item.body.evaluationType, options: item.body.options,
      score: entry.score, requiredFlag: item.body.evaluationType === 'RESOLUTION_CONFIRM' || entry.required,
      sortNo: entry.sortNo
    }
  })
  assert.deepEqual(snapshot.items.map((item) => ({
    itemId: item.itemId, itemNameSnapshot: item.itemNameSnapshot,
    evaluationTypeSnapshot: item.evaluationTypeSnapshot,
    options: parsedOptions(item.optionsSnapshotJson, item.evaluationTypeSnapshot),
    score: item.score, requiredFlag: item.requiredFlag, sortNo: item.sortNo
  })), expected, 'template must contain all expected business fields')
  resource.snapshot = snapshot
  return resource
}

export const assertExactEvaluationRejection = (response, code, message) => {
  assert.equal(response?.code, code, 'wrong rejection code')
  assert.equal(response.msg, message, 'wrong rejection message')
}
const revisions = async (api, resource) => list(await api.getBusiness(
  `/after-sales/modeling/revisions?configType=${resource.type}&configId=${resource.id}`
), 'evaluation revisions')

export const verifyEvaluationItemProtection = async (api, fixture, item, template, stableCode = false) => {
  assertFixture(fixture)
  const before = structuredClone(await readEvaluationConfig(api, fixture, item))
  assert.equal(before.status, 'ENABLED', 'reference protection requires an enabled owned item')
  const beforeRevision = structuredClone(await revisions(api, item))
  assert.ok(beforeRevision.length < 100, 'revision LIMIT 100 cannot prove no additional writes')
  const enabledTemplate = await readEvaluationConfig(api, fixture, template)
  assert.equal(enabledTemplate.status, 'ENABLED', 'reference protection requires an enabled owned template')
  const beforeTemplate = evaluationTemplateSnapshot(enabledTemplate, fixture, template)
  assert.deepEqual(beforeTemplate, template.snapshot)
  if (stableCode) {
    assertExactEvaluationRejection(await api.put(
      `/after-sales/modeling/evaluation-item/update?id=${item.id}`,
      { ...item.body, itemCode: `${item.body.itemCode}-CHANGED` }
    ), 1020055, '评价项目编码是稳定引用，创建后不能修改')
    assert.deepEqual(await readEvaluationConfig(api, fixture, item), before, 'rejected code edit changed item')
    assert.deepEqual(await revisions(api, item), beforeRevision, 'rejected code edit appended revision')
  }
  assertExactEvaluationRejection(await api.delete(
    `/after-sales/modeling/evaluation-item/delete?id=${item.id}`
  ), 1020056, '评价项目已被评价模板引用，只能停用不能删除')
  assert.deepEqual(await readEvaluationConfig(api, fixture, item), before, 'rejected delete changed item')
  assert.deepEqual(await revisions(api, item), beforeRevision, 'rejected delete appended revision')
  const afterTemplate = await readEvaluationConfig(api, fixture, template)
  assert.equal(afterTemplate.status, 'ENABLED')
  assert.deepEqual(evaluationTemplateSnapshot(afterTemplate, fixture, template), beforeTemplate,
  'rejected mutations changed template snapshot')
  return true
}

export const evaluateOwnedTicket = async (api, fixture, template) => {
  assertFixture(fixture)
  assert.equal((await readEvaluationAsset(api, fixture)).asset.serviceStatus, 'IN_SERVICE')
  assert.deepEqual(evaluationTemplateSnapshot(
    await readEvaluationConfig(api, fixture, template), fixture, template), template.snapshot)
  fixture.ticketAttempted = true
  fixture.ticketId = evaluationId(data(await api.postBusiness('/after-sales/ticket/create', {
    title: fixture.ticketTitle, description: fixture.marker, sourceChannel: 'MANUAL',
    priority: 'P3', requiredFinishTime: fixture.finishTime, customerId: fixture.customerId,
    assetId: fixture.assetId, contactId: fixture.contactId, categoryId: fixture.issueCategory.id,
    categoryName: fixture.issueCategory.body.categoryName, urgency: 'NORMAL', importance: 'NORMAL',
    impactScope: fixture.marker, submitterName: `${fixture.marker}-CONTACT`
  }), 'evaluation owned ticket'))
  assert.equal((await readEvaluationTicket(api, fixture)).status, 'PENDING_ACCEPTANCE')
  const sla = data(await api.getBusiness(`/after-sales/sla/get?ticketId=${fixture.ticketId}`), 'ticket SLA')
  assert.equal(evaluationId(sla?.ticketId), fixture.ticketId)
  assert.equal(evaluationId(sla.policyId), fixture.sla.id)
  assert.equal(JSON.parse(sla.policySnapshotJson).policyCode, fixture.sla.body.policyCode)
  data(await api.postBusiness('/after-sales/ticket/process', {
    ticketId: fixture.ticketId, targetStatus: 'PENDING_CUSTOMER_VERIFICATION',
    processMethod: fixture.marker, resolution: `${fixture.marker}-RESOLVED`
  }), 'evaluation process')
  assert.equal((await readEvaluationTicket(api, fixture)).status, 'PENDING_CUSTOMER_VERIFICATION')
  data(await api.postBusiness('/after-sales/ticket/customer-confirm', {
    ticketId: fixture.ticketId, resolved: true, feedback: fixture.marker
  }), 'evaluation customer confirmation')
  assert.equal((await readEvaluationTicket(api, fixture)).status, 'PENDING_EVALUATION')
  data(await api.postBusiness('/after-sales/ticket/evaluate', {
    ticketId: fixture.ticketId, templateId: template.id, score: 5,
    content: fixture.marker, evaluatorName: `${fixture.marker}-CONTACT`
  }), 'formal evaluation')
  const ticket = await readEvaluationTicket(api, fixture)
  assert.equal(ticket.status, 'CLOSED')
  assert.equal(ticket.evaluationStatus, 'COMPLETED')
  const evaluation = await readOwnedEvaluation(api, fixture, template)
  fixture.evaluation = structuredClone(evaluation)
  return evaluation
}

export const readOwnedEvaluation = async (api, fixture, template) => {
  const value = data(await api.getBusiness(
    `/after-sales/ticket/evaluation/get?ticketId=${fixture.ticketId}`), 'formal evaluation readback')
  evaluationId(value?.id)
  assert.equal(evaluationId(value.ticketId), fixture.ticketId)
  assert.equal(evaluationId(value.templateId), template.id)
  assert.equal(value.templateVersionNo, template.body.versionNo)
  assert.equal(number(value.score, 'evaluation score'), 5)
  assert.equal(value.evaluationContent, fixture.marker)
  assert.equal(value.evaluatorName, `${fixture.marker}-CONTACT`)
  assert.ok(value.evaluationTime != null && String(value.evaluationTime).length > 0, 'missing persisted evaluation time')
  assert.ok(typeof value.templateSnapshotJson === 'string', 'missing persisted snapshot JSON')
  assert.deepEqual(evaluationTemplateSnapshot(JSON.parse(value.templateSnapshotJson), fixture, template),
    template.snapshot, 'formal evaluation lost complete frozen snapshot')
  return value
}

export const readEvaluationStatistics = async (api, fixture) => {
  const value = data(await api.getBusiness(`/after-sales/report/analysis?${new URLSearchParams({
    start: fixture.reportStart, end: fixture.reportEnd, customerId: fixture.customerId
  })}`), 'dedicated evaluation statistics')
  assert.equal(value?.scope?.start, fixture.reportStart)
  assert.equal(value.scope.end, fixture.reportEnd)
  assert.equal(evaluationId(value.scope.customerId), fixture.customerId)
  assert.equal(number(value.total, 'report total'), 1)
  assert.equal(number(value.resolved, 'report resolved'), 1)
  assert.equal(number(value.evaluationCount, 'report evaluationCount'), 1)
  assert.equal(number(value.customerScore, 'report customerScore'), 5)
  assert.ok(Array.isArray(value.issueDetails) && value.issueDetails.length === 1, 'report requires one owned ticket')
  assert.equal(evaluationId(value.issueDetails[0].id), fixture.ticketId)
  assert.equal(evaluationId(value.issueDetails[0].assetId), fixture.assetId)
  assert.equal(value.issueDetails[0].description, fixture.ticketTitle)
  assert.equal(value.issueDetails[0].status, 'CLOSED')
  return structuredClone(value)
}

export const verifyEvaluationVersionFreeze = async (api, fixture, v1) => {
  assertFixture(fixture)
  const evaluation = structuredClone(await readOwnedEvaluation(api, fixture, v1))
  const statistics = await readEvaluationStatistics(api, fixture)
  const choice = fixture.items[2]
  const changed = {
    ...choice.body, categoryId: fixture.alternateCategory.id,
    itemName: `${fixture.marker}-CHOICE-CHANGED`, evaluationType: 'MULTIPLE',
    options: ['UNSATISFIED', 'SATISFIED', 'FOLLOW_UP'], maxScore: 70, required: true, sortNo: 2
  }
  await readEvaluationConfig(api, fixture, choice)
  data(await api.putBusiness(`/after-sales/modeling/evaluation-item/update?id=${choice.id}`, changed), 'change item definition')
  choice.body = changed
  const updated = await readEvaluationConfig(api, fixture, choice)
  assert.equal(updated.itemName, changed.itemName)
  assert.equal(updated.evaluationType, changed.evaluationType)
  assert.deepEqual(parsedOptions(updated.optionsJson, updated.evaluationType), changed.options)
  assert.equal(number(updated.maxScore, 'updated maxScore'), 70)
  assert.equal(updated.requiredFlag, true)
  assert.equal(evaluationId(updated.categoryId), fixture.alternateCategory.id)
  const v2 = await createOwnedEvaluationTemplate(api, fixture, 'V2', [
    { itemId: fixture.items[0].id, score: 0, required: true, sortNo: 1 },
    { itemId: choice.id, score: 70, required: true, sortNo: 2 },
    { itemId: fixture.items[1].id, score: 30, required: false, sortNo: 3 },
    { itemId: fixture.items[3].id, score: 0, required: false, sortNo: 4 }
  ])
  assert.notDeepEqual(v2.snapshot.items, v1.snapshot.items, 'new version must actually change complete content')
  assert.deepEqual(evaluationTemplateSnapshot(
    await readEvaluationConfig(api, fixture, v1), fixture, v1), v1.snapshot, 'V1 snapshot drifted')
  assert.deepEqual(await readOwnedEvaluation(api, fixture, v1), evaluation, 'historical evaluation drifted')
  assert.deepEqual(await readEvaluationStatistics(api, fixture), statistics, 'historical statistics drifted')
  return { v1: v1.snapshot, v2: v2.snapshot, evaluation, statistics }
}

export const disableEvaluationConfig = async (api, fixture, resource) => {
  assertFixture(fixture)
  const before = await readEvaluationConfig(api, fixture, resource)
  if (before.status !== 'DISABLED') {
    data(await api.postBusiness(`/after-sales/modeling/status?configType=${resource.type}&id=${resource.id}&enabled=false`),
      'disable owned config')
  }
  const after = await readEvaluationConfig(api, fixture, resource)
  assert.equal(after.status, 'DISABLED')
  return after
}

export const cleanupEvaluationFixtures = async (api, fixture, readSql = runReadOnlySql) => {
  assertFixture(fixture)
  const errors = []
  const attempt = async (label, operation) => {
    try { await operation() } catch (error) {
      errors.push(new Error(`${label}: ${error.message}`, { cause: error }))
    }
  }
  let ticketClosed = !fixture.ticketAttempted
  if (fixture.ticketAttempted) await attempt('owned ticket closure', async () => {
    assert.ok(fixture.ticketId, 'ticket create result uncertain; preserve ticket dependencies')
    let ticket = await readEvaluationTicket(api, fixture)
    if (['PENDING_ACCEPTANCE', 'PROCESSING'].includes(ticket.status)) {
      data(await api.postBusiness('/after-sales/ticket/process', {
        ticketId: fixture.ticketId, targetStatus: 'PENDING_CUSTOMER_VERIFICATION',
        processMethod: fixture.marker, resolution: `${fixture.marker}-CLEANUP`
      }), 'cleanup process')
      ticket = await readEvaluationTicket(api, fixture)
      assert.equal(ticket.status, 'PENDING_CUSTOMER_VERIFICATION')
    }
    if (ticket.status === 'PENDING_CUSTOMER_VERIFICATION') {
      data(await api.postBusiness('/after-sales/ticket/customer-confirm', {
        ticketId: fixture.ticketId, resolved: true, feedback: fixture.marker
      }), 'cleanup customer confirmation')
      ticket = await readEvaluationTicket(api, fixture)
      assert.equal(ticket.status, 'PENDING_EVALUATION')
    }
    if (ticket.status === 'PENDING_EVALUATION') {
      data(await api.postBusiness(`/after-sales/ticket/close?id=${fixture.ticketId}&reason=${encodeURIComponent(fixture.marker)}`),
        'cleanup close')
      ticket = await readEvaluationTicket(api, fixture)
    }
    assert.equal(ticket.status, 'CLOSED', 'owned ticket remains active')
    ticketClosed = true
  })
  if (fixture.profileAttempted) await attempt('owned asset retirement', async () => {
    assert.ok(ticketClosed, 'preserve asset until owned ticket closure is verified')
    assert.ok(fixture.assetId && fixture.customerId, 'profile create result uncertain; preserve material/customer audit')
    const before = await readEvaluationAsset(api, fixture)
    if (before.asset.serviceStatus !== 'RETIRED') {
      data(await api.putBusiness('/after-sales/asset/update-status', {
        id: fixture.assetId, serviceStatus: 'RETIRED', reason: fixture.marker, version: before.asset.version
      }), 'cleanup retire asset')
    }
    assert.equal((await readEvaluationAsset(api, fixture)).asset.serviceStatus, 'RETIRED')
  })
  const ordered = [...fixture.resources].reverse().sort((left, right) => {
    const order = ['EVALUATION_TEMPLATE', 'EVALUATION_ITEM', 'EVALUATION_ITEM_CATEGORY', 'SLA_POLICY', 'CATEGORY']
    return order.indexOf(left.type) - order.indexOf(right.type)
  })
  for (const resource of ordered) {
    if (!ticketClosed) {
      errors.push(new Error(`${resource.type}: preserve dependencies until owned ticket closure is verified`))
      continue
    }
    await attempt(`${resource.type} ${resource.id || resource.body[paths[resource.type][1]]}`, async () => {
      if (resource.pending && !resource.id) {
        const values = list(await api.getBusiness(`${resourcePath(resource)}/list`), resource.type)
        const key = paths[resource.type][1]
        const matches = values.filter((row) => row[key] === resource.body[key])
        if (matches.length === 0 && values.length < 100) return
        assert.equal(matches.length, 1, 'uncertain configuration create cannot establish ownership/absence')
        resource.id = evaluationId(owner(matches[0], resource, fixture).id)
      }
      await disableEvaluationConfig(api, fixture, resource)
    })
  }
  if (fixture.materialAttempted) await attempt('owned material audit', async () => {
    assert.ok(fixture.materialId, 'material create result uncertain; manual ownership reconciliation required')
    materialOwner(data(await api.getBusiness(`/mes/basMaterial/queryById?id=${fixture.materialId}`), 'cleanup material'), fixture)
    if (!fixture.profileAttempted) {
      const readZero = async (statement, label) => {
        const result = await readSql(statement)
        assert.equal(result.available, true, `BLOCKED: ${label}: ${result.reason || 'read evidence unavailable'}`)
        assert.deepEqual(result.rows, [['0']], `${label}: expected exact zero`)
      }
      await readZero(`SELECT COUNT(*) FROM after_sales_customer_asset
        WHERE tenant_id=1 AND deleted=0 AND material_id='${evaluationId(fixture.materialId)}'`,
      'unused material asset references')
      await readZero(`SELECT COUNT(*) FROM mes_stk_inventory
        WHERE tenant_id=1 AND deleted=0 AND material_id='${fixture.materialId}'`,
      'unused material raw inventory')
      data(await api.deleteBusiness(`/mes/basMaterial/delete?id=${fixture.materialId}`), 'delete unused owned material')
      const absent = data(await api.getBusiness(
        `/mes/basMaterial/list?pageNo=1&pageSize=100&id=${fixture.materialId}`), 'deleted owned material')
      assert.equal(number(absent?.total, 'deleted material total'), 0)
      assert.deepEqual(absent.records, [], 'deleted material list still contains records')
      await readZero(`SELECT COUNT(*) FROM mes_bas_material
        WHERE tenant_id=1 AND deleted=0 AND id=${fixture.materialId}`, 'deleted material raw absence')
      fixture.materialDeleted = true
    }
  })
  if (errors.length) throw new AggregateError(errors,
    `${fixture.prefix} cleanup incomplete: ${errors.map((error) => error.message).join('; ')}`)
  return {
    ticketClosed, assetRetired: Boolean(fixture.assetId),
    disabledConfigurations: fixture.resources.filter((resource) => resource.id).map((resource) => resource.id),
    retainedAudit: { customerId: fixture.customerId,
      materialId: fixture.materialDeleted ? undefined : fixture.materialId, ticketId: fixture.ticketId }
  }
}
