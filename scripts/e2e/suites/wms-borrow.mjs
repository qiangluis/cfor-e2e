import fs from 'node:fs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { approveWmsProcess } from '../lib/wms-approval.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { createBorrowFixture, createOpeningInventory, dataOf, inventorySnapshot, isWmsWriteEnabled, pageRows, prepareWmsFixture, cleanupWmsFixtures } from '../lib/wms-fixtures.mjs'

export const cases = ['WMS-BR-001']

export const borrowCatalogBindings = Object.freeze({
  0: ['专属逾期借用分页过滤返回累计借用、累计归还、未归还和逾期字段'],
  1: ['专属借用详情与分页记录只使用允许的业务状态'],
  2: [
    '借用归还页面挂在现有仓库管理菜单下，展示已归还、未归还和逾期筛选',
    '专属逾期借用可在页面按单号和仅看逾期筛选并打开详情'
  ],
  3: ['专属逾期借用可从工作台仓库待办跳回带 marker 的借用详情']
})

/**
 * Original catalog assertions may only become VERIFIED through exact named
 * checks from this run; missing or duplicate facts deliberately fail closed.
 */
export function borrowCatalogEvidence (caseRecord) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'WMS-BR-001')
  if (!definition) throw new Error('缺少原 catalog 案例 WMS-BR-001')

  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => {
    const evidenceChecks = borrowCatalogBindings[index] || []
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
        : '本轮缺少精确具名的真实接口、页面或工作台跳转证据'
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

const hasAllowedBorrowShape = (row, validStatuses) => Boolean(
  row?.id && row?.billNo && row?.warehouseId && row?.borrowerId &&
  validStatuses.has(row?.borrowStatus) && row?.totalBorrowQty !== undefined &&
  row?.totalReturnedQty !== undefined && row?.remainingQty !== undefined &&
  typeof row?.overdue === 'boolean' && Array.isArray(row?.lines)
)

const verifyBorrowPageFilter = async (page, billNo, marker) => {
  try {
    const queryResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' &&
        url.pathname.endsWith('/wms/borrow-bill/page') && url.searchParams.get('billNo') === billNo &&
        url.searchParams.get('overdueOnly') === 'true'
    })
    await page.locator('input[placeholder="请输入借用单号"]').fill(billNo)
    await page.locator('.el-form-item').filter({ hasText: '仅看逾期' }).locator('.el-switch').click()
    await Promise.all([
      queryResponse,
      page.getByRole('button', { name: '查询', exact: true }).first().click()
    ])
    const table = page.locator('[data-testid="wms-borrow-table"]')
    const billLink = table.getByText(billNo, { exact: true }).first()
    await billLink.waitFor({ state: 'visible' })
    const rows = await table.locator('.el-table__body-wrapper tbody tr').allInnerTexts()
    await billLink.click()
    const dialog = page.locator('.el-dialog').filter({ hasText: `借用归还详情 - ${billNo}` }).last()
    await dialog.waitFor({ state: 'visible' })
    const markerVisible = await dialog.locator('input, textarea').evaluateAll((inputs, value) =>
      inputs.some((input) => String(input.value || '').includes(String(value))), marker)
    return {
      passed: rows.length > 0 && rows.every((row) => row.includes(billNo)) && markerVisible,
      details: `billNo=${billNo}; rows=${rows.length}; marker=${markerVisible}`
    }
  } catch (error) {
    return { passed: false, details: `借用页面逾期筛选或详情未形成：${error.message}` }
  }
}

const verifyWorkbenchOverdueNavigation = async (page, borrow, marker) => {
  try {
    await openRoute(page, '/index', { readySelector: '.personal-workbench .todo-panel' })
    const todoResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' &&
        url.pathname.endsWith('/workbench/todo/page') && url.searchParams.get('category') === 'warehouse'
    })
    await page.locator('.todo-source-filter .el-select').click()
    await page.getByText('仓库', { exact: true }).last().click()
    await todoResponse
    const todoItem = page.locator('.todo-panel .work-list-row').filter({ hasText: borrow.billNo }).first()
    await todoItem.waitFor({ state: 'visible' })
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/wireSideWarehouse/borrow' &&
        url.searchParams.get('id') === String(borrow.id)),
      todoItem.click()
    ])
    await page.locator('[data-testid="wms-borrow-page"]').waitFor({ state: 'visible' })
    const dialog = page.locator('.el-dialog').filter({ hasText: `借用归还详情 - ${borrow.billNo}` }).last()
    await dialog.waitFor({ state: 'visible' })
    const markerVisible = await dialog.locator('input, textarea').evaluateAll((inputs, value) =>
      inputs.some((input) => String(input.value || '').includes(String(value))), marker)
    return {
      passed: markerVisible,
      details: `id=${borrow.id}; billNo=${borrow.billNo}; marker=${markerVisible}; url=${page.url()}`
    }
  } catch (error) {
    return { passed: false, details: `工作台未能跳回本轮借用详情：${error.message}` }
  }
}

export const borrowOverReturnRejection = {
  code: 500,
  message: '归还数量不能超过未归还数量',
  allowServiceCode: true
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
  borrowOverReturnRejection,
  expectedCleanupRejection,
  withCleanupRejectionContracts,
  borrowCatalogBindings,
  borrowCatalogEvidence
}

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const pageResult = await api.getBusiness('/wms/borrow-bill/page?pageNo=1&pageSize=100')
  const { data: pageData, rows } = pageRows(pageResult)
  const validStatuses = new Set(['DRAFT', 'BORROWED', 'PARTIAL_RETURNED', 'RETURNED', 'CANCELLED'])
  caseRecord.checks.push({
    name: '借用归还分页契约返回累计借用、累计归还、未归还和逾期字段且分页不超过 100',
    passed: typeof pageData?.total === 'number' && rows.length <= 100 &&
      rows.every((row) => hasAllowedBorrowShape(row, validStatuses)),
    details: JSON.stringify({ total: pageData?.total, count: rows.length })
  })
  caseRecord.checks.push({
    name: '借用归还分页业务状态只允许 DRAFT、BORROWED、PARTIAL_RETURNED、RETURNED、CANCELLED',
    passed: rows.every((row) => validStatuses.has(row?.borrowStatus)),
    details: JSON.stringify({ count: rows.length, statuses: rows.map((row) => row?.borrowStatus) })
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
    borrowCatalogEvidence(caseRecord)
    return { token, api, partial: true }
  }
  const fixture = await prepareWmsFixture(api, caseRecord, 3)
  let partial = false
  try {
    await createOpeningInventory(api, caseRecord, fixture, fixture.material, fixture.unit.id, 106)
    const before = await inventorySnapshot(api, fixture, fixture.material.id)
    const sourceQty = Number(before.find((row) => String(row.materialId) === String(fixture.material.id))?.qty || 0)
    caseRecord.checks.push({ name: '借用前仓库存在正式库存事实', passed: sourceQty >= 10, details: `qty=${sourceQty}` })
    if (sourceQty < 10) {
      caseRecord.notes.push('106 期初审批后借用源库存未形成，未伪造借用写侧。')
      partial = true
    } else {
      const borrow = await createBorrowFixture(api, caseRecord, fixture, fixture.material, fixture.unit.id)
      let detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '借用草稿回读')
      const overdueDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      try {
        await api.putBusiness('/wms/borrow-bill/update', {
          ...borrow.body,
          id: borrow.id,
          version: detail.version,
          expectedReturnDate: overdueDate,
          submitAfterCreate: false
        })
        detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '借用到期前置回读')
        caseRecord.checks.push({
          name: '专属借用通过正式更新接口将预计归还前置到过去且保持草稿',
          passed: detail.borrowStatus === 'DRAFT' && Number(detail.isEffective) !== 1 &&
            Date.parse(detail.expectedReturnDate) < Date.now(),
          details: `status=${detail.borrowStatus}; effective=${detail.isEffective}; expectedReturnDate=${detail.expectedReturnDate}`
        })
      } catch (error) {
        partial = true
        caseRecord.checks.push({
          name: '专属借用通过正式更新接口将预计归还前置到过去且保持草稿',
          passed: false,
          details: `缺少本轮合法逾期样本：${error.message}`
        })
        caseRecord.notes.push('WMS-BR-001 工作台逾期断言保留 GAP：正式更新接口未能为本轮专属草稿前置还期。')
      }
      if (!partial) {
        await api.postBusiness('/wms/borrow-bill/submit', { id: borrow.id })
        detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '借用提审回读')
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
        if (Number(detail.isEffective) !== 1) {
          partial = true
        } else {
          await api.postBusiness('/wms/borrow-bill/borrow', { id: borrow.id })
          detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '借出回读')
          caseRecord.checks.push({ name: '借出后状态为 BORROWED、未归还数量为 10 且已逾期', passed: detail.borrowStatus === 'BORROWED' && Number(detail.remainingQty) === 10 && detail.overdue === true, details: `status=${detail.borrowStatus}; remaining=${detail.remainingQty}; overdue=${detail.overdue}` })
          const filtered = pageRows(await api.getBusiness(
            `/wms/borrow-bill/page?pageNo=1&pageSize=100&billNo=${encodeURIComponent(detail.billNo)}&overdueOnly=true`
          )).rows.find((row) => String(row?.id) === String(borrow.id))
          caseRecord.checks.push({
            name: '专属逾期借用分页过滤返回累计借用、累计归还、未归还和逾期字段',
            passed: hasAllowedBorrowShape(filtered, validStatuses) && filtered.overdue === true &&
              Number(filtered.remainingQty) === 10,
            details: `id=${borrow.id}; billNo=${detail.billNo}; remaining=${filtered?.remainingQty}; overdue=${filtered?.overdue}`
          })
          caseRecord.checks.push({
            name: '专属借用详情与分页记录只使用允许的业务状态',
            passed: validStatuses.has(detail.borrowStatus) && validStatuses.has(filtered?.borrowStatus),
            details: `detail=${detail.borrowStatus}; page=${filtered?.borrowStatus}`
          })
          const pageEvidence = await verifyBorrowPageFilter(page, detail.billNo, fixture.token)
          caseRecord.checks.push({
            name: '专属逾期借用可在页面按单号和仅看逾期筛选并打开详情',
            ...pageEvidence
          })
          await saveScreenshot(page, outputDir, 'wms-borrow-overdue-detail', record)
          const workbenchEvidence = await verifyWorkbenchOverdueNavigation(page, detail, fixture.token)
          caseRecord.checks.push({
            name: '专属逾期借用可从工作台仓库待办跳回带 marker 的借用详情',
            ...workbenchEvidence
          })
          if (!workbenchEvidence.passed) {
            partial = true
            caseRecord.notes.push('WMS-BR-001 工作台逾期断言保留 GAP：本轮专属逾期单未能从工作台入口打开带 marker 的详情。')
          }
          await saveScreenshot(page, outputDir, 'wms-borrow-workbench-detail', record)
          const lineId = detail.lines?.[0]?.id
          await api.postBusiness('/wms/borrow-bill/return', { id: borrow.id, version: detail.version, lines: [{ lineId: String(lineId), returnQty: 4, damagedQty: 0, conditionCode: 'GOOD' }] })
          detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '部分归还回读')
          caseRecord.checks.push({ name: '部分归还后状态为 PARTIAL_RETURNED 且剩余为 6', passed: detail.borrowStatus === 'PARTIAL_RETURNED' && Number(detail.remainingQty) === 6, details: `status=${detail.borrowStatus}; remaining=${detail.remainingQty}` })
          const overReturn = await api.post('/wms/borrow-bill/return', { id: borrow.id, version: detail.version, lines: [{ lineId: String(lineId), returnQty: 7, damagedQty: 0, conditionCode: 'GOOD' }] }, {
            expectedBusinessRejection: borrowOverReturnRejection
          })
          caseRecord.checks.push({
            name: '借用超量归还被拒绝',
            passed: matchesExpectedBusinessRejection(overReturn, borrowOverReturnRejection),
            details: `code=${overReturn?.code}; msg=${overReturn?.msg || overReturn?.message || ''}`
          })
          await api.postBusiness('/wms/borrow-bill/return', { id: borrow.id, version: detail.version, lines: [{ lineId: String(lineId), returnQty: 6, damagedQty: 0, conditionCode: 'GOOD' }] })
          detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(borrow.id)}`), '全量归还回读')
          const after = await inventorySnapshot(api, fixture, fixture.material.id)
          const afterQty = Number(after.find((row) => String(row.materialId) === String(fixture.material.id))?.qty || 0)
          caseRecord.checks.push({ name: '全量归还后状态为 RETURNED 且库存回到 106', passed: detail.borrowStatus === 'RETURNED' && Number(detail.remainingQty) === 0 && afterQty === 106, details: `status=${detail.borrowStatus}; remaining=${detail.remainingQty}; qty=${afterQty}` })
        }
      }
    }
  } finally {
    await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
  }
  borrowCatalogEvidence(caseRecord)
  return { token, api, partial: partial || !caseRecord.passCandidate }
}
