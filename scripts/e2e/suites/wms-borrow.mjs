import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['WMS-BR-001']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const pageResult = await api.getBusiness('/wms/borrow-bill/page?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  const rows = Array.isArray(pageData?.list)
    ? pageData.list
    : Array.isArray(pageData?.records)
      ? pageData.records
      : []
  const validStatuses = new Set(['DRAFT', 'BORROWED', 'PARTIAL_RETURNED', 'RETURNED', 'CANCELLED'])
  caseRecord.checks.push({
    name: '借用归还分页契约返回累计归还、未归还和逾期跟踪字段且分页不超过 100',
    passed:
      typeof pageData?.total === 'number' &&
      rows.length <= 100 &&
      rows.every(
        (row) =>
          row?.id &&
          row?.billNo &&
          row?.warehouseId &&
          row?.borrowerId &&
          validStatuses.has(row?.borrowStatus) &&
          row?.totalBorrowQty !== undefined &&
          row?.totalReturnedQty !== undefined &&
          row?.remainingQty !== undefined &&
          typeof row?.overdue === 'boolean' &&
          Array.isArray(row?.lines)
      ),
    details: JSON.stringify({ total: pageData?.total, count: rows.length })
  })

  const todoResult = await api.getBusiness(
    '/workbench/todo/page?category=warehouse&pageNo=1&pageSize=100'
  )
  const todoData = todoResult?.data ?? todoResult
  const todoRows = Array.isArray(todoData?.list) ? todoData.list : []
  caseRecord.checks.push({
    name: '统一工作台仓库待办聚合借用逾期事实并返回可跳转目标',
    passed:
      typeof todoData?.total === 'number' &&
      typeof todoData?.counts?.warehouse === 'number' &&
      todoRows.every(
        (row) =>
          row?.targetType !== 'WMS_BORROW_OVERDUE' ||
          (row?.source === 'WMS' &&
            row?.category === 'warehouse' &&
            row?.targetId &&
            row?.status === 'OVERDUE')
      ),
    details: JSON.stringify({
      total: todoData?.total,
      warehouseCount: todoData?.counts?.warehouse
    })
  })

  await openRoute(page, '/wireSideWarehouse/borrow')
  await page.locator('[data-testid="wms-borrow-page"]').waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '借用归还页面挂在现有仓库管理菜单下，展示已归还、未归还和逾期筛选',
    passed:
      new URL(page.url()).pathname === '/wireSideWarehouse/borrow' &&
      bodyText.includes('借用归还') &&
      bodyText.includes('新增借用') &&
      bodyText.includes('已归还') &&
      bodyText.includes('未归还') &&
      bodyText.includes('仅看逾期'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'wms-borrow-page', record)
  caseRecord.evidence.push('真实登录、借用归还分页接口、仓库菜单路由和浏览器截图')
  return { token, api }
}
