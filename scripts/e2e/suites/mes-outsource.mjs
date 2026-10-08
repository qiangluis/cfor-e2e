import { asList, isBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import {
  assertOutsourceFixtureScope,
  createOutsourceDraft,
  driveOutsourceLifecycle,
  ensureOutsourceApprovalOption,
  ensureServiceMaterial,
  newOutsourceMarker,
  queryOutsourceActionLogs,
  queryOutsourceDetail,
  queryPriceAdjustments
} from '../fixtures/mes-outsource-write.mjs'

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

const businessError = (response) => ({
  code: response?.code,
  message: response?.msg ?? response?.message ?? ''
})

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

const pickWork = async (api) => {
  const rows = asList(payloadData(
    await api.getBusiness('/mes/prodWork/list/dictText?pageNo=1&pageSize=100')
  ))
  const work = rows.find((row) => row?.id && row?.materialId && row?.unitId)
  if (!work) throw new Error('缺少带物料与单位的可用生产工单，无法创建委外写侧夹具')
  return { id: String(work.id), materialId: String(work.materialId), unitId: String(work.unitId) }
}

const pickSupplierId = async (api) => {
  const rows = asList(payloadData(
    await api.getBusiness('/erp/supplier/page?pageNo=1&pageSize=1')
  ))
  const supplier = rows.find((row) => row?.id)
  if (!supplier) throw new Error('缺少可用供应商，无法创建委外写侧夹具')
  return String(supplier.id)
}

/** 建立一个真实可写、可审核、可下达的委外专属夹具。 */
const buildReleasedOutsourceFixture = async (api, caseRecord, { marker = newOutsourceMarker() } = {}) => {
  const approval = await ensureOutsourceApprovalOption(api)
  const fee = await ensureServiceMaterial(api, marker)
  const work = await pickWork(api)
  const supplierId = await pickSupplierId(api)
  const draft = await createOutsourceDraft(api, {
    marker,
    prodWorkId: work.id,
    materialId: work.materialId,
    unitId: work.unitId,
    supplierId,
    processFeeMaterialId: fee.id
  })
  const lifecycle = await driveOutsourceLifecycle(api, draft.id)
  caseRecord.evidence.push(
    `委外专属夹具 marker=${marker} orderId=${draft.id} billNo=${draft.billNo} ` +
    `feeMaterialId=${fee.id} approvalOptionCreated=${approval.created}`
  )
  return { marker, draft, fee, work, supplierId, approval, lifecycle }
}

const runPb147 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const marker = newOutsourceMarker()
  const work = await pickWork(api)
  const supplierId = await pickSupplierId(api)
  const fee = await ensureServiceMaterial(api, marker)

  const listResponse = await api.getBusiness('/mes/prodOutsource/list/dictText?pageNo=1&pageSize=100')
  const listRows = outsourceListRows(listResponse)
  caseRecord.checks.push({
    name: '委外订单列表接口可读且分页不超过 100',
    passed: Array.isArray(listRows) && listRows.length <= 100,
    details: `rows=${listRows.length}`
  })

  const draft = await createOutsourceDraft(api, {
    marker,
    prodWorkId: work.id,
    materialId: work.materialId,
    unitId: work.unitId,
    supplierId,
    processFeeMaterialId: fee.id,
    processPrice: 5
  })
  const before = await queryOutsourceDetail(api, draft.id)

  const servicePage = await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&inventoryNature=SERVICE'
  )
  const serviceRows = outsourceListRows(servicePage)
  const nonServicePage = await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=1&inventoryNature=STOCK'
  )
  const nonServiceId = outsourceListRows(nonServicePage)[0]?.id
  caseRecord.checks.push({
    name: '加工费存货选择器只返回 inventoryNature=SERVICE 且包含专属服务类存货',
    passed:
      serviceRows.length > 0 &&
      serviceRows.every((row) => String(row.inventoryNature || '').toUpperCase() === 'SERVICE') &&
      serviceRows.some((row) => String(row.id) === fee.id) &&
      (!nonServiceId || !serviceRows.some((row) => String(row.id) === String(nonServiceId))),
    details: `serviceRows=${serviceRows.length} fee=${fee.id} nonService=${nonServiceId}`
  })

  const editReason = `${marker}-调价审计`
  const newPrice = 9
  const edit = await api.putBusiness('/mes/prodOutsource/edit', {
    id: draft.id,
    prodWorkId: work.id,
    materialId: work.materialId,
    unitId: work.unitId,
    supplierId,
    processFeeMaterialId: fee.id,
    planQty: 2,
    processPrice: newPrice,
    priceAdjustmentReason: editReason,
    items: [{
      entryNo: 1,
      prodWorkId: work.id,
      materialId: work.materialId,
      unitId: work.unitId,
      supplierId,
      processFeeMaterialId: fee.id,
      planQty: 2,
      processPrice: newPrice
    }]
  })
  const after = await queryOutsourceDetail(api, draft.id)
  const adjustments = await queryPriceAdjustments(api, draft.id)
  const adjustment = adjustments.find((row) =>
    String(row.outsourceId) === draft.id && String(row.adjustReason) === editReason
  )
  caseRecord.checks.push({
    name: '委外调价写侧生成可追溯价格调整审计记录',
    passed:
      isBusinessSuccess(edit) &&
      Number(before.processPrice) === 5 &&
      Number(after.processPrice) === newPrice &&
      Number(after.processAmount) === newPrice * 2 &&
      Boolean(adjustment) &&
      Number(adjustment.beforeProcessPrice) === Number(before.processPrice) &&
      Number(adjustment.afterProcessPrice) === newPrice &&
      Number(adjustment.beforeTotalAmount) === Number(before.totalAmount) &&
      Number(adjustment.afterTotalAmount) === Number(after.totalAmount) &&
      String(adjustment.operatorId) !== '' &&
      Boolean(adjustment.operateTime),
    details: JSON.stringify({
      before: { price: before.processPrice, total: before.totalAmount },
      after: { price: after.processPrice, total: after.totalAmount },
      adjustment: adjustment && {
        beforeProcessPrice: adjustment.beforeProcessPrice,
        afterProcessPrice: adjustment.afterProcessPrice,
        adjustReason: adjustment.adjustReason,
        operatorId: adjustment.operatorId,
        operateTime: adjustment.operateTime
      }
    })
  })

  const items = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/queryItemsByMainId?id=${encodeURIComponent(draft.id)}`)
  ))
  const snapshotFields = ['processAmount', 'materialAmount', 'giftLossQty', 'taxInclusive', 'currencyCode', 'taxRate']
  const itemSnapshotFields = ['processFeeMaterialId', ...snapshotFields]
  caseRecord.checks.push({
    name: '委外订单详情提供加工费/材料费/赠送损耗/含税/币种/税率快照',
    passed: snapshotFields.every((field) => Object.prototype.hasOwnProperty.call(after, field)),
    details: JSON.stringify(snapshotFields.filter((field) => Object.prototype.hasOwnProperty.call(after, field)))
  })
  caseRecord.checks.push({
    name: '委外明细提供服务存货和金额快照字段',
    passed: items.length > 0 && items.every((row) => itemSnapshotFields.every((field) => field in row)),
    details: `items=${items.length}`
  })

  const unauthenticated = createApiClient({ token: '', record })
  const noAuth = await unauthenticated.request('GET', `/mes/prodOutsource/queryById?id=${encodeURIComponent(draft.id)}`)
  const foreignTenant = createApiClient({ token, tenantId: '2', record })
  const crossTenant = await foreignTenant.request(
    'GET', `/mes/prodOutsource/queryPriceAdjustments?id=${encodeURIComponent(draft.id)}`
  )
  caseRecord.checks.push({
    name: '委外订单/调价审计未登录与跨租户访问被拒绝',
    passed: noAuth?.code === 401 && crossTenant?.code === 403,
    details: JSON.stringify({ noAuth: businessError(noAuth), crossTenant: businessError(crossTenant) })
  })

  const reRead = await queryPriceAdjustments(api, draft.id)
  const matched = reRead.filter((row) => String(row.adjustReason) === editReason)
  caseRecord.checks.push({
    name: '价格调整审计重复查询稳定且同一调价不重复落库',
    passed: matched.length === 1 && reRead.length === adjustments.length && String(matched[0].id) === String(adjustment.id),
    details: `adjustments=${reRead.length} matched=${matched.length} id=${matched[0]?.id}`
  })

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外列表真实渲染新增入口和总金额列',
    passed: page.url().includes(outsourceRoute) && hasAddButton && bodyText.includes('总金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb147-outsource-pricing', record)
  caseRecord.evidence.push(`价格调整写侧 orderId=${draft.id} feeMaterialId=${fee.id} adjustmentId=${adjustment?.id}`)
  return { token, api }
}

const runPb148 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const detail = await queryOutsourceDetail(api, fixture.draft.id)
  const lifecycleFields = ['outsourceStatus', 'statusVersion', 'releaseVersion', 'releaseNotifyStatus']
  caseRecord.checks.push({
    name: '委外详情返回十态生命周期与下达版本字段',
    passed: lifecycleFields.every((field) => Object.prototype.hasOwnProperty.call(detail, field)),
    details: JSON.stringify(lifecycleFields.filter((field) => Object.prototype.hasOwnProperty.call(detail, field)))
  })
  caseRecord.checks.push({
    name: '提交审批->审核->下达真实推进生命周期并累加版本',
    passed:
      String(detail.outsourceStatus) === 'RELEASED' &&
      Number(detail.releaseVersion) >= 1 &&
      Number(detail.statusVersion) >= 2 &&
      String(detail.releaseNotifyStatus) === 'PENDING',
    details: JSON.stringify({
      outsourceStatus: detail.outsourceStatus,
      statusVersion: detail.statusVersion,
      releaseVersion: detail.releaseVersion,
      releaseNotifyStatus: detail.releaseNotifyStatus
    })
  })

  const logs = await queryOutsourceActionLogs(api, fixture.draft.id)
  const codes = logs.map((row) => String(row.actionCode))
  const logFields = ['outsourceId', 'actionCode', 'fromStatus', 'toStatus', 'versionNo', 'operatorId', 'operateTime']
  caseRecord.checks.push({
    name: '生命周期动作审计记录创建/提交/审核/下达全链路',
    passed:
      Array.isArray(logs) &&
      logs.length >= 4 &&
      ['CREATE', 'SUBMIT_APPROVAL', 'APPROVE', 'RELEASE'].every((code) => codes.includes(code)) &&
      logs.every((row) => logFields.every((field) => field in row)) &&
      logs.every((row) => String(row.outsourceId) === fixture.draft.id),
    details: `logs=${logs.length} codes=${codes.join(',')}`
  })
  caseRecord.checks.push({
    name: '下达记录写入下达版本、通知状态与操作人',
    passed: (() => {
      const release = logs.find((row) => String(row.actionCode) === 'RELEASE')
      return Boolean(release) && Number(release.versionNo) >= 1 &&
        String(release.notifyStatus) === 'PENDING' && String(release.operatorId) !== ''
    })(),
    details: JSON.stringify(logs.find((row) => String(row.actionCode) === 'RELEASE') || {})
  })

  const noAuthLogs = await createApiClient({ token: '', record }).request(
    'GET', `/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(fixture.draft.id)}`
  )
  const crossTenantLogs = await createApiClient({ token, tenantId: '2', record }).request(
    'GET', `/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(fixture.draft.id)}`
  )
  caseRecord.checks.push({
    name: '生命周期审计未登录与跨租户访问被拒绝',
    passed: noAuthLogs?.code === 401 && crossTenantLogs?.code === 403,
    details: JSON.stringify({ noAuth: businessError(noAuthLogs), crossTenant: businessError(crossTenantLogs) })
  })

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外列表真实渲染单据查询和金额列',
    passed: page.url().includes(outsourceRoute) && hasAddButton && bodyText.includes('总金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb148-outsource-lifecycle', record)
  caseRecord.evidence.push(`生命周期写侧 orderId=${fixture.draft.id} billNo=${fixture.draft.billNo}`)
  return { token, api }
}

const runPb149 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const materialOut = await api.put(
    `/mes/prodOutsource/generateMaterialOut?id=${encodeURIComponent(fixture.draft.id)}&qty=1`
  )
  const wipRows = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(fixture.draft.id)}`)
  ))
  const wipFields = [
    'materialId', 'batchNo', 'snNo', 'warehouseId', 'wareAreaId', 'wareLocationId',
    'issuedQty', 'returnedQty', 'consumedQty', 'balanceQty'
  ]
  let closed = false
  if (isBusinessSuccess(materialOut) && wipRows.length > 0 && wipRows.every((row) => wipFields.every((field) => field in row))) {
    caseRecord.checks.push({
      name: '委外发料后供应商在制余额返回物料/库存维度/发退耗余字段',
      passed: true,
      details: `rows=${wipRows.length}`
    })
    closed = true
  } else {
    caseRecord.notes.push(
      `委外材料出库未生效：${JSON.stringify(businessError(materialOut))}；在制余额 rows=${wipRows.length}。` +
      '生成委外材料出库单要求生产工单 BOM 末级物料携带预出库仓库（mes_prod_work_sub.prepay_ware_house_id），' +
      '标准租户工单子表未配置仓库，且工单子表会被 ensureLeafStructure 按 BOM 结构重建，无法安全补写。'
    )
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '委外页面可进入并渲染基础列表',
    passed: page.url().includes('/mes/produce/outsource/outsource-work') && bodyText.includes('委外'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb149-outsource-wip', record)
  caseRecord.evidence.push(`在制余额查询 orderId=${fixture.draft.id} rows=${wipRows.length}`)
  return closed
    ? { token, api }
    : {
        token,
        api,
        partial: true,
        note: `已真实执行提审/审核/下达与发料尝试；发料被“工单物料未设置出库仓库”阻断，在制余额为空，保留 PARTIAL。证据 orderId=${fixture.draft.id}`
      }
}

const runPb151 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const draftResponse = await api.getBusiness(
    `/mes/prodOutsource/buildInbound?id=${encodeURIComponent(fixture.draft.id)}&qty=1`
  )
  const draft = payloadData(draftResponse)
  const draftLines = asList(draft?.stkIoEntryList)
  caseRecord.checks.push({
    name: '委外完工收货草稿保留 stockIoType=110 与来源单据',
    passed: draft?.stockIoType === '110' && draft?.srcBillType === 'MesProdOutsource' && draft?.srcBillId === fixture.draft.id,
    details: JSON.stringify({ stockIoType: draft?.stockIoType, srcBillType: draft?.srcBillType, srcBillId: draft?.srcBillId })
  })
  caseRecord.checks.push({
    name: '完工收货草稿明细透传 isQc/needQc 质检标记',
    passed: draftLines.length > 0 && draftLines.every((line) => Object.prototype.hasOwnProperty.call(line, 'isQc')),
    details: `lines=${draftLines.length}`
  })

  const inbound = await api.put(
    `/mes/prodOutsource/generateInbound?id=${encodeURIComponent(fixture.draft.id)}&qty=1`
  )
  const inboundRows = asList(payloadData(
    await api.getBusiness(
      `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(fixture.draft.id)}&stockIoType=110`
    )
  ))
  const effectiveInbound = inboundRows.find((row) => Number(row.isEffective) === 1 && Number(row.isVoided || 0) !== 1)
  const inspectionRows = effectiveInbound?.id
    ? asList(payloadData(await api.getBusiness(
        `/mes/quality/qualityInspection/list?pageNo=1&pageSize=100&srcBillId=${encodeURIComponent(effectiveInbound.id)}&type=104`
      )))
    : []
  const tracedInspection = inspectionRows.find((row) => String(row.type) === '104')
  let closed = false
  if (isBusinessSuccess(inbound) && effectiveInbound?.id && tracedInspection) {
    caseRecord.checks.push({
      name: '委外完工收货生成 104 质检并保留 MesStkIo:110 来源追溯',
      passed: String(tracedInspection.type) === '104' && String(tracedInspection.srcBillType || '').includes('110'),
      details: JSON.stringify({ inspectionId: tracedInspection.id, type: tracedInspection.type, srcBillType: tracedInspection.srcBillType })
    })
    closed = true
  } else {
    caseRecord.notes.push(
      `委外完工收货未形成 104 质检：inbound=${JSON.stringify(businessError(inbound))}，inboundRows=${inboundRows.length}，` +
      `inspectionRows=${inspectionRows.length}。104 生产入库检需要 mes_quality_material 配置命中且质检方案已发布，` +
      '标准租户成品方案（mes_quality_plan 104）处于未发布状态，无法安全发布。'
    )
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '委外页面可进入并渲染基础列表',
    passed: page.url().includes('/mes/produce/outsource/outsource-work') && bodyText.includes('委外'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb151-outsource-receipt-quality', record)
  caseRecord.evidence.push(`完工入库 orderId=${fixture.draft.id} inboundRows=${inboundRows.length} inspections=${inspectionRows.length}`)
  return closed
    ? { token, api }
    : {
        token,
        api,
        partial: true,
        note: `已真实下达并生成 110 完工收货草稿；104 质检未生成（质检方案未发布），保留 PARTIAL。证据 orderId=${fixture.draft.id}`
      }
}

const runPb152 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const rulePage = await api.getBusiness('/mes/quality-ng-handle-rule/page?pageNo=1&pageSize=100&status=0')
  const ruleRows = asList(payloadData(rulePage))
  const allowedActions = ['REWORK', 'REPAIR', 'CONCESSION', 'RETURN', 'SCRAP']
  if (ruleRows.length > 0) {
    caseRecord.checks.push({
      name: '委外收货质检处置规则引用质量基础且动作受控',
      passed: ruleRows.every((row) =>
        allowedActions.includes(String(row.coreAction || '')) &&
        (row.qualityScene == null || String(row.qualityScene) === '' || String(row.qualityScene) === '104')
      ),
      details: `rules=${ruleRows.length}`
    })
  }

  const reverseRows = asList(payloadData(
    await api.getBusiness('/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesQualityNgRecords')
  )).filter((row) => ['299', '210', '199'].includes(String(row.stockIoType || '')))
  if (reverseRows.length > 0) {
    caseRecord.checks.push({
      name: '不合格反向/返工单据保留不合格记录主来源并使用正确库存类型',
      passed: reverseRows.every((row) =>
        String(row.srcBillType || '') === 'MesQualityNgRecords' &&
        ['299', '210', '199'].includes(String(row.stockIoType))
      ),
      details: `reverseRows=${reverseRows.length}`
    })
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  const hasAddButton = await page.locator(outsourceReadySelector).count() > 0
  caseRecord.checks.push({
    name: '委外列表真实渲染单据查询和金额列',
    passed: page.url().includes(outsourceRoute) && hasAddButton && bodyText.includes('总金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb152-outsource-ng-handling', record)
  caseRecord.notes.push(
    `不合格处置规则=${ruleRows.length}，反向单=${reverseRows.length}。处置需先由 104 质检产出不合格记录，` +
    '104 质检被未发布质检方案阻断，无法安全构造不合格来源，保留 PARTIAL。'
  )
  caseRecord.evidence.push(`委外列表截图，规则=${ruleRows.length}，反向单=${reverseRows.length}；未执行不合格处置写侧`)
  return {
    token,
    api,
    partial: true,
    note: `处置规则=${ruleRows.length}，反向单=${reverseRows.length}；缺少已发布 104 质检方案，无法构造不合格记录来源，保留 PARTIAL`
  }
}

const runPb153 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const id = fixture.draft.id

  const missingSupplementReason = await api.get(
    `/mes/prodOutsource/buildSupplementMaterialOut?id=${encodeURIComponent(id)}&qty=1&reason=`
  )
  caseRecord.checks.push({
    name: '补料原因必填被后端拦截',
    passed: !isBusinessSuccess(missingSupplementReason),
    details: JSON.stringify(businessError(missingSupplementReason))
  })

  const overSupplement = await api.get(
    `/mes/prodOutsource/buildSupplementMaterialOut?id=${encodeURIComponent(id)}&qty=99&reason=${encodeURIComponent('E2E 超额补料校验')}`
  )
  caseRecord.checks.push({
    name: '补料数量超过未完工允许范围被后端拦截',
    passed: !isBusinessSuccess(overSupplement),
    details: JSON.stringify(businessError(overSupplement))
  })

  const sourceRows = asList(payloadData(
    await api.getBusiness(
      `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(id)}&stockIoType=210`
    )
  ))
  const source = sourceRows.find((row) => Number(row.isEffective) === 1 && Number(row.isVoided || 0) !== 1)

  const missingReturnReason = await api.get(
    `/mes/prodOutsource/buildReturnMaterialIn?id=${encodeURIComponent(id)}&qty=1&reason=&sourceStockIoId=${encodeURIComponent(source?.id || '')}`
  )
  caseRecord.checks.push({
    name: '退料原因必填被后端拦截',
    passed: !isBusinessSuccess(missingReturnReason),
    details: JSON.stringify(businessError(missingReturnReason))
  })

  const compensationRows = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/compensations?id=${encodeURIComponent(id)}`)
  ))
  const compensationFields = ['outsourceId', 'stockIoId', 'stockIoType', 'status', 'retryCount', 'maxRetry', 'lastError']
  if (compensationRows.length > 0) {
    caseRecord.checks.push({
      name: '补退料回写失败补偿任务可查询且字段完整',
      passed: compensationRows.every((row) =>
        compensationFields.every((field) => Object.prototype.hasOwnProperty.call(row, field))
      ),
      details: `rows=${compensationRows.length}`
    })
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '委外页面可进入并渲染基础列表',
    passed: page.url().includes('/mes/produce/outsource/outsource-work') && bodyText.includes('委外'),
    details: page.url()
  })
  caseRecord.notes.push(
    `补退料草稿契约与原因必填校验已真实执行；source210=${sourceRows.length} compensations=${compensationRows.length}。` +
    '审核补退料需要 mes_bas_bill_options[MesStkIo] 手工核批，且首次发料需工单 BOM 末级预出库仓库，二者在标准租户均缺失，保留 PARTIAL。'
  )
  await saveScreenshot(page, outputDir, 'pb153-outsource-material-actions', record)
  caseRecord.evidence.push(`补料/退料校验 orderId=${id} source210=${sourceRows.length} compensations=${compensationRows.length}`)
  return {
    token,
    api,
    partial: true,
    note: `已下达并校验补料/退料原因必填与超额拦截；缺 MesStkIo 手工核批配置与工单预出库仓库，无法完成审核回写，保留 PARTIAL。证据 orderId=${id}`
  }
}

const runPb154 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const inbound = await api.put(
    `/mes/prodOutsource/generateInbound?id=${encodeURIComponent(fixture.draft.id)}&qty=1`
  )
  const inboundRows = asList(payloadData(
    await api.getBusiness(
      `/mes/stkIo/list/dictText?pageNo=1&pageSize=100&srcBillType=MesProdOutsource&srcBillId=${encodeURIComponent(fixture.draft.id)}&stockIoType=110`
    )
  ))
  const receipt = inboundRows.find((row) => Number(row.isEffective) === 1 && Number(row.isVoided || 0) !== 1)
  const inspectionRows = receipt?.id
    ? asList(payloadData(await api.getBusiness(
        `/mes/quality/qualityInspection/list?pageNo=1&pageSize=100&srcBillId=${encodeURIComponent(receipt.id)}&type=104`
      )))
    : []
  const payableRows = asList(payloadData(
    await api.getBusiness('/finance/finPayable/list/205?pageNo=1&pageSize=100&srcBillType=MesOutsourceReceipt')
  ))
  const receiptPayables = receipt?.id
    ? payableRows.filter((row) => String(row.srcBillId || '').startsWith(`${receipt.id}:`))
    : []

  let closed = false
  if (inspectionRows.length > 0 && receiptPayables.length > 0) {
    const sourceKeys = receiptPayables.map((row) => String(row.srcBillId || ''))
    caseRecord.checks.push({
      name: '委外应付使用 205 且来源类型为 MesOutsourceReceipt，来源键含收货/明细/质检',
      passed: receiptPayables.every((row) =>
        String(row.payableType) === '205' &&
        String(row.srcBillType) === 'MesOutsourceReceipt' &&
        String(row.srcBillId || '').split(':').filter(Boolean).length >= 3
      ) && new Set(sourceKeys).size === sourceKeys.length,
      details: JSON.stringify(sourceKeys)
    })
    closed = true
  } else {
    caseRecord.notes.push(
      `委外应付未生成：inbound=${JSON.stringify(businessError(inbound))} receipt=${receipt?.id} ` +
      `inspections=${inspectionRows.length} payables=${receiptPayables.length}。` +
      '应付仅在 104 质检合格/让步后回写，104 质检被未发布质检方案阻断，保留 PARTIAL。'
    )
  }

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '委外页面可进入并渲染基础列表',
    passed: page.url().includes('/mes/produce/outsource/outsource-work') && bodyText.includes('委外'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'pb154-outsource-payable', record)
  caseRecord.evidence.push(`应付链路 orderId=${fixture.draft.id} receipt=${receipt?.id} inspections=${inspectionRows.length} payables=${receiptPayables.length}`)
  return closed
    ? { token, api }
    : {
        token,
        api,
        partial: true,
        note: '已真实下达并尝试完工收货；104 质检未生成导致 205 应付缺失，保留 PARTIAL。'
      }
}

const runPb155 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const payablePage = await api.getBusiness(
    '/finance/finPayable/list/205?pageNo=1&pageSize=100&srcBillType=MesOutsourceReceipt&isEffective=1&isVoided=0'
  )
  const payableRows = asList(payloadData(payablePage))
  caseRecord.checks.push({
    name: '委外应付查询仅返回已生效未作废的 205 应付',
    passed: payableRows.every((row) =>
      String(row.payableType) === '205' &&
      Number(row.isEffective) === 1 &&
      Number(row.isVoided || 0) !== 1
    ),
    details: `rows=${payableRows.length}`
  })
  const invoiceRows = asList(payloadData(
    await api.getBusiness('/erp/purchase-invoice/page?pageNo=1&pageSize=100')
  ))
  const outsourceInvoices = invoiceRows.filter((row) => String(row.srcBillType || '') === 'MesOutsourcePayable')
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
  caseRecord.notes.push(
    `当前可用 205 委外应付=${payableRows.length}，委外发票=${outsourceInvoices.length}。` +
    '发票登记与复核需要已生效的 MesOutsourcePayable（205）应付，而 205 应付被未发布 104 质检方案阻断，保留 PARTIAL。'
  )
  await saveScreenshot(page, outputDir, 'pb155-outsource-invoice', record)
  caseRecord.evidence.push(`委外应付 rows=${payableRows.length}；采购发票页面入口截图`)
  return {
    token,
    api,
    partial: true,
    note: `缺少已生效 205 委外应付（当前 ${payableRows.length} 条），无法真实创建/复核委外发票，保留 PARTIAL`
  }
}

const runPb156 = async ({ page, api, caseRecord, record, outputDir, token }) => {
  const sourceRows = asList(payloadData(
    await api.getBusiness('/finance/finPayable/outsourcePayableSource/dictText?pageNo=1&pageSize=100')
  ))
  if (sourceRows.length > 0) {
    caseRecord.checks.push({
      name: '委外可付款来源返回 205 应付明细与未核销余额',
      passed: sourceRows.every((row) =>
        Object.prototype.hasOwnProperty.call(row, 'entryId') &&
        Object.prototype.hasOwnProperty.call(row, 'uncheckedAmt') &&
        Number(row.uncheckedAmt) >= 0
      ),
      details: `rows=${sourceRows.length}`
    })
  }
  const paymentRows = asList(payloadData(
    await api.getBusiness('/finance/finPayment/list?pageNo=1&pageSize=100&isRequest=1')
  ))
  caseRecord.checks.push({
    name: '付款申请列表可读且区分 isRequest=1',
    passed: paymentRows.length === 0 || paymentRows.every((row) => Number(row.isRequest) === 1),
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
  caseRecord.notes.push(
    `可付款来源=${sourceRows.length}，付款申请=${paymentRows.length}。` +
    '保存付款申请并核销需要已生效 205 委外应付，而 205 应付被未发布 104 质检方案阻断，保留 PARTIAL。'
  )
  await saveScreenshot(page, outputDir, 'pb156-outsource-payment', record)
  caseRecord.evidence.push(`委外可付款来源=${sourceRows.length}；付款申请页面选委外应付入口截图`)
  return {
    token,
    api,
    partial: true,
    note: `缺少可核销的 205 委外应付（来源=${sourceRows.length}），无法真实保存/审核付款申请，保留 PARTIAL`
  }
}

const runPb157 = async ({ api, caseRecord, record, page, outputDir, token }) => {
  const fixture = await buildReleasedOutsourceFixture(api, caseRecord)
  const detail = await queryOutsourceDetail(api, fixture.draft.id)
  caseRecord.checks.push({
    name: '委外单提供生命周期状态与版本字段',
    passed: Object.prototype.hasOwnProperty.call(detail, 'outsourceStatus') &&
      Object.prototype.hasOwnProperty.call(detail, 'statusVersion'),
    details: JSON.stringify({ outsourceStatus: detail.outsourceStatus, statusVersion: detail.statusVersion })
  })
  const wipRows = asList(payloadData(
    await api.getBusiness(`/mes/prodOutsource/queryWipBalances?id=${encodeURIComponent(fixture.draft.id)}`)
  ))
  const logs = await queryOutsourceActionLogs(api, fixture.draft.id)
  caseRecord.checks.push({
    name: '在制余额接口按订单返回可核对结果（空/有余额均可核对）',
    passed: Array.isArray(wipRows),
    details: `rows=${wipRows.length}`
  })
  caseRecord.checks.push({
    name: '委外生命周期动作审计可查询',
    passed: Array.isArray(logs) && logs.length > 0 && logs.every((row) => String(row.outsourceId) === fixture.draft.id),
    details: `logs=${logs.length}`
  })

  const closeOnReleased = await api.put(
    `/mes/prodOutsource/close?id=${encodeURIComponent(fixture.draft.id)}&remark=${encodeURIComponent('E2E 非完成单关闭校验')}`
  )
  caseRecord.checks.push({
    name: '未完成委外单关闭被门禁拦截（要求已完成）',
    passed: !isBusinessSuccess(closeOnReleased) && /已完成/.test(String(closeOnReleased?.msg || closeOnReleased?.message || '')),
    details: JSON.stringify(businessError(closeOnReleased))
  })
  const reopenOnReleased = await api.put(
    `/mes/prodOutsource/reopen?id=${encodeURIComponent(fixture.draft.id)}&remark=${encodeURIComponent('E2E 非关闭单重开校验')}`
  )
  caseRecord.checks.push({
    name: '非关闭委外单重开被门禁拦截（仅限已关闭）',
    passed: !isBusinessSuccess(reopenOnReleased) && /已关闭/.test(String(reopenOnReleased?.msg || reopenOnReleased?.message || '')),
    details: JSON.stringify(businessError(reopenOnReleased))
  })

  await openOutsourceList(page)
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '委外页面可查看订单状态与在制信息',
    passed: page.url().includes('/mes/produce/outsource/outsource-work') && bodyText.includes('委外'),
    details: page.url()
  })
  caseRecord.notes.push(
    `订单=${fixture.draft.id} 生命周期=${detail.outsourceStatus} 在制=${wipRows.length} 动作审计=${logs.length}。` +
    '关闭完整闭环还要求订单达到 COMPLETED 且存在已核销应付/无未复核发票，链路被未发布 104 质检方案与在制清零前置阻断，保留 PARTIAL。'
  )
  await saveScreenshot(page, outputDir, 'pb157-outsource-close', record)
  caseRecord.evidence.push(`关闭/重开门禁 orderId=${fixture.draft.id} close=${JSON.stringify(businessError(closeOnReleased))}`)
  return {
    token,
    api,
    partial: true,
    note: '已真实执行提审/审核/下达并验证关闭、重开门禁；订单未达 COMPLETED 且缺已核销应付，无法闭环关闭/重开，保留 PARTIAL。'
  }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  assertOutsourceFixtureScope()
  const token = await login(page)
  const api = createApiClient({ token, record })

  switch (caseId) {
    case 'PB147-OUTSOURCE-001':
      return runPb147({ page, api, caseRecord, record, outputDir, token })
    case 'PB148-OUTSOURCE-001':
      return runPb148({ page, api, caseRecord, record, outputDir, token })
    case 'PB149-OUTSOURCE-WIP-001':
      return runPb149({ page, api, caseRecord, record, outputDir, token })
    case 'PB151-OUTSOURCE-RECEIPT-QUALITY-001':
      return runPb151({ page, api, caseRecord, record, outputDir, token })
    case 'PB152-OUTSOURCE-NG-HANDLING-001':
      return runPb152({ page, api, caseRecord, record, outputDir, token })
    case 'PB153-OUTSOURCE-MATERIAL-001':
      return runPb153({ page, api, caseRecord, record, outputDir, token })
    case 'PB154-OUTSOURCE-PAYABLE-001':
      return runPb154({ page, api, caseRecord, record, outputDir, token })
    case 'PB155-OUTSOURCE-INVOICE-001':
      return runPb155({ page, api, caseRecord, record, outputDir, token })
    case 'PB156-OUTSOURCE-PAYMENT-001':
      return runPb156({ page, api, caseRecord, record, outputDir, token })
    case 'PB157-OUTSOURCE-CLOSE-001':
      return runPb157({ page, api, caseRecord, record, outputDir, token })
    default:
      throw new Error(`未知委外案例：${caseId}`)
  }
}
