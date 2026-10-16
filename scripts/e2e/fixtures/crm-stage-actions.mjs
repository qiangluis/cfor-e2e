import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'

const ACTIONS = Object.freeze(['CREATE_QUOTE', 'CREATE_CONTRACT', 'TRANSFER_OWNER'])
const ACTION_RULE = 'ACTION'
const PAGE_SIZE = 100

const stableId = (value) =>
  (typeof value === 'string' && /^[1-9]\d*$/.test(value)) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)

const sameId = (left, right) => stableId(left) && stableId(right) && String(left) === String(right)

const dataOf = (response, label) => {
  if (!isBusinessSuccess(response)) {
    throw new Error(`${label} business failure: ${JSON.stringify(response).slice(0, 500)}`)
  }
  return response.data
}

const pageOf = (response, label) => {
  const data = dataOf(response, label)
  if (!data || !Array.isArray(data.list) || !Number.isSafeInteger(data.total)) {
    throw new Error(`${label} 未返回合法分页结构`)
  }
  return data
}

const recordCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks ||= []
  caseRecord.checks.push({ name, passed: passed === true, details })
  return passed === true
}

const recordGap = (caseRecord, message) => {
  caseRecord.notes ||= []
  const note = `GAP: ${message}`
  if (!caseRecord.notes.includes(note)) caseRecord.notes.push(note)
  caseRecord.crmStageActionGaps ||= []
  if (!caseRecord.crmStageActionGaps.includes(message)) caseRecord.crmStageActionGaps.push(message)
}

const own = (caseRecord, kind, id, extra = {}) => {
  if (!stableId(id)) throw new Error(`${kind} 未返回稳定 ID`)
  caseRecord.fixtures ||= []
  caseRecord.fixtures.push({ kind, id: String(id), tenantId: 1, owned: true, ...extra })
  return String(id)
}

const requiredContext = ({ api, caseRecord, userId, customerId, tag, type, stages, createBusiness }) => {
  if (!api || !caseRecord || !stableId(userId) || !stableId(customerId) || !tag) {
    throw new Error('BLOCKED: CRM 阶段动作 fixture 缺少 api/caseRecord/userId/customerId/tag')
  }
  if (!stableId(type?.id) || !Array.isArray(stages) || stages.length < 4 ||
      stages.slice(0, 4).some((stage) => !stableId(stage?.id))) {
    throw new Error('BLOCKED: CRM 阶段动作 fixture 需要专属状态组和至少四个专属阶段')
  }
  if (typeof createBusiness !== 'function') {
    throw new Error('BLOCKED: 请由主线程注入 createBusiness({ api, caseRecord, userId, customerId, tag, type, stages, stageId })')
  }
}

async function readDepartmentId (api, userId) {
  const permission = dataOf(await api.getBusiness('/system/auth/get-permission-info'), 'CRM 当前权限')
  const identity = permission?.user
  if (sameId(identity?.id, userId) && stableId(identity?.deptId)) {
    return String(identity.deptId)
  }
  const departments = dataOf(await api.getBusiness('/system/dept/list'), 'CRM 当前租户部门列表')
  const department = (Array.isArray(departments) ? departments : []).find((row) =>
    stableId(row?.id) && (row?.status === undefined || Number(row.status) === 0))
  return department ? String(department.id) : null
}

async function createRule (api, caseRecord, { typeId, stageId, tag, deptId, actions = [] }) {
  const response = await api.postBusiness('/crm/business-stage-rule/create', {
    statusGroupId: typeId,
    statusId: stageId,
    versionNo: 1,
    status: 1,
    remark: `${tag}-${stageId}`,
    applicableOrgIds: [String(deptId)],
    items: actions.map((action, index) => ({
      ruleType: ACTION_RULE,
      fieldCode: action,
      compareOperator: 'EQ',
      compareValue: action,
      sort: index + 1,
      remark: tag
    }))
  })
  return own(caseRecord, 'crm-business-stage-rule', dataOf(response, '创建专属阶段动作规则'), { tag, stageId })
}

async function createBusinessAtStage (createBusiness, api, caseRecord, context, stage, suffix) {
  const created = await createBusiness({
    api,
    caseRecord,
    userId: context.userId,
    customerId: context.customerId,
    tag: `${context.tag}-${suffix}`,
    type: context.type,
    stages: context.stages,
    stageId: stage.id
  })
  const id = String(created?.id ?? created?.businessId ?? created)
  if (!stableId(id)) throw new Error(`专属商机 ${suffix} 创建后没有稳定 ID`)
  context.businessIds.push(own(caseRecord, 'crm-business-stage-action', id, { tag: context.tag, suffix }))
  const initialStageId = created?.detail?.statusId ?? created?.statusId
  if (!sameId(initialStageId, stage.id)) {
    await api.putBusiness('/crm/business/update-status', { id, statusId: stage.id })
  }
  const detail = dataOf(await api.getBusiness(`/crm/business/get?id=${encodeURIComponent(id)}`),
    `回读专属商机 ${suffix}`)
  recordCheck(caseRecord, `CRM-BASE-005 ${suffix} 商机正式回读专属阶段`,
    sameId(detail.id, id) && sameId(detail.customerId, context.customerId) &&
    sameId(detail.ownerUserId, context.userId) && sameId(detail.statusTypeId, context.type.id) &&
    sameId(detail.statusId, stage.id), JSON.stringify({ id, stageId: detail.statusId }))
  return { id, detail }
}

async function expectRejection (api, caseRecord, { method, path, body, name, message }) {
  const response = await api.request(method, path, body)
  const passed = matchesExpectedBusinessRejection(response, { codes: response?.code, message })
  recordCheck(caseRecord, name, passed, `code=${response?.code}, msg=${response?.msg || response?.message || ''}`)
  return response
}

async function transfer (api, caseRecord, businessId, newOwnerUserId, name) {
  const response = await api.putBusiness('/crm/business/transfer', {
    id: businessId,
    newOwnerUserId,
    // Keep the original owner as a write collaborator so finally can clean up safely.
    oldOwnerPermissionLevel: 3
  })
  const detail = dataOf(await api.getBusiness(`/crm/business/get?id=${encodeURIComponent(businessId)}`), `${name} 后商机`)
  recordCheck(caseRecord, name, sameId(detail.ownerUserId, newOwnerUserId),
    `businessId=${businessId}, ownerUserId=${detail.ownerUserId}`)
  return detail
}

/**
 * Verify CRM-BASE-005 action rules using only the caller's owned stage group.
 * The caller injects business creation because the main CRM suite owns that helper.
 */
export async function runCrmStageActions ({
  api,
  caseRecord,
  userId,
  customerId,
  tag,
  type,
  stages,
  createBusiness,
  alternateUserId
}) {
  requiredContext({ api, caseRecord, userId, customerId, tag, type, stages, createBusiness })
  const context = { api, caseRecord, userId: String(userId), customerId: String(customerId), tag,
    type, stages, businessIds: [], ruleIds: [] }
  let otherUserId = stableId(alternateUserId) ? String(alternateUserId) : null

  try {
    const catalog = dataOf(await api.getBusiness('/crm/business-stage-rule/action-catalog'), 'CRM 动作目录')
    recordCheck(caseRecord, '阶段动作目录包含 CREATE_QUOTE/CREATE_CONTRACT/TRANSFER_OWNER',
      Array.isArray(catalog) && ACTIONS.every((code) => catalog.some((row) => row?.code === code && row?.name)) &&
      new Set(catalog.map((row) => row?.code)).size === catalog.length, JSON.stringify(catalog))

    const departmentId = await readDepartmentId(api, userId)
    if (!departmentId) {
      recordGap(caseRecord, '当前登录身份没有可验证的合法 deptId，不能安全创建 applicableOrgIds 非空的专属规则')
      return { partial: true, gaps: caseRecord.crmStageActionGaps }
    }
    if (!otherUserId) {
      const users = dataOf(await api.getBusiness('/system/user/simple-list'), 'CRM 用户列表')
      const other = users.find((user) => stableId(user?.id) && !sameId(user.id, userId))
      otherUserId = other ? String(other.id) : null
    }
    if (!otherUserId) recordGap(caseRecord, '当前租户没有第二个可用负责人，转移允许/拒绝无法安全构造')

    const [noActionStage, quoteStage, transferAllowedStage, transferDeniedStage] = stages
    const noActionBusiness = await createBusinessAtStage(createBusiness, api, caseRecord, context,
      noActionStage, 'NO-ACTION')
    const noActionRule = await createRule(api, caseRecord, {
      typeId: type.id, stageId: noActionStage.id, tag, deptId: departmentId, actions: []
    })
    context.ruleIds.push(noActionRule)
    const pageAfterNoAction = pageOf(await api.getBusiness(
      `/crm/business-stage-rule/page?pageNo=1&pageSize=${PAGE_SIZE}&statusGroupId=${encodeURIComponent(type.id)}`),
    'CRM 阶段规则分页')
    const ownRule = pageAfterNoAction.list.find((row) => sameId(row.id, noActionRule))
    recordCheck(caseRecord, '阶段规则分页一次性返回 items/applicableOrgIds 且组织分配合法非空',
      Boolean(ownRule) && Array.isArray(ownRule.items) && Array.isArray(ownRule.applicableOrgIds) &&
      ownRule.applicableOrgIds.length > 0 && ownRule.applicableOrgIds.every(stableId) &&
      ownRule.applicableOrgIds.some((id) => sameId(id, departmentId)), JSON.stringify(ownRule))

    if (otherUserId) {
      await transfer(api, caseRecord, noActionBusiness.id, otherUserId,
        '未配置 ACTION 规则时转移负责人不受限制')
    }

    const transferAllowedRule = await createRule(api, caseRecord, {
      typeId: type.id, stageId: transferAllowedStage.id, tag, deptId: departmentId,
      actions: ['TRANSFER_OWNER']
    })
    context.ruleIds.push(transferAllowedRule)
    const transferAllowedBusiness = await createBusinessAtStage(createBusiness, api, caseRecord, context,
      transferAllowedStage, 'TRANSFER-ALLOWED')
    if (otherUserId) {
      await transfer(api, caseRecord, transferAllowedBusiness.id, otherUserId,
        'TRANSFER_OWNER 白名单允许时正式转移负责人')
    }

    const transferDeniedRule = await createRule(api, caseRecord, {
      typeId: type.id, stageId: transferDeniedStage.id, tag, deptId: departmentId,
      actions: ['CREATE_QUOTE']
    })
    context.ruleIds.push(transferDeniedRule)
    const transferDeniedBusiness = await createBusinessAtStage(createBusiness, api, caseRecord, context,
      transferDeniedStage, 'TRANSFER-DENIED')
    if (otherUserId) {
      await expectRejection(api, caseRecord, {
        method: 'PUT', path: '/crm/business/transfer',
        body: { id: transferDeniedBusiness.id, newOwnerUserId: otherUserId, oldOwnerPermissionLevel: 3 },
        name: 'TRANSFER_OWNER 不在 ACTION 白名单时正式拒绝', message: /动作|允许|白名单|转移负责人/
      })
      const unchanged = dataOf(await api.getBusiness(
        `/crm/business/get?id=${encodeURIComponent(transferDeniedBusiness.id)}`), '转移拒绝后商机')
      recordCheck(caseRecord, '转移负责人拒绝后负责人保持不变', sameId(unchanged.ownerUserId, userId),
        `businessId=${transferDeniedBusiness.id}, ownerUserId=${unchanged.ownerUserId}`)
    }

    const quoteAllowedRule = await createRule(api, caseRecord, {
      typeId: type.id, stageId: quoteStage.id, tag, deptId: departmentId, actions: ['CREATE_QUOTE']
    })
    context.ruleIds.push(quoteAllowedRule)
    const quoteBusiness = await createBusinessAtStage(createBusiness, api, caseRecord, context,
      quoteStage, 'QUOTE')
    const quotePayload = {
      subject: `${tag}-QUOTE`, customerId: String(customerId), businessId: quoteBusiness.id,
      quoteMethod: '口头报价', quoteDate: new Date().toISOString().slice(0, 10),
      ownerUserId: String(userId), remark: tag, products: []
    }
    const qualificationRejected = await expectRejection(api, caseRecord, {
      method: 'POST', path: '/crm/quote/create', body: quotePayload,
      name: '报价创建先经过真实报价资格校验', message: /报价资格|已通过/
    })
    if (qualificationRejected?.msg && /报价资格|已通过/.test(String(qualificationRejected.msg))) {
      recordGap(caseRecord,
        'CRM 当前后端没有报价资格申请/审批正式 API；报价动作白名单允许/拒绝无法在不伪造“已通过”的前提下到达 ACTION 校验')
    } else {
      recordGap(caseRecord, '报价资格拒绝未返回明确的报价资格业务错误，无法安全判定 ACTION 白名单顺序')
    }

    const rules = pageOf(await api.getBusiness(
      `/crm/business-stage-rule/page?pageNo=1&pageSize=${PAGE_SIZE}&statusGroupId=${encodeURIComponent(type.id)}`),
    'CRM 阶段规则最终分页')
    recordCheck(caseRecord, '阶段规则分页所有返回行均一次性带 items/applicableOrgIds',
      rules.list.every((row) => Array.isArray(row.items) && Array.isArray(row.applicableOrgIds)),
      `rows=${rules.list.length}, total=${rules.total}`)
    return { partial: caseRecord.crmStageActionGaps?.length > 0, gaps: caseRecord.crmStageActionGaps || [] }
  } finally {
    for (const id of [...context.ruleIds].reverse()) {
      try { await api.deleteBusiness(`/crm/business-stage-rule/delete?id=${encodeURIComponent(id)}`) } catch (error) {
        recordGap(caseRecord, `专属阶段规则 ${id} 清理失败：${error.message}`)
      }
    }
    for (const id of [...context.businessIds].reverse()) {
      try { await api.deleteBusiness(`/crm/business/delete?id=${encodeURIComponent(id)}`) } catch (error) {
        recordGap(caseRecord, `专属商机 ${id} 清理失败：${error.message}`)
      }
    }
  }
}

export const crmStageActionCodes = ACTIONS

export const crmStageActionInternals = Object.freeze({
  stableId,
  sameId,
  pageOf,
  requiredContext
})
