import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiClient, serverApiFailures } from '../lib/api.mjs'
import {
  QUALITY_PERMISSION_FORBIDDEN,
  verifyQualityNgTypePermissionRejections
} from '../fixtures/quality-permission-account.mjs'

const basePath = '/mes/quality-ng-type'
const ngTypeId = '2108306777804595202'
const itemId = '2108306779004595203'
const otherNgTypeId = '2108306777804595204'
const permission = 'erp:settle-method-rule:query'
const expectedRequests = [
  ['POST', `${basePath}/create`],
  ['PUT', `${basePath}/update`],
  ['DELETE', `${basePath}/delete?id=${ngTypeId}`],
  ['GET', `${basePath}/get?id=${ngTypeId}`],
  ['GET', `${basePath}/page?pageNo=1&pageSize=100`],
  ['GET', `${basePath}/export-excel?pageNo=1&pageSize=100`],
  ['GET', `${basePath}/item-relations?itemId=${itemId}`],
  ['PUT', `${basePath}/item-relations`]
]
const forbidden = () => ({ code: 403, msg: '没有该操作权限', data: null })

function harness(options = {}) {
  const calls = []
  const record = { api: [], screenshots: [] }
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const row = {
    id: ngTypeId, code: 'E2E-Q-PERM-OWNED', name: 'owned NG type', status: 0,
    operationType: 'repair,rework', defectType: 'appearance', defectLevel: 2,
    parentId: null, responsibleDomain: 'QUALITY', defaultHandleMethod: 'REWORK', sortOrder: 7
  }
  const state = {
    row: structuredClone(row), relations: [ngTypeId, otherNgTypeId],
    pageUrl: 'about:blank', user: null, role: null, password: null,
    token: 'private-reader-token', negatives: 0, masterReads: 0,
    deactivateCalls: 0, closeCalls: 0
  }
  const ok = (data) => options.legacy
    ? { code: 200, success: true, data } : { code: 0, data }
  const adminApi = {
    async getBusiness(pathname) {
      calls.push({ kind: 'admin-read', pathname })
      if (pathname === `${basePath}/get?id=${ngTypeId}`) {
        state.masterReads++
        if (options.failAfterRead && state.masterReads > 1) throw new Error('unit after-read failure')
        return ok(state.row)
      }
      if (pathname === `${basePath}/item-relations?itemId=${itemId}`) {
        return ok(state.masterReads > 1 && options.reorderRelations
          ? [...state.relations].reverse() : state.relations)
      }
      if (pathname.startsWith(`${basePath}/page?`)) {
        state.probeCode = new URL(`http://unit.invalid${pathname}`).searchParams.get('code')
        const list = state.probeExists
          ? [{ id: '2108306777804595205', code: state.probeCode, name: 'unauthorized create' }] : []
        return ok(options.badPage || { list, total: list.length })
      }
      if (pathname === '/system/menu/list') return ok([
        { id: '10', parentId: '0', permission: '' },
        { id: '11', parentId: '10', permission: options.permission || permission }
      ])
      if (pathname === '/system/menu/list-all-simple') return ok([{ id: '10' }, { id: '11' }])
      if (pathname === '/system/user/get?id=102') {
        if (options.failUserRead) throw new Error('unit disabled-user read failure')
        return ok({ ...state.user, ...(options.badDisabledUser || {}) })
      }
      assert.fail(`Unmocked admin read ${pathname}`)
    },
    async postBusiness(pathname, body) {
      calls.push({ kind: 'admin-write', pathname, body: structuredClone(body) })
      if (pathname === '/system/role/create') {
        state.role = { ...body, id: '101' }
        return ok('101')
      }
      if (pathname === '/system/permission/assign-role-menu') {
        assert.equal(body.roleId, '101')
        assert.deepEqual(body.menuIds, ['11', '10'])
        return ok(true)
      }
      if (pathname === '/system/user/create') {
        state.password = body.password
        state.user = { id: '102', username: body.username, status: 0 }
        return ok('102')
      }
      if (pathname === '/system/permission/assign-user-role') {
        assert.deepEqual(body, { userId: '102', roleIds: ['101'] })
        return ok(true)
      }
      assert.fail(`Unmocked admin write ${pathname}`)
    },
    async putBusiness(pathname, body) {
      calls.push({ kind: 'deactivate', pathname, body })
      assert.equal(pathname, '/system/user/update-status')
      assert.deepEqual(body, { id: '102', status: 1 })
      state.deactivateCalls++
      if (options.failDeactivate) {
        throw new Error(`unit deactivate failure ${state.password} ${state.token}`)
      }
      state.user.status = 1
      return ok(true)
    },
    async deleteBusiness() {
      assert.fail('Successful account setup must retain its read-only audit role')
    }
  }
  const info = () => ({
    user: { id: '102', username: options.wrongUsername ? 'admin' : state.user.username },
    permissions: options.permissions ?? [options.permission || permission]
  })
  const readerApi = {
    async getBusiness(pathname) {
      calls.push({ kind: 'permission', pathname })
      assert.equal(pathname, '/system/auth/get-permission-info')
      if (options.failAt === 'permission') throw new Error('unit permission-read failure')
      return ok(info())
    },
    async request(method, pathname, body, requestOptions) {
      calls.push({ kind: 'negative', method, pathname, body: structuredClone(body), requestOptions })
      const index = state.negatives++
      if (options.failAt === 'request') throw new Error('unit negative transport failure')
      if (options.mutation === 'create' && index === 0) state.probeExists = true
      if (options.mutation === 'update' && index === 1) state.row.name = 'unauthorized update'
      if (options.mutation === 'delete' && index === 2) state.row = null
      if (options.mutation === 'relations' && index === 7) state.relations = [otherNgTypeId]
      return index === (options.responseAt ?? 0) && options.response !== undefined
        ? options.response : forbidden()
    }
  }
  const dependencies = {
    async launchBrowser(launchOptions) {
      calls.push({ kind: 'launch', options: launchOptions })
      assert.equal(launchOptions.record, record)
      if (options.failAt === 'launch') throw new Error('unit launch failure')
      if (options.sharedPage) state.pageUrl = 'http://unit.invalid/index'
      return {
        page: { url: () => state.pageUrl },
        browser: {
          async close() {
            calls.push({ kind: 'close' })
            state.closeCalls++
            if (options.failClose) throw new Error('unit close failure')
          }
        }
      }
    },
    async loginWithCredentials(page, credentials) {
      calls.push({ kind: 'login' })
      assert.equal(page.url(), 'about:blank')
      assert.equal(credentials.username, state.user.username)
      assert.equal(credentials.password, state.password)
      if (options.failAt === 'login') {
        throw new Error(`unit login failure ${state.password} ${state.token}`)
      }
      state.pageUrl = 'http://unit.invalid/index'
      return state.token
    },
    createApiClient(clientOptions) {
      calls.push({ kind: 'client' })
      assert.equal(clientOptions.token, state.token)
      assert.equal(clientOptions.record, record)
      return options.realApi ? createApiClient(clientOptions) : readerApi
    },
    async saveScreenshot(page, directory, name, report) {
      calls.push({ kind: 'screenshot', directory, name })
      assert.equal(page.url(), 'http://unit.invalid/index')
      assert.equal(report, record)
      if (options.failAt === 'screenshot') throw new Error('unit screenshot failure')
      const file = `${directory}/${name}.png`
      report.screenshots.push({ file })
      return file
    }
  }
  const input = {
    adminApi, record, caseRecord, outputDir: '/unit-evidence',
    ngType: { id: ngTypeId, row }, itemId, headed: true,
    ...(options.permission ? { permission: options.permission } : {})
  }
  return {
    calls, record, caseRecord, state, input, dependencies, info, ok,
    run: () => verifyQualityNgTypePermissionRejections(input, dependencies)
  }
}

test('uses the existing account creator, one isolated login and eight exact 403 probes', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(result.verified, true)
  assert.equal(result.results.length, 8)
  assert.deepEqual(result.unchanged, {
    ngType: true, relations: true, createProbeAbsent: true
  })
  const negatives = h.calls.filter((call) => call.kind === 'negative')
  assert.deepEqual(negatives.map(({ method, pathname }) => [method, pathname]), expectedRequests)
  assert.ok(negatives.every((call) => call.requestOptions === undefined))
  assert.ok(negatives[0].body.code.startsWith('E2E-Q-PERM-'))
  assert.ok(negatives[0].body.name.length <= 32)
  assert.equal(negatives[0].body.id, undefined)
  assert.equal(negatives[1].body.id, ngTypeId)
  assert.notEqual(negatives[1].body.name, h.input.ngType.row.name)
  assert.deepEqual(negatives[7].body, { itemId, ngTypeIds: [otherNgTypeId] })
  assert.deepEqual(negatives.slice(2, 7).map((call) => call.body), Array(5).fill(undefined))
  for (const kind of ['launch', 'login', 'client', 'permission', 'screenshot']) {
    assert.equal(h.calls.filter((call) => call.kind === kind).length, 1)
  }
  assert.equal(h.calls.find((call) => call.kind === 'launch').options.headed, true)
  assert.ok(h.calls.findIndex((call) => call.kind === 'permission') <
    h.calls.findIndex((call) => call.kind === 'negative'))
  assert.ok(h.calls.filter((call) => call.kind === 'admin-write')
    .every((call) => call.pathname.startsWith('/system/')))
  assert.equal(h.state.deactivateCalls, 1)
  assert.equal(h.state.closeCalls, 1)
  assert.equal(h.state.user.status, 1)
  assert.ok(h.state.role)
  assert.deepEqual(h.caseRecord.accounts[0], {
    userId: '102', username: h.state.user.username, roleId: '101',
    menuIds: ['11', '10'], permission
  })
  assert.ok(h.caseRecord.checks.every((entry) => entry.passed))
  const report = JSON.stringify({ result, record: h.record, caseRecord: h.caseRecord })
  assert.ok(!report.includes(h.state.password))
  assert.ok(!report.includes(h.state.token))
  assert.doesNotMatch(report, /requestBody|credentials|Authorization/)
})

test('supports Result200 success envelopes and a matching message-field denial', async () => {
  const h = harness({ legacy: true, response: {
    code: 403, success: false, message: QUALITY_PERMISSION_FORBIDDEN.message, data: null
  } })
  assert.equal((await h.run()).verified, true)
})

test('allows another explicitly selected non-quality query permission', async () => {
  const h = harness({ permission: 'erp:purchase-order:query' })
  assert.equal((await h.run()).verified, true)
  assert.equal(h.caseRecord.accounts[0].permission, 'erp:purchase-order:query')
})

test('snapshots are cloned and relation ordering alone is not a mutation', async () => {
  const h = harness({ reorderRelations: true })
  h.input.outputDir = undefined
  assert.equal((await h.run()).verified, true)
  assert.equal(h.calls.filter((call) => call.kind === 'screenshot').length, 0)
})

test('blocks admin identity, missing permissions and all quality or wildcard grants before probes', async () => {
  const settings = [
    { wrongUsername: true },
    { permissions: null },
    { permissions: [] },
    ...['*:*:*', '*', 'mes:*', 'mes:quality-ng-type:*',
      'mes:quality-ng-type:query', 'mes:quality-ng-type:create',
      'mes:quality-ng-type:update', 'mes:quality-ng-type:delete',
      'mes:quality-ng-type:export', 'mes:quality:item:query']
      .map((value) => ({ permissions: [permission, value] }))
  ]
  for (const options of settings) {
    const h = harness(options)
    if (options.permissions === null) h.info = () => ({ user: {}, permissions: null })
    if (options.permissions === null) {
      h.dependencies.createApiClient = () => ({
        getBusiness: async () => h.ok({ user: { username: h.state.user.username }, permissions: null })
      })
    }
    await assert.rejects(h.run(), /真实身份或权限/)
    assert.equal(h.state.negatives, 0)
    assert.equal(h.state.deactivateCalls, 1)
    assert.equal(h.state.closeCalls, 1)
  }
})

test('rejects a reused browser page and still closes it and deactivates the account', async () => {
  const h = harness({ sharedPage: true })
  await assert.rejects(h.run(), /全新隔离浏览器/)
  assert.equal(h.calls.filter((call) => call.kind === 'login').length, 0)
  assert.equal(h.state.negatives, 0)
  assert.equal(h.state.deactivateCalls, 1)
  assert.equal(h.state.closeCalls, 1)
})

test('only a non-success 403 with the exact permission message and no data passes', async () => {
  for (const response of [
    undefined, null, {}, { code: '403', msg: '没有该操作权限' },
    { code: 0, msg: '没有该操作权限' },
    { code: 200, success: true, msg: '没有该操作权限' },
    { code: 401, msg: '没有该操作权限' },
    { code: 500, msg: '系统异常' },
    { code: 503, msg: '服务不可用' },
    { code: 403, success: true, msg: '没有该操作权限' },
    { code: 403, ok: true, msg: '没有该操作权限' },
    { code: 403, msg: '其他业务拒绝' },
    { code: 403, msg: '没有该操作权限', message: '系统异常' },
    { code: 403, msg: '没有该操作权限', data: { id: ngTypeId } },
    { code: 403, msg: '没有该操作权限', data: [] }
  ]) {
    const h = harness({ response })
    // Explicit undefined is distinct from the harness's default response.
    if (response === undefined) {
      h.dependencies.createApiClient = () => ({
        getBusiness: async () => h.ok(h.info()),
        request: async () => undefined
      })
    }
    const result = await h.run()
    assert.equal(result.verified, false)
    assert.equal(result.results[0].passed, false)
    assert.equal(h.state.deactivateCalls, 1)
    assert.equal(h.state.closeCalls, 1)
  }
})

test('each of the eight endpoints independently requires the exact 403', async () => {
  for (let responseAt = 0; responseAt < 8; responseAt++) {
    const h = harness({ responseAt, response: { code: 400, msg: '参数错误' } })
    const result = await h.run()
    assert.equal(result.verified, false)
    assert.deepEqual(result.results.map((row) => row.passed),
      expectedRequests.map((_, index) => index !== responseAt))
  }
})

for (const mutation of ['create', 'update', 'delete', 'relations']) {
  test(`even eight exact 403 responses cannot hide unauthorized ${mutation}`, async () => {
    const h = harness({ mutation })
    const result = await h.run()
    assert.equal(result.verified, false)
    assert.ok(result.results.every((row) => row.passed))
    assert.equal(result.unchanged[mutation === 'create' ? 'createProbeAbsent'
      : mutation === 'relations' ? 'relations' : 'ngType'], false)
    assert.equal(h.state.deactivateCalls, 1)
    assert.equal(h.state.closeCalls, 1)
    assert.equal(h.input.ngType.row.name, 'owned NG type')
  })
}

test('the relation write actually adds the NG type when it was not already related', async () => {
  const h = harness()
  h.state.relations = [otherNgTypeId]
  assert.equal((await h.run()).verified, true)
  assert.deepEqual(h.calls.find((call) => call.kind === 'negative' &&
    call.method === 'PUT' && call.pathname.endsWith('/item-relations')).body,
  { itemId, ngTypeIds: [otherNgTypeId, ngTypeId] })
})

test('invalid ownership, IDs or requested write/quality permissions cannot create an account', async () => {
  for (const patch of [
    { ngType: { id: ngTypeId, row: { id: ngTypeId, code: 'SHARED' } } },
    { ngType: { id: ngTypeId, row: { id: '1', code: 'E2E-Q-OWNED' } } },
    { itemId: 'not-an-id' },
    { permission: 'mes:quality-ng-type:query' },
    { permission: '*:*:*' },
    { permission: 'erp:settle-method-rule:update' }
  ]) {
    const h = harness()
    Object.assign(h.input, patch)
    await assert.rejects(h.run(), /BLOCKED:/)
    assert.equal(h.calls.length, 0)
  }
})

test('invalid or truncated baseline pages abort before account creation', async () => {
  for (const badPage of [
    null, {}, { list: [], total: 1 }, { list: [], total: '0' },
    { list: [{ code: null }], total: 1 }
  ]) {
    const h = harness({ badPage })
    if (badPage === null) {
      const get = h.input.adminApi.getBusiness
      h.input.adminApi.getBusiness = (path) => path.startsWith(`${basePath}/page?`)
        ? Promise.resolve(h.ok(null)) : get(path)
    }
    await assert.rejects(h.run(), /创建探针分页/)
    assert.equal(h.calls.filter((call) => call.kind === 'admin-write').length, 0)
    assert.equal(h.calls.filter((call) => call.kind === 'launch').length, 0)
  }
})

test('all operational failures run finally cleanup without exposing credentials', async () => {
  for (const failAt of ['launch', 'login', 'permission', 'request', 'screenshot']) {
    const h = harness({ failAt })
    await assert.rejects(h.run(), (error) => {
      assert.match(error.message, /unit .* failure/)
      assert.ok(!error.message.includes(h.state.password))
      assert.ok(!error.message.includes(h.state.token))
      return true
    })
    assert.equal(h.state.deactivateCalls, 1)
    assert.equal(h.state.closeCalls, failAt === 'launch' ? 0 : 1)
    assert.equal(h.state.user.status, 1)
    const report = JSON.stringify({ record: h.record, caseRecord: h.caseRecord })
    assert.ok(!report.includes(h.state.password))
    assert.ok(!report.includes(h.state.token))
  }
})

test('deactivation and browser-close failures are reported independently without masking the original error', async () => {
  const h = harness({ failAt: 'login', failDeactivate: true, failClose: true })
  await assert.rejects(h.run(), (error) => {
    assert.match(error.message, /unit login failure/)
    assert.match(error.message, /停用账号失败/)
    assert.match(error.message, /关闭浏览器失败/)
    assert.ok(!error.message.includes(h.state.password))
    assert.ok(!error.message.includes(h.state.token))
    return true
  })
  assert.equal(h.state.deactivateCalls, 1)
  assert.equal(h.state.closeCalls, 1)
  assert.ok(h.caseRecord.checks.some((entry) => !entry.passed))
})

test('an admin after-read failure still deactivates the reader and closes its browser', async () => {
  const h = harness({ failAfterRead: true })
  await assert.rejects(h.run(), /管理员回读失败/)
  assert.equal(h.state.deactivateCalls, 1)
  assert.equal(h.state.closeCalls, 1)
})

test('cleanup verifies the disabled account identity and status rather than trusting a success response', async () => {
  for (const options of [
    { failUserRead: true },
    { badDisabledUser: { status: 0 } },
    { badDisabledUser: { id: '1' } },
    { badDisabledUser: { username: 'admin' } }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run(), /停用账号失败/)
    assert.equal(h.state.deactivateCalls, 1)
    assert.equal(h.state.closeCalls, 1)
  }
})

test('real API recording never records user-create request passwords or authorization headers', async (t) => {
  const record = { api: [] }
  const password = 'private-user-password'
  const token = 'private-admin-token'
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).password, password)
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    return new Response(JSON.stringify({ code: 0, data: '102' }), { status: 200 })
  })
  await createApiClient({ token, record }).postBusiness('/system/user/create', {
    username: 'unit-reader', password
  })
  assert.equal(record.api.length, 1)
  assert.deepEqual(Object.keys(record.api[0]).sort(),
    ['bodySummary', 'code', 'method', 'pathname', 'status'])
  assert.ok(!JSON.stringify(record).includes(password))
  assert.ok(!JSON.stringify(record).includes(token))
})

test('real API service failures are not marked as expected or turned into permission evidence', async (t) => {
  const h = harness({ realApi: true })
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname.replace('/admin-api', '')
    const response = path === '/system/auth/get-permission-info'
      ? h.ok(h.info()) : { code: 500, msg: '系统异常' }
    return new Response(JSON.stringify(response), { status: 200 })
  })
  const result = await h.run()
  assert.equal(result.verified, false)
  assert.ok(result.results.every((row) => !row.passed))
  assert.equal(serverApiFailures(h.record.api).length, 8)
  assert.ok(h.record.api.every((entry) => !entry.expectedBusinessRejectionMatched))
})

for (const failure of ['http500', 'network', 'response-body']) {
  test(`real API ${failure} cannot count as a 403 and cleanup still runs`, async (t) => {
    const h = harness({ realApi: true })
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(url).pathname.endsWith('/system/auth/get-permission-info')) {
        return new Response(JSON.stringify(h.ok(h.info())), { status: 200 })
      }
      if (failure === 'network') throw new Error('unit network failure')
      if (failure === 'response-body') {
        return { status: 200, text: async () => { throw new Error('unit body read failure') } }
      }
      return new Response(JSON.stringify(forbidden()), { status: 500 })
    })
    await assert.rejects(h.run(), /HTTP 500|unit (network|body read) failure/)
    assert.equal(serverApiFailures(h.record.api).length, 1)
    assert.equal(h.state.deactivateCalls, 1)
    assert.equal(h.state.closeCalls, 1)
  })
}
