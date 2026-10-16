import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-266/PB-267 销售订单审批变更、履约关闭与重开审计。
export const cases = ['ERP-SALE-ORDER-LIFECYCLE-001', 'ERP-SALE-ORDER-LIFECYCLE-002']

const unwrap = (response) => response?.data

const findLifecycleCandidate = (orders) =>
  orders.find(
    (order) =>
      order?.isEffective === 1 &&
      order?.isClosed !== 1 &&
      order?.isVoided !== 1 &&
      String(order?.billStage) === '32'
  )

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })

  if (caseId === 'ERP-SALE-ORDER-LIFECYCLE-001') {
    const pageResult = unwrap(await api.getBusiness('/erp/sale-order/page?pageNo=1&pageSize=100'))
    caseRecord.checks.push({
      name: 'PB-266 销售订单分页返回版本与生命周期字段',
      passed:
        Array.isArray(pageResult?.list) &&
        pageResult.list.every(
          (order) =>
            Object.prototype.hasOwnProperty.call(order, 'version') ||
            Object.prototype.hasOwnProperty.call(order, 'billStage')
        ),
      details: JSON.stringify({
        total: pageResult?.total,
        sample: pageResult?.list?.[0]?.billNo
      })
    })

    await openRoute(page, '/erp/sale/order')
    await page.getByText('销售订单').first().waitFor({ state: 'visible' })
    await page.locator('.el-table__row').first().waitFor({ state: 'visible' })
    await saveScreenshot(page, outputDir, 'erp-sale-order-lifecycle-list', record)
    return { token, api }
  }

  if (caseId !== 'ERP-SALE-ORDER-LIFECYCLE-002') return { designed: true }

  const pageResult = unwrap(await api.getBusiness('/erp/sale-order/page?pageNo=1&pageSize=100'))
  const candidate = findLifecycleCandidate(pageResult?.list || [])
  if (!candidate) {
    throw new Error(
      'BLOCKED: 需要测试租户准备一条已生效、未关闭且 billStage=32 的销售订单，用于可恢复的关闭/重开闭环。'
    )
  }

  await openRoute(page, '/erp/sale/order')
  await page.getByText(candidate.billNo, { exact: false }).first().waitFor({ state: 'visible' })
  caseRecord.checks.push({
    name: 'PB-267 页面显示可关闭的真实销售订单',
    passed: true,
    details: `${candidate.billNo} version=${candidate.version} billStage=${candidate.billStage}`
  })

  const reason = `E2E 履约关闭审计 ${Date.now()}`
  await api.putBusiness('/erp/sale-order/close', {
    id: candidate.id,
    version: Number(candidate.version || 0),
    reason
  })
  const closed = unwrap(await api.getBusiness(`/erp/sale-order/get?id=${candidate.id}`))
  caseRecord.checks.push({
    name: 'PB-267 关闭后订单状态与版本真实回写',
    passed: closed?.isClosed === 1 && String(closed?.billStage) === '33',
    details: `isClosed=${closed?.isClosed} billStage=${closed?.billStage} version=${closed?.version}`
  })

  const closeLogs = unwrap(
    await api.getBusiness(`/erp/sale-order/change-log/list?id=${candidate.id}`)
  )
  caseRecord.checks.push({
    name: 'PB-267 关闭动作写入可追溯审计',
    passed:
      Array.isArray(closeLogs) &&
      closeLogs.some((item) => item.changeType === 'CLOSE' && item.changeReason === reason),
    details: `changeTypes=${(closeLogs || []).map((item) => item.changeType).join(',')}`
  })

  const uncloseReason = `E2E 恢复订单状态 ${Date.now()}`
  await api.putBusiness('/erp/sale-order/unclose', {
    id: candidate.id,
    version: Number(closed?.version || 0),
    reason: uncloseReason
  })
  const restored = unwrap(await api.getBusiness(`/erp/sale-order/get?id=${candidate.id}`))
  caseRecord.checks.push({
    name: 'PB-267 重开后恢复执行中并保留审计',
    passed: restored?.isClosed === 0 && String(restored?.billStage) === '32',
    details: `isClosed=${restored?.isClosed} billStage=${restored?.billStage} version=${restored?.version}`
  })

  const restoredLogs = unwrap(
    await api.getBusiness(`/erp/sale-order/change-log/list?id=${candidate.id}`)
  )
  caseRecord.checks.push({
    name: 'PB-267 重开动作写入完整链路',
    passed:
      Array.isArray(restoredLogs) &&
      restoredLogs.some(
        (item) => item.changeType === 'UNCLOSE' && item.changeReason === uncloseReason
      ),
    details: `changeTypes=${(restoredLogs || []).map((item) => item.changeType).join(',')}`
  })

  await saveScreenshot(page, outputDir, 'erp-sale-order-lifecycle-restored', record)
  return { token, api }
}
