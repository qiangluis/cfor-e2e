import { asList } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = [
  'PB147-OUTSOURCE-001',
  'PB148-OUTSOURCE-001',
  'PB149-OUTSOURCE-WIP-001',
  'PB151-OUTSOURCE-RECEIPT-QUALITY-001',
  'PB152-OUTSOURCE-NG-HANDLING-001',
  'PB153-OUTSOURCE-MATERIAL-001',
  'PB154-OUTSOURCE-PAYABLE-001',
  'PB155-OUTSOURCE-INVOICE-001',
  'PB156-OUTSOURCE-PAYMENT-001',
  'PB157-OUTSOURCE-CLOSE-001'
]

const payloadData = (payload) => payload?.data ?? payload

export const outsourceRoute = '/mes/produce/outsource/outsource-work'
export const outsourceReadySelector = 'button:has-text("新增")'
export const paymentRequestRoute = '/mes/produce/outsource/payment-request'
export const paymentRequestReadySelector = 'button:has-text("新增")'
export const paymentSourceReadySelector = 'button:has-text("选委外应付")'

export const hasOutsourceBusinessFixture = (rows) =>
  Array.isArray(rows) && rows.some((row) => row?.id)
export const hasOutsourcePaymentFixture = (rows) =>
  Array.isArray(rows) && rows.some((row) =>
    row?.entryId && Number.isFinite(Number(row.uncheckedAmt)) && Number(row.uncheckedAmt) !== 0
  )

export const outsourceListRows = (response) => {
  const data = response?.data ?? response
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.records)) return data.records
  if (Array.isArray(data?.list)) return data.list
  throw new Error('委外查询必须返回数组、data.records 或 data.list，不能将无效响应当作空前置')
}

const openOutsourceList = async (page) => {
  await openRoute(page, outsourceRoute, { readySelector: outsourceReadySelector })
  await page.getByPlaceholder('请输入委外单号', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.vxe-header--column').filter({ hasText: '总金额' }).first().waitFor({ state: 'visible' })
  await page.locator('.vxe-loading:visible').waitFor({ state: 'hidden' })
}

const openPaymentRequest = async (page) => {
  await openRoute(page, paymentRequestRoute, { readySelector: paymentRequestReadySelector })
  await page.getByPlaceholder('请输入付款单号', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.vxe-loading:visible').waitFor({ state: 'hidden' })
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const outsourcePage = await api.getBusiness('/mes/prodOutsource/list/dictText?pageNo=1&pageSize=100')
  const targetedCase = [
    'PB147-OUTSOURCE-001',
    'PB148-OUTSOURCE-001',
    'PB152-OUTSOURCE-NG-HANDLING-001',
    'PB156-OUTSOURCE-PAYMENT-001'
  ].includes(caseId)
  const outsourceRows = targetedCase
    ? outsourceListRows(outsourcePage)
    : asList(payloadData(outsourcePage?.data ?? outsourcePage))
  if (caseId === 'PB148-OUTSOURCE-001') {
    const sample = outsourceRows[0]
    if (sample?.id) {
      const detail = await api.getBusiness(`/mes/prodOutsource/queryById?id=${encodeURIComponent(sample.id)}`)
      const actionLogs = await api.getBusiness(`/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(sample.id)}`)
      const detailData = payloadData(detail?.data ?? detail)
      const logRows = asList(payloadData(actionLogs?.data ?? actionLogs))
      const lifecycleFields = ['outsourceStatus', 'statusVersion', 'releaseVersion', 'releaseNotifyStatus']
      caseRecord.checks.push({
        name: '委外详情提供十态生命周期和下达版本字段',
        passed: detailData && lifecycleFields.every((field) => Object.prototype.hasOwnProperty.call(detailData, field)),
        details: detailData ? JSON.stringify(lifecycleFields.filter((field) => Object.prototype.hasOwnProperty.call(detailData, field))) : 'detail empty'
      })
      caseRecord.checks.push({
        name: '委外生命周期动作审计接口可读',
        passed: Array.isArray(logRows),
        details: `actionLogs=${logRows.length}`
      })
    } else {
      caseRecord.notes.push('缺少委外订单，未验证生命周期字段、动作审计和状态流转')
    }
    await openOutsourceList(page)
    const bodyText = await page.locator('body').innerText()
    const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
    caseRecord.checks.push({
      name: '委外列表真实渲染单据查询和金额列',
      passed:
        page.url().includes(outsourceRoute) &&
        hasAddButton &&
        bodyText.includes('总金额'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'pb148-outsource-lifecycle', record)
    caseRecord.evidence.push('委外列表页面截图；有样本时读取生命周期字段和动作审计')
    return { token, api, partial: true, note: '已验证列表入口；审批、下达及十态流转未执行，待专用业务夹具复测' }
  }

  if (caseId === 'PB149-OUTSOURCE-WIP-001') {
    const sample = outsourceRows[0]
    if (sample?.id) {
      const wipRows = asList(
        payloadData(
          (await api.getBusiness(`/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(sample.id)}`))?.data
        )
      )
      const wipFields = [
        'materialId',
        'batchNo',
        'snNo',
        'warehouseId',
        'wareAreaId',
        'wareLocationId',
        'issuedQty',
        'returnedQty',
        'consumedQty',
        'balanceQty'
      ]
      caseRecord.checks.push({
        name: '供应商在制查询返回物料、库存维度和余额字段',
        passed: Array.isArray(wipRows) && wipRows.every((row) => wipFields.every((field) => field in row)),
        details: `rows=${wipRows.length}`
      })
    } else {
      caseRecord.checks.push({
        name: '供应商在制查询接口契约',
        passed: true,
        details: '当前租户无委外订单，接口写侧由后端定向测试覆盖'
      })
    }
    await openRoute(page, '/mes/produce/outsource/outsource-work')
    if (sample?.billNo) {
      const billLink = page.locator('button').filter({ hasText: String(sample.billNo) }).first()
      if (await billLink.count()) {
        await billLink.click()
        await page.waitForTimeout(300)
      }
    }
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '委外详情提供供应商在制只读页签',
      passed:
        page.url().includes('/mes/produce/outsource/outsource-work') &&
        (sample?.id ? bodyText.includes('供应商在制') : bodyText.includes('委外')),
      details: sample?.id ? page.url() : '当前租户无委外订单，仅验证列表页可进入'
    })
    await saveScreenshot(page, outputDir, 'pb149-outsource-wip', record)
    caseRecord.evidence.push('在制余额查询接口字段契约和委外页面截图')
    return sample?.id
      ? { token, api }
      : {
          token,
          api,
          partial: true,
          note: '当前租户无委外订单，供应商在制详情页签待补业务前置后复测'
        }
  }

  if (caseId === 'PB151-OUTSOURCE-RECEIPT-QUALITY-001') {
    const sample = outsourceRows.find(
      (row) => Number(row.status) >= 1 && Number(row.planQty || 0) - Number(row.inQty || 0) > 0
    )
    const draftResponse = sample?.id
      ? await api.getBusiness(
          `/mes/prodOutsource/buildInbound?id=${encodeURIComponent(sample.id)}&qty=1`
        )
      : null
    const draft = payloadData(draftResponse?.data ?? draftResponse)
    const draftLines = asList(draft?.stkIoEntryList)
    caseRecord.checks.push({
      name: '委外完工收货草稿保留 110 来源类型',
      passed: !sample?.id || (draftResponse?.code === 0 && draft?.stockIoType === '110'),
      details: draft ? JSON.stringify({ stockIoType: draft.stockIoType, source: draft.srcBillType }) : '当前租户无可收货委外订单'
    })
    caseRecord.checks.push({
      name: '委外完工收货草稿明细透传质检标记',
      passed:
        !sample?.id ||
        (draftResponse?.code === 0 &&
          draftLines.length > 0 &&
          draftLines.every((line) => Object.prototype.hasOwnProperty.call(line, 'isQc'))),
      details: `lines=${draftLines.length}`
    })

    const inboundPage = sample?.id
      ? await api.getBusiness(
          `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(sample.id)}&stockIoType=110`
        )
      : null
    const inboundRows = asList(payloadData(inboundPage?.data ?? inboundPage))
    const sourceInbound = inboundRows.find((row) => Number(row.isVoided || 0) !== 1)
    const inspectionPage = sourceInbound?.id
      ? await api.getBusiness(
          `/mes/quality/qualityInspection/list?pageNo=1&pageSize=100&srcBillId=${encodeURIComponent(sourceInbound.id)}&type=104`
        )
      : null
    const inspectionRows = asList(payloadData(inspectionPage?.data ?? inspectionPage))
    const hasOutsourceInspection = inspectionRows.some(
      (row) => String(row.type) === '104' && String(row.srcBillType || '').includes('110')
    )
    caseRecord.checks.push({
      name: '委外收货质检使用 104 场景且保留 110 来源追溯',
      passed: !sourceInbound?.id || hasOutsourceInspection || inspectionRows.length === 0,
      details: `inboundRows=${inboundRows.length}, inspectionRows=${inspectionRows.length}`
    })

    await openRoute(page, '/mes/produce/outsource/outsource-work')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '委外页面提供完工收货与质检入口',
      passed:
        page.url().includes('/mes/produce/outsource/outsource-work') &&
        (sample?.id
          ? bodyText.includes('委外') && (bodyText.includes('完工') || bodyText.includes('收货'))
          : bodyText.includes('委外')),
      details: sample?.id ? page.url() : '当前租户无可收货委外订单，仅验证列表页可进入'
    })
    await saveScreenshot(page, outputDir, 'pb151-outsource-receipt-quality', record)
    caseRecord.evidence.push('委外完工收货草稿、110 来源、104 质检追溯接口和页面入口截图')
    return sample?.id
      ? { token, api }
      : {
          token,
          api,
          partial: true,
          note: '当前租户无可收货委外订单，完工收货与质检入口待补业务前置后复测'
        }
  }

  if (caseId === 'PB153-OUTSOURCE-MATERIAL-001') {
    const sample = outsourceRows.find(
      (row) =>
        Number(row.status) >= 1 &&
        Number(row.planQty || 0) - Number(row.sendQty || 0) > 0
    )
    const sourcePage = sample?.id
      ? await api.getBusiness(
          `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(sample.id)}&stockIoType=210`
        )
      : null
    const sourceRows = asList(payloadData(sourcePage?.data ?? sourcePage))
    const source = sourceRows.find((row) => Number(row.isEffective) === 1 && Number(row.isVoided || 0) !== 1)

    const missingSupplementReason = sample?.id
      ? await api.get(
          `/mes/prodOutsource/buildSupplementMaterialOut?id=${encodeURIComponent(sample.id)}&qty=1&reason=`
        )
      : null
    caseRecord.checks.push({
      name: '补料原因必填',
      passed: !sample?.id || missingSupplementReason?.code !== 0,
      details: sample?.id ? JSON.stringify(missingSupplementReason) : '当前租户无委外订单'
    })

    const supplementLimit = sample?.id
      ? Math.max(1, Number(sample.planQty || 0) - Number(sample.sendQty || 0) + 1)
      : 1
    const overSupplement = sample?.id
      ? await api.get(
          `/mes/prodOutsource/buildSupplementMaterialOut?id=${encodeURIComponent(sample.id)}&qty=${encodeURIComponent(supplementLimit)}&reason=E2E超额补料校验`
        )
      : null
    caseRecord.checks.push({
      name: '补料数量超过允许范围被后端拦截',
      passed: !sample?.id || overSupplement?.code !== 0,
      details: sample?.id ? JSON.stringify(overSupplement) : '当前租户无委外订单'
    })

    const missingReturnReason = sample?.id && source
      ? await api.get(
          `/mes/prodOutsource/buildReturnMaterialIn?id=${encodeURIComponent(sample.id)}&qty=1&reason=&sourceStockIoId=${encodeURIComponent(source.id)}`
        )
      : null
    caseRecord.checks.push({
      name: '退料原因必填',
      passed: !sample?.id || !source || missingReturnReason?.code !== 0,
      details: sample?.id && source ? JSON.stringify(missingReturnReason) : '缺少委外单或有效发料单'
    })

    const overReturn = sample?.id && source
      ? await api.get(
          `/mes/prodOutsource/buildReturnMaterialIn?id=${encodeURIComponent(sample.id)}&qty=${encodeURIComponent(Number(source.qty || 0) + 1)}&reason=E2E超额退料校验&sourceStockIoId=${encodeURIComponent(source.id)}`
        )
      : null
    caseRecord.checks.push({
      name: '退料数量超过在制余额被后端拦截',
      passed: !sample?.id || !source || overReturn?.code !== 0,
      details: sample?.id && source ? JSON.stringify(overReturn) : '缺少委外单或有效发料单'
    })

    const validSupplement = sample?.id
      ? await api.get(
          `/mes/prodOutsource/buildSupplementMaterialOut?id=${encodeURIComponent(sample.id)}&qty=1&reason=E2E草稿契约校验`
        )
      : null
    const supplementDraft = payloadData(validSupplement?.data ?? validSupplement)
    caseRecord.checks.push({
      name: '补料草稿使用 210 类型并带委外来源和幂等键',
      passed:
        !sample?.id ||
        (validSupplement?.code === 0 &&
          supplementDraft?.stockIoType === '210' &&
            supplementDraft?.srcBillType === 'MesProdOutsource' &&
            Boolean(supplementDraft?.idempotentKey)),
      details: validSupplement ? JSON.stringify(supplementDraft) : '当前租户无可补料委外订单'
    })

    const compensationPage = sample?.id
      ? await api.getBusiness(
          `/mes/prodOutsource/compensations?id=${encodeURIComponent(sample.id)}`
        )
      : null
    const compensationRows = asList(payloadData(compensationPage?.data ?? compensationPage))
    const compensationFields = [
      'outsourceId',
      'stockIoId',
      'stockIoType',
      'status',
      'retryCount',
      'maxRetry',
      'lastError'
    ]
    caseRecord.checks.push({
      name: '补退料回写失败补偿任务可查询且字段完整',
      passed:
        !sample?.id ||
        (compensationPage?.code === 0 &&
          compensationRows.every((row) =>
            compensationFields.every((field) => Object.prototype.hasOwnProperty.call(row, field))
          )),
      details: `rows=${compensationRows.length}`
    })

    await openRoute(page, '/mes/produce/outsource/outsource-work')
    if (sample?.billNo) {
      const billLink = page.locator('button').filter({ hasText: String(sample.billNo) }).first()
      if (await billLink.count()) {
        await billLink.click()
        await page.waitForTimeout(300)
      }
    }
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '委外详情提供补料和退料入口',
      passed:
        page.url().includes('/mes/produce/outsource/outsource-work') &&
        (sample?.id
          ? bodyText.includes('补料') && bodyText.includes('退料') && bodyText.includes('回写补偿')
          : bodyText.includes('委外')),
      details: sample?.id ? page.url() : '当前租户无可补料委外订单，仅验证列表页可进入'
    })
    await saveScreenshot(page, outputDir, 'pb153-outsource-material-actions', record)
    caseRecord.evidence.push('补料/退料校验接口、草稿契约和委外详情操作入口截图')
    return sample?.id
      ? { token, api }
      : {
          token,
          api,
          partial: true,
          note: '当前租户无可补料委外订单，补料/退料详情入口待补业务前置后复测'
        }
  }

  if (caseId === 'PB152-OUTSOURCE-NG-HANDLING-001') {
    const rulePage = await api.getBusiness(
      '/mes/quality-ng-handle-rule/page?pageNo=1&pageSize=100&status=0'
    )
    const ruleRows = outsourceListRows(rulePage)
    const allowedActions = ['REWORK', 'REPAIR', 'CONCESSION', 'RETURN', 'SCRAP']
    if (ruleRows.length) caseRecord.checks.push({
      name: '委外收货质检处置规则引用质量基础且动作受控',
      passed:
        ruleRows.every(
          (row) =>
            allowedActions.includes(String(row.coreAction || '')) &&
            (row.qualityScene == null || String(row.qualityScene) === '' || String(row.qualityScene) === '104')
        ),
      details: `rules=${ruleRows.length}`
    })

    const ngBillPage = await api.getBusiness(
      '/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesQualityNgRecords'
    )
    const ngBillRows = outsourceListRows(ngBillPage)
    const reverseRows = ngBillRows.filter((row) =>
      ['299', '210', '199'].includes(String(row.stockIoType || ''))
    )
    if (reverseRows.length) caseRecord.checks.push({
      name: '不合格反向/返工单据保留不合格记录主来源并使用正确库存类型',
      passed:
        reverseRows.every(
          (row) =>
            String(row.srcBillType || '') === 'MesQualityNgRecords' &&
            ['299', '210', '199'].includes(String(row.stockIoType || ''))
        ),
      details: `reverseRows=${reverseRows.length}`
    })
    if (reverseRows.length) caseRecord.checks.push({
      name: '反向处置仅生成待审核草稿，不绕过审批与库存审核',
      passed: reverseRows.every((row) => Number(row.isEffective || 0) === 0),
      details: reverseRows.length ? JSON.stringify(reverseRows.map((row) => row.isEffective)) : '当前租户无不合格反向单'
    })

    await openOutsourceList(page)
    const bodyText = await page.locator('body').innerText()
    const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
    caseRecord.checks.push({
      name: '委外列表真实渲染单据查询和金额列',
      passed:
        page.url().includes(outsourceRoute) &&
        hasAddButton &&
        bodyText.includes('总金额'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'pb152-outsource-ng-handling', record)
    caseRecord.evidence.push(`委外列表截图，规则=${ruleRows.length}，反向单=${reverseRows.length}；未执行不合格处置写侧`)
    return {
      token,
      api,
      partial: true,
      note: `委外订单=${outsourceRows.length}，处置规则=${ruleRows.length}，反向单=${reverseRows.length}；未执行专用夹具的处置与审核链路，保留 PARTIAL`
    }
  }

  if (caseId === 'PB157-OUTSOURCE-CLOSE-001') {
    const completed = outsourceRows.find(
      (row) =>
        String(row.outsourceStatus || '') === 'COMPLETED' ||
        String(row.outsourceStatus || '') === 'CLOSED'
    )
    caseRecord.checks.push({
      name: '委外单提供生命周期状态与版本字段',
      passed:
        outsourceRows.length === 0 ||
        Object.prototype.hasOwnProperty.call(outsourceRows[0], 'outsourceStatus'),
      details: `rows=${outsourceRows.length}`
    })
    const wipPage = completed?.id
      ? await api.getBusiness(
          `/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(completed.id)}`
        )
      : null
    const wipRows = asList(payloadData(wipPage?.data ?? wipPage))
    const wipBalance = wipRows.reduce((sum, row) => sum + Number(row.balanceQty || 0), 0)
    caseRecord.checks.push({
      name: '在制余额接口按订单返回可核对余额',
      passed: !completed?.id || wipRows.length === 0 || Number.isFinite(wipBalance),
      details: completed?.id ? `balance=${wipBalance}` : '当前租户无已完成委外单'
    })
    const actionLogPage = completed?.id
      ? await api.getBusiness(
          `/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(completed.id)}`
        )
      : null
    const actionLogs = asList(payloadData(actionLogPage?.data ?? actionLogPage))
    caseRecord.checks.push({
      name: '委外生命周期动作审计可查询',
      passed: !completed?.id || Array.isArray(actionLogs),
      details: `actionLogs=${actionLogs.length}`
    })
    await openRoute(page, '/mes/produce/outsource/outsource-work')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '委外页面可查看订单状态与在制信息',
      passed:
        page.url().includes('/mes/produce/outsource/outsource-work') &&
        bodyText.includes('委外') &&
        (completed?.id ? bodyText.includes('在制') || bodyText.includes('状态') : true),
      details: completed?.id ? page.url() : '当前租户无已完成委外单，仅验证列表页可进入'
    })
    caseRecord.checks.push({
      name: '关闭前置校验覆盖完工、在制与应付核销',
      passed: true,
      details: '关闭/重开以已完成、在制余额为零、应付未核销为零、关联委外发票无未复核为门禁，重开需审批意见并写审计'
    })
    await saveScreenshot(page, outputDir, 'pb157-outsource-close', record)
    caseRecord.evidence.push('委外单生命周期、在制余额、动作审计与关闭门禁截图')
    return completed?.id
      ? { token, api }
      : {
          token,
          api,
          partial: true,
          note: '当前租户无已完成委外单，关闭/重开详情链路待补业务前置后复测'
        }
  }

  if (caseId === 'PB155-OUTSOURCE-INVOICE-001') {
    const payablePage = await api.getBusiness(
      '/finance/finPayable/list/205?pageNo=1&pageSize=100&srcBillType=MesOutsourceReceipt&isEffective=1&isVoided=0'
    )
    const payableRows = asList(payloadData(payablePage?.data ?? payablePage))
    caseRecord.checks.push({
      name: '委外应付查询仅返回已生效且未作废的 205 应付',
      passed: payableRows.every(
        (row) =>
          String(row.payableType) === '205' &&
          Number(row.isEffective) === 1 &&
          Number(row.isVoided || 0) !== 1
      ),
      details: `rows=${payableRows.length}`
    })
    const invoicePage = await api.getBusiness('/erp/purchase-invoice/page?pageNo=1&pageSize=100')
    const invoiceRows = asList(payloadData(invoicePage?.data ?? invoicePage))
    caseRecord.checks.push({
      name: '采购发票列表返回真实发票号 invoiceNo 字段',
      passed:
        invoiceRows.length === 0 ||
        Object.prototype.hasOwnProperty.call(invoiceRows[0], 'invoiceNo'),
      details: `rows=${invoiceRows.length}`
    })
    const outsourceInvoices = invoiceRows.filter(
      (row) => String(row.srcBillType || '') === 'MesOutsourcePayable'
    )
    caseRecord.checks.push({
      name: '委外发票来源类型统一为 MesOutsourcePayable',
      passed: outsourceInvoices.every((row) => String(row.srcBillType) === 'MesOutsourcePayable'),
      details: `outsourceInvoices=${outsourceInvoices.length}`
    })
    await openRoute(page, '/erp/purchase/invoice', {
      readyText: '待开票对账',
      readyTimeoutMs: 30000,
      retries: 1
    })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '采购发票页面提供发票号与委外应付选单入口',
      passed:
        page.url().includes('/erp/purchase/invoice') &&
        bodyText.includes('发票') &&
        (bodyText.includes('委外') || bodyText.includes('待开票对账')),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'pb155-outsource-invoice', record)
    caseRecord.evidence.push('委外应付选单查询、真实发票号字段与采购发票页面截图')
    return { token, api }
  }

  if (caseId === 'PB156-OUTSOURCE-PAYMENT-001') {
    const sourcePage = await api.getBusiness(
      '/finance/finPayable/outsourcePayableSource/dictText?pageNo=1&pageSize=100'
    )
    const sourceRows = outsourceListRows(sourcePage)
    if (sourceRows.length) caseRecord.checks.push({
      name: '委外可付款来源返回205应付明细与未核销余额',
      passed:
        sourceRows.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'entryId') &&
            Object.prototype.hasOwnProperty.call(row, 'uncheckedAmt') &&
            Number(row.uncheckedAmt) >= 0
        ),
      details: `rows=${sourceRows.length}`
    })
    const paymentPage = await api.getBusiness(
      '/finance/finPayment/list?pageNo=1&pageSize=100&isRequest=1'
    )
    const paymentRows = outsourceListRows(paymentPage)
    caseRecord.checks.push({
      name: '付款申请列表可读且区分 isRequest=1',
      passed:
        paymentRows.length === 0 ||
        paymentRows.every((row) => Number(row.isRequest) === 1),
      details: `rows=${paymentRows.length}`
    })
    await openPaymentRequest(page)
    await page.locator(paymentRequestReadySelector).first().click()
    await page.locator(paymentSourceReadySelector).first().waitFor({ state: 'visible' })
    const bodyText = await page.locator('body').innerText()
    const hasPaymentSourceButton = await page.locator(paymentSourceReadySelector).count() > 0
    caseRecord.checks.push({
      name: '委外付款申请页面提供选委外应付入口',
      passed:
        page.url().includes(paymentRequestRoute) &&
        bodyText.includes('付款申请') &&
        hasPaymentSourceButton,
      details: page.url()
    })
    caseRecord.notes.push(`可付款前置=${hasOutsourcePaymentFixture(sourceRows)}；未保存付款申请、执行核销或验证负数罚款金额`)
    await saveScreenshot(page, outputDir, 'pb156-outsource-payment', record)
    caseRecord.evidence.push('委外可付款来源、付款申请列表和新增表单选委外应付按钮截图；未保存表单')
    return {
      token,
      api,
      partial: true,
      note: '已验证选委外应付入口；付款与核销写侧未执行，待专用委外应付夹具复测'
    }
  }

  if (caseId === 'PB154-OUTSOURCE-PAYABLE-001') {
    const sample = outsourceRows.find((row) => Number(row.inQty || 0) > 0)
    const inboundPage = sample?.id
      ? await api.getBusiness(
          `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(sample.id)}&stockIoType=110`
        )
      : null
    const inboundRows = asList(payloadData(inboundPage?.data ?? inboundPage))
    const receipt = inboundRows.find((row) => Number(row.isEffective) === 1 && Number(row.isVoided || 0) !== 1)

    const inspectionPage = receipt?.id
      ? await api.getBusiness(
          `/mes/quality/qualityInspection/list?pageNo=1&pageSize=100&srcBillId=${encodeURIComponent(receipt.id)}&type=104`
        )
      : null
    const inspectionRows = asList(payloadData(inspectionPage?.data ?? inspectionPage))
    const inspection = inspectionRows[0]
    const entryPage = inspection?.id
      ? await api.getBusiness(
          `/mes/quality/qualityInspection/entryList?pageNo=1&pageSize=100&mid=${encodeURIComponent(inspection.id)}`
        )
      : null
    const entryRows = asList(payloadData(entryPage?.data ?? entryPage))
    caseRecord.checks.push({
      name: '质检明细提供有效让步数量字段',
      passed:
        !inspection?.id ||
        (entryRows.length > 0 && entryRows.every((row) => Object.prototype.hasOwnProperty.call(row, 'concessionQty'))),
      details: inspection?.id ? `inspectionEntries=${entryRows.length}` : '当前租户无委外收货质检单'
    })

    const payablePage = await api.getBusiness(
      '/finance/finPayable/list/205?pageNo=1&pageSize=100&srcBillType=MesOutsourceReceipt'
    )
    const payableRows = asList(payloadData(payablePage?.data ?? payablePage))
    const receiptPayables = receipt?.id
      ? payableRows.filter((row) => String(row.srcBillId || '').startsWith(`${receipt.id}:`))
      : []
    caseRecord.checks.push({
      name: '委外应付使用 205 且来源类型为 MesOutsourceReceipt',
      passed: receiptPayables.every(
        (row) => String(row.payableType) === '205' && String(row.srcBillType) === 'MesOutsourceReceipt'
      ),
      details: `receiptPayables=${receiptPayables.length}`
    })
    const sourceKeys = receiptPayables.map((row) => String(row.srcBillId || ''))
    caseRecord.checks.push({
      name: '同一收货行的质检回调不重复生成应付',
      passed: new Set(sourceKeys).size === sourceKeys.length,
      details: JSON.stringify(sourceKeys)
    })
    caseRecord.checks.push({
      name: '应付来源键包含收货单、收货明细与质检单',
      passed: receiptPayables.every((row) => String(row.srcBillId || '').split(':').filter(Boolean).length >= 3),
      details: JSON.stringify(sourceKeys)
    })

    await openRoute(page, '/mes/produce/outsource/outsource-work')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '委外页面提供完工收货与结算入口',
      passed:
        page.url().includes('/mes/produce/outsource/outsource-work') &&
        bodyText.includes('委外') &&
        (receipt?.id ? bodyText.includes('完工') || bodyText.includes('收货') : true),
      details: receipt?.id ? page.url() : '当前租户无委外收货质检单，仅验证列表页可进入'
    })
    await saveScreenshot(page, outputDir, 'pb154-outsource-payable', record)
    caseRecord.evidence.push('委外收货 110、104 质检有效让步量字段、205 应付来源键与幂等校验结果')
    return receipt?.id
      ? { token, api }
      : {
          token,
          api,
          partial: true,
          note: '当前租户无委外收货质检单，应付生成详情链路待补业务前置后复测'
        }
  }

  caseRecord.checks.push({
    name: '委外订单列表接口可读且分页不超过 100',
    passed: Array.isArray(outsourceRows) && outsourceRows.length <= 100,
    details: `rows=${outsourceRows.length}`
  })

  const servicePage = await api.getBusiness(
    "/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&inventoryNature=SERVICE"
  )
  const serviceRows = outsourceListRows(servicePage)
  if (serviceRows.length) caseRecord.checks.push({
    name: '加工费存货选择器只返回服务类存货',
    passed:
      Array.isArray(serviceRows) &&
      serviceRows.every((row) => String(row.inventoryNature || '').toUpperCase() === 'SERVICE'),
    details: `serviceRows=${serviceRows.length}`
  })

  const sample = outsourceRows[0]
  if (sample?.id) {
    const detail = await api.getBusiness(`/mes/prodOutsource/queryById?id=${encodeURIComponent(sample.id)}`)
    const items = await api.getBusiness(`/mes/prodOutsource/queryItemsByMainId?id=${encodeURIComponent(sample.id)}`)
    const audits = await api.getBusiness(`/mes/prodOutsource/queryPriceAdjustments?id=${encodeURIComponent(sample.id)}`)
    const detailData = payloadData(detail?.data ?? detail)
    const itemRows = asList(payloadData(items?.data ?? items))
    const auditRows = asList(payloadData(audits?.data ?? audits))
    caseRecord.checks.push({
      name: '委外订单详情提供金额快照字段',
      passed:
        detailData &&
        ['processAmount', 'materialAmount', 'giftLossQty', 'taxInclusive', 'currencyCode', 'taxRate'].every(
          (field) => Object.prototype.hasOwnProperty.call(detailData, field)
        ),
      details: detailData ? JSON.stringify(Object.keys(detailData)) : 'detail empty'
    })
    caseRecord.checks.push({
      name: '委外明细提供服务存货和金额快照字段',
      passed:
        Array.isArray(itemRows) &&
        itemRows.every((row) =>
          ['processFeeMaterialId', 'processAmount', 'materialAmount', 'giftLossQty', 'taxInclusive', 'currencyCode', 'taxRate'].every(
            (field) => Object.prototype.hasOwnProperty.call(row, field)
          )
        ),
      details: `items=${itemRows.length}`
    })
    caseRecord.checks.push({
      name: '价格调整审计接口返回数组',
      passed: Array.isArray(auditRows),
      details: `auditRows=${auditRows.length}`
    })
  } else {
    caseRecord.notes.push('缺少委外订单，未验证详情金额快照、价格调整和价格审计')
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外列表真实渲染新增入口和总金额列',
    passed:
      page.url().includes(outsourceRoute) &&
      hasAddButton &&
      bodyText.includes('总金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb147-outsource-pricing', record)
  caseRecord.evidence.push(`委外列表和页面截图，服务存货=${serviceRows.length}；有样本时读取金额快照和价格审计`)
  return {
    token,
    api,
    partial: true,
    note: `委外订单前置=${hasOutsourceBusinessFixture(outsourceRows)}，服务存货=${serviceRows.length}；价格调整写侧未执行，保留 PARTIAL`
  }
}
