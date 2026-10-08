import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { ExecutionWorkflowFixture } from '../fixtures/mes-execution-write.mjs'

export const cases = ['MES-MRP-001']

const STATUS_LABELS = new Set(['初始化', '运算中', '已完成', '已取消', '失败', '未知'])

const unwrap = (response, label) => {
  assertBusinessSuccess(response, label)
  return response && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

const pageRows = (response, label) => {
  const data = unwrap(response, label)
  const rows = Array.isArray(data?.list)
    ? data.list
    : Array.isArray(data?.records)
      ? data.records
      : []
  return { data, rows }
}

// PB-306：MRP 运算约束、终止与状态查询契约
export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const fixture = new ExecutionWorkflowFixture(api, record, caseRecord.id, {
    overdue: true,
    schedule: false
  })
  let calculationId
  try {
    await fixture.setup(caseRecord)
    const now = Date.now()
    const requestBody = {
      workIds: [fixture.works[0].id],
      workNos: [fixture.works[0].workTicketNo],
      materialIds: [fixture.material.id],
      materialNames: [`${fixture.marker}-FG`],
      planStartDate: new Date(now).toISOString(),
      planEndDate: new Date(now + 86400000).toISOString(),
      leadTime: 1,
      safetyStock: 0,
      description: fixture.marker,
      considerInTransitStock: false,
      considerSafetyStock: true,
      considerFinishedStock: true,
      considerOutput: true,
      calculationMode: 1,
      idempotencyKey: fixture.marker
    }
    const result = unwrap(await api.postBusiness('/mes/mrp/calculate', requestBody), 'MRP 运算')
    calculationId = String(result?.calculationId || '')
    caseRecord.checks.push({
      name: '正式 MRP 运算返回计算编号、工单数与结果汇总',
      passed:
        /^[1-9]\d*$|^[0-9a-f-]{16,}$/i.test(calculationId) &&
        Number(result?.summary?.totalOrders) === 1 &&
        Number.isInteger(result?.summary?.totalMaterials) &&
        Array.isArray(result?.demandPlan),
      details: JSON.stringify({
        calculationId,
        summary: result?.summary,
        demandPlanCount: result?.demandPlan?.length
      })
    })

    const historyResult = await api.getBusiness('/mes/mrp/history?pageNo=1&pageSize=100')
    const historyPage = pageRows(historyResult, 'MRP 历史分页')
    const historyRow = historyPage.rows.find((row) => String(row?.id) === calculationId)
    caseRecord.checks.push({
      name: 'MRP 运算历史分页返回本轮记录状态且 pageSize 不超过 100',
      passed:
        typeof historyPage.data?.total === 'number' &&
        historyPage.rows.length <= 100 &&
        historyRow != null &&
        [1, 2, 3, 4, 5].includes(historyRow?.status),
      details: JSON.stringify({
        total: historyPage.data?.total,
        count: historyPage.rows.length,
        calculationId,
        status: historyRow?.status
      })
    })

    caseRecord.checks.push({
      name: 'MRP 运算记录携带幂等键与委外关联列',
      passed:
        historyRow?.idempotencyKey === fixture.marker &&
        Object.prototype.hasOwnProperty.call(historyRow, 'outsourceLink'),
      details: JSON.stringify({
        idempotencyKey: historyRow?.idempotencyKey,
        outsourceLink: historyRow?.outsourceLink
      })
    })

    const status = unwrap(await api.getBusiness(
      `/mes/mrp/status/${encodeURIComponent(calculationId)}`
    ), 'MRP 状态')
    caseRecord.checks.push({
      name: 'MRP 状态接口返回状态码、状态名称、进度、终止原因与可终止标记',
      passed:
        String(status?.calculationId) === calculationId &&
        typeof status?.status === 'number' &&
        STATUS_LABELS.has(status?.statusLabel) &&
        Number.isInteger(status?.progress) &&
        typeof status?.cancelable === 'boolean' &&
        Object.prototype.hasOwnProperty.call(status, 'cancelReason'),
      details: JSON.stringify({
        calculationId: status?.calculationId,
        status: status?.status,
        statusLabel: status?.statusLabel,
        progress: status?.progress,
        cancelReason: status?.cancelReason,
        cancelable: status?.cancelable
      })
    })

    const duplicate = await api.request('POST', '/mes/mrp/calculate', requestBody)
    caseRecord.checks.push({
      name: '同一幂等键重复发起 MRP 被明确拒绝且不生成第二条记录',
      passed:
        duplicate?.code !== 0 &&
        String(duplicate?.msg || duplicate?.message || '').includes('幂等键'),
      details: JSON.stringify({ code: duplicate?.code, msg: duplicate?.msg || duplicate?.message })
    })
    const afterDuplicate = pageRows(
      await api.getBusiness('/mes/mrp/history?pageNo=1&pageSize=100'),
      'MRP 重复提交后历史'
    )
    caseRecord.checks.push({
      name: '重复提交后幂等键仍只对应一条 MRP 记录',
      passed:
        afterDuplicate.rows.filter((row) => row?.idempotencyKey === fixture.marker).length === 1,
      details: JSON.stringify({
        matches: afterDuplicate.rows.filter((row) => row?.idempotencyKey === fixture.marker).length
      })
    })

    const cancelCompleted = await api.request(
      'POST',
      `/mes/mrp/cancel?calculationId=${encodeURIComponent(calculationId)}&reason=${encodeURIComponent(fixture.marker)}`
    )
    caseRecord.checks.push({
      name: '终止接口对已完成 MRP 明确拒绝，不覆盖完成状态',
      passed:
        cancelCompleted?.code !== 0 &&
        String(cancelCompleted?.msg || cancelCompleted?.message || '').includes('已完成'),
      details: JSON.stringify({
        code: cancelCompleted?.code,
        msg: cancelCompleted?.msg || cancelCompleted?.message
      })
    })

    const missing = await api.request('GET', '/mes/mrp/status/__not_exists__')
    caseRecord.checks.push({
      name: '不存在的 MRP 运算状态查询被拒绝',
      passed:
        missing?.code !== 0 &&
        typeof (missing?.msg || missing?.message) === 'string' &&
        (missing?.msg || missing?.message).length > 0,
      details: JSON.stringify({ code: missing?.code, msg: missing?.msg || missing?.message })
    })

    await openRoute(page, '/mes/mrp', { readyText: 'MRP' }).catch(() => null)
    await saveScreenshot(page, outputDir, 'mes-mrp-status', record)
    caseRecord.evidence.push(
      `正式创建 ${fixture.marker} 生产工单并执行 MRP 运算，回读历史、状态、幂等拒绝和终止保护`
    )
    return { api }
  } finally {
    if (calculationId) {
      try {
        await api.deleteBusiness(
          `/mes/mrp/deleteHistory?id=${encodeURIComponent(calculationId)}`
        )
      } catch (error) {
        caseRecord.notes.push(`清理 MRP 运算 ${calculationId} 失败：${error.message}`)
      }
    }
    await fixture.cleanup(caseRecord)
  }
}
