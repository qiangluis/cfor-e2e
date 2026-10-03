import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['WMS-TR-001']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const pageResult = await api.getBusiness('/wms/transfer-bill/page?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  const rows = Array.isArray(pageData?.list)
    ? pageData.list
    : Array.isArray(pageData?.records)
      ? pageData.records
      : []
  const validStatuses = new Set(['DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'])
  caseRecord.checks.push({
    name: '跨仓调拨分页契约返回主表字段、明细与在途量且分页不超过 100',
    passed:
      typeof pageData?.total === 'number' &&
      rows.length <= 100 &&
      rows.every(
        (row) =>
          row?.id &&
          row?.billNo &&
          row?.outWarehouseId &&
          row?.inWarehouseId &&
          validStatuses.has(row?.transferStatus) &&
          row?.inTransitQty !== undefined &&
          Array.isArray(row?.lines)
      ),
    details: JSON.stringify({ total: pageData?.total, count: rows.length })
  })

  await openRoute(page, '/wireSideWarehouse/transfer')
  await page.locator('[data-testid="wms-transfer-page"]').waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '跨仓调拨页面挂在现有仓库管理菜单下并可真实渲染',
    passed:
      new URL(page.url()).pathname === '/wireSideWarehouse/transfer' &&
      bodyText.includes('跨仓调拨') &&
      bodyText.includes('新增调拨') &&
      bodyText.includes('在途量'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'wms-transfer-page', record)
  caseRecord.evidence.push('真实登录、调拨分页接口、仓库菜单路由和浏览器截图')
  return { token, api }
}
