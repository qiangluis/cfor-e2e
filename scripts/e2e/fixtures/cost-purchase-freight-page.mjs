import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'

const requireFact = (condition, message) => {
  if (!condition) throw new Error(`COST-011 page: ${message}`)
}
const amount = (value) => {
  requireFact(typeof value === 'number' || typeof value === 'string',
    '数量或金额缺失')
  requireFact(String(value).trim() !== '' && Number.isFinite(Number(value)),
    '数量或金额格式无效')
  return Number(value)
}

export function assertPurchaseFreightPage ({
  observation, fixture, snapshot, positive, zero, wmsSource
}) {
  requireFact(observation?.loaded === 'true' && observation.error === '', '正式页面未成功读取来源')
  requireFact(observation.periodId === fixture.periodId && observation.month === fixture.month &&
    observation.modelId === fixture.modelId && observation.versionNo === fixture.versionNo,
  '页面模型、期间或版本不匹配')
  requireFact(snapshot?.periodId === fixture.periodId && snapshot.snapshotKey === 'PURCHASE' &&
    snapshot.versionNo === fixture.versionNo && snapshot.status === 'DRAFT' &&
    observation.snapshotId === snapshot.id && observation.status === 'DRAFT',
  '页面与正式PURCHASE草稿快照不一致')
  requireFact(Array.isArray(snapshot.lines) && snapshot.lines.length > 0 &&
    Array.isArray(observation.rows) && observation.rows.length === snapshot.lines.length,
  '页面来源明细缺失或未完整显示')
  for (const row of observation.rows) {
    const matches = snapshot.lines.filter((line) => line.sourceType === row.sourceType &&
      String(line.sourceId) === row.sourceId && String(line.sourceLineId) === row.sourceLineId)
    requireFact(matches.length === 1 && row.periodId === fixture.periodId, '页面行来源归属不唯一')
    const source = matches[0]
    requireFact(row.productCode === source.productCode &&
      amount(row.quantity) === amount(source.quantity) &&
      amount(row.materialAmount) === amount(source.materialAmount) &&
      amount(row.expenseAmount) === amount(source.expenseAmount), '页面行与正式来源数量金额不一致')
    requireFact(row.sourceText === (source.sourceNo || String(source.sourceId)), '页面单号显示错误')
    requireFact(row.expenseText === amount(source.expenseAmount).toFixed(2),
      '页面采购费用单元格未显示真实金额')
    requireFact(row.materialText === amount(source.materialAmount).toFixed(2),
      '页面材料金额单元格未显示真实金额')
  }
  const freight = observation.rows.filter((row) => row.sourceType === 'PURCHASE_FREIGHT' &&
    row.sourceId === positive.id && row.sourceLineId === positive.entryId)
  requireFact(freight.length === 1 && freight[0].expenseText === positive.amount &&
    freight[0].materialText === '0.00', '页面没有唯一显示专属采购费用')
  // 采购入库来源已切到 WMS 采购入库事实源，页面来源主键是 mes_stk_io 主从 ID。
  requireFact(observation.rows.some((row) => row.sourceType === 'PURCHASE_RECEIPT' &&
    row.sourceId === String(wmsSource.wms.id) &&
    row.sourceLineId === String(wmsSource.entry.id)), '页面缺少同期间采购入库')
  requireFact(!observation.rows.some((row) => row.sourceType === 'PURCHASE_FREIGHT' &&
    row.sourceId === zero.id), '页面将零费用应付冒充来源')
  requireFact(amount(observation.expenseTotal) ===
    snapshot.lines.reduce((sum, row) => sum + amount(row.expenseAmount), 0),
  '页面采购费用合计与正式来源不一致')
  requireFact(observation.workspaceWrites.length === 0,
    '采购来源页面仍向workspace-states写入，不能用临时回执作为成功')
  return observation
}

export async function verifyPurchaseFreightPage ({
  page, outputDir, record, fixture, snapshot, positive, zero, wmsSource
}) {
  const workspaceWrites = []
  const onRequest = (request) => {
    if (request.url().includes('/cost/workspace-states') &&
      !['GET', 'OPTIONS', 'HEAD'].includes(request.method()))
      workspaceWrites.push({ method: request.method(), path: new URL(request.url()).pathname })
  }
  page.on('request', onRequest)
  try {
    await openRoute(page, `/cost-management/monthly/purchase-costing?periodId=${fixture.periodId}`, {
      readySelector: '[data-testid="formal-purchase-cost"]', retries: 1
    })
    const root = page.locator('[data-testid="formal-purchase-cost"]')
    await root.waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-testid="formal-purchase-cost"]')
      return root?.getAttribute('data-loaded') === 'true' || root?.getAttribute('data-error')
    })
    requireFact(await root.getAttribute('data-error') === '', '正式页面读取失败')
    const endpoint = `/admin-api/cost/periods/${fixture.periodId}/source-snapshot/purchase/refresh`
    const responsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === endpoint && response.request().method() === 'POST')
    const [response] = await Promise.all([
      responsePromise,
      root.locator('[data-testid="purchase-refresh-sources"]').click()
    ])
    const refreshed = assertBusinessSuccess(await response.json(), 'COST-011页面正式刷新').data
    requireFact(response.ok(), '页面正式刷新HTTP失败')
    requireFact(refreshed?.id === snapshot.id && refreshed?.snapshotHash === snapshot.snapshotHash,
      '页面刷新后与夹具采购来源快照不一致')
    await page.getByText(`已刷新 ${fixture.month} 的 ${refreshed.lines.length} 条采购来源`, {
      exact: true
    }).waitFor({ state: 'visible' })
    const observation = await root.evaluate((element) => {
      const text = (selector) => element.querySelector(selector)?.textContent?.trim() || ''
      return {
        loaded: element.dataset.loaded, error: element.dataset.error,
        periodId: element.dataset.periodId, month: element.dataset.month,
        modelId: element.dataset.modelId, versionNo: element.dataset.modelVersion,
        snapshotId: element.dataset.snapshotId, status: element.dataset.status,
        expenseTotal: text('[data-field="expenseAmount"]').replaceAll(',', ''),
        rows: [...element.querySelectorAll('[data-testid="purchase-source-row"]')].map((identity) => {
          const cells = identity.closest('tr')?.querySelectorAll('td') || []
          const cell = (index) => cells[index]?.textContent?.trim().replaceAll(',', '') || ''
          return {
            ...identity.dataset, sourceText: identity.textContent?.trim(),
            materialText: cell(5), expenseText: cell(6)
          }
        })
      }
    })
    observation.workspaceWrites = workspaceWrites
    assertPurchaseFreightPage({ observation, fixture, snapshot: refreshed, positive, zero, wmsSource })
    await saveScreenshot(page, outputDir, 'cost-011-formal-purchase-freight', record)
    return observation
  } finally {
    page.off('request', onRequest)
  }
}
