import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { runPartnerIsolationEvidence } from '../fixtures/partner-isolation.mjs'
import { queryOwnedPartnerInBrowser } from '../fixtures/partner-browser.mjs'
import { recordPartnerCatalogEvidence } from '../fixtures/partner-acceptance-evidence.mjs'
import { withCrmAcceptanceActor } from '../fixtures/crm-acceptance-actor.mjs'

export const cases = ['PB034-002']

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`
const dataOf = (response) =>
  response && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response
const enabledFlag = (value) => value === '1' || value === '\u0001' || value === 1 || value === true
export const PARTNER_ROLE_IN_USE_CODE = 1001003007
export const PARTNER_CODE_IMMUTABLE_CODE = 1001003005
export const PARTNER_ROLE_IN_USE_MESSAGE = '公共客商已启用其他角色，不能删除，请仅停用对应角色'
export const PARTNER_CODE_IMMUTABLE_MESSAGE = '公共客商编码创建后不可修改'
export const PARTNER_ROLE_DELETE_REJECTION = Object.freeze({
  code: PARTNER_ROLE_IN_USE_CODE,
  message: PARTNER_ROLE_IN_USE_MESSAGE
})
export const PARTNER_CODE_IMMUTABLE_REJECTION = Object.freeze({
  code: PARTNER_CODE_IMMUTABLE_CODE,
  message: PARTNER_CODE_IMMUTABLE_MESSAGE
})

export const partnerAcceptanceBoundary = ({
  backendRevalidated = false,
  crossTenantEvidence = false
} = {}) => {
  const blockers = []
  if (!backendRevalidated) blockers.push('当前后端实例尚未完成真实 API/数据库复验')
  if (!crossTenantEvidence) blockers.push('尚缺第二租户真实身份的读取/写入拒绝证据')
  return {
    acceptanceComplete: blockers.length === 0,
    blockers
  }
}

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
  if (!matchesExpectedBusinessRejection(response, PARTNER_ROLE_DELETE_REJECTION)) {
    throw new Error(
      `多角色客商删除契约不符：expected code/message ${PARTNER_ROLE_IN_USE_CODE}/${PARTNER_ROLE_IN_USE_MESSAGE}, ` +
      `got ${response?.code ?? 'unknown'}/${response?.msg ?? response?.message ?? 'unknown'}`
    )
  }
  return true
}

export const assertPartnerCodeImmutableRejected = (response) => {
  if (!matchesExpectedBusinessRejection(response, PARTNER_CODE_IMMUTABLE_REJECTION)) {
    throw new Error(
      `客商编码变更契约不符：expected code/message ${PARTNER_CODE_IMMUTABLE_CODE}/${PARTNER_CODE_IMMUTABLE_MESSAGE}, ` +
      `got ${response?.code ?? 'unknown'}/${response?.msg ?? response?.message ?? 'unknown'}`
    )
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

const partnerRoles = [
  ['customerEnabled', 'CUSTOMER'],
  ['supplierEnabled', 'SUPPLIER'],
  ['carrierEnabled', 'CARRIER']
]

const createOwnedPartnerFixture = async ({ api, caseRecord, suffix }) => {
  const payload = {
    name: `E2E双角色客商${suffix}`,
    shortName: 'E2E双角色',
    partnerKind: 'ORGANIZATION',
    taxNo: `E2E${suffix}`,
    status: 'ACTIVE',
    customerEnabled: true,
    supplierEnabled: true,
    carrierEnabled: true,
    remark: `PB034-002 owned fixture ${suffix}`
  }
  const fixture = {
    kind: 'base-partner-write',
    tag: suffix,
    status: 'creating',
    payload,
    retained: false
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]

  let partnerId
  try {
    partnerId = dataOf(await api.postBusiness('/base/partner/create', payload))
    if (!isStableId(partnerId)) throw new Error(`创建接口返回无效客商 ID：${JSON.stringify(partnerId)}`)
    fixture.partnerId = String(partnerId)
    const detail = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(partnerId)}`))
    if (!detail || String(detail.id) !== fixture.partnerId || detail.name !== payload.name ||
        detail.remark !== payload.remark) {
      throw new Error('PB034-002 专属客商所有权回读不匹配，拒绝继续修改')
    }
    const databaseRow = await runReadOnlySql(`
      SELECT id, partner_code, name, tax_no, customer_enabled, supplier_enabled, carrier_enabled
      FROM base_partner
      WHERE tenant_id=1 AND deleted=0 AND id='${fixture.partnerId}'
    `)
    if (!databaseRow.available || databaseRow.rows.length !== 1 ||
        databaseRow.rows[0][0] !== fixture.partnerId || databaseRow.rows[0][2] !== payload.name ||
        databaseRow.rows[0][3] !== payload.taxNo || !enabledFlag(databaseRow.rows[0][4]) ||
        !enabledFlag(databaseRow.rows[0][5]) || !enabledFlag(databaseRow.rows[0][6])) {
      throw new Error('PB034-002 专属客商未在 base_partner 单表唯一落库')
    }
    fixture.partnerCode = detail.partnerCode
    fixture.status = 'created'
    caseRecord.database = [...(caseRecord.database || []), {
      stage: 'partner-write-fixture',
      fixture: fixture.tag,
      partnerId: fixture.partnerId,
      partnerCode: fixture.partnerCode,
      taxNo: detail.taxNo,
      customerEnabled: detail.customerEnabled,
      supplierEnabled: detail.supplierEnabled,
      carrierEnabled: detail.carrierEnabled,
      basePartnerRows: databaseRow.rows
    }]
    caseRecord.evidence.push(
      `PB034-002 专属客商夹具 tag=${fixture.tag}; partnerId=${fixture.partnerId}; partnerCode=${fixture.partnerCode}; base_partner rows=1`
    )
    return { fixture, payload, partnerId: fixture.partnerId, detail }
  } catch (error) {
    if (isStableId(partnerId)) {
      fixture.status = 'retained-ownership-failure'
      fixture.retained = true
      caseRecord.notes.push(
        `PB034-002 专属夹具保留 partnerId=${partnerId}：所有权/单表证据未通过，未执行不安全清理`
      )
    }
    throw error
  }
}

const updateOwnedPartner = async (api, owned, changes) => {
  const before = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(owned.partnerId)}`))
  if (!before || String(before.id) !== owned.partnerId || before.name !== owned.payload.name ||
      before.remark !== owned.payload.remark) {
    throw new Error('PB034-002 专属客商所有权回读不匹配，拒绝更新')
  }
  await api.putBusiness('/base/partner/update', {
    ...partnerWriteBody(before),
    ...changes
  })
  const after = dataOf(await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(owned.partnerId)}`))
  return after
}

const cleanupOwnedPartner = async (api, caseRecord, owned) => {
  if (!owned?.partnerId) return
  const cleanupDetail = dataOf(await api.getBusiness(
    `/base/partner/get?id=${encodeURIComponent(owned.partnerId)}`
  ))
  if (!cleanupDetail || String(cleanupDetail.id) !== owned.partnerId ||
      cleanupDetail.name !== owned.payload.name || cleanupDetail.remark !== owned.payload.remark) {
    throw new Error('清理前未回读到自建客商的稳定 ID 或所有权标识')
  }
  await updateOwnedPartner(api, owned, {
    customerEnabled: true,
    supplierEnabled: false,
    carrierEnabled: false
  })
  await api.deleteBusiness(`/base/partner/delete?id=${encodeURIComponent(owned.partnerId)}`)
  const deleted = dataOf(await api.getBusiness(
    `/base/partner/get?id=${encodeURIComponent(owned.partnerId)}`
  ))
  if (deleted !== null) throw new Error('自建客商删除后仍可回读，清理未完成')
  owned.fixture.status = 'deleted'
  caseRecord.checks.push({
    name: '未产生业务引用的单角色客商可删除（用例自清理）',
    passed: true,
    details: `partnerId=${owned.partnerId}`
  })
}

export const PARTNER_CRM_ACTOR_PROFILE = 'CRM-BASE-002'

export const partnerCrmOwnerApi = (platformApi, crmApi, ownerUserId) => {
  if (!isStableId(ownerUserId)) throw new Error('BLOCKED: PB034 CRM 专属 owner 编号无效')
  const api = { ...platformApi }
  // Keep platform lifecycle access separate from the real SELF-scoped customer actor.
  for (const method of [
    'request', 'get', 'post', 'put', 'delete',
    'getBusiness', 'postBusiness', 'putBusiness', 'deleteBusiness'
  ]) {
    api[method] = (...args) => {
      const pathname = method === 'request' ? args[1] : args[0]
      const customerPath = typeof pathname === 'string' && pathname.startsWith('/crm/customer/')
      const client = customerPath ? crmApi : platformApi
      const verb = method === 'request' ? args[0] : method
      if (customerPath && pathname.split('?')[0] === '/crm/customer/create' &&
          ['POST', 'post', 'postBusiness'].includes(verb)) {
        const body = method === 'request' ? args[2] : args[1]
        if (!isStableId(body?.ownerUserId) || String(body.ownerUserId) !== String(ownerUserId)) {
          throw new Error('BLOCKED: PB034 CRM 请求 owner 必须与实际专属执行人相同')
        }
      }
      if (typeof client[method] !== 'function') {
        throw new Error(`BLOCKED: PB034 CRM/平台客户端缺少 ${method}，不回退共享身份`)
      }
      return client[method](...args)
    }
  }
  return api
}

export const withPartnerCrmAcceptanceOwner = async (context, platformApi, run, dependencies = {}) => {
  if (context.caseId !== 'PB034-002' || typeof run !== 'function') {
    throw new Error('BLOCKED: PB034 CRM 专属 owner 只用于本案客商关联验收')
  }
  if (!(dependencies.writeFixturesEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true')) {
    throw new Error('BLOCKED: PB034 CRM 专属 owner 要求 CFOR_E2E_WRITE_FIXTURES=true')
  }
  // Reuse an existing customer CRUD profile without relabeling the actual acceptance case.
  const actorContext = {
    ...context,
    caseId: PARTNER_CRM_ACTOR_PROFILE,
    record: { ...context.record, selectedCases: [PARTNER_CRM_ACTOR_PROFILE] }
  }
  return (dependencies.withCrmAcceptanceActor || withCrmAcceptanceActor)(
    actorContext, platformApi,
    async (_actorContext, crmApi, ownerUserId) => {
      const api = partnerCrmOwnerApi(platformApi, crmApi, ownerUserId)
      context.caseRecord.evidence.push(
        `PB034-002 CRM 请求与实际 owner 使用同一专属 SELF 身份 userId=${ownerUserId}; ` +
        `既有权限配置=${PARTNER_CRM_ACTOR_PROFILE}`
      )
      return run({ api, crmOwnerUserId: String(ownerUserId) })
    },
    dependencies.actorDependencies || {}
  )
}

const runPartnerCase = async (context, { token, api, crmOwnerUserId }) => {
  const { caseId, page, record, caseRecord, outputDir } = context
  caseRecord.notes.push(
    'PB-034：客户、供应商、承运商收敛为 base_partner 单表，角色用 customer_enabled/supplier_enabled/carrier_enabled 表达，稳定客商编码创建后不可修改。'
  )

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

    // Exercise all three roles on the same owned partner before removing the fixture.
    const suffix = unique('E2E')
    let owned
    try {
      owned = await createOwnedPartnerFixture({ api, caseRecord, suffix })
      const { partnerId } = owned
      let detail = owned.detail
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
      }, { expectedBusinessRejection: PARTNER_CODE_IMMUTABLE_REJECTION })
      assertPartnerCodeImmutableRejected(codeRejection)
      const unchanged = dataOf(await api.getBusiness(`/base/partner/get?id=${partnerId}`))
      caseRecord.checks.push({
        name: '稳定客商编码创建后不可修改',
        passed: unchanged?.partnerCode === detail.partnerCode && unchanged?.taxNo === detail.taxNo,
        details: `code=${codeRejection.code}, partnerCode=${unchanged?.partnerCode}, taxNo=${unchanged?.taxNo}`
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
        `/base/partner/delete?id=${encodeURIComponent(partnerId)}`,
        undefined,
        { expectedBusinessRejection: PARTNER_ROLE_DELETE_REJECTION }
      )
      assertPartnerRoleDeleteRejected(deleteResponse)
      const afterRejectedDelete = dataOf(await api.getBusiness(`/base/partner/get?id=${partnerId}`))
      caseRecord.checks.push({
        name: '已启用多个角色的客商禁止删除',
        passed: String(afterRejectedDelete?.id) === String(partnerId) &&
          afterRejectedDelete.name === detail.name &&
          afterRejectedDelete.partnerCode === detail.partnerCode &&
          partnerRoles.every(([field]) => afterRejectedDelete[field] === true),
        details: `HTTP 成功且业务拒绝 code=${deleteResponse.code}; partnerId=${partnerId}`
      })

      for (const [selectedRole] of partnerRoles) {
        const roleFlags = Object.fromEntries(partnerRoles.map(([field]) => [field, field === selectedRole]))
        const singleRole = await updateOwnedPartner(api, owned, roleFlags)
        caseRecord.checks.push({
          name: `专属客商切换为 ${selectedRole} 单角色后回读开关`,
          passed: partnerRoles.every(([field]) => singleRole?.[field] === roleFlags[field]),
          details: JSON.stringify(roleFlags)
        })
        for (const [field, roleType] of partnerRoles) {
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
      if (owned?.partnerId) {
        try {
          await cleanupOwnedPartner(api, caseRecord, owned)
        } catch (error) {
          owned.fixture.status = 'cleanup-failed'
          owned.fixture.retained = true
          caseRecord.notes.push(`PB034-002 清理失败 partnerId=${owned.partnerId}: ${error.message}`)
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
        name: crmName, ownerUserId: crmOwnerUserId, remark: crmName
      }))
      if (!isStableId(crmId)) throw new Error('CRM 创建接口未返回稳定编号')
      const crmDetail = dataOf(await api.getBusiness(`/crm/customer/get?id=${crmId}`))
      const linkage = await runReadOnlySql(`
        SELECT c.partner_id, p.name, p.customer_enabled, CAST(c.owner_user_id AS CHAR), c.creator
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
          crmPartner.customerEnabled === true && linkage.rows[0][1] === crmName &&
          String(crmDetail.ownerUserId) === crmOwnerUserId &&
          linkage.rows[0][3] === crmOwnerUserId && linkage.rows[0][4] === crmOwnerUserId,
        details: `crmId=${crmId}, partnerId=${crmPartnerId}, owner/creator=${crmOwnerUserId}`
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
        const crmCleanup = await runReadOnlySql(`
          SELECT c.deleted, p.deleted, p.customer_enabled
          FROM crm_customer c LEFT JOIN base_partner p ON p.id=c.partner_id
          WHERE c.id='${crmId}' AND c.tenant_id=1
        `)
        const cleanupRow = crmCleanup.rows?.[0]
        const crmDeleted = cleanupRow && enabledFlag(cleanupRow[0])
        const partnerDeleted = cleanupRow && enabledFlag(cleanupRow[1])
        const retainedPartnerRoleClosed = cleanupRow && !enabledFlag(cleanupRow[2])
        caseRecord.checks.push({
          name: 'CRM 自建客户删除后经营关系与统一客商主体同步清理',
          passed: deletedPartner === null && crmCleanup.available && crmCleanup.rows.length === 1 &&
            crmDeleted && (partnerDeleted || retainedPartnerRoleClosed),
          details: `crmId=${crmId}, partnerId=${crmPartnerId}, cleanup=${JSON.stringify(crmCleanup.rows)}`
        })
      }
    }

    // PB-034 第四批：旧 ERP 客户/供应商接口已切换到统一客商，旧表退役为只读视图
    const legacySuffix = unique('LEGACY')
    const legacyCode = `LEGACY${legacySuffix}`
    let legacyCustomerId
    try {
      legacyCustomerId = dataOf(await api.postBusiness('/erp/customer/create', {
        name: `E2E旧客户口径${legacySuffix}`,
        code: legacyCode,
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
        `/base/partner/page?pageNo=1&pageSize=100&keyword=${encodeURIComponent(legacyCode)}`
      ))
      const unifiedRows = partnerRows?.list || partnerRows?.records || []
      caseRecord.checks.push({
        name: '旧客户接口写入落到 base_partner（统一客商可见）',
        passed: unifiedRows.some((item) => String(item.id) === String(legacyCustomerId)),
        details: `partnerHits=${unifiedRows.length}`
      })

      const legacyPage = dataOf(await api.getBusiness(
        `/erp/customer/page?pageNo=1&pageSize=100&keyword=${encodeURIComponent(legacyCode)}`
      ))
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
          const legacyPartner = dataOf(await api.getBusiness(
            `/base/partner/get?id=${encodeURIComponent(legacyCustomerId)}`
          ))
          const legacyCleanup = await runReadOnlySql(`
            SELECT id, customer_enabled, supplier_enabled, carrier_enabled
            FROM base_partner
            WHERE id='${legacyCustomerId}' AND tenant_id=1 AND deleted=0
          `)
          const legacyDeleted = legacyPartner === null && legacyCleanup.available && legacyCleanup.rows.length === 0
          const legacyCustomerRoleClosed = legacyPartner?.customerEnabled === false &&
            legacyCleanup.available && legacyCleanup.rows.length === 1 && !enabledFlag(legacyCleanup.rows[0][1])
          if ((!legacyDeleted && !legacyCustomerRoleClosed) || !legacyCleanup.available) {
            throw new Error(`旧客户删除后未关闭统一客商客户角色：${JSON.stringify(legacyCleanup.rows)}`)
          }
          caseRecord.checks.push({
            name: '旧客户删除接口关闭统一客商客户角色（用例自清理）',
            passed: true,
            details: `legacyCustomerId=${legacyCustomerId}, outcome=${legacyDeleted ? '主体删除' : '客户角色关闭'}, base_partner=${JSON.stringify(legacyCleanup.rows)}`
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

    let crossTenantEvidence = false
    const pageEvidence = []
    if (process.env.CFOR_E2E_WRITE_FIXTURES === 'true') {
      await runPartnerIsolationEvidence({
        context,
        primaryApi: api,
        primaryOwnerId: crmOwnerUserId,
        verifyPage: async ({ page: tenantPage, api: tenantApi, partner, tenantId }) => {
          const tenantPermission = dataOf(await tenantApi.getPermissionInfo())
          const route = findMenuRouteByComponent(tenantPermission?.menus, 'base/partner/index')
          if (!route) throw new Error(`PB034-002 第二租户缺少客商页面菜单 tenantId=${tenantId}`)
          await openRoute(tenantPage, route, { readyText: '客商编码' })
          const detail = dataOf(await tenantApi.getBusiness(`/base/partner/get?id=${partner.id}`))
          const { rowText } = await queryOwnedPartnerInBrowser(tenantPage, partner)
          const headers = await tenantPage.locator('.el-table th').allInnerTexts()
          if (String(detail?.id) !== String(partner.id) ||
              detail?.partnerCode !== partner.partnerCode ||
              !headers.some((header) => header.trim() === '客商编码') ||
              !rowText.includes(partner.partnerCode)) {
            throw new Error(`PB034-002 页面/正式 API 未回读专属客商 tenantId=${tenantId}`)
          }
          await saveScreenshot(tenantPage, outputDir, `pb034-owned-partner-${tenantId}`, record)
          caseRecord.checks.push({
            name: `客商页面按专属编码查询且唯一正控制和三个角色展示完整 tenant=${tenantId}`,
            passed: true,
            details: `partnerId=${partner.id}; partnerCode=${partner.partnerCode}; route=${route}`
          })
          pageEvidence.push({ tenantId: String(tenantId), partnerId: String(partner.id), rowText })
        }
      })
      crossTenantEvidence = true
      caseRecord.checks.push({
        name: 'PB034 双租户客商真实页面唯一正控制展示完整',
        passed: pageEvidence.length === 2 && new Set(pageEvidence.map((row) => row.tenantId)).size === 2 &&
          pageEvidence.some((row) => row.tenantId === '1'),
        details: pageEvidence.map((row) => `tenant=${row.tenantId}; partner=${row.partnerId}; ${row.rowText}`).join('; ')
      })
    } else {
      caseRecord.notes.push('未启用 CFOR_E2E_WRITE_FIXTURES=true；PB034-002 第二租户真实隔离证据保留 GAP。')
    }

    caseRecord.evidence.push(
      '统一客商单表 CRUD、双角色开关、编码不可修改、多角色删除保护，以及旧 ERP 客户接口写统一客商、旧表只读视图回读的真实接口验证'
    )
    const boundary = partnerAcceptanceBoundary({
      backendRevalidated:
        caseRecord.database?.some((item) => item.stage === 'partner-write-fixture') === true &&
        caseRecord.checks.some((check) => check.name === 'CRM 创建客户正式回读并通过 partner_id 关联唯一 base_partner 客户角色') &&
        caseRecord.checks.some((check) => check.name === '旧客户接口写入落到 base_partner（统一客商可见）'),
      crossTenantEvidence
    })
    // The dedicated actor cleanup runs after this callback; finalize its evidence in runCase.
    caseRecord.notes.push(
      `PB034-002 验收边界：${boundary.acceptanceComplete ? '可完整验收' : '保持 PARTIAL'}；` +
      (boundary.blockers.length ? boundary.blockers.join('；') : '无剩余阻断')
    )
    return {
      token,
      api,
      partial: !boundary.acceptanceComplete,
      acceptanceComplete: boundary.acceptanceComplete,
      note: boundary.blockers.join('；')
    }
  }

  return { designed: true }
}

export const runCase = async (context) => {
  if (context.caseId !== 'PB034-002') return { designed: true }
  if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
    throw new Error('BLOCKED: PB034-002 写侧验收要求 CFOR_E2E_WRITE_FIXTURES=true')
  }
  await assertLocalWriteSafety(context.caseRecord)
  const token = await login(context.page)
  const platformApi = createApiClient({ token, record: context.record })
  const result = await withPartnerCrmAcceptanceOwner(context, platformApi,
    ({ api, crmOwnerUserId }) => runPartnerCase(context, { token, api, crmOwnerUserId }))
  const complete = recordPartnerCatalogEvidence(context.caseRecord)
  return { ...result, partial: result.partial || !complete, acceptanceComplete: complete }
}
