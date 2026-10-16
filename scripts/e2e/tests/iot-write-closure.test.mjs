import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IOT_CONTRACT_GAPS,
  IOT_MESSAGE_RUNTIME_CASES,
  IOT_PERMISSION_FORBIDDEN,
  IOT_TENANT_FORBIDDEN,
  IOT_WRITE_ASSERTIONS,
  assertIotMessageRuntimeEnabled,
  assertIotLocalTarget,
  createIotFixtureCleanup,
  createIotRuntimeStatusFixture,
  dataOf,
  finalizeIotCatalogAssertions,
  hasIotAlertTransferHandlingEvidence,
  hasIotDeadLetterDedupEvidence,
  initializeIotCatalogAssertions,
  isExactIotForbidden,
  markIotAssertion,
  pageOf,
  requireIotAnomalyEvidence,
  requireIotMessageEvidence,
  runIotAnomalyClosure,
  runIotSecurityE2e,
  sameIotRuntimeStatus,
  strictId,
  verifyIotPermissionRejections
} from '../fixtures/iot-write-closure.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { ENCRYPT_HEADER } from '../lib/crypto.mjs'

const record = (id = 'IOT-011') => ({
  id,
  caseId: id,
  checks: [],
  notes: [],
  evidence: []
})

const localRuntime = {
  target: 'local',
  tenantName: 'CFOR 标准平台',
  tenantId: '1',
  apiBase: 'http://127.0.0.1:48083',
  apiUrl: 'http://127.0.0.1:48083/admin-api',
  webBase: 'http://127.0.0.1:9151'
}

const identifier = 'e2e_009_signal'
const anomalyExpectations = [
  { type: 'DUPLICATE', sequenceNo: 9001, qualityCode: 0, value: 10 },
  { type: 'OUT_OF_ORDER', sequenceNo: 9003, qualityCode: 0, value: 21 },
  { type: 'QUALITY_CODE', sequenceNo: 9004, qualityCode: 7, value: 30 }
].map((expected) => ({ deviceId: '703', identifier, ...expected }))

const anomalyEvidence = (expected) => ({
  id: String(expected.sequenceNo),
  type: expected.type,
  deviceId: expected.deviceId,
  identifier: expected.identifier,
  sequenceNo: expected.sequenceNo,
  qualityCode: expected.qualityCode,
  idempotentKey:
    `d:${expected.deviceId}:m:thing.property.post:i:${expected.identifier}:s:${expected.sequenceNo}`,
  payload: JSON.stringify({ [expected.identifier]: expected.value }),
  status: 0
})

const simulateAnomalyApi = ({
  missingOutOfOrder = false,
  changeMessage = (row) => row,
  changeAnomaly = (row) => row
} = {}) => {
  const state = { sends: [], messages: [], anomalies: [], history: [], handled: [] }
  const success = (data) => ({ code: 0, data })
  const page = (list) => success({ list, total: list.length })
  const parseUrl = (path) => new URL(path, 'http://unit.invalid')
  const api = {
    async getBusiness (path) {
      const url = parseUrl(path)
      switch (url.pathname) {
        case '/iot/product-category/simple-list':
          return success([{ id: '11' }])
        case '/iot/product/get':
          return success(state.product)
        case '/iot/thing-model/get':
          return success(state.property)
        case '/iot/device/get':
          return success(state.device)
        case '/iot/device/message/page':
          assert.equal(url.searchParams.get('deviceId'), state.device.id)
          return page(state.messages.map((row) => changeMessage({ ...row })))
        case '/iot/device/property/history-list':
          assert.equal(url.searchParams.get('deviceId'), state.device.id)
          assert.equal(url.searchParams.get('identifier'), identifier)
          return success(state.history)
        case '/iot/data-anomaly/page':
          assert.equal(url.searchParams.get('deviceId'), state.device.id)
          return page(state.anomalies
            .filter((row) => row.type === url.searchParams.get('type'))
            .map((row) => changeAnomaly({ ...row })))
        case '/iot/data-anomaly/get':
          return success(state.anomalies.find((row) =>
            row.id === url.searchParams.get('id')))
        default:
          throw new Error(`Unexpected simulated GET ${path}`)
      }
    },
    async postBusiness (path, body) {
      switch (path) {
        case '/iot/product/create':
          state.product = { ...body, id: '701', productKey: 'unit-product', status: 0 }
          return success(state.product.id)
        case '/iot/thing-model/create':
          state.property = { ...body, id: '702' }
          return success(state.property.id)
        case '/iot/device/create':
          state.device = { ...body, id: '703' }
          return success(state.device.id)
        case '/iot/device/message/send': {
          assert.equal(body.method, 'thing.property.post')
          assert.equal(body.deviceId, state.device.id)
          assert.equal(body.preserveReportTime, true)
          assert.deepEqual(Object.keys(body.params), [identifier])
          state.sends.push(body)
          const duplicate = state.messages.some((row) =>
            row.sequenceNo === body.sequenceNo)
          if (!duplicate) {
            state.messages.push({
              deviceId: body.deviceId,
              identifier,
              sequenceNo: body.sequenceNo,
              qualityCode: body.qualityCode
            })
            state.history.push({ value: body.params[identifier] })
          }
          const type = duplicate ? 'DUPLICATE'
            : body.sequenceNo === 9003 ? 'OUT_OF_ORDER'
              : body.qualityCode !== 0 ? 'QUALITY_CODE' : null
          if (type && !(missingOutOfOrder && type === 'OUT_OF_ORDER')) {
            state.anomalies.push(anomalyEvidence({
              type,
              deviceId: body.deviceId,
              identifier,
              sequenceNo: body.sequenceNo,
              qualityCode: body.qualityCode,
              value: body.params[identifier]
            }))
          }
          return success(true)
        }
        default:
          throw new Error(`Unexpected simulated POST ${path}`)
      }
    },
    async putBusiness (path, body) {
      const url = parseUrl(path)
      if (url.pathname === '/iot/product/update-status') {
        state.product.status = Number(url.searchParams.get('status'))
        return success(true)
      }
      if (url.pathname === '/iot/data-anomaly/handle') {
        const anomaly = state.anomalies.find((row) => row.id === body.id)
        assert.ok(anomaly, 'Only simulated anomaly IDs may be handled')
        Object.assign(anomaly, {
          status: body.status,
          handleRemark: body.handleRemark,
          handleUserId: '99',
          handleTime: '2026-10-10T10:00:00'
        })
        state.handled.push(anomaly.id)
        return success(true)
      }
      throw new Error(`Unexpected simulated PUT ${path}`)
    },
    async request (method, path, body, options) {
      assert.equal(method, 'PUT')
      assert.equal(path, '/iot/data-anomaly/handle')
      assert.equal(state.anomalies.find((row) => row.id === body.id)?.status, 1)
      assert.equal(options.expectedBusinessRejection.code, 1050017001)
      return { code: 1050017001, msg: 'IoT 数据异常记录已处理' }
    }
  }
  return { api, state }
}

const runSimulatedAnomalyClosure = async (simulation, caseRecord) =>
  runIotAnomalyClosure({
    api: simulation.api,
    fixtures: createIotFixtureCleanup({ caseId: caseRecord.id, caseRecord }),
    caseRecord,
    waitOptions: { timeoutMs: 20, intervalMs: 1 }
  })

const runtimeStatusHarness = () => {
  const device = { id: '703', productId: '701', deviceName: 'E2E-IOT-013-OWNED' }
  const state = { device: { ...device }, active: null, event: null, writes: [] }
  const ok = (data) => ({ code: 0, data })
  const api = {
    async getBusiness (path) {
      if (path === '/iot/device/get?id=703') return ok(state.device)
      if (path === '/mes/device-status-event/active?deviceId=703&coreLayer=RUNTIME') return ok(state.active)
      if (path === '/mes/device-status-event/get?id=704') return ok(state.event)
      throw new Error(`Unexpected simulated GET ${path}`)
    },
    async postBusiness (path, body) {
      assert.equal(path, '/mes/device-status-event/start')
      state.writes.push(path)
      state.event = {
        ...body, id: '704', startTime: '2026-10-11T12:00:00',
        endTime: null, active: true, operatorId: '1'
      }
      state.active = structuredClone(state.event)
      return ok(state.event.id)
    },
    async putBusiness (path, body) {
      assert.equal(path, '/mes/device-status-event/end')
      assert.equal(body.id, state.event.id)
      assert.equal(body.reason, state.event.reason)
      state.writes.push(path)
      state.event = { ...state.event, endTime: '2026-10-11T12:01:00', active: false }
      state.active = null
      return ok(true)
    }
  }
  return { api, device, state }
}

test('IOT-013 creates a real scoped runtime fact and ends it while retaining audit', async () => {
  const { api, device, state } = runtimeStatusHarness()
  const caseRecord = record('IOT-013')
  const fixtures = createIotFixtureCleanup({ caseId: caseRecord.id, caseRecord })
  const event = await createIotRuntimeStatusFixture(api, fixtures, device)
  assert.equal(event.deviceId, device.id)
  assert.equal(event.coreLayer, 'RUNTIME')
  assert.equal(event.statusCode, 'RUNNING')
  assert.equal(sameIotRuntimeStatus(state.active, state.active, event), true)
  await fixtures.cleanup(false)
  assert.deepEqual(state.writes, ['/mes/device-status-event/start', '/mes/device-status-event/end'])
  assert.equal(state.active, null)
  assert.ok(state.event.endTime)
  assert.equal(caseRecord.checks.at(-1).name, 'MES 运行状态事件隔离夹具已保留')
  assert.equal(caseRecord.checks.at(-1).passed, true)
})

test('IOT-013 refuses foreign devices or existing runtime facts before creating any state', async () => {
  for (const mutate of [
    (h) => { h.state.device.deviceName = 'user-device' },
    (h) => { h.state.device.productId = '999' },
    (h) => { h.state.active = { id: 'old-runtime' } },
    (h) => { h.device.deviceName = 'user-device' }
  ]) {
    const h = runtimeStatusHarness()
    mutate(h)
    const caseRecord = record('IOT-013')
    await assert.rejects(createIotRuntimeStatusFixture(
      h.api, createIotFixtureCleanup({ caseId: caseRecord.id, caseRecord }), h.device
    ))
    assert.deepEqual(h.state.writes, [])
  }
})

test('IOT-013 runtime comparison rejects empty, ended, foreign or changed facts', () => {
  const fact = {
    id: '704', deviceId: '703', coreLayer: 'RUNTIME', statusCode: 'RUNNING',
    active: true, startTime: '2026-10-11T12:00:00', endTime: null
  }
  assert.equal(sameIotRuntimeStatus(fact, structuredClone(fact), fact), true)
  for (const after of [null, {}, { ...fact, id: '705' }, { ...fact, deviceId: '999' },
    { ...fact, active: false }, { ...fact, reason: 'changed' }]) {
    assert.equal(sameIotRuntimeStatus(fact, after, fact), false)
  }
  assert.equal(sameIotRuntimeStatus(null, null, null), false)
  assert.equal(sameIotRuntimeStatus({}, {}, {}), false)
  const ended = { ...fact, active: false, endTime: '2026-10-11T12:01:00' }
  assert.equal(sameIotRuntimeStatus(ended, ended, ended), false)
})

test('IOT-013 cleanup will not end another runtime event when ownership readback changes', async () => {
  const h = runtimeStatusHarness()
  const caseRecord = record('IOT-013')
  const fixtures = createIotFixtureCleanup({ caseId: caseRecord.id, caseRecord })
  await createIotRuntimeStatusFixture(h.api, fixtures, h.device)
  h.state.event = { ...h.state.event, reason: 'foreign-event' }
  await assert.rejects(fixtures.cleanup(false), /清理失败/)
  assert.deepEqual(h.state.writes, ['/mes/device-status-event/start'])
  assert.equal(caseRecord.checks.at(-1).passed, false)
})

const forbidden = (expected = IOT_PERMISSION_FORBIDDEN) =>
  ({ code: expected.code, msg: expected.message, data: null })

const permissionHarness = (options = {}) => {
  const caseRecord = record('IOT-002')
  initializeIotCatalogAssertions(caseRecord, 'IOT-002')
  const report = { api: [] }
  const calls = []
  const state = {
    device: {
      id: '703',
      productId: '701',
      deviceName: 'E2E-IOT-002-PERM-OWNED',
      assetStatus: 'ENABLED',
      state: 0,
      accessConfigVersion: 1,
      productModelSnapshot: '{"productId":"701","accessConfigVersion":1}'
    },
    user: null,
    role: null,
    roleIds: [],
    deviceReads: 0,
    deactivated: 0,
    negativeCount: 0,
    logoutCount: 0,
    token: 'unit-iot-private-token',
    refreshToken: 'unit-iot-private-refresh'
  }
  const ok = (data) => options.legacy ? { code: 200, success: true, data } : { code: 0, data }
  const adminApi = {
    async getBusiness (path) {
      calls.push({ kind: 'admin-read', path })
      if (path.startsWith('/system/tenant/get-id-by-name?')) return ok(options.tenantId ?? '1')
      if (path === '/iot/device/get?id=703') {
        state.deviceReads++
        if (options.failAfterRead && state.deviceReads > 1) throw new Error('unit device read failed')
        return ok(options.missingDevice ? null : state.device)
      }
      if (path === '/system/menu/list') return ok([
        { id: '10', parentId: '0', permission: '' },
        { id: '11', parentId: '10', permission: 'erp:settle-method-rule:query' }
      ])
      if (path === '/system/menu/list-all-simple') {
        return ok(options.noAssignableMenu ? [] : [{ id: '10' }, { id: '11' }])
      }
      if (path === '/system/user/get?id=802') {
        if (options.failUserRead) throw new Error('unit user read failed')
        return ok({ ...state.user, ...(state.deactivated ? options.badDisabledUser : options.badUser) })
      }
      if (path === '/system/role/get?id=801') return ok({ ...state.role, ...options.badRole })
      if (path === '/system/permission/list-user-roles?userId=802') {
        return ok(options.assignedRoles ?? state.roleIds)
      }
      if (path === '/system/tenant/simple-list') {
        return ok(options.tenants ?? [{ id: '1', name: 'CFOR 标准平台' },
          { id: '135', name: 'unit-existing-tenant' }])
      }
      assert.fail(`Unmocked permission admin GET ${path}`)
    },
    async postBusiness (path, body) {
      calls.push({ kind: 'admin-write', path })
      if (path === '/system/role/create') {
        state.role = { ...body, id: '801', type: 2 }
        return ok('801')
      }
      if (path === '/system/permission/assign-role-menu') {
        assert.deepEqual(body, { roleId: '801', menuIds: ['11', '10'] })
        return ok(true)
      }
      if (path === '/system/user/create') {
        state.password = body.password
        state.user = {
          id: '802', username: body.username, nickname: body.nickname, remark: body.remark, status: 0
        }
        return ok('802')
      }
      if (path === '/system/permission/assign-user-role') {
        if (options.failAssignRole) throw new Error(`unit role assignment failed ${state.password}`)
        assert.deepEqual(body, { userId: '802', roleIds: ['801'] })
        state.roleIds = body.roleIds
        return ok(true)
      }
      assert.fail(`No device mutation allowed: admin POST ${path}`)
    },
    async putBusiness (path, body) {
      calls.push({ kind: 'deactivate', path, body })
      assert.equal(path, '/system/user/update-status')
      assert.deepEqual(body, { id: '802', status: 1 })
      state.deactivated++
      if (options.failDeactivate) throw new Error(`unit deactivation failed ${state.password} ${state.token}`)
      if (!options.ignoreDeactivate) state.user.status = 1
      return ok(true)
    },
    async deleteBusiness (path) {
      calls.push({ kind: 'delete-role', path })
      assert.equal(path, '/system/role/delete?id=801')
      return ok(true)
    }
  }
  const readerApi = {
    async getBusiness (path) {
      calls.push({ kind: 'permission-read', path })
      assert.equal(path, '/system/auth/get-permission-info')
      if (options.failPermissionRead) throw new Error(`unit permission read failed ${state.token}`)
      return ok({
        user: { id: '802', username: state.user.username, ...options.principal },
        roles: options.roles ?? [state.role.code],
        permissions: options.permissions ?? ['erp:settle-method-rule:query', ''],
        ...options.permissionInfo
      })
    },
    async request (method, path, body, requestOptions) {
      if (path === '/system/auth/logout') {
        calls.push({ kind: 'logout', method })
        assert.equal(method, 'POST')
        state.logoutCount++
        if (options.failLogout) throw new Error(`unit logout failure ${state.token}`)
        return ok(true)
      }
      const crossTenant = requestOptions?.headers?.['tenant-id'] !== undefined
      calls.push({
        kind: crossTenant ? 'tenant-negative' : 'negative',
        method, path, body: structuredClone(body), requestOptions
      })
      if (options.failProbe) throw new Error(`unit probe transport failed ${state.token}`)
      if (crossTenant) {
        assert.equal(method, 'GET')
        assert.equal(body, undefined)
        assert.equal(requestOptions.headers['tenant-id'], '135')
        return Object.hasOwn(options, 'tenantResponse') ? options.tenantResponse : forbidden(IOT_TENANT_FORBIDDEN)
      }
      state.negativeCount++
      assert.ok(!['POST', 'DELETE'].includes(method))
      if (method === 'PUT') {
        assert.equal(path, '/iot/device/asset-status')
        assert.deepEqual(body, {
          id: state.device.id, assetStatus: state.device.assetStatus, reason: 'E2E-IOT permission no-op'
        })
      }
      if (options.mutation && state.negativeCount === 1) {
        state.device[options.mutation] = 'changed-by-broken-service'
      }
      return Object.hasOwn(options, 'response') ? options.response : forbidden()
    }
  }
  const dependencies = {
    createApiClient (clientOptions) {
      assert.equal(clientOptions.tenantId, '1')
      assert.equal(clientOptions.record, undefined, 'Private sessions must not use the shared report')
      if (clientOptions.token) {
        assert.equal(clientOptions.token, state.token)
        return readerApi
      }
      return {
        async request (method, path, body, requestOptions) {
          calls.push({ kind: 'login', method, path, encrypted: requestOptions.encrypted })
          assert.equal(method, 'POST')
          assert.equal(path, '/system/auth/login-encrypted')
          assert.equal(body.username, state.user.username)
          assert.equal(body.password, state.password)
          assert.equal(requestOptions.encrypted, true)
          if (options.failLogin) throw new Error(`unit login failure ${state.password}`)
          return options.loginResponse ?? ok({
            accessToken: state.token, refreshToken: state.refreshToken, userId: '802', tenantId: '1'
          })
        }
      }
    }
  }
  const input = {
    adminApi, device: structuredClone(state.device), identifier, caseRecord,
    record: report, runtime: localRuntime
  }
  return { input, dependencies, state, calls, caseRecord, report, adminApi, readerApi,
    run: () => verifyIotPermissionRejections(input, dependencies) }
}

test('IoT write fixtures require local CFOR standard tenant and exact IDs', () => {
  assert.doesNotThrow(() => assertIotLocalTarget(localRuntime))
  assert.doesNotThrow(() => assertIotLocalTarget({
    ...localRuntime,
    tenantId: ''
  }, { requireTenantId: false }))
  assert.throws(() => assertIotLocalTarget({
    ...localRuntime,
    tenantName: '福奇科技'
  }), /CFOR 标准平台/)
  assert.throws(() => assertIotLocalTarget({
    ...localRuntime,
    apiBase: 'https://jixu-ai.com'
  }), /本地 48083\/9151/)

  assert.equal(strictId('9007199254740993123', 'fixture'), '9007199254740993123')
  assert.equal(strictId(123, 'fixture'), '123')
  assert.throws(() => strictId(Number('9007199254740992'), 'fixture'), /精确/)
  assert.throws(() => strictId('0', 'fixture'), /精确/)
})

test('message-driven IoT cases are blocked when the local runtime is disabled', () => {
  assert.deepEqual(IOT_MESSAGE_RUNTIME_CASES, ['IOT-002', 'IOT-009', 'IOT-010', 'IOT-011'])
  for (const caseId of IOT_MESSAGE_RUNTIME_CASES) {
    assert.throws(
      () => assertIotMessageRuntimeEnabled({ iotRuntimeEnabled: false }, caseId),
      new RegExp(`BLOCKED: IoT 运行时已关闭.*${caseId}`)
    )
    assert.doesNotThrow(() => assertIotMessageRuntimeEnabled({ iotRuntimeEnabled: true }, caseId))
  }
  assert.doesNotThrow(() => assertIotMessageRuntimeEnabled({ iotRuntimeEnabled: false }, 'IOT-013'))
})

test('IoT fixture response helpers reject failed or malformed business facts', () => {
  assert.deepEqual(dataOf({ code: 0, data: { id: '9007199254740993123' } }), {
    id: '9007199254740993123'
  })
  assert.deepEqual(pageOf({
    code: 0,
    data: { list: [{ id: '9007199254740993123' }], total: 1 }
  }), {
    list: [{ id: '9007199254740993123' }],
    total: 1
  })
  for (const payload of [
    { code: 500, data: { list: [], total: 0 } },
    { code: 0, data: { list: [], total: '0' } },
    { code: 0, data: { list: [{}], total: 0 } },
    { code: 0, data: { list: Array.from({ length: 101 }, () => ({})), total: 101 } }
  ]) assert.throws(() => pageOf(payload))

  const rejection = { code: 1050018001, msg: 'IoT 回写死信记录已处理' }
  assert.equal(matchesExpectedBusinessRejection(rejection, {
    code: 1050018001,
    message: 'IoT 回写死信记录已处理'
  }), true)
  assert.equal(matchesExpectedBusinessRejection({
    code: 500,
    msg: '连接失败'
  }, {
    code: 1050018001,
    message: 'IoT 回写死信记录已处理'
  }), false)
})

test('IOT-010 transfer evidence requires persisted operator, time, and remark', () => {
  const remark = 'E2E-IOT-010 已转工单'
  assert.equal(hasIotAlertTransferHandlingEvidence({
    workOrderId: '701', transferUserId: '802', transferTime: '2026-10-12T10:00:00', transferRemark: remark
  }, remark), true)
  for (const change of [
    { transferUserId: null },
    { transferTime: null },
    { transferRemark: 'other' },
    { workOrderId: null }
  ]) {
    assert.equal(hasIotAlertTransferHandlingEvidence({
      workOrderId: '701', transferUserId: '802', transferTime: '2026-10-12T10:00:00', transferRemark: remark,
      ...change
    }, remark), false)
  }
})

test('IOT-011 dead-letter dedup evidence requires one exact row and source facts', () => {
  const expected = {
    id: '705',
    idempotentKey: 'd:703:m:thing.property.post:i:signal:s:11001',
    sourceTime: '2026-10-12T10:00:00',
    sourceVersion: '1'
  }
  const row = {
    ...expected,
    sourceTime: '2026-10-12T10:00:00',
    sourceVersion: '1',
    lastError: 'connection refused'
  }
  assert.equal(hasIotDeadLetterDedupEvidence([row], expected), true)
  assert.equal(hasIotDeadLetterDedupEvidence([row, { ...row }], expected), false)
  for (const field of ['sourceTime', 'sourceVersion', 'lastError']) {
    assert.equal(hasIotDeadLetterDedupEvidence([{ ...row, [field]: null }], expected), false)
  }
  assert.equal(hasIotDeadLetterDedupEvidence([{ ...row, idempotentKey: 'other' }], expected), false)
  for (const [field, value] of [
    ['id', '706'], ['sourceTime', '2026-10-12T10:00:01'], ['sourceVersion', '2']
  ]) {
    assert.equal(hasIotDeadLetterDedupEvidence([{ ...row, [field]: value }], expected), false)
  }
  assert.equal(hasIotDeadLetterDedupEvidence([row], {}), false)
})

test('IOT-009 first message evidence requires device, identifier, sequence, and quality together', () => {
  const expected = anomalyExpectations[0]
  const actual = {
    deviceId: 703,
    identifier,
    sequenceNo: 9001,
    qualityCode: 0
  }
  assert.equal(requireIotMessageEvidence(actual, expected), actual)
  assert.throws(() => requireIotMessageEvidence(undefined, expected), /未返回可验证记录/)
  for (const field of ['deviceId', 'identifier', 'sequenceNo', 'qualityCode']) {
    for (const value of [undefined, null, '', 'mismatch']) {
      assert.throws(
        () => requireIotMessageEvidence({ ...actual, [field]: value }, expected),
        new RegExp(field)
      )
    }
  }
})

for (const expected of anomalyExpectations) {
  test(`IOT-009 ${expected.type} requires matching identity, raw parameters, and exact idempotency key`, () => {
    const actual = anomalyEvidence(expected)
    assert.equal(requireIotAnomalyEvidence(actual, expected), actual)
    const changes = [
      [{ deviceId: '704' }, /deviceId/],
      [{ identifier: null }, /identifier/],
      [{ identifier: 'other_signal' }, /identifier/],
      [{ sequenceNo: expected.sequenceNo + 1 }, /sequenceNo/],
      [{ qualityCode: expected.qualityCode + 1 }, /qualityCode/],
      [{ qualityCode: null }, /qualityCode/],
      [{ type: 'OTHER' }, /type/],
      [{ idempotentKey: null }, /idempotentKey/],
      [{ idempotentKey: actual.idempotentKey.replace('d:703:', 'd:704:') }, /idempotentKey/],
      [{ idempotentKey: actual.idempotentKey.replace(`:i:${identifier}:`, ':i::') }, /idempotentKey/],
      [{ idempotentKey: actual.idempotentKey.replace(
        `:s:${expected.sequenceNo}`, `:s:${expected.sequenceNo}0`
      ) }, /idempotentKey/],
      [{ payload: null }, /payload/],
      [{ payload: '{invalid' }, /payload/],
      [{ payload: 'null' }, /payload/],
      [{ payload: '[]' }, /payload/],
      [{ payload: JSON.stringify({ other_signal: expected.value }) }, /payload/],
      [{ payload: JSON.stringify({ [identifier]: String(expected.value) }) }, /payload/],
      [{ payload: JSON.stringify({ [identifier]: expected.value + 1 }) }, /payload/],
      [{ payload: JSON.stringify({ [identifier]: expected.value, other_signal: 99 }) }, /payload/]
    ]
    for (const [change, pattern] of changes) {
      assert.throws(() => requireIotAnomalyEvidence({ ...actual, ...change }, expected), pattern)
    }
  })
}

test('IOT-009 missing OUT_OF_ORDER record is rejected rather than treated as GAP', async () => {
  assert.throws(
    () => requireIotAnomalyEvidence(undefined, anomalyExpectations[1], 'OUT_OF_ORDER 异常'),
    /OUT_OF_ORDER.*未返回可验证记录/
  )
  const simulation = simulateAnomalyApi({ missingOutOfOrder: true })
  const caseRecord = record('IOT-009')
  initializeIotCatalogAssertions(caseRecord, 'IOT-009')
  await assert.rejects(runSimulatedAnomalyClosure(simulation, caseRecord),
    /OUT_OF_ORDER.*等待超时/)
  assert.deepEqual(simulation.state.sends.map((row) => row.sequenceNo), [9001, 9001, 9002, 9003])
  assert.deepEqual(simulation.state.handled, [])
  assert.ok(!caseRecord.checks.some((check) => check.passed === true &&
    /OUT_OF_ORDER|QUALITY_CODE|异常处理/.test(check.name)))
  assert.ok(!caseRecord.notes.some((note) => /identifier|null|乱序/.test(note)))
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
})

test('IOT-009 simulated execution refuses a first message with inconsistent fields', async () => {
  for (const [field, value] of [
    ['deviceId', '704'],
    ['identifier', null],
    ['sequenceNo', 9000],
    ['qualityCode', null]
  ]) {
    const simulation = simulateAnomalyApi({
      changeMessage: (row) => ({ ...row, [field]: value })
    })
    const caseRecord = record('IOT-009')
    initializeIotCatalogAssertions(caseRecord, 'IOT-009')
    await assert.rejects(runSimulatedAnomalyClosure(simulation, caseRecord),
      field === 'sequenceNo' ? /首条消息消费完成等待超时/ : new RegExp(field))
    assert.equal(simulation.state.sends.length, 1)
    assert.deepEqual(caseRecord.checks, [])
  }
})

test('IOT-009 simulated execution refuses mismatched anomaly evidence for all three types', async () => {
  for (const expected of anomalyExpectations) {
    for (const [field, value] of [
      ['deviceId', '704'],
      ['identifier', null],
      ['sequenceNo', 9999],
      ['qualityCode', null],
      ['idempotentKey', `d:703:m:thing.property.post:i:${identifier}:s:9999`],
      ['payload', JSON.stringify({ [identifier]: expected.value + 1 })]
    ]) {
      const simulation = simulateAnomalyApi({
        changeAnomaly: (row) => row.type === expected.type ? { ...row, [field]: value } : row
      })
      const caseRecord = record('IOT-009')
      initializeIotCatalogAssertions(caseRecord, 'IOT-009')
      await assert.rejects(runSimulatedAnomalyClosure(simulation, caseRecord),
        field === 'sequenceNo' ? new RegExp(`${expected.type}.*等待超时`) : new RegExp(field))
      assert.deepEqual(simulation.state.handled, [])
      assert.ok(!caseRecord.checks.some((check) => check.name.includes(expected.type)))
      assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
    }
  }
})

test('IOT-009 simulated complete evidence is registered only after successful execution', async () => {
  const simulation = simulateAnomalyApi()
  const caseRecord = record('IOT-009')
  initializeIotCatalogAssertions(caseRecord, 'IOT-009')
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
  assert.deepEqual(caseRecord.checks, [])
  await runSimulatedAnomalyClosure(simulation, caseRecord)
  assert.deepEqual(simulation.state.handled, ['9001', '9003', '9004'])
  assert.equal(caseRecord.checks.length, 6)
  assert.ok(caseRecord.checks.every((check) => check.passed === true))
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
  const conclusion = finalizeIotCatalogAssertions(caseRecord)
  assert.equal(conclusion.acceptanceComplete, true)
  assert.ok(caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'))
})

test('IOT-002 scope and IOT-010 lifecycle gaps are explicit without a stale IOT-009 gap', async () => {
  assert.equal(Object.prototype.hasOwnProperty.call(IOT_CONTRACT_GAPS, 'IOT-009'), false)
  assert.ok(IOT_CONTRACT_GAPS['IOT-002'].some((gap) => /租户.*权限隔离/.test(gap)))
  assert.ok(IOT_CONTRACT_GAPS['IOT-010'].some((gap) => /单向推进/.test(gap)))
  const caseRecord = record('IOT-002')
  initializeIotCatalogAssertions(caseRecord, 'IOT-002')
  await runSimulatedAnomalyClosure(simulateAnomalyApi(), caseRecord)
  const conclusion = finalizeIotCatalogAssertions(caseRecord)
  assert.equal(conclusion.acceptanceComplete, false)
  assert.equal(conclusion.partial, true)
  assert.deepEqual(caseRecord.catalogAssertions.map((row) => row.status),
    ['VERIFIED', 'VERIFIED', 'GAP', 'GAP'])
  const unrunLifecycle = record('IOT-010')
  initializeIotCatalogAssertions(unrunLifecycle, 'IOT-010')
  assert.ok(unrunLifecycle.catalogAssertions.every((row) => row.status === 'GAP'))
})

test('IoT cleanup is LIFO, preserves original failure, and records cleanup failure', async () => {
  const caseRecord = record()
  const order = []
  const fixtures = createIotFixtureCleanup({ caseId: 'IOT-011', caseRecord })
  fixtures.track({ code: 0, data: '9007199254740993123' }, 'first', async (id) => {
    order.push(`first:${id}`)
  })
  fixtures.track({ code: 0, data: '9007199254740993124' }, 'second', async (id) => {
    order.push(`second:${id}`)
    throw new Error('cleanup transport failure')
  })
  await fixtures.cleanup(true)
  assert.deepEqual(order, [
    'second:9007199254740993124',
    'first:9007199254740993123'
  ])
  assert.ok(caseRecord.checks.some((check) => check.passed === false &&
    check.name === 'second测试数据已清理'))
  await assert.rejects(() => fixtures.cleanup(false), /清理失败/)
})

test('IoT catalog status remains GAP unless every assertion has named evidence', () => {
  const caseRecord = record('IOT-011')
  initializeIotCatalogAssertions(caseRecord, 'IOT-011')
  assert.deepEqual(
    caseRecord.catalogAssertions.map((row) => row.status),
    ['GAP', 'GAP', 'GAP', 'GAP']
  )
  markIotAssertion(caseRecord, 3, ['人工接管证据'])
  caseRecord.checks.push({ name: '人工接管证据', passed: true })
  const conclusion = finalizeIotCatalogAssertions(caseRecord)
  assert.equal(caseRecord.catalogAssertions[3].status, 'VERIFIED')
  assert.equal(caseRecord.catalogAssertions[0].status, 'GAP')
  assert.equal(conclusion.partial, true)
  assert.equal(conclusion.acceptanceComplete, false)
  assert.equal(caseRecord.remainingAssertions.length, IOT_WRITE_ASSERTIONS['IOT-011'].length - 1)
})

test('IOT-002 uses the existing account tool, one encrypted API login and six exact denials without device mutation', async () => {
  const h = permissionHarness()
  const before = structuredClone(h.state.device)
  const result = await h.run()
  assert.equal(result.results.length, 6)
  assert.equal(result.unchanged, true)
  assert.equal(result.accountDeactivated, true)
  assert.equal(result.tenantHeaderRejected, true)
  assert.deepEqual(h.state.device, before)
  assert.equal(h.state.deactivated, 1)
  assert.equal(h.state.user.status, 1)
  assert.equal(h.state.logoutCount, 1)
  assert.equal(h.calls.filter((call) => call.kind === 'login').length, 1)
  assert.equal(h.calls.filter((call) => call.kind === 'delete-role').length, 0)
  assert.ok(h.caseRecord.accounts[0].username.startsWith('autotestiot002'))
  assert.equal(h.caseRecord.accounts[0].permission, 'erp:settle-method-rule:query')
  assert.deepEqual(h.calls.filter((call) => call.kind === 'negative').map((call) => call.method),
    ['GET', 'GET', 'GET', 'GET', 'GET', 'PUT'])
  assert.ok(h.calls.filter((call) => call.kind === 'admin-write')
    .every((call) => call.path.startsWith('/system/')))
  assert.ok(h.caseRecord.checks.every((check) => check.passed))
  const conclusion = finalizeIotCatalogAssertions(h.caseRecord)
  assert.equal(conclusion.acceptanceComplete, false)
  assert.equal(h.caseRecord.catalogAssertions[3].status, 'GAP')
  assert.equal(h.caseRecord.catalogAssertions[3].evidenceChecks.length, 10)
  assert.match(h.caseRecord.catalogAssertions[3].details, /第二真实租户/)
  const report = JSON.stringify({ result, report: h.report, caseRecord: h.caseRecord })
  for (const secret of [h.state.password, h.state.token, h.state.refreshToken]) {
    assert.ok(!report.includes(secret))
  }
})

test('IOT-002 original assertions stay unchanged and read/header denials do not complete the catalog', async () => {
  assert.deepEqual(IOT_WRITE_ASSERTIONS['IOT-002'], [
    '重复消息不重复落库', '异常值可观测', '告警状态可关闭', '租户和设备权限隔离'
  ])
  const h = permissionHarness({ tenants: [{ id: '1', name: 'CFOR 标准平台' }] })
  const result = await h.run()
  assert.equal(result.tenantHeaderRejected, false)
  assert.match(result.gap, /第二个启用租户/)
  assert.equal(h.calls.filter((call) => call.kind === 'tenant-negative').length, 0)
  assert.equal(finalizeIotCatalogAssertions(h.caseRecord).acceptanceComplete, false)
  assert.ok(h.caseRecord.catalogAssertions.every((row) => row.status === 'GAP'))
})

test('IOT-002 refuses unsafe target, missing devices and unavailable menus before creating an account', async () => {
  for (const options of [
    { tenantId: '135' }, { missingDevice: true }, { noAssignableMenu: true }
  ]) {
    const h = permissionHarness(options)
    await assert.rejects(h.run(), /BLOCKED/)
    assert.equal(h.state.user, null)
    assert.equal(h.calls.filter((call) => call.kind === 'login').length, 0)
  }
  const h = permissionHarness()
  h.input.runtime = { ...localRuntime, target: 'production' }
  await assert.rejects(h.run(), /BLOCKED/)
  assert.deepEqual(h.calls, [])
  const foreignDevice = permissionHarness()
  foreignDevice.input.device.deviceName = 'USER-DEVICE'
  await assert.rejects(foreignDevice.run(), /E2E-IOT/)
  assert.deepEqual(foreignDevice.calls, [])
})

test('IOT-002 blocks wrong identities, tenant, administrator roles and IoT/wildcard grants before probes', async () => {
  for (const options of [
    { principal: { username: 'admin' } }, { principal: { id: '999' } },
    { roles: ['super_admin'] }, { roles: ['tenant_admin'] }, { roles: [] },
    { assignedRoles: ['801', '999'] }, { badRole: { type: 1 } },
    { badUser: { status: 1 } },
    { permissionInfo: { permissions: null } }, { permissions: [] },
    ...['*:*:*', 'iot:device:query', 'iot:device:update', 'iot:device:message-send',
      'system:user:create'].map((grant) => ({ permissions: ['erp:settle-method-rule:query', grant] })),
    { loginResponse: { code: 0, data: {
      userId: '802', tenantId: '135', accessToken: 'unit-iot-private-token'
    } } },
    { loginResponse: { code: 0, data: {
      userId: '999', tenantId: '1', accessToken: 'unit-iot-private-token'
    } } }
  ]) {
    const h = permissionHarness(options)
    await assert.rejects(h.run(), /归属不匹配|不匹配|IoT 权限探针真实账号/)
    assert.equal(h.state.negativeCount, 0)
    assert.equal(h.state.deactivated, 1)
    assert.equal(h.state.user.status, 1)
  }
})

test('IOT-002 exact 403 matcher rejects authentication, service failures, success flags and leaked data', async () => {
  for (const response of [
    undefined, null, {}, { code: '403', msg: '没有该操作权限' },
    { code: 0, msg: '没有该操作权限' }, { code: 200, success: true, msg: '没有该操作权限' },
    { code: 401, msg: '没有该操作权限' }, { code: 500, msg: '系统异常' },
    { code: 403, success: true, msg: '没有该操作权限' },
    { code: 403, ok: true, msg: '没有该操作权限' },
    { code: 403, msg: '没有该操作权限，但设备不存在' },
    { code: 403, msg: '没有该操作权限', message: '系统异常' },
    { code: 403, msg: '没有该操作权限', data: { id: '703' } },
    { code: 403, msg: '没有该操作权限', data: [] }
  ]) {
    assert.equal(isExactIotForbidden(response), false)
    const h = permissionHarness({ response })
    await assert.rejects(h.run(), /精确 403 拒绝/)
    assert.equal(h.state.negativeCount, 1)
    assert.equal(h.state.user.status, 1)
    assert.equal(h.state.logoutCount, 1)
    assert.ok(h.caseRecord.checks.some((check) => check.passed === false))
  }
  const legacy = permissionHarness({ legacy: true, response: {
    code: 403, success: false, message: '没有该操作权限', data: null
  } })
  assert.equal((await legacy.run()).accountDeactivated, true)
})

test('IOT-002 tenant header probe must match the tenant filter message, not generic permission denial', async () => {
  for (const tenantResponse of [
    forbidden(), { code: 401, msg: IOT_TENANT_FORBIDDEN.message },
    { code: 403, msg: IOT_TENANT_FORBIDDEN.message, data: { id: '703' } }
  ]) {
    const h = permissionHarness({ tenantResponse })
    await assert.rejects(h.run(), /精确租户 403 拒绝/)
    assert.equal(h.state.user.status, 1)
    assert.equal(h.state.logoutCount, 1)
  }
})

test('IOT-002 compares cloned complete device facts and rejects mutation despite exact denials', async () => {
  for (const mutation of ['deviceName', 'assetStatus', 'state', 'accessConfigVersion']) {
    const h = permissionHarness({ mutation })
    await assert.rejects(h.run(), /专属设备完全一致/)
    assert.equal(h.state.user.status, 1)
    assert.equal(h.state.logoutCount, 1)
    assert.ok(h.caseRecord.checks.some((check) => !check.passed &&
      check.name.includes('专属设备完全一致')))
  }
})

test('IOT-002 setup/login/probe failures still deactivate the owned account and redact private errors', async () => {
  for (const options of [
    { failAssignRole: true }, { failLogin: true }, { failPermissionRead: true }, { failProbe: true }
  ]) {
    const h = permissionHarness(options)
    let error
    try { await h.run() } catch (caught) { error = caught }
    assert.ok(error)
    assert.ok(h.state.deactivated >= 1)
    assert.equal(h.state.user.status, 1)
    const output = JSON.stringify({ error: error.message, caseRecord: h.caseRecord, report: h.report })
    assert.ok(!output.includes(h.state.password))
    assert.ok(!output.includes(h.state.token))
    assert.ok(!output.includes(h.state.refreshToken))
  }
})

test('IOT-002 cleanup failures never report successful account retirement or complete isolation', async () => {
  for (const options of [
    { failAfterRead: true }, { failDeactivate: true }, { ignoreDeactivate: true },
    { badDisabledUser: { username: 'other' } }, { failLogout: true }
  ]) {
    const h = permissionHarness(options)
    await assert.rejects(h.run(), /回读失败|停用账号失败|退出账号失败/)
    assert.ok(h.state.deactivated >= 1)
    assert.equal(h.state.logoutCount, 1)
    assert.equal(finalizeIotCatalogAssertions(h.caseRecord).acceptanceComplete, false)
  }
})

test('IOT-002 runtime dispatch invokes the real permission path after anomaly evidence using simulated APIs only', async () => {
  const anomalies = simulateAnomalyApi()
  const h = permissionHarness()
  const api = {
    getBusiness: (path) => path.startsWith('/system/')
      ? h.adminApi.getBusiness(path) : anomalies.api.getBusiness(path),
    postBusiness: (path, body) => path.startsWith('/system/')
      ? h.adminApi.postBusiness(path, body) : anomalies.api.postBusiness(path, body),
    putBusiness: (path, body) => path.startsWith('/system/')
      ? h.adminApi.putBusiness(path, body) : anomalies.api.putBusiness(path, body),
    deleteBusiness: (path) => h.adminApi.deleteBusiness(path),
    request: (...args) => anomalies.api.request(...args)
  }
  const createDevice = anomalies.api.postBusiness.bind(anomalies.api)
  anomalies.api.postBusiness = async (path, body) => {
    const response = await createDevice(path, body)
    if (path === '/iot/device/create') {
      anomalies.state.device.assetStatus = 'ENABLED'
    }
    return response
  }
  const result = await runIotSecurityE2e({
    caseId: 'IOT-002', api,
    fixtures: createIotFixtureCleanup({ caseId: 'IOT-002', caseRecord: h.caseRecord }),
    caseRecord: h.caseRecord, record: h.report
  }, { ...h.dependencies, runtime: localRuntime })
  assert.equal(result.permissionEvidence.results.length, 6)
  assert.deepEqual(anomalies.state.handled, ['9001', '9003', '9004'])
  assert.equal(h.state.user.status, 1)
  assert.equal(finalizeIotCatalogAssertions(h.caseRecord).acceptanceComplete, false)
  assert.deepEqual(h.caseRecord.catalogAssertions.map((row) => row.status),
    ['VERIFIED', 'VERIFIED', 'GAP', 'GAP'])
})

test('IOT-002 login uses the standard encrypted transport without network or browser access in this test', async (t) => {
  const h = permissionHarness()
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).pathname, '/admin-api/system/auth/login-encrypted')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['tenant-id'], '1')
    assert.equal(options.headers[ENCRYPT_HEADER], 'true')
    assert.equal(options.headers.Authorization, undefined)
    assert.ok(!options.body.includes(h.state.password))
    assert.ok(!options.body.includes(h.state.user.username))
    return new Response(JSON.stringify({ code: 0, data: {
      accessToken: h.state.token, refreshToken: h.state.refreshToken, userId: '802', tenantId: '1'
    } }), { headers: { 'content-type': 'application/json' } })
  })
  h.dependencies.createApiClient = (clientOptions) => clientOptions.token
    ? h.readerApi : createApiClient(clientOptions)
  assert.equal((await h.run()).accountDeactivated, true)
})
