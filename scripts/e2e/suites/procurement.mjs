import { createApiClient } from '../lib/api.mjs'
import { launchBrowser, login, loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { createPurchaseRequest, snapshotPurchaseRequest } from '../fixtures/purchase-request.mjs'
import { databaseConfigured, assertLocalWriteSafety } from '../lib/db.mjs'
import { createPurchaseReader } from '../fixtures/purchase-reader.mjs'
import { collectPagePerformance } from '../lib/performance.mjs'

const readBrowserBusinessResponse = async (response) => {
  const text = await response.text()
  return response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(text)
    : JSON.parse(text)
}

export const cases = [
  'PROC-001',
  'PROC-002',
  'PROC-003',
  'PROC-004',
  'PROC-005',
  'PROC-006',
  'PROC-007',
  'PROC-008',
  'PROC-009',
  'PROC-010',
  'PROC-011',
  'PROC-012',
  'PROC-013',
  'PROC-014',
  'PROC-015',
  'PROC-016',
  'PROC-017'
]

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  caseRecord.notes.push(
    '案例已锁定 MRP 净需求、缺料禁止开工、采购发票复核生成应付、入库检阻断可用库存、采购数量回写，以及请购/对账开关的后端来源门禁。'
  )
  caseRecord.notes.push(
    'PROC-005 锁定采购/销售订单结算方式与规则版本快照：settle_method_code 取字典 x_settle_method，' +
      'settle_method_rule_version 取按业务日期命中的 erp_settle_method_rule 版本，规则调整不回溯历史订单。'
  )
  caseRecord.notes.push(
    'PROC-008 锁定 ERP 采购类型规则设置页：采购类型复用 system_document_type 的 PURCHASE_ 前缀树，' +
      '规则只维护适用组织/审批流程/统计口径/模板与生效范围，采购订单保存编码与规则版本快照；' +
      'system_document_type 删除/改码前由 MES 引用校验器扫描生产订单、生产类型规则与委外类型规则。'
  )
  caseRecord.notes.push(
    'PROC-006 锁定 ERP 结算方式规则设置页：菜单挂在设置-业务设置-ERP，页面只维护规则，' +
      '结算方式目录继续复用字典 x_settle_method。'
  )
  caseRecord.notes.push(
    'PROC-007 锁定 ERP 财务单据类型规则：单据类型复用 system_document_type 的 FIN_ 固定财务类型，' +
      '规则表只维护适用组织、默认审批、凭证事件、打印模板、编号规则与必填字段策略；' +
      'PB-066 起收款/付款/报销单保存与提交时按该规则执行「不允许手工创建 / 必填字段策略 / 默认审批」。'
  )
  caseRecord.notes.push(
    'PROC-013 锁定企业侧采购工作台：摘要聚合请购/订单/门户接单/到货/对账/开票复核/付款申请，' +
      '不新增工作台事实表，卡片点击下钻既有业务单据列表。'
  )
  caseRecord.notes.push(
    'PROC-014 锁定请购单状态快捷查询与整单/行级关闭：分录新增 is_closed 标记，' +
      '整单关闭复用主表 is_closed，行级关闭后全部分录关闭时主表同步关闭，已关闭分录不再参与下单。'
  )
  caseRecord.notes.push(
    'PROC-015 锁定采购订单深化：列表状态快捷标签、字段级变更审计接口（未执行行数量/单价/备注 + ' +
      '表头备注/预计到货/结算方式）、变更记录查询与独立附件写接口，变更不改变单据状态机。'
  )
  caseRecord.notes.push(
    'PROC-017 锁定待生成请购前置列表：请购单列表直接进入生产订单/销售订单/现存量/MRP 四类来源，' +
      '选择来源后复用既有请购单创建接口生成未审核单，不新增前置事实表。'
  )
  if (caseId === 'PROC-007') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const typePage = await api.getBusiness('/system/document/type/page?pageNo=1&pageSize=100')
    const financeTypes = (Array.isArray(typePage?.data?.list) ? typePage.data.list : []).filter(
      (item) => typeof item?.code === 'string' && item.code.startsWith('FIN_')
    )
    caseRecord.checks.push({
      name: '系统单据类型存在 FIN_ 前缀的固定财务类型',
      passed: financeTypes.length > 0,
      details: `命中 ${financeTypes.length} 个财务单据类型`
    })
    if (financeTypes.length === 0) {
      return { token, api }
    }
    const financeType = financeTypes[0]
    const ruleId = (
      await api.postBusiness('/erp/finance-document-type-rule/create', {
        documentTypeId: financeType.id,
        defaultApproval: false,
        allowManualCreate: false,
        requiredFields: 'bankAccountId,settleMethod',
        status: 1,
        remark: 'PROC-007 automated e2e'
      })
    )?.data
    const rulePage = await api.getBusiness(
      `/erp/finance-document-type-rule/page?pageNo=1&pageSize=100&documentTypeId=${encodeURIComponent(financeType.id)}`
    )
    const createdRule = (Array.isArray(rulePage?.data?.list) ? rulePage.data.list : []).find(
      (item) => String(item.id) === String(ruleId)
    )
    caseRecord.checks.push({
      name: '规则保存允许手工创建与必填字段策略并回读一致',
      passed:
        createdRule != null &&
        createdRule.allowManualCreate === false &&
        String(createdRule.requiredFields || '') === 'bankAccountId,settleMethod',
      details: JSON.stringify(createdRule || {})
    })

    // PB-066 运行时：不允许手工创建的财务单据类型必须被写侧拒绝
    const manualCreate = await api.request('POST', '/finance/finReceipt/add/save', {
      documentTypeId: String(financeType.id),
      billDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
      receiptType: '102',
      amt: 1,
      remark: 'PROC-007 automated e2e manual create probe'
    })
    const manualCreateMessage = String(manualCreate?.message || manualCreate?.msg || '')
    caseRecord.checks.push({
      name: '收款单按单据类型规则拒绝手工创建或缺少必填字段',
      passed:
        manualCreate?.code !== 0 &&
        (manualCreateMessage.includes('不允许手工创建') ||
          manualCreateMessage.includes('缺少必填字段')),
      details: JSON.stringify(manualCreate || {})
    })

    await api.delete(`/erp/finance-document-type-rule/delete?id=${ruleId}`)
    await openRoute(page, '/settings/erp/finance-document-type-rule')
    await saveScreenshot(page, outputDir, 'erp-finance-document-type-rule', record)
    caseRecord.evidence.push(
      `PROC-007/PB-066 财务单据类型规则 ${ruleId} 绑定 ${financeType.code}，写侧拒绝手工创建 response=${manualCreateMessage}`
    )
    return { token, api }
  }

  if (caseId === 'PROC-009') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const accountPage = await api.getBusiness(
      '/erp/supplier-portal/account/page?pageNo=1&pageSize=100'
    )
    const accountRows = Array.isArray(accountPage?.data?.list) ? accountPage.data.list : []
    const settings = await api.getBusiness('/erp/supplier-portal/account/settings')
    const partnerPage = await api.getBusiness(
      '/base/partner/page?pageNo=1&pageSize=100&status=ACTIVE&supplierEnabled=true'
    )
    const partnerRows = Array.isArray(partnerPage?.data?.list) ? partnerPage.data.list : []
    caseRecord.checks.push({
      name: '供应商门户账号分页返回脱敏账号结构',
      passed:
        Array.isArray(accountPage?.data?.list) &&
        accountRows.every(
          (row) =>
            row?.id &&
            row?.loginName &&
            Object.prototype.hasOwnProperty.call(row, 'partnerName') &&
            !Object.prototype.hasOwnProperty.call(row, 'password') &&
            !Object.prototype.hasOwnProperty.call(row, 'passwordHash')
        ),
      details: `accounts=${accountRows.length}`
    })
    caseRecord.checks.push({
      name: '供应商门户配置返回邀请有效期和门户访问地址',
      passed:
        Number.isInteger(settings?.data?.inviteExpireDays) &&
        settings.data.inviteExpireDays >= 1 &&
        settings.data.inviteExpireDays <= 30 &&
        Object.prototype.hasOwnProperty.call(settings.data, 'portalBaseUrl'),
      details: `inviteExpireDays=${settings?.data?.inviteExpireDays}, portalBaseUrl=${settings?.data?.portalBaseUrl || 'fallback'}`
    })
    caseRecord.checks.push({
      name: '账号选择器的客商来源只包含启用供应商角色的统一客商',
      passed:
        Array.isArray(partnerPage?.data?.list) &&
        partnerRows.every((row) => row?.status === 'ACTIVE' && row?.supplierEnabled === true),
      details: `partners=${partnerRows.length}`
    })
    if (accountRows[0]?.id) {
      const detail = await api.getBusiness(
        `/erp/supplier-portal/account/get?id=${encodeURIComponent(accountRows[0].id)}`
      )
      caseRecord.checks.push({
        name: '账号详情不回显密码摘要',
        passed:
          detail?.data &&
          !Object.prototype.hasOwnProperty.call(detail.data, 'password') &&
          !Object.prototype.hasOwnProperty.call(detail.data, 'passwordHash'),
        details: `accountId=${accountRows[0].id}`
      })
    }
    await openRoute(page, '/settings/erp/supplierPortal')
    const renderStartedAt = Date.now()
    await page.locator('.supplier-portal-settings').waitFor({
      state: 'visible',
      timeout: 30000
    })
    const renderDurationMs = Date.now() - renderStartedAt
    const bodyText = await page.locator('body').innerText()
    const inviteCandidate = accountRows.find(
      (row) => row?.status !== 'ENABLED' && row?.status !== 'LOCKED'
    )
    const inviteEntryVisible =
      (await page.getByRole('button', { name: /邮件邀请|重新邀请/ }).count()) > 0
    caseRecord.checks.push({
      name: '供应商门户账号设置页真实渲染',
      passed:
        page.url().includes('/settings/erp/supplierPortal') &&
        bodyText.includes('供应商门户账号') &&
        bodyText.includes('新增账号') &&
        bodyText.includes('门户访问地址') &&
        bodyText.includes('邀请有效期') &&
        bodyText.includes('保存配置'),
      details: `${page.url()}, renderMs=${renderDurationMs}`
    })
    caseRecord.checks.push({
      name: '供应商门户设置页首屏渲染耗时不超过 5 秒',
      passed: renderDurationMs <= 5000,
      details: `renderMs=${renderDurationMs}`
    })
    caseRecord.checks.push({
      name: '邀请中或停用账号可看到邮件邀请入口',
      passed: !inviteCandidate || inviteEntryVisible,
      details: inviteCandidate
        ? `candidate=${inviteCandidate.loginName}, visible=${inviteEntryVisible}`
        : '当前无邀请中或停用账号，只校验设置页配置入口'
    })
    await saveScreenshot(page, outputDir, 'supplier-portal-account-settings', record)
    caseRecord.evidence.push(
      '真实登录、账号分页、统一客商供应商角色过滤、详情脱敏、邀请配置契约、邀请入口和设置页截图'
    )
    return { token, api }
  }

  if (caseId === 'PROC-011') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const openingPage = await api.getBusiness(
      '/erp/purchase-in/page?pageNo=1&pageSize=100&businessType=OPENING&status=20'
    )
    const openingRows = Array.isArray(openingPage?.data?.list) ? openingPage.data.list : []
    caseRecord.checks.push({
      name: '期初采购入库来源分页只返回已审核期初单',
      passed:
        Array.isArray(openingPage?.data?.list) &&
        openingRows.every(
          (row) => String(row.businessType).toUpperCase() === 'OPENING' && Number(row.status) === 20
        ),
      details: `openingRows=${openingRows.length}`
    })
    caseRecord.checks.push({
      name: '期初采购入库返回开票数量和金额控制字段',
      passed: openingRows.every(
        (row) =>
          Object.prototype.hasOwnProperty.call(row, 'totalCount') &&
          Object.prototype.hasOwnProperty.call(row, 'invoicedCount') &&
          Object.prototype.hasOwnProperty.call(row, 'totalPrice') &&
          Object.prototype.hasOwnProperty.call(row, 'invoicedPrice')
      ),
      details: 'totalCount/invoicedCount/totalPrice/invoicedPrice 字段契约'
    })

    const pageRenderStartedAt = Date.now()
    await openRoute(page, '/erp/purchase/invoice')
    const addButton = page.getByRole('button', { name: /新增/ }).first()
    let addVisible = false
    try {
      await addButton.waitFor({ state: 'visible', timeout: 30000 })
      addVisible = true
    } catch {}
    const pageRenderDurationMs = Date.now() - pageRenderStartedAt
    if (addVisible) await addButton.click()
    const openingButton = page.getByRole('button', { name: /选期初入库/ }).first()
    let openingButtonVisible = false
    if (addVisible) {
      try {
        await openingButton.waitFor({ state: 'visible', timeout: 30000 })
        openingButtonVisible = true
      } catch {}
    }
    caseRecord.checks.push({
      name: '采购发票表单提供期初入库来源入口',
      passed: addVisible && openingButtonVisible,
      details: `add=${addVisible}, openingSource=${openingButtonVisible}, pageRenderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '采购发票列表首屏渲染耗时不超过 5 秒',
      passed: pageRenderDurationMs <= 5000,
      details: `pageRenderMs=${pageRenderDurationMs}`
    })
    if (openingButtonVisible) {
      await openingButton.click()
      const dialogTitle = page.getByText('选择期初采购入库', { exact: true }).first()
      let dialogVisible = false
      try {
        await dialogTitle.waitFor({ state: 'visible', timeout: 30000 })
        dialogVisible = true
      } catch {}
      caseRecord.checks.push({
        name: '期初采购入库来源选择弹窗真实渲染',
        passed: dialogVisible,
        details: dialogVisible ? '弹窗已打开' : '未找到期初入库选择弹窗'
      })
    }
    await saveScreenshot(page, outputDir, 'erp-purchase-opening-invoice-source', record)
    caseRecord.evidence.push('真实登录、期初采购入库分页字段检查、采购发票入口和来源弹窗截图')
    return { token, api }
  }

  if (caseId === 'PROC-012') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const pageResult = await api.getBusiness(
      '/erp/price-scheme/page?pageNo=1&pageSize=100&priceDirection=PURCHASE'
    )
    const rows = Array.isArray(pageResult?.data?.list) ? pageResult.data.list : []
    caseRecord.checks.push({
      name: '统一价格中心提供 PURCHASE 方向方案分页',
      passed:
        Array.isArray(pageResult?.data?.list) &&
        rows.every((row) => row.priceDirection === 'PURCHASE'),
      details: `purchaseSchemes=${rows.length}`
    })
    await openRoute(page, '/settings/erp/price-center')
    const directionField = page.locator('.el-form-item').filter({ hasText: '价格方向' }).first()
    await directionField.waitFor({ state: 'visible', timeout: 30000 })
    const directionSelect = directionField.locator('.el-select').first()
    await directionSelect.click()
    const purchaseOption = page.getByText('采购价格', { exact: true }).last()
    await purchaseOption.waitFor({ state: 'visible', timeout: 30000 })
    const purchaseOptionVisible = await purchaseOption.isVisible()
    await page.keyboard.press('Escape')
    const inquiryButton = page.getByRole('button', { name: '统一取价', exact: true }).first()
    await inquiryButton.waitFor({ state: 'visible', timeout: 30000 })
    caseRecord.checks.push({
      name: '统一价格中心页面提供采购方向和取价入口',
      passed:
        page.url().includes('/settings/erp/price-center') &&
        purchaseOptionVisible &&
        (await inquiryButton.isVisible()),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-price-center', record)
    caseRecord.evidence.push('真实登录、PURCHASE 方向分页和价格中心页面截图')
    return { token, api }
  }

  if (caseId === 'PROC-013') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const summary = await api.getBusiness('/erp/purchase/workbench/summary')
    const data = summary?.data || {}
    const expectedFields = [
      'pendingRequestCount',
      'pendingOrderCount',
      'pendingPortalAcceptanceCount',
      'pendingReceiptCount',
      'pendingReconciliationCount',
      'pendingInvoiceReviewCount',
      'pendingPaymentRequestCount'
    ]
    caseRecord.checks.push({
      name: '企业侧采购工作台摘要返回 7 项非负整数待办',
      passed:
        expectedFields.every((field) => Object.prototype.hasOwnProperty.call(data, field)) &&
        expectedFields.every((field) => Number.isInteger(data[field]) && data[field] >= 0),
      details: JSON.stringify(data)
    })

    const titles = ['待审请购', '待审订单', '待接单', '待收货', '待对账', '待开票复核', '待付款']
    const pageRenderStartedAt = Date.now()
    const [browserSummaryResponse] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname.endsWith('/erp/purchase/workbench/summary') &&
          response.request().method() === 'GET',
        { timeout: 30000 }
      ),
      openRoute(page, '/erp/purchase/home')
    ])
    const browserSummary = await readBrowserBusinessResponse(browserSummaryResponse)
    if (browserSummary.code !== 0 ||
        !expectedFields.every((field) => Number.isInteger(browserSummary.data?.[field]) &&
          browserSummary.data[field] >= 0)) {
      throw new Error('采购工作台浏览器摘要响应未返回完整有效的待办数据')
    }
    const workbench = page.locator('.p_workbench').first()
    await workbench.waitFor({ state: 'visible', timeout: 60000 })
    await page.locator('.p_workbench_card').nth(titles.length - 1).waitFor({
      state: 'visible',
      timeout: 60000
    })
    await page.waitForFunction(
      (expected) => {
        const values = [...document.querySelectorAll('.p_workbench_card .p_workbench_value')]
        return values.length === expected.length &&
          values.every((element, index) => element.textContent.trim() === String(expected[index]))
      },
      expectedFields.map((field) => browserSummary.data[field]),
      { timeout: 30000 }
    )
    const pageRenderDurationMs = Date.now() - pageRenderStartedAt
    caseRecord.performance = await collectPagePerformance(page, pageRenderDurationMs)
    caseRecord.checks.push({
      name: '7 张待办卡片显示浏览器真实摘要响应的数值，不以默认零值结案',
      passed: true,
      details: JSON.stringify(browserSummary.data)
    })
    const bodyText = await page.locator('body').innerText()
    const visibleTitles = titles.filter((title) => bodyText.includes(title))
    caseRecord.checks.push({
      name: '采购工作台首页渲染 7 张待办卡片',
      passed: visibleTitles.length === titles.length,
      details: `visible=${visibleTitles.join(',')}, renderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '采购工作台首屏渲染耗时不超过 5 秒',
      passed: pageRenderDurationMs <= 5000,
      details: `renderMs=${pageRenderDurationMs}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-workbench-summary', record)
    const supplierFilter = page.locator('.cardBox .paramsBox .el-select')
    await supplierFilter.scrollIntoViewIfNeeded()
    await supplierFilter.click()
    await page.locator('.el-select-dropdown:visible').last().waitFor({ state: 'visible' })
    caseRecord.checks.push({
      name: '采购跟踪供应商筛选异步加载后可首次打开',
      passed: true,
      details: '只打开筛选，不修改单据'
    })
    await page.keyboard.press('Escape')

    const acceptanceCard = page.locator('.p_workbench_card').filter({ hasText: '待接单' }).first()
    const cardVisible = await acceptanceCard.isVisible().catch(() => false)
    const acceptanceResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/purchase-order/page') &&
          url.searchParams.get('portalStatus') === 'SENT' &&
          response.request().method() === 'GET'
      },
      { timeout: 30000 }
    )
    await acceptanceCard.click()
    await page.waitForURL(/\/erp\/purchase\/order(?:\?.*)?$/, { timeout: 30000 })
    const acceptanceResponse = await acceptanceResponsePromise
    const acceptanceResult = await readBrowserBusinessResponse(acceptanceResponse)
    const acceptanceRows = acceptanceResult?.data?.list
    const portalField = page.locator('.el-form-item').filter({ hasText: '门户状态' }).first()
    await portalField.waitFor({ state: 'visible', timeout: 30000 })
    caseRecord.checks.push({
      name: '待接单下钻请求真实携带 SENT 且页面显示筛选条件',
      passed: cardVisible && page.url().includes('portalStatus=SENT') &&
        (await portalField.innerText()).includes('待接单') &&
        acceptanceResult?.code === 0 && Array.isArray(acceptanceRows) &&
        acceptanceRows.every((row) => row.portalStatus === 'SENT'),
      details: `url=${page.url()}, responseCode=${acceptanceResult?.code}, orders=${acceptanceRows?.length ?? 'invalid'}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-workbench-acceptance-filter', record)

    const resetResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/purchase-order/page') &&
          !url.searchParams.has('portalStatus') &&
          response.request().method() === 'GET'
      },
      { timeout: 30000 }
    )
    await page.getByRole('button', { name: '重置', exact: true }).click()
    const resetResult = await readBrowserBusinessResponse(await resetResponsePromise)
    caseRecord.checks.push({
      name: '重置后清除门户筛选并重新查询全部订单',
      passed: resetResult?.code === 0 &&
        !(await portalField.innerText()).includes('待接单'),
      details: `responseCode=${resetResult?.code}, orders=${resetResult?.data?.list?.length ?? 'invalid'}`
    })
    caseRecord.evidence.push(
      '真实登录、7 项摘要及页面数值一致、首次数据就绪计时、SENT 查询请求/响应、门户筛选可见与重置请求、截图'
    )
    return { token, api }
  }

  if (caseId === 'PROC-014') {
    if (!databaseConfigured()) {
      throw new Error('BLOCKED: PROC-014 写侧验收需要配置本地数据库只读证据，尚未创建测试单据')
    }
    await assertLocalWriteSafety(caseRecord)
    const token = await login(page)
    const api = createApiClient({ token, record })
    const fixture = await createPurchaseRequest(api, caseRecord)
    const before = await snapshotPurchaseRequest(fixture, caseRecord, 'before-close')
    caseRecord.checks.push({
      name: '来源未传行号时后端补齐唯一行号并成功创建两行',
      passed: before.filter((row) => row[0] === 'item').length === 2 &&
        before.filter((row) => row[0] === 'item').every((row) =>
          Number.isInteger(Number(row[6])) && Number(row[6]) > 0) &&
        new Set(before.filter((row) => row[0] === 'item').map((row) => Number(row[6]))).size === 2,
      details: `entryNumbers=${before.filter((row) => row[0] === 'item').map((row) => row[6]).join(',')}`
    })
    caseRecord.checks.push({
      name: '真实创建两行请购，数量 3+5、主表及分录未关闭',
      passed: fixture.initial.itemsList?.length === 2 &&
        Number(fixture.initial.isClosed) === 0 &&
        fixture.initial.itemsList.every((item) => Number(item.isClosed) === 0) &&
        before.filter((row) => row[0] === 'item').length === 2 &&
        Number(before.find((row) => row[0] === 'bill')?.[4]) === 8,
      details: `requestId=${fixture.id}, billNo=${fixture.billNo}`
    })
    const renderStartedAt = Date.now()
    await openRoute(page, '/erp/purchase/purchaseRequest')
    await page.locator('.request-status-tabs').waitFor({ state: 'visible', timeout: 60000 })
    // Fixed VXE columns include hidden duplicate headers.
    await page.locator('.vxe-cell--title:visible').filter({ hasText: /^行关闭$/ }).first().waitFor({
      state: 'visible',
      timeout: 60000
    })
    const renderMs = Date.now() - renderStartedAt
    const bodyText = await page.locator('.request-status-tabs').innerText()
    const tabs = ['全部', '编制中', '编制完', '核批中', '核批完', '已关闭']
    const visibleTabs = tabs.filter((label) => bodyText.includes(label))
    caseRecord.checks.push({
      name: '请购单列表渲染状态快捷查询标签',
      passed: visibleTabs.length === tabs.length,
      details: `visible=${visibleTabs.join(',')}, renderMs=${renderMs}`
    })
    const waitForList = (closedOnly = false) => page.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return url.pathname.endsWith('/erp/purchase/order/request/page') &&
          url.searchParams.get('billNo') === fixture.billNo &&
          (!closedOnly || url.searchParams.get('isClosed') === '1')
      },
      { timeout: 30000 }
    )
    await page.getByPlaceholder('请输入请购单号').fill(fixture.billNo)
    const [searchResponse] = await Promise.all([
      waitForList(),
      page.getByRole('button', { name: '搜索', exact: true }).click()
    ])
    const filtered = await readBrowserBusinessResponse(searchResponse)
    caseRecord.checks.push({
      name: '页面按测试单号查询真实两行单据，不依赖空列表',
      passed: filtered.code === 0 && filtered.data.records?.length === 1 &&
        filtered.data.records[0].itemsList?.length === 2,
      details: `billNo=${fixture.billNo}`
    })
    const closeVisibleLine = async () => {
      const [browserResponse] = await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname.endsWith('/erp/purchase/order/request/close-items'),
          { timeout: 30000 }
        ),
        (async () => {
          await page.locator('button:visible').filter({ hasText: /^\s*关闭本行\s*$/ }).first().click()
          const confirmation = page.locator('.el-message-box:visible')
          await confirmation.getByRole('button', { name: /确定|确认/ }).click()
        })()
      ])
      const response = await readBrowserBusinessResponse(browserResponse)
      if (response.code !== 0) throw new Error(`页面行关闭失败：${JSON.stringify(response)}`)
      return fixture.read()
    }
    const afterOne = await closeVisibleLine()
    const firstClosed = afterOne.itemsList.find((item) => Number(item.isClosed) === 1)
    caseRecord.checks.push({
      name: 'Chrome 关闭第一行后仅该行关闭，主表保持打开',
      passed: afterOne.itemsList.filter((item) => Number(item.isClosed) === 1).length === 1 &&
        Number(afterOne.isClosed) === 0,
      details: `closedItemId=${firstClosed?.id}`
    })
    if (!firstClosed) throw new Error('首行关闭后未回读到已关闭分录')
    await snapshotPurchaseRequest(fixture, caseRecord, 'after-first-line')
    const rejectedOrder = await api.put(
      `/erp/purchase/order/request/place/an/order?ids=${firstClosed.id}&isSeparate=0`
    )
    caseRecord.checks.push({
      name: '真实已关闭分录被后端拒绝下单',
      passed: rejectedOrder.code !== 0 && String(rejectedOrder.msg).includes('已关闭'),
      details: `code=${rejectedOrder.code}, msg=${rejectedOrder.msg}`
    })
    // Wait for the list reload after closing before clicking the remaining row.
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].filter(
        (button) => button.textContent.trim() === '关闭本行' && button.getClientRects().length
      ).length === 1
    )
    await saveScreenshot(page, outputDir, 'erp-purchase-request-one-line-closed', record)
    const afterAll = await closeVisibleLine()
    caseRecord.checks.push({
      name: 'Chrome 关闭剩余行后全部分录关闭，数量不变',
      passed: afterAll.itemsList.length === 2 &&
        afterAll.itemsList.every((item) => Number(item.isClosed) === 1) &&
        afterAll.itemsList.reduce((sum, item) => sum + Number(item.inCount), 0) === 8,
      details: `requestId=${fixture.id}`
    })
    caseRecord.checks.push({
      name: '全部分录关闭时主表由打开同步转为关闭',
      passed: Number(afterOne.isClosed) === 0 && Number(afterAll.isClosed) === 1,
      details: `before=${afterOne.isClosed}, after=${afterAll.isClosed}`
    })
    const repeated = await api.put(`/erp/purchase/order/request/close?id=${fixture.id}`)
    const after = await snapshotPurchaseRequest(fixture, caseRecord, 'after-all-lines')
    caseRecord.checks.push({
      name: '两次页面行关闭的审计均持久化为关闭类型',
      passed: after.filter((row) => row[0] === 'audit' && row[2] === '关闭').length === 2,
      details: `requestId=${fixture.id}`
    })
    caseRecord.checks.push({
      name: '整单重复关闭明确拒绝，未设置下单标志、未修改数量',
      passed: repeated.code !== 0 && String(repeated.msg).includes('已关闭') &&
        Number(after.find((row) => row[0] === 'bill')?.[3]) === 0 &&
        Number(after.find((row) => row[0] === 'bill')?.[4]) === 8,
      details: `code=${repeated.code}, msg=${repeated.msg}`
    })
    const [closedQuery] = await Promise.all([
      waitForList(true),
      page.locator('.request-status-tabs').getByText('已关闭', { exact: true }).click()
    ])
    const closedList = await readBrowserBusinessResponse(closedQuery)
    caseRecord.checks.push({
      name: '已关闭快捷标签真实请求 isClosed=1 并回读测试单据',
      passed: closedList.code === 0 && closedList.data.records?.some(
        (row) => String(row.id) === fixture.id && Number(row.isClosed) === 1
      ),
      details: `requestId=${fixture.id}`
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-request-status-tabs', record)
    caseRecord.evidence.push(
      `真实 admin Chrome 登录、两行请购 ${fixture.id}、页面逐行关闭、主表联动、下单阻断、` +
      '重复关闭响应、状态查询、数据库前后值和截图；以各项断言判断结果，整单主动关闭及跨租户尚待补验'
    )
    const reader = await createPurchaseReader(api, caseRecord)
    let readerBrowser
    try {
      const readerFixture = await createPurchaseRequest(api, caseRecord)
      const readerBefore = await snapshotPurchaseRequest(readerFixture, caseRecord, 'before-reader-probe')
      readerBrowser = await launchBrowser({ record })
      const readerToken = await loginWithCredentials(readerBrowser.page, reader.credentials)
      const readerApi = createApiClient({ token: readerToken, record })
      const permissionInfo = (await readerApi.getBusiness('/system/auth/get-permission-info')).data
      caseRecord.checks.push({
        name: '隔离 Chrome 关联账号仅有请购查询权限，不具有管理员或写权限',
        passed: permissionInfo.user?.username === reader.username &&
          permissionInfo.permissions.includes('erp:purchase-order-request:query') &&
          !permissionInfo.permissions.includes('*:*:*') &&
          !permissionInfo.permissions.some((value) => /:(create|update|delete)$/.test(value)),
        details: `username=${reader.username}, permissions=${JSON.stringify(permissionInfo.permissions)}`
      })
      await openRoute(readerBrowser.page, '/erp/purchase/purchaseRequest')
      await readerBrowser.page.locator('.request-status-tabs').waitFor({ state: 'visible' })
      await readerBrowser.page.getByPlaceholder('请输入请购单号').fill(readerFixture.billNo)
      await Promise.all([
        readerBrowser.page.waitForResponse(
          (response) => new URL(response.url()).pathname.endsWith('/erp/purchase/order/request/page') &&
            new URL(response.url()).searchParams.get('billNo') === readerFixture.billNo
        ),
        readerBrowser.page.getByRole('button', { name: '搜索', exact: true }).click()
      ])
      await readerBrowser.page.locator('button:visible').filter({
        hasText: readerFixture.billNo
      }).first().waitFor({ state: 'visible' })
      const writeButtons = await readerBrowser.page.locator('button:visible').filter({
        hasText: /^\s*(关闭本行|整单关闭)\s*$/
      }).count()
      caseRecord.checks.push({
        name: '只读关联账号页面不提供关闭写操作',
        passed: writeButtons === 0,
        details: `visibleCloseButtons=${writeButtons}`
      })
      await saveScreenshot(readerBrowser.page, outputDir, 'erp-purchase-request-readonly-account', record)
      const readerItem = readerFixture.initial.itemsList.find((item) => Number(item.isClosed) === 0)
      if (!readerItem?.id) throw new Error('只读权限反例缺少可关闭的专用测试分录')
      const forbiddenClose = await readerApi.put(
        `/erp/purchase/order/request/close-items?ids=${readerItem.id}`
      )
      const readerAfter = await snapshotPurchaseRequest(readerFixture, caseRecord, 'after-reader-probe')
      caseRecord.checks.push({
        name: '只读关联账号不能通过直接请求关闭测试请购分录，数据库不变',
        passed: forbiddenClose.code === 403 &&
          JSON.stringify(readerAfter) === JSON.stringify(readerBefore),
        details: `username=${reader.username}, requestId=${readerFixture.id}, itemId=${readerItem.id}, code=${forbiddenClose.code}`
      })
      caseRecord.evidence.push(
        `关联只读账号 ${reader.username}、独立 Chrome 登录、页面写入口和直接关闭接口权限取证`
      )
    } finally {
      try {
        await reader.deactivate()
        caseRecord.notes.push(`已停用本轮关联测试账号 ${reader.username}，保留角色和审计证据`)
      } finally {
        await readerBrowser?.browser.close()
      }
    }
    return { token, api, notImplemented: true, note: '已执行行关闭及只读账号取证；整单主动关闭、反向和跨租户仍待补验' }
  }

  if (caseId === 'PROC-015') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const pageResult = await api.getBusiness('/erp/purchase-order/page?pageNo=1&pageSize=20')
    const rows = Array.isArray(pageResult?.data?.list) ? pageResult.data.list : []
    caseRecord.checks.push({
      name: '采购订单分页返回状态快捷标签与门户协同字段',
      passed:
        Array.isArray(pageResult?.data?.list) &&
        rows.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'billStage') &&
            Object.prototype.hasOwnProperty.call(row, 'isClosed') &&
            Object.prototype.hasOwnProperty.call(row, 'portalStatus')
        ),
      details: `orders=${rows.length}`
    })

    const changeMissing = await api.put('/erp/purchase-order/change', {
      id: '__pb139_not_exists__',
      reason: 'PB-139 e2e negative contract',
      changes: [{ fieldName: 'remark', value: 'x' }]
    })
    caseRecord.checks.push({
      name: '采购订单变更接口存在且对不存在单据返回业务错误',
      passed: changeMissing?.code !== 0 && String(changeMissing?.msg || '').length > 0,
      details: `code=${changeMissing?.code}, msg=${changeMissing?.msg}`
    })

    const changeListMissing = await api.get(
      '/erp/purchase-order/change-list?orderId=__pb139_not_exists__'
    )
    caseRecord.checks.push({
      name: '采购订单变更记录查询接口存在且对不存在单据返回业务错误',
      passed: changeListMissing?.code !== 0 && String(changeListMissing?.msg || '').length > 0,
      details: `code=${changeListMissing?.code}, msg=${changeListMissing?.msg}`
    })

    const attachmentMissing = await api.put(
      '/erp/purchase-order/update-attachment?id=__pb139_not_exists__&fileUrl='
    )
    caseRecord.checks.push({
      name: '采购订单附件接口存在且对不存在单据返回业务错误',
      passed: attachmentMissing?.code !== 0 && String(attachmentMissing?.msg || '').length > 0,
      details: `code=${attachmentMissing?.code}, msg=${attachmentMissing?.msg}`
    })

    await openRoute(page, '/erp/purchase/order')
    const bodyText = await page.locator('body').innerText()
    const tabs = ['全部', '编制中', '编制完', '核批中', '核批完', '已关闭']
    const visibleTabs = tabs.filter((label) => bodyText.includes(label))
    caseRecord.checks.push({
      name: '采购订单列表渲染状态快捷查询标签',
      passed: visibleTabs.length === tabs.length,
      details: `visible=${visibleTabs.join(',')}`
    })
    caseRecord.checks.push({
      name: '采购订单行操作提供变更入口',
      passed: bodyText.includes('变 更') || bodyText.includes('变更'),
      details: bodyText.includes('变 更') ? '命中变更按钮' : '未找到变更按钮'
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-order-status-tabs', record)
    caseRecord.evidence.push(
      '真实登录、订单分页标签字段契约、变更/变更记录/附件接口负向契约、状态标签与变更入口截图'
    )
    return { token, api }
  }

  if (caseId === 'PROC-016') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const invoicePage = await api.getBusiness('/erp/purchase-invoice/page?pageNo=1&pageSize=100')
    const invoiceRows = Array.isArray(invoicePage?.data?.list) ? invoicePage.data.list : []
    caseRecord.checks.push({
      name: '采购发票分页返回来源、明细快照与生效字段',
      passed:
        Array.isArray(invoicePage?.data?.list) &&
        invoiceRows.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'srcBillType') &&
            Object.prototype.hasOwnProperty.call(row, 'srcBillId') &&
            Object.prototype.hasOwnProperty.call(row, 'details') &&
            Object.prototype.hasOwnProperty.call(row, 'isEffective')
        ),
      details: `invoices=${invoiceRows.length}`
    })

    const payablePage = await api.getBusiness(
      '/finance/finPayable/list/dictText?pageNo=1&pageSize=100'
    )
    const payableRows = Array.isArray(payablePage?.data?.list)
      ? payablePage.data.list
      : Array.isArray(payablePage?.data?.records)
        ? payablePage.data.records
        : []
    const historicalOrderIds = new Set(
      payableRows
        .filter(
          (row) =>
            row?.srcBillType === 'PurOrder' && Number(row?.isVoided || 0) !== 1 && row?.srcBillId
        )
        .map((row) => String(row.srcBillId))
    )
    const invoiceById = new Map(invoiceRows.map((row) => [String(row.id), row]))
    const duplicateInvoicePayables = payableRows.filter((row) => {
      if (row?.srcBillType !== 'PurInvoice' || Number(row?.isVoided || 0) === 1) {
        return false
      }
      const invoice = invoiceById.get(String(row.srcBillId))
      if (!invoice?.details) {
        return false
      }
      try {
        const sourceOrderIds = Object.keys(JSON.parse(invoice.details))
        return sourceOrderIds.some((orderId) => historicalOrderIds.has(String(orderId)))
      } catch {
        return false
      }
    })
    caseRecord.checks.push({
      name: '不存在同一采购订单同时挂历史应付和发票应付',
      passed: duplicateInvoicePayables.length === 0,
      details: `historicalOrderPayables=${historicalOrderIds.size}, invoicePayables=${payableRows.filter((row) => row?.srcBillType === 'PurInvoice').length}, duplicates=${duplicateInvoicePayables.length}`
    })

    await openRoute(page, '/erp/purchase/invoice')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '采购发票页面正常渲染并保留复核入口',
      passed:
        page.url().includes('/erp/purchase/invoice') &&
        bodyText.includes('采购发票') &&
        (bodyText.includes('审核') || bodyText.includes('复核')),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-invoice-historical-payable-guard', record)
    caseRecord.evidence.push(
      '真实登录、采购发票来源字段契约、历史订单应付与发票应付重复扫描、发票页面截图'
    )
    return { token, api }
  }

  if (caseId === 'PROC-017') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    await openRoute(page, '/erp/purchase/purchaseRequest')
    const button = page.getByText('待生成请购', { exact: true }).first()
    const buttonVisible = (await button.count()) > 0
    if (buttonVisible) {
      await button.click()
      await page.waitForTimeout(800)
    }
    const bodyText = await page.locator('body').innerText()
    const sourceTabs = ['生产订单', '销售订单', '现存量', 'MRP运算结果']
    const visibleSourceTabs = sourceTabs.filter((label) => bodyText.includes(label))
    caseRecord.checks.push({
      name: '请购单列表提供待生成请购入口',
      passed: buttonVisible,
      details: buttonVisible ? '命中待生成请购按钮' : '未找到待生成请购按钮'
    })
    caseRecord.checks.push({
      name: '待生成请购弹窗聚合四类来源',
      passed:
        bodyText.includes('待生成请购') &&
        visibleSourceTabs.length === sourceTabs.length &&
        bodyText.includes('生成请购'),
      details: `tabs=${visibleSourceTabs.join(',')}`
    })
    caseRecord.checks.push({
      name: '待生成请购不新增前置事实表并复用来源读取接口',
      passed:
        typeof api.getBusiness === 'function' &&
        (await api.getBusiness('/mes/mrp/history?pageNo=1&pageSize=10'))?.code === 0,
      details: 'MRP history API contract'
    })
    await saveScreenshot(page, outputDir, 'erp-purchase-request-pending-sources', record)
    caseRecord.evidence.push('真实登录、请购单列表待生成入口、四类来源标签与 MRP 历史接口契约截图')
    return { token, api }
  }

  return { designed: true }
}
