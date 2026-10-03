import { createApiClient } from '../lib/api.mjs'
import { login, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['MES-MRP-001']

const STATUS_LABELS = new Set(['初始化', '运算中', '已完成', '已取消', '失败', '未知'])

// PB-306：MRP 运算约束、终止与状态查询契约
export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const pageResult = await api.getBusiness('/mes/mrp/history?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  const rows = Array.isArray(pageData?.list)
    ? pageData.list
    : Array.isArray(pageData?.records)
      ? pageData.records
      : []
  caseRecord.checks.push({
    name: 'MRP 运算历史分页返回状态字段且 pageSize 不超过 100',
    passed:
      typeof pageData?.total === 'number' &&
      rows.length <= 100 &&
      rows.every((row) => row?.id && [1, 2, 3, 4, 5].includes(row?.status)),
    details: JSON.stringify({ total: pageData?.total, count: rows.length })
  })

  if (rows.length === 0) {
    caseRecord.checks.push({
      name: 'MRP 运算状态查询返回状态码、状态名称与可终止标记',
      passed: false,
      details: '当前租户没有 MRP 运算记录，无法验证状态接口；需先构造一条运算记录'
    })
  } else {
    const statusResult = await api.getBusiness(
      `/mes/mrp/status/${encodeURIComponent(rows[0].id)}`
    )
    const status = statusResult?.data ?? statusResult
    caseRecord.checks.push({
      name: 'MRP 运算状态查询返回状态码、状态名称与可终止标记',
      passed:
        status?.calculationId === rows[0].id &&
        typeof status?.status === 'number' &&
        STATUS_LABELS.has(status?.statusLabel) &&
        typeof status?.cancelable === 'boolean' &&
        Object.prototype.hasOwnProperty.call(status, 'cancelReason'),
      details: JSON.stringify({
        status: status?.status,
        statusLabel: status?.statusLabel,
        cancelable: status?.cancelable
      })
    })

    // 不存在的运算必须返回业务错误，避免状态接口对未知运算静默成功。
    const missing = await api.request('GET', '/mes/mrp/status/__not_exists__')
    caseRecord.checks.push({
      name: '不存在的 MRP 运算状态查询被拒绝',
      passed: missing?.code !== 0 && typeof missing?.msg === 'string' && missing.msg.length > 0,
      details: JSON.stringify({ code: missing?.code, msg: missing?.msg })
    })
  }

  await saveScreenshot(page, outputDir, 'mes-mrp-status', record)
  caseRecord.evidence.push('真实登录后调用 MRP 历史分页与状态查询接口')
  return { api }
}
