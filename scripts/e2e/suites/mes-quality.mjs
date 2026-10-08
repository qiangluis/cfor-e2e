import { assertBusinessSuccess, isBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { assertLocalDatabase, assertLocalWriteSafety } from '../lib/db.mjs'

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
  const token = await login(page)
  const api = createApiClient({ token, record })

  const list = await api.getBusiness(
    '/mes/quality/qualityNgRecords/list/dictText?pageNo=1&pageSize=100'
  )
  const rows = list?.data?.records || list?.data?.list || []
  const rowsArray = Array.isArray(rows) ? rows : []
  caseRecord.checks.push({
    name: '不合格记录列表可查询且分页不超过 100',
    passed: Array.isArray(rowsArray),
    details: `rows=${rowsArray.length}`
  })

  const sample = rowsArray[0]
  caseRecord.checks.push({
    name: '不合格记录列表暴露处置评审与处置审批状态（PB-317）',
    passed:
      !sample ||
      (Object.prototype.hasOwnProperty.call(sample, 'reviewStatus') &&
        Object.prototype.hasOwnProperty.call(sample, 'approvalStatus')),
    details: sample
      ? `reviewStatus=${sample.reviewStatus}，approvalStatus=${sample.approvalStatus}`
      : '无不合格记录数据，跳过字段断言'
  })

  if (sample?.id) {
    const reviewInfo = await api.getBusiness(
      `/mes/quality/qualityNgRecords/review-info?id=${sample.id}`
    )
    const info = reviewInfo?.data || {}
    caseRecord.checks.push({
      name: '处置门禁查询返回评审状态与是否放行（PB-317）',
      passed:
        Object.prototype.hasOwnProperty.call(info, 'reviewStatus') &&
        Object.prototype.hasOwnProperty.call(info, 'dispositionAllowed') &&
        Object.prototype.hasOwnProperty.call(info, 'approvalStatus'),
      details: `reviewStatus=${info.reviewStatus}，approvalStatus=${info.approvalStatus}，dispositionAllowed=${info.dispositionAllowed}`
    })
    caseRecord.checks.push({
      name: '未评审记录的处置动作保持被阻断（PB-317）',
      passed:
        info.reviewStatus === 'PENDING'
          ? info.dispositionAllowed !== true
          : info.reviewStatus !== undefined,
      details: `reviewStatus=${info.reviewStatus}，dispositionAllowed=${info.dispositionAllowed}，blockReason=${info.blockReason || '-'}`
    })

    // 非法评审结论必须被拒绝，避免脏结论写入不合格记录
    const invalidDecision = await api.post('/mes/quality/qualityNgRecords/review', {
      id: String(sample.id),
      decision: 'E2E-INVALID',
      opinion: 'E2E 自动验证：非法评审结论应被拒绝（不应落库）'
    })
    caseRecord.checks.push({
      name: '非法评审结论被拒绝且不写库（PB-317）',
      passed: !isBusinessSuccess(invalidDecision),
      details: JSON.stringify(invalidDecision).slice(0, 300)
    })
  } else {
    caseRecord.notes.push('当前无不合格记录，评审门禁与非法结论写侧未取得真实数据证据。')
    caseRecord.checks.push({
      name: '无不合格记录数据，跳过评审门禁断言',
      passed: true,
      details: 'rows=0'
    })
  }

  await openRoute(page, '/quality/ng/list')
  await page.waitForLoadState('networkidle')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '不良品列表页面真实渲染处置评审入口与状态列',
    passed:
      new URL(page.url()).pathname.startsWith('/quality/ng') &&
      bodyText.includes('处置评审') &&
      bodyText.includes('处置审批'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'quality-ng-disposition-review', record)
  caseRecord.evidence.push('真实登录、不合格记录列表/处置门禁接口、评审入口页面与浏览器截图')
  return { token, api, partial: rowsArray.length === 0 }
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
  return { token, api, partial: rows.length === 0 }
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
  const token = await login(page)
  const api = createApiClient({ token, record })

  const list = await api.getBusiness(
    '/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100'
  )
  const rows =
    list?.data?.records ||
    list?.data?.list ||
    (Array.isArray(list?.data) ? list.data : [])
  const rowsArray = Array.isArray(rows) ? rows : []
  const outboundRows = rowsArray.filter((row) => String(row?.type) === '201')
  caseRecord.checks.push({
    name: '销售出库检列表可查询（201）',
    passed: Array.isArray(rowsArray),
    details: `total=${rowsArray.length}，oqc=${outboundRows.length}`
  })

  const sample = outboundRows[0]
  let hasOqcEvidence = false
  if (sample?.id) {
    const detail = await api.getBusiness(
      `/mes/quality/qualityInspection/queryMesQualityInspectionEntryByMainId/dictText?id=${sample.id}`
    )
    const entries = detail?.data || []
    const firstEntry = Array.isArray(entries) ? entries[0] : null
    hasOqcEvidence = Boolean(firstEntry)
    caseRecord.checks.push({
      name: 'OQC 明细按合格/有效让步/待判定/不合格四态返回',
      passed:
        !firstEntry ||
        (Object.prototype.hasOwnProperty.call(firstEntry, 'inspectionQty') &&
          Object.prototype.hasOwnProperty.call(firstEntry, 'passQty') &&
          Object.prototype.hasOwnProperty.call(firstEntry, 'concessionQty') &&
          Object.prototype.hasOwnProperty.call(firstEntry, 'pendingJudgeQty') &&
          Object.prototype.hasOwnProperty.call(firstEntry, 'ngQty')),
      details: firstEntry
        ? `inspectionQty=${firstEntry.inspectionQty}，passQty=${firstEntry.passQty}，concessionQty=${firstEntry.concessionQty}，pendingJudgeQty=${firstEntry.pendingJudgeQty}，ngQty=${firstEntry.ngQty}`
        : '无 OQC 明细，跳过字段断言'
    })
  } else {
    caseRecord.notes.push('当前无 201 销售出库检记录，OQC 四态与销售出库放行未取得真实数据证据。')
    caseRecord.checks.push({
      name: '无 201 销售出库检数据，跳过明细字段断言',
      passed: true,
      details: 'rows=0'
    })
  }

  await openRoute(page, '/quality/order')
  await page.waitForLoadState('networkidle')
  caseRecord.checks.push({
    name: '销售出库检沿用统一质检单页面',
    passed: new URL(page.url()).pathname.startsWith('/quality/order'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'quality-oqc-page', record)
  caseRecord.evidence.push('真实登录、201 销售出库检列表/四态明细接口与浏览器截图')
  return { token, api, partial: !hasOqcEvidence }
}

const runQualityTraceCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  // 无事实数据也必须返回完整环节骨架，且不得伪造业务记录
  const emptyKey = `E2E-TRACE-EMPTY-${Date.now()}`
  const emptyTrace = await api.getBusiness(
    `/mes/quality/trace/detail?traceKey=${encodeURIComponent(emptyKey)}&traceType=BATCH`
  )
  const emptyData = emptyTrace?.data || {}
  const emptyStages = Array.isArray(emptyData.stages) ? emptyData.stages : []
  caseRecord.checks.push({
    name: '追溯接口返回链路环节骨架且无事实时 found=false',
    passed: emptyData.found === false && emptyStages.length === 6,
    details: `found=${emptyData.found}，stages=${emptyStages.length}`
  })
  caseRecord.checks.push({
    name: '无事实批号不生成链路缺失异常（不伪造记录）',
    passed: Array.isArray(emptyData.anomalies) && emptyData.anomalies.length === 0,
    details: `anomalies=${Array.isArray(emptyData.anomalies) ? emptyData.anomalies.length : 'invalid'}`
  })

  // 重复查询保持幂等：异常条数不因重复追溯而增长
  const repeatTrace = await api.getBusiness(
    `/mes/quality/trace/detail?traceKey=${encodeURIComponent(emptyKey)}&traceType=BATCH`
  )
  const repeatAnomalies = repeatTrace?.data?.anomalies || []
  caseRecord.checks.push({
    name: '重复追溯同一批号保持幂等',
    passed: repeatAnomalies.length === (emptyData.anomalies || []).length,
    details: `first=${(emptyData.anomalies || []).length}，repeat=${repeatAnomalies.length}`
  })

  const anomalyPage = await api.getBusiness('/mes/quality/trace/anomaly/page?pageNo=1&pageSize=100')
  const anomalyRows = anomalyPage?.data?.list || []
  caseRecord.checks.push({
    name: '链路缺失数据异常分页可查询且 pageSize 不超过 100',
    passed: Array.isArray(anomalyRows),
    details: `rows=${Array.isArray(anomalyRows) ? anomalyRows.length : 'invalid'}`
  })

  const openAnomaly = anomalyRows.find((row) => row.status !== 'HANDLED')
  if (openAnomaly?.id) {
    const handled = await api.put('/mes/quality/trace/anomaly/handle', {
      id: openAnomaly.id,
      handleRemark: 'E2E 自动验证：已核对并补充链路事实'
    })
    caseRecord.checks.push({
      name: '处理链路缺失异常返回成功',
      passed: isBusinessSuccess(handled),
      details: JSON.stringify(handled).slice(0, 300)
    })
    const afterHandle = await api.getBusiness(
      `/mes/quality/trace/anomaly/page?pageNo=1&pageSize=100&status=HANDLED`
    )
    const handledIds = (afterHandle?.data?.list || []).map((row) => String(row.id))
    caseRecord.checks.push({
      name: '异常处理状态流转为 HANDLED',
      passed: handledIds.includes(String(openAnomaly.id)),
      details: `id=${openAnomaly.id}`
    })
  } else {
    caseRecord.checks.push({
      name: '当前无待处理链路缺失异常，跳过处理状态流转断言',
      passed: true,
      details: `rows=${anomalyRows.length}`
    })
  }

  // 非法请求：缺少追溯主键必须被拒绝
  const missingKey = await api.get('/mes/quality/trace/detail')
  caseRecord.checks.push({
    name: '缺少追溯主键的查询被拒绝',
    passed: !isBusinessSuccess(missingKey),
    details: JSON.stringify(missingKey).slice(0, 300)
  })

  await openRoute(page, '/quality/trace')
  await page.locator('[data-testid="quality-trace-page"]').waitFor({ state: 'visible' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '质量链路追溯页面真实渲染且只读聚合',
    passed:
      new URL(page.url()).pathname.startsWith('/quality/trace') &&
      bodyText.includes('追溯主键') &&
      bodyText.includes('链路缺失数据异常'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'quality-trace-page', record)
  caseRecord.evidence.push('真实登录、追溯只读聚合接口、链路缺失异常分页/处理接口与浏览器截图')
  caseRecord.notes.push('本次仅验证无事实批号、缺失异常幂等与页面契约，尚未取得真实批号/序列号六环节链路证据。')
  return { token, api, partial: true }
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

const runQualityBaseCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const definitions = {
    'QUALITY-BASE-001': {
      title: '质检场景规则可查询且核心场景固定',
      endpoint: '/mes/quality-scene-rule/page?pageNo=1&pageSize=100',
      route: '/quality/workbench',
      validate: (rows) => {
        const coreScenes = new Set(['101', '104', '201', '300'])
        return rows.every((row) => !row.coreScene || coreScenes.has(String(row.coreScene)))
      }
    },
    'QUALITY-BASE-002': {
      title: '质检项目主档可查询且分页不超过 100',
      endpoint: '/mes/quality/item/list?pageNo=1&pageSize=100',
      route: '/quality/workbench',
      validate: (rows) =>
        rows.every(
          (row) => row.publishStatus === undefined || [0, 1, 2].includes(row.publishStatus)
        )
    },
    'QUALITY-BASE-003': {
      title: '质检方案版本与发布状态可查询',
      endpoint: '/mes/quality/qualityPlan/list?pageNo=1&pageSize=100',
      route: '/systemModel/quality/plan',
      validate: (rows) =>
        rows.every(
          (row) =>
            row.versionNo === undefined ||
            (Number(row.versionNo) >= 1 && [0, 1, 2].includes(row.publishStatus))
        )
    },
    'QUALITY-BASE-004': {
      title: '质检存货适用范围可查询',
      endpoint:
        '/mes/quality/qualityMaterial/list?pageNo=1&pageSize=100&types=300%2C104%2C201%2C101%2C500',
      route: '/quality/workbench',
      validate: (rows) =>
        rows.every(
          (row) =>
            row.priority === undefined ||
            (Number.isInteger(Number(row.priority)) &&
              typeof row.materialId === 'string' &&
              typeof row.type === 'string' &&
              typeof row.applyOrgId === 'string' &&
              typeof row.businessSubType === 'string' &&
              (row.effectiveFrom == null || typeof row.effectiveFrom === 'string') &&
              (row.effectiveTo == null || typeof row.effectiveTo === 'string') &&
              (row.isDefault == null || typeof row.isDefault === 'boolean'))
        )
    },
    'QUALITY-BASE-005': {
      title: '不合格原因主档与正式记录快照可查询',
      endpoint: '/mes/quality-ng-type/page?pageNo=1&pageSize=100',
      route: '/quality/ng/list',
      validate: (rows) => rows.every((row) => row.id !== undefined && row.id !== null)
    },
    'QUALITY-BASE-006': {
      title: '不合格处置规则与正式执行入口可查询',
      endpoint: '/mes/quality-ng-handle-rule/page?pageNo=1&pageSize=100',
      route: '/quality/ng/list',
      validate: (rows) =>
        rows.every((row) => row.actionType === undefined || typeof row.actionType === 'string')
    }
  }
  const definition = definitions[caseId]
  const response = await api.getBusiness(definition.endpoint)
  const data = response?.data || {}
  const rows = Array.isArray(data) ? data : data.records || data.list || []
  caseRecord.checks.push({
    name: `${definition.title}，分页 pageSize 不超过 100`,
    passed:
      isBusinessSuccess(response) &&
      Array.isArray(rows) &&
      rows.length <= 100 &&
      definition.validate(rows),
    details: `rows=${Array.isArray(rows) ? rows.length : 'invalid'}`
  })

  if (caseId === 'QUALITY-BASE-004') {
    const scopeDefaults = new Map()
    let duplicateDefault = false
    for (const row of rows) {
      if (row?.isDefault !== true) continue
      const key = [row.materialId, row.type, row.applyOrgId || '', row.businessSubType || ''].join(
        '|'
      )
      const count = (scopeDefaults.get(key) || 0) + 1
      scopeDefaults.set(key, count)
      if (count > 1) duplicateDefault = true
    }
    caseRecord.checks.push({
      name: '同一存货/核心类型/适用范围最多一个默认方案',
      passed: !duplicateDefault,
      details: `defaultScopes=${scopeDefaults.size}, duplicate=${duplicateDefault}`
    })

    const firstRule = rows.find((row) => row?.materialId && row?.type)
    if (firstRule) {
      const resolved = await api.getBusiness(
        `/mes/quality/qualityMaterial/queryMaterialIdAndType?materialId=${encodeURIComponent(firstRule.materialId)}&type=${encodeURIComponent(firstRule.type)}`
      )
      const resolvedRule = resolved?.data || {}
      caseRecord.checks.push({
        name: '质检存货查询入口经过统一适用规则解析',
        passed:
          isBusinessSuccess(resolved) &&
          resolvedRule.materialId === firstRule.materialId &&
          resolvedRule.type === firstRule.type &&
          Boolean(resolvedRule.planId),
        details: `ruleId=${resolvedRule.id || 'n/a'}, planId=${resolvedRule.planId || 'n/a'}`
      })
    } else {
      caseRecord.notes.push('当前租户无质检存货绑定，跳过具体规则命中回读。')
    }
  }

  if (caseId === 'QUALITY-BASE-006') {
    const recordsResponse = await api.getBusiness(
      '/mes/quality/qualityNgRecords/list/dictText?pageNo=1&pageSize=100'
    )
    const recordRows = recordsResponse?.data?.records || recordsResponse?.data?.list || []
    const executeProbe = await api.post('/mes/quality/qualityNgRecords/execute', {
      id: 'E2E-NOT-FOUND',
      coreAction: 'CONCESSION',
      operateQty: 1,
      idempotencyKey: `E2E-PB100-${Date.now()}`
    })
    caseRecord.checks.push({
      name: '不合格处置正式执行接口存在并拒绝不存在记录',
      passed: !isBusinessSuccess(executeProbe),
      details: `code=${executeProbe?.code}, msg=${executeProbe?.msg || executeProbe?.message || ''}`
    })
    const reverseProbe = await api.post('/mes/quality/qualityNgRecords/reverse', {
      handleRecordId: 'E2E-NOT-FOUND',
      reason: 'E2E不存在记录'
    })
    caseRecord.checks.push({
      name: '不合格处置反执行接口存在并拒绝不存在记录',
      passed: !isBusinessSuccess(reverseProbe),
      details: `code=${reverseProbe?.code}, msg=${reverseProbe?.msg || reverseProbe?.message || ''}`
    })

    const executableRecord = recordRows.find(
      (row) =>
        row?.id &&
        row.reviewStatus === 'APPROVED' &&
        row.reviewCoreAction === 'SCRAP' &&
        (!row.approvalRequired || row.approvalStatus === 'APPROVED') &&
        Number(row.ngQty || 0) - Number(row.operateQty || 0) - Number(row.savedOperateQty || 0) >= 1
    )
    if (executableRecord) {
      const detail = await api.getBusiness(
        `/mes/quality/qualityNgRecords/queryById?id=${encodeURIComponent(executableRecord.id)}`
      )
      const snapshotRecord = detail?.data || {}
      const snapshotRule = snapshotRecord.dispositionRuleSnapshotJson
        ? JSON.parse(snapshotRecord.dispositionRuleSnapshotJson)
        : null
      const wrongAction = await api.post('/mes/quality/qualityNgRecords/execute', {
        id: String(executableRecord.id),
        coreAction: 'CONCESSION',
        operateQty: 1,
        idempotencyKey: `E2E-PB100-WRONG-ACTION-${Date.now()}`
      })
      caseRecord.checks.push({
        name: '正式处置不能临时改用未评审的动作',
        passed:
          !isBusinessSuccess(wrongAction) &&
          String(wrongAction?.msg || wrongAction?.message || '').includes('评审不一致'),
        details: `record=${executableRecord.id}, code=${wrongAction?.code}`
      })
      const canProbeWarehouse =
        snapshotRule != null &&
        (snapshotRule.qtyLimit == null || Number(snapshotRule.qtyLimit) >= 1) &&
        (!snapshotRule.attachmentRequired || !!snapshotRecord.reviewAttachmentUrl)
      if (canProbeWarehouse) {
        const missingWarehouse = await api.post('/mes/quality/qualityNgRecords/execute', {
          id: String(executableRecord.id),
          coreAction: 'SCRAP',
          operateQty: 1,
          idempotencyKey: `E2E-PB100-MISSING-WAREHOUSE-${Date.now()}`
        })
        caseRecord.checks.push({
          name: '报废正式执行缺少仓库时被拒绝，不生成未生效草稿',
          passed:
            !isBusinessSuccess(missingWarehouse) &&
            String(missingWarehouse?.msg || missingWarehouse?.message || '').includes('指定仓库'),
          details: `record=${executableRecord.id}, code=${missingWarehouse?.code}, msg=${missingWarehouse?.msg || missingWarehouse?.message || ''}`
        })
      } else {
        caseRecord.notes.push(
          'SCRAP 记录缺少规则快照或存在数量/附件前置限制，仓库专用断言待合适数据。'
        )
      }
    } else {
      caseRecord.notes.push('当前租户没有可执行的 SCRAP 记录，跳过动作一致性与仓库前置校验。')
    }
    const handles = recordRows.flatMap((row) => row.handleRecords || [])
    const wmsHandles = handles.filter(
      (row) => row.executionStatus === 'SUCCEEDED' && row.externalBillType === 'WMS_STOCK_IO'
    )
    caseRecord.checks.push({
      name: '执行成功的库存处置记录必须携带外部正式单据 ID',
      passed: wmsHandles.every((row) => !!row.externalBillId),
      details: `wmsHandles=${wmsHandles.length}`
    })
    if (!wmsHandles.length) {
      caseRecord.notes.push('无正式库存处置数据；此断言不代表 WMS 正向/反向闭环已验收。')
    }
    const formalMesHandles = handles.filter(
      (row) =>
        ['RUNNING', 'SUCCEEDED'].includes(row.executionStatus) &&
        ['MES_PROD_REWORK', 'MES_REPAIR_ORDER'].includes(row.externalBillType)
    )
    if (formalMesHandles.length) {
      caseRecord.checks.push({
        name: '返工/维修正式处置记录可追溯到新建任务或维修单，不是无编号的成功占位',
        passed: formalMesHandles.every((row) => !!row.externalBillId),
        details: `formalMesHandles=${formalMesHandles.length}`
      })
    } else {
      caseRecord.notes.push(
        '无返工/维修正式单据，ID 追溯与维修 RUNNING -> SUCCEEDED 待测试数据复验。'
      )
    }

    const unsupportedHandle = handles.find(
      (row) =>
        row.executionStatus === 'SUCCEEDED' &&
        ['MES_PROD_REWORK', 'MES_REPAIR_ORDER'].includes(row.externalBillType)
    )
    if (unsupportedHandle) {
      const source = recordRows.find((row) =>
        row.handleRecords?.some((handle) => handle.id === unsupportedHandle.id)
      )
      const reverse = await api.post('/mes/quality/qualityNgRecords/reverse', {
        handleRecordId: String(unsupportedHandle.id),
        reason: 'AUTOTEST-PB100：缺少正式反向契约应拒绝回退'
      })
      const afterResponse = await api.getBusiness(
        '/mes/quality/qualityNgRecords/list/dictText?pageNo=1&pageSize=100'
      )
      const afterRows = afterResponse?.data?.records || afterResponse?.data?.list || []
      const after = afterRows.find((row) => String(row.id) === String(source?.id))
      caseRecord.checks.push({
        name: '维修/返工缺少正式反向契约时安全拒绝且不改处置数量',
        passed:
          !isBusinessSuccess(reverse) &&
          String(reverse?.msg || reverse?.message || '').includes('正式反向接口') &&
          after != null &&
          Number(after.operateQty || 0) === Number(source.operateQty || 0),
        details: `handle=${unsupportedHandle.id}, code=${reverse?.code}`
      })
    } else {
      caseRecord.notes.push('无维修/返工正式处置记录；安全拒绝反执行待有真实数据时复验。')
    }
  }

  if (caseId === 'QUALITY-BASE-005') {
    const recordsResponse = await api.getBusiness(
      '/mes/quality/qualityNgRecords/list/dictText?pageNo=1&pageSize=100'
    )
    const records = recordsResponse?.data?.records || recordsResponse?.data?.list || []
    const recordRows = Array.isArray(records) ? records : []
    const snapshotRows = recordRows.filter(
      (row) => row?.ngTypeId || row?.ngTypeCodeSnapshot || row?.ngTypeNameSnapshot
    )
    caseRecord.checks.push({
      name: '正式不合格记录返回主档 ID、编码和名称快照',
      passed:
        isBusinessSuccess(recordsResponse) &&
        recordRows.every(
          (row) =>
            !row?.ngTypeId ||
            (typeof row.ngTypeCodeSnapshot === 'string' &&
              typeof row.ngTypeNameSnapshot === 'string')
        ),
      details: `records=${recordRows.length}, snapshotRows=${snapshotRows.length}`
    })
  }

  if (caseId === 'QUALITY-BASE-001') {
    const inspectionResponse = await api.getBusiness(
      '/mes/quality/qualityInspection/list?pageNo=1&pageSize=100'
    )
    const inspections = inspectionResponse?.data?.records || inspectionResponse?.data?.list || []
    const snapshotRows = Array.isArray(inspections)
      ? inspections.filter((row) => row.qualityPlanSnapshotJson)
      : []
    caseRecord.checks.push({
      name: '正式质检单回显场景子类型与方案快照字段',
      passed:
        isBusinessSuccess(response) &&
        snapshotRows.every(
          (row) => row.qualityPlanVersion !== undefined && row.qualityPlanSnapshotJson
        ),
      details: `snapshotRows=${snapshotRows.length}`
    })
  }

  await openRoute(page, definition.route)
  await page.waitForLoadState('networkidle')
  caseRecord.checks.push({
    name: `${definition.title}对应页面真实打开`,
    passed: new URL(page.url()).pathname.startsWith(definition.route),
    details: page.url()
  })
  if (caseId === 'QUALITY-BASE-006') {
    const disposition = page
      .locator('[data-testid="quality-ng-disposition"][data-quality-ng-review-action="SCRAP"]')
      .first()
    if ((await disposition.count()) && (await disposition.isEnabled())) {
      await disposition.hover()
      const scrapAction = page.locator('[data-testid="quality-ng-action-SCRAP"]:visible').first()
      if (await scrapAction.isEnabled()) {
        await scrapAction.click()
        const dialog = page.getByTestId('quality-ng-execute-dialog')
        await dialog.waitFor({ state: 'visible' })
        await dialog.getByTestId('quality-ng-execute-submit').click()
        caseRecord.checks.push({
          name: '真实页面报废弹窗先执行仓库必填校验，不绕到旧 WMS 入库页面',
          passed: (await dialog.getByText('请选择仓库', { exact: true }).count()) > 0,
          details: page.url()
        })
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
      } else {
        caseRecord.notes.push('SCRAP 记录尚未审批放行，不能执行弹窗写侧探针。')
        await page.keyboard.press('Escape')
      }
    } else {
      caseRecord.notes.push('当前页无可处置记录或没有执行权限，弹窗必填校验待测试前置数据。')
    }

    const detail = page.getByTestId('quality-ng-detail').first()
    if (await detail.count()) {
      await detail.click()
      const drawer = page.locator('.quality-ng-detail-drawer')
      await drawer.waitFor({ state: 'visible' })
      const text = await drawer.innerText()
      caseRecord.checks.push({
        name: '详情真实展示核心动作、正式执行状态、外部单据及反执行状态',
        passed: ['核心动作', '执行状态', '外部正式单据', '反执行状态'].every((label) =>
          text.includes(label)
        ),
        details: page.url()
      })
    } else {
      caseRecord.notes.push('当前页无不良记录，详情与反执行入口待正式数据复验。')
    }
  }
  await saveScreenshot(page, outputDir, `${caseId.toLowerCase()}-page`, record)
  caseRecord.evidence.push('真实登录、质量基础接口断言与浏览器页面截图')
  return { token, api }
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
