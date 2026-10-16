import { saveScreenshot } from '../lib/browser.mjs'

export const tenantListReadabilityFact = (metrics) => Boolean(
  metrics && metrics.rows > 0 && metrics.width > 0 &&
  metrics.cells?.length === metrics.rows * 5 &&
  metrics.rowHeights?.length === metrics.rows &&
  metrics.rowHeights.every((height) => Number.isFinite(height) && height >= 24 && height <= 64) &&
  metrics.cells.every((cell) => cell.width >= 100 && cell.height > 0 &&
    cell.height <= 32 && cell.whiteSpace === 'nowrap') &&
  metrics.scrollWidth > metrics.clientWidth && metrics.scrollLeft > 0
)

export async function verifyTenantListReadability ({ page, caseRecord, outputDir, record }) {
  if (new URL(page.url()).pathname !== '/system/tenant/list') {
    caseRecord.notes.push('租户列表未作为当前授权的设置落点，不用直接改 URL 伪造导航截图')
    return
  }
  const initialViewport = page.viewportSize()
  const views = [
    { width: 1100, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 }
  ]
  const observations = []
  try {
    const table = page.locator('.el-table:visible')
    await table.locator('.el-table__row').first().waitFor({ state: 'visible' })
    for (const viewport of views) {
      await page.setViewportSize(viewport)
      await page.waitForFunction(() => {
        const table = document.querySelector('.el-table')
        return table && !table.querySelector('.el-loading-mask') &&
          table.querySelector('.el-table__row')?.getBoundingClientRect().height > 0
      })
      const metrics = await table.evaluate(async (element) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const rows = [...element.querySelectorAll('.el-table__body .el-table__row')]
        const scroll = element.querySelector('.el-table__body-wrapper .el-scrollbar__wrap')
        if (scroll) scroll.scrollLeft = Math.min(400, scroll.scrollWidth - scroll.clientWidth)
        const metrics = {
          width: element.getBoundingClientRect().width,
          rows: rows.length,
          rowHeights: rows.map((row) => row.getBoundingClientRect().height),
          cells: rows.flatMap((row) => [1, 2, 3, 5, 6].map((index) => {
            const cell = row.querySelectorAll('td .cell')[index]
            const rect = cell?.getBoundingClientRect()
            return {
              width: rect?.width || 0, height: rect?.height || 0,
              whiteSpace: cell ? getComputedStyle(cell).whiteSpace : ''
            }
          })),
          scrollWidth: scroll?.scrollWidth || 0,
          clientWidth: scroll?.clientWidth || 0,
          scrollLeft: scroll?.scrollLeft || 0
        }
        if (scroll) scroll.scrollLeft = 0
        return metrics
      })
      const passed = tenantListReadabilityFact(metrics)
      observations.push({ viewport, passed, metrics })
      await saveScreenshot(page, outputDir, `smoke-tenant-list-${viewport.width}`, record)
      if (!passed) throw new Error(`租户列表 ${viewport.width}px 列宽、行高或横向滚动不可读`)
    }
  } finally {
    caseRecord.tenantListReadability = observations
    caseRecord.checks.push({
      name: '租户列表三视口真实数据列不碎行且横向滚动可用',
      passed: observations.length === views.length && observations.every((view) => view.passed),
      details: JSON.stringify(observations)
    })
    if (initialViewport) await page.setViewportSize(initialViewport)
  }
}
