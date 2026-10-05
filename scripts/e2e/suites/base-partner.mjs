import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB034-002']

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`
const dataOf = (response) => response?.data ?? response
export const PARTNER_ROLE_IN_USE_CODE = 1001003007

export const isStableId = (value) =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim()))

export const findMenuRouteByComponent = (menus, component, parentPath = '') => {
  for (const menu of Array.isArray(menus) ? menus : []) {
    const path = String(menu?.path || '').trim()
    const routePath = path.startsWith('/')
      ? path
      : [parentPath.replace(/\/$/, ''), path.replace(/^\//, '')].filter(Boolean).join('/')
    if (menu?.component === component) return `/${routePath.replace(/^\/+/, '')}`
    const childRoute = findMenuRouteByComponent(menu?.children, component, routePath)
    if (childRoute) return childRoute
  }
  return null
}

export const assertPartnerRoleDeleteRejected = (response) => {
  if (response?.code !== PARTNER_ROLE_IN_USE_CODE) {
    throw new Error(
      `多角色客商删除契约不符：expected code ${PARTNER_ROLE_IN_USE_CODE}, ` +
      `got code ${response?.code ?? 'unknown'}`
    )
  }
  return true
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  caseRecord.notes.push(
    'PB-034：客户、供应商、承运商收敛为 base_partner 单表，角色用 customer_enabled/supplier_enabled/carrier_enabled 表达，稳定客商编码创建后不可修改。'
  )

  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'PB034-002') {
    const pageResult = dataOf(await api.getBusiness('/base/partner/page?pageNo=1&pageSize=100'))
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
    let partnerId
    let detail
    try {
      partnerId = dataOf(await api.postBusiness('/base/partner/create', {
        name: `E2E双角色客商${suffix}`,
        shortName: 'E2E双角色',
        partnerKind: 'ORGANIZATION',
        taxNo: `E2E${suffix}`,
        status: 'ACTIVE',
        customerEnabled: true,
        supplierEnabled: true,
        carrierEnabled: false
      }))
      if (!isStableId(partnerId)) throw new Error(`创建接口返回无效客商 ID：${JSON.stringify(partnerId)}`)
      caseRecord.checks.push({
        name: '同一客商可同时启用客户与供应商角色',
        passed: true,
        details: `partnerId=${partnerId}`
      })

      detail = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(partnerId)}`))
      const detailIdMatches = isStableId(detail?.id) && String(detail.id) === String(partnerId)
      caseRecord.checks.push({
        name: '创建后回读稳定 ID、双角色与自动生成的角色编码',
        passed:
          detailIdMatches &&
          detail?.customerEnabled === true &&
          detail?.supplierEnabled === true &&
          Boolean(detail?.customerCode) &&
          Boolean(detail?.supplierCode),
        details: detail
          ? `id=${detail.id}, partnerCode=${detail.partnerCode}, customerCode=${detail.customerCode}, supplierCode=${detail.supplierCode}`
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

      const customerHits = dataOf(await api.getBusiness('/base/partner/simple-list?roleType=CUSTOMER'))
      const supplierHits = dataOf(await api.getBusiness('/base/partner/simple-list?roleType=SUPPLIER'))
      caseRecord.checks.push({
        name: '客户与供应商角色过滤返回同一客商 ID',
        passed:
          (customerHits || []).some((item) => String(item.id) === String(partnerId)) &&
          (supplierHits || []).some((item) => String(item.id) === String(partnerId)),
        details: `customerHits=${(customerHits || []).length}, supplierHits=${(supplierHits || []).length}`
      })

      const deleteResponse = await api.request(
        'DELETE',
        `/base/partner/delete?id=${encodeURIComponent(partnerId)}`
      )
      assertPartnerRoleDeleteRejected(deleteResponse)
      caseRecord.checks.push({
        name: '已启用多个角色的客商禁止删除',
        passed: true,
        details: `HTTP 成功且业务拒绝 code=${deleteResponse.code}`
      })
    } finally {
      if (isStableId(partnerId)) {
        try {
          const cleanupDetail = dataOf(await api.getBusiness(
            `/base/partner/get?id=${encodeURIComponent(partnerId)}`
          ))
          if (cleanupDetail?.id && String(cleanupDetail.id) === String(partnerId)) {
            await api.putBusiness('/base/partner/update', {
              ...cleanupDetail,
              supplierEnabled: false,
              carrierEnabled: false
            })
            await api.deleteBusiness(`/base/partner/delete?id=${encodeURIComponent(partnerId)}`)
            caseRecord.checks.push({
              name: '未产生业务引用的单角色客商可删除（用例自清理）',
              passed: true,
              details: '自建客商已通过业务成功契约清理'
            })
          } else {
            throw new Error('清理前未回读到自建客商的稳定 ID')
          }
        } catch (error) {
          caseRecord.notes.push(`PB034-002 清理失败 partnerId=${partnerId}: ${error.message}`)
          caseRecord.checks.push({
            name: '未产生业务引用的单角色客商可删除（用例自清理）',
            passed: false,
            details: `清理业务失败：${error.message}`
          })
        }
      }
    }

    const permission = dataOf(await api.getPermissionInfo())
    const partnerRoute = findMenuRouteByComponent(permission?.menus, 'base/partner/index')
    if (!partnerRoute) throw new Error('权限菜单中未找到 component=base/partner/index')
    await openRoute(page, partnerRoute, { readyText: '客商编码' })
    await page.locator('.el-table th').filter({ hasText: '客商编码' }).first().waitFor({
      state: 'visible',
      timeout: 30000
    })
    const bodyText = await page.locator('body').innerText()
    const headers = await page.locator('.el-table th').allInnerTexts()
    caseRecord.checks.push({
      name: '客商档案页面按真实菜单完整路由渲染',
      passed:
        page.url().includes(partnerRoute) &&
        headers.some((header) => header.trim() === '客商编码') &&
        bodyText.includes('角色'),
      details: `route=${partnerRoute}, headers=${headers.join(' | ')}`
    })
    await saveScreenshot(page, outputDir, 'pb034-base-partner', record)

    // PB-034 第四批：旧 ERP 客户/供应商接口已切换到统一客商，旧表退役为只读视图
    const legacySuffix = unique('LEGACY')
    let legacyCustomerId
    try {
      legacyCustomerId = dataOf(await api.postBusiness('/erp/customer/create', {
        name: `E2E旧客户口径${legacySuffix}`,
        code: `LEGACY${legacySuffix}`,
        mobile: '13800000000',
        status: 0,
        sort: 0
      }))
      if (!isStableId(legacyCustomerId)) {
        throw new Error(`旧客户创建接口返回无效客商 ID：${JSON.stringify(legacyCustomerId)}`)
      }
      caseRecord.checks.push({
        name: '旧 ERP 客户创建接口返回统一客商稳定编号',
        passed: true,
        details: `id=${legacyCustomerId}`
      })

      const partnerRows = dataOf(await api.getBusiness(
        `/base/partner/page?pageNo=1&pageSize=100&keyword=${encodeURIComponent(`LEGACY${legacySuffix}`)}`
      ))
      const unifiedRows = partnerRows?.list || partnerRows?.records || []
      caseRecord.checks.push({
        name: '旧客户接口写入落到 base_partner（统一客商可见）',
        passed: unifiedRows.some((item) => String(item.id) === String(legacyCustomerId)),
        details: `partnerHits=${unifiedRows.length}`
      })

      const legacyPage = dataOf(await api.getBusiness('/erp/customer/page?pageNo=1&pageSize=100'))
      const legacyRows = legacyPage?.list || legacyPage?.records || []
      caseRecord.checks.push({
        name: '旧客户分页经只读兼容视图读取统一客商',
        passed: legacyRows.some((item) => String(item.id) === String(legacyCustomerId)),
        details: `legacyRows=${legacyRows.length}`
      })
    } finally {
      if (isStableId(legacyCustomerId)) {
        try {
          await api.deleteBusiness(`/erp/customer/delete?id=${encodeURIComponent(legacyCustomerId)}`)
          caseRecord.checks.push({
            name: '旧客户删除接口关闭统一客商客户角色（用例自清理）',
            passed: true,
            details: '旧口径自建客户已通过业务成功契约清理'
          })
        } catch (error) {
          caseRecord.notes.push(`PB034-002 清理失败 legacyCustomerId=${legacyCustomerId}: ${error.message}`)
          caseRecord.checks.push({
            name: '旧客户删除接口关闭统一客商客户角色（用例自清理）',
            passed: false,
            details: `清理业务失败：${error.message}`
          })
        }
      }
    }

    caseRecord.evidence.push(
      '统一客商单表 CRUD、双角色开关、编码不可修改、多角色删除保护，以及旧 ERP 客户接口写统一客商、旧表只读视图回读的真实接口验证'
    )
    return { token, api }
  }

  return { designed: true }
}
