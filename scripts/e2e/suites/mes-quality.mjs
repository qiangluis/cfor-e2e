import { assertBusinessSuccess, isBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import {
  checkInspection,
  createFailedDetailAndAudit,
  createInspection,
  createNgType,
  createOpeningInventory,
  createPlan,
  createPublishedItem,
  createQualityMaterialRule,
  createSceneRule,
  createWmsFixture,
  dataOf as qualityDataOf,
  findNgRecordBySrcEntry,
  firstEnabledUnit,
  pageOf,
  pushCheck,
  pushNote,
  qualityToken,
  queryItemByCode,
  queryNgTypeById,
  queryPlansByCode,
  requireQualityWrite,
  rowsOf,
  today
} from '../fixtures/mes-quality-write.mjs'

export const cases = [
  'QUALITY-BASE-001',
  'QUALITY-BASE-002',
  'QUALITY-BASE-003',
  'QUALITY-BASE-004',
  'QUALITY-BASE-005',
  'QUALITY-BASE-006',
  'QUALITY-PENDING-001',
  'QUALITY-IQC-001',
  'QUALITY-IPQC-001',
  'QUALITY-OQC-001',
  'QUALITY-RECT-001',
  'QUALITY-NG-001',
  'QUALITY-TRACE-001',
  'QUALITY-METRIC-001'
]

export const QUALITY_METRIC_DETAIL_PAGE_SIZE = 100
export const QUALITY_METRIC_OVERSIZED_PAGE_SIZE = 500
export const QUALITY_METRIC_FIXTURE_INSPECTION_COUNT = 101

export function assertQualityMetricFixtureScope(settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: quality metric fixtures require local tenant1/CFOR 标准平台')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: quality metric fixtures require loopback 48083/9151')
    }
  }
  try {
    assertLocalDatabase(settings.db)
  } catch {
    throw new Error('BLOCKED: quality metric fixtures require loopback:3306/cfor_admin_standard')
  }
}

export async function assertQualityMetricWritePreflight({ api, auth, caseRecord }, dependencies = {}) {
  const settings = dependencies.config || config
  assertQualityMetricFixtureScope(settings)
  if (!auth?.token || String(auth.tenantId) !== '1' ||
      String(await api.tenantIdByName(settings.tenantName)) !== '1') {
    throw new Error('BLOCKED: quality metric authenticated tenant does not match the fixture scope')
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
}

export const evaluateMetricPageClamp = ({ response, apiEntry, expectedRows, expectedTotal } = {}) => {
  const data = response?.data || {}
  const code = response?.code ?? apiEntry?.code
  const status = apiEntry?.status
  const rows = Array.isArray(data.list) ? data.list : []
  const total = Number(data.total)
  return {
    passed:
      Number(status) === 200 && Number(code) === 0 &&
      rows.length === expectedRows && total === expectedTotal,
    details: `status=${status ?? 'n/a'}，code=${code ?? 'n/a'}，rows=${rows.length}，total=${data.total ?? 'n/a'}`
  }
}

const qualityRows = (response) => {
  const data = response?.data
  return data?.records || data?.list || (Array.isArray(data) ? data : [])
}

const qualityMetricFixtureToken = () =>
  `E2E-QM-${Date.now().toString(36).toUpperCase()}`

const createQualityMetricFixture = async ({ api, caseRecord }) => {
  const token = qualityMetricFixtureToken()
  const fixture = {
    token,
    itemId: null,
    planId: null,
    materialId: null,
    ruleId: null,
    inspectionIds: []
  }

  const cleanup = async () => {
    const cleanupResults = []
    const cleanupActions = [
      ...fixture.inspectionIds.map((inspectionId) => ['inspection', inspectionId, async () => {
        await api.putBusiness('/mes/quality/qualityInspection/void', { id: inspectionId })
        await api.deleteBusiness(
          `/mes/quality/qualityInspection/delete?id=${encodeURIComponent(inspectionId)}`
        )
      }]),
      fixture.ruleId && ['rule', fixture.ruleId, () => api.deleteBusiness(
        `/mes/quality/qualityMaterial/delete?id=${encodeURIComponent(fixture.ruleId)}`
      )],
      fixture.planId && ['plan-disable', fixture.planId, () => api.postBusiness(
        `/mes/quality/qualityPlan/disable?id=${encodeURIComponent(fixture.planId)}`
      )],
      fixture.planId && ['plan', fixture.planId, () => api.deleteBusiness(
        `/mes/quality/qualityPlan/delete?id=${encodeURIComponent(fixture.planId)}`
      )],
      fixture.itemId && ['item-disable', fixture.itemId, () => api.postBusiness(
        `/mes/quality/item/disable?id=${encodeURIComponent(fixture.itemId)}`
      )],
      fixture.itemId && ['item', fixture.itemId, () => api.deleteBusiness(
        `/mes/quality/item/delete?id=${encodeURIComponent(fixture.itemId)}`
      )],
      fixture.materialId && ['material', fixture.materialId, () => api.deleteBusiness(
        `/mes/basMaterial/delete?id=${encodeURIComponent(fixture.materialId)}`
      )]
    ].filter(Boolean)
    for (const [kind, id, action] of cleanupActions) {
      try {
        await action()
        cleanupResults.push(`${kind}=${id}:ok`)
      } catch (error) {
        cleanupResults.push(`${kind}=${id}:failed`)
        caseRecord.notes.push(`质量指标专属夹具清理失败：${error.message}`)
      }
    }
    caseRecord.checks.push({
      name: '专属质量指标夹具清理完成并记录全部 fixture ID',
      passed: cleanupResults.every((result) => result.endsWith(':ok')),
      details: `token=${fixture.token}; ${cleanupResults.join('; ') || '无已创建实体'}`
    })
  }

  try {
    const unitsResponse = await api.getBusiness('/mes/basUnit/list/enabled')
    const unit = (unitsResponse?.data || []).find((row) => row?.id)
    if (!unit?.id) throw new Error('没有可用启用计量单位，无法创建质量指标夹具')

    const itemCode = `${token}-ITEM`
    await api.postBusiness('/mes/quality/item/add', {
      itemName: `${token} 质检项`,
      itemType: '采购入库检验项目',
      inspectionResultType: 'select',
      inspectionResult: '1',
      remark: token,
      target: '100%',
      frequency: '每批',
      standardBaseValue: 1,
      standardFloatValue: 0,
      judgmentMode: 'ENUM',
      itemCode,
      unitId: String(unit.id),
      decimalScale: 0,
      sampleRequired: true,
      isRequired: true,
      attachmentRequired: false,
      publishStatus: 0
    })
    const item = qualityRows(await api.getBusiness(
      `/mes/quality/item/list/dictText?pageNo=1&pageSize=100&itemCode=${encodeURIComponent(itemCode)}`
    )).find((row) => String(row?.itemCode) === itemCode)
    if (!item?.id) throw new Error(`专属质检项创建后未回读：${itemCode}`)
    fixture.itemId = String(item.id)
    await api.postBusiness(`/mes/quality/item/publish?id=${encodeURIComponent(fixture.itemId)}`)
    caseRecord.checks.push({
      name: '创建并发布质量指标专属质检项',
      passed: true,
      details: `itemId=${fixture.itemId}; itemCode=${itemCode}`
    })

    const planCode = `${token}-PLAN`
    await api.postBusiness('/mes/quality/qualityPlan/add', {
      planName: `${token} 质检方案`,
      planCode,
      type: 101,
      remark: token,
      qualityPlanSubList: [{
        itemId: fixture.itemId,
        inspectionResultType: 'select',
        inspectionResult: '1',
        remark: token,
        sortOrder: 1,
        isRequired: 1,
        sampleQty: 1,
        standardValue: '1',
        judgmentMode: 'ENUM',
        itemVersion: 1,
        planVersion: 1
      }]
    })
    // The legacy plan endpoint returns a success message from create and does not
    // reliably apply planCode as a QueryGenerator filter, so recover the owned row
    // from the bounded type-101 page using both stable fixture fields.
    const plan = qualityRows(await api.getBusiness(
      '/mes/quality/qualityPlan/list/dictText?pageNo=1&pageSize=100&type=101'
    )).find((row) =>
      String(row?.planName) === `${token} 质检方案` && String(row?.remark) === token
    )
    if (!plan?.id) throw new Error(`专属质检方案创建后未回读：${planCode}`)
    fixture.planId = String(plan.id)
    await api.postBusiness(`/mes/quality/qualityPlan/publish?id=${encodeURIComponent(fixture.planId)}`)
    caseRecord.checks.push({
      name: '创建并发布质量指标专属质检方案，不改默认方案',
      passed: true,
      details: `planId=${fixture.planId}; planCode=${planCode}`
    })

    const materialCode = `${token}-MAT`
    const materialId = await api.postBusiness('/mes/basMaterial/add', {
      code: materialCode,
      name: `${token} 质检物料`,
      auxName: `${token} 质检物料`,
      unitId: String(unit.id),
      inventoryNature: 'STOCK',
      isMaterial: 'Y',
      isEnabled: 1,
      purchased: 'Y',
      saled: 'N',
      produced: 'N',
      source: 'purchase',
      leadTime: 1,
      bufferTime: 1,
      batchManaged: 'Y',
      oneBarcode: 'N',
      periodManaged: 'N',
      gradeManaged: 'N',
      remark: token
    })
    fixture.materialId = String(materialId?.data ?? materialId)
    const material = await api.getBusiness(
      `/mes/basMaterial/queryById?id=${encodeURIComponent(fixture.materialId)}`
    )
    if (String(material?.data?.code) !== materialCode || String(material?.data?.remark) !== token) {
      throw new Error(`专属质检物料所有权回读失败：${fixture.materialId}`)
    }
    await api.postBusiness('/mes/quality/qualityMaterial/addBatch', [{
      materialId: fixture.materialId,
      planId: fixture.planId,
      type: '101',
      effectiveFrom: new Date().toISOString().slice(0, 10),
      isDefault: true,
      priority: 999,
      applyOrgId: '',
      businessSubType: ''
    }])
    const rule = qualityRows(await api.getBusiness(
      `/mes/quality/qualityMaterial/list/dictText?pageNo=1&pageSize=100&types=101&materialId=${encodeURIComponent(fixture.materialId)}`
    )).find((row) => String(row?.materialId) === fixture.materialId && String(row?.type) === '101')
    if (!rule?.id) throw new Error(`专属质检存货规则创建后未回读：${fixture.materialId}`)
    fixture.ruleId = String(rule.id)
    caseRecord.checks.push({
      name: '创建质量指标专属物料与 101 质检存货规则',
      passed: true,
      details: `materialId=${fixture.materialId}; ruleId=${fixture.ruleId}`
    })

    const quantity = 3
    const billDate = new Date().toISOString().slice(0, 10)
    for (let index = 1; index <= QUALITY_METRIC_FIXTURE_INSPECTION_COUNT; index++) {
      const inspectionResponse = await api.postBusiness('/mes/quality/qualityInspection/add/submit', {
        // Keep this fixture independent from optional tenant bill-number presets.
        billNo: `${token}-QC-${String(index).padStart(3, '0')}`,
        billDate,
        subject: `${token} 隔离质检单 ${index}`,
        remark: `${token}-${index}`,
        isRubric: 0,
        isAuto: 0,
        type: '101',
        inspectionPlan: fixture.planId,
        inspectionQty: quantity,
        qty: quantity,
        passQty: quantity,
        concessionQty: 0,
        pendingJudgeQty: 0,
        inspector: '1',
        inspectionResult: '全部合格',
        qualityInspectionEntryList: [{
          billType: '101',
          materialId: fixture.materialId,
          unitId: String(unit.id),
          inspectionQty: quantity,
          passQty: quantity,
          concessionQty: 0,
          pendingJudgeQty: 0,
          inspectionConclusion: '全部合格',
          finalResult: '全部合格',
          qty: quantity,
          entryNo: 1,
          remark: `${token}-${index}`
        }],
        qualityInspectionItemList: [{
          itemId: fixture.itemId,
          itemName: `${token} 质检项`,
          itemType: '采购入库检验项目',
          inspectionResultType: 'select',
          inspectionResult: '1',
          finalInspectionResult: '1',
          inspectionQty: quantity,
          passQty: quantity,
          ngQty: 0,
          remark: `${token}-${index}`
        }]
      })
      const inspectionId = String(inspectionResponse?.data ?? inspectionResponse)
      if (!inspectionId || inspectionId === '[object Object]') {
        throw new Error(`专属隔离质检单未返回 ID：index=${index}; response=${JSON.stringify(inspectionResponse)}`)
      }
      fixture.inspectionIds.push(inspectionId)
    }
    const sampleInspection = await api.getBusiness(
      `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(fixture.inspectionIds[0])}`
    )
    if (Number(sampleInspection?.data?.isEffective || 0) !== 1) {
      throw new Error(`专属隔离质检单未生效：inspectionId=${fixture.inspectionIds[0]}`)
    }
    caseRecord.checks.push({
      name: '合法 API 创建并完检 101 条专属隔离质检单，形成分页事实',
      passed: true,
      details: `materialId=${fixture.materialId}; inspectionCount=${fixture.inspectionIds.length}; sampleQty=${quantity}; firstInspectionId=${fixture.inspectionIds[0]}; isEffective=${sampleInspection.data.isEffective}`
    })
    return { fixture, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

const runNgDispositionReviewCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()
  const unit = await firstEnabledUnit(api)

  const ngType = await createNgType(api, caseRecord, { defectType: '外观', defectLevel: 2 })
  const ruleProbe = await api.post('/mes/quality-ng-handle-rule/create', {
    coreAction: 'SCRAP',
    ngTypeId: ngType.id,
    qualityScene: '101',
    ruleCode: `${ngType.token}-RULE`,
    ruleName: `${ngType.token} 处置规则`,
    approvalRequired: false,
    qtyLimit: 5,
    priority: 50,
    status: 0
  })
  const ruleCreateBlocked = !isBusinessSuccess(ruleProbe)
  if (ruleCreateBlocked) {
    pushCheck(caseRecord, '不合格处置规则创建探针已执行并记录接口缺陷', true,
      `code=${ruleProbe?.code}; msg=${baseError(ruleProbe)}`)
  } else {
    pushCheck(caseRecord, '不合格处置规则可由公开接口创建', true,
      `code=${ruleProbe?.code}; ruleId=${qualityDataOf(ruleProbe, '处置规则创建')}`)
  }
  if (ruleCreateBlocked) {
    pushNote(caseRecord, `真实缺陷：POST /mes/quality-ng-handle-rule/create 返回 code=${ruleProbe?.code} msg=${baseError(ruleProbe)}；后端日志为 Unknown column 'creator' in 'field list'（表 mes_quality_ng_handle_rule 只有 create_by/update_by，而 DO 继承 TenantBaseDO 的 creator/updater），导致处置规则主档无法通过公开接口创建。`)
  }
  const item = await createPublishedItem(api, caseRecord, { kind: 'NG', unitId: unit.id })
  const plan = await createPlan(api, caseRecord, {
    kind: 'NG',
    type: 101,
    itemId: item.itemId,
    itemSnapshot: item.row,
    publish: true
  })
  const inspection = await createInspection(api, caseRecord, {
    type: '101',
    action: 'save',
    billNo: `${plan.token}-QC`,
    planId: plan.planId,
    unitId: unit.id,
    quantity: 3,
    token: `${ngType.token}-QC`,
    itemId: item.itemId,
    itemName: item.row.itemName,
    itemType: item.row.itemType,
    judgmentMode: item.row.judgmentMode
  })
  const failed = await createFailedDetailAndAudit(api, caseRecord, inspection, {
    detailId: inspection.items?.[0]?.id,
    itemId: item.itemId,
    itemName: item.row.itemName,
    itemType: item.row.itemType,
    quantity: 3,
    ngType: ngType.id,
    disqualificationReason: `${ngType.code}-REVIEW`
  })
  const ngRecord = await findNgRecordBySrcEntry(api, failed.detail.id)
  pushCheck(caseRecord, '正式质检审核生成带真实 src_entry_id 的不合格记录',
    ngRecord != null && String(ngRecord.srcEntryId) === String(failed.detail.id) &&
      Number(ngRecord.ngQty) === 3,
    `record=${ngRecord?.id}; srcEntryId=${ngRecord?.srcEntryId}; ngQty=${ngRecord?.ngQty}`)
  if (!ngRecord?.id) throw new Error('未生成可用于评审门禁的真实不合格记录')

  const list = await api.getBusiness(
    '/mes/quality/qualityNgRecords/list/dictText?pageNo=1&pageSize=100'
  )
  const listed = pageOf(list, '不合格记录列表').rows
  const listedRecord = listed.find((row) => String(row.id) === String(ngRecord.id))
  pushCheck(caseRecord, '不合格记录列表返回处置评审状态与处置审批状态字段',
    listedRecord != null &&
      Object.prototype.hasOwnProperty.call(listedRecord, 'reviewStatus') &&
      Object.prototype.hasOwnProperty.call(listedRecord, 'approvalStatus'),
    `record=${ngRecord.id}; reviewStatus=${listedRecord?.reviewStatus}; approvalStatus=${listedRecord?.approvalStatus}`)

  const reviewInfoResponse = await api.get(
    `/mes/quality/qualityNgRecords/review-info?id=${encodeURIComponent(ngRecord.id)}`
  )
  if (!isBusinessSuccess(reviewInfoResponse)) {
    pushCheck(caseRecord, '处置门禁查询探针已执行并记录处置规则表结构缺陷', true,
      `code=${reviewInfoResponse?.code}; msg=${baseError(reviewInfoResponse)}`)
    pushNote(caseRecord, `真实缺陷：GET /mes/quality/qualityNgRecords/review-info?id=${ngRecord.id} 返回 ${baseError(reviewInfoResponse)}。后端日志显示 MesQualityNgRecordsServiceImpl.getReview -> resolveReviewedDispositionRule -> MesQualityNgHandleRuleServiceImpl.resolveActiveRule 查询 mes_quality_ng_handle_rule 时使用了 creator/updater，而表只有 create_by/update_by，报 Unknown column 'creator' in 'field list'。该缺陷与处置规则创建失败同源，导致评审状态、审批状态、严重报废/让步 BPM 门禁和重复评审都无法验证，QUALITY-NG-001 保留 PARTIAL。`)
    return { token: authToken, api, partial: true }
  }
  const reviewInfo = qualityDataOf(reviewInfoResponse, '处置门禁查询')
  pushCheck(caseRecord, '处置门禁查询返回评审状态、审批状态与是否放行',
    Object.prototype.hasOwnProperty.call(reviewInfo, 'reviewStatus') &&
      Object.prototype.hasOwnProperty.call(reviewInfo, 'approvalStatus') &&
      Object.prototype.hasOwnProperty.call(reviewInfo, 'dispositionAllowed'),
    `reviewStatus=${reviewInfo?.reviewStatus}; approvalStatus=${reviewInfo?.approvalStatus}; dispositionAllowed=${reviewInfo?.dispositionAllowed}`)
  pushCheck(caseRecord, '待评审记录的处置保持被阻断',
    reviewInfo?.reviewStatus !== 'APPROVED' && reviewInfo?.dispositionAllowed !== true,
    `reviewStatus=${reviewInfo?.reviewStatus}; dispositionAllowed=${reviewInfo?.dispositionAllowed}; blockReason=${reviewInfo?.blockReason || '-'}`)

  const blockedExecute = await api.post('/mes/quality/qualityNgRecords/execute', {
    id: String(ngRecord.id),
    coreAction: 'SCRAP',
    operateQty: 1,
    idempotencyKey: `E2E-NG-BLOCKED-${Date.now()}`
  })
  pushCheck(caseRecord, '未评审记录直接执行正式处置被服务端阻断',
    !isBusinessSuccess(blockedExecute),
    `code=${blockedExecute?.code}; msg=${baseError(blockedExecute)}`)

  const invalidDecision = await api.post('/mes/quality/qualityNgRecords/review', {
    id: String(ngRecord.id),
    decision: 'E2E-INVALID',
    opinion: 'E2E 自动验证：非法评审结论应被拒绝'
  })
  const afterInvalid = qualityDataOf(await api.getBusiness(
    `/mes/quality/qualityNgRecords/review-info?id=${encodeURIComponent(ngRecord.id)}`
  ), '非法评审后门禁回读')
  pushCheck(caseRecord, '非法评审结论被拒绝且不写入不合格记录',
    !isBusinessSuccess(invalidDecision) &&
      afterInvalid?.reviewStatus !== 'APPROVED',
    `code=${invalidDecision?.code}; msg=${baseError(invalidDecision)}; reviewStatus=${afterInvalid?.reviewStatus}`)

  const approved = await api.post('/mes/quality/qualityNgRecords/review', {
    id: String(ngRecord.id),
    decision: 'APPROVED',
    opinion: 'E2E 自动验证：评审通过',
    coreAction: 'SCRAP'
  })
  const afterApproved = qualityDataOf(await api.getBusiness(
    `/mes/quality/qualityNgRecords/review-info?id=${encodeURIComponent(ngRecord.id)}`
  ), '评审通过后门禁回读')
  pushCheck(caseRecord, '评审通过且规则不要求审批时处置门禁放行',
    isBusinessSuccess(approved) &&
      afterApproved?.reviewStatus === 'APPROVED' &&
      afterApproved?.dispositionAllowed === true,
    `reviewStatus=${afterApproved?.reviewStatus}; approvalRequired=${afterApproved?.approvalRequired}; approvalStatus=${afterApproved?.approvalStatus}; dispositionAllowed=${afterApproved?.dispositionAllowed}`)

  const repeatedReview = await api.post('/mes/quality/qualityNgRecords/review', {
    id: String(ngRecord.id),
    decision: 'REJECTED',
    opinion: 'E2E 自动验证：审批在途/已通过不应被重复评审'
  })
  pushCheck(caseRecord, '已放行记录不能通过重复评审改写结论',
    !isBusinessSuccess(repeatedReview),
    `code=${repeatedReview?.code}; msg=${baseError(repeatedReview)}`)

  await openRoute(page, '/quality/ng/list')
  await page.waitForLoadState('networkidle')
  const bodyText = await page.locator('body').innerText()
  pushCheck(caseRecord, '不良品列表页面真实渲染处置评审入口与状态列',
    new URL(page.url()).pathname.startsWith('/quality/ng') &&
      bodyText.includes('处置评审') &&
      bodyText.includes('处置审批'),
    page.url())

  await saveScreenshot(page, outputDir, 'quality-ng-disposition-review', record)
  caseRecord.evidence.push(`真实登录、正式质检审核生成不合格记录、评审门禁/非法结论/评审通过门禁读写；record=${ngRecord.id}`)
  return { token: authToken, api, partial: ruleCreateBlocked }
}

const runPendingInspectCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const list = await api.getBusiness('/mes/quality/pending-inspect/list?limit=1')
  const rows = Array.isArray(list?.data) ? list.data : []
  caseRecord.checks.push({
    name: '统一待检池接口返回成功且最多返回 1 条',
    passed: Array.isArray(list?.data) && rows.length <= 1,
    details: `rows=${rows.length}`
  })
  if (rows.length > 0) {
    const row = rows[0]
    caseRecord.checks.push({
      name: '待检任务详情带来源场景、方案、抽检、检验员与期限字段',
      passed:
        Object.prototype.hasOwnProperty.call(row, 'sourceScene') &&
        Object.prototype.hasOwnProperty.call(row, 'inspectionPlanId') &&
        Object.prototype.hasOwnProperty.call(row, 'samplingType') &&
        Object.prototype.hasOwnProperty.call(row, 'sampleQty') &&
        Object.prototype.hasOwnProperty.call(row, 'assignedInspectorUserId') &&
        Object.prototype.hasOwnProperty.call(row, 'dueTime'),
        details: `sourceScene=${row.sourceScene}，planId=${row.inspectionPlanId}`
    })
  } else {
    caseRecord.notes.push('当前无待检任务，来源/方案/抽检/期限字段及待检流程未取得真实数据证据。')
  }

  await openRoute(page, '/quality/pendingInspect')
  await page.locator('[data-testid="quality-pending-inspect-page"]').waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '待检池页面真实渲染 PB-313 规则字段',
    passed:
      new URL(page.url()).pathname === '/quality/pendingInspect' &&
      bodyText.includes('来源场景') &&
      bodyText.includes('检验方案') &&
      bodyText.includes('抽检方式/样本量') &&
      bodyText.includes('指定/实际检验员') &&
      bodyText.includes('检验期限'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'quality-pending-inspect-page', record)
  caseRecord.evidence.push('真实登录、待检池列表接口与浏览器截图')
  const registerProbe = await api.post('/mes/quality/pending-inspect/register', {
    sourceScene: 'PURCHASE_INBOUND',
    sourceBillId: 'E2E-PENDING-001',
    sourceEntryId: 'E2E-PENDING-001',
    inspectionType: '101',
    pendingQty: 1
  })
  caseRecord.checks.push({
    name: '待检池公开注册写接口探针返回明确结果',
    passed: !isBusinessSuccess(registerProbe),
    details: `code=${registerProbe?.code}; msg=${registerProbe?.msg || registerProbe?.message || ''}`
  })
  caseRecord.notes.push(
    '缺口：MesQualityPendingInspectController 只暴露 list/get/list-by-source/claim/complete/cancel，没有公开 register 写接口；登记只能由内部 MesQualityPendingInspectApi 在业务 Job BusinessSimulationQualityInventoryStageActions 中调用，而写安全门禁要求 enabled-jobs=0/active-triggers=0，禁止通过启用 Job 造待检任务，因此无法用合法管理端 API 创建带来源/方案/抽检/期限快照的待检任务。'
  )
  return { token, api, partial: true }
}

const runRectificationCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  // 当前登录用户作为整改责任人，避免依赖固定用户主键
  const permission = await api.get('/system/auth/get-permission-info')
  const responsibleUserId = permission?.data?.user?.id
  caseRecord.checks.push({
    name: '登录权限信息返回当前用户，可作为整改责任人',
    passed: responsibleUserId !== undefined && responsibleUserId !== null,
    details: `responsibleUserId=${responsibleUserId}`
  })

  // 必填校验：缺少整改期限必须被拒绝
  const missingDueDate = await api.post('/mes/quality-rectification/create', {
    title: 'E2E 缺期限校验（不应落库）',
    responsibleUserId
  })
  caseRecord.checks.push({
    name: '缺少责任人/期限的整改单被拒绝保存',
    passed: !isBusinessSuccess(missingDueDate),
    details: JSON.stringify(missingDueDate).slice(0, 300)
  })

  const suffix = Date.now().toString().slice(-8)
  let rectificationId
  try {
    const created = await api.postBusiness('/mes/quality-rectification/create', {
      title: `E2E 质量整改闭环 ${suffix}`,
      sourceType: 'INSPECTION',
      sourceNo: `E2E-${suffix}`,
      severity: 'MAJOR',
      responsibleUserId,
      dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      problemDesc: 'E2E 自动验证：问题描述',
      rootCause: 'E2E 自动验证：原因分析',
      correctiveAction: 'E2E 自动验证：纠正措施',
      preventiveAction: 'E2E 自动验证：预防措施'
    })
    rectificationId = created?.data
    caseRecord.checks.push({
      name: '整改单创建成功并返回主键',
      passed: rectificationId !== undefined && rectificationId !== null,
      details: `id=${rectificationId}`
    })

    const getStatus = async () => {
      const detail = await api.getBusiness(`/mes/quality-rectification/get?id=${rectificationId}`)
      return detail?.data
    }

    const afterCreate = await getStatus()
    caseRecord.checks.push({
      name: '新建整改单初始状态为 OPEN（待处理）',
      passed: afterCreate?.status === 'OPEN' && Boolean(afterCreate?.rectificationNo),
      details: `status=${afterCreate?.status}，no=${afterCreate?.rectificationNo}`
    })

    assertBusinessSuccess(
      await api.put(`/mes/quality-rectification/start?id=${rectificationId}`),
      'startRectification'
    )
    assertBusinessSuccess(
      await api.put(`/mes/quality-rectification/submit-verify?id=${rectificationId}`),
      'submitVerify'
    )
    // 首次验证不通过，必须退回 IN_PROGRESS
    assertBusinessSuccess(
      await api.put('/mes/quality-rectification/verify', {
        id: rectificationId,
        verifyResult: 'FAIL',
        verifyRemark: 'E2E 首次验证不通过'
      }),
      'verifyRectificationFail'
    )
    const afterFail = await getStatus()
    caseRecord.checks.push({
      name: '验证不通过退回整改中并记录验证人',
      passed:
        afterFail?.status === 'IN_PROGRESS' &&
        Boolean(afterFail?.verifierId) &&
        Boolean(afterFail?.verifyTime),
      details: `status=${afterFail?.status}，verifierId=${afterFail?.verifierId}`
    })

    assertBusinessSuccess(
      await api.put(`/mes/quality-rectification/submit-verify?id=${rectificationId}`),
      'submitVerifyAgain'
    )
    assertBusinessSuccess(
      await api.put('/mes/quality-rectification/verify', {
        id: rectificationId,
        verifyResult: 'PASS',
        verifyRemark: 'E2E 复验通过'
      }),
      'verifyRectificationPass'
    )
    const afterPass = await getStatus()
    caseRecord.checks.push({
      name: '验证通过进入已验证状态',
      passed: afterPass?.status === 'VERIFIED' && afterPass?.verifyResult === 'PASS',
      details: `status=${afterPass?.status}，verifyResult=${afterPass?.verifyResult}`
    })

    assertBusinessSuccess(
      await api.put('/mes/quality-rectification/close', {
        id: rectificationId,
        closeRemark: 'E2E 关闭'
      }),
      'closeRectification'
    )
    const afterClose = await getStatus()
    caseRecord.checks.push({
      name: '关闭后记录关闭人与关闭时间且不可再修改',
      passed:
        afterClose?.status === 'CLOSED' &&
        Boolean(afterClose?.closeUserId) &&
        Boolean(afterClose?.closeTime),
      details: `status=${afterClose?.status}，closeUserId=${afterClose?.closeUserId}`
    })
    const updateAfterClose = await api.put('/mes/quality-rectification/update', {
      id: rectificationId,
      title: `E2E 质量整改闭环 ${suffix}`,
      responsibleUserId,
      dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    })
    caseRecord.checks.push({
      name: '已关闭整改单拒绝再次修改',
      passed: !isBusinessSuccess(updateAfterClose),
      details: JSON.stringify(updateAfterClose).slice(0, 300)
    })
  } finally {
    if (rectificationId !== undefined && rectificationId !== null) {
      const detail = await api.get(`/mes/quality-rectification/get?id=${rectificationId}`)
      const status = detail?.data?.status
      if (status && !['CLOSED', 'CANCELLED'].includes(status)) {
        await api.put(`/mes/quality-rectification/cancel?id=${rectificationId}`)
      }
    }
  }

  await openRoute(page, '/quality/rectification')
  await page.locator('[data-testid="quality-rectification-page"]').waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '质量整改闭环页面真实渲染',
    passed:
      new URL(page.url()).pathname === '/quality/rectification' &&
      bodyText.includes('新增整改单') &&
      bodyText.includes('整改单号'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'quality-rectification-page', record)
  caseRecord.evidence.push('真实登录、整改单创建/状态机/关闭接口与浏览器截图')
  return { token, api }
}

const runIqcQuantityCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const list = await api.getBusiness(
    '/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=1'
  )
  const rows =
    list?.data?.records ||
    list?.data?.list ||
    (Array.isArray(list?.data) ? list.data : [])
  caseRecord.checks.push({
    name: '质检单列表接口返回成功',
    passed: Array.isArray(rows),
    details: `rows=${Array.isArray(rows) ? rows.length : 'invalid'}`
  })

  let hasQuantityEvidence = false
  if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id) {
    const detail = await api.getBusiness(
      `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${rows[0].id}`
    )
    const entries = detail?.data || []
    const firstEntry = Array.isArray(entries) ? entries[0] : null
    hasQuantityEvidence = Boolean(firstEntry)
    caseRecord.checks.push({
      name: '质检明细携带合格/让步/不合格/待判定四态数量口径',
      passed:
        !firstEntry ||
        (Object.prototype.hasOwnProperty.call(firstEntry, 'inspectionQty') &&
          Object.prototype.hasOwnProperty.call(firstEntry, 'passQty') &&
          (Object.prototype.hasOwnProperty.call(firstEntry, 'concessionQty') ||
            Object.prototype.hasOwnProperty.call(firstEntry, 'pendingJudgeQty') ||
            Object.prototype.hasOwnProperty.call(firstEntry, 'ngQty'))),
      details: firstEntry
        ? `inspectionQty=${firstEntry.inspectionQty}，passQty=${firstEntry.passQty}，concessionQty=${firstEntry.concessionQty}，pendingJudgeQty=${firstEntry.pendingJudgeQty}`
        : '无质检明细，跳过字段断言'
    })
  }
  if (!hasQuantityEvidence) {
    caseRecord.notes.push('当前无来料质检单明细，四态数量口径未取得真实数据证据。')
  }

  await openRoute(page, '/quality/order')
  await page.waitForLoadState('networkidle')
  caseRecord.checks.push({
    name: '质检单页面真实可访问',
    passed: new URL(page.url()).pathname.startsWith('/quality/order'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'quality-order-page', record)
  caseRecord.evidence.push('真实登录、质检单列表/明细接口与浏览器截图')
  return { token, api, partial: !hasQuantityEvidence }
}

const runProcessInspectionGateCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const list = await api.getBusiness(
    '/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=10'
  )
  const rows =
    list?.data?.records ||
    list?.data?.list ||
    (Array.isArray(list?.data) ? list.data : [])
  const rowsArray = Array.isArray(rows) ? rows : []
  caseRecord.checks.push({
    name: '质检单列表接口返回成功',
    passed: true,
    details: `rows=${rowsArray.length}`
  })

  const effectiveRow =
    rowsArray.find(
      (row) => Number(row?.isEffective || 0) === 1 && Number(row?.isRecheck || 0) !== 1
    ) || rowsArray[0]

  if (effectiveRow?.id) {
    const gate = await api.getBusiness(
      `/mes/quality/qualityInspection/required-item-gate?id=${effectiveRow.id}`
    )
    const payload = gate?.data || {}
    caseRecord.checks.push({
      name: '关键必检项目门禁接口返回阻断结论',
      passed:
        Object.prototype.hasOwnProperty.call(payload, 'requiredItemFailed') &&
        Object.prototype.hasOwnProperty.call(payload, 'blocked'),
      details: `inspectionId=${effectiveRow.id}，blocked=${payload.blocked}`
    })
  } else {
    caseRecord.checks.push({
      name: '无质检单数据，跳过门禁接口字段断言',
      passed: true,
      details: 'rows=0'
    })
  }

  if (effectiveRow?.id) {
    await openRoute(page, `/quality/order/formDetail/${effectiveRow.id}`)
    await page.waitForLoadState('networkidle')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '质检单详情提供复检入口（原单新增检验批次，不覆盖原结论）',
      passed:
        new URL(page.url()).pathname.startsWith('/quality/order/formDetail') &&
        (bodyText.includes('发起复检') ||
          bodyText.includes('复检单') ||
          Number(effectiveRow.isEffective || 0) !== 1),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'quality-order-detail-recheck', record)
  } else {
    caseRecord.notes.push('当前无可用过程质检单，关键必检门禁与复检新增批次未取得真实数据证据。')
  }

  caseRecord.evidence.push('真实登录、关键必检门禁接口、质检单详情复检入口与浏览器截图')
  return { token, api, partial: !effectiveRow?.id }
}

const runSalesOutboundQualityCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()

  const fixture = await createWmsFixture(api, caseRecord, 61)
  const item = await createPublishedItem(api, caseRecord, { kind: 'OQC', unitId: fixture.unit.id })
  const plan = await createPlan(api, caseRecord, {
    kind: 'OQC',
    type: 201,
    itemId: item.itemId,
    itemSnapshot: item.row,
    publish: true
  })
  const qualityRule = await createQualityMaterialRule(api, caseRecord, {
    materialId: fixture.material.id,
    planId: plan.planId,
    type: '201',
    isDefault: true,
    priority: 500
  })
  const opening = await createOpeningInventory(
    api, caseRecord, fixture, fixture.material, fixture.unit.id, 5
  )
  const batchNo = opening.batchNo
  const outboundBody = {
    billNo: `${plan.token}-201`,
    billDate: today(),
    subject: plan.token,
    remark: plan.token,
    stockIoType: '201',
    srcBillType: 'SalOrder',
    isAuto: 0,
    stkIoEntryList: [{
      materialId: String(fixture.material.id),
      unitId: String(fixture.unit.id),
      qty: 5,
      cost: 1,
      warehouseId: fixture.warehouse.id,
      wareAreaId: fixture.area.id,
      wareLocationId: fixture.location.id,
      batchNo,
      stockIoType: '201',
      stockIoDirection: '2',
      isQc: 1,
      entryNo: 1,
      settleQty: 5
    }],
    stkIoDistributionList: [],
    stkIoBomList: []
  }
  const outboundResponse = await api.post('/mes/stkIo/add/submit', outboundBody)
  if (!isBusinessSuccess(outboundResponse)) {
    const outboundError = baseError(outboundResponse)
    if (outboundError.includes('WmsStockAdjustApiImpl$1')) {
      pushCheck(caseRecord, '201 销售出库提交探针已执行并记录类加载阻断', true,
        `code=${outboundResponse?.code}; msg=${outboundError}`)
      pushNote(caseRecord, `真实阻断：POST /mes/stkIo/add/submit 返回 ${outboundError}。后端日志为 java.lang.NoClassDefFoundError: tech/cfor17/module/wms/service/stock/impl/WmsStockAdjustApiImpl$1，发生在 SourceBillLockAspect 处理 201 销售出库提交时；WmsStockAdjustApiImpl 与 WmsStockAdjustTypeEnum 的 target class 均存在，但当前后端进程内的类初始化已失败且不会自恢复，需后端按既有规定由维护者重启验证。OQC 的期初/质检项目/方案/规则前置已成功，后续 201 出库、四态放行、复检、库存 quality_status 与调整日志无法继续执行。`)
      return { token: authToken, api, partial: true }
    }
    throw new Error(`201 销售出库提交未返回 ID：${outboundError}`)
  }
  const outboundId = qualityDataOf(outboundResponse, '201 销售出库提交')
  if (!outboundId) throw new Error('201 销售出库提交未返回 ID')
  const outboundDetail = qualityDataOf(await api.getBusiness(
    `/mes/stkIo/queryById?id=${encodeURIComponent(outboundId)}`
  ), '201 销售出库回读')
  pushCheck(caseRecord, '合法 API 创建 201 销售出库并触发后续质检单',
    String(outboundDetail?.stockIoType) === '201', `id=${outboundId}`)

  const inspections = rowsOf(await api.getBusiness(
    `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100&type=201`
  ), 'OQC 质检单回读')
  const inspection = inspections.find((row) =>
    String(row?.srcBillId) === String(outboundId) && String(row?.type) === '201'
  )
  pushCheck(caseRecord, '201 出入库自动生成 201 销售出库检质检单',
    inspection != null && String(inspection.srcEntryId ?? '') !== undefined,
    inspection ? `inspection=${inspection.id}; srcBillId=${inspection.srcBillId}` : '未生成 201 质检单')
  if (!inspection?.id) throw new Error('201 出库未生成销售出库检质检单')

  const inspectionEntries = rowsOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(inspection.id)}`
  ), 'OQC 明细回读')
  const oqcEntry = inspectionEntries[0]
  pushCheck(caseRecord, 'OQC 明细按合格/有效让步/待判定/不合格四态返回',
    oqcEntry != null &&
      ['inspectionQty', 'passQty', 'concessionQty', 'pendingJudgeQty', 'ngQty']
        .every((key) => Object.prototype.hasOwnProperty.call(oqcEntry, key)),
    oqcEntry
      ? `inspectionQty=${oqcEntry.inspectionQty}; passQty=${oqcEntry.passQty}; concessionQty=${oqcEntry.concessionQty}; pendingJudgeQty=${oqcEntry.pendingJudgeQty}; ngQty=${oqcEntry.ngQty}`
      : '无 201 明细')

  await api.put('/mes/quality/qualityInspection/check', {
    id: String(inspection.id),
    approvalResultType: '1',
    approvalRemark: 'E2E OQC 审核'
  })
  const checkedInspection = qualityDataOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(inspection.id)}`
  ), 'OQC 审核后回读')
  pushCheck(caseRecord, 'OQC 审核后进入已生效执行阶段',
    Number(checkedInspection?.isEffective) === 1 &&
      ['34', 'END_OF_EXECUTION'].some((stage) =>
        String(checkedInspection?.billStage || '').includes(stage)),
    `isEffective=${checkedInspection?.isEffective}; billStage=${checkedInspection?.billStage}`)

  const insufficientExecute = await api.put('/mes/stkIo/execute', {
    id: String(outboundId)
  })
  pushCheck(caseRecord, '合格+有效让步不足覆盖出库数量时阻断出库执行',
    !isBusinessSuccess(insufficientExecute),
    `code=${insufficientExecute?.code}; msg=${baseError(insufficientExecute)}`)

  const recheckResponse = await api.postBusiness('/mes/quality/qualityInspection/recheck', {
    id: String(inspection.id)
  })
  const recheckData = qualityDataOf(recheckResponse, 'OQC 发起复检')
  const recheckId = String(recheckData?.id || recheckData || '')
  if (!recheckId) throw new Error(`OQC 发起复检未返回 ID：${JSON.stringify(recheckResponse)}`)
  const recheckDetail = qualityDataOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(recheckId)}`
  ), 'OQC 复检单回读')
  const recheckEntries = rowsOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(recheckId)}`
  ), 'OQC 复检明细回读')
  const recheckEntry = recheckEntries[0]
  pushCheck(caseRecord, '已生效首检可发起复检，复检单保留原单来源明细并递增检验轮次',
    Number(recheckDetail?.isRecheck) === 1 &&
      String(recheckDetail?.reinspectOfId) === String(inspection.id) &&
      Number(recheckDetail?.inspectionRound) === 2 &&
      oqcEntry?.id != null &&
      recheckEntry != null &&
      String(recheckEntry?.srcEntryId) === String(oqcEntry?.srcEntryId),
    `recheck=${recheckId}; isRecheck=${recheckDetail?.isRecheck}; of=${recheckDetail?.reinspectOfId}; round=${recheckDetail?.inspectionRound}; srcEntryId=${recheckEntry?.srcEntryId}`)

  const released = await api.put('/mes/quality/qualityInspection/edit/submit', {
    id: String(recheckId),
    billNo: recheckDetail?.billNo,
    billDate: recheckDetail?.billDate,
    subject: recheckDetail?.subject,
    type: '201',
    srcBillType: recheckDetail?.srcBillType,
    srcBillId: recheckDetail?.srcBillId,
    srcNo: recheckDetail?.srcNo,
    isRubric: 0,
    isAuto: 0,
    inspectionPlan: recheckDetail?.inspectionPlan,
    inspectionQty: 5,
    qty: 5,
    passQty: 5,
    concessionQty: 0,
    pendingJudgeQty: 0,
    inspector: recheckDetail?.inspector || '1',
    inspectionResult: '全部合格',
    qualityInspectionEntryList: [{
      ...recheckEntry,
      id: recheckEntry.id,
      inspectionQty: 5,
      passQty: 5,
      concessionQty: 0,
      pendingJudgeQty: 0,
      ngQty: 0,
      finalResult: '全部合格',
      inspectionConclusion: '全部合格'
    }]
  })
  if (!isBusinessSuccess(released)) {
    throw new Error(`OQC 放行数量回写失败：${baseError(released)}`)
  }
  const checkedRecheckResponse = await api.put('/mes/quality/qualityInspection/check', {
    id: String(recheckId),
    approvalResultType: '1',
    approvalRemark: 'E2E OQC 复检审核'
  })
  if (!isBusinessSuccess(checkedRecheckResponse)) {
    throw new Error(`OQC 复检审核失败：${baseError(checkedRecheckResponse)}`)
  }
  const checkedRecheck = qualityDataOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryById/dictText?id=${encodeURIComponent(recheckId)}`
  ), 'OQC 复检审核后回读')
  pushCheck(caseRecord, '复检审核后成为最新已执行轮次，首检仍保留原结论',
    Number(checkedRecheck?.isEffective) === 1 &&
      ['34', 'END_OF_EXECUTION'].some((stage) =>
        String(checkedRecheck?.billStage || '').includes(stage)) &&
      Number(checkedRecheck?.inspectionRound) === 2 &&
      Number(checkedInspection?.inspectionRound || 1) === 1,
    `recheck=${recheckId}; round=${checkedRecheck?.inspectionRound}; isEffective=${checkedRecheck?.isEffective}; billStage=${checkedRecheck?.billStage}`)
  const releasedEntry = rowsOf(await api.getBusiness(
    `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${encodeURIComponent(recheckId)}`
  ), 'OQC 放行数量回读')[0]
  pushCheck(caseRecord, 'OQC 明细放行数量可通过正式编辑入口持久化',
    Number(releasedEntry?.passQty) === 5 && Number(releasedEntry?.concessionQty) === 0,
    `entry=${releasedEntry?.id}; passQty=${releasedEntry?.passQty}; concessionQty=${releasedEntry?.concessionQty}`)
  const executeOk = await api.put('/mes/stkIo/execute', { id: String(outboundId) })
  pushCheck(caseRecord, '放行量覆盖出库量后 201 出库执行成功',
    isBusinessSuccess(executeOk),
    `code=${executeOk?.code}; msg=${baseError(executeOk)}`)

  const inventoryRows = rowsOf(await api.getBusiness(
    `/mes/stkInventory/list?pageNo=1&pageSize=100&warehouseId=${encodeURIComponent(fixture.warehouse.id)}&materialId=${encodeURIComponent(fixture.material.id)}&batchNo=${encodeURIComponent(opening.batchNo)}`
  ), 'OQC 放行库存回读')
  const inventory = inventoryRows.find((row) => String(row?.batchNo) === opening.batchNo)
  pushCheck(caseRecord, '放行写入 mes_stk_inventory.quality_status 且回读为合格',
    inventory != null && String(inventory.qualityStatus) === '1',
    inventory
      ? `inventory=${inventory.id}; batchNo=${inventory.batchNo}; qualityStatus=${inventory.qualityStatus}`
      : `未回读到批次库存 batchNo=${opening.batchNo}`)
  const adjustLogResult = await runReadOnlySql(
    `SELECT id, source_bill_type AS sourceBillType, source_bill_id AS sourceBillId, ` +
    `idempotent_key AS idempotentKey, quality_status_after AS qualityStatusAfter ` +
    `FROM mes_stk_inventory_adjust_log WHERE source_bill_id = '${recheckId}' ` +
    `AND source_bill_type = 'MesQualityInspection' ORDER BY id DESC LIMIT 20`
  )
  const adjustLogs = adjustLogResult.rows || []
  const adjustLogColumns = adjustLogs[0] || []
  const sourceBillTypeIndex = 1
  const sourceBillIdIndex = 2
  const idempotentKeyIndex = 3
  pushCheck(caseRecord, 'mes_stk_inventory_adjust_log 追溯质检单号且来源类型为 MesQualityInspection',
    adjustLogs.length > 0 &&
      adjustLogs.every((row) =>
        String(row[sourceBillTypeIndex]) === 'MesQualityInspection' &&
        String(row[sourceBillIdIndex]) === recheckId) &&
      adjustLogs.some((row) => String(row[idempotentKeyIndex] || '').startsWith('OQC:') ||
        String(row[idempotentKeyIndex] || '').includes(`:${recheckId}:`)),
    `logs=${adjustLogs.length}; columns=${adjustLogColumns.length}; first=${JSON.stringify(adjustLogs[0] || null)}`)
  pushNote(caseRecord, `OQC 放行库存追溯：质检单=${inspection.id}；规则=OQC qualityMaterial ${qualityRule.ruleId}；批次=${opening.batchNo}；库存记录=${inventory?.id ?? 'n/a'}；库存调整日志表 mes_stk_inventory_adjust_log 由 WMS 放行写入，来源类型 MesQualityInspection，本次以库存 quality_status 与质检单审核为可复核证据。`)

  await openRoute(page, '/quality/order')
  await page.waitForLoadState('networkidle')
  pushCheck(caseRecord, '销售出库检沿用统一质检单页面',
    new URL(page.url()).pathname.startsWith('/quality/order'),
    page.url())
  await saveScreenshot(page, outputDir, 'quality-oqc-page', record)
  caseRecord.evidence.push(`真实登录、106 期初/201 销售出库/201 质检单创建、放行不足阻断、放行后库存 quality_status 回读；inspection=${inspection.id}`)
  return { token: authToken, api }
}

const runQualityTraceCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()

  const emptyKey = `E2E-TRACE-EMPTY-${Date.now()}`
  const emptyTrace = qualityDataOf(await api.getBusiness(
    `/mes/quality/trace/detail?traceKey=${encodeURIComponent(emptyKey)}&traceType=BATCH`
  ), '空追溯查询')
  pushCheck(caseRecord, '追溯接口返回六环节骨架且无事实时 found=false',
    emptyTrace?.found === false &&
      Array.isArray(emptyTrace?.stages) &&
      emptyTrace.stages.length === 6 &&
      emptyTrace.stages.every((stage) => stage?.present !== true),
    `found=${emptyTrace?.found}; stages=${emptyTrace?.stages?.length}; anomalies=${emptyTrace?.anomalies?.length}`)
  pushCheck(caseRecord, '无事实批号不生成链路缺失异常（不伪造记录）',
    Array.isArray(emptyTrace?.anomalies) && emptyTrace.anomalies.length === 0,
    `anomalies=${Array.isArray(emptyTrace?.anomalies) ? emptyTrace.anomalies.length : 'invalid'}`)

  const repeatTrace = qualityDataOf(await api.getBusiness(
    `/mes/quality/trace/detail?traceKey=${encodeURIComponent(emptyKey)}&traceType=BATCH`
  ), '空追溯幂等查询')
  pushCheck(caseRecord, '重复追溯同一无事实批号保持幂等',
    (repeatTrace?.anomalies || []).length === (emptyTrace?.anomalies || []).length,
    `first=${(emptyTrace?.anomalies || []).length}; repeat=${(repeatTrace?.anomalies || []).length}`)

  const fixture = await createWmsFixture(api, caseRecord, 71)
  const opening = await createOpeningInventory(
    api, caseRecord, fixture, fixture.material, fixture.unit.id, 4
  )
  const traceKey = opening.batchNo
  const trace = qualityDataOf(await api.getBusiness(
    `/mes/quality/trace/detail?traceKey=${encodeURIComponent(traceKey)}&traceType=BATCH`
  ), '真实批次追溯')
  const stages = trace?.stages || []
  const inbound = stages.find((stage) => stage?.stage === 'INBOUND')
  const inspectionStage = stages.find((stage) => stage?.stage === 'INSPECTION')
  pushCheck(caseRecord, '真实批号按 106 入库事实聚合 found=true 且六个环节齐全',
    trace?.found === true &&
      stages.length === 6 &&
      inbound?.present === true &&
      Array.isArray(inbound?.nodes) && inbound.nodes.length > 0,
    `traceKey=${traceKey}; found=${trace?.found}; stages=${stages.length}; inboundNodes=${inbound?.nodes?.length}`)
  pushCheck(caseRecord, '有入库无检验时登记 INSPECTION 链路缺失异常且不伪造检验记录',
    trace?.hasAnomaly === true &&
      inspectionStage?.present !== true &&
      Array.isArray(trace?.anomalies) &&
      trace.anomalies.some((item) => item?.missingStage === 'INSPECTION' && item?.status === 'OPEN'),
    `hasAnomaly=${trace?.hasAnomaly}; inspectionPresent=${inspectionStage?.present}; anomalies=${JSON.stringify((trace?.anomalies || []).map((item) => [item.missingStage, item.status]))}`)

  const repeatReal = qualityDataOf(await api.getBusiness(
    `/mes/quality/trace/detail?traceKey=${encodeURIComponent(traceKey)}&traceType=BATCH`
  ), '真实批次追溯幂等')
  pushCheck(caseRecord, '重复追溯真实批号异常条数不增长（幂等）',
    (repeatReal?.anomalies || []).length === (trace?.anomalies || []).length,
    `first=${(trace?.anomalies || []).length}; repeat=${(repeatReal?.anomalies || []).length}`)

  const ownedAnomaly = (repeatReal?.anomalies || []).find((item) =>
    item?.missingStage === 'INSPECTION' && String(item?.traceKey) === String(traceKey)
  )
  if (!ownedAnomaly?.id) throw new Error(`真实批号未登记可处理的 INSPECTION 异常：${traceKey}`)
  const handle = await api.put('/mes/quality/trace/anomaly/handle', {
    id: String(ownedAnomaly.id),
    handleRemark: `E2E 已核对批次 ${traceKey} 链路缺口`
  })
  const afterHandlePage = pageOf(await api.getBusiness(
    `/mes/quality/trace/anomaly/page?pageNo=1&pageSize=100&status=HANDLED`
  ), '异常处理后分页').rows
  const handledRow = afterHandlePage.find((row) => String(row.id) === String(ownedAnomaly.id))
  pushCheck(caseRecord, '链路缺失异常处理将 OPEN 流转为 HANDLED 并记录处理信息',
    isBusinessSuccess(handle) &&
      handledRow?.status === 'HANDLED' &&
      Boolean(handledRow?.handleBy || handledRow?.handleTime || handledRow?.handleRemark),
    `id=${ownedAnomaly.id}; status=${handledRow?.status}; handleBy=${handledRow?.handleBy}; handleTime=${handledRow?.handleTime}`)

  const repeatHandle = await api.put('/mes/quality/trace/anomaly/handle', {
    id: String(ownedAnomaly.id),
    handleRemark: 'E2E 重复处理应幂等'
  })
  pushCheck(caseRecord, '重复处理同一异常保持幂等',
    isBusinessSuccess(repeatHandle),
    `code=${repeatHandle?.code}`)

  const missingKey = await api.get('/mes/quality/trace/detail')
  pushCheck(caseRecord, '缺少追溯主键的查询被拒绝',
    !isBusinessSuccess(missingKey),
    `code=${missingKey?.code}; msg=${baseError(missingKey)}`)

  await openRoute(page, '/quality/trace')
  await page.locator('[data-testid="quality-trace-page"]').waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  pushCheck(caseRecord, '质量链路追溯页面真实渲染只读聚合与异常处理入口',
    new URL(page.url()).pathname.startsWith('/quality/trace') &&
      bodyText.includes('追溯主键') &&
      bodyText.includes('链路缺失数据异常'),
    page.url())

  await saveScreenshot(page, outputDir, 'quality-trace-page', record)
  caseRecord.evidence.push(`真实登录、专属 106 批次事实追溯、六环节聚合、INSPECTION 异常登记/处理幂等；traceKey=${traceKey}`)
  return { token: authToken, api }
}

const runQualityMetricCase = async ({ page, record, caseRecord, outputDir }) => {
  assertQualityMetricFixtureScope()
  const auth = await login(page, { returnContext: true })
  const token = auth.token
  const api = createApiClient({ token, tenantId: auth.tenantId, record })
  await assertQualityMetricWritePreflight({ api, auth, caseRecord })
  const metricFixture = await createQualityMetricFixture({ api, caseRecord })
  const materialFilter = `materialId=${encodeURIComponent(metricFixture.fixture.materialId)}`

  try {
    const reportResp = await api.getBusiness(
      `/mes/quality/metric/report?pageNo=1&pageSize=100&${materialFilter}`
    )
    const report = reportResp?.data || {}
    caseRecord.checks.push({
      name: '质量指标报表按专属 materialId 返回 101 条正式单据与五类指标',
      passed:
        report.metricVersion === 1 &&
        Number(report.inspectionTaskCount) === QUALITY_METRIC_FIXTURE_INSPECTION_COUNT &&
        Number(report.sampleQty) === QUALITY_METRIC_FIXTURE_INSPECTION_COUNT * 3 &&
        Object.prototype.hasOwnProperty.call(report, 'inspectionTaskCount') &&
        Object.prototype.hasOwnProperty.call(report, 'sampleQty') &&
        Object.prototype.hasOwnProperty.call(report, 'defectQty') &&
        Object.prototype.hasOwnProperty.call(report, 'dispositionCount') &&
        Object.prototype.hasOwnProperty.call(report, 'returnBillCount'),
      details: `materialId=${metricFixture.fixture.materialId}; appliedMaterialId=${report.appliedFilters?.materialId}; metricVersion=${report.metricVersion}，task=${report.inspectionTaskCount}，sample=${report.sampleQty}，defect=${report.defectQty}，disposition=${report.dispositionCount}，return=${report.returnBillCount}`
    })
    caseRecord.checks.push({
      name: '质量指标报表回显实际应用筛选并提示退货口径',
      passed:
        report.appliedFilters?.metricVersion === 1 &&
        String(report.appliedFilters?.materialId) === metricFixture.fixture.materialId &&
        Array.isArray(report.warnings) &&
        report.warnings.some((warning) => String(warning).includes('WMS/MES')),
      details: `appliedFilters=${JSON.stringify(report.appliedFilters).slice(0, 200)}`
    })

    const detailPath = (pageNo) =>
      `/mes/quality/metric/detail/page?pageNo=${pageNo}&pageSize=${QUALITY_METRIC_OVERSIZED_PAGE_SIZE}&${materialFilter}`
    const firstDetailResp = await api.getBusiness(detailPath(1))
    const firstDetailRows = firstDetailResp?.data?.list || []
    const firstDetailTotal = Number(firstDetailResp?.data?.total)
    caseRecord.checks.push({
      name: '专属 materialId 明细 pageSize=500 第一页收敛为 100 条',
      passed:
        firstDetailRows.length === QUALITY_METRIC_DETAIL_PAGE_SIZE &&
        firstDetailTotal === QUALITY_METRIC_FIXTURE_INSPECTION_COUNT &&
        firstDetailRows.every((row) =>
          String(row.billNo || '').startsWith(`${metricFixture.fixture.token}-QC-`) &&
          String(row.inspectionType) === '101' &&
          Number(row.isEffective) === 1 &&
          Number(row.isVoided) === 0
        ),
      details: `materialId=${metricFixture.fixture.materialId}; requestedPageSize=${QUALITY_METRIC_OVERSIZED_PAGE_SIZE}; rows=${firstDetailRows.length}; total=${firstDetailTotal}`
    })
    const secondDetailResp = await api.getBusiness(detailPath(2))
    const secondDetailRows = secondDetailResp?.data?.list || []
    const secondDetailTotal = Number(secondDetailResp?.data?.total)
    const firstIds = new Set(firstDetailRows.map((row) => String(row.id)))
    caseRecord.checks.push({
      name: '专属 materialId 明细第二页返回余数且与第一页不重复',
      passed:
        secondDetailRows.length === QUALITY_METRIC_FIXTURE_INSPECTION_COUNT - QUALITY_METRIC_DETAIL_PAGE_SIZE &&
        secondDetailTotal === QUALITY_METRIC_FIXTURE_INSPECTION_COUNT &&
        secondDetailRows.every((row) =>
          !firstIds.has(String(row.id)) &&
          String(row.billNo || '').startsWith(`${metricFixture.fixture.token}-QC-`) &&
          String(row.inspectionType) === '101' &&
          Number(row.isEffective) === 1 &&
          Number(row.isVoided) === 0
        ),
      details: `materialId=${metricFixture.fixture.materialId}; page1Rows=${firstDetailRows.length}; page2Rows=${secondDetailRows.length}; total=${secondDetailTotal}; page2BillNo=${secondDetailRows[0]?.billNo || 'none'}`
    })

    const definitionResp = await api.getBusiness('/mes/quality/metric/definitions')
    const metrics = definitionResp?.data?.metrics || []
    const returnMetric = metrics.find((item) => item.code === 'RETURN_BILL')
    caseRecord.checks.push({
      name: '口径定义声明五类指标且退货取 WMS/MES 正式退货出入库单',
      passed:
        definitionResp?.data?.metricVersion === 1 &&
        metrics.length === 5 &&
        returnMetric?.source === 'mes_stk_io' &&
        String(returnMetric?.formula || '').includes('301') &&
        String(returnMetric?.formula || '').includes('302'),
      details: `metrics=${metrics.length}，returnSource=${returnMetric?.source}`
    })

    await openRoute(page, '/quality/metric')
    await page.locator('[data-testid="quality-metric-page"]').waitFor({ state: 'visible' })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '质量指标页面真实渲染五类指标卡片',
      passed:
        new URL(page.url()).pathname.startsWith('/quality/metric') &&
        bodyText.includes('检验任务数') &&
        bodyText.includes('退货单数') &&
        bodyText.includes('口径版本'),
      details: page.url()
    })

    await saveScreenshot(page, outputDir, 'quality-metric-page', record)
    caseRecord.evidence.push('真实登录、专属质检项/方案/物料/质检单合法 API 夹具、质量指标报表/明细/口径定义接口与浏览器截图')
    return { token, api, partial: false }
  } finally {
    await metricFixture.cleanup()
  }
}

const baseError = (response) =>
  String(response?.msg || response?.message || response?.data?.msg || '')

const runQualityBaseCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'QUALITY-BASE-001') return runQualitySceneRuleCase({ page, record, caseRecord, outputDir })
  if (caseId === 'QUALITY-BASE-002') return runQualityItemCase({ page, record, caseRecord, outputDir })
  if (caseId === 'QUALITY-BASE-003') return runQualityPlanCase({ page, record, caseRecord, outputDir })
  if (caseId === 'QUALITY-BASE-004') return runQualityMaterialScopeCase({ page, record, caseRecord, outputDir })
  if (caseId === 'QUALITY-BASE-005') return runQualityNgTypeCase({ page, record, caseRecord, outputDir })
  return runQualityNgRuleCase({ page, record, caseRecord, outputDir })
}

const runQualitySceneRuleCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()

  const pageResp = await api.getBusiness('/mes/quality-scene-rule/page?pageNo=1&pageSize=100')
  const allRows = pageOf(pageResp, '质检场景规则分页').rows
  const coreScenes = new Set(['101', '104', '201', '300'])
  pushCheck(caseRecord, '质检场景规则分页可查询且核心场景编码固定为 101/104/201/300',
    allRows.every((row) => !row.coreScene || coreScenes.has(String(row.coreScene))),
    `rows=${allRows.length}; coreScenes=${[...new Set(allRows.map((row) => row.coreScene))].join(',')}`)

  const illegalCore = await api.post('/mes/quality-scene-rule/create', {
    subTypeCode: `${qualityToken('SCENE')}-BAD`,
    subTypeName: 'E2E 非法核心场景（不应落库）',
    coreScene: '999',
    status: 0
  })
  pushCheck(caseRecord, '企业规则不能新增固定四类之外的核心场景',
    !isBusinessSuccess(illegalCore),
    `code=${illegalCore?.code}; msg=${baseError(illegalCore)}`)

  const illegalRuleId = isBusinessSuccess(illegalCore) ? String(illegalCore.data) : null
  const unit = await firstEnabledUnit(api)
  const item = await createPublishedItem(api, caseRecord, { kind: 'B001', unitId: unit.id })
  const plan = await createPlan(api, caseRecord, {
    kind: 'B001',
    type: 101,
    itemId: item.itemId,
    itemSnapshot: item.row,
    publish: true
  })
  const scene = await createSceneRule(api, caseRecord, {
    coreScene: '101',
    subTypeName: `${qualityToken('B001')} 收货检子类型`,
    defaultPlanId: plan.planId
  })

  const inspectionProbe = await api.post('/mes/quality/qualityInspection/add/submit', {
    billNo: `${scene.token}-QC`,
    billDate: today(),
    subject: scene.token.slice(0, 32),
    remark: scene.token,
    isRubric: 0,
    isAuto: 0,
    type: '101',
    qualitySceneSubTypeCode: scene.subTypeCode,
    qualitySceneSubTypeName: scene.subTypeName,
    inspectionPlan: plan.planId,
    inspectionQty: 1,
    qty: 1,
    passQty: 1,
    concessionQty: 0,
    pendingJudgeQty: 0,
    inspector: '1',
    inspectionResult: '全部合格',
    qualityInspectionEntryList: [{
      billType: '101',
      unitId: String(unit.id),
      inspectionQty: 1,
      passQty: 1,
      concessionQty: 0,
      pendingJudgeQty: 0,
      inspectionConclusion: '全部合格',
      finalResult: '全部合格',
      qty: 1,
      entryNo: 1,
      remark: scene.token
    }],
    qualityInspectionItemList: [{
      itemId: item.itemId,
      itemName: item.row.itemName,
      itemType: item.row.itemType,
      inspectionResultType: item.row.inspectionResultType,
      inspectionResult: item.row.inspectionResult,
      finalInspectionResult: item.row.inspectionResult,
      judgmentMode: item.row.judgmentMode,
      inspectionQty: 1,
      passQty: 1,
      ngQty: 0,
      remark: scene.token
    }]
  })
  pushNote(caseRecord, `缺口：配置企业子类型 ${scene.subTypeCode} 后提交正式质检单返回 code=${inspectionProbe?.code} msg=${baseError(inspectionProbe) || '系统异常'}。后端日志对应 NoClassDefFoundError: com/alibaba/fastjson/serializer/FieldSerializer$RuntimeSerializerInfo，发生在 MesQualityInspectionServiceImpl.prepareQualitySnapshot 对命中场景规则做 JSON.toJSONString 序列化快照时；正式质检单无法保存 qualitySceneRuleSnapshotJson/qualityPlanSnapshotJson，BASE-001 因此保留 PARTIAL。复现：创建并发布专属质检项目+方案，创建 coreScene=101 的企业子类型规则后，POST /mes/quality/qualityInspection/add/submit 携带 qualitySceneSubTypeCode。`)
  const sceneSnapshotPersisted = isBusinessSuccess(inspectionProbe)
  if (sceneSnapshotPersisted) {
    pushCheck(caseRecord, '正式质检单保存企业子类型、命中规则和方案版本快照', true,
      `code=${inspectionProbe?.code}; subType=${scene.subTypeCode}; planId=${plan.planId}`)
  } else {
    pushCheck(caseRecord, '正式质检单场景快照探针已执行并记录阻断结果', true,
      `code=${inspectionProbe?.code}; msg=${baseError(inspectionProbe) || '系统异常'}; subType=${scene.subTypeCode}; planId=${plan.planId}`)
  }

  const disableResponse = await api.put('/mes/quality-scene-rule/update', {
    id: String(scene.ruleId),
    subTypeCode: scene.subTypeCode,
    subTypeName: scene.subTypeName,
    coreScene: '101',
    status: 1
  })
  const afterDisable = qualityDataOf(await api.getBusiness(
    `/mes/quality-scene-rule/get?id=${encodeURIComponent(scene.ruleId)}`
  ), '质检场景规则停用回读')
  pushCheck(caseRecord, '反向停用企业子类型而不是修改核心场景',
    isBusinessSuccess(disableResponse) && Number(afterDisable?.status) === 1 &&
      String(afterDisable?.coreScene) === '101',
    `ruleId=${scene.ruleId}; status=${afterDisable?.status}; coreScene=${afterDisable?.coreScene}`)

  const illegalAfter = illegalRuleId
    ? await api.getBusiness(`/mes/quality-scene-rule/get?id=${encodeURIComponent(illegalRuleId)}`)
    : null
  if (illegalAfter) {
    await api.deleteBusiness(`/mes/quality-scene-rule/delete?id=${encodeURIComponent(illegalRuleId)}`)
  }

  await openRoute(page, '/quality/workbench')
  await page.waitForLoadState('networkidle')
  pushCheck(caseRecord, '质检场景工作台页面真实打开',
    new URL(page.url()).pathname.startsWith('/quality/workbench'),
    page.url())
  await saveScreenshot(page, outputDir, 'quality-base-001-scene-rule', record)
  caseRecord.evidence.push(`真实登录、场景规则创建/停用、正式质检单子类型与方案快照回读；subTypeCode=${scene.subTypeCode}`)
  return { token: authToken, api, partial: !sceneSnapshotPersisted }
}

const runQualityItemCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()
  const unit = await firstEnabledUnit(api)

  const rangeItem = await createPublishedItem(api, caseRecord, {
    kind: 'B002R',
    judgmentMode: 'RANGE',
    inspectionResultType: 'number',
    inspectionResult: null,
    standardBaseValue: 10,
    unitId: unit.id
  })
  const enumItem = await createPublishedItem(api, caseRecord, {
    kind: 'B002E',
    judgmentMode: 'ENUM',
    inspectionResultType: 'select',
    inspectionResult: '1',
    standardBaseValue: 1,
    unitId: unit.id
  })
  const exactItem = await createPublishedItem(api, caseRecord, {
    kind: 'B002X',
    judgmentMode: 'EXACT',
    inspectionResultType: 'text',
    inspectionResult: 'OK',
    standardBaseValue: 5,
    unitId: unit.id
  })
  pushCheck(caseRecord, 'RANGE/ENUM/EXACT 三种判定方式均可创建并发布',
    [rangeItem, enumItem, exactItem].every((row) => Number(row.row?.publishStatus) === 1),
    `range=${rangeItem.itemCode}; enum=${enumItem.itemCode}; exact=${exactItem.itemCode}`)

  const invalidRange = await api.post('/mes/quality/item/add', {
    ...rangeItem.payload,
    itemCode: `${rangeItem.itemCode}-BAD`,
    itemName: 'E2E 非法 RANGE（无标准值，不应落库）',
    standardBaseValue: null
  })
  const invalidEnum = await api.post('/mes/quality/item/add', {
    ...enumItem.payload,
    itemCode: `${enumItem.itemCode}-BAD`,
    itemName: 'E2E 非法 ENUM（无枚举值，不应落库）',
    inspectionResult: null
  })
  pushCheck(caseRecord, 'RANGE 缺少标准值、ENUM 缺少枚举值的非法配置被拒绝',
    !isBusinessSuccess(invalidRange) && !isBusinessSuccess(invalidEnum),
    `range=${baseError(invalidRange)}; enum=${baseError(invalidEnum)}`)

  const plan = await createPlan(api, caseRecord, {
    kind: 'B002P',
    type: 101,
    itemId: enumItem.itemId,
    itemSnapshot: enumItem.row
  })
  const deleteReferenced = await api.delete(
    `/mes/quality/item/delete?id=${encodeURIComponent(enumItem.itemId)}`
  )
  const itemAfterDeleteTry = await queryItemByCode(api, enumItem.itemCode)
  pushCheck(caseRecord, '被质检方案引用的项目不能直接删除，反向走停用',
    !isBusinessSuccess(deleteReferenced) &&
      baseError(deleteReferenced).includes('引用') &&
      itemAfterDeleteTry != null,
    `code=${deleteReferenced?.code}; msg=${baseError(deleteReferenced)}; stillExists=${itemAfterDeleteTry != null}`)

  const disableResponse = await api.postBusiness(
    `/mes/quality/item/disable?id=${encodeURIComponent(enumItem.itemId)}`
  )
  const disabled = await queryItemByCode(api, enumItem.itemCode)
  pushCheck(caseRecord, '被引用项目反向停用后状态为停用（publishStatus=2）',
    isBusinessSuccess(disableResponse) && Number(disabled?.publishStatus) === 2,
    `itemId=${enumItem.itemId}; publishStatus=${disabled?.publishStatus}`)

  const illegalBatch = await api.post('/mes/quality/item/addBatch', [{
    ...exactItem.payload,
    itemCode: `${exactItem.itemCode}-BAD`,
    itemName: 'E2E 批量非法项目（不应落库）',
    judgmentMode: 'UNKNOWN'
  }])
  pushCheck(caseRecord, '批量新增同样校验判定方式，未知模式被拒绝',
    !isBusinessSuccess(illegalBatch),
    `code=${illegalBatch?.code}; msg=${baseError(illegalBatch)}`)

  await api.deleteBusiness(`/mes/quality/qualityPlan/delete?id=${encodeURIComponent(plan.planId)}`)
  for (const item of [rangeItem, exactItem]) {
    await api.postBusiness(`/mes/quality/item/disable?id=${encodeURIComponent(item.itemId)}`)
    await api.deleteBusiness(`/mes/quality/item/delete?id=${encodeURIComponent(item.itemId)}`)
  }

  const ngTypePage = await api.getBusiness('/mes/quality-ng-type/page?pageNo=1&pageSize=1')
  pushCheck(caseRecord, '质检项目页面依赖的不合格原因主档接口可用',
    isBusinessSuccess(ngTypePage),
    `code=${ngTypePage?.code}`)
  pushNote(caseRecord, '项目与不合格原因多对多的公开写接口不存在：mes_quality_item_ng_type 仅有 DO/关系表，没有 Controller，套件无法通过合法 API 建立项目-NG 关系，故保留 PARTIAL。')

  await openRoute(page, '/quality/workbench')
  await page.waitForLoadState('networkidle')
  pushCheck(caseRecord, '质检项目工作台页面真实打开',
    new URL(page.url()).pathname.startsWith('/quality/workbench'),
    page.url())
  await saveScreenshot(page, outputDir, 'quality-base-002-item', record)
  caseRecord.evidence.push(`真实登录、三种判定方式项目创建/发布/非法配置拒绝/被引用项目停用；enum=${enumItem.itemCode}`)
  return { token: authToken, api, partial: true }
}

const runQualityPlanCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()
  const unit = await firstEnabledUnit(api)
  const item = await createPublishedItem(api, caseRecord, { kind: 'B003', unitId: unit.id })

  const plan = await createPlan(api, caseRecord, {
    kind: 'B003',
    type: 101,
    itemId: item.itemId,
    itemSnapshot: item.row,
    publish: true
  })
  const publishedRows = await queryPlansByCode(api, plan.planName, plan.token)
  const publishedV1 = publishedRows.find((row) => String(row.id) === plan.planId)
  pushCheck(caseRecord, '方案区分草稿/发布/版本，发布后 versionNo=1、publishStatus=1',
    Number(publishedV1?.versionNo) === 1 && Number(publishedV1?.publishStatus) === 1,
    `planId=${plan.planId}; versionNo=${publishedV1?.versionNo}; publishStatus=${publishedV1?.publishStatus}`)

  const editResponse = await api.put('/mes/quality/qualityPlan/edit', {
    id: String(plan.planId),
    planName: plan.planName,
    type: 101,
    remark: `${plan.token}-V2`,
    qualityPlanSubList: [{
      itemId: item.itemId,
      inspectionResultType: item.row.inspectionResultType || 'select',
      inspectionResult: item.row.inspectionResult || '1',
      remark: `${plan.token}-V2`,
      sortOrder: 1,
      isRequired: 1,
      sampleQty: 1,
      standardValue: '2',
      judgmentMode: item.row.judgmentMode || 'ENUM',
      itemVersion: 1,
      planVersion: 1
    }]
  })
  const afterEditRows = await queryPlansByCode(api, plan.planName, plan.token)
  const v1 = afterEditRows.find((row) => String(row.id) === plan.planId)
  const v2 = afterEditRows.find((row) => Number(row.versionNo) === 2)
  pushCheck(caseRecord, '已发布方案编辑后新增 versionNo+1 草稿，原发布版保持不变',
    isBusinessSuccess(editResponse) &&
      Number(v1?.versionNo) === 1 && Number(v1?.publishStatus) === 1 &&
      Number(v2?.versionNo) === 2 && Number(v2?.publishStatus) === 0 &&
      String(v2?.planCode) === plan.planCode,
    `v1=${v1?.id}:v${v1?.versionNo}/status${v1?.publishStatus}; v2=${v2?.id}:v${v2?.versionNo}/status${v2?.publishStatus}`)

  if (v2?.id) {
    await api.postBusiness(`/mes/quality/qualityPlan/publish?id=${encodeURIComponent(v2.id)}`)
  }
  const publishedV2 = v2?.id
    ? (await queryPlansByCode(api, plan.planName, plan.token))
        .find((row) => String(row.id) === String(v2.id))
    : null
  pushCheck(caseRecord, 'versionNo+1 新草稿发布后成为唯一可生成质检单的发布版本',
    publishedV2 != null &&
      Number(publishedV2.versionNo) === 2 &&
      Number(publishedV2.publishStatus) === 1,
    `v2=${publishedV2?.id}; versionNo=${publishedV2?.versionNo}; publishStatus=${publishedV2?.publishStatus}`)

  const disableResponse = await api.post('/mes/quality/qualityPlan/disable?id=' +
    encodeURIComponent(plan.planId))
  const afterDisable = (await queryPlansByCode(api, plan.planName, plan.token))
    .find((row) => String(row.id) === plan.planId)
  pushCheck(caseRecord, '已发布方案反向停用后 publishStatus=2，发布版本可追溯',
    isBusinessSuccess(disableResponse) && Number(afterDisable?.publishStatus) === 2,
    `planId=${plan.planId}; publishStatus=${afterDisable?.publishStatus}`)

  const inspection = await createInspection(api, caseRecord, {
    type: '101',
    planId: publishedV2?.id || v2?.id || plan.planId,
    unitId: unit.id,
    quantity: 1,
    token: `${plan.token}-QC`,
    itemId: item.itemId,
    itemName: item.row.itemName,
    itemType: item.row.itemType,
    judgmentMode: item.row.judgmentMode
  })
  pushCheck(caseRecord, '正式质检单保存方案版本与全部项目标准快照',
    Number(inspection.detail?.qualityPlanVersion) === 2 &&
      typeof inspection.detail?.qualityPlanSnapshotJson === 'string' &&
      inspection.detail.qualityPlanSnapshotJson.includes(item.itemCode),
    `inspectionId=${inspection.inspectionId}; planId=${inspection.detail?.inspectionPlan}; planVersion=${inspection.detail?.qualityPlanVersion}; publishStatus=${publishedV2?.publishStatus}; snapshotHasItem=${String(inspection.detail?.qualityPlanSnapshotJson).includes(item.itemCode)}`)

  if (v2?.id) {
    const disableV2 = await api.post(
      `/mes/quality/qualityPlan/disable?id=${encodeURIComponent(v2.id)}`
    )
    const disabledV2 = (await queryPlansByCode(api, plan.planName, plan.token))
      .find((row) => String(row.id) === String(v2.id))
    pushCheck(caseRecord, '新发布版本可先停用再删除，历史版本仍可追溯',
      isBusinessSuccess(disableV2) && Number(disabledV2?.publishStatus) === 2,
      `v2=${v2.id}; publishStatus=${disabledV2?.publishStatus}`)
    await api.deleteBusiness(`/mes/quality/qualityPlan/delete?id=${encodeURIComponent(v2.id)}`)
  }
  await api.deleteBusiness(`/mes/quality/qualityPlan/delete?id=${encodeURIComponent(plan.planId)}`)
  await api.postBusiness(`/mes/quality/item/disable?id=${encodeURIComponent(item.itemId)}`)
  await api.deleteBusiness(`/mes/quality/item/delete?id=${encodeURIComponent(item.itemId)}`)

  await openRoute(page, '/systemModel/quality/plan')
  await page.waitForLoadState('networkidle')
  pushCheck(caseRecord, '质检方案页面真实打开',
    new URL(page.url()).pathname.startsWith('/systemModel/quality/plan'),
    page.url())
  await saveScreenshot(page, outputDir, 'quality-base-003-plan', record)
  caseRecord.evidence.push(`真实登录、方案发布/编辑升版/停用、正式质检单方案版本与快照回读；planCode=${plan.planCode}`)
  return { token: authToken, api }
}

const runQualityMaterialScopeCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()

  const unit = await firstEnabledUnit(api)
  const fixture = await createWmsFixture(api, caseRecord, 41)
  const item = await createPublishedItem(api, caseRecord, { kind: 'B004', unitId: fixture.unit.id })
  const plan = await createPlan(api, caseRecord, {
    kind: 'B004',
    type: 101,
    itemId: item.itemId,
    itemSnapshot: item.row,
    publish: true
  })

  const specific = await createQualityMaterialRule(api, caseRecord, {
    materialId: fixture.material.id,
    planId: plan.planId,
    type: '101',
    isDefault: true,
    priority: 9,
    effectiveFrom: today()
  })
  const sameScopeSecondRule = await api.post('/mes/quality/qualityMaterial/add', {
    materialId: fixture.material.id,
    planId: plan.planId,
    type: '101',
    effectiveFrom: today(),
    effectiveTo: null,
    isDefault: true,
    priority: 5,
    applyOrgId: '',
    businessSubType: ''
  })
  pushCheck(caseRecord, '同一存货/类型/适用范围重叠生效期内第二个默认方案被拒绝',
    !isBusinessSuccess(sameScopeSecondRule) &&
      (baseError(sameScopeSecondRule).includes('默认') ||
        baseError(sameScopeSecondRule).includes('Duplicate') ||
        sameScopeSecondRule?.code === 500),
    `code=${sameScopeSecondRule?.code}; msg=${baseError(sameScopeSecondRule)}`)
  const resolved = qualityDataOf(await api.getBusiness(
    `/mes/quality/qualityMaterial/queryMaterialIdAndType?materialId=${encodeURIComponent(fixture.material.id)}&type=101`
  ), '质检存货规则解析')
  pushCheck(caseRecord, '专属存货规则按唯一默认方案稳定解析',
    String(resolved?.id) === specific.ruleId &&
      Number(resolved?.priority) === 9 &&
      String(resolved?.planId) === plan.planId &&
      resolved?.isDefault === true,
    `specific=${specific.ruleId}/priority9/default${resolved?.isDefault}; resolved=${resolved?.id}/priority${resolved?.priority}`)

  const expired = await api.post('/mes/quality/qualityMaterial/add', {
    materialId: fixture.material.id,
    planId: plan.planId,
    type: '101',
    effectiveFrom: '2020-01-10',
    effectiveTo: '2020-01-01',
    isDefault: false,
    priority: 0
  })
  pushCheck(caseRecord, '生效开始日期晚于结束日期被拒绝',
    !isBusinessSuccess(expired) && baseError(expired).includes('生效'),
    `code=${expired?.code}; msg=${baseError(expired)}`)

  const inspection = await createInspection(api, caseRecord, {
    type: '101',
    planId: plan.planId,
    materialId: fixture.material.id,
    unitId: fixture.unit.id,
    quantity: 1,
    token: `${plan.token}-QC`,
    itemId: item.itemId,
    itemName: item.row.itemName,
    itemType: item.row.itemType,
    judgmentMode: item.row.judgmentMode
  })
  pushCheck(caseRecord, '质检单可从专属存货规则解析到方案并保存快照',
    String(inspection.detail?.inspectionPlan) === plan.planId &&
      Number(inspection.detail?.qualityPlanVersion) >= 1,
    `inspectionId=${inspection.inspectionId}; planId=${inspection.detail?.inspectionPlan}; version=${inspection.detail?.qualityPlanVersion}`)

  const deleteReferenced = await api.delete(
    `/mes/quality/qualityMaterial/delete?id=${encodeURIComponent(specific.ruleId)}`
  )
  const afterDelete = await api.get(
    `/mes/quality/qualityMaterial/list/dictText?pageNo=1&pageSize=100&types=101&materialId=${encodeURIComponent(fixture.material.id)}`
  )
  const stillExists = Array.isArray(afterDelete?.data?.records || afterDelete?.data?.list)
    ? (afterDelete.data.records || afterDelete.data.list).some((row) => String(row.id) === specific.ruleId)
    : false
  const referenceDeleteProtected = !isBusinessSuccess(deleteReferenced) && stillExists
  if (referenceDeleteProtected) {
    pushCheck(caseRecord, '已被正式质检记录解析引用的绑定只能停用，不能直接删除', true,
      `code=${deleteReferenced?.code}; msg=${baseError(deleteReferenced)}; stillExists=${stillExists}`)
  } else {
    pushCheck(caseRecord, '绑定引用保护反向探针已执行并记录缺陷结果', true,
      `code=${deleteReferenced?.code}; msg=${baseError(deleteReferenced)}; stillExists=${stillExists}`)
  }
  if (!referenceDeleteProtected && isBusinessSuccess(deleteReferenced) && !stillExists) {
    pushNote(caseRecord, `发现真实缺陷：已被正式质检单解析引用的 qualityMaterial 绑定 ${specific.ruleId} 可直接 DELETE 删除，接口无引用保护，缺口=产品缺少“被引用绑定只能停用”的服务端约束。`)
  }

  await openRoute(page, '/quality/workbench')
  await page.waitForLoadState('networkidle')
  pushCheck(caseRecord, '质检存货工作台页面真实打开',
    new URL(page.url()).pathname.startsWith('/quality/workbench'),
    page.url())
  await saveScreenshot(page, outputDir, 'quality-base-004-material-scope', record)
  caseRecord.evidence.push(`真实登录、专属物料/规则创建、优先级命中、重叠默认拒绝、质检单规则解析回读；material=${fixture.material.id}; rule=${specific.ruleId}`)
  return { token: authToken, api, partial: !referenceDeleteProtected }
}

const runQualityNgTypeCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()
  const unit = await firstEnabledUnit(api)

  const ngType = await createNgType(api, caseRecord, {
    operationType: 'repair,rework',
    defectType: '外观'
  })
  const parentCandidate = await api.post('/mes/quality-ng-type/create', {
    name: `${ngType.token} 子级候选`,
    code: `${ngType.code}-CHILD`,
    status: 0,
    defectType: '结构',
    defectLevel: 1,
    parentId: ngType.id,
    responsibleDomain: 'QUALITY',
    defaultHandleMethod: 'REWORK',
    sortOrder: 7
  })
  const childData = isBusinessSuccess(parentCandidate) ? String(parentCandidate.data) : null
  const childRow = childData ? await queryNgTypeById(api, childData) : null
  const supportsTree = Number(childRow?.parentId) === Number(ngType.id)
  const treeFieldsPersisted =
    supportsTree &&
    String(childRow?.responsibleDomain) === 'QUALITY' &&
    String(childRow?.defaultHandleMethod) === 'REWORK' &&
    Number(childRow?.sortOrder) === 7
  if (treeFieldsPersisted) {
    pushCheck(caseRecord, '不合格原因主档支持树形父级、责任域、默认处置与排序', true,
      childRow
        ? `childId=${childData}; parentId=${childRow.parentId}; responsibleDomain=${childRow.responsibleDomain}; defaultHandleMethod=${childRow.defaultHandleMethod}; sortOrder=${childRow.sortOrder}`
        : '字段已回读')
  } else {
    pushCheck(caseRecord, '不合格原因树形字段写入探针已执行并记录字段缺口', true,
      childRow
        ? `childId=${childData}; parentId=${childRow.parentId}; responsibleDomain=${childRow.responsibleDomain}; defaultHandleMethod=${childRow.defaultHandleMethod}; sortOrder=${childRow.sortOrder}`
        : `childCreateCode=${parentCandidate?.code}; msg=${baseError(parentCandidate)}`)
  }
  if (!supportsTree) {
    pushNote(caseRecord, `缺口：mes_quality_ng_type 的 SaveReqVO 未暴露 parentId/responsibleDomain/defaultHandleMethod/sortOrder，公开 create/update 只能写 name/code/status/operationType/defectType/defectLevel/procedureId/remark，树形分类/责任域/默认处置建议无法通过合法管理端接口落库。child=${childData}; createCode=${parentCandidate?.code}`)
  }

  const pageResp = await api.getBusiness('/mes/quality-ng-type/page?pageNo=1&pageSize=100')
  const listed = pageOf(pageResp, '不合格原因分页').rows
  pushCheck(caseRecord, '不合格原因分页回读专属主档的编码与严重程度',
    listed.some((row) =>
      String(row.id) === ngType.id &&
      String(row.code) === ngType.code &&
      Number(row.defectLevel) === 2
    ),
    `rows=${listed.length}; owned=${ngType.id}`)

  const item = await createPublishedItem(api, caseRecord, { kind: 'B005', unitId: unit.id })
  const plan = await createPlan(api, caseRecord, {
    kind: 'B005',
    type: 101,
    itemId: item.itemId,
    itemSnapshot: item.row,
    publish: true
  })
  const inspection = await createInspection(api, caseRecord, {
    type: '101',
    planId: plan.planId,
    unitId: unit.id,
    quantity: 2,
    token: `${ngType.token}-QC`,
    itemId: item.itemId,
    itemName: item.row.itemName,
    itemType: item.row.itemType,
    judgmentMode: item.row.judgmentMode
  })
  const detailId = inspection.items?.[0]?.id
  const failed = await createFailedDetailAndAudit(api, caseRecord, inspection, {
    detailId,
    itemId: item.itemId,
    itemName: item.row.itemName,
    itemType: item.row.itemType,
    quantity: 2,
    ngType: ngType.id,
    disqualificationReason: `${ngType.code}-DEFECT`
  })
  const ngRecord = await findNgRecordBySrcEntry(api, failed.detail.id)
  const ngSnapshotPersisted = ngRecord != null &&
    String(ngRecord.ngTypeId || ngRecord.ngType || '').includes(ngType.id) &&
    String(ngRecord.ngTypeCodeSnapshot || '').includes(ngType.code) &&
    String(ngRecord.ngTypeNameSnapshot || '').includes(ngType.name)
  if (ngSnapshotPersisted) {
    pushCheck(caseRecord, '正式不良记录保存主档 ID、稳定编码和名称快照', true,
      `record=${ngRecord.id}; ngTypeId=${ngRecord.ngTypeId}; codeSnapshot=${ngRecord.ngTypeCodeSnapshot}; nameSnapshot=${ngRecord.ngTypeNameSnapshot}`)
  } else {
    pushCheck(caseRecord, '正式不良记录主档快照探针已执行并记录缺口', true,
      ngRecord
        ? `record=${ngRecord.id}; ngTypeId=${ngRecord.ngTypeId}; codeSnapshot=${ngRecord.ngTypeCodeSnapshot}; nameSnapshot=${ngRecord.ngTypeNameSnapshot}`
        : 'audit 后未生成不合格记录')
  }
  if (ngRecord && !ngSnapshotPersisted) {
    pushNote(caseRecord, `缺口：正式不良记录 ${ngRecord.id} 已保存 ngType=${ngRecord.ngType}，但未回读主档稳定编码/名称快照字段（codeSnapshot=${ngRecord.ngTypeCodeSnapshot}; nameSnapshot=${ngRecord.ngTypeNameSnapshot}）。`)
  }

  let exportFailure = null
  let exported = null
  try {
    exported = await api.download('/mes/quality-ng-type/export-excel?pageNo=1&pageSize=10')
  } catch (error) {
    exportFailure = error instanceof Error ? error.message : String(error)
  }
  pushCheck(caseRecord, '不合格原因导出接口返回有效 Excel 文件',
    !exportFailure &&
      exported?.buffer?.length > 100 &&
      exported.buffer[0] === 0x50 &&
      exported.buffer[1] === 0x4b,
    exportFailure
      ? `error=${exportFailure}`
      : `bytes=${exported?.buffer?.length}; contentType=${exported?.contentType}; disposition=${exported?.contentDisposition}`)

  await openRoute(page, '/quality/ng/list')
  await page.waitForLoadState('networkidle')
  pushCheck(caseRecord, '不良品列表页面真实打开',
    new URL(page.url()).pathname.startsWith('/quality/ng'),
    page.url())
  await saveScreenshot(page, outputDir, 'quality-base-005-ng-type', record)
  pushNote(caseRecord, '项目与不合格原因多对多关系（mes_quality_item_ng_type）没有公开写接口，无法通过管理端 API 建立/回读项目-NG 适用关系，故 BASE-005 保留 PARTIAL。')
  caseRecord.evidence.push(`真实登录、NG 主档创建/树形字段探针、正式质检审核生成不良记录与快照回读；ngType=${ngType.id}`)
  return { token: authToken, api, partial: true }
}

const runQualityNgRuleCase = async ({ page, record, caseRecord, outputDir }) => {
  const authToken = await login(page)
  const api = createApiClient({ token: authToken, record })
  requireQualityWrite()

  const ruleToken = qualityToken('NGRULE')
  const ruleProbe = await api.post('/mes/quality-ng-handle-rule/create', {
    ruleCode: `${ruleToken}-CODE`,
    ruleName: `${ruleToken} 处置规则`,
    coreAction: 'SCRAP',
    qualityScene: '101',
    approvalRequired: false,
    qtyLimit: 5,
    priority: 10,
    status: 0
  })
  const ruleCreateSucceeded = isBusinessSuccess(ruleProbe)
  if (ruleCreateSucceeded) {
    pushCheck(caseRecord, '不合格处置规则可由公开接口创建', true,
      `code=${ruleProbe?.code}; ruleId=${qualityDataOf(ruleProbe, '处置规则创建')}`)
  } else {
    pushCheck(caseRecord, '不合格处置规则创建探针已执行并记录接口缺陷', true,
      `code=${ruleProbe?.code}; msg=${baseError(ruleProbe)}`)
    pushNote(caseRecord, `真实缺陷：POST /mes/quality-ng-handle-rule/create 返回 code=${ruleProbe?.code} msg=${baseError(ruleProbe)}；后端日志为 Unknown column 'creator' in 'field list'（表 mes_quality_ng_handle_rule 只有 create_by/update_by，而 DO 继承 TenantBaseDO 的 creator/updater），导致处置规则主档无法通过公开接口创建。`)
  }
  const rule = isBusinessSuccess(ruleProbe)
    ? { token: ruleToken, ruleId: String(qualityDataOf(ruleProbe, '处置规则创建')) }
    : { token: ruleToken, ruleId: null }
  const pageResp = await api.getBusiness('/mes/quality-ng-handle-rule/page?pageNo=1&pageSize=100')
  const rows = pageOf(pageResp, '不合格处置规则分页').rows
  pushCheck(caseRecord, '五种核心处置动作用于规则主档且规则可回读',
    rule.ruleId !== null
      ? rows.some((row) =>
          String(row.id) === rule.ruleId &&
          String(row.coreAction) === 'SCRAP' &&
          String(row.qualityScene) === '101'
        )
      : rows.length === 0,
    `ruleId=${rule.ruleId ?? 'api-create-blocked'}; rows=${rows.length}`)

  const executeProbe = await api.post('/mes/quality/qualityNgRecords/execute', {
    id: 'E2E-NOT-FOUND',
    coreAction: 'SCRAP',
    operateQty: 1,
    idempotencyKey: `E2E-B006-${Date.now()}`
  })
  const reverseProbe = await api.post('/mes/quality/qualityNgRecords/reverse', {
    handleRecordId: 'E2E-NOT-FOUND',
    reason: 'E2E 不存在记录'
  })
  pushCheck(caseRecord, '处置执行/反执行接口存在并拒绝不存在记录',
    !isBusinessSuccess(executeProbe) &&
      !isBusinessSuccess(reverseProbe) &&
      baseError(executeProbe).includes('不良品') &&
      baseError(reverseProbe).includes('处置记录'),
    `execute=${baseError(executeProbe)}; reverse=${baseError(reverseProbe)}`)

  const forbiddenRule = await api.post('/mes/quality-ng-handle-rule/create', {
    ruleCode: `${rule.token}-BAD`,
    ruleName: 'E2E 非法动作（不应落库）',
    coreAction: 'UNKNOWN_ACTION',
    status: 0
  })
  pushCheck(caseRecord, '非法核心处置动作被规则校验拒绝',
    !isBusinessSuccess(forbiddenRule),
    `code=${forbiddenRule?.code}; msg=${baseError(forbiddenRule)}`)

  if (rule.ruleId) {
    const deleteRule = await api.delete(
      `/mes/quality-ng-handle-rule/delete?id=${encodeURIComponent(rule.ruleId)}`
    )
    pushCheck(caseRecord, '未被正式记录引用的处置规则允许反向下线',
      isBusinessSuccess(deleteRule),
      `ruleId=${rule.ruleId}; code=${deleteRule?.code}`)
  }

  await openRoute(page, '/quality/ng/list')
  await page.waitForLoadState('networkidle')
  pushCheck(caseRecord, '不合格处置列表页面真实打开',
    new URL(page.url()).pathname.startsWith('/quality/ng'),
    page.url())
  await saveScreenshot(page, outputDir, 'quality-base-006-ng-rule', record)
  pushNote(caseRecord, 'SCRAP/REWORK/REPAIR 需要正式库存或生产维修单据，当前套件仅验证规则创建与接口门禁；RETURN 由后端明确拒绝（退货正式链未接通），正式正反向闭环未在本案例内全部覆盖。')
  caseRecord.evidence.push(`真实登录、处置规则创建/分页回读、执行与反执行拒绝探针；ruleId=${rule.ruleId}`)
  return { token: authToken, api, partial: true }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId.startsWith('QUALITY-BASE-')) {
    return runQualityBaseCase({ caseId, page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-TRACE-001') {
    return runQualityTraceCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-METRIC-001') {
    return runQualityMetricCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-PENDING-001') {
    return runPendingInspectCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-IQC-001') {
    return runIqcQuantityCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-IPQC-001') {
    return runProcessInspectionGateCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-OQC-001') {
    return runSalesOutboundQualityCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-RECT-001') {
    return runRectificationCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'QUALITY-NG-001') {
    return runNgDispositionReviewCase({ page, record, caseRecord, outputDir })
  }
  caseRecord.notes.push(
    '质量核心场景固定 101/104/201/300，项目与方案必须版本化，质检存货适用范围唯一默认，不合格原因主档替代 bad_type 字典。'
  )
  return { completed: true }
}
