import fs from 'node:fs'
import { createApiClient } from '../lib/api.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { createOpeningInventory, createTransferFixture, dataOf, inventorySnapshot, isWmsWriteEnabled, pageRows, prepareWmsFixture, cleanupWmsFixtures } from '../lib/wms-fixtures.mjs'

export const cases = ['WMS-TR-001']

export const transferCatalogBindings = Object.freeze({
  0: ['专属调拨分页过滤返回主表、明细和在途量'],
  1: ['专属调拨详情与分页记录只使用允许的业务状态'],
  2: [
    '跨仓调拨页面挂在现有仓库管理菜单下并可真实渲染',
    '专属调拨可在页面按单号筛选并打开详情'
  ]
})

/**
 * Keep the frozen catalog separate from fixture checks: every original
 * assertion needs its own named, passing runtime evidence before PASS.
 */
export function transferCatalogEvidence (caseRecord) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'WMS-TR-001')
  if (!definition) throw new Error('缺少原 catalog 案例 WMS-TR-001')

  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => {
    const evidenceChecks = transferCatalogBindings[index] || []
    const matches = evidenceChecks.map((name) =>
      caseRecord.checks.filter((check) => check?.name === name))
    const verified = evidenceChecks.length > 0 && matches.every((items) =>
      items.length === 1 && items[0].passed === true)
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks,
      details: verified
        ? matches.flat().map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : '本轮缺少精确具名的真实接口或页面证据'
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status !== 'VERIFIED').map((item) => item.assertion)
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  caseRecord.passCandidate = caseRecord.catalogComplete && caseRecord.checks.length > 0 &&
    caseRecord.checks.every((check) => check?.passed === true)
  caseRecord.notes.push(
    `原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`
  )
  return caseRecord
}

const hasAllowedTransferShape = (row, validStatuses) => Boolean(
  row?.id && row?.billNo && row?.outWarehouseId && row?.inWarehouseId &&
  validStatuses.has(row?.transferStatus) && row?.inTransitQty !== undefined &&
  Array.isArray(row?.lines)
)

const verifyTransferPageFilter = async (page, billNo, marker) => {
  try {
    const queryResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' &&
        url.pathname.endsWith('/wms/transfer-bill/page') && url.searchParams.get('billNo') === billNo
    })
    await page.locator('input[placeholder="请输入调拨单号"]').fill(billNo)
    await Promise.all([
      queryResponse,
      page.getByRole('button', { name: '查询', exact: true }).first().click()
    ])
    const table = page.locator('[data-testid="wms-transfer-table"]')
    const billLink = table.getByText(billNo, { exact: true }).first()
    await billLink.waitFor({ state: 'visible' })
    const rows = await table.locator('.el-table__body-wrapper tbody tr').allInnerTexts()
    await billLink.click()
    const dialog = page.locator('.el-dialog').filter({ hasText: `调拨详情 - ${billNo}` }).last()
    await dialog.waitFor({ state: 'visible' })
    const markerVisible = await dialog.locator('input, textarea').evaluateAll((inputs, value) =>
      inputs.some((input) => String(input.value || '').includes(String(value))), marker)
    return {
      passed: rows.length > 0 && rows.every((row) => row.includes(billNo)) && markerVisible,
      details: `billNo=${billNo}; rows=${rows.length}; marker=${markerVisible}`
    }
  } catch (error) {
    return { passed: false, details: `调拨页面筛选或详情未形成：${error.message}` }
  }
}

const expectedCleanupRejection = (pathname) => {
  if (pathname.startsWith('/mes/basMaterial/delete?')) {
    return { expectedBusinessRejection: {
      code: 500,
      message: /被以下单据引用.*库存记录.*不允许删除/,
      allowServiceCode: true
    } }
  }
  if (pathname.startsWith('/mes/wms-house-location/delete?')) {
    return { expectedBusinessRejection: {
      code: 1001001003,
      message: /已被库存、未完成任务或未完成单据引用/
    } }
  }
  if (pathname.startsWith('/mes/wmsHouseArea/delete?')) {
    return { expectedBusinessRejection: {
      code: 500,
      message: /该库区下存在库位，请先删除库位后再删除库区/,
      allowServiceCode: true
    } }
  }
  if (pathname.startsWith('/mes/wmsWareHouse/delete?')) {
    return { expectedBusinessRejection: {
      code: 500,
      message: /已被引用，不能删除/,
      allowServiceCode: true
    } }
  }
  return undefined
}

const withCleanupRejectionContracts = (api) => ({
  ...api,
  deleteBusiness: (pathname, options) =>
    api.deleteBusiness(pathname, expectedCleanupRejection(pathname) || options)
})

export const __internal = {
  expectedCleanupRejection,
  withCleanupRejectionContracts,
  transferCatalogBindings,
  transferCatalogEvidence
}

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const pageResult = await api.getBusiness('/wms/transfer-bill/page?pageNo=1&pageSize=100')
  const { data: pageData, rows } = pageRows(pageResult)
  const validStatuses = new Set(['DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'])
  caseRecord.checks.push({
    name: '跨仓调拨分页契约返回主表字段、明细和在途量且分页不超过 100',
    passed: typeof pageData?.total === 'number' && rows.length <= 100 &&
      rows.every((row) => hasAllowedTransferShape(row, validStatuses)),
    details: JSON.stringify({ total: pageData?.total, count: rows.length })
  })
  caseRecord.checks.push({
    name: '跨仓调拨分页业务状态只允许 DRAFT、IN_TRANSIT、COMPLETED、CANCELLED',
    passed: rows.every((row) => validStatuses.has(row?.transferStatus)),
    details: JSON.stringify({ count: rows.length, statuses: rows.map((row) => row?.transferStatus) })
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
    transferCatalogEvidence(caseRecord)
    return { token, api, partial: true }
  }

  const source = await prepareWmsFixture(api, caseRecord, 1)
  const target = await prepareWmsFixture(api, caseRecord, 2)
  let partial = false
  try {
    await createOpeningInventory(api, caseRecord, source, source.material, source.unit.id, 106)
    const before = await inventorySnapshot(api, source, source.material.id)
    const seeded = before.find((row) => String(row.materialId) === String(source.material.id))
    caseRecord.checks.push({ name: '调拨前源仓库存在正式库存事实', passed: Boolean(seeded) && Number(seeded.qty) >= 10, details: seeded ? `qty=${seeded.qty}` : '无源库存' })
    if (!seeded || Number(seeded.qty) < 10) {
      caseRecord.notes.push('106 期初审批后源库存未形成，未伪造调拨写侧。')
      partial = true
    } else {
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
      if (Number(detail.isEffective) !== 1) {
        partial = true
      } else {
        await api.postBusiness('/wms/transfer-bill/outbound', { id: transfer.id })
        detail = dataOf(await api.getBusiness(`/wms/transfer-bill/get?id=${encodeURIComponent(transfer.id)}`), '调拨调出回读')
        caseRecord.checks.push({ name: '调拨调出后状态为 IN_TRANSIT 且在途量为 10', passed: detail.transferStatus === 'IN_TRANSIT' && Number(detail.inTransitQty) === 10, details: `status=${detail.transferStatus}; inTransit=${detail.inTransitQty}` })
        const filtered = pageRows(await api.getBusiness(
          `/wms/transfer-bill/page?pageNo=1&pageSize=100&billNo=${encodeURIComponent(detail.billNo)}`
        )).rows.find((row) => String(row?.id) === String(transfer.id))
        caseRecord.checks.push({
          name: '专属调拨分页过滤返回主表、明细和在途量',
          passed: hasAllowedTransferShape(filtered, validStatuses) &&
            filtered.transferStatus === 'IN_TRANSIT' && Number(filtered.inTransitQty) === 10,
          details: `id=${transfer.id}; billNo=${detail.billNo}; status=${filtered?.transferStatus}; inTransit=${filtered?.inTransitQty}`
        })
        caseRecord.checks.push({
          name: '专属调拨详情与分页记录只使用允许的业务状态',
          passed: validStatuses.has(detail.transferStatus) && validStatuses.has(filtered?.transferStatus),
          details: `detail=${detail.transferStatus}; page=${filtered?.transferStatus}`
        })
        const browserEvidence = await verifyTransferPageFilter(page, detail.billNo, source.token)
        caseRecord.checks.push({
          name: '专属调拨可在页面按单号筛选并打开详情',
          ...browserEvidence
        })
        await saveScreenshot(page, outputDir, 'wms-transfer-filtered-detail', record)
        await api.postBusiness('/wms/transfer-bill/inbound', { id: transfer.id })
        detail = dataOf(await api.getBusiness(`/wms/transfer-bill/get?id=${encodeURIComponent(transfer.id)}`), '调拨调入回读')
        const afterSource = await inventorySnapshot(api, source, source.material.id)
        const afterTarget = await inventorySnapshot(api, target, source.material.id)
        const sourceQty = Number(afterSource.find((row) => String(row.materialId) === String(source.material.id))?.qty || 0)
        const targetQty = Number(afterTarget.find((row) => String(row.materialId) === String(source.material.id))?.qty || 0)
        caseRecord.checks.push({ name: '调拨调入完成状态、在途归零和库存事实守恒', passed: detail.transferStatus === 'COMPLETED' && Number(detail.inTransitQty) === 0 && sourceQty === 96 && targetQty === 10, details: `status=${detail.transferStatus}; source=${sourceQty}; target=${targetQty}; inTransit=${detail.inTransitQty}` })
      }
    }
  } finally {
    await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
  }
  transferCatalogEvidence(caseRecord)
  return { token, api, partial: partial || !caseRecord.passCandidate }
}
