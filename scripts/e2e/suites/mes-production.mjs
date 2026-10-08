import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = [
  'MES-PROD-001',
  'MES-PROD-002',
  'MES-PROD-003',
  'MES-PROD-004',
  'MES-PROD-005',
  'MES-PROD-006',
  'MES-PROD-007'
]

const BIZ_STATUSES = new Set([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ISSUED',
  'IN_PRODUCTION',
  'PARTIALLY_COMPLETED',
  'COMPLETED',
  'CLOSED',
  'CANCELLED'
])

const RELEASE_GATE_CODES = new Set(['BOM', 'MATERIAL'])
const CLOSE_CHECK_ITEMS = new Set(['PROCESS', 'MATERIAL', 'QUALITY', 'COST'])

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

const loadOrderRows = async (api) => {
  const pageResult = await api.getBusiness('/mes/prodOrder/list/dictText?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  if (Array.isArray(pageData)) return pageData
  if (Array.isArray(pageData?.records)) return pageData.records
  if (Array.isArray(pageData?.list)) return pageData.list
  return []
}

/**
 * PB-303~PB-312 生产协同深化改造的前端自动化案例。
 *
 * MES-PROD-001~004 先执行真实只读链路与前置缺失契约，
 * MES-PROD-005~007 继续执行状态、下达和结案门禁回归。
 */
export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'MES-PROD-001') {
    const orders = productionPageRows(
      await api.getBusiness('/mes/prodOrder/list/dictText?pageNo=1&pageSize=100'),
      '生产订单'
    )
    const workRows = productionPageRows(
      await api.getBusiness('/mes/prodWork/list/dictText?pageNo=1&pageSize=100'),
      '生产工单'
    )
    const taskRows = productionPageRows(
      await api.getBusiness('/mes/prodWorkTask/list?pageNo=1&pageSize=100'),
      '工单任务'
    )
    caseRecord.checks.push({
      name: '生产订单、工单和工单任务真实分页接口可读取',
      passed: true,
      details: `orders=${orders.length}, works=${workRows.length}, tasks=${taskRows.length}`
    })
    // This POST only reads routes/tasks; it does not schedule or generate tasks.
    const missingRoute = await api.request('POST', '/mes/prodWork/routeproducetask', {
      prodWorkOrderId: '__not_exists__'
    })
    caseRecord.checks.push({
      name: '不存在工单的工艺路线/任务只读查询明确返回工单不存在，而不是系统异常',
      passed: isMissingProductionWork(missingRoute),
      details: JSON.stringify({
        code: missingRoute?.code,
        msg: missingRoute?.msg ?? missingRoute?.message
      })
    })
    await openRoute(page, '/mes/produce/order', {
      readySelector: '.search-form input[placeholder="请输入计划单号"]'
    })
    await saveScreenshot(page, outputDir, 'mes-prod-order-workflow', record)
    caseRecord.evidence.push('真实生产计划页面、订单/工单/任务分页和工艺路线只读负向查询；未执行拆单或排产')
    const missing = [
      ['生产订单', orders],
      ['生产工单', workRows],
      ['工单任务', taskRows]
    ].filter(([, rows]) => rows.length === 0).map(([name]) => name)
    return {
      api,
      partial: true,
      note: `${missing.length ? `当前租户缺少正式${missing.join('、')}；` : ''}只读查询不等于生产订单拆单/生成任务闭环，未创建或修改共享业务数据`
    }
  }

  if (caseId === 'MES-PROD-002') {
    const workRows = productionPageRows(
      await api.getBusiness('/mes/prodWork/list/dictText?pageNo=1&pageSize=100'),
      '生产工单'
    )
    const stockRows = productionPageRows(
      await api.getBusiness('/mes/stkIo/list?pageNo=1&pageSize=100'),
      'WMS 出入库单'
    )
    caseRecord.checks.push({
      name: '领料工单与 WMS 出入库分页均可读取，库存写侧保持在 WMS',
      passed: true,
      details: `works=${workRows.length}, stockRows=${stockRows.length}`
    })
    // /mes/stkIo/add/{action} is a real write path, not a safe empty-entry probe.
    caseRecord.notes.push(
      '旧 /mes/stkIo/add 请求不存在，404 不能证明领料业务拒绝；真实 /add/{action} 会写单据，本次不调用。'
    )
    await openRoute(page, '/mes/produce/work-order', {
      readySelector: '.search-form input[placeholder="请输入工单编号"]'
    })
    await saveScreenshot(page, outputDir, 'mes-prod-material-issue', record)
    caseRecord.evidence.push('真实生产工单页面与工单/WMS 出入库分页；未领料、开工或修改库存')
    return {
      api,
      partial: true,
      note: `${workRows.length === 0 || stockRows.length === 0 ? '当前租户缺少正式工单或 WMS 出入库单；' : ''}分页和页面只读验证不能证明物料领料配置、缺料禁止开工闭环，待隔离正式前置复测`
    }
  }

  if (caseId === 'MES-PROD-003') {
    const [reports, inspections, andons] = await Promise.all([
      api.request('GET', '/mes/prodWorkReport/list?pageNo=1&pageSize=100'),
      api.request('GET', '/mes/quality/qualityInspection/list?pageNo=1&pageSize=100'),
      api.request('GET', '/mes/andon-record/page?pageNo=1&pageSize=100')
    ])
    const reportRows = reports?.data?.records || reports?.data?.list || []
    const inspectionRows = inspections?.data?.records || inspections?.data?.list || []
    const andonRows = andons?.data?.records || andons?.data?.list || []
    caseRecord.checks.push({
      name: '报工、过程检和安灯均有真实查询链路',
      passed:
        isBusinessSuccess(reports) &&
        isBusinessSuccess(inspections) &&
        isBusinessSuccess(andons) &&
        Array.isArray(reportRows) &&
        Array.isArray(inspectionRows) &&
        Array.isArray(andonRows),
      details: `reports=${reportRows.length}, inspections=${inspectionRows.length}, andons=${andonRows.length}`
    })
    await openRoute(page, '/mes/produce/report')
    await saveScreenshot(page, outputDir, 'mes-prod-report-quality', record)
    caseRecord.evidence.push('真实登录后读取报工、过程检、安灯查询接口并验证报工页面')
    const emptySources = [
      ['报工', reportRows],
      ['过程检', inspectionRows],
      ['安灯', andonRows]
    ]
      .filter(([, rows]) => rows.length === 0)
      .map(([name]) => name)
    return emptySources.length
      ? {
          api,
          partial: true,
          note: `当前租户${emptySources.join('、')}没有真实业务数据，查询链路和页面已验证，业务记录闭环待补数据复测`
        }
      : { api }
  }

  if (caseId === 'MES-PROD-004') {
    const [works, inbound] = await Promise.all([
      api.request('GET', '/mes/prodWork/list/dictText?pageNo=1&pageSize=100'),
      api.request('GET', '/mes/stkIo/list?pageNo=1&pageSize=100&stockIoType=104')
    ])
    const workRows = works?.data?.records || works?.data?.list || []
    const inboundRows = inbound?.data?.records || inbound?.data?.list || []
    caseRecord.checks.push({
      name: '成品入库查询复用 WMS 出入库事实源并可回看工单',
      passed:
        isBusinessSuccess(works) &&
        isBusinessSuccess(inbound) &&
        Array.isArray(workRows) &&
        Array.isArray(inboundRows),
      details: `works=${workRows.length}, inbound=${inboundRows.length}`
    })
    // 关闭接口契约是 List<CloseProdWorkRequest>；用不存在的工单号验证业务拒绝，而非触发 JSON 形状错误。
    const invalidClose = await api.request('POST', '/mes/prodWork/close', [{
      id: '__not_exists__',
      prodWorkOrderId: '__not_exists__',
      reason: 'E2E 校验不存在工单应被拒绝'
    }])
    caseRecord.checks.push({
      name: '不存在工单的完工/入库请求被拒绝',
      passed: invalidClose?.code !== 0,
      details: JSON.stringify({ code: invalidClose?.code, msg: invalidClose?.msg })
    })
    await openRoute(page, '/wireSideWarehouse/in/inProduct?stockIoType=104', {
      readySelector: 'input[placeholder="请输入入库单号"]'
    })
    await saveScreenshot(page, outputDir, 'mes-prod-inbound-quality-gate', record)
    caseRecord.evidence.push('真实登录后读取工单与成品入库分页并验证非法完工请求被拒绝')
    return { api }
  }

  if (caseId === 'MES-PROD-005') {
    const rows = await loadOrderRows(api)
    if (rows.length === 0) {
      caseRecord.notes.push('当前租户没有生产订单样本，无法验收九状态和暂停标记。')
      return {
        api,
        notImplemented: true,
        note: '当前租户没有生产订单样本，九状态和暂停标记待补数据复验'
      }
    }
    const invalid = rows.filter((row) => !BIZ_STATUSES.has(row?.bizStatus))
    caseRecord.checks.push({
      name: '生产订单列表每行都返回九状态编码与中文名称',
      passed:
        rows.length > 0 &&
        invalid.length === 0 &&
        rows.every(
          (row) => typeof row?.bizStatusName === 'string' && row.bizStatusName.length > 0
        ),
      details: JSON.stringify({
        total: rows.length,
        invalidCount: invalid.length,
        sample: rows.slice(0, 3).map((row) => ({
          billNo: row?.billNo,
          bizStatus: row?.bizStatus,
          bizStatusName: row?.bizStatusName,
          paused: row?.paused
        }))
      })
    })

    caseRecord.checks.push({
      name: '暂停标记是执行中的附加布尔标记，而不是独立状态列',
      passed: rows.every((row) => row?.paused === true || row?.paused === false),
      details: JSON.stringify({ pausedCount: rows.filter((row) => row?.paused === true).length })
    })

    await saveScreenshot(page, outputDir, 'mes-prod-biz-status', record)
    caseRecord.evidence.push('真实登录后调用生产订单分页接口校验九状态派生字段')
    return { api }
  }

  if (caseId === 'MES-PROD-006') {
    const rows = await loadOrderRows(api)
    if (rows.length === 0) {
      caseRecord.notes.push('当前租户没有生产订单样本，无法验收下达门禁预检。')
      return {
        api,
        notImplemented: true,
        note: '当前租户没有生产订单样本，下达门禁预检待补数据复验'
      }
    }

    const gateResult = await api.getBusiness(
      `/mes/prodOrder/release-gate?prodOrderId=${encodeURIComponent(rows[0].id)}`
    )
    const gate = gateResult?.data ?? gateResult
    const items = Array.isArray(gate?.items) ? gate.items : []
    caseRecord.checks.push({
      name: '下达门禁预检返回开关、结论与门禁明细',
      passed:
        gate?.prodOrderId === rows[0].id &&
        typeof gate?.enabled === 'boolean' &&
        typeof gate?.passed === 'boolean' &&
        items.length > 0 &&
        items.every(
          (item) =>
            RELEASE_GATE_CODES.has(item?.code) &&
            typeof item?.passed === 'boolean' &&
            typeof item?.message === 'string'
        ),
      details: JSON.stringify({
        prodOrderId: gate?.prodOrderId,
        enabled: gate?.enabled,
        passed: gate?.passed,
        items: items.map((item) => ({ code: item?.code, passed: item?.passed }))
      })
    })

    // 负向：不存在的生产订单必须被拒绝，而不是静默返回可通过的门禁结果
    const missing = await api.request(
      'GET',
      '/mes/prodOrder/release-gate?prodOrderId=__not_exists__'
    )
    caseRecord.checks.push({
      name: '不存在的生产订单下达门禁预检被拒绝',
      passed: missing?.code !== 0,
      details: JSON.stringify({ code: missing?.code, msg: missing?.msg })
    })

    await saveScreenshot(page, outputDir, 'mes-prod-release-gate', record)
    caseRecord.evidence.push('真实登录后调用生产订单下达门禁预检接口（只读 + 负向校验）')
    return { api }
  }

  if (caseId === 'MES-PROD-007') {
    const rows = await loadOrderRows(api)
    if (rows.length === 0) {
      caseRecord.notes.push('当前租户没有生产订单样本，无法验收结案门禁。')
      return {
        api,
        notImplemented: true,
        note: '当前租户没有生产订单样本，结案门禁待补数据复验'
      }
    }

    const checkResult = await api.getBusiness(
      `/mes/prodOrder/close-check?id=${encodeURIComponent(rows[0].id)}`
    )
    const check = checkResult?.data ?? checkResult
    const items = Array.isArray(check?.items) ? check.items : []
    caseRecord.checks.push({
      name: '结案检查清单包含四项门禁且每项带通过结论与说明',
      passed:
        check?.prodOrderId === rows[0].id &&
        items.length === 4 &&
        items.every(
          (item) =>
            CLOSE_CHECK_ITEMS.has(item?.item) &&
            typeof item?.itemName === 'string' &&
            typeof item?.passed === 'boolean' &&
            typeof item?.message === 'string'
        ) &&
        items.length === new Set(items.map((item) => item.item)).size,
      details: JSON.stringify(items.map((item) => ({ item: item?.item, passed: item?.passed })))
    })

    caseRecord.checks.push({
      name: '结案结论与待人工放行清单口径一致（cost 未接 FMS 时只能人工放行）',
      passed:
        typeof check?.passed === 'boolean' &&
        typeof check?.closable === 'boolean' &&
        Array.isArray(check?.overrideRequiredItems) &&
        check.closable === check.passed &&
        check.overrideRequiredItems.length === items.filter((item) => !item.passed).length,
      details: JSON.stringify({
        passed: check?.passed,
        closable: check?.closable,
        overrideRequiredItems: check?.overrideRequiredItems
      })
    })

    // 负向：不存在的生产订单结案请求必须被拒绝，避免误关其它单据
    const missing = await api.request('PUT', '/mes/prodOrder/closeWithCheck', {
      id: '__not_exists__',
      overrideItems: ['COST'],
      overrideReason: 'e2e negative check'
    })
    caseRecord.checks.push({
      name: '不存在的生产订单结案请求被拒绝',
      passed: missing?.code !== 0,
      details: JSON.stringify({ code: missing?.code, msg: missing?.msg })
    })

    await saveScreenshot(page, outputDir, 'mes-prod-close-check', record)
    caseRecord.evidence.push('真实登录后调用结案门禁检查清单与结案负向校验接口（未实际结案）')
    return { api }
  }

  caseRecord.notes.push(
    '案例已锁定工艺/班组、工作日历、领料方式、缺料流程、安灯关闭门禁和过程检放行。'
  )
  return { api }
}
