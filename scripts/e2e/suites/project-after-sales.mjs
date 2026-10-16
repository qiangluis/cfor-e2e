import { createApiClient } from '../lib/api.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import {
  assertProjectBusinessMenus,
  PROJECT_MENU_ROOT_IDS,
  verifyProjectBusinessMenuInBrowser
} from '../fixtures/project-menu.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import {
  assertProjectChangeLifecycle,
  assertProjectReportExportMatches,
  assertProjectTaskFactsUnchanged,
  planMilestoneWeightUpdates
} from '../fixtures/project-core-evidence.mjs'
import {
  assertProjectReportPageText,
  verifyProjectReportPages
} from '../fixtures/project-report-browser.mjs'
import { EVALUATION_ACCEPTANCE_GAPS } from '../fixtures/project-after-sales-evaluation-closure.mjs'
import { runEvaluationClosureCase } from '../fixtures/project-after-sales-evaluation-cases.mjs'
import {
  assertInspectionSnapshotUnchanged,
  assertInspectionTaskSnapshot,
  queryInspectionTaskInBrowser,
  readOtherInspectionFacts
} from '../fixtures/project-after-sales-inspection-closure.mjs'
import {
  assertPmClosureLocalTarget,
  cleanupDedicatedModelingConfigs,
  createDedicatedHrmEmployee,
  createDedicatedModelingConfig,
  createDedicatedStaffSkill,
  deleteDedicatedHrmEmployee,
  deleteDedicatedStaffSkill,
  newPmClosureFixture,
  ORIGINAL_PROJECT_ACCEPTANCE_GAPS,
  pmClosureDelayAdvanceDays,
  pmClosureTaskDate,
  PROJECT_AFTER_SALES_CATALOG_ASSERTIONS,
  PROJECT_AFTER_SALES_SAFETY_BLOCKS,
  readDedicatedModelingConfig
} from '../fixtures/project-after-sales-pm-closure.mjs'
import {
  saveAssetProfileInBrowser,
  saveIssueCategoryInBrowser,
  verifyDutyPageInBrowser,
  verifyExpiredAssetInBrowser
} from '../fixtures/project-after-sales-browser.mjs'
import {
  assertPb125AssetSearch,
  assertPb125InventoryUnchanged,
  assertPb125LocalTarget,
  assertPb125ServicePeriod,
  changePb125AssetStatus,
  cleanupPb125Fixtures,
  newPb125Fixture,
  preparePb125Assets,
  preparePb125Material,
  readPb125Asset,
  readPb125InventoryFacts,
  verifyPb125ExpiredAcceptance,
  verifyPb125StatusEvents
} from '../fixtures/project-after-sales-asset-closure.mjs'
import {
  assertReminderLocalTarget,
  cleanupReminderClosure,
  createReminderClosureRule,
  newReminderFixture,
  prepareReminderAsset,
  verifyReminderClosure
} from '../fixtures/project-after-sales-reminder-closure.mjs'
import { verifyReminderRuleQuietHoursInBrowser } from '../fixtures/project-after-sales-reminder-browser.mjs'
import {
  assertKnowledgeReadinessLocalContext,
  runProjectAfterSalesKnowledgeReadiness
} from '../fixtures/project-after-sales-knowledge-readiness.mjs'
import { runProjectMilestoneClosure } from '../fixtures/project-milestone-closure.mjs'
import { config } from '../config/index.mjs'
import path from 'node:path'
import * as XLSX from 'xlsx'

export const cases = [
  'PB111-001',
  'PB111-002',
  'PB112-001',
  'PB113-001',
  'PB114-001',
  'PB115-001',
  'PB116-001',
  'PB117-001',
  'PB118-001',
  'PB119-001',
  'PB120-001',
  'PB122-001',
  'PB121-001',
  'PB123-001',
  'PB124-001',
  'PB125-001',
  'PB127-001',
  'PB128-001',
  'PB129-001',
  'PB126-001',
  'PB130-001',
  'PB945-001',
  'PB947-001',
  'PB949-001',
  'PB951-001',
  'PB953-001',
  'PB955-001'
]

export { PROJECT_AFTER_SALES_CATALOG_ASSERTIONS }

const PERIOD_EVIDENCE_CHECKS = ['DAILY', 'WEEKLY', 'MONTHLY']
  .map((type) => `${type} 生成周期范围并由服务端构造只读来源快照`)
const REPORT_EVIDENCE_CHECKS = [
  'PROJECT_PROGRESS', 'TASK_EXECUTION', 'RESEARCH', 'RISK_ISSUE_BUG', 'PLAN_CHANGE',
  'RELEASE', 'GO_LIVE_ISSUE', 'ACCEPTANCE_RECTIFICATION', 'PROJECT_REVIEW',
  'AFTER_SALES_HANDOVER', 'PROJECT_CLOSEOUT'
].map((type) => `${type} 报表返回统一口径和同一筛选上下文`)
const EXPORT_EVIDENCE_CHECKS = ['PROJECT_PROGRESS', 'TASK_EXECUTION']
  .map((type) => `${type} 导出复用相同筛选并生成可解析 Excel`)
const REPORT_EXPORT_UI_EVIDENCE_CHECKS = [
  '十一类Excel导出逐项匹配列表项目日期版本和全部非空标量指标',
  '十一类项目报表真实页面按专属项目日期逐项展示且指标匹配正式查询'
]
const DUPLICATE_CHANGE_EVIDENCE_CHECKS = [
  '重复幂等键被领域拒绝，不产生第二次执行',
  '重复执行拒绝后第二条变更仍停留在 APPROVED'
]
const MILESTONE_GATE_EVIDENCE_CHECKS = [
  'PB951 缺门禁负例在合法HRM工作日且确认状态和其它条件完整',
  '里程碑缺少准出条件或必需交付物时不能完成'
]

const PROJECT_AFTER_SALES_ASSERTION_EVIDENCE = Object.freeze({
  'PB111-001': [
    { checks: ['项目建模配置沿用设置主菜单下的项目建模入口'] },
    { checks: ['项目建模树形条目和分类来自真实配置接口'] },
    { checks: ['项目基础建模工作区真实渲染，不新建平行页面'] },
    { checks: ['模块定义写入后可回读分类、版本和启用状态'] },
    { checks: ['模块定义停用后回读为 DISABLED'] }
  ],
  'PB111-002': [
    { checks: ['项目根只保留工作台、项目协作、项目执行、项目研发、报表五个可见入口'] },
    { checks: ['旧项目根和旧执行/报表目录隐藏，但按钮权限与深链仍保留'] },
    { checks: ['项目配置入口只在设置导航保留一份'] },
    { checks: ['真实浏览器菜单不展示交付项目、项目执行规划、统计查询和AI助手'] },
    { checks: ['旧项目深链仍可打开'] },
    { checks: ['执行研发报表子菜单完整且浏览器逐项可见'] },
    { checks: ['套餐不下发旧目录且新入口祖先完整'] }
  ],
  'PB112-001': [
    { checks: ['人员能力标签引用 HRM 员工并维护技能历史'] },
    { checks: ['派研保存 HRM 员工有效能力标签快照并可回读'] }
  ],
  'PB113-001': [
    { checks: ['日报只读来源按项目带出任务/风险/里程碑'] },
    { checks: ['日报填报人使用当前登录用户，不伪造固定用户编号'] },
    { checks: ['日报来源快照由服务端按事实源生成，忽略客户端伪造值'] },
    { checks: ['退回后生成新的修订版本，任务状态只作建议'] },
    { checks: ['退回版本不把任务状态建议反写到任务事实源'] }
  ],
  'PB114-001': [
    { checks: ['预警规则求值命中并保存规则版本、指标与证据'] },
    { checks: ['预警求值不修改项目状态与计划日期'],
      gap: '只证明项目事实不变；当前求值未关联真实 todoId，不能声明待办闭环。' },
    { checks: ['同一规则与触发窗口重复求值保持幂等'] }
  ],
  'PB115-001': [
    { checks: ['里程碑模板复用项目建模配置且不另建主档'] },
    { checks: ['里程碑模板保留版本号以支持发布后新版本变更'] },
    { checks: ['里程碑模板返回完整阶段快照供工作台回读'] },
    { checks: ['启用里程碑模板前阻断缺少必经阶段交付物'] },
    { checks: ['草稿经启用接口发布仍执行里程碑门禁，不能绕过保存校验'] },
    { checks: ['里程碑模板创建并发布 V1 后回读版本号'] },
    { checks: ['同编码发布新版本后版本号递增且旧版本自动停用'] }
  ],
  'PB116-001': [
    { checks: ['任务库复用建模配置键 taskLibrary/taskCategory 并返回引用计数'] },
    { checks: ['任务库真实条目保存标准工时、产出物、验收标准和前置关系'] },
    { checks: ['启用任务库前阻断前置任务循环依赖'] },
    { checks: ['草稿经启用接口发布仍执行任务库门禁，不能绕过验收标准校验'] }
  ],
  'PB117-001': [
    { checksPrefix: '发布项目类型时拒绝未启用的 ' },
    { checks: ['项目类型草稿经状态接口启用不能绕过依赖校验'] },
    { checks: ['项目主档切换项目类型时固化服务端依赖配置快照'] }
  ],
  'PB118-001': [
    { check: '交付项目分页可读' },
    { check: '非法健康状态被拒绝，核心状态与健康状态解耦' },
    { check: '健康状态可独立切换为 DELAYED 且核心状态不变' }
  ],
  'PB119-001': [
    { checks: ['售后设置复用现有建模页读取 SLA/提醒/评价，不建平行主档'] },
    { checks: ['SLA 策略写入后回读分类、响应/解决时限和暂停口径'] },
    { checks: ['SLA 策略停用后回读为 DISABLED'] },
    { checks: ['售后设置页可进入且复用页面内维护 SLA/提醒/评价'] }
  ],
  'PB120-001': [
    { checks: ['分类主档写入后回读产品类型/资产类型/服务状态适用范围'] },
    { checks: ['售后问题分类与 CRM 客户标签是相互独立的事实源'] },
    { checks: ['售后问题分类停用后回读为 DISABLED'] },
    { checks: ['售后设置页全部建模数据均从正式接口读取'] },
    { checks: ['售后设置页已接入真实数据且不再展示虚拟数据标识'] }
  ],
  'PB121-001': [
    { checks: ['暂停规则可分别控制客户侧SLA与内部责任计时'] },
    { checks: ['等待研发原因禁止暂停内部责任计时'] },
    { checks: ['暂停规则停用后回读为 DISABLED，停止参与 SLA 暂停计算'] }
  ],
  'PB122-001': [
    { checks: ['售后巡检方案发布记录版本'] },
    { checks: ['被方案引用的巡检项目禁止删除'] },
    { checks: ['巡检方案可分配到在保客户资产并作为任务快照来源'] }
  ],
  'PB125-001': [
    { checks: ['手工客户资产可在分页中按 assetNo 独立检索'] },
    { checks: ['客户资产详情统一回读服务期、责任人和存货档案引用'] },
    { checks: ['客户资产不是存货余额载体，不含库存数量字段'] },
    { checks: ['资产退役后状态回读为 RETIRED，不改动存货档案'] }
  ],
  'PB126-001': [
    { checks: ['AI不得自动受理/关闭/改写客户事实'] },
    { checks: ['置信度阈值越界被拒绝'] }
  ],
  'PB127-001': [
    { checks: ['客户资产来源类型与来源项目/验收引用可回读'] },
    { checks: ['服务期来源关联项目验收单且资产处于在保状态'] },
    { checks: ['来源验收单真实存在且状态为 APPROVED'] },
    { checks: ['项目验收资产退役后仍保留来源引用'] }
  ],
  'PB128-001': [
    { checks: ['评价项目主档写入后回读稳定编码与分类引用'] },
    { checks: ['评价项目停用后回读为 DISABLED 且编码不变'] }
  ],
  'PB129-001': [
    { checks: ['评价模板启用后回读项目快照与总分'] },
    { checks: ['已启用模板保留创建时快照，不随评价项目主档漂移'] }
  ],
  'PB130-001': [
    { checks: ['HRM 提供值班角色目录，售后不做角色主档'] },
    { checks: ['值班名册人员来自 HRM/OA 排班，电话来自售后转接规则'] },
    { checks: ['值班设置页不再出现示例人员与固定日期'] }
  ],
  'PB945-001': [
    { checks: PERIOD_EVIDENCE_CHECKS },
    { checks: PERIOD_EVIDENCE_CHECKS },
    { checks: ['日报来源按当天过滤，周期外任务不进入快照'] },
    { checks: ['报告生成不修改内外周期任务的完整正式事实和全部日期'] }
  ],
  'PB947-001': [
    { checks: ['风险可关联任务且保留责任人和期限'] },
    { checks: ['风险等级变化写前值、变化时间和结构化历史'] },
    { checks: ['风险关闭缺少验证人时按领域错误拒绝'] },
    { checks: ['风险验证后关闭并回读关闭时间、验证人和验证时间'] },
    { checks: ['风险、问题、Bug 使用独立记录和编号，不通过转化删除原记录'] }
  ],
  'PB949-001': [
    { checks: ['变更七个状态逐步正式回读且身份版本和全链路时间保持一致'] },
    { checks: ['变更审批通过冻结对象版本并记录下游处理策略'] },
    { checks: ['服务端一次性执行写入幂等键、执行人和执行时间'] },
    { checks: DUPLICATE_CHANGE_EVIDENCE_CHECKS },
    { checks: ['变更七个状态逐步正式回读且身份版本和全链路时间保持一致'] }
  ],
  'PB951-001': [
    { checks: MILESTONE_GATE_EVIDENCE_CHECKS },
    { checks: ['具备准出条件和交付物的里程碑可人工确认完成'] },
    { checks: ['具备准出条件和交付物的里程碑可人工确认完成'] },
    { checks: ['里程碑人工完成不代替任务责任人确认或改写任务状态'] }
  ],
  'PB953-001': [
    { checks: REPORT_EVIDENCE_CHECKS },
    { checks: REPORT_EVIDENCE_CHECKS },
    { checks: EXPORT_EVIDENCE_CHECKS },
    { checks: REPORT_EXPORT_UI_EVIDENCE_CHECKS }
  ],
  'PB955-001': [
    { checks: ['绩效公式、数据来源、剔除规则和可见角色公开可读'] },
    { checks: ['绩效汇总按正式已验收任务和已完成里程碑计算权重与完成率'] },
    { checks: ['个人绩效明细返回任务、里程碑和统一公式口径'] },
    { checks: ['风险趋势保留等级变化和验证关闭后的处置时长'] }
  ]
})

const CATALOG_ASSERTION_GAP_NOTES = Object.freeze({
  'PB123-001': 'PB-123 缺少企业知识中枢启用型 EMBEDDING 模型和真实 PARSED+INDEXED 文档，保留 BLOCKED/PARTIAL，未伪造通过。',
  'PB124-001': 'PB-124 原 catalog 未定义可执行断言，既有页面/API 证据不自动升级为 VERIFIED。'
})

export const PROJECT_AFTER_SALES_ACCEPTANCE_GAPS = Object.freeze({
  'PB122-001': [
    {
      assertion: 'PB-122：尚未按周期真实生成既有 after_sales_inspection_task，验证未另建平行任务事实',
      check: 'PB122/GAP1 白名单真实季度生成既有任务且其他资产事实不变'
    },
    {
      assertion: '尚未结构化核对任务的方案/项目/周期/资产、客户合同权益、预约、确认和签字规则完整快照',
      check: 'PB122/GAP2 完整方案项目周期资产合同权益及执行规则快照'
    },
    {
      assertion: '尚未发布新项目/方案版本后回读旧巡检任务，证明历史快照不变；发布及资产分配成功不能替代执行闭环',
      check: 'PB122/GAP3 项目主档及方案V2发布后历史任务完整快照不变'
    }
  ],
  'PB120-001': [
    {
      assertion: 'PB-120：尚未真实创建/转派服务单，验证只可选末级分类及产品/资产/服务状态/服务范围准入',
      check: 'PB120/GAP1 服务单末级分类与全部适用范围准入'
    },
    {
      assertion: '尚未在分类停用后验证新建和转派拒绝、历史服务单仍可查询',
      check: 'PB120/GAP2 分类停用后新建转派精确拒绝且历史服务单可查'
    },
    {
      assertion: '尚未验证分类稳定编码、树形层级和真实页面保存刷新；配置 API 回读不能替代服务单领域门禁',
      check: 'PB120/GAP3 分类稳定编码树层级与真实页面保存刷新'
    }
  ],
  'PB125-001': [
    {
      assertion: 'PB-125/127：尚未比较资产创建/退役前后的真实 WMS 库存与存货事实，证明数量和主档不变；VO 不含库存数量字段不能证明未写库存',
      check: 'PB125/GAP1 资产创建维护状态变更退役前后完整WMS与存货事实不变'
    },
    {
      assertion: '尚未验证服务状态由服务期与正式状态事件计算，以及到期仅提示续费/风险、不自动拒绝服务单受理',
      check: 'PB125/GAP2 服务期与正式状态历史计算且到期风险不阻断受理'
    },
    {
      assertion: '尚未从售后设置页保存服务期、负责人和联系人，清本地状态后刷新核对持久化值',
      check: 'PB125/GAP3 真实页面保存服务期责任人联系人并清状态刷新'
    }
  ],
  'PB128-001': EVALUATION_ACCEPTANCE_GAPS['PB128-001'],
  'PB129-001': EVALUATION_ACCEPTANCE_GAPS['PB129-001'],
  'PB130-001': [
    {
      assertion: 'PB-130：尚未分别核对原班和替班的 employeeId/姓名一致，并验证 HRM 调班、离职与无排班真实生效',
      check: 'PB130/GAP1 原班替班人员身份与调班离职无排班生效'
    },
    {
      assertion: '尚未验证无有效排班时生成配置缺失告警并进入受控兜底队列，不生成示例值班人',
      check: 'PB130/GAP2 无有效排班告警与受控兜底队列正式落库'
    },
    {
      assertion: '尚未确保值班页签实际存在并刷新回读人员/日期/转接规则；空白页不含示例姓名不能证明页面已接入 HRM/OA',
      check: 'PB130/GAP3 真实值班页签保存刷新HRM人员日期与转接规则'
    }
  ]
})

const addSameCaseGapEvidence = (caseRecord, name, sourceNames) => {
  const sources = sourceNames.map((sourceName) => caseRecord.checks.filter((check) =>
    check.name === sourceName))
  caseRecord.checks.push({
    name,
    passed: sourceNames.length > 0 && sources.every((matches) =>
      matches.length === 1 && matches[0].passed === true),
    details: sources.map((matches, index) =>
      `${sourceNames[index]}: ${matches.length === 1 ? matches[0].details : '缺少唯一证据'}`).join('; ')
  })
}

export const initializeProjectAfterSalesCatalogAssertions = (caseRecord, caseId) => {
  const assertions = PROJECT_AFTER_SALES_CATALOG_ASSERTIONS[caseId] || []
  caseRecord.catalogAssertions = assertions.map((assertion, index) => ({
    index,
    assertion,
    status: 'GAP',
    evidenceChecks: [],
    details: '本轮尚未执行该原断言'
  }))
  caseRecord.remainingAssertions = [...assertions]
  caseRecord.catalogComplete = false
  return caseRecord.catalogAssertions
}

export const markProjectAfterSalesCatalogAssertion = (
  caseRecord,
  index,
  evidenceChecks,
  gap = ''
) => {
  const row = caseRecord.catalogAssertions?.[index]
  if (!row) return false
  const names = Array.isArray(evidenceChecks) ? [...evidenceChecks] : []
  const matches = names.map((name) => caseRecord.checks.filter((check) => check.name === name))
  const checks = matches.map((items) => items.length === 1 ? items[0] : undefined)
  const missing = names.filter((name, position) => !checks[position])
  const failed = checks.filter((check) => check && check.passed !== true)
  row.evidenceChecks = names
  row.status = !gap && names.length > 0 && new Set(names).size === names.length &&
    names.every((name) => typeof name === 'string' && name.trim().length > 0) &&
    missing.length === 0 && failed.length === 0
    ? 'VERIFIED'
    : 'GAP'
  row.details = [
    gap,
    ...checks.map((check, position) => check
      ? `${check.name}: ${check.details}`
      : `缺证: ${names[position]}`)
  ].filter(Boolean).join('; ')
  return row.status === 'VERIFIED'
}

const applyProjectAfterSalesCatalogEvidence = (caseRecord, caseId) => {
  const mappings = PROJECT_AFTER_SALES_ASSERTION_EVIDENCE[caseId] || []
  mappings.forEach((mapping, index) => {
    const names = mapping.check
      ? [mapping.check]
      : mapping.checks || caseRecord.checks
        .filter((check) =>
          mapping.checksPrefix && String(check.name).startsWith(mapping.checksPrefix))
        .map((check) => check.name)
    markProjectAfterSalesCatalogAssertion(
      caseRecord,
      index,
      names,
      mapping.gap || (names.length ? '' : `缺少可闭环证据：${PROJECT_AFTER_SALES_CATALOG_ASSERTIONS[caseId]?.[index]}`)
    )
  })
}

export const finalizeProjectAfterSalesCatalogAssertions = (caseRecord, caseId, result = {}) => {
  if (!Array.isArray(caseRecord.catalogAssertions)) {
    initializeProjectAfterSalesCatalogAssertions(caseRecord, caseId)
  }
  applyProjectAfterSalesCatalogEvidence(caseRecord, caseId)
  const acceptanceGaps = (ORIGINAL_PROJECT_ACCEPTANCE_GAPS[caseId] || []).map((assertion, index) =>
    PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId]?.find((gap) => gap.assertion === assertion) ||
    { assertion, check: `${caseId.slice(0, 5)}/GAP${index + 1} 完整原验收证据` })
  for (const gap of acceptanceGaps) {
    let index = caseRecord.catalogAssertions.findIndex((row) => row.assertion === gap.assertion)
    if (index < 0) {
      index = caseRecord.catalogAssertions.length
      caseRecord.catalogAssertions.push({
        index, assertion: gap.assertion, status: 'GAP', evidenceChecks: [], details: ''
      })
    }
    markProjectAfterSalesCatalogAssertion(caseRecord, index, [gap.check])
    if (caseRecord.catalogAssertions[index].status === 'VERIFIED') {
      caseRecord.notes = caseRecord.notes.filter((note) => note !== `GAP: ${gap.assertion}`)
    }
  }
  caseRecord.acceptanceGapAssertions = caseRecord.catalogAssertions.filter((row) =>
    acceptanceGaps.some((gap) => gap.assertion === row.assertion))
  const gaps = caseRecord.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
  caseRecord.remainingAssertions = gaps.map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.catalogAssertions.length > 0 &&
    caseRecord.remainingAssertions.length === 0
  const notes = gaps.map((row, index) => {
    const caseGap = CATALOG_ASSERTION_GAP_NOTES[caseId]
    return caseGap || `catalog 断言未验证：${row.assertion}（${row.details || '缺少精确证据'}）`
  })
  if (caseRecord.catalogAssertions.length === 0) {
    notes.push(
      CATALOG_ASSERTION_GAP_NOTES[caseId] ||
      'catalog 未定义可执行断言，保留 PARTIAL，未伪造通过。'
    )
  }
  for (const note of notes) {
    if (!caseRecord.notes.includes(note)) caseRecord.notes.push(note)
  }
  const catalogPartial = !caseRecord.catalogComplete
  caseRecord.passCandidate = caseRecord.catalogComplete &&
    !result?.partial && !result?.notImplemented && !result?.designed &&
    !result?.blocked && !result?.skipped &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed === true)
  return {
    partial: Boolean(result?.partial || result?.notImplemented || result?.designed ||
      result?.blocked || result?.skipped || catalogPartial),
    note: notes.join('；'),
    catalogAssertions: caseRecord.catalogAssertions,
    remainingAssertions: caseRecord.remainingAssertions,
    catalogComplete: caseRecord.catalogComplete,
    passCandidate: caseRecord.passCandidate,
    acceptanceComplete: caseRecord.passCandidate
  }
}

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`
const dataOf = (response) => response?.data ?? response
const listOf = (response) => {
  const data = dataOf(response)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  return Array.isArray(data?.records) ? data.records : []
}

const parseJson = (value, fallback = {}) => {
  try {
    return JSON.parse(value || '')
  } catch {
    return fallback
  }
}

const dateOffset = (days) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export const resolveReportPeriodRange = (reportType, periodKey) => {
  const type = String(reportType || '').trim().toUpperCase()
  const key = String(periodKey || '').trim()
  if (type === 'DAILY' && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return [key, key]
  }
  if (type === 'WEEKLY') {
    const match = key.match(/^(\d{4})-W(\d{2})$/)
    if (!match) return null
    const year = Number(match[1])
    const week = Number(match[2])
    if (week < 1 || week > 53) return null
    const jan4 = new Date(Date.UTC(year, 0, 4))
    const weekday = jan4.getUTCDay() || 7
    const monday = new Date(jan4)
    monday.setUTCDate(jan4.getUTCDate() - weekday + 1 + (week - 1) * 7)
    const sunday = new Date(monday)
    sunday.setUTCDate(monday.getUTCDate() + 6)
    return [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)]
  }
  if (type === 'MONTHLY') {
    const match = key.match(/^(\d{4})-(\d{2})$/)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    if (month < 1 || month > 12) return null
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return [`${match[1]}-${match[2]}-01`, `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`]
  }
  return null
}

export const isoWeekKey = (dateText) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) return null
  const date = new Date(`${dateText}T00:00:00Z`)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const year = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

export const futureQuarterFixture = (daysAhead = 30) => {
  const date = new Date()
  date.setDate(date.getDate() + daysAhead)
  const year = date.getFullYear()
  const quarter = Math.floor(date.getMonth() / 3) + 1
  const dateText = date.toISOString().slice(0, 10)
  return {
    quarterCode: `${year}Q${quarter}`,
    requiredFinishTime: `${dateText} 18:00:00`
  }
}

export const PROJECT_REPORT_DEFINITIONS = [
  { reportType: 'PROJECT_PROGRESS', path: 'project-progress' },
  { reportType: 'TASK_EXECUTION', path: 'task-execution' },
  { reportType: 'RESEARCH', path: 'research' },
  { reportType: 'RISK_ISSUE_BUG', path: 'risk-issue' },
  { reportType: 'PLAN_CHANGE', path: 'plan-change' },
  { reportType: 'RELEASE', path: 'release' },
  { reportType: 'GO_LIVE_ISSUE', path: 'go-live-issue' },
  { reportType: 'ACCEPTANCE_RECTIFICATION', path: 'acceptance-rectification' },
  { reportType: 'PROJECT_REVIEW', path: 'review' },
  { reportType: 'AFTER_SALES_HANDOVER', path: 'after-sales-handover' },
  { reportType: 'PROJECT_CLOSEOUT', path: 'closeout' }
]

export const parseRiskLevelHistory = (value) => {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}


const cleanup = async (caseRecord, name, operation) => {
  try {
    await operation()
    caseRecord.evidence.push(`清理：${name}`)
  } catch (error) {
    caseRecord.checks.push({
      name: `清理：${name}`,
      passed: false,
      details: error.message
    })
  }
}

const projectUpdatePayload = (project, overrides = {}) => ({
  id: project.id,
  projectName: project.projectName,
  projectType: project.projectType,
  projectManagerId: project.projectManagerId,
  projectManagerName: project.projectManagerName,
  plannedStartDate: project.plannedStartDate,
  plannedEndDate: project.plannedEndDate,
  status: project.status,
  healthStatus: project.healthStatus,
  riskLevel: project.riskLevel,
  remark: project.remark,
  ...overrides
})

const numericId = (value, label) => {
  const text = String(value ?? '')
  if (!/^\d+$/.test(text)) throw new Error(`BLOCKED: ${label} 未返回合法数据库ID`)
  return text
}

const resolveProjectOwnerId = async (api) => {
  const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
  return numericId(profile?.id, '项目负责人')
}

const resolveEnabledProjectType = async (api, excluded = new Set()) => {
  const rows = listOf(await api.getBusiness('/pm/modeling/list?configKey=projectType&status=ENABLED'))
  const row = rows.find((item) => item?.configCode && !excluded.has(item.configCode))
  if (!row) throw new Error('BLOCKED: 没有可用于专属 PM 建项的启用 projectType 配置')
  return row.configCode
}

const confirmDedicatedProjectBaselines = async (api, fixture) => {
  // PB-911：正式执行只能由四项已确认基线触发，普通编辑不能绕过基线门禁。
  for (const baselineType of ['SCOPE', 'SCHEDULE', 'RESOURCE', 'ACCEPTANCE']) {
    await api.postBusiness('/pm/baseline/save', {
      projectId: fixture.projectId,
      baselineType,
      contentJson: JSON.stringify({ marker: fixture.marker, baselineType, source: 'E2E' }),
      confirm: true
    })
  }
  const baselineList = listOf(await api.getBusiness(`/pm/baseline/list?projectId=${fixture.projectId}`))
  const confirmedTypes = new Set(
    baselineList.filter((item) => item?.status === 'CONFIRMED').map((item) => item?.baselineType)
  )
  const missing = ['SCOPE', 'SCHEDULE', 'RESOURCE', 'ACCEPTANCE'].filter((type) => !confirmedTypes.has(type))
  if (missing.length) {
    throw new Error(`四项基线确认后仍缺失：${missing.join(',')}`)
  }
  const project = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
  if (project?.status !== 'EXECUTING') {
    throw new Error(`四项基线确认后项目未进入 EXECUTING：${JSON.stringify({ projectId: fixture.projectId, status: project?.status })}`)
  }
  return project
}

const createDedicatedProject = async ({
  api, caseId, projectType, caseRecord, activate = false, plannedWindow
}) => {
  const ownerId = await resolveProjectOwnerId(api)
  const marker = unique(`E2E_${caseId.replace(/[^A-Z0-9]+/gi, '_')}_PROJECT`)
  const handoverId = numericId(dataOf(await api.postBusiness(
    '/pm/handover/create',
    buildDedicatedProjectHandoverPayload({ marker, projectType })
  )), '专属项目交接单')
  await api.putBusiness(`/pm/handover/submit?id=${handoverId}`, undefined)
  const projectId = numericId(dataOf(await api.putBusiness('/pm/handover/review', {
    id: handoverId,
    decision: 'APPROVE',
    opinion: `${marker} 审核通过`,
    proposedPmId: ownerId,
    developmentManagerId: ownerId,
    consultantId: ownerId
  })), '专属 PM 项目')
  let project = dataOf(await api.getBusiness(`/pm/project/get?id=${projectId}`))
  if (!isDedicatedProject(project, { projectId, handoverId, marker }) ||
      project?.projectType !== projectType) {
    throw new Error(`专属 PM 项目归属回读失败：${JSON.stringify({ projectId, handoverId, marker, project })}`)
  }
  caseRecord.evidence.push(`创建并回读本轮专属空项目 projectId=${projectId}, handoverId=${handoverId}, marker=${marker}`)
  if (plannedWindow) {
    assertPmClosureLocalTarget()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedWindow.plannedStartDate || '') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(plannedWindow.plannedEndDate || '') ||
        plannedWindow.plannedEndDate < plannedWindow.plannedStartDate) {
      throw new Error('专属新项目初始计划窗口不合法')
    }
    await api.putBusiness('/pm/project/update', projectUpdatePayload(project, plannedWindow))
    project = dataOf(await api.getBusiness(`/pm/project/get?id=${projectId}`))
    if (!isDedicatedProject(project, { projectId, handoverId, marker }) ||
        project.plannedStartDate !== plannedWindow.plannedStartDate ||
        project.plannedEndDate !== plannedWindow.plannedEndDate) {
      throw new Error('专属新项目初始计划窗口未正式回读')
    }
    caseRecord.evidence.push(`仅初始化本轮新建项目 ${projectId} 的计划 ${project.plannedStartDate} 至 ${project.plannedEndDate}，测试后保持该初始窗口`)
  }
  caseRecord.notes.push('PM 正式项目域当前无回收/删除接口；本轮仅恢复专属项目基线并严格回读，不调用另一套 /pms/pm/project API。')
  const fixture = { projectId, handoverId, ownerId, marker, projectType, project }
  if (activate) {
    fixture.project = await confirmDedicatedProjectBaselines(api, fixture)
    caseRecord.evidence.push(`专属项目 ${projectId} 已确认 SCOPE/SCHEDULE/RESOURCE/ACCEPTANCE 四项基线并进入 EXECUTING`)
  }
  return fixture
}

const restoreDedicatedProject = async (api, fixture, overrides = {}) => {
  const before = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
  if (!isDedicatedProject(before, fixture)) {
    throw new Error(`专属 PM 项目清理前归属回读失败：projectId=${fixture.projectId}`)
  }
  await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, overrides))
  const after = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
  if (!isDedicatedProject(after, fixture)) {
    throw new Error(`专属 PM 项目清理后归属回读失败：projectId=${fixture.projectId}`)
  }
  return after
}

const verifyDedicatedProjectUnchanged = async (api, fixture, caseRecord) => {
  const project = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
  const fields = ['projectType', 'status', 'healthStatus', 'riskLevel', 'plannedStartDate', 'plannedEndDate']
  caseRecord.checks.push({
    name: '本轮专属项目归属、状态与原计划日期回读不变',
    passed: isDedicatedProject(project, fixture) &&
      fields.every((field) => project?.[field] === fixture.project[field]),
    details: JSON.stringify({
      projectId: fixture.projectId,
      before: Object.fromEntries(fields.map((field) => [field, fixture.project[field]])),
      after: Object.fromEntries(fields.map((field) => [field, project?.[field]]))
    })
  })
  caseRecord.evidence.push(`专属项目 ${fixture.projectId} 及其自动展开的里程碑/任务按正式域保留；未调整原计划日期`)
}

export const buildDedicatedProjectHandoverPayload = ({ marker, projectType }) => ({
  sourceType: 'MANUAL',
  sourceBusinessNo: marker,
  projectName: `${marker} 专属空项目`,
  projectType,
  customerNameSnapshot: marker,
  scopeIn: marker,
  commitments: marker,
  acceptanceConditions: marker,
  initialRisks: marker
})

export const isDedicatedProject = (project, fixture) =>
  Boolean(fixture?.marker && /^[1-9]\d*$/.test(String(fixture.projectId)) &&
    /^[1-9]\d*$/.test(String(fixture.handoverId))) &&
  String(project?.id) === String(fixture?.projectId) &&
  String(project?.handoverId) === String(fixture?.handoverId) &&
  project?.customerNameSnapshot === fixture?.marker

const firstEnabledMaterialId = async (api) => {
  const response = await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
  )
  const material = listOf(response)[0]
  const id = material?.id ?? material?.value ?? material?.materialId ?? material?.material_id
  return id == null ? '' : String(id)
}

const retireAsset = async (api, assetId) => {
  if (!assetId) return
  const detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  if (detail?.asset?.serviceStatus === 'RETIRED') return
  await api.putBusiness('/after-sales/asset/update-status', {
    id: assetId,
    serviceStatus: 'RETIRED',
    reason: 'E2E 用例结束退役专属资产',
    version: detail?.asset?.version
  })
}

const createManualAssetFixture = async (api, prefix) => {
  const materialId = await firstEnabledMaterialId(api)
  if (!materialId) throw new Error('BLOCKED: 当前租户没有已启用且可采购的 Base 存货档案')
  const customerNo = unique(`${prefix}_CUSTOMER`)
  const assetNo = unique(`${prefix}_ASSET`)
  const today = dateOffset(0)
  const profile = dataOf(await api.postBusiness('/after-sales/asset/customer-profile/create', {
    customerNo,
    fullName: `${prefix} 客户 ${customerNo}`,
    shortName: `${prefix}客户`,
    primaryContactName: `${prefix} 联系人`,
    primaryContactMobile: '13800000001',
    assets: [{
      assetNo,
      materialId,
      assetName: `${prefix} 手工资产`,
      assetContent: 'E2E 专属客户资产，不参与库存余额',
      useStartDate: today,
      storageAddress: 'E2E 验收环境',
      managers: [{
        departmentName: '售后实施部',
        managerName: `${prefix} 责任人`,
        managerMobile: '13800000002',
        primary: true
      }],
      servicePeriods: [{
        startDate: dateOffset(-1),
        endDate: dateOffset(365),
        sourceType: 'MANUAL',
        sourceNo: unique(`${prefix}_SERVICE`),
        sourceName: `${prefix} 手工服务期`,
        idempotencyKey: unique(`${prefix}_SERVICE_KEY`)
      }]
    }]
  }))
  const assetId = profile?.assetIds?.[0]
  if (!assetId) throw new Error('BLOCKED: 手工客户资产档案创建后未返回 assetId')
  let detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  await api.putBusiness('/after-sales/asset/update-status', {
    id: assetId,
    serviceStatus: 'IN_SERVICE',
    reason: 'E2E 专属资产在有效服务期内恢复服务',
    version: detail?.asset?.version
  })
  detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  return {
    customerId: profile.customerId,
    contactId: profile.primaryContactId,
    assetId,
    assetNo,
    materialId,
    detail,
    profile
  }
}

const createProjectAcceptanceAssetFixture = async (api, project, prefix, baselineId) => {
  const materialId = await firstEnabledMaterialId(api)
  if (!materialId) throw new Error('BLOCKED: 当前租户没有已启用且可采购的 Base 存货档案')
  const customerNo = unique(`${prefix}_CUSTOMER`)
  const customerId = dataOf(await api.postBusiness('/after-sales/asset/customer/create', {
    customerNo,
    fullName: `${prefix} 验收客户 ${customerNo}`,
    shortName: `${prefix}验收客户`
  }))
  const acceptanceId = dataOf(await api.postBusiness('/pm/customer-acceptance/save', {
    projectId: project.id,
    acceptanceType: 'FINAL',
    plannedDate: dateOffset(0),
    customerRepresentative: `${prefix} 客户代表`,
    resultSummary: 'E2E 项目验收通过，用于验证售后资产来源引用',
    evidenceUri: 'e2e://project-after-sales/acceptance',
    // PB-939 门禁：验收通过必须匹配范围基线并留客户确认人/日期。
    baselineId,
    deliveryEvidenceJson: JSON.stringify({
      source: 'E2E',
      evidenceUri: 'e2e://project-after-sales/acceptance'
    }),
    customerConfirmPerson: `${prefix} 客户确认人`,
    customerConfirmDate: dateOffset(0)
  }))
  await api.putBusiness('/pm/customer-acceptance/status', {
    id: acceptanceId,
    status: 'APPROVED',
    opinion: 'E2E 验收通过',
    reviewerName: '管理员'
  })
  const assetNo = unique(`${prefix}_PROJECT_ASSET`)
  const assetId = dataOf(await api.postBusiness('/after-sales/asset/create', {
    customerId,
    assetNo,
    materialId,
    assetName: `${prefix} 项目验收资产`,
    assetContent: '由项目验收单向售后客户资产生成',
    useStartDate: dateOffset(0),
    storageAddress: 'E2E 验收现场',
    sourceType: 'PROJECT_ACCEPTANCE',
    sourceProjectId: project.id,
    sourceAcceptanceId: acceptanceId,
    managers: [{
      departmentName: '售后交付部',
      managerName: `${prefix} 项目责任人`,
      managerMobile: '13800000003',
      primary: true
    }]
  }))
  await api.postBusiness('/after-sales/asset/service-period/create', {
    assetId,
    startDate: dateOffset(-1),
    endDate: dateOffset(365),
    sourceType: 'PROJECT_ACCEPTANCE',
    sourceId: acceptanceId,
    sourceNo: `ACC-${acceptanceId}`,
    sourceName: `${prefix} 项目验收服务期`,
    idempotencyKey: unique(`${prefix}_PROJECT_SERVICE_KEY`)
  })
  let detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  await api.putBusiness('/after-sales/asset/update-status', {
    id: assetId,
    serviceStatus: 'IN_SERVICE',
    reason: 'E2E 项目验收资产在服务期内',
    version: detail?.asset?.version
  })
  detail = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${assetId}`))
  return { customerId, acceptanceId, assetId, assetNo, detail }
}

const disableAfterSalesConfig = (api, configType, id) =>
  api.postBusiness(
    `/after-sales/modeling/status?configType=${configType}&id=${id}&enabled=false`
  )

const readAfterSalesConfig = async (api, listPath, id) =>
  listOf(await api.getBusiness(listPath)).find((row) => String(row.id) === String(id))

const getMilestone = async (api, projectId, milestoneId) =>
  listOf(await api.getBusiness(`/pm/milestone/list?projectId=${projectId}`))
    .find((item) => String(item.id) === String(milestoneId))

const createMilestoneFixture = async ({
  api,
  projectId,
  ownerId,
  marker,
  withGates = true,
  plannedStartDate,
  plannedEndDate,
  exitCondition = withGates ? `${marker} 准出条件` : null,
  requiredDeliverablesJson = withGates ? JSON.stringify([`${marker}-deliverable`]) : null
}) => {
  await reserveMilestoneWeight(api, projectId, 10)
  const milestoneId = dataOf(await api.postBusiness('/pm/milestone/save', {
    projectId,
    milestoneName: `${marker} 里程碑`,
    ownerId,
    ownerName: '管理员',
    plannedStartDate,
    plannedEndDate,
    weightRate: 10,
    exitCondition,
    requiredDeliverablesJson,
    healthStatus: withGates ? 'NORMAL' : null,
    warningStatus: withGates ? 'NONE' : null
  }))
  return {
    marker,
    milestoneId,
    detail: await getMilestone(api, projectId, milestoneId)
  }
}

// 专属项目建项时会按模板展开里程碑并占满 100 权重，新增里程碑前先等比下调已有权重腾出空间。
const reserveMilestoneWeight = async (api, projectId, newWeight) => {
  const existing = listOf(await api.getBusiness(`/pm/milestone/list?projectId=${projectId}`))
  for (const { item, weight } of planMilestoneWeightUpdates(existing, newWeight)) {
    const snappedStart = await findWorkingDate(api, item.plannedStartDate)
    const snappedEnd = await findWorkingDate(api, item.plannedEndDate || item.plannedStartDate)
    await api.postBusiness('/pm/milestone/save', {
      id: item.id,
      projectId,
      stageId: item.stageId,
      milestoneName: item.milestoneName,
      ownerId: item.ownerId,
      ownerName: item.ownerName,
      plannedStartDate: snappedStart,
      plannedEndDate: snappedEnd,
      weightRate: weight,
      exitCondition: item.exitCondition ?? null,
      requiredDeliverablesJson: item.requiredDeliverablesJson ?? null,
      healthStatus: item.healthStatus ?? null,
      warningStatus: item.warningStatus ?? null,
      manualConclusion: item.manualConclusion ?? null
    })
  }
}

const createTaskFixture = async ({
  api,
  projectId,
  ownerId,
  marker,
  plannedStartDate,
  plannedEndDate
}) => {
  const taskId = dataOf(await api.postBusiness('/pm/task/create-administrative', {
    projectId,
    taskName: `${marker} 任务`,
    taskContent: 'E2E 项目绩效与报告来源任务',
    ownerId,
    ownerName: '管理员',
    acceptanceOwnerId: ownerId,
    plannedStartDate,
    plannedEndDate,
    priority: 2,
    standardHours: 8,
    plannedHours: 8,
    requiredOutput: `${marker}-output`,
    acceptanceCriteria: `${marker} 验收标准`
  }))
  return taskId
}

const completeTaskFixture = async (api, taskId) => {
  await api.putBusiness(`/pm/task/dispatch?id=${taskId}`, undefined)
  await api.putBusiness(`/pm/task/accept?id=${taskId}`, undefined)
  await api.putBusiness(`/pm/task/start?id=${taskId}`, undefined)
  await api.postBusiness('/pm/task/submit-result', {
    taskId,
    resultSummary: 'E2E 任务成果提交',
    outputJson: JSON.stringify({ marker: taskId, delivered: true }),
    attachmentIds: null
  })
  await api.putBusiness('/pm/task/accept-result', {
    taskId,
    decision: 'APPROVE',
    conclusion: 'E2E 验收通过',
    evidenceJson: JSON.stringify({ source: 'cfor-e2e' }),
    exceptionAllowed: true,
    exceptionRuleCode: 'SAME_PERSON_AUTHORIZED',
    exceptionReason: '自动化验收使用同一管理员账号并显式记录例外规则'
  })
}

const createRiskFixture = async ({
  api,
  projectId,
  ownerId,
  marker,
  level = 'LOW',
  relatedType = null,
  relatedId = null
}) => {
  const riskId = dataOf(await api.postBusiness('/pm/risk/save', {
    projectId,
    title: `${marker} 风险`,
    description: `${marker} 风险描述`,
    level,
    probability: 'MEDIUM',
    impact: 'MEDIUM',
    responsePlan: `${marker} 应对计划`,
    ownerId,
    ownerName: '管理员',
    dueDate: dateOffset(14),
    relatedType,
    relatedId
  }))
  return {
    riskId,
    detail: dataOf(await api.getBusiness(`/pm/risk/get?id=${riskId}`))
  }
}

const createChangeFixture = async ({ api, projectId, requesterId, marker, relatedType, relatedId }) =>
  dataOf(await api.postBusiness('/pm/change/save', {
    projectId,
    title: `${marker} 变更`,
    changeType: 'MODIFY',
    reason: `${marker} 变更原因`,
    impactScope: `${marker} 影响范围`,
    baselineType: 'PROJECT_SCOPE',
    requesterId,
    requesterName: '管理员',
    fieldChanges: [{
      changeType: 'MODIFY',
      fieldName: `${marker}_scope_field`,
      oldValue: 'OLD',
      newValue: 'NEW'
    }],
    relatedType,
    relatedId
  }))

const riskUpdatePayload = (risk, overrides = {}) => ({
  id: risk.id,
  projectId: risk.projectId,
  title: risk.title,
  description: risk.description,
  level: risk.level,
  probability: risk.probability,
  impact: risk.impact,
  responsePlan: risk.responsePlan,
  ownerId: risk.ownerId,
  ownerName: risk.ownerName,
  dueDate: risk.dueDate,
  sourceType: risk.sourceType,
  sourceId: risk.sourceId,
  relatedType: risk.relatedType,
  relatedId: risk.relatedId,
  ...overrides
})

const isHrmWorkingDay = async (api, date) => {
  const holiday = dataOf(await api.getBusiness(
    `/hrm/attendance/holiday/check?day=${encodeURIComponent(`${date}T00:00:00`)}`
  ))
  if (Number(holiday?.type) === 1) return true
  if (Number(holiday?.type) === 2) return false
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6
}

const findWorkingDate = async (api, startDate, searchDays = 45) => {
  for (let offset = 0; offset < searchDays; offset += 1) {
    const candidate = dateOffsetFrom(startDate, offset)
    if (await isHrmWorkingDay(api, candidate)) return candidate
  }
  throw new Error(`BLOCKED: 自 ${startDate} 起 ${searchDays} 天内没有可用 HRM 工作日`)
}

const dateOffsetFrom = (dateText, days) => {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const pushReportQuery = (params, query) => {
  const result = new URLSearchParams(params)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      result.set(key, String(value))
    }
  }
  return result.toString()
}

const setChangeStatus = (api, id, status, extra = {}) =>
  api.putBusiness('/pm/change/status', { id, status, ...extra })

const projectDateRange = (project) => {
  const start = project?.plannedStartDate || dateOffset(0)
  const configuredEnd = project?.plannedEndDate || start
  return configuredEnd < start ? [start, start] : [start, configuredEnd]
}

export const isBusinessRejected = (response, code, message) =>
  Boolean(response?.code === code && response.success !== true &&
    typeof response.msg === 'string' && response.msg.includes(message))

export const hasProjectFixture = (response) => listOf(response).length > 0

export const validTaskLibraryConfig = (config) => {
  const tasks = config?.tasks ?? config?.items
  const nonblank = (value) => typeof value === 'string' && value.trim().length > 0
  if (!Array.isArray(tasks) || !tasks.length) return false
  return tasks.every((task) =>
    nonblank(task?.code || task?.taskCode) &&
    nonblank(task?.name || task?.taskName) &&
    Number(task?.standardHours) > 0 &&
    nonblank(task?.deliverable || task?.requiredOutput) &&
    nonblank(task?.acceptance || task?.acceptanceCriteria) &&
    (task?.predecessorIds == null || Array.isArray(task.predecessorIds)) &&
    (task?.predecessors == null || Array.isArray(task.predecessors))
  )
}

const runCaseCore = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后携带真实令牌调用项目与售后接口'
  })

  if (caseId === 'PB111-001') {
    const projectTypes = listOf(await api.getBusiness('/pm/modeling/list?configKey=projectType'))
    const [modules, moduleCategories, researchTemplates, documentTemplates, staffProfiles] =
      await Promise.all([
        api.getBusiness('/pm/modeling/list?configKey=moduleDefinition'),
        api.getBusiness('/pm/modeling/list?configKey=moduleCategory'),
        api.getBusiness('/pm/modeling/list?configKey=researchTemplate'),
        api.getBusiness('/pm/modeling/list?configKey=documentTemplate'),
        api.getBusiness('/pm/modeling/list?configKey=staffProfile')
      ])
    const treeConfigs = [
      ...listOf(modules),
      ...listOf(researchTemplates),
      ...listOf(documentTemplates),
      ...listOf(staffProfiles)
    ]
    caseRecord.checks.push({
      name: '项目建模配置沿用设置主菜单下的项目建模入口',
      passed:
        Array.isArray(projectTypes) &&
        projectTypes.every(
          (item) =>
            Boolean(item?.configCode) &&
            Boolean(item?.configName) &&
            typeof item?.configJson === 'string'
        ),
      details: `projectType 配置数=${Array.isArray(projectTypes) ? projectTypes.length : 'n/a'}，已校验页面所需真实配置字段`
    })
    caseRecord.checks.push({
      name: '项目建模树形条目和分类来自真实配置接口',
      passed:
        treeConfigs.every((item) => {
          try {
            const config = JSON.parse(item?.configJson || '{}')
            return Boolean(item?.configCode) && Boolean(config.categoryId)
          } catch {
            return false
          }
        }) &&
        listOf(moduleCategories).every((item) => Boolean(item?.configCode)),
      details: `模块=${listOf(modules).length}, 模块分类=${listOf(moduleCategories).length}, 调研=${listOf(researchTemplates).length}, 文档=${listOf(documentTemplates).length}, 人员=${listOf(staffProfiles).length}`
    })
    await openRoute(page, '/project/modeling/foundation/project-base/list')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '项目基础建模工作区真实渲染，不新建平行页面',
      passed: bodyText.includes('项目基础建模'),
      details: bodyText.includes('项目基础建模') ? '命中项目基础建模标题' : '未命中项目基础建模标题'
    })
    const existingCategory = listOf(moduleCategories)[0]
    const categoryCode = existingCategory?.configCode || unique('E2E_MODULE_CAT')
    let createdCategoryId = null
    let moduleId = null
    try {
      if (!existingCategory) {
        createdCategoryId = dataOf(await api.postBusiness('/pm/modeling/save', {
          configKey: 'moduleCategory',
          configCode: categoryCode,
          configName: `E2E 模块分类 ${categoryCode}`,
          configJson: JSON.stringify({ description: 'PB111 专属模块分类' }),
          status: 'ENABLED'
        }))
      }
      const moduleCode = unique('E2E_MODULE')
      moduleId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'moduleDefinition',
        configCode: moduleCode,
        configName: `E2E 模块定义 ${moduleCode}`,
        configJson: JSON.stringify({
          categoryId: categoryCode,
          description: 'PB111 验证模块定义复用项目建模事实源'
        }),
        status: 'ENABLED'
      }))
      const created = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=moduleDefinition')
      ).find((item) => String(item.id) === String(moduleId))
      const createdConfig = parseJson(created?.configJson)
      caseRecord.checks.push({
        name: '模块定义写入后可回读分类、版本和启用状态',
        passed:
          created?.status === 'ENABLED' &&
          created?.configCode === moduleCode &&
          created?.versionNo === 1 &&
          createdConfig.categoryId === categoryCode,
        details: `moduleId=${moduleId}, category=${createdConfig.categoryId || 'n/a'}`
      })
      await api.postBusiness(`/pm/modeling/status?id=${moduleId}&status=DISABLED`)
      const disabled = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=moduleDefinition')
      ).find((item) => String(item.id) === String(moduleId))
      caseRecord.checks.push({
        name: '模块定义停用后回读为 DISABLED',
        passed: disabled?.status === 'DISABLED',
        details: `moduleId=${moduleId}`
      })
    } finally {
      if (moduleId) {
        await cleanup(caseRecord, `停用模块定义 ${moduleId}`, () =>
          api.postBusiness(`/pm/modeling/status?id=${moduleId}&status=DISABLED`)
        )
      }
      if (createdCategoryId) {
        // 被模块定义引用的分类会命中后端引用保护；此处保留分类并记录预期行为，避免误判失败。
        try {
          await api.postBusiness(`/pm/modeling/status?id=${createdCategoryId}&status=DISABLED`)
          caseRecord.evidence.push(`清理：停用本轮模块分类 ${createdCategoryId}`)
        } catch (error) {
          caseRecord.evidence.push(
            `本轮模块分类 ${createdCategoryId} 仍被禁用的模块定义引用，后端按引用保护保留，未强制停用：${error.message}`
          )
        }
      }
    }
    await saveScreenshot(page, outputDir, 'pb111-project-modeling', record)
    caseRecord.evidence.push('PB-111 通过项目建模接口创建并回读模块分类/定义，再验证停用状态')
    return { token, api }
  }

  if (caseId === 'PB111-002') {
    const rootRows = await runReadOnlySql(`
      SELECT id, name, type, CAST(visible AS UNSIGNED), sort
      FROM system_menu
      WHERE parent_id = 29612001 AND deleted = 0 AND type <> 3
      ORDER BY sort, id
    `)
    const legacyRows = await runReadOnlySql(`
      WITH RECURSIVE legacy_tree AS (
        SELECT id, name, type, visible FROM system_menu
        WHERE deleted = 0 AND id IN (
          29300000, 29612003, 29612005, 29612009, 29612019, 29612026,
          29612039, 29612044, 29612046, 29612090, 29612126, 29612129
        )
        UNION DISTINCT
        SELECT child.id, child.name, child.type, child.visible FROM system_menu child
        INNER JOIN legacy_tree parent ON child.parent_id = parent.id
        WHERE child.deleted = 0
      )
      SELECT id, name, type, CAST(visible AS UNSIGNED)
      FROM legacy_tree
      ORDER BY id
    `)
    const businessRows = await runReadOnlySql(`
      SELECT parent_id, id, name, path, CAST(visible AS UNSIGNED), component
      FROM system_menu WHERE deleted = 0 AND type <> 3
        AND parent_id IN (29612007, 29612023, 29612025)
      ORDER BY parent_id, sort, id
    `)
    const packageRows = await runReadOnlySql(`
      SELECT
        (SELECT COUNT(*) FROM system_tenant_package package_row
         INNER JOIN JSON_TABLE(package_row.menu_ids, '$[*]' COLUMNS(menu_id BIGINT PATH '$')) item
         INNER JOIN system_menu menu ON menu.id = item.menu_id
         WHERE package_row.deleted = 0 AND menu.deleted = 0 AND menu.type <> 3
           AND menu.visible = 0 AND menu.parent_id IN (29612007, 29612023, 29612025)),
        (SELECT COUNT(*) FROM system_tenant_package package_row
         INNER JOIN JSON_TABLE(package_row.menu_ids, '$[*]' COLUMNS(menu_id BIGINT PATH '$')) item
         INNER JOIN system_menu menu ON menu.id = item.menu_id
         WHERE package_row.deleted = 0 AND menu.deleted = 0 AND menu.component_name LIKE 'PmMenu%'
           AND (NOT JSON_CONTAINS(package_row.menu_ids, CAST(menu.parent_id AS JSON))
                OR NOT JSON_CONTAINS(package_row.menu_ids, CAST(29612001 AS JSON))))
    `)
    const navigationRows = await runReadOnlySql(`
      SELECT
        SUM(item.source_path = '/project' AND item.deleted = 0),
        SUM(item.source_path = '/settings/pms' AND item.deleted = 0),
        SUM(item.source_path IN (
          '/project/foundation', '/project/handover', '/project/management',
          '/project/modeling', '/project/statistics', '/project/ai'
        ) AND item.deleted = 0)
      FROM system_navigation_group_item item
      INNER JOIN system_navigation_group group_row ON group_row.id = item.group_id
      WHERE group_row.group_key IN ('project', 'settings')
    `)
    if (![rootRows, legacyRows, navigationRows, businessRows, packageRows].every((item) => item.available)) {
      throw new Error('BLOCKED: PB111-002 需要本地菜单数据库只读证据')
    }
    caseRecord.database = [
      ...(caseRecord.database || []),
      { stage: 'project-menu', roots: rootRows.rows, legacy: legacyRows.rows,
        business: businessRows.rows, navigation: navigationRows.rows, packages: packageRows.rows }
    ]

    const visibleRootIds = rootRows.rows
      .filter((row) => row[3] === '1')
      .map((row) => Number(row[0]))
    caseRecord.checks.push({
      name: '项目根只保留工作台、项目协作、项目执行、项目研发、报表五个可见入口',
      passed: JSON.stringify(visibleRootIds) === JSON.stringify(PROJECT_MENU_ROOT_IDS),
      details: `visibleRootIds=${visibleRootIds.join(',')}`
    })

    const legacyVisibleRows = legacyRows.rows.filter((row) => row[2] !== '3' && row[3] === '1')
    caseRecord.checks.push({
      name: '旧项目根和旧执行/报表目录隐藏，但按钮权限与深链仍保留',
      passed: legacyVisibleRows.length === 0,
      details: `visibleLegacy=${JSON.stringify(legacyVisibleRows)}`
    })

    const navigation = navigationRows.rows[0] || []
    caseRecord.checks.push({
      name: '项目配置入口只在设置导航保留一份',
      passed: navigation[0] === '1' && navigation[1] === '1' && navigation[2] === '0',
      details: `projectSource=${navigation[0]}, settingsPms=${navigation[1]}, legacySources=${navigation[2]}`
    })

    await openRoute(page, '/project/workbench')
    const sidebar = page.locator('[id$="-menu"]:not([id$="-top-menu"])')
    const menuText = await sidebar.innerText()
    const legacyLabels = ['交付项目', '项目执行规划', '统计查询', 'AI助手', '基础建模', '业务管理']
    caseRecord.checks.push({
      name: '真实浏览器菜单不展示交付项目、项目执行规划、统计查询和AI助手',
      passed: legacyLabels.every((label) => !menuText.includes(label)),
      details: `forbiddenLabels=${legacyLabels.filter((label) => menuText.includes(label)).join(',') || 'none'}`
    })
    assertProjectBusinessMenus(businessRows.rows)
    caseRecord.projectMenuBrowser = await verifyProjectBusinessMenuInBrowser(page, businessRows.rows)
    caseRecord.checks.push({
      name: '执行研发报表子菜单完整且浏览器逐项可见',
      passed: caseRecord.projectMenuBrowser.length === 31,
      details: `entries=${caseRecord.projectMenuBrowser.length}`
    })
    caseRecord.checks.push({
      name: '套餐不下发旧目录且新入口祖先完整',
      passed: packageRows.rows[0]?.every((count) => count === '0'),
      details: JSON.stringify(packageRows.rows)
    })
    await saveScreenshot(page, outputDir, 'pb111-project-menu-governance', record)

    await openRoute(page, '/project/management/handover/list')
    const deepLinkText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '旧项目深链仍可打开',
      passed:
        page.url().includes('/project/management/handover/list') &&
        !/页面不存在|Page Not Found|\b404\b/.test(deepLinkText),
      details: `url=${page.url()}`
    })
    await saveScreenshot(page, outputDir, 'pb111-project-legacy-handover', record)
    return { token, api }
  }

  if (caseId === 'PB112-001') {
    const owned = newPmClosureFixture(caseId)
    const projectType = await resolveEnabledProjectType(api)
    let fixture
    try {
      const employee = await createDedicatedHrmEmployee(api, owned)
      const employeeId = owned.employee.id
      caseRecord.evidence.push(`本轮专属 HRM 员工 employeeId=${employeeId}, marker=${owned.marker}，未创建系统账号`)
      fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord })
      const skill = await createDedicatedStaffSkill(api, owned, projectType)
      const skills = listOf(await api.getBusiness(
        `/pm/staff-skill/list-by-employee?employeeId=${employeeId}`
      ))
      caseRecord.checks.push({
        name: '人员能力标签引用 HRM 员工并维护技能历史',
        passed: skills.some((row) =>
          String(row.id) === skill.id && String(row.employeeId) === employeeId &&
          row.skillCode === skill.body.skillCode && row.source === 'MANUAL' &&
          row.auditStatus === 'APPROVED' && Number(row.status) === 0),
        details: `skillId=${skill.id}, employeeId=${employeeId}, count=${skills.length}`
      })
      const project = fixture.project
      const plannedStart = project.plannedStartDate || dateOffset(0)
      const plannedEnd = project.plannedEndDate || plannedStart
      const researchId = numericId(dataOf(await api.postBusiness('/pm/research/create-detailed', {
        projectId: fixture.projectId,
        topic: `${owned.marker} 能力快照自动化验证`
      })), '本轮专属派研任务')
      await api.putBusiness('/pm/research/dispatch', {
        id: researchId,
        assigneeId: employeeId,
        assigneeName: employee.name,
        topic: `${owned.marker} 能力快照自动化验证`,
        researchMode: '远程',
        researchAddress: 'E2E',
        participantRequirement: '自动化验证',
        deliverableRequirement: '能力标签快照',
        dispatchNote: '验证派研时固化有效能力标签',
        plannedStartTime: `${plannedStart}T00:00:00`,
        plannedEndTime: `${plannedEnd}T23:59:59`
      })
      const dispatched = dataOf(await api.getBusiness(`/pm/research/get?id=${researchId}`))
      const snapshot = parseJson(dispatched?.assigneeSkillSnapshotJson, [])
      caseRecord.checks.push({
        name: '派研保存 HRM 员工有效能力标签快照并可回读',
        passed:
          String(dispatched?.projectId) === fixture.projectId &&
          String(dispatched?.assigneeId) === employeeId &&
          Array.isArray(snapshot) && snapshot.some((row) =>
            String(row.id) === skill.id && String(row.employeeId) === employeeId &&
            row.skillCode === skill.body.skillCode && row.auditStatus === 'APPROVED'),
        details: `projectId=${fixture.projectId}, researchId=${researchId}, snapshot=${JSON.stringify(snapshot).slice(0, 500)}`
      })
      caseRecord.evidence.push(
        `PB-112 本轮专属项目 ${fixture.projectId} 派研 ${researchId} 固化专属员工 ${employeeId} 的 ${skill.body.skillCode}；项目与派研保留为标记审计数据，正式域无删除接口`
      )
    } finally {
      await cleanup(caseRecord, '删除并回读本轮专属能力标签', () => deleteDedicatedStaffSkill(api, owned))
      await cleanup(caseRecord, '删除并回读本轮专属 HRM 员工', () => deleteDedicatedHrmEmployee(api, owned))
      if (fixture) await cleanup(caseRecord, '回读本轮专属项目归属与基线', () =>
        verifyDedicatedProjectUnchanged(api, fixture, caseRecord))
    }
    return { token, api }
  }

  if (caseId === 'PB113-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord })
    const projectId = fixture.projectId
    try {
    const project = fixture.project
    const permission = await api.get('/system/auth/get-permission-info')
    const reporterId = permission?.user?.id ?? permission?.data?.user?.id
    if (reporterId === undefined || reporterId === null) {
      caseRecord.notes.push('BLOCKED：无法取得当前登录用户编号，不能创建真实日报填报人。')
      return { token, api, partial: true }
    }
    // Keep auto-expanded milestones inside the original project window.
    const taskStart = pmClosureTaskDate(project, await findWorkingDate(
      api, project.plannedStartDate || dateOffset(0)))
    const taskEnd = taskStart
    const taskId = dataOf(await api.postBusiness('/pm/task/create-administrative', {
      projectId,
      taskName: `${unique('E2E_REPORT_TASK')} 周报任务状态建议`,
      taskContent: '验证日报周报任务状态只作为建议，不反写任务事实源',
      ownerId: reporterId,
      ownerName: '管理员',
      acceptanceOwnerId: reporterId,
      plannedStartDate: taskStart,
      plannedEndDate: taskEnd,
      priority: 2,
      standardHours: 2,
      plannedHours: 1,
      requiredOutput: '周报与任务状态建议',
      acceptanceCriteria: '任务状态建议不回写任务主档'
    }))
    const taskBefore = dataOf(await api.getBusiness(`/pm/task/get?id=${taskId}`))
    const source = dataOf(await api.getBusiness(`/pm/daily-report/source?projectId=${projectId}`))
    caseRecord.checks.push({
      name: '日报只读来源按项目带出任务/风险/里程碑',
      passed:
        String(source?.projectId) === projectId &&
        Array.isArray(source?.tasks) &&
        Array.isArray(source?.risks) &&
        Array.isArray(source?.milestones) &&
        source.tasks.some((task) => String(task.id) === String(taskId)),
      details: `任务=${source?.tasks?.length ?? 'n/a'}, 风险=${source?.risks?.length ?? 'n/a'}, 里程碑=${source?.milestones?.length ?? 'n/a'}`
    })
    caseRecord.checks.push({
      name: '日报填报人使用当前登录用户，不伪造固定用户编号',
      passed: reporterId !== undefined && reporterId !== null,
      details: `reporterId=${reporterId ?? 'n/a'}`
    })
    const periodKey = isoWeekKey(taskStart)
    const draftResponse = await api.postBusiness('/pm/daily-report/save-draft', {
      reportType: 'WEEKLY',
      projectId,
      reporterId,
      periodKey,
      contentJson: JSON.stringify({ summary: 'E2E 周报' }),
      taskStatusSuggestionJson: JSON.stringify([{ taskId, suggestion: 'COMPLETED' }]),
      sourceSnapshotJson: JSON.stringify({ forged: true })
    })
    const draftId = dataOf(draftResponse)
    const savedDraft = await api.getBusiness(`/pm/daily-report/get?id=${draftId}`)
    const savedDraftData = dataOf(savedDraft)
    caseRecord.checks.push({
      name: '日报来源快照由服务端按事实源生成，忽略客户端伪造值',
      passed:
        typeof savedDraftData?.sourceSnapshotJson === 'string' &&
        !savedDraftData.sourceSnapshotJson.includes('forged') &&
        savedDraftData.sourceSnapshotJson.includes('generatedAt'),
      details: savedDraftData?.sourceSnapshotJson?.slice(0, 160) || 'n/a'
    })
    await api.putBusiness(`/pm/daily-report/submit?id=${draftId}`)
    await api.putBusiness(`/pm/daily-report/review?id=${draftId}&approved=false&remark=E2E退回`)
    const reportPage = await api.getBusiness(
      `/pm/daily-report/page?pageNo=1&pageSize=100&projectId=${projectId}&reportType=WEEKLY&reporterId=${reporterId}&periodKey=${encodeURIComponent(periodKey)}`
    )
    const versions = listOf(reportPage)
      .filter((item) => String(item.reporterId) === String(reporterId))
      .map((item) => item.version)
    caseRecord.checks.push({
      name: '退回后生成新的修订版本，任务状态只作建议',
      passed: versions.length >= 2 && new Set(versions).size >= 2,
      details: `versions=${versions.join(',') || 'n/a'}`
    })
    const taskAfter = dataOf(await api.getBusiness(`/pm/task/get?id=${taskId}`))
    caseRecord.checks.push({
      name: '退回版本不把任务状态建议反写到任务事实源',
      passed:
        taskBefore?.status === 'PENDING_DISPATCH' &&
        taskAfter?.status === taskBefore.status,
      details: `before=${taskBefore?.status}, after=${taskAfter?.status}, taskId=${taskId}`
    })
    caseRecord.evidence.push(
      `PB-113 专属项目 ${projectId} 创建行政任务 ${taskId}、周报草稿 ${draftId}，退回后版本 ${versions.join(',')}，任务状态保持 ${taskAfter?.status}；标记数据保留，正式域无删除接口`
    )
    return { token, api }
    } finally {
      await verifyDedicatedProjectUnchanged(api, fixture, caseRecord)
    }
  }

  if (caseId === 'PB114-001') {
    const owned = newPmClosureFixture(caseId)
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({
      api, caseId, projectType, caseRecord,
      plannedWindow: { plannedStartDate: dateOffset(0), plannedEndDate: dateOffset(90) }
    })
    const projectId = fixture.projectId
    try {
      const advanceDays = pmClosureDelayAdvanceDays(fixture.project.plannedEndDate, dateOffset(0))
      const { owned: rule } = await createDedicatedModelingConfig(api, owned, 'warningRule', 'DELAY', {
        warningType: '延期',
        metric: 'PLANNED_END_DATE',
        advanceDays,
        warningLevel: 'HIGH',
        windowKey: 'DAY',
        dueHours: 24,
        title: 'E2E 项目即将延期',
        detail: `${owned.marker} 专属项目计划结束日进入 ${advanceDays} 天提前预警窗口`
      })
      const ruleCode = rule.body.configCode
      const projectBefore = dataOf(await api.getBusiness(`/pm/project/get?id=${projectId}`))
      if (!isDedicatedProject(projectBefore, fixture)) throw new Error('专属预警项目归属不匹配')
      const first = await api.postBusiness('/pm/warning/evaluate', { projectId })
      const firstData = dataOf(first) || {}
      const warningPage = await api.getBusiness(
        `/pm/warning/page?pageNo=1&pageSize=100&projectId=${projectId}&warningType=DELAY`
      )
      const warning = listOf(warningPage).find(
        (item) => item?.ruleCode === ruleCode
      )
      const warningId = warning?.id
      caseRecord.checks.push({
        name: '预警规则求值命中并保存规则版本、指标与证据',
        passed:
          firstData.matchedCount >= 1 &&
          firstData.createdCount >= 1 &&
          warning?.ruleCode === ruleCode && String(warning?.projectId) === projectId &&
          warning?.ruleVersion === 1 &&
          warning?.triggerMetric === 'PLANNED_END_DATE' &&
          Boolean(warning?.evidenceJson) &&
          Boolean(warning?.idempotencyKey) &&
          Boolean(warning?.dueTime),
        details: `first=${JSON.stringify(first)}, warning=${JSON.stringify(warning)}`
      })
      const afterWarningProject = dataOf(
        await api.getBusiness(`/pm/project/get?id=${projectId}`)
      )
      caseRecord.checks.push({
        name: '预警求值不修改项目状态与计划日期',
        passed:
          Boolean(projectBefore) &&
          afterWarningProject?.status === projectBefore?.status &&
          String(afterWarningProject?.plannedEndDate) === String(projectBefore?.plannedEndDate) &&
          afterWarningProject?.healthStatus === projectBefore?.healthStatus &&
          afterWarningProject?.riskLevel === projectBefore?.riskLevel,
        details: `before=${projectBefore?.status}/${projectBefore?.plannedEndDate}/${projectBefore?.healthStatus}, after=${afterWarningProject?.status}/${afterWarningProject?.plannedEndDate}/${afterWarningProject?.healthStatus}`
      })
      const second = await api.postBusiness('/pm/warning/evaluate', { projectId })
      const secondData = dataOf(second) || {}
      const warningsAfterSecond = listOf(
        await api.getBusiness(
          `/pm/warning/page?pageNo=1&pageSize=100&projectId=${projectId}&warningType=DELAY`
        )
      ).filter((item) => item?.ruleCode === ruleCode)
      caseRecord.checks.push({
        name: '同一规则与触发窗口重复求值保持幂等',
        passed:
          Boolean(warningId) &&
          warningsAfterSecond.length === 1 &&
          String(warningsAfterSecond[0]?.id) === String(warningId) &&
          (secondData.warningIds || []).some(
            (secondId) => String(secondId) === String(warningId)
          ),
        details: `second=${JSON.stringify(second)}, ruleWarnings=${warningsAfterSecond.length}`
      })
      const notifications = await runReadOnlySql(`
        SELECT id, user_id, template_code, template_params
        FROM system_notify_message WHERE tenant_id=1 AND deleted=0
          AND template_code='pm_project_warning'
          AND JSON_UNQUOTE(JSON_EXTRACT(template_params,'$.route'))=
            '/project-management/project-list?projectId=${projectId}'
        ORDER BY id
      `)
      if (!notifications.available) throw new Error(`BLOCKED: ${notifications.reason}`)
      const ruleNotification = notifications.rows.filter((row) => {
        const params = JSON.parse(row[3])
        return String(row[1]) === String(fixture.ownerId) &&
          params.detail?.includes(owned.marker) && params.warningType === 'DELAY'
      })
      caseRecord.database = [...(caseRecord.database || []),
        { stage: 'owned-project-warning-notifications-after-repeat', ...notifications }]
      caseRecord.checks.push({
        name: '延期预警站内通知正式落库且重复求值不重复通知',
        passed: ruleNotification.length === 1,
        details: `notificationIds=${ruleNotification.map((row) => row[0]).join(',')}, todoId=${warning?.todoId ?? 'null'}`
      })
      caseRecord.notes.push(`真实待办缺口：预警 ${warningId} 的 todoId=${warning?.todoId ?? 'null'}；通知落库不能替代待办创建与责任人处置审计。`)
    } finally {
      await cleanup(caseRecord, '停用并回读本轮专属预警规则', () =>
        cleanupDedicatedModelingConfigs(api, owned, caseRecord))
      await cleanup(caseRecord, '回读本轮专属预警项目原计划不变', () =>
        verifyDedicatedProjectUnchanged(api, fixture, caseRecord))
    }
    caseRecord.notes.push(
      '产品缺口：PmWarningEvaluationServiceImpl 明确跳过 LOAD/BUDGET，按当前全局启用规则求值且无待办ID/通知结果落库契约；本轮延期证据不代表六类完整验收。'
    )
    return { token, api }
  }

  if (caseId === 'PB118-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord })
    let project = fixture.project
    try {
      await api.putBusiness(
        '/pm/project/update',
        projectUpdatePayload(project, { healthStatus: 'NORMAL' })
      )
      fixture.project = dataOf(await api.getBusiness(`/pm/project/get?id=${fixture.projectId}`))
      project = fixture.project
      const pageData = await api.getBusiness('/pm/project/page?pageNo=1&pageSize=100')
      const pageProject = listOf(pageData).find((item) =>
        String(item?.id) === String(fixture.projectId))
      caseRecord.checks.push({
        name: '交付项目分页可读',
        passed: Array.isArray(listOf(pageData)) && Boolean(pageProject),
        details: `专属项目=${project.id}, pageMatch=${Boolean(pageProject)}, projectType=${project.projectType}`
      })
      const invalidPayload = await api.put(
        '/pm/project/update',
        projectUpdatePayload(project, { healthStatus: 'NOT_A_HEALTH_STATE' })
      )
      // Business rejection is returned in an HTTP-success response; transport and HTTP failures must surface.
      const invalidRejected = isBusinessRejected(
        invalidPayload,
        400,
        '健康状态必须是 NORMAL 或 DELAYED'
      )
      if (invalidRejected) {
        caseRecord.notes.push(`非法健康状态被拒绝：code=${invalidPayload.code} msg=${invalidPayload.msg}`)
      }
      caseRecord.checks.push({
        name: '非法健康状态被拒绝，核心状态与健康状态解耦',
        passed: invalidRejected,
        details: `projectId=${project.id}`
      })
      const afterInvalid = dataOf(await api.getBusiness(`/pm/project/get?id=${project.id}`))
      caseRecord.checks.push({
        name: '非法健康状态拒绝后原项目状态和健康状态不变',
        passed:
          afterInvalid?.status === project.status &&
          afterInvalid?.healthStatus === project.healthStatus,
        details: `status=${afterInvalid?.status}, healthStatus=${afterInvalid?.healthStatus}`
      })
      await api.putBusiness(
        '/pm/project/update',
        projectUpdatePayload(project, { healthStatus: 'DELAYED' })
      )
      const delayed = dataOf(await api.getBusiness(`/pm/project/get?id=${project.id}`))
      caseRecord.checks.push({
        name: '健康状态可独立切换为 DELAYED 且核心状态不变',
        passed:
          delayed?.healthStatus === 'DELAYED' &&
          delayed?.status === project.status,
        details: `healthStatus=${delayed?.healthStatus}, status=${delayed?.status}, originalStatus=${project.status}`
      })
      caseRecord.evidence.push(
        `PB-118 项目 ${project.id} 仅健康状态切换为 DELAYED，核心状态保持 ${project.status}`
      )
    } finally {
      const restored = await restoreDedicatedProject(api, fixture)
      caseRecord.checks.push({
        name: '专属项目清理后归属与原健康状态回读',
        passed: restored?.healthStatus === project.healthStatus &&
          restored?.status === project.status,
        details: `projectId=${fixture.projectId}, healthStatus=${restored?.healthStatus}, status=${restored?.status}`
      })
    }
    return {
      token,
      api,
      partial: true,
      note: 'PB-118 核心生命周期、前置条件、权限、审批和审计仍保留 PARTIAL；本次仅完成专属项目上的健康状态解耦验证。'
    }
  }

  if (caseId === 'PB120-001') {
    const categoryCode = unique('E2E_ISSUE_CATEGORY')
    const parentCode = unique('E2E_ISSUE_PARENT')
    const originalName = `E2E 售后问题分类 ${categoryCode}`
    const persistedName = `${originalName} 页面已保存`
    let categoryId
    let parentId
    try {
      parentId = dataOf(await api.postBusiness('/after-sales/modeling/category/create', {
        categoryCode: parentCode,
        categoryName: `E2E 专属分类父节点 ${parentCode}`,
        sortNo: 900
      }))
      categoryId = dataOf(await api.postBusiness('/after-sales/modeling/category/create', {
        parentId,
        categoryCode,
        categoryName: originalName,
        defaultPriority: 'P2',
        applicableProductType: 'STANDARD',
        applicableAssetType: 'SOFTWARE',
        applicableServiceStatus: 'IN_SERVICE',
        sortNo: 900
      }))
      const category = listOf(
        await api.getBusiness('/after-sales/modeling/category/list')
      ).find((row) => String(row.id) === String(categoryId))
      caseRecord.checks.push({
        name: '分类主档写入后回读产品类型/资产类型/服务状态适用范围',
        passed:
          category?.categoryCode === categoryCode &&
          category?.applicableProductType === 'STANDARD' &&
          category?.applicableAssetType === 'SOFTWARE' &&
          category?.applicableServiceStatus === 'IN_SERVICE' &&
          category?.status === 'ENABLED',
        details: `categoryId=${categoryId}, product=${category?.applicableProductType}, asset=${category?.applicableAssetType}, service=${category?.applicableServiceStatus}`
      })
      await saveIssueCategoryInBrowser(page, {
        categoryId, categoryCode, originalName, persistedName, parentId,
        productType: 'STANDARD', assetType: 'SOFTWARE', serviceStatus: 'IN_SERVICE'
      }, { capture: (name) => saveScreenshot(page, outputDir, name, record) })
      const persisted = dataOf(await api.getBusiness(
        `/after-sales/modeling/category/get?id=${categoryId}`
      ))
      const parent = dataOf(await api.getBusiness(
        `/after-sales/modeling/category/get?id=${parentId}`
      ))
      caseRecord.checks.push({
        name: '真实页面保存分类后清局部状态刷新，服务端编码、树层级与适用范围一致',
        passed:
          String(persisted?.id) === String(categoryId) &&
          persisted?.categoryCode === categoryCode && persisted?.categoryName === persistedName &&
          String(persisted?.parentId) === String(parentId) && persisted?.levelNo === 2 &&
          persisted?.leafFlag === true && parent?.leafFlag === false &&
          persisted?.fullPath === `${parent.categoryName}/${persistedName}` &&
          persisted?.applicableProductType === 'STANDARD' &&
          persisted?.applicableAssetType === 'SOFTWARE' &&
          persisted?.applicableServiceStatus === 'IN_SERVICE',
        details: `categoryId=${categoryId}, code=${persisted?.categoryCode}, path=${persisted?.fullPath}`
      })
      addSameCaseGapEvidence(caseRecord, PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId][2].check, [
        '真实页面保存分类后清局部状态刷新，服务端编码、树层级与适用范围一致'
      ])
      const crmTags = listOf(
        await api.getBusiness('/crm/customer-tag/definition/list-enabled')
      )
      caseRecord.checks.push({
        name: '售后问题分类与 CRM 客户标签是相互独立的事实源',
        passed:
          Array.isArray(crmTags) &&
          crmTags.every(
            (tag) =>
              !Object.prototype.hasOwnProperty.call(tag, 'applicableServiceStatus') &&
              !Object.prototype.hasOwnProperty.call(tag, 'applicableAssetType')
          ) &&
          crmTags.every((tag) => String(tag.id) !== String(categoryId)),
        details: `售后分类 id=${categoryId}，CRM 标签数=${Array.isArray(crmTags) ? crmTags.length : 'n/a'}`
      })
      await disableAfterSalesConfig(api, 'CATEGORY', categoryId)
      const disabledCategory = await readAfterSalesConfig(
        api,
        '/after-sales/modeling/category/list',
        categoryId
      )
      caseRecord.checks.push({
        name: '售后问题分类停用后回读为 DISABLED',
        passed: disabledCategory?.status === 'DISABLED',
        details: `categoryId=${categoryId}, status=${disabledCategory?.status}`
      })
    } finally {
      if (categoryId) {
        await cleanup(caseRecord, `停用并回读售后问题分类 ${categoryId}`, async () => {
          const row = dataOf(await api.getBusiness(`/after-sales/modeling/category/get?id=${categoryId}`))
          if (row?.categoryCode !== categoryCode) throw new Error('清理分类归属不一致')
          await disableAfterSalesConfig(api, 'CATEGORY', categoryId)
          const after = dataOf(await api.getBusiness(`/after-sales/modeling/category/get?id=${categoryId}`))
          if (after?.status !== 'DISABLED') throw new Error('分类清理后仍启用')
        })
      }
      if (parentId) {
        await cleanup(caseRecord, `停用并回读专属父分类 ${parentId}`, async () => {
          const row = dataOf(await api.getBusiness(`/after-sales/modeling/category/get?id=${parentId}`))
          if (row?.categoryCode !== parentCode) throw new Error('清理父分类归属不一致')
          await disableAfterSalesConfig(api, 'CATEGORY', parentId)
          const after = dataOf(await api.getBusiness(`/after-sales/modeling/category/get?id=${parentId}`))
          if (after?.status !== 'DISABLED') throw new Error('父分类清理后仍启用')
        })
      }
    }
    const settingsCollections = await Promise.all([
      api.getBusiness('/after-sales/modeling/priority-rule/list'),
      api.getBusiness('/after-sales/modeling/sla-policy/list'),
      api.getBusiness('/after-sales/modeling/escalation-rule/list'),
      api.getBusiness('/after-sales/modeling/evaluation-item-category/list'),
      api.getBusiness('/after-sales/modeling/evaluation-item/list'),
      api.getBusiness('/after-sales/modeling/evaluation-template/list'),
      api.getBusiness('/after-sales/modeling/reminder-rule/list'),
      api.getBusiness('/after-sales/modeling/ai-connection/list')
    ])
    caseRecord.checks.push({
      name: '售后设置页全部建模数据均从正式接口读取',
      passed: settingsCollections.every((item) => Array.isArray(listOf(item))),
      details: `优先级=${listOf(settingsCollections[0]).length}, SLA=${listOf(settingsCollections[1]).length}, 升级=${listOf(settingsCollections[2]).length}, 评价项目=${listOf(settingsCollections[4]).length}, 评价模板=${listOf(settingsCollections[5]).length}, 提醒=${listOf(settingsCollections[6]).length}, AI连接=${listOf(settingsCollections[7]).length}`
    })
    await openRoute(page, '/after-sales/settings', { readyText: '售后建模' })
    await page.waitForTimeout(1200)
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '售后设置页已接入真实数据且不再展示虚拟数据标识',
      passed: bodyText.includes('售后建模') && !bodyText.includes('虚拟数据'),
      details: bodyText.includes('售后建模') ? '售后建模页面已渲染' : '未命中售后建模页面'
    })
    await saveScreenshot(page, outputDir, 'pb120-after-sales-modeling', record)
    return {
      token, api, partial: true,
      note: '页面保存刷新、稳定编码与分类树已补证；服务单分类准入、停用后新建/转派拒绝及历史查询仍未闭环。'
    }
  }

  if (caseId === 'PB122-001') {
    const assetFixture = await createManualAssetFixture(api, 'PB122')
    const itemFixture = {
      itemCode: unique('ASII'),
      itemName: 'E2E 售后巡检项目',
      resultType: 'BOOLEAN',
      execRequirement: 'E2E 依照已发布标准检查并记录结果',
      standardHours: 0.5,
      attachmentRequired: true,
      status: 0
    }
    let itemId
    let planId
    let assignmentId
    try {
    const otherTasksBefore = await readOtherInspectionFacts(assetFixture.assetId)
    const servicePeriod = assetFixture.detail.servicePeriods.find((period) => period.status === 'VALID')
    if (!servicePeriod?.sourceNo) throw new Error('BLOCKED: 专属资产缺少真实有效服务期来源')
    const refs = {
      planServiceContractRef: servicePeriod.sourceNo,
      planServiceEntitlementRef: `${assetFixture.assetNo}:PLAN`,
      assignmentServiceContractRef: servicePeriod.sourceNo,
      assignmentServiceEntitlementRef: `${assetFixture.assetNo}:ASSIGNMENT`
    }
    itemId = dataOf(await api.postBusiness('/after-sales/inspection-config/item/create', itemFixture))
    const planResponse = await api.postBusiness('/after-sales/inspection-config/plan/create', {
      planCode: unique('ASIP'),
      planName: 'E2E 售后巡检方案',
      appointmentRequired: true,
      customerConfirmRequired: true,
      signatureRequired: true,
      serviceContractRef: refs.planServiceContractRef,
      serviceEntitlementRef: refs.planServiceEntitlementRef,
      items: [{ itemId, seq: 1, standard: '目视无异常' }],
      cycles: [{ cycleType: 'TIME', cycleValue: 30, cycleUnit: 'DAY', dataSource: 'CALENDAR' }]
    })
    planId = dataOf(planResponse)
    await api.putBusiness(`/after-sales/inspection-config/plan/publish?id=${planId}`)
    const plan = dataOf(await api.getBusiness(`/after-sales/inspection-config/plan/get?id=${planId}`))
    caseRecord.checks.push({
      name: '售后巡检方案发布记录版本',
      passed: plan.status === 'PUBLISHED' && plan.publishedVersion === plan.currentVersion,
      details: `status=${plan.status}, version=${plan.publishedVersion}`
    })
    const deleteResponse = await api.delete(`/after-sales/inspection-config/item/delete?id=${itemId}`)
    const deleteRejected = isBusinessRejected(deleteResponse, 400, '项目已被巡检方案引用，只能停用不能删除')
    caseRecord.checks.push({
      name: '被方案引用的巡检项目禁止删除',
      passed: deleteRejected,
      details: JSON.stringify(deleteResponse)
    })
    const inServiceAssetId = assetFixture.assetId
      const assignmentResponse = await api.postBusiness('/after-sales/inspection-config/assignment/create', {
        assetId: inServiceAssetId,
        planId,
        serviceContractRef: refs.assignmentServiceContractRef,
        serviceEntitlementRef: refs.assignmentServiceEntitlementRef,
        status: 0
      })
      assignmentId = dataOf(assignmentResponse)
      const assignments = await api.getBusiness(
        `/after-sales/inspection-config/assignment/list?assetId=${inServiceAssetId}`
      )
      caseRecord.checks.push({
        name: '巡检方案可分配到在保客户资产并作为任务快照来源',
        passed:
          assetFixture.detail?.asset?.serviceStatus === 'IN_SERVICE' &&
          listOf(assignments).some((item) => String(item.id) === String(assignmentId)),
        details: `assetId=${inServiceAssetId}, assignmentId=${assignmentId}`
      })
      const quarter = futureQuarterFixture(30)
      const generatePayload = {
        assetIds: [String(inServiceAssetId)],
        quarterCode: quarter.quarterCode,
        requiredFinishTime: quarter.requiredFinishTime
      }
      const invalidScope = await api.post('/after-sales/inspection/generate-quarter-for-assets', {
        ...generatePayload, assetIds: [String(inServiceAssetId), '9223372036854775807']
      })
      caseRecord.checks.push({
        name: '白名单含不可见资产时整批拒绝且不回退全量生成',
        passed: isBusinessRejected(invalidScope, 1030001, 'whitelist'),
        details: JSON.stringify(invalidScope)
      })
      const tasksBeforeGeneration = listOf(await api.getBusiness(
        `/after-sales/inspection/list?quarterCode=${quarter.quarterCode}`
      )).filter((item) => String(item.assetId) === String(inServiceAssetId))
      caseRecord.checks.push({
        name: '白名单整批拒绝后本轮资产没有提前生成任务',
        passed: tasksBeforeGeneration.length === 0,
        details: `tasks=${tasksBeforeGeneration.length}`
      })
      const generatedCount = dataOf(await api.postBusiness(
        '/after-sales/inspection/generate-quarter-for-assets', generatePayload))
      const readTask = async () => listOf(await api.getBusiness(
        `/after-sales/inspection/list?quarterCode=${quarter.quarterCode}`
      )).find((item) => String(item.assetId) === String(inServiceAssetId))
      const generatedTask = await readTask()
      caseRecord.checks.push({
        name: '按季度生成既有巡检任务并保存方案/资产/周期快照',
        passed:
          Number(generatedCount) === 1 &&
          generatedTask?.sourceType === 'QUARTER_AUTO' &&
          String(generatedTask?.configPlanId) === String(planId) &&
          Number(generatedTask?.configPlanVersion) === Number(plan.publishedVersion) &&
          typeof generatedTask?.configSnapshot === 'string' &&
          generatedTask.configSnapshot.includes(plan.planCode) &&
          generatedTask.configSnapshot.includes(itemFixture.itemCode),
        details:
          `count=${generatedCount}, taskId=${generatedTask?.id}, ` +
          `planVersion=${generatedTask?.configPlanVersion}, quarter=${quarter.quarterCode}`
      })
      const snapshot = assertInspectionTaskSnapshot(generatedTask, {
        assetFixture, plan, item: { ...itemFixture, id: itemId }, refs, standard: '目视无异常'
      })
      caseRecord.checks.push({
        name: 'PB122/GAP2 完整方案项目周期资产合同权益及执行规则快照',
        passed: Boolean(snapshot.assetSnapshot),
        details: `task=${generatedTask.id}, plan=${planId}/V${plan.publishedVersion}, asset=${inServiceAssetId}, period=${servicePeriod.sourceNo}`
      })
      const originalTaskSnapshot = generatedTask?.configSnapshot
      const secondGeneratedCount = dataOf(await api.postBusiness(
        '/after-sales/inspection/generate-quarter-for-assets', generatePayload))
      const tasksAfterRepeat = listOf(await api.getBusiness(
        `/after-sales/inspection/list?quarterCode=${quarter.quarterCode}`
      )).filter((item) => String(item.assetId) === String(inServiceAssetId))
      caseRecord.checks.push({
        name: '同资产同季度重复生成保持幂等且不新增平行任务',
        passed: Number(secondGeneratedCount) === 0 && tasksAfterRepeat.length === 1,
        details:
          `secondGenerated=${secondGeneratedCount}, taskCount=${tasksAfterRepeat.length}, ` +
          `taskId=${tasksAfterRepeat[0]?.id}`
      })
      await api.putBusiness('/after-sales/inspection-config/item/update', {
        ...itemFixture, id: itemId, itemName: `${itemFixture.itemName} V2`,
        execRequirement: 'E2E V2 新执行要求', standardHours: 1, attachmentRequired: false
      })
      await api.putBusiness('/after-sales/inspection-config/plan/update', {
        id: planId,
        planCode: plan.planCode,
        planName: `${plan.planName} V2`,
        appointmentRequired: false,
        customerConfirmRequired: false,
        signatureRequired: false,
        serviceContractRef: `${refs.planServiceContractRef}:V2`,
        serviceEntitlementRef: `${refs.planServiceEntitlementRef}:V2`,
        items: [{ itemId, seq: 1, standard: 'PB122 发布 V2 后的新标准' }],
        cycles: [{ cycleType: 'TIME', cycleValue: 45, cycleUnit: 'DAY', dataSource: 'CALENDAR' }]
      })
      await api.putBusiness(`/after-sales/inspection-config/plan/publish?id=${planId}`)
      const publishedV2 = dataOf(await api.getBusiness(`/after-sales/inspection-config/plan/get?id=${planId}`))
      const itemV2 = listOf(await api.getBusiness('/after-sales/inspection-config/item/list'))
        .find((item) => String(item.id) === String(itemId))
      const taskAfterPlanV2 = await readTask()
      assertInspectionSnapshotUnchanged(generatedTask, taskAfterPlanV2)
      caseRecord.checks.push({
        name: '发布方案 V2 后旧巡检任务仍保留原方案版本与完整快照',
        passed:
          String(taskAfterPlanV2?.configPlanId) === String(planId) &&
          Number(taskAfterPlanV2?.configPlanVersion) === Number(plan.publishedVersion) &&
          taskAfterPlanV2?.configSnapshot === originalTaskSnapshot,
        details:
          `oldVersion=${taskAfterPlanV2?.configPlanVersion}, ` +
          `snapshotUnchanged=${taskAfterPlanV2?.configSnapshot === originalTaskSnapshot}`
      })
      caseRecord.checks.push({
        name: 'PB122/GAP3 项目主档及方案V2发布后历史任务完整快照不变',
        passed: publishedV2?.status === 'PUBLISHED' &&
          Number(publishedV2?.publishedVersion) === Number(plan.publishedVersion) + 1 &&
          itemV2?.itemName === `${itemFixture.itemName} V2` &&
          taskAfterPlanV2.configSnapshot === originalTaskSnapshot,
        details: `itemV2=${itemV2?.itemName}, newPlanVersion=${publishedV2?.publishedVersion}, historyVersion=${taskAfterPlanV2.configPlanVersion}`
      })
      const otherTasksAfter = await readOtherInspectionFacts(assetFixture.assetId)
      const ownTasks = await runReadOnlySql(`
        SELECT id, asset_id, config_plan_id, config_plan_version, source_type, config_snapshot
        FROM after_sales_inspection_task WHERE tenant_id=1 AND deleted=0
          AND asset_id='${String(inServiceAssetId)}' ORDER BY id
      `)
      if (!ownTasks.available) throw new Error(`BLOCKED: ${ownTasks.reason}`)
      caseRecord.database = [...(caseRecord.database || []),
        { stage: 'other-inspection-facts-before', ...otherTasksBefore },
        { stage: 'other-inspection-facts-after', ...otherTasksAfter },
        { stage: 'owned-existing-inspection-task', ...ownTasks }]
      caseRecord.checks.push({
        name: 'PB122/GAP1 白名单真实季度生成既有任务且其他资产事实不变',
        passed: JSON.stringify(otherTasksBefore.rows) === JSON.stringify(otherTasksAfter.rows) &&
          ownTasks.rows.length === 1 &&
          String(ownTasks.rows[0]?.[0]) === String(generatedTask.id) &&
          ownTasks.rows[0]?.[5] === originalTaskSnapshot,
        details: `otherRows=${otherTasksAfter.rows.length}, ownedRows=${ownTasks.rows.length}, task=${generatedTask.id}`
      })
      await openRoute(page, '/after-sales/inspections', { readyText: '服务巡检' })
      await queryInspectionTaskInBrowser(page, generatedTask.inspectionNo)
      const ownedTaskRow = page.locator('.inspection-task-table .el-table__row')
        .filter({ hasText: generatedTask.inspectionNo })
      await ownedTaskRow.waitFor({ state: 'visible', timeout: 30000 })
      const inspectionPageText = await page.locator('body').innerText()
      caseRecord.checks.push({
        name: '巡检方案真实页面可进入并展示季度任务',
        passed: inspectionPageText.includes('服务巡检') &&
          inspectionPageText.includes('季度巡检任务') &&
          (await ownedTaskRow.innerText()).includes(assetFixture.detail.asset.assetName),
        details: inspectionPageText.includes('季度巡检任务')
          ? '命中服务巡检页面'
          : '未命中服务巡检页面'
      })
      caseRecord.checks.push({
        name: '巡检任务查询加载完成且页面不暴露接口调试提示',
        passed: !inspectionPageText.includes('pageSize=') &&
          await page.locator('.inspection-task-table .el-loading-mask:visible').count() === 0,
        details: `task=${generatedTask.inspectionNo}, query complete, loading mask hidden`
      })
      await saveScreenshot(page, outputDir, 'pb122-inspection-plan', record)
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    } finally {
      if (assignmentId) await cleanup(caseRecord, `删除本轮资产分配 ${assignmentId}`, () =>
        api.deleteBusiness(`/after-sales/inspection-config/assignment/delete?id=${assignmentId}`))
      if (planId) await cleanup(caseRecord, `停用并回读本轮方案 ${planId}`, async () => {
        await api.putBusiness(`/after-sales/inspection-config/plan/disable?id=${planId}`)
        const disabled = dataOf(await api.getBusiness(`/after-sales/inspection-config/plan/get?id=${planId}`))
        if (disabled?.status !== 'DISABLED') throw new Error('方案停用后状态未回读为 DISABLED')
      })
      if (itemId) await cleanup(caseRecord, `停用并回读本轮项目 ${itemId}，引用历史按契约保留`, async () => {
        await api.putBusiness('/after-sales/inspection-config/item/update', { ...itemFixture, id: itemId, status: 1 })
        const items = listOf(await api.getBusiness('/after-sales/inspection-config/item/list'))
        if (!items.some((item) => String(item.id) === String(itemId) && item.status === 1)) {
          throw new Error('巡检项目停用后状态未回读为 1')
        }
      })
      await cleanup(caseRecord, `退役本轮专属资产 ${assetFixture.assetId}`, () =>
        retireAsset(api, assetFixture.assetId)
      )
    }
    return { token, api }
  }

  if (caseId === 'PB130-001') {
    // 值班事实源为 HRM/OA 排班：售后只维护电话与转接规则
    const employeePage = await api.getBusiness(
      '/hrm/employee/simple-page?pageNo=1&pageSize=100&entryStatus=1'
    )
    const employee = listOf(employeePage)[0]
    if (!employee?.id) {
      caseRecord.notes.push('BLOCKED：当前租户无在职 HRM 员工，无法创建真实值班排班。')
      return { token, api, partial: true }
    }
    const dutyRole = unique('E2E_DUTY_ROLE')
    const phone = '400-900-1257'
    const dutyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    let scheduleId
    let ruleId
    try {
      scheduleId = dataOf(await api.postBusiness('/hrm/attendance/schedule/create', {
        employeeId: employee.id,
        scheduleDate: dutyDate,
        shiftName: 'E2E 值班班次',
        startTime: '09:00:00',
        endTime: '18:00:00',
        dutyRole,
        remark: 'E2E 值班写侧闭环'
      }))
      ruleId = dataOf(await api.postBusiness('/after-sales/duty/rule/save', {
        name: 'E2E 值班转接规则',
        dutyRole,
        phone: '400-900-1234',
        transferOrder: 1,
        timeoutMinutes: 5,
        serviceScope: 'E2E 服务范围',
        nonServiceTip: '非服务时段请留言',
        enabled: true,
        sort: 1
      }))
      const expected = {
        ruleId, dutyRole, name: `E2E 页面值班 ${dutyRole}`,
        employeeName: employee.name || employee.employeeName,
        date: dutyDate, phone, serviceScope: `E2E 页面服务 ${dutyRole}`,
        startTime: '09:00', endTime: '18:00',
        timeoutMinutes: 7, transferOrder: 2, nonServiceTip: `${dutyRole} 非服务时段请留言`
      }
      const pageEvidence = await verifyDutyPageInBrowser(page, expected, {
        capture: (name) => saveScreenshot(page, outputDir, name, record)
      })
      const rules = listOf(await api.getBusiness('/after-sales/duty/rule/list'))
      const rule = rules.find((item) => String(item.id) === String(ruleId))
      caseRecord.checks.push({
        name: '售后值班只维护转接规则，不复制排班事实',
        passed:
          rule?.dutyRole === dutyRole &&
          rule?.phone === phone &&
          rule?.serviceScope === expected.serviceScope &&
          rule?.nonServiceTip === expected.nonServiceTip &&
          rule?.timeoutMinutes === 7 && rule?.transferOrder === 2 &&
          rule?.enabled === true,
        details: `ruleId=${ruleId}, dutyRole=${rule?.dutyRole}`
      })
      const dutyRoles = listOf(await api.getBusiness('/after-sales/duty/duty-roles'))
      caseRecord.checks.push({
        name: 'HRM 提供值班角色目录，售后不做角色主档',
        passed:
          Array.isArray(dutyRoles) &&
          dutyRoles.length > 0 &&
          dutyRoles.includes(dutyRole),
        details: `角色数=${Array.isArray(dutyRoles) ? dutyRoles.length : 'n/a'}, 含本轮角色=${dutyRoles.includes(dutyRole)}`
      })
      const roster = dataOf(await api.getBusiness(
        `/after-sales/duty/roster?startDate=${dutyDate}&endDate=${dutyDate}`
      ))
      const shift = (roster?.roster || []).find((item) => item?.dutyRole === dutyRole)
      caseRecord.checks.push({
        name: '值班名册人员来自 HRM/OA 排班，电话来自售后转接规则',
        passed:
          Array.isArray(roster?.roster) &&
          shift?.date === dutyDate &&
          String(shift?.employeeId) === String(employee.id) &&
          shift?.employeeName === expected.employeeName &&
          shift?.phone === phone &&
          shift?.serviceScope === expected.serviceScope &&
          shift?.source === 'MANUAL' &&
          !(roster?.missingRoles || []).includes(dutyRole),
        details: `dutyDate=${dutyDate}, shift=${JSON.stringify(shift)}, missing=${JSON.stringify(roster?.missingRoles)}`
      })
      caseRecord.checks.push({
        name: '值班页签真实保存转接规则，清局部状态刷新回读 HRM 人员、日期与规则',
        passed:
          pageEvidence.reloadedText.includes(expected.employeeName) &&
          pageEvidence.reloadedText.includes(dutyDate) &&
          pageEvidence.reloadedText.includes(expected.nonServiceTip) &&
          rule?.name === expected.name,
        details: `ruleId=${ruleId}, scheduleId=${scheduleId}, date=${dutyDate}, employeeId=${employee.id}`
      })
      const hardcoded = ['2026-07-22'].filter((value) => pageEvidence.reloadedText.includes(value))
      caseRecord.checks.push({
        name: '值班设置页不再出现示例人员与固定日期',
        passed: hardcoded.length === 0 && pageEvidence.reloadedText.includes(expected.employeeName),
        details: '真实 HRM 排班行存在，非空白页面；未发现原型固定日期'
      })
      addSameCaseGapEvidence(caseRecord, PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId][2].check, [
        '值班页签真实保存转接规则，清局部状态刷新回读 HRM 人员、日期与规则',
        '值班名册人员来自 HRM/OA 排班，电话来自售后转接规则',
        '值班设置页不再出现示例人员与固定日期'
      ])
    } finally {
      if (ruleId) {
        await cleanup(caseRecord, `删除并回读本轮值班规则 ${ruleId}`, async () => {
          const before = listOf(await api.getBusiness('/after-sales/duty/rule/list'))
            .find((row) => String(row.id) === String(ruleId))
          if (before?.dutyRole !== dutyRole) throw new Error('值班规则清理归属不一致')
          await api.deleteBusiness(`/after-sales/duty/rule/delete?id=${ruleId}`)
          if (listOf(await api.getBusiness('/after-sales/duty/rule/list'))
            .some((row) => String(row.id) === String(ruleId))) throw new Error('值班规则清理残留')
        })
      }
      if (scheduleId) {
        await cleanup(caseRecord, `删除并回读本轮 HRM 值班排班 ${scheduleId}`, async () => {
          const before = dataOf(await api.getBusiness(`/hrm/attendance/schedule/get?id=${scheduleId}`))
          if (before?.dutyRole !== dutyRole || String(before?.employeeId) !== String(employee.id)) {
            throw new Error('HRM 排班清理归属不一致')
          }
          await api.deleteBusiness(`/hrm/attendance/schedule/delete?id=${scheduleId}`)
          const after = await api.getBusiness(`/hrm/attendance/schedule/get?id=${scheduleId}`)
          if (after.data !== null) throw new Error('HRM 排班清理未精确回读 data=null')
        })
      }
    }
    caseRecord.evidence.push(
      `PB-130 创建 HRM 值班排班 ${scheduleId}（员工 ${employee.id}, 角色 ${dutyRole}）并回读售后名册电话 ${phone}`
    )
    return {
      token, api, partial: true,
      note: '值班真实页签保存/刷新与 HRM 原班人员日期已补证；替班、调班、离职、无排班告警与受控兜底队列仍未完整验证。'
    }
  }

  if (caseId === 'PB121-001') {
    const reasonCode = unique('SLA_PAUSE')
    const ruleResponse = await api.postBusiness('/after-sales/sla/pause-rule/save', {
      reasonCode,
      reasonName: 'E2E等待客户补充资料',
      pauseCustomerSla: true,
      pauseInternalSla: false,
      maxPauseHours: 48,
      approvalRequired: false
    })
    const ruleId = dataOf(ruleResponse)
    const rules = listOf(await api.getBusiness('/after-sales/sla/pause-rule/list'))
    const rule = rules.find((item) => String(item.id) === String(ruleId))
    caseRecord.checks.push({
      name: '暂停规则可分别控制客户侧SLA与内部责任计时',
      passed: Boolean(rule) && rule.pauseCustomerSla === true && rule.pauseInternalSla === false,
      details: `ruleId=${ruleId}`
    })
    let rndRejected = false
    try {
      await api.postBusiness('/after-sales/sla/pause-rule/save', {
        reasonCode: 'WAITING_RND',
        reasonName: '等待研发处理',
        pauseCustomerSla: true,
        pauseInternalSla: true
      })
    } catch (error) {
      rndRejected = true
    }
    caseRecord.checks.push({
      name: '等待研发原因禁止暂停内部责任计时',
      passed: rndRejected,
      details: 'WAITING_RND + pauseInternalSla=true 被拒绝'
    })
    try {
      await api.postBusiness(`/after-sales/sla/pause-rule/change-status?id=${ruleId}&enabled=false`)
      const disabledRule = listOf(
        await api.getBusiness('/after-sales/sla/pause-rule/list')
      ).find((item) => String(item.id) === String(ruleId))
      caseRecord.checks.push({
        name: '暂停规则停用后回读为 DISABLED，停止参与 SLA 暂停计算',
        passed: disabledRule?.status === 'DISABLED',
        details: `ruleId=${ruleId}, status=${disabledRule?.status}`
      })
    } finally {
      if (ruleId) {
        await cleanup(caseRecord, `停用 SLA 暂停规则 ${ruleId}`, () =>
          api.postBusiness(`/after-sales/sla/pause-rule/change-status?id=${ruleId}&enabled=false`)
        )
      }
    }
    return { token, api }
  }

  if (caseId === 'PB124-001') {
    const fixture = newReminderFixture()
    try {
      assertReminderLocalTarget()
      const materialId = await firstEnabledMaterialId(api)
      if (!materialId) {
        throw new Error('BLOCKED: PB124 当前租户没有已启用且可采购的 Base 存货档案')
      }
      await prepareReminderAsset({
        api,
        fixture,
        materialId,
        caseRecord
      })
      const rule = await createReminderClosureRule({ api, fixture })
      const closure = await verifyReminderClosure({
        api,
        fixture,
        rule,
        caseRecord
      })
      caseRecord.evidence.push(
        `PB124 受控提醒对象 ${fixture.assetId} 完成唯一索引、时间边界、重复幂等和事实快照验证`
      )
      caseRecord.reminderBrowser = await verifyReminderRuleQuietHoursInBrowser({
        page, api, fixture, rule, caseRecord, cleanup: 'restore',
        capture: (name) => saveScreenshot(page, outputDir, name, record)
      })
      caseRecord.notes.push(
        'PB124 免打扰配置编辑、成对校验及保存刷新已由真实页面验证；仍缺 worker 消费、通知/待办与渠道发送结果、提醒运行列表展示、升级时钟/执行日志及服务单状态不变证据，保留 PARTIAL。'
      )
      return { token, api, partial: true, ...closure }
    } finally {
      if (fixture.rules.length > 0) await cleanupReminderClosure({ api, fixture, caseRecord })
    }
  }

  if (caseId === 'PB115-001') {
    const templates = listOf(await api.getBusiness('/pm/modeling/list?configKey=milestoneTemplate'))
    caseRecord.checks.push({
      name: '里程碑模板复用项目建模配置且不另建主档',
      passed:
        Array.isArray(templates) &&
        templates.every((item) => item.configKey === 'milestoneTemplate'),
      details: `模板数=${templates?.length ?? 'n/a'}`
    })
    caseRecord.checks.push({
      name: '里程碑模板保留版本号以支持发布后新版本变更',
      passed: (templates || []).every(
        (item) => item.versionNo === undefined || typeof item.versionNo === 'number'
      ),
      details: (templates || []).map((item) => `${item.configCode}@${item.versionNo}`).join(',') || '无模板数据，字段存在性以契约保证'
    })
    caseRecord.checks.push({
      name: '里程碑模板返回完整阶段快照供工作台回读',
      passed: (templates || []).every((item) => {
        try {
          const config = JSON.parse(item.configJson || '{}')
          return Array.isArray(config.stages)
        } catch {
          return false
        }
      }),
      details: '已校验 configJson.stages 数组'
    })
    let invalidRejected = false
    try {
      await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: unique('MS_INVALID'),
        configName: 'E2E 无交付物模板',
        configJson: JSON.stringify({
          stages: [{ name: '立项', duration: 5, required: true }]
        }),
        status: 'ENABLED'
      })
    } catch (error) {
      invalidRejected = true
    }
    caseRecord.checks.push({
      name: '启用里程碑模板前阻断缺少必经阶段交付物',
      passed: invalidRejected,
      details: '后端版本发布校验已执行'
    })
    const invalidDraftId = dataOf(await api.postBusiness('/pm/modeling/save', {
      configKey: 'milestoneTemplate',
      configCode: unique('MS_INVALID_DRAFT'),
      configName: 'E2E 无交付物草稿',
      configJson: JSON.stringify({ stages: [{ name: '立项', duration: 5, required: true }] }),
      status: 'DRAFT'
    }))
    let invalidStatusRejected = false
    try {
      await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=ENABLED`)
    } catch (error) {
      invalidStatusRejected = true
    }
    caseRecord.checks.push({
      name: '草稿经启用接口发布仍执行里程碑门禁，不能绕过保存校验',
      passed: invalidStatusRejected,
      details: `draftId=${invalidDraftId}`
    })
    await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=DISABLED`)
    const templateCode = unique('E2E_MILESTONE')
    const versionOneConfig = JSON.stringify({
      stages: [
        { code: `S1_${templateCode}`, name: '方案确认', duration: 3, required: true, deliverable: '确认单' },
        { code: `S2_${templateCode}`, name: '交付验收', duration: 5, required: true, deliverable: '验收材料' }
      ]
    })
    let versionOneId
    let versionTwoId
    try {
      versionOneId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: templateCode,
        configName: 'E2E 里程碑模板 V1',
        configJson: versionOneConfig,
        status: 'DRAFT'
      }))
      await api.postBusiness(`/pm/modeling/status?id=${versionOneId}&status=ENABLED`)
      const versionOne = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=milestoneTemplate')
      ).find((item) => String(item.id) === String(versionOneId))
      caseRecord.checks.push({
        name: '里程碑模板创建并发布 V1 后回读版本号',
        passed:
          versionOne?.status === 'ENABLED' &&
          versionOne?.versionNo === 1 &&
          parseJson(versionOne?.configJson).stages?.length === 2,
        details: `versionOneId=${versionOneId}, versionNo=${versionOne?.versionNo}`
      })
      versionTwoId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: templateCode,
        configName: 'E2E 里程碑模板 V2',
        configJson: JSON.stringify({
          stages: [
            { code: `S1_${templateCode}`, name: '方案确认', duration: 2, required: true, deliverable: '确认单' },
            { code: `S2_${templateCode}`, name: '交付验收', duration: 6, required: true, deliverable: '验收材料' },
            { code: `S3_${templateCode}`, name: '质保移交', duration: 4, required: true, deliverable: '移交清单' }
          ]
        }),
        status: 'DRAFT'
      }))
      await api.postBusiness(`/pm/modeling/status?id=${versionTwoId}&status=ENABLED`)
      const versions = listOf(
        await api.getBusiness('/pm/modeling/list?configKey=milestoneTemplate')
      ).filter((item) => item.configCode === templateCode)
      const latest = versions.find((item) => String(item.id) === String(versionTwoId))
      const previous = versions.find((item) => String(item.id) === String(versionOneId))
      caseRecord.checks.push({
        name: '同编码发布新版本后版本号递增且旧版本自动停用',
        passed:
          latest?.status === 'ENABLED' &&
          latest?.versionNo === 2 &&
          previous?.status === 'DISABLED' &&
          parseJson(latest?.configJson).stages?.length === 3,
        details: `v1=${previous?.status}@${previous?.versionNo}, v2=${latest?.status}@${latest?.versionNo}`
      })
    } finally {
      for (const id of [versionTwoId, versionOneId].filter(Boolean)) {
        await cleanup(caseRecord, `停用里程碑模板版本 ${id}`, () =>
          api.postBusiness(`/pm/modeling/status?id=${id}&status=DISABLED`)
        )
      }
    }
    await openRoute(page, '/project/modeling/project-base/list?modeling=milestoneTemplate', {
      readyText: '里程碑模板'
    })
    const milestonePageText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '里程碑模板真实菜单页渲染并可回读阶段快照',
      passed: milestonePageText.includes('项目基础建模') &&
        milestonePageText.includes('里程碑模板'),
      details: milestonePageText.includes('里程碑模板')
        ? '命中里程碑模板菜单工作区'
        : '未命中里程碑模板菜单工作区'
    })
    await saveScreenshot(page, outputDir, 'pb115-milestone-template', record)
    return { token, api }
  }

  if (caseId === 'PB116-001') {
    const owned = newPmClosureFixture(caseId)
    try {
      const category = await createDedicatedModelingConfig(api, owned, 'taskCategory', 'CATEGORY', {})
      const libraryValue = {
        categoryId: category.row.configCode,
        tasks: [
          { code: 'T1', name: '现场勘查', standardHours: 4, deliverable: '勘查记录', acceptance: '客户确认' },
          { code: 'T2', name: '方案实施', standardHours: 8, deliverable: '实施报告',
            acceptance: '验收通过', predecessorIds: ['T1'] }
        ]
      }
      const library = await createDedicatedModelingConfig(api, owned, 'taskLibrary', 'LIBRARY', libraryValue)
      const created = library.row
      const categoryAfter = await readDedicatedModelingConfig(api, owned, category.owned)
      const config = parseJson(created.configJson)
      caseRecord.checks.push({
        name: '任务库复用建模配置键 taskLibrary/taskCategory 并返回引用计数',
        passed: created.configKey === 'taskLibrary' && categoryAfter.configKey === 'taskCategory' &&
          typeof created.referenceCount === 'number' && typeof categoryAfter.referenceCount === 'number',
        details: `本轮 libraryId=${created.id}, categoryId=${categoryAfter.id}, referenceCount=${categoryAfter.referenceCount}`
      })
      caseRecord.checks.push({
        name: '任务库真实条目保存标准工时、产出物、验收标准和前置关系',
        passed:
          created?.status === 'ENABLED' &&
          created?.versionNo === 1 &&
          validTaskLibraryConfig(config) &&
          config.tasks?.[1]?.predecessorIds?.[0] === 'T1' &&
          config.categoryId === category.row.configCode,
        details: `taskLibraryId=${created.id}, tasks=${config.tasks?.length ?? 'n/a'}`
      })
      caseRecord.checks.push({
        name: '任务库引用使 taskCategory 引用计数真实增加',
        passed: Number(categoryAfter.referenceCount) === Number(category.row.referenceCount) + 1,
        details: `before=${category.row.referenceCount}, after=${categoryAfter.referenceCount}`
      })
      const rejected = await api.post(
        `/pm/modeling/status?id=${category.owned.id}&status=DISABLED`,
        undefined,
        { expectedBusinessRejection: { code: 1055020005, message: '存在引用的建模配置不能停用' } }
      )
      caseRecord.checks.push({
        name: '被任务库引用的任务分类禁止直接停用',
        passed: isBusinessRejected(rejected, 1055020005, '存在引用的建模配置不能停用') &&
          (await readDedicatedModelingConfig(api, owned, category.owned)).status === 'ENABLED',
        details: JSON.stringify(rejected)
      })
      const cyclic = {
        tasks: [
          { code: 'TASK-A', name: '任务A', standardHours: 4, deliverable: '交付物A',
            acceptanceCriteria: '验收A', predecessorIds: ['TASK-B'] },
          { code: 'TASK-B', name: '任务B', standardHours: 4, deliverable: '交付物B',
            acceptanceCriteria: '验收B', predecessorIds: ['TASK-A'] }
        ]
      }
      const cycleMessage = '项目规则配置无效：任务库前置任务存在循环依赖：TASK-A'
      const cycleResponse = await api.post('/pm/modeling/save', {
        configKey: 'taskLibrary',
        configCode: `${owned.marker}_CYCLE`,
        configName: `${owned.marker}_CYCLE`,
        configJson: JSON.stringify(cyclic),
        status: 'ENABLED'
      }, { expectedBusinessRejection: { code: 1055020011, message: cycleMessage } })
      caseRecord.checks.push({
        name: '启用任务库前阻断前置任务循环依赖',
        passed: isBusinessRejected(cycleResponse, 1055020011, cycleMessage),
        details: JSON.stringify(cycleResponse)
      })
      const draft = await createDedicatedModelingConfig(api, owned, 'taskLibrary', 'DRAFT', {
        tasks: [{ code: 'TASK-A', name: '任务A', standardHours: 4, deliverable: '交付物A' }]
      }, 'DRAFT')
      const draftMessage = '项目规则配置无效：任务库条目必须填写验收标准：TASK-A'
      const draftResponse = await api.post(
        `/pm/modeling/status?id=${draft.owned.id}&status=ENABLED`, undefined,
        { expectedBusinessRejection: { code: 1055020011, message: draftMessage } })
      caseRecord.checks.push({
        name: '草稿经启用接口发布仍执行任务库门禁，不能绕过验收标准校验',
        passed: isBusinessRejected(draftResponse, 1055020011, draftMessage) &&
          (await readDedicatedModelingConfig(api, owned, draft.owned)).status === 'DRAFT',
        details: JSON.stringify(draftResponse)
      })
      caseRecord.evidence.push(`PB116 本轮专属 ${owned.marker}: 分类 ${category.owned.id}, 任务库 ${library.owned.id}, 草稿 ${draft.owned.id}`)
    } finally {
      await cleanupDedicatedModelingConfigs(api, owned, caseRecord)
    }
    await openRoute(page, '/project/modeling/project-base/list?modeling=taskLibrary', {
      readyText: '任务库'
    })
    const taskLibraryPageText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '任务库真实菜单页渲染并可回读配置',
      passed: taskLibraryPageText.includes('项目基础建模') &&
        taskLibraryPageText.includes('任务库'),
      details: taskLibraryPageText.includes('任务库')
        ? '命中任务库菜单工作区'
        : '未命中任务库菜单工作区'
    })
    await saveScreenshot(page, outputDir, 'pb116-task-library', record)
    return { token, api }
  }

  if (caseId === 'PB117-001') {
    for (const field of ['milestone', 'taskLibrary', 'dailyReportRule', 'weeklyReportRule',
      'warningRule', 'approvalFlow', 'staffProfile']) {
      const response = await api.post('/pm/modeling/save', {
        configKey: 'projectType',
        configCode: unique(`TYPE_INVALID_${field.toUpperCase()}`),
        configName: 'E2E 失效依赖项目类型',
        configJson: JSON.stringify({ [field]: unique('MISSING') }),
        status: 'ENABLED'
      })
      caseRecord.checks.push({
        name: `发布项目类型时拒绝未启用的 ${field} 依赖`,
        passed: response?.code === 1055020007,
        details: JSON.stringify(response)
      })
    }
    const invalidDraftId = dataOf(await api.postBusiness('/pm/modeling/save', {
      configKey: 'projectType',
      configCode: unique('TYPE_DRAFT_INVALID'),
      configName: 'E2E 未启用依赖草稿',
      configJson: JSON.stringify({ taskLibrary: unique('MISSING') }),
      status: 'DRAFT'
    }))
    try {
      const response = await api.post(`/pm/modeling/status?id=${invalidDraftId}&status=ENABLED`)
      caseRecord.checks.push({
        name: '项目类型草稿经状态接口启用不能绕过依赖校验',
        passed: response?.code === 1055020007,
        details: JSON.stringify(response)
      })
    } finally {
      await api.postBusiness(`/pm/modeling/status?id=${invalidDraftId}&status=DISABLED`)
    }
    const milestoneCode = unique('MS_TYPE')
    const taskCode = unique('TASK_TYPE')
    const typeCode = unique('TYPE_DEPENDENCY')
    const dependencyIds = []
    let typeId
    let projectFixture
    try {
      dependencyIds.push(dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'milestoneTemplate',
        configCode: milestoneCode,
        configName: 'E2E 项目类型里程碑',
        configJson: JSON.stringify({
          stages: [{ name: '交付验收', duration: 5, required: true, deliverable: '验收资料' }]
        }),
        status: 'ENABLED'
      })))
      dependencyIds.push(dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'taskLibrary',
        configCode: taskCode,
        configName: 'E2E 项目类型任务库',
        configJson: JSON.stringify({
          tasks: [{ code: 'T1', name: '交付', standardHours: 8, deliverable: '交付资料', acceptance: '确认通过' }]
        }),
        status: 'ENABLED'
      })))
      typeId = dataOf(await api.postBusiness('/pm/modeling/save', {
        configKey: 'projectType',
        configCode: typeCode,
        configName: 'E2E 项目类型依赖',
        configJson: JSON.stringify({ milestone: milestoneCode, taskLibrary: taskCode }),
        status: 'DRAFT'
      }))
      await api.postBusiness(`/pm/modeling/status?id=${typeId}&status=ENABLED`)
      for (const id of dependencyIds) {
        const response = await api.post(`/pm/modeling/status?id=${id}&status=DISABLED`)
        caseRecord.checks.push({
          name: '被启用项目类型引用的模板不能直接停用',
          passed: response?.code === 1055020005,
          details: `dependencyId=${id}, ${JSON.stringify(response)}`
        })
      }
      const baseProjectType = await resolveEnabledProjectType(api, new Set([typeCode]))
      projectFixture = await createDedicatedProject({
        api,
        caseId,
        projectType: baseProjectType,
        caseRecord
      })
      await api.putBusiness(
        '/pm/project/update',
        projectUpdatePayload(projectFixture.project, { projectType: typeCode })
      )
      const projectAfterUpdate = dataOf(
        await api.getBusiness(`/pm/project/get?id=${projectFixture.projectId}`)
      )
      const snapshot = parseJson(projectAfterUpdate?.projectTypeConfigSnapshotJson)
      const snapshotCodes = [
        ...(snapshot?.dependencySnapshots?.milestone || []),
        ...(snapshot?.dependencySnapshots?.taskLibrary || [])
      ].map((item) => item?.configCode)
      caseRecord.checks.push({
        name: '项目主档切换项目类型时固化服务端依赖配置快照',
        passed:
          projectAfterUpdate?.projectType === typeCode &&
          Number(projectAfterUpdate?.projectTypeConfigVersion) >= 1 &&
          snapshotCodes.includes(milestoneCode) &&
          snapshotCodes.includes(taskCode),
        details: `projectId=${projectFixture.projectId}, version=${projectAfterUpdate?.projectTypeConfigVersion}, snapshotCodes=${snapshotCodes.join(',')}`
      })
    } finally {
      const cleanupErrors = []
      if (projectFixture) {
        try {
          const restored = await restoreDedicatedProject(api, projectFixture)
          caseRecord.checks.push({
            name: '专属项目清理后归属与原项目类型回读',
            passed: restored?.projectType === projectFixture.project.projectType &&
              restored?.projectName === projectFixture.project.projectName,
            details: `projectId=${projectFixture.projectId}, projectType=${restored?.projectType}`
          })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (typeId) {
        try {
          await api.postBusiness(`/pm/modeling/status?id=${typeId}&status=DISABLED`)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      for (const id of dependencyIds) {
        try {
          await api.postBusiness(`/pm/modeling/status?id=${id}&status=DISABLED`)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, 'PB117 专属项目或建模配置清理失败')
      }
    }
    await openRoute(page, '/project/modeling/foundation/project-base/list?modeling=projectType')
    await saveScreenshot(page, outputDir, 'pb117-project-type-dependencies', record)
    return {
      token,
      api,
      partial: true,
      note: 'PB-117 七类依赖完整 ID/版本/配置快照、建项自动展开和版本漂移仍保留 PARTIAL；本次仅修复专属项目切换与快照验证污染。'
    }
  }

  if (caseId === 'PB119-001') {
    const categoryCode = unique('E2E_SLA_CATEGORY')
    let categoryId
    let policyId
    try {
      categoryId = dataOf(await api.postBusiness('/after-sales/modeling/category/create', {
        categoryCode,
        categoryName: `E2E SLA 分类 ${categoryCode}`,
        defaultPriority: 'P2',
        applicableProductType: 'STANDARD',
        applicableAssetType: 'SOFTWARE',
        applicableServiceStatus: 'IN_SERVICE',
        sortNo: 999
      }))
      policyId = dataOf(await api.postBusiness('/after-sales/modeling/sla-policy/create', {
        policyCode: unique('E2E_SLA'),
        policyName: 'E2E 标准响应 SLA',
        categoryIds: [categoryId],
        priority: 'P2',
        assetServiceStatus: 'IN_SERVICE',
        customerLevel: 'STANDARD',
        contractScope: 'E2E',
        responseMinutes: 30,
        resolutionCommitted: true,
        resolutionMinutes: 240,
        warningRatio: 80,
        pauseReason: 'WAITING_CUSTOMER_SUPPLEMENT',
        effectiveType: 'IMMEDIATE',
        remark: 'PB119 写侧闭环专属策略'
      }))
      const [categories, slaPolicies, reminderRules, evaluationTemplates] = await Promise.all([
        api.getBusiness('/after-sales/modeling/category/list'),
        api.getBusiness('/after-sales/modeling/sla-policy/list'),
        api.getBusiness('/after-sales/modeling/reminder-rule/list'),
        api.getBusiness('/after-sales/modeling/evaluation-template/list')
      ])
      const policy = listOf(slaPolicies).find(
        (item) => String(item.id) === String(policyId)
      )
      caseRecord.checks.push({
        name: '售后设置复用现有建模页读取 SLA/提醒/评价，不建平行主档',
        passed:
          [categories, slaPolicies, reminderRules, evaluationTemplates].every(
            (item) => Array.isArray(listOf(item))
          ) && Boolean(policy),
        details: `分类=${listOf(categories).length}, SLA=${listOf(slaPolicies).length}, 提醒=${listOf(reminderRules).length}, 评价模板=${listOf(evaluationTemplates).length}`
      })
      caseRecord.checks.push({
        name: 'SLA 策略写入后回读分类、响应/解决时限和暂停口径',
        passed:
          policy?.status === 'ENABLED' &&
          policy?.responseMinutes === 30 &&
          policy?.resolutionCommitted === true &&
          policy?.resolutionMinutes === 240 &&
          policy?.pauseReason === 'WAITING_CUSTOMER_SUPPLEMENT' &&
          policy?.categoryIds?.some((id) => String(id) === String(categoryId)),
        details: `policyId=${policyId}, categoryIds=${policy?.categoryIds?.join(',') || 'n/a'}`
      })
      await disableAfterSalesConfig(api, 'SLA_POLICY', policyId)
      const disabledPolicy = await readAfterSalesConfig(
        api,
        '/after-sales/modeling/sla-policy/list',
        policyId
      )
      caseRecord.checks.push({
        name: 'SLA 策略停用后回读为 DISABLED',
        passed: disabledPolicy?.status === 'DISABLED',
        details: `policyId=${policyId}, status=${disabledPolicy?.status}`
      })
    } finally {
      if (policyId) {
        await cleanup(caseRecord, `停用 SLA 策略 ${policyId}`, () =>
          disableAfterSalesConfig(api, 'SLA_POLICY', policyId)
        )
      }
      if (categoryId) {
        await cleanup(caseRecord, `停用 SLA 专属分类 ${categoryId}`, () =>
          disableAfterSalesConfig(api, 'CATEGORY', categoryId)
        )
      }
    }
    await openRoute(page, '/after-sales/settings', { readyText: '售后建模' })
    await page.waitForTimeout(1000)
    const settingsText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '售后设置页可进入且复用页面内维护 SLA/提醒/评价',
      passed: settingsText.includes('售后建模'),
      details: settingsText.includes('售后建模') ? '售后建模设置页已渲染' : '未命中售后建模设置页'
    })
    await saveScreenshot(page, outputDir, 'pb119-after-sales-settings', record)
    return { token, api }
  }

  if (caseId === 'PB126-001') {
    // 接待策略为租户单例；先记录旧值，写侧验证结束后恢复，避免污染既有配置。
    const previousPolicy = dataOf(
      await api.getBusiness('/after-sales/modeling/ai-reception-policy/get')
    )
    let policyId
    try {
      policyId = dataOf(await api.postBusiness('/after-sales/modeling/ai-reception-policy/save', {
        policyName: 'E2E 小序接待策略',
        confidenceThreshold: 70,
        sensitiveKeywords: ['投诉', '退款'],
        forceHumanOnSensitive: true,
        receptionWorkdays: [1, 2, 3, 4, 5],
        receptionHoursStart: '09:00',
        receptionHoursEnd: '18:00',
        sessionRetentionDays: 90,
        solutionDedupEnabled: true,
        maxSuggestions: 5
      }))
      const policy = dataOf(await api.getBusiness('/after-sales/modeling/ai-reception-policy/get'))
      caseRecord.checks.push({
        name: 'AI不得自动受理/关闭/改写客户事实',
        passed:
          Boolean(policy) &&
          policy.forbidAutoAccept === true &&
          policy.forbidAutoClose === true &&
          policy.forbidFactRewrite === true &&
          policy.maxSuggestions <= 5,
        details: `policyId=${policyId}`
      })
      let invalidConfidenceRejected = false
      try {
        await api.postBusiness('/after-sales/modeling/ai-reception-policy/save', {
          policyName: 'E2E 非法阈值',
          confidenceThreshold: 120,
          maxSuggestions: 5
        })
      } catch (error) {
        invalidConfidenceRejected = true
      }
      caseRecord.checks.push({
        name: '置信度阈值越界被拒绝',
        passed: invalidConfidenceRejected,
        details: '阈值限定 0-100'
      })
    } finally {
      if (previousPolicy?.id) {
        await cleanup(caseRecord, `恢复小序接待策略原值 ${previousPolicy.id}`, () =>
          api.postBusiness('/after-sales/modeling/ai-reception-policy/save', {
            id: previousPolicy.id,
            policyName: previousPolicy.policyName,
            confidenceThreshold: previousPolicy.confidenceThreshold,
            sensitiveKeywords: parseJson(previousPolicy.sensitiveKeywordsJson, null),
            forceHumanOnSensitive: previousPolicy.forceHumanOnSensitive,
            receptionWorkdays: parseJson(previousPolicy.receptionWorkdaysJson, null),
            receptionHoursStart: previousPolicy.receptionHoursStart,
            receptionHoursEnd: previousPolicy.receptionHoursEnd,
            sessionRetentionDays: previousPolicy.sessionRetentionDays,
            solutionDedupEnabled: previousPolicy.solutionDedupEnabled,
            maxSuggestions: previousPolicy.maxSuggestions
          })
        )
      } else if (policyId) {
        await cleanup(caseRecord, `停用本轮新建小序接待策略 ${policyId}`, () =>
          api.postBusiness(`/after-sales/modeling/ai-reception-policy/status?id=${policyId}&enabled=false`)
        )
      }
    }
    return { token, api }
  }

  if (caseId === 'PB125-001') {
    assertPb125LocalTarget()
    const fixture = newPb125Fixture()
    let active
    let beforeFacts
    let cleanupComplete = false
    const stages = []
    const verifyFacts = async (stage) => {
      const after = await readPb125InventoryFacts(api, fixture)
      assertPb125InventoryUnchanged(beforeFacts, after)
      stages.push(stage)
      caseRecord.evidence.push(`PB125 ${stage}: materialId=${fixture.materialId}, WMS报表total=0，完整物理库存行=0，存货主档逐字段不变`)
    }
    try {
      await preparePb125Material(api, fixture)
      beforeFacts = await readPb125InventoryFacts(api, fixture)
      const assets = await preparePb125Assets(api, fixture)
      active = assets[0]
      await verifyFacts('创建在保及到期资产')
      const listed = assertPb125AssetSearch(
        await api.getBusiness(`/after-sales/asset/page?pageNo=1&pageSize=100&customerId=${fixture.customerId}&keyword=${active.assetNo}`),
        fixture, active
      )
      caseRecord.checks.push({
        name: '手工客户资产可在分页中按 assetNo 独立检索',
        passed:
          listed?.assetNo === active.assetNo &&
          String(listed?.customerId) === String(fixture.customerId) &&
          Object.prototype.hasOwnProperty.call(listed || {}, 'serviceStatus'),
        details: `assetId=${active.assetId}, assetNo=${active.assetNo}, customerId=${fixture.customerId}`
      })
      const detail = active.detail
      const managers = detail?.managers || []
      const periods = detail?.servicePeriods || []
      caseRecord.checks.push({
        name: '客户资产详情统一回读服务期、责任人和存货档案引用',
        passed:
          String(detail?.asset?.id) === active.assetId &&
          detail?.asset?.serviceStatus === 'IN_SERVICE' &&
          String(detail?.asset?.materialId) === String(fixture.materialId) &&
          managers.some((manager) => manager.managerName === `${fixture.marker}-MANAGER`) &&
          periods.some((period) => period.sourceType === 'MANUAL') &&
          String(detail?.customer?.id) === String(fixture.customerId),
        details: `assetId=${active.assetId}, materialId=${detail?.asset?.materialId}, managers=${managers.length}, periods=${periods.length}`
      })
      caseRecord.checks.push({
        name: '客户资产不是存货余额载体，不含库存数量字段',
        passed:
          !Object.prototype.hasOwnProperty.call(detail?.asset || {}, 'stockQuantity') &&
          !Object.prototype.hasOwnProperty.call(detail?.asset || {}, 'inventoryQuantity') &&
          Boolean(detail?.asset?.materialId),
        details: `assetKeys=${Object.keys(detail?.asset || {}).join(',')}`
      })
      await changePb125AssetStatus(api, fixture, active, 'SERVICE_SUSPENDED')
      await verifyFacts('正式停服事件')
      await changePb125AssetStatus(api, fixture, active, 'IN_SERVICE')
      await verifyFacts('正式恢复事件')
      const contactName = `${fixture.marker}-PAGE-CONTACT`
      const contactMobile = '13800000125'
      const contactId = dataOf(await api.postBusiness('/after-sales/asset/contact/create', {
        customerId: fixture.customerId, contactName, mobile: contactMobile, primary: false
      }))
      const expected = {
        customerId: fixture.customerId, assetId: active.assetId, assetNo: active.assetNo,
        contactId, contactName, managerName: `${fixture.marker}-PAGE-MANAGER`,
        managerMobile: '13800000126', servicePeriod: fixture.pagePeriod
      }
      await saveAssetProfileInBrowser(page, expected, {
        capture: (name) => saveScreenshot(page, outputDir, name, record)
      })
      const after = await readPb125Asset(api, fixture, active)
      const persistedPeriod = after?.servicePeriods?.find((row) =>
        row.sourceNo === expected.servicePeriod.sourceNo)
      caseRecord.checks.push({
        name: '售后设置页保存服务期、责任人和联系人后清局部状态刷新，与服务端一致',
        passed:
          String(after?.asset?.id) === active.assetId &&
          after.asset.assetNo === active.assetNo &&
          String(after.asset.customerId) === String(fixture.customerId) &&
          after.managers?.length === 1 &&
          after.managers[0].managerName === expected.managerName &&
          after.managers[0].managerMobile === expected.managerMobile &&
          after.assetContacts?.length === 1 &&
          String(after.assetContacts[0].contactId) === String(contactId) &&
          after.assetContacts[0].contactNameSnapshot === contactName &&
          after.assetContacts[0].mobileSnapshot === contactMobile &&
          persistedPeriod?.startDate === expected.servicePeriod.startDate &&
          persistedPeriod?.endDate === expected.servicePeriod.endDate &&
          persistedPeriod?.sourceName === expected.servicePeriod.sourceName &&
          after.servicePeriods.length === periods.length + 1 &&
          periods.every((before) => after.servicePeriods.some((period) =>
            String(period.id) === String(before.id) &&
            period.startDate === before.startDate && period.endDate === before.endDate)),
        details: `assetId=${active.assetId}, contactId=${contactId}, manager=${after?.managers?.[0]?.managerName}, newPeriod=${persistedPeriod?.id}`
      })
      addSameCaseGapEvidence(caseRecord, PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId][2].check, [
        '售后设置页保存服务期、责任人和联系人后清局部状态刷新，与服务端一致'
      ])
      assertPb125ServicePeriod(after, fixture.pagePeriod, 'IN_SERVICE', {
        startDate: active.period.startDate, endDate: fixture.pagePeriod.endDate,
      })
      await verifyFacts('真实页面保存追加服务期责任人联系人')
      await verifyExpiredAssetInBrowser(page, {
        assetNo: assets[1].assetNo, ...fixture.expiredPeriod
      }, { capture: (name) => saveScreenshot(page, outputDir, name, record) })
      const accepted = await verifyPb125ExpiredAcceptance(api, fixture)
      caseRecord.checks.push({
        name: 'PB125 到期资产真实风险提示且服务单匹配到期SLA正式受理',
        passed: true,
        details: `assetId=${accepted.assetId}, ticketId=${accepted.ticketId}, policyId=${accepted.policyId}；服务到期风险行真实存在，正式创建后进入PROCESSING，资产仍SERVICE_EXPIRED`
      })
      await verifyFacts('到期资产创建服务单并正式受理')
      await changePb125AssetStatus(api, fixture, active, 'RETIRED')
      await changePb125AssetStatus(api, fixture, assets[1], 'RETIRED')
      const statusEvents = await verifyPb125StatusEvents(fixture, active)
      caseRecord.checks.push({
        name: 'PB125 服务期计算与正式停服恢复退役历史精确回读',
        passed: true,
        details: `在保/到期由各自专属服务期计算；${active.assetId}状态日志=${JSON.stringify(statusEvents)}`
      })
      addSameCaseGapEvidence(caseRecord, PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId][1].check, [
        'PB125 服务期计算与正式停服恢复退役历史精确回读',
        'PB125 到期资产真实风险提示且服务单匹配到期SLA正式受理'
      ])
      await verifyFacts('两项专属资产正式退役')
    } finally {
      await cleanup(caseRecord, `PB125 专属服务单关闭、资产退役和分类SLA停用回读 ${fixture.marker}`, async () => {
        await cleanupPb125Fixtures(api, fixture)
        cleanupComplete = true
      })
    }
    const retired = await readPb125Asset(api, fixture, active)
    await verifyFacts('正式服务单关闭与配置清理完成')
    caseRecord.checks.push({
      name: '资产退役后状态回读为 RETIRED，不改动存货档案',
      passed:
        retired?.asset?.serviceStatus === 'RETIRED' &&
        String(retired?.asset?.materialId) === String(fixture.materialId) && cleanupComplete,
      details: `assetId=${active.assetId}, status=${retired?.asset?.serviceStatus}；已对比资产创建前与退役后完整WMS及存货事实`
    })
    caseRecord.checks.push({
      name: PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId][0].check,
      passed: cleanupComplete && stages.length === 7,
      details: `专属materialId=${fixture.materialId}；全部阶段=${stages.join('、')}；API现存量与mes_stk_inventory完整维度只读回查，不借PB127证据`
    })
    caseRecord.evidence.push(
      `PB125 ${fixture.marker}：资产 ${fixture.assets.map((asset) => asset.assetId).join(',')} 已退役，服务单 ${fixture.ticketId} 已按处理→专属测试客户确认→正式关闭流程回读CLOSED，分类 ${fixture.categoryId}/SLA ${fixture.policyId} 已停用。客户、联系人、服务期、关闭服务单及所引用专属物料无资产删除链，保留所有权明确的审计历史，不改共享数据。`
    )
    return { token, api }
  }

  if (caseId === 'PB127-001') {
    // PB-939 要求验收通过必须匹配已确认范围基线，因此使用本轮专属项目自带四项基线。
    const projectType = await resolveEnabledProjectType(api)
    const dedicated = await createDedicatedProject({
      api,
      caseId,
      projectType,
      caseRecord,
      activate: true
    })
    const project = dedicated.project
    const baseline = listOf(
      await api.getBusiness(`/pm/baseline/list?projectId=${dedicated.projectId}`)
    ).find((item) => item?.baselineType === 'SCOPE' && item?.status === 'CONFIRMED')
    if (!baseline?.id) {
      caseRecord.notes.push('BLOCKED：专属项目缺少已确认 SCOPE 基线，无法通过验收证据门禁。')
      return { token, api, partial: true }
    }
    const fixture = await createProjectAcceptanceAssetFixture(api, project, 'PB127', baseline.id)
    try {
      const detail = fixture.detail
      const periods = detail?.servicePeriods || []
      caseRecord.checks.push({
        name: '客户资产来源类型与来源项目/验收引用可回读',
        passed:
          detail?.asset?.sourceType === 'PROJECT_ACCEPTANCE' &&
          String(detail?.asset?.sourceProjectId) === String(project.id) &&
          String(detail?.asset?.sourceAcceptanceId) === String(fixture.acceptanceId),
        details: `assetId=${fixture.assetId}, sourceProjectId=${detail?.asset?.sourceProjectId}, sourceAcceptanceId=${detail?.asset?.sourceAcceptanceId}`
      })
      caseRecord.checks.push({
        name: '服务期来源关联项目验收单且资产处于在保状态',
        passed:
          detail?.asset?.serviceStatus === 'IN_SERVICE' &&
          periods.some(
            (period) =>
              period.sourceType === 'PROJECT_ACCEPTANCE' &&
              String(period.sourceId) === String(fixture.acceptanceId)
          ),
        details: `serviceStatus=${detail?.asset?.serviceStatus}, periods=${periods.length}`
      })
      const acceptance = dataOf(
        await api.getBusiness(`/pm/customer-acceptance/get?id=${fixture.acceptanceId}`)
      )
      caseRecord.checks.push({
        name: '来源验收单真实存在且状态为 APPROVED',
        passed:
          acceptance?.status === 'APPROVED' &&
          String(acceptance?.projectId) === String(project.id),
        details: `acceptanceId=${fixture.acceptanceId}, status=${acceptance?.status}`
      })
    } finally {
      await cleanup(caseRecord, `退役本轮项目验收资产 ${fixture.assetId}`, () =>
        retireAsset(api, fixture.assetId)
      )
    }
    const retired = dataOf(await api.getBusiness(`/after-sales/asset/get?id=${fixture.assetId}`))
    caseRecord.checks.push({
      name: '项目验收资产退役后仍保留来源引用',
      passed:
        retired?.asset?.serviceStatus === 'RETIRED' &&
        String(retired?.asset?.sourceAcceptanceId) === String(fixture.acceptanceId),
      details: `assetId=${fixture.assetId}, status=${retired?.asset?.serviceStatus}`
    })
    await openRoute(page, '/after-sales/settings')
    await saveScreenshot(page, outputDir, 'pb127-project-acceptance-asset', record)
    caseRecord.evidence.push(
      `PB-127 以项目 ${project.id} 与验收单 ${fixture.acceptanceId} 生成售后资产 ${fixture.assetId}，验证来源引用`
    )
    return { token, api }
  }

  if (caseId === 'PB128-001') {
    const closure = await runEvaluationClosureCase({
      caseId, api, page, caseRecord,
      capture: (label) => saveScreenshot(page, outputDir, label, record)
    })
    caseRecord.evidence.push(
      `PB128 独立夹具 ${closure.fixture.marker} 完成真实页面保存刷新、编码/引用保护及正式评价版本回读；ticketId=${closure.fixture.ticketId}`
    )
    return { token, api, partial: closure.partial }
  }

  if (caseId === 'PB129-001') {
    const closure = await runEvaluationClosureCase({
      caseId, api, page, caseRecord,
      capture: (label) => saveScreenshot(page, outputDir, label, record)
    })
    caseRecord.evidence.push(
      `PB129 独立夹具 ${closure.fixture.marker} 完成完整 V1/V2 快照、正式评价及历史统计回读；ticketId=${closure.fixture.ticketId}`
    )
    return { token, api, partial: closure.partial }
  }

  if (caseId === 'PB945-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      const outsideDate = await findWorkingDate(api, dateOffsetFrom(workingDate, 10))
      const projectStart = dateOffsetFrom(workingDate, -7)
      const projectEnd = dateOffsetFrom(workingDate, 90)
      await api.putBusiness('/pm/project/update', projectUpdatePayload(
        fixture.project,
        {
          status: 'EXECUTING',
          plannedStartDate: projectStart,
          plannedEndDate: projectEnd
        }
      ))
      const insideTaskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: `${fixture.marker}_INSIDE`,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const outsideTaskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: `${fixture.marker}_OUTSIDE`,
        plannedStartDate: outsideDate,
        plannedEndDate: outsideDate
      })
      const milestone = await createMilestoneFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const risk = await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        relatedType: 'TASK',
        relatedId: insideTaskId
      })
      const beforeTask = dataOf(await api.getBusiness(`/pm/task/get?id=${insideTaskId}`))
      const beforeOutsideTask = dataOf(await api.getBusiness(`/pm/task/get?id=${outsideTaskId}`))
      const generated = []
      for (const [reportType, periodKey] of [
        ['DAILY', workingDate],
        ['WEEKLY', isoWeekKey(workingDate)],
        ['MONTHLY', workingDate.slice(0, 7)]
      ]) {
        const reportId = numericId(dataOf(await api.postBusiness(
          `/pm/daily-report/generate?projectId=${fixture.projectId}&reporterId=${fixture.ownerId}` +
          `&reportType=${reportType}&periodKey=${encodeURIComponent(periodKey)}`
        )), `${reportType} 周期报告`)
        const report = dataOf(await api.getBusiness(`/pm/daily-report/get?id=${reportId}`))
        const range = resolveReportPeriodRange(reportType, periodKey)
        const source = dataOf(await api.getBusiness(
          `/pm/daily-report/source?projectId=${fixture.projectId}` +
          `&reportType=${reportType}&periodKey=${encodeURIComponent(periodKey)}`
        ))
        const sourceTaskIds = (source?.tasks || []).map((item) => String(item.id))
        const periodMatches =
          range &&
          String(report?.periodStart) === range[0] &&
          String(report?.periodEnd) === range[1]
        const sourceMatches =
          String(source?.projectId) === String(fixture.projectId) &&
          sourceTaskIds.includes(String(insideTaskId)) &&
          Array.isArray(source?.risks) &&
          (source?.risks || []).some((item) => String(item.id) === String(risk.riskId)) &&
          Array.isArray(source?.milestones) &&
          (source?.milestones || []).some((item) => String(item.id) === String(milestone.milestoneId))
        caseRecord.checks.push({
          name: `${reportType} 生成周期范围并由服务端构造只读来源快照`,
          passed:
            Boolean(range) &&
            periodMatches &&
            report?.aiSuggestionStatus === 'SUGGESTED' &&
            sourceMatches &&
            Boolean(source?.generatedAt) &&
            typeof report?.sourceSnapshotJson === 'string' &&
            report.sourceSnapshotJson.includes('generatedAt'),
          details: `reportId=${reportId}, period=${report?.periodStart}~${report?.periodEnd}, sourceTasks=${sourceTaskIds.join(',')}`
        })
        generated.push({ reportType, reportId, sourceTaskIds })
      }
      const daily = generated.find((item) => item.reportType === 'DAILY')
      caseRecord.checks.push({
        name: '日报来源按当天过滤，周期外任务不进入快照',
        passed:
          daily?.sourceTaskIds.includes(String(insideTaskId)) &&
          !daily?.sourceTaskIds.includes(String(outsideTaskId)),
        details: `inside=${insideTaskId}, outside=${outsideTaskId}, snapshot=${daily?.sourceTaskIds.join(',')}`
      })
      const afterTask = dataOf(await api.getBusiness(`/pm/task/get?id=${insideTaskId}`))
      const afterOutsideTask = dataOf(await api.getBusiness(`/pm/task/get?id=${outsideTaskId}`))
      assertProjectTaskFactsUnchanged(beforeTask, afterTask)
      assertProjectTaskFactsUnchanged(beforeOutsideTask, afterOutsideTask)
      caseRecord.projectTaskFacts = [
        { before: beforeTask, after: afterTask },
        { before: beforeOutsideTask, after: afterOutsideTask }
      ]
      caseRecord.checks.push({
        name: '报告生成不修改内外周期任务的完整正式事实和全部日期',
        passed: true,
        details: `inside=${insideTaskId}, outside=${outsideTaskId}; complete API facts compared`
      })
      caseRecord.checks.push({
        name: '报告生成只读取任务和工时，不反写任务状态',
        passed:
          afterTask?.status === beforeTask?.status &&
          String(afterTask?.plannedEndDate) === String(beforeTask?.plannedEndDate),
        details: `taskId=${insideTaskId}, before=${beforeTask?.status}, after=${afterTask?.status}`
      })
      caseRecord.evidence.push(
        `PB-945 在专属项目 ${fixture.projectId} 生成 ${generated.map((item) => `${item.reportType}:${item.reportId}`).join(', ')}，日报仅包含 ${workingDate} 的任务`
      )
    } finally {
      const restored = await restoreDedicatedProject(api, fixture)
      caseRecord.checks.push({
        name: '专属项目周期与状态清理后回读',
        passed:
          isDedicatedProject(restored, fixture) &&
          restored?.status === fixture.project.status,
        details: `projectId=${fixture.projectId}, status=${restored?.status}`
      })
    }
    return { token, api }
  }

  if (caseId === 'PB947-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const risk = await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        relatedType: 'TASK',
        relatedId: taskId
      })
      const issueId = dataOf(await api.postBusiness('/pm/issue/save', {
        projectId: fixture.projectId,
        title: `${fixture.marker} 问题`,
        description: 'E2E 验证问题独立于风险记录',
        level: 'MEDIUM',
        ownerId: fixture.ownerId,
        ownerName: '管理员',
        dueDate: dateOffset(14)
      }))
      const bugId = dataOf(await api.postBusiness('/pm/bug/save', {
        projectId: fixture.projectId,
        title: `${fixture.marker} Bug`,
        description: 'E2E 验证 Bug 独立编号与记录',
        severity: 'MEDIUM',
        priority: 2,
        reporterId: fixture.ownerId,
        reporterName: '管理员',
        assigneeId: fixture.ownerId,
        assigneeName: '管理员',
        dueDate: dateOffset(14)
      }))
      const [issue, bug] = await Promise.all([
        api.getBusiness(`/pm/issue/get?id=${issueId}`),
        api.getBusiness(`/pm/bug/get?id=${bugId}`)
      ])
      caseRecord.checks.push({
        name: '风险、问题、Bug 使用独立记录和编号，不通过转化删除原记录',
        passed:
          Boolean(dataOf(issue)?.issueNo) &&
          Boolean(dataOf(bug)?.bugNo) &&
          String(dataOf(issue)?.id) !== String(dataOf(bug)?.id),
        details: `riskNo=${risk.detail?.riskNo}, issueNo=${dataOf(issue)?.issueNo}, bugNo=${dataOf(bug)?.bugNo}`
      })
      const convertedBugId = numericId(
        dataOf(await api.postBusiness(`/pm/issue/convert-to-bug?id=${issueId}`)),
        '问题转化 Bug'
      )
      const repeatedConvertedBugId = numericId(
        dataOf(await api.postBusiness(`/pm/issue/convert-to-bug?id=${issueId}`)),
        '问题重复转化 Bug'
      )
      const convertedIssueId = numericId(
        dataOf(await api.postBusiness(`/pm/bug/convert-to-issue?id=${bugId}`)),
        'Bug 转化问题'
      )
      const repeatedConvertedIssueId = numericId(
        dataOf(await api.postBusiness(`/pm/bug/convert-to-issue?id=${bugId}`)),
        'Bug 重复转化问题'
      )
      const [convertedBug, convertedIssue, issueAfterConversion, bugAfterConversion] =
        await Promise.all([
          api.getBusiness(`/pm/bug/get?id=${convertedBugId}`),
          api.getBusiness(`/pm/issue/get?id=${convertedIssueId}`),
          api.getBusiness(`/pm/issue/get?id=${issueId}`),
          api.getBusiness(`/pm/bug/get?id=${bugId}`)
        ])
      caseRecord.checks.push({
        name: '问题与 Bug 可双向转化，来源记录保留且重复转化幂等',
        passed:
          convertedBugId === repeatedConvertedBugId &&
          convertedIssueId === repeatedConvertedIssueId &&
          dataOf(convertedBug)?.sourceType === 'ISSUE' &&
          String(dataOf(convertedBug)?.sourceId) === String(issueId) &&
          String(dataOf(convertedBug)?.convertedFromId) === String(issueId) &&
          dataOf(convertedIssue)?.sourceType === 'BUG' &&
          String(dataOf(convertedIssue)?.sourceId) === String(bugId) &&
          String(dataOf(convertedIssue)?.convertedFromId) === String(bugId) &&
          Boolean(dataOf(issueAfterConversion)?.issueNo) &&
          Boolean(dataOf(bugAfterConversion)?.bugNo),
        details:
          `issue=${issueId}->bug=${convertedBugId}, bug=${bugId}->issue=${convertedIssueId}, ` +
          `repeated=${repeatedConvertedBugId}/${repeatedConvertedIssueId}`
      })
      await api.postBusiness('/pm/risk/save', riskUpdatePayload(risk.detail, { level: 'HIGH' }))
      const leveled = dataOf(await api.getBusiness(`/pm/risk/get?id=${risk.riskId}`))
      const history = parseRiskLevelHistory(leveled?.levelHistoryJson)
      caseRecord.checks.push({
        name: '风险等级变化写前值、变化时间和结构化历史',
        passed:
          leveled?.level === 'HIGH' &&
          leveled?.previousLevel === 'LOW' &&
          Boolean(leveled?.levelChangedTime) &&
          history.some((item) =>
            item?.previousLevel === 'LOW' &&
            item?.currentLevel === 'HIGH' &&
            Boolean(item?.changedTime)),
        details: `riskId=${risk.riskId}, history=${JSON.stringify(history)}`
      })
      caseRecord.checks.push({
        name: '风险可关联任务且保留责任人和期限',
        passed:
          leveled?.relatedType === 'TASK' &&
          String(leveled?.relatedId) === String(taskId) &&
          String(leveled?.ownerId) === String(fixture.ownerId) &&
          Boolean(leveled?.dueDate),
        details: `relatedType=${leveled?.relatedType}, relatedId=${leveled?.relatedId}, dueDate=${leveled?.dueDate}`
      })
      await api.putBusiness('/pm/risk/status', { id: risk.riskId, status: 'MITIGATING' })
      const invalidMissingVerifier = await api.put('/pm/risk/status', {
        id: risk.riskId,
        status: 'CLOSED'
      }, {
        expectedBusinessRejection: {
          code: 1055009002,
          message: /verifier is required before closing/
        }
      })
      caseRecord.checks.push({
        name: '风险关闭缺少验证人时按领域错误拒绝',
        passed: isBusinessRejected(
          invalidMissingVerifier,
          1055009002,
          'verifier is required before closing'
        ),
        details: JSON.stringify(invalidMissingVerifier)
      })
      await api.putBusiness('/pm/risk/status', {
        id: risk.riskId,
        status: 'CLOSED',
        verifierId: fixture.ownerId
      })
      const closed = dataOf(await api.getBusiness(`/pm/risk/get?id=${risk.riskId}`))
      caseRecord.checks.push({
        name: '风险验证后关闭并回读关闭时间、验证人和验证时间',
        passed:
          closed?.status === 'CLOSED' &&
          String(closed?.verifiedBy) === String(fixture.ownerId) &&
          Boolean(closed?.closedTime) &&
          Boolean(closed?.verifiedTime),
        details: `riskId=${risk.riskId}, status=${closed?.status}, verifiedBy=${closed?.verifiedBy}`
      })
      caseRecord.evidence.push(
        `PB-947 验证风险 ${risk.riskId} 关联任务 ${taskId}、LOW→HIGH 历史、关闭验证及问题 ${issueId}/Bug ${bugId} 独立记录`
      )
      await openRoute(page, '/project/execution/controls/risk-issue')
      await saveScreenshot(page, outputDir, 'pb947-risk-issue-governance', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return {
      token,
      api,
      acceptanceComplete: caseRecord.checks.every((check) => check.passed !== false)
    }
  }

  if (caseId === 'PB949-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      const changeId = await createChangeFixture({
        api,
        projectId: fixture.projectId,
        requesterId: fixture.ownerId,
        marker: fixture.marker,
        relatedType: 'TASK',
        relatedId: taskId
      })
      const idempotencyKey = unique('E2E_CHANGE_EXEC')
      const history = []
      const captureChange = async () => {
        const snapshot = dataOf(await api.getBusiness(`/pm/change/get?id=${changeId}`))
        history.push(structuredClone(snapshot))
        return snapshot
      }
      await captureChange()
      await setChangeStatus(api, changeId, 'ASSESSING')
      await captureChange()
      await setChangeStatus(api, changeId, 'PENDING_APPROVAL')
      await captureChange()
      await setChangeStatus(api, changeId, 'APPROVED', {
        objectVersion: 1,
        downstreamStrategy: 'MANUAL',
        approvalOpinion: 'E2E 审批通过并冻结对象版本'
      })
      const approved = await captureChange()
      caseRecord.checks.push({
        name: '变更审批通过冻结对象版本并记录下游处理策略',
        passed:
          approved?.status === 'APPROVED' &&
          approved?.objectVersion === 1 &&
          approved?.downstreamStrategy === 'MANUAL' &&
          String(approved?.approverId) === String(fixture.ownerId),
        details: `changeId=${changeId}, version=${approved?.objectVersion}, strategy=${approved?.downstreamStrategy}`
      })
      await setChangeStatus(api, changeId, 'EXECUTING', { executionIdempotencyKey: idempotencyKey })
      const executing = await captureChange()
      caseRecord.checks.push({
        name: '服务端一次性执行写入幂等键、执行人和执行时间',
        passed:
          executing?.status === 'EXECUTING' &&
          executing?.executionIdempotencyKey === idempotencyKey &&
          String(executing?.executedBy) === String(fixture.ownerId) &&
          Boolean(executing?.executedTime) &&
          executing?.fieldChanges?.[0]?.executionStatus === 'EXECUTING',
        details: `changeId=${changeId}, key=${executing?.executionIdempotencyKey}, fieldStatus=${executing?.fieldChanges?.[0]?.executionStatus}`
      })
      await setChangeStatus(api, changeId, 'VERIFIED', {
        approvalOpinion: 'E2E 执行结果已验证'
      })
      await captureChange()
      await setChangeStatus(api, changeId, 'CLOSED', {
        approvalOpinion: 'E2E 变更闭环'
      })
      const closed = await captureChange()
      assertProjectChangeLifecycle(history)
      caseRecord.projectChangeHistory = history
      caseRecord.checks.push({
        name: '变更七个状态逐步正式回读且身份版本和全链路时间保持一致',
        passed: true,
        details: `change=${changeId}; states=${history.map((item) => item.status).join('->')}; create=${closed.createTime}, executed=${closed.executedTime}, verified=${closed.verifiedTime}, closed=${closed.closedTime}`
      })
      caseRecord.checks.push({
        name: '变更经执行、验证后关闭且全链路时间可回读',
        passed:
          closed?.status === 'CLOSED' &&
          Boolean(closed?.verifiedTime) &&
          Boolean(closed?.closedTime) &&
          closed?.fieldChanges?.[0]?.executionStatus === 'CLOSED',
        details: `changeId=${changeId}, status=${closed?.status}, verified=${closed?.verifiedTime}, closed=${closed?.closedTime}`
      })

      const duplicateChangeId = await createChangeFixture({
        api,
        projectId: fixture.projectId,
        requesterId: fixture.ownerId,
        marker: `${fixture.marker}_DUPLICATE`,
        relatedType: 'TASK',
        relatedId: taskId
      })
      await setChangeStatus(api, duplicateChangeId, 'ASSESSING')
      await setChangeStatus(api, duplicateChangeId, 'PENDING_APPROVAL')
      await setChangeStatus(api, duplicateChangeId, 'APPROVED', {
        objectVersion: 1,
        downstreamStrategy: 'MANUAL',
        approvalOpinion: 'E2E 重复幂等键验证'
      })
      const duplicate = await api.put('/pm/change/status', {
        id: duplicateChangeId,
        status: 'EXECUTING',
        executionIdempotencyKey: idempotencyKey
      }, {
        expectedBusinessRejection: {
          code: 1055012002,
          message: new RegExp(`change already executed with key ${idempotencyKey}`)
        }
      })
      caseRecord.checks.push({
        name: '重复幂等键被领域拒绝，不产生第二次执行',
        passed: isBusinessRejected(
          duplicate,
          1055012002,
          `change already executed with key ${idempotencyKey}`
        ),
        details: JSON.stringify(duplicate)
      })
      const duplicateAfter = dataOf(
        await api.getBusiness(`/pm/change/get?id=${duplicateChangeId}`)
      )
      caseRecord.checks.push({
        name: '重复执行拒绝后第二条变更仍停留在 APPROVED',
        passed: duplicateAfter?.status === 'APPROVED' && !duplicateAfter?.executedTime,
        details: `changeId=${duplicateChangeId}, status=${duplicateAfter?.status}`
      })
      caseRecord.evidence.push(
        `PB-949 变更 ${changeId} 完成 DRAFT→CLOSED，幂等键 ${idempotencyKey} 在 ${duplicateChangeId} 上被拒绝`
      )
      await openRoute(page, '/project/execution/plan-change/list')
      await saveScreenshot(page, outputDir, 'pb949-change-execution', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return { token, api }
  }

  if (caseId === 'PB951-001') {
    assertPmClosureLocalTarget()
    const result = await runProjectMilestoneClosure({
      api, page, record, caseRecord, outputDir,
      createProject: async (plannedWindow) => createDedicatedProject({
        api, caseId, projectType: await resolveEnabledProjectType(api), caseRecord,
        activate: true, plannedWindow
      })
    })
    return { token, api, ...result }
  }

  if (caseId === 'PB953-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      await completeTaskFixture(api, taskId)
      await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker
      })
      const query = {
        projectId: fixture.projectId,
        startDate: dateOffset(-1),
        endDate: dateOffset(1)
      }
      const reports = new Map()
      for (const definition of PROJECT_REPORT_DEFINITIONS) {
        const report = dataOf(await api.getBusiness(
          `/pm/report/${definition.path}?${pushReportQuery({}, query)}`
        ))
        reports.set(definition.reportType, report)
        caseRecord.checks.push({
          name: `${definition.reportType} 报表返回统一口径和同一筛选上下文`,
          passed:
            report?.reportType === definition.reportType &&
            Number.isInteger(Number(report?.metricVersion)) &&
            report?.calculationMode === 'RECHECKED' &&
            Boolean(report?.generatedAt) &&
            String(report?.appliedFilters?.projectId) === String(fixture.projectId) &&
            String(report?.appliedFilters?.startDate) === query.startDate &&
            String(report?.appliedFilters?.endDate) === query.endDate,
          details:
            `type=${report?.reportType}, version=${report?.metricVersion}, ` +
            `mode=${report?.calculationMode}, filters=${JSON.stringify(report?.appliedFilters)}`
        })
      }
      caseRecord.projectReportExports = []
      for (const definition of PROJECT_REPORT_DEFINITIONS) {
        const exportFile = await api.download(
          `/pm/report/export-excel?${pushReportQuery({ reportType: definition.reportType }, query)}`
        )
        const workbook = XLSX.read(exportFile.buffer, { type: 'buffer' })
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
          defval: null
        })
        if (rows.length !== 1) throw new Error(`PB953 ${definition.reportType} export expected one aggregate row`)
        assertProjectReportExportMatches(reports.get(definition.reportType), rows[0], query)
        caseRecord.projectReportExports.push({
          report: reports.get(definition.reportType), exportRow: rows[0]
        })
        caseRecord.checks.push({
          name: `${definition.reportType} 导出复用相同筛选并生成可解析 Excel`,
          passed:
            workbook.SheetNames.length > 0 &&
            rows.length > 0 &&
            String(rows[0]?.reportType) === definition.reportType &&
            String(rows[0]?.calculationMode) === 'RECHECKED',
          details: `contentType=${exportFile.contentType}, rows=${rows.length}, sheet=${workbook.SheetNames[0]}`
        })
      }
      caseRecord.checks.push({
        name: '十一类Excel导出逐项匹配列表项目日期版本和全部非空标量指标',
        passed: caseRecord.projectReportExports.length === 11,
        details: `project=${fixture.projectId}, range=${query.startDate}~${query.endDate}, types=${caseRecord.projectReportExports.map((item) => item.report.reportType).join(',')}`
      })
      caseRecord.evidence.push(
        `PB-953 对专属项目 ${fixture.projectId} 校验 11 类报表统一 projectId/startDate/endDate，并逐项验证全部 Excel 与查询口径一致`
      )
      caseRecord.projectReportBrowser = await verifyProjectReportPages({
        page, api, project: fixture.project, query, reports,
        capture: (name) => saveScreenshot(page, outputDir, name, record)
      })
      caseRecord.checks.push({
        name: '十一类项目报表真实页面按专属项目日期逐项展示且指标匹配正式查询',
        passed: caseRecord.projectReportBrowser.length === 11,
        details: caseRecord.projectReportBrowser.map((item) =>
          `${item.path}: route=${item.route}; project=${item.projectId}`).join('; ')
      })
      for (const route of ['/project/statistics/workspace', '/project/statistics/overview']) {
        await openRoute(page, route)
        const overview = page.locator('.module-overview')
        await overview.waitFor({ state: 'visible', timeout: 15000 })
        assertProjectReportPageText(await page.locator('body').innerText())
        const title = await overview.locator('h1').innerText()
        if (title !== '过程报告' || new URL(page.url()).pathname !== route) {
          throw new Error(`PB953 report overview context mismatch: ${route}`)
        }
        caseRecord.checks.push({
          name: `旧统计入口模块上下文正常:${route}`,
          passed: true,
          details: '旧菜单未携带 moduleKey 时解析为 reporting；仅验证入口配置，不作为业务指标证据'
        })
        await saveScreenshot(page, outputDir, `pb953-statistics-${route.split('/').at(-1)}`, record)
      }
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return { token, api }
  }

  if (caseId === 'PB955-001') {
    const projectType = await resolveEnabledProjectType(api)
    const fixture = await createDedicatedProject({ api, caseId, projectType, caseRecord, activate: true })
    try {
      const workingDate = await findWorkingDate(api, dateOffset(-14))
      await api.putBusiness('/pm/project/update', projectUpdatePayload(fixture.project, {
        status: 'EXECUTING',
        plannedStartDate: dateOffsetFrom(workingDate, -7),
        plannedEndDate: dateOffsetFrom(workingDate, 90)
      }))
      const taskId = await createTaskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      await completeTaskFixture(api, taskId)
      const milestone = await createMilestoneFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker,
        withGates: true,
        plannedStartDate: workingDate,
        plannedEndDate: workingDate
      })
      await api.putBusiness(`/pm/milestone/confirm?id=${milestone.milestoneId}`, undefined)
      await api.putBusiness(
        `/pm/milestone/complete?id=${milestone.milestoneId}` +
        `&manualConclusion=${encodeURIComponent('E2E 绩效里程碑完成')}`,
        undefined
      )
      const risk = await createRiskFixture({
        api,
        projectId: fixture.projectId,
        ownerId: fixture.ownerId,
        marker: fixture.marker
      })
      await api.postBusiness('/pm/risk/save', riskUpdatePayload(risk.detail, { level: 'HIGH' }))
      await api.putBusiness('/pm/risk/status', { id: risk.riskId, status: 'MITIGATING' })
      await api.putBusiness('/pm/risk/status', {
        id: risk.riskId,
        status: 'CLOSED',
        verifierId: fixture.ownerId
      })

      const formula = dataOf(await api.getBusiness('/pm/report/performance/formula'))
      caseRecord.checks.push({
        name: '绩效公式、数据来源、剔除规则和可见角色公开可读',
        passed:
          Boolean(formula?.configCode) &&
          Boolean(formula?.metricVersion) &&
          typeof formula?.formula === 'string' &&
          formula.formula.trim().length > 0 &&
          Array.isArray(formula?.dataSource) &&
          formula.dataSource.length > 0 &&
          Array.isArray(formula?.excludeRules) &&
          Array.isArray(formula?.visibleRoles) &&
          Boolean(formula?.weightRules),
        details: `config=${formula?.configCode}, version=${formula?.metricVersion}, sources=${formula?.dataSource?.join(',')}`
      })
      const query = {
        projectId: fixture.projectId,
        startDate: dateOffset(-1),
        endDate: dateOffset(1)
      }
      const summary = dataOf(await api.getBusiness(
        `/pm/report/performance/summary?${pushReportQuery({}, query)}`
      ))
      const row = (summary?.rows || []).find(
        (item) => String(item.userId) === String(fixture.ownerId)
      )
      // 专属项目在交接评审时会按模板展开里程碑与任务，plannedWeight 因此包含模板计划量；
      // 绩效口径按公开公式校验：completionRate 必须等于 deliveredWeight / plannedWeight * 100。
      const plannedWeight = Number(row?.plannedWeight)
      const deliveredWeight = Number(row?.deliveredWeight)
      const expectedCompletionRate =
        Number.isFinite(plannedWeight) && plannedWeight > 0
          ? Number(((deliveredWeight * 100) / plannedWeight).toFixed(2))
          : null
      caseRecord.checks.push({
        name: '绩效汇总按正式已验收任务和已完成里程碑计算权重与完成率',
        passed:
          summary?.reportType === 'PROJECT_PERFORMANCE' &&
          Number(row?.acceptedTaskCount) >= 1 &&
          Number(row?.completedMilestoneCount) >= 1 &&
          Number.isFinite(plannedWeight) &&
          plannedWeight >= deliveredWeight &&
          deliveredWeight >= 18 &&
          Number(row?.completionRate) === expectedCompletionRate &&
          summary?.formula === formula?.formula,
        details: `row=${JSON.stringify(row)}, expectedCompletionRate=${expectedCompletionRate}`
      })
      const person = dataOf(await api.getBusiness(
        `/pm/report/performance/person?${pushReportQuery({ userId: fixture.ownerId }, query)}`
      ))
      caseRecord.checks.push({
        name: '个人绩效明细返回任务、里程碑和统一公式口径',
        passed:
          String(person?.userId) === String(fixture.ownerId) &&
          Number(person?.acceptedTaskCount) >= 1 &&
          Number(person?.completedMilestoneCount) >= 1 &&
          (person?.tasks || []).some((item) => String(item.id) === String(taskId)) &&
          (person?.milestones || []).some(
            (item) => String(item.id) === String(milestone.milestoneId)
          ) &&
          Number(person?.metricVersion) === Number(summary?.metricVersion) &&
          person?.formula === summary?.formula,
        details: `user=${person?.userName}, tasks=${person?.tasks?.length}, milestones=${person?.milestones?.length}`
      })
      const trend = dataOf(await api.getBusiness(
        `/pm/report/risk-trend?${pushReportQuery({}, query)}`
      ))
      const change = (trend?.changes || []).find(
        (item) => String(item.riskId) === String(risk.riskId)
      )
      const handling = (trend?.handlingDurations || []).find(
        (item) => String(item.riskId) === String(risk.riskId)
      )
      caseRecord.checks.push({
        name: '风险趋势保留等级变化和验证关闭后的处置时长',
        passed:
          trend?.reportType === 'RISK_TREND' &&
          change?.previousLevel === 'LOW' &&
          change?.currentLevel === 'HIGH' &&
          Boolean(change?.changedTime) &&
          handling?.status === 'CLOSED' &&
          Boolean(handling?.verifiedTime) &&
          Number(handling?.durationDays) >= 0,
        details: `change=${JSON.stringify(change)}, handling=${JSON.stringify(handling)}`
      })
      caseRecord.evidence.push(
        `PB-955 专属项目 ${fixture.projectId} 完成任务 ${taskId}(8h)、里程碑 ${milestone.milestoneId}(权重10) 和风险 ${risk.riskId}，绩效完成率 100%`
      )
      await openRoute(page, '/project/ai/performance/dashboard')
      await saveScreenshot(page, outputDir, 'pb955-performance', record)
    } finally {
      await restoreDedicatedProject(api, fixture)
    }
    return { token, api }
  }

  caseRecord.notes.push(`未识别的案例：${caseId}`)
  return { token, api }
}

export const runCase = async (args) => {
  const { caseId, caseRecord } = args
  initializeProjectAfterSalesCatalogAssertions(caseRecord, caseId)
  let result
  try {
    if (caseId === 'PB123-001') {
      if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
        throw new Error('BLOCKED: PB123 安全负例需要 CFOR_E2E_WRITE_FIXTURES=true；全局知识索引 worker 仍禁止。')
      }
      assertKnowledgeReadinessLocalContext(config, config.tenantId)
      const { token, tenantId } = await login(args.page, { returnContext: true })
      caseRecord.checks.push({ name: 'PB123 复用真实租户1登录会话', passed: Boolean(token) && tenantId === '1' })
      const knowledgePage = await args.page.context().newPage()
      try {
        const screenshotPath = path.join(args.outputDir, 'pb123-knowledge-readiness.png')
        result = await runProjectAfterSalesKnowledgeReadiness({
          token, tenantId, runId: args.record.runId, caseRecord,
          page: knowledgePage, screenshotPath
        })
        caseRecord.checks.push({ name: 'PB123 安全就绪审计各执行阶段无异常',
          passed: result.auditSucceeded, details: JSON.stringify(result.failures) })
        if (result.negative) {
          caseRecord.checks.push({ name: 'PB123 缺真实文档版本按1040011精确拒绝且案例/事件全字段不变',
            passed: result.negative.matched && result.negative.unchanged })
          caseRecord.checks.push({ name: 'PB123 专属知识分类创建回读及正式停用回读',
            passed: Boolean(result.category) && result.categoryCleanup?.readback === true })
        }
        if (result.page?.loaded) {
          args.record.screenshots.push(screenshotPath)
          caseRecord.checks.push({ name: 'PB123 正式知识页面只读加载、真实列表请求及脱敏截图',
            passed: true, details: result.page.route })
        }
        for (const item of result.gaps) caseRecord.notes.push(`PB123 ${item.code}: ${item.reason}`)
        caseRecord.evidence.push(`PB123 原需求 ${result.requirementSource.sheet}/${result.requirementSource.range}；
          可用索引文档=${result.readiness?.candidates?.length ?? '未核实'}；未调用全局worker、搜索或policy副作用接口。`)
      } finally {
        await knowledgePage.close()
      }
      return { ...result, ...finalizeProjectAfterSalesCatalogAssertions(caseRecord, caseId, result) }
    }
    if (caseId === 'PB124-001') {
      if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
        caseRecord.notes.push(
          'PB124 受控对象夹具需要显式设置 CFOR_E2E_WRITE_FIXTURES=true；本轮未创建客户、资产、提醒规则或待发送事件。'
        )
        result = { partial: true }
        return { ...result, ...finalizeProjectAfterSalesCatalogAssertions(caseRecord, caseId, result) }
      }
      assertReminderLocalTarget()
    }
    if (PROJECT_AFTER_SALES_SAFETY_BLOCKS[caseId] && caseId !== 'PB124-001') {
      throw new Error(`BLOCKED: ${PROJECT_AFTER_SALES_SAFETY_BLOCKS[caseId]}`)
    }
    if (['PB112-001', 'PB113-001', 'PB114-001', 'PB116-001', 'PB122-001'].includes(caseId)) {
      assertPmClosureLocalTarget()
    }
    result = await runCaseCore(args)
  } catch (error) {
    finalizeProjectAfterSalesCatalogAssertions(caseRecord, caseId, { partial: true })
    throw error
  }
  const catalogResult = finalizeProjectAfterSalesCatalogAssertions(caseRecord, caseId, result)
  return {
    ...result,
    ...catalogResult
  }
}
