import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { ExecutionWorkflowFixture } from '../fixtures/mes-execution-write.mjs'

export const cases = ['MES-MRP-001']

export const MES_MRP_CATALOG_ASSERTIONS = Object.freeze([
  'MRP 运算历史分页返回状态码 1/2/3/4/5 且 pageSize 不超过 100',
  '状态接口返回状态码、状态名称、进度、终止原因与可终止标记',
  '不存在的运算状态查询被拒绝',
  '运算记录携带幂等键与委外关联列'
])

const MRP_CATALOG_GAP_NOTES = Object.freeze({
  1: 'MES-MRP-001 状态接口字段证据欠缺：未完整证明状态码、状态名称、进度、终止原因与可终止标记。',
  2: 'MES-MRP-001 不存在状态拒绝证据欠缺：未取得精确业务拒绝响应。',
  3: 'MES-MRP-001 运算记录字段证据欠缺：未同时证明幂等键与委外关联列。'
})

const STATUS_LABELS = new Set(['初始化', '运算中', '已完成', '已取消', '失败', '未知'])
const MRP_CALCULATION_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

export const MRP_IDEMPOTENCY_REJECTION = Object.freeze({
  code: 500,
  message: new RegExp(
    `^系统错误，MRP运算失败：该幂等键已存在MRP运算（${MRP_CALCULATION_UUID}），请勿重复提交$`
  ),
  allowServiceCode: true
})

export const MRP_COMPLETED_CANCEL_REJECTION = Object.freeze({
  code: 500,
  message: /^取消MRP运算失败：已完成的MRP运算不允许终止，请重新发起运算$/,
  allowServiceCode: true
})

export const MRP_MISSING_STATUS_REJECTION = Object.freeze({
  code: 500,
  message: /^查询MRP运算状态失败：MRP运算记录不存在$/,
  allowServiceCode: true
})

export const MRP_EXECUTION_CLEANUP_PATHS = Object.freeze({
  report: ['/mes/prodWorkReport/delete?id={id}'],
  task: [
    '/mes/prodWorkTask/queryById?id={id}',
    '/mes/prodWorkTask/voidOnly?prodWorkTaskId={id}'
  ],
  work: [
    '/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId={id}',
    '/mes/prodWorkTask/void?prodWorkId={id}',
    '/mes/prodWork/revocation',
    '/mes/prodWork/delete?id={id}'
  ],
  order: ['/mes/prodOrder/delete?id={id}'],
  opening: ['/mes/stkIo/void', '/mes/stkIo/queryById?id={id}'],
  inventory: ['/mes/stkInventory/delete?id={id}'],
  route: ['/mes/wmsTechRoute/delete?id={id}'],
  procedure: ['/mes/wmsProcedure/delete?id={id}'],
  bom: ['/mes/wmsAssemble/delete?id={id}'],
  material: ['/mes/basMaterial/edit', '/mes/basMaterial/delete?id={id}'],
  location: ['/mes/wms-house-location/delete?id={id}'],
  area: ['/mes/wmsHouseArea/delete?id={id}'],
  warehouse: [
    '/mes/wmsWareHouse/queryById?id={id}',
    '/mes/wmsWareHouse/edit',
    '/mes/wmsWareHouse/delete?id={id}'
  ],
  team: ['/mes/teamManage/delete?id={id}']
})

const rejectionMessage = (response) => response?.msg || response?.message || ''

export const assertExpectedMrpRejection = (response, expected, label) => {
  if (!matchesExpectedBusinessRejection(response, expected)) {
    throw new Error(`${label}契约不符：实际 ${JSON.stringify({
      code: response?.code,
      message: rejectionMessage(response)
    })}`)
  }
  return true
}

const cleanupEvidence = (fixture) => fixture.owned.map((resource) => {
  const paths = MRP_EXECUTION_CLEANUP_PATHS[resource.kind] || ['由共享执行夹具负责']
  return `${resource.kind}=${resource.id} via ${paths.join(' -> ')}`
}).join('; ')

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

export const initializeMrpCatalogAssertions = (caseRecord) => {
  caseRecord.catalogAssertions = MES_MRP_CATALOG_ASSERTIONS.map((assertion, index) => ({
    index,
    assertion,
    status: 'GAP',
    evidenceChecks: [],
    details: '本轮尚未执行该原断言'
  }))
  caseRecord.remainingAssertions = [...MES_MRP_CATALOG_ASSERTIONS]
  caseRecord.catalogComplete = false
  return caseRecord.catalogAssertions
}

export const markMrpCatalogAssertion = (caseRecord, index, evidenceChecks, gap = '') => {
  const row = caseRecord.catalogAssertions?.[index]
  if (!row) return false
  const names = Array.isArray(evidenceChecks) ? [...evidenceChecks] : []
  const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
  const missing = names.filter((name, position) => !checks[position])
  const failed = checks.filter((check) => check && check.passed !== true)
  row.evidenceChecks = names
  row.status = !gap && names.length > 0 && missing.length === 0 && failed.length === 0
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

export const finalizeMrpCatalogAssertions = (caseRecord) => {
  if (!Array.isArray(caseRecord.catalogAssertions)) initializeMrpCatalogAssertions(caseRecord)
  const gaps = caseRecord.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
  caseRecord.remainingAssertions = gaps.map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  const notes = gaps.map((row) => MRP_CATALOG_GAP_NOTES[row.index] ||
    `MES-MRP-001 catalog 断言缺口：${row.assertion}`)
  caseRecord.notes ||= []
  for (const note of notes) {
    if (!caseRecord.notes.includes(note)) caseRecord.notes.push(note)
  }
  return {
    partial: gaps.length > 0,
    note: notes.join('；'),
    catalogAssertions: caseRecord.catalogAssertions
  }
}

// PB-306：MRP 运算约束、终止与状态查询契约
export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  initializeMrpCatalogAssertions(caseRecord)
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
    markMrpCatalogAssertion(caseRecord, 0, [
      'MRP 运算历史分页返回本轮记录状态且 pageSize 不超过 100'
    ])

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
    markMrpCatalogAssertion(caseRecord, 3, ['MRP 运算记录携带幂等键与委外关联列'])

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
    markMrpCatalogAssertion(caseRecord, 1, [
      'MRP 状态接口返回状态码、状态名称、进度、终止原因与可终止标记'
    ])

    const duplicate = await api.request('POST', '/mes/mrp/calculate', requestBody, {
      expectedBusinessRejection: MRP_IDEMPOTENCY_REJECTION
    })
    assertExpectedMrpRejection(duplicate, MRP_IDEMPOTENCY_REJECTION, 'MRP 幂等重复提交')
    caseRecord.checks.push({
      name: '同一幂等键重复发起 MRP 被明确拒绝且不生成第二条记录',
      passed: true,
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
      `/mes/mrp/cancel?calculationId=${encodeURIComponent(calculationId)}&reason=${encodeURIComponent(fixture.marker)}`,
      undefined,
      { expectedBusinessRejection: MRP_COMPLETED_CANCEL_REJECTION }
    )
    assertExpectedMrpRejection(
      cancelCompleted,
      MRP_COMPLETED_CANCEL_REJECTION,
      '已完成 MRP 终止'
    )
    const afterCompletedCancel = unwrap(await api.getBusiness(
      `/mes/mrp/status/${encodeURIComponent(calculationId)}`
    ), '已完成 MRP 终止后状态')
    caseRecord.checks.push({
      name: '终止接口对已完成 MRP 明确拒绝，不覆盖完成状态',
      passed: afterCompletedCancel?.status === 3 && afterCompletedCancel?.cancelable === false,
      details: JSON.stringify({
        code: cancelCompleted?.code,
        msg: cancelCompleted?.msg || cancelCompleted?.message,
        retainedStatus: afterCompletedCancel?.status,
        cancelable: afterCompletedCancel?.cancelable
      })
    })

    const missing = await api.request('GET', '/mes/mrp/status/__not_exists__', undefined, {
      expectedBusinessRejection: MRP_MISSING_STATUS_REJECTION
    })
    assertExpectedMrpRejection(missing, MRP_MISSING_STATUS_REJECTION, '不存在 MRP 状态查询')
    caseRecord.checks.push({
      name: '不存在的 MRP 运算状态查询被拒绝',
      passed: true,
      details: JSON.stringify({ code: missing?.code, msg: missing?.msg || missing?.message })
    })
    markMrpCatalogAssertion(caseRecord, 2, ['不存在的 MRP 运算状态查询被拒绝'])

    await openRoute(page, '/mes/mrp', { readyText: 'MRP' }).catch(() => null)
    await saveScreenshot(page, outputDir, 'mes-mrp-status', record)
    caseRecord.evidence.push(
      `正式创建 ${fixture.marker} 生产工单并执行 MRP 运算，回读历史、状态、幂等拒绝和终止保护`
    )
    const catalogOutcome = finalizeMrpCatalogAssertions(caseRecord)
    return { api, ...catalogOutcome }
  } finally {
    if (calculationId) {
      try {
        const retained = unwrap(await api.getBusiness(
          `/mes/mrp/status/${encodeURIComponent(calculationId)}`
        ), 'MRP 终态事实保留回读')
        if (String(retained?.calculationId) !== calculationId || retained?.status !== 3) {
          throw new Error(`MRP 终态事实回读不匹配：${JSON.stringify(retained)}`)
        }
        caseRecord.checks.push({
          name: 'MRP 终态计算事实保留且未调用历史删除接口',
          passed: true,
          details: `calculationId=${calculationId}, status=${retained.status}, verify=/mes/mrp/status/{calculationId}`
        })
        caseRecord.evidence.push(
          `MRP 计算事实保留 calculationId=${calculationId}；夹具资源按共享执行夹具正式 API 清理：${cleanupEvidence(fixture)}`
        )
      } catch (error) {
        caseRecord.notes.push(`MRP 终态事实保留回读失败 calculationId=${calculationId}：${error.message}`)
      }
    }
    await fixture.cleanup(caseRecord)
    finalizeMrpCatalogAssertions(caseRecord)
  }
}
