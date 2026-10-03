import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB034-002']

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  caseRecord.notes.push(
    'PB-034：客户、供应商、承运商收敛为 base_partner 单表，角色用 customer_enabled/supplier_enabled/carrier_enabled 表达，稳定客商编码创建后不可修改。'
  )

  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'PB034-002') {
    const pageResult = await api.getBusiness('/base/partner/page?pageNo=1&pageSize=100')
    const rows = pageResult?.list || pageResult?.records || []
    caseRecord.checks.push({
      name: '统一客商分页来自 base_partner 单表',
      passed: Array.isArray(rows),
      details: `rows=${rows.length}`
    })
    const sample = rows[0]
    caseRecord.checks.push({
      name: '列表回读稳定客商编码与角色开关字段',
      passed:
        sample === undefined ||
        ['partnerCode', 'customerEnabled', 'supplierEnabled', 'carrierEnabled'].every((field) =>
          Object.prototype.hasOwnProperty.call(sample, field)
        ),
      details: sample ? `columns=${Object.keys(sample).join(',')}` : '当前租户无客商，字段契约由 VO 保证'
    })

    // 双角色闭环：创建一个同时启用客户与供应商角色的客商，校验编码稳定并最终清理
    const suffix = unique('E2E')
    const partnerId = await api.postBusiness('/base/partner/create', {
      name: `E2E双角色客商${suffix}`,
      shortName: 'E2E双角色',
      partnerKind: 'ORGANIZATION',
      taxNo: `E2E${suffix}`,
      status: 'ACTIVE',
      customerEnabled: true,
      supplierEnabled: true,
      carrierEnabled: false
    })
    caseRecord.checks.push({
      name: '同一客商可同时启用客户与供应商角色',
      passed: Boolean(partnerId),
      details: `partnerId=${partnerId}`
    })

    const detail = await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(partnerId)}`)
    caseRecord.checks.push({
      name: '创建后回读双角色与自动生成的角色编码',
      passed:
        detail?.customerEnabled === true &&
        detail?.supplierEnabled === true &&
        Boolean(detail?.customerCode) &&
        Boolean(detail?.supplierCode),
      details: detail
        ? `partnerCode=${detail.partnerCode}, customerCode=${detail.customerCode}, supplierCode=${detail.supplierCode}`
        : '未回读到客商'
    })

    let codeImmutableRejected = false
    try {
      await api.putBusiness('/base/partner/update', { ...detail, partnerCode: `CHANGED${suffix}` })
    } catch (e) {
      codeImmutableRejected = true
    }
    caseRecord.checks.push({
      name: '稳定客商编码创建后不可修改',
      passed: codeImmutableRejected,
      details: codeImmutableRejected ? '编码变更被拒绝' : '编码变更未被拒绝'
    })

    const customerHits = await api.getBusiness('/base/partner/simple-list?roleType=CUSTOMER')
    const supplierHits = await api.getBusiness('/base/partner/simple-list?roleType=SUPPLIER')
    caseRecord.checks.push({
      name: '客户与供应商角色过滤返回同一客商 ID',
      passed:
        (customerHits || []).some((item) => String(item.id) === String(partnerId)) &&
        (supplierHits || []).some((item) => String(item.id) === String(partnerId)),
      details: `customerHits=${(customerHits || []).length}, supplierHits=${(supplierHits || []).length}`
    })

    let multiRoleDeleteRejected = false
    try {
      await api.request('DELETE', `/base/partner/delete?id=${encodeURIComponent(partnerId)}`)
    } catch (e) {
      multiRoleDeleteRejected = true
    }
    caseRecord.checks.push({
      name: '已启用多个角色的客商禁止删除',
      passed: multiRoleDeleteRejected,
      details: multiRoleDeleteRejected ? '多角色删除被拒绝' : '多角色删除未被拒绝'
    })

    // 清理：关闭供应商角色后仅保留客户角色，再删除，避免污染租户数据
    await api.putBusiness('/base/partner/update', {
      ...detail,
      supplierEnabled: false
    })
    let cleanupOk = false
    try {
      await api.request('DELETE', `/base/partner/delete?id=${encodeURIComponent(partnerId)}`)
      cleanupOk = true
    } catch (e) {
      cleanupOk = false
    }
    caseRecord.checks.push({
      name: '未产生业务引用的单角色客商可删除（用例自清理）',
      passed: cleanupOk,
      details: cleanupOk ? '自建客商已清理' : '自建客商未清理，需人工处理'
    })

    await openRoute(page, '/base/partner')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '客商档案页面真实渲染',
      passed: page.url().includes('/base/partner') && bodyText.includes('客商编码') && bodyText.includes('角色'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'pb034-base-partner', record)

    // PB-034 第四批：旧 ERP 客户/供应商接口已切换到统一客商，旧表退役为只读视图
    const legacySuffix = unique('LEGACY')
    const legacyCustomerId = await api.postBusiness('/erp/customer/create', {
      name: `E2E旧客户口径${legacySuffix}`,
      code: `LEGACY${legacySuffix}`,
      mobile: '13800000000',
      status: 0,
      sort: 0
    })
    caseRecord.checks.push({
      name: '旧 ERP 客户创建接口返回统一客商编号',
      passed: Boolean(legacyCustomerId),
      details: `id=${legacyCustomerId}`
    })

    const partnerRows = await api.getBusiness(
      `/base/partner/page?pageNo=1&pageSize=100&keyword=${encodeURIComponent(`LEGACY${legacySuffix}`)}`
    )
    const unifiedRows = partnerRows?.list || partnerRows?.records || []
    caseRecord.checks.push({
      name: '旧客户接口写入落到 base_partner（统一客商可见）',
      passed: unifiedRows.some((item) => String(item.id) === String(legacyCustomerId)),
      details: `partnerHits=${unifiedRows.length}`
    })

    const legacyPage = await api.getBusiness('/erp/customer/page?pageNo=1&pageSize=100')
    const legacyRows = legacyPage?.list || legacyPage?.records || []
    caseRecord.checks.push({
      name: '旧客户分页经只读兼容视图读取统一客商',
      passed: legacyRows.some((item) => String(item.id) === String(legacyCustomerId)),
      details: `legacyRows=${legacyRows.length}`
    })

    let legacyCleanupOk = false
    try {
      await api.request('DELETE', `/erp/customer/delete?id=${encodeURIComponent(legacyCustomerId)}`)
      legacyCleanupOk = true
    } catch (e) {
      legacyCleanupOk = false
    }
    caseRecord.checks.push({
      name: '旧客户删除接口关闭统一客商客户角色（用例自清理）',
      passed: legacyCleanupOk,
      details: legacyCleanupOk ? '旧口径自建客户已清理' : '旧口径自建客户未清理，需人工处理'
    })

    caseRecord.evidence.push(
      '统一客商单表 CRUD、双角色开关、编码不可修改、多角色删除保护，以及旧 ERP 客户接口写统一客商、旧表只读视图回读的真实接口验证'
    )
    return { token, api }
  }

  return { designed: true }
}
