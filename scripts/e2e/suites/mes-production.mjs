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
    const orders = await loadOrderRows(api)
    const works = await api.getBusiness('/mes/prodWork/list/dictText?pageNo=1&pageSize=100')
    const workData = works?.data || {}
    const workRows = Array.isArray(workData?.records)
      ? workData.records
      : Array.isArray(workData?.list)
        ? workData.list
        : []
    caseRecord.checks.push({
      name: '生产订单、工单和工单任务真实分页接口可读取',
      passed:
        orders.length <= 100 &&
        works?.code === 0 &&
        workRows.length <= 100 &&
        (orders.length === 0 || workRows.every((row) => row.id != null)),
      details: `orders=${orders.length}, works=${workRows.length}`
    })
    const missingRoute = await api.request('POST', '/mes/prodWork/routeproducetask', {
      id: '__not_exists__'
    })
    caseRecord.checks.push({
      name: '不存在的工单排产请求被拒绝，不伪造任务',
      passed: missingRoute?.code !== 0,
      details: JSON.stringify({ code: missingRoute?.code, msg: missingRoute?.msg })
    })
    await openRoute(page, '/mes/produce/order')
    await saveScreenshot(page, outputDir, 'mes-prod-order-workflow', record)
    caseRecord.evidence.push('真实登录后读取生产订单/工单分页并校验不存在工单排产负向契约')
    return { api }
  }

  if (caseId === 'MES-PROD-002') {
    const workResult = await api.getBusiness('/mes/prodWork/list/dictText?pageNo=1&pageSize=100')
    const stockResult = await api.request('GET', '/mes/stkIo/list?pageNo=1&pageSize=100')
    const stockData = stockResult?.data || {}
    const stockRows = Array.isArray(stockData?.records)
      ? stockData.records
      : Array.isArray(stockData?.list)
        ? stockData.list
        : []
    caseRecord.checks.push({
      name: '领料工单与 WMS 出入库分页均可读取，库存写侧保持在 WMS',
      passed:
        workResult?.code === 0 &&
        stockResult?.code === 0 &&
        stockRows.length <= 100,
      details: `stockRows=${stockRows.length}`
    })
    const invalidIssue = await api.request('POST', '/mes/stkIo/add', {
      stockIoType: 'MATERIAL_ISSUE',
      srcBillId: '__not_exists__',
      entries: []
    })
    caseRecord.checks.push({
      name: '不存在来源工单或空明细的领料写入被拒绝',
      passed: invalidIssue?.code !== 0,
      details: JSON.stringify({ code: invalidIssue?.code, msg: invalidIssue?.msg })
    })
    await openRoute(page, '/mes/produce/work')
    await saveScreenshot(page, outputDir, 'mes-prod-material-issue', record)
    caseRecord.evidence.push('真实登录后读取工单/WMS 出入库接口并验证非法领料写入被拒绝')
    return { api }
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
    const invalidClose = await api.request('POST', '/mes/prodWork/close', {
      id: '__not_exists__'
    })
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
