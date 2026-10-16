import fs from 'node:fs'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess, nonEmpty } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import {
  COST_OPENING_FIXTURE_MONTH,
  prepareCostModelFixture,
  prepareCostOpeningFixture,
  createLockedCostModelFixture
} from '../fixtures/cost-model.mjs'
import {
  COST_SCENARIO_BY_CASE,
  cleanupCostScenarioReviewer,
  loadCostScenario,
  loginAs,
  prepareCostScenario
} from '../fixtures/cost-scenario.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import {
  cleanupDedicatedCostDepartment,
  costWritesEnabled,
  prepareDedicatedCostDepartment,
  scopedCostScenarioApi
} from '../fixtures/cost-write-scope.mjs'
import {
  COST_ALLOCATION_CLOSURE_CHECKS,
  runCostAllocationClosure,
  verifyCostSharedWorkspaceBoundary
} from '../fixtures/cost-allocation-closure.mjs'
import { COST_OPENING_CHECKS, runCostOpeningClosure } from '../fixtures/cost-opening-closure.mjs'
import {
  COST_OPENING_BROWSER_CHECKS,
  verifyCostOpeningBrowserClosure
} from '../fixtures/cost-opening-browser-closure.mjs'
import { costOpeningPageActions } from '../fixtures/cost-opening-page.mjs'
import {
  COST_APPROVAL_CHECKS,
  COST_APPROVAL_PAGE_CHECKS,
  COST_OUTBOX_CHECKS,
  COST_SEPARATION_CHECKS,
  COST_WORKFLOW_CHECKS,
  runCostPublicationApprovalClosure,
  runCostOutboxClosure,
  runCostSeparationClosure,
  runCostWorkflowClosure
} from '../fixtures/cost-workflow-closure.mjs'
import {
  COST_PURCHASE_FREIGHT_CHECKS,
  runCostPurchaseFreightClosure
} from '../fixtures/cost-purchase-freight-closure.mjs'
import {
  COST_PURCHASE_SOURCE_CHECKS,
  COST_PURCHASE_RETURN_CHECKS,
  runCostPurchaseReceiptClosure,
  runCostPurchaseReturnClosure
} from '../fixtures/cost-purchase-source-closure.mjs'
import {
  COST_PURCHASE_REPORT_CHECKS,
  runCostPurchaseReportClosure
} from '../fixtures/cost-purchase-report-closure.mjs'
import {
  COST_ENTERPRISE_CHECKS,
  auditCostEnterpriseRoutes,
  readCostEnterpriseFactSnapshot,
  verifyCostEnterpriseRejections,
  verifyCostEnterpriseWorkbench
} from '../fixtures/cost-enterprise-route-evidence.mjs'
import {
  COST_CENTER_PERMISSION_CHECKS,
  hasCostCenterPermissionEvidence,
  preflightCostCenterPermissionClosure,
  runCostCenterPermissionClosure
} from '../fixtures/cost-center-permission-closure.mjs'
import {
  COST_OPERATING_CHECKS,
  hasCostOperatingEvidence,
  runCostOperatingClosure
} from '../fixtures/cost-operating-closure.mjs'
import {
  COST_STAGE_EVIDENCE_BINDINGS,
  costStageEvidenceBindings,
  runCostStageEvidenceClosure
} from '../fixtures/cost-stage-evidence-closure.mjs'
import {
  COST_FORMAL_REPORT_BINDINGS,
  COST_FORMAL_REPORT_CHECKS,
  hasCostFormalReportEvidence,
  runCostFormalReportClosure
} from '../fixtures/cost-formal-report-closure.mjs'

export const cases = ['COST-001', 'COST-002', 'COST-003', 'COST-004', 'COST-005', 'COST-006', 'COST-007', 'COST-008', 'COST-009', 'COST-010', 'COST-011', 'COST-012', 'COST-013', 'COST-014', 'COST-015', 'COST-016', 'COST-017', 'COST-018', 'COST-019', 'COST-020', 'COST-021', 'COST-022', 'COST-023', 'COST-024', 'COST-025', 'COST-026', 'COST-027', 'COST-028', 'COST-029', 'COST-030', 'COST-031', 'COST-032', 'COST-033', 'COST-034', 'COST-035', 'COST-036', 'COST-037', 'COST-038', 'COST-039']

// A catalog assertion can only be VERIFIED by the exact, named runtime checks
// below. Empty-list, route-only, or combined success-or-blocked probes remain GAP.
export const costCatalogBindings = Object.freeze({
  'COST-001': Object.freeze({
    0: [COST_ALLOCATION_CLOSURE_CHECKS.saveReadback],
    1: [COST_ALLOCATION_CLOSURE_CHECKS.fixture],
    2: [COST_ALLOCATION_CLOSURE_CHECKS.modes],
    3: [
      COST_ALLOCATION_CLOSURE_CHECKS.browserRoute,
      COST_ALLOCATION_CLOSURE_CHECKS.browserCancel,
      COST_ALLOCATION_CLOSURE_CHECKS.browserRefresh
    ]
  }),
  'COST-002': Object.freeze({
    0: [COST_OPENING_CHECKS.draft],
    1: [COST_OPENING_CHECKS.material],
    2: [COST_OPENING_CHECKS.amounts],
    3: [COST_OPENING_CHECKS.unit],
    4: [COST_OPENING_CHECKS.states],
    5: Object.values(COST_OPENING_BROWSER_CHECKS)
  }),
  'COST-003': Object.freeze({
    0: ['成本写接口返回 requestId 与期间版本'],
    1: [COST_WORKFLOW_CHECKS.headers],
    2: [COST_WORKFLOW_CHECKS.replay],
    3: [COST_WORKFLOW_CHECKS.version]
  }),
  'COST-004': Object.freeze({
    1: [COST_OUTBOX_CHECKS.owned],
    3: [COST_OUTBOX_CHECKS.fields]
  }),
  'COST-005': Object.freeze({
    0: [COST_OPERATING_CHECKS.refresh, COST_OPERATING_CHECKS.collections],
    1: [COST_OPERATING_CHECKS.calculation],
    2: [COST_OPERATING_CHECKS.confirmationGate],
    3: [COST_OPERATING_CHECKS.publication, COST_OPERATING_CHECKS.page],
    4: [COST_OPERATING_CHECKS.rollback]
  }),
  'COST-007': Object.freeze({
    0: [COST_ENTERPRISE_CHECKS.trade, COST_ENTERPRISE_CHECKS.tradeUnchanged],
    1: [COST_ENTERPRISE_CHECKS.purchase, COST_ENTERPRISE_CHECKS.purchaseUnchanged]
  }),
  'COST-008': Object.freeze({
    0: [COST_OPERATING_CHECKS.allocationBasis, COST_OPERATING_CHECKS.invalidBasis],
    1: [COST_OPERATING_CHECKS.salesCost],
    2: [COST_OPERATING_CHECKS.publication, COST_OPERATING_CHECKS.page]
  }),
  'COST-009': Object.freeze({
    0: [COST_PURCHASE_SOURCE_CHECKS.receipt],
    1: [COST_PURCHASE_SOURCE_CHECKS.mapping],
    2: [COST_PURCHASE_SOURCE_CHECKS.draft, COST_PURCHASE_SOURCE_CHECKS.browser],
    3: [COST_PURCHASE_SOURCE_CHECKS.empty]
  }),
  'COST-010': Object.freeze({
    0: [COST_PURCHASE_RETURN_CHECKS.receipt],
    1: [COST_PURCHASE_RETURN_CHECKS.returned],
    2: [COST_PURCHASE_RETURN_CHECKS.draft, COST_PURCHASE_RETURN_CHECKS.browser],
    3: [COST_PURCHASE_RETURN_CHECKS.net],
    4: [COST_PURCHASE_RETURN_CHECKS.overflow]
  }),
  'COST-011': Object.freeze({
    0: [COST_PURCHASE_FREIGHT_CHECKS.wmsSource],
    1: [COST_PURCHASE_FREIGHT_CHECKS.expense],
    2: [COST_PURCHASE_FREIGHT_CHECKS.shared],
    3: [COST_PURCHASE_FREIGHT_CHECKS.zero]
  }),
  'COST-012': Object.freeze({
    0: [COST_PURCHASE_REPORT_CHECKS.fields],
    1: [COST_PURCHASE_REPORT_CHECKS.aggregate],
    2: [COST_PURCHASE_REPORT_CHECKS.fallback],
    3: [COST_PURCHASE_REPORT_CHECKS.frozen]
  }),
  'COST-022': Object.freeze({
    0: ['反月结重开接口可达且强制要求重开原因'],
    1: ['没有正式发布批次时反月结被业务规则阻断而非未知异常'],
    2: ['反月结后原发布批次保留为REVERSED、原试算保留为SUPERSEDED，期间回到ACCOUNTING并解绑当前批次'],
    3: ['重开后必须重新试算、人工确认并发布新批次，已发布金额不被覆盖']
  }),
  'COST-023': Object.freeze({
    0: [COST_SEPARATION_CHECKS.creator],
    1: [COST_SEPARATION_CHECKS.selfConfirm],
    2: [COST_SEPARATION_CHECKS.maintainer],
    3: [COST_SEPARATION_CHECKS.publicationRequest],
    4: [COST_SEPARATION_CHECKS.operatingConfirm],
    5: [COST_SEPARATION_CHECKS.operatingRollback]
  }),
  'COST-028': Object.freeze({
    0: [COST_APPROVAL_CHECKS.pending],
    1: [COST_APPROVAL_CHECKS.binding],
    2: [COST_APPROVAL_CHECKS.actors],
    3: [COST_APPROVAL_CHECKS.execution],
    4: [COST_APPROVAL_CHECKS.unique],
    5: [COST_APPROVAL_PAGE_CHECKS.strip],
    6: [COST_APPROVAL_PAGE_CHECKS.dialogs]
  }),
  'COST-029': Object.freeze({
    0: ['成本中心可引用真实部门并按启用日期创建'],
    1: ['同一部门在重叠有效期内禁止重复归属'],
    2: ['成本中心稳定编码创建后不可修改'],
    3: ['成本中心停用后关闭部门有效关系', '停用后的部门可按后续日期归属新成本中心'],
    4: Object.values(COST_CENTER_PERMISSION_CHECKS)
  }),
  'COST-030': Object.freeze({
    0: ['成本构成项正式接口返回分类/构成项/来源规则三段结构'],
    1: ['成本构成项与来源规则可写入正式接口', '锁定成本模型拒绝构成项与来源规则写入，原配置不改变'],
    2: ['业务方向/金额口径/日期依据/报表归属/经营利润标志往返不丢失'],
    3: ['来源规则随构成项一并保存']
  }),
  'COST-031': Object.freeze({
    0: ['COST-031 经营项目及固定收入支出根分类在专属模型正式共享构成表精确落库'],
    1: ['经营收支方向/报表归属/经营利润标志往返不丢失'],
    2: ['取数范围经 scope_json 往返不丢失'],
    3: ['主来源与核对来源按优先级保存为来源规则'],
    4: ['经营配置固定收入支出根分类，并保留既有成本构成项及取数规则业务值']
  }),
  'COST-032': Object.freeze({
    0: [
      'LABOR_HOUR 因子缺少来源时被拒绝',
      'MACHINE_HOUR 因子缺少来源时被拒绝',
      'AREA 因子缺少来源时被拒绝',
      'OUTPUT 因子缺少来源时被拒绝'
    ],
    1: ['未知分摊模式被拒绝'],
    2: ['原有数量分摊模式仍可写入']
  }),
  'COST-033': Object.freeze({
    0: ['期初在制非法行按模板行号返回错误'],
    1: ['多行批次错误定位到具体出错行']
  }),
  'COST-034': COST_STAGE_EVIDENCE_BINDINGS,
  'COST-035': COST_FORMAL_REPORT_BINDINGS['COST-035'],
  'COST-036': COST_FORMAL_REPORT_BINDINGS['COST-036'],
  'COST-037': COST_FORMAL_REPORT_BINDINGS['COST-037'],
  'COST-038': COST_FORMAL_REPORT_BINDINGS['COST-038'],
  'COST-039': COST_FORMAL_REPORT_BINDINGS['COST-039']
})

export const costCatalogGapContexts = Object.freeze({
  'COST-001': '专属正式 API 与显式模型选择、取消/刷新页面边界已接入，仍以真实运行具名检查为准。原三模式限定与 COST-032 正式受控因子扩展存在口径冲突，未擅自改原断言',
  'COST-002': '专属期初状态机及正式模型/期间页面已接入；取消、刷新及完整 API/SQL 不变性须全部真实运行，不允许共享状态或首行兜底',
  'COST-003': '缺少 X-Input-Hash 重放结果回读及 If-Match 冲突写侧样本',
  'COST-004': '专属正式期间入箱、载荷哈希、请求/审计关联、回放及非DEAD人工门禁已接入；成功共存不能替代事务失败回滚。dispatch 无事件过滤且无安全真实瞬态失败入口，退避/死信/正向人工审计仍待验证',
  'COST-005': '专属正式归集、计算、独立复核、发布、回退及页面已接入；本轮具名检查、API/SQL事实、页面和账号清理必须全部完成，不以空事实或共享workspace回执判通过',
  'COST-006': '只读取单一报表接口，未覆盖全部报表、不可比较基线和导出同口径',
  'COST-007': '精确拒绝消息及正式期间/工作流请求不变已接入；全量菜单审核可证明既有工作台组件复用，但公开与 legacy 工作台、正式 control-rules 与通用 validation-threshold 设置入口并存，未确认“无平行设置入口”的范围，也无“不新增”的历史基线证据，第三原断言保留 GAP',
  'COST-008': '专属经营费用分摊正反例、销售成本排除和正式页面已接入；本轮非空正式事实、全部具名检查及清理不完整时保留缺口',
  'COST-009': '刷新检查把“生成草稿”和“无来源阻断”合并，不能分别证明来源字段、DRAFT 边界和无来源门禁',
  'COST-010': '现有采购样本没有采购退回，未验证负数退回映射和超额退回阻断写侧',
  'COST-011': '专属WMS来源、应付freight、采购费用快照与正式清理已接入，仍以真实运行的精确ID/金额及页面证据为准',
  'COST-012': '采购成本报表行为空，缺少发票累计、行级不可比较和已发布来源快照样本',
  'COST-013': '当前无已完工已结算委外来源，未验证 MES API 边界、金额拆分与 DRAFT 写侧',
  'COST-014': '比较报表未形成同时具备自产/外购与约束冻结事实的专属样本',
  'COST-015': '质量刷新把草稿成功和不同阻断原因合并，未形成 payload/hash、已确认禁止补写的真实样本',
  'COST-016': '交期/产能刷新只得到泛化阻断，未形成正式字段/hash、不可比较和已确认禁止补写样本',
  'COST-017': '收入草稿为空，未验证 ERP API 边界、来源单号、退货红字和不落正式快照',
  'COST-018': '支出草稿为空，未验证 ERP 报销 API 边界、来源单号、采购应付排除和不落正式快照',
  'COST-019': '其他应付草稿为空，未验证过滤规则、分摊基数正数门禁及发布阻断',
  'COST-020': '当前采购样本未覆盖委外和四种应付状态，且没有人工确认后的正式发布边界回读',
  'COST-021': '当前没有 AVAILABLE 付款核销轨迹，未验证逐行金额/状态及不重复相加',
  'COST-022': '缺少反月结审批执行、历史状态回读和重新试算发布的完整证据',
  'COST-023': '已补专属试算、独立复核、发布批次和回退/反月结审批 API/数据库证据；模型维护人独立拒绝、发布人申请回退/反月结与经营域双人断言缺少现有权限下的独立业务主体或可写事实，保留 GAP；审批拒绝不替代申请拒绝',
  'COST-024': '当前只验证部分 CARRYOVER 读取，未覆盖确认锁定、缺上期门禁、对象汇总、料工费拆分和完整页面交互',
  'COST-025': '未形成单条处理审计或 WARN+OPEN 批量放行真实样本，也未验证规则版本快照',
  'COST-026': '没有已发布采购成本行级/订单级发票快照样本，无法验证字段、回落和页面弹窗口径',
  'COST-027': '没有覆盖来源、试算平衡、成本中心和 UNRESOLVED 的真实影响金额样本及批量放行弹窗',
  'COST-028': '已补专属期间、模型、发布批次、审批申请/决策和令牌清理证据；审批页面绑定专属期间与审批弹窗尚未在真实页面上下文验证',
  'COST-029': '专属维护/只读 CUSTOM 账号页面、精确403、全字段哈希及退出清理须全部真实执行；正式拒绝不绕过授权、不转静默PARTIAL',
  'COST-030': '缺少精确具名的运行时证据',
  'COST-031': '经营项目落库、固定根分类及合并保留需精确具名运行时证据，不以 API 成功冒充数据库证据',
  'COST-032': '缺少精确具名的运行时证据',
  'COST-033': '缺少精确具名的运行时证据',
  'COST-034': '缺少取数阶段、完整阶段证据载荷、BLOCK/WARN 页面优先级和同证据去重的真实样本',
  'COST-035': '缺少成本发布与经营发布双侧非空正式事实、未经营发布空值反控制或两条路由逐行页面证据',
  'COST-036': '不以生产型拒绝或未发布TRADE门禁冒充正控制；缺少既有合法已发布TRADE、原始远期空月分配来源或真实页面期间证据',
  'COST-037': '缺少非空自产/外购比较行、真实不可比较原因、精确期间绑定或正式列与单元格页面证据',
  'COST-038': '缺少完整菜单库存、当前用户权限、隐藏占位保留/不泄漏以及真实工作台入口页面证据',
  'COST-039': '缺少全部成本报表别名标题/页键/权限映射及正式企业管理全成本页面证据'
})

const costCatalogDefinition = (caseId) => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === caseId)
  if (!definition) throw new Error(`缺少原 catalog 案例 ${caseId}`)
  return definition
}

/**
 * Fail closed for catalog acceptance: each original assertion must name the
 * exact checks that prove it. A missing, failed, non-boolean, or duplicate
 * check is a GAP; a similarly named check never counts as a substitute.
 */
export function costCatalogEvidence (caseId, caseRecord, bindings = costCatalogBindings) {
  const definition = costCatalogDefinition(caseId)
  const checks = Array.isArray(caseRecord?.checks) ? caseRecord.checks : []
  const caseBindings = caseId === 'COST-034'
    ? costStageEvidenceBindings(caseRecord)
    : bindings?.[caseId] || {}
  const namedBindings = Object.values(caseBindings).flat().filter((name) => typeof name === 'string' && name)
  const repeatedBindings = new Set(namedBindings.filter((name, index) => namedBindings.indexOf(name) !== index))
  const gapContext = costCatalogGapContexts[caseId] || '缺少与原断言一一对应的真实运行时证据'
  const fixtureKey = {
    'COST-009': 'costPurchaseReceipt',
    'COST-010': 'costPurchaseReturn',
    'COST-011': 'costPurchaseFreight',
    'COST-012': 'costPurchaseReport'
  }[caseId]
  const runtimeFixtureReady = ['COST-005', 'COST-008'].includes(caseId)
    ? hasCostOperatingEvidence(caseRecord)
    : COST_FORMAL_REPORT_CASES.has(caseId)
      ? hasCostFormalReportEvidence(caseRecord, caseId)
      : !fixtureKey || caseRecord?.fixtures?.[fixtureKey]?.complete === true

  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => {
    const evidenceChecks = Array.isArray(caseBindings[index])
      ? caseBindings[index].filter((name) => typeof name === 'string' && name)
      : []
    const matchedChecks = evidenceChecks.map((name) => checks.filter((check) => check?.name === name))
    const verified = evidenceChecks.length > 0 &&
      evidenceChecks.length === (caseBindings[index] || []).length &&
      evidenceChecks.every((name) => !repeatedBindings.has(name)) &&
      matchedChecks.every((items) => items.length === 1 && items[0].passed === true) &&
      runtimeFixtureReady &&
      (caseId !== 'COST-029' || index !== 4 || hasCostCenterPermissionEvidence(caseRecord))
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks,
      details: verified
        ? matchedChecks.flat().map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : `GAP: ${gapContext}`
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED').map((item) => item.assertion)
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  caseRecord.passCandidate = caseRecord.catalogComplete && checks.length > 0 &&
    checks.every((check) => check?.passed === true)
  caseRecord.notes ||= []
  caseRecord.notes.push(
    `原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`
  )
  return caseRecord
}

const accountingOrgId = 1
const currentMonth = new Date().toISOString().slice(0, 7)

const offsetDate = (days) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

const flattenDepartments = (nodes) =>
  (nodes || []).flatMap((node) => [node, ...flattenDepartments(node.children || [])])

const responseData = (payload) => payload?.data ?? payload

/**
 * MySQL BIT(1) values can be serialized as booleans, numeric strings,
 * control characters, or Node Buffer-shaped JSON objects depending on the
 * API/database adapter. Treat only the explicit true/1 forms as soft-deleted.
 */
export const isSoftDeletedValue = (value) => {
  if (value === true || value === 1) return true
  if (typeof value === 'string') {
    return value === '1' || value === '\u0001' || value.trim().toLowerCase() === 'true'
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.length === 1 && value[0] === 1
  }
  if (value && typeof value === 'object' && value.type === 'Buffer' &&
      Array.isArray(value.data)) {
    return value.data.length === 1 && value.data[0] === 1
  }
  return false
}

export const costConfigurationSignature = (configuration) => {
  const categories = new Map(configuration.categories.map((row) => [row.id, row.code]))
  const items = new Map(configuration.items.map((row) => [row.id, row.code]))
  const sorted = (rows) => rows.map((row) => JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)))
  )).sort()
  return JSON.stringify({
    categories: sorted(configuration.categories.map(({ id, parentId, ...row }) => ({
      ...row, parentCode: parentId ? categories.get(parentId) : ''
    }))),
    items: sorted(configuration.items.map(({ id, categoryId, ...row }) => ({
      ...row, categoryCode: categories.get(categoryId)
    }))),
    sourceRules: sorted(configuration.sourceRules.map(({ id, componentItemId, ...row }) => ({
      ...row, componentCode: items.get(componentItemId)
    })))
  })
}

const restoreCostConfiguration = async ({ api, modelVersionId, original, caseRecord }) => {
  await api.putBusiness(`/cost/model-versions/${modelVersionId}/components`, {
    categories: original.categories, items: original.items, sourceRules: original.sourceRules
  })
  const restored = responseData(await api.getBusiness(`/cost/model-versions/${modelVersionId}/components`))
  const passed = costConfigurationSignature(restored) === costConfigurationSignature(original)
  caseRecord.checks.push({
    name: '专属模型探针配置已恢复，分类、构成项及来源规则业务值与原始配置一致',
    passed, details: `model=${modelVersionId}`
  })
  if (!passed) throw new Error('Dedicated cost configuration was not completely restored')
}

const recordCostDatabase = async ({ modelVersionId, caseRecord }) => {
  if (!/^[1-9]\d*$/.test(modelVersionId)) throw new Error('Invalid cost database fixture ID')
  const snapshot = await runReadOnlySql(`
    SELECT 'model', COUNT(*) FROM cost_model_version
    WHERE tenant_id=1 AND id=${modelVersionId} AND deleted=0;
    SELECT 'categories', COUNT(*) FROM cost_component_category
    WHERE tenant_id=1 AND model_version_id=${modelVersionId} AND deleted=0;
    SELECT 'items', COUNT(*) FROM cost_component_item
    WHERE tenant_id=1 AND model_version_id=${modelVersionId} AND deleted=0;
    SELECT 'sourceRules', COUNT(*) FROM cost_component_source_rule s
    JOIN cost_component_item i ON i.id=s.component_item_id AND i.tenant_id=s.tenant_id
    WHERE i.tenant_id=1 AND i.model_version_id=${modelVersionId} AND i.deleted=0 AND s.deleted=0
  `)
  caseRecord.database = [...(caseRecord.database || []), { stage: 'owned-cost-final', ...snapshot }]
  const passed = snapshot.available && snapshot.rows.length === 4 &&
    snapshot.rows.every(([tag, count]) => tag === 'model' ? count === '1' : Number(count) > 0)
  caseRecord.checks.push({
    name: '本案例模型、分类、构成项和来源规则已在当前租户正式表落库',
    passed, details: JSON.stringify(snapshot.rows)
  })
  if (!passed) throw new Error('Cost configuration database evidence is incomplete')
}

export const hasDeadLetterSamples = (rows) => Array.isArray(rows) && rows.length > 0

// 成本页面草稿状态的正式后端键名，与前端 cost-management 常量保持一致。
const COST_WORKSPACE_STATE_KEYS = {
  model: 'cost-model-base-config-20260825-clean-v2',
  activePeriod: 'cost-active-period-20260825-clean-v2',
  openingWipGate: 'cost-opening-wip-formal-gates-20260825-clean-v2'
}

const readCostWorkspaceState = async (api, stateKey) =>
  responseData(
    await api.getBusiness(
      `/cost/workspace-states/get?accountingOrgId=${accountingOrgId}&stateKey=${encodeURIComponent(stateKey)}`
    )
  )

const saveCostWorkspaceState = async (api, stateKey, payload, version) =>
  responseData(
    await api.putBusiness('/cost/workspace-states/save', {
      accountingOrgId,
      stateKey,
      payloadJson: JSON.stringify(payload),
      version
    })
  )

/**
 * 上期结转的口径说明只在"上期在制"阶段渲染，而该阶段由页面草稿状态派生。
 *
 * <p>这里按正式 workspace-state 契约，临时把当前模型标记为已产生首次正式成本并把
 * 当前期间切到下一个月，断言结束后按原 payload 恢复，避免污染用户页面状态。</p>
 */
const withCarryoverStage = async (api, action) => {
  const modelState = await readCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.model)
  const model = JSON.parse(modelState?.payloadJson || '{}')
  const enterpriseType = model.enterpriseType || '生产型'
  const modelKey = `${enterpriseType}|${model.version || 'V1'}`

  const gateState = await readCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.openingWipGate)
  const gatePayload = JSON.parse(gateState?.payloadJson || '{}')
  const activeState = await readCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.activePeriod)
  const activePayload = JSON.parse(activeState?.payloadJson || '{}')

  const savedGate = await saveCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.openingWipGate, {
    ...gatePayload,
    [modelKey]: {
      firstFormalPeriod: '2000-01',
      firstFormalBatchNo: 'E2E-CARRYOVER-STAGE',
      state: '已正式写入',
      lockedAt: '',
      ...(gatePayload[modelKey] || {})
    }
  }, gateState?.version ?? 0)
  const savedActive = await saveCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.activePeriod, {
    ...activePayload,
    [enterpriseType]: '2000-02'
  }, activeState?.version ?? 0)

  try {
    return await action()
  } finally {
    await saveCostWorkspaceState(
      api, COST_WORKSPACE_STATE_KEYS.openingWipGate,
      gatePayload, savedGate?.version ?? 0
    ).catch(() => {})
    await saveCostWorkspaceState(
      api, COST_WORKSPACE_STATE_KEYS.activePeriod,
      activePayload, savedActive?.version ?? 0
    ).catch(() => {})
  }
}

export const costArrayData = (payload, label) => {
  if (!isBusinessSuccess(payload) || !Array.isArray(payload.data)) {
    throw new Error(`${label} 未返回有效业务数组，不能视为缺少依赖`)
  }
  return payload.data
}

export const costPageRows = (payload, label) => {
  const data = payload?.data
  if (
    !isBusinessSuccess(payload) ||
    !Array.isArray(data?.list) ||
    !Number.isSafeInteger(data.total) ||
    data.total < data.list.length ||
    (data.list.length === 0 && data.total !== 0)
  ) {
    throw new Error(`${label} 未返回有效分页列表，不能视为缺少依赖`)
  }
  return data.list
}

export const hasEditableCostModel = (rows) =>
  rows.some((row) => row.status === 'DRAFT' && nonEmpty(row.id))

const saveCostPrerequisiteEvidence = async ({ caseId, page, record, caseRecord, outputDir, note }) => {
  await openRoute(page, '/cost-management/workbench', { readySelector: '.title-line h1' })
  caseRecord.checks.push({
    name: '依赖缺失时仍完成真实成本工作台只读前置验证',
    passed: await page.getByRole('heading', { name: '成本工作台', exact: true }).isVisible(),
    details: page.url()
  })
  caseRecord.notes.push(note)
  await saveScreenshot(page, outputDir, `${caseId}-prerequisite`, record)
  caseRecord.evidence.push('仅验证正式查询与真实工作台前置，未执行缺少依赖的业务闭环')
}

export const nextCostCenterStartDate = ({ centers, departmentId, today }) => {
  const latestDisabledAt = centers
    .filter((row) =>
      (row.departmentIds || []).some((id) => String(id) === String(departmentId))
    )
    .map((row) => row.disabledAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  if (!latestDisabledAt || latestDisabledAt < today) return today
  const date = new Date(`${latestDisabledAt}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

const PERIOD_DEPENDENT_CASES = new Set([
  'COST-002', 'COST-003', 'COST-005', 'COST-006', 'COST-008', 'COST-009',
  'COST-010', 'COST-011', 'COST-012', 'COST-013', 'COST-014', 'COST-015',
  'COST-016', 'COST-017', 'COST-018', 'COST-019', 'COST-020', 'COST-021',
  'COST-022', 'COST-023', 'COST-024', 'COST-025', 'COST-026', 'COST-027',
  'COST-028', 'COST-033', 'COST-034'
])
const MODEL_DEPENDENT_CASES = new Set(['COST-030', 'COST-031', 'COST-032'])
export const COST_CASE_EFFECTIVE_MONTH = '2099-12'

const isCostFixtureId = (value) =>
  typeof value === 'string' &&
  /^[1-9]\d*$/.test(value) &&
  BigInt(value) <= 9223372036854775807n

const costScopeId = (value) =>
  isCostFixtureId(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : null

// A local case/run registration and persisted remarks must agree; names never grant ownership.
export const costFixtureRemark = (fixture) =>
  `CFOR-E2E:${fixture.caseId}:${fixture.runId}:${fixture.fixtureId}:tenant=${fixture.tenantId}:org=${fixture.accountingOrgId}:month=${fixture.effectiveMonth}:exclusive`

const registeredCostFixture = ({ caseId, record, caseRecord } = {}) => {
  const fixture = caseRecord?.fixtures?.cost
  const runId = record?.runId
  if (
    !MODEL_DEPENDENT_CASES.has(caseId) ||
    caseRecord?.id !== caseId ||
    caseRecord?.caseId !== caseId ||
    typeof runId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(runId) ||
    !fixture ||
    fixture.exclusive !== true ||
    fixture.caseId !== caseId ||
    fixture.runId !== runId ||
    typeof fixture.fixtureId !== 'string' ||
    !fixture.fixtureId.startsWith(`E2E-${caseId}-${runId}-`) ||
    !/^[A-Za-z0-9_-]+$/.test(fixture.fixtureId) ||
    fixture.fixtureId.length <= `E2E-${caseId}-${runId}-`.length ||
    !costScopeId(record?.environment?.tenantId) ||
    costScopeId(fixture.tenantId) !== costScopeId(record.environment.tenantId) ||
    costScopeId(fixture.accountingOrgId) !== String(accountingOrgId) ||
    fixture.effectiveMonth !== COST_CASE_EFFECTIVE_MONTH ||
    ![fixture.modelVersionId, fixture.costCenterId, fixture.componentItemId].every(isCostFixtureId)
  ) return null
  return fixture
}

export const isOwnedCostModelFixture = (model, context) => {
  const fixture = registeredCostFixture(context)
  return Boolean(
    fixture &&
    isCostFixtureId(model?.id) &&
    model.id === fixture.modelVersionId &&
    model.status === 'DRAFT' &&
    model.lockedAt == null &&
    model.lockedBy == null &&
    costScopeId(model.accountingOrgId) === String(accountingOrgId) &&
    model.effectiveMonth === fixture.effectiveMonth &&
    model.remark === costFixtureRemark(fixture)
  )
}

const costFixtureObjectData = (payload, label) => {
  if (
    !isBusinessSuccess(payload) ||
    (payload.data !== null &&
      (typeof payload.data !== 'object' || Array.isArray(payload.data)))
  ) throw new Error(`${label} 未返回有效业务对象，不能视为缺少归属证据`)
  return payload.data
}

export const loadOwnedCostFixture = async ({ api, modelVersions, ...context }) => {
  const missing = (note) => ({ fixture: null, note })
  const registration = registeredCostFixture(context)
  if (!registration) return missing('缺少本案、本轮、当前租户的专属 E2E 夹具精确 ID 登记')
  const matches = modelVersions.filter((row) => row.id === registration.modelVersionId)
  if (matches.length !== 1 || !isOwnedCostModelFixture(matches[0], context)) {
    return missing('登记模型不唯一或缺少严格归属证据；版本名称中的 E2E 标记不能授权写侧')
  }
  const model = costFixtureObjectData(
    await api.getBusiness(`/cost/model-versions/${registration.modelVersionId}`),
    '专属成本模型详情'
  )
  if (!isOwnedCostModelFixture(model, context)) {
    return missing('登记模型详情与本轮夹具 ID、备注、组织、草稿状态或远期月份不符')
  }
  const center = costFixtureObjectData(
    await api.getBusiness(`/cost/centers/${registration.costCenterId}`),
    '专属成本中心详情'
  )
  const remark = costFixtureRemark(registration)
  if (
    !center ||
    !isCostFixtureId(center.id) ||
    center.id !== registration.costCenterId ||
    costScopeId(center.accountingOrgId) !== String(accountingOrgId) ||
    center.status !== 'ENABLED' ||
    center.enabledAt !== `${registration.effectiveMonth}-01` ||
    center.disabledAt != null ||
    center.referenceCount !== 0 ||
    center.remark !== remark
  ) return missing('登记成本中心不属于同一本轮远期 E2E 夹具，或已存在共享业务引用')

  const config = costFixtureObjectData(
    await api.getBusiness(`/cost/model-versions/${registration.modelVersionId}/components`),
    '专属成本构成配置'
  )
  if (!config) return missing('登记模型缺少构成配置归属证据')
  if (![config.categories, config.items, config.sourceRules].every(Array.isArray)) {
    throw new Error('专属成本构成配置未返回分类/构成项/来源规则数组，不能视为缺少归属证据')
  }
  const categoryIds = new Set(config.categories.map((row) => row.id))
  const itemIds = new Set(config.items.map((row) => row.id))
  const componentMatches = config.items.filter((row) => row.id === registration.componentItemId)
  if (
    config.modelVersionId !== model.id ||
    config.categories.length === 0 ||
    categoryIds.size !== config.categories.length ||
    itemIds.size !== config.items.length ||
    componentMatches.length !== 1 ||
    !config.categories.every((row) =>
      isCostFixtureId(row.id) &&
      (!row.parentId || categoryIds.has(row.parentId))
    ) ||
    !config.items.every((row) =>
      isCostFixtureId(row.id) &&
      categoryIds.has(row.categoryId) &&
      row.remark === remark &&
      row.systemItem === false &&
      row.status === 'ENABLED'
    ) ||
    !config.sourceRules.every((row) =>
      isCostFixtureId(row.id) && itemIds.has(row.componentItemId)
    )
  ) return missing('构成配置模型关联或精确构成项 ID 不符，或混入非本轮专属构成项/来源规则')

  const rules = costArrayData(await api.getBusiness(
    `/cost/allocation-rules?modelVersionId=${model.id}&effectiveMonth=${registration.effectiveMonth}`
  ), '专属成本模型远期分摊规则')
  if (rules.length > 0) return missing('专属模型远期月份已有分摊规则，未覆盖任何既有规则或其构成项')
  return { fixture: { model, center, componentItem: componentMatches[0], config }, note: '' }
}

const loadFormalModelPage = async (api) => {
  const list = []
  for (let pageNo = 1; pageNo <= 1000; pageNo++) {
    const result = await api.getBusiness(
      `/cost/model-versions?accountingOrgId=${accountingOrgId}&pageNo=${pageNo}&pageSize=100`
    )
    const rows = costPageRows(result, '成本模型版本')
    list.push(...rows)
    if (list.length >= result.data.total) {
      return { list, model: list.find((item) => item.status === 'LOCKED') || list[0] || null }
    }
    if (!rows.length) throw new Error('成本模型分页提前返回空列表')
  }
  throw new Error('成本模型分页超出安全上限')
}

const trackedTraceShape = (rows) =>
  rows.every(
    (row) =>
      ['AVAILABLE', 'NOT_AVAILABLE'].includes(row.payableTraceStatus) &&
      row.materialAmount !== undefined &&
      Array.isArray(row.payableSettlementTraces)
  )

const COST_FORMAL_REPORT_CASES = new Set(Object.keys(COST_FORMAL_REPORT_CHECKS))

const preferredFormalReportPeriodId = (record) => (record?.cases || []).findLast((entry) =>
  entry?.id === 'COST-008' && entry.fixtures?.costOperating?.runId === record.runId &&
  hasCostOperatingEvidence(entry)
)?.fixtures.costOperating.periodId

const runTokens = new Map()
const guardedPages = new WeakMap()
export const protectSharedCostWorkspace = async (page, caseRecord, { rejectWrites = false } = {}) => {
  if (typeof page?.route !== 'function') return
  const existing = guardedPages.get(page)
  if (existing) {
    existing.caseRecord = caseRecord
    existing.rejectWrites = rejectWrites
    return
  }
  const guard = { caseRecord, rejectWrites }
  guardedPages.set(page, guard)
  await page.route('**/cost/workspace-states/save', async (route) => {
    if (route.request().method() === 'PUT') {
      if (guard.rejectWrites) {
        guard.caseRecord.checks.push({
          name: '经营闭环禁止保存共享workspace',
          passed: false,
          details: '共享workspace PUT已中止，未转发也未返回模拟成功'
        })
        await route.abort('blockedbyclient')
        return
      }
      const payload = route.request().postDataJSON()
      if (!payload || !Number.isSafeInteger(payload.version) || payload.version < 0 ||
          typeof payload.stateKey !== 'string' || typeof payload.payloadJson !== 'string') {
        throw new Error('Cost workspace guard received an invalid save request')
      }
      guard.caseRecord.guardedWorkspaceWrites ||= []
      guard.caseRecord.guardedWorkspaceWrites.push({
        stateKey: payload.stateKey,
        accountingOrgId: payload.accountingOrgId,
        version: payload.version,
        persisted: false
      })
      guard.caseRecord.notes.push(`共享页面状态写请求 ${payload.stateKey} 已拦截，未落库，不计入保存验收证据`)
      // Keep the caller's version unchanged. This temporary UI receipt is not
      // persistence evidence and never forwards a shared workspace mutation.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: payload, msg: 'E2E read-only guard: not persisted' })
      })
      return
    }
    await route.continue()
  })
  caseRecord.notes.push(rejectWrites
    ? '经营闭环共享workspace PUT仅中止，不返回模拟保存回执；任何尝试均为失败证据'
    : '成本页面共享 workspace-state 写请求由 E2E 只读保护拦截；临时页面回执不是正式保存证据')
}

const runCostCase = async ({
  caseId, page, ctx, token: suppliedToken, record, caseRecord, outputDir
}, dependencies = {}) => {
  const operatingCase = ['COST-005', 'COST-008'].includes(caseId)
  const formalReportCase = COST_FORMAL_REPORT_CASES.has(caseId)
  page ||= ctx?.page
  const token = ((operatingCase || formalReportCase) && (suppliedToken || ctx?.token)) ||
    await (dependencies.login || login)(page)
  runTokens.set(record.runId, token)
  let api = (dependencies.createApiClient || createApiClient)({ token, record })
  const rawApi = api
  if (formalReportCase) {
    const result = await (dependencies.runCostFormalReportClosure || runCostFormalReportClosure)({
      api, page, token, record, caseRecord, outputDir, caseId,
      periodId: dependencies.formalReportPeriodId ??
        preferredFormalReportPeriodId(record)
    }, dependencies.costFormalReportDependencies || {})
    const complete = result?.acceptanceComplete === true &&
      hasCostFormalReportEvidence(caseRecord, caseId)
    return { token, api, ...result, partial: !complete, acceptanceComplete: complete }
  }
  await protectSharedCostWorkspace(page, caseRecord, { rejectWrites: operatingCase })
  const savePrerequisiteEvidence = dependencies.saveCostPrerequisiteEvidence || saveCostPrerequisiteEvidence
  if (operatingCase) {
    caseRecord.fixtures ||= {}
    delete caseRecord.fixtures.costOperating
    if ((dependencies.writeFixtures ?? costWritesEnabled()) !== true) {
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '经营正式写侧未显式启用；仅记录工作台只读前置，不创建夹具或保存共享workspace'
      })
      return { token, api, partial: true, acceptanceComplete: false, note: '经营完整写侧未启用' }
    }
    const result = await (dependencies.runCostOperatingClosure || runCostOperatingClosure)({
      api, page, token, record, caseRecord, outputDir
    }, {
      ...dependencies.costOperatingDependencies,
      writeFixtures: dependencies.writeFixtures ?? costWritesEnabled()
    })
    const complete = result?.acceptanceComplete === true && hasCostOperatingEvidence(caseRecord)
    return { token, api, ...result, partial: !complete, acceptanceComplete: complete }
  }
  if (caseId === 'COST-034') {
    const result = await (dependencies.runCostStageEvidenceClosure || runCostStageEvidenceClosure)({
      api, page, token, record, caseRecord, outputDir
    }, {
      ...dependencies.costStageEvidenceDependencies,
      writeFixtures: dependencies.writeFixtures ?? costWritesEnabled()
    })
    const complete = result?.acceptanceComplete === true &&
      Object.keys(costStageEvidenceBindings(caseRecord)).length === 4
    return { token, api, ...result, partial: !complete, acceptanceComplete: complete }
  }
  if (caseId === 'COST-004') {
    const result = await (dependencies.runCostOutboxClosure || runCostOutboxClosure)({
      api, record, caseRecord, page, outputDir,
      dependencies: {
        ...dependencies.costOutboxDependencies,
        writeFixtures: dependencies.writeFixtures ?? costWritesEnabled()
      }
    })
    return { token, api, partial: true, note: `COST-004 ${result.status}: ${result.reasons.join('；')}` }
  }
  if (caseId === 'COST-012') {
    if (!(dependencies.writeFixtures ?? costWritesEnabled())) {
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '专属采购报表写侧未启用；未创建采购发票、正式来源快照或发布报表'
      })
      return { token, api, partial: true, note: 'COST-012 专属采购报表写侧未启用' }
    }
    await (dependencies.runCostPurchaseReportClosure || runCostPurchaseReportClosure)({
      api, page, record, caseRecord, outputDir, caseId
    }, dependencies.costPurchaseReportDependencies || {})
    return { token, api }
  }
  if (['COST-009', 'COST-010'].includes(caseId)) {
    if (!(dependencies.writeFixtures ?? costWritesEnabled())) {
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '专属采购来源写侧未启用；未刷新共享期间或以空行替代业务证据'
      })
      return { token, api, partial: true, note: '采购来源完整写侧未启用' }
    }
    const closure = caseId === 'COST-009'
      ? dependencies.runCostPurchaseReceiptClosure || runCostPurchaseReceiptClosure
      : dependencies.runCostPurchaseReturnClosure || runCostPurchaseReturnClosure
    await closure({ api, page, record, caseRecord, outputDir, caseId },
      dependencies.costPurchaseSourceDependencies || {})
    return { token, api }
  }
  if (caseId === 'COST-001' &&
      (dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true')) {
    await (dependencies.runCostAllocationClosure || runCostAllocationClosure)({
      api, page, record, caseRecord, outputDir,
      dependencies: dependencies.costAllocationDependencies || {}
    })
    return { token, api }
  }
  if (caseId === 'COST-002') {
    const writeFixtures = dependencies.writeFixtures ?? costWritesEnabled()
    if (!writeFixtures && !dependencies.prepareCostOpeningFixture) {
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '写侧开关未启用；未创建专属模型、期间、成本中心或期初在制记录'
      })
      return { token, api, partial: true, note: 'COST-002 专属写侧夹具未启用' }
    }
    await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
    if (!caseRecord.fixtures?.costOpening) {
      await (dependencies.prepareCostOpeningFixture || prepareCostOpeningFixture)({
        api, record, caseRecord,
        effectiveMonth: COST_OPENING_FIXTURE_MONTH,
        writeFixtures
      }, {
        assertLocalDatabase: dependencies.assertLocalDatabase || assertLocalDatabase
      })
    }
  }
  if (MODEL_DEPENDENT_CASES.has(caseId) && !caseRecord.fixtures?.cost) {
    if (!(dependencies.writeFixtures ?? costWritesEnabled()) && !dependencies.prepareCostFixture) {
      return { token, api, partial: true, note: '成本模型写侧开关未启用' }
    }
    await (dependencies.prepareCostFixture || prepareCostModelFixture)({
      api, caseId, record, caseRecord,
      effectiveMonth: COST_CASE_EFFECTIVE_MONTH, remarkForFixture: costFixtureRemark
    })
  }
  const { list: modelVersions, model } = await loadFormalModelPage(api)
  caseRecord.checks.push({
    name: '成本模型版本 API 可用',
    passed: Array.isArray(modelVersions),
    details: model
      ? `${model.id}:${model.versionNo}:${model.status}`
      : '当前租户暂无成本模型，已验证空列表契约'
  })

  // 正式报表 / 采购来源刷新 / 试算职责分离 / 上期结转都需要真实写侧事实，
  // 因此先按案例语义建立专属远期期间的夹具，再进入只读断言。
  const scenarioKind = caseId === 'COST-002' ? null : COST_SCENARIO_BY_CASE[caseId]
  if (scenarioKind && !loadCostScenario(caseRecord)) {
    if (!(dependencies.writeFixtures ?? costWritesEnabled())) {
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '写侧开关未启用；未操作任何共享成本期间'
      })
      return { token, api, partial: true, note: 'CFOR_E2E_WRITE_FIXTURES 未启用' }
    }
    await (dependencies.prepareCostScenario || prepareCostScenario)({
      api, record, caseRecord, scenario: scenarioKind
    })
  }
  if (caseId === 'COST-011') {
    const writeFixtures = dependencies.writeFixtures ?? costWritesEnabled()
    if (!writeFixtures && !dependencies.runCostPurchaseFreightClosure) {
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '写侧开关未启用；未创建专属应付、未刷新采购费用快照、未执行清理写入'
      })
      return { token, api, partial: true, note: 'COST-011 专属采购费用写侧未启用' }
    }
    const fixture = loadCostScenario(caseRecord)
    await (dependencies.runCostPurchaseFreightClosure || runCostPurchaseFreightClosure)({
      api: rawApi,
      page,
      outputDir,
      record,
      caseRecord,
      fixture,
      dependencies: dependencies.costPurchaseFreightDependencies || {}
    })
  }
  if (scenarioKind) {
    if (caseId === 'COST-022') {
      const published = caseRecord.fixtures.costScenario
      const negativeRecord = { ...caseRecord, fixtures: {}, checks: [], evidence: [], notes: [] }
      const negative = await (dependencies.prepareCostScenario || prepareCostScenario)({
        api, record, caseRecord: negativeRecord, scenario: 'accounting'
      })
      caseRecord.fixtures.costUnpublishedScenario = negative
      caseRecord.fixtures.costScenario = { ...published }
    }
    api = await (dependencies.scopedCostScenarioApi || scopedCostScenarioApi)({
      api, record, caseRecord
    })
  }

  if (PERIOD_DEPENDENT_CASES.has(caseId)) {
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = costPageRows(periodsResult, '成本期间')
    if (periods.length === 0) {
      caseRecord.checks.push({
        name: '成本期间正式 API 返回有效空列表（后续保留 PARTIAL）',
        passed: true,
        details: '当前核算组织暂无成本期间，未伪造期间、账套或经营事实'
      })
      await saveCostPrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '当前核算组织暂无成本期间；正式业务闭环待用户确认会计期间后复测。'
      })
      return {
        token,
        api,
        partial: true,
        note: '缺少成本期间前置，未执行写侧和正式报表断言'
      }
    }
  }

  let ownedCostFixture
  if (MODEL_DEPENDENT_CASES.has(caseId)) {
    const prerequisite = await loadOwnedCostFixture({ api, modelVersions, caseId, record, caseRecord })
    ownedCostFixture = prerequisite.fixture
    if (!ownedCostFixture) {
      caseRecord.checks.push({
        name: '专属夹具安全门禁阻断写侧（保留 PARTIAL）',
        passed: true,
        details: prerequisite.note
      })
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: `${prerequisite.note}；未修改历史/共享模型、中心、构成项或分摊规则，未自动创建夹具。`
      })
      return { token, api, partial: true, note: prerequisite.note }
    }
    caseRecord.checks.push({
      name: '模型/中心/构成项精确 ID 与本案本轮 E2E 归属及远期月份一致',
      passed: true,
      details: `model=${ownedCostFixture.model.id} center=${ownedCostFixture.center.id} item=${ownedCostFixture.componentItem.id}`
    })
  }

  if (caseId === 'COST-001') {
    // PB-074：分摊规则按模型版本、成本中心和生效月份读写正式库。
    const rulesResult = model?.id
      ? await api.getBusiness(
          `/cost/allocation-rules?modelVersionId=${model.id}&effectiveMonth=${currentMonth}`
        )
      : null
    const rules = rulesResult?.data || []
    caseRecord.checks.push({
      name: '分摊规则正式接口按模型版本与月份返回列表',
      passed: Array.isArray(rules),
      details: `rows=${Array.isArray(rules) ? rules.length : 'n/a'}`
    })
    if (rules.length) {
      caseRecord.checks.push({
        name: '分摊规则包含成本中心、构成项与分摊模式',
        passed: rules.every(
          (row) =>
            nonEmpty(row.costCenterId) &&
            Array.isArray(row.lines) &&
            row.lines.length > 0 &&
            row.lines.every(
              (line) =>
                nonEmpty(line.componentItemId) &&
                ['QUANTITY', 'AMOUNT', 'MANUAL'].includes(line.allocationMode)
            )
        ),
        details: `rules=${rules.length}`
      })
    }
    const centersResult = await api.getBusiness(`/cost/centers?accountingOrgId=${accountingOrgId}`)
    caseRecord.checks.push({
      name: '成本中心正式主档可用',
      passed: Array.isArray(centersResult?.data),
      details: `centers=${centersResult?.data?.length ?? 0}`
    })
    await openRoute(page, '/cost-management/modeling/allocation-rule', {
      readySelector: '.allocation-workspace',
      retries: 1
    })
    caseRecord.checks.push({
      name: '成本分摊规则页面可打开',
      passed: (await page.locator('.allocation-workspace').count()) > 0,
      details: '真实 Chrome 成本分摊规则页'
    })
    caseRecord.checks.push({
      name: '页面展示成本中心或空态',
      passed:
        (await page.locator('.center-list-item').count()) > 0 ||
        (await page.getByText('成本中心', { exact: false }).count()) > 0,
      details: `centers=${await page.locator('.center-list-item').count()}`
    })
    await saveScreenshot(page, outputDir, 'cost-allocation-rule', record)
    caseRecord.evidence.push('成本分摊规则正式 API、成本中心主档与页面截图')
    return model ? {
      token,
      api,
      allowRuntimeErrors: {
        console: (message) => message.includes('ws://localhost:17521/socket.io')
      }
    } : {
      token,
      api,
      allowRuntimeErrors: {
        console: (message) => message.includes('ws://localhost:17521/socket.io')
      },
      partial: true,
      note: '当前租户暂无成本模型，成本分摊规则完整业务闭环待初始化模型后复测'
    }
  }

  if (caseId === 'COST-002') {
    await (dependencies.runCostOpeningClosure || runCostOpeningClosure)({
      api, caseRecord, record,
      dependencies: {
        config,
        writeFixtures: dependencies.writeFixtures ?? costWritesEnabled(),
        assertLocalDatabase: dependencies.assertLocalDatabase || assertLocalDatabase
      },
      onDraft: async ({ fixture, openingRow }) => {
        await (dependencies.verifyCostOpeningBrowserClosure || verifyCostOpeningBrowserClosure)({
          api, page, fixture, openingRow, caseRecord, record,
          dependencies: {
            browserActions: costOpeningPageActions({ outputDir, record }),
            ...(dependencies.costOpeningBrowserDependencies || {})
          }
        })
      }
    })
    caseRecord.evidence.push('专属期初 DRAFT 页面、取消/刷新草稿隔离、完整 API/SQL 及确认锁定回退')
  }

  if (caseId === 'COST-003') {
    await (dependencies.runCostWorkflowClosure || runCostWorkflowClosure)({
      api, record, caseRecord
    })
    // 成本工作流写接口统一返回 requestId/version，并接受 If-Match 请求契约。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id && period?.modelVersionNo) {
      const requestId = `e2e-cost-contract-${Date.now()}`
      const replay = await api.postBusiness(
        '/cost/periods',
        {
          requestId,
          accountingOrgId,
          period: period.period,
          enterpriseType: period.enterpriseType,
          modelVersion: period.modelVersionNo
        },
        { headers: { 'X-Request-Id': requestId } }
      )
      caseRecord.checks.push({
        name: '成本写接口返回 requestId 与期间版本',
        passed: replay?.data?.requestId === requestId && Number.isInteger(replay?.data?.version),
        details: `requestId=${replay?.data?.requestId || 'missing'}, version=${replay?.data?.version ?? 'missing'}`
      })
      caseRecord.checks.push({
        name: '成本期间接口暴露 If-Match 所需版本',
        passed: Number.isInteger(period.version),
        details: `periodVersion=${period.version ?? 'missing'}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于幂等与 If-Match 契约校验',
        passed: false,
        details: '当前核算组织暂无已建立成本期间'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开并承载写接口契约',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-workflow-contract', record)
    caseRecord.evidence.push('成本工作流 requestId/If-Match 契约 API 与页面截图')
  }

  if (caseId === 'COST-006') {
    // PB-424～PB-443：统一正式成本分析/结果报表接口。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const report = await api.getBusiness(`/cost/reports/dimension-cost-report/${period.id}`)
      caseRecord.checks.push({
        name: '正式成本报表接口返回发布批次与明细',
        passed:
          report?.data?.reportKey === 'dimension-cost-report' &&
          nonEmpty(report?.data?.publicationId) &&
          Array.isArray(report?.data?.rows),
        details: report?.data?.scope || '当前期间没有正式成本发布'
      })
      const abnormal = await api.getBusiness(`/cost/reports/abnormal-fluctuation/${period.id}`)
      caseRecord.checks.push({
        name: '异常波动报表复用规则命中事实',
        passed:
          abnormal?.data?.reportKey === 'abnormal-fluctuation' &&
          Array.isArray(abnormal?.data?.rows),
        details: `异常行=${abnormal?.data?.rows?.length ?? 0}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于正式报表校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行正式报表接口校验'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本结果与成本分析页面可打开',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本报表工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-formal-reports', record)
    caseRecord.evidence.push('PB-424～PB-443 正式报表接口与成本工作台截图')
  }

  if (caseId === 'COST-007') {
    const tenantId = record.environment?.tenantId || config.tenantId
    await verifyCostEnterpriseRejections({
      api, caseRecord, period: currentMonth, tenantId,
      readSnapshot: () => readCostEnterpriseFactSnapshot(
        dependencies.costEnterpriseReadSql || runReadOnlySql)
    })
    const audit = await auditCostEnterpriseRoutes({
      api, tenantId, readSql: dependencies.costEnterpriseReadSql || runReadOnlySql
    })
    caseRecord.costEnterpriseRouteEvidence = audit
    caseRecord.checks.push({
      name: COST_ENTERPRISE_CHECKS.inventory,
      passed: audit.reusedComponent === true,
      details: JSON.stringify({
        workbench: audit.workbench, menuCount: audit.inventory.count,
        menuHash: audit.inventory.sha256, workbenches: audit.workbenches,
        controlRules: audit.controlRules, thresholds: audit.thresholds,
        noParallelSettingsVerified: audit.noParallelSettingsVerified, gaps: audit.gaps
      })
    })
    await (dependencies.openRoute || openRoute)(page, audit.workbench.route, {
      readySelector: '.cost-workbench'
    })
    audit.browser = await verifyCostEnterpriseWorkbench(page, audit)
    caseRecord.checks.push({
      name: COST_ENTERPRISE_CHECKS.workbench,
      passed: true,
      details: JSON.stringify({ route: audit.browser.route, component: audit.browser.component })
    })
    audit.screenshot = await (dependencies.saveScreenshot || saveScreenshot)(
      page, outputDir, 'cost-enterprise-type-isolation', record)
    caseRecord.evidence.push(
      'COST-007 TRADE/六类采购来源精确拒绝消息与逐行正式事实不变证据',
      `COST-007 全量菜单 count=${audit.inventory.count} hash=${audit.inventory.sha256}；` +
      `既有工作台 ${audit.workbench.route} component=${audit.workbench.component}；` +
      `原第三断言仍 GAP：${audit.gaps.join('；')}`
    )
    caseRecord.notes.push(...audit.gaps)
    return { token, api, partial: true, note: 'COST-007 两类拒绝精确复验，入口边界待确认；未修改原断言或设置归属' }
  }

  if (caseId === 'COST-009') {
    // ERP 已审核采购入库自动归集到 FMS 来源快照草稿，确认仍由人工完成。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      const noSourceBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('采购入库')
      const draft = refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT'
      caseRecord.checks.push({
        name: 'ERP采购入库来源刷新为草稿或在无来源时明确阻断',
        passed: draft || noSourceBlocked,
        details: draft ? `snapshot=${refreshed.data.snapshotKey}` : String(refreshed?.msg || '无来源阻断')
      })
      if (draft) {
        const lines = refreshed.data.lines || []
        caseRecord.checks.push({
          name: '采购来源映射为ERP/PURCHASE_RECEIPT且未自动确认',
          passed:
            refreshed.data.snapshotKey === 'PURCHASE' &&
            lines.length > 0 &&
            lines.every(
              (row) => row.sourceModule === 'ERP' &&
                row.sourceType === 'PURCHASE_RECEIPT' &&
                row.sourceStatus === 'CONFIRMED'
            ),
          details: `lines=${lines.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于采购来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购来源刷新场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-source-refresh', record)
    caseRecord.evidence.push('ERP采购入库来源刷新接口、草稿状态与成本工作台截图')
  }

  if (caseId === 'COST-010') {
    // 采购入库与采购退回共用 PURCHASE 快照，退回以负数参与净额计算。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      const lines = refreshed?.data?.lines || []
      const receiptLines = lines.filter((row) => row.sourceType === 'PURCHASE_RECEIPT')
      const returnLines = lines.filter((row) => row.sourceType === 'PURCHASE_RETURN')
      const grouped = new Map()
      for (const row of lines) {
        const key = String(row.productId || row.sourceProductId || '')
        const current = grouped.get(key) || { quantity: 0, amount: 0 }
        current.quantity += Number(row.quantity || row.qty || 0)
        current.amount += Number(row.materialAmount || row.amount || row.totalAmount || 0)
        grouped.set(key, current)
      }
      caseRecord.checks.push({
        name: '采购入库正数与采购退回负数均映射到同一PURCHASE快照',
        passed:
          refreshed?.code === 0 &&
          refreshed?.data?.snapshotKey === 'PURCHASE' &&
          refreshed?.data?.status === 'DRAFT' &&
          receiptLines.every((row) => Number(row.quantity || row.qty || 0) >= 0) &&
          returnLines.every((row) =>
            Number(row.quantity || row.qty || 0) < 0 &&
            Number(row.materialAmount || row.amount || row.totalAmount || 0) <= 0
          ),
        details: `receipts=${receiptLines.length}, returns=${returnLines.length}, status=${refreshed?.data?.status || 'n/a'}`
      })
      if (lines.length) {
        caseRecord.checks.push({
          name: '同产品采购入库与采购退回净数量、净金额不为负',
          passed: [...grouped.values()].every(
            (value) => value.quantity >= 0 && value.amount >= 0
          ),
          details: `products=${grouped.size}`
        })
      }
      caseRecord.checks.push({
        name: '采购退回超过入库净额时由后端阻断或当前净额已通过校验',
        passed:
          (refreshed?.code === 422001 &&
            String(refreshed?.msg || refreshed?.message || '').includes('退回')) ||
          (refreshed?.code === 0 && [...grouped.values()].every(
            (value) => value.quantity >= 0 && value.amount >= 0
          )),
        details: String(refreshed?.msg || refreshed?.message || '当前期间采购退回净额校验通过')
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于采购退回净额校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购入库/退回净额刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购退回净额场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-return-net', record)
    caseRecord.evidence.push('采购入库/采购退回净额接口、草稿状态、阻断校验与成本工作台截图')
  }

  if (caseId === 'COST-011') {
    // COST-011 的正式 API 闭环已在写侧阶段完成；这里只补真实页面证据。
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购到岸费用场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-freight', record)
    caseRecord.evidence.push('采购到岸费用来源接口、费用分项草稿状态与成本工作台截图')
  }

  if (caseId === 'COST-012') {
    // PB-443：采购成本表从正式发布来源显示采购订单口径的发票价格状态与价差。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const report = await api.getBusiness(`/cost/reports/purchase-cost-report/${period.id}`)
      const rows = report?.data?.rows || []
      caseRecord.checks.push({
        name: '采购成本正式报表暴露发票价格状态与比较范围',
        passed:
          report?.data?.reportKey === 'purchase-cost-report' &&
          Array.isArray(rows) &&
          rows.every(
            (row) =>
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceStatus') &&
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceStatusText') &&
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceScope') &&
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceDifference')
          ),
        details: `rows=${rows.length}, scope=${rows[0]?.values?.invoicePriceScope || 'n/a'}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于发票价格状态报表校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购成本正式报表校验'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购成本发票价格状态场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-invoice-price-status', record)
    caseRecord.evidence.push('采购成本正式报表发票价格状态/价差字段与成本工作台截图')
  }

  if (caseId === 'COST-013') {
    // 委外正式成本只从 MES 已完工、已结算来源刷新为 OUTSOURCE 草稿。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/outsource/refresh`
      )
      const lines = refreshed?.data?.lines || []
      const noSourceBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('已完工且已结算委外')
      const draft = refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT'
      caseRecord.checks.push({
        name: 'MES正式委外来源刷新为OUTSOURCE草稿或无来源明确阻断',
        passed: draft || noSourceBlocked,
        details: draft ? `snapshot=${refreshed.data.snapshotKey}` : String(refreshed?.msg || '无来源阻断')
      })
      if (draft) {
        caseRecord.checks.push({
          name: '委外来源映射为MES/OUTSOURCE_COMPLETION并拆分材料费与加工费',
          passed:
            refreshed.data.snapshotKey === 'OUTSOURCE' &&
            lines.length > 0 &&
            lines.every(
              (row) => row.sourceModule === 'MES' &&
                row.sourceType === 'OUTSOURCE_COMPLETION' &&
                row.componentCode === 'OUTSOURCE' &&
                Number(row.quantity || 0) > 0 &&
                Number(row.materialAmount || 0) >= 0 &&
                Number(row.expenseAmount || 0) >= 0 &&
                row.sourceStatus === 'DRAFT'
            ),
          details: `lines=${lines.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于委外来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行委外来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开委外来源刷新场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-outsource-source-refresh', record)
    caseRecord.evidence.push('MES委外正式来源刷新接口、材料/加工费拆分与成本工作台截图')
  }

  if (caseId === 'COST-014') {
    // PB-428：自产与外购比较只读已发布事实，约束事实缺失时必须返回不可比较。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const report = await api.getBusiness(`/cost/reports/make-buy/${period.id}`)
      const rows = report?.data?.rows || []
      const hasNotComparable = rows.some((row) => row.values?.status === '不可比较')
      const hasNonZeroBuyCost = rows.some(
        (row) => row.values?.buyCost !== null && row.values?.buyCost !== undefined && Number(row.values.buyCost) !== 0
      )
      caseRecord.checks.push({
        name: '自产与外购比较正式接口返回make-buy报表',
        passed: report?.data?.reportKey === 'make-buy' && Array.isArray(rows),
        details: `rows=${rows.length}, reportKey=${report?.data?.reportKey || 'n/a'}`
      })
      caseRecord.checks.push({
        name: '质量/交期/产能冻结事实缺失时标记不可比较',
        passed: rows.length === 0 || hasNotComparable,
        details: rows.length === 0 ? '当前期间暂无比较对象' : `notComparable=${hasNotComparable}`
      })
      caseRecord.checks.push({
        name: '外购成本缺少约束事实时不伪造成零值',
        passed: rows.length === 0 || hasNonZeroBuyCost || rows.every((row) => row.values?.buyCost === null),
        details: `nonZeroBuyCost=${hasNonZeroBuyCost}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于自产与外购比较校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行自产与外购正式报表校验'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开自产与外购比较场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-make-buy-report', record)
    caseRecord.evidence.push('自产与外购比较正式报表接口、不可比较状态与成本工作台截图')
  }

  if (caseId === 'COST-015') {
    // PB-428：质量约束只补写已有采购/委外来源草稿，不修改正式成本金额或已确认快照。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/quality/refresh?snapshotKey=PURCHASE`
      )
      const lines = refreshed?.data?.lines || []
      const noQualityBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('质量约束')
      const noSnapshotBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('来源快照')
      const draft = refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT'
      caseRecord.checks.push({
        name: '质量事实刷新只写入PURCHASE草稿或明确阻断',
        passed: draft || noQualityBlocked || noSnapshotBlocked,
        details: draft ? `snapshot=${refreshed.data.snapshotKey}` : String(refreshed?.msg || '无可刷新质量事实')
      })
      if (draft) {
        caseRecord.checks.push({
          name: '质量字段冻结在来源载荷且不改变成本金额',
          passed:
            refreshed.data.snapshotKey === 'PURCHASE' &&
            lines.length > 0 &&
            lines.some((row) => ['PASS', 'DEGRADED', 'FAIL', 'DATA_MISSING'].includes(row.qualityStatus)) &&
            lines.every((row) => Object.prototype.hasOwnProperty.call(row, 'constraintSnapshotHash')),
          details: `lines=${lines.length}`
        })
        caseRecord.checks.push({
          name: '质量刷新保持来源快照草稿状态',
          passed: refreshed.data.status === 'DRAFT',
          details: `status=${refreshed.data.status}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于质量约束刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行质量事实刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开质量约束刷新场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-quality-constraint-refresh', record)
    caseRecord.evidence.push('MES质量事实、FMS来源草稿约束刷新接口与成本工作台截图')
  }

  if (caseId === 'COST-016') {
    // PB-428：交期与产能只补写已有来源草稿，缺少正式事实时明确阻断，不改变成本金额。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const delivery = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/delivery/refresh?snapshotKey=PURCHASE`
      )
      const capacity = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/capacity/refresh?snapshotKey=PURCHASE`
      )
      const accepted = (response) => {
        if (response?.code === 0) return response?.data?.status === 'DRAFT'
        return response?.code === 422001 && Boolean(response?.msg || response?.message)
      }
      caseRecord.checks.push({
        name: '交期约束刷新返回草稿或明确阻断',
        passed: accepted(delivery),
        details: delivery?.code === 0
          ? `status=${delivery.data?.status}, lines=${delivery.data?.lines?.length || 0}`
          : String(delivery?.msg || delivery?.message || '交期刷新无响应')
      })
      caseRecord.checks.push({
        name: '产能约束刷新返回草稿或明确阻断',
        passed: accepted(capacity),
        details: capacity?.code === 0
          ? `status=${capacity.data?.status}, lines=${capacity.data?.lines?.length || 0}`
          : String(capacity?.msg || capacity?.message || '产能刷新无响应')
      })
      if (delivery?.code === 0) {
        const lines = delivery.data?.lines || []
        caseRecord.checks.push({
          name: '交期结果暴露正式状态与快照时间，不参与成本金额',
          passed: lines.length === 0 || lines.every(
            (row) => ['ON_TIME', 'LATE', 'DATA_MISSING', 'NOT_APPLICABLE'].includes(row.deliveryStatus) &&
              Object.prototype.hasOwnProperty.call(row, 'deliveryExpectedAt') &&
              Object.prototype.hasOwnProperty.call(row, 'deliveryActualAt')
          ),
          details: `lines=${lines.length}`
        })
      }
      if (capacity?.code === 0) {
        const lines = capacity.data?.lines || []
        caseRecord.checks.push({
          name: '产能结果只暴露正式负荷事实，不以零值补缺',
          passed: lines.length === 0 || lines.every(
            (row) => row.capacityLoad === null || row.capacityLoad === undefined || Number(row.capacityLoad) >= 0
          ),
          details: `lines=${lines.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于交期与产能约束刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行交期/产能事实刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开交期与产能约束入口',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-delivery-capacity-constraints', record)
    caseRecord.evidence.push('交期/产能正式约束刷新接口与成本工作台截图')
  }

  if (caseId === 'COST-017') {
    // PB-440：ERP 已生效应收作为经营收入唯一只读来源，FMS 刷新只返回未落档草稿。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/operating-income-sources/refresh`
      )
      caseRecord.checks.push({
        name: '经营收入来源刷新返回未落档草稿',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.rowCount || 0}, amount=${refreshed.data?.totalAmount || 0}`
          : String(refreshed?.msg || refreshed?.message || '收入来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.rows || []
        caseRecord.checks.push({
          name: '收入草稿仅包含营业收入且来源可追溯',
          passed: rows.every(
            (row) => row.direction === 'INCOME' &&
              row.reportScope === '营业收入' &&
              row.itemCode === 'SALES_REVENUE' &&
              nonEmpty(row.sourceNo) &&
              ['SalOrder', 'SaleReturn'].includes(row.sourceType)
          ),
          details: `incomeRows=${rows.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于经营收入来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行 ERP 收入来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开经营收入入口',
      passed: (await page.getByText('经营', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-income-refresh', record)
    caseRecord.evidence.push('ERP 应收收入来源刷新接口、草稿契约与成本工作台截图')
  }

  if (caseId === 'COST-018') {
    // PB-420/421：ERP 已审批生效报销明细作为经营费用只读来源，FMS 刷新只返回未落档草稿。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/operating-expense-sources/refresh`
      )
      caseRecord.checks.push({
        name: '经营支出来源刷新返回未落档草稿',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.rowCount || 0}, amount=${refreshed.data?.totalAmount || 0}`
          : String(refreshed?.msg || refreshed?.message || '经营支出来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.rows || []
        caseRecord.checks.push({
          name: '经营支出草稿仅包含已审批生效报销明细',
          passed: rows.every(
            (row) => row.direction === 'EXPENSE' &&
              row.reportScope === '经营费用' &&
              row.itemCode === 'OPERATING_EXPENSE' &&
              nonEmpty(row.sourceNo) &&
              row.sourceType === 'ExpenseReport'
          ),
          details: `expenseRows=${rows.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于经营支出来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行 ERP 报销来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开经营支出入口',
      passed: (await page.getByText('经营', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-expense-refresh', record)
    caseRecord.evidence.push('ERP 报销明细来源刷新接口、草稿契约与成本工作台截图')
  }

  if (caseId === 'COST-019') {
    // PB-420/421：其他应付只接入非采购、非付款反向来源的已生效明细。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/operating-expense-sources/refresh`
      )
      caseRecord.checks.push({
        name: '其他应付经营费用来源刷新返回未落档草稿',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.rowCount || 0}, amount=${refreshed.data?.totalAmount || 0}`
          : String(refreshed?.msg || refreshed?.message || '其他应付来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.rows || []
        const payableRows = rows.filter((row) => row.sourceType === 'Payable')
        caseRecord.checks.push({
          name: '其他应付来源可追溯且统一映射经营费用',
          passed: payableRows.every(
            (row) => row.direction === 'EXPENSE' &&
              row.reportScope === '经营费用' &&
              row.itemCode === 'OPERATING_EXPENSE' &&
              nonEmpty(row.sourceNo)
          ),
          details: `payableRows=${payableRows.length}`
        })
        caseRecord.checks.push({
          name: '经营费用自动生成可追溯分摊基数快照',
          passed:
            rows.length === 0 ||
            rows.every(
              (row) =>
                /^(REVENUE|HEADCOUNT|AREA):/.test(row.allocationBasis || '') &&
                String(row.note || '').includes('分摊基数自动取数')
            ),
          details: `basisRows=${rows.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于其他应付来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行其他应付来源刷新'
      })
    }
    // 支出方向提示仅在“支出”页签渲染，深链接显式切换方向，避免默认收入页签导致误判。
    await openRoute(page, '/cost-management/monthly/operating-income-expense?direction=expense', {
      readySelector: '.operating-collection-workspace'
    })
    caseRecord.checks.push({
      name: '经营支出页说明自动取数口径和发布阻断规则',
      passed:
        (await page.getByText('分摊基数自动取数', { exact: false }).count()) > 0 &&
        (await page.getByText('发布前必须存在有效正数基数', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-payable-expense-refresh', record)
    caseRecord.evidence.push('ERP 其他应付来源刷新接口、非采购过滤契约与成本工作台截图')
  }

  if (caseId === 'COST-020') {
    // PB-420/421：采购/委外应付结算状态只作为来源追溯快照，不改变成本金额。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      caseRecord.checks.push({
        name: '采购成本来源刷新返回应付结算追溯字段',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.lines?.length || 0}`
          : String(refreshed?.msg || refreshed?.message || '采购来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.lines || []
        const tracked = rows.filter((row) => row.sourceType === 'PURCHASE_RECEIPT' || row.sourceType === 'PURCHASE_RETURN')
        caseRecord.checks.push({
          name: '应付状态仅作为快照且不替代采购成本金额',
          passed: tracked.every(
            (row) => ['UNPAID', 'PARTIAL', 'PAID', 'NOT_AVAILABLE'].includes(row.payableSettlementStatus) &&
              row.materialAmount !== undefined &&
              row.payableAmount !== undefined
          ),
          details: `trackedRows=${tracked.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于采购应付结算快照校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购应付结算快照刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购成本来源入口',
      passed: (await page.getByText('采购', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台采购来源入口'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-payable-settlement-snapshot', record)
    caseRecord.evidence.push('采购来源刷新接口、应付结算状态快照与成本金额分离校验、成本工作台截图')
  }

  if (caseId === 'COST-021') {
    // PB-420/421：付款与核销冲销轨迹仅作为来源追溯快照，成本确认金额保持不变。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      caseRecord.checks.push({
        name: '采购成本来源刷新返回付款核销追溯状态',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.lines?.length || 0}`
          : String(refreshed?.msg || refreshed?.message || '采购来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.lines || []
        const traced = rows.filter((row) => row.sourceType === 'PURCHASE_RECEIPT' || row.sourceType === 'PURCHASE_RETURN')
        caseRecord.checks.push({
          name: '付款核销轨迹仅作快照且成本金额不变',
          passed: trackedTraceShape(traced),
          details: `tracedRows=${traced.length}`
        })
        caseRecord.checks.push({
          name: '存在付款核销轨迹时携带可追溯单号与状态',
          passed: traced.every((row) => {
            if (row.payableTraceStatus !== 'AVAILABLE') return true
            const traces = Array.isArray(row.payableSettlementTraces) ? row.payableSettlementTraces : []
            return traces.length > 0 && traces.every((trace) =>
              ['PAYMENT', 'WRITE_OFF'].includes(trace.traceType) &&
              ['CONFIRMED', 'VOIDED'].includes(trace.traceStatus) &&
              nonEmpty(trace.traceNo) &&
              nonEmpty(trace.payableNo))
          }),
          details: `availableRows=${traced.filter((row) => row.payableTraceStatus === 'AVAILABLE').length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于付款核销追溯校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行付款核销追溯刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开付款核销追溯入口',
      passed: (await page.getByText('采购', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台采购来源入口'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-payable-trace', record)
    caseRecord.evidence.push('采购来源刷新接口、付款核销轨迹快照与成本金额分离校验、成本工作台截图')
  }

  if (caseId === 'COST-022') {
    // 反月结重开必须经过申请、复核审批、重新试算、人工确认和再次发布。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    // 反月结重开的"原因必填"门禁在发布批次校验之后执行，因此必须先拿到真实的已发布期间。
    const candidate = loadCostScenario(caseRecord)?.period || periods.find((row) => nonEmpty(row.id))
    const missingReason = candidate
      ? await api.request('POST', `/cost/periods/${candidate.id}/publications/reopen`, {})
      : null
    caseRecord.checks.push({
      name: '反月结重开接口可达且强制要求重开原因',
      passed:
        candidate !== undefined &&
        missingReason?.code !== undefined &&
        missingReason.code !== 0 &&
        missingReason.code !== 500 &&
        /(反月结重开原因|反月结原因)/.test(
          String(missingReason.msg || missingReason.message || '')
        ),
      details: candidate
        ? `code=${missingReason?.code} msg=${missingReason?.msg || missingReason?.message || ''}`
        : '当前核算组织暂无成本期间，未执行反月结接口校验'
    })
    const unpublished = periods.find(
      (row) => row.status !== 'COST_PUBLISHED' || !nonEmpty(row.currentPublicationId)
    )
    if (unpublished) {
      const blocked = await api.request(
        'POST',
        `/cost/periods/${unpublished.id}/publications/reopen`,
        { reason: 'E2E反月结门禁校验' }
      )
      caseRecord.checks.push({
        name: '没有正式发布批次时反月结被业务规则阻断而非未知异常',
        passed: blocked?.code !== undefined && blocked.code !== 0 && blocked.code !== 500,
        details: `code=${blocked?.code} msg=${blocked?.msg || blocked?.message || ''}`
      })
    } else {
      caseRecord.checks.push({
        name: '没有正式发布批次时反月结被业务规则阻断而非未知异常',
        passed: false,
        details: '当前核算组织没有可用于反月结门禁校验的未发布期间样本'
      })
    }

    const fixture = loadCostScenario(caseRecord)
    if (!fixture?.periodId || !fixture.publicationId || !fixture.currentTrialId ||
        !fixture.approvalReviewerUsername || !fixture.approvalReviewerPassword) {
      throw new Error('COST-022 专属发布场景缺少反月结审批或原始试算登记')
    }
    const periodId = String(fixture.periodId)
    const originalTrialId = String(fixture.currentTrialId)
    const originalPublicationId = String(fixture.publicationId)
    const originalPeriod = responseData(await api.getBusiness(`/cost/periods/${periodId}`))
    const originalTrace = responseData(
      await api.getBusiness(`/cost/publications/${originalPublicationId}/trace`)
    )
    const traceFacts = (trace) => JSON.stringify({
      resultHash: trace?.resultHash || '',
      configSnapshotHash: trace?.configSnapshotHash || '',
      sourceSnapshotHash: trace?.sourceSnapshotHash || '',
      engineVersion: trace?.engineVersion || '',
      components: trace?.components || [],
      sources: trace?.sources || [],
      allocations: trace?.allocations || []
    })
    const originalTraceFacts = traceFacts(originalTrace)

    const reopenRequest = await api.postBusiness(
      `/cost/periods/${periodId}/publications/reopen`,
      { reason: 'COST-022 E2E 反月结重开审批' }
    )
    const reopenApplication = responseData(reopenRequest)
    const pendingPeriod = responseData(await api.getBusiness(`/cost/periods/${periodId}`))
    const activeApproval = responseData(await api.getBusiness(
      `/cost/publication-approvals/periods/${periodId}/active`
    ))
    if (pendingPeriod.status !== 'COST_PUBLISHED' ||
        String(pendingPeriod.currentPublicationId) !== originalPublicationId ||
        String(pendingPeriod.currentTrialId) !== originalTrialId ||
        String(activeApproval?.id) !== String(reopenApplication?.approvalId)) {
      throw new Error('COST-022 反月结申请阶段提前改变正式成本状态')
    }
    const reviewerToken = await loginAs(
      record, fixture.approvalReviewerUsername, fixture.approvalReviewerPassword
    )
    const reviewerApi = createApiClient({ token: reviewerToken, record })
    await reviewerApi.postBusiness(
      `/cost/publication-approvals/${activeApproval.id}/approve`,
      {
        note: 'COST-022 E2E 复核通过并执行反月结重开',
        expectedVersion: activeApproval.version
      },
      {
        headers: {
          'If-Match': String(activeApproval.version),
          'X-Request-Id': `e2e-cost022-approve-${record.runId}`
        }
      }
    )
    const reopenedPeriod = responseData(await api.getBusiness(`/cost/periods/${periodId}`))
    const originalTraceAfterReopen = responseData(
      await api.getBusiness(`/cost/publications/${originalPublicationId}/trace`)
    )
    const stateEvidence = await runReadOnlySql(`
      SELECT 'trial', CAST(id AS CHAR), status, CAST(period_id AS CHAR),
             CAST(result_hash AS CHAR), CAST(finished_amount AS CHAR)
      FROM cost_trial
      WHERE tenant_id=1 AND id=${originalTrialId} AND deleted=b'0'
      UNION ALL
      SELECT 'publication', CAST(id AS CHAR), status, CAST(period_id AS CHAR),
             CAST(result_hash AS CHAR), CAST(batch_no AS CHAR)
      FROM cost_publication
      WHERE tenant_id=1 AND id=${originalPublicationId} AND deleted=b'0'
    `)
    caseRecord.database = [...(caseRecord.database || []), {
      stage: 'cost022-reopen-history', ...stateEvidence
    }]
    const trialHistory = stateEvidence.rows.find((row) =>
      row[0] === 'trial' && row[1] === originalTrialId)
    const publicationHistory = stateEvidence.rows.find((row) =>
      row[0] === 'publication' && row[1] === originalPublicationId)
    const historyPassed = reopenedPeriod.status === 'ACCOUNTING' &&
      reopenedPeriod.currentTrialId == null &&
      reopenedPeriod.currentPublicationId == null &&
      trialHistory?.[2] === 'SUPERSEDED' &&
      publicationHistory?.[2] === 'REVERSED' &&
      traceFacts(originalTraceAfterReopen) === originalTraceFacts
    caseRecord.checks.push({
      name: '反月结后原发布批次保留为REVERSED、原试算保留为SUPERSEDED，期间回到ACCOUNTING并解绑当前批次',
      passed: stateEvidence.available && historyPassed,
      details: `period=${reopenedPeriod.status}; trial=${trialHistory?.[2] || 'missing'}; ` +
        `publication=${publicationHistory?.[2] || 'missing'}; traceUnchanged=${traceFacts(originalTraceAfterReopen) === originalTraceFacts}`
    })
    if (!historyPassed) throw new Error('COST-022 反月结历史状态或原发布事实回读不符合契约')

    const retrial = responseData(await api.postBusiness(
      `/cost/periods/${periodId}/trials`,
      {
        enterpriseType: reopenedPeriod.enterpriseType,
        periodId,
        modelVersion: reopenedPeriod.modelVersionNo,
        requestId: `e2e-cost022-retrial-${record.runId}`
      }
    ))
    const trialPeriod = responseData(await api.getBusiness(`/cost/periods/${periodId}`))
    const newTrialId = String(trialPeriod.currentTrialId || retrial?.trialId || '')
    if (!newTrialId || newTrialId === originalTrialId || trialPeriod.status !== 'TRIAL_PENDING') {
      throw new Error('COST-022 反月结后未生成新的待确认试算')
    }
    const confirmed = await reviewerApi.postBusiness(
      `/cost/trials/${newTrialId}/confirm`,
      undefined,
      {
        headers: {
          'If-Match': String(trialPeriod.version),
          'X-Request-Id': `e2e-cost022-confirm-${record.runId}`
        }
      }
    )
    const confirmedPeriod = responseData(await api.getBusiness(`/cost/periods/${periodId}`))
    if (confirmedPeriod.status !== 'TRIAL_CONFIRMED' ||
        String(confirmedPeriod.currentTrialId) !== newTrialId) {
      throw new Error(`COST-022 新试算确认后状态异常：${confirmedPeriod.status}`)
    }
    const republished = responseData(await reviewerApi.postBusiness(
      `/cost/periods/${periodId}/publications`,
      undefined,
      {
        headers: {
          'If-Match': String(confirmedPeriod.version),
          'X-Request-Id': `e2e-cost022-republish-${record.runId}`
        }
      }
    ))
    const republishedPeriod = responseData(await api.getBusiness(`/cost/periods/${periodId}`))
    const newPublicationId = String(
      republishedPeriod.currentPublicationId || republished?.publicationId || ''
    )
    const newTrace = responseData(
      await api.getBusiness(`/cost/publications/${newPublicationId}/trace`)
    )
    const republishPassed = Boolean(
      confirmed?.data || confirmed
    ) && republishedPeriod.status === 'COST_PUBLISHED' &&
      newPublicationId && newPublicationId !== originalPublicationId &&
      String(republishedPeriod.currentTrialId) === newTrialId &&
      traceFacts(newTrace) === originalTraceFacts
    caseRecord.checks.push({
      name: '重开后必须重新试算、人工确认并发布新批次，已发布金额不被覆盖',
      passed: republishPassed,
      details: `newTrial=${newTrialId}; oldTrial=${originalTrialId}; ` +
        `newPublication=${newPublicationId}; oldPublication=${originalPublicationId}; ` +
        `traceFactsPreserved=${traceFacts(newTrace) === originalTraceFacts}`
    })
    if (!republishPassed) throw new Error('COST-022 重开后的重新试算/确认/发布链路未闭环')
    fixture.reopenedPublicationId = newPublicationId
    fixture.reopenedTrialId = newTrialId
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开反月结重开入口',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台入口'
    })
    await saveScreenshot(page, outputDir, 'cost-publication-reopen', record)
    caseRecord.evidence.push('反月结重开接口契约、门禁规则与成本工作台截图')
  }

  if (caseId === 'COST-023') {
    await (dependencies.runCostSeparationClosure || runCostSeparationClosure)({
      api: rawApi,
      actorApi: rawApi,
      record,
      caseRecord,
      dependencies: {
        ...dependencies.costWorkflowDependencies,
        writeFixtures: dependencies.writeFixtures ?? costWritesEnabled()
      }
    })
    caseRecord.evidence.push('COST-023 专属期间、试算、独立复核、发布人与审批人 API/数据库证据')
  }

  if (caseId === 'COST-024') {
    // 上期结转必须由后端按上一已发布期间的期末在制派生，不再由前端本地推算正式口径。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    // 夹具先造出"上一已发布期间 + 当前核算中期间"，因此优先用它派生 CARRYOVER。
    const scenarioPeriod = loadCostScenario(caseRecord)?.period
    const accounting = [
      ...(scenarioPeriod?.status === 'ACCOUNTING' ? [scenarioPeriod] : []),
      ...periods.filter((row) => row.status === 'ACCOUNTING' && row.id !== scenarioPeriod?.id)
    ]
    let carriedSample = null
    let blockedSample = null
    for (const period of accounting) {
      const response = await api.request(
        'POST',
        `/cost/periods/${period.id}/opening-wip/carry-forward?stage=CARRYOVER`
      )
      if (response?.code === 0) {
        carriedSample = { period, rows: response?.data || [] }
        // 首条可用样本即本轮证据；继续遍历会覆盖成更早的共享期间，证据不再属于本轮夹具。
        break
      } else if (blockedSample === null) {
        blockedSample = { period, response }
      }
    }
    caseRecord.checks.push({
      name: '核算中期间的上期结转接口返回后端派生的期末在制草稿',
      passed:
        carriedSample !== null &&
        carriedSample.rows.length > 0 &&
        carriedSample.rows.every(
          (row) => row.sourceType === 'CARRYOVER' && nonEmpty(row.sourceRef)
        ),
      details: carriedSample
        ? `periodId=${carriedSample.period.id} rows=${carriedSample.rows.length} sourceRef=${carriedSample.rows[0]?.sourceRef || '空'}`
        : '当前核算组织没有可派生上期结转的核算中期间'
    })
    caseRecord.checks.push({
      name: '缺少上一已发布期间时结转被业务规则阻断而非未知异常',
      passed:
        blockedSample === null ||
        (blockedSample.response.code !== 500 &&
          String(blockedSample.response.msg || blockedSample.response.message || '').includes(
            'previous published'
          )),
      details: blockedSample
        ? `periodId=${blockedSample.period.id} code=${blockedSample.response.code} msg=${blockedSample.response.msg || blockedSample.response.message || ''}`
        : '当前核算组织所有核算中期间均可派生结转，未触发缺失上期门禁'
    })
    if (carriedSample) {
      // getBusiness 返回 {code,data,msg}，结转明细数组在 data 内。
      const listed = responseData(
        await api.getBusiness(
          `/cost/periods/${carriedSample.period.id}/opening-wip?stage=CARRYOVER`
        )
      )
      caseRecord.checks.push({
        name: '上期结转明细可在正式接口按 CARRYOVER 阶段查询',
        passed:
          Array.isArray(listed) &&
          listed.length > 0 &&
          listed.every((row) => row.stage === 'CARRYOVER' && nonEmpty(row.sourceRef)),
        details: `stage=CARRYOVER rows=${Array.isArray(listed) ? listed.length : 'n/a'}`
      })
    }
    // Shared workspace-state is not changed to force a browser acceptance state.
    {
      await openRoute(page, '/cost-management/monthly/opening-wip', {
        readySelector: '.opening-wip-workspace'
      })
      caseRecord.checks.push({
        name: '成本工作台可打开上期结转入口',
        passed: (await page.getByText('期初', { exact: false }).count()) > 0,
        details: '真实 Chrome 成本工作台期初/上期在制入口'
      })
      // 上期结转阶段由远端 workspace-state 异步 hydrate 派生，必须等分支真正切到
      // 上期在制后再取口径提示，否则会因初始渲染仍处于期初阶段而漏判提示。
      const stageVisible = await page.getByText('上期结转', { exact: false })
        .first().isVisible()
      if (!stageVisible) {
        caseRecord.notes.push('COST-024 浏览器当前共享阶段不是上期结转；未改共享模型、期间或 gate 状态')
        await saveScreenshot(page, outputDir, 'cost-opening-wip-carry-forward', record)
        return { token, api, partial: true, note: '专属 API 证据完成；共享页面阶段不可安全切换' }
      }
      // 口径说明挂在悬浮提示里，逐个小问号 hover，直到目标文案出现。
      const carryoverRuleTriggers = page.locator(
        '.opening-wip-workspace .el-tooltip__trigger'
      )
      await carryoverRuleTriggers.first().waitFor({ state: 'visible', timeout: 30000 })
      const carryoverTriggerCount = await carryoverRuleTriggers.count()
      for (let index = 0; index < carryoverTriggerCount; index++) {
        await carryoverRuleTriggers.nth(index).hover().catch(() => {})
        await page.waitForTimeout(250)
        if ((await page.getByText('投入结构拆分', { exact: false }).count()) > 0) break
      }
      caseRecord.checks.push({
        name: '上期结转页面说明料工费拆分和数量人工确认口径',
        passed:
          (await page.getByText('投入结构拆分', { exact: false }).count()) > 0 ||
          (await page.getByText('数量仍需人工确认', { exact: false }).count()) > 0,
        details: '真实 Chrome 上期结转口径提示'
      })
      await saveScreenshot(page, outputDir, 'cost-opening-wip-carry-forward', record)
    }
    caseRecord.evidence.push(
      '上期结转后端派生契约、CARRYOVER 阶段查询、料工费拆分提示与成本工作台截图'
    )
  }

  if (caseId === 'COST-025') {
    // 异常处理队列以 cost_rule_hit 正式事实为准，批量动作只放行警告项、不动阻断项。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    const candidate =
      loadCostScenario(caseRecord)?.period ||
      periods.find((row) => row.status === 'COST_PUBLISHED' && nonEmpty(row.currentPublicationId)) ||
      periods.find((row) => nonEmpty(row.currentPublicationId))
    if (candidate) {
      const hits = await api.request(
        'GET',
        `/cost/periods/${candidate.id}/rule-hits?pageNo=1&pageSize=100`
      )
      const rows = hits?.data?.list || []
      caseRecord.checks.push({
        name: '异常队列读取 cost_rule_hit 正式分页事实',
        passed:
          hits?.code === 0 &&
          Array.isArray(rows) &&
          rows.every((row) => ['BLOCK', 'WARN', 'PASS'].includes(row.level) && nonEmpty(row.status)),
        details: `periodId=${candidate.id} total=${hits?.data?.total ?? 0} rows=${rows.length}`
      })
      const missingNote = await api.request(
        'POST',
        `/cost/periods/${candidate.id}/rule-hits/release-warnings`,
        {}
      )
      caseRecord.checks.push({
        name: '批量放行警告项强制要求处理说明',
        passed: missingNote?.code !== undefined && missingNote.code !== 0 && missingNote.code !== 500,
        details: `code=${missingNote?.code} msg=${missingNote?.msg || missingNote?.message || ''}`
      })
      const released = await api.request(
        'POST',
        `/cost/periods/${candidate.id}/rule-hits/release-warnings`,
        { note: 'E2E 批量放行警告项校验' }
      )
      const releasedOk =
        released?.code === 0 &&
        released?.data?.releasedCount !== undefined &&
        released?.data?.remainingBlockingCount !== undefined
      const releasedBlocked = released?.code !== undefined && released.code !== 0 && released.code !== 500
      caseRecord.checks.push({
        name: '批量放行只处理警告项并返回剩余阻断数量',
        passed: releasedOk || releasedBlocked,
        details: `code=${released?.code} released=${released?.data?.releasedCount ?? '空'} remainingBlocking=${released?.data?.remainingBlockingCount ?? '空'} msg=${released?.msg || released?.message || ''}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在可用于异常队列校验的成本期间',
        passed: false,
        details: '当前核算组织暂无成本期间'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开异常处理入口',
      passed: (await page.getByText('异常', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台异常处理入口'
    })
    await saveScreenshot(page, outputDir, 'cost-exception-queue', record)
    caseRecord.evidence.push('异常队列正式事实分页、警告批量放行契约与成本工作台截图')
  }

  if (caseId === 'COST-026') {
    // 发票价格差异只按发票自身保存的采购订单行级快照比较；缺少行级事实时明确回落订单级，不按金额摊分。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    const publishedPeriods = periods.filter(
      (row) => ['PUBLISHED', 'COST_PUBLISHED'].includes(String(row.status)) && nonEmpty(row.id)
    )
    let reportSample = null
    let blockedSample = null
    for (const period of publishedPeriods) {
      const response = await api.request(
        'GET',
        `/cost/reports/purchase-cost-report/${period.id}`
      )
      if (response?.code === 0 && (response?.data?.rows?.length || 0) > 0) {
        reportSample = { period, response }
        break
      }
      if (blockedSample === null && response?.code !== 0) {
        blockedSample = { period, response }
      }
    }
    if (reportSample) {
      const rows = reportSample.response.data.rows
      const scopes = rows.map((row) => String(row.values?.invoicePriceScope || ''))
      caseRecord.checks.push({
        name: '采购成本表返回发票价格比较范围与可读口径',
        passed:
          rows.every(
            (row) =>
              nonEmpty(row.values?.invoicePriceScope) &&
              nonEmpty(row.values?.invoicePriceScopeText) &&
              ['PURCHASE_ORDER_LINE', 'PURCHASE_ORDER', 'UNAVAILABLE'].includes(
                String(row.values?.invoicePriceScope)
              )
          ) && rows.every((row) => nonEmpty(row.values?.invoicePriceStatusText)),
        details: `periodId=${reportSample.period.id} rows=${rows.length} scopes=${[
          ...new Set(scopes)
        ].join(',')}`
      })
      const lineRows = rows.filter((row) => row.values?.invoicePriceScope === 'PURCHASE_ORDER_LINE')
      caseRecord.checks.push({
        name: '行级发票比较同时返回开票数量、开票单价与基准单价',
        passed:
          lineRows.length === 0 ||
          lineRows.every(
            (row) =>
              row.values?.invoiceQuantity !== null &&
              row.values?.invoiceQuantity !== undefined &&
              row.values?.invoiceUnitPrice !== null &&
              row.values?.invoiceUnitPrice !== undefined &&
              row.values?.invoiceExpectedUnitPrice !== null &&
              row.values?.invoiceExpectedUnitPrice !== undefined
          ),
        details:
          lineRows.length === 0
            ? '本期没有行级发票快照样本，仅校验订单级口径'
            : `lineRows=${lineRows.length}`
      })
      caseRecord.checks.push({
        name: '报表提示明确订单级金额不会摊到入库行',
        passed: (reportSample.response.data.notices || []).some((notice) =>
          String(notice).includes('行')
        ),
        details: `notices=${(reportSample.response.data.notices || []).length}`
      })
    } else {
      caseRecord.checks.push({
        name: '采购成本表在无正式发布期间时返回业务错误而非未知异常',
        passed:
          blockedSample === null ||
          (blockedSample.response.code !== 500 &&
            !String(blockedSample.response.message || '').toLowerCase().includes('exception')),
        details: blockedSample
          ? `periodId=${blockedSample.period.id} code=${blockedSample.response.code} msg=${blockedSample.response.msg || blockedSample.response.message || ''}`
          : '当前核算组织没有已发布成本期间，未触发采购成本表查询'
      })
    }
    // 采购成本工作区只在月度深链接下挂载，直接打开目标路由而非依赖工作台快捷入口。
    await openRoute(page, '/cost-management/monthly/purchase-costing', {
      readySelector: '[data-testid="formal-purchase-cost"]'
    })
    caseRecord.checks.push({
      name: '采购成本页面说明发票行级与订单级比较口径',
      passed:
        (await page.getByText('发票价格差异口径', { exact: false }).count()) > 0 ||
        (await page.getByText('发票比较范围', { exact: false }).count()) > 0,
      details: '真实 Chrome 采购成本页面发票价格比较范围提示'
    })
    await saveScreenshot(page, outputDir, 'cost-invoice-line-price-scope', record)
    caseRecord.evidence.push(
      '采购成本表发票比较范围契约、行级开票数量与单价字段、页面口径提示与截图'
    )
  }

  if (caseId === 'COST-027') {
    // 异常影响金额只从已确认来源快照与当前试算对象派生；无法量化时返回 UNRESOLVED，不用 0 冒充已知金额。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    const candidate = periods.find((row) => nonEmpty(row.id))
    if (candidate) {
      const hits = await api.request(
        'GET',
        `/cost/periods/${candidate.id}/rule-hits?pageNo=1&pageSize=100`
      )
      const rows = hits?.data?.list || []
      const scopes = ['SOURCE_LINE', 'TRIAL_DIFFERENCE', 'COST_CENTER_INPUT', 'UNRESOLVED']
      caseRecord.checks.push({
        name: '异常队列返回只读影响金额与取数口径',
        passed:
          hits?.code === 0 &&
          Array.isArray(rows) &&
          rows.every(
            (row) => nonEmpty(row.impactScope) && nonEmpty(row.impactBasis)
          ) &&
          rows.every((row) => scopes.includes(String(row.impactScope))),
        details: `periodId=${candidate.id} rows=${rows.length} scopes=${[
          ...new Set(rows.map((row) => String(row.impactScope)))
        ].join(',')}`
      })
      const unresolved = rows.filter((row) => row.impactScope === 'UNRESOLVED')
      caseRecord.checks.push({
        name: '不可量化异常不返回 0 冒充已知影响金额',
        passed: unresolved.every(
          (row) => row.impactAmount === null || row.impactAmount === undefined
        ),
        details: unresolved.length
          ? `unresolved=${unresolved.length} basis=${unresolved[0].impactBasis || ''}`
          : '本期异常均可在既有正式事实中量化'
      })
      const sourceScoped = rows.filter((row) => row.impactScope === 'SOURCE_LINE')
      caseRecord.checks.push({
        name: '来源类规则影响金额来自已确认来源快照且非零',
        passed: sourceScoped.every((row) => Number(row.impactAmount) > 0),
        details: sourceScoped.length
          ? `sourceRows=${sourceScoped.length} firstAmount=${sourceScoped[0].impactAmount}`
          : '本期没有来源类影响金额样本'
      })
    } else {
      caseRecord.checks.push({
        name: '存在可用于影响金额校验的成本期间',
        passed: false,
        details: '当前核算组织暂无成本期间'
      })
    }
    // 异常队列只作为成本工作台弹窗渲染，先打开工作台再点“流程阻断”入口触发弹窗。
    await openRoute(page, '/cost-management/workbench', { readySelector: '.title-line h1' })
    const exceptionEntry = page.getByText('流程阻断', { exact: false }).first()
    if ((await exceptionEntry.count()) > 0) {
      await exceptionEntry.click().catch(() => {})
    }
    // 异常队列是按需加载的工作区，需等待目标提示挂载后再断言，避免截图停在加载态。
    await page
      .locator('.impact-caliber-note')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {})
    caseRecord.checks.push({
      name: '异常处理页面说明影响金额口径与不可量化规则',
      passed: (await page.getByText('异常影响金额口径', { exact: false }).count()) > 0,
      details: '真实 Chrome 异常队列影响金额口径提示'
    })
    await saveScreenshot(page, outputDir, 'cost-exception-impact-amount', record)
    caseRecord.evidence.push(
      '异常影响金额派生契约、不可量化口径、来源类金额校验与页面提示截图'
    )
  }

  if (caseId === 'COST-028') {
    await (dependencies.runCostPublicationApprovalClosure || runCostPublicationApprovalClosure)({
      api: rawApi,
      actorApi: rawApi,
      record,
      caseRecord,
      page,
      outputDir,
      dependencies: {
        ...dependencies.costWorkflowDependencies,
        writeFixtures: dependencies.writeFixtures ?? costWritesEnabled()
      }
    })
    caseRecord.evidence.push('COST-028 专属期间、发布批次、审批申请/决策、状态机和令牌清理 API/数据库证据')
  }

  if (caseId === 'COST-029') {
    // PB-071：成本中心编码稳定、部门有效期内唯一归属，停用后按后续日期释放。
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const firstCode = `E2E-CC-${suffix}`
    const secondCode = `E2E-CC2-${suffix}`
    const centersResult = await api.getBusiness(`/cost/centers?accountingOrgId=${accountingOrgId}`)
    const departmentsResult = await api.getBusiness('/cost/centers/departments')
    const centers = costArrayData(centersResult, '成本中心')
    const departments = flattenDepartments(costArrayData(departmentsResult, '成本中心部门'))
    const occupiedDepartmentIds = new Set(
      centers
        .filter((row) => row.status !== 'DISABLED' || !row.disabledAt)
        .flatMap((row) => row.departmentIds || [])
        .map(String)
    )
    if (!(dependencies.writeFixtures ?? costWritesEnabled())) {
      return { token, api, partial: true, note: '成本中心专属写侧开关未启用' }
    }
    if (config.target !== 'local' || config.tenantId !== '1' ||
        String(record.environment?.tenantId) !== '1') {
      throw new Error('BLOCKED: COST-029 only allows local tenant1')
    }
    const permissionDependencies = {
      ...dependencies.costCenterPermissionDependencies,
      writeFixtures: dependencies.writeFixtures ?? costWritesEnabled()
    }
    const permissionPreflight = await preflightCostCenterPermissionClosure({
      api, record, caseRecord,
      dependencies: {
        ...permissionDependencies,
        assertLocalWriteSafety: dependencies.assertLocalWriteSafety ||
          permissionDependencies.assertLocalWriteSafety || assertLocalWriteSafety
      }
    })
    let dedicatedDepartment
    try {
      dedicatedDepartment = await prepareDedicatedCostDepartment({ api, record, caseRecord })
    } catch (error) {
      const closure = caseRecord.costCenterPermissionClosure
      closure.status = 'FAILED'
      closure.residuals.push({
        step: 'departmentPreparation',
        department: caseRecord.fixtures?.costDepartment || null,
        reason: error.message
      })
      caseRecord.checks.push({
        name: 'COST-029 专属部门创建/正式回读失败不得转PARTIAL',
        passed: false, details: error.message
      })
      throw error
    }
    const availableDepartment = { id: dedicatedDepartment.id, status: 0 }
    let firstCenterId
    let firstCenterActive = false
    let secondCenterId
    let secondCenterActive = false
    let missingAvailableDepartment = false

    if (availableDepartment) {
      const firstDate = nextCostCenterStartDate({
        centers, departmentId: availableDepartment.id, today: offsetDate(0)
      })
      const secondDateValue = new Date(`${firstDate}T00:00:00Z`)
      secondDateValue.setUTCDate(secondDateValue.getUTCDate() + 1)
      const secondDate = secondDateValue.toISOString().slice(0, 10)
      caseRecord.notes.push(`临时成本中心仅使用历史停用日之后的区间：${firstDate} / ${secondDate}`)
      const firstPayload = {
        accountingOrgId,
        code: firstCode,
        name: `E2E成本中心${suffix}`,
        enabledAt: firstDate,
        departmentIds: [availableDepartment.id],
        remark: permissionPreflight.marker
      }
      try {
        const firstCreate = await api.post('/cost/centers', firstPayload)
        firstCenterId = isCostFixtureId(responseData(firstCreate)?.id) ? responseData(firstCreate).id : null
        firstCenterActive = firstCreate?.code === 0 && firstCenterId !== null
        if (firstCreate?.code === 0 && !firstCenterId) {
          caseRecord.costCenterPermissionClosure.residuals.push({
            step: 'firstCenterCreateIdentity', code: firstCode, marker: permissionPreflight.marker,
            reason: 'Formal create succeeded without a lossless string ID; no ID-targeted mutation attempted'
          })
        }
        caseRecord.checks.push({
          name: '成本中心可引用真实部门并按启用日期创建',
          passed: firstCenterActive,
          details: `centerId=${firstCenterId || 'missing'}, deptId=${availableDepartment.id}`
        })
        if (!firstCenterActive) {
          throw new Error(`成本中心首次创建失败，停止后续写侧：${firstCreate?.msg || firstCreate?.code}`)
        }
        caseRecord.checks.push({
          name: '成本中心回读保留原始部门 ID，未发生 Snowflake 精度丢失',
          passed: responseData(firstCreate)?.departmentIds?.includes(availableDepartment.id) === true,
          details: `deptId=${availableDepartment.id}`
        })

        const overlapCreate = await api.post('/cost/centers', {
          ...firstPayload,
          code: secondCode,
          name: `E2E重叠成本中心${suffix}`,
          enabledAt: secondDate
        })
        caseRecord.checks.push({
          name: '同一部门在重叠有效期内禁止重复归属',
          passed:
            overlapCreate?.code !== 0 &&
            String(overlapCreate?.msg || overlapCreate?.message || '').includes('已归属'),
          details: `code=${overlapCreate?.code} msg=${overlapCreate?.msg || overlapCreate?.message || ''}`
        })

        const codeChange = await api.put(`/cost/centers/${firstCenterId}`, {
          ...firstPayload,
          code: `${firstCode}-CHANGED`
        })
        caseRecord.checks.push({
          name: '成本中心稳定编码创建后不可修改',
          passed:
            codeChange?.code !== 0 &&
            String(codeChange?.msg || codeChange?.message || '').includes('编码创建后不允许修改'),
          details: `code=${codeChange?.code} msg=${codeChange?.msg || codeChange?.message || ''}`
        })

        const firstDeactivate = await api.post(`/cost/centers/${firstCenterId}/deactivate`, {
          disabledAt: firstDate,
          reason: permissionPreflight.marker
        })
        firstCenterActive = !(firstDeactivate?.code === 0)
        caseRecord.checks.push({
          name: '成本中心停用后关闭部门有效关系',
          passed: firstDeactivate?.code === 0,
          details: `code=${firstDeactivate?.code}`
        })
        if (firstCenterActive) throw new Error('首次停用失败，停止后续部门重用')

        const secondCreate = await api.post('/cost/centers', {
          ...firstPayload,
          code: secondCode,
          name: `E2E后续成本中心${suffix}`,
          enabledAt: secondDate
        })
        secondCenterId = isCostFixtureId(responseData(secondCreate)?.id) ? responseData(secondCreate).id : null
        secondCenterActive = secondCreate?.code === 0 && secondCenterId !== null
        if (secondCreate?.code === 0 && !secondCenterId) {
          caseRecord.costCenterPermissionClosure.residuals.push({
            step: 'secondCenterCreateIdentity', code: secondCode, marker: permissionPreflight.marker,
            reason: 'Formal create succeeded without a lossless string ID; no ID-targeted mutation attempted'
          })
        }
        caseRecord.checks.push({
          name: '停用后的部门可按后续日期归属新成本中心',
          passed: secondCenterActive,
          details: `centerId=${secondCenterId || 'missing'}`
        })
        if (!secondCenterActive) throw new Error('后续成本中心创建失败，停止页面数据断言')

        await runCostCenterPermissionClosure({
          preflight: permissionPreflight, api, record, caseRecord, page, outputDir,
          department: dedicatedDepartment,
          activeCenter: responseData(secondCreate),
          ownedCenters: [responseData(firstCreate), responseData(secondCreate)],
          dependencies: permissionDependencies
        })
      } finally {
        if (firstCenterId && firstCenterActive) {
          try {
            const cleanup = await api.post(`/cost/centers/${firstCenterId}/deactivate`, {
              disabledAt: firstDate,
              reason: permissionPreflight.marker
            })
            caseRecord.checks.push({
              name: '本轮首次成本中心失败后清理停用成功',
              passed: cleanup?.code === 0 && responseData(cleanup)?.status === 'DISABLED',
              details: `centerId=${firstCenterId}, code=${cleanup?.code}`
            })
          } catch (error) {
            caseRecord.checks.push({
              name: '本轮首次成本中心失败后清理停用成功',
              passed: false,
              details: error.message
            })
          }
        }
        if (secondCenterId && secondCenterActive) {
          try {
            const cleanup = await api.post(`/cost/centers/${secondCenterId}/deactivate`, {
              disabledAt: secondDate,
              reason: permissionPreflight.marker
            })
            caseRecord.checks.push({
              name: '本轮后续成本中心清理停用成功',
              passed: cleanup?.code === 0 && responseData(cleanup)?.status === 'DISABLED',
              details: `centerId=${secondCenterId}, code=${cleanup?.code}`
            })
          } catch (error) {
            caseRecord.checks.push({
              name: '本轮后续成本中心清理停用成功',
              passed: false,
              details: error.message
            })
          }
        }
      }
    } else {
      missingAvailableDepartment = true
      caseRecord.checks.push({
        name: '真实部门占用前置已查询（无可用区间，保留 PARTIAL）',
        passed: true,
        details: '当前没有启用且不存在开放归属关系的部门，未创建临时成本中心'
      })
    }

    if (missingAvailableDepartment) {
      await saveCostPrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '部门依赖缺失，仅完成正式部门查询与工作台前置，未执行成本中心创建/停用'
      })
      return {
        token,
        api,
        partial: true,
        note: '当前没有未占用部门，成本中心写侧未伪造数据'
      }
    }
    caseRecord.evidence.push(
      '成本中心正式创建、编码不可变、部门跨期冲突、停用释放与页面权限入口'
    )
    return { token, api }
  }

  if (caseId === 'COST-030') {
    // PB-072/073：成本构成项与来源规则按模型版本走正式 API，方向/口径字段往返不丢失。
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const draftModel = ownedCostFixture.model
    if (draftModel) {
      const modelVersionId = String(draftModel.id)
      const original = ownedCostFixture.config
      caseRecord.checks.push({
        name: '成本构成项正式接口返回分类/构成项/来源规则三段结构',
        passed:
          Array.isArray(original.categories) &&
          Array.isArray(original.items) &&
          Array.isArray(original.sourceRules),
        details: `categories=${original.categories?.length ?? 'n/a'} items=${original.items?.length ?? 'n/a'} sourceRules=${original.sourceRules?.length ?? 'n/a'}`
      })
      const probeCode = `E2E-CCF-${suffix}`
      const probePayload = {
        categories: [
          {
            id: 'cat-probe',
            parentId: '',
            code: `${probeCode}-C`,
            name: 'E2E构成分类',
            sortNo: 100,
            status: 'ENABLED'
          }
        ],
        items: [
          {
            id: 'item-probe',
            categoryId: 'cat-probe',
            code: probeCode,
            name: 'E2E构成项',
            inclusionRate: 100,
            fetchMode: 'AUTO',
            resultScope: 'OPERATING_EXPENSE',
            businessDirection: 'EXPENSE',
            amountBasis: '审核金额',
            dateBasis: '审核日期',
            reportScope: '管理费用',
            affectOperatingProfit: true,
            reconciliationSourceType: 'ERP_EXPENSE_REPORT',
            systemItem: false,
            participateWip: false,
            status: 'ENABLED',
            remark: 'PB-072/073 E2E probe'
          }
        ],
        sourceRules: [
          {
            id: 'rule-probe',
            componentItemId: 'item-probe',
            sourceType: 'SRC-EXPENSE',
            sourcePriority: 1,
            status: 'ENABLED'
          }
        ]
      }
      try {
      const replaced = await api.put(
        `/cost/model-versions/${modelVersionId}/components`,
        probePayload
      )
      caseRecord.checks.push({
        name: '成本构成项与来源规则可写入正式接口',
        passed: replaced?.code === 0,
        details: `code=${replaced?.code} msg=${replaced?.msg || replaced?.message || ''}`
      })
      const reloaded = await api.getBusiness(
        `/cost/model-versions/${modelVersionId}/components`
      )
      const reloadedItem = (reloaded?.data?.items || []).find((row) => row.code === probeCode)
      const reloadedRule = (reloaded?.data?.sourceRules || [])[0]
      caseRecord.checks.push({
        name: '业务方向/金额口径/日期依据/报表归属/经营利润标志往返不丢失',
        passed:
          Boolean(reloadedItem) &&
          reloadedItem.businessDirection === 'EXPENSE' &&
          reloadedItem.amountBasis === '审核金额' &&
          reloadedItem.dateBasis === '审核日期' &&
          reloadedItem.reportScope === '管理费用' &&
          reloadedItem.affectOperatingProfit === true &&
          reloadedItem.reconciliationSourceType === 'ERP_EXPENSE_REPORT',
        details: JSON.stringify({
          businessDirection: reloadedItem?.businessDirection,
          amountBasis: reloadedItem?.amountBasis,
          dateBasis: reloadedItem?.dateBasis,
          reportScope: reloadedItem?.reportScope,
          affectOperatingProfit: reloadedItem?.affectOperatingProfit,
          reconciliationSourceType: reloadedItem?.reconciliationSourceType
        })
      })
      caseRecord.checks.push({
        name: '来源规则随构成项一并保存',
        passed: Boolean(reloadedRule) && reloadedRule.sourceType === 'SRC-EXPENSE',
        details: JSON.stringify(reloadedRule || {})
      })
      const locked = await createLockedCostModelFixture({
        api, record, caseRecord, remark: costFixtureRemark(caseRecord.fixtures.cost)
      })
      const rejected = await api.put(`/cost/model-versions/${locked.id}/components`, probePayload)
      const lockedConfiguration = responseData(
        await api.getBusiness(`/cost/model-versions/${locked.id}/components`)
      )
      caseRecord.checks.push({
        name: '锁定成本模型拒绝构成项与来源规则写入，原配置不改变',
        passed: rejected?.code === 422001 &&
          String(rejected.msg || '').includes('locked model configuration cannot be changed') &&
          lockedConfiguration.categories.length === 0 &&
          lockedConfiguration.items.length === 0 && lockedConfiguration.sourceRules.length === 0,
        details: `lockedModel=${locked.id} code=${rejected?.code}`
      })
      } finally {
        await restoreCostConfiguration({ api, modelVersionId, original, caseRecord })
      }
      await (dependencies.openRoute || openRoute)(page, '/cost-management')
      caseRecord.checks.push({
        name: '成本构成项页面路由可进入',
        passed: page.url().includes('/cost-management'),
        details: page.url()
      })
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'cost-component-formal-config', record)
    }
    caseRecord.evidence.push('成本构成项正式读写、方向口径字段往返与来源规则保存')
  }

  if (caseId === 'COST-031') {
    // PB-076：经营收支项目落正式 cost_component_item，固定收入/支出根分类，取数范围走 scope_json。
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const draftModel = ownedCostFixture.model
    if (draftModel) {
      const modelVersionId = String(draftModel.id)
      const original = ownedCostFixture.config
      const nonOperatingCategories = (original.categories || []).filter(
        (row) => row.code !== 'OP-INC-ROOT' && row.code !== 'OP-EXP-ROOT'
      )
      const nonOperatingItems = (original.items || []).filter(
        (row) => row.businessDirection !== 'REVENUE' && row.businessDirection !== 'EXPENSE'
      )
      const keepItemIds = new Set(nonOperatingItems.map((row) => row.id))
      const nonOperatingRules = (original.sourceRules || []).filter((rule) =>
        keepItemIds.has(rule.componentItemId)
      )
      const probeCode = `E2E-OP-${suffix}`
      const scope = ['已审核费用报销单', '不含税金额']
      const payload = {
        categories: [
          ...nonOperatingCategories,
          { id: 'OP-INC-ROOT', parentId: '', code: 'OP-INC-ROOT', name: '经营收入', sortNo: 800, status: 'ENABLED' },
          { id: 'OP-EXP-ROOT', parentId: '', code: 'OP-EXP-ROOT', name: '经营支出', sortNo: 810, status: 'ENABLED' }
        ],
        items: [
          ...nonOperatingItems,
          {
            id: probeCode,
            categoryId: 'OP-EXP-ROOT',
            code: probeCode,
            name: 'E2E 管理费用',
            inclusionRate: 100,
            fetchMode: 'AUTO',
            resultScope: 'OPERATING_EXPENSE',
            businessDirection: 'EXPENSE',
            amountBasis: '审核金额',
            dateBasis: '审核日期',
            reportScope: '管理费用',
            affectOperatingProfit: true,
            scopeJson: JSON.stringify(scope),
            systemItem: false,
            participateWip: false,
            status: 'ENABLED',
            remark: 'PB-076 E2E probe'
          }
        ],
        sourceRules: [
          ...nonOperatingRules,
          { id: `${probeCode}-P`, componentItemId: probeCode, sourceType: '费用报销单', sourcePriority: 1, status: 'ENABLED' },
          { id: `${probeCode}-C1`, componentItemId: probeCode, sourceType: '应付账款', sourcePriority: 2, status: 'ENABLED' }
        ]
      }
      try {
      const replaced = await api.put(
        `/cost/model-versions/${modelVersionId}/components`,
        payload
      )
      caseRecord.checks.push({
        name: '经营收支项目可写入本案专属 E2E 成本构成模型',
        passed: replaced?.code === 0,
        details: `code=${replaced?.code} msg=${replaced?.msg || replaced?.message || ''}`
      })
      const reloaded = await api.getBusiness(
        `/cost/model-versions/${modelVersionId}/components`
      )
      const probe = (reloaded?.data?.items || []).find((row) => row.code === probeCode)
      caseRecord.checks.push({
        name: '经营收支方向/报表归属/经营利润标志往返不丢失',
        passed:
          Boolean(probe) &&
          probe.businessDirection === 'EXPENSE' &&
          probe.reportScope === '管理费用' &&
          probe.affectOperatingProfit === true,
        details: JSON.stringify({
          businessDirection: probe?.businessDirection,
          reportScope: probe?.reportScope,
          affectOperatingProfit: probe?.affectOperatingProfit
        })
      })
      caseRecord.checks.push({
        name: '取数范围经 scope_json 往返不丢失',
        passed:
          Boolean(probe?.scopeJson) &&
          JSON.stringify(JSON.parse(probe.scopeJson)) === JSON.stringify(scope),
        details: probe?.scopeJson || 'missing'
      })
      const probeRules = (reloaded?.data?.sourceRules || []).filter(
        (rule) => rule.componentItemId === probe?.id
      )
      caseRecord.checks.push({
        name: '主来源与核对来源按优先级保存为来源规则',
        passed:
          probeRules.length === 2 &&
          probeRules.some((rule) => rule.sourceType === '费用报销单' && rule.sourcePriority === 1) &&
          probeRules.some((rule) => rule.sourceType === '应付账款' && rule.sourcePriority === 2),
        details: probeRules.map((rule) => `${rule.sourceType}#${rule.sourcePriority}`).join(',')
      })
      const originalNonOperating = {
        categories: nonOperatingCategories, items: nonOperatingItems, sourceRules: nonOperatingRules
      }
      const originalCodes = new Set(nonOperatingItems.map((item) => item.code))
      const retainedItems = reloaded.data.items.filter((item) => originalCodes.has(item.code))
      const retainedIds = new Set(retainedItems.map((item) => item.id))
      const retainedConfiguration = {
        categories: reloaded.data.categories.filter((category) =>
          nonOperatingCategories.some((originalCategory) => originalCategory.code === category.code)),
        items: retainedItems,
        sourceRules: reloaded.data.sourceRules.filter((rule) => retainedIds.has(rule.componentItemId))
      }
      caseRecord.checks.push({
        name: '经营配置固定收入支出根分类，并保留既有成本构成项及取数规则业务值',
        passed: reloaded.data.categories.some((category) => category.code === 'OP-INC-ROOT') &&
          reloaded.data.categories.some((category) => category.code === 'OP-EXP-ROOT') &&
          costConfigurationSignature(retainedConfiguration) === costConfigurationSignature(originalNonOperating),
        details: `retainedItems=${retainedItems.length} originalItems=${nonOperatingItems.length}`
      })
      if (!isCostFixtureId(String(probe?.id))) throw new Error('经营探针未返回精确构成项 ID')
      const snapshot = await (dependencies.runReadOnlySql || runReadOnlySql)(`
        SELECT COUNT(*) FROM cost_component_item i
        JOIN cost_component_category c ON c.id=i.category_id
          AND c.tenant_id=i.tenant_id AND c.model_version_id=i.model_version_id
        WHERE i.tenant_id=1 AND i.model_version_id=${modelVersionId}
          AND i.id=${probe.id} AND i.deleted=0 AND c.deleted=0
          AND c.category_code='OP-EXP-ROOT'
          AND EXISTS (SELECT 1 FROM cost_component_category r
            WHERE r.tenant_id=1 AND r.model_version_id=${modelVersionId}
              AND r.category_code='OP-INC-ROOT' AND r.deleted=0)
      `)
      caseRecord.database = [...(caseRecord.database || []), { stage: 'operating-probe', ...snapshot }]
      const persisted = snapshot.available && snapshot.rows.length === 1 && snapshot.rows[0][0] === '1'
      caseRecord.checks.push({
        name: 'COST-031 经营项目及固定收入支出根分类在专属模型正式共享构成表精确落库',
        passed: persisted, details: `model=${modelVersionId}; item=${probe.id}; rows=${JSON.stringify(snapshot.rows)}`
      })
      if (!persisted) throw new Error('经营探针共享构成表与根分类落库未证实')
      for (let iteration = 1; iteration <= 2; iteration++) {
        const repeated = responseData(await api.putBusiness(
          `/cost/model-versions/${modelVersionId}/components`,
          payload
        ))
        caseRecord.checks.push({
          name: `同编码经营配置第 ${iteration} 次重复保存成功且业务值保持一致`,
          passed: costConfigurationSignature(repeated) === costConfigurationSignature(reloaded.data),
          details: `model=${modelVersionId} iteration=${iteration}`
        })
      }
      } finally {
        await restoreCostConfiguration({ api, modelVersionId, original, caseRecord })
      }
      await (dependencies.openRoute || openRoute)(page, '/cost-management')
      caseRecord.checks.push({
        name: '收入与支出配置页面路由可进入',
        passed: page.url().includes('/cost-management'),
        details: page.url()
      })
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'cost-operating-formal-config', record)
    }
    caseRecord.evidence.push('经营收支项目正式落库、方向与取数范围往返、来源规则优先级')
  }

  if (caseId === 'COST-032') {
    // PB-074：工时/机器时/面积/产量等受控分摊因子，因子必须来自正式快照或人工确认。
    const draftModel = ownedCostFixture.model
    const center = ownedCostFixture.center
    const componentItemId = ownedCostFixture.componentItem.id
    if (draftModel?.id && center && componentItemId) {
      const basePayload = {
        modelVersionId: String(draftModel.id),
        costCenterId: String(center.id),
        effectiveMonth: COST_CASE_EFFECTIVE_MONTH,
        status: 'DRAFT'
      }
      for (const allocationMode of ['LABOR_HOUR', 'MACHINE_HOUR', 'AREA', 'OUTPUT']) {
      const missingSource = await api.put('/cost/allocation-rules', {
        ...basePayload,
        lines: [
          {
            componentItemId: String(componentItemId),
            finishedRatio: 100,
            wipRatio: 0,
            allocationMode
          }
        ]
      }, { expectedBusinessRejection: {
        code: 422001, message: 'factor source must be SNAPSHOT or MANUAL for factor allocation'
      } })
      caseRecord.checks.push({
        name: `${allocationMode} 因子缺少来源时被拒绝`,
        passed:
          missingSource?.code === 422001 &&
          (missingSource?.msg || missingSource?.message) ===
            'factor source must be SNAPSHOT or MANUAL for factor allocation',
        details: `code=${missingSource?.code} msg=${missingSource?.msg || missingSource?.message || ''}`
      })
      }
      const unknownMode = await api.put('/cost/allocation-rules', {
        ...basePayload,
        lines: [
          {
            componentItemId: String(componentItemId),
            finishedRatio: 100,
            wipRatio: 0,
            allocationMode: 'UNKNOWN_FACTOR'
          }
        ]
      }, { expectedBusinessRejection: { code: 422001, message: 'unsupported allocation mode' } })
      caseRecord.checks.push({
        name: '未知分摊模式被拒绝',
        passed:
          unknownMode?.code === 422001 &&
          (unknownMode?.msg || unknownMode?.message) === 'unsupported allocation mode',
        details: `code=${unknownMode?.code} msg=${unknownMode?.msg || unknownMode?.message || ''}`
      })
      // 使用远期月份写入数量模式规则，确认原有模式未回归且不影响真实期间。
      const fallback = await api.put('/cost/allocation-rules', {
        ...basePayload,
        lines: [
          {
            componentItemId: String(componentItemId),
            finishedRatio: 100,
            wipRatio: 0,
            allocationMode: 'QUANTITY'
          }
        ]
      })
      caseRecord.checks.push({
        name: '原有数量分摊模式仍可写入',
        passed: fallback?.code === 0,
        details: `code=${fallback?.code} msg=${fallback?.msg || fallback?.message || ''}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在草稿模型/启用成本中心/构成项以校验分摊因子',
        passed: false,
        details: `model=${draftModel?.id || '-'} center=${center?.id || '-'} item=${componentItemId || '-'}`
      })
    }
    await (dependencies.openRoute || openRoute)(page, '/cost-management')
    caseRecord.checks.push({
      name: '分摊规则页面路由可进入',
      passed: page.url().includes('/cost-management'),
      details: page.url()
    })
    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'cost-allocation-factor', record)
    caseRecord.evidence.push('受控分摊因子校验、未知模式拒绝与原有模式回归')
  }

  if (caseId === 'COST-033') {
    // PB-075：期初在制导入按模板行返回逐行错误定位。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const accountingPeriod = (periodsResult?.data?.list || []).find(
      (item) => item.status === 'ACCOUNTING'
    )
    if (!accountingPeriod?.id) {
      caseRecord.checks.push({
        name: '存在核算中成本期间以校验逐行错误定位',
        passed: false,
        details: '当前核算组织没有 ACCOUNTING 状态成本期间'
      })
    } else {
      // 服务层按模板行校验：合法行引用真实启用存货档案，非法行留空编码触发定位错误。
      const validRow = {
        stage: 'OPENING',
        objectKey: 'E2E-WIP-OK',
        materialId: '',
        productCode: 'ERP-RM-001',
        quantity: 1,
        materialAmount: 10,
        laborAmount: 0,
        expenseAmount: 0,
        totalAmount: 10,
        unitCost: 10,
        sourceType: 'MANUAL'
      }
      const badRow = { ...validRow, objectKey: 'E2E-WIP-ROW', productCode: '' }
      const rejected = await api.put(
        `/cost/periods/${accountingPeriod.id}/opening-wip?stage=OPENING`,
        [badRow]
      )
      caseRecord.checks.push({
        name: '期初在制非法行按模板行号返回错误',
        passed:
          rejected?.code !== 0 &&
          String(rejected?.msg || rejected?.message || '').includes('第2行'),
        details: `code=${rejected?.code} msg=${rejected?.msg || rejected?.message || ''}`
      })
      const secondRowBatch = await api.put(
        `/cost/periods/${accountingPeriod.id}/opening-wip?stage=OPENING`,
        [
          validRow,
          { ...validRow, objectKey: 'E2E-WIP-BAD', productCode: '' }
        ]
      )
      caseRecord.checks.push({
        name: '多行批次错误定位到具体出错行',
        passed:
          secondRowBatch?.code !== 0 &&
          String(secondRowBatch?.msg || secondRowBatch?.message || '').includes('第3行'),
        details: `code=${secondRowBatch?.code} msg=${secondRowBatch?.msg || secondRowBatch?.message || ''}`
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '期初在制页面路由可进入',
      passed: page.url().includes('/cost-management'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'cost-opening-wip-row-error', record)
    caseRecord.evidence.push('期初在制逐行错误定位与多行批次错误行号')
  }

  if (ownedCostFixture) {
    await (dependencies.recordCostDatabase || recordCostDatabase)({
      modelVersionId: ownedCostFixture.model.id, caseRecord
    })
  }
  caseRecord.evidence.push('真实成本模型、期间与截图证据')
  return { token, api }
}

export const runCase = async (context, dependencies = {}) => {
  try {
    if (['COST-001', 'COST-007'].includes(context.caseId) &&
        typeof context.page?.on === 'function') {
      return await verifyCostSharedWorkspaceBoundary({
        page: context.page,
        caseRecord: context.caseRecord,
        operation: () => runCostCase(context, dependencies),
        dependencies: dependencies.sharedWorkspaceDependencies || {}
      })
    }
    return await runCostCase(context, dependencies)
  } catch (error) {
    context.caseRecord.checks.push({
      name: '成本用例执行异常，catalog 验收不得通过',
      passed: false,
      details: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    try {
      if (context.caseId === 'COST-029' && context.caseRecord.fixtures?.costDepartment) {
        try {
          const token = await (dependencies.login || login)(context.page)
          const api = (dependencies.createApiClient || createApiClient)({ token, record: context.record })
          await cleanupDedicatedCostDepartment({ api, caseRecord: context.caseRecord })
        } catch (error) {
          const closure = context.caseRecord.costCenterPermissionClosure
          if (closure) {
            closure.complete = false
            closure.status = 'FAILED'
            closure.residuals.push({
              step: 'departmentCleanup', department: context.caseRecord.fixtures.costDepartment,
              reason: error.message
            })
          }
          context.caseRecord.checks.push({
            name: 'COST-029 专属部门清理失败保留准确残留台账',
            passed: false, details: error.message
          })
          throw error
        }
      }
    } finally {
      costCatalogEvidence(context.caseId, context.caseRecord)
    }
  }
}

export async function teardownRun ({ record, token = runTokens.get(record.runId) }) {
  if (!token) return
  if (config.target !== 'local' || config.tenantId !== '1' ||
      String(record.environment?.tenantId) !== '1') {
    throw new Error('成本整轮清理仅允许 local tenant1')
  }
  const api = createApiClient({ token, record })
  const fixtures = new Map()
  for (const entry of record.cases) {
    for (const fixture of [
      entry.fixtures?.cost, entry.fixtures?.costScenario, entry.fixtures?.costUnpublishedScenario
    ]) {
      if (!fixture?.departmentId) continue
      if (fixture.runId !== record.runId || fixture.tenantId !== '1') {
        throw new Error('成本清理夹具不属于本轮租户')
      }
      const modelId = fixture.modelVersionId || fixture.modelId
      const marker = fixture.remark || costFixtureRemark(fixture)
      fixtures.set(fixture.departmentId, { ...fixture, modelId, marker, entry })
    }
  }
  const errors = []
  for (const fixture of fixtures.values()) {
    try {
      for (const reviewerKey of ['reviewer', 'approvalReviewer']) {
        try {
          await cleanupCostScenarioReviewer({ api, fixture, key: reviewerKey })
        } catch (error) {
          errors.push(new Error(`${fixture.departmentId}/${reviewerKey}: ${error.message}`))
        }
      }
      const model = fixture.modelId
        ? responseData(await api.getBusiness(`/cost/model-versions/${fixture.modelId}`))
        : null
      if (model && (String(model.id) !== fixture.modelId || model.remark !== fixture.marker ||
          String(model.accountingOrgId) !== '1')) {
        throw new Error('专属成本模型清理所有权不符')
      }
      const center = fixture.costCenterId
        ? responseData(await api.getBusiness(`/cost/centers/${fixture.costCenterId}`))
        : null
      if (center) {
        if (String(center.id) !== fixture.costCenterId || center.remark !== fixture.marker ||
            String(center.accountingOrgId) !== '1' ||
            center.departmentIds.map(String).join() !== fixture.departmentId) {
          throw new Error('专属成本中心清理所有权不符')
        }
        if (center.status === 'ENABLED') {
          await api.postBusiness(`/cost/centers/${fixture.costCenterId}/deactivate`, {
            disabledAt: `${fixture.effectiveMonth || fixture.month}-28`, reason: fixture.marker
          })
        }
        const after = responseData(await api.getBusiness(`/cost/centers/${fixture.costCenterId}`))
        if (after.status !== 'DISABLED' || after.remark !== fixture.marker) {
          throw new Error('专属成本中心未正式停用')
        }
      }
      const department = responseData(await api.getBusiness(`/system/dept/get?id=${fixture.departmentId}`))
      const suffix = fixture.suffix || fixture.fixtureId?.split('-').at(-1)
      if (String(department?.id) !== fixture.departmentId ||
          !suffix || !department.name.endsWith(suffix) ||
          !department.code.endsWith(suffix)) {
        throw new Error('专属部门清理所有权不符')
      }
      await api.deleteBusiness(`/system/dept/delete?id=${fixture.departmentId}`)
      let removed = null
      for (let attempt = 0; attempt < 5; attempt++) {
        removed = responseData(await api.getBusiness(`/system/dept/get?id=${fixture.departmentId}`))
        const softDeleted = removed != null && isSoftDeletedValue(removed.deleted)
        if (removed == null || softDeleted) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      let softDeleted = removed != null && isSoftDeletedValue(removed.deleted)
      if (removed != null && !softDeleted) {
        const databaseEvidence = await runReadOnlySql(`
          SELECT CAST(tenant_id AS CHAR), CAST(id AS CHAR), name, code, deleted
          FROM system_dept
          WHERE tenant_id=1 AND id=${fixture.departmentId}
        `)
        const row = databaseEvidence.rows?.[0]
        softDeleted = databaseEvidence.available &&
          row?.[0] === '1' &&
          row?.[1] === fixture.departmentId &&
          row?.[2] === department.name &&
          row?.[3] === department.code &&
          isSoftDeletedValue(row?.[4])
        fixture.entry.database = [...(fixture.entry.database || []), {
          stage: 'cost-department-cleanup',
          ...databaseEvidence
        }]
      }
      if (removed != null && !softDeleted) throw new Error('专属成本部门删除后仍可见')
      fixture.entry.notes.push(
        `整轮清理：center=${fixture.costCenterId || '-'} 已停用，department=${fixture.departmentId} 已删除；` +
        `model=${fixture.modelId || '-'}、期间、正式规则/来源/发布事实无删除 API，保留专属审计；` +
        `部门软删除证据=${removed == null ? 'API不可见' : softDeleted ? 'API/只读数据库确认' : '未确认'}`
      )
    } catch (error) {
      errors.push(new Error(`${fixture.departmentId}: ${error.message}`))
    }
  }
  runTokens.delete(record.runId)
  if (errors.length) throw new AggregateError(errors,
    `成本整轮清理失败：${errors.map((error) => error.message).join('; ')}`)
}
