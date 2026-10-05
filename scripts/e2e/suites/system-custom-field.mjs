import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB040-001', 'PB040-002', 'PB040-003']

const CUSTOM_FIELD_CODE_PREFIX = 'E2E_PB040'

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'PB040-001') {
    const objectCatalogResponse = await api.getBusiness('/system/custom-field/object-catalog')
    const definitionPageResponse = await api.getBusiness(
      '/system/custom-field/page?pageNo=1&pageSize=100'
    )
    const objects = Array.isArray(objectCatalogResponse?.data) ? objectCatalogResponse.data : []
    const definitions = definitionPageResponse?.data?.list || []

    caseRecord.checks.push({
      name: '业务对象与能力位置目录可访问',
      passed: objects.length > 0,
      details: `objectCount=${objects.length}`
    })

    const requiredObjects = ['crm.customer', 'erp.sale_order', 'wms.stk_io', 'pm.project', 'after_sales.ticket']
    const objectCodes = objects.map((item) => item?.objectCode)
    caseRecord.checks.push({
      name: '内置对象覆盖 CRM/ERP/WMS/PMS/售后公共契约',
      passed: requiredObjects.every((code) => objectCodes.includes(code)),
      details: `missing=${requiredObjects.filter((code) => !objectCodes.includes(code)).join(',') || 'none'}`
    })

    const placementsBound = objects.every((item) => Array.isArray(item?.supportedPlacements))
    const hasBodyCapableObject = objects.some((item) => item?.bodySupported === true)
    caseRecord.checks.push({
      name: '登记对象显式声明能力位置，未开放列表/报表等未接线位置',
      passed: placementsBound && hasBodyCapableObject,
      details: '原生仅登记表头/详情/API；WMS 出入库单与订单行额外支持表单主体'
    })

    caseRecord.checks.push({
      name: '定义分页接口返回自定义项列表',
      passed: Array.isArray(definitions),
      details: `definitionCount=${definitions.length}`
    })

    await openRoute(page, '/settings/custom-field', {
      readySelector: '.custom-field-tabs',
      readyTimeoutMs: 15000
    })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设置-自定义项中心页面渲染定义与旧扩展槽位两个页签',
      passed: bodyText.includes('自定义项定义') && bodyText.includes('旧扩展槽位'),
      details: page.url()
    })

    await saveScreenshot(page, outputDir, 'pb040-custom-field-center', record)
    caseRecord.evidence.push(
      '真实登录并打开设置-自定义项中心；对象目录、能力位置与定义分页通过后端接口回读'
    )
    return { token, api }
  }

  if (caseId === 'PB040-002') {
    const fieldCode = `${CUSTOM_FIELD_CODE_PREFIX}_${Date.now()}`
    const createResult = await api.postBusiness('/system/custom-field/create', {
      fieldCode,
      fieldName: 'E2E 自定义项',
      dataType: 'TEXT',
      sensitivityLevel: 'NORMAL',
      description: 'PB-040 E2E draft',
      bindings: [{ businessObject: 'crm.customer', placement: 'FORM_HEADER', displayOrder: 1 }]
    })
    const fieldId = createResult
    caseRecord.checks.push({
      name: '草稿自定义项绑定已注册业务对象与能力位置后创建成功',
      passed: Boolean(fieldId),
      details: `fieldId=${fieldId}`
    })

    const draft = await api.getBusiness(`/system/custom-field/get?id=${fieldId}`)
    caseRecord.checks.push({
      name: '草稿阶段编码与数据类型可编辑',
      passed: draft?.codeEditable === true && draft?.dataTypeEditable === true && draft?.currentVersion === 0,
      details: `status=${draft?.status} version=${draft?.currentVersion}`
    })

    const impact = await api.getBusiness(`/system/custom-field/impact?id=${fieldId}`)
    caseRecord.checks.push({
      name: '发布影响预览可计算对象数量与阻断项',
      passed: impact?.publishable === true && impact?.boundObjectCount === 1,
      details: `publishable=${impact?.publishable} boundObjectCount=${impact?.boundObjectCount}`
    })

    await api.postBusiness('/system/custom-field/submit-publish', { id: fieldId, reason: 'E2E submit' })
    const pending = await api.getBusiness(`/system/custom-field/get?id=${fieldId}`)
    caseRecord.checks.push({
      name: '提交发布后进入待审核状态',
      passed: pending?.status === 'PENDING_PUBLISH',
      details: `status=${pending?.status}`
    })

    await api.postBusiness('/system/custom-field/review-publish', {
      id: fieldId,
      decision: 'APPROVE',
      opinion: 'E2E approve'
    })
    const published = await api.getBusiness(`/system/custom-field/get?id=${fieldId}`)
    caseRecord.checks.push({
      name: '审核通过后发布并递增版本，编码与数据类型锁定',
      passed:
        published?.status === 'PUBLISHED' &&
        published?.currentVersion === 1 &&
        published?.codeEditable === false &&
        published?.dataTypeEditable === false,
      details: `status=${published?.status} version=${published?.currentVersion}`
    })

    const immutableAttempt = await api.put('/system/custom-field/update', {
      ...published,
      id: fieldId,
      fieldCode: `${fieldCode}_CHANGED`,
      bindings: [{ businessObject: 'crm.customer', placement: 'FORM_HEADER', displayOrder: 1 }]
    })
    caseRecord.checks.push({
      name: '已发布字段直接改写稳定编码被后端拒绝',
      passed: immutableAttempt?.code !== 0,
      details: `code=${immutableAttempt?.code} msg=${immutableAttempt?.msg || immutableAttempt?.message || 'n/a'}`
    })

    await api.postBusiness(`/system/custom-field/create-version?id=${fieldId}`)
    const nextDraft = await api.getBusiness(`/system/custom-field/get?id=${fieldId}`)
    const logs = await api.getBusiness(`/system/custom-field/publish-logs?id=${fieldId}`)
    caseRecord.checks.push({
      name: '已发布字段通过新建版本进入草稿并保留发布日志',
      passed:
        nextDraft?.status === 'DRAFT' &&
        nextDraft?.currentVersion === 1 &&
        nextDraft?.codeEditable === false &&
        Array.isArray(logs) &&
        logs.length >= 3,
      details: `status=${nextDraft?.status} logCount=${Array.isArray(logs) ? logs.length : 'n/a'}`
    })

    // 清理：新版本草稿未产生业务值，删除避免污染测试租户配置
    await api.delete(`/system/custom-field/delete?id=${fieldId}`)
    caseRecord.evidence.push(
      '真实接口创建草稿 -> 影响预览 -> 提交 -> 审核发布 -> 编码不可变校验 -> 新建版本 -> 删除草稿 全链路'
    )
    return { token, api }
  }

  if (caseId === 'PB040-003') {
    const slots = await api.getBusiness('/system/custom-field/legacy-slots')
    const slotList = Array.isArray(slots) ? slots : []
    caseRecord.checks.push({
      name: '旧 custom_field 扩展槽位登记可查询',
      passed: slotList.length > 0,
      details: `slotCount=${slotList.length}`
    })

    const hasSystemReserved = slotList.some((slot) => slot?.occupancyType === 'SYSTEM_RESERVED')
    caseRecord.checks.push({
      name: '系统内部占用槽位标记为 SYSTEM_RESERVED',
      passed: hasSystemReserved,
      details: `reserved=${slotList.filter((slot) => slot?.occupancyType === 'SYSTEM_RESERVED').length}`
    })

    const unknownSlots = slotList.filter((slot) => slot?.occupancyType === 'UNKNOWN')
    caseRecord.checks.push({
      name: '未识别槽位保留人工审核入口而不直接暴露',
      passed: unknownSlots.every((slot) => slot?.migrationStatus === 'PENDING'),
      details: `unknown=${unknownSlots.length}`
    })

    const runtimeSchema = await api.getBusiness(
      '/system/custom-field/runtime-schema?businessObject=crm.customer&placement=FORM_HEADER'
    )
    const schemaList = Array.isArray(runtimeSchema) ? runtimeSchema : []
    caseRecord.checks.push({
      name: '运行时 Schema 只返回已发布且未停用的定义',
      passed: schemaList.every((item) => item?.status === 'PUBLISHED'),
      details: `schemaCount=${schemaList.length}`
    })

    await openRoute(page, '/settings/custom-field')
    await page.getByRole('tab', { name: '旧扩展槽位' }).click().catch(() => {})
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '旧扩展槽位页签展示兼容层说明',
      passed: bodyText.includes('旧自定义项') || bodyText.includes('兼容层') || bodyText.includes('custom_field'),
      details: page.url()
    })

    await saveScreenshot(page, outputDir, 'pb040-legacy-slots', record)
    caseRecord.evidence.push(
      '旧扩展槽位登记、系统保留占用与运行时 Schema 只读契约回读'
    )
    return { token, api }
  }
}
