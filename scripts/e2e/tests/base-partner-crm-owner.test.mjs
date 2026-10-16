import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  PARTNER_CRM_ACTOR_PROFILE,
  partnerCrmOwnerApi,
  withPartnerCrmAcceptanceOwner
} from '../suites/base-partner.mjs'
import { crmActorRequirements } from '../fixtures/crm-acceptance-actor.mjs'
import {
  CRM_CUSTOMER_NOT_EXISTS,
  PARTNER_NOT_EXISTS,
  verifyPartnerIsolationDirection
} from '../fixtures/partner-isolation.mjs'

const originalFetch = globalThis.fetch
test.before(() => {
  globalThis.fetch = async () => { throw new Error('Unexpected real network request in PB034 unit tests') }
})
test.after(() => { globalThis.fetch = originalFetch })

const success = (data) => ({ code: 0, msg: '', data: structuredClone(data) })
const rejection = ({ code, message }) => ({ code, msg: message, data: null })
const customerQuota = { code: 1020006010, msg: '操作失败，超出客户数拥有上限', data: null }
const local = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台', headless: true,
  apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151'
}

function client (label, handle, calls) {
  const invoke = async (method, verb, pathname, body, options) => {
    calls.push({ label, method, verb, pathname, body, options })
    const response = await handle(verb, pathname, body, options)
    if (method.endsWith('Business') && response?.code !== 0) {
      throw new Error(`${pathname} business failure: ${JSON.stringify(response)}`)
    }
    return response
  }
  const api = {
    request: (verb, pathname, body, options) => invoke('request', verb, pathname, body, options)
  }
  for (const [method, verb] of [
    ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['delete', 'DELETE'],
    ['getBusiness', 'GET'], ['postBusiness', 'POST'],
    ['putBusiness', 'PUT'], ['deleteBusiness', 'DELETE']
  ]) {
    api[method] = (pathname, body, options) => ['GET', 'DELETE'].includes(verb)
      ? invoke(method, verb, pathname, undefined, body)
      : invoke(method, verb, pathname, body, options)
  }
  api.getPermissionInfo = () => api.getBusiness('/system/auth/get-permission-info')
  return api
}

function context () {
  const caseRecord = {
    id: 'PB034-002', caseId: 'PB034-002',
    checks: [], notes: [], evidence: [], fixtures: []
  }
  return {
    caseId: 'PB034-002', page: { platform: true }, caseRecord,
    record: { runId: 'pb034-unit', selectedCases: ['PB034-002'], cases: [caseRecord], api: [] }
  }
}

function actorHarness ({ customerResponse = success('103'), customerHandler, partnerHandler } = {}) {
  const calls = []
  const requirements = crmActorRequirements([PARTNER_CRM_ACTOR_PROFILE])
  const menus = [
    { id: '100', parentId: '0', status: 0, permission: '', path: 'business' },
    { id: '200', parentId: '0', status: 0, permission: 'system:settings:query', path: 'settings' },
    { id: '201', parentId: '200', status: 0, permission: '', path: 'crm' },
    ...requirements.permissions.map((permission, index) => ({
      id: String(101 + index), parentId: '100', status: 0, permission
    })),
    ...requirements.pageComponents.map((component, index) => ({
      id: String(300 + index), parentId: '201', status: 0, permission: '', component
    }))
  ]
  let roleCode
  let username
  let userStatus = 0
  const platformApi = client('platform', async (verb, pathname, body) => {
    if (pathname === '/system/menu/list') return success(menus)
    if (pathname === '/system/menu/list-all-simple') return success(menus.map(({ id }) => ({ id })))
    if (pathname.startsWith('/system/role/get')) return success({ id: '20', code: roleCode, dataScope: 5 })
    if (pathname.startsWith('/system/user/get')) return success({ id: '30', username, status: userStatus })
    if (pathname === '/system/role/create') { roleCode = body.code; return success('20') }
    if (pathname === '/system/user/create') { username = body.username; return success('30') }
    if (pathname.startsWith('/system/permission/assign-')) return success(true)
    if (pathname === '/system/user/update-status') { userStatus = body.status; return success(true) }
    if (pathname === '/system/auth/get-permission-info') {
      return success({ user: { id: '1' }, roles: ['super_admin'] })
    }
    if (pathname === '/crm/customer/create') return customerQuota
    if (partnerHandler && pathname.startsWith('/base/partner/')) return partnerHandler(verb, pathname, body)
    throw new Error(`Unexpected platform API: ${verb} ${pathname}`)
  }, calls)
  const actorApi = client('actor', async (verb, pathname, body) => {
    if (pathname === '/system/auth/get-permission-info') {
      return success({
        user: { id: '30', username }, roles: [roleCode],
        permissions: [...requirements.permissions, ...requirements.navPermissions]
      })
    }
    if (pathname === '/system/auth/logout') return success(true)
    if (customerHandler && pathname.startsWith('/crm/customer/')) return customerHandler(verb, pathname, body)
    if (pathname === '/crm/customer/create') {
      assert.equal(String(body.ownerUserId), '30')
      return customerResponse
    }
    throw new Error(`Unexpected actor API: ${verb} ${pathname}`)
  }, calls)
  const actorDependencies = {
    config: local,
    launchBrowser: async () => ({
      page: { actor: true }, context: {},
      flushResponses: async () => calls.push({ label: 'browser', method: 'flush' }),
      browser: { close: async () => calls.push({ label: 'browser', method: 'close' }) }
    }),
    loginWithCredentials: async (_page, credentials) => {
      assert.equal(credentials.username, username)
      return { token: 'fixture-private-token', tenantId: '1' }
    },
    createApiClient: () => actorApi
  }
  return {
    platformApi, actorApi, calls, menus,
    dependencies: { writeFixturesEnabled: true, actorDependencies }
  }
}

test('PB034 CRM create uses the real dedicated actor and preserves platform lifecycle identity', async () => {
  const h = actorHarness()
  const c = context()
  const selectedCases = [...c.record.selectedCases]
  const result = await withPartnerCrmAcceptanceOwner(c, h.platformApi, async ({ api, crmOwnerUserId }) => {
    assert.equal(crmOwnerUserId, '30')
    const permission = await api.getBusiness('/system/auth/get-permission-info')
    assert.deepEqual(permission.data.roles, ['super_admin'])
    return api.postBusiness('/crm/customer/create', { name: 'PB034 OWNED', ownerUserId: crmOwnerUserId })
  }, h.dependencies)
  assert.equal(result.data, '103')
  assert.equal(h.calls.filter((call) =>
    call.label === 'platform' && call.pathname === '/crm/customer/create').length, 0)
  assert.equal(h.calls.filter((call) =>
    call.label === 'actor' && call.pathname === '/crm/customer/create').length, 1)
  assert.deepEqual(c.record.selectedCases, selectedCases)
  assert.equal(c.caseRecord.id, 'PB034-002')
  assert.deepEqual(c.caseRecord.accounts[0].selectedCases, [PARTNER_CRM_ACTOR_PROFILE])
  assert.equal(c.caseRecord.accounts[0].dataScope, 5)
  assert(h.calls.some((call) => call.pathname === '/system/permission/assign-role-data-scope' &&
    call.body.dataScope === 5))
  assert(h.calls.some((call) => call.label === 'actor' && call.pathname === '/system/auth/logout'))
  assert(h.calls.some((call) => call.pathname === '/system/user/update-status' &&
    call.body.id === '30' && call.body.status === 1))
  assert(!h.calls.some((call) => /customer-limit-config|tenant-package|assign-user-role.*id=1/.test(call.pathname || '')))
  assert.doesNotMatch(JSON.stringify(c.caseRecord), /fixture-private-token|"password"/)
})

test('PB034 owner mismatch is blocked before either real client is called', () => {
  const calls = []
  const raw = client('unused', async () => success(true), calls)
  const api = partnerCrmOwnerApi(raw, raw, '30')
  for (const ownerUserId of ['1', '31', undefined, {}, 0]) {
    for (const method of ['post', 'postBusiness']) {
      assert.throws(() => api[method]('/crm/customer/create', { ownerUserId }), /owner 必须/)
    }
    assert.throws(() => api.request('POST', '/crm/customer/create', { ownerUserId }), /owner 必须/)
  }
  assert.throws(() => partnerCrmOwnerApi(raw, raw, 'not-an-id'), /owner 编号无效/)
  assert.equal(calls.length, 0)
})

test('PB034 customer rejection contracts and arguments are forwarded unchanged without admin fallback', async () => {
  const calls = []
  const platform = client('platform', async () => success(true), calls)
  const actor = client('actor', async () => rejection(CRM_CUSTOMER_NOT_EXISTS), calls)
  const api = partnerCrmOwnerApi(platform, actor, '30')
  const options = { expectedBusinessRejection: CRM_CUSTOMER_NOT_EXISTS }
  const body = { id: '203', ownerUserId: '30', name: 'DENIED' }
  assert.deepEqual(await api.get('/crm/customer/get?id=203', options), rejection(CRM_CUSTOMER_NOT_EXISTS))
  assert.deepEqual(await api.put('/crm/customer/update', body, options), rejection(CRM_CUSTOMER_NOT_EXISTS))
  assert.deepEqual(await api.delete('/crm/customer/delete?id=203', options), rejection(CRM_CUSTOMER_NOT_EXISTS))
  assert.deepEqual(await api.request('DELETE', '/crm/customer/delete?id=203', undefined, options),
    rejection(CRM_CUSTOMER_NOT_EXISTS))
  assert(calls.every((call) => call.label === 'actor' && call.options === options))
  assert.equal(calls[1].body, body)
  await assert.rejects(api.putBusiness('/crm/customer/update', body), /1020006000/)
  assert(calls.every((call) => call.label === 'actor'))
})

test('PB034 quota rejection remains a real failure and still retires the dedicated actor', async () => {
  const h = actorHarness({ customerResponse: customerQuota })
  const c = context()
  await assert.rejects(withPartnerCrmAcceptanceOwner(c, h.platformApi, ({ api, crmOwnerUserId }) =>
    api.postBusiness('/crm/customer/create', { name: 'PB034 OWNED', ownerUserId: crmOwnerUserId }),
  h.dependencies), /1020006010/)
  assert(!h.calls.some((call) => call.label === 'platform' && call.pathname.startsWith('/crm/')))
  assert(h.calls.some((call) => call.label === 'actor' && call.pathname === '/system/auth/logout'))
  assert(h.calls.some((call) => call.pathname === '/system/user/update-status' && call.body.status === 1))
})

test('PB034 missing package permission blocks before creating business data or any new role', async () => {
  const h = actorHarness()
  h.menus.find((row) => row.permission === 'crm:customer:update').status = 1
  let ran = false
  await assert.rejects(withPartnerCrmAcceptanceOwner(context(), h.platformApi, async () => {
    ran = true
  }, h.dependencies), /BLOCKED.*crm:customer:update/)
  assert.equal(ran, false)
  assert(!h.calls.some((call) => call.pathname === '/system/role/create' || call.pathname.startsWith('/crm/')))
})

test('PB034 dedicated owner preparation requires its own case and explicit write opt-in', async () => {
  let ran = false
  const dependencies = {
    writeFixturesEnabled: false,
    withCrmAcceptanceActor: async () => { ran = true }
  }
  await assert.rejects(withPartnerCrmAcceptanceOwner(context(), {}, async () => {}, dependencies),
    /CFOR_E2E_WRITE_FIXTURES=true/)
  await assert.rejects(withPartnerCrmAcceptanceOwner({ ...context(), caseId: 'PB034-001' },
    {}, async () => {}, { ...dependencies, writeFixturesEnabled: true }), /只用于本案/)
  assert.equal(ran, false)
})

function isolationPair (tenantId, prefix, ownerUserId) {
  const partnerPayload = {
    name: `PB034 PARTNER ${tenantId}`, partnerCode: 'PB034SAME', taxNo: 'PB034TAX',
    remark: `PB034 OWNED ${tenantId}`, customerEnabled: true, supplierEnabled: true, carrierEnabled: true
  }
  const crmPayload = { name: `PB034 CRM ${tenantId}`, remark: `PB034 CRM ${tenantId}`, ownerUserId }
  return {
    tenantId, partnerId: `${prefix}01`, crmPartnerId: `${prefix}02`, crmId: `${prefix}03`,
    partnerPayload, crmPayload,
    partner: { ...partnerPayload, id: `${prefix}01` },
    crm: { ...crmPayload, id: `${prefix}03`, partnerId: `${prefix}02` },
    crmPartner: { ...crmPayload, id: `${prefix}02`, customerEnabled: true }
  }
}

function isolationResponse (pair, verb, pathname, body) {
  const url = new URL(pathname, 'http://fixture.invalid')
  if (url.pathname === '/base/partner/page') return success({ list: [pair.partner], total: 1 })
  if (url.pathname === '/base/partner/simple-list') return success([pair.partner])
  if (url.pathname === '/crm/customer/page') {
    const list = url.searchParams.get('name') === pair.crmPayload.name ? [pair.crm] : []
    return success({ list, total: list.length })
  }
  const targetId = String(url.searchParams.get('id') || body?.id)
  if (url.pathname === '/base/partner/get') {
    return success([pair.partner, pair.crmPartner].find((row) => row.id === targetId) || null)
  }
  if (url.pathname === '/crm/customer/get') {
    return targetId === pair.crmId ? success(pair.crm) : rejection(CRM_CUSTOMER_NOT_EXISTS)
  }
  if (url.pathname.startsWith('/base/partner/') && ['PUT', 'DELETE'].includes(verb)) {
    return rejection(PARTNER_NOT_EXISTS)
  }
  if (url.pathname.startsWith('/crm/customer/') && ['PUT', 'DELETE'].includes(verb)) {
    return rejection(CRM_CUSTOMER_NOT_EXISTS)
  }
  throw new Error(`Unexpected isolation operation: ${verb} ${pathname}`)
}

test('PB034 existing isolation verifier retains both directions, own positive controls and unchanged facts', async () => {
  const primary = isolationPair('1', '1', '30')
  const secondary = isolationPair('2', '2', '90')
  const h = actorHarness({
    customerHandler: (...args) => isolationResponse(primary, ...args),
    partnerHandler: (...args) => isolationResponse(primary, ...args)
  })
  const secondaryCalls = []
  const secondaryApi = client('secondary', (...args) => isolationResponse(secondary, ...args), secondaryCalls)
  const c = context()
  const pairsBefore = structuredClone([primary, secondary])
  const readDb = async (_caseRecord, _stage, sql) => {
    const pair = sql.includes('tenant_id=1') ? primary : secondary
    return [[pair.tenantId, pair.partnerId, pair.crmId, pair.crmPartnerId, pair.crmPayload.ownerUserId]]
  }
  await withPartnerCrmAcceptanceOwner(c, h.platformApi, async ({ api, crmOwnerUserId }) => {
    assert.equal(primary.crmPayload.ownerUserId, crmOwnerUserId)
    await verifyPartnerIsolationDirection({
      actorApi: secondaryApi, ownerApi: api, actor: secondary, owner: primary,
      readDb, caseRecord: c.caseRecord, label: '第二租户到tenant1'
    })
    await verifyPartnerIsolationDirection({
      actorApi: api, ownerApi: secondaryApi, actor: primary, owner: secondary,
      readDb, caseRecord: c.caseRecord, label: 'tenant1到第二租户'
    })
  }, h.dependencies)
  assert.deepEqual([primary, secondary], pairsBefore)
  assert.equal(c.caseRecord.partnerIsolationSnapshots.length, 12)
  for (const snapshot of c.caseRecord.partnerIsolationSnapshots) {
    assert.deepEqual(snapshot.before, snapshot.after)
    assert.equal(snapshot.rejection.data, null)
  }
  assert.equal(c.caseRecord.checks.filter((check) =>
    check.name.includes('精确契约且双方完整快照不变') && check.passed).length, 12)
  assert.equal(c.caseRecord.checks.filter((check) =>
    check.name.includes('双向隔离含自身正控制') && check.passed).length, 2)
  assert(!h.calls.some((call) => call.label === 'platform' && call.pathname.startsWith('/crm/')))
  assert(secondaryCalls.some((call) => call.pathname === '/crm/customer/delete?id=103' &&
    call.options.expectedBusinessRejection === CRM_CUSTOMER_NOT_EXISTS))
})

test('PB034 exact cross-tenant refusal still fails if either owned fact changes', async () => {
  const primary = isolationPair('1', '1', '30')
  const secondary = isolationPair('2', '2', '90')
  const h = actorHarness({
    customerHandler: (...args) => isolationResponse(primary, ...args),
    partnerHandler: (...args) => isolationResponse(primary, ...args)
  })
  const secondaryApi = client('secondary', (verb, pathname, body) => {
    if (pathname === '/base/partner/get?id=101') primary.partner.taxNo = 'ILLEGAL CHANGE'
    return isolationResponse(secondary, verb, pathname, body)
  }, [])
  const c = context()
  const readDb = async (_caseRecord, _stage, sql) => {
    const pair = sql.includes('tenant_id=1') ? primary : secondary
    return [[JSON.stringify(pair)]]
  }
  await assert.rejects(withPartnerCrmAcceptanceOwner(c, h.platformApi, ({ api }) =>
    verifyPartnerIsolationDirection({
      actorApi: secondaryApi, ownerApi: api, actor: secondary, owner: primary,
      readDb, caseRecord: c.caseRecord, label: '第二租户到tenant1'
    }), h.dependencies), /精确契约且双方完整快照不变/)
  assert(c.caseRecord.checks.some((check) =>
    check.name.includes('partner-get 精确契约且双方完整快照不变') && check.passed === false))
  assert(h.calls.some((call) => call.pathname === '/system/user/update-status' && call.body.status === 1))
})

test('PB034 suite binds both CRM links and isolation owner to the dedicated actor without SQL owner selection', () => {
  const source = fs.readFileSync(new URL('../suites/base-partner.mjs', import.meta.url), 'utf8')
  assert.match(source, /primaryOwnerId: crmOwnerUserId/)
  assert.match(source, /name: crmName, ownerUserId: crmOwnerUserId, remark: crmName/)
  assert.match(source, /linkage\.rows\[0\]\[3\] === crmOwnerUserId && linkage\.rows\[0\]\[4\] === crmOwnerUserId/)
  assert.match(source, /runPartnerIsolationEvidence\(\{\s*context,/)
  assert.doesNotMatch(source, /resolveCrmOwnerUserId|crm_customer_limit_config|runLocalFixtureSql/)
})
