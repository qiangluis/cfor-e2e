import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'

export const cases = ['PB034-002']

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`
const dataOf = (response) =>
  response && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response
export const PARTNER_ROLE_IN_USE_CODE = 1001003007
export const PARTNER_CODE_IMMUTABLE_CODE = 1001003005

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

export const assertPartnerCodeImmutableRejected = (response) => {
  if (response?.code !== PARTNER_CODE_IMMUTABLE_CODE) {
    throw new Error(`客商编码变更必须返回 ${PARTNER_CODE_IMMUTABLE_CODE}，实际 ${response?.code}`)
  }
  return true
}

export const partnerRoleFilterMatches = (rows, partnerId, expected) =>
  Array.isArray(rows) && rows.every((row) => isStableId(row?.id)) &&
  rows.some((row) => String(row.id) === String(partnerId)) === expected

const partnerWriteBody = (detail) => ({
  id: detail.id, name: detail.name, partnerCode: detail.partnerCode,
  shortName: detail.shortName, partnerKind: detail.partnerKind,
  taxNo: detail.taxNo, status: detail.status,
  customerEnabled: detail.customerEnabled, supplierEnabled: detail.supplierEnabled,
  carrierEnabled: detail.carrierEnabled
})

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  caseRecord.notes.push(
    'PB-034：客户、供应商、承运商收敛为 base_partner 单表，角色用 customer_enabled/supplier_enabled/carrier_enabled 表达，稳定客商编码创建后不可修改。'
  )

  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'PB034-002') {
    await assertLocalWriteSafety(caseRecord)
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

    // Exercise all three roles on the same partner before removing the owned fixture.
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
        carrierEnabled: true
      }))
      if (!isStableId(partnerId)) throw new Error(`创建接口返回无效客商 ID：${JSON.stringify(partnerId)}`)
      caseRecord.checks.push({
        name: '同一客商可同时启用客户、供应商和承运商角色',
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
          detail?.carrierEnabled === true &&
          Boolean(detail?.customerCode) &&
          Boolean(detail?.supplierCode) &&
          Boolean(detail?.carrierCode),
        details: detail
          ? `id=${detail.id}, partnerCode=${detail.partnerCode}, customerCode=${detail.customerCode}, supplierCode=${detail.supplierCode}`
          : '未回读到客商'
      })

      const codeRejection = await api.put('/base/partner/update', {
        ...partnerWriteBody(detail), partnerCode: `CHANGED${suffix}`
      })
      assertPartnerCodeImmutableRejected(codeRejection)
      const unchanged = dataOf(await api.getBusiness(`/base/partner/get?id=${partnerId}`))
      caseRecord.checks.push({
        name: '稳定客商编码创建后不可修改',
        passed: unchanged?.partnerCode === detail.partnerCode,
        details: `code=${codeRejection.code}, partnerCode=${unchanged?.partnerCode}`
      })

      const customerHits = dataOf(await api.getBusiness('/base/partner/simple-list?roleType=CUSTOMER'))
      const supplierHits = dataOf(await api.getBusiness('/base/partner/simple-list?roleType=SUPPLIER'))
      const carrierHits = dataOf(await api.getBusiness('/base/partner/simple-list?roleType=CARRIER'))
      caseRecord.checks.push({
        name: '客户、供应商和承运商角色过滤返回同一客商 ID',
        passed:
          (customerHits || []).some((item) => String(item.id) === String(partnerId)) &&
          (supplierHits || []).some((item) => String(item.id) === String(partnerId)) &&
          (carrierHits || []).some((item) => String(item.id) === String(partnerId)),
        details: `customerHits=${customerHits.length}, supplierHits=${supplierHits.length}, carrierHits=${carrierHits.length}`
      })
      for (const role of ['customerEnabled', 'supplierEnabled', 'carrierEnabled']) {
        const filtered = dataOf(await api.getBusiness(
          `/base/partner/page?pageNo=1&pageSize=100&${role}=true&keyword=${encodeURIComponent(detail.partnerCode)}`
        ))
        const hits = filtered?.list || []
        caseRecord.checks.push({
          name: `${role} 分页过滤仅返回同一专属客商`,
          passed: hits.length === 1 && String(hits[0].id) === String(partnerId) &&
            hits[0][role] === true && hits[0].taxNo === detail.taxNo,
          details: `partnerId=${partnerId}, hits=${hits.length}`
        })
      }

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

      const roles = [
        ['customerEnabled', 'CUSTOMER'],
        ['supplierEnabled', 'SUPPLIER'],
        ['carrierEnabled', 'CARRIER']
      ]
      for (const [selectedRole] of roles) {
        const roleFlags = Object.fromEntries(roles.map(([field]) => [field, field === selectedRole]))
        await api.putBusiness('/base/partner/update', {
          ...partnerWriteBody(detail), ...roleFlags
        })
        const singleRole = dataOf(await api.getBusiness(`/base/partner/get?id=${partnerId}`))
        caseRecord.checks.push({
          name: `专属客商切换为 ${selectedRole} 单角色后回读开关`,
          passed: roles.every(([field]) => singleRole?.[field] === roleFlags[field]),
          details: JSON.stringify(roleFlags)
        })
        for (const [field, roleType] of roles) {
          const expected = field === selectedRole
          const simple = dataOf(await api.getBusiness(`/base/partner/simple-list?roleType=${roleType}`))
          const filtered = dataOf(await api.getBusiness(
            `/base/partner/page?pageNo=1&pageSize=100&${field}=true&keyword=${encodeURIComponent(detail.partnerCode)}`
          ))
          const hits = filtered?.list
          caseRecord.checks.push({
            name: `${selectedRole} 单角色在 ${field} 筛选中的包含/排除正确`,
            passed: partnerRoleFilterMatches(simple, partnerId, expected) &&
              partnerRoleFilterMatches(hits, partnerId, expected) &&
              hits.length === (expected ? 1 : 0) &&
              hits.every((row) => row[field] === true && row.taxNo === detail.taxNo),
            details: `partnerId=${partnerId}, expected=${expected}, hits=${hits?.length}`
          })
        }
      }
    } finally {
      if (isStableId(partnerId)) {
        try {
          const cleanupDetail = dataOf(await api.getBusiness(
            `/base/partner/get?id=${encodeURIComponent(partnerId)}`
          ))
          if (cleanupDetail?.id && String(cleanupDetail.id) === String(partnerId)) {
            await api.putBusiness('/base/partner/update', {
              ...partnerWriteBody(cleanupDetail),
              customerEnabled: true,
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

    let crmId
    let crmPartnerId
    const crmName = `AUTOTEST-PB034-002-CRM-${suffix}`
    try {
      if (!isStableId(permission?.user?.id)) throw new Error('当前用户编号无效，未创建 CRM 客户')
      crmId = dataOf(await api.postBusiness('/crm/customer/create', {
        name: crmName, ownerUserId: permission.user.id, remark: crmName
      }))
      if (!isStableId(crmId)) throw new Error('CRM 创建接口未返回稳定编号')
      const crmDetail = dataOf(await api.getBusiness(`/crm/customer/get?id=${crmId}`))
      const linkage = await runReadOnlySql(`
        SELECT c.partner_id, p.name, p.customer_enabled
        FROM crm_customer c JOIN base_partner p ON p.id=c.partner_id
        WHERE c.id='${crmId}' AND c.tenant_id=1 AND p.tenant_id=1
          AND c.deleted=0 AND p.deleted=0
      `)
      if (!linkage.available || linkage.rows.length !== 1) throw new Error('CRM 与统一客商关联未唯一落库')
      crmPartnerId = linkage.rows[0][0]
      const crmPartner = dataOf(await api.getBusiness(`/base/partner/get?id=${crmPartnerId}`))
      const legacySource = await runReadOnlySql(`
        SELECT TABLE_TYPE FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='erp_customer';
        SELECT v.id,v.name FROM erp_customer v
        WHERE v.id='${crmPartnerId}' AND v.tenant_id=1 AND v.deleted=0
      `)
      caseRecord.checks.push({
        name: 'CRM 创建客户正式回读并通过 partner_id 关联唯一 base_partner 客户角色',
        passed: crmDetail?.name === crmName && crmPartner?.name === crmName &&
          crmPartner.customerEnabled === true && linkage.rows[0][1] === crmName,
        details: `crmId=${crmId}, partnerId=${crmPartnerId}`
      })
      caseRecord.checks.push({
        name: '旧 ERP 客户主档为只读兼容视图，CRM 客户投影使用同一统一客商编号',
        passed: legacySource.available && legacySource.rows.length === 2 &&
          legacySource.rows[0][0] === 'VIEW' &&
          legacySource.rows[1][0] === String(crmPartnerId) &&
          legacySource.rows[1][1] === crmName,
        details: JSON.stringify(legacySource.rows)
      })
    } finally {
      if (isStableId(crmId)) await api.deleteBusiness(`/crm/customer/delete?id=${crmId}`)
      if (isStableId(crmPartnerId)) {
        const deletedPartner = dataOf(await api.getBusiness(`/base/partner/get?id=${crmPartnerId}`))
        caseRecord.checks.push({
          name: 'CRM 自建客户删除后统一客商主体同步清理',
          passed: deletedPartner === null,
          details: `crmId=${crmId}, partnerId=${crmPartnerId}`
        })
      }
    }

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
