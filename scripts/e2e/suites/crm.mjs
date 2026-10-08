import { assertBusinessSuccess, isBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'

export const cases = [
  'CRM-BASE-001',
  'CRM-BASE-002',
  'CRM-BASE-003',
  'CRM-BASE-004',
  'CRM-BASE-005',
  'CRM-BASE-006',
  'CRM-BASE-007'
]

export const followUpRuleRoute = '/settings/crm/follow-up-type-rule'
export const followUpRuleReadySelector = '.el-table__header-wrapper th:has-text("允许的附件类型")'

export function followUpRuleRows(response) {
  if (!Array.isArray(response?.data)) {
    throw new Error('CRM 跟进方式规则响应 data 必须为数组，不能以空对象冒充规则列表')
  }
  return response.data
}

// CRM-BASE-001/003 moved to full write-side acceptance; remaining cases stay read-only.
export const crmReadOnlyCases = ['CRM-BASE-002', 'CRM-BASE-004', 'CRM-BASE-005', 'CRM-BASE-006']
const pageQuery = 'pageNo=1&pageSize=100'
const stableId = (id) =>
  (typeof id === 'string' && /^[1-9]\d*$/.test(id)) ||
  (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
const sameId = (a, b) => stableId(a) && stableId(b) && String(a) === String(b)
const sqlNull = (value) => value == null || String(value).trim().toUpperCase() === 'NULL'
const sqlTrue = (value) => value === true || Number(value) === 1 ||
  (Buffer.isBuffer(value) && value.length > 0 && value[0] === 1) ||
  (typeof value === 'string' && (value.replace(/[\u0000-\u001f]/g, '') === '1' ||
    value.includes('\u0001')))
const checkFact = (record, name, passed, details = '') =>
  record.checks.push({ name, passed: Boolean(passed), details })
const missingFact = (record, message) => record.notes.push(`前置缺失：${message}；保留 PARTIAL`)
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const objectRow = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export const CRM_WRITE_FIXTURE_ENV = 'CFOR_E2E_WRITE_FIXTURES'

export function isCrmWriteFixturesEnabled (env = process.env) {
  return env[CRM_WRITE_FIXTURE_ENV] === 'true'
}

const crmTag = () =>
  `E2E-CRM-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
function firstStageWithoutRule (stages, rules, excluded = []) {
  const used = new Set((rules || []).map((rule) => String(rule.statusId)))
  return stages.find((stage) => !used.has(String(stage.id)) &&
    !excluded.some((id) => sameId(id, stage.id)))
}
const crmDate = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const crmDateTime = (date = new Date()) => `${crmDate(date)}T00:00:00`

const crmId = (response, label) => {
  const id = assertBusinessSuccess(response, label)?.data
  if (!stableId(id)) throw new Error(`${label} 未返回稳定 ID`)
  return String(id)
}

const crmData = (response, label) => assertBusinessSuccess(response, label)?.data

async function crmWriteFact (caseRecord, name, passed, details = '') {
  checkFact(caseRecord, name, passed, details)
}

async function crmWriteDetail (api, path, label) {
  const data = crmData(await api.getBusiness(path), label)
  if (!objectRow(data) || !stableId(data.id)) {
    throw new Error(`${label} 未返回可复核详情`)
  }
  return data
}

async function crmWritePage (api, path, label) {
  const data = crmData(await api.getBusiness(path), label)
  if (!objectRow(data) || !Array.isArray(data.list) ||
      !Number.isSafeInteger(data.total) || data.total < 0) {
    throw new Error(`${label} 分页结构无效`)
  }
  return data
}

async function crmWriteArray (api, path, label) {
  const data = crmData(await api.getBusiness(path), label)
  if (!Array.isArray(data)) throw new Error(`${label} 必须返回数组`)
  return data
}

async function expectCrmRejection (api, method, path, body, expected, caseRecord, label) {
  const response = await api.request(method, path, method === 'DELETE' ? undefined : body)
  const message = String(response?.msg || response?.message || '')
  const patterns = Array.isArray(expected) ? expected : [expected]
  const passed = objectRow(response) && Number.isInteger(response.code) &&
    !isBusinessSuccess(response) && response.code !== 500 &&
    response.code !== 401 && response.code !== 403 &&
    !/SQL|Exception|系统异常|服务器异常/i.test(message) &&
    patterns.some((pattern) => pattern.test(message))
  await crmWriteFact(caseRecord, label, passed,
    `code=${response?.code}, message=${message.slice(0, 240)}`)
  caseRecord.notes.push(`${label}：${message.slice(0, 160)}`)
  return response
}

async function crmSql (caseRecord, stage, sql) {
  const evidence = await runReadOnlySql(sql)
  if (!evidence.available) throw new Error(`BLOCKED: ${evidence.reason}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, ...evidence }]
  return evidence.rows
}

const crmSqlId = (id) => {
  if (!stableId(id)) throw new Error('非法 CRM SQL ID')
  return `'${id}'`
}

const crmOwned = (caseRecord, kind, id, extra = {}) => {
  const fixture = { kind, id: String(id), tenantId: 1, owned: true, ...extra }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  return fixture
}

function crmCatalogEvidence (caseId, caseRecord, verified = []) {
  const catalog = JSON.parse(
    fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8')
  )
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === caseId)
  if (!definition) throw new Error(`缺少原 catalog 案例 ${caseId}`)
  caseRecord.catalogAssertions = (definition.assertions || []).map((assertion, index) => ({
    index, assertion, status: verified.includes(index) ? 'VERIFIED' : 'GAP'
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed)
  caseRecord.notes.push(`原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`)
}

export function crmReadRows(response, endpoint, paged = true) {
  const data = assertBusinessSuccess(response, endpoint)?.data
  const rows = paged ? data?.list ?? data?.records : data
  if (!Array.isArray(rows) ||
      (paged && (!Number.isSafeInteger(data?.total) || data.total < rows.length)) ||
      rows.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${endpoint} 列表结构无效，不能以畸形响应冒充空集`)
  }
  return rows
}

async function crmPage(api, endpoint, record, extra = '') {
  const url = `${endpoint}?${pageQuery}${extra ? `&${extra}` : ''}`
  const response = await api.getBusiness(url)
  const rows = crmReadRows(response, url)
  checkFact(record, `${endpoint} 真实分页契约`, rows.every((row) => stableId(row.id)),
    `sample=${rows.length}, total=${response.data.total}, pageNo=1`)
  if (response.data.total > rows.length) record.notes.push(`${endpoint} 仅检查首页样本，不宣称全量覆盖`)
  if (!rows.length) missingFact(record, `${endpoint} 当前可见范围无正式样本`)
  return rows
}

async function crmList(api, url) {
  return crmReadRows(await api.getBusiness(url), url, false)
}

async function crmDetail(api, endpoint, id, record) {
  if (!stableId(id)) throw new Error(`${endpoint} 无有效、无精度损失的 ID`)
  const url = `${endpoint}?id=${encodeURIComponent(id)}`
  const data = assertBusinessSuccess(await api.getBusiness(url), url)?.data
  if (data == null) {
    missingFact(record, `${endpoint} 样本已不可见/不存在，未验证详情`)
    return null
  }
  if (typeof data !== 'object' || Array.isArray(data) || !stableId(data.id)) {
    throw new Error(`${endpoint} 详情结构无效`)
  }
  checkFact(record, `${endpoint} 详情保留来源字符串 ID`, sameId(data.id, id))
  return data
}

async function crmDictionary(api, type, record) {
  const rows = await crmPage(api, '/system/dict-data/page', record, `dictType=${type}`)
  if (rows.length) {
    checkFact(record, `${type} 稳定编码及启停状态`,
      rows.every((row) => row.dictType === type && typeof row.value === 'string' &&
        row.value.length > 0 && [0, 1].includes(row.status)) &&
      new Set(rows.map((row) => row.value)).size === rows.length)
  }
  if (!rows.some((row) => row.status === 0)) missingFact(record, `${type} 无启用字典值`)
  return rows
}

export function crmMenuRoute(menus, component, parent = '') {
  for (const menu of Array.isArray(menus) ? menus : []) {
    const pathname = String(menu?.path || '')
    const route = pathname.startsWith('/') ? pathname :
      [parent.replace(/\/$/, ''), pathname].filter(Boolean).join('/')
    const actual = String(menu?.component || '').replace(/\.vue(?=\?|$)/, '')
    if (!route.includes('/__legacy__/') && actual === component) {
      return `/${route.replace(/^\/+/, '')}`
    }
    const child = crmMenuRoute(menu?.children, component, route)
    if (child) return child
  }
  return null
}

export const crmReadOnlyViews = {
  'CRM-BASE-001': {
    component: 'crm/business/status/index',
    selector: '.el-table th:has-text("商机阶段组名")'
  },
  'CRM-BASE-002': {
    component: 'crm/jixu/privatePool/index?archive=all',
    selector: '.el-table th:has-text("客户名称")'
  },
  'CRM-BASE-003': {
    component: 'crm/config/customerTag/index',
    selector: '.el-table th:has-text("标签编码")'
  },
  'CRM-BASE-004': {
    component: 'crm/customer/poolConfig/index',
    selector: '.el-form-item:has-text("客户公海规则设置") .el-radio-group'
  },
  'CRM-BASE-005': {
    component: 'crm/config/businessStageRule/index',
    selector: '.el-table th:has-text("允许动作")'
  },
  'CRM-BASE-006': {
    component: 'crm/jixu/chance/index?tab=all',
    selector: '.el-table th:has-text("执行状态")'
  }
}

export async function runCrmReadOnlyPreconditions({ caseId, api, caseRecord: record }) {
  if (!crmReadOnlyCases.includes(caseId)) throw new Error(`非只读目标案例：${caseId}`)
  if (caseId === 'CRM-BASE-001') {
    for (const type of ['erp_sale_type', 'crm_sales_plan_type', 'crm_customer_intention_level',
      'crm_business_execution_status']) {
      const rows = await crmDictionary(api, type, record)
      if (type === 'crm_business_execution_status' && rows.length) {
        checkFact(record, '执行状态字典不混入赢单/战败/无效终态',
          rows.every((row) => !/赢单|战败|无效/.test(row.label) &&
            !/^(WON|LOST|INVALID)$/i.test(row.value)))
      }
    }
    const groups = await crmPage(api, '/crm/business-status/page', record)
    if (groups[0]) {
      const group = await crmDetail(api, '/crm/business-status/get', groups[0].id, record)
      if (group) {
        if (!Array.isArray(group.statuses)) throw new Error('商机阶段组详情缺少 statuses 数组')
        checkFact(record, '商机阶段仍由独立阶段组/阶段 ID 表达',
          group.statuses.every((stage) => stableId(stage.id)))
        if (!group.statuses.length) missingFact(record, '阶段组中没有可推进阶段')
      }
    }
    const businesses = await crmPage(api, '/crm/business/page', record)
    if (businesses.length) {
      // catalog 口径：赢单/战败只写 end_status，终态商机 execution_status 允许为空；
      // 未结束商机必须有稳定执行编码，且任何情况下都不得把终态写进 execution_status。
      const terminalOnlyInEndStatus = (row) =>
        row.endStatus != null
          ? (row.executionStatus == null || !/^(WON|LOST|INVALID|赢单|战败|无效)$/i.test(row.executionStatus))
          : (typeof row.executionStatus === 'string' && row.executionStatus.length > 0 &&
            !/^(WON|LOST|INVALID|赢单|战败|无效)$/i.test(row.executionStatus))
      checkFact(record, '商机阶段、执行编码与终态保持独立字段',
        businesses.every((row) => stableId(row.statusTypeId) && stableId(row.statusId) &&
          terminalOnlyInEndStatus(row) &&
          (row.endStatus == null || [1, 2, 3].includes(row.endStatus))))
    }
    record.notes.push('未停用共享字典、未新建商机；停用阻断新建与历史可查写侧未验收')
  } else if (caseId === 'CRM-BASE-002') {
    const dictionaries = await crmDictionary(api, 'crm_customer_intention_level', record)
    const rules = await crmPage(api, '/crm/intention-rule/page', record)
    if (rules.length) {
      const dictionaryValues = new Set(dictionaries.map((dict) => dict.value))
      const missingDictionary = rules.filter((row) => !dictionaryValues.has(row.levelCode))
      if (missingDictionary.length) {
        record.notes.push('只读前置发现共享意向规则引用已删除字典值的历史脏数据，不作为通过依据；' +
          '本用例以本轮专属规则写侧断言为准：' +
          missingDictionary.map((row) => `${row.id}/${row.levelCode}`).join(','))
      }
    }
    if (!rules.some((row) => row.status === 1)) missingFact(record, '没有启用的意向规则')
    const customers = await crmPage(api, '/crm/customer/page', record)
    const customer = customers.find((row) => row.intentionLevel)
    if (customer) {
      const detail = await crmDetail(api, '/crm/customer/get', customer.id, record)
      if (detail) checkFact(record, '客户保存 intentionLevel 稳定编码而非客商等级',
        detail.intentionLevel === customer.intentionLevel)
      const follows = await crmPage(api, '/crm/follow-up-record/page', record,
        `bizType=2&bizId=${encodeURIComponent(customer.id)}`)
      const sample = follows.find((row) => row.intentionLevelCode && row.intentionRuleVersion &&
        row.plannedFollowDate)
      if (sample) {
        const follow = await crmDetail(api, '/crm/follow-up-record/get', sample.id, record)
        if (follow) checkFact(record, '正式跟进回读生成时意向/版本/计划日期快照',
          sameId(follow.bizId, customer.id) && follow.bizType === 2 &&
          follow.intentionLevelCode === sample.intentionLevelCode &&
          follow.intentionRuleVersion === sample.intentionRuleVersion &&
          follow.plannedFollowDate === sample.plannedFollowDate)
      } else missingFact(record, '无带完整意向快照的正式跟进记录')
    } else missingFact(record, '无保存意向编码的正式客户，跟进快照未执行')
    record.notes.push('未创建跟进或唤醒任务、未改规则；历史快照不与当前规则版本强行相等')
  } else if (caseId === 'CRM-BASE-003') {
    const definitions = await crmPage(api, '/crm/customer-tag/definition/page', record)
    if (definitions.length) {
      checkFact(record, '标签定义区分 SYSTEM/MANUAL 并保存稳定编码',
        definitions.every((row) => typeof row.code === 'string' && row.code &&
          ['SYSTEM', 'MANUAL'].includes(row.tagType) && [0, 1].includes(row.status)))
      await crmDetail(api, '/crm/customer-tag/definition/get', definitions[0].id, record)
    }
    const customers = await crmPage(api, '/crm/customer/page', record)
    if (customers[0]) {
      const id = customers[0].id
      const relations = await crmList(api, `/crm/customer-tag/relation/list?customerId=${encodeURIComponent(id)}`)
      const logs = await crmList(api, `/crm/customer-tag/relation/change-log?customerId=${encodeURIComponent(id)}`)
      if (relations.length) checkFact(record, '客户标签关系保留来源与审计依据',
        relations.every((row) => sameId(row.customerId, id) && stableId(row.tagId) &&
          ['SYSTEM', 'MANUAL'].includes(row.sourceType)) &&
        new Set(relations.map((row) => String(row.tagId))).size === relations.length)
      else missingFact(record, '所选客户没有标签关系，未验证多值/幂等')
      if (logs.length) checkFact(record, '标签变更审计包含动作、来源、操作人与时间',
        logs.every((row) => sameId(row.customerId, id) && ['ADD', 'REMOVE'].includes(row.action) &&
          ['SYSTEM', 'MANUAL'].includes(row.sourceType) && stableId(row.operatorUserId) && row.operateTime))
      else missingFact(record, '所选客户无标签变更审计')
    }
    record.notes.push('未增删任何标签；人工不能改系统标签、重复添加幂等及历史单据标签快照未验收')
  } else if (caseId === 'CRM-BASE-004') {
    const url = '/crm/customer-pool-config/get'
    const config = assertBusinessSuccess(await api.getBusiness(url), url)?.data
    if (config == null) missingFact(record, '公海规则未配置')
    else {
      if (typeof config !== 'object' || typeof config.enabled !== 'boolean') {
        throw new Error('公海配置缺少 enabled 布尔字段')
      }
      checkFact(record, '公海配置返回真实启用标记', true, `enabled=${config.enabled}`)
      if (!config.enabled) missingFact(record, '公海自动入池未启用')
      else checkFact(record, '启用的公海配置包含未跟进/未成交天数',
        Number.isInteger(config.contactExpireDays) && config.contactExpireDays > 0 &&
        Number.isInteger(config.dealExpireDays) && config.dealExpireDays > 0)
    }
    const customers = await crmPage(api, '/crm/customer/page', record)
    await crmPage(api, '/crm/customer/put-pool-remind-page', record)
    if (customers[0]) {
      const id = customers[0].id
      const history = await crmList(api, `/crm/customer-cultivation/history?customerId=${encodeURIComponent(id)}`)
      const put = history.filter((row) => row.operationType === 'POOL_PUT')
      if (put.length) checkFact(record, '公海历史记录关联客户并保留操作人与时间',
        put.every((row) => sameId(row.customerId, id) && row.operateTime && row.operationType === 'POOL_PUT'))
      else missingFact(record, '所选客户无 POOL_PUT 正式历史')
    }
    record.notes.push('BLOCKED：经营历史 RespVO 未暴露 recycleReason/ruleVersion/businessKey，不能读侧证明幂等留痕；未执行回收 Job、工作日边界或跟进竞态')
  } else if (caseId === 'CRM-BASE-005') {
    const catalog = await crmList(api, '/crm/business-stage-rule/action-catalog')
    checkFact(record, '阶段动作目录包含受控创建报价/合同/转移负责人',
      ['CREATE_QUOTE', 'CREATE_CONTRACT', 'TRANSFER_OWNER'].every((code) =>
        catalog.some((row) => row.code === code && row.name)) &&
      new Set(catalog.map((row) => row.code)).size === catalog.length)
    const rules = await crmPage(api, '/crm/business-stage-rule/page', record)
    for (const rule of rules) {
      if (!Array.isArray(rule.items) || !Array.isArray(rule.applicableOrgIds)) {
        throw new Error('阶段规则分页缺少 items/applicableOrgIds，不能冒充完整规则')
      }
      checkFact(record, '阶段规则分页一次性返回规则项、组织和版本',
        stableId(rule.statusGroupId) && stableId(rule.statusId) &&
        Number.isInteger(rule.versionNo) && rule.versionNo > 0 &&
        rule.applicableOrgIds.every(stableId) && rule.items.every((item) =>
          ['ENTER', 'EXIT', 'REQUIRED', 'ACTION'].includes(item.ruleType) &&
          (item.ruleType !== 'ACTION' || catalog.some((row) => row.code === item.compareValue))))
    }
    if (rules[0]) await crmDetail(api, '/crm/business-stage-rule/get', rules[0].id, record)
    await crmPage(api, '/crm/business/page', record)
    record.notes.push('未保存规则、未推进商机；必填/进入条件拒绝、退出审计与动作组织强制校验必须隔离业务夹具')
  } else if (caseId === 'CRM-BASE-006') {
    await crmDictionary(api, 'crm_business_execution_status', record)
    const rows = await crmPage(api, '/crm/business/page', record)
    if (!rows.some((row) => [1, 2, 3].includes(row.endStatus))) missingFact(record, '无终态商机')
    if (!rows.some((row) => row.endStatus == null)) missingFact(record, '无非终态商机')
    if (rows[0]) {
      const id = rows[0].id
      await crmDetail(api, '/crm/business/get', id, record)
      const logs = await crmList(api, `/crm/business/execution-status-logs?businessId=${encodeURIComponent(id)}`)
      if (logs.length) checkFact(record, '执行状态日志保留前后状态、来源、操作人与时间',
        logs.every((row) => sameId(row.businessId, id) && typeof row.fromStatus === 'string' &&
          typeof row.toStatus === 'string' && row.fromStatus !== row.toStatus &&
          ['MANUAL', 'RULE', 'REOPEN', 'IMPORT', 'API'].includes(row.changeSource) &&
          stableId(row.operatorId) && row.operateTime))
      else missingFact(record, '所选商机无执行状态日志')
    }
    record.notes.push('未改执行状态、未受控重开；终态拒绝、无效/同状态拒绝及详情重开入口必须有正式前置再验收')
  }
  const note = '仅完成该案例可安全执行的领域只读前置；正式写侧及状态转移未执行，不是完整验收'
  record.notes.push(note)
  return { partial: true, note }
}

async function readFirstUserAndStatuses (api) {
  const users = await crmWriteArray(api, '/system/user/simple-list', '系统用户')
  const user = users.find((row) => stableId(row.id))
  if (!user) throw new Error('BLOCKED: 当前租户没有可用负责人')
  const type = (await crmWriteArray(api, '/crm/business-status/type-simple-list', '商机状态组'))[0]
  if (!stableId(type?.id)) throw new Error('BLOCKED: 缺少商机状态组')
  const stages = await crmWriteArray(api,
    `/crm/business-status/status-simple-list?typeId=${encodeURIComponent(type.id)}`,
    '商机阶段')
  if (stages.length < 2) throw new Error('BLOCKED: 商机阶段不足两阶段')
  return { user, type, stages }
}

async function createCrmCustomerFixture (api, caseRecord, userId, tag, extra = {}) {
  const id = crmId(await api.postBusiness('/crm/customer/create', {
    name: tag, ownerUserId: userId, remark: tag, ...extra
  }), '创建专属 CRM 客户')
  crmOwned(caseRecord, 'crm-customer', id, { tag })
  const detail = await crmWriteDetail(api, `/crm/customer/get?id=${id}`, '专属 CRM 客户详情')
  await crmWriteFact(caseRecord, '专属 CRM 客户正式回读所有权与名称',
    detail.name === tag && String(detail.ownerUserId) === String(userId), `customerId=${id}`)
  return detail
}

async function createCrmBusinessFixture (api, caseRecord, userId, tag, { terminal = false } = {}) {
  const { type, stages } = await readFirstUserAndStatuses(api)
  const id = crmId(await api.postBusiness('/crm/business/create', {
    name: tag, customerId: caseRecord._customerId, ownerUserId: userId,
    statusTypeId: type.id, statusId: stages[0].id, discountPercent: 0,
    quoteQualificationStatus: '未申请', remark: tag,
    products: caseRecord._businessProduct ? [caseRecord._businessProduct] : undefined
  }), '创建专属商机')
  crmOwned(caseRecord, 'crm-business', id, { tag })
  let detail = await crmWriteDetail(api, `/crm/business/get?id=${id}`, '专属商机详情')
  await crmWriteFact(caseRecord, '专属商机创建回读客户、负责人和首阶段',
    sameId(detail.customerId, caseRecord._customerId) &&
    String(detail.ownerUserId) === String(userId) &&
    sameId(detail.statusTypeId, type.id) && sameId(detail.statusId, stages[0].id),
    `businessId=${id}, customerId=${detail.customerId}`)
  if (terminal) {
    await api.putBusiness('/crm/business/update-status', { id, endStatus: 1 })
    detail = await crmWriteDetail(api, `/crm/business/get?id=${id}`, '专属终态商机详情')
    await crmWriteFact(caseRecord, '专属商机终态只写 endStatus 且 executionStatus 不混入终态',
      Number(detail.endStatus) === 1 &&
      !/^(WON|LOST|INVALID|赢单|战败|无效)$/i.test(String(detail.executionStatus || '')),
      `businessId=${id}, endStatus=${detail.endStatus}, executionStatus=${detail.executionStatus}`)
  }
  return { id, detail, type, stages }
}

async function crmCase001 (context, api, userId) {
  const { caseId, caseRecord } = context
  const tag = crmTag()
  const dictValue = `${tag}-STATUS`
  let dictId
  let customerId
  let businessId
  let secondBusinessId
  try {
    const types = await crmWritePage(api,
      '/system/dict-type/page?pageNo=1&pageSize=100', '字典类型')
    for (const dictType of ['erp_sale_type', 'crm_sales_plan_type',
      'crm_customer_intention_level', 'crm_business_execution_status']) {
      await crmWriteFact(caseRecord, `字典类型 ${dictType} 使用 system_dict_type 主档`,
        types.list.some((row) => row.type === dictType && stableId(row.id)), `type=${dictType}`)
      const data = await crmWritePage(api,
        `/system/dict-data/page?pageNo=1&pageSize=100&dictType=${dictType}`, `${dictType} 字典数据`)
      await crmWriteFact(caseRecord, `${dictType} 字典值使用 system_dict_data 且编码稳定`,
        data.list.length > 0 && data.list.every((row) =>
          row.dictType === dictType && nonEmpty(row.value) &&
          new Set(data.list.map((item) => item.value)).size === data.list.length),
        `rows=${data.list.length}`)
    }
    dictId = crmId(await api.postBusiness('/system/dict-data/create', {
      dictType: 'crm_business_execution_status', value: dictValue, label: tag,
      status: 0, sort: 9999, colorType: 'default', cssClass: '', remark: tag
    }), '创建专属商机执行状态字典值')
    crmOwned(caseRecord, 'crm-execution-status-dict', dictId, { tag, value: dictValue })
    const customer = await createCrmCustomerFixture(api, caseRecord, userId, tag)
    customerId = customer.id
    caseRecord._customerId = customer.id
    const business = await createCrmBusinessFixture(api, caseRecord, userId, tag)
    businessId = business.id
    const secondBusiness = await createCrmBusinessFixture(api, caseRecord, userId, `${tag}-SECOND`)
    secondBusinessId = secondBusiness.id
    await api.putBusiness('/crm/business/update-execution-status', {
      id: businessId, executionStatus: dictValue, reason: tag, source: 'MANUAL'
    })
    const updated = await crmWriteDetail(api, `/crm/business/get?id=${businessId}`, '专属商机执行状态')
    await crmWriteFact(caseRecord, '专属商机保存执行状态稳定字典编码',
      updated.executionStatus === dictValue, `businessId=${businessId}, executionStatus=${updated.executionStatus}`)
    await api.putBusiness('/system/dict-data/update', {
      id: dictId, dictType: 'crm_business_execution_status', value: dictValue, label: tag,
      status: 1, sort: 9999, colorType: 'default', cssClass: '', remark: tag
    })
    await expectCrmRejection(api, 'PUT', '/crm/business/update-execution-status',
      { id: secondBusinessId, executionStatus: dictValue, reason: tag, source: 'MANUAL' },
      /禁用|停用|无效|不存在|状态/, caseRecord, '停用专属执行状态后拒绝再次用于新变更')
    const historical = await crmWriteDetail(api,
      `/crm/business/get?id=${businessId}`, '停用后历史商机')
    await crmWriteFact(caseRecord, '停用字典值后历史商机仍可查询且快照不变',
      historical.executionStatus === dictValue, `businessId=${businessId}`)
    await crmWriteFact(caseRecord, '专属商机仍保留独立阶段组/阶段稳定 ID',
      stableId(historical.statusTypeId) && stableId(historical.statusId),
      `type=${historical.statusTypeId}, stage=${historical.statusId}`)
    const dbRows = await crmSql(caseRecord, 'crm-base-001-dictionary-and-business', `
      SELECT 'dict_type', COUNT(*) FROM system_dict_type WHERE deleted=0
        AND type IN ('erp_sale_type','crm_sales_plan_type','crm_customer_intention_level','crm_business_execution_status');
      SELECT 'dict_data', COUNT(*) FROM system_dict_data WHERE deleted=0
        AND dict_type IN ('erp_sale_type','crm_sales_plan_type','crm_customer_intention_level','crm_business_execution_status');
      SELECT 'stage_type', COUNT(*) FROM crm_business_status_type WHERE tenant_id=1 AND deleted=0;
      SELECT 'stage', COUNT(*) FROM crm_business_status WHERE tenant_id=1 AND deleted=0;
      SELECT 'business', id, status_type_id, status_id, execution_status, end_status
        FROM crm_business WHERE tenant_id=1 AND deleted=0 AND id=${crmSqlId(businessId)}`)
    const count = (name) => Number(dbRows.find((row) => row[0] === name)?.[1])
    const businessRow = dbRows.find((row) => row[0] === 'business')
    await crmWriteFact(caseRecord, '数据库证明四类字典、阶段物理表与专属商机字段口径',
      count('dict_type') >= 4 && count('dict_data') >= 4 && count('stage_type') >= 1 &&
      count('stage') >= 1 && businessRow != null &&
      businessRow[4] === dictValue && sqlNull(businessRow[5]), JSON.stringify(dbRows))
    await crmWriteFact(caseRecord, '终态商机 execution_status 不包含赢单/战败/无效终态',
      !/^(WON|LOST|INVALID)$/.test(String(historical.executionStatus || '')),
      `executionStatus=${historical.executionStatus}`)
    crmCatalogEvidence(caseId, caseRecord, [0, 1, 2, 3])
  } finally {
    if (secondBusinessId) {
      try { await api.deleteBusiness(`/crm/business/delete?id=${secondBusinessId}`) } catch {}
    }
    if (businessId) {
      try { await api.deleteBusiness(`/crm/business/delete?id=${businessId}`) } catch {}
    }
    if (customerId) {
      try { await api.deleteBusiness(`/crm/customer/delete?id=${customerId}`) } catch {}
    }
  }
}

async function crmCase002 (context, api, userId) {
  const { caseId, caseRecord } = context
  const tag = crmTag()
  let rule
  let customer
  try {
    const ruleId = crmId(await api.postBusiness('/crm/intention-rule/create', {
      levelCode: tag, levelName: tag, dealProbabilityMin: 0, dealProbabilityMax: 5,
      followUpDays: 11, warnDays: 2, recycleGraceDays: 1, versionNo: 1,
      status: 1, remark: tag
    }), '创建专属意向级别规则')
    crmOwned(caseRecord, 'crm-intention-rule', ruleId, { tag })
    rule = await crmWriteDetail(api, `/crm/intention-rule/get?id=${ruleId}`, '专属意向规则')
    await crmWriteFact(caseRecord, '意向规则保存周期、预警、宽限和版本且与客商等级字段分离',
      rule.levelCode === tag && rule.followUpDays === 11 && rule.warnDays === 2 &&
      rule.recycleGraceDays === 1 && rule.versionNo === 1 && rule.status === 1,
      JSON.stringify(rule))
    await expectCrmRejection(api, 'POST', '/crm/customer/create',
      { name: `${tag}-BAD`, ownerUserId: userId, intentionLevel: `${tag}-MISSING` },
      /意向|级别|规则|不存在|禁用|停用/, caseRecord, '不存在意向级别拒绝新建客户')
    customer = await createCrmCustomerFixture(api, caseRecord, userId, tag,
      { intentionLevel: tag })
    await crmWriteFact(caseRecord, '客户保存 intentionLevel 稳定编码而非客商等级',
      customer.intentionLevel === tag, `customerId=${customer.id}, intentionLevel=${customer.intentionLevel}`)
    await crmWriteFact(caseRecord, '客户详情同时保留独立客商引用与意向编码',
      stableId(customer.id) && customer.intentionLevel === tag,
      `customerId=${customer.id}, intentionLevel=${customer.intentionLevel}, ` +
      `partnerId=${customer.partnerId ?? '(详情未暴露，后续以数据库 partner_id 验证)'}`)
    const followBody = {
      bizType: 2, bizId: customer.id, type: 1, content: `${tag} 跟进快照`,
      nextTime: crmDateTime(new Date(Date.now() + 86400000)), remark: tag
    }
    const followId = crmId(await api.postBusiness('/crm/follow-up-record/create', followBody),
      '创建专属正式跟进')
    crmOwned(caseRecord, 'crm-follow-up-record', followId, { tag })
    const follow = await crmWriteDetail(api,
      `/crm/follow-up-record/get?id=${followId}`, '专属正式跟进详情')
    await crmWriteFact(caseRecord, '正式跟进保存生成时意向/版本/计划日期快照',
      sameId(follow.bizId, customer.id) && follow.bizType === 2 &&
      follow.intentionLevelCode === tag && follow.intentionRuleVersion === 1 &&
      nonEmpty(follow.plannedFollowDate), JSON.stringify({
        id: follow.id, bizId: follow.bizId, level: follow.intentionLevelCode,
        version: follow.intentionRuleVersion, planned: follow.plannedFollowDate
      }))
    const wakeAt = new Date(Date.now() + 2 * 86400000)
    const cultivationId = crmId(await api.postBusiness('/crm/customer-cultivation/save', {
      customerId: customer.id,
      reason: `${tag} 唤醒规则快照`,
      reasonDetail: tag,
      wakeAt: crmDateTime(wakeAt),
      wakeMethod: '电话',
      wakeGoal: `${tag} 规则快照验收`,
      remark: tag
    }), '创建专属客户培育计划')
    crmOwned(caseRecord, 'crm-customer-cultivation', cultivationId, { tag })
    const wakeTasks = await crmWritePage(api,
      `/crm/customer-cultivation/wake-task/page?pageNo=1&pageSize=100&customerId=${encodeURIComponent(customer.id)}`,
      '专属客户唤醒任务')
    const wakeTask = wakeTasks.list.find((row) => sameId(row.cultivationId, cultivationId))
    await crmWriteFact(caseRecord, '唤醒任务生成时保存意向级别、规则版本和计划跟进日期',
      wakeTask != null && sameId(wakeTask.customerId, customer.id) &&
      wakeTask.ruleLevelCode === tag && Number(wakeTask.ruleVersion) === 1 &&
      wakeTask.plannedFollowDate === crmDate(wakeAt),
      JSON.stringify(wakeTask))
    await api.putBusiness('/crm/intention-rule/update', {
      id: ruleId, levelCode: tag, levelName: tag, dealProbabilityMin: 0,
      dealProbabilityMax: 5, followUpDays: 22, warnDays: 3, recycleGraceDays: 2,
      versionNo: 2, status: 1, remark: `${tag}-v2`
    })
    const taskFollowId = crmId(await api.postBusiness('/crm/customer-cultivation/complete-wake', {
      taskId: wakeTask.id,
      customerId: customer.id,
      resultType: '继续培育',
      resultContent: `${tag} 唤醒后继续培育`,
      followNo: `${tag}-WAKE`,
      contactPerson: '管理员',
      communicationMethod: '电话',
      customerFeedback: '客户同意继续跟进',
      planContent: `${tag} 唤醒计划`,
      achieved: true,
      evidenceNote: tag,
      nextFollowTime: crmDateTime(new Date(Date.now() + 3 * 86400000)),
      nextPlanContent: `${tag} 下一步`,
      nextWakeAt: crmDateTime(new Date(Date.now() + 4 * 86400000)),
      nextWakeGoal: `${tag} 下一轮唤醒`
    }), '提交专属唤醒结果生成跟进')
    crmOwned(caseRecord, 'crm-wake-follow-up-record', taskFollowId, {
      tag, sourceTaskId: wakeTask.id
    })
    const wakeFollow = await crmWriteDetail(api,
      `/crm/follow-up-record/get?id=${taskFollowId}`, '唤醒生成的跟进记录')
    await crmWriteFact(caseRecord, '唤醒生成的跟进复制来源任务规则版本与计划日期',
      sameId(wakeFollow.sourceTaskId, wakeTask.id) &&
      wakeFollow.intentionLevelCode === tag && Number(wakeFollow.intentionRuleVersion) === 1 &&
      wakeFollow.plannedFollowDate === wakeTask.plannedFollowDate,
      JSON.stringify({
        followId: taskFollowId, sourceTaskId: wakeFollow.sourceTaskId,
        level: wakeFollow.intentionLevelCode, version: wakeFollow.intentionRuleVersion,
        planned: wakeFollow.plannedFollowDate, taskPlanned: wakeTask.plannedFollowDate
      }))
    const historyFollow = await crmWriteDetail(api,
      `/crm/follow-up-record/get?id=${followId}`, '规则调整后的历史跟进')
    await crmWriteFact(caseRecord, '规则版本调整不回溯历史跟进快照',
      historyFollow.intentionRuleVersion === 1 &&
      historyFollow.plannedFollowDate === follow.plannedFollowDate,
      `followId=${followId}, version=${historyFollow.intentionRuleVersion}`)
    await api.putBusiness('/crm/intention-rule/update', {
      id: ruleId, levelCode: tag, levelName: tag, dealProbabilityMin: 0,
      dealProbabilityMax: 5, followUpDays: 22, warnDays: 3, recycleGraceDays: 2,
      versionNo: 3, status: 0, remark: `${tag}-disabled`
    })
    await expectCrmRejection(api, 'POST', '/crm/customer/create',
      { name: `${tag}-REJECT`, ownerUserId: userId, intentionLevel: tag },
      /意向|级别|规则|不存在|禁用|停用/, caseRecord, '停用意向规则拒绝新建客户')
    const historical = await crmWriteDetail(api,
      `/crm/customer/get?id=${customer.id}`, '停用规则后的历史客户')
    await crmWriteFact(caseRecord, '停用意向级别后历史客户仍可查询且编码不变',
      historical.intentionLevel === tag, `customerId=${customer.id}`)
    const dbRows = await crmSql(caseRecord, 'crm-base-002-intention-snapshot', `
      SELECT r.id,r.level_code,r.version_no,r.status FROM crm_customer_intention_rule r
        WHERE r.tenant_id=1 AND r.id=${crmSqlId(ruleId)};
      SELECT c.id,c.intention_level,c.partner_id FROM crm_customer c
        WHERE c.tenant_id=1 AND c.deleted=0 AND c.id=${crmSqlId(customer.id)};
      SELECT f.id,f.biz_type,f.biz_id,f.intention_level_code,f.intention_rule_version,f.planned_follow_date
        FROM crm_follow_up_record f
        WHERE f.tenant_id=1 AND f.deleted=0 AND f.id=${crmSqlId(followId)};
      SELECT w.id,w.rule_level_code,w.rule_version,w.planned_follow_date,w.follow_record_id
        FROM crm_customer_wake_task w
        WHERE w.tenant_id=1 AND w.deleted=0 AND w.id=${crmSqlId(wakeTask.id)};
      SELECT f.id,f.source_task_id,f.intention_level_code,f.intention_rule_version,f.planned_follow_date
        FROM crm_follow_up_record f
        WHERE f.tenant_id=1 AND f.deleted=0 AND f.id=${crmSqlId(taskFollowId)}`)
    await crmWriteFact(caseRecord, '数据库证明客户意向编码和跟进生成时快照已落库',
      dbRows.length === 5 && dbRows[0][1] === tag && String(dbRows[0][3]) === '0' &&
      dbRows[1][1] === tag && dbRows[2][3] === tag && String(dbRows[2][4]) === '1' &&
      dbRows[3][1] === tag && String(dbRows[3][2]) === '1' &&
      dbRows[4][2] === tag && String(dbRows[4][3]) === '1' &&
      dbRows[4][4] === dbRows[3][3],
      JSON.stringify(dbRows)
    )
    const deleteLevel = `${tag}-DELETE`
    const deleteRuleId = crmId(await api.postBusiness('/crm/intention-rule/create', {
      levelCode: deleteLevel, levelName: deleteLevel, dealProbabilityMin: 0,
      dealProbabilityMax: 5, followUpDays: 11, warnDays: 2, recycleGraceDays: 1,
      versionNo: 1, status: 1, remark: `${tag}-delete-probe`
    }), '创建删除探针意向规则')
    crmOwned(caseRecord, 'crm-intention-rule-delete-probe', deleteRuleId, { tag: deleteLevel })
    await createCrmCustomerFixture(api, caseRecord, userId, `${tag}-DELETE-CUSTOMER`, {
      intentionLevel: deleteLevel
    })
    await api.deleteBusiness(`/crm/intention-rule/delete?id=${deleteRuleId}`)
    const deletedReferencedRule = await api.getBusiness(
      `/crm/intention-rule/get?id=${deleteRuleId}`)
    const softDeletedRule = await crmSql(caseRecord, 'crm-base-002-rule-delete-probe',
      `SELECT id,deleted FROM crm_customer_intention_rule
       WHERE tenant_id=1 AND id=${crmSqlId(deleteRuleId)}`)
    await crmWriteFact(caseRecord, '已引用意向规则删除探针回读真实落库结果',
      deletedReferencedRule.data == null && softDeletedRule.length === 1 &&
      sqlTrue(softDeletedRule[0][1]),
      `ruleId=${deleteRuleId}, detail=${JSON.stringify(deletedReferencedRule.data)}, ` +
      `db=${JSON.stringify(softDeletedRule)}`)
    crmCatalogEvidence(caseId, caseRecord, [0, 1, 2, 4, 5])
    caseRecord.notes.push(
      '产品缺陷：已引用的意向规则仍被 /crm/intention-rule/delete 物理软删除，' +
      `详情返回 null，数据库行 deleted=1；ruleId=${deleteRuleId}，catalog assertion 3 保留 GAP`)
  } finally {
    if (rule) {
      try {
        await api.putBusiness('/crm/intention-rule/update', {
          id: rule.id, levelCode: tag, levelName: tag, dealProbabilityMin: 0,
          dealProbabilityMax: 5, followUpDays: rule.followUpDays, warnDays: rule.warnDays,
          recycleGraceDays: rule.recycleGraceDays, versionNo: rule.versionNo,
          status: 0, remark: `${tag}-retained-disabled`
        })
      } catch {}
    }
  }
}

async function crmCase003 (context, api, userId) {
  const { caseId, caseRecord } = context
  const tag = crmTag()
  const code = `${tag}-TAG`
  const systemCode = `${tag}-SYS`
  let manualId
  let manualDefinitionId
  let systemId
  let customerId
  try {
    manualId = crmId(await api.postBusiness('/crm/customer-tag/definition/create', {
      code, name: tag, tagType: 'MANUAL', scope: 'CUSTOMER', colorType: 'primary',
      status: 1, remark: tag
    }), '创建专属人工标签定义')
    manualDefinitionId = manualId
    crmOwned(caseRecord, 'crm-tag-definition', manualId, { tag, code })
    const manual = await crmWriteDetail(api,
      `/crm/customer-tag/definition/get?id=${manualId}`, '专属人工标签定义')
    await crmWriteFact(caseRecord, '人工标签定义保存稳定编码/名称/颜色/状态',
      manual.code === code && manual.name === tag && manual.tagType === 'MANUAL' &&
      manual.colorType === 'primary' && manual.status === 1, JSON.stringify(manual))
    await api.putBusiness('/crm/customer-tag/definition/update', {
      id: manualId, code: `${code}-CHANGED`, name: `${tag}-UPDATED`, tagType: 'MANUAL',
      scope: 'CUSTOMER', colorType: 'warning', status: 1, remark: `${tag}-UPDATED`
    })
    const updated = await crmWriteDetail(api,
      `/crm/customer-tag/definition/get?id=${manualId}`, '更新后人工标签定义')
    await crmWriteFact(caseRecord, '标签编码创建后不可修改，名称/颜色可维护',
      updated.code === code && updated.name === `${tag}-UPDATED` &&
      updated.colorType === 'warning', `code=${updated.code}`)
    systemId = crmId(await api.postBusiness('/crm/customer-tag/definition/create', {
      code: systemCode, name: systemCode, tagType: 'SYSTEM', scope: 'CUSTOMER',
      colorType: 'info', status: 1, remark: tag
    }), '创建专属系统标签定义')
    crmOwned(caseRecord, 'crm-tag-definition-system', systemId, { tag, code: systemCode })
    customerId = (await createCrmCustomerFixture(api, caseRecord, userId, tag)).id
    const addRelation = () => api.postBusiness('/crm/customer-tag/relation/add', {
      customerId, tagId: manualId, sourceType: 'MANUAL', ruleVersion: 1,
      evidence: tag, reason: tag
    })
    await addRelation()
    await addRelation()
    const relations = await crmWriteArray(api,
      `/crm/customer-tag/relation/list?customerId=${encodeURIComponent(customerId)}`,
      '客户标签关系')
    const logs = await crmWriteArray(api,
      `/crm/customer-tag/relation/change-log?customerId=${encodeURIComponent(customerId)}`,
      '客户标签变更日志')
    await crmWriteFact(caseRecord, '重复添加标签幂等且关系保留来源与规则版本',
      relations.length === 1 && sameId(relations[0].customerId, customerId) &&
      sameId(relations[0].tagId, manualId) && relations[0].sourceType === 'MANUAL' &&
      Number(relations[0].ruleVersion) === 1, JSON.stringify(relations))
    await crmWriteFact(caseRecord, '标签变更审计包含动作、来源、操作人与时间',
      logs.length === 1 && logs.every((row) => sameId(row.customerId, customerId) &&
        row.action === 'ADD' && row.sourceType === 'MANUAL' &&
        stableId(row.operatorUserId) && nonEmpty(row.operateTime)), JSON.stringify(logs))
    const idempotentRows = await crmSql(caseRecord, 'crm-base-003-tag-idempotent', `
      SELECT 'definition',COUNT(*) FROM crm_customer_tag_definition
        WHERE tenant_id=1 AND deleted=0 AND id=${crmSqlId(manualDefinitionId)};
      SELECT 'relation',COUNT(*) FROM crm_customer_tag_relation
        WHERE tenant_id=1 AND deleted=0 AND customer_id=${crmSqlId(customerId)}
        AND tag_id=${crmSqlId(manualDefinitionId)};
      SELECT 'add_log',COUNT(*) FROM crm_customer_tag_change_log
        WHERE tenant_id=1 AND customer_id=${crmSqlId(customerId)}
        AND tag_id=${crmSqlId(manualDefinitionId)} AND action='ADD'`)
    await crmWriteFact(caseRecord, '数据库证明重复添加仅一条关系与一条 ADD 审计',
      idempotentRows.length === 3 && Number(idempotentRows[0][1]) === 1 &&
      Number(idempotentRows[1][1]) === 1 && Number(idempotentRows[2][1]) === 1,
      JSON.stringify(idempotentRows))
    await expectCrmRejection(api, 'POST', '/crm/customer-tag/relation/add',
      { customerId, tagId: systemId, sourceType: 'MANUAL', reason: tag },
      /系统|SYSTEM|人工|添加|移除/, caseRecord, '人工入口不能添加系统标签')
    await expectCrmRejection(api, 'DELETE', `/crm/customer-tag/definition/delete?id=${manualId}`,
      undefined, /引用|使用|删除|不能/, caseRecord, '已有引用的标签禁止删除')
    await api.request('DELETE', '/crm/customer-tag/relation/remove', {
      customerId, tagId: manualId, sourceType: 'MANUAL', reason: tag
    })
    const afterRemove = await crmWriteArray(api,
      `/crm/customer-tag/relation/list?customerId=${encodeURIComponent(customerId)}`,
      '移除后标签关系')
    const afterLogs = await crmWriteArray(api,
      `/crm/customer-tag/relation/change-log?customerId=${encodeURIComponent(customerId)}`,
      '移除后标签审计')
    await crmWriteFact(caseRecord, '人工移除只删除专属关系且审计保留 ADD/REMOVE',
      afterRemove.filter((row) => sameId(row.tagId, manualId)).length === 0 &&
      afterLogs.filter((row) => sameId(row.tagId, manualId)).some((row) => row.action === 'ADD') &&
      afterLogs.filter((row) => sameId(row.tagId, manualId)).some((row) => row.action === 'REMOVE'),
      `relations=${afterRemove.length}, actions=${afterLogs.map((row) => row.action)}`)
    const dbRows = await crmSql(caseRecord, 'crm-base-003-tag-audit', `
      SELECT 'system_definition',COUNT(*) FROM crm_customer_tag_definition
        WHERE tenant_id=1 AND deleted=0 AND id=${crmSqlId(systemId)};
      SELECT 'manual_definition_active',COUNT(*) FROM crm_customer_tag_definition
        WHERE tenant_id=1 AND deleted=0 AND id=${crmSqlId(manualDefinitionId)};
      SELECT 'relation_active',COUNT(*) FROM crm_customer_tag_relation
        WHERE tenant_id=1 AND deleted=0 AND customer_id=${crmSqlId(customerId)}
        AND tag_id=${crmSqlId(manualDefinitionId)};
      SELECT 'relation_row',COUNT(*) FROM crm_customer_tag_relation
        WHERE tenant_id=1 AND customer_id=${crmSqlId(customerId)}
        AND tag_id=${crmSqlId(manualDefinitionId)};
      SELECT 'log',COUNT(*) FROM crm_customer_tag_change_log
        WHERE tenant_id=1 AND customer_id=${crmSqlId(customerId)}
        AND tag_id=${crmSqlId(manualDefinitionId)}`)
    await crmWriteFact(caseRecord, '数据库证明标签关系幂等与审计保留',
      dbRows.length === 5 && Number(dbRows[0][1]) === 1 &&
      Number(dbRows[1][1]) === 1 && Number(dbRows[2][1]) === 0 &&
      Number(dbRows[3][1]) === 1 && Number(dbRows[4][1]) === 2,
      JSON.stringify(dbRows))
    await api.deleteBusiness(`/crm/customer-tag/definition/delete?id=${manualId}`)
    const deleted = await api.getBusiness(`/crm/customer-tag/definition/get?id=${manualId}`)
    await crmWriteFact(caseRecord, '无引用后人工标签定义可删除',
      deleted.data == null, `tagId=${manualId}`)
    manualId = undefined
    crmCatalogEvidence(caseId, caseRecord, [0, 1, 2, 3, 4, 5, 6])
  } finally {
    if (systemId) {
      try { await api.deleteBusiness(`/crm/customer-tag/definition/delete?id=${systemId}`) } catch {}
    }
  }
}

async function crmCase004 (context, api, userId) {
  const { caseId, caseRecord } = context
  const tag = crmTag()
  let originalConfig
  let poolConfigChanged = false
  let customerId
  try {
    originalConfig = crmData(await api.getBusiness('/crm/customer-pool-config/get'), '公海配置')
    if (!objectRow(originalConfig)) throw new Error('公海配置未返回真实对象')
    await crmWriteFact(caseRecord, '公海配置返回真实启用标记和默认天数字段',
      typeof originalConfig.enabled === 'boolean' &&
      (originalConfig.enabled ? Number.isInteger(originalConfig.contactExpireDays) &&
        Number.isInteger(originalConfig.dealExpireDays) : true),
      JSON.stringify(originalConfig))
    const customer = await createCrmCustomerFixture(api, caseRecord, userId, tag)
    customerId = customer.id
    const before = await crmWriteArray(api,
      `/crm/customer-cultivation/history?customerId=${encodeURIComponent(customerId)}`,
      '入池前经营历史')
    await crmWriteFact(caseRecord, '专属客户创建后入池前没有任何 POOL_PUT 历史',
      before.filter((row) => row.operationType === 'POOL_PUT').length === 0,
      `customerId=${customerId}, history=${before.length}`)
    await api.putBusiness('/crm/customer-pool-config/save', {
      ...originalConfig, enabled: true, contactExpireDays: 1,
      dealExpireDays: originalConfig.dealExpireDays ?? 1
    })
    poolConfigChanged = true
    const saved = crmData(await api.getBusiness('/crm/customer-pool-config/get'), '启用后的公海配置')
    if (!objectRow(saved)) throw new Error('启用后的公海配置未返回真实对象')
    await crmWriteFact(caseRecord, '公海配置启用并保存未跟进/未成交天数',
      saved.enabled === true && Number(saved.contactExpireDays) === 1 &&
      Number(saved.dealExpireDays) >= 1, JSON.stringify(saved))
    const jobs = await crmWritePage(api,
      '/infra/job/page?pageNo=1&pageSize=100', '基础设施任务')
    const autoPutJob = jobs.list.find((row) => row.handlerName === 'crmCustomerAutoPutPoolJob')
    const reminderJob = jobs.list.find((row) => row.handlerName === 'crmCustomerPoolReminderJob')
    await crmWriteFact(caseRecord, '公海提醒任务由正式 JobHandler 承载',
      Boolean(reminderJob),
      `autoPut=${autoPutJob?.id || ''}, autoPutStatus=${autoPutJob?.status ?? ''}, ` +
      `reminder=${reminderJob?.id || ''}, reminderStatus=${reminderJob?.status ?? ''}`)
    await crmWriteFact(caseRecord, '公海回收幂等与工作日边界仍需真实到期客户前置',
      true, 'CRM 未暴露可安全配置 contactLastTime 的正式写接口，本轮不直接改库/绕过状态机')
    caseRecord.notes.push('CRM-BASE-004 精确缺口：客户没有安全暴露 contactLastTime/ownerTime 配置入口，' +
      `且 crmCustomerAutoPutPoolJob 未注册为 infra_job；无法在不直接改库的前提下安全构造“已到期”客户，customerId=${customerId}`)
    crmCatalogEvidence(caseId, caseRecord, [])
  } finally {
    if (poolConfigChanged && originalConfig) {
      try {
        await api.putBusiness('/crm/customer-pool-config/save', originalConfig)
        const restored = crmData(await api.getBusiness('/crm/customer-pool-config/get'), '恢复后的公海配置')
        if (!objectRow(restored)) throw new Error('恢复后的公海配置未返回真实对象')
        await crmWriteFact(caseRecord, '公海配置恢复到执行前状态',
          restored.enabled === originalConfig.enabled &&
          restored.contactExpireDays === originalConfig.contactExpireDays &&
          restored.dealExpireDays === originalConfig.dealExpireDays,
          JSON.stringify(restored))
      } catch (error) {
        caseRecord.notes.push(`公海配置恢复失败：${error.message}`)
      }
    }
    if (customerId) {
      try { await api.deleteBusiness(`/crm/customer/delete?id=${customerId}`) } catch {}
    }
  }
}

async function crmCase005 (context, api, userId) {
  const { caseId, caseRecord } = context
  const tag = crmTag()
  let businessId
  let customerId
  let ruleId
  let contractId
  try {
    const customer = await createCrmCustomerFixture(api, caseRecord, userId, tag)
    customerId = customer.id
    caseRecord._customerId = customer.id
    const { id, type, stages } = await createCrmBusinessFixture(api, caseRecord, userId, tag)
    businessId = id
    const existingRules = await crmWritePage(api,
      `/crm/business-stage-rule/page?pageNo=1&pageSize=100&statusGroupId=${encodeURIComponent(type.id)}`,
      '阶段规则分页').then((page) => (page.list || []).filter((rule) =>
        sameId(rule.statusGroupId, type.id)))
    const baselineRuleIds = new Set(existingRules.map((rule) => String(rule.id)))
    const invalidStage = firstStageWithoutRule(stages, existingRules)
    if (!invalidStage) throw new Error('BLOCKED: 当前申请单状态组没有未配置规则的可推进阶段')
    const mainStage = firstStageWithoutRule(stages, existingRules, [invalidStage.id])
    if (!mainStage) throw new Error('BLOCKED: 没有可用于进入/退出/必填规则的未配置阶段')
    const actionStage = firstStageWithoutRule(stages, existingRules, [invalidStage.id, mainStage.id])
    if (!actionStage) throw new Error('BLOCKED: 没有可用于动作白名单反例的未配置阶段')
    const allowedStage = firstStageWithoutRule(stages, existingRules,
      [invalidStage.id, mainStage.id, actionStage.id])
    if (!allowedStage) throw new Error('BLOCKED: 没有可用于动作白名单允许例的未配置阶段')
    const invalidField = await api.request('POST', '/crm/business-stage-rule/create', {
      statusGroupId: type.id, statusId: invalidStage.id, versionNo: 1, status: 1,
      remark: `${tag}-bad-field`,
      items: [{ ruleType: 'ENTER', fieldCode: `${tag}-UNKNOWN`, compareOperator: 'EQ',
        compareValue: 'x', sort: 1 }]
    })
    await crmWriteFact(caseRecord, '不支持的阶段字段保存被拒绝且不产生假规则',
      Number.isInteger(invalidField?.code) && !isBusinessSuccess(invalidField) &&
      invalidField.code !== 500 && /字段|不支持|未知|已存在|重复/.test(String(invalidField?.msg || '')),
      `code=${invalidField?.code}, msg=${invalidField?.msg}`)
    const invalidOperator = await api.request('POST', '/crm/business-stage-rule/create', {
      statusGroupId: type.id, statusId: invalidStage.id, versionNo: 1, status: 1,
      remark: `${tag}-bad-operator`,
      items: [{ ruleType: 'ENTER', fieldCode: 'totalPrice', compareOperator: 'CONTAINS',
        compareValue: 'x', sort: 1 }]
    })
    await crmWriteFact(caseRecord, '不支持的比较符保存被拒绝且不产生假规则',
      Number.isInteger(invalidOperator?.code) && !isBusinessSuccess(invalidOperator) &&
      invalidOperator.code !== 500 &&
      /比较|操作符|不支持|已存在|重复/.test(String(invalidOperator?.msg || '')),
      `code=${invalidOperator?.code}, msg=${invalidOperator?.msg}`)
    const afterRejectedRules = await crmWritePage(api,
      `/crm/business-stage-rule/page?pageNo=1&pageSize=100&statusGroupId=${encodeURIComponent(type.id)}`,
      '反例后阶段规则分页')
    const newRejectedRules = (afterRejectedRules.list || []).filter((rule) =>
      !baselineRuleIds.has(String(rule.id)) && sameId(rule.statusId, invalidStage.id))
    await crmWriteFact(caseRecord, '不支持字段/比较符后没有产生假规则',
      newRejectedRules.length === 0,
      `stageId=${invalidStage.id}, newRules=${JSON.stringify(newRejectedRules.map((rule) => rule.id))}`)
    ruleId = crmId(await api.postBusiness('/crm/business-stage-rule/create', {
      statusGroupId: type.id, statusId: mainStage.id, enterCondition: tag,
      exitCondition: `${tag}-exit`, versionNo: 1, status: 1, remark: tag,
      applicableOrgIds: [], items: [
        { ruleType: 'REQUIRED', fieldCode: 'contactNextTime',
          compareOperator: 'NOT_NULL', sort: 1, remark: tag },
        { ruleType: 'ENTER', fieldCode: 'name', compareOperator: 'EQ',
          compareValue: `${tag}-NOT`, sort: 2, remark: tag },
        { ruleType: 'EXIT', fieldCode: 'name', compareOperator: 'NOT_NULL',
          sort: 3, remark: tag },
        { ruleType: 'ACTION', fieldCode: 'CREATE_CONTRACT', compareOperator: 'EQ',
          compareValue: 'CREATE_CONTRACT', sort: 4, remark: tag }
      ]
    }), '创建专属阶段规则')
    crmOwned(caseRecord, 'crm-business-stage-rule', ruleId, { tag })
    const savedRule = await crmWriteDetail(api,
      `/crm/business-stage-rule/get?id=${ruleId}`, '专属阶段规则')
    await crmWriteFact(caseRecord, '阶段规则保存进入/退出/必填/动作和版本',
      Number(savedRule.versionNo) === 1 && Array.isArray(savedRule.items) &&
      ['REQUIRED', 'ENTER', 'EXIT', 'ACTION'].every((ruleType) =>
        savedRule.items.some((item) => item.ruleType === ruleType)) &&
      Array.isArray(savedRule.applicableOrgIds), JSON.stringify(savedRule))
    await expectCrmRejection(api, 'PUT', '/crm/business/update-status',
      { id: businessId, statusId: mainStage.id },
      /必填|字段|阶段|条件|推进/, caseRecord, '必填字段缺失时推进阶段被拒绝')
    await api.putBusiness('/crm/business/update', {
      id: businessId, name: `${tag}-NOT`, customerId, ownerUserId: userId,
      statusTypeId: type.id, statusId: stages[0].id, contactNextTime: crmDateTime(),
      executionStatus: 'PENDING', discountPercent: 0, remark: tag
    })
    caseRecord.notes.push(
      '产品缺陷复现：CRM 商机原 execution_status=PENDING 时，PUT /crm/business/update ' +
      '不带 execution_status 会把它解析为 null，随后插入 to_status=null 的执行状态日志并触发数据库非空异常；' +
      '本用例为继续验证阶段规则显式回传 PENDING 规避。')
    await api.putBusiness('/crm/business/update-status',
      { id: businessId, statusId: mainStage.id })
    let advanced = await crmWriteDetail(api, `/crm/business/get?id=${businessId}`, '推进后的商机')
    await crmWriteFact(caseRecord, '满足必填字段和进入条件后阶段真实推进',
      sameId(advanced.statusId, mainStage.id), `businessId=${businessId}, statusId=${advanced.statusId}`)
    await api.putBusiness('/crm/business/update-status',
      { id: businessId, endStatus: 1 })
    advanced = await crmWriteDetail(api, `/crm/business/get?id=${businessId}`, '终态后的商机')
    await crmWriteFact(caseRecord, '退出条件不阻断离开阶段，商机可正常进入终态',
      Number(advanced.endStatus) === 1, `businessId=${businessId}, endStatus=${advanced.endStatus}`)
    const actionRuleId = crmId(await api.postBusiness('/crm/business-stage-rule/create', {
      statusGroupId: type.id, statusId: actionStage.id, versionNo: 1, status: 1,
      remark: `${tag}-action`,
      items: [{ ruleType: 'ACTION', fieldCode: 'TRANSFER_OWNER',
        compareOperator: 'EQ', compareValue: 'TRANSFER_OWNER', sort: 1 }]
    }), '创建动作白名单阶段规则')
    crmOwned(caseRecord, 'crm-business-stage-rule-action', actionRuleId, { tag })
    const actionBusiness = await createCrmBusinessFixture(api, caseRecord, userId, `${tag}-ACTION`)
    await api.putBusiness('/crm/business/update-status',
      { id: actionBusiness.id, statusId: actionStage.id })
    const rejectedContract = await api.request('POST', '/crm/contract/create', {
      name: `${tag}-REJECT`, customerId, businessId: actionBusiness.id,
      sourceType: 10, ownerUserId: userId, orderDate: crmDateTime(),
      discountPercent: 0, remark: tag, products: []
    })
    await crmWriteFact(caseRecord, '创建合同命中动作白名单并拒绝未授权动作',
      Number.isInteger(rejectedContract?.code) && !isBusinessSuccess(rejectedContract) &&
      rejectedContract.code !== 500 && /动作|允许|白名单|创建合同/.test(String(rejectedContract?.msg || '')),
      `code=${rejectedContract?.code}, msg=${rejectedContract?.msg}`)
    const allowedRuleId = crmId(await api.postBusiness('/crm/business-stage-rule/create', {
      statusGroupId: type.id, statusId: allowedStage.id, versionNo: 1, status: 1,
      remark: `${tag}-allowed`,
      items: [{ ruleType: 'ACTION', fieldCode: 'CREATE_CONTRACT',
        compareOperator: 'EQ', compareValue: 'CREATE_CONTRACT', sort: 1 }]
    }), '创建允许合同动作阶段规则')
    crmOwned(caseRecord, 'crm-business-stage-rule-allowed', allowedRuleId, { tag })
    const contractBusiness = await createCrmBusinessFixture(api, caseRecord, userId,
      `${tag}-CONTRACT`)
    await api.putBusiness('/crm/business/update-status',
      { id: contractBusiness.id, statusId: allowedStage.id })
    contractId = crmId(await api.postBusiness('/crm/contract/create', {
      name: `${tag}-CONTRACT`, customerId, businessId: contractBusiness.id,
      sourceType: 10, ownerUserId: userId, orderDate: crmDateTime(),
      discountPercent: 0, remark: tag, products: []
    }), '创建动作白名单允许的合同')
    crmOwned(caseRecord, 'crm-contract', contractId, { tag })
    await crmWriteFact(caseRecord, '动作白名单允许时创建合同成功',
      stableId(contractId), `contractId=${contractId}`)
    const dbRows = await crmSql(caseRecord, 'crm-base-005-stage-rules', `
      SELECT 'rule',COUNT(*) FROM crm_business_stage_rule WHERE tenant_id=1 AND deleted=0 AND id=${crmSqlId(ruleId)};
      SELECT rule_type,field_code,compare_operator FROM crm_business_stage_rule_item
        WHERE tenant_id=1 AND deleted=0 AND rule_id=${crmSqlId(ruleId)} ORDER BY sort;
      SELECT 'business',status_id,end_status FROM crm_business
        WHERE tenant_id=1 AND deleted=0 AND id=${crmSqlId(businessId)}`)
    await crmWriteFact(caseRecord, '数据库证明阶段规则项与商机状态转移均真实落库',
      dbRows.length >= 5 && Number(dbRows[0][1]) === 1, JSON.stringify(dbRows))
    crmCatalogEvidence(caseId, caseRecord, [0, 1, 2, 3, 4, 5, 6])
  } finally {
    if (contractId) {
      try {
        await api.postBusiness('/crm/contract/void',
          { id: contractId, reason: `${tag} e2e cleanup` })
      } catch {}
    }
    const ownedStageRules = (caseRecord.fixtures || []).filter((row) =>
      ['crm-business-stage-rule', 'crm-business-stage-rule-action',
        'crm-business-stage-rule-allowed'].includes(row.kind) &&
      row.owned === true && String(row.tenantId) === '1')
    for (const fixture of ownedStageRules) {
      try { await api.deleteBusiness(`/crm/business-stage-rule/delete?id=${fixture.id}`) } catch {}
    }
  }
}

async function crmCase006 (context, api, userId) {
  const { caseId, caseRecord } = context
  const tag = crmTag()
  let activeBusinessId
  let activeCustomerId
  let terminalBusinessId
  let terminalCustomerId
  try {
    const activeCustomer = await createCrmCustomerFixture(api, caseRecord, userId, `${tag}-ACTIVE`)
    activeCustomerId = activeCustomer.id
    caseRecord._customerId = activeCustomer.id
    const active = await createCrmBusinessFixture(api, caseRecord, userId, `${tag}-ACTIVE`)
    activeBusinessId = active.id
    await crmWriteFact(caseRecord, '专属非终态商机初始执行状态为受控字典编码',
      active.detail.endStatus == null && active.detail.executionStatus === 'PENDING',
      `businessId=${activeBusinessId}, executionStatus=${active.detail.executionStatus}`)
    await api.putBusiness('/crm/business/update-execution-status', {
      id: activeBusinessId, executionStatus: 'IN_PROGRESS',
      reason: `${tag} manual`, source: 'MANUAL'
    })
    let detail = await crmWriteDetail(api,
      `/crm/business/get?id=${activeBusinessId}`, '执行状态变更后的商机')
    let logs = await crmWriteArray(api,
      `/crm/business/execution-status-logs?businessId=${encodeURIComponent(activeBusinessId)}`,
      '执行状态日志')
    await crmWriteFact(caseRecord, '受控变更执行状态成功并保存 from/to/source/operator/time',
      detail.executionStatus === 'IN_PROGRESS' && logs.length === 1 &&
      logs[0].fromStatus === 'PENDING' && logs[0].toStatus === 'IN_PROGRESS' &&
      logs[0].changeSource === 'MANUAL' && stableId(logs[0].operatorId) &&
      nonEmpty(logs[0].operateTime), JSON.stringify({ detail, logs }))
    const beforeInvalidLogs = logs.length
    await expectCrmRejection(api, 'PUT', '/crm/business/update-execution-status',
      { id: activeBusinessId, executionStatus: `${tag}-INVALID`, reason: tag, source: 'MANUAL' },
      /执行状态|字典|无效|不存在|启用/, caseRecord, '无效执行状态编码被拒绝')
    await expectCrmRejection(api, 'PUT', '/crm/business/update-execution-status',
      { id: activeBusinessId, executionStatus: 'IN_PROGRESS', reason: tag, source: 'MANUAL' },
      /相同|变化|未变化|一致/, caseRecord, '执行状态未变化时拒绝写入')
    logs = await crmWriteArray(api,
      `/crm/business/execution-status-logs?businessId=${encodeURIComponent(activeBusinessId)}`,
      '拒绝后执行状态日志')
    await crmWriteFact(caseRecord, '无效/同状态拒绝不产生额外审计记录',
      logs.length === beforeInvalidLogs, `logs=${logs.length}`)
    await api.putBusiness('/crm/business/update-status',
      { id: activeBusinessId, endStatus: 2 })
    const terminalActive = await crmWriteDetail(api,
      `/crm/business/get?id=${activeBusinessId}`, '赢单前终态商机')
    await expectCrmRejection(api, 'PUT', '/crm/business/update-execution-status',
      { id: activeBusinessId, executionStatus: 'PAUSED', reason: tag, source: 'MANUAL' },
      /终态|已进入|禁止|不能/, caseRecord, '终态商机直接改执行状态被拒绝')
    await crmWriteFact(caseRecord, '终态商机 execution_status 不混入赢单/战败',
      Number(terminalActive.endStatus) === 2 &&
      !/^(WON|LOST|INVALID|赢单|战败|无效)$/.test(String(terminalActive.executionStatus || '')),
      `businessId=${activeBusinessId}, endStatus=${terminalActive.endStatus}`)
    await expectCrmRejection(api, 'PUT', '/crm/business/reopen',
      { id: activeBusinessId, executionStatus: 'IN_PROGRESS' },
      /重开原因|原因|必填/, caseRecord, '重开未填写原因被拒绝')
    const terminalCustomer = await createCrmCustomerFixture(api, caseRecord, userId, `${tag}-TERM`)
    terminalCustomerId = terminalCustomer.id
    caseRecord._customerId = terminalCustomer.id
    const terminal = await createCrmBusinessFixture(api, caseRecord, userId, `${tag}-TERM`,
      { terminal: true })
    terminalBusinessId = terminal.id
    const detailRoute = `/crm/business/detail/${terminalBusinessId}`
    let frontendRouteAvailable = true
    try {
      await openRoute(context.page, detailRoute,
        { readySelector: 'button:has-text("受控重开")', readyTimeoutMs: 5000, retries: 0 })
    } catch (error) {
      frontendRouteAvailable = false
      caseRecord.notes.push(`前端入口缺口：${detailRoute} 在数据库 /crm 菜单接管后未注册静态详情路由，` +
        `未加载任何商机详情 API，页面未展示「受控重开」；${error.message}`)
      caseRecord.evidence.push(await saveScreenshot(context.page, context.outputDir,
        'crm-business-reopen-route-missing', context.record))
    }
    if (frontendRouteAvailable) {
      const reopenButton = context.page.getByRole('button', { name: '受控重开' }).first()
      await crmWriteFact(caseRecord, '终态商机详情页展示独立「受控重开」入口',
        new URL(context.page.url()).pathname === detailRoute && (await reopenButton.count()) > 0,
        context.page.url())
      await reopenButton.click()
      const dialog = context.page.getByRole('dialog').filter({ hasText: '受控重开商机' })
      await dialog.waitFor({ state: 'visible' })
      const dialogText = await dialog.innerText()
      await crmWriteFact(caseRecord, '重开弹窗按执行状态字典选择并强制填写原因',
        dialogText.includes('重开后状态') && dialogText.includes('重开原因') &&
        dialogText.includes('必填且写入审计'), dialogText.slice(0, 240))
      await dialog.getByRole('button', { name: '取 消' }).click()
    }
    await api.putBusiness('/crm/business/reopen', {
      id: terminalBusinessId, executionStatus: 'IN_PROGRESS', reason: `${tag} reopen`
    })
    const reopened = await crmWriteDetail(api,
      `/crm/business/get?id=${terminalBusinessId}`, '受控重开后的商机')
    const reopenLogs = await crmWriteArray(api,
      `/crm/business/execution-status-logs?businessId=${encodeURIComponent(terminalBusinessId)}`,
      '重开后执行状态日志')
    await crmWriteFact(caseRecord, '受控重开清空 endStatus、写入执行状态并落 REOPEN 审计',
      reopened.endStatus == null && reopened.executionStatus === 'IN_PROGRESS' &&
      reopenLogs.length === 1 && reopenLogs[0].changeSource === 'REOPEN' &&
      reopenLogs[0].toStatus === 'IN_PROGRESS' && nonEmpty(reopenLogs[0].operateTime),
      JSON.stringify({ reopened, reopenLogs }))
    await expectCrmRejection(api, 'PUT', '/crm/business/reopen',
      { id: activeBusinessId, executionStatus: 'IN_PROGRESS', reason: tag },
      /非终态|终态|无需|不能|重开|原因|参数/, caseRecord, '重开非终态商机被拒绝')
    const dbRows = await crmSql(caseRecord, 'crm-base-006-execution-logs', `
      SELECT id,from_status,to_status,operator_id,change_source FROM crm_business_execution_status_log
        WHERE tenant_id=1 AND business_id=${crmSqlId(activeBusinessId)} ORDER BY id;
      SELECT id,from_status,to_status,operator_id,change_source FROM crm_business_execution_status_log
        WHERE tenant_id=1 AND business_id=${crmSqlId(terminalBusinessId)} ORDER BY id`)
    await crmWriteFact(caseRecord, '数据库证明执行状态与受控重开审计均真实落库',
      dbRows.some((row) => row[4] === 'MANUAL') && dbRows.some((row) => row[4] === 'REOPEN'),
      JSON.stringify(dbRows))
    crmCatalogEvidence(caseId, caseRecord, frontendRouteAvailable ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4])
    caseRecord.notes.push(frontendRouteAvailable
      ? '受控重开 API、日志与详情页入口均已验收；终态拒绝与空原因反例已覆盖'
      : '受控重开 API、日志与反例均已验收；终态详情页入口因路由未注册保留 GAP')
  } finally {
    if (terminalBusinessId) {
      try { await api.deleteBusiness(`/crm/business/delete?id=${terminalBusinessId}`) } catch {}
    }
    if (terminalCustomerId) {
      try { await api.deleteBusiness(`/crm/customer/delete?id=${terminalCustomerId}`) } catch {}
    }
    if (activeBusinessId) {
      try { await api.deleteBusiness(`/crm/business/delete?id=${activeBusinessId}`) } catch {}
    }
    if (activeCustomerId) {
      try { await api.deleteBusiness(`/crm/customer/delete?id=${activeCustomerId}`) } catch {}
    }
  }
}

async function crmCase007 (context, api, userId) {
  const { caseId, caseRecord } = context
  const tag = crmTag()
  const dictValue = String(90000 + Math.floor(Math.random() * 9000))
  let dictionaryId
  let ruleId
  let customerId
  try {
    const dict = await crmWritePage(api,
      '/system/dict-data/page?pageNo=1&pageSize=100&dictType=crm_follow_up_type',
      '跟进方式字典')
    const dictType = await crmWritePage(api,
      '/system/dict-type/page?pageNo=1&pageSize=100&type=crm_follow_up_type', '字典类型')
    await crmWriteFact(caseRecord, '跟进方式主档仍是 crm_follow_up_type 字典',
      dictType.list.some((row) => row.type === 'crm_follow_up_type') &&
      dict.list.every((row) => row.dictType === 'crm_follow_up_type' && nonEmpty(row.value)),
      `rows=${dict.list.length}`)
    dictionaryId = crmId(await api.postBusiness('/system/dict-data/create', {
      dictType: 'crm_follow_up_type', value: dictValue, label: tag,
      status: 0, sort: 9999, colorType: 'default', cssClass: '', remark: tag
    }), '创建专属跟进方式字典值')
    crmOwned(caseRecord, 'crm-follow-up-type-dict', dictionaryId, { tag, dictValue })
    ruleId = crmId(await api.postBusiness('/crm/follow-up-type-rule/save', {
      dictValue: Number(dictValue), requireAttachment: true,
      allowedAttachmentTypes: '.PDF, docx,pdf', status: 1, remark: tag
    }), '创建专属跟进方式规则')
    crmOwned(caseRecord, 'crm-follow-up-type-rule', ruleId, { tag, dictValue })
    let rule = (await crmWriteArray(api, '/crm/follow-up-type-rule/list', '跟进方式规则'))
      .find((row) => sameId(row.id, ruleId))
    await crmWriteFact(caseRecord, '领域规则保存附件要求、规范化扩展名、版本与启用状态',
      rule != null && rule.dictValue === Number(dictValue) &&
      rule.requireAttachment === true && rule.allowedAttachmentTypes === 'pdf,docx' &&
      Number(rule.versionNo) === 1 && Number(rule.status) === 1,
      JSON.stringify(rule))
    const duplicate = await api.request('POST', '/crm/follow-up-type-rule/save', {
      dictValue: Number(dictValue), requireAttachment: false,
      allowedAttachmentTypes: null, status: 1, remark: `${tag}-duplicate`
    })
    await crmWriteFact(caseRecord, '同一字典值重复创建领域规则被拒绝',
      Number.isInteger(duplicate?.code) && !isBusinessSuccess(duplicate) &&
      duplicate.code !== 500 && /重复|已存在|唯一|存在/.test(String(duplicate?.msg || '')),
      `code=${duplicate?.code}, msg=${duplicate?.msg}`)
    const dbRows = await crmSql(caseRecord, 'crm-base-007-follow-up-rule', `
      SELECT id,dict_value,require_attachment,allowed_attachment_types,version_no,status
        FROM crm_follow_up_type_rule
        WHERE tenant_id=1 AND deleted=0 AND id=${crmSqlId(ruleId)};
      SELECT COUNT(*) FROM system_dict_data
        WHERE deleted=0 AND dict_type='crm_follow_up_type' AND value='${dictValue}'`)
    await crmWriteFact(caseRecord, '数据库证明领域规则引用真实字典值且字段落库',
      dbRows.length === 2 && dbRows[0][1] === dictValue &&
      String(dbRows[0][2]) === '1' && dbRows[0][3] === 'pdf,docx' &&
      String(dbRows[0][4]) === '1' && String(dbRows[0][5]) === '1' &&
      Number(dbRows[1][0]) === 1, JSON.stringify(dbRows))
    const page = await crmWritePage(api,
      '/system/dict-data/page?pageNo=1&pageSize=100&dictType=crm_follow_up_type',
      '跟进方式字典复核')
    await crmWriteFact(caseRecord, '领域规则没有创建平行沟通方式主档表/数据',
      page.list.filter((row) => row.value === dictValue).length === 1,
      `dictRows=${page.list.length}`)
    const customer = await createCrmCustomerFixture(api, caseRecord, userId, tag)
    customerId = customer.id
    const followBody = {
      bizType: 2, bizId: customerId, type: Number(dictValue), content: `${tag} 附件校验`,
      nextTime: crmDateTime(new Date(Date.now() + 86400000)), remark: tag
    }
    await expectCrmRejection(api, 'POST', '/crm/follow-up-record/create', followBody,
      /附件|上传|必填/, caseRecord, '命中专属规则后缺失附件拒绝创建跟进')
    const followId = crmId(await api.postBusiness('/crm/follow-up-record/create', {
      ...followBody, content: `${tag} 带附件`, fileUrls: [`${tag}.pdf`]
    }), '创建带合法附件跟进')
    crmOwned(caseRecord, 'crm-follow-up-record', followId, { tag })
    const follow = await crmWriteDetail(api,
      `/crm/follow-up-record/get?id=${followId}`, '带合法附件跟进')
    await crmWriteFact(caseRecord, '合法附件满足专属规则并保存附件引用',
      sameId(follow.bizId, customerId) && follow.type === Number(dictValue) &&
      Array.isArray(follow.fileUrls) && follow.fileUrls.includes(`${tag}.pdf`),
      `followId=${followId}, fileUrls=${JSON.stringify(follow.fileUrls)}`)
    const permission = crmData(await api.getBusiness('/system/auth/get-permission-info'), '权限菜单')
    const menuRoute = crmMenuRoute(permission?.menus, 'crm/followUpTypeRule/index')
    await openRoute(context.page, followUpRuleRoute, { readySelector: followUpRuleReadySelector })
    const bodyText = await context.page.locator('body').innerText()
    await crmWriteFact(caseRecord, '设置-业务设置-CRM 下真实页面可访问并展示规则字段',
      new URL(context.page.url()).pathname === followUpRuleRoute &&
      bodyText.includes('必须上传附件') && bodyText.includes('允许的附件类型'),
      `menuRoute=${menuRoute || followUpRuleRoute}, url=${context.page.url()}`)
    await context.page.getByRole('button', { name: /新增/ }).first().click()
    const dialog = context.page.getByRole('dialog').last()
    await dialog.waitFor({ state: 'visible' })
    const dialogText = await dialog.innerText()
    await crmWriteFact(caseRecord, '规则编辑弹窗提供字典选择、附件要求和扩展名维护',
      dialogText.includes('跟进方式') && dialogText.includes('必须上传附件') &&
      dialogText.includes('允许的附件类型'), dialogText.slice(0, 240))
    await context.page.getByRole('button', { name: '取 消' }).last().click()
    caseRecord.evidence.push(await saveScreenshot(context.page, context.outputDir,
      'crm-follow-up-type-rule-write', context.record))
    crmCatalogEvidence(caseId, caseRecord, [0, 1, 2, 3, 4])
  } finally {
    if (ruleId) {
      try { await api.deleteBusiness(`/crm/follow-up-type-rule/delete?id=${ruleId}`) } catch {}
    }
    if (dictionaryId) {
      try { await api.deleteBusiness(`/system/dict-data/delete?id=${dictionaryId}`) } catch {}
    }
    if (customerId) {
      try { await api.deleteBusiness(`/crm/customer/delete?id=${customerId}`) } catch {}
    }
  }
}

export async function runCrmWriteCase (context, api, userId, dependencies = {}) {
  const { caseId, caseRecord } = context
  crmCatalogEvidence(caseId, caseRecord)
  if (crmReadOnlyCases.includes(caseId)) {
    await runCrmReadOnlyPreconditions({ caseId, api, caseRecord })
  }
  if (caseId === 'CRM-BASE-001') await crmCase001(context, api, userId)
  else if (caseId === 'CRM-BASE-002') await crmCase002(context, api, userId)
  else if (caseId === 'CRM-BASE-003') await crmCase003(context, api, userId)
  else if (caseId === 'CRM-BASE-004') await crmCase004(context, api, userId)
  else if (caseId === 'CRM-BASE-005') await crmCase005(context, api, userId)
  else if (caseId === 'CRM-BASE-006') await crmCase006(context, api, userId)
  else if (caseId === 'CRM-BASE-007') await crmCase007(context, api, userId)
  else throw new Error(`未知 CRM 案例 ${caseId}`)
  const view = crmReadOnlyViews[caseId]
  if (view) {
    const permission = crmData(await api.getBusiness('/system/auth/get-permission-info'), '权限菜单')
    const menuRoute = crmMenuRoute(permission?.menus, view.component)
    if (menuRoute) {
      await openRoute(context.page, menuRoute, { readySelector: view.selector })
      await crmWriteFact(caseRecord, '真实权限菜单领域页面已就绪',
        new URL(context.page.url()).pathname === menuRoute.split('?')[0],
        `menu=${menuRoute}, url=${context.page.url()}`)
      caseRecord.evidence.push(await saveScreenshot(context.page, context.outputDir,
        `${caseId}-write`, context.record))
    } else {
      throw new Error(`BLOCKED: 权限菜单缺少 ${view.component}`)
    }
  }
  return { partial: caseRecord.passCandidate !== true, note: caseRecord.notes.at(-1) }
}

function assertCrmLocalScope (selected = config) {
  if (selected.target !== 'local' || selected.tenantId !== '1' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(selected.webBase).hostname) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(selected.apiBase).hostname)) {
    throw new Error('BLOCKED: CRM 写侧仅允许租户 1 的本地验收环境')
  }
}

export const runCase = async (context, dependencies = {}) => {
  if (dependencies.readonly === true) {
    return runCrmReadOnlyPreconditions(context)
  }
  assertCrmLocalScope(dependencies.config || config)
  if (!isCrmWriteFixturesEnabled(dependencies.env || process.env)) {
    throw new Error(`BLOCKED: 写侧验收必须显式设置 ${CRM_WRITE_FIXTURE_ENV}=true`)
  }
  const { page, caseRecord } = context
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const auth = await (dependencies.login || login)(page, { returnContext: true })
  const token = typeof auth === 'string' ? auth : auth?.token
  const api = (dependencies.createApiClient || createApiClient)({
    token, tenantId: '1', record: context.record
  })
  const tenantId = await api.tenantIdByName(config.tenantName)
  if (String(tenantId) !== '1' || (auth?.tenantId && String(auth.tenantId) !== '1')) {
    throw new Error('BLOCKED: CRM 登录租户不匹配，未创建夹具')
  }
  const permission = crmData(
    await api.getBusiness('/system/auth/get-permission-info'), 'CRM 权限')
  if (!stableId(permission?.user?.id)) {
    throw new Error('BLOCKED: CRM 认证缺少可信用户 ID')
  }
  return runCrmWriteCase(context, api, String(permission.user.id), dependencies)
}
