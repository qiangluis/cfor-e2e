import { createApiClient } from '../lib/api.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { createOpeningInventory, createTransferFixture, dataOf, inventorySnapshot, isWmsWriteEnabled, pageRows, prepareWmsFixture, cleanupWmsFixtures } from '../lib/wms-fixtures.mjs'

export const cases = ['WMS-TR-001']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const pageResult = await api.getBusiness('/wms/transfer-bill/page?pageNo=1&pageSize=100')
  const { data: pageData, rows } = pageRows(pageResult)
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
  if (!isWmsWriteEnabled()) {
    caseRecord.notes.push('未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建专属调拨夹具。')
    return { token, api, partial: true }
  }

  const source = await prepareWmsFixture(api, caseRecord, 1)
  const target = await prepareWmsFixture(api, caseRecord, 2)
  try {
    const opening = await createOpeningInventory(api, caseRecord, source, source.material, source.unit.id, 106)
    const before = await inventorySnapshot(api, source, source.material.id)
    const seeded = before.find((row) => String(row.materialId) === String(source.material.id))
    caseRecord.checks.push({ name: '调拨前源仓库存在正式库存事实', passed: Boolean(seeded) && Number(seeded.qty) >= 10, details: seeded ? `qty=${seeded.qty}` : '无源库存' })
    if (!seeded || Number(seeded.qty) < 10) {
      caseRecord.notes.push('106 期初审批后源库存未形成，未伪造调拨写侧。')
      return { token, api, partial: true }
    }
    const transfer = await createTransferFixture(api, caseRecord, source, source.material, source.unit.id, target)
    await api.postBusiness('/wms/transfer-bill/submit', { id: transfer.id })
    let detail = dataOf(await api.getBusiness(`/wms/transfer-bill/get?id=${encodeURIComponent(transfer.id)}`), '调拨提审回读')
    caseRecord.checks.push({ name: '调拨正式提交后进入审核或生效状态', passed: ['22', 'AUDITING', 'UNDER_EXECUTION', 'END_OF_AUDIT', 'END_OF_EXECUTION'].includes(String(detail.billStage)) || Number(detail.isEffective) === 1, details: `stage=${detail.billStage}; effective=${detail.isEffective}` })
    if (Number(detail.isEffective) !== 1) {
      await approveWmsProcess({
        api,
        processId: detail.processInstanceId,
        caseRecord,
        record,
        label: '调拨',
        reason: 'WMS 调拨 BPM 审批通过'
      })
      detail = dataOf(await api.getBusiness(`/wms/transfer-bill/get?id=${encodeURIComponent(transfer.id)}`), '调拨审批后回读')
    }
    caseRecord.checks.push({ name: '调拨 BPM 审批完成后单据正式生效', passed: Number(detail.isEffective) === 1, details: `processInstanceId=${detail.processInstanceId || ''}; effective=${detail.isEffective}` })
    if (Number(detail.isEffective) !== 1) return { token, api, partial: true }
    await api.postBusiness('/wms/transfer-bill/outbound', { id: transfer.id })
    detail = dataOf(await api.getBusiness(`/wms/transfer-bill/get?id=${encodeURIComponent(transfer.id)}`), '调拨调出回读')
    caseRecord.checks.push({ name: '调拨调出后状态为 IN_TRANSIT 且在途量为 10', passed: detail.transferStatus === 'IN_TRANSIT' && Number(detail.inTransitQty) === 10, details: `status=${detail.transferStatus}; inTransit=${detail.inTransitQty}` })
    await api.postBusiness('/wms/transfer-bill/inbound', { id: transfer.id })
    detail = dataOf(await api.getBusiness(`/wms/transfer-bill/get?id=${encodeURIComponent(transfer.id)}`), '调拨调入回读')
    const afterSource = await inventorySnapshot(api, source, source.material.id)
    const afterTarget = await inventorySnapshot(api, target, source.material.id)
    const sourceQty = Number(afterSource.find((row) => String(row.materialId) === String(source.material.id))?.qty || 0)
    const targetQty = Number(afterTarget.find((row) => String(row.materialId) === String(source.material.id))?.qty || 0)
    caseRecord.checks.push({ name: '调拨调入完成状态、在途归零和库存事实守恒', passed: detail.transferStatus === 'COMPLETED' && Number(detail.inTransitQty) === 0 && sourceQty === 96 && targetQty === 10, details: `status=${detail.transferStatus}; source=${sourceQty}; target=${targetQty}; inTransit=${detail.inTransitQty}` })
    return { token, api, partial: false }
  } finally {
    await cleanupWmsFixtures(api, caseRecord)
  }
}
