import { randomBytes } from 'node:crypto'

import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { observePage } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { extractAccessToken, resolveLoginContext } from '../lib/session.mjs'
import { assertSafeScope } from './init-gaps.mjs'
import {
  dataOf, numericId, retireProcurementIsolationTenant, withProcurementTenant
} from './procurement-tenant-isolation.mjs'

export const PARTNER_NOT_EXISTS = Object.freeze({ code: 1001003000, message: '公共客商不存在' })
export const CRM_CUSTOMER_NOT_EXISTS = Object.freeze({ code: 1020006000, message: '客户不存在' })
export const PARTNER_ISOLATION_PERMISSIONS = Object.freeze([
  'base:partner:query', 'base:partner:create', 'base:partner:update', 'base:partner:delete',
  'crm:customer:query', 'crm:customer:create', 'crm:customer:update', 'crm:customer:delete'
])
const components = [
  'system/tenant-workbench/index', 'system/user/index', 'system/role/index',
  'system/dept/index', 'system/enterprise-organization/index', 'system/systemInit/index',
  'base/partner/index'
]
const requireFact = (value, message) => {
  if (!value) throw new Error(`PB034-002: ${message}`)
}
const id = (value) => numericId(value, 'PB034 ID')
const quote = (value) => {
  requireFact(typeof value === 'string' && /^[A-Za-z0-9 _:-]+$/.test(value), 'unsafe marker')
  return `'${value}'`
}
const merge = (errors) => {
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, errors.map((error) => error.message).join('; '))
}
const flatten = (rows) => (Array.isArray(rows) ? rows : [])
  .flatMap((row) => [row, ...flatten(row.children)])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (record, name, passed, details) => {
  record.checks.push({ name, passed: passed === true, details })
  requireFact(passed === true, name)
}

export async function readPartnerEvidenceDb (caseRecord, stage, sql) {
  const result = await runReadOnlySql(sql)
  requireFact(result.available && Array.isArray(result.rows), `read-only SQL unavailable: ${stage}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, rows: result.rows }]
  return result.rows
}

export function assertExactPartnerRejection (payload, contract) {
  requireFact(payload?.code === contract.code && payload.msg === contract.message &&
    Object.hasOwn(payload, 'data') && payload.data === null && payload.success !== true,
  `expected code/msg/data=null ${contract.code}/${contract.message}, got ${JSON.stringify(payload)}`)
  return true
}

export function partnerIsolationRows (payload) {
  requireFact(payload?.code === 0 && payload.success !== false, 'page business failure')
  const rows = payload?.data?.list ?? payload?.data?.records
  requireFact(Array.isArray(rows) && Number.isSafeInteger(Number(payload.data.total)) &&
    Number(payload.data.total) >= rows.length && rows.every((row) => {
      try { id(row.id); return true } catch { return false }
    }), 'malformed page, total or IDs')
  return rows
}

export function buildPartnerIsolationPackage ({ standardPackage, menus, assignableMenus }) {
  requireFact(String(standardPackage?.id) === '111' && standardPackage.status === 0 &&
    Array.isArray(standardPackage.menuIds), 'enabled package 111 required')
  const allowed = new Set(standardPackage.menuIds.map(id))
  const rows = flatten(menus)
  const byId = new Map(rows.map((row) => [id(row.id), row]))
  requireFact(byId.size === rows.length, 'duplicate source menu IDs')
  const assignable = new Set(flatten(assignableMenus).map((row) => id(row.id)))
  const requested = [
    ...components.map((component) => rows.find((row) => row.component === component)),
    ...PARTNER_ISOLATION_PERMISSIONS.map((permission) => rows.find((row) => row.permission === permission))
  ]
  requireFact(requested.every(Boolean), 'partner isolation menus/permissions missing')
  const selected = new Set()
  for (let row of requested) {
    const seen = new Set()
    while (row) {
      const key = id(row.id)
      requireFact(!seen.has(key) && allowed.has(key) && assignable.has(key) &&
        row.status === 0 && Number(row.deleted ?? 0) === 0, `unassignable menu/parent: ${key}`)
      seen.add(key)
      selected.add(key)
      if (String(row.parentId) === '0') break
      row = byId.get(id(row.parentId))
      requireFact(row, 'missing menu parent')
    }
  }
  return { menuIds: [...selected] }
}

export async function captureOwnedPartnerSnapshot ({ api, tenantId, partnerId, readDb, caseRecord, stage }) {
  const tenant = id(tenantId)
  const partner = id(partnerId)
  return {
    api: await api.getBusiness(`/base/partner/get?id=${partner}`),
    database: await readDb(caseRecord, stage,
      `SELECT * FROM base_partner WHERE tenant_id=${tenant} AND id=${partner} ORDER BY id`)
  }
}

const pairSpec = (tenantId, marker, ownerUserId) => ({
  tenantId: id(tenantId), ownerUserId: id(ownerUserId),
  partnerPayload: {
    name: `PB034 PARTNER ${marker} ${tenantId}`, partnerCode: `PB034${marker}`,
    taxNo: `PB034TAX${marker}`, remark: `PB034 OWNED ${marker} ${tenantId}`,
    partnerKind: 'ORGANIZATION', status: 'ACTIVE',
    customerEnabled: true, supplierEnabled: true, carrierEnabled: true
  },
  crmPayload: { name: `PB034 CRM ${marker} ${tenantId}`,
    remark: `PB034 CRM ${marker} ${tenantId}`, ownerUserId: id(ownerUserId) },
  partnerAttempted: false, crmAttempted: false
})

async function recoverPair (pair, readDb, caseRecord) {
  if (pair.partnerAttempted) {
    const rows = await readDb(caseRecord, 'partner-isolation-owned-partner', `
      SELECT CAST(id AS CHAR),name,remark FROM base_partner
      WHERE tenant_id=${pair.tenantId} AND deleted=0
      AND name=${quote(pair.partnerPayload.name)} AND remark=${quote(pair.partnerPayload.remark)}`)
    requireFact(rows.length <= 1, 'ambiguous owned partner')
    if (rows.length) {
      const found = id(rows[0][0])
      requireFact(!pair.partnerId || pair.partnerId === found, 'owned partner ID changed')
      pair.partnerId = found
    }
  }
  if (pair.crmAttempted) {
    const rows = await readDb(caseRecord, 'partner-isolation-owned-crm', `
      SELECT CAST(c.id AS CHAR),CAST(c.partner_id AS CHAR),c.name,c.remark,p.name,p.remark
      FROM crm_customer c LEFT JOIN base_partner p ON p.id=c.partner_id AND p.tenant_id=c.tenant_id
      WHERE c.tenant_id=${pair.tenantId} AND c.deleted=0 AND c.name=${quote(pair.crmPayload.name)}
      AND c.remark=${quote(pair.crmPayload.remark)}`)
    requireFact(rows.length <= 1, 'ambiguous owned CRM customer')
    if (rows.length) {
      const found = id(rows[0][0])
      requireFact((!pair.crmId || pair.crmId === found) && rows[0][2] === pair.crmPayload.name &&
        rows[0][3] === pair.crmPayload.remark && rows[0][4] === pair.crmPayload.name &&
        rows[0][5] === pair.crmPayload.remark, 'CRM/partner ownership mismatch')
      pair.crmId = found
      pair.crmPartnerId = id(rows[0][1])
    }
  }
}

async function createPair (api, pair, readDb, caseRecord) {
  const preflight = await readDb(caseRecord, 'partner-isolation-business-preflight', `
    SELECT 'partner',COUNT(*) FROM base_partner WHERE tenant_id=${pair.tenantId}
      AND (name=${quote(pair.partnerPayload.name)} OR remark=${quote(pair.partnerPayload.remark)})
    UNION ALL SELECT 'crm',COUNT(*) FROM crm_customer WHERE tenant_id=${pair.tenantId}
      AND (name=${quote(pair.crmPayload.name)} OR remark=${quote(pair.crmPayload.remark)})`)
  requireFact(preflight.length === 2 && preflight.every((row) => row[1] === '0') &&
    new Set(preflight.map((row) => row[0])).size === 2, 'business marker already exists')
  pair.partnerAttempted = true
  pair.partnerId = id(dataOf(await api.postBusiness('/base/partner/create', pair.partnerPayload)))
  await recoverPair(pair, readDb, caseRecord)
  pair.partner = dataOf(await api.getBusiness(`/base/partner/get?id=${pair.partnerId}`))
  requireFact(String(pair.partner?.id) === pair.partnerId && pair.partner.name === pair.partnerPayload.name &&
    pair.partner.remark === pair.partnerPayload.remark && pair.partner.partnerCode === pair.partnerPayload.partnerCode &&
    pair.partner.taxNo === pair.partnerPayload.taxNo &&
    ['customerEnabled', 'supplierEnabled', 'carrierEnabled'].every((field) => pair.partner[field] === true),
  'created partner API/SQL ownership or roles mismatch')
  pair.crmAttempted = true
  pair.crmId = id(dataOf(await api.postBusiness('/crm/customer/create', pair.crmPayload)))
  await recoverPair(pair, readDb, caseRecord)
  pair.crm = dataOf(await api.getBusiness(`/crm/customer/get?id=${pair.crmId}`))
  pair.crmPartner = dataOf(await api.getBusiness(`/base/partner/get?id=${pair.crmPartnerId}`))
  requireFact(String(pair.crm?.id) === pair.crmId && pair.crm.name === pair.crmPayload.name &&
    pair.crm.remark === pair.crmPayload.remark && pair.crmPartner?.name === pair.crmPayload.name &&
    pair.crmPartner.remark === pair.crmPayload.remark && pair.crmPartner.customerEnabled === true,
  'created CRM customer did not link its owned base_partner')
}

async function cleanupPair (api, pair, readDb, caseRecord) {
  const errors = []
  const attempt = async (operation) => {
    try { await operation() } catch (error) { errors.push(error) }
  }
  await attempt(() => recoverPair(pair, readDb, caseRecord))
  if (pair.crmId && pair.crmPartnerId) await attempt(async () => {
    const detail = dataOf(await api.getBusiness(`/crm/customer/get?id=${pair.crmId}`))
    requireFact(String(detail?.id) === pair.crmId && detail.name === pair.crmPayload.name &&
      detail.remark === pair.crmPayload.remark, 'CRM cleanup ownership mismatch')
    await api.deleteBusiness(`/crm/customer/delete?id=${pair.crmId}`)
    const response = await api.get(`/crm/customer/get?id=${pair.crmId}`,
      { expectedBusinessRejection: CRM_CUSTOMER_NOT_EXISTS })
    assertExactPartnerRejection(response, CRM_CUSTOMER_NOT_EXISTS)
    const rows = await readDb(caseRecord, 'partner-isolation-crm-cleanup', `
      SELECT 'crm',COUNT(*) FROM crm_customer WHERE tenant_id=${pair.tenantId} AND id=${pair.crmId} AND deleted=0
      UNION ALL SELECT 'partner',COUNT(*) FROM base_partner
        WHERE tenant_id=${pair.tenantId} AND id=${pair.crmPartnerId} AND deleted=0
      UNION ALL SELECT 'permission',COUNT(*) FROM crm_permission
        WHERE tenant_id=${pair.tenantId} AND biz_type=2 AND biz_id=${pair.crmId} AND deleted=0`)
    requireFact(rows.length === 3 && new Set(rows.map((row) => row[0])).size === 3 &&
      rows.every((row) => row[1] === '0'), 'CRM business/partner/permission cleanup incomplete')
  })
  if (pair.partnerId) await attempt(async () => {
    const detail = dataOf(await api.getBusiness(`/base/partner/get?id=${pair.partnerId}`))
    requireFact(String(detail?.id) === pair.partnerId && detail.name === pair.partnerPayload.name &&
      detail.remark === pair.partnerPayload.remark, 'partner cleanup ownership mismatch')
    await api.putBusiness('/base/partner/update', {
      ...pair.partnerPayload, id: pair.partnerId, supplierEnabled: false, carrierEnabled: false
    })
    await api.deleteBusiness(`/base/partner/delete?id=${pair.partnerId}`)
    const returned = await api.getBusiness(`/base/partner/get?id=${pair.partnerId}`)
    const rows = await readDb(caseRecord, 'partner-isolation-partner-cleanup', `
      SELECT COUNT(*) FROM base_partner WHERE tenant_id=${pair.tenantId} AND id=${pair.partnerId} AND deleted=0`)
    requireFact(returned?.data === null && rows.length === 1 && rows[0][0] === '0', 'partner cleanup incomplete')
  })
  if (errors.length) throw merge(errors)
}

export async function capturePartnerPairSnapshot ({ api, pair, readDb, caseRecord, stage }) {
  const partnerIds = [id(pair.partnerId), id(pair.crmPartnerId)].join(',')
  const crmId = id(pair.crmId)
  const apiSnapshot = {
    partner: await api.getBusiness(`/base/partner/get?id=${pair.partnerId}`),
    crm: await api.getBusiness(`/crm/customer/get?id=${crmId}`),
    crmPartner: await api.getBusiness(`/base/partner/get?id=${pair.crmPartnerId}`)
  }
  const database = {}
  for (const [table, where] of [
    ['base_partner', `id IN (${partnerIds})`],
    ['crm_customer', `id=${crmId}`],
    ['crm_permission', `biz_type=2 AND biz_id=${crmId}`],
    ['erp_customer', `id IN (${partnerIds})`],
    ['erp_supplier', `id IN (${partnerIds})`]
  ]) {
    database[table] = await readDb(caseRecord, `${stage}-${table}`,
      `SELECT * FROM ${table} WHERE tenant_id=${id(pair.tenantId)} AND ${where} ORDER BY id`)
  }
  return { api: apiSnapshot, database }
}

export async function verifyPartnerIsolationDirection ({
  actorApi, ownerApi, actor, owner, readDb, caseRecord, label
}) {
  const partnerPage = `/base/partner/page?pageNo=1&pageSize=100&keyword=${encodeURIComponent(owner.partner.partnerCode)}`
  // Same codes across tenants require a positive control, not an empty-page assertion.
  const ownPage = partnerIsolationRows(await actorApi.getBusiness(partnerPage))
  requireFact(ownPage.length === 1 && String(ownPage[0].id) === actor.partnerId &&
    ownPage[0].taxNo === actor.partnerPayload.taxNo, 'same-code page lacks own positive control or leaks foreign ID')
  for (const roleType of ['CUSTOMER', 'SUPPLIER', 'CARRIER']) {
    const payload = await actorApi.getBusiness(`/base/partner/simple-list?roleType=${roleType}`)
    requireFact(payload?.code === 0 && Array.isArray(payload.data) &&
      payload.data.some((row) => String(row.id) === actor.partnerId) &&
      !payload.data.some((row) => [owner.partnerId, owner.crmPartnerId].includes(String(row.id))),
    `role ${roleType} lacks own control or leaks foreign partner`)
  }
  const ownCrm = partnerIsolationRows(await actorApi.getBusiness(
    `/crm/customer/page?pageNo=1&pageSize=100&sceneType=1&name=${encodeURIComponent(actor.crmPayload.name)}`))
  const foreignCrm = partnerIsolationRows(await actorApi.getBusiness(
    `/crm/customer/page?pageNo=1&pageSize=100&sceneType=1&name=${encodeURIComponent(owner.crmPayload.name)}`))
  requireFact(ownCrm.length === 1 && String(ownCrm[0].id) === actor.crmId && foreignCrm.length === 0,
    'CRM page isolation lacks own positive control')
  const operations = [
    ['partner-get', () => actorApi.get(`/base/partner/get?id=${owner.partnerId}`), null],
    ['crm-get', () => actorApi.get(`/crm/customer/get?id=${owner.crmId}`,
      { expectedBusinessRejection: CRM_CUSTOMER_NOT_EXISTS }), CRM_CUSTOMER_NOT_EXISTS],
    ['partner-update', () => actorApi.put('/base/partner/update', {
      ...actor.partnerPayload, id: owner.partnerId, name: `${actor.partnerPayload.name} DENIED`
    }, { expectedBusinessRejection: PARTNER_NOT_EXISTS }), PARTNER_NOT_EXISTS],
    ['partner-delete', () => actorApi.delete(`/base/partner/delete?id=${owner.partnerId}`,
      { expectedBusinessRejection: PARTNER_NOT_EXISTS }), PARTNER_NOT_EXISTS],
    ['crm-update', () => actorApi.put('/crm/customer/update', {
      ...actor.crmPayload, id: owner.crmId, name: `${actor.crmPayload.name} DENIED`
    }, { expectedBusinessRejection: CRM_CUSTOMER_NOT_EXISTS }), CRM_CUSTOMER_NOT_EXISTS],
    ['crm-delete', () => actorApi.delete(`/crm/customer/delete?id=${owner.crmId}`,
      { expectedBusinessRejection: CRM_CUSTOMER_NOT_EXISTS }), CRM_CUSTOMER_NOT_EXISTS]
  ]
  for (const [operation, run, contract] of operations) {
    const snapshots = async (stage) => ({
      actor: await capturePartnerPairSnapshot({ api: actorApi, pair: actor, readDb, caseRecord, stage: `${label}-${operation}-${stage}-actor` }),
      owner: await capturePartnerPairSnapshot({ api: ownerApi, pair: owner, readDb, caseRecord, stage: `${label}-${operation}-${stage}-owner` })
    })
    const before = await snapshots('before')
    const payload = await run()
    if (contract) assertExactPartnerRejection(payload, contract)
    else requireFact(payload?.code === 0 && payload.msg === '' && payload.data === null &&
      Object.hasOwn(payload, 'data') && payload.success !== false, 'foreign partner GET must return exact success/null')
    const after = await snapshots('after')
    check(caseRecord, `PB034 ${label} ${operation} 精确契约且双方完整快照不变`,
      same(before, after), `actorTenant=${actor.tenantId}; ownerTenant=${owner.tenantId}; code=${payload.code}; data=null`)
    caseRecord.partnerIsolationSnapshots = [...(caseRecord.partnerIsolationSnapshots || []),
      { label, operation, before, rejection: payload, after }]
  }
  check(caseRecord, `PB034 ${label} 分页与角色列表双向隔离含自身正控制`, true,
    `ownPartner=${actor.partnerId}; ownCrm=${actor.crmId}; foreignPartner=${owner.partnerId}`)
}

/**
 * Use procurement's existing session/retirement contracts without modifying them.
 * Add lost-response recovery, login-token capture and verified account retirement.
 */
export async function runPartnerIsolationEvidence ({
  context, primaryApi, primaryOwnerId, verifyPage, dependencies = {}
}) {
  assertSafeScope(dependencies.config || config)
  requireFact(dependencies.writeFixturesEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true',
    'BLOCKED: local write fixtures must be explicitly enabled')
  const { caseRecord } = context
  const readDb = dependencies.readDb || readPartnerEvidenceDb
  const apiFactory = dependencies.createApiClient || createApiClient
  const withTenant = dependencies.withTenant || withProcurementTenant
  const retire = dependencies.retireTenant || retireProcurementIsolationTenant
  const marker = randomBytes(8).toString('hex')
  const fixture = {
    packagePayload: { name: `E2E PB034 PKG ${marker}`, status: 0, remark: `PB034 ${marker}` },
    tenantPayload: { name: `E2E PB034 TEN ${marker}`, contactName: 'CFOR E2E PB034',
      contactMobile: '19900000000', status: 0, expireTime: '2099-12-31T23:59:59',
      accountCount: 1, username: `e2epb034${marker}`, password: `Part!${randomBytes(5).toString('hex')}` }
  }
  const errors = []
  const pendingTokens = new Map()
  const loggedOutTokens = new Set()
  const tokenReads = []
  let packageAttempted = false
  let tenantAttempted = false
  let primary
  let secondary
  let completed = false
  let businessError
  const attempt = async (operation) => {
    try { await operation() } catch (error) { errors.push(error) }
  }
  const loadOwners = async () => {
    if (packageAttempted) {
      const rows = await readDb(caseRecord, 'partner-isolation-package-owner',
        `SELECT CAST(id AS CHAR),name FROM system_tenant_package WHERE name=${quote(fixture.packagePayload.name)} AND deleted=0`)
      requireFact(rows.length <= 1, 'ambiguous private package')
      if (rows.length) {
        const found = id(rows[0][0])
        requireFact(found !== '111' && (!fixture.packageId || fixture.packageId === found), 'private package ID changed')
        fixture.packageId = found
      }
    }
    if (tenantAttempted && fixture.packageId) {
      const rows = await readDb(caseRecord, 'partner-isolation-tenant-owner', `
        SELECT CAST(id AS CHAR),name,CAST(package_id AS CHAR),CAST(contact_user_id AS CHAR)
        FROM system_tenant WHERE name=${quote(fixture.tenantPayload.name)} AND deleted=0`)
      requireFact(rows.length <= 1, 'ambiguous private tenant')
      if (rows.length) {
        const found = id(rows[0][0])
        requireFact(found !== '1' && rows[0][2] === fixture.packageId &&
          (!fixture.tenantId || fixture.tenantId === found), 'private tenant ownership mismatch')
        fixture.tenantId = found
        fixture.userId = id(rows[0][3])
        const users = await readDb(caseRecord, 'partner-isolation-user-owner', `
          SELECT CAST(id AS CHAR),username FROM system_users WHERE tenant_id=${found} AND deleted=0`)
        requireFact(users.length === 1 && users[0][0] === fixture.userId &&
          users[0][1] === fixture.tenantPayload.username, 'private administrator ownership mismatch')
      }
    }
  }
  const remember = (auth) => {
    if (typeof auth?.token === 'string' && auth.token) {
      pendingTokens.set(auth.token, /^[1-9]\d*$/.test(String(auth.tenantId)) ? String(auth.tenantId) : fixture.tenantId)
    }
  }
  try {
    const permissionInfo = dataOf(await primaryApi.getBusiness('/system/auth/get-permission-info'))
    requireFact(Array.isArray(permissionInfo?.roles) && permissionInfo.roles.includes('super_admin'),
      'BLOCKED: private account retirement requires the current platform super_admin')
    const standardPackage = dataOf(await primaryApi.getBusiness('/system/tenant-package/get?id=111'))
    const menus = dataOf(await primaryApi.getBusiness('/system/menu/list'))
    const assignableMenus = dataOf(await primaryApi.getBusiness('/system/menu/list-all-simple'))
    Object.assign(fixture.packagePayload, buildPartnerIsolationPackage({ standardPackage, menus, assignableMenus }))
    const absent = await readDb(caseRecord, 'partner-isolation-lifecycle-preflight', `
      SELECT 'package',COUNT(*) FROM system_tenant_package WHERE name=${quote(fixture.packagePayload.name)}
      UNION ALL SELECT 'tenant',COUNT(*) FROM system_tenant WHERE name=${quote(fixture.tenantPayload.name)}
      UNION ALL SELECT 'user',COUNT(*) FROM system_users WHERE username=${quote(fixture.tenantPayload.username)}`)
    requireFact(absent.length === 3 && new Set(absent.map((row) => row[0])).size === 3 &&
      absent.every((row) => row[1] === '0'), 'lifecycle marker already exists')
    packageAttempted = true
    const createdPackage = id(dataOf(await primaryApi.postBusiness('/system/tenant-package/create', fixture.packagePayload)))
    await loadOwners()
    requireFact(createdPackage === fixture.packageId, 'package response/SQL mismatch')
    fixture.tenantPayload.packageId = fixture.packageId
    tenantAttempted = true
    const createdTenant = id(dataOf(await primaryApi.postBusiness('/system/tenant/create', fixture.tenantPayload)))
    await loadOwners()
    requireFact(createdTenant === fixture.tenantId, 'tenant response/SQL mismatch')
    fixture.tenant = { id: fixture.tenantId, name: fixture.tenantPayload.name,
      username: fixture.tenantPayload.username, password: fixture.tenantPayload.password }
    caseRecord.fixtures = [...(caseRecord.fixtures || []),
      { kind: 'partner-isolation', marker, tenantId: fixture.tenantId,
        packageId: fixture.packageId, userId: fixture.userId }]
    primary = pairSpec('1', marker, primaryOwnerId)
    await createPair(primaryApi, primary, readDb, caseRecord)
    await withTenant(context, fixture.tenant, async ({ api: secondaryApi, auth, page }) => {
      requireFact(id(auth.tenantId) === fixture.tenantId, 'isolated login tenant mismatch')
      const info = dataOf(await secondaryApi.getBusiness('/system/auth/get-permission-info'))
      requireFact(id(info?.user?.id) === fixture.userId && Array.isArray(info.permissions) &&
        PARTNER_ISOLATION_PERMISSIONS.every((permission) => info.permissions.includes(permission)),
      'isolated user or CRUD permission mismatch')
      secondary = pairSpec(fixture.tenantId, marker, fixture.userId)
      let sessionError
      try {
        await createPair(secondaryApi, secondary, readDb, caseRecord)
        await verifyPartnerIsolationDirection({ actorApi: secondaryApi, ownerApi: primaryApi,
          actor: secondary, owner: primary, readDb, caseRecord, label: '第二租户到tenant1' })
        await verifyPartnerIsolationDirection({ actorApi: primaryApi, ownerApi: secondaryApi,
          actor: primary, owner: secondary, readDb, caseRecord, label: 'tenant1到第二租户' })
        await verifyPage({ page: context.page, api: primaryApi, partner: primary.partner, tenantId: '1' })
        await verifyPage({ page, api: secondaryApi, partner: secondary.partner, tenantId: fixture.tenantId })
        check(caseRecord, 'PB034 双租户实际菜单页面刷新回读专属客商', true,
          `tenant1=${primary.partnerId}; secondTenant=${fixture.tenantId}/${secondary.partnerId}`)
        completed = true
      } catch (error) {
        sessionError = error
      } finally {
        await attempt(() => cleanupPair(secondaryApi, secondary, readDb, caseRecord))
      }
      if (sessionError) throw sessionError
    }, {
      ...dependencies,
      observePage (page, record) {
        const capture = (dependencies.observePage || observePage)(page, record)
        const listener = (response) => {
          if (!/\/system\/auth\/(?:login-encrypted|refresh-token)(?:\?|$)/.test(response.url()) ||
              response.request().method() !== 'POST') return
          tokenReads.push((async () => {
            const text = await response.text()
            const payload = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
              ? decryptResponse(text) : JSON.parse(text)
            remember(resolveLoginContext(payload, payload?.data?.accessToken))
          })().catch(() => { errors.push(new Error('PB034 login token capture failed')) }))
        }
        page.on('response', listener)
        return { async flushResponses () {
          try {
            await capture.flushResponses()
            await Promise.all(tokenReads)
            const entries = await page.evaluate(() => [window.localStorage, window.sessionStorage]
              .flatMap((storage) => Array.from({ length: storage.length }, (_, index) => {
                const key = storage.key(index)
                return [key, storage.getItem(key)]
              })))
            const token = extractAccessToken(entries)
            if (token && !loggedOutTokens.has(token)) remember({ token, tenantId: fixture.tenantId })
          } finally { page.off('response', listener) }
        } }
      },
      createApiClient (auth) {
        remember(auth)
        const api = apiFactory(auth)
        return { ...api, async postBusiness (path, body, options) {
          const result = await api.postBusiness(path, body, options)
          if (path === '/system/auth/logout') {
            pendingTokens.delete(auth.token)
            loggedOutTokens.add(auth.token)
          }
          return result
        } }
      }
    })
  } catch (error) {
    businessError = error
  } finally {
    await attempt(async () => { await Promise.all(tokenReads) })
    if (primary) await attempt(() => cleanupPair(primaryApi, primary, readDb, caseRecord))
    if (packageAttempted || tenantAttempted) await attempt(loadOwners)
    for (const [token, tenantId] of pendingTokens) await attempt(async () => {
      requireFact(tenantId === fixture.tenantId, 'captured token tenant mismatch')
      await apiFactory({ token, tenantId, record: context.record }).postBusiness('/system/auth/logout')
    })
    if (fixture.tenantId && fixture.userId) {
      await attempt(async () => {
        const rows = await readDb(caseRecord, 'partner-isolation-token-zero', `
          SELECT 'access',COUNT(*) FROM system_oauth2_access_token
            WHERE tenant_id=${fixture.tenantId} AND user_id=${fixture.userId} AND deleted=0
          UNION ALL SELECT 'refresh',COUNT(*) FROM system_oauth2_refresh_token
            WHERE tenant_id=${fixture.tenantId} AND user_id=${fixture.userId} AND deleted=0`)
        requireFact(rows.length === 2 && new Set(rows.map((row) => row[0])).size === 2 &&
          rows.every((row) => row[1] === '0'), 'private tokens not zero')
      })
      await attempt(async () => {
        await loadOwners()
        const options = { headers: { 'visit-tenant-id': fixture.tenantId } }
        await primaryApi.putBusiness('/system/user/update-status', { id: fixture.userId, status: 1 }, options)
        const returned = dataOf(await primaryApi.getBusiness(`/system/user/get?id=${fixture.userId}`, options))
        const rows = await readDb(caseRecord, 'partner-isolation-user-retired', `
          SELECT CAST(id AS CHAR),username,CAST(status AS CHAR) FROM system_users
          WHERE tenant_id=${fixture.tenantId} AND id=${fixture.userId} AND deleted=0`)
        requireFact(String(returned?.id) === fixture.userId && returned.username === fixture.tenantPayload.username &&
          returned.status === 1 && rows.length === 1 && rows[0][0] === fixture.userId &&
          rows[0][1] === fixture.tenantPayload.username && rows[0][2] === '1', 'private user not retired')
      })
    }
    if (fixture.packageId) await attempt(async () => {
      const linked = await readDb(caseRecord, 'partner-isolation-package-references', `
        SELECT CAST(id AS CHAR),name FROM system_tenant WHERE package_id=${fixture.packageId} AND deleted=0`)
      requireFact(linked.length <= 1 && linked.every((row) =>
        row[0] === fixture.tenantId && row[1] === fixture.tenantPayload.name), 'unexpected private package references')
      const { username, password, ...tenantPayload } = fixture.tenantPayload
      if (fixture.tenantId) await retire(primaryApi, { ...fixture, tenantPayload })
      else await primaryApi.putBusiness('/system/tenant-package/update',
        { ...fixture.packagePayload, id: fixture.packageId, status: 1 })
      for (const [kind, resourceId, name] of [
        ['tenant-package', fixture.packageId, fixture.packagePayload.name],
        ...(fixture.tenantId ? [['tenant', fixture.tenantId, fixture.tenantPayload.name]] : [])
      ]) {
        const returned = dataOf(await primaryApi.getBusiness(`/system/${kind}/get?id=${resourceId}`))
        const table = kind === 'tenant' ? 'system_tenant' : 'system_tenant_package'
        const rows = await readDb(caseRecord, `partner-isolation-${kind}-retired`,
          `SELECT CAST(id AS CHAR),name,CAST(status AS CHAR) FROM ${table} WHERE id=${resourceId} AND deleted=0`)
        requireFact(String(returned?.id) === resourceId && returned.name === name && returned.status === 1 &&
          rows.length === 1 && rows[0][0] === resourceId && rows[0][1] === name && rows[0][2] === '1',
        `private ${kind} not retired`)
      }
    })
    caseRecord.checks.push({ name: 'PB034 隔离业务正式清理账号套餐租户停用且令牌zero',
      passed: errors.length === 0,
      details: `tenantId=${fixture.tenantId || 'not-created'}; businessCompleted=${completed}; ` +
        `businessErrors=${businessError ? 1 : 0}; lifecycleErrors=${errors.length}` })
  }
  const failures = [...(businessError ? [businessError] : []), ...errors]
  if (failures.length) throw merge(failures)
  return { executed: true, tenantId: fixture.tenantId }
}
