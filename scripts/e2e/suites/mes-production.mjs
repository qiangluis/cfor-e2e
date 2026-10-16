import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { config } from '../config/index.mjs'
import { ExecutionWorkflowFixture } from '../fixtures/mes-execution-write.mjs'
import { collectMesProductionWmsEvidence } from '../fixtures/mes-production-wms-evidence.mjs'
import {
  MES_SALES_SELECTION_CHECK,
  assertMesSalesSelectionScope,
  isMesSalesSelectionEvidenceVerified,
  runMesSalesSelectionClosure
} from '../fixtures/mes-sales-selection-closure.mjs'
import { approveOwnedSalesProcess } from './erp-sales.mjs'
import {
  createFailedDetailAndAudit,
  dataOf as unwrap,
  rowsOf
} from '../fixtures/mes-quality-write.mjs'

export const cases = [
  'MES-PROD-001',
  'MES-PROD-002',
  'MES-PROD-003',
  'MES-PROD-004',
  'MES-PROD-005',
  'MES-PROD-006',
  'MES-PROD-007'
]

const BIZ_STATUS_NAMES = Object.freeze({
  DRAFT: '草稿',
  PENDING_APPROVAL: '待审批',
  APPROVED: '已审批',
  ISSUED: '已下达',
  IN_PRODUCTION: '执行中',
  PARTIALLY_COMPLETED: '部分完工',
  COMPLETED: '已完工',
  CLOSED: '已关闭',
  CANCELLED: '已取消'
})
const BIZ_STATUSES = new Set(Object.keys(BIZ_STATUS_NAMES))

const RELEASE_GATE_CODES = new Set(['BOM', 'MATERIAL'])
const CLOSE_CHECK_ITEMS = new Set(['PROCESS', 'MATERIAL', 'QUALITY', 'COST'])
const productionCatalog = JSON.parse(fs.readFileSync(
  new URL('../cases/catalog.json', import.meta.url), 'utf8'
))
const productionEvidenceBindings = Object.freeze({
  'MES-PROD-001': [
    { gap: '未执行或未完成 MES-PROD-001 专属销售订单选单闭环；未以旧的直接生产单证据替代来源单证据。' },
    ['专属生产订单审核后拆分出唯一工单'],
    ['专属工单排产生成唯一专属任务'],
    ['未配工艺排产被拒绝且不产生孤立任务', '未配置班组时预排产被正式阻断']
  ],
  'MES-PROD-002': [
    { gap: '本轮验证了 BOM 投料预览，但尚未配置并回读物料级领料方式，不能以预览代替领料方式配置。' },
    ['生产领料单经 WMS 正式审核并保留来源与明细'],
    { gap: '当前正式投料服务返回业务阻断，不创建 BPM 缺料流程实例；本轮不伪造 BPM 实例。' },
    { gap: '缺料时正式报工前置会被阻断，但当前后端没有在 start API 上执行缺料门禁。' },
    ['重复生成生产领料单被正式拒绝且不新增单据', '重复投料超过已领未投余额被正式拒绝']
  ],
  'MES-PROD-005': [
    ['生产订单列表每行返回九状态编码'],
    ['生产订单中文状态名称与九状态枚举逐项一致'],
    ['暂停标记是执行中的附加布尔标记，而不是独立状态列']
  ],
  'MES-PROD-006': [
    ['专属生产订单下达门禁预检返回唯一 BOM 与物料齐套明细'],
    ['下达门禁两项均返回布尔结论与缺项说明'],
    ['不存在的生产订单下达门禁预检被精确拒绝']
  ],
  'MES-PROD-003': [
    ['合格+不合格=报工数量'],
    { gap: '源码复核：报工/质检后端没有调用 MesAndonRecordService.createRecord 的自动建安灯链路；本次只验证显式 QUALITY 来源安灯生命周期。' },
    { gap: '源码复核：安灯正式状态只有 ACTIVE -> HANDLING -> HANDLED，生产订单结案检查未发现读取安灯状态的门禁；正式 close/reopen API 不存在。' },
      { gap: '源码复核：普通报工工艺路线的 isQuality=0，当前专属 fixture 没有正式柔性节点/事件配置，不能把普通报工冒充过程检柔性事件。' },
      ['不合格报工原因与任务/工单关联可回读']
  ],
  'MES-PROD-004': [
    ['过程检不合格时必检门禁阻断报工审核与完工流转',
      '不合格过程检审核报工被正式拒绝',
      '不合格过程检工单完工被正式拒绝且状态未变'],
    ['过程检放行后生成104成品入库并回读来源'],
    ['WMS 收货后正式开始/预留/确认/完成并迁移库存'],
    ['工单 stockedNum 和实际交期回写', '工单完工状态切换保留入库实际交期']
  ],
  'MES-PROD-007': [
    ['专属生产订单结案检查清单包含四项门禁且不重复'],
    ['专属结案结论与人工放行清单口径一致'],
    ['成本项未通过且明确要求人工放行'],
    ['不存在的生产订单结案请求被明确拒绝']
  ]
})

export const isMesSalesSelectionDispatchEnabled = (settings = config, env = process.env) => {
  try {
    assertMesSalesSelectionScope(settings, env)
    return true
  } catch { return false }
}

export const productionEvidenceBindingsFor = (caseId, caseRecord) => {
  const bindings = productionEvidenceBindings[caseId]?.map((binding) =>
    Array.isArray(binding) ? [...binding] : { ...binding }
  )
  if (!bindings || caseId !== 'MES-PROD-001') return bindings
  if (caseRecord.mesSalesSelectionDispatchedVerified === true &&
      isMesSalesSelectionEvidenceVerified(caseRecord)) {
    bindings[0] = [MES_SALES_SELECTION_CHECK]
  } else {
    const reason = caseRecord.mesSalesSelectionClosure?.gaps?.map((item) => item.detail).filter(Boolean)
      .join('; ')
    bindings[0] = {
      gap: reason
        ? `专属销售订单选单闭环未验证：${reason}`
        : '未执行或未完成 MES-PROD-001 专属销售订单选单闭环；未以旧的直接生产单证据替代来源单证据。'
    }
  }
  return bindings
}

export const dispatchProductionSalesSelection = async (context, dependencies = {}) => {
  if (context.caseId !== 'MES-PROD-001') return null
  context.caseRecord.mesSalesSelectionDispatchedVerified = false
  const settings = dependencies.config || config
  const env = dependencies.env || process.env
  if (!isMesSalesSelectionDispatchEnabled(settings, env)) {
    context.caseRecord.notes ||= []
    context.caseRecord.notes.push(
      '销售订单选单专属夹具未启用：需 local tenant1、CFOR_E2E_WRITE_FIXTURES=true 和 CFOR_E2E_MES_SALES_SELECTION=true'
    )
    return null
  }
  const result = await (dependencies.runMesSalesSelectionClosure || runMesSalesSelectionClosure)(context, {
    approveSalesOrder: async ({ source }) => {
      await (dependencies.approveOwnedSalesProcess || approveOwnedSalesProcess)({
        ...context, processId: source.processInstanceId || source.bpmiInstanceId
      })
    },
    ...(dependencies.mesSalesSelectionDependencies || {}),
    settings,
    env
  })
  context.caseRecord.mesSalesSelectionDispatchedVerified =
    result?.salesSelectionVerified === true && isMesSalesSelectionEvidenceVerified(context.caseRecord)
  return result
}

export const finalizeProductionCatalogEvidence = (caseRecord, caseId) => {
  const bindings = productionEvidenceBindingsFor(caseId, caseRecord)
  if (!bindings) return false
  const definition = productionCatalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === caseId)
  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => {
    const binding = bindings[index]
    if (binding?.gap) {
      return {
        index, assertion, evidenceChecks: [],
        status: 'GAP',
        details: binding.gap
      }
    }
    const names = binding || []
    const matches = names.map((name) => caseRecord.checks.filter((check) => check.name === name))
    return {
      index, assertion, evidenceChecks: names,
      status: names.length > 0 && matches.every((items) =>
        items.length === 1 && items[0].passed === true) ? 'VERIFIED' : 'GAP',
      details: matches.map((items, position) => items.length === 1
        ? `${names[position]}: ${items[0].details}`
        : `${names[position]}: missing or duplicate evidence${
          names[position] === 'WMS 收货后正式开始/预留/确认/完成并迁移库存'
            ? '; required closure includes pendingPutawayQty=0 and completed PUTAWAY inventory transfer'
            : ''}`).join('; ')
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED')
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((item) => item.passed === true)
  return caseRecord.passCandidate
}

export const productionStatusChecks = (rows) => ({
  codes: rows.length > 0 && rows.every((row) => BIZ_STATUSES.has(row?.bizStatus)),
  names: rows.length > 0 && rows.every((row) =>
    BIZ_STATUSES.has(row?.bizStatus) && row.bizStatusName === BIZ_STATUS_NAMES[row.bizStatus]),
  paused: rows.length > 0 && rows.every((row) => typeof row?.paused === 'boolean')
})

export const productionReleaseGateChecks = (gate, orderId) => {
  const items = Array.isArray(gate?.items) ? gate.items : []
  const structure = String(gate?.prodOrderId) === orderId &&
    typeof gate?.enabled === 'boolean' && typeof gate?.passed === 'boolean' &&
    items.length === 2 && items.every((item) => RELEASE_GATE_CODES.has(item?.code)) &&
    new Set(items.map((item) => item.code)).size === 2
  return {
    structure,
    details: structure && items.every((item) =>
      typeof item.passed === 'boolean' && typeof item.message === 'string' &&
      item.message.trim().length > 0)
  }
}

export const productionCloseChecks = (gate, orderId) => {
  const items = Array.isArray(gate?.items) ? gate.items : []
  const overrides = Array.isArray(gate?.overrideRequiredItems) ? gate.overrideRequiredItems : []
  const structure = String(gate?.prodOrderId) === orderId && items.length === 4 &&
    new Set(items.map((item) => item?.item)).size === 4 &&
    items.every((item) => CLOSE_CHECK_ITEMS.has(item?.item) &&
      typeof item.itemName === 'string' && item.itemName.trim().length > 0 &&
      typeof item.passed === 'boolean' &&
      typeof item.message === 'string' && item.message.trim().length > 0)
  const failedItems = items.filter((item) => item?.passed === false)
    .map((item) => item.item).sort()
  const conclusion = structure && typeof gate.passed === 'boolean' &&
    typeof gate.closable === 'boolean' &&
    gate.passed === items.every((item) => item.passed) &&
    gate.closable === gate.passed && Array.isArray(gate.overrideRequiredItems) &&
    JSON.stringify([...overrides].sort()) === JSON.stringify(failedItems)
  const cost = items.find((item) => item?.item === 'COST')
  return {
    structure, conclusion,
    cost: structure && cost.passed === false && overrides.includes('COST') &&
      /FMS/.test(cost.message) && /人工.*放行/.test(cost.message)
  }
}

const missingOrderRejection = {
  code: 500,
  message: /未找到生产订单|单据未找到|生产订单不存在/,
  allowServiceCode: true
}

const workStateRejection = {
  code: 500,
  message: /工单|完工|报工|质检|入库|状态/,
  allowServiceCode: true
}
const feedNoStockRejection = {
  code: 400,
  message: /没有可分配库存|领料已满足|无需重复生成领料单/,
  allowServiceCode: true
}

export const productionPageRows = (result, label) => {
  const data = result?.data
  const rows = Array.isArray(data) ? data : data?.records ?? data?.list
  const total = data?.total == null ? rows?.length : Number(data.total)
  if (
    !isBusinessSuccess(result) ||
    !Array.isArray(rows) ||
    rows.length > 100 ||
    !Number.isSafeInteger(total) ||
    total < rows.length ||
    (rows.length === 0 && total !== 0) ||
    rows.some((row) => row?.id == null || String(row.id).trim() === '')
  ) {
    throw new Error(`${label} 分页响应无效，不能视为缺少正式单据`)
  }
  return rows
}

export const isMissingProductionWork = (result) => {
  if (result?.code !== 500) return false
  const message = String(result?.msg ?? result?.message ?? '')
  // Deployment errors cannot stand in for an explicit business rejection.
  return message === '工单不存在'
}

export const productionAndonId = (response) => {
  const value = unwrap(response, '安灯创建')
  assert((typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))) &&
    /^[1-9]\d*$/.test(String(value)), '正式安灯创建返回无效主键')
  return String(value)
}

export const assertProductionAndon = (row, expected, status) => {
  assert.equal(String(row?.id), expected.id, '安灯回读主键不匹配')
  assert.equal(String(row?.configId), expected.configId, '安灯回读配置不匹配')
  assert.equal(row?.source, 'QUALITY', '安灯回读创建来源不匹配')
  assert.equal(String(row?.workId), expected.workId, '安灯回读工单不属于本轮')
  assert.equal(String(row?.procedureId), expected.procedureId, '安灯回读工序不属于本轮')
  assert.equal(row?.remark, expected.marker, '安灯回读专属标记不匹配')
  assert.equal(row?.status, status, '安灯回读状态不匹配')
  return row
}

const mergeProductionFixtureEvidence = (caseRecord, fixtureRecord) => {
  for (const key of ['checks', 'notes', 'evidence', 'database', 'executionFixtures']) {
    caseRecord[key] = [...(caseRecord[key] || []), ...(fixtureRecord[key] || [])]
  }
}

/**
 * PB-303~PB-312 生产协同深化改造的前端自动化案例。
 *
 * MES-PROD-001~004 执行专属正式写侧并保留真实契约缺口，
 * MES-PROD-005~007 继续执行状态、下达和结案门禁回归。
 */
export const runCase = async (context, dependencies = {}) => {
  const { caseId, page, record, caseRecord, outputDir } = context
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'MES-PROD-001') {
    await dispatchProductionSalesSelection({ ...context, api }, dependencies)
    const fixture = new ExecutionWorkflowFixture(api, record, caseId, {
      withOpeningInventory: true
    })
    try {
      await fixture.setup(caseRecord)
      const work = fixture.works[0]
      const task = fixture.tasks[0]
      const taskReadback = (await api.getBusiness(
        `/mes/prodWorkTask/queryById?id=${encodeURIComponent(task.id)}`
      ))?.data
      caseRecord.checks.push({
        name: '专属生产订单审核后拆分出唯一工单',
        passed: fixture.order?.id != null && work?.prodOrderId === fixture.order.id &&
          taskReadback?.workTicketId === work.id && taskReadback?.remark === fixture.marker,
        details: JSON.stringify({
          order: fixture.order?.id,
          work: work?.id,
          task: task?.id,
          taskRemark: taskReadback?.remark
        })
      })
      caseRecord.checks.push({
        name: '专属工单排产生成唯一专属任务',
        passed: fixture.tasks.length === 1 &&
          String(fixture.tasks[0]?.workTicketId) === String(fixture.works[0]?.id) &&
          String(fixture.tasks[0]?.routing) === String(fixture.route.id),
        details: JSON.stringify({
          workId: fixture.works[0]?.id,
          taskId: fixture.tasks[0]?.id,
          routing: fixture.tasks[0]?.routing
        })
      })
      const negativeRecord = { checks: [], notes: [], evidence: [] }
      const negativeFixture = new ExecutionWorkflowFixture(api, negativeRecord, `${caseId}-NO-TEAM`, {
        withTeam: false,
        withOpeningInventory: true
      })
      try {
        await negativeFixture.setup(negativeRecord)
        caseRecord.checks.push({
          name: '未配工艺排产被拒绝且不产生孤立任务',
          passed: negativeFixture.missingRouteBlocked === true &&
            negativeFixture.tasks.length === 0,
          details: JSON.stringify(negativeFixture.fixtureRecord.missingRoute)
        })
        caseRecord.checks.push({
          name: '未配置班组时预排产被正式阻断',
          passed: negativeFixture.scheduleBlocked === true &&
            negativeFixture.tasks.length === 0 &&
            negativeRecord.checks.every((check) => check.passed === true),
          details: JSON.stringify({
            scheduleBlocked: negativeFixture.scheduleBlocked,
            taskCount: negativeFixture.tasks.length,
            negativeChecks: negativeRecord.checks
          })
        })
      } finally {
        await negativeFixture.cleanup(negativeRecord)
        mergeProductionFixtureEvidence(caseRecord, negativeRecord)
      }
      await openRoute(page, '/mes/produce/order', {
        readySelector: '.search-form input[placeholder="请输入计划单号"]'
      })
      await saveScreenshot(page, outputDir, 'mes-prod-order-workflow', record)
      caseRecord.evidence.push(
        `真实创建 ${fixture.marker} 专属生产订单、工单和任务，并用第二条无班组夹具验证预排产门禁；未修改共享业务数据`
      )
      const complete = finalizeProductionCatalogEvidence(caseRecord, caseId)
      if (complete) return {
        api, partial: false,
        note: '销售订单真实选单、生产单来源与明细 API/SQL、拆单、排产和无工艺/班组阻断原断言均已验证'
      }
      return {
        api,
        partial: true,
        note: caseRecord.remainingAssertions.map((item) => `${item.assertion}: ${item.details}`).join('; ')
      }
    } finally {
      await fixture.cleanup(caseRecord)
      finalizeProductionCatalogEvidence(caseRecord, caseId)
    }
  }

  if (caseId === 'MES-PROD-002') {
    const fixture = new ExecutionWorkflowFixture(api, record, caseId, {
      withFeed: true,
      withOpeningInventory: true
    })
    const noStockRecord = { checks: [], notes: [], evidence: [] }
    const noStockFixture = new ExecutionWorkflowFixture(api, noStockRecord, `${caseId}-NO-STOCK`, {
      withFeed: true,
      withOpeningInventory: true
    })
    try {
      await fixture.setup(caseRecord)
      await fixture.prepareFeed(caseRecord)
      await noStockFixture.setup(noStockRecord)
      const noStockMaterial = await noStockFixture.voidOpeningInventoryForShortage(noStockRecord)
      const noStock = await api.request(
        'POST',
        '/mes/prodWorkTask/generate-pick-bill',
        { taskId: noStockFixture.tasks[0].id },
        { expectedBusinessRejection: feedNoStockRejection }
      )
      caseRecord.checks.push({
        name: '无库存时生成生产领料单被正式拒绝',
        passed: noStockMaterial != null && Number(noStockMaterial.requiredQty) > 0 &&
          Number(noStockMaterial.stockQty) === 0 &&
          matchesExpectedBusinessRejection(noStock, feedNoStockRejection),
        details: JSON.stringify({
          taskId: noStockFixture.tasks[0].id,
          stockQty: noStockMaterial?.stockQty,
          code: noStock?.code,
          msg: noStock?.msg
        })
      })
      caseRecord.notes.push(
        '缺料 BPM：当前正式服务只返回无库存业务阻断，没有可用 BPM 实例创建 API；本轮保留 GAP。'
      )
      caseRecord.notes.push(
        '缺料开工：当前 start API 不执行投料门禁；正式报工前置会执行 /feed-status 阻断，本轮不把 start 误报为已覆盖。'
      )
      caseRecord.notes.push(
        '物料级领料方式仍需配置与回读，BOM 预览不等同于领料方式配置。'
      )
      await openRoute(page, '/mes/produce/work-order', {
        readySelector: '.search-form input[placeholder="请输入工单编号"]'
      })
      await saveScreenshot(page, outputDir, 'mes-prod-material-issue', record)
      caseRecord.evidence.push(
        `真实完成 ${fixture.marker} 预览、203 领料单、WMS 审核、投料记录、状态回读和重复拒绝；第二条无库存夹具 ${noStockFixture.marker} 命中正式缺料拒绝`
      )
      finalizeProductionCatalogEvidence(caseRecord, caseId)
      return {
        api,
        partial: true,
        note: '领料/WMS/投料/重复拒绝和无库存阻断已完成；物料级领料方式、缺料 BPM 与 start API 开工门禁仍保留 GAP'
      }
    } finally {
      await noStockFixture.cleanup(noStockRecord)
      mergeProductionFixtureEvidence(caseRecord, noStockRecord)
      await fixture.cleanup(caseRecord)
      finalizeProductionCatalogEvidence(caseRecord, caseId)
    }
  }

  if (caseId === 'MES-PROD-003') {
    const fixture = new ExecutionWorkflowFixture(api, record, caseId, {
      withOpeningInventory: true
    })
    try {
      await fixture.setup(caseRecord)
      await fixture.startWork()
      const report = await fixture.reportTask({
        qty: 2,
        qualifiedQty: 1,
        defectQty: 1
      })
      const reportNum = Number(report?.reportNum)
      const qualifiedNum = Number(report?.qualifiedNum ?? 0)
      const unqualifiedNum = Number(report?.unqualifiedNum ?? 0)
      caseRecord.checks.push({
        name: '合格+不合格=报工数量',
        passed: Number.isFinite(reportNum) &&
          Number.isFinite(qualifiedNum) &&
          Number.isFinite(unqualifiedNum) &&
          qualifiedNum + unqualifiedNum === reportNum &&
          reportNum === 2,
        details: JSON.stringify({
          reportId: report?.id,
          reportNum: report?.reportNum,
          qualifiedNum: report?.qualifiedNum,
          unqualifiedNum: report?.unqualifiedNum
        })
      })
      caseRecord.checks.push({
        name: '不合格报工原因与任务/工单关联可回读',
        passed: String(report?.workTaskId) === fixture.tasks[0].id &&
          String(report?.workTicketId) === fixture.works[0].id &&
          report?.disqualificationReason === `${fixture.marker} defect` &&
          report?.remark === fixture.marker,
        details: JSON.stringify({
          reportId: report?.id,
          workTaskId: report?.workTaskId,
          workTicketId: report?.workTicketId,
          disqualificationReason: report?.disqualificationReason,
          remark: report?.remark
        })
      })
      caseRecord.evidence.push(
        `真实开工 ${fixture.marker} 专属任务，通过 /mes/prodWorkReport/addByTaskId 写入并回读报工；合格数 1 + 不合格数 1 = 报工数 2`
      )

      const configResponse = await api.getBusiness(
        '/mes/andon-config/page?pageNo=1&pageSize=100&code=QUALITY_NG_PROCESS'
      )
      const configRows = productionPageRows(configResponse, '安灯配置')
      const andonConfig = configRows.find((item) =>
        item?.code === 'QUALITY_NG_PROCESS' &&
        item?.enabled !== false &&
        String(item?.enabled).toLowerCase() !== 'false' &&
        Number(item?.enabled) !== 0
      )
      if (!andonConfig?.id) {
        caseRecord.notes.push(
          'GAP: 当前租户没有启用的 QUALITY_NG_PROCESS 安灯配置，未伪造配置或安灯记录；显式安灯生命周期无法执行。'
        )
      } else {
        const andonCreateRequest = {
          configId: String(andonConfig.id),
          source: 'QUALITY',
          workId: fixture.works[0].id,
          procedureId: fixture.procedure.id,
          remark: fixture.marker
        }
        const created = await api.postBusiness('/mes/andon-record/create', andonCreateRequest)
        const andonId = productionAndonId(created)
        const expectedAndon = {
          id: andonId,
          configId: String(andonConfig.id),
          workId: fixture.works[0].id,
          procedureId: fixture.procedure.id,
          marker: fixture.marker
        }
        fixture.fixtureRecord.andon = {
          id: andonId,
          configId: String(andonConfig.id),
          source: 'QUALITY',
          cleanup: 'RETAINED_AUDIT_NO_DELETE_API'
        }
        caseRecord.andonEvidence = {
          create: { request: andonCreateRequest, response: created },
          transitions: []
        }
        const active = await api.getBusiness(
          `/mes/andon-record/get?id=${encodeURIComponent(andonId)}`
        )
        const activeRecord = assertProductionAndon(unwrap(active), expectedAndon, 'ACTIVE')
        caseRecord.andonEvidence.transitions.push({ stage: 'ACTIVE', response: activeRecord })
        const persisted = await runReadOnlySql(
          `SELECT id, tenant_id, source, work_id, procedure_id, status, remark, deleted+0
           FROM mes_andon_record WHERE tenant_id=1 AND id='${andonId}'`
        )
        caseRecord.database = [...(caseRecord.database || []), {
          stage: 'andon-create-committed', ...persisted
        }]
        assert(persisted.available && persisted.rows?.length === 1 &&
          JSON.stringify(persisted.rows[0]) === JSON.stringify([
            andonId, '1', 'QUALITY', expectedAndon.workId, expectedAndon.procedureId,
            'ACTIVE', fixture.marker, '0'
          ]), '安灯创建后未回读到本轮租户已提交事实，禁止继续响应')
        caseRecord.checks.push({
          name: '安灯正式 create 返回已提交 ACTIVE 记录',
          passed: true,
          details: JSON.stringify({
            id: activeRecord?.id,
            status: activeRecord?.status,
            source: activeRecord?.source,
            workId: activeRecord?.workId,
            procedureId: activeRecord?.procedureId
          })
        })
        caseRecord.andonEvidence.respondRequest = { id: andonId }
        caseRecord.andonEvidence.respondResponse =
          await api.putBusiness('/mes/andon-record/respond', { id: andonId })
        const handling = await api.getBusiness(
          `/mes/andon-record/get?id=${encodeURIComponent(andonId)}`
        )
        const handlingRecord = assertProductionAndon(unwrap(handling), expectedAndon, 'HANDLING')
        caseRecord.andonEvidence.transitions.push({ stage: 'HANDLING', response: handlingRecord })
        caseRecord.checks.push({
          name: '安灯响应后状态为 HANDLING',
          passed: handlingRecord?.status === 'HANDLING' &&
            String(handlingRecord?.id) === andonId,
          details: JSON.stringify({
            id: handlingRecord?.id,
            status: handlingRecord?.status,
            responderUserId: handlingRecord?.responderUserId
          })
        })
        await api.putBusiness('/mes/andon-record/handle', {
          id: andonId,
          handleRemark: `${fixture.marker} handle`
        })
        const handled = await api.getBusiness(
          `/mes/andon-record/get?id=${encodeURIComponent(andonId)}`
        )
        const handledRecord = assertProductionAndon(unwrap(handled), expectedAndon, 'HANDLED')
        caseRecord.andonEvidence.transitions.push({ stage: 'HANDLED', response: handledRecord })
        caseRecord.checks.push({
          name: '安灯处置后状态为 HANDLED 且保留处置说明',
          passed: handledRecord?.status === 'HANDLED' &&
            handledRecord?.handleRemark === `${fixture.marker} handle` &&
            String(handledRecord?.id) === andonId,
          details: JSON.stringify({
            id: handledRecord?.id,
            status: handledRecord?.status,
            handleRemark: handledRecord?.handleRemark,
            handleMinutes: handledRecord?.handleMinutes
          })
        })
        caseRecord.checks.push({
          name: '安灯正式 create/respond/handle 状态链路可回读',
          passed: caseRecord.andonEvidence.transitions.map((item) => item.stage).join(',') ===
            'ACTIVE,HANDLING,HANDLED',
          details: JSON.stringify(caseRecord.andonEvidence)
        })
        const duplicateHandle = await api.request(
          'PUT',
          '/mes/andon-record/handle',
          { id: andonId, handleRemark: `${fixture.marker} duplicate` },
          {
            expectedBusinessRejection: {
              code: 2010911003,
              message: /已处置，不允许再次修改/
            }
          }
        )
        caseRecord.checks.push({
          name: '已处置安灯重复处置被正式拒绝',
          passed: matchesExpectedBusinessRejection(duplicateHandle, {
            code: 2010911003,
            message: /已处置，不允许再次修改/
          }),
          details: JSON.stringify({
            code: duplicateHandle?.code,
            msg: duplicateHandle?.msg
          })
        })
        caseRecord.evidence.push(
          `真实调用安灯 ${andonId} 的 create -> ACTIVE、respond -> HANDLING、handle -> HANDLED；重复处置命中错误码 2010911003。安灯事实按后端设计保留，当前没有删除接口。`
        )
      }

      await openRoute(page, '/mes/produce/report')
      await saveScreenshot(page, outputDir, 'mes-prod-report-quality', record)
      await openRoute(page, '/mes/produce/andon')
      await saveScreenshot(page, outputDir, 'mes-prod-andon-lifecycle', record)
      caseRecord.evidence.push(
        '真实登录后打开报工和安灯页面，并以专属 marker 回读本次写入的业务记录。'
      )
      finalizeProductionCatalogEvidence(caseRecord, caseId)
      return {
        api,
        partial: true,
        note: '报工与显式安灯状态链路已完成；自动建安灯、安灯关闭门禁和柔性过程检仍按源码证据保留 GAP'
      }
    } finally {
      await fixture.cleanup(caseRecord)
      finalizeProductionCatalogEvidence(caseRecord, caseId)
    }
  }

  if (caseId === 'MES-PROD-004') {
    const fixture = new ExecutionWorkflowFixture(api, record, caseId, {
      withOpeningInventory: true,
      separateOpeningLocation: true,
      normalizeWmsOutputCleanup: true,
      withQuality: true
    })
    try {
      await fixture.setup(caseRecord)
      await fixture.startWork()
      const report = await fixture.reportTask({
        qty: 2,
        qualifiedQty: 2,
        defectQty: 0
      })
      const inspectionRows = productionPageRows(
        await api.getBusiness(
          `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100&type=300&srcBillId=${encodeURIComponent(fixture.reportIds[0])}`
        ),
        '自动过程检单'
      )
      let inspectionRow = inspectionRows.find((row) =>
        String(row?.srcBillId) === String(fixture.reportIds[0]) &&
        String(row?.type) === '300')
      if (!inspectionRow?.id && fixture.tasks[0]?.id) {
        // 正式任务来源质检单的主来源是任务，报工 ID 固化在 customField8。
        const taskInspectionRows = productionPageRows(
          await api.getBusiness(
            `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100&type=300&srcBillId=${encodeURIComponent(fixture.tasks[0].id)}`
          ),
          '任务来源自动过程检单'
        )
        inspectionRows.push(...taskInspectionRows)
        inspectionRow = taskInspectionRows.find((row) =>
          String(row?.srcBillId) === String(fixture.tasks[0].id) &&
          String(row?.customField8) === String(fixture.reportIds[0]) &&
          String(row?.type) === '300')
      }
      if (!inspectionRow?.id) {
        const source = await runReadOnlySql(
          `SELECT id, src_bill_type, src_bill_id, custom_field8, bill_stage, is_effective+0
           FROM mes_quality_inspection WHERE tenant_id=1 AND deleted=0 AND type='300'
             AND (src_bill_id IN ('${fixture.reportIds[0]}', '${fixture.tasks[0].id}')
               OR custom_field8='${fixture.reportIds[0]}')`
        )
        caseRecord.database = [...(caseRecord.database || []), {
          stage: 'process-quality-source-diagnostic', ...source
        }]
        caseRecord.productionQualityDiagnostic = {
          reportId: fixture.reportIds[0],
          taskId: fixture.tasks[0].id,
          reportEffective: report.isEffective,
          reportStage: report.billStage,
          reportSource: report.srcBillType,
          outputIds: fixture.outputIds,
          inspectionRows,
          source
        }
        caseRecord.checks.push({
          name: '质量工序报工未通过过程检不得提前生效或入库',
          passed: Number(report.isEffective) === 0 && fixture.outputIds.length === 0,
          details: JSON.stringify(caseRecord.productionQualityDiagnostic)
        })
        throw new Error('报工后未生成正式300过程检单；来源回读及报工生效/入库事实已记录')
      }
      const inspectionId = fixture.registerQualityInspection(inspectionRow.id, inspectionRow.billNo)
      const inspection = {
        // Automatically generated process inspections start in edit stage (14).
        // Use the formal edit-submit path before invoking the audit endpoint.
        action: 'save',
        inspectionId,
        detail: unwrap(await api.getBusiness(
          `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(inspectionId)}`
        ), '自动过程检单回读'),
        entries: rowsOf(await api.getBusiness(
          `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(inspectionId)}`
        ), '自动过程检明细回读'),
        items: rowsOf(await api.getBusiness(
          `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${encodeURIComponent(inspectionId)}`
        ), '自动过程检项目回读')
      }
      caseRecord.checks.push({
        name: '报工后自动过程检单及明细真实生成并关联来源',
        passed: inspection.detail?.type === '300' &&
          (
            String(inspection.detail?.srcBillId) === String(fixture.reportIds[0]) ||
            (
              String(inspection.detail?.srcBillId) === String(fixture.tasks[0].id) &&
              String(inspection.detail?.customField8) === String(fixture.reportIds[0])
            )
          ) &&
          inspection.entries.length === 1 &&
          inspection.items.length >= 1 &&
          (
            String(inspection.entries[0]?.srcBillId) === String(fixture.reportIds[0]) ||
            (
              String(inspection.entries[0]?.srcBillId) === String(fixture.tasks[0].id) &&
              String(inspection.entries[0]?.customField8) === String(fixture.reportIds[0])
            )
          ),
        details: JSON.stringify({
          inspectionId,
          srcBillId: inspection.detail?.srcBillId,
          customField8: inspection.detail?.customField8,
          entryCount: inspection.entries.length,
          itemCount: inspection.items.length,
          entrySrcBillId: inspection.entries[0]?.srcBillId,
          entryCustomField8: inspection.entries[0]?.customField8
        })
      })
      await createFailedDetailAndAudit(api, caseRecord, inspection, {
        detailId: inspection.items[0]?.id,
        itemId: inspection.items[0]?.itemId,
        itemName: inspection.items[0]?.itemName,
        itemType: inspection.items[0]?.itemType || '生产过程检验项目',
        quantity: 1,
        disqualificationReason: `${fixture.marker} required item failed`
      })
      const failedGate = unwrap(await api.getBusiness(
        `/mes/quality/qualityInspection/required-item-gate?id=${encodeURIComponent(inspectionId)}`
      ), '不合格过程检必检门禁')
      caseRecord.checks.push({
        name: '过程检不合格时必检门禁阻断报工审核与完工流转',
        passed: failedGate?.blocked === true && failedGate?.requiredItemFailed === true,
        details: JSON.stringify(failedGate)
      })
      const blockedReport = await api.request(
        'PUT',
        '/mes/prodWorkReport/check',
        {
          id: fixture.reportIds[0],
          approvalResultType: '1',
          approvalRemark: `${fixture.marker} blocked`
        },
        {
          expectedBusinessRejection: {
            code: 500,
            message: /关键必检项目未通过|禁止流转|完工入库/,
            allowServiceCode: true
          }
        }
      )
      caseRecord.checks.push({
        name: '不合格过程检审核报工被正式拒绝',
        passed: blockedReport?.code === 500 &&
          /关键必检项目未通过|禁止流转|完工入库/.test(
            String(blockedReport?.msg || blockedReport?.message || '')
          ),
        details: JSON.stringify({ code: blockedReport?.code, msg: blockedReport?.msg })
      })
      const finishRejection = {
        code: 500,
        message: /质检|质量|必检|禁止.*完工/,
        allowServiceCode: true
      }
      const blockedFinish = await api.request('POST', '/mes/prodWork/finish', {
        id: fixture.works[0].id
      }, { expectedBusinessRejection: finishRejection })
      const blockedWork = fixture.assertOwnedWork(unwrap(await api.getBusiness(
        `/mes/prodWork/queryById?id=${encodeURIComponent(fixture.works[0].id)}`
      ), '不合格过程检完工请求后工单回读'))
      const finishBlocked = matchesExpectedBusinessRejection(blockedFinish, finishRejection) &&
        Number(blockedWork.status) === 2
      caseRecord.checks.push({
        name: '不合格过程检工单完工被正式拒绝且状态未变',
        passed: finishBlocked,
        details: JSON.stringify({
          code: blockedFinish?.code, msg: blockedFinish?.msg,
          workId: blockedWork.id, status: blockedWork.status
        })
      })
      assert(finishBlocked, '不合格过程检未能阻断正式工单完工，停止后续放行验证')

      const recheckResponse = await api.postBusiness('/mes/quality/qualityInspection/recheck', {
        id: inspectionId
      })
      const recheckData = recheckResponse?.data ?? recheckResponse
      const recheckId = String(recheckData?.id || recheckData || '')
      if (!/^[1-9]\d*$/.test(recheckId)) {
        throw new Error(`过程检复检未返回有效主键：${JSON.stringify(recheckResponse)}`)
      }
      fixture.registerQualityInspection(recheckId, `recheck-${recheckId}`)
      const recheckDetail = unwrap(await api.getBusiness(
        `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(recheckId)}`
      ), '过程检复检回读')
      const recheckEntries = rowsOf(await api.getBusiness(
        `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(recheckId)}`
      ), '过程检复检明细回读')
      const recheckItems = rowsOf(await api.getBusiness(
        `/mes/quality/qualityInspection/queryMesQualityInspectionItemByMainId/dictText?id=${encodeURIComponent(recheckId)}`
      ), '过程检复检项目回读')
      const recheckEntry = recheckEntries[0]
      unwrap(await api.putBusiness('/mes/quality/qualityInspection/edit/submit', {
        ...recheckDetail,
        id: recheckId,
        type: '300',
        inspectionQty: 2,
        qty: 2,
        passQty: 2,
        concessionQty: 0,
        pendingJudgeQty: 0,
        inspectionResult: '全部合格',
        qualityInspectionEntryList: [{
          ...recheckEntry,
          inspectionQty: 2,
          qty: 2,
          passQty: 2,
          concessionQty: 0,
          pendingJudgeQty: 0,
          ngQty: 0,
          finalResult: '全部合格',
          inspectionConclusion: '全部合格'
        }],
        qualityInspectionItemList: recheckItems.map((item) => ({
          ...item,
          inspectionQty: 2,
          passQty: 2,
          ngQty: 0,
          inspectionResult: '1',
          finalInspectionResult: '1'
        }))
      }), '过程检复检放行编辑提交')
      const releasedInspection = unwrap(await api.getBusiness(
        `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(recheckId)}`
      ), '过程检复检提交后回读')
      // With the current NONE approval policy, edit/submit may already
      // complete the inspection and execute its output write-back.
      if (Number(releasedInspection?.isEffective) !== 1 ||
        !['34', 'END_OF_EXECUTION'].some((stage) =>
          String(releasedInspection?.billStage || '').includes(stage))) {
        unwrap(await api.putBusiness('/mes/quality/qualityInspection/check', {
          id: recheckId,
          approvalResultType: '1',
          approvalRemark: `${fixture.marker} quality release`
        }), '过程检复检审核放行')
      }
      // Register any automatic 104 output immediately so cleanup can void it
      // even when a later assertion fails.
      await fixture.captureProductionOutput(fixture.reportIds[0])
      const releasedGate = unwrap(await api.getBusiness(
        `/mes/quality/qualityInspection/required-item-gate?id=${encodeURIComponent(recheckId)}`
      ), '过程检复检放行门禁')
      caseRecord.checks.push({
        name: '过程检复检合格后必检门禁解除',
        passed: releasedGate?.blocked === false &&
          releasedGate?.requiredItemFailed === false,
        details: JSON.stringify(releasedGate)
      })
      // A successful quality release may automatically approve the source
      // report and create the 104 output. Re-approving that report is a
      // stale-state request, so read the report first and only call the
      // explicit approval endpoint when the automatic write-back did not run.
      const reportBeforeApproval = unwrap(await api.getBusiness(
        `/mes/prodWorkReport/queryById?id=${encodeURIComponent(fixture.reportIds[0])}`
      ), '过程检放行后报工状态回读')
      const reportAlreadyEffective = Number(reportBeforeApproval?.isEffective) === 1 ||
        String(reportBeforeApproval?.billStage || '').includes('END_OF_EXECUTION') ||
        String(reportBeforeApproval?.billStage || '') === '34'
      if (reportAlreadyEffective) {
        caseRecord.checks.push({
          name: '过程检复检放行后自动回写报工生效',
          passed: true,
          details: JSON.stringify({
            reportId: fixture.reportIds[0],
            isEffective: reportBeforeApproval?.isEffective,
            billStage: reportBeforeApproval?.billStage,
            source: 'quality-release-write-back'
          })
        })
      } else {
        unwrap(await api.putBusiness('/mes/prodWorkReport/check', {
          id: fixture.reportIds[0],
          approvalResultType: '1',
          approvalRemark: `${fixture.marker} report release`
        }), '过程检放行后审核报工')
      }
      const reportDetail = unwrap(await api.getBusiness(
        `/mes/prodWorkReport/queryById?id=${encodeURIComponent(fixture.reportIds[0])}`
      ), '过程检放行后报工回读')
      assert.equal(
        Number(reportDetail?.isEffective),
        1,
        '过程检放行后报工必须生效'
      )
      const output = await fixture.captureProductionOutput(fixture.reportIds[0], {
        requireInventory: true
      })
      if (!output?.id) throw new Error('过程检放行后未形成104成品入库')
      const outputDetail = unwrap(await api.getBusiness(
        `/mes/stkIo/queryById?id=${encodeURIComponent(output.id)}`
      ), '104成品入库回读')
      const outputEntries = rowsOf(await api.getBusiness(
        `/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(output.id)}`
      ), '104成品入库明细回读')
      const outputEntry = outputEntries.find((entry) =>
        String(entry?.srcEntryId) === String(fixture.reportIds[0]))
      caseRecord.evidence.push(
        `真实创建 ${fixture.marker} 过程检、失败必检门禁、复检放行、报工审核和104成品入库；所有库存维度属于本轮隔离仓库`
      )
      caseRecord.checks.push({
        name: '过程检放行后生成104成品入库并回读来源',
        passed: String(outputDetail?.stockIoType) === '104' &&
          String(outputDetail?.srcBillType) === 'ProdWork' &&
          String(outputDetail?.srcBillId) === String(fixture.works[0].id) &&
          outputEntry != null &&
          String(outputEntry?.materialId) === fixture.material.id,
        details: JSON.stringify({
          outputId: output.id,
          stockIoType: outputDetail?.stockIoType,
          srcBillType: outputDetail?.srcBillType,
          srcBillId: outputDetail?.srcBillId,
          entryId: outputEntry?.id
        })
      })
      const inventoryRows = productionPageRows(
        await api.getBusiness(
          `/mes/stkInventory/list?pageNo=1&pageSize=100&warehouseId=${encodeURIComponent(fixture.warehouse.id)}&materialId=${encodeURIComponent(fixture.material.id)}&batchNo=${encodeURIComponent(output.dimensions.batchNo)}`
        ),
        '104 成品库存事实'
      )
      caseRecord.checks.push({
        name: 'WMS 成品入库审核状态与库存事实正确',
        passed: Number(outputDetail?.isEffective) === 1 &&
          Number(outputDetail?.isVoided || 0) === 0 &&
          inventoryRows.some((row) =>
            String(row?.materialId) === fixture.material.id &&
            String(row?.warehouseId) === fixture.warehouse.id &&
            String(row?.batchNo) === String(output.dimensions.batchNo) &&
            Number(row?.qty) >= 2),
        details: JSON.stringify({
          outputEffective: outputDetail?.isEffective,
          outputVoided: outputDetail?.isVoided,
          inventoryRows: inventoryRows.map((row) => ({
            id: row?.id, qty: row?.qty, pendingPutawayQty: row?.pendingPutawayQty,
            materialId: row?.materialId,
            warehouseId: row?.warehouseId, batchNo: row?.batchNo
          }))
        })
      })
      const operationTasks = productionPageRows(await api.getBusiness(
        `/wms/operation/task/page?pageNo=1&pageSize=100&sourceBillType=MesStkIo&sourceBillId=${encodeURIComponent(output.id)}`
      ), '生产入库 WMS 作业任务')
      const taskByType = new Map(operationTasks.map((task) => [String(task?.taskType), task]))
      const receiveTask = taskByType.get('RECEIVE')
      const putawayTask = taskByType.get('PUTAWAY')
      caseRecord.checks.push({
        name: 'WMS 收货已完成且生成待执行上架任务',
        passed: operationTasks.length === 2 &&
          receiveTask?.status === 'COMPLETED' &&
          putawayTask?.status === 'PENDING' &&
          Number(receiveTask?.plannedQuantity) >= 2 &&
          Number(receiveTask?.actualQuantity) >= 2 &&
          Number(putawayTask?.plannedQuantity) >= 2 &&
          Number(putawayTask?.actualQuantity) === 0,
        details: JSON.stringify({
          outputId: output.id,
          tasks: operationTasks.map((task) => ({
            id: task?.id,
            taskType: task?.taskType,
            status: task?.status,
            plannedQuantity: task?.plannedQuantity,
            actualQuantity: task?.actualQuantity,
            sourceBillType: task?.sourceBillType,
            sourceBillId: task?.sourceBillId
          }))
        })
      })
      const stockedWork = unwrap(await api.getBusiness(
        `/mes/prodWork/queryById?id=${encodeURIComponent(fixture.works[0].id)}`
      ), '104 入库后工单交期回读')
      caseRecord.checks.push({
        name: '104入库足额后实际交期写入',
        passed: Number(stockedWork?.stockedNum) >= 2 &&
          Boolean(stockedWork?.actualDeliveryTime),
        details: JSON.stringify({
          workId: stockedWork?.id,
          stockedNum: stockedWork?.stockedNum,
          actualDeliveryTime: stockedWork?.actualDeliveryTime
        })
      })
      await collectMesProductionWmsEvidence({
        fixture, page, context: page.context(), caseRecord, outputDir, record, quantity: 2
      })
      const finishedWork = await fixture.finishWork()
      caseRecord.checks.push({
        name: '工单 stockedNum 和实际交期回写',
        passed: Number(finishedWork?.stockedNum) >= 2 &&
          finishedWork?.actualDeliveryTime != null &&
          String(finishedWork.actualDeliveryTime).trim().length > 0,
        details: JSON.stringify({
          workId: finishedWork?.id,
          status: finishedWork?.status,
          stockedNum: finishedWork?.stockedNum,
          actualDeliveryTime: finishedWork?.actualDeliveryTime
        })
      })
      caseRecord.checks.push({
        name: '工单完工状态切换保留入库实际交期',
        passed: Boolean(stockedWork?.actualDeliveryTime) &&
          finishedWork?.actualDeliveryTime === stockedWork.actualDeliveryTime,
        details: JSON.stringify({
          before: stockedWork?.actualDeliveryTime,
          after: finishedWork?.actualDeliveryTime
        })
      })
      await openRoute(page, '/wireSideWarehouse/in/inProduct?stockIoType=104', {
        readySelector: 'input[placeholder="请输入入库单号"]'
      })
      await saveScreenshot(page, outputDir, 'mes-prod-inbound-quality-gate', record)
      const complete = finalizeProductionCatalogEvidence(caseRecord, caseId)
      return {
        api,
        partial: !complete,
        note: complete
          ? '过程检、工单完工门禁、入库及WMS作业原断言均已具备完整证据'
          : '已执行的过程检和成品入库证据已记录；尚未证明WMS收货/上架作业原断言'
      }
    } finally {
      await fixture.cleanup(caseRecord)
      finalizeProductionCatalogEvidence(caseRecord, caseId)
    }
  }

  if (caseId === 'MES-PROD-005') {
    const rows = productionPageRows(await api.getBusiness(
      '/mes/prodOrder/list/dictText?pageNo=1&pageSize=100'), '生产订单')
    if (rows.length === 0) {
      caseRecord.notes.push('当前租户没有生产订单样本，无法验收九状态和暂停标记。')
      return {
        api,
        notImplemented: true,
        note: '当前租户没有生产订单样本，九状态和暂停标记待补数据复验'
      }
    }
    const stateChecks = productionStatusChecks(rows)
    caseRecord.checks.push({
      name: '生产订单列表每行返回九状态编码',
      passed: stateChecks.codes,
      details: JSON.stringify({
        total: rows.length,
        invalidCount: rows.filter((row) => !BIZ_STATUSES.has(row?.bizStatus)).length,
        sample: rows.slice(0, 3).map((row) => ({
          billNo: row?.billNo,
          bizStatus: row?.bizStatus,
          bizStatusName: row?.bizStatusName,
          paused: row?.paused
        }))
      })
    })

    caseRecord.checks.push({
      name: '生产订单中文状态名称与九状态枚举逐项一致',
      passed: stateChecks.names,
      details: JSON.stringify(rows.map((row) => ({
        id: row.id, bizStatus: row.bizStatus, bizStatusName: row.bizStatusName
      })))
    })
    caseRecord.checks.push({
      name: '暂停标记是执行中的附加布尔标记，而不是独立状态列',
      passed: stateChecks.paused,
      details: JSON.stringify({ pausedCount: rows.filter((row) => row?.paused === true).length })
    })

    await openRoute(page, '/mes/produce/order', {
      readySelector: '.search-form input[placeholder="请输入计划单号"]'
    })
    await saveScreenshot(page, outputDir, 'mes-prod-biz-status', record)
    caseRecord.evidence.push('真实登录后调用生产订单分页接口校验九状态派生字段')
    finalizeProductionCatalogEvidence(caseRecord, caseId)
    return { api }
  }

  if (caseId === 'MES-PROD-006') {
    const fixture = new ExecutionWorkflowFixture(api, record, caseId, {
      schedule: false,
      withOpeningInventory: true
    })
    try {
      await fixture.setup(caseRecord)
      const gateResult = await api.getBusiness(
        `/mes/prodOrder/release-gate?prodOrderId=${encodeURIComponent(fixture.order.id)}`
      )
      const gate = gateResult?.data ?? gateResult
      const gateChecks = productionReleaseGateChecks(gate, fixture.order.id)
      caseRecord.checks.push({
        name: '专属生产订单下达门禁预检返回唯一 BOM 与物料齐套明细',
        passed: gateChecks.structure,
        details: JSON.stringify({ orderId: fixture.order.id, gate })
      })
      caseRecord.checks.push({
        name: '下达门禁两项均返回布尔结论与缺项说明',
        passed: gateChecks.details,
        details: JSON.stringify(gate?.items)
      })
      const missing = await api.request(
        'GET',
        '/mes/prodOrder/release-gate?prodOrderId=__not_exists__',
        undefined,
        { expectedBusinessRejection: missingOrderRejection }
      )
      caseRecord.checks.push({
        name: '不存在的生产订单下达门禁预检被精确拒绝',
        passed: matchesExpectedBusinessRejection(missing, missingOrderRejection) &&
          missing?.data == null,
        details: JSON.stringify({ code: missing?.code, msg: missing?.msg })
      })
      await openRoute(page, '/mes/produce/order', {
        readySelector: '.search-form input[placeholder="请输入计划单号"]'
      })
      await saveScreenshot(page, outputDir, 'mes-prod-release-gate', record)
      caseRecord.evidence.push(
        `真实创建 ${fixture.marker} 专属生产订单并调用下达门禁预检；失效 ID 仅作为已声明的业务拒绝负向校验`
      )
      finalizeProductionCatalogEvidence(caseRecord, caseId)
      return { api }
    } finally {
      await fixture.cleanup(caseRecord)
      finalizeProductionCatalogEvidence(caseRecord, caseId)
    }
  }

  if (caseId === 'MES-PROD-007') {
    const fixture = new ExecutionWorkflowFixture(api, record, caseId, {
      schedule: false,
      withOpeningInventory: true
    })
    try {
      await fixture.setup(caseRecord)
      const checkResult = await api.getBusiness(
        `/mes/prodOrder/close-check?id=${encodeURIComponent(fixture.order.id)}`
      )
      const closeCheck = checkResult?.data ?? checkResult
      const items = Array.isArray(closeCheck?.items) ? closeCheck.items : []
      const closeChecks = productionCloseChecks(closeCheck, fixture.order.id)
      caseRecord.checks.push({
        name: '专属生产订单结案检查清单包含四项门禁且不重复',
        passed: closeChecks.structure,
        details: JSON.stringify(items.map((item) => ({ item: item?.item, passed: item?.passed })))
      })
      caseRecord.checks.push({
        name: '专属结案结论与人工放行清单口径一致',
        passed: closeChecks.conclusion,
        details: JSON.stringify({ passed: closeCheck?.passed, closable: closeCheck?.closable,
          overrideRequiredItems: closeCheck?.overrideRequiredItems })
      })
      caseRecord.checks.push({
        name: '成本项未通过且明确要求人工放行',
        passed: closeChecks.cost,
        details: JSON.stringify({
          item: items.find((item) => item.item === 'COST'),
          overrideRequiredItems: closeCheck?.overrideRequiredItems
        })
      })
      const missing = await api.request('PUT', '/mes/prodOrder/closeWithCheck', {
        id: '__not_exists__',
        overrideItems: ['COST'],
        overrideReason: `${fixture.marker} negative check`
      }, { expectedBusinessRejection: missingOrderRejection })
      caseRecord.checks.push({
        name: '不存在的生产订单结案请求被明确拒绝',
        passed: matchesExpectedBusinessRejection(missing, missingOrderRejection),
        details: JSON.stringify({ code: missing?.code, msg: missing?.msg })
      })
      await saveScreenshot(page, outputDir, 'mes-prod-close-check', record)
      caseRecord.evidence.push(
        `真实创建 ${fixture.marker} 专属生产订单并调用结案门禁清单；未实际结案共享或专属订单`
      )
      finalizeProductionCatalogEvidence(caseRecord, caseId)
      return { api }
    } finally {
      await fixture.cleanup(caseRecord)
      finalizeProductionCatalogEvidence(caseRecord, caseId)
    }
  }

  caseRecord.notes.push(
    '案例已锁定工艺/班组、工作日历、领料方式、缺料流程、安灯关闭门禁和过程检放行。'
  )
  return { api }
}
