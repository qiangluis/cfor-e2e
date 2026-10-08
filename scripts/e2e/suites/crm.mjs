import { assertBusinessSuccess } from '../lib/assertions.mjs'

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

export const crmReadOnlyCases = cases.slice(0, 6)
const pageQuery = 'pageNo=1&pageSize=100'
const stableId = (id) =>
  (typeof id === 'string' && /^[1-9]\d*$/.test(id)) ||
  (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
const sameId = (a, b) => stableId(a) && stableId(b) && String(a) === String(b)
const checkFact = (record, name, passed, details = '') =>
  record.checks.push({ name, passed: Boolean(passed), details })
const missingFact = (record, message) => record.notes.push(`前置缺失：${message}；保留 PARTIAL`)

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
      checkFact(record, '意向规则保存编码、周期、预警、宽限和版本',
        rules.every((row) => typeof row.levelCode === 'string' &&
          dictionaries.some((dict) => dict.value === row.levelCode) &&
          Number.isInteger(row.followUpDays) && row.followUpDays > 0 &&
          Number.isInteger(row.warnDays) && row.warnDays >= 0 &&
          Number.isInteger(row.recycleGraceDays) && row.recycleGraceDays >= 0 &&
          Number.isInteger(row.versionNo) && row.versionNo > 0 && [0, 1].includes(row.status)))
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

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (crmReadOnlyCases.includes(caseId)) {
    const { createApiClient } = await import('../lib/api.mjs')
    const { login, openRoute, saveScreenshot } = await import('../lib/browser.mjs')
    const token = await login(page)
    const api = createApiClient({ token, record })
    const view = crmReadOnlyViews[caseId]
    const permission = (await api.getBusiness('/system/auth/get-permission-info')).data
    const menuRoute = crmMenuRoute(permission?.menus, view.component)
    if (menuRoute) {
      const route = menuRoute
      await openRoute(page, route, { readySelector: view.selector })
      checkFact(caseRecord, '真实权限菜单领域页面已就绪（未操作保存按钮）',
        new URL(page.url()).pathname === route.split('?')[0], `menu=${menuRoute}, url=${page.url()}`)
      caseRecord.evidence.push(await saveScreenshot(page, outputDir, `${caseId}-readonly`, record))
    } else missingFact(caseRecord, `权限菜单缺少 ${view.component}，领域页面未验证`)
    return { token, api, ...await runCrmReadOnlyPreconditions({ caseId, api, caseRecord }) }
  }

  if (caseId === 'CRM-BASE-007') {
    const { createApiClient } = await import('../lib/api.mjs')
    const { login, openRoute, saveScreenshot } = await import('../lib/browser.mjs')
    const token = await login(page)
    const api = createApiClient({ token, record })
    const ruleRows = followUpRuleRows(await api.getBusiness('/crm/follow-up-type-rule/list'))
    const valid = ruleRows.every(
      (item) =>
        item?.dictValue != null &&
        item?.versionNo != null &&
        (item?.status === 0 || item?.status === 1)
    )
    const uniqueValues = new Set(ruleRows.map((item) => String(item.dictValue)))
    if (ruleRows.length > 0) {
      caseRecord.checks.push({
        name: '跟进方式规则接口返回字典值、版本和启用状态',
        passed: valid,
        details: `rows=${ruleRows.length}`
      })
      caseRecord.checks.push({
        name: '每个跟进方式字典值至多一条领域规则',
        passed: uniqueValues.size === ruleRows.length,
        details: `unique=${uniqueValues.size}, rows=${ruleRows.length}`
      })
    } else {
      caseRecord.notes.push('跟进方式规则 data 为空数组，仅验证列表与页面契约；规则字段及唯一性未验收，保留 PARTIAL')
    }
    await openRoute(page, followUpRuleRoute, { readySelector: followUpRuleReadySelector })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设置-业务设置-CRM 页面可访问且展示跟进方式规则',
      passed:
        new URL(page.url()).pathname === followUpRuleRoute &&
        bodyText.includes('必须上传附件') &&
        bodyText.includes('允许的附件类型'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'crm-follow-up-type-rule', record)
    caseRecord.evidence.push('CRM-BASE-007 真实登录、规则列表接口和设置页渲染截图')
    return { token, api, partial: ruleRows.length === 0 }
  }

  caseRecord.notes.push(
    '案例已登记销售类型、销售计划类型、意向级别和商机执行状态复用字典主档；' +
      '意向级别规则落 crm_customer_intention_rule，客户保存 intention_level 编码并校验启用状态；' +
      '客户标签为定义/关系/审计三表，系统标签与人工标签互不冒充；' +
      '公海回收写 recycleReason、ruleVersion 和 POOL_PUT 幂等业务键，跟进超期按 WorkingDayApi 工作日计算；' +
      '商机阶段规则用规则头 + 规则项两表表达，进入条件与必填字段在 updateBusinessStatus 内做后端强制校验；' +
      'CRM-BASE-006 锁定执行状态受控变更：update-execution-status 写 crm_business_execution_status_log，' +
      '终态商机禁止直接改执行状态，状态未变化或无效编码被拒绝；' +
      '终态商机重开走独立受控动作 PUT /crm/business/reopen，清空 end_status、回写执行状态并以 change_source=REOPEN 落审计，非终态或未填原因被拒绝；' +
      'CRM-BASE-005 覆盖阶段规则允许动作白名单与适用组织，分页响应返回 items 与 applicableOrgIds；' +
    'CRM-BASE-007 锁定跟进方式复用字典 crm_follow_up_type，领域规则 crm_follow_up_type_rule 承载附件要求；' +
      'CRM-BASE-002 锁定正式跟进记录写 intention_level_code、intention_rule_version 和 planned_follow_date 生成时快照，' +
      '由唤醒任务生成的跟进复制来源任务快照，规则后续调整不回溯历史；' +
      '客户标签在报价/合同创建时写入 customer_tag_snapshot（标签稳定编码口径），后续标签调整不回溯历史单据；' +
      '销售价格中心与期初销售出库开票来源继续按批次执行。'
  )
  return { designed: true }
}
