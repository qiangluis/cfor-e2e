import { createApiClient } from '../lib/api.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { createBorrowFixture, createOpeningInventory, dataOf, inventorySnapshot, isWmsWriteEnabled, pageRows, prepareWmsFixture, cleanupWmsFixtures } from '../lib/wms-fixtures.mjs'

export const cases = ['WMS-BR-001']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const pageResult = await api.getBusiness('/wms/borrow-bill/page?pageNo=1&pageSize=100')
  const { data: pageData, rows } = pageRows(pageResult)
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
  if (!isWmsWriteEnabled()) {
    caseRecord.notes.push('未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建专属借用夹具。')
    return { token, api, partial: true }
  }
  const fixture = await prepareWmsFixture(api, caseRecord, 3)
  try {
    const opening = await createOpeningInventory(api, caseRecord, fixture, fixture.material, fixture.unit.id, 106)
    const before = await inventorySnapshot(api, fixture, fixture.material.id)
    const sourceQty = Number(before.find((row) => String(row.materialId) === String(fixture.material.id))?.qty || 0)
    caseRecord.checks.push({ name: '借用前仓库存在正式库存事实', passed: sourceQty >= 10, details: `qty=${sourceQty}` })
    if (sourceQty < 10) {
      caseRecord.notes.push('106 期初审批后借用源库存未形成，未伪造借用写侧。')
      return { token, api, partial: true }
    }
    const borrow = await createBorrowFixture(api, caseRecord, fixture, fixture.material, fixture.unit.id)
    await api.postBusiness('/wms/borrow-bill/submit', { id: borrow.id })
    let detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '借用提审回读')
    caseRecord.checks.push({ name: '借用正式提交后进入审核或生效状态', passed: ['22', 'AUDITING', 'UNDER_EXECUTION', 'END_OF_AUDIT', 'END_OF_EXECUTION'].includes(String(detail.billStage)) || Number(detail.isEffective) === 1, details: `stage=${detail.billStage}; effective=${detail.isEffective}` })
    if (Number(detail.isEffective) !== 1) {
      await approveWmsProcess({
        api,
        processId: detail.processInstanceId,
        caseRecord,
        record,
        label: '借用',
        reason: 'WMS 借用 BPM 审批通过'
      })
      detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '借用审批后回读')
    }
    caseRecord.checks.push({ name: '借用 BPM 审批完成后单据正式生效', passed: Number(detail.isEffective) === 1, details: `processInstanceId=${detail.processInstanceId || ''}; effective=${detail.isEffective}` })
    if (Number(detail.isEffective) !== 1) return { token, api, partial: true }
    await api.postBusiness('/wms/borrow-bill/borrow', { id: borrow.id })
    detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '借出回读')
    caseRecord.checks.push({ name: '借出后状态为 BORROWED 且未归还数量为 10', passed: detail.borrowStatus === 'BORROWED' && Number(detail.remainingQty) === 10, details: `status=${detail.borrowStatus}; remaining=${detail.remainingQty}` })
    const lineId = detail.lines?.[0]?.id
    await api.postBusiness('/wms/borrow-bill/return', { id: borrow.id, version: detail.version, lines: [{ lineId: String(lineId), returnQty: 4, damagedQty: 0, conditionCode: 'GOOD' }] })
    detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '部分归还回读')
    caseRecord.checks.push({ name: '部分归还后状态为 PARTIAL_RETURNED 且剩余为 6', passed: detail.borrowStatus === 'PARTIAL_RETURNED' && Number(detail.remainingQty) === 6, details: `status=${detail.borrowStatus}; remaining=${detail.remainingQty}` })
    const overReturn = await api.post('/wms/borrow-bill/return', { id: borrow.id, version: detail.version, lines: [{ lineId: String(lineId), returnQty: 7, damagedQty: 0, conditionCode: 'GOOD' }] })
    caseRecord.checks.push({ name: '借用超量归还被拒绝', passed: overReturn?.code !== 0, details: `code=${overReturn?.code}; msg=${overReturn?.msg || overReturn?.message || ''}` })
    await api.postBusiness('/wms/borrow-bill/return', { id: borrow.id, version: detail.version, lines: [{ lineId: String(lineId), returnQty: 6, damagedQty: 0, conditionCode: 'GOOD' }] })
    detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '全量归还回读')
    const after = await inventorySnapshot(api, fixture, fixture.material.id)
    const afterQty = Number(after.find((row) => String(row.materialId) === String(fixture.material.id))?.qty || 0)
    caseRecord.checks.push({ name: '全量归还后状态为 RETURNED 且库存回到 106', passed: detail.borrowStatus === 'RETURNED' && Number(detail.remainingQty) === 0 && afterQty === 106, details: `status=${detail.borrowStatus}; remaining=${detail.remainingQty}; qty=${afterQty}` })
    return { token, api, partial: false }
  } finally {
    await cleanupWmsFixtures(api, caseRecord)
  }
}
